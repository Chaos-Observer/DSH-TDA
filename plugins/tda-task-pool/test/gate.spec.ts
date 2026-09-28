/**
 * tda-task-pool 冒烟门（门4 test:smoke）：IT2 / T0.2 验收 1–7 载体。
 *
 *  1. G0-① 全 phase×stage 走通（create→claim→blocked→resume→complete(success/failed)，
 *     blocked reason 可路由）+ 周期任务连续 3 run 的 due 派生与失败计数
 *  2. G0-② kill -9 重启：任务池/owner/预算账本/task_runs/nextDueAt 原样 + 配对零差异
 *     + replay-equivalence + 不变量复验
 *  3. 并发 CAS 恰一成功（不变量门已覆盖，此处以序列化路径复验）
 *  4. 预算三区：80% 触发 converge（新 claim 被拒并提示收敛）、100% 后 complete 必带 unfinished
 *  5. Agent 提议未批准不可 claim；批准后入 ready 集
 *  6. 模型工具面：agent 调用自动待批、approve 越权被拦、裁剪视图不含全快照
 *  7. model-visible⟺logged 自检（task:state 注入区的任务必有事件踪迹、序位紧随 goal:state）
 *
 * 子进程以 Node 类型剥离直跑（内核 erasable-syntax + 显式 .ts 扩展，零转译依赖），
 * 场景脚本放本包 testkit-runtime/（裸标识符靠 node_modules 向上解析）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  createTdaInvariantRegistry,
  openTdaDomain,
  registerTdaInvariants,
  StaleRevisionError,
  type TdaDomain,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  assertReplayEquivalence,
  compareReplay,
  createFileSessionSink,
  killAndWait,
  pairLogAgainstDomain,
  readSessionLog,
  spawnScenario,
  waitForControl,
} from '@tda/testkit';
import {
  taskPoolDomainSpec,
  tdaTaskPoolPlugin,
  TASK_POOL_TOOL_NAMES,
  type TaskTables,
  type TaskToolCallContext,
} from '../src/index.ts';
import { registerTaskPoolInvariants } from '../src/loadChecks.ts';

const runtimeDir = fileURLToPath(new URL('../testkit-runtime/', import.meta.url));

function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-task-gate'),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

function createClock(start = 1_700_000_000_000): {
  now: () => number;
  set: (ms: number) => void;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const toolCtx = (actor: TaskToolCallContext['actor'], session = 'sess-tool'): TaskToolCallContext => ({
  actor,
  sessionId: asSessionId(session),
  ...(actor === 'human' ? { lead: true } : {}),
});

/**
 * idle 场景：经插件 apply 装配（真实出口路径），走完整 op 集后写 idle 保活等杀。
 * 时钟注入固定基准——周期派生必须可复现（replay 比对前提）。
 */
