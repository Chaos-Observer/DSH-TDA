/**
 * tda-task-pool 不变量门（门2 test:invariants）：两级注册，违规即抛 InvariantError。
 *
 * T0.2 §4.1 九条不变量逐条覆盖拒绝用例：
 *  1. 图无环：注入父环 / 依赖环 → 拒；运行期自依赖 → 拒
 *  2. 挂靠有效：目标不存在/非 active → 拒；注入"未终态任务挂 complete 目标" → 拒
 *  3. 引用完整：blockedBy 引用 tombstone → 拒（运行期 + 加载期）
 *  4. CAS 严格：并发 claim 恰一成功、一 STALE_REVISION
 *  5. 终态完备：blocked 无理由 / complete 无结果 / 暂停后 block / 终态再变更 → 拒
 *  6. 认领前置：依赖未完成 / 重复认领 / 在跑无归属 / 改派越权 → 拒
 *  7. 预算守恒：超父剩余 / 收紧低于子帽之和 / 超目标剩余 → 拒（含加载期兜底）
 *  8. 路径安全：绝对路径 / .. 逃逸 / 非规范存量 → 拒
 *  9. 周期派生正确：运行中周期缺 nextDueAt / 终态仍带 nextDueAt / 达 maxRuns 未停排 → 拒
 *  附：zone 派生字段被篡改 → 拒（防绕三区行为）
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  asTaskId,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  createTdaInvariantRegistry,
  InvariantError,
  openTdaDomain,
  registerTdaInvariants,
  StaleRevisionError,
  TDA_KERNEL_PACKAGE,
  type TdaDomain,
  type TdaInvariantRegistry,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  ZERO_CONSUMED,
  taskPoolDomainSpec,
  type GoalLookup,
  type GoalView,
  type TaskNode,
  type TaskPoolService,
  type TaskTables,
} from '../src/index.ts';
import { createTaskPoolService } from '../src/service.ts';
import { registerTaskPoolInvariants } from '../src/loadChecks.ts';

function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-task-inv'),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

/** 可控时钟：周期/预算测试的确定性来源。 */
function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

/** 假目标层：只在 seam 契约内提供只读视图 + consume 记账（不 import 目标插件）。 */
function createFakeGoals(goals: GoalView[] = []): {
  lookup: GoalLookup;
  mutate: (id: string, patch: Partial<GoalView>) => void;
  consumed: Map<string, { tokens: number; wallClockMs: number; attentionUnits: number }>;
} {
  const table = new Map<string, GoalView>(goals.map((goal) => [goal.id, goal]));
  const consumed = new Map<string, { tokens: number; wallClockMs: number; attentionUnits: number }>();
  return {
    lookup: {
      get: (id) => table.get(id),
      async consume(_actor, id, ref, usage) {
        const goal = table.get(id);
        if (goal === undefined) throw new Error(`假目标不存在：${id}`);
        if (goal.revision !== ref.expectedRevision) {
          const error = new Error('假目标修订号过期');
          (error as { code?: string }).code = 'STALE_REVISION';
          throw error;
        }
        const acc = consumed.get(id) ?? { tokens: 0, wallClockMs: 0, attentionUnits: 0 };
        acc.tokens += usage.tokens ?? 0;
        acc.wallClockMs += usage.wallClockMs ?? 0;
        acc.attentionUnits += usage.attentionUnits ?? 0;
        consumed.set(id, acc);
        table.set(id, { ...goal, revision: goal.revision + 1 });
      },
      focusGoalId: () => [...table.values()][0]?.id,
    },
    mutate: (id, patch) => {
      const goal = table.get(id);
      if (goal !== undefined) table.set(id, { ...goal, ...patch });
    },
    consumed,
  };
}

const activeGoal = (id = 'goal-1', tokens = 1000): GoalView => ({
  id,
  revision: 0,
  phase: 'active',
  budget: { tokens, consumed: { tokens: 0, wallClockMs: 0, attentionUnits: 0 } },
});

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<TaskTables>;
  readonly registry: TdaInvariantRegistry;
  readonly service: TaskPoolService;
  readonly clock: ReturnType<typeof createClock>;
}

