/**
 * T1.4 测试脚手架：假治理（记录动作与生命周期）/ 假 rehearsal 执行器。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asSessionId,
  createJsonBackend,
  openTdaDomain,
  type TdaDomain,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { metaThinkingDomainSpec, type MetaPath, type MetaThinkingTables } from '../src/domain.ts';
import {
  createMetaThinkingService,
  type MetaGovernanceSeam,
  type MetaLifecycle,
  type MetaThinkingConfig,
  type MetaThinkingService,
  type RehearsalExecutor,
} from '../src/service.ts';

export type SequencedEvent = { seq: number; family: string; businessId: string; payload: unknown };

export function createMemorySink(sessionId = 'sess-meta'): TdaSessionSink & { readonly events: SequencedEvent[] } {
  const events: SequencedEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId(sessionId),
    append(event) {
      seq += 1;
      events.push({ seq, family: event.family, businessId: event.businessId, payload: event.payload });
      return seq;
    },
    flush() {},
    events,
  };
}

export interface FakeGovernance extends MetaGovernanceSeam {
  readonly lifecycles: Map<string, MetaLifecycle>;
  /** 治理动作留痕（对账 T1.2 不变量 8：动作全留痕）。 */
  readonly actions: { assetId: string; action: string; kind?: string }[];
}

export function createFakeGovernance(initial: Record<string, MetaLifecycle> = {}): FakeGovernance {
  const lifecycles = new Map(Object.entries(initial));
  const actions: { assetId: string; action: string; kind?: string }[] = [];
  return {
    lifecycles,
    actions,
    lifecycleOf(assetId) {
      return lifecycles.get(assetId);
    },
    async consolidate(_actor, assetId) {
      actions.push({ assetId, action: 'consolidate' });
      lifecycles.set(assetId, 'consolidated');
    },
    async retire(_actor, assetId, reason) {
      actions.push({ assetId, action: 'retire', kind: reason.kind });
      lifecycles.set(assetId, 'retired');
    },
    validating(assetKind = 'memory') {
      return [...lifecycles.entries()]
        .filter(([id, lifecycle]) => id.startsWith(assetKind === 'memory' ? '' : 'mp-') && lifecycle === 'validating')
        .map(([id]) => id);
    },
  };
}

export interface FakeExecutor extends RehearsalExecutor {
  readonly calls: { taskId: string; boundaryEventKind: string; hint: string }[];
  script: { outcome: 'success' | 'failure'; tokens: string[] }[];
}

export function createFakeExecutor(script: { outcome: 'success' | 'failure'; tokens: string[] }[] = []): FakeExecutor {
  const calls: { taskId: string; boundaryEventKind: string; hint: string }[] = [];
  const list = [...script];
  return {
    calls,
    script: list,
    async run(input) {
      calls.push({ taskId: input.taskId, boundaryEventKind: input.boundary.eventKind, hint: input.structureHint });
      const next = list.shift() ?? { outcome: 'success' as const, tokens: [] };
      return { childSessionId: `sess-child-${calls.length}`, outcome: next.outcome, transitionTokens: next.tokens };
    },
  };
}

/**
 * 标准候选拓扑：observe → hypothesize → verify → synthesize（线性）。
 * 节点词表刻意取 **TOKEN_TO_STEP 可映射出的种类**——coverage 的分母是拓扑步骤
 * 种类集，若含"轨迹里不可能出现的步骤"（如 refute），verdict 将永远 fail。
 */
export function sampleTopology() {
  return {
    nodes: [
      { id: 'n1', kind: 'observe' as const },
      { id: 'n2', kind: 'hypothesize' as const },
      { id: 'n3', kind: 'verify' as const },
      { id: 'n4', kind: 'synthesize' as const },
    ],
    edges: [
      { from: 'n1', to: 'n2', kind: 'seq' as const },
      { from: 'n2', to: 'n3', kind: 'seq' as const },
      { from: 'n3', to: 'n4', kind: 'seq' as const },
    ],
    entry: 'n1',
    exits: ['n4'],
  };
}

export function sampleDraft(mode: 'convergent' | 'divergent' = 'divergent') {
  return {
    topology: sampleTopology(),
    mode,
    applicability: { taskClasses: ['protocol-analysis'], stages: [], problemFeatures: [] },
    source: { kind: 'coach-author' as const, refs: [{ sessionId: 'sess-1', seqFrom: 1, seqTo: 9 }] },
  };
}

export interface MetaFixture {
  readonly service: MetaThinkingService;
  readonly domain: TdaDomain<MetaThinkingTables>;
  readonly governance: FakeGovernance;
  readonly executor: FakeExecutor;
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly backend: TdaStorageBackend;
  readonly dir: string;
  dispose(): Promise<void>;
}

export interface SetupOptions {
  readonly governance?: Record<string, MetaLifecycle>;
  readonly executor?: { outcome: 'success' | 'failure'; tokens: string[] }[];
  readonly config?: MetaThinkingConfig;
  readonly now?: () => number;
  readonly dir?: string;
}

async function open(options: SetupOptions): Promise<MetaFixture> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'tda-meta-')));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(metaThinkingDomainSpec, { backend });
  const governance = createFakeGovernance(options.governance ?? {});
  const executor = createFakeExecutor(options.executor ?? []);
  const sink = createMemorySink();
  const service = createMetaThinkingService({
    domain,
    session: sink,
    governance,
    executor,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  await service.initialize();
  return {
    service,
    domain,
    governance,
    executor,
    sink,
    backend,
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

export const setup = (options: SetupOptions = {}): Promise<MetaFixture> => open(options);

export const pathOf = (id: string, overrides: Partial<MetaPath> = {}): Partial<MetaPath> => ({ id: id as never, ...overrides });
