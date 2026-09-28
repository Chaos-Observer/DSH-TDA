/**
 * 文件型 session sink：JSONL 追加写，每次 append 后 fsync。
 *
 * kill -9 语义基石："整行落盘 = 事件已提交"；被杀的半行在读回时按撕裂尾丢弃
 * （见 sessionLog.ts）。先域后事件的契约下，撕裂只会表现为"域有日志无"。
 */
import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';
import type { SessionId, Seq, TdaLogEvent, TdaSessionSink } from '@tda/kernel';

export function createFileSessionSink(path: string, sessionId: SessionId): TdaSessionSink {
  let seq = 0;
  return {
    sessionId,
    append(event: TdaLogEvent): Seq {
      seq += 1;
      const line = JSON.stringify({
        sessionId,
        seq,
        family: event.family,
        businessId: event.businessId,
        payload: event.payload,
      });
      appendFileSync(path, `${line}\n`, 'utf8');
      const fd = openSync(path, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return seq;
    },
    flush(): void {
      // 每次 append 已同步落盘；flush 为显式屏障空操作
    },
  };
}
