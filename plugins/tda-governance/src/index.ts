/**
 * tda-governance 插件出口（六文件模板：domain/events/projection/service/loadChecks/index）。
 *
 * **权威分级闸**（本插件特有，见 domain.ts 文件头）：内核的 `invalidRecords` 是
 * 域级开关，而本插件需要"`gov_actions` 拒绝 / 投影与水位跳过"的表级分级。
 * 取法：域级 `backup-and-skip`（开域不阻断）+ `onInvalidRecord` 收集 →
 * 若其中出现 `gov_actions` 的损坏记录，则关域并抛 `GOV_AUTHORITY_CORRUPTED`
 * （fail-loud）。这样表级语义到手，内核契约零改动。
 *
 * 启动序（内核纪律 #7）：`await service.initialize()`（补水位单行）**先于**
 * 不变量注册——否则从未扫过的运行会带着空 scan_state 过不了自己的门。
 * dispose 序：关域（无订阅手柄——治理由宿主周期驱动，不订阅事件）。
 */
import {
  createAuditIndex,
  createDualWriteReconciler,
  openTdaDomain,
  registerTdaInvariants,
  TdaError,
  type TdaDomain,
  type TdaEventBus,
  type TdaInvariantRegistry,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { governanceDomainSpec, type GovTables } from './domain.ts';
import {
  createGovernanceService,
  type GovConfig,
  type GovRecallSeam,
  type GovernanceService,
  type GovTaskSeam,
  type GovTimelineSeam,
} from './service.ts';
import { registerGovernanceInvariants } from './loadChecks.ts';

export {
  governanceDomainSpec,
  GovActionSchema,
  MemoryGovStateSchema,
  GovScanStateSchema,
  VerifyEvidenceSchema,
  GovReasonSchema,
  GOV_ACTIONS,
  GOV_ASSET_KINDS,
  GOV_RETIRE_KINDS,
  GOV_WRITERS,
  GOV_CREDENTIALS,
  MEMORY_LIFECYCLES,
  CREDENTIAL_RANK,
  CONSOLIDATE_MIN_CREDENTIAL,
  APPROVAL_REQUIRED,
  GOV_SCAN_STATE_KEY,
  GOV_ACTION_PREFIX,
  govStateKey,
  type GovTables,
  type GovAction,
  type GovActionKind,
  type GovAssetKind,
  type GovReason,
  type GovRetireKind,
  type GovScanState,
  type GovWriter,
  type GovWriterRef,
  type GovCredential,
  type MemoryGovState,
  type MemoryLifecycle,
  type VerifyEvidence,
  type GovConflict,
} from './domain.ts';
export { govActionPayload } from './events.ts';
export {
  projectStates,
  applyAction,
  governanceScore,
  capacityZone,
  isUnusedTooLong,
  DEFAULT_GOVERNANCE_WEIGHTS,
  type GovernanceWeights,
  type ProjectionDeps,
  type UsageSnapshot,
} from './projection.ts';
export {
  createGovernanceService,
  type GovernanceService,
  type GovDeps,
  type GovConfig,
  type GovCaller,
  type GovScanReport,
  type GovRetireOptions,
  type CapacityReport,
  type RankRow,
  type GovTimelineSeam,
  type GovTimelineEntry,
  type GovTimelineChunk,
  type GovRecallSeam,
  type GovRecallLogRow,
  type GovTaskSeam,
  type GovTaskView,
} from './service.ts';
export {
  registerGovernanceInvariants,
  governanceInvariantChecks,
  type GovInvariantOptions,
  type GovReadFace,
} from './loadChecks.ts';

/** Cordis ctx 的结构镜像（接 DSH 时替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  /** 内容层权威（T0.3；**必填**——治理是它的旁路层）。 */
  readonly timeline: GovTimelineSeam;
  /** 复用信号源（T1.1）；未装配即"零复用"，容量与 unused-days 退化但机制不失效。 */
  readonly recall?: GovRecallSeam;
  /** 任务只读面（T0.2）；未装配则 promote 的证据校验缺"任务 success"一支（fail-loud 而非放行）。 */
  readonly task?: GovTaskSeam;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly tokenMeter?: (text: string) => number;
  readonly config?: GovConfig;
}

export interface TdaGovernanceHandle {
  readonly service: GovernanceService;
  readonly domain: TdaDomain<GovTables>;
  readonly boot: { readonly cursor: string; readonly cycleMs: number };
  dispose(): Promise<void>;
}

export interface TdaGovernancePlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaGovernanceHandle>;
}

export const tdaGovernancePlugin: TdaGovernancePlugin = {
  name: 'tda-governance',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const corrupt: string[] = [];
    const domain = await openTdaDomain(governanceDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
      onInvalidRecord: (info) => {
        if (info.table === 'gov_actions') corrupt.push(`${info.table}/${info.key}`);
      },
    });
    // 权威分级闸：治理权威损坏即拒绝启动（投影/水位损坏已在打开期跳过）
    if (corrupt.length > 0) {
      await domain.close();
      throw new TdaError(
        'GOV_AUTHORITY_CORRUPTED',
        `gov_actions 存在不可解析记录 [${corrupt.join(', ')}]——治理权威不可推断，拒绝启动`,
      );
    }
    const service = createGovernanceService({
      domain,
      session: ctx.session,
      timeline: ctx.timeline,
      reconciler,
      index,
      ...(ctx.recall !== undefined ? { recall: ctx.recall } : {}),
      ...(ctx.task !== undefined ? { task: ctx.task } : {}),
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.tokenMeter !== undefined ? { tokenMeter: ctx.tokenMeter } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
    });
    // 启动序：先建状态，再注册检查（纪律 #7）
    const scanState = await service.initialize();
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerGovernanceInvariants(ctx.invariants, domain, {
      service,
      timeline: ctx.timeline,
    });
    return {
      service,
      domain,
      boot: { cursor: scanState.cursor, cycleMs: scanState.cycleMs },
      async dispose() {
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
