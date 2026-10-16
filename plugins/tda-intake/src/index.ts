/**
 * tda-intake 插件出口（T4.2 §4.2）。
 *
 * **J1/J6/J7 的三个落点都在本文件可见**：
 *  - `TdaPluginContext` 的 goalTree seam 只有 `create` 一个写方法 + `get` 只读
 *    （编译期即无目标编辑权——intake 不长成影子目标权威）；
 *  - `timeline` seam 只暴露 `appendUserOriginal`（原文唯一载体=T0.3 chunk，J2）；
 *  - apply 里注册的 `intake-zero-edit-surface` 检查（运行时复核装配没塞写面）。
 *
 * 装配层接线（harness runtime）：
 *  - `extractor`/`decomposer` LLM 工序由装配层注入（intake 独立 seam——
 *    intake 阶段无 taskId，不经 T0.5 task 记录通道，U6 评估收敛）；
 *  - 审批桥：宿主在 supervision.approve 后调 `intake.commit`（凭 ResumeTicket）；
 *  - trajectory sources 扩 `intake/change` 族（replayCheck 对账）。
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
  intakeDomainSpec,
  type IntakeTables,
} from './domain.ts';
import {
  createIntakeService,
  type DraftExtractor,
  type IntakeDeps,
  type IntakeGoalSeam,
  type IntakeSupervisionSeam,
  type IntakeTimelineSeam,
  type TreeDecomposer,
  type IntakeService,
} from './service.ts';
import { registerIntakeInvariants } from './loadChecks.ts';

export {
  intakeDomainSpec,
  OpenQuestionSchema,
  RequirementDraftSchema,
  ProposedGoalNodeSchema,
  ValidationReportSchema,
  GoalTreeProposalSchema,
  IntakeParamsSchema,
  DEFAULT_INTAKE_PARAMS,
  INTAKE_PARAMS_KEY,
  INTAKE_PARAMS_BUSINESS_ID,
  DRAFT_PREFIX,
  INTAKE_PROPOSAL_PREFIX,
  DRAFT_STATUSES,
  DRAFT_ACTIVE_STATUSES,
  DRAFT_TERMINAL_STATUSES,
  PROPOSAL_STATUSES,
  QUESTION_FIELDS,
  type IntakeTables,
  type RequirementDraft,
  type DraftStatus,
  type OpenQuestion,
  type QuestionField,
  type LlmMeta,
  type BudgetHint,
  type GoalTreeProposal,
  type ProposalStatus,
  type ProposedGoalNode,
  type ValidationReport,
  type IntakeParams,
} from './domain.ts';
export { draftPayload, proposalPayload, intakeParamsPayload } from './events.ts';
export {
  createIntakeService,
  deriveQuestionsFromSeed,
  validateProposal,
  VALIDATION_CHECK_IDS,
  INTAKE_ACTOR,
  INTAKE_TICKET_FROM,
  type IntakeService,
  type IntakeDeps,
  type IntakeGoalSeam,
  type IntakeGoalCreateRequest,
  type IntakeGoalView,
  type IntakeSupervisionSeam,
  type IntakeTimelineSeam,
  type DraftExtractor,
  type DraftExtractInput,
  type DraftExtractResult,
  type TreeDecomposer,
  type DecomposeInput,
  type DecomposeResult,
  type ResumeTicketLike,
  type DraftFilter,
  type QuestionSeedInput,
} from './service.ts';
export { registerIntakeInvariants, intakeInvariantChecks } from './loadChecks.ts';

export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  readonly goalTree: IntakeGoalSeam;
  readonly supervision: IntakeSupervisionSeam;
  readonly timeline: IntakeTimelineSeam;
  /** J3：LLM 抽取工序（缺省 ⇒ extract 抛 NO_EXTRACTOR）。 */
  readonly extractor?: DraftExtractor;
  /** J4：Lead 分解工序（缺省 ⇒ propose 抛 NO_DECOMPOSER）。 */
  readonly decomposer?: TreeDecomposer;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly config?: Partial<import('./domain.ts').IntakeParams>;
}

export interface TdaIntakeHandle {
  readonly service: IntakeService;
  readonly domain: TdaDomain<IntakeTables>;
  dispose(): Promise<void>;
}

export interface TdaIntakePlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaIntakeHandle>;
}

export const tdaIntakePlugin: TdaIntakePlugin = {
  name: 'tda-intake',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(intakeDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const deps: IntakeDeps = {
      domain,
      session: ctx.session,
      goalTree: ctx.goalTree,
      supervision: ctx.supervision,
      timeline: ctx.timeline,
      ...(ctx.extractor !== undefined ? { extractor: ctx.extractor } : {}),
      ...(ctx.decomposer !== undefined ? { decomposer: ctx.decomposer } : {}),
      reconciler,
      index,
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    };
    const service = createIntakeService(deps);
    // 启动序：先建状态（params 种子），再注册检查（纪律 #7）
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerIntakeInvariants(ctx.invariants, domain, { service });
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
