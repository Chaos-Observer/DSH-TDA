/**
 * tda-goal-state 服务：ctx.goalTree 服务面实现（T0.1 §4.2）。
 *
 * 插件业务代码只碰 goals/history 等表与 kernel 双写器——CAS、双写、审计索引
 * 细节全在内核（决策点③）。相对规格签名的两处强化（不变量驱动的必要超集）：
 *  1. 所有 mutation 带 GoalRef（expectedRevision）——不变量 4"CAS 严格"要求
 *     每次变更带期望 revision，不匹配即抛 STALE_REVISION，不静默重试；
 *  2. 所有 mutation 带 actor——goal_history"变更者"列必要（create 的 caller
 *     参数即规格原文）。
 *
 * 进程内互斥锁：consume 的祖先汇聚、focus 的让渡+切换都是复合写，锁保证
 * 复合 op 期间无其他服务写交错（锁外直写 domain 属注入场景，由不变量门捕获）。
 *
 * stage 推进机制（IT1）：edit 可显式设 stage（仅 active phase 允许，§2.2）；
 * IT2 起改由 taskPool/change 事件驱动推进，服务面签名不变。
 */
import {
  allocateId,
  cas,
  dualWrite,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type GoalId,
  type Revision,
  type TdaDomain,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  type GoalActor,
  type GoalBlockedReason,
  type GoalBudget,
  type GoalBudgetCaps,
  type GoalChangeRecord,
  type GoalNode,
  type GoalOperation,
  type GoalOutcome,
  type GoalPhase,
  type GoalStage,
  type GoalTables,
  type ObjectiveEdit,
  type Calibration,
  type ConstraintSnapshot,
} from './domain.ts';
import { goalChangePayload } from './events.ts';

/** 轮次预算默认总帽（create 未显式指定时）。 */
const DEFAULT_MAX_GOAL_ROUNDS = 50;

const ZERO_CONSUMED = { tokens: 0, wallClockMs: 0, attentionUnits: 0 } as const;

const BUDGET_DIMS = ['tokens', 'wallClockMs', 'attentionUnits'] as const;

export interface GoalRef {
  readonly expectedRevision: Revision;
}

export interface CreateGoalRequest {
  readonly objective: string;
  readonly completionCriteria?: readonly string[];
  readonly parentId?: GoalId;
  /** 显式预算分配（帽）；不传则继承父预算（不变量 3 分配时检查仍强制）。 */
  readonly budget?: GoalBudgetCaps;
  readonly maxGoalRounds?: number;
  readonly queuePosition?: number;
  /** C6 约束快照（创建时固定；T0.4 pinned 区数据源之一）。 */
  readonly pinned?: readonly string[];
  /** P4（T4.2 §3.4 v2）：目标来源（intake 代建收敛创建入口；人类直建缺省 'human'）。 */
  readonly source?: 'intake' | 'human';
  /** P4（T4.2 §3.4 v2）：intake 提议溯源（source='intake' 时必填——goal-state 加载期断言）。 */
  readonly intakeProposalId?: string;
}

export interface EditGoalRequest {
  readonly objective?: string;
  readonly completionCriteria?: readonly string[];
  readonly budget?: GoalBudgetCaps;
  readonly maxGoalRounds?: number;
  readonly queuePosition?: number;
  /** 仅 active phase 可设（§2.2：stage 仅存于 active）。 */
  readonly stage?: GoalStage;
  readonly pinned?: readonly string[];
  /** objective 改写理由（objective_edits，T1.5 数据面）。 */
  readonly reason?: string;
}

export interface ConsumedUsage {
  readonly tokens?: number;
  readonly wallClockMs?: number;
  readonly attentionUnits?: number;
}

interface UsageRecord {
  readonly tokens: number;
  readonly wallClockMs: number;
  readonly attentionUnits: number;
}

