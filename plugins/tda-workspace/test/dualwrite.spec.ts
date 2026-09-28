/**
 * tda-workspace 双写对账门（门3 test:dualwrite）。
 *
 * 覆盖：**一次扫描 = 一个写窗口**（图谱节点/边/缓存/历史全部同窗落域，故多表
 *      写入仍严格配对）/ 陈旧节点与边的剔除也在同窗 / 预检失败不落域不产事件 /
 *      audit_index 按 scan 实体延展 / 总线分发与 seq 一致 /
 *      replay-equivalence（ws_scan_runs 由事件载荷逐字段重建）/
 *      时点扫描订阅（stage 跃迁触发、非跃迁不重复、drain 可等待、退订即止）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
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
import { assertReplayEquivalence, compareReplay } from '@tda/testkit';
import {
  createWorkspaceService,
  subscribeTaskScan,
  workspaceDomainSpec,
  type WorkspaceCaller,
  type WorkspaceService,
  type WorkspaceTables,
} from '../src/index.ts';
import { createFakeAnnotator, createFakeTasks, createFakeTimeline, createMemoryFs, createMemorySink } from './helpers.ts';

const FILES: Record<string, string> = {
  '/ws/proj/a.md': '# A\n',
  '/ws/proj/b.md': '# B\n',
  '/ws/proj/stale.md': '# stale\n',
};

interface Rig {
  readonly service: WorkspaceService;
  readonly domain: TdaDomain<WorkspaceTables>;
  readonly sink: TdaSessionSink & { readonly events: TdaLogEvent[] };
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly bus: TdaEventBus;
  readonly published: TdaBusEvent[];
  readonly fs: ReturnType<typeof createMemoryFs>;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-ws-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(workspaceDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  const sink = createMemorySink('sess-ws-dw');
  const bus = createTdaEventBus();
  const published: TdaBusEvent[] = [];
  bus.subscribe('workspace/scan', (event) => published.push(event));
  const fs = createMemoryFs(FILES);
  const tasks = createFakeTasks([{ id: 'task-1', localPath: 'proj' }]);
  const service = createWorkspaceService({
    domain,
    session: sink,
    fs,
    config: { root: '/ws' },
    taskPool: tasks.seam,
    annotator: createFakeAnnotator({
      ok: true,
      structured: {
        files: [{ path: 'proj/a.md', role: 'doc', credibilityHint: 'authoritative-likely' }],
        edges: [{ from: 'proj/a.md', to: 'proj/b.md', kind: 'related-to', confidence: 0.6, evidence: '同主题' }],
        notes: ['A 与 B 同属协议说明'],
      },
      childSessionId: 'sub-1',
    }),
    timeline: createFakeTimeline().seam,
    reconciler,
    index,
    bus,
  });
  return {
    service,
    domain,
    sink,
    reconciler,
    index,
    bus,
    published,
    fs,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

const caller: WorkspaceCaller = { actor: 'agent', sessionId: asSessionId('sess-ws-dw') };

describe('T0.6 双写配对', () => {
  it('一次扫描 = 一个写窗口（多表同窗落域仍严格配对）', async () => {
    const rig = await setup();
    try {
      await rig.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(report.pairedWrites).toBe(1); // 3 个节点 + 1 条边 + 3 行缓存 + 1 条历史 同窗
      expect(report.unpairedChanges).toEqual([]);
      expect(rig.sink.events.filter((event) => event.family === 'workspace/scan')).toHaveLength(1);
      const registry = createTdaInvariantRegistry();
      registerTdaInvariants(registry, rig.reconciler);
      await expect(registry.verify()).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('陈旧节点/边的剔除也在同一窗口（重扫即刷新，不留残边）', async () => {
    const rig = await setup();
    try {
      await rig.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      expect(rig.service.files('task-1').map((file) => file.path)).toContain('proj/stale.md');
      rig.fs.remove('/ws/proj/stale.md');
      const second = await rig.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      expect(second.status).toBe('recorded');
      expect(rig.service.files('task-1').map((file) => file.path)).not.toContain('proj/stale.md');
      expect(rig.reconciler.reconcile().ok).toBe(true);
      expect(rig.reconciler.reconcile().pairedWrites).toBe(2);
    } finally {
      await rig.dispose();
    }
  });

  it('预检失败不落域不产事件（无 localPath 即拒）', async () => {
    const rig = await setup();
    try {
      await expect(rig.service.scan(caller, { taskId: 'task-ghost' })).rejects.toMatchObject({
        code: 'WORKSPACE_TASK_NOT_FOUND',
      });
      expect(rig.sink.events).toHaveLength(0);
      expect(rig.domain.table('ws_file_nodes').size()).toBe(0);
      expect(rig.reconciler.reconcile().ok).toBe(true);
    } finally {
      await rig.dispose();
    }
  });

  it('audit_index 按 scan 实体延展、bus 分发与 seq 一致', async () => {
    const rig = await setup();
    try {
      const run = await rig.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      const located = rig.index.locate('scan', String(run.id));
      expect(located?.sessionId).toBe(rig.sink.sessionId);
      expect(rig.published).toHaveLength(1);
      expect(rig.published[0]?.businessId).toBe(String(run.id));
      expect(rig.published[0]?.seq).toBe(located?.seqFrom);
      expect(rig.published[0]?.payload.filesScanned).toBe(3);
    } finally {
      await rig.dispose();
    }
  });

  it('replay-equivalence：ws_scan_runs 由事件载荷逐字段重建零差异', async () => {
    const rig = await setup();
    try {
      await rig.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      rig.fs.put('/ws/proj/a.md', '# A v2\n', 1_700_000_500_000);
      await rig.service.scan(caller, { taskId: 'task-1' });
      const diff = compareReplay(
        rig.sink.events.map((event, index) => ({ seq: index + 1, sessionId: rig.sink.sessionId, ...event })),
        rig.domain.table('ws_scan_runs').entries(),
        (event) => (event.family !== 'workspace/scan' ? undefined : { key: event.businessId, value: event.payload }),
      );
      assertReplayEquivalence(diff);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T0.6 时点扫描订阅（J8）', () => {
  it('stage 跃迁进入 executing/verifying 触发一次；同 stage 重复事件不重复扫；drain 可等待', async () => {
    const rig = await setup();
    const tasks = createFakeTasks([{ id: 'task-1', localPath: 'proj' }]);
    const service = createWorkspaceService({
      domain: rig.domain,
      session: createMemorySink('sess-ws-link'),
      fs: rig.fs,
      config: { root: '/ws' },
      taskPool: tasks.seam,
      annotator: createFakeAnnotator(),
      timeline: createFakeTimeline().seam,
      bus: rig.bus,
      now: () => 1_700_000_000_000,
    });
    const handle = subscribeTaskScan({ bus: rig.bus, workspace: service, caller });
    try {
      const publish = (stage: string, seq: number): void => {
        rig.bus.publish({
          family: 'taskPool/change',
          businessId: 'task-1',
          payload: { id: 'task-1', stage },
          seq,
          sessionId: rig.sink.sessionId,
        });
      };
      publish('planning', 1);
      publish('executing', 2);
      publish('executing', 3); // 非跃迁：不重复
      publish('verifying', 4);
      await handle.drain();
      expect(service.runs('task-1')).toHaveLength(2);

      // 退订后不再触发
      handle.unsubscribe();
      publish('executing', 5);
      await handle.drain();
      expect(service.runs('task-1')).toHaveLength(2);
    } finally {
      handle.unsubscribe();
      await handle.drain();
      await rig.dispose();
    }
  });
});
