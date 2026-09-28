/**
 * tda-timeline 服务：ctx.timeline 服务面实现（T0.3 §4.2）。
 *
 * 设计要点（规格裁定落地）：
 *  - append-only 铁律（J2）：无 update/delete；更正只经 supersede（新 chunk
 *    显式取代）与 invalidate（invalidation 记录作废）两种新记录；
 *  - 单一漏斗（J6）：唯一写入口 = append；supersede/invalidate 内部同样走
 *    统一 commit（落域 → append 事件 → 同步 FTS），任一步抛整 op 抛；
 *  - 计证强约束（J5/§5.2）：quarantine 不接受调用方指定——credential ∈
 *    {tool-output, external-content} 时服务端恒置 true；
 *  - 无 CAS（§4.2）：条目不可变、id 寻址；allocateId('tl') 无洞分配，
 *    跨会话重启后从表内最大后缀续配（seq 单调全局）；
 *  - FTS 派生索引与写路径同步维护；服务构造时从 domain 重建（崩溃恢复）。
 *
 * 规格签名的必要超集（同 tda-goal-state 先例，不变量/审计驱动）：
 * supersede/invalidate 相对 §4.2 签名补 writer 首位参数——更正同样产出
 * 新记录，§5.5 审计基线与 §108"producer 经 WriterRef 声明身份、审计可
 * 归因"要求每条记录可追溯写入方；缺此参数新记录的 writer 只能伪造继承
 * （错归因）或留空（断链），故以调用方显式声明补齐。
 *
 * 进程内互斥锁：id 分配 + 落域 + 双写是复合写，锁保证分配不交错
 * （锁外直写 domain 属注入场景，由不变量门捕获）。
 */
import {
  allocateId,
  dualWrite,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type EntryId,
  type TaskId,
  type TdaDomain,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  QUARANTINE_CREDENTIALS,
  CREDENTIAL_RANK,
  type TimelineCredential,
  type TimelineEntry,
  type TimelineTables,
  type TimelineWriter,
  type WriterRef,
} from './domain.ts';
import { timelineWritePayload } from './events.ts';
import { createBm25Index, type TimelineTextIndex } from './fts.ts';

/** 写入方提交的 chunk（quarantine 不在内——服务端按 credential 强制，J5）。 */
export interface TimelineChunk {
  readonly content: string;
  readonly chunkType: 'fact' | 'method' | 'reflection' | 'skill';
  readonly source: 'task' | 'conversation' | 'study';
  readonly credential: TimelineCredential;
  /** 弱链接（J8：无外键、无级联）。 */
  readonly relatedTaskId?: TaskId;
  readonly trajectoryLink?: string;
  readonly confidence?: number;
  /** P0 占位不计量（J4）。 */
  readonly emotionWeight?: number;
  readonly vector?: number[];
}

/** 时间范围（闭区间；to 缺省为 +∞）。 */
export interface TimelineTimeRange {
  readonly from: number;
  readonly to?: number;
}

export interface TimelineFilter {
  readonly chunkType?: TimelineChunk['chunkType'];
  readonly source?: TimelineChunk['source'];
  /** T1.1 provenance gate 查询侧预筛：凭证等级 ≥ 此值才浮现（J5）。 */
  readonly credentialMin?: TimelineCredential;
  readonly relatedTaskId?: TaskId;
  readonly timeRange?: TimelineTimeRange;
  readonly limit?: number;
}

export interface TimelineQuery extends TimelineFilter {
  readonly text?: string;
  readonly vector?: number[];
  /** 缺省 hybrid（J7：FTS + 暴力余弦混合）。 */
  readonly mode?: 'fts' | 'vector' | 'hybrid';
}

export interface TimelineHit {
  readonly entry: TimelineEntry;
  readonly score: number;
}

