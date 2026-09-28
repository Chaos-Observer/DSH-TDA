/**
 * tda-context 双写对账门（门3 test:dualwrite）。
 *
 * 覆盖：组装（域内零写：`domainWrite` 是空操作）与钉扎定义变更**都配对** /
 *      audit_index 按 assemble 实体延展 / 总线分发与 seq 一致 /
 *      "组装留痕"的结构性证明——AssembleRecord 不落 domain，权威在 session log
 *      （从 log 重建 == records()）/ 预检失败（PIN_RENDER_OVERFLOW）不产组装留痕。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  createTdaInvariantRegistry,
  openTdaDomain,
  registerTdaInvariants,
  type AuditIndex,
  type DualWriteReconciler,
  type TdaBusEvent,
  type TdaDomain,
  type TdaEventBus,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  contextDomainSpec,
  createContextService,
  createMemorySurface,
  type AssembleRecord,
  type ContextService,
  type ContextTables,
} from '../src/index.ts';
import { createFakeGoalSeam, createFakeTaskSeam, createFakeTimeline, createMemorySink } from './helpers.ts';

interface Rig {
  readonly service: ContextService;
  readonly domain: TdaDomain<ContextTables>;
  readonly sink: TdaSessionSink & { readonly events: TdaLogEvent[] };
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly bus: TdaEventBus;
  readonly published: TdaBusEvent[];
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-ctx-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(contextDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  const sink = createMemorySink('sess-ctx-dw');
  const bus = createTdaEventBus();
  const published: TdaBusEvent[] = [];
  bus.subscribe('context/assemble', (event) => published.push(event));
  const service = createContextService({
    domain,
    session: sink,
    surface: createMemorySurface({
      sessionId: 'sess-ctx-dw',
      messages: [
        { seq: 1, role: 'user', content: '第一轮提问' },
        { seq: 2, role: 'assistant', content: '第一轮回答' },
      ],
    }),
    goalSeam: createFakeGoalSeam().seam,
    taskSeam: createFakeTaskSeam().seam,
    timeline: createFakeTimeline().seam,
    reconciler,
    index,
    bus,
    now: () => 1_700_000_000_000,
  });
  return {
    service,
    domain,
    sink,
    reconciler,
    index,
    bus,
    published,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T0.4 双写配对', () => {
  it('组装不写域但事件配对（log-only：域内零写是 §3.3 明文）；钉扎定义变更同族配对', async () => {
    const rig = await setup();
    try {
      await rig.service.pin('scheduler', { kind: 'goal', sourceKind: 'goalTree.focus', sourceRef: 'focus', maxTokens: 64 });
      await rig.service.assemble(1);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      // 钉扎定义变更：域写 + 事件（配对 1 次）；组装：log-only（域内无记录，不计反向洞）
      expect(report.pairedWrites).toBe(1);
      expect(report.unmatchedWrites).toBe(0);
      expect(rig.domain.table('context_pins').size()).toBe(1);
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, rig.reconciler);
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 assemble 实体延展；bus 与 seq 一致', async () => {
    const rig = await setup();
    try {
      await rig.service.assemble(1);
      await rig.service.assemble(2);
      const businessId = `${String(rig.sink.sessionId)}:2`;
      const located = rig.index.locate('assemble', businessId);
      expect(located?.sessionId).toBe(rig.sink.sessionId);
      expect(rig.published.map((event) => event.businessId)).toEqual([
        `${String(rig.sink.sessionId)}:1`,
        businessId,
      ]);
      expect(rig.published[1]?.seq).toBe(located?.seqFrom);
      // 同一实体多次记录 → seqTo 前移（审计可定位到该实体的全部事件）
      expect(rig.index.locate('assemble', `${String(rig.sink.sessionId)}:1`)?.seqFrom).toBeLessThanOrEqual(
        rig.published[1]?.seq ?? 0,
      );
    } finally {
      await rig.dispose();
    }
  });

  it('组装留痕：AssembleRecord 不落 domain，权威在 session log（重建 == records()）', async () => {
    const rig = await setup();
    try {
      await rig.service.assemble(1);
      await rig.service.assemble(2);
      // 域内只有钉扎表：组装记录不落域（§3.3）——组装前后钉扎表零变化
      expect(rig.domain.table('context_pins').size()).toBe(0);
      const logged = rig.sink.events
        .filter((event) => event.family === 'context/assemble' && typeof event.payload.round === 'number')
        .map((event) => event.payload as unknown as AssembleRecord);
      expect(logged).toHaveLength(2);
      expect(logged).toEqual(rig.service.records());
    } finally {
      await rig.dispose();
    }
  });

  it('预检失败（PIN_RENDER_OVERFLOW）不产组装留痕（fail-loud，不留半套）', async () => {
    const rig = await setup();
    try {
      await rig.service.pin('scheduler', { kind: 'goal', sourceKind: 'goalTree.focus', sourceRef: 'focus', maxTokens: 1 });
      const before = rig.sink.events.length;
      await expect(rig.service.assemble(1)).rejects.toMatchObject({ code: 'PIN_RENDER_OVERFLOW' });
      expect(rig.sink.events.length).toBe(before);
      expect(rig.reconciler.reconcile().ok).toBe(true);
      expect(rig.service.records()).toHaveLength(0);
    } finally {
      await rig.dispose();
    }
  });

  it('unpin 也走双写（删除同样有事件），且幂等', async () => {
    const rig = await setup();
    try {
      const created = await rig.service.pin('scheduler', {
        kind: 'goal',
        sourceKind: 'goalTree.focus',
        sourceRef: 'focus',
        maxTokens: 64,
      });
      await rig.service.unpin('scheduler', created.id, { expectedRevision: created.revision });
      await rig.service.unpin('scheduler', created.id); // 幂等：不存在即无事
      expect(rig.domain.table('context_pins').size()).toBe(0);
      expect(rig.sink.events.filter((event) => event.family === 'context/assemble')).toHaveLength(2);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
