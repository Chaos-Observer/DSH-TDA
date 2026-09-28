/**
 * tda-predictor 域定义（T1.3 §3.3 存储落点）。
 *
 * 五表，**全部派生**（`invalidRecords='backup-and-skip'`）——预测器是**认知资产**
 * 不是权威（J7）：任何一表丢了都只是"重扫 log 重建"（extract 幂等 + predict 确定），
 * 不阻断任何主链路；因此它也是唯一一个"丢数据不算事故"的插件。
 *
 * 零原文泄漏（J3）在 schema 层的落法：`Transition` 的所有字段都是**分类/摘要/引用**
 * ——`tool` 是公开名、`argClass` 是参数模式类别、`errorClass` 是失败类别、
 * `source{seqFrom,seqTo}` 指向会话日志（原文在 log 可查，不在这里复制）。
 * 没有任何字段承载参数值或返回正文。
 *
 * 与 T0.4 的接合（J8）：`predict_params.thetaPredict` 是"低置信不注入"的阈值，
 * `riskFlags`/`confidence` 同时作为 `gate.mode='static'` 的替代不确定性源输入。
 */
import { asMismatchId, asPredictionId, asTransitionId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

/** 四类 transition（J1）。`context/assemble` **刻意不在内**——每轮必有、无决策性。 */
export const TRANSITION_KINDS = ['tool-call', 'dispatch', 'task-transition', 'turn-close'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export const TASK_STAGES = ['planning', 'executing', 'waiting', 'verifying'] as const;
export type TransitionStage = (typeof TASK_STAGES)[number];

export const OUTCOME_STATUSES = ['success', 'failure', 'partial'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export const DELTA_KINDS = ['action', 'outcome', 'risk-materialized', 'none'] as const;
export type DeltaKind = (typeof DELTA_KINDS)[number];

/** 参数模式分类（与宿主 `TOOL_ARG_CLASSES` 同集合，零 import）。 */
export const ARG_CLASSES = ['read', 'write', 'query', 'dispatch', 'other'] as const;
export type ArgClass = (typeof ARG_CLASSES)[number];

export const TransitionActionSchema = z.object({
  tool: z.string().optional(),
  argClass: z.enum(ARG_CLASSES).optional(),
  role: z.enum(['lead', 'sidekick']).optional(),
  fromStage: z.string().optional(),
  toStage: z.string().optional(),
  closeReason: z.string().optional(),
});

export const TransitionOutcomeSchema = z.object({
  status: z.enum(OUTCOME_STATUSES),
  errorClass: z.string().optional(),
  resultClass: z.string().optional(),
});

export const TransitionSchema = z
  .object({
    id: z.string().transform(asTransitionId),
    kind: z.enum(TRANSITION_KINDS),
    goalId: z.string().optional(),
    taskId: z.string().optional(),
    taskStage: z.enum(TASK_STAGES),
    action: TransitionActionSchema,
    outcome: TransitionOutcomeSchema,
    stateBefore: z.string().optional(),
    stateAfter: z.string().optional(),
    /** 会话日志引用（原文在那里，这里只引）。 */
    source: z.object({ sessionId: z.string(), seqFrom: z.number(), seqTo: z.number() }),
    at: z.number(),
  })
  .superRefine((transition, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (transition.source.seqTo < transition.source.seqFrom) {
      issue(`source.seqTo=${transition.source.seqTo} < seqFrom=${transition.source.seqFrom}（区间倒挂）`);
    }
    // 四类的动作/结果完备律：kind 决定哪些字段必须/禁止在场
    const action = transition.action;
    if (transition.kind === 'tool-call') {
      if (action.tool === undefined || action.tool === '') issue('kind=tool-call 必带 tool（公开名）');
      if (action.argClass === undefined) issue('kind=tool-call 必带 argClass（参数模式分类，J3）');
      if (action.role !== undefined) issue('kind=tool-call 不得带 role（那是 dispatch 的字段）');
    } else if (transition.kind === 'dispatch') {
      if (action.role === undefined) issue('kind=dispatch 必带 role');
      if (action.tool !== undefined) issue('kind=dispatch 不得带 tool');
    } else if (transition.kind === 'task-transition') {
      if (action.fromStage === undefined || action.toStage === undefined) {
        issue('kind=task-transition 必带 fromStage/toStage');
      }
      if (transition.taskId === undefined) issue('kind=task-transition 必带 taskId（迁移的主体）');
    } else if (action.closeReason === undefined) {
      issue('kind=turn-close 必带 closeReason');
    }
    // 零原文泄漏的自检：字段白名单外的内容型字段不存在（schema 已封闭，
    // 这里再加一条"值形态"启发式——超长字符串只可能是正文泄漏）
    const longFields: readonly (readonly [string, string | undefined])[] = [
      ['tool', action.tool],
      ['argClass', action.argClass],
      ['role', action.role],
      ['fromStage', action.fromStage],
      ['toStage', action.toStage],
      ['closeReason', action.closeReason],
      ['errorClass', transition.outcome.errorClass],
      ['resultClass', transition.outcome.resultClass],
      ['stateBefore', transition.stateBefore],
      ['stateAfter', transition.stateAfter],
    ];
    for (const [name, value] of longFields) {
      if (value !== undefined && value.length > 64) {
        issue(`字段 ${name} 长 ${value.length} 字符 > 64——分类/摘要字段不得承载正文（J3 零原文泄漏）`);
      }
    }
  });
export type Transition = z.infer<typeof TransitionSchema>;

export const PredictionSchema = z
  .object({
    id: z.string().transform(asPredictionId),
    sessionId: z.string(),
    round: z.number(),
    /** 脱敏上下文（无原文）。 */
    context: z.object({
      taskId: z.string().optional(),
      stage: z.string(),
      recentActions: z.array(z.string()),
    }),
    nextAction: z.string(),
    outcomeDist: z.object({ success: z.number(), failure: z.number(), partial: z.number() }),
    riskFlags: z.array(z.object({ errorClass: z.string(), freq: z.number() })),
    confidence: z.number(),
    /** **裁决时的 θ_pred**（必要超集）：injected 的可回放依据——θ 之后被调高
     *  不得回溯撤销当时的注入决定，否则"闸门按参数判定"失去可回放性。 */
    theta: z.number(),
    /** ≥θ_pred 且进了 injection 区（T0.4 预算裁决后）。 */
    injected: z.boolean(),
    /** top-K 依据（可解释 + 可复算，不变量 5）。 */
    similarTransitionIds: z.array(z.string()),
    at: z.number(),
  })
  .superRefine((prediction, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (prediction.confidence < 0 || prediction.confidence > 1) {
      issue(`confidence 须落在 [0,1]（收到 ${prediction.confidence}）`);
    }
    const dist = prediction.outcomeDist;
    const sum = dist.success + dist.failure + dist.partial;
    if (Math.abs(sum - 1) > 1e-6) issue(`outcomeDist 须归一（和 ${sum}）`);
    for (const flag of prediction.riskFlags) {
      if (flag.freq < 0 || flag.freq > 1) issue(`riskFlags.freq 须落在 [0,1]（收到 ${flag.freq}）`);
    }
    if (prediction.injected && prediction.confidence < prediction.theta) {
      // 不变量 3：以**裁决时的 θ** 判定——低置信不得进任何注入路径
      issue(`confidence=${prediction.confidence} < 裁决时 θ=${prediction.theta} 却 injected=true（不变量 3）`);
    }
  });
export type Prediction = z.infer<typeof PredictionSchema>;

export const MismatchSchema = z.object({
  id: z.string().transform(asMismatchId),
  predictionId: z.string(),
  actual: z.object({
    action: z.string(),
    outcomeStatus: z.enum(OUTCOME_STATUSES),
    errorClass: z.string().optional(),
  }),
  deltaKind: z.enum(DELTA_KINDS),
  at: z.number(),
});
export type MismatchRecord = z.infer<typeof MismatchSchema>;

export const PredictParamsSchema = z
  .object({
    /** θ_pred：低于此置信不注入（不变量 3）。 */
    thetaPredict: z.number(),
    topK: z.number(),
    simWeights: z.object({ taskCls: z.number(), actionSeq: z.number(), state: z.number() }),
    /** mismatch 采集开关（关掉会让 coach 信号塌陷，仅诊断用）。 */
    mismatchEnabled: z.boolean(),
    revision: z.number(),
  })
  .superRefine((params, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (params.thetaPredict < 0 || params.thetaPredict > 1) issue(`thetaPredict 须落在 [0,1]`);
    if (params.topK < 1) issue(`topK 须 ≥1（收到 ${params.topK}）`);
    const sum = params.simWeights.taskCls + params.simWeights.actionSeq + params.simWeights.state;
    if (Math.abs(sum - 1) > 1e-9) issue(`相似度权重和须为 1（收到 ${sum}）`);
  });
export type PredictParams = z.infer<typeof PredictParamsSchema>;

/** P0 默认（U1：待真实轨迹压测标定）。 */
export const DEFAULT_PREDICT_PARAMS: PredictParams = {
  thetaPredict: 0.55,
  topK: 5,
  simWeights: { taskCls: 0.5, actionSeq: 0.3, state: 0.2 },
  mismatchEnabled: true,
  revision: 0,
};

export const ExtractStateSchema = z.object({
  lastSeq: z.number(),
  lastAt: z.number(),
  /** 单批 transition 数上限（J10 吞吐帽）。 */
  batchCap: z.number(),
});
export type ExtractState = z.infer<typeof ExtractStateSchema>;

export const PREDICT_PARAMS_KEY = 'singleton' as const;
export const EXTRACT_STATE_KEY = 'singleton' as const;
export const PREDICT_PARAMS_BUSINESS_ID = 'params';

export type PredictorTables = {
  transitions: typeof TransitionSchema;
  predictions: typeof PredictionSchema;
  mismatches: typeof MismatchSchema;
  predict_params: typeof PredictParamsSchema;
  extract_state: typeof ExtractStateSchema;
};

export const predictorDomainSpec = defineTdaDomain({
  name: 'tda-predictor',
  version: 1,
  tables: {
    transitions: TransitionSchema,
    predictions: PredictionSchema,
    mismatches: MismatchSchema,
    predict_params: PredictParamsSchema,
    extract_state: ExtractStateSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});

export const TRANSITION_PREFIX = 'tr';
export const PREDICTION_PREFIX = 'pred';
export const MISMATCH_PREFIX = 'mm';
