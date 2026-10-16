/**
 * tda-graph 测试helpers：内存假体实现三个权威域只读面，并记录调用日志
 * （否定性断言"graph 全查询面前后权威域 revision 不变"靠只读假体自证）。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDualWriteReconciler,
  createJsonBackend,
  createTdaEventBus,
  openTdaDomain,
  type DualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaBusEvent,
} from '@tda/kernel';
import { graphDomainSpec, GRAPH_PARAMS_KEY, type GraphParams, type GraphTables } from '../src/domain.ts';
import {
  createGraphService,
  type GraphFileEdge,
  type GraphFileNode,
  type GraphGoalSeam,
  type GraphGoalView,
  type GraphTaskSeam,
  type GraphTaskView,
  type GraphWorkspaceSeam,
  type TaskGraphService,
} from '../src/service.ts';

export const NOW = 1_700_000_000_000;

export function makeGoal(overrides: Partial<GraphGoalView> = {}): GraphGoalView {
  return {
    id: 'goal-1',
    objective: '完成灯环抓取',
    phase: 'active',
    focus: false,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<GraphTaskView> = {}): GraphTaskView {
  return {
    id: 'task-1',
    goalId: 'goal-1',
    subject: '整理依赖清单',
    phase: 'active',
    stage: 'planning',
    zone: 'normal',
    blockedBy: [],
    ...overrides,
  };
}

export function makeFile(path: string, overrides: Partial<GraphFileNode> = {}): GraphFileNode {
  return {
    path,
    ignored: false,
    lastScanId: 'scan-1',
    ...overrides,
  };
}

// ── 假权威域（只读 + 调用日志） ─────────────────────────────────────────

export interface FakeGoal extends GraphGoalSeam {
  readonly goals: Map<string, GraphGoalView>;
  readonly calls: string[];
  seed(goal: GraphGoalView): void;
}

export function createFakeGoal(seed: readonly GraphGoalView[] = []): FakeGoal {
  const goals = new Map<string, GraphGoalView>();
  for (const goal of seed) goals.set(goal.id, goal);
  const calls: string[] = [];
  return {
    goals,
    calls,
    seed(goal) {
      goals.set(goal.id, goal);
    },
    tree(rootId) {
      calls.push(`tree:${rootId ?? 'all'}`);
      const all = [...goals.values()];
      if (rootId === undefined) return all;
      // 子树：root + 后代（parentId 链）
      const inSubtree = new Set([rootId]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const goal of all) {
          if (goal.parentId !== undefined && inSubtree.has(goal.parentId) && !inSubtree.has(goal.id)) {
            inSubtree.add(goal.id);
            changed = true;
          }
        }
      }
      return all.filter((goal) => inSubtree.has(goal.id));
    },
    get(id) {
      calls.push(`get:${id}`);
      return goals.get(id);
    },
  };
}

export interface FakeTaskPool extends GraphTaskSeam {
  readonly tasks: Map<string, GraphTaskView>;
  readonly calls: string[];
  seed(task: GraphTaskView): void;
}

export function createFakeTaskPool(seed: readonly GraphTaskView[] = []): FakeTaskPool {
  const tasks = new Map<string, GraphTaskView>();
  for (const task of seed) tasks.set(task.id, task);
  const calls: string[] = [];
  return {
    tasks,
    calls,
    seed(task) {
      tasks.set(task.id, task);
    },
    list(filter) {
      calls.push('list');
      return [...tasks.values()].filter((task) => filter?.goalId === undefined || task.goalId === filter.goalId);
    },
    get(id) {
      calls.push(`get:${id}`);
      return tasks.get(id);
    },
  };
}

export interface FakeWorkspace extends GraphWorkspaceSeam {
  readonly neighborhoods: Map<string, { nodes: GraphFileNode[]; edges: GraphFileEdge[] }>;
  readonly calls: string[];
  setNeighborhood(taskId: string, nodes: readonly GraphFileNode[], edges: readonly GraphFileEdge[]): void;
}

export function createFakeWorkspace(): FakeWorkspace {
  const neighborhoods = new Map<string, { nodes: GraphFileNode[]; edges: GraphFileEdge[] }>();
  const calls: string[] = [];
  return {
    neighborhoods,
    calls,
    setNeighborhood(taskId, nodes, edges) {
      neighborhoods.set(taskId, { nodes: [...nodes], edges: [...edges] });
    },
    graph(taskId) {
      calls.push(`graph:${taskId}`);
      return neighborhoods.get(taskId) ?? { nodes: [], edges: [] };
    },
  };
}

// ── 装配 ───────────────────────────────────────────────────────────────

export interface Rig {
  readonly dir: string;
  readonly domain: TdaDomain<GraphTables>;
  readonly reconciler: DualWriteReconciler;
  readonly bus: TdaEventBus;
  readonly published: TdaBusEvent[];
  readonly goal: FakeGoal;
  readonly taskPool: FakeTaskPool;
  readonly workspace: FakeWorkspace;
  readonly service: TaskGraphService;
  dispose(): Promise<void>;
}

export interface RigOptions {
  readonly goals?: readonly GraphGoalView[];
  readonly tasks?: readonly GraphTaskView[];
  readonly config?: Partial<GraphParams>;
  readonly now?: () => number;
  /** 关闭 boot 重建（测试手动触发）。 */
  readonly skipInitialize?: boolean;
}

export async function setup(options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-graph-'));
  const backend = createJsonBackend(dir);
  const reconciler = createDualWriteReconciler();
  const domain = await openTdaDomain(graphDomainSpec, {
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
  // 记录全部族的总线发布（graph 应当零发布——J10）
  bus.subscribe('*', (event) => {
    published.push(event);
  });
  const goal = createFakeGoal(options.goals ?? []);
  const taskPool = createFakeTaskPool(options.tasks ?? []);
  const workspace = createFakeWorkspace();
  const service = createGraphService({
    domain,
    goal,
    taskPool,
    workspace,
    reconciler,
    now: options.now ?? ((): number => NOW),
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  if (options.skipInitialize !== true) {
    await service.initialize();
  }
  return {
    dir,
    domain,
    reconciler,
    bus,
    published,
    goal,
    taskPool,
    workspace,
    service,
    async dispose() {
      await domain.close();
    },
  };
}

export { GRAPH_PARAMS_KEY };
