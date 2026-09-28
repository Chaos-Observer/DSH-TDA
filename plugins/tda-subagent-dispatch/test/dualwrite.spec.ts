/**
 * tda-subagent-dispatch 双写对账门（门3 test:dualwrite）。
 *
 * 覆盖：状态机每一步都配对（建单/批准/开跑/发布/结算/取消）/
 *      策略种子与策略变更同族配对（businessId=policy:<role>）/
 *      audit_index 按 dispatch 实体自动延展 / 总线分发与 seq 一致 /
 *      预检失败不落域不产事件（fail-loud 但不留半套）/
 *      replay-equivalence：由事件载荷逐字段重建 dispatch_orders 零差异。
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
  registerTdaInvariants,
  type AuditIndex,
  type DualWriteReconciler,
  type TdaBusEvent,
  type TdaDomain,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import {
  createFixedProvider,
  dispatchDomainSpec,
  createSubagentDispatchService,
  type DispatchTables,
  type SubagentDispatchService,
} from '../src/index.ts';
import { createFakeTaskPool, createFakeTimeline, createMemorySink } from './helpers.ts';

interface Rig {
  readonly service: SubagentDispatchService;
  readonly domain: TdaDomain<DispatchTables>;
  readonly sink: TdaSessionSink & { readonly events: TdaLogEvent[] };
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly published: TdaBusEvent[];
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-dispatch-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(dispatchDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  const sink = createMemorySink('sess-dispatch-dw');
  const bus = createTdaEventBus();
  const published: TdaBusEvent[] = [];
  bus.subscribe('dispatch/change', (event) => {
    published.push(event);
  });
  const pool = createFakeTaskPool();
  const timeline = createFakeTimeline();
  const service = createSubagentDispatchService({
    domain,
    session: sink,
    provider: createFixedProvider({ findings: ['ok'], confidence: 1 }, { tokens: 10, toolCalls: 2, wallClockMs: 5 }),
    reconciler,
    index,
    bus,
    taskPool: pool.seam,
    timeline: timeline.seam,
  });
  return {
    service,
    domain,
    sink,
    reconciler,
    index,
    published,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

const caller = { actor: 'agent' as const, sessionId: asSessionId('sess-lead') };

describe('T0.5 双写配对', () => {
  it('状态机每一步配对；策略种子随首次使用落域且配对', async () => {
    const rig = await setup();
    try {
      const order = await rig.service.dispatch(caller, { taskId: 'task-1' as never, role: 'sidekick' });
      const begun = await rig.service.start(caller, order.id, { expectedRevision: order.revision });
      await rig.service.settle(caller, begun.order.id, { expectedRevision: begun.order.revision });

      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.unpairedChanges).toEqual([]);
      expect(report.unmatchedWrites).toBe(0);
      expect(report.failedWindows).toBe(0);
      // 2 条策略种子 + 建单 + 开跑(starting) + 发布(running) + 结算 = 6 个配对窗口
      expect(report.pairedWrites).toBe(6);
      // 内核级检查（@tda/kernel 双写配对）在同一 registry 上通过
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, rig.reconciler);
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('高风险链（建单→批准→开跑→结算）每一步配对，且 token 消费计入同一快照', async () => {
    const rig = await setup();
    try {
      const order = await rig.service.dispatch(caller, { taskId: 'task-1' as never, role: 'lead' });
      const approved = await rig.service.approve(
        { actor: 'human', sessionId: asSessionId('sess-human'), lead: true },
        order.id,
        { expectedRevision: order.revision },
      );
      const begun = await rig.service.start(caller, approved.id, { expectedRevision: approved.revision });
      await rig.service.settle(caller, begun.order.id, { expectedRevision: begun.order.revision });

      expect(rig.reconciler.reconcile().ok).toBe(true);
      // 事件流里能读到"发凭据"与"消费凭据"两个状态（审计可证）
      const approvals = rig.sink.events
        .filter((event) => event.family === 'dispatch/change')
        .map((event) => (event.payload.approval as { token?: string; consumedAt?: number } | undefined) ?? {})
        .filter((approval) => approval.token !== undefined || approval.consumedAt !== undefined);
      expect(approvals.some((approval) => typeof approval.token === 'string')).toBe(true);
      expect(approvals.some((approval) => typeof approval.consumedAt === 'number')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('取消（显式终态）配对；audit_index 按 dispatch 实体自动延展', async () => {
    const rig = await setup();
    try {
      const order = await rig.service.dispatch(caller, { taskId: 'task-1' as never, role: 'sidekick' });
      await rig.service.cancel(caller, order.id, { expectedRevision: order.revision });
      expect(rig.reconciler.reconcile().ok).toBe(true);
      const located = rig.index.locate('dispatch', order.id);
      expect(located).toBeDefined();
      expect(located?.sessionId).toBe(rig.sink.sessionId);
      expect(located?.seqTo).toBeGreaterThanOrEqual(located?.seqFrom ?? 0);
    } finally {
      await rig.dispose();
    }
  });

  it('总线分发与 seq 一致（跨插件联动面契约）', async () => {
    const rig = await setup();
    try {
      const order = await rig.service.dispatch(caller, { taskId: 'task-1' as never, role: 'sidekick' });
      const begun = await rig.service.start(caller, order.id, { expectedRevision: order.revision });
      await rig.service.settle(caller, begun.order.id, { expectedRevision: begun.order.revision });
      expect(rig.published).toHaveLength(4); // 建单 / starting / running / settled
      expect(rig.published.map((event) => event.businessId)).toEqual([order.id, order.id, order.id, order.id]);
      // seq 与 sink 分配序一致（1..n 单调）
      const seqs = rig.published.map((event) => event.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      // 载荷 = 全快照（业务 id 与记录 key 相同）
      const last = rig.published.at(-1);
      expect(last?.payload.id).toBe(order.id);
      expect(last?.payload.status).toBe('settled');
    } finally {
      await rig.dispose();
    }
  });

  it('预检失败不落域不产事件（capability 门 fail-loud 不留半套）', async () => {
    const rig = await setup();
    try {
      await expect(
        rig.service.dispatch(caller, { taskId: 'task-1' as never, role: 'sidekick', maxTokens: 0 }),
      ).resolves.toBeDefined();
      const before = rig.sink.events.length;
      await expect(
        rig.service.dispatch(
          { ...caller, depth: 2 },
          { taskId: 'task-1' as never, role: 'sidekick' },
        ),
      ).rejects.toMatchObject({ code: 'DISPATCH_DEPTH_EXCEEDED' });
      expect(rig.sink.events.length).toBe(before);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('replay-equivalence：由事件载荷重建 dispatch_orders 零差异', async () => {
    const rig = await setup();
    try {
      const first = await rig.service.dispatch(caller, { taskId: 'task-1' as never, role: 'sidekick' });
      const begun = await rig.service.start(caller, first.id, { expectedRevision: first.revision });
      await rig.service.settle(caller, begun.order.id, { expectedRevision: begun.order.revision });
      const high = await rig.service.dispatch(caller, { taskId: 'task-1' as never, role: 'lead' });
      await rig.service.reject(
        { actor: 'human', sessionId: asSessionId('sess-human'), lead: true },
        high.id,
        { expectedRevision: high.revision },
        '预算过高',
      );

      const diff = compareReplay(
        rig.sink.events.map((event, index) => ({ seq: index + 1, sessionId: rig.sink.sessionId, ...event })),
        rig.domain.table('dispatch_orders').entries(),
        (event) => {
          if (event.family !== 'dispatch/change') return undefined;
          const payload = event.payload as { id?: unknown };
          if (typeof payload.id !== 'string') return undefined; // 策略行（businessId=policy:*）不属本表
          return { key: payload.id, value: event.payload };
        },
      );
      assertReplayEquivalence(diff);
    } finally {
      await rig.dispose();
    }
  });
});
