/**
 * tda-recall 服务：ctx.recall 服务面实现（T1.1 §4.2）。
 *
 * 被动语义（J4）：不做"主动问需要回忆什么"（归 T2.4），只服务两条被动路径——
 * T0.4 `assemble` 的 injection 区拉取（`injectCandidates`）+ Harness/模型显式查询（`recall`）。
 *
 * 相对 §4.2 签名的三处**必要超集**（同 tda-context `assemble` 先例，不变量驱动）：
 *  1. `recall` / `injectCandidates` / `logUse` / `setParams` 是**异步**的——
 *     不变量 5 要求"每次召回都写 recall_log"，而写域是异步的；
 *  2. 增 `log(filter?)` 只读面——T1.2 治理管道消费 `recall_log`（reuseCount /
 *     lastUsedAt / unused-days）需经服务面读取（跨插件零 import）；
 *  3. 增 `initialize()`——内核纪律 #7：加载期要查的状态（参数单行）必须由启动序
 *     在注册不变量**之前**建立，且恢复期行缺失时补种子。
 *
 * 写入组合（内核纪律 #12）：
 *  - `recall_params`：权威（`dualWrite` + 族 `recall/change`，businessId='params'）；
 *  - `recall_log`：派生（`dualWriteDerived`，仅域写无事件——召回自身不该产审计事件，
 *    否则"索引引发新索引"自指放大；权威在"同 log 前缀 + 同 params 可重跑复现"）。
 *
 * **日志严格 append-only**：`injected` 的最终值在写行**之前**定妥（先算分选帽再落盘），
 * 绝不在写后用 update 回改——回改就是把旁路日志变成可变状态，直接侵蚀 T1.1 J7 的立论。
 *
 * 回放确定性（§2/不变量 7）：整条管线是 `(log 前缀, params 快照, at)` 的纯函数——
 * 无进程内累积状态、无隐藏时钟（`at` 由参数或注入的 `now` 给出）。
 */
import {
  allocateId,
  dualWrite,
  dualWriteDerived,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type JsonObject,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  DEFAULT_RECALL_PARAMS,
  RECALL_LOG_PREFIX,
  RECALL_PARAMS_KEY,
  RecallParamsSchema,
  type RecallChunkType,
  type RecallCredential,
  type RecallLogKind,
  type RecallLogRecord,
  type RecallParams,
  type RecallTables,
} from './domain.ts';
import { recallParamsPayload, RECALL_PARAMS_BUSINESS_ID } from './events.ts';
import {
  buildFocusQuery,
  composeScore,
  evaluateGate,
  normalizeSemantic,
  recencyScore,
  renderInjectionText,
  taskRelevance,
  type FocusContext,
  type ScoreParts,
  momentumScore,
  emotionScore,
} from './scoring.ts';

/** 时间线条目在 recall 侧的只读窄视图（结构镜像 tda-timeline 的 TimelineEntry）。 */
export interface RecallTimelineEntryView {
  readonly id: string;
  readonly content: string;
  readonly chunkType?: RecallChunkType | undefined;
  readonly credential: RecallCredential;
  readonly quarantine: boolean;
  readonly relatedTaskId?: string | undefined;
  readonly confidence?: number | undefined;
  readonly createdAt: number;
  /** 情感权重声明值（T2.4 J5 计量口径的读取面；缺省未声明）。 */
  readonly emotionWeight?: number | undefined;
}

export interface RecallTimelineHit {
  readonly entry: RecallTimelineEntryView;
  readonly score: number;
}

export interface RecallTimelineQuery {
  readonly text?: string;
  readonly vector?: number[];
  readonly mode?: 'fts' | 'vector' | 'hybrid';
  /** 查询侧预筛（T0.3 TimelineFilter.credentialMin，J5 ④）。 */
  readonly credentialMin?: RecallCredential;
  readonly chunkType?: RecallChunkType;
  readonly limit?: number;
}

/** 检索基底 seam：T0.3 `ctx.timeline`（recall 不碰存储细节，J1）。 */
export interface RecallTimelineSeam {
  search(query: RecallTimelineQuery): readonly RecallTimelineHit[];
}

/** 焦点目标 seam（T0.1 focusView）。 */
export interface RecallGoalFocusView {
  readonly id: string;
  readonly objective: string;
  readonly completionCriteria: readonly string[];
}

export interface RecallGoalSeam {
  focusView(): RecallGoalFocusView | undefined;
}

