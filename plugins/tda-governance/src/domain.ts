/**
 * tda-governance 域定义（T1.2 §3.3 存储落点）。
 *
 * 三表，**权威分级**（不是一刀切）：
 *  - `gov_actions`（键 `gov-<n>`，append-only）：**治理权威**——一切状态迁移/
 *    提议/审批/裁决的唯一记录，丢了不可推断 → 损坏必须**拒绝开域**；
 *  - `memory_gov_states`（键 `memory#<EntryId>`）：gov_actions 的**投影缓存**
 *    （可重放重建）→ 损坏可跳过；
 *  - `gov_scan_state`（键 `'singleton'`）：扫描水位 + 吞吐帽 → 损坏可跳过。
 *
 * 内核的 `invalidRecords` 是**域级**开关（'reject' | 'backup-and-skip'），无法
 * 表级分级；故本插件取 `backup-and-skip` + 在 `apply` 里做**权威分级闸**：
 * 若 `onInvalidRecord` 报告了 `gov_actions` 的损坏记录，则关域并抛
 * `GOV_AUTHORITY_CORRUPTED`（fail-loud）。这样既拿到表级分级的语义，
 * 又不改动内核契约（决策点③可逆）。
 *
 * 治理是**旁路层**（J2）：本域不复制时间线内容，只存"状态投影 + 动作日志"；
 * `reuseCount`/`lastUsedAt` 从 T1.1 recall_log 只读聚合（扫时刷新），
 * `credential` 从 T0.3 只读镜像——内容本体永不出现在这里。
 *
 * P1 只实例化 `assetKind='memory'`（J1）；schema 预埋 kind 维度，
 * T2.2 技能生命周期作为同服务第二实例扩展，**不新立服务**。
 */
import { asGovActionId, defineTdaDomain, type EntryId } from '@tda/kernel';
import { z } from 'zod';

/** 资产类型：P1 唯一；T2.2 起扩展 'skill'，T1.4 用 'meta-thinking'。 */
export const GOV_ASSET_KINDS = ['memory', 'meta-thinking', 'skill', 'workflow', 'knowledge'] as const;
export type GovAssetKind = (typeof GOV_ASSET_KINDS)[number];

/** §3.6 主生命周期的记忆口径（J6）：retired 是软状态可恢复。 */
export const MEMORY_LIFECYCLES = ['draft', 'validating', 'consolidated', 'retired'] as const;
export type MemoryLifecycle = (typeof MEMORY_LIFECYCLES)[number];

/** 退役触发四信号（J7）+ conflict（T1.4 的 `rehearsal-fail` 归 T2.2 扩展）。 */
export const GOV_RETIRE_KINDS = [
  'superseded',
  'unused-days',
  'capacity',
  'conflict',
  'manual',
  /** T1.4 元思维专用：rehearsal 是受控实验，连续证伪 = 直接证据（非弱归因）。 */
  'rehearsal-fail',
  /** T2.2 技能专用：连续真实复用失败（一次 success 清零，滞回防误杀）。 */
  'use-fail',
] as const;
export type GovRetireKind = (typeof GOV_RETIRE_KINDS)[number];

export const GOV_ACTIONS = [
  'propose',
  'approve',
  'promote',
  'consolidate',
  'retire',
  'restore',
  'flag-conflict',
  'propose-invalidate',
] as const;
export type GovActionKind = (typeof GOV_ACTIONS)[number];

/** 需要人类审批的动作（J12 高风险）：容量强制淘汰、遗忘。 */
export const APPROVAL_REQUIRED: readonly GovActionKind[] = ['propose-invalidate'];

/** 迁移类动作：它们的 reason 语义是"为什么迁移"，不得挂退役信号（防误归因）。 */
export const MIGRATION_ACTIONS: readonly GovActionKind[] = ['promote', 'consolidate', 'restore', 'approve'];

export const GOV_WRITERS = ['agent', 'human', 'coach', 'scheduler'] as const;
export type GovWriter = (typeof GOV_WRITERS)[number];

