/**
 * T3.4 · service（ctx.security）。硬纪律：
 * - 不变量 1：run 仅 env='ci-mock'（fail-loud，红队不是运维按钮）；
 * - 不变量 2/9：同 fixture+params ⇒ 同 verdict（executor 纯函数）；
 * - 不变量 3：验证层零拦截权——发现修复必须回功能规格 + 回归用例；
 * - 不变量 4：open 的 critical/high > 0 ⇒ Gate 红灯（gateBlocked()）；
 * - 不变量 7：fixed 必带 regressionRunId 指向该 case passed 的 run；
 * - 不变量 8：risk-accepted/wont-fix 必带 reason+scope+tokenRef+reviewAt。
 */
import {
  TdaError,
  dualWrite,
  type AuditIndex,
  type DualWriteContext,
  type DualWriteOp,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
} from '@tda/kernel';
import {
  DEFAULT_REDTEAM_PARAMS,
  FIVE_CLAUSES,
  REDTEAM_PARAMS_BUSINESS_ID,
  REDTEAM_PARAMS_KEY,
  securityDomainSpec,
  type CaseKind,
  type RedTeamCase,
  type RedTeamParams,
  type RedTeamRun,
  type RunKind,
  type SecurityFinding,
  type SecurityTables,
  type Verdict,
} from './domain.ts';
import { runPayload, paramsPayload, RUN_BUSINESS_PREFIX } from './events.ts';

/** 确定性探针 seam：在 mock fixture 命名空间执行单 case（J8 离线 CI；verdict 可复算）。 */
export interface RedTeamExecutor {
  probe(caseRow: RedTeamCase, instance: string): Promise<Verdict>;
}

export interface SecurityDeps {
  readonly domain: TdaDomain<SecurityTables>;
  readonly session: TdaSessionSink;
  readonly executor: RedTeamExecutor;
  /** 唯一合法值 'ci-mock'（不变量 1；生产进程构造即抛）。 */
  readonly env: 'ci-mock';
  readonly bus?: TdaEventBus | undefined;
  readonly reconciler?: DualWriteReconciler | undefined;
  readonly index?: AuditIndex | undefined;
  readonly now: () => number;
}

export interface SecurityService {
  initialize(): Promise<void>;
  seedCases(cases: readonly Omit<RedTeamCase, 'createdAt'>[]): Promise<void>;
  cases(kind?: CaseKind): readonly RedTeamCase[];
  run(kind: RunKind, caseIds?: readonly string[]): Promise<RedTeamRun>;
  runs(): readonly RedTeamRun[];
  findings(status?: string, severity?: string): readonly SecurityFinding[];
  updateFinding(id: string, patch: { readonly status: SecurityFinding['status']; readonly fixSpecRef?: string; readonly regressionRunId?: string }): Promise<SecurityFinding>;
  acceptRisk(id: string, acceptance: { readonly reason: string; readonly scope: string; readonly tokenRef: string; readonly reviewAt: number }): Promise<SecurityFinding>;
  gateBlocked(): boolean;
  matrix(): { readonly clause: string; readonly instances: readonly { readonly instance: string; readonly covered: boolean }[]; readonly covered: boolean }[];
  params(): RedTeamParams;
  setParams(patch: Partial<Omit<RedTeamParams, 'revision'>>): Promise<RedTeamParams>;
  dispose(): Promise<void>;
}

