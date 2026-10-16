/**
 * T4.4 · 树谱与状态展示 v1（tda-display）——数据契约。
 *
 * J1：**无自有 domain、无表、无事件族、无双写**（全项目最轻插件，纯投影层）。
 * 本文件只定义聚合投影类型（StatusSnapshot，非持久化）与只读 deps seam。
 * 内核写工具（dualWrite 系列、allocateId、openTdaDomain）**不进 deps**——零写权的类型级保证（不变量 1）。
 */

/** 展示范围（v1：按目标过滤树谱/报告；undefined=全图）。 */
export interface DisplayScope {
  readonly goalId?: string | undefined;
}

/** 目标摘要（J3 视图②；zone 由装配层按预算三区口径计算）。 */
export interface GoalSummary {
  readonly goalId: string;
  /** 截断 ≤120（J8 消毒前先截断）。 */
  readonly objective: string;
  readonly phase: string;
  readonly stage: string;
  readonly zone: string;
  readonly taskCount: number;
  readonly completedCount: number;
  readonly focus: boolean;
}

/** 任务计数（J3 视图②）。 */
export interface TaskCounts {
  readonly ready: number;
  readonly executing: number;
  readonly awaitingApproval: number;
  readonly verifying: number;
  readonly blocked: number;
  readonly completedToday: number;
}

/** 审批摘要项（J3 视图③）：whatToShow 摘要+定级理由；**零 token、零 excerpts**（J8/不变量 4）。 */
export interface ApprovalDigestItem {
  readonly approvalId: string;
  readonly kind: string;
  readonly riskLevel: string;
  readonly subject: string;
  readonly summary: string;
  readonly riskReasons: readonly string[];
}

/** 决策链摘要（T0.7 auditView 的人读投影）。 */
export interface AuditDigestItem {
  readonly at: number;
  readonly kind: string;
  readonly approvalId?: string | undefined;
}

/** 三视图合一快照（每次请求实时聚合，无缓存）。 */
export interface StatusSnapshot {
  readonly at: number;
  /** 树谱视图数据源 = T4.3 treeView 原样透传（J3 视图①）。 */
  readonly spectrum: unknown;
  readonly overview: {
    readonly focusGoal?: GoalSummary | undefined;
    readonly goals: readonly GoalSummary[];
    readonly tasks: TaskCounts;
    readonly drift?: { readonly band: string; readonly trend: readonly number[] } | undefined;
    readonly attention?: {
      readonly consumedUnits: number;
      readonly quotaUnits: number;
      readonly zone: string;
      readonly pendingCount: number;
    } | undefined;
  };
  readonly approvals: readonly ApprovalDigestItem[];
  readonly audit: { readonly recentDecisions: readonly AuditDigestItem[] };
  /** fail-open 降级清单（可选 seam 抛错时记名，视图继续渲染其余部分）。 */
  readonly degraded: readonly string[];
}

/** 报告产物（J7）：markdown 人读报告，落 T0.3 timeline。 */
export type StatusReport = string;

// ── 只读 deps seam（全部结构化最小面；harness 适配器用 lambda 桥接） ──

/** 目标只读面（goalTree.tree + focus 的投影）。 */
export interface DisplayGoalItem {
  readonly goalId: string;
  readonly objective: string;
  readonly phase: string;
  readonly stage: string;
  readonly zone: string;
  readonly focus: boolean;
}

export interface DisplayGoalSeam {
  list(): readonly DisplayGoalItem[];
}

/** 任务只读面（taskPool.list 投影；证据回链与提议态供计数/报告）。 */
export interface DisplayTaskItem {
  readonly id: string;
  readonly goalId: string;
  readonly phase: string;
  readonly stage: string;
  readonly proposalPending: boolean;
  readonly outcome?: string | undefined;
  readonly evidence: readonly string[];
  readonly updatedAt: number;
}

export interface DisplayTaskSeam {
  list(filter?: { goalId?: string | undefined }): readonly DisplayTaskItem[];
}

/** 图谱只读面（T4.3 只读投影原样透传）。 */
export interface DisplayGraphSeam {
  treeView(rootGoalId?: string | undefined): unknown;
  export(format: 'json' | 'dot'): string;
}

/** 监督只读面（T3.2；**可缺省**——缺省时审批/审计视图降级为空，J9 fail-open）。 */
export interface DisplaySupervisionSeam {
  pending(filter?: { riskLevel?: string; kind?: string }): readonly {
    approvalId: string;
    kind: string;
    riskLevel: string;
    subject: string;
    whatToShow: { summary: string; riskReasons?: readonly string[] };
  }[];
  attentionStatus(): { consumedUnits: number; quotaUnits: number; zone: string; pendingCount: number };
  events(): readonly { kind: string; approvalId?: string | undefined; at: number }[];
}

/** 漂移只读面（T1.5；**可缺省**）。 */
export interface DisplayDriftSeam {
  /** 最近 N 次快照分数序列（旧→新）+ 当前三带。 */
  trend(goalId?: string | undefined): { band: string; trend: readonly number[] } | undefined;
}

/** 时间线唯一写入口（T0.3；J7 报告的唯一写路径——本插件唯一非只读调用）。 */
export interface DisplayTimelineSeam {
  append(
    writer: { sessionId: string; actor: string; at: number },
    chunk: { content: string; chunkType: string; source: string; credential: string },
  ): Promise<{ id: string }>;
}

export interface DisplayDeps {
  readonly goal: DisplayGoalSeam;
  readonly taskPool: DisplayTaskSeam;
  readonly graph: DisplayGraphSeam;
  readonly supervision?: DisplaySupervisionSeam | undefined;
  readonly drift?: DisplayDriftSeam | undefined;
  readonly timeline: DisplayTimelineSeam;
  /** 会话归因（报告写时间线的 writer.sessionId）。 */
  readonly schedulerSessionId: string;
  readonly now?: (() => number) | undefined;
}

export interface StatusDisplayService {
  initialize(): Promise<void>;
  /** host 默认 127.0.0.1（不变量 2 fail-loud）；port 默认 7391，0=ephemeral。 */
  startServer(opts?: { port?: number; host?: string }): Promise<{ url: string; port: number }>;
  stopServer(): Promise<void>;
  snapshot(scope?: DisplayScope): StatusSnapshot;
  report(scope: DisplayScope, range?: { from?: number; to?: number }): Promise<StatusReport>;
  serverStatus(): { listening: boolean; url?: string; port?: number };
  dispose(): Promise<void>;
}

export const DISPLAY_VERSION = '0.1.0';
export const DISPLAY_DEFAULT_PORT = 7391;
/** 决策链摘要条数（视图③ recentDecisions 尾窗）。 */
export const AUDIT_TAIL = 20;
/** 目标 objective 截断（J8）。 */
export const OBJECTIVE_MAX_CHARS = 120;
