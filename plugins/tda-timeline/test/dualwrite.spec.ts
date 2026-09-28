/**
 * tda-timeline 双写对账门（门3 test:dualwrite）：服务每次 accepted 写入
 * 经统一出口 commitEntry（timeline_entries 落域 → append log-only 事件
 * → 同步 FTS 派生索引），对账器逐一配对。
 *
 * 覆盖：单 op 配对 / supersede-invalidate 配对（含 reason 落域）/
 *       audit_index 按 timeline 实体自动延展 / 记录不存 seq（方案 §3.2
 *       硬规则：seq 拥有序在事件侧）/ 预检失败不落域不产事件（fail-loud，
 *       无半套）/ 直写域即漏双写。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asEntryId,
  asSessionId,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  openTdaDomain,
  type AuditIndex,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import { timelineDomainSpec, type TimelineTables } from '../src/domain.ts';
import { createTimelineService, type TimelineService } from '../src/service.ts';

/** 内存 session sink（append 分配自增 seq）。 */
function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-dw'),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<TimelineTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly service: TimelineService;
  readonly sink: ReturnType<typeof createMemorySink>;
}

async function assemble(dir: string): Promise<Rig> {
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(timelineDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  const sink = createMemorySink();
  const service = createTimelineService({ domain, session: sink, reconciler, index });
  return { dir, backend, domain, reconciler, index, service, sink };
}

async function teardown(rig: Rig): Promise<void> {
  await rig.domain.close();
  await rig.backend.close();
  // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', rig.dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

const agentWriter = { sessionId: 'sess-dw', actor: 'agent', at: 1 } as const;

const factChunk = {
  content: '预算守恒是树不变量',
  chunkType: 'fact',
  source: 'conversation',
  credential: 'user-original',
} as const;

describe('tda-timeline 双写对账门', () => {
  it('单 op：append 一域写配对一个事件；记录不存 seq', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-dw-single-')));
    try {
      await rig.service.append(agentWriter, factChunk);
      expect(rig.sink.events).toHaveLength(1);
      expect(rig.sink.events[0]?.family).toBe('timeline/write');
      expect(rig.sink.events[0]?.businessId).toBe('tl-1');
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 1,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
      // 硬规则：seq 在事件侧拥有序，domain 记录不重复存储
      const record = rig.domain.table('timeline_entries').get('tl-1');
      expect(record).toBeDefined();
      expect(Object.keys(record ?? {})).not.toContain('seq');
      // 事件载荷与记录逐字段一致（replay-equivalence 基石）
      expect(rig.sink.events[0]?.payload).toEqual(record);
    } finally {
      await teardown(rig);
    }
  });

  it('复合 op：supersede/invalidate 各配对 1，reason 落域可溯', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-dw-correction-')));
    try {
      const origin = await rig.service.append(agentWriter, factChunk);
      const replacement = await rig.service.supersede(agentWriter, origin.id, { ...factChunk, content: '预算守恒（修订版）' }, '补充表述');
      const voided = await rig.service.invalidate(agentWriter, origin.id, '计划改期');
      expect(rig.sink.events).toHaveLength(3);
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 3,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
      // supersede 的 reason 落在新记录上（§4.2 签名落点；invalidation 的 reason 即 content）
      expect(rig.service.get(replacement.id)?.reason).toBe('补充表述');
      expect(rig.service.get(voided.id)?.content).toBe('计划改期');
      expect(rig.service.get(voided.id)?.invalidates).toBe(origin.id);
      // audit_index：timeline 实体 seq 区间自动延展（三条写入同实体域）
      expect(rig.index.locate('timeline', 'tl-1')).toMatchObject({ seqFrom: 1, seqTo: 1 });
      expect(rig.index.locate('timeline', 'tl-2')).toMatchObject({ seqFrom: 2, seqTo: 2 });
      expect(rig.index.locate('timeline', 'tl-3')).toMatchObject({ seqFrom: 3, seqTo: 3 });
    } finally {
      await teardown(rig);
    }
  });

  it('预检失败：supersede 不存在目标不落域、不产事件、无失败窗口（fail-loud 无半套）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-dw-precheck-')));
    try {
      await rig.service.append(agentWriter, factChunk);
      await expect(
        rig.service.supersede(agentWriter, asEntryId('tl-99'), factChunk, '目标不存在'),
      ).rejects.toThrow(/ENTRY_NOT_FOUND|不存在/);
      expect(rig.sink.events).toHaveLength(1); // 仍只有 append 一个事件
      expect(rig.domain.table('timeline_entries').size()).toBe(1);
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 1,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
    } finally {
      await teardown(rig);
    }
  });

  it('直写域绕过双写器 → 漏双写（对账器 + 内核级不变量双捕获）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-dw-leak-')));
    try {
      await rig.domain.table('timeline_entries').put('tl-5', {
        id: asEntryId('tl-5'),
        kind: 'chunk',
        content: '绕过双写',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'model-produced',
        quarantine: false,
        writer: { sessionId: 'sess-dw', actor: 'agent', at: 1 },
        createdAt: 1,
      });
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges).toHaveLength(1);
      expect(report.unpairedChanges[0]).toMatchObject({ table: 'timeline_entries', key: 'tl-5' });
    } finally {
      await teardown(rig);
    }
  });
});
