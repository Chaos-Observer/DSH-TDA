/**
 * tda-executor 插件级不变量：以插件自己的 npm 包名注册（`tda-executor`）。
 *
 * T4.1 §4.1 十一条不变量 → 结构性/加载期/服务期/冒烟门分层映射：
 *  1. 零直写权威        → **结构性**（deps seam 类型只含服务方法，无 domain 句柄）
 *                        + 加载期 `executor-zero-domain-write`（复核装配没塞多余面）；
 *  2. 路由确定性        → **纯函数导出**（routeTask/selectAttempts 单测逐分支）；
 *  3. 验证门            → 服务期 driveToTerminal + 冒烟门；
 *  4. 重试帽            → 加载期 `executor-attempts-capped` + 服务期；
 *  5. owner 纪律        → 服务期（claim owner 恒为 scheduler 会话）+ 冒烟门；
 *  6. 让位纪律          → 服务期（isMainActive 过滤）+ 冒烟门；
 *  7. 审批无自动过      → 服务期 resumeAttempt + 冒烟门；
 *  8. 孤儿显式终态      → 服务期 initialize 收口 + 加载期 `executor-no-orphan`；
 *  9. 预算口径单一      → 结构性（zone 判据复用 T0.2 zoneOfCaps，本插件不实现口径）；
 * 10. 零注入直通        → **结构性**（deps 无 context/surface 类型）；
 * 11. 双写配对          → 内核门（reconciler）+ dualwrite.spec。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  EXECUTOR_PARAMS_KEY,
  EXECUTOR_TERMINAL_STATUSES,
  ExecutorParamsSchema,
  type ExecutorTables,
} from './domain.ts';
import type { TaskExecutorService } from './service.ts';

export interface ExecutorInvariantOptions {
  readonly service?: TaskExecutorService | undefined;
}

export function executorInvariantChecks(
  domain: TdaDomain<ExecutorTables>,
  options: ExecutorInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];

  checks.push({
    name: 'executor-params-singleton',
    run(fail) {
      const table = domain.table('executor_params');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`executor_params 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== EXECUTOR_PARAMS_KEY) {
        fail(`executor_params 行键必须是 ${EXECUTOR_PARAMS_KEY}，实为 ${String(keys[0])}`);
      }
      const params = table.get(EXECUTOR_PARAMS_KEY);
      if (params === undefined) {
        fail('executor_params 单行缺失（启动序 initialize 未跑？）');
        return;
      }
      const parsed = ExecutorParamsSchema.safeParse(params);
      if (!parsed.success) {
        fail(`executor_params 非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`);
      }
    },
  });

  checks.push({
    name: 'executor-attempts-wellformed',
    run(fail) {
      const table = domain.table('executor_attempts');
      for (const [key, attempt] of table.entries()) {
        if (key !== String(attempt.id)) fail(`attempt 记录键 ${key} 与 id ${String(attempt.id)} 不符（键即纪律）`);
        if (attempt.attempts < 1) fail(`attempt ${String(attempt.id)} attempts < 1`);
        if (attempt.status === 'failed' && (attempt.unfinished?.length ?? 0) === 0) {
          fail(`attempt ${String(attempt.id)} failed 必携非空 unfinished（C5）`);
        }
        if (attempt.status === 'awaiting-approval' && attempt.approvalId === undefined) {
          fail(`attempt ${String(attempt.id)} awaiting-approval 必携 approvalId`);
        }
      }
    },
  });

  checks.push({
    name: 'executor-attempts-capped',
    run(fail) {
      const params = domain.table('executor_params').get(EXECUTOR_PARAMS_KEY);
      if (params === undefined) return;
      for (const [, attempt] of domain.table('executor_attempts').entries()) {
        if (attempt.attempts > params.maxRetries + 1) {
          fail(`attempt ${String(attempt.id)} attempts=${attempt.attempts} 超重试帽（maxRetries=${params.maxRetries}，禁第四次开跑）`);
        }
      }
    },
  });

  checks.push({
    name: 'executor-no-orphan',
    run(fail) {
      // 不变量 8：启动后不得残留"既非终态又无在飞语义"的悬挂 attempt。
      // 在飞（executing/awaiting-approval/verifying）由 initialize 的 bootAt 收口保证；
      // 加载期复核：终态集合外不允许出现其他状态值（schema 已兜底，这里是双保险）。
      for (const [, attempt] of domain.table('executor_attempts').entries()) {
        const known =
          (EXECUTOR_TERMINAL_STATUSES as readonly string[]).includes(attempt.status) ||
          ['selected', 'claimed', 'executing', 'awaiting-approval', 'verifying'].includes(attempt.status);
        if (!known) fail(`attempt ${String(attempt.id)} 状态值非法：${String(attempt.status)}`);
      }
    },
  });

  checks.push({
    name: 'executor-zero-domain-write',
    run(fail) {
      // 不变量 1/10：执行环服务面不得持有任何他域 domain 句柄（装配层错误在这里现形）。
      const service = options.service;
      if (service === undefined) return;
      const forbidden = Object.keys(service).filter((name) =>
        ['domain', 'storage', 'context', 'surface', 'session'].includes(name),
      );
      if (forbidden.length > 0) {
        fail(`executor 服务面携带了越权句柄 [${forbidden.join('、')}]（J1：零直写权威/零注入直通）`);
      }
    },
  });

  return checks;
}

export function registerExecutorInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<ExecutorTables>,
  options: ExecutorInvariantOptions,
): () => void {
  return registry.register('tda-executor', tdaPluginInstaller(executorInvariantChecks(domain, options)));
}
