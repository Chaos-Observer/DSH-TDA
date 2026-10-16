/**
 * tda-task-pool 事件构造：只允许走已登记族（taskPool/change，编号 2）。
 *
 * 载荷 = TaskNode 全快照（T0.2 J2）：replay-equivalence 的 rebuild 直接以
 * payload 还原记录；事件不存 seq（seq 由 session sink 拥有序分配）。
 * 显式逐字段构造（不用展开）：payload 形态与 TaskNode 记录逐字段一致，
 * 可选字段遵循 exactOptionalPropertyTypes——仅在在场时挂键。
 */
import type { JsonObject } from '@tda/kernel';
import type { TaskNode } from './domain.ts';

/**
 * 全快照载荷。字段顺序稳定（KV-cache/回放比对友好）：
 * 身份 → 挂靠 → 内容 → 状态 → 调度 → 计数 → 预算 → 提议 → 终态 → 时间戳。
 */
export const taskChangePayload = (node: TaskNode): JsonObject => ({
  id: node.id,
  revision: node.revision,
  goalId: node.goalId,
  ...(node.parentTaskId !== undefined ? { parentTaskId: node.parentTaskId } : {}),
  ...(node.alternativeOf !== undefined
    ? {
        alternativeOf: {
          taskId: node.alternativeOf.taskId,
          ...(node.alternativeOf.planId !== undefined ? { planId: node.alternativeOf.planId } : {}),
          ...(node.alternativeOf.contingencyId !== undefined
            ? { contingencyId: node.alternativeOf.contingencyId }
            : {}),
        },
      }
    : {}),
  ...(node.planId !== undefined ? { planId: node.planId } : {}),
  subject: node.subject,
  description: node.description,
  phase: node.phase,
  stage: node.stage,
  ...(node.outcome !== undefined ? { outcome: node.outcome } : {}),
  ...(node.blockedReason !== undefined
    ? { blockedReason: { code: node.blockedReason.code, message: node.blockedReason.message } }
    : {}),
  ...(node.ownerId !== undefined ? { ownerId: node.ownerId } : {}),
  blockedBy: [...node.blockedBy],
  ...(node.localPath !== undefined ? { localPath: node.localPath } : {}),
  writeScopes: [...node.writeScopes],
  priority: node.priority,
  schedule: {
    ...(node.schedule.notBefore !== undefined ? { notBefore: node.schedule.notBefore } : {}),
    ...(node.schedule.dueAt !== undefined ? { dueAt: node.schedule.dueAt } : {}),
  },
  ...(node.recurrence !== undefined
    ? {
        recurrence: {
          kind: node.recurrence.kind,
          ...(node.recurrence.intervalMs !== undefined ? { intervalMs: node.recurrence.intervalMs } : {}),
          ...(node.recurrence.cron !== undefined ? { cron: node.recurrence.cron } : {}),
          ...(node.recurrence.maxRuns !== undefined ? { maxRuns: node.recurrence.maxRuns } : {}),
          ...(node.recurrence.endAt !== undefined ? { endAt: node.recurrence.endAt } : {}),
        },
      }
    : {}),
  runCount: node.runCount,
  consecutiveFailures: node.consecutiveFailures,
  ...(node.lastRunAt !== undefined ? { lastRunAt: node.lastRunAt } : {}),
  ...(node.nextDueAt !== undefined ? { nextDueAt: node.nextDueAt } : {}),
  ...(node.evidence !== undefined ? { evidence: [...node.evidence] } : {}),
  ...(node.unfinished !== undefined ? { unfinished: [...node.unfinished] } : {}),
  proposedBy: node.proposedBy,
  ...(node.proposal !== undefined
    ? {
        proposal: {
          status: node.proposal.status,
          at: node.proposal.at,
          ...(node.proposal.by !== undefined ? { by: node.proposal.by } : {}),
          ...(node.proposal.reason !== undefined ? { reason: node.proposal.reason } : {}),
        },
      }
    : {}),
  budget: {
    ...(node.budget.tokens !== undefined ? { tokens: node.budget.tokens } : {}),
    ...(node.budget.toolCalls !== undefined ? { toolCalls: node.budget.toolCalls } : {}),
    ...(node.budget.wallClockMs !== undefined ? { wallClockMs: node.budget.wallClockMs } : {}),
    ...(node.budget.attentionUnits !== undefined ? { attentionUnits: node.budget.attentionUnits } : {}),
    consumed: {
      tokens: node.budget.consumed.tokens,
      toolCalls: node.budget.consumed.toolCalls,
      wallClockMs: node.budget.consumed.wallClockMs,
      attentionUnits: node.budget.consumed.attentionUnits,
    },
    zone: node.budget.zone,
  },
  ...(node.progress !== undefined ? { progress: node.progress } : {}),
  ...(node.deletedAt !== undefined ? { deletedAt: node.deletedAt } : {}),
  ...(node.deleteReason !== undefined ? { deleteReason: node.deleteReason } : {}),
  createdAt: node.createdAt,
  updatedAt: node.updatedAt,
});
