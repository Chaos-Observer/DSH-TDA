/**
 * tda-recall 事件载荷（T1.1 §5 审计面）。
 *
 * 族 `recall/change` 只承载**参数变更**（唯一权威写路径；recall_log 走派生写、
 * 不产事件）。载荷是**全快照**（内核纪律：快照而非增量——反向累计会把全量当
 * 增量重复计数），逐字段显式构造以保键序稳定（KV-cache / replay 比对友好）。
 */
import type { JsonObject } from '@tda/kernel';
import type { RecallParams } from './domain.ts';

/** 参数单行的业务 id（audit_index 的 locate 键）。 */
export const RECALL_PARAMS_BUSINESS_ID = 'params';

/**
 * 载荷键序**必须与 `RecallParamsSchema` 的定义序一致**：domain 记录经 zod parse
 * 产出（键序 = schema 序），replay-equivalence 以 `JSON.stringify` 整体比对，
 * 任一字段错位即判"分歧"。改动此处顺序前先看 dualwrite 门的重放用例。
 */
export function recallParamsPayload(params: RecallParams): JsonObject {
  return {
    scorerVersion: params.scorerVersion,
    weights: {
      task: params.weights.task,
      recency: params.weights.recency,
      semantic: params.weights.semantic,
      momentum: params.weights.momentum,
      emotion: params.weights.emotion,
    },
    halfLifeDays: {
      fact: params.halfLifeDays.fact,
      reflection: params.halfLifeDays.reflection,
      method: params.halfLifeDays.method,
      skill: params.halfLifeDays.skill,
    },
    modelProducedMinConfidence: params.modelProducedMinConfidence,
    minScore: params.minScore,
    injectionMaxTokens: params.injectionMaxTokens,
    momentum: {
      ...params.momentum,
      eventWeights: { ...params.momentum.eventWeights },
    },
    attention: { ...params.attention },
    strategic: { ...params.strategic },
    emotionWeightCap: params.emotionWeightCap,
    revision: params.revision,
  };
}
