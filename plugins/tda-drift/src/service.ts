/**
 * tda-drift 服务：ctx.drift 服务面实现（T1.5 §4.2）。
 *
 * **检测器是旁路观察者，零目标写权**（J1）：deps 里的 goal seam 只含只读方法 +
 * `recordCalibration`（校准记录的落点，权威在 T0.1 domain）。加载期有一条
 * `drift-zero-goal-write` 检查，把"seam 上出现了目标 mutation 方法"直接判红——
 * 编译期约束之外再上一道运行时闸。
 *
 * 两条触发（J6）：周期（宿主驱动）+ 事件（`goalTree/change` 的 objective edit）。
 * 单次 evaluate 的计算量有帽（transitions 窗口扫描上限 = 配置 `windowScanCap`）。
 *
 * 待执行校准队列是**进程内投放状态**（不是权威）：权威是 calibrations 记录
 * （含 `snapshot=<id>` 回链）；重启后队列由下一次 evaluate 重建（仍在漂移就会再生成）。
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
  CALIBRATION_RISKS,
  DEFAULT_DRIFT_PARAMS,
  DRIFT_METRICS,
  DRIFT_PARAMS_BUSINESS_ID,
  DRIFT_PARAMS_KEY,
  DriftParamsSchema,
  METRIC_ACTION,
  SNAPSHOT_PREFIX,
  type CalibrationAction,
  type DriftMetric,
  type DriftParams,
  type DriftSnapshot,
  type DriftTables,
} from './domain.ts';
import { driftParamsPayload } from './events.ts';
import {
  classifyLevel,
  compositeScore,
  constraintRetentionScore,
  consistencyScore,
  hysteresisPassed,
  isMetricBelow,
  persistenceScore,
  renderHint,
  routeAction,
  type ObjectiveEditRow,
} from './metrics.ts';

export interface DriftGoalView {
  readonly id: string;
  readonly objective: string;
  readonly phase: string;
  readonly stage: string;
}

export interface DriftCalibrationRow {
  readonly goalId: string;
  readonly driftType: string;
  readonly action: string;
  readonly detail: string;
  readonly at: number;
}

/**
 * 目标层数据面（T0.1 四表；**只读** + `recordCalibration` 一个写点）。
 * J1：编译期就不给 edit/focus/pause/complete/clear——漂移检测器不可能改目标。
 */
export interface DriftGoalSeam {
  focusView(): DriftGoalView | undefined;
  get(id: string): DriftGoalView | undefined;
  /** objective_edits 流水（J2① 数据面）。 */
  objectiveEdits(): readonly ObjectiveEditRow[];
  /** C6 约束快照当前值（reanchor 的注入内容）。 */
  constraints(id: string): readonly string[];
  /** J5①：校准必留痕（写 T0.1 `calibrations`，权威证据；U7 seam）。 */
  recordCalibration(
    actor: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string },
    goalId: string,
    entry: { readonly driftType: string; readonly action: CalibrationAction; readonly detail: string; readonly at?: number | undefined },
  ): Promise<void>;
  /** 校准记录读取面（后验追踪与 pending 判定的依据）。 */
  calibrations(): readonly DriftCalibrationRow[];
}

export interface DriftTaskView {
  readonly id: string;
  readonly goalId: string;
  readonly phase: string;
  readonly stage: string;
  readonly ownerId?: string | undefined;
  readonly blockedCode?: string | undefined;
}

export interface DriftTaskSeam {
  list(): readonly DriftTaskView[];
}

export interface DriftPredictorSeam {
  /** transition 窗口（J2④；token = 脱敏动作分类串）。 */
  transitions(): readonly { readonly at: number; readonly token: string }[];
}

export interface DriftConfig {
  /** 持久性指标的每窗口编辑数上限（J2① 的分母；U1）。 */
  readonly maxEditsPerWindow?: number;
  /** 约束保持率指标的每窗口违例上限（J2③ 分母；U3）。 */
  readonly maxConstraintBlocks?: number;
  /** 单次 evaluate 扫描的 transition 上限（J6 吞吐帽）。 */
  readonly windowScanCap?: number;
}

export interface CalibrationHint {
  readonly kind: CalibrationAction;
  readonly goalId: string;
  readonly text: string;
  readonly snapshotId: string;
  readonly risk: 'low' | 'medium';
}

