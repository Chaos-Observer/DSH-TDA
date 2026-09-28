/**
 * tda-context 不变量门（门2 test:invariants）。
 *
 * 分层验证（§4.1 七条的落点）：
 *  - **静态结构**：剥夺序不得含 pinned/system（C6 豁免绝对化的结构保证）；
 *  - **schema 恒等律**（invalidRecords=reject）→ 打开即拒：kind/sourceKind 错配、
 *    maxTokens<1、sourceRef 空；
 *  - **加载期检查**：钉扎记录键 == 内容 id、四区配比合法且 pinned 区为正。
 *  - **gate 分层**：无样本/全哨兵自动降级 static（机制不失效）——以纯函数单测覆盖。
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
  type TdaDomain,
} from '@tda/kernel';
import { contextDomainSpec, type ContextTables } from '../src/index.ts';
import { registerContextInvariants } from '../src/loadChecks.ts';
import { runGate, selectDrops, type ScorableSegment } from '../src/gate.ts';

const pin = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pin-1',
  revision: 0,
  kind: 'goal',
  sourceKind: 'goalTree.focus',
  sourceRef: 'focus',
  maxTokens: 128,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

async function withDomain<T>(
  seed: (domain: TdaDomain<ContextTables>) => Promise<void>,
  body: (domain: TdaDomain<ContextTables>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-ctx-inv-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(contextDomainSpec, { backend });
  try {
    await seed(domain);
    return await body(domain);
  } finally {
    await domain.close();
    await backend.close();
    // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  }
}

describe('T0.4 加载期检查', () => {
  it('合法域全部通过（含剥夺序静态检查）', async () => {
    await withDomain(
      async (domain) => {
        await domain.table('context_pins').put('pin-1', pin() as never);
      },
      async (domain) => {
        const registry = createTdaInvariantRegistry();
        registerContextInvariants(registry, domain);
        await expect(registry.verify()).resolves.toBeUndefined();
      },
    );
  });

  it('钉扎记录键与内容 id 不符被拒（键即纪律：不在键上的项永不生效）', async () => {
    await withDomain(
      async (domain) => {
        await domain.table('context_pins').put('pin-1', pin({ id: 'pin-elsewhere' }) as never);
      },
      async (domain) => {
        const registry = createTdaInvariantRegistry();
        registerContextInvariants(registry, domain);
        await expect(registry.verify()).rejects.toThrow(/与内容 id/);
      },
    );
  });

  it('四区配比非法（和不为 1 / pinned 为零）被拒', async () => {
    await withDomain(
      async () => undefined,
      async (domain) => {
        const registry = createTdaInvariantRegistry();
        registerContextInvariants(registry, domain, {
          allocation: { pinnedPct: 0.5, memoPct: 0.5, historyPct: 0.5, injectionPct: 0.5 },
        });
        await expect(registry.verify()).rejects.toThrow(/四区配比非法/);

        const registry2 = createTdaInvariantRegistry();
        registerContextInvariants(registry2, domain, {
          allocation: { pinnedPct: 0, memoPct: 0.2, historyPct: 0.6, injectionPct: 0.2 },
        });
        await expect(registry2.verify()).rejects.toThrow(/pinned 区配比必须为正/);
      },
    );
  });
});

describe('T0.4 schema 恒等律（reject：打开即拒）', () => {
  it('kind/sourceKind 错配、maxTokens<1、sourceRef 空均被拒', async () => {
    const cases: readonly Record<string, unknown>[] = [
      pin({ kind: 'safety', sourceKind: 'goalTree.focus' }),
      pin({ maxTokens: 0 }),
      pin({ sourceRef: '' }),
    ];
    for (const record of cases) {
      const dir = await mkdtemp(join(tmpdir(), 'tda-ctx-reject-'));
      const backend = createJsonBackend(dir);
      try {
        const unit = await backend.open({ name: contextDomainSpec.name, version: contextDomainSpec.version });
        await unit.putRecord(compositeRecordKey('context_pins', 'pin-1'), record);
        await unit.close();
        await expect(openTdaDomain(contextDomainSpec, { backend })).rejects.toThrow();
      } finally {
        await backend.close();
        // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
      }
    }
  });
});

describe('T0.4 gate 分层（结构与降级）', () => {
  it('无样本即 static；全哨兵即 static 且有 fallbackReason', () => {
    const segments: ScorableSegment[] = [
      { id: 'h1', kind: 'history', text: 'abc', tokenEstimate: 10 },
      { id: 'i1', kind: 'injection', text: 'xyz', tokenEstimate: 10 },
    ];
    const noSample = runGate(segments, { keepTokens: 100 });
    expect(noSample.mode).toBe('static');
    expect(noSample.fallbackReason).toContain('static');

    const sentinel = runGate(segments, { keepTokens: 100 }, {
      tokens: [{ token: 'a', logprob: -9_999, top: [] }],
    });
    expect(sentinel.mode).toBe('static');
    expect(sentinel.fallbackReason).toContain('哨兵');

    const perplexity = runGate(segments, { keepTokens: 100 }, {
      tokens: [{ token: 'a', logprob: -0.01, top: [] }],
    });
    expect(perplexity.mode).toBe('perplexity');
  });

  it('pinned/system 永不进剥夺候选（C6 豁免绝对化）', () => {
    const segments: ScorableSegment[] = [
      { id: 'pin-1', kind: 'pinned', text: 'x'.repeat(100), tokenEstimate: 500 },
      { id: 'sys', kind: 'system', text: 'y'.repeat(100), tokenEstimate: 500 },
      { id: 'h1', kind: 'history', text: 'z'.repeat(100), tokenEstimate: 500 },
      { id: 'i1', kind: 'injection', text: 'w'.repeat(100), tokenEstimate: 500 },
    ];
    const dropped = selectDrops(segments, { 'pin-1': 0, sys: 0, h1: 0.5, i1: 0.1 }, 1_000);
    expect(dropped).toEqual(['i1', 'h1']);
    expect(dropped).not.toContain('pin-1');
    expect(dropped).not.toContain('sys');
  });
});
