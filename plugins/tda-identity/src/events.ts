/** T3.3 · events（identity/change 第十九事件族）。键序对齐 schema 定义序。 */
import type { IdentityManifest, IdentityParams, MigrationRecord, SnapshotRecord } from './domain.ts';
import type { JsonObject } from '@tda/kernel';

export const MANIFEST_BUSINESS_PREFIX = 'identity-manifest';
export const MIGRATION_BUSINESS_PREFIX = 'identity-migration';
export const SNAPSHOT_BUSINESS_PREFIX = 'identity-snapshot';

export function manifestPayload(manifest: IdentityManifest): JsonObject {
  return {
    manifestId: manifest.manifestId,
    identityId: String(manifest.identityId),
    version: manifest.version,
    ...(manifest.supersedes !== undefined ? { supersedes: manifest.supersedes } : {}),
    ...(manifest.userBinding !== undefined
      ? { userBinding: { userId: manifest.userBinding.userId, since: manifest.userBinding.since } }
      : {}),
    components: {
      strategies: manifest.components.strategies.map((item) => ({ ref: item.ref, status: item.status, profiles: [...item.profiles] })),
      metaPaths: manifest.components.metaPaths.map((item) => ({ ref: item.ref, status: item.status, profiles: [...item.profiles] })),
      calibrations: manifest.components.calibrations.map((item) => ({ from: item.from, to: item.to, ref: item.ref })),
    },
    activeModelProfile: manifest.activeModelProfile,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

export function migrationPayload(record: MigrationRecord): JsonObject {
  return {
    migrationId: String(record.migrationId),
    direction: record.direction,
    ...(record.fromProfile !== undefined ? { fromProfile: record.fromProfile } : {}),
    ...(record.toProfile !== undefined ? { toProfile: record.toProfile } : {}),
    trigger: record.trigger,
    verdicts: record.verdicts.map((verdict) => ({
      ref: verdict.ref,
      kind: verdict.kind,
      verdict: verdict.verdict,
      ...(verdict.rehearsalId !== undefined ? { rehearsalId: verdict.rehearsalId } : {}),
      ...(verdict.coverage !== undefined ? { coverage: verdict.coverage } : {}),
      ...(verdict.languageDependent !== undefined ? { languageDependent: verdict.languageDependent } : {}),
    })),
    ...(record.humanTokenRef !== undefined ? { humanTokenRef: record.humanTokenRef } : {}),
    at: record.at,
  };
}

export function snapshotPayload(record: SnapshotRecord): JsonObject {
  return {
    snapshotId: String(record.snapshotId),
    manifestVersion: record.manifestVersion,
    contentHash: record.contentHash,
    ...(record.prevHash !== undefined ? { prevHash: record.prevHash } : {}),
    exportedAt: record.exportedAt,
  };
}

export function paramsPayload(params: IdentityParams): JsonObject {
  return {
    minVerifiedProfiles: params.minVerifiedProfiles,
    degradedCoverageMargin: params.degradedCoverageMargin,
    migrationConcurrency: params.migrationConcurrency,
    snapshotFormatVersion: params.snapshotFormatVersion,
    languageDependentRequiresVerified: params.languageDependentRequiresVerified,
    revision: params.revision,
  };
}
