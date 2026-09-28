import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 临时目录 I/O 在多包并行时会拖慢 fsync 型用例（与 dispatch 包同款假超时）
    testTimeout: 20_000,
  },
});
