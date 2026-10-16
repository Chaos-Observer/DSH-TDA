import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * 手工补齐 workspace 链接（等价于 `pnpm install` 在本仓库做的那部分工作）。
 *
 * 本机教训（IT4）：在沙箱 FS 层下，**相对目标**的 symlink/junction 会被解析到
 * 错误基准（实测落到 PortableGit 目录里），因此这里一律用**绝对目标**。
 * 仅在本机 pnpm 安装器失效时使用（见 memory 的"本机工具链坑"）。
 */

const ROOT = resolve('.');

const WORKSPACE_DIRS = [
  'packages/tda-kernel',
  'packages/tda-testkit',
  ...readdirSync('plugins')
    .filter((name) => existsSync(join('plugins', name, 'package.json')))
    .map((name) => `plugins/${name}`),
  ...readdirSync('harness')
    .filter((name) => existsSync(join('harness', name, 'package.json')))
    .map((name) => `harness/${name}`),
];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const pkgDirs = new Map();
for (const dir of WORKSPACE_DIRS) {
  pkgDirs.set(readJson(join(dir, 'package.json')).name, resolve(dir));
}

const externalHosts = ['node_modules', ...WORKSPACE_DIRS.map((dir) => join(dir, 'node_modules'))];

const findExternal = (name) => {
  for (const host of externalHosts) {
    const candidate = join(host, name);
    if (existsSync(candidate)) return resolve(candidate);
  }
  return undefined;
};

/** 判断既有链接是否健康（lstat 探存在 + readlink 目标存在）。 */
const linkHealthy = (linkPath) => {
  try {
    lstatSync(linkPath);
  } catch {
    return false;
  }
  try {
    const target = readFileSync(`${linkPath}`, 'utf8');
    void target;
  } catch {
    // 目录：用 existsSync 判定穿透后是否存在
  }
  return existsSync(linkPath);
};

const force = process.argv.includes('--force');
let created = 0;
let healthy = 0;
let repaired = 0;
const problems = [];

for (const dir of WORKSPACE_DIRS) {
  const manifest = readJson(join(dir, 'package.json'));
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  const target = join(dir, 'node_modules');
  for (const name of Object.keys(deps)) {
    const linkPath = join(target, name);
    let exists = false;
    try {
      lstatSync(linkPath);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && !force && linkHealthy(linkPath)) {
      healthy += 1;
      continue;
    }
    const workspaceDir = pkgDirs.get(name);
    const source = workspaceDir !== undefined ? workspaceDir : findExternal(name);
    if (source === undefined) {
      problems.push(`${dir}: 找不到依赖 ${name} 的落点（需先联网安装）`);
      continue;
    }
    if (exists) {
      rmSync(linkPath, { recursive: true, force: true });
      repaired += 1;
    }
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(source, linkPath, 'junction');
    created += 1;
    console.log(`${exists ? 'repair' : 'link  '} ${linkPath} → ${source}`);
  }
}

// P5.6：根级 workspace 链接（cordis loader 裸说明符可达——DSH 宿主行按包名挂载，
// import('tda-*') 从 vendor 树向上解析到根 node_modules）。幂等，不碰既有依赖链接。
const ROOT_LINKS = join(ROOT, 'node_modules');
mkdirSync(ROOT_LINKS, { recursive: true });
for (const [name, dir] of pkgDirs) {
  const linkPath = join(ROOT_LINKS, name);
  if (existsSync(linkPath)) continue;
  try {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(dir, linkPath, 'junction');
    created += 1;
    console.log(`root-link ${linkPath} → ${dir}`);
  } catch (error) {
    problems.push(`root-link ${linkPath}: ${String(error)}`);
  }
}

console.log(`\ncreated=${created} repaired=${repaired} healthy=${healthy}`);
if (problems.length > 0) {
  console.log('PROBLEMS:\n' + problems.join('\n'));
  process.exitCode = 1;
}
