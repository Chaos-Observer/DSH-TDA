/**
 * tda-context 域定义（T0.4 §3.3 存储落点）。
 *
 * 本插件只有**一张**表：`context_pins`（C6 钉扎项定义）。
 * 其余数据按规格各有落点，刻意不进 domain：
 *  - PageTable：进程内 + 启动从时间线/taskPool 重建（page 是视图不是权威）；
 *  - AssembleRecord：log-only 事件 + T0.3 时间线（J8 双写），域内不存；
 *  - gate 配置：插件 Config（cordis.yml 可覆盖）。
 *
 * 相对规格 §3.1 的一处必要偏差：`PinEntry.render` 是**函数**，不能落盘。
 * 故域里存**定义**（kind/sourceKind/sourceRef/maxTokens），渲染器按 sourceKind
 * 在代码侧注册（`renderers.ts`）——"渲染规则引用"入库、"渲染实现"留在代码，
 * 与 §3.3"内容不存、只存渲染规则引用"的原意一致且可持久化。
 *
 * invalidRecords 缺省 reject：钉扎定义是 C6 硬条款的输入，损坏必须响
 * （映射表 T0.4 行：reject（定义）/ 记录不落 domain）。
 */
import { asPinId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

/** C6 明文四类。 */
export const PIN_KINDS = ['goal', 'criteria', 'constraint', 'safety'] as const;
export type PinKind = (typeof PIN_KINDS)[number];

/** 渲染数据源（J2：每轮从 domain 重渲染，不存正文快照）。 */
export const PIN_SOURCE_KINDS = [
  'goalTree.focus',
  'constraint_snapshots',
  'taskPool.focus',
  'config.safety',
] as const;
export type PinSourceKind = (typeof PIN_SOURCE_KINDS)[number];

export const PinEntrySchema = z
  .object({
    id: z.string().transform(asPinId),
    /** 钉扎定义是可变更配置（沿用全仓 CAS 纪律：更新/删除可带 expectedRevision）。 */
    revision: z.number(),
    kind: z.enum(PIN_KINDS),
    sourceKind: z.enum(PIN_SOURCE_KINDS),
    /** goalId / taskId / 配置键（依 sourceKind 解释）。 */
    sourceRef: z.string(),
    /** 单项帽（超帽 = 渲染器 bug，渲染即拒——见 service）。 */
    maxTokens: z.number(),
    enabled: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .superRefine((pin, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (pin.maxTokens < 1) issue(`maxTokens 须 ≥1（收到 ${pin.maxTokens}）——零帽会让钉扎永远渲染不出内容`);
    if (pin.sourceRef === '') issue('sourceRef 不得为空（渲染数据源的键）');
    // 源与类的对应律：结构上禁掉"目标类钉扎却读安全配置"这类错配
    const allowed: Record<PinSourceKind, readonly PinKind[]> = {
      'goalTree.focus': ['goal', 'criteria'],
      'constraint_snapshots': ['constraint'],
      'taskPool.focus': ['goal', 'criteria'],
      'config.safety': ['safety'],
    };
    if (!allowed[pin.sourceKind].includes(pin.kind)) {
      issue(`sourceKind=${pin.sourceKind} 不支持 kind=${pin.kind}（允许：${allowed[pin.sourceKind].join('/')}）`);
    }
  });
export type PinEntry = z.infer<typeof PinEntrySchema>;

export type ContextTables = {
  context_pins: typeof PinEntrySchema;
};

export const contextDomainSpec = defineTdaDomain({
  name: 'tda-context',
  version: 1,
  tables: {
    context_pins: PinEntrySchema,
  },
  layout: 'single',
});

/** 段种类（J4 排序：system → pinned → memo → history → injection）。 */
export const SEGMENT_KINDS = ['system', 'pinned', 'memo', 'history', 'injection'] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/** 遮蔽原因（§2：双档 + gate + 换页折叠）。 */
export const SHADOW_REASONS = [
  'pressure',
  'context-overflow',
  'gate-perplexity',
  'gate-static',
  'page-fold',
] as const;
export type ShadowReason = (typeof SHADOW_REASONS)[number];

/** 组装审计记录（append-only；双写 session event + T0.3 时间线）。 */
export interface AssembleRecord {
  readonly sessionId: string;
  readonly round: number;
  readonly segments: readonly { readonly kind: SegmentKind; readonly ref?: string; readonly tokenEstimate: number }[];
  readonly shadowed: { readonly seqs: readonly number[]; readonly reason: ShadowReason };
  readonly budget: {
    readonly pinnedPct: number;
    readonly memoPct: number;
    readonly historyPct: number;
    readonly injectionPct: number;
    /** 必要超集：pinned 溢出（C6 豁免导致）不得被静默掩盖，须可审计。 */
    readonly overrun?: readonly string[];
  };
  readonly gate?: {
    readonly mode: 'perplexity' | 'static';
    readonly sampledTokens?: number;
    readonly droppedSegmentIds: readonly string[];
    readonly fallbackReason?: string;
  };
  readonly at: number;
}
