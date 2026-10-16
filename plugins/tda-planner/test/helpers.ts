/**
 * tda-planner 测试helpers：内存假体实现被依赖的各服务面，并记录调用日志
 * （否定性断言如"规划器零执行权/从不 claim/complete"靠 calls 自证）。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  openTdaDomain,
  type AuditIndex,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaBusEvent,
} from '@tda/kernel';
import { plannerDomainSpec, PLANNER_PARAMS_KEY, type PlannerTables } from '../src/domain.ts';
import type { PlannedTask } from '../src/domain.ts';
import {
  createPlannerService,
  type PlannerGoalSeam,
  type PlannerSupervisionSeam,
  type PlannerTaskCreateRequest,
  type PlannerTaskEditRequest,
  type PlannerTaskPoolSeam,
  type PlannerTaskView,
  type TaskPlannerService,
} from '../src/service.ts';

export const NOW = 1_700_000_000_000;

export function makeTask(overrides: Partial<PlannerTaskView> = {}): PlannerTaskView {
  return {
    id: 'task-1',
    revision: 1,
    goalId: 'goal-1',
    subject: '主路径任务',
    phase: 'active',
    stage: 'planning',
    blockedBy: [],
    priority: 5,
    zone: 'normal',
    runCount: 0,
    consecutiveFailures: 0,
    budget: { caps: {}, consumed: {} },
    writeScopes: [],
    ...overrides,
  };
}

// ── 假 session sink ────────────────────────────────────────────────────

export interface FakeSession {
  readonly sessionId: string;
  readonly appends: { family: string; businessId: string; payload: Record<string, unknown> }[];
  append(event: { family: string; businessId: string; payload: Record<string, unknown> }): number;
  flush(): void;
}

export function createFakeSession(sessionId = 'sess-planner'): FakeSession {
  const appends: FakeSession['appends'] = [];
  let seq = 0;
  return {
    sessionId,
    appends,
    append(event) {
      seq += 1;
      appends.push(event);
      return seq;
    },
    flush() {
      /* 测试用内存 sink，无持久化屏障 */
    },
  };
}

// ── 假 taskPool（受控写面 + 调用日志） ─────────────────────────────────

export interface FakeTaskPool extends PlannerTaskPoolSeam {
  readonly tasks: Map<string, PlannerTaskView>;
  readonly calls: string[];
  /** 测试开关：create/edit/block 一律抛 STALE_REVISION。 */
  stale: boolean;
  seed(task: PlannerTaskView): void;
}

export function createFakeTaskPool(seed: readonly PlannerTaskView[] = []): FakeTaskPool {
  const tasks = new Map<string, PlannerTaskView>();
  for (const task of seed) tasks.set(task.id, task);
  const calls: string[] = [];
  let counter = 0;
  const fake: FakeTaskPool = {
    tasks,
    calls,
    stale: false,
    seed(task) {
      tasks.set(task.id, task);
    },
    get(id) {
      return tasks.get(id);
    },
    list(filter) {
      return [...tasks.values()].filter((task) => filter?.goalId === undefined || task.goalId === filter.goalId);
    },
    async create(_actor, req: PlannerTaskCreateRequest) {
      calls.push(`create:${req.subject}`);
      if (fake.stale) throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
      counter += 1;
      const node = makeTask({
        id: `task-${counter}`,
        revision: 1,
        goalId: req.goalId,
        subject: req.subject,
        blockedBy: [...(req.blockedBy ?? [])],
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        ...(req.localPath !== undefined ? { localPath: req.localPath } : {}),
        ...(req.writeScopes !== undefined ? { writeScopes: [...req.writeScopes] } : {}),
        ...(req.budget !== undefined ? { budget: { caps: { ...req.budget }, consumed: {} } } : {}),
      });
      // 记录代建溯源（供断言 alternativeOf 结构与 planId；只读视图外加挂）
      const traced: PlannerTaskView & { planId?: string; alternativeOf?: unknown } = {
        ...node,
        ...(req.planId !== undefined ? { planId: req.planId } : {}),
        ...(req.alternativeOf !== undefined ? { alternativeOf: { ...req.alternativeOf } } : {}),
      };
      tasks.set(traced.id, traced);
      return traced;
    },
    async edit(_actor, id, ref, req: PlannerTaskEditRequest) {
      const label = req.subject ?? req.stage ?? (req.budget !== undefined ? 'budget' : 'priority');
      calls.push(`edit:${id}:${label}`);
      const current = tasks.get(id);
      if (current === undefined) throw new Error(`TASK_NOT_FOUND:${id}`);
      if (fake.stale || current.revision !== ref.expectedRevision) {
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
      }
      const next: PlannerTaskView = {
        ...current,
        revision: current.revision + 1,
        ...(req.subject !== undefined ? { subject: req.subject } : {}),
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        ...(req.blockedBy !== undefined ? { blockedBy: [...req.blockedBy] } : {}),
        ...(req.stage !== undefined ? { stage: req.stage } : {}),
        ...(req.budget !== undefined ? { budget: { ...current.budget, caps: { ...current.budget.caps, ...req.budget } } } : {}),
      };
      tasks.set(id, next);
      return next;
    },
    async block(_actor, id, ref, reason) {
      calls.push(`block:${id}:${reason.code}`);
      const current = tasks.get(id);
      if (current === undefined) throw new Error(`TASK_NOT_FOUND:${id}`);
      if (fake.stale || current.revision !== ref.expectedRevision) {
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
      }
      const next: PlannerTaskView = {
        ...current,
        revision: current.revision + 1,
        phase: 'blocked',
      };
      tasks.set(id, next);
      return next;
    },
  };
  return fake;
}

