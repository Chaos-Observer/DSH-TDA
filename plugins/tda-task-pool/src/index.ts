/**
 * tda-task-pool 插件出口（六文件模板汇聚点：domain/events/cron/service/tools/loadChecks/index）。
 *
 * IT2 形态：框架无关——TdaPluginContext 是 Cordis ctx 的结构镜像
 * （storage / invariants / session 三槽 + 可选 bus / goalTree 联动槽）。
 * IT3 接 DSH 时仅此文件把 TdaPluginContext 换成真实 Cordis ctx，
 * domain/service/loadChecks/tools 零改动（决策点③可逆性）。
 *
 * T0.2 出口面：ctx.taskPool（服务）+ domain（后续插件只读引用）+ 工具集定义。
 * 联动：提交成功后经 bus 分发 `taskPool/change`（goal-state 据此幂等推进目标 stage）；
 * 账本向上汇聚经 goalLookup seam（见 service.ts 顶注的记账路径裁定）。
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
import { taskPoolDomainSpec, type TaskTables } from './domain.ts';
import {
  createTaskPoolService,
  type GoalLookup,
  type TaskPoolService,
} from './service.ts';
import { registerTaskPoolInvariants } from './loadChecks.ts';
import { createTaskPoolTools, type TaskToolDefinition } from './tools.ts';

export {
  taskPoolDomainSpec,
  TaskNodeSchema,
  TaskBudgetSchema,
  TaskScheduleSchema,
  TaskRecurrenceSchema,
  TaskBlockedReasonSchema,
  TaskProposalSchema,
  TaskChangeRecordSchema,
  TaskRunRecordSchema,
  TaskConsumedSchema,
  TASK_PHASES,
  TASK_STAGES,
  TASK_OUTCOMES,
  TASK_ACTORS,
  TASK_ZONES,
  TASK_OPERATIONS,
  TASK_BUDGET_DIMS,
  BUDGET_CONVERGE_RATIO,
  ZERO_CONSUMED,
  capsOf,
  remainingOf,
  zoneOf,
  zoneOfCaps,
  type TaskTables,
  type TaskNode,
  type TaskPhase,
  type TaskStage,
  type TaskOutcome,
  type TaskActor,
  type TaskZone,
  type TaskOperation,
  type TaskBudget,
  type TaskBudgetCaps,
  type TaskBudgetDim,
  type TaskConsumed,
  type TaskSchedule,
  type TaskRecurrence,
  type TaskBlockedReason,
  type TaskProposal,
  type TaskChangeRecord,
  type TaskRunRecord,
} from './domain.ts';
export { taskChangePayload } from './events.ts';
export {
  parseCron,
  isValidCron,
  nextCronAfter,
  nextRecurrenceAfter,
  type CronSpec,
  type RecurrenceLike,
} from './cron.ts';
export {
  createTaskPoolService,
  normalizeWorkspacePath,
  type TaskPoolService,
  type TaskPoolDeps,
  type TaskRef,
  type CreateTaskRequest,
  type EditTaskRequest,
  type TaskCompletion,
  type RunCompletion,
  type ConsumedUsage,
  type TaskListFilter,
  type TaskView,
  type TaskPoolSection,
  type ScopeWarning,
  type GoalLookup,
  type GoalView,
  type GoalBudgetView,
  type GoalUsageLike,
  type GoalRefLike,
} from './service.ts';
export {
  createTaskPoolTools,
  toTaskView,
  TASK_POOL_TOOL_NAMES,
  type TaskToolDefinition,
  type TaskToolCallContext,
  type TaskPoolToolName,
} from './tools.ts';
export {
  registerTaskPoolInvariants,
  taskPoolInvariantChecks,
  type TaskInvariantOptions,
} from './loadChecks.ts';

/** Cordis ctx 的结构镜像（IT3 起替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  /** 事件分发面（跨插件联动；未装配则不发事件，插件仍自洽）。 */
  readonly bus?: TdaEventBus;
  /** 目标层 seam（tda-goal-state 的 ctx.goalTree 服务面）；未装配则跨层检查降级。 */
  readonly goalLookup?: GoalLookup;
  /** 可注入时钟（测试确定性）。 */
  readonly now?: () => number;
}

export interface TdaTaskPoolHandle {
  readonly service: TaskPoolService;
  readonly domain: TdaDomain<TaskTables>;
  readonly tools: readonly TaskToolDefinition[];
  dispose(): Promise<void>;
}

export interface TdaTaskPoolPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaTaskPoolHandle>;
}

export const tdaTaskPoolPlugin: TdaTaskPoolPlugin = {
  name: 'tda-task-pool',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(taskPoolDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    // 两级不变量：内核级（@tda/kernel，双写配对）+ 插件级（tda-task-pool，九条）
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerTaskPoolInvariants(ctx.invariants, domain, {
      ...(ctx.goalLookup !== undefined ? { goalLookup: ctx.goalLookup } : {}),
    });
    const service = createTaskPoolService({
      domain,
      session: ctx.session,
      reconciler,
      index,
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.goalLookup !== undefined ? { goalLookup: ctx.goalLookup } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    });
    return {
      service,
      domain,
      tools: createTaskPoolTools(service),
      async dispose() {
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
