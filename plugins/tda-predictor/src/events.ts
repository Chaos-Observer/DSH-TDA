/**
 * tda-predictor 事件载荷（T1.3 §5 审计面）。
 *
 * 族 `predict/change` 承载 **predictions 与 mismatches**（businessId = `pred-<n>` / `mm-<n>`）。
 * `transitions` **不产事件**——它是会话日志的纯投影（幂等重抽即得），给它配事件
 * 就是"投影引发新日志"的自指放大（同 T0.7 `audit_index`）。
 *
 * 为什么 predictions 反而必须产事件：`injected` 取决于 T0.4 的预算裁决，
 * **不在日志里**（外部状态），故"注入过什么预测"无法由 log 重放得出——
 * 事件载荷（全快照）是它唯一的可回放来源。
 *
 * 键序必须与 schema 定义序一致（replay-equivalence 以 JSON.stringify 整体比对）。
 */
import type { JsonObject } from '@tda/kernel';
import type { MismatchRecord, Prediction } from './domain.ts';

export function predictionPayload(prediction: Prediction): JsonObject {
  return {
    id: String(prediction.id),
    sessionId: prediction.sessionId,
    round: prediction.round,
    context: {
      ...(prediction.context.taskId !== undefined ? { taskId: prediction.context.taskId } : {}),
      stage: prediction.context.stage,
      recentActions: [...prediction.context.recentActions],
    },
    nextAction: prediction.nextAction,
    outcomeDist: {
      success: prediction.outcomeDist.success,
      failure: prediction.outcomeDist.failure,
      partial: prediction.outcomeDist.partial,
    },
    riskFlags: prediction.riskFlags.map((flag) => ({ errorClass: flag.errorClass, freq: flag.freq })),
    confidence: prediction.confidence,
    theta: prediction.theta,
    injected: prediction.injected,
    similarTransitionIds: [...prediction.similarTransitionIds],
    at: prediction.at,
  };
}

export function mismatchPayload(mismatch: MismatchRecord): JsonObject {
  return {
    id: String(mismatch.id),
    predictionId: mismatch.predictionId,
    actual: {
      action: mismatch.actual.action,
      outcomeStatus: mismatch.actual.outcomeStatus,
      ...(mismatch.actual.errorClass !== undefined ? { errorClass: mismatch.actual.errorClass } : {}),
    },
    deltaKind: mismatch.deltaKind,
    at: mismatch.at,
  };
}
