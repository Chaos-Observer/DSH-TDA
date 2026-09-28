/**
 * tda-trajectory 服务：ctx.trajectory 服务面实现（T0.7 §4.2）。
 *
 * 定位：**薄审计层，不存轨迹**（J1）。五件事：
 *  1. `index` / `record`：订阅全族事件 → 写 `audit_index`（**派生写**，不产事件）；
 *  2. `locate`：实体 → seq 范围（§5.5 投毒溯源的基础设施）；
 *  3. `replayCheck`：由日志前缀重建权威态 → 与各插件 domain **逐 revision 比对**
 *     （§4.1-4 / J4 硬判据）；
 *  4. `resumeCheck`：校验恢复序五步的产物（J5，冒烟/CI 用）；
 *  5. `auditView`：跨实体审计查询面（§5.5；不自动进上下文）。
 *
 * 三处刻意设计：
 *  - **索引是派生写**：`dualWriteDerived`（仅域、无事件）。若索引也产事件，
 *    "索引事件引发新索引"会自指放大；`logOnly` 相反（仅事件）也不行——索引必须持久。
 *  - **replayCheck 不假设"所有域都有 revision"**：goal/task/dispatch 有 CAS 修订号，
 *    timeline/scan 是 append-only（无修订号）——统一按"事件给出的期望修订号"比对
 *    （无修订号的族期望值恒 0），于是两类域都归到"零差异"这一个判据上。
 *  - **索引订阅是"已提交事实的回声"**：写索引是 floating promise，必须提供
 *    `drain()`；`dispose` 序 = 退订 → drain → 关域（承 IT2/IT3 的教训）。
 */
import {
  dualWriteDerived,
  TdaError,
  type DualWriteContext,
  type DualWriteReconciler,
  type EventFamily,
  type Seq,
  type SessionId,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionHost,
} from '@tda/kernel';
import {
  auditIndexKey,
  AUDIT_ENTITY_KINDS,
  ENTITY_FAMILY,
  type AuditEntityKind,
  type AuditIndexEntry,
  type TrajectoryTables,
} from './domain.ts';

/** 域现状的只读视图（装配层注入；轨迹插件不 import 任何插件内部）。 */
export interface TrajectoryDomainSource {
  readonly entityKind: AuditEntityKind;
  readonly family: string;
  /** 实体 id（= 事件的 businessId）→ 当前修订号（无 CAS 实体恒 0）。 */
  entries(): readonly { readonly entityId: string; readonly revision: number }[];
}

/** resume 恢复序的现场证据（由 Harness 的 resume 步骤产生；服务只做判定）。 */
export interface ResumeEvidence {
  readonly bootAt: number;
  readonly openTurnsBefore: number;
  readonly synthesizedClosers: number;
  /** 重建的调度定时器数（周期任务的 nextDueAt 重挂）。 */
  readonly rebuiltTimers: number;
  /** 重建的 page 数（PageTable）。 */
  readonly rebuiltPages: number;
  /** 被收口的孤儿派发单 id。 */
  readonly orphanDispatches: readonly string[];
  /** 历史是否被改写（必须恒 false——resume 只追加）。 */
  readonly historyRewritten: boolean;
}

export interface ReplayMismatch {
  readonly entity: string;
  readonly expected: number;
  readonly actual: number;
}

export interface ReplayReport {
  readonly ok: boolean;
  /** 比对过的实体数。 */
  readonly checked: number;
  /** 域**落后**于已提交事件（actual < expected）——真违规：事件已提交而域没落。 */
  readonly mismatches: readonly ReplayMismatch[];
  /**
   * 域**超前**于日志（actual > expected）——**撕裂尾**：宿主在"域已提交、事件未提交"
   * 之间被杀。契约"先域后事件"下这是唯一合法的偏差方向（先落域再 append 事件），
   * 与 T0.1–T0.3 的 kill -9 冒烟口径一致（只允许"域有日志无"）。
   * 不计入 ok，但必须可读——静默吞掉撕裂尾等于放弃审计。
   */
  readonly tornRevisions: readonly ReplayMismatch[];
  /** 只在日志里出现（域缺失）——幽灵：事件已提交而域没落。 */
  readonly missing: readonly string[];
  /** 只在域里出现（日志从未出现该实体）——幽灵实体：绕过双写直写域。 */
  readonly extra: readonly string[];
}

export interface ResumeReport {
  readonly ok: boolean;
  readonly orphanDispatches: readonly string[];
  readonly rebuiltTimers: number;
  readonly synthesizedClosers: number;
  readonly violations: readonly string[];
}

