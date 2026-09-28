/**
 * tda-goal-state 域定义（T0.1 §3 数据模型）：五张表，全部权威数据。
 *
 *  - goal_nodes：GoalNode 全快照（权威状态，layout single）
 *  - goal_history：GoalId#revision → 变更记录（操作/变更者/diff 摘要）；
 *    按方案 §3.2 硬规则"event seq 拥有序，domain 记录不重复存储 seq"，
 *    历史记录不存 sessionEvent seq——审计定位经 audit_index.locate('goal', goalId)
 *  - objective_edits：自增 seq（T1.5 目标持久性/一致性指标数据面）
 *  - calibrations：自增 seq（T1.5 校准记录，P0 只建表不写）
 *  - constraint_snapshots：GoalId → C6 约束快照（T0.4 pinned 区数据源之一）
 *
 * invalidRecords 缺省 reject：目标是权威数据，损坏必须响（T0.1 §3.2）。
 */
import { asGoalId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

export const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete'] as const;
export type GoalPhase = (typeof GOAL_PHASES)[number];

/** 执行 stage：仅 active phase 有效；非 active 时保留最后值不参与路由（T0.1 §2.2）。 */
export const GOAL_STAGES = ['planning', 'executing', 'waiting', 'verifying'] as const;
export type GoalStage = (typeof GOAL_STAGES)[number];

export const GOAL_OUTCOMES = ['success', 'failed'] as const;
export type GoalOutcome = (typeof GOAL_OUTCOMES)[number];

export const GOAL_ACTORS = ['human', 'agent', 'coach', 'scheduler'] as const;
export type GoalActor = (typeof GOAL_ACTORS)[number];

export const GOAL_OPERATIONS = [
  'create',
  'edit',
  'focus',
  'focus-release',
  'pause',
  'resume',
  'block',
  'complete',
  'clear',
  'recordRound',
  'consume',
  'consume-rollup',
] as const;
export type GoalOperation = (typeof GOAL_OPERATIONS)[number];

/** 资源预算三维 + 消耗账本（T0.1 J5）。 */
export const GoalBudgetSchema = z.object({
  tokens: z.number().optional(),
  wallClockMs: z.number().optional(),
  attentionUnits: z.number().optional(),
  consumed: z.object({
    tokens: z.number(),
    wallClockMs: z.number(),
    attentionUnits: z.number(),
  }),
});

export type GoalBudget = z.infer<typeof GoalBudgetSchema>;

/** 预算帽（分配面）：consumed 由 consume 账本推进，分配只设帽。 */
export type GoalBudgetCaps = Pick<GoalBudget, 'tokens' | 'wallClockMs' | 'attentionUnits'>;

export const GoalBlockedReasonSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type GoalBlockedReason = z.infer<typeof GoalBlockedReasonSchema>;

/**
 * GoalNode 全快照（T0.1 §3.1）。superRefine 固化不变量 5 的字段完备律：
 * outcome 在场 ⟺ phase=complete；blockedReason 在场 ⟺ phase=blocked
 * （resume/complete 必须清理由/结果字段，paused/blocked 携带即拒绝打开）。
 *
 * id 经 transform 带 GoalId 品牌（运行期仍是普通字符串，零成本）：服务 API 的
 * GoalId 参数与节点回传无缝衔接，编译期防跨业务线 id 混用。
 */
export const GoalNodeSchema = z
  .object({
    id: z.string().transform(asGoalId),
    revision: z.number(),
    parentId: z.string().optional(),
    objective: z.string(),
    completionCriteria: z.array(z.string()),
    phase: z.enum(GOAL_PHASES),
    stage: z.enum(GOAL_STAGES),
    outcome: z.enum(GOAL_OUTCOMES).optional(),
    blockedReason: GoalBlockedReasonSchema.optional(),
    maxGoalRounds: z.number(),
    roundsStarted: z.number(),
    budget: GoalBudgetSchema,
    queuePosition: z.number().optional(),
    focus: z.boolean(),
    /** clear 的 tombstone 标记（T0.1 §2.1：保留 GoalRef + clearedAt，历史不丢）。 */
    clearedAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .superRefine((node, ctx) => {
    if (node.phase === 'complete' && node.outcome === undefined) {
      ctx.addIssue({ code: 'custom', message: 'phase=complete 必填 outcome（显式终态，失败也是完成）' });
    }
    if (node.phase !== 'complete' && node.outcome !== undefined) {
      ctx.addIssue({ code: 'custom', message: `phase=${node.phase} 不得携带 outcome` });
    }
    if (node.phase === 'blocked' && node.blockedReason === undefined) {
      ctx.addIssue({ code: 'custom', message: 'phase=blocked 必填 blockedReason（稳定 code + 人读 message）' });
    }
    if (node.phase !== 'blocked' && node.blockedReason !== undefined) {
      ctx.addIssue({ code: 'custom', message: `phase=${node.phase} 不得携带 blockedReason（resume 须清理由）` });
    }
  });

export type GoalNode = z.infer<typeof GoalNodeSchema>;

/** goal_history 记录（键 GoalId#revision）。 */
export const GoalChangeRecordSchema = z.object({
  goalId: z.string(),
  revision: z.number(),
  operation: z.enum(GOAL_OPERATIONS),
  actor: z.enum(GOAL_ACTORS),
  /** diff 摘要（人读；权威快照在 goal_nodes 与事件载荷）。 */
  summary: z.string(),
  at: z.number(),
});

export type GoalChangeRecord = z.infer<typeof GoalChangeRecordSchema>;

/** objective_edits：目标改写流水（T1.5 数据面）。 */
export const ObjectiveEditSchema = z.object({
  goalId: z.string(),
  from: z.string(),
  to: z.string(),
  reason: z.string().optional(),
  actor: z.enum(GOAL_ACTORS),
  at: z.number(),
});

export type ObjectiveEdit = z.infer<typeof ObjectiveEditSchema>;

/** calibrations：T1.5 校准记录（P0 建表占位，写入归 T1.5）。 */
export const CalibrationSchema = z.object({
  goalId: z.string(),
  driftType: z.string(),
  action: z.enum(['restate', 'echo', 'reanchor', 'nudge']),
  detail: z.string(),
  at: z.number(),
});

export type Calibration = z.infer<typeof CalibrationSchema>;

/** constraint_snapshots：C6 约束保持率基线（创建/编辑时快照）。 */
export const ConstraintSnapshotSchema = z.object({
  goalId: z.string(),
  pinned: z.array(z.string()),
  at: z.number(),
});

export type ConstraintSnapshot = z.infer<typeof ConstraintSnapshotSchema>;

export type GoalTables = {
  goal_nodes: typeof GoalNodeSchema;
  goal_history: typeof GoalChangeRecordSchema;
  objective_edits: typeof ObjectiveEditSchema;
  calibrations: typeof CalibrationSchema;
  constraint_snapshots: typeof ConstraintSnapshotSchema;
};

export const goalStateDomainSpec = defineTdaDomain({
  name: 'tda-goal-state',
  version: 1,
  tables: {
    goal_nodes: GoalNodeSchema,
    goal_history: GoalChangeRecordSchema,
    objective_edits: ObjectiveEditSchema,
    calibrations: CalibrationSchema,
    constraint_snapshots: ConstraintSnapshotSchema,
  },
  layout: 'single',
});
