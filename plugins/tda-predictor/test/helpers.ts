/**
 * T1.3 测试脚手架：内存宿主（可写工具调用与 TDA 事件）/ 域装配 / 会话 sink。
 *
 * 内存宿主刻意实现**真实的轮次语义**（turn/start 计轮号、turn/end 闭合），
 * 因为 `observe` 要靠轮次区间定位"实际动作"——夹具若不真，观测就测不出来。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asSessionId,
  createJsonBackend,
  openTdaDomain,
  type EventFamily,
  type HostRecord,
  type Seq,
  type SessionId,
  type TdaDomain,
  type TdaLogEvent,
  type TdaSessionHost,
  type TdaSessionSink,
  type TdaStorageBackend,
  type ToolArgClass,
} from '@tda/kernel';
import { predictorDomainSpec, type PredictorTables } from '../src/domain.ts';
import {
  createPredictorService,
  type PredictorConfig,
  type PredictorService,
  type PredictorTaskSeam,
} from '../src/service.ts';

export type SequencedLogEvent = TdaLogEvent & { readonly seq: number; readonly sessionId: SessionId };

export function createMemorySink(sessionId = 'sess-predict'): TdaSessionSink & { readonly events: SequencedLogEvent[] } {
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

export interface MemoryHost extends TdaSessionHost {
  turn(at: number): number;
  tool(call: { turn: number; tool: string; argClass: ToolArgClass; status: 'success' | 'failure'; errorClass?: string }, at: number): Seq;
  message(call: { turn: number; role: 'user' | 'assistant' | 'tool'; content: string }, at: number): Seq;
  close(turn: number, outcome: 'success' | 'failed' | 'aborted', at: number): Seq;
  crash(turn: number, reason: string, at: number): Seq;
}

export function createMemoryHost(sessionId = 'sess-predict'): MemoryHost {
  const records: HostRecord[] = [];
  const id = asSessionId(sessionId);
  let at = 1_790_000_000_000;
  const push = (record: HostRecord): Seq => {
    records.push(record);
    return record.seq;
  };
  return {
    sessionId: id,
    records: () => [...records].sort((a, b) => a.seq - b.seq),
    nextSeq: () => records.length + 1,
    append(event: TdaLogEvent): Seq {
      at += 1;
      return push({
        seq: records.length + 1,
        kind: 'tda',
        at,
        family: event.family as EventFamily,
        businessId: event.businessId,
        payload: event.payload,
      });
    },
    flush() {},
    beginTurn(): number {
      at += 1;
      const turn = records.filter((record) => record.kind === 'turn/start').length;
      push({ seq: records.length + 1, kind: 'turn/start', at, turn });
      return turn;
    },
    turn(atOverride: number): number {
      at = atOverride;
      const turn = records.filter((record) => record.kind === 'turn/start').length;
      push({ seq: records.length + 1, kind: 'turn/start', at, turn });
      return turn;
    },
    endTurn(): Seq {
      throw new Error('请用 close()/crash()（需要显式轮号与结局）');
    },
    close(turn, outcome, atOverride): Seq {
      at = atOverride;
      return push({ seq: records.length + 1, kind: 'turn/end', at, turn, outcome });
    },
    crash(turn, reason, atOverride): Seq {
      at = atOverride;
      return push({ seq: records.length + 1, kind: 'interrupted', at, turn, reason });
    },
    tool(call, atOverride): Seq {
      at = atOverride;
      return push({
        seq: records.length + 1,
        kind: 'tool/call',
        at,
        turn: call.turn,
        tool: call.tool,
        argClass: call.argClass,
        status: call.status,
        ...(call.errorClass !== undefined ? { errorClass: call.errorClass } : {}),
      });
    },
    message(call, atOverride): Seq {
      at = atOverride;
      return push({
        seq: records.length + 1,
        kind: 'conversation',
        at,
        turn: call.turn,
        role: call.role,
        content: call.content,
      });
    },
    appendMessage(message, atOverride): Seq {
      return this.message(message, atOverride);
    },
    closeTurn(turn, reason, atOverride): Seq {
      return this.crash(turn, reason, atOverride);
    },
    appendToolCall(call, atOverride): Seq {
      return this.tool({ ...call }, atOverride);
    },
    appendSeedEnd(note, atOverride): Seq {
      at = atOverride;
      return push({ seq: records.length + 1, kind: 'session/end-seed', at, note });
    },
  };
}

export function createFakeTask(
  focus: { id: string; stage: string; goalId: string } | undefined,
): PredictorTaskSeam {
  return {
    focus() {
      return focus;
    },
  };
}

export interface PredictorFixture {
  readonly service: PredictorService;
  readonly domain: TdaDomain<PredictorTables>;
  readonly host: MemoryHost;
  /**
   * 会话 sink = 宿主本体（生产形态：TdaSessionHost extends TdaSessionSink）。
   * 刻意不另造 sink——否则 predict/change 事件不落日志，
   * "预测可由事件重放"这条不变量就没了判据。
   */
  readonly sink: MemoryHost;
  readonly backend: TdaStorageBackend;
  readonly dir: string;
  readonly degraded: string[];
  dispose(): Promise<void>;
}

export interface SetupOptions {
  readonly host?: MemoryHost;
  readonly focus?: { id: string; stage: string; goalId: string } | undefined;
  readonly config?: PredictorConfig;
  readonly now?: () => number;
  readonly dir?: string;
}

async function open(options: SetupOptions): Promise<PredictorFixture> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'tda-predict-')));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(predictorDomainSpec, { backend });
  const host = options.host ?? createMemoryHost();
  const degraded: string[] = [];
  const service = createPredictorService({
    domain,
    session: host,
    task: createFakeTask(options.focus ?? { id: 'task-1', stage: 'executing', goalId: 'goal-1' }),
    onDegrade: (message) => degraded.push(message),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  await service.initialize();
  return {
    service,
    domain,
    host,
    sink: host,
    backend,
    dir,
    degraded,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

export const setup = (options: SetupOptions = {}): Promise<PredictorFixture> => open(options);

export const BASE_AT = 1_790_000_000_000;

/**
 * 造一段历史轨迹："executing + edit(write) → timeout" 重复 times 轮。
 * 返回下一个可用轮号（便于继续追加"本轮"）。
 */
export function seedFailureHistory(host: MemoryHost, times: number, at = BASE_AT): number {
  let clock = at;
  for (let index = 0; index < times; index += 1) {
    const turn = host.turn(clock);
    clock += 1000;
    host.tool({ turn, tool: 'edit', argClass: 'write', status: 'failure', errorClass: 'timeout' }, clock);
    clock += 1000;
    host.close(turn, 'failed', clock);
    clock += 1000;
  }
  return times;
}