/** 写入方归因（结构镜像 T0.3 WriterRef；跨插件零 import）。 */
export const GovWriterRefSchema = z.object({
  sessionId: z.string(),
  actor: z.enum(GOV_WRITERS),
  at: z.number(),
});
export type GovWriterRef = z.infer<typeof GovWriterRefSchema>;

/** 凭证五级只读镜像（T0.3；治理侧的容量排名与固化阀用）。 */
export const GOV_CREDENTIALS = [
  'user-original',
  'execution-verified',
  'model-produced',
  'tool-output',
  'external-content',
] as const;
export type GovCredential = (typeof GOV_CREDENTIALS)[number];

/** 凭证秩（结构镜像 T0.3 CREDENTIAL_RANK）。 */
export const CREDENTIAL_RANK: Record<GovCredential, number> = {
  'user-original': 4,
  'execution-verified': 3,
  'model-produced': 2,
  'tool-output': 1,
  'external-content': 0,
};

/** 固化阀要求的最低凭证（J5 条件 ②）。 */
export const CONSOLIDATE_MIN_CREDENTIAL: GovCredential = 'execution-verified';

/**
 * 外部验证证据链（J5 条件 ①）。
 * 口径（U1）：任务 `complete(success)` ∧ 该 chunk 在该任务执行期被 recall_log 记 injected。
 * 证据**不含 chunk 正文**（J2：治理不复制内容）。
 */
export const VerifyEvidenceSchema = z.object({
  taskId: z.string(),
  runIndex: z.number(),
  taskOutcome: z.literal('success'),
  injectedAt: z.number(),
  checkedAt: z.number(),
});
export type VerifyEvidence = z.infer<typeof VerifyEvidenceSchema>;

/** 退役/其它动作理由（可解释性：不变量 5 要求容量淘汰带排名明细）。 */
export const GovReasonSchema = z.object({
  kind: z.enum([...GOV_RETIRE_KINDS, 'verify-pass', 'verify-fail', 'dup', 'conflict', 'manual'] as const),
  detail: z.string(),
});
export type GovReason = z.infer<typeof GovReasonSchema>;

