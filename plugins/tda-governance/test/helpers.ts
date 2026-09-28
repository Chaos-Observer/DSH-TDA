/**
 * T1.2 测试脚手架：假时间线（含 supersede/invalidate 链）/ 假 recall_log / 假任务面。
 *
 * 假时间线刻意实现**真实的链语义**（current() 减去被 supersede 与被 invalidate 的、
 * history() 返回取代/作废闭包）——否则"superseded 自动退役""分叉冲突检测"这两条
 * 就无法被真正验证。
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
  type TdaLogEvent,
  type SessionId,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { governanceDomainSpec, type GovCredential, type GovTables, type GovWriterRef } from '../src/domain.ts';
import {
  createGovernanceService,
  type GovConfig,
  type GovRecallLogRow,
  type GovRecallSeam,
  type GovTaskSeam,
  type GovTimelineChunk,
  type GovTimelineEntry,
  type GovTimelineSeam,
  type GovernanceService,
} from '../src/service.ts';

export type SequencedLogEvent = TdaLogEvent & { readonly seq: number; readonly sessionId: SessionId };

export function createMemorySink(sessionId = 'sess-gov'): TdaSessionSink & { readonly events: SequencedLogEvent[] } {
  const id = asSessionId(sessionId);
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

const QUARANTINE: readonly GovCredential[] = ['tool-output', 'external-content'];

export interface FakeTimeline extends GovTimelineSeam {
  readonly entries: Map<string, GovTimelineEntry>;
  seed(init: Partial<GovTimelineEntry> & { content: string; createdAt: number; credential?: GovCredential }): GovTimelineEntry;
  tokenize(text: string): number;
}

export function createFakeTimeline(initial: readonly (Partial<GovTimelineEntry> & { content: string; createdAt: number })[] = []): FakeTimeline {
  const entries = new Map<string, GovTimelineEntry>();
  let counter = 0;

  /** 分配 id 时跳过已占用的编号（种子条目可能显式指定了 id）。 */
  const nextId = (prefix: string): string => {
    do {
      counter += 1;
    } while (entries.has(`${prefix}-${counter}`));
    return `${prefix}-${counter}`;
  };

  const seed = (init: Partial<GovTimelineEntry> & { content: string; createdAt: number; credential?: GovCredential }): GovTimelineEntry => {
    const credential = init.credential ?? 'model-produced';
    const entry: GovTimelineEntry = {
      id: init.id ?? nextId('tl'),
      kind: init.kind ?? 'chunk',
      content: init.content,
      ...(init.chunkType !== undefined ? { chunkType: init.chunkType } : { chunkType: 'fact' as const }),
      source: init.source ?? 'task',
      credential,
      quarantine: init.quarantine ?? QUARANTINE.includes(credential),
      ...(init.relatedTaskId !== undefined ? { relatedTaskId: init.relatedTaskId } : {}),
      ...(init.supersedes !== undefined ? { supersedes: init.supersedes } : {}),
      ...(init.invalidates !== undefined ? { invalidates: init.invalidates } : {}),
      createdAt: init.createdAt,
    };
    if (entry.kind === 'invalidation') {
      const { chunkType: _dropped, ...rest } = entry;
      void _dropped;
      entries.set(entry.id, rest as GovTimelineEntry);
      return rest as GovTimelineEntry;
    }
    entries.set(entry.id, entry);
    return entry;
  };

  for (const init of initial) seed(init);

  const supersededBy = new Map<string, string[]>();
  const invalidatedBy = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.supersedes !== undefined) {
      const list = supersededBy.get(entry.supersedes) ?? [];
      list.push(entry.id);
      supersededBy.set(entry.supersedes, list);
    }
    if (entry.invalidates !== undefined) invalidatedBy.add(entry.invalidates);
  }

  const seqOf = (id: string): number => Number(id.slice(id.indexOf('-') + 1));

  const current = (): readonly GovTimelineEntry[] =>
    [...entries.values()]
      .filter((entry) => entry.kind === 'chunk')
      .filter((entry) => (supersededBy.get(entry.id) ?? []).length === 0 && !invalidatedBy.has(entry.id))
      .sort((a, b) => seqOf(a.id) - seqOf(b.id));

  const history = (id: string): readonly GovTimelineEntry[] => {
    // 闭包：沿 supersedes / invalidates 双向遍历（取代链与作废链都算"演化史"）
    const closure = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const entry of entries.values()) {
        if (entry.supersedes !== undefined && (closure.has(entry.supersedes) || closure.has(entry.id))) {
          if (!closure.has(entry.supersedes) || !closure.has(entry.id)) {
            closure.add(entry.supersedes);
            closure.add(entry.id);
            grew = true;
          }
        }
        if (entry.invalidates !== undefined && closure.has(entry.invalidates) && !closure.has(entry.id)) {
          closure.add(entry.id);
          grew = true;
        }
      }
    }
    return [...entries.values()]
      .filter((entry) => closure.has(entry.id))
      .sort((a, b) => seqOf(a.id) - seqOf(b.id));
  };

  return {
    entries,
    seed,
    tokenize: (text: string) => Math.max(1, Math.ceil(text.length / 4)),
    current,
    get: (id) => entries.get(id),
    history,
    async supersede(writer: GovWriterRef, id: string, chunk: GovTimelineChunk) {
      void writer;
      const created = seed({
        content: chunk.content,
        chunkType: chunk.chunkType,
        source: chunk.source,
        credential: chunk.credential,
        ...(chunk.relatedTaskId !== undefined ? { relatedTaskId: chunk.relatedTaskId } : {}),
        supersedes: id,
        createdAt: Date.now(),
      });
      const list = supersededBy.get(id) ?? [];
      list.push(created.id);
      supersededBy.set(id, list);
      return { id: created.id };
    },
    async invalidate(writer: GovWriterRef, id: string, reason: string) {
      void writer;
      const created = seed({
        content: `作废：${reason}`,
        kind: 'invalidation',
        invalidates: id,
        credential: 'user-original',
        createdAt: Date.now(),
      });
      invalidatedBy.add(id);
      return { id: created.id };
    },
  };
}

