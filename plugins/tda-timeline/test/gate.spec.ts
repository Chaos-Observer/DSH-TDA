/**
 * tda-timeline 冒烟门（门4 test:smoke）：IT1 / T0.3 验收载体（G0-③ 数据面侧）。
 *
 *  1. 进程内装配：tdaTimelinePlugin.apply → append/supersede/invalidate/search
 *     → 两级不变量过 → dispose
 *  2. idle-kill：op 全部完成后 kill -9 → 重启后条目/更正链/向量/FTS 原样
 *     （FTS 从 domain 重建后可检索）+ log↔domain 配对零差异 +
 *     replay-equivalence + 不变量复验；再以第二会话续写——EntryId 跨会话
 *     单调无洞（tl-6），FTS 在新进程重建后旧条目仍可检索
 *  3. §5.2 硬条款自检（tool-output 强制 quarantine，调用方无从指定）+
 *     WriterRef 归因 + 弱链接无级联（relatedTaskId 指向不存在任务也可读写）
 *
 * 子进程以 Node 类型剥离直跑（内核 erasable-syntax + 显式 .ts 扩展，零转译依赖），
 * 场景脚本放本包 testkit-runtime/（裸标识符靠 node_modules 向上解析）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  asEntryId,
  asSessionId,
  asTaskId,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  assertReplayEquivalence,
  compareReplay,
  createFileSessionSink,
  killAndWait,
  pairLogAgainstDomain,
  readSessionLog,
  spawnScenario,
  waitForControl,
} from '@tda/testkit';
import { tdaTimelinePlugin, timelineDomainSpec } from '../src/index.ts';

const runtimeDir = fileURLToPath(new URL('../testkit-runtime/', import.meta.url));

/** 内存 session sink（进程内装配用；append 分配自增 seq）。 */
function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-gate'),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

/**
 * idle 场景：经插件 apply 装配（真实出口路径），走完整写集后写 idle 保活等杀。
 * 5 次写入：append×3（含 tool-output 检疫条目）、supersede、invalidate。
 */
const IDLE_SCRIPT = `
import { asSessionId, createJsonBackend, createTdaInvariantRegistry } from '@tda/kernel';
import { createFileSessionSink, writeControl } from '@tda/testkit';
import { tdaTimelinePlugin } from '../src/index.ts';

const dir = process.argv[2];
const controlFile = process.argv[3];
const backend = createJsonBackend(dir);
const registry = createTdaInvariantRegistry();
const sink = createFileSessionSink(dir + '/session.jsonl', asSessionId('sess-tl-idle'));
const handle = await tdaTimelinePlugin.apply({ storage: backend, invariants: registry, session: sink });
const svc = handle.service;

const agent = { sessionId: 'sess-tl-idle', actor: 'agent', at: Date.now() };
const e1 = await svc.append(agent, { content: '预算守恒是树不变量之一', chunkType: 'fact', source: 'conversation', credential: 'user-original', vector: [1, 0] });
const e2 = await svc.append({ sessionId: 'sess-tl-idle', actor: 'human', at: Date.now() }, { content: '本周聚焦目标树施工', chunkType: 'fact', source: 'task', credential: 'user-original', relatedTaskId: 'task-1' });
const e3 = await svc.append(agent, { content: '工具返回：磁盘扫描完成', chunkType: 'fact', source: 'task', credential: 'tool-output' });
const e4 = await svc.supersede(agent, e1.id, { content: '预算守恒是树不变量（修订版）', chunkType: 'fact', source: 'conversation', credential: 'user-original', vector: [1, 0] }, '补充表述');
const e5 = await svc.invalidate(agent, e2.id, '计划改期');
// 进程内自检：检疫强制 / 当前视图 / 检索
if (e3.quarantine !== true) throw new Error('quarantine 服务端强制失败');
if (svc.current().length !== 2) throw new Error('current 自检失败');
if (svc.search({ text: '预算' }).length !== 1) throw new Error('search 自检失败');
await registry.verify();
writeControl(controlFile, 'idle');
setInterval(() => {}, 1000);
`;

/**
 * resume 场景：kill -9 后以新进程/新会话打开同一工作区——EntryId 分配从表内
 * 最大后缀续配（tl-6，跨会话 seq 单调无洞）；FTS 从 domain 重建后旧条目
 * （tl-4）仍可检索（§3.2 崩溃恢复口径）。
 */
