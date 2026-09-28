/**
 * T3.2 · 加载期不变量检查（§4.1 核心 6 条）。
 */
import { tdaPluginInstaller, type TdaDomain, type TdaInvariantCheck, type TdaInvariantRegistry } from '@tda/kernel';
import type { ApprovalRequest, SupervisionEvent, SupervisionTables } from './domain.ts';

export interface SupervisionReadFace {
  approvals(): readonly ApprovalRequest[];
  events(): readonly SupervisionEvent[];
}

export function supervisionInvariantChecks(domain: TdaDomain<SupervisionTables>, face?: SupervisionReadFace): TdaInvariantCheck[] {
  void domain;
  const checks: TdaInvariantCheck[] = [];

  checks.push({
    name: 'supervision-token-single-use',
    run(fail) {
      // 不变量 2：resolution 在场 ⇒ token.consumedAt 必在场（消费即焚）。
      for (const approval of face?.approvals() ?? []) {
        if (approval.resolution !== undefined && approval.token.consumedAt === undefined) {
          fail(`审批项 ${String(approval.approvalId)} 已 resolution 却未消费 token（一次性纪律被破坏）`);
        }
        if (approval.status !== 'pending' && approval.status !== 'cancelled' && approval.token.consumedAt === undefined && approval.resolution !== undefined) {
          fail(`审批项 ${String(approval.approvalId)} 终态未焚 token`);
        }
      }
    },
  });

  checks.push({
    name: 'supervision-no-timeout-autopass',
    run(fail) {
      // 不变量 3：approved 必带 resolution（人类动作）；无 resolution 的 approved=时间路径自动通过。
      for (const approval of face?.approvals() ?? []) {
        if (approval.status === 'approved' && approval.resolution?.decision !== 'approve') {
          fail(`审批项 ${String(approval.approvalId)} approved 却无人类 resolution（存在超时自动通过路径）`);
        }
      }
    },
  });

  checks.push({
    name: 'supervision-explicit-terminal',
    run(fail) {
      // 不变量 5：rejected/cancelled 必带 reason。
      for (const approval of face?.approvals() ?? []) {
        if ((approval.status === 'rejected' || approval.status === 'cancelled') && (approval.statusReason ?? '') === '') {
          fail(`审批项 ${String(approval.approvalId)} ${approval.status} 却无 reason（显式终态被破坏）`);
        }
      }
    },
  });

  checks.push({
    name: 'supervision-billing-target',
    run(fail) {
      // 不变量 7：每个审批项 taskId/goalId 至少其一。
      for (const approval of face?.approvals() ?? []) {
        if (approval.taskId === undefined && approval.goalId === undefined) {
          fail(`审批项 ${String(approval.approvalId)} 缺计费落点（taskId/goalId 至少其一）`);
        }
      }
    },
  });

  checks.push({
    name: 'supervision-irreversible-high',
    run(fail) {
      // 不变量 8：不可逆动作最低 high；digest 呈现由服务保证（这里对账权威）。
      for (const approval of face?.approvals() ?? []) {
        if (approval.whatToShow.impact.some((impact) => !impact.reversible) && approval.riskLevel !== 'high') {
          fail(`审批项 ${String(approval.approvalId)} 含不可逆影响却定级 ${approval.riskLevel}（元规则被破坏）`);
        }
      }
    },
  });

  checks.push({
    name: 'supervision-params-singleton',
    run(fail) {
      const rows = [...domain.table('supervision_params').keys()];
      if (rows.length !== 1 || rows[0] !== 'singleton') {
        fail(`supervision_params 必须恰有一行 singleton（现状 ${rows.length} 行）`);
      }
    },
  });

  return checks;
}

export function registerSupervisionInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<SupervisionTables>,
  face?: SupervisionReadFace,
): () => void {
  return registry.register('tda-supervision', tdaPluginInstaller(supervisionInvariantChecks(domain, face)));
}
