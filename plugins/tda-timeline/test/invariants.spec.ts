/**
 * tda-timeline 不变量门（门2 test:invariants）：两级注册，违规即抛 InvariantError。
 *
 *  - 合法数据：服务走 append/supersede/invalidate → current/history/search
 *    → 内核级（双写配对）+ 插件级（引用完整/计证复核/seq 无洞）全过
 *  - 引用完整：注入悬挂 supersedes → 拒；supersedes 指向 invalidation → 拒；
 *    自指 → schema put 即拒
 *  - 计证强约束（§5.2）：append tool-output/external-content → quarantine
 *    服务端恒 true（调用方无从指定）；注入 quarantine=false → put 即拒
 *  - 字段完备：chunk 缺 chunkType / invalidation 缺 invalidates / invalidation
 *    携 chunkType → put 即拒
 *  - seq 无洞：注入跳号（tl-1/tl-3）→ 拒
 *  - 服务预检：supersede/invalidate 目标不存在 → ENTRY_NOT_FOUND；目标为
 *    invalidation → NOT_A_CHUNK（fail-loud，无半套）
 *  - 当前视图/历史链：supersede 后 current 不含旧、history 含完整链；
 *    并发双 supersede 全记录（U4：P0 不拒绝，冲突裁定归 T1.2）
 *  - credentialMin 预筛：tool-output 在 model-produced 线下不可见（§6.3）
 *  - 混合检索：fts 命中 + 向量语义命中（跨语言）均浮现（§6.3）
 *  - 内核级联动：直写 timeline_entries 绕过双写 → 漏双写被内核门捕获
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
  createTdaInvariantRegistry,
  InvariantError,
  openTdaDomain,
  registerTdaInvariants,
  TDA_KERNEL_PACKAGE,
  type TdaDomain,
  type TdaInvariantRegistry,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import { timelineDomainSpec, type TimelineEntry, type TimelineTables } from '../src/domain.ts';
import { createTimelineService, type TimelineService } from '../src/service.ts';
import { registerTimelineInvariants } from '../src/loadChecks.ts';

/** 内存 session sink（与内核单测同构；append 分配自增 seq）。 */
function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-inv'),
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
  readonly registry: TdaInvariantRegistry;
  readonly service: TimelineService;
}

/** 装配一套时间线插件运行时（域 + 双写对账 + 两级不变量注册 + 服务）。 */
async function assemble(dir: string): Promise<Rig> {
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const registry = createTdaInvariantRegistry();
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
  // 两级注册：内核级（@tda/kernel）+ 插件级（tda-timeline）
  registerTdaInvariants(registry, reconciler);
  registerTimelineInvariants(registry, domain);
  const service = createTimelineService({
    domain,
    session: createMemorySink(),
    reconciler,
    index: createAuditIndex(),
  });
  return { dir, backend, domain, registry, service };
}

async function teardown(rig: Rig): Promise<void> {
  await rig.domain.close();
  await rig.backend.close();
  // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', rig.dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

/** 合法 TimelineEntry 基件（注入用例用；zod 合法、引用/序列违规）。 */
const baseEntry = (id: string, over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: asEntryId(id),
  kind: 'chunk',
  content: `内容 ${id}`,
  chunkType: 'fact',
  source: 'conversation',
  credential: 'model-produced',
  quarantine: false,
  writer: { sessionId: 'sess-inv', actor: 'agent', at: 1 },
  createdAt: 1,
  ...over,
});

/** 合法 invalidation 基件（无 chunkType——字段完备律的反面构造用原始字面量）。 */
const baseInvalidation = (id: string, invalidates: string, over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: asEntryId(id),
  kind: 'invalidation',
  content: `作废 ${invalidates}`,
  source: 'conversation',
  credential: 'model-produced',
  quarantine: false,
  invalidates: asEntryId(invalidates),
  writer: { sessionId: 'sess-inv', actor: 'agent', at: 1 },
  createdAt: 1,
  ...over,
});

const agentWriter = { sessionId: 'sess-inv', actor: 'agent', at: 1 } as const;

