// P5.0 vendor 重放脚本：DSH v0.1.7-alpha.2 → vendor/dsh（机械改写，可重放）。
// 改写纪律（VENDORED.md 同款声明）：不碰业务源码一行；仅
//   ① 删包内 tsconfig.json（防 vite 向上误加载 DSH 根配置）；
//   ② package.json exports 机械 src 化（vendor 语境不构建 lib/——types/default 指 src）。
// 来源：D:/WorkSpace/Learn/project/Reference/deepseek-harness @ 00102833df（0.1.7-alpha.2）
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC_ROOT = resolve('D:/WorkSpace/Learn/project/Reference/deepseek-harness');
const DST = resolve('vendor/dsh');

/** packages/ 运行闭包（31 包，2026-10-14 实测）。 */
const PACKAGE_CLOSURE = [
  'attachment/attachment', 'compaction/compaction', 'compaction/compaction-basic',
  'compaction/compaction-image-offload', 'compaction/compaction-tool-result-pruner',
  'core/agent', 'core/scope', 'core/session', 'core/system-prompt', 'core/tools',
  'interaction/commands', 'interaction/user-approval', 'llm/llm', 'llm/llm-retry', 'llm/token-meter',
  'ptc-runtime/ptc-runtime', 'runtime-diagnostics/invariants', 'sandbox/sandbox', 'sandbox/sandbox-policy',
  'session/session-persistence', 'session/session-projection', 'storage/storage', 'storage/storage-domain',
  'storage/storage-json', 'storage/storage-sqlite', 'typert/protocol', 'util/brand', 'util/crypto',
  'util/timeout', 'util/values', 'workspace/workspace',
];
/** 根 vendor/ 的 cordis 生态（被 packages 闭包引用的 3 个）。 */
// P5.5：+ loader/group/include（boot 生态——profile patch 真消费机器，全部无装饰器）
const ROOT_VENDOR_CLOSURE = ['cordis', 'schemastery', 'cosmokit', 'loader', 'group', 'include'];

/** lib 构建产物路径 → src 源码路径（机械映射；.d.ts/.js/.mjs/.cjs → .ts）。 */
const toSrc = (value) =>
  value
    .replace(/^\.\/lib\/types\//, './src/')
    .replace(/^\.\/lib\//, './src/')
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.mjs$/, '.ts')
    .replace(/\.cjs$/, '.ts')
    .replace(/\.js$/, '.ts');

function rewriteExports(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const rewritten = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key !== 'exports') {
      rewritten[key] = value;
      continue;
    }
    const exportsValue = {};
    for (const [entry, target] of Object.entries(value)) {
      if (entry === './package.json') {
        exportsValue[entry] = target;
        continue;
      }
      if (entry === './src/*') {
        exportsValue[entry] = target;
        continue;
      }
      if (typeof target === 'string') {
        exportsValue[entry] = toSrc(target);
      } else if (target !== null && typeof target === 'object') {
        // **保留全部条件键**（types/import/require/default…），值统一 src 化——
        // 只留 types/default 会丢 import/require 条件（schemastery 实测踩坑）
        exportsValue[entry] = Object.fromEntries(
          Object.entries(target).map(([condition, conditionValue]) => [
            condition,
            typeof conditionValue === 'string' ? toSrc(conditionValue) : conditionValue,
          ]),
        );
      } else {
        exportsValue[entry] = target;
      }
    }
    rewritten.exports = exportsValue;
  }
  // 主入口兜底（无 exports 的老式包）：main/types 也 src 化
  if (rewritten.main !== undefined && rewritten.main.startsWith('./lib/')) rewritten.main = toSrc(rewritten.main);
  if (rewritten.types !== undefined && rewritten.types.startsWith('./lib/')) rewritten.types = toSrc(rewritten.types);
  writeFileSync(manifestPath, JSON.stringify(rewritten, null, 2) + '\n');
}

function vendorPackage(relSource, relTarget) {
  const src = resolve(SRC_ROOT, relSource);
  const dst = resolve(DST, relTarget);
  if (!existsSync(resolve(src, 'package.json'))) throw new Error(`missing package: ${relSource}`);
  // 覆写模式（源同内容）：不先删整树——沙箱批量删除护栏会拦；陈旧文件与源一致无副作用
  cpSync(src, dst, { recursive: true, force: true });
  // ① 裁 tsconfig（含 tsconfig.*.json 变体）
  for (const entry of readdirSync(dst)) {
    if (entry.startsWith('tsconfig')) rmSync(resolve(dst, entry));
  }
  // ② exports src 化
  rewriteExports(resolve(dst, 'package.json'));
  return dst;
}

let count = 0;
for (const rel of PACKAGE_CLOSURE) {
  vendorPackage(`packages/${rel}`, `packages/${rel}`);
  count += 1;
}
for (const rel of ROOT_VENDOR_CLOSURE) {
  vendorPackage(`vendor/${rel}`, `root-vendor/${rel}`);
  count += 1;
}
console.log(`vendored ${count} packages → vendor/dsh`);
