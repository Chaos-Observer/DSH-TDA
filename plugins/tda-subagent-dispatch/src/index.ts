/**
 * tda-subagent-dispatch 插件出口（七文件模板：domain/events/schema/policy/service/tools/loadChecks/index）。
 *
 * IT3 形态：框架无关——TdaPluginContext 是 Cordis ctx 的结构镜像
 * （storage / invariants / session 三槽 + 可选 bus / taskPool / timeline / provider 槽）。
 * 接 DSH 时仅此文件把 TdaPluginContext 换成真实 ctx 并把 provider 换成
 * `ctx.subagents` 适配，domain/service/loadChecks/tools 零改动（决策点③可逆性）。
 *
 * T0.5 出口面：ctx.subagentDispatch（服务）+ domain + provider seam + 工具集定义。
 * 启动序：开域 → reconcileOrphans（在途单显式终态，C5）→ 注册两级不变量。
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
import { dispatchDomainSpec, type DispatchTables } from './domain.ts';
import {
  createSubagentDispatchService,
  type DispatchTaskPoolSeam,
  type DispatchTimelineSeam,
  type SubagentDispatchService,
  type SubagentProvider,
} from './service.ts';
import { registerDispatchInvariants } from './loadChecks.ts';
import { createDispatchTools, type DispatchToolDefinition } from './tools.ts';

export {
  dispatchDomainSpec,
  DispatchOrderSchema,
  DispatchResultSchema,
  RolePolicySchema,
  ApprovalSchema,
  AgentOptionsSchema,
  DISPATCH_ROLES,
  DISPATCH_STATUSES,
  DISPATCH_TERMINAL,
  DISPATCH_OUTCOMES,
  DISPATCH_RISKS,
  DISPATCH_SANDBOXES,
  DISPATCH_OPERATIONS,
  DISPATCH_SCHEMA_IDS,
  ROLE_SCHEMAS,
  defaultSchemaOf,
  DISPATCH_ACTORS,
  KNOWN_STOP_REASONS,
  ZERO_DISPATCH_CONSUMED,
  type DispatchTables,
  type DispatchOrder,
  type DispatchResult,
  type DispatchRole,
  type DispatchStatus,
  type DispatchOutcome,
  type DispatchRisk,
  type DispatchSandbox,
  type DispatchOperation,
  type DispatchSchemaId,
  type DispatchActor,
  type DispatchApproval,
  type DispatchConsumed,
  type RolePolicy,
  type AgentOptions,
} from './domain.ts';
export { dispatchChangePayload, dispatchPolicyPayload } from './events.ts';
export {
  SIDEKICK_CONCLUSION_SCHEMA,
  LEAD_CONCLUSION_SCHEMA,
  SIDEKICK_WORKSPACE_ANNOTATION_SCHEMA,
  CONCLUSION_SCHEMAS,
  FORBIDDEN_SCHEMA_FIELDS,
  schemaFieldNames,
  assertConclusionSchema,
  validateConclusion,
  conclusionView,
  type ObjectJsonSchema,
  type JsonSchemaNode,
  type ConclusionView,
  type ConclusionValidation,
} from './schema.ts';
export {
  defaultRolePolicies,
  assessRisk,
  assertToolFilterSafe,
  renderPersona,
  FORBIDDEN_SUBAGENT_TOOLS,
  PERSONA_TEMPLATES,
  PERSONA_VARIABLES,
  DEFAULT_SIDEKICK_TOOLS,
  DEFAULT_LEAD_TOOLS,
  type DispatchTaskView,
  type RiskAssessment,
} from './policy.ts';
export {
  createSubagentDispatchService,
  extractSummary,
  hashBrief,
  mapStopReason,
  sanitizeDiagnostic,
  type SubagentDispatchService,
  type SubagentDispatchDeps,
  type DispatchCaller,
  type DispatchRef,
  type DispatchRequest,
  type DispatchFilter,
  type DispatchOrderView,
  type DispatchStartResult,
  type DispatchBrief,
  type ContentBlock,
  type SubagentProvider,
  type SubagentCapabilities,
  type SubagentRun,
  type SubagentResultLike,
  type SubagentStartRequest,
  type SubagentUsage,
  type DispatchTaskPoolSeam,
  type DispatchTimelineSeam,
} from './service.ts';
export {
  createScriptedProvider,
  createFixedProvider,
  FULL_CAPABILITIES,
  type ScriptedProvider,
  type ScriptedProviderSpec,
} from './provider.ts';
/**
 * P5.3 DSH StreamChunk 换真适配（真实通道）+ scripted stream face（测试注入面）。
 */
