/**
 * T0.5 测试脚手架：内存 sink / 任务池 seam 假体 / 时间线 seam 假体。
 *
 * 设计原则（同 T0.1/T0.2 测试）：假体只实现**被依赖的那一面**，并记录调用序
 * ——"服务从不改任务状态"（不变量 6）这类**否定性**断言靠调用日志自证，
 * 而不是靠"没抛错"。
 */
import {
  asSessionId,
  StaleRevisionError,
  type TdaLogEvent,
  type TdaSessionSink,
} from '@tda/kernel';
import type { DispatchTaskPoolSeam, DispatchTimelineSeam } from '../src/service.ts';

export function createMemorySink(sessionId = 'sess-dispatch'): TdaSessionSink & { readonly events: TdaLogEvent[] } {
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

export interface FakeTaskState {
  id: string;
  revision: number;
  goalId: string;
  subject: string;
  description: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  stage: 'planning' | 'executing' | 'waiting' | 'verifying';
  ownerId?: string | undefined;
  localPath?: string | undefined;
  writeScopes: string[];
  priority: number;
  proposal?: { status: 'pending_approval' | 'approved' | 'rejected' };
  budget: {
    zone: 'normal' | 'converge' | 'exhausted';
    tokens?: number;
    consumed: { tokens: number; toolCalls: number; wallClockMs: number; attentionUnits: number };
  };
}

export interface FakeTaskPool {
  readonly seam: DispatchTaskPoolSeam;
  /** 主任务（单任务场景的便捷入口）。 */
  readonly task: FakeTaskState;
  readonly tasks: Map<string, FakeTaskState>;
  /** 调用日志（否定性断言用：`complete` 永不出现即"服务从不改任务状态"）。 */
  readonly calls: string[];
}

const makeTask = (seed: Partial<FakeTaskState>, index: number): FakeTaskState => ({
  id: `task-${index + 1}`,
  revision: 0,
  goalId: 'goal-1',
  subject: `整理灯环协议文档 ${index + 1}`,
  description: '把 COM186 抓到的帧整理成表格',
  phase: 'active',
  stage: 'executing',
  writeScopes: [],
  priority: 5,
  budget: {
    zone: 'normal',
    tokens: 10_000,
    consumed: { tokens: 0, toolCalls: 0, wallClockMs: 0, attentionUnits: 0 },
  },
  ...seed,
});

export function createFakeTaskPool(seeds: Partial<FakeTaskState> | readonly Partial<FakeTaskState>[] = {}): FakeTaskPool {
  const list = Array.isArray(seeds) ? seeds : [seeds];
  const tasks = new Map<string, FakeTaskState>();
  list.forEach((seed, index) => {
    const task = makeTask(seed, index);
    tasks.set(task.id, task);
  });
  const first = [...tasks.values()][0];
  if (first === undefined) throw new Error('假任务池至少需要一个任务');
  const calls: string[] = [];
  const seam: DispatchTaskPoolSeam = {
    get(id) {
      return tasks.get(id);
    },
    async claim(_actor, id, ref, ownerId) {
      calls.push(`claim:${id}`);
      const task = tasks.get(id);
      if (task === undefined) throw new Error(`假任务不存在：${id}`);
      if (task.revision !== ref.expectedRevision) throw new StaleRevisionError(id, ref.expectedRevision, task.revision);
      task.revision += 1;
      task.ownerId = ownerId;
      return task;
    },
    async release(_actor, id, ref) {
      calls.push(`release:${id}`);
      const task = tasks.get(id);
      if (task === undefined) throw new Error(`假任务不存在：${id}`);
      if (task.revision !== ref.expectedRevision) throw new StaleRevisionError(id, ref.expectedRevision, task.revision);
      task.revision += 1;
      task.ownerId = undefined;
      return task;
    },
    async consume(_actor, id, ref, usage) {
      calls.push(`consume:${id}`);
      const task = tasks.get(id);
      if (task === undefined) throw new Error(`假任务不存在：${id}`);
      if (task.revision !== ref.expectedRevision) throw new StaleRevisionError(id, ref.expectedRevision, task.revision);
      task.revision += 1;
      task.budget.consumed = {
        tokens: task.budget.consumed.tokens + (usage.tokens ?? 0),
        toolCalls: task.budget.consumed.toolCalls + (usage.toolCalls ?? 0),
        wallClockMs: task.budget.consumed.wallClockMs + (usage.wallClockMs ?? 0),
        attentionUnits: task.budget.consumed.attentionUnits + (usage.attentionUnits ?? 0),
      };
      return task;
    },
  };
  return { seam, task: first, tasks, calls };
}

export interface FakeTimelineChunk {
  readonly actor: string;
  readonly content: string;
  readonly credential: string;
  readonly source: string;
  readonly relatedTaskId?: string;
  readonly trajectoryLink?: string;
}

export function createFakeTimeline(): {
  readonly seam: DispatchTimelineSeam;
  readonly chunks: FakeTimelineChunk[];
} {
  const chunks: FakeTimelineChunk[] = [];
  let seq = 0;
  return {
    chunks,
    seam: {
      async append(writer, chunk) {
        seq += 1;
        chunks.push({
          actor: writer.actor,
          content: chunk.content,
          credential: chunk.credential,
          source: chunk.source,
          ...(chunk.relatedTaskId !== undefined ? { relatedTaskId: chunk.relatedTaskId } : {}),
          ...(chunk.trajectoryLink !== undefined ? { trajectoryLink: chunk.trajectoryLink } : {}),
        });
        return { id: `tl-${seq}` };
      },
    },
  };
}
