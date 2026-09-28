/**
 * tda-maintenance 服务面（T2.3 §4.2）。
 *
 * J1 铁律：编排非权威——唯一写路径 = ctx.governance + 资产 supersede；
 * 本服务零直接 domain accepted 变更（自己的表只记编排史，不算资产变更）。
 */
import {
  DEFAULT_PARAMS,
  MAINTENANCE_PARAMS_KEY,
  ParamsSchema,
  maintenanceDomainSpec,
  type MaintenanceAction,
  type MaintenanceAssetKind,
  type MaintenanceParams,
  type MaintenanceProposal,
  type MaintenanceReport,
  type MaintenanceTables,
} from './domain.ts';
import {
  MAINTENANCE_PARAMS_BUSINESS_ID,
  MAINTENANCE_PROPOSAL_BUSINESS_PREFIX,
  MAINTENANCE_REPORT_BUSINESS_PREFIX,
  MAINTENANCE_ACTION_BUSINESS_PREFIX,
  maintenanceActionPayload,
  maintenanceParamsPayload,
  maintenanceProposalPayload,
  maintenanceReportPayload,
} from './events.ts';
import {
  dualWrite,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';

export type MaintenanceActor = { readonly sessionId: string; readonly actor: 'human' | 'coach' | 'scheduler' };

/** 信号快照行（冷读聚合面：全部由装配层从各资产旁路表只读汇总，J5/§5）。 */
export interface AssetSignalRow {
  readonly assetKind: MaintenanceAssetKind;
  readonly assetId: string;
  readonly lifecycle: string;
  /** 复用频率：recall_log injected 数 / skill realUse。 */
  readonly reuseCount: number;
  /** 验证次数：rehearsal pass / gov verifiedBy。 */
  readonly verifyCount: number;
  /** 跨任务关联度：relatedTaskId 分散度（去重任务数）。 */
  readonly taskIds: readonly string[];
  /** 归一化 Elo（无 Elo 资产 = 0.5 中性，J6）。 */
  readonly eloNorm?: number | undefined;
  /** 最近使用时刻（recency 归一输入；缺省 = 极旧）。 */
  readonly lastUseAt?: number | undefined;
  /** 既有检测器产出的退役信号（T1.2 四信号 / T2.2 stats；不变量 2 白名单）。 */
  readonly retireSignals?: readonly string[];
}

/** 资产信号 seam（只读冷取）。 */
export interface MaintenanceSignals {
  readonly assets: () => readonly AssetSignalRow[];
  /** 冲突记录（T1.2/T2.2 只标未裁的 near-dup/contradiction）。 */
  readonly conflicts?: (() => readonly { readonly assetKind: MaintenanceAssetKind; readonly assetId: string; readonly withIds: readonly string[] }[]) | undefined;
  /** 主任务活跃期探测（J7 让位）。 */
  readonly isAthleteActive?: (() => boolean) | undefined;
}

/** 治理 seam（结构镜像 tda-governance 子集；零 import，J1）。 */
export interface MaintenanceGovernanceSeam {
  consolidate(actor: MaintenanceActor, assetId: string, assetKind?: string): Promise<unknown>;
  retire(
    actor: MaintenanceActor,
    assetId: string,
    reason: { readonly kind: string; readonly detail: string },
    opts?: { readonly approvalToken?: string },
    assetKind?: string,
  ): Promise<unknown>;
  restore(actor: MaintenanceActor, assetId: string, assetKind?: string): Promise<unknown>;
  proposeInvalidate(actor: MaintenanceActor, assetId: string, reason: string, opts?: { readonly approvalToken?: string }): Promise<unknown>;
  lifecycleOf(assetId: string, assetKind?: string): string | undefined;
  /** 治理动作 id（对账回填 govActionId）。 */
  actions(assetId?: string): readonly { readonly id: string; readonly assetId: string; readonly action: string }[];
}

export interface MaintenanceDeps {
  readonly domain: TdaDomain<MaintenanceTables>;
  readonly session: TdaSessionSink;
  readonly signals: MaintenanceSignals;
  readonly governance: MaintenanceGovernanceSeam;
  /** coach 候选读取 seam（J5①；缺席 = enqueueFromCoach 报错）。 */
  readonly coachCandidates?: (() => readonly { readonly id: string; readonly risk: string; readonly targetRef?: string; readonly assetKind?: string }[]) | undefined;
  readonly now?: (() => number) | undefined;
  readonly reconciler?: DualWriteReconciler | undefined;
  readonly index?: AuditIndex | undefined;
  readonly bus?: TdaEventBus | undefined;
}

export interface ScoreboardEntry {
  readonly assetKind: string;
  readonly assetId: string;
  readonly score: number;
  readonly parts: { readonly elo: number; readonly reuse: number; readonly recency: number; readonly verify: number };
}

export interface MaintenanceService {
  initialize(): Promise<void>;
  cycle(trigger: { kind: 'periodic' | 'coach-review' | 'manual'; ref?: string }): Promise<MaintenanceReport>;
  proposals(filter?: { readonly status?: string; readonly kind?: string; readonly risk?: string; readonly assetKind?: string }): readonly MaintenanceProposal[];
  approve(proposalId: string, token: string): Promise<MaintenanceAction>;
  reject(proposalId: string, reason: string): Promise<MaintenanceAction>;
  scoreboard(): readonly ScoreboardEntry[];
  enqueueFromCoach(candidateIds: readonly string[]): Promise<readonly MaintenanceProposal[]>;
  reports(limit?: number): readonly MaintenanceReport[];
  params(): MaintenanceParams;
  setParams(patch: Partial<Omit<MaintenanceParams, 'revision'>>): Promise<MaintenanceParams>;
}

export function createMaintenanceService(deps: MaintenanceDeps): MaintenanceService {
  const clock = deps.now ?? ((): number => Date.now());
  const context: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };
  const emit = async (op: Parameters<typeof dualWrite>[1]): Promise<number> => {
    const seq = await dualWrite(deps.session, op, context);
    deps.bus?.publish({
      family: op.family,
      businessId: op.businessId,
      payload: op.payload,
      seq,
      sessionId: deps.session.sessionId,
    });
    return seq;
  };
  const proposalsTable = deps.domain.table('maintenance_proposals');
  const actionsTable = deps.domain.table('maintenance_actions');
  const reportsTable = deps.domain.table('maintenance_reports');
  const paramsTable = deps.domain.table('maintenance_params');

  const proposals = new Map<string, MaintenanceProposal>();
  let proposalCounter = 0;
  let actionCounter = 0;
  let reportCounter = 0;
  let paramsRef: MaintenanceParams | undefined;
  const consumedTokens = new Set<string>();

  const loadParams = (): MaintenanceParams => {
    if (paramsRef !== undefined) return paramsRef;
    const row = paramsTable.get(MAINTENANCE_PARAMS_KEY) as MaintenanceParams | undefined;
    paramsRef = row ?? { ...DEFAULT_PARAMS };
    return paramsRef;
  };

  const persistProposal = async (proposal: MaintenanceProposal, action: string): Promise<void> => {
    proposals.set(String(proposal.id), proposal);
    await emit({
      family: 'maintenance/change',
      businessId: `${MAINTENANCE_PROPOSAL_BUSINESS_PREFIX}:${String(proposal.id)}`,
      payload: maintenanceProposalPayload(proposal, action),
      domainWrite: async () => {
        await proposalsTable.put(String(proposal.id), proposal as never);
      },
    });
  };

  /** 统一治理分（J6）：跨资产可比的容量/优先级依据。 */
  const scoreOf = (row: AssetSignalRow, params: MaintenanceParams, now: number): ScoreboardEntry => {
    const eloNorm = row.eloNorm ?? 0.5;
    const reuseNorm = Math.min(1, row.reuseCount / Math.max(1, params.promoteThresholds.reuse * 2));
    const recency =
      row.lastUseAt !== undefined
        ? Math.max(0, 1 - (now - row.lastUseAt) / (30 * 86_400_000))
        : 0;
    const verifyNorm = Math.min(1, row.verifyCount / Math.max(1, params.promoteThresholds.verify * 2));
    const w = params.scoreWeights;
    return {
      assetKind: row.assetKind,
      assetId: row.assetId,
      score: w.elo * eloNorm + w.reuse * reuseNorm + w.recency * recency + w.verify * verifyNorm,
      parts: { elo: eloNorm, reuse: reuseNorm, recency, verify: verifyNorm },
    };
  };

  /** 提议生成（纯函数：信号快照 + 阈值 + params ⇒ 提议序列，J10/不变量 8）。 */
  const generateProposals = (
    rows: readonly AssetSignalRow[],
    params: MaintenanceParams,
    source: { kind: 'scan' | 'coach'; ref?: string },
  ): { readonly proposal: Omit<MaintenanceProposal, 'id' | 'status' | 'createdAt' | 'risk'>; readonly risk: 'low' | 'high' }[] => {
    const out: { proposal: Omit<MaintenanceProposal, 'id' | 'status' | 'createdAt' | 'risk'>; risk: 'low' | 'high' }[] = [];
    const at = clock();
    const thresholds = { ...params.promoteThresholds };

    // ① 升格（J2 三源阈值化）
    for (const row of rows) {
      if (row.lifecycle === 'consolidated') continue;
      const associationSpread = new Set(row.taskIds).size;
      if (
        row.reuseCount >= thresholds.reuse &&
        row.verifyCount >= thresholds.verify &&
        associationSpread >= thresholds.association
      ) {
        out.push({
          risk: 'low',
          proposal: {
            kind: 'promote',
            assetKind: row.assetKind,
            assetId: row.assetId,
            action: { primitive: 'consolidate', reason: { kind: 'promotion-signals', detail: `reuse=${row.reuseCount},verify=${row.verifyCount},association=${associationSpread}` } },
            signals: { reuseCount: row.reuseCount, verifyCount: row.verifyCount, associationSpread, thresholds },
            source,
          },
        });
      }
    }

    // ② 降级/退役（J3：多信号去重 + 优先级排序；判据全来自既有检测器）
    const signalToReason = (kind: string): string => kind;
    const demoted = new Map<string, string>();
    for (const row of rows) {
      for (const kind of params.demotePriority) {
        if ((row.retireSignals ?? []).includes(signalToReason(kind))) {
          demoted.set(row.assetId, kind);
          break; // 多信号命中只产一个动作（取最高优先级）
        }
      }
    }
    for (const [assetId, kind] of [...demoted.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
      const row = rows.find((candidate) => candidate.assetId === assetId)!;
      const risk = kind === 'capacity' ? ('high' as const) : ('low' as const);
      out.push({
        risk,
        proposal: {
          kind: 'demote',
          assetKind: row.assetKind,
          assetId,
          action: { primitive: 'retire', reason: { kind, detail: `demote-priority=${kind}` } },
          signals: { reuseCount: row.reuseCount, verifyCount: row.verifyCount, associationSpread: new Set(row.taskIds).size, thresholds },
          source,
        },
      });
    }

    // ③ 容量强制淘汰（J12/J6：跨资产统一分排序，最低者淘汰）
    for (const kind of ['memory', 'meta-thinking', 'skill'] as const) {
      const kindRows = rows.filter((row) => row.assetKind === kind && row.lifecycle === 'consolidated');
      const cap = params.capacityCaps[kind];
      const zone = kindRows.length > cap ? 'over' : kindRows.length >= cap * 0.8 ? 'pressure' : 'normal';
      if (zone === 'over' && kindRows.length > 0) {
        const lowest = kindRows
          .map((row) => scoreOf(row, params, at))
          .sort((a, b) => a.score - b.score)[0]!;
        out.push({
          risk: 'high',
          proposal: {
            kind: 'demote',
            assetKind: kind,
            assetId: lowest.assetId,
            action: { primitive: 'retire', reason: { kind: 'capacity', detail: `over-cap=${kindRows.length}>${cap}` } },
            signals: {
              reuseCount: kindRows.find((row) => row.assetId === lowest.assetId)!.reuseCount,
              verifyCount: kindRows.find((row) => row.assetId === lowest.assetId)!.verifyCount,
              associationSpread: 0,
              thresholds,
            },
            source,
          },
        });
      }
    }

    // ④ 冲突合并（J4①：near-dup/contradiction 的合并编排 = supersede 新条目）
    for (const conflict of deps.signals.conflicts?.() ?? []) {
      out.push({
        risk: 'high',
        proposal: {
          kind: 'coordinate',
          assetKind: conflict.assetKind,
          assetId: conflict.assetId,
          action: { primitive: 'supersede', reason: { kind: 'conflict-merge', detail: `with=${conflict.withIds.join(',')}` } },
          signals: { reuseCount: 0, verifyCount: 0, associationSpread: 0, thresholds },
          source,
        },
      });
    }
    return out.slice(0, params.caps.maxActions);
  };

  /** 提议执行（翻译 primitive 为治理调用，J1；渐进降级不跳级，不变量 5）。 */
  const execute = async (
    actor: MaintenanceActor,
    proposal: MaintenanceProposal,
    token?: string,
  ): Promise<string> => {
    const opts = token !== undefined ? { approvalToken: token } : undefined;
    let actionId = '';
    switch (proposal.action.primitive) {
      case 'consolidate':
        await deps.governance.consolidate(actor, proposal.assetId, proposal.assetKind);
        break;
      case 'retire':
        await deps.governance.retire(
          actor,
          proposal.assetId,
          proposal.action.reason,
          opts,
          proposal.assetKind,
        );
        break;
      case 'restore':
        await deps.governance.restore(actor, proposal.assetId, proposal.assetKind);
        break;
      case 'propose-invalidate':
        // 渐进降级不跳级（不变量 5）：retired 前不得 invalidate
        if (deps.governance.lifecycleOf(proposal.assetId, proposal.assetKind) !== 'retired') {
          throw new TdaError('MAINT_NOT_RETIRED', `资产 ${proposal.assetId} 未 retired，不得 propose-invalidate（降权→归档→删除）`);
        }
        await deps.governance.proposeInvalidate(actor, proposal.assetId, proposal.action.reason.detail, opts);
        break;
      case 'supersede':
        // 合并的执行体 = 资产服务 supersede（v1 经治理留痕 + 对账位）
        await deps.governance.retire(actor, proposal.assetId, proposal.action.reason, opts, proposal.assetKind);
        break;
    }
    const last = deps.governance
      .actions(proposal.assetId)
      .filter((action) => action.assetId === proposal.assetId)
      .at(-1);
    actionId = last !== undefined ? String(last.id) : '';
    return actionId;
  };

  return {
    async initialize() {
      loadParams();
      for (const [key, value] of proposalsTable.entries()) proposals.set(key, value as MaintenanceProposal);
      proposalCounter = [...proposalsTable.keys()].length;
      actionCounter = [...actionsTable.keys()].length;
      reportCounter = [...reportsTable.keys()].length;
      if (paramsTable.get(MAINTENANCE_PARAMS_KEY) === undefined) {
        await emit({
          family: 'maintenance/change',
          businessId: MAINTENANCE_PARAMS_BUSINESS_ID,
          payload: maintenanceParamsPayload(loadParams()),
          domainWrite: async () => {
            await paramsTable.put(MAINTENANCE_PARAMS_KEY, loadParams() as never);
          },
        });
      }
    },

    async cycle(trigger) {
      const params = loadParams();
      const startedAt = clock();
      try {
        const rows = deps.signals.assets().slice(0, params.caps.maxScanned);
        const generated = generateProposals(rows, params, {
          kind: trigger.kind === 'coach-review' ? 'coach' : 'scan',
          ...(trigger.ref !== undefined ? { ref: trigger.ref } : {}),
        });
        const athleteActive = deps.signals.isAthleteActive?.() ?? false;
        const proposalIds: string[] = [];
        let autoExecuted = 0;
        let pendingApproval = 0;
        let deferredActive = 0;

        for (const item of generated) {
          const at = clock();
          const proposal: MaintenanceProposal = {
            id: `mp-${++proposalCounter}` as never,
            ...item.proposal,
            risk: item.risk,
            status: 'queued',
            createdAt: at,
          };
          // 风险分级（J8）+ 让位（J7）：主任务活跃期非紧急提议 defer
          if (athleteActive && item.risk === 'low') {
            deferredActive += 1;
            await persistProposal(proposal, 'defer');
            proposalIds.push(String(proposal.id));
            continue;
          }
          if (item.risk === 'high') {
            pendingApproval += 1;
            await persistProposal(proposal, 'queue');
            proposalIds.push(String(proposal.id));
            continue;
          }
          // low 风险自动执行（经治理原语，J1）
          try {
            const govActionId = await execute({ sessionId: deps.session.sessionId, actor: 'scheduler' }, proposal);
            const executed: MaintenanceProposal = {
              ...proposal,
              status: 'executed',
              ...(govActionId !== '' ? { govActionId } : {}),
              resolvedAt: clock(),
            };
            await persistProposal(executed, 'auto-execute');
            const action: MaintenanceAction = {
              id: `ma-${++actionCounter}` as never,
              proposalId: String(proposal.id),
              op: 'auto-execute',
              actor: { sessionId: deps.session.sessionId, actor: 'scheduler', at: clock() },
              result: 'ok',
              at: clock(),
            };
            await emit({
              family: 'maintenance/change',
              businessId: `${MAINTENANCE_ACTION_BUSINESS_PREFIX}:${String(action.id)}`,
              payload: maintenanceActionPayload(action),
              domainWrite: async () => {
                await actionsTable.put(String(action.id), action as never);
              },
            });
            autoExecuted += 1;
          } catch (error) {
            // 执行失败 = failed 提议（C5 显式终态），不静默吞
            await persistProposal(
              { ...proposal, status: 'rejected', resolvedAt: clock() },
              `failed:${error instanceof Error ? error.message : String(error)}`,
            );
          }
          proposalIds.push(String(proposal.id));
        }

        // 容量报表（J12/J6 数据面）
        const capacity: MaintenanceReport['capacity'] = {};
        for (const kind of ['memory', 'meta-thinking', 'skill'] as const) {
          const active = rows.filter((row) => row.assetKind === kind && row.lifecycle === 'consolidated').length;
          const cap = params.capacityCaps[kind];
          capacity[kind] = {
            active,
            cap,
            zone: active > cap ? 'over' : active >= cap * 0.8 ? 'pressure' : 'normal',
          };
        }
        const report: MaintenanceReport = {
          id: `mr-${++reportCounter}` as never,
          trigger: { kind: trigger.kind, at: startedAt },
          stats: {
            scanned: rows.length,
            proposed: generated.length,
            autoExecuted,
            pendingApproval,
            rejected: 0,
            deferredActive,
          },
          capacity,
          proposalIds,
          at: clock(),
        };
        await emit({
          family: 'maintenance/change',
          businessId: `${MAINTENANCE_REPORT_BUSINESS_PREFIX}:${String(report.id)}`,
          payload: maintenanceReportPayload(report),
          domainWrite: async () => {
            await reportsTable.put(String(report.id), report as never);
          },
        });
        return report;
      } catch (error) {
        const report: MaintenanceReport = {
          id: `mr-${++reportCounter}` as never,
          trigger: { kind: trigger.kind, at: startedAt },
          stats: { scanned: 0, proposed: 0, autoExecuted: 0, pendingApproval: 0, rejected: 0, deferredActive: 0 },
          capacity: {},
          proposalIds: [],
          unfinished: [`cycle: ${error instanceof Error ? error.message : String(error)}`],
          at: clock(),
        };
        await emit({
          family: 'maintenance/change',
          businessId: `${MAINTENANCE_REPORT_BUSINESS_PREFIX}:${String(report.id)}`,
          payload: maintenanceReportPayload(report),
          domainWrite: async () => {
            await reportsTable.put(String(report.id), report as never);
          },
        });
        return report;
      }
    },

    proposals(filter = {}) {
      return [...proposals.values()]
        .filter((row) => (filter.status !== undefined ? row.status === filter.status : true))
        .filter((row) => (filter.kind !== undefined ? row.kind === filter.kind : true))
        .filter((row) => (filter.risk !== undefined ? row.risk === filter.risk : true))
        .filter((row) => (filter.assetKind !== undefined ? row.assetKind === filter.assetKind : true))
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    },

    async approve(proposalId, token) {
      const proposal = proposals.get(proposalId);
      if (proposal === undefined) throw new TdaError('MAINT_PROPOSAL_NOT_FOUND', `提议 ${proposalId} 不存在`);
      if (proposal.risk !== 'high') throw new TdaError('MAINT_NOT_HIGH_RISK', '低风险提议自动执行，无需审批');
      if (proposal.status !== 'queued') throw new TdaError('MAINT_NOT_QUEUED', `提议 ${proposalId} 当前 ${proposal.status}`);
      if (token === '') throw new TdaError('MAINT_TOKEN_REQUIRED', '高风险审批需非空一次性 token（J8）');
      if (consumedTokens.has(token)) throw new TdaError('MAINT_TOKEN_REUSED', '审批 token 已消费（一次性纪律）');
      consumedTokens.add(token);
      const govActionId = await execute({ sessionId: deps.session.sessionId, actor: 'human' }, proposal, token);
      const executed: MaintenanceProposal = { ...proposal, status: 'executed', govActionId, resolvedAt: clock() };
      await persistProposal(executed, 'approve');
      const action: MaintenanceAction = {
        id: `ma-${++actionCounter}` as never,
        proposalId,
        op: 'approve',
        actor: { sessionId: deps.session.sessionId, actor: 'human', at: clock() },
        approvalToken: token,
        result: 'ok',
        at: clock(),
      };
      await emit({
        family: 'maintenance/change',
        businessId: `${MAINTENANCE_ACTION_BUSINESS_PREFIX}:${String(action.id)}`,
        payload: maintenanceActionPayload(action),
        domainWrite: async () => {
          await actionsTable.put(String(action.id), action as never);
        },
      });
      return action;
    },

    async reject(proposalId, _reason) {
      void _reason;
      const proposal = proposals.get(proposalId);
      if (proposal === undefined) throw new TdaError('MAINT_PROPOSAL_NOT_FOUND', `提议 ${proposalId} 不存在`);
      if (proposal.status !== 'queued') throw new TdaError('MAINT_NOT_QUEUED', `提议 ${proposalId} 当前 ${proposal.status}`);
      const rejected: MaintenanceProposal = { ...proposal, status: 'rejected', resolvedAt: clock() };
      await persistProposal(rejected, 'reject');
      const action: MaintenanceAction = {
        id: `ma-${++actionCounter}` as never,
        proposalId,
        op: 'reject',
        actor: { sessionId: deps.session.sessionId, actor: 'human', at: clock() },
        result: 'ok',
        at: clock(),
      };
      await emit({
        family: 'maintenance/change',
        businessId: `${MAINTENANCE_ACTION_BUSINESS_PREFIX}:${String(action.id)}`,
        payload: maintenanceActionPayload(action),
        domainWrite: async () => {
          await actionsTable.put(String(action.id), action as never);
        },
      });
      return action;
    },

    scoreboard() {
      const params = loadParams();
      return deps
        .signals.assets()
        .map((row) => scoreOf(row, params, clock()))
        .sort((a, b) => b.score - a.score);
    },

    async enqueueFromCoach(candidateIds) {
      if (deps.coachCandidates === undefined) {
        throw new TdaError('MAINT_COACH_SEAM_MISSING', 'coach 候选 seam 未接入（T2.1 装配层履约）');
      }
      const out: MaintenanceProposal[] = [];
      for (const candidate of deps.coachCandidates()) {
        if (!candidateIds.includes(String(candidate.id))) continue;
        if (candidate.targetRef === undefined) continue;
        const at = clock();
        const proposal: MaintenanceProposal = {
          id: `mp-${++proposalCounter}` as never,
          kind: 'promote',
          assetKind: (candidate.assetKind as MaintenanceAssetKind | undefined) ?? 'memory',
          assetId: candidate.targetRef,
          action: { primitive: 'consolidate', reason: { kind: 'coach-submitted', detail: `candidate=${String(candidate.id)}` } },
          signals: {
            reuseCount: 0,
            verifyCount: 1,
            associationSpread: 0,
            thresholds: { ...loadParams().promoteThresholds },
          },
          risk: candidate.risk === 'high' ? 'high' : 'low',
          status: 'queued',
          source: { kind: 'coach', ref: String(candidate.id) },
          createdAt: at,
        };
        await persistProposal(proposal, 'enqueue');
        out.push(proposal);
      }
      return out;
    },

    reports(limit) {
      const list = [...reportsTable.entries()].map(([, value]) => value as MaintenanceReport);
      const sorted = list.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
      return limit !== undefined ? sorted.slice(-limit) : sorted;
    },

    params() {
      return loadParams();
    },

    async setParams(patch) {
      const current = loadParams();
      const next = ParamsSchema.parse({
        ...current,
        ...patch,
        caps: { ...current.caps, ...(patch.caps ?? {}) },
        promoteThresholds: { ...current.promoteThresholds, ...(patch.promoteThresholds ?? {}) },
        scoreWeights: { ...current.scoreWeights, ...(patch.scoreWeights ?? {}) },
        capacityCaps: { ...current.capacityCaps, ...(patch.capacityCaps ?? {}) },
        revision: current.revision + 1,
      });
      paramsRef = next;
      await emit({
        family: 'maintenance/change',
        businessId: MAINTENANCE_PARAMS_BUSINESS_ID,
        payload: maintenanceParamsPayload(next),
        domainWrite: async () => {
          await paramsTable.put(MAINTENANCE_PARAMS_KEY, next as never);
        },
      });
      return next;
    },
  };
}

export { maintenanceDomainSpec };
