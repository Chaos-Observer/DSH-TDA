/**
 * tda-meta-thinking 域定义（T1.4 §3.3 存储落点）。
 *
 * 两表，**全部派生**（`invalidRecords='backup-and-skip'`）：元路径可经轨迹 +
 * 治理日志重建（认知资产非权威，同 T1.3 J7）；rehearsal 史是 coach 复盘输入，
 * 丢了可重跑。
 *
 * **lifecycle 不在本域**（J1/J6）：治理状态单一权威在 `ctx.governance`
 * （assetKind='meta-thinking' 分区）——本插件无 retire 本地实现、无 lifecycle 字段，
 * 一切状态迁移委托治理管道。这使"元思维是统一治理管道的第三实例"成为
 * 结构事实而非口号：meta_paths 表里**没有** lifecycle 列可存。
 *
 * 非语言内容（J2）在 schema 层落死：节点 = 推理动作**类型**，label 仅 ≤24 字符
 * 类型助记（禁句号/换行）；正文/参数值没有任何字段可承载。
 */
import { asMetaPathId, asRehearsalId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

/** 推理动作类型（§3.6 思维行的节点词表）。 */
export const REASONING_STEP_KINDS = [
  'observe',
  'hypothesize',
  'decompose',
  'analogize',
  'verify',
  'refute',
  'synthesize',
] as const;
export type ReasoningStepKind = (typeof REASONING_STEP_KINDS)[number];

export const EDGE_KINDS = ['seq', 'cond', 'loop'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** 收敛/发散双路径（J3：planning→divergent 优先，executing/verifying→convergent 优先）。 */
export const META_MODES = ['convergent', 'divergent'] as const;
export type MetaMode = (typeof META_MODES)[number];

export const META_SOURCE_KINDS = ['trajectory-extract', 'coach-author', 'human'] as const;
export type MetaSourceKind = (typeof META_SOURCE_KINDS)[number];

/** label 上限（J2：类型助记，非正文）。 */
export const LABEL_MAX = 24;

export const MetaPathSchema = z
  .object({
    id: z.string().transform(asMetaPathId),
    topology: z.object({
      nodes: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(REASONING_STEP_KINDS),
          label: z.string().optional(),
        }),
      ),
      edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(EDGE_KINDS) })),
      entry: z.string(),
      exits: z.array(z.string()),
    }),
    mode: z.enum(META_MODES),
    /** 适用条件（分类键，非原文）。 */
    applicability: z.object({
      taskClasses: z.array(z.string()),
      stages: z.array(z.enum(['planning', 'executing', 'waiting', 'verifying'])),
      problemFeatures: z.array(z.string()),
    }),
    stats: z.object({
      rehearsalPass: z.number(),
      rehearsalFail: z.number(),
      consecutiveRehearsalFail: z.number(),
      realUse: z.number(),
    }),
    source: z.object({
      kind: z.enum(META_SOURCE_KINDS),
      refs: z.array(z.object({ sessionId: z.string(), seqFrom: z.number(), seqTo: z.number() })),
    }),
    version: z.number(),
    supersedes: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .superRefine((path, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    const { topology } = path;
    const ids = new Set(topology.nodes.map((node) => node.id));
    if (topology.nodes.length === 0) issue('拓扑至少要有一个节点');
    if (!ids.has(topology.entry)) issue(`entry ${topology.entry} 不在节点集内`);
    if (topology.exits.length === 0) issue('exits 不得为空（必须有可判定的终点）');
    for (const exit of topology.exits) {
      if (!ids.has(exit)) issue(`exit ${exit} 不在节点集内`);
    }
    // label 启发式（不变量 2：非语言内容）
    for (const node of topology.nodes) {
      if (node.label === undefined) continue;
      if (node.label.length > LABEL_MAX) issue(`节点 ${node.id} label 长 ${node.label.length} > ${LABEL_MAX}`);
      if (node.label.includes('。') || node.label.includes('\n')) {
        issue(`节点 ${node.id} label 含句号/换行——label 是类型助记不是正文（J2）`);
      }
    }
    // 边端点合法 + 无自环
    for (const edge of topology.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        issue(`边 ${edge.from}→${edge.to} 端点不在节点集内`);
      }
      if (edge.from === edge.to) issue(`边 ${edge.from}→${edge.to} 是自环`);
    }
    // 不变量 1：seq/cond 边无环（loop 边不算——它本身是回边，但必须回到 cond 护栏祖先）
    const forward = topology.edges.filter((edge) => edge.kind !== 'loop');
    if (hasCycle(topology.nodes.map((node) => node.id), forward)) {
      issue('seq/cond 边存在环（不变量 1：拓扑必须无环）');
    }
    for (const edge of topology.edges.filter((item) => item.kind === 'loop')) {
      const guarded = topology.edges.some((item) => item.to === edge.to && item.kind === 'cond');
      if (!guarded) issue(`loop 回边 ${edge.from}→${edge.to} 的目标无 cond 护栏（不变量 1：禁无护栏回边）`);
    }
    // entry 可达全部 exits
    const reachable = reachableFrom(topology.entry, topology.edges);
    for (const exit of topology.exits) {
      if (!reachable.has(exit)) issue(`entry 不可达 exit ${exit}（不变量 1）`);
    }
    // stats 恒等律
    if (path.stats.consecutiveRehearsalFail > path.stats.rehearsalFail) {
      issue('consecutiveRehearsalFail 不得超过 rehearsalFail（连续计数是它的子集）');
    }
    if (path.version < 1) issue(`version 须 ≥1（收到 ${path.version}）`);
    if (path.supersedes === path.id) issue('supersedes 不得自指');
    for (const ref of path.source.refs) {
      if (ref.seqTo < ref.seqFrom) issue(`source.refs 区间倒挂（${ref.seqFrom}>${ref.seqTo}）`);
    }
  });
