/**
 * tda-smoke 插件级不变量：以插件自己的 npm 包名（tda-smoke）注册。
 *
 * 检查目标记录形态自洽：键符合 goal-<n> 约定、revision 为非负整数。
 * （zod schema 在写路径已强制类型；此处兜底业务约定。）
 */
import { tdaPluginInstaller, type TdaInvariantCheck, type TdaInvariantRegistry, type TdaDomain } from '@tda/kernel';
import type { SmokeTables } from './domain.ts';

export function smokeInvariantChecks(domain: TdaDomain<SmokeTables>): TdaInvariantCheck[] {
  return [
    {
      name: 'goal-record-shape',
      run(fail) {
        for (const [key, value] of domain.table('goals').entries()) {
          if (!key.startsWith('goal-')) {
            fail(`目标键 ${key} 不符合 goal-<n> 约定`);
          }
          if (!Number.isInteger(value.revision) || value.revision < 0) {
            fail(`目标 ${key} revision 非法：${String(value.revision)}`);
          }
        }
      },
    },
  ];
}

/** 用插件包名注册插件级检查；返回注销函数。 */
export function registerSmokeInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<SmokeTables>,
): () => void {
  return registry.register('tda-smoke', tdaPluginInstaller(smokeInvariantChecks(domain)));
}