/** 焦点目标裁剪视图（T0.1 §5：objective/phase/stage/criteria/blockedReason/预算剩余）。 */
export interface GoalFocusView {
  readonly id: string;
  readonly objective: string;
  readonly phase: GoalPhase;
  readonly stage: GoalStage;
  readonly outcome?: GoalOutcome;
  readonly blockedReason?: GoalBlockedReason;
  readonly completionCriteria: readonly string[];
  readonly budgetRemaining: GoalBudgetCaps;
}

/** system-prompt section 描述（order 紧随 plan:policy，T0.1 §5）。 */
export interface GoalStateSection {
  readonly id: 'goal:state';
  readonly order: { readonly after: 'plan:policy' };
  readonly content: string;
}

export interface GoalTreeService {
  create(actor: GoalActor, req: CreateGoalRequest): Promise<GoalNode>;
  edit(actor: GoalActor, id: GoalId, ref: GoalRef, req: EditGoalRequest): Promise<GoalNode>;
  focus(actor: GoalActor, id: GoalId, ref: GoalRef): Promise<GoalNode>;
  pause(actor: GoalActor, id: GoalId, ref: GoalRef): Promise<GoalNode>;
  resume(actor: GoalActor, id: GoalId, ref: GoalRef): Promise<GoalNode>;
  block(actor: GoalActor, id: GoalId, ref: GoalRef, reason: GoalBlockedReason): Promise<GoalNode>;
  complete(actor: GoalActor, id: GoalId, ref: GoalRef, outcome: GoalOutcome): Promise<GoalNode>;
  clear(actor: GoalActor, id: GoalId, ref: GoalRef): Promise<GoalNode>;
  recordRound(actor: GoalActor, id: GoalId, ref: GoalRef): Promise<GoalNode>;
  consume(actor: GoalActor, id: GoalId, ref: GoalRef, usage: ConsumedUsage): Promise<GoalNode>;
  get(id: GoalId): GoalNode | undefined;
  tree(rootId?: GoalId): GoalNode[];
  history(id: GoalId): readonly GoalChangeRecord[];
  focusView(): GoalFocusView | undefined;
  promptSection(): GoalStateSection;
  /**
   * C6 约束快照的当前值（T0.4 pinned 区 `constraint` 类的数据源；T0.1 §5 C6 联动）。
   * 每目标一份快照（编辑即覆盖），故直接取该目标的那条。
   */
  constraints(id: GoalId): readonly string[];
  /** T1.5 数据面（J2①）：objective_edits 全量只读（按 seq 升序）。 */
  objectiveEdits(): readonly ObjectiveEdit[];
  /** T1.5 校准记录读取面（后验追踪 / replayCheck 来源）。 */
  calibrations(): readonly Calibration[];
  /**
   * T1.5 校准留痕（U7 回写本规格 §4.2 API 清单）：写 `calibrations` 表 +
   * 双写 `drift/calibrate` 事件（businessId=`calibration:<n>`）。
   * **权威证据在 T0.1 domain**（T1.5 J5①），drift 只经此 seam 写入——
   * 检测器对目标数据零写权（T1.5 J1），故这里只收"已成形"的记录，不做任何判定。
   */
  recordCalibration(
    actor: GoalActor,
    goalId: GoalId,
    entry: {
      readonly driftType: string;
      readonly action: 'restate' | 'echo' | 'reanchor' | 'nudge';
      readonly detail: string;
      readonly at: number;
    },
  ): Promise<void>;
}

export interface GoalServiceDeps {
  readonly domain: TdaDomain<GoalTables>;
  readonly session: TdaSessionSink;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  /**
   * 任务池 seam（跨插件只经服务面，零 import）：用于目标 stage=verifying 的
   * 前置校验——该目标下不得有未终态任务（T0.2 §5"目标层联动"）。
   * 未装配时降级（子系统完整性由集成测试兜），其余行为不受影响。
   */
  readonly taskPool?: GoalTaskPoolLink;
}

/** 任务池对目标层暴露的最小判定面（结构镜像 ctx.taskPool）。 */
export interface GoalTaskPoolLink {
  assertSettled(goalId: GoalId): void;
}

