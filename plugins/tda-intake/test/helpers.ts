/**
 * tda-intake 测试helpers：内存假体实现被依赖的各服务面，并记录调用日志
 * （否定性断言如"intake 零目标编辑权"靠假体面与 calls 自证）。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuditIndex,
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  openTdaDomain,
  type AuditIndex,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaBusEvent,
} from '@tda/kernel';
import { intakeDomainSpec, INTAKE_PARAMS_KEY, type IntakeParams, type IntakeTables } from '../src/domain.ts';
import {
  createIntakeService,
  type IntakeGoalSeam,
  type IntakeGoalView,
  type IntakeSupervisionSeam,
  type IntakeTimelineSeam,
  type IntakeService,
} from '../src/service.ts';

export const NOW = 1_700_000_000_000;

// ── 假 session sink ────────────────────────────────────────────────────

export interface FakeSession {
  readonly sessionId: string;
  readonly appends: { family: string; businessId: string; payload: Record<string, unknown> }[];
  append(event: { family: string; businessId: string; payload: Record<string, unknown> }): number;
  flush(): void;
}

export function createFakeSession(sessionId = 'sess-intake'): FakeSession {
  const appends: FakeSession['appends'] = [];
  let seq = 0;
  return {
    sessionId,
    appends,
    append(event) {
      seq += 1;
      appends.push(event);
      return seq;
    },
    flush() {
      /* 测试用内存 sink，无持久化屏障 */
    },
  };
}

// ── 假 goalTree（唯一写方法 create + 只读 get；记录调用） ──────────────

export interface FakeGoalTree extends IntakeGoalSeam {
  readonly goals: Map<string, IntakeGoalView & { createReq: unknown }>;
  readonly calls: string[];
  configureFailOn(objectiveSubstring: string): void;
}

export function createFakeGoalTree(): FakeGoalTree {
  const goals = new Map<string, IntakeGoalView & { createReq: unknown }>();
  const calls: string[] = [];
  let failOn = '';
  let counter = 0;
  return {
    goals,
    calls,
    configureFailOn(objectiveSubstring) {
      failOn = objectiveSubstring;
    },
    async create(_actor, req) {
      calls.push(`create:${req.objective}`);
      if (failOn !== '' && req.objective.includes(failOn)) {
        throw new Error(`GOAL_CREATE_FAILED:${req.objective}`);
      }
      if (req.source === 'intake' && req.intakeProposalId === undefined) {
        throw new Error('INTAKE_PROVENANCE_REQUIRED');
      }
      counter += 1;
      const view: IntakeGoalView & { createReq: unknown } = {
        id: `goal-${counter}`,
        objective: req.objective,
        ...(req.source !== undefined ? { source: req.source } : {}),
        ...(req.intakeProposalId !== undefined ? { intakeProposalId: req.intakeProposalId } : {}),
        createReq: { ...req },
      };
      goals.set(view.id, view);
      return view;
    },
    get(id) {
      calls.push(`get:${id}`);
      return goals.get(id);
    },
  };
}

// ── 假 supervision（request/approve，token 一次性） ─────────────────────

export interface FakeSupervision extends IntakeSupervisionSeam {
  readonly calls: string[];
  readonly requests: { approvalId: string; kind: string; resume: { from: string; handle: string }; status: string; summary: string }[];
  approve(approvalId: string, token: string): { approvalId: string; nonce: string; from: string; handle: string };
}

export function createFakeSupervision(): FakeSupervision {
  const calls: string[] = [];
  const requests: FakeSupervision['requests'] = [];
  const tokens = new Map<string, string>();
  let counter = 0;
  return {
    calls,
    requests,
    async request(input) {
      calls.push(`request:${input.kind}`);
      counter += 1;
      const approvalId = `appr-${counter}`;
      tokens.set(approvalId, `tok-${counter}`);
      requests.push({
        approvalId,
        kind: input.kind,
        resume: input.resume,
        status: 'pending',
        summary: input.whatToShow.summary,
      });
      return { approvalId };
    },
    approve(approvalId, token) {
      calls.push(`approve:${approvalId}`);
      const expected = tokens.get(approvalId);
      if (expected === undefined || expected !== token) {
        throw Object.assign(new Error('token invalid'), { code: 'APPROVAL_TOKEN_INVALID' });
      }
      tokens.delete(approvalId);
      const request = requests.find((item) => item.approvalId === approvalId);
      if (request !== undefined) request.status = 'approved';
      return {
        approvalId,
        nonce: `nonce-${approvalId}`,
        from: request?.resume.from ?? '',
        handle: request?.resume.handle ?? '',
      };
    },
  };
}

// ── 假 timeline（只暴露 appendUserOriginal；记录全文以证隔离） ──────────

export interface FakeTimeline extends IntakeTimelineSeam {
  readonly chunks: { entryId: string; content: string }[];
}

export function createFakeTimeline(): FakeTimeline {
  const chunks: FakeTimeline['chunks'] = [];
  let counter = 0;
  return {
    chunks,
    async appendUserOriginal(content) {
      counter += 1;
      const entryId = `tl-${counter}`;
      chunks.push({ entryId, content });
      return { entryId };
    },
  };
}

// ── 假 LLM 工序（确定性 scripted） ─────────────────────────────────────

export interface FakeExtractor {
  (input: { rawEntryId: string }): Promise<{
    objective: string;
    completionCriteria: string[];
    constraints: string[];
    budgetHint?: { tokens?: number };
    generation: { provider: string; model: string; schemaHash: string };
  }>;
  /** 测试开关：返回坏草稿（空目标——deriveQuestions 应给 blocking 问题）。 */
  mode: 'good' | 'sparse' | null;
}

