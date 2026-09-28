/**
 * tda-coach 服务面（T2.1 §4.2）。
 *
 * 安全面核心（J1/J5/J11）：coach 对执行面**只读**，对一切权威**零直接写权**——
 * 物化只走三路径（目标库 propose / PIPE append / 治理动作），固化/退役全经
 * ctx.governance 与目标库既有阀，coach 自己不碰任何资产的治理态。
 * 失败语义（J8）：review 内异常 = 显式 failed + unfinished，不阻断主链路（fail-open）。
 */
import {
  DEFAULT_COACH_PARAMS,
  COACH_PARAMS_KEY,
  COACH_SCAN_STATE_KEY,
  CoachParamsSchema,
  CoachReviewSchema,
  CoachCandidateSchema,
  coachDomainSpec,
  type CoachCandidate,
  type CoachParams,
  type CoachReview,
  type CoachScanState,
  type CoachTables,
} from './domain.ts';
import { buildCandidate, clusterRows, passesQualityGate, summarizeCluster, type ClusterRow } from './cluster.ts';
import {
  COACH_CANDIDATE_BUSINESS_PREFIX,
  COACH_PARAMS_BUSINESS_ID,
  COACH_REVIEW_BUSINESS_PREFIX,
  coachCandidatePayload,
  coachParamsPayload,
  coachReviewPayload,
} from './events.ts';
import {
  dualWrite,
  dualWriteDerived,
  TdaError,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteOp,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type Seq,
  type TdaSessionSink,
} from '@tda/kernel';

const SCAN_STATE_KEY = COACH_SCAN_STATE_KEY;

/** coach actor（复用 T1.4 预留的 `actor:'coach'` 位）。 */
export interface CoachActor {
  readonly actor: 'coach' | 'human' | 'scheduler';
  readonly sessionId: string;
}

/** 六路只读数据源（J2，冷读 domain/log，全部窄接口）。 */
export interface CoachReads {
  readonly mismatches: () => readonly {
    readonly id: string;
    readonly predictionId: string;
    readonly actual: { readonly action: string; readonly errorClass?: string | undefined };
    readonly deltaKind: 'action' | 'outcome' | 'risk-materialized' | 'none';
    readonly at: number;
  }[];
  readonly predictions: () => readonly {
    readonly id: string;
    readonly context: { readonly taskId?: string | undefined; readonly stage: string };
  }[];
  readonly govActions: () => readonly { readonly id: string; readonly action: string; readonly assetKind: string; readonly assetId: string; readonly at: number }[];
  readonly rehearsalRuns: () => readonly { readonly id: string; readonly verdict: string; readonly at: number }[];
}

/** T1.4 目标库窄面（coach 不 fork——委托 rehearse，J1/T0.7 J6）。 */
export interface CoachMetaSeam {
  readonly propose: (
    actor: CoachActor,
    draft: unknown,
  ) => Promise<{ readonly id: string }>;
  readonly rehearse: (
    actor: CoachActor,
    metaPathId: string,
    taskId: string,
  ) => Promise<{ readonly id: string; readonly verdict: 'pass' | 'fail' }>;
  readonly requestConsolidate: (actor: CoachActor, metaPathId: string) => Promise<void>;
}

/** T2.2 技能库窄面（缺席 = skill 候选 deferred，J4；IT8b 装配后接入）。 */
export interface CoachSkillSeam {
  readonly propose: (draft: unknown) => Promise<{ readonly id: string }>;
  readonly rehearse: (
    skillId: string,
    taskId: string,
  ) => Promise<{ readonly id: string; readonly verdict: 'pass' | 'fail' }>;
  readonly requestConsolidate: (skillId: string) => Promise<unknown>;
}

/** T0.3 PIPE 窄面（method-memory 物化，凭证 model-produced，J4）。 */
export interface CoachPipeSeam {
  readonly append: (writer: { readonly sessionId: string; readonly at: number }, chunk: {
    readonly content: string;
    readonly chunkType: string;
    readonly credential: string;
    readonly confidence?: number;
    readonly relatedTaskId?: string;
  }) => Promise<{ readonly id: string }>;
}

