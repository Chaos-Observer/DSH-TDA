/**
 * tda-trajectory 测试脚手架：内存会话主机 + 内嵌"域现状来源"假体。
 *
 * 内存主机与文件主机（testkit `openFileSessionHost`）实现同一个 `TdaSessionHost`
 * 面——前者用于纯逻辑用例，后者用于 kill -9 冒烟；两者语义必须一致（这本身就是
 * "seam 足够窄"的检验）。
 */
import {
  asSessionId,
  type EventFamily,
  type HostRecord,
  type Seq,
  type SessionId,
  type TdaLogEvent,
  type TdaSessionHost,
} from '@tda/kernel';
import type { TrajectoryDomainSource } from '../src/service.ts';

export function createMemoryHost(sessionId = 'sess-traj'): TdaSessionHost {
  const records: HostRecord[] = [];
  const id = asSessionId(sessionId);
  const push = (record: HostRecord): Seq => {
    records.push(record);
    return record.seq;
  };
  let at = 1_700_000_000_000;
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
    beginTurn(): number {
      at += 1;
      const turn = records.filter((record) => record.kind === 'turn/start').length;
      push({ seq: records.length + 1, kind: 'turn/start', at, turn });
      return turn;
    },
    endTurn(_at: number, turn: number, outcome: 'success' | 'failed' | 'aborted'): Seq {
      at += 1;
      return push({ seq: records.length + 1, kind: 'turn/end', at, turn, outcome });
    },
    appendMessage(message): Seq {
      at += 1;
      return push({
        seq: records.length + 1,
        kind: 'conversation',
        at,
        turn: message.turn,
        role: message.role,
        content: message.content,
      });
    },
    closeTurn(turn: number, reason: string): Seq {
      at += 1;
      return push({ seq: records.length + 1, kind: 'interrupted', at, turn, reason });
    },
    appendToolCall(call): Seq {
      at += 1;
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
    appendSeedEnd(note: string): Seq {
      at += 1;
      return push({ seq: records.length + 1, kind: 'session/end-seed', at, note });
    },
    flush(): void {},
  };
}

/** 域现状来源假体：`Map<entityId, revision>` 即全部。 */
export function createSource(
  entityKind: TrajectoryDomainSource['entityKind'],
  family: string,
  initial: Record<string, number> = {},
): TrajectoryDomainSource & { set(entityId: string, revision: number): void; remove(entityId: string): void } {
  const table = new Map<string, number>(Object.entries(initial));
  return {
    entityKind,
    family,
    entries: () => [...table.entries()].map(([entityId, revision]) => ({ entityId, revision })),
    set(entityId, revision) {
      table.set(entityId, revision);
    },
    remove(entityId) {
      table.delete(entityId);
    },
  };
}

export type { SessionId };
