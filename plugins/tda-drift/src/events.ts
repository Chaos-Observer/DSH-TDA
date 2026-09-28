/**
 * tda-drift 事件载荷（T1.5 §5 审计面）。
 *
 * 族 `drift/calibrate` 承载两类：**校准记录**（businessId = `calibration:<n>`，
 * 由 goal-state 的 `recordCalibration` seam 在写 calibrations 时发出——权威证据在
 * T0.1 domain）与**参数变更**（businessId='params'）。快照不产事件（纯函数可重算）。
 */
import type { JsonObject } from '@tda/kernel';
import type { DriftParams } from './domain.ts';

export const CALIBRATION_BUSINESS_PREFIX = 'calibration';

export function calibrationPayload(entry: {
  readonly seq: number;
  readonly goalId: string;
  readonly driftType: string;
  readonly action: string;
  readonly detail: string;
  readonly at: number;
}): JsonObject {
  return {
    seq: entry.seq,
    goalId: entry.goalId,
    driftType: entry.driftType,
    action: entry.action,
    detail: entry.detail,
    at: entry.at,
  };
}

export function driftParamsPayload(params: DriftParams): JsonObject {
  return {
    weights: { ...params.weights },
    windowMs: params.windowMs,
    baselineWindows: params.baselineWindows,
    thresholds: { watch: params.thresholds.watch, drift: params.thresholds.drift },
    perMetricThreshold: params.perMetricThreshold,
    hysteresisWindows: params.hysteresisWindows,
    revision: params.revision,
  };
}
