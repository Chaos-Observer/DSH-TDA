/**
 * tda-goal-state 事件构造：只允许走已登记族（goalTree/change，编号 1）。
 *
 * 载荷 = GoalNode 全快照（T0.1 J2）：replay-equivalence 的 rebuild 直接以
 * payload 还原记录；事件不存 seq（seq 由 session sink 拥有序分配）。
 * 显式逐字段构造（不用展开）：保证 payload 形态与 GoalNode 记录逐字段一致，
 * 可选字段遵循 exactOptionalPropertyTypes——仅在在场时挂键。
 */
import type { JsonObject } from '@tda/kernel';
import type { GoalNode } from './domain.ts';

export type GoalChangeEventPayload = JsonObject;

export const goalChangePayload = (node: GoalNode): GoalChangeEventPayload => ({
  id: node.id,
  revision: node.revision,
  ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
  objective: node.objective,
  completionCriteria: [...node.completionCriteria],
  phase: node.phase,
  stage: node.stage,
  ...(node.outcome !== undefined ? { outcome: node.outcome } : {}),
  ...(node.blockedReason !== undefined
    ? { blockedReason: { code: node.blockedReason.code, message: node.blockedReason.message } }
    : {}),
  maxGoalRounds: node.maxGoalRounds,
  roundsStarted: node.roundsStarted,
  budget: {
    ...(node.budget.tokens !== undefined ? { tokens: node.budget.tokens } : {}),
    ...(node.budget.wallClockMs !== undefined ? { wallClockMs: node.budget.wallClockMs } : {}),
    ...(node.budget.attentionUnits !== undefined ? { attentionUnits: node.budget.attentionUnits } : {}),
    consumed: {
      tokens: node.budget.consumed.tokens,
      wallClockMs: node.budget.consumed.wallClockMs,
      attentionUnits: node.budget.consumed.attentionUnits,
    },
  },
  ...(node.queuePosition !== undefined ? { queuePosition: node.queuePosition } : {}),
  focus: node.focus,
  ...(node.clearedAt !== undefined ? { clearedAt: node.clearedAt } : {}),
  createdAt: node.createdAt,
  updatedAt: node.updatedAt,
});
