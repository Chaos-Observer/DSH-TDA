/**
 * T0.4 测试脚手架：目标/任务 seam 假体、时间线假体、可变约束源。
 *
 * surface 直接用 `createMemorySurface`（src 内的参考实现）——它同时是被测面与
 * 测试夹具，正因如此它必须最小且语义直白（这本身也是"seam 足够窄"的证据）。
 */
import { asSessionId, type TdaLogEvent, type TdaSessionSink } from '@tda/kernel';
import type { ContextGoalFocusView, ContextTaskFocusView, ContextTimelineSeam } from '../src/service.ts';

export function createMemorySink(sessionId = 'sess-context'): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId(sessionId),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

export const goalView = (overrides: Partial<ContextGoalFocusView> = {}): ContextGoalFocusView => ({
  id: 'goal-1',
  objective: '把灯环配对协议整理成可复用文档',
  phase: 'active',
  stage: 'executing',
  completionCriteria: ['帧格式表格齐全', '配对流程可复现'],
  budgetRemaining: { tokens: 9_000, wallClockMs: 60_000, attentionUnits: 5 },
  ...overrides,
});

export const taskView = (overrides: Partial<ContextTaskFocusView> = {}): ContextTaskFocusView => ({
  id: 'task-1',
  subject: '整理协议帧表格',
  stage: 'executing',
  priority: 5,
  budget: { zone: 'normal' },
  ...overrides,
});

/** 可变目标 seam：`constraintsOf` 可在用例中改写（验证 pinned 无过期窗口）。 */
export function createFakeGoalSeam(initial: ContextGoalFocusView | null = goalView()): {
  seam: { focusView(): ContextGoalFocusView | undefined; constraints(goalId: string): readonly string[] };
  set(view: ContextGoalFocusView | null): void;
  setConstraints(list: readonly string[]): void;
  constraintsCalls: string[];
} {
  let view = initial ?? undefined;
  let constraints: readonly string[] = ['不得覆盖原始抓包数据'];
  const constraintsCalls: string[] = [];
  return {
    constraintsCalls,
    set(next) {
      view = next ?? undefined;
    },
    setConstraints(list) {
      constraints = [...list];
    },
    seam: {
      focusView: () => view,
      constraints(goalId) {
        constraintsCalls.push(goalId);
        return constraints;
      },
    },
  };
}

export function createFakeTaskSeam(initial: readonly ContextTaskFocusView[] = [taskView()]): {
  seam: { list(filter?: { readonly stage?: string }): readonly ContextTaskFocusView[] };
  set(list: readonly ContextTaskFocusView[]): void;
} {
  let list = [...initial];
  return {
    set(next) {
      list = [...next];
    },
    seam: {
      list: (filter) => (filter?.stage === undefined ? list : list.filter((task) => task.stage === filter.stage)),
    },
  };
}

export interface FakeTimelineChunk {
  readonly credential: string;
  readonly source: string;
  readonly content: string;
  readonly relatedTaskId?: string;
}

export function createFakeTimeline(): { readonly seam: ContextTimelineSeam; readonly chunks: FakeTimelineChunk[] } {
  const chunks: FakeTimelineChunk[] = [];
  let seq = 0;
  return {
    chunks,
    seam: {
      current: () => chunks.map((chunk, index) => ({ id: `tl-${index + 1}`, content: chunk.content, source: chunk.source })),
      async append(_writer, chunk) {
        seq += 1;
        chunks.push({
          credential: chunk.credential,
          source: chunk.source,
          content: chunk.content,
          ...(chunk.relatedTaskId !== undefined ? { relatedTaskId: chunk.relatedTaskId } : {}),
        });
        return { id: `tl-${seq}` };
      },
    },
  };
}
