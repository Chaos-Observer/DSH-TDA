/**
 * CAS 与无洞 id 分配。
 *
 * CAS：期望 revision 不匹配即抛 STALE_REVISION，不静默重试（并发覆写必须显式处理）。
 * allocateId：无独立计数器——从表内现有键最大数值后缀 +1 派生，
 *  分配即落键，崩溃不留洞也不重号（依赖权威实体记录不硬删）。
 */
import { TdaError, type Revision } from './types.ts';

export class StaleRevisionError extends TdaError {
  // 显式字段声明（不用参数属性）：保持 erasable-syntax-only，Node strip-only 可直跑。
  readonly entity: string;
  readonly expected: Revision;
  readonly actual: Revision;

  constructor(
    entity: string,
    expected: Revision,
    actual: Revision,
  ) {
    super('STALE_REVISION', `实体 "${entity}" 修订号过期：期望 ${expected}，实际 ${actual}（不静默重试）`);
    this.entity = entity;
    this.expected = expected;
    this.actual = actual;
  }
}

export class IdSpaceExhaustedError extends TdaError {
  readonly prefix: string;

  constructor(prefix: string) {
    super('ID_SPACE_EXHAUSTED', `id 前缀 "${prefix}" 数值空间耗尽（已达 MAX_SAFE_INTEGER）`);
    this.prefix = prefix;
  }
}

/** CAS：校验 revision 后应用变更并递增；不匹配即抛。 */
export function cas<T extends { revision: Revision }>(
  current: T,
  expected: Revision,
  mutate: (current: T) => Omit<T, 'revision'>,
): T {
  if (current.revision !== expected) {
    const entityId = (current as { id?: unknown }).id;
    throw new StaleRevisionError(
      typeof entityId === 'string' ? entityId : '<unknown>',
      expected,
      current.revision,
    );
  }
  return { ...mutate(current), revision: current.revision + 1 } as T;
}

/** 可枚举键的极小表面（TdaKvTable 的结构子集，测试可用普通 Map 代替）。 */
export interface KeySource {
  keys(): IterableIterator<string>;
}

export function allocateId(table: KeySource, prefix: string): string {
  let max = 0;
  for (const key of table.keys()) {
    if (!key.startsWith(`${prefix}-`)) continue;
    const suffix = key.slice(prefix.length + 1);
    if (!/^\d+$/.test(suffix)) continue;
    const value = Number(suffix);
    if (value > max) max = value;
  }
  if (max >= Number.MAX_SAFE_INTEGER) {
    throw new IdSpaceExhaustedError(prefix);
  }
  return `${prefix}-${max + 1}`;
}
