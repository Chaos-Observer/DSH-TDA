/**
 * tda-goal-state 插件出口（六文件模板汇聚点：domain/events/service/loadChecks/index）。
 *
 * IT0/IT1 形态：框架无关——TdaPluginContext 是 Cordis ctx 的结构镜像
 * （storage / invariants / session 三槽，均来自内核接口）。
 * IT1 接 DSH 时仅此文件把 TdaPluginContext 换成真实 Cordis ctx，
 * domain/service/loadChecks 零改动（决策点③可逆性）。
 *
 * T0.1 出口面：ctx.goalTree（服务）+ domain（IT1 出口对账：后续插件经
 * TdaDomain 只读引用 goal 树；constraint_snapshots 是 T0.4 pinned 区数据源）。
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
import { goalStateDomainSpec, type GoalTables } from './domain.ts';
import { createGoalTreeService, type GoalTreeService, type GoalTaskPoolLink } from './service.ts';
import { registerGoalStateInvariants } from './loadChecks.ts';
import { subscribeTaskStageSync, type TaskStageSyncHandle, type TaskPoolLink } from './taskLink.ts';

export {
  goalStateDomainSpec,
  GoalNodeSchema,
  GoalBudgetSchema,
  GoalBlockedReasonSchema,
  GoalChangeRecordSchema,
  ObjectiveEditSchema,
  CalibrationSchema,
  ConstraintSnapshotSchema,
  GOAL_PHASES,
  GOAL_STAGES,
  GOAL_OUTCOMES,
  GOAL_ACTORS,
  GOAL_OPERATIONS,
  type GoalTables,
  type GoalNode,
  type GoalPhase,
  type GoalStage,
  type GoalOutcome,
  type GoalActor,
  type GoalOperation,
  type GoalBudget,
  type GoalBudgetCaps,
  type GoalBlockedReason,
  type GoalChangeRecord,
  type ObjectiveEdit,
  type Calibration,
  type ConstraintSnapshot,
} from './domain.ts';
export { goalChangePayload, type GoalChangeEventPayload } from './events.ts';
export {
  createGoalTreeService,
  type GoalTreeService,
  type GoalServiceDeps,
  type GoalTaskPoolLink,
  type GoalRef,
  type CreateGoalRequest,
  type EditGoalRequest,
  type ConsumedUsage,
  type GoalFocusView,
  type GoalStateSection,
} from './service.ts';
export { registerGoalStateInvariants, goalStateInvariantChecks } from './loadChecks.ts';
export {
  subscribeTaskStageSync,
  projectGoalStage,
  type TaskStageSyncOptions,
  type TaskStageSyncHandle,
  type TaskPoolLink,
  type TaskStageProjection,
} from './taskLink.ts';

/** Cordis ctx 的结构镜像（IT1 起替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  /** 事件分发面（taskPool/change 幂等推进目标 stage；未装配则不订阅）。 */
  readonly bus?: TdaEventBus;
  /** 任务池 seam（verifying 前置 assertSettled）；未装配则跳过前置校验。 */
  readonly taskPool?: TaskPoolLink & GoalTaskPoolLink;
  /** 同步失败出口（默认 console.error；Harness 装配时接自身日志）。 */
  readonly onSyncError?: (message: string) => void;
}

export interface TdaGoalStateHandle {
  readonly service: GoalTreeService;
  readonly domain: TdaDomain<GoalTables>;
  dispose(): Promise<void>;
}

export interface TdaGoalStatePlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaGoalStateHandle>;
}

export const tdaGoalStatePlugin: TdaGoalStatePlugin = {
  name: 'tda-goal-state',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(goalStateDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    // 两级不变量：内核级（@tda/kernel，双写配对）+ 插件级（tda-goal-state，树三查）
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerGoalStateInvariants(ctx.invariants, domain);
    const service = createGoalTreeService({
      domain,
      session: ctx.session,
      reconciler,
      index,
      ...(ctx.taskPool !== undefined ? { taskPool: ctx.taskPool } : {}),
    });
    // 联动：订阅 taskPool/change 幂等推进目标 stage（T0.2 §5）
    const sync: TaskStageSyncHandle | undefined =
      ctx.bus !== undefined && ctx.taskPool !== undefined
        ? subscribeTaskStageSync({
            bus: ctx.bus,
            service,
            taskPool: ctx.taskPool,
            ...(ctx.onSyncError !== undefined ? { onError: ctx.onSyncError } : {}),
          })
        : undefined;
    return {
      service,
      domain,
      async dispose() {
        // 序不可换：先停订（不再有新回声）→ 等在途回声落定 → 才关域
        sync?.unsubscribe();
        await sync?.drain();
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
