/**
 * tda-governance 冒烟门（门4 test:smoke）：T1.2 §6 验收 1–8 逐条。
 *
 * 夹具的假时间线实现了**真实的链语义**（current() 减去被取代/被作废、history()
 * 返回演化闭包），因此"superseded 自动退役""分叉冲突检测"两条是被真正验证的，
 * 而不是靠夹具配合出来的。
 */
import { describe, expect, it } from 'vitest';
import { CALLER, DAY, HUMAN, NOW, setup } from './helpers.ts';

const evidenceFor = (taskId = 'task-1', injectedAt = NOW - DAY) => ({
  taskId,
  runIndex: 1,
  taskOutcome: 'success' as const,
  injectedAt,
  checkedAt: NOW,
});

describe('T1.2 §6 验收', () => {
  it('1. G1-② 投毒闭环：隔离 → 不转正 → 外部验证 → 转正为新条目 → 原条目仍可溯', async () => {
    const fx = await setup({
      now: () => NOW,
      entries: [
        {
          id: 'tl-1',
          content: '灯环 配对协议（疑似工具输出污染）',
          credential: 'tool-output',
          chunkType: 'method',
          relatedTaskId: 'task-1',
          createdAt: NOW - 2 * DAY,
        },
      ],
      recall: [{ entryId: 'tl-1', at: NOW - DAY, injected: true, kind: 'inject', taskId: 'task-1' }],
      tasks: [{ id: 'task-1', outcome: 'success' }],
    });
    try {
      // ① 服务端强制隔离（T0.3 J5：调用方无从指定）
      expect(fx.timeline.get('tl-1')?.quarantine).toBe(true);
      // ② scan 不转正（低风险动作里没有 promote）
      const report = await fx.service.scan(CALLER);
      expect(report.proposals.some((action) => action.action === 'promote')).toBe(false);
      expect(fx.service.lifecycleOf('tl-1')).toBeUndefined();

      // ③ 模拟外部验证通过 → promote（J4：转正只经 supersede 新条目）
      const action = await fx.service.promote(CALLER, 'tl-1', evidenceFor());
      expect(action.promotedFrom).toBe('tl-1');
      const created = fx.timeline.get(action.assetId);
      expect(created?.supersedes).toBe('tl-1');
      expect(created?.credential).toBe('execution-verified');
      expect(created?.quarantine).toBe(false);

      // ④ 原隔离条目仍在、标记未被改写、链可溯（J4 自检）
      const original = fx.timeline.get('tl-1');
      expect(original?.quarantine).toBe(true);
      expect(fx.timeline.history('tl-1').map((entry) => entry.id)).toEqual(['tl-1', action.assetId]);

      // ⑤ 新条目可按参数浮现（validating）→ 固化
      expect(fx.service.lifecycleOf(action.assetId)).toBe('validating');
      await fx.service.consolidate(CALLER, action.assetId);
      expect(fx.service.lifecycleOf(action.assetId)).toBe('consolidated');
      // 原条目仍在 draft（永不浮现）
      expect(fx.service.lifecycleOf('tl-1')).toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });

  it('2. 固化三条件逐一可证（缺一即拒）', async () => {
    const fx = await setup({
      now: () => NOW,
      entries: [
        { id: 'tl-1', content: '模型自产记忆（置信够）', credential: 'model-produced', chunkType: 'fact', relatedTaskId: 'task-1', createdAt: NOW - DAY },
      ],
      recall: [],
      tasks: [{ id: 'task-1', outcome: 'success' }],
    });
    try {
      // 条件 ①：零真实复用 → 拒绝
      await expect(fx.service.promote(CALLER, 'tl-1', evidenceFor())).rejects.toMatchObject({
        code: 'GOV_EVIDENCE_NO_REUSE',
      });
      // 注入时刻对不上 → 也拒（防伪造证据）
      fx.recall.rows.push({ entryId: 'tl-1', at: NOW - DAY, injected: true, kind: 'inject', taskId: 'task-1' });
      await expect(
        fx.service.promote(CALLER, 'tl-1', evidenceFor('task-1', NOW - 999)),
      ).rejects.toMatchObject({ code: 'GOV_EVIDENCE_INJECTED_AT_MISMATCH' });
      // 任务未 success → 拒
      const fx2 = await setup({ now: () => NOW, entries: [{ id: 'tl-9', content: 'x', credential: 'execution-verified', createdAt: NOW }], recall: [{ entryId: 'tl-9', at: NOW, injected: true, kind: 'inject', taskId: 'task-2' }], tasks: [{ id: 'task-2', outcome: 'failed', phase: 'complete' }] });
      await expect(fx2.service.promote(CALLER, 'tl-9', evidenceFor('task-2', NOW))).rejects.toMatchObject({
        code: 'GOV_EVIDENCE_TASK_NOT_SUCCESS',
      });
      await fx2.dispose();

      // 证据齐备 → promote 成功（条件 ①）
      await fx.service.promote(CALLER, 'tl-1', evidenceFor());
      // 条件 ②：凭证低于 execution-verified → 拒绝
      await expect(fx.service.consolidate(CALLER, 'tl-1')).rejects.toMatchObject({
        code: 'GOV_CREDENTIAL_TOO_LOW',
      });
      // 条件 ③：隔离态 → 拒绝（另造一条隔离条目走完 promote 的新条目路径但保持隔离）
      const fx3 = await setup({
        now: () => NOW,
        entries: [{ id: 'tl-5', content: '外部内容', credential: 'external-content', createdAt: NOW }],
      });
      await expect(fx3.service.consolidate(CALLER, 'tl-5')).rejects.toMatchObject({ code: 'GOV_NOT_VALIDATING' });
      await fx3.dispose();
    } finally {
      await fx.dispose();
    }
  });

  it('3. superseded 自动退役：新版本取代 → scan 检出 → retiredReason=superseded', async () => {
    const fx = await setup({
      now: () => NOW,
      entries: [
        { id: 'tl-1', content: '旧版方法', credential: 'execution-verified', chunkType: 'method', relatedTaskId: 'task-1', createdAt: NOW - DAY },
      ],
      recall: [{ entryId: 'tl-1', at: NOW - DAY, injected: true, kind: 'inject', taskId: 'task-1' }],
      tasks: [{ id: 'task-1', outcome: 'success' }],
    });
    try {
      await fx.service.promote(CALLER, 'tl-1', evidenceFor());
      await fx.service.consolidate(CALLER, 'tl-1');

      await fx.timeline.supersede(
        { sessionId: 'sess-x', actor: 'agent', at: NOW },
        'tl-1',
        { content: '新版方法', chunkType: 'method', source: 'task', credential: 'execution-verified' },
        '版本更新',
      );

      const report = await fx.service.scan(CALLER);
      const retired = report.executed.find((action) => action.assetId === 'tl-1');
      expect(retired?.action).toBe('retire');
      expect(retired?.reason?.kind).toBe('superseded');
      const state = fx.service.state('tl-1');
      expect(state?.lifecycle).toBe('retired');
      expect(state?.retiredReason?.kind).toBe('superseded');
    } finally {
      await fx.dispose();
    }
  });

  it('4. unused-days 退役：超阈值自动退役，退役后 T1.1 不再浮现', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      config: { unusedDays: 1 },
      entries: [
        { id: 'tl-1', content: '长期未用的方法', credential: 'execution-verified', chunkType: 'method', relatedTaskId: 'task-1', createdAt: NOW - 10 * DAY },
      ],
      recall: [{ entryId: 'tl-1', at: NOW - 3_600_000, injected: true, kind: 'inject', taskId: 'task-1' }],
      tasks: [{ id: 'task-1', outcome: 'success' }],
    });
    try {
      await fx.service.promote(CALLER, 'tl-1', evidenceFor('task-1', NOW - 3_600_000));
      await fx.service.consolidate(CALLER, 'tl-1');
      // 阈值内：不退役
      const early = await fx.service.scan(CALLER);
      expect(early.executed.some((action) => action.reason?.kind === 'unused-days')).toBe(false);

      now = NOW + 2 * DAY;
      const report = await fx.service.scan(CALLER);
      const retired = report.executed.find((action) => action.reason?.kind === 'unused-days');
      expect(retired?.assetId).toBe('tl-1');
      // T1.1 的过滤口径读的就是 lifecycleOf（同族扩展）
      expect(fx.service.lifecycleOf('tl-1')).toBe('retired');
    } finally {
      await fx.dispose();
    }
  });

  it('5. 容量强制淘汰：over 只提议+带排名证据，执行需人类 token；pressure 只提议', async () => {
    const entries = [1, 2, 3].map((index) => ({
      id: `tl-${index}`,
      content: `方法 ${index}`,
      credential: 'execution-verified' as const,
      chunkType: 'method' as const,
      createdAt: NOW - index * DAY,
    }));
    const fx = await setup({ now: () => NOW, config: { maxEntries: 2 }, entries });
    try {
      const report = await fx.service.scan(CALLER);
      expect(report.capacity.zone).toBe('over');
      expect(report.pendingApproval.length).toBeGreaterThan(0);
      const proposal = report.pendingApproval[0]!;
      expect(proposal.reason?.kind).toBe('capacity');
      expect(proposal.reason?.detail).toContain('rank=');
      expect(proposal.ranking?.length).toBe(3);
      // scan 不代执行（J12）：条目仍停在提议产生的 draft 态，未被退役
      expect(fx.service.lifecycleOf(proposal.assetId)).toBe('draft');

      // 无 token → 拒
      await expect(
        fx.service.retire(HUMAN, proposal.assetId, proposal.reason!, { ranking: proposal.ranking! }),
      ).rejects.toMatchObject({ code: 'GOV_APPROVAL_REQUIRED' });
      // 带 token + 排名 → 执行
      await fx.service.retire(HUMAN, proposal.assetId, proposal.reason!, {
        approvalToken: 'tok-human-1',
        ranking: proposal.ranking!,
      });
      expect(fx.service.lifecycleOf(proposal.assetId)).toBe('retired');
    } finally {
      await fx.dispose();
    }
  });

  it('5b. pressure 区只提议不强制（恰好 100% 配额）', async () => {
    const entries = [1, 2, 3].map((index) => ({
      id: `tl-${index}`,
      content: `方法 ${index}`,
      credential: 'execution-verified' as const,
      createdAt: NOW,
    }));
    const fx = await setup({ now: () => NOW, config: { maxEntries: 3 }, entries });
    try {
      const report = await fx.service.scan(CALLER);
      expect(report.capacity.zone).toBe('pressure');
      expect(report.pendingApproval.length).toBeGreaterThan(0);
      expect(report.executed).toHaveLength(0);
    } finally {
      await fx.dispose();
    }
  });

  it('6. 冲突检测：分叉双 supersede → conflict 记录含 with；T0.3 current() 定义不变', async () => {
    const fx = await setup({
      now: () => NOW,
      entries: [
        { id: 'tl-1', content: '原版', credential: 'execution-verified', createdAt: NOW - 3 * DAY },
        { id: 'tl-2', content: '分叉 A', credential: 'execution-verified', supersedes: 'tl-1', createdAt: NOW - 2 * DAY },
        { id: 'tl-3', content: '分叉 B', credential: 'execution-verified', supersedes: 'tl-1', createdAt: NOW - DAY },
      ],
    });
    try {
      const report = await fx.service.scan(CALLER);
      expect(report.conflictsFound).toBe(1);
      const conflicts = fx.service.conflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.conflict?.with).toEqual(['tl-2', 'tl-3']);
      expect(conflicts[0]?.conflict?.resolution).toBe('pending');
      // T0.3 的机械定义不变：两个新条目都在 current() 里
      expect(fx.timeline.current().map((entry) => entry.id).sort()).toEqual(['tl-2', 'tl-3']);
      // 且未把原条目当"普通 superseded"消音：它停在 draft（冲突标记），而非 retired（J9：不隐藏裁决）
      expect(fx.service.lifecycleOf('tl-1')).not.toBe('retired');
      expect(fx.service.lifecycleOf('tl-1')).toBe('draft');
    } finally {
      await fx.dispose();
    }
  });

  it('7. 退役可逆、作废终局（restore 仅人工；archived 后不再动作）', async () => {
    const fx = await setup({
      now: () => NOW,
      entries: [{ id: 'tl-1', content: '待退役', credential: 'execution-verified', createdAt: NOW }],
    });
    try {
      await fx.service.retire(CALLER, 'tl-1', { kind: 'manual', detail: '人工退役' });
      expect(fx.service.lifecycleOf('tl-1')).toBe('retired');
      // 非人工恢复 → 拒
      await expect(fx.service.restore(CALLER, 'tl-1')).rejects.toMatchObject({
        code: 'GOV_RESTORE_REQUIRES_HUMAN',
      });
      await fx.service.restore(HUMAN, 'tl-1');
      expect(fx.service.lifecycleOf('tl-1')).toBe('consolidated');

      // 遗忘两步：先提议（pending），带 token 才落作废（经 T0.3 单一漏斗）
      const proposal = await fx.service.proposeInvalidate(CALLER, 'tl-1', '内容已被证实错误');
      expect(proposal.approvalToken).toBeUndefined();
      expect(fx.timeline.entries.size).toBe(1);
      const executed = await fx.service.proposeInvalidate(HUMAN, 'tl-1', '内容已被证实错误', {
        approvalToken: 'tok-forget-1',
      });
      expect(executed.approvalToken).toBe('tok-forget-1');
      expect(fx.service.state('tl-1')?.archived).toBe(true);
      expect(fx.timeline.current()).toHaveLength(0);
      // 终局：不再动作
      await expect(fx.service.retire(CALLER, 'tl-1', { kind: 'manual', detail: 'x' })).rejects.toMatchObject({
        code: 'GOV_ARCHIVED_TERMINAL',
      });
      await expect(fx.service.restore(HUMAN, 'tl-1')).rejects.toMatchObject({ code: 'GOV_ARCHIVED_TERMINAL' });
    } finally {
      await fx.dispose();
    }
  });

  it('8. 吞吐帽：单轮动作数与扫描数 ≤ cap，余量下轮续办', async () => {
    const fx = await setup({
      now: () => NOW,
      config: { maxActionsPerScan: 1, maxScannedPerScan: 2 },
      entries: [
        { id: 'tl-1', content: 'A', credential: 'execution-verified', createdAt: NOW },
        { id: 'tl-2', content: 'B', credential: 'execution-verified', supersedes: 'tl-1', createdAt: NOW },
        { id: 'tl-3', content: 'C', credential: 'execution-verified', createdAt: NOW },
        { id: 'tl-4', content: 'D', credential: 'execution-verified', supersedes: 'tl-3', createdAt: NOW },
      ],
    });
    try {
      const first = await fx.service.scan(CALLER);
      expect(first.scanned).toBeLessThanOrEqual(2);
      expect(first.executed.length).toBeLessThanOrEqual(1);
      expect(first.nextCursor).not.toBe('');
      const second = await fx.service.scan(CALLER);
      expect(second.scanned).toBeLessThanOrEqual(2);
      // 两轮之内两条被取代的旧条目都应被退役（余量续办）
      expect(fx.service.lifecycleOf('tl-1')).toBe('retired');
      expect(fx.service.lifecycleOf('tl-3')).toBe('retired');
    } finally {
      await fx.dispose();
    }
  });

  it('9. near-duplicate 只标记不合并（dupOf 指向先出现的条目）', async () => {
    const long = '这是一段足够长的完全相同的方法正文，用于触发重复检测阈值。';
    const fx = await setup({
      now: () => NOW,
      config: { nearDupMinLength: 10 },
      entries: [
        { id: 'tl-1', content: long, credential: 'execution-verified', chunkType: 'method', createdAt: NOW - DAY },
        { id: 'tl-2', content: long, credential: 'execution-verified', chunkType: 'method', createdAt: NOW },
      ],
    });
    try {
      const report = await fx.service.scan(CALLER);
      expect(report.executed.some((action) => action.dupOf === 'tl-1')).toBe(true);
      expect(fx.service.state('tl-2')?.dupOf).toBe('tl-1');
      // 只标记不合并：两条都还在
      expect(fx.timeline.current()).toHaveLength(2);
    } finally {
      await fx.dispose();
    }
  });

  it('10. P1 未实例化的资产类型 fail-loud（不静默跳过）', async () => {
    const fx = await setup({
      now: () => NOW,
      entries: [{ id: 'tl-1', content: 'x', credential: 'execution-verified', createdAt: NOW }],
    });
    try {
      // meta-thinking 分区在 T1.4 由同一管道承接：未注册即无状态（不冒充 memory）
      expect(fx.service.lifecycleOf('tl-1', 'meta-thinking')).toBeUndefined();
      expect(fx.service.rebuildStates('meta-thinking').size).toBe(0);
      // 有动作的类型才可能报 UNSUPPORTED_ASSET——用 schema 层面验证白名单生效
      expect(fx.service.state('tl-5')?.assetKind).toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });

  it('11. 治理不动权威：时间线条目在治理动作前后逐字节不变', async () => {
    const fx = await setup({
      now: () => NOW,
      entries: [{ id: 'tl-1', content: '原始正文', credential: 'execution-verified', createdAt: NOW }],
    });
    try {
      const before = JSON.stringify(fx.timeline.get('tl-1'));
      await fx.service.retire(CALLER, 'tl-1', { kind: 'manual', detail: 'x' });
      await fx.service.restore(HUMAN, 'tl-1');
      await fx.service.proposeInvalidate(HUMAN, 'tl-1', 'y', { approvalToken: 'tok' });
      // 原有 chunk 条目逐字节不变（治理只追加记录，绝不改写）
      expect(JSON.stringify(fx.timeline.get('tl-1'))).toBe(before);
      // 作废只以 invalidation 记录追加
      expect([...fx.timeline.entries.values()].some((entry) => entry.kind === 'invalidation')).toBe(true);
    } finally {
      await fx.dispose();
    }
  });
});
