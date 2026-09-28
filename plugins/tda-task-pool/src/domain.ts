/**
 * tda-task-pool 域定义（T0.2 §3 数据模型）：三张表，全部权威数据。
 *
 *  - task_nodes：TaskNode 全快照（权威状态，layout single）
 *  - task_history：TaskId#revision → 变更记录（操作/变更者/diff 摘要）；
 *    按方案 §3.2 硬规则"event seq 拥有序，domain 记录不重复存储 seq"，
 *    历史不存 seq——审计定位经 audit_index.locate('task', taskId)
 *  - task_runs：TaskId#runIndex → 运行记录（append-only；周期任务每次 run 一条，
 *    一次性任务 runIndex=0）
 *
 * invalidRecords 缺省 reject：任务是权威数据，损坏必须响（T0.2 §3.2）。
 *
 * schema 承载的恒等律（加载即拒，配合 reject 策略零额外检查代码）：
 *  1. phase=complete ⟺ outcome 在场；phase=blocked ⟺ blockedReason 在场；
 *  2. 预算 zone 必须等于由帽与账本重算的值（派生字段不可被注入篡改）；
 *  3. 耗尽区（zone=exhausted）的 complete 必带 unfinished 清单（C5/J6）；
 *  4. 一次性任务 runCount ≤ 1；consecutiveFailures ≤ runCount；
 *  5. recurrence 形态律（interval≥1000ms / cron 5 字段合法）；
 *  6. 待批提议只能停在 active(planning) 且无 owner（J9：未批准不可认领）。
 */
import { asTaskId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';
import { isValidCron } from './cron.ts';

export const TASK_PHASES = ['active', 'paused', 'blocked', 'complete'] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

/** 执行 stage（沿用 T0.1 §2.2）：仅 active phase 可设；非 active 保留最后值。 */
export const TASK_STAGES = ['planning', 'executing', 'waiting', 'verifying'] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

export const TASK_OUTCOMES = ['success', 'failed'] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const TASK_ACTORS = ['human', 'agent', 'coach', 'scheduler'] as const;
export type TaskActor = (typeof TASK_ACTORS)[number];

export const TASK_ZONES = ['normal', 'converge', 'exhausted'] as const;
export type TaskZone = (typeof TASK_ZONES)[number];

export const TASK_OPERATIONS = [
  'create',
  'edit',
  'claim',
  'release',
  'reassign',
  'block',
  'resume',
  'pause',
  'complete',
  'delete',
  'consume',
  'consume-rollup',
  'start-run',
  'complete-run',
  'propose',
  'approve',
  'reject',
] as const;
export type TaskOperation = (typeof TASK_OPERATIONS)[number];

export const TASK_BUDGET_DIMS = ['tokens', 'toolCalls', 'wallClockMs', 'attentionUnits'] as const;
export type TaskBudgetDim = (typeof TASK_BUDGET_DIMS)[number];

/** 收敛区阈值（T0.2 J6：任一维度 ≥80% 消耗进 converge）。 */
export const BUDGET_CONVERGE_RATIO = 0.8;

export const TaskConsumedSchema = z.object({
  tokens: z.number(),
  toolCalls: z.number(),
  wallClockMs: z.number(),
  attentionUnits: z.number(),
});
export type TaskConsumed = z.infer<typeof TaskConsumedSchema>;

export const TaskBudgetSchema = z.object({
  tokens: z.number().optional(),
  toolCalls: z.number().optional(),
  wallClockMs: z.number().optional(),
  attentionUnits: z.number().optional(),
  consumed: TaskConsumedSchema,
  /** 派生（J6）：consume 时按帽与账本重算，持久化以便 Harness 直读。 */
  zone: z.enum(TASK_ZONES),
});
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;

/** 预算帽（分配面）：consumed/zone 由账本推进，分配只设帽。 */
export type TaskBudgetCaps = Partial<Record<TaskBudgetDim, number>>;

export const ZERO_CONSUMED: TaskConsumed = {
  tokens: 0,
  toolCalls: 0,
  wallClockMs: 0,
  attentionUnits: 0,
};

export const capsOf = (budget: TaskBudget): TaskBudgetCaps => {
  const caps: { tokens?: number; toolCalls?: number; wallClockMs?: number; attentionUnits?: number } = {};
  for (const dim of TASK_BUDGET_DIMS) {
    const cap = budget[dim];
    if (cap !== undefined) caps[dim] = cap;
  }
  return caps;
};

/** 剩余 = 帽 − 已耗（无帽维度不出现）。 */
export const remainingOf = (budget: TaskBudget): TaskBudgetCaps => {
  const remaining: { tokens?: number; toolCalls?: number; wallClockMs?: number; attentionUnits?: number } = {};
  for (const dim of TASK_BUDGET_DIMS) {
    const cap = budget[dim];
    if (cap !== undefined) remaining[dim] = cap - budget.consumed[dim];
  }
  return remaining;
};

/** 三区派生（唯一实现，schema 校验、服务重算、跨插件作用域判定共用同一函数）。 */
export function zoneOfCaps(
  caps: TaskBudgetCaps,
  consumed: Partial<Record<TaskBudgetDim, number>>,
): TaskZone {
  let zone: TaskZone = 'normal';
  for (const dim of TASK_BUDGET_DIMS) {
    const cap = caps[dim];
    if (cap === undefined) continue;
    // 零帽即无额度：已耗 0 也判耗尽（避免 0/0 的退化定义）
    const ratio = cap <= 0 ? Number.POSITIVE_INFINITY : (consumed[dim] ?? 0) / cap;
    if (ratio >= 1) return 'exhausted';
    if (ratio >= BUDGET_CONVERGE_RATIO) zone = 'converge';
  }
  return zone;
}

export const zoneOf = (budget: TaskBudget): TaskZone => zoneOfCaps(capsOf(budget), budget.consumed);

export const TaskScheduleSchema = z.object({
  notBefore: z.number().optional(),
  dueAt: z.number().optional(),
});
export type TaskSchedule = z.infer<typeof TaskScheduleSchema>;

export const TaskRecurrenceSchema = z
  .object({
    kind: z.enum(['interval', 'cron']),
    intervalMs: z.number().optional(),
    cron: z.string().optional(),
    maxRuns: z.number().optional(),
    endAt: z.number().optional(),
  })
  .superRefine((recurrence, ctx) => {
    if (recurrence.kind === 'interval') {
      if (recurrence.intervalMs === undefined || recurrence.intervalMs < 1_000) {
        ctx.addIssue({ code: 'custom', path: ['intervalMs'], message: 'kind=interval 必填 intervalMs 且 ≥1000' });
      }
    } else if (recurrence.cron === undefined || !isValidCron(recurrence.cron)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cron'],
        message: `kind=cron 必填合法 5 字段 cron：${recurrence.cron ?? '(缺)'}`,
      });
    }
    if (recurrence.maxRuns !== undefined && recurrence.maxRuns < 1) {
      ctx.addIssue({ code: 'custom', path: ['maxRuns'], message: 'maxRuns 须 ≥1' });
    }
  });
