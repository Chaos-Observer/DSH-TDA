/**
 * tda-governance 服务：ctx.governance 服务面实现（T1.2 §4.2）。
 *
 * 治理是**旁路层**（J2）：任何治理动作都不改 T0.3 时间线条目；内容层更正只经
 * `supersede`/`invalidate`（T0.3 J2，经 T0.3 的单一漏斗），资产层淘汰只记治理状态。
 *
 * 三条写入纪律：
 *  1. `gov_actions` 追加 = 权威（`dualWrite` + 族 `memoryGov/change`，businessId=`gov-<n>`）；
 *  2. `memory_gov_states` 刷新 = **投影**（`dualWriteDerived`，仅域无事件）——
 *     它就是 `projectStates()` 的输出，"线上写"与"不变量门重建"共用同一折叠实现；
 *  3. `gov_scan_state` 更新 = 水位缓存（同样只域无事件）。
 *
 * 相对 §4.2 签名的必要超集（同 tda-context `assemble` 先例）：
 *  - 所有 mutation 带 `actor`（§5.5 审计可归因：每条 gov_action 的 actor 是治理
 *    责任的落点，不能由服务伪造）；
 *  - 补 `initialize()`（启动序先于不变量注册）、`lifecycleOf()`（T1.1 gate 的
 *    反向过滤入口）、`actions()`/`rebuildStates()`（T1.3/T1.4 消费与不变量门自证）、
 *    `scanState()`（水位读取面）。
 *
 * 风险分级（J12）：`superseded`/`unused-days`/near-dup 标记 = 低风险，自动执行 + 留痕；
 * 容量强制淘汰与遗忘（invalidate）= 高风险，**scan 只提议**，执行需人类一次性 token。
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
  CONSOLIDATE_MIN_CREDENTIAL,
  CREDENTIAL_RANK,
  GOV_ACTION_PREFIX,
  GOV_SCAN_STATE_KEY,
  GovActionSchema,
  govStateKey,
  type GovAction,
  type GovAssetKind,
  type GovCredential,
  type GovReason,
  type GovScanState,
  type GovTables,
  type GovWriter,
  type GovWriterRef,
  type MemoryGovState,
  type MemoryLifecycle,
  type VerifyEvidence,
} from './domain.ts';
import { govActionPayload } from './events.ts';
import {
  capacityZone,
  DEFAULT_GOVERNANCE_WEIGHTS,
  governanceScore,
  isUnusedTooLong,
  projectStates,
  type GovernanceWeights,
  type UsageSnapshot,
} from './projection.ts';

/** T0.3 条目在治理侧的只读窄视图（结构镜像 tda-timeline `TimelineEntry`）。 */
export interface GovTimelineEntry {
  readonly id: string;
  readonly kind: 'chunk' | 'invalidation';
  readonly content: string;
  readonly chunkType?: 'fact' | 'method' | 'reflection' | 'skill' | undefined;
  readonly source: 'task' | 'conversation' | 'study' | 'harness';
  readonly credential: GovCredential;
  readonly quarantine: boolean;
  readonly relatedTaskId?: string | undefined;
  readonly supersedes?: string | undefined;
  readonly invalidates?: string | undefined;
  readonly createdAt: number;
}

export interface GovTimelineChunk {
  readonly content: string;
  readonly chunkType: 'fact' | 'method' | 'reflection' | 'skill';
  readonly source: 'task' | 'conversation' | 'study' | 'harness';
  readonly credential: GovCredential;
  readonly relatedTaskId?: string;
  readonly trajectoryLink?: string;
  readonly confidence?: number;
}

/** T0.3 检索/写面 seam（治理只经其公开通道，不碰存储细节）。 */
export interface GovTimelineSeam {
  current(filter?: { readonly limit?: number }): readonly GovTimelineEntry[];
  get(id: string): GovTimelineEntry | undefined;
  history(id: string): readonly GovTimelineEntry[];
  /** 内容层更正唯一通道①：新条目显式取代旧条目（J4 转正的落点）。 */
  supersede(writer: GovWriterRef, id: string, chunk: GovTimelineChunk, reason: string): Promise<{ readonly id: string }>;
  /** 内容层更正唯一通道②：作废记录（遗忘的落点，J12 需审批后执行）。 */
  invalidate(writer: GovWriterRef, id: string, reason: string): Promise<{ readonly id: string }>;
}

/** T1.1 recall_log 只读 seam（reuseCount / lastUsedAt / unused-days 信号源）。 */
export interface GovRecallLogRow {
  readonly entryId: string;
  readonly at: number;
  readonly injected: boolean;
  readonly kind: string;
  readonly taskId?: string | undefined;
}

export interface GovRecallSeam {
  log(filter?: { readonly entryId?: string; readonly injectedOnly?: boolean }): readonly GovRecallLogRow[];
}

