/**
 * session 日志读回：解析 JSONL，容忍撕裂尾。
 *
 * 规则：完整换行结尾 = 全部行已提交；尾部残缺行 / 中间损坏行按"未提交"丢弃，
 * 并置 tornTail——父进程据此判定是否存在半截事件写入。
 */
import { existsSync, readFileSync } from 'node:fs';
import type { JsonObject, SequencedEvent } from '@tda/kernel';

/** 日志行形态：带序号事件 + 业务 payload（file sink 落盘即含 payload）。 */
export interface SessionLogEvent extends SequencedEvent {
  readonly payload: JsonObject;
}

export interface SessionLogRead {
  readonly events: readonly SessionLogEvent[];
  /** 存在不完整/损坏行（事件写了但没提交） */
  readonly tornTail: boolean;
}

export function readSessionLog(path: string): SessionLogRead {
  if (!existsSync(path)) return { events: [], tornTail: false };
  const raw = readFileSync(path, 'utf8');
  if (raw === '') return { events: [], tornTail: false };
  const lines = raw.split('\n');
  const tail = lines.pop() ?? '';
  const events: SessionLogEvent[] = [];
  let tornTail = tail !== '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as SessionLogEvent);
    } catch {
      // 中间损坏行同样按撕裂处理（保守：不承诺已提交）
      tornTail = true;
    }
  }
  return { events, tornTail };
}