export const GovActionSchema = z
  .object({
    id: z.string().transform(asGovActionId),
    assetKind: z.enum(GOV_ASSET_KINDS),
    assetId: z.string(),
    action: z.enum(GOV_ACTIONS),
    from: z.enum(MEMORY_LIFECYCLES).optional(),
    to: z.enum(MEMORY_LIFECYCLES).optional(),
    reason: GovReasonSchema.optional(),
    evidence: VerifyEvidenceSchema.optional(),
    actor: GovWriterRefSchema,
    /** J12：人类审批一次性 token（**只用不存全文**——这里存引用/凭据本身，见 service 注释）。 */
    approvalToken: z.string().optional(),
    /** 容量淘汰的治理分排名快照（不变量 5 的可解释证据）。 */
    ranking: z
      .array(z.object({ assetId: z.string(), score: z.number(), reuseCount: z.number(), credentialRank: z.number() }))
      .optional(),
    /** 转正是**新条目**时，指向被取代的原隔离条目（不变量 3 的对账锚点，J4）。 */
    promotedFrom: z.string().optional(),
    /** flag-conflict 的分叉对象（J9：证据回链，裁决留给显式动作）。 */
    conflictWith: z.array(z.string()).optional(),
    /** near-duplicate 标记（U4：只标不并，合并语义归 T2.3）。 */
    dupOf: z.string().optional(),
    at: z.number(),
  })
  .superRefine((action, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (action.actor.at !== action.at) {
      issue(`actor.at=${action.actor.at} 与 at=${action.at} 不符（归因时刻必须同轴）`);
    }
    // 迁移类动作的 from/to 恒等律
    const expected: Partial<Record<GovActionKind, readonly [readonly MemoryLifecycle[], MemoryLifecycle]>> = {
      promote: [['draft', 'validating'], 'validating'],
      // from 允许 draft：元思维（T1.4）的通过 rehearsal 本身就是晋升证据，可从 draft 直固
      consolidate: [['draft', 'validating'], 'consolidated'],
      restore: [['retired'], 'consolidated'],
    };
    const pair = expected[action.action];
    if (pair !== undefined) {
      if (action.from === undefined || !pair[0].includes(action.from) || action.to !== pair[1]) {
        issue(
          `动作 ${action.action} 的 from/to 必须是 ${pair[0].join('|')}→${pair[1]}（收到 ${String(action.from)}→${String(action.to)}）`,
        );
      }
    }
    if (action.action === 'retire') {
      if (action.reason === undefined) {
        issue('retire 必带 reason（退役可解释：四信号之一 + 明细）');
      } else if (!GOV_RETIRE_KINDS.includes(action.reason.kind as GovRetireKind)) {
        issue(`retire 的 reason.kind=${action.reason.kind} 不在四信号内`);
      }
      if (action.to !== 'retired') issue(`retire 的 to 必须是 retired（收到 ${String(action.to)}）`);
    }
    if (action.reason?.kind === 'capacity') {
      if (action.reason.detail.length === 0) {
        issue('capacity 治理必带排名明细（不变量 5：淘汰必须可解释）');
      }
      if (action.ranking === undefined || action.ranking.length === 0) {
        issue('capacity 治理必带 ranking 快照（当时候选集的 reuseCount/credential/recency 明细）');
      }
      if (action.action === 'retire' && (action.approvalToken === undefined || action.approvalToken === '')) {
        issue('capacity 强制淘汰属高风险动作，执行时必带人类审批 token（J12）');
      }
    } else if (
      action.reason !== undefined &&
      GOV_RETIRE_KINDS.includes(action.reason.kind as GovRetireKind) &&
      MIGRATION_ACTIONS.includes(action.action)
    ) {
      // 只有**迁移类**动作禁挂退役原因（它们的 reason 是 verify-pass/dup 之类）；
      // propose / retire / flag-conflict / propose-invalidate 携带退役信号是本义。
      issue(`迁移动作 ${action.action} 不得挂退役原因 kind=${action.reason.kind}（防误归因）`);
    }
    if (action.action === 'promote' && action.evidence === undefined && action.assetKind === 'memory') {
      issue('promote 必带外部验证证据（J5 条件 ①，memory 分区）');
    }
    if (action.evidence !== undefined && action.action !== 'promote') {
      issue(`动作 ${action.action} 不得携带外部验证证据（证据只在转正时入账）`);
    }
    if (action.action === 'propose-invalidate' && action.reason === undefined) {
      issue('propose-invalidate 必带 reason');
    }
    if (
      action.approvalToken !== undefined &&
      action.action !== 'propose-invalidate' &&
      !(action.action === 'retire' && action.reason?.kind === 'capacity') &&
      action.action !== 'approve'
    ) {
      issue(`动作 ${action.action} 不得携带审批 token（token 只服务于高风险动作）`);
    }
    if ((action.action === 'propose' || action.action === 'approve' || action.action === 'flag-conflict') && (action.from !== undefined || action.to !== undefined)) {
      issue(`动作 ${action.action} 不改变生命周期，不得携带 from/to（投影口径：无迁移即无状态变更）`);
    }
    if (action.conflictWith !== undefined) {
      if (action.action !== 'flag-conflict') {
        issue(`动作 ${action.action} 不得携带 conflictWith（冲突标记只在 flag-conflict 上）`);
      }
      if (action.conflictWith.length < 2) {
        issue(`flag-conflict 的 conflictWith 至少两项（分叉=≥2 个分叉对象；收到 ${action.conflictWith.length}）`);
      }
      if (action.conflictWith.includes(action.assetId)) {
        issue('conflictWith 不得自指');
      }
    }
    if (action.promotedFrom !== undefined) {
      if (action.action !== 'promote') issue(`动作 ${action.action} 不得携带 promotedFrom（只在转正时）`);
      if (action.promotedFrom === action.assetId) issue('promotedFrom 不得自指（转正必产新条目）');
    }
    if (action.dupOf !== undefined) {
      if (action.action !== 'propose') issue(`动作 ${action.action} 不得携带 dupOf（重复标记只在 propose 上）`);
      if (action.dupOf === action.assetId) issue('dupOf 不得自指');
    }
  });
