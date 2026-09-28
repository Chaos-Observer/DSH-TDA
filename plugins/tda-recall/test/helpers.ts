/**
 * T1.1 测试脚手架：内存 session sink / 假时间线（朴素词项重叠检索）/
 * 焦点 seam 假体 / 内存域装配。
 *
 * 假时间线的 `search` 刻意返回**未归一**的原始分（词项重叠计数），用来验证
 * `normalizeSemantic` 的池内归一——若它偷懒直接透传，跨会话分数就不可比。
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
import { recallDomainSpec, type RecallChunkType, type RecallCredential, type RecallTables } from '../src/domain.ts';
import {
  createRecallService,
  type RecallConfig,
  type RecallGoalSeam,
  type RecallGovernanceSeam,
  type RecallService,
  type RecallTaskSeam,
  type RecallTimelineEntryView,
  type RecallTimelineHit,
  type RecallTimelineQuery,
  type RecallTimelineSeam,
} from '../src/service.ts';

export type SequencedLogEvent = TdaLogEvent & { readonly seq: number; readonly sessionId: SessionId };

/**
 * 内存 session sink：事件**带 seq/sessionId**（compareReplay 要求 SequencedEvent 形态），
 * 因此同一夹具既供服务面也能直接进 replay-equivalence 比对。
 */
export function createMemorySink(sessionId = 'sess-recall'): TdaSessionSink & { readonly events: SequencedLogEvent[] } {
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

export interface FakeEntryInit {
  readonly id: string;
  readonly content: string;
  readonly chunkType?: RecallChunkType;
  readonly credential?: RecallCredential;
  readonly quarantine?: boolean;
  readonly relatedTaskId?: string;
  readonly confidence?: number;
  readonly emotionWeight?: number;
  readonly createdAt: number;
}

export interface FakeTimeline extends RecallTimelineSeam {
  readonly queries: RecallTimelineQuery[];
  put(init: FakeEntryInit): RecallTimelineEntryView;
  readonly views: Map<string, RecallTimelineEntryView>;
}

/** 朴素检索：query 词项在 content 中的出现次数（未归一，故意）。 */
export function createFakeTimeline(entries: readonly FakeEntryInit[] = []): FakeTimeline {
  const views = new Map<string, RecallTimelineEntryView>();
  const queries: RecallTimelineQuery[] = [];
  const put = (init: FakeEntryInit): RecallTimelineEntryView => {
    const view: RecallTimelineEntryView = {
      id: init.id,
      content: init.content,
      ...(init.chunkType !== undefined ? { chunkType: init.chunkType } : {}),
      credential: init.credential ?? 'execution-verified',
      quarantine: init.quarantine ?? false,
      ...(init.relatedTaskId !== undefined ? { relatedTaskId: init.relatedTaskId } : {}),
      ...(init.confidence !== undefined ? { confidence: init.confidence } : {}),
      ...(init.emotionWeight !== undefined ? { emotionWeight: init.emotionWeight } : {}),
      createdAt: init.createdAt,
    };
    views.set(view.id, view);
    return view;
  };
  for (const entry of entries) put(entry);
  return {
    views,
    queries,
    put,
    search(query: RecallTimelineQuery): readonly RecallTimelineHit[] {
      queries.push(query);
      const terms = (query.text ?? '')
        .split(/[\s，。、;；]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 0);
      const hits: RecallTimelineHit[] = [];
      for (const entry of views.values()) {
        if (query.chunkType !== undefined && entry.chunkType !== query.chunkType) continue;
        let score = 0;
        if (terms.length > 0) {
          for (const term of terms) {
            let index = 0;
            while ((index = entry.content.indexOf(term, index)) >= 0) {
              score += 1;
              index += term.length;
            }
          }
          if (score === 0) continue;
        } else {
          score = 1;
        }
        hits.push({ entry, score });
      }
      hits.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1));
      return query.limit !== undefined ? hits.slice(0, query.limit) : hits;
    },
  };
}

export function createFakeGoal(
  view: { id: string; objective: string; completionCriteria: readonly string[] } | undefined,
): RecallGoalSeam {
  return {
    focusView() {
      return view;
    },
  };
}

