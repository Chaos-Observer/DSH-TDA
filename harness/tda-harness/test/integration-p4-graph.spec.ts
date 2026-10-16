/**
 * P4 集成门（IT14b）：tda-graph 真装配（25 插件 + 图谱读模型）后的闭环语义。
 *
 * 与 tda-graph 插件门的分工：插件门用假体单飞验证规格符合性；本文件验证
 * **装配后**才暴露的语义——
 *  1. boot 全量重建：goal/task 真权威域 → 投影 fresh（graph 默认装配，无 opt-in）；
 *  2. 权威域变更 → tick reconcile → 投影跟上（fresh 承诺）；
 *  3. 六查询面在真装配下的最小闭环（subtree/blockedChain/export）。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleRuntime, type TdaRuntime } from '../src/runtime.ts';

function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface Rig {
  readonly runtime: TdaRuntime;
  dispose(): Promise<void>;
}

async function setup(options: {
  storageBackend?: 'json' | 'sqlite';
  sessionBackend?: 'file' | 'dsh-compat';
} = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-harness-p4g-'));
  const clock = createClock();
  const runtime = await assembleRuntime({
    dir,
    now: clock.now,
    ...(options.storageBackend !== undefined ? { storageBackend: options.storageBackend } : {}),
    ...(options.sessionBackend !== undefined ? { sessionBackend: options.sessionBackend } : {}),
  });
  return {
    runtime,
    async dispose() {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，detached 子进程清理（不占 libuv 线程池）
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    },
  };
}

describe('P4 集成：任务图谱聚合读模型（T4.3）', () => {
  it('boot 重建 fresh；权威域变更 → tick reconcile → 投影跟上', async () => {
    const rig = await setup();
    try {
      const graph = rig.runtime.graph;
      expect(graph).toBeDefined();
      // boot 后空权威域投影为空但 fresh
      expect(graph?.service.stats().state).toBe('fresh');

      // 权威域：建目标 + 任务（真 T0.1/T0.2）
      const goal = await rig.runtime.goalTree.service.create('human', {
        objective: '整理灯环协议依赖',
        completionCriteria: ['依赖清单产出'],
      });
      const task = await rig.runtime.taskPool.service.create('human', {
        goalId: goal.id,
        subject: '整理依赖清单',
      });
      // tick reconcile（bus 快速路径可能已先行；tick 是兜底主路径）
      await rig.runtime.tick();
      expect(graph?.service.stats().state).toBe('fresh');

      const view = graph?.service.subtree(String(goal.id));
      expect(view?.goals.map((item) => item.id)).toContain(String(goal.id));
      expect(view?.tasks.map((item) => item.id)).toContain(String(task.id));
      expect(view?.tasks[0]?.label).toBe('整理依赖清单');
      expect(view?.tasks[0]?.rootGoalId).toBe(String(goal.id));
      expect(graph?.service.stats().nodes).toBeGreaterThanOrEqual(2);

      // 权威域再变更（任务加阻塞依赖）→ reconcile → blockedChain 跟上
      const task2 = await rig.runtime.taskPool.service.create('human', {
        goalId: goal.id,
        subject: '校验依赖清单',
        blockedBy: [task.id],
      });
      await rig.runtime.tick();
      const chain = graph?.service.blockedChain(String(task2.id));
      expect(chain).toContain(String(task.id));

      // 装配级两级不变量（含内核双写对账 + graph 插件级检查）全过
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('P5.4 Gate G4 复验：图谱读模型落在 DSH 兼容介质上（sqlite 域 + dsh-compat 日志）', async () => {
    const rig = await setup({ storageBackend: 'sqlite', sessionBackend: 'dsh-compat' });
    try {
      const goal = await rig.runtime.goalTree.service.create('human', {
        objective: '整理灯环协议依赖',
        completionCriteria: ['依赖清单产出'],
      });
      const task = await rig.runtime.taskPool.service.create('human', {
        goalId: goal.id,
        subject: '整理依赖清单',
      });
      await rig.runtime.tick();
      const view = rig.runtime.graph?.service.subtree(String(goal.id));
      expect(view?.tasks.map((item) => item.id)).toContain(String(task.id));
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('六查询面最小闭环：taskGraph/fileGraph/export 在真装配可用', async () => {
    const rig = await setup();
    try {
      const goal = await rig.runtime.goalTree.service.create('human', {
        objective: '灯环抓取目标',
        completionCriteria: ['标准甲'],
      });
      const task = await rig.runtime.taskPool.service.create('human', {
        goalId: goal.id,
        subject: '直连抓取',
        localPath: 'ws/ring', // localPath 锚定（T0.6 文件邻域桥接点）
      });
      await rig.runtime.tick();
      const graph = rig.runtime.graph;
      expect(graph).toBeDefined();

      // taskGraph：单任务一元视图（文件邻域可能为空——未扫描，桥接不致命）
      const one = graph?.service.taskGraph(String(task.id));
      expect(one?.task.id).toBe(String(task.id));
      expect(one?.blockedBy).toEqual([]);
      // fileGraph 桥接（J6 零复制）：未扫描 ⇒ 空邻域（不致命）
      const files = graph?.service.fileGraph(String(task.id));
      expect(files?.nodes).toEqual([]);

      // export：json/dot 双格式
      const json = JSON.parse(graph?.service.export('json') ?? '{}') as { nodes: unknown[] };
      expect(Array.isArray(json.nodes)).toBe(true);
      expect((json.nodes as unknown[]).length).toBeGreaterThanOrEqual(2);
      const dot = graph?.service.export('dot') ?? '';
      expect(dot).toContain('digraph taskgraph');
      expect(dot).toContain(String(task.id));

      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });
});
