/**
 * tda-predictor 双写对账门（门3 test:dualwrite）。
 *
 * 本插件是唯一同时用到**三种**"域记录 × 事件"组合的插件（内核纪律 #12）：
 *  - `transitions` / `extract_state`  = 派生（`dualWriteDerived`，无事件）；
 *  - `predictions` / `mismatches`     = 权威（`dualWrite` + 族 `predict/change`）；
 *  - `predict_params`                 = 权威（同上，businessId='params'）。
 *
 * 故配对窗口数 = params 种子 + setParams + prediction + mismatch；
 * 派生窗计数只来自 transitions 与水位。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  tdaEvents,
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
} from '@tda/kernel';
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import { predictorDomainSpec, type PredictorTables } from '../src/domain.ts';
import { createPredictorService, type PredictorService } from '../src/service.ts';
import { registerPredictorInvariants } from '../src/loadChecks.ts';
import { BASE_AT, createMemoryHost, createMemorySink, seedFailureHistory, type MemoryHost } from './helpers.ts';

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<PredictorTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly bus: TdaEventBus;
  readonly published: TdaBusEvent[];
  readonly host: MemoryHost;
  readonly service: PredictorService;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-predict-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(predictorDomainSpec, {
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
  bus.subscribe('predict/change', (event) => {
    published.push(event);
  });
  const host = createMemoryHost();
  seedFailureHistory(host, 3);
  const service = createPredictorService({ domain, session: host, reconciler, index, bus, now: () => BASE_AT });
  await service.initialize();
  return {
    dir,
    backend,
    domain,
    reconciler,
    index,
    bus,
    published,
    host,
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

describe('T1.3 双写与审计', () => {
  it('预测与比对配对；transitions 与水位只进派生窗', async () => {
    const rig = await setup();
    try {
      await rig.service.extract(rig.host);
      const prediction = await rig.service.predict({ session: rig.host, round: 3 });
      rig.host.turn(BASE_AT + 100_000);
      rig.host.tool({ turn: 3, tool: 'edit', argClass: 'write', status: 'failure', errorClass: 'timeout' }, BASE_AT + 101_000);
      rig.host.close(3, 'failed', BASE_AT + 102_000);
      await rig.service.observe(String(prediction?.id), rig.host);

      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.pairedWrites).toBe(3); // params 种子 + prediction + mismatch
      expect(report.derivedChanges).toBeGreaterThan(0); // transitions + 水位
      expect(report.unpairedChanges).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 predict 实体延展；transitions 不进索引（无事件）', async () => {
    const rig = await setup();
    try {
      await rig.service.extract(rig.host);
      await rig.service.predict({ session: rig.host, round: 3 });
      expect(rig.index.locate('predict', 'pred-1')?.entityId).toBe('pred-1');
      expect(rig.index.entries().every((entry) => entry.entityKind === 'predict')).toBe(true);
      // transitions 有行、无事件、无索引
      expect(rig.domain.table('transitions').size()).toBeGreaterThan(0);
      expect(rig.published.every((event) => event.businessId.startsWith('pred-') || event.businessId === 'params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('总线载荷 = 全快照（键序与 schema 一致，含裁决时 θ）', async () => {
    const rig = await setup();
    try {
      await rig.service.extract(rig.host);
      await rig.service.predict({ session: rig.host, round: 3 });
      const keys = Object.keys(rig.published.at(-1)?.payload ?? {});
      expect(keys).toEqual([
        'id',
        'sessionId',
        'round',
        'context',
        'nextAction',
        'outcomeDist',
        'riskFlags',
        'confidence',
        'theta',
        'injected',
        'similarTransitionIds',
        'at',
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('replay-equivalence：predictions/mismatches 由 predict/change 日志重建 ⇒ 零差异', async () => {
    const rig = await setup();
    try {
      await rig.service.extract(rig.host);
      const prediction = await rig.service.predict({ session: rig.host, round: 3 });
      rig.host.turn(BASE_AT + 100_000);
      rig.host.tool({ turn: 3, tool: 'edit', argClass: 'write', status: 'failure', errorClass: 'timeout' }, BASE_AT + 101_000);
      rig.host.close(3, 'failed', BASE_AT + 102_000);
      await rig.service.observe(String(prediction?.id), rig.host);

      const events = tdaEvents(rig.host.records())
        .filter((record) => record.family === 'predict/change')
        .map((record) => ({ ...record, sessionId: rig.host.sessionId }));
      const diff = compareReplay(events,
        [
          ...rig.domain.table('predictions').entries(),
          ...rig.domain.table('mismatches').entries(),
        ],
        (record) => (record.businessId === 'params' ? undefined : { key: record.businessId, value: record.payload }),
      );
      expect(() => assertReplayEquivalence(diff)).not.toThrow();
      // 逐条与事件全等
      for (const [, value] of rig.domain.table('predictions').entries()) {
        const event = tdaEvents(rig.host.records()).find((record) => record.businessId === String(value.id));
        expect(canonicalJson(event?.payload)).toBe(canonicalJson(value));
      }
    } finally {
      await rig.dispose();
    }
  });

  it('预检失败：非法参数不落域、不产事件', async () => {
    const rig = await setup();
    try {
      const before = rig.host.records().length;
      const beforeParams = canonicalJson(rig.domain.table('predict_params').get('singleton'));
      await expect(rig.service.setParams({ topK: 0 })).rejects.toMatchObject({ code: 'PREDICT_PARAMS_INVALID' });
      expect(rig.host.records().length).toBe(before);
      expect(canonicalJson(rig.domain.table('predict_params').get('singleton'))).toBe(beforeParams);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('直写域即漏双写（对账器抓到）', async () => {
    const rig = await setup();
    try {
      const row = rig.domain.table('predict_params').get('singleton');
      await rig.domain.table('predict_params').put('singleton', { ...row, revision: 99 } as never);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges.some((change) => change.table === 'predict_params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('内核门 + 插件门共存（同一 registry）', async () => {
    const rig = await setup();
    try {
      await rig.service.extract(rig.host);
      const prediction = await rig.service.predict({ session: rig.host, round: 3 });
      await rig.service.observe(String(prediction?.id), rig.host);
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, rig.reconciler);
      registerPredictorInvariants(registry, rig.domain, { log: rig.host.records() });
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('id 分配无洞：并发（extract ∥ predict）不产生同号记录', async () => {
    const rig = await setup();
    try {
      await Promise.all([
        rig.service.extract(rig.host),
        rig.service.predict({ session: rig.host, round: 3 }),
        rig.service.setParams({ thetaPredict: 0.6 }),
      ]);
      for (const tableName of ['transitions', 'predictions'] as const) {
        const ids = [...rig.domain.table(tableName).keys()].sort();
        expect(ids).toEqual([...new Set(ids)].sort());
      }
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('会话 sink 独立于宿主时仍可用（可选形态）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-predict-dw2-'));
    const backend = createJsonBackend(dir);
    try {
      const domain = await openTdaDomain(predictorDomainSpec, { backend });
      const service = createPredictorService({
        domain,
        session: createMemorySink('sess-separate'),
        now: () => BASE_AT,
      });
      await expect(service.initialize()).resolves.toMatchObject({ lastSeq: 0, batchCap: 200 });
      await expect(service.setParams({ thetaPredict: 0.5 })).resolves.toMatchObject({ revision: 1 });
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