export interface DriftService {
  /** 启动序（内核纪律 #7）：必须在注册不变量之前 await。 */
  initialize(): Promise<void>;
  evaluate(goalId?: string, trigger?: 'cycle' | 'objective-edit'): Promise<DriftSnapshot>;
  calibrate(goalId: string, kind: CalibrationAction, snapshotId: string): Promise<CalibrationHint>;
  injectCandidates(session: { readonly sessionId: string }, round: number): Promise<readonly CalibrationHint[]>;
  snapshots(goalId: string, range?: { readonly from: number; readonly to: number }): readonly DriftSnapshot[];
  params(): DriftParams;
  setParams(patch: Partial<Omit<DriftParams, 'revision'>>): Promise<DriftParams>;
  /** 后验追踪面（J5②）：最近一次校准之后是否已出对照快照。 */
  postVerification(goalId: string): { readonly calibratedAt: number | undefined; readonly verified: boolean };
}

export interface DriftDeps {
  readonly domain: TdaDomain<DriftTables>;
  readonly session: TdaSessionSink;
  readonly goal: DriftGoalSeam;
  readonly task?: DriftTaskSeam;
  readonly predictor?: DriftPredictorSeam;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly config?: DriftConfig;
}

const DEFAULTS = { maxEditsPerWindow: 3, maxConstraintBlocks: 2, windowScanCap: 500 } as const;

const seqOf = (id: string): number => Number(String(id).slice(SNAPSHOT_PREFIX.length + 1));

