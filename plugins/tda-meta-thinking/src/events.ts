/**
 * tda-meta-thinking 事件载荷（T1.4 §5 审计面）。
 *
 * 族 `metaPath/change` 承载 **meta_paths 与 rehearsal_runs**（businessId = `mp-<n>` / `reh-<n>`）。
 * 两者虽是派生表（可重建），但 `stats` 的更新依赖**治理侧的裁决时序**
 * （consolidate/retire 何时发生），事件流是唯一可回放的裁决记录——故按全快照双写
 * （同 T1.3 predictions 的口径：依赖外部状态的数据不能只靠"可重算"）。
 *
 * lifecycle/retire 的动作记录在 T1.2 的 `memoryGov/change`（治理单一，J1）——
 * 本族**不含任何治理动作**，两族各自配对，互不越界。
 */
import type { JsonObject } from '@tda/kernel';
import type { MetaPath, RehearsalRun } from './domain.ts';

export const META_PATH_BUSINESS_PREFIX = 'mp';
export const REHEARSAL_BUSINESS_PREFIX = 'reh';

export function metaPathPayload(path: MetaPath): JsonObject {
  return {
    id: String(path.id),
    topology: {
      nodes: path.topology.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        ...(node.label !== undefined ? { label: node.label } : {}),
      })),
      edges: path.topology.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
      entry: path.topology.entry,
      exits: [...path.topology.exits],
    },
    mode: path.mode,
    applicability: {
      taskClasses: [...path.applicability.taskClasses],
      stages: [...path.applicability.stages],
      problemFeatures: [...path.applicability.problemFeatures],
    },
    stats: { ...path.stats },
    source: {
      kind: path.source.kind,
      refs: path.source.refs.map((ref) => ({ sessionId: ref.sessionId, seqFrom: ref.seqFrom, seqTo: ref.seqTo })),
    },
    version: path.version,
    ...(path.supersedes !== undefined ? { supersedes: path.supersedes } : {}),
    createdAt: path.createdAt,
    updatedAt: path.updatedAt,
  };
}

export function rehearsalPayload(run: RehearsalRun): JsonObject {
  return {
    id: String(run.id),
    metaPathId: run.metaPathId,
    taskId: run.taskId,
    childSessionId: run.childSessionId,
    boundary: { sessionId: run.boundary.sessionId, eventKind: run.boundary.eventKind, seq: run.boundary.seq },
    verdict: run.verdict,
    coverage: run.coverage,
    outcome: run.outcome,
    at: run.at,
  };
}
