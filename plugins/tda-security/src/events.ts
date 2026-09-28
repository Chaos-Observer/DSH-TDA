/**
 * T3.4 · events。T3.4 不立新事件族（规格裁定）：安全运行/发现的双写事件暂挂
 * supervision/change 族（同属人类审计面），businessId 以 security- 前缀隔离。
 */
import type { RedTeamCase, RedTeamParams, RedTeamRun, SecurityFinding } from './domain.ts';
import type { JsonObject } from '@tda/kernel';

export const CASE_BUSINESS_PREFIX = 'security-case';
export const RUN_BUSINESS_PREFIX = 'security-run';
export const FINDING_BUSINESS_PREFIX = 'security-finding';

export function casePayload(caseRow: RedTeamCase): JsonObject {
  return {
    caseId: String(caseRow.caseId),
    kind: caseRow.kind,
    version: caseRow.version,
    ...(caseRow.supersedes !== undefined ? { supersedes: caseRow.supersedes } : {}),
    title: caseRow.title,
    fixture: { hash: caseRow.fixture.hash, entryPoint: caseRow.fixture.entryPoint },
    target: { spec: caseRow.target.spec, invariantId: caseRow.target.invariantId },
    expectedVerdict: caseRow.expectedVerdict,
    severityIfBreached: caseRow.severityIfBreached,
    citations: [...caseRow.citations],
    createdAt: caseRow.createdAt,
  };
}

export function runPayload(run: RedTeamRun): JsonObject {
  return {
    runId: String(run.runId),
    kind: run.kind,
    at: run.at,
    status: run.status,
    env: run.env,
    casesTotal: run.casesTotal,
    results: run.results.map((result) => ({
      caseId: result.caseId,
      caseVersion: result.caseVersion,
      actual: result.actual,
      ...(result.findingId !== undefined ? { findingId: result.findingId } : {}),
      durationMs: result.durationMs,
    })),
    ...(run.unfinished !== undefined ? { unfinished: [...run.unfinished] } : {}),
  };
}

export function findingPayload(finding: SecurityFinding): JsonObject {
  return {
    findingId: String(finding.findingId),
    severity: finding.severity,
    sourceRunId: finding.sourceRunId,
    sourceCaseId: finding.sourceCaseId,
    clauseRef: finding.clauseRef,
    status: finding.status,
    ...(finding.fixSpecRef !== undefined ? { fixSpecRef: finding.fixSpecRef } : {}),
    ...(finding.regressionRunId !== undefined ? { regressionRunId: finding.regressionRunId } : {}),
    ...(finding.acceptance !== undefined
      ? {
          acceptance: {
            reason: finding.acceptance.reason,
            scope: finding.acceptance.scope,
            tokenRef: finding.acceptance.tokenRef,
            reviewAt: finding.acceptance.reviewAt,
          },
        }
      : {}),
    openedAt: finding.openedAt,
    updatedAt: finding.updatedAt,
  };
}

export function paramsPayload(params: RedTeamParams): JsonObject {
  return {
    requiredClauseCoverage: params.requiredClauseCoverage,
    gateBlockingSeverities: [...params.gateBlockingSeverities],
    matrixInstances: [...params.matrixInstances],
    fixtureRetentionDays: params.fixtureRetentionDays,
    revision: params.revision,
  };
}
