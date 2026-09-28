/**
 * tda-coach 双写对账门（门3 test:dualwrite）。
 *
 * 写组合（J8/不变量 9）：`coach_reviews`/`coach_candidates`/`coach_params` = 权威
 * （`dualWrite` + 族 `coach/change`）；`coach_scan_state` = 派生（`dualWriteDerived`，
 * 水位同 log 可重算，无事件）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  openTdaDomain,
  type AuditIndex,
  type DualWriteReconciler,
  type TdaBusEvent,
  type TdaDomain,
} from '@tda/kernel';
import { coachDomainSpec, type CoachTables } from '../src/domain.ts';
import { createCoachService, type CoachService } from '../src/service.ts';
import { createFakeMeta, createFakePipe, createMemorySink, sameCluster, NOW } from './helpers.ts';

interface Rig {
  readonly dir: string;
  readonly backend: ReturnType<typeof createJsonBackend>;
  readonly domain: TdaDomain<CoachTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly published: TdaBusEvent[];
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly service: CoachService;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-coach-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(coachDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  const bus = createTdaEventBus();
  const published: TdaBusEvent[] = [];
  bus.subscribe('coach/change', (event) => {
    published.push(event);
  });
  const sink = createMemorySink();
  const meta = createFakeMeta();
  const pipe = createFakePipe();
  const service = createCoachService({
    domain,
    session: sink,
    reads: {
      mismatches: () =>
        sameCluster(3).map((row) => ({
          id: row.id,
          predictionId: row.predictionId,
          actual: { action: row.action },
          deltaKind: row.deltaKind,
          at: row.at,
        })),
      predictions: () => [{ id: 'pred-1', context: { taskId: 'task-1', stage: 'executing' } }],
      govActions: () => [],
      rehearsalRuns: () => [],
    },
    meta: meta.seam,
    pipe: pipe.seam,
    transferExecutor: {
      async run(input) {
        return { verdict: 'pass' as const, rehearsalId: `transfer-${input.modelProfile}` };
      },
    },
    bus,
    reconciler,
    index,
    now: () => NOW,
  });
  await service.initialize();
  return {
    dir,
    backend,
    domain,
    reconciler,
    index,
    published,
    sink,
    service,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T2.1 双写与审计', () => {
  it('review/candidate/params 全配对；scan_state 走派生窗', async () => {
    const rig = await setup();
    try {
      const report = await rig.service.review({ kind: 'manual' });
      const candidate = rig.service.candidates()[0]!;
      await rig.service.rehearseCandidate({ actor: 'coach', sessionId: 'sess-coach' }, String(candidate.id), 'task-1');
      await rig.service.verifyTransfer({ actor: 'coach', sessionId: 'sess-coach' }, String(candidate.id), 'model-b');
      await rig.service.submit({ actor: 'coach', sessionId: 'sess-coach' }, String(candidate.id));
      await rig.service.setParams({ minConfidence: 0.4 });

      const reconcileReport = rig.reconciler.reconcile();
      expect(reconcileReport.ok).toBe(true);
      expect(reconcileReport.derivedChanges).toBeGreaterThan(0); // scan_state
      expect(rig.published.every((event) => event.family === 'coach/change')).toBe(true);
      expect(rig.published.some((event) => event.businessId === `review:${String(report.id)}`)).toBe(true);
      expect(rig.published.some((event) => event.businessId === 'params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 记 coach 实体；session 日志为权威源', async () => {
    const rig = await setup();
    try {
      await rig.service.review({ kind: 'manual' });
      const located = rig.index.locate('coach', 'review:cr-1');
      expect(located?.entityId).toBe('review:cr-1');
      expect(located?.sessionId).toBe('sess-coach');
    } finally {
      await rig.dispose();
    }
  });

  it('replay-equivalence：params 从 coach/change 日志重建 ⇒ 零差异', async () => {
    const rig = await setup();
    try {
      await rig.service.setParams({ minConfidence: 0.4 });
      const events = rig.published.map((event) => ({ ...event, at: NOW }));
      const { compareReplay, assertReplayEquivalence } = await import('@tda/testkit');
      const diff = compareReplay(
        events,
        rig.domain.table('coach_params').entries(),
        (event) => (event.businessId === 'params' ? { key: 'singleton', value: event.payload } : undefined),
      );
      expect(() => assertReplayEquivalence(diff)).not.toThrow();
    } finally {
      await rig.dispose();
    }
  });

  it('预检失败：未验证 submit 不落域、不产事件', async () => {
    const rig = await setup();
    try {
      await rig.service.review({ kind: 'manual' });
      const candidate = rig.service.candidates()[0]!;
      const before = rig.published.length;
      const beforeRow = canonicalJson(rig.domain.table('coach_candidates').get(String(candidate.id)));
      await expect(
        rig.service.submit({ actor: 'coach', sessionId: 'sess-coach' }, String(candidate.id)),
      ).rejects.toMatchObject({ code: 'COACH_NOT_TRANSFER_VERIFIED' });
      expect(rig.published.length).toBe(before);
      expect(canonicalJson(rig.domain.table('coach_candidates').get(String(candidate.id)))).toBe(beforeRow);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('直写域即漏双写（对账器抓到）', async () => {
    const rig = await setup();
    try {
      const row = rig.domain.table('coach_params').get('singleton');
      await rig.domain.table('coach_params').put('singleton', { ...row, revision: 42 } as never);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges.some((change) => change.table === 'coach_params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
