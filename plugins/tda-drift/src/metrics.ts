/**
 * tda-drift 指标与判带层：**全部纯函数**（T1.5 J2/J8）。
 *
 * 「同 domain 快照 + 同窗口 + 同 params ⇒ 同 DriftSnapshot」是可审计的结构性保证：
 * 四指标全部落在 T0.1 四表 + transitions 的**可机读口径**上，语义相似度（embedding/
 * LLM 评判）P1 刻意不装——不可重算的判断不可审计。
 */
import { DRIFT_METRICS, type DriftLevel, type DriftMetric, type DriftParams, type DriftScores } from './domain.ts';

/** objective_edits 的只读窄视图。 */
export interface ObjectiveEditRow {
  readonly goalId: string;
  readonly at: number;
}

export interface MetricInputs {
  readonly goalId: string;
  readonly now: number;
  readonly params: DriftParams;
  /** 窗口内的 objective_edits（J2①）。 */
  readonly objectiveEdits: readonly ObjectiveEditRow[];
  /** 报告态 vs 实际态的错配数（J2②；由服务按规则集算出）。 */
  readonly consistencyViolations: number;
  /** 一致性检查的规则总数（分母；0 时该指标恒 1）。 */
  readonly consistencyChecks: number;
  /** 窗口内 `constraint-*` 类 blockedReason 发生数（J2③，弱代理，诚实标 U3）。 */
  readonly constraintBlocks: number;
  /** 当前窗口的动作分布（actionToken → 次数；J2④）。 */
  readonly currentDist: ReadonlyMap<string, number>;
  /** 基线窗口的动作分布（前 baselineWindows 个窗口的合并）。 */
  readonly baselineDist: ReadonlyMap<string, number>;
}

/**
 * ① 目标持久性（J2①）：objective_edits 频率趋势。
 * `1 - min(1, edits / maxEdits)`——编辑越频繁分越低。**幅度**的语义度量
 * （embedding 相似度）留 U1，v1 用计数诚实代理。
 */
export function persistenceScore(
  edits: readonly ObjectiveEditRow[],
  goalId: string,
  window: { readonly from: number; readonly to: number },
  maxEditsPerWindow = 3,
): number {
  const count = edits.filter((edit) => edit.goalId === goalId && edit.at >= window.from && edit.at < window.to).length;
  return 1 - Math.min(1, count / Math.max(1, maxEditsPerWindow));
}

/**
 * ② 状态一致性（J2②）：goalTree 报告的 stage 与 taskPool 实际执行态的错配。
 * 规则式（U2 待补全）：
 *  - 报 executing 但无任何 in-progress（有 owner 的 executing）任务 → 违例；
 *  - 报 verifying 但无任何 verifying 任务 → 违例；
 *  - 报 planning 但已有任务在执行 → 违例。
 */
export function consistencyScore(
  violations: number,
  checks: number,
): number {
  if (checks <= 0) return 1;
  return 1 - Math.min(1, violations / checks);
}

/**
 * ③ 约束保持率（J2③）：`constraint-*` 类 blockedReason 的发生与复发。
 * **弱代理**（U3 诚实标注）：blockedReason 之外的行为比对/LLM 评判留 T2.1。
 */
export function constraintRetentionScore(blocks: number, maxBlocksPerWindow = 2): number {
  return 1 - Math.min(1, blocks / Math.max(1, maxBlocksPerWindow));
}

/**
 * ④ 行动波动性（J2④）：当前窗口动作分布对基线窗口的 KL 散度。
 * `1 - min(1, KL / ln 2)`——KL=0（分布未变）→ 1（无波动）；KL ≥ ln2 → 0。
 * 任一侧为空分布 → 1（无证据不判漂移，宁缺毋滥）。
 */
