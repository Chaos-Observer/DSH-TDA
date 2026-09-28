/** T3.2 · events（supervision/change 第十八事件族）。键序对齐 schema 定义序（compareReplay 纪律）。 */
import type { ApprovalRequest, AttentionCharge, SupervisionEvent, SupervisionParams } from './domain.ts';
import type { JsonObject } from '@tda/kernel';

export const APPROVAL_BUSINESS_PREFIX = 'approval';
export const EVENT_BUSINESS_PREFIX = 'supervision-event';
export const CHARGE_BUSINESS_PREFIX = 'attention';

export function approvalPayload(approval: ApprovalRequest): JsonObject {
  return {
    approvalId: String(approval.approvalId),
    kind: approval.kind,
    riskLevel: approval.riskLevel,
    requester: { service: approval.requester.service, ref: approval.requester.ref },
    subject: approval.subject,
    whatToShow: {
      summary: approval.whatToShow.summary,
      impact: approval.whatToShow.impact.map((impact) => ({
        target: impact.target,
        change: impact.change,
        reversible: impact.reversible,
      })),
      riskReasons: [...approval.whatToShow.riskReasons],
      evidence: approval.whatToShow.evidence.map((item) => ({ kind: item.kind, ref: item.ref })),
      ...(approval.whatToShow.excerpts !== undefined
        ? { excerpts: approval.whatToShow.excerpts.map((item) => ({ ref: item.ref, text: item.text })) }
        : {}),
      ...(approval.whatToShow.critiques !== undefined ? { critiques: [...approval.whatToShow.critiques] } : {}),
      ...(approval.whatToShow.alternatives !== undefined
        ? { alternatives: approval.whatToShow.alternatives.map((item) => ({ label: item.label, tradeoff: item.tradeoff })) }
        : {}),
    },
    resume: { from: approval.resume.from, handle: approval.resume.handle },
    status: approval.status,
    token: {
      nonce: approval.token.nonce,
      issuedAt: approval.token.issuedAt,
      expiresAt: approval.token.expiresAt,
      ...(approval.token.consumedAt !== undefined ? { consumedAt: approval.token.consumedAt } : {}),
    },
    ...(approval.resolution !== undefined
      ? {
          resolution: {
            decision: approval.resolution.decision,
            by: approval.resolution.by,
            ...(approval.resolution.note !== undefined ? { note: approval.resolution.note } : {}),
            at: approval.resolution.at,
            tokenNonce: approval.resolution.tokenNonce,
          },
        }
      : {}),
    attention: {
      units: approval.attention.units,
      chargedAt: approval.attention.chargedAt,
      ...(approval.attention.respondedAt !== undefined ? { respondedAt: approval.attention.respondedAt } : {}),
    },
    ...(approval.taskId !== undefined ? { taskId: approval.taskId } : {}),
    ...(approval.goalId !== undefined ? { goalId: approval.goalId } : {}),
    ...(approval.statusReason !== undefined ? { statusReason: approval.statusReason } : {}),
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
  };
}

export function eventPayload(event: SupervisionEvent): JsonObject {
  return {
    eventId: event.eventId,
    kind: event.kind,
    ...(event.approvalId !== undefined ? { approvalId: event.approvalId } : {}),
    detail: event.detail as never,
    at: event.at,
  };
}

export function chargePayload(charge: AttentionCharge): JsonObject {
  return {
    chargeId: String(charge.chargeId),
    ...(charge.approvalId !== undefined ? { approvalId: charge.approvalId } : {}),
    kind: charge.kind,
    units: charge.units,
    ...(charge.taskId !== undefined ? { taskId: charge.taskId } : {}),
    ...(charge.goalId !== undefined ? { goalId: charge.goalId } : {}),
    at: charge.at,
  };
}

export function supervisionParamsPayload(params: SupervisionParams): JsonObject {
  return {
    autonomyLevel: params.autonomyLevel,
    riskTable: { ...params.riskTable },
    baseUnits: { low: params.baseUnits.low, medium: params.baseUnits.medium, high: params.baseUnits.high },
    volumeFactorCap: params.volumeFactorCap,
    tokenTtlHours: params.tokenTtlHours,
    zoneThresholds: { pressure: params.zoneThresholds.pressure },
    attentionQuotaUnits: params.attentionQuotaUnits,
    maxDigestItems: params.maxDigestItems,
    digestWindowHours: params.digestWindowHours,
    maxExcerpts: params.maxExcerpts,
    requestRateLimitPerHour: params.requestRateLimitPerHour,
    revision: params.revision,
  };
}
