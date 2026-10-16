/**
 * P5 vendor 门（转正回归）：vendor/dsh 34 包从 TDA 侧可解析（P5.0），
 * createSqliteBackend 适配器承载真 TdaDomain（P5.1），
 * openDshCompatSessionHost 写出的日志可被 DSH 真校验采纳（P5.2）。
 * vendor 更新（scripts/vendor-dsh.mjs 重放）后必须仍绿。
 */
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createSqliteBackend,
  openTdaDomain,
  createJsonBackend,
  openDshCompatSessionHost,
  readDshCompatRecords,
  type TdaDomainSpec,
} from '@tda/kernel';

// ── P5.0：类型层经机械 src 化的 exports 主入口直吃源码（零构建、零业务源码改动）──
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
// P5.3：DSH llm 子路径真件（无装饰器独立文件，运行层直吃）
import { BlockAssembler } from '@deepseek-ai/dsh-llm/src/assembler.ts';
import { AssistantStreamAccumulator, expandAssistantStream } from '@deepseek-ai/dsh-llm/src/assistant-stream.ts';
import { createDshStreamProvider, createScriptedStreamFace, structuredFromBlocks } from 'tda-subagent-dispatch';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDshToolRegistry, validateJsonSchemaSubset, RUN_CODE_RESERVED_NAME } from 'tda-task-pool';
import type { DshStreamChunk } from 'tda-subagent-dispatch';
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite';

describe('P5.0 vendor 探针', () => {
  it('defineDomain 类型层可用（DomainSpec 同构验证）', () => {
    const spec = defineDomain({
      name: 'tda_probe',
      version: 1,
      compatibleVersions: [],
      tables: {
        probe: { valueSchema: z.unknown() },
      },
    });
    expect(spec.name).toBe('tda_probe');
  });

  it('SqliteStorageBackend 运行层可用（:memory: + kv.open 单元）', async () => {
    const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' });
    const unit = await backend.kv.open({
      name: 'tda_probe',
      version: 1,
      tables: ['probe'],
      hasGlobal: false,
    });
    // 基础 KV 原语往返（SqliteKvUnit：putRecord/loadAll/deleteRecord/setGlobal）
    await unit.putRecord('probe', 'k1', { v: 42 });
    const loaded = await unit.loadAll();
    expect(loaded.tables.probe).toEqual({ k1: { v: 42 } });
    await unit.deleteRecord('probe', 'k1');
    const after = await unit.loadAll();
    expect(after.tables.probe).toEqual({});
    await backend.close?.();
  });
});

// ── P5.1：createSqliteBackend 适配器承载真 TdaDomain ──

const PROBE_SPEC: TdaDomainSpec<{ alpha: z.ZodTypeAny; beta: z.ZodTypeAny }> = {
  name: 'tda-probe-domain',
  version: 2,
  compatibleVersions: [1],
  tables: {
    alpha: z.object({ label: z.string(), n: z.number() }),
    beta: z.object({ flag: z.boolean() }),
  },
};

