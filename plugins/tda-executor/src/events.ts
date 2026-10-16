/**
 * tda-executor 事件载荷（族 `executor/change`，第二十族，内核 events.ts 登记）。
 *
 * 纪律（T0.7 J2 + 施工范式 #26）：payload 键序**必须与 schema 定义序一致**
 * （compareReplay 是 stringify 逐字节比对，键序漂移=回放分歧假红）；
 * 可选键仅在在场时挂（缺键不挂 undefined——JSON 无损）。
 */
import type { ExecutorAttempt, ExecutorParams } from './domain.ts';
import type { JsonObject } from '@tda/kernel';

/** attempt 全快照载荷（逐字段显式构造，保键序）。 */
export function attemptPayload(attempt: ExecutorAttempt): JsonObject {
  return {
    id: attempt.id,
    revision: attempt.revision,
    taskId: attempt.taskId,
    goalId: attempt.goalId,
    mode: attempt.mode,
    modeReason: attempt.modeReason,
    ...(attempt.defId !== undefined ? { defId: attempt.defId } : {}),
    ...(attempt.orderId !== undefined ? { orderId: attempt.orderId } : {}),
    ...(attempt.runId !== undefined ? { runId: attempt.runId } : {}),
    status: attempt.status,
    attempts: attempt.attempts,
    ownerId: attempt.ownerId,
    ...(attempt.approvalId !== undefined ? { approvalId: attempt.approvalId } : {}),
    ...(attempt.verification !== undefined
      ? {
          verification: {
            kind: attempt.verification.kind,
            passed: attempt.verification.passed,
            detail: attempt.verification.detail,
            evidenceEntryIds: [...attempt.verification.evidenceEntryIds],
          },
        }
      : {}),
    ...(attempt.outcome !== undefined ? { outcome: attempt.outcome } : {}),
    ...(attempt.unfinished !== undefined ? { unfinished: [...attempt.unfinished] } : {}),
    createdAt: attempt.createdAt,
    ...(attempt.settledAt !== undefined ? { settledAt: attempt.settledAt } : {}),
  };
}

/** params 全快照载荷（业务 id 恒为 'params'）。 */
export function executorParamsPayload(params: ExecutorParams): JsonObject {
  return {
    maxParallel: params.maxParallel,
    maxRetries: params.maxRetries,
    selectionPolicy: params.selectionPolicy,
    verifyMode: params.verifyMode,
    routerVersion: params.routerVersion,
    revision: params.revision,
  };
}
