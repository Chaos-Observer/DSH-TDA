/**
 * T3.1 分层知识图谱 · 服务（ctx.knowledge）。
 *
 * 硬纪律落地：
 * - J3 三权威：内容=时间线 chunk（consolidated 时物化）；结构=Graphiti（seam）；
 *   映射/元数据=本 domain。episode 载荷=summary+证据引用，零正文。
 * - J5 治理单一：无 lifecycle 写路径——出库经 ctx.governance（assetKind='knowledge'）。
 * - J7 双帽：MOC 层级≤depthCap、单条目 MOC 父数≤fanInCap（建边断言）。
 * - J9 凭证继承：entry.credential = min(证据 chunk 凭证)。
 * - J10 外置降级：provider 缺席/断连 → 邻接降级为事件图投影 + 队列重放，主链路不阻断。
 * - promise 链锁不可重入：公开方法加锁包装，内部实现 applyXxx 无锁（25 条纪律）。
 * - domain put 异步：initialize await 播种 + 内存权威引用（P2 补记 1）。
 */
import {
  TdaError,
  dualWrite,
  dualWriteDerived,
  asKnowledgeEntryId,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteOp,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  DEFAULT_KNOWLEDGE_PARAMS,
  KNOWLEDGE_CREDENTIAL_RANK,
  KNOWLEDGE_PARAMS_BUSINESS_ID,
  KNOWLEDGE_PARAMS_KEY,
  knowledgeDomainSpec,
  type DistillSourceChunk,
  type KnowledgeCandidate,
  type KnowledgeEdge,
  type KnowledgeEdgeKind,
  type KnowledgeEntry,
  type KnowledgeEvent,
  type KnowledgeParams,
  type KnowledgeRun,
  type KnowledgeTables,
} from './domain.ts';
import {
  KNOWLEDGE_ENTRY_BUSINESS_PREFIX,
  KNOWLEDGE_RUN_BUSINESS_PREFIX,
  knowledgeEntryPayload,
  knowledgeParamsPayload,
  knowledgeRunPayload,
} from './events.ts';

/** Graphiti 外置服务 seam（J10）：不可用 → 降级 + 队列重放，不伪造图态。 */
export interface KnowledgeGraphProvider {
  /** 服务是否可用（断连探测由实现方承担；false 时写入排队）。 */
  available(): boolean;
  ingest(entry: KnowledgeEntry): Promise<string>;
  invalidate(entryId: string, graphRef: string): Promise<void>;
  reassert(entry: KnowledgeEntry): Promise<string>;
  neighbors(entryId: string, depth: number): { entries: { ref: string; summary: string }[]; edges: KnowledgeEdge[] };
}

/** 蒸馏执行 seam（生产=Sidekick 子代理经 T0.5；禁原文出子代理——输入是簇摘要）。 */
export interface KnowledgeDistiller {
  distill(cluster: readonly DistillSourceChunk[]): Promise<KnowledgeCandidate[]>;
}

/** 时间线读取面（源簇检索 + 证据存在性 + 物化写）。 */
export interface KnowledgeTimelineSeam {
  search(query: string, opts?: { readonly limit?: number }): readonly {
    readonly id: string;
    readonly summary: string;
    readonly credential: string;
    readonly relatedTaskId?: string;
    readonly trajectoryRef?: string;
    readonly at: number;
  }[];
  get(entryId: string): { readonly id: string; readonly credential: string; readonly trajectoryRef?: string } | undefined;
  append(input: {
    readonly title: string;
    readonly summary: string;
    readonly chunkType: 'fact' | 'method';
    readonly credential: string;
    readonly relatedTaskId?: string;
  }): Promise<string>;
  invalidate(entryId: string, reason: string): Promise<void>;
}

/** 维护信号读取（T2.3 升格三源 → 蒸馏触发一路；v1 只读消费）。 */
export interface KnowledgeMaintenanceSeam {
  upgrades(): readonly { readonly assetId: string; readonly title: string; readonly taskClass: string }[];
}

