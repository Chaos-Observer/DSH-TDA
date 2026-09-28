/**
 * tda-meta-thinking 插件出口（六文件模板：domain/events/service/loadChecks/index）。
 *
 * **governance 与 executor 是必填 seam**（J1：治理单一；J5：fork 执行由装配层桥接）——
 * 缺任何一个即 fail-loud（元思维没有"无治理降级"形态，那等于再造一条治理管道）。
 * 启动序：`await service.initialize()`（校验治理 seam 就位）先于不变量注册。
 */
import {
  createAuditIndex,
  createDualWriteReconciler,
  openTdaDomain,
  registerTdaInvariants,
  type TdaDomain,
  type TdaEventBus,
  type TdaInvariantRegistry,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { metaThinkingDomainSpec, type MetaThinkingTables } from './domain.ts';
import {
  createMetaThinkingService,
  type MetaGovernanceSeam,
  type MetaThinkingConfig,
  type MetaThinkingService,
  type RehearsalExecutor,
} from './service.ts';
import { registerMetaThinkingInvariants } from './loadChecks.ts';

export {
  metaThinkingDomainSpec,
  MetaPathSchema,
  RehearsalRunSchema,
  REASONING_STEP_KINDS,
  EDGE_KINDS,
  META_MODES,
  META_SOURCE_KINDS,
  LABEL_MAX,
  META_PATH_PREFIX,
  REHEARSAL_PREFIX,
  type MetaThinkingTables,
  type MetaPath,
  type ReasoningStepKind,
  type EdgeKind,
  type MetaMode,
  type MetaSourceKind,
  type RehearsalRun,
} from './domain.ts';
export { metaPathPayload, rehearsalPayload, META_PATH_BUSINESS_PREFIX, REHEARSAL_BUSINESS_PREFIX } from './events.ts';
export {
  createMetaThinkingService,
  tokenToStep,
  TOKEN_TO_STEP,
  type MetaThinkingService,
  type MetaThinkingDeps,
  type MetaThinkingConfig,
  type MetaGovernanceSeam,
  type MetaLifecycle,
  type RehearsalExecutor,
  type MetaPathDraft,
} from './service.ts';
export {
  registerMetaThinkingInvariants,
  metaThinkingInvariantChecks,
  type MetaInvariantOptions,
} from './loadChecks.ts';

/** Cordis ctx 的结构镜像（接 DSH 时替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  /** 统一治理管道（T1.2，assetKind='meta-thinking' 分区；**必填**，J1）。 */
  readonly governance: MetaGovernanceSeam;
  /** rehearsal 执行桥（T0.7 fork + 派发；**必填**，J5）。 */
  readonly executor: RehearsalExecutor;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly tokenMeter?: (text: string) => number;
  readonly config?: MetaThinkingConfig;
}

export interface TdaMetaThinkingHandle {
  readonly service: MetaThinkingService;
  readonly domain: TdaDomain<MetaThinkingTables>;
  dispose(): Promise<void>;
}

export interface TdaMetaThinkingPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaMetaThinkingHandle>;
}

export const tdaMetaThinkingPlugin: TdaMetaThinkingPlugin = {
  name: 'tda-meta-thinking',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(metaThinkingDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createMetaThinkingService({
      domain,
      session: ctx.session,
      governance: ctx.governance,
      executor: ctx.executor,
      reconciler,
      index,
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.tokenMeter !== undefined ? { tokenMeter: ctx.tokenMeter } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    });
    // 启动序：先校验依赖就位，再注册检查（纪律 #7）
    await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerMetaThinkingInvariants(ctx.invariants, domain, {
      governance: ctx.governance,
      service,
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
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
