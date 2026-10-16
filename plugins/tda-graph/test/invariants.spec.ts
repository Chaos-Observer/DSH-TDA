/**
 * tda-graph 门 1：不变量（纯函数逐分支 + 加载期检查）。
 *
 * 覆盖 T4.3 §4.1：投影构建（三源归一/容量帽/标签隔离/tombstone 出图）/
 * 无环复核（advisory 豁免）/加载期四查（params 单行/边引用完备/标签隔离/零写面）。
 */
import { describe, expect, it } from 'vitest';
import {
  createTdaInvariantRegistry,
} from '@tda/kernel';
import { registerGraphInvariants } from '../src/loadChecks.ts';
import { buildProjection, detectCycle } from '../src/service.ts';
import type { GraphEdge, GraphNode, GraphParams } from '../src/domain.ts';
import { makeFile, makeGoal, makeTask, NOW, setup } from './helpers.ts';

const PARAMS: Pick<GraphParams, 'maxNodes' | 'maxEdges' | 'maxLabelChars'> = {
  maxNodes: 10_000,
  maxEdges: 50_000,
  maxLabelChars: 120,
};

const node = (id: string, overrides: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: id.startsWith('goal') ? 'goal' : id.startsWith('task') ? 'task' : 'file',
  ref: id,
  label: id,
  status: 'active',
  depth: 0,
  ...overrides,
});

const edge = (from: string, to: string, kind: GraphEdge['kind'], advisory = false): GraphEdge => ({
  from,
  to,
  kind,
  advisory,
});

describe('T4.3 投影构建（buildProjection 纯函数）', () => {
  it('三源归一：goal/task/file 节点与三类边全落谱', () => {
    const projection = buildProjection({
      goals: [makeGoal(), makeGoal({ id: 'goal-2', parentId: 'goal-1', objective: '子目标' })],
      tasks: [
        makeTask({ localPath: 'ws/a' }),
        makeTask({ id: 'task-2', blockedBy: ['task-1'] }),
      ],
      fileGraphOf: (taskId) =>
        taskId === 'task-1'
          ? {
              nodes: [makeFile('ws/a/x.ts'), makeFile('ws/a/y.ts', { ignored: true })],
              edges: [{ from: 'ws/a/x.ts', to: 'ws/a/y.ts', kind: 'depends-on' }],
            }
          : { nodes: [], edges: [] },
      params: PARAMS,
    });
    // 节点：2 goal + 2 task + 2 file
    expect(projection.nodes.size).toBe(6);
    expect(projection.nodes.get('goal-2')?.kind).toBe('goal');
    expect(projection.nodes.get('task-2')?.rootGoalId).toBe('goal-1');
    expect(projection.nodes.get('file:ws/a/x.ts')?.kind).toBe('file');
    // 边：goal parent + task parent（无）+ blockedBy + dependsOn
    expect(projection.edges.get('goal-1#parent#goal-2')).toBeDefined();
    expect(projection.edges.get('task-2#blockedBy#task-1')).toBeDefined();
    expect(projection.edges.get('file:ws/a/x.ts#dependsOn#file:ws/a/y.ts')).toBeDefined();
    expect(projection.truncated).toBe(false);
    expect(projection.unfinished).toEqual([]);
  });

  it('alternativeOf 边标 advisory；tombstone（clearedAt/deletedAt）出图', () => {
    const projection = buildProjection({
      goals: [makeGoal(), makeGoal({ id: 'goal-9', clearedAt: NOW - 1000 })],
      tasks: [
        makeTask({ alternativeOf: { taskId: 'task-2' } }),
        makeTask({ id: 'task-2' }),
        makeTask({ id: 'task-9', deletedAt: NOW - 500 }),
      ],
      fileGraphOf: () => ({ nodes: [], edges: [] }),
      params: PARAMS,
    });
    expect(projection.edges.get('task-1#alternativeOf#task-2')?.advisory).toBe(true);
    expect(projection.nodes.has('goal-9')).toBe(false);
    expect(projection.nodes.has('task-9')).toBe(false);
  });

  it('标签截断（J8）：超长 objective/subject 截到 maxLabelChars', () => {
    const projection = buildProjection({
      goals: [makeGoal({ objective: '长'.repeat(200) })],
      tasks: [],
      fileGraphOf: () => ({ nodes: [], edges: [] }),
      params: { maxNodes: 100, maxEdges: 100, maxLabelChars: 120 },
    });
    expect(projection.nodes.get('goal-1')?.label.length).toBeLessThanOrEqual(120);
    expect(projection.nodes.get('goal-1')?.label.endsWith('…')).toBe(true);
  });

  it('容量帽：超 maxNodes ⇒ truncated + unfinished 显式说明', () => {
    const tasks = Array.from({ length: 5 }, (_, index) => makeTask({ id: `task-${index + 1}` }));
    const projection = buildProjection({
      goals: [makeGoal()],
      tasks,
      fileGraphOf: () => ({ nodes: [], edges: [] }),
      params: { maxNodes: 3, maxEdges: 100, maxLabelChars: 120 },
    });
    expect(projection.truncated).toBe(true);
    expect(projection.unfinished.length).toBeGreaterThan(0);
    expect(projection.nodes.size).toBeLessThanOrEqual(3);
  });
});

