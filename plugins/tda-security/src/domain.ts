/**
 * T3.4 安全加固 · domain（J1 验证层：零运行时防御能力，只建用例库/运行记录/发现跟踪）。
 * 四表全 backup-and-skip——验证层非权威：用例可经 fixtures 重建、runs 可经 CI 重跑。
 */
import { z } from 'zod';
import { asCaseId, asFindingId, asRedTeamRunId, defineTdaDomain } from '@tda/kernel';

export const CASE_KINDS = ['injection-memory', 'injection-tool', 'injection-identity', 'penetration'] as const;
export const RUN_KINDS = ['injection-redteam', 'penetration', 'regression', 'matrix-check'] as const;
export const VERDICTS = ['blocked', 'detected-but-leaked', 'breached'] as const;
export const FINDING_STATUS = ['open', 'fixed', 'risk-accepted', 'wont-fix', 'closed'] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

const RedTeamCaseSchema = z.object({
  caseId: z.string().transform(asCaseId),
  kind: z.enum(CASE_KINDS),
  version: z.number().int().min(1),
  supersedes: z.string().optional(),
  title: z.string(),
  /** fixture 只存 hash（J9：正文只在 CI fixture 文件）。 */
  fixture: z.object({ hash: z.string(), entryPoint: z.string() }),
  target: z.object({ spec: z.string(), invariantId: z.string() }),
  expectedVerdict: z.literal('blocked'),
  severityIfBreached: z.enum(SEVERITIES),
  citations: z.array(z.string()),
  createdAt: z.number(),
});

const RedTeamRunSchema = z.object({
  runId: z.string().transform(asRedTeamRunId),
  kind: z.enum(RUN_KINDS),
  at: z.number(),
  status: z.enum(['reported', 'failed']),
  env: z.literal('ci-mock'),
  casesTotal: z.number().int().min(0),
  results: z.array(
    z.object({
      caseId: z.string(),
      caseVersion: z.number(),
      actual: z.enum(VERDICTS),
      findingId: z.string().optional(),
      durationMs: z.number(),
    }),
  ),
  unfinished: z.array(z.string()).optional(),
});

const SecurityFindingSchema = z.object({
  findingId: z.string().transform(asFindingId),
  severity: z.enum(SEVERITIES),
  sourceRunId: z.string(),
  sourceCaseId: z.string(),
  clauseRef: z.string(),
  status: z.enum(FINDING_STATUS),
  fixSpecRef: z.string().optional(),
  regressionRunId: z.string().optional(),
  acceptance: z
    .object({
      reason: z.string(),
      scope: z.string(),
      tokenRef: z.string(),
      reviewAt: z.number(),
    })
    .optional(),
  openedAt: z.number(),
  updatedAt: z.number(),
});

const RedTeamParamsSchema = z.object({
  requiredClauseCoverage: z.boolean(),
  gateBlockingSeverities: z.array(z.enum(SEVERITIES)),
  matrixInstances: z.array(z.string()),
  fixtureRetentionDays: z.number().int().min(1),
  revision: z.number().int().min(0),
});

export type RedTeamCase = z.infer<typeof RedTeamCaseSchema>;
export type RedTeamRun = z.infer<typeof RedTeamRunSchema>;
export type SecurityFinding = z.infer<typeof SecurityFindingSchema>;
export type RedTeamParams = z.infer<typeof RedTeamParamsSchema>;
export type CaseKind = (typeof CASE_KINDS)[number];
export type RunKind = (typeof RUN_KINDS)[number];
export type Verdict = (typeof VERDICTS)[number];
export type Severity = (typeof SEVERITIES)[number];

export const DEFAULT_REDTEAM_PARAMS: RedTeamParams = {
  requiredClauseCoverage: true,
  gateBlockingSeverities: ['critical', 'high'],
  matrixInstances: ['memory', 'knowledge', 'meta-thinking', 'skill', 'workflow'],
  fixtureRetentionDays: 90,
  revision: 0,
};

export const REDTEAM_PARAMS_KEY = 'singleton';
export const REDTEAM_PARAMS_BUSINESS_ID = 'params';
/** §5 五硬条款（对账矩阵行，J5）。 */
export const FIVE_CLAUSES = [
  'S5-1-constraint-pinning',
  'S5-2-write-quarantine',
  'S5-3-credential-provenance',
  'S5-4-control-data-flow-separation',
  'S5-5-audit-baseline',
] as const;

export const securityDomainSpec = defineTdaDomain({
  name: 'tda-security',
  version: 1,
  layout: 'per-record',
  tables: {
    redteam_cases: RedTeamCaseSchema,
    redteam_runs: RedTeamRunSchema,
    security_findings: SecurityFindingSchema,
    redteam_params: RedTeamParamsSchema,
  },
  invalidRecords: 'backup-and-skip',
});

export type SecurityTables = typeof securityDomainSpec.tables;
