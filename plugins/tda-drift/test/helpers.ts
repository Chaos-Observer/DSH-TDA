/**
 * T1.5 测试脚手架：假目标层（只读面 + recordCalibration 记录器）/ 假任务面 /
 * 假 transitions 面。
 *
 * **否定性断言的关键**：假目标层记录每一次调用名——`calls` 里不允许出现
 * edit/focus/complete 等 mutation（J1"零目标写权"的实证）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJsonBackend,
  openTdaDomain,
  type TdaDomain,
  type TdaSessionSink,
  type TdaStorageBackend,
} from '@tda/kernel';
import { driftDomainSpec, type DriftTables } from '../src/domain.ts';
import {
  createDriftService,
  type DriftCalibrationRow,
  type DriftConfig,
  type DriftGoalSeam,
  type DriftGoalView,
  type DriftPredictorSeam,
  type DriftService,
  type DriftTaskSeam,
  type DriftTaskView,
} from '../src/service.ts';

export interface FakeGoalState {
  readonly seam: DriftGoalSeam;
  readonly goals: Map<string, DriftGoalView>;
  readonly edits: { goalId: string; at: number }[];
  readonly calibrations: DriftCalibrationRow[];
  /** 每一次 seam 调用名（否定性断言用）。 */
  readonly calls: string[];
  setObjective(goalId: string, objective: string, at: number): void;
}

export function createFakeGoals(
  initial: readonly (DriftGoalView & { pinned?: string[] })[] = [],
): FakeGoalState {
  const goals = new Map(initial.map((goal) => [goal.id, goal]));
  const edits: { goalId: string; at: number }[] = [];
  const calibrations: DriftCalibrationRow[] = [];
  const calls: string[] = [];
  const constraints = new Map(initial.map((goal) => [goal.id, goal.pinned ?? []]));
  return {
    goals,
    edits,
    calibrations,
    calls,
    setObjective(goalId, _objective, at) {
      // 测试里直接改数据并记一条 objective_edit（模拟 T0.1 的 edit 路径）
      edits.push({ goalId, at });
    },
    seam: {
      focusView() {
        calls.push('focusView');
        return [...goals.values()][0];
      },
      get(id) {
        calls.push('get');
        return goals.get(id);
      },
      objectiveEdits() {
        calls.push('objectiveEdits');
        return [...edits];
      },
      constraints(id) {
        calls.push('constraints');
        return constraints.get(id) ?? [];
      },
      async recordCalibration(_actor, goalId, entry) {
        calls.push('recordCalibration');
        // 时间源与被测服务对齐（entry.at 由服务时钟传入）——夹具用真实时钟会在
        // 固定时钟用例（NOW=2026-09-25）被真实日期越过时变成时间炸弹
        calibrations.push({ goalId, ...entry, at: entry.at ?? Date.now() });
      },
      calibrations() {
        calls.push('calibrations');
        return [...calibrations];
      },
    },
  };
}

export function createFakeTasks(tasks: readonly DriftTaskView[] = []): DriftTaskSeam & { readonly rows: DriftTaskView[] } {
  const rows = [...tasks];
  return {
    rows,
    list() {
      return [...rows];
    },
  };
}

export function createFakeTransitions(
  rows: readonly { at: number; token: string }[] = [],
): DriftPredictorSeam & { readonly rows: { at: number; token: string }[] } {
  const list = [...rows];
  return {
    rows: list,
    transitions() {
      return [...list];
    },
  };
}

export interface DriftFixture {
  readonly service: DriftService;
  readonly domain: TdaDomain<DriftTables>;
  readonly goals: FakeGoalState;
  readonly tasks: ReturnType<typeof createFakeTasks>;
  readonly transitions: ReturnType<typeof createFakeTransitions>;
  readonly backend: TdaStorageBackend;
  readonly dir: string;
  dispose(): Promise<void>;
}

export interface SetupOptions {
  readonly goals?: readonly (DriftGoalView & { pinned?: string[] })[];
  readonly tasks?: readonly DriftTaskView[];
  readonly transitions?: readonly { at: number; token: string }[];
  readonly config?: DriftConfig;
  readonly now?: () => number;
  readonly session?: TdaSessionSink;
  readonly dir?: string;
}

async function open(options: SetupOptions): Promise<DriftFixture> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'tda-drift-')));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(driftDomainSpec, { backend });
  const goals = createFakeGoals(options.goals ?? [
    { id: 'goal-1', objective: '整理灯环配对协议并归档', phase: 'active', stage: 'executing', pinned: ['C6-1'] },
  ]);
  const tasks = createFakeTasks(options.tasks ?? []);
  const transitions = createFakeTransitions(options.transitions ?? []);
  const service = createDriftService({
    domain,
    session: options.session ?? ({
      sessionId: 'sess-drift' as never,
      append: () => 1,
      flush: () => undefined,
    } as never),
    goal: goals.seam,
    task: tasks,
    predictor: transitions,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  await service.initialize();
  return {
    service,
    domain,
    goals,
    tasks,
    transitions,
    backend,
    dir,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

export const setup = (options: SetupOptions = {}): Promise<DriftFixture> => open(options);

export const DAY = 86_400_000;
export const NOW = 1_790_000_000_000;
