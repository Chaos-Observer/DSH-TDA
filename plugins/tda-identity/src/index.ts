/** tda-identity 出口：ctx.identity 服务 + domain 规格 + 不变量注册（T3.3）。 */
export { createIdentityService } from './service.ts';
export type { IdentityService, IdentityDeps, IdentityRehearsalSeam, ImportResult, ComponentView } from './service.ts';
export { identityDomainSpec, canonicalJson } from './domain.ts';
export type {
  IdentityTables,
  IdentityManifest,
  MigrationRecord,
  SnapshotRecord,
  IdentityParams,
  IdentitySnapshot,
  ComponentKind,
  ComponentStatus,
  Verdict,
} from './domain.ts';
export { DEFAULT_IDENTITY_PARAMS, COMPONENT_KINDS, COMPONENT_STATUS, VERDICTS } from './domain.ts';
export {
  manifestPayload,
  migrationPayload,
  snapshotPayload,
  paramsPayload,
  MANIFEST_BUSINESS_PREFIX,
  MIGRATION_BUSINESS_PREFIX,
  SNAPSHOT_BUSINESS_PREFIX,
} from './events.ts';
export { identityInvariantChecks, registerIdentityInvariants, type IdentityReadFace } from './loadChecks.ts';
