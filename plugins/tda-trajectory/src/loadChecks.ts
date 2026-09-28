/**
 * tda-trajectory 插件级不变量：以插件自己的 npm 包名注册（§5"配套插件
 * `dsh-tda/invariant`"的 TDA 侧落地——TDA 事件族的关系由声明它的插件所有）。
 *
 * T0.7 §4.1 八条不变量 → 分层映射：
 *  1. **双写一致**     → 内核 `@tda/kernel` 的 `dualwrite-pairing`（跨插件聚合对账器，
 *                        这里不重复实现）；本插件补 `trajectory-index-consistent-with-log`
 *                        （索引必须指向真实存在的日志事件——索引与日志的一致性）；
 *  2. **log-only 纯净** → `trajectory-log-only-purity`：TDA 事件的载荷不得出现在任何
 *                        模型可见消息里（结构性保证是 `deriveMessages` 只投影
 *                        conversation；本检查是**自动断言**）；
 *  3. **可序列化**     → 结构中保证（session 落盘即 `JSON.stringify`，不可序列化即抛）；
 *  4. **回放等价**     → 运行时 `replayCheck`（服务面，需域现状来源）；本文件不重查；
 *  5. **resume 不改写** → 运行时 `resumeCheck` + `trajectory-history-append-only`
 *                        （日志文件的"未改写"由宿主与冒烟以**字节比对**证明）；
 *  6. **fork seed**    → 内核 `checkSeedInvariants`（纯函数）+ 冒烟；本文件不重查；
 *  7. **业务 id 稳定**  → 各生产插件的提交出口保证（事件 businessId 即实体 id）；
 *  8. **索引可重建**    → `trajectory-index-key-canonical`（键即纪律）+ 服务
 *                        `rebuildIndex()` + 冒烟"删表重扫后与原件逐字段相同"。
 *  ＋ **round↔turn**    → `trajectory-round-turn`（内核 `invariants.ts` 预留的检查点）：
 *                        AssembleRecord.round 必须对应存在的轮次。
 */
import {
  deriveMessages,
  projectTurns,
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
  type TdaHostRecord,
  type TdaSessionHost,
} from '@tda/kernel';
import { auditIndexKey, ENTITY_FAMILY, type TrajectoryTables } from './domain.ts';

export interface TrajectoryInvariantOptions {
  /** 会话主机（提供即启用"索引↔日志一致 / log-only 纯净 / round↔turn"三项检查）。 */
  readonly host?: TdaSessionHost;
}

export function trajectoryInvariantChecks(
  domain: TdaDomain<TrajectoryTables>,
  options: TrajectoryInvariantOptions = {},
): TdaInvariantCheck[] {
  return [
    {
      name: 'trajectory-index-key-canonical',
      run(fail) {
        const table = domain.table('audit_index');
        for (const [key, entry] of table.entries()) {
          const expected = auditIndexKey(entry);
          if (key !== expected) {
            fail(`索引记录键 ${key} 与内容不符（规范键应为 ${expected}）——键即纪律，不在键上的索引永不被查到`);
          }
        }
      },
    },
    {
      name: 'trajectory-index-consistent-with-log',
      run(fail) {
        const host = options.host;
        if (host === undefined) return; // 未装配会话主机：降级
        const events = host.records().filter((record) => record.kind === 'tda');
        const table = domain.table('audit_index');
        for (const [key, entry] of table.entries()) {
          const at = events.find((record) => record.seq === entry.seqFrom);
          if (at === undefined) {
            fail(`索引 ${key} 的 seqFrom=${entry.seqFrom} 在日志里找不到对应事件（索引指向不存在的位置）`);
            continue;
          }
          if (at.businessId !== entry.entityId) {
            fail(`索引 ${key} 的 entityId=${entry.entityId} 与 seqFrom 处事件业务 id ${at.businessId} 不符`);
          }
          const expectedFamily = ENTITY_FAMILY[entry.entityKind];
          if (at.family !== expectedFamily) {
            fail(`索引 ${key} 声明 entityKind=${entry.entityKind}（应来自 ${expectedFamily}），seqFrom 处却是 ${at.family}`);
          }
        }
      },
    },
    {
      name: 'trajectory-round-turn',
      run(fail) {
        const host = options.host;
        if (host === undefined) return; // 未装配会话主机：降级
        const turns = projectTurns(host.records());
        if (turns.length === 0) return; // 无轮次（纯 domain 冒烟）：round↔turn 无对应前提
        const rounds = host
          .records()
          .filter((record): record is TdaHostRecord => record.kind === 'tda' && record.family === 'context/assemble')
          .map((record) => {
            const value = (record.payload as { round?: unknown }).round;
            return typeof value === 'number' ? value : undefined;
          })
          .filter((round): round is number => round !== undefined);
        for (const round of rounds) {
          if (round < 1 || round > turns.length) {
            fail(
              `AssembleRecord.round=${round} 无对应轮次（当前轮次共 ${turns.length} 个）——` +
                '组装必须发生在已开启的轮次内（model-visible⟺logged 的对应关系）',
            );
          }
        }
      },
    },
    {
      name: 'trajectory-log-only-purity',
      run(fail) {
        const host = options.host;
        if (host === undefined) return; // 未装配会话主机：降级
        const records = host.records();
        const messages = deriveMessages(records);
        const haystack = messages.map((message) => message.content).join('\u0000');
        for (const record of records) {
          if (record.kind !== 'tda') continue;
          const serialized = JSON.stringify(record.payload);
          // 只对足够长的载荷做子串检查（短载荷易与自然语言误撞）
          if (serialized.length < 24) continue;
          if (haystack.includes(serialized)) {
            fail(
              `TDA 事件 ${record.family}/${record.businessId} 的载荷出现在模型可见消息里` +
                '（log-only 纯净被破坏：轨迹不得污染 deriveMessages）',
            );
            return;
          }
        }
      },
    },
  ];
}

export function registerTrajectoryInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<TrajectoryTables>,
  options: TrajectoryInvariantOptions = {},
): () => void {
  return registry.register('tda-trajectory', tdaPluginInstaller(trajectoryInvariantChecks(domain, options)));
}
