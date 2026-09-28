/**
 * T3.1 · 加载期不变量检查（J11/§4.1）。
 * 检查面用窄接口（只读），便于测试桩复现每条判据。
 */
import { tdaPluginInstaller, type TdaDomain, type TdaInvariantCheck, type TdaInvariantRegistry } from '@tda/kernel';
import type { KnowledgeEdge, KnowledgeEntry, KnowledgeParams, KnowledgeRun, KnowledgeTables } from './domain.ts';

export interface KnowledgeReadFace {
  entries(): readonly KnowledgeEntry[];
  runs(): readonly KnowledgeRun[];
  params(): KnowledgeParams;
  edges(): readonly KnowledgeEdge[];
}

export function knowledgeInvariantChecks(domain: TdaDomain<KnowledgeTables>, face?: KnowledgeReadFace): TdaInvariantCheck[] {
  void domain;
  const checks: TdaInvariantCheck[] = [];

  checks.push({
    name: 'knowledge-entries-graphref-gate',
    run(fail) {
      // 不变量 2（未验证零入图）：graphRef 非空 ⇒ status=consolidated。
      for (const entry of face?.entries() ?? []) {
        if (entry.graphRef !== undefined && entry.status !== 'consolidated') {
          fail(`条目 ${String(entry.entryId)}#v${entry.version} 有 graphRef 却处于 ${entry.status}（未验证零入图被破坏）`);
        }
      }
    },
  });

  checks.push({
    name: 'knowledge-entries-evidence-present',
    run(fail) {
      // 不变量 3/4：非人工条目必须有证据引用（零证据条目不可溯源 = 审计断裂）。
      for (const entry of face?.entries() ?? []) {
        if (entry.evidence.chunkRefs.length === 0 && entry.createdBy !== 'human') {
          fail(`条目 ${String(entry.entryId)} 无证据 chunk 引用（createdBy=${entry.createdBy}）`);
        }
      }
    },
  });

  checks.push({
    name: 'knowledge-runs-wellformed',
    run(fail) {
      // C5 显式终态：failed 必带 stage+reason；recorded 必带 endedAt。
      for (const run of face?.runs() ?? []) {
        if (run.status === 'failed' && (run.stage === undefined || run.failureReason === undefined)) {
          fail(`run ${String(run.runId)} failed 却缺 stage/failureReason（显式终态被破坏）`);
        }
        if (run.status === 'recorded' && run.endedAt === undefined) {
          fail(`run ${String(run.runId)} recorded 却无 endedAt`);
        }
      }
    },
  });

  checks.push({
    name: 'knowledge-params-singleton',
    run(fail) {
      // 参数恰一行（singleton layout），缺行 = initialize 未跑。
      const rows = [...domain.table('knowledge_params').keys()];
      if (rows.length !== 1 || rows[0] !== 'singleton') {
        fail(`knowledge_params 必须恰有一行 singleton（现状 ${rows.length} 行）`);
      }
    },
  });

  checks.push({
    name: 'knowledge-edge-fanin-cap',
    run(fail) {
      // 不变量 6（双帽兜底）：同一 toId 的 part-of 活跃入边数 ≤ fanInCap。
      const params = face?.params();
      if (params === undefined) return;
      // 语义与 service.assertLinkCaps 一致：父数 = child（fromId）的 part-of 出边数。
      const fanIn = new Map<string, number>();
      for (const edge of face?.edges() ?? []) {
        if (edge.removedAt !== undefined || edge.kind !== 'part-of') continue;
        fanIn.set(edge.fromId, (fanIn.get(edge.fromId) ?? 0) + 1);
      }
      for (const [fromId, count] of fanIn) {
        if (count > params.fanInCap) {
          fail(`条目 ${fromId} 的 MOC 父数 ${count} 超 fanInCap=${params.fanInCap}（投影对账出 wiki 迷宫）`);
        }
      }
    },
  });

  return checks;
}

/** 治理入口：注册进内核不变量注册表（加载期即校验，fail-loud）。 */
export function registerKnowledgeInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<KnowledgeTables>,
  face?: KnowledgeReadFace,
): () => void {
  return registry.register('tda-knowledge', tdaPluginInstaller(knowledgeInvariantChecks(domain, face)));
}