/** 假 recall_log（只暴露治理消费面）。 */
export function createFakeRecall(rows: readonly GovRecallLogRow[] = []): GovRecallSeam & { readonly rows: GovRecallLogRow[] } {
  const list = [...rows];
  return {
    rows: list,
    log(filter = {}) {
      return list.filter((row) => {
        if (filter.entryId !== undefined && row.entryId !== filter.entryId) return false;
        if (filter.injectedOnly === true && !row.injected) return false;
        return true;
      });
    },
  };
}

/** 假任务面（J5 证据校验）。 */
export function createFakeTasks(
  tasks: readonly { id: string; phase?: string; stage?: string; outcome?: string; runCount?: number }[] = [],
): GovTaskSeam {
  const table = new Map(
    tasks.map((task) => [
      task.id,
      {
        id: task.id,
        phase: task.phase ?? 'complete',
        stage: task.stage ?? 'verifying',
        ...(task.outcome !== undefined ? { outcome: task.outcome } : {}),
        runCount: task.runCount ?? 1,
      },
    ]),
  );
  return { get: (id) => table.get(id) };
}

export interface GovFixture {
  readonly service: GovernanceService;
  readonly domain: TdaDomain<GovTables>;
  readonly timeline: FakeTimeline;
  readonly recall: ReturnType<typeof createFakeRecall>;
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly backend: TdaStorageBackend;
  readonly dir: string;
  dispose(): Promise<void>;
  reopen(): Promise<GovFixture>;
}

export interface SetupOptions {
  readonly entries?: readonly (Partial<GovTimelineEntry> & { content: string; createdAt: number })[];
  readonly recall?: readonly GovRecallLogRow[];
  readonly tasks?: readonly { id: string; phase?: string; stage?: string; outcome?: string; runCount?: number }[];
  readonly config?: GovConfig;
  readonly now?: () => number;
  readonly dir?: string;
}

async function open(options: SetupOptions): Promise<GovFixture> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'tda-gov-')));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(governanceDomainSpec, { backend });
  const timeline = createFakeTimeline(options.entries ?? []);
  const recall = createFakeRecall(options.recall ?? []);
  const sink = createMemorySink();
  const service = createGovernanceService({
    domain,
    session: sink,
    timeline,
    recall,
    task: createFakeTasks(options.tasks ?? []),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  await service.initialize();
  return {
    service,
    domain,
    timeline,
    recall,
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
    async reopen() {
      await domain.close();
      await backend.close();
      return open({ ...options, dir });
    },
  };
}

export const setup = (options: SetupOptions = {}): Promise<GovFixture> => open(options);

export const DAY = 86_400_000;
export const NOW = 1_790_000_000_000;
export const CALLER = { actor: 'scheduler', sessionId: 'sess-gov' } as const;
export const HUMAN = { actor: 'human', sessionId: 'sess-human' } as const;
