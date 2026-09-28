/**
 * kill -9 场景驱动：把场景脚本（.mjs）写进包内 testkit-runtime/ 目录，
 * 以当前 Node 直跑（内核为 erasable-syntax + 显式 .ts 扩展，Node 24
 * 类型剥离零转译执行），按需硬杀并回收退出信号。
 *
 * 脚本必须位于消费包目录内：裸标识符（@tda/kernel 等）靠 node_modules
 * 向上解析，放系统临时目录会找不到工作区依赖。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hardKill } from './process.ts';

export interface SpawnScenarioOptions {
  readonly runtimeDir: string;
  readonly scriptName: string;
  readonly scriptSource: string;
  readonly args?: readonly string[];
}

export interface SpawnedScenario {
  readonly child: ChildProcess;
  readonly scriptPath: string;
  /** 子进程 stderr 累积（启动失败诊断用） */
  readStderr(): string;
}

export function spawnScenario(options: SpawnScenarioOptions): SpawnedScenario {
  mkdirSync(options.runtimeDir, { recursive: true });
  const scriptPath = join(options.runtimeDir, options.scriptName);
  writeFileSync(scriptPath, options.scriptSource, 'utf8');
  let stderr = '';
  const child = spawn(process.execPath, [scriptPath, ...(options.args ?? [])], {
    cwd: options.runtimeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  child.stdout?.on('data', () => {
    // 场景脚本不约定 stdout；丢弃以防背压
  });
  return { child, scriptPath, readStderr: () => stderr };
}

export interface KillOutcome {
  readonly signal: string | null;
  readonly code: number | null;
  /**
   * 是否确认为硬杀致死（不可捕获、无清理机会）：
   *  - POSIX：exit 事件 signal === 'SIGKILL'；
   *  - Windows：信号不可观测（exit 事件 signal 恒为 null），以 TerminateProcess
   *    固定退出码 1 判定（process.kill(pid,'SIGKILL') 经 libuv 映射，
   *    实测 { code: 1, signal: null }）。
   * kill -9 场景断言一律用本字段，不直接断言 signal（U-e2 已定）。
   */
  readonly hardKilled: boolean;
}

/** 硬杀并等待退出；kill -9 场景 outcome.hardKilled 应为 true。 */
export async function killAndWait(child: ChildProcess, timeoutMs = 10_000): Promise<KillOutcome> {
  return new Promise<KillOutcome>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('killAndWait 超时：子进程未退出'));
      }
    }, timeoutMs);
    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        hardKilled:
          signal === 'SIGKILL' ||
          (process.platform === 'win32' && signal === null && code === 1),
      });
    };
    child.once('exit', finish);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(child.exitCode, child.signalCode);
      return;
    }
    if (child.pid === undefined) {
      settled = true;
      clearTimeout(timer);
      reject(new Error('子进程无 pid，无法硬杀'));
      return;
    }
    hardKill(child.pid);
  });
}
