/**
 * tda-planner 门 1：不变量（加载期检查 + 纯函数逐分支）。
 *
 * 覆盖 T4.5 §4.1：质量门五查（纯函数）/触发检测确定性（纯函数）/
 * 加载期六查（params 单行/终态 settled/applied 溯源/supersede 链/
 * 预案引用/零执行面）。
 */
import { describe, expect, it } from 'vitest';
import {
  asContingencyId,
  createTdaInvariantRegistry,
} from '@tda/kernel';
import { registerPlannerInvariants } from '../src/loadChecks.ts';
import {
  evaluatePlan,
  evaluateTriggers,
  type QualityGateContext,
} from '../src/service.ts';
import type { PlanContingency, PlannedTask } from '../src/domain.ts';
import { makeGoodPlan, NOW, setup } from './helpers.ts';

// ── 纯函数：质量门五查 ─────────────────────────────────────────────────

const CTX: QualityGateContext = {
  goalCriteria: ['标准甲', '标准乙'],
  goalRemaining: { tokens: 100 },
};

const goodTask = (overrides: Partial<PlannedTask> = {}): PlannedTask => ({
  tempId: 't1',
  subject: '任务甲',
  completionCriteria: ['证据路径'],
  blockedByTempIds: [],
  criteriaRefs: [0],
  ...overrides,
});

