/**
 * tda-recall 不变量门（门2 test:invariants）：T1.1 §4.1 七条的加载期可达面。
 *
 * 两段：
 *  A. schema 拒载/跳过——`invalidRecords='backup-and-skip'`（参数可回默认、
 *     日志可重建），损坏记录走 `onInvalidRecord` 通知而不阻断开域；
 *  B. 加载期检查——`recallInvariantChecks` 的每条各造一例违规。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compositeRecordKey,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  registerTdaInvariants,
  type TdaDomain,
  type TdaStorageBackend,
} from '@tda/kernel';
import { asSessionId, createDualWriteReconciler, asEntryId } from '@tda/kernel';
import { DEFAULT_RECALL_PARAMS, recallDomainSpec, type RecallTables } from '../src/domain.ts';
import { recallInvariantChecks, registerRecallInvariants } from '../src/loadChecks.ts';

async function withDomain<T>(
  run: (domain: TdaDomain<RecallTables>, backend: TdaStorageBackend, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-recall-inv-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(recallDomainSpec, { backend });
  try {
    return await run(domain, backend, dir);
  } finally {
    await domain.close();
    await backend.close();
    // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  }
}

/** 直接在域上写记录（绕过服务面，专测加载期检查）。 */
const put = (domain: TdaDomain<RecallTables>, table: 'recall_params' | 'recall_log', key: string, value: unknown): Promise<void> =>
  domain.table(table).put(key, value as never);

const logRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'rl-1',
  entryId: 'tl-1',
  at: 1_790_000_000_000,
  score: 0.5,
  gatePassed: true,
  injected: true,
  kind: 'recall',
  paramsRevision: 0,
  sessionId: 'sess-1',
  ...overrides,
});

describe('A. schema 拒载/跳过（backup-and-skip）', () => {
  it('损坏的 recall_params 行与 recall_log 行各自被跳过并通知', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-recall-poison-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: recallDomainSpec.name, version: recallDomainSpec.version });
      await unit.putRecord(compositeRecordKey('recall_params', 'singleton'), { weights: 'not-an-object' });
      await unit.putRecord(compositeRecordKey('recall_log', 'rl-1'), { corrupted: true });
      await unit.close();

      const skipped: string[] = [];
      const domain = await openTdaDomain(recallDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(`${info.table}/${info.key}`),
      });
      expect(skipped.sort()).toEqual(['recall_log/rl-1', 'recall_params/singleton']);
      // 跳过而非阻断：域仍可用，且参数单行为空（启动序会补种子）
      expect(domain.table('recall_params').size()).toBe(0);
      expect(domain.table('recall_log').size()).toBe(0);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('参数越界（权重和 ≠ 1）在读取侧即被 schema 拒（guard 不依赖服务面）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-recall-poison2-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: recallDomainSpec.name, version: recallDomainSpec.version });
      await unit.putRecord(compositeRecordKey('recall_params', 'singleton'), {
        ...DEFAULT_RECALL_PARAMS,
        revision: 0,
        weights: { task: 0.9, recency: 0.9, semantic: 0.9 },
      });
      await unit.close();
      const skipped: string[] = [];
      const domain = await openTdaDomain(recallDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(info.key),
      });
      expect(skipped).toEqual(['singleton']);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});