export type TaskRecurrence = z.infer<typeof TaskRecurrenceSchema>;

export const TaskBlockedReasonSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type TaskBlockedReason = z.infer<typeof TaskBlockedReasonSchema>;

export const TaskProposalSchema = z.object({
  status: z.enum(['pending_approval', 'approved', 'rejected']),
  at: z.number(),
  by: z.string().optional(),
  reason: z.string().optional(),
});
export type TaskProposal = z.infer<typeof TaskProposalSchema>;

/**
 * TaskNode 全快照（T0.2 §3.1）。相对规格 type-equiv 的两处必要补字段
 * （规格 §3.1 为等价声明，服务面 TaskCompletion 已定义这两项）：
 *  - `evidence`：完成证据（T0.1 J4 目标 verifying 的汇聚输入）
 *  - `unfinished`：预算耗尽时的未完成清单（J6/C5 硬要求，必须可机读）
 */
export const TaskNodeSchema = z
  .object({
    id: z.string().transform(asTaskId),
    revision: z.number(),
    goalId: z.string(),
    parentTaskId: z.string().optional(),
    alternativeOf: z.string().optional(),
    subject: z.string(),
    description: z.string(),
    phase: z.enum(TASK_PHASES),
    stage: z.enum(TASK_STAGES),
    outcome: z.enum(TASK_OUTCOMES).optional(),
    blockedReason: TaskBlockedReasonSchema.optional(),
    ownerId: z.string().optional(),
    blockedBy: z.array(z.string()),
    localPath: z.string().optional(),
    writeScopes: z.array(z.string()),
    priority: z.number(),
    schedule: TaskScheduleSchema,
    recurrence: TaskRecurrenceSchema.optional(),
    runCount: z.number(),
    consecutiveFailures: z.number(),
    lastRunAt: z.number().optional(),
    nextDueAt: z.number().optional(),
    evidence: z.array(z.string()).optional(),
    unfinished: z.array(z.string()).optional(),
    proposedBy: z.enum(['human', 'agent']),
    proposal: TaskProposalSchema.optional(),
    budget: TaskBudgetSchema,
    progress: z.string().optional(),
    deletedAt: z.number().optional(),
    deleteReason: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .superRefine((node, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    // 1. 终态字段完备律（承 T0.1 同款）
    if (node.phase === 'complete' && node.outcome === undefined) {
      issue('phase=complete 必填 outcome（显式终态，失败也是完成）');
    }
    if (node.phase !== 'complete' && node.outcome !== undefined) {
      issue(`phase=${node.phase} 不得携带 outcome`);
    }
    if (node.phase === 'blocked' && node.blockedReason === undefined) {
      issue('phase=blocked 必填 blockedReason（稳定 code + 人读 message）');
    }
    if (node.phase !== 'blocked' && node.blockedReason !== undefined) {
      issue(`phase=${node.phase} 不得携带 blockedReason（resume 须清理由）`);
    }
    if (node.phase === 'complete' && node.nextDueAt !== undefined) {
      issue('phase=complete 不得携带 nextDueAt（周期任务收尾须停排）');
    }
    // 2. zone 派生一致性：防注入篡改派生字段绕过三区行为
    const expectedZone = zoneOf(node.budget);
    if (node.budget.zone !== expectedZone) {
      issue(`budget.zone=${node.budget.zone} 与按帽/账本重算的 ${expectedZone} 不一致（派生字段不得篡改）`);
    }
    // 3. 耗尽区终态必须带未完成清单（C5：绝不悄然截断）
    if (node.phase === 'complete' && node.budget.zone === 'exhausted' && node.unfinished === undefined) {
      issue('预算耗尽（zone=exhausted）触发的 complete 必带 unfinished 未完成清单');
    }
    // 4. run 计数守恒
    if (node.recurrence === undefined && node.runCount > 1) {
      issue(`一次性任务 runCount 须 ≤1，收到 ${node.runCount}`);
    }
    if (node.consecutiveFailures > node.runCount) {
      issue(`consecutiveFailures(${node.consecutiveFailures}) 不得超过 runCount(${node.runCount})`);
    }
    if (node.runCount > 0 && node.lastRunAt === undefined) {
      issue('runCount>0 必带 lastRunAt（run 时刻可溯）');
    }
    // 5. 周期形态律：停排 ⟺ 无 nextDueAt；在跑 ⟺ 有 nextDueAt
    if (node.recurrence !== undefined && node.phase === 'active' && node.nextDueAt === undefined) {
      issue('运行中的周期任务必带 nextDueAt（durable 调度锚点）');
    }
    if (node.recurrence === undefined && node.nextDueAt !== undefined) {
      issue('非周期任务不得携带 nextDueAt');
    }
    if (
      node.recurrence?.maxRuns !== undefined &&
      node.phase === 'active' &&
      node.runCount > node.recurrence.maxRuns
    ) {
      // 注意用 > 而非 ≥：第 maxRuns 轮本身合法（是最后一轮，收尾后停排）
      issue(`runCount(${node.runCount}) 已超 maxRuns(${node.recurrence.maxRuns}) 却仍在跑（应停排收敛）`);
    }
    // 6. 待批提议形态律（J9）
    if (node.proposal?.status === 'pending_approval') {
      if (node.phase !== 'active' || node.stage !== 'planning' || node.ownerId !== undefined) {
        issue('待批提议只能停在 active(planning) 且无 owner（未批准不可认领/派发）');
      }
      if (node.runCount > 0) {
        issue('待批提议不得已开跑');
      }
    }
    if (node.proposedBy === 'human' && node.proposal?.status === 'pending_approval') {
      issue('proposedBy=human 的任务不应处于待批态（人类直建即批准）');
    }
    // 7. tombstone 字段配对
    if (node.deletedAt === undefined && node.deleteReason !== undefined) {
      issue('deleteReason 只在 tombstone（deletedAt 在场）时出现');
    }
  });

export type TaskNode = z.infer<typeof TaskNodeSchema>;

/** task_history 记录（键 TaskId#revision）。 */
export const TaskChangeRecordSchema = z.object({
  taskId: z.string(),
  revision: z.number(),
  operation: z.enum(TASK_OPERATIONS),
  actor: z.enum(TASK_ACTORS),
  summary: z.string(),
  /** 预算记账增量（consume/consume-rollup 操作在场）——向上汇聚的可机读依据。 */
  usage: TaskConsumedSchema.partial().optional(),
  at: z.number(),
});
export type TaskChangeRecord = z.infer<typeof TaskChangeRecordSchema>;

/** task_runs 记录（键 TaskId#runIndex，append-only）。 */
export const TaskRunRecordSchema = z.object({
  taskId: z.string(),
  runIndex: z.number(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  outcome: z.enum(TASK_OUTCOMES).optional(),
  consumed: TaskConsumedSchema,
  notes: z.string().optional(),
});
export type TaskRunRecord = z.infer<typeof TaskRunRecordSchema>;

export type TaskTables = {
  task_nodes: typeof TaskNodeSchema;
  task_history: typeof TaskChangeRecordSchema;
  task_runs: typeof TaskRunRecordSchema;
};

export const taskPoolDomainSpec = defineTdaDomain({
  name: 'tda-task-pool',
  version: 1,
  tables: {
    task_nodes: TaskNodeSchema,
    task_history: TaskChangeRecordSchema,
    task_runs: TaskRunRecordSchema,
  },
  layout: 'single',
});
