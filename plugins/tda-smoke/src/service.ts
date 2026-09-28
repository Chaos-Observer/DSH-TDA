/**
 * tda-smoke 服务：目标的创建/推进，全部经双写器（状态总线+审计总线配对）。
 *
 * 插件业务代码只调这两个方法——domain/双写/索引细节全在内核（决策点③）。
 * completeGoal 走 CAS：期望 revision 不匹配即抛 STALE_REVISION，不静默重试。
 */
import {
  allocateId,
  cas,
  dualWrite,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type GoalId,
  type TdaDomain,
  type TdaSessionSink,
} from '@tda/kernel';
import { goalChangePayload } from './events.ts';
import type { SmokeTables } from './domain.ts';

export interface SmokeServiceDeps {
  readonly domain: TdaDomain<SmokeTables>;
  readonly session: TdaSessionSink;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
}

export interface SmokeService {
  createGoal(title: string): Promise<GoalId>;
  completeGoal(id: GoalId, expectedRevision: number): Promise<void>;
}

export function createSmokeService(deps: SmokeServiceDeps): SmokeService {
  const goals = deps.domain.table('goals');
  // exactOptionalPropertyTypes：仅在有值时挂键，避免显式传 undefined
  const context: DualWriteContext = {
    ...(deps.reconciler ? { reconciler: deps.reconciler } : {}),
    ...(deps.index ? { index: deps.index } : {}),
  };
  return {
    async createGoal(title) {
      // 无洞 id：从表内最大后缀 +1 派生，分配即落键，崩溃安全
      const id = allocateId(goals, 'goal');
      const record = { id, title, status: 'active' as const, revision: 0 };
      await dualWrite(
        deps.session,
        {
          family: 'goalTree/change',
          businessId: id,
          payload: goalChangePayload(record),
          domainWrite: () => goals.put(id, record),
        },
        context,
      );
      return id as GoalId;
    },
    async completeGoal(id, expectedRevision) {
      const current = goals.get(id);
      if (!current) {
        throw new Error(`目标不存在：${id}`);
      }
      const next = cas(current, expectedRevision, (goal) => ({ ...goal, status: 'done' as const }));
      await dualWrite(
        deps.session,
        {
          family: 'goalTree/change',
          businessId: id,
          payload: goalChangePayload(next),
          domainWrite: () => goals.put(id, next),
        },
        context,
      );
    },
  };
}
