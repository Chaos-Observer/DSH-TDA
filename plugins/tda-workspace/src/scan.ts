/**
 * T0.6 确定性扫描原语（**零 LLM**）：角色初判、显性依赖解析、版本链推导、
 * 可信度提示、三级 cache 比对、路径安全。
 *
 * 这些函数是"确定性采集"的全部内容（J1：只有隐性依赖启发式/脉络摘要/可信度
 * 初判需要模型，其余不付 LLM 成本）。全部是纯函数——可单测、可复算、可回放。
 */
import { posix } from 'node:path';
import { TdaError } from '@tda/kernel';
import {
  CREDIBILITY_HINTS,
  FILE_ROLES,
  isSafeRelativePath,
  type CredibilityHint,
  type EdgeKind,
  type FileRole,
  type ScanCache,
} from './domain.ts';

/** 目录名 → 跳过匹配（与 fs seam 的 skip 同源）。 */
export const isIgnoredPath = (path: string, skip: readonly string[]): boolean =>
  path.split('/').some((segment) => skip.includes(segment));

/** 路径规范化 + 安全断言（不变量 1：workspace 相对、禁逃逸、禁绝对）。 */
export function normalizeScanRoot(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (trimmed === '') {
    throw new TdaError('UNSAFE_PATH', '扫描根不得为空');
  }
  if (/^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('/')) {
    throw new TdaError('UNSAFE_PATH', `扫描根不得为绝对路径：${raw}`);
  }
  const segments = trimmed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new TdaError('UNSAFE_PATH', `扫描根不得含 .. 逃逸段：${raw}`);
  }
  if (segments.length === 0) {
    throw new TdaError('UNSAFE_PATH', `扫描根无有效路径段：${raw}`);
  }
  const normalized = segments.join('/');
  if (!isSafeRelativePath(normalized)) {
    throw new TdaError('UNSAFE_PATH', `扫描根不规范：${raw}`);
  }
  return normalized;
}

const ROLE_BY_EXT: Readonly<Record<string, FileRole>> = {
  md: 'doc',
  txt: 'doc',
  rst: 'doc',
  adoc: 'doc',
  pdf: 'doc',
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  py: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  hpp: 'code',
  sh: 'code',
  yaml: 'config',
  yml: 'config',
  toml: 'config',
  ini: 'config',
  cfg: 'config',
  json: 'config',
  jsonc: 'config',
  env: 'config',
  csv: 'data',
  tsv: 'data',
  jsonl: 'data',
  parquet: 'data',
  sqlite: 'data',
  sql: 'data',
  png: 'artifact',
  jpg: 'artifact',
  jpeg: 'artifact',
  gif: 'artifact',
  svg: 'artifact',
  zip: 'artifact',
  exe: 'artifact',
  dll: 'artifact',
  so: 'artifact',
  mp4: 'artifact',
  log: 'artifact',
};

export const extOf = (path: string): string => {
  const base = posix.basename(path);
  const index = base.lastIndexOf('.');
  if (index <= 0) return '';
  return base.slice(index + 1).toLowerCase();
};

/** 扩展名 → 角色初判（LLM 标注可覆盖；不标注时也保证 role 有意义）。 */
export const guessRole = (path: string): FileRole => ROLE_BY_EXT[extOf(path)] ?? 'unknown';

/** 草稿/临时命名标记（可信度初判的命名信号，J4）。 */
const DRAFT_TOKENS: readonly string[] = [
  'draft',
  'wip',
  'tmp',
  'temp',
  'old',
  'bak',
  'backup',
  'copy',
  '草稿',
  '副本',
  '拷贝',
];

const DRAFT_DIRS: readonly string[] = ['scratch', 'tmp', 'temp', 'draft', 'drafts', 'wip', '.trash'];

const stemTokensOf = (path: string): readonly string[] => {
  const base = posix.basename(path);
  const dot = base.lastIndexOf('.');
  const stem = dot <= 0 ? base : base.slice(0, dot);
  return stem.toLowerCase().split(/[._\-\s]+/).filter((token) => token !== '');
};

/**
 * 可信度初判（J4：**提示非裁决**）。
 * 信号：命名（draft/wip/tmp/old/副本…）、目录角色（scratch/ vs docs/）、
 * git 跟踪状态、mtime 新旧（相对扫描时刻 30 天）。
 * 明确纪律：任何文件都不因扫描自动升格为知识——本函数只产提示。
 */
export function assessCredibility(input: {
  readonly path: string;
  readonly mtime: number;
  readonly now: number;
  readonly gitTracked?: boolean | undefined;
}): CredibilityHint {
  const tokens = stemTokensOf(input.path);
  const dirs = input.path.split('/').slice(0, -1).map((segment) => segment.toLowerCase());
  if (tokens.some((token) => DRAFT_TOKENS.includes(token)) || dirs.some((dir) => DRAFT_DIRS.includes(dir))) {
    return 'draft-likely';
  }
  const underDocs = dirs.some((dir) => dir === 'docs' || dir === 'doc' || dir === 'spec' || dir === 'specs');
  const fresh = input.now - input.mtime < 30 * 24 * 60 * 60 * 1_000;
  if (underDocs && input.gitTracked === true && fresh) return 'authoritative-likely';
  return 'unknown';
}

