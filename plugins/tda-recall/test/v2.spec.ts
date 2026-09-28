/**
 * T2.4 recall v2 验收门（§6.1–§6.8）。
 *
 * 退化等价（验收 7 前半）由既有 T1.1 三门在 v1 默认下继续覆盖；
 * 本门验证 v2 增量行为：动量/情感/主动两路/gate 不削弱/动量复算。
 */
import { describe, expect, it } from 'vitest';
import { DAY, HOUR, NOW, setup, type FakeEntryInit } from './helpers.ts';

const V2_PARAMS = {
  scorerVersion: 'v2' as const,
  weights: { task: 0.35, recency: 0.15, semantic: 0.2, momentum: 0.2, emotion: 0.1 },
};

describe('T2.4 recall v2 验收门', () => {
  it('1. 动量效应可辨：v2 下 A（有召回史）排名高于 B（零召回）；v1 下无此行为', async () => {
    const entries: FakeEntryInit[] = [
      { id: 'tl-a', content: '灯环 动量候选甲', chunkType: 'method', relatedTaskId: 'task-1', createdAt: NOW - 2 * DAY },
      { id: 'tl-b', content: '灯环 动量候选乙', chunkType: 'method', relatedTaskId: 'task-1', createdAt: NOW - 2 * DAY },
    ];
    const fx = await setup({ entries, now: () => NOW });
    try {
      // 造 A 的召回史：注入 3 次（动量事件），B 零
      for (let i = 0; i < 3; i += 1) {
        await fx.service.logUse(['tl-a'], { taskId: 'task-1', sessionId: 'sess-recall' });
      }
      // v1：同龄同类同任务 → 分数只由 task/recency/semantic 决定，A/B 持平
      const v1 = await fx.service.recall({ text: '灯环', includeBelowMin: true, at: NOW });
      const scoreV1 = (id: string): number => v1.find((chunk) => chunk.entry.id === id)?.score ?? 0;
      expect(scoreV1('tl-a')).toBeCloseTo(scoreV1('tl-b'), 9);

      // v2：动量项生效，A > B
      await fx.service.setParams({ ...V2_PARAMS });
      const v2 = await fx.service.recall({ text: '灯环', includeBelowMin: true, at: NOW });
      const scoreV2 = (id: string): number => v2.find((chunk) => chunk.entry.id === id)?.score ?? 0;
      expect(scoreV2('tl-a')).toBeGreaterThan(scoreV2('tl-b'));
      const a = v2.find((chunk) => chunk.entry.id === 'tl-a')!;
      expect(a.momentumDetail).toBeDefined();
      expect(a.momentumDetail!.mFast).toBeGreaterThan(0);
    } finally {
      await fx.dispose();
    }
  });

  it('2. 邻域降级：EmbeddingProvider 缺席 → proximity=0.5 中性不报错，动量照常', async () => {
    const fx = await setup({
      entries: [{ id: 'tl-x', content: '灯环 邻域', chunkType: 'method', relatedTaskId: 'task-1', createdAt: NOW - HOUR }],
      now: () => NOW,
    });
    try {
      await fx.service.setParams({ ...V2_PARAMS });
      // 造动量史（注入 + 使用），随后重查
      await fx.service.injectCandidates({ sessionId: 'sess-recall' }, 1);
      await fx.service.logUse(['tl-x'], { taskId: 'task-1', sessionId: 'sess-recall' });
      const chunks = await fx.service.recall({ text: '灯环', taskId: 'task-1', includeBelowMin: true, at: NOW });
      const chunk = chunks.find((item) => item.entry.id === 'tl-x')!;
      expect(chunk.momentumDetail!.attentionProximity).toBe(0.5);
      expect(chunk.parts.momentum).toBeGreaterThan(0);
    } finally {
      await fx.dispose();
    }
  });

  it('3. 情感资格分流：user-original 计分上升；model-produced 恒 0 且 emotionApplied=false', async () => {
    const fx = await setup({
      entries: [
        { id: 'tl-user', content: '灯环 情感甲', chunkType: 'fact', credential: 'user-original', emotionWeight: 0.9, relatedTaskId: 'task-1', createdAt: NOW - DAY },
        { id: 'tl-model', content: '灯环 情感乙', chunkType: 'fact', credential: 'model-produced', emotionWeight: 0.9, confidence: 0.95, relatedTaskId: 'task-1', createdAt: NOW - DAY },
      ],
      now: () => NOW,
    });
    try {
      await fx.service.setParams({ ...V2_PARAMS });
      const chunks = await fx.service.recall({ text: '灯环', taskId: 'task-1', includeBelowMin: true, at: NOW });
      const user = chunks.find((chunk) => chunk.entry.id === 'tl-user')!;
      const model = chunks.find((chunk) => chunk.entry.id === 'tl-model')!;
      expect(user.parts.emotion).toBeCloseTo(0.9, 9);
      expect(model.parts.emotion).toBe(0);
      // 落库值保留可审计（条目视图），但计分取 0
      expect(model.entry.emotionWeight).toBe(0.9);
      // emotionApplied 审计标注
      const logRows = fx.service.log();
      expect(logRows.find((row) => row.entryId === 'tl-user')?.emotionApplied).toBe(true);
      expect(logRows.find((row) => row.entryId === 'tl-model')?.emotionApplied).toBe(false);
    } finally {
      await fx.dispose();
    }
  });

  it('4. 主动阶段召回：strategicBrief 三帽（条数/token/结构）+ trigger=active-stage 留痕', async () => {
    const fx = await setup({
      entries: Array.from({ length: 8 }, (_, i): FakeEntryInit => ({
        id: `tl-v${i}`,
        content: `灯环 verifying 验证清单条目 ${i} 校验方法`,
        chunkType: 'method',
        relatedTaskId: 'task-1',
        createdAt: NOW - i * HOUR,
      })),
      now: () => NOW,
    });
    try {
      await fx.service.setParams({ ...V2_PARAMS, strategic: { maxItems: 3, tokenCap: 400, shareFraction: 0.34 } });
      const brief = await fx.service.strategicBrief('task-1', 'verifying');
      expect(brief.taskId).toBe('task-1');
      expect(brief.toStage).toBe('verifying');
      expect(brief.items.length).toBeLessThanOrEqual(3);
      expect(brief.tokensEst).toBeLessThanOrEqual(400);
      const logRows = fx.service.log({ entryId: 'tl-v0' });
      expect(logRows.some((row) => row.trigger === 'active-stage')).toBe(true);
    } finally {
      await fx.dispose();
    }
  });

  it('5. 主动工具路：trigger=active-tool 同 gate 同留痕', async () => {
    const fx = await setup({
      entries: [{ id: 'tl-tool', content: '灯环 工具查询', chunkType: 'fact', relatedTaskId: 'task-1', createdAt: NOW - DAY }],
      now: () => NOW,
    });
    try {
      const chunks = await fx.service.recall({ text: '灯环', trigger: 'active-tool', at: NOW });
      expect(chunks.length).toBe(1);
      expect(fx.service.log({ entryId: 'tl-tool' }).every((row) => row.trigger === 'active-tool')).toBe(true);
    } finally {
      await fx.dispose();
    }
  });

  it('6. gate 不削弱（安全主项）：高情感+高动量的中毒条目在 v2 任何路不浮现', async () => {
    const fx = await setup({
      entries: [
        { id: 'tl-poison', content: '灯环 中毒', chunkType: 'fact', credential: 'tool-output', emotionWeight: 1.0, relatedTaskId: 'task-1', createdAt: NOW },
        { id: 'tl-clean', content: '灯环 executing 干净', chunkType: 'fact', credential: 'execution-verified', relatedTaskId: 'task-1', createdAt: NOW },
      ],
      now: () => NOW,
    });
    try {
      await fx.service.setParams({ ...V2_PARAMS });
      // 先给毒条目造动量史
      for (let i = 0; i < 3; i += 1) {
        await fx.service.logUse(['tl-poison'], { taskId: 'task-1', sessionId: 'sess-recall' });
      }
      void V2_PARAMS;
      // 被动查询路
      const passive = await fx.service.recall({ text: '灯环', includeBelowMin: true, at: NOW });
      expect(passive.find((chunk) => chunk.entry.id === 'tl-poison')).toBeUndefined();
      // 主动工具路
      const active = await fx.service.recall({ text: '灯环', trigger: 'active-tool', includeBelowMin: true, at: NOW });
      expect(active.find((chunk) => chunk.entry.id === 'tl-poison')).toBeUndefined();
      // 主动阶段路
      const brief = await fx.service.strategicBrief('task-1', 'executing');
      expect(brief.items.some((chunk) => chunk.entry.id === 'tl-poison')).toBe(false);
      expect(brief.items.some((chunk) => chunk.entry.id === 'tl-clean')).toBe(true);
    } finally {
      await fx.dispose();
    }
  });

  it('7. 退化等价：v1 下 emotion/momentum 部分恒 0（CI 回归由 T1.1 三门承担）', async () => {
    const fx = await setup({
      entries: [{ id: 'tl-eq', content: '灯环 等价', chunkType: 'fact', relatedTaskId: 'task-1', createdAt: NOW - DAY }],
      now: () => NOW,
    });
    try {
      const chunks = await fx.service.recall({ text: '灯环', includeBelowMin: true, at: NOW });
      const chunk = chunks[0]!;
      expect(chunk.parts.momentum ?? 0).toBe(0);
      expect(chunk.parts.emotion ?? 0).toBe(0);
      expect(chunk.momentumDetail).toBeUndefined();
      // v1 强约束：切权重不归零 → 参数非法
      await expect(
        fx.service.setParams({ weights: { task: 0.4, recency: 0.2, semantic: 0.3, momentum: 0.1, emotion: 0 } }),
      ).rejects.toMatchObject({ code: 'RECALL_PARAMS_INVALID' });
    } finally {
      await fx.dispose();
    }
  });

  it('8. 动量可复算：从 recall_log 独立重算 momentum 与记录值一致（不变量 3）', async () => {
    const fx = await setup({
      entries: [{ id: 'tl-m', content: '灯环 复算', chunkType: 'method', relatedTaskId: 'task-1', createdAt: NOW - DAY }],
      now: () => NOW,
    });
    try {
      await fx.service.setParams({ ...V2_PARAMS });
      // 两轮注入 + 一轮使用
      await fx.service.recall({ text: '灯环', at: NOW - HOUR }); // 被动查询（无 injected）
      const { injectCandidates } = fx.service;
      await injectCandidates({ sessionId: 'sess-recall' }, 1);
      await injectCandidates({ sessionId: 'sess-recall' }, 2);
      await fx.service.logUse(['tl-m'], { taskId: 'task-1', sessionId: 'sess-recall' });

      const chunks = await fx.service.recall({ text: '灯环', includeBelowMin: true, at: NOW });
      const chunk = chunks.find((item) => item.entry.id === 'tl-m')!;
      expect(chunk.momentumDetail).toBeDefined();

      // 独立复算：手工收集事件（injected 1.0 ×2 + used 2.0 ×1）按双尺度衰减
      const events = [
        { at: NOW, weight: 1.0 },
        { at: NOW, weight: 1.0 },
        { at: NOW, weight: 2.0 },
      ];
      const tauFast = 2 * 3_600_000;
      const tauSlow = 7 * 86_400_000;
      const fast = events.reduce((sum, event) => sum + event.weight * Math.exp(-(NOW - event.at) / tauFast), 0);
      const slow = events.reduce((sum, event) => sum + event.weight * Math.exp(-(NOW - event.at) / tauSlow), 0);
      const saturated = Math.tanh((0.6 * fast + 0.4 * slow) / 5);
      const expected = saturated * (0.3 + 0.7 * 0.5);
      expect(chunk.parts.momentum).toBeCloseTo(expected, 6);
    } finally {
      await fx.dispose();
    }
  });
});
