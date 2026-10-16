/**
 * P5.2 · DSH 兼容会话主机：TdaSessionHost 的 **DSH jsonl 物理格式**实现。
 *
 * 与 `openFileSessionHost`（testkit，IT4 参考实现）的分工：后者是 TDA 自有行形态
 * （`{...record, sessionId}`）；本实现写出的日志**可被 DSH session-persistence
 * 采纳**——首行 DSH header（version 4）+ 事件行 DSH 信封
 * `{type, seq, time, ignorable: true, data}`。
 *
 * 三条对齐裁定（详见《DSH真装配-勘察与施工图》§2）：
 *  1. **全部 TDA 记录 `ignorable: true`**：DSH 词表封闭，未知类型必须 ignorable
 *     才被采纳——而"未知读者可安全跳过"恰是 TDA **log-only 纯净**（sessionHost J1）
 *     的 DSH 对偶：TDA 事件丢失不影响会话重建（权威在各插件 domain）；
 *  2. **type 命名**：`tda/<family>`（TDA 事件）或 `tda/<kind>`（其余宿主记录）；
 *     原始 HostRecord 全量存于 `data`（读回无损还原）；
 *  3. **conversation → DSH 原生消息类型**（user/message 等）的映射留 P5.4
 *     （需 Message 内容块结构对齐）——本阶段 DSH 侧看到的是可解析、seq 连续、
 *     可安全跳过的完整轨迹。
 *
 * kill -9 语义同文件主机：整行落盘 = 已提交（fsync），撕裂尾在读回时丢弃；
 * 重开 seq 续接，历史字节不变。header 行为 DSH 规定（`type:'session'`，version 4）。
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync } from 'node:fs';
import { type HostRecord, type TdaSessionHost } from './sessionHost.ts';
import type { EventFamily, TdaLogEvent } from './events.ts';
import { asSessionId } from './types.ts';
import type { Seq, SessionId } from './types.ts';

/** DSH 会话格式版本（镜像 vendor core/session SESSION_FORMAT_VERSION=4；升级随 vendor 重放核对）。 */
export const DSH_SESSION_FORMAT_VERSION = 4;

/** DSH jsonl 首行 header（session-persistence-jsonl format.ts HeaderLine 形态）。 */
export interface DshSessionHeaderLine {
  readonly type: 'session';
  readonly version: number;
  readonly id: SessionId;
  readonly createdAt: number;
  readonly isSeeded: boolean;
  readonly delegationDepth: number;
}

/** 事件行的 DSH 信封（ignorable 恒 true——裁定 1）。 */
export interface DshEventLine {
  readonly type: string;
  readonly seq: Seq;
  readonly time: number;
  readonly ignorable: true;
  readonly data: HostRecord;
}

export interface DshCompatRead {
  readonly records: readonly HostRecord[];
  readonly header: DshSessionHeaderLine | undefined;
  /** 尾部残缺/损坏行（写了但未提交）。 */
  readonly tornTail: boolean;
  /** 原始字节（byte 级不变性断言用）。 */
  readonly bytes: Buffer;
}

/** type 映射（裁定 2）。 */
export const dshEventTypeOf = (record: HostRecord): string =>
  record.kind === 'tda' ? `tda/${record.family}` : `tda/${record.kind}`;

/** 读回 DSH 兼容日志：header + data 还原为 HostRecord；撕裂尾丢弃；未知 DSH 行忽略。 */
export function readDshCompatRecords(path: string): DshCompatRead {
  if (!existsSync(path)) return { records: [], header: undefined, tornTail: false, bytes: Buffer.alloc(0) };
  const raw = readFileSync(path);
  const text = raw.toString('utf8');
  if (text === '') return { records: [], header: undefined, tornTail: false, bytes: raw };
  const lines = text.split('\n');
  const tail = lines.pop() ?? '';
  const records: HostRecord[] = [];
  let header: DshSessionHeaderLine | undefined;
  let tornTail = tail !== '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; data?: HostRecord; id?: SessionId; version?: number; createdAt?: number; isSeeded?: boolean };
      if (parsed.type === 'session') {
        header = {
          type: 'session',
          version: Number(parsed.version),
          id: parsed.id as SessionId,
          createdAt: Number(parsed.createdAt),
          isSeeded: parsed.isSeeded === true,
          delegationDepth: 0,
        };
        continue;
      }
      if (parsed.type !== undefined && parsed.type.startsWith('tda/') && parsed.data !== undefined) {
        records.push(parsed.data);
        continue;
      }
      // 未知 DSH 原生行（P5.4 共存场景）：忽略但不标记撕裂
    } catch {
      tornTail = true;
    }
  }
  return { records, header, tornTail, bytes: raw };
}

