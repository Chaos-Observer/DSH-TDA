/**
 * tda-subagent-dispatch 域定义（T0.5 §3 数据模型）：两张表，均为权威数据。
 *
 *  - dispatch_orders：DispatchOrder 全快照（派发单，CAS revision+1，layout single）
 *  - dispatch_policy：RolePolicy（按角色一行；插件 Config 为默认种子，域为权威）
 *
 * invalidRecords 缺省 reject：派发记录是审计数据（§3.4），损坏必须响。
 *
 * schema 承载的恒等律（加载即拒，配合 reject 策略零额外检查代码）：
 *  1. 终态律：status=settled ⟺ result 在场；terminal(settled/cancelled) ⟺ settledAt 在场；
 *  2. 在途律：status∈{starting,running,settled} ⟹ childSessionId 在场（run 已发布）；
 *  3. 审批律（J9）：risk=high ⟹ approval 在场；已开跑(≥starting)/已结算 ⟹ 该审批已 approved
 *     且 token 已一次性消费（token 摘除 + consumedAt 在场）；
 *  4. 深度律（J6/不变量 5）：maxDepth 恒 0；role 与 outputSchemaId 一一对应；
 *  5. 结果律（§2.1）：outcome∈{conclusion,conclusion-partial} ⟹ conclusionEntryId 在场，
 *     outcome∈{aborted,error} ⟹ 不得携带 conclusionEntryId（无结论不得伪造引用）；
 *  6. fork 禁用律（J3）：mode 恒 'spawn'。
 */
import { asDispatchId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

export const DISPATCH_ROLES = ['sidekick', 'lead'] as const;
export type DispatchRole = (typeof DISPATCH_ROLES)[number];

/** P0 仅 spawn；'fork' 禁用（J3：fork 种子=父历史进子会话，与"只收任务描述"冲突）。 */
export const DISPATCH_MODES = ['spawn'] as const;
export type DispatchMode = (typeof DISPATCH_MODES)[number];

export const DISPATCH_STATUSES = [
  'requested',
  'approved',
  'starting',
  'running',
  'settled',
  'cancelled',
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** 终态（不可再变更）。 */
export const DISPATCH_TERMINAL: ReadonlySet<DispatchStatus> = new Set<DispatchStatus>(['settled', 'cancelled']);

/** 主上下文呈现口径（§2.1 stopReason → dispatch 结果映射）。 */
export const DISPATCH_OUTCOMES = ['conclusion', 'conclusion-partial', 'aborted', 'error'] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const DISPATCH_RISKS = ['low', 'high'] as const;
export type DispatchRisk = (typeof DISPATCH_RISKS)[number];

export const DISPATCH_SANDBOXES = ['read-only', 'workspace-write'] as const;
export type DispatchSandbox = (typeof DISPATCH_SANDBOXES)[number];

export const DISPATCH_OPERATIONS = [
  'request',
  'approve',
  'reject',
  'start',
  'run',
  'settle',
  'cancel',
  'reconcile-orphan',
] as const;
export type DispatchOperation = (typeof DISPATCH_OPERATIONS)[number];

export const DISPATCH_SCHEMA_IDS = [
  'sidekick-conclusion',
  'lead-conclusion',
  /** T0.6 §4.2：工作区语义标注 = sidekick-conclusion + 文件标注扩展字段（P0 内嵌）。 */
  'sidekick-workspace-annotation',
] as const;
export type DispatchSchemaId = (typeof DISPATCH_SCHEMA_IDS)[number];

/**
 * 角色 → 可用结论 schema 的对应律（J6 + T0.6 §4.2）。
 *
 * 默认 schema = 各角色第一项；内部消费方（如工作区标注）可显式指定本角色的
 * 其它 schema。**模型通道不暴露 schema 参数**（工具只收 taskId+role），
 * 故"改 schema 绕过白名单"对模型不可达。
 */
export const ROLE_SCHEMAS: Readonly<Record<'sidekick' | 'lead', readonly DispatchSchemaId[]>> = {
  sidekick: ['sidekick-conclusion', 'sidekick-workspace-annotation'],
  lead: ['lead-conclusion'],
};

export const defaultSchemaOf = (role: 'sidekick' | 'lead'): DispatchSchemaId => ROLE_SCHEMAS[role][0] as DispatchSchemaId;

export const DISPATCH_ACTORS = ['human', 'agent', 'coach', 'scheduler'] as const;
export type DispatchActor = (typeof DISPATCH_ACTORS)[number];

/** DSH `SubagentResult.stopReason` 的已知变体（未知变体按 error 处理，§2.1）。 */
export const KNOWN_STOP_REASONS = ['completed', 'aborted', 'error', 'max-tokens', 'refusal'] as const;

export const AgentOptionsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  maxTokens: z.number().optional(),
});
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

