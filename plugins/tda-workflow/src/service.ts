/**
 * tda-workflow 服务面（T2.5 §4.2）。
 *
 * 安全面主防线（J5/不变量 2）：script 无 domain 写权（只经受控 step API 回调）；
 * 运行时内容只能作为 args 流动——**任何注入内容不得改写 definition**（定义变更
 * 只能 append 新版本，服务端断言）。
 */
import {
  DEFAULT_PARAMS,
  WORKFLOW_PARAMS_KEY,
  ParamsSchema,
  DefinitionSchema,
  RunSchema,
  scriptHashOf,
  workflowDomainSpec,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowMeta,
  type WorkflowParams,
  type WorkflowRun,
  type WorkflowTables,
} from './domain.ts';
import {
  WORKFLOW_DEF_BUSINESS_PREFIX,
  WORKFLOW_EVENT_BUSINESS_PREFIX,
  WORKFLOW_PARAMS_BUSINESS_ID,
  WORKFLOW_RUN_BUSINESS_PREFIX,
  workflowDefPayload,
  workflowEventPayload,
  workflowParamsPayload,
  workflowRunPayload,
} from './events.ts';
import {
  dualWrite,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';

export type WorkflowActor = { readonly sessionId: string; readonly actor: 'agent' | 'human' | 'coach' | 'scheduler' };

/** 治理 seam（第五实例 assetKind='workflow'，J8）。 */
export interface WorkflowGovernanceSeam {
  lifecycleOf(assetId: string, assetKind?: string): string | undefined;
  promoteAsset(actor: WorkflowActor, assetId: string, assetKind: string, note: string): Promise<unknown>;
  consolidate(actor: WorkflowActor, assetId: string, assetKind?: string): Promise<unknown>;
  retire(
    actor: WorkflowActor,
    assetId: string,
    reason: { readonly kind: string; readonly detail: string },
    opts?: { readonly approvalToken?: string },
    assetKind?: string,
  ): Promise<unknown>;
}

/** contract 断言执行 seam（确定性代码，J4：校验器无 LLM 判断路径）。 */
export interface WorkflowChecks {
  readonly assert: (assertion: { readonly kind: string; readonly target: string; readonly expect: string }) => boolean;
}

/** step 执行体 seam（dispatch 经 T0.5 / tool 白名单——装配层桥接，J12 零新增模型工具）。 */
export interface WorkflowStepExecutor {
  readonly execute: (input: {
    readonly stepId: string;
    readonly kind: string;
    readonly contractRef?: { readonly skillId?: string } | undefined;
    readonly args: Record<string, unknown>;
  }) => Promise<{ readonly outcome: 'success' | 'failure'; readonly detail?: Record<string, unknown> }>;
}

/** 局部重规划 planner seam（J6：Lead 子代理产修订子计划）。 */
export interface WorkflowPlanner {
  readonly replan: (input: {
    readonly run: WorkflowRun;
    readonly def: WorkflowDefinition;
    readonly failedStepIds: readonly string[];
  }) => Promise<{ readonly meta: WorkflowMeta; readonly script: string } | undefined>;
}

export interface WorkflowDeps {
  readonly domain: TdaDomain<WorkflowTables>;
  readonly session: TdaSessionSink;
  readonly governance: WorkflowGovernanceSeam;
  readonly checks: WorkflowChecks;
  readonly executor: WorkflowStepExecutor;
  readonly planner?: WorkflowPlanner | undefined;
  readonly now?: (() => number) | undefined;
  readonly reconciler?: DualWriteReconciler | undefined;
  readonly index?: AuditIndex | undefined;
  readonly bus?: TdaEventBus | undefined;
}

export interface WorkflowDefinitionDraft {
  readonly name: string;
  readonly description: string;
  readonly kind?: 'template' | 'instance';
  readonly parentTemplateId?: string;
  readonly source?: 'planner' | 'human' | 'coach' | 'template-instance';
  readonly meta: WorkflowMeta;
  readonly script: string;
  readonly supersedes?: string;
  readonly defId?: string;
  readonly version?: number;
}

export interface ValidationReport {
  readonly defId: string;
  readonly version: number;
  readonly pass: boolean;
  readonly violations: readonly { readonly stepId: string; readonly phase: 'pre' | 'post'; readonly assertion: string }[];
}

export interface WorkflowService {
  initialize(): Promise<void>;
  propose(actor: WorkflowActor, draft: WorkflowDefinitionDraft): Promise<WorkflowDefinition>;
  instantiate(templateId: string, params: Record<string, unknown>): Promise<WorkflowDefinition>;
  validate(defId: string): Promise<ValidationReport>;
  requestConsolidate(actor: WorkflowActor, defId: string): Promise<unknown>;
  definitions(filter?: { readonly kind?: 'template' | 'instance'; readonly status?: string }): readonly WorkflowDefinition[];
  history(defId: string): readonly WorkflowDefinition[];
  start(actor: WorkflowActor, defId: string, params: Record<string, unknown>, taskId: string): Promise<WorkflowRun>;
  approve(actor: WorkflowActor, runId: string, token: string, decision: 'approve' | 'reject'): Promise<WorkflowRun>;
  resume(runId: string): Promise<WorkflowRun>;
  cancel(runId: string, reason: string): Promise<WorkflowRun>;
  status(runId: string): WorkflowRun;
  runs(): readonly WorkflowRun[];
  proposeTemplateFromRun(actor: WorkflowActor, runId: string): Promise<WorkflowDefinition>;
  params(): WorkflowParams;
  setParams(patch: Partial<Omit<WorkflowParams, 'revision'>>): Promise<WorkflowParams>;
}

export function createWorkflowService(deps: WorkflowDeps): WorkflowService {
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
  const defsTable = deps.domain.table('workflow_defs');
  const eventsTable = deps.domain.table('workflow_events');
  const runsTable = deps.domain.table('workflow_runs');
  const paramsTable = deps.domain.table('workflow_params');

  const defs = new Map<string, WorkflowDefinition>(); // key `${defId}#${version}`
  const runs = new Map<string, WorkflowRun>();
  let defCounter = 0;
  let runCounter = 0;
  let eventCounter = 0;
  let paramsRef: WorkflowParams | undefined;
  const consumedTokens = new Set<string>();
  /** 已批过的审批节点（run 内一次性；重启后经 approve API 续行）。 */
  const approvedSteps = new Map<string, Set<string>>();

  const loadParams = (): WorkflowParams => {
    if (paramsRef !== undefined) return paramsRef;
    const row = paramsTable.get(WORKFLOW_PARAMS_KEY) as WorkflowParams | undefined;
    paramsRef = row ?? { ...DEFAULT_PARAMS };
    return paramsRef;
  };

  const defKey = (defId: string, version: number): string => `${defId}#${version}`;
  const lifecycleOf = (defId: string): string =>
    deps.governance.lifecycleOf(defId, 'workflow') ?? 'draft';

  const persistEvent = async (event: Omit<WorkflowEvent, 'id'>): Promise<WorkflowEvent> => {
    const full: WorkflowEvent = { ...event, id: `we-${++eventCounter}` as never };
    await emit({
      family: 'workflow/change',
      businessId: `${WORKFLOW_EVENT_BUSINESS_PREFIX}:${String(full.id)}`,
      payload: workflowEventPayload(full),
      domainWrite: async () => {
        await eventsTable.put(String(full.id), full as never);
      },
    });
    return full;
  };

  const persistRun = async (run: WorkflowRun, action: string): Promise<void> => {
    runs.set(String(run.runId), run);
    await emit({
      family: 'workflow/change',
      businessId: `${WORKFLOW_RUN_BUSINESS_PREFIX}:${String(run.runId)}`,
      payload: workflowRunPayload(run, action),
      domainWrite: async () => {
        await runsTable.put(String(run.runId), run as never);
      },
    });
  };

  const persistDef = async (def: WorkflowDefinition, action: string): Promise<void> => {
    defs.set(defKey(String(def.defId), def.version), def);
    await emit({
      family: 'workflow/change',
      businessId: `${WORKFLOW_DEF_BUSINESS_PREFIX}:${String(def.defId)}`,
      payload: workflowDefPayload(def, action),
      domainWrite: async () => {
        await defsTable.put(defKey(String(def.defId), def.version), def as never);
      },
    });
  };

  const requireDef = (defId: string): WorkflowDefinition => {
    // 取该 defId 的最新版本
    const keys = [...defs.keys()].filter((key) => key.startsWith(`${defId}#`));
    if (keys.length === 0) throw new TdaError('WF_DEF_NOT_FOUND', `定义 ${defId} 不存在`);
    const latest = keys.map((key) => Number(key.split('#')[1])).sort((a, b) => b - a)[0]!;
    return defs.get(defKey(defId, latest))!;
  };

  const requireRun = (runId: string): WorkflowRun => {
    const run = runs.get(runId);
    if (run === undefined) throw new TdaError('WF_RUN_NOT_FOUND', `运行 ${runId} 不存在`);
    return run;
  };

  /** 拓扑序（Kahn；加载期 schema 已断言无环）。 */
  const topoOrder = (meta: WorkflowMeta): string[] => {
    const indegree = new Map<string, number>(meta.steps.map((step) => [step.id, 0]));
    for (const step of meta.steps) {
      for (const dep of step.dependsOn) {
        indegree.set(step.id, (indegree.get(step.id) ?? 0) + (meta.steps.some((candidate) => candidate.id === dep) ? 1 : 0));
      }
    }
    const dependents = new Map<string, string[]>();
    for (const step of meta.steps) {
      for (const dep of step.dependsOn) {
        dependents.set(dep, [...(dependents.get(dep) ?? []), step.id]);
      }
    }
    const order: string[] = [];
    const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);
      for (const next of dependents.get(id) ?? []) {
        const degree = (indegree.get(next) ?? 1) - 1;
        indegree.set(next, degree);
        if (degree === 0) queue.push(next);
      }
    }
    return order;
  };

  const checkAll = (assertions: readonly { kind: string; target: string; expect: string }[]): boolean =>
    assertions.every((assertion) => deps.checks.assert(assertion));

  /** run 推进循环：逐 step 前置→执行→后置；审批挂起/重规划/终态（§2.2 状态机）。 */
  const advance = async (run: WorkflowRun): Promise<WorkflowRun> => {
    let current = run;
    const def = requireDef(current.defId);
    const order = topoOrder(def.meta);
    for (const stepId of order) {
      const state = current.stepStates[stepId];
      if (state === 'done' || state === 'skipped' || state === 'failed') continue;
      const step = def.meta.steps.find((candidate) => candidate.id === stepId)!;
      // 依赖未 done → 跳过本轮（下一轮 resume 继续）
      if (step.dependsOn.some((dep) => current.stepStates[dep] !== 'done' && current.stepStates[dep] !== 'skipped')) {
        continue;
      }
      // 审批节点：挂起等 token（J7：不自愈不超时自动过）
      const approval = def.meta.approvalNodes.find((node) => node.stepId === stepId);
      const alreadyApproved = approvedSteps.get(String(current.runId))?.has(stepId) ?? false;
      if (approval !== undefined && !alreadyApproved && current.status !== 'awaiting-approval') {
        await persistEvent({
          runId: String(current.runId),
          kind: 'approval-request',
          ...(true ? { stepId } : {}),
          detail: { whatToShow: approval.whatToShow, riskLevel: approval.riskLevel },
          at: clock(),
        });
        current = { ...current, status: 'awaiting-approval', stepStates: { ...current.stepStates, [stepId]: 'ready' } };
        await persistRun(current, 'awaiting-approval');
        return current;
      }
      current = { ...current, status: 'running', stepStates: { ...current.stepStates, [stepId]: 'checking-pre' } };
      // 前置断言（J4：前置不过不启动）
      if (!checkAll(step.contract.pre)) {
        await persistEvent({
          runId: String(current.runId),
          kind: 'contract-violation',
          stepId,
          detail: { phase: 'pre' },
          at: clock(),
        });
        current = { ...current, stepStates: { ...current.stepStates, [stepId]: 'skipped' } };
        await persistRun(current, 'pre-violation');
        continue;
      }
      current = { ...current, stepStates: { ...current.stepStates, [stepId]: 'executing' } };
      await persistEvent({
        runId: String(current.runId),
        kind: 'step-begin',
        stepId,
        detail: { kind: step.kind },
        at: clock(),
      });
      const executeStep = (): ReturnType<typeof deps.executor.execute> =>
        deps.executor.execute({
          stepId,
          kind: step.kind,
          ...(step.contractRef !== undefined ? { contractRef: { ...(step.contractRef.skillId !== undefined ? { skillId: step.contractRef.skillId } : {}) } } : {}),
          args: { ...current.params },
        });
      let result = await executeStep();
      // 预算内自动单步重试（J6：预算内重试/调参，不重规划）；v1 每步每轮最多一次
      let retried = false;
      while (result.outcome === 'failure' && !retried) {
        const deviationAfter = current.deviation.postFail + 1;
        if (deviationAfter > def.meta.deviationBudget.postFailMax) break; // 超阈 → 走下方重规划分支
        retried = true;
        current = { ...current, deviation: { ...current.deviation, postFail: deviationAfter } };
        await persistEvent({
          runId: String(current.runId),
          kind: 'deviation',
          stepId,
          detail: { postFail: deviationAfter, action: 'auto-retry' },
          at: clock(),
        });
        result = await executeStep();
      }
      if (result.outcome === 'failure') {
        const deviation = { ...current.deviation, postFail: current.deviation.postFail + 1 };
        current = { ...current, deviation, stepStates: { ...current.stepStates, [stepId]: 'failed' } };
        await persistEvent({
          runId: String(current.runId),
          kind: 'deviation',
          stepId,
          detail: { postFail: deviation.postFail },
          at: clock(),
        });
        // 局部重规划（J6）：偏差预算内重试；累积超阈触发单步重规划
        const budget = def.meta.deviationBudget;
        if (deviation.postFail > budget.postFailMax) {
          await persistEvent({
            runId: String(current.runId),
            kind: 'replan',
            detail: { failedStepIds: order.filter((id) => current.stepStates[id] === 'failed') },
            at: clock(),
          });
          const replanned = deps.planner?.replan({
            run: current,
            def,
            failedStepIds: order.filter((id) => current.stepStates[id] === 'failed'),
          });
          const draft = replanned instanceof Promise ? await replanned : replanned;
          if (draft !== undefined) {
            // 重规划产物 = 新版本（append，不改当前定义——不变量 6）
            const newDef: WorkflowDefinition = DefinitionSchema.parse({
              defId: String(def.defId),
              version: def.version + 1,
              supersedes: String(def.defId),
              kind: def.kind,
              ...(def.parentTemplateId !== undefined ? { parentTemplateId: def.parentTemplateId } : {}),
              name: def.name,
              description: def.description,
              source: 'planner',
              meta: draft.meta,
              script: draft.script,
              scriptHash: scriptHashOf(draft.script),
              createdBy: { sessionId: deps.session.sessionId, actor: 'agent' },
              createdAt: clock(),
            });
            await persistDef(newDef, 'replan-version');
            current = {
              ...current,
              defVersion: newDef.version,
              status: 'running',
              stepStates: Object.fromEntries(Object.entries(current.stepStates).map(([id, st]) => [id, st === 'failed' ? 'ready' : st])),
            };
            await persistRun(current, 'replanned');
            return advance(current);
          }
          current = {
            ...current,
            status: 'replanning',
            unfinished: order.filter((id) => current.stepStates[id] !== 'done' && current.stepStates[id] !== 'skipped'),
          };
          await persistRun(current, 'replanning');
          return current;
        }
        await persistRun(current, 'step-failure');
        continue;
      }
      // 后置断言：不过 → 结果不当成功（同 T0.5 J4 纪律）
      current = { ...current, stepStates: { ...current.stepStates, [stepId]: 'checking-post' } };
      if (!checkAll(step.contract.post)) {
        await persistEvent({
          runId: String(current.runId),
          kind: 'contract-violation',
          stepId,
          detail: { phase: 'post' },
          at: clock(),
        });
        const deviation = { ...current.deviation, postFail: current.deviation.postFail + 1 };
        current = { ...current, deviation, stepStates: { ...current.stepStates, [stepId]: 'failed' } };
        await persistRun(current, 'post-failure');
        continue;
      }
      current = { ...current, stepStates: { ...current.stepStates, [stepId]: 'done' } };
      await persistEvent({
        runId: String(current.runId),
        kind: 'step-end',
        stepId,
        detail: { outcome: 'success' },
        at: clock(),
      });
    }
    // 全部 step 落定 → 终态
    const allDone = order.every((id) => current.stepStates[id] === 'done' || current.stepStates[id] === 'skipped');
    const anyFailed = order.some((id) => current.stepStates[id] === 'failed');
    if (allDone && !anyFailed) {
      const completed: WorkflowRun = {
        ...current,
        status: 'completed',
        outcome: 'success',
        endedAt: clock(),
      };
      await persistEvent({
        runId: String(current.runId),
        kind: 'run-end',
        detail: { outcome: 'success' },
        at: clock(),
      });
      await persistRun(completed, 'complete');
      return completed;
    }
    if (current.status === 'running') {
      const unfinished = order.filter(
        (id) => current.stepStates[id] !== 'done' && current.stepStates[id] !== 'skipped',
      );
      const failed: WorkflowRun = {
        ...current,
        status: 'failed',
        outcome: 'failed',
        unfinished,
        endedAt: clock(),
      };
      await persistEvent({
        runId: String(current.runId),
        kind: 'run-end',
        detail: { outcome: 'failed', unfinished },
        at: clock(),
      });
      await persistRun(failed, 'fail');
      return failed;
    }
    return current;
  };

  /** 模板的真实复用次数（不变量 8 外部验证阀第二条件）。 */
  const realUseOf = (templateId: string): number => {
    const instanceDefIds = new Set(
      [...defs.values()]
        .filter((def) => def.kind === 'instance' && def.parentTemplateId === templateId)
        .map((def) => String(def.defId)),
    );
    return [...runs.values()].filter(
      (run) => instanceDefIds.has(run.defId) && run.status === 'completed' && run.outcome === 'success',
    ).length;
  };

  return {
    async initialize() {
      loadParams();
      for (const [key, value] of defsTable.entries()) defs.set(key, value as WorkflowDefinition);
      for (const [key, value] of runsTable.entries()) runs.set(key, value as WorkflowRun);
      defCounter = new Set([...defs.values()].map((def) => String(def.defId))).size;
      runCounter = [...runsTable.keys()].length;
      eventCounter = [...eventsTable.keys()].length;
      if (paramsTable.get(WORKFLOW_PARAMS_KEY) === undefined) {
        await emit({
          family: 'workflow/change',
          businessId: WORKFLOW_PARAMS_BUSINESS_ID,
          payload: workflowParamsPayload(loadParams()),
          domainWrite: async () => {
            await paramsTable.put(WORKFLOW_PARAMS_KEY, loadParams() as never);
          },
        });
      }
    },

    async propose(actor, draft) {
      // 定义冻结（不变量 1）：同 defId+version 已存在即拒（变更 = append 新版本）
      const defId = draft.defId ?? `wf-${++defCounter}`;
      const version = draft.version ?? 1;
      if (defs.has(defKey(String(defId), version))) {
        throw new TdaError('WF_DEF_VERSION_EXISTS', `定义 ${defId}#${version} 已存在（定义冻结：变更只能 append 新版本）`);
      }
      const def: WorkflowDefinition = DefinitionSchema.parse({
        defId: String(defId),
        version,
        ...(draft.supersedes !== undefined ? { supersedes: draft.supersedes } : {}),
        kind: draft.kind ?? 'template',
        ...(draft.parentTemplateId !== undefined ? { parentTemplateId: draft.parentTemplateId } : {}),
        name: draft.name,
        description: draft.description,
        source: draft.source ?? 'human',
        meta: draft.meta,
        script: draft.script,
        scriptHash: scriptHashOf(draft.script),
        createdBy: { sessionId: actor.sessionId, actor: actor.actor },
        createdAt: clock(),
      });
      await persistDef(def, 'propose');
      return def;
    },

    async instantiate(templateId, params) {
      const template = requireDef(templateId);
      if (template.kind !== 'template') {
        throw new TdaError('WF_NOT_TEMPLATE', `定义 ${templateId} 不是模板（实例化只针对模板，J8）`);
      }
      if (lifecycleOf(templateId) === 'retired') {
        throw new TdaError('WF_TEMPLATE_RETIRED', `模板 ${templateId} 已退役`);
      }
      // 实例化 = append 新 def（不改模板字节——不变量 7）
      const def: WorkflowDefinition = DefinitionSchema.parse({
        defId: `wf-${++defCounter}`,
        version: 1,
        kind: 'instance',
        parentTemplateId: String(template.defId),
        name: template.name,
        description: template.description,
        source: 'template-instance',
        meta: template.meta,
        script: template.script,
        scriptHash: template.scriptHash,
        createdBy: { sessionId: 'instantiate', actor: 'scheduler' },
        createdAt: clock(),
      });
      await persistDef(def, 'instantiate');
      void params;
      return def;
    },

    async validate(defId) {
      const def = requireDef(defId);
      const violations: ValidationReport['violations'][number][] = [];
      for (const step of def.meta.steps) {
        for (const assertion of step.contract.pre) {
          if (!deps.checks.assert(assertion)) {
            violations.push({ stepId: step.id, phase: 'pre', assertion: `${assertion.kind}:${assertion.target}` });
          }
        }
        for (const assertion of step.contract.post) {
          if (!deps.checks.assert(assertion)) {
            violations.push({ stepId: step.id, phase: 'post', assertion: `${assertion.kind}:${assertion.target}` });
          }
        }
      }
      return { defId: String(def.defId), version: def.version, pass: violations.length === 0, violations };
    },

    async requestConsolidate(actor, defId) {
      const def = requireDef(defId);
      const lifecycle = lifecycleOf(defId);
      if (lifecycle === 'retired') throw new TdaError('WF_RETIRED', `定义 ${defId} 已退役`);
      if (lifecycle === 'consolidated') throw new TdaError('WF_ALREADY_CONSOLIDATED', `定义 ${defId} 已固化`);
      // 外部验证阀（不变量 8 / G2-②）：回放验证通过 ∧ ≥1 次真实复用
      const validation = await this.validate(defId);
      if (!validation.pass) {
        throw new TdaError('WF_VALIDATION_FAILED', `定义 ${defId} 回放验证未通过（外部验证阀条件 ①）`);
      }
      const realUse = realUseOf(defId);
      if (def.kind === 'template' && realUse < 1) {
        throw new TdaError('WF_NO_REAL_USE', `模板 ${defId} 零真实复用（外部验证阀条件 ②，G2-② 零复用固化拒绝）`);
      }
      if (lifecycleOf(defId) !== 'consolidated') {
        await deps.governance.promoteAsset(actor, defId, 'workflow', `validate pass ∧ realUse=${realUse}`);
      }
      return deps.governance.consolidate(actor, defId, 'workflow');
    },

    definitions(filter = {}) {
      const latest = new Map<string, WorkflowDefinition>();
      for (const def of defs.values()) {
        const existing = latest.get(String(def.defId));
        if (existing === undefined || def.version > existing.version) latest.set(String(def.defId), def);
      }
      return [...latest.values()]
        .filter((def) => (filter.kind !== undefined ? def.kind === filter.kind : true))
        .filter((def) => (filter.status !== undefined ? lifecycleOf(String(def.defId)) === filter.status : true))
        .sort((a, b) => (String(a.defId) < String(b.defId) ? -1 : 1));
    },

    history(defId) {
      return [...defs.values()]
        .filter((def) => String(def.defId) === defId)
        .sort((a, b) => a.version - b.version);
    },

    async start(actor, defId, params, taskId) {
      const def = requireDef(defId);
      if (lifecycleOf(defId) === 'retired') {
        throw new TdaError('WF_DEF_RETIRED', `定义 ${defId} 已退役，不可启动`);
      }
      const run: WorkflowRun = RunSchema.parse({
        runId: `wr-${++runCounter}`,
        defId: String(def.defId),
        defVersion: def.version,
        taskId,
        params: { ...params },
        status: 'running',
        stepStates: Object.fromEntries(def.meta.steps.map((step) => [step.id, 'ready' as const])),
        deviation: { postFail: 0, mismatchDensity: 0, burnRate: 0 },
        startedAt: clock(),
      });
      await persistRun(run, 'start');
      void actor;
      return advance(run);
    },

    async approve(actor, runId, token, decision) {
      const run = requireRun(runId);
      if (run.status !== 'awaiting-approval') {
        throw new TdaError('WF_NOT_AWAITING', `运行 ${runId} 当前 ${run.status}（审批挂起语义，无自动通过路径）`);
      }
      if (consumedTokens.has(token)) throw new TdaError('WF_TOKEN_REUSED', '审批 token 已消费（一次性）');
      consumedTokens.add(token);
      const pendingStep = Object.entries(run.stepStates).find(([, state]) => state === 'ready')?.[0];
      if (decision === 'approve' && pendingStep !== undefined) {
        const set = approvedSteps.get(runId) ?? new Set<string>();
        set.add(pendingStep);
        approvedSteps.set(runId, set);
      }
      await persistEvent({
        runId,
        kind: 'approval-decision',
        ...(pendingStep !== undefined ? { stepId: pendingStep } : {}),
        detail: { decision },
        at: clock(),
      });
      if (decision === 'reject') {
        const cancelled: WorkflowRun = {
          ...run,
          status: 'cancelled',
          outcome: 'cancelled',
          unfinished: Object.entries(run.stepStates)
            .filter(([, state]) => state !== 'done' && state !== 'skipped')
            .map(([id]) => id),
          endedAt: clock(),
        };
        await persistRun(cancelled, 'reject');
        return cancelled;
      }
      void actor;
      return advance({ ...run, status: 'running' });
    },

    async resume(runId) {
      const run = requireRun(runId);
      if (run.status !== 'awaiting-approval' && run.status !== 'replanning') {
        throw new TdaError('WF_NOT_RESUMABLE', `运行 ${runId} 当前 ${run.status}，不可续跑`);
      }
      return advance({ ...run, status: 'running' });
    },

    async cancel(runId, reason) {
      const run = requireRun(runId);
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        throw new TdaError('WF_ALREADY_TERMINAL', `运行 ${runId} 已是终态（${run.status}）`);
      }
      const cancelled: WorkflowRun = {
        ...run,
        status: 'cancelled',
        outcome: 'cancelled',
        unfinished: Object.entries(run.stepStates)
          .filter(([, state]) => state !== 'done' && state !== 'skipped')
          .map(([id]) => id),
        endedAt: clock(),
      };
      void reason;
      await persistRun(cancelled, 'cancel');
      return cancelled;
    },

    status(runId) {
      return requireRun(runId);
    },

    runs() {
      return [...runs.values()].sort((a, b) => (String(a.runId) < String(b.runId) ? -1 : 1));
    },

    async proposeTemplateFromRun(actor, runId) {
      const run = requireRun(runId);
      if (run.status !== 'completed') {
        throw new TdaError('WF_RUN_NOT_COMPLETED', `运行 ${runId} 未完成（模板回写触发源 = 目标完成，J8）`);
      }
      const sourceDef = defs.get(defKey(run.defId, run.defVersion));
      if (sourceDef === undefined) throw new TdaError('WF_DEF_NOT_FOUND', `运行 ${runId} 的定义不存在`);
      const def: WorkflowDefinition = DefinitionSchema.parse({
        defId: `wf-${++defCounter}`,
        version: 1,
        kind: 'template',
        name: `${sourceDef.name}-template`,
        description: `分层模板候选（抽象自 run ${runId}，待验证）`,
        source: 'planner',
        meta: sourceDef.meta,
        script: sourceDef.script,
        scriptHash: sourceDef.scriptHash,
        createdBy: { sessionId: actor.sessionId, actor: actor.actor },
        createdAt: clock(),
      });
      await persistDef(def, 'template-candidate');
      return def;
    },

    params() {
      return loadParams();
    },

    async setParams(patch) {
      const current = loadParams();
      const next = ParamsSchema.parse({
        ...current,
        ...patch,
        defaultDeviationBudget: { ...current.defaultDeviationBudget, ...(patch.defaultDeviationBudget ?? {}) },
        revision: current.revision + 1,
      });
      paramsRef = next;
      await emit({
        family: 'workflow/change',
        businessId: WORKFLOW_PARAMS_BUSINESS_ID,
        payload: workflowParamsPayload(next),
        domainWrite: async () => {
          await paramsTable.put(WORKFLOW_PARAMS_KEY, next as never);
        },
      });
      return next;
    },
  };
}

export { workflowDomainSpec };
