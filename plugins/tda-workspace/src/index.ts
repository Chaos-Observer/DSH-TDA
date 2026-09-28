/**
 * tda-workspace 插件出口（八文件模板：domain/events/fs/scan/service/link/loadChecks/index）。
 *
 * IT3 形态：框架无关——TdaPluginContext 是 Cordis ctx 的结构镜像
 * （storage / invariants / session 三槽 + 可选 bus / taskPool / annotator / timeline / fs / gitProbe）。
 * 接 DSH 时仅此文件把 TdaPluginContext 换成真实 ctx，其余零改动（决策点③可逆性）。
 *
 * T0.6 出口面：ctx.workspace（服务）+ domain + 时点扫描订阅手柄。
 * dispose 序固定：**退订 → drain → 关域**（在途扫描是已提交事实的回声）。
 */
import {
  createAuditIndex,
  createDualWriteReconciler,
  openTdaDomain,
  registerTdaInvariants,
  type TdaDomain,
  type TdaEventBus,
  type TdaInvariantRegistry,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { workspaceDomainSpec, type WorkspaceTables } from './domain.ts';
import { createNodeWorkspaceFs, type GitProbe, type WorkspaceFs } from './fs.ts';
import {
  createWorkspaceService,
  type SidekickAnnotator,
  type WorkspaceCaller,
  type WorkspaceConfig,
  type WorkspaceService,
  type WorkspaceTaskSeam,
  type WorkspaceTimelineSeam,
} from './service.ts';
import { registerWorkspaceInvariants } from './loadChecks.ts';
import { subscribeTaskScan, type TaskScanLinkHandle } from './link.ts';

export {
  workspaceDomainSpec,
  FileNodeSchema,
  GraphEdgeSchema,
  ScanRunSchema,
  ScanCacheSchema,
  FILE_ROLES,
  CREDIBILITY_HINTS,
  EDGE_KINDS,
  SCAN_MODES,
  SCAN_STATUSES,
  SCAN_OPERATIONS,
  isSafeRelativePath,
  nodeKey,
  edgeKey,
  type WorkspaceTables,
  type FileNode,
  type GraphEdge,
  type ScanRun,
  type ScanCache,
  type FileRole,
  type CredibilityHint,
  type EdgeKind,
  type ScanMode,
  type ScanStatus,
  type ScanOperation,
} from './domain.ts';
export { workspaceScanPayload } from './events.ts';
export {
  createNodeWorkspaceFs,
  toRelativePosix,
  DEFAULT_SKIP_DIRS,
  type WorkspaceFs,
  type GitProbe,
  type FsEntry,
  type WalkOptions,
  type WalkResult,
} from './fs.ts';
export {
  normalizeScanRoot,
  isIgnoredPath,
  extOf,
  guessRole,
  assessCredibility,
  extractExplicitDeps,
  resolveExisting,
  deriveExplicitEdges,
  deriveSupersedesEdges,
  changedPaths,
  type DerivedEdge,
} from './scan.ts';
export {
  createWorkspaceService,
  IGNORE_FILE_PATTERNS,
  ignoredByPattern,
  type WorkspaceService,
  type WorkspaceDeps,
  type WorkspaceConfig,
  type WorkspaceCaller,
  type WorkspaceTaskSeam,
  type WorkspaceTaskView,
  type WorkspaceTimelineSeam,
  type SidekickAnnotator,
  type SidekickAnnotationRequest,
  type SidekickAnnotationOutcome,
  type SidekickAnnotationValue,
  type SidekickFileAnnotation,
  type SidekickAnnotatedEdge,
  type ScanRequest,
  type FileFilter,
  type EdgeFilter,
  type WorkspaceSection,
} from './service.ts';
export { subscribeTaskScan, SCAN_TRIGGER_STAGES, type TaskScanLinkOptions, type TaskScanLinkHandle } from './link.ts';
export {
  registerWorkspaceInvariants,
  workspaceInvariantChecks,
  type WorkspaceInvariantOptions,
} from './loadChecks.ts';

/** Cordis ctx 的结构镜像（接 DSH 时替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  /** 工作区绝对根 + 上限配置（cordis.yml 可覆盖）。 */
  readonly workspace: WorkspaceConfig;
  /** 文件系统 seam（缺省 Node FS 实现）。 */
  readonly fs?: WorkspaceFs;
  /** git 版本线索探针（缺省不探测）。 */
  readonly gitProbe?: GitProbe;
  /** Sidekick 标注 seam（T0.5 dispatch 切片；未装配则降级为确定性单层）。 */
  readonly annotator?: SidekickAnnotator;
  readonly bus?: TdaEventBus;
  readonly taskPool?: WorkspaceTaskSeam;
  readonly timeline?: WorkspaceTimelineSeam;
  readonly now?: () => number;
  /** 时点扫描订阅（J8；缺省在有 bus 时开启）。 */
  readonly autoScan?: boolean;
  readonly onScanError?: (message: string) => void;
}

export interface TdaWorkspaceHandle {
  readonly service: WorkspaceService;
  readonly domain: TdaDomain<WorkspaceTables>;
  readonly link?: TaskScanLinkHandle;
  dispose(): Promise<void>;
}

export interface TdaWorkspacePlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaWorkspaceHandle>;
}

export const tdaWorkspacePlugin: TdaWorkspacePlugin = {
  name: 'tda-workspace',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(workspaceDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createWorkspaceService({
      domain,
      session: ctx.session,
      fs: ctx.fs ?? createNodeWorkspaceFs(),
      config: ctx.workspace,
      reconciler,
      index,
      ...(ctx.taskPool !== undefined ? { taskPool: ctx.taskPool } : {}),
      ...(ctx.annotator !== undefined ? { annotator: ctx.annotator } : {}),
      ...(ctx.timeline !== undefined ? { timeline: ctx.timeline } : {}),
      ...(ctx.gitProbe !== undefined ? { gitProbe: ctx.gitProbe } : {}),
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    });
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerWorkspaceInvariants(ctx.invariants, domain, {
      ...(ctx.taskPool !== undefined
        ? { taskLocalPath: (taskId: string): string | undefined => ctx.taskPool?.get(taskId)?.localPath }
        : {}),
    });
    const autoScan = ctx.autoScan ?? true;
    const caller: WorkspaceCaller = { actor: 'scheduler', sessionId: ctx.session.sessionId };
    const link =
      autoScan && ctx.bus !== undefined
        ? subscribeTaskScan({
            bus: ctx.bus,
            workspace: service,
            caller,
            ...(ctx.onScanError !== undefined ? { onError: ctx.onScanError } : {}),
          })
        : undefined;
    return {
      service,
      domain,
      ...(link !== undefined ? { link } : {}),
      async dispose() {
        // dispose 序固定：退订 → drain（等在途扫描）→ 关域
        link?.unsubscribe();
        await link?.drain();
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
