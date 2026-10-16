/**
 * tda-planner 服务面（T4.5 §4.2 `ctx.taskPlanner`）。
 *
 * 硬纪律（全部在类型级或运行时强制）：
 *  - **零执行权**：deps 的 taskPool seam 只含 get/list/create/edit/block
 *    （类型级无 claim/complete/startRun/dispatch——J1 规划与执行强分离）；
 *  - **质量门权威**：LLM 分解只是建议，离开 draft 前必过 evaluatePlan 五查
 *    （J2/J9：criteria 覆盖/预算守恒/无环/叶子可执行/预案覆盖）；
 *  - **计划快照不可变**：除状态与 CAS revision 外一切字段只写一次（J3）；
 *  - **审批门**：applyPlan/activate 必经对应 kind 批准 + 一次性 ResumeTicket；
 *    v1 无自动路径（activationAutonomy='human-only'，J4）；
 *  - **触发检测确定性**：evaluateTriggers 是导出纯函数（同输入同输出，单测逐分支）；
 *  - **禁整树重建**：replan 只 supersede 链 + 增量应用（J8）；
 *  - **零注入直通**：deps 无 context/surface 句柄（编译期即无）。
 */
import {
  allocateId,
  asContingencyId,
  asPlanId,
  dualWrite,
  TdaError,
  type AuditIndex,
  type ContingencyId,
  type DualWriteContext,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  DEFAULT_PLANNER_PARAMS,
  PLANNER_PARAMS_BUSINESS_ID,
  PLANNER_PARAMS_KEY,
  PlannerParamsSchema,
  type CoverageReport,
  type DeviationReport,
  type PlanContingency,
  type PlanStatus,
  type PlannedTask,
  type PlannerParams,
  type PlannerTables,
  type TaskBudgetCaps,
  type TaskPlan,
} from './domain.ts';
import { contingencyPayload, planPayload, plannerParamsPayload } from './events.ts';

/** 规划器的固定 actor（J6：代建任务 proposedBy='agent'）。 */
export const PLANNER_ACTOR = 'agent';
/** ResumeTicket 的 from 标识（审批桥按此校验票据归属）。 */
export const PLANNER_TICKET_FROM = 'ctx.taskPlanner';

// ── 只读/受控写 seam（结构镜像：方法式声明获得参数双变性） ────────────────

export interface PlannerTaskView {
  readonly id: string;
  readonly revision: number;
  readonly goalId: string;
  readonly subject: string;
  readonly phase: string;
  readonly stage: string;
  readonly outcome?: string | undefined;
  readonly blockedBy: readonly string[];
  readonly priority: number;
  readonly zone: string;
  readonly runCount: number;
  readonly consecutiveFailures: number;
  readonly budget: {
    readonly caps: TaskBudgetCaps;
    readonly consumed: TaskBudgetCaps;
  };
  readonly localPath?: string | undefined;
  readonly writeScopes: readonly string[];
}

export interface PlannerTaskCreateRequest {
  readonly goalId: string;
  readonly subject: string;
  readonly description?: string;
  readonly parentTaskId?: string;
  readonly alternativeOf?: { taskId: string; planId?: string; contingencyId?: string };
  readonly blockedBy?: readonly string[];
  readonly localPath?: string;
  readonly writeScopes?: readonly string[];
  readonly priority?: number;
  readonly budget?: TaskBudgetCaps;
  /** P4（T4.5 §3.4 v2）：规划溯源。 */
  readonly planId?: string;
}

export interface PlannerTaskEditRequest {
  readonly subject?: string;
  readonly priority?: number;
  readonly blockedBy?: readonly string[];
  readonly stage?: 'planning' | 'executing' | 'waiting' | 'verifying';
  readonly budget?: TaskBudgetCaps;
}

/** J1：类型级零执行权——只有 get/list/create/edit/block，无 claim/complete/startRun/dispatch。 */
export interface PlannerTaskPoolSeam {
  get(id: string): PlannerTaskView | undefined;
  list(filter?: { goalId?: string }): readonly PlannerTaskView[];
  create(actor: string, req: PlannerTaskCreateRequest): Promise<PlannerTaskView>;
  edit(actor: string, id: string, ref: { expectedRevision: number }, req: PlannerTaskEditRequest): Promise<PlannerTaskView>;
  block(
    actor: string,
    id: string,
    ref: { expectedRevision: number },
    reason: { code: string; message: string },
  ): Promise<PlannerTaskView>;
}

export interface PlannerGoalView {
  readonly id: string;
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  /** 目标剩余预算（按维度；缺省维度=不设帽）。 */
  readonly budgetRemaining: TaskBudgetCaps;
}

export interface PlannerGoalSeam {
  get(id: string): PlannerGoalView | undefined;
}

export interface PlannerSupervisionSeam {
  request(input: {
    kind: string;
    requester: { service: string; ref: string };
    subject: string;
    whatToShow: {
      summary: string;
      impact: readonly { target: string; change: 'create' | 'update' | 'invalidate' | 'execute'; reversible: boolean }[];
      riskReasons: readonly string[];
      evidence: readonly { kind: string; ref: string }[];
    };
    resume: { from: string; handle: string };
    taskId?: string;
    goalId?: string;
    riskHint?: 'low' | 'medium' | 'high';
  }): Promise<{ approvalId: string }>;
}

/** LLM 分解工序（J2：Lead 角色 one-shot；schema 白名单在 prompt 侧强制）。 */
export interface DecomposeInput {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  /** replan 上下文：触发重规划的偏差证据。 */
  readonly deviation?: DeviationReport;
  /** replan 上下文：既有任务主题（防重复分解）。 */
  readonly existingTaskSubjects: readonly string[];
}

export interface DecomposeResult {
  readonly tasks: readonly PlannedTask[];
  readonly generation: { provider: string; model: string; schemaHash: string };
}

export type Decomposer = (input: DecomposeInput) => Promise<DecomposeResult>;

export interface PlannerInputRefs {
  /** 工作区语义摘要引用（J5：全文不进规划 prompt，T4.3/T0.6 摘要由装配层备好）。 */
  readonly workspaceDigestEntryIds?: readonly string[];
}

