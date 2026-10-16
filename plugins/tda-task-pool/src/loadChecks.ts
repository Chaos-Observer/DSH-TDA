/**
 * tda-task-pool 插件级不变量：以插件 npm 包名（tda-task-pool）注册。
 *
 * T0.2 §4.1 九条不变量 → 检查/运行时分层映射（写路径 vs 加载期）：
 *  1. 图无环            → 加载期 task-graph-acyclic（父子+依赖合并图；alternativeOf 不参与）
 *  2. 挂靠有效          → 加载期 task-goal-attach（需注入 goalLookup；未装配时降级为
 *                         "goalId 形态合法"，装配完整性由集成测试兜底）
 *  3. 引用完整          → 加载期 task-ref-integrity（不得引用 tombstone / 悬挂引用）
 *  4. CAS 严格          → 运行时强制（cas() 不匹配即抛 STALE_REVISION，不静默重试）
 *  5. 终态完备          → schema 恒等律（reject 加载即拒）+ 运行时 assertPhaseTransition
 *  6. 认领前置          → 运行时强制（claim 六检）+ 加载期 task-claim-consistency
 *                         （stage=executing ⟹ owner 在场，拦"无人负责的在跑任务"）
 *  7. 预算守恒          → 加载期 task-budget-conservation（注入场景兜底；分配时检查在服务面）
 *  8. 路径安全          → 加载期 task-path-safety（存量必须已规范化）+ 写入时规范化
 *  9. 周期派生正确      → 加载期 task-recurrence-derivation + 运行时 nextRecurrenceAfter
 */
import {
  tdaPluginInstaller,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
  type TdaDomain,
  type TdaKvTable,
} from '@tda/kernel';
import {
  TASK_BUDGET_DIMS,
  type TaskNode,
  type TaskTables,
} from './domain.ts';
import { normalizeWorkspacePath, type GoalLookup, type GoalView } from './service.ts';

export interface TaskInvariantOptions {
  /** 目标层只读 seam；注入后启用挂靠有效性与跨层预算守恒检查。 */
  readonly goalLookup?: GoalLookup;
}

const goalCapsOf = (goal: GoalView): Partial<Record<(typeof TASK_BUDGET_DIMS)[number], number>> => ({
  ...(goal.budget.tokens !== undefined ? { tokens: goal.budget.tokens } : {}),
  ...(goal.budget.wallClockMs !== undefined ? { wallClockMs: goal.budget.wallClockMs } : {}),
  ...(goal.budget.attentionUnits !== undefined ? { attentionUnits: goal.budget.attentionUnits } : {}),
});

/** 规范化幂等探针：存量值必须已是规范形态（否则说明库被旁路写入）。 */
const isCanonicalPath = (value: string): boolean => {
  try {
    return normalizeWorkspacePath(value, 'path') === value;
  } catch {
    return false;
  }
};

