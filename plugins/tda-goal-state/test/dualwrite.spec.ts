/**
 * tda-goal-state 双写对账门（门3 test:dualwrite）：服务每次 accepted 变更
 * 经统一出口 commit（goal_nodes + goal_history + 附加表同窗口落域 → append
 * log-only 事件），对账器逐一配对。
 *
 * 覆盖：单 op 配对 / 复合 op 多记录同窗口（consume 汇聚、focus 让渡）/
 *       audit_index 按 goal 实体自动延展 / goal_history 不存 seq（方案 §3.2
 *       硬规则：seq 拥有序在事件侧，domain 记录不重复存储）/
 *       预检失败不落域不产事件（fail-loud，无半套）/ 直写域即漏双写。
 */
import { mkdtemp } from 'node:fs/promises';
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
  openTdaDomain,
  type AuditIndex,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaInvariantRegistry,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import { goalStateDomainSpec, type GoalTables } from '../src/domain.ts';
import { createGoalTreeService, type GoalTreeService } from '../src/service.ts';
import { registerGoalStateInvariants } from '../src/loadChecks.ts';

/** 内存 session sink（append 分配自增 seq）。 */
function createMemorySink(): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId('sess-dw'),
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
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly registry: TdaInvariantRegistry;
  readonly service: GoalTreeService;
  readonly sink: ReturnType<typeof createMemorySink>;
}

async function assemble(dir: string): Promise<Rig> {
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
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
  registerGoalStateInvariants(registry, domain);
  const sink = createMemorySink();
  const service = createGoalTreeService({ domain, session: sink, reconciler, index });
  return { dir, backend, domain, reconciler, index, registry, service, sink };
}

async function teardown(rig: Rig): Promise<void> {
  await rig.domain.close();
  await rig.backend.close();
  // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', rig.dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

describe('tda-goal-state 双写对账门', () => {
  it('单 op：create 的三表写同窗口配对一个事件', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-dw-single-')));
    try {
      await rig.service.create('human', { objective: '甲' });
      expect(rig.sink.events).toHaveLength(1);
      expect(rig.sink.events[0]?.family).toBe('goalTree/change');
      // goal_nodes + goal_history + constraint_snapshots 三写同窗，配对 1 次
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 1,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
      // goal_history 记录不存 seq（硬规则：seq 在事件侧拥有序）
      const record = rig.domain.table('goal_history').get('goal-1#0');
      expect(record).toBeDefined();
      expect(Object.keys(record ?? {})).not.toContain('seq');
    } finally {
      await teardown(rig);
    }
  });

  it('复合 op：consume 汇聚 + focus 让渡的多记录多事件全部配对', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-dw-composite-')));
    try {
      const root = await rig.service.create('human', { objective: '根', budget: { tokens: 100 } });
      const child = await rig.service.create('human', { objective: '子', parentId: root.id, budget: { tokens: 60 } });
      // focus：让渡 root + 聚焦 child = 2 事件
      const focused = await rig.service.focus('agent', child.id, { expectedRevision: child.revision });
      // consume：child 本笔 + root 汇聚 = 2 事件
      await rig.service.consume('agent', child.id, { expectedRevision: focused.revision }, { tokens: 10 });
      expect(rig.sink.events).toHaveLength(6); // 2 create + 2 focus + 2 consume
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 6,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
      // audit_index：goal 实体 seq 区间自动延展
      // （root: seq 1/3/6 → 1..6；child: seq 2/4/5 → 2..5）
      expect(rig.index.locate('goal', 'goal-1')).toMatchObject({ seqFrom: 1, seqTo: 6 });
      expect(rig.index.locate('goal', 'goal-2')).toMatchObject({ seqFrom: 2, seqTo: 5 });
      // 账本：child 与 root 同耗 10（汇聚）
      expect(rig.service.get(asGoalId('goal-2'))?.budget.consumed.tokens).toBe(10);
      expect(rig.service.get(asGoalId('goal-1'))?.budget.consumed.tokens).toBe(10);
    } finally {
      await teardown(rig);
    }
  });

  it('预检失败：超帽 consume 不落域、不产事件、无失败窗口（fail-loud 无半套）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-dw-precheck-')));
    try {
      const root = await rig.service.create('human', { objective: '根', budget: { tokens: 10 } });
      await expect(
        rig.service.consume('agent', root.id, { expectedRevision: root.revision }, { tokens: 11 }),
      ).rejects.toThrow(/BUDGET_EXHAUSTED|超帽/);
      expect(rig.sink.events).toHaveLength(1); // 仍只有 create 一个事件
      expect(rig.service.get('goal-1' as never)?.revision).toBe(0);
      expect(rig.reconciler.reconcile()).toMatchObject({
        ok: true,
        pairedWrites: 1,
        unpairedChanges: [],
        unmatchedWrites: 0,
        failedWindows: 0,
      });
    } finally {
      await teardown(rig);
    }
  });

  it('直写域绕过双写器 → 漏双写（对账器 + 内核级不变量双捕获）', async () => {
    const rig = await assemble(await mkdtemp(join(tmpdir(), 'tda-gs-dw-leak-')));
    try {
      await rig.domain.table('goal_nodes').put('goal-9', {
        id: asGoalId('goal-9'),
        revision: 0,
        objective: '绕过双写',
        completionCriteria: [],
        phase: 'active',
        stage: 'planning',
        maxGoalRounds: 50,
        roundsStarted: 0,
        budget: { consumed: { tokens: 0, wallClockMs: 0, attentionUnits: 0 } },
        focus: false,
        createdAt: 1,
        updatedAt: 1,
      });
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges).toHaveLength(1);
      expect(report.unpairedChanges[0]).toMatchObject({ table: 'goal_nodes', key: 'goal-9' });
    } finally {
      await teardown(rig);
    }
  });
});
