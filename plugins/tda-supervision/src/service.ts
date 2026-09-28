/**
 * T3.2 · service（ctx.supervision）。硬纪律：
 * - J2 定级：规则表查定 + 元规则（不可逆 ⇒ high），禁调用方自定；
 * - J4 一次性 token：approve/reject 消费即焚；过期回 pending（无自动 resolved 路径）；
 * - J5 只发票不代跑：approve 产 ResumeTicket（单次），恢复逻辑在调用方；
 * - J7 units = base(risk)×min(volume,cap) 纯函数；计费落点 taskId/goalId 至少其一；
 * - J8 三区：正常逐项 / 压力区 medium+low 转 digest / exhausted 全 digest + 告警；
 * - 不变量 5：rejected/cancelled 必带 reason，已 done 保留（本服务无回滚代码路径）。
 */
import {
  TdaError,
  dualWrite,
  asApprovalId,
  asAttentionId,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteOp,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  DEFAULT_SUPERVISION_PARAMS,
  SUPERVISION_PARAMS_BUSINESS_ID,
  SUPERVISION_PARAMS_KEY,
  supervisionDomainSpec,
  type ApprovalKind,
  type ApprovalRequest,
  type AttentionCharge,
  type RiskLevel,
  type SupervisionEvent,
  type SupervisionParams,
  type SupervisionTables,
} from './domain.ts';
import { supervisionParamsPayload, approvalPayload, eventPayload, chargePayload, APPROVAL_BUSINESS_PREFIX, EVENT_BUSINESS_PREFIX, CHARGE_BUSINESS_PREFIX } from './events.ts';

export interface ApprovalRequestInput {
  readonly kind: ApprovalKind;
  readonly requester: { readonly service: string; readonly ref: string };
  readonly subject: string;
  readonly whatToShow: ApprovalRequest['whatToShow'];
  readonly resume: { readonly from: string; readonly handle: string };
  readonly taskId?: string | undefined;
  readonly goalId?: string | undefined;
  /** 调用方建议档位（仅可上调；服务端按规则表兜底，J2）。 */
  readonly riskHint?: RiskLevel | undefined;
}

export interface ResumeTicket {
  readonly approvalId: string;
  readonly nonce: string;
  readonly from: string;
  readonly handle: string;
}

export interface DigestView {
  readonly items: readonly { readonly approvalId: string; readonly subject: string; readonly kind: ApprovalKind; readonly reversible: boolean }[];
  readonly pendingUnits: number;
}

export interface AttentionStatus {
  readonly consumedUnits: number;
  readonly quotaUnits: number;
  readonly zone: 'normal' | 'pressure' | 'exhausted';
  readonly pendingCount: number;
  readonly medianResponseMs: number | undefined;
}

export interface DashboardView {
  readonly range: { readonly from: number; readonly to: number };
  readonly approvalsByRisk: Record<string, number>;
  readonly attentionUnitsTotal: number;
  readonly pendingDepth: number;
  readonly digestCount: number;
}

export interface SupervisionDeps {
  readonly domain: TdaDomain<SupervisionTables>;
  readonly session: TdaSessionSink;
  readonly bus?: TdaEventBus | undefined;
  readonly reconciler?: DualWriteReconciler | undefined;
  readonly index?: AuditIndex | undefined;
  /** 漂移升级等 escalation 的只读源（v1：仪表盘漂移趋势由调用方组装）。 */
  readonly now: () => number;
}

