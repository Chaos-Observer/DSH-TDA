/**
 * tda-coach 事件载荷（T2.1 §4.1 不变量 9 审计面）。
 *
 * 族 `coach/change`：review/candidate 全动作（业务 id = `review:<id>` / `candidate:<id>` /
 * `params`）。载荷 = 全快照或状态增量，JSON 无损。
 */
import type { JsonObject } from '@tda/kernel';
import type { CoachCandidate, CoachParams, CoachReview } from './domain.ts';

export const COACH_REVIEW_BUSINESS_PREFIX = 'review';
export const COACH_CANDIDATE_BUSINESS_PREFIX = 'candidate';
export const COACH_PARAMS_BUSINESS_ID = 'params';

export function coachReviewPayload(review: CoachReview): JsonObject {
  return {
    id: String(review.id),
    trigger: { kind: review.trigger.kind, at: review.trigger.at },
    window: { ...review.window },
    status: review.status,
    stats: { ...review.stats },
    patterns: review.patterns.length,
    candidateIds: [...review.candidateIds],
    govActionRefs: [...review.govActionRefs],
    ...(review.unfinished !== undefined ? { unfinished: [...review.unfinished] } : {}),
    at: review.at,
  };
}

export function coachCandidatePayload(candidate: CoachCandidate, action: string): JsonObject {
  return {
    action,
    id: String(candidate.id),
    kind: candidate.kind,
    risk: candidate.risk,
    status: candidate.status,
    confidence: candidate.confidence,
    evidenceCount: candidate.evidence.mismatchIds.length,
    ...(candidate.draftRef !== undefined ? { draftRef: { ...candidate.draftRef } } : {}),
    ...(candidate.transfer !== undefined
      ? { transfer: { verified: candidate.transfer.verified, modelProfiles: [...candidate.transfer.modelProfiles] } }
      : {}),
    reviewId: candidate.reviewId,
    at: candidate.updatedAt,
  };
}

export function coachParamsPayload(params: CoachParams): JsonObject {
  return {
    periodMs: params.periodMs,
    surgeThreshold: params.surgeThreshold,
    surgeWindowMs: params.surgeWindowMs,
    maxMismatchScan: params.maxMismatchScan,
    maxCandidatesPerReview: params.maxCandidatesPerReview,
    maxRehearsalConcurrent: params.maxRehearsalConcurrent,
    reviewBudgetMs: params.reviewBudgetMs,
    minEvidenceCount: params.minEvidenceCount,
    minConfidence: params.minConfidence,
    yieldPollMs: params.yieldPollMs,
    yieldTimeoutMs: params.yieldTimeoutMs,
    revision: params.revision,
  };
}
