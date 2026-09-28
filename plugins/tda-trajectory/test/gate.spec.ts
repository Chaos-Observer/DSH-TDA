/**
 * tda-trajectory 冒烟门（门4 test:smoke）：T0.7 验收 3/5/6/7 的插件侧载体。
 *
 * （验收 1/2/4/8 需要全插件装配与 kill -9 子进程，落在
 *  `harness/tda-harness/test/resume-smoke.spec.ts` 与 `fork-replay.spec.ts`，
 *  并已挂进 CI 第四门。）
 *
 *  3. **replay-equivalence**：全量 `replayCheck` 零差异；域被篡改/缺失/多出各有可读报告
 *  5. **§5.5 溯源自检**：任取实体 `locate` 给 seq 范围；全量抽样一致；范围内事件与实体对应
 *  6. **log-only 纯净**：`deriveMessages` 不含任何 TDA 事件（自动断言）
 *  7. **resume 判定**：恢复序证据合格/不合格各有判定（closer 数不符、历史被改写）
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, createJsonBackend, deriveMessages, openTdaDomain, tdaEvents } from '@tda/kernel';
import { trajectoryDomainSpec } from '../src/index.ts';
import { createTrajectoryService, type TrajectoryService } from '../src/service.ts';
import { createMemoryHost, createSource } from './helpers.ts';

interface Rig {
  readonly service: TrajectoryService;
  readonly host: ReturnType<typeof createMemoryHost>;
  readonly goals: ReturnType<typeof createSource>;
  readonly tasks: ReturnType<typeof createSource>;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-traj-gate-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(trajectoryDomainSpec, { backend });
  const host = createMemoryHost('sess-traj-gate');
  const goals = createSource('goal', 'goalTree/change');
  const tasks = createSource('task', 'taskPool/change');
  const service = createTrajectoryService({
    domain,
    host,
    sources: [goals, tasks],
    now: () => 1_700_000_000_000,
  });
  return {
    service,
    host,
    goals,
    tasks,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

const session = asSessionId('sess-traj-gate');

/** 造一段会话：两轮 + 三实体变更（含一次同实体再变更）。 */
function seedSession(host: ReturnType<typeof createMemoryHost>): void {
  host.beginTurn(1);
  host.appendMessage({ turn: 0, role: 'user', content: '把协议整理成表格' }, 2);
  host.append({ family: 'goalTree/change', businessId: 'goal-1', payload: { id: 'goal-1', revision: 0 } });
  host.append({ family: 'taskPool/change', businessId: 'task-1', payload: { id: 'task-1', revision: 0 } });
  host.endTurn(3, 0, 'success');
  host.beginTurn(4);
  host.append({ family: 'taskPool/change', businessId: 'task-1', payload: { id: 'task-1', revision: 3 } });
  host.append({ family: 'goalTree/change', businessId: 'goal-2', payload: { id: 'goal-2', revision: 0 } });
  host.endTurn(5, 1, 'success');
}

