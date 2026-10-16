/**
 * tda-intake 服务面（T4.2 §4.2 `ctx.intake`）。
 *
 * 硬纪律（全部在类型级或运行时强制）：
 *  - **原文零入域**：draft 只存 `rawEntryId`——原始需求全文的唯一载体是 T0.3
 *    timeline user-original chunk（J2/不变量 1）；answer 超长截断；
 *  - **问题确定性**：`deriveQuestions` 是导出纯函数（模板机械生成，J3）——
 *    提问面是注入面，禁 LLM 产问题集；OpenQuestion 无 provider 字段（类型级）；
 *  - **分解校验门**：`validateProposal` 纯函数（J4）——LLM 分解是建议，校验是
 *    权威；不过闸禁提请（confirmRequest 拒绝）；
 *  - **零目标编辑权**：goalTree seam 只有 `create` 一个写方法（J7/不变量 6）——
 *    唯一代建时刻是经审批的结构性动作，此后目标变更加回 T0.1 CAS 面；
 *  - **审批门**：commit 必经 `kind='requirement-confirm'` + 一次性 ResumeTicket（J5）；
 *  - **轮次帽**：clarificationRounds ≤ maxClarificationRounds；超帽 escalation
 *    提请一次性决断（J8，禁静默继续/禁无限澄清）；
 *  - **单活动草稿**（J11）：新 intake 遇活动草稿 fail-loud；遇 committed 草稿
 *    自动 supersede（链指针，已建目标不动）；
 *  - **零注入直通**：requirement-draft/goal-tree-proposal schema 无任务指令类
 *    字段（J12/不变量 7——intake 不碰任务层）。
 */
import {
  allocateId,
  asDraftId,
  asIntakeProposalId,
  dualWrite,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  DEFAULT_INTAKE_PARAMS,
  DRAFT_ACTIVE_STATUSES,
  INTAKE_PARAMS_BUSINESS_ID,
  INTAKE_PARAMS_KEY,
  IntakeParamsSchema,
  type DraftStatus,
  type GoalTreeProposal,
  type IntakeParams,
  type IntakeTables,
  type OpenQuestion,
  type ProposedGoalNode,
  type RequirementDraft,
  type ValidationReport,
} from './domain.ts';
import { draftPayload, intakeParamsPayload, proposalPayload } from './events.ts';

/** intake 的固定 actor（J6：代建走 goalTree.create，服务端身份）。 */
export const INTAKE_ACTOR = 'agent';
/** ResumeTicket 的 from 标识（审批桥按此校验票据归属）。 */
export const INTAKE_TICKET_FROM = 'ctx.intake';

// ── 只读/受控写 seam（结构镜像：J7 类型级零目标编辑权） ────────────────

export interface IntakeGoalCreateRequest {
  readonly objective: string;
  readonly completionCriteria?: readonly string[];
  readonly parentId?: string | undefined;
  readonly budget?:
    | {
        tokens?: number | undefined;
        wallClockMs?: number | undefined;
        attentionUnits?: number | undefined;
      }
    | undefined;
  readonly maxGoalRounds?: number | undefined;
  readonly pinned?: readonly string[];
  /** P4（T4.2 §3.4 v2）：来源与提议溯源（代建必带）。 */
  readonly source?: 'intake' | 'human';
  readonly intakeProposalId?: string;
}

export interface IntakeGoalView {
  readonly id: string;
  readonly objective: string;
  readonly source?: string | undefined;
  readonly intakeProposalId?: string | undefined;
}

/** J7/不变量 6：唯一写方法 create + 只读 get（无 edit/clear/delete——类型级切断）。 */
export interface IntakeGoalSeam {
  create(actor: string, req: IntakeGoalCreateRequest): Promise<IntakeGoalView>;
  get(id: string): IntakeGoalView | undefined;
}

export interface IntakeSupervisionSeam {
  request(input: {
    kind: string;
    requester: { service: string; ref: string };
    subject: string;
    whatToShow: {
      summary: string;
      impact: readonly { target: string; change: 'create' | 'update' | 'invalidate' | 'execute'; reversible: boolean }[];
      riskReasons: readonly string[];
      evidence: readonly { kind: string; ref: string }[];
    };
    resume: { from: string; handle: string };
    goalId?: string;
    riskHint?: 'low' | 'medium' | 'high';
  }): Promise<{ approvalId: string }>;
}

