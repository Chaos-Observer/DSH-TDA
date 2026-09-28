/**
 * 硬杀进程：SIGKILL 直杀（Windows 上 Node 映射为 TerminateProcess，不给进程
 * 任何清理机会），taskkill /F 回退覆盖异常环境。专用于崩溃语义验证，
 * 生产路径禁止使用。
 */
import { execFileSync } from 'node:child_process';

export function hardKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
    return;
  } catch {
    // 落入 taskkill 回退
  }
  try {
    execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    // 进程可能已退出；调用方以退出信号/码判定
  }
}

export function hardKillSelf(): void {
  hardKill(process.pid);
}
