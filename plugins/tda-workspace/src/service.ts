/**
 * tda-workspace 服务：ctx.workspace 服务面实现（T0.6 §4.2）。
 *
 * scan 内部序（规格 §4.2 原文，逐条落地）：
 *   ① 校验 localPath（规范化 + 逃逸判定）→ ② inventory 采集（三级 cache 比对）
 *   → ③ 变化集批注（经 T0.5 Sidekick seam，未装配则降级为确定性单层）
 *   → ④ 更新图谱（节点/边 upsert + 陈旧项剔除，同一次写窗口）
 *   → ⑤ 两条 timeline chunk（execution-verified inventory + model-produced notes）
 *   → ⑥ ScanRun 终态（超限 → truncated + failed + unfinished，C5 不静默截断）。
 *
 * 两条硬纪律：
 *  - **文件正文永不出本插件**（J1/不变量 2）：正文只进 `annotator` seam（子代理），
 *    落域的只有 size/mtime/hash/ext 与派生角色，事件与时间线只带摘要；
 *  - **图谱是派生视图**（不变量 8）：重扫即刷新（陈旧节点/边在写窗口内剔除），
 *    与 `ws_scan_runs` 的 append-only 历史并存不悖。
 */
import {
  allocateId,
  dualWrite,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type ScanId,
  type SessionId,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  isSafeRelativePath,
  nodeKey,
  edgeKey,
  type CredibilityHint,
  type EdgeKind,
  type FileNode,
  type FileRole,
  type GraphEdge,
  type ScanCache,
  type ScanMode,
  type ScanRun,
  type WorkspaceTables,
} from './domain.ts';
import { workspaceScanPayload } from './events.ts';
import { DEFAULT_SKIP_DIRS, type FsEntry, type GitProbe, type WorkspaceFs } from './fs.ts';
import {
  assessCredibility,
  changedPaths,
  deriveExplicitEdges,
  deriveSupersedesEdges,
  extOf,
  guessRole,
  normalizeScanRoot,
} from './scan.ts';

/** 文件级忽略规则（仍登记，但不参与标注——目录级 skip 见 fs seam）。 */
export const IGNORE_FILE_PATTERNS: readonly RegExp[] = [
  /\.log$/i,
  /\.pyc$/i,
  /\.tmp$/i,
  /\.map$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.DS_Store$/i,
];

export const ignoredByPattern = (path: string): boolean =>
  IGNORE_FILE_PATTERNS.some((pattern) => pattern.test(path));

/** 任务池 seam（ctx.taskPool 的结构子集；扫描根 = task.localPath，J2）。 */
export interface WorkspaceTaskView {
  readonly id: string;
  readonly revision: number;
  readonly goalId: string;
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete';
  readonly localPath?: string | undefined;
  readonly writeScopes: readonly string[];
}

export interface WorkspaceTaskSeam {
  get(id: string): WorkspaceTaskView | undefined;
}

/** Sidekick 语义标注结论（T0.5 `sidekick-conclusion` 的工作区扩展字段）。 */
export interface SidekickFileAnnotation {
  readonly path: string;
  readonly role: FileRole;
  readonly credibilityHint: CredibilityHint;
}

export interface SidekickAnnotatedEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly confidence: number;
  readonly evidence: string;
}

export interface SidekickAnnotationValue {
  readonly files: readonly SidekickFileAnnotation[];
  readonly edges: readonly SidekickAnnotatedEdge[];
  readonly notes?: readonly string[];
}

export interface SidekickAnnotationRequest {
  readonly taskId: string;
  readonly goalId: string;
  readonly scanId: string;
  /** 只含"变化文件清单（路径 + 头部片段摘要）"，不含主上下文（承 T0.5 J2）。 */
  readonly files: readonly { readonly path: string; readonly head: string }[];
}

export interface SidekickAnnotationOutcome {
  readonly ok: boolean;
  readonly structured?: SidekickAnnotationValue | undefined;
  readonly error?: string | undefined;
  readonly orderId?: string | undefined;
  readonly childSessionId?: string | undefined;
}

/** T0.5 dispatch 的 workspace 侧切片（装配层接线；未装配则降级为确定性单层）。 */
export interface SidekickAnnotator {
  annotate(req: SidekickAnnotationRequest): Promise<SidekickAnnotationOutcome>;
}

