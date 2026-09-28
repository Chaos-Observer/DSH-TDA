/**
 * tda-context 插件级不变量：以插件自己的 npm 包名注册。
 *
 * T0.4 §4.1 七条不变量 → 检查/运行时/结构分层映射：
 *  1. C6 豁免绝对化   → **结构性**（`selectDrops` 把 pinned/system 排除在候选之外）
 *                       + 加载期 context-deprivation-order（剥夺序不得含 pinned）；
 *  2. 前缀稳定        → **结构性**（段序固定 system→pinned→memo→history→injection +
 *                       渲染是数据源纯函数）+ 冒烟门逐字节自检；
 *  3. 段边界完整      → 服务期（history 只在 page 边界与 tool-call/result 配对边界分段）
 *                       ——继承 compaction 的配对边界保持；
 *  4. 遮蔽必经权威集  → **结构性**（唯一遮蔽出口是 surface.shadow；服务无删除 API）
 *                       + 冒烟门断言"遮蔽后 surface.shadowedSeqs 必增长"；
 *  5. 双路径可达      → gate.runGate 无样本/全哨兵即降级 static（不变量门用例）；
 *  6. pinned 同步     → 服务期每轮重渲染（不缓存正文）+ 冒烟门"改约束下一轮即反映"；
 *  7. 组装留痕        → **结构性**（AssembleRecord 不落 domain，只走 log-only 事件 +
 *                       时间线）+ 不变量门"从 session log 重建 == records()"。
 *
 * 加载期能查的只有 `context_pins`（本插件唯一表）与配置配比。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import { type ContextTables } from './domain.ts';
import { assertAllocation, DEFAULT_ALLOCATION, DEPRIVATION_ORDER, type BudgetAllocation } from './budget.ts';

export interface ContextInvariantOptions {
  /** 四区配比（插件 Config）；提供即校验其合法性。 */
  readonly allocation?: BudgetAllocation;
}

/** 与域无关的静态结构检查（防"有人把 pinned 塞进剥夺序"这类静默退化）。 */
export function contextStaticChecks(): TdaInvariantCheck[] {
  return [
    {
      name: 'context-deprivation-order',
      run(fail) {
        const expected = ['injection', 'history', 'memo'];
        if (DEPRIVATION_ORDER.join(',') !== expected.join(',')) {
          fail(`剥夺序必须是 ${expected.join(' → ')}，实为 ${DEPRIVATION_ORDER.join(' → ')}`);
        }
        if (DEPRIVATION_ORDER.includes('pinned') || DEPRIVATION_ORDER.includes('system')) {
          fail('pinned/system 不得参与剥夺（C6 豁免绝对化）');
        }
      },
    },
  ];
}

export function contextInvariantChecks(
  domain: TdaDomain<ContextTables>,
  options: ContextInvariantOptions = {},
): TdaInvariantCheck[] {
  return [
    ...contextStaticChecks(),
    {
      name: 'context-pin-key-canonical',
      run(fail) {
        const pins = domain.table('context_pins');
        for (const [key, pin] of pins.entries()) {
          if (key !== String(pin.id)) {
            fail(`钉扎项记录键 ${key} 与内容 id ${String(pin.id)} 不符（键即纪律，不在键上的项永不生效）`);
          }
        }
      },
    },
    {
      name: 'context-pin-source-kind',
      run(fail) {
        const pins = domain.table('context_pins');
        const allowed: Record<string, readonly string[]> = {
          'goalTree.focus': ['goal', 'criteria'],
          constraint_snapshots: ['constraint'],
          'taskPool.focus': ['goal', 'criteria'],
          'config.safety': ['safety'],
        };
        for (const [key, pin] of pins.entries()) {
          if (!(allowed[pin.sourceKind] ?? []).includes(pin.kind)) {
            fail(`钉扎项 ${key} 的 sourceKind=${pin.sourceKind} 不支持 kind=${pin.kind}`);
          }
        }
      },
    },
    {
      name: 'context-budget-allocation',
      run(fail) {
        const allocation = options.allocation ?? DEFAULT_ALLOCATION;
        try {
          assertAllocation(allocation);
        } catch (error) {
          fail(`四区配比非法：${error instanceof Error ? error.message : String(error)}`);
        }
        if (allocation.pinnedPct <= 0) {
          fail('pinned 区配比必须为正（C6 四类钉扎不得被压到零额）');
        }
      },
    },
  ];
}

export function registerContextInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<ContextTables>,
  options: ContextInvariantOptions = {},
): () => void {
  return registry.register('tda-context', tdaPluginInstaller(contextInvariantChecks(domain, options)));
}