const RESUME_SCRIPT = `
import { asSessionId, createJsonBackend, createTdaInvariantRegistry } from '@tda/kernel';
import { createFileSessionSink, writeControl } from '@tda/testkit';
import { tdaTimelinePlugin } from '../src/index.ts';

const dir = process.argv[2];
const controlFile = process.argv[3];
const backend = createJsonBackend(dir);
const registry = createTdaInvariantRegistry();
const sink = createFileSessionSink(dir + '/session2.jsonl', asSessionId('sess-tl-resume'));
const handle = await tdaTimelinePlugin.apply({ storage: backend, invariants: registry, session: sink });
const svc = handle.service;

const e6 = await svc.append({ sessionId: 'sess-tl-resume', actor: 'agent', at: Date.now() }, { content: '跨会话续写：时间线不随会话切换而重置', chunkType: 'reflection', source: 'study', credential: 'model-produced' });
if (e6.id !== 'tl-6') throw new Error('跨会话 seq 单调性失败：期望 tl-6，实际 ' + e6.id);
const hits = svc.search({ text: '预算' });
if (hits.length !== 1 || hits[0].entry.id !== 'tl-4') {
  throw new Error('FTS 重建失败：' + JSON.stringify(hits.map((hit) => hit.entry.id)));
}
await registry.verify();
writeControl(controlFile, 'done');
process.exit(0);
`;

