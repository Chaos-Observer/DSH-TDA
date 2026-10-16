/** T4.4 测试夹具：假体只读面 + 装配（display 无域——零 backend/零 invariants）。 */
import { createTdaEventBus, type TdaEventBus } from '@tda/kernel';
import { describe, expect, it } from 'vitest';
import { tdaDisplayPlugin, type TdaDisplayHandle } from '../src/index.ts';
import type {
  DisplayDriftSeam,
  DisplayGoalSeam,
  DisplaySupervisionSeam,
  DisplayTaskSeam,
  DisplayTimelineSeam,
} from '../src/domain.ts';

export const NOW = 1_760_300_000_000;

export interface FakeGoalItem {
  goalId: string;
  objective: string;
  phase: string;
  stage: string;
  zone: string;
  focus: boolean;
}

export interface FakeTaskItem {
  id: string;
  goalId: string;
  phase: string;
  stage: string;
  proposalPending: boolean;
  outcome?: string | undefined;
  evidence: readonly string[];
  updatedAt: number;
}

export interface FakeApproval {
  approvalId: string;
  kind: string;
  riskLevel: string;
  subject: string;
  whatToShow: { summary: string; riskReasons?: readonly string[]; excerpts?: readonly unknown[] };
  /** 混入 token 字段——snapshot 必须**零 token**（不变量 4 grep 自检）。 */
  token?: string;
}

export interface FakeSupervision extends DisplaySupervisionSeam {
  readonly approvals: Map<string, FakeApproval>;
  readonly decisionLog: { kind: string; approvalId?: string | undefined; at: number }[];
  throws: boolean;
}

export function createFakeSupervision(): FakeSupervision {
  const approvals = new Map<string, FakeApproval>();
  const decisionLog: { kind: string; approvalId?: string | undefined; at: number }[] = [];
  let throws = false;
  const pending = (filter?: { riskLevel?: string; kind?: string }) => {
    if (throws) throw new Error('supervision down');
      return [...approvals.values()].filter(
        (request) =>
          (filter?.kind === undefined || request.kind === filter.kind) &&
          (filter?.riskLevel === undefined || request.riskLevel === filter.riskLevel),
      );
  };
  const attentionStatus = () => {
    if (throws) throw new Error('supervision down');
    return { consumedUnits: 420, quotaUnits: 1000, zone: 'normal', pendingCount: approvals.size, medianResponseMs: undefined };
  };
  const events = () => {
    if (throws) throw new Error('supervision down');
    return [...decisionLog];
  };
  return Object.defineProperties({ approvals, decisionLog, pending, attentionStatus, events }, {
    throws: {
      get: () => throws,
      set: (value: boolean) => {
        throws = value;
      },
    },
  }) as unknown as FakeSupervision;
}

export function createFakeGoal(items: FakeGoalItem[]): DisplayGoalSeam {
  return {
    list: () => items,
  };
}

export function createFakeTaskPool(items: FakeTaskItem[]): DisplayTaskSeam {
  return {
    list: (filter) => (filter?.goalId === undefined ? items : items.filter((task) => task.goalId === filter.goalId)),
  };
}

export function createFakeDrift(): DisplayDriftSeam & { throws: boolean } {
  const state = { throws: false };
  return {
    get throws() {
      return state.throws;
    },
    set throws(value: boolean) {
      state.throws = value;
    },
    trend() {
      if (state.throws) throw new Error('drift down');
      return { band: 'watch', trend: [0.2, 0.35, 0.41] };
    },
  };
}

export function createFakeTimeline(): DisplayTimelineSeam & { readonly chunks: { credential: string; source: string; content: string }[] } {
  const chunks: { credential: string; source: string; content: string }[] = [];
  return {
    chunks,
    async append(_writer, chunk) {
      chunks.push({ credential: chunk.credential, source: chunk.source, content: chunk.content });
      return { id: `entry-${chunks.length}` };
    },
  };
}

export interface Rig {
  readonly handle: TdaDisplayHandle;
  readonly supervision: FakeSupervision;
  readonly drift: ReturnType<typeof createFakeDrift> | undefined;
  readonly timeline: ReturnType<typeof createFakeTimeline>;
  readonly bus: TdaEventBus;
  dispose(): Promise<void>;
}

