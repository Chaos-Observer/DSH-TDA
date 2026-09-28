/**
 * tda-predictor 服务：ctx.predictor 服务面实现（T1.3 §4.2）。
 *
 * 三种写组合（内核纪律 #12），本插件是唯一同时用到三种的：
 *  1. `transitions` = **派生**（`dualWriteDerived`）——会话日志的纯投影；
 *  2. `predictions` / `mismatches` = **权威**（`dualWrite` + 族 `predict/change`）——
 *     `injected` 依赖 T0.4 预算裁决（外部状态），无法由日志重放得出；
 *  3. `predict_params` / `extract_state` = 参数与水位（前者权威带事件，后者派生）。
 *
 * 双轨制（J5）：`confidence ≥ θ_pred` 的预测注入主上下文；`< θ_pred` 只落旁路。
 * **无论注入与否，凡生成过预测的轮次必做 observe 比对并记 mismatch（含 `none`）**
 * ——若低置信连记录都跳过，coach 信号密度就塌陷了（这是双轨存在的理由）。
 *
 * fail-open（J10/不变量 7）：`extract`/`predict` 的任何预期外异常都降级为"无预测"，
 * **禁止阻断主任务链路**——预测器是可选增强，不是主链路依赖。
 */
import {
  allocateId,
  dualWrite,
  dualWriteDerived,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type HostRecord,
  type JsonObject,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  DEFAULT_PREDICT_PARAMS,
  EXTRACT_STATE_KEY,
  PREDICTION_PREFIX,
  PREDICT_PARAMS_BUSINESS_ID,
  PREDICT_PARAMS_KEY,
  MISMATCH_PREFIX,
  PredictParamsSchema,
  TRANSITION_PREFIX,
  type ExtractState,
  type MismatchRecord,
  type PredictParams,
  type Prediction,
  type PredictorTables,
  type Transition,
  type TransitionStage,
} from './domain.ts';
import { mismatchPayload, predictionPayload } from './events.ts';
import {
  actionToken,
  aggregatePrediction,
  classifyDelta,
  extractTransitions,
  renderPrediction,
  similarTransitions,
  type ExtractionResult,
  type TransitionDraft,
  type TransitionQuery,
} from './extract.ts';

/** 宿主日志只读面（sink 的结构子集；预测器只冷读日志，不依赖进程内状态）。 */
export interface PredictorLogSeam {
  readonly sessionId: string;
  records(): readonly HostRecord[];
}

/** 任务态只读 seam（`predict` 的 stage 缺省源；未装配即 executing）。 */
export interface PredictorTaskSeam {
  focus(): { readonly id: string; readonly stage: string; readonly goalId: string } | undefined;
}

export interface PredictorConfig {
  /** 单批 extract transition 上限（J10）。 */
  readonly batchCap?: number;
  /** 相似检索的候选池（≥ topK）。 */
  readonly poolSize?: number;
  /** 用于构造 `recentActions` 的历史动作数。 */
  readonly recentActions?: number;
}

export interface ExtractReport {
  readonly scanned: number;
  readonly extracted: number;
  readonly skipped: number;
  readonly watermark: number;
}

export interface PredictContext {
  readonly session: PredictorLogSeam;
  readonly round: number;
  readonly taskId?: string;
  readonly stage?: string;
}

