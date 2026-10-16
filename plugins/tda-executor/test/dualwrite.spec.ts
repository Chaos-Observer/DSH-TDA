/**
 * tda-executor 双写对账门（门3 test:dualwrite）。
 *
 * 写组合：attempt 与 params **均为权威**（`dualWrite` + 族 `executor/change`，
 * businessId=attemptId / 'params'）——attempt 的调度决策不可由他域重放重建
 * （P1 纪律 #12：不可重算 ⇒ 权威）。本门验证配对、索引、总线载荷与回放等价。
 */
import { describe, expect, it } from 'vitest';
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import { EXECUTOR_PARAMS_BUSINESS_ID } from '../src/domain.ts';
import { makeTask, setup } from './helpers.ts';

describe('T4.1 双写与审计', () => {
  it('params 种子与 attempt 终态逐一配对；无反向洞', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      await rig.service.runOnce();
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      // params 种子（1）+ attempt 生命周期（claimed→executing→verifying→completed 四条）
      expect(report.pairedWrites).toBeGreaterThanOrEqual(2);
      const attempt = rig.service.attempts({ taskId: 'task-1' })[0];
      expect(attempt?.status).toBe('completed');
      expect(rig.reconciler.reconcile().unmatchedWrites).toBe(0);
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 executor 实体延展；locate 可定位 attempt', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      await rig.service.runOnce();
      const attempt = rig.service.attempts({ taskId: 'task-1' })[0];
      expect(attempt).toBeDefined();
      const located = rig.index.locate('executor', String(attempt?.id));
      expect(located?.entityId).toBe(String(attempt?.id));
      expect(rig.index.entries().every((entry) => entry.entityKind === 'executor')).toBe(true);
      expect(rig.index.locate('executor', EXECUTOR_PARAMS_BUSINESS_ID)?.entityId).toBe('params');
    } finally {
      await rig.dispose();
    }
  });

  it('总线载荷 = 全快照（键序与 schema 定义序一致）', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      await rig.service.runOnce();
      const last = rig.published.filter((event) => event.businessId !== 'params').at(-1);
      expect(last).toBeDefined();
      expect(Object.keys(last?.payload ?? {})).toEqual([
        'id',
        'revision',
        'taskId',
        'goalId',
        'mode',
        'modeReason',
        'orderId',
        'status',
        'attempts',
        'ownerId',
        'verification',
        'outcome',
        'createdAt',
        'settledAt',
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('回放等价：按日志重建 attempt/params 终态与域内逐字节一致', async () => {
    const rig = await setup({ tasks: [makeTask()] });
    try {
      await rig.service.runOnce();
      await rig.service.setParams('human', { maxParallel: 3 });
      const events = rig.published;
      const attemptsDiff = compareReplay(
        events,
        rig.domain.table('executor_attempts').entries(),
        (event) =>
          event.businessId === 'params' ? undefined : { key: event.businessId, value: event.payload },
      );
      assertReplayEquivalence(attemptsDiff);
      const paramsDiff = compareReplay(
        events,
        rig.domain.table('executor_params').entries(),
        (event) => (event.businessId === 'params' ? { key: 'singleton', value: event.payload } : undefined),
      );
      assertReplayEquivalence(paramsDiff);
      expect(attemptsDiff.equal).toBe(true);
      expect(paramsDiff.equal).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('每次 accepted 变更都有配对事件（域↔事件双向零差异）', async () => {
    const rig = await setup({ tasks: [makeTask(), makeTask({ id: 'task-2', subject: '第二个任务', priority: 9 })] });
    try {
      await rig.service.runOnce();
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      // 两个任务各一条 attempt 生命周期 + params 种子
      const executorEvents = rig.session.appends.filter((event) => event.family === 'executor/change');
      expect(executorEvents.length).toBeGreaterThanOrEqual(3);
      expect(rig.domain.table('executor_attempts').size()).toBe(2);
    } finally {
      await rig.dispose();
    }
  });
});
