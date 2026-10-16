/**
 * P5.6 loader 真挂载场景（子进程 node --experimental-transform-types 直跑）。
 *
 * 证明面：**真 cordis Loader + Include 把 cordis 行挂成可服务**——
 * Include 读 entry-list 文件（真 js-yaml/JSON 词表）→ applyEntryPatches →
 * Loader 裸说明符 import('tda-task-pool')（根级 workspace junction）→
 * unwrapExports 取 default 插件 → apply(config) 自举三槽 → provide 'taskPool'
 * → 容器解析服务真操作 → dispose 卸载。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Include from '@deepseek-ai/cordis-plugin-include';

const dir = process.argv[2];
mkdirSync(dir, { recursive: true });

const bootFile = join(dir, 'tda.boot.json');
writeFileSync(bootFile, JSON.stringify([
  { id: 'tda-task-pool', name: 'tda-task-pool', config: { dir, sessionId: 'sess-loader' } },
]));

// 1) 真挂载 + 模块解析 + apply 调用 + config 送达 + 服务面自检（stdout 证据）
const boot = spawnSync(
  process.execPath,
  ['--experimental-transform-types', join(import.meta.dirname, 'loader-mount-child.mjs'), bootFile],
  { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CI: '1' } },
);
const out = boot.stdout ?? '';
assert.equal(boot.status, 0, '挂载子进程非零退出：' + out + (boot.stderr ?? ''));
assert.ok(out.includes('[tda-task-pool] entry applied（dir='), 'apply 打点缺失');
assert.ok(out.includes('dir='), 'config 未送达');
assert.ok(out.includes('entry 自检：服务面可用'), '服务面自检缺失');

// 2) cordis registry 挂载生命周期（fiber 完成态）——同进程内省
const mod = await import('tda-task-pool');
const ctx = new Context();
ctx.plugin(Loader);
await ctx.plugin(Include, { path: pathToFileURL(bootFile).href });
await new Promise((resolve) => setTimeout(resolve, 2000));
const runtime = ctx.registry.get(mod.default);
assert.ok(runtime !== undefined, 'registry 无挂载 runtime');
const fiberList = [...runtime.fibers];
assert.equal(fiberList.length, 1, '挂载 fiber 数异常');
assert.equal(fiberList[0].state, 2, 'fiber 未 ACTIVE（state=' + fiberList[0].state + '）');

console.log('LOADER-MOUNT-OK');
process.exit(0);
