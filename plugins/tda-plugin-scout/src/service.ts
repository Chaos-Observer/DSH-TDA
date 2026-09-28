/**
 * tda-plugin-scout 服务面（T2.6 §4.2）。
 *
 * 三零权限（J5/不变量 1）：对 DSH 插件目录/技能库/治理域全部只读；冒烟安装仅限
 * ephemeral scratch（经 T0.5 dispatch seam，装配层提供）；零 adoptExternal 调用权。
 */
import {
  DEFAULT_PARAMS,
  SCOUT_PARAMS_KEY,
  ParamsSchema,
  scoutDomainSpec,
  scorePlugin,
  type PluginAssessment,
  type RegistryPluginRow,
  type ScoutParams,
  type ScoutRun,
  type ScoutTables,
} from './domain.ts';
import {
  SCOUT_ASSESSMENT_BUSINESS_PREFIX,
  SCOUT_PARAMS_BUSINESS_ID,
  SCOUT_RUN_BUSINESS_PREFIX,
  scoutAssessmentPayload,
  scoutParamsPayload,
  scoutRunPayload,
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

/** registry 快照 seam（J2：接 dsh.so 现成管线；白名单域 fetch + cache 降级在装配层）。 */
export interface ScoutRegistrySeam {
  /** 返回机读快照（J9-④：断网降级 = cache 快照，source='cache'）。 */
  readonly fetchSnapshot: () => Promise<{ readonly at: number; readonly plugins: readonly RegistryPluginRow[]; readonly source: 'live' | 'cache' }>;
}

/** 冒烟执行 seam（J4：fresh 子代理 + minimal preset + scratch；三层断言）。 */
export interface ScoutSmokeSeam {
  readonly run: (input: { readonly pluginId: string }) => Promise<{
    readonly installed: boolean;
    readonly loaded: boolean;
    readonly basicCall: boolean;
    readonly scratchRef: string;
    readonly dispatchId: string;
  }>;
}

/** 叙述生成 seam（J3：model-produced，与数值隔离；scorer 不接收其输出）。 */
export interface ScoutNarrator {
  readonly narrate: (input: { readonly pluginId: string; readonly pluginName: string }) => Promise<{ readonly summary: string; readonly risks: readonly string[] }>;
}

/** 时间线回写 seam（J6 PIPE 双 chunk：结构化 execution-verified / 叙述 model-produced）。 */
export interface ScoutPipe {
  readonly append: (writer: { readonly sessionId: string }, chunk: {
    readonly content: string;
    readonly chunkType: string;
    readonly credential: string;
  }) => Promise<{ readonly id: string }>;
}

export type { RegistryPluginRow } from './domain.ts';

export interface ScoutDeps {
  readonly domain: TdaDomain<ScoutTables>;
  readonly session: TdaSessionSink;
  readonly registry: ScoutRegistrySeam;
  readonly smoke?: ScoutSmokeSeam | undefined;
  readonly narrator?: ScoutNarrator | undefined;
  readonly pipe?: ScoutPipe | undefined;
  readonly now?: (() => number) | undefined;
  readonly reconciler?: DualWriteReconciler | undefined;
  readonly index?: AuditIndex | undefined;
  readonly bus?: TdaEventBus | undefined;
}

export interface ScoutReport {
  readonly runId: string;
  readonly snapshot: ScoutRun['snapshot'];
  readonly grades: Record<string, number>;
  readonly topAdoptionCandidates: readonly { readonly pluginId: string; readonly grade: string; readonly composite: number }[];
  readonly narratives: readonly { readonly pluginId: string; readonly summary: string }[];
}

export interface PluginScoutService {
  initialize(): Promise<void>;
  scan(trigger: { kind: 'periodic' | 'manual'; scope?: { readonly query?: string; readonly limit?: number } }): Promise<ScoutRun>;
  assess(pluginId: string): Promise<PluginAssessment>;
  smokeTest(pluginId: string): Promise<NonNullable<PluginAssessment['smoke']>>;
  assessments(filter?: { readonly grade?: string; readonly pluginId?: string; readonly fresh?: boolean }): readonly PluginAssessment[];
  assessment(pluginId: string): PluginAssessment | undefined;
  report(runId?: string): ScoutReport;
  params(): ScoutParams;
  setParams(patch: Partial<Omit<ScoutParams, 'revision'>>): Promise<ScoutParams>;
}

export function createPluginScoutService(deps: ScoutDeps): PluginScoutService {
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
  const assessmentsTable = deps.domain.table('plugin_assessments');
  const eventsTable = deps.domain.table('plugin_scout_events');
  const runsTable = deps.domain.table('plugin_scout_runs');
  const paramsTable = deps.domain.table('plugin_scout_params');

  const assessmentVersions = new Map<string, number>(); // pluginId → 最新版号
  let runCounter = 0;
  let eventCounter = 0;
  let paramsRef: ScoutParams | undefined;

  const loadParams = (): ScoutParams => {
    if (paramsRef !== undefined) return paramsRef;
    const row = paramsTable.get(SCOUT_PARAMS_KEY) as ScoutParams | undefined;
    paramsRef = row ?? { ...DEFAULT_PARAMS };
    return paramsRef;
  };

  const nextAssessmentId = (pluginId: string): { id: string; version: number } => {
    const version = (assessmentVersions.get(pluginId) ?? 0) + 1;
    assessmentVersions.set(pluginId, version);
    return { id: `${pluginId}#v${version}`, version };
  };

  const persistEvent = async (event: Omit<import('./domain.ts').ScoutEvent, 'id'>): Promise<void> => {
    const full = { ...event, id: `se-${++eventCounter}` as never };
    await emit({
      family: 'pluginScout/change',
      businessId: `scout-event:${String(full.id)}`,
      payload: { ...full, detail: { ...full.detail } } as never,
      domainWrite: async () => {
        await eventsTable.put(String(full.id), full as never);
      },
    });
  };

  const persistRun = async (run: ScoutRun): Promise<void> => {
    await emit({
      family: 'pluginScout/change',
      businessId: `${SCOUT_RUN_BUSINESS_PREFIX}:${String(run.runId)}`,
      payload: scoutRunPayload(run),
      domainWrite: async () => {
        await runsTable.put(String(run.runId), run as never);
      },
    });
  };

  const persistAssessment = async (assessment: PluginAssessment): Promise<void> => {
    await emit({
      family: 'pluginScout/change',
      businessId: `${SCOUT_ASSESSMENT_BUSINESS_PREFIX}:${assessment.assessmentId}`,
      payload: scoutAssessmentPayload(assessment),
      domainWrite: async () => {
        await assessmentsTable.put(assessment.assessmentId, assessment as never);
      },
    });
  };

  /** 评估单插件（scorer 纯函数 + smoke/narrative 编排）。 */
  const assessRow = async (
    row: RegistryPluginRow,
    scanRunId: string,
    snapshotAt: number,
    runId: string,
  ): Promise<PluginAssessment> => {
    const params = loadParams();
    const scored = scorePlugin(row, params, { snapshotAt, now: clock() });
    // 冒烟只对预分级 A+ 候选（J4 阈值化）
    let smoke: PluginAssessment['smoke'] | undefined;
    if (
      deps.smoke !== undefined &&
      scored.composite >= params.smokeThreshold &&
      scored.veto === undefined
    ) {
      const result = await deps.smoke.run({ pluginId: row.pluginId });
      smoke = {
        installed: result.installed,
        loaded: result.loaded,
        basicCall: result.basicCall,
        passed: result.installed && result.loaded && result.basicCall,
        scratchRef: result.scratchRef,
        dispatchId: result.dispatchId,
        at: clock(),
      };
      await persistEvent({
        runId,
        kind: 'smoke-result',
        pluginId: row.pluginId,
        detail: { passed: smoke.passed },
        at: clock(),
      });
      if (!smoke.passed) {
        scored.badges = [...new Set([...scored.badges.filter((badge) => badge !== 'adoption-candidate'), 'smoke-failed' as const])];
      }
    }
    // 叙述后产（先分后叙，J9-②）：隔离为 model-produced
    let narrative: PluginAssessment['narrative'] | undefined;
    if (deps.narrator !== undefined) {
      const narrated = await deps.narrator.narrate({ pluginId: row.pluginId, pluginName: row.pluginName });
      narrative = {
        summary: narrated.summary.slice(0, params.narrativeTokenCap),
        risks: [...narrated.risks],
        sourcePluginIds: [row.pluginId],
      };
    }
    const { id, version } = nextAssessmentId(row.pluginId);
    const assessment: PluginAssessment = {
      assessmentId: id,
      pluginId: row.pluginId,
      pluginName: row.pluginName,
      version,
      ...(version > 1
        ? { supersedes: `${row.pluginId}#v${version - 1}` }
        : {}),
      scanRunId,
      registrySnapshotAt: snapshotAt,
      dimensions: scored.grade === 'C' && scored.veto === undefined ? {} : {},
      composite: scored.composite,
      grade: scored.grade,
      ...(scored.veto !== undefined ? { veto: scored.veto } : {}),
      badges: scored.badges,
      ...(smoke !== undefined ? { smoke } : {}),
      ...(narrative !== undefined ? { narrative } : {}),
      credentials: { structured: 'execution-verified', upstream: 'third-party-registry', narrative: 'model-produced' },
      assessedAt: clock(),
    };
    // dimensions 需要完整四维（record schema）；重算并填入
    const { scoreDimensions } = await import('./domain.ts');
    (assessment as { dimensions: Record<string, unknown> }).dimensions = scoreDimensions(row);
    await persistAssessment(assessment);
    await persistEvent({
      runId,
      kind: 'plugin-assess',
      pluginId: row.pluginId,
      detail: { assessmentId: id, grade: scored.grade, composite: scored.composite },
      at: clock(),
    });
    return assessment;
  };

  return {
    async initialize() {
      loadParams();
      for (const [, value] of assessmentsTable.entries()) {
        const row = value as PluginAssessment;
        const current = assessmentVersions.get(row.pluginId) ?? 0;
        if (row.version > current) assessmentVersions.set(row.pluginId, row.version);
      }
      runCounter = [...runsTable.keys()].length;
      eventCounter = [...eventsTable.keys()].length;
      if (paramsTable.get(SCOUT_PARAMS_KEY) === undefined) {
        await emit({
          family: 'pluginScout/change',
          businessId: SCOUT_PARAMS_BUSINESS_ID,
          payload: scoutParamsPayload(loadParams()),
          domainWrite: async () => {
            await paramsTable.put(SCOUT_PARAMS_KEY, loadParams() as never);
          },
        });
      }
    },

    async scan(trigger) {
      const params = loadParams();
      const runId = `sr-${++runCounter}` as never;
      const startedAt = clock();
      let run: ScoutRun = {
        runId,
        trigger: {
          kind: trigger.kind,
          ...(trigger.scope !== undefined ? { scope: { ...trigger.scope } } : {}),
        },
        status: 'fetching',
        snapshot: { at: startedAt, pluginCount: 0, source: 'live' },
        assessed: [],
        unassessed: [],
        reportChunkIds: [],
        startedAt,
      };
      try {
        await persistEvent({ runId, kind: 'scan-begin', detail: { trigger: trigger.kind }, at: clock() });
        // ① 快照（断网降级由 registry seam 决定 source=cache；J9-④）
        const snapshot = await deps.registry.fetchSnapshot();
        run = {
          ...run,
          status: 'assessing',
          snapshot: { at: snapshot.at, pluginCount: snapshot.plugins.length, source: snapshot.source },
        };
        await persistEvent({
          runId,
          kind: 'snapshot-fetch',
          detail: { source: snapshot.source, count: snapshot.plugins.length },
          at: clock(),
        });
        // ② 逐插件确定性计分（≤帽；增量优先级 U6 v1 = 表序）
        const candidates = snapshot.plugins.slice(0, params.maxAssessPerScan);
        const skipped = snapshot.plugins.slice(params.maxAssessPerScan);
        for (const row of candidates) {
          const assessment = await assessRow(row, String(runId), snapshot.at, String(runId));
          run = { ...run, assessed: [...run.assessed, assessment.assessmentId] };
        }
        run = {
          ...run,
          unassessed: skipped.map((row) => ({ pluginId: row.pluginId, reason: 'maxAssessPerScan' })),
        };
        // ③ 报告回写（J6 双 chunk 双凭证）
        run = { ...run, status: 'reporting' };
        if (deps.pipe !== undefined) {
          for (const assessmentId of run.assessed) {
            const stored = assessmentsTable.get(assessmentId) as PluginAssessment | undefined;
            if (stored === undefined) continue;
            const structured = await deps.pipe.append(
              { sessionId: deps.session.sessionId },
              {
                content: `plugin-assessment ${stored.pluginId}: grade=${stored.grade} composite=${stored.composite.toFixed(3)}`,
                chunkType: 'fact',
                credential: 'execution-verified',
              },
            );
            if (stored.narrative !== undefined) {
              await deps.pipe.append(
                { sessionId: deps.session.sessionId },
                {
                  content: stored.narrative.summary,
                  chunkType: 'reflection',
                  credential: 'model-produced',
                },
              );
            }
            run = { ...run, reportChunkIds: [...run.reportChunkIds, String(structured.id)] };
          }
        }
        await persistEvent({ runId, kind: 'report-write', detail: { chunks: run.reportChunkIds.length }, at: clock() });
        // ④ 终态：帽内未评完 = partial（J10 显式终态）
        const final: ScoutRun = {
          ...run,
          status: run.unassessed.length > 0 ? 'partial' : 'completed',
          endedAt: clock(),
        };
        await persistEvent({ runId, kind: 'scan-end', detail: { status: final.status }, at: clock() });
        await persistRun(final);
        return final;
      } catch (error) {
        const failed: ScoutRun = {
          ...run,
          status: 'failed',
          stage: 'fetch',
          failureReason: error instanceof Error ? error.message : String(error),
          endedAt: clock(),
        };
        await persistRun(failed);
        return failed;
      }
    },

    async assess(pluginId) {
      const snapshot = await deps.registry.fetchSnapshot();
      const row = snapshot.plugins.find((candidate) => candidate.pluginId === pluginId);
      if (row === undefined) throw new TdaError('SCOUT_PLUGIN_NOT_FOUND', `registry 中无插件 ${pluginId}`);
      return assessRow(row, 'manual', snapshot.at, 'manual');
    },

    async smokeTest(pluginId) {
      if (deps.smoke === undefined) throw new TdaError('SCOUT_SMOKE_SEAM_MISSING', '冒烟 seam 未接入（T0.5 装配层）');
      const result = await deps.smoke.run({ pluginId });
      return {
        installed: result.installed,
        loaded: result.loaded,
        basicCall: result.basicCall,
        passed: result.installed && result.loaded && result.basicCall,
        scratchRef: result.scratchRef,
        dispatchId: result.dispatchId,
        at: clock(),
      };
    },

    assessments(filter = {}) {
      const latest = new Map<string, PluginAssessment>();
      for (const [, value] of assessmentsTable.entries()) {
        const row = value as PluginAssessment;
        const current = latest.get(row.pluginId);
        if (current === undefined || row.version > current.version) latest.set(row.pluginId, row);
      }
      return [...latest.values()]
        .filter((row) => (filter.grade !== undefined ? row.grade === filter.grade : true))
        .filter((row) => (filter.pluginId !== undefined ? row.pluginId === filter.pluginId : true))
        .filter((row) =>
          filter.fresh === true ? clock() - row.registrySnapshotAt <= loadParams().snapshotTtlMs : true,
        )
        .sort((a, b) => b.composite - a.composite);
    },

    assessment(pluginId) {
      return this.assessments({ pluginId })[0];
    },

    report(runId) {
      const grades: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 };
      const latest = this.assessments();
      for (const row of latest) grades[row.grade] = (grades[row.grade] ?? 0) + 1;
      const candidates = latest
        .filter((row) => row.badges.includes('adoption-candidate'))
        .map((row) => ({ pluginId: row.pluginId, grade: row.grade, composite: row.composite }));
      const narratives = latest
        .filter((row) => row.narrative !== undefined)
        .map((row) => ({ pluginId: row.pluginId, summary: row.narrative!.summary }));
      const run = runId !== undefined ? (runsTable.get(runId) as ScoutRun | undefined) : undefined;
      return {
        runId: runId ?? (run !== undefined ? String(run.runId) : ''),
        snapshot: run?.snapshot ?? { at: clock(), pluginCount: 0, source: 'live' },
        grades,
        topAdoptionCandidates: candidates,
        narratives,
      };
    },

    params() {
      return loadParams();
    },

    async setParams(patch) {
      const current = loadParams();
      const next = ParamsSchema.parse({
        ...current,
        ...patch,
        weights: { ...current.weights, ...(patch.weights ?? {}) },
        gradeThresholds: { ...current.gradeThresholds, ...(patch.gradeThresholds ?? {}) },
        revision: current.revision + 1,
      });
      paramsRef = next;
      await emit({
        family: 'pluginScout/change',
        businessId: SCOUT_PARAMS_BUSINESS_ID,
        payload: scoutParamsPayload(next),
        domainWrite: async () => {
          await paramsTable.put(SCOUT_PARAMS_KEY, next as never);
        },
      });
      return next;
    },
  };
}

export { scoutDomainSpec };
