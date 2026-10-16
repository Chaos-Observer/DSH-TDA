/**
 * tda-executor 测试helpers：内存假体实现被依赖的各服务面，并记录调用日志
 * （否定性断言如"执行环从不直写他域/从不自行 complete 失败任务"靠 calls 自证）。
 */
import { mkdtemp, } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
import { executorDomainSpec, EXECUTOR_PARAMS_KEY, type ExecutorTables } from '../src/domain.ts';
import {
  createExecutorService,
  type ExecutorDispatchSeam,
  type ExecutorGoalSeam,
  type ExecutorSupervisionSeam,
  type ExecutorTaskPoolSeam,
  type ExecutorTaskView,
  type ExecutorTimelineSeam,
  type ExecutorWorkflowSeam,
  type ExecutorWorkflowDefView,
  type ExecutorWorkflowRunView,
  type TaskExecutorService,
} from '../src/service.ts';

export const NOW = 1_700_000_000_000;

export function makeTask(overrides: Partial<ExecutorTaskView> = {}): ExecutorTaskView {
  return {
    id: 'task-1',
    revision: 1,
    goalId: 'goal-1',
    subject: '整理依赖清单',
    phase: 'active',
    stage: 'planning',
    blockedBy: [],
    priority: 5,
    zone: 'normal',
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: NOW - 10_000,
    writeScopes: [],
    ...overrides,
  };
}

// ── 假 session sink（记录 append，回传自增 seq） ────────────────────────

export interface FakeSession {
  readonly sessionId: string;
  readonly appends: { family: string; businessId: string; payload: Record<string, unknown> }[];
  append(event: { family: string; businessId: string; payload: Record<string, unknown> }): number;
  flush(): void;
}

