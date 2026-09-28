/** T3.1 测试夹具：假时间线 / 假图谱 / 假蒸馏器 / 假治理。 */
import { createJsonBackend, openTdaDomain } from '@tda/kernel';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeDomainSpec, type DistillSourceChunk, type KnowledgeCandidate, type KnowledgeEdge, type KnowledgeEntry } from '../src/domain.ts';
import { createKnowledgeService, type KnowledgeDeps, type KnowledgeService } from '../src/service.ts';

export const NOW = 1_795_000_000_000;

export interface FakeChunk {
  readonly id: string;
  readonly content: string;
  readonly credential: string;
  readonly relatedTaskId?: string;
  readonly trajectoryRef?: string;
}

export function createFakeTimeline(chunks: FakeChunk[]) {
  const store = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const appended: { title: string; summary: string; credential: string }[] = [];
  const invalidated: { entryId: string; reason: string }[] = [];
  let appendSeq = 0;
  return {
    seam: {
      search(_query: string, opts?: { limit?: number }) {
        const rows = [...store.values()].map((chunk) => ({
          id: chunk.id,
          summary: chunk.content,
          credential: chunk.credential,
          ...(chunk.relatedTaskId !== undefined ? { relatedTaskId: chunk.relatedTaskId } : {}),
          ...(chunk.trajectoryRef !== undefined ? { trajectoryRef: chunk.trajectoryRef } : {}),
          at: NOW,
        }));
        return typeof opts?.limit === 'number' ? rows.slice(0, opts.limit) : rows;
      },
      get(entryId: string) {
        const chunk = store.get(entryId);
        return chunk === undefined
          ? undefined
          : {
              id: chunk.id,
              credential: chunk.credential,
              ...(chunk.trajectoryRef !== undefined ? { trajectoryRef: chunk.trajectoryRef } : {}),
            };
      },
      async append(input: { title: string; summary: string; chunkType: string; credential: string }) {
        appendSeq += 1;
        appended.push({ title: input.title, summary: input.summary, credential: input.credential });
        const id = `tl-kn-${appendSeq}`;
        store.set(id, { id, content: input.summary, credential: input.credential });
        return id;
      },
      async invalidate(entryId: string, reason: string) {
        invalidated.push({ entryId, reason });
      },
    },
    store,
    appended,
    invalidated,
  };
}

export function createFakeProvider(opts: { available?: boolean | undefined } = {}) {
  const graph = new Map<string, string>();
  const invalidated: string[] = [];
  let available = opts.available ?? true;
  return {
    seam: {
      available: () => available,
      async ingest(entry: KnowledgeEntry) {
        const ref = `graph:${String(entry.entryId)}#v${entry.version}`;
        graph.set(String(entry.entryId), ref);
        return ref;
      },
      async invalidate(entryId: string) {
        invalidated.push(entryId);
        graph.delete(entryId);
      },
      async reassert(entry: KnowledgeEntry) {
        const ref = `graph:${String(entry.entryId)}#v${entry.version}`;
        graph.set(String(entry.entryId), ref);
        return ref;
      },
      neighbors(entryId: string, depth: number) {
        void entryId;
        void depth;
        return { entries: [], edges: [] as KnowledgeEdge[] };
      },
    },
    graph,
    invalidated,
    setAvailable(next: boolean) {
      available = next;
    },
  };
}

export function createFakeDistiller(candidates: KnowledgeCandidate[] | ((cluster: readonly DistillSourceChunk[]) => KnowledgeCandidate[])) {
  const calls: DistillSourceChunk[][] = [];
  return {
    seam: {
      async distill(cluster: readonly DistillSourceChunk[]) {
        calls.push([...cluster]);
        return typeof candidates === 'function' ? candidates(cluster) : candidates;
      },
    },
    calls,
  };
}

export function createFakeGovernance() {
  const actions: { assetId: string; assetKind?: string }[] = [];
  return {
    seam: {
      async consolidate(_actor: unknown, assetId: string, assetKind?: string) {
        actions.push({ assetId, ...(assetKind !== undefined ? { assetKind } : {}) });
        return { id: `gov-${actions.length}` };
      },
      lifecycleOf(_assetId: string, _assetKind?: string) {
        return undefined;
      },
    },
    actions,
  };
}

export interface SetupOptions {
  readonly chunks?: FakeChunk[];
  readonly providerAvailable?: boolean;
  readonly candidates?: KnowledgeCandidate[];
  readonly now?: () => number;
}

export interface Fixture {
  readonly service: KnowledgeService;
  readonly domain: Awaited<ReturnType<typeof openTdaDomain>>;
  readonly timeline: ReturnType<typeof createFakeTimeline>;
  readonly provider: ReturnType<typeof createFakeProvider>;
  readonly distiller: ReturnType<typeof createFakeDistiller>;
  readonly governance: ReturnType<typeof createFakeGovernance>;
  readonly dispose: () => Promise<void>;
}

export async function setup(options: SetupOptions = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-kn-test-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(knowledgeDomainSpec, { backend });
  const timeline = createFakeTimeline(options.chunks ?? []);
  const provider = createFakeProvider({ available: options.providerAvailable });
  const distiller = createFakeDistiller(options.candidates ?? []);
  const governance = createFakeGovernance();
  const deps: KnowledgeDeps = {
    domain,
    session: { sessionId: 'sess-knowledge' as never, append: () => 1, flush() {} },
    timeline: timeline.seam,
    governance: governance.seam,
    provider: provider.seam,
    distiller: distiller.seam,
    now: options.now ?? (() => NOW),
  };
  const service = createKnowledgeService(deps);
  await service.initialize();
  return {
    service,
    domain,
    timeline,
    provider,
    distiller,
    governance,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

export const draftCandidate = (overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate => ({
  kind: 'method',
  title: '灯环配对法',
  summary: '先发配对指令等待 SN 回帧，确认链路后进入控制序列。',
  edges: [],
  evidenceChunkRefs: ['tl-1', 'tl-2'],
  ...overrides,
});
