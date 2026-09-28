/**
 * tda-predictor 插件出口（七文件模板：domain/extract/events/service/loadChecks/index）。
 *
 * 启动序（内核纪律 #7）：`await service.initialize()`（补参数单行与水位）**先于**
 * 不变量注册——否则从未抽取过的运行会带着空参数表过不了自己的门。
 *
 * 无订阅手柄：预测器不订阅任何事件（它的输入是**日志冷读**，由宿主周期驱动
 * `extract`），因此 dispose 只需关域。
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
import { predictorDomainSpec, type ExtractState, type PredictorTables } from './domain.ts';
import {
  createPredictorService,
  type PredictorConfig,
  type PredictorService,
  type PredictorTaskSeam,
} from './service.ts';
import { registerPredictorInvariants } from './loadChecks.ts';

export {
  predictorDomainSpec,
  TransitionSchema,
  PredictionSchema,
  MismatchSchema,
  PredictParamsSchema,
  ExtractStateSchema,
  TRANSITION_KINDS,
  TASK_STAGES,
  OUTCOME_STATUSES,
  DELTA_KINDS,
  ARG_CLASSES,
  DEFAULT_PREDICT_PARAMS,
  PREDICT_PARAMS_KEY,
  EXTRACT_STATE_KEY,
  PREDICT_PARAMS_BUSINESS_ID,
  TRANSITION_PREFIX,
  PREDICTION_PREFIX,
  MISMATCH_PREFIX,
  type PredictorTables,
  type Transition,
  type TransitionKind,
  type TransitionStage,
  type OutcomeStatus,
  type DeltaKind,
  type ArgClass,
  type Prediction,
  type MismatchRecord,
  type PredictParams,
  type ExtractState,
} from './domain.ts';
export { predictionPayload, mismatchPayload } from './events.ts';
export {
  extractTransitions,
  actionToken,
  transitionSimilarity,
  similarTransitions,
  aggregatePrediction,
  renderPrediction,
  classifyDelta,
  dominantOutcome,
  PREDICTION_CAVEAT,
  RISK_FREQ_FLOOR,
  type TransitionDraft,
  type ExtractionOptions,
  type ExtractionResult,
  type TransitionQuery,
  type Similarity,
  type SimilarityParts,
  type SimilarHit,
  type Aggregation,
} from './extract.ts';
export {
  createPredictorService,
  actualActionOf,
  type PredictorService,
  type PredictorDeps,
  type PredictorConfig,
  type PredictorLogSeam,
  type PredictorTaskSeam,
  type ExtractReport,
  type PredictContext,
} from './service.ts';
export { registerPredictorInvariants, predictorInvariantChecks, type PredictInvariantOptions } from './loadChecks.ts';

/** Cordis ctx 的结构镜像（接 DSH 时替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  readonly task?: PredictorTaskSeam;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly config?: PredictorConfig;
  readonly onDegrade?: (message: string) => void;
}

export interface TdaPredictorHandle {
  readonly service: PredictorService;
  readonly domain: TdaDomain<PredictorTables>;
  readonly boot: ExtractState;
  dispose(): Promise<void>;
}

export interface TdaPredictorPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaPredictorHandle>;
}

export const tdaPredictorPlugin: TdaPredictorPlugin = {
  name: 'tda-predictor',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(predictorDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createPredictorService({
      domain,
      session: ctx.session,
      reconciler,
      index,
      ...(ctx.task !== undefined ? { task: ctx.task } : {}),
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
      ...(ctx.onDegrade !== undefined ? { onDegrade: ctx.onDegrade } : {}),
    });
    const boot = await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerPredictorInvariants(ctx.invariants, domain);
    return {
      service,
      domain,
      boot,
      async dispose() {
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
