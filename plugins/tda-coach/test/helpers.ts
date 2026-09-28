/**
 * T2.1 测试脚手架：假六路只读数据源 / 假目标库 seam / 假 PIPE / 假迁移执行器。
 *
 * 否定性断言关键：假目标库记录每次调用名——coach 只允许 propose/rehearse/
 * requestConsolidate（J1 零直接资产写权的实证）；假治理面（govActions 读取）
 * 永远是冷读。
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
import { coachDomainSpec, type CoachTables } from '../src/domain.ts';
import { createCoachService, type CoachService } from '../src/service.ts';

export type SequencedLogEvent = TdaLogEvent & { readonly seq: number; readonly sessionId: SessionId };

/** 内存 session sink：事件带 seq/sessionId（dualwrite/replay 比对需要）。 */
export function createMemorySink(sessionId = 'sess-coach'): TdaSessionSink & { readonly events: SequencedLogEvent[] } {
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

export interface FakeMismatchRow {
  readonly id: string;
  readonly predictionId: string;
  readonly action: string;
  readonly deltaKind: 'action' | 'outcome' | 'risk-materialized' | 'none';
  readonly errorClass?: string;
  readonly at: number;
}

export interface FakePredictionRow {
  readonly id: string;
  readonly taskId?: string;
  readonly stage: string;
}

export interface FakeMetaState {
  readonly seam: {
    propose(actor: unknown, draft: unknown): Promise<{ id: string }>;
    rehearse(actor: unknown, metaPathId: string, taskId: string): Promise<{ id: string; verdict: 'pass' | 'fail' }>;
    requestConsolidate(actor: unknown, metaPathId: string): Promise<void>;
  };
  readonly drafts: unknown[];
  readonly rehearsed: { metaPathId: string; taskId: string }[];
  readonly consolidated: string[];
  readonly calls: string[];
  /** 依次出队的 rehearsal 判定（缺省全 pass）。 */
  verdicts: ('pass' | 'fail')[];
}

export function createFakeMeta(): FakeMetaState {
  const drafts: unknown[] = [];
  const rehearsed: { metaPathId: string; taskId: string }[] = [];
  const consolidated: string[] = [];
  const calls: string[] = [];
  const verdicts: ('pass' | 'fail')[] = [];
  let next = 0;
  return {
    drafts,
    rehearsed,
    consolidated,
    calls,
    verdicts,
    seam: {
      async propose(_actor, draft) {
        calls.push('propose');
        drafts.push(draft);
        next += 1;
        return { id: `mp-${next}` };
      },
      async rehearse(_actor, metaPathId, taskId) {
        calls.push('rehearse');
        rehearsed.push({ metaPathId, taskId });
        const verdict = verdicts.shift() ?? 'pass';
        return { id: `reh-${rehearsed.length}`, verdict };
      },
      async requestConsolidate(_actor, metaPathId) {
        calls.push('requestConsolidate');
        consolidated.push(metaPathId);
      },
    },
  };
}

export interface FakePipeState {
  readonly seam: {
    append(writer: { sessionId: string; at: number }, chunk: {
      content: string;
      chunkType: string;
      credential: string;
      confidence?: number;
    }): Promise<{ id: string }>;
  };
  readonly chunks: { content: string; chunkType: string; credential: string }[];
}

export function createFakePipe(): FakePipeState {
  const chunks: { content: string; chunkType: string; credential: string }[] = [];
  let next = 0;
  return {
    chunks,
    seam: {
      async append(_writer, chunk) {
        chunks.push({ ...chunk });
        next += 1;
        return { id: `tl-${next}` };
      },
    },
  };
}

export interface FakeSkillsState {
  readonly seam: {
    propose(draft: unknown): Promise<{ id: string }>;
    rehearse(skillId: string, taskId: string): Promise<{ id: string; verdict: 'pass' | 'fail' }>;
    requestConsolidate(skillId: string): Promise<unknown>;
  };
  readonly proposed: unknown[];
  readonly consolidated: string[];
}

export function createFakeSkills(): FakeSkillsState {
  const proposed: unknown[] = [];
  const consolidated: string[] = [];
  let next = 0;
  return {
    proposed,
    consolidated,
    seam: {
      async propose(draft) {
        proposed.push(draft);
        next += 1;
        return { id: `sk-${next}` };
      },
      async rehearse(skillId, _taskId) {
        return { id: `skreh-${skillId}`, verdict: 'pass' };
      },
      async requestConsolidate(skillId) {
        consolidated.push(skillId);
        return { ok: true };
      },
    },
  };
}

export interface CoachFixture {
  readonly service: CoachService;
  readonly domain: TdaDomain<CoachTables>;
  readonly meta: FakeMetaState;
  readonly pipe: FakePipeState;
  readonly skills?: FakeSkillsState;
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly backend: TdaStorageBackend;
  readonly dir: string;
  setMismatches(rows: readonly FakeMismatchRow[]): void;
  setPredictions(rows: readonly FakePredictionRow[]): void;
  setRehearsalRuns(rows: readonly { id: string; verdict: string; at: number }[]): void;
  dispose(): Promise<void>;
}

export interface SetupOptions {
  readonly mismatches?: readonly FakeMismatchRow[];
  readonly predictions?: readonly FakePredictionRow[];
  readonly withSkills?: boolean;
  readonly now?: () => number;
  readonly session?: ReturnType<typeof createMemorySink>;
  readonly dir?: string;
}

async function open(options: SetupOptions = {}): Promise<CoachFixture> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'tda-coach-')));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(coachDomainSpec, { backend });
  const meta = createFakeMeta();
  const pipe = createFakePipe();
  const skills = options.withSkills === true ? createFakeSkills() : undefined;
  const sink = options.session ?? createMemorySink();

  let mismatches: readonly FakeMismatchRow[] = options.mismatches ?? [];
  let predictions: readonly FakePredictionRow[] = options.predictions ?? [];
  let rehearsalRuns: readonly { id: string; verdict: string; at: number }[] = [];

  const service = createCoachService({
    domain,
    session: sink,
    reads: {
      mismatches: () =>
        mismatches.map((row) => ({
          id: row.id,
          predictionId: row.predictionId,
          actual: { action: row.action, ...(row.errorClass !== undefined ? { errorClass: row.errorClass } : {}) },
          deltaKind: row.deltaKind,
          at: row.at,
        })),
      predictions: () =>
        predictions.map((row) => ({
          id: row.id,
          context: { ...(row.taskId !== undefined ? { taskId: row.taskId } : {}), stage: row.stage },
        })),
      govActions: () => [],
      rehearsalRuns: () => [...rehearsalRuns],
    },
    meta: meta.seam,
    pipe: pipe.seam,
    ...(skills !== undefined ? { skills: skills.seam } : {}),
    transferExecutor: {
      async run(input) {
        return { verdict: 'pass' as const, rehearsalId: `transfer-${input.modelProfile}` };
      },
    },
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  await service.initialize();
  return {
    service,
    domain,
    meta,
    pipe,
    ...(skills !== undefined ? { skills } : {}),
    sink,
    backend,
    dir,
    setMismatches(rows) {
      mismatches = rows;
    },
    setPredictions(rows) {
      predictions = rows;
    },
    setRehearsalRuns(rows) {
      rehearsalRuns = rows;
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

export const setup = (options: SetupOptions = {}): Promise<CoachFixture> => open(options);

export const NOW = 1_790_000_000_000;

/** 构造 N 条同聚类 mismatch（同 prediction/stage/action，指定 deltaKind）。 */
export const sameCluster = (
  count: number,
  opts: {
    readonly action?: string;
    readonly stage?: string;
    readonly deltaKind?: FakeMismatchRow['deltaKind'];
    readonly errorClass?: string;
    readonly startSeq?: number;
  } = {},
): FakeMismatchRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `mm-${(opts.startSeq ?? 0) + index + 1}`,
    predictionId: 'pred-1',
    action: opts.action ?? 'edit:write',
    deltaKind: opts.deltaKind ?? 'action',
    ...(opts.errorClass !== undefined ? { errorClass: opts.errorClass } : {}),
    at: NOW + index,
  }));
