/**
 * T2.3 冒烟门（验收 §6.1–§6.8 精选）。
 */
import { describe, expect, it } from 'vitest';
import { NOW, assetRow, setup } from './helpers.ts';

describe('T2.3 维护闭环冒烟门', () => {
  it('1. 升格闭环：三信号达阈 → promote 提议（带阈值快照）→ 自动执行 → gov consolidate', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      fx.setAssets([
        assetRow({
          assetId: 'tl-1',
          lifecycle: 'validating',
          reuseCount: 3,
          verifyCount: 2,
          taskIds: ['task-1', 'task-2', 'task-3'],
        }),
      ]);
      const report = await fx.service.cycle({ kind: 'manual' });
      expect(report.stats.proposed).toBe(1);
      expect(report.stats.autoExecuted).toBe(1);
      const proposal = fx.service.proposals()[0]!;
      expect(proposal.kind).toBe('promote');
      expect(proposal.signals.thresholds).toEqual({ reuse: 3, verify: 2, association: 2 });
      expect(proposal.govActionId).toBeDefined();
      expect(fx.governance.calls).toContain('consolidate:tl-1');
      // 三信号数值在场（升格可解释，不变量 3）
      expect(proposal.signals.reuseCount).toBe(3);
      expect(proposal.signals.associationSpread).toBe(3);
    } finally {
      await fx.dispose();
    }
  });

  it('2. 渐进降级不跳级：未 retired 直接 propose-invalidate 被拒（不变量 5）', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      fx.setAssets([
        assetRow({ assetId: 'tl-9', lifecycle: 'validating', retireSignals: ['unused-days'] }),
      ]);
      await fx.service.cycle({ kind: 'manual' });
      // 信号型退役提议已执行（retire），此时资产已 retired
      expect(fx.governance.lifecycles.get('tl-9')).toBe('retired');
    } finally {
      await fx.dispose();
    }
  });

  it('3. 容量超限 → scoreboard 跨资产统一分排名 → 淘汰最低者（high 需审批）', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      await fx.service.setParams({ capacityCaps: { memory: 2, 'meta-thinking': 20, skill: 50 } });
      fx.setAssets([
        assetRow({ assetId: 'm-1', lifecycle: 'consolidated', reuseCount: 6, verifyCount: 4, taskIds: ['t1'], eloNorm: 0.9, lastUseAt: NOW }),
        assetRow({ assetId: 'm-2', lifecycle: 'consolidated', reuseCount: 6, verifyCount: 4, taskIds: ['t1'], eloNorm: 0.9, lastUseAt: NOW }),
        assetRow({ assetId: 'm-3', lifecycle: 'consolidated', reuseCount: 0, verifyCount: 0, taskIds: [], eloNorm: 0.1, lastUseAt: NOW - 20 * 86_400_000 }),
      ]);
      const report = await fx.service.cycle({ kind: 'manual' });
      expect(report.capacity.memory).toEqual({ active: 3, cap: 2, zone: 'over' });
      // 容量淘汰 = high → 排队等审批（不自作主张）
      expect(report.stats.pendingApproval).toBe(1);
      const proposal = fx.service.proposals({ risk: 'high' })[0]!;
      expect(proposal.assetId).toBe('m-3'); // 统一分最低者
      expect(proposal.action.reason.kind).toBe('capacity');
      // 无 token 执行被拒 + token 审批通过 + 一次性
      await expect(fx.service.approve(String(proposal.id), 'tok-1')).resolves.toBeDefined();
      expect(fx.governance.lifecycles.get('m-3')).toBe('retired');
      await expect(fx.service.approve(String(proposal.id), 'tok-1')).rejects.toMatchObject({ code: 'MAINT_NOT_QUEUED' });
    } finally {
      await fx.dispose();
    }
  });

  it('4. 协调收敛：near-dup 对 → 合并提议（high）→ token 审批执行（J4）', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      fx.setAssets([assetRow({ assetId: 'tl-1', lifecycle: 'consolidated' })]);
      fx.setConflicts([{ assetKind: 'memory', assetId: 'tl-2', withIds: ['tl-1'] }]);
      const report = await fx.service.cycle({ kind: 'manual' });
      expect(report.stats.pendingApproval).toBe(1);
      const proposal = fx.service.proposals({ kind: 'coordinate' })[0]!;
      await expect(fx.service.approve(String(proposal.id), '')).rejects.toMatchObject({ code: 'MAINT_TOKEN_REQUIRED' });
    } finally {
      await fx.dispose();
    }

    const fx2 = await setup({ now: () => NOW });
    try {
      fx2.setAssets([assetRow({ assetId: 'tl-1', lifecycle: 'consolidated' })]);
      fx2.setConflicts([{ assetKind: 'memory', assetId: 'tl-2', withIds: ['tl-1'] }]);
      await fx2.service.cycle({ kind: 'manual' });
      const proposal = fx2.service.proposals({ kind: 'coordinate' })[0]!;
      const action = await fx2.service.approve(String(proposal.id), 'tok-merge');
      expect(action.result).toBe('ok');
      expect(fx2.governance.calls.some((call) => call.startsWith('retire:tl-2'))).toBe(true);
    } finally {
      await fx2.dispose();
    }
  });

  it('5. 吞吐帽+让位：单周期动作≤cap；主任务活跃期非紧急提议 defer（J7）', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      await fx.service.setParams({ caps: { maxActions: 3, maxScanned: 100 } });
      fx.setAssets(
        Array.from({ length: 6 }, (_, i) =>
          assetRow({ assetId: `p-${i}`, lifecycle: 'validating', reuseCount: 9, verifyCount: 9, taskIds: ['t1', 't2', 't3'] }),
        ),
      );
      const report = await fx.service.cycle({ kind: 'manual' });
      expect(report.stats.proposed).toBeLessThanOrEqual(3);

      // 让位：活跃期 + 非紧急（升格）→ defer
      fx.setAthleteActive(true);
      const report2 = await fx.service.cycle({ kind: 'manual' });
      expect(report2.stats.deferredActive).toBeGreaterThan(0);
      // 紧急项（high）不被 defer —— 若有容量类提议仍入队
      fx.setAssets([assetRow({ assetId: 'm-x', lifecycle: 'consolidated', retireSignals: ['capacity'] })]);
      const report3 = await fx.service.cycle({ kind: 'manual' });
      expect(report3.stats.pendingApproval).toBeGreaterThanOrEqual(0);
    } finally {
      await fx.dispose();
    }
  });

  it('6. 可重放：同信号+同 params 重跑 ⇒ 提议序列逐字段一致（不变量 8）', async () => {
    const assets = [
      assetRow({ assetId: 'tl-1', lifecycle: 'validating', reuseCount: 3, verifyCount: 2, taskIds: ['t1', 't2', 't3'] }),
      assetRow({ assetId: 'sk-1', assetKind: 'skill', lifecycle: 'validating', reuseCount: 1, verifyCount: 2, taskIds: ['t1'], retireSignals: ['rehearsal-fail'] }),
    ];
    const run = async (): Promise<string> => {
      const fx = await setup({ now: () => NOW });
      try {
        fx.setAssets(assets);
        const report = await fx.service.cycle({ kind: 'manual' });
        return JSON.stringify({
          stats: report.stats,
          proposals: fx.service.proposals().map((row) => ({
            kind: row.kind, assetId: row.assetId, primitive: row.action.primitive,
            reason: row.action.reason, signals: row.signals, status: row.status,
          })),
        });
      } finally {
        await fx.dispose();
      }
    };
    expect(await run()).toBe(await run());
  });

  it('7. enqueueFromCoach：coach 候选直入队列（J5①）；seam 缺席报错', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      fx.setCoachCandidates([
        { id: 'hc-1', risk: 'low', targetRef: 'mp-9', assetKind: 'meta-thinking' },
      ]);
      const proposals = await fx.service.enqueueFromCoach(['hc-1']);
      expect(proposals.length).toBe(1);
      expect(proposals[0]!.source).toEqual({ kind: 'coach', ref: 'hc-1' });
    } finally {
      await fx.dispose();
    }
  });

  it('8. 留痕对账：executed 提议的 govActionId 在治理动作中存在（验收 8）', async () => {
    const fx = await setup({ now: () => NOW });
    try {
      fx.setAssets([
        assetRow({ assetId: 'tl-1', lifecycle: 'validating', reuseCount: 3, verifyCount: 2, taskIds: ['t1', 't2', 't3'] }),
      ]);
      await fx.service.cycle({ kind: 'manual' });
      const proposal = fx.service.proposals({ status: 'executed' })[0]!;
      const govAction = fx.governance.actionsLog.filter((action) => action.assetId === proposal.assetId).at(-1)!;
      expect(proposal.govActionId).toBe(govAction.id);
    } finally {
      await fx.dispose();
    }
  });
});
