/**
 * tda-planner 双写对账门（门3 test:dualwrite）。
 *
 * 写组合：plan 与 contingency **均为权威**（`dualWrite` + 族 `planner/change`，
 * businessId=planId / contingencyId / 'params'）——计划快照与预案切换决策不可
 * 由他域重放重建（P1 纪律 #12：不可重算 ⇒ 权威）。本门验证配对、索引、
 * 总线载荷与回放等价。
 */
import { describe, expect, it } from 'vitest';
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import { PLANNER_PARAMS_BUSINESS_ID } from '../src/domain.ts';
import { makeGoodPlan, setup } from './helpers.ts';

describe('T4.5 双写与审计', () => {
  it('params 种子与 plan 生命周期逐一配对；无反向洞', async () => {
    const rig = await setup();
    try {
      const { planId, approvalId } = await makeGoodPlan(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(planId, ticket);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      // params 种子（1）+ plan 创建/提请/审批应用（3）+ contingency 0（标准计划无预案边）
      expect(report.pairedWrites).toBeGreaterThanOrEqual(4);
      expect(rig.reconciler.reconcile().unmatchedWrites).toBe(0);
      const plan = rig.service.plan(planId);
      expect(plan?.status).toBe('applied');
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 plan 实体延展；locate 可定位 plan', async () => {
    const rig = await setup();
    try {
      const { planId, approvalId } = await makeGoodPlan(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(planId, ticket);
      const located = rig.index.locate('plan', planId);
      expect(located?.entityId).toBe(planId);
      expect(rig.index.entries().every((entry) => entry.entityKind === 'plan')).toBe(true);
      expect(rig.index.locate('plan', PLANNER_PARAMS_BUSINESS_ID)?.entityId).toBe('params');
    } finally {
      await rig.dispose();
    }
  });

  it('总线载荷 = 全快照（键序与 schema 定义序一致）', async () => {
    const rig = await setup();
    try {
      const { planId } = await makeGoodPlan(rig);
      const last = rig.published.filter((event) => event.businessId === planId).at(-1);
      expect(last).toBeDefined();
      expect(Object.keys(last?.payload ?? {})).toEqual([
        'id',
        'revision',
        'goalId',
        'status',
        'kind',
        'tasks',
        'coverage',
        'generation',
        'createdAt',
      ]);
      // tasks 内层键序（与 PlannedTaskSchema 定义序一致）
      const tasks = (last?.payload as { tasks: Record<string, unknown>[] }).tasks;
      expect(Object.keys(tasks[0] ?? {})).toEqual([
        'tempId',
        'subject',
        'completionCriteria',
        'blockedByTempIds',
        'criteriaRefs',
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('回放等价：按日志重建 plan/params 终态与域内逐字节一致', async () => {
    const rig = await setup();
    try {
      const { planId, approvalId } = await makeGoodPlan(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(planId, ticket);
      await rig.service.setParams('human', { verifyFailThreshold: 3 });
      const events = rig.published;
      const plansDiff = compareReplay(
        events,
        rig.domain.table('planner_plans').entries(),
        (event) => (event.businessId === 'params' ? undefined : { key: event.businessId, value: event.payload }),
      );
      assertReplayEquivalence(plansDiff);
      const paramsDiff = compareReplay(
        events,
        rig.domain.table('planner_params').entries(),
        (event) => (event.businessId === 'params' ? { key: 'singleton', value: event.payload } : undefined),
      );
      assertReplayEquivalence(paramsDiff);
      expect(plansDiff.equal).toBe(true);
      expect(paramsDiff.equal).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('每次 accepted 变更都有配对事件（域↔事件双向零差异）', async () => {
    const rig = await setup();
    try {
      const { planId, approvalId } = await makeGoodPlan(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(planId, ticket);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      const plannerEvents = rig.session.appends.filter((event) => event.family === 'planner/change');
      // params 种子 1 + plan 创建/提请/应用 3
      expect(plannerEvents.length).toBeGreaterThanOrEqual(4);
      expect(rig.domain.table('planner_plans').size()).toBe(1);
    } finally {
      await rig.dispose();
    }
  });
});