/** 跨模型迁移验证执行器（J6：以不同 modelProfile 再跑一次 rehearsal）。 */
export interface CoachTransferExecutor {
  readonly run: (input: {
    readonly candidate: CoachCandidate;
    readonly modelProfile: string;
    readonly taskId?: string;
  }) => Promise<{ readonly verdict: 'pass' | 'fail'; readonly rehearsalId: string }>;
}

export interface CoachDeps {
  readonly domain: TdaDomain<CoachTables>;
  readonly session: TdaSessionSink;
  readonly reads: CoachReads;
  readonly meta: CoachMetaSeam;
  readonly pipe: CoachPipeSeam;
  readonly skills?: CoachSkillSeam | undefined;
  readonly transferExecutor?: CoachTransferExecutor | undefined;
  /** 主任务 round 活跃期探测（J9 让位；缺席 = 永不活跃）。 */
  readonly isAthleteActive?: (() => boolean) | undefined;
  readonly taskClassOf?: ((taskId: string | undefined) => string) | undefined;
  readonly now?: (() => number) | undefined;
  readonly reconciler?: DualWriteReconciler | undefined;
  readonly index?: AuditIndex | undefined;
  /** 联动总线（快速路径；审计权威仍是会话日志）。 */
  readonly bus?: TdaEventBus | undefined;
}

export interface CoachService {
  /** 启动序：先建参数/水位单行，再注册不变量（纪律 #14）。 */
  initialize(): Promise<void>;
  review(trigger: { kind: 'periodic' | 'mismatch-surge' | 'manual' }): Promise<CoachReview>;
  candidates(filter?: {
    status?: string;
    kind?: string;
    risk?: string;
    reviewId?: string;
  }): readonly CoachCandidate[];
  rehearseCandidate(
    actor: CoachActor,
    candidateId: string,
    taskId: string,
  ): Promise<{ readonly candidateId: string; readonly verdict: 'pass' | 'fail'; readonly rehearsalId: string }>;
  verifyTransfer(
    actor: CoachActor,
    candidateId: string,
    modelProfile: string,
    taskId?: string,
  ): Promise<{ readonly candidateId: string; readonly modelProfile: string; readonly verdict: 'pass' | 'fail'; readonly rehearsalId: string }>;
  submit(
    actor: CoachActor,
    candidateId: string,
    approval?: string,
  ): Promise<{ readonly candidateId: string; readonly status: string; readonly targetRef?: string }>;
  reports(limit?: number): readonly CoachReview[];
  /** mismatch 观察钩子（宿主订阅 predict/change 后喂入；surge 超阈返回 true）。 */
  observeMismatch(at: number, deltaKind: string): boolean;
  scanState(): CoachScanState;
  params(): CoachParams;
  setParams(patch: Partial<Omit<CoachParams, 'revision'>>): Promise<CoachParams>;
}

const seqOfMismatch = (id: string): number => {
  const suffix = id.split('-').at(-1);
  const parsed = Number(suffix);
  return Number.isFinite(parsed) ? parsed : 0;
};

const bySeqAsc = (a: { readonly id: string }, b: { readonly id: string }): number =>
  seqOfMismatch(a.id) - seqOfMismatch(b.id);