describe('P5.1 createSqliteBackend（DSH 兼容物理布局）', () => {
  it('多表 composite 读写删 + 重开持久化（同形对拍 jsonBackend）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-p5-sqlite-'));
    const file = join(dir, 'probe.db');
    {
      const backend = createSqliteBackend(file);
      const domain = await openTdaDomain(PROBE_SPEC, { backend });
      await domain.table('alpha').put('a-1', { label: '甲', n: 1 });
      await domain.table('alpha').put('a-2', { label: '乙', n: 2 });
      await domain.table('beta').put('b-1', { flag: true });
      expect(domain.table('alpha').get('a-1')).toEqual({ label: '甲', n: 1 });
      expect([...domain.table('alpha').entries()]).toHaveLength(2);
      expect(domain.table('beta').size()).toBe(1);
      await domain.table('alpha').delete('a-2');
      expect(domain.table('alpha').get('a-2')).toBeUndefined();
      await domain.close();
      backend.close();
    }
    // 重开：持久化 + 同形对拍 jsonBackend 内存态
    {
      const backend = createSqliteBackend(file);
      const domain = await openTdaDomain(PROBE_SPEC, { backend });
      expect(domain.table('alpha').get('a-1')).toEqual({ label: '甲', n: 1 });
      expect(domain.table('alpha').size()).toBe(1);
      expect(domain.table('beta').get('b-1')).toEqual({ flag: true });

      const reference = await openTdaDomain(PROBE_SPEC, { backend: createJsonBackend(join(dir, 'ref')) });
      await reference.table('alpha').put('a-1', { label: '甲', n: 1 });
      await reference.table('beta').put('b-1', { flag: true });
      expect([...domain.table('alpha').entries()].sort()).toEqual([...reference.table('alpha').entries()].sort());
      await reference.close();
      await domain.close();
      backend.close();
    }
  });

  it('版本兼容集：v1 存量 → open v2(compatible) 重戳；不兼容 → VERSION_MISMATCH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-p5-sqlite-ver-'));
    const file = join(dir, 'probe.db');
    // 先落 v1 数据
    const v1Spec: TdaDomainSpec<{ alpha: z.ZodTypeAny }> = { ...PROBE_SPEC, version: 1 };
    {
      const backend = createSqliteBackend(file);
      const domain = await openTdaDomain(v1Spec, { backend });
      await domain.table('alpha').put('legacy', { label: '旧', n: 0 });
      await domain.close();
      backend.close();
    }
    // v2 + compatibleVersions:[1] ⇒ 接受并重戳
    {
      const backend = createSqliteBackend(file);
      const domain = await openTdaDomain(PROBE_SPEC, { backend });
      expect(domain.table('alpha').get('legacy')).toEqual({ label: '旧', n: 0 });
      await domain.close();
      backend.close();
    }
    // v3（不兼容）⇒ 拒绝
    {
      const backend = createSqliteBackend(file);
      const v3Spec: TdaDomainSpec<{ alpha: z.ZodTypeAny; beta: z.ZodTypeAny }> = { ...PROBE_SPEC, version: 3 };
      await expect(openTdaDomain(v3Spec, { backend })).rejects.toThrowError(/介质版本 2 与 domain 版本 3/);
      backend.close();
    }
  });

  it('backup-and-skip：损坏记录挪影子表（DSH 主表布局不受影响）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-p5-sqlite-backup-'));
    const file = join(dir, 'probe.db');
    const backupSpec: TdaDomainSpec<{ alpha: z.ZodTypeAny }> = {
      name: 'tda-probe-derived',
      version: 1,
      invalidRecords: 'backup-and-skip',
      tables: { alpha: z.object({ label: z.string(), n: z.number() }) },
    };
    {
      const backend = createSqliteBackend(file);
      const domain = await openTdaDomain(backupSpec, { backend });
      await domain.table('alpha').put('good', { label: '好', n: 1 });
      await domain.close();
      backend.close();
    }
    // 毒化：注入一条"JSON 合法但 schema 不过"的记录（坏 JSON 属 malformed-medium
    // 语义=整域拒绝打开，不在 backup-and-skip 范围——与 jsonBackend/DSH 对齐）。
    // 介质键是适配器的长度前缀编码：2:alpha<key>。
    {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(file);
      db.prepare(`INSERT INTO "u_tda_probe_derived_records" (key, value) VALUES (?, ?)`).run(
        '2:alphaschema-fail',
        JSON.stringify({ label: 42, n: '不是数字' }),
      );
      db.close();
    }
    // 打开：坏记录被挪入影子表，好记录存活
    {
      const backend = createSqliteBackend(file);
      const domain = await openTdaDomain(backupSpec, { backend });
      expect(domain.table('alpha').get('good')).toEqual({ label: '好', n: 1 });
      expect(domain.table('alpha').get('schema-fail')).toBeUndefined();
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(file);
      const backed = db.prepare('SELECT COUNT(*) AS n FROM "u_tda_probe_derived_records_backup"').get() as {
        n: number;
      };
      expect(backed.n).toBe(1);
      db.close();
      await domain.close();
      backend.close();
    }
  });
});

// ── P5.2：openDshCompatSessionHost（DSH jsonl 物理格式）──