export function createDriftService(deps: DriftDeps): DriftService {
  const clock = deps.now ?? ((): number => Date.now());
  const config = deps.config ?? {};
  const maxEditsPerWindow = config.maxEditsPerWindow ?? DEFAULTS.maxEditsPerWindow;
  const maxConstraintBlocks = config.maxConstraintBlocks ?? DEFAULTS.maxConstraintBlocks;
  const windowScanCap = config.windowScanCap ?? DEFAULTS.windowScanCap;
  const context: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };

  let current: DriftParams | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  /** 进程内投放队列（非权威，见文件头）。 */
  const pending: CalibrationHint[] = [];

  const withLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const paramsOf = (): DriftParams => {
    if (current === undefined) throw new TdaError('DRIFT_NOT_INITIALIZED', 'ctx.drift 尚未 initialize（参数未装载）');
    return current;
  };

  const readSnapshots = (): DriftSnapshot[] => {
    const list: DriftSnapshot[] = [];
    for (const [, value] of deps.domain.table('drift_scores').entries()) list.push(value);
    return list.sort((a, b) => seqOf(a.id) - seqOf(b.id));
  };

  const commitParams = async (params: DriftParams): Promise<void> => {
    const payload = driftParamsPayload(params) as JsonObject;
    const seq = await dualWrite(
      deps.session,
      {
        family: 'drift/calibrate',
        businessId: DRIFT_PARAMS_BUSINESS_ID,
        payload,
        domainWrite: () => deps.domain.table('drift_params').put(DRIFT_PARAMS_KEY, params),
      },
      context,
    );
    if (deps.bus !== undefined) {
      deps.bus.publish({
        family: 'drift/calibrate',
        businessId: DRIFT_PARAMS_BUSINESS_ID,
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
  };

  const writeSnapshot = async (snapshot: DriftSnapshot): Promise<void> => {
    await dualWriteDerived(() => deps.domain.table('drift_scores').put(String(snapshot.id), snapshot), context);
  };

  /** J2② 一致性错配（规则式；U2 待补全超时类规则）。 */
  const consistencyViolations = (goal: DriftGoalView, goalId: string): { violations: number; checks: number } => {
    const tasks = (deps.task?.list() ?? []).filter((task) => task.goalId === goalId);
    let violations = 0;
    let checks = 0;
    const active = tasks.filter((task) => task.phase === 'active');
    const inProgress = active.some((task) => task.stage === 'executing' && task.ownerId !== undefined);
    const verify = active.some((task) => task.stage === 'verifying');
    const executing = active.some((task) => task.stage === 'executing');
    if (goal.stage === 'executing') {
      checks += 1;
      if (!inProgress) violations += 1;
    }
    if (goal.stage === 'verifying') {
      checks += 1;
      if (!verify) violations += 1;
    }
    if (goal.stage === 'planning') {
      checks += 1;
      if (executing) violations += 1;
    }
    return { violations, checks };
  };

  /** J2④ 动作分布（当前窗口 + 基线窗口）。 */
  const distributions = (
    now: number,
    params: DriftParams,
  ): { current: Map<string, number>; baseline: Map<string, number> } => {
    const all = (deps.predictor?.transitions() ?? []).slice(-windowScanCap);
    const currentFrom = now - params.windowMs;
    const current = new Map<string, number>();
    for (const row of all) {
      if (row.at < currentFrom || row.at >= now) continue;
      current.set(row.token, (current.get(row.token) ?? 0) + 1);
    }
    const baseline = new Map<string, number>();
    const baselineFrom = currentFrom - params.windowMs * params.baselineWindows;
    for (const row of all) {
      if (row.at < baselineFrom || row.at >= currentFrom) continue;
      baseline.set(row.token, (baseline.get(row.token) ?? 0) + 1);
    }
    return { current, baseline };
  };

  /**
   * 校准实现（**无锁**）：evaluate 持锁期间调用它，公开 calibrate 只是加锁包装。
   * 拆锁纪律与 tda-governance 的 applyXxx 同源——promise 链锁不可重入。
   */
  const applyCalibrate = async (
    goalId: string,
    kind: CalibrationAction,
    snapshotId: string,
  ): Promise<CalibrationHint> => {
    const snapshot = deps.domain.table('drift_scores').get(snapshotId);
    if (snapshot === undefined) {
      throw new TdaError('DRIFT_SNAPSHOT_NOT_FOUND', `快照 ${snapshotId} 不存在（校准必须可解释、可回放）`);
    }
    const goal = deps.goal.get(goalId);
    if (goal === undefined) throw new TdaError('DRIFT_NO_GOAL', `目标 ${goalId} 不存在`);
    const metric = (Object.keys(METRIC_ACTION) as DriftMetric[]).find((name) => METRIC_ACTION[name] === kind);
    const text = renderHint(kind, {
      objective: goal.objective,
      stage: goal.stage,
      constraints: deps.goal.constraints(goalId),
      ...(metric !== undefined ? { metric } : { metric: 'persistence' as DriftMetric }),
      score: metric !== undefined ? snapshot.scores[metric] : snapshot.composite,
    });
    const detail = `snapshot=${String(snapshot.id)} ${text}`;
    // J5①：校准必留痕（权威证据落 T0.1 calibrations；事件由 seam 发出）
    await deps.goal.recordCalibration(
      { actor: 'scheduler', sessionId: deps.session.sessionId },
      goalId,
      { driftType: metric ?? 'composite', action: kind, detail, at: clock() },
    );
    const hint: CalibrationHint = {
      kind,
      goalId,
      text,
      snapshotId: String(snapshot.id),
      risk: CALIBRATION_RISKS[kind],
    };
    return hint;
  };

  return {
    async initialize() {
      const table = deps.domain.table('drift_params');
      const existing = table.get(DRIFT_PARAMS_KEY);
      if (existing !== undefined) {
        current = existing;
        return;
      }
      current = {
        ...DEFAULT_DRIFT_PARAMS,
        weights: { ...DEFAULT_DRIFT_PARAMS.weights },
        thresholds: { ...DEFAULT_DRIFT_PARAMS.thresholds },
      };
      await commitParams(current);
      return;
    },

    async evaluate(goalId, trigger = 'cycle') {
      return withLock(async () => {
        const params = paramsOf();
        const now = clock();
        const goal = (goalId !== undefined ? deps.goal.get(goalId) : undefined) ?? deps.goal.focusView();
        if (goal === undefined) {
          throw new TdaError('DRIFT_NO_GOAL', '无焦点目标可评估（周期触发时应跳过而非报错见 harness SKIPPABLE_CODES）');
        }
        const to = now;
        const from = to - params.windowMs;

        const edits = deps.goal.objectiveEdits();
        const { violations, checks } = consistencyViolations(goal, goal.id);
        const constraintBlocks = (deps.task?.list() ?? []).filter(
          (task) => task.goalId === goal.id && task.blockedCode !== undefined && task.blockedCode.startsWith('constraint-'),
        ).length;
        const { current: currentDist, baseline: baselineDist } = distributions(now, params);

        // 纯函数计算（J8：同输入同输出；四个分项各自独立可测）
        const scores = {
          persistence: persistenceScore(edits, goal.id, { from, to }, maxEditsPerWindow),
          consistency: consistencyScore(violations, checks),
          constraintRetention: constraintRetentionScore(constraintBlocks, maxConstraintBlocks),
          actionVolatility: 0,
        };
        // actionVolatility 需要 baseline 分布——与上面合并成一次 computeScores 会重复算
        // 窗口，这里显式覆盖（保持 metrics.ts 的每个分项都可独立调用/测试）。
        scores.actionVolatility = (() => {
          const total = [...currentDist.values()].reduce((sum, value) => sum + value, 0);
          const baseTotal = [...baselineDist.values()].reduce((sum, value) => sum + value, 0);
          if (total === 0 || baseTotal === 0) return 1;
          const tokens = new Set([...currentDist.keys(), ...baselineDist.keys()]);
          let kl = 0;
          for (const token of tokens) {
            const p = (currentDist.get(token) ?? 0) / total;
            const q = (baselineDist.get(token) ?? 0) / baseTotal;
            if (p === 0) continue;
            kl += p * Math.log(p / (q === 0 ? 1e-9 : q));
          }
          return 1 - Math.min(1, kl / Math.log(2));
        })();

        const composite = compositeScore(scores, params);
        const level = classifyLevel(composite, params);
        const table = deps.domain.table('drift_scores');
        const id = allocateId(table, SNAPSHOT_PREFIX);
        const snapshot: DriftSnapshot = {
          id: id as never,
          goalId: goal.id,
          scores,
          composite,
          level,
          window: { from, to },
          trigger,
          at: now,
        };
        await writeSnapshot(snapshot);

        // J3 路由 + J5③ 滞回：越限指标 → 校准（low 即时 / medium 滞回）
        const history = readSnapshots().filter((row) => row.goalId === goal.id);
        const hysteresis = {} as Record<DriftMetric, boolean>;
        for (const metric of DRIFT_METRICS) {
          const recentScores = history.slice(0, -1).map((row) => row.scores[metric]);
          hysteresis[metric] =
            CALIBRATION_RISKS[METRIC_ACTION[metric]] === 'low'
              ? isMetricBelow(scores[metric], params)
              : hysteresisPassed([...recentScores, scores[metric]], params);
        }
        // J3 双轨：composite 越 drift 带 **或** 任一指标（经滞回）越限都触发——
        // 防止"四指标互相抵消掩盖单维漂移"（如约束独自崩掉而总量尚可）
        const anyMetric = DRIFT_METRICS.some((metric) => hysteresis[metric]);
        const routed = level === 'drift' || anyMetric ? routeAction(scores, hysteresis) : undefined;
        if (routed !== undefined) {
          // 无锁直调（evaluate 已持锁；this.calibrate 会二次入链自锁死）
          const hint = await applyCalibrate(goal.id, METRIC_ACTION[routed.metric], String(snapshot.id));
          pending.push(hint);
        }
        return snapshot;
      });
    },

    async calibrate(goalId, kind, snapshotId) {
      // 加锁包装：evaluate 已持锁，内部必须走无锁实现（否则 promise 链自锁死）
      return withLock(() => applyCalibrate(goalId, kind, snapshotId));
    },

    async injectCandidates(_session, _round) {
      // 待执行队列是投放状态（非权威）：本轮生成的提示交给 T0.4 injection 区
      const out = [...pending];
      pending.length = 0;
      return out;
    },

    snapshots(goalId, range) {
      return readSnapshots().filter((snapshot) => {
        if (snapshot.goalId !== goalId) return false;
        if (range?.from !== undefined && snapshot.at < range.from) return false;
        if (range?.to !== undefined && snapshot.at > range.to) return false;
        return true;
      });
    },

    params() {
      return paramsOf();
    },

    async setParams(patch) {
      return withLock(async () => {
        const base = paramsOf();
        const merged: DriftParams = {
          weights: { ...base.weights, ...(patch.weights ?? {}) },
          windowMs: patch.windowMs ?? base.windowMs,
          baselineWindows: patch.baselineWindows ?? base.baselineWindows,
          thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) },
          perMetricThreshold: patch.perMetricThreshold ?? base.perMetricThreshold,
          hysteresisWindows: patch.hysteresisWindows ?? base.hysteresisWindows,
          revision: base.revision + 1,
        };
        const parsed = DriftParamsSchema.safeParse(merged);
        if (!parsed.success) {
          throw new TdaError(
            'DRIFT_PARAMS_INVALID',
            `参数非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`,
          );
        }
        const next = parsed.data;
        await commitParams(next);
        current = next;
        return next;
      });
    },

    postVerification(goalId) {
      // J5②：校准后下一窗口必出对照快照
      const rows = deps.goal.calibrations().filter((row) => row.goalId === goalId);
      const lastCalibration = rows.reduce<number | undefined>(
        (latest, row) => (latest === undefined || row.at > latest ? row.at : latest),
        undefined,
      );
      if (lastCalibration === undefined) return { calibratedAt: undefined, verified: false };
            // `>=` 而非 `>`：校准与其触发快照同刻（calibrate 由该快照路由产生，detail 带
      // snapshot=<id> 回链）——同刻快照即校准的对照基础；持续漂移下每窗口都会
      // 重新落账校准，严格 `>` 会让 verified 结构性恒 false。
      const verified = readSnapshots().some((snapshot) => snapshot.goalId === goalId && snapshot.at >= lastCalibration);
      return { calibratedAt: lastCalibration, verified };
    },
  };
}
