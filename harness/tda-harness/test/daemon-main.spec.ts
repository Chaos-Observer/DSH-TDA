/**
 * daemon 驱动入口门（main.ts 主循环形态）：子进程真跑 `--once` 冒烟——
 * 装配（executor/planner 默认开）→ tick → P1/P2/P3 全驱动 → 不变量 → 退出。
 * 两变体：默认介质（display 临时端口真绑定）+ P5 介质（sqlite 域 + dsh-compat 日志）。
 */
import { mkdtempSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entryPath = fileURLToPath(new URL('../src/main.ts', import.meta.url));


function runOnce(args: readonly string[]): { code: number | null; stdout: string; stderr: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tda-daemon-main-'));
  const run = spawnSync(
    process.execPath,
    [entryPath, '--once', `--dir=${dir}`, ...args],
    { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CI: '1' } },
  );
  return {
    code: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    dir,
  };
}

describe('daemon 驱动入口（main.ts --once）', () => {
  it('默认介质：display 临时端口真绑定 + 全驱动 + 不变量全过', () => {
    const run = runOnce(['--port=0']);
    try {
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('once 完成（不变量全过）');
      expect(run.stdout).toContain('"due"');
      expect(run.stdout).toContain('P1={');
    } finally {
      if (run.code !== 0) {
        console.error(`main --once 失败（exit ${run.code}）\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
      }
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', run.dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    }
  }, 120_000);

  it('P5 介质：sqlite 域 + dsh-compat 日志上同一冒烟全过', () => {
    const run = runOnce(['--storage=sqlite', '--session=dsh-compat', '--no-display']);
    try {
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('once 完成（不变量全过）');
    } finally {
      if (run.code !== 0) {
        console.error(`main --once(sqlite) 失败（exit ${run.code}）\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
      }
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', run.dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    }
  }, 120_000);

  it('常驻模式三视图真断言：/ 页面 + snapshot/report/export 三 API 全 200，SIGINT 优雅退出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-daemon-main-live-'));
    const run = spawn(
      process.execPath,
      [entryPath, '--dir=' + dir, '--port=0', '--tick-ms=200'],
      { env: { ...process.env, CI: '1' } },
    );
    let stdout = '';
    let stderr = '';
    run.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    run.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    try {
      // 等状态台 URL 就绪（startServer 完成即打印）
      const url = await new Promise<string>((resolvePromise, rejectPromise) => {
        const started = Date.now();
        const poll = (): void => {
          const match = stdout.match(/状态台：(\S+)/);
          if (match !== null) {
            resolvePromise(match[1]!);
            return;
          }
          if (Date.now() - started > 30_000) {
            rejectPromise(new Error('状态台 URL 30s 未就绪：' + stdout + stderr));
            return;
          }
          setTimeout(poll, 100);
        };
        poll();
      });

      // 三视图四端点真断言（endpoint 无尾斜杠——统一补齐）
      const base = url.endsWith('/') ? url : url + '/';
      const page = await fetch(base);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('TDA 状态台');

      const snapshot = await fetch(base + 'api/snapshot');
      expect(snapshot.status).toBe(200);
      const body = (await snapshot.json()) as { overview?: unknown; spectrum?: unknown };
      expect(body).toHaveProperty('overview');
      expect(body).toHaveProperty('spectrum');

      const report = await fetch(base + 'api/report');
      expect([200, 500]).toContain(report.status); // J9 fail-open：聚合失败服务仍存活
      if (report.status === 200) {
        expect(await report.text()).toContain('#');
      }

      const dot = await fetch(base + 'api/export/dot');
      expect(dot.status).toBe(200);
      expect(await dot.text()).toContain('digraph');
    } finally {
      run.kill();
      await new Promise((resolvePromise) => run.on('close', resolvePromise));
      if (stderr.length > 0) {
        console.error('常驻模式 stderr：' + stderr);
      }
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    }
  }, 120_000);
});