const IDLE_SCRIPT = `
import { asSessionId, createJsonBackend, createTdaInvariantRegistry } from '@tda/kernel';
import { createFileSessionSink, writeControl } from '@tda/testkit';
import { tdaTaskPoolPlugin } from '../src/index.ts';

const dir = process.argv[2];
const controlFile = process.argv[3];
let now = 1700000000000;
const clock = () => now;
const backend = createJsonBackend(dir);
const registry = createTdaInvariantRegistry();
const sink = createFileSessionSink(dir + '/session.jsonl', asSessionId('sess-task-idle'));
const handle = await tdaTaskPoolPlugin.apply({ storage: backend, invariants: registry, session: sink, now: clock });
const svc = handle.service;

// 1) 目标树（假目标，仅作挂靠 id）：根 + 子
const root = await svc.create('human', { goalId: 'goal-1', subject: '根任务', budget: { tokens: 1000 }, localPath: 'work' });
const child = await svc.create('human', {
  goalId: 'goal-1', subject: '子任务', parentTaskId: root.id, budget: { tokens: 400 }, writeScopes: ['work/out'],
});
// 2) 认领 + 预算记账（子 → 根汇聚）
const claimed = await svc.claim('agent', child.id, { expectedRevision: child.revision }, asSessionId('sess-runner'));
await svc.consume('agent', child.id, { expectedRevision: claimed.revision }, { tokens: 50, toolCalls: 2 });
// 3) 相位往返：根 block → resume
const blocked = await svc.block('scheduler', root.id, { expectedRevision: svc.get(root.id).revision }, { code: 'WAIT_INPUT', message: '等人工输入' });
await svc.resume('human', root.id, { expectedRevision: blocked.revision });
// 4) 周期任务：开 run 并收尾（派生 nextDueAt）
const periodic = await svc.create('human', {
  goalId: 'goal-1', subject: '周期巡检', budget: { tokens: 200 },
  recurrence: { kind: 'interval', intervalMs: 1000, maxRuns: 3 },
});
const started = await svc.startRun('scheduler', periodic.id, { expectedRevision: periodic.revision }, asSessionId('sess-sched'));
now += 200;
await svc.completeRun('scheduler', periodic.id, { expectedRevision: started.revision }, { outcome: 'success', consumed: { tokens: 20 } });
// 5) Agent 提议（待批）
await svc.propose('agent', { goalId: 'goal-1', subject: '提议：加抽查' });

await registry.verify();
writeControl(controlFile, 'idle');
setInterval(() => {}, 1000);
`;