export function createFakeSession(sessionId = 'sess-executor'): FakeSession {
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

export interface FakeTaskPool extends ExecutorTaskPoolSeam {
  readonly tasks: Map<string, ExecutorTaskView>;
  readonly calls: string[];
  /** 测试开关：claim 一律抛 STALE_REVISION（模拟并发 revision 漂移）。 */
  claimStale: boolean;
  seed(task: ExecutorTaskView): void;
}

export function createFakeTaskPool(seed: readonly ExecutorTaskView[] = []): FakeTaskPool {
  const tasks = new Map<string, ExecutorTaskView>();
  for (const task of seed) tasks.set(task.id, task);
  const calls: string[] = [];
  const fake: FakeTaskPool = {
    tasks,
    calls,
    claimStale: false,
    seed(task) {
      tasks.set(task.id, task);
    },
    ready() {
      return [...tasks.values()].filter((task) => task.ownerId === undefined && task.blockedBy.length === 0);
    },
    get(id) {
      return tasks.get(id);
    },
    async claim(_actor, id, ref, ownerId) {
      calls.push(`claim:${id}`);
      if (fake.claimStale) {
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
      }
      const current = tasks.get(id);
      if (current === undefined) throw new Error(`TASK_NOT_FOUND:${id}`);
      if (current.revision !== ref.expectedRevision) {
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
      }
      const next = { ...current, revision: current.revision + 1, ownerId };
      tasks.set(id, next);
      return next;
    },
    async release(_actor, id, ref) {
      calls.push(`release:${id}`);
      const current = tasks.get(id);
      if (current === undefined) throw new Error(`TASK_NOT_FOUND:${id}`);
      if (current.revision !== ref.expectedRevision) {
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
      }
      const next = { ...current, revision: current.revision + 1, ownerId: undefined };
      tasks.set(id, next);
      return next;
    },
    async block(_actor, id, ref, reason) {
      calls.push(`block:${id}:${reason.code}`);
      const current = tasks.get(id);
      if (current === undefined) throw new Error(`TASK_NOT_FOUND:${id}`);
      if (current.revision !== ref.expectedRevision) {
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
      }
      const next = { ...current, revision: current.revision + 1, stage: 'waiting' };
      tasks.set(id, next);
      return next;
    },
    async complete(_actor, id, ref, completion) {
      calls.push(`complete:${id}:${completion.outcome}`);
      const current = tasks.get(id);
      if (current === undefined) throw new Error(`TASK_NOT_FOUND:${id}`);
      if (current.revision !== ref.expectedRevision) {
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
      }
      const next: ExecutorTaskView = {
        ...current,
        revision: current.revision + 1,
        stage: completion.outcome === 'success' ? 'done' : 'failed',
        ownerId: undefined,
      };
      tasks.set(id, next);
      return next;
    },
  };
  return fake;
}

// ── 假 dispatch（默认 scripted：settled + 结论带 entryId） ──────────────

export interface FakeDispatch extends ExecutorDispatchSeam {
  readonly calls: string[];
  readonly orders: Map<string, { id: string; taskId: string; status: string; revision: number }>;
  configure(opts: { status?: string; conclusionOutcome?: string; entryId?: string | null }): void;
}

export function createFakeDispatch(): FakeDispatch {
  const calls: string[] = [];
  const orders = new Map<string, { id: string; taskId: string; status: string; revision: number }>();
  let opts: { status?: string; conclusionOutcome?: string; entryId?: string | null } = {};
  let counter = 0;
  return {
    calls,
    orders,
    configure(next) {
      opts = next;
    },
    async dispatch(_caller, req) {
      calls.push(`dispatch:${req.taskId}`);
      counter += 1;
      const order = { id: `disp-${counter}`, taskId: req.taskId, status: opts.status ?? 'approved', revision: 0 };
      orders.set(order.id, order);
      return order;
    },
    async driveOrder(_caller, orderId) {
      calls.push(`driveOrder:${orderId}`);
      const order = orders.get(orderId);
      if (order === undefined) throw new Error(`DISPATCH_NOT_FOUND:${orderId}`);
      if (order.status === 'requested') {
        throw Object.assign(new Error('approval required'), { code: 'DISPATCH_APPROVAL_REQUIRED' });
      }
      order.status = 'settled';
      return { id: order.id, taskId: order.taskId, status: order.status };
    },
    conclusionOf(orderId) {
      const order = orders.get(orderId);
      if (order === undefined || order.status !== 'settled') return undefined;
      if (opts.conclusionOutcome === 'conclusion-partial') {
        return { taskId: order.taskId, role: 'sidekick', outcome: 'conclusion-partial', findings: [], confidence: 0.4 };
      }
      if (opts.entryId === null) {
        return { taskId: order.taskId, role: 'sidekick', outcome: 'conclusion', findings: ['x'], confidence: 0.9 };
      }
      return {
        taskId: order.taskId,
        role: 'sidekick',
        outcome: 'conclusion',
        findings: ['发现 A'],
        confidence: 0.9,
        entryId: opts.entryId ?? 'tl-1',
      };
    },
  };
}

// ── 假 workflow（definitions + start，默认 completed run） ──────────────

export interface FakeWorkflow extends ExecutorWorkflowSeam {
  readonly calls: string[];
  readonly defs: ExecutorWorkflowDefView[];
  readonly runs: Map<string, ExecutorWorkflowRunView>;
  configure(opts: { runStatus?: string; runOutcome?: string }): void;
}

export function createFakeWorkflow(): FakeWorkflow {
  const calls: string[] = [];
  const defs: ExecutorWorkflowDefView[] = [];
  const runs = new Map<string, ExecutorWorkflowRunView>();
  let opts: { runStatus?: string; runOutcome?: string } = {};
  let counter = 0;
  return {
    calls,
    defs,
    runs,
    configure(next) {
      opts = next;
    },
    definitions() {
      return defs;
    },
    async start(_actor, defId, _params, taskId) {
      calls.push(`start:${defId}:${taskId}`);
      counter += 1;
      const run: ExecutorWorkflowRunView = {
        runId: `wfrun-${counter}`,
        status: opts.runStatus ?? 'completed',
        ...(opts.runOutcome !== undefined ? { outcome: opts.runOutcome } : {}),
      };
      runs.set(run.runId, run);
      return run;
    },
  };
}

// ── 假 supervision（request/approve/pending + token 一次性） ────────────

export interface FakeSupervision extends ExecutorSupervisionSeam {
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
      const token = `tok-${counter}`;
      tokens.set(approvalId, token);
      requests.push({ approvalId, kind: input.kind, resume: input.resume, status: 'pending' });
      return { approvalId };
    },
    approve(approvalId, token) {
      calls.push(`approve:${approvalId}`);
      const expected = tokens.get(approvalId);
      if (expected === undefined || expected !== token) {
        throw Object.assign(new Error('token invalid'), { code: 'APPROVAL_TOKEN_INVALID' });
      }
      tokens.delete(approvalId); // 一次性
      const request = requests.find((item) => item.approvalId === approvalId);
      if (request !== undefined) request.status = 'approved';
      return {
        approvalId,
        nonce: `nonce-${approvalId}`,
        from: request?.resume.from ?? '',
        handle: request?.resume.handle ?? '',
      };
    },
    pending() {
      return requests
        .filter((item) => item.status === 'pending')
        .map((item) => ({ approvalId: item.approvalId, kind: item.kind, status: item.status }));
    },
  };
}