const capsOf = (budget: GoalBudget): GoalBudgetCaps => ({
  ...(budget.tokens !== undefined ? { tokens: budget.tokens } : {}),
  ...(budget.wallClockMs !== undefined ? { wallClockMs: budget.wallClockMs } : {}),
  ...(budget.attentionUnits !== undefined ? { attentionUnits: budget.attentionUnits } : {}),
});

const remainingBudget = (budget: GoalBudget): GoalBudgetCaps => {
  const remaining: { tokens?: number; wallClockMs?: number; attentionUnits?: number } = {};
  if (budget.tokens !== undefined) remaining.tokens = budget.tokens - budget.consumed.tokens;
  if (budget.wallClockMs !== undefined) {
    remaining.wallClockMs = budget.wallClockMs - budget.consumed.wallClockMs;
  }
  if (budget.attentionUnits !== undefined) {
    remaining.attentionUnits = budget.attentionUnits - budget.consumed.attentionUnits;
  }
  return remaining;
};

const addConsumed = (consumed: GoalBudget['consumed'], usage: UsageRecord): GoalBudget['consumed'] => ({
  tokens: consumed.tokens + usage.tokens,
  wallClockMs: consumed.wallClockMs + usage.wallClockMs,
  attentionUnits: consumed.attentionUnits + usage.attentionUnits,
});

const renderFocusView = (view: GoalFocusView): string => {
  const lines: string[] = [
    `焦点目标 ${view.id}：${view.objective}`,
    `阶段：${view.phase}/${view.stage}${view.outcome === undefined ? '' : `（${view.outcome}）`}`,
  ];
  if (view.blockedReason !== undefined) {
    lines.push(`阻塞：${view.blockedReason.code} — ${view.blockedReason.message}`);
  }
  lines.push('完成标准：');
  for (const criterion of view.completionCriteria) {
    lines.push(`- ${criterion}`);
  }
  const budgetParts: string[] = [];
  if (view.budgetRemaining.tokens !== undefined) budgetParts.push(`tokens 剩 ${view.budgetRemaining.tokens}`);
  if (view.budgetRemaining.wallClockMs !== undefined) {
    budgetParts.push(`墙钟剩 ${view.budgetRemaining.wallClockMs}ms`);
  }
  if (view.budgetRemaining.attentionUnits !== undefined) {
    budgetParts.push(`注意力剩 ${view.budgetRemaining.attentionUnits}`);
  }
  lines.push(budgetParts.length > 0 ? `预算剩余：${budgetParts.join('｜')}` : '预算剩余：无帽');
  return lines.join('\n');
};