export function createFakeExtractor(): FakeExtractor {
  const fake = (async (input: { rawEntryId: string }) => {
    void input;
    if (fake.mode === 'sparse') {
      return {
        objective: '',
        completionCriteria: [],
        constraints: [],
        generation: { provider: 'scripted', model: 'fake-sidekick', schemaHash: 'sha-draft' },
      };
    }
    return {
      objective: '整理灯环协议依赖清单',
      completionCriteria: ['依赖清单产出并双写对账'],
      constraints: ['不改动固件'],
      budgetHint: { tokens: 50_000 },
      generation: { provider: 'scripted', model: 'fake-sidekick', schemaHash: 'sha-draft' },
    };
  }) as FakeExtractor;
  fake.mode = null;
  return fake;
}

export interface FakeDecomposer {
  (input: { objective: string; completionCriteria: readonly string[]; constraints: readonly string[] }): Promise<{
    nodes: readonly { tempId: string; parentTempId?: string; objective: string; completionCriteria: string[]; pinned?: string[] }[];
    generation: { provider: string; model: string; schemaHash: string };
  }>;
  /** 测试开关：坏提议（悬空父/多根/成环/空 criteria）。 */
  mode: 'good' | 'dangling' | 'multi-root' | 'cycle' | 'empty-criteria' | null;
}

export function createFakeDecomposer(): FakeDecomposer {
  const fake = (async (input: { objective: string }) => {
    const good = [
      { tempId: 'g1', objective: input.objective, completionCriteria: ['标准一'] },
      { tempId: 'g1.1', parentTempId: 'g1', objective: '子目标：收集依赖', completionCriteria: ['子标准'] },
    ];
    switch (fake.mode) {
      case 'dangling':
        return {
          nodes: [{ tempId: 'g1', parentTempId: 'ghost', objective: 'x', completionCriteria: ['c'] }],
          generation: { provider: 'scripted', model: 'fake-lead', schemaHash: 'sha-tree' },
        };
      case 'multi-root':
        return {
          nodes: [
            { tempId: 'g1', objective: 'x', completionCriteria: ['c'] },
            { tempId: 'g2', objective: 'y', completionCriteria: ['c'] },
          ],
          generation: { provider: 'scripted', model: 'fake-lead', schemaHash: 'sha-tree' },
        };
      case 'cycle':
        return {
          nodes: [
            { tempId: 'g1', parentTempId: 'g2', objective: 'x', completionCriteria: ['c'] },
            { tempId: 'g2', parentTempId: 'g1', objective: 'y', completionCriteria: ['c'] },
          ],
          generation: { provider: 'scripted', model: 'fake-lead', schemaHash: 'sha-tree' },
        };
      case 'empty-criteria':
        return {
          nodes: [{ tempId: 'g1', objective: 'x', completionCriteria: [] }],
          generation: { provider: 'scripted', model: 'fake-lead', schemaHash: 'sha-tree' },
        };
      default:
        return {
          nodes: good,
          generation: { provider: 'scripted', model: 'fake-lead', schemaHash: 'sha-tree' },
        };
    }
  }) as unknown as FakeDecomposer;
  fake.mode = null;
  return fake;
}

// ── 装配 ───────────────────────────────────────────────────────────────

export interface Rig {
  readonly dir: string;
  readonly domain: TdaDomain<IntakeTables>;
  readonly reconciler: DualWriteReconciler;
  readonly index: AuditIndex;
  readonly bus: TdaEventBus;
  readonly published: TdaBusEvent[];
  readonly session: FakeSession;
  readonly goalTree: FakeGoalTree;
  readonly supervision: FakeSupervision;
  readonly timeline: FakeTimeline;
  readonly extractor: FakeExtractor;
  readonly decomposer: FakeDecomposer;
  readonly service: IntakeService;
  dispose(): Promise<void>;
}

export interface RigOptions {
  readonly config?: Partial<IntakeParams>;
  readonly withoutExtractor?: boolean;
  readonly withoutDecomposer?: boolean;
  readonly now?: () => number;
}

export async function setup(options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-intake-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const index = createAuditIndex();
  const domain = await openTdaDomain(intakeDomainSpec, {
    backend,
    onChange: (change) =>
      reconciler.observeChange({
        domain: change.domain,
        table: change.table,
        key: change.key,
        operation: change.operation,
      }),
  });
  const bus = createTdaEventBus();
  const published: Rig['published'] = [];
  bus.subscribe('intake/change', (event) => {
    published.push(event);
  });
  const session = createFakeSession();
  const goalTree = createFakeGoalTree();
  const supervision = createFakeSupervision();
  const timeline = createFakeTimeline();
  const extractor = createFakeExtractor();
  const decomposer = createFakeDecomposer();
  const service = createIntakeService({
    domain,
    session: session as never,
    goalTree,
    supervision,
    timeline,
    ...(options.withoutExtractor === true ? {} : { extractor }),
    ...(options.withoutDecomposer === true ? {} : { decomposer }),
    reconciler,
    index,
    bus,
    now: options.now ?? ((): number => NOW),
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  await service.initialize();
  return {
    dir,
    domain,
    reconciler,
    index,
    bus,
    published,
    session,
    goalTree,
    supervision,
    timeline,
    extractor,
    decomposer,
    service,
    async dispose() {
      await domain.close();
    },
  };
}

export { INTAKE_PARAMS_KEY };
