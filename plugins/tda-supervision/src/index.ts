/** tda-supervision 出口：ctx.supervision 服务 + domain 规格 + 不变量注册（T3.2）。 */
export { createSupervisionService } from './service.ts';
export type {
  SupervisionService,
  SupervisionDeps,
  ApprovalRequestInput,
  ResumeTicket,
  DigestView,
  AttentionStatus,
  DashboardView,
} from './service.ts';
export { supervisionDomainSpec } from './domain.ts';
export type {
  SupervisionTables,
  ApprovalRequest,
  SupervisionEvent,
  AttentionCharge,
  SupervisionParams,
  ApprovalKind,
  RiskLevel,
} from './domain.ts';
export {
  DEFAULT_SUPERVISION_PARAMS,
  APPROVAL_KINDS,
  RISK_LEVELS,
  APPROVAL_STATUS,
} from './domain.ts';
export {
  approvalPayload,
  eventPayload,
  chargePayload,
  supervisionParamsPayload,
  APPROVAL_BUSINESS_PREFIX,
  EVENT_BUSINESS_PREFIX,
  CHARGE_BUSINESS_PREFIX,
} from './events.ts';
export { supervisionInvariantChecks, registerSupervisionInvariants, type SupervisionReadFace } from './loadChecks.ts';
