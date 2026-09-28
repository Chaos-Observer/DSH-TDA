/**
 * T2.6 插件调研 Agent v1 —— domain（四表，全 backup-and-skip）+ scorer 纯函数。
 *
 * J3：四维评分 = 确定性结构化计分，LLM 只产叙述不改数（评分函数不接收叙述输入）。
 * J7：徽章 = 结构化信号的纯函数，禁 LLM 产出。
 * 评估不是治理资产（J1）：无 lifecycle，不进治理管道。
 */
import { z } from 'zod';
import { asScoutEventId, asScoutRunId, defineTdaDomain } from '@tda/kernel';

export const SCOUT_GRADES = ['S', 'A', 'B', 'C'] as const;
export type ScoutGrade = (typeof SCOUT_GRADES)[number];

export const BADGES = [
  'gold-trust',
  'security-scan-clean',
  'runtime-verified',
  'community-active',
  'docs-complete',
  'smoke-failed',
  'security-veto',
  'stale-data',
  'adoption-candidate',
] as const;
export type Badge = (typeof BADGES)[number];

/** registry 机读快照行（scorer 的唯一输入；J9-② 不接收自由文本/叙述）。 */
export interface RegistryPluginRow {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly downloads?: number;
  readonly stars?: number;
  readonly trustLevel?: 'gold' | 'silver' | 'none';
  readonly docsComplete?: boolean;
  readonly l4InstallVerified?: boolean;
  readonly l5RuntimeVerified?: boolean;
  readonly securityFindings: readonly { readonly severity: 'low' | 'medium' | 'high' | 'critical'; readonly resolved: boolean }[];
}

export const AssessmentSchema = z.object({
  assessmentId: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  version: z.number(),
  supersedes: z.string().optional(),
  scanRunId: z.string(),
  registrySnapshotAt: z.number(),
  dimensions: z.record(
    z.string(),
    z.object({
      score: z.number(),
      signals: z.array(z.object({ key: z.string(), value: z.string(), weight: z.number(), contribution: z.number() })),
    }),
  ),
  composite: z.number(),
  grade: z.enum(SCOUT_GRADES),
  veto: z.object({ kind: z.literal('security'), findings: z.array(z.string()) }).optional(),
  badges: z.array(z.enum(BADGES)),
  smoke: z
    .object({
      installed: z.boolean(),
      loaded: z.boolean(),
      basicCall: z.boolean(),
      passed: z.boolean(),
      scratchRef: z.string(),
      dispatchId: z.string(),
      at: z.number(),
    })
    .optional(),
  narrative: z
    .object({ summary: z.string(), risks: z.array(z.string()), sourcePluginIds: z.array(z.string()) })
    .optional(),
  credentials: z.object({
    structured: z.literal('execution-verified'),
    upstream: z.literal('third-party-registry'),
    narrative: z.literal('model-produced'),
  }),
  assessedAt: z.number(),
});
export type PluginAssessment = z.infer<typeof AssessmentSchema>;

export const RUN_STATUSES = [
  'pending',
  'fetching',
  'assessing',
  'smoke-testing',
  'reporting',
  'completed',
  'partial',
  'failed',
] as const;

export const ScoutRunSchema = z
  .object({
    runId: z.string().transform(asScoutRunId),
    trigger: z.object({ kind: z.enum(['periodic', 'manual']), scope: z.record(z.string(), z.unknown()).optional() }),
    status: z.enum(RUN_STATUSES),
    stage: z.enum(['fetch', 'assess', 'smoke', 'report']).optional(),
    failureReason: z.string().optional(),
    snapshot: z.object({ at: z.number(), pluginCount: z.number(), source: z.enum(['live', 'cache']) }),
    assessed: z.array(z.string()),
    unassessed: z.array(z.object({ pluginId: z.string(), reason: z.string() })),
    reportChunkIds: z.array(z.string()),
    startedAt: z.number(),
    endedAt: z.number().optional(),
  })
  .superRefine((run, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (run.status === 'failed' && (run.stage === undefined || run.failureReason === undefined)) {
      issue('failed run 必带 stage+reason（显式终态，C5）');
    }
  });