async function assemble(
  dir: string,
  options: { readonly goals?: GoalLookup; readonly clock?: ReturnType<typeof createClock> } = {},
): Promise<Rig> {
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const registry = createTdaInvariantRegistry();
  const clock = options.clock ?? createClock();
  const domain = await openTdaDomain(taskPoolDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  registerTdaInvariants(registry, reconciler);
  registerTaskPoolInvariants(registry, domain, options.goals === undefined ? {} : { goalLookup: options.goals });
  const service = createTaskPoolService({
    domain,
    session: createMemorySink(),
    reconciler,
    index: createAuditIndex(),
    bus: createTdaEventBus(),
    ...(options.goals !== undefined ? { goalLookup: options.goals } : {}),
    now: clock.now,
  });
  return { dir, backend, domain, registry, service, clock };
}

async function teardown(rig: Rig): Promise<void> {
  await rig.domain.close();
  await rig.backend.close();
  // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', rig.dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

/** 合法 TaskNode 基件（注入用例用：zod 合法、业务违规）。 */
const baseNode = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  id: asTaskId(id),
  revision: 0,
  goalId: 'goal-1',
  subject: `任务 ${id}`,
  description: '',
  phase: 'active',
  stage: 'planning',
  blockedBy: [],
  writeScopes: [],
  priority: 0,
  schedule: {},
  runCount: 0,
  consecutiveFailures: 0,
  proposedBy: 'human',
  budget: { consumed: { ...ZERO_CONSUMED }, zone: 'normal' },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('tda-task-pool 不变量门', () => {
  it('不变量 1 图无环：运行期自依赖 / 依赖环拒；加载期注入父环拒', async () => {
    const fake = createFakeGoals([activeGoal()]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-cycle-')), { goals: fake.lookup });
    try {
      const a = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: 'A',
        budget: { tokens: 100 },
      });
      const b = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: 'B',
        budget: { tokens: 100 },
      });
      // 运行期：自依赖
      await expect(
        rig.service.edit('human', a.id, { expectedRevision: a.revision }, { blockedBy: [a.id] }),
      ).rejects.toThrow(/不得依赖自身|环/);
      // 运行期：A→B 后 B→A 成环
      const a2 = await rig.service.edit('human', a.id, { expectedRevision: a.revision }, { blockedBy: [b.id] });
      await expect(
        rig.service.edit('human', b.id, { expectedRevision: b.revision }, { blockedBy: [a2.id] }),
      ).rejects.toThrow(/环/);
      // 加载期：注入父环
      await rig.domain.table('task_nodes').put('task-90', baseNode('task-90', { parentTaskId: 'task-91' }));
      await rig.domain.table('task_nodes').put('task-91', baseNode('task-91', { parentTaskId: 'task-90' }));
      await expect(rig.registry.verify('tda-task-pool')).rejects.toBeInstanceOf(InvariantError);
      await expect(rig.registry.verify('tda-task-pool')).rejects.toThrow(/环/);
    } finally {
      await teardown(rig);
    }
  });

  it('不变量 2 挂靠有效：目标不存在/非 active 拒；注入未终态任务挂 complete 目标拒', async () => {
    const fake = createFakeGoals([activeGoal(), { ...activeGoal('goal-2'), phase: 'complete' }]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-goal-')), { goals: fake.lookup });
    try {
      await expect(
        rig.service.create('human', { goalId: 'goal-404' as never, subject: '孤儿' }),
      ).rejects.toThrow(/目标不存在/);
      await expect(
        rig.service.create('human', { goalId: 'goal-2' as never, subject: '挂在已完目标' }),
      ).rejects.toThrow(/非 active/);
      // 加载期：未终态任务挂在 complete 目标下
      fake.mutate('goal-1', { phase: 'complete' });
      await rig.domain.table('task_nodes').put('task-1', baseNode('task-1'));
      await expect(rig.registry.verify('tda-task-pool')).rejects.toThrow(/挂靠有效性|未终态/);
    } finally {
      await teardown(rig);
    }
  });

  it('不变量 3 引用完整：blockedBy 引用 tombstone → 运行期 TASK_REF_DELETED + 加载期拒', async () => {
    const fake = createFakeGoals([activeGoal()]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-ref-')), { goals: fake.lookup });
    try {
      const doomed = await rig.service.create('human', { goalId: 'goal-1' as never, subject: '将被删' });
      const deleted = await rig.service.delete('human', doomed.id, { expectedRevision: doomed.revision }, '作废');
      expect(deleted.deletedAt).toBeTypeOf('number');
      await expect(
        rig.service.create('human', { goalId: 'goal-1' as never, subject: '引用已删', blockedBy: [doomed.id] }),
      ).rejects.toThrow(/TASK_REF_DELETED|tombstone/);
      // 加载期注入（直写域绕过服务校验）
      await rig.domain.table('task_nodes').put('task-9', baseNode('task-9', { blockedBy: [String(doomed.id)] }));
      await expect(rig.registry.verify('tda-task-pool')).rejects.toThrow(/引用 tombstone/);
    } finally {
      await teardown(rig);
    }
  });

  it('不变量 4 CAS 严格：并发 claim 恰一成功、一 STALE_REVISION', async () => {
    const fake = createFakeGoals([activeGoal()]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-cas-')), { goals: fake.lookup });
    try {
      const task = await rig.service.create('human', { goalId: 'goal-1' as never, subject: '并发认领' });
      const results = await Promise.allSettled([
        rig.service.claim('agent', task.id, { expectedRevision: task.revision }, asSessionId('sess-a')),
        rig.service.claim('agent', task.id, { expectedRevision: task.revision }, asSessionId('sess-b')),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleRevisionError);
      const settled = rig.service.get(task.id);
      expect(settled?.revision).toBe(1);
      expect(settled?.stage).toBe('executing');
      await expect(rig.registry.verify()).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('不变量 5 终态完备：blocked 缺理由 / 暂停后 block / 终态再变更 / 无开窗 completeRun 全拒', async () => {
    const fake = createFakeGoals([activeGoal()]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-terminal-')), { goals: fake.lookup });
    try {
      // schema 恒等律：blocked 缺 blockedReason 直写即拒
      await expect(
        rig.domain.table('task_nodes').put('task-90', baseNode('task-90', { phase: 'blocked' })),
      ).rejects.toThrow(/必填 blockedReason/);
      // schema 恒等律：complete 缺 outcome 直写即拒
      await expect(
        rig.domain.table('task_nodes').put('task-91', baseNode('task-91', { phase: 'complete' })),
      ).rejects.toThrow(/必填 outcome/);

      const task = await rig.service.create('human', { goalId: 'goal-1' as never, subject: '迁移' });
      const paused = await rig.service.pause('human', task.id, { expectedRevision: task.revision });
      await expect(
        rig.service.block('agent', task.id, { expectedRevision: paused.revision }, { code: 'X', message: 'y' }),
      ).rejects.toThrow(/不允许/);
      await expect(
        rig.service.complete('human', task.id, { expectedRevision: paused.revision }, { outcome: 'failed' }),
      ).rejects.toThrow(/不允许/);
      const resumed = await rig.service.resume('human', task.id, { expectedRevision: paused.revision });
      const done = await rig.service.complete('human', task.id, { expectedRevision: resumed.revision }, { outcome: 'success' });
      expect(done.phase).toBe('complete');
      await expect(
        rig.service.edit('human', task.id, { expectedRevision: done.revision }, { subject: '改终态' }),
      ).rejects.toThrow(/TASK_COMPLETE|终态/);
      await expect(
        rig.service.completeRun('agent', task.id, { expectedRevision: done.revision }, { outcome: 'success' }),
      ).rejects.toThrow(/终态|无未收尾/);
    } finally {
      await teardown(rig);
    }
  });

  it('不变量 6 认领前置：依赖未完成 / 重复认领 / 改派越权 / 在跑无归属态拒', async () => {
    const fake = createFakeGoals([activeGoal()]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-claim-')), { goals: fake.lookup });
    try {
      const dep = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '前置',
        budget: { tokens: 100 },
      });
      const main = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '依赖前置',
        blockedBy: [dep.id],
        budget: { tokens: 100 },
      });
      expect(rig.service.ready()).toHaveLength(1); // 仅 dep 可认领
      await expect(
        rig.service.claim('agent', main.id, { expectedRevision: main.revision }, asSessionId('sess-a')),
      ).rejects.toThrow(/依赖未完成/);
      const claimed = await rig.service.claim('agent', dep.id, { expectedRevision: dep.revision }, asSessionId('sess-a'));
      await expect(
        rig.service.claim('agent', dep.id, { expectedRevision: claimed.revision }, asSessionId('sess-b')),
      ).rejects.toThrow(/不可认领/);
      // 改派越权：agent 不得强制改派（不变量 6）
      await expect(
        rig.service.reassign('agent', dep.id, { expectedRevision: claimed.revision }, asSessionId('sess-b')),
      ).rejects.toThrow(/TASK_FORCE_REQUIRED|人类/);
      // 加载期：在跑却无人负责（stage=executing 但无 owner）
      await rig.domain.table('task_nodes').put('task-92', baseNode('task-92', { stage: 'executing' }));
      await expect(rig.registry.verify('tda-task-pool')).rejects.toThrow(/无 ownerId|归属/);
    } finally {
      await teardown(rig);
    }
  });

  it('不变量 7 预算守恒：超父剩余 / 收紧低于子帽 / 超目标剩余 / 加载期兜底全拒', async () => {
    const fake = createFakeGoals([activeGoal('goal-1', 100)]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-budget-')), { goals: fake.lookup });
    try {
      const root = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '根',
        budget: { tokens: 60 },
      });
      // 超目标剩余：根任务帽之和不得超目标剩余 100
      await expect(
        rig.service.create('human', { goalId: 'goal-1' as never, subject: '根二', budget: { tokens: 60 } }),
      ).rejects.toThrow(/超过目标/);
      const child = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '子',
        parentTaskId: root.id,
        budget: { tokens: 40 },
      });
      // 超父剩余：root 剩余 60，再挂 30 的兄弟即 70 > 60
      await expect(
        rig.service.create('human', {
          goalId: 'goal-1' as never,
          subject: '子二',
          parentTaskId: root.id,
          budget: { tokens: 30 },
        }),
      ).rejects.toThrow(/超过父任务/);
      // 收紧自帽低于子帽之和
      await expect(
        rig.service.edit('human', root.id, { expectedRevision: rig.service.get(root.id)?.revision ?? 0 }, { budget: { tokens: 10 } }),
      ).rejects.toThrow(/超过新帽/);
      // 加载期兜底：注入子帽之和超父帽
      await rig.domain.table('task_nodes').put('task-93', baseNode('task-93', {
        parentTaskId: 'task-1',
        budget: { tokens: 999, consumed: { ...ZERO_CONSUMED }, zone: 'normal' },
      }));
      await expect(rig.registry.verify('tda-task-pool')).rejects.toThrow(/超过父帽/);
      expect(child.budget.tokens).toBe(40);
    } finally {
      await teardown(rig);
    }
  });

  it('不变量 8 路径安全：绝对路径 / .. 逃逸 / 非规范存量全拒，合法路径被规范化', async () => {
    const fake = createFakeGoals([activeGoal()]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-path-')), { goals: fake.lookup });
    try {
      await expect(
        rig.service.create('human', { goalId: 'goal-1' as never, subject: '绝对', localPath: '/etc/passwd' }),
      ).rejects.toThrow(/UNSAFE_PATH|绝对路径/);
      await expect(
        rig.service.create('human', { goalId: 'goal-1' as never, subject: '盘符', localPath: 'C:\\Windows' }),
      ).rejects.toThrow(/UNSAFE_PATH|绝对路径/);
      await expect(
        rig.service.create('human', { goalId: 'goal-1' as never, subject: '逃逸', localPath: 'a/../../b' }),
      ).rejects.toThrow(/UNSAFE_PATH|逃逸/);
      await expect(
        rig.service.create('human', {
          goalId: 'goal-1' as never,
          subject: '作用域逃逸',
          writeScopes: ['../outside'],
        }),
      ).rejects.toThrow(/UNSAFE_PATH|逃逸/);
      // 规范化：分隔符归一、去尾斜杠
      const ok = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '合法',
        localPath: 'tasks\\sub\\',
        writeScopes: ['src/./core'],
      });
      expect(ok.localPath).toBe('tasks/sub');
      expect(ok.writeScopes).toEqual(['src/core']);
      // 加载期：注入非规范存量
      await rig.domain.table('task_nodes').put('task-94', baseNode('task-94', { localPath: '../escape' }));
      await expect(rig.registry.verify('tda-task-pool')).rejects.toThrow(/非规范形态/);
    } finally {
      await teardown(rig);
    }
  });

  it('不变量 9 周期派生正确：运行中缺 nextDueAt / 终态带 nextDueAt / 超 maxRuns 未停排 / 越 endAt 全拒', async () => {
    const fake = createFakeGoals([activeGoal()]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-recur-')), { goals: fake.lookup });
    try {
      // 运行中的周期任务缺 nextDueAt：schema 恒等律直接拒（durable 调度锚点不可缺）
      await expect(
        rig.domain.table('task_nodes').put(
          'task-95',
          baseNode('task-95', { recurrence: { kind: 'interval', intervalMs: 1000 } }),
        ),
      ).rejects.toThrow(/必带 nextDueAt/);

      // 终态仍带 nextDueAt → 拒（停排未生效）
      await expect(
        rig.domain.table('task_nodes').put(
          'task-96',
          baseNode('task-96', {
            phase: 'complete',
            outcome: 'success',
            recurrence: { kind: 'interval', intervalMs: 1000 },
            nextDueAt: 5,
          }),
        ),
      ).rejects.toThrow(/不得携带 nextDueAt/);

      // 超跑（runCount > maxRuns）却仍在跑 → 拒；恰好跑满不算违规（下一轮才停排）
      await expect(
        rig.domain.table('task_nodes').put(
          'task-97',
          baseNode('task-97', {
            recurrence: { kind: 'interval', intervalMs: 1000, maxRuns: 1 },
            runCount: 2,
            lastRunAt: 1,
            nextDueAt: 10,
          }),
        ),
      ).rejects.toThrow(/maxRuns|停排/);

      // nextDueAt 越过 endAt：schema 无此形（跨字段推导），由加载期检查兜住
      await rig.domain.table('task_nodes').put(
        'task-98',
        baseNode('task-98', {
          recurrence: { kind: 'interval', intervalMs: 1000, endAt: 100 },
          nextDueAt: 200,
        }),
      );
      await expect(rig.registry.verify('tda-task-pool')).rejects.toThrow(/越过 endAt|停排/);

      // 同一形但 nextDueAt ≤ endAt 合法（对照组，确认检查不是全拒）
      await rig.domain.table('task_nodes').put(
        'task-99',
        baseNode('task-99', {
          recurrence: { kind: 'interval', intervalMs: 1000, endAt: 5000 },
          nextDueAt: 4000,
        }),
      );
      const ref = rig.domain.table('task_nodes').get('task-98');
      await rig.domain.table('task_nodes').delete('task-98');
      expect(ref?.recurrence?.endAt).toBe(100);
      await expect(rig.registry.verify('tda-task-pool')).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('派生字段 tamper：zone 与帽/账本不一致 → 直写即拒（防绕三区行为）', async () => {
    const fake = createFakeGoals([activeGoal()]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-zone-')), { goals: fake.lookup });
    try {
      await expect(
        rig.domain.table('task_nodes').put(
          'task-99',
          baseNode('task-99', { budget: { tokens: 10, consumed: { ...ZERO_CONSUMED, tokens: 10 }, zone: 'normal' } }),
        ),
      ).rejects.toThrow(/zone=normal 与按帽\/账本重算的 exhausted 不一致/);
    } finally {
      await teardown(rig);
    }
  });

  it('合法全路径：create→claim→consume→block→resume→complete 两级不变量全过', async () => {
    const fake = createFakeGoals([activeGoal('goal-1', 10_000)]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-ok-')), { goals: fake.lookup });
    try {
      const task = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '全路径',
        budget: { tokens: 1000, toolCalls: 10 },
        localPath: 'work/out',
      });
      const claimed = await rig.service.claim('agent', task.id, { expectedRevision: task.revision }, asSessionId('sess-run'));
      const consumed = await rig.service.consume('agent', task.id, { expectedRevision: claimed.revision }, { tokens: 100, toolCalls: 2 });
      const blocked = await rig.service.block('scheduler', task.id, { expectedRevision: consumed.revision }, { code: 'WAIT_INPUT', message: '等人工' });
      const resumed = await rig.service.resume('human', task.id, { expectedRevision: blocked.revision });
      const done = await rig.service.complete('human', task.id, { expectedRevision: resumed.revision }, {
        outcome: 'success',
        evidence: ['e2e-1'],
      });
      expect(done.phase).toBe('complete');
      expect(done.budget.consumed.tokens).toBe(100);
      expect(done.evidence).toEqual(['e2e-1']);
      // 账本向上汇聚到目标（seam）
      expect(fake.consumed.get('goal-1')?.tokens).toBe(100);
      expect(rig.service.runs(task.id)).toHaveLength(1);
      expect(rig.service.runs(task.id)[0]?.outcome).toBe('success');
      await expect(rig.registry.verify()).resolves.toBeUndefined();
      await expect(rig.registry.verify(TDA_KERNEL_PACKAGE)).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('内核级联动：直写 task_nodes 绕过双写 → 漏双写被内核门捕获', async () => {
    const fake = createFakeGoals([activeGoal()]);
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-inv-leak-')), { goals: fake.lookup });
    try {
      await rig.domain.table('task_nodes').put('task-99', baseNode('task-99'));
      await expect(rig.registry.verify(TDA_KERNEL_PACKAGE)).rejects.toThrow(/漏双写/);
    } finally {
      await teardown(rig);
    }
  });
});
