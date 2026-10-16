/**
 * tda-graph 服务面（T4.3 §4.2 `ctx.taskGraph`）。
 *
 * 硬纪律（全部在类型级或运行时强制）：
 *  - **零写权**：deps 只注入三权威域的只读服务面（goalTree tree/get / taskPool
 *    list/get / workspace graph），无任何权威写路径（J1）；
 *  - **纯派生**：自有 domain 仅三张 backup-and-skip 表，写入走 `dualWriteDerived`
 *    （派生窗不计配对），不产事件（J10：派生层产事件=自指放大）；
 *  - **无环复核 fail-loud**：rebuild 后合并图（非 advisory 边）成环 ⇒ state=failed，
 *    查询抛 GRAPH_UNHEALTHY，禁渲染环/静默丢边（J9）；
 *  - **容量帽显式截断**：超 maxNodes/maxEdges ⇒ truncated+unfinished（J7）；
 *  - **标签隔离**：label ≤ maxLabelChars；文件节点只引路径/scanId，不携语义标注（J8）；
 *  - **增量驱动**：boot 必重建 + taskPool/change 订阅（快速路径，apply 里挂）+
 *    reconcile 全量重算（goal 侧 tick；goal 数量级小，全量便宜）（J3）。
 */
import {
  dualWriteDerived,
  TdaError,
  type DualWriteContext,
  type DualWriteReconciler,
  type TdaDomain,
} from '@tda/kernel';
import {
  DEFAULT_GRAPH_PARAMS,
  GRAPH_PARAMS_KEY,
  GraphParamsSchema,
  edgeKey,
  truncateLabel,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphNodeKind,
  type GraphNode,
  type GraphParams,
  type GraphState,
  type GraphTables,
} from './domain.ts';

// ── 只读 seam（结构镜像：J1 类型级零写权） ─────────────────────────────

export interface GraphGoalView {
  readonly id: string;
  readonly parentId?: string | undefined;
  readonly objective: string;
  readonly phase: string;
  readonly stage?: string | undefined;
  readonly focus: boolean;
  readonly clearedAt?: number | undefined;
}

export interface GraphGoalSeam {
  tree(rootId?: string): readonly GraphGoalView[];
  get(id: string): GraphGoalView | undefined;
}

export interface GraphTaskView {
  readonly id: string;
  readonly goalId: string;
  readonly subject: string;
  readonly phase: string;
  readonly stage: string;
  readonly zone: string;
  readonly parentTaskId?: string | undefined;
  readonly blockedBy: readonly string[];
  readonly alternativeOf?: { readonly taskId: string } | undefined;
  readonly localPath?: string | undefined;
  readonly deletedAt?: number | undefined;
}

export interface GraphTaskSeam {
  list(filter?: { goalId?: string }): readonly GraphTaskView[];
  get(id: string): GraphTaskView | undefined;
}

export interface GraphFileNode {
  readonly path: string;
  readonly ignored: boolean;
  readonly role?: string | undefined;
  readonly lastScanId: string;
}

export interface GraphFileEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'depends-on' | 'related-to' | 'supersedes-file';
}

/** J6：唯一关联点=task.localPath ↔ file nodes；不复制文件图谱语义标注。 */
export interface GraphWorkspaceSeam {
  graph(taskId: string): { readonly nodes: readonly GraphFileNode[]; readonly edges: readonly GraphFileEdge[] };
}

export interface GraphDeps {
  readonly domain: TdaDomain<GraphTables>;
  readonly goal: GraphGoalSeam;
  readonly taskPool: GraphTaskSeam;
  readonly workspace: GraphWorkspaceSeam;
  readonly reconciler?: DualWriteReconciler;
  readonly now?: () => number;
  readonly config?: Partial<GraphParams>;
}

/** TdaKvTable 无 values()：entries 解构出值序列（模块级纯助手）。 */
const tableValues = <V>(table: { readonly entries: () => IterableIterator<[string, V]> }): readonly V[] =>
  [...table.entries()].map(([, value]) => value);

// ── 纯函数：投影构建（J2/J7/J8/J9） ────────────────────────────────────

