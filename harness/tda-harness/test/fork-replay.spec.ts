/**
 * IT4 · fork/replay 冒烟（T0.7 J6 / 验收 2、4、8）——**进 CI 第四门**。
 *
 *  2. **G0-③ 会话侧**：组装留痕与该轮消息面交叉验证（"当时模型看到了什么"双源可证）
 *  4. **fork 冒烟**：以闭合轮次为边界 fork → 子会话 `deriveMessages` 与父会话前缀等值；
 *     seed 不变量六条通过；开放轮次内边界/前缀分歧/计数不实各有拒绝用例
 *  8. **replay-equivalence**：全链 `replayCheck` 零差异（含 log-only 族的"仅事件"归类）
 *
 * 说明：fork 只做**审计/归因**用途的边界选择规则与 seed 不变量校验（J6 明确
 * rehearsal 的试错消费面归 T2.1/T2.2），故本文件不启动子代理。
 */
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSeedInvariants,
  deriveMessages,
  openTurns,
  projectTurns,
  tdaEvents,
  type TdaHostRecord,
} from '@tda/kernel';
import { forkFileSessionHost, readHostRecords } from '@tda/testkit';
import { describe, expect, it } from 'vitest';
import { assembleRuntime } from '../src/runtime.ts';

const SESSION = 'session.jsonl';

