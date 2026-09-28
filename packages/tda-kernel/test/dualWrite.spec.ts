/**
 * 门3 · 双写对账门：状态总线与审计总线的配对契约回归。
 *
 * 覆盖：逐一配对与 seq 有序 / 未登记族拒绝 / audit_index 自动写与延展 /
 *       flush 屏障 / domainWrite 失败则无事件 / 反向洞检测 / rebuild。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  asSessionId,
  BusSubscriberFailedError,
  BUS_WILDCARD,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaInvariantRegistry,
  createTdaEventBus,
  defineTdaDomain,
  dualWrite,
  dualWriteDerived,
  openTdaDomain,
  registerTdaInvariants,
  type DomainChangeRecord,
  type EventFamily,
  type SequencedEvent,
  type TdaDomain,
} from '../src/index.ts';
import { createMemorySink, makeTempDir, removeTempDir } from './helpers.ts';

const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  revision: z.number(),
});

const goalSpec = defineTdaDomain({
  name: 'dualwrite-goals',
  version: 1,
  tables: { goals: GoalSchema },
});

interface DualWriteFixture {
  dir: string;
  backend: ReturnType<typeof createJsonBackend>;
  reconciler: ReturnType<typeof createDualWriteReconciler>;
  index: ReturnType<typeof createAuditIndex>;
  domain: TdaDomain<{ goals: typeof GoalSchema }>;
  sink: ReturnType<typeof createMemorySink>['sink'];
  events: ReturnType<typeof createMemorySink>['events'];
  flushCount: () => number;
}

async function setup(): Promise<DualWriteFixture> {
  const dir = await makeTempDir('tda-kernel-dw-');
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(goalSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      } satisfies DomainChangeRecord),
  });
  const { sink, events, flushCount } = createMemorySink();
  return { dir, backend, reconciler, index, domain, sink, events, flushCount };
}

async function teardown(fixture: DualWriteFixture): Promise<void> {
  await fixture.domain.close();
  await fixture.backend.close();
  await removeTempDir(fixture.dir);
}

describe('dualWrite：配对契约', () => {
  it('每次双写逐一配对，event seq 拥有序且 businessId 稳定', async () => {
    const ctx = await setup();
    try {
      const goals = ctx.domain.table('goals');
      const seq1 = await dualWrite(
        ctx.sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-1',
          payload: { title: '目标一' },
          domainWrite: () => goals.put('goal-1', { id: 'goal-1', title: '目标一', revision: 0 }),
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      const seq2 = await dualWrite(
        ctx.sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-2',
          payload: { title: '目标二' },
          domainWrite: () => goals.put('goal-2', { id: 'goal-2', title: '目标二', revision: 0 }),
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      const seq3 = await dualWrite(
        ctx.sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-2',
          payload: { title: '目标二改' },
          domainWrite: () =>
            goals.update('goal-2', (current) => ({ id: current.id, title: '目标二改', revision: current.revision + 1 })),
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      expect([seq1, seq2, seq3]).toEqual([1, 2, 3]);
      expect(ctx.events.map((event) => event.businessId)).toEqual(['goal-1', 'goal-2', 'goal-2']);
      expect(ctx.events.every((event) => event.family === 'goalTree/change')).toBe(true);
      expect(ctx.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 3,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
      // flush 屏障：每次双写结束都显式 flush
      expect(ctx.flushCount()).toBe(3);
    } finally {
      await teardown(ctx);
    }
  });

  it('未登记族：拒绝双写且不落域、不产生事件', async () => {
    const ctx = await setup();
    try {
      const goals = ctx.domain.table('goals');
      let domainWriteCalled = false;
      await expect(
        dualWrite(
          ctx.sink,
          {
            family: 'unknown/change' as EventFamily,
            businessId: 'goal-1',
            payload: {},
            domainWrite: () => {
              domainWriteCalled = true;
              return goals.put('goal-1', { id: 'goal-1', title: 'x', revision: 0 });
            },
          },
          { reconciler: ctx.reconciler, index: ctx.index },
        ),
      ).rejects.toMatchObject({ code: 'UNKNOWN_EVENT_FAMILY' });
      expect(domainWriteCalled).toBe(false);
      expect(ctx.events).toHaveLength(0);
      expect(ctx.reconciler.reconcile().ok).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });

  it('audit_index 由双写器自动写，同实体延展 seqTo', async () => {
    const ctx = await setup();
    try {
      const goals = ctx.domain.table('goals');
      await dualWrite(
        ctx.sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-1',
          payload: { title: '目标一' },
          domainWrite: () => goals.put('goal-1', { id: 'goal-1', title: '目标一', revision: 0 }),
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      await dualWrite(
        ctx.sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-1',
          payload: { title: '目标一改' },
          domainWrite: () =>
            goals.update('goal-1', (current) => ({ id: current.id, title: '目标一改', revision: current.revision + 1 })),
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      expect(ctx.index.locate('goal', 'goal-1')).toMatchObject({
        entityKind: 'goal',
        entityId: 'goal-1',
        seqFrom: 1,
        seqTo: 2,
      });
      expect(ctx.index.entries()).toHaveLength(1);
    } finally {
      await teardown(ctx);
    }
  });

  it('domainWrite 抛错：整 op 抛、无事件、窗口计失败', async () => {
    const ctx = await setup();
    try {
      await expect(
        dualWrite(
          ctx.sink,
          {
            family: 'goalTree/change',
            businessId: 'goal-1',
            payload: {},
            domainWrite: () => {
              throw new Error('boom');
            },
          },
          { reconciler: ctx.reconciler, index: ctx.index },
        ),
      ).rejects.toThrow('boom');
      expect(ctx.events).toHaveLength(0);
      expect(ctx.reconciler.reconcile()).toMatchObject({ ok: false, failedWindows: 1 });
    } finally {
      await teardown(ctx);
    }
  });

  it('反向洞：窗口内域零变更即 unmatchedWrites', async () => {
    const ctx = await setup();
    try {
      await dualWrite(
        ctx.sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-1',
          payload: {},
          domainWrite: () => {},
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      expect(ctx.reconciler.reconcile()).toMatchObject({ ok: false, unmatchedWrites: 1 });
    } finally {
      await teardown(ctx);
    }
  });

  it('rebuild：由带序号事件重建索引（seqTo 延展到最大）', () => {
    const index = createAuditIndex();
    const events: SequencedEvent[] = [
      { sessionId: asSessionId('s1'), seq: 1, family: 'goalTree/change', businessId: 'goal-1' },
      { sessionId: asSessionId('s1'), seq: 2, family: 'taskPool/change', businessId: 'task-1' },
      { sessionId: asSessionId('s1'), seq: 5, family: 'goalTree/change', businessId: 'goal-1' },
    ];
    index.rebuild(events);
    expect(index.locate('goal', 'goal-1')).toMatchObject({ seqFrom: 1, seqTo: 5 });
    expect(index.locate('task', 'task-1')).toMatchObject({ seqFrom: 2, seqTo: 2 });
    expect(index.entries()).toHaveLength(2);
  });
});

/**
 * 事件总线（IT2 跨插件联动面）。
 *
 * 契约：族白名单同闸 / 按族与通配分发 / 退订即断 / 订阅者错误聚合 fail-loud
 * 且不改动已提交事实 / 提交出口 publish 的事件 seq 与 dualWrite 返回值一致。
 */