/** 焦点任务 seam（T0.2）。 */
export interface RecallTaskFocusView {
  readonly id: string;
  readonly subject: string;
  readonly description?: string | undefined;
  readonly stage: string;
  readonly goalId: string;
}

export interface RecallTaskSeam {
  focus(): RecallTaskFocusView | undefined;
  /** 焦点目标树的任务集（gate ② 的"当前目标树任务集"判据；缺省降级为仅当前任务）。 */
  idsOfGoal?(goalId: string): readonly string[];
}

export type RecallLifecycle = 'draft' | 'validating' | 'consolidated' | 'retired';

/**
 * 治理 seam（T1.2 → T1.1 的反向过滤）。
 *
 * T1.2 §5 明定"retired 条目不浮现由 T1.1 gate 消费治理状态实现——recall 查询侧加
 * `lifecycle≠retired` 过滤，T1.1 J5 硬闸的同族扩展"。缺省未装配即无过滤（P0 行为），
 * 装配后退役立即生效。
 */
export interface RecallGovernanceSeam {
  lifecycleOf(assetId: string): RecallLifecycle | undefined;
}

export interface RecallConfig {
  /** 检索候选池上限（默认 50）：池越大召回越全，日志越长。 */
  readonly candidatePool?: number;
  /** 注入 token 自帽（覆盖 params.injectionMaxTokens；T0.4 会再叠加四区裁决）。 */
  readonly injectionMaxTokens?: number;
}

export interface RecallQuery {
  /** 显式查询词（被动查询路）。 */
  readonly text?: string;
  /** 显式查询向量（EmbeddingProvider 就绪后）。 */
  readonly vector?: number[];
  /** 缺省 = 当前焦点任务（assemble 路自动填）。 */
  readonly taskId?: string;
  /** 缺省 = 当前焦点目标。 */
  readonly goalId?: string;
  readonly chunkType?: RecallChunkType;
  readonly credentialMin?: RecallCredential;
  /** 返回条数上限（默认 10）。 */
  readonly limit?: number;
  /** 查询时刻（回放用；缺省 now）。 */
  readonly at?: number;
  /**
   * 调试标志：低于 `minScore` 也返回（不变量 4 —— **生产路径禁用**，
   * 只有显式诊断查询可传；`injectCandidates` 不接受此标志）。
   */
  readonly includeBelowMin?: boolean;
  /** v2 主动工具路标记（J6：active-tool 与被动路同 gate 同留痕）。 */
  readonly trigger?: 'passive-query' | 'active-tool' | undefined;
}

export interface ScoredChunk {
  readonly entry: RecallTimelineEntryView;
  readonly score: number;
  readonly parts: ScoreParts;
  /** v2 动量明细（审计/调试，J8；v1 恒缺省）。 */
  readonly momentumDetail?: { readonly mFast: number; readonly mSlow: number; readonly attentionProximity: number } | undefined;
  readonly gatePassed: boolean;
  /** gate 拒绝原因（仅 gatePassed=false 时在场）。 */
  readonly gateReason?: string | undefined;
  /** 是否进了注入集（显式查询路恒 false——它不注入）。 */
  readonly injected: boolean;
}

export interface RecallLogFilter {
  readonly entryId?: string;
  readonly injectedOnly?: boolean;
  readonly since?: number;
  readonly limit?: number;
}

export interface RecallHandleMeta {
  /** 本次启动是否补种了参数单行（resume 证据面用）。 */
  readonly seeded: boolean;
}

/** 主动阶段召回 briefing（T2.4 J7 三帽）。 */
export interface StrategicBriefing {
  readonly taskId: string;
  readonly toStage: string;
  readonly items: readonly ScoredChunk[];
  readonly tokensEst: number;
  readonly truncated: boolean;
  readonly at: number;
}

export interface RecallService {
  recall(query?: RecallQuery): Promise<readonly ScoredChunk[]>;
  /** 主动阶段路（T0.2 stage 迁移事件驱动；J6 ②）。 */
  strategicBrief(taskId: string, toStage: string): Promise<StrategicBriefing>;
  injectCandidates(session: { readonly sessionId: string }, round: number): Promise<readonly ScoredChunk[]>;
  logUse(entryIds: readonly string[], ctx: { readonly taskId?: string; readonly sessionId: string }): Promise<number>;
  params(): RecallParams;
  setParams(patch: Partial<Omit<RecallParams, 'revision'>>): Promise<RecallParams>;
  /** 治理信号读取面（T1.2 消费；必要超集，见文件头）。 */
  log(filter?: RecallLogFilter): readonly RecallLogRecord[];
  /** 启动序（必要超集 3）：**必须在注册不变量之前** await。 */
  initialize(): Promise<RecallHandleMeta>;
}

