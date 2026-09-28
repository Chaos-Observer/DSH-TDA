/**
 * T2.1 coach —— 模式聚类与候选生成（**纯函数**，J3/J12/J8）。
 *
 * 回放确定性的承重点：同输入（mismatch 行 + 参数）⇒ 同聚类 ⇒ 同候选序列。
 * 聚类键 = 分类键拼接（taskClass|stage|actionPattern），**非语义原文**；
 * 证据 = 引用不拷贝；confidence = 一致性 × 强度的确定组合。
 */
import type { CoachCandidateKind, CoachPatternSummary, CoachRisk, CoachTopology } from './domain.ts';

/** 聚类输入行：mismatch 经 prediction join 出的分类上下文（零原文）。 */
export interface ClusterRow {
  readonly mismatchId: string;
  readonly predictionId: string;
  readonly taskClass: string;
  readonly stage: string;
  readonly actionPattern: string;
  readonly deltaKind: 'action' | 'outcome' | 'risk-materialized' | 'none';
  readonly errorClass?: string | undefined;
  readonly at: number;
}

export interface BuiltCandidate {
  readonly kind: CoachCandidateKind;
  readonly risk: CoachRisk;
  readonly condition: {
    readonly taskClasses: string[];
    readonly stages: string[];
    readonly problemFeatures: string[];
    readonly actionPattern?: string;
  };
  readonly rule: {
    readonly expect?: string;
    readonly avoid?: string[];
    readonly prefer?: string[];
    readonly shape?: CoachTopology;
  };
  readonly confidence: number;
}

const DELTA_ORDER = ['action', 'outcome', 'risk-materialized', 'none'] as const;

/** 控制流面动作词表（J10：涉及编排/审批/派发的规则 = high，需人类 token）。 */
const CONTROL_FLOW_TOKENS = ['dispatch', 'approval', 'planning', 'task-transition'];

export const isControlFlowPattern = (pattern: string, stage: string): boolean =>
  CONTROL_FLOW_TOKENS.some((token) => pattern.includes(token) || stage === token);

/** 分类键聚类：key = taskClass|stage|actionPattern（J3）。 */
export function clusterRows(rows: readonly ClusterRow[]): Map<string, ClusterRow[]> {
  const clusters = new Map<string, ClusterRow[]>();
  for (const row of rows) {
    const key = `${row.taskClass}|${row.stage}|${row.actionPattern}`;
    const bucket = clusters.get(key);
    if (bucket === undefined) clusters.set(key, [row]);
    else bucket.push(row);
  }
  return clusters;
}

/** 模式摘要（报告主体，结构化）。 */
export function summarizeCluster(key: string, rows: readonly ClusterRow[]): CoachPatternSummary {
  const deltaKinds: Record<string, number> = {};
  for (const kind of DELTA_ORDER) deltaKinds[kind] = 0;
  const errorFreq = new Map<string, number>();
  for (const row of rows) {
    deltaKinds[row.deltaKind] = (deltaKinds[row.deltaKind] ?? 0) + 1;
    if (row.errorClass !== undefined) {
      errorFreq.set(row.errorClass, (errorFreq.get(row.errorClass) ?? 0) + 1);
    }
  }
  const first = rows[0]!;
  const nonNone = rows.filter((row) => row.deltaKind !== 'none').length;
  return {
    key,
    condition: {
      taskClasses: [...new Set(rows.map((row) => row.taskClass))],
      stages: [...new Set(rows.map((row) => row.stage))],
      problemFeatures: nonNone > 0 ? ['mismatch-recurring'] : [],
      actionPattern: first.actionPattern,
    },
    deltaKinds,
    topErrorClasses: [...errorFreq.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([errorClass, freq]) => ({ errorClass, freq })),
    count: rows.length,
    evidence: {
      mismatchIds: rows.map((row) => row.mismatchId),
      transitionIds: rows.map((row) => row.predictionId),
    },
  };
}

