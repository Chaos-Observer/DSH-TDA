/**
 * T2.1 coach 元进程 v1 —— domain（四表，全 `invalidRecords:'backup-and-skip'`）。
 *
 * J8/J3 纪律：coach 是认知资产非权威——四表丢失 = 同 log + 同 params 重扫重建。
 * **零原文泄漏（J3）**：候选/报告字段白名单 = 分类键 + 引用 + 数字 + 拓扑 shape，
 * schema 本身不含任何自由正文槽位（label 级短模板除外，U2 折中）。
 */
import { z } from 'zod';
import { asCoachCandidateId, asCoachReviewId, defineTdaDomain } from '@tda/kernel';

export const COACH_TRIGGER_KINDS = ['periodic', 'mismatch-surge', 'manual'] as const;
export type CoachTriggerKind = (typeof COACH_TRIGGER_KINDS)[number];

export const COACH_CANDIDATE_KINDS = ['meta-path', 'skill', 'method-memory'] as const;
export type CoachCandidateKind = (typeof COACH_CANDIDATE_KINDS)[number];

export const COACH_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type CoachRisk = (typeof COACH_RISK_LEVELS)[number];

export const COACH_CANDIDATE_STATUSES = [
  'proposed',
  'rehearsing',
  'validated',
  'transfer-verified',
  'submitted',
  'rejected',
  'deferred',
] as const;
export type CoachCandidateStatus = (typeof COACH_CANDIDATE_STATUSES)[number];

export const COACH_REVIEW_STATUSES = [
  'requested',
  'scanning',
  'analyzing',
  'proposing',
  'recorded',
  'failed',
] as const;
export type CoachReviewStatus = (typeof COACH_REVIEW_STATUSES)[number];

/** 拓扑 shape（结构对齐 T1.4 MetaPath.topology；kind 词表校验在使用侧做）。 */
export const CoachTopologySchema = z.object({
  nodes: z.array(z.object({ id: z.string(), kind: z.string() })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })),
  entry: z.string(),
  exits: z.array(z.string()),
});
export type CoachTopology = z.infer<typeof CoachTopologySchema>;

export const CoachConditionSchema = z.object({
  taskClasses: z.array(z.string()),
  stages: z.array(z.string()),
  problemFeatures: z.array(z.string()),
  actionPattern: z.string().optional(),
});

export const CoachRuleSchema = z.object({
  expect: z.string().optional(),
  avoid: z.array(z.string()).optional(),
  prefer: z.array(z.string()).optional(),
  shape: CoachTopologySchema.optional(),
});

export const CoachEvidenceSchema = z.object({
  mismatchIds: z.array(z.string()),
  transitionIds: z.array(z.string()),
  sessions: z.array(
    z.object({ sessionId: z.string(), seqFrom: z.number(), seqTo: z.number() }),
  ),
});

