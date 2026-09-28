/**
 * daemon 骨架：tick 循环 + 优雅退出（IT0）。
 *
 * IT2 起任务池入驻 runtime.tick；进程管理（PID 文件/信号转发）IT1 起由
 * DSH 宿主接管，本骨架保留 start/stop/tick 语义作为最小闭环。
 */
export interface TdaRuntimeLike {
  /** 返回值被忽略：IT2 起 runtime.tick 回传 tick 报告（due/startedRuns/skipped）。 */
  tick(): Promise<unknown>;
}

export interface DaemonOptions {
  readonly runtime: TdaRuntimeLike;
  /** 缺省 1000ms；测试传小值加速。 */
  readonly tickIntervalMs?: number;
}

export interface TdaDaemon {
  start(): void;
  /** 停表并等待在途 tick 落定。 */
  stop(): Promise<void>;
  ticks(): number;
}

export function createDaemon(options: DaemonOptions): TdaDaemon {
  const intervalMs = options.tickIntervalMs ?? 1_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let latest: Promise<unknown> | null = null;
  let tickCount = 0;
  let running = false;

  return {
    start() {
      if (running) {
        throw new Error('daemon 已在运行（重复 start）');
      }
      running = true;
      timer = setInterval(() => {
        tickCount += 1;
        latest = options.runtime.tick().catch((error: unknown) => {
          // tick 失败不静默：保留诊断输出；IT2 起重试/退避策略入驻
          console.error('[tda-harness] tick 失败：', error);
        });
      }, intervalMs);
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      running = false;
      if (latest !== null) {
        await latest;
        latest = null;
      }
    },
    ticks() {
      return tickCount;
    },
  };
}
