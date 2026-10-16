/**
 * tda-executor 插件出口（T4.1 §4.2）。
 *
 * **J1 的两个落点都在本文件可见**：
 *  - `TdaPluginContext` 的 taskPool/dispatch/workflow/supervision/goal/timeline 全是
 *    **服务方法 seam**（结构镜像，编译期即无 domain/storage/context 句柄）；
 *  - apply 里注册的 `executor-zero-domain-write` 检查（运行时复核装配没塞多余面）。
 *
 * 装配层接线（harness runtime）：
 *  - tick 新阶段 `executor.runOnce()`（due/startRun/pump/drain 之后）；
 *  - `isMainActive` seam 由宿主注入（v1 保守近似，默认 false）；
 *  - ResumeTicket 桥：宿主在 supervision.approve 后调 `executor.resumeAttempt`；
 *  - trajectory sources 扩 `executor/change` 族（replayCheck 对账）。
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
import {
  executorDomainSpec,
  type ExecutorTables,
} from './domain.ts';
import {
  createExecutorService,
  type ExecutorDeps,
  type ExecutorDispatchSeam,
  type ExecutorGoalSeam,
  type ExecutorSupervisionSeam,
  type ExecutorTaskPoolSeam,
  type ExecutorTimelineSeam,
  type ExecutorWorkflowSeam,
  type TaskExecutorService,
} from './service.ts';
import { registerExecutorInvariants } from './loadChecks.ts';

export {
  executorDomainSpec,
  ExecutorAttemptSchema,
  ExecutorParamsSchema,
  VerificationReportSchema,
  DEFAULT_EXECUTOR_PARAMS,
  EXECUTOR_PARAMS_KEY,
  EXECUTOR_PARAMS_BUSINESS_ID,
  ATTEMPT_PREFIX,
  EXECUTOR_ATTEMPT_STATUSES,
  EXECUTOR_TERMINAL_STATUSES,
  EXECUTOR_MODES,
  VERIFICATION_KINDS,
  type ExecutorTables,
  type ExecutorAttempt,
  type ExecutorAttemptStatus,
  type ExecutorMode,
  type ExecutorParams,
  type VerificationKind,
  type VerificationReport,
} from './domain.ts';
export { attemptPayload, executorParamsPayload } from './events.ts';
export {
  createExecutorService,
  routeTask,
  selectAttempts,
  entryCriteria,
  hasEntryCriteria,
  isHighRiskTask,
  EXECUTOR_ACTOR,
  type TaskExecutorService,
  type ExecutorDeps,
  type ExecutorTaskPoolSeam,
  type ExecutorTaskView,
  type ExecutorDispatchSeam,
  type ExecutorWorkflowSeam,
  type ExecutorSupervisionSeam,
  type ExecutorGoalSeam,
  type ExecutorTimelineSeam,
  type RouteDecision,
  type SelectOptions,
  type AttemptReport,
  type ResumeTicketLike,
} from './service.ts';
export { registerExecutorInvariants, executorInvariantChecks } from './loadChecks.ts';

export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  readonly taskPool: ExecutorTaskPoolSeam;
  readonly dispatch: ExecutorDispatchSeam;
  readonly workflow: ExecutorWorkflowSeam;
  readonly supervision: ExecutorSupervisionSeam;
  readonly goal: ExecutorGoalSeam;
  readonly timeline: ExecutorTimelineSeam;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  /** scheduler 会话 id（认领 owner 归属）。 */
  readonly schedulerSessionId: string;
  /** 装配时刻（孤儿判据的 bootAt 基准，同 T0.5 纪律）。 */
  readonly bootAt: number;
  readonly isMainActive?: () => boolean;
  readonly config?: Partial<import('./domain.ts').ExecutorParams>;
}

export interface TdaExecutorHandle {
  readonly service: TaskExecutorService;
  readonly domain: TdaDomain<ExecutorTables>;
  dispose(): Promise<void>;
}

export interface TdaExecutorPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaExecutorHandle>;
}

export const tdaExecutorPlugin: TdaExecutorPlugin = {
  name: 'tda-executor',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(executorDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const deps: ExecutorDeps = {
      domain,
      session: ctx.session,
      taskPool: ctx.taskPool,
      dispatch: ctx.dispatch,
      workflow: ctx.workflow,
      supervision: ctx.supervision,
      goal: ctx.goal,
      timeline: ctx.timeline,
      ownerSessionId: ctx.schedulerSessionId,
      bootAt: ctx.bootAt,
      reconciler,
      index,
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.isMainActive !== undefined ? { isMainActive: ctx.isMainActive } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    };
    const service = createExecutorService(deps);
    // 启动序：先建状态（params 种子 + 孤儿收口），再注册检查（纪律 #7）
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerExecutorInvariants(ctx.invariants, domain, { service });
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