export {
  createDshStreamProvider,
  createScriptedStreamFace,
  extractJsonObject,
  structuredFromBlocks,
  mapFinishToStopReason,
  type DshStreamFace,
  type DshStreamProvider,
  type DshStreamProviderOptions,
  type ScriptedStreamFaceSpec,
  type DshContentBlock,
  type DshFinishReason,
  type DshGenerateOptions,
  type DshStreamChunk,
  type DshTokenUsage,
} from './dshStreamProvider.ts';
export {
  createOpenAiCompatStreamFace,
  type OpenAiCompatFaceOptions,
} from './openAiCompatFace.ts';
export {
  createDispatchTools,
  DISPATCH_TOOL_NAMES,
  type DispatchToolDefinition,
  type DispatchToolCallContext,
  type DispatchToolName,
} from './tools.ts';
export {
  registerDispatchInvariants,
  dispatchInvariantChecks,
  type DispatchInvariantOptions,
} from './loadChecks.ts';

/** Cordis ctx 的结构镜像（接 DSH 时替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  /** 执行通道 seam（DSH `ctx.subagents` 派发侧切片）；缺省用本地参考 provider。 */
  readonly subagents?: SubagentProvider;
  /** 事件分发面（未装配则不发事件，插件仍自洽）。 */
  readonly bus?: TdaEventBus;
  /** 任务池 seam（ctx.taskPool 子集）。 */
  readonly taskPool?: DispatchTaskPoolSeam;
  /** 时间线 seam（ctx.timeline 子集，J5 结论落点①）。 */
  readonly timeline?: DispatchTimelineSeam;
  /** 可注入时钟（测试确定性）。 */
  readonly now?: () => number;
  /** 全局在飞帽（J10 默认 3）。 */
  readonly maxParallel?: number;
}

export interface TdaDispatchHandle {
  readonly service: SubagentDispatchService;
  readonly domain: TdaDomain<DispatchTables>;
  readonly provider: SubagentProvider;
  readonly tools: readonly DispatchToolDefinition[];
  /** 本次启动收口的孤儿单 id（宿主重启时在途的派发；IT4 resume 证据）。 */
  readonly orphanedAtBoot: readonly string[];
  dispose(): Promise<void>;
}

export interface TdaDispatchPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaDispatchHandle>;
}

export const tdaSubagentDispatchPlugin: TdaDispatchPlugin = {
  name: 'tda-subagent-dispatch',
  async apply(ctx) {
    const bootAt = ctx.now?.() ?? Date.now();
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(dispatchDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    if (ctx.subagents === undefined) {
      throw new Error('tda-subagent-dispatch 需要注入 subagents seam（DSH ctx.subagents 或本地参考 provider）');
    }
    const service = createSubagentDispatchService({
      domain,
      session: ctx.session,
      provider: ctx.subagents,
      reconciler,
      index,
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.taskPool !== undefined ? { taskPool: ctx.taskPool } : {}),
      ...(ctx.timeline !== undefined ? { timeline: ctx.timeline } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.maxParallel !== undefined ? { maxParallel: ctx.maxParallel } : {}),
    });
    // 启动序（在注册不变量之前）：策略种子 + 孤儿单收口（在途 run 随宿主重启
    // 失联 → 显式终态，C5）。加载期不变量依赖的状态必须在此建立。
    const orphanedAtBoot = await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerDispatchInvariants(ctx.invariants, domain, {
      bootAt: bootAt,
      ...(ctx.taskPool !== undefined
        ? { taskExists: (taskId: string): boolean => ctx.taskPool?.get(taskId) !== undefined }
        : {}),
    });
    return {
      service,
      domain,
      provider: ctx.subagents,
      tools: createDispatchTools(service),
      orphanedAtBoot,
      async dispose() {
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