export interface AuditEntry extends AuditIndexEntry {
  /** 同实体是否仍有后续变更（seqTo 已前移）。 */
  readonly continued: boolean;
}

export interface AuditFilter {
  readonly entityKind?: AuditEntityKind;
  readonly entityId?: string;
  readonly sessionId?: string;
  readonly seqFrom?: number;
  readonly seqTo?: number;
}

/** 事件 → 索引的入参（`index` 直接调用；`record` 为订阅面入口）。 */
export interface TrajectoryEventRef {
  readonly family: EventFamily;
  readonly businessId: string;
  readonly seq: Seq;
  readonly sessionId: SessionId;
}

export interface TrajectoryService {
  /** 同步索引一条已提交事件（幂等：同实体延展 seqTo）。 */
  index(event: TrajectoryEventRef): Promise<AuditIndexEntry | undefined>;
  /**
   * 订阅面入口：把**已提交**事件入索引（floating promise；`drain()` 可等待）。
   * 事件回声里抛错会污染发布方（`BusSubscriberFailedError`），故失败走 `onError`
   * 显式出口而非向上抛。
   */
  record(event: TrajectoryEventRef): void;
  locate(entityKind: AuditEntityKind, entityId: string): AuditIndexEntry[];
  /** 由日志前缀重建权威态并与域逐 revision 比对（J4 硬判据）。 */
  replayCheck(range?: { readonly from: Seq; readonly to?: Seq }): Promise<ReplayReport>;
  resumeCheck(evidence: ResumeEvidence): ResumeReport;
  auditView(filter?: AuditFilter): AuditEntry[];
  /** 从日志全量重扫重建索引（§4.1-8：索引丢失不影响权威）。 */
  /**
   * **从会话日志增量摄入**（seq > 上次处理位点），回传本次触及的条目数。
   *
   * 为什么以日志而非总线为权威来源（IT4 实测教训）：goal-state / timeline 从不向
   * 总线发布（总线是 IT2 为**双向联动**引入的联动面，不是审计面），只订阅总线会让
   * 索引**整族漏掉**。而 J1/J2 早已定死「轨迹 = 会话日志」——索引必须从日志派生。
   * 总线订阅保留为**快速路径**（谁发布了就顺手索引），日志摄入是**兜底权威**。
   */
  ingest(): Promise<number>;
  rebuildIndex(): Promise<number>;
  entries(): readonly AuditIndexEntry[];
  /** 在途索引写（dispose 序：退订 → drain → 关域）。 */
  drain(): Promise<void>;
}

export interface TrajectoryDeps {
  readonly domain: TdaDomain<TrajectoryTables>;
  readonly host?: TdaSessionHost;
  readonly sources?: readonly TrajectoryDomainSource[];
  readonly bus?: TdaEventBus;
  readonly reconciler?: DualWriteReconciler;
  readonly now?: () => number;
  /** 索引写失败上报（订阅里抛错会污染发布方，故走显式出口）。 */
  readonly onError?: (message: string) => void;
}

/** 事件族 → 实体种类（六族一一对应；未知族不索引）。 */
const entityKindOfFamily = (family: string): AuditEntityKind | undefined =>
  AUDIT_ENTITY_KINDS.find((kind) => ENTITY_FAMILY[kind] === family);

/** 载荷里的修订号（无 CAS 的族恒 0）。 */
const revisionOf = (payload: unknown): number => {
  if (typeof payload !== 'object' || payload === null) return 0;
  const value = (payload as { revision?: unknown }).revision;
  return typeof value === 'number' ? value : 0;
};