export interface ResumeTicketLike {
  readonly approvalId: string;
  readonly nonce: string;
  readonly from: string;
  readonly handle: string;
}

export interface TriggerEvent {
  readonly kind: 'activate' | 'expire';
  readonly contingencyId: string;
  readonly detail: string;
  readonly at: number;
}

export interface DiffReport {
  readonly planId: string;
  readonly created: readonly string[];
  readonly edited: readonly string[];
  readonly skipped: readonly string[];
}

export interface PlanFilter {
  readonly goalId?: string;
  readonly status?: PlanStatus;
}

export interface TaskPlannerService {
  initialize(): Promise<void>;
  /**
   * 生成计划草稿（J2：LLM 分解 + 质量门；门不过留 draft）。
   * 命名说明：规格 §4.2 的 `plan(goalId)` 与 `plan(id)` 同名重载在对象字面量
   * 实现上不可行（重复键）——按仓库惯例（executor: attempts()/attempt()）
   * 生成器定名 proposePlan，`plan(id)` 保持按 id 读取器。
   */
  proposePlan(goalId: string, inputs?: PlannerInputRefs): Promise<TaskPlan>;
  qualityGate(planId: string): CoverageReport;
  confirmRequest(actor: 'human' | 'lead', planId: string): Promise<{ approvalId: string }>;
  applyPlan(planId: string, token: ResumeTicketLike): Promise<readonly string[]>;
  replan(goalId: string, deviation: DeviationReport): Promise<TaskPlan>;
  applyReplanDiff(planId: string, token: ResumeTicketLike): Promise<DiffReport>;
  contingencies(planId?: string): readonly PlanContingency[];
  contingency(id: string): PlanContingency | undefined;
  checkTriggers(now: number): readonly TriggerEvent[];
  /**
   * 触发扫描 + 自动清理（J7 双驱动之二，tick 挂点）：
   * 检出事件（activate 待批/expire 自动）；autoExpire 开时 dormant 预案的
   * 主路径已 success ⇒ 自动落 expired（不变量 10 的低风险清理，无需审批）。
   */
  runTriggerScan(now: number): Promise<readonly TriggerEvent[]>;
  requestActivation(contingencyId: string): Promise<{ approvalId: string }>;
  activate(contingencyId: string, token: ResumeTicketLike): Promise<PlanContingency>;
  veto(contingencyId: string, reason: string): Promise<PlanContingency>;
  plans(filter?: PlanFilter): readonly TaskPlan[];
  plan(id: string): TaskPlan | undefined;
  params(): PlannerParams;
  setParams(actor: 'human' | 'lead', patch: Partial<Omit<PlannerParams, 'revision'>>): Promise<PlannerParams>;
}

export interface PlannerDeps {
  readonly domain: TdaDomain<PlannerTables>;
  readonly session: TdaSessionSink;
  readonly taskPool: PlannerTaskPoolSeam;
  readonly goal: PlannerGoalSeam;
  readonly supervision: PlannerSupervisionSeam;
  /** J2：LLM 分解工序（缺省 ⇒ plan/replan 抛 NO_DECOMPOSER，禁假造分解）。 */
  readonly decomposer?: Decomposer;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly config?: Partial<PlannerParams>;
}

// ── 纯函数：质量门五查（J9，确定性，禁 LLM） ────────────────────────────

export interface QualityGateContext {
  /** 目标完成标准（质量门①的覆盖基准）。 */
  readonly goalCriteria: readonly string[];
  /** 目标剩余预算（质量门②的守恒基准；缺省维度=不设帽）。 */
  readonly goalRemaining: TaskBudgetCaps;
}

const BUDGET_DIMS = ['tokens', 'toolCalls', 'wallClockMs', 'attentionUnits'] as const;

const check = (
  id: CoverageReport['checks'][number]['id'],
  passed: boolean,
  detail: string,
): CoverageReport['checks'][number] => ({ id, passed, detail });

const effectiveCaps = (task: PlannedTask, inherited: TaskBudgetCaps): TaskBudgetCaps => {
  const effective: TaskBudgetCaps = {};
  for (const dim of BUDGET_DIMS) {
    const value = task.budget?.[dim] ?? inherited[dim];
    if (value !== undefined) effective[dim] = value;
  }
  return effective;
};

const capsSum = (caps: readonly TaskBudgetCaps[]): TaskBudgetCaps => {
  const total: TaskBudgetCaps = {};
  for (const cap of caps) {
    for (const dim of BUDGET_DIMS) {
      const value = cap[dim];
      if (value !== undefined) total[dim] = (total[dim] ?? 0) + value;
    }
  }
  return total;
};

const withinCaps = (assigned: TaskBudgetCaps, limit: TaskBudgetCaps): string | undefined => {
  for (const dim of BUDGET_DIMS) {
    const used = assigned[dim];
    const cap = limit[dim];
    if (used === undefined || cap === undefined) continue;
    if (used > cap) return `${dim} 超帽（分配 ${used} > 限额 ${cap}）`;
  }
  return undefined;
};

/** 高风险任务判据（T0.5 J9 同款：writeScopes 超出 localPath 或 riskHint=high）。 */
export function isHighRiskPlannedTask(task: PlannedTask): boolean {
  if (task.riskHint === 'high') return true;
  const scopes = task.writeScopes ?? [];
  if (scopes.length === 0) return false;
  if (task.localPath === undefined || task.localPath === '') return true;
  const root = task.localPath.endsWith('/') ? task.localPath : `${task.localPath}/`;
  return scopes.some((scope) => !scope.startsWith(root));
}

/**
 * 质量门五查（J9；纯函数，同输入同输出）。
 *  ① criteria 覆盖：目标每个 completionCriteria 至少一个任务以其索引进 criteriaRefs；
 *  ② 预算守恒：Σ根帽 ≤ 目标剩余；Σ子帽 ≤ 父任务有效帽（继承链向上取最近定义）；
 *  ③ 依赖无环：parentTempId + blockedByTempIds + alternativeOfTempId 合并图（引用完备同查）；
 *  ④ 叶子可执行：无子任务节点 subject 非空 ∧ completionCriteria 非空 ∧ localPath/writeScopes 合法；
 *  ⑤ 预案覆盖：高风险任务必有 alternativeOfTempId 或显式 noContingencyReason。
 */
