/**
 * 跨进程 log↔domain 配对对账（父进程侧）：撕裂语义判定。
 *
 * 契约"先域后事件"⇒ 只允许"域有日志无"（撕裂尾），
 * 永不允许"日志有域无"（幽灵事件——域没落事件却落了，属于协议违反）。
 */
import type { SequencedEvent } from '@tda/kernel';

export interface LogDomainPairing {
  /** 日志事件在 domain 找不到对应记录（幽灵——契约违反） */
  readonly ghosts: readonly string[];
  /** domain 记录在日志找不到对应事件（撕裂/漏双写） */
  readonly unpaired: readonly string[];
  readonly ok: boolean;
}

export function pairLogAgainstDomain(
  events: readonly SequencedEvent[],
  domainKeys: Iterable<string>,
): LogDomainPairing {
  const loggedIds = new Set(events.map((event) => event.businessId));
  const domainIdSet = new Set(domainKeys);
  const ghosts: string[] = [];
  const unpaired: string[] = [];
  for (const id of loggedIds) {
    if (!domainIdSet.has(id)) ghosts.push(id);
  }
  for (const key of domainIdSet) {
    if (!loggedIds.has(key)) unpaired.push(key);
  }
  return { ghosts, unpaired, ok: ghosts.length === 0 && unpaired.length === 0 };
}

export function assertNoGhosts(pairing: LogDomainPairing): void {
  if (pairing.ghosts.length > 0) {
    throw new Error(
      `发现幽灵事件（日志有而 domain 无，违反"先域后事件"）：[${pairing.ghosts.join(', ')}]`,
    );
  }
}
