/**
 * P5.5 profile 真消费场景（子进程 node --experimental-transform-types 直跑）。
 *
 * 证明面：**DSH 真代码消费 cordis.yml**——vendor/dsh/root-vendor/include 的
 * `entryListSchema`（js-yaml Schema，!!js 表达式词表）解析 + `applyEntryPatches`
 * 全语义（根追加 / `- id` 整块替换不合并 / name 防呆 / disabled 切换 / 未命中
 * warn 跳过）作用在含 dsh-base 基座的真条目表上。
 *
 * app-boot index（loadOptionalPatches 住址）因 npm 闭包断供（resolve.exports/ajv
 * 不在本机）不可加载——故读取+parse 的十行薄壳按其源码等价复刻，schema 与 patch
 * 语义两件核心真件直吃 vendor 源码（勘察裁定见 docs/DSH宿主boot勘察与评估.md）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// js-yaml 实体在 .workbuddy/npm-tmp（vendor/dsh/node_modules junction 指向它）——场景从
// vendor 解析链取用（与 include 内部同一份），TDA 根 node_modules 不落 npm 散件。
import jsYamlCjs from '../../../vendor/dsh/node_modules/js-yaml/index.js';
const yamlLib = { load: jsYamlCjs.load, JSON_SCHEMA: jsYamlCjs.JSON_SCHEMA };
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const content = readFileSync(join(repoRoot, 'profiles', 'cordis.yml'), 'utf8');

// ── 1) DSH 真词表解析：entryListSchema（!!js 表达式支持与 app-boot parsePatchList 同款）──
const parsed = yamlLib.load(content, { schema: entryListSchema });
assert.ok(Array.isArray(parsed), 'cordis.yml 顶层必须是 PatchOptions 数组');
assert.equal(parsed.length, 1, 'TDA 层 = 单个 - insert 层');
const patchList = parsed[0];
assert.ok(Array.isArray(patchList.insert), 'insert 列表存在');
assert.equal(patchList.insert.length, 27, '27 行全量层叠');
for (const row of patchList.insert) {
  assert.ok(typeof row.id === 'string' && row.id.startsWith('tda-'), '行 id = tda-<短名>');
  assert.ok(typeof row.name === 'string' && row.name.length > 0, '行 name = 工作区包名');
}

// ── 2) applyEntryPatches 真语义：dsh-base 基座 + TDA insert 层 ──
const base = [
  { id: 'dsh-base', name: 'dsh-base-fake', group: true, config: [{ id: 'dsh-session', name: 'dsh-session' }] },
];
const warns1 = [];
const merged = applyEntryPatches(structuredClone(base), [patchList], (msg) => warns1.push(msg));
assert.equal(warns1.length, 0, '27 行全部命中（零 warn）');
assert.equal(merged.filter((entry) => String(entry.id).startsWith('tda-')).length, 27, '27 行根追加');
const baseRow = merged.find((entry) => entry.id === 'dsh-base');
assert.equal(baseRow.config.length, 1, '基座行不受 TDA 层影响');

// ── 3) 后续层语义：- id 整块替换（不合并）/ disabled 切换 / name 防呆 / 未命中 warn ──
const overlay = [
  { id: 'tda-executor', config: { executorEnabled: true } },
  { id: 'tda-smoke', name: 'tda-smoke', disabled: true },
  { id: 'tda-no-such-row', name: 'nope' },
];
const warns2 = [];
const merged2 = applyEntryPatches(merged, overlay, (msg) => warns2.push(msg));
const executor = merged2.find((entry) => entry.id === 'tda-executor');
assert.deepEqual(executor.config, { executorEnabled: true }, 'config 整块替换（不合并——patch.ts 同语义）');
assert.equal(executor.name, 'tda-executor', '未带 name 的替换保持原 name');
assert.equal(merged2.find((entry) => entry.id === 'tda-smoke').disabled, true, 'disabled 停用开关可落');
assert.equal(warns2.length, 1, '未命中行恰一条 warn（fail-soft 跳过）');

console.log('P55-GATE-OK');
process.exit(0);
