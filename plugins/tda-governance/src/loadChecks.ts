/**
 * tda-governance 插件级不变量：以插件自己的 npm 包名注册（`tda-governance`）。
 *
 * T1.2 §4.1 八条不变量 → 检查/运行时/结构分层映射：
 *  1. 治理不动权威        → **结构性**（服务 deps 里没有 goalTree/taskPool/timeline 的
 *                           mutation 面；唯一内容层通道是 supersede/invalidate）
 *                           + 加载期 `gov-no-lifecycle-in-domain`；
 *  2. 固化三条件          → 服务端断言（consolidate） + 加载期 `gov-consolidated-conditions`；
 *  3. 转正即新条目        → 加载期 `gov-promote-new-entry`（promotedFrom ↔ timeline 的 supersedes 链）；
 *  4. 退役可逆、作废终局  → 加载期 `gov-restore-by-human` + `gov-archive-terminal`
 *                           （"archived ⟹ retired"这一条由状态 schema 的恒等律承担——
 *                            它不可能通过 `table.put` 落地，故不另设检查）；
 *  5. 容量淘汰可解释      → 加载期 `gov-capacity-ranking`（capacity ⟹ detail 带 rank= ∧ ranking 非空）；
 *  6. 动作全留痕          → **结构性**（服务唯一写出口 `record()`） + 双写门配对；
 *  7. 吞吐帽              → 服务期（scan 的 caps 判定） + 冒烟门用例；
 *  8. 投影可重建          → 加载期 `gov-states-match-projection`（**与线上写共用同一折叠实现**）。
 */
