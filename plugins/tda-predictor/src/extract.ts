/**
 * tda-predictor 抽取与聚合层：**全部纯函数**（T1.3 J2/J4/J5）。
 *
 * 抽取是"确定性本地过程，不经模型"：给定同一份日志前缀，产出逐字段相同。
 * 这是世界模型训练数据管线可重建、可审计的结构性保证——模型参与抽取就等于
 * 引入不可回放的噪声。
 *
 * 为什么聚合也要是纯函数：`predictions.similarTransitionIds + params` 必须
 * 足以事后复算同结果（不变量 5）。任何隐藏状态（缓存、时变权重）都会破坏这一点。
 */
import type { HostRecord, ToolArgClass } from '@tda/kernel';
import type {
  ArgClass,
  DeltaKind,
  OutcomeStatus,
  Prediction,
  PredictParams,
  Transition,
  TransitionKind,
  TransitionStage,
} from './domain.ts';

/** 抽取产出的过渡（id 由服务层分配，这里只管内容）。 */
export type TransitionDraft = Omit<Transition, 'id'>;

export interface ExtractionOptions {
  readonly sessionId: string;
  readonly goalId?: string | undefined;
  readonly taskId?: string | undefined;
  /** 当前任务态（stateBefore/After 的取值；缺省 executing）。 */
  readonly taskStage?: TransitionStage | undefined;
  /** 增量起点（只扫 seq > fromSeq 的记录）。 */
  readonly fromSeq?: number | undefined;
  /** 单批 transition 上限（J10 吞吐帽）。 */
  readonly batchCap?: number | undefined;
}

export interface ExtractionResult {
  readonly transitions: readonly TransitionDraft[];
  /** 本轮检视的记录数。 */
  readonly scanned: number;
  /** 被**刻意**跳过的记录数（`context/assemble` 事件：J1 明义不抽取）。 */
  readonly skipped: number;
  /** 已扫到的最大 seq（下一轮的增量起点）。 */
  readonly watermark: number;
}

const DEFAULT_BATCH_CAP = 200;

const asStage = (value: unknown, fallback: TransitionStage): TransitionStage =>
  value === 'planning' || value === 'executing' || value === 'waiting' || value === 'verifying' ? value : fallback;

const outcomeOfStatus = (status: string): OutcomeStatus =>
  status === 'success' ? 'success' : status === 'partial' ? 'partial' : status === 'failure' ? 'failure' : 'failure';

/**
 * 从会话日志抽取 transition（J1 四类）。
 *
 * 排除 `context/assemble`（每轮必有、无决策性，抽取即噪声）——这条排除被计入
 * `skipped` 而不是静默丢掉，冒烟门以"assemble 事件零抽取"自检（J1 自检）。
 */
