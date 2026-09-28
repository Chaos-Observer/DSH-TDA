/**
 * T0.4 §2 预算四区（J4：百分比配比，非绝对 token）。
 *
 * 关键裁定：
 *  - 四区默认配比按 §2（pinned 8–12% / memo 8–12% / history 50–65% / injection 15–25%）
 *    的**中位**取值，U3 待压测标定；
 *  - **剥夺序固定 = injection → history → memo**，pinned 永不参与剥夺（不变量 1）；
 *  - 剥夺按区内优先级：静态优先级表（默认）+ 可插拔打分器（T1.1 引力场），
 *    分数越低越先被剥。
 */
import type { SegmentKind } from './domain.ts';

export interface BudgetAllocation {
  readonly pinnedPct: number;
  readonly memoPct: number;
  readonly historyPct: number;
  readonly injectionPct: number;
}

/** 默认配比（中位取值，U3 实现后压测标定）。 */
export const DEFAULT_ALLOCATION: BudgetAllocation = {
  pinnedPct: 0.1,
  memoPct: 0.1,
  historyPct: 0.6,
  injectionPct: 0.2,
};

/** 剥夺序（J4/§2 明文）：injection 先剥，history 次之，memo 最后；pinned 不剥。 */
export const DEPRIVATION_ORDER: readonly SegmentKind[] = ['injection', 'history', 'memo'];

export const assertAllocation = (allocation: BudgetAllocation): void => {
  const total =
    allocation.pinnedPct + allocation.memoPct + allocation.historyPct + allocation.injectionPct;
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(`四区配比之和须为 1，实为 ${total}`);
  }
  for (const [key, value] of Object.entries(allocation)) {
    if (value < 0 || value > 1) throw new Error(`预算配比 ${key} 越界：${value}`);
  }
};

export interface BudgetPlan {
  readonly totalTokens: number;
  readonly caps: Record<SegmentKind, number>;
  readonly used: Record<SegmentKind, number>;
  /** 溢出分区（pinned 溢出是 C6 的合法后果，history/injection 溢出属剥夺失败须报错）。 */
  readonly overrun: readonly SegmentKind[];
}

/** 简易 token 计量（P0 近似：UTF-8 字节 /4；DSH tokenMeter 接入后替换）。 */
export const defaultTokenMeter = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

export const planBudget = (
  totalTokens: number,
  allocation: BudgetAllocation,
  used: Record<SegmentKind, number>,
): BudgetPlan => {
  const caps: Record<SegmentKind, number> = {
    system: 0,
    pinned: Math.floor(totalTokens * allocation.pinnedPct),
    memo: Math.floor(totalTokens * allocation.memoPct),
    history: Math.floor(totalTokens * allocation.historyPct),
    injection: Math.floor(totalTokens * allocation.injectionPct),
  };
  const overrun: SegmentKind[] = [];
  for (const kind of ['pinned', 'memo', 'history', 'injection'] as const) {
    if (used[kind] > caps[kind]) overrun.push(kind);
  }
  return { totalTokens, caps, used, overrun };
};