export interface PredictorService {
  initialize(): Promise<ExtractState>;
  extract(session: PredictorLogSeam, opts?: { readonly range?: { readonly from: number; readonly to: number } }): Promise<ExtractReport>;
  predict(ctx: PredictContext): Promise<Prediction | null>;
  observe(predictionId: string, session: PredictorLogSeam): Promise<MismatchRecord | null>;
  injectCandidates(session: { readonly sessionId: string }, round: number): Promise<readonly Prediction[]>;
  similar(query: TransitionQuery, k?: number): readonly Transition[];
  params(): PredictParams;
  setParams(patch: Partial<Omit<PredictParams, 'revision'>>): Promise<PredictParams>;
  prediction(id: string): Prediction | undefined;
  predictions(filter?: { readonly sessionId?: string; readonly round?: number }): readonly Prediction[];
  mismatches(filter?: { readonly predictionId?: string }): readonly MismatchRecord[];
  transitions(filter?: { readonly kind?: Transition['kind'] }): readonly Transition[];
  extractState(): ExtractState;
  /** 注入文本（T0.4 的 injection 提供方用；J6 必带"非事实"标注）。 */
  renderText(prediction: Prediction): string;
}

export interface PredictorDeps {
  readonly domain: TdaDomain<PredictorTables>;
  readonly session: TdaSessionSink;
  readonly task?: PredictorTaskSeam;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly config?: PredictorConfig;
  /** fail-open 的上报出口（J10：降级不等于静默）。 */
  readonly onDegrade?: (message: string) => void;
}

const DEFAULTS = { batchCap: 200, poolSize: 50, recentActions: 3 } as const;

const seqOf = (id: string, prefix: string): number => Number(String(id).slice(prefix.length + 1));