export function extractTransitions(
  records: readonly HostRecord[],
  options: ExtractionOptions,
): ExtractionResult {
  const fromSeq = options.fromSeq ?? 0;
  const batchCap = options.batchCap ?? DEFAULT_BATCH_CAP;
  const stage = options.taskStage ?? 'executing';
  const transitions: TransitionDraft[] = [];
  let scanned = 0;
  let skipped = 0;
  let watermark = fromSeq;

  /** 任务态迁移的对比基准（同一次抽取内累积）。 */
  const taskStages = new Map<string, string>();

  for (const record of records) {
    if (record.seq <= fromSeq) continue;
    if (transitions.length >= batchCap) break; // 余量下批续（吞吐帽）
    scanned += 1;
    watermark = record.seq;

    if (record.kind === 'tool/call') {
      transitions.push({
        kind: 'tool-call',
        ...(options.goalId !== undefined ? { goalId: options.goalId } : {}),
        ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
        taskStage: stage,
        action: { tool: record.tool, argClass: record.argClass as ArgClass },
        outcome: {
          status: record.status,
          ...(record.errorClass !== undefined ? { errorClass: record.errorClass } : {}),
        },
        stateBefore: stage,
        stateAfter: stage,
        source: { sessionId: options.sessionId, seqFrom: record.seq, seqTo: record.seq },
        at: record.at,
      });
      continue;
    }

    if (record.kind === 'turn/end' || record.kind === 'interrupted') {
      const closeReason = record.kind === 'interrupted' ? 'interrupted' : record.outcome;
      transitions.push({
        kind: 'turn-close',
        ...(options.goalId !== undefined ? { goalId: options.goalId } : {}),
        ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
        taskStage: stage,
        action: { closeReason },
        outcome: {
          status:
            closeReason === 'interrupted' ? 'partial' : outcomeOfStatus(closeReason === 'failed' ? 'failure' : 'success'),
        },
        source: { sessionId: options.sessionId, seqFrom: record.seq, seqTo: record.seq },
        at: record.at,
      });
      continue;
    }

    if (record.kind !== 'tda') continue;

    if (record.family === 'context/assemble') {
      // J1：注入类不计 transition（每轮必有、无决策性）
      skipped += 1;
      continue;
    }

    if (record.family === 'dispatch/change') {
      const payload = record.payload as Record<string, unknown>;
      // 只在**结算**时抽（建单/开跑没有"结果"，抽了就是半条 transition）
      if (payload.status !== 'settled') continue;
      const result = payload.result as Record<string, unknown> | undefined;
      const role = payload.role === 'lead' || payload.role === 'sidekick' ? payload.role : undefined;
      if (role === undefined) continue;
      const outcomeValue = typeof result?.outcome === 'string' ? result.outcome : 'error';
      transitions.push({
        kind: 'dispatch',
        ...(typeof payload.goalId === 'string' ? { goalId: payload.goalId } : {}),
        ...(typeof payload.taskId === 'string' ? { taskId: payload.taskId } : {}),
        taskStage: stage,
        action: { role },
        outcome: {
          status:
            outcomeValue === 'conclusion' ? 'success' : outcomeValue === 'conclusion-partial' ? 'partial' : 'failure',
          errorClass: outcomeValue === 'conclusion' || outcomeValue === 'conclusion-partial' ? 'dispatch-incomplete' : 'dispatch-error',
          resultClass: outcomeValue,
        },
        source: { sessionId: options.sessionId, seqFrom: record.seq, seqTo: record.seq },
        at: record.at,
      });
      continue;
    }

    if (record.family === 'taskPool/change') {
      const payload = record.payload as Record<string, unknown>;
      const taskId = typeof payload.id === 'string' ? payload.id : undefined;
      if (taskId === undefined) continue;
      const nextStage = asStage(payload.stage, stage);
      const previous = taskStages.get(taskId);
      taskStages.set(taskId, nextStage);
      if (previous === undefined || previous === nextStage) continue; // 无迁移不产 transition
      const phase = typeof payload.phase === 'string' ? payload.phase : 'active';
      const outcome = typeof payload.outcome === 'string' ? payload.outcome : undefined;
      transitions.push({
        kind: 'task-transition',
        ...(typeof payload.goalId === 'string' ? { goalId: payload.goalId } : {}),
        taskId,
        taskStage: nextStage,
        action: { fromStage: previous, toStage: nextStage },
        outcome: {
          status:
            phase === 'complete'
              ? outcome === 'failed'
                ? 'failure'
                : outcome === 'success'
                  ? 'success'
                  : 'partial'
              : 'partial',
          ...(phase === 'complete' && outcome !== undefined ? { resultClass: `outcome:${outcome}` } : {}),
        },
        stateBefore: previous,
        stateAfter: nextStage,
        source: { sessionId: options.sessionId, seqFrom: record.seq, seqTo: record.seq },
        at: record.at,
      });
      continue;
    }
  }

  return { transitions, scanned, skipped, watermark };
}

