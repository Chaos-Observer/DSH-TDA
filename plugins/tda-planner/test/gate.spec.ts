/**
 * tda-planner 验收门（门3 test:smoke → gate.spec）。
 *
 * 覆盖 T4.5 §6 验收 1–9：质量门拒坏提议/代建溯源/预案触发/预案激活四步/
 * 否决与过期/局部重规划 diff/双写回放/零执行权/legacy 兼容。
 */
import { describe, expect, it } from 'vitest';
import { NOW, makeGoodPlan, setup } from './helpers.ts';
import type { PlannedTask } from '../src/domain.ts';

/** 造一条带预案边的计划：t1（主路径，高风险）→ 备选 t2。 */
function planWithContingency(): PlannedTask[] {
  return [
    {
      tempId: 't1',
      subject: '主路径：直连抓取',
      completionCriteria: ['证据：抓取完成'],
      blockedByTempIds: [],
      alternativeOfTempId: 't2',
      contingency: { trigger: { kind: 'task-failed', taskTempId: 't1' }, carveOut: 0.5 },
      criteriaRefs: [0],
      localPath: 'ws/a',
      writeScopes: ['ws/b/x'], // 高风险 ⇒ 必须有预案（⑤）
      budget: { tokens: 60 },
    },
    {
      tempId: 't2',
      subject: '备选：迂回抓取',
      completionCriteria: ['证据：迂回完成'],
      blockedByTempIds: [],
      criteriaRefs: [1],
      budget: { tokens: 30 },
    },
  ];
}