/** 时间线 seam（ctx.timeline.append 的结构子集）。 */
export interface WorkspaceTimelineSeam {
  append(
    writer: { readonly sessionId: string; readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly at: number },
    chunk: {
      readonly content: string;
      readonly chunkType: 'fact' | 'method' | 'reflection' | 'skill';
      readonly source: 'task' | 'conversation' | 'study' | 'harness';
      readonly credential: 'user-original' | 'execution-verified' | 'model-produced' | 'tool-output' | 'external-content';
      readonly relatedTaskId?: string;
      readonly trajectoryLink?: string;
      readonly confidence?: number;
    },
  ): Promise<{ readonly id: string }>;
}

export interface WorkspaceConfig {
  /** workspace 绝对根（localPath 相对它解析）。 */
  readonly root: string;
  readonly skipDirs?: readonly string[];
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly hashMaxBytes?: number;
  readonly headBytes?: number;
  /** 单次扫描解析显性依赖的最大文件数（本地读头，便宜）。 */
  readonly headMaxFiles?: number;
  /** 单次扫描送给 Sidekick 的批注上限（防 LLM 成本侵蚀主任务，J7）。 */
  readonly annotateMaxFiles?: number;
}

export interface WorkspaceCaller {
  readonly actor: 'agent' | 'human' | 'coach' | 'scheduler';
  readonly sessionId: SessionId;
}

export interface ScanRequest {
  readonly taskId: string;
  readonly mode?: ScanMode;
  readonly maxFiles?: number;
}

export interface FileFilter {
  readonly role?: FileRole;
  readonly ignored?: boolean;
  readonly credibilityHint?: CredibilityHint;
  readonly changedIn?: ScanId;
}

export interface EdgeFilter {
  readonly kind?: EdgeKind;
  readonly confidenceMin?: number;
}

export interface WorkspaceSection {
  readonly id: 'workspace:hints';
  readonly order: { readonly after: 'task:state' };
  readonly content: string;
}

export interface WorkspaceService {
  scan(caller: WorkspaceCaller, req: ScanRequest): Promise<ScanRun>;
  files(taskId: string, filter?: FileFilter): FileNode[];
  edges(taskId: string, filter?: EdgeFilter): GraphEdge[];
  graph(taskId: string): { readonly nodes: FileNode[]; readonly edges: GraphEdge[] };
  runs(taskId: string): readonly ScanRun[];
  /** J4：可信度**提示**清单（供 T0.4 memo/injection 摘要；不作知识固化依据）。 */
  hints(taskId: string): { readonly path: string; readonly credibilityHint: CredibilityHint }[];
  section(): WorkspaceSection;
}

export interface WorkspaceDeps {
  readonly domain: TdaDomain<WorkspaceTables>;
  readonly session: TdaSessionSink;
  readonly fs: WorkspaceFs;
  readonly config: WorkspaceConfig;
  readonly taskPool?: WorkspaceTaskSeam;
  readonly annotator?: SidekickAnnotator;
  readonly timeline?: WorkspaceTimelineSeam;
  readonly gitProbe?: GitProbe;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
}

const DEFAULTS = {
  maxFiles: 2_000,
  maxBytes: 64 * 1024 * 1024,
  hashMaxBytes: 256 * 1024,
  headBytes: 4 * 1024,
  headMaxFiles: 500,
  annotateMaxFiles: 50,
} as const;

