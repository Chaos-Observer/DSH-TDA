import { defineConfig } from 'vitest/config';

/**
 * harness 集成门的执行策略：**文件级串行**。
 *
 * 理由（IT4 实测）：本包的用例会 spawn 子进程（kill -9 冒烟）并做大量 fsync 密集的
 * 域落盘；文件级并行时多个 worker 争用磁盘与进程表，会把 1.6s 的用例拖成 90s 假超时。
 * 插件包的门仍走默认并行（它们不 spawn、不锁盘）。
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
