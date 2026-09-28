/**
 * tda-maintenance 不变量门 + 双写对账门（门2+门3 合并，覆盖面完整即可）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
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
} from '@tda/kernel';
import { maintenanceDomainSpec, type MaintenanceTables } from '../src/domain.ts';
import { createMaintenanceService, type MaintenanceService } from '../src/service.ts';
import { registerMaintenanceInvariants, maintenanceInvariantChecks } from '../src/loadChecks.ts';
import { NOW, assetRow, createMemorySink } from './helpers.ts';

interface Rig {
  readonly domain: TdaDomain<MaintenanceTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly published: TdaBusEvent[];
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly service: MaintenanceService;
  readonly dir: string;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-maint-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(maintenanceDomainSpec, {
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
  bus.subscribe('maintenance/change', (event) => {
    published.push(event);
  });
  const service = createMaintenanceService({
    domain,
    session: createMemorySink(),
    signals: { assets: () => [] },
    governance: {
      async consolidate() {
        return {};
      },
      async retire() {
        return {};
      },
      async restore() {
        return {};
      },
      async proposeInvalidate() {
        return {};
      },
      lifecycleOf: () => undefined,
      actions: () => [],
    },
    bus,
    reconciler,
    index,
    now: () => NOW,
  });
  await service.initialize();
  return {
    domain,
    reconciler,
    index,
    published,
    sink: service as never as ReturnType<typeof createMemorySink>,
    service,
    dir,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T2.3 不变量门', () => {
  it('maintenance-params-singleton：缺行红（initialize 未跑）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-maint-inv-'));
    const backend = createJsonBackend(dir);
    const domain = await openTdaDomain(maintenanceDomainSpec, { backend });
    try {
      const registry = createTdaInvariantRegistry();
      const unregister = registerMaintenanceInvariants(registry, domain, {});
      await expect(registry.verify('tda-maintenance')).rejects.toThrowError(/必须恰有一行/);
      unregister();
    } finally {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('maintenance-retire-reason-whitelist：检查项在清单（防静默删检查）', async () => {
    const rig = await setup();
    try {
      const names = maintenanceInvariantChecks(rig.domain, { service: rig.service }).map((check) => check.name);
      expect(names).toEqual([
        'maintenance-params-singleton',
        'maintenance-retire-reason-whitelist',
        'maintenance-service-no-direct-write',
      ]);
      const registry = createTdaInvariantRegistry();
      const unregister = registerMaintenanceInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-maintenance')).resolves.toBeUndefined();
      unregister();
    } finally {
      await rig.dispose();
    }
  });
});

describe('T2.3 双写与审计', () => {
  it('提议/动作/报告全配对；audit_index 记 maintenance 实体', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-maint-dw2-'));
    const backend = createJsonBackend(dir);
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(maintenanceDomainSpec, {
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
    bus.subscribe('maintenance/change', (event) => {
      published.push(event);
    });
    const governanceCalls: { id: string; assetId: string; action: string }[] = [];
    let govSeq = 0;
    const lifecycles = new Map<string, string>();
    const service = createMaintenanceService({
      domain,
      session: createMemorySink(),
      signals: {
        assets: () => [assetRow({ assetId: 'tl-1', lifecycle: 'validating', reuseCount: 3, verifyCount: 2, taskIds: ['t1', 't2', 't3'] })],
      },
      governance: {
        async consolidate(_actor, assetId) {
          govSeq += 1;
          governanceCalls.push({ id: `gov-${govSeq}`, assetId, action: 'consolidate' });
          lifecycles.set(assetId, 'consolidated');
          return { id: `gov-${govSeq}` };
        },
        async retire() {
          return {};
        },
        async restore() {
          return {};
        },
        async proposeInvalidate() {
          return {};
        },
        lifecycleOf: (assetId) => lifecycles.get(assetId),
        actions: (assetId) =>
          assetId !== undefined ? governanceCalls.filter((action) => action.assetId === assetId) : [...governanceCalls],
      },
      bus,
      reconciler,
      index,
      now: () => NOW,
    });
    try {
      await service.initialize();
      await service.cycle({ kind: 'manual' });
      const report = reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(published.every((event) => event.family === 'maintenance/change')).toBe(true);
      const executed = service.proposals({ status: 'executed' })[0]!;
      const located = index.locate('maintenance', `maintenance-proposal:${String(executed.id)}`);
      expect(located?.entityId).toBe(`maintenance-proposal:${String(executed.id)}`);
      expect(executed.govActionId).toBe('gov-1');
    } finally {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('直写域即漏双写（对账器抓到）', async () => {
    const rig = await setup();
    try {
      const row = rig.domain.table('maintenance_params').get('singleton');
      await rig.domain.table('maintenance_params').put('singleton', { ...row, revision: 42 } as never);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges.some((change) => change.table === 'maintenance_params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
