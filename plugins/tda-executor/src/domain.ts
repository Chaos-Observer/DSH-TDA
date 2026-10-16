/**
 * tda-executor 域定义（T4.1 §3.3 存储落点）。
 *
 * 两表，**全部权威**（`invalidRecords: 'reject'`）：
 *  - `executor_attempts`：attempt 全快照（CAS revision+1）。attempt 记录"选了什么
 *    任务/路由到什么/第几试/为何终态"——调度决策**不可由其他域重放重建**（P1 纪律 #12：
 *    不可重算 ⇒ 权威），故域+事件双写（族 `executor/change`，第二十族）；
 *  - `executor_params`：策略权威（并发帽/重试帽/选择序/验证模式/路由版本）。
 *
 * 与 T0.7 audit_index 的区别：audit_index 是"必须持久却不能产事件"的派生（否则
 * 索引事件引发新索引的自指放大）；attempt 是审计链的解释环节（T3.2 auditView 需
 * 可定位"为何执行/为何切"），必须产事件。
 *
 * 执行环对任务/派发/工作流/监督**零直写**：一切状态变更经对方服务面 CAS
 * （deps 类型级只注入服务方法，见 service.ts 的 seam 声明）。
 */
import { asAttemptId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

export const ATTEMPT_PREFIX = 'exec';
export const EXECUTOR_PARAMS_KEY = 'singleton';
/** params 行的稳定业务 id（T0.7 不变量 7：配对事件稳定 id）。 */
export const EXECUTOR_PARAMS_BUSINESS_ID = 'params';

/** attempt 状态机（T4.1 §2）。 */
export const EXECUTOR_ATTEMPT_STATUSES = [
  'selected',
  'claimed',
  'executing',
  'awaiting-approval',
  'verifying',
  'completed',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type ExecutorAttemptStatus = (typeof EXECUTOR_ATTEMPT_STATUSES)[number];

/** 终态集合（显式终态纪律 C5：失败/半截/孤儿都必须落这里）。 */
export const EXECUTOR_TERMINAL_STATUSES = ['completed', 'failed', 'blocked', 'cancelled'] as const;

/** 路由三模式（J3：确定性纯函数，禁 LLM 猜）。 */
export const EXECUTOR_MODES = ['workflow', 'dispatch', 'direct'] as const;
export type ExecutorMode = (typeof EXECUTOR_MODES)[number];

export const VERIFICATION_KINDS = ['workflow-contract', 'evidence-check', 'lead-review'] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const VerificationReportSchema = z.object({
  kind: z.enum(VERIFICATION_KINDS),
  passed: z.boolean(),
  /** 消毒摘要（禁原文；同 T0.5 diagnostic 消毒纪律）。 */
  detail: z.string(),
  evidenceEntryIds: z.array(z.string()),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

export const ExecutorAttemptSchema = z
  .object({
    id: z.string().transform(asAttemptId),
    revision: z.number(),
    taskId: z.string(),
    goalId: z.string(),
    mode: z.enum(EXECUTOR_MODES),
    /** 路由依据（可回放：matched defId / no-def / verify-closeout）。 */
    modeReason: z.string(),
    defId: z.string().optional(),
    orderId: z.string().optional(),
    runId: z.string().optional(),
    status: z.enum(EXECUTOR_ATTEMPT_STATUSES),
    /** 第几试（1 起；重试 +1）。 */
    attempts: z.number(),
    /** = scheduler 会话（J4：认领 owner 纪律）。 */
    ownerId: z.string(),
    /** awaiting-approval 的监督请求 id（J7）。 */
    approvalId: z.string().optional(),
    verification: VerificationReportSchema.optional(),
    outcome: z.enum(['success', 'failed']).optional(),
    /** failed 必填（C5：未完成清单）。 */
    unfinished: z.array(z.string()).optional(),
    createdAt: z.number(),
    settledAt: z.number().optional(),
  })
  .superRefine((attempt, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (attempt.modeReason === '') issue('modeReason 必填（路由依据可回放）');
    if (attempt.attempts < 1) issue(`attempts 须 ≥1（收到 ${attempt.attempts}）`);
    if (attempt.status === 'failed') {
      if (attempt.outcome !== 'failed') issue('status=failed 必携 outcome=failed');
      if ((attempt.unfinished?.length ?? 0) === 0) issue('status=failed 必携非空 unfinished（C5 显式终态）');
    }
    if (attempt.status === 'completed' && attempt.outcome !== 'success') {
      issue('status=completed 必携 outcome=success');
    }
    if (attempt.outcome !== undefined && attempt.status !== 'completed' && attempt.status !== 'failed') {
      issue(`status=${attempt.status} 不得携带 outcome（显式终态才判成败）`);
    }
    const terminal = (EXECUTOR_TERMINAL_STATUSES as readonly string[]).includes(attempt.status);
    if (terminal && attempt.settledAt === undefined) issue(`终态 ${attempt.status} 必携 settledAt`);
    if (!terminal && attempt.settledAt !== undefined) issue(`非终态 ${attempt.status} 不得携带 settledAt`);
    if (attempt.status === 'awaiting-approval' && attempt.approvalId === undefined) {
      issue('awaiting-approval 必携 approvalId（监督请求引用）');
    }
    if (attempt.status !== 'awaiting-approval' && attempt.approvalId !== undefined && attempt.status !== 'completed' && attempt.status !== 'failed') {
      issue(`status=${attempt.status} 不得残留 approvalId（凭票消费后应清除或已终态）`);
    }
    if (attempt.verification !== undefined && !['verifying', 'completed', 'failed'].includes(attempt.status)) {
      issue(`status=${attempt.status} 不得携带 verification（验证只发生在 verifying 及之后）`);
    }
    if (attempt.mode === 'workflow' && attempt.defId === undefined) {
      issue('mode=workflow 必携 defId（路由依据）');
    }
    if (attempt.mode === 'workflow' && attempt.defId !== undefined && attempt.defId === '') {
      issue('defId 不得为空串');
    }
    if (attempt.mode !== 'workflow' && attempt.defId !== undefined) {
      issue(`mode=${attempt.mode} 不得携带 defId`);
    }
    if (
      attempt.mode === 'dispatch' &&
      ['executing', 'verifying', 'completed', 'failed'].includes(attempt.status) &&
      attempt.orderId === undefined
    ) {
      issue(`mode=dispatch 在 ${attempt.status} 必携 orderId（对账 T0.5）`);
    }
    if (
      attempt.mode === 'direct' &&
      (attempt.orderId !== undefined || attempt.runId !== undefined || attempt.defId !== undefined)
    ) {
      issue('mode=direct 不得携带 orderId/runId/defId');
    }
  });
export type ExecutorAttempt = z.infer<typeof ExecutorAttemptSchema>;

export const ExecutorParamsSchema = z
  .object({
    /** 同时 executing 态 attempt 帽（J11）。 */
    maxParallel: z.number(),
    /** 单任务自动重试帽（J6）。 */
    maxRetries: z.number(),
    /** v1 唯一选择序：priority 降序 → dueAt 升序 → createdAt 升序（承 T0.2 dispatch 序）。 */
    selectionPolicy: z.literal('priority-due'),
    /** 完成前验证模式（J5）。 */
    verifyMode: z.enum(['evidence', 'evidence+lead']),
    /** 路由规则版本（回放解释，同 scorerVersion 范式）。 */
    routerVersion: z.number(),
    revision: z.number(),
  })
  .superRefine((params, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (!Number.isInteger(params.maxParallel) || params.maxParallel < 1) {
      issue(`maxParallel 须为 ≥1 的整数（收到 ${params.maxParallel}）`);
    }
    if (!Number.isInteger(params.maxRetries) || params.maxRetries < 0) {
      issue(`maxRetries 须为 ≥0 的整数（收到 ${params.maxRetries}）`);
    }
    if (!Number.isInteger(params.routerVersion) || params.routerVersion < 1) {
      issue(`routerVersion 须为 ≥1 的整数（收到 ${params.routerVersion}）`);
    }
  });
export type ExecutorParams = z.infer<typeof ExecutorParamsSchema>;

/** v1 默认（T4.1 §3.3）。 */
export const DEFAULT_EXECUTOR_PARAMS: ExecutorParams = {
  maxParallel: 2,
  maxRetries: 1,
  selectionPolicy: 'priority-due',
  verifyMode: 'evidence',
  routerVersion: 1,
  revision: 0,
};

export const executorDomainSpec = defineTdaDomain({
  name: 'tda-executor',
  version: 1,
  tables: {
    executor_attempts: ExecutorAttemptSchema,
    executor_params: ExecutorParamsSchema,
  },
  invalidRecords: 'reject',
  layout: 'single',
});

export type ExecutorTables = {
  executor_attempts: typeof ExecutorAttemptSchema;
  executor_params: typeof ExecutorParamsSchema;
}