describe('tda-task-pool 冒烟门', () => {
  it('验收 1：全 phase×stage 走通 + blocked reason 可路由 + 周期连续 3 run 派生正确', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-tp-gate-e2e-'));
    const registry = createTdaInvariantRegistry();
    const backend = createJsonBackend(dir);
    const clock = createClock();
    const handle = await tdaTaskPoolPlugin.apply({
      storage: backend,
      invariants: registry,
      session: createFileSessionSink(join(dir, 'session.jsonl'), asSessionId('sess-e2e')),
      now: clock.now,
    });
    try {
      const task = await handle.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '端到端',
        budget: { tokens: 1000, toolCalls: 20, wallClockMs: 60_000, attentionUnits: 10 },
      });
      // stage 四子态推进（active 内）
      const executing = await handle.service.claim('agent', task.id, { expectedRevision: task.revision }, asSessionId('sess-w'));
      expect(executing.stage).toBe('executing');
      const waiting = await handle.service.edit('agent', task.id, { expectedRevision: executing.revision }, { stage: 'waiting' });
      expect(waiting.stage).toBe('waiting');
      // 释放回 planning（owner 归还）
      const released = await handle.service.release('agent', task.id, { expectedRevision: waiting.revision });
      expect(released.stage).toBe('planning');
      expect(released.ownerId).toBeUndefined();
      // blocked 携带稳定 code（可路由）
      const blocked = await handle.service.block('scheduler', task.id, { expectedRevision: released.revision }, {
        code: 'dep-failed',
        message: '前置依赖失败',
      });
      expect(blocked.phase).toBe('blocked');
      expect(blocked.blockedReason?.code).toBe('dep-failed');
      const resumed = await handle.service.resume('human', task.id, { expectedRevision: blocked.revision });
      const done = await handle.service.complete('human', task.id, { expectedRevision: resumed.revision }, {
        outcome: 'failed',
        evidence: ['run-log#42'],
        notes: '外部依赖不可用',
      });
      expect(done.phase).toBe('complete');
      expect(done.outcome).toBe('failed');
      // 失败也是完成：run 记录落盘（一次性任务 runIndex=0）
      const runs = handle.service.runs(task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ runIndex: 0, outcome: 'failed' });

      // 周期任务连续 3 run：due 派生 + 失败计数
      const periodic = await handle.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '周期',
        budget: { tokens: 100 },
        recurrence: { kind: 'interval', intervalMs: 1000, maxRuns: 3 },
      });
      const base = clock.now();
      const runOnce = async (index: number, outcome: 'success' | 'failed'): Promise<typeof periodic> => {
        const now = base + index * 1000;
        clock.set(now);
        // due 命中（nextDueAt ≤ now）——调度入口
        expect(handle.service.due(now).map((node) => node.id)).toContain(periodic.id);
        const current = handle.service.get(periodic.id);
        if (current === undefined) throw new Error('测试前置失败：周期任务不存在');
        const started = await handle.service.startRun(
          'scheduler',
          periodic.id,
          { expectedRevision: current.revision },
          asSessionId('sess-sched'),
        );
        clock.advance(100); // 开窗后 100ms 收尾（不越下一期）
        return handle.service.completeRun('scheduler', periodic.id, { expectedRevision: started.revision }, { outcome });
      };

      // run 1（success）：nextDueAt 推进一期、失败计数清零
      const first = await runOnce(0, 'success');
      expect(first.phase).toBe('active');
      expect(first.nextDueAt).toBe(base + 1000);
      expect(first.consecutiveFailures).toBe(0);
      // run 2（failed）：失败计数累加
      const second = await runOnce(1, 'failed');
      expect(second.phase).toBe('active');
      expect(second.nextDueAt).toBe(base + 2000);
      expect(second.consecutiveFailures).toBe(1);
      // run 3（success）：跑满 maxRuns → 停排（终态 + 无 nextDueAt）
      const third = await runOnce(2, 'success');
      expect(third.phase).toBe('complete');
      expect(third.nextDueAt).toBeUndefined();
      expect(third.consecutiveFailures).toBe(0);
      expect(third.runCount).toBe(3);
      const settled = handle.service.get(periodic.id);
      expect(settled?.phase).toBe('complete');
      expect(settled?.nextDueAt).toBeUndefined();
      expect(settled?.runCount).toBe(3);
      expect(settled?.consecutiveFailures).toBe(0); // 第三轮 success 清零
      expect(handle.service.runs(periodic.id)).toHaveLength(3);
      expect(handle.service.runs(periodic.id).map((record) => record.outcome)).toEqual(['success', 'failed', 'success']);
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('验收 2：kill -9 → 重启后三表原样 + 配对零差异 + replay 等值 + 不变量复验', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-tp-gate-idle-'));
    try {
      const controlFile = join(dir, 'control.log');
      const spawned = spawnScenario({
        runtimeDir,
        scriptName: 'idle-scenario.mjs',
        scriptSource: IDLE_SCRIPT,
        args: [dir, controlFile],
      });
      expect(await waitForControl(controlFile, 'idle'), spawned.readStderr()).toBe(true);
      const outcome = await killAndWait(spawned.child);
      expect(outcome.hardKilled).toBe(true);

      // 日志：11 个事件（root: create/consume-rollup/block/resume；child: create/claim/consume；
      // periodic: create/start-run/complete-run；proposal: propose），无撕裂尾
      const { events, tornTail } = readSessionLog(join(dir, 'session.jsonl'));
      expect(events).toHaveLength(11);
      expect(tornTail).toBe(false);

      const backend = createJsonBackend(dir);
      const domain: TdaDomain<TaskTables> = await openTdaDomain(taskPoolDomainSpec, { backend });
      try {
        const tasks = domain.table('task_nodes');
        expect(tasks.size()).toBe(4);
        const root = tasks.get('task-1');
        const child = tasks.get('task-2');
        const periodic = tasks.get('task-3');
        const proposed = tasks.get('task-4');
        if (root === undefined || child === undefined || periodic === undefined || proposed === undefined) {
          throw new Error('重启后任务缺失');
        }
        // 预算账本：子耗 50/2，根经汇聚同耗；periodic 的 run 消耗只记 run 记录（任务账本未 consume）
        expect(child.budget.consumed).toMatchObject({ tokens: 50, toolCalls: 2 });
        expect(root.budget.consumed).toMatchObject({ tokens: 50, toolCalls: 2 });
        expect(root.budget.zone).toBe('normal');
        // owner：子被认领，根/周期无 owner
        expect(child.ownerId).toBe('sess-runner');
        expect(root.ownerId).toBeUndefined();
        // 周期派生：nextDueAt 已推进、run 记录已收尾
        expect(periodic.runCount).toBe(1);
        expect(periodic.nextDueAt).toBe(1_700_000_001_000);
        expect(periodic.consecutiveFailures).toBe(0);
        expect(domain.table('task_runs').size()).toBe(1);
        expect(domain.table('task_runs').get('task-3#0')?.completedAt).toBe(1_700_000_000_200);
        // 提议：待批 + 不可认领
        expect(proposed.proposal?.status).toBe('pending_approval');
        expect(proposed.proposedBy).toBe('agent');
        // revision 推进（root 4 次 accepted：create/rollup/block/resume → rev 3；child 3 次 → rev 2）
        expect(root.revision).toBe(3);
        expect(child.revision).toBe(2);
        expect(periodic.revision).toBe(2);
        expect(domain.table('task_history').size()).toBe(11);

        // 配对零差异 + replay-equivalence（事件全快照重放 == 域现状）
        expect(pairLogAgainstDomain(events, tasks.keys()).ok).toBe(true);
        assertReplayEquivalence(
          compareReplay(events, tasks.entries(), (event) => ({ key: event.businessId, value: event.payload })),
        );
      } finally {
        await domain.close();
        await backend.close();
      }

      // 重启后两级不变量复验（九条 + 双写配对）
      const registry = createTdaInvariantRegistry();
      const reconciler = createDualWriteReconciler();
      const backend2 = createJsonBackend(dir);
      const domain2 = await openTdaDomain(taskPoolDomainSpec, {
        backend: backend2,
        onChange: (change) =>
          reconciler.observeChange({
            domain: change.domain,
            table: change.table,
            key: change.key,
            operation: change.operation,
          }),
      });
      try {
        registerTdaInvariants(registry, reconciler);
        registerTaskPoolInvariants(registry, domain2);
        await expect(registry.verify()).resolves.toBeUndefined();
      } finally {
        await domain2.close();
        await backend2.close();
      }
    } finally {
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('验收 4 预算三区：80% converge 禁新委派、100% complete 必带 unfinished', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-tp-gate-zone-'));
    const backend = createJsonBackend(dir);
    const handle = await tdaTaskPoolPlugin.apply({
      storage: backend,
      invariants: createTdaInvariantRegistry(),
      session: createFileSessionSink(join(dir, 'session.jsonl'), asSessionId('sess-zone')),
    });
    try {
      const task = await handle.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '三区',
        budget: { tokens: 100 },
      });
      // 80% → converge
      const converged = await handle.service.consume('agent', task.id, { expectedRevision: task.revision }, { tokens: 80 });
      expect(converged.budget.zone).toBe('converge');
      await expect(
        handle.service.claim('agent', task.id, { expectedRevision: converged.revision }, asSessionId('sess-x')),
      ).rejects.toThrow(/BUDGET_CONVERGE|收敛/);
      // 100% → exhausted：先跨过阈值再收尾
      const exhausted = await handle.service.consume('agent', task.id, { expectedRevision: converged.revision }, { tokens: 20 });
      expect(exhausted.budget.zone).toBe('exhausted');
      await expect(
        handle.service.claim('agent', task.id, { expectedRevision: exhausted.revision }, asSessionId('sess-x')),
      ).rejects.toThrow(/BUDGET_EXHAUSTED|耗尽|提额/);
      // 耗尽区 complete 缺 unfinished → 拒
      await expect(
        handle.service.complete('human', task.id, { expectedRevision: exhausted.revision }, { outcome: 'failed' }),
      ).rejects.toThrow(/unfinished|未完成清单/);
      // 带 unfinished → 收尾成功（显式终态，绝不悄然截断）
      const closed = await handle.service.complete('human', task.id, { expectedRevision: exhausted.revision }, {
        outcome: 'failed',
        unfinished: ['剩余数据源未接入'],
      });
      expect(closed.phase).toBe('complete');
      expect(closed.unfinished).toEqual(['剩余数据源未接入']);
      // 耗尽作用域拒绝新建（作用域须仍在跑：这里另建一个耗尽未终态的任务作父）
      const scope = await handle.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '耗尽未终态',
        budget: { tokens: 10 },
      });
      const drained = await handle.service.consume('agent', scope.id, { expectedRevision: scope.revision }, { tokens: 10 });
      expect(drained.budget.zone).toBe('exhausted');
      await expect(
        handle.service.create('human', {
          goalId: 'goal-1' as never,
          subject: '耗尽后新建',
          parentTaskId: scope.id,
          budget: { tokens: 1 },
        }),
      ).rejects.toThrow(/BUDGET_EXHAUSTED|耗尽|提额/);
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('验收 5–6 提议审批闭环 + 工具面裁剪视图 + approve 越权被拦', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-tp-gate-proposal-'));
    const backend = createJsonBackend(dir);
    const handle = await tdaTaskPoolPlugin.apply({
      storage: backend,
      invariants: createTdaInvariantRegistry(),
      session: createFileSessionSink(join(dir, 'session.jsonl'), asSessionId('sess-prop')),
    });
    try {
      const tools = new Map(handle.tools.map((tool) => [tool.name, tool]));
      expect([...handle.tools.map((tool) => tool.name)].sort()).toEqual([...TASK_POOL_TOOL_NAMES].sort());

      // 模型工具调用的默认路径：actor='agent' → 自动待批
      const createTool = tools.get('task_create');
      if (createTool === undefined) throw new Error('缺 task_create 工具');
      const created = await createTool.handler(
        { goalId: 'goal-1', subject: '模型建的任务', budget: { tokens: 50 } },
        toolCtx('agent'),
      );
      expect(created.proposalStatus).toBe('pending_approval');
      expect(created.phase).toBe('active');
      // 裁剪视图不含全快照字段（主上下文只留决策与编排）
      expect(created).not.toHaveProperty('description');
      expect(created).not.toHaveProperty('writeScopes');
      expect(created).not.toHaveProperty('createdAt');

      const taskId = created.id as never;
      // 未批准不可 claim，也不进 ready
      expect(handle.service.ready().map((node) => node.id)).not.toContain(taskId);
      await expect(
        handle.service.claim('agent', taskId, { expectedRevision: created.revision as number }, asSessionId('sess-a')),
      ).rejects.toThrow(/未批准|TASK_NOT_APPROVED/);
      // 模型自批被拦（工具层 + 服务层双拦）
      const approveTool = tools.get('task_approve');
      if (approveTool === undefined) throw new Error('缺 task_approve 工具');
      await expect(
        approveTool.handler(
          { taskId: created.id as string, expectedRevision: created.revision as number, approve: true },
          toolCtx('agent'),
        ),
      ).rejects.toThrow(/TASK_APPROVAL_FORBIDDEN|人类|Lead/);
      await expect(
        handle.service.approveProposal('agent', taskId, { expectedRevision: created.revision as number }, true),
      ).rejects.toThrow(/仅人类|Lead/);
      // 人类批准 → 入 ready 集 → 可认领
      const approved = await handle.service.approveProposal(
        'human',
        taskId,
        { expectedRevision: created.revision as number },
        true,
      );
      expect(approved.proposal?.status).toBe('approved');
      expect(handle.service.ready().map((node) => node.id)).toContain(taskId);
      const claimed = await handle.service.claim('agent', taskId, { expectedRevision: approved.revision }, asSessionId('sess-a'));
      expect(claimed.stage).toBe('executing');
      // 驳回路径：提议被驳回后同样不可认领
      const rejected = await handle.service.propose('agent', { goalId: 'goal-1' as never, subject: '被驳回的提议' });
      const rejectedAfter = await handle.service.approveProposal(
        'human',
        rejected.id,
        { expectedRevision: rejected.revision },
        false,
        '超范围',
      );
      expect(rejectedAfter.proposal?.status).toBe('rejected');
      await expect(
        handle.service.claim('agent', rejected.id, { expectedRevision: rejectedAfter.revision }, asSessionId('sess-a')),
      ).rejects.toThrow(/未批准|TASK_NOT_APPROVED/);
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('验收 7：task:state 裁剪视图（序位紧随 goal:state）+ model-visible⟺logged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-tp-gate-view-'));
    const backend = createJsonBackend(dir);
    const sink = createMemorySink();
    const handle = await tdaTaskPoolPlugin.apply({ storage: backend, invariants: createTdaInvariantRegistry(), session: sink });
    try {
      const ready = await handle.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '待认领任务',
        localPath: 'work/a',
        budget: { tokens: 10 },
      });
      const running = await handle.service.create('human', {
        goalId: 'goal-1' as never,
        subject: '在办任务',
        budget: { tokens: 10 },
      });
      await handle.service.claim('agent', running.id, { expectedRevision: running.revision }, asSessionId('sess-r'));
      // 非 ready/executing 的任务不进注入区
      const parked = await handle.service.create('human', { goalId: 'goal-1' as never, subject: '暂停任务' });
      await handle.service.pause('human', parked.id, { expectedRevision: parked.revision });

      const section = handle.service.promptSection();
      expect(section.id).toBe('task:state');
      expect(section.order.after).toBe('goal:state');
      expect(section.content).toContain('待认领任务');
      expect(section.content).toContain('可认领');
      expect(section.content).toContain('在办任务');
      expect(section.content).toContain('owner=sess-r');
      expect(section.content).not.toContain('暂停任务');
      // 裁剪视图不得泄露全快照细节（路径/描述）
      expect(section.content).not.toContain('work/a');

      // model-visible⟺logged：注入区里的任务必有事件踪迹；域内每个任务亦然
      const logged = new Set(sink.events.map((event) => event.businessId));
      for (const id of [ready.id, running.id]) {
        expect(logged.has(id)).toBe(true);
        expect(section.content).toContain(String(id));
      }
      for (const [key] of handle.domain.table('task_nodes').entries()) {
        expect(logged.has(key)).toBe(true);
      }
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('advisory：writeScopes 重叠只告警不阻断（owner 唯一 + CAS 拒载）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-tp-gate-scope-'));
    const backend = createJsonBackend(dir);
    const bus = createTdaEventBus();
    const handle = await tdaTaskPoolPlugin.apply({
      storage: backend,
      invariants: createTdaInvariantRegistry(),
      session: createFileSessionSink(join(dir, 'session.jsonl'), asSessionId('sess-scope')),
      bus,
    });
    try {
      const a = await handle.service.create('human', {
        goalId: 'goal-1' as never,
        subject: 'A',
        writeScopes: ['src/core'],
        budget: { tokens: 10 },
      });
      const b = await handle.service.create('human', {
        goalId: 'goal-1' as never,
        subject: 'B',
        writeScopes: ['src/core/lexer'],
        budget: { tokens: 10 },
      });
      // 重叠只告警（不阻断：两个任务都已建成）
      const warnings = handle.service.writeScopeWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ prefix: 'src/core' });
      expect(handle.service.list()).toHaveLength(2);
      // CAS 拒载
      const stale = await handle.service
        .edit('human', a.id, { expectedRevision: 99 }, { subject: '旧号' })
        .then(() => undefined, (error: unknown) => error);
      expect(stale).toBeInstanceOf(StaleRevisionError);
      expect(b.id).toBeDefined();
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
