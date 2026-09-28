/**
 * tda-smoke 事件构造：只允许走已登记族（goalTree/change）。
 *
 * 载荷即记录快照——replay-equivalence 的 rebuild 直接以 payload 还原记录，
 * 事件不存 seq（seq 由 session sink 拥有序分配）。
 */
import type { JsonObject } from '@tda/kernel';

export interface SmokeGoalEventPayload {
  readonly id: string;
  readonly title: string;
  readonly status: 'active' | 'done';
  readonly revision: number;
}

export const goalChangePayload = (goal: SmokeGoalEventPayload): JsonObject => ({
  id: goal.id,
  title: goal.title,
  status: goal.status,
  revision: goal.revision,
});