// ── 假 goal / timeline（只读） ─────────────────────────────────────────

export function createFakeGoal(criteria: readonly string[] = []): ExecutorGoalSeam {
  return {
    get(id) {
      if (id !== 'goal-1') return undefined;
      return { id, completionCriteria: criteria };
    },
  };
}

export function createFakeTimeline(entryIds: readonly string[] = []): ExecutorTimelineSeam {
  const present = new Set(entryIds);
  return {
    get(id) {
      return present.has(id) ? { id } : undefined;
    },
  };
}

// ── 装配 ───────────────────────────────────────────────────────────────

export interface Rig {
  readonly dir: string;
  readonly domain: TdaDomain<ExecutorTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly bus: TdaEventBus;
  readonly published: TdaBusEvent[];
  readonly session: FakeSession;
  readonly taskPool: FakeTaskPool;
  readonly dispatch: FakeDispatch;
  readonly workflow: FakeWorkflow;
  readonly supervision: FakeSupervision;
  readonly goal: ExecutorGoalSeam;
  readonly timeline: ExecutorTimelineSeam;
  readonly service: TaskExecutorService;
  dispose(): Promise<void>;
}

export interface RigOptions {
  readonly tasks?: readonly ExecutorTaskView[];
  readonly goalCriteria?: readonly string[];
  readonly timelineEntries?: readonly string[];
  readonly isMainActive?: () => boolean;
  readonly bootAt?: number;
  readonly now?: () => number;
}

export async function setup(options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-executor-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(executorDomainSpec, {
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
  bus.subscribe('executor/change', (event) => {
    published.push(event);
  });
  const session = createFakeSession();
  const taskPool = createFakeTaskPool(options.tasks ?? []);
  const dispatch = createFakeDispatch();
  const workflow = createFakeWorkflow();
  const supervision = createFakeSupervision();
  const goal = createFakeGoal(options.goalCriteria ?? []);
  const timeline = createFakeTimeline(options.timelineEntries ?? []);
  const service = createExecutorService({
    domain,
    session: session as never,
    taskPool,
    dispatch,
    workflow,
    supervision,
    goal,
    timeline,
    ownerSessionId: 'sess-harness-scheduler',
    bootAt: options.bootAt ?? NOW,
    reconciler,
    index,
    bus,
    now: options.now ?? ((): number => NOW),
    ...(options.isMainActive !== undefined ? { isMainActive: options.isMainActive } : {}),
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
    dispatch,
    workflow,
    supervision,
    goal,
    timeline,
    service,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，detached 子进程清理（不占 libuv 线程池）
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    },
  };
}

export { EXECUTOR_PARAMS_KEY };
