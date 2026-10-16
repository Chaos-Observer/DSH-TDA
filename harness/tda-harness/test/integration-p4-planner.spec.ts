/**
 * P4 集成门（IT15b）：tda-planner 真装配（24 插件 + 规划器）后的闭环语义。
 *
 * 与 tda-planner 插件门的分工：插件门用 stub/seam 单飞验证规格符合性；
 * 本文件验证**装配后**才暴露的语义——
 *  1. 规划闭环：proposePlan（真 decomposer 注入）→ 质量门 → confirmRequest
 *     （task-plan 审批）→ 一次性 token → applyPlan → 任务树真落 T0.2（planId 溯源）；
 *  2. 预案激活：主路径失败 → tick 触发扫描（plannerEnabled）→ requestActivation
 *     → approveAndActivate 桥 → 四步切换落定（备选 ready/主路径 blocked[plan-b-activated]）；
 *  3. opt-in 开关：默认关时 tick 不做触发扫描（autoExpire 不误清理）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleRuntime, type TdaRuntime } from '../src/runtime.ts';
import type { Decomposer, PlannedTask } from 'tda-planner';

function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface Rig {
  readonly runtime: TdaRuntime;
  dispose(): Promise<void>;
}

async function setup(options: {
  plannerEnabled?: boolean;
  storageBackend?: 'json' | 'sqlite';
  sessionBackend?: 'file' | 'dsh-compat';
} = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-harness-p4p-'));
  const clock = createClock();
  const runtime = await assembleRuntime({
    dir,
    now: clock.now,
    decomposer: createScriptedDecomposer(),
    ...(options.plannerEnabled !== undefined ? { plannerEnabled: options.plannerEnabled } : {}),
    ...(options.storageBackend !== undefined ? { storageBackend: options.storageBackend } : {}),
    ...(options.sessionBackend !== undefined ? { sessionBackend: options.sessionBackend } : {}),
  });
  return {
    runtime,
    async dispose() {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，detached 子进程清理（不占 libuv 线程池）
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    },
  };
}

/** 确定性 decomposer：主路径（高风险带预案边）+ 备选，两任务覆盖两标准。 */
function createScriptedDecomposer(): Decomposer {
  return async (input) => {
    const tasks: PlannedTask[] = [
      {
        tempId: 't1',
        subject: '主路径：直连抓取',
        completionCriteria: ['证据：抓取完成'],
        blockedByTempIds: [],
        alternativeOfTempId: 't2',
        contingency: { trigger: { kind: 'task-failed', taskTempId: 't1' }, carveOut: 0.5 },
        criteriaRefs: [0],
        localPath: 'ws/a',
        writeScopes: ['ws/b/x'],
      },
      {
        tempId: 't2',
        subject: '备选：迂回抓取',
        completionCriteria: ['证据：迂回完成'],
        blockedByTempIds: [],
        criteriaRefs: [1],
      },
    ];
    void input;
    return {
      tasks,
      generation: { provider: 'scripted', model: 'harness-lead', schemaHash: 'sha-harness' },
    };
  };
}

async function seedGoal(runtime: TdaRuntime): Promise<string> {
  const goal = await runtime.goalTree.service.create('human', {
    objective: '完成灯环抓取',
    completionCriteria: ['标准甲：抓取路径验证', '标准乙：备选路径验证'],
  });
  return String(goal.id);
}

/**
 * 批准代建任务的待批提议（T0.2 纪律：actor='agent' 创建 ⇒ proposedBy='agent' ⇒
 * proposal pending_approval，需人类逐条 approveProposal 后才 ready——计划审批
 * （planner 层）与任务提议审批（T0.2 层）是两道门，v1 保持两层）。
 */
async function approveProposals(runtime: TdaRuntime, taskIds: readonly string[]): Promise<void> {
  for (const taskId of taskIds) {
    const node = runtime.taskPool.service.get(taskId as never);
    if (node === undefined || node.proposal === undefined) continue;
    await runtime.taskPool.service.approveProposal('human', taskId as never, { expectedRevision: node.revision }, true);
  }
}

/** 提请并代建一条计划（走真 supervision 审批 + 服务面 applyPlan）。 */
async function approveAndApply(runtime: TdaRuntime, goalId: string): Promise<{ planId: string; taskIds: readonly string[] }> {
  const plan = await runtime.planner.service.proposePlan(goalId);
  expect(plan.coverage.passed).toBe(true);
  const { approvalId } = await runtime.planner.service.confirmRequest('human', plan.id);
  const pending = runtime.supervision.service.pending({ kind: 'task-plan' });
  const approval = pending.find((item) => String(item.approvalId) === approvalId);
  expect(approval).toBeDefined();
  const ticket = await runtime.supervision.service.approve(
    approvalId as never,
    approval?.token.nonce ?? '',
  );
  const taskIds = await runtime.planner.service.applyPlan(plan.id, {
    approvalId: String(ticket.approvalId),
    nonce: String(ticket.nonce),
    from: String(ticket.from),
    handle: String(ticket.handle),
  });
  return { planId: plan.id, taskIds };
}

