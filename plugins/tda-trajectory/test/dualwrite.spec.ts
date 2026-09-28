/**
 * tda-trajectory 双写对账门（门3 test:dualwrite）。
 *
 * 覆盖：**索引写是派生写**（仅域、无事件：不产事件、不误报漏双写，`derivedChanges` 计数）/
 *      订阅全族 → 索引（floating promise + drain 可等待）/ 同实体延展 seqTo 幂等 /
 *      `rebuildIndex` 与原件逐字段相同（§4.1-8 索引可重建）/ auditView 过滤 /
 *      内核门与插件门在同一 registry 上同时通过。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  createTdaInvariantRegistry,
  openTdaDomain,
  registerTdaInvariants,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
} from '@tda/kernel';
import { trajectoryDomainSpec, type TrajectoryTables } from '../src/index.ts';
import { createTrajectoryService, subscribeTrajectoryIndex, type TrajectoryService } from '../src/service.ts';
import { registerTrajectoryInvariants } from '../src/loadChecks.ts';
import { createMemoryHost, createSource } from './helpers.ts';

interface Rig {
  readonly service: TrajectoryService;
  readonly domain: TdaDomain<TrajectoryTables>;
  readonly host: ReturnType<typeof createMemoryHost>;
  readonly bus: TdaEventBus;
  readonly reconciler: DualWriteReconciler;
  readonly link: ReturnType<typeof subscribeTrajectoryIndex>;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-traj-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const domain = await openTdaDomain(trajectoryDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  const host = createMemoryHost('sess-traj-dw');
  const bus = createTdaEventBus();
  const sources = [createSource('goal', 'goalTree/change'), createSource('task', 'taskPool/change')];
  const service = createTrajectoryService({ domain, host, sources, bus, reconciler, now: () => 1_700_000_000_000 });
  const link = subscribeTrajectoryIndex({ bus, service });
  return {
    service,
    domain,
    host,
    bus,
    reconciler,
    link,
    async dispose() {
      link.unsubscribe();
      await link.drain();
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

const publish = (bus: TdaEventBus, sessionId: string, family: Parameters<TdaEventBus['publish']>[0]['family'], businessId: string, seq: number, payload: Record<string, unknown>): void => {
  bus.publish({
    family,
    businessId,
    payload: payload as never,
    seq,
    sessionId: asSessionId(sessionId),
  });
};

describe('T0.7 索引写是派生写（仅域、无事件）', () => {
  it('索引不产事件、不误报漏双写，域变化计入 derivedChanges', async () => {
    const rig = await setup();
    try {
      await rig.service.index({ family: 'goalTree/change', businessId: 'goal-1', seq: 1, sessionId: asSessionId('sess-traj-dw') });
      expect(rig.domain.table('audit_index').size()).toBe(1);
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 0,
        unmatchedWrites: 0,
        unpairedChanges: [],
        derivedChanges: 1,
      });
      // 内核门 + 插件门在同一 registry 上一并通过
      const registry = createTdaInvariantRegistry();
      const offKernel = registerTdaInvariants(registry, rig.reconciler);
      // 这里只验"内核门 + 插件门共存"；索引↔日志一致由 gate/invariants 门在带日志的夹具上验
      const offPlugin = registerTrajectoryInvariants(registry, rig.domain);
      await expect(registry.verify()).resolves.toBeUndefined();
      offKernel();
      offPlugin();
    } finally {
      await rig.dispose();
    }
  });

  it('同实体多变更只延展 seqTo（索引体积与实体数同阶），且幂等', async () => {
    const rig = await setup();
    try {
      const session = asSessionId('sess-traj-dw');
      await rig.service.index({ family: 'goalTree/change', businessId: 'goal-1', seq: 1, sessionId: session });
      await rig.service.index({ family: 'goalTree/change', businessId: 'goal-1', seq: 4, sessionId: session });
      // 回放/重扫重放较小 seq：不倒退
      await rig.service.index({ family: 'goalTree/change', businessId: 'goal-1', seq: 2, sessionId: session });
      const located = rig.service.locate('goal', 'goal-1');
      expect(located).toHaveLength(1);
      expect(located[0]).toMatchObject({ seqFrom: 1, seqTo: 4 });
      expect(rig.domain.table('audit_index').size()).toBe(1);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T0.7 全族订阅（已是提交事实的回声）', () => {
  it('总线六族 → 自动入索引；drain 可等待在途写', async () => {
    const rig = await setup();
    try {
      const session = 'sess-traj-dw';
      publish(rig.bus, session, 'goalTree/change', 'goal-1', 1, { id: 'goal-1', revision: 0 });
      publish(rig.bus, session, 'taskPool/change', 'task-1', 2, { id: 'task-1', revision: 0 });
      publish(rig.bus, session, 'timeline/write', 'tl-1', 3, { entryId: 'tl-1' });
      publish(rig.bus, session, 'dispatch/change', 'dispatch-1', 4, { id: 'dispatch-1', revision: 0 });
      publish(rig.bus, session, 'context/assemble', `${session}:1`, 5, { round: 1 });
      publish(rig.bus, session, 'workspace/scan', 'scan-1', 6, { id: 'scan-1' });
      await rig.link.drain();
      expect(rig.service.entries().map((entry) => `${entry.entityKind}:${entry.entityId}`).sort()).toEqual([
        'assemble:sess-traj-dw:1',
        'dispatch:dispatch-1',
        'goal:goal-1',
        'scan:scan-1',
        'task:task-1',
        'timeline:tl-1',
      ]);
      // 退订后不再索引
      rig.link.unsubscribe();
      publish(rig.bus, session, 'goalTree/change', 'goal-2', 7, { id: 'goal-2', revision: 0 });
      await rig.link.drain();
      expect(rig.service.locate('goal', 'goal-2')).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });

  it('rebuildIndex：删表重扫后与原件逐字段相同（索引可重建）', async () => {
    const rig = await setup();
    try {
      const session = asSessionId('sess-traj-dw');
      rig.host.append({ family: 'goalTree/change', businessId: 'goal-1', payload: { id: 'goal-1', revision: 0 } });
      rig.host.append({ family: 'goalTree/change', businessId: 'goal-1', payload: { id: 'goal-1', revision: 1 } });
      rig.host.append({ family: 'taskPool/change', businessId: 'task-1', payload: { id: 'task-1', revision: 0 } });
      rig.host.beginTurn(1);
      rig.host.endTurn(2, 0, 'success');
      await rig.service.rebuildIndex();
      const original = rig.service.entries();
      expect(original).toHaveLength(2);
      expect(rig.service.locate('goal', 'goal-1')[0]).toMatchObject({ seqFrom: 1, seqTo: 2 });
      // 再重扫一次：结果不变（幂等）
      await rig.service.rebuildIndex();
      expect(rig.service.entries()).toEqual(original);
      expect(rig.reconciler.reconcile().ok).toBe(true);
      void session;
    } finally {
      await rig.dispose();
    }
  });
});

describe('T0.7 auditView（§5.5 跨实体审计查询面）', () => {
  it('按实体种类/实体 id/seq 区间过滤，continued 标记后续变更', async () => {
    const rig = await setup();
    try {
      const session = asSessionId('sess-traj-dw');
      await rig.service.index({ family: 'goalTree/change', businessId: 'goal-1', seq: 1, sessionId: session });
      await rig.service.index({ family: 'goalTree/change', businessId: 'goal-1', seq: 9, sessionId: session });
      await rig.service.index({ family: 'taskPool/change', businessId: 'task-1', seq: 5, sessionId: session });
      expect(rig.service.auditView({ entityKind: 'goal' })).toHaveLength(1);
      expect(rig.service.auditView({ entityId: 'task-1' })[0]?.seqFrom).toBe(5);
      expect(rig.service.auditView({ seqFrom: 6 }).map((entry) => entry.entityId)).toEqual(['goal-1']);
      expect(rig.service.auditView({ entityKind: 'goal' })[0]?.continued).toBe(true);
      expect(rig.service.auditView({ entityKind: 'task' })[0]?.continued).toBe(false);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T0.7 日志摄入（权威路径：总线不是审计面）', () => {
  it('goal-state 类"只写日志不发布总线"的族也能被索引（实测缺陷回归）', async () => {
    const rig = await setup();
    try {
      // 只往日志写（不 publish 总线）——模拟 goal-state / timeline 的真实行为
      rig.host.append({ family: 'goalTree/change', businessId: 'goal-x', payload: { id: 'goal-x', revision: 0 } });
      rig.host.append({ family: 'timeline/write', businessId: 'tl-9', payload: { entryId: 'tl-9' } });
      await rig.link.drain(); // drain 先摄入日志，再等总线快速路径
      expect(rig.service.locate('goal', 'goal-x')).toHaveLength(1);
      expect(rig.service.locate('timeline', 'tl-9')).toHaveLength(1);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('摄入是增量的：重复 drain 不重复延展，新增事件被补上', async () => {
    const rig = await setup();
    try {
      rig.host.append({ family: 'goalTree/change', businessId: 'goal-y', payload: { id: 'goal-y', revision: 0 } });
      expect(await rig.service.ingest()).toBeGreaterThan(0);
      expect(await rig.service.ingest()).toBe(0); // 无新增 → 零工作
      rig.host.append({ family: 'goalTree/change', businessId: 'goal-y', payload: { id: 'goal-y', revision: 2 } });
      expect(await rig.service.ingest()).toBeGreaterThan(0);
      expect(rig.service.locate('goal', 'goal-y')[0]).toMatchObject({ seqFrom: 1, seqTo: 2 });
    } finally {
      await rig.dispose();
    }
  });

  it('同一实体的事件突发：索引只留一条条目（写串行化，实测竞态回归）', async () => {
    const rig = await setup();
    try {
      const session = asSessionId('sess-traj-dw');
      // fire-and-forget 并发入队（record 的真实形态）
      for (const seq of [1, 2, 3, 4]) {
        rig.service.record({ family: 'goalTree/change', businessId: 'goal-burst', seq, sessionId: session });
      }
      await rig.service.drain();
      const located = rig.service.locate('goal', 'goal-burst');
      expect(located).toHaveLength(1);
      expect(located[0]).toMatchObject({ seqFrom: 1, seqTo: 4 });
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
