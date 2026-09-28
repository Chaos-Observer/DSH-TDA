/**
 * T3.1 分层知识图谱 · domain（J11 四表，全 backup-and-skip——Graphiti 可经
 * knowledge_events 全量重摄入重建）。
 *
 * 三权威分工（J3）：内容=T0.3 时间线 chunk；结构=Graphiti（外置，经 seam）；
 * 映射/元数据=本 domain。**本 domain 不存条目正文**——summary 是进 episode 的
 * 陈述摘要（≤300 字符），物化 chunk 承载完整内容。
 */
import { z } from 'zod';
import { asKnowledgeEntryId, asKnowledgeRunId, defineTdaDomain } from '@tda/kernel';

export const KNOWLEDGE_ENTRY_KINDS = ['moc', 'concept', 'method', 'entity'] as const;
export const KNOWLEDGE_EDGE_KINDS = [
  'part-of',
  'relates-to',
  'derives-from',
  'contradicts',
  'exemplifies',
  'supersedes',
] as const;
export const KNOWLEDGE_STATUS = ['draft', 'validating', 'consolidated', 'retired', 'invalidated'] as const;
/** 凭证秩（J9：条目 credential = min(证据 chunk 凭证)）。与 timeline 的秩序一致。 */
export const KNOWLEDGE_CREDENTIAL_RANK: Record<string, number> = {
  'tool-output': 0,
  'external-content': 0,
  'model-produced': 1,
  'execution-verified': 2,
  'user-original': 3,
};

const KnowledgeEntrySchema = z.object({
  entryId: z.string().transform(asKnowledgeEntryId),
  version: z.number().int().min(1),
  supersedes: z.string().optional(),
  kind: z.enum(KNOWLEDGE_ENTRY_KINDS),
  title: z.string().min(1).max(60),
  /** ≤300 字符陈述（Graphiti episode 载荷=此摘要+证据引用，J3 禁正文）。 */
  summary: z.string().min(1).max(300),
  chunkRef: z.string().optional(),
  /** Graphiti 引用（仅 consolidated 后非空——不变量 2 未验证零入图）。 */
  graphRef: z.string().optional(),
  /** 治理投影镜像（权威在 gov_states，J5/不变量 7 治理单一）。 */
  status: z.enum(KNOWLEDGE_STATUS),
  credential: z.string(),
  authorityHint: z.enum(['authoritative-likely', 'draft-likely', 'unknown']).optional(),
  validity: z.object({
    validFrom: z.number(),
    validTo: z.number().optional(),
    ingestedAt: z.number(),
  }),
  evidence: z.object({
    chunkRefs: z.array(z.string()),
    trajectoryRefs: z.array(z.string()),
    fileRefs: z.array(z.string()).optional(),
  }),
  stats: z.object({
    reuseCount: z.number().int().min(0),
    verifyCount: z.number().int().min(0),
    associationSpread: z.number().int().min(0),
  }),
  createdBy: z.enum(['distill', 'coach', 'human']),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const KnowledgeEventSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'distill-begin',
    'candidate-proposed',
    'entry-consolidated',
    'entry-ingested',
    'entry-invalidated',
    'entry-reasserted',
    'link-added',
    'link-removed',
    'distill-end',
  ]),
  entryId: z.string().optional(),
  detail: z.record(z.string(), z.unknown()),
  at: z.number(),
});

const KnowledgeRunSchema = z.object({
  runId: z.string().transform(asKnowledgeRunId),
  trigger: z.object({
    kind: z.enum(['maintenance', 'periodic', 'manual']),
    clusterRefs: z.array(z.string()).optional(),
  }),
  status: z.enum(['pending', 'clustering', 'distilling', 'validating', 'recorded', 'failed']),
  stage: z.enum(['cluster', 'distill', 'validate']).optional(),
  failureReason: z.string().optional(),
  clusterCount: z.number().int().min(0),
  candidatesProposed: z.array(z.string()),
  skipped: z.array(z.object({ reason: z.string(), clusterRef: z.string() })),
  reportChunkIds: z.array(z.string()),
  startedAt: z.number(),
  endedAt: z.number().optional(),
});

const KnowledgeParamsSchema = z.object({
  distillThresholds: z.object({ reuse: z.number().min(0), verify: z.number().min(0), associationSpread: z.number().min(0) }),
  clusterCap: z.number().int().min(1),
  depthCap: z.number().int().min(1),
  fanInCap: z.number().int().min(1),
  periodMs: z.number().min(1),
  distillConcurrency: z.number().int().min(1),
  invalidateQueueCap: z.number().int().min(1),
  revision: z.number().int().min(0),
});

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
export type KnowledgeEvent = z.infer<typeof KnowledgeEventSchema>;
export type KnowledgeRun = z.infer<typeof KnowledgeRunSchema>;
export type KnowledgeParams = z.infer<typeof KnowledgeParamsSchema>;
export type KnowledgeEntryKind = (typeof KNOWLEDGE_ENTRY_KINDS)[number];
export type KnowledgeEdgeKind = (typeof KNOWLEDGE_EDGE_KINDS)[number];
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUS)[number];

export interface KnowledgeCandidate {
  readonly kind: KnowledgeEntryKind;
  readonly title: string;
  readonly summary: string;
  readonly edges: { readonly toTitle: string; readonly kind: KnowledgeEdgeKind; readonly confidence: number }[];
  readonly evidenceChunkRefs: readonly string[];
}

export interface KnowledgeEdge {
  readonly edgeId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly kind: KnowledgeEdgeKind;
  readonly evidence: readonly string[];
  readonly removedAt?: number;
}

export const DEFAULT_KNOWLEDGE_PARAMS: KnowledgeParams = {
  distillThresholds: { reuse: 2, verify: 1, associationSpread: 2 },
  clusterCap: 8,
  depthCap: 3,
  fanInCap: 2,
  periodMs: 24 * 3_600_000,
  distillConcurrency: 2,
  invalidateQueueCap: 64,
  revision: 0,
};

export const KNOWLEDGE_PARAMS_KEY = 'singleton';
export const KNOWLEDGE_PARAMS_BUSINESS_ID = 'params';

/** 蒸馏管线的源簇（聚类输入；harness 从 timeline 检索 + 维护信号供给）。 */
export interface DistillSourceChunk {
  readonly entryId: string;
  readonly summary: string;
  readonly credential: string;
  readonly relatedTaskId?: string;
  readonly trajectoryRef?: string;
  readonly at: number;
}

export const knowledgeDomainSpec = defineTdaDomain({
  name: 'tda-knowledge',
  version: 1,
  // per-record：四表均为键值集合（entries 版本链键、events/runs/params 单键）。
  layout: 'per-record',
  tables: {
    knowledge_entries: KnowledgeEntrySchema,
    knowledge_events: KnowledgeEventSchema,
    knowledge_runs: KnowledgeRunSchema,
    knowledge_params: KnowledgeParamsSchema,
  },
  invalidRecords: 'backup-and-skip',
});

export type KnowledgeTables = typeof knowledgeDomainSpec.tables;