export function createFakeTask(options: {
  readonly focus?: { id: string; subject: string; description?: string; stage?: string; goalId: string } | undefined;
  readonly siblings?: readonly string[];
}): RecallTaskSeam {
  return {
    focus() {
      const task = options.focus;
      if (task === undefined) return undefined;
      return {
        id: task.id,
        subject: task.subject,
        ...(task.description !== undefined ? { description: task.description } : {}),
        stage: task.stage ?? 'executing',
        goalId: task.goalId,
      };
    },
    idsOfGoal() {
      return options.siblings ?? [];
    },
  };
}

export function createFakeGovernance(lifecycle: Record<string, 'draft' | 'validating' | 'consolidated' | 'retired'>): RecallGovernanceSeam {
  return {
    lifecycleOf(assetId: string) {
      return lifecycle[assetId];
    },
  };
}

export interface RecallFixture {
  readonly service: RecallService;
  readonly domain: TdaDomain<RecallTables>;
  readonly timeline: FakeTimeline;
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly backend: TdaStorageBackend;
  readonly dir: string;
  readonly seeds: ReadonlyMap<string, string>;
  dispose(): Promise<void>;
  /** 内存域（含当前内容）快照，供回放/确定性断言。 */
  snapshot(): string;
  /** 重开一份同目录的服务（模拟重启）。 */
  reopen(): Promise<RecallFixture>;
}

export interface SetupOptions {
  readonly entries?: readonly FakeEntryInit[];
  readonly goal?: { id: string; objective: string; completionCriteria: readonly string[] } | undefined;
  readonly task?: { id: string; subject: string; description?: string; stage?: string; goalId: string } | undefined;
  readonly siblings?: readonly string[];
  readonly lifecycle?: Record<string, 'draft' | 'validating' | 'consolidated' | 'retired'>;
  readonly config?: RecallConfig;
  readonly now?: () => number;
  readonly tokenMeter?: (text: string) => number;
  readonly dir?: string;
}

async function open(options: SetupOptions): Promise<RecallFixture> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'tda-recall-')));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(recallDomainSpec, { backend });
  const timeline = createFakeTimeline(options.entries ?? []);
  const sink = createMemorySink();
  const service = createRecallService({
    domain,
    session: sink,
    timeline,
    ...(options.goal !== undefined ? { goal: createFakeGoal(options.goal) } : {}),
    ...(options.task !== undefined ? { task: createFakeTask({ focus: options.task, siblings: options.siblings ?? [] }) } : {}),
    ...(options.lifecycle !== undefined ? { governance: createFakeGovernance(options.lifecycle) } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.tokenMeter !== undefined ? { tokenMeter: options.tokenMeter } : {}),
  });
  const boot = await service.initialize();
  const seeds = new Map<string, string>();
  for (const event of sink.events) {
    if (event.family === 'recall/change') seeds.set(event.businessId, JSON.stringify(event.payload));
  }
  void boot;
  return {
    service,
    domain,
    timeline,
    sink,
    backend,
    dir,
    seeds,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
    snapshot() {
      const rows: string[] = [];
      for (const tableName of ['recall_params', 'recall_log'] as const) {
        for (const [key, value] of domain.table(tableName).entries()) {
          rows.push(`${tableName}\u0000${key}\u0000${JSON.stringify(value)}`);
        }
      }
      return rows.sort().join('\n');
    },
    async reopen() {
      await domain.close();
      await backend.close();
      return open({ ...options, dir });
    },
  };
}

export const setup = async (options: SetupOptions = {}): Promise<RecallFixture> => open(options);

/** 造条目的便捷函数（默认 active/execution-verified）。 */
export const entry = (id: string, init: Partial<FakeEntryInit> & { createdAt: number }): FakeEntryInit => ({
  content: `内容 ${id}`,
  ...init,
  id,
});

/** 固定基准时刻（2026-09-24T00:00:00Z 附近），让半衰期断言可手算。 */
export const NOW = 1_790_000_000_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
