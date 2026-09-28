/**
 * tda-coach 插件出口（T2.1）。
 *
 * 安全面落点（J1/J11）：deps 只暴露四类窄面（只读 reads / 目标库 rehearse 委托 /
 * PIPE append / 迁移执行器），编译期就没有任何治理写方法与 injection 写面；
 * `coach-service-no-lifecycle-face` 在加载期复核。
 */
import {
  createAuditIndex,
  createDualWriteReconciler,
  openTdaDomain,
  registerTdaInvariants,
  type TdaDomain,
  type TdaInvariantRegistry,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { coachDomainSpec, type CoachTables } from './domain.ts';
import { createCoachService, type CoachDeps, type CoachService } from './service.ts';
import { registerCoachInvariants } from './loadChecks.ts';

export {
  coachDomainSpec,
  COACH_PARAMS_KEY,
  COACH_SCAN_STATE_KEY,
  COACH_TRIGGER_KINDS,
  COACH_CANDIDATE_KINDS,
  COACH_CANDIDATE_STATUSES,
  COACH_REVIEW_STATUSES,
  COACH_RISK_LEVELS,
  DEFAULT_COACH_PARAMS,
  CoachParamsSchema,
  CoachCandidateSchema,
  CoachReviewSchema,
  type CoachTables,
  type CoachCandidate,
  type CoachReview,
  type CoachParams,
  type CoachScanState,
  type CoachTopology,
} from './domain.ts';
export {
  buildCandidate,
  clusterRows,
  passesQualityGate,
  summarizeCluster,
  isControlFlowPattern,
  type ClusterRow,
  type BuiltCandidate,
} from './cluster.ts';
export {
  COACH_REVIEW_BUSINESS_PREFIX,
  COACH_CANDIDATE_BUSINESS_PREFIX,
  COACH_PARAMS_BUSINESS_ID,
  coachReviewPayload,
  coachCandidatePayload,
  coachParamsPayload,
} from './events.ts';
export {
  createCoachService,
  type CoachService,
  type CoachDeps,
  type CoachActor,
  type CoachReads,
  type CoachMetaSeam,
  type CoachSkillSeam,
  type CoachPipeSeam,
  type CoachTransferExecutor,
} from './service.ts';
export { registerCoachInvariants, coachInvariantChecks, type CoachInvariantOptions } from './loadChecks.ts';

export interface TdaCoachHandle {
  readonly service: CoachService;
  readonly domain: TdaDomain<CoachTables>;
  dispose(): Promise<void>;
}

export interface TdaCoachPlugin {
  readonly name: string;
  apply(ctx: {
    readonly storage: TdaStorageBackend;
    readonly invariants: TdaInvariantRegistry;
    readonly session: TdaSessionSink;
    readonly deps: Omit<CoachDeps, 'domain' | 'session'>;
  }): Promise<TdaCoachHandle>;
}

export const tdaCoachPlugin: TdaCoachPlugin = {
  name: 'tda-coach',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(coachDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createCoachService({
      ...ctx.deps,
      domain,
      session: ctx.session,
      reconciler,
      index,
    });
    // 启动序：先建状态（参数/水位单行），再注册检查（纪律 #14）
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerCoachInvariants(ctx.invariants, domain, {
      reads: ctx.deps.reads,
      service,
    });
    return {
      service,
      domain,
      async dispose() {
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
