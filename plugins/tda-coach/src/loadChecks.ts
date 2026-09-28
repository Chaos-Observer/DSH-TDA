/**
 * tda-coach 插件级不变量（T2.1 §4.1 → 检查/运行时/结构分层映射）：
 *  1. 零直接资产写权   → **结构性**（deps 只暴露 propose/rehearse/requestConsolidate/append 窄面）
 *  2. 未验证零固化     → 服务期 submit 断言（冒烟门）；
 *  3. 零原文泄漏       → **结构性**（schema 无自由正文槽位）+ 加载期 `coach-candidates-whitelist`；
 *  4. 复盘确定性       → 纯函数聚类（CI 断言在冒烟门）；
 *  5. 吞吐帽/让位      → 服务期（冒烟门）；
 *  6. 高风险审批       → 服务期（冒烟门）；
 *  7. 无注入直通       → **结构性**（无 T0.4 injection 写面）；
 *  8. fail-open        → 服务期（冒烟门：failed + unfinished）；
 *  9. 留痕可审计       → 加载期 review/candidate 事件载荷良构检查。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  COACH_PARAMS_KEY,
  CoachParamsSchema,
  type CoachParams,
  type CoachTables,
} from './domain.ts';
import type { CoachReads, CoachService } from './service.ts';

export interface CoachInvariantOptions {
  readonly reads: CoachReads;
  readonly service?: CoachService | undefined;
}

export function coachInvariantChecks(
  domain: TdaDomain<CoachTables>,
  options: CoachInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];
  const { service } = options;

  checks.push({
    name: 'coach-params-singleton',
    run(fail) {
      const table = domain.table('coach_params');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`coach_params 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== COACH_PARAMS_KEY) fail(`coach_params 行键必须是 ${COACH_PARAMS_KEY}，实为 ${String(keys[0])}`);
      const params = table.get(COACH_PARAMS_KEY) as CoachParams | undefined;
      if (params === undefined) {
        fail('coach_params 单行缺失（启动序 initialize 未跑？）');
        return;
      }
      const parsed = CoachParamsSchema.safeParse(params);
      if (!parsed.success) fail(`coach_params 非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`);
    },
  });

  checks.push({
    name: 'coach-candidates-whitelist',
    run(fail) {
      // 零原文自检（不变量 3）：候选字段值不得出现长自由文本（分类键/引用/数字/拓扑除外）
      for (const [key, value] of domain.table('coach_candidates').entries()) {
        const row = value as { readonly rule: { readonly expect?: string } };
        const expect = row.rule?.expect;
        if (expect !== undefined && expect.length > 120) {
          fail(`候选 ${key} 的 rule.expect 超 120 字符（疑似原文泄漏，白名单只收分类串）`);
        }
      }
    },
  });

  checks.push({
    name: 'coach-reviews-wellformed',
    run(fail) {
      for (const [, value] of domain.table('coach_reviews').entries()) {
        const row = value as { readonly status: string; readonly unfinished?: string[]; readonly id: unknown };
        if (row.status === 'failed' && (row.unfinished === undefined || row.unfinished.length === 0)) {
          fail(`复盘 ${String(row.id)} 记 failed 却无 unfinished 清单（C5 显式终态）`);
        }
      }
    },
  });

  if (service !== undefined) {
    checks.push({
      name: 'coach-service-no-lifecycle-face',
      run(fail) {
        // 治理单一（J5）：coach 服务面不得出现资产生命周期写方法
        const face = service as unknown as Record<string, unknown>;
        for (const forbidden of ['consolidate', 'retire', 'restore', 'invalidate', 'appendEntry']) {
          if (typeof face[forbidden] === 'function') {
            fail(`coach 服务面出现治理写方法 ${forbidden}（零直接资产写权被破坏）`);
          }
        }
      },
    });
  }

  return checks;
}

export function registerCoachInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<CoachTables>,
  options: CoachInvariantOptions,
): () => void {
  return registry.register('tda-coach', tdaPluginInstaller(coachInvariantChecks(domain, options)));
}