export interface RecallDeps {
  readonly domain: TdaDomain<RecallTables>;
  readonly session: TdaSessionSink;
  readonly timeline: RecallTimelineSeam;
  readonly goal?: RecallGoalSeam;
  readonly task?: RecallTaskSeam;
  readonly governance?: RecallGovernanceSeam;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly tokenMeter?: (text: string) => number;
  readonly config?: RecallConfig;
}

const DEFAULT_CANDIDATE_POOL = 50;
const DEFAULT_LIMIT = 10;

/** 粗略 token 估计（≈4 字符/token）；T0.4 会用自己的 tokenMeter 再裁。 */
const defaultTokenMeter = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const byEntryIdAsc = (a: { readonly entryId: string }, b: { readonly entryId: string }): number =>
  a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;

const compareEntryId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Evaluated {
  readonly hit: RecallTimelineHit;
  readonly gatePassed: boolean;
  readonly gateReason?: string;
  readonly score: number;
  readonly parts: ScoreParts;
  readonly momentumDetail?: { readonly mFast: number; readonly mSlow: number; readonly attentionProximity: number };
  /** 是否进入注入集（仅 inject 路会被置 true；写日志前定妥）。 */
  injected: boolean;
}

interface EvaluatedSet {
  readonly items: readonly Evaluated[];
  readonly focus: FocusContext;
  readonly at: number;
  readonly params: RecallParams;
}