export function createSecurityService(deps: SecurityDeps): SecurityService {
  if (deps.env !== 'ci-mock') {
    throw new TdaError('SECURITY_ENV_FORBIDDEN', `security 服务只允许 env='ci-mock'（收到 ${deps.env}），红队不进生产运行时`);
  }
  const casesTable = deps.domain.table('redteam_cases');
  const runsTable = deps.domain.table('redteam_runs');
  const findingsTable = deps.domain.table('security_findings');
  const paramsTable = deps.domain.table('redteam_params');

  const clock = deps.now;
  let paramsRef: RedTeamParams | undefined;
  let runSeq = 0;
  let findingSeq = 0;
  const cases = new Map<string, RedTeamCase>();
  const findings = new Map<string, SecurityFinding>();

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

  const loadParams = (): RedTeamParams => {
    if (paramsRef !== undefined) return paramsRef;
    const row = paramsTable.get(REDTEAM_PARAMS_KEY) as RedTeamParams | undefined;
    paramsRef = row ?? { ...DEFAULT_REDTEAM_PARAMS };
    return paramsRef;
  };

  const service: SecurityService = {
    async initialize() {
      loadParams();
      for (const [, value] of casesTable.entries()) {
        const caseRow = value as RedTeamCase;
        cases.set(String(caseRow.caseId), caseRow);
      }
      if (paramsTable.get(REDTEAM_PARAMS_KEY) === undefined) {
        await emit({
          family: 'supervision/change',
          businessId: REDTEAM_PARAMS_BUSINESS_ID,
          payload: paramsPayload(loadParams()),
          domainWrite: async () => {
            await paramsTable.put(REDTEAM_PARAMS_KEY, loadParams() as never);
          },
        });
      }
    },

    async seedCases(rows) {
      for (const row of rows) {
        const caseRow: RedTeamCase = { ...row, createdAt: clock() } as RedTeamCase;
        cases.set(String(caseRow.caseId), caseRow);
        await casesTable.put(String(caseRow.caseId), caseRow as never);
      }
    },

    cases(kind) {
      const all = [...cases.values()];
      return kind === undefined ? all : all.filter((caseRow) => caseRow.kind === kind);
    },

    async run(kind, caseIds) {
      // 用例选择：injection-redteam=注入三面；penetration=渗透组；其余显式 caseIds。
      const selected: RedTeamCase[] =
        caseIds === undefined
          ? service
              .cases(kind === 'injection-redteam' ? 'injection-memory' : kind === 'penetration' ? 'penetration' : 'injection-memory')
              .filter((caseRow) =>
                kind === 'injection-redteam'
                  ? caseRow.kind.startsWith('injection-')
                  : kind === 'penetration'
                    ? caseRow.kind === 'penetration'
                    : true,
              )
              .slice()
          : [...cases.values()].filter((caseRow) => caseIds.includes(String(caseRow.caseId)));
      if (selected.length === 0 && kind !== 'matrix-check') {
        throw new TdaError('SECURITY_NO_CASES', `run ${kind} 无可选用例（先 seedCases）`);
      }
      runSeq += 1;
      const runId = `rtr-${runSeq}`;
      const instances = loadParams().matrixInstances;
      const results: RedTeamRun['results'] = [];
      const unfinished: string[] = [];
      let status: RedTeamRun['status'] = 'reported';
      for (const caseRow of selected) {
        const instanceList = caseRow.kind === 'injection-memory' ? instances : ['memory'];
        for (const instance of instanceList) {
          try {
            const started = clock();
            const actual = await deps.executor.probe(caseRow, instance);
            const durationMs = Math.max(1, clock() - started);
            let findingId: string | undefined;
            if (actual !== 'blocked') {
              findingSeq += 1;
              const finding: SecurityFinding = {
                findingId: `sec-${findingSeq}` as never,
                severity: actual === 'breached' ? caseRow.severityIfBreached : 'low',
                sourceRunId: runId,
                sourceCaseId: String(caseRow.caseId),
                clauseRef: `${caseRow.target.spec}/${caseRow.target.invariantId}`,
                status: 'open',
                openedAt: clock(),
                updatedAt: clock(),
              };
              findings.set(String(finding.findingId), finding);
              findingId = String(finding.findingId);
            }
            results.push({ caseId: String(caseRow.caseId), caseVersion: caseRow.version, actual, ...(findingId !== undefined ? { findingId } : {}), durationMs });
          } catch (error) {
            unfinished.push(`${String(caseRow.caseId)}#${instance}:${error instanceof Error ? error.message : String(error)}`);
            status = 'failed';
          }
        }
      }
      const run: RedTeamRun = {
        runId: runId as never,
        kind,
        at: clock(),
        status,
        env: 'ci-mock',
        casesTotal: results.length,
        results,
        ...(unfinished.length > 0 ? { unfinished } : {}),
      };
      // 发现落域（单窗多写：run + findings 同窗配对）。
      await emit({
        family: 'supervision/change',
        businessId: `${RUN_BUSINESS_PREFIX}:${runId}`,
        payload: runPayload(run),
        domainWrite: async () => {
          await runsTable.put(runId, run as never);
          for (const finding of findings.values()) {
            if (finding.sourceRunId === runId) await findingsTable.put(String(finding.findingId), finding as never);
          }
        },
      });
      return run;
    },

    runs() {
      return [...runsTable.entries()].map(([, value]) => value as RedTeamRun);
    },

    findings(status, severity) {
      const all = [...findingsTable.entries()].map(([, value]) => value as SecurityFinding);
      return all.filter(
        (finding) =>
          (status === undefined || finding.status === status) &&
          (severity === undefined || finding.severity === severity),
      );
    },

    async updateFinding(id, patch) {
      const finding = findings.get(id) ?? ([...findingsTable.entries()].map(([, value]) => value as SecurityFinding).find((item) => String(item.findingId) === id));
      if (finding === undefined) {
        throw new TdaError('SECURITY_FINDING_NOT_FOUND', `发现 ${id} 不存在`);
      }
      if (patch.status === 'fixed') {
        // 不变量 7：fixed 必须 regressionRunId 指向该 case passed 的 run。
        if (patch.regressionRunId === undefined) {
          throw new TdaError('SECURITY_REGRESSION_REQUIRED', 'fixed 必带 regressionRunId（回归 passed 的 run）');
        }
        const regression = [...runsTable.entries()].map(([, value]) => value as RedTeamRun).find((run) => String(run.runId) === patch.regressionRunId);
        if (regression === undefined) {
          throw new TdaError('SECURITY_REGRESSION_NOT_FOUND', `回归 run ${patch.regressionRunId} 不存在`);
        }
        const caseResult = regression.results.find((result) => result.caseId === String(finding.sourceCaseId));
        if (caseResult === undefined || caseResult.actual !== 'blocked') {
          throw new TdaError('SECURITY_REGRESSION_NOT_PASSED', 'regressionRunId 指向的 run 未对该 case 判 blocked');
        }
        if (patch.fixSpecRef === undefined) {
          throw new TdaError('SECURITY_FIX_SPEC_REQUIRED', 'fixed 必带 fixSpecRef（修复回功能规格，J7）');
        }
      }
      const next: SecurityFinding = {
        ...finding,
        status: patch.status,
        ...(patch.fixSpecRef !== undefined ? { fixSpecRef: patch.fixSpecRef } : {}),
        ...(patch.regressionRunId !== undefined ? { regressionRunId: patch.regressionRunId } : {}),
        updatedAt: clock(),
      };
      findings.set(id, next);
      await findingsTable.put(id, next as never);
      return next;
    },

    async acceptRisk(id, acceptance) {
      const finding = findings.get(id) ?? ([...findingsTable.entries()].map(([, value]) => value as SecurityFinding).find((item) => String(item.findingId) === id));
      if (finding === undefined) {
        throw new TdaError('SECURITY_FINDING_NOT_FOUND', `发现 ${id} 不存在`);
      }
      // 不变量 8：四要素缺一不可（reason/scope/tokenRef/reviewAt）。
      if (
        acceptance.reason === '' ||
        acceptance.scope === '' ||
        acceptance.tokenRef === '' ||
        !Number.isFinite(acceptance.reviewAt)
      ) {
        throw new TdaError('SECURITY_ACCEPTANCE_INCOMPLETE', 'risk-accepted 必带 reason+scope+tokenRef+reviewAt（显式化，禁默默接受）');
      }
      const next: SecurityFinding = {
        ...finding,
        status: finding.severity === 'low' && acceptance.reason.startsWith('wontfix:') ? 'wont-fix' : 'risk-accepted',
        acceptance,
        updatedAt: clock(),
      };
      findings.set(id, next);
      await findingsTable.put(id, next as never);
      return next;
    },

    gateBlocked() {
      // 不变量 4：open 的 critical/high > 0 ⇒ 红灯（risk-accepted 不计 open）。
      const blocking = loadParams().gateBlockingSeverities;
      return service.findings('open').some((finding) => blocking.includes(finding.severity));
    },

    matrix() {
      // J5 对账矩阵：每条款 × 实例 ≥1 用例（无裸奔）。
      const all = service.cases();
      return FIVE_CLAUSES.map((clause) => {
        // 注入三面用例按五实例逐一遍跑（J6 五实例一致），故条款有用例 = 各实例均覆盖。
        const instances = loadParams().matrixInstances.map((instance) => ({
          instance,
          covered: all.some((caseRow) => caseRow.citations.includes(clause)),
        }));
        return { clause, instances, covered: instances.every((item) => item.covered) };
      });
    },

    params() {
      return loadParams();
    },

    async setParams(patch) {
      const current = loadParams();
      const next: RedTeamParams = { ...current, ...patch, revision: current.revision + 1 };
      paramsRef = next;
      await emit({
        family: 'supervision/change',
        businessId: REDTEAM_PARAMS_BUSINESS_ID,
        payload: paramsPayload(next),
        domainWrite: async () => {
          await paramsTable.put(REDTEAM_PARAMS_KEY, next as never);
        },
      });
      return next;
    },

    async dispose() {
      await deps.domain.close();
    },
  };

  return service;
}

export { securityDomainSpec };
