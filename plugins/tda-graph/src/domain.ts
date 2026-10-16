/**
 * tda-graph 域定义（T4.3 §3.2 存储落点）。
 *
 * 三表，**全部派生**（`invalidRecords: 'backup-and-skip'`，丢失=rebuild）：
 *  - `graph_nodes`/`graph_edges`：三源归一投影（goal/task/file）。权威分别在
 *    T0.1 goal_nodes / T0.2 task_nodes / T0.6 文件图谱——本域是"可整表重建"的
 *    只读投影（audit_index 同款），**不产事件**（J10：派生层产事件=索引事件
 *    引发新索引的自指放大），写入走 `dualWriteDerived`（派生窗，不计配对）；
 *  - `graph_params`：策略权威（容量帽/标签上限/重建策略）。
 *
 * 零写权纪律（J1）：deps 类型级只注入三权威域的**只读**服务面（tree/get/list/graph），
 * 本域无任何权威写路径——读模型持写权=第四处图权威，违背 C1。
 */
import { defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

export const GRAPH_PARAMS_KEY = 'singleton';
/** params 行的稳定业务 id（虽不产事件，保持 T0.7 行键命名惯例）。 */
export const GRAPH_PARAMS_BUSINESS_ID = 'params';

/** 图谱状态机（T4.3 §2；内存态，不持久——boot 必重建）。 */
export const GRAPH_STATES = ['stale', 'rebuilding', 'fresh', 'failed'] as const;
export type GraphState = (typeof GRAPH_STATES)[number];

/** 节点三类（三源归一）。 */
export const GRAPH_NODE_KINDS = ['goal', 'task', 'file'] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

/** 边六类（T4.3 §3.1；alternativeOf=advisory，不参与环检测与阻塞链）。 */
export const GRAPH_EDGE_KINDS = [
  'parent',
  'blockedBy',
  'alternativeOf',
  'dependsOn',
  'relatedTo',
  'supersedesFile',
] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export const GraphNodeSchema = z.object({
  /** 'goal-3' / 'task-17' / 'file:src/a.ts'。 */
  id: z.string(),
  kind: z.enum(GRAPH_NODE_KINDS),
  /** 权威定位（goalId / taskId / 工作区相对路径），非副本。 */
  ref: z.string(),
  /** task/file 的归属根目标（goal 节点自身=id）。 */
  rootGoalId: z.string().optional(),
  /** 截断 ≤ maxLabelChars（J8 标签隔离）。 */
  label: z.string(),
  /** goal: phase；task: phase×zone；file: 存在性+scanId 摘要。 */
  status: z.string(),
  /** 子树内深度（root=0；全图投影时按各自树计）。 */
  depth: z.number().int().min(0),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(GRAPH_EDGE_KINDS),
  /** alternativeOf=true（advisory 标注，不参与环检测/阻塞链）。 */
  advisory: z.boolean(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphParamsSchema = z.object({
  revision: z.number(),
  maxNodes: z.number().int().min(1),
  maxEdges: z.number().int().min(1),
  maxLabelChars: z.number().int().min(1),
  rebuildPolicy: z.enum(['boot+task-subscribe+goal-reconcile']),
});
export type GraphParams = z.infer<typeof GraphParamsSchema>;

export const DEFAULT_GRAPH_PARAMS: GraphParams = {
  revision: 0,
  maxNodes: 10_000,
  maxEdges: 50_000,
  maxLabelChars: 120,
  rebuildPolicy: 'boot+task-subscribe+goal-reconcile',
};

export type GraphTables = {
  graph_nodes: typeof GraphNodeSchema;
  graph_edges: typeof GraphEdgeSchema;
  graph_params: typeof GraphParamsSchema;
};

export const graphDomainSpec = defineTdaDomain({
  name: 'tda-graph',
  version: 1,
  tables: {
    graph_nodes: GraphNodeSchema,
    graph_edges: GraphEdgeSchema,
    graph_params: GraphParamsSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});

/** 边的复合键（`from#kind#to`）。 */
export const edgeKey = (edge: Pick<GraphEdge, 'from' | 'kind' | 'to'>): string =>
  `${edge.from}#${edge.kind}#${edge.to}`;

/** 标签截断（J8：≤ maxLabelChars，仅 objective/subject/路径类文本）。 */
export const truncateLabel = (label: string, maxChars: number): string =>
  label.length <= maxChars ? label : `${label.slice(0, Math.max(0, maxChars - 1))}…`;
