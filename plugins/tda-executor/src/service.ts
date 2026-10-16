/**
 * tda-executor 服务面（T4.1 §4.2 `ctx.executor`）。
 *
 * 硬纪律（全部在类型级或运行时强制）：
 *  - **零直写权威**：deps 只注入 taskPool/dispatch/workflow/supervision/goal/timeline
 *    的**服务方法**（seam 结构镜像），执行环不碰对方 domain；自有 domain 仅两表；
 *  - **CAS 优先**：fresh(attempt, ref) 先抛 STALE_REVISION 再判状态；任务侧 CAS 由
 *    taskPool 服务负责，STALE 即本轮跳过（重试责任在调用方，不静默）；
 *  - **显式终态**：重试帽尽/验证不过/重启孤儿 ⇒ failed+unfinished，禁静默；
 *  - **路由/选择确定性**：`routeTask`/`selectAttempts` 是导出纯函数（同输入同输出，
 *    单测逐分支；回放按 routerVersion+params 解释）；
 *  - **审批无自动过**：awaiting-approval 只凭一次性 ResumeTicket 推进；
 *  - **零注入直通**：deps 无 context/surface 句柄（编译期即无）。
 */
import {
  allocateId,
  asAttemptId,
  dualWrite,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  DEFAULT_EXECUTOR_PARAMS,
  EXECUTOR_PARAMS_BUSINESS_ID,
  EXECUTOR_PARAMS_KEY,
  ExecutorParamsSchema,
  type ExecutorAttempt,
  type ExecutorAttemptStatus,
  type ExecutorMode,
  type ExecutorParams,
  type ExecutorTables,
  type VerificationReport,
} from './domain.ts';
import { attemptPayload, executorParamsPayload } from './events.ts';

/** 执行环的固定 actor（J4：认领 owner 纪律——owner 恒为 scheduler 会话）。 */
export const EXECUTOR_ACTOR = 'scheduler';

/** 高风险任务的确定性判据（J5/T0.5 J9 同款）：writeScopes 超出 localPath。 */
export function isHighRiskTask(task: {
  readonly localPath?: string | undefined;
  readonly writeScopes: readonly string[];
}): boolean {
  if (task.writeScopes.length === 0) return false;
  if (task.localPath === undefined || task.localPath === '') return true;
  const root = task.localPath.endsWith('/') ? task.localPath : `${task.localPath}/`;
  return task.writeScopes.some((scope) => !scope.startsWith(root));
}

// ── 只读/受控写 seam（结构镜像：方法式声明获得参数双变性） ────────────────

export interface ExecutorTaskView {
  readonly id: string;
  readonly revision: number;
  readonly goalId: string;
  readonly subject: string;
  readonly phase: string;
  readonly stage: string;
  readonly ownerId?: string | undefined;
  readonly blockedBy: readonly string[];
  readonly priority: number;
  readonly zone: string;
  readonly runCount: number;
  readonly consecutiveFailures: number;
  readonly proposalStatus?: string | undefined;
  readonly dueAt?: number | undefined;
  readonly createdAt: number;
  readonly localPath?: string | undefined;
  readonly writeScopes: readonly string[];
}

export interface ExecutorTaskPoolSeam {
  ready(filter?: { goalId?: string; priorityMin?: number }): readonly ExecutorTaskView[];
  get(id: string): ExecutorTaskView | undefined;
  claim(actor: string, id: string, ref: { expectedRevision: number }, ownerId: string): Promise<ExecutorTaskView>;
  release(actor: string, id: string, ref: { expectedRevision: number }): Promise<ExecutorTaskView>;
  block(
    actor: string,
    id: string,
    ref: { expectedRevision: number },
    reason: { code: string; message: string },
  ): Promise<ExecutorTaskView>;
  complete(
    actor: string,
    id: string,
    ref: { expectedRevision: number },
    completion: {
      outcome: 'success' | 'failed';
      evidence?: readonly string[];
      unfinished?: readonly string[];
      notes?: string;
    },
  ): Promise<ExecutorTaskView>;
}

