/**
 * tda-timeline 事件构造：只允许走已登记族（timeline/write，编号 3）。
 *
 * 载荷 = TimelineEntry 全量（append-only 铁律的审计面）：replay-equivalence
 * 的 rebuild 直接以 payload 还原记录；事件不存 seq（seq 由 session sink 拥有序
 * 分配，条目经 id 的数值后缀对齐同一顺序）。显式逐字段构造（不用展开）：
 * 保证 payload 形态与记录逐字段一致，可选字段遵循 exactOptionalPropertyTypes
 * ——仅在在场时挂键。
 */
import type { JsonObject } from '@tda/kernel';
import type { TimelineEntry } from './domain.ts';

export type TimelineWriteEventPayload = JsonObject;

export const timelineWritePayload = (entry: TimelineEntry): TimelineWriteEventPayload => ({
  id: entry.id,
  kind: entry.kind,
  content: entry.content,
  ...(entry.chunkType !== undefined ? { chunkType: entry.chunkType } : {}),
  source: entry.source,
  credential: entry.credential,
  quarantine: entry.quarantine,
  ...(entry.relatedTaskId !== undefined ? { relatedTaskId: entry.relatedTaskId } : {}),
  ...(entry.trajectoryLink !== undefined ? { trajectoryLink: entry.trajectoryLink } : {}),
  ...(entry.supersedes !== undefined ? { supersedes: entry.supersedes } : {}),
  ...(entry.invalidates !== undefined ? { invalidates: entry.invalidates } : {}),
  ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
  ...(entry.emotionWeight !== undefined ? { emotionWeight: entry.emotionWeight } : {}),
  ...(entry.vector !== undefined ? { vector: [...entry.vector] } : {}),
  writer: { sessionId: entry.writer.sessionId, actor: entry.writer.actor, at: entry.writer.at },
  createdAt: entry.createdAt,
});