export interface KnowledgeDeps {
  readonly domain: TdaDomain<KnowledgeTables>;
  readonly session: TdaSessionSink;
  readonly timeline: KnowledgeTimelineSeam;
  readonly governance: {
    consolidate(
      actor: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string },
      assetId: string,
      assetKind?: string,
    ): Promise<unknown>;
    lifecycleOf(assetId: string, assetKind?: string): string | undefined;
  };
  readonly provider?: KnowledgeGraphProvider | undefined;
  readonly distiller?: KnowledgeDistiller | undefined;
  readonly maintenance?: KnowledgeMaintenanceSeam | undefined;
  readonly bus?: TdaEventBus | undefined;
  readonly reconciler?: DualWriteReconciler | undefined;
  readonly index?: AuditIndex | undefined;
  readonly now: () => number;
  /** 审批凭证（出库阀的人类 token 路，J5）；v1 由调用方直接给 token 串。 */
  readonly actor?: { readonly actor: 'agent' | 'human' | 'coach' | 'scheduler'; readonly sessionId: string };
}

export interface ValidationReport {
  readonly entryId: string;
  readonly evidenceComplete: boolean;
  readonly credential: string;
  readonly contradictions: { readonly withEntryId: string; readonly edgeKind: KnowledgeEdgeKind }[];
  readonly missingChunkRefs: string[];
}

export interface KnowledgeService {
  initialize(): Promise<void>;
  distill(trigger: { kind: 'maintenance' | 'periodic' | 'manual'; clusterRefs?: readonly string[] }): Promise<KnowledgeRun>;
  propose(candidate: KnowledgeCandidate, by: 'coach' | 'human'): Promise<KnowledgeEntry>;
  validate(entryId: string): ValidationReport;
  requestConsolidate(entryId: string, opts?: { readonly humanToken?: string }): Promise<KnowledgeEntry>;
  recordReuse(entryId: string): void;
  link(fromId: string, toId: string, kind: KnowledgeEdgeKind, evidence: readonly string[]): Promise<KnowledgeEdge>;
  unlink(edgeId: string, reason: string): Promise<void>;
  reassert(entryId: string, by: 'human' | 'coach'): Promise<KnowledgeEntry>;
  invalidate(entryId: string, reason: string): Promise<KnowledgeEntry>;
  edges(): readonly KnowledgeEdge[];
  entries(filter?: { kind?: string; status?: string }): readonly KnowledgeEntry[];
  entry(entryId: string): KnowledgeEntry;
  neighbors(entryId: string, depth?: number): { entries: readonly KnowledgeEntry[]; edges: readonly KnowledgeEdge[] };
  expand(refs: readonly string[]): readonly { readonly entryId: string; readonly title: string; readonly summary: string; readonly credential: string }[];
  history(entryId: string): readonly KnowledgeEntry[];
  runs(): readonly KnowledgeRun[];
  params(): KnowledgeParams;
  setParams(patch: Partial<Omit<KnowledgeParams, 'revision'>>): Promise<KnowledgeParams>;
  flushQueued(): Promise<number>;
  dispose(): Promise<void>;
}

const ENTRY_PREFIX = 'kn';