describe('P5.2 openDshCompatSessionHost', () => {
  it('写读还原 + seq 连续 + header（version 4 / isSeeded false）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-p5-dsh-'));
    const file = join(dir, 'session.jsonl');
    const host = openDshCompatSessionHost(file, 'sess-dsh-probe' as never, { createdAt: 1000 });
    const turn = host.beginTurn(1001);
    host.append({ family: 'taskPool/change', businessId: 'task-1', payload: { stage: 'planning' } });
    host.appendMessage({ turn, role: 'user', content: '整理灯环协议' }, 1002);
    host.endTurn(1003, turn, 'success');

    const read = readDshCompatRecords(file);
    expect(read.header).toEqual({
      type: 'session',
      version: 4,
      id: 'sess-dsh-probe',
      createdAt: 1000,
      isSeeded: false,
      delegationDepth: 0,
    });
    expect(read.records).toHaveLength(4); // turn/start + tda + conversation + turn/end
    expect(read.tornTail).toBe(false);
    expect(read.records.map((record) => record.seq)).toEqual([1, 2, 3, 4]); // header 不占 TDA seq
  });

  it('DSH 真校验采纳：validateStoredEvents 不拒（未知 tda/* 类型因 ignorable 跳过）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-p5-dsh-adopt-'));
    const file = join(dir, 'session.jsonl');
    const host = openDshCompatSessionHost(file, 'sess-dsh-adopt' as never, { createdAt: 2000 });
    host.beginTurn(2001);
    host.append({ family: 'goalTree/change', businessId: 'goal-1', payload: { phase: 'active' } });
    host.appendMessage({ turn: 0, role: 'assistant', content: 'ready' }, 2002);
    host.appendToolCall({ turn: 0, tool: 'task_list', argClass: 'query', status: 'success' }, 2003);

    // 行 → DSH 信封数组（header 行除外）
    const lines = (readFileSync(file, 'utf8') as string).split('\n').filter((line) => line.trim() !== '');
    const events = lines
      .map((line) => JSON.parse(line) as { type: string } & Record<string, unknown>)
      .filter((line) => line.type !== 'session');
    expect(events).toHaveLength(4);

    // **storage-contract 语义复刻（词表 = DSH 真代码）**：@deepseek-ai/dsh-session-persistence
    // 的 import 链拉进 llm 包的 @Remote 装饰器（node strip/oxc 均不可转换——装饰器是
    // "源码直吃"的硬边界，DSH 发货态走构建产物无此问题，P5.4 由 DSH 宿主内置）。
    // 本门用 DSH 真词表（known-event-types.ts 独立文件可加载）复刻其判定：
    // 未知 type 必须 ignorable=true 才采纳。
    const { KNOWN_SESSION_EVENT_TYPES } = (await import(
      '@deepseek-ai/dsh-session/src/known-event-types.ts'
    )) as { KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> };
    for (const event of events) {
      if (!KNOWN_SESSION_EVENT_TYPES.has(event.type)) {
        expect(event.ignorable).toBe(true); // 未登记类型必须标记 ignorable
      }
    }
    expect(events.every((event) => typeof event.seq === 'number' && event.seq > 0)).toBe(true);
  });

  it('撕裂尾丢弃 + 重开 seq 续接 + 历史字节不变（kill -9 语义）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-p5-dsh-kill-'));
    const file = join(dir, 'session.jsonl');
    const host = openDshCompatSessionHost(file, 'sess-dsh-kill' as never);
    host.beginTurn(3000);
    const bytesBefore = readFileSync(file);
    // 模拟崩溃半行（无换行 = 未提交）
    appendFileSync(file, '{"type":"tda/turn/end","seq":3,"time":3', 'utf8');

    const reopened = openDshCompatSessionHost(file, 'sess-dsh-kill' as never);
    const read = readDshCompatRecords(file);
    // truncation-repair：重开即截断撕裂尾 ⇒ 此后读回 tornTail=false（半行已删）
    expect(read.tornTail).toBe(false);
    expect(read.records).toHaveLength(1); // 撕裂行丢弃
    expect(reopened.nextSeq()).toBe(2); // seq 续接
    // 历史字节不变（resume 只追加）：repair 后文件 = 完整行状态，与半行写入前一致
    const bytesAfter = readFileSync(file);
    expect(bytesAfter.subarray(0, bytesBefore.length)).toEqual(bytesBefore);
    expect(bytesAfter.length).toBe(bytesBefore.length);
    // 续写正常
    reopened.append({ family: 'taskPool/change', businessId: 'task-9', payload: {} });
    expect(readDshCompatRecords(file).records).toHaveLength(2);
  });
});

// ── P5.3：StreamChunk 换真（face 输出由 DSH 真 BlockAssembler 组装/校验）──

const STREAM_CONCLUSION = { findings: ['流式链路打通'], confidence: 1 };

async function collectChunks(spec: Parameters<typeof createScriptedStreamFace>[0]): Promise<DshStreamChunk[]> {
  const chunks: DshStreamChunk[] = [];
  const request = {
    provider: 'tda-dispatch',
    model: 'tda-subagent-oneshot',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }] }],
  };
  for await (const chunk of createScriptedStreamFace(spec)(request)) chunks.push(chunk);
  return chunks;
}

