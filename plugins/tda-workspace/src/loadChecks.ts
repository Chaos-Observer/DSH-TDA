/**
 * tda-workspace 插件级不变量：以插件自己的 npm 包名注册。
 *
 * T0.6 §4.1 八条不变量 → 检查/运行时/结构分层映射：
 *  1. 路径安全       → schema（路径规范律）+ 加载期 workspace-path-safety
 *                      （含可选"必须落在任务 localPath 前缀内"）；realpath 逃逸在服务期判；
 *  2. 内容隔离       → **结构性**（域内四表无任何正文字段；正文只进 annotator seam）
 *                      + 冒烟门以"grep 不到文件正文片段"自证；
 *  3. 凭证分层       → 服务期强制（inventory=execution-verified / notes=model-produced）
 *                      + schema（recorded 必带 inventoryEntryId）+ 集成门断言；
 *  4. 增量正确       → 服务期（changedPaths 三级比对）+ 加载期 workspace-cache-consistency
 *                      （cache 与图谱不得漂移）；
 *  5. 上限强制       → schema（truncated ⟹ unfinished；failed ⟹ unfinished）+ 服务期置终态；
 *  6. 引用完整       → 加载期 workspace-edge-ref-integrity + workspace-supersedes-acyclic；
 *  7. 扫描串行       → 运行时（进程内 per-task 队列）；
 *  8. 图谱可重建     → **结构性**（file_nodes/edges 全派生，重扫即刷新）
 *                      + 加载期 workspace-scan-link（节点所引 lastScanId 必存在）。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import { edgeKey, isSafeRelativePath, nodeKey, type WorkspaceTables } from './domain.ts';

export interface WorkspaceInvariantOptions {
  /** 任务 localPath（提供即强制"节点路径必须落在其前缀内"，不变量 1 的强形式）。 */
  readonly taskLocalPath?: (taskId: string) => string | undefined;
}

export function workspaceInvariantChecks(
  domain: TdaDomain<WorkspaceTables>,
  options: WorkspaceInvariantOptions = {},
): TdaInvariantCheck[] {
  return [
    {
      name: 'workspace-path-safety',
      run(fail) {
        const nodes = domain.table('ws_file_nodes');
        const edges = domain.table('ws_graph_edges');
        const prefixOf = (taskId: string): string | undefined => options.taskLocalPath?.(taskId);
        for (const [key, node] of nodes.entries()) {
          if (!isSafeRelativePath(node.path)) {
            fail(`节点 ${key} 路径不安全：${node.path}`);
            continue;
          }
          const root = prefixOf(node.taskId);
          if (root !== undefined && node.path !== root && !node.path.startsWith(`${root}/`)) {
            fail(`节点 ${key} 逃离任务 ${node.taskId} 的 localPath "${root}"：${node.path}`);
          }
        }
        for (const [key, edge] of edges.entries()) {
          for (const [field, value] of [
            ['from', edge.from],
            ['to', edge.to],
          ] as const) {
            if (!isSafeRelativePath(value)) fail(`边 ${key} 的 ${field} 路径不安全：${value}`);
          }
        }
      },
    },
    {
      name: 'workspace-edge-ref-integrity',
      run(fail) {
        const nodes = domain.table('ws_file_nodes');
        const edges = domain.table('ws_graph_edges');
        for (const [key, edge] of edges.entries()) {
          for (const [field, value] of [
            ['from', edge.from],
            ['to', edge.to],
          ] as const) {
            if (nodes.get(nodeKey(edge.taskId, value)) === undefined) {
              fail(`边 ${key} 的 ${field} 指向不存在的文件节点 ${value}（引用完整：to 必存在节点）`);
            }
          }
        }
      },
    },
    {
      name: 'workspace-supersedes-acyclic',
      run(fail) {
        const edges = domain.table('ws_graph_edges');
        const next = new Map<string, string[]>();
        for (const [, edge] of edges.entries()) {
          if (edge.kind !== 'supersedes-file') continue;
          const key = nodeKey(edge.taskId, edge.from);
          const list = next.get(key) ?? [];
          list.push(nodeKey(edge.taskId, edge.to));
          next.set(key, list);
        }
        const done = new Set<string>();
        const visiting = new Set<string>();
        const walk = (key: string): void => {
          if (done.has(key)) return;
          if (visiting.has(key)) {
            fail(`supersedes-file 版本链成环（经 ${key} 回环）——版本链必须单向收敛`);
            return;
          }
          visiting.add(key);
          for (const target of next.get(key) ?? []) walk(target);
          visiting.delete(key);
          done.add(key);
        };
        for (const key of next.keys()) walk(key);
      },
    },
    {
      name: 'workspace-scan-link',
      run(fail) {
        const nodes = domain.table('ws_file_nodes');
        const runs = domain.table('ws_scan_runs');
        for (const [key, node] of nodes.entries()) {
          const run = runs.get(node.lastScanId);
          if (run === undefined) {
            fail(`节点 ${key} 的 lastScanId=${node.lastScanId} 不存在（标注来源必须可溯）`);
            continue;
          }
          if (run.taskId !== node.taskId) {
            fail(`节点 ${key} 的 lastScanId 属于任务 ${run.taskId}，与节点任务 ${node.taskId} 不符`);
          }
        }
      },
    },
    {
      name: 'workspace-cache-consistency',
      run(fail) {
        const nodes = domain.table('ws_file_nodes');
        const cache = domain.table('ws_scan_cache');
        for (const [key, row] of cache.entries()) {
          const node = nodes.get(nodeKey(row.taskId, row.path));
          if (node === undefined) {
            fail(`cache 行 ${key} 无对应文件节点（缓存不得先于图谱存在）`);
            continue;
          }
          if (node.size !== row.size || node.mtime !== row.mtime) {
            fail(
              `cache 行 ${key} 与节点漂移（cache ${row.size}/${row.mtime} vs 节点 ${node.size}/${node.mtime}）` +
                '——三级比对依据必须与图谱同源',
            );
          }
          if (node.contentHash !== undefined && row.contentHash !== node.contentHash) {
            fail(`cache 行 ${key} 的 contentHash 与节点不一致`);
          }
        }
      },
    },
    {
      name: 'workspace-edge-key-canonical',
      run(fail) {
        const edges = domain.table('ws_graph_edges');
        for (const [key, edge] of edges.entries()) {
          const expected = edgeKey(edge.taskId, edge.from, edge.to, edge.kind);
          if (key !== expected) {
            fail(`边记录键 ${key} 与内容不符（规范键应为 ${expected}）——键即纪律，不在键上的边会被重扫重复堆积`);
          }
        }
      },
    },
  ];
}

export function registerWorkspaceInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<WorkspaceTables>,
  options: WorkspaceInvariantOptions = {},
): () => void {
  return registry.register('tda-workspace', tdaPluginInstaller(workspaceInvariantChecks(domain, options)));
}