export interface SetupOptions {
  goals?: FakeGoalItem[];
  tasks?: FakeTaskItem[];
  spectrum?: Record<string, unknown>;
  dot?: string;
  withSupervision?: boolean;
  withDrift?: boolean;
}

export async function setup(options: SetupOptions = {}): Promise<Rig> {
  const goals = options.goals ?? [
    { goalId: 'goal-1', objective: '整理灯环协议依赖清单', phase: 'active', stage: 'executing', zone: 'normal', focus: true },
    { goalId: 'goal-2', objective: '输出配对说明书', phase: 'active', stage: 'planning', zone: 'converge', focus: false },
  ];
  const tasks = options.tasks ?? [
    { id: 'task-1', goalId: 'goal-1', phase: 'complete', stage: 'done', proposalPending: false, outcome: 'success', evidence: ['entry-1', 'entry-2'], updatedAt: NOW },
    { id: 'task-2', goalId: 'goal-1', phase: 'active', stage: 'planning', proposalPending: false, evidence: [], updatedAt: NOW },
    { id: 'task-3', goalId: 'goal-2', phase: 'active', stage: 'planning', proposalPending: true, evidence: [], updatedAt: NOW },
    { id: 'task-4', goalId: 'goal-2', phase: 'blocked', stage: 'planning', proposalPending: false, evidence: [], updatedAt: NOW },
  ];
  const spectrum = options.spectrum ?? {
    focusGoalId: 'goal-1',
    goals: [
      { id: 'goal-1', label: '整理灯环协议依赖清单', stagePath: ['active'], zone: 'normal' },
      { id: 'goal-2', label: '输出配对说明书', stagePath: ['active'], zone: 'converge' },
    ],
    tasks: [
      { id: 'task-1', label: '解析 $ 帧定界', stagePath: ['done'], zone: 'normal', rootGoalId: 'goal-1' },
      { id: 'task-2', label: '验证转义序列', stagePath: ['planning'], zone: 'normal', rootGoalId: 'goal-1' },
    ],
    edges: [
      { kind: 'parent', from: 'goal-1', to: 'task-1' },
      { kind: 'parent', from: 'goal-1', to: 'task-2' },
      { kind: 'alternativeOf', from: 'task-2', to: 'task-1' },
    ],
    truncated: false,
  };
  const dot = options.dot ?? 'digraph taskgraph { "goal-1" [shape=ellipse]; }';
  const supervision = options.withSupervision === false ? undefined : createFakeSupervision();
  if (supervision !== undefined) {
    supervision.approvals.set('appr-1', {
      approvalId: 'appr-1',
      kind: 'dispatch',
      riskLevel: 'high',
      subject: '高风险派发待批',
      whatToShow: { summary: 'writeScopes 超出本地路径', riskReasons: ['T0.5 J9 高风险派发门'], excerpts: [{ ref: 'r', text: '机密原文' }] },
      token: 'tok-secret-123',
    });
    supervision.decisionLog.push(
      { kind: 'approved', approvalId: 'appr-0', at: NOW - 1000 },
      { kind: 'rejected', approvalId: 'appr-0b', at: NOW - 900 },
      { kind: 'requested', approvalId: 'appr-1', at: NOW - 100 },
    );
  }
  const drift = options.withDrift === false ? undefined : createFakeDrift();
  const timeline = createFakeTimeline();
  const bus = createTdaEventBus();
  const handle = await tdaDisplayPlugin.apply({
    goal: createFakeGoal(goals),
    taskPool: createFakeTaskPool(tasks),
    graph: {
      treeView: () => spectrum,
      export: (format) => (format === 'dot' ? dot : JSON.stringify(spectrum)),
    },
    ...(supervision !== undefined ? { supervision } : {}),
    ...(drift !== undefined ? { drift } : {}),
    timeline,
    schedulerSessionId: 'sess-harness-scheduler',
    now: () => NOW,
    bus,
  });
  return {
    handle,
    supervision: supervision as FakeSupervision,
    drift,
    timeline,
    bus,
    dispose: () => handle.dispose(),
  };
}

// describe/it 引用占位（避免 vitest transform 对纯 helper 文件的告警）
void describe;
void expect;
void it;