export function taskPoolInvariantChecks(
  domain: TdaDomain<TaskTables>,
  options: TaskInvariantOptions = {},
): TdaInvariantCheck[] {
  const goalLookup = options.goalLookup;

  const aliveEntries = (tasks: TdaKvTable<TaskNode>): [string, TaskNode][] =>
    [...tasks.entries()].filter(([, node]) => node.deletedAt === undefined);

  return [
    {
      name: 'task-alternative-of-refs',
      run(fail) {
        // P4（T4.5 §3.4 v2）：预案边引用完备 + legacy-advisory 标记语义对账。
        // legacy 边 = v1 裸值迁移行（有 alternativeOf 但无 planId ∧ 无 contingencyId）：
        // 保持 advisory 语义，不参与预案状态机（planner 侧同规则过滤）。
        const tasks = domain.table('task_nodes');
        for (const [key, node] of aliveEntries(tasks)) {
          if (node.alternativeOf === undefined) continue;
          if (node.alternativeOf.taskId.trim() === '') {
            fail(`任务 ${key} 的 alternativeOf.taskId 为空`);
          }
        }
      },
    },

    {
      name: 'task-graph-acyclic',
      run(fail) {
        const tasks = domain.table('task_nodes');
        const edges = new Map<string, string[]>();
        for (const [key, node] of tasks.entries()) {
          const outs: string[] = [];
          if (node.parentTaskId !== undefined) {
            if (tasks.get(node.parentTaskId) === undefined) {
              fail(`任务 ${key} 的父任务 ${node.parentTaskId} 不存在（悬挂父引用）`);
              continue;
            }
            outs.push(node.parentTaskId);
          }
          for (const dependency of node.blockedBy) {
            if (tasks.get(dependency) === undefined) {
              fail(`任务 ${key} 的 blockedBy 引用不存在：${dependency}`);
              continue;
            }
            outs.push(dependency);
          }
          // P4（T4.5 §3.4 v2）：预案边进合并图（alternativeOf.taskId 引用存在性同查）。
          if (node.alternativeOf !== undefined) {
            const target = node.alternativeOf.taskId;
            if (tasks.get(target) === undefined) {
              fail(`任务 ${key} 的 alternativeOf 引用不存在：${target}`);
            } else {
              outs.push(target);
            }
          }
          edges.set(key, outs);
        }
        const visiting = new Set<string>();
        const done = new Set<string>();
        const walk = (current: string): void => {
          if (done.has(current)) return;
          if (visiting.has(current)) {
            fail(`任务 ${current} 处于父子+依赖合并环中`);
            return;
          }
          visiting.add(current);
          for (const next of edges.get(current) ?? []) {
            if (edges.has(next)) walk(next);
          }
          visiting.delete(current);
          done.add(current);
        };
        for (const key of edges.keys()) walk(key);
      },
    },
    {
      name: 'task-goal-attach',
      run(fail) {
        const tasks = domain.table('task_nodes');
        for (const [key, node] of tasks.entries()) {
          if (node.goalId.trim() === '') {
            fail(`任务 ${key} 缺 goalId（任务必挂目标，J4）`);
            continue;
          }
          if (goalLookup === undefined) continue; // 未装配目标层：跨层检查降级（写路径仍强制）
          const goal = goalLookup.get(node.goalId);
          if (goal === undefined) {
            fail(`任务 ${key} 挂靠的目标不存在：${node.goalId}`);
            continue;
          }
          if (node.deletedAt !== undefined) continue;
          // 未终态任务必须挂在 active 目标下（目标 complete 后其任务须已全部终态）
          if (node.phase !== 'complete' && goal.phase !== 'active') {
            fail(`任务 ${key} 未终态却挂在 ${goal.phase} 目标 ${node.goalId} 下（挂靠有效性违反）`);
          }
          if (goal.clearedAt !== undefined && node.phase !== 'complete') {
            fail(`任务 ${key} 未终态却挂在已 clear 目标 ${node.goalId} 下`);
          }
        }
      },
    },
    {
      name: 'task-ref-integrity',
      run(fail) {
        const tasks = domain.table('task_nodes');
        for (const [key, node] of tasks.entries()) {
          const refs: string[] = [];
          if (node.parentTaskId !== undefined) refs.push(node.parentTaskId);
          refs.push(...node.blockedBy);
          for (const ref of refs) {
            const target = tasks.get(ref);
            if (target === undefined) {
              fail(`任务 ${key} 引用不存在：${ref}`);
              continue;
            }
            if (target.deletedAt !== undefined) {
              fail(`任务 ${key} 引用 tombstone：${ref}（不变量 3：禁引用已删）`);
            }
          }
        }
      },
    },
    {
      name: 'task-claim-consistency',
      run(fail) {
        const tasks = domain.table('task_nodes');
        for (const [key, node] of aliveEntries(tasks)) {
          if (node.phase !== 'active') continue;
          // 单向后承（非等价）：executing 必有 owner（在跑就得有人负责）；
          // 反向不成立——owner 可在等待期持有任务（stage=waiting 仍归属同一 owner）。
          if (node.stage === 'executing' && node.ownerId === undefined) {
            fail(`任务 ${key} stage=executing 却无 ownerId（在跑任务必须有归属）`);
          }
        }
      },
    },
    {
      name: 'task-budget-conservation',
      run(fail) {
        const tasks = domain.table('task_nodes');
        const childSums = new Map<string, Record<string, number>>();
        for (const [, node] of aliveEntries(tasks)) {
          if (node.parentTaskId === undefined) continue;
          const acc = childSums.get(node.parentTaskId) ?? {};
          for (const dim of TASK_BUDGET_DIMS) acc[dim] = (acc[dim] ?? 0) + (node.budget[dim] ?? 0);
          childSums.set(node.parentTaskId, acc);
        }
        for (const [key, node] of tasks.entries()) {
          const acc = childSums.get(key);
          if (acc === undefined) continue;
          for (const dim of TASK_BUDGET_DIMS) {
            const cap = node.budget[dim];
            if (cap === undefined) continue;
            const sum = acc[dim] ?? 0;
            if (sum > cap) {
              fail(`任务 ${key} 子任务 ${dim} 帽之和 ${sum} 超过父帽 ${cap}`);
            }
          }
        }
        if (goalLookup === undefined) return;
        const rootSums = new Map<string, Record<string, number>>();
        for (const [, node] of aliveEntries(tasks)) {
          if (node.parentTaskId !== undefined) continue;
          const acc = rootSums.get(node.goalId) ?? {};
          for (const dim of TASK_BUDGET_DIMS) acc[dim] = (acc[dim] ?? 0) + (node.budget[dim] ?? 0);
          rootSums.set(node.goalId, acc);
        }
        for (const [goalId, acc] of rootSums) {
          const goal = goalLookup.get(goalId);
          if (goal === undefined) continue;
          const caps = goalCapsOf(goal);
          for (const dim of TASK_BUDGET_DIMS) {
            const cap = caps[dim];
            if (cap === undefined) continue;
            // 目标的已耗账本缺 toolCalls 维（目标层预算三维），逐维取对应消耗
            const consumed = dim === 'tokens'
              ? goal.budget.consumed.tokens
              : dim === 'wallClockMs'
                ? goal.budget.consumed.wallClockMs
                : dim === 'attentionUnits'
                  ? goal.budget.consumed.attentionUnits
                  : 0;
            const remaining = cap - consumed;
            const sum = acc[dim] ?? 0;
            if (sum > remaining) {
              fail(`目标 ${goalId} 下根任务 ${dim} 帽之和 ${sum} 超过目标剩余 ${remaining}`);
            }
          }
        }
      },
    },
    {
      name: 'task-path-safety',
      run(fail) {
        const tasks = domain.table('task_nodes');
        for (const [key, node] of tasks.entries()) {
          if (node.localPath !== undefined && !isCanonicalPath(node.localPath)) {
            fail(`任务 ${key} 的 localPath 非规范形态（禁绝对路径/.. 逃逸）：${node.localPath}`);
          }
          for (const scope of node.writeScopes) {
            if (!isCanonicalPath(scope)) {
              fail(`任务 ${key} 的 writeScope 非规范形态：${scope}`);
            }
          }
        }
      },
    },
    {
      name: 'task-recurrence-derivation',
      run(fail) {
        const tasks = domain.table('task_nodes');
        for (const [key, node] of tasks.entries()) {
          const recurrence = node.recurrence;
          if (recurrence === undefined) {
            if (node.nextDueAt !== undefined) fail(`任务 ${key} 非周期却携带 nextDueAt`);
            continue;
          }
          if (node.phase === 'active' && node.nextDueAt === undefined) {
            fail(`任务 ${key} 运行中的周期任务缺 nextDueAt（durable 调度锚点）`);
          }
          if (node.phase === 'complete' && node.nextDueAt !== undefined) {
            fail(`任务 ${key} 已终态却仍带 nextDueAt（应停排）`);
          }
          if (
            recurrence.maxRuns !== undefined &&
            node.phase === 'active' &&
            node.runCount > recurrence.maxRuns
          ) {
            fail(`任务 ${key} runCount(${node.runCount}) 已超 maxRuns(${recurrence.maxRuns}) 却未停排`);
          }
          if (recurrence.endAt !== undefined && node.nextDueAt !== undefined && node.nextDueAt > recurrence.endAt) {
            fail(`任务 ${key} 的 nextDueAt 越过 endAt（停排条件失效）`);
          }
        }
      },
    },
  ];
}

/** 用插件包名注册插件级检查；返回注销函数。 */
export function registerTaskPoolInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<TaskTables>,
  options: TaskInvariantOptions = {},
): () => void {
  const checks = taskPoolInvariantChecks(domain, options);
  return registry.register('tda-task-pool', tdaPluginInstaller(checks));
}
