/**
 * tda-meta-thinking 服务：ctx.metaThinking 服务面实现（T1.4 §4.2）。
 *
 * **治理单一**（J1/不变量 6）：本服务**没有** lifecycle 字段、没有 retire 本地实现——
 * 一切状态迁移委托 `ctx.governance`（assetKind='meta-thinking' 分区）。注入池只认
 * 治理态 consolidated（不变量 3：未验证零注入），draft/fail 的候选在服务端被滤掉。
 *
 * **rehearsal 是 T0.7 fork seam 的首个真实消费方**（J5）：fork 到任务边界 → 子会话
 * 注入结构提示试跑 → coverage（拓扑步骤在子会话 transition 链的覆盖率）∧ outcome
 * 双条件判 verdict → 判定输入全落盘（可复算，不变量 4）。执行本体经 `executor`
 * seam 注入（装配层桥接 fork + 派发），本服务只管判定与记账。
 *
 * 连续 rehearsal 失败自动退役（J8）：与记忆的保守纪律**刻意不同**——rehearsal 是
 * 受控实验，证伪是直接证据不是弱归因，故达阈值即 retire('rehearsal-fail')。
 */
import {
  allocateId,
  dualWrite,
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
  META_PATH_PREFIX,
  REHEARSAL_PREFIX,
  type MetaMode,
  type MetaPath,
  type MetaThinkingTables,
  type RehearsalRun,
} from './domain.ts';
import { metaPathPayload, rehearsalPayload } from './events.ts';

export type MetaLifecycle = 'draft' | 'validating' | 'consolidated' | 'retired';

/** 治理 seam（结构镜像 tda-governance 服务面的子集；零 import）。 */
export interface MetaGovernanceSeam {
  lifecycleOf(assetId: string, assetKind?: string): MetaLifecycle | undefined;
  consolidate(
    actor: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string },
    assetId: string,
    assetKind?: string,
  ): Promise<unknown>;
  validating(assetKind?: string): readonly string[];
  retire(
    actor: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string },
    assetId: string,
    reason: { readonly kind: string; readonly detail: string },
    opts?: { readonly approvalToken?: string },
    assetKind?: string,
  ): Promise<unknown>;
}

/**
 * rehearsal 执行 seam（T0.7 fork 的装配桥）。
 * 返回子会话 id、任务终态与**脱敏**的 transition 动作分类串（T1.3 同款，零原文）。
 */
export interface RehearsalExecutor {
  run(input: {
    readonly metaPath: MetaPath;
    readonly taskId: string;
    readonly boundary: { readonly sessionId: string; readonly eventKind: string; readonly seq: number };
    readonly structureHint: string;
  }): Promise<{
    readonly childSessionId: string;
    readonly outcome: 'success' | 'failure';
    readonly transitionTokens: readonly string[];
  }>;
}

export interface MetaThinkingConfig {
  /** coverage 阈值 θ_cov（U2）。 */
  readonly coverageTheta?: number;
  /** 连续 rehearsal 失败自动退役阈值（J8，P0 默认 3）。 */
  readonly consecutiveFailLimit?: number;
  /** 结构提示 token 上限（J7，P0 默认 120）。 */
  readonly hintMaxTokens?: number;
  /** 活跃（consolidated）元路径容量（J10）。 */
  readonly activeCapacity?: number;
  /** 同 mode 注入候选上限（J10 多样性保护）。 */
  readonly perModeLimit?: number;
}

/** 候选草稿（§4.2：Omit<MetaPath,'id'|'stats'|'version'|'createdAt'|'updatedAt'>）。 */
export interface MetaPathDraft {
  readonly topology: MetaPath['topology'];
  readonly mode: MetaMode;
  readonly applicability: MetaPath['applicability'];
  readonly source: MetaPath['source'];
}