describe('T4.5 质量门五查（evaluatePlan 纯函数）', () => {
  it('好计划五查全过', () => {
    const report = evaluatePlan(
      [
        goodTask({ tempId: 't1', criteriaRefs: [0] }),
        goodTask({ tempId: 't2', subject: '任务乙', criteriaRefs: [1] }),
      ],
      CTX,
    );
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(5);
    expect(report.checks.every((item) => item.passed)).toBe(true);
  });

  it('① criteria 无覆盖被拒（含 criteriaRefs 越界不计覆盖）', () => {
    const report = evaluatePlan([goodTask({ criteriaRefs: [0] })], CTX);
    const check = report.checks.find((item) => item.id === 'criteria-coverage');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('索引 [1]');

    const outOfRange = evaluatePlan([goodTask({ criteriaRefs: [5] })], CTX);
    expect(outOfRange.checks.find((item) => item.id === 'criteria-coverage')?.passed).toBe(false);
  });

  it('② 预算不守恒被拒（Σ子帽 > 父帽；Σ根帽 > 目标剩余）', () => {
    const childOver = evaluatePlan(
      [
        goodTask({ tempId: 'p', budget: { tokens: 10 } }),
        goodTask({ tempId: 'c1', parentTempId: 'p', budget: { tokens: 8 }, criteriaRefs: [0] }),
        goodTask({ tempId: 'c2', parentTempId: 'p', budget: { tokens: 8 }, criteriaRefs: [1] }),
      ],
      CTX,
    );
    expect(childOver.checks.find((item) => item.id === 'budget-conservation')?.passed).toBe(false);

    const rootOver = evaluatePlan(
      [
        goodTask({ tempId: 't1', budget: { tokens: 80 } }),
        goodTask({ tempId: 't2', budget: { tokens: 80 }, criteriaRefs: [1] }),
      ],
      CTX,
    );
    expect(rootOver.checks.find((item) => item.id === 'budget-conservation')?.passed).toBe(false);

    // 守恒情形：子帽和 = 父帽、根帽和 = 目标剩余
    const conserved = evaluatePlan(
      [
        goodTask({ tempId: 'p', budget: { tokens: 100 } }),
        goodTask({ tempId: 'c1', parentTempId: 'p', budget: { tokens: 60 }, criteriaRefs: [0] }),
        goodTask({ tempId: 'c2', parentTempId: 'p', budget: { tokens: 40 }, criteriaRefs: [1] }),
      ],
      CTX,
    );
    expect(conserved.checks.find((item) => item.id === 'budget-conservation')?.passed).toBe(true);
  });

  it('③ 合并图成环被拒（阻塞依赖环；含悬挂引用）', () => {
    const cyclic = evaluatePlan(
      [
        goodTask({ tempId: 'a', blockedByTempIds: ['b'], criteriaRefs: [0] }),
        goodTask({ tempId: 'b', blockedByTempIds: ['a'], criteriaRefs: [1] }),
      ],
      CTX,
    );
    const check = cyclic.checks.find((item) => item.id === 'dag-acyclic');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('成环');

    const dangling = evaluatePlan([goodTask({ blockedByTempIds: ['ghost'], criteriaRefs: [0, 1] })], CTX);
    expect(dangling.checks.find((item) => item.id === 'dag-acyclic')?.passed).toBe(false);
  });

  it('④ 叶子不可执行被拒（subject 空 / criteria 空）', () => {
    const noSubject = evaluatePlan(
      [
        goodTask({ tempId: 't1', subject: '  ', criteriaRefs: [0] }),
        goodTask({ tempId: 't2', subject: '任务乙', completionCriteria: [], criteriaRefs: [1] }),
      ],
      CTX,
    );
    const check = noSubject.checks.find((item) => item.id === 'leaf-executable');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('subject 为空');
    expect(check?.detail).toContain('completionCriteria 为空');
  });

  it('⑤ 高风险无预案且无理由被拒；有备选边无 contingency 也被拒', () => {
    const noContingency = evaluatePlan(
      [
        goodTask({ tempId: 't1', criteriaRefs: [0], localPath: 'ws/a', writeScopes: ['ws/b/x'] }),
        goodTask({ tempId: 't2', subject: '任务乙', criteriaRefs: [1] }),
      ],
      CTX,
    );
    const check = noContingency.checks.find((item) => item.id === 'contingency-coverage');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('无预案且无显式理由');

    // 显式理由 ⇒ 过
    const withReason = evaluatePlan(
      [
        goodTask({ tempId: 't1', criteriaRefs: [0], localPath: 'ws/a', writeScopes: ['ws/b/x'], noContingencyReason: '只读分析无副作用' }),
        goodTask({ tempId: 't2', subject: '任务乙', criteriaRefs: [1] }),
      ],
      CTX,
    );
    expect(withReason.checks.find((item) => item.id === 'contingency-coverage')?.passed).toBe(true);

    // 有备选边但无 contingency 结构 ⇒ 拒
    const edgeNoStruct = evaluatePlan(
      [
        goodTask({ tempId: 't1', criteriaRefs: [0], alternativeOfTempId: 't2' }),
        goodTask({ tempId: 't2', subject: '任务乙', criteriaRefs: [1] }),
      ],
      CTX,
    );
    expect(edgeNoStruct.checks.find((item) => item.id === 'contingency-coverage')?.passed).toBe(false);
  });
});

// ── 纯函数：触发检测 ───────────────────────────────────────────────────

const contingency = (overrides: Partial<PlanContingency> = {}): PlanContingency => ({
  id: asContingencyId('cont-1'),
  revision: 0,
  planId: 'plan-1',
  primaryTaskId: 'task-1',
  alternativeTaskId: 'task-2',
  trigger: { kind: 'task-failed', taskTempId: 't1' },
  status: 'dormant',
  carveOut: 0.5,
  ...overrides,
});

const taskState = (overrides: Partial<{ id: string; phase: string; outcome?: string; zone: string; consecutiveFailures: number }> = {}) => ({
  id: 'task-1',
  phase: 'active',
  zone: 'normal',
  consecutiveFailures: 0,
  ...overrides,
});

const PARAMS = { autoExpire: true, verifyFailThreshold: 2 };