export interface ExecutorDispatchOrderView {
  readonly id: string;
  readonly taskId: string;
  readonly status: string;
}

export interface ExecutorDispatchSeam {
  /** 建单（不执行）：高风险单返回 requested（T0.5 J9 闸），其余 approved。 */
  dispatch(
    caller: { actor: string; sessionId: string },
    req: { taskId: string; role: 'sidekick' | 'lead'; note?: string },
  ): Promise<ExecutorDispatchOrderView & { revision: number }>;
  /** 驱动已批准单到 settle（adapter 内部 start+settle，取新 ref）。 */
  driveOrder(caller: { actor: string; sessionId: string }, orderId: string): Promise<ExecutorDispatchOrderView>;
  conclusionOf(orderId: string):
    | {
        readonly taskId: string;
        readonly role: string;
        readonly outcome: string;
        readonly findings: readonly string[];
        readonly confidence: number;
        readonly entryId?: string;
      }
    | undefined;
}

export interface ExecutorWorkflowDefView {
  readonly defId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
}

export interface ExecutorWorkflowRunView {
  readonly runId: string;
  readonly status: string;
  readonly outcome?: string;
  readonly unfinished?: readonly string[];
}

export interface ExecutorWorkflowSeam {
  definitions(filter?: { kind?: 'template' | 'instance'; status?: string }): readonly ExecutorWorkflowDefView[];
  start(
    actor: { sessionId: string; actor: string },
    defId: string,
    params: Record<string, unknown>,
    taskId: string,
  ): Promise<ExecutorWorkflowRunView>;
}

export interface ExecutorSupervisionSeam {
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
  pending(filter?: { kind?: string }): readonly { approvalId: string; kind: string; status: string }[];
}

export interface ExecutorGoalSeam {
  get(id: string): { id: string; completionCriteria: readonly string[] } | undefined;
}

export interface ExecutorTimelineSeam {
  get(id: string): unknown;
}

export interface ExecutorDeps {
  readonly domain: TdaDomain<ExecutorTables>;
  readonly session: TdaSessionSink;
  readonly taskPool: ExecutorTaskPoolSeam;
  readonly dispatch: ExecutorDispatchSeam;
  readonly workflow: ExecutorWorkflowSeam;
  readonly supervision: ExecutorSupervisionSeam;
  readonly goal: ExecutorGoalSeam;
  readonly timeline: ExecutorTimelineSeam;
  readonly ownerSessionId: string;
  readonly bootAt: number;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  /** 主任务活跃信号（J8 让位；装配层注入，v1 保守近似）。 */
  readonly isMainActive?: () => boolean;
  readonly config?: Partial<ExecutorParams>;
}

// ── 纯函数（路由/选择/验证判定） ────────────────────────────────────────

export interface RouteDecision {
  readonly mode: ExecutorMode;
  readonly modeReason: string;
  readonly defId?: string;
}

/**
 * 路由三模式（J3，确定性纯函数）：
 *  ① direct——stage=verifying 且目标完成标准含可机读 `entry:<id>` 断言（收尾型）；
 *  ② workflow——defs 中存在 name === task.subject 的定义。**调用方须预过滤**
 *     （`definitions({status:'consolidated'})`——T2.5 生命周期归治理域，WorkflowDefinition
 *     本身无 status 字段；v1 匹配启发式，planner 的 suggestedWorkflowDefId 落地后改精确匹配）；
 *  ③ dispatch——默认（T0.5 通道，brief 只从 task 记录构造）。
 */
