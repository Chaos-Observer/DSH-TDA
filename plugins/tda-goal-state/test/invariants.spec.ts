/**
 * tda-goal-state 不变量门（门2 test:invariants）：两级注册，违规即抛 InvariantError。
 *
 *  - 合法数据：服务走双写器建父子树 + focus 切换 + consume + block/resume/complete
 *    → 内核级（双写配对）+ 插件级（树三查：无环/单焦点/预算守恒）全过
 *  - 树完整：注入悬挂父 / 父环 → verify('tda-goal-state') 抛
 *  - 单焦点：注入双焦点 → 抛
 *  - 预算守恒：服务路径超父剩余拒（BUDGET_EXCEEDED）；注入子帽之和超父帽 → 抛
 *  - CAS 严格：并发 consume 同期望 revision → 恰一成功、一 STALE_REVISION
 *  - schema 恒等律：complete 缺 outcome 打开即拒（reject）；paused 携 blockedReason 拒
 *  - 迁移守卫：paused/blocked 再 pause/block、非 active 直接 complete → INVALID_TRANSITION；
 *    终态（complete/clear）再变更 → GOAL_COMPLETE / GOAL_CLEARED
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asGoalId,
  asSessionId,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaInvariantRegistry,
  InvariantError,
  openTdaDomain,
  registerTdaInvariants,
  StaleRevisionError,
  TDA_KERNEL_PACKAGE,
  type TdaDomain,
  type TdaInvariantRegistry,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import { goalStateDomainSpec, type GoalNode, type GoalTables } from '../src/domain.ts';
import { createGoalTreeService, type GoalTreeService } from '../src/service.ts';
import { registerGoalStateInvariants } from '../src/loadChecks.ts';

/** 内存 session sink（与内核单测同构；append 分配自增 seq）。 */
function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-inv'),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<GoalTables>;
  readonly registry: TdaInvariantRegistry;
  readonly service: GoalTreeService;
}