describe('P4 集成：任务规划器（T4.5）', () => {
  it('规划闭环：质量门 → task-plan 审批 → 代建落 T0.2（planId 溯源 + 预案边）', async () => {
    const rig = await setup({ plannerEnabled: true });
    try {
      const goalId = await seedGoal(rig.runtime);
      const { planId, taskIds } = await approveAndApply(rig.runtime, goalId);
      expect(taskIds).toHaveLength(2);

      // 代建任务真落任务树，且带 planId 溯源（T0.2 v2）
      for (const taskId of taskIds) {
        const node = rig.runtime.taskPool.service.get(taskId as never) as unknown as { planId?: string };
        expect(node?.planId).toBe(planId);
      }
      // 主路径任务携 alternativeOf 结构（taskId/planId/contingencyId 三元齐全 ⇒ 非 legacy）
      const [contingency] = rig.runtime.planner.service.contingencies(planId);
      expect(contingency?.status).toBe('dormant');
      const primary = rig.runtime.taskPool.service.get(contingency?.primaryTaskId as never) as unknown as {
        alternativeOf?: { taskId: string; planId?: string; contingencyId?: string };
      };
      expect(primary.alternativeOf?.taskId).toBe(contingency?.alternativeTaskId);
      expect(primary.alternativeOf?.planId).toBe(planId);
      expect(primary.alternativeOf?.contingencyId).toBe(contingency?.id);

      // 装配级两级不变量（含内核双写对账 + planner 插件级检查）全过
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('P5.4 Gate G4 复验：规划闭环落在 DSH 兼容介质上（sqlite 域 + dsh-compat 日志）', async () => {
    const rig = await setup({ plannerEnabled: true, storageBackend: 'sqlite', sessionBackend: 'dsh-compat' });
    try {
      const goalId = await seedGoal(rig.runtime);
      const { planId, taskIds } = await approveAndApply(rig.runtime, goalId);
      expect(taskIds).toHaveLength(2);
      for (const taskId of taskIds) {
        const node = rig.runtime.taskPool.service.get(taskId as never) as unknown as { planId?: string };
        expect(node?.planId).toBe(planId);
      }
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('预案激活：主路径失败 → 触发扫描 → approveAndActivate 桥 → 四步切换落定', async () => {
    const rig = await setup({ plannerEnabled: true });
    try {
      const goalId = await seedGoal(rig.runtime);
      const { planId, taskIds } = await approveAndApply(rig.runtime, goalId);
      const [contingency] = rig.runtime.planner.service.contingencies(planId);
      const primaryId = contingency?.primaryTaskId as string;
      expect(contingency?.status).toBe('dormant');

      // 主路径失败终态（T0.2 complete failed；先过任务提议审批门）
      await approveProposals(rig.runtime, taskIds);
      const primaryNode = rig.runtime.taskPool.service.get(primaryId as never);
      expect(primaryNode).toBeDefined();
      await rig.runtime.taskPool.service.complete('human', primaryId as never, { expectedRevision: primaryNode!.revision }, {
        outcome: 'failed',
        unfinished: ['直连抓取失败'],
      });

      // tick 触发扫描（plannerEnabled）：检出 activate 事件但不自动切换
      await rig.runtime.tick();
      const events = rig.runtime.planner.service.checkTriggers(1_700_000_000_000);
      expect(events.some((event) => event.kind === 'activate' && event.contingencyId === contingency?.id)).toBe(true);
      expect(rig.runtime.planner.service.contingency(contingency?.id as string)?.status).toBe('dormant');

      // 提请激活 → 人类批准 → 装配层桥四步切换
      const { approvalId } = await rig.runtime.planner.service.requestActivation(contingency?.id as string);
      const pending = rig.runtime.supervision.service.pending({ kind: 'plan-activation' });
      const approval = pending.find((item) => String(item.approvalId) === approvalId);
      expect(approval).toBeDefined();
      const activated = await rig.runtime.approveAndActivate(approvalId, approval?.token.nonce ?? '');
      expect(activated.status).toBe('activated');
      expect(activated.activationApprovalId).toBe(approvalId);

      // ① 备选 ready 候选 ② 主路径已失败终态（T0.2 终态不可变 ⇒ 保持 complete，
      // blocked[plan-b-activated] 标记仅对活着的主路径——IT15 装配期裁定）
      const alternative = rig.runtime.taskPool.service.get(contingency?.alternativeTaskId as never);
      expect(alternative?.phase).toBe('active');
      expect(alternative?.stage).toBe('planning');
      const primaryAfter = rig.runtime.taskPool.service.get(primaryId as never);
      expect(primaryAfter?.phase).toBe('complete');
      expect(primaryAfter?.outcome).toBe('failed');

      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('opt-in 开关：默认关时 tick 不触发扫描（autoExpire 不误清理）', async () => {
    const rig = await setup();
    try {
      const goalId = await seedGoal(rig.runtime);
      const { planId, taskIds } = await approveAndApply(rig.runtime, goalId);
      const [contingency] = rig.runtime.planner.service.contingencies(planId);
      const primaryId = contingency?.primaryTaskId as string;
      void planId;

      // 主路径成功（若误触发扫描，dormant 预案会被 autoExpire 清掉）
      await approveProposals(rig.runtime, taskIds);
      const primaryNode = rig.runtime.taskPool.service.get(primaryId as never);
      await rig.runtime.taskPool.service.complete('human', primaryId as never, { expectedRevision: primaryNode!.revision }, {
        outcome: 'success',
        evidence: ['tl-stub'],
      });
      await rig.runtime.tick();
      // 默认关 ⇒ 预案仍 dormant（扫描未跑）；显式扫描才清
      expect(rig.runtime.planner.service.contingency(contingency?.id as string)?.status).toBe('dormant');
      const events = await rig.runtime.planner.service.runTriggerScan(1_700_000_000_000);
      expect(events.some((event) => event.kind === 'expire')).toBe(true);
      expect(rig.runtime.planner.service.contingency(contingency?.id as string)?.status).toBe('expired');
    } finally {
      await rig.dispose();
    }
  });
});