/** J2：原文唯一载体=timeline user-original chunk；本 seam 只暴露"登记原文"一个动作。 */
export interface IntakeTimelineSeam {
  appendUserOriginal(content: string): Promise<{ entryId: string }>;
}

/** J3：LLM 抽取工序（Sidekick one-shot；原文经 rawEntryId 由适配层取，插件不经手全文）。 */
export interface DraftExtractInput {
  readonly rawEntryId: string;
}
export interface DraftExtractResult {
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly budgetHint?: { tokens?: number; wallClockMs?: number; attentionUnits?: number };
  readonly generation: { provider: string; model: string; schemaHash: string };
}
export type DraftExtractor = (input: DraftExtractInput) => Promise<DraftExtractResult>;

/** J4：Lead 分解工序（schema 白名单 goal-tree-proposal；无任务指令字段）。 */
export interface DecomposeInput {
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
}
export interface DecomposeResult {
  readonly nodes: readonly ProposedGoalNode[];
  readonly generation: { provider: string; model: string; schemaHash: string };
}
export type TreeDecomposer = (input: DecomposeInput) => Promise<DecomposeResult>;

export interface ResumeTicketLike {
  readonly approvalId: string;
  readonly nonce: string;
  readonly from: string;
  readonly handle: string;
}

export interface DraftFilter {
  readonly status?: DraftStatus;
}

export interface IntakeService {
  initialize(): Promise<void>;
  intake(actor: 'human' | 'lead', raw: { text: string }): Promise<RequirementDraft>;
  extract(draftId: string): Promise<RequirementDraft>;
  deriveQuestions(draftId: string): readonly OpenQuestion[];
  answer(
    actor: 'human' | 'lead',
    draftId: string,
    answers: readonly { questionId: string; answer: string }[],
  ): Promise<RequirementDraft>;
  propose(draftId: string): Promise<GoalTreeProposal>;
  confirmRequest(actor: 'human' | 'lead', proposalId: string): Promise<{ approvalId: string }>;
  commit(proposalId: string, token: ResumeTicketLike): Promise<readonly string[]>;
  reject(proposalId: string, token: ResumeTicketLike): Promise<GoalTreeProposal>;
  drafts(filter?: DraftFilter): readonly RequirementDraft[];
  draft(id: string): RequirementDraft | undefined;
  proposals(): readonly GoalTreeProposal[];
  proposal(id: string): GoalTreeProposal | undefined;
  params(): IntakeParams;
  setParams(actor: 'human' | 'lead', patch: Partial<Omit<IntakeParams, 'revision'>>): Promise<IntakeParams>;
}

export interface IntakeDeps {
  readonly domain: TdaDomain<IntakeTables>;
  readonly session: TdaSessionSink;
  readonly goalTree: IntakeGoalSeam;
  readonly supervision: IntakeSupervisionSeam;
  readonly timeline: IntakeTimelineSeam;
  /** J3：LLM 抽取工序（缺省 ⇒ extract 抛 NO_EXTRACTOR）。 */
  readonly extractor?: DraftExtractor;
  /** J4：Lead 分解工序（缺省 ⇒ propose 抛 NO_DECOMPOSER）。 */
  readonly decomposer?: TreeDecomposer;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly config?: Partial<IntakeParams>;
}

/** TdaKvTable 无 values()：entries 解构出值序列（模块级纯助手）。 */
const tableRecords = <V>(table: { readonly entries: () => IterableIterator<[string, V]> }): readonly V[] =>
  [...table.entries()].map(([, value]) => value);

// ── 纯函数：澄清问题生成（J3，确定性模板，禁 LLM） ─────────────────────

export interface QuestionSeedInput {
  readonly objective: string;
  readonly completionCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly budgetHint?:
    | {
        tokens?: number | undefined;
        wallClockMs?: number | undefined;
        attentionUnits?: number | undefined;
      }
    | undefined;
}

/**
 * 澄清问题机械生成（不变量 2；同输入同输出，单测逐分支）：
 *  - objective 空 ⇒ blocking（无目标陈述不可继续）；
 *  - completionCriteria 空 ⇒ blocking（无完成标准不可 ready）；
 *  - constraints 空 ⇒ 非 blocking（可后补，C5）；
 *  - budgetHint 缺 ⇒ 非 blocking（提议可细化）。
 * id 稳定（q-objective/q-criteria/q-constraints/q-budget）——answer 按 id 回写。
 */
