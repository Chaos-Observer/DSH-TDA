/**
 * tda-workspace 域定义（T0.6 §3 数据模型）：四张表，**全部是派生数据**。
 *
 *  - ws_file_nodes：文件节点（图谱节点，key = TaskId#path）
 *  - ws_graph_edges：图谱边（key = TaskId#from#to#kind；重扫可重写）
 *  - ws_scan_runs：扫描历史（append-only，key = ScanId）
 *  - ws_scan_cache：增量依据（key = TaskId#path）
 *
 * `invalidRecords: 'backup-and-skip'`（§3.4 明文）：工作区图谱是**派生**数据
 * ——损坏记录移出主存储后继续打开，由重扫重建；这与 T0.1/T0.2 权威表"拒绝打开"
 * 的取舍相反，正是取舍的依据：权威数据损坏必须响，派生数据损坏可重建。
 *
 * schema 恒等律（加载即拒）：
 *  1. 路径规范律：path 必须是 workspace 相对、无 `..`、无绝对前缀、无盘符；
 *  2. 节点角色/提示枚举律（role/credibilityHint 只在标注后在场）；
 *  3. 边置信度 ∈ [0,1]；`depends-on` 显性边置信度恒 1（确定性解析，非启发式）；
 *  4. scan run 终态律：status=recorded ⟺ 无 unfinished；failed 必带 unfinished
 *     （C5 显式终态：截断/失败绝不静默）；
 *  5. 计数律：filesChanged ≤ filesScanned；truncated ⟹ unfinished 在场。
 */
import { asScanId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

export const FILE_ROLES = ['doc', 'code', 'config', 'data', 'artifact', 'unknown'] as const;
export type FileRole = (typeof FILE_ROLES)[number];

/** J4：可信度**提示非裁决**——任何文件不因扫描自动升格为知识。 */
export const CREDIBILITY_HINTS = ['authoritative-likely', 'draft-likely', 'unknown'] as const;
export type CredibilityHint = (typeof CREDIBILITY_HINTS)[number];

export const EDGE_KINDS = ['depends-on', 'related-to', 'supersedes-file'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const SCAN_MODES = ['full', 'incremental'] as const;
export type ScanMode = (typeof SCAN_MODES)[number];

export const SCAN_STATUSES = ['recorded', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SCAN_OPERATIONS = ['inventory', 'annotate', 'record', 'fail'] as const;
export type ScanOperation = (typeof SCAN_OPERATIONS)[number];

const RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)(?!.*[\\])[^:]+$/;

/** 路径规范律（不变量 1）：workspace 相对、Unix 分隔符、无逃逸段/绝对前缀/盘符。 */
export const isSafeRelativePath = (path: string): boolean =>
  path !== '' && RELATIVE_PATH_RE.test(path) && !/^[A-Za-z]:/.test(path);

export const FileNodeSchema = z
  .object({
    taskId: z.string(),
    path: z.string(),
    size: z.number(),
    mtime: z.number(),
    /** 小文件算（≤hashMaxBytes）；大文件只有 size+mtime（U6：门槛实现期定 256KB）。 */
    contentHash: z.string().optional(),
    ext: z.string(),
    /** skip 规则命中（仍登记，标注不计入上限——§3.1 字段说明）。 */
    ignored: z.boolean(),
    /** 版本线索（U1：P0 只取跟踪状态）。 */
    gitTracked: z.boolean().optional(),
    /** LLM 判定（标注后在场）。 */
    role: z.enum(FILE_ROLES).optional(),
    /** J4 提示（非裁决）。 */
    credibilityHint: z.enum(CREDIBILITY_HINTS).optional(),
    lastScanId: z.string(),
  })
  .superRefine((node, ctx) => {
    if (!isSafeRelativePath(node.path)) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: `文件路径不安全（须 workspace 相对且无逃逸）：${node.path}` });
    }
    if (node.size < 0 || node.mtime < 0) {
      ctx.addIssue({ code: 'custom', message: 'size/mtime 不得为负' });
    }
  });
export type FileNode = z.infer<typeof FileNodeSchema>;

