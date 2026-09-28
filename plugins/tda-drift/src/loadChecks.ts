/**
 * tda-drift 插件级不变量：以插件自己的 npm 包名注册（`tda-drift`）。
 *
 * T1.5 §4.1 八条不变量 → 检查/运行时/结构分层映射：
 *  1. 零目标写权        → **结构性**（seam 类型无 mutation）+ 加载期
 *                         `drift-zero-goal-write`（装配错误立即红）；
 *  2. 校准不动权威      → **结构性**（服务无任何 goalTree/taskPool mutation 调用面）
 *                         + 冒烟门逐字节比对；
 *  3. 指标确定性        → 加载期 `drift-snapshot-deterministic`（重算 == 已存）；
 *  4. 校准必留痕        → 加载期 `drift-calibrations-wellformed`（action ∈ 四动作 ∧ detail 带 snapshot=）；
 *  5. 不强制重置        → **结构性**（全仓搜不到 drift → clear/reset/complete 的路径；
 *                         `drift-zero-goal-write` 同样拦住）；
 *  6. 后验必达          → 服务期 `postVerification`（CI 断言在冒烟门）；
 *  7. 预算纪律          → 服务期（提示文本 ≤150 token 由 renderHint 的固定句式保证）；
 *  8. 滞回生效          → 服务期（hysteresisPassed）+ 冒烟门边界用例。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  CALIBRATION_ACTIONS,
  DRIFT_METRICS,
  DRIFT_PARAMS_KEY,
  DriftParamsSchema,
  type DriftParams,
  type DriftTables,
} from './domain.ts';
import type { DriftGoalSeam, DriftService } from './service.ts';

export interface DriftInvariantOptions {
  readonly goal: DriftGoalSeam;
  readonly service?: DriftService | undefined;
}

export function driftInvariantChecks(
  domain: TdaDomain<DriftTables>,
  options: DriftInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];
  const { goal, service } = options;

  checks.push({
    name: 'drift-params-singleton',
    run(fail) {
      const table = domain.table('drift_params');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`drift_params 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== DRIFT_PARAMS_KEY) fail(`drift_params 行键必须是 ${DRIFT_PARAMS_KEY}，实为 ${String(keys[0])}`);
      const params = table.get(DRIFT_PARAMS_KEY);
      if (params === undefined) {
        fail('drift_params 单行缺失（启动序 initialize 未跑？）');
        return;
      }
      const parsed = DriftParamsSchema.safeParse(params);
      if (!parsed.success) fail(`drift_params 非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`);
    },
  });

  checks.push({
    name: 'drift-zero-goal-write',
    run(fail) {
      // 不变量 1/5：检测器不得持有目标写权（装配层错误在这里现形）
      const present = Object.keys(goal);
      const forbidden = present.filter((name) => FORBIDDEN_METHODS.includes(name));
      if (forbidden.length > 0) {
        fail(`drift 的 goal seam 携带了目标 mutation 方法 [${forbidden.join('、')}]（J1：检测器是旁路观察者）`);
      }
    },
  });

  checks.push({
    name: 'drift-scores-append-only',
    run(fail) {
      const table = domain.table('drift_scores');
      const seen = new Set<string>();
      let previous = 0;
      for (const [key, snapshot] of table.entries()) {
        if (key !== String(snapshot.id)) fail(`快照记录键 ${key} 与 id ${String(snapshot.id)} 不符（键即纪律）`);
        if (seen.has(String(snapshot.id))) fail(`快照 id ${String(snapshot.id)} 重复——allocateId 无洞分配被绕过`);
        seen.add(String(snapshot.id));
        const seq = Number(String(snapshot.id).slice('ds-'.length));
        if (seq < previous) fail(`快照 id ${String(snapshot.id)} 破坏单调序（append-only 趋势面，J7）`);
        previous = seq;
        // 指标值域
        for (const metric of DRIFT_METRICS) {
          const value = snapshot.scores[metric];
          if (value < 0 || value > 1) fail(`快照 ${String(snapshot.id)} 的 ${metric}=${value} 越界 [0,1]`);
        }
        if (snapshot.composite < 0 || snapshot.composite > 1) {
          fail(`快照 ${String(snapshot.id)} composite=${snapshot.composite} 越界 [0,1]`);
        }
      }
    },
  });

  checks.push({
    name: 'drift-calibrations-wellformed',
    run(fail) {
      // 不变量 4：无静默校准（每条记录可回链快照、动作合法）
      for (const row of goal.calibrations()) {
        if (!(CALIBRATION_ACTIONS as readonly string[]).includes(row.action)) {
          fail(`校准记录 action=${row.action} 不在四动作内`);
        }
        if (!row.detail.includes('snapshot=')) {
          fail(`校准记录缺 snapshot 回链（detail=${row.detail.slice(0, 40)}…）——不可解释的校准不可审计`);
        }
        if (row.detail.length === 0) fail('校准记录 detail 为空（无静默校准）');
      }
    },
  });

  if (service !== undefined) {
    checks.push({
      name: 'drift-snapshot-deterministic',
      run(fail) {
        // 不变量 3：快照可由同一纯函数重算复现（对最新一条做抽查）
        const snapshots = service.snapshots('goal-1', { from: 0, to: Number.MAX_SAFE_INTEGER });
        const latest = snapshots.at(-1);
        if (latest === undefined) return;
        // 重算口径：参数与快照自洽（composite == Σ w·score）
        const params = domain.table('drift_params').get(DRIFT_PARAMS_KEY) as DriftParams | undefined;
        if (params === undefined) return;
        const recomputed = DRIFT_METRICS.reduce((sum, metric) => sum + params.weights[metric] * latest.scores[metric], 0);
        if (Math.abs(recomputed - latest.composite) > 1e-9) {
          fail(`快照 ${String(latest.id)} composite=${latest.composite} 与 Σw·score=${recomputed} 不符（确定性被破坏）`);
        }
        const expectedLevel =
          latest.composite >= params.thresholds.watch ? 'normal' : latest.composite >= params.thresholds.drift ? 'watch' : 'drift';
        if (latest.level !== expectedLevel) {
          fail(`快照 ${String(latest.id)} level=${latest.level} 与判带结果 ${expectedLevel} 不符`);
        }
      },
    });
  }

  return checks;
}

const FORBIDDEN_METHODS: readonly string[] = [
  'edit',
  'focus',
  'pause',
  'resume',
  'block',
  'complete',
  'clear',
  'consume',
  'recordRound',
  'delete',
];

export function registerDriftInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<DriftTables>,
  options: DriftInvariantOptions,
): () => void {
  return registry.register('tda-drift', tdaPluginInstaller(driftInvariantChecks(domain, options)));
}
