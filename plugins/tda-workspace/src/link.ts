/**
 * T0.6 J8：事件驱动的时点扫描（claim / 执行收敛 / verifying 三个时点各触发一次增量扫描）。
 *
 * 纪律（承 IT2 的 dispose 序教训）：
 *  - 扫描是**已提交事实的回声**（floating promise），订阅手柄必须提供
 *    `unsubscribe() + drain()`，否则 dispose 关域会撞上晚到的扫描写；
 *  - 预期内的跳过必须**显式分类**（无 localPath / 任务不存在 / 路径逃逸），
 *    其余错误走 onError 照抛，绝不静默吞（fail-loud）；
 *  - 只在 stage **跃迁进入**触发集时扫（同一 stage 的重复事件不重复扫）。
 */
import type { TdaBusEvent, TdaEventBus } from '@tda/kernel';
import type { WorkspaceCaller, WorkspaceService } from './service.ts';

/** 触发扫描的任务 stage（claim=executing；执行收敛/verifying=verifying）。 */
export const SCAN_TRIGGER_STAGES: readonly string[] = ['executing', 'verifying'];

/** 预期内跳过（分类显式，不算异常）。 */
export const SKIPPABLE_CODES: readonly string[] = [
  'WORKSPACE_NO_LOCAL_PATH',
  'WORKSPACE_TASK_NOT_FOUND',
  'UNSAFE_PATH',
];

export interface TaskScanLinkOptions {
  readonly bus: TdaEventBus;
  readonly workspace: WorkspaceService;
  readonly caller: WorkspaceCaller;
  /** 去重基线：缺省由订阅者自建（首次事件视为跃迁）。 */
  readonly onError?: (message: string) => void;
}

export interface TaskScanLinkHandle {
  unsubscribe(): void;
  /** 等待在途扫描结束（dispose 序：退订 → drain → 关域）。 */
  drain(): Promise<void>;
}

export function subscribeTaskScan(options: TaskScanLinkOptions): TaskScanLinkHandle {
  const report =
    options.onError ??
    ((message: string): void => {
      console.error('[tda-workspace] 时点扫描失败：', message);
    });
  const lastStage = new Map<string, string>();
  const inflight = new Set<Promise<void>>();
  // 同任务串行由 workspace 服务的 per-task 队列保证；此处只负责触发与追踪
  const unsubscribe = options.bus.subscribe('taskPool/change', (event: TdaBusEvent) => {
    const payload = event.payload;
    const taskId = payload.id;
    const stage = payload.stage;
    if (typeof taskId !== 'string' || typeof stage !== 'string') return;
    if (!SCAN_TRIGGER_STAGES.includes(stage)) {
      lastStage.set(taskId, stage);
      return;
    }
    if (lastStage.get(taskId) === stage) return; // 非跃迁：不重复扫
    lastStage.set(taskId, stage);
    const promise = options.workspace
      .scan(options.caller, { taskId, mode: 'incremental' })
      .then(() => undefined)
      .catch((error: unknown) => {
        const code = (error as { code?: string }).code;
        if (code !== undefined && SKIPPABLE_CODES.includes(code)) return; // 预期内：显式分类后跳过
        report(`任务 ${taskId} 时点扫描失败：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        inflight.delete(promise);
      });
    inflight.add(promise);
  });
  return {
    unsubscribe,
    async drain() {
      await Promise.all([...inflight]);
    },
  };
}