export const CoachCandidateSchema = z
  .object({
    id: z.string().transform(asCoachCandidateId),
    kind: z.enum(COACH_CANDIDATE_KINDS),
    risk: z.enum(COACH_RISK_LEVELS),
    condition: CoachConditionSchema,
    rule: CoachRuleSchema,
    evidence: CoachEvidenceSchema,
    confidence: z.number(),
    status: z.enum(COACH_CANDIDATE_STATUSES),
    draftRef: z
      .object({ kind: z.enum(['meta-path', 'skill', 'timeline-entry']), id: z.string() })
      .optional(),
    transfer: z.object({ verified: z.boolean(), modelProfiles: z.array(z.string()) }).optional(),
    reviewId: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .superRefine((candidate, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (candidate.confidence < 0 || candidate.confidence > 1) {
      issue(`confidence 须落在 [0,1]（收到 ${candidate.confidence}）`);
    }
    if (candidate.condition.taskClasses.length === 0 && candidate.condition.stages.length === 0) {
      issue('适用条件不得全空（J12 质量门 ②：候选必须说明何时适用）');
    }
  });
export type CoachCandidate = z.infer<typeof CoachCandidateSchema>;

export const CoachPatternSummarySchema = z.object({
  key: z.string(),
  condition: CoachConditionSchema,
  deltaKinds: z.record(z.string(), z.number()),
  topErrorClasses: z.array(z.object({ errorClass: z.string(), freq: z.number() })),
  count: z.number(),
  evidence: z.object({ mismatchIds: z.array(z.string()), transitionIds: z.array(z.string()) }),
});
export type CoachPatternSummary = z.infer<typeof CoachPatternSummarySchema>;

export const CoachReviewSchema = z
  .object({
    id: z.string().transform(asCoachReviewId),
    trigger: z.object({ kind: z.enum(COACH_TRIGGER_KINDS), at: z.number() }),
    window: z.object({ fromSeq: z.number(), toSeq: z.number(), fromAt: z.number(), toAt: z.number() }),
    status: z.enum(COACH_REVIEW_STATUSES),
    stats: z.object({
      mismatchesScanned: z.number(),
      patternsFound: z.number(),
      candidatesProposed: z.number(),
      candidatesRejected: z.number(),
      rehearsalsRun: z.number(),
      humanApprovalsRequested: z.number(),
    }),
    patterns: z.array(CoachPatternSummarySchema),
    candidateIds: z.array(z.string()),
    govActionRefs: z.array(z.string()),
    unfinished: z.array(z.string()).optional(),
    at: z.number(),
  })
  .superRefine((review, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (review.status === 'failed' && (review.unfinished === undefined || review.unfinished.length === 0)) {
      issue('failed 是显式终态，必带 unfinished 清单（C5：绝不静默失败）');
    }
  });
export type CoachReview = z.infer<typeof CoachReviewSchema>;

export const CoachScanStateSchema = z.object({
  /** 已消费的 mismatch 水位（mismatch id 数字后缀）。 */
  lastMismatchSeq: z.number(),
  lastAt: z.number(),
  lastReviewAt: z.number(),
  surgeWindow: z.object({ sinceAt: z.number(), nonNoneCount: z.number() }),
});
export type CoachScanState = z.infer<typeof CoachScanStateSchema>;

export const CoachParamsSchema = z
  .object({
    periodMs: z.number(),
    surgeThreshold: z.number(),
    surgeWindowMs: z.number(),
    maxMismatchScan: z.number(),
    maxCandidatesPerReview: z.number(),
    maxRehearsalConcurrent: z.number(),
    reviewBudgetMs: z.number(),
    minEvidenceCount: z.number(),
    minConfidence: z.number(),
    yieldPollMs: z.number(),
    yieldTimeoutMs: z.number(),
    revision: z.number(),
  })
  .superRefine((params, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    for (const key of [
      'surgeThreshold',
      'maxMismatchScan',
      'maxCandidatesPerReview',
      'maxRehearsalConcurrent',
      'minEvidenceCount',
    ] as const) {
      if (params[key] < 1) issue(`${key} 须 ≥1（收到 ${params[key]}）`);
    }
    if (params.minConfidence < 0 || params.minConfidence > 1) {
      issue(`minConfidence 须落在 [0,1]（收到 ${params.minConfidence}）`);
    }
    if (params.yieldPollMs <= 0 || params.yieldTimeoutMs < params.yieldPollMs) {
      issue('让位轮询参数非法（poll>0 且 timeout≥poll）');
    }
  });
export type CoachParams = z.infer<typeof CoachParamsSchema>;

export const DEFAULT_COACH_PARAMS: CoachParams = {
  periodMs: 24 * 3600_000,
  surgeThreshold: 5,
  surgeWindowMs: 3600_000,
  maxMismatchScan: 200,
  maxCandidatesPerReview: 10,
  maxRehearsalConcurrent: 2,
  reviewBudgetMs: 30_000,
  minEvidenceCount: 3,
  minConfidence: 0.5,
  yieldPollMs: 20,
  yieldTimeoutMs: 5_000,
  revision: 0,
};

export const COACH_PARAMS_KEY = 'singleton';
export const COACH_SCAN_STATE_KEY = 'singleton';

export type CoachTables = {
  coach_reviews: typeof CoachReviewSchema;
  coach_candidates: typeof CoachCandidateSchema;
  coach_scan_state: typeof CoachScanStateSchema;
  coach_params: typeof CoachParamsSchema;
};

/** 四表全 backup-and-skip（J8）：coach 是认知资产非权威，丢失=同 log+同 params 重扫重建。 */
export const coachDomainSpec = defineTdaDomain({
  name: 'tda-coach',
  version: 1,
  tables: {
    coach_reviews: CoachReviewSchema,
    coach_candidates: CoachCandidateSchema,
    coach_scan_state: CoachScanStateSchema,
    coach_params: CoachParamsSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});
