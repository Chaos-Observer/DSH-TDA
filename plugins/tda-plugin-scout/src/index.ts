/**
 * tda-plugin-scout 插件出口（T2.6）。
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
import {
  scoutDomainSpec,
  type ScoutTables,
} from './domain.ts';
import { createPluginScoutService, type PluginScoutService, type ScoutDeps } from './service.ts';
import { registerScoutInvariants } from './loadChecks.ts';

export {
  scoutDomainSpec,
  SCOUT_PARAMS_KEY,
  SCOUT_GRADES,
  BADGES,
  DEFAULT_PARAMS,
  scorePlugin,
  scoreDimensions,
  AssessmentSchema,
  ScoutRunSchema,
  ParamsSchema,
  type ScoutTables,
  type PluginAssessment,
  type ScoutRun,
  type ScoutParams,
  type ScoutGrade,
  type Badge,
  type RegistryPluginRow,
} from './domain.ts';
export {
  SCOUT_ASSESSMENT_BUSINESS_PREFIX,
  SCOUT_RUN_BUSINESS_PREFIX,
  SCOUT_PARAMS_BUSINESS_ID,
  scoutAssessmentPayload,
  scoutRunPayload,
  scoutParamsPayload,
} from './events.ts';
export {
  createPluginScoutService,
  type PluginScoutService,
  type ScoutDeps,
  type ScoutRegistrySeam,
  type ScoutSmokeSeam,
  type ScoutNarrator,
  type ScoutPipe,
  type ScoutReport,
} from './service.ts';
export { registerScoutInvariants, scoutInvariantChecks, type ScoutInvariantOptions } from './loadChecks.ts';

export interface TdaScoutHandle {
  readonly service: PluginScoutService;
  readonly domain: TdaDomain<ScoutTables>;
  dispose(): Promise<void>;
}

export interface TdaScoutPlugin {
  readonly name: string;
  apply(ctx: {
    readonly storage: TdaStorageBackend;
    readonly invariants: TdaInvariantRegistry;
    readonly session: TdaSessionSink;
    readonly deps: Omit<ScoutDeps, 'domain' | 'session'>;
  }): Promise<TdaScoutHandle>;
}

export const tdaPluginScoutPlugin: TdaScoutPlugin = {
  name: 'tda-plugin-scout',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(scoutDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createPluginScoutService({
      ...ctx.deps,
      domain,
      session: ctx.session,
      reconciler,
      index,
    });
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerScoutInvariants(ctx.invariants, domain, { service });
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