export function createGoalTreeService(deps: GoalServiceDeps): GoalTreeService {
  const goals = deps.domain.table('goal_nodes');
  const history = deps.domain.table('goal_history');
  const objectiveEdits = deps.domain.table('objective_edits');
  const constraintSnapshots = deps.domain.table('constraint_snapshots');

  // exactOptionalPropertyTypes：仅在有值时挂键，避免显式传 undefined
  const context: DualWriteContext = {
    ...(deps.reconciler ? { reconciler: deps.reconciler } : {}),
    ...(deps.index ? { index: deps.index } : {}),
  };

  // 进程内互斥锁：复合写（consume 汇聚 / focus 让渡）原子化
  let lock: Promise<unknown> = Promise.resolve();
  const withLock = async <T>(op: () => Promise<T>): Promise<T> => {
    const result = lock.then(op, op);
    lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const mustGet = (id: GoalId): GoalNode => {
    const node = goals.get(id);
    if (node === undefined) {
      throw new TdaError('GOAL_NOT_FOUND', `目标不存在：${id}`);
    }
    return node;
  };

  /** 终态不可变：clear 的 tombstone 与 complete 均拒绝再变更（显式终态原则）。 */
  const assertNotTerminal = (node: GoalNode): void => {
    if (node.clearedAt !== undefined) {
      throw new TdaError('GOAL_CLEARED', `目标 ${node.id} 已 clear（tombstone 不可变）`);
    }
    if (node.phase === 'complete') {
      throw new TdaError('GOAL_COMPLETE', `目标 ${node.id} 已 complete（终态不可变）`);
    }
  };

  const parentOf = (node: GoalNode): GoalNode | undefined =>
    node.parentId === undefined ? undefined : goals.get(node.parentId as GoalId);

  const ancestorsOf = (node: GoalNode): GoalNode[] => {
    const chain: GoalNode[] = [];
    let current = parentOf(node);
    while (current !== undefined) {
      chain.push(current);
      current = parentOf(current);
    }
    return chain;
  };

  const rootOf = (node: GoalNode): GoalNode => {
    let current = node;
    for (;;) {
      const parent = parentOf(current);
      if (parent === undefined) return current;
      current = parent;
    }
  };

  /** 单焦点（不变量 2）：每棵树恰一个；加载期容忍撕裂的零焦点，服务路径维持恰一。 */
  const focusOfTree = (root: GoalNode): GoalNode | undefined => {
    for (const [, node] of goals.entries()) {
      if (node.focus && node.clearedAt === undefined && rootOf(node).id === root.id) return node;
    }
    return undefined;
  };

  /** 不变量 3（分配时检查）：Σ 子节点帽 ≤ 父节点剩余（帽 − 已耗，逐维）。 */
  const assertBudgetConservation = (parent: GoalNode, incomingCaps: GoalBudgetCaps): void => {
    const remaining = remainingBudget(parent.budget);
    for (const dim of BUDGET_DIMS) {
      const cap = remaining[dim];
      if (cap === undefined) continue;
      let sum = incomingCaps[dim] ?? 0;
      for (const [, child] of goals.entries()) {
        if (child.parentId === parent.id) sum += child.budget[dim] ?? 0;
      }
      if (sum > cap) {
        throw new TdaError(
          'BUDGET_EXCEEDED',
          `预算守恒违反：子节点 ${dim} 之和 ${sum} 超过父目标 ${parent.id} 剩余 ${cap}`,
        );
      }
    }
  };

  /**
   * 自帽收紧（edit）时不得低于既有子节点帽之和——否则加载期守恒检查即拒打开。
   * 分配时检查的"对下"方向：分配查上（不超父剩余），收紧查下（不低过子之和）。
   */
  const assertCapsCoverChildren = (node: GoalNode, newCaps: GoalBudgetCaps): void => {
    for (const dim of BUDGET_DIMS) {
      const cap = newCaps[dim];
      if (cap === undefined) continue;
      let sum = 0;
      for (const [, child] of goals.entries()) {
        if (child.parentId === node.id) sum += child.budget[dim] ?? 0;
      }
      if (sum > cap) {
        throw new TdaError(
          'BUDGET_EXCEEDED',
          `预算守恒违反：既有子节点 ${dim} 之和 ${sum} 超过新帽 ${cap}（目标 ${node.id}）`,
        );
      }
    }
  };

  /** consume 预检：本节点 + 祖先链逐级不得超帽（fail-loud，不落半套）。 */
  const assertWithinCap = (node: GoalNode, usage: UsageRecord): void => {
    for (const dim of BUDGET_DIMS) {
      const cap = node.budget[dim];
      if (cap === undefined) continue;
      const next = node.budget.consumed[dim] + usage[dim];
      if (next > cap) {
        throw new TdaError(
          'BUDGET_EXHAUSTED',
          `目标 ${node.id} ${dim} 预算将超帽：${node.budget.consumed[dim]} + ${usage[dim]} > ${cap}`,
        );
      }
    }
  };

  /**
   * phase 迁移守卫（不变量 5）：
   *  - pause / block 仅自 active（paused/blocked 不可再 pause/block）；
   *  - resume（to='active'）仅自 paused/blocked；
   *  - complete 仅自 active（paused/blocked 须先 resume；失败也是完成）。
   */
  const assertPhaseTransition = (from: GoalNode, to: 'paused' | 'blocked' | 'active' | 'complete'): void => {
    const ok =
      (to === 'paused' && from.phase === 'active') ||
      (to === 'blocked' && from.phase === 'active') ||
      (to === 'active' && (from.phase === 'paused' || from.phase === 'blocked')) ||
      (to === 'complete' && from.phase === 'active');
    if (!ok) {
      throw new TdaError(
        'INVALID_TRANSITION',
        `目标 ${from.id} 不允许 ${from.phase} → ${to}（pause/block 仅自 active；resume 自 paused/blocked；complete 仅自 active）`,
      );
    }
  };

  /**
   * 单次 accepted 变更统一出口：goal_nodes + goal_history（+ 附加表）先行落域，
   * 再 append log-only 事件——同调用栈，任一步抛则整 op 抛（双写器契约）。
   */
  const commit = async (
    node: GoalNode,
    operation: GoalOperation,
    actor: GoalActor,
    summary: string,
    extraWrites: readonly (() => Promise<void>)[] = [],
  ): Promise<GoalNode> => {
    await dualWrite(
      deps.session,
      {
        family: 'goalTree/change',
        businessId: node.id,
        payload: goalChangePayload(node),
        domainWrite: async () => {
          await goals.put(node.id, node);
          await history.put(`${node.id}#${node.revision}`, {
            goalId: node.id,
            revision: node.revision,
            operation,
            actor,
            summary,
            at: node.updatedAt,
          });
          for (const write of extraWrites) await write();
        },
      },
      context,
    );
    return node;
  };

  const summarizeEdit = (req: EditGoalRequest, current: GoalNode): string => {
    const parts: string[] = [];
    if (req.objective !== undefined && req.objective !== current.objective) parts.push('objective');
    if (req.completionCriteria !== undefined) parts.push('completionCriteria');
    if (req.budget !== undefined) parts.push('budget');
    if (req.maxGoalRounds !== undefined) parts.push('maxGoalRounds');
    if (req.queuePosition !== undefined) parts.push('queuePosition');
    if (req.stage !== undefined && req.stage !== current.stage) parts.push(`stage→${req.stage}`);
    return `编辑：${parts.length > 0 ? parts.join('/') : '无字段变化'}`;
  };

  return {
    async create(actor, req) {
      return withLock(async () => {
        // 无洞 id：从表内最大后缀 +1 派生，分配即落键，崩溃不留洞不重号
        const id = allocateId(goals, 'goal') as GoalId;
        const now = Date.now();
        const parent = req.parentId === undefined ? undefined : mustGet(req.parentId);
        if (parent !== undefined && parent.clearedAt !== undefined) {
          throw new TdaError('GOAL_CLEARED', `父目标 ${parent.id} 已 clear，不得挂接后继`);
        }
        // 默认继承父预算；显式分配优先——两条路都过守恒检查
        const caps: GoalBudgetCaps = req.budget ?? (parent === undefined ? {} : capsOf(parent.budget));
        if (parent !== undefined) assertBudgetConservation(parent, caps);
        // P4（T4.2 §3.4 v2）：intake 来源必携提议溯源（加载期断言的服务期对偶）
        if (req.source === 'intake' && req.intakeProposalId === undefined) {
          throw new TdaError('INTAKE_PROVENANCE_REQUIRED', `目标 ${req.objective.slice(0, 40)} source='intake' 必携 intakeProposalId（溯源断裂禁建）`);
        }
        // 新树（无父）根即焦点；子树无焦点时新节点补位（单焦点自愈）
        const focus = parent === undefined || focusOfTree(rootOf(parent)) === undefined;
        const node: GoalNode = {
          id,
          revision: 0,
          ...(parent !== undefined ? { parentId: parent.id } : {}),
          objective: req.objective,
          completionCriteria: req.completionCriteria === undefined ? [] : [...req.completionCriteria],
          phase: 'active',
          stage: 'planning',
          maxGoalRounds: req.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
          roundsStarted: 0,
          budget: { ...caps, consumed: { ...ZERO_CONSUMED } },
          ...(req.queuePosition !== undefined ? { queuePosition: req.queuePosition } : {}),
          focus,
          // P4（T4.2 §3.4 v2）：来源与提议溯源（intake 代建必带；人类直建 source='human'）
          source: req.source ?? 'human',
          ...(req.intakeProposalId !== undefined ? { intakeProposalId: req.intakeProposalId } : {}),
          createdAt: now,
          updatedAt: now,
        };
        // C6：创建即快照约束（pinned 缺省空数组——保持率基线从零计）
        const snapshot: ConstraintSnapshot = {
          goalId: id,
          pinned: req.pinned === undefined ? [] : [...req.pinned],
          at: now,
        };
        await commit(node, 'create', actor, `创建目标：${req.objective}`, [
          () => constraintSnapshots.put(id, snapshot),
        ]);
        return node;
      });
    },

    async edit(actor, id, ref, req) {
      return withLock(async () => {
        const current = mustGet(id);
        assertNotTerminal(current);
        if (req.stage !== undefined && current.phase !== 'active') {
          throw new TdaError('STAGE_REQUIRES_ACTIVE', `stage 仅存于 active phase（当前 ${current.phase}）`);
        }
        // T0.2 §5：目标进入 verifying 前，该目标下不得有未终态任务（完成标准汇聚前置）
        if (req.stage === 'verifying' && deps.taskPool !== undefined) {
          deps.taskPool.assertSettled(id);
        }
        const objective = req.objective;
        const objectiveChanged = objective !== undefined && objective !== current.objective;
        const budget = req.budget;
        if (budget !== undefined) {
          // 新帽对上：不超父剩余；对下：不低过既有子帽之和（双方向守恒）
          if (current.parentId !== undefined) {
            assertBudgetConservation(mustGet(current.parentId as GoalId), budget);
          }
          assertCapsCoverChildren(current, budget);
        }
        const now = Date.now();
        const next = cas(current, ref.expectedRevision, (goal) => ({
          ...goal,
          ...(objective !== undefined ? { objective } : {}),
          ...(req.completionCriteria !== undefined
            ? { completionCriteria: [...req.completionCriteria] }
            : {}),
          ...(budget !== undefined ? { budget: { ...budget, consumed: goal.budget.consumed } } : {}),
          ...(req.maxGoalRounds !== undefined ? { maxGoalRounds: req.maxGoalRounds } : {}),
          ...(req.queuePosition !== undefined ? { queuePosition: req.queuePosition } : {}),
          ...(req.stage !== undefined ? { stage: req.stage } : {}),
          updatedAt: now,
        }));
        const extraWrites: (() => Promise<void>)[] = [];
        if (objectiveChanged && objective !== undefined) {
          const editId = allocateId(objectiveEdits, 'oe');
          const record: ObjectiveEdit = {
            goalId: id,
            from: current.objective,
            to: objective,
            ...(req.reason !== undefined ? { reason: req.reason } : {}),
            actor,
            at: now,
          };
          extraWrites.push(() => objectiveEdits.put(editId, record));
        }
        if (req.pinned !== undefined) {
          const snapshot: ConstraintSnapshot = { goalId: id, pinned: [...req.pinned], at: now };
          extraWrites.push(() => constraintSnapshots.put(id, snapshot));
        }
        await commit(next, 'edit', actor, summarizeEdit(req, current), extraWrites);
        return next;
      });
    },

    async focus(actor, id, ref) {
      return withLock(async () => {
        const current = mustGet(id);
        assertNotTerminal(current);
        const next = cas(current, ref.expectedRevision, (goal) => ({ ...goal, focus: true }));
        const previous = focusOfTree(rootOf(current));
        if (previous !== undefined && previous.id !== id) {
          // 先让渡旧焦点再切换：崩溃撕裂至多零焦点（加载期容忍，下次 create/focus 自愈）
          const released = cas(previous, previous.revision, (goal) => ({ ...goal, focus: false }));
          await commit(released, 'focus-release', actor, `焦点让渡给 ${id}`);
        }
        await commit(next, 'focus', actor, `切换焦点至 ${id}`);
        return next;
      });
    },

    async pause(actor, id, ref) {
      return withLock(async () => {
        const current = mustGet(id);
        assertNotTerminal(current);
        assertPhaseTransition(current, 'paused');
        const next = cas(current, ref.expectedRevision, (goal) => ({ ...goal, phase: 'paused' as const }));
        await commit(next, 'pause', actor, '暂停目标');
        return next;
      });
    },

    async resume(actor, id, ref) {
      return withLock(async () => {
        const current = mustGet(id);
        assertNotTerminal(current);
        assertPhaseTransition(current, 'active');
        const now = Date.now();
        // resume 必须清 blockedReason（schema 恒等律：reason 在场 ⟺ blocked）
        const next = cas(current, ref.expectedRevision, (goal) => {
          const { blockedReason: _dropped, ...rest } = goal;
          return { ...rest, phase: 'active' as const, updatedAt: now };
        });
        await commit(next, 'resume', actor, '恢复目标');
        return next;
      });
    },

    async block(actor, id, ref, reason) {
      return withLock(async () => {
        const current = mustGet(id);
        assertNotTerminal(current);
        assertPhaseTransition(current, 'blocked');
        const now = Date.now();
        const next = cas(current, ref.expectedRevision, (goal) => ({
          ...goal,
          phase: 'blocked' as const,
          blockedReason: { code: reason.code, message: reason.message },
          updatedAt: now,
        }));
        await commit(next, 'block', actor, `阻塞目标：${reason.code}`);
        return next;
      });
    },

    async complete(actor, id, ref, outcome) {
      return withLock(async () => {
        const current = mustGet(id);
        assertNotTerminal(current);
        // complete 仅允许自 active（paused/blocked 须先 resume 回 active）
        assertPhaseTransition(current, 'complete');
        const now = Date.now();
        const next = cas(current, ref.expectedRevision, (goal) => ({
          ...goal,
          phase: 'complete' as const,
          outcome,
          updatedAt: now,
        }));
        await commit(next, 'complete', actor, `完成目标：${outcome}`);
        return next;
      });
    },

    async clear(actor, id, ref) {
      return withLock(async () => {
        const current = mustGet(id);
        if (current.clearedAt !== undefined) {
          throw new TdaError('GOAL_CLEARED', `目标 ${current.id} 已 clear（tombstone 不可变）`);
        }
        if (current.phase === 'complete') {
          throw new TdaError('GOAL_COMPLETE', 'complete 是终态，不得 clear（§2.1：任意非 complete 态可 clear）');
        }
        const now = Date.now();
        const next = cas(current, ref.expectedRevision, (goal) => ({ ...goal, clearedAt: now, updatedAt: now }));
        await commit(next, 'clear', actor, '清除目标（tombstone）');
        return next;
      });
    },

    async recordRound(actor, id, ref) {
      return withLock(async () => {
        const current = mustGet(id);
        assertNotTerminal(current);
        if (current.roundsStarted >= current.maxGoalRounds) {
          throw new TdaError(
            'ROUND_CAP_EXCEEDED',
            `目标 ${id} 轮次预算已尽：${current.roundsStarted}/${current.maxGoalRounds}`,
          );
        }
        const next = cas(current, ref.expectedRevision, (goal) => ({
          ...goal,
          roundsStarted: goal.roundsStarted + 1,
        }));
        await commit(next, 'recordRound', actor, `准入轮次 ${next.roundsStarted}/${next.maxGoalRounds}`);
        return next;
      });
    },

    async consume(actor, id, ref, usage) {
      return withLock(async () => {
        const current = mustGet(id);
        assertNotTerminal(current);
        const usageRecord: UsageRecord = {
          tokens: usage.tokens ?? 0,
          wallClockMs: usage.wallClockMs ?? 0,
          attentionUnits: usage.attentionUnits ?? 0,
        };
        // 预检本节点 + 祖先链（任一级超帽即整体拒绝，不落半套）
        for (const node of [current, ...ancestorsOf(current)]) {
          assertWithinCap(node, usageRecord);
        }
        const next = cas(current, ref.expectedRevision, (goal) => ({
          ...goal,
          budget: { ...goal.budget, consumed: addConsumed(goal.budget.consumed, usageRecord) },
        }));
        await commit(next, 'consume', actor, `预算记账：${JSON.stringify(usageRecord)}`);
        // 消耗账本向上汇聚：祖先链逐级 accepted 变更 + 双写（J5）
        for (const ancestor of ancestorsOf(current)) {
          const fresh = mustGet(ancestor.id);
          const rolled = cas(fresh, fresh.revision, (node) => ({
            ...node,
            budget: { ...node.budget, consumed: addConsumed(node.budget.consumed, usageRecord) },
          }));
          await commit(rolled, 'consume-rollup', actor, `子树消耗汇聚自 ${id}`);
        }
        return next;
      });
    },

    get(id) {
      return goals.get(id);
    },

    tree(rootId) {
      const all: GoalNode[] = [];
      for (const [, node] of goals.entries()) {
        if (node.clearedAt === undefined) all.push(node);
      }
      if (rootId === undefined) return all;
      const childrenOf = new Map<string, GoalNode[]>();
      for (const node of all) {
        if (node.parentId === undefined) continue;
        const siblings = childrenOf.get(node.parentId);
        if (siblings === undefined) childrenOf.set(node.parentId, [node]);
        else siblings.push(node);
      }
      const out: GoalNode[] = [];
      const queue: string[] = [rootId as string];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        const node = goals.get(current as GoalId);
        if (node === undefined || node.clearedAt !== undefined) continue;
        out.push(node);
        for (const child of childrenOf.get(current) ?? []) queue.push(child.id);
      }
      return out;
    },

    history(id) {
      const out: GoalChangeRecord[] = [];
      for (const [, record] of history.entries()) {
        if (record.goalId === id) out.push(record);
      }
      out.sort((a, b) => a.revision - b.revision);
      return out;
    },

    focusView() {
      // 多树并存（U2 未决）时取 updatedAt 最大者（确定性；P0 单树主导）
      let best: GoalNode | undefined;
      for (const [, node] of goals.entries()) {
        if (!node.focus || node.clearedAt !== undefined) continue;
        if (best === undefined || node.updatedAt > best.updatedAt) best = node;
      }
      if (best === undefined) return undefined;
      return {
        id: best.id,
        objective: best.objective,
        phase: best.phase,
        stage: best.stage,
        ...(best.outcome !== undefined ? { outcome: best.outcome } : {}),
        ...(best.blockedReason !== undefined
          ? { blockedReason: { code: best.blockedReason.code, message: best.blockedReason.message } }
          : {}),
        completionCriteria: [...best.completionCriteria],
        budgetRemaining: remainingBudget(best.budget),
      };
    },

    promptSection() {
      const view = this.focusView();
      return {
        id: 'goal:state' as const,
        order: { after: 'plan:policy' as const },
        content: view === undefined ? '（无焦点目标）' : renderFocusView(view),
      };
    },

    calibrations() {
      const list: Calibration[] = [];
      for (const [, value] of deps.domain.table('calibrations').entries()) list.push(value);
      return list;
    },

    objectiveEdits() {
      const list: ObjectiveEdit[] = [];
      for (const [, value] of objectiveEdits.entries()) list.push(value);
      return list;
    },

    async recordCalibration(actor, goalId, entry) {
      return withLock(async () => {
        const table = deps.domain.table('calibrations');
        const id = allocateId(table, 'cal');
        const row = {
          goalId: String(goalId),
          driftType: entry.driftType,
          action: entry.action,
          detail: entry.detail,
          at: entry.at,
        };
        await dualWrite(
          deps.session,
          {
            family: 'drift/calibrate',
            businessId: `calibration:${id}`,
            // 载荷 = 全快照（键序与 calibrations schema 定义序一致）
            payload: {
              goalId: row.goalId,
              driftType: row.driftType,
              action: row.action,
              detail: row.detail,
              at: row.at,
            } as never,
            domainWrite: () => table.put(id, row as never),
          },
          context,
        );
        void actor;
      });
    },

    constraints(id) {
      return constraintSnapshots.get(id)?.pinned ?? [];
    },
  };
}