export interface ProjectionInput {
  readonly goals: readonly GraphGoalView[];
  readonly tasks: readonly GraphTaskView[];
  /** task.localPath → 文件邻域（调用方按需取，缺 localPath 的任务不查）。 */
  readonly fileGraphOf: (taskId: string) => { nodes: readonly GraphFileNode[]; edges: readonly GraphFileEdge[] };
  readonly params: Pick<GraphParams, 'maxNodes' | 'maxEdges' | 'maxLabelChars'>;
}

export interface Projection {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: ReadonlyMap<string, GraphEdge>;
  readonly truncated: boolean;
  readonly unfinished: readonly string[];
}

const FILE_PREFIX = 'file:';

/** 任务→根目标归属（沿 goal parentId 上溯；goal 缺失时归属自身 goalId）。 */
export function rootGoalOf(
  goalId: string,
  goalsById: ReadonlyMap<string, GraphGoalView>,
): string {
  let current = goalId;
  for (let hop = 0; hop < 64; hop += 1) {
    const goal = goalsById.get(current);
    if (goal === undefined || goal.parentId === undefined) return current;
    current = goal.parentId;
  }
  return current;
}

/**
 * 三源归一投影（纯函数，同输入同输出）：
 *  - goal 节点：tree 全量（clearedAt 在场的 tombstone 不入谱——历史不丢但已出图）；
 *  - task 节点：list 全量（deletedAt 在场的 tombstone 同理）+ parent/blockedBy/alternativeOf 边；
 *  - file 节点：有 localPath 的任务逐个桥接 workspace.graph（J6 零复制——
 *    只投影 path/ignored/scanId，语义标注/可信度 hints 留在 T0.6）。
 * 容量帽：节点/边超帽 ⇒ truncated + unfinished 说明（禁静默截断）。
 */
