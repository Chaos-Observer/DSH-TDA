/**
 * T0.4 §2/J5/J6/J7 困惑度 gate：段级近似（v1）+ static 双路径（必须并存）。
 *
 *  - **段级近似**（J5）：用采样窗口内 token 的 `exp(logprob)` 作为该 token 的
 *    "被推断度"，对每段取其段内 token 的均值；段被推断度越高 → 越优先遮蔽
 *    （信息已被当前前缀推断出来，留着的边际价值低）。逐 token 实时计分（理想形态）
 *    归 v2/U4；
 *  - **哨兵过滤**（J7）：DeepSeek 的 `-9999.0` 是"无 logprob"哨兵，聚合前必须剔除，
 *    否则会把不可得误算成"极度不可能"；
 *  - **双路径**（J6）：无样本/样本全哨兵/采样失败 → 自动降级 static
 *    （预算内优先级排序 + 静态截断），**机制不失效**；P0 默认 static。
 */
import type { SegmentKind } from './domain.ts';

export const SENTINEL_LOGPROB = -9_999;

export interface LogprobsToken {
  readonly token: string;
  readonly logprob: number;
  readonly top: readonly { readonly token: string; readonly logprob: number }[];
}

export interface LogprobsSample {
  readonly tokens: readonly LogprobsToken[];
}

export interface ScorableSegment {
  readonly id: string;
  readonly kind: SegmentKind;
  readonly text: string;
  readonly tokenEstimate: number;
}

export interface GateDecision {
  readonly mode: 'perplexity' | 'static';
  /** 建议遮蔽的段 id（升序=先剥）。 */
  readonly droppedSegmentIds: readonly string[];
  readonly sampledTokens: number;
  readonly scores: Readonly<Record<string, number>>;
  readonly fallbackReason?: string;
}

/** 静态优先级表（v1 内置；T1.1 引力场计分器注册后可动态化）。 */
export const STATIC_PRIORITY: Readonly<Record<SegmentKind, number>> = {
  system: 1,
  pinned: 1,
  memo: 0.5,
  history: 0.4,
  injection: 0.3,
};

/** 哨兵过滤：剔除 `-9999.0` 等"无 logprob"样本。 */
export function filterSentinels(sample: LogprobsSample): { readonly tokens: readonly LogprobsToken[]; readonly dropped: number } {
  const kept = sample.tokens.filter((token) => token.logprob > SENTINEL_LOGPROB && Number.isFinite(token.logprob));
  return { tokens: kept, dropped: sample.tokens.length - kept.length };
}

const probabilityOf = (logprob: number): number => {
  // 数值防御：logprob ≤ 0；exp 后裁到 [0,1]
  const value = Math.exp(logprob);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

/** 段级"被推断度"（J5 v1）：段内 token 的平均可推断概率；无重叠样本 → 0（不判定）。 */
export function perplexityScores(
  segments: readonly ScorableSegment[],
  tokens: readonly LogprobsToken[],
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const segment of segments) {
    const hits: number[] = [];
    for (const sample of tokens) {
      if (sample.token === '') continue;
      if (segment.text.includes(sample.token)) hits.push(probabilityOf(sample.logprob));
    }
    scores[segment.id] = hits.length === 0 ? 0 : hits.reduce((sum, value) => sum + value, 0) / hits.length;
  }
  return scores;
}

/** 静态打分：优先级表（可被注册的计分器覆盖）。 */
export function staticScores(
  segments: readonly ScorableSegment[],
  priority: Readonly<Record<SegmentKind, number>> = STATIC_PRIORITY,
  scorers: readonly ((segment: ScorableSegment) => number)[] = [],
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const segment of segments) {
    let score = priority[segment.kind];
    for (const scorer of scorers) {
      // 计分器输出 0–1 的放大/降权分：取均值（多计分器并存时互不覆盖）
      const value = scorer(segment);
      score = (score + Math.max(0, Math.min(1, value))) / 2;
    }
    scores[segment.id] = score;
  }
  return scores;
}

/**
 * 按分数从低到高剥离，直到总 token 落进预算。
 * **pinned 永不进候选**（不变量 1：C6 豁免绝对化）。
 */
export function selectDrops(
  segments: readonly ScorableSegment[],
  scores: Readonly<Record<string, number>>,
  keepTokens: number,
): readonly string[] {
  let total = segments.reduce((sum, segment) => sum + segment.tokenEstimate, 0);
  const candidates = segments
    .filter((segment) => segment.kind !== 'pinned' && segment.kind !== 'system')
    .sort((a, b) => (scores[a.id] ?? 0) - (scores[b.id] ?? 0) || a.id.localeCompare(b.id));
  const dropped: string[] = [];
  for (const segment of candidates) {
    if (total <= keepTokens) break;
    dropped.push(segment.id);
    total -= segment.tokenEstimate;
  }
  return dropped;
}

export interface GateOptions {
  readonly keepTokens: number;
  readonly priority?: Readonly<Record<SegmentKind, number>>;
  readonly scorers?: readonly ((segment: ScorableSegment) => number)[];
}

/** gate 主入口：有有效样本走 perplexity，否则降级 static（J6）。 */
export function runGate(
  segments: readonly ScorableSegment[],
  options: GateOptions,
  sample?: LogprobsSample,
): GateDecision {
  if (sample === undefined) {
    const scores = staticScores(segments, options.priority, options.scorers);
    return {
      mode: 'static',
      droppedSegmentIds: selectDrops(segments, scores, options.keepTokens),
      sampledTokens: 0,
      scores,
      fallbackReason: '无 logprobs 样本（P0 默认 static 路径）',
    };
  }
  const filtered = filterSentinels(sample);
  if (filtered.tokens.length === 0) {
    const scores = staticScores(segments, options.priority, options.scorers);
    return {
      mode: 'static',
      droppedSegmentIds: selectDrops(segments, scores, options.keepTokens),
      sampledTokens: 0,
      scores,
      fallbackReason: `样本全部为哨兵（-9999.0）或空，降级 static（剔除 ${filtered.dropped} 个哨兵）`,
    };
  }
  const scores = perplexityScores(segments, filtered.tokens);
  return {
    mode: 'perplexity',
    droppedSegmentIds: selectDrops(segments, scores, options.keepTokens),
    sampledTokens: filtered.tokens.length,
    scores,
  };
}
