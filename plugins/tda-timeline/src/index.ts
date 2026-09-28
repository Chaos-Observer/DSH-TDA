/**
 * tda-timeline 插件出口（六文件模板汇聚点：domain/events/service/fts/loadChecks/index）。
 *
 * IT0/IT1 形态：框架无关——TdaPluginContext 是 Cordis ctx 的结构镜像
 * （storage / invariants / session 三槽，均来自内核接口）。
 * IT1 接 DSH 时仅此文件把 TdaPluginContext 换成真实 Cordis ctx，
 * domain/service/fts/loadChecks 零改动（决策点③可逆性）。
 *
 * T0.3 出口面：ctx.timeline（服务）+ domain（IT1 出口对账：后续插件经
 * TdaDomain 只读引用时间线；T0.4 上下文换页的底层基底）。
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
import { timelineDomainSpec, type TimelineTables } from './domain.ts';
import { createTimelineService, type TimelineService } from './service.ts';
import { registerTimelineInvariants } from './loadChecks.ts';

export {
  timelineDomainSpec,
  TimelineEntrySchema,
  WriterRefSchema,
  TIMELINE_KINDS,
  TIMELINE_CHUNK_TYPES,
  TIMELINE_SOURCES,
  TIMELINE_CREDENTIALS,
  TIMELINE_WRITERS,
  CREDENTIAL_RANK,
  QUARANTINE_CREDENTIALS,
  type TimelineTables,
  type TimelineEntry,
  type TimelineKind,
  type TimelineChunkType,
  type TimelineSource,
  type TimelineCredential,
  type TimelineWriter,
  type WriterRef,
} from './domain.ts';
export { timelineWritePayload, type TimelineWriteEventPayload } from './events.ts';
export {
  createTimelineService,
  type TimelineService,
  type TimelineServiceDeps,
  type TimelineChunk,
  type TimelineFilter,
  type TimelineTimeRange,
  type TimelineQuery,
  type TimelineHit,
} from './service.ts';
export { registerTimelineInvariants, timelineInvariantChecks } from './loadChecks.ts';
export { createBm25Index, tokenize, type TimelineTextIndex } from './fts.ts';

/** Cordis ctx 的结构镜像（IT1 起替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
}

export interface TdaTimelineHandle {
  readonly service: TimelineService;
  readonly domain: TdaDomain<TimelineTables>;
  dispose(): Promise<void>;
}

export interface TdaTimelinePlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaTimelineHandle>;
}

export const tdaTimelinePlugin: TdaTimelinePlugin = {
  name: 'tda-timeline',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(timelineDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    // 两级不变量：内核级（@tda/kernel，双写配对）+ 插件级（tda-timeline，三查）
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerTimelineInvariants(ctx.invariants, domain);
    const service = createTimelineService({ domain, session: ctx.session, reconciler, index });
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