export const ApprovalSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
  at: z.number(),
  by: z.string().optional(),
  /** 一次性批准凭据：仅在 approved 且未开跑时在场（消费即摘除）。 */
  token: z.string().optional(),
  /** token 一次性消费时刻（J9 / 不变量 8）。 */
  consumedAt: z.number().optional(),
  reason: z.string().optional(),
});
export type DispatchApproval = z.infer<typeof ApprovalSchema>;

export const DispatchConsumedSchema = z.object({
  tokens: z.number(),
  toolCalls: z.number(),
  wallClockMs: z.number(),
});
export type DispatchConsumed = z.infer<typeof DispatchConsumedSchema>;

export const ZERO_DISPATCH_CONSUMED: DispatchConsumed = { tokens: 0, toolCalls: 0, wallClockMs: 0 };

export const DispatchResultSchema = z.object({
  stopReason: z.string(),
  outcome: z.enum(DISPATCH_OUTCOMES),
  conclusionEntryId: z.string().optional(),
  /**
   * 结论摘要（规格 §3.1 DispatchResult 的必要补字段）：J5 要求主上下文只出现
   * "结论摘要视图 + entryId 引用"，而结论正文落时间线；摘要若不留存在派发单上，
   * 每轮渲染 ConclusionView 都要回查时间线（跨插件耦合 + 成本）。故随单持久化
   * `findings[:3] + confidence`——正文仍在时间线，摘要只是渲染用裁剪。
   */
  summary: z
    .object({
      findings: z.array(z.string()),
      confidence: z.number(),
    })
    .optional(),
  /** provider 消毒文本，≤4096 UTF-8 字节（§5 诊断消毒契约）。 */
  diagnostic: z.string().optional(),
  consumed: DispatchConsumedSchema,
  /**
   * 规格 §3.1 DispatchResult 的必要补字段（C5 显式终态）：宿主重启导致在途
   * run 失联时，该派发单以显式终态 `error + orphaned` 收尾，而非永久悬停
   * 在 starting/running（T0.7 孤儿单显式终态同款纪律）。
   */
  orphaned: z.boolean().optional(),
});
export type DispatchResult = z.infer<typeof DispatchResultSchema>;

