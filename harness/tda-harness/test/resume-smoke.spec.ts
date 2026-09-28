/**
 * IT4 · resume 冒烟（T0.7 J8 / 验收 1、§5.5）——**进 CI 第四门**。
 *
 * kill -9 三场景（G0-② 的会话侧证据）：
 *  A. 轮次执行中：轮次开放、消息已写、context 已组装 → 被杀
 *  B. 工具调用后：一轮完整闭合（含 tool 调用/结果）+ 新一轮开放 → 被杀
 *  C. dispatch 在飞：派发单已 running（run 已发布、owner 已占）→ 被杀
 *
 * 每场景重启后断言（父进程侧，全部可机读）：
 *  1. **历史字节不变**（resume 只追加）：重启后文件以被杀前字节为前缀，且新增段含
 *     `interrupted` closer；
 *  2. **恢复序完整**：`resumeCheck()` 通过（closer 数 == 开放轮次数）；
 *  3. **域与日志一致**：`replayCheck()` 零差异（逐 revision + id 集合）；
 *  4. **派生状态重建**：定时器 / PageTable 计数入证据；
 *  5. **孤儿单显式终态**（场景 C）：派发单落 `settled + error + orphaned`，任务 owner 归还；
 *  6. log-only 纯净：`deriveMessages` 不含任何 TDA 事件。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveMessages, openTurns, tdaEvents } from '@tda/kernel';
import { killAndWait, spawnScenario, waitForControl } from '@tda/testkit';
import { describe, expect, it } from 'vitest';
import { assembleRuntime } from '../src/runtime.ts';

const runtimeDir = fileURLToPath(new URL('../testkit-runtime/', import.meta.url));

/**
 * 场景脚手架：三个脚本共用"装配 + 造目标/任务"前置。
 * 子进程用 Node 类型剥离直跑（`.ts` 显式扩展 + erasable syntax），零转译依赖。
 */
const script = (body: string): string => `
import { asSessionId } from '@tda/kernel';
import { writeControl } from '@tda/testkit';
import { assembleRuntime } from '../src/runtime.ts';

const dir = process.argv[2];
const controlFile = process.argv[3];
let now = 1700000000000;
const clock = () => now;
const runtime = await assembleRuntime({ dir, now: clock, autoScan: false });
const goals = runtime.goalTree.service;
const tasks = runtime.taskPool.service;
${body}
writeControl(controlFile, 'idle');
setInterval(() => {}, 1000);
`;

/** A. 轮次执行中：轮次开放 + 消息已写 + 组装过一次。 */
const TURN_RUNNING_SCRIPT = script(`
const goal = await goals.create('human', {
  objective: '把灯环协议整理成表格',
  budget: { tokens: 5000 },
  pinned: ['不得覆盖原始抓包'],
});
const task = await tasks.create('human', { goalId: goal.id, subject: '整理协议帧表格', budget: { tokens: 2000 } });
const turn = runtime.host.beginTurn(clock());
runtime.host.appendMessage({ turn, role: 'user', content: '把工作区里的协议文档整理成表格' }, clock());
runtime.host.appendMessage({ turn, role: 'assistant', content: '我先扫描工作区' }, clock());
await tasks.claim('agent', task.id, { expectedRevision: task.revision }, asSessionId('sess-runner'));
await runtime.context.service.assemble(1);
`);

/** B. 工具调用后：一轮完整闭合（含 tool 调用/结果）+ 新一轮开放。 */
const AFTER_TOOL_SCRIPT = script(`
const goal = await goals.create('human', { objective: '跑一轮带工具调用的会话', budget: { tokens: 5000 } });
void goal;
const turn0 = runtime.host.beginTurn(clock());
runtime.host.appendMessage({ turn: turn0, role: 'user', content: '读一下 spec.md' }, clock());
runtime.host.appendMessage({ turn: turn0, role: 'assistant', content: '调用 read_file' }, clock());
runtime.host.appendMessage({ turn: turn0, role: 'tool', content: 'read_file: spec.md（已返回头部片段）' }, clock());
runtime.host.appendMessage({ turn: turn0, role: 'assistant', content: '看完了，字段表在第二节' }, clock());
runtime.host.endTurn(clock(), turn0, 'success');
const turn1 = runtime.host.beginTurn(clock());
runtime.host.appendMessage({ turn: turn1, role: 'user', content: '那把它写成表格' }, clock());
`);

