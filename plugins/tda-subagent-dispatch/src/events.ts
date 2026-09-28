/**
 * tda-subagent-dispatch 事件构造：只允许走已登记族（dispatch/change，编号 4）。
 *
 * 载荷 = DispatchOrder 全快照（J11 三层审计之一）：replay-equivalence 的 rebuild
 * 直接以 payload 还原记录；事件不存 seq（seq 由 session sink 拥有序分配）。
 * 显式逐字段构造：payload 形态与 DispatchOrder 记录逐字段一致，可选字段遵循
 * exactOptionalPropertyTypes——仅在在场时挂键。
 */
import type { JsonObject } from '@tda/kernel';
import type { DispatchActor, DispatchOrder, RolePolicy } from './domain.ts';

export const dispatchChangePayload = (order: DispatchOrder): JsonObject => ({
  id: order.id,
  revision: order.revision,
  taskId: order.taskId,
  goalId: order.goalId,
  role: order.role,
  mode: order.mode,
  provider: order.provider,
  agentOptions: {
    provider: order.agentOptions.provider,
    model: order.agentOptions.model,
    ...(order.agentOptions.reasoningEffort !== undefined
      ? { reasoningEffort: order.agentOptions.reasoningEffort }
      : {}),
    ...(order.agentOptions.maxTokens !== undefined ? { maxTokens: order.agentOptions.maxTokens } : {}),
  },
  toolFilter: [...order.toolFilter],
  maxDepth: order.maxDepth,
  sandbox: order.sandbox,
  personaTemplateId: order.personaTemplateId,
  outputSchemaId: order.outputSchemaId,
  risk: order.risk,
  ...(order.approval !== undefined
    ? {
        approval: {
          status: order.approval.status,
          at: order.approval.at,
          ...(order.approval.by !== undefined ? { by: order.approval.by } : {}),
          // 一次性的内部审批 nonce（非外部凭据）：随快照完整入事件，
          // 保证 replay-equivalence 能由载荷逐字段还原记录（内核硬契约）；
          // 它开跑即消费，审计上可证明"发了哪张凭据、何时消费"。
          ...(order.approval.token !== undefined ? { token: order.approval.token } : {}),
          ...(order.approval.consumedAt !== undefined ? { consumedAt: order.approval.consumedAt } : {}),
          ...(order.approval.reason !== undefined ? { reason: order.approval.reason } : {}),
        },
      }
    : {}),
  status: order.status,
  ...(order.childSessionId !== undefined ? { childSessionId: order.childSessionId } : {}),
  promptHash: order.promptHash,
  ...(order.result !== undefined
    ? {
        result: {
          stopReason: order.result.stopReason,
          outcome: order.result.outcome,
          ...(order.result.conclusionEntryId !== undefined
            ? { conclusionEntryId: order.result.conclusionEntryId }
            : {}),
          ...(order.result.summary !== undefined
            ? { summary: { findings: [...order.result.summary.findings], confidence: order.result.summary.confidence } }
            : {}),
          ...(order.result.diagnostic !== undefined ? { diagnostic: order.result.diagnostic } : {}),
          consumed: {
            tokens: order.result.consumed.tokens,
            toolCalls: order.result.consumed.toolCalls,
            wallClockMs: order.result.consumed.wallClockMs,
          },
          ...(order.result.orphaned !== undefined ? { orphaned: order.result.orphaned } : {}),
        },
      }
    : {}),
  createdAt: order.createdAt,
  ...(order.settledAt !== undefined ? { settledAt: order.settledAt } : {}),
});

/**
 * 策略行变更载荷（§3.3"改策略=可审计变更"）。
 * businessId = `policy:<role>`——与派发单共用 dispatch/change 族（族是白名单单位，
 * 不能为策略另造族），但业务 id 前缀可区分，audit_index 定位仍可归因。
 */
export const dispatchPolicyPayload = (policy: RolePolicy, actor: DispatchActor, at: number): JsonObject => ({
  policyRole: policy.role,
  updatedBy: actor,
  updatedAt: at,
  agentOptions: {
    provider: policy.agentOptions.provider,
    model: policy.agentOptions.model,
    ...(policy.agentOptions.reasoningEffort !== undefined ? { reasoningEffort: policy.agentOptions.reasoningEffort } : {}),
    ...(policy.agentOptions.maxTokens !== undefined ? { maxTokens: policy.agentOptions.maxTokens } : {}),
  },
  toolFilter: [...policy.toolFilter],
  maxDepth: policy.maxDepth,
  sandbox: policy.sandbox,
  personaTemplateId: policy.personaTemplateId,
  maxParallel: policy.maxParallel,
  ...(policy.highRiskBudgetTokens !== undefined ? { highRiskBudgetTokens: policy.highRiskBudgetTokens } : {}),
});
