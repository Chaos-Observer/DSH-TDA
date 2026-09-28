/**
 * tda-goal-state 冒烟门（门4 test:smoke）：IT1 / T0.1 验收载体（G0-② 数据面侧）。
 *
 *  1. 进程内装配：tdaGoalStatePlugin.apply → 建树/focus/consume/block/resume/complete
 *     → 两级不变量过 → STALE 拒载 → dispose
 *  2. idle-kill：op 全部完成后 kill -9 → 重启后五表状态（树/焦点/预算/快照/history）
 *     原样恢复 + log↔domain 配对零差异 + replay-equivalence + 不变量复验
 *  3. phase×stage 全走通 + model-visible⟺logged 自检（prompt section 反映的焦点
 *     必有对应事件；域内每个目标都有事件踪迹）
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
  createTdaInvariantRegistry,
  openTdaDomain,
  StaleRevisionError,
  registerTdaInvariants,
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
import { goalStateDomainSpec, tdaGoalStatePlugin, type GoalTables } from '../src/index.ts';
import { registerGoalStateInvariants } from '../src/loadChecks.ts';

const runtimeDir = fileURLToPath(new URL('../testkit-runtime/', import.meta.url));

/** 内存 session sink（model-visible⟺logged 自检用；append 分配自增 seq）。 */
function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-gate'),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

/**
 * idle 场景：经插件 apply 装配（真实出口路径），走完整 op 集后写 idle 保活等杀。
 * 每次 root op 前重新取 revision——复合 op（focus 让渡/consume 汇聚）会推进
 * 祖先 revision，硬编码期望号会误踩 STALE。
 */
const IDLE_SCRIPT = `
import { asSessionId, createJsonBackend, createTdaInvariantRegistry } from '@tda/kernel';
import { createFileSessionSink, writeControl } from '@tda/testkit';
import { tdaGoalStatePlugin } from '../src/index.ts';

const dir = process.argv[2];
const controlFile = process.argv[3];
const backend = createJsonBackend(dir);
const registry = createTdaInvariantRegistry();
const sink = createFileSessionSink(dir + '/session.jsonl', asSessionId('sess-gs-idle'));
const handle = await tdaGoalStatePlugin.apply({ storage: backend, invariants: registry, session: sink });
const svc = handle.service;

const root = await svc.create('human', { objective: '根目标', budget: { tokens: 1000 }, pinned: ['C6-1'] });
const child = await svc.create('human', { objective: '子目标', parentId: root.id, budget: { tokens: 400 } });
const focused = await svc.focus('agent', child.id, { expectedRevision: child.revision });
await svc.consume('agent', child.id, { expectedRevision: focused.revision }, { tokens: 50 });
const blocked = await svc.block('scheduler', root.id, { expectedRevision: svc.get(root.id).revision }, { code: 'WAIT_INPUT', message: '等输入' });
await svc.resume('human', root.id, { expectedRevision: blocked.revision });
await svc.edit('agent', child.id, { expectedRevision: svc.get(child.id).revision }, { objective: '子目标（改写）', reason: '细化范围' });
await registry.verify();
writeControl(controlFile, 'idle');
setInterval(() => {}, 1000);
`;

