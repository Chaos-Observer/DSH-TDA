/**
 * tda-goal-state × tda-task-pool 联动面（T0.2 §5"目标层联动"）。
 *
 * 两条联动，方向与幂等性各自不同（这是本文件的存在理由）：
 *
 *  1. **任务 → 目标：stage 幂等推进**（订阅 `taskPool/change`）
 *     目标的 stage 是"该目标下任务推进到什么程度"的派生投影：
 *     ∃ executing → executing；否则 ∃ verifying → verifying；
 *     否则 ∃ waiting → waiting；否则 → planning。
 *     投影是幂等的纯函数（同样的任务集合必得同样的 stage），因此可由事件
 *     多次触发、重启后重新订阅也自洽——**不携带任何"上次已同步"状态**。
 *     跳过条件（不视为错误）：目标非 active（paused/blocked 保留最后 stage）、
 *     已 complete/clear、并发 CAS 失败（下一个事件会自愈）。
 *
 *  2. **目标 → 任务：verifying 前置校验**（`assertSettled` 服务面直调）
 *     目标进入 verifying 前，该目标下不得有未终态任务（T0.1 J4 完成标准汇聚）。
 *     这是**调用**而非订阅：前置条件是同步判定，必须阻塞性返回结果。
 *
 * 记账汇聚（任务消耗 → 目标账本）**不在此处**：那是直接服务面调用
 * （见 tda-task-pool/service.ts 顶注的记账路径裁定），不做事件反向累计，
 * 以免全快照事件被误当增量造成重复计数。
 */
import type { TdaBusEvent, TdaEventBus } from '@tda/kernel';
import type { GoalId } from '@tda/kernel';
import type { GoalStage } from './domain.ts';
import type { GoalTreeService } from './service.ts';

/** 任务池只读投影（结构子集，跨插件零 import）。 */
export interface TaskStageProjection {
  readonly phase: string;
  readonly stage: string;
}

/** 目标层对任务池的最小依赖面（由装配方注入 ctx.taskPool）。 */
export interface TaskPoolLink {
  assertSettled(goalId: GoalId): void;
  list(filter: { readonly goalId: GoalId }): readonly TaskStageProjection[];
}

/** 幂等投影：任务集合 → 目标 stage。 */
export function projectGoalStage(tasks: readonly TaskStageProjection[]): GoalStage {
  let hasWaiting = false;
  let hasVerifying = false;
  let hasExecuting = false;
  for (const task of tasks) {
    if (task.phase !== 'active') continue;
    if (task.stage === 'executing') hasExecuting = true;
    else if (task.stage === 'verifying') hasVerifying = true;
    else if (task.stage === 'waiting') hasWaiting = true;
  }
  if (hasExecuting) return 'executing';
  if (hasVerifying) return 'verifying';
  if (hasWaiting) return 'waiting';
  return 'planning';
}

/** 订阅者自身可容忍的错误码（非错误：状态不允许 / 并发过期，下个事件自愈）。 */
const TOLERATED_CODES = new Set([
  'STAGE_REQUIRES_ACTIVE',
  'GOAL_COMPLETE',
  'GOAL_CLEARED',
  'GOAL_NOT_FOUND',
  'STALE_REVISION',
]);

export interface TaskStageSyncOptions {
  readonly bus: TdaEventBus;
  readonly service: GoalTreeService;
  readonly taskPool: TaskPoolLink;
  /**
   * 非容忍错误的出口。事件订阅是"已提交事实的回声"，错误无法回灌给提交方
   * （也不应回灌——提交已 durable），故走显式出口而非静默吞掉或抛成
   * 未处理拒绝：默认 console.error，Harness 装配时改写入自身日志。
   */
  readonly onError?: (message: string) => void;
}

export interface TaskStageSyncHandle {
  /** 停订：此后不再触发新同步（幂等，可重复调用）。 */
  unsubscribe(): void;
  /**
   * 等待**已触发**的同步全部落定（不抛：错误已走 onError 出口）。
   *
   * dispose 序必须是 `unsubscribe() → drain() → domain.close()`：
   * 回声是投递后不等结果的 floating promise，若直接关域，晚到的 edit 会撞上
   * 已关闭的域——要么报"域已关闭"，要么与 close 的 flush 争同一 tmp 路径。
   */
  drain(): Promise<void>;
}

/**
 * 订阅 `taskPool/change` 并幂等推进目标 stage。
 * 返回手柄（unsubscribe + drain），插件 dispose 时按序调用。
 */
export function subscribeTaskStageSync(options: TaskStageSyncOptions): TaskStageSyncHandle {
  const { bus, service, taskPool } = options;
  const report =
    options.onError ??
    ((message: string): void => {
      console.error('[tda-goal-state] stage 同步失败：', message);
    });
  const inflight = new Set<Promise<void>>();
  let active = true;

  const off = bus.subscribe('taskPool/change', (event: TdaBusEvent) => {
    // 事件是"已提交事实的回声"：停订后到达的事件不再回声（否则与 drain 赛跑）
    if (!active) return;
    const payload = event.payload;
    const goalId = payload.goalId;
    if (typeof goalId !== 'string' || goalId === '') return;
    const goal = service.get(goalId as GoalId);
    if (goal === undefined || goal.phase !== 'active' || goal.clearedAt !== undefined) return;
    const projected = projectGoalStage(taskPool.list({ goalId: goalId as GoalId }));
    if (projected === goal.stage) return;
    const sync = service
      .edit('scheduler', goalId as GoalId, { expectedRevision: goal.revision }, { stage: projected })
      .then(
        () => undefined,
        (error: unknown) => {
          const code = (error as { code?: string }).code;
          if (code !== undefined && TOLERATED_CODES.has(code)) return; // 幂等推进：下个事件自愈
          report(`目标 ${goalId} stage 同步失败：${error instanceof Error ? error.message : String(error)}`);
        },
      );
    inflight.add(sync);
    void sync.then(() => {
      inflight.delete(sync);
    });
  });

  return {
    unsubscribe() {
      if (!active) return;
      active = false;
      off();
    },
    async drain() {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}
