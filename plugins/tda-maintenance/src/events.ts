/**
 * tda-maintenance 事件载荷（T2.3 不变量 9 审计面）。
 * 族 `maintenance/change`：业务 id = `maintenance-proposal:<id>` / `maintenance-action:<id>` /
 * `maintenance-report:<id>` / `params`。
 */
import type { JsonObject } from '@tda/kernel';
import type { MaintenanceAction, MaintenanceParams, MaintenanceProposal, MaintenanceReport } from './domain.ts';

export const MAINTENANCE_PROPOSAL_BUSINESS_PREFIX = 'maintenance-proposal';
export const MAINTENANCE_ACTION_BUSINESS_PREFIX = 'maintenance-action';
export const MAINTENANCE_REPORT_BUSINESS_PREFIX = 'maintenance-report';
export const MAINTENANCE_PARAMS_BUSINESS_ID = 'params';

export function maintenanceProposalPayload(proposal: MaintenanceProposal, action: string): JsonObject {
  return {
    action,
    id: String(proposal.id),
    kind: proposal.kind,
    assetKind: proposal.assetKind,
    assetId: proposal.assetId,
    primitive: proposal.action.primitive,
    reason: { ...proposal.action.reason },
    signals: { ...proposal.signals, thresholds: { ...proposal.signals.thresholds } },
    risk: proposal.risk,
    status: proposal.status,
    ...(proposal.govActionId !== undefined ? { govActionId: proposal.govActionId } : {}),
    ...(proposal.resolvedAt !== undefined ? { resolvedAt: proposal.resolvedAt } : {}),
    at: proposal.resolvedAt ?? proposal.createdAt,
  };
}

export function maintenanceActionPayload(action: MaintenanceAction): JsonObject {
  return {
    id: String(action.id),
    proposalId: action.proposalId,
    op: action.op,
    actor: { ...action.actor },
    ...(action.approvalToken !== undefined ? { approvalToken: action.approvalToken } : {}),
    ...(action.result !== undefined ? { result: action.result } : {}),
    at: action.at,
  };
}

export function maintenanceReportPayload(report: MaintenanceReport): JsonObject {
  return {
    id: String(report.id),
    trigger: { ...report.trigger },
    stats: { ...report.stats },
    capacity: { ...report.capacity },
    proposalIds: [...report.proposalIds],
    ...(report.unfinished !== undefined ? { unfinished: [...report.unfinished] } : {}),
    at: report.at,
  };
}

export function maintenanceParamsPayload(params: MaintenanceParams): JsonObject {
  return {
    cycleMs: params.cycleMs,
    caps: { ...params.caps },
    promoteThresholds: { ...params.promoteThresholds },
    scoreWeights: { ...params.scoreWeights },
    capacityCaps: { ...params.capacityCaps },
    demotePriority: [...params.demotePriority],
    revision: params.revision,
  };
}
