/**
 * tda-recall 计分与 provenance gate 的**纯函数**层（T1.1 §2 / §4.1）。
 *
 * 全部无副作用、无时间源（`at` 由调用方传入）：这是回放确定性（不变量 7）
 * 的结构性保证——同 log 前缀 + 同 params 快照 ⇒ 同候选同分，没有任何隐藏状态。
 */
import {
  GATE_BLOCKED_CREDENTIALS,
  type RecallChunkType,
  type RecallCredential,
  type RecallParams,
} from './domain.ts';

/** gate 的输入面（时间线条目在 recall 侧的只读窄视图）。 */
export interface GateInput {
  readonly entryId: string;
  readonly quarantine: boolean;
  readonly credential: RecallCredential;
  readonly confidence?: number | undefined;
  readonly relatedTaskId?: string | undefined;
}

/** 焦点上下文（J2：query 构造的输入；也是 gate ② 的"当前任务/目标树任务集"判据）。 */
export interface FocusContext {
  readonly taskId?: string | undefined;
  readonly goalId?: string | undefined;
  /** 当前目标树的任务集（缺省空集——判据退化为"只认当前任务"）。 */
  readonly goalTaskIds: readonly string[];
}

export interface GateOutcome {
  readonly passed: boolean;
  readonly reason?: string;
}

/**
 * provenance gate（J5 硬闸，先于计分）。
 *
 * 四条，逐条独立可解释：
 *  ① `quarantine=true` 任何参数下不浮现；
 *  ② `tool-output`/`external-content` 同理（T0.3 已强制 quarantine，这里双保险——
 *     防"上游将来放宽 quarantine 却忘了 recall 侧"的结构性回归）；
 *  ③ `model-produced` 需 **confidence≥θ ∧ relatedTaskId ∈ {当前任务} ∪ 目标树任务集** 双条件；
 *  ④ 其余（user-original / execution-verified）放行。
 *
 * 为什么是硬闸不是降权：Sleeper 实证——中毒记忆被召回后 60–89% 操纵行为，
 * 而 proximity dependence 让"目标邻近查询"高率召回中毒记忆；只降权不够，
 * 必须在结构上拦掉（§5.3 硬条款）。
 */
export function evaluateGate(input: GateInput, focus: FocusContext, params: RecallParams): GateOutcome {
  if (input.quarantine) {
    return { passed: false, reason: 'quarantine' };
  }
  if (GATE_BLOCKED_CREDENTIALS.includes(input.credential)) {
    return { passed: false, reason: `credential:${input.credential}` };
  }
  if (input.credential === 'model-produced') {
    const confidence = input.confidence ?? 0;
    if (confidence < params.modelProducedMinConfidence) {
      return { passed: false, reason: `model-produced:confidence<${params.modelProducedMinConfidence}` };
    }
    const related = input.relatedTaskId;
    const inFocus = related !== undefined && (related === focus.taskId || focus.goalTaskIds.includes(related));
    if (!inFocus) {
      return { passed: false, reason: 'model-produced:task-mismatch' };
    }
  }
  return { passed: true };
}

/**
 * 任务状态相关分（J2：本插件相对 DSH 纯语义召回的本质差异）。
 *
 * 1.0 = 命中当前焦点任务；0.6 = 命中同目标树的其他任务（可复用，但非本任务直接产物）；
 * 0 = 无任务链接。**任务链接缺失不得与"跨任务"同分**——前者意味着无法判断相关性，
 * 给 0 让语义/时间维度去决定，而非伪造一个中间值。
 */
export function taskRelevance(relatedTaskId: string | undefined, focus: FocusContext): number {
  if (relatedTaskId === undefined) return 0;
  if (focus.taskId !== undefined && relatedTaskId === focus.taskId) return 1;
  if (focus.goalTaskIds.includes(relatedTaskId)) return 0.6;
  return 0;
}

/**
 * 时间衰减分（J3 分类型半衰期）。
 *
 * `0.5 ** (ageDays / halfLifeDays[chunkType])`：严格随 `at − createdAt` 单调不增
 * （不变量 6 的公式级保证）。未来时间戳（时钟回拨/测试构造）按 age=0 处理——
 * 不产生 >1 的 recency（那会让"新"这一维度失衡）。
 */
export function recencyScore(
  createdAt: number,
  at: number,
  chunkType: RecallChunkType,
  params: RecallParams,
): number {
  const ageDays = Math.max(0, at - createdAt) / 86_400_000;
  if (ageDays === 0) return 1;
  return Math.pow(0.5, ageDays / params.halfLifeDays[chunkType]);
}

