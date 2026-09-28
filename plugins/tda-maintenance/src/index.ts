/**
 * tda-maintenance 插件出口（T2.3）。
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
import { maintenanceDomainSpec, type MaintenanceTables } from './domain.ts';
import { createMaintenanceService, type MaintenanceDeps, type MaintenanceService } from './service.ts';
import { registerMaintenanceInvariants } from './loadChecks.ts';

export {
  maintenanceDomainSpec,
  MAINTENANCE_PARAMS_KEY,
  MAINTENANCE_KINDS,
  MAINTENANCE_ASSET_KINDS,
  MAINTENANCE_PRIMITIVES,
  MAINTENANCE_PROPOSAL_STATUSES,
  HIGH_RISK_REASONS,
  DEFAULT_PARAMS,
  ProposalSchema,
  ReportSchema,
  ParamsSchema,
  type MaintenanceTables,
  type MaintenanceProposal,
  type MaintenanceAction,
  type MaintenanceReport,
  type MaintenanceParams,
  type MaintenanceAssetKind,
} from './domain.ts';
export {
  MAINTENANCE_PROPOSAL_BUSINESS_PREFIX,
  MAINTENANCE_ACTION_BUSINESS_PREFIX,
  MAINTENANCE_REPORT_BUSINESS_PREFIX,
  MAINTENANCE_PARAMS_BUSINESS_ID,
  maintenanceProposalPayload,
  maintenanceActionPayload,
  maintenanceReportPayload,
  maintenanceParamsPayload,
} from './events.ts';
export {
  createMaintenanceService,
  type MaintenanceService,
  type MaintenanceDeps,
  type MaintenanceActor,
  type MaintenanceSignals,
  type AssetSignalRow,
  type MaintenanceGovernanceSeam,
  type ScoreboardEntry,
} from './service.ts';
export { registerMaintenanceInvariants, maintenanceInvariantChecks, type MaintenanceInvariantOptions } from './loadChecks.ts';

export interface TdaMaintenanceHandle {
  readonly service: MaintenanceService;
  readonly domain: TdaDomain<MaintenanceTables>;
  dispose(): Promise<void>;
}

export interface TdaMaintenancePlugin {
  readonly name: string;
  apply(ctx: {
    readonly storage: TdaStorageBackend;
    readonly invariants: TdaInvariantRegistry;
    readonly session: TdaSessionSink;
    readonly deps: Omit<MaintenanceDeps, 'domain' | 'session'>;
  }): Promise<TdaMaintenanceHandle>;
}

export const tdaMaintenancePlugin: TdaMaintenancePlugin = {
  name: 'tda-maintenance',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(maintenanceDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createMaintenanceService({
      ...ctx.deps,
      domain,
      session: ctx.session,
      reconciler,
      index,
    });
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerMaintenanceInvariants(ctx.invariants, domain, { service });
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
