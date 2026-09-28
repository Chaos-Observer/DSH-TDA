/**
 * IT0 本地直跑入口：装配运行时 → daemon start → SIGINT/SIGTERM 优雅退出。
 *
 * 退出路径固定：停表 → 不变量对账（不过即非零退出）→ dispose。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from './daemon.ts';
import { assembleRuntime } from './runtime.ts';

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-harness-'));
  const runtime = await assembleRuntime({ dir });
  const daemon = createDaemon({ runtime });
  daemon.start();
  console.log(`[tda-harness] daemon 已启动（数据目录 ${dir}）`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[tda-harness] 收到 ${signal}，优雅退出…`);
    await daemon.stop();
    await runtime.verifyInvariants();
    await runtime.dispose();
    console.log('[tda-harness] 已退出');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();
