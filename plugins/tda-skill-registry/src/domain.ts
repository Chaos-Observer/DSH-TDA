/**
 * T2.2 技能生命周期 v1 —— domain（四表，全 backup-and-skip）。
 *
 * J10 边界：procedure = 能力单元操作序列（动作分类 + contract 引用），**禁编排
 * 控制流**（条件分支/审批/预算声明进不了 schema）——防 skill 长成影子编排器。
 * 零原文泄漏（不变量 4）：steps 只有分类字段，无参数值/正文槽位。
 * lifecycle 不在本 domain（J1/不变量 8）：单一权威在 ctx.governance（assetKind='skill'）。
 */
import { z } from 'zod';
import { asSkillId, asSkillUseId, defineTdaDomain } from '@tda/kernel';

export const SKILL_KINDS = ['procedure', 'composite'] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

export const SKILL_SOURCE_KINDS = ['coach-candidate', 'human', 'trajectory-extract', 'external-adopted'] as const;
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

export const SKILL_CREDENTIALS = ['model-produced', 'user-original', 'tool-output', 'external-content', 'execution-verified'] as const;
export type SkillCredential = (typeof SKILL_CREDENTIALS)[number];

export const SKILL_USE_OUTCOMES = ['success', 'failure', 'partial'] as const;
export type SkillUseOutcome = (typeof SKILL_USE_OUTCOMES)[number];

export const SKILL_REHEARSAL_VERDICTS = ['pass', 'fail'] as const;

export const SkillStepSchema = z.object({
  /** 动作分类（工具/子代理公开名或分类串，禁参数值）。 */
  action: z.string(),
  argClass: z.string().optional(),
  contractRef: z.string().optional(),
});

export const SkillSchema = z
  .object({
    id: z.string().transform(asSkillId),
    /** 稳定名 kebab-case（同名 propose 拒绝，J9 ①）。 */
    name: z.string(),
    summary: z.string(),
    kind: z.enum(SKILL_KINDS),
    procedure: z.object({
      steps: z.array(SkillStepSchema),
      prerequisites: z.array(z.string()),
    }),
    applicability: z.object({
      taskClasses: z.array(z.string()),
      stages: z.array(z.string()),
      problemFeatures: z.array(z.string()),
    }),
    source: z.object({
      kind: z.enum(SKILL_SOURCE_KINDS),
      refs: z.array(z.object({ sessionId: z.string(), seqFrom: z.number(), seqTo: z.number() })),
    }),
    credential: z.enum(SKILL_CREDENTIALS),
    stats: z.object({
      rehearsalPass: z.number(),
      rehearsalFail: z.number(),
      consecutiveRehearsalFail: z.number(),
      realUse: z.number(),
      consecutiveUseFail: z.number(),
      elo: z.number(),
    }),
    version: z.number(),
    supersedes: z.string().optional(),
    conflict: z
      .object({
        with: z.array(z.string()),
        kind: z.enum(['near-dup', 'contradiction']),
        detectedAt: z.number(),
      })
      .optional(),
    /** 被哪些 composite 依赖（退役时标记，不级联删除，J9）。 */
    dependents: z.array(z.string()).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .superRefine((skill, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (skill.summary.length > 120) issue(`summary 超 120 字符（渐进披露描述上限，收到 ${skill.summary.length}）`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.name)) issue(`name 须 kebab-case（收到 ${skill.name}）`);
    // J10 边界：技能 schema 禁编排控制流
    for (const forbidden of ['if', 'branch', 'approval', 'budget', 'condition']) {
      if (skill.procedure.steps.some((step) => step.action === `__${forbidden}__`)) {
        issue(`步骤含编排控制流标记 ${forbidden}（技能 ≠ 编排定义，J10）`);
      }
    }
    if (skill.procedure.steps.some((step) => step.action.length > 80)) {
      issue('步骤 action 超 80 字符（疑似正文/参数值泄漏）');
    }
  });
export type Skill = z.infer<typeof SkillSchema>;

export const SkillRehearsalRunSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  taskId: z.string(),
  childSessionId: z.string(),
  boundary: z.object({ sessionId: z.string(), eventKind: z.string(), seq: z.number() }),
  verdict: z.enum(SKILL_REHEARSAL_VERDICTS),
  coverage: z.number(),
  outcome: z.enum(['success', 'failure']),
  at: z.number(),
});
export type SkillRehearsalRun = z.infer<typeof SkillRehearsalRunSchema>;

export const SkillUseSchema = z
  .object({
    id: z.string().transform(asSkillUseId),
    skillId: z.string(),
    taskId: z.string(),
    sessionId: z.string(),
    outcome: z.enum(SKILL_USE_OUTCOMES),
    eloBefore: z.number(),
    eloAfter: z.number(),
    /** 当时 K 值（复算必需，不变量 7）。 */
    k: z.number(),
    at: z.number(),
  })
  .superRefine((use, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (use.k <= 0) issue(`K 值须 >0（收到 ${use.k}）`);
  });
export type SkillUse = z.infer<typeof SkillUseSchema>;

export const SkillParamsSchema = z
  .object({
    thetaCov: z.number(),
    maxConsecutiveRehearsalFail: z.number(),
    maxConsecutiveUseFail: z.number(),
    unusedDays: z.number(),
    maxActiveSkills: z.number(),
    eloK: z.number(),
    eloBaseline: z.number(),
    promoteMinRealUse: z.number(),
    govWeights: z.object({ elo: z.number(), reuse: z.number(), recency: z.number() }),
    topKInject: z.number(),
    revision: z.number(),
  })
  .superRefine((params, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (params.thetaCov < 0 || params.thetaCov > 1) issue(`thetaCov 须落在 [0,1]（收到 ${params.thetaCov}）`);
    if (params.eloK <= 0) issue(`eloK 须 >0（收到 ${params.eloK}）`);
    if (params.maxActiveSkills < 1) issue(`maxActiveSkills 须 ≥1（收到 ${params.maxActiveSkills}）`);
    const sum = params.govWeights.elo + params.govWeights.reuse + params.govWeights.recency;
    if (Math.abs(sum - 1) > 1e-9) issue(`govWeights 和须为 1（收到 ${sum}）`);
  });
export type SkillParams = z.infer<typeof SkillParamsSchema>;

export const DEFAULT_SKILL_PARAMS: SkillParams = {
  thetaCov: 0.6,
  maxConsecutiveRehearsalFail: 3,
  maxConsecutiveUseFail: 3,
  unusedDays: 30,
  maxActiveSkills: 50,
  eloK: 24,
  eloBaseline: 1500,
  promoteMinRealUse: 1,
  govWeights: { elo: 0.4, reuse: 0.3, recency: 0.3 },
  topKInject: 3,
  revision: 0,
};

export const SKILL_PARAMS_KEY = 'singleton';

export type SkillTables = {
  skills: typeof SkillSchema;
  skill_rehearsal_runs: typeof SkillRehearsalRunSchema;
  skill_usage_log: typeof SkillUseSchema;
  skill_params: typeof SkillParamsSchema;
};

export const skillDomainSpec = defineTdaDomain({
  name: 'tda-skill-registry',
  version: 1,
  tables: {
    skills: SkillSchema,
    skill_rehearsal_runs: SkillRehearsalRunSchema,
    skill_usage_log: SkillUseSchema,
    skill_params: SkillParamsSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});
