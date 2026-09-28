/**
 * tda-harness daemon 骨架自测：tick 推进 / 停摆 / 重复 start fail-loud /
 * 退出前两级不变量全过。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaemon } from '../src/daemon.ts';
import { assembleRuntime } from '../src/runtime.ts';

describe('tda-harness daemon 骨架', () => {
  it('start → tick 推进 → stop 后停摆，退出前不变量全过', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-harness-'));
    const runtime = await assembleRuntime({ dir });
    try {
      const daemon = createDaemon({ runtime, tickIntervalMs: 5 });
      daemon.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(daemon.ticks()).toBeGreaterThan(0);
      await daemon.stop();
      const settled = daemon.ticks();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(daemon.ticks()).toBe(settled);
      await expect(runtime.verifyInvariants()).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('重复 start 抛错（fail-loud）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-harness-dup-'));
    const runtime = await assembleRuntime({ dir });
    try {
      const daemon = createDaemon({ runtime, tickIntervalMs: 5 });
      daemon.start();
      expect(() => daemon.start()).toThrow(/已在运行/);
      await daemon.stop();
    } finally {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
