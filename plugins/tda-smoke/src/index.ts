/**
 * tda-smoke 插件出口（六文件模板汇聚点：domain/events/service/loadChecks/index）。
 *
 * IT0 形态：框架无关——TdaPluginContext 是 Cordis ctx 的结构镜像
 * （storage / invariants / session 三槽，均来自内核接口）。
 * IT1 接 DSH 时仅此文件把 TdaPluginContext 换成真实 Cordis ctx，
 * domain/service/loadChecks 零改动（决策点③可逆性）。
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
import { smokeDomainSpec, type SmokeTables } from './domain.ts';
import { createSmokeService, type SmokeService } from './service.ts';
import { registerSmokeInvariants } from './loadChecks.ts';

export { smokeDomainSpec, SmokeGoalSchema, type SmokeTables } from './domain.ts';
export { goalChangePayload, type SmokeGoalEventPayload } from './events.ts';
export { createSmokeService, type SmokeService, type SmokeServiceDeps } from './service.ts';
export { registerSmokeInvariants, smokeInvariantChecks } from './loadChecks.ts';

/** Cordis ctx 的结构镜像（IT1 起替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
}

export interface TdaSmokeHandle {
  readonly service: SmokeService;
  readonly domain: TdaDomain<SmokeTables>;
  dispose(): Promise<void>;
}

export interface TdaSmokePlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaSmokeHandle>;
}

export const tdaSmokePlugin: TdaSmokePlugin = {
  name: 'tda-smoke',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(smokeDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    // 两级不变量：内核级（@tda/kernel，双写配对）+ 插件级（tda-smoke，记录形态）
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerSmokeInvariants(ctx.invariants, domain);
    const service = createSmokeService({ domain, session: ctx.session, reconciler, index });
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
