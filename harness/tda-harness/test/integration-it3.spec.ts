/**
 * IT3 集成门：真装配（timeline + goal-state + task-pool + dispatch + workspace + context
 * 共用一个 registry/总线/目录）下的跨插件闭环与隔离语义。
 *
 * 与各插件自带门的分工：插件门验证"插件自身"的规格符合性（用 stub seam 单飞），
 * 本文件验证**装配后**才暴露的语义——IT3 的装配面比 IT2 更宽（六条跨插件依赖、
 * 两处装配层桥接），因此这里同时是"seam 桥接正确性"的回归门。
 *
 *  1. 全链路：目标 → 任务（localPath）→ tick 开窗 → 时点扫描 → Sidekick 标注（经
 *     T0.5 派发门）→ 结论回传时间线 → context 组装（pinned 在场）
 *  2. G0-⑤ 零泄漏：子代理原始输出不进主上下文（只以摘要 + entryId 引用存在）
 *  3. G0-④ pinned 在场：pressure/overflow 遮蔽后 C6 四类逐字节仍在
 *  4. 派发并发帽 + pump：超帽入队，settle 后由 tick 排空
 *  5. 持久化：dispose 后同目录重装配，图谱/扫描历史/派发记录原样 + 不变量复验
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSessionId, type TaskId } from '@tda/kernel';
import { createScriptedProvider, type SubagentStartRequest, type SubagentResultLike } from 'tda-subagent-dispatch';
import { describe, expect, it } from 'vitest';
import { assembleRuntime } from '../src/runtime.ts';

const SECRET_BODY = 'BODY_SECRET_MARKER_4f2';

function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** 单脚本双形态：标注请求（schema 含 files）返回文件标注，其余返回普通结论。 */
function respondBySchema(req: SubagentStartRequest): SubagentResultLike {
  if (req.outputSchema.required?.includes('files') === true) {
    return {
      stopReason: 'completed',
      structured: {
        findings: ['工作区扫描完成'],
        confidence: 0.8,
        files: [
          { path: 'proj/spec.md', role: 'doc', credibilityHint: 'authoritative-likely' },
          { path: 'proj/detail.md', role: 'doc', credibilityHint: 'draft-likely' },
        ],
        edges: [{ from: 'proj/spec.md', to: 'proj/detail.md', kind: 'related-to', confidence: 0.7, evidence: '同属协议说明' }],
        notes: ['spec 与 detail 同属一份说明'],
      },
      usage: { tokens: 40, toolCalls: 2, wallClockMs: 10 },
    };
  }
  return {
    stopReason: 'completed',
    structured: { findings: ['结论 A'], confidence: 0.9 },
    usage: { tokens: 20, toolCalls: 1, wallClockMs: 5 },
  };
}