/** T0.2 任务只读 seam（J5 外部验证的证据面：任务必须以 success 收尾）。 */
export interface GovTaskView {
  readonly id: string;
  readonly phase: string;
  readonly stage: string;
  readonly outcome?: string | undefined;
  readonly runCount: number;
}

export interface GovTaskSeam {
  get(id: string): GovTaskView | undefined;
}

export interface GovConfig {
  /** 扫描周期（P0 默认 6h，U5）。 */
  readonly cycleMs?: number;
  readonly maxActionsPerScan?: number;
  readonly maxScannedPerScan?: number;
  /** 容量双帽（J8/U2）。 */
  readonly maxEntries?: number;
  readonly maxTokens?: number;
  /** unused-days 阈值 N（J7/U2）。 */
  readonly unusedDays?: number;
  readonly weights?: GovernanceWeights;
  /** 治理分里的时间新鲜度半衰期（U2）。 */
  readonly recencyHalfLifeDays?: number;
  /** near-duplicate 判定的最小内容长度（U4）。 */
  readonly nearDupMinLength?: number;
}

export interface GovCaller {
  readonly actor: GovWriter;
  readonly sessionId: string;
}

export interface CapacityReport {
  readonly activeEntries: number;
  readonly activeTokensEst: number;
  readonly caps: { readonly maxEntries: number; readonly maxTokens: number };
  readonly zone: 'normal' | 'pressure' | 'over';
}

export interface RankRow {
  readonly assetId: string;
  readonly score: number;
  readonly reuseCount: number;
  readonly credentialRank: number;
}

export interface GovScanReport {
  /** 本轮实际检视的条目数（≤ caps.maxScanned，不变量 7）。 */
  readonly scanned: number;
  /** 本轮生成的全部治理动作（含已执行的）。 */
  readonly proposals: readonly GovAction[];
  /** 低风险、已自动执行的（superseded / unused-days / dup 标记）。 */
  readonly executed: readonly GovAction[];
  /** 高风险、等待人类审批的（容量淘汰 / 遗忘）——**scan 不代执行**（J12）。 */
  readonly pendingApproval: readonly GovAction[];
  readonly conflictsFound: number;
  readonly capacity: CapacityReport;
  readonly nextCursor: string;
}

export interface GovRetireOptions {
  /** J12 人类一次性审批 token（capacity 强制淘汰必填）。 */
  readonly approvalToken?: string;
  /** 容量淘汰的治理分排名快照（不变量 5 的可解释证据）。 */
  readonly ranking?: readonly RankRow[];
}

export interface GovernanceService {
  initialize(): Promise<GovScanState>;
  scan(actor: GovCaller, opts?: { readonly limit?: number }): Promise<GovScanReport>;
  promote(actor: GovCaller, assetId: string, evidence: VerifyEvidence): Promise<GovAction>;
  /** 非记忆资产的晋升通道（T2.2 skill/T2.5 workflow）：证据由所属插件门承担。 */
  promoteAsset(
    actor: GovCaller,
    assetId: string,
    assetKind: GovAssetKind,
    note: string,
  ): Promise<GovAction>;
  /** assetKind 缺省 'memory'；T1.4 起 'meta-thinking' 走同一管道（J1：不新立服务）。 */
  consolidate(actor: GovCaller, assetId: string, assetKind?: GovAssetKind): Promise<GovAction>;
  retire(
    actor: GovCaller,
    assetId: string,
    reason: GovReason,
    opts?: GovRetireOptions,
    assetKind?: GovAssetKind,
  ): Promise<GovAction>;
  restore(actor: GovCaller, assetId: string, assetKind?: GovAssetKind): Promise<GovAction>;
  proposeInvalidate(
    actor: GovCaller,
    assetId: string,
    reason: string,
    opts?: { readonly approvalToken?: string },
  ): Promise<GovAction>;
  conflicts(): readonly MemoryGovState[];
  capacity(): CapacityReport;
  state(assetId: string, assetKind?: GovAssetKind): MemoryGovState | undefined;
  /** T1.1 gate 的反向过滤入口（T1.2 §5）。 */
  lifecycleOf(assetId: string, assetKind?: GovAssetKind): MemoryLifecycle | undefined;
  /** T1.4 元思维分区的待固化清单（validating 态）。 */
  validating(assetKind?: GovAssetKind): readonly string[];
  actions(assetId?: string): readonly GovAction[];
  /** 投影重建（不变量 8 的自证面：与线上写走同一折叠实现）。 */
  rebuildStates(assetKind?: GovAssetKind): Map<string, MemoryGovState>;
  scanState(): GovScanState;
  /** 当前活跃集（容量报表的数据面；T3.2 仪表盘亦用）。 */
  activeEntries(): readonly GovTimelineEntry[];
  /** 待执行（已提议未审批）的高风险动作。 */
  pendingApprovals(): readonly GovAction[];
}