// ── 假 supervision（request/approve，token 一次性） ─────────────────────

export interface FakeSupervision extends PlannerSupervisionSeam {
  readonly calls: string[];
  readonly requests: { approvalId: string; kind: string; resume: { from: string; handle: string }; status: string }[];
  approve(approvalId: string, token: string): { approvalId: string; nonce: string; from: string; handle: string };
}

export function createFakeSupervision(): FakeSupervision {
  const calls: string[] = [];
  const requests: FakeSupervision['requests'] = [];
  const tokens = new Map<string, string>();
  let counter = 0;
  return {
    calls,
    requests,
    async request(input) {
      calls.push(`request:${input.kind}`);
      counter += 1;
      const approvalId = `appr-${counter}`;
      tokens.set(approvalId, `tok-${counter}`);
      requests.push({ approvalId, kind: input.kind, resume: input.resume, status: 'pending' });
      return { approvalId };
    },
    approve(approvalId, token) {
      calls.push(`approve:${approvalId}`);
      const expected = tokens.get(approvalId);
      if (expected === undefined || expected !== token) {
        throw Object.assign(new Error('token invalid'), { code: 'APPROVAL_TOKEN_INVALID' });
      }
      tokens.delete(approvalId);
      const request = requests.find((item) => item.approvalId === approvalId);
      if (request !== undefined) request.status = 'approved';
      return {
        approvalId,
        nonce: `nonce-${approvalId}`,
        from: request?.resume.from ?? '',
        handle: request?.resume.handle ?? '',
      };
    },
  };
}

// ── 假 goal（只读） ────────────────────────────────────────────────────

export function createFakeGoal(
  criteria: readonly string[] = [],
  budgetRemaining: Record<string, number> = {},
): PlannerGoalSeam {
  return {
    get(id) {
      if (id !== 'goal-1') return undefined;
      return {
        id,
        objective: '完成目标',
        completionCriteria: criteria,
        budgetRemaining,
      };
    },
  };
}

// ── 假 decomposer（确定性分解：一个任务覆盖一条标准） ───────────────────

export interface FakeDecomposer {
  (input: { goalId: string; completionCriteria: readonly string[] }): Promise<{
    readonly tasks: readonly PlannedTask[];
    generation: { provider: string; model: string; schemaHash: string };
  }>;
  /** 测试开关：下一次调用返回坏提议（质量门应拒）。 */
  nextBad: 'criteria-gap' | 'cycle' | 'high-risk-no-contingency' | null;
  /** 测试开关：下一次调用返回任意任务集（预案边/diff 场景）；优先于 nextBad。 */
  nextTasks: readonly PlannedTask[] | null;
}

