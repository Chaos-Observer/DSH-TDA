/**
 * replay-equivalence 比较器：由 session 日志重建期望记录集，与 domain 现状对比。
 *
 * 相等 = 零差异（idle-kill / boot-kill 场景的验收口径）；
 * missing = 日志有而域无（幽灵——"先域后事件"契约下不应出现）；
 * extra = 域有而日志无（撕裂/漏双写）；
 * divergent = 同名不同值。
 */
import type { SequencedEvent } from '@tda/kernel';

export interface ReplayRecord {
  readonly key: string;
  readonly value: unknown;
}

export interface ReplayDiff {
  readonly equal: boolean;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly divergent: readonly string[];
}

/** 泛型 E：允许日志行形态（含 payload）直接流入 rebuild 回调。 */
export function compareReplay<E extends SequencedEvent>(
  events: readonly E[],
  actual: Iterable<readonly [string, unknown]>,
  rebuild: (event: E) => ReplayRecord | undefined,
): ReplayDiff {
  const expected = new Map<string, unknown>();
  for (const event of events) {
    const record = rebuild(event);
    if (record) expected.set(record.key, record.value);
  }
  const actualMap = new Map<string, unknown>(actual);
  const missing: string[] = [];
  const extra: string[] = [];
  const divergent: string[] = [];
  for (const [key, value] of expected) {
    if (!actualMap.has(key)) {
      missing.push(key);
      continue;
    }
    if (JSON.stringify(actualMap.get(key)) !== JSON.stringify(value)) {
      divergent.push(key);
    }
  }
  for (const key of actualMap.keys()) {
    if (!expected.has(key)) extra.push(key);
  }
  return {
    equal: missing.length === 0 && extra.length === 0 && divergent.length === 0,
    missing,
    extra,
    divergent,
  };
}

/** 零差异断言：不等即抛，消息带完整差异清单。 */
export function assertReplayEquivalence(diff: ReplayDiff): void {
  if (diff.equal) return;
  throw new Error(
    `replay-equivalence 失败：幽灵（日志有域无）[${diff.missing.join(', ')}]；` +
      `撕裂（域有日志无）[${diff.extra.join(', ')}]；分歧 [${diff.divergent.join(', ')}]`,
  );
}
