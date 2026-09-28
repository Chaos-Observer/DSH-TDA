/**
 * T3.2 人机监督 · domain（§3）。
 *
 * - approval_requests：**人类决策权威**（缺省 reject 打开策略——人类决定丢失=审计断裂，
 *   G3-② 不可静默跳过；内核 'reject' 即规格的 reject-open）。
 * - supervision_events：事件权威（log-only session event supervision/change 第十八族的双写域形态）。
 * - attention_ledger：append-only 旁路（同 recall_log 模式，units 确定性可复算）。
 * - supervision_params：参数权威。
 */
import { z } from 'zod';
import { asApprovalId, asAttentionId, defineTdaDomain } from '@tda/kernel';

export const APPROVAL_KINDS = [
  'task-proposal',
  'dispatch',
  'governance',
  'coach-submit',
  'maintenance',
  'workflow-node',
  'adoption-candidate',
  'identity-migration',
  'risk-acceptance',
] as const;
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const APPROVAL_STATUS = ['pending', 'approved', 'rejected', 'cancelled'] as const;

const ImpactSchema = z.object({
  target: z.string(),
  change: z.enum(['create', 'update', 'invalidate', 'execute']),
  reversible: z.boolean(),
});

const ApprovalRequestSchema = z.object({
  approvalId: z.string().transform(asApprovalId),
  kind: z.enum(APPROVAL_KINDS),
  /** J2：规则表查定（禁调用方自定高档绕过）。 */
  riskLevel: z.enum(RISK_LEVELS),
  requester: z.object({ service: z.string(), ref: z.string() }),
  /** ≤120 字符一句话（禁正文）。 */
  subject: z.string().min(1).max(120),
  whatToShow: z.object({
    summary: z.string().min(1).max(200),
    impact: z.array(ImpactSchema),
    riskReasons: z.array(z.string()),
    evidence: z.array(z.object({ kind: z.string(), ref: z.string() })),
    /** 必要原文片段 ≤3×500 字符（人类呈现+审计重建，J6；不进任何注入路径，不变量 10）。 */
    excerpts: z
      .array(z.object({ ref: z.string(), text: z.string().max(500) }))
      .max(3)
      .optional(),
    critiques: z.array(z.string()).max(3).optional(),
    alternatives: z.array(z.object({ label: z.string(), tradeoff: z.string() })).optional(),
  }),
  /** 恢复句柄（J5：监督服务只发票不代跑）。 */
  resume: z.object({ from: z.string(), handle: z.string() }),
  status: z.enum(APPROVAL_STATUS),
  /** 当前有效 token（单签；J4 一次性）。 */
  token: z.object({
    nonce: z.string(),
    issuedAt: z.number(),
    expiresAt: z.number(),
    consumedAt: z.number().optional(),
  }),
  resolution: z
    .object({
      decision: z.enum(['approve', 'reject']),
      by: z.literal('human'),
      note: z.string().optional(),
      at: z.number(),
      tokenNonce: z.string(),
    })
    .optional(),
  /** J7：digest 项 chargedAt=flush 时（未读不计费）。 */
  attention: z.object({ units: z.number(), chargedAt: z.number(), respondedAt: z.number().optional() }),
  /** 计费落点：taskId/goalId 至少其一（不变量 7）。 */
  taskId: z.string().optional(),
  goalId: z.string().optional(),
  statusReason: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const SupervisionEventSchema = z.object({
  eventId: z.string(),
  kind: z.enum([
    'requested',
    'token-issued',
    'token-expired',
    'approved',
    'rejected',
    'cancelled',
    'attention-charged',
    'digest-flushed',
    'digest-vetoed',
    'params-changed',
  ]),
  approvalId: z.string().optional(),
  detail: z.unknown(),
  at: z.number(),
});

const AttentionChargeSchema = z.object({
  chargeId: z.string().transform(asAttentionId),
  approvalId: z.string().optional(),
  kind: z.enum(['approval', 'digest', 'escalation']),
  units: z.number().min(0),
  taskId: z.string().optional(),
  goalId: z.string().optional(),
  at: z.number(),
});

const SupervisionParamsSchema = z.object({
  autonomyLevel: z.enum(['full-auto', 'high-risk-only', 'full-approval']),
  /** 动作类型→档位（结构化规则表，可配；元规则：不可逆动作最低 high，服务端断言）。 */
  riskTable: z.record(z.string(), z.enum(RISK_LEVELS)),
  baseUnits: z.object({ low: z.number().min(0), medium: z.number().min(0), high: z.number().min(0) }),
  volumeFactorCap: z.number().min(1),
  tokenTtlHours: z.number().min(0.001),
  zoneThresholds: z.object({ pressure: z.number().min(0).max(1) }),
  /** 注意力预算分母（T0.2 J6 三区的分母；v1 扩展参数）。 */
  attentionQuotaUnits: z.number().min(1),
  maxDigestItems: z.number().min(1),
  digestWindowHours: z.number().min(0.001),
  maxExcerpts: z.number().min(0).max(3),
  requestRateLimitPerHour: z.number().min(1),
  revision: z.number().int().min(0),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type SupervisionEvent = z.infer<typeof SupervisionEventSchema>;
export type AttentionCharge = z.infer<typeof AttentionChargeSchema>;
export type SupervisionParams = z.infer<typeof SupervisionParamsSchema>;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const DEFAULT_SUPERVISION_PARAMS: SupervisionParams = {
  autonomyLevel: 'high-risk-only',
  riskTable: {
    'task-proposal': 'high',
    dispatch: 'high',
    governance: 'high',
    'coach-submit': 'high',
    maintenance: 'medium',
    'workflow-node': 'medium',
    'adoption-candidate': 'low',
    'identity-migration': 'high',
    'risk-acceptance': 'high',
  },
  baseUnits: { low: 1, medium: 3, high: 5 },
  volumeFactorCap: 3,
  tokenTtlHours: 24,
  zoneThresholds: { pressure: 0.8 },
  attentionQuotaUnits: 100,
  maxDigestItems: 20,
  digestWindowHours: 24,
  maxExcerpts: 3,
  requestRateLimitPerHour: 50,
  revision: 0,
};

export const SUPERVISION_PARAMS_KEY = 'singleton';
export const SUPERVISION_PARAMS_BUSINESS_ID = 'params';

export const supervisionDomainSpec = defineTdaDomain({
  name: 'tda-supervision',
  version: 1,
  // per-record：approval_requests 键=approvalId，events 键=eventId，ledger 键=chargeId。
  layout: 'per-record',
  tables: {
    approval_requests: ApprovalRequestSchema,
    supervision_events: SupervisionEventSchema,
    attention_ledger: AttentionChargeSchema,
    supervision_params: SupervisionParamsSchema,
  },
  // 内核 invalidRecords 是 domain 级粒度（不分支配表）：取最严的 reject——
  // 人类决策权威损坏即整域拒开（G3-② 审计断裂不可静默跳过；events/ledger 可经会话日志重放重建）。
  invalidRecords: 'reject',
});

export type SupervisionTables = typeof supervisionDomainSpec.tables;
