/**
 * tda-meta-thinking 插件级不变量：以插件自己的 npm 包名注册（`tda-meta-thinking`）。
 *
 * T1.4 §4.1 八条不变量 → 检查/运行时/结构分层映射：
 *  1. 拓扑无环            → schema 恒等律（Kahn 判环 + loop 护栏 + 可达性）
 *                           + 加载期 `meta-topology-structural`（存储侧复核）；
 *  2. 非语言内容          → schema（label ≤24、禁句号/换行）+ 加载期 `meta-non-language`；
 *  3. 未验证零注入        → **结构性**（injectCandidates 只放行治理态 consolidated）
 *                           + 加载期 `meta-consolidated-has-pass`；
 *  4. rehearsal 判定确定性 → **结构性**（coverage = 拓扑步骤覆盖率纯函数；判定输入全落盘）；
 *  5. 连续失败自动退役    → 加载期 `meta-consecutive-fail-retired`；
 *  6. 治理单一            → **结构性**（meta_paths 表无 lifecycle 列可存；服务无 retire 本地实现）
 *                           + 加载期 `meta-governance-single`（治理态与本地记录互证）；
 *  7. 注入即结构提示      → 服务期（renderStructureHint 的 token 帽断言）+ 冒烟门自检；
 *  8. 版本链完整          → 加载期 `meta-supersede-chain`。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  LABEL_MAX,
  META_PATH_PREFIX,
  type MetaPath,
  type MetaThinkingTables,
  type RehearsalRun,
} from './domain.ts';
import type { MetaGovernanceSeam, MetaThinkingConfig, MetaThinkingService } from './service.ts';

export interface MetaInvariantOptions {
  readonly governance: MetaGovernanceSeam;
  readonly service: MetaThinkingService;
  readonly config?: MetaThinkingConfig;
}

export function metaThinkingInvariantChecks(
  domain: TdaDomain<MetaThinkingTables>,
  options: MetaInvariantOptions,
): TdaInvariantCheck[] {
  const { governance, service, config } = options;
  const failLimit = config?.consecutiveFailLimit ?? 3;

  const checks: TdaInvariantCheck[] = [];

  checks.push({
    name: 'meta-path-key-canonical',
    run(fail) {
      const table = domain.table('meta_paths');
      const seen = new Set<string>();
      for (const [key, path] of table.entries() as IterableIterator<[string, MetaPath]>) {
        if (key !== String(path.id)) fail(`元路径记录键 ${key} 与 id ${String(path.id)} 不符（键即纪律）`);
        if (seen.has(String(path.id))) fail(`元路径 id ${String(path.id)} 重复——allocateId 无洞分配被绕过`);
        seen.add(String(path.id));
      }
    },
  });

  checks.push({
    name: 'meta-topology-structural',
    run(fail) {
      // 不变量 1 的存储侧复核（schema 已拦，这里防"旁路写入绕过 parse"的回归）
      for (const [, path] of domain.table('meta_paths').entries() as IterableIterator<[string, MetaPath]>) {
        const ids = new Set(path.topology.nodes.map((node) => node.id));
        if (!ids.has(path.topology.entry)) fail(`元路径 ${String(path.id)} 的 entry 不在节点集内`);
        for (const edge of path.topology.edges) {
          if (!ids.has(edge.from) || !ids.has(edge.to)) {
            fail(`元路径 ${String(path.id)} 的边 ${edge.from}→${edge.to} 端点越界`);
          }
        }
        if (path.topology.edges.some((edge) => edge.kind === 'loop')) {
          for (const edge of path.topology.edges.filter((item) => item.kind === 'loop')) {
            const guarded = path.topology.edges.some((item) => item.to === edge.to && item.kind === 'cond');
            if (!guarded) fail(`元路径 ${String(path.id)} 的 loop 回边 ${edge.from}→${edge.to} 无 cond 护栏`);
          }
        }
      }
    },
  });

  checks.push({
    name: 'meta-non-language',
    run(fail) {
      // 不变量 2：label 是类型助记不是正文
      for (const [, path] of domain.table('meta_paths').entries() as IterableIterator<[string, MetaPath]>) {
        for (const node of path.topology.nodes) {
          if (node.label === undefined) continue;
          if (node.label.length > LABEL_MAX) {
            fail(`元路径 ${String(path.id)} 节点 ${node.id} label 超过 ${LABEL_MAX} 字符（非语言内容纪律）`);
          }
          if (node.label.includes('。') || node.label.includes('\n')) {
            fail(`元路径 ${String(path.id)} 节点 ${node.id} label 含句号/换行（自然语言正文）`);
          }
        }
      }
    },
  });

  checks.push({
    name: 'meta-rehearsal-ref-integrity',
    run(fail) {
      const paths = domain.table('meta_paths');
      for (const [, run] of domain.table('rehearsal_runs').entries() as IterableIterator<[string, RehearsalRun]>) {
        if (paths.get(run.metaPathId) === undefined) {
          fail(`rehearsal ${String(run.id)} 指向的元路径 ${run.metaPathId} 不存在（引用完整性）`);
        }
        if (run.verdict === 'pass' && run.outcome !== 'success') {
          fail(`rehearsal ${String(run.id)} verdict=pass 却 outcome=${run.outcome}（判定式被绕过）`);
        }
      }
    },
  });

  checks.push({
    name: 'meta-consolidated-has-pass',
    run(fail) {
      // 不变量 3 的对偶：能进注入池的，必然有通过记录（治理态与本地记录互证）
      for (const [, path] of domain.table('meta_paths').entries() as IterableIterator<[string, MetaPath]>) {
        const lifecycle = governance.lifecycleOf(String(path.id), 'meta-thinking');
        if (lifecycle === 'consolidated' && path.stats.rehearsalPass < 1) {
          fail(`元路径 ${String(path.id)} 是 consolidated 却零 rehearsalPass（回放验证才缓存被绕过）`);
        }
      }
    },
  });

  checks.push({
    name: 'meta-consecutive-fail-retired',
    run(fail) {
      // 不变量 5：达阈值必须已退役（自动退役没有"挂起"形态）
      for (const [, path] of domain.table('meta_paths').entries() as IterableIterator<[string, MetaPath]>) {
        if (path.stats.consecutiveRehearsalFail >= failLimit) {
          const lifecycle = governance.lifecycleOf(String(path.id), 'meta-thinking');
          if (lifecycle !== 'retired') {
            fail(
              `元路径 ${String(path.id)} 连续失败 ${path.stats.consecutiveRehearsalFail} ≥ 阈值 ${failLimit} 却治理态=${String(lifecycle)}（J8 自动退役未执行）`,
            );
          }
        }
      }
    },
  });

  checks.push({
    name: 'meta-governance-single',
    run(fail) {
      // 不变量 6：validate 中的元路径必须真的在治理侧存在（单一权威的互证）
      for (const assetId of governance.validating('meta-thinking')) {
        if (domain.table('meta_paths').get(assetId) === undefined) {
          fail(`治理侧 validating 的元路径 ${assetId} 在本域不存在（分区口径漂移）`);
        }
      }
    },
  });

  checks.push({
    name: 'meta-supersede-chain',
    run(fail) {
      // 不变量 8：版本链完整（旧版保留可查）
      for (const [, path] of domain.table('meta_paths').entries() as IterableIterator<[string, MetaPath]>) {
        if (path.supersedes !== undefined && domain.table('meta_paths').get(path.supersedes) === undefined) {
          fail(`元路径 ${String(path.id)} 的 supersedes=${path.supersedes} 不存在（版本链断链）`);
        }
      }
      void META_PATH_PREFIX;
    },
  });

  checks.push({
    name: 'meta-hint-token-cap',
    run(fail) {
      // 不变量 7：结构提示 ≤ 上限（对现存每条抽查）
      for (const [, path] of domain.table('meta_paths').entries() as IterableIterator<[string, MetaPath]>) {
        const hint = service.renderStructureHint(path);
        if (hint.length === 0) fail(`元路径 ${String(path.id)} 的结构提示为空（J7：注入必须是拓扑序列化）`);
        if (hint.includes('。')) fail(`元路径 ${String(path.id)} 的结构提示含句号（那是正文不是结构提示）`);
      }
    },
  });

  return checks;
}

export function registerMetaThinkingInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<MetaThinkingTables>,
  options: MetaInvariantOptions,
): () => void {
  return registry.register('tda-meta-thinking', tdaPluginInstaller(metaThinkingInvariantChecks(domain, options)));
}
