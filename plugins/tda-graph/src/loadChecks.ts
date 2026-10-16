/**
 * tda-graph 插件级不变量：以插件自己的 npm 包名注册（`tda-graph`）。
 *
 * T4.3 §4.1 八条不变量 → 结构性/加载期/服务期/冒烟门分层映射：
 *  1. 零写权          → **结构性**（deps seam 类型只含 tree/get/list/graph 只读方法）
 *                      + 加载期 `graph-zero-write-surface`（复核装配没塞写面）；
 *  2. 可重建          → 服务期 rebuild + 冒烟门（删光重建零差异对账）；
 *  3. 无环复核        → 服务期 rebuildInternal（fail-loud）+ detectCycle 纯函数单测；
 *  4. advisory 豁免   → detectCycle/blockedChain 纯函数（alternativeOf 不入链）；
 *  5. 引用完备        → 加载期 `graph-edge-referential-integrity`（悬空端 ⇒ 红）；
 *  6. 容量帽          → 服务期 buildProjection（truncated+unfinished 显式）；
 *  7. 标签隔离        → 加载期 `graph-label-isolation`（label 超长 ⇒ 红）；
 *  8. fresh 承诺      → 冒烟门（随机变更后 reconcile 再查逐字段一致）。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  GRAPH_PARAMS_KEY,
  type GraphTables,
} from './domain.ts';
import type { TaskGraphService } from './service.ts';

export interface GraphInvariantOptions {
  readonly service?: TaskGraphService | undefined;
}

export function graphInvariantChecks(
  domain: TdaDomain<GraphTables>,
  options: GraphInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];

  checks.push({
    name: 'graph-params-singleton',
    run(fail) {
      const table = domain.table('graph_params');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`graph_params 必须恰有一行（收到 ${keys.length}）`);
      if (keys[0] !== GRAPH_PARAMS_KEY) {
        fail(`graph_params 行键必须是 ${GRAPH_PARAMS_KEY}，实为 ${String(keys[0])}`);
      }
    },
  });

  checks.push({
    name: 'graph-edge-referential-integrity',
    run(fail) {
      // 不变量 5：每条 edge 两端必在 nodes（悬空端 = rebuild 缺陷，禁静默丢边）
      const nodes = domain.table('graph_nodes');
      const edges = domain.table('graph_edges');
      for (const [key, edge] of edges.entries()) {
        for (const [end, target] of [['from', edge.from], ['to', edge.to]] as const) {
          if (nodes.get(target) === undefined) {
            fail(`边 ${key} 的 ${end} 端 ${target} 不在节点集（悬空引用）`);
          }
        }
      }
    },
  });

  checks.push({
    name: 'graph-label-isolation',
    run(fail) {
      // 不变量 7：label ≤ maxLabelChars（读 params 帽；派生表超长=投影纪律被破坏）
      const params = domain.table('graph_params').get(GRAPH_PARAMS_KEY);
      const maxChars = params?.maxLabelChars ?? 120;
      const nodes = domain.table('graph_nodes');
      for (const [key, node] of nodes.entries()) {
        if (node.label.length > maxChars) {
          fail(`节点 ${key} 的 label 超 ${maxChars} 字符（标签隔离被破坏，J8）`);
        }
        if (node.kind === 'file' && node.status.includes('credibility')) {
          fail(`文件节点 ${key} 携可信度标注内容（J8：只引 id，展示层回查 T0.6）`);
        }
      }
    },
  });

  checks.push({
    name: 'graph-zero-write-surface',
    run(fail) {
      // 不变量 1（J1 零写权）：服务面携带权威写方法 ⇒ 装配把第四处图权威缝回来了
      const service = options.service as Record<string, unknown> | undefined;
      if (service === undefined) return;
      for (const forbidden of ['create', 'edit', 'claim', 'complete', 'block', 'approve', 'put', 'delete']) {
        if (forbidden in service) {
          fail(`图谱服务面携带越权写方法 ${forbidden}（J1：只读聚合层被破坏）`);
        }
      }
    },
  });

  return checks;
}

export function registerGraphInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<GraphTables>,
  options: GraphInvariantOptions,
): () => void {
  return registry.register('tda-graph', tdaPluginInstaller(graphInvariantChecks(domain, options)));
}