export interface GovDeps {
  readonly domain: TdaDomain<GovTables>;
  readonly session: TdaSessionSink;
  readonly timeline: GovTimelineSeam;
  readonly recall?: GovRecallSeam;
  readonly task?: GovTaskSeam;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly tokenMeter?: (text: string) => number;
  readonly config?: GovConfig;
}

const DEFAULTS = {
  cycleMs: 6 * 60 * 60 * 1000,
  maxActionsPerScan: 20,
  maxScannedPerScan: 200,
  maxEntries: 5000,
  maxTokens: 200_000,
  unusedDays: 30,
  recencyHalfLifeDays: 30,
  nearDupMinLength: 24,
} as const;

const defaultTokenMeter = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const seqOfAction = (id: string): number => Number(String(id).slice('gov-'.length));

export function createGovernanceService(deps: GovDeps): GovernanceService {
  const clock = deps.now ?? ((): number => Date.now());
  const tokenMeter = deps.tokenMeter ?? defaultTokenMeter;
  const config = deps.config ?? {};
  const weights = config.weights ?? DEFAULT_GOVERNANCE_WEIGHTS;
  const cycleMs = config.cycleMs ?? DEFAULTS.cycleMs;
  const caps = {
    maxActions: config.maxActionsPerScan ?? DEFAULTS.maxActionsPerScan,
    maxScanned: config.maxScannedPerScan ?? DEFAULTS.maxScannedPerScan,
  };
  const maxEntries = config.maxEntries ?? DEFAULTS.maxEntries;
  const maxTokens = config.maxTokens ?? DEFAULTS.maxTokens;
  const unusedDaysMs = (config.unusedDays ?? DEFAULTS.unusedDays) * 86_400_000;
  const recencyHalfLifeDays = config.recencyHalfLifeDays ?? DEFAULTS.recencyHalfLifeDays;
  const nearDupMinLength = config.nearDupMinLength ?? DEFAULTS.nearDupMinLength;
  const context: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };

  let chain: Promise<unknown> = Promise.resolve();
  const withLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ── 读取面 ────────────────────────────────────────────────────────────────

  const readActions = (): GovAction[] => {
    const table = deps.domain.table('gov_actions');
    const list: GovAction[] = [];
    for (const [, value] of table.entries()) list.push(value);
    list.sort((a, b) => seqOfAction(a.id) - seqOfAction(b.id));
    return list;
  };

  /** 凭证镜像：来自 T0.3（治理不复制内容，J2）。 */
  const credentialOf = (assetId: string): GovCredential | undefined => deps.timeline.get(assetId)?.credential;

  /**
   * 复用快照：**只数 `inject` 行**（装配路每轮一条）。
   * `confirm` 行是 T0.4 预算裁决的补充证据，若一并计数会让同一轮被两条路径重复计。
   */
  const usageOf = (assetId: string): UsageSnapshot | undefined => {
    const rows = (deps.recall?.log({ entryId: assetId, injectedOnly: true }) ?? []).filter(
      (row) => row.kind === 'inject',
    );
    if (rows.length === 0) return { reuseCount: 0 };
    let last = rows[0]!.at;
    for (const row of rows) if (row.at > last) last = row.at;
    return { reuseCount: rows.length, lastUsedAt: last };
  };

  const projectionDeps = { credentialOf, usageOf };

  const rebuildStates = (assetKind?: GovAssetKind): Map<string, MemoryGovState> =>
    projectStates(readActions(), projectionDeps, assetKind);

  const stateOf = (assetId: string, assetKind: GovAssetKind = 'memory'): MemoryGovState | undefined =>
    deps.domain.table('memory_gov_states').get(govStateKey(assetKind, assetId));

  const activeEntries = (): readonly GovTimelineEntry[] =>
    deps.timeline.current().filter((entry) => entry.kind === 'chunk');

  const capacity = (): CapacityReport => {
    const active = activeEntries();
    const activeTokensEst = active.reduce((sum, entry) => sum + tokenMeter(entry.content), 0);
    const capsPair = { maxEntries, maxTokens };
    return {
      activeEntries: active.length,
      activeTokensEst,
      caps: capsPair,
      zone: capacityZone({ activeEntries: active.length, activeTokensEst, caps: capsPair }),
    };
  };

  /** 治理分排名（容量淘汰的可解释证据，不变量 5）。 */
  const rankActive = (at: number): readonly RankRow[] => {
    const active = activeEntries();
    const usages = active.map((entry) => usageOf(entry.id) ?? { reuseCount: 0 });
    const maxReuseCount = usages.reduce((max, usage) => (usage.reuseCount > max ? usage.reuseCount : max), 0);
    return active
      .map((entry, index) => {
        const usage = usages[index]!;
        const ageDays = Math.max(0, at - entry.createdAt) / 86_400_000;
        const recency = Math.pow(0.5, ageDays / recencyHalfLifeDays);
        return {
          assetId: entry.id,
          reuseCount: usage.reuseCount,
          credentialRank: CREDENTIAL_RANK[entry.credential],
          score: governanceScore(
            { reuseCount: usage.reuseCount, maxReuseCount, credential: entry.credential, recency },
            weights,
          ),
        };
      })
      .sort((a, b) => b.score - a.score || (a.assetId < b.assetId ? -1 : 1));
  };

  // ── 写入面 ────────────────────────────────────────────────────────────────

  const writerOf = (caller: GovCaller, at: number): GovWriterRef => ({
    sessionId: caller.sessionId,
    actor: caller.actor,
    at,
  });

  /** 投影刷新（派生写：仅域、无事件）。 */
  const refreshState = async (states: Map<string, MemoryGovState>): Promise<void> => {
    const table = deps.domain.table('memory_gov_states');
    await dualWriteDerived(async () => {
      for (const [key, value] of states) await table.put(key, value);
    }, context);
  };

  /** 权威写出口：落 gov_actions → append 事件 → 发布总线 → 刷新投影。 */
  const record = async (draft: {
    readonly assetKind: GovAssetKind;
    readonly assetId: string;
    readonly action: GovAction['action'];
    readonly from?: MemoryLifecycle;
    readonly to?: MemoryLifecycle;
    readonly reason?: GovReason;
    readonly evidence?: VerifyEvidence;
    readonly approvalToken?: string;
    readonly ranking?: readonly RankRow[];
    readonly promotedFrom?: string;
    readonly conflictWith?: readonly string[];
    readonly dupOf?: string;
    readonly caller: GovCaller;
  }): Promise<GovAction> => {
    const table = deps.domain.table('gov_actions');
    const at = clock();
    const id = allocateId(table, GOV_ACTION_PREFIX);
    const parsed = GovActionSchema.parse({
      id,
      assetKind: draft.assetKind,
      assetId: draft.assetId,
      action: draft.action,
      ...(draft.from !== undefined ? { from: draft.from } : {}),
      ...(draft.to !== undefined ? { to: draft.to } : {}),
      ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
      ...(draft.evidence !== undefined ? { evidence: draft.evidence } : {}),
      actor: writerOf(draft.caller, at),
      ...(draft.approvalToken !== undefined ? { approvalToken: draft.approvalToken } : {}),
      ...(draft.ranking !== undefined ? { ranking: draft.ranking.map((row) => ({ ...row })) } : {}),
      ...(draft.promotedFrom !== undefined ? { promotedFrom: draft.promotedFrom } : {}),
      ...(draft.conflictWith !== undefined ? { conflictWith: [...draft.conflictWith] } : {}),
      ...(draft.dupOf !== undefined ? { dupOf: draft.dupOf } : {}),
      at,
    });
    const payload = govActionPayload(parsed) as JsonObject;
    const seq = await dualWrite(
      deps.session,
      {
        family: 'memoryGov/change',
        businessId: String(parsed.id),
        payload,
        domainWrite: () => table.put(String(parsed.id), parsed),
      },
      context,
    );
    if (deps.bus !== undefined) {
      deps.bus.publish({
        family: 'memoryGov/change',
        businessId: String(parsed.id),
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
    await refreshState(rebuildStates());
    return parsed;
  };

  const isHighRisk = (action: GovAction): boolean =>
    (action.action === 'propose' && action.reason?.kind === 'capacity') || action.action === 'propose-invalidate';

  const pendingApprovals = (): readonly GovAction[] => readActions().filter(isHighRisk);

  // ── 迁移实现（不含锁：scan 在同一锁内直接调用它们）──────────────────────

  const applyRetire = async (
    caller: GovCaller,
    assetId: string,
    reason: GovReason,
    opts: GovRetireOptions = {},
    assetKind: GovAssetKind = 'memory',
  ): Promise<GovAction> => {
    const state = stateOf(assetId, assetKind);
    // archived 先判：它才是终局诊断（retired 只是软态，两者同时在场时终局优先）
    if (state?.archived === true) {
      throw new TdaError('GOV_ARCHIVED_TERMINAL', `条目 ${assetId} 已 archived（invalidate 是终局，不再动作）`);
    }
    if (state?.lifecycle === 'retired') {
      throw new TdaError('GOV_ALREADY_RETIRED', `条目 ${assetId} 已是 retired（重复退役）`);
    }
    if (reason.kind === 'capacity') {
      if (opts.approvalToken === undefined || opts.approvalToken === '') {
        throw new TdaError('GOV_APPROVAL_REQUIRED', 'capacity 强制淘汰属高风险动作，需人类一次性审批 token（J12）');
      }
      if (opts.ranking === undefined || opts.ranking.length === 0) {
        throw new TdaError('GOV_RANKING_REQUIRED', 'capacity 淘汰必须携带治理分排名快照（不变量 5）');
      }
    }
    return record({
      assetKind,
      assetId,
      action: 'retire',
      from: state?.lifecycle ?? 'draft',
      to: 'retired',
      reason,
      ...(opts.approvalToken !== undefined ? { approvalToken: opts.approvalToken } : {}),
      ...(opts.ranking !== undefined ? { ranking: opts.ranking } : {}),
      caller,
    });
  };

  const applyConsolidate = async (
    caller: GovCaller,
    assetId: string,
    assetKind: GovAssetKind = 'memory',
  ): Promise<GovAction> => {
    const state = stateOf(assetId, assetKind);
    // **非记忆资产**（T1.4 元思维）的固化条件由其所属插件的门承担（rehearsal pass），
    // 固化前置与凭证条件在这里只对 memory 生效——两类资产的证据形态不同，
    // 强行套用会把"回放验证才缓存"误判成"无凭证"。
    if (assetKind === 'memory') {
      if (state === undefined) {
        throw new TdaError('GOV_NOT_VALIDATING', `条目 ${assetId} 无治理状态（须先 promote 进入 validating）`);
      }
      if (state.lifecycle !== 'validating') {
        throw new TdaError('GOV_NOT_VALIDATING', `条目 ${assetId} 当前 ${state.lifecycle}，固化只能从 validating 起`);
      }
    } else if (state?.lifecycle === 'retired') {
      throw new TdaError('GOV_ALREADY_RETIRED', `条目 ${assetId} 已退役，不得固化`);
    }
    if (assetKind === 'memory') {
      const entry = deps.timeline.get(assetId);
    if (entry === undefined) {
      throw new TdaError('GOV_ASSET_NOT_FOUND', `条目 ${assetId} 不在时间线（弱引用已失效）`);
    }
    // J5 三条件（服务端断言，缺一拒绝）
    if (entry.quarantine) {
      throw new TdaError('GOV_QUARANTINED', `条目 ${assetId} 仍处隔离态，不得固化（J5 条件 ③）`);
    }
    if (CREDENTIAL_RANK[entry.credential] < CREDENTIAL_RANK[CONSOLIDATE_MIN_CREDENTIAL]) {
      throw new TdaError(
        'GOV_CREDENTIAL_TOO_LOW',
        `条目 ${assetId} 凭证 ${entry.credential} < ${CONSOLIDATE_MIN_CREDENTIAL}（J5 条件 ②）`,
      );
    }
    if ((state?.verifiedBy.length ?? 0) < 1) {
      throw new TdaError('GOV_NO_EXTERNAL_VERIFY', `条目 ${assetId} 无外部验证证据（J5 条件 ①）`);
    }
      return record({ assetKind, assetId, action: 'consolidate', from: 'validating', to: 'consolidated', caller });
    }
    // 非记忆资产：from 取当前态（无状态行 = draft），条件由所属插件门断言
    return record({
      assetKind,
      assetId,
      action: 'consolidate',
      from: state?.lifecycle ?? 'draft',
      to: 'consolidated',
      caller,
    });
  };

  const applyPromoteAsset = async (
    caller: GovCaller,
    assetId: string,
    assetKind: GovAssetKind,
    note: string,
  ): Promise<GovAction> => {
    if (assetKind === 'memory') {
      // memory 走原通道（时间线 chunk 证据）
      return applyPromote(caller, assetId, { taskId: 'skill-external', note } as never);
    }
    const state = stateOf(assetId, assetKind);
    if (state?.lifecycle === 'retired' || state?.archived === true) {
      throw new TdaError('GOV_ALREADY_RETIRED', `资产 ${assetId} 已退役，不得晋升`);
    }
    if (state?.lifecycle === 'validating' || state?.lifecycle === 'consolidated') {
      throw new TdaError('GOV_ALREADY_PROMOTED', `资产 ${assetId} 当前 ${String(state?.lifecycle)}，无需晋升`);
    }
    // 非记忆资产：rehearsal pass 的证据由所属插件断言（J4/T2.2 J5），这里只留痕
    return record({
      assetKind,
      assetId,
      action: 'promote',
      from: state?.lifecycle ?? 'draft',
      to: 'validating',
      caller,
      // note 只进日志载荷（promote 不得挂退役原因——归因律全域生效）
    });
  };

  const applyPromote = async (
    caller: GovCaller,
    assetId: string,
    evidence: VerifyEvidence,
  ): Promise<GovAction> => {
    const entry = deps.timeline.get(assetId);
    if (entry === undefined || entry.kind !== 'chunk') {
      throw new TdaError('GOV_ASSET_NOT_FOUND', `条目 ${assetId} 不是可治理的 chunk`);
    }
    if (entry.chunkType === undefined) {
      throw new TdaError('GOV_ASSET_NOT_FOUND', `条目 ${assetId} 缺 chunkType，无法转正`);
    }
    // 证据校验（J5 条件 ①）：任务 success ∧ 该条目在该任务执行期被复用
    const task = deps.task?.get(evidence.taskId);
    if (task === undefined) {
      throw new TdaError('GOV_EVIDENCE_TASK_NOT_FOUND', `证据指向的任务 ${evidence.taskId} 不存在（弱引用即断链）`);
    }
    if (task.phase !== 'complete' || task.outcome !== 'success') {
      throw new TdaError(
        'GOV_EVIDENCE_TASK_NOT_SUCCESS',
        `任务 ${evidence.taskId} 未以 success 收尾（phase=${task.phase} outcome=${String(task.outcome)}），不构成外部验证`,
      );
    }
    const reused = (deps.recall?.log({ entryId: assetId, injectedOnly: true }) ?? []).filter(
      (row) => row.taskId === evidence.taskId,
    );
    if (reused.length === 0) {
      throw new TdaError(
        'GOV_EVIDENCE_NO_REUSE',
        `条目 ${assetId} 在任务 ${evidence.taskId} 执行期无 injected 记录（注入≠贡献，证据不成立）`,
      );
    }
    if (!reused.some((row) => row.at === evidence.injectedAt)) {
      throw new TdaError(
        'GOV_EVIDENCE_INJECTED_AT_MISMATCH',
        `证据注入时刻 ${evidence.injectedAt} 与 recall_log 不符（可用：${reused.map((row) => row.at).join('、')}）`,
      );
    }

    const state = stateOf(assetId);
    if (state?.lifecycle === 'consolidated') {
      throw new TdaError('GOV_ALREADY_CONSOLIDATED', `条目 ${assetId} 已固化`);
    }

    if (entry.quarantine) {
      // J4：转正只经 supersede 新条目（原隔离标记永不消失，隔离史可溯）
      const writer = writerOf(caller, clock());
      const created = await deps.timeline.supersede(
        writer,
        assetId,
        {
          content: entry.content,
          chunkType: entry.chunkType,
          source: entry.source,
          credential: 'execution-verified',
          ...(entry.relatedTaskId !== undefined ? { relatedTaskId: entry.relatedTaskId } : {}),
        },
        `治理转正：外部验证通过（任务 ${evidence.taskId} 成功复用）`,
      );
      return record({
        assetKind: 'memory',
        assetId: String(created.id),
        action: 'promote',
        from: 'draft',
        to: 'validating',
        evidence,
        reason: { kind: 'verify-pass', detail: `supersede 原隔离条目 ${assetId}` },
        promotedFrom: assetId,
        caller,
      });
    }
    return record({
      assetKind: 'memory',
      assetId,
      action: 'promote',
      from: state?.lifecycle ?? 'draft',
      to: 'validating',
      evidence,
      reason: { kind: 'verify-pass', detail: `原条目迁 validating（任务 ${evidence.taskId}）` },
      caller,
    });
  };

  const applyRestore = async (
    caller: GovCaller,
    assetId: string,
    assetKind: GovAssetKind = 'memory',
  ): Promise<GovAction> => {
    const state = stateOf(assetId, assetKind);
    if (state === undefined || state.lifecycle !== 'retired') {
      throw new TdaError('GOV_NOT_RETIRED', `条目 ${assetId} 不在 retired 态，无从恢复`);
    }
    if (state.archived) {
      throw new TdaError('GOV_ARCHIVED_TERMINAL', `条目 ${assetId} 已 archived（内容层作废是终局，恢复须新条目）`);
    }
    if (caller.actor !== 'human') {
      throw new TdaError('GOV_RESTORE_REQUIRES_HUMAN', `恢复退役属人工触发（收到 actor=${caller.actor}）`);
    }
    return record({ assetKind, assetId, action: 'restore', from: 'retired', to: 'consolidated', caller });
  };

  const applyProposeInvalidate = async (
    caller: GovCaller,
    assetId: string,
    reason: string,
    opts: { readonly approvalToken?: string } = {},
  ): Promise<GovAction> => {
    const state = stateOf(assetId);
    if (state?.archived === true) {
      throw new TdaError('GOV_ALREADY_ARCHIVED', `条目 ${assetId} 已作废（重复提议）`);
    }
    const entry = deps.timeline.get(assetId);
    if (entry === undefined) {
      throw new TdaError('GOV_ASSET_NOT_FOUND', `条目 ${assetId} 不在时间线`);
    }
    const approved = opts.approvalToken !== undefined && opts.approvalToken !== '';
    if (approved) {
      // 先经 T0.3 单一漏斗落作废记录，再记治理动作（反序会让状态声称 archived 而漏斗未跑）
      await deps.timeline.invalidate(writerOf(caller, clock()), assetId, reason);
    }
    return record({
      assetKind: 'memory',
      assetId,
      action: 'propose-invalidate',
      reason: { kind: 'manual', detail: reason },
      ...(approved ? { approvalToken: opts.approvalToken } : {}),
      caller,
    });
  };

  return {
    async initialize() {
      const table = deps.domain.table('gov_scan_state');
      const existing = table.get(GOV_SCAN_STATE_KEY);
      if (existing !== undefined) {
        // 水位可回退到安全值：游标指向已消失的条目时从头扫（不静默跳过）
        return existing;
      }
      const seed: GovScanState = { lastScanAt: 0, cursor: '', cycleMs, caps };
      await dualWriteDerived(() => table.put(GOV_SCAN_STATE_KEY, seed), context);
      return seed;
    },

    async scan(caller, opts = {}) {
      return withLock(async () => {
        const now = clock();
        const scanState = deps.domain.table('gov_scan_state').get(GOV_SCAN_STATE_KEY) ?? {
          lastScanAt: 0,
          cursor: '',
          cycleMs,
          caps,
        };
        const limit = Math.min(opts.limit ?? caps.maxScanned, caps.maxScanned);

        const states = rebuildStates('memory');
        const tracked = [...states.values()].map((state) => state.assetId);
        const base = new Set(tracked.concat(activeEntries().map((entry) => entry.id)));
        // §2.2：扫描面 = current() + 替代链/作废链闭包——被取代的旧条目不在 current() 里，
        // 只有并入 history 闭包才能被"superseded 检测"看见。
        const expanded = new Set(base);
        for (const id of base) for (const member of deps.timeline.history(id)) expanded.add(member.id);
        const candidates = [...expanded].sort();
        const startIndex = scanState.cursor === '' ? 0 : candidates.indexOf(scanState.cursor) + 1;
        const slice = candidates.slice(startIndex, startIndex + limit);
        const nextCursor = startIndex + limit < candidates.length ? (slice.at(-1) ?? '') : '';

        const proposals: GovAction[] = [];
        const executed: GovAction[] = [];
        const pending: GovAction[] = [];
        let conflictsFound = 0;
        const budgetReached = (): boolean => executed.length + pending.length >= caps.maxActions;

        const currentEntries = activeEntries();
        const seenContent = new Map<string, string>();

        for (const assetId of slice) {
          if (budgetReached()) break; // 余量移交下次周期（不变量 7）
          const entry = deps.timeline.get(assetId);
          if (entry === undefined || entry.kind !== 'chunk') continue;
          const state = states.get(govStateKey('memory', assetId));

          // ① conflict：同一条目被 ≥2 个不同新条目直接取代（J9 只标记不裁决）。
          // 顺序优先级：分叉冲突比"已被取代"更具体——若先走 superseded 退役，
          // "被两个版本取代"这一异常就被"已被取代"掩盖了（J9 的"不隐藏裁决"）。
          const forks = currentEntries.filter((candidate) => candidate.supersedes === assetId);
          if (forks.length >= 2) {
            if (state?.conflict === undefined) {
              const action = await record({
                assetKind: 'memory',
                assetId,
                action: 'flag-conflict',
                reason: { kind: 'conflict', detail: `分叉 supersede：${forks.map((f) => f.id).join('、')}` },
                conflictWith: forks.map((fork) => fork.id),
                caller,
              });
              proposals.push(action);
              executed.push(action);
              conflictsFound += 1;
            }
            continue;
          }

          // ② superseded：T0.3 history 链尾 ≠ 本条目（低风险，自动执行）
          const history = deps.timeline.history(assetId);
          const tail = history.at(-1);
          if (history.length > 1 && tail !== undefined && String(tail.id) !== assetId) {
            if (state?.lifecycle !== 'retired') {
              const action = await applyRetire(caller, assetId, {
                kind: 'superseded',
                detail: `链尾 ${String(tail.id)} 已取代本条目`,
              });
              proposals.push(action);
              executed.push(action);
            }
            continue;
          }

          // ③ unused-days：无复用超阈值（低风险，自动执行）
          const usage = usageOf(assetId);
          const lifecycle = state?.lifecycle ?? 'draft';
          if (
            (lifecycle === 'consolidated' || lifecycle === 'validating') &&
            isUnusedTooLong({
              lastUsedAt: usage?.lastUsedAt,
              createdAt: entry.createdAt,
              now,
              unusedDaysMs,
            })
          ) {
            const action = await applyRetire(caller, assetId, {
              kind: 'unused-days',
              detail: `最近使用 ${usage?.lastUsedAt === undefined ? '从未' : new Date(usage.lastUsedAt).toISOString()}，超 ${unusedDaysMs / 86_400_000} 天`,
            });
            proposals.push(action);
            executed.push(action);
            continue;
          }

          // ④ near-duplicate：同 chunkType + 同正文（只标记 dupOf，不合并；U4）
          if (entry.chunkType !== undefined && entry.content.length >= nearDupMinLength) {
            const key = `${entry.chunkType}\u0000${entry.content}`;
            const first = seenContent.get(key);
            if (first === undefined) {
              seenContent.set(key, assetId);
            } else if (state?.dupOf === undefined) {
              const action = await record({
                assetKind: 'memory',
                assetId,
                action: 'propose',
                reason: { kind: 'dup', detail: `与 ${first} 正文全等（同 chunkType）` },
                dupOf: first,
                caller,
              });
              proposals.push(action);
              executed.push(action);
            }
          }
        }

        // ⑤ 容量压力（J8 双维）：只**提议**，不代执行（J12）
        const capacityReport = capacity();
        if (capacityReport.zone !== 'normal' && !budgetReached()) {
          const ranking = rankActive(now);
          const overBy = Math.max(
            1,
            capacityReport.activeEntries - maxEntries,
            Math.ceil((capacityReport.activeTokensEst - maxTokens) / Math.max(1, maxTokens / Math.max(1, maxEntries))),
          );
          const victims = capacityReport.zone === 'over' ? ranking.slice(-Math.min(overBy, caps.maxActions)) : ranking.slice(-1);
          for (const victim of victims) {
            if (budgetReached()) break;
            const rank = ranking.findIndex((row) => row.assetId === victim.assetId) + 1;
            const action = await record({
              assetKind: 'memory',
              assetId: victim.assetId,
              action: 'propose',
              reason: {
                kind: 'capacity',
                detail: `rank=${rank}/${ranking.length} score=${victim.score.toFixed(4)} zone=${capacityReport.zone} (entries ${capacityReport.activeEntries}/${maxEntries}, tokens ${capacityReport.activeTokensEst}/${maxTokens})`,
              },
              ranking,
              caller,
            });
            proposals.push(action);
            pending.push(action);
          }
        }

        // 水位更新（派生写：仅域无事件）
        const next: GovScanState = { lastScanAt: now, cursor: nextCursor, cycleMs, caps };
        // 必须 await：水位是下一轮的输入，fire-and-forget 会让下轮读到旧游标
        //（与 IT2/IT4 修过的"原子发布串行化 / 索引串行"同一类并发纪律）
        await dualWriteDerived(async () => {
          await deps.domain.table('gov_scan_state').put(GOV_SCAN_STATE_KEY, next);
        }, context);

        return {
          scanned: slice.length,
          proposals,
          executed,
          pendingApproval: pending,
          conflictsFound,
          capacity: capacityReport,
          nextCursor,
        };
      });
    },

    promote(caller, assetId, evidence) {
      return withLock(() => applyPromote(caller, assetId, evidence));
    },

    promoteAsset(caller, assetId, assetKind, note) {
      return withLock(() => applyPromoteAsset(caller, assetId, assetKind, note));
    },

    consolidate(caller, assetId, assetKind = 'memory') {
      return withLock(() => applyConsolidate(caller, assetId, assetKind));
    },

    retire(caller, assetId, reason, opts = {}, assetKind = 'memory') {
      return withLock(() => applyRetire(caller, assetId, reason, opts, assetKind));
    },

    restore(caller, assetId, assetKind = 'memory') {
      return withLock(() => applyRestore(caller, assetId, assetKind));
    },

    proposeInvalidate(caller, assetId, reason, opts = {}) {
      return withLock(() => applyProposeInvalidate(caller, assetId, reason, opts));
    },

    conflicts() {
      return [...rebuildStates('memory').values()].filter((state) => state.conflict !== undefined);
    },

    capacity,

    state(assetId, assetKind = 'memory') {
      return stateOf(assetId, assetKind);
    },

    lifecycleOf(assetId, assetKind = 'memory') {
      return stateOf(assetId, assetKind)?.lifecycle;
    },

    actions(assetId) {
      const all = readActions();
      return assetId === undefined ? all : all.filter((action) => action.assetId === assetId);
    },

    rebuildStates,

    scanState() {
      return (
        deps.domain.table('gov_scan_state').get(GOV_SCAN_STATE_KEY) ?? { lastScanAt: 0, cursor: '', cycleMs, caps }
      );
    },

    validating(assetKind = 'memory') {
      return [...rebuildStates(assetKind).values()]
        .filter((state) => state.lifecycle === 'validating')
        .map((state) => state.assetId);
    },

    activeEntries,

    pendingApprovals,
  };
}
