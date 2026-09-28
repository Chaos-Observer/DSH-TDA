/**
 * tda-workspace 不变量门（门2 test:invariants）。
 *
 * 分层验证（§4.1 八条的落点）：
 *  - schema 恒等律（invalidRecords=**backup-and-skip**：派生数据跳过而非拒载，
 *    故此处用 onInvalidRecord 断言"被跳过"）→ 路径不安全、边置信度越界、
 *    depends-on 置信度≠1、failed 无 unfinished、recorded 无 inventoryEntryId；
 *  - 加载期检查 → 边引用完整性、supersedes 成环、lastScanId 可溯、cache 与图谱漂移、
 *    边键规范性、路径前缀不得逃出任务 localPath。
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
import { edgeKey, nodeKey, workspaceDomainSpec, type WorkspaceTables } from '../src/index.ts';
import { registerWorkspaceInvariants } from '../src/loadChecks.ts';

const node = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskId: 'task-1',
  path: 'proj/a.md',
  size: 3,
  mtime: 1,
  ext: 'md',
  ignored: false,
  role: 'doc',
  credibilityHint: 'unknown',
  lastScanId: 'scan-1',
  ...overrides,
});

const otherNode = node({ path: 'proj/b.md' });

const run = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'scan-1',
  taskId: 'task-1',
  mode: 'full',
  status: 'recorded',
  startedAt: 1,
  finishedAt: 2,
  filesScanned: 2,
  filesChanged: 2,
  truncated: false,
  inventoryEntryId: 'tl-1',
  localPath: 'proj',
  maxFiles: 2_000,
  maxBytes: 1_000,
  ...overrides,
});

const edge = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskId: 'task-1',
  from: 'proj/a.md',
  to: 'proj/b.md',
  kind: 'depends-on',
  confidence: 1,
  evidence: 'import → ./b',
  ...overrides,
});

const cacheRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskId: 'task-1',
  path: 'proj/a.md',
  size: 3,
  mtime: 1,
  lastScanId: 'scan-1',
  ...overrides,
});

interface DomainOptions {
  readonly nodes?: readonly Record<string, unknown>[];
  readonly edges?: readonly Record<string, unknown>[];
  readonly runs?: readonly Record<string, unknown>[];
  readonly cache?: readonly Record<string, unknown>[];
}

async function withDomain<T>(seed: DomainOptions, body: (domain: TdaDomain<WorkspaceTables>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-ws-inv-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(workspaceDomainSpec, { backend });
  try {
    for (const record of seed.runs ?? [run()]) await domain.table('ws_scan_runs').put(String(record.id), record as never);
    for (const record of seed.nodes ?? [node(), otherNode]) {
      await domain.table('ws_file_nodes').put(nodeKey(String(record.taskId), String(record.path)), record as never);
    }
    for (const record of seed.edges ?? [edge()]) {
      await domain
        .table('ws_graph_edges')
        .put(edgeKey(String(record.taskId), String(record.from), String(record.to), record.kind as never), record as never);
    }
    for (const record of seed.cache ?? [cacheRow(), cacheRow({ path: 'proj/b.md' })]) {
      await domain.table('ws_scan_cache').put(nodeKey(String(record.taskId), String(record.path)), record as never);
    }
    return await body(domain);
  } finally {
    await domain.close();
    await backend.close();
    // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  }
}

const verify = async (domain: TdaDomain<WorkspaceTables>, taskLocalPath?: (taskId: string) => string | undefined) => {
  const registry = createTdaInvariantRegistry();
  registerWorkspaceInvariants(registry, domain, taskLocalPath !== undefined ? { taskLocalPath } : {});
  return registry.verify();
};

describe('T0.6 加载期检查', () => {
  it('合法域全部通过', async () => {
    await withDomain({}, async (domain) => {
      await expect(verify(domain)).resolves.toBeUndefined();
    });
  });

  it('边引用不存在的节点被拒（引用完整：to/from 必存在）', async () => {
    await withDomain({ edges: [edge({ to: 'proj/ghost.md' })] }, async (domain) => {
      await expect(verify(domain)).rejects.toThrow(/不存在的文件节点 proj\/ghost\.md/);
    });
  });

  it('supersedes-file 版本链成环被拒', async () => {
    await withDomain(
      {
        edges: [
          edge({ kind: 'supersedes-file', confidence: 0.9, from: 'proj/a.md', to: 'proj/b.md' }),
          edge({ kind: 'supersedes-file', confidence: 0.9, from: 'proj/b.md', to: 'proj/a.md' }),
        ],
      },
      async (domain) => {
        await expect(verify(domain)).rejects.toThrow(/成环/);
      },
    );
  });

  it('节点 lastScanId 不可溯（或跨任务）被拒', async () => {
    await withDomain({ nodes: [node({ lastScanId: 'scan-ghost' }), otherNode] }, async (domain) => {
      await expect(verify(domain)).rejects.toThrow(/lastScanId=scan-ghost 不存在/);
    });
    await withDomain({ runs: [run({ taskId: 'task-other' })], nodes: [node(), otherNode] }, async (domain) => {
      await expect(verify(domain)).rejects.toThrow(/与节点任务 task-1 不符/);
    });
  });

  it('cache 与图谱漂移被拒（三级比对依据必须与图谱同源）', async () => {
    await withDomain({ cache: [cacheRow({ size: 999 }), cacheRow({ path: 'proj/b.md' })] }, async (domain) => {
      await expect(verify(domain)).rejects.toThrow(/与节点漂移/);
    });
  });

  it('边记录键不规范被拒（键即纪律：不在键上的边会重复堆积）', async () => {
    await withDomain({}, async (domain) => {
      // 直写一条"键与内容不符"的边（绕过服务路径，模拟注入）
      await domain.table('ws_graph_edges').put('task-1#proj/a.md#proj/b.md#related-to', edge() as never);
      await expect(verify(domain)).rejects.toThrow(/与内容不符/);
    });
  });

  it('节点路径逃出任务 localPath 前缀被拒（不变量 1 强形式）', async () => {
    await withDomain({ nodes: [node({ path: 'other/a.md' }), otherNode] }, async (domain) => {
      await expect(verify(domain, () => 'proj')).rejects.toThrow(/逃离任务/);
    });
  });
});

describe('T0.6 schema 恒等律（backup-and-skip：坏记录跳过而非拒载）', () => {
  it('不安全路径/越界置信度/depends-on 非 1 的记录被跳过并通知，域仍可打开', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-ws-skip-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: workspaceDomainSpec.name, version: workspaceDomainSpec.version });
      await unit.putRecord(compositeRecordKey('ws_file_nodes', 'task-1#../escape.md'), node({ path: '../escape.md' }));
      await unit.putRecord(
        compositeRecordKey('ws_graph_edges', 'task-1#proj/a.md#proj/b.md#related-to'),
        edge({ kind: 'related-to', confidence: 2, evidence: 'x' }),
      );
      await unit.putRecord(
        compositeRecordKey('ws_graph_edges', 'task-1#proj/a.md#proj/b.md#depends-on'),
        edge({ confidence: 0.5 }),
      );
      await unit.close();

      const skipped: string[] = [];
      const domain = await openTdaDomain(workspaceDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(`${info.table}:${info.key}`),
      });
      expect(skipped).toHaveLength(3);
      expect(skipped.join(' ')).toContain('ws_file_nodes');
      expect(domain.table('ws_file_nodes').size()).toBe(0);
      expect(domain.table('ws_graph_edges').size()).toBe(0);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('scan run 恒等律：failed 无 unfinished / recorded 无 inventoryEntryId 均被跳过', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-ws-skip2-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: workspaceDomainSpec.name, version: workspaceDomainSpec.version });
      await unit.putRecord(compositeRecordKey('ws_scan_runs', 'scan-a'), run({ id: 'scan-a', status: 'failed' }));
      await unit.putRecord(
        compositeRecordKey('ws_scan_runs', 'scan-b'),
        run({ id: 'scan-b', status: 'recorded', truncated: true, unfinished: ['x'] }),
      );
      await unit.close();
      const skipped: string[] = [];
      const domain = await openTdaDomain(workspaceDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(info.key),
      });
      expect(skipped.sort()).toEqual(['scan-a', 'scan-b']);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
