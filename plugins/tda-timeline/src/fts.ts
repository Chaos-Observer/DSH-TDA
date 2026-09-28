/**
 * 时间线 FTS 派生索引（P0 进程内 BM25 实现；sqlite FTS5 seam）。
 *
 * 规格 §3.2：timeline_fts 是派生索引——sqlite 形态为同库 FTS5 虚拟表、
 * 与 domain 同步提交；崩溃恢复以 domain 为准重建。P0 无 sqlite backend，
 * 以进程内倒排实现同一语义：
 *  - add：与写路径同步（正常态两者一致，条目 append-only 只增不改）；
 *  - rebuild：服务启动时从 domain 全量重建（崩溃后索引丢失不丢数据）。
 * seam：DSH sqlite backend 落地后，以 FTS5 虚拟表实现同一 TimelineTextIndex
 * 接口替换本模块，service 零改动（向量检索同样留索引升级位，U2）。
 *
 * 分词：拉丁/数字按词；CJK 无空格分句，取单字 + 相邻二元组（查询子串命中）。
 * BM25：Okapi，k1=1.5，b=0.75；IDF 取 ln(1+(N-n+0.5)/(n+0.5)) 恒正。
 */
import type { TimelineEntry } from './domain.ts';

export interface TimelineTextIndex {
  /** 从 domain 全量重建（崩溃恢复路径）。 */
  rebuild(entries: Iterable<TimelineEntry>): void;
  /** 写路径同步维护（仅 chunk 内容入索引——invalidation 的 reason 不是检索语料）。 */
  add(entry: TimelineEntry): void;
  /** 返回 id → BM25 原始分（仅含命中文档；未命中为空 Map）。 */
  search(text: string): ReadonlyMap<string, number>;
}

const K1 = 1.5;
const B = 0.75;

const LATIN_WORD = /[a-z0-9]+/g;
const CJK_RUN = /[\u4e00-\u9fff]+/g;

/** 中英混合分词：拉丁词 + CJK 单字/二元组。 */
export const tokenize = (text: string): string[] => {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const match of lower.matchAll(LATIN_WORD)) tokens.push(match[0]);
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0];
    for (const ch of run) tokens.push(ch);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
};

interface Posting {
  readonly tf: Map<string, number>;
  readonly length: number;
}

export function createBm25Index(): TimelineTextIndex {
  const postings = new Map<string, Posting>();
  const df = new Map<string, number>();
  let totalLength = 0;

  const indexDoc = (id: string, tokens: readonly string[]): void => {
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    postings.set(id, { tf, length: tokens.length });
    totalLength += tokens.length;
  };

  return {
    rebuild(entries) {
      postings.clear();
      df.clear();
      totalLength = 0;
      for (const entry of entries) {
        if (entry.kind !== 'chunk') continue;
        indexDoc(entry.id, tokenize(entry.content));
      }
    },
    add(entry) {
      if (entry.kind !== 'chunk') return;
      indexDoc(entry.id, tokenize(entry.content));
    },
    search(text) {
      const queryTokens = tokenize(text);
      if (queryTokens.length === 0 || postings.size === 0) return new Map();
      const n = postings.size;
      const avgdl = totalLength / n;
      const uniqueTokens = [...new Set(queryTokens)];
      const scores = new Map<string, number>();
      for (const [id, posting] of postings) {
        let score = 0;
        for (const token of uniqueTokens) {
          const tf = posting.tf.get(token);
          if (tf === undefined) continue;
          const n_t = df.get(token) ?? 0;
          const idf = Math.log(1 + (n - n_t + 0.5) / (n_t + 0.5));
          score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + B * (posting.length / avgdl)));
        }
        if (score > 0) scores.set(id, score);
      }
      return scores;
    },
  };
}
