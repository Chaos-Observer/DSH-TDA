/**
 * P4 集成门（IT14a）：tda-executor 真装配（23 插件 + 执行环）后的闭环语义。
 *
 * 与 tda-executor 插件门的分工：插件门用 stub/seam 单飞验证规格符合性；
 * 本文件验证**装配后**才暴露的语义——
 *  1. tick 执行环阶段：ready → claim → 路由(dispatch) → 结论验证 → complete(success)；
 *  2. 高风险任务：awaiting-approval → 人类一次性 token → approveAndResume 桥 → 续跑完成；
 *  3. opt-in 开关：默认关时 tick 不自动认领（既有手动流集成门不受影响）。
 *
 * 装配期教训（2026-10-13）：执行环自动认领会与既有集成测试的手动流相撞
 * （claim/complete 撞 STALE）——故 tick 阶段为 opt-in（executorEnabled），
 * 本门显式开启；DSH 真装配落地后随主循环形态改默认开。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleRuntime, type TdaRuntime } from '../src/runtime.ts';

function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface Rig {
  readonly runtime: TdaRuntime;
  dispose(): Promise<void>;
}

async function setup(options: { executorEnabled?: boolean; storageBackend?: 'json' | 'sqlite'; sessionBackend?: 'file' | 'dsh-compat' } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-harness-p4-'));
  const clock = createClock();
  const runtime = await assembleRuntime({
    dir,
    now: clock.now,
    ...(options.executorEnabled !== undefined ? { executorEnabled: options.executorEnabled } : {}),
    ...(options.storageBackend !== undefined ? { storageBackend: options.storageBackend } : {}),
    ...(options.sessionBackend !== undefined ? { sessionBackend: options.sessionBackend } : {}),
  });
  return {
    runtime,
    async dispose() {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，detached 子进程清理（不占 libuv 线程池）
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    },
  };
}

async function seedGoalAndTask(runtime: TdaRuntime, overrides: { subject?: string; localPath?: string; writeScopes?: string[] } = {}): Promise<{ goalId: string; taskId: string }> {
  const goal = await runtime.goalTree.service.create('human', {
    objective: '整理灯环协议依赖',
    completionCriteria: ['依赖清单产出并双写对账'],
  });
  const task = await runtime.taskPool.service.create('human', {
    goalId: goal.id,
    subject: overrides.subject ?? '整理依赖清单',
    ...(overrides.localPath !== undefined ? { localPath: overrides.localPath } : {}),
    ...(overrides.writeScopes !== undefined ? { writeScopes: overrides.writeScopes } : {}),
  });
  return { goalId: String(goal.id), taskId: String(task.id) };
}

describe('P4 集成：任务执行环（T4.1）', () => {
  it('tick 自动执行：ready → claim → dispatch 路由 → 验证 → complete(success)', async () => {
    const rig = await setup({ executorEnabled: true });
    try {
      const { taskId } = await seedGoalAndTask(rig.runtime);
      const report = await rig.runtime.tick();
      expect(report.executed.some((entry) => entry.startsWith(`${taskId}:completed:success`))).toBe(true);

      const task = rig.runtime.taskPool.service.get(taskId as never);
      // 真实语义（T0.2 complete）：phase→complete + outcome + evidence，stage 保持
      expect(task?.phase).toBe('complete');
      expect(task?.outcome).toBe('success');
      expect((task?.evidence?.length ?? 0) > 0).toBe(true);

      const attempts = rig.runtime.executor.service.attempts({ taskId });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe('completed');
      expect(attempts[0]?.mode).toBe('dispatch');
      expect(attempts[0]?.verification?.passed).toBe(true);
      expect((attempts[0]?.verification?.evidenceEntryIds.length ?? 0) > 0).toBe(true);

      // 装配级两级不变量（含内核双写对账 + executor 插件级检查）全过
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('P5.1：同一端到端链路落在 DSH 兼容 sqlite 上（storageBackend=sqlite）', async () => {
    const rig = await setup({ executorEnabled: true, storageBackend: 'sqlite' });
    try {
      const { taskId } = await seedGoalAndTask(rig.runtime);
      const report = await rig.runtime.tick();
      expect(report.executed.some((entry) => entry.startsWith(`${taskId}:completed:success`))).toBe(true);
      const task = rig.runtime.taskPool.service.get(taskId as never);
      expect(task?.phase).toBe('complete');
      expect(task?.outcome).toBe('success');
      // 双写对账 + 插件级不变量在 sqlite 介质上全过
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('高风险任务：挂起审批 → 一次性 token → approveAndResume 桥 → 续跑完成', async () => {
    const rig = await setup({ executorEnabled: true });
    try {
      const { taskId } = await seedGoalAndTask(rig.runtime, {
        subject: '改写夹爪固件',
        localPath: 'ws/ring',
        writeScopes: ['ws/outside/firmware'], // 超出 localPath ⇒ 高风险（T0.5 J9 同款判据）
      });
      const report = await rig.runtime.tick();
      expect(report.executed.some((entry) => entry.startsWith(`${taskId}:awaiting-approval`))).toBe(true);

      const pending = rig.runtime.supervision.service.pending({ kind: 'dispatch' });
      expect(pending).toHaveLength(1);
      const approval = pending[0];
      expect(approval).toBeDefined();

      // 未凭票：任务未被 complete
      const before = rig.runtime.taskPool.service.get(taskId as never);
      expect(before?.stage).not.toBe('done');

      // 人类批准（一次性 token）→ 装配层桥续跑
      const final = await rig.runtime.approveAndResume(String(approval?.approvalId), approval?.token.nonce ?? '');
      expect(final.status).toBe('completed');

      const after = rig.runtime.taskPool.service.get(taskId as never);
      expect(after?.phase).toBe('complete');
      expect(after?.outcome).toBe('success');

      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('P5.2：DSH 兼容日志（sessionBackend=dsh-compat）上同一执行环链路', async () => {
    const rig = await setup({ executorEnabled: true, sessionBackend: 'dsh-compat' });
    try {
      const { taskId } = await seedGoalAndTask(rig.runtime);
      const report = await rig.runtime.tick();
      expect(report.executed.some((entry) => entry.startsWith(`${taskId}:completed:success`))).toBe(true);
      const task = rig.runtime.taskPool.service.get(taskId as never);
      expect(task?.phase).toBe('complete');
      // 双写对账 + 插件级不变量在 DSH 兼容日志上全过
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('opt-in 开关：默认关时 tick 不自动认领（手动流不受影响）', async () => {
    const rig = await setup();
    try {
      const { taskId } = await seedGoalAndTask(rig.runtime);
      const report = await rig.runtime.tick();
      expect(report.executed).toEqual([]);
      const task = rig.runtime.taskPool.service.get(taskId as never);
      expect(task?.ownerId).toBeUndefined();
      expect(task?.stage).toBe('planning');
      expect(rig.runtime.executor.service.attempts()).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });
});