export function createPredictorService(deps: PredictorDeps): PredictorService {
  const clock = deps.now ?? ((): number => Date.now());
  const config = deps.config ?? {};
  const batchCap = config.batchCap ?? DEFAULTS.batchCap;
  const poolSize = config.poolSize ?? DEFAULTS.poolSize;
  const recentCount = config.recentActions ?? DEFAULTS.recentActions;
  const context: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };
  const report = deps.onDegrade ?? ((message: string): void => console.error('[tda-predictor] 降级：', message));

  let current: PredictParams | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const withLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const paramsOf = (): PredictParams => {
    if (current === undefined) {
      throw new TdaError('PREDICT_NOT_INITIALIZED', 'ctx.predictor 尚未 initialize（参数未装载）');
    }
    return current;
  };

  const readTransitions = (): Transition[] => {
    const list: Transition[] = [];
    for (const [, value] of deps.domain.table('transitions').entries()) list.push(value);
    return list.sort((a, b) => seqOf(a.id, TRANSITION_PREFIX) - seqOf(b.id, TRANSITION_PREFIX));
  };

  const readPredictions = (): Prediction[] => {
    const list: Prediction[] = [];
    for (const [, value] of deps.domain.table('predictions').entries()) list.push(value);
    return list.sort((a, b) => seqOf(a.id, PREDICTION_PREFIX) - seqOf(b.id, PREDICTION_PREFIX));
  };

  const commitParams = async (params: PredictParams): Promise<void> => {
    const payload = {
      thetaPredict: params.thetaPredict,
      topK: params.topK,
      simWeights: { ...params.simWeights },
      mismatchEnabled: params.mismatchEnabled,
      revision: params.revision,
    } as JsonObject;
    const seq = await dualWrite(
      deps.session,
      {
        family: 'predict/change',
        businessId: PREDICT_PARAMS_BUSINESS_ID,
        payload,
        domainWrite: () => deps.domain.table('predict_params').put(PREDICT_PARAMS_KEY, params),
      },
      context,
    );
    if (deps.bus !== undefined) {
      deps.bus.publish({
        family: 'predict/change',
        businessId: PREDICT_PARAMS_BUSINESS_ID,
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
  };

  const commitDerived = async (batch: (() => Promise<void>) | (() => void)): Promise<void> => {
    await dualWriteDerived(batch, context);
  };

  /** 权威写（预测/比对）：落域 → 事件 → 总线。 */
  const commitRecord = async (
    businessId: string,
    payload: JsonObject,
    domainWrite: () => void | Promise<void>,
  ): Promise<void> => {
    const seq = await dualWrite(deps.session, { family: 'predict/change', businessId, payload, domainWrite }, context);
    if (deps.bus !== undefined) {
      deps.bus.publish({
        family: 'predict/change',
        businessId,
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
  };

  /** 最近动作分类串（`predict` 的 query 构造输入；脱敏）。 */
  const recentActions = (transitions: readonly Transition[], taskId: string | undefined): string[] =>
    transitions
      .filter((transition) => taskId === undefined || transition.taskId === taskId || transition.taskId === undefined)
      .slice(-recentCount)
      .map((transition) => actionToken(transition));

  const buildQuery = (ctx: PredictContext): TransitionQuery => {
    const focus = deps.task?.focus();
    const taskId = ctx.taskId ?? focus?.id;
    const stage = (ctx.stage ?? focus?.stage) as TransitionStage | undefined;
    const transitions = readTransitions();
    return {
      ...(taskId !== undefined ? { taskId } : {}),
      ...(stage !== undefined ? { stage } : {}),
      recentActions: recentActions(transitions, taskId),
    };
  };

  return {
    async initialize() {
      const paramsTable = deps.domain.table('predict_params');
      const existingParams = paramsTable.get(PREDICT_PARAMS_KEY);
      if (existingParams === undefined) {
        current = {
          ...DEFAULT_PREDICT_PARAMS,
          simWeights: { ...DEFAULT_PREDICT_PARAMS.simWeights },
        };
        await commitParams(current);
      } else {
        current = existingParams;
      }
      const stateTable = deps.domain.table('extract_state');
      const existingState = stateTable.get(EXTRACT_STATE_KEY);
      if (existingState !== undefined) return existingState;
      const seed: ExtractState = { lastSeq: 0, lastAt: 0, batchCap };
      await commitDerived(() => stateTable.put(EXTRACT_STATE_KEY, seed));
      return seed;
    },

    async extract(session, opts = {}) {
      return withLock(async () => {
        const state = deps.domain.table('extract_state').get(EXTRACT_STATE_KEY) ?? {
          lastSeq: 0,
          lastAt: 0,
          batchCap,
        };
        const focus = deps.task?.focus();
        let records: readonly HostRecord[];
        let result: ExtractionResult;
        try {
          // 冷读本身就是可能失败的 I/O：必须与抽取同窗降级（fail-open，不变量 7）
          records = session.records();
          result = extractTransitions(records, {
            sessionId: session.sessionId,
            ...(focus?.goalId !== undefined ? { goalId: focus.goalId } : {}),
            ...(focus?.id !== undefined ? { taskId: focus.id } : {}),
            ...(focus?.stage !== undefined ? { taskStage: focus.stage as TransitionStage } : {}),
            fromSeq: opts.range?.from ?? state.lastSeq,
            batchCap,
          });
        } catch (error) {
          // fail-open（不变量 7）：抽取失败降级为"无新 transition"，主链路不受影响
          report(`extract 失败，降级为无新 transition：${error instanceof Error ? error.message : String(error)}`);
          return { scanned: 0, extracted: 0, skipped: 0, watermark: state.lastSeq };
        }
        const table = deps.domain.table('transitions');
        const drafts: TransitionDraft[] = [...result.transitions];
        await commitDerived(async () => {
          for (const draft of drafts) {
            const id = allocateId(table, TRANSITION_PREFIX);
            await table.put(id, { ...draft, id } as never);
          }
          await deps.domain.table('extract_state').put(EXTRACT_STATE_KEY, {
            lastSeq: result.watermark,
            lastAt: clock(),
            batchCap,
          });
        });
        return {
          scanned: result.scanned,
          extracted: drafts.length,
          skipped: result.skipped,
          watermark: result.watermark,
        };
      });
    },

    async predict(ctx) {
      const params = paramsOf();
      try {
        const query = buildQuery(ctx);
        const hits = similarTransitions(readTransitions(), query, Math.max(params.topK, poolSize), params.simWeights).slice(
          0,
          params.topK,
        );
        const aggregation = aggregatePrediction(hits, params.topK);
        if (aggregation === undefined) return null;
        const at = clock();
        const table = deps.domain.table('predictions');
        const id = allocateId(table, PREDICTION_PREFIX);
        const prediction: Prediction = {
          id: id as never,
          sessionId: ctx.session.sessionId,
          round: ctx.round,
          context: {
            ...(query.taskId !== undefined ? { taskId: query.taskId } : {}),
            stage: query.stage ?? 'executing',
            recentActions: [...query.recentActions],
          },
          nextAction: aggregation.nextAction,
          outcomeDist: { ...aggregation.outcomeDist },
          riskFlags: aggregation.riskFlags.map((flag) => ({ ...flag })),
          confidence: aggregation.confidence,
          theta: params.thetaPredict,
          injected: aggregation.confidence >= params.thetaPredict,
          similarTransitionIds: hits.map((hit) => String(hit.transition.source.seqFrom)),
          at,
        };
        await commitRecord(String(id), predictionPayload(prediction), () => table.put(String(id), prediction));
        return prediction;
      } catch (error) {
        // fail-open：预测失败 = 无预测（不抛断主链路）
        report(`predict 失败，降级为无预测：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },

    async observe(predictionId, session) {
      return withLock(async () => {
        if (!paramsOf().mismatchEnabled) return null;
        const prediction = deps.domain.table('predictions').get(predictionId);
        if (prediction === undefined) {
          throw new TdaError('PREDICT_PREDICTION_NOT_FOUND', `预测 ${predictionId} 不存在`);
        }
        const records = session.records();
        const actual = actualActionOf(records, prediction.round, session.sessionId, deps.task?.focus());
        const { deltaKind, actual: normalized } = classifyDelta(prediction, actual);
        const table = deps.domain.table('mismatches');
        const id = allocateId(table, MISMATCH_PREFIX);
        const mismatch: MismatchRecord = {
          id: id as never,
          predictionId: String(prediction.id),
          actual: {
            action: normalized.action,
            outcomeStatus: normalized.outcomeStatus,
            ...(normalized.errorClass !== undefined ? { errorClass: normalized.errorClass } : {}),
          },
          deltaKind,
          at: clock(),
        };
        await commitRecord(String(id), mismatchPayload(mismatch), () => table.put(String(id), mismatch));
        return mismatch;
      });
    },

    async injectCandidates(session, round) {
      // 只返回**裁决时**过 θ 闸的预测（injected 是 append-only 的当时决定，
      // 不用当前 θ 复筛——否则 θ 调高会回溯撤销历史决定，可回放性即失）。
      // T0.4 的份额内进一步裁断体现在 AssembleRecord（J8）。
      return readPredictions()
        .filter(
          (prediction) =>
            prediction.sessionId === session.sessionId &&
            prediction.round === round &&
            prediction.injected,
        )
        .map((prediction) => ({ ...prediction }));
    },

    similar(query, k) {
      const params = paramsOf();
      const limit = k ?? params.topK;
      const hits = similarTransitions(readTransitions(), query, Math.max(limit, poolSize), params.simWeights);
      return hits.slice(0, limit).map((hit) => {
        const found = readTransitions().find(
          (transition) => transition.source.seqFrom === hit.transition.source.seqFrom && transition.kind === hit.transition.kind,
        );
        return found as Transition;
      });
    },

    params() {
      return paramsOf();
    },

    async setParams(patch) {
      return withLock(async () => {
        const base = paramsOf();
        const merged: PredictParams = {
          thetaPredict: patch.thetaPredict ?? base.thetaPredict,
          topK: patch.topK ?? base.topK,
          simWeights: { ...base.simWeights, ...(patch.simWeights ?? {}) },
          mismatchEnabled: patch.mismatchEnabled ?? base.mismatchEnabled,
          revision: base.revision + 1,
        };
        const parsed = PredictParamsSchema.safeParse(merged);
        if (!parsed.success) {
          throw new TdaError(
            'PREDICT_PARAMS_INVALID',
            `参数非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`,
          );
        }
        const next = parsed.data;
        await commitParams(next);
        current = next;
        return next;
      });
    },

    prediction(id) {
      return deps.domain.table('predictions').get(id);
    },

    predictions(filter = {}) {
      return readPredictions().filter((prediction) => {
        if (filter.sessionId !== undefined && prediction.sessionId !== filter.sessionId) return false;
        if (filter.round !== undefined && prediction.round !== filter.round) return false;
        return true;
      });
    },

    mismatches(filter = {}) {
      const list: MismatchRecord[] = [];
      for (const [, value] of deps.domain.table('mismatches').entries()) list.push(value);
      return list
        .filter((mismatch) => filter.predictionId === undefined || mismatch.predictionId === filter.predictionId)
        .sort((a, b) => seqOf(a.id, MISMATCH_PREFIX) - seqOf(b.id, MISMATCH_PREFIX));
    },

    transitions(filter = {}) {
      const list = readTransitions();
      return filter.kind === undefined ? list : list.filter((transition) => transition.kind === filter.kind);
    },

    extractState() {
      return (
        deps.domain.table('extract_state').get(EXTRACT_STATE_KEY) ?? { lastSeq: 0, lastAt: 0, batchCap }
      );
    },

    renderText(prediction) {
      return renderPrediction(prediction);
    },
  };
}

/**
 * 从日志抽"本轮的实际动作"（`observe` 的 actual 面；确定性）。
 *
 * 定位口径：`turn/start`(round) 与 `turn/end`(round) 的 seq 区间内，**最后一条**
 * `tool/call` 记录（无则取最后一条 `dispatch/change` 结算事件）。都没有 = 本轮
 * 没有可观测动作（`classifyDelta` 会判成 `action`——预测了一个没发生的动作）。
 */
export function actualActionOf(
  records: readonly HostRecord[],
  round: number,
  sessionId: string,
  focus: { readonly id: string } | undefined,
): { readonly action: string; readonly outcomeStatus: 'success' | 'failure' | 'partial'; readonly errorClass?: string } | undefined {
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  const start = ordered.find((record) => record.kind === 'turn/start' && record.turn === round);
  if (start === undefined) return undefined;
  const end = ordered.find((record) => (record.kind === 'turn/end' || record.kind === 'interrupted') && record.turn === round);
  const endSeq = end?.seq ?? Number.MAX_SAFE_INTEGER;
  const inRange = ordered.filter((record) => record.seq > start.seq && record.seq <= endSeq);

  let last: { action: string; outcomeStatus: 'success' | 'failure' | 'partial'; errorClass?: string } | undefined;
  for (const record of inRange) {
    if (record.kind === 'tool/call') {
      last = {
        action: `${record.tool}:${record.argClass}`,
        outcomeStatus: record.status === 'success' ? 'success' : 'failure',
        ...(record.errorClass !== undefined ? { errorClass: record.errorClass } : {}),
      };
      continue;
    }
    if (record.kind === 'tda' && record.family === 'dispatch/change') {
      const payload = record.payload as Record<string, unknown>;
      if (payload.status !== 'settled') continue;
      const role = payload.role === 'lead' || payload.role === 'sidekick' ? payload.role : 'sidekick';
      const result = payload.result as Record<string, unknown> | undefined;
      const outcome = typeof result?.outcome === 'string' ? result.outcome : 'error';
      last = {
        action: `dispatch:${role}`,
        outcomeStatus:
          outcome === 'conclusion' ? 'success' : outcome === 'conclusion-partial' ? 'partial' : 'failure',
        errorClass: outcome === 'conclusion' ? 'dispatch-incomplete' : 'dispatch-error',
      };
    }
  }
  void sessionId;
  void focus;
  return last;
}