export function evaluatePlan(tasks: readonly PlannedTask[], ctx: QualityGateContext): CoverageReport {
  const checks: CoverageReport['checks'] = [];
  const byTempId = new Map(tasks.map((task) => [task.tempId, task]));

  // ① criteria 覆盖
  const covered = new Set<number>();
  for (const task of tasks) {
    for (const ref of task.criteriaRefs) {
      if (ref >= 0 && ref < ctx.goalCriteria.length) covered.add(ref);
    }
  }
  const uncovered: number[] = [];
  for (let index = 0; index < ctx.goalCriteria.length; index += 1) {
    if (!covered.has(index)) uncovered.push(index);
  }
  checks.push(
    check(
      'criteria-coverage',
      uncovered.length === 0,
      uncovered.length === 0
        ? `${ctx.goalCriteria.length} 条目标标准全部有任务覆盖`
        : `目标标准未被覆盖：索引 [${uncovered.join(', ')}]`,
    ),
  );

  // ② 预算守恒（父先子后拓扑递推有效帽）
  const childrenOf = new Map<string, PlannedTask[]>();
  for (const task of tasks) {
    if (task.parentTempId === undefined) continue;
    const siblings = childrenOf.get(task.parentTempId) ?? [];
    siblings.push(task);
    childrenOf.set(task.parentTempId, siblings);
  }
  const budgetViolations: string[] = [];
  const walkBudget = (task: PlannedTask, inherited: TaskBudgetCaps): void => {
    const effective = effectiveCaps(task, inherited);
    const children = childrenOf.get(task.tempId) ?? [];
    if (children.length > 0) {
      const violation = withinCaps(capsSum(children.map((child) => effectiveCaps(child, effective))), effective);
      if (violation !== undefined) budgetViolations.push(`${task.tempId} 子任务${violation}`);
      for (const child of children) walkBudget(child, effective);
    }
  };
  for (const task of tasks) {
    if (task.parentTempId === undefined) walkBudget(task, {});
  }
  const roots = tasks.filter((task) => task.parentTempId === undefined);
  const rootViolation = withinCaps(capsSum(roots.map((task) => effectiveCaps(task, {}))), ctx.goalRemaining);
  if (rootViolation !== undefined) budgetViolations.push(`根任务Σ帽${rootViolation}`);
  checks.push(
    check(
      'budget-conservation',
      budgetViolations.length === 0,
      budgetViolations.length === 0 ? '预算切分守恒（Σ子≤父、Σ根≤目标剩余）' : budgetViolations.join('；'),
    ),
  );

  // ③ 依赖无环 + 引用完备（父子+阻塞+预案边合并图）
  const dangling: string[] = [];
  const edges = new Map<string, string[]>();
  for (const task of tasks) {
    const outs: string[] = [];
    const refs: readonly (readonly [string, string])[] = [
      ...(task.parentTempId !== undefined ? [['父任务', task.parentTempId] as const] : []),
      ...task.blockedByTempIds.map((dep) => ['阻塞依赖', dep] as const),
      ...(task.alternativeOfTempId !== undefined ? [['备选', task.alternativeOfTempId] as const] : []),
    ];
    for (const [label, target] of refs) {
      if (!byTempId.has(target)) {
        dangling.push(`${task.tempId} 引用不存在的${label} ${target}`);
        continue;
      }
      outs.push(target);
    }
    edges.set(task.tempId, outs);
  }
  const cycleNodes: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walk = (current: string): void => {
    if (done.has(current)) return;
    if (visiting.has(current)) {
      cycleNodes.push(current);
      return;
    }
    visiting.add(current);
    for (const next of edges.get(current) ?? []) walk(next);
    visiting.delete(current);
    done.add(current);
  };
  for (const tempId of edges.keys()) walk(tempId);
  const dagOk = cycleNodes.length === 0 && dangling.length === 0;
  checks.push(
    check(
      'dag-acyclic',
      dagOk,
      dagOk
        ? '合并图无环且引用完备'
        : [...dangling, ...(cycleNodes.length > 0 ? [`成环节点：[${cycleNodes.join(', ')}]`] : [])].join('；'),
    ),
  );

  // ④ 叶子可执行
  const leafViolations: string[] = [];
  for (const task of tasks) {
    if ((childrenOf.get(task.tempId) ?? []).length > 0) continue;
    if (task.subject.trim() === '') leafViolations.push(`${task.tempId} subject 为空`);
    if (task.completionCriteria.length === 0) leafViolations.push(`${task.tempId} completionCriteria 为空`);
    const scopes = task.writeScopes ?? [];
    if (task.localPath !== undefined && task.localPath.trim() === '') {
      leafViolations.push(`${task.tempId} localPath 为空串`);
    }
    if (scopes.some((scope) => scope.trim() === '')) leafViolations.push(`${task.tempId} writeScopes 含空串`);
  }
  checks.push(
    check(
      'leaf-executable',
      leafViolations.length === 0,
      leafViolations.length === 0 ? '全部叶子可执行' : leafViolations.join('；'),
    ),
  );

  // ⑤ 预案覆盖
  const contingencyViolations: string[] = [];
  for (const task of tasks) {
    // 备选边必携 contingency 结构（对所有带边任务，不限高风险）
    if (task.alternativeOfTempId !== undefined && task.contingency === undefined) {
      contingencyViolations.push(`${task.tempId} 有备选边却无 contingency（trigger/carveOut 必携）`);
    }
    if (!isHighRiskPlannedTask(task)) continue;
    if (task.alternativeOfTempId === undefined && (task.noContingencyReason ?? '') === '') {
      contingencyViolations.push(`${task.tempId} 高风险却无预案且无显式理由`);
    }
  }
  checks.push(
    check(
      'contingency-coverage',
      contingencyViolations.length === 0,
      contingencyViolations.length === 0 ? '高风险任务预案覆盖完备' : contingencyViolations.join('；'),
    ),
  );

  return { passed: checks.every((item) => item.passed), checks };
}

// ── 纯函数：预案触发检测（J7/J9，确定性） ───────────────────────────────

export interface TriggerEvalTask {
  readonly id: string;
  readonly phase: string;
  readonly outcome?: string | undefined;
  readonly zone: string;
  readonly consecutiveFailures: number;
}