/**
 * 候选生成（纯函数，J3/J12）：
 * - kind 由多数 deltaKind 决定：action→meta-path（程序性纠正）；outcome/risk→method-memory（事实性教训）；
 * - risk：控制流面动作（dispatch/approval/planning/task-transition）= high；
 * - confidence = 0.5·一致性 + 0.5·强度（样本对 2×minEvidence 归一）。
 */
export function buildCandidate(
  _key: string,
  rows: readonly ClusterRow[],
  opts: { readonly minEvidenceCount: number; readonly minConfidence: number },
): BuiltCandidate | undefined {
  const nonNoneRows = rows.filter((row) => row.deltaKind !== 'none');
  if (rows.length < opts.minEvidenceCount || nonNoneRows.length === 0) {
    return undefined; // 质量门 ①：证据数不足 → 不产候选
  }
  const counts = new Map<CoachCandidateKind, number>();
  for (const row of nonNoneRows) {
    // 分流（J4）：动作模式带 skill: 前缀 → 技能通道；程序性纠正（action）→ 元路径；
    // 事实性教训（outcome/risk-materialized）→ method-memory（时间线）
    const kind: CoachCandidateKind =
      row.actionPattern.startsWith('skill:')
        ? 'skill'
        : row.deltaKind === 'action'
          ? 'meta-path'
          : 'method-memory';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const kind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const first = rows[0]!;
  const consistency = nonNoneRows.length / rows.length;
  const strength = Math.min(1, rows.length / (2 * opts.minEvidenceCount));
  const confidence = 0.5 * consistency + 0.5 * strength;
  if (confidence < opts.minConfidence) return undefined;
  const risk: CoachRisk = isControlFlowPattern(first.actionPattern, first.stage) ? 'high' : 'medium';
  const topErrors = [...new Set(nonNoneRows.map((row) => row.errorClass).filter((c) => c !== undefined))].map(
    (c) => String(c),
  );
  const condition = {
    taskClasses: [...new Set(rows.map((row) => row.taskClass))],
    stages: [...new Set(rows.map((row) => row.stage))],
    problemFeatures: ['mismatch-recurring'],
    ...(first.actionPattern !== '' ? { actionPattern: first.actionPattern } : {}),
  };
  if (kind === 'meta-path') {
    // 程序性纠正：线性拓扑（observe→verify→synthesize），结构化无原文（J3/U2）
    const shape: CoachTopology = {
      nodes: [
        { id: 's1', kind: 'observe' },
        { id: 's2', kind: 'verify' },
        { id: 's3', kind: 'synthesize' },
      ],
      edges: [
        { from: 's1', to: 's2', kind: 'seq' },
        { from: 's2', to: 's3', kind: 'seq' },
      ],
      entry: 's1',
      exits: ['s3'],
    };
    return {
      kind,
      risk,
      condition,
      rule: {
        expect: `${first.stage}:${first.actionPattern}`,
        ...(topErrors.length > 0 ? { avoid: topErrors } : {}),
        shape,
      },
      confidence,
    };
  }
  return {
    kind,
    risk,
    condition,
    rule: {
      expect: `${first.stage}:${first.actionPattern}`,
      ...(topErrors.length > 0 ? { avoid: topErrors } : {}),
      prefer: ['retry-with-adjusted-args'],
    },
    confidence,
  };
}

/** 质量门（J12 四项）：证据数/条件非空/可 rehearsal 判定/白名单合规（schema 层已断言）。 */
export function passesQualityGate(
  candidate: BuiltCandidate,
  evidenceCount: number,
  minEvidenceCount: number,
): { readonly ok: boolean; readonly reason?: string } {
  if (evidenceCount < minEvidenceCount) {
    return { ok: false, reason: `evidence<minEvidenceCount (${evidenceCount}<${minEvidenceCount})` };
  }
  if (
    candidate.condition.taskClasses.length === 0 &&
    candidate.condition.stages.length === 0 &&
    candidate.condition.actionPattern === undefined
  ) {
    return { ok: false, reason: 'condition-empty' };
  }
  const decidable = candidate.rule.expect !== undefined || candidate.rule.shape !== undefined;
  if (!decidable) return { ok: false, reason: 'not-rehearsal-decidable' };
  return { ok: true };
}