export function buildProjection(input: ProjectionInput): Projection {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const unfinished: string[] = [];
  let truncated = false;
  const { maxNodes, maxEdges, maxLabelChars } = input.params;

  const putNode = (node: GraphNode): boolean => {
    if (nodes.size >= maxNodes) {
      truncated = true;
      return false;
    }
    nodes.set(node.id, node);
    return true;
  };
  const putEdge = (edge: GraphEdge): boolean => {
    const key = edgeKey(edge);
    if (edges.has(key)) return true;
    if (edges.size >= maxEdges) {
      truncated = true;
      return false;
    }
    edges.set(key, edge);
    return true;
  };

  // ① goal 源
  const goalsById = new Map<string, GraphGoalView>();
  for (const goal of input.goals) {
    if (goal.clearedAt !== undefined) continue; // tombstone 出图（历史在 T0.1）
    goalsById.set(goal.id, goal);
  }
  for (const goal of goalsById.values()) {
    if (!putNode({
      id: goal.id,
      kind: 'goal',
      ref: goal.id,
      label: truncateLabel(goal.objective, maxLabelChars),
      status: goal.phase,
      depth: 0,
    })) {
      unfinished.push(`goal 节点超帽截断：${goal.id}`);
      break;
    }
    if (goal.parentId !== undefined && goalsById.has(goal.parentId)) {
      if (!putEdge({ from: goal.parentId, to: goal.id, kind: 'parent', advisory: false })) {
        unfinished.push(`goal parent 边超帽截断：${goal.parentId}→${goal.id}`);
      }
    }
  }

  // ② task 源
  const tasksById = new Map<string, GraphTaskView>();
  for (const task of input.tasks) {
    if (task.deletedAt !== undefined) continue;
    tasksById.set(task.id, task);
  }
  for (const task of tasksById.values()) {
    const root = rootGoalOf(task.goalId, goalsById);
    if (!putNode({
      id: task.id,
      kind: 'task',
      ref: task.id,
      rootGoalId: root,
      label: truncateLabel(task.subject, maxLabelChars),
      status: `${task.phase}/${task.zone}`,
      depth: 0,
    })) {
      unfinished.push(`task 节点超帽截断：${task.id}`);
      continue;
    }
    if (task.parentTaskId !== undefined && tasksById.has(task.parentTaskId)) {
      if (!putEdge({ from: task.parentTaskId, to: task.id, kind: 'parent', advisory: false })) {
        unfinished.push(`task parent 边超帽截断：${task.parentTaskId}→${task.id}`);
      }
    }
    for (const blocker of task.blockedBy) {
      if (!tasksById.has(blocker)) continue; // 悬空依赖由权威域守门；此处不臆造节点
      if (!putEdge({ from: task.id, to: blocker, kind: 'blockedBy', advisory: false })) {
        unfinished.push(`blockedBy 边超帽截断：${task.id}→${blocker}`);
      }
    }
    if (task.alternativeOf !== undefined && tasksById.has(task.alternativeOf.taskId)) {
      if (!putEdge({ from: task.id, to: task.alternativeOf.taskId, kind: 'alternativeOf', advisory: true })) {
        unfinished.push(`alternativeOf 边超帽截断：${task.id}→${task.alternativeOf.taskId}`);
      }
    }
  }

  // ③ file 源（桥接，零复制）
  const fileEdgesSeen = new Set<string>();
  for (const task of tasksById.values()) {
    if (task.localPath === undefined) continue;
    let neighborhood: { nodes: readonly GraphFileNode[]; edges: readonly GraphFileEdge[] };
    try {
      neighborhood = input.fileGraphOf(task.id);
    } catch {
      continue; // T0.6 域不可用 ⇒ 文件层留空（goal/task 层完整），不致命
    }
    for (const file of neighborhood.nodes) {
      putNode({
        id: `${FILE_PREFIX}${file.path}`,
        kind: 'file',
        ref: file.path,
        rootGoalId: rootGoalOf(task.goalId, goalsById),
        label: truncateLabel(file.path, maxLabelChars),
        // 只引存在性+scanId（J8：语义标注/可信度 hints 留 T0.6，展示层回查）
        status: `${file.ignored ? 'ignored' : 'scanned'}@${file.lastScanId}`,
        depth: 0,
      });
    }
    for (const edge of neighborhood.edges) {
      const key = `${edge.from}#${edge.kind}#${edge.to}`;
      if (fileEdgesSeen.has(key)) continue;
      fileEdgesSeen.add(key);
      const kind: GraphEdgeKind =
        edge.kind === 'depends-on' ? 'dependsOn' : edge.kind === 'related-to' ? 'relatedTo' : 'supersedesFile';
      if (!putEdge({ from: `${FILE_PREFIX}${edge.from}`, to: `${FILE_PREFIX}${edge.to}`, kind, advisory: false })) {
        unfinished.push(`file 边超帽截断：${edge.from}→${edge.to}`);
      }
    }
  }

  if (truncated && unfinished.length === 0) {
    unfinished.push('投影超容量帽（maxNodes/maxEdges），部分节点/边未入谱');
  }
  return { nodes, edges, truncated, unfinished };
}

/**
 * 合并图无环复核（J9；纯函数）：非 advisory 边（parent/blockedBy/dependsOn/
 * relatedTo/supersedesFile）成环 ⇒ 返回环路径；advisory（alternativeOf）豁免。
 */
export function detectCycle(
  nodes: ReadonlyMap<string, unknown>,
  edges: ReadonlyMap<string, GraphEdge>,
): readonly string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges.values()) {
    if (edge.advisory) continue;
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  const walk = (current: string): readonly string[] | null => {
    if (done.has(current)) return null;
    if (visiting.has(current)) {
      const start = path.indexOf(current);
      return path.slice(start === -1 ? 0 : start).concat(current);
    }
    visiting.add(current);
    path.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const cycle = walk(next);
      if (cycle !== null) return cycle;
    }
    path.pop();
    visiting.delete(current);
    done.add(current);
    return null;
  };
  for (const id of nodes.keys()) {
    const cycle = walk(id);
    if (cycle !== null) return cycle;
  }
  return null;
}

// ── 视图类型 ───────────────────────────────────────────────────────────