export function createCoachService(deps: CoachDeps): CoachService {
  const clock = deps.now ?? ((): number => Date.now());
  const context: DualWriteContext = {
    ...(deps.reconciler !== undefined ? { reconciler: deps.reconciler } : {}),
    ...(deps.index !== undefined ? { index: deps.index } : {}),
  };
  // 双写 + 总线快速路径（audit 权威 = 会话日志；bus 仅供联动订阅，如 surge 检测）
  const emit = async (op: DualWriteOp): Promise<Seq> => {
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
  const paramsTable = deps.domain.table('coach_params');
  const scanTable = deps.domain.table('coach_scan_state');
  const reviewsTable = deps.domain.table('coach_reviews');
  const candidatesTable = deps.domain.table('coach_candidates');

  const consumedTokens = new Set<string>();
  const reviews = new Map<string, CoachReview>();
  const candidates = new Map<string, CoachCandidate>();
  let inFlightRehearsals = 0;
  let reviewRunning = false;
  // id 分配即落键：计数器从表内现有行数起步（重启后无重号）
  let reviewCounter = [...reviewsTable.keys()].length;
  let candidateCounter = [...candidatesTable.keys()].length;

  // 内存权威（表 put 是异步的；initialize 时播种并 await 落盘，此后以内存为准）
  let paramsRef: CoachParams | undefined;
  let scanRef: CoachScanState | undefined;
  const loadParams = (): CoachParams => {
    if (paramsRef !== undefined) return paramsRef;
    const row = paramsTable.get(COACH_PARAMS_KEY) as CoachParams | undefined;
    if (row !== undefined) {
      paramsRef = row;
      return row;
    }
    paramsRef = { ...DEFAULT_COACH_PARAMS };
    return paramsRef;
  };
  const loadScanState = (): CoachScanState => {
    if (scanRef !== undefined) return scanRef;
    const row = scanTable.get(SCAN_STATE_KEY) as CoachScanState | undefined;
    if (row !== undefined) {
      scanRef = row;
      return row;
    }
    scanRef = {
      lastMismatchSeq: 0,
      lastAt: 0,
      lastReviewAt: 0,
      surgeWindow: { sinceAt: 0, nonNoneCount: 0 },
    };
    return scanRef;
  };

  const requireCandidate = (id: string): CoachCandidate => {
    const row = candidates.get(id);
    if (row === undefined) throw new TdaError('COACH_CANDIDATE_NOT_FOUND', `候选 ${id} 不存在`);
    return row;
  };

  const putCandidate = async (candidate: CoachCandidate, action: string): Promise<void> => {
    candidates.set(String(candidate.id), candidate);
    await emit({
        family: 'coach/change',
        businessId: `${COACH_CANDIDATE_BUSINESS_PREFIX}:${String(candidate.id)}`,
        payload: coachCandidatePayload(candidate, action),
        domainWrite: () => candidatesTable.put(String(candidate.id), candidate as never),
      },
      );
  };

  const taskClassOf = (taskId: string | undefined): string =>
    deps.taskClassOf !== undefined ? deps.taskClassOf(taskId) : (taskId ?? 'unbound');

  const waitForAthlete = async (): Promise<void> => {
    const active = deps.isAthleteActive;
    if (active === undefined) return;
    const params = loadParams();
    const deadline = clock() + params.yieldTimeoutMs;
    while (active()) {
      if (clock() > deadline) {
        throw new TdaError('COACH_YIELD_TIMEOUT', '主任务 round 活跃超时未让出（J9 让位纪律：rehearsal 排队不抢占）');
      }
      await new Promise((resolve) => setTimeout(resolve, params.yieldPollMs));
    }
  };

  const params = (): CoachParams => loadParams();

  const review = async (trigger: { kind: 'periodic' | 'mismatch-surge' | 'manual' }): Promise<CoachReview> => {
    if (reviewRunning) {
      throw new TdaError('COACH_REVIEW_RUNNING', '上一轮复盘尚未落定（单飞：同插件不允许并发 review）');
    }
    reviewRunning = true;
    const startedAt = clock();
    try {
      const config = loadParams();
      const state = loadScanState();
      const reviewId = `cr-${++reviewCounter}`;

      // ① 扫描（增量水位 + 吞吐帽，J9）
      const pending = deps.reads
        .mismatches()
        .filter((row) => seqOfMismatch(row.id) > state.lastMismatchSeq)
        .sort(bySeqAsc)
        .slice(0, config.maxMismatchScan);
      const predictions = new Map(deps.reads.predictions().map((p) => [String(p.id), p]));
      const rows: ClusterRow[] = pending.map((mismatch) => {
        const prediction = predictions.get(mismatch.predictionId);
        return {
          mismatchId: mismatch.id,
          predictionId: mismatch.predictionId,
          taskClass: taskClassOf(prediction?.context.taskId),
          stage: prediction?.context.stage ?? 'executing',
          actionPattern: mismatch.actual.action,
          deltaKind: mismatch.deltaKind,
          ...(mismatch.actual.errorClass !== undefined ? { errorClass: mismatch.actual.errorClass } : {}),
          at: mismatch.at,
        };
      });

      // ② 聚类（纯函数，J3）
      const clusters = clusterRows(rows);
      const keys = [...clusters.keys()].sort();
      const patterns = keys.map((key) => summarizeCluster(key, clusters.get(key)!));

      // ③ 候选生成 + 质量门 + 物化（J12/J4），候选帽内推进
      const candidateIds: string[] = [];
      const govActionRefs: string[] = [];
      let proposed = 0;
      let rejected = 0;
      for (const key of keys) {
        if (proposed >= config.maxCandidatesPerReview) break;
        const built = buildCandidate(key, clusters.get(key)!, {
          minEvidenceCount: config.minEvidenceCount,
          minConfidence: config.minConfidence,
        });
        if (built === undefined) {
          rejected += 1;
          continue;
        }
        const gate = passesQualityGate(built, clusters.get(key)!.length, config.minEvidenceCount);
        if (!gate.ok) {
          rejected += 1;
          continue;
        }
        const at = clock();
        const candidate: CoachCandidate = CoachCandidateSchema.parse({
          id: `hc-${++candidateCounter}`,
          kind: built.kind,
          risk: built.risk,
          condition: built.condition,
          rule: built.rule,
          evidence: {
            mismatchIds: clusters.get(key)!.map((row) => row.mismatchId),
            transitionIds: clusters.get(key)!.map((row) => row.predictionId),
            sessions: [],
          },
          confidence: built.confidence,
          status: 'proposed',
          reviewId,
          createdAt: at,
          updatedAt: at,
        });
        // 物化（J4 三分流）——只产 draft，不碰治理态
        if (built.kind === 'meta-path') {
          const created = await deps.meta.propose(
            { actor: 'coach', sessionId: deps.session.sessionId },
            {
              topology: built.rule.shape,
              mode: 'convergent',
              applicability: {
                taskClasses: built.condition.taskClasses,
                stages: built.condition.stages,
                problemFeatures: built.condition.problemFeatures,
              },
              source: { kind: 'coach-candidate', refs: [] },
            },
          );
          await putCandidate(
            {
              ...candidate,
              status: 'proposed',
              draftRef: { kind: 'meta-path', id: String(created.id) },
              updatedAt: clock(),
            },
            'materialize',
          );
        } else if (built.kind === 'skill') {
          if (deps.skills === undefined) {
            await putCandidate({ ...candidate, status: 'deferred', updatedAt: clock() }, 'defer');
          } else {
            const created = await deps.skills.propose({
              name: `coach-${key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
              summary: `coach 提炼：${key}`,
              kind: 'procedure',
              procedure: { steps: [{ action: built.rule.expect ?? 'other' }], prerequisites: [] },
              applicability: {
                taskClasses: built.condition.taskClasses,
                stages: built.condition.stages,
                problemFeatures: built.condition.problemFeatures,
              },
              source: { kind: 'coach-candidate', refs: [] },
              credential: 'model-produced',
            });
            await putCandidate(
              {
                ...candidate,
                status: 'proposed',
                draftRef: { kind: 'skill', id: String(created.id) },
                updatedAt: clock(),
              },
              'materialize',
            );
          }
        } else {
          // method-memory：PIPE append（浮现/固化走 T1.1 gate/T1.2 既有阀，coach 不绕过）
          const entry = await deps.pipe.append(
            { sessionId: deps.session.sessionId, at: clock() },
            {
              content: `coach:${key}`,
              chunkType: 'method',
              credential: 'model-produced',
              confidence: built.confidence,
            },
          );
          await putCandidate(
            {
              ...candidate,
              status: 'submitted',
              draftRef: { kind: 'timeline-entry', id: String(entry.id) },
              updatedAt: clock(),
            },
            'materialize',
          );
          proposed += 1;
          candidateIds.push(String(candidate.id));
          continue;
        }
        proposed += 1;
        candidateIds.push(String(candidate.id));
      }

      // ④ 汇总历史候选验证结果（冷读 rehearsal 史，J2）
      const stateNow = loadScanState();
      const rehearsalsSince = deps.reads
        .rehearsalRuns()
        .filter((run) => run.at >= stateNow.lastReviewAt).length;

      const report: CoachReview = CoachReviewSchema.parse({
        id: reviewId,
        trigger: { kind: trigger.kind, at: startedAt },
        window: {
          fromSeq: state.lastMismatchSeq,
          toSeq: pending.length > 0 ? seqOfMismatch(pending[pending.length - 1]!.id) : state.lastMismatchSeq,
          fromAt: state.lastAt,
          toAt: clock(),
        },
        status: 'recorded',
        stats: {
          mismatchesScanned: pending.length,
          patternsFound: patterns.length,
          candidatesProposed: proposed,
          candidatesRejected: rejected,
          rehearsalsRun: rehearsalsSince,
          humanApprovalsRequested: 0,
        },
        patterns,
        candidateIds,
        govActionRefs,
        at: clock(),
      });
      reviews.set(reviewId, report);
      const nextScan: CoachScanState = {
        ...stateNow,
        lastMismatchSeq: pending.length > 0 ? seqOfMismatch(pending[pending.length - 1]!.id) : state.lastMismatchSeq,
        lastAt: clock(),
        lastReviewAt: clock(),
        surgeWindow: { sinceAt: clock(), nonNoneCount: 0 },
      };
      scanRef = nextScan;
      await emit({
          family: 'coach/change',
          businessId: `${COACH_REVIEW_BUSINESS_PREFIX}:${reviewId}`,
          payload: coachReviewPayload(report),
          // await 语义必须在窗口内落域（block 箭头返回 void 会让 onChange 溢出窗口）
          domainWrite: async () => {
            await reviewsTable.put(reviewId, report as never);
            await scanTable.put(SCAN_STATE_KEY, nextScan as never);
          },
        },
      );
      return report;
    } catch (error) {
      // fail-open（不变量 8）：复盘异常 = 显式 failed 终态，不阻断主链路
      const failed: CoachReview = CoachReviewSchema.parse({
        id: `cr-${++reviewCounter}`,
        trigger: { kind: trigger.kind, at: startedAt },
        window: { fromSeq: 0, toSeq: 0, fromAt: 0, toAt: clock() },
        status: 'failed',
        stats: {
          mismatchesScanned: 0,
          patternsFound: 0,
          candidatesProposed: 0,
          candidatesRejected: 0,
          rehearsalsRun: 0,
          humanApprovalsRequested: 0,
        },
        patterns: [],
        candidateIds: [],
        govActionRefs: [],
        unfinished: [`review: ${error instanceof Error ? error.message : String(error)}`],
        at: clock(),
      });
      reviews.set(String(failed.id), failed);
      // 失败报告走派生窗落域（session 可能正是故障源，不再经事件通道）
      await dualWriteDerived(() => reviewsTable.put(String(failed.id), failed as never), context);
      return failed;
    } finally {
      reviewRunning = false;
    }
  };

  const rehearseCandidate = async (
    actor: CoachActor,
    candidateId: string,
    taskId: string,
  ): Promise<{ readonly candidateId: string; readonly verdict: 'pass' | 'fail'; readonly rehearsalId: string }> => {
    const config = loadParams();
    const candidate = requireCandidate(candidateId);
    if (candidate.kind === 'method-memory') {
      throw new TdaError('COACH_REHEARSAL_NA', 'method-memory 走真实复用阀（T1.2 J5），不做 rehearsal');
    }
    if (candidate.status !== 'proposed') {
      throw new TdaError('COACH_NOT_PROPOSED', `候选 ${candidateId} 当前 ${candidate.status}，rehearsal 只能从 proposed 起`);
    }
    if (candidate.draftRef === undefined) {
      throw new TdaError('COACH_NO_DRAFT', `候选 ${candidateId} 无物化落点（deferred 候选须等 seam 履约）`);
    }
    if (inFlightRehearsals >= config.maxRehearsalConcurrent) {
      throw new TdaError('COACH_REHEARSAL_BUSY', `rehearsal 并发已达帽 ${config.maxRehearsalConcurrent}（J9）`);
    }
    await waitForAthlete();
    inFlightRehearsals += 1;
    try {
      await putCandidate({ ...candidate, status: 'rehearsing', updatedAt: clock() }, 'rehearse-start');
      let verdict: 'pass' | 'fail';
      let rehearsalId: string;
      if (candidate.kind === 'meta-path') {
        const run = await deps.meta.rehearse(actor, candidate.draftRef.id, taskId);
        verdict = run.verdict;
        rehearsalId = String(run.id);
      } else {
        if (deps.skills === undefined) {
          throw new TdaError('COACH_SKILL_SEAM_MISSING', 'skill 候选的 rehearsal 须 T2.2 seam 履约（U5）');
        }
        const run = await deps.skills.rehearse(candidate.draftRef.id, taskId);
        verdict = run.verdict;
        rehearsalId = String(run.id);
      }
      await putCandidate(
        {
          ...candidate,
          status: verdict === 'pass' ? 'validated' : 'rejected',
          updatedAt: clock(),
        },
        `rehearse-${verdict}`,
      );
      return { candidateId, verdict, rehearsalId };
    } finally {
      inFlightRehearsals -= 1;
    }
  };

  const verifyTransfer = async (
    actor: CoachActor,
    candidateId: string,
    modelProfile: string,
    taskId?: string,
  ): Promise<{ readonly candidateId: string; readonly modelProfile: string; readonly verdict: 'pass' | 'fail'; readonly rehearsalId: string }> => {
    void actor;
    const candidate = requireCandidate(candidateId);
    if (candidate.kind === 'method-memory') {
      throw new TdaError('COACH_TRANSFER_NA', 'method-memory 不做跨模型迁移验证（走真实复用阀）');
    }
    if (candidate.status !== 'validated' && candidate.status !== 'transfer-verified') {
      throw new TdaError('COACH_NOT_VALIDATED', `候选 ${candidateId} 当前 ${candidate.status}，迁移验证须先 rehearsal pass`);
    }
    if (deps.transferExecutor === undefined) {
      throw new TdaError('COACH_VERIFY_EXECUTOR_MISSING', '迁移验证执行器未接入（J6：以不同 modelProfile 再跑 rehearsal）');
    }
    const result = await deps.transferExecutor.run({ candidate, modelProfile, ...(taskId !== undefined ? { taskId } : {}) });
    const prevProfiles = candidate.transfer?.modelProfiles ?? [];
    await putCandidate(
      {
        ...candidate,
        status: result.verdict === 'pass' ? 'transfer-verified' : candidate.status,
        transfer: {
          verified: result.verdict === 'pass' || (candidate.transfer?.verified ?? false),
          modelProfiles:
            result.verdict === 'pass'
              ? [...new Set([...prevProfiles, modelProfile])]
              : prevProfiles,
        },
        updatedAt: clock(),
      },
      `transfer-${result.verdict}`,
    );
    return { candidateId, modelProfile, verdict: result.verdict, rehearsalId: String(result.rehearsalId) };
  };

  const submit = async (
    actor: CoachActor,
    candidateId: string,
    approval?: string,
  ): Promise<{ readonly candidateId: string; readonly status: string; readonly targetRef?: string }> => {
    const candidate = requireCandidate(candidateId);
    // 不变量 2：未验证零固化（J5/J6：meta-path/skill 须 transfer-verified）
    if (candidate.kind !== 'method-memory' && candidate.status !== 'transfer-verified') {
      throw new TdaError('COACH_NOT_TRANSFER_VERIFIED', `候选 ${candidateId} 当前 ${candidate.status}，固化提请须先迁移验证通过`);
    }
    if (candidate.draftRef === undefined) {
      throw new TdaError('COACH_NO_DRAFT', `候选 ${candidateId} 无物化落点`);
    }
    // 高风险人类审批（J10/不变量 6：token 一次性消费，拒绝留痕）
    if (candidate.risk === 'high') {
      if (approval === undefined || approval === '') {
        throw new TdaError('COACH_APPROVAL_REQUIRED', `候选 ${candidateId} 属控制流面（risk=high），submit 需人类一次性 token`);
      }
      if (consumedTokens.has(approval)) {
        throw new TdaError('COACH_APPROVAL_REUSED', '审批 token 已消费（一次性纪律）');
      }
      consumedTokens.add(approval);
    }
    if (candidate.kind === 'meta-path') {
      await deps.meta.requestConsolidate(actor, candidate.draftRef.id);
    } else if (candidate.kind === 'skill') {
      if (deps.skills === undefined) {
        throw new TdaError('COACH_SKILL_SEAM_MISSING', 'skill 晋升须 T2.2 seam 履约（U5）');
      }
      await deps.skills.requestConsolidate(candidate.draftRef.id);
    }
    // method-memory：PIPE 落库即入既有管道，submit 仅记录（J4）
    await putCandidate({ ...candidate, status: 'submitted', updatedAt: clock() }, 'submit');
    return {
      candidateId,
      status: 'submitted',
      ...(candidate.draftRef !== undefined ? { targetRef: candidate.draftRef.id } : {}),
    };
  };

  const issueToken = (): string => {
    const token = `coach-appr-${clock()}-${consumedTokens.size + 1}`;
    return token;
  };

  return {
    async initialize() {
      loadParams();
      loadScanState();
      if (paramsTable.get(COACH_PARAMS_KEY) === undefined) {
        // 参数权威行 = 事件配对（businessId='params'）
        await emit({
            family: 'coach/change',
            businessId: COACH_PARAMS_BUSINESS_ID,
            payload: coachParamsPayload(loadParams()),
            domainWrite: () => paramsTable.put(COACH_PARAMS_KEY, loadParams() as never),
          },
      );
      }
      if (scanTable.get(SCAN_STATE_KEY) === undefined) {
        // 水位 = 派生数据（同 log 可重算）：仅域写
        await dualWriteDerived(() => scanTable.put(SCAN_STATE_KEY, loadScanState() as never), context);
      }
    },
    review,
    candidates(filter = {}) {
      return [...candidates.values()]
        .filter((row) => (filter.status !== undefined ? row.status === filter.status : true))
        .filter((row) => (filter.kind !== undefined ? row.kind === filter.kind : true))
        .filter((row) => (filter.risk !== undefined ? row.risk === filter.risk : true))
        .filter((row) => (filter.reviewId !== undefined ? row.reviewId === filter.reviewId : true))
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    },
    rehearseCandidate,
    verifyTransfer,
    submit,
    issueApprovalToken: issueToken,
    reports(limit) {
      const list = [...reviewsTable.entries()].map(([, value]) => value as CoachReview);
      const sorted = list.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
      return limit !== undefined ? sorted.slice(-limit) : sorted;
    },
    observeMismatch(at, deltaKind) {
      const state = loadScanState();
      const config = loadParams();
      const expired = at - state.surgeWindow.sinceAt > config.surgeWindowMs;
      const window = expired
        ? { sinceAt: at, nonNoneCount: deltaKind !== 'none' ? 1 : 0 }
        : {
            sinceAt: state.surgeWindow.sinceAt,
            nonNoneCount: state.surgeWindow.nonNoneCount + (deltaKind !== 'none' ? 1 : 0),
          };
      const surge = window.nonNoneCount >= config.surgeThreshold;
      const next: CoachScanState = {
        ...state,
        lastAt: at,
        surgeWindow: surge ? { sinceAt: at, nonNoneCount: 0 } : window,
      };
      // 水位/窗口是派生数据（同 log 可重算）：内存为准 + 派生窗落盘
      scanRef = next;
      void dualWriteDerived(() => scanTable.put(SCAN_STATE_KEY, next as never), context);
      return surge;
    },
    scanState() {
      return loadScanState();
    },
    params,
    async setParams(patch) {
      const current = loadParams();
      const next = CoachParamsSchema.parse({ ...current, ...patch, revision: current.revision + 1 });
      paramsRef = next;
      // 落盘只经双写窗口（窗口外 put = 漏配对）
      await emit({
        family: 'coach/change',
        businessId: COACH_PARAMS_BUSINESS_ID,
        payload: coachParamsPayload(next),
        domainWrite: () => paramsTable.put(COACH_PARAMS_KEY, next as never),
      });
      return next;
    },
  } as CoachService & { readonly issueApprovalToken: () => string };
}

export { coachDomainSpec, CoachReviewSchema, CoachCandidateSchema };