/** C. dispatch 在飞：派发单 running（run 已发布、owner 已占），永不自 settle。 */
const DISPATCH_INFLIGHT_SCRIPT = script(`
const caller = { actor: 'scheduler', sessionId: asSessionId('sess-harness-scheduler') };
const goal = await goals.create('human', { objective: '派发在飞时被杀', budget: { tokens: 5000 } });
const task = await tasks.create('human', {
  goalId: goal.id,
  subject: '被派发的任务',
  budget: { tokens: 2000 },
  localPath: 'proj',
});
const order = await runtime.dispatch.service.dispatch(caller, { taskId: task.id, role: 'sidekick' });
const begun = await runtime.dispatch.service.start(caller, order.id, { expectedRevision: order.revision });
if (!begun.started) throw new Error('测试前置失败：派发未开跑');
`);

interface SmokeCase {
  readonly name: string;
  readonly scriptSource: string;
  readonly marker?: string;
}

const sessionPath = (dir: string): string => join(dir, 'session.jsonl');

type Runtime = Awaited<ReturnType<typeof assembleRuntime>>;

/** 跑一个 kill -9 场景：起子进程 → 等控制标记 → 硬杀 → 同目录重装配 → 断言。 */
async function runScenario(
  scenario: SmokeCase,
  assertAfterResume: (resumed: Runtime, dir: string, before: Buffer) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `tda-${scenario.name}-`));
  const controlFile = join(dir, 'control.txt');
  const spawned = spawnScenario({
    runtimeDir,
    scriptName: `${scenario.name}.mjs`,
    scriptSource: scenario.scriptSource,
    args: [dir, controlFile],
  });
  try {
    const ready = await waitForControl(controlFile, scenario.marker ?? 'idle', { timeoutMs: 30_000 });
    expect(ready, spawned.readStderr()).toBe(true);

    const before = existsSync(sessionPath(dir)) ? await readFile(sessionPath(dir)) : Buffer.alloc(0);
    expect(before.length).toBeGreaterThan(0); // 被杀前已有已提交事件
    const outcome = await killAndWait(spawned.child);
    expect(outcome.hardKilled).toBe(true);

    const resumed = await assembleRuntime({ dir });
    try {
      await assertAfterResume(resumed, dir, before);
    } finally {
      await resumed.dispose();
    }
  } finally {
    if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
      await killAndWait(spawned.child).catch(() => undefined);
    }
    // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  }
}

