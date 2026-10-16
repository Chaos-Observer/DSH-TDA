/**
 * TDA daemon 驱动入口（主循环形态——P4 遗留"opt-in 随主循环形态改默认开"的落点）。
 *
 * 与 IT0 骨架的差别：
 *  - **真数据目录**（--dir，缺省临时目录不丢弃——持久运行须显式 --dir）；
 *  - **P4 三开关默认开**（executor/planner/display——本入口即主循环；runtime 层
 *    默认值不变，测试的手动流 opt-in 纪律不受影响）；
 *  - **P1/P2/P3 周期驱动**入循环（独立时钟：P1/P3 每 30s / P2 每 300s——各自
 *    有吞吐帽与 fail-open 兜底，见各 driveX 实现）；
 *  - **--once 冒烟模式**：装配 → tick → 三驱动 → 不变量 → 退出（非测试环境的
 *    产品级冒烟路径，集成门以子进程消费）。
 *
 * 退出路径固定：停表 → 不变量对账（不过即非零退出）→ dispose。
 * 用法：node src/main.ts [--dir <path>] [--once] [--no-display] [--no-executor]
 *                      [--no-planner] [--storage json|sqlite]
 *                      [--session file|dsh-compat] [--port <n>] [--tick-ms <n>]
 */
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemon } from './daemon.ts';
import { assembleRuntime, type TdaRuntime } from './runtime.ts';

interface CliOptions {
  dir?: string;
  once: boolean;
  display: boolean;
  executor: boolean;
  planner: boolean;
  storage: 'json' | 'sqlite';
  session: 'file' | 'dsh-compat';
  port?: number;
  tickMs: number;
}

function parseArgv(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    once: argv.includes('--once'),
    display: !argv.includes('--no-display'),
    executor: !argv.includes('--no-executor'),
    planner: !argv.includes('--no-planner'),
    storage: 'json',
    session: 'file',
    tickMs: 1_000,
  };
  // 两种形都认：--flag value 与 --flag=value（等号形静默回退默认值是曾踩坑）
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index >= 0) return argv[index + 1];
    const prefixed = argv.find((item) => item.startsWith(flag + '='));
    return prefixed !== undefined ? prefixed.slice(flag.length + 1) : undefined;
  };
  const dir = value('--dir');
  if (dir !== undefined) options.dir = resolve(dir);
  const storage = value('--storage');
  if (storage === 'json' || storage === 'sqlite') options.storage = storage;
  const session = value('--session');
  if (session === 'file' || session === 'dsh-compat') options.session = session;
  const port = value('--port');
  if (port !== undefined && Number.isFinite(Number(port))) options.port = Number(port);
  const tickMs = value('--tick-ms');
  if (tickMs !== undefined && Number.isFinite(Number(tickMs))) options.tickMs = Math.max(50, Number(tickMs));
  return options;
}

/** P1/P2/P3 周期驱动节拍（毫秒；独立时钟，tick 保持 1s 粒度不掺重活——P4 纪律）。 */
const DRIVE_P1_MS = 30_000;
const DRIVE_P2_MS = 300_000;
const DRIVE_P3_MS = 30_000;

async function main(): Promise<void> {
  const cli = parseArgv(process.argv.slice(2));
  let dir: string;
  if (cli.dir !== undefined) {
    if (!existsSync(cli.dir)) mkdirSync(cli.dir, { recursive: true });
    dir = cli.dir;
  } else {
    dir = await mkdtemp(join(tmpdir(), 'tda-harness-'));
  }

  const runtime: TdaRuntime = await assembleRuntime({
    dir,
    storageBackend: cli.storage,
    sessionBackend: cli.session,
    executorEnabled: cli.executor,
    plannerEnabled: cli.planner,
    displayEnabled: cli.display,
    ...(cli.port !== undefined ? { displayPort: cli.port } : {}),
  });
  const daemon = createDaemon({ runtime, tickIntervalMs: cli.tickMs });

  // ── P4（T4.4）状态台：startServer 由调用方显式触发（display 插件纪律）──
  if (cli.display && runtime.display !== undefined) {
    const endpoint = await runtime.display.service.startServer(cli.port !== undefined ? { port: cli.port } : undefined);
    console.log('[tda-harness] 状态台：' + endpoint.url);
  }

  const timers: ReturnType<typeof setInterval>[] = [];
  const driveEvery = (ms: number, label: string, run: () => Promise<unknown>): void => {
    timers.push(setInterval(() => {
      run().then(
        (report) => console.log(`[tda-harness] ${label}: ${JSON.stringify(report)}`),
        (error: unknown) => console.error(`[tda-harness] ${label} 失败：`, error),
      );
    }, ms));
  };
  const driveP1 = (): Promise<unknown> => runtime.driveP1();
  const driveP3 = (): Promise<unknown> => runtime.driveP3();
  const driveP2 = (): Promise<unknown> => runtime.driveP2();

  if (cli.once) {
    // ── 冒烟模式：一轮全驱动 + 不变量 + 退出 ──
    const report = await runtime.tick();
    const p1 = await runtime.driveP1();
    const p2 = await runtime.driveP2();
    const p3 = await runtime.driveP3();
    console.log(`[tda-harness] once tick 报告：${JSON.stringify(report)}`);
    console.log(`[tda-harness] once 驱动：P1=${JSON.stringify(p1)} P2=${JSON.stringify(p2)} P3=${JSON.stringify(p3)}`);
    await runtime.verifyInvariants();
    await runtime.dispose();
    console.log('[tda-harness] once 完成（不变量全过）');
    return;
  }

  // ── 常驻模式：tick 循环（daemon）+ 驱动节拍（独立时钟）──
  driveEvery(DRIVE_P1_MS, 'driveP1', driveP1);
  driveEvery(DRIVE_P2_MS, 'driveP2', driveP2);
  driveEvery(DRIVE_P3_MS, 'driveP3', driveP3);
  daemon.start();
  console.log(`[tda-harness] daemon 已启动（数据目录 ${dir}，storage=${cli.storage}，session=${cli.session}，executor=${cli.executor}，planner=${cli.planner}，display=${cli.display}）`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[tda-harness] 收到 ${signal}，优雅退出…`);
    for (const timer of timers) clearInterval(timer);
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