/**
 * 语义分归一（U2 降级路径）。
 *
 * `raw` 来自 T0.3 `search()` 的混合分（BM25 或余弦，尺度随语料变化）。归一以
 * **候选池最大值**为分母：这样"这一池里最相关的那条"恒为 1，三元加权的
 * 尺度跨会话可比；池内无正分时全 0（无语义证据，交给 task/recency 决定）。
 */
export function normalizeSemantic(raw: number, poolMax: number): number {
  if (!(poolMax > 0)) return 0;
  const ratio = raw / poolMax;
  if (!(ratio > 0)) return 0;
  return ratio > 1 ? 1 : ratio;
}

export interface ScoreParts {
  readonly taskRel: number;
  readonly recency: number;
  readonly semantic: number;
  /** v2 动量分（v1 恒 0，J2 退化等价）。 */
  readonly momentum?: number | undefined;
  /** v2 情感分（v1 恒 0；model-produced 资格过滤恒 0，J5）。 */
  readonly emotion?: number | undefined;
}

/**
 * 五元计分（T2.4 J2）。
 *
 * seam 契约：`scorerVersion='v1'` 时**严格等于** T1.1 三元公式（momentum/emotion
 * 权重恒 0，由 schema superRefine 强制）——v1 是 v2 的特例，降级路径由此保证。
 */
export function composeScore(parts: ScoreParts, params: RecallParams): number {
  const raw =
    params.weights.task * parts.taskRel +
    params.weights.recency * parts.recency +
    params.weights.semantic * parts.semantic +
    params.weights.momentum * (parts.momentum ?? 0) +
    params.weights.emotion * (parts.emotion ?? 0);
  return Math.max(0, Math.min(1, raw));
}

/**
 * 动量双尺度（J3）：`saturate(w_fast·m_fast + w_slow·m_slow) × (α+(1−α)·attentionProximity)`。
 *
 * m_fast/m_slow 从 recall_log 事件指数衰减重算（注入 1.0 / 使用 2.0，J3）；
 * saturate = 除以滚动上限后 tanh 压缩（防"越召回越强"富者愈富）；
 * 纯函数、无隐藏状态（不变量 3 可复算）。
 */
export function momentumScore(
  events: readonly { readonly at: number; readonly weight: number }[],
  at: number,
  params: RecallParams,
  attentionProximity: number,
): { readonly momentum: number; readonly mFast: number; readonly mSlow: number } {
  const tauFastMs = params.momentum.fastTauHours * 3600_000;
  const tauSlowMs = params.momentum.slowTauDays * 86_400_000;
  let fast = 0;
  let slow = 0;
  for (const event of events) {
    const delta = Math.max(0, at - event.at);
    fast += event.weight * Math.exp(-delta / tauFastMs);
    slow += event.weight * Math.exp(-delta / tauSlowMs);
  }
  const saturated = Math.tanh(
    (params.momentum.wFast * fast + params.momentum.wSlow * slow) / params.momentum.saturateCeiling,
  );
  const proximity = Math.max(0, Math.min(1, attentionProximity));
  const momentum = saturated * (params.momentum.alpha + (1 - params.momentum.alpha) * proximity);
  return { momentum, mFast: fast, mSlow: slow };
}

/**
 * 情感分（J5 计量口径）：写入方声明值直接计量，**资格过滤**——`model-produced`
 * 的 emotionWeight 落库留痕但计分恒 0（自产显著性 = 自产显著性攻击面）。
 */
export function emotionScore(credential: RecallCredential, emotionWeight: number | undefined): number {
  if (credential === 'model-produced') return 0;
  if (emotionWeight === undefined) return 0;
  return Math.max(0, Math.min(1, emotionWeight));
}

/**
 * 焦点 query 文本构造（J2）。
 *
 * 拼接顺序固定（objective → criteria → subject → description），保证同焦点
 * 构造出**逐字节相同**的 query（回放确定性的前提之一）。空段不占位（避免
 * 平白拉长查询串）。
 */
export function buildFocusQuery(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join('\n');
}

/**
 * 注入的渲染文本（J6 的"可解释注入"）。
 *
 * 每行形如 `[<chunkType>/<credential>] <content>`：凭证随注入文本同行，模型
 * 因此能自己判断该条证据的可信度（§5.3"信任分层"在注入面的落地）。
 */
export function renderInjectionText(input: {
  readonly chunkType: RecallChunkType;
  readonly credential: RecallCredential;
  readonly content: string;
}): string {
  return `[${input.chunkType}/${input.credential}] ${input.content}`;
}
