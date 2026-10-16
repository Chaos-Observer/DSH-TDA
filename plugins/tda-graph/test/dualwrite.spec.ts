/**
 * tda-graph 双写对账门（门3 test:dualwrite）。
 *
 * T4.3 J10：graph 是**纯派生层，不立事件族、不产事件**——派生写走
 * `dualWriteDerived`（派生窗，不计配对）。本门验证：
 *  1. 全查询生命周期零总线发布（任何族都不该有 graph 的事件）；
 *  2. 派生窗内的域变更被对账器归为 derivedChanges（不产生未配对告警）；
 *  3. 权威域（假体）在 graph 全生命周期内零写调用（J7 零写权对账）。
 */
import { describe, expect, it } from 'vitest';
import { makeFile, makeGoal, makeTask, setup } from './helpers.ts';

describe('T4.3 派生层无声学（J10）', () => {
  it('rebuild/查询全生命周期零总线发布', async () => {
    const rig = await setup({
      goals: [makeGoal()],
      tasks: [makeTask({ localPath: 'ws/a' })],
    });
    try {
      rig.workspace.setNeighborhood('task-1', [makeFile('ws/a/x.ts')], [
        { from: 'ws/a/x.ts', to: 'ws/a/y.ts', kind: 'depends-on' },
      ]);
      await rig.service.rebuild();
      expect(rig.service.stats().state).toBe('fresh');
      rig.service.subtree();
      rig.service.blockedChain('task-1');
      rig.service.export('json');
      rig.service.export('dot');
      // 零事件：graph 不产任何族的总线发布（未登记族双写即抛的内核门 + 本对账双保险）
      expect(rig.published).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });

  it('派生窗归账：域变更计 derivedChanges，不产生 unpairedChanges', async () => {
    const rig = await setup({
      goals: [makeGoal()],
      tasks: [makeTask()],
    });
    try {
      await rig.service.rebuild();
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.derivedChanges).toBeGreaterThan(0);
      expect(report.unpairedChanges).toHaveLength(0);
      expect(report.unmatchedWrites).toBe(0);
    } finally {
      await rig.dispose();
    }
  });

  it('权威域零写权（J7）：全生命周期假体只收到只读调用', async () => {
    const rig = await setup({
      goals: [makeGoal()],
      tasks: [makeTask()],
    });
    try {
      await rig.service.rebuild();
      rig.service.subtree();
      rig.service.crossGoalDependencies();
      rig.service.taskGraph('task-1');
      // 假体只有只读面（类型级），调用日志只含 tree/get/list/graph
      const allCalls = [...rig.goal.calls, ...rig.taskPool.calls, ...rig.workspace.calls];
      expect(allCalls.every((call) => /^(tree|get|list|graph)/.test(call))).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