describe('T4.5 触发检测（evaluateTriggers 纯函数）', () => {
  it('task-failed：主路径失败终态 ⇒ activate', () => {
    const events = evaluateTriggers(
      [contingency()],
      new Map([['task-1', taskState({ phase: 'complete', outcome: 'failed' })]]),
      PARAMS,
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('activate');
    expect(events[0]?.contingencyId).toBe('cont-1');
  });

  it('task-blocked：主路径 blocked ⇒ activate', () => {
    const events = evaluateTriggers(
      [contingency({ trigger: { kind: 'task-blocked', taskTempId: 't1' } })],
      new Map([['task-1', taskState({ phase: 'blocked' })]]),
      PARAMS,
      NOW,
    );
    expect(events.map((item) => item.kind)).toEqual(['activate']);
  });

  it('budget-zone：进入 converge/exhausted 区 ⇒ activate；normal 不触发', () => {
    const fired = evaluateTriggers(
      [contingency({ trigger: { kind: 'budget-zone', zone: 'converge' } })],
      new Map([['task-1', taskState({ zone: 'converge' })]]),
      PARAMS,
      NOW,
    );
    expect(fired).toHaveLength(1);
    const quiet = evaluateTriggers(
      [contingency({ trigger: { kind: 'budget-zone', zone: 'converge' } })],
      new Map([['task-1', taskState({ zone: 'normal' })]]),
      PARAMS,
      NOW,
    );
    expect(quiet).toHaveLength(0);
  });

  it('verify-failed：连续失败 ≥ max(trigger.attempts, verifyFailThreshold) ⇒ activate', () => {
    const events = evaluateTriggers(
      [contingency({ trigger: { kind: 'verify-failed', attempts: 3 } })],
      new Map([['task-1', taskState({ consecutiveFailures: 3 })]]),
      PARAMS,
      NOW,
    );
    expect(events).toHaveLength(1);
    const below = evaluateTriggers(
      [contingency({ trigger: { kind: 'verify-failed', attempts: 3 } })],
      new Map([['task-1', taskState({ consecutiveFailures: 2 })]]),
      PARAMS,
      NOW,
    );
    expect(below).toHaveLength(0);
  });

  it('expire：主路径 success 完成 ⇒ 自动作废（autoExpire）', () => {
    const events = evaluateTriggers(
      [contingency()],
      new Map([['task-1', taskState({ phase: 'complete', outcome: 'success' })]]),
      PARAMS,
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('expire');
  });

  it('非 dormant / 任务缺失 / autoExpire 关 均不产事件', () => {
    const notDormant = evaluateTriggers(
      [contingency({ status: 'triggered' })],
      new Map([['task-1', taskState({ phase: 'complete', outcome: 'failed' })]]),
      PARAMS,
      NOW,
    );
    expect(notDormant).toHaveLength(0);

    const missing = evaluateTriggers([contingency()], new Map(), PARAMS, NOW);
    expect(missing).toHaveLength(0);

    const noAutoExpire = evaluateTriggers(
      [contingency()],
      new Map([['task-1', taskState({ phase: 'complete', outcome: 'success' })]]),
      { autoExpire: false, verifyFailThreshold: 2 },
      NOW,
    );
    expect(noAutoExpire).toHaveLength(0);
  });
});

// ── 加载期检查 ─────────────────────────────────────────────────────────

describe('T4.5 加载期检查', () => {
  it('正常域 verify 通过', async () => {
    const rig = await setup();
    try {
      const registry = createTdaInvariantRegistry();
      registerPlannerInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-planner')).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('applied 计划缺 tempToTaskId ⇒ schema 拒绝（域级前置，加载期检查为二道防线）', async () => {
    const rig = await setup();
    try {
      const { planId, approvalId } = await makeGoodPlan(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(planId, ticket);
      const applied = rig.service.plan(planId);
      expect(applied?.status).toBe('applied');
      await expect(
        rig.domain.table('planner_plans').put(planId, { ...applied, tempToTaskId: undefined } as never),
      ).rejects.toThrowError(/tempToTaskId/);
    } finally {
      await rig.dispose();
    }
  });

  it('replan 计划缺 deviation ⇒ schema 拒绝（域级前置）', async () => {
    const rig = await setup();
    try {
      const { planId, approvalId } = await makeGoodPlan(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(planId, ticket);
      const replanned = await rig.service.replan('goal-1', {
        kind: 'retry-exhausted',
        taskId: 'task-1',
        detail: '重试帽用尽',
        at: NOW,
      });
      expect(replanned.kind).toBe('replan');
      await expect(
        rig.domain.table('planner_plans').put(replanned.id, { ...replanned, deviation: undefined } as never),
      ).rejects.toThrowError(/deviation/);
    } finally {
      await rig.dispose();
    }
  });

  it('预案 carveOut 越界 ⇒ schema 拒绝（域级前置）', async () => {
    const rig = await setup();
    try {
      await expect(
        rig.domain.table('planner_contingencies').put('cont-9', {
          id: 'cont-9',
          revision: 0,
          planId: 'plan-9',
          primaryTaskId: 'task-1',
          alternativeTaskId: 'task-2',
          trigger: { kind: 'task-failed', taskTempId: 't1' },
          status: 'dormant',
          carveOut: 1.5,
        } as never),
      ).rejects.toThrowError(/carveOut/);
    } finally {
      await rig.dispose();
    }
  });

  it('预案 planId 悬挂（跨记录）⇒ verify 红（加载期检查的增量价值）', async () => {
    const rig = await setup();
    try {
      await rig.domain.table('planner_contingencies').put('cont-8', {
        id: 'cont-8',
        revision: 0,
        planId: 'plan-ghost',
        primaryTaskId: 'task-1',
        alternativeTaskId: 'task-2',
        trigger: { kind: 'task-failed', taskTempId: 't1' },
        status: 'dormant',
        carveOut: 0.5,
      } as never);
      const registry = createTdaInvariantRegistry();
      registerPlannerInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-planner')).rejects.toThrowError(/planId 指向不存在/);
    } finally {
      await rig.dispose();
    }
  });

  it('supersedes 悬挂（跨记录）⇒ verify 红', async () => {
    const rig = await setup();
    try {
      const { planId, approvalId } = await makeGoodPlan(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(planId, ticket);
      const replanned = await rig.service.replan('goal-1', {
        kind: 'retry-exhausted',
        taskId: 'task-1',
        detail: '重试帽用尽',
        at: NOW,
      });
      await rig.domain.table('planner_plans').put(replanned.id, { ...replanned, supersedes: 'plan-ghost' } as never);
      const registry = createTdaInvariantRegistry();
      registerPlannerInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-planner')).rejects.toThrowError(/supersedes 指向不存在/);
    } finally {
      await rig.dispose();
    }
  });

  it('服务面携带越权方法（claim）⇒ verify 红（J1 零执行权）', async () => {
    const rig = await setup();
    try {
      const rogue = { ...rig.service, claim: () => undefined };
      const registry = createTdaInvariantRegistry();
      registerPlannerInvariants(registry, rig.domain, { service: rogue as never });
      await expect(registry.verify('tda-planner')).rejects.toThrowError(/越权/);
      const ok = createTdaInvariantRegistry();
      registerPlannerInvariants(ok, rig.domain, { service: rig.service });
      await expect(ok.verify('tda-planner')).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('params 单行纪律：第二行 ⇒ verify 红', async () => {
    const rig = await setup();
    try {
      await rig.domain.table('planner_params').put('rogue', {
        revision: 0,
        autoExpire: true,
        activationAutonomy: 'human-only',
        replanThreshold: 'retry-exhausted',
        verifyFailThreshold: 2,
        schemaVersion: 1,
      } as never);
      const registry = createTdaInvariantRegistry();
      registerPlannerInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-planner')).rejects.toThrowError(/恰有一行/);
    } finally {
      await rig.dispose();
    }
  });
});
