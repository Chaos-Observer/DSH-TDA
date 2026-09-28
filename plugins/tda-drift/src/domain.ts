/**
 * tda-drift 域定义（T1.5 §3.3 存储落点）。
 *
 * 两表，**全部派生**（`invalidRecords='backup-and-skip'`）：
 *  - `drift_scores`：周期评估快照（append-only 趋势序列，J7）——evaluate 是
 *    **纯函数**（J8：同 domain 快照 + 同窗口 + 同 params ⇒ 同快照），丢了重算即得；
 *  - `drift_params`：参数权威（同 recall/predictor 口径，可回默认）。
 *
 * **`calibrations` 不在本域**（§3.3 明文）：校准记录是**外部验证阀的兜底证据**
 * （J5①），权威在 T0.1 goal-state domain——drift 经 `recordCalibration` seam 写入
 * （U7 回写 T0.1 §4.2），本插件对目标数据**零写权**（J1：检测器是旁路观察者）。
 *
 * 快照本身不产事件（可重算的派生数据不产日志，同 T0.7 audit_index / T1.3 transitions）；
 * 校准动作产 `drift/calibrate` 事件（由 goal-state 的 seam 在写 calibrations 时发出）。
 */
import { asDriftSnapshotId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

/** 四指标（J2：全部落在 T0.1 四表 + transitions 的可机读口径）。 */
export const DRIFT_METRICS = [
  'persistence',
  'consistency',
  'constraintRetention',
  'actionVolatility',
] as const;
export type DriftMetric = (typeof DRIFT_METRICS)[number];

export const DRIFT_LEVELS = ['normal', 'watch', 'drift'] as const;
export type DriftLevel = (typeof DRIFT_LEVELS)[number];

/** 四动作（J3：与四指标一一对应；J4 全部是"提醒/重述/重锚"性质）。 */
export const CALIBRATION_ACTIONS = ['restate', 'echo', 'reanchor', 'nudge'] as const;
export type CalibrationAction = (typeof CALIBRATION_ACTIONS)[number];

/** 风险分级（J5③：medium 需滞回）。 */
export const CALIBRATION_RISKS: Record<CalibrationAction, 'low' | 'medium'> = {
  restate: 'low',
  echo: 'low',
  reanchor: 'medium',
  nudge: 'medium',
};

/** 指标 → 动作路由（J3）。 */
export const METRIC_ACTION: Record<DriftMetric, CalibrationAction> = {
  persistence: 'restate',
  consistency: 'echo',
  constraintRetention: 'reanchor',
  actionVolatility: 'nudge',
};

export const DriftScoresSchema = z.object({
  persistence: z.number(),
  consistency: z.number(),
  constraintRetention: z.number(),
  actionVolatility: z.number(),
});

export const DriftSnapshotSchema = z
  .object({
    id: z.string().transform(asDriftSnapshotId),
    goalId: z.string(),
    scores: DriftScoresSchema,
    composite: z.number(),
    level: z.enum(DRIFT_LEVELS),
    /** 评估窗口（闭开区间）。 */
    window: z.object({ from: z.number(), to: z.number() }),
    trigger: z.enum(['cycle', 'objective-edit']),
    at: z.number(),
  });

export type DriftScores = z.infer<typeof DriftScoresSchema>;

export type DriftSnapshot = z.infer<typeof DriftSnapshotSchema>;

export const DriftParamsSchema = z
  .object({
    weights: z.object({
      persistence: z.number(),
      consistency: z.number(),
      constraintRetention: z.number(),
      actionVolatility: z.number(),
    }),
    /** 指标窗口（P0 默认 7d）。 */
    windowMs: z.number(),
    /** 波动性基线窗口数（P0 默认 4）。 */
    baselineWindows: z.number(),
    thresholds: z.object({ watch: z.number(), drift: z.number() }),
    /** 单指标越限即候选（P0 默认 0.6）。 */
    perMetricThreshold: z.number(),
    /** medium 动作的滞回窗数（J5③，P0 默认 2）。 */
    hysteresisWindows: z.number(),
    revision: z.number(),
  })
  .superRefine((params, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    const weightSum = DRIFT_METRICS.reduce((sum, metric) => sum + params.weights[metric], 0);
    if (Math.abs(weightSum - 1) > 1e-9) issue(`四指标权重和须为 1（收到 ${weightSum}）`);
    if (params.windowMs <= 0) issue(`windowMs 须 > 0（收到 ${params.windowMs}）`);
    if (params.baselineWindows < 1) issue(`baselineWindows 须 ≥1（收到 ${params.baselineWindows}）`);
    if (!(params.thresholds.watch > params.thresholds.drift)) {
      issue(`thresholds.watch(${params.thresholds.watch}) 须 > thresholds.drift(${params.thresholds.drift})`);
    }
    for (const level of ['watch', 'drift'] as const) {
      const value = params.thresholds[level];
      if (value < 0 || value > 1) issue(`thresholds.${level} 须落在 [0,1]（收到 ${value}）`);
    }
    if (params.perMetricThreshold < 0 || params.perMetricThreshold > 1) {
      issue(`perMetricThreshold 须落在 [0,1]（收到 ${params.perMetricThreshold}）`);
    }
    if (params.hysteresisWindows < 1) issue(`hysteresisWindows 须 ≥1（收到 ${params.hysteresisWindows}）`);
  });
export type DriftParams = z.infer<typeof DriftParamsSchema>;

/** P0 默认（U4：实测标定）。 */
export const DEFAULT_DRIFT_PARAMS: DriftParams = {
  weights: { persistence: 0.25, consistency: 0.25, constraintRetention: 0.25, actionVolatility: 0.25 },
  windowMs: 7 * 86_400_000,
  baselineWindows: 4,
  thresholds: { watch: 0.7, drift: 0.5 },
  perMetricThreshold: 0.6,
  hysteresisWindows: 2,
  revision: 0,
};

export const DRIFT_PARAMS_KEY = 'singleton' as const;
export const DRIFT_PARAMS_BUSINESS_ID = 'params';

export type DriftTables = {
  drift_scores: typeof DriftSnapshotSchema;
  drift_params: typeof DriftParamsSchema;
};

export const driftDomainSpec = defineTdaDomain({
  name: 'tda-drift',
  version: 1,
  tables: {
    drift_scores: DriftSnapshotSchema,
    drift_params: DriftParamsSchema,
  },
  layout: 'single',
  invalidRecords: 'backup-and-skip',
});

export const SNAPSHOT_PREFIX = 'ds';