export function createFakeDecomposer(): FakeDecomposer {
  let nextBad: FakeDecomposer['nextBad'] = null;
  let nextTasks: readonly PlannedTask[] | null = null;
  const run = async (input: { goalId: string; completionCriteria: readonly string[] }) => {
    if (nextTasks !== null) {
      const forced = nextTasks;
      nextTasks = null;
      return {
        tasks: forced,
        generation: { provider: 'scripted', model: 'fake-lead', schemaHash: 'sha-test' },
      };
    }
    const tasks: PlannedTask[] = input.completionCriteria.map((_, index) => ({
      tempId: `t${index + 1}`,
      subject: `任务 ${index + 1}`,
      completionCriteria: [`标准 ${index + 1} 的证据路径`],
      blockedByTempIds: [],
      criteriaRefs: [index],
    }));
    if (nextBad === 'criteria-gap') {
      // 覆盖缺失：只保留覆盖第一条标准的任务（第二条起无任务覆盖）
      tasks.splice(1);
      tasks[0] = { ...tasks[0]!, criteriaRefs: [0] };
    }
    if (nextBad === 'cycle') {
      tasks.push({ tempId: 'tcy1', subject: '环甲', completionCriteria: ['y'], blockedByTempIds: ['tcy2'], criteriaRefs: [0] });
      tasks.push({ tempId: 'tcy2', subject: '环乙', completionCriteria: ['y'], blockedByTempIds: ['tcy1'], criteriaRefs: [0] });
    }
    if (nextBad === 'high-risk-no-contingency') {
      tasks.push({
        tempId: 'thr',
        subject: '高风险任务',
        completionCriteria: ['y'],
        blockedByTempIds: [],
        criteriaRefs: [0],
        localPath: 'ws/a',
        writeScopes: ['ws/b/x'],
      });
    }
    nextBad = null;
    return {
      tasks,
      generation: { provider: 'scripted', model: 'fake-lead', schemaHash: 'sha-test' },
    };
  };
  // 注意：禁 Object.assign——它会把 getter/setter 求值拷贝为数据属性（setter 丢失），
  // 必须 Object.defineProperties 原样挂载访问器。
  return Object.defineProperties(run, {
    nextBad: {
      get: () => nextBad,
      set: (value: FakeDecomposer['nextBad']) => {
        nextBad = value;
      },
    },
    nextTasks: {
      get: () => nextTasks,
      set: (value: readonly PlannedTask[] | null) => {
        nextTasks = value;
      },
    },
  }) as FakeDecomposer;
}

// ── 装配 ───────────────────────────────────────────────────────────────

export interface Rig {
  readonly dir: string;
  readonly domain: TdaDomain<PlannerTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly bus: TdaEventBus;
  readonly published: TdaBusEvent[];
  readonly session: FakeSession;
  readonly taskPool: FakeTaskPool;
  readonly supervision: FakeSupervision;
  readonly goal: PlannerGoalSeam;
  readonly decomposer: FakeDecomposer;
  readonly service: TaskPlannerService;
  dispose(): Promise<void>;
}

export interface RigOptions {
  readonly tasks?: readonly PlannerTaskView[];
  readonly goalCriteria?: readonly string[];
  readonly goalRemaining?: Record<string, number>;
  readonly now?: () => number;
}

export async function setup(options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-planner-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(plannerDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  const bus = createTdaEventBus();
  const published: Rig['published'] = [];
  bus.subscribe('planner/change', (event) => {
    published.push(event);
  });
  const session = createFakeSession();
  const taskPool = createFakeTaskPool(options.tasks ?? []);
  const supervision = createFakeSupervision();
  const goal = createFakeGoal(options.goalCriteria ?? ['标准一', '标准二'], options.goalRemaining ?? {});
  const decomposer = createFakeDecomposer();
  const service = createPlannerService({
    domain,
    session: session as never,
    taskPool,
    goal,
    supervision,
    decomposer,
    reconciler,
    index,
    bus,
    now: options.now ?? ((): number => NOW),
  });
  await service.initialize();
  return {
    dir,
    domain,
    reconciler,
    index,
    bus,
    published,
    session,
    taskPool,
    supervision,
    goal,
    decomposer,
    service,
    async dispose() {
      await domain.close();
    },
  };
}

/** 造一条过质量门的标准计划（两任务覆盖两标准）并提请审批。 */
export async function makeGoodPlan(rig: Rig): Promise<{ planId: string; approvalId: string }> {
  const plan = await rig.service.proposePlan('goal-1');
  const { approvalId } = await rig.service.confirmRequest('human', plan.id);
  return { planId: plan.id, approvalId };
}

/** 凭一次性票据代建计划（approve → applyPlan）。 */
export async function approveAndApply(
  rig: Rig,
  planId: string,
  approvalId: string,
): Promise<readonly string[]> {
  const ticket = rig.supervision.approve(approvalId, `tok-${approvalId.replace('appr-', '')}`);
  return rig.service.applyPlan(planId, ticket);
}

export { PLANNER_PARAMS_KEY };