export function routeTask(
  task: { readonly subject: string; readonly stage: string },
  defs: readonly ExecutorWorkflowDefView[],
  goalCriteria: readonly string[],
): RouteDecision {
  if (task.stage === 'verifying' && hasEntryCriteria(goalCriteria)) {
    return { mode: 'direct', modeReason: 'verify-closeout' };
  }
  const def = defs.find((candidate) => candidate.name === task.subject);
  if (def !== undefined) {
    return { mode: 'workflow', modeReason: `matched-def:${def.defId}`, defId: def.defId };
  }
  return { mode: 'dispatch', modeReason: 'no-def' };
}

/** 目标完成标准里的可机读断言：`entry:<entryId>`（direct 模式的确定性求值对象）。 */
export function entryCriteria(goalCriteria: readonly string[]): readonly string[] {
  return goalCriteria
    .filter((criterion) => criterion.startsWith('entry:'))
    .map((criterion) => criterion.slice('entry:'.length))
    .filter((id) => id !== '');
}

export function hasEntryCriteria(goalCriteria: readonly string[]): boolean {
  return entryCriteria(goalCriteria).length > 0;
}

export interface SelectOptions {
  readonly maxParallel: number;
  readonly inFlight: number;
  readonly isMainActive: boolean;
}

/**
 * 选取序（J3/选择序 pure）：ready 集 → 过滤（未认领/已批准/预算区/让位/并发帽）
 * → 排序（priority 降序 → dueAt 升序 → createdAt 升序，承 T0.2 dispatch 序）。
 */
export function selectAttempts(
  ready: readonly ExecutorTaskView[],
  options: SelectOptions,
): readonly ExecutorTaskView[] {
  if (options.isMainActive) return [];
  const capacity = Math.max(0, options.maxParallel - options.inFlight);
  if (capacity === 0) return [];
  return ready
    .filter((task) => task.ownerId === undefined)
    .filter((task) => task.zone !== 'exhausted')
    .filter((task) => task.proposalStatus !== 'pending_approval')
    .slice()
    .sort((left, right) => {
      if (left.priority !== right.priority) return right.priority - left.priority;
      const leftDue = left.dueAt ?? Number.MAX_SAFE_INTEGER;
      const rightDue = right.dueAt ?? Number.MAX_SAFE_INTEGER;
      if (leftDue !== rightDue) return leftDue - rightDue;
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })
    .slice(0, capacity);
}

// ── 服务实现 ────────────────────────────────────────────────────────────

export interface AttemptReport {
  readonly attemptId: string;
  readonly taskId: string;
  readonly mode: ExecutorMode;
  readonly status: ExecutorAttemptStatus;
  readonly outcome?: 'success' | 'failed';
  readonly skipped?: string;
}

export interface ResumeTicketLike {
  readonly approvalId: string;
  readonly nonce: string;
  readonly from: string;
  readonly handle: string;
}

export interface TaskExecutorService {
  initialize(): Promise<readonly string[]>;
  select(now: number): readonly ExecutorTaskView[];
  runOnce(now?: number): Promise<readonly AttemptReport[]>;
  resumeAttempt(attemptId: string, ticket: ResumeTicketLike): Promise<ExecutorAttempt>;
  retry(actor: 'human' | 'lead', attemptId: string, ref: { expectedRevision: number }): Promise<ExecutorAttempt>;
  attempts(filter?: { taskId?: string; status?: ExecutorAttemptStatus }): readonly ExecutorAttempt[];
  attempt(id: string): ExecutorAttempt | undefined;
  inFlight(): readonly ExecutorAttempt[];
  params(): ExecutorParams;
  setParams(actor: 'human' | 'lead', patch: Partial<Omit<ExecutorParams, 'revision'>>): Promise<ExecutorParams>;
  route(task: { subject: string; stage: string }, goalId: string): RouteDecision;
}

const IN_FLIGHT_STATUSES: readonly ExecutorAttemptStatus[] = ['executing', 'awaiting-approval', 'verifying'];
const PRE_BOOT_RECONCILE_STATUSES: readonly ExecutorAttemptStatus[] = [
  'selected',
  'claimed',
  'executing',
  'awaiting-approval',
  'verifying',
];