export interface SubtreeView {
  readonly rootGoalId: string;
  readonly goals: readonly GraphNode[];
  readonly tasks: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly truncated: boolean;
  readonly unfinished?: readonly string[];
  readonly staleAt?: number | undefined;
}

export interface TreeAnnotation {
  readonly id: string;
  readonly stagePath: readonly string[];
  readonly zone: string;
  readonly runCount: number;
}

export interface TreeSpectrumView extends SubtreeView {
  readonly focusGoalId?: string | undefined;
  readonly annotations: readonly TreeAnnotation[];
}

export interface TaskGraphView {
  readonly task: GraphNode;
  readonly blockedBy: readonly string[];
  readonly blocking: readonly string[];
  readonly alternatives: readonly string[];
  readonly children: readonly string[];
  readonly files: FileGraphView;
}

export interface FileGraphView {
  readonly nodes: readonly { readonly id: string; readonly path: string; readonly status: string }[];
  readonly edges: readonly GraphEdge[];
}

export interface CrossGoalEdge {
  readonly from: string;
  readonly to: string;
  readonly fromGoalId: string;
  readonly toGoalId: string;
}

export interface ExportScope {
  readonly rootGoalId?: string;
  readonly kinds?: readonly GraphNodeKind[];
}

export interface RebuildReport {
  readonly nodes: number;
  readonly edges: number;
  readonly truncated: boolean;
  readonly unfinished: readonly string[];
  readonly durationMs: number;
}

// ── 服务实现 ────────────────────────────────────────────────────────────

export interface TaskGraphService {
  initialize(): Promise<void>;
  rebuild(): Promise<RebuildReport>;
  /** goal 侧/tick 对账（J3：全量重算，goal 数量级小全量便宜；幂等）。 */
  reconcile(): Promise<RebuildReport>;
  subtree(rootGoalId?: string): SubtreeView;
  treeView(rootGoalId?: string): TreeSpectrumView;
  taskGraph(taskId: string): TaskGraphView;
  blockedChain(taskId: string): readonly string[];
  crossGoalDependencies(): readonly CrossGoalEdge[];
  fileGraph(taskId: string): FileGraphView;
  export(format: 'json' | 'dot', scope?: ExportScope): string;
  stats(): { nodes: number; edges: number; state: GraphState; truncated: boolean };
  params(): GraphParams;
  setParams(actor: 'human' | 'lead', patch: Partial<Omit<GraphParams, 'revision'>>): Promise<GraphParams>;
}