describe('IT4 resume 冒烟 · kill -9 三场景（G0-② 会话侧）', () => {
  it('A 轮次执行中：历史字节不变 + closer 合成 + 域日志一致 + log-only 纯净', async () => {
    await runScenario({ name: 'turn-running', scriptSource: TURN_RUNNING_SCRIPT }, async (resumed, dir, before) => {
      // ① 历史字节不变（resume 只追加）
      const after = await readFile(sessionPath(dir));
      expect(after.subarray(0, before.length).equals(before)).toBe(true);
      expect(after.subarray(before.length).toString('utf8')).toContain('"kind":"interrupted"');
      expect(resumed.resumeEvidence().historyRewritten).toBe(false);

      // ② 恢复序完整：开放轮次 1 个 → 恰合成 1 个 closer
      const evidence = resumed.resumeEvidence();
      expect(evidence.openTurnsBefore).toBe(1);
      expect(evidence.synthesizedClosers).toBe(1);
      const report = resumed.resumeCheck();
      expect(report.ok, report.violations.join('；')).toBe(true);
      expect(openTurns(resumed.host.records())).toEqual([]);

      // ③ 域与日志一致（逐 revision + id 集合）
      //    kill -9 允许**撕裂尾**（"先域后事件"契约下唯一合法偏差方向）：
      //    被杀的瞬间可能正好落在"域已 fsync、事件未 append"之间，于是域超前 ≤1 个修订号。
      //    但"域落后 / 幽灵 / 幽灵实体"一律为真违规——这才是回放等价要守的东西。
      const replay = await resumed.trajectory.service.replayCheck();
      expect({ mismatches: replay.mismatches, missing: replay.missing, extra: replay.extra }).toEqual({
        mismatches: [],
        missing: [],
        extra: [],
      });
      expect(replay.checked).toBeGreaterThan(0);
      expect(replay.tornRevisions.length).toBeLessThanOrEqual(1); // 撕裂窗至多一次未配对提交
      for (const torn of replay.tornRevisions) expect(torn.actual).toBe(torn.expected + 1);

      // ④ 派生状态重建入证据（PageTable 由焦点目标/任务重建）
      expect(evidence.rebuiltPages).toBeGreaterThan(0);

      // ⑤ 组装留痕可回放：AssembleRecord 有索引，且消息面与该轮一致
      // context/assemble 族同时承载钉扎定义（businessId=pin:<id>）与组装记录（sessionId:round）；
      // 这里只看组装记录
      const assembleEntries = resumed.trajectory.service
        .auditView({ entityKind: 'assemble' })
        .filter((entry) => !entry.entityId.startsWith('pin:'));
      expect(assembleEntries).toHaveLength(1);
      expect(deriveMessages(resumed.host.records()).map((message) => message.content)).toEqual([
        '把工作区里的协议文档整理成表格',
        '我先扫描工作区',
      ]);
      // ⑥ log-only 纯净
      const haystack = deriveMessages(resumed.host.records())
        .map((message) => message.content)
        .join('\u0000');
      for (const record of tdaEvents(resumed.host.records())) {
        expect(haystack).not.toContain(JSON.stringify(record.payload));
      }
      // ⑦ 数据面恢复
      expect(resumed.taskPool.service.list()).toHaveLength(1);
      expect(resumed.goalTree.service.tree().map((node) => node.objective)).toEqual(['把灯环协议整理成表格']);
      await expect(resumed.verifyInvariants()).resolves.toBeUndefined();
    });
  }, 90_000);

  it('B 工具调用后：闭合轮次字节不变，开放轮次由 closer 收口', async () => {
    await runScenario({ name: 'after-tool-call', scriptSource: AFTER_TOOL_SCRIPT }, async (resumed, dir, before) => {
      const after = await readFile(sessionPath(dir));
      expect(after.subarray(0, before.length).equals(before)).toBe(true);

      const evidence = resumed.resumeEvidence();
      expect(evidence.openTurnsBefore).toBe(1); // 只有第二轮开放
      expect(evidence.synthesizedClosers).toBe(1);
      const closers = resumed.host.records().filter((record) => record.kind === 'turn/end' || record.kind === 'interrupted');
      expect(closers.map((record) => record.kind)).toEqual(['turn/end', 'interrupted']);

      const messages = deriveMessages(resumed.host.records());
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
      expect(messages).toHaveLength(5);
      expect(resumed.resumeCheck().ok).toBe(true);
      await expect(resumed.verifyInvariants()).resolves.toBeUndefined();
    });
  }, 90_000);

  it('C dispatch 在飞：孤儿单落显式终态 + owner 归还 + 恢复序完整', async () => {
    await runScenario({ name: 'dispatch-inflight', scriptSource: DISPATCH_INFLIGHT_SCRIPT }, async (resumed, dir, before) => {
      const after = await readFile(sessionPath(dir));
      expect(after.subarray(0, before.length).equals(before)).toBe(true);

      // ① 孤儿单被显式收口（C5：不静默悬停）
      const evidence = resumed.resumeEvidence();
      expect(evidence.orphanDispatches).toHaveLength(1);
      const orderId = evidence.orphanDispatches[0] as never;
      const order = resumed.dispatch.service.get(orderId);
      expect(order?.status).toBe('settled');
      expect(order?.result?.outcome).toBe('error');
      expect(order?.result?.orphaned).toBe(true);
      expect(order?.settledAt).toBeDefined();
      // ② 任务 owner 已归还（run 已死，不得留僵尸认领）
      expect(resumed.taskPool.service.list()[0]?.ownerId).toBeUndefined();
      // ③ 恢复序完整 + 域日志一致（收口追加的事件也在日志里）
      expect(resumed.resumeCheck().ok).toBe(true);
      const replay = await resumed.trajectory.service.replayCheck();
      expect({ mismatches: replay.mismatches, missing: replay.missing, extra: replay.extra }).toEqual({
        mismatches: [],
        missing: [],
        extra: [],
      });
      // ④ 在途集合清空
      expect(
        resumed.dispatch.service.list().filter((item) => item.status === 'running' || item.status === 'starting'),
      ).toEqual([]);
      await expect(resumed.verifyInvariants()).resolves.toBeUndefined();
    });
  }, 90_000);

  it('干净重启（无开放轮次、无孤儿）：closer/孤儿均为 0，恢复序仍完整', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-clean-boot-'));
    const controlFile = join(dir, 'control.txt');
    const spawned = spawnScenario({
      runtimeDir,
      scriptName: 'clean-boot.mjs',
      scriptSource: script(`
const goal = await goals.create('human', { objective: '干净停机', budget: { tokens: 1000 } });
await tasks.create('human', { goalId: goal.id, subject: '任务甲' });
`),
      args: [dir, controlFile],
    });
    try {
      expect(await waitForControl(controlFile, 'idle', { timeoutMs: 30_000 }), spawned.readStderr()).toBe(true);
      await killAndWait(spawned.child);
      const resumed = await assembleRuntime({ dir });
      try {
        const evidence = resumed.resumeEvidence();
        expect(evidence.openTurnsBefore).toBe(0);
        expect(evidence.synthesizedClosers).toBe(0);
        expect(evidence.orphanDispatches).toEqual([]);
        expect(resumed.resumeCheck().ok).toBe(true);
        await expect(resumed.verifyInvariants()).resolves.toBeUndefined();
      } finally {
        await resumed.dispose();
      }
    } finally {
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  }, 90_000);
});
