/**
 * tda-graph 验收门（门3 test:smoke → gate.spec）。
 *
 * 覆盖 T4.3 §6 验收 1–8：贯通树/阻塞链/跨目标依赖/文件桥接/导出/可重建/
 * 零写权/fail-loud。
 */
import { describe, expect, it } from 'vitest';
import { TdaError } from '@tda/kernel';
import { edgeKey } from '../src/domain.ts';
import { makeFile, makeGoal, makeTask, setup } from './helpers.ts';

describe('T4.3 验收 1：贯通树（subtree）', () => {
  it('root → 子目标 → 任务完整层级，status/深度/归属正确', async () => {
    const rig = await setup({
      goals: [
        makeGoal(),
        makeGoal({ id: 'goal-2', parentId: 'goal-1', objective: '子目标' }),
      ],
      tasks: [
        makeTask(),
        makeTask({ id: 'task-2', goalId: 'goal-2', subject: '子目标任务' }),
      ],
    });
    try {
      const view = rig.service.subtree('goal-1');
      expect(view.rootGoalId).toBe('goal-1');
      expect(view.goals.map((goal) => goal.id)).toEqual(['goal-1', 'goal-2']);
      // 深度：root=0、子目标=1、任务=归属目标深度+1
      expect(view.goals.find((goal) => goal.id === 'goal-1')?.depth).toBe(0);
      expect(view.goals.find((goal) => goal.id === 'goal-2')?.depth).toBe(1);
      expect(view.tasks.map((task) => task.id).sort()).toEqual(['task-1', 'task-2']);
      expect(view.tasks.find((task) => task.id === 'task-2')?.rootGoalId).toBe('goal-1');
      expect(view.truncated).toBe(false);
      // 无 root ⇒ 全图（自动选根）
      const all = rig.service.subtree();
      expect(all.goals.map((goal) => goal.id)).toContain('goal-1');
    } finally {
      await rig.dispose();
    }
  });

  it('fresh 承诺：权威域变更后 reconcile 再查，投影逐字段一致', async () => {
    const rig = await setup({ goals: [makeGoal()], tasks: [makeTask()] });
    try {
      expect(rig.service.subtree('goal-1').tasks).toHaveLength(1);
      // 权威域新增任务 → reconcile → 投影跟上
      rig.taskPool.seed(makeTask({ id: 'task-2', subject: '新任务' }));
      await rig.service.reconcile();
      const view = rig.service.subtree('goal-1');
      expect(view.tasks).toHaveLength(2);
      const projected = view.tasks.find((task) => task.id === 'task-2');
      const live = rig.taskPool.get('task-2');
      expect(projected?.label).toBe(live?.subject);
      expect(projected?.status).toBe(`${live?.phase}/${live?.zone}`);
      expect(rig.service.stats().state).toBe('fresh');
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.3 验收 2–3：阻塞链与跨目标依赖', () => {
  it('blockedChain 传递闭包正确（跨层）；alternativeOf 不入链', async () => {
    const rig = await setup({
      goals: [makeGoal()],
      tasks: [
        makeTask({ id: 'task-1', blockedBy: ['task-2'] }),
        makeTask({ id: 'task-2', blockedBy: ['task-3'] }),
        makeTask({ id: 'task-3' }),
        // advisory 边：task-4 的备选是 task-1——不得出现在 task-4 的阻塞链
        makeTask({ id: 'task-4', blockedBy: ['task-1'], alternativeOf: { taskId: 'task-1' } }),
      ],
    });
    try {
      expect([...rig.service.blockedChain('task-1')].sort()).toEqual(['task-2', 'task-3']);
      // task-4 → task-1 → task-2 → task-3；alternativeOf 边（task-4→task-1 已有 blockedBy；
      // 再造一条纯 advisory 的：task-3 的备选是 task-4）
      rig.taskPool.seed(makeTask({ id: 'task-3', blockedBy: [], alternativeOf: { taskId: 'task-4' } }));
      await rig.service.reconcile();
      // task-3 的阻塞链为空（它对 task-4 只是 advisory 备选关系）
      expect(rig.service.blockedChain('task-3')).toEqual([]);
      // taskGraph.alternatives 列出 advisory 边
      const graph = rig.service.taskGraph('task-3');
      expect(graph.alternatives).toEqual(['task-4']);
    } finally {
      await rig.dispose();
    }
  });

  it('crossGoalDependencies 找出全部跨目标 blockedBy 边', async () => {
    const rig = await setup({
      goals: [makeGoal(), makeGoal({ id: 'goal-2', objective: '另一目标' })],
      tasks: [
        makeTask({ id: 'task-1', goalId: 'goal-1' }),
        makeTask({ id: 'task-2', goalId: 'goal-2', blockedBy: ['task-1'] }),
        makeTask({ id: 'task-3', goalId: 'goal-2', blockedBy: ['task-2'] }),
      ],
    });
    try {
      const cross = rig.service.crossGoalDependencies();
      expect(cross).toHaveLength(1);
      expect(cross[0]).toEqual({ from: 'task-2', to: 'task-1', fromGoalId: 'goal-2', toGoalId: 'goal-1' });
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.3 验收 4：文件桥接（fileGraph，J6 零复制）', () => {
  it('fileGraph 与 workspace.graph 一致；taskGraph 内嵌文件邻域', async () => {
    const rig = await setup({
      goals: [makeGoal()],
      tasks: [makeTask({ localPath: 'ws/a' })],
    });
    try {
      rig.workspace.setNeighborhood(
        'task-1',
        [makeFile('ws/a/x.ts'), makeFile('ws/a/y.ts', { ignored: true }), makeFile('ws/a/z.ts')],
        [
          { from: 'ws/a/x.ts', to: 'ws/a/y.ts', kind: 'depends-on' },
          { from: 'ws/a/y.ts', to: 'ws/a/z.ts', kind: 'supersedes-file' },
        ],
      );
      await rig.service.reconcile();
      const files = rig.service.fileGraph('task-1');
      expect([...files.nodes.map((file) => file.id)].sort()).toEqual([
        'file:ws/a/x.ts',
        'file:ws/a/y.ts',
        'file:ws/a/z.ts',
      ]);
      expect([...files.edges.map((edge) => edge.kind)].sort()).toEqual(['dependsOn', 'supersedesFile']);
      // 与权威面一致（零复制对账）
      const authoritative = rig.workspace.graph('task-1');
      expect([...files.nodes.map((file) => file.path)].sort()).toEqual(
        [...authoritative.nodes.map((file) => file.path)].sort(),
      );
      // taskGraph 内嵌
      const graph = rig.service.taskGraph('task-1');
      expect(graph.files.nodes).toHaveLength(3);
      expect(graph.blockedBy).toEqual([]);
      expect(graph.children).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.3 验收 5：导出（json 无损 / dot 可渲染）', () => {
  it('json 无损 + dot 含节点与 advisory 虚线（不截断配置）', async () => {
    const rig = await setup({
      goals: [makeGoal()],
      tasks: [makeTask(), makeTask({ id: 'task-2', blockedBy: ['task-1'], alternativeOf: { taskId: 'task-1' } })],
    });
    try {
      const json = JSON.parse(rig.service.export('json')) as {
        nodes: { id: string }[];
        edges: { kind: string }[];
        truncated: boolean;
      };
      expect(json.nodes).toHaveLength(3);
      expect(json.truncated).toBe(false);
      expect(json.edges.some((edge) => edge.kind === 'alternativeOf')).toBe(true);

      const dot = rig.service.export('dot');
      expect(dot).toContain('digraph taskgraph');
      expect(dot).toContain('shape=ellipse'); // goal
      expect(dot).toContain('shape=box'); // task
      expect(dot).toContain('style=dashed'); // advisory
      expect(dot).not.toContain('截断视图');
    } finally {
      await rig.dispose();
    }
  });

  it('truncated 时 dot 附截断注释头（J7 显式）', async () => {
    const rig = await setup({
      goals: [makeGoal()],
      tasks: [makeTask(), makeTask({ id: 'task-2' })],
      config: { maxNodes: 2 }, // 1 goal + 2 task > 2 ⇒ 截断
    });
    try {
      expect(rig.service.stats().truncated).toBe(true);
      const json = JSON.parse(rig.service.export('json')) as { truncated: boolean };
      expect(json.truncated).toBe(true);
      const dot = rig.service.export('dot');
      expect(dot).toContain('截断视图');
    } finally {
      await rig.dispose();
    }
  });
});

describe('T4.3 验收 6–8：可重建 / fail-loud', () => {
  it('删光派生表 → rebuild → 逐节点逐边零差异', async () => {
    const rig = await setup({
      goals: [makeGoal(), makeGoal({ id: 'goal-2', parentId: 'goal-1' })],
      tasks: [makeTask({ localPath: 'ws/a' })],
    });
    try {
      rig.workspace.setNeighborhood('task-1', [makeFile('ws/a/x.ts')], []);
      await rig.service.reconcile(); // 快照前先同步（含文件节点）
      const before = {
        nodes: new Map(rig.domain.table('graph_nodes').entries()),
        edges: new Map(rig.domain.table('graph_edges').entries()),
      };
      // 删光
      for (const key of [...rig.domain.table('graph_nodes').keys()]) {
        await rig.domain.table('graph_nodes').delete(key);
      }
      for (const key of [...rig.domain.table('graph_edges').keys()]) {
        await rig.domain.table('graph_edges').delete(key);
      }
      expect(rig.domain.table('graph_nodes').size()).toBe(0);
      // 重建
      await rig.service.rebuild();
      const after = {
        nodes: new Map(rig.domain.table('graph_nodes').entries()),
        edges: new Map(rig.domain.table('graph_edges').entries()),
      };
      expect(after.nodes.size).toBe(before.nodes.size);
      expect(after.edges.size).toBe(before.edges.size);
      for (const [key, node] of before.nodes) {
        expect(after.nodes.get(key)).toEqual(node);
      }
      for (const [key, edge] of before.edges) {
        expect(after.edges.get(key)).toEqual(edge);
      }
    } finally {
      await rig.dispose();
    }
  });

  it('向权威域注入环 → rebuild 落 failed、查询抛 GRAPH_UNHEALTHY（fail-loud）', async () => {
    const rig = await setup({
      goals: [makeGoal()],
      tasks: [
        makeTask({ id: 'task-1', blockedBy: ['task-2'] }),
        makeTask({ id: 'task-2', blockedBy: ['task-1'] }), // 环
      ],
      skipInitialize: true,
    });
    try {
      await expect(rig.service.initialize()).rejects.toThrowError(/成环/);
      expect(rig.service.stats().state).toBe('failed');
      expect(rig.service.stats().nodes).toBe(0); // 禁半成品投影
      expect(() => rig.service.subtree()).toThrowError(TdaError);
      expect(() => rig.service.subtree()).toThrowError(/GRAPH_UNHEALTHY|不健康/);
      expect(() => rig.service.export('json')).toThrowError(/不健康/);
      // 权威域修复 → reconcile 恢复 fresh
      rig.taskPool.seed(makeTask({ id: 'task-2', blockedBy: [] }));
      await rig.service.rebuild();
      expect(rig.service.stats().state).toBe('fresh');
      expect(rig.service.subtree().tasks).toHaveLength(2);
    } finally {
      await rig.dispose();
    }
  });

  it('edgeKey 复合键与幂等重建（同权威域两次重建零漂移）', async () => {
    const rig = await setup({ goals: [makeGoal()], tasks: [makeTask({ blockedBy: [] })] });
    try {
      const first = new Map(rig.domain.table('graph_edges').entries());
      await rig.service.rebuild();
      const second = new Map(rig.domain.table('graph_edges').entries());
      expect(second.size).toBe(first.size);
      for (const [key, edge] of first) {
        expect(second.get(key)).toEqual(edge);
        expect(key).toBe(edgeKey(edge));
      }
    } finally {
      await rig.dispose();
    }
  });
});
