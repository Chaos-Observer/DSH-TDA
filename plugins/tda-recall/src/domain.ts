/**
 * tda-recall 域定义（T1.1 §3.4 存储落点）。
 *
 * 两张表，两种"域记录 × 事件"组合（内核纪律 #12）：
 *  - `recall_params`（键 `'singleton'`，layout single）：**参数权威**——权重/
 *    半衰期/θ/minScore；变更走 `dualWrite(family='recall/change')`（有域写 + 有事件）。
 *  - `recall_log`（键 `rl-<n>`，append-only）：**旁路复用日志**——无事件，
 *    走 `dualWriteDerived`（仅域写）。它可被 recall 自身重跑重建（同 log 前缀
 *    + 同 params ⇒ 同日志），故权威在"可重放的过程"，域里只是历史台账。
 *    若给它配事件，就是"召回本身引发新审计事件"，属自指放大（同 T0.7 audit_index）。
 *
 * 为什么复用信号不进 T0.3 时间线（J7）：条目不可变（T0.3 J2），把"被用过几次"
 * 写在条目上=update，append-only 铁律溃堤；旁路 append-only 日志是唯一干净解。
 *
 * invalidRecords='backup-and-skip'：参数可回默认（initialize 会补种子）、
 * 日志丢了只损治理信号不阻断权威——映射表 T1.1 行原文。
 *
 * `injectionMaxTokens` 是相对 §3.2 `RecallParams` 的一处**必要超集**：J6 要求
 * "注入集 token 估计 ≤ T0.4 injection 区份额；超限按分截断"，而份额归 T0.4 四区
 * 预算管、recall 无从预知——故 recall 侧持一个自帽（T0.4 再叠加裁决），
 * 截断结果逐条记入 recall_log 的 `injected` 与 T0.4 的 AssembleRecord。
 */
import { defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

/** 半衰期分档的四类（J3：事实过时快、方法与技能长效）。 */
export const RECALL_CHUNK_TYPES = ['fact', 'reflection', 'method', 'skill'] as const;
export type RecallChunkType = (typeof RECALL_CHUNK_TYPES)[number];

/** T0.3 凭证五级在 recall 侧的只读镜像（结构等价，零 import）。 */
export const RECALL_CREDENTIALS = [
  'user-original',
  'execution-verified',
  'model-produced',
  'tool-output',
  'external-content',
] as const;
export type RecallCredential = (typeof RECALL_CREDENTIALS)[number];

/** J5 硬闸：任何参数下都不浮现的凭证（T0.3 已服务端强制 quarantine，这里双保险）。 */
export const GATE_BLOCKED_CREDENTIALS: readonly RecallCredential[] = ['tool-output', 'external-content'];

export const RecallWeightsSchema = z.object({
  task: z.number(),
  recency: z.number(),
  semantic: z.number(),
  /** v2 动量权重（v1 恒 0，J2 退化等价）。 */
  momentum: z.number(),
  /** v2 情感权重（v1 恒 0；≤ emotionWeightCap 硬帽，J5）。 */
  emotion: z.number(),
});

/** 动量双尺度参数（J3，RiverMemo V10 双尺度基准的工程化子集）。 */
export const MomentumParamsSchema = z.object({
  fastTauHours: z.number(),
  slowTauDays: z.number(),
  wFast: z.number(),
  wSlow: z.number(),
  eventWeights: z.object({ injected: z.number(), used: z.number() }),
  saturateCeiling: z.number(),
  alpha: z.number(),
  scanWindowDays: z.number(),
});

/** 主动召回参数（J6/J7）。 */
export const StrategicParamsSchema = z.object({
  maxItems: z.number(),
  tokenCap: z.number(),
  shareFraction: z.number(),
});

export const RecallHalfLivesSchema = z.object({
  fact: z.number(),
  reflection: z.number(),
  method: z.number(),
  skill: z.number(),
});

export const RecallParamsSchema = z
  .object({
    /** 计分器版本（J2：'v1' = 严格退化等价，降级开关）。 */
    scorerVersion: z.enum(['v1', 'v2']),
    weights: RecallWeightsSchema,
    halfLifeDays: RecallHalfLivesSchema,
    /** θ：model-produced 浮现的置信下限（J5 双条件之一）。 */
    modelProducedMinConfidence: z.number(),
    /** minScore：低于此分不进注入（J6"宁缺毋滥"）。 */
    minScore: z.number(),
    /** 注入 token 自帽（必要超集，见文件头）。 */
    injectionMaxTokens: z.number(),
    momentum: MomentumParamsSchema,
    attention: z.object({ recentRounds: z.number() }),
    strategic: StrategicParamsSchema,
    /** w_emotion 硬帽（服务端断言，J5）。 */
    emotionWeightCap: z.number(),
    /** 变更审计（T1.2 消费）。 */
    revision: z.number(),
  })
  .superRefine((params, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    const sum =
      params.weights.task +
      params.weights.recency +
      params.weights.semantic +
      params.weights.momentum +
      params.weights.emotion;
    if (Math.abs(sum - 1) > 1e-9) {
      issue(`权重和须为 1（收到 ${sum}）——否则分数尺度随权重一起漂，跨轮不可比`);
    }
    if (params.scorerVersion === 'v1' && (params.weights.momentum !== 0 || params.weights.emotion !== 0)) {
      issue(`scorerVersion='v1' 时 momentum/emotion 权重必须为 0（J2 退化等价契约）`);
    }
    if (params.weights.emotion > params.emotionWeightCap) {
      issue(`w_emotion=${params.weights.emotion} 超 emotionWeightCap=${params.emotionWeightCap}（情感是调味非主菜，J5）`);
    }
    const wFastWSlow = params.momentum.wFast + params.momentum.wSlow;
    if (Math.abs(wFastWSlow - 1) > 1e-9) {
      issue(`momentum.wFast+wSlow 须为 1（收到 ${wFastWSlow}）`);
    }
    for (const [name, value] of Object.entries(params.halfLifeDays)) {
      if (!(value > 0)) issue(`半衰期 ${name} 须 > 0（收到 ${value}）——0 会让 recency 立即归零`);
    }
    if (params.modelProducedMinConfidence < 0 || params.modelProducedMinConfidence > 1) {
      issue(`modelProducedMinConfidence 须落在 [0,1]（收到 ${params.modelProducedMinConfidence}）`);
    }
    if (params.minScore < 0 || params.minScore > 1) {
      issue(`minScore 须落在 [0,1]（收到 ${params.minScore}）`);
    }
    if (params.injectionMaxTokens < 1) {
      issue(`injectionMaxTokens 须 ≥1（收到 ${params.injectionMaxTokens}）`);
    }
  });
export type RecallParams = z.infer<typeof RecallParamsSchema>;

/** P0 默认参数（§3.2 原文：0.5/0.2/0.3；14/30/90/180；θ=0.6；minScore=0.25）。 */
export const DEFAULT_RECALL_PARAMS: RecallParams = {
  scorerVersion: 'v1',
  // 默认 v1（严格 T1.1 语义）；v2 由治理显式开启并切换五元权重
  weights: { task: 0.5, recency: 0.2, semantic: 0.3, momentum: 0, emotion: 0 },
  halfLifeDays: { fact: 14, reflection: 30, method: 90, skill: 180 },
  modelProducedMinConfidence: 0.6,
  minScore: 0.25,
  injectionMaxTokens: 2000,
  momentum: {
    fastTauHours: 2,
    slowTauDays: 7,
    wFast: 0.6,
    wSlow: 0.4,
    eventWeights: { injected: 1.0, used: 2.0 },
    saturateCeiling: 5,
    alpha: 0.3,
    scanWindowDays: 30,
  },
  attention: { recentRounds: 8 },
  strategic: { maxItems: 5, tokenCap: 300, shareFraction: 0.34 },
  emotionWeightCap: 0.2,
  revision: 0,
};

/** 参数单行的键（layout single 下的表内键）。 */
export const RECALL_PARAMS_KEY = 'singleton' as const;

/**
 * 复用日志的三种来源（必要超集：`kind` 区分三条被动路径，供 T1.2 分口径统计）。
 *  - `recall`：显式查询路（Harness/模型查询）；
 *  - `inject`：T0.4 assemble 的 injection 区拉取（被动语义，J4）；
 *  - `confirm`：T0.4 预算裁决后的注入确认（`logUse`）。
 */
export const RECALL_LOG_KINDS = ['recall', 'inject', 'confirm'] as const;
export type RecallLogKind = (typeof RECALL_LOG_KINDS)[number];

/**
 * `recall_log` 行（append-only）。
 *
 * `gatePassed` / `reason` / `paramsRevision` 是相对 §3.3 表结构的**必要超集**：
 *  - `gatePassed`：不变量 5 明文"含被 gate 拦下的候选，记 gatePassed"；
 *  - `reason`：gate 拒绝原因（可解释——J5 要求闸门可解释而非一刀切）；
 *  - `paramsRevision`：不变量 7"回放用当时 params 快照解释浮现/未浮现"，
 *    日志行必须自证它是在哪一版参数下产出的。
 */
export const RecallLogSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  at: z.number(),
  taskId: z.string().optional(),
  goalId: z.string().optional(),
  score: z.number(),
  gatePassed: z.boolean(),
  injected: z.boolean(),
  kind: z.enum(RECALL_LOG_KINDS),
  paramsRevision: z.number(),
  sessionId: z.string(),
  reason: z.string().optional(),
  /** v2 扩展（J8）：召回触发路；旧行缺省按 'passive-assemble' 解释。 */
  trigger: z.enum(['passive-assemble', 'passive-query', 'active-tool', 'active-stage']).optional(),
  /** v2 扩展：真实复用标记（动量事件权重 2.0 的来源）。 */
  used: z.boolean().optional(),
  /** v2 扩展：情感权重实际参与计分的标注（投毒审计数据面，J8）。 */
  emotionApplied: z.boolean().optional(),
});

export type RecallLogRecord = z.infer<typeof RecallLogSchema>;

export type RecallTables = {
  recall_params: typeof RecallParamsSchema;
  recall_log: typeof RecallLogSchema;
};

export const recallDomainSpec = defineTdaDomain({
  name: 'tda-recall',
  version: 2,
  tables: {
    recall_params: RecallParamsSchema,
    recall_log: RecallLogSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});

/** 引擎侧 id 分配前缀。 */
export const RECALL_LOG_PREFIX = 'rl';
