/**
 * tda-recall 双写对账门（门3 test:dualwrite）。
 *
 * 本插件的两种写组合是**刻意不同**的，本门就是这条纪律的守门人：
 *  - `recall_params` 变更 → `dualWrite`（域 + 事件，配对窗口）；
 *  - `recall_log` 追加   → `dualWriteDerived`（仅域、无事件，**派生窗**）。
 *
 * replay-equivalence 的口径也随之分账：只有 `recall_params` 参与"日志→域"的重建
 * 比对；`recall_log` 与 T0.7 的 `audit_index` 同族——它的权威在"可重跑复现"
 * （同 log 前缀 + 同 params ⇒ 同日志，由 gate 门的确定性用例证明），
 * 不参与事件重建（否则 count=0 会被判"缺"）。
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
  type TdaSessionSink,
} from '@tda/kernel';
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import { recallDomainSpec, type RecallParams, type RecallTables } from '../src/domain.ts';
import { RECALL_PARAMS_BUSINESS_ID } from '../src/events.ts';
import { createRecallService } from '../src/service.ts';
import { DAY, NOW, createFakeTimeline, createMemorySink, type SequencedLogEvent } from './helpers.ts';

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<RecallTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly bus: ReturnType<typeof createTdaEventBus>;
  readonly published: TdaBusEvent[];
  readonly sink: TdaSessionSink & { readonly events: SequencedLogEvent[] };
  readonly service: ReturnType<typeof createRecallService>;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-recall-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(recallDomainSpec, {
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
  bus.subscribe('recall/change', (event) => {
    published.push(event);
  });
  const sink = createMemorySink();
  const timeline = createFakeTimeline([
    { id: 'tl-1', content: '灯环 方法', chunkType: 'method', relatedTaskId: 'task-1', createdAt: NOW - DAY },
  ]);
  const service = createRecallService({ domain, session: sink, timeline, reconciler, index, bus });
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
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T1.1 双写与审计', () => {
  it('参数变更配对；召回日志走派生窗（不计反向洞）', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ minScore: 0.3 });
      await rig.service.recall({ text: '灯环', at: NOW });

      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.pairedWrites).toBe(2); // 种子 + setParams
      expect(report.unmatchedWrites).toBe(0);
      expect(report.derivedChanges).toBeGreaterThan(0); // 召回日志
      expect(rig.domain.table('recall_log').size()).toBeGreaterThan(0);
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 recall 实体自动延展；业务 id = params', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ minScore: 0.4 });
      const located = rig.index.locate('recall', RECALL_PARAMS_BUSINESS_ID);
      expect(located).toBeDefined();
      expect(located?.entityKind).toBe('recall');
      expect(located?.sessionId).toBe(rig.sink.sessionId);
      // 两条事件（种子 + setParams）→ seqTo 覆盖到后者的 seq
      expect(located?.seqTo).toBeGreaterThan(located?.seqFrom ?? 0);
      // 召回日志**不**进索引（它是派生旁路，无事件 → 无索引项）
      expect(rig.index.entries().every((entry) => entry.entityKind === 'recall')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('总线载荷 = 全快照（含 revision），非增量', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ injectionMaxTokens: 1024 });
      expect(rig.published).toHaveLength(2);
      const last = rig.published.at(-1);
      expect(last?.family).toBe('recall/change');
      expect(last?.businessId).toBe('params');
      expect(last?.payload).toMatchObject({ injectionMaxTokens: 1024, revision: 1 });
      // 全快照：权重/半衰期/θ/minScore 一并到场（消费方可直接替换本地副本）
      expect(Object.keys(last?.payload ?? {}).sort()).toEqual([
        'attention',
        'emotionWeightCap',
        'halfLifeDays',
        'injectionMaxTokens',
        'minScore',
        'modelProducedMinConfidence',
        'momentum',
        'revision',
        'scorerVersion',
        'strategic',
        'weights',
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('replay-equivalence：参数从 recall/change 日志重建 ⇒ 零差异', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ minScore: 0.35 });
      await rig.service.recall({ text: '灯环', at: NOW });

      const diff = compareReplay(
        rig.sink.events,
        rig.domain.table('recall_params').entries(),
        (event) => {
          if (event.family !== 'recall/change') return undefined;
          return { key: 'singleton', value: event.payload };
        },
      );
      expect(() => assertReplayEquivalence(diff)).not.toThrow();

      // 参数行本身与最后一条事件全等（逐字段，键序也一致）
      const current = rig.domain.table('recall_params').get('singleton') as RecallParams;
      expect(JSON.stringify(current)).toBe(JSON.stringify(rig.sink.events.at(-1)?.payload));
    } finally {
      await rig.dispose();
    }
  });

  it('预检失败：非法参数不落域、不产事件、不发布总线', async () => {
    const rig = await setup();
    try {
      const before = rig.sink.events.length;
      const beforeRows = JSON.stringify([...rig.domain.table('recall_params').entries()]);
      await expect(rig.service.setParams({ minScore: 2 })).rejects.toMatchObject({ code: 'RECALL_PARAMS_INVALID' });
      expect(rig.sink.events.length).toBe(before);
      expect(JSON.stringify([...rig.domain.table('recall_params').entries()])).toBe(beforeRows);
      expect(rig.published).toHaveLength(1); // 只有种子那次
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('直写域即漏双写（对账器抓到）', async () => {
    const rig = await setup();
    try {
      const base = rig.domain.table('recall_params').get('singleton')!;
      await rig.domain.table('recall_params').put('singleton', {
        ...base,
        weights: { momentum: 0, emotion: 0, task: 1, recency: 0, semantic: 0 },
        halfLifeDays: { fact: 1, reflection: 1, method: 1, skill: 1 },
        modelProducedMinConfidence: 1,
        minScore: 0,
        injectionMaxTokens: 1,
        revision: 9,
      });
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      // 窗口外的域变更落 unpairedChanges（对账器抓到"没人认领的域写"）
      expect(report.unpairedChanges.length).toBeGreaterThan(0);
      expect(report.unpairedChanges.some((change) => change.table === 'recall_params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('内核门 + 插件门在同一 registry 共存（IT2 聚合器纪律）', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ minScore: 0.3 });
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, rig.reconciler);
      const { registerRecallInvariants } = await import('../src/loadChecks.ts');
      registerRecallInvariants(registry, rig.domain);
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('id 分配无洞：并发调用不产生同号日志', async () => {
    const rig = await setup();
    try {
      await Promise.all([
        rig.service.recall({ text: '灯环', at: NOW }),
        rig.service.recall({ text: '灯环', at: NOW }),
        rig.service.injectCandidates({ sessionId: 's' }, 1),
      ]);
      const ids = [...rig.domain.table('recall_log').keys()].sort();
      expect(ids).toEqual([...new Set(ids)].sort());
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('未装配总线时静默（可选依赖不阻断）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-recall-dw2-'));
    const backend = createJsonBackend(dir);
    try {
      const domain = await openTdaDomain(recallDomainSpec, { backend });
      const sink = createMemorySink('sess-no-bus');
      const service = createRecallService({
        domain,
        session: sink,
        timeline: createFakeTimeline([]),
      });
      await expect(service.initialize()).resolves.toEqual({ seeded: true });
      await expect(service.setParams({ minScore: 0.1 })).resolves.toMatchObject({ minScore: 0.1 });
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('会话 id 归因：日志与事件都带 sessionId（审计可归因）', async () => {
    const rig = await setup();
    try {
      await rig.service.recall({ text: '灯环', at: NOW });
      void asSessionId;
      const rows = rig.service.log();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.sessionId === 'sess-recall')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