describe('tda-timeline 不变量门', () => {
  it('合法数据：服务全路径（append/supersede/invalidate/search）→ 两级不变量全过', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-ok-')));
    try {
      const first = await rig.service.append(agentWriter, {
        content: '预算守恒是树不变量之一',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'user-original',
      });
      const second = await rig.service.append(agentWriter, {
        content: '本周聚焦目标树施工',
        chunkType: 'fact',
        source: 'task',
        credential: 'user-original',
      });
      const replacement = await rig.service.supersede(
        agentWriter,
        first.id,
        { content: '预算守恒是树不变量（修订版）', chunkType: 'fact', source: 'conversation', credential: 'user-original' },
        '补充表述',
      );
      const voided = await rig.service.invalidate(agentWriter, second.id, '计划改期');
      expect(voided.kind).toBe('invalidation');
      // 当前视图：旧两条已出，修订版在
      const current = rig.service.current();
      expect(current.map((entry) => entry.id)).toEqual([replacement.id]);
      // 历史链：起源 + 更正（按 seq 正序）
      expect(rig.service.history(first.id).map((entry) => entry.id)).toEqual([first.id, replacement.id]);
      expect(rig.service.history(second.id).map((entry) => entry.id)).toEqual([second.id, voided.id]);
      // 检索：当前视图内可命中
      expect(rig.service.search({ text: '预算守恒' }).map((hit) => hit.entry.id)).toEqual([replacement.id]);
      await expect(rig.registry.verify()).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('引用完整：注入悬挂 supersedes → 拒绝', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-dangling-')));
    try {
      await rig.domain.table('timeline_entries').put('tl-1', baseEntry('tl-1'));
      await rig.domain
        .table('timeline_entries')
        .put('tl-2', baseEntry('tl-2', { supersedes: asEntryId('tl-99') }));
      await expect(rig.registry.verify('tda-timeline')).rejects.toBeInstanceOf(InvariantError);
      await expect(rig.registry.verify('tda-timeline')).rejects.toThrow(/不存在/);
    } finally {
      await teardown(rig);
    }
  });

  it('引用完整：supersedes 指向 invalidation 记录 → 拒绝', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-inv-target-')));
    try {
      await rig.domain.table('timeline_entries').put('tl-1', baseEntry('tl-1'));
      await rig.domain.table('timeline_entries').put('tl-2', baseInvalidation('tl-2', 'tl-1'));
      await rig.domain
        .table('timeline_entries')
        .put('tl-3', baseEntry('tl-3', { supersedes: asEntryId('tl-2') }));
      await expect(rig.registry.verify('tda-timeline')).rejects.toThrow(/invalidation/);
    } finally {
      await teardown(rig);
    }
  });

  it('引用完整：自指 → put 即拒（schema 恒等律）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-self-')));
    try {
      await expect(
        rig.domain.table('timeline_entries').put('tl-1', baseEntry('tl-1', { supersedes: asEntryId('tl-1') })),
      ).rejects.toThrow(/自指/);
      await expect(
        rig.domain.table('timeline_entries').put('tl-2', baseInvalidation('tl-2', 'tl-2')),
      ).rejects.toThrow(/自指/);
    } finally {
      await teardown(rig);
    }
  });

  it('计证强约束：tool-output / external-content 写入 quarantine 恒 true（服务端强制）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-quarantine-')));
    try {
      // 服务路径：调用方无从指定 quarantine——低凭证恒 true
      const toolOut = await rig.service.append(agentWriter, {
        content: '工具返回：磁盘扫描完成，可释放 3.2GB',
        chunkType: 'fact',
        source: 'task',
        credential: 'tool-output',
      });
      expect(toolOut.quarantine).toBe(true);
      const external = await rig.service.append(agentWriter, {
        content: '外部网页摘录：某库发布新版本',
        chunkType: 'fact',
        source: 'study',
        credential: 'external-content',
      });
      expect(external.quarantine).toBe(true);
      // 高凭证不强制检疫
      const original = await rig.service.append(agentWriter, {
        content: '用户原话：先把 IT1 收尾',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'user-original',
      });
      expect(original.quarantine).toBe(false);
      // 注入场景：低凭证 + quarantine=false → put 即拒（schema 层）
      await expect(
        rig.domain
          .table('timeline_entries')
          .put('tl-9', baseEntry('tl-9', { credential: 'tool-output', quarantine: false })),
      ).rejects.toThrow(/quarantine=true/);
      await expect(rig.registry.verify()).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('字段完备：chunk 缺 chunkType / invalidation 缺 invalidates / invalidation 携 chunkType → put 即拒', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-fields-')));
    try {
      // 反例构造用原始字面量（exactOptionalPropertyTypes 下不能显式传 undefined）
      const writer = { sessionId: 'sess-inv', actor: 'agent', at: 1 };
      await expect(
        rig.domain.table('timeline_entries').put('tl-1', {
          id: asEntryId('tl-1'),
          kind: 'chunk',
          content: '无 chunkType',
          source: 'conversation',
          credential: 'model-produced',
          quarantine: false,
          writer,
          createdAt: 1,
        } as TimelineEntry),
      ).rejects.toThrow(/必填 chunkType/);
      await expect(
        rig.domain.table('timeline_entries').put('tl-2', {
          id: asEntryId('tl-2'),
          kind: 'invalidation',
          content: '缺 invalidates',
          source: 'conversation',
          credential: 'model-produced',
          quarantine: false,
          writer,
          createdAt: 1,
        } as TimelineEntry),
      ).rejects.toThrow(/必填 invalidates/);
      await expect(
        rig.domain.table('timeline_entries').put('tl-3', {
          id: asEntryId('tl-3'),
          kind: 'invalidation',
          content: '携 chunkType',
          chunkType: 'fact',
          source: 'conversation',
          credential: 'model-produced',
          quarantine: false,
          invalidates: asEntryId('tl-1'),
          writer,
          createdAt: 1,
        } as TimelineEntry),
      ).rejects.toThrow(/不得携带 chunkType/);
    } finally {
      await teardown(rig);
    }
  });

  it('seq 无洞：注入跳号（tl-1/tl-3）→ 拒绝', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-seq-')));
    try {
      await rig.domain.table('timeline_entries').put('tl-1', baseEntry('tl-1'));
      await rig.domain.table('timeline_entries').put('tl-3', baseEntry('tl-3'));
      await expect(rig.registry.verify('tda-timeline')).rejects.toThrow(/空洞|重号/);
    } finally {
      await teardown(rig);
    }
  });

  it('服务预检：supersede/invalidate 目标不存在或非 chunk → fail-loud 无半套', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-precheck-')));
    try {
      const entry = await rig.service.append(agentWriter, {
        content: '甲事实',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'user-original',
      });
      const voided = await rig.service.invalidate(agentWriter, entry.id, '过时');
      // 目标不存在
      await expect(
        rig.service.supersede(
          agentWriter,
          asEntryId('tl-99'),
          { content: 'x', chunkType: 'fact', source: 'conversation', credential: 'user-original' },
          'r',
        ),
      ).rejects.toThrow(/ENTRY_NOT_FOUND|不存在/);
      await expect(rig.service.invalidate(agentWriter, asEntryId('tl-99'), 'r')).rejects.toThrow(/ENTRY_NOT_FOUND|不存在/);
      // 目标为 invalidation 记录（不变量 2）
      await expect(
        rig.service.supersede(
          agentWriter,
          voided.id,
          { content: 'x', chunkType: 'fact', source: 'conversation', credential: 'user-original' },
          'r',
        ),
      ).rejects.toThrow(/NOT_A_CHUNK|invalidation/);
      await expect(rig.service.invalidate(agentWriter, voided.id, 'r')).rejects.toThrow(/NOT_A_CHUNK|invalidation/);
      // 空理由拒
      await expect(
        rig.service.supersede(
          agentWriter,
          entry.id,
          { content: 'x', chunkType: 'fact', source: 'conversation', credential: 'user-original' },
          '  ',
        ),
      ).rejects.toThrow(/EMPTY_REASON|理由/);
      // 预检失败未落任何新记录（仍只有 append + invalidate 两条）
      expect(rig.service.current()).toHaveLength(0);
      await expect(rig.registry.verify()).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('当前视图与历史链：并发双 supersede 全记录（U4：P0 不拒绝）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-concurrent-')));
    try {
      const origin = await rig.service.append(agentWriter, {
        content: '初版结论',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'user-original',
      });
      const [alpha, beta] = await Promise.all([
        rig.service.supersede(
          agentWriter,
          origin.id,
          { content: '甲更正', chunkType: 'fact', source: 'conversation', credential: 'user-original' },
          '甲路',
        ),
        rig.service.supersede(
          agentWriter,
          origin.id,
          { content: '乙更正', chunkType: 'fact', source: 'conversation', credential: 'user-original' },
          '乙路',
        ),
      ]);
      // 并发 supersede 允许且全记录：两条更正都在，起源出当前视图
      const current = rig.service.current();
      expect(current.map((entry) => entry.id).sort()).toEqual([alpha.id, beta.id].sort());
      expect(rig.service.history(origin.id)).toHaveLength(3);
      await expect(rig.registry.verify()).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('credentialMin 预筛：tool-output 在 model-produced 线下不可见（§6.3）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-credmin-')));
    try {
      await rig.service.append(agentWriter, {
        content: '用户原话：先跑门禁',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'user-original',
      });
      await rig.service.append(agentWriter, {
        content: '工具返回：扫描完成',
        chunkType: 'fact',
        source: 'task',
        credential: 'tool-output',
      });
      const visible = rig.service.current({ credentialMin: 'model-produced' });
      expect(visible).toHaveLength(1);
      expect(visible[0]?.credential).toBe('user-original');
      // 不设预筛时检疫条目仍可读（治理归 T1.2，U3）
      expect(rig.service.current()).toHaveLength(2);
      // 检索侧同样预筛
      expect(rig.service.search({ text: '扫描', credentialMin: 'model-produced' })).toHaveLength(0);
      expect(rig.service.search({ text: '扫描' })).toHaveLength(1);
    } finally {
      await teardown(rig);
    }
  });

  it('混合检索：fts 关键词命中 + 向量语义命中（跨语言）均浮现', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-hybrid-')));
    try {
      await rig.service.append(agentWriter, {
        content: '预算守恒是树不变量',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'user-original',
        vector: [1, 0],
      });
      await rig.service.append(agentWriter, {
        content: '今天天气很好',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'user-original',
        vector: [0, 1],
      });
      await rig.service.append(agentWriter, {
        content: '预算与天气都聊一点',
        chunkType: 'fact',
        source: 'conversation',
        credential: 'user-original',
        vector: [0.6, 0.8],
      });
      // 纯 fts：命中两条含"预算"的
      const ftsHits = rig.service.search({ text: '预算', mode: 'fts' });
      expect(ftsHits).toHaveLength(2);
      // 纯向量：查询向量朝"天气"方向——语义命中无关键词交集的条目（跨语言场景）
      const vectorHits = rig.service.search({ vector: [0, 1], mode: 'vector' });
      expect(vectorHits.map((hit) => hit.entry.content)).toContain('今天天气很好');
      // hybrid：fts 命中 + 向量命中并集，双通道都中的排最前
      const hybridHits = rig.service.search({ text: '预算', vector: [0, 1], mode: 'hybrid' });
      expect(hybridHits.length).toBeGreaterThanOrEqual(3);
      expect(hybridHits[0]?.entry.content).toBe('预算与天气都聊一点');
    } finally {
      await teardown(rig);
    }
  });

  it('内核级联动：直写 timeline_entries 绕过双写 → 漏双写被内核门捕获', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-tl-inv-leak-')));
    try {
      await rig.domain.table('timeline_entries').put('tl-7', baseEntry('tl-7'));
      await expect(rig.registry.verify(TDA_KERNEL_PACKAGE)).rejects.toBeInstanceOf(InvariantError);
      await expect(rig.registry.verify(TDA_KERNEL_PACKAGE)).rejects.toThrow(/漏双写/);
    } finally {
      await teardown(rig);
    }
  });
});
