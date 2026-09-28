/**
 * tda-recall 插件出口（七文件模板：domain/events/scoring/service/loadChecks/index）。
 *
 * 框架无关：`TdaPluginContext` 是 Cordis ctx 的结构镜像（storage / invariants /
 * session 三槽 + 可选 timeline / goal / task / governance / bus）。接 DSH 时仅此文件
 * 换真实 ctx，其余零改动（决策点③可逆性）。
 *
 * 启动序（内核纪律 #7）：`await service.initialize()`（补参数单行）**先于**
 * `registerRecallInvariants`——否则一个从未被召回的运行会带着空参数表过不了自己的门。
 * dispose 序：关域（无订阅手柄——recall 是纯被动拉取，不订阅任何事件）。
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
import { recallDomainSpec, type RecallTables } from './domain.ts';
import {
  createRecallService,
  type RecallConfig,
  type RecallGoalSeam,
  type RecallGovernanceSeam,
  type RecallHandleMeta,
  type RecallService,
  type RecallTaskSeam,
  type RecallTimelineSeam,
} from './service.ts';
import { registerRecallInvariants } from './loadChecks.ts';

export {
  recallDomainSpec,
  RecallParamsSchema,
  RecallLogSchema,
  RECALL_CHUNK_TYPES,
  RECALL_CREDENTIALS,
  GATE_BLOCKED_CREDENTIALS,
  RECALL_LOG_KINDS,
  RECALL_PARAMS_KEY,
  RECALL_LOG_PREFIX,
  DEFAULT_RECALL_PARAMS,
  type RecallTables,
  type RecallParams,
  type RecallLogRecord,
  type RecallLogKind,
  type RecallChunkType,
  type RecallCredential,
} from './domain.ts';
export { recallParamsPayload, RECALL_PARAMS_BUSINESS_ID } from './events.ts';
export {
  evaluateGate,
  taskRelevance,
  recencyScore,
  normalizeSemantic,
  composeScore,
  buildFocusQuery,
  renderInjectionText,
  type GateInput,
  type GateOutcome,
  type FocusContext,
  type ScoreParts,
} from './scoring.ts';
export {
  createRecallService,
  type RecallService,
  type RecallDeps,
  type RecallConfig,
  type RecallQuery,
  type ScoredChunk,
  type RecallLogFilter,
  type RecallHandleMeta,
  type RecallTimelineSeam,
  type RecallTimelineEntryView,
  type RecallTimelineHit,
  type RecallTimelineQuery,
  type RecallGoalSeam,
  type RecallGoalFocusView,
  type RecallTaskSeam,
  type RecallTaskFocusView,
  type RecallGovernanceSeam,
  type RecallLifecycle,
} from './service.ts';
export { registerRecallInvariants, recallInvariantChecks } from './loadChecks.ts';

/** Cordis ctx 的结构镜像（接 DSH 时替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  /** 检索基底（T0.3 timeline；**必填**——无它则无候选）。 */
  readonly timeline: RecallTimelineSeam;
  readonly goal?: RecallGoalSeam;
  readonly task?: RecallTaskSeam;
  readonly governance?: RecallGovernanceSeam;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly tokenMeter?: (text: string) => number;
  readonly config?: RecallConfig;
}

export interface TdaRecallHandle {
  readonly service: RecallService;
  readonly domain: TdaDomain<RecallTables>;
  /** 启动序产出（resume 证据面：本次是否补种参数单行）。 */
  readonly boot: RecallHandleMeta;
  dispose(): Promise<void>;
}

export interface TdaRecallPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaRecallHandle>;
}

export const tdaRecallPlugin: TdaRecallPlugin = {
  name: 'tda-recall',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(recallDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createRecallService({
      domain,
      session: ctx.session,
      timeline: ctx.timeline,
      reconciler,
      index,
      ...(ctx.goal !== undefined ? { goal: ctx.goal } : {}),
      ...(ctx.task !== undefined ? { task: ctx.task } : {}),
      ...(ctx.governance !== undefined ? { governance: ctx.governance } : {}),
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.tokenMeter !== undefined ? { tokenMeter: ctx.tokenMeter } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    });
    // 启动序：先建状态，再注册检查（纪律 #7）
    const boot = await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerRecallInvariants(ctx.invariants, domain);
    return {
      service,
      domain,
      boot,
      async dispose() {
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
