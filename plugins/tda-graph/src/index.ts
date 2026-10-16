/**
 * tda-graph 插件出口（T4.3 §4.2）。
 *
 * **J1 的两个落点都在本文件可见**：
 *  - `TdaPluginContext` 的 goal/taskPool/workspace 全是**只读方法 seam**
 *    （tree/get/list/graph——编译期即无权威写路径）；
 *  - apply 里注册的 `graph-zero-write-surface` 检查（运行时复核装配没塞写面）。
 *
 * 装配层接线（harness runtime）：
 *  - boot：`initialize()` 全量重建（先于不变量注册）；
 *  - tick：goal 侧 `reconcile()` 重算阶段（J3；goal 数量级小全量便宜）；
 *  - 快速路径：bus 订阅 `taskPool/change` → `reconcile()`（任务侧增量触发）；
 *  - 不产事件（J10）：派生写走 `dualWriteDerived`，replayCheck sources 不含本插件。
 */
import {
  createAuditIndex,
  createDualWriteReconciler,
  openTdaDomain,
  registerTdaInvariants,
  type TdaDomain,
  type TdaEventBus,
  type TdaInvariantRegistry,
  type TdaStorageBackend,
} from '@tda/kernel';
import {
  graphDomainSpec,
  type GraphTables,
} from './domain.ts';
import {
  createGraphService,
  type GraphDeps,
  type GraphGoalSeam,
  type GraphTaskSeam,
  type GraphWorkspaceSeam,
  type TaskGraphService,
} from './service.ts';
import { registerGraphInvariants } from './loadChecks.ts';

export {
  graphDomainSpec,
  GraphNodeSchema,
  GraphEdgeSchema,
  GraphParamsSchema,
  DEFAULT_GRAPH_PARAMS,
  GRAPH_PARAMS_KEY,
  GRAPH_PARAMS_BUSINESS_ID,
  GRAPH_STATES,
  GRAPH_NODE_KINDS,
  GRAPH_EDGE_KINDS,
  type GraphTables,
  type GraphNode,
  type GraphNodeKind,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphParams,
  type GraphState,
} from './domain.ts';
export { edgeKey, truncateLabel } from './domain.ts';
export {
  createGraphService,
  buildProjection,
  detectCycle,
  rootGoalOf,
  type TaskGraphService,
  type GraphDeps,
  type GraphGoalSeam,
  type GraphGoalView,
  type GraphTaskSeam,
  type GraphTaskView,
  type GraphWorkspaceSeam,
  type GraphFileNode,
  type GraphFileEdge,
  type Projection,
  type ProjectionInput,
  type SubtreeView,
  type TreeSpectrumView,
  type TreeAnnotation,
  type TaskGraphView,
  type FileGraphView,
  type CrossGoalEdge,
  type ExportScope,
  type RebuildReport,
} from './service.ts';
export { registerGraphInvariants, graphInvariantChecks } from './loadChecks.ts';

export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly goal: GraphGoalSeam;
  readonly taskPool: GraphTaskSeam;
  readonly workspace: GraphWorkspaceSeam;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly config?: Partial<import('./domain.ts').GraphParams>;
}

export interface TdaGraphHandle {
  readonly service: TaskGraphService;
  readonly domain: TdaDomain<GraphTables>;
  dispose(): Promise<void>;
}

export interface TdaGraphPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaGraphHandle>;
}

export const tdaGraphPlugin: TdaGraphPlugin = {
  name: 'tda-graph',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    void index; // 派生层不产事件、不入 audit_index（J10；保留字段位以对齐插件装配形态）
    const domain = await openTdaDomain(graphDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const deps: GraphDeps = {
      domain,
      goal: ctx.goal,
      taskPool: ctx.taskPool,
      workspace: ctx.workspace,
      reconciler,
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    };
    const service = createGraphService(deps);
    // 启动序：boot 全量重建（先于不变量注册，纪律 #7）
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerGraphInvariants(ctx.invariants, domain, { service });
    // J3 快速路径：任务侧 bus 订阅（taskPool/change 在总线上）→ 全量重算
    // （重建幂等且 O(N) 便宜；goal 侧无总线发布，靠 tick reconcile 兜底）。
    // **catch 必须显式**：dispose 后回声事件仍会触发本回调（domain 已关），
    // 快速路径是尽力而为的旁路——失败静默，tick reconcile 才是兜底主路径。
    const unsubscribe = ctx.bus?.subscribe('taskPool/change', () => {
      service.reconcile().catch(() => undefined);
    });
    return {
      service,
      domain,
      async dispose() {
        unsubscribe?.();
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