export function actionVolatilityScore(
  currentDist: ReadonlyMap<string, number>,
  baselineDist: ReadonlyMap<string, number>,
): number {
  const currentTotal = [...currentDist.values()].reduce((sum, value) => sum + value, 0);
  const baselineTotal = [...baselineDist.values()].reduce((sum, value) => sum + value, 0);
  if (currentTotal === 0 || baselineTotal === 0) return 1;
  const tokens = new Set([...currentDist.keys(), ...baselineDist.keys()]);
  let kl = 0;
  for (const token of tokens) {
    const p = (currentDist.get(token) ?? 0) / currentTotal;
    const q = (baselineDist.get(token) ?? 0) / baselineTotal;
    if (p === 0) continue; // 0·log(0/q) = 0
    kl += p * Math.log(p / (q === 0 ? 1e-9 : q));
  }
  return 1 - Math.min(1, kl / Math.log(2));
}

export function computeScores(inputs: MetricInputs): DriftScores {
  const to = inputs.now;
  const from = to - inputs.params.windowMs;
  const window = { from, to };
  return {
    persistence: persistenceScore(inputs.objectiveEdits, inputs.goalId, window),
    consistency: consistencyScore(inputs.consistencyViolations, inputs.consistencyChecks),
    constraintRetention: constraintRetentionScore(inputs.constraintBlocks),
    actionVolatility: actionVolatilityScore(inputs.currentDist, inputs.baselineDist),
  };
}

export const compositeScore = (scores: DriftScores, params: DriftParams): number =>
  DRIFT_METRICS.reduce((sum, metric) => sum + params.weights[metric] * scores[metric], 0);

/** 三带判级（J3：composite 双轨）。 */
export function classifyLevel(composite: number, params: DriftParams): DriftLevel {
  if (composite >= params.thresholds.watch) return 'normal';
  if (composite >= params.thresholds.drift) return 'watch';
  return 'drift';
}

/** 单指标越限（候选判据；J3 双轨的第二轨）。 */
export const isMetricBelow = (score: number, params: DriftParams): boolean => score < params.perMetricThreshold;

/**
 * 滞回判定（J5③）：medium 动作需连续 `hysteresisWindows` 个窗口越限。
 * `recentScores` 按时间升序（含当前窗口）——取尾部 N 个全部越限才放行。
 */
export function hysteresisPassed(
  recentScores: readonly number[],
  params: DriftParams,
): boolean {
  if (recentScores.length < params.hysteresisWindows) return false;
  return recentScores.slice(-params.hysteresisWindows).every((score) => score < params.perMetricThreshold);
}

/**
 * 路由（J3）：取**最低**的越限指标（一次只做一件事——温和修正不叠加干扰）。
 * 无越限指标 → undefined（即便 composite 已在 drift 带，也只记录不动作）。
 */
export function routeAction(
  scores: DriftScores,
  hysteresis: Record<DriftMetric, boolean>,
): { readonly metric: DriftMetric; readonly score: number } | undefined {
  const candidates = DRIFT_METRICS.filter((metric) => hysteresis[metric]);
  if (candidates.length === 0) return undefined;
  return candidates.reduce((worst, metric) => (scores[metric] < worst.score ? { metric, score: scores[metric] } : worst), {
    metric: candidates[0]!,
    score: scores[candidates[0]!],
  });
}

/** 校准提示文本（J4：重述/回声/重锚/微调；≤150 token 由服务侧再裁）。 */
export function renderHint(action: string, context: { readonly objective: string; readonly stage: string; readonly constraints: readonly string[]; readonly metric: DriftMetric; readonly score: number }): string {
  const head = `[漂移校准·${action}]`;
  switch (action) {
    case 'restate':
      return `${head} 目标正在偏离，请回到初始目标：${context.objective}`;
    case 'echo':
      return `${head} 报告状态（${context.stage}）与实际执行不一致，请核对当前真实进度后继续`;
    case 'reanchor':
      return `${head} 约束正在被绕开，重新锚定：${context.constraints.join('；') || '（无已声明约束）'}`;
    case 'nudge':
    default:
      return `${head} 行为分布较基线波动明显（${context.metric}=${context.score.toFixed(2)}），请先复核计划再继续`;
  }
}