describe('T4.3 无环复核（detectCycle 纯函数）', () => {
  const nodes = new Map(
    [node('a'), node('b'), node('c'), node('d')].map((item) => [item.id, item] as const),
  );

  it('无环图返回 null', () => {
    const edges = new Map(
      [edge('a', 'b', 'parent'), edge('b', 'c', 'blockedBy'), edge('c', 'd', 'dependsOn')].map((item) => [
        `${item.from}#${item.kind}#${item.to}`,
        item,
      ] as const),
    );
    expect(detectCycle(nodes, edges)).toBeNull();
  });

  it('成环图返回环路径', () => {
    const edges = new Map(
      [edge('a', 'b', 'parent'), edge('b', 'c', 'blockedBy'), edge('c', 'a', 'dependsOn')].map((item) => [
        `${item.from}#${item.kind}#${item.to}`,
        item,
      ] as const),
    );
    const cycle = detectCycle(nodes, edges);
    expect(cycle).not.toBeNull();
    expect(cycle?.length).toBeGreaterThan(2);
  });

  it('advisory 边（alternativeOf）豁免环检测', () => {
    const edges = new Map(
      [edge('a', 'b', 'parent'), edge('b', 'a', 'alternativeOf', true)].map((item) => [
        `${item.from}#${item.kind}#${item.to}`,
        item,
      ] as const),
    );
    expect(detectCycle(nodes, edges)).toBeNull();
  });
});

// ── 加载期检查 ─────────────────────────────────────────────────────────

describe('T4.3 加载期检查', () => {
  it('正常域 verify 通过', async () => {
    const rig = await setup();
    try {
      const registry = createTdaInvariantRegistry();
      registerGraphInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-graph')).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });

  it('边悬空端 ⇒ verify 红（引用完备）', async () => {
    const rig = await setup();
    try {
      await rig.domain.table('graph_nodes').put('task-1', node('task-1'));
      await rig.domain.table('graph_edges').put('task-1#blockedBy#ghost', {
        from: 'task-1',
        to: 'ghost',
        kind: 'blockedBy',
        advisory: false,
      });
      const registry = createTdaInvariantRegistry();
      registerGraphInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-graph')).rejects.toThrowError(/悬空引用/);
    } finally {
      await rig.dispose();
    }
  });

  it('label 超长 ⇒ verify 红（标签隔离）', async () => {
    const rig = await setup();
    try {
      await rig.domain.table('graph_nodes').put('goal-1', {
        ...node('goal-1'),
        label: '长'.repeat(200),
      });
      const registry = createTdaInvariantRegistry();
      registerGraphInvariants(registry, rig.domain, { service: rig.service });
      await expect(registry.verify('tda-graph')).rejects.toThrowError(/标签隔离/);
    } finally {
      await rig.dispose();
    }
  });

  it('服务面携带越权写方法 ⇒ verify 红（J1 零写权）', async () => {
    const rig = await setup();
    try {
      const rogue = { ...rig.service, create: () => undefined };
      const registry = createTdaInvariantRegistry();
      registerGraphInvariants(registry, rig.domain, { service: rogue as never });
      await expect(registry.verify('tda-graph')).rejects.toThrowError(/越权写方法/);
      const ok = createTdaInvariantRegistry();
      registerGraphInvariants(ok, rig.domain, { service: rig.service });
      await expect(ok.verify('tda-graph')).resolves.toBeUndefined();
    } finally {
      await rig.dispose();
    }
  });
});