describe('T0.7 replay-equivalence（验收 3）', () => {
  it('全量 replayCheck 零差异；域篡改/缺失/多出各有可读报告', async () => {
    const rig = await setup();
    try {
      seedSession(rig.host);
      rig.goals.set('goal-1', 0);
      rig.goals.set('goal-2', 0);
      rig.tasks.set('task-1', 3);
      const ok = await rig.service.replayCheck();
      expect(ok).toMatchObject({ ok: true, mismatches: [], missing: [], extra: [] });
      expect(ok.checked).toBe(3);

      // ① 修订号落后（撕裂/漏落）
      rig.tasks.set('task-1', 2);
      const stale = await rig.service.replayCheck();
      expect(stale.ok).toBe(false);
      expect(stale.mismatches[0]).toEqual({ entity: 'task:task-1', expected: 3, actual: 2 });

      // ② 域缺失
      rig.tasks.remove('task-1');
      expect((await rig.service.replayCheck()).missing).toEqual(['task:task-1']);

      // ③ 域多出（幽灵）
      rig.tasks.set('task-1', 3);
      rig.goals.set('goal-ghost', 0);
      expect((await rig.service.replayCheck()).extra).toEqual(['goal:goal-ghost']);

      // ④ 域**超前**（撕裂尾）不计违规但要可读：先域后事件契约允许的方向
      rig.goals.remove('goal-ghost');
      rig.tasks.set('task-1', 4);
      const torn = await rig.service.replayCheck();
      expect(torn.ok).toBe(true);
      expect(torn.mismatches).toEqual([]);
      expect(torn.tornRevisions).toEqual([{ entity: 'task:task-1', expected: 3, actual: 4 }]);

      // ⑤ 区间回放：只回放第一段（轮 0）时不要求后续实体的修订号
      rig.tasks.set('task-1', 3);
      const bounded = await rig.service.replayCheck({ from: 1, to: 3 });
      expect(bounded.mismatches).toEqual([]);
      expect(bounded.missing).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T0.7 溯源自检（验收 5，§5.5）', () => {
  it('任取实体 locate 给 seq 范围；范围内事件与实体变更一一对应', async () => {
    const rig = await setup();
    try {
      seedSession(rig.host);
      for (const record of tdaEvents(rig.host.records())) {
        await rig.service.index({
          family: record.family,
          businessId: record.businessId,
          seq: record.seq,
          sessionId: session,
        });
      }
      // 抽样：task-1 有两次变更 → locate 给一个闭区间（seqFrom=4，seqTo=7）
      const task = rig.service.locate('task', 'task-1');
      expect(task).toHaveLength(1);
      expect(task[0]).toMatchObject({ entityKind: 'task', entityId: 'task-1', seqFrom: 4, seqTo: 7 });
      // 全量：每个实体都能定位，且范围内必然含该实体的 TDA 事件
      const events = tdaEvents(rig.host.records());
      for (const entry of rig.service.entries()) {
        const inRange = events.filter(
          (record) => record.seq >= entry.seqFrom && record.seq <= entry.seqTo && record.businessId === entry.entityId,
        );
        expect(inRange.length).toBeGreaterThan(0);
      }
      expect(rig.service.entries()).toHaveLength(3);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T0.7 log-only 纯净（验收 6，自动断言）', () => {
  it('deriveMessages 不含任何 TDA 事件；事件数与消息数互不干扰', async () => {
    const rig = await setup();
    try {
      seedSession(rig.host);
      const messages = deriveMessages(rig.host.records());
      expect(messages.map((message) => message.content)).toEqual(['把协议整理成表格']);
      const events = tdaEvents(rig.host.records());
      expect(events).toHaveLength(4);
      // 强断言：任何事件的 JSON 载荷都不出现在消息文本里
      const haystack = messages.map((message) => message.content).join('\u0000');
      for (const record of events) {
        expect(haystack).not.toContain(JSON.stringify(record.payload));
      }
      // 事件 seq 与消息 seq 不共享编号空间（各自独立记录，读回时按 seq 排序）
      expect(rig.host.records().length).toBe(events.length + messages.length + 4); // 4 事件 + 1 消息 + 2 turn/start + 2 turn/end
    } finally {
      await rig.dispose();
    }
  });
});

describe('T0.7 resume 判定（验收 1 的判定面）', () => {
  it('开放轮次全部合成 closer → 通过；closer 数不符或历史被改写 → 违规', async () => {
    const rig = await setup();
    try {
      const base = {
        bootAt: 1_700_000_000_000,
        openTurnsBefore: 2,
        synthesizedClosers: 2,
        rebuiltTimers: 3,
        rebuiltPages: 2,
        orphanDispatches: ['dispatch-1'],
        historyRewritten: false,
      };
      const ok = rig.service.resumeCheck(base);
      expect(ok).toMatchObject({ ok: true, orphanDispatches: ['dispatch-1'], rebuiltTimers: 3, synthesizedClosers: 2 });

      const short = rig.service.resumeCheck({ ...base, synthesizedClosers: 1 });
      expect(short.ok).toBe(false);
      expect(short.violations.join(' ')).toContain('恢复序不完整');

      const rewritten = rig.service.resumeCheck({ ...base, historyRewritten: true });
      expect(rewritten.violations.join(' ')).toContain('只追加');

      const negativeTimers = rig.service.resumeCheck({ ...base, rebuiltTimers: -1 });
      expect(negativeTimers.violations.join(' ')).toContain('定时器');
    } finally {
      await rig.dispose();
    }
  });

  it('无开放轮次时零 closer 也合格（干净重启）', async () => {
    const rig = await setup();
    try {
      const report = rig.service.resumeCheck({
        bootAt: 1_700_000_000_000,
        openTurnsBefore: 0,
        synthesizedClosers: 0,
        rebuiltTimers: 0,
        rebuiltPages: 0,
        orphanDispatches: [],
        historyRewritten: false,
      });
      expect(report.ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