export interface TimelineService {
  /** 唯一写入口（J6）：一切 chunk 汇入均经此（带 WriterRef 归因）。 */
  append(writer: WriterRef, chunk: TimelineChunk): Promise<TimelineEntry>;
  /** 版本式更正：新 chunk 显式取代旧 chunk（旧 chunk 保留可溯）。 */
  supersede(writer: WriterRef, id: EntryId, chunk: TimelineChunk, reason: string): Promise<TimelineEntry>;
  /** 作废式更正：invalidation 记录标记目标失效（矛盾/过时，不删除）。 */
  invalidate(writer: WriterRef, id: EntryId, reason: string): Promise<TimelineEntry>;
  get(id: EntryId): TimelineEntry | undefined;
  /** 当前有效事实视图：chunks − 被 supersede 的 − 被 invalidate 的。 */
  current(filter?: TimelineFilter): TimelineEntry[];
  /** 取代/作废链（含起源条目，按 seq 正序）——事实演化追溯证据。 */
  history(id: EntryId): readonly TimelineEntry[];
  /** 混合检索（J7）：BM25 + 暴力余弦；credentialMin 等过滤先行。 */
  search(query: TimelineQuery): TimelineHit[];
}

export interface TimelineServiceDeps {
  readonly domain: TdaDomain<TimelineTables>;
  readonly session: TdaSessionSink;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
}

/** 条目 id 的数值后缀（seq 序：tl-<n> 单调分配，与事件 seq 同序）。 */
const seqOf = (id: string): number => Number(id.slice('tl-'.length));

const bySeq = (a: TimelineEntry, b: TimelineEntry): number => seqOf(a.id) - seqOf(b.id);