export type MetaPath = z.infer<typeof MetaPathSchema>;

/** 有向图判环（Kahn 消退；忽略 loop 边）。 */
function hasCycle(nodeIds: readonly string[], edges: readonly { readonly from: string; readonly to: string }[]): boolean {
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const out = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    out.get(edge.from)?.push(edge.to);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of out.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  return visited !== nodeIds.length;
}

/** 从 entry 出发的可达集（全部边型）。 */
function reachableFrom(entry: string, edges: readonly { readonly from: string; readonly to: string }[]): Set<string> {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of edges) {
      if (edge.from !== id || seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
}

export const RehearsalRunSchema = z
  .object({
    id: z.string().transform(asRehearsalId),
    metaPathId: z.string(),
    taskId: z.string(),
    childSessionId: z.string(),
    /** 显式 fork 边界（禁开放轮次前缀，T0.7 J6）。 */
    boundary: z.object({ sessionId: z.string(), eventKind: z.string(), seq: z.number() }),
    verdict: z.enum(['pass', 'fail']),
    /** stepCoverage：拓扑步骤在子会话 transition 链中的覆盖率（0–1）。 */
    coverage: z.number(),
    outcome: z.enum(['success', 'failure']),
    at: z.number(),
  })
  .superRefine((run, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (run.coverage < 0 || run.coverage > 1) issue(`coverage 须落在 [0,1]（收到 ${run.coverage}）`);
    if (run.verdict === 'pass' && run.outcome !== 'success') {
      issue('verdict=pass 必须以 outcome=success 为前提（J5 判定式的两个条件之一）');
    }
    if (run.boundary.seq < 0) issue('boundary.seq 不得为负');
  });
export type RehearsalRun = z.infer<typeof RehearsalRunSchema>;

export const META_PATH_PREFIX = 'mp';
export const REHEARSAL_PREFIX = 'reh';

export type MetaThinkingTables = {
  meta_paths: typeof MetaPathSchema;
  rehearsal_runs: typeof RehearsalRunSchema;
};

export const metaThinkingDomainSpec = defineTdaDomain({
  name: 'tda-meta-thinking',
  version: 1,
  tables: {
    meta_paths: MetaPathSchema,
    rehearsal_runs: RehearsalRunSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});
