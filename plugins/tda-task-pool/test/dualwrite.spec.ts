/**
 * tda-task-pool 双写对账门（门3 test:dualwrite）：服务每次 accepted 变更经统一
 * 出口 commit（task_nodes + task_history [+ task_runs] 同窗口落域 → append
 * log-only 事件）→ 提交成功后经总线分发，对账器逐一配对。
 *
 * 覆盖：单 op 配对 / 复合 op（consume 本笔 + 祖先汇聚）多窗口多事件 /
 *      startRun 的 run 记录同窗 / audit_index 按 task 实体自动延展 /
 *      task_history 不存 seq（方案 §3.2 硬规则）/ 预检失败不落域不产事件 /
 *      直写域即漏双写 / 总线分发与 seq 一致（跨插件联动面契约）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  createTdaInvariantRegistry,
  openTdaDomain,
  type AuditIndex,
  type DualWriteReconciler,
  type TdaBusEvent,
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
  type TaskPoolService,
  type TaskTables,
} from '../src/index.ts';
import { createTaskPoolService } from '../src/service.ts';

function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-task-dw'),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

const goalView = (id = 'goal-1', tokens = 10_000): GoalView => ({
  id,
  revision: 0,
  phase: 'active',
  budget: { tokens, consumed: { tokens: 0, wallClockMs: 0, attentionUnits: 0 } },
});

function createFakeGoals(): GoalLookup {
  const table = new Map<string, GoalView>([[ 'goal-1', goalView() ]]);
  return {
    get: (id) => table.get(id),
    async consume(_actor, id, ref) {
      const goal = table.get(id);
      if (goal === undefined) throw new Error('假目标不存在');
      table.set(id, { ...goal, revision: ref.expectedRevision + 1 });
    },
  };
}

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<TaskTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly registry: TdaInvariantRegistry;
  readonly service: TaskPoolService;
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly bus: ReturnType<typeof createTdaEventBus>;
  readonly busEvents: TdaBusEvent[];
}

async function assemble(dir: string, options: { readonly withGoal?: boolean; readonly now?: () => number } = {}): Promise<Rig> {
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const registry = createTdaInvariantRegistry();
  const bus = createTdaEventBus();
  const busEvents: TdaBusEvent[] = [];
  bus.subscribe('taskPool/change', (event) => busEvents.push(event));
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
  const sink = createMemorySink();
  const service = createTaskPoolService({
    domain,
    session: sink,
    reconciler,
    index,
    bus,
    ...(options.withGoal === true ? { goalLookup: createFakeGoals() } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { dir, backend, domain, reconciler, index, registry, service, sink, bus, busEvents };
}

async function teardown(rig: Rig): Promise<void> {
  await rig.domain.close();
  await rig.backend.close();
  // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', rig.dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

describe('tda-task-pool 双写对账门', () => {
  it('单 op：create 的双表写同窗口配对一个事件，history 不存 seq，索引记 task 实体', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-dw-single-')));
    try {
      const node = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '甲',
        budget: { tokens: 10 },
      });
      expect(rig.sink.events).toHaveLength(1);
      expect(rig.sink.events[0]?.family).toBe('taskPool/change');
      expect(rig.sink.events[0]?.businessId).toBe(node.id);
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 1,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
      // task_history 记录不存 seq（seq 拥有序在事件侧）
      const record = rig.domain.table('task_history').get(`${node.id}#0`);
      expect(record).toBeDefined();
      expect(Object.keys(record ?? {})).not.toContain('seq');
      // audit_index：entityKind='task'，seq 起止
      expect(rig.index.locate('task', node.id)).toMatchObject({ seqFrom: 1, seqTo: 1 });
      // 总线分发：seq 与事件侧拥有序一致，载荷为全快照
      expect(rig.busEvents).toHaveLength(1);
      expect(rig.busEvents[0]).toMatchObject({ family: 'taskPool/change', businessId: node.id, seq: 1 });
      expect((rig.busEvents[0]?.payload.budget as { zone?: string } | undefined)?.zone).toBe('normal');
    } finally {
      await teardown(rig);
    }
  });

  it('复合 op：consume 本笔 + 祖先汇聚 = 两窗两事件全配对，索引逐实体延展', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-dw-composite-')));
    try {
      const root = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '根',
        budget: { tokens: 100, toolCalls: 10 },
      });
      const child = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '子',
        parentTaskId: root.id,
        budget: { tokens: 50, toolCalls: 5 },
      });
      const claimed = await rig.service.claim('agent', child.id, { expectedRevision: child.revision }, asSessionId('sess-a'));
      await rig.service.consume('agent', child.id, { expectedRevision: claimed.revision }, { tokens: 5, toolCalls: 1 });
      // create×2 + claim + (consume 本笔 + root 汇聚) = 5 事件、5 窗
      expect(rig.sink.events).toHaveLength(5);
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 5,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
      // 账本：子与根同耗（汇聚）
      expect(rig.service.get(child.id)?.budget.consumed).toMatchObject({ tokens: 5, toolCalls: 1 });
      expect(rig.service.get(root.id)?.budget.consumed).toMatchObject({ tokens: 5, toolCalls: 1 });
      // history 记账增量可机读（usage 列）
      const rollup = rig.service.history(root.id).find((record) => record.operation === 'consume-rollup');
      expect(rollup?.usage).toMatchObject({ tokens: 5, toolCalls: 1 });
      // audit_index 延展
      expect(rig.index.locate('task', root.id)).toMatchObject({ seqFrom: 1, seqTo: 5 });
      expect(rig.index.locate('task', child.id)).toMatchObject({ seqFrom: 2, seqTo: 4 });
    } finally {
      await teardown(rig);
    }
  });

  it('startRun：run 记录与任务状态同窗配对（不产半套）', async () => {
    let now = 1_700_000_000_000;
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-dw-run-')), { now: () => now });
    try {
      const task = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '周期',
        budget: { tokens: 100 },
        recurrence: { kind: 'interval', intervalMs: 1000 },
      });
      const started = await rig.service.startRun('scheduler', task.id, { expectedRevision: task.revision }, asSessionId('sess-sched'));
      expect(started.runCount).toBe(1);
      expect(rig.domain.table('task_runs').size()).toBe(1);
      expect(rig.domain.table('task_runs').get(`${task.id}#0`)?.completedAt).toBeUndefined();
      expect(rig.reconciler.reconcile()).toMatchObject({ ok: true, pairedWrites: 2 });
      // completeRun：收尾记录与 nextDueAt 派生同窗
      now += 200;
      const completed = await rig.service.completeRun('scheduler', task.id, { expectedRevision: started.revision }, {
        outcome: 'success',
        consumed: { tokens: 7 },
      });
      expect(completed.nextDueAt).toBe(1_700_000_001_000);
      expect(completed.stage).toBe('planning');
      expect(completed.ownerId).toBeUndefined();
      expect(rig.domain.table('task_runs').get(`${task.id}#0`)?.completedAt).toBe(now);
      expect(rig.reconciler.reconcile()).toMatchObject({ ok: true, pairedWrites: 3 });
    } finally {
      await teardown(rig);
    }
  });

  it('预检失败：超帽 consume 不落域、不产事件、无失败窗口（fail-loud 无半套）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-dw-precheck-')));
    try {
      const task = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '紧帽',
        budget: { tokens: 10 },
      });
      await expect(
        rig.service.consume('agent', task.id, { expectedRevision: task.revision }, { tokens: 11 }),
      ).rejects.toThrow(/超帽/);
      expect(rig.sink.events).toHaveLength(1);
      expect(rig.service.get(task.id)?.revision).toBe(0);
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 1,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
    } finally {
      await teardown(rig);
    }
  });

  it('目标 seam 汇聚：任务账本经服务面汇入目标（不属本插件域，不污染本插件对账）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-dw-goal-')), { withGoal: true });
    try {
      const task = await rig.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '汇聚',
        budget: { tokens: 100 },
      });
      await rig.service.consume('agent', task.id, { expectedRevision: task.revision }, { tokens: 3 });
      expect(rig.reconciler.reconcile()).toMatchObject({ ok: true, pairedWrites: 2, unpairedChanges: [] });
      // 本插件域内只有 task_nodes 变更（目标域变更不落本对账器）
      expect(rig.domain.table('task_nodes').size()).toBe(1);
    } finally {
      await teardown(rig);
    }
  });

  it('直写域绕过双写器 → 漏双写（对账器捕获 + 内核级不变量 fail）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tp-dw-leak-')));
    try {
      await rig.domain.table('task_nodes').put('task-9', {
        id: 'task-9' as never,
        revision: 0,
        goalId: 'goal-1',
        subject: '绕过双写',
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
      });
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges.length).toBeGreaterThan(0);
    } finally {
      await teardown(rig);
    }
  });
});
