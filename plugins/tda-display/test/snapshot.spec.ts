/** T4.4 门 1：快照聚合对账 + 报告凭证/消毒 + fail-open 降级。 */
import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/service.ts';
import { NOW, setup } from './helpers.ts';

describe('T4.4 快照聚合（不变量 6：与权威域逐字段一致）', () => {
  it('目标摘要计数/焦点/任务六计数与假体对拍', async () => {
    const rig = await setup();
    try {
      const snap = rig.handle.service.snapshot();
      expect(snap.at).toBe(NOW);
      expect(snap.overview.goals).toHaveLength(2);
      const focus = snap.overview.focusGoal;
      expect(focus?.goalId).toBe('goal-1');
      expect(focus?.taskCount).toBe(2);
      expect(focus?.completedCount).toBe(1);
      const counts = snap.overview.tasks;
      expect(counts).toEqual({ ready: 1, executing: 0, awaitingApproval: 1, verifying: 0, blocked: 1, completedToday: 1 });
      expect(snap.overview.drift).toEqual({ band: 'watch', trend: [0.2, 0.35, 0.41] });
      expect(snap.overview.attention).toEqual({ consumedUnits: 420, quotaUnits: 1000, zone: 'normal', pendingCount: 1 });
      expect(snap.degraded).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });

  it('scope 过滤：树谱透传 T4.3 treeView（零复制）', async () => {
    const rig = await setup();
    try {
      const snap = rig.handle.service.snapshot({ goalId: 'goal-1' });
      const spectrum = snap.spectrum as { focusGoalId?: string };
      expect(spectrum.focusGoalId).toBe('goal-1');
    } finally {
      await rig.dispose();
    }
  });

  it('审批摘要：whatToShow 摘要+理由可见；excerpts/token 剥除（不变量 4）', async () => {
    const rig = await setup();
    try {
      const snap = rig.handle.service.snapshot();
      expect(snap.approvals).toHaveLength(1);
      const item = snap.approvals[0];
      expect(item?.approvalId).toBe('appr-1');
      expect(item?.summary).toBe('writeScopes 超出本地路径');
      expect(item?.riskReasons).toEqual(['T0.5 J9 高风险派发门']);
      // 零 token：整快照序列化后 grep
      const serialized = JSON.stringify(snap);
      expect(serialized).not.toContain('tok-secret-123');
      expect(serialized).not.toContain('机密原文');
    } finally {
      await rig.dispose();
    }
  });

  it('决策链：只含 approved/rejected/cancelled 尾窗', async () => {
    const rig = await setup();
    try {
      const snap = rig.handle.service.snapshot();
      expect(snap.audit.recentDecisions.map((item) => item.kind)).toEqual(['approved', 'rejected']);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.4 fail-open（不变量 8）', () => {
  it('supervision/drift 抛错 ⇒ 视图降级不传播，degraded 记名', async () => {
    const rig = await setup();
    try {
      rig.supervision.throws = true;
      if (rig.drift !== undefined) rig.drift.throws = true;
      const snap = rig.handle.service.snapshot();
      expect(snap.approvals).toEqual([]);
      expect(snap.audit.recentDecisions).toEqual([]);
      expect(snap.overview.attention).toBeUndefined();
      expect(snap.overview.drift).toBeUndefined();
      expect(snap.degraded).toContain('supervision');
      expect(snap.degraded).toContain('drift');
    } finally {
      await rig.dispose();
    }
  });

  it('无 supervision/drift 装配 ⇒ 视图为空而非报错', async () => {
    const rig = await setup({ withSupervision: false, withDrift: false });
    try {
      const snap = rig.handle.service.snapshot();
      expect(snap.approvals).toEqual([]);
      expect(snap.overview.attention).toBeUndefined();
      expect(snap.overview.drift).toBeUndefined();
      expect(snap.degraded).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.4 报告产物（J7/不变量 7）', () => {
  it('markdown 生成 + 落时间线 credential=execution-verified / source=harness', async () => {
    const rig = await setup();
    try {
      const markdown = await rig.handle.service.report({});
      expect(markdown).toContain('# TDA 状态报告');
      expect(markdown).toContain('整理灯环协议依赖清单');
      expect(markdown).toContain('task-1：success（证据：entry-1、entry-2）');
      expect(rig.timeline.chunks).toHaveLength(1);
      expect(rig.timeline.chunks[0]?.credential).toBe('execution-verified');
      expect(rig.timeline.chunks[0]?.source).toBe('harness');
    } finally {
      await rig.dispose();
    }
  });

  it('报告文本经 escape：<script> 注入 objective 被 neutralize（不变量 5）', async () => {
    const rig = await setup({
      goals: [{ goalId: 'goal-x', objective: '<script>alert(1)</script>正常目标', phase: 'active', stage: 'planning', zone: 'normal', focus: true }],
      tasks: [],
    });
    try {
      const markdown = await rig.handle.service.report({});
      expect(markdown).not.toContain('<script>');
      expect(markdown).toContain('&lt;script&gt;');
    } finally {
      await rig.dispose();
    }
  });

  it('escapeHtml 纯函数五字符全覆盖', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  });
});
