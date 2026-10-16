/**
 * tda-task-pool 服务：ctx.taskPool 服务面实现（T0.2 §4.2）。
 *
 * 相对规格签名的必要强化（与 tda-goal-state 同款纪律，不变量驱动）：
 *  1. 所有 mutation 带 TaskRef（expectedRevision）——不变量 4"CAS 严格"；
 *  2. 所有 mutation 带 actor——task_history"变更者"列必要；
 *  3. `reassign` 增 actor 参数——不变量 6"仅人类/Lead 强制改派"需可判；
 *  4. 跨插件耦合只经注入 seam（`goalLookup`）与事件总线（`bus`），
 *     不 import 任何插件内部模块（方案 §2.1 依赖倒置）。
 *
 * 进程内互斥锁：consume 的祖先汇聚 + 作用域预算检查是复合写，锁保证复合 op
 * 期间无其他服务写交错（锁外直写 domain 属注入场景，由不变量门捕获）。
 *
 * 与规格 §5 的一处有意偏差（记账路径）：账本向上汇聚由本服务在提交后经
 * `goalLookup.consume` **服务面直调**，而非让 goal-state 订阅事件再反向累计——
 * 事件载荷是全快照而非增量，订阅方需自建"上次已计"投影，重启/回放窗口内有
 * 重复计数风险（违反 J7 守恒的确定性）。事件订阅仍保留，用于**幂等的**目标
 * stage 推进（见 tda-goal-state 订阅面）。
 */
import {
  allocateId,
  cas,
  dualWrite,
  StaleRevisionError,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type GoalId,
  type Revision,
  type SessionId,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
  type TaskId,
} from '@tda/kernel';
import {
  TASK_BUDGET_DIMS,
  ZERO_CONSUMED,
  capsOf,
  remainingOf,
  zoneOfCaps,
  type TaskActor,
  type TaskAlternativeOf,
  type TaskBlockedReason,
  type TaskBudget,
  type TaskBudgetCaps,
  type TaskConsumed,
  type TaskChangeRecord,
  type TaskNode,
  type TaskOperation,
  type TaskOutcome,
  type TaskPhase,
  type TaskProposal,
  type TaskRecurrence,
  type TaskRunRecord,
  type TaskSchedule,
  type TaskStage,
  type TaskTables,
  type TaskZone,
} from './domain.ts';
import { nextRecurrenceAfter } from './cron.ts';
import { taskChangePayload } from './events.ts';

/**
 * 目标层只读视图（结构镜像 tda-goal-state 的 GoalNode，窄化为任务池所需字段）。
 * 方法式声明（非属性式）以获得参数双变性——goal-state 的 `get(id: GoalId)`
 * 可直接装配，无需包装（跨插件零 import）。
 *
 * 可选字段显式写 `| undefined`：生产方 GoalNode 由 zod `.optional()` 推导，
 * 形态是 `T | undefined`；在 exactOptionalPropertyTypes 下 `tokens?: number`
 * 会拒绝该形态。镜像必须在"无该字段"与"字段为 undefined"两种形态上都可赋值。
 */
export interface GoalBudgetView {
  readonly tokens?: number | undefined;
  readonly wallClockMs?: number | undefined;
  readonly attentionUnits?: number | undefined;
  readonly consumed: { readonly tokens: number; readonly wallClockMs: number; readonly attentionUnits: number };
}

export interface GoalView {
  readonly id: string;
  readonly revision: number;
  readonly phase: TaskPhase;
  readonly budget: GoalBudgetView;
  readonly clearedAt?: number | undefined;
}

export interface GoalUsageLike {
  readonly tokens?: number;
  readonly wallClockMs?: number;
  readonly attentionUnits?: number;
}

export interface GoalRefLike {
  readonly expectedRevision: Revision;
}

/** 目标层 seam（由装配方注入 ctx.goalTree；未装配时相关检查降级，见各方法注释）。 */
export interface GoalLookup {
  get(id: string): GoalView | undefined;
  consume(actor: TaskActor, id: string, ref: GoalRefLike, usage: GoalUsageLike): Promise<unknown>;
  /** 焦点目标 id（`task:state` 注入区裁剪依据）；缺省则注入全部 ready/executing。 */
  focusGoalId?(): string | undefined;
}

export interface TaskRef {
  readonly expectedRevision: Revision;
}

export interface CreateTaskRequest {
  readonly goalId: GoalId;
  readonly subject: string;
  readonly description?: string;
  readonly parentTaskId?: TaskId;
  readonly alternativeOf?: TaskAlternativeOf;
  /** P4（T4.5 §3.4 v2）：规划溯源（planner 代建任务带 planId；T0.2 加载期断言对偶）。 */
  readonly planId?: string;
  /** 执行依赖 DAG 边（无环、禁引用 tombstone）。 */
  readonly blockedBy?: readonly TaskId[];
  /** 任务本地路径（workspace 相对，T0.6 扫描起点）。 */
  readonly localPath?: string;
  readonly writeScopes?: readonly string[];
  readonly priority?: number;
  readonly schedule?: TaskSchedule;
  readonly recurrence?: TaskRecurrence;
  /** 预算帽；缺省继承父任务帽，无父则继承目标帽（不变量 7 仍强制）。 */
  readonly budget?: TaskBudgetCaps;
  readonly progress?: string;
}

export interface EditTaskRequest {
  readonly subject?: string;
  readonly description?: string;
  readonly priority?: number;
  readonly localPath?: string;
  readonly writeScopes?: readonly string[];
  readonly schedule?: TaskSchedule;
  /** 传 null 显式清除周期（转一次性任务）。 */
  readonly recurrence?: TaskRecurrence | null;
  readonly blockedBy?: readonly TaskId[];
  readonly budget?: TaskBudgetCaps;
  /** 仅 active phase 可设（§2.2）：waiting 用于依赖未满足的显式等待。 */
  readonly stage?: TaskStage;
  readonly progress?: string;
}

export interface TaskCompletion {
  readonly outcome: TaskOutcome;
  /** 完成证据（T0.1 J4 目标 verifying 的汇聚输入）。 */
  readonly evidence?: readonly string[];
  /** 未完成清单（zone=exhausted 时必填，C5）。 */
  readonly unfinished?: readonly string[];
  readonly notes?: string;
}

export interface RunCompletion {
  readonly outcome: TaskOutcome;
  /** 本 run 独立预算窗口的消耗。 */
  readonly consumed?: Partial<TaskConsumed>;
  readonly notes?: string;
}

export interface ConsumedUsage {
  readonly tokens?: number;
  readonly toolCalls?: number;
  readonly wallClockMs?: number;
  readonly attentionUnits?: number;
}

export interface TaskListFilter {
  readonly goalId?: GoalId;
  readonly phase?: TaskPhase;
  readonly stage?: TaskStage;
  readonly ownerId?: SessionId;
  readonly parentTaskId?: TaskId;
  readonly proposalStatus?: TaskProposal['status'];
  readonly priorityMin?: number;
  /** 默认 false：tombstone 不占活跃容量。 */
  readonly includeDeleted?: boolean;
}