export interface MetaThinkingService {
  propose(actor: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string }, draft: MetaPathDraft): Promise<MetaPath>;
  /** J4 辅路：transition 链 → shape 参考（机械映射表，供 coach 修订）。 */
  extractFromTrajectory(tokens: readonly string[], refs: readonly { sessionId: string; seqFrom: number; seqTo: number }[]): MetaPathDraft;
  rehearse(actor: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string }, metaPathId: string, taskId: string): Promise<RehearsalRun>;
  requestConsolidate(actor: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string }, metaPathId: string): Promise<void>;
  injectCandidates(session: { readonly sessionId: string }, round: number, stage?: string): Promise<readonly MetaPath[]>;
  paths(filter?: { readonly mode?: MetaMode; readonly stage?: string; readonly taskClass?: string }): readonly MetaPath[];
  get(id: string): MetaPath | undefined;
  supersede(actor: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string }, oldId: string, draft: MetaPathDraft): Promise<MetaPath>;
  history(id: string): readonly MetaPath[];
  rehearsals(metaPathId?: string): readonly RehearsalRun[];
  /** J7：注入文本 = 拓扑序列化（类型标签序列），≤hintMaxTokens。 */
  renderStructureHint(metaPath: MetaPath): string;
  initialize(): Promise<void>;
}

export interface MetaThinkingDeps {
  readonly domain: TdaDomain<MetaThinkingTables>;
  readonly session: TdaSessionSink;
  readonly governance: MetaGovernanceSeam;
  readonly executor: RehearsalExecutor;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly tokenMeter?: (text: string) => number;
  readonly config?: MetaThinkingConfig;
}

const DEFAULTS = {
  coverageTheta: 0.6,
  consecutiveFailLimit: 3,
  hintMaxTokens: 120,
  activeCapacity: 20,
  perModeLimit: 3,
} as const;

const defaultTokenMeter = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const seqOf = (id: string, prefix: string): number => Number(String(id).slice(prefix.length + 1));

/** J4 辅路的固定映射表（U1：与 T2.1 coach 一并标定）。 */
export const TOKEN_TO_STEP: readonly (readonly [string, string])[] = [
  ['read', 'observe'],
  ['query', 'observe'],
  ['edit', 'verify'],
  ['write', 'verify'],
  ['dispatch', 'decompose'],
  ['stage:', 'synthesize'],
  ['close:', 'observe'],
];

export function tokenToStep(token: string): string {
  for (const [prefix, kind] of TOKEN_TO_STEP) {
    if (token.startsWith(prefix)) return kind;
  }
  return 'hypothesize';
}