export type ScoutRun = z.infer<typeof ScoutRunSchema>;

export const ScoutEventSchema = z.object({
  id: z.string().transform(asScoutEventId),
  runId: z.string(),
  kind: z.enum(['scan-begin', 'snapshot-fetch', 'plugin-assess', 'smoke-result', 'report-write', 'scan-end']),
  pluginId: z.string().optional(),
  detail: z.record(z.string(), z.unknown()),
  at: z.number(),
});
export type ScoutEvent = z.infer<typeof ScoutEventSchema>;

export const ParamsSchema = z
  .object({
    periodMs: z.number(),
    weights: z.object({ engineering: z.number(), compatibility: z.number(), security: z.number(), community: z.number() }),
    gradeThresholds: z.object({ S: z.number(), A: z.number(), B: z.number() }),
    smokeThreshold: z.number(),
    smokeConcurrency: z.number(),
    maxAssessPerScan: z.number(),
    scanBudgetMs: z.number(),
    networkAllowlist: z.array(z.string()),
    snapshotTtlMs: z.number(),
    narrativeTokenCap: z.number(),
    smokeApprovalRequired: z.boolean(),
    revision: z.number(),
  })
  .superRefine((params, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    const sum =
      params.weights.engineering + params.weights.compatibility + params.weights.security + params.weights.community;
    if (Math.abs(sum - 1) > 1e-9) issue(`四维权重和须为 1（收到 ${sum}）`);
    if (params.smokeConcurrency < 1 || params.maxAssessPerScan < 1) issue('吞吐帽须 ≥1（J10）');
  });
export type ScoutParams = z.infer<typeof ParamsSchema>;

export const DEFAULT_PARAMS: ScoutParams = {
  periodMs: 24 * 3600_000,
  weights: { engineering: 0.3, compatibility: 0.25, security: 0.3, community: 0.15 },
  gradeThresholds: { S: 0.85, A: 0.7, B: 0.5 },
  smokeThreshold: 0.7,
  smokeConcurrency: 2,
  maxAssessPerScan: 200,
  scanBudgetMs: 60_000,
  networkAllowlist: ['dsh.so'],
  snapshotTtlMs: 7 * 86_400_000,
  narrativeTokenCap: 300,
  smokeApprovalRequired: false,
  revision: 0,
};

export const SCOUT_PARAMS_KEY = 'singleton';

export type ScoutTables = {
  plugin_assessments: typeof AssessmentSchema;
  plugin_scout_events: typeof ScoutEventSchema;
  plugin_scout_runs: typeof ScoutRunSchema;
  plugin_scout_params: typeof ParamsSchema;
};