/** 动作分类串（聚合与比较的唯一口径；也是注入文本里出现的"动作名"）。 */
export function actionToken(transition: {
  readonly kind: TransitionKind;
  readonly action: {
    readonly tool?: string | undefined;
    readonly argClass?: string | undefined;
    readonly role?: string | undefined;
    readonly fromStage?: string | undefined;
    readonly toStage?: string | undefined;
    readonly closeReason?: string | undefined;
  };
}): string {
  switch (transition.kind) {
    case 'tool-call':
      return `${transition.action.tool ?? 'tool'}:${transition.action.argClass ?? 'other'}`;
    case 'dispatch':
      return `dispatch:${transition.action.role ?? 'sidekick'}`;
    case 'task-transition':
      return `stage:${transition.action.fromStage ?? '?'}->${transition.action.toStage ?? '?'}`;
    case 'turn-close':
    default:
      return `close:${transition.action.closeReason ?? 'unknown'}`;
  }
}

export interface TransitionQuery {
  readonly taskId?: string | undefined;
  readonly stage?: string | undefined;
  /** 最近动作分类串（脱敏）。 */
  readonly recentActions: readonly string[];
}

export interface SimilarityParts {
  readonly taskCls: number;
  readonly actionSeq: number;
  readonly state: number;
}

export interface Similarity {
  readonly total: number;
  readonly parts: SimilarityParts;
}

