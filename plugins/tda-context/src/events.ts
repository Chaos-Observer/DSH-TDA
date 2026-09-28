/**
 * tda-context 事件构造：只允许走已登记族（context/assemble，编号 5）。
 *
 * 载荷 = AssembleRecord 全快照（J8"组装即审计"）：回放要能还原"当时模型看到了
 * 什么"，故段清单、遮蔽记录、预算配比、gate 模式全部入载荷；域内不存记录
 * （§3.3：AssembleRecord 落 log-only 事件 + T0.3 时间线）。
 */
import type { JsonObject } from '@tda/kernel';
import type { AssembleRecord, PinEntry } from './domain.ts';

export const assemblePayload = (record: AssembleRecord): JsonObject => ({
  sessionId: record.sessionId,
  round: record.round,
  segments: record.segments.map((segment) => ({
    kind: segment.kind,
    ...(segment.ref !== undefined ? { ref: segment.ref } : {}),
    tokenEstimate: segment.tokenEstimate,
  })),
  shadowed: {
    seqs: [...record.shadowed.seqs],
    reason: record.shadowed.reason,
  },
  budget: {
    pinnedPct: record.budget.pinnedPct,
    memoPct: record.budget.memoPct,
    historyPct: record.budget.historyPct,
    injectionPct: record.budget.injectionPct,
    ...(record.budget.overrun !== undefined ? { overrun: [...record.budget.overrun] } : {}),
  },
  ...(record.gate !== undefined
    ? {
        gate: {
          mode: record.gate.mode,
          ...(record.gate.sampledTokens !== undefined ? { sampledTokens: record.gate.sampledTokens } : {}),
          droppedSegmentIds: [...record.gate.droppedSegmentIds],
          ...(record.gate.fallbackReason !== undefined ? { fallbackReason: record.gate.fallbackReason } : {}),
        },
      }
    : {}),
  at: record.at,
});

/**
 * 钉扎定义变更载荷（C6 配置的可审计变更）。
 * businessId = `pin:<id>`——与组装记录共用 context/assemble 族（族是白名单单位，
 * 不为配置另造族），业务 id 前缀可区分，audit_index 定位仍可归因。
 */
export const pinPayload = (pin: PinEntry): JsonObject => ({
  pinId: String(pin.id),
  revision: pin.revision,
  kind: pin.kind,
  sourceKind: pin.sourceKind,
  sourceRef: pin.sourceRef,
  maxTokens: pin.maxTokens,
  enabled: pin.enabled,
  createdAt: pin.createdAt,
  updatedAt: pin.updatedAt,
});