export const scoutDomainSpec = defineTdaDomain({
  name: 'tda-plugin-scout',
  version: 1,
  tables: {
    plugin_assessments: AssessmentSchema,
    plugin_scout_events: ScoutEventSchema,
    plugin_scout_runs: ScoutRunSchema,
    plugin_scout_params: ParamsSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});

// ============ scorer 纯函数（J3/J7/J9-③：同 snapshot+同 params ⇒ 同 composite/grade/badges）============

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** 子信号 → 维度分（机读字段映射；缺失信号 = 中性 0.5，U1：缺失≠0 分）。 */
export function scoreDimensions(
  row: RegistryPluginRow,
): Record<'engineering' | 'compatibility' | 'security' | 'community', { score: number; signals: { key: string; value: string; weight: number; contribution: number }[] }> {
  const mk = (key: string, value: number, weight: number) => ({
    key,
    value: String(value),
    weight,
    contribution: clamp01(value) * weight,
  });
  const engineeringSignals = [
    mk('docs-complete', row.docsComplete ? 1 : 0.3, 0.5),
    mk('trust-level', row.trustLevel === 'gold' ? 1 : row.trustLevel === 'silver' ? 0.7 : 0.4, 0.5),
  ];
  const securitySignals = [
    mk('resolved-findings', row.securityFindings.filter((f) => f.resolved).length / Math.max(1, row.securityFindings.length), 0.4),
    mk('unresolved-high-critical', row.securityFindings.some((f) => !f.resolved && (f.severity === 'high' || f.severity === 'critical')) ? 0 : 1, 0.6),
  ];
  const compatSignals = [
    mk('l4-install', row.l4InstallVerified ? 1 : 0.4, 0.5),
    mk('l5-runtime', row.l5RuntimeVerified ? 1 : 0.4, 0.5),
  ];
  const communitySignals = [
    mk('downloads', clamp01((row.downloads ?? 0) / 1000), 0.6),
    mk('stars', clamp01((row.stars ?? 0) / 100), 0.4),
  ];
  const dim = (signals: { contribution: number }[]) =>
    signals.reduce((sum, signal) => sum + signal.contribution, 0);
  return {
    engineering: { score: clamp01(dim(engineeringSignals)), signals: engineeringSignals },
    compatibility: { score: clamp01(dim(compatSignals)), signals: compatSignals },
    security: { score: clamp01(dim(securitySignals)), signals: securitySignals },
    community: { score: clamp01(dim(communitySignals)), signals: communitySignals },
  };
}

/** composite/grade/badges/veto（J9-③ 一票否决无 LLM 判断路径）。 */
export function scorePlugin(
  row: RegistryPluginRow,
  params: ScoutParams,
  opts: { readonly snapshotAt: number; readonly now: number; readonly smokePassed?: boolean | undefined },
): {
  composite: number;
  grade: ScoutGrade;
  badges: Badge[];
  veto?: { kind: 'security'; findings: string[] };
} {
  const dimensions = scoreDimensions(row);
  const w = params.weights;
  const composite =
    w.engineering * dimensions.engineering.score +
    w.compatibility * dimensions.compatibility.score +
    w.security * dimensions.security.score +
    w.community * dimensions.community.score;
  const unresolvedHigh = row.securityFindings.filter(
    (finding) => !finding.resolved && (finding.severity === 'high' || finding.severity === 'critical'),
  );
  const veto =
    unresolvedHigh.length > 0
      ? { kind: 'security' as const, findings: unresolvedHigh.map((finding) => `${finding.severity}`) }
      : undefined;
  const grade: ScoutGrade =
    veto !== undefined
      ? 'C' // 一票否决（J9-③）：composite 照记不隐，grade 强制 C
      : composite >= params.gradeThresholds.S
        ? 'S'
        : composite >= params.gradeThresholds.A
          ? 'A'
          : composite >= params.gradeThresholds.B
            ? 'B'
            : 'C';
  const badges: Badge[] = [];
  if (row.trustLevel === 'gold') badges.push('gold-trust');
  if (row.securityFindings.length > 0 && row.securityFindings.every((finding) => finding.resolved)) badges.push('security-scan-clean');
  if (row.l5RuntimeVerified || opts.smokePassed === true) badges.push('runtime-verified');
  if ((row.downloads ?? 0) >= 500 || (row.stars ?? 0) >= 50) badges.push('community-active');
  if (row.docsComplete === true) badges.push('docs-complete');
  if (opts.smokePassed === false) badges.push('smoke-failed');
  if (veto !== undefined) badges.push('security-veto');
  if (opts.now - opts.snapshotAt > params.snapshotTtlMs) badges.push('stale-data');
  if ((grade === 'S' || grade === 'A') && veto === undefined && opts.smokePassed !== false) badges.push('adoption-candidate');
  return { composite, grade, badges, ...(veto !== undefined ? { veto } : {}) };
}
