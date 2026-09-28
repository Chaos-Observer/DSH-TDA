/**
 * IT2 集成门：真装配（smoke + goal-state + task-pool 共用一个 registry/总线）下
 * 的跨插件闭环与 daemon 调度语义。
 *
 * 与各插件自带门的分工：插件门验证"插件自身"的规格符合性（用 stub/seam 单飞），
 * 本文件验证**装配后**才暴露的语义——这正是装配层最容易出错的地方
 * （历史上：多插件共用 ctx.invariants 触发 @tda/kernel 重复注册；dispose 与
 * 在途事件回声争同一 tmp 路径）。
 *
 *  1. tick 调度闭环：due → startRun（开窗）→ completeRun（派生 nextDueAt，
 *     跑满 maxRuns 停排）；开窗期间 tick 幂等不重复开窗。
 *  2. 任务 → 目标：stage 幂等投影（executing 由任务集派生）。
 *  3. 任务 → 目标：预算汇聚（经服务面直调，不靠事件反向累计）。
 *  4. 目标 → 任务：verifying 前置（未终态任务挡住 → 全终态后放行）。
 *  5. 持久化：dispose 后同目录重装配，状态原样、两级不变量复验通过。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSessionId, type GoalId, type TaskId } from '@tda/kernel';
import type { GoalNode, GoalStage, GoalTreeService } from 'tda-goal-state';
import type { TaskNode, TaskPoolService } from 'tda-task-pool';
import { describe, expect, it } from 'vitest';
import { assembleRuntime } from '../src/runtime.ts';

/** 注入时钟：调度派生必须可复现（nextDueAt 断言前提）。 */
function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/**
 * 轮询等待：goal-state 的 stage 同步是**已提交事实的回声**（事件订阅 +
 * floating edit），提交方不等它，故集成测试须显式等待而非假定同步完成。
 */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 目标 stage 改写 + STALE 重试。
 *
 * 回声是异步的：读修订号与提交之间可能被回声的 edit 插队。CAS 语义如此设计
 * （"不静默重试"是服务端的正确行为），故重试责任在调用方——生产代码里由
 * 调用者重读，测试里由本助手代劳。
 */
async function editGoalStage(
  goals: GoalTreeService,
  goalId: GoalId,
  stage: GoalStage,
  attempts = 5,
): Promise<GoalNode> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = goals.get(goalId);
    if (current === undefined) throw new Error('测试前置失败：目标不存在');
    try {
      return await goals.edit('human', goalId, { expectedRevision: current.revision }, { stage });
    } catch (error) {
      if ((error as { code?: string }).code !== 'STALE_REVISION') throw error;
    }
  }
  throw new Error(`目标 ${goalId} 的 stage 改写连续 ${attempts} 次撞上修订号过期`);
}

function mustGetTask(tasks: TaskPoolService, id: TaskId): TaskNode {
  const node = tasks.get(id);
  if (node === undefined) throw new Error(`测试前置失败：任务 ${id} 不存在`);
  return node;
}