export function createTrajectoryService(deps: TrajectoryDeps): TrajectoryService {
  const table = deps.domain.table('audit_index');
  const clock = deps.now ?? ((): number => Date.now());
  const context: DualWriteContext = {
    ...(deps.reconciler ? { reconciler: deps.reconciler } : {}),
  };
  /** 在途索引写（floating promise 集合；drain 用）。 */
  const inflight = new Set<Promise<void>>();
  /**
   * 索引写串行链：record() 是 fire-and-forget，同一实体的多个事件会并发进入
   * index()——两者都先 findExisting 再写，竞态下会各建一条条目（键含 seqFrom，
   * 互不覆盖），索引因此**逐实体堆积重复行**（冒烟实测抓到）。
   */
  let writeChain: Promise<unknown> = Promise.resolve();
  const withWriteLock = <T>(op: () => Promise<T>): Promise<T> => {
    const result = writeChain.then(op, op);
    writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  /** 已摄入的日志位点（ingest 的增量基准）。 */
  let ingestedUpTo = 0;
  const report =
    deps.onError ??
    ((message: string): void => {
      console.error('[tda-trajectory] 索引写入失败：', message);
    });

  const findExisting = (entityKind: AuditEntityKind, entityId: string): AuditIndexEntry | undefined => {
    for (const [, entry] of table.entries()) {
      if (entry.entityKind === entityKind && entry.entityId === entityId) return entry;
    }
    return undefined;
  };

  const putEntry = async (entry: AuditIndexEntry): Promise<AuditIndexEntry> => {
    await dualWriteDerived(async () => {
      await table.put(auditIndexKey(entry), entry);
    }, context);
    return entry;
  };

  const indexUnlocked = async (event: TrajectoryEventRef): Promise<AuditIndexEntry | undefined> => {
    const entityKind = entityKindOfFamily(event.family);
    if (entityKind === undefined) return undefined;
    const existing = findExisting(entityKind, event.businessId);
    if (existing !== undefined) {
      // 幂等：重扫/重放不重复延展；同实体多变更只延展 seqTo（索引体积与实体数同阶）
      if (event.seq <= existing.seqTo) return existing;
      const next: AuditIndexEntry = {
        entityKind: existing.entityKind,
        entityId: existing.entityId,
        sessionId: existing.sessionId,
        seqFrom: existing.seqFrom,
        seqTo: event.seq,
        at: existing.at,
      };
      await dualWriteDerived(async () => {
        await table.delete(auditIndexKey(existing));
        await table.put(auditIndexKey(next), next);
      }, context);
      return next;
    }
    return putEntry({
      entityKind,
      entityId: event.businessId,
      sessionId: String(event.sessionId),
      seqFrom: event.seq,
      seqTo: event.seq,
      at: clock(),
    });
  };

  /** 索引写入口（串行）：并发事件按到达序处理，实体条目唯一。 */
  const index = (event: TrajectoryEventRef): Promise<AuditIndexEntry | undefined> =>
    withWriteLock(() => indexUnlocked(event));

  const tdaRecords = (range?: { readonly from: Seq; readonly to?: Seq }) =>
    (deps.host?.records() ?? [])
      .filter((record) => record.kind === 'tda')
      .filter((record) =>
        range === undefined ? true : record.seq >= range.from && (range.to === undefined || record.seq <= range.to),
      );

  const replayCheck = async (range?: { readonly from: Seq; readonly to?: Seq }): Promise<ReplayReport> => {
    if (deps.sources === undefined) {
      throw new TdaError('TRAJECTORY_NO_SOURCES', 'replayCheck 需要装配域现状来源（sources seam）');
    }
    const events = tdaRecords(range);
    const mismatches: ReplayMismatch[] = [];
    const tornRevisions: ReplayMismatch[] = [];
    const missing: string[] = [];
    const extra: string[] = [];
    let checked = 0;
    for (const source of deps.sources) {
      const expected = new Map<string, number>();
      for (const record of events) {
        if (record.family !== source.family) continue;
        const previous = expected.get(record.businessId);
        expected.set(record.businessId, Math.max(previous ?? 0, revisionOf(record.payload)));
      }
      const actual = new Map<string, number>();
      for (const entry of source.entries()) actual.set(entry.entityId, entry.revision);
      for (const [entityId, revision] of expected) {
        checked += 1;
        if (!actual.has(entityId)) {
          missing.push(`${source.entityKind}:${entityId}`);
          continue;
        }
        const actualRevision = actual.get(entityId) ?? 0;
        if (actualRevision < revision) {
          mismatches.push({ entity: `${source.entityKind}:${entityId}`, expected: revision, actual: actualRevision });
        } else if (actualRevision > revision) {
          tornRevisions.push({ entity: `${source.entityKind}:${entityId}`, expected: revision, actual: actualRevision });
        }
      }
      for (const entityId of actual.keys()) {
        if (!expected.has(entityId)) extra.push(`${source.entityKind}:${entityId}`);
      }
    }
    return {
      ok: mismatches.length === 0 && missing.length === 0 && extra.length === 0,
      checked,
      mismatches,
      tornRevisions,
      missing,
      extra,
    };
  };

  const resumeCheck = (evidence: ResumeEvidence): ResumeReport => {
    const violations: string[] = [];
    if (evidence.openTurnsBefore > 0 && evidence.synthesizedClosers !== evidence.openTurnsBefore) {
      violations.push(
        `开放轮次 ${evidence.openTurnsBefore} 个，仅合成 ${evidence.synthesizedClosers} 个 interrupted closer（恢复序不完整）`,
      );
    }
    if (evidence.historyRewritten) {
      violations.push('resume 改写了历史事件（须只追加，§4.1-5）');
    }
    if (!Number.isFinite(evidence.rebuiltTimers) || evidence.rebuiltTimers < 0) {
      violations.push('重建定时器数非法');
    }
    if (!Number.isFinite(evidence.rebuiltPages) || evidence.rebuiltPages < 0) {
      violations.push('重建 page 数非法');
    }
    return {
      ok: violations.length === 0,
      orphanDispatches: [...evidence.orphanDispatches],
      rebuiltTimers: evidence.rebuiltTimers,
      synthesizedClosers: evidence.synthesizedClosers,
      violations,
    };
  };

  const entries = (): readonly AuditIndexEntry[] =>
    [...table.entries()]
      .map(([, entry]) => entry)
      .sort(
        (a, b) =>
          a.entityKind.localeCompare(b.entityKind) ||
          a.entityId.localeCompare(b.entityId) ||
          a.seqFrom - b.seqFrom,
      );

  return {
    index,
    async ingest() {
      if (deps.host === undefined) {
        throw new TdaError('TRAJECTORY_NO_HOST', 'ingest 需要会话主机 seam（host）');
      }
      const pending = tdaRecords().filter((record) => record.seq > ingestedUpTo);
      if (pending.length === 0) return 0;
      let changed = 0;
      for (const record of pending) {
        const written = await index({
          family: record.family,
          businessId: record.businessId,
          seq: record.seq,
          sessionId: deps.host.sessionId,
        });
        if (written !== undefined) changed += 1;
        ingestedUpTo = Math.max(ingestedUpTo, record.seq);
      }
      return changed;
    },
    record(event) {
      inflight.add(
        index(event)
          .then(() => undefined)
          .catch((error: unknown) => {
            report(`${event.family}/${event.businessId}：${error instanceof Error ? error.message : String(error)}`);
          }),
      );
    },
    locate: (entityKind, entityId) => entries().filter((entry) => entry.entityKind === entityKind && entry.entityId === entityId),
    replayCheck,
    resumeCheck,
    auditView: (filter) =>
      entries()
        .filter((entry) => {
          if (filter === undefined) return true;
          if (filter.entityKind !== undefined && entry.entityKind !== filter.entityKind) return false;
          if (filter.entityId !== undefined && entry.entityId !== filter.entityId) return false;
          if (filter.sessionId !== undefined && entry.sessionId !== filter.sessionId) return false;
          if (filter.seqFrom !== undefined && entry.seqTo < filter.seqFrom) return false;
          if (filter.seqTo !== undefined && entry.seqFrom > filter.seqTo) return false;
          return true;
        })
        .map((entry) => ({ ...entry, continued: entry.seqTo > entry.seqFrom })),
    async rebuildIndex() {
      if (deps.host === undefined) {
        throw new TdaError('TRAJECTORY_NO_HOST', 'rebuildIndex 需要会话主机 seam（host）');
      }
      const existing = entries();
      await dualWriteDerived(async () => {
        for (const entry of existing) await table.delete(auditIndexKey(entry));
      }, context);
      let count = 0;
      ingestedUpTo = 0;
      for (const record of tdaRecords()) {
        const written = await index({
          family: record.family,
          businessId: record.businessId,
          seq: record.seq,
          sessionId: deps.host.sessionId,
        });
        if (written !== undefined) count += 1;
        ingestedUpTo = Math.max(ingestedUpTo, record.seq);
      }
      return count;
    },
    entries,
    async drain() {
      // 先等写链排空（含 ingest 的在途写），再等总线快速路径的在途写
      await withWriteLock(async () => undefined);
      await Promise.all([...inflight]);
    },
  };
}

/** 订阅全族 → 索引（返回退订手柄；装配层负责 dispose 序：退订 → drain → 关域）。 */
export interface TrajectorySubscribeHandle {
  unsubscribe(): void;
  drain(): Promise<void>;
}

export function subscribeTrajectoryIndex(options: {
  readonly bus: TdaEventBus;
  readonly service: TrajectoryService;
}): TrajectorySubscribeHandle {
  const disposers = AUDIT_ENTITY_KINDS.map((kind) =>
    options.bus.subscribe(ENTITY_FAMILY[kind] as EventFamily, (event) => {
      options.service.record(event);
    }),
  );
  return {
    unsubscribe() {
      for (const dispose of disposers) dispose();
    },
    async drain() {
      // 先日志摄入（权威路径），再等总线快速路径——「索引跟上已提交事实」的完整语义
      await options.service.ingest();
      await options.service.drain();
    },
  };
}
