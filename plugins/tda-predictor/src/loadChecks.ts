/**
 * tda-predictor 插件级不变量：以插件自己的 npm 包名注册（`tda-predictor`）。
 *
 * T1.3 §4.1 八条不变量 → 检查/运行时/结构分层映射：
 *  1. 抽取确定性        → **结构性**（`extractTransitions` 纯函数 + 水位增量）
 *                         + 冒烟门"重抽逐字段一致"；
 *  2. 零原文泄漏        → schema 层字段白名单 + 加载期 `predict-no-leak`（存储侧复核）；
 *  3. 低置信不注入      → 加载期 `predict-low-confidence-not-injected`；
 *  4. mismatch 全记录   → 加载期 `predict-mismatch-density`（已闭合轮次必有 mismatch）；
 *  5. 预测可复算        → 加载期 `predict-from-events`（事件载荷即全快照，逐字段复核）；
 *  6. 推断标注          → **结构性**（`renderPrediction` 是唯一注入文本出口，含 CAVEAT 常量）
 *                         + 冒烟门自检；
 *  7. fail-open          → 服务期（extract/predict 的 try/catch 降级 + `onDegrade` 上报）；
 *  8. 吞吐帽            → 加载期 `predict-batch-cap` + 服务期判定。
 */
import {
  canonicalJson,
  tdaEvents,
  tdaPluginInstaller,
  type HostRecord,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  EXTRACT_STATE_KEY,
  PREDICT_PARAMS_KEY,
  PredictParamsSchema,
  type MismatchRecord,
  type Prediction,
  type PredictorTables,
  type Transition,
} from './domain.ts';

export interface PredictInvariantOptions {
  /**
   * 会话日志（**一条入口同时供两条检查**）：
   *  - `predict/change` 事件 → 预测/比对的可回放来源（不变量 5/7）；
   *  - `turn/end`/`interrupted` → 已闭合轮次（不变量 4 mismatch 密度的判据）。
   * 缺省即两条检查都跳过（纯脱机域自检）。
   */
  readonly log?: readonly HostRecord[] | undefined;
}

