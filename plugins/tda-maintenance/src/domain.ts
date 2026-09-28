/**
 * T2.3 资产更新维护闭环 v1 —— domain（四表，全 backup-and-skip）。
 * 编排记录可经 session log + 治理日志 + 信号表重建（J10）——丢了不阻断系统。
 */
import { z } from 'zod';
import { asMaintenanceActionId, asMaintenanceProposalId, asMaintenanceReportId, defineTdaDomain } from '@tda/kernel';

export const MAINTENANCE_KINDS = ['promote', 'demote', 'coordinate'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export const MAINTENANCE_ASSET_KINDS = ['memory', 'meta-thinking', 'skill'] as const;
export type MaintenanceAssetKind = (typeof MAINTENANCE_ASSET_KINDS)[number];

export const MAINTENANCE_PRIMITIVES = ['consolidate', 'retire', 'restore', 'propose-invalidate', 'supersede'] as const;
export type MaintenancePrimitive = (typeof MAINTENANCE_PRIMITIVES)[number];

export const MAINTENANCE_PROPOSAL_STATUSES = ['queued', 'approved', 'executed', 'rejected', 'expired'] as const;
export type MaintenanceProposalStatus = (typeof MAINTENANCE_PROPOSAL_STATUSES)[number];

/** 高风险三类（J8）：容量强制淘汰 / invalidate 提议 / 冲突合并。 */
export const HIGH_RISK_REASONS = ['capacity', 'invalidate', 'conflict-merge'] as const;

export const ProposalSchema = z
  .object({
    id: z.string().transform(asMaintenanceProposalId),
    kind: z.enum(MAINTENANCE_KINDS),
    assetKind: z.enum(MAINTENANCE_ASSET_KINDS),
    assetId: z.string(),
    action: z.object({
      primitive: z.enum(MAINTENANCE_PRIMITIVES),
      reason: z.object({ kind: z.string(), detail: z.string() }),
    }),
    /** 三信号数值 + 当时阈值快照（不变量 3：升格可解释，缺一拒绝生成）。 */
    signals: z.object({
      reuseCount: z.number(),
      verifyCount: z.number(),
      associationSpread: z.number(),
      thresholds: z.object({ reuse: z.number(), verify: z.number(), association: z.number() }),
    }),
    risk: z.enum(['low', 'high']),
    status: z.enum(MAINTENANCE_PROPOSAL_STATUSES),
    govActionId: z.string().optional(),
    source: z.object({ kind: z.enum(['scan', 'coach']), ref: z.string().optional() }),
    createdAt: z.number(),
    resolvedAt: z.number().optional(),
  })
  .superRefine((proposal, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (proposal.status === 'executed' && proposal.govActionId === undefined) {
      issue('executed 提议必回填 govActionId（不变量 1：编排非权威，无第二写路径）');
    }
    if (proposal.status === 'executed' && proposal.resolvedAt === undefined) {
      issue('executed 提议必带 resolvedAt');
    }
  });
export type MaintenanceProposal = z.infer<typeof ProposalSchema>;

export const ActionSchema = z.object({
  id: z.string().transform(asMaintenanceActionId),
  proposalId: z.string(),
  op: z.enum(['auto-execute', 'approve', 'reject', 'expire']),
  actor: z.object({ sessionId: z.string(), actor: z.string(), at: z.number() }),
  approvalToken: z.string().optional(),
  result: z.enum(['ok', 'failed']).optional(),
  at: z.number(),
});
export type MaintenanceAction = z.infer<typeof ActionSchema>;

export const ReportSchema = z
  .object({
    id: z.string().transform(asMaintenanceReportId),
    trigger: z.object({ kind: z.enum(['periodic', 'coach-review', 'manual']), at: z.number() }),
    stats: z.object({
      scanned: z.number(),
      proposed: z.number(),
      autoExecuted: z.number(),
      pendingApproval: z.number(),
      rejected: z.number(),
      deferredActive: z.number(),
    }),
    capacity: z.record(
      z.string(),
      z.object({ active: z.number(), cap: z.number(), zone: z.enum(['normal', 'pressure', 'over']) }),
    ),
    proposalIds: z.array(z.string()),
    unfinished: z.array(z.string()).optional(),
    at: z.number(),
  })
  .superRefine((report, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (report.stats.deferredActive < 0) issue('deferredActive 不得为负');
  });
export type MaintenanceReport = z.infer<typeof ReportSchema>;

export const ParamsSchema = z
  .object({
    cycleMs: z.number(),
    caps: z.object({ maxActions: z.number(), maxScanned: z.number() }),
    promoteThresholds: z.object({ reuse: z.number(), verify: z.number(), association: z.number() }),
    scoreWeights: z.object({ elo: z.number(), reuse: z.number(), recency: z.number(), verify: z.number() }),
    capacityCaps: z.object({ memory: z.number(), 'meta-thinking': z.number(), skill: z.number() }),
    demotePriority: z.array(z.string()),
    revision: z.number(),
  })
  .superRefine((params, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    const sum =
      params.scoreWeights.elo + params.scoreWeights.reuse + params.scoreWeights.recency + params.scoreWeights.verify;
    if (Math.abs(sum - 1) > 1e-9) issue(`scoreWeights 和须为 1（收到 ${sum}）`);
    if (params.caps.maxActions < 1 || params.caps.maxScanned < 1) issue('caps 须 ≥1（吞吐帽，J7）');
  });
export type MaintenanceParams = z.infer<typeof ParamsSchema>;

export const DEFAULT_PARAMS: MaintenanceParams = {
  cycleMs: 6 * 3600_000,
  caps: { maxActions: 20, maxScanned: 500 },
  promoteThresholds: { reuse: 3, verify: 2, association: 2 },
  scoreWeights: { elo: 0.3, reuse: 0.3, recency: 0.2, verify: 0.2 },
  capacityCaps: { memory: 200, 'meta-thinking': 20, skill: 50 },
  demotePriority: ['capacity', 'use-fail', 'rehearsal-fail', 'superseded', 'unused-days'],
  revision: 0,
};

export const MAINTENANCE_PARAMS_KEY = 'singleton';

export type MaintenanceTables = {
  maintenance_proposals: typeof ProposalSchema;
  maintenance_actions: typeof ActionSchema;
  maintenance_reports: typeof ReportSchema;
  maintenance_params: typeof ParamsSchema;
};

export const maintenanceDomainSpec = defineTdaDomain({
  name: 'tda-maintenance',
  version: 1,
  tables: {
    maintenance_proposals: ProposalSchema,
    maintenance_actions: ActionSchema,
    maintenance_reports: ReportSchema,
    maintenance_params: ParamsSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});