export const GraphEdgeSchema = z
  .object({
    taskId: z.string(),
    from: z.string(),
    to: z.string(),
    kind: z.enum(EDGE_KINDS),
    confidence: z.number(),
    evidence: z.string().optional(),
  })
  .superRefine((edge, ctx) => {
    const issue = (message: string, path?: string): void => {
      ctx.addIssue({ code: 'custom', ...(path !== undefined ? { path: [path] } : {}), message });
    };
    for (const [field, value] of [
      ['from', edge.from],
      ['to', edge.to],
    ] as const) {
      if (!isSafeRelativePath(value)) issue(`边的 ${field} 路径不安全：${value}`, field);
    }
    if (edge.from === edge.to) issue('边不得自指（from === to）');
    if (edge.confidence < 0 || edge.confidence > 1) issue(`confidence 须 ∈ [0,1]，收到 ${edge.confidence}`);
    // 显性边由确定性解析产生（import/require/路径引用），不存在"自评置信度"
    if (edge.kind === 'depends-on' && edge.confidence !== 1) {
      issue(`kind=depends-on 是确定性解析结果，confidence 须恒 1（收到 ${edge.confidence}）`);
    }
    if (edge.kind !== 'depends-on' && edge.evidence === undefined) {
      issue(`kind=${edge.kind} 是启发式/命名约定判定，必带 evidence（可复核）`);
    }
  });
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const ScanRunSchema = z
  .object({
    id: z.string().transform(asScanId),
    taskId: z.string(),
    mode: z.enum(SCAN_MODES),
    status: z.enum(SCAN_STATUSES),
    startedAt: z.number(),
    finishedAt: z.number(),
    filesScanned: z.number(),
    filesChanged: z.number(),
    truncated: z.boolean(),
    /** failed/truncated 时的未完清单（C5：扫描失败/截断必须可见）。 */
    unfinished: z.array(z.string()).optional(),
    /** T0.3 timeline chunk（execution-verified：文件系统状态是执行验证过的事实）。 */
    inventoryEntryId: z.string().optional(),
    /** T0.3 timeline chunk（model-produced：语义标注是模型产出）。 */
    notesEntryId: z.string().optional(),
    /** T0.5 dispatch 子会话（轨迹链接）。 */
    childSessionId: z.string().optional(),
    /** 实际扫描根（workspace 相对，规范化后）。 */
    localPath: z.string(),
    maxFiles: z.number(),
    maxBytes: z.number(),
  })
  .superRefine((run, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (!isSafeRelativePath(run.localPath)) {
      issue(`扫描根不安全：${run.localPath}`);
    }
    if (run.finishedAt < run.startedAt) issue('finishedAt 不得早于 startedAt');
    if (run.filesChanged > run.filesScanned) {
      issue(`filesChanged(${run.filesChanged}) 不得超过 filesScanned(${run.filesScanned})`);
    }
    if (run.status === 'recorded' && run.unfinished !== undefined) {
      issue('status=recorded 不得携带 unfinished（未完成即非 recorded）');
    }
    if (run.status === 'failed' && run.unfinished === undefined) {
      issue('status=failed 必带 unfinished（显式终态：失败/截断必须可读地列出来）');
    }
    if (run.truncated && run.unfinished === undefined) {
      issue('truncated=true 必带 unfinished（上限命中不得静默丢文件）');
    }
    if (run.status === 'recorded' && run.inventoryEntryId === undefined) {
      issue('status=recorded 必带 inventoryEntryId（每条扫描历史必汇时间线）');
    }
  });
export type ScanRun = z.infer<typeof ScanRunSchema>;

export const ScanCacheSchema = z.object({
  taskId: z.string(),
  path: z.string(),
  size: z.number(),
  mtime: z.number(),
  contentHash: z.string().optional(),
  lastScanId: z.string(),
});
export type ScanCache = z.infer<typeof ScanCacheSchema>;

export type WorkspaceTables = {
  ws_file_nodes: typeof FileNodeSchema;
  ws_graph_edges: typeof GraphEdgeSchema;
  ws_scan_runs: typeof ScanRunSchema;
  ws_scan_cache: typeof ScanCacheSchema;
};

export const workspaceDomainSpec = defineTdaDomain({
  name: 'tda-workspace',
  version: 1,
  tables: {
    ws_file_nodes: FileNodeSchema,
    ws_graph_edges: GraphEdgeSchema,
    ws_scan_runs: ScanRunSchema,
    ws_scan_cache: ScanCacheSchema,
  },
  layout: 'single',
  // 派生数据：损坏可重建（§3.4 明文），故跳过而非拒绝打开
  invalidRecords: 'backup-and-skip',
});

/** 图谱节点/边键（唯一实现，服务与加载期检查共用）。 */
export const nodeKey = (taskId: string, path: string): string => `${taskId}#${path}`;
export const edgeKey = (taskId: string, from: string, to: string, kind: EdgeKind): string =>
  `${taskId}#${from}#${to}#${kind}`;
