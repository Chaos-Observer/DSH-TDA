/**
 * tda-intake 事件载荷（族 `intake/change`，第二十一族，内核 events.ts 登记）。
 *
 * 纪律（T0.7 J2 + 施工范式 #26）：payload 键序**必须与 schema 定义序一致**
 * （compareReplay 是 stringify 逐字节比对，键序漂移=回放分歧假红）；
 * 可选键仅在在场时挂（缺键不挂 undefined——JSON 无损）。
 */
import type { JsonObject } from '@tda/kernel';
import type { GoalTreeProposal, IntakeParams, RequirementDraft } from './domain.ts';

function questionsPayload(questions: RequirementDraft['openQuestions']): JsonObject[] {
  return questions.map((question) => ({
    id: question.id,
    field: question.field,
    question: question.question,
    blocking: question.blocking,
    ...(question.answer !== undefined ? { answer: question.answer } : {}),
    ...(question.answeredAt !== undefined ? { answeredAt: question.answeredAt } : {}),
  }));
}

function llmMetaPayload(meta: RequirementDraft['extraction']): JsonObject {
  return {
    provider: meta.provider,
    model: meta.model,
    schemaHash: meta.schemaHash,
    at: meta.at,
  };
}

/** draft 全快照载荷（逐字段显式构造，保键序）。 */
export function draftPayload(draft: RequirementDraft): JsonObject {
  return {
    id: draft.id,
    revision: draft.revision,
    status: draft.status,
    rawEntryId: draft.rawEntryId,
    objective: draft.objective,
    completionCriteria: [...draft.completionCriteria],
    constraints: [...draft.constraints],
    ...(draft.budgetHint !== undefined
      ? {
          budgetHint: {
            ...(draft.budgetHint.tokens !== undefined ? { tokens: draft.budgetHint.tokens } : {}),
            ...(draft.budgetHint.wallClockMs !== undefined ? { wallClockMs: draft.budgetHint.wallClockMs } : {}),
            ...(draft.budgetHint.attentionUnits !== undefined
              ? { attentionUnits: draft.budgetHint.attentionUnits }
              : {}),
          },
        }
      : {}),
    openQuestions: questionsPayload(draft.openQuestions),
    clarificationRounds: draft.clarificationRounds,
    extraction: llmMetaPayload(draft.extraction),
    ...(draft.supersedes !== undefined ? { supersedes: draft.supersedes } : {}),
    ...(draft.proposalId !== undefined ? { proposalId: draft.proposalId } : {}),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    ...(draft.settledAt !== undefined ? { settledAt: draft.settledAt } : {}),
  };
}

/** proposal 全快照载荷（保键序）。 */
export function proposalPayload(proposal: GoalTreeProposal): JsonObject {
  return {
    id: proposal.id,
    revision: proposal.revision,
    draftId: proposal.draftId,
    status: proposal.status,
    nodes: proposal.nodes.map((node) => ({
      tempId: node.tempId,
      ...(node.parentTempId !== undefined ? { parentTempId: node.parentTempId } : {}),
      objective: node.objective,
      completionCriteria: [...node.completionCriteria],
      ...(node.budget !== undefined
        ? {
            budget: {
              ...(node.budget.tokens !== undefined ? { tokens: node.budget.tokens } : {}),
              ...(node.budget.wallClockMs !== undefined ? { wallClockMs: node.budget.wallClockMs } : {}),
              ...(node.budget.attentionUnits !== undefined
                ? { attentionUnits: node.budget.attentionUnits }
                : {}),
            },
          }
        : {}),
      ...(node.maxGoalRounds !== undefined ? { maxGoalRounds: node.maxGoalRounds } : {}),
      ...(node.pinned !== undefined ? { pinned: [...node.pinned] } : {}),
    })),
    validation: {
      passed: proposal.validation.passed,
      checks: proposal.validation.checks.map((check) => ({
        id: check.id,
        passed: check.passed,
        detail: check.detail,
      })),
    },
    decomposition: llmMetaPayload(proposal.decomposition),
    ...(proposal.approval !== undefined
      ? {
          approval: {
            approvalId: proposal.approval.approvalId,
            at: proposal.approval.at,
            ...(proposal.approval.by !== undefined ? { by: proposal.approval.by } : {}),
          },
        }
      : {}),
    ...(proposal.createdGoalIds !== undefined ? { createdGoalIds: [...proposal.createdGoalIds] } : {}),
    createdAt: proposal.createdAt,
    ...(proposal.settledAt !== undefined ? { settledAt: proposal.settledAt } : {}),
  };
}

/** params 全快照载荷（业务 id 恒为 'params'）。 */
export function intakeParamsPayload(params: IntakeParams): JsonObject {
  return {
    revision: params.revision,
    maxClarificationRounds: params.maxClarificationRounds,
    maxAnswerChars: params.maxAnswerChars,
    confirmRisk: params.confirmRisk,
    clarifyRisk: params.clarifyRisk,
    schemaVersion: params.schemaVersion,
  };
}