/**
 * 触发检测纯函数（J7：task 状态×预算区×attempts×验证结果的机械组合，禁 LLM 猜）。
 *  - activate：dormant 预案的 trigger 条件满足（只产事件，不自动切换）；
 *  - expire：autoExpire 开 ∧ dormant 预案的主路径已 success 完成（低风险自动清理）。
 * legacy 边（无 contingencyId）由调用方预过滤，不进本函数。
 */
export function evaluateTriggers(
  contingencies: readonly PlanContingency[],
  tasks: ReadonlyMap<string, TriggerEvalTask>,
  params: Pick<PlannerParams, 'autoExpire' | 'verifyFailThreshold'>,
  now: number,
): readonly TriggerEvent[] {
  const events: TriggerEvent[] = [];
  for (const contingency of contingencies) {
    if (contingency.status !== 'dormant') continue;
    const primary = tasks.get(contingency.primaryTaskId);
    if (primary === undefined) continue;
    if (params.autoExpire && primary.phase === 'complete' && primary.outcome === 'success') {
      events.push({
        kind: 'expire',
        contingencyId: contingency.id,
        detail: `主路径 ${contingency.primaryTaskId} 已成功完成，预案作废（autoExpire）`,
        at: now,
      });
      continue;
    }
    const trigger = contingency.trigger;
    let fired = false;
    let detail = '';
    switch (trigger.kind) {
      case 'task-failed':
        fired = primary.phase === 'complete' && primary.outcome === 'failed';
        detail = `主路径 ${contingency.primaryTaskId} 失败终态`;
        break;
      case 'task-blocked':
        fired = primary.phase === 'blocked';
        detail = `主路径 ${contingency.primaryTaskId} 进入 blocked`;
        break;
      case 'budget-zone':
        fired = primary.zone === trigger.zone;
        detail = `主路径 ${contingency.primaryTaskId} 预算进入 ${trigger.zone} 区`;
        break;
      case 'verify-failed': {
        const threshold = Math.max(trigger.attempts, params.verifyFailThreshold);
        fired = primary.consecutiveFailures >= threshold;
        detail = `主路径 ${contingency.primaryTaskId} 连续失败 ${primary.consecutiveFailures} 次（阈值 ${threshold}）`;
        break;
      }
    }
    if (fired) {
      events.push({ kind: 'activate', contingencyId: contingency.id, detail, at: now });
    }
  }
  return events;
}

/** applyTasks 的代建结果（内部类型；applyPlan/applyReplanDiff 消费）。 */
interface ApplyTasksOutcome {
  readonly created: string[];
  readonly edited: string[];
  readonly skipped: string[];
  readonly tempToTaskId: Record<string, string>;
}

// ── 服务实现 ────────────────────────────────────────────────────────────