/** `task:state` 注入区裁剪视图项（T0.2 §5：主上下文只留决策与编排）。 */
export interface TaskView {
  readonly id: string;
  readonly subject: string;
  readonly stage: TaskStage;
  readonly ownerId?: string;
  readonly priority: number;
  readonly dueAt?: number;
  readonly nextDueAt?: number;
  readonly zone: TaskZone;
  readonly ready: boolean;
}

export interface TaskPoolSection {
  readonly id: 'task:state';
  readonly order: { readonly after: 'goal:state' };
  readonly content: string;
}

export interface ScopeWarning {
  readonly goalId: string;
  readonly a: string;
  readonly b: string;
  readonly prefix: string;
}

export interface TaskPoolService {
  create(actor: TaskActor, req: CreateTaskRequest): Promise<TaskNode>;
  edit(actor: TaskActor, id: TaskId, ref: TaskRef, req: EditTaskRequest): Promise<TaskNode>;
  claim(actor: TaskActor, id: TaskId, ref: TaskRef, ownerId: SessionId): Promise<TaskNode>;
  release(actor: TaskActor, id: TaskId, ref: TaskRef): Promise<TaskNode>;
  reassign(actor: TaskActor, id: TaskId, ref: TaskRef, ownerId: SessionId): Promise<TaskNode>;
  block(actor: TaskActor, id: TaskId, ref: TaskRef, reason: TaskBlockedReason): Promise<TaskNode>;
  resume(actor: TaskActor, id: TaskId, ref: TaskRef): Promise<TaskNode>;
  pause(actor: TaskActor, id: TaskId, ref: TaskRef): Promise<TaskNode>;
  complete(actor: TaskActor, id: TaskId, ref: TaskRef, completion: TaskCompletion): Promise<TaskNode>;
  delete(actor: TaskActor, id: TaskId, ref: TaskRef, reason: string): Promise<TaskNode>;
  consume(actor: TaskActor, id: TaskId, ref: TaskRef, usage: ConsumedUsage): Promise<TaskNode>;
  get(id: TaskId): TaskNode | undefined;
  list(filter?: TaskListFilter): TaskNode[];
  ready(filter?: TaskListFilter): TaskNode[];
  runs(id: TaskId): readonly TaskRunRecord[];
  history(id: TaskId): readonly TaskChangeRecord[];
  due(now: number): TaskNode[];
  startRun(actor: TaskActor, id: TaskId, ref: TaskRef, ownerId: SessionId): Promise<TaskNode>;
  completeRun(actor: TaskActor, id: TaskId, ref: TaskRef, run: RunCompletion): Promise<TaskNode>;
  propose(actor: TaskActor, req: CreateTaskRequest): Promise<TaskNode>;
  approveProposal(actor: TaskActor, id: TaskId, ref: TaskRef, approve: boolean, reason?: string): Promise<TaskNode>;
  /** 目标 verifying 前置：该目标下存在未终态任务即抛。 */
  assertSettled(goalId: GoalId): void;
  promptSection(): TaskPoolSection;
  writeScopeWarnings(filter?: TaskListFilter): readonly ScopeWarning[];
}

export interface TaskPoolDeps {
  readonly domain: TdaDomain<TaskTables>;
  readonly session: TdaSessionSink;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly goalLookup?: GoalLookup;
  /** 可注入时钟（周期/预算测试的确定性来源）；缺省 Date.now。 */
  readonly now?: () => number;
}

const ZERO_CAPS: TaskBudgetCaps = {};

const usageRecord = (usage: ConsumedUsage): TaskConsumed => ({
  tokens: usage.tokens ?? 0,
  toolCalls: usage.toolCalls ?? 0,
  wallClockMs: usage.wallClockMs ?? 0,
  attentionUnits: usage.attentionUnits ?? 0,
});

const addConsumed = (consumed: TaskConsumed, delta: TaskConsumed): TaskConsumed => ({
  tokens: consumed.tokens + delta.tokens,
  toolCalls: consumed.toolCalls + delta.toolCalls,
  wallClockMs: consumed.wallClockMs + delta.wallClockMs,
  attentionUnits: consumed.attentionUnits + delta.attentionUnits,
});

const hasUsage = (usage: TaskConsumed): boolean =>
  usage.tokens !== 0 || usage.toolCalls !== 0 || usage.wallClockMs !== 0 || usage.attentionUnits !== 0;

/** 任务本地路径规范化（不变量 8）：workspace 相对前缀，禁逃逸与绝对路径。 */
export function normalizeWorkspacePath(raw: string, field: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new TdaError('UNSAFE_PATH', `${field} 不得为空`);
  }
  if (/^[A-Za-z]:/.test(trimmed) || /^[\\/]/.test(trimmed)) {
    throw new TdaError('UNSAFE_PATH', `${field} 不得为绝对路径：${raw}`);
  }
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) {
    throw new TdaError('UNSAFE_PATH', `${field} 未含有效路径段：${raw}`);
  }
  if (segments.includes('..')) {
    throw new TdaError('UNSAFE_PATH', `${field} 不得含 .. 逃逸段：${raw}`);
  }
  return segments.join('/');
}

const renderView = (view: TaskView): string => {
  const parts = [`${view.id} [active/${view.stage}]`];
  parts.push(`owner=${view.ownerId ?? '未认领'}`);
  parts.push(`pri=${view.priority}`);
  parts.push(`zone=${view.zone}`);
  const due = view.nextDueAt ?? view.dueAt;
  if (due !== undefined) parts.push(`due=${new Date(due).toISOString()}`);
  if (view.ready) parts.push('可认领');
  return `- ${parts.join(' ')} 「${view.subject}」`;
};