/** 装配一套目标树插件运行时（域 + 双写对账 + 两级不变量注册 + 服务）。 */
async function assemble(dir: string): Promise<Rig> {
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const registry = createTdaInvariantRegistry();
  const domain = await openTdaDomain(goalStateDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  // 两级注册：内核级（@tda/kernel）+ 插件级（tda-goal-state）
  registerTdaInvariants(registry, reconciler);
  registerGoalStateInvariants(registry, domain);
  const service = createGoalTreeService({
    domain,
    session: createMemorySink(),
    reconciler,
    index: createAuditIndex(),
  });
  return { dir, backend, domain, registry, service };
}

async function teardown(rig: Rig): Promise<void> {
  await rig.domain.close();
  await rig.backend.close();
  // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', rig.dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

/** 合法 GoalNode 基件（注入用例用；zod 合法、树结构违规）。 */
const baseNode = (id: string, over: Partial<GoalNode> = {}): GoalNode => ({
  id: asGoalId(id),
  revision: 0,
  objective: `目标 ${id}`,
  completionCriteria: [],
  phase: 'active',
  stage: 'planning',
  maxGoalRounds: 50,
  roundsStarted: 0,
  budget: { consumed: { tokens: 0, wallClockMs: 0, attentionUnits: 0 } },
  focus: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('tda-goal-state 不变量门', () => {
  it('合法数据：服务全路径（建树/focus/consume/block/resume/complete）→ 两级不变量全过', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-ok-')));
    try {
      const root = await rig.service.create('human', { objective: '根目标', budget: { tokens: 1000 } });
      const child = await rig.service.create('human', {
        objective: '子目标',
        parentId: root.id,
        budget: { tokens: 400 },
      });
      // 焦点切换：让渡根 → 聚焦子
      const focused = await rig.service.focus('agent', child.id, { expectedRevision: child.revision });
      // 消耗 + 祖先汇聚
      await rig.service.consume('agent', child.id, { expectedRevision: focused.revision }, { tokens: 50 });
      // phase×stage 走通：block → resume → complete（复合 op 会推进 root revision，重取）
      const rootNow = rig.service.get(root.id);
      if (rootNow === undefined) throw new Error('测试前置失败：root 不存在');
      const blocked = await rig.service.block('agent', root.id, {
        expectedRevision: rootNow.revision,
      }, { code: 'WAIT_INPUT', message: '等人工输入' });
      expect(blocked.phase).toBe('blocked');
      const resumed = await rig.service.resume('human', root.id, { expectedRevision: blocked.revision });
      expect(resumed.phase).toBe('active');
      expect(resumed.blockedReason).toBeUndefined();
      const done = await rig.service.complete('human', root.id, { expectedRevision: resumed.revision }, 'success');
      expect(done.phase).toBe('complete');
      expect(done.outcome).toBe('success');
      await expect(rig.registry.verify()).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('树完整：注入悬挂父引用 → 拒绝', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-dangling-')));
    try {
      await rig.domain.table('goal_nodes').put('goal-1', baseNode('goal-1', { parentId: 'goal-99' }));
      await expect(rig.registry.verify('tda-goal-state')).rejects.toBeInstanceOf(InvariantError);
      await expect(rig.registry.verify('tda-goal-state')).rejects.toThrow(/不存在/);
    } finally {
      await teardown(rig);
    }
  });

  it('树完整：注入父环 → 拒绝', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-cycle-')));
    try {
      await rig.domain.table('goal_nodes').put('goal-1', baseNode('goal-1', { parentId: 'goal-2' }));
      await rig.domain.table('goal_nodes').put('goal-2', baseNode('goal-2', { parentId: 'goal-1' }));
      await expect(rig.registry.verify('tda-goal-state')).rejects.toThrow(/父环/);
    } finally {
      await teardown(rig);
    }
  });

  it('单焦点：注入双焦点 → 拒绝；服务路径维持恰一', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-focus-')));
    try {
      // 双焦点必须在同一棵树内才违规（根各自成树时每树恰一是合法的）
      await rig.domain.table('goal_nodes').put('goal-1', baseNode('goal-1', { focus: true }));
      await rig.domain.table('goal_nodes').put('goal-2', baseNode('goal-2', { parentId: 'goal-1', focus: true }));
      await expect(rig.registry.verify('tda-goal-state')).rejects.toThrow(/焦点/);
    } finally {
      await teardown(rig);
    }
    // 服务路径：单树内根即焦点，focus 切换让渡旧焦点 → 恰一
        const rig2 = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-focus2-')));
        try {
          const a = await rig2.service.create('human', { objective: '甲' });
          const b = await rig2.service.create('human', { objective: '乙', parentId: a.id });
          expect(rig2.service.focusView()?.id).toBe(a.id);
          await rig2.service.focus('agent', b.id, { expectedRevision: b.revision });
          const focused = [...rig2.domain.table('goal_nodes').entries()].filter(([, n]) => n.focus);
          expect(focused).toHaveLength(1);
          expect(focused[0]?.[1].id).toBe(b.id);
          await expect(rig2.registry.verify()).resolves.toBeUndefined();
        } finally {
          await teardown(rig2);
        }
  });

  it('预算守恒：服务路径超父剩余即拒（分配时检查）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-budget-')));
    try {
      const root = await rig.service.create('human', { objective: '根', budget: { tokens: 100 } });
      await rig.service.create('human', { objective: '子一', parentId: root.id, budget: { tokens: 60 } });
      await expect(
        rig.service.create('human', { objective: '子二', parentId: root.id, budget: { tokens: 60 } }),
      ).rejects.toThrow(/BUDGET_EXCEEDED|预算守恒/);
      // 消耗后剩余更紧：再耗 50，剩余 40，子帽 60 的挂接同样被拒
      await rig.service.consume('agent', root.id, { expectedRevision: root.revision }, { tokens: 50 });
      await expect(
        rig.service.create('human', { objective: '子三', parentId: root.id, budget: { tokens: 60 } }),
      ).rejects.toThrow(/预算守恒/);
    } finally {
      await teardown(rig);
    }
  });

  it('预算守恒：注入子帽之和超父帽 → 加载期拒绝', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-budget2-')));
    try {
      await rig.domain
        .table('goal_nodes')
        .put('goal-1', baseNode('goal-1', { focus: true, budget: { tokens: 100, consumed: { tokens: 0, wallClockMs: 0, attentionUnits: 0 } } }));
      await rig.domain
        .table('goal_nodes')
        .put('goal-2', baseNode('goal-2', { parentId: 'goal-1', budget: { tokens: 60, consumed: { tokens: 0, wallClockMs: 0, attentionUnits: 0 } } }));
      await rig.domain
        .table('goal_nodes')
        .put('goal-3', baseNode('goal-3', { parentId: 'goal-1', budget: { tokens: 60, consumed: { tokens: 0, wallClockMs: 0, attentionUnits: 0 } } }));
      await expect(rig.registry.verify('tda-goal-state')).rejects.toThrow(/超过父帽/);
    } finally {
      await teardown(rig);
    }
  });

  it('预算守恒：收紧自帽不得低于既有子帽之和', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-budget3-')));
    try {
      const root = await rig.service.create('human', { objective: '根', budget: { tokens: 100 } });
      await rig.service.create('human', { objective: '子', parentId: root.id, budget: { tokens: 60 } });
      await expect(
        rig.service.edit('human', root.id, { expectedRevision: root.revision }, { budget: { tokens: 30 } }),
      ).rejects.toThrow(/超过新帽/);
    } finally {
      await teardown(rig);
    }
  });

  it('CAS 严格：并发 consume 同期望 revision → 恰一成功、一 STALE_REVISION，账本只进一份', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-cas-')));
    try {
      const root = await rig.service.create('human', { objective: '根', budget: { tokens: 100 } });
      const results = await Promise.allSettled([
        rig.service.consume('agent', root.id, { expectedRevision: root.revision }, { tokens: 10 }),
        rig.service.consume('agent', root.id, { expectedRevision: root.revision }, { tokens: 10 }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleRevisionError);
      expect(rig.service.get(root.id)?.budget.consumed.tokens).toBe(10);
      expect(rig.service.get(root.id)?.revision).toBe(1);
      await expect(rig.registry.verify()).resolves.toBeUndefined();
    } finally {
      await teardown(rig);
    }
  });

  it('schema 恒等律：phase=complete 缺 outcome → 打开即拒（invalidRecords=reject）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-gs-inv-schema-'));
    try {
      const rig = await assemble(dir);
      await rig.service.create('human', { objective: '甲' });
      // 仅关闭落盘（不删目录——后面要读文件注入）
      await rig.domain.close();
      await rig.backend.close();
      // 文件级注入：complete 但删去 outcome（resume/complete 必须清/设字段的铁律被破坏）
      const mainFile = join(dir, 'tda-goal-state.json');
      const file = JSON.parse(await readFile(mainFile, 'utf8')) as { records: Record<string, Record<string, unknown>> };
      const key = 'goal_nodes\u0000goal-1';
      const record = file.records[key];
      if (record === undefined) throw new Error('测试前置失败：未找到 goal-1 记录');
      delete record.outcome;
      record.phase = 'complete';
      await writeFile(mainFile, JSON.stringify(file), 'utf8');
      const backend = createJsonBackend(dir);
      await expect(openTdaDomain(goalStateDomainSpec, { backend })).rejects.toMatchObject({
        code: 'INVALID_RECORD',
      });
      await backend.close();
    } finally {
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('schema 恒等律：paused 携带 blockedReason → put 即拒', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-schema2-')));
    try {
      await expect(
        rig.domain
          .table('goal_nodes')
          .put('goal-1', baseNode('goal-1', { phase: 'paused', blockedReason: { code: 'X', message: 'y' } })),
      ).rejects.toThrow(/不得携带 blockedReason/);
      // active 携带 outcome 同样拒
      await expect(
        rig.domain.table('goal_nodes').put('goal-2', baseNode('goal-2', { outcome: 'success' })),
      ).rejects.toThrow(/不得携带 outcome/);
    } finally {
      await teardown(rig);
    }
  });

  it('迁移守卫：paused/blocked 不可再 pause/block；非 active 不可直接 complete', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-trans-')));
    try {
      const goal = await rig.service.create('human', { objective: '甲' });
      const paused = await rig.service.pause('human', goal.id, { expectedRevision: goal.revision });
      await expect(
        rig.service.pause('human', goal.id, { expectedRevision: paused.revision }),
      ).rejects.toThrow(/INVALID_TRANSITION|不允许/);
      await expect(
        rig.service.complete('human', goal.id, { expectedRevision: paused.revision }, 'success'),
      ).rejects.toThrow(/不允许/);
      const resumed = await rig.service.resume('human', goal.id, { expectedRevision: paused.revision });
      const blocked = await rig.service.block('agent', goal.id, { expectedRevision: resumed.revision }, { code: 'E', message: 'm' });
      await expect(
        rig.service.block('agent', goal.id, { expectedRevision: blocked.revision }, { code: 'E2', message: 'm2' }),
      ).rejects.toThrow(/不允许/);
      await expect(
        rig.service.complete('human', goal.id, { expectedRevision: blocked.revision }, 'failed'),
      ).rejects.toThrow(/不允许/);
    } finally {
      await teardown(rig);
    }
  });

  it('终态不可变：complete 后 edit/consume/clear 拒；clear 后一切变更拒', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-terminal-')));
    try {
      const goal = await rig.service.create('human', { objective: '甲' });
      const done = await rig.service.complete('human', goal.id, { expectedRevision: goal.revision }, 'success');
      await expect(
        rig.service.edit('human', goal.id, { expectedRevision: done.revision }, { objective: '改' }),
      ).rejects.toThrow(/GOAL_COMPLETE|终态/);
      await expect(
        rig.service.consume('agent', goal.id, { expectedRevision: done.revision }, { tokens: 1 }),
      ).rejects.toThrow(/GOAL_COMPLETE|终态/);
      await expect(
        rig.service.clear('human', goal.id, { expectedRevision: done.revision }),
      ).rejects.toThrow(/GOAL_COMPLETE|终态/);

      const other = await rig.service.create('human', { objective: '乙' });
      const cleared = await rig.service.clear('human', other.id, { expectedRevision: other.revision });
      expect(cleared.clearedAt).toBeTypeOf('number');
      await expect(
        rig.service.edit('human', other.id, { expectedRevision: cleared.revision }, { objective: '改' }),
      ).rejects.toThrow(/GOAL_CLEARED|tombstone/);
      await expect(
        rig.service.consume('agent', other.id, { expectedRevision: cleared.revision }, { tokens: 1 }),
      ).rejects.toThrow(/GOAL_CLEARED|tombstone/);
    } finally {
      await teardown(rig);
    }
  });

  it('stage 仅存于 active：paused 后设 stage → STAGE_REQUIRES_ACTIVE', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-stage-')));
    try {
      const goal = await rig.service.create('human', { objective: '甲' });
      const executing = await rig.service.edit('agent', goal.id, { expectedRevision: goal.revision }, { stage: 'executing' });
      expect(executing.stage).toBe('executing');
      const paused = await rig.service.pause('human', goal.id, { expectedRevision: executing.revision });
      await expect(
        rig.service.edit('agent', goal.id, { expectedRevision: paused.revision }, { stage: 'waiting' }),
      ).rejects.toThrow(/STAGE_REQUIRES_ACTIVE|仅存于 active/);
    } finally {
      await teardown(rig);
    }
  });

  it('内核级联动：直写 goal_nodes 绕过双写 → 漏双写被内核门捕获', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-inv-leak-')));
    try {
      await rig.domain.table('goal_nodes').put('goal-9', baseNode('goal-9'));
      await expect(rig.registry.verify(TDA_KERNEL_PACKAGE)).rejects.toBeInstanceOf(InvariantError);
      await expect(rig.registry.verify(TDA_KERNEL_PACKAGE)).rejects.toThrow(/漏双写/);
    } finally {
      await teardown(rig);
    }
  });
});