export function deriveQuestionsFromSeed(seed: QuestionSeedInput): readonly OpenQuestion[] {
  const questions: OpenQuestion[] = [];
  if (seed.objective.trim() === '') {
    questions.push({
      id: 'q-objective',
      field: 'objective',
      question: '这条需求要达成的一句话目标是什么？（who 在什么边界内做到 what）',
      blocking: true,
    });
  }
  if (seed.completionCriteria.length === 0) {
    questions.push({
      id: 'q-criteria',
      field: 'completionCriteria',
      question: '怎样算完成？请给出至少一条可核对完成与否的标准。',
      blocking: true,
    });
  }
  if (seed.constraints.length === 0) {
    questions.push({
      id: 'q-constraints',
      field: 'constraints',
      question: '有哪些硬约束（不可越过的边界/预算上限/禁改区域）？没有可跳过。',
      blocking: false,
    });
  }
  if (
    seed.budgetHint?.tokens === undefined &&
    seed.budgetHint?.wallClockMs === undefined &&
    seed.budgetHint?.attentionUnits === undefined
  ) {
    questions.push({
      id: 'q-budget',
      field: 'budget',
      question: '是否给定初始预算帽（token/时长/注意力）？不设则继承默认。',
      blocking: false,
    });
  }
  return questions;
}

/** 校验项 id（J4/不变量 3）。 */
export const VALIDATION_CHECK_IDS = [
  'nodes-nonempty',
  'criteria-nonempty',
  'temp-refs-complete',
  'dag-acyclic',
  'root-unique',
  'budget-legal',
] as const;

/**
 * 目标树提议确定性校验（J4/不变量 3；纯函数，禁 LLM）：
 * ① 节点非空 ② 每节点 completionCriteria 非空 ③ tempId 引用完备（parentTempId 在场）
 * ④ 父子图无环 ⑤ 根唯一（恰一个无 parentTempId 节点）⑥ 预算合法（在场维度 > 0）。
 */
export function validateProposal(nodes: readonly ProposedGoalNode[]): ValidationReport {
  const checks: ValidationReport['checks'] = [];
  const check = (id: string, passed: boolean, detail: string): void => {
    checks.push({ id, passed, detail });
  };

  check('nodes-nonempty', nodes.length > 0, nodes.length > 0 ? `${nodes.length} 个提议节点` : '提议为空');

  const byTempId = new Map(nodes.map((node) => [node.tempId, node]));
  const emptyCriteria = nodes.filter((node) => node.completionCriteria.length === 0).map((node) => node.tempId);
  check(
    'criteria-nonempty',
    emptyCriteria.length === 0,
    emptyCriteria.length === 0 ? '全部节点完成标准非空' : `完成标准为空：[${emptyCriteria.join(', ')}]`,
  );

  const dangling = nodes
    .filter((node) => node.parentTempId !== undefined && !byTempId.has(node.parentTempId))
    .map((node) => node.tempId);
  check(
    'temp-refs-complete',
    dangling.length === 0,
    dangling.length === 0 ? 'tempId 引用完备' : `引用不存在的父节点：[${dangling.join(', ')}]`,
  );

  const visiting = new Set<string>();
  const done = new Set<string>();
  const cycleNodes: string[] = [];
  const walk = (current: string): void => {
    if (done.has(current)) return;
    if (visiting.has(current)) {
      cycleNodes.push(current);
      return;
    }
    visiting.add(current);
    const parent = byTempId.get(current)?.parentTempId;
    if (parent !== undefined) walk(parent);
    visiting.delete(current);
    done.add(current);
  };
  for (const node of nodes) walk(node.tempId);
  check(
    'dag-acyclic',
    cycleNodes.length === 0,
    cycleNodes.length === 0 ? '父子图无环' : `父子成环：[${cycleNodes.join(', ')}]`,
  );

  const roots = nodes.filter((node) => node.parentTempId === undefined);
  check('root-unique', roots.length === 1, roots.length === 1 ? '根唯一' : `根数=${roots.length}（须恰一）`);

  const badBudget = nodes
    .filter((node) =>
      Object.values(node.budget ?? {}).some((value) => value !== undefined && value <= 0),
    )
    .map((node) => node.tempId);
  check(
    'budget-legal',
    badBudget.length === 0,
    badBudget.length === 0 ? '预算合法' : `预算维度 ≤0：[${badBudget.join(', ')}]`,
  );

  return { passed: checks.every((item) => item.passed), checks };
}

