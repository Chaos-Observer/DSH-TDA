/**
 * tda-plugin-scout 事件载荷（族 `pluginScout/change`，第八扩展族）。
 */
import type { JsonObject } from '@tda/kernel';
import type { PluginAssessment, ScoutParams, ScoutRun } from './domain.ts';

export const SCOUT_ASSESSMENT_BUSINESS_PREFIX = 'scout-assessment';
export const SCOUT_RUN_BUSINESS_PREFIX = 'scout-run';
export const SCOUT_PARAMS_BUSINESS_ID = 'params';

export function scoutAssessmentPayload(assessment: PluginAssessment): JsonObject {
  return {
    assessmentId: assessment.assessmentId,
    pluginId: assessment.pluginId,
    version: assessment.version,
    ...(assessment.supersedes !== undefined ? { supersedes: assessment.supersedes } : {}),
    grade: assessment.grade,
    composite: assessment.composite,
    badges: [...assessment.badges],
    ...(assessment.veto !== undefined ? { veto: { ...assessment.veto } } : {}),
    ...(assessment.smoke !== undefined ? { smokePassed: assessment.smoke.passed } : {}),
    assessedAt: assessment.assessedAt,
  };
}

export function scoutRunPayload(run: ScoutRun): JsonObject {
  return {
    runId: String(run.runId),
    trigger: { ...run.trigger } as { kind: string; scope?: Record<string, string | number | boolean | null> },
    status: run.status,
    ...(run.stage !== undefined ? { stage: run.stage } : {}),
    ...(run.failureReason !== undefined ? { failureReason: run.failureReason } : {}),
    snapshot: { ...run.snapshot },
    assessed: [...run.assessed],
    unassessed: run.unassessed.map((item) => ({ ...item })),
    reportChunkIds: [...run.reportChunkIds],
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
  };
}

export function scoutParamsPayload(params: ScoutParams): JsonObject {
  return {
    periodMs: params.periodMs,
    weights: { ...params.weights },
    gradeThresholds: { ...params.gradeThresholds },
    smokeThreshold: params.smokeThreshold,
    smokeConcurrency: params.smokeConcurrency,
    maxAssessPerScan: params.maxAssessPerScan,
    scanBudgetMs: params.scanBudgetMs,
    networkAllowlist: [...params.networkAllowlist],
    snapshotTtlMs: params.snapshotTtlMs,
    narrativeTokenCap: params.narrativeTokenCap,
    smokeApprovalRequired: params.smokeApprovalRequired,
    revision: params.revision,
  };
}