async function seedWorkspace(root: string): Promise<void> {
  await mkdir(join(root, 'proj', 'src'), { recursive: true });
  await mkdir(join(root, 'proj', 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'proj', 'spec.md'), `# 协议说明\n\n${SECRET_BODY}\n\n[细节](./detail.md)\n`, 'utf8');
  await writeFile(join(root, 'proj', 'detail.md'), '# 细节\n\n字段表\n', 'utf8');
  await writeFile(join(root, 'proj', 'src', 'main.ts'), "import { helper } from './helper';\nexport const main = () => helper();\n", 'utf8');
  await writeFile(join(root, 'proj', 'src', 'helper.ts'), 'export const helper = () => 1;\n', 'utf8');
  await writeFile(join(root, 'proj', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
}

describe('IT3 集成：dispatch × workspace × context 装配后闭环', () => {
  it('全链路：tick 开窗 → 时点扫描 → Sidekick 标注 → 结论入时间线 → 组装（pinned 在场 + 零泄漏）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-it3-'));
    const clock = createClock();
    await seedWorkspace(dir);
    const runtime = await assembleRuntime({
      dir,
      now: clock.now,
      subagents: createScriptedProvider({ respond: respondBySchema }),
    });
    try {
      const goals = runtime.goalTree.service;
      const tasks = runtime.taskPool.service;

      const goal = await goals.create('human', {
        objective: '把灯环协议整理成可复用文档',
        completionCriteria: ['帧格式表格齐全'],
        budget: { tokens: 10_000 },
        pinned: ['不得覆盖原始抓包数据'],
      });
      const task = await tasks.create('human', {
        goalId: goal.id,
        subject: '整理协议帧表格',
        localPath: 'proj',
        budget: { tokens: 5_000 },
        recurrence: { kind: 'interval', intervalMs: 1_000, maxRuns: 1 },
      });

      // ① tick：开 run 窗口（stage → executing，触发 workspace 时点扫描）并落定
      const first = await runtime.tick();
      expect(first.due).toBe(1);
      expect(first.startedRuns).toEqual([task.id]);
      const opened = tasks.get(task.id);
      expect(opened?.stage).toBe('executing');
      expect(opened?.ownerId).toBe('sess-harness-scheduler');

      // ② 时点扫描：本地 inventory + 经 T0.5 的 Sidekick 标注
      const runs = runtime.workspace.service.runs(task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('recorded');
      const files = runtime.workspace.service.files(task.id).map((file) => file.path);
      expect(files).toContain('proj/spec.md');
      expect(files).toContain('proj/src/helper.ts');
      expect(files.some((path) => path.includes('node_modules'))).toBe(false);
      // 显性依赖边（本地确定性解析）
      expect(
        runtime.workspace.service
          .edges(task.id, { kind: 'depends-on' })
          .map((edge) => `${edge.from}->${edge.to}`),
      ).toContain('proj/src/main.ts->proj/src/helper.ts');
      // 模型标注覆盖了确定性初判（credibilityHint 来自 Sidekick）
      expect(runtime.workspace.service.files(task.id).find((file) => file.path === 'proj/spec.md')?.credibilityHint).toBe(
        'authoritative-likely',
      );
      expect(runtime.workspace.service.edges(task.id, { kind: 'related-to' })).toHaveLength(1);

      // ③ 派发记录：标注走的是 dispatch（sidekick + 工作区标注 schema）
      const orders = runtime.dispatch.service.list({ taskId: task.id });
      expect(orders).toHaveLength(1);
      expect(orders[0]?.status).toBe('settled');
      expect(orders[0]?.outputSchemaId).toBe('sidekick-workspace-annotation');
      expect(orders[0]?.result?.outcome).toBe('conclusion');
      expect(orders[0]?.maxDepth).toBe(0);
      // 结论三维消耗汇入任务预算（J8）
      expect((tasks.get(task.id)?.budget.consumed.tokens ?? 0)).toBeGreaterThanOrEqual(40);

      // ④ 结论回传双落点：时间线 chunk（model-produced）+ dispatch 记录
      const entries = runtime.timeline.service.current({ relatedTaskId: task.id });
      expect(entries.some((entry) => entry.credential === 'execution-verified')).toBe(true);
      expect(entries.some((entry) => entry.credential === 'model-produced')).toBe(true);

      // ⑤ G0-⑤ 零泄漏：主上下文（组装文本）不含文件正文；dispatch 记录只有摘要
      const assembled = await runtime.context.service.assemble(1);
      expect(assembled.text).not.toContain(SECRET_BODY);
      const order = orders[0];
      expect(order?.result?.summary?.findings).toEqual(['工作区扫描完成']);
      expect(JSON.stringify(order)).not.toContain('credibilityHint');
      expect(JSON.stringify(order)).not.toContain('同属协议说明');
      // 结论摘要视图只给 findings/confidence/entryId 引用
      const view = runtime.dispatch.service.conclusionOf(order?.id as never);
      expect(Object.keys(view ?? {}).sort()).toEqual(['confidence', 'entryId', 'findings', 'outcome', 'role', 'taskId']);

      // ⑥ 组装：pinned 四类在场（C6），memo 含焦点任务，段序稳定
      const pinned = assembled.segments.filter((segment) => segment.kind === 'pinned').map((segment) => segment.text);
      expect(pinned).toHaveLength(4);
      expect(assembled.text).toContain('把灯环协议整理成可复用文档');
      expect(assembled.text).toContain('不得覆盖原始抓包数据');
      expect(assembled.text).toContain('整理协议帧表格');
      expect(assembled.segments.map((segment) => segment.kind)[0]).toBe('system');
      expect(assembled.record.gate?.mode).toBe('static');
      expect(runtime.context.service.promptSection().content.split('\n')).toEqual(pinned);

      await expect(runtime.verifyInvariants()).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('G0-④：pressure/overflow 遮蔽后 pinned 逐字节仍在，且前缀稳定', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-it3-pin-'));
    const clock = createClock();
    const runtime = await assembleRuntime({ dir, now: clock.now, autoScan: false, contextBudgetTokens: 400 });
    try {
      const goals = runtime.goalTree.service;
      const goal = await goals.create('human', {
        objective: '压缩不得吃掉约束',
        completionCriteria: ['约束保持率 100%'],
        budget: { tokens: 5_000 },
        pinned: ['必须先脱敏再入库'],
      });
      for (let index = 0; index < 20; index += 1) {
        runtime.context.service.promptSection();
      }
      const base = await runtime.context.service.assemble(1);
      const pinnedBase = base.segments.filter((segment) => segment.kind === 'pinned').map((segment) => segment.text);
      // 同一 focus 下连续组装：稳定前缀逐字节相同
      const second = await runtime.context.service.assemble(2);
      const prefixOf = (assembled: typeof base): string[] =>
        assembled.segments.filter((segment) => ['system', 'pinned', 'memo'].includes(segment.kind)).map((segment) => segment.text);
      expect(prefixOf(second)).toEqual(prefixOf(base));
      expect(second.segments.filter((segment) => segment.kind === 'pinned').map((segment) => segment.text)).toEqual(pinnedBase);
      expect(second.text).toContain('必须先脱敏再入库');
      expect(goal.id).toBe(String(goals.focusView()?.id));
      await expect(runtime.verifyInvariants()).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('派发并发帽与 pump：超帽入队，settle 后由 tick 排空', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-it3-cap-'));
    const clock = createClock();
    const runtime = await assembleRuntime({
      dir,
      now: clock.now,
      subagents: createScriptedProvider({ respond: respondBySchema }),
      dispatchMaxParallel: 1,
      autoScan: false,
    });
    const caller = { actor: 'scheduler' as const, sessionId: asSessionId('sess-harness-scheduler') };
    try {
      const goals = runtime.goalTree.service;
      const tasks = runtime.taskPool.service;
      const goal = await goals.create('human', { objective: '并发帽验证', budget: { tokens: 5_000 } });
      const taskA = await tasks.create('human', { goalId: goal.id, subject: 'A', budget: { tokens: 1_000 } });
      const taskB = await tasks.create('human', { goalId: goal.id, subject: 'B', budget: { tokens: 1_000 } });

      const orderA = await runtime.dispatch.service.dispatch(caller, { taskId: taskA.id as TaskId, role: 'sidekick' });
      const orderB = await runtime.dispatch.service.dispatch(caller, { taskId: taskB.id as TaskId, role: 'sidekick' });
      const begunA = await runtime.dispatch.service.start(caller, orderA.id, { expectedRevision: orderA.revision });
      expect(begunA.started).toBe(true);
      const begunB = await runtime.dispatch.service.start(caller, orderB.id, { expectedRevision: orderB.revision });
      expect(begunB.started).toBe(false);
      expect(begunB.queued).toBe(true);

      await runtime.dispatch.service.settle(caller, begunA.order.id, { expectedRevision: begunA.order.revision });
      const ticked = await runtime.tick();
      expect(ticked.dispatched).toEqual([String(orderB.id)]);
      expect(runtime.dispatch.service.get(orderB.id)?.status).toBe('running');
      await expect(runtime.verifyInvariants()).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('持久化：同目录重装配后图谱/扫描历史/派发记录原样，不变量复验通过', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-it3-persist-'));
    const clock = createClock();
    await seedWorkspace(dir);
    const runtime = await assembleRuntime({
      dir,
      now: clock.now,
      subagents: createScriptedProvider({ respond: respondBySchema }),
    });
    try {
      const goals = runtime.goalTree.service;
      const tasks = runtime.taskPool.service;
      const goal = await goals.create('human', { objective: '重启不丢', budget: { tokens: 5_000 } });
      const task = await tasks.create('human', {
        goalId: goal.id,
        subject: '扫描一次',
        localPath: 'proj',
        budget: { tokens: 2_000 },
        recurrence: { kind: 'interval', intervalMs: 1_000, maxRuns: 1 },
      });
      await runtime.tick();
      const filesBefore = runtime.workspace.service.files(task.id);
      expect(filesBefore.length).toBeGreaterThan(0);
      const ordersBefore = runtime.dispatch.service.list({ taskId: task.id });
      await runtime.dispose();

      const reopened = await assembleRuntime({
        dir,
        now: clock.now,
        subagents: createScriptedProvider({ respond: respondBySchema }),
      });
      try {
        expect(reopened.workspace.service.files(task.id)).toEqual(filesBefore);
        expect(reopened.workspace.service.runs(task.id)).toHaveLength(1);
        expect(reopened.dispatch.service.list({ taskId: task.id })).toEqual(ordersBefore);
        expect(reopened.taskPool.service.runs(task.id)).toHaveLength(1);
        await expect(reopened.verifyInvariants()).resolves.toBeUndefined();
        // 重启后在途单已被显式收口（无 orphan 残留）
        expect(
          reopened.dispatch.service.list().filter((order) => order.status === 'running' || order.status === 'starting'),
        ).toEqual([]);
      } finally {
        await reopened.dispose();
      }
    } finally {
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
