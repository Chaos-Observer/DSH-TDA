/**
 * tda-trajectory 不变量门（门2 test:invariants）。
 *
 * 分层验证（§4.1 八条 + round↔turn）：
 *  - **schema 恒等律**（invalidRecords=backup-and-skip：派生索引跳过而非拒载）
 *    → seqFrom>seqTo / entityId 空 / seqFrom<1 各被跳过并通知；
 *  - **加载期检查** → 索引键规范性、索引↔日志一致、round↔turn、log-only 纯净；
 *  - **内核边界**（内核 `invariants.ts` 预留的 round↔turn 检查点在此落地）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  compositeRecordKey,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  type TdaDomain,
  type TdaSessionHost,
} from '@tda/kernel';
import { auditIndexKey, trajectoryDomainSpec, type TrajectoryTables } from '../src/index.ts';
import { registerTrajectoryInvariants } from '../src/loadChecks.ts';
import { createMemoryHost } from './helpers.ts';

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  entityKind: 'goal',
  entityId: 'goal-1',
  sessionId: 'sess-traj',
  seqFrom: 1,
  seqTo: 1,
  at: 1,
  ...overrides,
});

interface DomainOptions {
  readonly entries?: readonly Record<string, unknown>[];
  readonly host?: TdaSessionHost;
}

async function withDomain<T>(
  options: DomainOptions,
  body: (domain: TdaDomain<TrajectoryTables>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-traj-inv-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(trajectoryDomainSpec, { backend });
  try {
    for (const record of options.entries ?? [entry()]) {
      // 注记录：键按内容推导（否则会先被键规范性检查抓住，测不到别的）
      const key = auditIndexKey(record as never);
      await domain.table('audit_index').put(key, record as never);
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

const verify = async (domain: TdaDomain<TrajectoryTables>, host?: TdaSessionHost) => {
  const registry = createTdaInvariantRegistry();
  registerTrajectoryInvariants(registry, domain, host !== undefined ? { host } : {});
  return registry.verify();
};

describe('T0.7 schema 恒等律（backup-and-skip：坏记录跳过而非拒载）', () => {
  it('seqFrom>seqTo / entityId 空 / seqFrom<1 被跳过并通知，域仍可打开', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-traj-skip-'));
    const backend = createJsonBackend(dir);
    try {
      const unit = await backend.open({ name: trajectoryDomainSpec.name, version: trajectoryDomainSpec.version });
      await unit.putRecord(compositeRecordKey('audit_index', 'goal#goal-1#5'), entry({ seqFrom: 5, seqTo: 2 }));
      await unit.putRecord(compositeRecordKey('audit_index', 'task##1'), entry({ entityKind: 'task', entityId: '' }));
      await unit.putRecord(compositeRecordKey('audit_index', 'scan#scan-1#0'), entry({ entityKind: 'scan', entityId: 'scan-1', seqFrom: 0 }));
      await unit.close();
      const skipped: string[] = [];
      const domain = await openTdaDomain(trajectoryDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(info.key),
      });
      expect(skipped).toHaveLength(3);
      expect(domain.table('audit_index').size()).toBe(0);
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});

describe('T0.7 加载期检查', () => {
  it('合法索引 + 日志/轮次齐备 → 全部通过', async () => {
    const host = createMemoryHost();
    host.beginTurn(1);
    host.append({ family: 'goalTree/change', businessId: 'goal-1', payload: { id: 'goal-1', revision: 0 } });
    host.endTurn(2, 0, 'success');
    await withDomain({ entries: [entry({ seqFrom: 2, seqTo: 2 })], host }, async (domain) => {
      await expect(verify(domain, host)).resolves.toBeUndefined();
    });
  });

  it('索引键与内容不符被拒（键即纪律：不在键上的索引永不被查到）', async () => {
    await withDomain({ entries: [] }, async (domain) => {
      await domain.table('audit_index').put('goal#goal-1#999', entry() as never);
      await expect(verify(domain)).rejects.toThrow(/与内容不符/);
    });
  });

  it('索引指向日志里不存在的位置被拒（索引↔日志一致）', async () => {
    const host = createMemoryHost();
    host.beginTurn(1);
    host.endTurn(2, 0, 'success');
    await withDomain({ entries: [entry({ seqFrom: 2, seqTo: 2 })], host }, async (domain) => {
      // 日志 seq2 是 turn/end（宿主记录），不是 TDA 事件
      await expect(verify(domain, host)).rejects.toThrow(/找不到对应事件/);
    });
  });

  it('索引的 entityId/族与 seqFrom 处事件不符被拒', async () => {
    const host = createMemoryHost();
    host.append({ family: 'taskPool/change', businessId: 'task-9', payload: { id: 'task-9', revision: 0 } });
    await withDomain({ entries: [entry({ seqFrom: 1, seqTo: 1 })], host }, async (domain) => {
      await expect(verify(domain, host)).rejects.toThrow(/业务 id|声明 entityKind/);
    });
  });

  it('round↔turn：AssembleRecord.round 超出轮次数被拒；无轮次时降级', async () => {
    const host = createMemoryHost();
    host.beginTurn(1);
    host.endTurn(2, 0, 'success');
    host.append({ family: 'context/assemble', businessId: 'sess-traj:5', payload: { round: 5 } });
    await withDomain({ entries: [], host }, async (domain) => {
      await expect(verify(domain, host)).rejects.toThrow(/无对应轮次/);
    });

    const noTurns = createMemoryHost();
    noTurns.append({ family: 'context/assemble', businessId: 'sess-traj:5', payload: { round: 5 } });
    await withDomain({ entries: [], host: noTurns }, async (domain) => {
      await expect(verify(domain, noTurns)).resolves.toBeUndefined();
    });
  });

  it('log-only 纯净：TDA 载荷出现在模型可见消息里即被拒', async () => {
    const dirty = createMemoryHost();
    const payload = { id: 'goal-leak', revision: 3, objective: '这段文本被粘进了对话' };
    dirty.append({ family: 'goalTree/change', businessId: 'goal-leak', payload });
    dirty.beginTurn(1);
    dirty.appendMessage({ turn: 0, role: 'user', content: JSON.stringify(payload) }, 2);
    await withDomain({ entries: [], host: dirty }, async (domain) => {
      await expect(verify(domain, dirty)).rejects.toThrow(/log-only 纯净被破坏/);
    });

    const clean = createMemoryHost();
    clean.append({ family: 'goalTree/change', businessId: 'goal-clean', payload });
    clean.beginTurn(1);
    clean.appendMessage({ turn: 0, role: 'user', content: '正常对话，与事件载荷无关' }, 2);
    await withDomain({ entries: [], host: clean }, async (domain) => {
      await expect(verify(domain, clean)).resolves.toBeUndefined();
    });
  });

  it('未装配会话主机时三项日志相关检查降级（仍校验键规范性）', async () => {
    await withDomain({ entries: [entry()] }, async (domain) => {
      await expect(verify(domain)).resolves.toBeUndefined();
      await domain.table('audit_index').put('goal#x#7', entry({ entityId: 'x', seqFrom: 1 }) as never);
      await expect(verify(domain)).rejects.toThrow(/与内容不符/);
    });
  });
});

describe('T0.7 索引实体范围', () => {
  it('只索引六族内的实体种类（未知族不入索引）', async () => {
    const host = createMemoryHost();
    host.append({ family: 'goalTree/change', businessId: 'goal-1', payload: { id: 'goal-1', revision: 0 } });
    const dir = await mkdtemp(join(tmpdir(), 'tda-traj-index-'));
    const backend = createJsonBackend(dir);
    try {
      const domain = await openTdaDomain(trajectoryDomainSpec, { backend });
      const { createTrajectoryService } = await import('../src/service.ts');
      const service = createTrajectoryService({ domain, host });
      expect(await service.index({ family: 'goalTree/change', businessId: 'goal-1', seq: 1, sessionId: asSessionId('s') })).toBeDefined();
      expect(service.entries().every((item) => ['goal', 'task', 'timeline', 'dispatch', 'assemble', 'scan'].includes(item.entityKind))).toBe(
        true,
      );
      await domain.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