export function createRecallService(deps: RecallDeps): RecallService {
  const clock = deps.now ?? ((): number => Date.now());
  const tokenMeter = deps.tokenMeter ?? defaultTokenMeter;
  const candidatePool = deps.config?.candidatePool ?? DEFAULT_CANDIDATE_POOL;
  const injectionCapOverride = deps.config?.injectionMaxTokens;
  const context: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };

  let current: RecallParams | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  /** 进程内串行链：id 分配 + 落域是复合写，不串行会裂成多条同号日志。 */
  const withLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const paramsOf = (): RecallParams => {
    if (current === undefined) {
      throw new TdaError('RECALL_NOT_INITIALIZED', 'ctx.recall 尚未 initialize（参数未装载）');
    }
    return current;
  };

  /** 权威写出口：落域 → append 事件 → （装配后）发布总线。 */
  const commitParams = async (params: RecallParams): Promise<void> => {
    const payload = recallParamsPayload(params) as JsonObject;
    const seq = await dualWrite(
      deps.session,
      {
        family: 'recall/change',
        businessId: RECALL_PARAMS_BUSINESS_ID,
        payload,
        domainWrite: () => deps.domain.table('recall_params').put(RECALL_PARAMS_KEY, params),
      },
      context,
    );
    if (deps.bus !== undefined) {
      deps.bus.publish({
        family: 'recall/change',
        businessId: RECALL_PARAMS_BUSINESS_ID,
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
  };

  /** 派生写出口：只域、无事件（recall_log 的唯一写入路径）。 */
  const appendLogs = async (rows: readonly Omit<RecallLogRecord, 'id'>[]): Promise<void> => {
    if (rows.length === 0) return;
    const table = deps.domain.table('recall_log');
    await dualWriteDerived(async () => {
      for (const row of rows) {
        const id = allocateId(table, RECALL_LOG_PREFIX);
        await table.put(id, { ...row, id });
      }
    }, context);
  };

  /** 焦点上下文解析（query 显式值优先于 focus 服务）。 */
  const resolveFocus = (query: RecallQuery): { focus: FocusContext; text: string | undefined } => {
    const goal = deps.goal?.focusView();
    const task = deps.task?.focus();
    const goalId = query.goalId ?? goal?.id;
    const taskId = query.taskId ?? task?.id;
    const goalTaskIds = goalId === undefined ? [] : (deps.task?.idsOfGoal?.(goalId) ?? []);
    const focus: FocusContext = {
      ...(taskId !== undefined ? { taskId } : {}),
      ...(goalId !== undefined ? { goalId } : {}),
      goalTaskIds,
    };
    const text =
      query.text ??
      (query.vector === undefined
        ? buildFocusQuery([goal?.objective, ...(goal?.completionCriteria ?? []), task?.subject, task?.description])
        : undefined);
    return { focus, text };
  };

  /**
   * 召回管线（§2 流程图）：search → gate（**先于计分**，不变量 1）→ 三元计分。
   * **纯计算，不写任何东西**——写日志由调用方在 `injected` 定妥后一次性完成。
   */
  /**
   * 动量事件源（J3）：从 recall_log 冷读该条目的事件（scanWindowDays 窗口内）。
   * injected（inject/recall 且 injected=true）权重 1.0；used（confirm 且 used=true）权重 2.0。
   * 纯读、无隐藏状态——同 log 前缀 ⇒ 同动量（不变量 3）。
   */
  const momentumEventsOf = (
    entryId: string,
    at: number,
    params: RecallParams,
  ): { at: number; weight: number }[] => {
    const windowMs = params.momentum.scanWindowDays * 86_400_000;
    const since = at - windowMs;
    const events: { at: number; weight: number }[] = [];
    const table = deps.domain.table('recall_log');
    for (const row of table.entries()) {
      if (row[1].entryId !== entryId || row[1].at < since) continue;
      const record = row[1];
      if (record.kind === 'confirm' && record.used === true) {
        events.push({ at: record.at, weight: params.momentum.eventWeights.used });
      } else if (record.injected) {
        events.push({ at: record.at, weight: params.momentum.eventWeights.injected });
      }
    }
    return events;
  };

  const evaluateAll = (query: RecallQuery, atOverride?: number): EvaluatedSet => {
    const params = paramsOf();
    const at = atOverride ?? query.at ?? clock();
    const { focus, text } = resolveFocus(query);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const pool = Math.max(limit * 4, 20);
    const searchQuery: RecallTimelineQuery = {
      ...(text !== undefined ? { text } : {}),
      ...(query.vector !== undefined ? { vector: query.vector } : {}),
      ...(query.credentialMin !== undefined ? { credentialMin: query.credentialMin } : {}),
      ...(query.chunkType !== undefined ? { chunkType: query.chunkType } : {}),
      limit: candidatePool > pool ? candidatePool : pool,
    };
    const hits = deps.timeline.search(searchQuery);
    const poolMax = hits.reduce((max, hit) => (hit.score > max ? hit.score : max), 0);

    const items: Evaluated[] = [];
    for (const hit of hits) {
      const entry = hit.entry;
      // 非 chunk 记录（如 invalidation 标记）不是召回候选：不参与、不记日志
      //（记了会污染 T1.2 的复用统计——它从未"被用过"过）。
      if (entry.chunkType === undefined) continue;
      const lifecycle = deps.governance?.lifecycleOf(entry.id);
      const gate =
        lifecycle === 'retired'
          ? { passed: false, reason: 'retired' }
          : evaluateGate(
              {
                entryId: entry.id,
                quarantine: entry.quarantine,
                credential: entry.credential,
                ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
                ...(entry.relatedTaskId !== undefined ? { relatedTaskId: entry.relatedTaskId } : {}),
              },
              focus,
              params,
            );
      if (!gate.passed) {
        // 被拦下者不进入计分（不变量 1：gate 先行），但**必须留痕**（不变量 5）
        items.push({
          hit,
          gatePassed: false,
          ...(gate.reason !== undefined ? { gateReason: gate.reason } : {}),
          score: 0,
          parts: { taskRel: 0, recency: 0, semantic: 0 },
          injected: false,
        });
        continue;
      }
      // v2 计分输入：动量从 recall_log 重算（不落库，J3）；质心缺席 = 0.5 中性（J4）
      const isV2 = params.scorerVersion === 'v2';
      const proximity = 0.5;
      const momentum = isV2
        ? momentumScore(
            momentumEventsOf(entry.id, at, params),
            at,
            params,
            proximity,
          )
        : undefined;
      const emotion = isV2 ? emotionScore(entry.credential, entry.emotionWeight) : undefined;
      const parts: ScoreParts = {
        taskRel: taskRelevance(entry.relatedTaskId, focus),
        recency: recencyScore(entry.createdAt, at, entry.chunkType, params),
        semantic: normalizeSemantic(hit.score, poolMax),
        ...(momentum !== undefined ? { momentum: momentum.momentum } : {}),
        ...(emotion !== undefined ? { emotion } : {}),
      };
      items.push({
        hit,
        gatePassed: true,
        score: composeScore(parts, params),
        parts,
        ...(momentum !== undefined ? { momentumDetail: { mFast: momentum.mFast, mSlow: momentum.mSlow, attentionProximity: proximity } } : {}),
        injected: false,
      });
    }
    return { items, focus, at, params };
  };

  /** 写召回日志（顺序取 entryId 升序，与检索 tie-break 无关 ⇒ 完全确定）。 */
  const writeLogs = async (
    set: EvaluatedSet,
    kind: RecallLogKind,
    sessionId: string,
    trigger?: 'passive-query' | 'active-tool' | 'active-stage' | undefined,
  ): Promise<void> => {
    const resolvedTrigger: (typeof rows)[number]['trigger'] =
      kind === 'inject' ? 'passive-assemble' : (trigger ?? 'passive-query');
    const rows: Omit<RecallLogRecord, 'id'>[] = [...set.items]
      .sort((a, b) => compareEntryId(a.hit.entry.id, b.hit.entry.id))
      .map((item) => ({
        entryId: item.hit.entry.id,
        at: set.at,
        ...(set.focus.taskId !== undefined ? { taskId: set.focus.taskId } : {}),
        ...(set.focus.goalId !== undefined ? { goalId: set.focus.goalId } : {}),
        score: item.score,
        gatePassed: item.gatePassed,
        injected: item.injected,
        kind,
        paramsRevision: set.params.revision,
        sessionId,
        trigger: resolvedTrigger,
        ...(kind === 'confirm' ? { used: true } : {}),
        ...(item.parts.emotion !== undefined
          ? { emotionApplied: (item.parts.emotion ?? 0) > 0 }
          : {}),
        ...(item.gateReason !== undefined ? { reason: item.gateReason } : {}),
      }));
    await withLock(() => appendLogs(rows));
  };

  /** 注入帽裁决（J6）：按分降序累计 token，超帽者留在日志里但不注入。 */
  const selectForInjection = (set: EvaluatedSet): readonly ScoredChunk[] => {
    const cap = injectionCapOverride ?? set.params.injectionMaxTokens;
    const accepted = set.items.filter((item) => item.gatePassed && item.score >= set.params.minScore);
    accepted.sort((a, b) => b.score - a.score || compareEntryId(a.hit.entry.id, b.hit.entry.id));
    const selected: ScoredChunk[] = [];
    let used = 0;
    for (const item of accepted) {
      const entry = item.hit.entry;
      const text = renderInjectionText({
        chunkType: entry.chunkType as RecallChunkType,
        credential: entry.credential,
        content: entry.content,
      });
      const cost = tokenMeter(text);
      if (used + cost > cap) continue;
      used += cost;
      item.injected = true;
      selected.push({
        entry,
        score: item.score,
        parts: item.parts,
        gatePassed: true,
        injected: true,
      });
    }
    return selected;
  };

  const toChunk = (item: Evaluated): ScoredChunk => ({
    entry: item.hit.entry,
    score: item.score,
    parts: item.parts,
    ...(item.momentumDetail !== undefined ? { momentumDetail: item.momentumDetail } : {}),
    gatePassed: item.gatePassed,
    ...(item.gateReason !== undefined ? { gateReason: item.gateReason } : {}),
    injected: item.injected,
  });

  return {
    async recall(query = {}) {
      const set = evaluateAll(query);
      const limit = query.limit ?? DEFAULT_LIMIT;
      const accepted = set.items
        .filter((item) => item.gatePassed && (item.score >= set.params.minScore || query.includeBelowMin === true))
        .map(toChunk)
        .sort((a, b) => b.score - a.score || compareEntryId(a.entry.id, b.entry.id))
        .slice(0, limit);
      await writeLogs(set, 'recall', deps.session.sessionId, query.trigger);
      return accepted;
    },

    async strategicBrief(taskId, toStage) {
      const params = paramsOf();
      const at = clock();
      // J6 ②：新阶段 subject + completionCriteria + 上阶段结论摘要（缺 seam 时仅阶段词）
      const focusTask = deps.task?.focus();
      const stageQuery = [toStage];
      if (focusTask !== undefined && focusTask.id === taskId) {
        stageQuery.push(focusTask.subject);
        if (focusTask.description !== undefined) stageQuery.push(focusTask.description);
      }
      const set = evaluateAll({
        text: stageQuery.join('\n'),
        taskId,
        limit: params.strategic.maxItems,
      });
      const accepted = set.items
        .filter((item) => item.gatePassed && item.score >= params.minScore)
        .map(toChunk)
        .sort((a, b) => b.score - a.score || compareEntryId(a.entry.id, b.entry.id))
        .slice(0, params.strategic.maxItems);
      let tokensEst = 0;
      let truncated = false;
      const items: ScoredChunk[] = [];
      for (const chunk of accepted) {
        const text = renderInjectionText({
          chunkType: chunk.entry.chunkType as RecallChunkType,
          credential: chunk.entry.credential,
          content: chunk.entry.content,
        });
        const cost = tokenMeter(text);
        if (tokensEst + cost > params.strategic.tokenCap) {
          truncated = true;
          break;
        }
        tokensEst += cost;
        items.push(chunk);
      }
      await writeLogs(set, 'recall', deps.session.sessionId, 'active-stage');
      return { taskId, toStage, items, tokensEst, truncated, at };
    },

    async injectCandidates(session, _round) {
      // assemble 路：焦点上下文自动构造（J2），不接受调试标志（不变量 4）
      const set = evaluateAll({ limit: DEFAULT_LIMIT });
      const selected = selectForInjection(set);
      await writeLogs(set, 'inject', session.sessionId);
      return selected;
    },

    async logUse(entryIds, ctx) {
      const table = deps.domain.table('recall_log');
      const latest = new Map<string, RecallLogRecord>();
      for (const key of table.keys()) {
        const row = table.get(key);
        if (row === undefined) continue;
        const prev = latest.get(row.entryId);
        if (prev === undefined || row.at >= prev.at) latest.set(row.entryId, row);
      }
      const at = clock();
      const revision = paramsOf().revision;
      const rows: Omit<RecallLogRecord, 'id'>[] = entryIds.map((entryId) => ({
        entryId,
        at,
        ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
        score: latest.get(entryId)?.score ?? 0,
        gatePassed: true,
        injected: true,
        kind: 'confirm',
        // v2：confirm 行 = 真实复用事件（动量权重 2.0 的来源，J3/J8）
        used: true,
        paramsRevision: revision,
        sessionId: ctx.sessionId,
      }));
      await withLock(() => appendLogs(rows));
      return rows.length;
    },

    params() {
      return paramsOf();
    },

    async setParams(patch) {
      return withLock(async () => {
        const base = paramsOf();
        const merged: RecallParams = {
          scorerVersion: patch.scorerVersion ?? base.scorerVersion,
          weights: { ...base.weights, ...(patch.weights ?? {}) },
          halfLifeDays: { ...base.halfLifeDays, ...(patch.halfLifeDays ?? {}) },
          modelProducedMinConfidence: patch.modelProducedMinConfidence ?? base.modelProducedMinConfidence,
          minScore: patch.minScore ?? base.minScore,
          injectionMaxTokens: patch.injectionMaxTokens ?? base.injectionMaxTokens,
          momentum: {
            ...base.momentum,
            ...(patch.momentum ?? {}),
            eventWeights: { ...base.momentum.eventWeights, ...(patch.momentum?.eventWeights ?? {}) },
          },
          attention: { ...base.attention, ...(patch.attention ?? {}) },
          strategic: { ...base.strategic, ...(patch.strategic ?? {}) },
          emotionWeightCap: patch.emotionWeightCap ?? base.emotionWeightCap,
          revision: base.revision + 1,
        };
        const parsed = RecallParamsSchema.safeParse(merged);
        if (!parsed.success) {
          throw new TdaError(
            'RECALL_PARAMS_INVALID',
            `参数非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`,
          );
        }
        const next = parsed.data;
        await commitParams(next);
        current = next;
        return next;
      });
    },

    log(filter = {}) {
      const table = deps.domain.table('recall_log');
      const out: RecallLogRecord[] = [];
      for (const key of table.keys()) {
        const row = table.get(key);
        if (row === undefined) continue;
        if (filter.entryId !== undefined && row.entryId !== filter.entryId) continue;
        if (filter.injectedOnly === true && !row.injected) continue;
        if (filter.since !== undefined && row.at < filter.since) continue;
        out.push(row);
      }
      out.sort((a, b) => a.at - b.at || byEntryIdAsc(a, b));
      return filter.limit !== undefined ? out.slice(0, filter.limit) : out;
    },

    async initialize() {
      const table = deps.domain.table('recall_params');
      const existing = table.get(RECALL_PARAMS_KEY);
      if (existing !== undefined) {
        current = existing;
        return { seeded: false };
      }
      const seeded: RecallParams = { ...DEFAULT_RECALL_PARAMS };
      current = seeded;
      await commitParams(seeded);
      return { seeded: true };
    },
  };
}