export function createTaskPoolService(deps: TaskPoolDeps): TaskPoolService {
  const tasks = deps.domain.table('task_nodes');
  const history = deps.domain.table('task_history');
  const runs = deps.domain.table('task_runs');
  const clock = deps.now ?? ((): number => Date.now());
  const goalLookup = deps.goalLookup;

  const context: DualWriteContext = {
    ...(deps.reconciler ? { reconciler: deps.reconciler } : {}),
    ...(deps.index ? { index: deps.index } : {}),
  };

  // 进程内互斥锁：复合写（consume 汇聚 / 预算双方向检查 / startRun 开窗）原子化
  let lock: Promise<unknown> = Promise.resolve();
  const withLock = async <T>(op: () => Promise<T>): Promise<T> => {
    const result = lock.then(op, op);
    lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const mustGet = (id: TaskId): TaskNode => {
    const node = tasks.get(id);
    if (node === undefined) {
      throw new TdaError('TASK_NOT_FOUND', `任务不存在：${id}`);
    }
    return node;
  };

  const alive = (node: TaskNode): boolean => node.deletedAt === undefined;

  /**
   * CAS 前置：期望修订号不匹配即抛 STALE_REVISION——**先于一切状态判据**。
   * 理由（不变量 4 + 验收 3）：并发调用的后者持有过期视图，报"状态不可认领"
   * 会掩盖真实原因（并发覆写），也让"恰好一个成功 + 一个 STALE"无法成立。
   */
  const fresh = (node: TaskNode, ref: TaskRef): TaskNode => {
    if (node.revision !== ref.expectedRevision) {
      throw new StaleRevisionError(node.id, ref.expectedRevision, node.revision);
    }
    return node;
  };

  /** 终态不可变：tombstone 与 complete 均拒绝再变更（显式终态原则）。 */
  const assertNotTerminal = (node: TaskNode): void => {
    if (node.deletedAt !== undefined) {
      throw new TdaError('TASK_DELETED', `任务 ${node.id} 已 delete（tombstone 不可变）`);
    }
    if (node.phase === 'complete') {
      throw new TdaError('TASK_COMPLETE', `任务 ${node.id} 已 complete（终态不可变）`);
    }
  };

  const assertPhaseTransition = (
    from: TaskNode,
    to: 'paused' | 'blocked' | 'active' | 'complete',
  ): void => {
    const ok =
      (to === 'paused' && from.phase === 'active') ||
      (to === 'blocked' && from.phase === 'active') ||
      (to === 'active' && (from.phase === 'paused' || from.phase === 'blocked')) ||
      (to === 'complete' && from.phase === 'active');
    if (!ok) {
      throw new TdaError(
        'INVALID_TRANSITION',
        `任务 ${from.id} 不允许 ${from.phase} → ${to}（pause/block 仅自 active；resume 自 paused/blocked；complete 仅自 active）`,
      );
    }
  };

  /** 预算冻结字段（帽）：zone 由帽 + 账本重算，杜绝手工写入漂移。 */
  const withZone = (caps: TaskBudgetCaps, consumed: TaskConsumed): TaskBudget => ({
    ...caps,
    consumed,
    zone: zoneOfCaps(caps, consumed),
  });

  const openRunOf = (id: TaskId): TaskRunRecord | undefined => {
    let open: TaskRunRecord | undefined;
    for (const [, record] of runs.entries()) {
      if (record.taskId !== id || record.completedAt !== undefined) continue;
      if (open !== undefined) {
        throw new TdaError('TASK_RUN_AMBIGUOUS', `任务 ${id} 存在多个未收尾 run（run 窗口必须单一）`);
      }
      open = record;
    }
    return open;
  };

  const childrenOf = (id: TaskId): TaskNode[] => {
    const out: TaskNode[] = [];
    for (const [, node] of tasks.entries()) {
      if (alive(node) && node.parentTaskId === id) out.push(node);
    }
    return out;
  };

  const rootTasksOfGoal = (goalId: string): TaskNode[] => {
    const out: TaskNode[] = [];
    for (const [, node] of tasks.entries()) {
      if (alive(node) && node.parentTaskId === undefined && node.goalId === goalId) out.push(node);
    }
    return out;
  };

  const ancestorsOf = (node: TaskNode): TaskNode[] => {
    const chain: TaskNode[] = [];
    let cursor = node.parentTaskId;
    const seen = new Set<string>([node.id]);
    while (cursor !== undefined) {
      if (seen.has(cursor)) break; // 环由不变量门捕获；此处防御性终止
      seen.add(cursor);
      const parent = tasks.get(cursor as TaskId);
      if (parent === undefined) break;
      chain.push(parent);
      cursor = parent.parentTaskId;
    }
    return chain;
  };

  /**
   * 不变量 7（分配时检查，双方向）：
   *  - 对上：新帽 + 既有兄弟帽之和 ≤ 作用域剩余（帽 − 已耗，逐维）；
   *  - 对下：收紧自帽时不得低于既有子任务帽之和。
   */
  const assertScopeConservation = (
    scope: TaskNode | undefined,
    goal: GoalView | undefined,
    incomingCaps: TaskBudgetCaps,
    excludeId?: string,
  ): void => {
    for (const dim of TASK_BUDGET_DIMS) {
      const incoming = incomingCaps[dim] ?? 0;
      if (scope !== undefined) {
        const remaining = remainingOf(scope.budget)[dim];
        if (remaining === undefined) continue;
        let sum = incoming;
        for (const sibling of childrenOf(scope.id)) {
          if (sibling.id === excludeId) continue;
          sum += sibling.budget[dim] ?? 0;
        }
        if (sum > remaining) {
          throw new TdaError(
            'BUDGET_EXCEEDED',
            `预算守恒违反：子任务 ${dim} 之和 ${sum} 超过父任务 ${scope.id} 剩余 ${remaining}`,
          );
        }
        continue;
      }
      if (goal === undefined || dim === 'toolCalls') continue;
      const cap = goal.budget[dim];
      if (cap === undefined) continue;
      const remaining = cap - goal.budget.consumed[dim];
      let sum = incoming;
      for (const sibling of rootTasksOfGoal(goal.id)) {
        if (sibling.id === excludeId) continue;
        sum += sibling.budget[dim] ?? 0;
      }
      if (sum > remaining) {
        throw new TdaError(
          'BUDGET_EXCEEDED',
          `预算守恒违反：根任务 ${dim} 之和 ${sum} 超过目标 ${goal.id} 剩余 ${remaining}`,
        );
      }
    }
  };

  const assertCapsCoverChildren = (node: TaskNode, newCaps: TaskBudgetCaps): void => {
    for (const dim of TASK_BUDGET_DIMS) {
      const cap = newCaps[dim];
      if (cap === undefined) continue;
      let sum = 0;
      for (const child of childrenOf(node.id)) sum += child.budget[dim] ?? 0;
      if (sum > cap) {
        throw new TdaError(
          'BUDGET_EXCEEDED',
          `预算守恒违反：既有子任务 ${dim} 之和 ${sum} 超过新帽 ${cap}（任务 ${node.id}）`,
        );
      }
    }
  };

  /** consume 预检：本节点 + 祖先链 + 目标（逐级不得超帽，fail-loud 不落半套）。 */
  const assertWithinCap = (node: TaskNode, usage: TaskConsumed): void => {
    for (const dim of TASK_BUDGET_DIMS) {
      const cap = node.budget[dim];
      if (cap === undefined) continue;
      const next = node.budget.consumed[dim] + usage[dim];
      if (next > cap) {
        throw new TdaError(
          'BUDGET_EXHAUSTED',
          `任务 ${node.id} ${dim} 预算将超帽：${node.budget.consumed[dim]} + ${usage[dim]} > ${cap}`,
        );
      }
    }
  };

  /** 三区行为闸（§4.4）：converge 停止新委派；exhausted 另禁新建与开跑。 */
  const assertZoneAllows = (
    op: 'create' | 'claim' | 'start-run',
    zone: TaskZone,
    scopeId: string,
  ): void => {
    if (zone === 'normal') return;
    if (op === 'create' && zone === 'converge') return; // 收敛区仍可建（只是禁新委派）
    throw new TdaError(
      zone === 'exhausted' ? 'BUDGET_EXHAUSTED' : 'BUDGET_CONVERGE',
      `${op} 被预算三区行为拒绝：作用域 ${scopeId} 处于 ${zone} 区` +
        (zone === 'exhausted' ? '（请提额或人类介入）' : '（收敛范围，停止新委派）'),
    );
  };

  const goalCaps = (goal: GoalView): TaskBudgetCaps => ({
    ...(goal.budget.tokens !== undefined ? { tokens: goal.budget.tokens } : {}),
    ...(goal.budget.wallClockMs !== undefined ? { wallClockMs: goal.budget.wallClockMs } : {}),
    ...(goal.budget.attentionUnits !== undefined ? { attentionUnits: goal.budget.attentionUnits } : {}),
  });

  const goalRemaining = (goal: GoalView): TaskBudgetCaps => {
    const remaining: TaskBudgetCaps = {};
    if (goal.budget.tokens !== undefined) remaining.tokens = goal.budget.tokens - goal.budget.consumed.tokens;
    if (goal.budget.wallClockMs !== undefined) {
      remaining.wallClockMs = goal.budget.wallClockMs - goal.budget.consumed.wallClockMs;
    }
    if (goal.budget.attentionUnits !== undefined) {
      remaining.attentionUnits = goal.budget.attentionUnits - goal.budget.consumed.attentionUnits;
    }
    return remaining;
  };

  const goalZone = (goal: GoalView): TaskZone =>
    zoneOfCaps(goalCaps(goal), {
      tokens: goal.budget.consumed.tokens,
      wallClockMs: goal.budget.consumed.wallClockMs,
      attentionUnits: goal.budget.consumed.attentionUnits,
    });

  const assertGoalAttachable = (goalId: GoalId): GoalView | undefined => {
    if (goalLookup === undefined) return undefined; // 未装配目标层：降级（装配完整性由集成测试兜）
    const goal = goalLookup.get(goalId);
    if (goal === undefined) {
      throw new TdaError('GOAL_NOT_FOUND', `任务挂靠的目标不存在：${goalId}`);
    }
    if (goal.clearedAt !== undefined) {
      throw new TdaError('GOAL_CLEARED', `目标 ${goalId} 已 clear，不得挂接任务`);
    }
    if (goal.phase !== 'active') {
      throw new TdaError('GOAL_NOT_ACTIVE', `目标 ${goalId} 非 active（${goal.phase}），不得新建/改挂任务`);
    }
    return goal;
  };

  const assertBlockedByValid = (blockedBy: readonly string[], selfId?: string): void => {
    for (const dependency of blockedBy) {
      if (selfId !== undefined && dependency === selfId) {
        throw new TdaError('TASK_GRAPH_CYCLE', `任务不得依赖自身：${selfId}`);
      }
      const target = tasks.get(dependency);
      if (target === undefined) {
        throw new TdaError('TASK_REF_MISSING', `blockedBy 引用的任务不存在：${dependency}`);
      }
      if (target.deletedAt !== undefined) {
        throw new TdaError('TASK_REF_DELETED', `blockedBy 不得引用 tombstone：${dependency}`);
      }
    }
  };

  /** 不变量 1 的运行期守卫：把新父/新依赖并入图后仍须无环。 */
  const assertGraphAcyclic = (
    nodeId: string,
    parentTaskId: string | undefined,
    blockedBy: readonly string[],
  ): void => {
    const edges = new Map<string, string[]>();
    for (const [key, current] of tasks.entries()) {
      if (key === nodeId) continue;
      const outs: string[] = [];
      if (current.parentTaskId !== undefined) outs.push(current.parentTaskId);
      for (const dependency of current.blockedBy) outs.push(dependency);
      edges.set(key, outs);
    }
    const own: string[] = [];
    if (parentTaskId !== undefined) own.push(parentTaskId);
    for (const dependency of blockedBy) own.push(dependency);
    edges.set(nodeId, own);

    const visiting = new Set<string>();
    const done = new Set<string>();
    const walk = (current: string): void => {
      if (done.has(current)) return;
      if (visiting.has(current)) {
        throw new TdaError('TASK_GRAPH_CYCLE', `父子+依赖合并图存在环（经 ${current} 回环）`);
      }
      visiting.add(current);
      for (const next of edges.get(current) ?? []) {
        if (edges.has(next)) walk(next);
      }
      visiting.delete(current);
      done.add(current);
    };
    for (const key of edges.keys()) walk(key);
  };

  const isReady = (node: TaskNode): boolean => {
    if (!alive(node) || node.phase !== 'active' || node.stage !== 'planning' || node.ownerId !== undefined) {
      return false;
    }
    if (node.proposal !== undefined && node.proposal.status !== 'approved') return false;
    for (const dependency of node.blockedBy) {
      const target = tasks.get(dependency as TaskId);
      if (target === undefined || target.phase !== 'complete') return false;
    }
    return node.budget.zone === 'normal';
  };

  const matchesFilter = (node: TaskNode, filter?: TaskListFilter): boolean => {
    if (filter === undefined) return true;
    if (filter.includeDeleted !== true && node.deletedAt !== undefined) return false;
    if (filter.goalId !== undefined && node.goalId !== filter.goalId) return false;
    if (filter.phase !== undefined && node.phase !== filter.phase) return false;
    if (filter.stage !== undefined && node.stage !== filter.stage) return false;
    if (filter.ownerId !== undefined && node.ownerId !== filter.ownerId) return false;
    if (filter.parentTaskId !== undefined && node.parentTaskId !== filter.parentTaskId) return false;
    if (filter.proposalStatus !== undefined && node.proposal?.status !== filter.proposalStatus) return false;
    if (filter.priorityMin !== undefined && node.priority < filter.priorityMin) return false;
    return true;
  };

  /**
   * 单次 accepted 变更统一出口：task_nodes + task_history（+ 附加表）先行落域，
   * 再 append log-only 事件——同调用栈，任一步抛则整 op 抛（双写器契约）。
   * 提交成功后经总线分发已提交事实（IT2 跨插件联动面）。
   */
  const commit = async (
    node: TaskNode,
    operation: TaskOperation,
    actor: TaskActor,
    summary: string,
    extra: { readonly usage?: TaskConsumed; readonly writes?: readonly (() => Promise<void>)[] } = {},
  ): Promise<TaskNode> => {
    const payload = taskChangePayload(node);
    const seq = await dualWrite(
      deps.session,
      {
        family: 'taskPool/change',
        businessId: node.id,
        payload,
        domainWrite: async () => {
          await tasks.put(node.id, node);
          await history.put(`${node.id}#${node.revision}`, {
            taskId: node.id,
            revision: node.revision,
            operation,
            actor,
            summary,
            ...(extra.usage !== undefined ? { usage: extra.usage } : {}),
            at: node.updatedAt,
          });
          for (const write of extra.writes ?? []) await write();
        },
      },
      context,
    );
    if (deps.bus !== undefined) {
      deps.bus.publish({
        family: 'taskPool/change',
        businessId: node.id,
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
    return node;
  };

  const summarizeEdit = (req: EditTaskRequest, current: TaskNode): string => {
    const parts: string[] = [];
    if (req.subject !== undefined && req.subject !== current.subject) parts.push('subject');
    if (req.description !== undefined) parts.push('description');
    if (req.priority !== undefined) parts.push('priority');
    if (req.localPath !== undefined) parts.push('localPath');
    if (req.writeScopes !== undefined) parts.push('writeScopes');
    if (req.schedule !== undefined) parts.push('schedule');
    if (req.recurrence !== undefined) parts.push('recurrence');
    if (req.blockedBy !== undefined) parts.push('blockedBy');
    if (req.budget !== undefined) parts.push('budget');
    if (req.stage !== undefined && req.stage !== current.stage) parts.push(`stage→${req.stage}`);
    if (req.progress !== undefined) parts.push('progress');
    return `编辑：${parts.length > 0 ? parts.join('/') : '无字段变化'}`;
  };

  const createInternal = async (
    actor: TaskActor,
    req: CreateTaskRequest,
    options: { readonly forceProposal: boolean },
  ): Promise<TaskNode> => {
    const goal = assertGoalAttachable(req.goalId);
    const parent = req.parentTaskId === undefined ? undefined : mustGet(req.parentTaskId);
    if (parent !== undefined) {
      if (!alive(parent)) {
        throw new TdaError('TASK_DELETED', `父任务 ${parent.id} 是 tombstone，不得挂接子任务`);
      }
      if (parent.phase === 'complete') {
        throw new TdaError('TASK_COMPLETE', `父任务 ${parent.id} 已 complete，不得挂接子任务`);
      }
      if (parent.goalId !== req.goalId) {
        throw new TdaError(
          'TASK_GOAL_MISMATCH',
          `子任务必须与父任务同属一个目标（父 ${parent.goalId}，子 ${req.goalId}）`,
        );
      }
    }
    const blockedBy = (req.blockedBy ?? []).map((id) => String(id) as TaskId);
    assertBlockedByValid(blockedBy);

    // 预算：显式优先，否则继承父任务帽 / 目标帽（两路都过守恒检查）
    // 三区行为先判：耗尽区拒绝新建（提示提额/人类介入）——政策判据先于额度切分，
    // 否则守恒检查会先以"剩余不足"报错，掩盖"该作用域已耗尽"这个更可行动的结论
    if (parent !== undefined) assertZoneAllows('create', parent.budget.zone, parent.id);
    else if (goal !== undefined) assertZoneAllows('create', goalZone(goal), goal.id);

    // 缺省继承"作用域剩余"（T0.2 §4.2 原文口径：默认继承父任务/目标**剩余**预算）
    const caps: TaskBudgetCaps =
      req.budget ??
      (parent !== undefined
        ? remainingOf(parent.budget)
        : goal !== undefined
          ? goalRemaining(goal)
          : ZERO_CAPS);
    assertScopeConservation(parent, parent === undefined ? goal : undefined, caps);

    const id = allocateId(tasks, 'task') as TaskId;
    const now = clock();
    const schedule: TaskSchedule = {
      ...(req.schedule?.notBefore !== undefined ? { notBefore: req.schedule.notBefore } : {}),
      ...(req.schedule?.dueAt !== undefined ? { dueAt: req.schedule.dueAt } : {}),
    };
    const recurrence = req.recurrence;
    const proposedBy: 'human' | 'agent' =
      options.forceProposal || actor === 'agent' || actor === 'coach' ? 'agent' : 'human';
    const proposal: TaskProposal | undefined =
      proposedBy === 'agent' ? { status: 'pending_approval', at: now } : undefined;
    const firstDue =
      recurrence === undefined ? undefined : (schedule.dueAt ?? schedule.notBefore ?? now);

    const node: TaskNode = {
      id,
      revision: 0,
      goalId: req.goalId,
      ...(parent !== undefined ? { parentTaskId: parent.id } : {}),
      ...(req.alternativeOf !== undefined ? { alternativeOf: { ...req.alternativeOf } } : {}),
      ...(req.planId !== undefined ? { planId: req.planId } : {}),
      subject: req.subject,
      description: req.description ?? '',
      phase: 'active',
      stage: 'planning',
      blockedBy,
      ...(req.localPath !== undefined
        ? { localPath: normalizeWorkspacePath(req.localPath, 'localPath') }
        : {}),
      writeScopes: (req.writeScopes ?? []).map((scope_) => normalizeWorkspacePath(scope_, 'writeScopes')),
      priority: req.priority ?? 0,
      schedule,
      ...(recurrence !== undefined ? { recurrence } : {}),
      runCount: 0,
      consecutiveFailures: 0,
      ...(firstDue !== undefined ? { nextDueAt: firstDue } : {}),
      proposedBy,
      ...(proposal !== undefined ? { proposal } : {}),
      budget: withZone(caps, { ...ZERO_CONSUMED }),
      ...(req.progress !== undefined ? { progress: req.progress } : {}),
      createdAt: now,
      updatedAt: now,
    };
    assertGraphAcyclic(node.id, node.parentTaskId, node.blockedBy);
    return commit(node, proposedBy === 'agent' ? 'propose' : 'create', actor, `创建任务：${req.subject}`);
  };

  /** 账本向上汇聚：先任务祖先链，再经 seam 汇入目标（J5/J7 守恒）。 */
  const rollUp = async (actor: TaskActor, node: TaskNode, usage: TaskConsumed): Promise<void> => {
    if (!hasUsage(usage)) return;
    for (const ancestor of ancestorsOf(node)) {
      const fresh = mustGet(ancestor.id);
      const rolled = cas(fresh, fresh.revision, (task) => ({
        ...task,
        budget: withZone(capsOf(task.budget), addConsumed(task.budget.consumed, usage)),
        updatedAt: clock(),
      }));
      await commit(rolled, 'consume-rollup', actor, `子树消耗汇聚自 ${node.id}`, { usage });
    }
    if (goalLookup === undefined) return;
    const usageAtGoal: GoalUsageLike = {
      tokens: usage.tokens,
      wallClockMs: usage.wallClockMs,
      attentionUnits: usage.attentionUnits,
    };
    // 目标侧 consume 自带上溯汇聚；STALE 说明并发写，重取一次即可（仍失败则 fail-loud）
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const goal = goalLookup.get(node.goalId);
      if (goal === undefined || goal.phase !== 'active') return;
      try {
        await goalLookup.consume(actor, node.goalId, { expectedRevision: goal.revision }, usageAtGoal);
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'STALE_REVISION') throw error;
      }
    }
    throw new TdaError('GOAL_ROLLUP_STALE', `目标 ${node.goalId} 账本汇聚连续两次修订号过期（并发写）`);
  };

  const service: TaskPoolService = {
    create(actor, req) {
      return withLock(async () => createInternal(actor, req, { forceProposal: false }));
    },

    propose(actor, req) {
      return withLock(async () => createInternal(actor, req, { forceProposal: true }));
    },

    async edit(actor, id, ref, req) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        if (req.stage !== undefined && current.phase !== 'active') {
          throw new TdaError('STAGE_REQUIRES_ACTIVE', `stage 仅存于 active phase（当前 ${current.phase}）`);
        }
        const nextBlockedBy =
          req.blockedBy === undefined ? current.blockedBy : req.blockedBy.map((dep) => String(dep) as TaskId);
        if (req.blockedBy !== undefined) {
          assertBlockedByValid(nextBlockedBy, id);
          assertGraphAcyclic(id, current.parentTaskId, nextBlockedBy);
        }
        if (req.recurrence === null && current.recurrence === undefined) {
          throw new TdaError('TASK_NOT_RECURRING', `任务 ${id} 本无周期定义，无需清除`);
        }
        if (req.recurrence !== undefined && openRunOf(id) !== undefined) {
          throw new TdaError('TASK_RUN_OPEN', `任务 ${id} 有未收尾 run，期间不得变更周期定义`);
        }
        if (req.budget !== undefined) {
          const parent = current.parentTaskId === undefined ? undefined : tasks.get(current.parentTaskId as TaskId);
          const goal = current.parentTaskId === undefined ? assertGoalAttachable(current.goalId as GoalId) : undefined;
          assertScopeConservation(parent, goal, req.budget, id);
          assertCapsCoverChildren(current, req.budget);
        }
        const now = clock();
        const next = cas(current, ref.expectedRevision, (task) => {
          const { recurrence: _oldRecurrence, ...rest } = task;
          const recurrence =
            req.recurrence === undefined ? _oldRecurrence : req.recurrence === null ? undefined : req.recurrence;
          const nextDueAt =
            recurrence === undefined
              ? undefined
              : (req.schedule?.dueAt ?? task.schedule.dueAt ?? task.nextDueAt ?? now);
          return {
            ...rest,
            ...(req.subject !== undefined ? { subject: req.subject } : {}),
            ...(req.description !== undefined ? { description: req.description } : {}),
            ...(req.priority !== undefined ? { priority: req.priority } : {}),
            ...(req.localPath !== undefined
              ? { localPath: normalizeWorkspacePath(req.localPath, 'localPath') }
              : {}),
            ...(req.writeScopes !== undefined
              ? { writeScopes: req.writeScopes.map((scope) => normalizeWorkspacePath(scope, 'writeScopes')) }
              : {}),
            ...(req.schedule !== undefined ? { schedule: req.schedule } : {}),
            ...(recurrence !== undefined ? { recurrence } : {}),
            ...(req.blockedBy !== undefined ? { blockedBy: nextBlockedBy } : {}),
            ...(req.budget !== undefined
              ? { budget: withZone(req.budget, task.budget.consumed) }
              : {}),
            ...(req.stage !== undefined ? { stage: req.stage } : {}),
            ...(req.progress !== undefined ? { progress: req.progress } : {}),
            ...(recurrence === undefined
              ? {}
              : nextDueAt !== undefined
                ? { nextDueAt }
                : {}),
            updatedAt: now,
          };
        });
        assertGraphAcyclic(next.id, next.parentTaskId, next.blockedBy);
        return commit(next, 'edit', actor, summarizeEdit(req, current));
      });
    },

    async claim(actor, id, ref, ownerId) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        if (current.stage !== 'planning' || current.ownerId !== undefined) {
          throw new TdaError(
            'TASK_NOT_CLAIMABLE',
            `任务 ${id} 不可认领（需 active/planning 且无 owner；当前 ${current.phase}/${current.stage}）`,
          );
        }
        if (current.proposal !== undefined && current.proposal.status !== 'approved') {
          throw new TdaError(
            'TASK_NOT_APPROVED',
            `任务 ${id} 提议状态为 ${current.proposal.status}，未批准不可认领（J9）`,
          );
        }
        for (const dependency of current.blockedBy) {
          const target = tasks.get(dependency as TaskId);
          if (target === undefined || target.phase !== 'complete') {
            throw new TdaError('TASK_DEP_UNMET', `任务 ${id} 的执行依赖未完成：${dependency}`);
          }
        }
        assertZoneAllows('claim', current.budget.zone, current.id);
        const next = cas(current, ref.expectedRevision, (task) => ({
          ...task,
          stage: 'executing' as const,
          ownerId: String(ownerId),
          updatedAt: clock(),
        }));
        return commit(next, 'claim', actor, `认领任务（owner=${ownerId}）`);
      });
    },

    async release(actor, id, ref) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        if (current.ownerId === undefined) {
          throw new TdaError('TASK_NOT_OWNED', `任务 ${id} 无 owner，无需释放`);
        }
        const next = cas(current, ref.expectedRevision, (task) => {
          const { ownerId: _dropped, ...rest } = task;
          return { ...rest, stage: 'planning' as const, updatedAt: clock() };
        });
        return commit(next, 'release', actor, `释放任务（回 planning）`);
      });
    },

    async reassign(actor, id, ref, ownerId) {
      return withLock(async () => {
        // 不变量 6：改派仅人类/Lead 可强制
        if (actor !== 'human') {
          throw new TdaError('TASK_FORCE_REQUIRED', `改派任务需人类/Lead 强制（收到 actor=${actor}）`);
        }
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        const next = cas(current, ref.expectedRevision, (task) => ({
          ...task,
          ownerId: String(ownerId),
          stage: task.stage === 'planning' ? ('executing' as const) : task.stage,
          updatedAt: clock(),
        }));
        return commit(next, 'reassign', actor, `强制改派（owner=${ownerId}）`);
      });
    },

    async block(actor, id, ref, reason) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        assertPhaseTransition(current, 'blocked');
        const next = cas(current, ref.expectedRevision, (task) => ({
          ...task,
          phase: 'blocked' as const,
          blockedReason: { code: reason.code, message: reason.message },
          updatedAt: clock(),
        }));
        return commit(next, 'block', actor, `阻塞任务：${reason.code}`);
      });
    },

    async resume(actor, id, ref) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        assertPhaseTransition(current, 'active');
        const next = cas(current, ref.expectedRevision, (task) => {
          const { blockedReason: _dropped, ...rest } = task;
          return { ...rest, phase: 'active' as const, updatedAt: clock() };
        });
        return commit(next, 'resume', actor, '恢复任务');
      });
    },

    async pause(actor, id, ref) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        assertPhaseTransition(current, 'paused');
        const next = cas(current, ref.expectedRevision, (task) => ({
          ...task,
          phase: 'paused' as const,
          updatedAt: clock(),
        }));
        return commit(next, 'pause', actor, '暂停任务');
      });
    },

    async complete(actor, id, ref, completion) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        assertPhaseTransition(current, 'complete');
        if (current.recurrence !== undefined && openRunOf(id) !== undefined) {
          throw new TdaError(
            'TASK_RUN_OPEN',
            `任务 ${id} 有未收尾 run：周期任务须先 completeRun 收尾本 run，再停排整个周期`,
          );
        }
        if (current.budget.zone === 'exhausted' && completion.unfinished === undefined) {
          throw new TdaError(
            'TASK_UNFINISHED_REQUIRED',
            `任务 ${id} 预算已耗尽：complete 必带 unfinished 未完成清单（C5：绝不悄然截断）`,
          );
        }
        const now = clock();
        const oneShot = current.recurrence === undefined;
        const writes: (() => Promise<void>)[] = [];
        if (oneShot) {
          // 一次性任务的执行记录仍落 task_runs（runIndex=runCount）
          const runIndex = current.runCount;
          const record: TaskRunRecord = {
            taskId: current.id,
            runIndex,
            startedAt: current.createdAt,
            completedAt: now,
            outcome: completion.outcome,
            consumed: { ...current.budget.consumed },
            ...(completion.notes !== undefined ? { notes: completion.notes } : {}),
          };
          writes.push(() => runs.put(`${current.id}#${runIndex}`, record));
        }
        const next = cas(current, ref.expectedRevision, (task) => ({
          ...task,
          phase: 'complete' as const,
          outcome: completion.outcome,
          ...(completion.evidence !== undefined ? { evidence: [...completion.evidence] } : {}),
          ...(completion.unfinished !== undefined ? { unfinished: [...completion.unfinished] } : {}),
          ...(oneShot
            ? { runCount: task.runCount + 1, lastRunAt: task.lastRunAt ?? now }
            : {}),
          updatedAt: now,
        }));
        return commit(next, 'complete', actor, `完成任务：${completion.outcome}`, { writes });
      });
    },

    async delete(actor, id, ref, reason) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        if (current.deletedAt !== undefined) {
          throw new TdaError('TASK_DELETED', `任务 ${id} 已是 tombstone`);
        }
        if (current.phase === 'complete') {
          throw new TdaError('TASK_COMPLETE', 'complete 是终态，不得 delete（任意非 complete 态可删）');
        }
        // 引用完整（不变量 3）：被他人引用时禁删，防制造悬挂引用/环
        for (const [key, node] of tasks.entries()) {
          if (key === id || !alive(node)) continue;
          if (node.parentTaskId === id || node.blockedBy.includes(id)) {
            throw new TdaError(
              'TASK_REFERENCED',
              `任务 ${id} 被 ${key} 引用（父子/依赖），须先解除引用再删（不级联删）`,
            );
          }
        }
        const now = clock();
        const next = cas(current, ref.expectedRevision, (task) => ({
          ...task,
          deletedAt: now,
          deleteReason: reason,
          updatedAt: now,
        }));
        return commit(next, 'delete', actor, `删除任务（tombstone）：${reason}`);
      });
    },

    async consume(actor, id, ref, usage) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        const delta = usageRecord(usage);
        // 预检：本节点 + 祖先链（任一级超帽即整体拒绝，不落半套）
        for (const node of [current, ...ancestorsOf(current)]) {
          assertWithinCap(node, delta);
        }
        const next = cas(current, ref.expectedRevision, (task) => ({
          ...task,
          budget: withZone(capsOf(task.budget), addConsumed(task.budget.consumed, delta)),
          updatedAt: clock(),
        }));
        await commit(next, 'consume', actor, `预算记账：${JSON.stringify(delta)}`, { usage: delta });
        await rollUp(actor, current, delta);
        return next;
      });
    },

    async startRun(actor, id, ref, ownerId) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        if (current.recurrence === undefined) {
          throw new TdaError('TASK_NOT_RECURRING', `任务 ${id} 无周期定义，不得开 run 窗口`);
        }
        if (openRunOf(id) !== undefined) {
          throw new TdaError('TASK_RUN_OPEN', `任务 ${id} 已有未收尾 run`);
        }
        if (current.proposal !== undefined && current.proposal.status !== 'approved') {
          throw new TdaError('TASK_NOT_APPROVED', `任务 ${id} 未批准，不得开 run（J9）`);
        }
        assertZoneAllows('start-run', current.budget.zone, current.id);
        const now = clock();
        if (current.recurrence.endAt !== undefined && now >= current.recurrence.endAt) {
          throw new TdaError('TASK_SCHEDULE_ENDED', `任务 ${id} 周期已到期（endAt）`);
        }
        const runIndex = current.runCount;
        const record: TaskRunRecord = {
          taskId: current.id,
          runIndex,
          startedAt: now,
          consumed: { ...ZERO_CONSUMED },
        };
        const next = cas(current, ref.expectedRevision, (task) => ({
          ...task,
          runCount: task.runCount + 1,
          lastRunAt: now,
          stage: 'executing' as const,
          ownerId: String(ownerId),
          updatedAt: now,
        }));
        return commit(next, 'start-run', actor, `开启 run#${runIndex}（owner=${ownerId}）`, {
          writes: [() => runs.put(`${current.id}#${runIndex}`, record)],
        });
      });
    },

    async completeRun(actor, id, ref, run) {
      return withLock(async () => {
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        const open = openRunOf(id);
        if (open === undefined) {
          throw new TdaError('TASK_NO_OPEN_RUN', `任务 ${id} 无未收尾 run，无法 completeRun`);
        }
        const recurrence = current.recurrence;
        if (recurrence === undefined) {
          throw new TdaError('TASK_NOT_RECURRING', `任务 ${id} 无周期定义，不得 completeRun`);
        }
        const now = clock();
        const failures = run.outcome === 'failed' ? current.consecutiveFailures + 1 : 0;
        const fireAt = current.nextDueAt ?? now;
        const exhaustedByRuns = recurrence.maxRuns !== undefined && current.runCount >= recurrence.maxRuns;
        const endedByTime =
          recurrence.endAt !== undefined &&
          (now >= recurrence.endAt ||
            nextRecurrenceAfter(recurrence, fireAt, now) > recurrence.endAt);
        const stopping = exhaustedByRuns || endedByTime;
        const closing: TaskRunRecord = {
          ...open,
          completedAt: now,
          outcome: run.outcome,
          consumed: { ...ZERO_CONSUMED, ...(run.consumed ?? {}) },
          ...(run.notes !== undefined ? { notes: run.notes } : {}),
        };
        const next = cas(current, ref.expectedRevision, (task) => {
          const { ownerId: _owner, nextDueAt: _due, ...rest } = task;
          if (stopping) {
            return {
              ...rest,
              phase: 'complete' as const,
              outcome: failures > 0 ? ('failed' as const) : ('success' as const),
              consecutiveFailures: failures,
              stage: 'verifying' as const,
              // 停排原因为 maxRuns/endAt（正常收敛），未完成清单显式为空以守 schema 恒等律
              ...(task.budget.zone === 'exhausted' ? { unfinished: [] } : {}),
              updatedAt: now,
            };
          }
          return {
            ...rest,
            phase: 'active' as const,
            stage: 'planning' as const,
            consecutiveFailures: failures,
            nextDueAt: nextRecurrenceAfter(recurrence, fireAt, now),
            updatedAt: now,
          };
        });
        return commit(next, 'complete-run', actor, `收尾 run#${open.runIndex}：${run.outcome}`, {
          writes: [() => runs.put(`${current.id}#${open.runIndex}`, closing)],
        });
      });
    },

    async approveProposal(actor, id, ref, approve, reason) {
      return withLock(async () => {
        // P0 全审批（J9/决策点⑤默认档）：批准权仅人类/Lead，模型不得自批
        if (actor !== 'human') {
          throw new TdaError('TASK_APPROVAL_FORBIDDEN', `提议批准仅人类/Lead（收到 actor=${actor}）`);
        }
        const current = fresh(mustGet(id), ref);
        assertNotTerminal(current);
        if (current.proposal === undefined || current.proposal.status !== 'pending_approval') {
          throw new TdaError('TASK_NO_PENDING_PROPOSAL', `任务 ${id} 无待批提议（当前 ${current.proposal?.status ?? '无'}）`);
        }
        const now = clock();
        const next = cas(current, ref.expectedRevision, (task) => ({
          ...task,
          proposal: {
            status: approve ? ('approved' as const) : ('rejected' as const),
            at: now,
            by: actor,
            ...(reason !== undefined ? { reason } : {}),
          },
          updatedAt: now,
        }));
        return commit(next, approve ? 'approve' : 'reject', actor, approve ? '批准提议' : `驳回提议：${reason ?? ''}`);
      });
    },

    get(id) {
      return tasks.get(id);
    },

    list(filter) {
      const out: TaskNode[] = [];
      for (const [, node] of tasks.entries()) {
        if (matchesFilter(node, filter)) out.push(node);
      }
      out.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      return out;
    },

    ready(filter) {
      return this.list(filter).filter(isReady);
    },

    runs(id) {
      const out: TaskRunRecord[] = [];
      for (const [, record] of runs.entries()) {
        if (record.taskId === id) out.push(record);
      }
      out.sort((a, b) => a.runIndex - b.runIndex);
      return out;
    },

    history(id) {
      const out: TaskChangeRecord[] = [];
      for (const [, record] of history.entries()) {
        if (record.taskId === id) out.push(record);
      }
      out.sort((a, b) => a.revision - b.revision);
      return out;
    },

    due(now) {
      const out: TaskNode[] = [];
      for (const [, node] of tasks.entries()) {
        if (!alive(node) || node.phase !== 'active' || node.recurrence === undefined) continue;
        if (node.nextDueAt === undefined || node.nextDueAt > now) continue;
        if (node.recurrence.endAt !== undefined && now >= node.recurrence.endAt) continue;
        if (node.proposal !== undefined && node.proposal.status !== 'approved') continue;
        // 三区行为：converge 禁派生新委派、exhausted 禁开跑（due 与 startRun 同闸，避免空转报错）
        if (node.budget.zone !== 'normal') continue;
        // 已开窗未收尾的 run 不重复触发（调度幂等：due 只看窗口外）
        if (openRunOf(node.id) !== undefined) continue;
        out.push(node);
      }
      // dispatch 序：priority 降序 → dueAt 升序 → createdAt 升序（§4.4）
      out.sort(
        (a, b) =>
          b.priority - a.priority ||
          (a.nextDueAt ?? 0) - (b.nextDueAt ?? 0) ||
          a.createdAt - b.createdAt,
      );
      return out;
    },

    assertSettled(goalId) {
      const unsettled: string[] = [];
      for (const [, node] of tasks.entries()) {
        if (!alive(node) || node.goalId !== goalId || node.phase === 'complete') continue;
        unsettled.push(`${node.id}(${node.phase}/${node.stage})`);
      }
      if (unsettled.length > 0) {
        throw new TdaError(
          'TASKS_UNSETTLED',
          `目标 ${goalId} 下存在未终态任务，不得进入 verifying：${unsettled.join('、')}`,
        );
      }
    },

    promptSection() {
      const focusGoalId = goalLookup?.focusGoalId?.();
      const views: TaskView[] = [];
      for (const [, node] of tasks.entries()) {
        if (!alive(node) || node.phase !== 'active') continue;
        if (focusGoalId !== undefined && node.goalId !== focusGoalId) continue;
        const ready = isReady(node);
        const executing = node.stage === 'executing';
        if (!ready && !executing) continue;
        views.push({
          id: node.id,
          subject: node.subject,
          stage: node.stage,
          ...(node.ownerId !== undefined ? { ownerId: node.ownerId } : {}),
          priority: node.priority,
          ...(node.schedule.dueAt !== undefined ? { dueAt: node.schedule.dueAt } : {}),
          ...(node.nextDueAt !== undefined ? { nextDueAt: node.nextDueAt } : {}),
          zone: node.budget.zone,
          ready,
        });
      }
      // 排序：executing 优先（在跑的最需决策关注）→ priority 降序 → createdAt 升序
      views.sort((a, b) => {
        const execDiff = Number(b.stage === 'executing') - Number(a.stage === 'executing');
        if (execDiff !== 0) return execDiff;
        return b.priority - a.priority;
      });
      return {
        id: 'task:state' as const,
        order: { after: 'goal:state' as const },
        content: views.length === 0 ? '（无待办/在办任务）' : views.map(renderView).join('\n'),
      };
    },

    writeScopeWarnings(filter) {
      const active = this.list(filter);
      const out: ScopeWarning[] = [];
      for (let i = 0; i < active.length; i += 1) {
        for (let j = i + 1; j < active.length; j += 1) {
          const a = active[i];
          const b = active[j];
          if (a === undefined || b === undefined) continue;
          for (const left of a.writeScopes) {
            for (const right of b.writeScopes) {
              const overlap =
                left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
              if (overlap) {
                out.push({
                  goalId: a.goalId,
                  a: `${a.id}:${left}`,
                  b: `${b.id}:${right}`,
                  prefix: left.length <= right.length ? left : right,
                });
              }
            }
          }
        }
      }
      return out; // advisory：只告警不阻断（T0.2 J7/§2.3）
    },
  };

  return service;
}