const cosine = (a: readonly number[] | undefined, b: readonly number[] | undefined): number => {
  if (a === undefined || b === undefined || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

export function createTimelineService(deps: TimelineServiceDeps): TimelineService {
  const entries = deps.domain.table('timeline_entries');

  // exactOptionalPropertyTypes：仅在有值时挂键，避免显式传 undefined
  const context: DualWriteContext = {
    ...(deps.reconciler ? { reconciler: deps.reconciler } : {}),
    ...(deps.index ? { index: deps.index } : {}),
  };

  // FTS 派生索引：崩溃恢复以 domain 为准重建（§3.2）——索引空载起步，
  // 逐条 add 即 rebuild 语义（add/rebuild 同样跳过 invalidation：reason
  // 不是检索语料）；随后与写路径同步维护
  const fts: TimelineTextIndex = createBm25Index();
  for (const [, entry] of entries.entries()) {
    fts.add(entry);
  }

  // 进程内互斥锁：id 分配 + 落域 + 双写复合写原子化
  let lock: Promise<unknown> = Promise.resolve();
  const withLock = async <T>(op: () => Promise<T>): Promise<T> => {
    const result = lock.then(op, op);
    lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const mustGetChunk = (id: EntryId): TimelineEntry => {
    const entry = entries.get(id);
    if (entry === undefined) {
      throw new TdaError('ENTRY_NOT_FOUND', `时间线条目不存在：${id}`);
    }
    // 不变量 2：supersede/invalidate 只能指向 chunk（禁指向 invalidation 记录）
    if (entry.kind !== 'chunk') {
      throw new TdaError('NOT_A_CHUNK', `条目 ${id} 是 invalidation 记录，不得作为 supersede/invalidate 目标`);
    }
    return entry;
  };

  /** 单次 accepted 写入统一出口：落域 → append log-only 事件 → 同步 FTS。 */
  const commitEntry = async (entry: TimelineEntry): Promise<TimelineEntry> => {
    await dualWrite(
      deps.session,
      {
        family: 'timeline/write',
        businessId: entry.id,
        payload: timelineWritePayload(entry),
        domainWrite: async () => {
          await entries.put(entry.id, entry);
        },
      },
      context,
    );
    fts.add(entry);
    return entry;
  };

  /**
   * invalidation 的 credential 由 writer.actor 派生：作废理由的内容由写入方
   * 产出——human 即 user-original，agent/coach/scheduler（自动角色）即
   * model-produced；source 继承目标条目（同一管线的自我更正）。计证强约束
   * 同样适用（派生结果落入低凭证集时恒检疫）。
   */
  const invalidationCredentialOf = (actor: TimelineWriter): TimelineCredential =>
    actor === 'human' ? 'user-original' : 'model-produced';

  const buildChunkEntry = (
    id: EntryId,
    writer: WriterRef,
    chunk: TimelineChunk,
    correction?: { readonly supersedes: EntryId; readonly reason: string },
  ): TimelineEntry => {
    // 计证强约束（§5.2，服务端强制）：低凭证恒检疫，调用方无从指定
    const quarantine = QUARANTINE_CREDENTIALS.has(chunk.credential);
    return {
      id,
      kind: 'chunk',
      content: chunk.content,
      chunkType: chunk.chunkType,
      source: chunk.source,
      credential: chunk.credential,
      quarantine,
      ...(chunk.relatedTaskId !== undefined ? { relatedTaskId: chunk.relatedTaskId } : {}),
      ...(chunk.trajectoryLink !== undefined ? { trajectoryLink: chunk.trajectoryLink } : {}),
      ...(correction !== undefined ? { supersedes: correction.supersedes } : {}),
      ...(correction !== undefined ? { reason: correction.reason } : {}),
      ...(chunk.confidence !== undefined ? { confidence: chunk.confidence } : {}),
      ...(chunk.emotionWeight !== undefined ? { emotionWeight: chunk.emotionWeight } : {}),
      ...(chunk.vector !== undefined ? { vector: [...chunk.vector] } : {}),
      writer: { sessionId: writer.sessionId, actor: writer.actor, at: writer.at },
      createdAt: Date.now(),
    };
  };

  /** 当前视图判定集：被 supersede 的 chunk + 被 invalidate 的 chunk。 */
  const correctedIds = (): Set<string> => {
    const corrected = new Set<string>();
    for (const [, entry] of entries.entries()) {
      if (entry.kind === 'invalidation') {
        if (entry.invalidates !== undefined) corrected.add(entry.invalidates);
        continue;
      }
      if (entry.supersedes !== undefined) corrected.add(entry.supersedes);
    }
    return corrected;
  };

  const matchesFilter = (entry: TimelineEntry, filter?: TimelineFilter): boolean => {
    if (filter === undefined) return true;
    if (filter.chunkType !== undefined && entry.chunkType !== filter.chunkType) return false;
    if (filter.source !== undefined && entry.source !== filter.source) return false;
    if (filter.credentialMin !== undefined) {
      if (CREDENTIAL_RANK[entry.credential] < CREDENTIAL_RANK[filter.credentialMin]) return false;
    }
    if (filter.relatedTaskId !== undefined && entry.relatedTaskId !== filter.relatedTaskId) return false;
    if (filter.timeRange !== undefined) {
      if (entry.createdAt < filter.timeRange.from) return false;
      if (filter.timeRange.to !== undefined && entry.createdAt > filter.timeRange.to) return false;
    }
    return true;
  };

  /** 过滤后的当前有效视图（不含 limit——limit 在排序/计分后施加）。 */
  const selectCurrent = (filter?: TimelineFilter): TimelineEntry[] => {
    const corrected = correctedIds();
    const out: TimelineEntry[] = [];
    for (const [, entry] of entries.entries()) {
      if (entry.kind !== 'chunk') continue;
      if (corrected.has(entry.id)) continue;
      if (!matchesFilter(entry, filter)) continue;
      out.push(entry);
    }
    out.sort(bySeq);
    return out;
  };

  return {
    async append(writer, chunk) {
      return withLock(async () => {
        // 无洞 id：从表内最大后缀 +1 派生，分配即落键，崩溃不留洞不重号
        const id = allocateId(entries, 'tl') as EntryId;
        return commitEntry(buildChunkEntry(id, writer, chunk));
      });
    },

    async supersede(writer, id, chunk, reason) {
      return withLock(async () => {
        // 目标必须存在且为 chunk（不变量 2；fail-loud 预检，无半套）
        mustGetChunk(id);
        if (reason.trim() === '') {
          throw new TdaError('EMPTY_REASON', `supersede 必须给出更正理由（目标 ${id}）`);
        }
        const newId = allocateId(entries, 'tl') as EntryId;
        return commitEntry(buildChunkEntry(newId, writer, chunk, { supersedes: id, reason }));
      });
    },

    async invalidate(writer, id, reason) {
      return withLock(async () => {
        const target = mustGetChunk(id);
        if (reason.trim() === '') {
          throw new TdaError('EMPTY_REASON', `invalidate 必须给出作废原因（目标 ${id}）`);
        }
        const newId = allocateId(entries, 'tl') as EntryId;
        const credential = invalidationCredentialOf(writer.actor);
        const entry: TimelineEntry = {
          id: newId,
          kind: 'invalidation',
          content: reason,
          source: target.source,
          credential,
          quarantine: QUARANTINE_CREDENTIALS.has(credential),
          invalidates: id,
          writer: { sessionId: writer.sessionId, actor: writer.actor, at: writer.at },
          createdAt: Date.now(),
        };
        return commitEntry(entry);
      });
    },

    get(id) {
      return entries.get(id);
    },

    current(filter) {
      const out = selectCurrent(filter);
      if (filter?.limit !== undefined) return out.slice(0, filter.limit);
      return out;
    },

    history(id) {
      const origin = entries.get(id);
      if (origin === undefined) return [];
      // 传递闭包：起源 + 一切（直接/间接）指向链上成员的更正记录
      const chain: TimelineEntry[] = [origin];
      const collected = new Set<string>([id]);
      let frontier = new Set<string>([id]);
      while (frontier.size > 0) {
        const next = new Set<string>();
        for (const [, entry] of entries.entries()) {
          if (collected.has(entry.id)) continue;
          const target = entry.supersedes ?? entry.invalidates;
          if (target !== undefined && frontier.has(target)) {
            chain.push(entry);
            collected.add(entry.id);
            next.add(entry.id);
          }
        }
        frontier = next;
      }
      chain.sort(bySeq);
      return chain;
    },

    search(query) {
      const mode = query.mode ?? 'hybrid';
      const base = selectCurrent(query);
      const text = query.text;
      const vector = query.vector;
      const wantFts = (mode === 'fts' || mode === 'hybrid') && text !== undefined && text.trim() !== '';
      const wantVector = (mode === 'vector' || mode === 'hybrid') && vector !== undefined && vector.length > 0;

      // 无检索式：退化为过滤视图（按 seq 正序，score 记 0）
      if (!wantFts && !wantVector) {
        const hits = base.map((entry) => ({ entry, score: 0 }));
        return query.limit !== undefined ? hits.slice(0, query.limit) : hits;
      }

      const bm25 = wantFts && text !== undefined ? fts.search(text) : new Map<string, number>();
      let maxBm25 = 0;
      for (const score of bm25.values()) {
        if (score > maxBm25) maxBm25 = score;
      }
      const scored: TimelineHit[] = [];
      for (const entry of base) {
        let score = 0;
        if (wantFts) {
          const raw = bm25.get(entry.id) ?? 0;
          if (maxBm25 > 0) score += 0.5 * (raw / maxBm25);
        }
        if (wantVector) {
          const similarity = cosine(entry.vector, vector);
          if (similarity > 0) score += 0.5 * similarity;
        }
        if (score > 0) scored.push({ entry, score });
      }
      // 分降序；同分按 seq 升序（确定性）
      scored.sort((a, b) => b.score - a.score || bySeq(a.entry, b.entry));
      return query.limit !== undefined ? scored.slice(0, query.limit) : scored;
    },
  };
}