describe('P5.3 StreamChunk 换真（DSH 真 BlockAssembler）', () => {
  it('对拍：同一 tool-call chunk 序列，DSH 组装 = 适配器提取（+ usage/finish 契约）', async () => {
    const chunks = await collectChunks({ structured: STREAM_CONCLUSION, viaToolCall: true, usage: { inputTokens: 9, outputTokens: 6, totalTokens: 15 } });
    // 序列契约：block-start → delta(s) → block-end → usage → finish（usage 先于 finish）
    expect(chunks[0]?.type).toBe('block-start');
    expect(chunks[chunks.length - 1]?.type).toBe('finish');
    expect(chunks[chunks.length - 2]?.type).toBe('usage');

    // DSH 真件组装（agent loop 权威算法）
    const assembler = new BlockAssembler();
    for (const chunk of chunks) assembler.push(chunk);
    const blocks = assembler.blocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('tool-call');
    expect(blocks[0]?.type === 'tool-call' ? blocks[0].arguments : '').toBe(JSON.stringify(STREAM_CONCLUSION));
    expect(assembler.usage).toEqual({ inputTokens: 9, outputTokens: 6, totalTokens: 15 });
    expect(assembler.finish.kind).toBe('stop');

    // 适配器从 DSH 组装结果提取的结论 = 原 structured
    expect(structuredFromBlocks(blocks).structured).toEqual(STREAM_CONCLUSION);

    // provider 端到端（真 BlockAssembler 懒加载链路）
    const provider = createDshStreamProvider({ face: createScriptedStreamFace({ structured: STREAM_CONCLUSION, viaToolCall: true }) });
    const run = await provider.start({
      orderId: 'ord-gate' as never,
      role: 'sidekick',
      prompt: [{ type: 'text', text: 'gate' }],
      outputSchema: {} as never,
      agentOptions: {} as never,
      toolFilter: [],
      maxDepth: 0,
      persona: '',
      parent: 'sess-gate' as never,
      inheritsParentContext: false,
    });
    const result = await run.result;
    expect(result.stopReason).toBe('completed');
    expect(result.structured).toEqual(STREAM_CONCLUSION);
  });

  it('expandAssistantStream 往返无损：scripted 序列可被 DSH 持久化词表复放', async () => {
    const chunks = await collectChunks({ structured: STREAM_CONCLUSION, viaToolCall: true });
    const accumulator = new AssistantStreamAccumulator();
    chunks.forEach((chunk, index) => accumulator.push({ time: 1000 + index, chunk }));
    const records = accumulator.snapshot();
    const expanded = expandAssistantStream(records);
    expect(expanded.map((timed) => timed.chunk)).toEqual(chunks);
    // 展开序列再喂真 BlockAssembler，组装结果不变
    const assembler = new BlockAssembler();
    for (const timed of expanded) assembler.push(timed.chunk);
    expect(structuredFromBlocks(assembler.blocks()).structured).toEqual(STREAM_CONCLUSION);
  });
});
// ── P5.4：工具直传 + cordis.yml 27 行一致性（DSH 宿主接管前的静态真面）──

describe('P5.4 任务池 9 工具直传 + cordis.yml 27 行一致性', () => {
  it('cordis.yml 全量层叠：27 行 id 唯一、name 与 workspace 包逐一对应（boot 真消费前提）', () => {
    // 仓库根：test/ → tda-harness → harness → 仓库根
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const yml = readFileSync(join(repoRoot, 'profiles', 'cordis.yml'), 'utf8');
    const rows = [...yml.matchAll(/- id:\s*([\w-]+)\n\s+name:\s*([\w-]+)/g)].map(
      (match) => ({ id: match[1]!, name: match[2]! }),
    );
    expect(rows).toHaveLength(27);
    expect(new Set(rows.map((row) => row.id)).size).toBe(27);
    expect(rows[0]?.id).toBe('tda-smoke');
    const missing: string[] = [];
    for (const row of rows) {
      const pkgDir = join(repoRoot, 'plugins', row.name);
      if (!existsSync(join(pkgDir, 'package.json'))) {
        missing.push(row.name);
        continue;
      }
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name: string };
      expect(pkg.name).toBe(row.name);
    }
    expect(missing).toEqual([]);
  });

  it('P5.5 profile 真消费：DSH 真 include 机器吃 cordis.yml（子进程 transform-types）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-p55-profile-'));
    const scenario = fileURLToPath(new URL('../testkit-p55/profile-consume.mjs', import.meta.url));
    const run = spawnSync(
      process.execPath,
      ['--experimental-transform-types', scenario, dir],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CI: '1' } },
    );
    const ok = run.status === 0 && (run.stdout ?? '').includes('P55-GATE-OK');
    try {
      expect(ok).toBe(true);
    } finally {
      if (!ok) {
        console.error(['P5.5 场景失败 exit='.concat(String(run.status)), run.stdout, run.stderr].join(String.fromCharCode(10)));
      }
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    }
  }, 90_000);

  it('子集门特征面完备 + 保留名 = run_code（DSH ToolRuntime.register 同语义）', () => {
    const features: [unknown, unknown][] = [
      [{ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x' }],
      [{ type: 'string' }, 'x'],
      [{ type: 'string', enum: ['a', 'b'] }, 'b'],
      [{ type: 'number' }, 1],
      [{ type: 'boolean' }, true],
      [{ type: 'array', items: { type: 'string' } }, ['x', 'y']],
    ];
    for (const [schema, value] of features) {
      expect(validateJsonSchemaSubset(schema, value, '')).toEqual([]);
    }
    expect(RUN_CODE_RESERVED_NAME).toBe('run_code');
    // registry 冒烟（真面可构造）
    const registry = createDshToolRegistry();
    expect(registry.list()).toEqual([]);
  });
});
