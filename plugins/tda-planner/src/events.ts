/**
 * tda-planner 事件载荷（族 `planner/change`，第二十二族，内核 events.ts 登记）。
 *
 * 纪律（T0.7 J2 + 施工范式 #26）：payload 键序**必须与 schema 定义序一致**
 * （compareReplay 是 stringify 逐字节比对，键序漂移=回放分歧假红）；
 * 可选键仅在在场时挂（缺键不挂 undefined——JSON 无损）。
 */
import type { JsonObject } from '@tda/kernel';
import type { PlanContingency, PlannerParams, TaskPlan } from './domain.ts';

function triggerPayload(trigger: PlanContingency['trigger']): JsonObject {
  switch (trigger.kind) {
    case 'task-failed':
    case 'task-blocked':
      return { kind: trigger.kind, taskTempId: trigger.taskTempId };
    case 'budget-zone':
      return { kind: trigger.kind, zone: trigger.zone };
    case 'verify-failed':
      return { kind: trigger.kind, attempts: trigger.attempts };
  }
}

function coveragePayload(coverage: TaskPlan['coverage']): JsonObject {
  return {
    passed: coverage.passed,
    checks: coverage.checks.map((check) => ({ id: check.id, passed: check.passed, detail: check.detail })),
  };
}

/** plan 全快照载荷（逐字段显式构造，保键序）。 */
export function planPayload(plan: TaskPlan): JsonObject {
  return {
    id: plan.id,
    revision: plan.revision,
    goalId: plan.goalId,
    status: plan.status,
    kind: plan.kind,
    tasks: plan.tasks.map((task): JsonObject => ({
      tempId: task.tempId,
      ...(task.parentTempId !== undefined ? { parentTempId: task.parentTempId } : {}),
      subject: task.subject,
      ...(task.description !== undefined ? { description: task.description } : {}),
      completionCriteria: [...task.completionCriteria],
      blockedByTempIds: [...task.blockedByTempIds],
      ...(task.alternativeOfTempId !== undefined ? { alternativeOfTempId: task.alternativeOfTempId } : {}),
      ...(task.contingency !== undefined
        ? { contingency: { trigger: triggerPayload(task.contingency.trigger), carveOut: task.contingency.carveOut } }
        : {}),
      ...(task.budget !== undefined
        ? {
            budget: {
              ...(task.budget.tokens !== undefined ? { tokens: task.budget.tokens } : {}),
              ...(task.budget.toolCalls !== undefined ? { toolCalls: task.budget.toolCalls } : {}),
              ...(task.budget.wallClockMs !== undefined ? { wallClockMs: task.budget.wallClockMs } : {}),
              ...(task.budget.attentionUnits !== undefined ? { attentionUnits: task.budget.attentionUnits } : {}),
            },
          }
        : {}),
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      ...(task.localPath !== undefined ? { localPath: task.localPath } : {}),
      ...(task.writeScopes !== undefined ? { writeScopes: [...task.writeScopes] } : {}),
      ...(task.suggestedWorkflowDefId !== undefined ? { suggestedWorkflowDefId: task.suggestedWorkflowDefId } : {}),
      ...(task.riskHint !== undefined ? { riskHint: task.riskHint } : {}),
      criteriaRefs: [...task.criteriaRefs],
      ...(task.noContingencyReason !== undefined ? { noContingencyReason: task.noContingencyReason } : {}),
    })),
    coverage: coveragePayload(plan.coverage),
    generation: {
      provider: plan.generation.provider,
      model: plan.generation.model,
      schemaHash: plan.generation.schemaHash,
      at: plan.generation.at,
    },
    ...(plan.deviation !== undefined
      ? { deviation: { kind: plan.deviation.kind, taskId: plan.deviation.taskId, detail: plan.deviation.detail, at: plan.deviation.at } }
      : {}),
    ...(plan.supersedes !== undefined ? { supersedes: plan.supersedes } : {}),
    ...(plan.appliedTaskIds !== undefined ? { appliedTaskIds: [...plan.appliedTaskIds] } : {}),
    ...(plan.tempToTaskId !== undefined ? { tempToTaskId: { ...plan.tempToTaskId } } : {}),
    ...(plan.approval !== undefined
      ? { approval: { approvalId: plan.approval.approvalId, at: plan.approval.at, ...(plan.approval.by !== undefined ? { by: plan.approval.by } : {}) } }
      : {}),
    createdAt: plan.createdAt,
    ...(plan.settledAt !== undefined ? { settledAt: plan.settledAt } : {}),
  };
}

/** contingency 全快照载荷（保键序）。 */
export function contingencyPayload(contingency: PlanContingency): JsonObject {
  return {
    id: contingency.id,
    revision: contingency.revision,
    planId: contingency.planId,
    primaryTaskId: contingency.primaryTaskId,
    alternativeTaskId: contingency.alternativeTaskId,
    trigger: triggerPayload(contingency.trigger),
    status: contingency.status,
    carveOut: contingency.carveOut,
    ...(contingency.activationApprovalId !== undefined
      ? { activationApprovalId: contingency.activationApprovalId }
      : {}),
    ...(contingency.triggeredAt !== undefined ? { triggeredAt: contingency.triggeredAt } : {}),
    ...(contingency.resolvedAt !== undefined ? { resolvedAt: contingency.resolvedAt } : {}),
    ...(contingency.reason !== undefined ? { reason: contingency.reason } : {}),
  };
}

/** params 全快照载荷（业务 id 恒为 'params'）。 */
export function plannerParamsPayload(params: PlannerParams): JsonObject {
  // 键序 = PlannerParamsSchema 定义序（revision 在前；compareReplay 逐字节比对）
  return {
    revision: params.revision,
    autoExpire: params.autoExpire,
    activationAutonomy: params.activationAutonomy,
    replanThreshold: params.replanThreshold,
    verifyFailThreshold: params.verifyFailThreshold,
    schemaVersion: params.schemaVersion,
  };
}
