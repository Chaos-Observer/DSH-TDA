/**
 * tda-skill-registry 事件载荷（T2.2 不变量 9 审计面）。
 * 族 `skill/change`：业务 id = `skill:<id>` / `skill-rehearsal:<id>` / `skill-use:<id>` / `params`。
 */
import type { JsonObject } from '@tda/kernel';
import type { Skill, SkillParams, SkillRehearsalRun, SkillUse } from './domain.ts';

export const SKILL_BUSINESS_PREFIX = 'skill';
export const SKILL_REHEARSAL_BUSINESS_PREFIX = 'skill-rehearsal';
export const SKILL_USE_BUSINESS_PREFIX = 'skill-use';
export const SKILL_PARAMS_BUSINESS_ID = 'params';

export function skillPayload(skill: Skill, action: string): JsonObject {
  return {
    action,
    id: String(skill.id),
    name: skill.name,
    kind: skill.kind,
    version: skill.version,
    credential: skill.credential,
    source: skill.source.kind,
    stats: { ...skill.stats },
    ...(skill.supersedes !== undefined ? { supersedes: skill.supersedes } : {}),
    ...(skill.conflict !== undefined ? { conflict: { ...skill.conflict } } : {}),
    at: skill.updatedAt,
  };
}

export function skillRehearsalPayload(run: SkillRehearsalRun): JsonObject {
  return {
    id: run.id,
    skillId: run.skillId,
    taskId: run.taskId,
    childSessionId: run.childSessionId,
    boundary: { ...run.boundary },
    verdict: run.verdict,
    coverage: run.coverage,
    outcome: run.outcome,
    at: run.at,
  };
}

export function skillUsePayload(use: SkillUse): JsonObject {
  return {
    id: use.id,
    skillId: use.skillId,
    taskId: use.taskId,
    sessionId: use.sessionId,
    outcome: use.outcome,
    eloBefore: use.eloBefore,
    eloAfter: use.eloAfter,
    k: use.k,
    at: use.at,
  };
}

export function skillParamsPayload(params: SkillParams): JsonObject {
  return {
    thetaCov: params.thetaCov,
    maxConsecutiveRehearsalFail: params.maxConsecutiveRehearsalFail,
    maxConsecutiveUseFail: params.maxConsecutiveUseFail,
    unusedDays: params.unusedDays,
    maxActiveSkills: params.maxActiveSkills,
    eloK: params.eloK,
    eloBaseline: params.eloBaseline,
    promoteMinRealUse: params.promoteMinRealUse,
    govWeights: { ...params.govWeights },
    topKInject: params.topKInject,
    revision: params.revision,
  };
}
