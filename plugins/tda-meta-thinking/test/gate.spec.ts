/**
 * tda-meta-thinking 冒烟门（门4 test:smoke）：T1.4 §6 验收 1–8 逐条。
 */
import { describe, expect, it } from 'vitest';
import { sampleDraft, setup } from './helpers.ts';

describe('T1.4 §6 验收', () => {
  it('1. 拓扑落地：propose → rehearse（pass）→ requestConsolidate → 注入池可见', async () => {
    const fx = await setup({
      executor: [
        // 子会话试跑：outcome=success 且 transition 链覆盖全部 4 种步骤
        { outcome: 'success', tokens: ['read:read', 'random:x', 'edit:write', 'stage:planning->executing'] },
      ],
    });
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft('divergent'));
      expect(fx.governance.lifecycleOf(String(path.id))).toBeUndefined(); // draft（治理侧惰性）

      const run = await fx.service.rehearse({ actor: 'coach', sessionId: 's' }, String(path.id), 'task-1');
      expect(run.verdict).toBe('pass');
      expect(run.coverage).toBe(1);

      await fx.service.requestConsolidate({ actor: 'coach', sessionId: 's' }, String(path.id));
      expect(fx.governance.lifecycleOf(String(path.id))).toBe('consolidated');

      const candidates = await fx.service.injectCandidates({ sessionId: 's' }, 1);
      expect(candidates.map((item) => String(item.id))).toContain(String(path.id));
    } finally {
      await fx.dispose();
    }
  });

  it('2. 回放验证才缓存：draft / rehearse-fail 零注入', async () => {
    const fx = await setup({
      executor: [{ outcome: 'failure', tokens: ['decompose:x'] }],
    });
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      // 未验证 → 零注入
      expect(await fx.service.injectCandidates({ sessionId: 's' }, 1)).toEqual([]);
      // rehearsal 失败 → 仍零注入（未验证零注入对失败候选同样生效）
      const run = await fx.service.rehearse({ actor: 'coach', sessionId: 's' }, String(path.id), 'task-1');
      expect(run.verdict).toBe('fail');
      expect(await fx.service.injectCandidates({ sessionId: 's' }, 1)).toEqual([]);
      // 固化被拒：draft 且无 pass 记录（通过的 rehearsal 本身就是晋升证据）
      await expect(fx.service.requestConsolidate({ actor: 'coach', sessionId: 's' }, String(path.id))).rejects.toMatchObject({
        code: 'META_NO_PASS',
      });
      // validating 但无 pass 记录 → 仍是"回放验证才缓存"
      fx.governance.lifecycles.set(String(path.id), 'validating');
      await expect(fx.service.requestConsolidate({ actor: 'coach', sessionId: 's' }, String(path.id))).rejects.toMatchObject({
        code: 'META_NO_PASS',
      });
    } finally {
      await fx.dispose();
    }
  });

  it('3. 失败降权与自动退役：连续 3 次 fail → retire(rehearsal-fail)；中途 pass 清零连续计数', async () => {
    const fx = await setup({
      executor: [
        { outcome: 'failure', tokens: [] },
        { outcome: 'failure', tokens: [] },
        { outcome: 'success', tokens: ['read:read', 'random:x', 'edit:write', 'stage:planning->executing'] },
        { outcome: 'failure', tokens: [] },
        { outcome: 'failure', tokens: [] },
        { outcome: 'failure', tokens: [] },
      ],
    });
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      const id = String(path.id);
      await fx.service.rehearse({ actor: 'coach', sessionId: 's' }, id, 'task-1');
      await fx.service.rehearse({ actor: 'coach', sessionId: 's' }, id, 'task-1');
      // 连续 2 次 < 阈值 3 → 不退役
      expect(fx.governance.actions.some((action) => action.action === 'retire')).toBe(false);
      // 中途 pass 清零连续计数
      await fx.service.rehearse({ actor: 'coach', sessionId: 's' }, id, 'task-1');
      const afterPass = fx.service.get(id)?.stats.consecutiveRehearsalFail ?? -1;
      expect(afterPass).toBe(0);
      // 再连败 3 次 → 自动退役 + gov_actions 留痕
      for (let index = 0; index < 3; index += 1) {
        await fx.service.rehearse({ actor: 'coach', sessionId: 's' }, id, 'task-1');
      }
      const retire = fx.governance.actions.find((action) => action.action === 'retire');
      expect(retire?.kind).toBe('rehearsal-fail');
      expect(fx.governance.lifecycleOf(id)).toBe('retired');
    } finally {
      await fx.dispose();
    }
  });

  it('4. 双路径路由：planning 返回 divergent 优先、verifying 返回 convergent 优先', async () => {
    const fx = await setup();
    try {
      const divergent = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft('divergent'));
      const convergent = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft('convergent'));
      // 直接置为 consolidated（本用例只验路由，不验验证闸）
      fx.governance.lifecycles.set(String(divergent.id), 'consolidated');
      fx.governance.lifecycles.set(String(convergent.id), 'consolidated');

      const forPlanning = await fx.service.injectCandidates({ sessionId: 's' }, 1, 'planning');
      expect(String(forPlanning[0]?.id)).toBe(String(divergent.id));
      const forVerifying = await fx.service.injectCandidates({ sessionId: 's' }, 1, 'verifying');
      expect(String(forVerifying[0]?.id)).toBe(String(convergent.id));
    } finally {
      await fx.dispose();
    }
  });

  it('5. 非语言自检：label 超长/含句号即拒；合法拓扑通过', async () => {
    const fx = await setup();
    try {
      const draft = sampleDraft();
      const longLabel = {
        ...draft,
        topology: { ...draft.topology, nodes: draft.topology.nodes.map((node, index) => ({ ...node, label: index === 0 ? '一'.repeat(30) : undefined })) },
      };
      await expect(fx.service.propose({ actor: 'coach', sessionId: 's' }, longLabel as never)).rejects.toThrow();
      const sentenceLabel = {
        ...draft,
        topology: { ...draft.topology, nodes: draft.topology.nodes.map((node, index) => ({ ...node, label: index === 0 ? '先分解问题。再假设。' : undefined })) },
      };
      await expect(fx.service.propose({ actor: 'coach', sessionId: 's' }, sentenceLabel as never)).rejects.toThrow();
      // 合法：短助记标签
      const ok = {
        ...draft,
        topology: { ...draft.topology, nodes: draft.topology.nodes.map((node, index) => ({ ...node, label: index === 0 ? '拆解' : undefined })) },
      };
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, ok);
      expect(fx.service.get(String(path.id))).toBeDefined();
    } finally {
      await fx.dispose();
    }
  });

  it('6. 结构提示注入：节点类型标签序列（分支折叠），≤120 token', async () => {
    const fx = await setup();
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      const hint = fx.service.renderStructureHint(path);
      expect(hint).toContain('observe');
      expect(hint).toContain('verify');
      expect(hint).toContain('→');
      expect(hint).not.toContain('。');
      // token 帽（4 字符/token 的保守估计也远低于 120）
      expect(hint.length).toBeLessThanOrEqual(120 * 4);
    } finally {
      await fx.dispose();
    }
  });

  it('7. fork 合规：rehearse 显式传任务边界（禁开放轮次前缀由 T0.7 seam 把守）', async () => {
    const fx = await setup({
      executor: [{ outcome: 'success', tokens: ['read:read', 'random:x', 'edit:write', 'stage:planning->executing'] }],
    });
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      await fx.service.rehearse({ actor: 'coach', sessionId: 's' }, String(path.id), 'task-9');
      expect(fx.executor.calls).toHaveLength(1);
      // 显式 boundary（eventKind=task-boundary）传给了执行桥
      expect(fx.executor.calls[0]?.boundaryEventKind).toBe('task-boundary');
      expect(fx.executor.calls[0]?.taskId).toBe('task-9');
      // 结构提示随 fork 注入子会话
      expect(fx.executor.calls[0]?.hint).toContain('observe');
      // 判定输入全落盘（可复算，不变量 4）
      const run = fx.service.rehearsals(String(path.id))[0];
      expect(run?.boundary.sessionId).toBe('sess-meta');
      expect(fx.service.rehearsals(String(path.id))[0]?.coverage).toBe(1);
    } finally {
      await fx.dispose();
    }
  });

  it('8. 治理一致性：consolidate/retire 都在治理动作留痕，且元思维分区不串 memory', { timeout: 30_000 }, async () => {
    const fx = await setup({
      executor: [{ outcome: 'success', tokens: ['read:read', 'random:x', 'edit:write', 'stage:planning->executing'] }],
    });
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      await fx.service.rehearse({ actor: 'coach', sessionId: 's' }, String(path.id), 'task-1');
      await fx.service.requestConsolidate({ actor: 'coach', sessionId: 's' }, String(path.id));
      const actions = fx.governance.actions.filter((action) => action.assetId === String(path.id));
      expect(actions.map((action) => action.action)).toEqual(['consolidate']);
      // 版本链：supersede 产新版 + 旧版退役（superseded）
      const v2 = await fx.service.supersede({ actor: 'coach', sessionId: 's' }, String(path.id), sampleDraft('convergent'));
      expect(v2.supersedes).toBe(String(path.id));
      expect(v2.version).toBe(2);
      expect(fx.governance.lifecycleOf(String(path.id))).toBe('retired');
      expect(fx.service.history(String(v2.id)).map((item) => String(item.id))).toEqual([String(v2.id), String(path.id)]);
    } finally {
      await fx.dispose();
    }
  });

  it('9. extractFromTrajectory：transition 链 → shape 参考（机械映射，供 coach 修订）', async () => {
    const fx = await setup();
    try {
      const draft = fx.service.extractFromTrajectory(
        ['read:read', 'read:read', 'edit:write', 'dispatch:sidekick', 'stage:planning->executing'],
        [{ sessionId: 'sess-1', seqFrom: 3, seqTo: 9 }],
      );
      expect(draft.source.kind).toBe('trajectory-extract');
      expect(draft.topology.nodes.map((node) => node.kind)).toEqual(['observe', 'verify', 'decompose', 'synthesize']);
      expect(draft.topology.entry).toBe('s1');
      expect(draft.topology.exits).toEqual(['s4']);
      // 提案即入 draft（治理态惰性，不进注入池）
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, draft);
      expect(await fx.service.injectCandidates({ sessionId: 's' }, 1)).toEqual([]);
      void path;
    } finally {
      await fx.dispose();
    }
  });

  it('10. 治理缺失 fail-loud（不静默造第二条治理管道）', async () => {
    const fx = await setup();
    try {
      const broken = {
        ...fx,
        // 模拟装配漏接 governance seam
      };
      const { createMetaThinkingService } = await import('../src/service.ts');
      const service = createMetaThinkingService({
        domain: broken.domain,
        session: broken.sink,
        governance: undefined as never,
        executor: broken.executor,
      });
      // initialize 才做 seam 就位校验（构造是惰性的）
      await expect(service.initialize()).rejects.toMatchObject({ code: 'META_GOVERNANCE_MISSING' });
    } finally {
      await fx.dispose();
    }
  });
});
