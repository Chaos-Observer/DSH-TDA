/**
 * tda-drift 插件出口（七文件模板：domain/metrics/events/service/loadChecks/index）。
 *
 * **J1 的两个落点都在本文件可见**：
 *  - `TdaPluginContext.goal` 的类型是 `DriftGoalSeam`（编译期就没有 mutation 方法）；
 *  - `apply` 里注册的 `drift-zero-goal-write` 检查（运行时复核装配没塞多余方法）。
 *
 * 事件触发路径（J6）：`goalTree/change` 的 objective edit → 宿主调用
 * `evaluate(goalId, 'objective-edit')`。本插件不直接订阅总线（保持"检测器只读"的
 * 单向性，订阅逻辑归宿主）。
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
import { driftDomainSpec, type DriftTables } from './domain.ts';
import {
  createDriftService,
  type DriftConfig,
  type DriftGoalSeam,
  type DriftPredictorSeam,
  type DriftService,
  type DriftTaskSeam,
} from './service.ts';
import { registerDriftInvariants } from './loadChecks.ts';

export {
  driftDomainSpec,
  DriftSnapshotSchema,
  DriftParamsSchema,
  DRIFT_METRICS,
  DRIFT_LEVELS,
  CALIBRATION_ACTIONS,
  CALIBRATION_RISKS,
  METRIC_ACTION,
  DEFAULT_DRIFT_PARAMS,
  DRIFT_PARAMS_KEY,
  DRIFT_PARAMS_BUSINESS_ID,
  SNAPSHOT_PREFIX,
  type DriftTables,
  type DriftSnapshot,
  type DriftMetric,
  type DriftLevel,
  type CalibrationAction,
  type DriftParams,
} from './domain.ts';
export { calibrationPayload, driftParamsPayload, CALIBRATION_BUSINESS_PREFIX } from './events.ts';
export {
  computeScores,
  persistenceScore,
  consistencyScore,
  constraintRetentionScore,
  actionVolatilityScore,
  compositeScore,
  classifyLevel,
  isMetricBelow,
  hysteresisPassed,
  routeAction,
  renderHint,
  type MetricInputs,
  type ObjectiveEditRow,
} from './metrics.ts';
export {
  createDriftService,
  type DriftService,
  type DriftDeps,
  type DriftConfig,
  type DriftGoalSeam,
  type DriftGoalView,
  type DriftCalibrationRow,
  type DriftTaskSeam,
  type DriftTaskView,
  type DriftPredictorSeam,
  type CalibrationHint,
} from './service.ts';
export { registerDriftInvariants, driftInvariantChecks, type DriftInvariantOptions } from './loadChecks.ts';

/** Cordis ctx 的结构镜像（接 DSH 时替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  /** 目标层数据面（**只读** + recordCalibration 一个写点；J1）。 */
  readonly goal: DriftGoalSeam;
  readonly task?: DriftTaskSeam;
  readonly predictor?: DriftPredictorSeam;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly config?: DriftConfig;
}

export interface TdaDriftHandle {
  readonly service: DriftService;
  readonly domain: TdaDomain<DriftTables>;
  dispose(): Promise<void>;
}

export interface TdaDriftPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaDriftHandle>;
}

export const tdaDriftPlugin: TdaDriftPlugin = {
  name: 'tda-drift',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(driftDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createDriftService({
      domain,
      session: ctx.session,
      goal: ctx.goal,
      reconciler,
      index,
      ...(ctx.task !== undefined ? { task: ctx.task } : {}),
      ...(ctx.predictor !== undefined ? { predictor: ctx.predictor } : {}),
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    });
    // 启动序：先建状态（参数单行），再注册检查（纪律 #7）
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerDriftInvariants(ctx.invariants, domain, { goal: ctx.goal, service });
    return {
      service,
      domain,
      async dispose() {
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
