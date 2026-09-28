/**
 * 控制文件协议：子进程每完成一个 op 追加一行 `ready <n>`，父进程轮询标记。
 *
 * 用文件而非管道：kill -9 后管道缓冲区随进程消失，控制文件留在盘上，
 * 父进程据此判断"子进程死前走到哪一步"。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export const CONTROL_READY = 'ready';
export const CONTROL_IDLE = 'idle';
export const CONTROL_TORN = 'torn';
export const CONTROL_BOOTED = 'booted';

export function writeControl(file: string, marker: string, index?: number): void {
  const line = index === undefined ? `${marker}\n` : `${marker} ${index}\n`;
  appendFileSync(file, line, 'utf8');
}

export function readControl(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * 等待控制文件出现指定标记；ready 需序号 >= minIndex。
 * 超时返回 false（调用方应结合子进程 stderr 诊断）。
 */
export async function waitForControl(
  file: string,
  marker: string,
  options: { readonly timeoutMs?: number; readonly minIndex?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const minIndex = options.minIndex ?? 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const line of readControl(file)) {
      const separator = line.indexOf(' ');
      const head = separator === -1 ? line : line.slice(0, separator);
      if (head !== marker) continue;
      if (marker === CONTROL_READY) {
        const index = Number(line.slice(separator + 1));
        if (Number.isFinite(index) && index >= minIndex) return true;
        continue;
      }
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
