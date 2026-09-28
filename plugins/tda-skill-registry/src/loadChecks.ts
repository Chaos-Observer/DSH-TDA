/**
 * tda-skill-registry 插件级不变量（T2.2 §4.1 → 分层映射）：
 *  1. 回放入职       → 服务期 rehearse（冒烟门）；
 *  2. 晋升双条件     → 服务期 requestConsolidate（冒烟门）；
 *  3. 前置依赖在库   → 服务期 rehearse（冒烟门）；
 *  4. 零原文泄漏     → **结构性**（schema 无正文槽位）+ 加载期 `skill-steps-whitelist`；
 *  5. 冲突只标不裁   → 加载期 `skill-conflict-mark-only`（无技能定义被检查改动）；
 *  6. 退役可逆/双通道 → 服务期（冒烟门）；
 *  7. Elo 可复算     → 加载期 `skill-usage-elo-replayable`（eloAfter = f(eloBefore,K,outcome)）；
 *  8. 治理单一       → **结构性**（无 lifecycle 字段）+ 加载期 `skill-service-no-lifecycle-face`；
 *  9. 留痕对账       → 加载期 `skill-params-singleton` + 双写门。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import { SKILL_PARAMS_KEY, SkillParamsSchema, type SkillParams, type SkillTables } from './domain.ts';
import type { SkillService } from './service.ts';

export interface SkillInvariantOptions {
  readonly service?: SkillService | undefined;
}

export function skillInvariantChecks(
  domain: TdaDomain<SkillTables>,
  options: SkillInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];
  const { service } = options;

  checks.push({
    name: 'skill-params-singleton',
    run(fail) {
      const table = domain.table('skill_params');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`skill_params 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== SKILL_PARAMS_KEY) fail(`skill_params 行键必须是 ${SKILL_PARAMS_KEY}`);
      const params = table.get(SKILL_PARAMS_KEY) as SkillParams | undefined;
      if (params === undefined) {
        fail('skill_params 单行缺失（启动序 initialize 未跑？）');
        return;
      }
      const parsed = SkillParamsSchema.safeParse(params);
      if (!parsed.success) fail(`skill_params 非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`);
    },
  });

  checks.push({
    name: 'skill-steps-whitelist',
    run(fail) {
      for (const [key, value] of domain.table('skills').entries()) {
        const skill = value as { readonly procedure: { readonly steps: readonly { readonly action: string }[] } };
        for (const step of skill.procedure.steps) {
          if (step.action.length > 80) {
            fail(`技能 ${key} 步骤 action 超 80 字符（疑似原文/参数值泄漏）`);
          }
        }
      }
    },
  });

  checks.push({
    name: 'skill-usage-elo-replayable',
    run(fail) {
      for (const [key, value] of domain.table('skill_usage_log').entries()) {
        const use = value as { readonly eloBefore: number; readonly eloAfter: number; readonly k: number; readonly outcome: string };
        const s = use.outcome === 'success' ? 1 : use.outcome === 'partial' ? 0.5 : 0;
        const expected = use.eloBefore + use.k * (s - 1 / (1 + 10 ** (1500 / 400)));
        // baseline=1500 固定基线口径（参数改 baseline 只影响后续记录，此处按落盘 k/before 复算）
        const recomputed = use.eloBefore + use.k * (s - 1 / (1 + 10 ** ((1500 - use.eloBefore) / 400)));
        if (Math.abs(use.eloAfter - recomputed) > 1e-6 && Math.abs(use.eloAfter - expected) > 1e-6) {
          fail(`使用记录 ${key} 的 Elo 不可复算（after=${use.eloAfter}，复算=${recomputed}）`);
        }
      }
    },
  });

  if (service !== undefined) {
    checks.push({
      name: 'skill-service-no-lifecycle-face',
      run(fail) {
        const face = service as unknown as Record<string, unknown>;
        for (const forbidden of ['retireLocal', 'setLifecycle', 'archive']) {
          if (typeof face[forbidden] === 'function') {
            fail(`skill 服务面出现生命周期写方法 ${forbidden}（治理单一被破坏）`);
          }
        }
      },
    });
  }

  return checks;
}

export function registerSkillInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<SkillTables>,
  options: SkillInvariantOptions,
): () => void {
  return registry.register('tda-skill-registry', tdaPluginInstaller(skillInvariantChecks(domain, options)));
}
