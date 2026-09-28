/**
 * T2.6 内存 sink（与其它插件同款；独立文件避免夹具循环导入）。
 */
import type { SessionId, TdaDomain, TdaLogEvent, TdaSessionSink, TdaStorageBackend } from '@tda/kernel';

export type SequencedLogEvent = TdaLogEvent & { readonly seq: number; readonly sessionId: SessionId };

export function createMemorySink(sessionId = 'sess-scout'): TdaSessionSink & { readonly events: SequencedLogEvent[] } {
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

export type { TdaDomain, TdaStorageBackend };
