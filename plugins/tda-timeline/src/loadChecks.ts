/**
 * tda-timeline 插件级不变量：以插件自己的 npm 包名（tda-timeline）注册。
 *
 * T0.3 七条不变量 → 检查/运行时/schema 分层映射：
 *  1. append-only        → 结构性：服务无 update/delete API（更正只产新记录），
 *                          无静态检查可写；冒烟门以"无改写路径 + 双写配对"验证。
 *  2. 引用完整            → schema superRefine（禁自指）+ 加载期检查
 *                          timeline-referential-integrity（指向存在、禁指向
 *                          invalidation 记录——跨记录判定只能加载期做）。
 *  3. 字段完备            → schema superRefine（chunk↔chunkType、
 *                          invalidation↔invalidates 恒等律），打开即拒。
 *  4. 计证强约束          → 服务端强制（append 恒置 quarantine）+ schema
 *                          superRefine（注入场景打开即拒）+ 加载期检查
 *                          timeline-quarantine-accounting 兜底。
 *  5. seq 唯一单调无洞     → 加载期检查 timeline-seq-contiguous（tl-1..tl-N
 *                          恰为连续整数列；服务路径 allocateId 保证无洞）。
 *  6. 当前视图自洽        → 服务路径属性：commit 后 current() 即时反映
 *                          （不变量门用例直接断言）。
 *  7. 单线唯一            → 结构性（J1：domain 即全部，无第二时间线）。
 */
import {
  tdaPluginInstaller,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
  type TdaDomain,
} from '@tda/kernel';
import { QUARANTINE_CREDENTIALS, type TimelineTables } from './domain.ts';

const ENTRY_KEY_RE = /^tl-\d+$/;

export function timelineInvariantChecks(domain: TdaDomain<TimelineTables>): TdaInvariantCheck[] {
  return [
    {
      name: 'timeline-referential-integrity',
      run(fail) {
        const entries = domain.table('timeline_entries');
        for (const [key, entry] of entries.entries()) {
          for (const ref of [entry.supersedes, entry.invalidates]) {
            if (ref === undefined) continue;
            // 自指在 schema 层已拒；此处兜底防御（双保险，消息可区分）
            if (ref === entry.id) {
              fail(`条目 ${key} 引用自身（禁自指）`);
              continue;
            }
            const target = entries.get(ref);
            if (target === undefined) {
              fail(`条目 ${key} 引用不存在的条目 ${ref}（引用完整：supersedes/invalidates 必指向存在的 chunk）`);
              continue;
            }
            if (target.kind !== 'chunk') {
              fail(`条目 ${key} 引用 invalidation 记录 ${ref}（禁指向 invalidation）`);
            }
          }
        }
      },
    },
    {
      name: 'timeline-quarantine-accounting',
      run(fail) {
        const entries = domain.table('timeline_entries');
        for (const [key, entry] of entries.entries()) {
          if (QUARANTINE_CREDENTIALS.has(entry.credential) && !entry.quarantine) {
            fail(`条目 ${key} 凭证 ${entry.credential} 未检疫（§5.2 计证强约束：恒 quarantine=true）`);
          }
        }
      },
    },
    {
      name: 'timeline-seq-contiguous',
      run(fail) {
        const entries = domain.table('timeline_entries');
        const suffixes: number[] = [];
        for (const key of entries.keys()) {
          const match = ENTRY_KEY_RE.exec(key);
          if (match === null) {
            fail(`条目键 ${key} 不符合 tl-<n> 形态（id 空间纯净）`);
            continue;
          }
          suffixes.push(Number(key.slice('tl-'.length)));
        }
        suffixes.sort((a, b) => a - b);
        for (let i = 0; i < suffixes.length; i += 1) {
          const actual = suffixes[i];
          if (actual !== i + 1) {
            fail(`条目 id 序列存在空洞/重号：第 ${i + 1} 位应为 tl-${i + 1}，实际 tl-${String(actual)}`);
            break;
          }
        }
      },
    },
  ];
}

/** 用插件包名注册插件级检查；返回注销函数。 */
export function registerTimelineInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<TimelineTables>,
): () => void {
  return registry.register('tda-timeline', tdaPluginInstaller(timelineInvariantChecks(domain)));
}