describe('IT2 集成：goal × task × daemon 装配后闭环', () => {
  it('tick 调度闭环：开窗/收尾/派生下一期/跑满停排 + stage 投影 + 预算汇聚', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-harness-int-'));
    const clock = createClock();
    const runtime = await assembleRuntime({ dir, now: clock.now });
    try {
      const goals = runtime.goalTree.service;
      const tasks = runtime.taskPool.service;

      const goal = await goals.create('human', { objective: 'IT2 收口', budget: { tokens: 1_000 } });
      expect(goal.stage).toBe('planning');
      expect(goal.phase).toBe('active');

      const patrol = await tasks.create('human', {
        goalId: goal.id,
        subject: '周期巡检',
        budget: { tokens: 300 },
        recurrence: { kind: 'interval', intervalMs: 1_000, maxRuns: 2 },
        localPath: 'work',
      });
      // 首次 due = 创建时刻（无 schedule 时的 firstDue 口径）
      expect(patrol.nextDueAt).toBe(clock.now());

      // ① tick 开窗
      const first = await runtime.tick();
      expect(first.due).toBe(1);
      expect(first.startedRuns).toEqual([patrol.id]);
      expect(first.skipped).toEqual([]);
      const opened = mustGetTask(tasks, patrol.id);
      expect(opened.stage).toBe('executing');
      expect(opened.ownerId).toBe('sess-harness-scheduler');
      expect(tasks.runs(patrol.id)).toHaveLength(1);

      // ② 开窗期间 tick 幂等：有未收尾 run 者不进 due 集，绝不重复开窗
      const second = await runtime.tick();
      expect(second.due).toBe(0);
      expect(second.startedRuns).toEqual([]);
      expect(tasks.runs(patrol.id)).toHaveLength(1);

      // ③ 任务 → 目标：stage 投影（任务集含 active/executing → 目标 executing）
      await waitFor(() => goals.get(goal.id)?.stage === 'executing', '目标 stage 投影为 executing');

      // ④ 任务 → 目标：预算汇聚（服务面直调；toolCalls 非目标维度，故不计入）
      const beforeConsume = mustGetTask(tasks, patrol.id);
      await tasks.consume(
        'scheduler',
        patrol.id,
        { expectedRevision: beforeConsume.revision },
        { tokens: 120, toolCalls: 3 },
      );
      expect(goals.get(goal.id)?.budget.consumed.tokens).toBe(120);

      // ⑤ completeRun 派生下一期（fireAt 用开窗前的 nextDueAt，非收尾时刻）
      clock.advance(100);
      await tasks.completeRun(
        'scheduler',
        patrol.id,
        { expectedRevision: mustGetTask(tasks, patrol.id).revision },
        { outcome: 'success' },
      );
      const afterFirstRun = mustGetTask(tasks, patrol.id);
      expect(afterFirstRun.runCount).toBe(1);
      expect(afterFirstRun.phase).toBe('active');
      expect(afterFirstRun.nextDueAt).toBe(clock.now() + 900); // T0+1000 − (T0+100)
      expect(afterFirstRun.ownerId).toBeUndefined();

      // ⑥ 未到期不 due；到期后第 2 轮开窗 → 跑满 maxRuns 停排（owner/nextDueAt 清空）
      expect((await runtime.tick()).due).toBe(0);
      clock.advance(900);
      expect((await runtime.tick()).startedRuns).toEqual([patrol.id]);
      clock.advance(50);
      await tasks.completeRun(
        'scheduler',
        patrol.id,
        { expectedRevision: mustGetTask(tasks, patrol.id).revision },
        { outcome: 'success' },
      );
      const stopped = mustGetTask(tasks, patrol.id);
      expect(stopped.phase).toBe('complete');
      expect(stopped.outcome).toBe('success');
      expect(stopped.runCount).toBe(2);
      expect(stopped.nextDueAt).toBeUndefined();
      expect(stopped.ownerId).toBeUndefined();
      expect(tasks.due(clock.now())).toHaveLength(0);

      // ⑦ 注入区序位与两级不变量
      expect(tasks.promptSection().order.after).toBe('goal:state');
      expect(tasks.promptSection().id).toBe('task:state');
      await expect(runtime.verifyInvariants()).resolves.toBeUndefined();

      // ⑧ 同目录重装配：域状态原样（runCount/终态/目标账本皆 durable）
      await runtime.dispose();
      const reopened = await assembleRuntime({ dir, now: clock.now });
      try {
        const restored = reopened.taskPool.service.get(patrol.id);
        expect(restored?.phase).toBe('complete');
        expect(restored?.runCount).toBe(2);
        expect(reopened.taskPool.service.runs(patrol.id)).toHaveLength(2);
        expect(reopened.goalTree.service.get(goal.id)?.budget.consumed.tokens).toBe(120);
        expect((await reopened.tick()).due).toBe(0);
        await expect(reopened.verifyInvariants()).resolves.toBeUndefined();
      } finally {
        await reopened.dispose();
      }
    } finally {
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('目标 → 任务：verifying 被未终态任务挡住，任务全终态后放行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-harness-gate-'));
    const clock = createClock();
    const runtime = await assembleRuntime({ dir, now: clock.now });
    try {
      const goals = runtime.goalTree.service;
      const tasks = runtime.taskPool.service;
      const goal = await goals.create('human', { objective: '有依赖的目标', budget: { tokens: 500 } });
      const oneShot = await tasks.create('human', { goalId: goal.id, subject: '一次性任务' });

      // 任务未终态：目标不得进入 verifying（前置校验先于 CAS，故无竞争）
      const blocking = goals.get(goal.id);
      if (blocking === undefined) throw new Error('测试前置失败：目标不存在');
      await expect(
        goals.edit('human', goal.id, { expectedRevision: blocking.revision }, { stage: 'verifying' }),
      ).rejects.toThrow(/未终态任务/);

      // tick 对一次性任务不开窗（due 只认周期任务）
      expect((await runtime.tick()).due).toBe(0);

      // 认领 → 目标 stage 幂等推进为 executing
      const claimed = await tasks.claim('agent', oneShot.id, { expectedRevision: oneShot.revision }, asSessionId('sess-runner'));
      await waitFor(() => goals.get(goal.id)?.stage === 'executing', '目标 stage 推进为 executing');

      // 任务终态后放行
      await tasks.complete(
        'agent',
        oneShot.id,
        { expectedRevision: claimed.revision },
        { outcome: 'success', evidence: ['diff#1'] },
      );
      const verifying = await editGoalStage(goals, goal.id, 'verifying');
      expect(verifying.stage).toBe('verifying');
      expect(verifying.phase).toBe('active');

      await expect(runtime.verifyInvariants()).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
