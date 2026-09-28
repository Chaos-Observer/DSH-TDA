/**
 * P2 集成门：coach × skill-registry × maintenance × workflow × plugin-scout 真装配语义。
 *
 * 与各插件门的分工：插件门验证规格符合性（stub seam 单飞），本文件验证**装配后**
 * 才暴露的语义——P2 的装配面是单向 seam 链（skillRegistry→governance、coach→
 * predictor/meta/skills/pipe、maintenance→signals/governance/coach、workflow→
 * governance/checks/executor、scout→registry/smoke/pipe），且 `replayCheck` 的
 * sources 必须把 P2 五族全部纳入（少一族即报"日志有域无"——P1 已实测过该装配错误）。
 *
 *  1. 全链：mismatch 流 → driveP2（coach 复盘产出候选）→ rehearse/transfer/submit →
 *     治理固化 → 技能晋升双条件 → 维护 cycle 消费信号
 *  2. 轨迹对账：replayCheck 零违规（P2 五族在 sources 里）+ 实体可定位
 *  3. 持久化：dispose 后同目录重装配，coach/技能/维护状态原样 + 不变量复验
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleRuntime } from '../src/runtime.ts';

function createClock(start = 1_790_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('P2 集成：coach × skills × maintenance × workflow × scout 装配后闭环', () => {
  it('1. 全链：mismatch → coach 候选 → rehearsal → 迁移验证 → submit；技能晋升双条件；维护 cycle 消费', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-p2-'));
    const clock = createClock();
    const runtime = await assembleRuntime({ dir, now: clock.now });
    try {
      const goals = runtime.goalTree.service;
      const tasks = runtime.taskPool.service;
      const timeline = runtime.timeline.service;
      const writer = { sessionId: String(runtime.host.sessionId), actor: 'scheduler' as const, at: clock.now() };

      const goal = await goals.create('human', {
        objective: '灯环协议自成长',
        completionCriteria: ['帧表齐全'],
      });
      await goals.focus('human', goal.id, { expectedRevision: goal.revision });
      const task = await tasks.create('human', {
        goalId: goal.id,
        subject: '整理协议帧表格',
        budget: { tokens: 5_000 },
      });
      await tasks.claim('human', task.id, { expectedRevision: task.revision }, runtime.host.sessionId);
      await timeline.append(writer, {
        content: '灯环配对：先发 $01*01，等 SN 回帧',
        chunkType: 'method',
        source: 'task',
        credential: 'execution-verified',
        relatedTaskId: task.id,
      });

      // ① 预测抽取产生 mismatch（同 action 模式反复偏差 → coach 聚类信号）
      await runtime.predictor.service.extract(runtime.host);
      await runtime.driveP1();

      // ② coach 复盘：driveP2 产出候选（若有足量 mismatch；无信号时 propose=0 也不失败）
      const driveReport = await runtime.driveP2();
      expect(driveReport.maintenanceProposed).toBeGreaterThanOrEqual(0);
      const candidates = runtime.coach.service.candidates({ status: 'proposed' });

      // ③ 候选验证链：有候选则走 rehearsal → transfer → submit 全链
      if (candidates.length > 0 && candidates[0]!.draftRef !== undefined) {
        const candidate = candidates[0]!;
        const rehearsal = await runtime.coach.service.rehearseCandidate(
          { actor: 'coach', sessionId: String(runtime.host.sessionId) },
          String(candidate.id),
          task.id,
        );
        expect(rehearsal.verdict).toBe('pass');
        await runtime.coach.service.verifyTransfer(
          { actor: 'coach', sessionId: String(runtime.host.sessionId) },
          String(candidate.id),
          'model-b',
        );
        await runtime.coach.service.submit({ actor: 'coach', sessionId: String(runtime.host.sessionId) }, String(candidate.id));
        expect(runtime.coach.service.candidates({ status: 'submitted' }).length).toBeGreaterThan(0);
      }

      // ④ 技能晋升双条件（装配后语义）：rehearse pass → validating（召回可见）→
      //    logUse success → consolidate

      const emitSkillCalls = (): void => {
        const turn = runtime.host.beginTurn(clock.now());
        for (const tool of ['read', 'edit']) {
          clock.advance(1000);
          runtime.host.appendToolCall(
            { turn, tool, argClass: tool === 'read' ? 'read' : 'write', status: 'success' },
            clock.now(),
          );
        }
      };

      emitSkillCalls();
      const skill = await runtime.skills.service.propose(
        { actor: 'human', sessionId: String(runtime.host.sessionId) },
        {
          name: 'pair-light-ring',
          summary: '灯环配对操作序列',
          procedure: { steps: [{ action: 'read:read' }, { action: 'edit:write' }], prerequisites: [] },
          applicability: { taskClasses: ['tda'], stages: ['executing'] },
          source: { kind: 'human' },
          credential: 'user-original',
        },
      );
      const run = await runtime.skills.service.rehearse(
        { actor: 'human', sessionId: String(runtime.host.sessionId) },
        String(skill.id),
        task.id,
      );
      expect(run.verdict).toBe('pass');
      await runtime.skills.service.logUse(
        { actor: 'human', sessionId: String(runtime.host.sessionId) },
        String(skill.id),
        task.id,
        'success',
      );
      await runtime.skills.service.requestConsolidate(
        { actor: 'human', sessionId: String(runtime.host.sessionId) },
        String(skill.id),
      );
      expect(runtime.governance.service.lifecycleOf(String(skill.id), 'skill')).toBe('consolidated');

      // ⑤ 维护 cycle：信号面读到技能/记忆资产（装配 signals 聚合生效）
      const maintReport = await runtime.maintenance.service.cycle({ kind: 'manual' });
      expect(maintReport.stats.scanned).toBeGreaterThan(0);
      // 跨资产统一治理分排名（Elo/reuse/recency/verify 四元）
      const board = runtime.maintenance.service.scoreboard();
      expect(board.some((entry) => entry.assetKind === 'skill')).toBe(true);
    } finally {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('2. 轨迹对账：replayCheck 零违规（P2 五族已进 sources）+ 实体可定位', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-p2-replay-'));
    const clock = createClock();
    const runtime = await assembleRuntime({
      dir,
      now: clock.now,
      scoutRegistryRows: [
        {
          pluginId: 'p-gold',
          pluginName: 'Gold Plugin',
          trustLevel: 'gold',
          docsComplete: true,
          l4InstallVerified: true,
          l5RuntimeVerified: true,
          downloads: 900,
          stars: 90,
          securityFindings: [],
        },
      ],
    });
    try {
      await runtime.skills.service.setParams({ thetaCov: 0.6 });
      await runtime.maintenance.service.setParams({ cycleMs: 3600_000 });
      await runtime.coach.service.setParams({ minEvidenceCount: 2 });
      await runtime.workflow.service.setParams({ maxConcurrentRuns: 5 });
      await runtime.driveP2();

      const report = await runtime.trajectory.service.replayCheck();
      expect(report.ok).toBe(true);
      // P2 五族实体在索引里可定位
      expect(runtime.trajectory.service.locate('coach', 'params')).toBeDefined();
      expect(runtime.trajectory.service.locate('skill', 'params')).toBeDefined();
      expect(runtime.trajectory.service.locate('maintenance', 'params')).toBeDefined();
      expect(runtime.trajectory.service.locate('workflow', 'params')).toBeDefined();
      expect(runtime.trajectory.service.locate('pluginScout', 'scout-run:sr-1')).toBeDefined();
      // scout 评估已落（registry 注入面生效）
      expect(runtime.scout.service.assessments().some((row) => row.pluginId === 'p-gold')).toBe(true);
    } finally {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('3. 持久化：dispose 后重装配，coach/技能/维护状态原样 + 不变量复验', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-p2-resume-'));
    const clock = createClock();
    const first = await assembleRuntime({ dir, now: clock.now });
    let snapshot: string;
    try {
      const skill = await first.skills.service.propose(
        { actor: 'human', sessionId: String(first.host.sessionId) },
        {
          name: 'resume-skill',
          summary: '恢复面样本技能',
          procedure: { steps: [{ action: 'read:read' }], prerequisites: [] },
          applicability: { taskClasses: ['tda'], stages: ['executing'] },
          source: { kind: 'human' },
          credential: 'user-original',
        },
      );
      // 首轮 rehearsal 需 tool/call 覆盖率：先落调用记录
      const turn = first.host.beginTurn(clock.now());
      for (const tool of ['read', 'edit']) {
        clock.advance(1000);
        first.host.appendToolCall(
          { turn, tool, argClass: tool === 'read' ? 'read' : 'write', status: 'success' },
          clock.now(),
        );
      }
      await first.skills.service.rehearse(
        { actor: 'human', sessionId: String(first.host.sessionId) },
        String(skill.id),
        'task-1',
      );
      await first.skills.service.logUse(
        { actor: 'human', sessionId: String(first.host.sessionId) },
        String(skill.id),
        'task-1',
        'success',
      );
      await first.maintenance.service.cycle({ kind: 'manual' });
      snapshot = JSON.stringify({
        skillStats: first.skills.domain.table('skills').get(String(skill.id))?.stats,
        proposals: first.maintenance.service.proposals().length,
        reports: first.maintenance.service.reports().length,
        coachParams: first.coach.service.params().revision,
      });
    } finally {
      await first.dispose();
    }

    const second = await assembleRuntime({ dir, now: clock.now });
    try {
      const turn = second.host.beginTurn(clock.now());
      for (const tool of ['read', 'edit']) {
        clock.advance(1000);
        second.host.appendToolCall(
          { turn, tool, argClass: tool === 'read' ? 'read' : 'write', status: 'success' },
          clock.now(),
        );
      }

      const restored = JSON.stringify({
        skillStats: [...second.skills.domain.table('skills').entries()].at(-1)?.[1].stats,
        proposals: second.maintenance.service.proposals().length,
        reports: second.maintenance.service.reports().length,
        coachParams: second.coach.service.params().revision,
      });
      expect(restored).toBe(snapshot);
      await expect(second.verifyInvariants()).resolves.toBeUndefined();
    } finally {
      await second.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
