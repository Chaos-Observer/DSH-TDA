/**
 * tda-workflow 插件级不变量（T2.5 §4.1 → 分层映射）：
 *  1. 定义冻结        → 加载期 propose 断言（服务期）+ 双写门；
 *  2. 控制流/数据流分离 → **结构性**（script 不进任何 eval——v1 经 executor seam 执行）
 *                       + 加载期 `workflow-script-no-eval`（scriptHash 冻结完整性）；
 *  3. contract 强制   → 服务期（冒烟门三行为）；
 *  4. 审批挂起语义    → 服务期（冒烟门）；
 *  5. 预算单一口径    → **结构性**（预算经 taskId 挂靠，无独立预算域）；
 *  6. 重规划有界      → 服务期（冒烟门）；
 *  7. 模板实例化不改模板 → 服务期（冒烟门字节比对）；
 *  8. 外部验证阀      → 服务期 requestConsolidate（冒烟门）；
 *  9. 可重放          → 双写门（runs 投影 = events 重放）。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import { WORKFLOW_PARAMS_KEY, ParamsSchema, scriptHashOf, type WorkflowParams, type WorkflowTables } from './domain.ts';
import type { WorkflowService } from './service.ts';

export interface WorkflowInvariantOptions {
  readonly service?: WorkflowService | undefined;
}

export function workflowInvariantChecks(
  domain: TdaDomain<WorkflowTables>,
  options: WorkflowInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];
  const { service } = options;

  checks.push({
    name: 'workflow-params-singleton',
    run(fail) {
      const table = domain.table('workflow_params');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`workflow_params 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== WORKFLOW_PARAMS_KEY) fail(`workflow_params 行键必须是 ${WORKFLOW_PARAMS_KEY}`);
      const params = table.get(WORKFLOW_PARAMS_KEY) as WorkflowParams | undefined;
      if (params === undefined) {
        fail('workflow_params 单行缺失（启动序 initialize 未跑？）');
        return;
      }
      const parsed = ParamsSchema.safeParse(params);
      if (!parsed.success) fail(`workflow_params 非法：${parsed.error.issues.map((issue) => issue.message).join('；')}`);
    },
  });

  checks.push({
    name: 'workflow-script-hash-frozen',
    run(fail) {
      // scriptHash 冻结完整性：落盘 script 必须能复算出同一指纹
      for (const [key, value] of domain.table('workflow_defs').entries()) {
        const def = value as { readonly script: string; readonly scriptHash: string };
        if (scriptHashOf(def.script) !== def.scriptHash) {
          fail(`定义 ${key} 的 scriptHash 与落盘 script 不符（冻结被破坏）`);
        }
      }
    },
  });

  checks.push({
    name: 'workflow-runs-match-events-replay',
    run(fail) {
      // 不变量 9 的投影自证：run 终态在 events 里必有 run-end（或仍在途）
      const runEnds = new Set<string>();
      for (const [, value] of domain.table('workflow_events').entries()) {
        const event = value as { readonly kind: string; readonly runId: string; readonly detail: Record<string, unknown> };
        if (event.kind === 'run-end') runEnds.add(event.runId);
      }
      for (const [key, value] of domain.table('workflow_runs').entries()) {
        const run = value as { readonly runId: string; readonly status: string };
        if (run.status === 'completed' && !runEnds.has(String(run.runId))) {
          fail(`运行 ${key} 已 completed 却无 run-end 事件（投影与权威日志脱节）`);
        }
      }
    },
  });

  if (service !== undefined) {
    checks.push({
      name: 'workflow-service-no-def-write-face',
      run(fail) {
        const face = service as unknown as Record<string, unknown>;
        for (const forbidden of ['mutateDef', 'writeScript', 'editDefinition']) {
          if (typeof face[forbidden] === 'function') {
            fail(`workflow 服务面出现定义改写方法 ${forbidden}（定义冻结被破坏）`);
          }
        }
      },
    });
  }

  return checks;
}

export function registerWorkflowInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<WorkflowTables>,
  options: WorkflowInvariantOptions,
): () => void {
  return registry.register('tda-workflow', tdaPluginInstaller(workflowInvariantChecks(domain, options)));
}
