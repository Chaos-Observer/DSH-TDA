/**
 * tda-context 插件出口（八文件模板：domain/events/budget/gate/pages/surface/service/loadChecks/index）。
 *
 * IT3 形态：框架无关——TdaPluginContext 是 Cordis ctx 的结构镜像
 * （storage / invariants / session 三槽 + 可选 surface / goalSeam / taskSeam / timeline / bus）。
 * 接 DSH 时仅此文件把 TdaPluginContext 换成真实 ctx（surface 换成
 * `ctx.compaction` 适配），其余零改动（决策点③可逆性）。
 *
 * T0.4 出口面：ctx.context（服务）+ domain（钉扎定义）+ 默认 C6 四类钉扎种子。
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
import { PIN_KINDS, contextDomainSpec, type ContextTables, type PinEntry, type PinSourceKind } from './domain.ts';
import { registerContextInvariants } from './loadChecks.ts';
import {
  createContextService,
  type ContextConfig,
  type ContextDeps,
  type ContextGoalSeam,
  type ContextService,
  type ContextTaskSeam,
  type ContextTimelineSeam,
  type SegmentScorer,
} from './service.ts';
import { createMemorySurface, type ContextSurfaceSeam } from './surface.ts';
import type { LogprobsSample } from './gate.ts';

export {
  contextDomainSpec,
  PinEntrySchema,
  PIN_KINDS,
  PIN_SOURCE_KINDS,
  SEGMENT_KINDS,
  SHADOW_REASONS,
  type ContextTables,
  type PinEntry,
  type PinKind,
  type PinSourceKind,
  type SegmentKind,
  type ShadowReason,
  type AssembleRecord,
} from './domain.ts';
export { assemblePayload, pinPayload } from './events.ts';
export {
  DEFAULT_ALLOCATION,
  DEPRIVATION_ORDER,
  assertAllocation,
  defaultTokenMeter,
  planBudget,
  type BudgetAllocation,
  type BudgetPlan,
} from './budget.ts';
export {
  SENTINEL_LOGPROB,
  STATIC_PRIORITY,
  filterSentinels,
  perplexityScores,
  staticScores,
  selectDrops,
  runGate,
  type GateDecision,
  type LogprobsSample,
  type LogprobsToken,
  type ScorableSegment,
} from './gate.ts';
export { createPageTable, pageIdOf, type PageRecord, type PageTable, type PageLabel, type PageSeed } from './pages.ts';
export { createMemorySurface, type ContextSurfaceSeam, type SurfaceMessage, type ShadowEntry, type PressureSignal } from './surface.ts';
export {
  createContextService,
  PIN_KIND_ORDER,
  type ContextService,
  type ContextDeps,
  type ContextConfig,
  type ContextGoalSeam,
  type ContextGoalFocusView,
  type ContextTaskSeam,
  type ContextTaskFocusView,
  type ContextTimelineSeam,
  type SegmentScorer,
  type AssembledContext,
  type AssembledSegment,
  type PinInput,
  type ContextSection,
} from './service.ts';
export {
  registerContextInvariants,
  contextInvariantChecks,
  contextStaticChecks,
  type ContextInvariantOptions,
} from './loadChecks.ts';

/** C6 四类的默认钉扎种子（`sourceRef='focus'` 表示"随焦点目标"）。 */
export const DEFAULT_PIN_SEEDS: readonly {
  readonly kind: (typeof PIN_KINDS)[number];
  readonly sourceKind: PinSourceKind;
  readonly sourceRef: string;
  readonly maxTokens: number;
}[] = [
  { kind: 'goal', sourceKind: 'goalTree.focus', sourceRef: 'focus', maxTokens: 120 },
  { kind: 'criteria', sourceKind: 'goalTree.focus', sourceRef: 'focus', maxTokens: 256 },
  { kind: 'constraint', sourceKind: 'constraint_snapshots', sourceRef: 'focus', maxTokens: 256 },
  { kind: 'safety', sourceKind: 'config.safety', sourceRef: 'config', maxTokens: 256 },
];

/** Cordis ctx 的结构镜像（接 DSH 时替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  readonly session: TdaSessionSink;
  /** 会话 surface seam（DSH compaction 结构镜像）；缺省用内存参考实现。 */
  readonly surface?: ContextSurfaceSeam;
  readonly goalSeam?: ContextGoalSeam;
  readonly taskSeam?: ContextTaskSeam;
  readonly timeline?: ContextTimelineSeam;
  readonly decisions?: () => readonly string[];
  readonly injection?: () => readonly { readonly id: string; readonly text: string }[];
  readonly config?: ContextConfig;
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  /** 是否播种 C6 四类默认钉扎（缺省 true）。 */
  readonly seedPins?: boolean;
}

export interface TdaContextHandle {
  readonly service: ContextService;
  readonly domain: TdaDomain<ContextTables>;
  dispose(): Promise<void>;
}

export interface TdaContextPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaContextHandle>;
}

export const tdaContextPlugin: TdaContextPlugin = {
  name: 'tda-context',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const index = createAuditIndex();
    const domain = await openTdaDomain(contextDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const deps: ContextDeps = {
      domain,
      session: ctx.session,
      surface: ctx.surface ?? createMemorySurface(),
      reconciler,
      index,
      ...(ctx.goalSeam !== undefined ? { goalSeam: ctx.goalSeam } : {}),
      ...(ctx.taskSeam !== undefined ? { taskSeam: ctx.taskSeam } : {}),
      ...(ctx.timeline !== undefined ? { timeline: ctx.timeline } : {}),
      ...(ctx.decisions !== undefined ? { decisions: ctx.decisions } : {}),
      ...(ctx.injection !== undefined ? { injection: ctx.injection } : {}),
      ...(ctx.config !== undefined ? { config: ctx.config } : {}),
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    };
    const service = createContextService(deps);
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerContextInvariants(ctx.invariants, domain, {
      ...(ctx.config?.allocation !== undefined ? { allocation: ctx.config.allocation } : {}),
    });
    // 播种 C6 四类（幂等：已存在的 kind 不重复建）
    if (ctx.seedPins ?? true) {
      const existing = new Set(service.pins().map((entry) => entry.kind));
      for (const seed of DEFAULT_PIN_SEEDS) {
        if (existing.has(seed.kind)) continue;
        await service.pin('scheduler', {
          kind: seed.kind,
          sourceKind: seed.sourceKind,
          sourceRef: seed.sourceRef,
          maxTokens: seed.maxTokens,
        });
      }
    }
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

export type { PinEntry as ContextPinEntry, SegmentScorer as ContextSegmentScorer, LogprobsSample as ContextLogprobsSample };