export function createGraphService(deps: GraphDeps): TaskGraphService {
  const clock = deps.now ?? ((): number => Date.now());
  const dualContext: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
  };

  let chain: Promise<unknown> = Promise.resolve();
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const nodesTable = () => deps.domain.table('graph_nodes');
  const edgesTable = () => deps.domain.table('graph_edges');
  const paramsTable = () => deps.domain.table('graph_params');

  let state: GraphState = 'stale';
  let failReason = '';
  let staleAt: number | undefined;
  let lastTruncated = false;

  const readParams = (): GraphParams => {
    const stored = paramsTable().get(GRAPH_PARAMS_KEY);
    if (stored !== undefined) return stored;
    return { ...DEFAULT_GRAPH_PARAMS, ...deps.config, revision: 0 };
  };

  const seedParams = async (): Promise<void> => {
    if (paramsTable().get(GRAPH_PARAMS_KEY) !== undefined) return;
    const params: GraphParams = { ...DEFAULT_GRAPH_PARAMS, ...deps.config, revision: 0 };
    await dualWriteDerived(async () => {
      await paramsTable().put(GRAPH_PARAMS_KEY, params);
    }, dualContext);
  };

  const assertHealthy = (): void => {
    if (state === 'failed') {
      throw new TdaError('GRAPH_UNHEALTHY', `图谱投影不健康（${failReason}），禁返回可疑投影（J9 fail-loud）`);
    }
  };

  /** 清空两张派生表（TdaKvTable 无 clear，逐键 delete；重建前必调）。 */
  const clearProjection = async (): Promise<void> => {
    for (const key of [...nodesTable().keys()]) {
      await nodesTable().delete(key);
    }
    for (const key of [...edgesTable().keys()]) {
      await edgesTable().delete(key);
    }
  };

  /** 权威域快照 → 投影 → 派生写（可整表重建：先清后写）。 */
  const rebuildInternal = async (): Promise<RebuildReport> => {
    const startedAt = clock();
    const params = readParams();
    const projection = buildProjection({
      goals: deps.goal.tree(),
      tasks: deps.taskPool.list(),
      fileGraphOf: (taskId) => deps.workspace.graph(taskId),
      params,
    });

    // J9 无环复核 fail-loud：成环 ⇒ 清投影 + failed 显式终态（禁半成品）
    const cycle = detectCycle(projection.nodes, projection.edges);
    if (cycle !== null) {
      await clearProjection();
      state = 'failed';
      failReason = `合并图成环：${cycle.join(' → ')}`;
      throw new TdaError('GRAPH_CYCLE', failReason);
    }

    // 派生写：整表重建（audit_index 模式：删光重建零差异可证）
    await dualWriteDerived(async () => {
      await clearProjection();
      for (const node of projection.nodes.values()) {
        await nodesTable().put(node.id, node);
      }
      for (const [key, edge] of projection.edges) {
        await edgesTable().put(key, edge);
      }
    }, dualContext);

    state = 'fresh';
    staleAt = undefined;
    failReason = '';
    lastTruncated = projection.truncated;
    return {
      nodes: projection.nodes.size,
      edges: projection.edges.size,
      truncated: projection.truncated,
      unfinished: projection.unfinished,
      durationMs: Math.max(0, clock() - startedAt),
    };
  };

  /** 子树视图（贯通树：root → 子目标 → 任务；深度按子树内计）。 */
  const subtreeView = (rootGoalId?: string): SubtreeView => {
    assertHealthy();
    const nodes = nodesTable();
    const edges = edgesTable();
    // 无 root ⇒ 全图（根目标 = 无 goal-parent 入边的 goal 节点）
    let root = rootGoalId;
    if (root === undefined) {
      root = [...tableValues(nodes)]
        .filter((node) => node.kind === 'goal')
        .find((node) => ![...tableValues(edges)].some((edge) => edge.kind === 'parent' && edge.to === node.id))?.id;
      if (root === undefined) {
        return { rootGoalId: '', goals: [], tasks: [], edges: [], truncated: false, ...(staleAt !== undefined ? { staleAt } : {}) };
      }
    }
    const nodeMap = new Map(tableValues(nodes).map((node) => [node.id, node] as const));
    const goalIds = subtreeGoalIds(root, nodeMap);
    const goals = tableValues(nodes)
      .filter((node) => node.kind === 'goal' && goalIds.has(node.id))
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    const tasks = tableValues(nodes).filter(
      (node) => node.kind === 'task' && node.rootGoalId !== undefined && goalIds.has(node.rootGoalId),
    );
    const taskIds = new Set(tasks.map((task) => task.id));
    const edgesInView = tableValues(edges).filter(
      (edge) => goalIds.has(edge.from) || goalIds.has(edge.to) || taskIds.has(edge.from) || taskIds.has(edge.to),
    );
    const depths = subtreeDepthOf(root, nodeMap, new Map(edgesInView.map((edge) => [edgeKey(edge), edge] as const)));
    const withDepth = (node: GraphNode): GraphNode => ({ ...node, depth: depths.get(node.id) ?? 0 });
    return {
      rootGoalId: root,
      goals: goals.map(withDepth),
      tasks: tasks.map(withDepth),
      edges: edgesInView,
      truncated: lastTruncated,
      ...(staleAt !== undefined ? { staleAt } : {}),
    };
  };

  /** 文件邻域视图（J6 零复制桥接；只引 id/路径/scanId，不携语义标注）。 */
  const fileGraphView = (taskId: string): FileGraphView => {
    assertHealthy();
    const neighborhood = deps.workspace.graph(taskId);
    return {
      nodes: neighborhood.nodes.map((file) => ({
        id: `${FILE_PREFIX}${file.path}`,
        path: file.path,
        status: `${file.ignored ? 'ignored' : 'scanned'}@${file.lastScanId}`,
      })),
      edges: neighborhood.edges.map((edge) => ({
        from: `${FILE_PREFIX}${edge.from}`,
        to: `${FILE_PREFIX}${edge.to}`,
        kind: (edge.kind === 'depends-on' ? 'dependsOn' : edge.kind === 'related-to' ? 'relatedTo' : 'supersedesFile') as GraphEdgeKind,
        advisory: false,
      })),
    };
  };

  /** 子树目标集（root + 全部后代，经 goal parent 边向下）。 */
  const subtreeGoalIds = (rootGoalId: string, allGoals: ReadonlyMap<string, GraphNode>): Set<string> => {
    const subtreeGoalIds = new Set<string>([rootGoalId]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of tableValues(deps.domain.table('graph_edges'))) {
        if (edge.kind !== 'parent' || edge.advisory) continue;
        if (subtreeGoalIds.has(edge.from) && !subtreeGoalIds.has(edge.to) && allGoals.get(edge.to)?.kind === 'goal') {
          subtreeGoalIds.add(edge.to);
          changed = true;
        }
      }
    }
    return subtreeGoalIds;
  };

  const subtreeDepthOf = (rootGoalId: string, nodes: ReadonlyMap<string, GraphNode>, edges: ReadonlyMap<string, GraphEdge>): Map<string, number> => {
    const depths = new Map<string, number>([[rootGoalId, 0]]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of edges.values()) {
        if (edge.kind !== 'parent' || edge.advisory) continue;
        const parentDepth = depths.get(edge.from);
        if (parentDepth !== undefined && !depths.has(edge.to)) {
          depths.set(edge.to, parentDepth + 1);
          changed = true;
        }
      }
    }
    // 任务深度 = 归属目标深度 + 1（任务层统一一层偏移）
    for (const node of tableValues(nodes)) {
      if (node.kind === 'task' && node.rootGoalId !== undefined) {
        const goalDepth = depths.get(node.rootGoalId) ?? 0;
        depths.set(node.id, goalDepth + 1);
      }
    }
    return depths;
  };

  return {
    async initialize() {
      return withLock(async () => {
        await seedParams();
        await rebuildInternal();
      });
    },

    async rebuild() {
      return withLock(async () => rebuildInternal());
    },

    async reconcile() {
      return withLock(async () => rebuildInternal());
    },

    subtree(rootGoalId) {
      return subtreeView(rootGoalId);
    },

    treeView(rootGoalId) {
      const view = subtreeView(rootGoalId);
      const focus = deps.goal.tree().find((goal) => goal.focus);
      const tasksById = new Map(view.tasks.map((task) => [task.id, task]));
      // 谱系标注：stage 迁移路径（当前 stage 与 zone/runCount 快照；stage 历史
      // 归 T0.2 history 面，本投影只携带当前态——J8 同款"只引不复制"）
      const annotations: TreeAnnotation[] = view.tasks.map((task) => {
        const live = deps.taskPool.get(task.ref);
        const stagePath: string[] = [];
        let current: GraphTaskView | undefined = live;
        for (let hop = 0; hop < 32 && current !== undefined; hop += 1) {
          stagePath.unshift(current.stage);
          current = current.parentTaskId !== undefined ? deps.taskPool.get(current.parentTaskId) : undefined;
        }
        return {
          id: task.id,
          stagePath,
          zone: tasksById.get(task.id)?.status.split('/')[1] ?? 'normal',
          runCount: 0, // runCount 归 T0.2 实况，投影不复制计数（展示层经 taskGraph 回查）
        };
      });
      return {
        ...view,
        ...(focus !== undefined ? { focusGoalId: focus.id } : {}),
        annotations,
      };
    },

    taskGraph(taskId) {
      assertHealthy();
      const task = nodesTable().get(taskId);
      if (task === undefined) {
        throw new TdaError('TASK_NOT_IN_GRAPH', `任务 ${taskId} 不在图谱投影中（不存在或已删除）`);
      }
      const blockedBy: string[] = [];
      const blocking: string[] = [];
      const alternatives: string[] = [];
      const children: string[] = [];
      for (const edge of tableValues(edgesTable())) {
        if (edge.kind === 'blockedBy') {
          if (edge.from === taskId) blockedBy.push(edge.to);
          if (edge.to === taskId) blocking.push(edge.from);
        }
        if (edge.kind === 'alternativeOf') {
          if (edge.from === taskId) alternatives.push(edge.to);
        }
        if (edge.kind === 'parent' && edge.from === taskId) children.push(edge.to);
      }
      return {
        task,
        blockedBy,
        blocking,
        alternatives,
        children,
        files: fileGraphView(taskId),
      };
    },

    blockedChain(taskId) {
      assertHealthy();
      // 传递闭包（blockedBy 边：from=被挡任务 → to=阻塞者）；advisory 边豁免（J9④）
      const blockers = new Set<string>();
      const queue = [taskId];
      for (let hop = 0; hop < 1024 && queue.length > 0; hop += 1) {
        const current = queue.shift() as string;
        for (const edge of tableValues(edgesTable())) {
          if (edge.kind !== 'blockedBy' || edge.advisory) continue;
          if (edge.from !== current || blockers.has(edge.to)) continue;
          blockers.add(edge.to);
          queue.push(edge.to);
        }
      }
      blockers.delete(taskId);
      return [...blockers];
    },

    crossGoalDependencies() {
      assertHealthy();
      const result: CrossGoalEdge[] = [];
      for (const edge of tableValues(edgesTable())) {
        if (edge.kind !== 'blockedBy' || edge.advisory) continue;
        const fromTask = deps.taskPool.get(edge.from);
        const toTask = deps.taskPool.get(edge.to);
        if (fromTask === undefined || toTask === undefined) continue;
        if (fromTask.goalId !== toTask.goalId) {
          result.push({ from: edge.from, to: edge.to, fromGoalId: fromTask.goalId, toGoalId: toTask.goalId });
        }
      }
      return result;
    },

    fileGraph(taskId) {
      return fileGraphView(taskId);
    },

    export(format, scope) {
      assertHealthy();
      const allNodes = tableValues(nodesTable());
      const allEdges = tableValues(edgesTable());
      const nodes = scope?.kinds !== undefined ? allNodes.filter((node) => scope.kinds?.includes(node.kind)) : allNodes;
      const nodeIds = new Set(nodes.map((node) => node.id));
      const edges = allEdges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
      if (format === 'json') {
        return JSON.stringify(
          {
            exportedAt: clock(),
            truncated: lastTruncated,
            nodes,
            edges,
          },
          null,
          2,
        );
      }
      // dot（Graphviz）：shape 按 kind、advisory 虚线、truncated 附注释头
      const shapeOf = (kind: string): string => (kind === 'goal' ? 'ellipse' : kind === 'task' ? 'box' : 'note');
      const lines: string[] = ['digraph taskgraph {'];
      if (lastTruncated) lines.push('  // 注意：投影超容量帽，本图为截断视图（unfinished 见 stats/查询面）');
      for (const node of nodes) {
        lines.push(`  "${node.id}" [shape=${shapeOf(node.kind)}, label="${node.label.replace(/"/g, "'")}"];`);
      }
      for (const edge of edges) {
        const style = edge.advisory ? ', style=dashed' : '';
        lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.kind}"${style}];`);
      }
      lines.push('}');
      return lines.join('\n');
    },

    stats() {
      return {
        nodes: nodesTable().size(),
        edges: edgesTable().size(),
        state,
        truncated: lastTruncated,
      };
    },

    params() {
      return readParams();
    },

    async setParams(actor, patch) {
      return withLock(async () => {
        void actor;
        const current = readParams();
        const parsed = GraphParamsSchema.parse({ ...current, ...patch, revision: current.revision + 1 });
        await dualWriteDerived(async () => {
          await paramsTable().put(GRAPH_PARAMS_KEY, parsed);
        }, dualContext);
        return parsed;
      });
    },
  };
}

