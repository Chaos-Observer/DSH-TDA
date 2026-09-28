/**
 * tda-governance 事件载荷（T1.2 §5 审计基线）。
 *
 * 族 `memoryGov/change` 承载**每一条治理动作**（businessId = `gov-<n>`）。
 * 「动作日志 = 治理权威」意味着它必须同时进事件流——否则崩溃后无法回放重建状态。
 *
 * 键序**必须与 `GovActionSchema` 的定义序一致**：domain 记录经 zod parse 产出
 * （键序 = schema 序），replay-equivalence 以 `JSON.stringify` 整体比对，
 * 任一字段错位即判"分歧"。可选键**仅在在场时挂**。
 */
import type { JsonObject } from '@tda/kernel';
import type { GovAction } from './domain.ts';

export function govActionPayload(action: GovAction): JsonObject {
  return {
    id: String(action.id),
    assetKind: action.assetKind,
    assetId: action.assetId,
    action: action.action,
    ...(action.from !== undefined ? { from: action.from } : {}),
    ...(action.to !== undefined ? { to: action.to } : {}),
    ...(action.reason !== undefined ? { reason: { kind: action.reason.kind, detail: action.reason.detail } } : {}),
    ...(action.evidence !== undefined
      ? {
          evidence: {
            taskId: action.evidence.taskId,
            runIndex: action.evidence.runIndex,
            taskOutcome: action.evidence.taskOutcome,
            injectedAt: action.evidence.injectedAt,
            checkedAt: action.evidence.checkedAt,
          },
        }
      : {}),
    actor: { sessionId: action.actor.sessionId, actor: action.actor.actor, at: action.actor.at },
    ...(action.approvalToken !== undefined ? { approvalToken: action.approvalToken } : {}),
    ...(action.ranking !== undefined
      ? {
          ranking: action.ranking.map((row) => ({
            assetId: row.assetId,
            score: row.score,
            reuseCount: row.reuseCount,
            credentialRank: row.credentialRank,
          })),
        }
      : {}),
    ...(action.promotedFrom !== undefined ? { promotedFrom: action.promotedFrom } : {}),
    ...(action.conflictWith !== undefined ? { conflictWith: [...action.conflictWith] } : {}),
    ...(action.dupOf !== undefined ? { dupOf: action.dupOf } : {}),
    at: action.at,
  };
}