import {
  canonicalJson,
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import {
  CREDENTIAL_RANK,
  CONSOLIDATE_MIN_CREDENTIAL,
  GOV_SCAN_STATE_KEY,
  govStateKey,
  type GovTables,
} from './domain.ts';
import type { GovTimelineSeam } from './service.ts';
import type { GovAction, GovAssetKind, MemoryGovState } from './domain.ts';

/**
 * 检查所需的**只读面**（窄接口：便于用桩件单测每条检查的判据）。
 *  结构上即满足它。
 */
export interface GovReadFace {
  rebuildStates(assetKind?: GovAssetKind): Map<string, MemoryGovState>;
  actions(assetId?: string): readonly GovAction[];
}

export interface GovInvariantOptions {
  /** 服务实例（投影/状态/动作的权威读取面——与线上写共用折叠实现）。 */
  readonly service: GovReadFace;
  /** 时间线只读 seam（转正链与凭证条件的外部校验；缺省跳过那两条）。 */
  readonly timeline?: GovTimelineSeam;
}

export function governanceInvariantChecks(
  domain: TdaDomain<GovTables>,
  options: GovInvariantOptions,
): TdaInvariantCheck[] {
  const checks: TdaInvariantCheck[] = [];
  const { service, timeline } = options;

  checks.push({
    name: 'gov-scan-state-singleton',
    run(fail) {
      const table = domain.table('gov_scan_state');
      const keys = [...table.keys()];
      if (keys.length !== 1) fail(`gov_scan_state 必须恰有一行（收到 ${keys.length}）——水位是单例`);
      if (keys[0] !== GOV_SCAN_STATE_KEY) {
        fail(`gov_scan_state 行键必须是 ${GOV_SCAN_STATE_KEY}，实为 ${String(keys[0])}`);
      }
    },
  });

  checks.push({
    name: 'gov-actions-id-canonical',
    run(fail) {
      const table = domain.table('gov_actions');
      const seen = new Set<string>();
      for (const [key, action] of table.entries()) {
        const id = String(action.id);
        if (key !== id) fail(`gov_actions 记录键 ${key} 与 id ${id} 不符（键即纪律）`);
        if (seen.has(id)) fail(`gov_actions id ${id} 重复——allocateId 无洞分配被绕过`);
        seen.add(id);
      }
    },
  });

  checks.push({
    name: 'gov-states-match-projection',
    run(fail) {
      // 不变量 8：投影可重建（同 gov_actions + 同 recall_log ⇒ 逐字段一致）
      const rebuilt = service.rebuildStates('memory');
      const stored = domain.table('memory_gov_states');
      const storedKeys = new Set<string>();
      for (const [key, row] of stored.entries()) {
        if (row.assetKind !== 'memory') continue;
        storedKeys.add(key);
        const expected = rebuilt.get(key);
        if (expected === undefined) {
          fail(`${key} 在投影中不存在（域里有日志没有的幽灵状态）`);
          continue;
        }
        // 口径：**键序无关**（canonicalJson）——投影缓存的相等是内容相等；
        // 线上两侧都走同一折叠实现，本比较只用于抓"被旁路改写的状态行"。
        if (canonicalJson(row) !== canonicalJson(expected)) {
          fail(`${key} 与 gov_actions 重放结果不一致（投影漂移：库 ${canonicalJson(row)} ≠ 重放 ${canonicalJson(expected)}）`);
        }
      }
      for (const key of rebuilt.keys()) {
        if (!storedKeys.has(key)) {
          fail(`${key} 有动作日志却无状态行（投影未刷新；修复路径 = rebuildStates → refreshState）`);
        }
      }
    },
  });

  checks.push({
    name: 'gov-capacity-ranking',
    run(fail) {
      // 不变量 5：容量淘汰可解释
      for (const action of service.actions()) {
        if (action.reason?.kind !== 'capacity') continue;
        if (action.ranking === undefined || action.ranking.length === 0) {
          fail(`动作 ${String(action.id)} 是 capacity 治理却无 ranking 快照`);
        }
        if (!action.reason.detail.includes('rank=')) {
          fail(`动作 ${String(action.id)} 的 capacity 明细未含排名（detail=${action.reason.detail}）`);
        }
      }
    },
  });

  checks.push({
    name: 'gov-restore-by-human',
    run(fail) {
      // 不变量 4 前半：恢复只能人工触发
      for (const action of service.actions()) {
        if (action.action === 'retire' && action.reason?.kind === 'capacity') {
          if (action.approvalToken === undefined || action.approvalToken === '') {
            fail(`容量强制淘汰 ${String(action.id)} 未经人类审批（无 token）`);
          }
        }
        if (action.action !== 'restore') continue;
        if (action.actor.actor !== 'human') {
          fail(`恢复动作 ${String(action.id)} 的 actor=${action.actor.actor}（只允许 human）`);
        }
      }
    },
  });

  checks.push({
    name: 'gov-archive-terminal',
    run(fail) {
      // 不变量 4 后半：archived（invalidate）后治理侧不再动作
      const actions = service.actions();
      const archivedAt = new Map<string, number>();
      for (const action of actions) {
        if (action.action === 'propose-invalidate' && action.approvalToken !== undefined) {
          archivedAt.set(action.assetId, action.at);
        }
      }
      for (const action of actions) {
        const at = archivedAt.get(action.assetId);
        if (at === undefined || action.at <= at) continue;
        if (action.action === 'propose-invalidate' && action.approvalToken !== undefined) continue;
        fail(`条目 ${action.assetId} 在作废后仍有治理动作 ${action.action}（archived 是终局）`);
      }
    },
  });

  if (timeline !== undefined) {
    checks.push({
      name: 'gov-promote-new-entry',
      run(fail) {
        // 不变量 3：quarantine 解除必伴随一条 supersedes→原条目的新 chunk
        for (const action of service.actions()) {
          if (action.action !== 'promote' || action.promotedFrom === undefined) continue;
          const created = timeline.get(action.assetId);
          if (created === undefined) {
            fail(`转正动作 ${String(action.id)} 指向的新条目 ${action.assetId} 不在时间线`);
            continue;
          }
          if (created.supersedes !== action.promotedFrom) {
            fail(
              `转正新条目 ${action.assetId} 的 supersedes=${String(created.supersedes)} ≠ 原隔离条目 ${action.promotedFrom}（隔离史断链）`,
            );
          }
          const original = timeline.get(action.promotedFrom);
          if (original === undefined) {
            fail(`原隔离条目 ${action.promotedFrom} 不在时间线（转正不得删除原条目）`);
          } else if (!original.quarantine) {
            fail(`原条目 ${action.promotedFrom} 的 quarantine 被改写（J4：标记附着不可变条目、永不消失）`);
          }
        }
      },
    });

    checks.push({
      name: 'gov-consolidated-conditions',
      run(fail) {
        // 不变量 2：固化三条件（加载期复核，防状态行被旁路注入）
        for (const state of service.rebuildStates('memory').values()) {
          if (state.lifecycle !== 'consolidated') continue;
          if (state.verifiedBy.length < 1) {
            fail(`条目 ${state.assetId} 是 consolidated 却无外部验证证据（J5 条件 ①）`);
          }
          const entry = timeline.get(state.assetId);
          if (entry === undefined) {
            fail(`条目 ${state.assetId} 是 consolidated 却不在时间线（弱引用断链）`);
            continue;
          }
          if (entry.quarantine) fail(`条目 ${state.assetId} 是 consolidated 却仍隔离（J5 条件 ③）`);
          if (CREDENTIAL_RANK[entry.credential] < CREDENTIAL_RANK[CONSOLIDATE_MIN_CREDENTIAL]) {
            fail(`条目 ${state.assetId} 是 consolidated 但凭证 ${entry.credential} 低于 ${CONSOLIDATE_MIN_CREDENTIAL}（J5 条件 ②）`);
          }
        }
      },
    });

    checks.push({
      name: 'gov-state-refs-resolvable',
      run(fail) {
        for (const state of service.rebuildStates('memory').values()) {
          if (timeline.get(state.assetId) === undefined) {
            fail(`治理状态 ${govStateKey('memory', state.assetId)} 指向的条目不在时间线（弱引用已断）`);
          }
        }
      },
    });
  }

  return checks;
}

export function registerGovernanceInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<GovTables>,
  options: GovInvariantOptions,
): () => void {
  return registry.register('tda-governance', tdaPluginInstaller(governanceInvariantChecks(domain, options)));
}
