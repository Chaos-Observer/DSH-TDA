/**
 * tda-governance 投影层：**纯函数**折叠 `gov_actions` → `memory_gov_states`（T1.2 J10）。
 *
 * 「权威不可重建、投影可重建」是 T0.7 replay-equivalence 的同一判据：
 * 动作日志不可推断（人工 retire/恢复/冲突裁决都在里面），而状态只是它的折叠结果。
 * 因此全仓只有这一个折叠实现——线上写状态与不变量门重建状态**走同一条代码路径**，
 * 否则"重建一致"就成了一句空话。
 *
 * 折叠的两个**外部输入**必须显式传入（不读全局）：
 *  - `credentialOf`：凭证镜像来自 T0.3（治理不复制内容，J2）；
 *  - `usageOf`：reuseCount / lastUsedAt 聚合自 T1.1 `recall_log`（扫时刷新）。
 * 故本插件对"投影可重建"的准确表述是：**同 gov_actions + 同 recall_log ⇒ 逐字段一致**。
 */
import {
  CREDENTIAL_RANK,
  type GovAction,
  type GovAssetKind,
  type GovCredential,
  type GovReason,
  type MemoryGovState,
  govStateKey,
} from './domain.ts';

export interface UsageSnapshot {
  readonly reuseCount: number;
  readonly lastUsedAt?: number | undefined;
}

export interface ProjectionDeps {
  readonly credentialOf: (assetId: string) => GovCredential | undefined;
  readonly usageOf: (assetId: string) => UsageSnapshot | undefined;
}

/** 治理分权重（J8：0.5/0.3/0.2）。 */
export interface GovernanceWeights {
  readonly reuse: number;
  readonly credential: number;
  readonly recency: number;
}

export const DEFAULT_GOVERNANCE_WEIGHTS: GovernanceWeights = { reuse: 0.5, credential: 0.3, recency: 0.2 };

const seqOf = (id: string): number => Number(id.slice('gov-'.length));

/** 动作按 id 数值后缀排序（与分配序一致；不依赖表键字典序）。 */
const byActionSeq = (a: GovAction, b: GovAction): number => seqOf(a.id) - seqOf(b.id);

function createBase(action: GovAction, deps: ProjectionDeps): MemoryGovState {
  const credential = deps.credentialOf(action.assetId) ?? (action.action === 'promote' ? 'execution-verified' : 'model-produced');
  const usage = deps.usageOf(action.assetId);
  return {
    assetKind: action.assetKind,
    assetId: action.assetId,
    lifecycle: 'draft',
    archived: false,
    credential,
    verifiedBy: [],
    reuseCount: usage?.reuseCount ?? 0,
    ...(usage?.lastUsedAt !== undefined ? { lastUsedAt: usage.lastUsedAt } : {}),
    updatedAt: action.at,
  };
}

/** 单步折叠（纯函数；供投影与单测直接调用）。 */
export function applyAction(base: MemoryGovState, action: GovAction, deps: ProjectionDeps): MemoryGovState {
  const next: MemoryGovState = { ...base, updatedAt: action.at };
  switch (action.action) {
    case 'promote': {
      const credential = deps.credentialOf(action.assetId) ?? 'execution-verified';
      return {
        ...next,
        lifecycle: 'validating',
        credential,
        verifiedBy: action.evidence === undefined ? [...base.verifiedBy] : [...base.verifiedBy, action.evidence],
      };
    }
    case 'consolidate':
      return { ...next, lifecycle: 'consolidated' };
    case 'retire': {
      const reason: GovReason = action.reason ?? { kind: 'manual', detail: '（无明细）' };
      return { ...next, lifecycle: 'retired', retiredReason: reason };
    }
    case 'restore': {
      const { retiredReason: _dropped, ...rest } = next;
      void _dropped;
      return { ...rest, lifecycle: 'consolidated' };
    }
    case 'flag-conflict':
      return {
        ...next,
        conflict: {
          with: [...(action.conflictWith ?? [])],
          detectedAt: action.at,
          resolution: 'pending',
        },
      };
    case 'propose-invalidate': {
      // 审批通过（带 token）才真作废：终局 = retired + archived（内容层已 invalidate）
      if (action.approvalToken === undefined || action.approvalToken === '') return next;
      return {
        ...next,
        lifecycle: 'retired',
        archived: true,
        retiredReason: { kind: 'manual', detail: action.reason?.detail ?? '内容层 invalidate' },
      };
    }
    case 'propose':
      return action.dupOf === undefined ? next : { ...next, dupOf: action.dupOf };
    case 'approve':
    default:
      return next;
  }
}

/**
 * 折叠全部动作 → 状态表快照。
 *
 * `assetKindFilter`：T1.4 的 meta-thinking 分区与 memory 分区共用本函数
 * （同一治理管道、同一投影代码，只有 kind 维度不同）。
 */
export function projectStates(
  actions: readonly GovAction[],
  deps: ProjectionDeps,
  assetKindFilter?: GovAssetKind,
): Map<string, MemoryGovState> {
  const sorted = [...actions].sort(byActionSeq);
  const out = new Map<string, MemoryGovState>();
  for (const action of sorted) {
    if (assetKindFilter !== undefined && action.assetKind !== assetKindFilter) continue;
    const key = govStateKey(action.assetKind, action.assetId);
    const base = out.get(key) ?? createBase(action, deps);
    out.set(key, applyAction(base, action, deps));
  }
  return out;
}

/** 治理分（J8）：复用权重 × 归一复用数 + 凭证秩 + 时间新鲜度。 */
export function governanceScore(
  input: {
    readonly reuseCount: number;
    readonly maxReuseCount: number;
    readonly credential: GovCredential;
    readonly recency: number;
  },
  weights: GovernanceWeights = DEFAULT_GOVERNANCE_WEIGHTS,
): number {
  const reuse = input.maxReuseCount > 0 ? input.reuseCount / input.maxReuseCount : 0;
  const credential = CREDENTIAL_RANK[input.credential] / 4;
  return weights.reuse * reuse + weights.credential * credential + weights.recency * input.recency;
}

/** 容量三区（J8：<80% normal / 80–100% pressure / >100% over；两维取最紧）。 */
export function capacityZone(input: {
  readonly activeEntries: number;
  readonly activeTokensEst: number;
  readonly caps: { readonly maxEntries: number; readonly maxTokens: number };
}): 'normal' | 'pressure' | 'over' {
  const ratio = Math.max(
    input.caps.maxEntries > 0 ? input.activeEntries / input.caps.maxEntries : 0,
    input.caps.maxTokens > 0 ? input.activeTokensEst / input.caps.maxTokens : 0,
  );
  if (ratio > 1) return 'over';
  if (ratio >= 0.8) return 'pressure';
  return 'normal';
}

/** 退役判据：无复用超 N 天（J7 `unused-days`）。 */
export function isUnusedTooLong(input: {
  readonly lastUsedAt: number | undefined;
  readonly createdAt: number;
  readonly now: number;
  readonly unusedDaysMs: number;
}): boolean {
  const reference = input.lastUsedAt ?? input.createdAt;
  return input.now - reference > input.unusedDaysMs;
}
