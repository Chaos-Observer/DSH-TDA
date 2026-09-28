/**
 * 文件型会话主机：JSONL 追加写 + fsync，每行一条宿主记录（IT4 / T0.7 参考实现）。
 *
 * 与 `createFileSessionSink` 的分工：后者只写 TDA log-only 事件（旧插件门继续用它）；
 * 本实现是**宿主面**——除 TDA 事件外还承载轮次括号、`conversation`、`interrupted`
 * closer、`session/end-seed` marker，是 resume / fork / replay 冒烟的落盘基底。
 *
 * 行形态统一为 `{ ...record, sessionId }`；`kind='tda'` 的行同时保留
 * `family/businessId/payload` 顶层字段，因此**与 `readSessionLog` 兼容**
 * （既有插件门的日志读回不必改）。
 *
 * kill -9 语义同 `createFileSessionSink`：整行落盘 = 已提交，撕裂尾在读回时丢弃。
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import {
  asSessionId,
  type EventFamily,
  type HostRecord,
  type JsonObject,
  type Seq,
  type SessionId,
  type TdaLogEvent,
  type TdaSessionHost,
} from '@tda/kernel';

export interface HostLogRead {
  readonly records: readonly HostRecord[];
  /** 尾部残缺/损坏行（写了但未提交）——父进程据此判定撕裂。 */
  readonly tornTail: boolean;
  /** 原始字节（byte 级不变性断言用）。 */
  readonly bytes: Buffer;
}

/** 读回宿主日志（按 seq 升序，容忍撕裂尾）。 */
export function readHostRecords(path: string): HostLogRead {
  if (!existsSync(path)) return { records: [], tornTail: false, bytes: Buffer.alloc(0) };
  const raw = readFileSync(path);
  const text = raw.toString('utf8');
  if (text === '') return { records: [], tornTail: false, bytes: raw };
  const lines = text.split('\n');
  const tail = lines.pop() ?? '';
  const records: HostRecord[] = [];
  let tornTail = tail !== '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line) as HostRecord);
    } catch {
      tornTail = true;
    }
  }
  return { records, tornTail, bytes: raw };
}

/** 磁盘字节（byte 级"历史未被改写"断言用）。 */
export const readHostBytes = (path: string): Buffer => (existsSync(path) ? readFileSync(path) : Buffer.alloc(0));

const writeLine = (path: string, record: HostRecord & { sessionId: SessionId }): void => {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * 打开（或创建）文件会话主机。
 * 已存在的日志被读入内存作为权威视图，`nextSeq` 从中续接——崩溃恢复零丢失。
 */
export function openFileSessionHost(path: string, sessionId: SessionId): TdaSessionHost {
  const read = readHostRecords(path);
  const records: HostRecord[] = [...read.records];

  const push = (record: HostRecord): Seq => {
    records.push(record);
    writeLine(path, { ...record, sessionId });
    return record.seq;
  };

  const host: TdaSessionHost = {
    sessionId,
    records: () => [...records],
    nextSeq: () => records.length + 1,
    append(event: TdaLogEvent): Seq {
      const seq = records.length + 1;
      push({
        seq,
        kind: 'tda',
        at: Date.now(),
        family: event.family as EventFamily,
        businessId: event.businessId,
        payload: event.payload as JsonObject,
      });
      return seq;
    },
    beginTurn(at: number): number {
      const turn = records.filter((record) => record.kind === 'turn/start').length;
      push({ seq: records.length + 1, kind: 'turn/start', at, turn });
      return turn;
    },
    endTurn(at: number, turn: number, outcome: 'success' | 'failed' | 'aborted'): Seq {
      return push({ seq: records.length + 1, kind: 'turn/end', at, turn, outcome });
    },
    appendMessage(message, at): Seq {
      return push({
        seq: records.length + 1,
        kind: 'conversation',
        at,
        turn: message.turn,
        role: message.role,
        content: message.content,
      });
    },
    closeTurn(turn: number, reason: string, at: number): Seq {
      // resume 只追加：为开放轮次合成 interrupted closer（历史记录字节不变）
      return push({ seq: records.length + 1, kind: 'interrupted', at, turn, reason });
    },
    appendSeedEnd(note: string, at: number): Seq {
      return push({ seq: records.length + 1, kind: 'session/end-seed', at, note });
    },
    appendToolCall(call, at): Seq {
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
    flush(): void {
      // 每次写入已 fsync；flush 为显式屏障空操作
    },
  };
  return host;
}

export interface ForkFileOptions {
  /** 父会话日志路径。 */
  readonly sourcePath: string;
  /** 子会话日志路径（须不存在或为空）。 */
  readonly targetPath: string;
  readonly childSessionId: string;
  /** fork 边界：**已闭合轮次**的序号。 */
  readonly boundary: number;
  readonly at: number;
}

export interface ForkFileResult {
  readonly sessionId: SessionId;
  /** 实际继承的记录数（应等于调用方声明的 inheritedEventCount）。 */
  readonly inheritedEventCount: number;
  readonly records: readonly HostRecord[];
}

/**
 * 文件级 fork：截取父日志中 `boundary` 轮闭合处之前的 balanced 前缀，
 * 重新编号（seq 从 1 连续）写入子日志，并在末尾追加 `session/end-seed` marker。
 * 校验交给 `checkSeedInvariants`（不做自我确认）。
 */
export function forkFileSessionHost(options: ForkFileOptions): ForkFileResult {
  const parent = readHostRecords(options.sourcePath).records;
  const ordered = [...parent].sort((a, b) => a.seq - b.seq);
  let boundarySeq = 0;
  for (const record of ordered) {
    if (record.kind === 'turn/end' && record.turn === options.boundary) {
      boundarySeq = Math.max(boundarySeq, record.seq);
    }
    if (record.kind === 'interrupted' && record.turn === options.boundary) {
      boundarySeq = Math.max(boundarySeq, record.seq);
    }
  }
  const prefix = ordered.filter((record) => record.seq <= boundarySeq);
  const sessionId = asSessionId(options.childSessionId);
  const lines: string[] = [];
  prefix.forEach((record, index) => {
    lines.push(`${JSON.stringify({ ...record, seq: index + 1, sessionId })}\n`);
  });
  lines.push(
    `${JSON.stringify({
      seq: prefix.length + 1,
      kind: 'session/end-seed',
      at: options.at,
      note: `fork@turn-${options.boundary}`,
      sessionId,
    })}\n`,
  );
  writeFileSync(options.targetPath, lines.join(''), 'utf8');
  const host = openFileSessionHost(options.targetPath, sessionId);
  return { sessionId, inheritedEventCount: prefix.length, records: host.records() };
}

/** 撕裂尾判定：只看"最后一行是否完整换行结尾"。 */
export const hasCompleteLastLine = (bytes: Buffer): boolean =>
  bytes.length === 0 || bytes.subarray(bytes.length - 1).toString('utf8') === '\n';
