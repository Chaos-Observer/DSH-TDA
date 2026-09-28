/**
 * tda-context 冒烟门（门4 test:smoke）：T0.4 验收 1–6 载体。
 *
 *  1. **G0-④**：pressure 与 context-overflow 双档触发后，pinned 四类逐字节完整在场
 *  2. **G0-③**：任务切换 = pageOut 旧页 + pageIn 新页；换页后上下文含新任务页、
 *     底层时间线 seq 连续不变
 *  3. **KV-cache 友好**：同 focus 连续两轮组装前缀段逐字节相同；四区百分比生效
 *     （超区时 injection 先剥、pinned 不动）
 *  4. **双路径**：static 无 logprobs 独立完成全流程；perplexity 过滤 -9999.0、
 *     采样失败自动降级
 *  5. **可审计**：任取历史轮次可从 session log 重建 AssembleRecord
 *  6. pinned 数据源变更在下一轮 assemble 生效（无过期窗口）
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJsonBackend, openTdaDomain, type TdaDomain } from '@tda/kernel';
import {
  SENTINEL_LOGPROB,
  contextDomainSpec,
  createContextService,
  createMemorySurface,
  filterSentinels,
  type AssembleRecord,
  type ContextConfig,
  type ContextService,
  type ContextTables,
  type PinInput,
  type SurfaceMessage,
} from '../src/index.ts';
import { createFakeGoalSeam, createFakeTaskSeam, createFakeTimeline, createMemorySink, goalView, taskView } from './helpers.ts';

const ALL_PINS: PinInput[] = [
  { kind: 'goal', sourceKind: 'goalTree.focus', sourceRef: 'focus', maxTokens: 256 },
  { kind: 'criteria', sourceKind: 'goalTree.focus', sourceRef: 'focus', maxTokens: 256 },
  { kind: 'constraint', sourceKind: 'constraint_snapshots', sourceRef: 'focus', maxTokens: 256 },
  { kind: 'safety', sourceKind: 'config.safety', sourceRef: 'config', maxTokens: 256 },
];

const historyMessages = (count: number, pageId?: string): SurfaceMessage[] =>
  Array.from({ length: count }, (_unused, index) => ({
    seq: index + 1,
    role: index % 3 === 0 ? 'user' : 'assistant',
    content: `第 ${index + 1} 轮对话内容：${'长文本'.repeat(20)}`,
    ...(pageId !== undefined ? { pageId } : {}),
    pairBoundary: index % 2 === 1,
  }));

interface Fixture {
  readonly service: ContextService;
  readonly domain: TdaDomain<ContextTables>;
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly surface: ReturnType<typeof createMemorySurface>;
  readonly goal: ReturnType<typeof createFakeGoalSeam>;
  readonly tasks: ReturnType<typeof createFakeTaskSeam>;
  readonly timeline: ReturnType<typeof createFakeTimeline>;
  dispose(): Promise<void>;
}

async function setup(options: {
  readonly pins?: readonly PinInput[];
  readonly config?: ContextConfig;
  readonly messages?: readonly SurfaceMessage[];
  readonly pressure?: () => { readonly level: 'none' | 'pressure' | 'overflow'; readonly seqs?: readonly number[] } | undefined;
  readonly injection?: () => readonly { readonly id: string; readonly text: string }[];
  readonly decisions?: () => readonly string[];
  readonly goal?: ReturnType<typeof createFakeGoalSeam>;
  readonly tasks?: ReturnType<typeof createFakeTaskSeam>;
  readonly withTimeline?: boolean;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-ctx-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(contextDomainSpec, { backend });
  const sink = createMemorySink();
  const surface = createMemorySurface({
    messages: options.messages ?? [],
    ...(options.pressure !== undefined ? { pressure: options.pressure } : {}),
  });
  const goal = options.goal ?? createFakeGoalSeam();
  const tasks = options.tasks ?? createFakeTaskSeam();
  const timeline = createFakeTimeline();
  const now = 1_700_000_000_000;
  const service = createContextService({
    domain,
    session: sink,
    surface,
    goalSeam: goal.seam,
    taskSeam: tasks.seam,
    ...(options.withTimeline === false ? {} : { timeline: timeline.seam }),
    ...(options.injection !== undefined ? { injection: options.injection } : {}),
    ...(options.decisions !== undefined ? { decisions: options.decisions } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    now: () => now,
  });
  for (const pin of options.pins ?? ALL_PINS) await service.pin('scheduler', pin);
  return {
    service,
    domain,
    sink,
    surface,
    goal,
    tasks,
    timeline,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

const pinnedTexts = (fx: Fixture): string[] =>
  fx.service
    .promptSection()
    .content.split('\n')
    .filter((line) => line !== '');

describe('T0.4 pinned 豁免绝对化（验收 1，G0-④）', () => {
  it('pressure 与 context-overflow 双档触发后，pinned 四类逐字节完整在场', async () => {
    let pressure: { level: 'none' | 'pressure' | 'overflow'; seqs?: readonly number[] } = { level: 'none' };
    const fx = await setup({
      messages: historyMessages(24),
      pressure: () => pressure,
      config: { totalBudgetTokens: 600 },
    });
    try {
      const base = await fx.service.assemble(1);
      const pinnedBase = base.segments.filter((segment) => segment.kind === 'pinned').map((segment) => segment.text);
      expect(pinnedBase).toHaveLength(4);

      pressure = { level: 'pressure', seqs: [1, 2, 3, 4, 5, 6] };
      const pressurized = await fx.service.assemble(2);
      expect(pressurized.record.shadowed.reason).toBe('pressure');
      expect(pressurized.record.shadowed.seqs).toEqual([1, 2, 3, 4, 5, 6]);

      pressure = { level: 'overflow', seqs: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] };
      const overflowed = await fx.service.assemble(3);
      expect(overflowed.record.shadowed.reason).toBe('context-overflow');

      // C6 硬条款：任何条件下 pinned 逐字节完整在场
      for (const assembled of [pressurized, overflowed]) {
        const texts = assembled.segments.filter((segment) => segment.kind === 'pinned').map((segment) => segment.text);
        expect(texts).toEqual(pinnedBase);
        for (const text of pinnedBase) expect(assembled.text).toContain(text);
      }
      // 遮蔽只写回权威集，不删 surface；双档原因可归因（首轮 gate 的静态遮蔽在更早）
      expect(fx.surface.messages()).toHaveLength(24);
      expect(fx.surface.shadowedSeqs().length).toBeGreaterThan(0);
      // 第一轮：静态 gate 已按预算剥过 history
      expect(fx.surface.applied[0]?.reason).toBe('gate-static');
      expect(fx.surface.applied.slice(-2).map((entry) => entry.reason)).toEqual(['pressure', 'context-overflow']);
    } finally {
      await fx.dispose();
    }
  });

  it('pinned 超预算区也不被截断（只记录 overrun，剥夺不碰 pinned）', async () => {
    const fx = await setup({
      messages: historyMessages(30),
      config: { totalBudgetTokens: 200 },
      injection: () => [{ id: 'recall-1', text: '召回片段'.repeat(50) }],
    });
    try {
      const assembled = await fx.service.assemble(1);
      const pinned = assembled.segments.filter((segment) => segment.kind === 'pinned');
      expect(pinned).toHaveLength(4);
      expect(assembled.record.budget.overrun).toContain('pinned');
      // injection 先被剥
      expect(assembled.segments.some((segment) => segment.kind === 'injection')).toBe(false);
      expect(fx.surface.shadowedSeqs().length).toBeGreaterThan(0);
    } finally {
      await fx.dispose();
    }
  });

  it('单项帽超限即拒（PIN_RENDER_OVERFLOW：超帽=渲染器 bug）', async () => {
    const fx = await setup({ pins: [{ kind: 'goal', sourceKind: 'goalTree.focus', sourceRef: 'focus', maxTokens: 1 }] });
    try {
      await expect(fx.service.assemble(1)).rejects.toMatchObject({ code: 'PIN_RENDER_OVERFLOW' });
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.4 分页树换页（验收 2，G0-③）', () => {
  it('任务切换 = pageOut 旧页 + pageIn 新页；换页后含新任务页、时间线 seq 连续', async () => {
    const messages: SurfaceMessage[] = [
      { seq: 1, role: 'user', content: '任务一的上下文' },
      { seq: 2, role: 'assistant', content: '任务一的回答', pageId: 'task:task-1' },
      { seq: 3, role: 'user', content: '任务二的上下文' },
      { seq: 4, role: 'assistant', content: '任务二的回答', pageId: 'task:task-2' },
    ];
    const tasks = createFakeTaskSeam([taskView({ id: 'task-1', stage: 'executing' })]);
    const fx = await setup({ messages, tasks });
    try {
      const first = await fx.service.assemble(1);
      expect(first.text).toContain('任务一的回答');
      expect(first.text).not.toContain('任务二的回答');
      expect(fx.service.pages().find((page) => page.pageId === 'task:task-1')?.resident).toBe(true);

      // 会话切换 = 任务切换 = 换 page
      tasks.set([taskView({ id: 'task-2', stage: 'executing', subject: '读任务二' })]);
      const second = await fx.service.assemble(2);
      expect(second.text).toContain('任务二的回答');
      expect(second.text).not.toContain('任务一的回答');
      const pages = fx.service.pages();
      expect(pages.find((page) => page.pageId === 'task:task-2')?.resident).toBe(true);
      expect(pages.find((page) => page.pageId === 'task:task-1')?.resident).toBe(false);
      // 底层时间线只增不改：两轮各汇一条，id 连续
      expect(fx.timeline.chunks).toHaveLength(2);
      expect(fx.timeline.chunks.every((chunk) => chunk.source === 'conversation')).toBe(true);
      // 手动换页也走整段操作
      fx.service.pageIn('task:task-1');
      expect(fx.service.pages().find((page) => page.pageId === 'task:task-1')?.resident).toBe(true);
      fx.service.pageOut('task:task-1');
      expect(fx.service.pages().find((page) => page.pageId === 'task:task-1')?.resident).toBe(false);
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.4 KV-cache 友好与预算四区（验收 3）', () => {
  it('同 focus 连续两轮：system/pinned/memo 前缀逐字节相同', async () => {
    const fx = await setup({ messages: historyMessages(4), decisions: () => ['决定 A', '决定 B'] });
    try {
      const first = await fx.service.assemble(1);
      // 新增长尾对话（易变后缀），前缀不应受影响
      fx.surface.push({ seq: 5, role: 'user', content: '新增一轮提问' });
      const second = await fx.service.assemble(2);
      const stableKinds = new Set(['system', 'pinned', 'memo']);
      const prefixFirst = first.segments.filter((segment) => stableKinds.has(segment.kind));
      const prefixSecond = second.segments.filter((segment) => stableKinds.has(segment.kind));
      expect(prefixSecond.map((segment) => segment.text)).toEqual(prefixFirst.map((segment) => segment.text));
      expect(second.text.startsWith(prefixFirst.map((segment) => segment.text).join('\n\n'))).toBe(true);
      // 段序恒为 稳定前缀 → 易变后缀：system → pinned×4 → memo → history
      const kinds = second.segments.map((segment) => segment.kind);
      expect(kinds[0]).toBe('system');
      expect(kinds.slice(1, 5)).toEqual(['pinned', 'pinned', 'pinned', 'pinned']);
      expect(kinds[5]).toBe('memo');
      expect(kinds.indexOf('memo')).toBeLessThan(kinds.indexOf('history'));
    } finally {
      await fx.dispose();
    }
  });

  it('四区按百分比配比：预算/配比入记录，超区先剥 injection', async () => {
    const fx = await setup({
      messages: historyMessages(10),
      injection: () => [{ id: 'recall-1', text: '召回'.repeat(400) }],
      config: { totalBudgetTokens: 500 },
    });
    try {
      const assembled = await fx.service.assemble(1);
      expect(assembled.record.budget.pinnedPct).toBe(0.1);
      expect(assembled.record.budget.historyPct).toBe(0.6);
      expect(assembled.budget.caps.history).toBe(300);
      expect(assembled.budget.caps.injection).toBe(100);
      expect(assembled.gate.droppedSegmentIds).toContain('recall-1');
      expect(assembled.segments.some((segment) => segment.kind === 'injection')).toBe(false);
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.4 gate 双路径（验收 4）', () => {
  it('static 路径无 logprobs 亦可完成全流程', async () => {
    const fx = await setup({ messages: historyMessages(6) });
    try {
      const assembled = await fx.service.assemble(1);
      expect(assembled.gate.mode).toBe('static');
      expect(assembled.record.gate?.mode).toBe('static');
      expect(assembled.record.gate?.fallbackReason).toContain('static');
      expect(assembled.text.length).toBeGreaterThan(0);
    } finally {
      await fx.dispose();
    }
  });

  it('perplexity 路径：过滤 -9999.0 哨兵、采样失败自动降级 static', async () => {
    const fx = await setup({
      messages: historyMessages(6),
      config: { gateMode: 'perplexity' },
    });
    try {
      const sentinel = await fx.service.gateSample({
        tokens: [
          { token: 'ok', logprob: -0.1, top: [] },
          { token: 'sentinel', logprob: SENTINEL_LOGPROB, top: [] },
        ],
      });
      expect(filterSentinels({ tokens: [{ token: 'a', logprob: SENTINEL_LOGPROB, top: [] }] }).dropped).toBe(1);
      // 全部为哨兵 → 降级 static（机制不失效）
      const allSentinel = await fx.service.gateSample({
        tokens: [{ token: 'x', logprob: SENTINEL_LOGPROB, top: [] }],
      });
      expect(allSentinel.mode).toBe('static');
      expect(allSentinel.fallbackReason).toContain('哨兵');
      expect(sentinel.sampledTokens + allSentinel.sampledTokens).toBeGreaterThan(0);

      const real = await fx.service.gateSample({
        tokens: [
          { token: '第', logprob: -0.01, top: [] },
          { token: '轮', logprob: -0.02, top: [] },
        ],
      });
      expect(real.mode).toBe('perplexity');
      expect(real.sampledTokens).toBe(2);
      const assembled = await fx.service.assemble(1);
      expect(assembled.gate.mode).toBe('perplexity');
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.4 可审计与 pinned 同步（验收 5、6）', () => {
  it('任取历史轮次可从 session log 重建 AssembleRecord（model-visible⟺logged）', async () => {
    const fx = await setup({ messages: historyMessages(6) });
    try {
      await fx.service.assemble(1);
      await fx.service.assemble(2);
      const logged = fx.sink.events
        .filter((event) => event.family === 'context/assemble')
        .filter((event) => typeof event.payload.round === 'number')
        .map((event) => event.payload as unknown as AssembleRecord);
      expect(logged).toEqual(fx.service.records());
      for (const record of logged) {
        expect(record.segments.length).toBeGreaterThan(0);
        expect(record.budget.historyPct).toBe(0.6);
        expect(record.gate?.mode).toBeDefined();
      }
      // 每轮组装也汇入时间线（J8 双落点）
      expect(fx.timeline.chunks).toHaveLength(2);
      expect(fx.timeline.chunks[0]?.credential).toBe('execution-verified');
    } finally {
      await fx.dispose();
    }
  });

  it('pinned 数据源变更下一轮即生效（无过期窗口）；unpin 后即消失', async () => {
    const fx = await setup({ messages: historyMessages(2) });
    try {
      const first = await fx.service.assemble(1);
      expect(first.text).toContain('不得覆盖原始抓包数据');

      fx.goal.setConstraints(['变更后的约束：必须先脱敏']);
      const second = await fx.service.assemble(2);
      expect(second.text).toContain('变更后的约束：必须先脱敏');
      expect(second.text).not.toContain('不得覆盖原始抓包数据');

      const constraintPin = fx.service.pins().find((pin) => pin.kind === 'constraint');
      expect(constraintPin).toBeDefined();
      await fx.service.unpin('scheduler', constraintPin?.id as never, { expectedRevision: constraintPin?.revision ?? 0 });
      expect(fx.service.pins().some((pin) => pin.kind === 'constraint')).toBe(false);
      const third = await fx.service.assemble(3);
      expect(third.text).not.toContain('变更后的约束');
    } finally {
      await fx.dispose();
    }
  });

  it('promptSection 紧随 task:state，且与 assemble 的 pinned 段一致', async () => {
    const fx = await setup();
    try {
      const assembled = await fx.service.assemble(1);
      const section = fx.service.promptSection();
      expect(section.id).toBe('context:pinned');
      expect(section.order.after).toBe('task:state');
      expect(section.content.split('\n')).toEqual(pinnedTexts(fx));
      expect(assembled.segments.filter((segment) => segment.kind === 'pinned').map((segment) => segment.text)).toEqual(
        pinnedTexts(fx),
      );
    } finally {
      await fx.dispose();
    }
  });

  it('registerScorer 的计分器参与 gate 打分（T1.1 挂载点可用）', async () => {
    const fx = await setup({ messages: historyMessages(8), config: { totalBudgetTokens: 400 } });
    try {
      fx.service.registerScorer(() => 0);
      const assembled = await fx.service.assemble(1);
      expect(assembled.gate.droppedSegmentIds.length).toBeGreaterThan(0);
    } finally {
      await fx.dispose();
    }
  });

  it('页重建：无焦点页时 rebuildPages 从焦点目标/任务重来', async () => {
    const fx = await setup({ tasks: createFakeTaskSeam([taskView({ id: 'task-9' })]) });
    try {
      await fx.service.assemble(1);
      fx.service.rebuildPages();
      const pages = fx.service.pages();
      expect(pages.map((page) => page.pageId).sort()).toEqual(['goal:goal-1', 'task:task-9']);
      expect(pages.every((page) => page.resident)).toBe(true);
      void goalView;
    } finally {
      await fx.dispose();
    }
  });
});
