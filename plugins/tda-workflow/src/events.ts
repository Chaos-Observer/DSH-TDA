/**
 * tda-workflow 事件载荷（T2.5 §5 审计面；族 `workflow/change` 第七扩展族）。
 */
import type { JsonObject } from '@tda/kernel';
import type { WorkflowDefinition, WorkflowEvent, WorkflowParams, WorkflowRun } from './domain.ts';

export const WORKFLOW_DEF_BUSINESS_PREFIX = 'workflow-def';
export const WORKFLOW_RUN_BUSINESS_PREFIX = 'workflow-run';
export const WORKFLOW_EVENT_BUSINESS_PREFIX = 'workflow-event';
export const WORKFLOW_PARAMS_BUSINESS_ID = 'params';

export function workflowDefPayload(def: WorkflowDefinition, action: string): JsonObject {
  return {
    action,
    defId: String(def.defId),
    version: def.version,
    kind: def.kind,
    ...(def.parentTemplateId !== undefined ? { parentTemplateId: def.parentTemplateId } : {}),
    name: def.name,
    source: def.source,
    scriptHash: def.scriptHash,
    steps: def.meta.steps.length,
    createdBy: { ...def.createdBy },
    at: def.createdAt,
  };
}

export function workflowRunPayload(run: WorkflowRun, action: string): JsonObject {
  return {
    action,
    runId: String(run.runId),
    defId: run.defId,
    defVersion: run.defVersion,
    taskId: run.taskId,
    status: run.status,
    stepStates: { ...run.stepStates },
    deviation: { ...run.deviation },
    ...(run.outcome !== undefined ? { outcome: run.outcome } : {}),
    ...(run.unfinished !== undefined ? { unfinished: [...run.unfinished] } : {}),
    at: run.endedAt ?? run.startedAt,
  };
}

export function workflowEventPayload(event: WorkflowEvent): JsonObject {
  return {
    id: String(event.id),
    runId: event.runId,
    kind: event.kind,
    ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
    detail: { ...event.detail } as Record<string, string | number | boolean | null>,
    at: event.at,
  };
}

export function workflowParamsPayload(params: WorkflowParams): JsonObject {
  return {
    defaultDeviationBudget: { ...params.defaultDeviationBudget },
    maxConcurrentRuns: params.maxConcurrentRuns,
    approvalTokenTtlMs: params.approvalTokenTtlMs,
    revision: params.revision,
  };
}