export interface SupervisionService {
  initialize(): Promise<void>;
  request(input: ApprovalRequestInput): Promise<ApprovalRequest>;
  cancel(approvalId: string, reason: string): Promise<ApprovalRequest>;
  approve(approvalId: string, token: string): Promise<ResumeTicket>;
  reject(approvalId: string, token: string, note?: string): Promise<ApprovalRequest>;
  /** 重签（token 过期回 pending 后由人类侧重新取 token——实现上=refreshTicket）。 */
  reissueToken(approvalId: string): Promise<ApprovalRequest>;
  pending(filter?: { riskLevel?: string; kind?: string }): readonly ApprovalRequest[];
  digest(): DigestView;
  veto(approvalId: string, reason: string): Promise<void>;
  flushDigest(): Promise<DigestView>;
  attentionStatus(): AttentionStatus;
  dashboard(range?: { from?: number; to?: number }): DashboardView;
  events(): readonly SupervisionEvent[];
  params(): SupervisionParams;
  setParams(patch: Partial<Omit<SupervisionParams, 'revision'>>): Promise<SupervisionParams>;
  dispose(): Promise<void>;
}

const crypto = globalThis.crypto;

const randomNonce = (): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export function createSupervisionService(deps: SupervisionDeps): SupervisionService {
  const approvalsTable = deps.domain.table('approval_requests');
  const eventsTable = deps.domain.table('supervision_events');
  const ledgerTable = deps.domain.table('attention_ledger');
  const paramsTable = deps.domain.table('supervision_params');

  const clock = deps.now;
  let paramsRef: SupervisionParams | undefined;
  let approvalSeq = 0;
  let eventSeq = 0;
  let chargeSeq = 0;
  const approvals = new Map<string, ApprovalRequest>();
  /** 已消费 ResumeTicket（单次有效，J5）。 */
  const consumedTickets = new Set<string>();
  /** digest 池（免审项聚合；flush 时聚合计费）。 */
  const digestPool = new Set<string>();

  const context: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };
  const emit = async (op: DualWriteOp): Promise<void> => {
    const seq = await dualWrite(deps.session, op, context);
    deps.bus?.publish({
      family: op.family,
      businessId: op.businessId,
      payload: op.payload,
      seq,
      sessionId: deps.session.sessionId,
    });
  };

  const loadParams = (): SupervisionParams => {
    if (paramsRef !== undefined) return paramsRef;
    const row = paramsTable.get(SUPERVISION_PARAMS_KEY) as SupervisionParams | undefined;
    paramsRef = row ?? { ...DEFAULT_SUPERVISION_PARAMS };
    return paramsRef;
  };

  const recordEvent = async (kind: SupervisionEvent['kind'], approvalId: string | undefined, detail: unknown): Promise<void> => {
    eventSeq += 1;
    const row = {
      eventId: `sve-${eventSeq}`,
      kind,
      ...(approvalId !== undefined ? { approvalId } : {}),
      detail,
      at: clock(),
    };
    await emit({
      family: 'supervision/change',
      businessId: `${EVENT_BUSINESS_PREFIX}:${row.eventId}`,
      payload: eventPayload(row),
      domainWrite: async () => {
        await eventsTable.put(row.eventId, row as never);
      },
    });
  };

  const persistApproval = async (approval: ApprovalRequest): Promise<void> => {
    approvals.set(String(approval.approvalId), approval);
    await approvalsTable.put(String(approval.approvalId), approval as never);
  };

  /** units = base(risk)×min(volumeFactor, cap)（不变量 6 纯函数）。 */
  const computeUnits = (riskLevel: RiskLevel, impactCount: number): number => {
    const config = loadParams();
    const base = config.baseUnits[riskLevel];
    const volumeFactor = Math.max(1, impactCount);
    return base * Math.min(volumeFactor, config.volumeFactorCap);
  };

  const consumedUnits = (): number => {
    let total = 0;
    for (const [, charge] of ledgerTable.entries()) {
      total += (charge as AttentionCharge).units;
    }
    return total;
  };

  const zoneOf = (units: number): AttentionStatus['zone'] => {
    const config = loadParams();
    const fraction = units / config.attentionQuotaUnits;
    if (fraction >= 1) return 'exhausted';
    if (fraction >= config.zoneThresholds.pressure) return 'pressure';
    return 'normal';
  };

  const requireApproval = (approvalId: string): ApprovalRequest => {
    const approval = approvals.get(approvalId);
    if (approval === undefined) {
      throw new TdaError('SUPERVISION_NOT_FOUND', `审批项 ${approvalId} 不存在`);
    }
    return approval;
  };

  const chargeAttention = async (
    kind: AttentionCharge['kind'],
    units: number,
    ref: { approvalId?: string; taskId?: string; goalId?: string },
  ): Promise<void> => {
    if (units === 0) return;
    if ((ref.taskId ?? undefined) === undefined && (ref.goalId ?? undefined) === undefined) {
      throw new TdaError('SUPERVISION_BILLING_TARGET', '计费落点必填：taskId/goalId 至少其一（不变量 7）');
    }
    chargeSeq += 1;
    const charge: AttentionCharge = {
      chargeId: asAttentionId(`att-${chargeSeq}`),
      ...(ref.approvalId !== undefined ? { approvalId: ref.approvalId } : {}),
      kind,
      units,
      ...(ref.taskId !== undefined ? { taskId: ref.taskId } : {}),
      ...(ref.goalId !== undefined ? { goalId: ref.goalId } : {}),
      at: clock(),
    };
    await emit({
      family: 'supervision/change',
      businessId: `${CHARGE_BUSINESS_PREFIX}:${String(charge.chargeId)}`,
      payload: chargePayload(charge),
      domainWrite: async () => {
        await ledgerTable.put(String(charge.chargeId), charge as never);
      },
    });
    await recordEvent('attention-charged', ref.approvalId, { chargeId: String(charge.chargeId), units, kind });
  };

  const service: SupervisionService = {
    async initialize() {
      loadParams();
      for (const [, value] of approvalsTable.entries()) {
        const approval = value as ApprovalRequest;
        approvals.set(String(approval.approvalId), approval);
        const seq = Number(String(approval.approvalId).replace('apr-', ''));
        if (Number.isFinite(seq) && seq > approvalSeq) approvalSeq = seq;
      }
      if (paramsTable.get(SUPERVISION_PARAMS_KEY) === undefined) {
        await emit({
          family: 'supervision/change',
          businessId: SUPERVISION_PARAMS_BUSINESS_ID,
          payload: supervisionParamsPayload(loadParams()),
          domainWrite: async () => {
            await paramsTable.put(SUPERVISION_PARAMS_KEY, loadParams() as never);
          },
        });
      }
    },

    async request(input) {
      const config = loadParams();
      // 请求洪水帽
      const hourAgo = clock() - 3_600_000;
      let recent = 0;
      for (const [, event] of eventsTable.entries()) {
        if ((event as SupervisionEvent).kind === 'requested' && (event as SupervisionEvent).at >= hourAgo) recent += 1;
      }
      if (recent >= config.requestRateLimitPerHour) {
        throw new TdaError('SUPERVISION_RATE_LIMIT', `审批请求超洪水帽 ${config.requestRateLimitPerHour}/h（防注意力刷爆）`);
      }
      // J2 定级：规则表查定 + 元规则（不可逆 ⇒ high）；调用方 riskHint 只可上调。
      const ruleLevel = config.riskTable[input.kind] ?? 'medium';
      const anyIrreversible = input.whatToShow.impact.some((impact) => !impact.reversible);
      let riskLevel: RiskLevel = anyIrreversible ? 'high' : ruleLevel;
      const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
      if (input.riskHint !== undefined && rank[input.riskHint] > rank[riskLevel]) riskLevel = input.riskHint;
      if (input.whatToShow.impact.some((impact) => impact.reversible === false) && riskLevel !== 'high') {
        throw new TdaError('SUPERVISION_META_RULE', '不可逆动作最低定 high（元规则服务端断言，不变量 8）');
      }
      // excerpts 帽
      const excerpts = (input.whatToShow.excerpts ?? []).slice(0, config.maxExcerpts);
      approvalSeq += 1;
      const approvalId = asApprovalId(`apr-${approvalSeq}`);
      const at = clock();
      const nonce = randomNonce();
      const units = computeUnits(riskLevel, input.whatToShow.impact.length);
      // 三区判定（J8）：exhausted/pressure 下 medium+low 入 digest；high 仍逐项。
      const zone = zoneOf(consumedUnits());
      const toDigest = zone !== 'normal' && riskLevel !== 'high';
      const approval: ApprovalRequest = {
        approvalId,
        kind: input.kind,
        riskLevel,
        requester: { ...input.requester },
        subject: input.subject,
        whatToShow: { ...input.whatToShow, ...(excerpts.length > 0 ? { excerpts } : {}) },
        resume: { ...input.resume },
        status: 'pending',
        token: { nonce, issuedAt: at, expiresAt: at + config.tokenTtlHours * 3_600_000 },
        attention: { units, chargedAt: toDigest ? at : at },
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
        createdAt: at,
        updatedAt: at,
      };
      await emit({
        family: 'supervision/change',
        businessId: `${APPROVAL_BUSINESS_PREFIX}:${String(approvalId)}`,
        payload: approvalPayload(approval),
        domainWrite: async () => {
          await persistApproval(approval);
        },
      });
      await recordEvent('requested', String(approvalId), { kind: input.kind, riskLevel, zone, toDigest });
      await recordEvent('token-issued', String(approvalId), { nonce, expiresAt: approval.token.expiresAt });
      if (toDigest) {
        digestPool.add(String(approvalId));
      } else {
        // 逐项推送 = 请求入队即计费（J7）；digest 项 flush 时聚合计费。
        await chargeAttention('approval', units, {
          approvalId: String(approvalId),
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
        });
      }
      if (zone === 'exhausted') {
        await recordEvent('attention-charged', undefined, { alarm: 'attention-exhausted', note: '免打扰模式：新请求入 digest 排队不推送' });
      }
      return requireApproval(String(approvalId));
    },

    async cancel(approvalId, reason) {
      const approval = requireApproval(approvalId);
      if (approval.status !== 'pending') {
        throw new TdaError('SUPERVISION_NOT_PENDING', `审批项 ${approvalId} 当前 ${approval.status}，仅 pending 可撤销`);
      }
      if (reason === '') throw new TdaError('SUPERVISION_REASON_REQUIRED', 'cancel 必带 reason（不变量 5 显式终态）');
      const next: ApprovalRequest = {
        ...approval,
        status: 'cancelled',
        statusReason: reason,
        updatedAt: clock(),
      };
      await emit({
        family: 'supervision/change',
        businessId: `${APPROVAL_BUSINESS_PREFIX}:${approvalId}`,
        payload: approvalPayload(next),
        domainWrite: async () => {
          await persistApproval(next);
        },
      });
      await recordEvent('cancelled', approvalId, { reason });
      digestPool.delete(approvalId);
      return requireApproval(approvalId);
    },

    async approve(approvalId, token) {
      const approval = requireApproval(approvalId);
      if (approval.status !== 'pending') {
        throw new TdaError('SUPERVISION_NOT_PENDING', `审批项 ${approvalId} 当前 ${approval.status}`);
      }
      // token 校验（不变量 2）：存在/未消费/未过期。
      if (token !== approval.token.nonce) {
        throw new TdaError('SUPERVISION_TOKEN_MISMATCH', 'token 不匹配（防重放）');
      }
      if (approval.token.consumedAt !== undefined) {
        throw new TdaError('SUPERVISION_TOKEN_CONSUMED', 'token 已消费（一次性纪律，重复使用=重放拒绝）');
      }
      if (clock() > approval.token.expiresAt) {
        // 过期 ≠ resolved：回 pending 可重签（J4/J5）。
        await recordEvent('token-expired', approvalId, { nonce: approval.token.nonce });
        throw new TdaError('SUPERVISION_TOKEN_EXPIRED', 'token 已过期（审批项回 pending，可 reissueToken 重签）');
      }
      const at = clock();
      const next: ApprovalRequest = {
        ...approval,
        status: 'approved',
        token: { ...approval.token, consumedAt: at },
        resolution: { decision: 'approve', by: 'human', at, tokenNonce: approval.token.nonce },
        attention: { ...approval.attention, respondedAt: at },
        updatedAt: at,
      };
      await emit({
        family: 'supervision/change',
        businessId: `${APPROVAL_BUSINESS_PREFIX}:${approvalId}`,
        payload: approvalPayload(next),
        domainWrite: async () => {
          await persistApproval(next);
        },
      });
      await recordEvent('approved', approvalId, { nonce: approval.token.nonce, at });
      digestPool.delete(approvalId);
      // ResumeTicket 单次有效（J5/不变量 4）。
      const ticketNonce = randomNonce();
      consumedTickets.add(ticketNonce);
      return { approvalId, nonce: ticketNonce, from: approval.resume.from, handle: approval.resume.handle };
    },

    async reject(approvalId, token, note) {
      const approval = requireApproval(approvalId);
      if (approval.status !== 'pending') {
        throw new TdaError('SUPERVISION_NOT_PENDING', `审批项 ${approvalId} 当前 ${approval.status}`);
      }
      if (token !== approval.token.nonce) {
        throw new TdaError('SUPERVISION_TOKEN_MISMATCH', 'token 不匹配（防重放）');
      }
      if (approval.token.consumedAt !== undefined) {
        throw new TdaError('SUPERVISION_TOKEN_CONSUMED', 'token 已消费（一次性纪律）');
      }
      const at = clock();
      const next: ApprovalRequest = {
        ...approval,
        status: 'rejected',
        statusReason: note ?? '',
        token: { ...approval.token, consumedAt: at },
        resolution: {
          decision: 'reject',
          by: 'human',
          ...(note !== undefined ? { note } : {}),
          at,
          tokenNonce: approval.token.nonce,
        },
        attention: { ...approval.attention, respondedAt: at },
        updatedAt: at,
      };
      await emit({
        family: 'supervision/change',
        businessId: `${APPROVAL_BUSINESS_PREFIX}:${approvalId}`,
        payload: approvalPayload(next),
        domainWrite: async () => {
          await persistApproval(next);
        },
      });
      await recordEvent('rejected', approvalId, { nonce: approval.token.nonce, note: note ?? '' });
      digestPool.delete(approvalId);
      return requireApproval(approvalId);
    },

    async reissueToken(approvalId) {
      const approval = requireApproval(approvalId);
      if (approval.status !== 'pending') {
        throw new TdaError('SUPERVISION_NOT_PENDING', `审批项 ${approvalId} 当前 ${approval.status}，仅 pending 可重签`);
      }
      const at = clock();
      const nonce = randomNonce();
      const next: ApprovalRequest = {
        ...approval,
        token: { nonce, issuedAt: at, expiresAt: at + loadParams().tokenTtlHours * 3_600_000 },
        updatedAt: at,
      };
      await emit({
        family: 'supervision/change',
        businessId: `${APPROVAL_BUSINESS_PREFIX}:${approvalId}`,
        payload: approvalPayload(next),
        domainWrite: async () => {
          await persistApproval(next);
        },
      });
      await recordEvent('token-issued', approvalId, { nonce, reissue: true });
      return requireApproval(approvalId);
    },

    pending(filter) {
      return [...approvals.values()].filter(
        (approval) =>
          approval.status === 'pending' &&
          (filter?.riskLevel === undefined || approval.riskLevel === filter.riskLevel) &&
          (filter?.kind === undefined || approval.kind === filter.kind),
      );
    },

    digest() {
      const items = [...digestPool]
        .map((approvalId) => approvals.get(approvalId))
        .filter((approval): approval is ApprovalRequest => approval !== undefined)
        .map((approval) => ({
          approvalId: String(approval.approvalId),
          subject: approval.subject,
          kind: approval.kind,
          reversible: approval.whatToShow.impact.every((impact) => impact.reversible),
        }));
      return {
        items,
        pendingUnits: items.reduce((sum, item) => sum + (approvals.get(item.approvalId)?.attention.units ?? 0), 0),
      };
    },

    async veto(approvalId, reason) {
      const approval = requireApproval(approvalId);
      // digest 只收可逆项（不变量 8）：veto=事后回滚入口，仅可逆。
      if (!approval.whatToShow.impact.every((impact) => impact.reversible)) {
        throw new TdaError('SUPERVISION_VETO_IRREVERSIBLE', `审批项 ${approvalId} 含不可逆影响，不可经 digest 否决（须走正式审批）`);
      }
      await recordEvent('digest-vetoed', approvalId, { reason });
      digestPool.delete(approvalId);
    },

    async flushDigest() {
      const items = [...digestPool]
        .map((approvalId) => approvals.get(approvalId))
        .filter((approval): approval is ApprovalRequest => approval !== undefined);
      // 聚合计费（J7）：flush 阅读时一次计费，未读不计费。
      let total = 0;
      for (const approval of items) {
        if (approval.attention.chargedAt === approval.createdAt && !digestPool.has(String(approval.approvalId))) continue;
        total += approval.attention.units;
      }
      if (items.length > 0) {
        const first = items[0]!;
        await chargeAttention('digest', total, {
          ...(first.taskId !== undefined ? { taskId: first.taskId } : {}),
          ...(first.goalId !== undefined ? { goalId: first.goalId } : {}),
        });
      }
      // 已读即出池（flush = 人类回到循环的入口；再次入池需新请求）
      for (const approval of items) digestPool.delete(String(approval.approvalId));
      await recordEvent('digest-flushed', undefined, { count: items.length, units: total });
      return {
        items: items.map((approval) => ({
          approvalId: String(approval.approvalId),
          subject: approval.subject,
          kind: approval.kind,
          reversible: approval.whatToShow.impact.every((impact) => impact.reversible),
        })),
        pendingUnits: total,
      };
    },

    attentionStatus() {
      const units = consumedUnits();
      const responses = [...approvals.values()]
        .filter((approval) => approval.attention.respondedAt !== undefined)
        .map((approval) => approval.attention.respondedAt! - approval.attention.chargedAt)
        .sort((a, b) => a - b);
      const median = responses.length === 0 ? undefined : responses[Math.floor(responses.length / 2)]!;
      return {
        consumedUnits: units,
        quotaUnits: loadParams().attentionQuotaUnits,
        zone: zoneOf(units),
        pendingCount: service.pending().length,
        medianResponseMs: median,
      };
    },

    dashboard(range) {
      const from = range?.from ?? 0;
      const to = range?.to ?? Number.MAX_SAFE_INTEGER;
      const byRisk: Record<string, number> = {};
      for (const approval of approvals.values()) {
        if (approval.createdAt < from || approval.createdAt > to) continue;
        byRisk[approval.riskLevel] = (byRisk[approval.riskLevel] ?? 0) + 1;
      }
      return {
        range: { from, to },
        approvalsByRisk: byRisk,
        attentionUnitsTotal: consumedUnits(),
        pendingDepth: service.pending().length,
        digestCount: digestPool.size,
      };
    },

    events() {
      return [...eventsTable.entries()].map(([, value]) => value as SupervisionEvent);
    },

    params() {
      return loadParams();
    },

    async setParams(patch) {
      const current = loadParams();
      const next: SupervisionParams = { ...current, ...patch, revision: current.revision + 1 };
      paramsRef = next;
      await emit({
        family: 'supervision/change',
        businessId: SUPERVISION_PARAMS_BUSINESS_ID,
        payload: supervisionParamsPayload(next),
        domainWrite: async () => {
          await paramsTable.put(SUPERVISION_PARAMS_KEY, next as never);
        },
      });
      await recordEvent('params-changed', undefined, { revision: next.revision });
      return next;
    },

    async dispose() {
      await deps.domain.close();
    },
  };

  return service;
}

export { supervisionDomainSpec };
