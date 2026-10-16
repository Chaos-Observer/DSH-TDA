/**
 * tda-planner 插件级不变量：以插件自己的 npm 包名注册（`tda-planner`）。
 *
 * T4.5 §4.1 十一条不变量 → 结构性/加载期/服务期/冒烟门分层映射：
 *  1. 质量门            → **纯函数导出**（evaluatePlan 单测逐查）+ confirmRequest 服务期；
 *  2. 审批门            → 服务期（verifyTicket 一次性）+ 冒烟门；
 *  3. 拓扑序/中断保留   → 服务期 applyTasks + settleCancelled（C5）；
 *  4. 零执行权          → **结构性**（deps seam 类型只含 get/list/create/edit/block）
 *                        + 加载期 `planner-zero-execution-surface`（复核装配没塞多余面）；
 *  5. 溯源              → 加载期 `planner-applied-traceable`（applied ⇒ tempToTaskId 完整）；
 *  6. 预案引用完备      → 加载期 `planner-contingency-refs`（activated ⇒ approvalId+resolvedAt 等）；
 *  7. 预算守恒          → 质量门②（evaluatePlan）+ T0.2 服务面 assertScopeConservation；
 *  8. supersede 单向    → domain superRefine（replan ⇒ deviation+supersedes）+ 加载期复核；
 *  9. 触发检测确定性    → **纯函数导出**（evaluateTriggers 单测逐分支）；
 * 10. expired 自动/activated 需批 → domain superRefine + 服务期；
 * 11. 双写配对          → 内核门（reconciler）+ dualwrite.spec。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  PLANNER_PARAMS_KEY,
  type PlannerTables,
} from './domain.ts';
import type { TaskPlannerService } from './service.ts';

export interface PlannerInvariantOptions {
  readonly service?: TaskPlannerService | undefined;
}

export function plannerInvariantChecks(
  domain: TdaDomain<PlannerTables>,
  options: PlannerInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];

  checks.push({
    name: 'planner-params-singleton',
    run(fail) {
      const table = domain.table('planner_params');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`planner_params 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== PLANNER_PARAMS_KEY) {
        fail(`planner_params 行键必须是 ${PLANNER_PARAMS_KEY}，实为 ${String(keys[0])}`);
      }
    },
  });

  checks.push({
    name: 'planner-plan-terminal-settled',
    run(fail) {
      const table = domain.table('planner_plans');
      for (const [key, plan] of table.entries()) {
        const terminal = ['applied', 'rejected', 'cancelled', 'superseded'].includes(plan.status);
        if (terminal && plan.settledAt === undefined) fail(`计划 ${key} 终态 ${plan.status} 缺 settledAt`);
        if (!terminal && plan.settledAt !== undefined) fail(`计划 ${key} 非终态 ${plan.status} 却携 settledAt`);
        if (plan.status !== 'draft' && !plan.coverage.passed) {
          fail(`计划 ${key} 离开 draft 但质量门未过（coverage.passed=false）`);
        }
      }
    },
  });

  checks.push({
    name: 'planner-applied-traceable',
    run(fail) {
      const table = domain.table('planner_plans');
      for (const [key, plan] of table.entries()) {
        if (plan.status !== 'applied') continue;
        if ((plan.appliedTaskIds?.length ?? 0) !== plan.tasks.length) {
          fail(`计划 ${key} applied 但 appliedTaskIds 与 tasks 不等长（溯源断裂）`);
        }
        if (plan.tempToTaskId === undefined || Object.keys(plan.tempToTaskId).length !== plan.tasks.length) {
          fail(`计划 ${key} applied 但 tempToTaskId 映射不完整（replan diff 失基准）`);
        }
        if (plan.approval === undefined) fail(`计划 ${key} applied 却无 approval（审批门被破坏）`);
      }
    },
  });

  checks.push({
    name: 'planner-supersede-chain',
    run(fail) {
      const table = domain.table('planner_plans');
      const byId = new Map([...table.entries()].map(([key, plan]) => [key, plan]));
      for (const [key, plan] of table.entries()) {
        if (plan.kind === 'replan') {
          if (plan.deviation === undefined) fail(`replan 计划 ${key} 缺 deviation（偏差证据）`);
          if (plan.supersedes === undefined) fail(`replan 计划 ${key} 缺 supersedes（单向链断裂）`);
        }
        if (plan.kind === 'initial' && plan.supersedes !== undefined) {
          fail(`initial 计划 ${key} 不得携 supersedes`);
        }
        if (plan.supersedes !== undefined && !byId.has(plan.supersedes)) {
          fail(`计划 ${key} 的 supersedes 指向不存在的计划 ${plan.supersedes}`);
        }
      }
    },
  });

  checks.push({
    name: 'planner-contingency-refs',
    run(fail) {
      const contingencies = domain.table('planner_contingencies');
      const plans = domain.table('planner_plans');
      for (const [key, contingency] of contingencies.entries()) {
        if (!(contingency.carveOut > 0 && contingency.carveOut < 1)) {
          fail(`预案 ${key} 的 carveOut 须在 (0,1)（收到 ${contingency.carveOut}）`);
        }
        if (contingency.primaryTaskId === contingency.alternativeTaskId) {
          fail(`预案 ${key} 主路径与备选同一任务`);
        }
        if (contingency.status === 'activated') {
          if (contingency.activationApprovalId === undefined) fail(`预案 ${key} activated 却缺 activationApprovalId`);
          if (contingency.resolvedAt === undefined) fail(`预案 ${key} activated 却缺 resolvedAt`);
        }
        if (contingency.status === 'vetoed' || contingency.status === 'expired') {
          if ((contingency.reason ?? '') === '') fail(`预案 ${key} ${contingency.status} 却缺 reason（显式终态）`);
        }
        const plan = plans.get(contingency.planId);
        if (plan === undefined) fail(`预案 ${key} 的 planId 指向不存在的计划 ${contingency.planId}`);
      }
    },
  });

  checks.push({
    name: 'planner-zero-execution-surface',
    run(fail) {
      // 不变量 4（J1 零执行权）：服务面携带越权句柄 ⇒ 装配把"自规划自执行"闭环缝回来了。
      const service = options.service as Record<string, unknown> | undefined;
      if (service === undefined) return;
      for (const forbidden of ['claim', 'complete', 'startRun', 'completeRun', 'dispatch', 'execute', 'pump']) {
        if (forbidden in service) {
          fail(`规划器服务面携带越权方法 ${forbidden}（J1：规划与执行强分离被破坏）`);
        }
      }
      const deps = (service as unknown as { __deps?: Record<string, unknown> }).__deps;
      if (deps !== undefined) {
        for (const forbidden of ['context', 'surface', 'storage', 'domain']) {
          if (forbidden in deps) fail(`规划器 deps 携带越权句柄 ${forbidden}（零注入直通被破坏）`);
        }
      }
    },
  });

  return checks;
}

export function registerPlannerInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<PlannerTables>,
  options: PlannerInvariantOptions,
): () => void {
  return registry.register('tda-planner', tdaPluginInstaller(plannerInvariantChecks(domain, options)));
}
