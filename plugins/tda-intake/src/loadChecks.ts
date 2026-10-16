/**
 * tda-intake 插件级不变量：以插件自己的 npm 包名注册（`tda-intake`）。
 *
 * T4.2 §4.1 十一条不变量 → 结构性/加载期/服务期/冒烟门分层映射：
 *  1. 原文隔离        → 加载期 `intake-no-raw-text`（域内无长文本字段——schema 层面
 *                      无正文字段即结构性保证；answer 截断在服务期）；
 *  2. 问题确定性      → **纯函数导出**（deriveQuestionsFromSeed 单测逐分支）；
 *  3. 分解校验门      → **纯函数导出**（validateProposal 单测逐查）+ 服务期；
 *  4. 审批门          → 服务期 verifyTicket 一次性 + 冒烟门；
 *  5. 创建收敛        → 加载期 `intake-source-traceable`（source='intake' ⇒ 溯源非空
 *                      的服务期对偶在 goal-state；此处校验 createdGoalIds 回填）；
 *  6. 零目标编辑权    → **结构性**（goalTree seam 类型只含 create/get）+ 加载期
 *                      `intake-zero-edit-surface`（复核装配没塞 edit/clear/delete）；
 *  7. 零注入直通      → **结构性**（schema 白名单无任务指令字段——domain 层保证）；
 *  8. 双写配对        → 内核门（reconciler）+ dualwrite.spec；
 *  9. 轮次帽          → 服务期 answer + escalation 呈现 + 冒烟门；
 * 10. 单活动草稿      → 服务期 intake fail-loud + 冒烟门；
 * 11. 拓扑序/中断保留 → 服务期 commitOrder + 半树显式终态 + 冒烟门。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  INTAKE_PARAMS_KEY,
  type IntakeTables,
} from './domain.ts';
import type { IntakeService } from './service.ts';

export interface IntakeInvariantOptions {
  readonly service?: IntakeService | undefined;
}

export function intakeInvariantChecks(
  domain: TdaDomain<IntakeTables>,
  options: IntakeInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];

  checks.push({
    name: 'intake-params-singleton',
    run(fail) {
      const table = domain.table('intake_params');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`intake_params 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== INTAKE_PARAMS_KEY) {
        fail(`intake_params 行键必须是 ${INTAKE_PARAMS_KEY}，实为 ${String(keys[0])}`);
      }
    },
  });

  checks.push({
    name: 'intake-no-raw-text',
    run(fail) {
      // 不变量 1：原文隔离——域记录无正文字段（schema 层面保证）；此处复核
      // 长文本泄漏面：objective/answer 字段禁超长（全文只允许在 timeline chunk）
      const drafts = domain.table('intake_drafts');
      for (const [key, draft] of drafts.entries()) {
        if (draft.objective.length > 500) {
          fail(`草稿 ${key} 的 objective 超 500 字符（疑似原文入域，J2）`);
        }
        for (const question of draft.openQuestions) {
          if ((question.answer?.length ?? 0) > 2100) {
            fail(`草稿 ${key} 问题 ${question.id} 的 answer 超 2100 字符（截断纪律被破坏）`);
          }
        }
      }
    },
  });

  checks.push({
    name: 'intake-source-traceable',
    run(fail) {
      // 不变量 5/11：committed 提议必携等长 createdGoalIds（T0.1 v2 溯源对偶）
      const proposals = domain.table('intake_proposals');
      for (const [key, proposal] of proposals.entries()) {
        if (proposal.status === 'committed') {
          if (proposal.approval === undefined) fail(`提议 ${key} committed 却无 approval（审批门被破坏）`);
          if ((proposal.createdGoalIds?.length ?? 0) !== proposal.nodes.length) {
            fail(`提议 ${key} committed 但 createdGoalIds 与 nodes 不等长（溯源断裂）`);
          }
        }
      }
    },
  });

  checks.push({
    name: 'intake-zero-edit-surface',
    run(fail) {
      // 不变量 6（J7 零目标编辑权）：服务面携带目标编辑方法 ⇒ 装配把影子目标权威缝回来了
      const service = options.service as Record<string, unknown> | undefined;
      if (service === undefined) return;
      for (const forbidden of ['editGoal', 'clearGoal', 'deleteGoal', 'focusGoal', 'completeGoal', 'edit', 'clear', 'delete']) {
        if (forbidden in service) {
          fail(`intake 服务面携带越权方法 ${forbidden}（J7：intake 无目标编辑权）`);
        }
      }
    },
  });

  return checks;
}

export function registerIntakeInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<IntakeTables>,
  options: IntakeInvariantOptions,
): () => void {
  return registry.register('tda-intake', tdaPluginInstaller(intakeInvariantChecks(domain, options)));
}
