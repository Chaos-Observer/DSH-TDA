/**
 * tda-predictor 冒烟门（门4 test:smoke）：T1.3 §6 验收 1–8 逐条。
 */
import { describe, expect, it } from 'vitest';
import { BASE_AT, createMemoryHost, seedFailureHistory, setup } from './helpers.ts';

describe('T1.3 §6 验收', () => {
  it('1. G1-④ 风险可观测可用：历史 timeout 模式 → riskFlags + 注入 → observe 记 deltaKind', async () => {
    const host = createMemoryHost();
    seedFailureHistory(host, 3);
    const fx = await setup({ host });
    try {
      const report = await fx.service.extract(host);
      // 一轮历史 = tool-call + turn-close 两条（J1 四类里的两类）
      expect(report.extracted).toBe(6);

      const prediction = await fx.service.predict({ session: host, round: 3 });
      expect(prediction).not.toBeNull();
      expect(prediction?.nextAction).toBe('edit:write');
      expect(prediction?.riskFlags.map((flag) => flag.errorClass)).toContain('timeout');
      expect(prediction?.confidence).toBeGreaterThanOrEqual(fx.service.params().thetaPredict);
      expect(prediction?.injected).toBe(true);

      // 注入候选（T0.4 拉取面）+ 文本必带"非事实"标注（J6）
      const candidates = await fx.service.injectCandidates({ sessionId: host.sessionId }, 3);
      expect(candidates.map((item) => String(item.id))).toContain(String(prediction?.id));
      expect(fx.service.renderText(prediction!)).toContain('预测');
      expect(fx.service.renderText(prediction!)).toContain('非既成事实');

      // 本轮真的踩了同一个坑 → risk-materialized
      host.turn(BASE_AT + 100_000);
      host.tool({ turn: 3, tool: 'edit', argClass: 'write', status: 'failure', errorClass: 'timeout' }, BASE_AT + 101_000);
      host.close(3, 'failed', BASE_AT + 102_000);
      const mismatch = await fx.service.observe(String(prediction?.id), host);
      expect(mismatch?.deltaKind).toBe('risk-materialized');
      expect(mismatch?.actual.errorClass).toBe('timeout');
    } finally {
      await fx.dispose();
    }
  });

  it('1b. 实际成功 → deltaKind=outcome（动作对了但结果不符预测分布）', async () => {
    const host = createMemoryHost();
    seedFailureHistory(host, 3);
    const fx = await setup({ host });
    try {
      await fx.service.extract(host);
      const prediction = await fx.service.predict({ session: host, round: 3 });
      host.turn(BASE_AT + 100_000);
      host.tool({ turn: 3, tool: 'edit', argClass: 'write', status: 'success' }, BASE_AT + 101_000);
      host.close(3, 'success', BASE_AT + 102_000);
      const mismatch = await fx.service.observe(String(prediction?.id), host);
      expect(mismatch?.deltaKind).toBe('outcome');
    } finally {
      await fx.dispose();
    }
  });

  it('2. 低置信不注入：弱相似 → 不返回候选，但 predictions 仍有记录（双轨自检）', async () => {
    const host = createMemoryHost();
    // 只有一条"同 stage 但不同任务/动作"的历史 → 相似度仅来自 state 分量
    const turn = host.turn(BASE_AT);
    host.tool({ turn, tool: 'read', argClass: 'read', status: 'success' }, BASE_AT + 1000);
    host.close(turn, 'success', BASE_AT + 2000);
    const fx = await setup({ host });
    try {
      await fx.service.extract(host);
      const prediction = await fx.service.predict({ session: host, round: 1 });
      expect(prediction).not.toBeNull();
      expect(prediction?.confidence).toBeLessThan(fx.service.params().thetaPredict);
      expect(prediction?.injected).toBe(false);
      const candidates = await fx.service.injectCandidates({ sessionId: host.sessionId }, 1);
      expect(candidates).toEqual([]);
      // 双轨：旁路记录仍在（coach 信号密度不塌陷）
      expect(fx.service.predictions({ round: 1 })).toHaveLength(1);
    } finally {
      await fx.dispose();
    }
  });

  it('3. 抽取正确性：四类各若干 + context/assemble 零抽取', async () => {
    const host = createMemoryHost();
    const t0 = host.turn(BASE_AT);
    host.tool({ turn: t0, tool: 'edit', argClass: 'write', status: 'failure', errorClass: 'timeout' }, BASE_AT + 1000);
    host.append({
      family: 'dispatch/change',
      businessId: 'dispatch-1',
      payload: {
        id: 'dispatch-1',
        taskId: 'task-1',
        goalId: 'goal-1',
        role: 'sidekick',
        status: 'settled',
        result: { outcome: 'conclusion' },
      },
    });
    // 注入类事件：J1 明义不抽取
    host.append({ family: 'context/assemble', businessId: 'sess:1', payload: { round: 1 } });
    // 任务态迁移：planning → executing 产一条，executing → executing 不产
    for (const stage of ['planning', 'executing', 'executing']) {
      host.append({
        family: 'taskPool/change',
        businessId: 'task-1',
        payload: { id: 'task-1', goalId: 'goal-1', phase: 'active', stage },
      });
    }
    host.close(t0, 'success', BASE_AT + 9000);

    const fx = await setup({ host });
    try {
      const report = await fx.service.extract(host);
      expect(report.extracted).toBe(4);
      expect(report.skipped).toBe(1); // context/assemble 被刻意跳过并计数
      const kinds = fx.service.transitions().map((transition) => transition.kind).sort();
      expect(kinds).toEqual(['dispatch', 'task-transition', 'tool-call', 'turn-close']);
      const taskTransition = fx.service.transitions({ kind: 'task-transition' })[0];
      expect(taskTransition?.action.fromStage).toBe('planning');
      expect(taskTransition?.action.toStage).toBe('executing');
      const dispatch = fx.service.transitions({ kind: 'dispatch' })[0];
      expect(dispatch?.action.role).toBe('sidekick');
      expect(dispatch?.outcome.status).toBe('success');
      // seq 范围与来源自洽
      for (const transition of fx.service.transitions()) {
        expect(transition.source.seqTo).toBeGreaterThanOrEqual(transition.source.seqFrom);
        expect(transition.source.sessionId).toBe(host.sessionId);
      }
    } finally {
      await fx.dispose();
    }
  });

  it('4. 重建等价：重抽逐字段一致；同 log+同 params 复算预测一致', async () => {
    const host = createMemoryHost();
    seedFailureHistory(host, 3);
    const fx = await setup({ host });
    try {
      await fx.service.extract(host);
      const first = fx.service.transitions().map((transition) => {
        const { id: _id, ...rest } = transition;
        void _id;
        return JSON.stringify(rest);
      });
      // 清空后从零重抽（幂等 extract 的口径：内容一致，id 可重新分配）
      for (const key of [...fx.domain.table('transitions').keys()]) await fx.domain.table('transitions').delete(key);
      await fx.service.extract(host, { range: { from: 0, to: Number.MAX_SAFE_INTEGER } });
      const second = fx.service.transitions().map((transition) => {
        const { id: _id, ...rest } = transition;
        void _id;
        return JSON.stringify(rest);
      });
      expect(second).toEqual(first);

      const firstPrediction = await fx.service.predict({ session: host, round: 3 });
      const secondPrediction = await fx.service.predict({ session: host, round: 3 });
      expect(secondPrediction?.nextAction).toBe(firstPrediction?.nextAction);
      expect(secondPrediction?.confidence).toBe(firstPrediction?.confidence);
      expect(secondPrediction?.similarTransitionIds).toEqual(firstPrediction?.similarTransitionIds);
    } finally {
      await fx.dispose();
    }
  });

  it('5. 泄漏自检：会话正文里的敏感串不得出现在任何表中', async () => {
    const host = createMemoryHost();
    const turn = host.turn(BASE_AT);
    host.message({ turn, role: 'tool', content: 'SECRET-TOKEN-abc123 灯环配对密钥' }, BASE_AT + 500);
    host.tool({ turn, tool: 'read', argClass: 'read', status: 'success' }, BASE_AT + 1000);
    host.close(turn, 'success', BASE_AT + 2000);
    const fx = await setup({ host });
    try {
      await fx.service.extract(host);
      await fx.service.predict({ session: host, round: 1 });
      const dump = JSON.stringify([
        fx.service.transitions(),
        fx.service.predictions(),
        fx.service.mismatches(),
      ]);
      expect(dump).not.toContain('SECRET-TOKEN');
      expect(dump).not.toContain('灯环配对密钥');
      expect(dump).not.toContain('abc123');
    } finally {
      await fx.dispose();
    }
  });

  it('6. 推断标注：注入文本恒带"预测非事实"（唯一出口）', async () => {
    const host = createMemoryHost();
    seedFailureHistory(host, 3);
    const fx = await setup({ host });
    try {
      await fx.service.extract(host);
      const prediction = await fx.service.predict({ session: host, round: 3 });
      const text = fx.service.renderText(prediction!);
      expect(text).toContain('基于历史的预测，非既成事实');
      expect(text).toContain('edit:write');
      expect(text).toContain('timeout');
    } finally {
      await fx.dispose();
    }
  });

  it('7. 预算纪律：注入候选只含过 θ 闸者（份额内截断归 T0.4）', async () => {
    const host = createMemoryHost();
    seedFailureHistory(host, 3);
    const fx = await setup({ host });
    try {
      await fx.service.extract(host);
      const strong = await fx.service.predict({ session: host, round: 3 });
      // 当时的 θ 闸：强历史过闸
      expect(strong?.injected).toBe(true);
      const strongCandidates = await fx.service.injectCandidates({ sessionId: host.sessionId }, 3);
      expect(strongCandidates.map((item) => String(item.id))).toEqual([String(strong?.id)]);

      // 把 θ 提到 0.99 → 同一份历史不再构成"可信预测"（新预测被拦）
      await fx.service.setParams({ thetaPredict: 0.99 });
      const weak = await fx.service.predict({ session: host, round: 3 });
      expect(weak?.injected).toBe(false);
      // injected 是**当时的裁决**（append-only）：旧预测不被回溯撤销，
      // 但新预测不进候选——这正是"闸门按参数判定"的可回放形态
      const candidates = await fx.service.injectCandidates({ sessionId: host.sessionId }, 3);
      expect(candidates.map((item) => String(item.id)).sort()).toEqual(
        [String(strong?.id)].sort(),
      );
    } finally {
      await fx.dispose();
    }
  });

  it('8. fail-open：抽取异常降级为无新 transition，不抛断主链路', async () => {
    const broken = {
      sessionId: 'sess-broken' as never,
      records() {
        throw new Error('日志不可读（模拟冷读失败）');
      },
    };
    const fx = await setup();
    try {
      const report = await fx.service.extract(broken as never);
      expect(report.extracted).toBe(0);
      expect(report.watermark).toBe(0);
      expect(fx.degraded.join('\n')).toContain('extract 失败');
      // 主链路不受影响：预测照常返回（无历史 → null 也是合法降级）
      await expect(fx.service.predict({ session: broken as never, round: 0 })).resolves.toBeNull();
    } finally {
      await fx.dispose();
    }
  });

  it('9. 增量水位：range 之外的记录不被重复抽取（吞吐帽同款纪律）', async () => {
    const host = createMemoryHost();
    seedFailureHistory(host, 2);
    const fx = await setup({ host });
    try {
      const first = await fx.service.extract(host);
      expect(first.extracted).toBe(4);
      expect(first.watermark).toBeGreaterThan(0);
      // 无新记录：再抽增量应为 0
      const second = await fx.service.extract(host);
      expect(second.extracted).toBe(0);
      expect(second.watermark).toBe(first.watermark);
      // 新增一轮后增量抽 1
      host.turn(BASE_AT + 500_000);
      host.tool({ turn: 2, tool: 'edit', argClass: 'write', status: 'failure', errorClass: 'timeout' }, BASE_AT + 501_000);
      host.close(2, 'failed', BASE_AT + 502_000);
      const third = await fx.service.extract(host);
      expect(third.extracted).toBe(2); // tool-call + turn-close
    } finally {
      await fx.dispose();
    }
  });

  it('10. 参数纪律：权重和 ≠ 1 / θ 出界 / topK<1 均拒', async () => {
    const fx = await setup();
    try {
      await expect(fx.service.setParams({ simWeights: { taskCls: 0.9, actionSeq: 0.9, state: 0.9 } })).rejects.toMatchObject({
        code: 'PREDICT_PARAMS_INVALID',
      });
      await expect(fx.service.setParams({ thetaPredict: 1.5 })).rejects.toMatchObject({ code: 'PREDICT_PARAMS_INVALID' });
      await expect(fx.service.setParams({ topK: 0 })).rejects.toMatchObject({ code: 'PREDICT_PARAMS_INVALID' });
      const next = await fx.service.setParams({ thetaPredict: 0.7 });
      expect(next.revision).toBe(1);
    } finally {
      await fx.dispose();
    }
  });
});
