/**
 * tda-meta-thinking 不变量门（门2 test:invariants）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compositeRecordKey,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  registerTdaInvariants,
} from '@tda/kernel';
import { metaThinkingDomainSpec } from '../src/domain.ts';
import { registerMetaThinkingInvariants } from '../src/loadChecks.ts';
import { createFakeGovernance, sampleDraft, setup } from './helpers.ts';

describe('A. schema 拒载/跳过（backup-and-skip）', () => {
  it('损坏的 meta_paths / rehearsal_runs 行各自被跳过并通知', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-meta-poison-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: metaThinkingDomainSpec.name, version: metaThinkingDomainSpec.version });
      await unit.putRecord(compositeRecordKey('meta_paths', 'mp-1'), { corrupted: true });
      await unit.putRecord(compositeRecordKey('rehearsal_runs', 'reh-1'), { nope: 1 });
      await unit.close();
      const skipped: string[] = [];
      const domain = await openTdaDomain(metaThinkingDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(`${info.table}/${info.key}`),
      });
      expect(skipped.sort()).toEqual(['meta_paths/mp-1', 'rehearsal_runs/reh-1']);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('拓扑带环（seq 边成环）在 schema 层即被拒', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-meta-cycle-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: metaThinkingDomainSpec.name, version: metaThinkingDomainSpec.version });
      await unit.putRecord(
        compositeRecordKey('meta_paths', 'mp-1'),
        sampleDraft().topology &&
          {
            id: 'mp-1',
            topology: {
              nodes: [
                { id: 'a', kind: 'observe' },
                { id: 'b', kind: 'verify' },
              ],
              edges: [
                { from: 'a', to: 'b', kind: 'seq' },
                { from: 'b', to: 'a', kind: 'seq' },
              ],
              entry: 'a',
              exits: ['b'],
            },
            mode: 'convergent',
            applicability: { taskClasses: [], stages: [], problemFeatures: [] },
            stats: { rehearsalPass: 0, rehearsalFail: 0, consecutiveRehearsalFail: 0, realUse: 0 },
            source: { kind: 'human', refs: [] },
            version: 1,
            createdAt: 0,
            updatedAt: 0,
          },
      );
      await unit.close();
      const skipped: string[] = [];
      const domain = await openTdaDomain(metaThinkingDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(`${info.table}/${info.key}`),
      });
      // a→b→a 是 seq 环：schema 恒等律拒载（不变量 1 的第一道闸）
      expect(skipped).toEqual(['meta_paths/mp-1']);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});

describe('B. 加载期检查（含治理互证）', () => {
  it('正常域（真实流程后）两级门全过', async () => {
    const fx = await setup({
      executor: [{ outcome: 'success', tokens: ['read:read', 'random:x', 'edit:write', 'stage:a->b'] }],
    });
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      await fx.service.rehearse({ actor: 'coach', sessionId: 's' }, String(path.id), 'task-1');
      await fx.service.requestConsolidate({ actor: 'coach', sessionId: 's' }, String(path.id));
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, createDualWriteReconciler());
      registerMetaThinkingInvariants(registry, fx.domain, {
        governance: fx.governance,
        service: fx.service,
      });
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });

  it('meta-rehearsal-ref-integrity：指向不存在的元路径即红', async () => {
    const fx = await setup();
    try {
      const registry = createTdaInvariantRegistry();
      registerMetaThinkingInvariants(registry, fx.domain, { governance: fx.governance, service: fx.service });
      await fx.domain.table('rehearsal_runs').put('reh-1', {
        id: 'reh-1',
        metaPathId: 'mp-404',
        taskId: 'task-1',
        childSessionId: 'sess-child',
        boundary: { sessionId: 'sess-meta', eventKind: 'task-boundary', seq: 0 },
        verdict: 'pass',
        coverage: 1,
        outcome: 'success',
        at: 0,
      } as never);
      await expect(registry.verify('tda-meta-thinking')).rejects.toThrowError(/引用完整性/);
    } finally {
      await fx.dispose();
    }
  });

  it('meta-consolidated-has-pass：治理 consolidated 却零 pass 即红（互证）', async () => {
    const fx = await setup();
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      fx.governance.lifecycles.set(String(path.id), 'consolidated'); // 旁路置位
      const registry = createTdaInvariantRegistry();
      registerMetaThinkingInvariants(registry, fx.domain, { governance: fx.governance, service: fx.service });
      await expect(registry.verify('tda-meta-thinking')).rejects.toThrowError(/零 rehearsalPass/);
    } finally {
      await fx.dispose();
    }
  });

  it('meta-consecutive-fail-retired：连续失败达阈值却未退役即红', async () => {
    const fx = await setup();
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      // 本地 stats 达阈值，治理态却仍是 validating
      fx.governance.lifecycles.set(String(path.id), 'validating');
      const row = fx.service.get(String(path.id))!;
      await fx.domain.table('meta_paths').put(String(path.id), {
        ...row,
        stats: { ...row.stats, rehearsalFail: 3, consecutiveRehearsalFail: 3 },
      } as never);
      const registry = createTdaInvariantRegistry();
      registerMetaThinkingInvariants(registry, fx.domain, { governance: fx.governance, service: fx.service });
      await expect(registry.verify('tda-meta-thinking')).rejects.toThrowError(/自动退役未执行/);
    } finally {
      await fx.dispose();
    }
  });

  it('meta-governance-single：治理侧 validating 的 id 在本域不存在即红（分区口径漂移）', async () => {
    const fx = await setup();
    try {
      const rogue = createFakeGovernance({});
      rogue.lifecycles.set('mp-404', 'validating');
      const registry = createTdaInvariantRegistry();
      registerMetaThinkingInvariants(registry, fx.domain, { governance: rogue, service: fx.service });
      await expect(registry.verify('tda-meta-thinking')).rejects.toThrowError(/分区口径漂移/);
    } finally {
      await fx.dispose();
    }
  });

  it('meta-supersede-chain：supersedes 指向不存在的版本即红', async () => {
    const fx = await setup();
    try {
      const path = await fx.service.propose({ actor: 'coach', sessionId: 's' }, sampleDraft());
      const row = fx.service.get(String(path.id))!;
      await fx.domain.table('meta_paths').put(String(path.id), { ...row, supersedes: 'mp-404' } as never);
      const registry = createTdaInvariantRegistry();
      registerMetaThinkingInvariants(registry, fx.domain, { governance: fx.governance, service: fx.service });
      await expect(registry.verify('tda-meta-thinking')).rejects.toThrowError(/版本链断链/);
    } finally {
      await fx.dispose();
    }
  });

  it('检查表条目与规格一一对应（防静默删检查）', async () => {
    const fx = await setup();
    try {
      const { metaThinkingInvariantChecks } = await import('../src/loadChecks.ts');
      const names = metaThinkingInvariantChecks(fx.domain, { governance: fx.governance, service: fx.service }).map(
        (check) => check.name,
      );
      expect(names).toEqual([
        'meta-path-key-canonical',
        'meta-topology-structural',
        'meta-non-language',
        'meta-rehearsal-ref-integrity',
        'meta-consolidated-has-pass',
        'meta-consecutive-fail-retired',
        'meta-governance-single',
        'meta-supersede-chain',
        'meta-hint-token-cap',
      ]);
    } finally {
      await fx.dispose();
    }
  });
});