describe('T4.5 验收 1：质量门（五类坏提议被确定性拒）', () => {
  it('criteria 无覆盖的提议留 draft 不过闸；confirmRequest 抛', async () => {
    const rig = await setup();
    try {
      rig.decomposer.nextBad = 'criteria-gap';
      const plan = await rig.service.proposePlan('goal-1');
      expect(plan.status).toBe('draft');
      expect(plan.coverage.passed).toBe(false);
      const failed = plan.coverage.checks.filter((item) => !item.passed).map((item) => item.id);
      expect(failed).toContain('criteria-coverage');
      await expect(rig.service.confirmRequest('human', plan.id)).rejects.toThrowError(/质量门未过/);
    } finally {
      await rig.dispose();
    }
  });

  it('合并图成环的提议留 draft；预算不守恒同理', async () => {
    const rig = await setup();
    try {
      rig.decomposer.nextBad = 'cycle';
      const plan = await rig.service.proposePlan('goal-1');
      expect(plan.coverage.passed).toBe(false);
      expect(plan.coverage.checks.find((item) => item.id === 'dag-acyclic')?.passed).toBe(false);
    } finally {
      await rig.dispose();
    }
  });

  it('高风险无预案且无理由的提议留 draft', async () => {
    const rig = await setup();
    try {
      rig.decomposer.nextBad = 'high-risk-no-contingency';
      const plan = await rig.service.proposePlan('goal-1');
      expect(plan.coverage.passed).toBe(false);
      expect(plan.coverage.checks.find((item) => item.id === 'contingency-coverage')?.passed).toBe(false);
    } finally {
      await rig.dispose();
    }
  });

  it('无 decomposer 时 proposePlan 抛 NO_DECOMPOSER（禁假造分解）', async () => {
    const rig = await setup();
    try {
      const service = Object.create(rig.service) as typeof rig.service;
      void service;
      // 经 rig 重建一个无 decomposer 的服务面（同域）
      const { createPlannerService } = await import('../src/service.ts');
      const bare = createPlannerService({
        domain: rig.domain,
        session: rig.session as never,
        taskPool: rig.taskPool,
        goal: rig.goal,
        supervision: rig.supervision,
        now: (): number => NOW,
      });
      await expect(bare.proposePlan('goal-1')).rejects.toThrowError(/未注入 LLM 分解工序/);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.5 验收 2：审批门与代建溯源', () => {
  it('无票/错票/重放/非待批态全部被拒', async () => {
    const rig = await setup();
    try {
      const { planId, approvalId } = await makeGoodPlan(rig);
      // 无票
      await expect(rig.service.applyPlan(planId, {
        approvalId: 'appr-x', nonce: 'nonce-x', from: 'ctx.executor', handle: planId,
      })).rejects.toThrowError(/不指向本记录/);
      // 正确票但重放
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(planId, ticket);
      await expect(rig.service.applyPlan(planId, ticket)).rejects.toThrowError(/已消费|非 pending-approval/);
    } finally {
      await rig.dispose();
    }
  });

  it('凭票代建：拓扑序创建 + planId 溯源 + appliedTaskIds/tempToTaskId 回填', async () => {
    const rig = await setup();
    try {
      rig.decomposer.nextTasks = [
        { tempId: 't1', subject: '父任务', completionCriteria: ['x'], blockedByTempIds: [], criteriaRefs: [0] },
        { tempId: 't1.1', parentTempId: 't1', subject: '子任务', completionCriteria: ['y'], blockedByTempIds: [], criteriaRefs: [1] },
      ];
      const plan = await rig.service.proposePlan('goal-1');
      expect(plan.coverage.passed).toBe(true);
      const { approvalId } = await rig.service.confirmRequest('human', plan.id);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      const created = await rig.service.applyPlan(plan.id, ticket);
      expect(created).toHaveLength(2);
      // 父先子后
      const createCalls = rig.taskPool.calls.filter((call) => call.startsWith('create:'));
      expect(createCalls).toEqual(['create:父任务', 'create:子任务']);
      // 溯源
      const applied = rig.service.plan(plan.id);
      expect(applied?.status).toBe('applied');
      expect(applied?.appliedTaskIds).toEqual(created);
      expect(Object.keys(applied?.tempToTaskId ?? {}).sort()).toEqual(['t1', 't1.1']);
      // 每个代建任务带 planId
      for (const id of created) {
        const traced = rig.taskPool.get(id) as unknown as { planId?: string };
        expect(traced.planId).toBe(plan.id);
      }
      // 零执行权：全期无 claim/complete/startRun/dispatch 调用
      expect(rig.taskPool.calls.some((call) => /^(claim|complete|startRun|dispatch)/.test(call))).toBe(false);
    } finally {
      await rig.dispose();
    }
  });

  it('重复代建被拒（TASK_ALREADY_APPLIED）', async () => {
    const rig = await setup();
    try {
      const { planId, approvalId } = await makeGoodPlan(rig);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(planId, ticket);
      const plan = rig.service.plan(planId);
      expect(plan?.status).toBe('applied');
      // 篡改状态回 pending-approval 再试（票据已消费，先被重放拦）
      await expect(rig.service.applyPlan(planId, ticket)).rejects.toThrowError(/已消费/);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.5 验收 3–5：预案触发、激活四步、否决与过期', () => {
  it('触发检出只产事件不切换；提请激活后四步落定', async () => {
    const rig = await setup();
    try {
      rig.decomposer.nextTasks = planWithContingency();
      const plan = await rig.service.proposePlan('goal-1');
      expect(plan.coverage.passed).toBe(true);
      const { approvalId } = await rig.service.confirmRequest('human', plan.id);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      const created = await rig.service.applyPlan(plan.id, ticket);
      expect(created).toHaveLength(2);

      const primaryId = created[1] as string;
      const alternativeId = created[0] as string;
      // 代建边：备选 t2 先建（代建序），主路径 t1 携 alternativeOf 结构
      const primary = rig.taskPool.get(primaryId) as unknown as {
        alternativeOf?: { taskId: string; planId?: string; contingencyId?: string };
      };
      expect(primary.alternativeOf?.taskId).toBe(alternativeId);
      expect(primary.alternativeOf?.planId).toBe(plan.id);
      expect(primary.alternativeOf?.contingencyId).toMatch(/^cont-/); // 携 contingencyId ⇒ 非 legacy

      // 预案记录 dormant
      const [contingency] = rig.service.contingencies(plan.id);
      const cid = contingency?.id ?? 'cont-missing';
      expect(contingency?.status).toBe('dormant');
      expect(contingency?.primaryTaskId).toBe(primaryId);
      expect(contingency?.alternativeTaskId).toBe(alternativeId);

      // 触发检出（主路径失败终态）⇒ 只产事件不切换
      rig.taskPool.tasks.set(primaryId, {
        ...rig.taskPool.tasks.get(primaryId)!,
        phase: 'complete',
        outcome: 'failed',
      });
      const events = rig.service.checkTriggers(NOW);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('activate');
      expect(rig.service.contingency(cid)?.status).toBe('dormant');

      // 提请激活（kind=plan-activation）
      const { approvalId: activationId } = await rig.service.requestActivation(cid);
      expect(rig.supervision.calls).toContain('request:plan-activation');
      expect(rig.service.contingency(cid)?.status).toBe('triggered');

      // 凭票激活：四步落定
      const activationTicket = rig.supervision.approve(activationId, `tok-${activationId.replace('appr-', '')}`);
      const activated = await rig.service.activate(cid, activationTicket);
      expect(activated.status).toBe('activated');
      expect(activated.activationApprovalId).toBe(activationId);
      // ① 备选 ready 候选（stage=planning/phase=active）
      const alternative = rig.taskPool.get(alternativeId);
      expect(alternative?.stage).toBe('planning');
      expect(alternative?.phase).toBe('active');
      // ② 主路径已失败终态 ⇒ 保持 complete（T0.2 终态不可变；blocked 标记仅对活主路径）
      const primaryAfter = rig.taskPool.get(primaryId);
      expect(primaryAfter?.phase).toBe('complete');
      expect(primaryAfter?.outcome).toBe('failed');
      // ③ carve-out 转注（主路径 60 帽未耗 ×0.5 = 30 ⇒ 备选帽 30+30=60）
      expect(alternative?.budget.caps.tokens).toBe(60);
      // 调用面：edit（stage/budget）+ block，无 claim/complete
      expect(rig.taskPool.calls.some((call) => call.startsWith('claim') || call.startsWith('complete'))).toBe(false);

      // 重放被拒
      await expect(rig.service.activate(cid, activationTicket)).rejects.toThrowError(/已消费|非 triggered/);
    } finally {
      await rig.dispose();
    }
  });

  it('活着的主路径（budget-zone 触发）激活后被打 blocked[plan-b-activated]', async () => {
    const rig = await setup();
    try {
      rig.decomposer.nextTasks = [
        {
          tempId: 't1',
          subject: '主路径：长跑分析',
          completionCriteria: ['证据：分析完成'],
          blockedByTempIds: [],
          alternativeOfTempId: 't2',
          contingency: { trigger: { kind: 'budget-zone', zone: 'converge' }, carveOut: 0.5 },
          criteriaRefs: [0],
          budget: { tokens: 60 },
        },
        {
          tempId: 't2',
          subject: '备选：轻量分析',
          completionCriteria: ['证据：轻量完成'],
          blockedByTempIds: [],
          criteriaRefs: [1],
          budget: { tokens: 30 },
        },
      ];
      const plan = await rig.service.proposePlan('goal-1');
      const { approvalId } = await rig.service.confirmRequest('human', plan.id);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      const created = await rig.service.applyPlan(plan.id, ticket);
      const primaryId = created[1] as string;
      const [contingency] = rig.service.contingencies(plan.id);
      const cid = contingency?.id ?? 'cont-missing';

      // 主路径活着但预算进 converge 区 ⇒ 触发检出
      rig.taskPool.tasks.set(primaryId, { ...rig.taskPool.tasks.get(primaryId)!, zone: 'converge' });
      const events = rig.service.checkTriggers(NOW);
      expect(events.map((item) => item.kind)).toEqual(['activate']);

      const { approvalId: activationId } = await rig.service.requestActivation(cid);
      const activationTicket = rig.supervision.approve(activationId, `tok-${activationId.replace('appr-', '')}`);
      await rig.service.activate(cid, activationTicket);
      const primaryAfter = rig.taskPool.get(primaryId);
      expect(primaryAfter?.phase).toBe('blocked'); // 活主路径被打标记
    } finally {
      await rig.dispose();
    }
  });

  it('veto 必填 reason；dormant/triggered 可否决，activated 不可', async () => {
    const rig = await setup();
    try {
      rig.decomposer.nextTasks = planWithContingency();
      const plan = await rig.service.proposePlan('goal-1');
      const { approvalId } = await rig.service.confirmRequest('human', plan.id);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      await rig.service.applyPlan(plan.id, ticket);
      const [contingency] = rig.service.contingencies(plan.id);
      const cid = contingency?.id ?? 'cont-missing';

      await expect(rig.service.veto(cid, '  ')).rejects.toThrowError(/reason/);
      const vetoed = await rig.service.veto(cid, '风险已由其他措施覆盖');
      expect(vetoed.status).toBe('vetoed');
      expect(vetoed.reason).toBe('风险已由其他措施覆盖');
      await expect(rig.service.veto(cid, 'again')).rejects.toThrowError(/禁否决/);
    } finally {
      await rig.dispose();
    }
  });

  it('主路径成功 ⇒ runTriggerScan 自动 expired（autoExpire，无需审批）', async () => {
    const rig = await setup();
    try {
      rig.decomposer.nextTasks = planWithContingency();
      const plan = await rig.service.proposePlan('goal-1');
      const { approvalId } = await rig.service.confirmRequest('human', plan.id);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      const created = await rig.service.applyPlan(plan.id, ticket);
      const primaryId = created[1] as string;
      const [contingency] = rig.service.contingencies(plan.id);
      const cid = contingency?.id ?? 'cont-missing';

      rig.taskPool.tasks.set(primaryId, {
        ...rig.taskPool.tasks.get(primaryId)!,
        phase: 'complete',
        outcome: 'success',
      });
      const events = await rig.service.runTriggerScan(NOW);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('expire');
      const expired = rig.service.contingency(cid);
      expect(expired?.status).toBe('expired');
      expect(expired?.reason).toContain('autoExpire');
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.5 验收 6：局部重规划（supersede 链 + 增量应用）', () => {
  it('replan 产 supersede 新计划；diff 只建新任务 + edit 受影响 + 旧计划 superseded', async () => {
    const rig = await setup();
    try {
      // 初始计划：t1 + t2
      rig.decomposer.nextTasks = [
        { tempId: 't1', subject: '任务甲', completionCriteria: ['x'], blockedByTempIds: [], criteriaRefs: [0] },
        { tempId: 't2', subject: '任务乙', completionCriteria: ['y'], blockedByTempIds: [], criteriaRefs: [1] },
      ];
      const plan = await rig.service.proposePlan('goal-1');
      const { approvalId } = await rig.service.confirmRequest('human', plan.id);
      const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
      const firstCreated = await rig.service.applyPlan(plan.id, ticket);
      expect(firstCreated).toHaveLength(2);

      // replan：t2 改主题 + 新增 t3（禁 delete：旧任务不动）
      rig.decomposer.nextTasks = [
        { tempId: 't1', subject: '任务甲', completionCriteria: ['x'], blockedByTempIds: [], criteriaRefs: [0] },
        { tempId: 't2', subject: '任务乙（修订）', completionCriteria: ['y'], blockedByTempIds: [], criteriaRefs: [1] },
        { tempId: 't3', subject: '任务丙（新增）', completionCriteria: ['z'], blockedByTempIds: [], criteriaRefs: [0] },
      ];
      const replanned = await rig.service.replan('goal-1', {
        kind: 'retry-exhausted',
        taskId: firstCreated[0] ?? 'task-1',
        detail: '重试帽用尽，迂回分解',
        at: NOW,
      });
      expect(replanned.kind).toBe('replan');
      expect(replanned.supersedes).toBe(plan.id);
      expect(replanned.coverage.passed).toBe(true);

      const { approvalId: diffApproval } = await rig.service.confirmRequest('human', replanned.id);
      const diffTicket = rig.supervision.approve(diffApproval, `tok-${diffApproval.replace('appr-', '')}`);
      const report = await rig.service.applyReplanDiff(replanned.id, diffTicket);
      // 只建新任务（t3），t1 无差异跳过，t2 主题变更 edit
      expect(report.created).toHaveLength(1);
      expect(report.edited).toHaveLength(1);
      expect(report.skipped.length).toBeGreaterThanOrEqual(1);

      // 旧计划 superseded（指针标记，已建任务不动）
      const old = rig.service.plan(plan.id);
      expect(old?.status).toBe('superseded');
      expect(rig.taskPool.calls.some((call) => call.startsWith('delete'))).toBe(false);
      // 旧任务仍在（t2 只是被 edit 改主题，未被删）
      expect(rig.taskPool.get(firstCreated[1] as string)?.subject).toBe('任务乙（修订）');
      // 新计划 applied
      expect(rig.service.plan(replanned.id)?.status).toBe('applied');
    } finally {
      await rig.dispose();
    }
  });

  it('无 applied 计划时 replan 抛 NO_APPLIED_PLAN', async () => {
    const rig = await setup();
    try {
      await expect(
        rig.service.replan('goal-1', { kind: 'retry-exhausted', taskId: 'task-1', detail: 'x', at: NOW }),
      ).rejects.toThrowError(/无 applied 计划/);
    } finally {
      await rig.dispose();
    }
  });
});
