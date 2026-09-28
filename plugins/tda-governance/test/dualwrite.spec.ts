/**
 * tda-governance 双写对账门（门3 test:dualwrite）。
 *
 * 三种写、三种组合（内核纪律 #12）：
 *  - `gov_actions`  = 权威（`dualWrite` + 族 `memoryGov/change`，businessId=`gov-<n>`）；
 *  - `memory_gov_states` / `gov_scan_state` = 投影与水位（`dualWriteDerived`，仅域无事件）。
 *
 * 因此本门的核心断言是：**配对窗口数 = 动作数**，投影变化只进 `derivedChanges`，
 * 且 replay-equivalence 只对 `gov_actions` 做（投影的权威在动作日志，正是被重放出来的东西）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
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
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import { governanceDomainSpec, type GovAction, type GovTables } from '../src/domain.ts';
import { createGovernanceService, type GovernanceService } from '../src/service.ts';
import { registerGovernanceInvariants } from '../src/loadChecks.ts';
import { CALLER, HUMAN, NOW, createFakeRecall, createFakeTasks, createFakeTimeline, createMemorySink, type SequencedLogEvent } from './helpers.ts';

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<GovTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly bus: TdaEventBus;
  readonly published: TdaBusEvent[];
  readonly sink: TdaSessionSink & { readonly events: SequencedLogEvent[] };
  readonly service: GovernanceService;
  readonly timeline: ReturnType<typeof createFakeTimeline>;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-gov-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(governanceDomainSpec, {
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
  const published: TdaBusEvent[] = [];
  bus.subscribe('memoryGov/change', (event) => {
    published.push(event);
  });
  const sink = createMemorySink();
  const timeline = createFakeTimeline([
    { id: 'tl-1', content: '候选记忆', credential: 'execution-verified', chunkType: 'method', relatedTaskId: 'task-1', createdAt: NOW },
  ]);
  const service = createGovernanceService({
    domain,
    session: sink,
    timeline,
    recall: createFakeRecall([{ entryId: 'tl-1', at: NOW, injected: true, kind: 'inject', taskId: 'task-1' }]),
    task: createFakeTasks([{ id: 'task-1', outcome: 'success' }]),
    reconciler,
    index,
    bus,
    now: () => NOW,
  });
  await service.initialize();
  return {
    dir,
    backend,
    domain,
    reconciler,
    index,
    bus,
    published,
    sink,
    service,
    timeline,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

const evidence = { taskId: 'task-1', runIndex: 1, taskOutcome: 'success' as const, injectedAt: NOW, checkedAt: NOW };

describe('T1.2 双写与审计', () => {
  it('每条动作配对一次；投影与水位只进派生窗', async () => {
    const rig = await setup();
    try {
      await rig.service.promote(CALLER, 'tl-1', evidence);
      await rig.service.consolidate(CALLER, 'tl-1');
      await rig.service.retire(HUMAN, 'tl-1', { kind: 'manual', detail: 'x' });
      await rig.service.scan(CALLER);

      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.pairedWrites).toBe(3); // promote / consolidate / retire
      expect(report.unmatchedWrites).toBe(0);
      expect(report.unpairedChanges).toEqual([]);
      expect(report.derivedChanges).toBeGreaterThan(0); // 状态投影 + 水位
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 gov 实体延展，seqTo 覆盖到最新动作', async () => {
    const rig = await setup();
    try {
      await rig.service.promote(CALLER, 'tl-1', evidence);
      await rig.service.consolidate(CALLER, 'tl-1');
      const located = rig.index.locate('gov', 'gov-1');
      expect(located?.seqFrom).toBe(1);
      expect(located?.seqTo).toBe(1);
      expect(rig.index.locate('gov', 'gov-2')?.entityId).toBe('gov-2');
      expect(rig.index.entries().every((entry) => entry.entityKind === 'gov')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('总线载荷 = 全快照（逐字段，键序与 schema 一致）', async () => {
    const rig = await setup();
    try {
      await rig.service.promote(CALLER, 'tl-1', evidence);
      const event = rig.published.at(-1);
      expect(event?.family).toBe('memoryGov/change');
      expect(event?.businessId).toBe('gov-1');
      expect(Object.keys(event?.payload ?? {})).toEqual([
        'id',
        'assetKind',
        'assetId',
        'action',
        'from',
        'to',
        'reason',
        'evidence',
        'actor',
        'at',
      ]);
      expect(event?.payload).toMatchObject({ action: 'promote', from: 'draft', to: 'validating' });
    } finally {
      await rig.dispose();
    }
  });

  it('replay-equivalence：gov_actions 从 memoryGov/change 日志重建 ⇒ 零差异', async () => {
    const rig = await setup();
    try {
      await rig.service.promote(CALLER, 'tl-1', evidence);
      await rig.service.consolidate(CALLER, 'tl-1');
      await rig.service.scan(CALLER);

      const diff = compareReplay(
        rig.sink.events,
        rig.domain.table('gov_actions').entries(),
        (event) => {
          if (event.family !== 'memoryGov/change') return undefined;
          return { key: event.businessId, value: event.payload };
        },
      );
      expect(() => assertReplayEquivalence(diff)).not.toThrow();

      // 逐条动作与事件载荷全等（键序也一致）
      for (const [, action] of rig.domain.table('gov_actions').entries()) {
        const event = rig.sink.events.find((row) => row.businessId === String(action.id));
        expect(canonicalJson(event?.payload)).toBe(canonicalJson(action));
      }
    } finally {
      await rig.dispose();
    }
  });

  it('预检失败：不落域、不产事件、不发布总线（且域逐字节不变）', async () => {
    const rig = await setup();
    try {
      await rig.service.promote(CALLER, 'tl-1', evidence);
      const beforeEvents = rig.sink.events.length;
      const beforeActions = [...rig.domain.table('gov_actions').entries()].map(([key, value]) => `${key}:${canonicalJson(value)}`);
      const beforeStates = [...rig.domain.table('memory_gov_states').entries()].map(([key, value]) => `${key}:${canonicalJson(value)}`);

      await expect(rig.service.restore(HUMAN, 'tl-1')).rejects.toMatchObject({ code: 'GOV_NOT_RETIRED' });
      await expect(rig.service.promote(CALLER, 'tl-1', { ...evidence, taskId: 'task-404' })).rejects.toMatchObject({
        code: 'GOV_EVIDENCE_TASK_NOT_FOUND',
      });

      expect(rig.sink.events.length).toBe(beforeEvents);
      expect([...rig.domain.table('gov_actions').entries()].map(([key, value]) => `${key}:${canonicalJson(value)}`)).toEqual(beforeActions);
      expect([...rig.domain.table('memory_gov_states').entries()].map(([key, value]) => `${key}:${canonicalJson(value)}`)).toEqual(beforeStates);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('直写域即漏双写（对账器抓到）', async () => {
    const rig = await setup();
    try {
      const rogue: GovAction = {
        id: 'gov-77' as never,
        assetKind: 'memory',
        assetId: 'tl-1',
        action: 'consolidate',
        from: 'validating',
        to: 'consolidated',
        actor: { sessionId: 'sess-x', actor: 'agent', at: NOW },
        at: NOW,
      };
      await rig.domain.table('gov_actions').put('gov-77', rogue);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges.some((change) => change.table === 'gov_actions')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('内核门 + 插件门共存（同一 registry）', async () => {
    const rig = await setup();
    try {
      await rig.service.promote(CALLER, 'tl-1', evidence);
      await rig.service.consolidate(CALLER, 'tl-1');
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, rig.reconciler);
      registerGovernanceInvariants(registry, rig.domain, { service: rig.service, timeline: rig.timeline });
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('id 分配无洞：并发（scan ∥ retire）不产生同号动作', async () => {
    const rig = await setup();
    try {
      await Promise.all([
        rig.service.scan(CALLER),
        rig.service.retire(CALLER, 'tl-1', { kind: 'manual', detail: 'x' }),
        rig.service.proposeInvalidate(CALLER, 'tl-1', 'y'),
      ]);
      const ids = [...rig.domain.table('gov_actions').keys()].sort();
      expect(ids).toEqual([...new Set(ids)].sort());
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('未装配总线/recall/task 时降级不崩（可选依赖）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-gov-dw2-'));
    const backend = createJsonBackend(dir);
    try {
      const domain = await openTdaDomain(governanceDomainSpec, { backend });
      const service = createGovernanceService({
        domain,
        session: createMemorySink('sess-bare'),
        timeline: createFakeTimeline([{ id: 'tl-1', content: 'x', credential: 'execution-verified', createdAt: NOW }]),
        now: () => NOW,
      });
      await expect(service.initialize()).resolves.toMatchObject({ cursor: '' });
      // 无 task 面时证据校验 fail-loud（不静默放行）
      await expect(
        service.promote(CALLER, 'tl-1', evidence),
      ).rejects.toMatchObject({ code: 'GOV_EVIDENCE_TASK_NOT_FOUND' });
      // 无 recall 面时容量与 unused-days 退化为"零复用"但仍可评估
      expect(service.capacity().activeEntries).toBe(1);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('重启后投影与水位从域恢复（reopen 后状态一致）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-gov-reopen-'));
    const backend = createJsonBackend(dir);
    try {
      const domainA = await openTdaDomain(governanceDomainSpec, { backend });
      const serviceA = createGovernanceService({
        domain: domainA,
        session: createMemorySink('s1'),
        timeline: createFakeTimeline([{ id: 'tl-1', content: 'x', credential: 'execution-verified', chunkType: 'method', createdAt: NOW }]),
        recall: createFakeRecall([{ entryId: 'tl-1', at: NOW, injected: true, kind: 'inject', taskId: 'task-1' }]),
        task: createFakeTasks([{ id: 'task-1', outcome: 'success' }]),
        now: () => NOW,
      });
      await serviceA.initialize();
      await serviceA.promote(CALLER, 'tl-1', evidence);
      await serviceA.scan(CALLER);
      const snapshot = [...domainA.table('memory_gov_states').entries()].map(([key, value]) => `${key}:${canonicalJson(value)}`);
      const cursor = serviceA.scanState().cursor;
      await domainA.close();

      const domainB = await openTdaDomain(governanceDomainSpec, { backend });
      const serviceB = createGovernanceService({
        domain: domainB,
        session: createMemorySink('s2'),
        timeline: createFakeTimeline([{ id: 'tl-1', content: 'x', credential: 'execution-verified', chunkType: 'method', createdAt: NOW }]),
        recall: createFakeRecall([{ entryId: 'tl-1', at: NOW, injected: true, kind: 'inject', taskId: 'task-1' }]),
        task: createFakeTasks([{ id: 'task-1', outcome: 'success' }]),
        now: () => NOW,
      });
      const boot = await serviceB.initialize();
      expect(boot.cursor).toBe(cursor);
      expect([...domainB.table('memory_gov_states').entries()].map(([key, value]) => `${key}:${canonicalJson(value)}`)).toEqual(snapshot);
      expect(serviceB.lifecycleOf('tl-1')).toBe('validating');
      await domainB.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
