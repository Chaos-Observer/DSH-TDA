/**
 * tda-goal-state 插件级不变量：以插件自己的 npm 包名（tda-goal-state）注册。
 *
 * T0.1 五条树不变量 → 检查/运行时分层映射（写路径 vs 加载期）：
 *  1. 树完整（父存在 + 无环）       → 加载期检查 goal-tree-acyclic
 *  2. 单焦点（每棵树恰一个）         → 加载期检查 goal-tree-single-focus。
 *     写入序 = 先让渡旧焦点再切换，崩溃撕裂至多零焦点：加载期容忍 0（撕裂），
 *     拒绝 ≥2（双焦点即分叉）；恰一由服务路径 create/focus 自愈维持。
 *  3. 预算守恒（Σ 子帽 ≤ 父帽）      → 加载期检查 goal-budget-conservation。
 *     对消耗稳定的弱形式：分配时服务查"Σ 子帽 ≤ 父剩余（帽−已耗）"，
 *     加载期查"Σ 子帽 ≤ 父帽"（注入场景兜底）。
 *  4. CAS 严格（每次变更带期望 revision）→ 运行时强制：cas() 不匹配即抛
 *     STALE_REVISION，不静默重试；加载期无独立检查。
 *  5. phase 迁移合法 + 字段完备律    → 运行时强制 + schema 层：
 *     assertPhaseTransition（pause/block 仅自 active 等）+ GoalNodeSchema
 *     .superRefine（outcome 在场 ⟺ phase=complete；blockedReason 在场 ⟺
 *     phase=blocked）。schema 在 invalidRecords=reject 下加载即拒，
 *     无需独立检查。
 */
import {
  tdaPluginInstaller,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
  type TdaDomain,
  type TdaKvTable,
} from '@tda/kernel';
import type { GoalNode, GoalTables } from './domain.ts';

/** 按父链求根；遇环返回 undefined（调用方 fail-loud，不会静默吞掉）。 */
function rootOf(goals: TdaKvTable<GoalNode>, node: GoalNode): string | undefined {
  const seen = new Set<string>([node.id]);
  let cursor = node.parentId;
  while (cursor !== undefined) {
    if (seen.has(cursor)) return undefined;
    seen.add(cursor);
    cursor = goals.get(cursor)?.parentId;
  }
  return seen.size === 1 ? node.id : [...seen][seen.size - 1];
}

export function goalStateInvariantChecks(domain: TdaDomain<GoalTables>): TdaInvariantCheck[] {
  return [
    {
      name: 'goal-tree-acyclic',
      run(fail) {
        const goals = domain.table('goal_nodes');
        for (const [key, node] of goals.entries()) {
          // 父引用必须存在（悬挂父即拒——树完整是其余树检查的前提）
          if (node.parentId !== undefined && goals.get(node.parentId) === undefined) {
            fail(`目标 ${key} 的父节点 ${node.parentId} 不存在（悬挂父引用）`);
          }
          // 沿父链步行：seen 回访即环（含自环）
          const seen = new Set<string>([node.id]);
          let cursor = node.parentId;
          while (cursor !== undefined) {
            if (seen.has(cursor)) {
              fail(`目标 ${key} 处于父环中（经 ${cursor} 回环）`);
              break;
            }
            seen.add(cursor);
            cursor = goals.get(cursor)?.parentId;
          }
        }
      },
    },
    {
      name: 'goal-tree-single-focus',
      run(fail) {
        const goals = domain.table('goal_nodes');
        // 按根分组统计存活焦点（tombstone 的 focus 标志不参与——clear 不让渡焦点，
        // 撕裂的零焦点由服务路径自愈，此处只拦双焦点分叉）
        const focusCountByRoot = new Map<string, number>();
        for (const [key, node] of goals.entries()) {
          if (!node.focus || node.clearedAt !== undefined) continue;
          const root = rootOf(goals, node);
          if (root === undefined) {
            fail(`目标 ${key} 焦点节点处于父环中，无法归属树`);
            continue;
          }
          focusCountByRoot.set(root, (focusCountByRoot.get(root) ?? 0) + 1);
        }
        for (const [root, count] of focusCountByRoot) {
          if (count > 1) {
            fail(`树 ${root} 存在 ${count} 个焦点目标（单焦点不变量：每棵树恰一个）`);
          }
        }
      },
    },
    {
      name: 'goal-budget-conservation',
      run(fail) {
        const goals = domain.table('goal_nodes');
        // 逐父累计存活子节点帽（tombstone 不参与预算）
        const childCaps = new Map<string, { tokens: number; wallClockMs: number; attentionUnits: number }>();
        for (const [, node] of goals.entries()) {
          if (node.parentId === undefined || node.clearedAt !== undefined) continue;
          const acc = childCaps.get(node.parentId) ?? { tokens: 0, wallClockMs: 0, attentionUnits: 0 };
          acc.tokens += node.budget.tokens ?? 0;
          acc.wallClockMs += node.budget.wallClockMs ?? 0;
          acc.attentionUnits += node.budget.attentionUnits ?? 0;
          childCaps.set(node.parentId, acc);
        }
        for (const [key, node] of goals.entries()) {
          const acc = childCaps.get(node.id);
          if (acc === undefined) continue;
          if (node.budget.tokens !== undefined && acc.tokens > node.budget.tokens) {
            fail(`目标 ${key} 子节点 tokens 帽之和 ${acc.tokens} 超过父帽 ${node.budget.tokens}`);
          }
          if (node.budget.wallClockMs !== undefined && acc.wallClockMs > node.budget.wallClockMs) {
            fail(`目标 ${key} 子节点 wallClockMs 帽之和 ${acc.wallClockMs} 超过父帽 ${node.budget.wallClockMs}`);
          }
          if (node.budget.attentionUnits !== undefined && acc.attentionUnits > node.budget.attentionUnits) {
            fail(
              `目标 ${key} 子节点 attentionUnits 帽之和 ${acc.attentionUnits} 超过父帽 ${node.budget.attentionUnits}`,
            );
          }
        }
      },
    },
  ];
}

/** 用插件包名注册插件级检查；返回注销函数。 */
export function registerGoalStateInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<GoalTables>,
): () => void {
  return registry.register('tda-goal-state', tdaPluginInstaller(goalStateInvariantChecks(domain)));
}
