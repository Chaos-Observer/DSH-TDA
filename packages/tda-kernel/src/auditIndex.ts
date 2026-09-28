/**
 * audit_index：溯源总线的内存参考实现（派生数据，可由事件日志重建）。
 *
 * 双写器内部按族→entityKind 自动写索引，插件零代码；
 * 同实体多次写入延展 seqTo（seqFrom 保持首次）。
 * rebuild 要求事件按 seq 升序供给（session 日志天然有序）。
 */
import { entityKindOf, type EntityKind, type EventFamily } from './events.ts';
import type { Seq, SessionId } from './types.ts';

export interface AuditIndexEntry {
  readonly entityKind: EntityKind;
  readonly entityId: string;
  readonly sessionId: SessionId;
  readonly seqFrom: Seq;
  seqTo: Seq;
  readonly at: number;
}

/** 带序号的事件（session sink 落盘后的形态），rebuild 的输入。 */
export interface SequencedEvent {
  readonly sessionId: SessionId;
  readonly seq: Seq;
  readonly family: EventFamily;
  readonly businessId: string;
}

export interface AuditIndex {
  record(entityKind: EntityKind, entityId: string, sessionId: SessionId, seq: Seq): void;
  locate(entityKind: EntityKind, entityId: string): AuditIndexEntry | undefined;
  entries(): readonly AuditIndexEntry[];
  rebuild(events: readonly SequencedEvent[]): void;
}

export function createAuditIndex(): AuditIndex {
  const index = new Map<string, AuditIndexEntry>();
  const keyOf = (entityKind: EntityKind, entityId: string): string => `${entityKind}\u0000${entityId}`;

  const record = (entityKind: EntityKind, entityId: string, sessionId: SessionId, seq: Seq): void => {
    const key = keyOf(entityKind, entityId);
    const existing = index.get(key);
    if (existing) {
      existing.seqTo = seq;
      return;
    }
    index.set(key, { entityKind, entityId, sessionId, seqFrom: seq, seqTo: seq, at: Date.now() });
  };

  return {
    record,
    locate(entityKind, entityId) {
      return index.get(keyOf(entityKind, entityId));
    },
    entries() {
      return [...index.values()];
    },
    rebuild(events) {
      index.clear();
      for (const event of events) {
        record(entityKindOf(event.family), event.businessId, event.sessionId, event.seq);
      }
    },
  };
}
