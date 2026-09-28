/** 测试共享助手：内存 session sink / 临时目录 / TdaError 断言。 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { asSessionId, TdaError, type TdaLogEvent, type TdaSessionSink } from '../src/index.ts';

export interface MemorySinkHandle {
  readonly sink: TdaSessionSink;
  readonly events: TdaLogEvent[];
  flushCount(): number;
}

/** 内存 session sink：append 分配自增 seq，flush 计数（屏障断言用）。 */
export function createMemorySink(): MemorySinkHandle {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  let flushes = 0;
  return {
    sink: {
      sessionId: asSessionId('sess-test'),
      append(event: TdaLogEvent) {
        events.push(event);
        seq += 1;
        return seq;
      },
      flush() {
        flushes += 1;
      },
    },
    events,
    flushCount: () => flushes,
  };
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  // Windows 上目录删除可能瞬时 EBUSY/ENOTEMPTY（杀软/索引器仍持有句柄），
  // 与测试逻辑无关，故带重试而非让偶发环境噪声变成红灯。
  // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

export function expectTdaError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TdaError);
    expect((error as TdaError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 TdaError(${code})，但未抛出`);
}

export async function expectTdaErrorAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TdaError);
    expect((error as TdaError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 TdaError(${code})，但未抛出`);
}
