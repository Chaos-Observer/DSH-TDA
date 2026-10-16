/**
 * tda-intake 域定义（T4.2 §3.3 存储落点）。
 *
 * 三表，**全部权威**（`invalidRecords: 'reject'`）：
 *  - `intake_drafts`：RequirementDraft 全快照（CAS revision+1）。需求草稿是审计
 *    事实——"这个草稿是谁用什么产生的"（ExtractionMeta 随记录落盘，J9）；
 *  - `intake_proposals`：GoalTreeProposal 全快照。目标树提议+确定性校验报告
 *    （J4：LLM 分解是建议，校验门是权威）；
 *  - `intake_params`：策略权威（澄清轮帽/答案截断阈值/审批定级/schemaVersion）。
 *
 * **原文零入域**（J2/不变量 1）：draft/proposal 只存 `rawEntryId` 引用——原始需求
 * 文本的唯一载体是 T0.3 timeline user-original chunk，域内禁存全文（不变量 1）。
 *
 * 零目标编辑权（J7/不变量 6）：deps 类型级只注入 `goalTree.create` 一个写方法 +
 * 只读面——唯一代建时刻（J6）是经审批的结构性动作，此后一切目标变更加回 T0.1。
 */
import { asDraftId, asIntakeProposalId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

export const DRAFT_PREFIX = 'req';
export const INTAKE_PROPOSAL_PREFIX = 'goalp';
export const INTAKE_PARAMS_KEY = 'singleton';
/** params 行的稳定业务 id（T0.7 不变量 7：配对事件稳定 id）。 */
export const INTAKE_PARAMS_BUSINESS_ID = 'params';

/** 草稿状态机（T4.2 §2）。 */
export const DRAFT_STATUSES = [
  'drafting',
  'ready',
  'proposed',
  'committed',
  'rejected',
  'cancelled',
  'superseded',
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_ACTIVE_STATUSES = ['drafting', 'ready', 'proposed'] as const;
export const DRAFT_TERMINAL_STATUSES = ['committed', 'rejected', 'cancelled', 'superseded'] as const;

/** 提议状态机（T4.2 §2 尾注）。 */
export const PROPOSAL_STATUSES = [
  'draft',
  'pending-approval',
  'approved',
  'rejected',
  'cancelled',
  'committed',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** 澄清问题字段枚举（J3；OpenQuestion 无 provider 来源字段——类型级保证）。 */
export const QUESTION_FIELDS = ['objective', 'completionCriteria', 'constraints', 'budget', 'scope'] as const;
export type QuestionField = (typeof QUESTION_FIELDS)[number];

export const OpenQuestionSchema = z.object({
  /** q-<n>（草稿内稳定）。 */
  id: z.string(),
  field: z.enum(QUESTION_FIELDS),
  /** 确定性模板生成（J3：服务端纯函数，禁 LLM 产问题集）。 */
  question: z.string(),
  /** true=不答不可 ready。 */
  blocking: z.boolean(),
  /** 回写答案（≤ maxAnswerChars 截断+引用，不变量 1）。 */
  answer: z.string().optional(),
  answeredAt: z.number().optional(),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

/** LLM 工序元数据（J9：随记录落盘，回放可解释）。 */
const LlmMetaSchema = z.object({
  provider: z.string(),
  model: z.string(),
  schemaHash: z.string(),
  at: z.number(),
});
export type LlmMeta = z.infer<typeof LlmMetaSchema>;

/** 预算帽候选（提议可细化；维度与 T0.1 GoalBudgetCaps 对齐）。 */
export const BudgetHintSchema = z.object({
  tokens: z.number().optional(),
  wallClockMs: z.number().optional(),
  attentionUnits: z.number().optional(),
});
export type BudgetHint = z.infer<typeof BudgetHintSchema>;

export const RequirementDraftSchema = z
  .object({
    id: z.string().transform(asDraftId),
    revision: z.number(),
    status: z.enum(DRAFT_STATUSES),
    /** 原文 timeline chunk（user-original）；域内禁存全文（不变量 1）。 */
    rawEntryId: z.string(),
    /** 一句话目标陈述。 */
    objective: z.string(),
    /** ≥1 方可 ready。 */
    completionCriteria: z.array(z.string()),
    /** 硬约束候选（C5；确认后进 goal pinned）。 */
    constraints: z.array(z.string()),
    budgetHint: BudgetHintSchema.optional(),
    openQuestions: z.array(OpenQuestionSchema),
    /** 帽内（J8）。 */
    clarificationRounds: z.number().int().min(0),
    extraction: LlmMetaSchema,
    /** 需求变更链（J7：只登记指针，已建目标不动）。 */
    supersedes: z.string().optional(),
    proposalId: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    settledAt: z.number().optional(),
  })
  .superRefine((draft, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    const terminal = (DRAFT_TERMINAL_STATUSES as readonly string[]).includes(draft.status);
    if (terminal && draft.settledAt === undefined) issue(`终态 ${draft.status} 必携 settledAt`);
    if (!terminal && draft.settledAt !== undefined) issue(`非终态 ${draft.status} 不得携带 settledAt`);
    if (draft.status === 'committed' && draft.proposalId === undefined) {
      issue('committed 草稿必携 proposalId（代建溯源）');
    }
    if (draft.status === 'drafting' && draft.openQuestions.length === 0) {
      issue('drafting 态必携 openQuestions（空则应为 ready——由 deriveQuestions 判定，禁手工造空）');
    }
    if (draft.status !== 'drafting' && draft.status !== 'superseded') {
      // 非 drafting 态不允许存留 blocking 未答问题（ready 判定纪律）
      const openBlocking = draft.openQuestions.filter((question) => question.blocking && question.answer === undefined);
      if (openBlocking.length > 0) {
        issue(`status=${draft.status} 不得携未答 blocking 问题（${openBlocking.map((question) => question.id).join(',')}）`);
      }
    }
  });
export type RequirementDraft = z.infer<typeof RequirementDraftSchema>;

export const ProposedGoalNodeSchema = z.object({
  /** 'g1' / 'g1.1' …（提议内稳定；commit 时映射真实 GoalId）。 */
  tempId: z.string(),
  parentTempId: z.string().optional(),
  objective: z.string(),
  /** 非空（校验门）。 */
  completionCriteria: z.array(z.string()),
  budget: BudgetHintSchema.optional(),
  maxGoalRounds: z.number().optional(),
  /** 来自草稿 constraints（C6）。 */
  pinned: z.array(z.string()).optional(),
});
export type ProposedGoalNode = z.infer<typeof ProposedGoalNodeSchema>;

export const ValidationReportSchema = z.object({
  passed: z.boolean(),
  checks: z.array(
    z.object({
      id: z.string(),
      passed: z.boolean(),
      /** 消毒摘要（禁原文）。 */
      detail: z.string(),
    }),
  ),
});
export type ValidationReport = z.infer<typeof ValidationReportSchema>;

export const GoalTreeProposalSchema = z
  .object({
    id: z.string().transform(asIntakeProposalId),
    revision: z.number(),
    draftId: z.string(),
    status: z.enum(PROPOSAL_STATUSES),
    /** 拓扑序：父先子后（commit 依序创建）。 */
    nodes: z.array(ProposedGoalNodeSchema),
    validation: ValidationReportSchema,
    decomposition: LlmMetaSchema,
    approval: z
      .object({
        approvalId: z.string(),
        at: z.number(),
        by: z.string().optional(),
      })
      .optional(),
    /** commit 后回填（T0.1 v2 source/intakeProposalId 的对偶引用）。 */
    createdGoalIds: z.array(z.string()).optional(),
    createdAt: z.number(),
    settledAt: z.number().optional(),
  })
  .superRefine((proposal, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (proposal.nodes.length === 0) issue('提议必含至少一个节点（空提议禁存）');
    if (proposal.status !== 'draft' && !proposal.validation.passed) {
      issue(`status=${proposal.status} 离开 draft 前校验门必过（J4）`);
    }
    const terminal = ['committed', 'rejected', 'cancelled'].includes(proposal.status);
    if (terminal && proposal.settledAt === undefined) issue(`终态 ${proposal.status} 必携 settledAt`);
    if (!terminal && proposal.settledAt !== undefined) issue(`非终态 ${proposal.status} 不得携带 settledAt`);
    if (proposal.status === 'committed') {
      if (proposal.approval === undefined) issue('committed 提议必携 approval（审批门）');
      if ((proposal.createdGoalIds?.length ?? 0) !== proposal.nodes.length) {
        issue('committed 提议必回填与 nodes 等长的 createdGoalIds');
      }
    }
  });
export type GoalTreeProposal = z.infer<typeof GoalTreeProposalSchema>;

export const IntakeParamsSchema = z.object({
  revision: z.number(),
  /** v1=3（J8：防澄清地狱）。 */
  maxClarificationRounds: z.number().int().min(1),
  /** v1=2000（答案截断阈值；超长引用新 chunk）。 */
  maxAnswerChars: z.number().int().min(1),
  confirmRisk: z.enum(['medium']),
  clarifyRisk: z.enum(['low']),
  /** requirement-draft/goal-tree-proposal schema 版本。 */
  schemaVersion: z.number().int().min(1),
});
export type IntakeParams = z.infer<typeof IntakeParamsSchema>;

export const DEFAULT_INTAKE_PARAMS: IntakeParams = {
  revision: 0,
  maxClarificationRounds: 3,
  maxAnswerChars: 2000,
  confirmRisk: 'medium',
  clarifyRisk: 'low',
  schemaVersion: 1,
};

export type IntakeTables = {
  intake_drafts: typeof RequirementDraftSchema;
  intake_proposals: typeof GoalTreeProposalSchema;
  intake_params: typeof IntakeParamsSchema;
};

export const intakeDomainSpec = defineTdaDomain({
  name: 'tda-intake',
  version: 1,
  tables: {
    intake_drafts: RequirementDraftSchema,
    intake_proposals: GoalTreeProposalSchema,
    intake_params: IntakeParamsSchema,
  },
  layout: 'single',
  invalidRecords: 'reject',
});
