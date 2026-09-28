/**
 * T2.5 测试脚手架：假治理面 / 可编程 contract 断言器 / 可编程 step 执行器 /
 * 可编程 planner。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJsonBackend,
  openTdaDomain,
  type SessionId,
  type TdaDomain,
  type TdaLogEvent,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { workflowDomainSpec, type WorkflowMeta, type WorkflowTables } from '../src/domain.ts';
import { createWorkflowService, type WorkflowService } from '../src/service.ts';

export type SequencedLogEvent = TdaLogEvent & { readonly seq: number; readonly sessionId: SessionId };

export function createMemorySink(sessionId = 'sess-wf'): TdaSessionSink & { readonly events: SequencedLogEvent[] } {
  const id = sessionId as SessionId;
  const events: SequencedLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: id,
    append(event: TdaLogEvent) {
      seq += 1;
      events.push({ ...event, seq, sessionId: id });
      return seq;
    },
    flush() {},
    events,
  };
}

export interface FakeGovernanceState {
  readonly seam: {
    lifecycleOf(assetId: string, assetKind?: string): string | undefined;
    promoteAsset(actor: unknown, assetId: string, assetKind: string, note: string): Promise<unknown>;
    consolidate(actor: unknown, assetId: string, assetKind?: string): Promise<unknown>;
    retire(actor: unknown, assetId: string, reason: { kind: string; detail: string }, opts?: unknown, assetKind?: string): Promise<unknown>;
  };
  readonly lifecycles: Map<string, string>;
  readonly calls: string[];
}

export function createFakeGovernance(): FakeGovernanceState {
  const lifecycles = new Map<string, string>();
  const calls: string[] = [];
  return {
    lifecycles,
    calls,
    seam: {
      lifecycleOf(assetId) {
        return lifecycles.get(assetId);
      },
      async promoteAsset(_actor, assetId, _assetKind, _note) {
        calls.push(`promote:${assetId}`);
        lifecycles.set(assetId, 'validating');
        return { ok: true };
      },
      async consolidate(_actor, assetId) {
        calls.push(`consolidate:${assetId}`);
        lifecycles.set(assetId, 'consolidated');
        return { ok: true };
      },
      async retire(_actor, assetId, reason, _opts, _assetKind) {
        calls.push(`retire:${assetId}:${reason.kind}`);
        lifecycles.set(assetId, 'retired');
        return { ok: true };
      },
    },
  };
}

export interface WorkflowFixture {
  readonly service: WorkflowService;
  readonly domain: TdaDomain<WorkflowTables>;
  readonly governance: FakeGovernanceState;
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly backend: TdaStorageBackend;
  readonly dir: string;
  /** 断言结果表：`${kind}:${target}` → boolean（缺省 true）。 */
  assertResults: Map<string, boolean>;
  /** 执行器脚本：依次出队（缺省 success）。 */
  executorScript: { outcome: 'success' | 'failure' }[];
  readonly executorCalls: { stepId: string; kind: string }[];
  setPlanner(fn: (() => Promise<{ meta: WorkflowMeta; script: string } | undefined>) | undefined): void;
  dispose(): Promise<void>;
}

export const NOW = 1_790_000_000_000;

export async function setup(): Promise<WorkflowFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-wf-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(workflowDomainSpec, { backend });
  const governance = createFakeGovernance();
  const sink = createMemorySink();

  const assertResults = new Map<string, boolean>();
  const executorScript: { outcome: 'success' | 'failure' }[] = [];
  const executorCalls: { stepId: string; kind: string }[] = [];
  let plannerFn: (() => Promise<{ meta: WorkflowMeta; script: string } | undefined>) | undefined;
  let n = 0;

  const service = createWorkflowService({
    domain,
    session: sink,
    governance: governance.seam,
    checks: {
      assert(assertion) {
        const key = `${assertion.kind}:${assertion.target}`;
        return assertResults.get(key) ?? true;
      },
    },
    executor: {
      async execute(input) {
        executorCalls.push({ stepId: input.stepId, kind: input.kind });
        n += 1;
        const step = executorScript.shift() ?? { outcome: 'success' as const };
        return { outcome: step.outcome, detail: { call: n } };
      },
    },
    planner: {
      replan: async () => (plannerFn !== undefined ? plannerFn() : undefined),
    },
    now: () => NOW,
  });
  await service.initialize();
  return {
    service,
    domain,
    governance,
    sink,
    backend,
    dir,
    assertResults,
    executorScript,
    executorCalls,
    setPlanner(fn) {
      plannerFn = fn;
    },
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

/** 两步线性定义（read → write，第一步带审批节点）。 */
export const metaOf = (overrides: Partial<WorkflowMeta> = {}): WorkflowMeta => ({
  phases: [{ id: 'p1', label: '主 phase', stepIds: ['s1', 's2'] }],
  steps: [
    {
      id: 's1',
      kind: 'tool',
      dependsOn: [],
      contract: { pre: [{ kind: 'task-phase', target: 'task-1', expect: 'executing' }], post: [{ kind: 'artifact-exists', target: 'artifact-1', expect: 'exists' }], hardBounds: [] },
    },
    {
      id: 's2',
      kind: 'dispatch',
      dependsOn: ['s1'],
      contract: { pre: [], post: [], hardBounds: [] },
    },
  ],
  approvalNodes: [],
  budgets: {},
  deviationBudget: { postFailMax: 2, mismatchDensityMax: 0.4, burnRateMax: 1.5 },
  ...overrides,
});

export const draftOf = (name: string, meta: WorkflowMeta, overrides: Record<string, unknown> = {}) => ({
  name,
  description: `${name} 的描述`,
  kind: 'template' as const,
  source: 'human' as const,
  meta,
  script: '/* 控制流（受控 step API）*/ stepBegin("s1"); stepEnd("s1");',
  ...overrides,
});