describe('内核事件总线', () => {
  it('按族与通配分发，退订后不再收到', async () => {
    const ctx = await setup();
    try {
      const bus = createTdaEventBus();
      const byFamily: string[] = [];
      const wildcard: string[] = [];
      const offFamily = bus.subscribe('taskPool/change', (event) => byFamily.push(event.businessId));
      bus.subscribe(BUS_WILDCARD, (event) => wildcard.push(`${event.family}:${event.businessId}`));
      expect(bus.subscriberCount()).toBe(2);
      expect(bus.subscriberCount('taskPool/change')).toBe(1);

      // 模拟插件提交出口：先 dualWrite（提交），再 publish（已提交事实的通知）
      const seq = await dualWrite(
        ctx.sink,
        {
          family: 'taskPool/change',
          businessId: 'task-1',
          payload: { id: 'task-1' },
          domainWrite: () => ctx.domain.table('goals').put('task-1', { id: 'task-1', title: 'T', revision: 0 }),
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      bus.publish({
        family: 'taskPool/change',
        businessId: 'task-1',
        payload: { id: 'task-1' },
        seq,
        sessionId: ctx.sink.sessionId,
      });
      expect(byFamily).toEqual(['task-1']);
      expect(wildcard).toEqual(['taskPool/change:task-1']);
      // 提交出口的 seq 与事件侧拥有序一致（订阅者据此定位 log）
      expect(seq).toBe(1);

      // 未命中族的订阅者不被唤醒
      bus.publish({
        family: 'goalTree/change',
        businessId: 'goal-1',
        payload: {},
        seq: 2,
        sessionId: ctx.sink.sessionId,
      });
      expect(byFamily).toEqual(['task-1']);
      expect(wildcard).toHaveLength(2);

      offFamily();
      expect(bus.subscriberCount('taskPool/change')).toBe(0);
      bus.publish({
        family: 'taskPool/change',
        businessId: 'task-2',
        payload: {},
        seq: 3,
        sessionId: ctx.sink.sessionId,
      });
      expect(byFamily).toEqual(['task-1']);
    } finally {
      await teardown(ctx);
    }
  });

  it('未登记族 publish 即抛（与双写器同闸，总线不得成为造族旁路）', () => {
    const bus = createTdaEventBus();
    expect(() => bus.subscribe('taskPool/created' as EventFamily, () => {})).toThrow(/未在 EVENT_FAMILIES 登记/);
    expect(() =>
      bus.publish({
        family: 'taskPool/created' as EventFamily,
        businessId: 'x',
        payload: {},
        seq: 1,
        sessionId: asSessionId('s1'),
      }),
    ).toThrow(/未在 EVENT_FAMILIES 登记/);
  });

  it('订阅者抛错：全部订阅者仍被通知，错误聚合向上传播（fail-loud）', async () => {
    const ctx = await setup();
    try {
      const bus = createTdaEventBus();
      const seen: string[] = [];
      bus.subscribe('taskPool/change', () => {
        throw new Error('联动面故障');
      });
      bus.subscribe('taskPool/change', () => seen.push('second'));
      const seq = await dualWrite(
        ctx.sink,
        {
          family: 'taskPool/change',
          businessId: 'task-1',
          payload: {},
          domainWrite: () => ctx.domain.table('goals').put('task-1', { id: 'task-1', title: 'T', revision: 0 }),
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      expect(() =>
        bus.publish({
          family: 'taskPool/change',
          businessId: 'task-1',
          payload: {},
          seq,
          sessionId: ctx.sink.sessionId,
        }),
      ).toThrow(BusSubscriberFailedError);
      // 后位订阅者不受前位失败影响（通知不中断）
      expect(seen).toEqual(['second']);
      // 已提交事实不受订阅者失败影响：域记录与事件都在
      expect(ctx.domain.table('goals').get('task-1')).toBeDefined();
      expect(ctx.events).toHaveLength(1);
      expect(ctx.reconciler.reconcile().ok).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });
});

describe('内核双写 · log-only 事件（域内无对应记录）', () => {
  it('log-only 事件不参与域↔事件配对：不开窗、不误报反向洞，事件与索引照常落', async () => {
    const ctx = await setup();
    try {
      const seq = await dualWrite(
        ctx.sink,
        {
          family: 'context/assemble',
          businessId: 'sess-x:1',
          payload: { round: 1 },
          domainWrite: () => undefined,
          logOnly: true,
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      expect(seq).toBe(1);
      expect(ctx.events).toHaveLength(1);
      expect(ctx.reconciler.reconcile()).toMatchObject({
        ok: true,
        unmatchedWrites: 0,
        pairedWrites: 0,
        failedWindows: 0,
      });
      // 索引照常延展（审计可定位）
      expect(ctx.index.locate('assemble', 'sess-x:1')?.seqFrom).toBe(1);
      // 后续普通双写仍正常配对（log-only 不留残窗）
      await dualWrite(
        ctx.sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-1',
          payload: { id: 'goal-1', title: 'T', revision: 0 },
          domainWrite: () => ctx.domain.table('goals').put('goal-1', { id: 'goal-1', title: 'T', revision: 0 }),
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      expect(ctx.reconciler.reconcile()).toMatchObject({ ok: true, pairedWrites: 1, unmatchedWrites: 0 });
    } finally {
      await teardown(ctx);
    }
  });
});

describe('内核双写 · 派生写（仅域、无事件）', () => {
  it('派生写不参与域↔事件配对：不开权威窗、不误报漏双写，域变更照常落', async () => {
    const ctx = await setup();
    try {
      await dualWriteDerived(
        () => ctx.domain.table('goals').put('derived-1', { id: 'derived-1', title: '索引', revision: 0 }),
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      expect(ctx.domain.table('goals').get('derived-1')).toBeDefined();
      expect(ctx.events).toHaveLength(0); // 派生写不产事件
      expect(ctx.reconciler.reconcile()).toMatchObject({
        ok: true,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
        derivedChanges: 1,
      });
      // 派生窗与权威窗互不串扰：随后普通双写仍严格配对
      await dualWrite(
        ctx.sink,
        {
          family: 'goalTree/change',
          businessId: 'goal-1',
          payload: { id: 'goal-1', title: 'T', revision: 0 },
          domainWrite: () => ctx.domain.table('goals').put('goal-1', { id: 'goal-1', title: 'T', revision: 0 }),
        },
        { reconciler: ctx.reconciler, index: ctx.index },
      );
      expect(ctx.reconciler.reconcile()).toMatchObject({ ok: true, pairedWrites: 1, derivedChanges: 1 });
      // 内核门（@tda/kernel）在混合使用下仍通过
      const registry = createTdaInvariantRegistry();
      const unregister = registerTdaInvariants(registry, ctx.reconciler);
      await expect(registry.verify()).resolves.toBeUndefined();
      unregister();
    } finally {
      await teardown(ctx);
    }
  });

  it('派生窗未开即结束 → 抛（窗口配对纪律对派生窗同样成立）', async () => {
    const ctx = await setup();
    try {
      expect(() => ctx.reconciler.endDerived()).toThrow();
    } finally {
      await teardown(ctx);
    }
  });
});