export function createMetaThinkingService(deps: MetaThinkingDeps): MetaThinkingService {
  const clock = deps.now ?? ((): number => Date.now());
  const tokenMeter = deps.tokenMeter ?? defaultTokenMeter;
  const config = deps.config ?? {};
  const coverageTheta = config.coverageTheta ?? DEFAULTS.coverageTheta;
  const consecutiveFailLimit = config.consecutiveFailLimit ?? DEFAULTS.consecutiveFailLimit;
  const hintMaxTokens = config.hintMaxTokens ?? DEFAULTS.hintMaxTokens;
  const activeCapacity = config.activeCapacity ?? DEFAULTS.activeCapacity;
  const perModeLimit = config.perModeLimit ?? DEFAULTS.perModeLimit;
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

  const readPaths = (): MetaPath[] => {
    const list: MetaPath[] = [];
    for (const [, value] of deps.domain.table('meta_paths').entries()) list.push(value);
    return list.sort((a, b) => seqOf(a.id, META_PATH_PREFIX) - seqOf(b.id, META_PATH_PREFIX));
  };

  const readRehearsals = (): RehearsalRun[] => {
    const list: RehearsalRun[] = [];
    for (const [, value] of deps.domain.table('rehearsal_runs').entries()) list.push(value);
    return list.sort((a, b) => seqOf(a.id, REHEARSAL_PREFIX) - seqOf(b.id, REHEARSAL_PREFIX));
  };

  const mustGet = (id: string): MetaPath => {
    const path = deps.domain.table('meta_paths').get(id);
    if (path === undefined) throw new TdaError('META_PATH_NOT_FOUND', `元路径 ${id} 不存在`);
    return path;
  };

  const commitPath = async (path: MetaPath): Promise<void> => {
    const payload = metaPathPayload(path) as JsonObject;
    const seq = await dualWrite(
      deps.session,
      {
        family: 'metaPath/change',
        businessId: String(path.id),
        payload,
        domainWrite: () => deps.domain.table('meta_paths').put(String(path.id), path),
      },
      context,
    );
    if (deps.bus !== undefined) {
      deps.bus.publish({
        family: 'metaPath/change',
        businessId: String(path.id),
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
  };

  const commitRehearsal = async (run: RehearsalRun): Promise<void> => {
    const payload = rehearsalPayload(run) as JsonObject;
    const seq = await dualWrite(
      deps.session,
      {
        family: 'metaPath/change',
        businessId: String(run.id),
        payload,
        domainWrite: () => deps.domain.table('rehearsal_runs').put(String(run.id), run),
      },
      context,
    );
    if (deps.bus !== undefined) {
      deps.bus.publish({
        family: 'metaPath/change',
        businessId: String(run.id),
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
  };

  /** 结构提示（J7）：从 entry 沿 seq/cond 边走主干，分支折叠成 (a | b)。 */
  const renderStructureHint = (metaPath: MetaPath): string => {
    const { topology } = metaPath;
    const outgoing = new Map<string, { to: string; kind: string }[]>();
    for (const edge of topology.edges) {
      const list = outgoing.get(edge.from) ?? [];
      list.push({ to: edge.to, kind: edge.kind });
      outgoing.set(edge.from, list);
    }
    const kindOf = (id: string): string => {
      const node = topology.nodes.find((item) => item.id === id);
      return node?.label ?? node?.kind ?? id;
    };
    const parts: string[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined = topology.entry;
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      parts.push(kindOf(cursor));
      const nexts: { readonly to: string; readonly kind: string }[] = outgoing.get(cursor) ?? [];
      if (nexts.length === 0) break;
      if (nexts.length === 1) {
        cursor = nexts[0]!.to;
        continue;
      }
      // 分支：全部后继折叠为 (a | b)，然后终止（提示是"支架"不是流程图全文）
      parts.push(`(${nexts.map((next: { readonly to: string; readonly kind: string }) => kindOf(next.to)).join(' | ')})`);
      break;
    }
    return parts.join(' → ');
  };

  /**
   * 提案实现（**无锁**）：promise 链锁不可重入——supersede 在持锁窗口内调用本实现，
   * 公开 propose 只是加锁包装（同 governance/drift 的 applyXxx 纪律）。
   */
  const applyPropose = async (
    actor: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string },
    draft: MetaPathDraft,
  ): Promise<MetaPath> => {
    const table = deps.domain.table('meta_paths');
    const id = allocateId(table, META_PATH_PREFIX);
    const at = clock();
    const path = {
      id: id as never,
      topology: draft.topology,
      mode: draft.mode,
      applicability: draft.applicability,
      stats: { rehearsalPass: 0, rehearsalFail: 0, consecutiveRehearsalFail: 0, realUse: 0 },
      source: draft.source,
      version: 1,
      createdAt: at,
      updatedAt: at,
    } as MetaPath;
    await commitPath(path);
    void actor;
    return path;
  };

  return {
    async initialize() {
      // 启动序（纪律 #7）：本插件没有"必须先建"的种子行（lifecycle 在治理侧），
      // 但要校验治理 seam 就位——fail-loud 而非静默降级。
      if (deps.governance === undefined || typeof deps.governance.lifecycleOf !== 'function') {
        throw new TdaError('META_GOVERNANCE_MISSING', 'ctx.governance 未装配（元思维依赖统一治理管道，J1）');
      }
    },

    async propose(actor, draft) {
      // 加锁包装（supersede 在持锁窗口内必须走无锁的 applyPropose）
      return withLock(() => applyPropose(actor, draft));
    },

    extractFromTrajectory(tokens, refs) {
      // 机械映射（J4）：transition 分类串 → 推理步类型；去重保序成线性拓扑
      const kinds: string[] = [];
      for (const token of tokens) {
        const kind = tokenToStep(token);
        if (kinds[kinds.length - 1] !== kind) kinds.push(kind);
      }
      if (kinds.length === 0) kinds.push('observe');
      const nodes = kinds.map((kind, index) => ({ id: `s${index + 1}`, kind: kind as never }));
      const edges = nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1]!.id, kind: 'seq' as const }));
      const last = nodes[nodes.length - 1]!.id;
      return {
        topology: { nodes, edges, entry: nodes[0]!.id, exits: [last] },
        mode: kinds.includes('hypothesize') || kinds.includes('analogize') ? 'divergent' : 'convergent',
        applicability: { taskClasses: [], stages: ['executing'], problemFeatures: [] },
        source: { kind: 'trajectory-extract', refs: refs.map((ref) => ({ ...ref })) },
      } as MetaPathDraft;
    },

    async rehearse(actor, metaPathId, taskId) {
      return withLock(async () => {
        const metaPath = mustGet(metaPathId);
        const lifecycle = deps.governance.lifecycleOf(metaPathId, 'meta-thinking');
        if (lifecycle === 'retired') {
          throw new TdaError('META_RETIRED', `元路径 ${metaPathId} 已退役，不得再 rehearse`);
        }
        const structureHint = renderStructureHint(metaPath);
        if (tokenMeter(structureHint) > hintMaxTokens) {
          throw new TdaError('META_HINT_TOO_LONG', `结构提示 ${tokenMeter(structureHint)} token > 上限 ${hintMaxTokens}（J7）`);
        }
        // 显式 boundary（禁开放轮次前缀）：以"该任务最近一次 closed 轮次"为界——
        // 由 executor 落实 fork 语义，这里只传任务锚点与来源会话。
        const boundary = { sessionId: deps.session.sessionId, eventKind: 'task-boundary', seq: 0 };
        const executed = await deps.executor.run({ metaPath, taskId, boundary, structureHint });
        // coverage：拓扑步骤种类在子会话 transition 链（映射后）中的覆盖率
        const mapped = new Set(executed.transitionTokens.map((token) => tokenToStep(token)));
        const steps = new Set(metaPath.topology.nodes.map((node) => node.kind));
        let hit = 0;
        for (const step of steps) if (mapped.has(step)) hit += 1;
        const coverage = steps.size === 0 ? 0 : hit / steps.size;
        const verdict = executed.outcome === 'success' && coverage >= coverageTheta ? 'pass' : 'fail';

        const runTable = deps.domain.table('rehearsal_runs');
        const runId = allocateId(runTable, REHEARSAL_PREFIX);
        const run: RehearsalRun = {
          id: runId as never,
          metaPathId,
          taskId,
          childSessionId: executed.childSessionId,
          boundary: { ...boundary },
          verdict,
          coverage,
          outcome: executed.outcome,
          at: clock(),
        };
        await commitRehearsal(run);

        // stats 更新（J6/J8）：pass 清零连续计数；fail 累加并判自动退役
        const previousFail = verdict === 'fail' ? metaPath.stats.consecutiveRehearsalFail + 1 : 0;
        const next: MetaPath = {
          ...metaPath,
          stats: {
            rehearsalPass: metaPath.stats.rehearsalPass + (verdict === 'pass' ? 1 : 0),
            rehearsalFail: metaPath.stats.rehearsalFail + (verdict === 'fail' ? 1 : 0),
            consecutiveRehearsalFail: previousFail,
            realUse: metaPath.stats.realUse,
          },
          updatedAt: clock(),
        };
        await commitPath(next);

        if (previousFail >= consecutiveFailLimit) {
          // J8：受控实验证伪 = 直接证据 → 自动退役（不经审批，与记忆口径刻意不同）
          await deps.governance.retire(
            { actor: actor.actor, sessionId: actor.sessionId },
            metaPathId,
            { kind: 'rehearsal-fail', detail: `连续 ${previousFail} 次 rehearsal 失败（阈值 ${consecutiveFailLimit}）` },
            undefined,
            'meta-thinking',
          );
        }
        return run;
      });
    },

    async requestConsolidate(actor, metaPathId) {
      const path = mustGet(metaPathId);
      const lifecycle = deps.governance.lifecycleOf(metaPathId, 'meta-thinking');
      if (lifecycle === 'retired') {
        throw new TdaError('META_RETIRED', `元路径 ${metaPathId} 已退役，不得固化`);
      }
      if (lifecycle === 'consolidated') {
        throw new TdaError('META_ALREADY_CONSOLIDATED', `元路径 ${metaPathId} 已固化（重复提请）`);
      }
      // 允许从 draft 直接固化：通过的 rehearsal 记录本身就是晋升证据（J6 判定式）
      const lastRun = readRehearsals().filter((run) => run.metaPathId === metaPathId).at(-1);
      if (lastRun === undefined || lastRun.verdict !== 'pass') {
        throw new TdaError('META_NO_PASS', `元路径 ${metaPathId} 无通过的 rehearsal 记录（回放验证才缓存，J6）`);
      }
      void path;
      await deps.governance.consolidate({ actor: actor.actor, sessionId: actor.sessionId }, metaPathId, 'meta-thinking');
    },

    async injectCandidates(_session, _round, stage) {
      // 不变量 3：只返回治理态 consolidated 的元路径（draft/fail 一律滤掉）
      const consolidated = readPaths().filter(
        (path) => deps.governance.lifecycleOf(String(path.id), 'meta-thinking') === 'consolidated',
      );
      const eligible =
        stage === undefined
          ? consolidated
          : consolidated.filter((path) => path.applicability.stages.length === 0 || path.applicability.stages.includes(stage as never));
      // J3 双路径路由：planning → divergent 优先；executing/verifying → convergent 优先
      const divergentFirst = stage === 'planning';
      const sorted = [...eligible].sort((a, b) => {
        const modeA = (divergentFirst ? a.mode === 'divergent' : a.mode === 'convergent') ? 0 : 1;
        const modeB = (divergentFirst ? b.mode === 'divergent' : b.mode === 'convergent') ? 0 : 1;
        return modeA - modeB || b.stats.rehearsalPass - a.stats.rehearsalPass || String(a.id).localeCompare(String(b.id));
      });
      // J10 多样性保护：同 mode 至多 perModeLimit 条
      const counts = new Map<MetaMode, number>();
      const out: MetaPath[] = [];
      for (const path of sorted) {
        const count = counts.get(path.mode) ?? 0;
        if (count >= perModeLimit) continue;
        counts.set(path.mode, count + 1);
        out.push(path);
      }
      return out.slice(0, activeCapacity);
    },

    paths(filter = {}) {
      return readPaths().filter((path) => {
        if (filter.mode !== undefined && path.mode !== filter.mode) return false;
        if (filter.stage !== undefined && !path.applicability.stages.includes(filter.stage as never)) return false;
        if (filter.taskClass !== undefined && !path.applicability.taskClasses.includes(filter.taskClass)) return false;
        return true;
      });
    },

    get(id) {
      return deps.domain.table('meta_paths').get(id);
    },

    async supersede(actor, oldId, draft) {
      return withLock(async () => {
        const old = mustGet(oldId);
        // 无锁直调（supersede 已持锁；this.propose 会二次入链自锁死）
        const created = await applyPropose(actor, {
          ...draft,
          source: draft.source,
        });
        const next: MetaPath = {
          ...created,
          supersedes: String(old.id),
          version: old.version + 1,
          updatedAt: clock(),
        };
        await commitPath(next);
        // 旧版退役（治理管道，同 T1.2 J7 的 superseded 口径）
        await deps.governance.retire(
          { actor: actor.actor, sessionId: actor.sessionId },
          oldId,
          { kind: 'superseded', detail: `被 ${String(next.id)} 取代` },
          undefined,
          'meta-thinking',
        );
        return next;
      });
    },

    history(id) {
      // supersede 链（不变量 8：旧版保留可查）
      const chain: MetaPath[] = [];
      let cursor: string | undefined = id;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        const path = deps.domain.table('meta_paths').get(cursor);
        if (path === undefined) break;
        chain.push(path);
        cursor = path.supersedes;
      }
      return chain;
    },

    rehearsals(metaPathId) {
      const list = readRehearsals();
      return metaPathId === undefined ? list : list.filter((run) => run.metaPathId === metaPathId);
    },

    renderStructureHint,
  };
}