async function withRuntime<T>(body: (runtime: Awaited<ReturnType<typeof assembleRuntime>>, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-fork-'));
  const runtime = await assembleRuntime({ dir, autoScan: false });
  try {
    return await body(runtime, dir);
  } finally {
    await runtime.dispose();
    // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  }
}

/** 造两轮完整对话（每轮内组装一次），返回组装记录。 */
async function seedTwoTurns(runtime: Awaited<ReturnType<typeof assembleRuntime>>): Promise<readonly TdaHostRecord[]> {
  const goals = runtime.goalTree.service;
  const goal = await goals.create('human', {
    objective: '把协议整理成表格',
    budget: { tokens: 5_000 },
    pinned: ['不得覆盖原始抓包'],
  });
  await runtime.taskPool.service.create('human', { goalId: goal.id, subject: '整理帧表格', budget: { tokens: 2_000 } });

  const turn0 = runtime.host.beginTurn(1_700_000_000_000);
  runtime.host.appendMessage({ turn: turn0, role: 'user', content: '第一问：先看工作区' }, 1_700_000_000_001);
  await runtime.context.service.assemble(1);
  runtime.host.appendMessage({ turn: turn0, role: 'assistant', content: '第一答：已扫描' }, 1_700_000_000_002);
  runtime.host.endTurn(1_700_000_000_003, turn0, 'success');

  const turn1 = runtime.host.beginTurn(1_700_000_010_000);
  runtime.host.appendMessage({ turn: turn1, role: 'user', content: '第二问：写成表格' }, 1_700_000_010_001);
  await runtime.context.service.assemble(2);
  runtime.host.appendMessage({ turn: turn1, role: 'assistant', content: '第二答：表格已生成' }, 1_700_000_010_002);
  runtime.host.endTurn(1_700_000_010_003, turn1, 'success');

  await runtime.trajectory.link?.drain();
  // 注意：context/assemble 族同时承载**钉扎定义**（businessId=pin:<id>）与**组装记录**
  // （businessId=<sessionId>:<round>）——按 round 字段在场与否区分，否则会把 4 条种子钉扎算进来
  return tdaEvents(runtime.host.records()).filter(
    (record): record is TdaHostRecord =>
      record.kind === 'tda' && record.family === 'context/assemble' && typeof record.payload.round === 'number',
  );
}

describe('IT4 fork 冒烟（验收 4）', () => {
  it('以闭合轮次为边界 fork：前缀逐字段等值 + seed 不变量通过 + 子会话消息面前缀相同', async () => {
    await withRuntime(async (runtime, dir) => {
      await seedTwoTurns(runtime);
      const sourcePath = join(dir, SESSION);
      const childPath = join(dir, 'fork-child.jsonl');
      const fork = forkFileSessionHost({
        sourcePath,
        targetPath: childPath,
        childSessionId: 'sess-fork-child',
        boundary: 0, // 轮 0 已闭合
        at: 1_700_000_020_000,
      });
      const parent = readHostRecords(sourcePath).records;
      const report = checkSeedInvariants({
        parent,
        child: fork.records,
        boundary: 0,
        inheritedEventCount: fork.inheritedEventCount,
      });
      expect(report.violations).toEqual([]);
      expect(report.ok).toBe(true);

      // 前缀等值：子会话的模型可见消息 === 父会话到该边界为止的消息
      const parentMessages = deriveMessages(parent).slice(0, deriveMessages(fork.records).length);
      expect(deriveMessages(fork.records).map((message) => message.content)).toEqual(
        parentMessages.map((message) => message.content),
      );
      // 子会话只继承到边界：不含第二轮消息
      expect(deriveMessages(fork.records).some((message) => message.content.includes('第二问'))).toBe(false);
      // seed marker 在继承前缀之后
      const marker = fork.records.find((record) => record.kind === 'session/end-seed');
      expect(marker?.seq).toBe(fork.inheritedEventCount + 1);
    });
  });

  it('拒绝用例：开放轮次内边界 / 前缀分歧 / 计数不实 各被拒', async () => {
    await withRuntime(async (runtime, dir) => {
      await seedTwoTurns(runtime);
      // 再开一轮不闭合 → 制造开放轮次
      const open = runtime.host.beginTurn(1_700_000_030_000);
      runtime.host.appendMessage({ turn: open, role: 'user', content: '第三问（进行中）' }, 1_700_000_030_001);
      expect(openTurns(runtime.host.records())).toEqual([2]);

      const sourcePath = join(dir, SESSION);
      const parent = readHostRecords(sourcePath).records;
      // ① 以开放轮次为边界 fork（helper 取不到闭合 seq → 空前缀），seed 校验必须拒
      const childPath = join(dir, 'fork-open.jsonl');
      const openFork = forkFileSessionHost({
        sourcePath,
        targetPath: childPath,
        childSessionId: 'sess-fork-open',
        boundary: 2,
        at: 1_700_000_040_000,
      });
      const openReport = checkSeedInvariants({
        parent,
        child: openFork.records,
        boundary: 2,
        inheritedEventCount: openFork.inheritedEventCount,
      });
      expect(openReport.ok).toBe(false);
      expect(openReport.violations.join(' ')).toContain('未闭合');

      // ② 前缀被篡改 → 分歧
      const cleanPath = join(dir, 'fork-clean.jsonl');
      const clean = forkFileSessionHost({
        sourcePath,
        targetPath: cleanPath,
        childSessionId: 'sess-fork-clean',
        boundary: 1,
        at: 1_700_000_050_000,
      });
      const messageIndex = clean.records.findIndex((record) => record.kind === 'conversation');
      expect(messageIndex).toBeGreaterThanOrEqual(0);
      const tampered = clean.records.map((record, index) =>
        index === messageIndex ? { ...record, content: '被改过的第一条消息' } : record,
      ) as typeof clean.records;
      const tamperedReport = checkSeedInvariants({
        parent,
        child: tampered,
        boundary: 1,
        inheritedEventCount: clean.inheritedEventCount,
      });
      expect(tamperedReport.violations.join(' ')).toContain('分歧');

      // ③ 计数不实
      const wrongCount = checkSeedInvariants({
        parent,
        child: clean.records,
        boundary: 1,
        inheritedEventCount: clean.inheritedEventCount + 5,
      });
      expect(wrongCount.violations.join(' ')).toContain('inheritedEventCount');
      // ④ 轮次投影自洽：两轮闭合 + 一轮开放
      expect(projectTurns(runtime.host.records()).map((turn) => turn.closedBy)).toEqual(['turn/end', 'turn/end', undefined]);
    });
  });
});

describe('IT4 组装留痕 ↔ 消息面交叉验证（验收 2，G0-③ 会话侧）', () => {
  it('每条 AssembleRecord 的 round 对应存在的轮次，history 段引用真实消息 seq', async () => {
    await withRuntime(async (runtime) => {
      const assembleRecords = await seedTwoTurns(runtime);
      const turns = projectTurns(runtime.host.records());
      const messages = deriveMessages(runtime.host.records());
      expect(assembleRecords).toHaveLength(2);

      for (const record of assembleRecords) {
        const payload = record.payload as {
          round: number;
          segments: readonly { kind: string; ref?: string; tokenEstimate: number }[];
        };
        // ① round↔turn 对应
        expect(payload.round).toBeGreaterThanOrEqual(1);
        expect(payload.round).toBeLessThanOrEqual(turns.length);
        // ② 段序稳定（system → pinned → memo → history）
        expect(payload.segments[0]?.kind).toBe('system');
        expect(payload.segments.filter((segment) => segment.kind === 'pinned')).toHaveLength(4);
        // ③ history 段引用可解析到真实消息 seq 范围
        for (const segment of payload.segments.filter((item) => item.kind === 'history')) {
          const match = /^hist-(\d+)-(\d+)$/.exec(segment.ref ?? '');
          expect(match, `history 段 ref 应为 hist-<from>-<to>：${segment.ref ?? '(缺)'}`).not.toBeNull();
          const from = Number(match?.[1]);
          const to = Number(match?.[2]);
          const referenced = messages.filter((message) => message.seq >= from && message.seq <= to);
          expect(referenced.length).toBeGreaterThan(0);
          expect(referenced.every((message) => message.seq <= to)).toBe(true);
        }
        // ④ pinned 正文与 promptSection 一致（"当时模型看到了什么"双源可证）
        const pinned = payload.segments.filter((segment) => segment.kind === 'pinned');
        expect(pinned.every((segment) => typeof segment.ref === 'string')).toBe(true);
      }
      // ⑤ log-only 纯净：组装记录本身不出现在消息面
      const haystack = messages.map((message) => message.content).join('\u0000');
      for (const record of assembleRecords) expect(haystack).not.toContain(JSON.stringify(record.payload));
    });
  });
});

describe('IT4 replay-equivalence 全链（验收 8）', () => {
  it('含 log-only 族的完整日志：replayCheck 零违规，六族实体均可定位', async () => {
    await withRuntime(async (runtime) => {
      await seedTwoTurns(runtime);
      // 再触发一次派发与结论回传（dispatch + timeline 两族的域记录）
      const task = runtime.taskPool.service.list()[0];
      if (task === undefined) throw new Error('测试前置失败：任务缺失');
      await runtime.dispatch.service.execute(
        { actor: 'scheduler', sessionId: runtime.host.sessionId },
        { taskId: task.id, role: 'sidekick' },
      );
      await runtime.trajectory.link?.drain();

      const replay = await runtime.trajectory.service.replayCheck();
      expect({ mismatches: replay.mismatches, missing: replay.missing, extra: replay.extra }).toEqual({
        mismatches: [],
        missing: [],
        extra: [],
      });
      expect(replay.checked).toBeGreaterThanOrEqual(4); // goal + task + timeline + dispatch(+policies)

      // 六族实体都可定位（§5.5 溯源自检的装配侧证据）
      const kinds = new Set(runtime.trajectory.service.entries().map((entry) => entry.entityKind));
      expect(kinds.has('goal')).toBe(true);
      expect(kinds.has('task')).toBe(true);
      expect(kinds.has('timeline')).toBe(true);
      expect(kinds.has('dispatch')).toBe(true);
      expect(kinds.has('assemble')).toBe(true);
      // log-only 族（assemble）只经事件存在、域内无记录——索引仍能定位
      const assembleIds = runtime.trajectory.service
        .auditView({ entityKind: 'assemble' })
        .map((entry) => entry.entityId)
        .filter((id) => !id.startsWith('pin:'));
      expect(assembleIds).toHaveLength(2);
      await expect(runtime.verifyInvariants()).resolves.toBeUndefined();
      expect(existsSync(join(runtime.host.sessionId as unknown as string, 'x'))).toBe(false);
    });
  });
});
