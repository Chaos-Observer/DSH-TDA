/**
 * tda-workflow 不变量门 + 双写对账门（合并）。
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
  type AuditIndex,
  type DualWriteReconciler,
  type TdaBusEvent,
  type TdaDomain,
} from '@tda/kernel';
import { workflowDomainSpec, type WorkflowTables } from '../src/domain.ts';
import { createWorkflowService, type WorkflowService } from '../src/service.ts';
import { registerWorkflowInvariants, workflowInvariantChecks } from '../src/loadChecks.ts';
import { NOW, createMemorySink, metaOf } from './helpers.ts';

interface Rig {
  readonly domain: TdaDomain<WorkflowTables>;
  readonly service: WorkflowService;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly published: TdaBusEvent[];
  readonly dir: string;
  dispose(): Promise<void>;
}

async function setup(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-wf-dw-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(workflowDomainSpec, {
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
  bus.subscribe('workflow/change', (event) => {
    published.push(event);
  });
  const service = createWorkflowService({
    domain,
    session: createMemorySink(),
    governance: {
      lifecycleOf: () => undefined,
      async promoteAsset() {
        return {};
      },
      async consolidate() {
        return {};
      },
      async retire() {
        return {};
      },
    },
    checks: { assert: () => true },
    executor: {
      async execute() {
        return { outcome: 'success' as const };
      },
    },
    bus,
    reconciler,
    index,
    now: () => NOW,
  });
  await service.initialize();
  return {
    domain,
    service,
    reconciler,
    index,
    published,
    dir,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T2.5 不变量门', () => {
  it('params-singleton 缺行红', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-wf-inv-'));
    const backend = createJsonBackend(dir);
    const domain = await openTdaDomain(workflowDomainSpec, { backend });
    try {
      const registry = createTdaInvariantRegistry();
      const unregister = registerWorkflowInvariants(registry, domain, {});
      await expect(registry.verify('tda-workflow')).rejects.toThrowError(/必须恰有一行/);
      unregister();
    } finally {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('scriptHash 冻结完整性：篡改 hash 红', async () => {
    const rig = await setup();
    try {
      await rig.domain.table('workflow_defs').put('wf-x#1', {
        defId: 'wf-x', version: 1, kind: 'template', name: 'x', description: 'x', source: 'human',
        meta: metaOf(), script: 'script-a', scriptHash: 'deadbeef',
        createdBy: { sessionId: 's', actor: 'human' }, createdAt: NOW,
      } as never);
      const registry = createTdaInvariantRegistry();
      const unregister = registerWorkflowInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-workflow')).rejects.toThrowError(/scriptHash 与落盘 script 不符/);
      unregister();
    } finally {
      await rig.dispose();
    }
  });

  it('检查清单与规格映射一一对应（防静默删检查）', async () => {
    const rig = await setup();
    try {
      const names = workflowInvariantChecks(rig.domain, { service: rig.service }).map((check) => check.name);
      expect(names).toEqual([
        'workflow-params-singleton',
        'workflow-script-hash-frozen',
        'workflow-runs-match-events-replay',
        'workflow-service-no-def-write-face',
      ]);
      const registry = createTdaInvariantRegistry();
      const unregister = registerWorkflowInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-workflow')).resolves.toBeUndefined();
      unregister();
    } finally {
      await rig.dispose();
    }
  });
});

describe('T2.5 双写与审计', () => {
  it('def/run/event/params 全配对；audit_index 记 workflow 实体', async () => {
    const rig = await setup();
    try {
      const def = await rig.service.propose({ sessionId: 's', actor: 'human' }, {
        name: 'dw-wf', description: 'x', kind: 'template', source: 'human', meta: metaOf(), script: '/*s*/',
      });
      const run = await rig.service.start({ sessionId: 's', actor: 'scheduler' }, String(def.defId), {}, 'task-1');
      await rig.service.setParams({ maxConcurrentRuns: 5 });
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(true);
      expect(rig.published.every((event) => event.family === 'workflow/change')).toBe(true);
      const located = rig.index.locate('workflow', `workflow-run:${String(run.runId)}`);
      expect(located?.entityId).toBe(`workflow-run:${String(run.runId)}`);
    } finally {
      await rig.dispose();
    }
  });

  it('直写域即漏双写（对账器抓到）', async () => {
    const rig = await setup();
    try {
      const row = rig.domain.table('workflow_params').get('singleton');
      await rig.domain.table('workflow_params').put('singleton', { ...row, revision: 42 } as never);
      const report = rig.reconciler.reconcile();
      expect(report.ok).toBe(false);
      expect(report.unpairedChanges.some((change) => change.table === 'workflow_params')).toBe(true);
    } finally {
      await rig.dispose();
    }
  });
});