const writeLine = (path: string, line: object): void => {
  appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * 打开（或创建）DSH 兼容会话主机。已存在日志读入内存续接 seq；首行 header
 * 仅在创建时写入（resume 只追加，历史字节不变）。
 */
export function openDshCompatSessionHost(
  path: string,
  sessionId: SessionId,
  meta: { readonly createdAt?: number; readonly cwd?: string } = {},
): TdaSessionHost {
  const read = readDshCompatRecords(path);
  const records: HostRecord[] = [...read.records];
  if (read.tornTail) {
    // truncation-repair（DSH format.ts 同语义）：撕裂尾未提交——截断到最后一个
    // 完整换行，保证后续追加不会粘在半行之后（kill -9 后首写前必须做）。
    const bytes = read.bytes;
    const lastNewline = bytes.lastIndexOf(0x0a);
    truncateSync(path, lastNewline + 1);
  }
  if (!existsSync(path) || read.bytes.length === 0) {
    const header: DshSessionHeaderLine = {
      type: 'session',
      version: DSH_SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: meta.createdAt ?? Date.now(),
      isSeeded: false,
      delegationDepth: 0,
    };
    writeLine(path, header);
  } else if (read.header !== undefined && read.header.id !== sessionId) {
    throw new Error(`dsh-compat 会话身份不符：文件 header id="${String(read.header.id)}"，请求 "${sessionId}"`);
  }

  const push = (record: HostRecord): Seq => {
    records.push(record);
    const line: DshEventLine = {
      type: dshEventTypeOf(record),
      seq: record.seq,
      time: record.at,
      ignorable: true,
      data: record,
    };
    writeLine(path, line);
    return record.seq;
  };

  const host: TdaSessionHost = {
    sessionId,
    records: () => [...records],
    nextSeq: (): Seq => (records.length === 0 ? 1 : (records[records.length - 1]?.seq ?? 0) + 1),
    append(event: TdaLogEvent): Seq {
      const seq = (records.length === 0 ? 0 : (records[records.length - 1]?.seq ?? 0)) + 1;
      return push({
        seq,
        kind: 'tda',
        at: Date.now(),
        family: event.family as EventFamily,
        businessId: event.businessId,
        payload: event.payload,
      });
    },
    beginTurn(at: number): number {
      const turn = records.filter((record) => record.kind === 'turn/start').length;
      push({ seq: (records[records.length - 1]?.seq ?? 0) + 1, kind: 'turn/start', at, turn });
      return turn;
    },
    endTurn(at: number, turn: number, outcome: 'success' | 'failed' | 'aborted'): Seq {
      return push({ seq: (records[records.length - 1]?.seq ?? 0) + 1, kind: 'turn/end', at, turn, outcome });
    },
    appendMessage(message, at): Seq {
      return push({
        seq: (records[records.length - 1]?.seq ?? 0) + 1,
        kind: 'conversation',
        at,
        turn: message.turn,
        role: message.role,
        content: message.content,
      });
    },
    closeTurn(turn: number, reason: string, at: number): Seq {
      // resume 只追加：为开放轮次合成 interrupted closer（历史字节不变）
      return push({ seq: (records[records.length - 1]?.seq ?? 0) + 1, kind: 'interrupted', at, turn, reason });
    },
    appendSeedEnd(note: string, at: number): Seq {
      return push({ seq: (records[records.length - 1]?.seq ?? 0) + 1, kind: 'session/end-seed', at, note });
    },
    flush(): void {
      // 每行写时已 fsync（writeLine）——flush 为收口 noop（契约占位）
    },
    appendToolCall(call, at): Seq {
      return push({
        seq: (records[records.length - 1]?.seq ?? 0) + 1,
        kind: 'tool/call',
        at,
        turn: call.turn,
        tool: call.tool,
        argClass: call.argClass,
        status: call.status,
        ...(call.errorClass !== undefined ? { errorClass: call.errorClass } : {}),
      });
    },
  };
  void asSessionId;
  return host;
}