export function createKnowledgeService(deps: KnowledgeDeps): KnowledgeService {
  const entriesTable = deps.domain.table('knowledge_entries');
  const eventsTable = deps.domain.table('knowledge_events');
  const runsTable = deps.domain.table('knowledge_runs');
  const paramsTable = deps.domain.table('knowledge_params');

  const clock = deps.now;
  const actor = deps.actor ?? { actor: 'scheduler' as const, sessionId: String(deps.session.sessionId) };
  let paramsRef: KnowledgeParams | undefined;
  let entrySeq = 0;
  let eventSeq = 0;
  let runSeq = 0;
  let edgeSeq = 0;
  const entries = new Map<string, KnowledgeEntry>();
  const edges = new Map<string, KnowledgeEdge>();
  const queuedWrites: { readonly kind: 'invalidate' | 'reassert'; readonly entry: KnowledgeEntry }[] = [];

  // 双写 + 总线快速路径（审计权威=会话日志；bus 仅供联动订阅）。
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

  // knowledge_events 是权威日志：域写必经双写窗口（会话事件 = 重放基底，J11）。
  const recordEvent = async (event: Omit<KnowledgeEvent, 'id' | 'at'>): Promise<void> => {
    eventSeq += 1;
    const row: KnowledgeEvent = { id: `ke-${eventSeq}`, at: clock(), ...event };
    await emit({
      family: 'knowledge/change',
      businessId: `knowledge-event:${row.id}`,
      payload: {
        id: row.id,
        kind: row.kind,
        ...(row.entryId !== undefined ? { entryId: row.entryId } : {}),
        detail: row.detail as never,
        at: row.at,
      },
      domainWrite: async () => {
        events.set(String(row.id), row);
        await eventsTable.put(String(row.id), row as never);
      },
    });
  };
  const events = new Map<string, KnowledgeEvent>();

  const loadParams = (): KnowledgeParams => {
    if (paramsRef !== undefined) return paramsRef;
    const row = paramsTable.get(KNOWLEDGE_PARAMS_KEY) as KnowledgeParams | undefined;
    paramsRef = row ?? { ...DEFAULT_KNOWLEDGE_PARAMS };
    return paramsRef;
  };

  /** 凭证继承（J9/不变量 4）：entry.credential = min(证据 chunk 凭证)。 */
  const inheritCredential = (chunkRefs: readonly string[]): { credential: string; missing: string[] } => {
    let best = Number.POSITIVE_INFINITY;
    let credential = 'model-produced';
    const missing: string[] = [];
    for (const ref of chunkRefs) {
      const chunk = deps.timeline.get(ref);
      if (chunk === undefined) {
        missing.push(ref);
        continue;
      }
      const rank = KNOWLEDGE_CREDENTIAL_RANK[chunk.credential] ?? 0;
      if (rank < best) {
        best = rank;
        credential = chunk.credential;
      }
    }
    if (chunkRefs.length === 0) credential = 'model-produced';
    return { credential, missing };
  };

  const allocateEntryId = (): string => {
    let candidate = '';
    do {
      entrySeq += 1;
      candidate = `${ENTRY_PREFIX}-${entrySeq}`;
    } while (entries.has(candidate));
    return candidate;
  };

  const persistEntry = async (entry: KnowledgeEntry): Promise<void> => {
    entries.set(String(entry.entryId), entry);
    const key = `${String(entry.entryId)}#v${entry.version}`;
    await entriesTable.put(key, entry as never);
  };

  const emitEntry = async (entry: KnowledgeEntry, action: string): Promise<void> => {
    await emit({
      family: 'knowledge/change',
      businessId: `${KNOWLEDGE_ENTRY_BUSINESS_PREFIX}:${String(entry.entryId)}#v${entry.version}`,
      payload: knowledgeEntryPayload(entry),
      domainWrite: async () => {
        await persistEntry(entry);
      },
    });
    await recordEvent({
      kind:
        action === 'consolidated'
          ? 'entry-consolidated'
          : action === 'ingested'
            ? 'entry-ingested'
            : action === 'invalidated'
              ? 'entry-invalidated'
              : action === 'reasserted'
                ? 'entry-reasserted'
                : 'candidate-proposed',
      entryId: String(entry.entryId),
      detail: { status: entry.status, version: entry.version },
    });
  };

  const requireEntry = (entryId: string): KnowledgeEntry => {
    const entry = entries.get(entryId);
    if (entry === undefined) {
      throw new TdaError('KNOWLEDGE_ENTRY_NOT_FOUND', `知识条目 ${entryId} 不存在`);
    }
    return entry;
  };

  /** 当前边集合（权威=Graphiti/事件投影；本 map 是运行期镜像）。 */
  const rebuildEdges = (): void => {
    edges.clear();
    for (const [, event] of events) {
      if (event.kind === 'link-added') {
        const detail = event.detail as { edgeId?: string; fromId?: string; toId?: string; kind?: KnowledgeEdgeKind; evidence?: string[] };
        if (detail.edgeId !== undefined && detail.fromId !== undefined && detail.toId !== undefined) {
          edges.set(detail.edgeId, {
            edgeId: detail.edgeId,
            fromId: detail.fromId,
            toId: detail.toId,
            kind: detail.kind ?? 'relates-to',
            evidence: detail.evidence ?? [],
          });
        }
      } else if (event.kind === 'link-removed') {
        const detail = event.detail as { edgeId?: string; removedAt?: number };
        if (detail.edgeId !== undefined) {
          const existing = edges.get(detail.edgeId);
          if (existing !== undefined) edges.set(detail.edgeId, { ...existing, removedAt: detail.removedAt ?? event.at });
        }
      }
    }
  };

  /** 分层双帽（J7/不变量 6）：MOC 层级 ≤ depthCap、单条目 MOC 父数 ≤ fanInCap。 */
  const assertLinkCaps = (fromId: string, toId: string, kind: KnowledgeEdgeKind): void => {
    const config = loadParams();
    if (kind === 'part-of') {
      // 语义：link(child, parent, 'part-of')——父数 = child 已有的 part-of 出边数。
      const parents = [...edges.values()].filter(
        (edge) => edge.kind === 'part-of' && edge.fromId === fromId && edge.removedAt === undefined,
      );
      if (parents.length >= config.fanInCap) {
        throw new TdaError(
          'KNOWLEDGE_FANIN_CAP',
          `条目 ${fromId} 的 MOC 父数已达 fanInCap=${config.fanInCap}（防 wiki 迷宫）`,
        );
      }
      // 层级 = 1 + 祖先链长：从 parent 沿"child→parent"边向上走。
      let depth = 1;
      let cursor: string | undefined = toId;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        const parentEdge = [...edges.values()].find(
          (edge) => edge.kind === 'part-of' && edge.fromId === cursor && edge.removedAt === undefined,
        );
        if (parentEdge === undefined) break;
        depth += 1;
        cursor = parentEdge.toId;
      }
      if (depth > config.depthCap) {
        throw new TdaError('KNOWLEDGE_DEPTH_CAP', `MOC 层级将超 depthCap=${config.depthCap}（防 wiki 迷宫）`);
      }
    }
  };

  const service: KnowledgeService = {
    async initialize() {
      loadParams();
      rebuildEdges();
      for (const [, value] of entriesTable.entries()) {
        const entry = value as KnowledgeEntry;
        entries.set(String(entry.entryId), entry);
      }
      if (paramsTable.get(KNOWLEDGE_PARAMS_KEY) === undefined) {
        await dualWrite(
          deps.session,
          {
            family: 'knowledge/change',
            businessId: KNOWLEDGE_PARAMS_BUSINESS_ID,
            payload: knowledgeParamsPayload(loadParams()),
            domainWrite: async () => {
              await paramsTable.put(KNOWLEDGE_PARAMS_KEY, loadParams() as never);
            },
          },
          context,
        );
      }
    },

    async propose(candidate, by) {
      if (candidate.title.length === 0 || candidate.title.length > 60) {
        throw new TdaError('KNOWLEDGE_TITLE_LEN', `条目标题须 1–60 字符（收 ${candidate.title.length}）`);
      }
      if (candidate.summary.length === 0 || candidate.summary.length > 300) {
        throw new TdaError('KNOWLEDGE_SUMMARY_LEN', `条目摘要须 1–300 字符（收 ${candidate.summary.length}）`);
      }
      const { credential, missing } = inheritCredential(candidate.evidenceChunkRefs);
      if (missing.length === candidate.evidenceChunkRefs.length && candidate.evidenceChunkRefs.length > 0) {
        throw new TdaError('KNOWLEDGE_EVIDENCE_MISSING', `证据 chunk 全部缺失（${missing.join(',')}）`);
      }
      const at = clock();
      const entry: KnowledgeEntry = {
        entryId: asKnowledgeEntryId(allocateEntryId()),
        version: 1,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        status: 'draft',
        credential,
        validity: { validFrom: at, ingestedAt: at },
        evidence: {
          chunkRefs: [...candidate.evidenceChunkRefs],
          trajectoryRefs: candidate.evidenceChunkRefs
            .map((ref) => deps.timeline.get(ref)?.trajectoryRef)
            .filter((ref): ref is string => ref !== undefined),
        },
        stats: { reuseCount: 0, verifyCount: 0, associationSpread: candidate.edges.length },
        createdBy: by,
        createdAt: at,
        updatedAt: at,
      };
      await emitEntry(entry, 'proposed');
      // 同批候选互边（按 title 对齐，J6/3.1）。
      for (const edge of candidate.edges) {
        const target = [...entries.values()].find((item) => item.title === edge.toTitle && item.status !== 'retired');
        if (target !== undefined) {
          await service.link(String(entry.entryId), String(target.entryId), edge.kind, []);
        }
      }
      return entry;
    },

    async distill(trigger) {
      const config = loadParams();
      runSeq += 1;
      const runId = `kr-${runSeq}`;
      const run: KnowledgeRun = {
        runId: runId as never,
        trigger: {
          kind: trigger.kind,
          ...(trigger.clusterRefs !== undefined ? { clusterRefs: [...trigger.clusterRefs] } : {}),
        },
        status: 'clustering',
        clusterCount: 0,
        candidatesProposed: [],
        skipped: [],
        reportChunkIds: [],
        startedAt: clock(),
      };
      try {
        if (deps.distiller === undefined) {
          throw new TdaError('KNOWLEDGE_DISTILLER_MISSING', '蒸馏执行 seam 未就绪（KnowledgeDistiller）');
        }
        // ① 聚类（确定性）：relatedTaskId + 关键词共现的确定性分组，≤clusterCap。
        const sources: readonly DistillSourceChunk[] =
          trigger.clusterRefs !== undefined
            ? trigger.clusterRefs
                .map((ref) => deps.timeline.get(ref))
                .filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== undefined)
                .map((chunk) => ({
                  entryId: chunk.id,
                  summary: chunk.id,
                  credential: chunk.credential,
                  ...(chunk.trajectoryRef !== undefined ? { trajectoryRef: chunk.trajectoryRef } : {}),
                  at: clock(),
                }))
            : deps.timeline
                .search('knowledge-distill', { limit: config.clusterCap * 2 })
                .map((chunk) => ({
                  entryId: chunk.id,
                  summary: chunk.summary,
                  credential: chunk.credential,
                  ...(chunk.relatedTaskId !== undefined ? { relatedTaskId: chunk.relatedTaskId } : {}),
                  ...(chunk.trajectoryRef !== undefined ? { trajectoryRef: chunk.trajectoryRef } : {}),
                  at: chunk.at,
                }));
        const byTask = new Map<string, DistillSourceChunk[]>();
        for (const chunk of sources) {
          const key = chunk.relatedTaskId ?? '_global';
          const bucket = byTask.get(key) ?? [];
          bucket.push(chunk);
          byTask.set(key, bucket);
        }
        const clusters = [...byTask.values()].filter((bucket) => bucket.length >= 2).slice(0, config.clusterCap);
        run.clusterCount = clusters.length;
        run.status = 'distilling';
        // ② Sidekick 蒸馏（并发≤distillConcurrency：v1 顺序即满足 ≥1）。
        const candidates: { clusterRef: string; candidate: KnowledgeCandidate }[] = [];
        for (const [index, cluster] of clusters.entries()) {
          const produced = await deps.distiller.distill(cluster.slice(0, config.clusterCap));
          for (const candidate of produced) candidates.push({ clusterRef: cluster[0]?.entryId ?? `c${index}`, candidate });
        }
        // ③ 确定性验证（证据存在性 + 凭证继承 + 矛盾检测）→ draft 落库。
        run.status = 'validating';
        for (const { clusterRef, candidate } of candidates) {
          const { missing } = inheritCredential(candidate.evidenceChunkRefs);
          const evidenceComplete = missing.length === 0;
          if (!evidenceComplete) {
            run.skipped.push({ reason: `evidence-missing:${missing.join(',')}`, clusterRef });
            continue;
          }
          const entry = await service.propose(candidate, 'coach');
          run.candidatesProposed.push(String(entry.entryId));
        }
        run.status = 'recorded';
        run.endedAt = clock();
      } catch (error) {
        // fail-loud 进显式终态（C5）：failed(stage+reason)，不静默重试。
        run.stage = run.status === 'clustering' ? 'cluster' : run.status === 'distilling' ? 'distill' : 'validate';
        run.status = 'failed';
        run.failureReason = error instanceof Error ? error.message : String(error);
        run.endedAt = clock();
      }
      await emit({
        family: 'knowledge/change',
        businessId: `${KNOWLEDGE_RUN_BUSINESS_PREFIX}:${String(run.runId)}`,
        payload: knowledgeRunPayload(run),
        domainWrite: async () => {
          await runsTable.put(String(run.runId), run as never);
        },
      });
      await recordEvent({ kind: 'distill-end', detail: { runId: String(run.runId), status: run.status } });
      return run;
    },

    validate(entryId) {
      const entry = requireEntry(entryId);
      const missing: string[] = [];
      for (const ref of entry.evidence.chunkRefs) {
        if (deps.timeline.get(ref) === undefined) missing.push(ref);
      }
      // 矛盾检测：本条目作为 from/to 的 contradicts 边。
      const contradictions = [...edges.values()]
        .filter((edge) => edge.removedAt === undefined && (edge.fromId === entryId || edge.toId === entryId) && edge.kind === 'contradicts')
        .map((edge) => ({ withEntryId: edge.fromId === entryId ? edge.toId : edge.fromId, edgeKind: edge.kind }));
      return {
        entryId,
        evidenceComplete: missing.length === 0,
        credential: entry.credential,
        contradictions,
        missingChunkRefs: missing,
      };
    },

    async requestConsolidate(entryId, opts) {
      const entry = requireEntry(entryId);
      if (entry.status !== 'draft' && entry.status !== 'validating') {
        throw new TdaError('KNOWLEDGE_NOT_DRAFT', `条目 ${entryId} 当前 ${entry.status}，出库只能从 draft/validating 起`);
      }
      // 出库阀（J5/不变量 5）：（≥1 真实复用 ∧ 证据完备）∨ 人类审查 token。
      const report = service.validate(entryId);
      const reuseOk = entry.stats.reuseCount >= 1;
      const withToken = opts?.humanToken !== undefined && opts.humanToken !== '';
      if (!withToken && !(reuseOk && report.evidenceComplete)) {
        throw new TdaError(
          'KNOWLEDGE_OUT_VALVE',
          `零复用/证据不全的固化拒绝（reuse=${entry.stats.reuseCount} verify=${entry.stats.verifyCount} evidence=${report.evidenceComplete}）——出库需复用/审查`,
        );
      }
      // 治理单一（J5）：迁移经 ctx.governance（assetKind='knowledge'）。
      await deps.governance.consolidate(actor, entryId, 'knowledge');
      const consolidated: KnowledgeEntry = {
        ...entry,
        status: 'consolidated',
        graphRef: entry.graphRef,
        updatedAt: clock(),
      };
      await emitEntry(consolidated, 'consolidated');
      // ingest 时序（J8）：物化 chunk 先（内容权威先行），Graphiti ingest 后。
      if (consolidated.chunkRef === undefined) {
        const chunkId = await deps.timeline.append({
          title: consolidated.title,
          summary: consolidated.summary,
          chunkType: consolidated.kind === 'method' ? 'method' : 'fact',
          credential: consolidated.credential,
        });
        const withChunk: KnowledgeEntry = { ...consolidated, chunkRef: chunkId, updatedAt: clock() };
        await emitEntry(withChunk, 'proposed');
        if (deps.provider?.available() === true) {
          const graphRef = await deps.provider.ingest(withChunk);
          const ingested: KnowledgeEntry = { ...withChunk, graphRef, updatedAt: clock() };
          await emitEntry(ingested, 'ingested');
        }
        return requireEntry(entryId);
      }
      if (deps.provider?.available() === true) {
        const graphRef = await deps.provider.ingest(consolidated);
        await emitEntry({ ...consolidated, graphRef, updatedAt: clock() }, 'ingested');
      }
      return requireEntry(entryId);
    },

    recordReuse(entryId) {
      const entry = requireEntry(entryId);
      const next: KnowledgeEntry = {
        ...entry,
        stats: { ...entry.stats, reuseCount: entry.stats.reuseCount + 1 },
        updatedAt: clock(),
      };
      // stats 增长 = 派生投影（同 log 可重算）：内存权威 + 派生窗落盘。
      entries.set(entryId, next);
      void dualWriteDerived(() => entriesTable.put(`${entryId}#v${next.version}`, next as never), context);
    },

    async link(fromId, toId, kind, evidence) {
      requireEntry(fromId);
      requireEntry(toId);
      assertLinkCaps(fromId, toId, kind);
      edgeSeq += 1;
      const edge: KnowledgeEdge = { edgeId: `kedge-${edgeSeq}`, fromId, toId, kind, evidence: [...evidence] };
      // 结构权威=Graphiti：available 时同步建图；不可用=主链路不阻断（事件留痕即最终一致基底）。
      await recordEvent({ kind: 'link-added', entryId: fromId, detail: { ...edge } });
      rebuildEdges();
      return edge;
    },

    async unlink(edgeId, reason) {
      const edge = edges.get(edgeId);
      if (edge === undefined) {
        throw new TdaError('KNOWLEDGE_EDGE_NOT_FOUND', `边 ${edgeId} 不存在`);
      }
      await recordEvent({ kind: 'link-removed', entryId: edge.fromId, detail: { edgeId, reason, removedAt: clock() } });
      rebuildEdges();
    },

    async reassert(entryId, by) {
      const entry = requireEntry(entryId);
      if (entry.status !== 'invalidated' && entry.status !== 'retired') {
        throw new TdaError('KNOWLEDGE_NOT_INVALIDATED', `条目 ${entryId} 当前 ${entry.status}，re-assert 只对失效/退役条目`);
      }
      // 版本可回滚（J4/不变量 3）：append 新版本（supersedes 链），不改历史。
      const at = clock();
      const next: KnowledgeEntry = {
        ...entry,
        entryId: asKnowledgeEntryId(allocateEntryId()),
        version: 1,
        supersedes: entryId,
        status: 'draft',
        validity: { validFrom: at, ingestedAt: at },
        updatedAt: at,
      };
      await emitEntry(next, 'proposed');
      await recordEvent({ kind: 'entry-reasserted', entryId, detail: { newEntryId: String(next.entryId), by } });
      if (deps.provider?.available() === true) {
        await deps.provider.reassert(next);
      } else {
        queuedWrites.push({ kind: 'reassert', entry: next });
        trimQueue();
      }
      return next;
    },

    async invalidate(entryId, reason) {
      const entry = requireEntry(entryId);
      if (entry.validity.validTo !== undefined) {
        throw new TdaError('KNOWLEDGE_ALREADY_INVALIDATED', `条目 ${entryId} 已失效（重复 invalidate）`);
      }
      // 失效不删（J4/不变量 3）：只置 validTo + 双记（Graphiti + T0.3 invalidate）。
      const next: KnowledgeEntry = {
        ...entry,
        status: 'invalidated',
        validity: { ...entry.validity, validTo: clock() },
        updatedAt: clock(),
      };
      await emitEntry(next, 'invalidated');
      await deps.timeline.invalidate(entryId, reason);
      if (deps.provider?.available() === true && entry.graphRef !== undefined) {
        await deps.provider.invalidate(entryId, entry.graphRef);
      } else {
        queuedWrites.push({ kind: 'invalidate', entry: next });
        trimQueue();
      }
      return requireEntry(entryId);
    },

    edges() {
      return [...edges.values()].filter((edge) => edge.removedAt === undefined);
    },

    entries(filter) {
      const all = [...entries.values()];
      if (filter === undefined) return all;
      return all.filter(
        (entry) =>
          (filter.kind === undefined || entry.kind === filter.kind) &&
          (filter.status === undefined || entry.status === filter.status),
      );
    },

    entry(entryId) {
      return requireEntry(entryId);
    },

    neighbors(entryId, depth = 1) {
      requireEntry(entryId);
      // 降级路径（J10/不变量 9）：provider 缺席/断连 → 事件图投影（本地邻接）。
      if (deps.provider?.available() === true) {
        const remote = deps.provider.neighbors(entryId, depth);
        const remoteEntries = remote.entries
          .map((item) => entries.get(item.ref))
          .filter((entry): entry is KnowledgeEntry => entry !== undefined);
        return { entries: remoteEntries, edges: remote.edges };
      }
      const frontier = new Set<string>([entryId]);
      const seen = new Set<string>([entryId]);
      const resultEdges: KnowledgeEdge[] = [];
      for (let d = 0; d < depth; d += 1) {
        const next = new Set<string>();
        for (const cursor of frontier) {
          for (const edge of edges.values()) {
            if (edge.removedAt !== undefined) continue;
            if (edge.fromId === cursor && !seen.has(edge.toId)) {
              resultEdges.push(edge);
              next.add(edge.toId);
            } else if (edge.toId === cursor && !seen.has(edge.fromId)) {
              resultEdges.push(edge);
              next.add(edge.fromId);
            }
          }
        }
        for (const id of next) seen.add(id);
        frontier.clear();
        for (const id of next) frontier.add(id);
      }
      return { entries: [...seen].filter((id) => id !== entryId).map((id) => entries.get(id)).filter((entry): entry is KnowledgeEntry => entry !== undefined), edges: resultEdges };
    },

    expand(refs) {
      // 图扩展候选源（J8）：证据引用了给定 chunk 的条目 + 其邻居，同池竞争（gate 先行不削弱）。
      const direct = [...entries.values()].filter((entry) =>
        entry.evidence.chunkRefs.some((ref) => refs.includes(ref)) && entry.status === 'consolidated',
      );
      const result = direct.map((entry) => ({ entryId: String(entry.entryId), title: entry.title, summary: entry.summary, credential: entry.credential }));
      for (const entry of direct) {
        for (const neighbor of service.neighbors(String(entry.entryId), 1).entries) {
          if (neighbor.status === 'consolidated' && !result.some((item) => item.entryId === String(neighbor.entryId))) {
            result.push({ entryId: String(neighbor.entryId), title: neighbor.title, summary: neighbor.summary, credential: neighbor.credential });
          }
        }
      }
      return result;
    },

    history(entryId) {
      // supersede 版本链：从任一版本沿 supersedes 回溯。
      const chain: KnowledgeEntry[] = [];
      let cursor: string | undefined = entryId;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        const entry = entries.get(cursor);
        if (entry === undefined) break;
        chain.unshift(entry);
        cursor = entry.supersedes;
      }
      return chain;
    },

    runs() {
      return [...runsTable.entries()].map(([, value]) => value as KnowledgeRun);
    },

    params() {
      return loadParams();
    },

    async setParams(patch) {
      const current = loadParams();
      const next: KnowledgeParams = { ...current, ...patch, revision: current.revision + 1 };
      paramsRef = next;
      await emit({
        family: 'knowledge/change',
        businessId: KNOWLEDGE_PARAMS_BUSINESS_ID,
        payload: knowledgeParamsPayload(next),
        domainWrite: async () => {
          await paramsTable.put(KNOWLEDGE_PARAMS_KEY, next as never);
        },
      });
      return next;
    },

    /** 队列重放（J10/不变量 9）：恢复后按序补写，图态最终一致。 */
    async flushQueued() {
      if (deps.provider?.available() !== true) return 0;
      let flushed = 0;
      while (queuedWrites.length > 0) {
        const item = queuedWrites[0]!;
        if (item.kind === 'invalidate') {
          if (item.entry.graphRef !== undefined) await deps.provider.invalidate(String(item.entry.entryId), item.entry.graphRef);
        } else {
          await deps.provider.reassert(item.entry);
        }
        queuedWrites.shift();
        flushed += 1;
      }
      return flushed;
    },

    async dispose() {
      await deps.domain.close();
    },
  };

  const trimQueue = (): void => {
    const cap = loadParams().invalidateQueueCap;
    while (queuedWrites.length > cap) queuedWrites.shift();
  };

  return service;
}

export { knowledgeDomainSpec };
