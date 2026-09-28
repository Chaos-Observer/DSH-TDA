/**
 * tda-maintenance 插件级不变量（T2.3 §4.1 → 分层映射）：
 *  1. 编排非权威    → **结构性**（deps 只有治理 seam）+ 加载期 `maintenance-service-no-direct-write`；
 *  2. 无第二退役判据 → 加载期 `maintenance-retire-reason-whitelist`；
 *  3. 升格可解释    → schema 层（signals 必填 + thresholds 快照）；
 *  4. 高风险审批    → 服务期 approve（冒烟门）；
 *  5. 渐进降级不跳级 → 服务期 execute（冒烟门）；
 *  7. 吞吐帽/让位   → 服务期 cycle（冒烟门）；
 *  8. 可重放        → 双写门；
 *  9. 留痕          → 双写门 + audit_index。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import { MAINTENANCE_PARAMS_KEY, ParamsSchema, type MaintenanceParams, type MaintenanceTables } from './domain.ts';
import type { MaintenanceService } from './service.ts';

export interface MaintenanceInvariantOptions {
  readonly service?: MaintenanceService | undefined;
}

/** 既有检测器产出集合（不变量 2 白名单：T1.2 四信号/T2.2 stats/升格/协调/容量）。 */
const RETIRE_REASON_WHITELIST = new Set([
  'superseded',
  'unused-days',
  'capacity',
  'conflict',
  'rehearsal-fail',
  'use-fail',
  'manual',
  'promotion-signals',
  'coach-submitted',
  'conflict-merge',
  'invalidate',
]);

export function maintenanceInvariantChecks(
  domain: TdaDomain<MaintenanceTables>,
  options: MaintenanceInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];
  const { service } = options;

  checks.push({
    name: 'maintenance-params-singleton',
    run(fail) {
      const table = domain.table('maintenance_params');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`maintenance_params 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== MAINTENANCE_PARAMS_KEY) fail(`maintenance_params 行键必须是 ${MAINTENANCE_PARAMS_KEY}`);
      const params = table.get(MAINTENANCE_PARAMS_KEY) as MaintenanceParams | undefined;
      if (params === undefined) {
        fail('maintenance_params 单行缺失（启动序 initialize 未跑？）');
        return;
      }
      const parsed = ParamsSchema.safeParse(params);
      if (!parsed.success) fail(`maintenance_params 非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`);
    },
  });

  checks.push({
    name: 'maintenance-retire-reason-whitelist',
    run(fail) {
      // 不变量 2：退役提议的 reason.kind 必属既有检测器产出集合
      for (const [key, value] of domain.table('maintenance_proposals').entries()) {
        const row = value as { readonly action: { readonly primitive: string; readonly reason: { readonly kind: string } } };
        if (row.action.primitive === 'retire' || row.action.primitive === 'propose-invalidate') {
          if (!RETIRE_REASON_WHITELIST.has(row.action.reason.kind)) {
            fail(`提议 ${key} 的退役 reason.kind=${row.action.reason.kind} 不在既有检测器集合（无第二退役判据）`);
          }
        }
      }
    },
  });

  if (service !== undefined) {
    checks.push({
      name: 'maintenance-service-no-direct-write',
      run(fail) {
        const face = service as unknown as Record<string, unknown>;
        for (const forbidden of ['putAsset', 'writeTimeline', 'appendEntry', 'mutateAsset']) {
          if (typeof face[forbidden] === 'function') {
            fail(`maintenance 服务面出现直接资产写方法 ${forbidden}（编排非权威被破坏）`);
          }
        }
      },
    });
  }

  return checks;
}

export function registerMaintenanceInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<MaintenanceTables>,
  options: MaintenanceInvariantOptions,
): () => void {
  return registry.register('tda-maintenance', tdaPluginInstaller(maintenanceInvariantChecks(domain, options)));
}