// ── 服务实现 ────────────────────────────────────────────────────────────

export function createIntakeService(deps: IntakeDeps): IntakeService {
  const clock = deps.now ?? ((): number => Date.now());
  const bus = deps.bus;
  /** 一次性 ResumeTicket 的进程内消费记录（跨进程重放防护归 supervision 的 token 语义）。 */
  const consumedTickets = new Set<string>();
  const dualContext: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };

  let chain: Promise<unknown> = Promise.resolve();
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const draftsTable = () => deps.domain.table('intake_drafts');
  const proposalsTable = () => deps.domain.table('intake_proposals');
  const paramsTable = () => deps.domain.table('intake_params');

  /** 统一出口：dualWrite（域+事件配对）后 bus.publish（纪律 #6）。 */
  const commit = async (
    businessId: string,
    payload: import('@tda/kernel').JsonObject,
    domainWrite: () => void | Promise<void>,
  ): Promise<number> => {
    const seq = await dualWrite(
      deps.session,
      { family: 'intake/change', businessId, payload, domainWrite },
      dualContext,
    );
    if (bus !== undefined) {
      bus.publish({
        family: 'intake/change',
        businessId,
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
    return seq;
  };

  const putDraft = async (draft: RequirementDraft): Promise<void> => {
    await draftsTable().put(draft.id, draft);
  };
  const putProposal = async (proposal: GoalTreeProposal): Promise<void> => {
    await proposalsTable().put(proposal.id, proposal);
  };

  const commitDraft = async (
    current: RequirementDraft,
    mutate: (draft: RequirementDraft) => RequirementDraft,
  ): Promise<RequirementDraft> => {
    const next = mutate({ ...current, revision: current.revision + 1 });
    await commit(next.id, draftPayload(next), async () => {
      await putDraft(next);
    });
    return next;
  };

  const commitProposal = async (
    current: GoalTreeProposal,
    mutate: (proposal: GoalTreeProposal) => GoalTreeProposal,
  ): Promise<GoalTreeProposal> => {
    const next = mutate({ ...current, revision: current.revision + 1 });
    await commit(next.id, proposalPayload(next), async () => {
      await putProposal(next);
    });
    return next;
  };

  const readParams = (): IntakeParams => {
    const stored = paramsTable().get(INTAKE_PARAMS_KEY);
    if (stored !== undefined) return stored;
    return { ...DEFAULT_INTAKE_PARAMS, ...deps.config, revision: 0 };
  };

  const seedParams = async (): Promise<void> => {
    if (paramsTable().get(INTAKE_PARAMS_KEY) !== undefined) return;
    const params: IntakeParams = { ...DEFAULT_INTAKE_PARAMS, ...deps.config, revision: 0 };
    await commit(INTAKE_PARAMS_BUSINESS_ID, intakeParamsPayload(params), async () => {
      await paramsTable().put(INTAKE_PARAMS_KEY, params);
    });
  };

  const mustDraft = (draftId: string): RequirementDraft => {
    const draft = draftsTable().get(draftId);
    if (draft === undefined) throw new TdaError('DRAFT_NOT_FOUND', `需求草稿不存在：${draftId}`);
    return draft;
  };
  const mustProposal = (proposalId: string): GoalTreeProposal => {
    const proposal = proposalsTable().get(proposalId);
    if (proposal === undefined) throw new TdaError('PROPOSAL_NOT_FOUND', `目标树提议不存在：${proposalId}`);
    return proposal;
  };

  /** 票据校验（一次性；身份/重放先拦，状态后查——同 T4.1/T4.5 裁定）。 */
  const verifyTicket = (
    ticket: ResumeTicketLike,
    handle: string,
    currentStatus: string,
    allowedStatuses: readonly string[],
    notAwaitingMessage: string,
  ): void => {
    if (ticket.from !== INTAKE_TICKET_FROM || ticket.handle !== handle) {
      throw new TdaError(
        'RESUME_TICKET_MISMATCH',
        `ResumeTicket 不指向本记录（from=${ticket.from}, handle=${ticket.handle}，期望 ${handle}）`,
      );
    }
    if (consumedTickets.has(ticket.nonce)) {
      throw new TdaError('RESUME_TICKET_REPLAY', 'ResumeTicket nonce 已消费（一次性）');
    }
    if (!allowedStatuses.includes(currentStatus)) {
      throw new TdaError('RECORD_NOT_AWAITING', notAwaitingMessage);
    }
    consumedTickets.add(ticket.nonce);
  };

  /** 按答案回写重导问题（保留已答项；新问题接续编号）。 */
  const applyAnswers = (
    draft: RequirementDraft,
    answers: readonly { questionId: string; answer: string }[],
  ): { openQuestions: OpenQuestion[]; answered: number } => {
    const maxChars = readParams().maxAnswerChars;
    const answeredIds = new Set(answers.map((item) => item.questionId));
    let answered = 0;
    const openQuestions = draft.openQuestions.map((question) => {
      if (!answeredIds.has(question.id)) return question;
      const raw = answers.find((item) => item.questionId === question.id)?.answer ?? '';
      answered += 1;
      return {
        ...question,
        answer: raw.length > maxChars ? `${raw.slice(0, maxChars)}…（截断，全文见时间线补充 chunk）` : raw,
        answeredAt: clock(),
      };
    });
    return { openQuestions, answered };
  };

  /** 代建序（J6/不变量 11）：父先子后；环在校验门④拒之，此处再 fail-loud。 */
  const commitOrder = (nodes: readonly ProposedGoalNode[]): readonly ProposedGoalNode[] => {
    const byTempId = new Map(nodes.map((node) => [node.tempId, node]));
    const indegree = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const node of nodes) indegree.set(node.tempId, 0);
    for (const node of nodes) {
      if (node.parentTempId !== undefined && byTempId.has(node.parentTempId)) {
        indegree.set(node.tempId, (indegree.get(node.tempId) ?? 0) + 1);
        const list = children.get(node.parentTempId) ?? [];
        list.push(node.tempId);
        children.set(node.parentTempId, list);
      }
    }
    const queue = nodes.filter((node) => (indegree.get(node.tempId) ?? 0) === 0).map((node) => node.tempId);
    const ordered: ProposedGoalNode[] = [];
    while (queue.length > 0) {
      const tempId = queue.shift() as string;
      const node = byTempId.get(tempId);
      if (node !== undefined) ordered.push(node);
      for (const child of children.get(tempId) ?? []) {
        indegree.set(child, (indegree.get(child) ?? 0) - 1);
        if ((indegree.get(child) ?? 0) === 0) queue.push(child);
      }
    }
    if (ordered.length !== nodes.length) {
      throw new TdaError('PROPOSAL_NOT_TOPOLOGICAL', '提议节点无法拓扑排序（父子成环，校验门④应已拒）');
    }
    return ordered;
  };

  return {
    async initialize() {
      return withLock(async () => {
        await seedParams();
      });
    },

    async intake(actor, raw) {
      return withLock(async () => {
        void actor;
        if (raw.text.trim() === '') {
          throw new TdaError('EMPTY_REQUIREMENT', '原始需求文本为空（禁建空草稿）');
        }
        // J11 单活动草稿：活动草稿在场 ⇒ fail-loud；committed 草稿 ⇒ supersede 链
        const all = [...draftsTable().entries()].map(([, draft]) => draft);
        const active = all.find((draft) => (DRAFT_ACTIVE_STATUSES as readonly string[]).includes(draft.status));
        if (active !== undefined) {
          throw new TdaError(
            'ACTIVE_DRAFT_EXISTS',
            `存在未终态草稿 ${active.id}（${active.status}），须先终态化再提新需求（J11 单活动草稿）`,
          );
        }
        const supersededTarget = all
          .filter((draft) => draft.status === 'committed')
          .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        // J2：原文唯一载体=timeline user-original chunk（域内只存引用）
        const { entryId } = await deps.timeline.appendUserOriginal(raw.text);
        const seed: QuestionSeedInput = { objective: '', completionCriteria: [], constraints: [] };
        const draft: RequirementDraft = {
          id: asDraftId(allocateId(draftsTable(), 'req')),
          revision: 0,
          status: 'drafting',
          rawEntryId: entryId,
          objective: '',
          completionCriteria: [],
          constraints: [],
          openQuestions: [...deriveQuestionsFromSeed(seed)],
          clarificationRounds: 0,
          extraction: { provider: 'pending', model: 'pending', schemaHash: 'pending', at: clock() },
          ...(supersededTarget !== undefined ? { supersedes: supersededTarget.id } : {}),
          createdAt: clock(),
          updatedAt: clock(),
        };
        await commit(draft.id, draftPayload(draft), async () => {
          await putDraft(draft);
        });
        // supersede 链指针回写（旧 committed → superseded；已建目标不动，J7）
        if (supersededTarget !== undefined) {
          await commitDraft(supersededTarget, (previous) => ({
            ...previous,
            status: 'superseded',
            settledAt: clock(),
          }));
        }
        return draft;
      });
    },

    async extract(draftId) {
      return withLock(async () => {
        if (deps.extractor === undefined) {
          throw new TdaError('NO_EXTRACTOR', 'intake 未注入 LLM 抽取工序（J3：禁假造草稿）');
        }
        const draft = mustDraft(draftId);
        if (draft.status !== 'drafting') {
          throw new TdaError('DRAFT_NOT_DRAFTING', `草稿 ${draftId} 非 drafting（${draft.status}），禁重复抽取`);
        }
        // 原文不经手：适配层按 rawEntryId 自取（插件全程无全文）
        const result = await deps.extractor({ rawEntryId: draft.rawEntryId });
        const seed: QuestionSeedInput = {
          objective: result.objective,
          completionCriteria: result.completionCriteria,
          constraints: result.constraints,
          ...(result.budgetHint !== undefined ? { budgetHint: result.budgetHint } : {}),
        };
        const openQuestions = deriveQuestionsFromSeed(seed);
        const blockingRemain = openQuestions.some((question) => question.blocking && question.answer === undefined);
        const updated = await commitDraft(draft, (previous) => ({
          ...previous,
          status: blockingRemain ? 'drafting' : 'ready',
          objective: result.objective,
          completionCriteria: [...result.completionCriteria],
          constraints: [...result.constraints],
          ...(result.budgetHint !== undefined ? { budgetHint: { ...result.budgetHint } } : {}),
          openQuestions: [...openQuestions],
          extraction: { ...result.generation, at: clock() },
          updatedAt: clock(),
        }));
        return updated;
      });
    },

    deriveQuestions(draftId) {
      const draft = mustDraft(draftId);
      return deriveQuestionsFromSeed({
        objective: draft.objective,
        completionCriteria: draft.completionCriteria,
        constraints: draft.constraints,
        ...(draft.budgetHint !== undefined ? { budgetHint: draft.budgetHint } : {}),
      });
    },

    async answer(actor, draftId, answers) {
      return withLock(async () => {
        void actor;
        const draft = mustDraft(draftId);
        if (draft.status !== 'drafting') {
          throw new TdaError('DRAFT_NOT_DRAFTING', `草稿 ${draftId} 非 drafting（${draft.status}），禁澄清回写`);
        }
        const params = readParams();
        if (draft.clarificationRounds >= params.maxClarificationRounds) {
          // J8 轮次帽：超帽禁继续澄清——escalation 已在上轮提请（决断中）
          throw new TdaError(
            'CLARIFICATION_CAP_REACHED',
            `澄清轮次已达帽（${draft.clarificationRounds}/${params.maxClarificationRounds}），escalation 决断中，禁静默继续`,
          );
        }
        const applied = applyAnswers(draft, answers);
        if (applied.answered === 0) {
          throw new TdaError('NO_MATCHING_QUESTION', '回写的 questionId 均不在草稿 openQuestions 中');
        }
        // 重导：已答项保留（同 id），新增问题接续
        const seed: QuestionSeedInput = {
          objective: draft.objective,
          completionCriteria: draft.completionCriteria,
          constraints: draft.constraints,
          ...(draft.budgetHint !== undefined ? { budgetHint: draft.budgetHint } : {}),
        };
        const fresh = deriveQuestionsFromSeed(seed);
        const merged: OpenQuestion[] = [...applied.openQuestions];
        for (const question of fresh) {
          if (!merged.some((item) => item.id === question.id)) merged.push(question);
        }
        const blockingRemain = merged.some((question) => question.blocking && question.answer === undefined);
        const rounds = draft.clarificationRounds + 1;
        const updated = await commitDraft(draft, (previous) => ({
          ...previous,
          status: blockingRemain ? 'drafting' : 'ready',
          openQuestions: merged,
          clarificationRounds: rounds,
          updatedAt: clock(),
        }));
        // J8 超帽 escalation：blocking 仍存且已达帽 ⇒ 带全量 openQuestions 提请一次性决断
        if (blockingRemain && rounds >= params.maxClarificationRounds) {
          const openList = merged
            .filter((question) => question.blocking && question.answer === undefined)
            .map((question) => `${question.id}:${question.question}`)
            .join(' | ');
          await deps.supervision.request({
            kind: 'requirement-clarify',
            requester: { service: INTAKE_TICKET_FROM, ref: draftId },
            subject: `澄清超帽决断：草稿 ${draftId} 剩余 blocking 问题`.slice(0, 120),
            whatToShow: {
              summary: `澄清 ${rounds}/${params.maxClarificationRounds} 轮后仍有 blocking 问题：${openList}`.slice(0, 300),
              impact: [{ target: draftId, change: 'update', reversible: true }],
              riskReasons: ['澄清轮次帽（J8）：注意力预算，禁无限澄清'],
              evidence: [{ kind: 'draft', ref: draftId }],
            },
            resume: { from: INTAKE_TICKET_FROM, handle: draftId },
          });
        }
        return updated;
      });
    },

    async propose(draftId) {
      return withLock(async () => {
        if (deps.decomposer === undefined) {
          throw new TdaError('NO_DECOMPOSER', 'intake 未注入 Lead 分解工序（J4：禁假造分解）');
        }
        const draft = mustDraft(draftId);
        if (draft.status !== 'ready') {
          throw new TdaError('DRAFT_NOT_READY', `草稿 ${draftId} 非 ready（${draft.status}），禁提请分解`);
        }
        const result = await deps.decomposer({
          objective: draft.objective,
          completionCriteria: draft.completionCriteria,
          constraints: draft.constraints,
        });
        const validation = validateProposal(result.nodes);
        const proposal: GoalTreeProposal = {
          id: asIntakeProposalId(allocateId(proposalsTable(), 'goalp')),
          revision: 0,
          draftId,
          status: 'draft',
          nodes: [...result.nodes],
          validation,
          decomposition: { ...result.generation, at: clock() },
          createdAt: clock(),
        };
        await commit(proposal.id, proposalPayload(proposal), async () => {
          await putProposal(proposal);
        });
        if (!validation.passed) {
          // J4：不过闸禁提请——提议留档（审计），显式抛（禁静默）
          const failed = validation.checks.filter((item) => !item.passed).map((item) => item.detail).join('；');
          throw new TdaError('VALIDATION_FAILED', `目标树提议校验未过：${failed}`);
        }
        await commitDraft(draft, (previous) => ({
          ...previous,
          status: 'proposed',
          proposalId: proposal.id,
          updatedAt: clock(),
        }));
        return proposal;
      });
    },

    async confirmRequest(actor, proposalId) {
      return withLock(async () => {
        void actor;
        const proposal = mustProposal(proposalId);
        if (proposal.status !== 'draft') {
          throw new TdaError('PROPOSAL_NOT_DRAFT', `提议 ${proposalId} 非 draft（${proposal.status}），禁重复提请`);
        }
        if (!proposal.validation.passed) {
          throw new TdaError('VALIDATION_NOT_PASSED', `提议 ${proposalId} 校验未过，禁提请（J4）`);
        }
        const draft = mustDraft(proposal.draftId);
        const approval = await deps.supervision.request({
          kind: 'requirement-confirm',
          requester: { service: INTAKE_TICKET_FROM, ref: proposalId },
          subject: `目标树确认：${draft.objective.slice(0, 60)}（将建 ${proposal.nodes.length} 个目标）`.slice(0, 120),
          whatToShow: {
            summary: `目标树 ${proposal.nodes.length} 节点，完成标准 ${draft.completionCriteria.length} 条${draft.constraints.length > 0 ? `，约束 ${draft.constraints.length} 条` : ''}`,
            impact: [{ target: proposalId, change: 'create', reversible: true }],
            riskReasons: ['建目标是后续一切执行的源头（决策点⑤：须人在场）；v1 定级 medium（目标可 edit/clear）'],
            evidence: [
              { kind: 'proposal', ref: proposalId },
              { kind: 'draft', ref: draft.id },
            ],
          },
          resume: { from: INTAKE_TICKET_FROM, handle: proposalId },
        });
        await commitProposal(proposal, (previous) => ({ ...previous, status: 'pending-approval' }));
        return { approvalId: approval.approvalId };
      });
    },

    async commit(proposalId, token) {
      return withLock(async () => {
        const proposal = mustProposal(proposalId);
        verifyTicket(
          token,
          proposalId,
          proposal.status,
          ['pending-approval'],
          `提议 ${proposalId} 非 pending-approval（${proposal.status}），禁凭票代建`,
        );
        const draft = mustDraft(proposal.draftId);
        const ordered = commitOrder(proposal.nodes);
        const tempToGoalId = new Map<string, string>();
        const created: string[] = [];
        // 不变量 11：中途失败已建节点保留 + proposal 落 cancelled（禁静默回滚半棵树）
        try {
          for (const node of ordered) {
            const view = await deps.goalTree.create(INTAKE_ACTOR, {
              objective: node.objective,
              completionCriteria: node.completionCriteria,
              ...(node.parentTempId !== undefined && tempToGoalId.get(node.parentTempId) !== undefined
                ? { parentId: tempToGoalId.get(node.parentTempId) }
                : {}),
              ...(node.budget !== undefined ? { budget: { ...node.budget } } : {}),
              ...(node.maxGoalRounds !== undefined ? { maxGoalRounds: node.maxGoalRounds } : {}),
              ...(node.pinned !== undefined ? { pinned: [...node.pinned] } : {}),
              source: 'intake',
              intakeProposalId: proposal.id,
            });
            tempToGoalId.set(node.tempId, view.id);
            created.push(view.id);
          }
        } catch (error) {
          await commitProposal(proposal, (previous) => ({
            ...previous,
            status: 'cancelled',
            createdGoalIds: [...created],
            settledAt: clock(),
          }));
          throw error;
        }
        // commit 双写：proposal → committed + createdGoalIds 回填；draft → committed
        await commitProposal(proposal, (previous) => ({
          ...previous,
          status: 'committed',
          createdGoalIds: [...created],
          approval: { approvalId: token.approvalId, at: clock() },
          settledAt: clock(),
        }));
        await commitDraft(draft, (previous) => ({
          ...previous,
          status: 'committed',
          proposalId: proposal.id,
          settledAt: clock(),
          updatedAt: clock(),
        }));
        return created;
      });
    },

    async reject(proposalId, token) {
      return withLock(async () => {
        const proposal = mustProposal(proposalId);
        verifyTicket(
          token,
          proposalId,
          proposal.status,
          ['pending-approval'],
          `提议 ${proposalId} 非 pending-approval（${proposal.status}），禁凭票驳回`,
        );
        const rejected = await commitProposal(proposal, (previous) => ({
          ...previous,
          status: 'rejected',
          settledAt: clock(),
        }));
        const draft = [...draftsTable().entries()].map(([, record]) => record).find((record) => record.id === rejected.draftId);
        if (draft !== undefined && draft.status === 'proposed') {
          await commitDraft(draft, (previous) => ({
            ...previous,
            status: 'rejected',
            settledAt: clock(),
            updatedAt: clock(),
          }));
        }
        return rejected;
      });
    },

    drafts(filter) {
      const all = tableRecords(draftsTable());
      return filter?.status === undefined ? all : all.filter((draft) => draft.status === filter.status);
    },

    draft(id) {
      return draftsTable().get(id);
    },

    proposals() {
      return tableRecords(proposalsTable());
    },

    proposal(id) {
      return proposalsTable().get(id);
    },

    params() {
      return readParams();
    },

    async setParams(actor, patch) {
      return withLock(async () => {
        void actor;
        const current = readParams();
        const parsed = IntakeParamsSchema.parse({ ...current, ...patch, revision: current.revision + 1 });
        await commit(INTAKE_PARAMS_BUSINESS_ID, intakeParamsPayload(parsed), async () => {
          await paramsTable().put(INTAKE_PARAMS_KEY, parsed);
        });
        return parsed;
      });
    },
  };
}