export function createPlannerService(deps: PlannerDeps): TaskPlannerService {
  const clock = deps.now ?? ((): number => Date.now());
  const bus = deps.bus;
  /** 一次性 ResumeTicket 的进程内消费记录（跨进程重放防护归 supervision 的 token 语义）。 */
  const consumedTickets = new Set<string>();
  const dualContext: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };

  /** 进程内互斥链（纪律 #25：持锁窗口内走 applyXxx 无锁实现，公开方法只加锁包装）。 */
  let chain: Promise<unknown> = Promise.resolve();
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const plansTable = () => deps.domain.table('planner_plans');
  const contingenciesTable = () => deps.domain.table('planner_contingencies');
  const paramsTable = () => deps.domain.table('planner_params');

  /** 统一出口：dualWrite（域+事件配对）后 bus.publish（纪律 #6）。 */
  const commit = async (
    businessId: string,
    payload: import('@tda/kernel').JsonObject,
    domainWrite: () => void | Promise<void>,
  ): Promise<number> => {
    const seq = await dualWrite(
      deps.session,
      { family: 'planner/change', businessId, payload, domainWrite },
      dualContext,
    );
    if (bus !== undefined) {
      bus.publish({
        family: 'planner/change',
        businessId,
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
    return seq;
  };

  const putPlan = async (plan: TaskPlan): Promise<void> => {
    await plansTable().put(plan.id, plan);
  };

  const putContingency = async (contingency: PlanContingency): Promise<void> => {
    await contingenciesTable().put(contingency.id, contingency);
  };

  const commitPlan = async (
    current: TaskPlan,
    mutate: (draft: TaskPlan) => TaskPlan,
  ): Promise<TaskPlan> => {
    const next = mutate({ ...current, revision: current.revision + 1 });
    await commit(next.id, planPayload(next), async () => {
      await putPlan(next);
    });
    return next;
  };

  const commitContingency = async (
    current: PlanContingency,
    mutate: (draft: PlanContingency) => PlanContingency,
  ): Promise<PlanContingency> => {
    const next = mutate({ ...current, revision: current.revision + 1 });
    await commit(next.id, contingencyPayload(next), async () => {
      await putContingency(next);
    });
    return next;
  };

  const readParams = (): PlannerParams => {
    const stored = paramsTable().get(PLANNER_PARAMS_KEY);
    if (stored !== undefined) return stored;
    return { ...DEFAULT_PLANNER_PARAMS, ...deps.config, revision: 0 };
  };

  const seedParams = async (): Promise<void> => {
    if (paramsTable().get(PLANNER_PARAMS_KEY) !== undefined) return;
    const params: PlannerParams = { ...DEFAULT_PLANNER_PARAMS, ...deps.config, revision: 0 };
    await commit(PLANNER_PARAMS_BUSINESS_ID, plannerParamsPayload(params), async () => {
      await paramsTable().put(PLANNER_PARAMS_KEY, params);
    });
  };

  const mustPlan = (planId: string): TaskPlan => {
    const plan = plansTable().get(planId);
    if (plan === undefined) throw new TdaError('PLAN_NOT_FOUND', `计划不存在：${planId}`);
    return plan;
  };

  const mustContingency = (contingencyId: string): PlanContingency => {
    const contingency = contingenciesTable().get(contingencyId);
    if (contingency === undefined) {
      throw new TdaError('CONTINGENCY_NOT_FOUND', `预案不存在：${contingencyId}`);
    }
    return contingency;
  };

  /** 票据校验（一次性；身份/重放先拦，状态后查——同 T4.1 裁定）。 */
  const verifyTicket = (
    ticket: ResumeTicketLike,
    handle: string,
    currentStatus: string,
    allowedStatuses: readonly string[],
    notAwaitingMessage: string,
  ): void => {
    if (ticket.from !== PLANNER_TICKET_FROM || ticket.handle !== handle) {
      throw new TdaError(
        'RESUME_TICKET_MISMATCH',
        `ResumeTicket 不指向本记录（from=${ticket.from}, handle=${ticket.handle}，期望 ${handle}）`,
      );
    }
    if (consumedTickets.has(ticket.nonce)) {
      throw new TdaError('RESUME_TICKET_REPLAY', 'ResumeTicket nonce 已消费（一次性）');
    }
    if (!allowedStatuses.includes(currentStatus)) {
      throw new TdaError('RECORD_NOT_AWAITING', notAwaitingMessage);
    }
    consumedTickets.add(ticket.nonce);
  };

  const goalOf = (goalId: string): PlannerGoalView => {
    const goal = deps.goal.get(goalId);
    if (goal === undefined) throw new TdaError('GOAL_NOT_FOUND', `目标不存在：${goalId}`);
    return goal;
  };

  const runQualityGate = (tasks: readonly PlannedTask[], goalId: string): CoverageReport =>
    evaluatePlan(tasks, {
      goalCriteria: goalOf(goalId).completionCriteria,
      goalRemaining: goalOf(goalId).budgetRemaining,
    });

  /** 生成计划草稿（J2：LLM 分解 + 质量门；门不过留 draft 不过闸）。 */
  const draftPlan = async (
    goalId: string,
    kind: 'initial' | 'replan',
    deviation: DeviationReport | undefined,
    supersedes: string | undefined,
  ): Promise<TaskPlan> => {
    if (deps.decomposer === undefined) {
      throw new TdaError('NO_DECOMPOSER', '规划器未注入 LLM 分解工序（J2：禁假造分解）');
    }
    const goal = goalOf(goalId);
    const existing = deps.taskPool.list({ goalId }).map((task) => task.subject);
    const result = await deps.decomposer({
      goalId,
      objective: goal.objective,
      completionCriteria: goal.completionCriteria,
      ...(deviation !== undefined ? { deviation } : {}),
      existingTaskSubjects: existing,
    });
    if (result.tasks.length === 0) {
      throw new TdaError('EMPTY_DECOMPOSITION', 'LLM 分解结果为空（禁建空计划）');
    }
    const coverage = runQualityGate(result.tasks, goalId);
    const plan: TaskPlan = {
      id: asPlanId(allocateId(plansTable(), 'plan')),
      revision: 0,
      goalId,
      status: 'draft',
      kind,
      tasks: [...result.tasks],
      coverage,
      generation: { ...result.generation, at: clock() },
      ...(deviation !== undefined ? { deviation } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      createdAt: clock(),
    };
    await commit(plan.id, planPayload(plan), async () => {
      await putPlan(plan);
    });
    return plan;
  };

  /**
   * 代建序（J6）：父先子后 + 阻塞依赖先行 + **备选先于主路径**（alternativeOf 边
   * 在 create 时即携 contingencyId——前向引用会丢边，故三类边统一拓扑）。
   * 合并图无环由质量门③保证；此处再 fail-loud 复核。
   */
  const applyOrder = (tasks: readonly PlannedTask[]): readonly PlannedTask[] => {
    const byTempId = new Map(tasks.map((task) => [task.tempId, task]));
    const indegree = new Map<string, number>();
    const successors = new Map<string, string[]>();
    for (const task of tasks) indegree.set(task.tempId, 0);
    const addEdge = (from: string, to: string): void => {
      const list = successors.get(from) ?? [];
      list.push(to);
      successors.set(from, list);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    };
    for (const task of tasks) {
      if (task.parentTempId !== undefined && byTempId.has(task.parentTempId)) {
        addEdge(task.parentTempId, task.tempId);
      }
      for (const dep of task.blockedByTempIds) {
        if (byTempId.has(dep) && dep !== task.tempId) addEdge(dep, task.tempId);
      }
      if (task.alternativeOfTempId !== undefined && byTempId.has(task.alternativeOfTempId)) {
        // 备选先于主路径（边挂在备选上：alternative → primary）
        addEdge(task.alternativeOfTempId, task.tempId);
      }
    }
    const queue = tasks.filter((task) => (indegree.get(task.tempId) ?? 0) === 0).map((task) => task.tempId);
    const ordered: PlannedTask[] = [];
    while (queue.length > 0) {
      const tempId = queue.shift() as string;
      const task = byTempId.get(tempId);
      if (task !== undefined) ordered.push(task);
      for (const next of successors.get(tempId) ?? []) {
        indegree.set(next, (indegree.get(next) ?? 0) - 1);
        if ((indegree.get(next) ?? 0) === 0) queue.push(next);
      }
    }
    if (ordered.length !== tasks.length) {
      throw new TdaError('PLAN_NOT_TOPOLOGICAL', '计划任务无法代建序排序（合并图有成环，质量门③应已拒）');
    }
    return ordered;
  };

  /**
   * applyPlan / applyReplanDiff 的共同代建内核（J6/J8）：
   * 按代建序 create（父先子后、备选先于主路径）；中途失败已建保留 +
   * plan 落 cancelled+unfinished（C5 禁静默回滚半棵树）。
   */
  /**
   * 代建票据预检（J6 审批门）：**在 try 之外调用**——票据身份/重放/状态错误是
   * 调用方错误（如传错 ticket），不应把计划收口为 cancelled；只有代建过程中的
   * 失败（STALE/任务消失）才走 settleCancelled。
   */
  const verifyApplyTicket = (plan: TaskPlan, token: ResumeTicketLike): void => {
    verifyTicket(
      token,
      plan.id,
      plan.status,
      ['pending-approval'],
      `计划 ${plan.id} 非 pending-approval（${plan.status}），禁凭票代建`,
    );
    if (!plan.coverage.passed) {
      throw new TdaError('QUALITY_GATE_NOT_PASSED', `计划 ${plan.id} 质量门未过，禁代建`);
    }
  };

  const createTasksFromPlan = async (
    plan: TaskPlan,
    options: { onlyNew: boolean; baseMap: Record<string, string> },
  ): Promise<ApplyTasksOutcome> => {
    const tempToTaskId: Record<string, string> = { ...options.baseMap };
    const created: string[] = [];
    const edited: string[] = [];
    const skipped: string[] = [];

    // 预案 id 预分配（alternativeOf 边携带；携 contingencyId ⇒ 非 legacy）
    const contingencyIds = new Map<string, ContingencyId>();
    for (const task of plan.tasks) {
      if (task.alternativeOfTempId !== undefined && task.contingency !== undefined && !contingencyIds.has(task.tempId)) {
        contingencyIds.set(task.tempId, asContingencyId(allocateId(contingenciesTable(), 'cont')));
      }
    }

    const ordered = applyOrder(plan.tasks);
    for (const task of ordered) {
      const existingId = options.baseMap[task.tempId];
      if (existingId !== undefined) {
        if (!options.onlyNew) {
          throw new TdaError('TASK_ALREADY_APPLIED', `任务 ${task.tempId} 已代建（${existingId}），initial apply 禁重复`);
        }
        // replan diff：受影响任务才 edit（subject/blockedBy/priority 三类；禁 objective/completionCriteria）
        const live = deps.taskPool.get(existingId);
        if (live === undefined) {
          skipped.push(`${task.tempId}→${existingId}（任务不存在，跳过）`);
          continue;
        }
        const nextBlockedBy = task.blockedByTempIds
          .map((tempId) => tempToTaskId[tempId])
          .filter((id): id is string => id !== undefined);
        const wantsEdit =
          live.subject !== task.subject ||
          (task.priority !== undefined && live.priority !== task.priority) ||
          nextBlockedBy.join(',') !== [...live.blockedBy].sort().join(',');
        if (wantsEdit) {
          const updated = await deps.taskPool.edit(PLANNER_ACTOR, existingId, { expectedRevision: live.revision }, {
            subject: task.subject,
            ...(task.priority !== undefined ? { priority: task.priority } : {}),
            blockedBy: nextBlockedBy,
          });
          tempToTaskId[task.tempId] = updated.id;
          edited.push(updated.id);
        } else {
          skipped.push(`${task.tempId}→${existingId}（无差异，跳过）`);
        }
        continue;
      }
      const alternativeTarget = task.alternativeOfTempId !== undefined ? tempToTaskId[task.alternativeOfTempId] : undefined;
      const contingencyId = contingencyIds.get(task.tempId);
      const node = await deps.taskPool.create(PLANNER_ACTOR, {
        goalId: plan.goalId,
        subject: task.subject,
        ...(task.description !== undefined ? { description: task.description } : {}),
        ...(task.parentTempId !== undefined && tempToTaskId[task.parentTempId] !== undefined
          ? { parentTaskId: tempToTaskId[task.parentTempId] }
          : {}),
        ...(alternativeTarget !== undefined && contingencyId !== undefined
          ? { alternativeOf: { taskId: alternativeTarget, planId: plan.id, contingencyId } }
          : {}),
        blockedBy: task.blockedByTempIds
          .map((tempId) => tempToTaskId[tempId])
          .filter((id): id is string => id !== undefined),
        ...(task.localPath !== undefined ? { localPath: task.localPath } : {}),
        ...(task.writeScopes !== undefined ? { writeScopes: [...task.writeScopes] } : {}),
        ...(task.priority !== undefined ? { priority: task.priority } : {}),
        ...(task.budget !== undefined ? { budget: { ...task.budget } } : {}),
        planId: plan.id,
      });
      tempToTaskId[task.tempId] = node.id;
      created.push(node.id);
    }

    // 预案记录（dormant；primary=本任务，alternative=备选任务）
    for (const task of ordered) {
      if (task.alternativeOfTempId === undefined || task.contingency === undefined) continue;
      const contingencyId = contingencyIds.get(task.tempId);
      const primaryId = tempToTaskId[task.tempId];
      const alternativeId = tempToTaskId[task.alternativeOfTempId];
      if (contingencyId === undefined || primaryId === undefined || alternativeId === undefined) continue;
      const contingency: PlanContingency = {
        id: contingencyId,
        revision: 0,
        planId: plan.id,
        primaryTaskId: primaryId,
        alternativeTaskId: alternativeId,
        trigger: task.contingency.trigger,
        status: 'dormant',
        carveOut: task.contingency.carveOut,
      };
      await commit(contingency.id, contingencyPayload(contingency), async () => {
        await putContingency(contingency);
      });
    }

    return { created, edited, skipped, tempToTaskId };
  };

  /** applyPlan / applyReplanDiff 的失败收口（C5：已建保留 + plan cancelled+unfinished）。 */
  const settleCancelled = async (plan: TaskPlan, error: unknown): Promise<never> => {
    const message = error instanceof Error ? error.message : String(error);
    await commitPlan(plan, (draft) => ({
      ...draft,
      status: 'cancelled',
      unfinished: [`代建中断：${message}；已建任务保留，禁静默回滚半棵树`],
      settledAt: clock(),
    }));
    throw error;
  };

  /** 触发扫描本地实现（checkTriggers/runTriggerScan 共用；纯读 + 可选自动清理）。 */
  const scanTriggers = (at: number): readonly TriggerEvent[] => {
    const all = [...contingenciesTable().entries()].map(([, record]) => record);
    const tasks = new Map<string, TriggerEvalTask>();
    for (const contingency of all) {
      for (const taskId of [contingency.primaryTaskId, contingency.alternativeTaskId]) {
        if (tasks.has(taskId)) continue;
        const task = deps.taskPool.get(taskId);
        if (task !== undefined) {
          tasks.set(taskId, {
            id: task.id,
            phase: task.phase,
            outcome: task.outcome,
            zone: task.zone,
            consecutiveFailures: task.consecutiveFailures,
          });
        }
      }
    }
    return evaluateTriggers(all, tasks, readParams(), at);
  };

  return {
    async initialize() {
      return withLock(async () => {
        await seedParams();
      });
    },

    async proposePlan(goalId, inputs) {
      void inputs;
      return withLock(async () => {
        goalOf(goalId);
        return draftPlan(goalId, 'initial', undefined, undefined);
      });
    },

    qualityGate(planId) {
      const plan = mustPlan(planId);
      return runQualityGate(plan.tasks, plan.goalId);
    },

    async confirmRequest(actor, planId) {
      return withLock(async () => {
        void actor;
        const plan = mustPlan(planId);
        if (plan.status !== 'draft') {
          throw new TdaError('PLAN_NOT_DRAFT', `计划 ${planId} 非 draft（${plan.status}），禁重复提请`);
        }
        const fresh = runQualityGate(plan.tasks, plan.goalId);
        if (!fresh.passed) {
          throw new TdaError(
            'QUALITY_GATE_NOT_PASSED',
            `计划 ${planId} 质量门未过，禁提请：${fresh.checks.filter((item) => !item.passed).map((item) => item.detail).join('；')}`,
          );
        }
        const gated = plan.coverage.passed ? plan : await commitPlan(plan, (draft) => ({ ...draft, coverage: fresh }));
        const approval = await deps.supervision.request({
          kind: 'task-plan',
          requester: { service: PLANNER_TICKET_FROM, ref: planId },
          subject: `任务计划待批：${plan.tasks.length} 个任务（目标 ${plan.goalId}）`.slice(0, 120),
          whatToShow: {
            summary: `初始规划：${plan.tasks.length} 任务，质量门五查全过`,
            impact: [{ target: plan.goalId, change: 'create', reversible: true }],
            riskReasons: ['批量建任务=结构性动作（J6）'],
            evidence: [{ kind: 'plan', ref: planId }],
          },
          resume: { from: PLANNER_TICKET_FROM, handle: planId },
          goalId: plan.goalId,
        });
        await commitPlan(gated, (draft) => ({ ...draft, status: 'pending-approval' }));
        return { approvalId: approval.approvalId };
      });
    },

    async applyPlan(planId, token) {
      return withLock(async () => {
        const plan = mustPlan(planId);
        verifyApplyTicket(plan, token);
        let outcome: ApplyTasksOutcome | undefined;
        try {
          outcome = await createTasksFromPlan(plan, { onlyNew: false, baseMap: {} });
        } catch (error) {
          await settleCancelled(plan, error);
        }
        if (outcome === undefined) {
          throw new TdaError('APPLY_INTERRUPTED', `计划 ${planId} 代建中断且未收口（不应可达）`);
        }
        // appliedTaskIds 口径：**全部计划任务**的真实 id（replan 场景含复用旧任务）；
        // DiffReport.created 才是"本次新建"（两者语义不同，禁混用）。
        const appliedTaskIds = plan.tasks
          .map((task) => outcome.tempToTaskId[task.tempId])
          .filter((id): id is string => id !== undefined);
        await commitPlan(plan, (draft) => ({
          ...draft,
          status: 'applied',
          appliedTaskIds,
          tempToTaskId: { ...outcome.tempToTaskId },
          approval: { approvalId: token.approvalId, at: clock() },
          settledAt: clock(),
        }));
        return outcome.created;
      });
    },

    async replan(goalId, deviation) {
      return withLock(async () => {
        goalOf(goalId);
        const appliedPlans = [...plansTable().entries()]
          .map(([, record]) => record)
          .filter((record) => record.goalId === goalId && record.status === 'applied');
        const latest = appliedPlans.sort((left, right) => right.createdAt - left.createdAt)[0];
        if (latest === undefined) {
          throw new TdaError('NO_APPLIED_PLAN', `目标 ${goalId} 无 applied 计划，禁 replan（先 initial plan）`);
        }
        return draftPlan(goalId, 'replan', deviation, latest.id);
      });
    },

    async applyReplanDiff(planId, token) {
      return withLock(async () => {
        const plan = mustPlan(planId);
        verifyApplyTicket(plan, token);
        const previous = plan.supersedes !== undefined ? plansTable().get(plan.supersedes) : undefined;
        const baseMap = previous?.tempToTaskId ?? {};
        let outcome: ApplyTasksOutcome | undefined;
        try {
          outcome = await createTasksFromPlan(plan, { onlyNew: true, baseMap });
        } catch (error) {
          await settleCancelled(plan, error);
        }
        if (outcome === undefined) {
          throw new TdaError('APPLY_INTERRUPTED', `计划 ${planId} 代建中断且未收口（不应可达）`);
        }
        const appliedTaskIds = plan.tasks
          .map((task) => outcome.tempToTaskId[task.tempId])
          .filter((id): id is string => id !== undefined);
        await commitPlan(plan, (draft) => ({
          ...draft,
          status: 'applied',
          appliedTaskIds,
          tempToTaskId: { ...outcome.tempToTaskId },
          approval: { approvalId: token.approvalId, at: clock() },
          settledAt: clock(),
        }));
        // supersede 单向链：旧 applied → superseded（J8；只标记指针，不动已建任务）
        if (previous !== undefined && previous.status === 'applied') {
          await commitPlan(previous, (draft) => ({ ...draft, status: 'superseded', settledAt: clock() }));
        }
        return { planId, created: outcome.created, edited: outcome.edited, skipped: outcome.skipped };
      });
    },

    contingencies(planId) {
      const all = [...contingenciesTable().entries()].map(([, record]) => record);
      return planId === undefined ? all : all.filter((record) => record.planId === planId);
    },

    contingency(id) {
      return contingenciesTable().get(id);
    },

    checkTriggers(at) {
      return scanTriggers(at);
    },

    async runTriggerScan(at) {
      const events = scanTriggers(at);
      for (const event of events) {
        if (event.kind !== 'expire') continue;
        const contingency = contingenciesTable().get(event.contingencyId);
        if (contingency === undefined || contingency.status !== 'dormant') continue;
        // 自动清理（autoExpire）：只动 dormant→expired，禁触碰 triggered/activated
        await commitContingency(contingency, (draft) => ({
          ...draft,
          status: 'expired',
          reason: event.detail,
          resolvedAt: at,
        }));
      }
      return events;
    },

    async requestActivation(contingencyId) {
      return withLock(async () => {
        const contingency = mustContingency(contingencyId);
        if (contingency.status !== 'dormant') {
          throw new TdaError(
            'CONTINGENCY_NOT_DORMANT',
            `预案 ${contingencyId} 非 dormant（${contingency.status}），禁提请激活`,
          );
        }
        const approval = await deps.supervision.request({
          kind: 'plan-activation',
          requester: { service: PLANNER_TICKET_FROM, ref: contingencyId },
          subject: `预案激活待批：主路径 ${contingency.primaryTaskId} → 备选 ${contingency.alternativeTaskId}`.slice(0, 120),
          whatToShow: {
            summary: `触发条件满足，请求切换备选路径（carveOut=${contingency.carveOut}）`,
            impact: [
              { target: contingency.alternativeTaskId, change: 'update', reversible: true },
              { target: contingency.primaryTaskId, change: 'invalidate', reversible: true },
            ],
            riskReasons: ['结构性切换=人在场（J4 决策点⑤保守侧）'],
            evidence: [
              { kind: 'contingency', ref: contingencyId },
              { kind: 'plan', ref: contingency.planId },
            ],
          },
          resume: { from: PLANNER_TICKET_FROM, handle: contingencyId },
          taskId: contingency.primaryTaskId,
        });
        await commitContingency(contingency, (draft) => ({
          ...draft,
          status: 'triggered',
          triggeredAt: clock(),
        }));
        return { approvalId: approval.approvalId };
      });
    },

    async activate(contingencyId, token) {
      return withLock(async () => {
        const contingency = mustContingency(contingencyId);
        verifyTicket(
          token,
          contingencyId,
          contingency.status,
          ['triggered'],
          `预案 ${contingencyId} 非 triggered（${contingency.status}），禁凭票激活`,
        );
        // 切换四步（T4.5 §4.2；全程 CAS，任一步失败即抛——禁部分切换后静默继续）
        const alternative = deps.taskPool.get(contingency.alternativeTaskId);
        if (alternative === undefined) {
          throw new TdaError('ALTERNATIVE_TASK_NOT_FOUND', `备选任务不存在：${contingency.alternativeTaskId}`);
        }
        // ① 备选转 ready 候选（stage→planning；已是 planning 也做一次 CAS 记录切换意图）
        if (alternative.phase !== 'active' || alternative.stage !== 'planning') {
          await deps.taskPool.edit(PLANNER_ACTOR, alternative.id, { expectedRevision: alternative.revision }, {
            stage: 'planning',
          });
        }
        // ② 主路径 blocked[plan-b-activated]
        // 规格 §4.2 原样假设主路径仍活着；但 task-failed 触发时主路径已 failure 终态
        // （T0.2 终态不可变 ⇒ 禁 block，也无必要）。裁定：**已终态主路径跳过 block**
        // （它已是"让位"的事实结果），仅活着的主路径才打 blocked 标记。
        const primary = deps.taskPool.get(contingency.primaryTaskId);
        if (primary === undefined) {
          throw new TdaError('PRIMARY_TASK_NOT_FOUND', `主路径任务不存在：${contingency.primaryTaskId}`);
        }
        if (primary.phase !== 'complete') {
          await deps.taskPool.block(PLANNER_ACTOR, primary.id, { expectedRevision: primary.revision }, {
            code: 'plan-b-activated',
            message: `预案 ${contingencyId} 激活：主路径让位备选 ${contingency.alternativeTaskId}`,
          });
        }
        // ③ carve-out 转注：主路径未耗余额 × carveOut 加到备选帽
        const freshPrimary = deps.taskPool.get(primary.id);
        const freshAlternative = deps.taskPool.get(alternative.id);
        if (freshPrimary === undefined || freshAlternative === undefined) {
          throw new TdaError('TASK_VANISHED', '切换过程中任务消失（并发删除），显式失败');
        }
        const boost: TaskBudgetCaps = {};
        for (const dim of BUDGET_DIMS) {
          const cap = freshPrimary.budget.caps[dim];
          const consumed = freshPrimary.budget.consumed[dim];
          if (cap === undefined) continue;
          const remaining = Math.max(0, cap - (consumed ?? 0));
          if (remaining <= 0) continue;
          boost[dim] = (freshAlternative.budget.caps[dim] ?? 0) + Math.floor(remaining * contingency.carveOut);
        }
        if (Object.keys(boost).length > 0) {
          await deps.taskPool.edit(PLANNER_ACTOR, freshAlternative.id, { expectedRevision: freshAlternative.revision }, {
            budget: { ...freshAlternative.budget.caps, ...boost },
          });
        }
        // ④ contingency→activated 双写
        return commitContingency(contingency, (draft) => ({
          ...draft,
          status: 'activated',
          activationApprovalId: token.approvalId,
          resolvedAt: clock(),
        }));
      });
    },

    async veto(contingencyId, reason) {
      return withLock(async () => {
        if (reason.trim() === '') {
          throw new TdaError('VETO_REASON_REQUIRED', '否决必填 reason（显式终态）');
        }
        const contingency = mustContingency(contingencyId);
        if (contingency.status !== 'dormant' && contingency.status !== 'triggered') {
          throw new TdaError(
            'CONTINGENCY_NOT_VETOABLE',
            `预案 ${contingencyId} 非 dormant/triggered（${contingency.status}），禁否决`,
          );
        }
        return commitContingency(contingency, (draft) => ({
          ...draft,
          status: 'vetoed',
          reason,
          resolvedAt: clock(),
        }));
      });
    },

    plans(filter) {
      const all = [...plansTable().entries()].map(([, record]) => record);
      return all.filter(
        (record) =>
          (filter?.goalId === undefined || record.goalId === filter.goalId) &&
          (filter?.status === undefined || record.status === filter.status),
      );
    },

    plan(id) {
      return plansTable().get(id);
    },

    params() {
      return readParams();
    },

    async setParams(actor, patch) {
      return withLock(async () => {
        void actor;
        const current = readParams();
        const parsed = PlannerParamsSchema.parse({ ...current, ...patch, revision: current.revision + 1 });
        await commit(PLANNER_PARAMS_BUSINESS_ID, plannerParamsPayload(parsed), async () => {
          await paramsTable().put(PLANNER_PARAMS_KEY, parsed);
        });
        return parsed;
      });
    },
  };
}