export function createExecutorService(deps: ExecutorDeps): TaskExecutorService {
  const now = deps.now ?? ((): number => Date.now());
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

  const attemptsTable = () => deps.domain.table('executor_attempts');
  const paramsTable = () => deps.domain.table('executor_params');

  const fresh = (id: string, ref: { expectedRevision: number }): ExecutorAttempt => {
    const current = attemptsTable().get(id);
    if (current === undefined) throw new TdaError('ATTEMPT_NOT_FOUND', `attempt 不存在：${id}`);
    if (current.revision !== ref.expectedRevision) {
      throw new TdaError('STALE_REVISION', `attempt ${id} revision 漂移（期望 ${ref.expectedRevision}，实为 ${current.revision}）`);
    }
    return current;
  };

  const putAttempt = async (attempt: ExecutorAttempt): Promise<void> => {
    await attemptsTable().put(attempt.id, attempt);
  };

  /** 统一出口：dualWrite（域+事件配对）后 bus.publish（纪律 #6）。 */
  const commit = async (
    businessId: string,
    payload: import('@tda/kernel').JsonObject,
    domainWrite: () => void | Promise<void>,
  ): Promise<number> => {
    const seq = await dualWrite(
      deps.session,
      { family: 'executor/change', businessId, payload, domainWrite },
      dualContext,
    );
    if (bus !== undefined) {
      bus.publish({
        family: 'executor/change',
        businessId,
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
    return seq;
  };

  const commitAttempt = async (
    current: ExecutorAttempt,
    mutate: (draft: ExecutorAttempt) => ExecutorAttempt,
  ): Promise<ExecutorAttempt> => {
    const next = mutate({ ...current, revision: current.revision + 1 });
    await commit(next.id, attemptPayload(next), async () => {
      await putAttempt(next);
    });
    return next;
  };

  const readParams = (): ExecutorParams => {
    const stored = paramsTable().get(EXECUTOR_PARAMS_KEY);
    if (stored !== undefined) return stored;
    return { ...DEFAULT_EXECUTOR_PARAMS, ...deps.config, revision: 0 };
  };

  const seedParams = async (): Promise<void> => {
    if (paramsTable().get(EXECUTOR_PARAMS_KEY) !== undefined) return;
    const params: ExecutorParams = { ...DEFAULT_EXECUTOR_PARAMS, ...deps.config, revision: 0 };
    await commit(EXECUTOR_PARAMS_BUSINESS_ID, executorParamsPayload(params), async () => {
      await paramsTable().put(EXECUTOR_PARAMS_KEY, params);
    });
  };

  const goalCriteriaOf = (goalId: string): readonly string[] => deps.goal.get(goalId)?.completionCriteria ?? [];

  /**
   * 完终态动作前重读任务（装配期教训：dispatch settle 的 consume 会把任务 revision
   * 推高，拿着 claim 时的旧 ref 去 complete/release 必撞 STALE_REVISION——插件门
   * 的假体不调 consume 所以不暴露，只有真装配现形，由 P4 集成门守住）。
   */
  const liveTask = (id: string): ExecutorTaskView => {
    const current = deps.taskPool.get(id);
    if (current === undefined) throw new TdaError('TASK_NOT_FOUND', `任务不存在：${id}`);
    return current;
  };

  const inFlightCount = (): number =>
    [...attemptsTable().entries()].filter(([, record]) => IN_FLIGHT_STATUSES.includes(record.status)).length;

  /** 驱动一种模式到结论落定；返回验证报告与证据引用（pending=审批挂起）。 */
  const drive = async (
    attempt: ExecutorAttempt,
    task: ExecutorTaskView,
  ): Promise<{ verification: VerificationReport; evidence: readonly string[]; pendingApprovalId?: string; updated: ExecutorAttempt }> => {
    if (attempt.mode === 'workflow') {
      const defId = attempt.defId;
      if (defId === undefined) throw new TdaError('EXECUTOR_ROUTE_BROKEN', 'workflow 模式缺 defId');
      const run = await deps.workflow.start(
        { sessionId: deps.ownerSessionId, actor: EXECUTOR_ACTOR },
        defId,
        { taskId: task.id },
        task.id,
      );
      const updated = await commitAttempt(attempt, (draft) => ({ ...draft, status: 'executing', runId: run.runId }));
      if (run.status === 'awaiting-approval') {
        return { verification: pendingVerification('workflow 审批节点等待人类决断'), evidence: [], updated };
      }
      const passed = run.status === 'completed';
      return {
        verification: {
          kind: 'workflow-contract',
          passed,
          detail: passed
            ? `run ${run.runId} completed（合同后置由 T2.5 校验器强制）`
            : `run ${run.runId} ${run.status}${run.outcome !== undefined ? `:${run.outcome}` : ''}`,
          evidenceEntryIds: [`workflow-run:${run.runId}`],
        },
        evidence: [`workflow-run:${run.runId}`],
        updated,
      };
    }
    if (attempt.mode === 'dispatch') {
      // 续跑（resumeAttempt 重入）：attempt 已携 orderId——既有单已被人类经
      // dispatch.approve 批准（approveAndResume 桥），直接驱动到 settle。
      if (attempt.orderId !== undefined) {
        const settled = await deps.dispatch.driveOrder(
          { actor: EXECUTOR_ACTOR, sessionId: deps.ownerSessionId },
          attempt.orderId,
        );
        const conclusion = deps.dispatch.conclusionOf(settled.id);
        const entryId = conclusion?.entryId;
        const passed = conclusion !== undefined && conclusion.outcome === 'conclusion' && entryId !== undefined;
        return {
          verification: {
            kind: 'evidence-check',
            passed,
            detail: passed
              ? `结论过 schema，entryId=${String(entryId)}`
              : `结论未过 schema 或缺 entryId（outcome=${String(conclusion?.outcome)}）`,
            evidenceEntryIds: entryId !== undefined ? [entryId] : [],
          },
          evidence: entryId !== undefined ? [entryId] : [],
          updated: attempt,
        };
      }
      const order = await deps.dispatch.dispatch(
        { actor: EXECUTOR_ACTOR, sessionId: deps.ownerSessionId },
        { taskId: task.id, role: 'sidekick' },
      );
      const updated = await commitAttempt(attempt, (draft) => ({ ...draft, status: 'executing', orderId: order.id }));
      if (order.status === 'requested') {
        // 高风险派发单待批（T0.5 J9 闸，执行环不预检——单点审批收敛在 dispatch 层）：
        // 登记监督请求并挂起（J7），凭 ResumeTicket 续跑。
        const approval = await deps.supervision.request({
          kind: 'dispatch',
          requester: { service: 'ctx.executor', ref: attempt.id },
          subject: `高风险派发待批：${task.subject}`.slice(0, 120),
          whatToShow: {
            summary: `派发单 ${order.id} 高风险待批（T0.5 J9）`,
            impact: [{ target: order.id, change: 'execute', reversible: true }],
            riskReasons: ['T0.5 J9 高风险派发门（writeScopes 超出 localPath 等）'],
            evidence: [
              { kind: 'dispatch-order', ref: order.id },
              { kind: 'task', ref: task.id },
            ],
          },
          resume: { from: 'ctx.executor', handle: attempt.id },
          taskId: task.id,
          goalId: task.goalId,
        });
        return { verification: pendingVerification('dispatch 高风险待批'), evidence: [], pendingApprovalId: approval.approvalId, updated };
      }
      const settled = await deps.dispatch.driveOrder(
        { actor: EXECUTOR_ACTOR, sessionId: deps.ownerSessionId },
        order.id,
      );
      const conclusion = deps.dispatch.conclusionOf(settled.id);
      const entryId = conclusion?.entryId;
      const passed = conclusion !== undefined && conclusion.outcome === 'conclusion' && entryId !== undefined;
      return {
        verification: {
          kind: 'evidence-check',
          passed,
          detail: passed
            ? `结论过 schema，entryId=${String(entryId)}`
            : `结论未过 schema 或缺 entryId（outcome=${String(conclusion?.outcome)}）`,
          evidenceEntryIds: entryId !== undefined ? [entryId] : [],
        },
        evidence: entryId !== undefined ? [entryId] : [],
        updated,
      };
    }
    // direct：目标完成标准的 entry:<id> 断言确定性求值（U3：v1 仅此一种收尾）。
    const criteria = entryCriteria(goalCriteriaOf(task.goalId));
    const resolved = criteria.filter((entryId) => deps.timeline.get(entryId) !== undefined);
    const passed = criteria.length > 0 && resolved.length === criteria.length;
    return {
      verification: {
        kind: 'evidence-check',
        passed,
        detail: passed
          ? `完成标准 ${criteria.length} 条 entry 断言全部在场`
          : `完成标准 entry 断言缺席 ${criteria.length - resolved.length}/${criteria.length}`,
        evidenceEntryIds: resolved,
      },
      evidence: resolved,
      updated: attempt,
    };
  };

  /** 从 claimed 驱动到终态（含重试帽与审批挂起）。 */
  const driveToTerminal = async (attempt: ExecutorAttempt, task: ExecutorTaskView): Promise<AttemptReport> => {
    let current = attempt;
    for (;;) {
      let outcome;
      try {
        outcome = await drive(current, task);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'DISPATCH_QUEUED') {
          // 派发并发帽满：放弃本轮——释放认领（回 ready）+ attempt 显式终态，留待下轮 pump 后重选。
          // 遗弃的排队单由 dispatch 自身生命周期收敛（v1 已知噪音，见 T4.1 未决项）。
          await deps.taskPool.release(EXECUTOR_ACTOR, task.id, { expectedRevision: liveTask(task.id).revision });
          const cancelled = await commitAttempt(current, (draft) => ({
            ...draft,
            status: 'cancelled',
            unfinished: ['dispatch-queued：派发并发帽已满，留待下轮 pump 排空后重选'],
            settledAt: now(),
          }));
          return {
            attemptId: cancelled.id,
            taskId: cancelled.taskId,
            mode: cancelled.mode,
            status: 'cancelled',
            skipped: 'DISPATCH_QUEUED',
          };
        }
        throw error;
      }
      current = outcome.updated;
      if (outcome.pendingApprovalId !== undefined) {
        const parked = await commitAttempt(current, (draft) => ({
          ...draft,
          status: 'awaiting-approval',
          approvalId: outcome.pendingApprovalId,
        }));
        return { attemptId: parked.id, taskId: parked.taskId, mode: parked.mode, status: 'awaiting-approval' };
      }
      const verifying = await commitAttempt(current, (draft) => ({
        ...draft,
        status: 'verifying',
        verification: outcome.verification,
      }));
      current = verifying;
      if (outcome.verification.passed) {
        await deps.taskPool.complete(
          EXECUTOR_ACTOR,
          task.id,
          { expectedRevision: liveTask(task.id).revision },
          { outcome: 'success', evidence: outcome.evidence },
        );
        const done = await commitAttempt(current, (draft) => ({
          ...draft,
          status: 'completed',
          outcome: 'success',
          settledAt: now(),
        }));
        return { attemptId: done.id, taskId: done.taskId, mode: done.mode, status: 'completed', outcome: 'success' };
      }
      // 验证不过：重试帽内重驱（J6）；超帽显式终态（C5）。
      if (current.attempts <= readParams().maxRetries) {
        // 重试=全新执行：清 orderId/runId，下轮 drive 建新单（resume 才复用既有已批单）
        current = await commitAttempt(current, (draft) => ({
          ...draft,
          status: 'claimed',
          attempts: draft.attempts + 1,
          verification: undefined,
          orderId: undefined,
          runId: undefined,
        }));
        continue;
      }
      const unfinished = [`验证不过：${outcome.verification.detail}`];
      await deps.taskPool.complete(
        EXECUTOR_ACTOR,
        task.id,
        { expectedRevision: liveTask(task.id).revision },
        { outcome: 'failed', unfinished },
      );
      const failed = await commitAttempt(current, (draft) => ({
        ...draft,
        status: 'failed',
        outcome: 'failed',
        unfinished,
        settledAt: now(),
      }));
      return { attemptId: failed.id, taskId: failed.taskId, mode: failed.mode, status: 'failed', outcome: 'failed' };
    }
  };

  const driveTask = async (task: ExecutorTaskView): Promise<AttemptReport> => {
    const claimed = await deps.taskPool.claim(
      EXECUTOR_ACTOR,
      task.id,
      { expectedRevision: task.revision },
      deps.ownerSessionId,
    );
    const route = routeTask(claimed, deps.workflow.definitions({ status: 'consolidated' }), goalCriteriaOf(claimed.goalId)); // 调用方预过滤（T2.5 生命周期在治理域）
    const id = asAttemptId(allocateId(attemptsTable(), 'exec'));
    const attempt: ExecutorAttempt = {
      id,
      revision: 0,
      taskId: claimed.id,
      goalId: claimed.goalId,
      mode: route.mode,
      modeReason: route.modeReason,
      ...(route.defId !== undefined ? { defId: route.defId } : {}),
      status: 'claimed',
      attempts: 1,
      ownerId: deps.ownerSessionId,
      createdAt: now(),
    };
    const seeded = await commitAttempt(attempt, (draft) => draft);
    // 高风险任务的审批收敛在 dispatch 层闸（T0.5 J9）——执行环不预检，
    // 避免"任务级 + 派发级"双审批；判据同源（isHighRiskTask 保留供复用/审计）。
    return driveToTerminal(seeded, claimed);
  };

  return {
    async initialize() {
      return withLock(async () => {
        await seedParams();
        const reconciled: string[] = [];
        for (const [, record] of attemptsTable().entries()) {
          if (record.createdAt >= deps.bootAt) continue;
          if (!PRE_BOOT_RECONCILE_STATUSES.includes(record.status)) continue;
          const unfinished = [`executor-restart：boot 前在飞 attempt（${record.status}）由 resume 收口为显式终态`];
          const next: ExecutorAttempt = {
            ...record,
            revision: record.revision + 1,
            status: 'failed',
            outcome: 'failed',
            unfinished,
            settledAt: deps.bootAt,
          };
          await commit(next.id, attemptPayload(next), async () => {
            await putAttempt(next);
          });
          reconciled.push(next.id);
        }
        return reconciled;
      });
    },

    select(at) {
      void at;
      const params = readParams();
      return selectAttempts(deps.taskPool.ready(), {
        maxParallel: params.maxParallel,
        inFlight: inFlightCount(),
        isMainActive: deps.isMainActive?.() ?? false,
      });
    },

    async runOnce(at) {
      void at;
      return withLock(async () => {
        const params = readParams();
        if (deps.isMainActive?.() === true) return [];
        const reports: AttemptReport[] = [];
        for (const task of selectAttempts(deps.taskPool.ready(), {
          maxParallel: params.maxParallel,
          inFlight: inFlightCount(),
          isMainActive: false,
        })) {
          try {
            reports.push(await driveTask(task));
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'STALE_REVISION') {
              reports.push({ attemptId: '-', taskId: task.id, mode: 'dispatch', status: 'claimed', skipped: code });
              continue;
            }
            throw error; // 非预期失败照抛（fail-loud，由 daemon 记录）
          }
        }
        return reports;
      });
    },

    async resumeAttempt(attemptId, ticket) {
      return withLock(async () => {
        const current = attemptsTable().get(attemptId);
        if (current === undefined) throw new TdaError('ATTEMPT_NOT_FOUND', `attempt 不存在：${attemptId}`);
        // ticket 身份与重放先拦（重放=攻击信号，先于状态检查，避免状态泄漏）
        if (ticket.from !== 'ctx.executor' || ticket.handle !== attemptId) {
          throw new TdaError('RESUME_TICKET_MISMATCH', `ResumeTicket 不指向本 attempt（from=${ticket.from}, handle=${ticket.handle}）`);
        }
        if (consumedTickets.has(ticket.nonce)) {
          throw new TdaError('RESUME_TICKET_REPLAY', 'ResumeTicket nonce 已消费（一次性）');
        }
        if (current.approvalId !== undefined && ticket.approvalId !== current.approvalId) {
          throw new TdaError('RESUME_TICKET_MISMATCH', 'ResumeTicket 的 approvalId 与 attempt 登记不符');
        }
        if (current.status !== 'awaiting-approval') {
          throw new TdaError('ATTEMPT_NOT_AWAITING', `attempt ${attemptId} 非 awaiting-approval（${current.status}），禁凭票续跑`);
        }
        consumedTickets.add(ticket.nonce);
        const resumed = await commitAttempt(current, (draft) => ({
          ...draft,
          status: 'claimed',
          approvalId: undefined,
          verification: undefined,
        }));
        const task = deps.taskPool.get(resumed.taskId);
        if (task === undefined) {
          throw new TdaError('TASK_NOT_FOUND', `attempt 挂靠任务不存在：${resumed.taskId}`);
        }
        await driveToTerminal(resumed, task);
        const final = attemptsTable().get(attemptId);
        return final ?? resumed;
      });
    },

    async retry(actor, attemptId, ref) {
      void actor;
      return withLock(async () => {
        const current = fresh(attemptId, ref);
        if (!['failed', 'blocked', 'cancelled'].includes(current.status)) {
          throw new TdaError('INVALID_TRANSITION', `仅终态 attempt 可人工重试（当前 ${current.status}）`);
        }
        return commitAttempt(current, (draft) => ({
          ...draft,
          status: 'claimed',
          outcome: undefined,
          unfinished: undefined,
          verification: undefined,
          settledAt: undefined,
          attempts: draft.attempts + 1,
        }));
      });
    },

    attempts(filter) {
      const all = [...attemptsTable().entries()].map(([, record]) => record);
      return all
        .filter((record) => filter?.taskId === undefined || record.taskId === filter.taskId)
        .filter((record) => filter?.status === undefined || record.status === filter.status);
    },

    attempt(id) {
      return attemptsTable().get(id);
    },

    inFlight() {
      return [...attemptsTable().entries()]
        .map(([, record]) => record)
        .filter((record) => IN_FLIGHT_STATUSES.includes(record.status));
    },

    params() {
      return readParams();
    },

    async setParams(actor, patch) {
      void actor;
      return withLock(async () => {
        const current = readParams();
        const merged: ExecutorParams = {
          ...current,
          ...patch,
          selectionPolicy: 'priority-due',
          revision: current.revision + 1,
        };
        const parsed = ExecutorParamsSchema.safeParse(merged);
        if (!parsed.success) {
          throw new TdaError(
            'EXECUTOR_PARAMS_INVALID',
            `params 非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`,
          );
        }
        const next = parsed.data;
        await commit(EXECUTOR_PARAMS_BUSINESS_ID, executorParamsPayload(next), async () => {
          await paramsTable().put(EXECUTOR_PARAMS_KEY, next);
        });
        return next;
      });
    },

    route(task, goalId) {
      return routeTask(task, deps.workflow.definitions({ status: 'consolidated' }), goalCriteriaOf(goalId));
    },
  };
}

function pendingVerification(detail: string): VerificationReport {
  return { kind: 'evidence-check', passed: false, detail, evidenceEntryIds: [] };
}
