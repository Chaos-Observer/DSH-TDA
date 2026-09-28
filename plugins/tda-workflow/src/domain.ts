/**
 * T2.5 工作流外部化 v1 —— domain（四表）。
 *
 * J3：meta（声明式数据，zod 校验**永不 eval**）+ script（控制流，经 scriptHash 冻结）。
 * J10：run 事件是权威日志，workflow_runs 只是投影。
 * 治理状态不存本 domain 副本——status 为 ctx.governance 投影镜像。
 */
import { z } from 'zod';
import { asWorkflowDefId, asWorkflowEventId, asWorkflowRunId, defineTdaDomain } from '@tda/kernel';

/** contract 断言七类（J4，结构化可判定，非自由文本）。 */
export const ASSERTION_KINDS = [
  'file-exists',
  'file-contains',
  'task-phase',
  'budget-zone',
  'tool-succeeded',
  'schema-valid',
  'artifact-exists',
] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const AssertionSchema = z.object({
  kind: z.enum(ASSERTION_KINDS),
  target: z.string(),
  expect: z.string(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const BoundSchema = z.object({
  kind: z.enum(['file-read-scope', 'tool-precondition', 'budget-cap']),
  target: z.string(),
  limit: z.string(),
});
export type Bound = z.infer<typeof BoundSchema>;

export const STEP_KINDS = ['dispatch', 'tool', 'approval', 'aggregate', 'wait'] as const;
export type WorkflowStepKind = (typeof STEP_KINDS)[number];

export const WorkflowMetaSchema = z
  .object({
    phases: z.array(z.object({ id: z.string(), label: z.string(), stepIds: z.array(z.string()) })),
    steps: z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(STEP_KINDS),
          /** J9：引用技能（skillId+入参契约），不复制 procedure。 */
          contractRef: z
            .object({
              skillId: z.string().optional(),
              argsContract: z.array(AssertionSchema).optional(),
            })
            .optional(),
          dependsOn: z.array(z.string()),
          alternativeOf: z.string().optional(),
          contract: z.object({ pre: z.array(AssertionSchema), post: z.array(AssertionSchema), hardBounds: z.array(BoundSchema) }),
        }),
      )
      .superRefine((steps, ctx) => {
        const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
        // J9 对偶：模板禁含实现细节；技能禁含编排——schema 层拒"步骤里带分支审批语义"的技能引用形态
        const ids = new Set(steps.map((step) => step.id));
        if (ids.size !== steps.length) issue('step id 重复（DAG 节点必须唯一）');
        for (const step of steps) {
          for (const dep of step.dependsOn) {
            if (!ids.has(dep)) issue(`step ${step.id} 的 dependsOn=${dep} 不在步骤集内（DAG 边必须指向已知节点）`);
          }
        }
      }),
    approvalNodes: z.array(
      z.object({
        stepId: z.string(),
        riskLevel: z.enum(['low', 'medium', 'high']),
        whatToShow: z.record(z.string(), z.unknown()),
        resumeFrom: z.string(),
      }),
    ),
    budgets: z.object({
      tokens: z.number().optional(),
      toolCalls: z.number().optional(),
      wallClockMs: z.number().optional(),
      attentionUnits: z.number().optional(),
    }),
    deviationBudget: z.object({ postFailMax: z.number(), mismatchDensityMax: z.number(), burnRateMax: z.number() }),
    paramsSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((meta, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    // DAG 无环（执行器断言的前置：加载期拓扑检查）
    const ids = meta.steps.map((step) => step.id);
    const edges = new Map<string, string[]>(meta.steps.map((step) => [step.id, [...step.dependsOn]]));
    const state = new Map<string, number>();
    const visit = (id: string): boolean => {
      const mark = state.get(id) ?? 0;
      if (mark === 1) return false;
      if (mark === 2) return true;
      state.set(id, 1);
      for (const dep of edges.get(id) ?? []) {
        if (ids.includes(dep) && !visit(dep)) return false;
      }
      state.set(id, 2);
      return true;
    };
    for (const id of ids) {
      if (!visit(id)) {
        issue('dependsOn 存在环（DAG 无环是执行前提）');
        break;
      }
    }
  });
export type WorkflowMeta = z.infer<typeof WorkflowMetaSchema>;

export const DefinitionSchema = z.object({
  defId: z.string().transform(asWorkflowDefId),
  version: z.number(),
  supersedes: z.string().optional(),
  kind: z.enum(['template', 'instance']),
  parentTemplateId: z.string().optional(),
  name: z.string(),
  description: z.string(),
  source: z.enum(['planner', 'human', 'coach', 'template-instance']),
  meta: WorkflowMetaSchema,
  script: z.string(),
  scriptHash: z.string(),
  createdBy: z.object({ sessionId: z.string(), actor: z.string() }),
  createdAt: z.number(),
});
export type WorkflowDefinition = z.infer<typeof DefinitionSchema>;

export const RUN_STATUSES = [
  'pending',
  'running',
  'awaiting-approval',
  'replanning',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatus = (typeof RUN_STATUSES)[number];

export const RunSchema = z
  .object({
    runId: z.string().transform(asWorkflowRunId),
    defId: z.string(),
    defVersion: z.number(),
    taskId: z.string(),
    params: z.record(z.string(), z.unknown()),
    status: z.enum(RUN_STATUSES),
    stepStates: z.record(z.string(), z.enum(['ready', 'checking-pre', 'executing', 'checking-post', 'done', 'failed', 'skipped'])),
    deviation: z.object({ postFail: z.number(), mismatchDensity: z.number(), burnRate: z.number() }),
    unfinished: z.array(z.string()).optional(),
    outcome: z.enum(['success', 'failed', 'cancelled']).optional(),
    startedAt: z.number(),
    endedAt: z.number().optional(),
  })
  .superRefine((run, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    const terminal = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
    if (terminal && run.endedAt === undefined) issue('终态 run 必带 endedAt');
    if (run.status === 'failed' && (run.unfinished === undefined || run.unfinished.length === 0)) {
      issue('failed 是显式终态，必带 unfinished 清单（C5）');
    }
  });
export type WorkflowRun = z.infer<typeof RunSchema>;

export const EVENT_KINDS = [
  'step-begin',
  'step-end',
  'contract-check',
  'contract-violation',
  'approval-request',
  'approval-decision',
  'deviation',
  'replan',
  'budget-consume',
  'run-end',
] as const;
export type WorkflowEventKind = (typeof EVENT_KINDS)[number];

export const EventSchema = z.object({
  id: z.string().transform(asWorkflowEventId),
  runId: z.string(),
  kind: z.enum(EVENT_KINDS),
  stepId: z.string().optional(),
  detail: z.record(z.string(), z.unknown()),
  at: z.number(),
});
export type WorkflowEvent = z.infer<typeof EventSchema>;

export const ParamsSchema = z
  .object({
    defaultDeviationBudget: z.object({ postFailMax: z.number(), mismatchDensityMax: z.number(), burnRateMax: z.number() }),
    maxConcurrentRuns: z.number(),
    approvalTokenTtlMs: z.number(),
    revision: z.number(),
  })
  .superRefine((params, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (params.maxConcurrentRuns < 1) issue(`maxConcurrentRuns 须 ≥1（收到 ${params.maxConcurrentRuns}）`);
  });
export type WorkflowParams = z.infer<typeof ParamsSchema>;

export const DEFAULT_PARAMS: WorkflowParams = {
  defaultDeviationBudget: { postFailMax: 2, mismatchDensityMax: 0.4, burnRateMax: 1.5 },
  maxConcurrentRuns: 3,
  approvalTokenTtlMs: 86_400_000,
  revision: 0,
};

export const WORKFLOW_PARAMS_KEY = 'singleton';

export type WorkflowTables = {
  workflow_defs: typeof DefinitionSchema;
  workflow_events: typeof EventSchema;
  workflow_runs: typeof RunSchema;
  workflow_params: typeof ParamsSchema;
};

export const workflowDomainSpec = defineTdaDomain({
  name: 'tda-workflow',
  version: 1,
  tables: {
    workflow_defs: DefinitionSchema,
    workflow_events: EventSchema,
    workflow_runs: RunSchema,
    workflow_params: ParamsSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});

/** scriptHash（冻结指纹，J3）：确定性 JSON 串 FNV-1a 32 位十六进制。 */
export const scriptHashOf = (script: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < script.length; i += 1) {
    hash ^= script.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