const jaccard = (a: readonly string[], b: readonly string[]): number => {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/**
 * 相似度（J2 的 v1 退化路径：结构化键匹配，不建向量索引）。
 *
 * 三分量：任务类（同任务 = 1 / 同目标 = 0.5 / 否则 0）、动作序列（Jaccard）、
 * 状态（同 stage = 1）。权重来自 `predict_params.simWeights`（可标定）。
 */
export function transitionSimilarity(
  transition: TransitionDraft,
  query: TransitionQuery,
  weights: PredictParams['simWeights'],
): Similarity {
  const taskCls =
    query.taskId === undefined || transition.taskId === undefined
      ? 0
      : transition.taskId === query.taskId
        ? 1
        : 0.5;
  const actionSeq = jaccard([actionToken(transition)], query.recentActions);
  const state = query.stage !== undefined && transition.taskStage === query.stage ? 1 : 0;
  const total = weights.taskCls * taskCls + weights.actionSeq * actionSeq + weights.state * state;
  return { total, parts: { taskCls, actionSeq, state } };
}

export interface SimilarHit {
  readonly transition: TransitionDraft;
  readonly similarity: Similarity;
}

/** top-K 相似检索（显式诊断面与预测内部共用）。 */
export function similarTransitions(
  transitions: readonly TransitionDraft[],
  query: TransitionQuery,
  k: number,
  weights: PredictParams['simWeights'],
): readonly SimilarHit[] {
  return transitions
    .map((transition) => ({ transition, similarity: transitionSimilarity(transition, query, weights) }))
    .filter((hit) => hit.similarity.total > 0)
    .sort(
      (a, b) =>
        b.similarity.total - a.similarity.total ||
        (a.transition.source.seqFrom - b.transition.source.seqFrom) ||
        (a.transition.at - b.transition.at),
    )
    .slice(0, k);
}

/** 风险信号阈值：相似集内失败类别占比 ≥ 此值即进 riskFlags（J4）。 */
export const RISK_FREQ_FLOOR = 1 / 3;

export interface Aggregation {
  readonly nextAction: string;
  readonly outcomeDist: { readonly success: number; readonly failure: number; readonly partial: number };
  readonly riskFlags: readonly { readonly errorClass: string; readonly freq: number }[];
  readonly confidence: number;
}

/**
 * 聚合单步预测（J4）：众数定 nextAction、加权定成败分布、频率定风险。
 *
 * `confidence = 平均相似度 × 支持度系数`（支持度 = min(1, n / topK)）——
 * 两个因子都必须非零：只有一条极相似的历史不足以下结论（样本量），
 * 一堆弱相似的历史也不足（相似度）。这样 θ_pred 才是有意义的门槛。
 */
export function aggregatePrediction(hits: readonly SimilarHit[], topK: number): Aggregation | undefined {
  if (hits.length === 0) return undefined;
  const counts = new Map<string, number>();
  const status = { success: 0, failure: 0, partial: 0 };
  const errorCounts = new Map<string, number>();
  let scoreSum = 0;
  for (const hit of hits) {
    const token = actionToken(hit.transition);
    counts.set(token, (counts.get(token) ?? 0) + 1);
    status[hit.transition.outcome.status] += 1;
    if (hit.transition.outcome.errorClass !== undefined) {
      errorCounts.set(hit.transition.outcome.errorClass, (errorCounts.get(hit.transition.outcome.errorClass) ?? 0) + 1);
    }
    scoreSum += hit.similarity.total;
  }
  const nextAction = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  const total = hits.length;
  const support = Math.min(1, total / Math.max(1, topK));
  const confidence = (scoreSum / total) * support;
  const riskFlags = [...errorCounts.entries()]
    .map(([errorClass, count]) => ({ errorClass, freq: count / total }))
    .filter((flag) => flag.freq >= RISK_FREQ_FLOOR)
    .sort((a, b) => b.freq - a.freq || (a.errorClass < b.errorClass ? -1 : 1));
  return {
    nextAction,
    outcomeDist: { success: status.success / total, failure: status.failure / total, partial: status.partial / total },
    riskFlags,
    confidence,
  };
}

/**
 * 注入文本（J6）：**必带"预测非事实"标注**。
 *
 * 预测源自真实日志（execution-verified 级凭证），但语义是或然的——模型若把它
 * 当既成事实，就会自我实现（预测污染）。故标注不是装饰而是纪律。
 */
export const PREDICTION_CAVEAT = '（基于历史的预测，非既成事实）';

export function renderPrediction(prediction: {
  readonly nextAction: string;
  readonly riskFlags: readonly { readonly errorClass: string; readonly freq: number }[];
  readonly confidence: number;
}): string {
  const risks =
    prediction.riskFlags.length === 0
      ? '无显著历史风险'
      : prediction.riskFlags.map((flag) => `${flag.errorClass}(${(flag.freq * 100).toFixed(0)}%)`).join('、');
  return `下一步最可能：${prediction.nextAction}；历史风险：${risks}${PREDICTION_CAVEAT}`;
}

/**
 * 预测-观测比对（J5 双轨制的"观测"支）。
 *
 * 优先级：**风险命中 > 动作不符 > 结果不符 > 吻合**——风险命中是最高价值的
 * coach 信号（"你预判的那个坑真的踩了"），不该被"动作也不一样"掩盖。
 * 没有实际动作时判 `action`（预测了一个最终没发生的动作）。
 */
export function classifyDelta(
  prediction: Pick<Prediction, 'nextAction' | 'riskFlags' | 'outcomeDist'>,
  actual:
    | {
        readonly action: string;
        readonly outcomeStatus: OutcomeStatus;
        readonly errorClass?: string | undefined;
      }
    | undefined,
): {
  readonly deltaKind: DeltaKind;
  readonly actual: {
    readonly action: string;
    readonly outcomeStatus: OutcomeStatus;
    readonly errorClass?: string | undefined;
  };
} {
  if (actual === undefined) {
    return { deltaKind: 'action', actual: { action: 'none', outcomeStatus: 'partial' } };
  }
  if (actual.errorClass !== undefined && prediction.riskFlags.some((flag) => flag.errorClass === actual.errorClass)) {
    return { deltaKind: 'risk-materialized', actual };
  }
  if (prediction.nextAction !== actual.action) {
    return { deltaKind: 'action', actual };
  }
  if (dominantOutcome(prediction.outcomeDist) !== actual.outcomeStatus) {
    return { deltaKind: 'outcome', actual };
  }
  return { deltaKind: 'none', actual };
}

/** 预测成败分布的众数（"结果不符"的判据；并列时按 success → partial → failure 序取先者）。 */
export function dominantOutcome(dist: {
  readonly success: number;
  readonly failure: number;
  readonly partial: number;
}): OutcomeStatus {
  const ordered: readonly OutcomeStatus[] = ['success', 'partial', 'failure'];
  return ordered.reduce((best, candidate) => (dist[candidate] > dist[best] ? candidate : best), 'success');
}

export type { ToolArgClass };
