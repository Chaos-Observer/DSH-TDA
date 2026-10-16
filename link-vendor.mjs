// P5.0：为 vendor/dsh 的 DSH 包建 node_modules junction（绝对目标，同 link-workspace 纪律）。
// 结构：vendor/dsh/packages/<group>/<pkg> 与 vendor/dsh/root-vendor/<pkg>（cordis 生态）。
// 用法：node link-vendor.mjs（幂等）
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');
const VENDOR = join(ROOT, 'vendor', 'dsh');
const SCOPE = join(ROOT, 'node_modules', '@deepseek-ai');

const manifests = [];
for (const top of ['packages', 'root-vendor']) {
  const topDir = join(VENDOR, top);
  if (!existsSync(topDir)) continue;
  for (const entry of readdirSync(topDir)) {
    const entryDir = join(topDir, entry);
    // packages/<group>/<pkg> 两层；root-vendor/<pkg> 一层
    if (existsSync(join(entryDir, 'package.json'))) {
      manifests.push({ dir: entryDir, manifest: join(entryDir, 'package.json') });
    } else {
      for (const pkg of readdirSync(entryDir)) {
        const manifest = join(entryDir, pkg, 'package.json');
        if (existsSync(manifest)) manifests.push({ dir: join(entryDir, pkg), manifest });
      }
    }
  }
}

let created = 0;
let reused = 0;
mkdirSync(SCOPE, { recursive: true });
for (const { dir, manifest } of manifests) {
  const name = JSON.parse(readFileSync(manifest, 'utf-8')).name; // @deepseek-ai/xxx
  if (!name.startsWith('@deepseek-ai/')) continue;
  const linkPath = join(SCOPE, name.slice('@deepseek-ai/'.length));
  const source = resolve(dir);
  if (existsSync(linkPath)) {
    if (lstatSync(linkPath).isSymbolicLink()) {
      reused += 1;
      continue; // 已链接（幂等）
    }
    rmSync(linkPath, { recursive: true }); // 实体目录冲突：vendor 接管
  }
  symlinkSync(source, linkPath, 'junction');
  created += 1;
}
// P5.5：vendor/dsh/node_modules 的 npm 依赖 junction（include/loader 的 js-yaml/yaml）。
// 实体在 .workbuddy/npm-tmp（网络安装一次的持久项目数据），此处幂等重建链接。
const NPM_DEPS = ['js-yaml', 'yaml'];
const NPM_SRC = join(ROOT, '.workbuddy', 'npm-tmp', 'node_modules');
const VENDOR_NM = join(VENDOR, 'node_modules');
mkdirSync(VENDOR_NM, { recursive: true });
for (const name of NPM_DEPS) {
  const linkPath = join(VENDOR_NM, name);
  const source = join(NPM_SRC, name);
  if (!existsSync(source)) {
    console.log(`npm dep ${name} 实体缺失（.workbuddy/npm-tmp）——跳过`);
    continue;
  }
  if (existsSync(linkPath)) continue;
  symlinkSync(source, linkPath, 'junction');
  created += 1;
}
console.log(`vendor links: created=${created} reused=${reused} total manifests=${manifests.length}`);