/** 显性依赖解析（确定性；不变量 6：边指向的节点必须存在——由调用方过滤）。 */
export function extractExplicitDeps(head: string, ext: string, selfPath: string): string[] {
  const found = new Set<string>();
  const push = (specifier: string): void => {
    if (!specifier.startsWith('.')) return; // 只认相对引用（外部包不是工作区文件图）
    const resolved = posix.normalize(posix.join(posix.dirname(selfPath), specifier));
    if (resolved === selfPath) return;
    if (!isSafeRelativePath(resolved)) return;
    found.add(resolved);
  };
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    for (const match of head.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier !== undefined) push(specifier);
    }
  } else if (['c', 'h', 'cpp', 'hpp'].includes(ext)) {
    for (const match of head.matchAll(/#include\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (specifier !== undefined) push(specifier);
    }
  } else if (ext === 'py') {
    for (const match of head.matchAll(/^\s*from\s+([.\w]+)\s+import/gm)) {
      const specifier = match[1];
      if (specifier !== undefined && specifier.startsWith('.')) push(specifier.replace(/\./g, '/'));
    }
  } else if (ext === 'md') {
    for (const match of head.matchAll(/\]\(([^)\s#?]+)\)/g)) {
      const specifier = match[1];
      if (specifier !== undefined && specifier.startsWith('.')) push(decodeURIComponent(specifier));
    }
  }
  return [...found];
}

/** 若 `to` 未带扩展名而磁盘上有唯一 `to.<ext>`，视作同一节点（TS 常见写法）。 */
export function resolveExisting(paths: ReadonlySet<string>, candidate: string): string | undefined {
  if (paths.has(candidate)) return candidate;
  const matches = [...paths].filter((path) => path.startsWith(`${candidate}.`)).sort();
  if (matches.length === 1) return matches[0];
  const indexes = [...paths].filter((path) => path === `${candidate}/index.ts` || path === `${candidate}/index.js`).sort();
  return indexes.length === 1 ? indexes[0] : undefined;
}

/** 显性依赖边（确定性，confidence 恒 1，带 evidence=命中语句）。 */
export interface DerivedEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly confidence: number;
  readonly evidence: string;
}

export function deriveExplicitEdges(
  paths: ReadonlySet<string>,
  heads: ReadonlyMap<string, string>,
): DerivedEdge[] {
  const edges: DerivedEdge[] = [];
  for (const [path, head] of [...heads.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ext = extOf(path);
    for (const candidate of extractExplicitDeps(head, ext, path)) {
      const target = resolveExisting(paths, candidate);
      if (target === undefined || target === path) continue;
      edges.push({
        from: path,
        to: target,
        kind: 'depends-on',
        confidence: 1,
        evidence: `${ext === 'md' ? 'markdown 链接' : 'import/require'} → ${candidate}`,
      });
    }
  }
  return edges;
}

/** 版本链推导（`supersedes-file`）：命名约定（draft/old/bak 标记）+ `.v<N>` 版本号。 */
export function deriveSupersedesEdges(paths: readonly string[]): DerivedEdge[] {
  const set = new Set(paths);
  const edges: DerivedEdge[] = [];
  for (const path of [...paths].sort()) {
    const dir = posix.dirname(path);
    const base = posix.basename(path);
    const dot = base.lastIndexOf('.');
    const ext = dot <= 0 ? '' : base.slice(dot);
    const stem = dot <= 0 ? base : base.slice(0, dot);
    const tokens = stem.toLowerCase().split(/[._\-\s]+/).filter((token) => token !== '');
    const markIndex = tokens.findIndex((token) => DRAFT_TOKENS.includes(token));
    if (markIndex >= 0) {
      const cleaned = tokens.filter((_token, index) => index !== markIndex).join('-');
      const candidate = posix.join(dir, `${cleaned}${ext}`);
      const target = candidate === path ? undefined : candidate;
      if (target !== undefined && set.has(target)) {
        edges.push({
          from: target,
          to: path,
          kind: 'supersedes-file',
          confidence: 0.9,
          evidence: `命名约定：${path} 含 "${tokens[markIndex]}" 标记，${target} 为其正式版`,
        });
      }
      continue;
    }
    const versionMatch = /^(.*?)[._-]v(\d+)$/.exec(stem);
    if (versionMatch !== null) {
      const [, versionStem, versionText] = versionMatch;
      const version = Number(versionText);
      if (version > 1) {
        const previous = posix.join(dir, `${versionStem}.v${version - 1}${ext}`);
        if (set.has(previous)) {
          edges.push({
            from: path,
            to: previous,
            kind: 'supersedes-file',
            confidence: 0.9,
            evidence: `版本号：v${version} 取代 v${version - 1}`,
          });
        }
      }
    }
  }
  return edges;
}

/**
 * 三级 cache 比对（不变量 4）：size+mtime+contentHash 任一维变化即需重标注。
 * 返回需要重标注的路径集（含新文件与已消失文件的处理由调用方负责）。
 */
export function changedPaths(
  entries: readonly { readonly path: string; readonly size: number; readonly mtime: number; readonly contentHash?: string | undefined }[],
  cache: ReadonlyMap<string, ScanCache | undefined>,
  mode: 'full' | 'incremental',
): readonly string[] {
  if (mode === 'full') return entries.map((entry) => entry.path);
  const changed: string[] = [];
  for (const entry of entries) {
    const previous = cache.get(entry.path);
    if (previous === undefined) {
      changed.push(entry.path);
      continue;
    }
    if (previous.size !== entry.size || previous.mtime !== entry.mtime) {
      changed.push(entry.path);
      continue;
    }
    if (previous.contentHash !== undefined && entry.contentHash !== undefined && previous.contentHash !== entry.contentHash) {
      changed.push(entry.path);
    }
  }
  return changed;
}

/** 可信度提示的合法值集（加载期检查用）。 */
export const CREDIBILITY_VALUES: readonly string[] = [...CREDIBILITY_HINTS];
export const FILE_ROLE_VALUES: readonly string[] = [...FILE_ROLES];
