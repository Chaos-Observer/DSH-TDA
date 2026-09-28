/**
 * T3.1 · events（knowledge/change 第十七事件族，log-only session event）。
 * 载荷 = JSON 无损；键序与 schema 定义序一致（compareReplay 逐字节比对纪律）。
 */
import type { KnowledgeEntry, KnowledgeParams, KnowledgeRun } from './domain.ts';
import type { JsonObject } from '@tda/kernel';

export const KNOWLEDGE_ENTRY_BUSINESS_PREFIX = 'knowledge-entry';
export const KNOWLEDGE_RUN_BUSINESS_PREFIX = 'knowledge-run';

export function knowledgeEntryPayload(entry: KnowledgeEntry): JsonObject {
  return {
    entryId: String(entry.entryId),
    version: entry.version,
    ...(entry.supersedes !== undefined ? { supersedes: entry.supersedes } : {}),
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    ...(entry.chunkRef !== undefined ? { chunkRef: entry.chunkRef } : {}),
    ...(entry.graphRef !== undefined ? { graphRef: entry.graphRef } : {}),
    status: entry.status,
    credential: entry.credential,
    ...(entry.authorityHint !== undefined ? { authorityHint: entry.authorityHint } : {}),
    validity: {
      validFrom: entry.validity.validFrom,
      ...(entry.validity.validTo !== undefined ? { validTo: entry.validity.validTo } : {}),
      ingestedAt: entry.validity.ingestedAt,
    },
    evidence: {
      chunkRefs: [...entry.evidence.chunkRefs],
      trajectoryRefs: [...entry.evidence.trajectoryRefs],
      ...(entry.evidence.fileRefs !== undefined ? { fileRefs: [...entry.evidence.fileRefs] } : {}),
    },
    stats: {
      reuseCount: entry.stats.reuseCount,
      verifyCount: entry.stats.verifyCount,
      associationSpread: entry.stats.associationSpread,
    },
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function knowledgeRunPayload(run: KnowledgeRun): JsonObject {
  return {
    runId: String(run.runId),
    trigger: {
      kind: run.trigger.kind,
      ...(run.trigger.clusterRefs !== undefined ? { clusterRefs: [...run.trigger.clusterRefs] } : {}),
    },
    status: run.status,
    ...(run.stage !== undefined ? { stage: run.stage } : {}),
    ...(run.failureReason !== undefined ? { failureReason: run.failureReason } : {}),
    clusterCount: run.clusterCount,
    candidatesProposed: [...run.candidatesProposed],
    skipped: run.skipped.map((item) => ({ reason: item.reason, clusterRef: item.clusterRef })),
    reportChunkIds: [...run.reportChunkIds],
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
  };
}

export function knowledgeParamsPayload(params: KnowledgeParams): JsonObject {
  return {
    distillThresholds: {
      reuse: params.distillThresholds.reuse,
      verify: params.distillThresholds.verify,
      associationSpread: params.distillThresholds.associationSpread,
    },
    clusterCap: params.clusterCap,
    depthCap: params.depthCap,
    fanInCap: params.fanInCap,
    periodMs: params.periodMs,
    distillConcurrency: params.distillConcurrency,
    invalidateQueueCap: params.invalidateQueueCap,
    revision: params.revision,
  };
}