export function predictorInvariantChecks(
  domain: TdaDomain<PredictorTables>,
  options: PredictInvariantOptions = {},
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];
  const { log } = options;

  const singleton = (tableName: 'predict_params' | 'extract_state', key: string): TdaInvariantCheck => ({
    name: `predict-${tableName.replace('_', '-')}-singleton`,
    run(fail) {
      const table = domain.table(tableName);
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`${tableName} 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== key) fail(`${tableName} 行键必须是 ${key}，实为 ${String(keys[0])}`);
    },
  });

  checks.push(singleton('predict_params', PREDICT_PARAMS_KEY), singleton('extract_state', EXTRACT_STATE_KEY));

  checks.push({
    name: 'predict-params-valid',
    run(fail) {
      const params = domain.table('predict_params').get(PREDICT_PARAMS_KEY);
      if (params === undefined) {
        fail('predict_params 单行缺失（启动序 initialize 未跑？）');
        return;
      }
      const parsed = PredictParamsSchema.safeParse(params);
      if (!parsed.success) fail(`predict_params 非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`);
    },
  });

  checks.push({
    name: 'predict-low-confidence-not-injected',
    run(fail) {
      // 不变量 3：低置信不得进任何注入路径
      for (const [, prediction] of domain.table('predictions').entries() as IterableIterator<[string, Prediction]>) {
        if (prediction.injected && prediction.confidence < prediction.theta) {
          fail(
            `预测 ${String(prediction.id)} confidence=${prediction.confidence} < 裁决时 θ=${prediction.theta} 却 injected=true（不变量 3）`,
          );
        }
      }
    },
  });

  checks.push({
    name: 'predict-no-leak',
    run(fail) {
      // 不变量 2：存储侧复核字段白名单（分类/摘要字段不得承载正文）
      const inspect = (label: string, value: unknown): void => {
        if (typeof value === 'string' && value.length > 64) {
          fail(`${label} 长 ${value.length} 字符 > 64——分类/摘要字段不得承载正文（零原文泄漏，J3）`);
        }
      };
      for (const [, transition] of domain.table('transitions').entries() as IterableIterator<[string, Transition]>) {
        const prefix = `transition ${String(transition.id)}`;
        inspect(`${prefix}.action.tool`, transition.action.tool);
        inspect(`${prefix}.action.argClass`, transition.action.argClass);
        inspect(`${prefix}.action.role`, transition.action.role);
        inspect(`${prefix}.action.fromStage`, transition.action.fromStage);
        inspect(`${prefix}.action.toStage`, transition.action.toStage);
        inspect(`${prefix}.action.closeReason`, transition.action.closeReason);
        inspect(`${prefix}.outcome.errorClass`, transition.outcome.errorClass);
        inspect(`${prefix}.outcome.resultClass`, transition.outcome.resultClass);
        inspect(`${prefix}.stateBefore`, transition.stateBefore);
        inspect(`${prefix}.stateAfter`, transition.stateAfter);
      }
      for (const [, prediction] of domain.table('predictions').entries() as IterableIterator<[string, Prediction]>) {
        inspect(`prediction ${String(prediction.id)}.nextAction`, prediction.nextAction);
        inspect(`prediction ${String(prediction.id)}.context.stage`, prediction.context.stage);
        for (const token of prediction.context.recentActions) {
          inspect(`prediction ${String(prediction.id)}.context.recentActions[]`, token);
        }
        for (const flag of prediction.riskFlags) inspect(`prediction ${String(prediction.id)}.riskFlags[].errorClass`, flag.errorClass);
      }
      for (const [, mismatch] of domain.table('mismatches').entries() as IterableIterator<[string, MismatchRecord]>) {
        inspect(`mismatch ${String(mismatch.id)}.actual.action`, mismatch.actual.action);
        inspect(`mismatch ${String(mismatch.id)}.actual.errorClass`, mismatch.actual.errorClass);
      }
    },
  });

  checks.push({
    name: 'predict-mismatch-ref-integrity',
    run(fail) {
      const predictions = domain.table('predictions');
      for (const [, mismatch] of domain.table('mismatches').entries() as IterableIterator<[string, MismatchRecord]>) {
        if (predictions.get(mismatch.predictionId) === undefined) {
          fail(`比对 ${String(mismatch.id)} 指向的预测 ${mismatch.predictionId} 不存在（引用完整性）`);
        }
      }
    },
  });

  checks.push({
    name: 'predict-batch-cap',
    run(fail) {
      const state = domain.table('extract_state').get(EXTRACT_STATE_KEY);
      if (state === undefined) {
        fail('extract_state 单行缺失（启动序 initialize 未跑？）');
        return;
      }
      if (!(state.batchCap >= 1)) fail(`extract_state.batchCap=${state.batchCap} 须 ≥1（吞吐帽不得为 0）`);
      if (state.lastSeq < 0) fail(`extract_state.lastSeq=${state.lastSeq} 不得为负`);
    },
  });

  if (log !== undefined) {
    checks.push({
      name: 'predict-from-events',
      run(fail) {
        // 不变量 5/7：predictions/mismatches 由 `predict/change` 事件（全快照）可重建
        const expected = new Map<string, string>();
        for (const event of tdaEvents(log)) {
          if (event.family !== 'predict/change') continue;
          if (event.businessId === 'params') continue;
          expected.set(event.businessId, canonicalJson(event.payload));
        }
        const actual = new Map<string, string>();
        for (const tableName of ['predictions', 'mismatches'] as const) {
          for (const [key, value] of domain.table(tableName).entries()) actual.set(key, canonicalJson(value));
        }
        for (const [key, value] of actual) {
          const want = expected.get(key);
          if (want === undefined) {
            fail(`${key} 在 predict/change 日志中没有对应事件（预测器权威副本缺失）`);
            continue;
          }
          if (want !== value) fail(`${key} 与事件载荷不一致（库 ${value} ≠ 事件 ${want}）`);
        }
        for (const key of expected.keys()) {
          if (!actual.has(key)) fail(`${key} 有事件却无记录（投影未落地）`);
        }
      },
    });
  }

  if (log !== undefined) {
    checks.push({
      name: 'predict-mismatch-density',
      run(fail) {
        // 不变量 4：凡生成过预测的**已闭合轮次**必落 observe 结果（含 none）
        const closed = new Set(
          log.filter((record) => record.kind === 'turn/end' || record.kind === 'interrupted').map((record) => record.turn),
        );
        const observed = new Set<string>();
        for (const [, mismatch] of domain.table('mismatches').entries() as IterableIterator<[string, MismatchRecord]>) {
          observed.add(String(mismatch.predictionId));
        }
        for (const [, prediction] of domain.table('predictions').entries() as IterableIterator<[string, Prediction]>) {
          if (!closed.has(prediction.round)) continue;
          if (!observed.has(String(prediction.id))) {
            fail(`预测 ${String(prediction.id)}（轮次 ${prediction.round} 已闭合）没有对应 mismatch——coach 信号密度塌陷`);
          }
        }
      },
    });
  }

  return checks;
}

export function registerPredictorInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<PredictorTables>,
  options: PredictInvariantOptions = {},
): () => void {
  return registry.register('tda-predictor', tdaPluginInstaller(predictorInvariantChecks(domain, options)));
}