export const DispatchOrderSchema = z
  .object({
    id: z.string().transform(asDispatchId),
    revision: z.number(),
    taskId: z.string(),
    goalId: z.string(),
    role: z.enum(DISPATCH_ROLES),
    mode: z.enum(DISPATCH_MODES),
    provider: z.literal('spawn'),
    agentOptions: AgentOptionsSchema,
    toolFilter: z.array(z.string()),
    maxDepth: z.literal(0),
    sandbox: z.enum(DISPATCH_SANDBOXES),
    personaTemplateId: z.string(),
    outputSchemaId: z.enum(DISPATCH_SCHEMA_IDS),
    risk: z.enum(DISPATCH_RISKS),
    approval: ApprovalSchema.optional(),
    status: z.enum(DISPATCH_STATUSES),
    childSessionId: z.string().optional(),
    promptHash: z.string(),
    result: DispatchResultSchema.optional(),
    createdAt: z.number(),
    settledAt: z.number().optional(),
  })
  .superRefine((order, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    const terminal = DISPATCH_TERMINAL.has(order.status);
    // 1. 终态律
    if (order.status === 'settled' && order.result === undefined) {
      issue('status=settled 必填 result（结算即带结论/诊断）');
    }
    if (order.status !== 'settled' && order.result !== undefined) {
      issue(`status=${order.status} 不得携带 result（只有 settled 才有回传结果）`);
    }
    if (terminal && order.settledAt === undefined) {
      issue(`${order.status} 是终态，必填 settledAt`);
    }
    if (!terminal && order.settledAt !== undefined) {
      issue(`status=${order.status} 非终态，不得携带 settledAt`);
    }
    // 2. 在途律：run 一旦发布就有子会话 id（starting 是"已调 start，run 未发布"的过渡态）
    if (
      (order.status === 'running' || order.status === 'settled') &&
      order.childSessionId === undefined
    ) {
      issue(`status=${order.status} 必有 childSessionId（run 已发布，子会话即 claim owner）`);
    }
    if (order.status === 'starting' && order.childSessionId !== undefined) {
      issue('status=starting 尚无子会话 id（run 未发布）——发布后即转 running');
    }
    // 3. 审批律（J9）
    if (order.risk === 'high' && order.approval === undefined) {
      issue('risk=high 必带 approval（未批准禁派）');
    }
    const started = order.status === 'starting' || order.status === 'running' || order.status === 'settled';
    if (started) {
      if (order.approval?.status !== 'approved' && order.risk === 'high') {
        issue(`status=${order.status} 的高风险派发必须先经批准（approval.status=approved）`);
      }
      if (order.approval?.token !== undefined) {
        issue('已开跑的派发不得再持批准 token（一次性凭据须已消费）');
      }
      if (order.risk === 'high' && order.approval?.consumedAt === undefined) {
        issue('高风险派发开跑即须记录 token 消费时刻（consumedAt，防重放）');
      }
    }
    if (order.approval?.status === 'approved' && order.approval.token === undefined && order.approval.consumedAt === undefined) {
      issue('审批通过须发一次性 token（或已消费并留 consumedAt）');
    }
    // 4. 深度/角色律
    if (!ROLE_SCHEMAS[order.role].includes(order.outputSchemaId)) {
      issue(
        `role=${order.role} 不得使用 outputSchemaId=${order.outputSchemaId}（允许：${ROLE_SCHEMAS[order.role].join('/')}）`,
      );
    }
    // 6. 结构白名单体积上界（诊断 ≤4096 字节，§5 消毒契约）
    if (order.result?.diagnostic !== undefined && Buffer.byteLength(order.result.diagnostic, 'utf8') > 4096) {
      issue('result.diagnostic 超过 4096 UTF-8 字节上界（provider 消毒契约）');
    }
    // 5. 结果律（§2.1）
    const outcome = order.result?.outcome;
    if (outcome !== undefined) {
      const hasConclusion = outcome === 'conclusion' || outcome === 'conclusion-partial';
      if (hasConclusion && order.result?.summary === undefined) {
        issue(`outcome=${outcome} 必带 summary（结论摘要随单持久化，供 ConclusionView 渲染）`);
      }
      if (!hasConclusion && order.result?.summary !== undefined) {
        issue(`outcome=${outcome} 不得携带 summary（无结论不得有结论摘要）`);
      }
      if (outcome === 'conclusion' && order.result?.conclusionEntryId === undefined) {
        issue('outcome=conclusion 必带 conclusionEntryId（结论已过 schema 并落时间线）');
      }
      if (!hasConclusion && order.result?.conclusionEntryId !== undefined) {
        issue(`outcome=${outcome} 不得携带 conclusionEntryId（无结论不得伪造引用）`);
      }
    }
  });

export type DispatchOrder = z.infer<typeof DispatchOrderSchema>;

/** dispatch_policy：按角色一行的策略权威（插件 Config 为默认种子）。 */
export const RolePolicySchema = z.object({
  role: z.enum(DISPATCH_ROLES),
  agentOptions: AgentOptionsSchema,
  toolFilter: z.array(z.string()),
  maxDepth: z.literal(0),
  sandbox: z.enum(DISPATCH_SANDBOXES),
  personaTemplateId: z.string(),
  /** 该角色在飞上限（总帽另计）。 */
  maxParallel: z.number(),
  /** 超此 token 预算的派发升 high（J9 高风险判定之一）。 */
  highRiskBudgetTokens: z.number().optional(),
});
export type RolePolicy = z.infer<typeof RolePolicySchema>;

export type DispatchTables = {
  dispatch_orders: typeof DispatchOrderSchema;
  dispatch_policy: typeof RolePolicySchema;
};

export const dispatchDomainSpec = defineTdaDomain({
  name: 'tda-subagent-dispatch',
  version: 1,
  tables: {
    dispatch_orders: DispatchOrderSchema,
    dispatch_policy: RolePolicySchema,
  },
  layout: 'single',
});