export function createWorkspaceService(deps: WorkspaceDeps): WorkspaceService {
  const nodes = deps.domain.table('ws_file_nodes');
  const edgesTable = deps.domain.table('ws_graph_edges');
  const runs = deps.domain.table('ws_scan_runs');
  const cacheTable = deps.domain.table('ws_scan_cache');
  const clock = deps.now ?? ((): number => Date.now());

  const config = {
    root: deps.config.root,
    skipDirs: deps.config.skipDirs ?? DEFAULT_SKIP_DIRS,
    maxFiles: deps.config.maxFiles ?? DEFAULTS.maxFiles,
    maxBytes: deps.config.maxBytes ?? DEFAULTS.maxBytes,
    hashMaxBytes: deps.config.hashMaxBytes ?? DEFAULTS.hashMaxBytes,
    headBytes: deps.config.headBytes ?? DEFAULTS.headBytes,
    headMaxFiles: deps.config.headMaxFiles ?? DEFAULTS.headMaxFiles,
    annotateMaxFiles: deps.config.annotateMaxFiles ?? DEFAULTS.annotateMaxFiles,
  };

  const context: DualWriteContext = {
    ...(deps.reconciler ? { reconciler: deps.reconciler } : {}),
    ...(deps.index ? { index: deps.index } : {}),
  };

  /** 同任务扫描串行（不变量 7）：进程内 per-task 队列。 */
  const chains = new Map<string, Promise<unknown>>();
  const withTaskLock = async <T>(taskId: string, op: () => Promise<T>): Promise<T> => {
    const previous = chains.get(taskId) ?? Promise.resolve();
    const result = previous.then(op, op);
    chains.set(
      taskId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };

  const requireTask = (taskId: string): WorkspaceTaskView => {
    const task = deps.taskPool?.get(taskId);
    if (task === undefined) {
      throw new TdaError('WORKSPACE_TASK_NOT_FOUND', `任务不存在（无法锚定扫描根）：${taskId}`);
    }
    if (task.localPath === undefined || task.localPath === '') {
      throw new TdaError('WORKSPACE_NO_LOCAL_PATH', `任务 ${taskId} 未声明 localPath，无法扫描（T0.2 localPath 是扫描起点）`);
    }
    return task;
  };

  /** 逃逸判定（不变量 1）：realpath(root/localPath) 必须落在 realpath(root) 之内。 */
  const resolveRoot = async (localPath: string): Promise<string> => {
    const relativePath = normalizeScanRoot(localPath);
    const realRoot = await deps.fs.realpath(config.root);
    let realTarget: string;
    try {
      realTarget = await deps.fs.realpath(joinPath(realRoot, relativePath));
    } catch {
      // 根不存在：仍允许（walk 会返回空集），但不得绕过前缀判定
      realTarget = joinPath(realRoot, relativePath);
    }
    const normalizedRoot = realRoot.replace(/[\\/]+$/, '');
    if (realTarget !== normalizedRoot && !realTarget.startsWith(`${normalizedRoot}/`) && !realTarget.startsWith(`${normalizedRoot}\\`)) {
      throw new TdaError('UNSAFE_PATH', `扫描根逃逸 workspace（符号链接逃逸？）：${localPath} → ${realTarget}`);
    }
    return relativePath;
  };

  const scanInternal = async (caller: WorkspaceCaller, req: ScanRequest): Promise<ScanRun> =>
    withTaskLock(req.taskId, async () => {
      const task = requireTask(req.taskId);
      const startedAt = clock();
      const mode: ScanMode = req.mode ?? 'incremental';
      const maxFiles = req.maxFiles ?? config.maxFiles;
      const relativeRoot = await resolveRoot(task.localPath ?? '');

      // ── ② inventory 采集（确定性；零 LLM） ──
      // 路径基准纪律：fs seam 的 walk 返回**相对扫描根**的路径；本插件对外一律用
      // **workspace 相对**路径（前缀 = task.localPath）。换算在此一次完成，
      // 下游（图谱/边/缓存/时间线）只认 workspace 相对路径——杜绝两套基准混用。
      const scanRoot = joinPath(config.root, relativeRoot);
      const wsOf = (input: string): string => (relativeRoot === "" ? input : `${relativeRoot}/${input}`);
      const walk = await deps.fs.walk(scanRoot, { maxFiles, skip: config.skipDirs });
      const absByPath = new Map<string, string>();
      const rawEntries = walk.entries.map((entry) => {
        const workspacePath = wsOf(entry.path);
        absByPath.set(workspacePath, joinPath(scanRoot, entry.path));
        return { path: workspacePath, size: entry.size, mtime: entry.mtime };
      });
      const totalBytes = rawEntries.reduce((sum, entry) => sum + entry.size, 0);
      const byteTruncated = totalBytes > config.maxBytes;
      const truncated = walk.truncated || byteTruncated;
      const unfinished: string[] = walk.unfinished.map(wsOf);
      if (byteTruncated) {
        unfinished.push(`累计字节 ${totalBytes} 超上限 ${config.maxBytes}`);
      }

      const trackedRaw = await deps.gitProbe?.tracked(scanRoot);
      const tracked = trackedRaw === undefined ? undefined : new Set([...trackedRaw].map(wsOf));
      const entries: (FsEntry & { readonly contentHash?: string; readonly gitTracked?: boolean })[] = [];
      for (const entry of rawEntries) {
        const absolute = absByPath.get(entry.path) ?? joinPath(scanRoot, entry.path);
        const contentHash = entry.size <= config.hashMaxBytes ? await deps.fs.hashFile(absolute) : undefined;
        entries.push({
          ...entry,
          ...(contentHash !== undefined ? { contentHash } : {}),
          ...(tracked?.has(entry.path) === true ? { gitTracked: true } : {}),
        });
      }

      const cache = new Map<string, ScanCache | undefined>();
      for (const entry of entries) {
        cache.set(entry.path, cacheTable.get(nodeKey(task.id, entry.path)));
      }
      const marked = changedPaths(entries, cache, mode);
      const changedSet = new Set(marked);
      const changedAnnotatable = entries.filter((entry) => changedSet.has(entry.path) && !ignoredByPattern(entry.path));

      // 确定性部分（本地解析）与 LLM 部分（Sidekick 批注）的上限**分开**：
      // 前者便宜（只读文件头），后者付 token 成本（J7：批注上限防 LLM 成本侵蚀主任务）
      const headScope = changedAnnotatable.slice(0, config.headMaxFiles);
      if (changedAnnotatable.length > headScope.length) {
        unfinished.push(
          `显性依赖解析仅覆盖前 ${headScope.length}/${changedAnnotatable.length} 个变化文件（headMaxFiles 上限）`,
        );
      }
      const annotatable = headScope.slice(0, config.annotateMaxFiles);
      if (headScope.length > annotatable.length) {
        unfinished.push(
          `语义标注仅覆盖前 ${annotatable.length}/${headScope.length} 个变化文件（annotateMaxFiles 上限）`,
        );
      }

      // ── ③ 变化集批注（经 T0.5；未装配或失败即显式降级，不静默） ──
      const heads = new Map<string, string>();
      for (const entry of headScope) {
        const absolute = absByPath.get(entry.path) ?? joinPath(scanRoot, entry.path);
        heads.set(entry.path, await deps.fs.readHead(absolute, config.headBytes));
      }
      const scanId = allocateId(runs, 'scan') as ScanId;
      let annotation: SidekickAnnotationValue | undefined;
      let childSessionId: string | undefined;
      if (deps.annotator !== undefined && annotatable.length > 0) {
        try {
          const outcome = await deps.annotator.annotate({
            taskId: task.id,
            goalId: task.goalId,
            scanId,
            files: [...heads.entries()].map(([path, head]) => ({ path, head })),
          });
          if (outcome.ok && outcome.structured !== undefined) {
            annotation = outcome.structured;
          } else {
            unfinished.push(`语义标注未完成：${outcome.error ?? '结论未过 schema 校验（按 partial 处理）'}`);
          }
          childSessionId = outcome.childSessionId;
        } catch (error) {
          unfinished.push(`语义标注失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (annotatable.length > 0) {
        unfinished.push(`语义标注未装配（无 Sidekick seam），${annotatable.length} 个变化文件仅做确定性采集`);
      }

      // ── ④ 图谱更新（节点/边；陈旧项剔除） ──
      const pathSet = new Set(entries.map((entry) => entry.path));
      const annotationByPath = new Map<string, SidekickFileAnnotation>();
      for (const item of annotation?.files ?? []) {
        if (pathSet.has(item.path)) annotationByPath.set(item.path, item);
      }
      const nodeRecords: FileNode[] = entries.map((entry) => {
        const annotated = annotationByPath.get(entry.path);
        return {
          taskId: task.id,
          path: entry.path,
          size: entry.size,
          mtime: entry.mtime,
          ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
          ext: extOf(entry.path),
          ignored: ignoredByPattern(entry.path),
          ...(entry.gitTracked !== undefined ? { gitTracked: entry.gitTracked } : {}),
          role: annotated?.role ?? guessRole(entry.path),
          credibilityHint:
            annotated?.credibilityHint ??
            assessCredibility({
              path: entry.path,
              mtime: entry.mtime,
              now: startedAt,
              ...(entry.gitTracked !== undefined ? { gitTracked: entry.gitTracked } : {}),
            }),
          lastScanId: scanId,
        };
      });

      const derived: GraphEdge[] = [
        ...deriveExplicitEdges(pathSet, heads).map((edge) => ({ taskId: task.id, ...edge })),
        ...deriveSupersedesEdges([...pathSet].sort()).map((edge) => ({ taskId: task.id, ...edge })),
      ];
      const annotatedEdges: GraphEdge[] = [];
      for (const edge of annotation?.edges ?? []) {
        if (!pathSet.has(edge.from) || !pathSet.has(edge.to) || edge.from === edge.to) continue;
        if (derived.some((existing) => existing.from === edge.from && existing.to === edge.to && existing.kind === edge.kind)) {
          continue;
        }
        annotatedEdges.push({
          taskId: task.id,
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          confidence: Math.max(0, Math.min(1, edge.confidence)),
          evidence: edge.evidence,
        });
      }
      const graphEdges = [...derived, ...annotatedEdges];

      // ── ⑤ 两条 timeline chunk（分证：execution-verified vs model-produced） ──
      let inventoryEntryId: string | undefined;
      let notesEntryId: string | undefined;
      if (deps.timeline !== undefined) {
        const inventory = await deps.timeline.append(
          { sessionId: String(caller.sessionId), actor: caller.actor, at: clock() },
          {
            content: JSON.stringify({
              kind: 'workspace-inventory',
              scanId,
              taskId: task.id,
              localPath: relativeRoot,
              mode,
              filesScanned: entries.length,
              filesChanged: marked.length,
              truncated,
              topLevels: [...new Set(entries.map((entry) => entry.path.split('/')[0]))].sort(),
            }),
            chunkType: 'fact',
            source: 'task',
            // 文件系统状态是执行验证过的事实（J6）
            credential: 'execution-verified',
            relatedTaskId: task.id,
            trajectoryLink: String(scanId),
            confidence: 1,
          },
        );
        inventoryEntryId = String(inventory.id);
        if (annotation !== undefined) {
          const notes = await deps.timeline.append(
            { sessionId: String(caller.sessionId), actor: caller.actor, at: clock() },
            {
              content: JSON.stringify({
                kind: 'workspace-notes',
                scanId,
                taskId: task.id,
                annotatedFiles: annotationByPath.size,
                edges: annotatedEdges.length,
                notes: [...(annotation.notes ?? [])],
              }),
              chunkType: 'reflection',
              source: 'task',
              // 语义标注是模型产出（低凭证；召回侧受 credentialMin 约束）
              credential: 'model-produced',
              relatedTaskId: task.id,
              trajectoryLink: childSessionId ?? String(scanId),
              confidence: 0.6,
            },
          );
          notesEntryId = String(notes.id);
        }
      }

      const finishedAt = clock();
      // C5：任何未完成（截断 / 标注降级 / 上限命中）都落 failed + unfinished，
      // 绝不"看起来成功"——recorded ⟺ 零 unfinished 是 schema 恒等律
      const status: ScanRun['status'] = truncated || unfinished.length > 0 ? 'failed' : 'recorded';
      const finalRun: ScanRun = {
        id: scanId,
        taskId: task.id,
        mode,
        status,
        startedAt,
        finishedAt,
        filesScanned: entries.length,
        filesChanged: marked.length,
        truncated,
        ...(unfinished.length > 0 ? { unfinished: [...unfinished] } : {}),
        ...(inventoryEntryId !== undefined ? { inventoryEntryId } : {}),
        ...(notesEntryId !== undefined ? { notesEntryId } : {}),
        ...(childSessionId !== undefined ? { childSessionId } : {}),
        localPath: relativeRoot,
        maxFiles,
        maxBytes: config.maxBytes,
      };

      // ── 单写窗口：图谱 + cache + 扫描历史一次落域（双写配对） ──
      const payload = workspaceScanPayload(finalRun);
      const staleNodes: string[] = [];
      for (const [key, node] of nodes.entries()) {
        if (node.taskId === task.id && !pathSet.has(node.path)) staleNodes.push(key);
      }
      const staleEdges: string[] = [];
      for (const [key, edge] of edgesTable.entries()) {
        if (edge.taskId !== task.id) continue;
        if (!pathSet.has(edge.from) || !pathSet.has(edge.to)) staleEdges.push(key);
      }

      const seq = await dualWrite(
        deps.session,
        {
          family: 'workspace/scan',
          businessId: finalRun.id,
          payload,
          domainWrite: async () => {
            for (const key of staleEdges) await edgesTable.delete(key);
            for (const key of staleNodes) await nodes.delete(key);
            for (const node of nodeRecords) await nodes.put(nodeKey(node.taskId, node.path), node);
            for (const edge of graphEdges) {
              await edgesTable.put(edgeKey(edge.taskId, edge.from, edge.to, edge.kind), edge);
            }
            for (const entry of entries) {
              await cacheTable.put(nodeKey(task.id, entry.path), {
                taskId: task.id,
                path: entry.path,
                size: entry.size,
                mtime: entry.mtime,
                ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
                lastScanId: scanId,
              });
            }
            await runs.put(finalRun.id, finalRun);
          },
        },
        context,
      );
      if (deps.bus !== undefined) {
        deps.bus.publish({
          family: 'workspace/scan',
          businessId: finalRun.id,
          payload,
          seq,
          sessionId: deps.session.sessionId,
        });
      }
      return finalRun;
    });

  return {
    scan: scanInternal,
    files: (taskId, filter) =>
      [...nodes.entries()]
        .map(([, node]) => node)
        .filter((node) => node.taskId === taskId)
        .filter((node) => {
          if (filter === undefined) return true;
          if (filter.role !== undefined && node.role !== filter.role) return false;
          if (filter.ignored !== undefined && node.ignored !== filter.ignored) return false;
          if (filter.credibilityHint !== undefined && node.credibilityHint !== filter.credibilityHint) return false;
          if (filter.changedIn !== undefined && node.lastScanId !== filter.changedIn) return false;
          return true;
        })
        .sort((a, b) => a.path.localeCompare(b.path)),
    edges: (taskId, filter) =>
      [...edgesTable.entries()]
        .map(([, edge]) => edge)
        .filter((edge) => edge.taskId === taskId)
        .filter((edge) => {
          if (filter === undefined) return true;
          if (filter.kind !== undefined && edge.kind !== filter.kind) return false;
          if (filter.confidenceMin !== undefined && edge.confidence < filter.confidenceMin) return false;
          return true;
        })
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind)),
    graph: (taskId) => ({
      nodes: [...nodes.entries()]
        .map(([, node]) => node)
        .filter((node) => node.taskId === taskId)
        .sort((a, b) => a.path.localeCompare(b.path)),
      edges: [...edgesTable.entries()]
        .map(([, edge]) => edge)
        .filter((edge) => edge.taskId === taskId)
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind)),
    }),
    runs: (taskId) =>
      [...runs.entries()]
        .map(([, run]) => run)
        .filter((run) => run.taskId === taskId)
        .sort((a, b) => a.startedAt - b.startedAt || String(a.id).localeCompare(String(b.id))),
    hints: (taskId) =>
      [...nodes.entries()]
        .map(([, node]) => node)
        .filter((node) => node.taskId === taskId && node.credibilityHint !== undefined)
        .map((node) => ({ path: node.path, credibilityHint: node.credibilityHint as CredibilityHint }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    section: () => {
      const all = [...nodes.entries()].map(([, node]) => node);
      const authoritative = all.filter((node) => node.credibilityHint === 'authoritative-likely').length;
      const drafts = all.filter((node) => node.credibilityHint === 'draft-likely').length;
      const files = all.length;
      return {
        id: 'workspace:hints',
        order: { after: 'task:state' },
        content:
          files === 0
            ? '（工作区尚未扫描）'
            : `工作区文件 ${files}：疑似权威源 ${authoritative}，疑似草稿 ${drafts}（提示非裁决，知识固化须经治理）`,
      };
    },
  };
}

/** posix 风格路径拼接（跨平台：Windows 上 node:path.join 会用 `\`）。 */
const joinPath = (base: string, relative: string): string => {
  const left = base.replace(/[\\/]+$/, '');
  const right = relative.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  if (right === '') return left;
  return `${left}/${right}`;
};

export { isSafeRelativePath };
