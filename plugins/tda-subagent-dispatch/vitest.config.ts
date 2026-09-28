import { defineConfig } from 'vitest/config';

/**
 * 派发插件的 kill -9/子进程/临时目录用例是 I/O 密集型：并行满载时 5s 默认超时
 * 会假红（实测一次全量跑里 1 例超时、单跑复绿）。放宽到 20s——不是掩盖慢，
 * 而是让"超时"只可能指向真死锁。
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
