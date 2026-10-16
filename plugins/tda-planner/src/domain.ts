/**
 * tda-planner 域定义（T4.5 §3.3 存储落点）。
 *
 * 三表，**全部权威**（`invalidRecords: 'reject'`）：
 *  - `planner_plans`：TaskPlan 全快照（不可变计划 + 状态/CAS revision）。计划快照记
 *    "当时的规划意图"——与任务树实况分立，偏差 = 执行实况 vs 快照预期（J3）；
 *  - `planner_contingencies`：PlanContingency 全快照。预案激活是审计链关键节点
 *    （T3.2 auditView 需可定位"为何切备选"），调度与切换决策**不可由其他域重放
 *    重建**（P1 纪律 #12：不可重算 ⇒ 权威），故域+事件双写（族 `planner/change`，
 *    第二十二族）；
 *  - `planner_params`：策略权威（autoExpire/activationAutonomy/replanThreshold/
 *    verifyFailThreshold/schemaVersion）。
 *
 * 规划器对任务树**零执行权**：只经 taskPool 的 create/edit/block 受审批写面 +
 * 只读面（deps 类型级无 claim/complete/startRun/dispatch，见 service.ts seam 声明）。
 */
import { asContingencyId, asPlanId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

export const PLAN_PREFIX = 'plan';
export const CONTINGENCY_PREFIX = 'cont';
export const PLANNER_PARAMS_KEY = 'singleton';
/** params 行的稳定业务 id（T0.7 不变量 7：配对事件稳定 id）。 */
export const PLANNER_PARAMS_BUSINESS_ID = 'params';

/** 计划状态机（T4.5 §2）。 */
export const PLAN_STATUSES = [
  'draft',
  'pending-approval',
  'applied',
  'rejected',
  'cancelled',
  'superseded',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_TERMINAL_STATUSES = ['applied', 'rejected', 'cancelled', 'superseded'] as const;

/** 预案状态机（J4）：dormant → triggered → activated（+vetoed/expired）。 */
export const CONTINGENCY_STATUSES = ['dormant', 'triggered', 'activated', 'vetoed', 'expired'] as const;
export type ContingencyStatus = (typeof CONTINGENCY_STATUSES)[number];

/** 预案触发条件四种（J7 纯函数判据）。 */
export const TRIGGER_KINDS = ['task-failed', 'task-blocked', 'budget-zone', 'verify-failed'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const PlanTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task-failed'), taskTempId: z.string() }),
  z.object({ kind: z.literal('task-blocked'), taskTempId: z.string() }),
  z.object({ kind: z.literal('budget-zone'), zone: z.enum(['converge', 'exhausted']) }),
  z.object({ kind: z.literal('verify-failed'), attempts: z.number().int().min(1) }),
]);
export type PlanTrigger = z.infer<typeof PlanTriggerSchema>;

/** 重规划偏差证据（T4.1/执行侧产生，planner 只消费；J8）。 */
export const DEVIATION_KINDS = ['retry-exhausted', 'verify-failed', 'budget-zone', 'trigger-anomaly'] as const;
export type DeviationKind = (typeof DEVIATION_KINDS)[number];

export const DeviationReportSchema = z.object({
  kind: z.enum(DEVIATION_KINDS),
  taskId: z.string(),
  /** 消毒摘要（禁原文）。 */
  detail: z.string(),
  at: z.number(),
});
export type DeviationReport = z.infer<typeof DeviationReportSchema>;

/** 预算帽（分配面；consumed/zone 由任务树账本推进，规划只设帽——承 T0.2 口径）。 */
export const TaskBudgetCapsSchema = z.object({
  tokens: z.number().optional(),
  toolCalls: z.number().optional(),
  wallClockMs: z.number().optional(),
  attentionUnits: z.number().optional(),
});
export type TaskBudgetCaps = z.infer<typeof TaskBudgetCapsSchema>;

/** 计划内任务（提议态；tempId 域内自洽，apply 时映射真实 TaskId）。 */
export const PlannedTaskSchema = z.object({
  tempId: z.string(),
  parentTempId: z.string().optional(),
  subject: z.string(),
  description: z.string().optional(),
  /** 任务级完成标准（非空，质量门④；目标层标准是 T0.1 权威，这里是证据路径）。 */
  completionCriteria: z.array(z.string()),
  blockedByTempIds: z.array(z.string()),
  /** 预案边：指向备选任务（plan B）。primary = 本任务。 */
  alternativeOfTempId: z.string().optional(),
  contingency: z
    .object({
      trigger: PlanTriggerSchema,
      carveOut: z.number(),
    })
    .optional(),
  budget: TaskBudgetCapsSchema.optional(),
  priority: z.number().optional(),
  localPath: z.string().optional(),
  writeScopes: z.array(z.string()).optional(),
  /** J10 建议字段（T4.1 路由消费；匹配 consolidated def 优先）。 */
  suggestedWorkflowDefId: z.string().optional(),
  riskHint: z.enum(['low', 'high']).optional(),
  /** 覆盖的目标 completionCriteria 索引（质量门①）。 */
  criteriaRefs: z.array(z.number().int().min(0)),
  /** 高风险无预案时的显式理由（质量门⑤）。 */
  noContingencyReason: z.string().optional(),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

/** 质量门检查项 id（J9 五查）。 */
export const QUALITY_CHECK_IDS = [
  'criteria-coverage',
  'budget-conservation',
  'dag-acyclic',
  'leaf-executable',
  'contingency-coverage',
] as const;
export type QualityCheckId = (typeof QUALITY_CHECK_IDS)[number];

export const CoverageReportSchema = z.object({
  passed: z.boolean(),
  checks: z.array(
    z.object({
      id: z.enum(QUALITY_CHECK_IDS),
      passed: z.boolean(),
      /** 消毒摘要（禁原文）。 */
      detail: z.string(),
    }),
  ),
});
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

/** 生成元数据（裁决随记录落盘：provider/model/schemaHash/at）。 */
export const GenerationMetaSchema = z.object({
  provider: z.string(),
  model: z.string(),
  schemaHash: z.string(),
  at: z.number(),
});
export type GenerationMeta = z.infer<typeof GenerationMetaSchema>;

export const TaskPlanSchema = z
  .object({
    id: z.string().transform(asPlanId),
    revision: z.number(),
    goalId: z.string(),
    status: z.enum(PLAN_STATUSES),
    kind: z.enum(['initial', 'replan']),
    /** 拓扑序（父先子后）。 */
    tasks: z.array(PlannedTaskSchema),
    coverage: CoverageReportSchema,
    generation: GenerationMetaSchema,
    deviation: DeviationReportSchema.optional(),
    supersedes: z.string().optional(),
    /** applyPlan 后回填（与 tempToTaskId 等长同序）。 */
    appliedTaskIds: z.array(z.string()).optional(),
    /** tempId → 真实 TaskId 映射（applyPlan 后回填；replan diff 的比对基准）。 */
    tempToTaskId: z.record(z.string(), z.string()).optional(),
    approval: z
      .object({
        approvalId: z.string(),
        at: z.number(),
        by: z.string().optional(),
      })
      .optional(),
    createdAt: z.number(),
    settledAt: z.number().optional(),
  })
  .superRefine((plan, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (plan.tasks.length === 0) issue('计划必含至少一个任务（空计划禁存）');
    // 不变量 1：离开 draft 前质量门必过
    if (plan.status !== 'draft' && !plan.coverage.passed) {
      issue(`status=${plan.status} 离开 draft 前质量门必过（coverage.passed=false）`);
    }
    // 不变量 2/6：applied 必携代建回填
    if (plan.status === 'applied') {
      if ((plan.appliedTaskIds?.length ?? 0) !== plan.tasks.length) {
        issue('applied 计划必回填与 tasks 等长的 appliedTaskIds');
      }
      if (plan.tempToTaskId === undefined || Object.keys(plan.tempToTaskId).length !== plan.tasks.length) {
        issue('applied 计划必回填完整 tempToTaskId 映射');
      }
      if (plan.approval === undefined) issue('applied 计划必携 approval（审批门）');
    }
    // 不变量 8：replan 必携偏差证据 + supersede 指针
    if (plan.kind === 'replan') {
      if (plan.deviation === undefined) issue('replan 必携 deviation（偏差证据）');
      if (plan.supersedes === undefined) issue('replan 必携 supersedes（supersede 单向链）');
    }
    if (plan.kind === 'initial' && plan.supersedes !== undefined) {
      issue('initial 计划不得携 supersedes');
    }
    // 终态必携 settledAt
    const terminal = (PLAN_TERMINAL_STATUSES as readonly string[]).includes(plan.status);
    if (terminal && plan.settledAt === undefined) issue(`终态 ${plan.status} 必携 settledAt`);
    if (!terminal && plan.settledAt !== undefined) issue(`非终态 ${plan.status} 不得携带 settledAt`);
  });
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export const PlanContingencySchema = z
  .object({
    id: z.string().transform(asContingencyId),
    revision: z.number(),
    planId: z.string(),
    primaryTaskId: z.string(),
    alternativeTaskId: z.string(),
    trigger: PlanTriggerSchema,
    status: z.enum(CONTINGENCY_STATUSES),
    /** 主路径未耗预算的转注比例（0<r<1；U5 比例制 v1）。 */
    carveOut: z.number(),
    activationApprovalId: z.string().optional(),
    triggeredAt: z.number().optional(),
    resolvedAt: z.number().optional(),
    /** vetoed/expired 必填（显式终态）。 */
    reason: z.string().optional(),
  })
  .superRefine((contingency, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (!(contingency.carveOut > 0 && contingency.carveOut < 1)) {
      issue(`carveOut 须在 (0,1) 开区间（收到 ${contingency.carveOut}）`);
    }
    if (contingency.primaryTaskId === contingency.alternativeTaskId) {
      issue('主路径与备选不得同一任务');
    }
    if (['triggered', 'activated'].includes(contingency.status) && contingency.triggeredAt === undefined) {
      issue(`status=${contingency.status} 必携 triggeredAt`);
    }
    if (contingency.status === 'activated') {
      if (contingency.activationApprovalId === undefined) issue('activated 必携 activationApprovalId（审批门）');
      if (contingency.resolvedAt === undefined) issue('activated 必携 resolvedAt');
    }
    if (contingency.status === 'vetoed' || contingency.status === 'expired') {
      if ((contingency.reason ?? '') === '') issue(`${contingency.status} 必携 reason（显式终态）`);
      if (contingency.resolvedAt === undefined) issue(`${contingency.status} 必携 resolvedAt`);
    }
  });
export type PlanContingency = z.infer<typeof PlanContingencySchema>;

export const PlannerParamsSchema = z.object({
  revision: z.number(),
  /** v1=true：主路径 completed ⇒ dormant 预案自动 expired（J4 低风险清理）。 */
  autoExpire: z.boolean(),
  /** v1 唯一 'human-only'（J4：结构性切换=人在场；U1 低风险自动激活留决）。 */
  activationAutonomy: z.enum(['human-only']),
  /** v1 唯一 'retry-exhausted'（与 T4.1 maxRetries 口径统一，U6）。 */
  replanThreshold: z.enum(['retry-exhausted']),
  /** verify-failed 触发的连续失败阈值（J7；与 replanThreshold 分离标定）。 */
  verifyFailThreshold: z.number().int().min(1),
  /** task-plan-proposal schema 版本（LLM 工序白名单演进追踪）。 */
  schemaVersion: z.number().int().min(1),
});
export type PlannerParams = z.infer<typeof PlannerParamsSchema>;

export const DEFAULT_PLANNER_PARAMS: PlannerParams = {
  revision: 0,
  autoExpire: true,
  activationAutonomy: 'human-only',
  replanThreshold: 'retry-exhausted',
  verifyFailThreshold: 2,
  schemaVersion: 1,
};

export type PlannerTables = {
  planner_plans: typeof TaskPlanSchema;
  planner_contingencies: typeof PlanContingencySchema;
  planner_params: typeof PlannerParamsSchema;
};

export const plannerDomainSpec = defineTdaDomain({
  name: 'tda-planner',
  version: 1,
  tables: {
    planner_plans: TaskPlanSchema,
    planner_contingencies: PlanContingencySchema,
    planner_params: PlannerParamsSchema,
  },
  layout: 'single',
  invalidRecords: 'reject',
});
