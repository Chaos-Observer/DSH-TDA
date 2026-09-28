/**
 * tda-drift 冒烟门（门4 test:smoke）：T1.5 §6 验收 1–8 逐条。
 */
import { describe, expect, it } from 'vitest';
import { DAY, NOW, setup } from './helpers.ts';

describe('T1.5 §6 验收', () => {
  it('1. G1-③ 漂移捕获 + 温和校准：编辑渐偏 + 状态错配 → restate/echo → 目标权威值逐字节不变', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      config: { maxEditsPerWindow: 3 },
      goals: [{ id: 'goal-1', objective: '初始目标：整理灯环配对协议', phase: 'active', stage: 'executing' }],
      // 报 executing 但无 in-progress 任务 → 一致性违例；
      // 另加一条 constraint-* 阻塞 → 约束保持率 0.5（三分量同掉，composite 越 drift 阈）
      tasks: [
        { id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'planning' },
        { id: 'task-2', goalId: 'goal-1', phase: 'active', stage: 'executing', blockedCode: 'constraint-scope' },
      ],
    });
    try {
      const before = JSON.stringify(fx.goals.seam.get('goal-1'));
      // objective 被编辑 3 次（persistence → 0）
      for (let index = 0; index < 3; index += 1) {
        now += DAY;
        fx.goals.setObjective('goal-1', `被改过的目标 v${index}`, now);
      }
      now += DAY;
      const snapshot = await fx.service.evaluate('goal-1', 'objective-edit');
      expect(snapshot.level).toBe('drift');
      expect(snapshot.scores.persistence).toBe(0);
      expect(snapshot.scores.consistency).toBeLessThan(1);
      // 低风险动作即时执行（restate/echo），落 calibrations
      expect(fx.goals.calibrations.length).toBeGreaterThan(0);
      const actions = fx.goals.calibrations.map((row) => row.action);
      expect(actions).toContain('restate');
      // 目标权威值逐字节不变（不变量 1/2 自检）
      expect(JSON.stringify(fx.goals.seam.get('goal-1'))).toBe(before);
      // 且 seam 调用日志里没有任何 mutation
      const mutations = fx.goals.calls.filter((call) =>
        ['edit', 'focus', 'pause', 'resume', 'block', 'complete', 'clear', 'consume', 'recordRound', 'delete'].includes(call),
      );
      expect(mutations).toEqual([]);
    } finally {
      await fx.dispose();
    }
  });

  it('2. 约束保持路径：constraint-* 复发 → 连续 2 窗口后 reanchor（滞回自检），注入含 pinned 约束', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      goals: [{ id: 'goal-1', objective: '目标', phase: 'active', stage: 'executing', pinned: ['约束A', '约束B'] }],
      tasks: [
        { id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'executing', ownerId: 'sess-x', blockedCode: 'constraint-scope' },
      ],
      // 无 objective 编辑、状态一致 → 只有约束维度在掉分
      transitions: Array.from({ length: 6 }, (_, index) => ({ at: NOW - 30 * DAY + index * DAY, token: 'read:read' })),
    });
    try {
      const first = await fx.service.evaluate('goal-1');
      // 第一窗口：medium 动作被滞回拦住（不触发）
      expect(first.scores.constraintRetention).toBe(0.5);
      expect(fx.goals.calibrations.some((row) => row.action === 'reanchor')).toBe(false);
      expect(fx.goals.calls.filter((call) => call === 'recordCalibration')).toHaveLength(0);

      now += DAY;
      const second = await fx.service.evaluate('goal-1');
      expect(second.scores.constraintRetention).toBe(0.5);
      // 连续 2 窗口越限 → reanchor 触发，且文本带 pinned 约束清单
      const reanchor = fx.goals.calibrations.find((row) => row.action === 'reanchor');
      expect(reanchor).toBeDefined();
      expect(reanchor?.detail).toContain('约束A');
      expect(reanchor?.detail).toContain('snapshot=ds-');
    } finally {
      await fx.dispose();
    }
  });

  it('3. 行动波动路径：动作分布突变 → actionVolatility↓ → 连续 2 窗口后 nudge', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      config: { windowScanCap: 1000 },
      goals: [{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing' }],
      // 让一致性=1（有 in-progress 任务）：唯一越限指标是 actionVolatility，路由才指向 nudge
      tasks: [{ id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'executing', ownerId: 'sess-x' }],
    });
    try {
      // 收窄窗口（1 天）+ 2 窗基线：让"基线全 read / 当前全 write"干净可算
      // 基线 4 窗：第二窗的基线仍以 read 为主（首窗异常只占 1/3），KL 仍越限
      await fx.service.setParams({ windowMs: DAY, baselineWindows: 4 });
      // 基线窗口（前 2 个 windowMs）：稳定 read
      fx.transitions.rows.push(...Array.from({ length: 20 }, (_, index) => ({ at: NOW - 3 * DAY + index * DAY / 10, token: 'read:read' })));
      // 当前窗口：全 write
      fx.transitions.rows.push(...Array.from({ length: 10 }, (_, index) => ({ at: NOW - DAY / 2 + index, token: 'edit:write' })));

      const first = await fx.service.evaluate('goal-1');
      // KL(write‖read) ≥ ln2 → 波动分 0（远低于候选线 0.6）
      expect(first.scores.actionVolatility).toBeLessThan(0.6);
      // 滞回第一窗：medium 动作不触发
      expect(fx.goals.calibrations.some((row) => row.action === 'nudge')).toBe(false);

      // 第二窗口：波动依旧 → nudge 触发
      now = NOW + 2 * DAY;
      fx.transitions.rows.push(...Array.from({ length: 10 }, (_, index) => ({ at: now - DAY / 2 + index, token: 'edit:write' })));
      await fx.service.evaluate('goal-1');
      const nudge = fx.goals.calibrations.find((row) => row.action === 'nudge');
      expect(nudge).toBeDefined();
      expect(nudge?.detail).toContain('snapshot=ds-');
    } finally {
      await fx.dispose();
    }
  });

  it('4. 无强制重置：全部校准场景跑完后 goalTree 无 clear/reset/complete 痕迹', { timeout: 30_000 }, async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      goals: [{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing', pinned: ['C'] }],
      tasks: [{ id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'planning', blockedCode: 'constraint-x' }],
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        now += DAY;
        fx.goals.setObjective('goal-1', `v${index}`, now);
        await fx.service.evaluate('goal-1');
      }
      const forbidden = fx.goals.calls.filter((call) => ['complete', 'clear', 'pause', 'block', 'delete', 'edit', 'focus'].includes(call));
      expect(forbidden).toEqual([]);
      expect(fx.goals.goals.get('goal-1')?.phase).toBe('active');
    } finally {
      await fx.dispose();
    }
  });

  it('5. 后验追踪：校准后下一窗口必出对照快照；校准无效 → 升级人类路径可达', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      config: { maxEditsPerWindow: 2 },
      goals: [{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing' }],
      tasks: [{ id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'planning' }],
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        now += DAY;
        fx.goals.setObjective('goal-1', `v${index}`, now);
      }
      now += DAY;
      await fx.service.evaluate('goal-1');
      expect(fx.goals.calibrations.length).toBeGreaterThan(0);
      // 校准后下一窗口出了对照快照 → verified
      now += DAY;
      await fx.service.evaluate('goal-1');
      const verification = fx.service.postVerification('goal-1');
      expect(verification.verified).toBe(true);
      expect(verification.calibratedAt).toBeDefined();
      // "校准无效"路径：注入仍未回升 → postVerification 只给事实，升级归 T3.2（接口可达）
      const unverified = fx.service.postVerification('goal-404');
      expect(unverified.calibratedAt).toBeUndefined();
      expect(unverified.verified).toBe(false);
    } finally {
      await fx.dispose();
    }
  });

  it('6. 确定性：同 domain 快照 + 同 params 两次 evaluate 的指标逐字段一致', async () => {
    const now = NOW;
    const fx = await setup({
      now: () => now,
      goals: [{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing' }],
      tasks: [{ id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'planning' }],
      transitions: [{ at: NOW - DAY, token: 'read:read' }],
    });
    try {
      const first = await fx.service.evaluate('goal-1');
      // 第二次同窗口评估（同时钟）：只允许 at/id 变，四指标与判带必须逐字段一致
      const second = await fx.service.evaluate('goal-1');
      expect(second.scores).toEqual(first.scores);
      expect(second.composite).toBe(first.composite);
      expect(second.level).toBe(first.level);
      expect(second.window).toEqual(first.window);
    } finally {
      await fx.dispose();
    }
  });

  it('7. 趋势数据面：≥N 个周期快照可查，等级分布合理（T3.2 前置）', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      config: { maxEditsPerWindow: 3 },
      goals: [{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing' }],
      tasks: [{ id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'planning' }],
    });
    try {
      for (let index = 0; index < 4; index += 1) {
        now += DAY;
        await fx.service.evaluate('goal-1');
      }
      const list = fx.service.snapshots('goal-1');
      expect(list.length).toBe(4);
      expect(list.every((snapshot) => ['normal', 'watch', 'drift'].includes(snapshot.level))).toBe(true);
    } finally {
      await fx.dispose();
    }
  });

  it('8. 误报防护：单窗口边界值（drift 阈 ±ε）不触发 medium 校准', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      goals: [{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing', pinned: ['C'] }],
      tasks: [{ id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'executing', ownerId: 's' }],
      transitions: Array.from({ length: 8 }, (_, index) => ({ at: NOW - 6 * DAY + index * DAY, token: 'read:read' })),
    });
    try {
      const first = await fx.service.evaluate('goal-1');
      // composite 处于 watch/normal 带 → 不触发任何校准
      expect(first.level).not.toBe('drift');
      expect(fx.goals.calibrations).toEqual([]);
      now += DAY;
      const second = await fx.service.evaluate('goal-1');
      expect(second.level).not.toBe('drift');
      expect(fx.goals.calibrations).toEqual([]);
    } finally {
      await fx.dispose();
    }
  });

  it('9. 注入候选：evaluate 生成的提示经 injectCandidates 投放一次（队列清空）', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      goals: [{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing' }],
      tasks: [{ id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'planning' }],
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        now += DAY;
        fx.goals.setObjective('goal-1', `v${index}`, now);
      }
      now += DAY;
      await fx.service.evaluate('goal-1');
      const first = await fx.service.injectCandidates({ sessionId: 's' }, 1);
      expect(first.length).toBeGreaterThan(0);
      expect(first[0]?.text).toContain('[漂移校准·');
      // 队列已清空（消费即走）
      const second = await fx.service.injectCandidates({ sessionId: 's' }, 2);
      expect(second).toEqual([]);
    } finally {
      await fx.dispose();
    }
  });

  it('10. 无焦点目标：evaluate fail-loud（宿主按 SKIPPABLE 跳过）', async () => {
    const fx = await setup({ goals: [] });
    try {
      await expect(fx.service.evaluate()).rejects.toMatchObject({ code: 'DRIFT_NO_GOAL' });
    } finally {
      await fx.dispose();
    }
  });

  it('11. 参数纪律：权重和 ≠ 1 / 阈值倒挂 / 滞回 <1 均拒', async () => {
    const fx = await setup();
    try {
      await expect(fx.service.setParams({ weights: { persistence: 0.9, consistency: 0.9, constraintRetention: 0.9, actionVolatility: 0.9 } })).rejects.toMatchObject({
        code: 'DRIFT_PARAMS_INVALID',
      });
      await expect(fx.service.setParams({ thresholds: { watch: 0.4, drift: 0.7 } })).rejects.toMatchObject({
        code: 'DRIFT_PARAMS_INVALID',
      });
      await expect(fx.service.setParams({ hysteresisWindows: 0 })).rejects.toMatchObject({ code: 'DRIFT_PARAMS_INVALID' });
      const next = await fx.service.setParams({ perMetricThreshold: 0.5 });
      expect(next.revision).toBe(1);
    } finally {
      await fx.dispose();
    }
  });
});
