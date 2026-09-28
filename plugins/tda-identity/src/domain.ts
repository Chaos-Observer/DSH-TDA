/**
 * T3.3 跨模型身份持久化 · domain（四表全 backup-and-skip——身份全派生：
 * manifests 可经组件域+migrations 重建；migrations/snapshots 与会话日志双写可重放）。
 */
import { z } from 'zod';
import { asIdentityId, asMigrationId, asSnapshotId, defineTdaDomain } from '@tda/kernel';

export const COMPONENT_KINDS = ['strategy', 'meta-path', 'calibration'] as const;
export const COMPONENT_STATUS = ['verified', 'degraded'] as const;
export const VERDICTS = ['verified', 'degraded', 'failed'] as const;

const IdentityManifestSchema = z.object({
  manifestId: z.string(),
  identityId: z.string().transform(asIdentityId),
  version: z.number().int().min(1),
  supersedes: z.string().optional(),
  userBinding: z.object({ userId: z.string(), since: z.number() }).optional(),
  components: z.object({
    strategies: z.array(z.object({ ref: z.string(), status: z.enum(COMPONENT_STATUS), profiles: z.array(z.string()) })),
    metaPaths: z.array(z.object({ ref: z.string(), status: z.enum(COMPONENT_STATUS), profiles: z.array(z.string()) })),
    calibrations: z.array(z.object({ from: z.number(), to: z.number(), ref: z.string() })),
  }),
  activeModelProfile: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const MigrationRecordSchema = z.object({
  migrationId: z.string().transform(asMigrationId),
  direction: z.enum(['export', 'import', 'migrate']),
  fromProfile: z.string().optional(),
  toProfile: z.string().optional(),
  trigger: z.enum(['model-swap', 'model-upgrade', 'manual']),
  verdicts: z.array(
    z.object({
      ref: z.string(),
      kind: z.enum(COMPONENT_KINDS),
      verdict: z.enum(VERDICTS),
      rehearsalId: z.string().optional(),
      coverage: z.number().optional(),
      languageDependent: z.boolean().optional(),
    }),
  ),
  /** T3.2 审批 id（import/migrate 必填，不变量 4）。 */
  humanTokenRef: z.string().optional(),
  at: z.number(),
});

const SnapshotRecordSchema = z.object({
  snapshotId: z.string().transform(asSnapshotId),
  manifestVersion: z.number().int().min(1),
  contentHash: z.string(),
  prevHash: z.string().optional(),
  exportedAt: z.number(),
});

const IdentityParamsSchema = z.object({
  minVerifiedProfiles: z.number().int().min(1),
  degradedCoverageMargin: z.number().min(0).max(1),
  migrationConcurrency: z.number().int().min(1),
  snapshotFormatVersion: z.number().int().min(1),
  languageDependentRequiresVerified: z.boolean(),
  revision: z.number().int().min(0),
});

export type IdentityManifest = z.infer<typeof IdentityManifestSchema>;
export type MigrationRecord = z.infer<typeof MigrationRecordSchema>;
export type SnapshotRecord = z.infer<typeof SnapshotRecordSchema>;
export type IdentityParams = z.infer<typeof IdentityParamsSchema>;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];
export type ComponentStatus = (typeof COMPONENT_STATUS)[number];
export type Verdict = (typeof VERDICTS)[number];

/** 线上传输格式（J7：禁模型特定字段 + 禁自然语言规则体——结构化是迁移性前提）。 */
export interface IdentitySnapshot {
  readonly formatVersion: 1;
  readonly identityId: string;
  readonly manifestVersion: number;
  readonly strategies: readonly { readonly candidateId: string; readonly condition: Record<string, unknown>; readonly rule: Record<string, unknown>; readonly evidence: readonly string[] }[];
  readonly metaPaths: readonly { readonly id: string; readonly topology: Record<string, unknown>; readonly mode: string; readonly applicability: Record<string, unknown> }[];
  readonly calibrationRefs: readonly { readonly from: number; readonly to: number; readonly ref: string }[];
  readonly contentHash: string;
}

export const DEFAULT_IDENTITY_PARAMS: IdentityParams = {
  minVerifiedProfiles: 2,
  degradedCoverageMargin: 0.1,
  migrationConcurrency: 2,
  snapshotFormatVersion: 1,
  languageDependentRequiresVerified: true,
  revision: 0,
};

export const IDENTITY_ID = 'idn-1' as const;
export const IDENTITY_PARAMS_KEY = 'singleton';
export const IDENTITY_PARAMS_BUSINESS_ID = 'params';

export const identityDomainSpec = defineTdaDomain({
  name: 'tda-identity',
  version: 1,
  layout: 'per-record',
  tables: {
    identity_manifests: IdentityManifestSchema,
    identity_migrations: MigrationRecordSchema,
    identity_snapshots: SnapshotRecordSchema,
    identity_params: IdentityParamsSchema,
  },
  invalidRecords: 'backup-and-skip',
});

export type IdentityTables = typeof identityDomainSpec.tables;

/** canonicalJson：键序无关的结构化哈希基底（fork 前缀比对同款纪律）。 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};