describe('tda-goal-state 冒烟门', () => {
  it('进程内装配：apply → 建树/focus/consume/block/resume/complete → 两级不变量过 → STALE 拒载 → dispose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-gs-gate-asm-'));
    const registry = createTdaInvariantRegistry();
    const backend = createJsonBackend(dir);
    const handle = await tdaGoalStatePlugin.apply({
      storage: backend,
      invariants: registry,
      session: createFileSessionSink(join(dir, 'session.jsonl'), asSessionId('sess-gate-asm')),
    });
    try {
      const root = await handle.service.create('human', { objective: '目标甲', budget: { tokens: 100 } });
      const child = await handle.service.create('human', { objective: '目标乙', parentId: root.id, budget: { tokens: 40 } });
      const focused = await handle.service.focus('agent', child.id, { expectedRevision: child.revision });
      await handle.service.consume('agent', child.id, { expectedRevision: focused.revision }, { tokens: 10 });
      // 复合 op 会推进祖先 revision（focus 让渡 + consume 汇聚），block 前重取
      const rootFresh = handle.service.get(root.id);
      if (rootFresh === undefined) throw new Error('测试前置失败：root 不存在');
      const blocked = await handle.service.block('scheduler', root.id, { expectedRevision: rootFresh.revision }, { code: 'WAIT_INPUT', message: '等输入' });
      const resumed = await handle.service.resume('human', root.id, { expectedRevision: blocked.revision });
      const done = await handle.service.complete('human', root.id, { expectedRevision: resumed.revision }, 'success');
      expect(done.phase).toBe('complete');
      await expect(registry.verify()).resolves.toBeUndefined();
      // CAS 拒载：拿旧期望号（0）edit 已推进到 rev 2 的 child（非终态，直达 cas）
      const error = await handle.service.edit('agent', child.id, { expectedRevision: 0 }, { objective: '旧号编辑' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StaleRevisionError);
      expect((error as StaleRevisionError).code).toBe('STALE_REVISION');
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('idle-kill：kill -9 → 重启后五表状态原样 + 配对零差异 + replay 等值 + 不变量复验', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-gs-gate-idle-'));
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

      // 日志：9 个事件（root: create/focus-release/consume-rollup/block/resume；
      // child: create/focus/consume/edit），无撕裂尾
      const { events, tornTail } = readSessionLog(join(dir, 'session.jsonl'));
      expect(events).toHaveLength(9);
      expect(tornTail).toBe(false);

      // 重启：状态原样恢复
      const backend = createJsonBackend(dir);
      const domain = await openTdaDomain(goalStateDomainSpec, { backend });
      try {
        const goals = domain.table('goal_nodes');
        expect(goals.size()).toBe(2);
        const root = goals.get('goal-1');
        const child = goals.get('goal-2');
        expect(root).toBeDefined();
        expect(child).toBeDefined();
        if (root === undefined || child === undefined) return;
        // 预算：child 耗 50，root 经 consume-rollup 同耗 50（账本向上汇聚）
        expect(child.budget.consumed.tokens).toBe(50);
        expect(root.budget.consumed.tokens).toBe(50);
        // 相位：root 经 block→resume 回 active 且理由已清；child 全程 active
        expect(root.phase).toBe('active');
        expect(root.blockedReason).toBeUndefined();
        expect(child.phase).toBe('active');
        // 焦点：恰 child（root 已让渡）
        expect(child.focus).toBe(true);
        expect(root.focus).toBe(false);
        // objective 改写已落
        expect(child.objective).toBe('子目标（改写）');
        // revision 推进（root 5 次 accepted、child 4 次）
        expect(root.revision).toBe(4);
        expect(child.revision).toBe(3);

        // 配对：goal_nodes 键 ↔ 事件 businessId 零差异
        expect(pairLogAgainstDomain(events, goals.keys()).ok).toBe(true);
        // replay-equivalence：事件载荷（全快照）重放 == 域现状
        assertReplayEquivalence(
          compareReplay(events, goals.entries(), (event) => ({ key: event.businessId, value: event.payload })),
        );

        // 其余四表原样
        expect(domain.table('constraint_snapshots').size()).toBe(2);
        expect(domain.table('constraint_snapshots').get('goal-1')?.pinned).toEqual(['C6-1']);
        expect(domain.table('constraint_snapshots').get('goal-2')?.pinned).toEqual([]);
        expect(domain.table('objective_edits').size()).toBe(1);
        const history = domain.table('goal_history');
        expect(history.size()).toBe(9);
        expect(history.get('goal-1#4')?.operation).toBe('resume');
        expect(history.get('goal-2#3')?.operation).toBe('edit');
        expect(domain.table('calibrations').size()).toBe(0);
      } finally {
        await domain.close();
        await backend.close();
      }

      // 重启后两级不变量复验（树三查 + 双写配对）
      const registry = createTdaInvariantRegistry();
      const reconciler = createDualWriteReconciler();
      const backend2 = createJsonBackend(dir);
      const domain2: TdaDomain<GoalTables> = await openTdaDomain(goalStateDomainSpec, {
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
        registerGoalStateInvariants(registry, domain2);
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

  it('phase×stage 全走通 + model-visible⟺logged 自检', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-gs-gate-phase-'));
    const registry = createTdaInvariantRegistry();
    const backend = createJsonBackend(dir);
    const sink = createMemorySink();
    const handle = await tdaGoalStatePlugin.apply({ storage: backend, invariants: registry, session: sink });
    try {
      const goal = await handle.service.create('human', { objective: '阶段 walk' });
      expect(goal.stage).toBe('planning');
      // stage 四子态在 active 下逐个推进
      const executing = await handle.service.edit('agent', goal.id, { expectedRevision: goal.revision }, { stage: 'executing' });
      const waiting = await handle.service.edit('agent', goal.id, { expectedRevision: executing.revision }, { stage: 'waiting' });
      const verifying = await handle.service.edit('agent', goal.id, { expectedRevision: waiting.revision }, { stage: 'verifying' });
      expect(verifying.stage).toBe('verifying');
      // phase 四态：active → paused → active → blocked → active → complete
      const paused = await handle.service.pause('human', goal.id, { expectedRevision: verifying.revision });
      const resumed = await handle.service.resume('human', goal.id, { expectedRevision: paused.revision });
      const blocked = await handle.service.block('scheduler', goal.id, { expectedRevision: resumed.revision }, { code: 'WAIT_INPUT', message: '等输入' });
      const resumed2 = await handle.service.resume('human', goal.id, { expectedRevision: blocked.revision });
      // 非 active 期间 stage 保留最后值（不参与路由）
      expect(resumed2.stage).toBe('verifying');
      const done = await handle.service.complete('human', goal.id, { expectedRevision: resumed2.revision }, 'success');
      expect(done.phase).toBe('complete');
      expect(done.stage).toBe('verifying');

      // model-visible⟺logged：prompt section 反映的焦点有事件踪迹；
      // 域内每个目标（含 complete）都能在日志中找到对应事件
      const view = handle.service.focusView();
      expect(view?.id).toBe(goal.id);
      const loggedIds = new Set(sink.events.map((event) => event.businessId));
      expect(loggedIds.has(view?.id ?? '')).toBe(true);
      for (const [key] of handle.domain.table('goal_nodes').entries()) {
        expect(loggedIds.has(key)).toBe(true);
      }
      const section = handle.service.promptSection();
      expect(section.id).toBe('goal:state');
      expect(section.order.after).toBe('plan:policy');
      expect(section.content).toContain('阶段 walk');
      expect(section.content).toContain('complete/verifying');
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await handle.dispose();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
