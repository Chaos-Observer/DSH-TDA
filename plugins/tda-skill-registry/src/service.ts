/**
 * tda-skill-registry 服务面（T2.2 §4.2）。
 *
 * 三个铁律落点：
 *  - 回放入职（不变量 1）：非 external-adopted 未经 rehearsal pass 不进 validating；
 *  - 晋升双条件（不变量 2）：consolidated ⇔ rehearsalPass≥1 ∧ realUse≥N ∧ last success；
 *  - 治理单一（不变量 8）：本服务无 lifecycle 字段——一切迁移经 ctx.governance。
 */
import {
  DEFAULT_SKILL_PARAMS,
  SKILL_PARAMS_KEY,
  SkillParamsSchema,
  SkillSchema,
  skillDomainSpec,
  type Skill,
  type SkillParams,
  type SkillRehearsalRun,
  type SkillTables,
  type SkillUse,
} from './domain.ts';
import {
  SKILL_BUSINESS_PREFIX,
  SKILL_PARAMS_BUSINESS_ID,
  SKILL_REHEARSAL_BUSINESS_PREFIX,
  SKILL_USE_BUSINESS_PREFIX,
  skillParamsPayload,
  skillPayload,
  skillRehearsalPayload,
  skillUsePayload,
} from './events.ts';
import {
  dualWrite,
  TdaError,
  asSkillId,
  asSkillUseId,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';

export type SkillActor = {
  readonly actor: 'agent' | 'human' | 'coach' | 'scheduler';
  readonly sessionId: string;
};

export type SkillLifecycle = 'draft' | 'validating' | 'consolidated' | 'retired';

/** 治理 seam（结构镜像 tda-governance 服务面子集；零 import，J1）。 */
export interface SkillGovernanceSeam {
  lifecycleOf(assetId: string, assetKind?: string): SkillLifecycle | undefined;
  promoteAsset(actor: SkillActor, assetId: string, assetKind: string, note: string): Promise<unknown>;
  consolidate(actor: SkillActor, assetId: string, assetKind?: string): Promise<unknown>;
  retire(
    actor: SkillActor,
    assetId: string,
    reason: { readonly kind: string; readonly detail: string },
    opts?: { readonly approvalToken?: string },
    assetKind?: string,
  ): Promise<unknown>;
}

/** rehearsal 执行器 seam（fork 委托 T0.7 J6；判定输入全落盘，J5）。 */
export interface SkillRehearsalExecutor {
  readonly run: (input: {
    readonly skill: Skill;
    readonly taskId: string;
  }) => Promise<{
    readonly childSessionId: string;
    readonly boundary: { readonly sessionId: string; readonly eventKind: string; readonly seq: number };
    readonly outcome: 'success' | 'failure';
    readonly coverage: number;
  }>;
}

/** consolidated 物化回调（DSH skills 技能源目录写 SKILL.md；v1 由装配层提供）。 */
export interface SkillMaterializer {
  readonly write: (skill: Skill) => Promise<void>;
  readonly remove: (skill: Skill) => Promise<void>;
}

export interface SkillDeps {
  readonly domain: TdaDomain<SkillTables>;
  readonly session: TdaSessionSink;
  readonly governance: SkillGovernanceSeam;
  readonly executor: SkillRehearsalExecutor;
  readonly materializer?: SkillMaterializer | undefined;
  readonly now?: (() => number) | undefined;
  readonly reconciler?: DualWriteReconciler | undefined;
  readonly index?: AuditIndex | undefined;
  readonly bus?: TdaEventBus | undefined;
}

export interface SkillDraft {
  readonly name: string;
  readonly summary: string;
  readonly kind?: 'procedure' | 'composite';
  readonly procedure: {
    readonly steps: readonly { readonly action: string; readonly argClass?: string; readonly contractRef?: string }[];
    readonly prerequisites: readonly string[];
  };
  readonly applicability: {
    readonly taskClasses: readonly string[];
    readonly stages: readonly string[];
    readonly problemFeatures?: readonly string[] | undefined;
  };
  readonly source:
    | { readonly kind: 'coach-candidate' | 'human' | 'trajectory-extract'; readonly refs?: readonly { readonly sessionId: string; readonly seqFrom: number; readonly seqTo: number }[] }
    | { readonly kind: 'external-adopted'; readonly dshSkillRef: string };
  readonly credential: Skill['credential'];
  readonly supersedes?: string;
}

export interface SkillInjectItem {
  readonly skill: Skill;
  /** validating 技能带"验证中"标注（J3 双通道可见性）。 */
  readonly validating: boolean;
}

export interface SkillService {
  initialize(): Promise<void>;
  propose(actor: SkillActor, draft: SkillDraft): Promise<Skill>;
  adoptExternal(actor: SkillActor, ref: { readonly name: string; readonly dshSkillRef: string; readonly summary?: string }): Promise<Skill>;
  extractFromTrajectory(refs: readonly { readonly sessionId: string; readonly seqFrom: number; readonly seqTo: number }[], tokens: readonly string[]): SkillDraft;
  rehearse(actor: SkillActor, skillId: string, taskId: string): Promise<SkillRehearsalRun>;
  logUse(actor: SkillActor, skillId: string, taskId: string, outcome: SkillUse['outcome']): Promise<SkillUse>;
  requestConsolidate(actor: SkillActor, skillId: string): Promise<unknown>;
  supersede(actor: SkillActor, oldId: string, draft: SkillDraft): Promise<Skill>;
  injectCandidates(filter?: { readonly taskClass?: string; readonly stage?: string }): readonly SkillInjectItem[];
  skills(filter?: { readonly lifecycle?: SkillLifecycle; readonly taskClass?: string; readonly stage?: string }): readonly Skill[];
  history(skillId: string): readonly Skill[];
  params(): SkillParams;
  setParams(patch: Partial<Omit<SkillParams, 'revision'>>): Promise<SkillParams>;
}

const ELO_EXPECTATION = (baseline: number, rating: number): number => 1 / (1 + 10 ** ((baseline - rating) / 400));

export function createSkillService(deps: SkillDeps): SkillService {
  const clock = deps.now ?? ((): number => Date.now());
  const context: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };
  const emit = async (op: Parameters<typeof dualWrite>[1]): Promise<number> => {
    const seq = await dualWrite(deps.session, op, context);
    deps.bus?.publish({
      family: op.family,
      businessId: op.businessId,
      payload: op.payload,
      seq,
      sessionId: deps.session.sessionId,
    });
    return seq;
  };
  const skillsTable = deps.domain.table('skills');
  const runsTable = deps.domain.table('skill_rehearsal_runs');
  const usageTable = deps.domain.table('skill_usage_log');
  const paramsTable = deps.domain.table('skill_params');

  const skills = new Map<string, Skill>();
  let skillCounter = 0;
  let runCounter = 0;
  let useCounter = 0;
  let paramsRef: SkillParams | undefined;

  const loadParams = (): SkillParams => {
    if (paramsRef !== undefined) return paramsRef;
    const row = paramsTable.get(SKILL_PARAMS_KEY) as SkillParams | undefined;
    if (row !== undefined) {
      paramsRef = row;
      return row;
    }
    paramsRef = { ...DEFAULT_SKILL_PARAMS };
    return paramsRef;
  };

  const lifecycleOf = (skillId: string): SkillLifecycle =>
    deps.governance.lifecycleOf(skillId, 'skill') ?? 'draft';

  const requireSkill = (id: string): Skill => {
    const row = skills.get(id);
    if (row === undefined) throw new TdaError('SKILL_NOT_FOUND', `技能 ${id} 不存在`);
    return row;
  };

  const persistSkill = async (skill: Skill, action: string): Promise<void> => {
    skills.set(String(skill.id), skill);
    await emit({
      family: 'skill/change',
      businessId: `${SKILL_BUSINESS_PREFIX}:${String(skill.id)}`,
      payload: skillPayload(skill, action),
      domainWrite: async () => {
        await skillsTable.put(String(skill.id), skill as never);
      },
    });
  };

  /** 写时冲突检测（J9 三型，只标不裁；v1 简化口径记 U 项）。 */
  const detectConflict = (draft: SkillDraft): Skill['conflict'] | undefined => {
    const overlap = (a: readonly string[], b: readonly string[]): boolean =>
      a.some((item) => b.includes(item));
    for (const existing of skills.values()) {
      if (existing.name === draft.name) {
        throw new TdaError('SKILL_NAME_TAKEN', `同名技能已存在：${draft.name}（name 是稳定标识，收敛走 supersede）`);
      }
      const applicOverlap =
        overlap([...draft.applicability.taskClasses], existing.applicability.taskClasses) ||
        overlap([...draft.applicability.stages], existing.applicability.stages);
      if (!applicOverlap) continue;
      const draftActions = new Set(draft.procedure.steps.map((step) => step.action));
      const existingActions = new Set(existing.procedure.steps.map((step) => step.action));
      const common = [...draftActions].filter((action) => existingActions.has(action)).length;
      const maxSize = Math.max(draftActions.size, existingActions.size);
      if (maxSize > 0 && common / maxSize >= 0.5) {
        // ①② applicability 重叠 + procedure 相似 → near-dup
        return { with: [String(existing.id)], kind: 'near-dup', detectedAt: clock() };
      }
      if (draftActions.size > 0 && existingActions.size > 0 && common === 0) {
        // ③ applicability 重叠 + 关键动作零交集 = 同场景互斥做法 → contradiction（只标不裁）
        return { with: [String(existing.id)], kind: 'contradiction', detectedAt: clock() };
      }
    }
    return undefined;
  };

  return {
    async initialize() {
      loadParams();
      // 重启恢复：从域表装载（skillCounter 续号）
      for (const [key, value] of skillsTable.entries()) {
        skills.set(key, value as Skill);
      }
      skillCounter = [...skillsTable.keys()].length;
      runCounter = [...runsTable.keys()].length;
      useCounter = [...usageTable.keys()].length;
      if (paramsTable.get(SKILL_PARAMS_KEY) === undefined) {
        await emit({
          family: 'skill/change',
          businessId: SKILL_PARAMS_BUSINESS_ID,
          payload: skillParamsPayload(loadParams()),
          domainWrite: async () => {
            await paramsTable.put(SKILL_PARAMS_KEY, loadParams() as never);
          },
        });
      }
    },

    async propose(_actor, draft) {
      const conflict = detectConflict(draft);
      const at = clock();
      const id = asSkillId(`sk-${++skillCounter}`);
      const skill: Skill = SkillSchema.parse({
        id,
        name: draft.name,
        summary: draft.summary,
        kind: draft.kind ?? 'procedure',
        procedure: {
          steps: draft.procedure.steps.map((step) => ({ ...step })),
          prerequisites: [...draft.procedure.prerequisites],
        },
        applicability: {
          taskClasses: [...draft.applicability.taskClasses],
          stages: [...draft.applicability.stages],
          problemFeatures: [...(draft.applicability.problemFeatures ?? [])],
        },
        source: {
          kind: draft.source.kind,
          refs:
            draft.source.kind === 'external-adopted'
              ? []
              : [...(draft.source.refs ?? [])],
        },
        credential: draft.credential,
        stats: {
          rehearsalPass: 0,
          rehearsalFail: 0,
          consecutiveRehearsalFail: 0,
          realUse: 0,
          consecutiveUseFail: 0,
          elo: loadParams().eloBaseline,
        },
        version: 1,
        ...(draft.supersedes !== undefined ? { supersedes: draft.supersedes } : {}),
        ...(conflict !== undefined ? { conflict } : {}),
        createdAt: at,
        updatedAt: at,
      });
      // 前置依赖标记（J9：被依赖方记录 dependents，不级联）
      await persistSkill(skill, 'propose');
      return skill;
    },

    async adoptExternal(actor, ref) {
      const at = clock();
      const id = asSkillId(`sk-${++skillCounter}`);
      const skill: Skill = SkillSchema.parse({
        id,
        name: ref.name,
        summary: ref.summary ?? `外部采纳：${ref.dshSkillRef}`,
        kind: 'procedure',
        procedure: { steps: [{ action: 'external:invoke' }], prerequisites: [] },
        applicability: { taskClasses: [], stages: [], problemFeatures: [] },
        source: { kind: 'external-adopted', refs: [] },
        credential: 'user-original',
        stats: {
          rehearsalPass: 0,
          rehearsalFail: 0,
          consecutiveRehearsalFail: 0,
          realUse: 0,
          consecutiveUseFail: 0,
          elo: loadParams().eloBaseline,
        },
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      await persistSkill(skill, 'adopt');
      // J4 例外：人类采纳动作本身即外部验证阀——draft → validating（免 rehearsal）
      await deps.governance.promoteAsset(actor, String(skill.id), 'skill', 'external-adopted: human gate');
      return skill;
    },

    extractFromTrajectory(refs, tokens) {
      // 机械抽取（J11 ③）：transition 分类串 → procedure 骨架（去重保序）
      const actions: string[] = [];
      for (const token of tokens) {
        if (actions[actions.length - 1] !== token) actions.push(token);
      }
      if (actions.length === 0) actions.push('other:noop');
      return {
        name: 'trajectory-extract-pending-name',
        summary: '轨迹提炼骨架（需人工/coach 修订后 propose）',
        kind: 'procedure',
        procedure: { steps: actions.map((action) => ({ action })), prerequisites: [] },
        applicability: { taskClasses: [], stages: ['executing'], problemFeatures: [] },
        source: { kind: 'trajectory-extract', refs: refs.map((ref) => ({ ...ref })) },
        credential: 'execution-verified',
      };
    },

    async rehearse(actor, skillId, taskId) {
      const params = loadParams();
      const skill = requireSkill(skillId);
      const lifecycle = lifecycleOf(skillId);
      if (lifecycle === 'retired') {
        throw new TdaError('SKILL_RETIRED', `技能 ${skillId} 已退役，不得 rehearsal`);
      }
      if (skill.source.kind === 'external-adopted') {
        throw new TdaError('SKILL_REHEARSAL_NA', 'external-adopted 免 rehearsal（人类即阀，J4）');
      }
      // 前置依赖在库（J9/不变量 3）：composite 前置须全 consolidated
      for (const prerequisiteId of skill.procedure.prerequisites) {
        const lifecyclePre = lifecycleOf(prerequisiteId);
        if (lifecyclePre !== 'consolidated') {
          throw new TdaError('SKILL_PREREQ_NOT_CONSOLIDATED', `前置技能 ${prerequisiteId} 当前 ${lifecyclePre}（Voyager 铁律 1）`);
        }
      }
      const result = await deps.executor.run({ skill, taskId });
      const verdict = result.outcome === 'success' && result.coverage >= params.thetaCov ? 'pass' : 'fail';
      const run: SkillRehearsalRun = {
        id: `reh-${++runCounter}`,
        skillId: String(skill.id),
        taskId,
        childSessionId: result.childSessionId,
        boundary: { ...result.boundary },
        verdict,
        coverage: result.coverage,
        outcome: result.outcome,
        at: clock(),
      };
      const stats = { ...skill.stats };
      if (verdict === 'pass') {
        stats.rehearsalPass += 1;
        stats.consecutiveRehearsalFail = 0;
      } else {
        stats.rehearsalFail += 1;
        stats.consecutiveRehearsalFail += 1;
      }
      await emit({
        family: 'skill/change',
        businessId: `${SKILL_REHEARSAL_BUSINESS_PREFIX}:${run.id}`,
        payload: skillRehearsalPayload(run),
        domainWrite: async () => {
          await runsTable.put(run.id, run as never);
          await skillsTable.put(String(skill.id), { ...skill, stats, updatedAt: clock() } as never);
        },
      });
      skills.set(String(skill.id), { ...skill, stats, updatedAt: clock() });
      if (verdict === 'pass') {
        // 回放入职（不变量 1）：draft → validating
        if (lifecycleOf(skillId) === 'draft') {
          await deps.governance.promoteAsset(actor, skillId, 'skill', `rehearsal ${run.id} pass (coverage=${result.coverage})`);
        }
      } else if (stats.consecutiveRehearsalFail >= params.maxConsecutiveRehearsalFail) {
        // 连续 fail ≥ N → 自动 retire[rehearsal-fail]（J5，受控实验证伪=直接证据）
        await deps.governance.retire(
          actor,
          skillId,
          { kind: 'rehearsal-fail', detail: `consecutive=${stats.consecutiveRehearsalFail}` },
          undefined,
          'skill',
        );
      }
      return run;
    },

    async logUse(actor, skillId, taskId, outcome) {
      const params = loadParams();
      const skill = requireSkill(skillId);
      const lifecycle = lifecycleOf(skillId);
      if (lifecycle !== 'validating' && lifecycle !== 'consolidated') {
        throw new TdaError('SKILL_NOT_USABLE', `技能 ${skillId} 当前 ${lifecycle}，不可真实复用记账`);
      }
      // Elo 在线评分（J7）
      const s = outcome === 'success' ? 1 : outcome === 'partial' ? 0.5 : 0;
      const eloBefore = skill.stats.elo;
      const expectation = ELO_EXPECTATION(params.eloBaseline, eloBefore);
      const eloAfter = eloBefore + params.eloK * (s - expectation);
      const use: SkillUse = {
        id: asSkillUseId(`su-${++useCounter}`),
        skillId: String(skill.id),
        taskId,
        sessionId: actor.sessionId,
        outcome,
        eloBefore,
        eloAfter,
        k: params.eloK,
        at: clock(),
      };
      const stats = { ...skill.stats, elo: eloAfter };
      stats.realUse += 1;
      stats.consecutiveUseFail = outcome === 'success' ? 0 : stats.consecutiveUseFail + 1;
      await emit({
        family: 'skill/change',
        businessId: `${SKILL_USE_BUSINESS_PREFIX}:${use.id}`,
        payload: skillUsePayload(use),
        domainWrite: async () => {
          await usageTable.put(use.id, use as never);
          await skillsTable.put(String(skill.id), { ...skill, stats, updatedAt: clock() } as never);
        },
      });
      skills.set(String(skill.id), { ...skill, stats, updatedAt: clock() });
      if (stats.consecutiveUseFail >= params.maxConsecutiveUseFail) {
        await deps.governance.retire(
          actor,
          skillId,
          { kind: 'use-fail', detail: `consecutive=${stats.consecutiveUseFail}` },
          undefined,
          'skill',
        );
      }
      return use;
    },

    async requestConsolidate(actor, skillId) {
      const params = loadParams();
      const skill = requireSkill(skillId);
      const lifecycle = lifecycleOf(skillId);
      if (lifecycle === 'retired') {
        throw new TdaError('SKILL_RETIRED', `技能 ${skillId} 已退役，不得固化`);
      }
      if (lifecycle === 'consolidated') {
        throw new TdaError('SKILL_ALREADY_CONSOLIDATED', `技能 ${skillId} 已固化（重复提请）`);
      }
      // 晋升双条件（不变量 2/J4）：external-adopted 例外
      if (skill.source.kind !== 'external-adopted') {
        if (skill.stats.rehearsalPass < 1) {
          throw new TdaError('SKILL_NO_REHEARSAL_PASS', `技能 ${skillId} 无 rehearsal pass（晋升条件 ①）`);
        }
        if (skill.stats.realUse < params.promoteMinRealUse) {
          throw new TdaError('SKILL_NO_REAL_USE', `技能 ${skillId} 真实复用 ${skill.stats.realUse}<${params.promoteMinRealUse}（晋升条件 ②，零复用固化拒绝 = G2-①）`);
        }
      }
      const action = await deps.governance.consolidate(actor, skillId, 'skill');
      if (deps.materializer !== undefined && lifecycleOf(skillId) === 'consolidated') {
        await deps.materializer.write(skill);
      }
      return action;
    },

    async supersede(actor, oldId, draft) {
      const old = requireSkill(oldId);
      if (lifecycleOf(oldId) === 'retired') {
        throw new TdaError('SKILL_RETIRED', `技能 ${oldId} 已退役，不得 supersede`);
      }
      const created = await this.propose(actor, { ...draft, supersedes: oldId });
      const at = clock();
      // 旧版标记 dependents 关系后经治理退役（superseded）
      await persistSkill({ ...old, dependents: [String(created.id)], updatedAt: at }, 'supersede-mark');
      await deps.governance.retire(
        actor,
        oldId,
        { kind: 'superseded', detail: `by ${String(created.id)}` },
        undefined,
        'skill',
      );
      return created;
    },

    injectCandidates(filter = {}) {
      const params = loadParams();
      const matches = [...skills.values()]
        .map((skill) => ({ skill, lifecycle: lifecycleOf(String(skill.id)) }))
        .filter(({ lifecycle }) => lifecycle === 'validating' || lifecycle === 'consolidated')
        .filter(({ skill }) =>
          filter.taskClass !== undefined ? skill.applicability.taskClasses.includes(filter.taskClass) : true,
        )
        .filter(({ skill }) =>
          filter.stage !== undefined ? skill.applicability.stages.includes(filter.stage) : true,
        )
        .sort((a, b) => b.skill.stats.elo - a.skill.stats.elo)
        .slice(0, params.topKInject);
      return matches.map(({ skill, lifecycle }) => ({ skill, validating: lifecycle === 'validating' }));
    },

    skills(filter = {}) {
      return [...skills.values()]
        .map((skill) => ({ skill, lifecycle: lifecycleOf(String(skill.id)) }))
        .filter(({ lifecycle }) => (filter.lifecycle !== undefined ? lifecycle === filter.lifecycle : true))
        .filter(({ skill }) =>
          filter.taskClass !== undefined ? skill.applicability.taskClasses.includes(filter.taskClass) : true,
        )
        .filter(({ skill }) => (filter.stage !== undefined ? skill.applicability.stages.includes(filter.stage) : true))
        .map(({ skill }) => skill)
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    },

    history(skillId) {
      // supersede 链回溯（旧版保留可溯，J4/Mem0 add-only）
      const chain: Skill[] = [];
      let current = skills.get(skillId);
      while (current !== undefined) {
        chain.push(current);
        current = current.supersedes !== undefined ? skills.get(current.supersedes) : undefined;
      }
      return chain;
    },

    params() {
      return loadParams();
    },

    async setParams(patch) {
      const current = loadParams();
      const next = SkillParamsSchema.parse({ ...current, ...patch, revision: current.revision + 1 });
      paramsRef = next;
      await emit({
        family: 'skill/change',
        businessId: SKILL_PARAMS_BUSINESS_ID,
        payload: skillParamsPayload(next),
        domainWrite: async () => {
          await paramsTable.put(SKILL_PARAMS_KEY, next as never);
        },
      });
      return next;
    },
  };
}

export { skillDomainSpec, SkillSchema };
