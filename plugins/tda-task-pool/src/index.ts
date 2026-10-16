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
  asSessionId,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createSqliteBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  registerTdaInvariants,
  TdaError,
  type TdaDomain,
  type TdaEventBus,
  type TdaInvariantRegistry,
  type TdaLogEvent,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { join } from 'node:path';
import { taskPoolDomainSpec, type TaskTables } from './domain.ts';
import {
  createTaskPoolService,
  type GoalLookup,
  type TaskPoolService,
} from './service.ts';
import { registerTaskPoolInvariants } from './loadChecks.ts';
import { createTaskPoolTools, type TaskToolDefinition } from './tools.ts';
/**
 * P5.4：DSH 工具面直传（ToolDefinition 契约形状 + 注册宿主语义镜像）。
 * 注意：cordis 入口（dsh.ts）**不在此再导出**——cordis Service 用参数属性，
 * strip-only 子进程（kill -9 场景）不可加载，须显式 import 或 transform-types。
 */
export {
  callerFromExec,
  createDshToolRegistry,
  toDshToolDefinition,
  validateJsonSchemaSubset,
  RUN_CODE_RESERVED_NAME,
  type DshToolCallerOptions,
  type DshToolDefinition,
  type DshToolRegistry,
  type DshToolRunContext,
  type DshToolSchema,
  type DshTextContentBlock,
} from './dshTools.ts';

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

// ── P5.6 cordis loader 入口（default export = loader/Include 可挂载插件）──
//
// 形态：自举式——apply 内按 config 自建三槽（backend/invariants/session sink），
// 不依赖宿主服务面；DSH 宿主到位后可把这三槽换成 ctx.storage/ctx.session 注入。
// **不 import cordis**（保持 strip-only 子进程可加载；ctx 结构化使用）。

export interface TaskPoolEntryConfig {
  /** 数据目录（必填；json 域文件/sqlite 库落此处）。 */
  readonly dir: string;
  /** 存储介质（缺省 json；sqlite = DSH 兼容布局，库文件 <dir>/tda.db）。 */
  readonly storage?: 'json' | 'sqlite';
  /** 会话身份（审计归属；缺省 'sess-task-pool-entry'）。 */
  readonly sessionId?: string;
}

export default {
  name: 'tda-task-pool',
  /** cordis provide 名：挂载后经 ctx.taskPool 可达。 */
  provide: 'taskPool',
  reusable: true,
  async apply(
    ctx: { provide?: (name: string, value: unknown) => void },
    config: TaskPoolEntryConfig,
  ) {
    console.log('[tda-task-pool] entry applied（dir=' + config.dir + '，storage=' + (config.storage ?? 'json') + '）');
    if (typeof config?.dir !== 'string' || config.dir === '') {
      throw new TdaError('ENTRY_DIR_REQUIRED', 'tda-task-pool 行 config.dir 必填（数据目录）');
    }
    const backend = config.storage === 'sqlite'
      ? createSqliteBackend(join(config.dir, 'tda.db'))
      : createJsonBackend(config.dir);
    const invariants = createTdaInvariantRegistry();
    // 会话 sink：v1 内存态（审计留进程内；宿主接管后换 DSH session 持久面）
    let seq = 0;
    const sink: TdaSessionSink = {
      sessionId: asSessionId(config.sessionId ?? 'sess-task-pool-entry'),
      append(_event: TdaLogEvent) {
        seq += 1;
        return seq;
      },
      flush() {},
    };
    const handle = await tdaTaskPoolPlugin.apply({ storage: backend, invariants, session: sink });
    console.log('[tda-task-pool] entry 自检：服务面可用（list=' + handle.service.list().length + '）');
    // cordis 反射层显式供给（provide 字段仅宿主元数据，本 fork 不自动接管返回值）
    // 反射层直供（绕开 effect 收集——provide 的 disposer 返回值会被 effect 校验判 Invalid）
    (ctx as { reflect?: { provide?: (name: string, value: unknown) => () => void } }).reflect?.provide?.('taskPool', handle.service);
    // 本 fork 的 effect 契约：apply 返回值只能是 undefined 或 disposer——
    // 服务经 reflect.provide 供给（返回 service 会被 safeCollect 判 Invalid effect）。
    return undefined;
  },
};
