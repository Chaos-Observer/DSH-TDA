/**
 * T0.6 文件系统 seam：把"采集"从"判定"里剥出来，使扫描逻辑可测、可跨平台。
 *
 * 真实实现走 Node FS 原语（readdir/stat/realpath/hash），**不经模型**（§5：
 * 文件清单/元数据/hash 由本地确定性采集，LLM 只见 Sidekick 结论）。
 * 测试注入内存实现，从而不需要真实目录也能覆盖忽略规则/上限/增量全部分支。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath as fsRealpath, stat } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';

/** 采集到的一条文件条目（workspace 相对路径）。 */
export interface FsEntry {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
}

export interface WalkOptions {
  readonly maxFiles: number;
  /** 命中即整棵子树跳过（目录名精确匹配）。 */
  readonly skip: readonly string[];
}

export interface WalkResult {
  readonly entries: readonly FsEntry[];
  /** 上限命中（文件数）——调用方必须转成显式 truncated+unfinished（C5）。 */
  readonly truncated: boolean;
  /** 因上限未采集完的剩余项（人读清单）。 */
  readonly unfinished: readonly string[];
}

/** git 版本线索探针（U1：P0 只取跟踪状态）；缺省不探测（gitTracked 缺席）。 */
export interface GitProbe {
  tracked(absoluteRoot: string): Promise<ReadonlySet<string> | undefined>;
}

export interface WorkspaceFs {
  /** 递归列出 root 下的文件（确定性：按路径字典序，保证重扫可比对）。 */
  walk(root: string, options: WalkOptions): Promise<WalkResult>;
  /** 读取文件头部片段（≤ maxBytes），供 Sidekick 语义标注。 */
  readHead(absolutePath: string, maxBytes: number): Promise<string>;
  /** 小文件内容哈希（sha256 hex）。 */
  hashFile(absolutePath: string): Promise<string>;
  /** 真实路径（符号链接逃逸判定用）。 */
  realpath(path: string): Promise<string>;
}

/** 默认忽略规则（U4：实现期定；`.git` 恒忽略——版本元数据不是工作内容）。 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
];

/** Node FS 实现（生产路径）。 */
export function createNodeWorkspaceFs(): WorkspaceFs {
  return {
    async walk(root, options) {
      const entries: FsEntry[] = [];
      const unfinished: string[] = [];
      let truncated = false;
      const walkDir = async (absolute: string, prefix: string): Promise<void> => {
        if (truncated) return;
        let dirents;
        try {
          dirents = await readdir(absolute, { withFileTypes: true });
        } catch {
          return; // 权限/竞态：该子树跳过，不使整次扫描失败（目录级降级）
        }
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        for (const dirent of dirents) {
          if (truncated) {
            unfinished.push(posix.join(prefix, dirent.name));
            continue;
          }
          if (dirent.isDirectory()) {
            if (options.skip.includes(dirent.name)) continue;
            await walkDir(join(absolute, dirent.name), posix.join(prefix, dirent.name));
            continue;
          }
          if (!dirent.isFile()) continue;
          if (entries.length >= options.maxFiles) {
            truncated = true;
            unfinished.push(posix.join(prefix, dirent.name));
            return;
          }
          const info = await stat(join(absolute, dirent.name));
          entries.push({ path: posix.join(prefix, dirent.name), size: info.size, mtime: Math.floor(info.mtimeMs) });
        }
      };
      await walkDir(root, '');
      return { entries, truncated, unfinished };
    },
    async readHead(absolutePath, maxBytes) {
      const buffer = await readFile(absolutePath);
      return buffer.subarray(0, maxBytes).toString('utf8');
    },
    async hashFile(absolutePath) {
      const buffer = await readFile(absolutePath);
      return createHash('sha256').update(buffer).digest('hex');
    },
    async realpath(path) {
      return fsRealpath(path);
    },
  };
}

/** 相对路径计算（跨平台：统一成 posix 分隔符）。 */
export const toRelativePosix = (root: string, absolute: string): string =>
  relative(root, absolute).split(/[\\/]/).join('/');
