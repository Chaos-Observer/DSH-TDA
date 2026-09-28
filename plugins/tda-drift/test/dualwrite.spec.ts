/**
 * tda-drift 双写对账门（门3 test:dualwrite）。
 *
 * 写组合：`drift_params` = 权威（`dualWrite` + 族 `drift/calibrate`，businessId='params'）；
 * `drift_scores` = 派生（`dualWriteDerived`，无事件——纯函数可重算）。
 * 校准记录的权威与事件都在 goal-state 侧（`recordCalibration` seam），由 goal-state 门验证；
 * 本门验证 drift 自身两种组合的配对与回放口径。
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
} from '@tda/kernel';
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import { driftDomainSpec, DRIFT_PARAMS_BUSINESS_ID, type DriftTables } from '../src/domain.ts';
import { createDriftService, type DriftService } from '../src/service.ts';
import { registerDriftInvariants } from '../src/loadChecks.ts';
import { DAY, NOW, createFakeGoals, createFakeTasks, createFakeTransitions, type FakeGoalState } from './helpers.ts';

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<DriftTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly published: TdaBusEvent[];
  readonly goals: FakeGoalState;
  readonly service: DriftService;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-drift-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(driftDomainSpec, {
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
  bus.subscribe('drift/calibrate', (event) => {
    published.push(event);
  });
  const goals = createFakeGoals([{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing' }]);
  const service = createDriftService({
    domain,
    session: {
      sessionId: 'sess-drift' as never,
      append: () => 1,
      flush: () => undefined,
    } as never,
    goal: goals.seam,
    task: createFakeTasks([]),
    predictor: createFakeTransitions([]),
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
    published,
    goals,
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

describe('T1.5 双写与审计', () => {
  it('参数变更配对；快照走派生窗（不计反向洞）', async () => {
    const rig = await setup();
    try {
      await rig.service.evaluate('goal-1');
      await rig.service.setParams({ perMetricThreshold: 0.5 });
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.pairedWrites).toBe(2); // params 种子 + setParams
      expect(report.derivedChanges).toBeGreaterThan(0); // drift_scores
      expect(rig.domain.table('drift_scores').size()).toBe(1);
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 drift 实体延展；快照不进索引（无事件）', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ perMetricThreshold: 0.5 });
      expect(rig.index.locate('drift', DRIFT_PARAMS_BUSINESS_ID)?.entityId).toBe('params');
      expect(rig.index.entries().every((entry) => entry.entityKind === 'drift')).toBe(true);
      expect(rig.published.every((event) => event.businessId === 'params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('总线载荷 = 全快照（键序与 schema 定义序一致）', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ hysteresisWindows: 3 });
      const keys = Object.keys(rig.published.at(-1)?.payload ?? {});
      expect(keys).toEqual([
        'weights',
        'windowMs',
        'baselineWindows',
        'thresholds',
        'perMetricThreshold',
        'hysteresisWindows',
        'revision',
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('replay-equivalence：参数从 drift/calibrate 日志重建 ⇒ 零差异', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ windowMs: 2 * DAY });
      const events = rig.published.map((event) => ({ ...event, at: NOW }));
      const diff = compareReplay(
        events,
        rig.domain.table('drift_params').entries(),
        (event) => (event.businessId === 'params' ? { key: 'singleton', value: event.payload } : undefined),
      );
      expect(() => assertReplayEquivalence(diff)).not.toThrow();
    } finally {
      await rig.dispose();
    }
  });

  it('预检失败：非法参数不落域、不产事件', async () => {
    const rig = await setup();
    try {
      const before = rig.published.length;
      const beforeParams = canonicalJson(rig.domain.table('drift_params').get('singleton'));
      await expect(rig.service.setParams({ windowMs: 0 })).rejects.toMatchObject({ code: 'DRIFT_PARAMS_INVALID' });
      expect(rig.published.length).toBe(before);
      expect(canonicalJson(rig.domain.table('drift_params').get('singleton'))).toBe(beforeParams);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('直写域即漏双写（对账器抓到）', async () => {
    const rig = await setup();
    try {
      const row = rig.domain.table('drift_params').get('singleton');
      await rig.domain.table('drift_params').put('singleton', { ...row, revision: 42 } as never);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges.some((change) => change.table === 'drift_params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('内核门 + 插件门共存（同一 registry）', async () => {
    const rig = await setup();
    try {
      await rig.service.evaluate('goal-1');
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, rig.reconciler);
      registerDriftInvariants(registry, rig.domain, { goal: rig.goals.seam, service: rig.service });
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('id 分配无洞：并发（evaluate ∥ setParams）不产生同号快照', async () => {
    const rig = await setup();
    try {
      await Promise.all([
        rig.service.evaluate('goal-1'),
        rig.service.evaluate('goal-1'),
        rig.service.setParams({ perMetricThreshold: 0.55 }),
      ]);
      const ids = [...rig.domain.table('drift_scores').keys()].sort();
      expect(ids).toEqual([...new Set(ids)].sort());
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