describe('B. 加载期检查', () => {
  it('正常域（种子参数 + 合法日志）全过，且内核门同过', async () => {
    await withDomain(async (domain) => {
      await put(domain, 'recall_params', 'singleton', { ...DEFAULT_RECALL_PARAMS });
      await put(domain, 'recall_log', 'rl-1', logRow());
      const registry = createTdaInvariantRegistry();
      registerRecallInvariants(registry, domain);
      registerTdaInvariants(registry, createDualWriteReconciler());
      await expect(registry.verify()).resolves.toBeUndefined();
    });
  });

  it('recall-params-singleton：零行/多行/键不符均红', async () => {
    await withDomain(async (domain) => {
      const registry = createTdaInvariantRegistry();
      registerRecallInvariants(registry, domain);
      await expect(registry.verify('tda-recall')).rejects.toThrowError(/必须恰有一行/);

      await put(domain, 'recall_params', 'singleton', { ...DEFAULT_RECALL_PARAMS });
      await put(domain, 'recall_params', 'other', { ...DEFAULT_RECALL_PARAMS });
      await expect(registry.verify('tda-recall')).rejects.toThrowError(/必须恰有一行/);

      await domain.table('recall_params').delete('other');
      await domain.table('recall_params').delete('singleton');
      await put(domain, 'recall_params', 'wrong-key', { ...DEFAULT_RECALL_PARAMS });
      await expect(registry.verify('tda-recall')).rejects.toThrowError(/行键必须是 singleton/);
    });
  });

  it('recall-log-gate-consistency：gatePassed=false 却 injected/带分/无 reason 均红', async () => {
    await withDomain(async (domain) => {
      await put(domain, 'recall_params', 'singleton', { ...DEFAULT_RECALL_PARAMS });
      const registry = createTdaInvariantRegistry();
      registerRecallInvariants(registry, domain);

      await put(domain, 'recall_log', 'rl-1', logRow({ gatePassed: false, injected: true, score: 0, reason: 'quarantine' }));
      await expect(registry.verify('tda-recall')).rejects.toThrowError(/gatePassed=false 却 injected=true/);
      await domain.table('recall_log').delete('rl-1');

      await put(domain, 'recall_log', 'rl-2', logRow({ gatePassed: false, injected: false, score: 0.3, reason: 'x' }));
      await expect(registry.verify('tda-recall')).rejects.toThrowError(/gatePassed=false 却带分/);
      await domain.table('recall_log').delete('rl-2');

      await put(domain, 'recall_log', 'rl-3', logRow({ gatePassed: false, injected: false, score: 0 }));
      await expect(registry.verify('tda-recall')).rejects.toThrowError(/被拦下却无 reason/);
    });
  });

  it('recall-log-params-revision：日志版本超前当前参数即红（回放解释不成立）', async () => {
    await withDomain(async (domain) => {
      await put(domain, 'recall_params', 'singleton', { ...DEFAULT_RECALL_PARAMS, revision: 1 });
      await put(domain, 'recall_log', 'rl-1', logRow({ paramsRevision: 5 }));
      const registry = createTdaInvariantRegistry();
      registerRecallInvariants(registry, domain);
      await expect(registry.verify('tda-recall')).rejects.toThrowError(/超前当前参数版本/);
    });
  });

  it('recall-log-key-canonical：键与内容 id 不符即红（键即纪律）', async () => {
    await withDomain(async (domain) => {
      await put(domain, 'recall_params', 'singleton', { ...DEFAULT_RECALL_PARAMS });
      await put(domain, 'recall_log', 'rl-7', logRow({ id: 'rl-1' }));
      const registry = createTdaInvariantRegistry();
      registerRecallInvariants(registry, domain);
      await expect(registry.verify('tda-recall')).rejects.toThrowError(/与内容 id rl-1 不符/);
    });
  });

  it('检查表条目与规格一一对应（防静默删检查）', async () => {
    await withDomain(async (domain) => {
      const names = recallInvariantChecks(domain).map((check) => check.name);
      expect(names).toEqual([
        'recall-params-singleton',
        'recall-log-gate-consistency',
        'recall-log-params-revision',
        'recall-log-key-canonical',
      ]);
    });
  });

  it('advisory：日志引用不存在的条目（弱链接）不阻断（无级联）', async () => {
    await withDomain(async (domain) => {
      await put(domain, 'recall_params', 'singleton', { ...DEFAULT_RECALL_PARAMS });
      await put(domain, 'recall_log', 'rl-1', logRow({ entryId: 'tl-404' }));
      const registry = createTdaInvariantRegistry();
      registerRecallInvariants(registry, domain);
      await expect(registry.verify('tda-recall')).resolves.toBeUndefined();
      void asEntryId;
      void asSessionId;
    });
  });
});