describe('tda-timeline 冒烟门', () => {
  it('进程内装配：apply → append/supersede/invalidate/search → 两级不变量过 → dispose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-tl-gate-asm-'));
    const registry = createTdaInvariantRegistry();
    const backend = createJsonBackend(dir);
    const handle = await tdaTimelinePlugin.apply({
      storage: backend,
      invariants: registry,
      session: createFileSessionSink(join(dir, 'session.jsonl'), asSessionId('sess-gate-asm')),
    });
    try {
      const writer = { sessionId: 'sess-gate-asm', actor: 'agent' as const, at: Date.now() };
      const first = await handle.service.append(writer, {
        content: '初版结论：先收尾 IT1',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'user-original',
      });
      const second = await handle.service.append(writer, {
        content: '工具返回：目录扫描清单',
        chunkType: 'fact',
        source: 'task',
        credential: 'tool-output',
      });
      expect(second.quarantine).toBe(true);
      const replacement = await handle.service.supersede(
        writer,
        first.id,
        { content: '修订结论：IT1 收尾并回填规格', chunkType: 'fact', source: 'conversation', credential: 'user-original' },
        '范围细化',
      );
      await handle.service.invalidate(writer, first.id, '已被修订版取代后的旧注记');
      // 当前视图：修订版 + 检疫条目（旧结论已出）
      expect(handle.service.current().map((entry) => entry.id)).toEqual([second.id, replacement.id]);
      // 检索：混合模式可命中
      expect(handle.service.search({ text: '修订' }).map((hit) => hit.entry.id)).toEqual([replacement.id]);
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('idle-kill：kill -9 → 重启原样 + FTS 从 domain 重建 + 跨会话 seq 单调', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-tl-gate-idle-'));
    try {
      const controlFile = join(dir, 'control.log');
      const spawned = spawnScenario({
        runtimeDir,
        scriptName: 'idle-scenario.mjs',
        scriptSource: IDLE_SCRIPT,
        args: [dir, controlFile],
      });
      expect(await waitForControl(controlFile, 'idle'), spawned.readStderr()).toBe(true);
      const outcome = await killAndWait(spawned.child);
      expect(outcome.hardKilled).toBe(true);

      // 日志：5 个事件（append×3 + supersede + invalidate），无撕裂尾
      const { events, tornTail } = readSessionLog(join(dir, 'session.jsonl'));
      expect(events).toHaveLength(5);
      expect(tornTail).toBe(false);

      // 重启：条目/更正链/向量原样恢复
      const backend = createJsonBackend(dir);
      const domain = await openTdaDomain(timelineDomainSpec, { backend });
      try {
        const entries = domain.table('timeline_entries');
        expect(entries.size()).toBe(5);
        for (const id of ['tl-1', 'tl-2', 'tl-3', 'tl-4', 'tl-5']) {
          expect(entries.get(id)).toBeDefined();
        }
        // 检疫强制已落盘
        expect(entries.get('tl-3')?.quarantine).toBe(true);
        expect(entries.get('tl-3')?.credential).toBe('tool-output');
        // 更正链：supersede/invalidate 链接与理由原样
        expect(entries.get('tl-4')?.supersedes).toBe('tl-1');
        expect(entries.get('tl-4')?.reason).toBe('补充表述');
        expect(entries.get('tl-5')?.kind).toBe('invalidation');
        expect(entries.get('tl-5')?.invalidates).toBe('tl-2');
        expect(entries.get('tl-5')?.content).toBe('计划改期');
        // 向量随条目持久化
        expect(entries.get('tl-4')?.vector).toEqual([1, 0]);

        // 配对：条目键 ↔ 事件 businessId 零差异
        expect(pairLogAgainstDomain(events, entries.keys()).ok).toBe(true);
        // replay-equivalence：事件载荷（全量记录）重放 == 域现状
        assertReplayEquivalence(
          compareReplay(events, entries.entries(), (event) => ({ key: event.businessId, value: event.payload })),
        );
      } finally {
        await domain.close();
        await backend.close();
      }

      // 重启后经插件真实出口装配：FTS 从 domain 重建 + 两级不变量复验
      const registry = createTdaInvariantRegistry();
      const backend2 = createJsonBackend(dir);
      const handle2 = await tdaTimelinePlugin.apply({
        storage: backend2,
        invariants: registry,
        session: createMemorySink(),
      });
      try {
        // FTS 重建：被取代的 tl-1 不在当前视图；tl-4 可检索
        const hits = handle2.service.search({ text: '预算' });
        expect(hits.map((hit) => hit.entry.id)).toEqual(['tl-4']);
        // 当前视图自洽：tl-1（被 supersede）、tl-2（被 invalidate）已出
        expect(handle2.service.current().map((entry) => entry.id)).toEqual(['tl-3', 'tl-4']);
        // 历史链完整
        expect(handle2.service.history(asEntryId('tl-1')).map((entry) => entry.id)).toEqual(['tl-1', 'tl-4']);
        await expect(registry.verify()).resolves.toBeUndefined();
      } finally {
        await handle2.dispose();
        await backend2.close();
      }

      // 跨会话续写：新进程/新会话打开同一工作区，EntryId 续配 tl-6（seq 单调无洞）
      const controlFile2 = join(dir, 'control2.log');
      const resumed = spawnScenario({
        runtimeDir,
        scriptName: 'resume-scenario.mjs',
        scriptSource: RESUME_SCRIPT,
        args: [dir, controlFile2],
      });
      expect(await waitForControl(controlFile2, 'done'), resumed.readStderr()).toBe(true);
      // 'done' 后仅剩 process.exit(0)；等退出落定再断言退出码
      const exitCode = await new Promise<number | null>((resolve) => {
        if (resumed.child.exitCode !== null) {
          resolve(resumed.child.exitCode);
          return;
        }
        resumed.child.once('exit', (code) => resolve(code));
      });
      expect(exitCode).toBe(0);

      // 终态核对：6 条条目，续写条目在
      const backend3 = createJsonBackend(dir);
      const domain3 = await openTdaDomain(timelineDomainSpec, { backend: backend3 });
      try {
        expect(domain3.table('timeline_entries').size()).toBe(6);
        expect(domain3.table('timeline_entries').get('tl-6')?.content).toContain('跨会话续写');
      } finally {
        await domain3.close();
        await backend3.close();
      }
    } finally {
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('§5.2 硬条款 + WriterRef 归因 + 弱链接无级联自检', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-tl-gate-hard-'));
    const registry = createTdaInvariantRegistry();
    const backend = createJsonBackend(dir);
    const sink = createMemorySink();
    const handle = await tdaTimelinePlugin.apply({ storage: backend, invariants: registry, session: sink });
    try {
      const writer = { sessionId: 'sess-gate-hard', actor: 'human' as const, at: Date.now() };
      // §5.2：以工具返回内容调用 append——TimelineChunk 无 quarantine 字段
      // （类型级无从指定），服务端按 credential 恒置 true
      const toolOut = await handle.service.append(writer, {
        content: '工具返回：可释放 3.2GB',
        chunkType: 'fact',
        source: 'task',
        credential: 'tool-output',
      });
      expect(toolOut.quarantine).toBe(true);
      // 弱链接：relatedTaskId 指向不存在的任务（任务层未建）——读写无级联
      const linked = await handle.service.append(writer, {
        content: '任务证据：目标树五表已落',
        chunkType: 'fact',
        source: 'task',
        credential: 'execution-verified',
        relatedTaskId: asTaskId('task-999'),
      });
      expect(handle.service.current({ relatedTaskId: asTaskId('task-999') }).map((entry) => entry.id)).toEqual([linked.id]);
      expect(handle.service.get(linked.id)?.relatedTaskId).toBe('task-999');
      // 归因：每条记录可追溯到 WriterRef；域内每个条目都有事件踪迹
      for (const [key, entry] of handle.domain.table('timeline_entries').entries()) {
        expect(entry.writer.sessionId).toBe('sess-gate-hard');
        expect(entry.writer.actor).toBe('human');
        expect(entry.writer.at).toBeTypeOf('number');
        expect(sink.events.some((event) => event.businessId === key)).toBe(true);
      }
      // 模型可见性口径：时间线内容不自动进上下文——无 promptSection 出口
      expect((handle.service as unknown as { promptSection?: unknown }).promptSection).toBeUndefined();
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
