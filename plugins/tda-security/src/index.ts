/** tda-security 出口：ctx.security 服务 + domain 规格（T3.4 验证层）。 */
export { createSecurityService } from './service.ts';
export { SEED_CASES, seedRows, type SeedCase } from './cases.ts';
export type { SecurityService, SecurityDeps, RedTeamExecutor } from './service.ts';
export { securityDomainSpec, FIVE_CLAUSES } from './domain.ts';
export type {
  SecurityTables,
  RedTeamCase,
  RedTeamRun,
  SecurityFinding,
  RedTeamParams,
  CaseKind,
  RunKind,
  Verdict,
  Severity,
} from './domain.ts';
export { DEFAULT_REDTEAM_PARAMS, CASE_KINDS, RUN_KINDS, VERDICTS, FINDING_STATUS, SEVERITIES } from './domain.ts';
export {
  casePayload,
  runPayload,
  findingPayload,
  paramsPayload,
  CASE_BUSINESS_PREFIX,
  RUN_BUSINESS_PREFIX,
  FINDING_BUSINESS_PREFIX,
} from './events.ts';
