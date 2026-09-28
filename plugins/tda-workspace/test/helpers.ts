/**
 * T0.6 测试脚手架：内存 FS / 任务池 seam 假体 / Sidekick 标注假体 / 时间线假体。
 *
 * 内存 FS 严格实现 seam 契约（walk 返回**相对传入 root** 的路径），使
 * "路径基准换算"这一层也被测试覆盖（而不是被真实 FS 掩盖）。
 */
import { createHash } from 'node:crypto';
import { asSessionId, type TdaLogEvent, type TdaSessionSink } from '@tda/kernel';
import type { FsEntry, WorkspaceFs } from '../src/fs.ts';
import type {
  SidekickAnnotator,
  SidekickAnnotationRequest,
  SidekickAnnotationOutcome,
  WorkspaceTaskSeam,
  WorkspaceTaskView,
  WorkspaceTimelineSeam,
} from '../src/service.ts';

export function createMemorySink(sessionId = 'sess-workspace'): TdaSessionSink & { readonly events: TdaLogEvent[] } {
  const events: TdaLogEvent[] = [];
  let seq = 0;
  return {
    sessionId: asSessionId(sessionId),
    append(event: TdaLogEvent) {
      events.push(event);
      seq += 1;
      return seq;
    },
    flush() {},
    events,
  };
}

export interface MemoryFile {
  readonly content: string;
  readonly mtime: number;
}

export interface MemoryFs extends WorkspaceFs {
  readonly files: Map<string, MemoryFile>;
  readonly heads: string[];
  put(path: string, content: string, mtime?: number): void;
  remove(path: string): void;
}

/**
 * 内存 FS：键为绝对 posix 路径（如 `/ws/proj/a.md`）。
 * `escapeAt`（可选）模拟符号链接逃逸：realpath 把该路径解析到 workspace 之外。
 */
export function createMemoryFs(
  files: Record<string, string | MemoryFile> = {},
  options: { readonly escapeAt?: string; readonly escapeTo?: string } = {},
): MemoryFs {
  const table = new Map<string, MemoryFile>();
  for (const [path, value] of Object.entries(files)) {
    table.set(path, typeof value === 'string' ? { content: value, mtime: 1_700_000_000_000 } : value);
  }
  const heads: string[] = [];
  const stripTrailing = (path: string): string => path.replace(/\/+$/, '');
  return {
    files: table,
    heads,
    put(path, content, mtime = 1_700_000_000_000) {
      table.set(path, { content, mtime });
    },
    remove(path) {
      table.delete(path);
    },
    async walk(root, walkOptions) {
      const base = stripTrailing(root);
      const prefix = `${base}/`;
      const matched = [...table.keys()].filter((path) => path.startsWith(prefix)).sort();
      const entries: FsEntry[] = [];
      const unfinished: string[] = [];
      let truncated = false;
      for (const path of matched) {
        const relative = path.slice(prefix.length);
        const segments = relative.split('/');
        if (segments.slice(0, -1).some((segment) => walkOptions.skip.includes(segment))) continue;
        const info = table.get(path);
        if (info === undefined) continue;
        if (entries.length >= walkOptions.maxFiles) {
          truncated = true;
          unfinished.push(relative);
          continue;
        }
        entries.push({ path: relative, size: Buffer.byteLength(info.content, 'utf8'), mtime: info.mtime });
      }
      return { entries, truncated, unfinished };
    },
    async readHead(absolutePath, maxBytes) {
      heads.push(absolutePath);
      const info = table.get(absolutePath);
      if (info === undefined) throw new Error(`内存 FS 缺文件：${absolutePath}`);
      return Buffer.from(info.content, 'utf8').subarray(0, maxBytes).toString('utf8');
    },
    async hashFile(absolutePath) {
      const info = table.get(absolutePath);
      if (info === undefined) throw new Error(`内存 FS 缺文件：${absolutePath}`);
      return createHash('sha256').update(info.content).digest('hex');
    },
    async realpath(path) {
      if (options.escapeAt !== undefined && stripTrailing(path) === stripTrailing(options.escapeAt)) {
        return options.escapeTo ?? '/outside/elsewhere';
      }
      return path;
    },
  };
}

export function createFakeTasks(
  seeds: readonly Partial<WorkspaceTaskView>[] = [{}],
): { readonly seam: WorkspaceTaskSeam; readonly tasks: Map<string, WorkspaceTaskView> } {
  const tasks = new Map<string, WorkspaceTaskView>();
  seeds.forEach((seed, index) => {
    const task: WorkspaceTaskView = {
      id: `task-${index + 1}`,
      revision: 0,
      goalId: 'goal-1',
      phase: 'active',
      localPath: `proj-${index + 1}`,
      writeScopes: [],
      ...seed,
    };
    tasks.set(task.id, task);
  });
  return {
    tasks,
    seam: { get: (id) => tasks.get(id) },
  };
}

export interface FakeAnnotator extends SidekickAnnotator {
  readonly requests: SidekickAnnotationRequest[];
  readonly configured: (value: SidekickAnnotationOutcome | ((req: SidekickAnnotationRequest) => SidekickAnnotationOutcome)) => void;
}

export function createFakeAnnotator(initial?: SidekickAnnotationOutcome): FakeAnnotator {
  const requests: SidekickAnnotationRequest[] = [];
  let responder: (req: SidekickAnnotationRequest) => SidekickAnnotationOutcome =
    () => initial ?? { ok: true, structured: { files: [], edges: [], notes: [] }, childSessionId: 'sub-1' };
  return {
    requests,
    configured(value) {
      responder = typeof value === 'function' ? value : () => value;
    },
    async annotate(req) {
      requests.push(req);
      return responder(req);
    },
  };
}

export interface FakeTimelineChunk {
  readonly credential: string;
  readonly source: string;
  readonly content: string;
  readonly trajectoryLink?: string;
}

export function createFakeTimeline(): { readonly seam: WorkspaceTimelineSeam; readonly chunks: FakeTimelineChunk[] } {
  const chunks: FakeTimelineChunk[] = [];
  let seq = 0;
  return {
    chunks,
    seam: {
      async append(_writer, chunk) {
        seq += 1;
        chunks.push({
          credential: chunk.credential,
          source: chunk.source,
          content: chunk.content,
          ...(chunk.trajectoryLink !== undefined ? { trajectoryLink: chunk.trajectoryLink } : {}),
        });
        return { id: `tl-${seq}` };
      },
    },
  };
}
