/**
 * tda-meta-thinking 双写对账门（门3 test:dualwrite）。
 *
 * 本插件**没有派生表**：meta_paths 与 rehearsal_runs 都走 `dualWrite`
 * （族 `metaPath/change`，businessId = `mp-<n>` / `reh-<n>`）——stats 的更新
 * 依赖治理侧的裁决时序，事件流是唯一可回放的裁决记录。因此：
 * 配对窗口数 = 提案数 + rehearsal 数 + stats 刷新数，`derivedChanges` 恒 0。
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
} from '@tda/kernel';
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import { metaThinkingDomainSpec, type MetaThinkingTables } from '../src/domain.ts';
import { createMetaThinkingService, type MetaThinkingService } from '../src/service.ts';
import { registerMetaThinkingInvariants } from '../src/loadChecks.ts';
import { createFakeGovernance, createFakeExecutor, sampleDraft, createMemorySink, type FakeExecutor, type FakeGovernance } from './helpers.ts';

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<MetaThinkingTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly bus: TdaEventBus;
  readonly published: TdaBusEvent[];
  readonly governance: FakeGovernance;
  readonly executor: FakeExecutor;
  readonly service: MetaThinkingService;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-meta-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(metaThinkingDomainSpec, {
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
  bus.subscribe('metaPath/change', (event) => {
    published.push(event);
  });
  const governance = createFakeGovernance({});
  const executor = createFakeExecutor([
    { outcome: 'success', tokens: ['read:read', 'random:x', 'edit:write', 'stage:a->b'] },
  ]);
  const service = createMetaThinkingService({
    domain,
    session: createMemorySink(),
    governance,
    executor,
    reconciler,
    index,
    bus,
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
    governance,
    executor,
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

describe('T1.4 双写与审计', () => {
  it('提案 / rehearsal / stats 刷新逐窗配对（无派生窗）', async () => {
    const rig = await setup();
    try {
      const path = await rig.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      await rig.service.rehearse({ actor: 'coach', sessionId: 's' }, String(path.id), 'task-1');
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      // propose(1) + rehearse 的 run(1) + stats 刷新(1)
      expect(report.pairedWrites).toBe(3);
      expect(report.derivedChanges).toBe(0);
      expect(report.unpairedChanges).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 metaPath 实体延展', async () => {
    const rig = await setup();
    try {
      const path = await rig.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      expect(rig.index.locate('metaPath', String(path.id))?.entityKind).toBe('metaPath');
      expect(rig.index.entries().every((entry) => entry.entityKind === 'metaPath')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('总线载荷 = 全快照（键序与 schema 定义序一致）', async () => {
    const rig = await setup();
    try {
      await rig.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      const keys = Object.keys(rig.published.at(-1)?.payload ?? {});
      expect(keys).toEqual([
        'id',
        'topology',
        'mode',
        'applicability',
        'stats',
        'source',
        'version',
        'createdAt',
        'updatedAt',
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('replay-equivalence：meta_paths / rehearsal_runs 由 metaPath/change 日志重建 ⇒ 零差异', async () => {
    const rig = await setup();
    try {
      const path = await rig.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      await rig.service.rehearse({ actor: 'coach', sessionId: 's' }, String(path.id), 'task-1');
      const events = rig.published.map((event) => ({ ...event, kind: 'tda' as const, at: 0 }));
      const diff = compareReplay(
        events,
        [...rig.domain.table('meta_paths').entries(), ...rig.domain.table('rehearsal_runs').entries()],
        (record) => ({ key: record.businessId, value: record.payload }),
      );
      expect(() => assertReplayEquivalence(diff)).not.toThrow();
      // 逐条与事件全等
      for (const [, value] of rig.domain.table('meta_paths').entries()) {
        // 同一实体可能有多条事件（提案 → stats 刷新）：取**最后**一条（全快照流，最后者为准）
        const event = events.filter((record) => record.businessId === String(value.id)).at(-1);
        expect(canonicalJson(event?.payload)).toBe(canonicalJson(value));
      }
    } finally {
      await rig.dispose();
    }
  });

  it('直写域即漏双写（对账器抓到）', async () => {
    const rig = await setup();
    try {
      const path = await rig.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      const row = rig.service.get(String(path.id))!;
      await rig.domain.table('meta_paths').put(String(path.id), { ...row, version: 99 } as never);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges.some((change) => change.table === 'meta_paths')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('内核门 + 插件门共存（同一 registry）', async () => {
    const rig = await setup();
    try {
      const path = await rig.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      await rig.service.rehearse({ actor: 'coach', sessionId: 's' }, String(path.id), 'task-1');
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, rig.reconciler);
      registerMetaThinkingInvariants(registry, rig.domain, {
        governance: rig.governance,
        service: rig.service,
      });
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('id 分配无洞：并发（propose ∥ propose）不产生同号', async () => {
    const rig = await setup();
    try {
      await Promise.all([
        rig.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft()),
        rig.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft()),
        rig.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft()),
      ]);
      const ids = [...rig.domain.table('meta_paths').keys()].sort();
      expect(ids).toEqual(['mp-1', 'mp-2', 'mp-3']);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