export type GovAction = z.infer<typeof GovActionSchema>;

/** 冲突记录（J9：只检测标记，不隐藏裁决）。 */
export const GovConflictSchema = z.object({
  with: z.array(z.string()),
  detectedAt: z.number(),
  resolution: z.enum(['pending', 'merged', 'human-ruled']),
});
export type GovConflict = z.infer<typeof GovConflictSchema>;

export const MemoryGovStateSchema = z
  .object({
    assetKind: z.enum(GOV_ASSET_KINDS),
    assetId: z.string(),
    lifecycle: z.enum(MEMORY_LIFECYCLES),
    /** 内容层已被 invalidate（终局标记；条目仍可溯）。 */
    archived: z.boolean(),
    retiredReason: GovReasonSchema.optional(),
    /** 凭证镜像（治理查询/容量排名用；不复制内容）。 */
    credential: z.enum(GOV_CREDENTIALS),
    verifiedBy: z.array(VerifyEvidenceSchema),
    conflict: GovConflictSchema.optional(),
    /** near-duplicate 标记（U4：只标不并）。 */
    dupOf: z.string().optional(),
    /** 聚合自 T1.1 recall_log（缓存，扫时刷新）。 */
    reuseCount: z.number(),
    lastUsedAt: z.number().optional(),
    updatedAt: z.number(),
  })
  .superRefine((state, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (state.archived && state.lifecycle !== 'retired') {
      issue(`archived=true 必须是 retired 态（收到 ${state.lifecycle}）——invalidate 是终局`);
    }
    if (state.retiredReason !== undefined && state.lifecycle !== 'retired') {
      issue(`retiredReason 只在 retired 态在场（收到 ${state.lifecycle}）`);
    }
    if (state.lifecycle === 'retired' && state.retiredReason === undefined) {
      issue('retired 态必带 retiredReason（退役可解释）');
    }
    if (state.dupOf === state.assetId) {
      issue('dupOf 不得自指');
    }
    if (state.reuseCount < 0) issue('reuseCount 不得为负');
    if (state.lastUsedAt !== undefined && state.reuseCount === 0) {
      issue('lastUsedAt 在场却 reuseCount=0（聚合口径矛盾）');
    }
  });
export type MemoryGovState = z.infer<typeof MemoryGovStateSchema>;

/** 扫描水位 + 吞吐帽（J11）。 */
export const GovScanStateSchema = z.object({
  lastScanAt: z.number(),
  /** 下次扫描的起点游标（资产 id；'' 表示从头）。 */
  cursor: z.string(),
  /** 周期（毫秒；P0 默认 6h，U5）。 */
  cycleMs: z.number(),
  caps: z.object({ maxActions: z.number(), maxScanned: z.number() }),
});
export type GovScanState = z.infer<typeof GovScanStateSchema>;

export const GOV_SCAN_STATE_KEY = 'singleton' as const;

export type GovTables = {
  gov_actions: typeof GovActionSchema;
  memory_gov_states: typeof MemoryGovStateSchema;
  gov_scan_state: typeof GovScanStateSchema;
};

export const governanceDomainSpec = defineTdaDomain({
  name: 'tda-governance',
  version: 1,
  tables: {
    gov_actions: GovActionSchema,
    memory_gov_states: MemoryGovStateSchema,
    gov_scan_state: GovScanStateSchema,
  },
  layout: 'single',
  // 域级 backup-and-skip + apply 里的权威分级闸（见文件头）
  invalidRecords: 'backup-and-skip',
});

/** 治理状态行的复合键（kind 分区：`memory#tl-3`；T2.2 起 `skill#...`）。 */
export const govStateKey = (assetKind: GovAssetKind, assetId: string | EntryId): string =>
  `${assetKind}#${String(assetId)}`;

export const GOV_ACTION_PREFIX = 'gov';
