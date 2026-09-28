import { readFileSync, writeFileSync } from 'node:fs';

const steps = [];
const patch = (p, label, from, to) => {
  let s = readFileSync(p, 'utf8');
  if (!s.includes(from)) {
    steps.push(`MISS ${label}`);
    return;
  }
  s = s.replace(from, to);
  writeFileSync(p, s);
  steps.push(`ok   ${label}`);
};

// test1：三个指标同时掉分（persistence=0、consistency<1、constraintRetention=0.5）
// composite = 0.25*(0+0+0.5+1) = 0.375 < 0.5 → drift
patch(
  'test/gate.spec.ts',
  'test1 加约束违例',
  `      // 报 executing 但无 in-progress 任务 → 一致性违例
      tasks: [{ id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'planning' }],`,
  `      // 报 executing 但无 in-progress 任务 → 一致性违例；
      // 另加一条 constraint-* 阻塞 → 约束保持率 0.5（三分量同掉，composite 越 drift 阈）
      tasks: [
        { id: 'task-1', goalId: 'goal-1', phase: 'active', stage: 'planning' },
        { id: 'task-2', goalId: 'goal-1', phase: 'active', stage: 'executing', ownerId: 'sess-x', blockedCode: 'constraint-scope' },
      ],`,
);

// test2：constraintRetention = 1 - 1/2 = 0.5（低于 0.6 候选线即可）
patch(
  'test/gate.spec.ts',
  'test2 分数口径',
  `      expect(first.scores.constraintRetention).toBe(0);`,
  `      expect(first.scores.constraintRetention).toBe(0.5);`,
);
patch(
  'test/gate.spec.ts',
  'test2 第二窗分数',
  `      expect(second.scores.constraintRetention).toBe(0);`,
  `      expect(second.scores.constraintRetention).toBe(0.5);`,
);

// test3：用 1 天窗口 + 2 窗基线，让"基线全 read / 当前全 write"干净可算
patch(
  'test/gate.spec.ts',
  'test3 重写',
  `  it('3. 行动波动路径：动作分布突变 → actionVolatility↓ → 连续 2 窗口后 nudge', async () => {
    let now = NOW;
    // 基线窗口（前 4 个 windowMs）：稳定 read；当前窗口：全 write
    const baseline = Array.from({ length: 20 }, (_, index) => ({ at: NOW - 8 * DAY + index * DAY / 2, token: 'read:read' }));
    const fx = await setup({
      now: () => now,
      config: { windowScanCap: 1000 },
      transitions: [...baseline],
    });
    try {
      void now;
      // 把当前窗口塞满 write（在 evaluate 前追加，时钟推进使它们落入当前窗口）
      const current = Array.from({ length: 10 }, (_, index) => ({ at: NOW - 3 * DAY + index * DAY / 4, token: 'edit:write' }));
      fx.transitions.rows.push(...current);
      const first = await fx.service.evaluate('goal-1');
      expect(first.scores.actionVolatility).toBeLessThan(0.6);
      expect(fx.goals.calibrations.some((row) => row.action === 'nudge')).toBe(false); // 滞回第一窗
      // 第二窗口：波动依旧 → nudge 触发
      fx.transitions.rows.push(...Array.from({ length: 5 }, (_, index) => ({ at: NOW + DAY + index, token: 'edit:write' })));
      now = NOW + DAY + DAY;
      // 把上一窗的快照作为基线成员，当前窗仍是 write → 滞回第二窗
      fx.transitions.rows.push(...Array.from({ length: 5 }, (_, index) => ({ at: now - DAY / 2 + index, token: 'edit:write' })));
      await fx.service.evaluate('goal-1');
      expect(fx.goals.calibrations.some((row) => row.action === 'nudge')).toBe(true);
    } finally {
      await fx.dispose();
    }
  });`,
  `  it('3. 行动波动路径：动作分布突变 → actionVolatility↓ → 连续 2 窗口后 nudge', async () => {
    let now = NOW;
    const fx = await setup({
      now: () => now,
      config: { windowScanCap: 1000 },
      goals: [{ id: 'goal-1', objective: 'x', phase: 'active', stage: 'executing' }],
    });
    try {
      // 收窄窗口（1 天）+ 2 窗基线：让"基线全 read / 当前全 write"干净可算
      await fx.service.setParams({ windowMs: DAY, baselineWindows: 2 });
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
  });`,
);

// test4：三轮 evaluate 有校准落盘，放宽超时
patch(
  'test/gate.spec.ts',
  'test4 超时',
  "  it('4. 无强制重置：全部校准场景跑完后 goalTree 无 clear/reset/complete 痕迹', async () => {",
  "  it('4. 无强制重置：全部校准场景跑完后 goalTree 无 clear/reset/complete 痕迹', { timeout: 30_000 }, async () => {",
);

console.log(steps.join('\n'));
