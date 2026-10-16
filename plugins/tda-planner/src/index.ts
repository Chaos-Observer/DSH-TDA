/**
 * tda-planner 插件出口（T4.5 §4.2）。
 *
 * **J1 的两个落点都在本文件可见**：
 *  - `TdaPluginContext` 的 taskPool seam 只含 get/list/create/edit/block
 *    （类型级无 claim/complete/startRun/dispatch——编译期即切断"自规划自执行"闭环）；
 *  - apply 里注册的 `planner-zero-execution-surface` 检查（运行时复核装配没塞多余面）。
 *
 * 装配层接线（harness runtime）：
 *  - tick 新阶段 `planner.checkTriggers()`（J7 双驱动之一；opt-in 开关默认关）；
 *  - 审批桥：宿主在 supervision.approve 后调 `planner.applyPlan/activate`（凭 ResumeTicket）；
 *  - trajectory sources 扩 `planner/change` 族（replayCheck 对账）。
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
  plannerDomainSpec,
  type PlannerTables,
} from './domain.ts';
import {
  createPlannerService,
  type Decomposer,
  type PlannerDeps,
  type PlannerGoalSeam,
  type PlannerSupervisionSeam,
  type PlannerTaskPoolSeam,
  type TaskPlannerService,
} from './service.ts';
import { registerPlannerInvariants } from './loadChecks.ts';

export {
  plannerDomainSpec,
  PlanTriggerSchema,
  PlannedTaskSchema,
  CoverageReportSchema,
  TaskPlanSchema,
  PlanContingencySchema,
  PlannerParamsSchema,
  DEFAULT_PLANNER_PARAMS,
  PLANNER_PARAMS_KEY,
  PLANNER_PARAMS_BUSINESS_ID,
  PLAN_PREFIX,
  CONTINGENCY_PREFIX,
  PLAN_STATUSES,
  PLAN_TERMINAL_STATUSES,
  CONTINGENCY_STATUSES,
  TRIGGER_KINDS,
  DEVIATION_KINDS,
  QUALITY_CHECK_IDS,
  type PlannerTables,
  type TaskPlan,
  type PlanStatus,
  type PlannedTask,
  type PlanTrigger,
  type PlanContingency,
  type ContingencyStatus,
  type CoverageReport,
  type QualityCheckId,
  type GenerationMeta,
  type DeviationReport,
  type DeviationKind,
  type PlannerParams,
  type TaskBudgetCaps,
} from './domain.ts';
export { planPayload, contingencyPayload, plannerParamsPayload } from './events.ts';
export {
  createPlannerService,
  evaluatePlan,
  evaluateTriggers,
  isHighRiskPlannedTask,
  PLANNER_ACTOR,
  PLANNER_TICKET_FROM,
  type TaskPlannerService,
  type PlannerDeps,
  type PlannerTaskPoolSeam,
  type PlannerTaskView,
  type PlannerTaskCreateRequest,
  type PlannerTaskEditRequest,
  type PlannerGoalSeam,
  type PlannerGoalView,
  type PlannerSupervisionSeam,
  type Decomposer,
  type DecomposeInput,
  type DecomposeResult,
  type PlannerInputRefs,
  type ResumeTicketLike,
  type TriggerEvent,
  type TriggerEvalTask,
  type DiffReport,
  type PlanFilter,
  type QualityGateContext,
} from './service.ts';
export { registerPlannerInvariants, plannerInvariantChecks } from './loadChecks.ts';

export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  readonly taskPool: PlannerTaskPoolSeam;
  readonly goal: PlannerGoalSeam;
  readonly supervision: PlannerSupervisionSeam;
  /** J2：LLM 分解工序（缺省 ⇒ plan/replan 抛 NO_DECOMPOSER）。 */
  readonly decomposer?: Decomposer;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly config?: Partial<import('./domain.ts').PlannerParams>;
}

export interface TdaPlannerHandle {
  readonly service: TaskPlannerService;
  readonly domain: TdaDomain<PlannerTables>;
  dispose(): Promise<void>;
}

export interface TdaPlannerPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaPlannerHandle>;
}

export const tdaPlannerPlugin: TdaPlannerPlugin = {
  name: 'tda-planner',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(plannerDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const deps: PlannerDeps = {
      domain,
      session: ctx.session,
      taskPool: ctx.taskPool,
      goal: ctx.goal,
      supervision: ctx.supervision,
      ...(ctx.decomposer !== undefined ? { decomposer: ctx.decomposer } : {}),
      reconciler,
      index,
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    };
    const service = createPlannerService(deps);
    // 启动序：先建状态（params 种子），再注册检查（纪律 #7）
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerPlannerInvariants(ctx.invariants, domain, { service });
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
