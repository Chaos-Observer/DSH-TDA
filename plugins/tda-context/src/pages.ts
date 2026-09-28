/**
 * T0.4 §2 分页树（PageTable）：轻量 memo 常驻 + 完整 page 按需加载。
 *
 * 纪律（§3.3）：page 是**视图不是权威**——权威在 T0.3 时间线；故 PageTable
 * 进程内驻留，启动时可由时间线/taskPool 重建（`rebuild`）。
 * **会话切换 = 任务切换 = 换 page**（J3），换页只做**整段**操作（J4：禁段中截断）。
 */
import type { SessionId } from '@tda/kernel';

export interface PageLabel {
  readonly kind: 'goal' | 'task';
  readonly id: string;
}

export interface PageRecord {
  readonly pageId: string;
  readonly label: PageLabel;
  /** page 覆盖的时间线 seq 范围（闭区间）。 */
  readonly timelineFrom: number;
  readonly timelineTo: number;
  readonly tokenEstimate: number;
  readonly resident: boolean;
  readonly lastAccess: number;
  readonly foldedAt?: number;
}

export interface PageSeed {
  readonly label: PageLabel;
  readonly timelineFrom: number;
  readonly timelineTo: number;
  readonly tokenEstimate?: number;
}

export interface PageTable {
  ensure(label: PageLabel, range?: { from: number; to: number }, at?: number): PageRecord;
  get(pageId: string): PageRecord | undefined;
  list(): readonly PageRecord[];
  resident(): readonly PageRecord[];
  pageIn(pageId: string, at: number): PageRecord;
  pageOut(pageId: string, at: number): PageRecord;
  /** 折叠为 memo 级摘要后的换出（记录 foldedAt，供遮蔽原因 page-fold 使用）。 */
  rebuild(sessionId: SessionId, seeds: readonly PageSeed[], at: number): void;
  focusPage(): PageRecord | undefined;
  touch(pageId: string, at: number): void;
}

export const pageIdOf = (label: PageLabel): string => `${label.kind}:${label.id}`;

export function createPageTable(): PageTable {
  const pages = new Map<string, PageRecord>();
  let focus: string | undefined;

  const require = (pageId: string): PageRecord => {
    const page = pages.get(pageId);
    if (page === undefined) throw new Error(`page 不存在：${pageId}`);
    return page;
  };

  return {
    ensure(label, range, at = 0) {
      const pageId = pageIdOf(label);
      const existing = pages.get(pageId);
      if (existing !== undefined) {
        if (range === undefined) return existing;
        const next: PageRecord = {
          ...existing,
          timelineFrom: Math.min(existing.timelineFrom, range.from),
          timelineTo: Math.max(existing.timelineTo, range.to),
          lastAccess: at,
        };
        pages.set(pageId, next);
        return next;
      }
      const created: PageRecord = {
        pageId,
        label,
        timelineFrom: range?.from ?? 0,
        timelineTo: range?.to ?? 0,
        tokenEstimate: 0,
        // 首建即驻留（$3.4.2 默认折叠策略：焦点相关页展开）
        resident: true,
        lastAccess: at,
      };
      pages.set(pageId, created);
      focus ??= pageId;
      return created;
    },
    get: (pageId) => pages.get(pageId),
    list: () => [...pages.values()].sort((a, b) => a.pageId.localeCompare(b.pageId)),
    resident: () => [...pages.values()].filter((page) => page.resident).sort((a, b) => a.pageId.localeCompare(b.pageId)),
    pageIn(pageId, at) {
      const page = require(pageId);
      const next: PageRecord = {
        pageId: page.pageId,
        label: page.label,
        timelineFrom: page.timelineFrom,
        timelineTo: page.timelineTo,
        tokenEstimate: page.tokenEstimate,
        resident: true,
        lastAccess: at,
      };
      pages.set(pageId, next);
      focus = pageId;
      return next;
    },
    pageOut(pageId, at) {
      const page = require(pageId);
      if (page.resident) {
        pages.set(pageId, { ...page, resident: false, lastAccess: at, foldedAt: at });
      }
      if (focus === pageId) {
        focus = [...pages.values()].find((candidate) => candidate.resident)?.pageId;
      }
      return require(pageId);
    },
    rebuild(_sessionId, seeds, at) {
      pages.clear();
      focus = undefined;
      for (const seed of seeds) {
        const pageId = pageIdOf(seed.label);
        pages.set(pageId, {
          pageId,
          label: seed.label,
          timelineFrom: seed.timelineFrom,
          timelineTo: seed.timelineTo,
          tokenEstimate: seed.tokenEstimate ?? 0,
          resident: true,
          lastAccess: at,
        });
      }
      focus = [...pages.values()].find((page) => page.resident)?.pageId;
    },
    focusPage: () => (focus === undefined ? undefined : pages.get(focus)),
    touch(pageId, at) {
      const page = pages.get(pageId);
      if (page !== undefined) pages.set(pageId, { ...page, lastAccess: at });
    },
  };
}
