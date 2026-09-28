/**
 * tda-workspace 冒烟门（门4 test:smoke）：T0.6 验收 1–8 载体。
 *
 *  1. 全量扫描：inventory 完整（忽略规则命中正确）、显性依赖边（import 解析）正确、
 *     supersedes-file 版本链（draft→final）正确
 *  2. G0-② 延伸：重启后 file_nodes/edges/scan_cache 完整恢复；cache 损坏
 *     backup-and-skip 后重扫可重建
 *  3. 增量：改 1 文件只重标注该文件（cache 命中），时间线恰新增两条 chunk
 *  4. 内容隔离自检：文件正文不进域/不进时间线（只进 Sidekick seam）
 *  5. 凭证自检：inventory=execution-verified、notes=model-produced；hints 只读不作固化
 *  6. 上限：超 maxFiles 触发 truncated+unfinished（显式，不静默丢文件）
 *  7. 标注失败按 partial 处理（不改写扫描终态语义，但显式记未完成）
 *  8. 同任务并发 scan 串行（排队不双跑）
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  compositeRecordKey,
  createJsonBackend,
  createTdaInvariantRegistry,
  openTdaDomain,
  type TdaDomain,
  type TdaStorageBackend,
} from '@tda/kernel';
import {
  createWorkspaceService,
  workspaceDomainSpec,
  type WorkspaceCaller,
  type WorkspaceConfig,
  type WorkspaceDeps,
  type WorkspaceService,
  type WorkspaceTables,
} from '../src/index.ts';
import { registerWorkspaceInvariants } from '../src/loadChecks.ts';
import {
  createFakeAnnotator,
  createFakeTasks,
  createFakeTimeline,
  createMemoryFs,
  createMemorySink,
  type FakeAnnotator,
  type MemoryFs,
} from './helpers.ts';

const SECRET = 'SECRET_BODY_MARKER_9f3';

const FILES: Record<string, string> = {
  '/ws/proj/spec.md': `# 协议草案\n\n${SECRET}\n\n[细节](./detail.md)\n`,
  '/ws/proj/detail.md': `# 细节\n\n字段表\n`,
  '/ws/proj/spec.draft.md': `# 旧草案\n\n废弃版本\n`,
  '/ws/proj/src/main.ts': `import { helper } from './helper';\nexport const main = () => helper();\n`,
  '/ws/proj/src/helper.ts': `export const helper = () => 1;\n`,
  '/ws/proj/.env': `TOKEN=${SECRET}\n`,
  '/ws/proj/debug.log': `${SECRET} log line\n`,
  '/ws/proj/node_modules/pkg/index.js': `module.exports = 1;\n`,
  '/ws/proj/docs/notes.md': `# 正式说明\n\n权威源\n`,
};

const caller: WorkspaceCaller = { actor: 'agent', sessionId: asSessionId('sess-ws') };

interface Fixture {
  readonly service: WorkspaceService;
  readonly domain: TdaDomain<WorkspaceTables>;
  readonly fs: MemoryFs;
  readonly annotator: FakeAnnotator;
  readonly timeline: ReturnType<typeof createFakeTimeline>;
  readonly tasks: ReturnType<typeof createFakeTasks>;
  readonly dir: string;
  readonly backend: TdaStorageBackend;
  dispose(): Promise<void>;
}

async function setup(options: {
  readonly files?: Record<string, string | { content: string; mtime: number }>;
  readonly fs?: MemoryFs;
  readonly config?: Partial<WorkspaceConfig>;
  readonly annotator?: FakeAnnotator | null;
  readonly withTimeline?: boolean;
  readonly now?: () => number;
  readonly deps?: (base: WorkspaceDeps) => WorkspaceDeps;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-ws-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(workspaceDomainSpec, { backend });
  const fs = options.fs ?? createMemoryFs(options.files ?? FILES);
  const tasks = createFakeTasks([{ id: 'task-1', localPath: 'proj' }]);
  const wired = options.annotator ?? createFakeAnnotator();
  const annotator = options.annotator === null ? undefined : wired;
  const timeline = createFakeTimeline();
  const base: WorkspaceDeps = {
    domain,
    session: createMemorySink(),
    fs,
    config: { root: '/ws', ...(options.config ?? {}) },
    taskPool: tasks.seam,
    ...(annotator !== undefined ? { annotator } : {}),
    ...(options.withTimeline === false ? {} : { timeline: timeline.seam }),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  const service = createWorkspaceService(options.deps !== undefined ? options.deps(base) : base);
  return {
    service,
    domain,
    fs,
    annotator: wired,
    timeline,
    tasks,
    dir,
    backend,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T0.6 全量扫描（验收 1）', () => {
  it('inventory 完整 + 忽略规则命中 + 显性依赖边 + supersedes 版本链', async () => {
    const fx = await setup({ annotator: null }); // 只看确定性层
    try {
      const run = await fx.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      expect(run.status).toBe('failed'); // 未装配标注 → 显式未完成（C5），但 inventory 已落
      expect(run.localPath).toBe('proj');
      const files = fx.service.files('task-1');
      const paths = files.map((file) => file.path);
      expect(paths).toEqual([
        'proj/.env',
        'proj/debug.log',
        'proj/detail.md',
        'proj/docs/notes.md',
        'proj/spec.draft.md',
        'proj/spec.md',
        'proj/src/helper.ts',
        'proj/src/main.ts',
      ]);
      // 目录级 skip：node_modules 整棵不登记
      expect(paths.some((path) => path.includes('node_modules'))).toBe(false);
      // 文件级忽略：仍登记但 ignored=true
      expect(files.find((file) => file.path === 'proj/debug.log')?.ignored).toBe(true);
      expect(files.find((file) => file.path === 'proj/.env')?.ignored).toBe(true);
      expect(files.find((file) => file.path === 'proj/spec.md')?.ignored).toBe(false);
      // 角色初判（确定性兜底）
      expect(files.find((file) => file.path === 'proj/src/main.ts')?.role).toBe('code');
      // 显性依赖边：import './helper' 解析到 src/helper.ts；markdown 链接解析到 detail.md
      const dependsOn = fx.service.edges('task-1', { kind: 'depends-on' });
      const pairs = dependsOn.map((edge) => `${edge.from}->${edge.to}`).sort();
      expect(pairs).toEqual(['proj/spec.md->proj/detail.md', 'proj/src/main.ts->proj/src/helper.ts']);
      expect(dependsOn.every((edge) => edge.confidence === 1)).toBe(true);
      // 版本链：spec.md 取代 spec.draft.md
      const supersedes = fx.service.edges('task-1', { kind: 'supersedes-file' });
      expect(supersedes.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['proj/spec.md->proj/spec.draft.md']);
      expect(supersedes[0]?.evidence).toContain('draft');
    } finally {
      await fx.dispose();
    }
  });

  it('凭证分层：inventory=execution-verified、notes=model-produced，且都弱链接到任务', async () => {
    const fx = await setup();
    try {
      await fx.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      expect(fx.timeline.chunks).toHaveLength(2);
      expect(fx.timeline.chunks[0]?.credential).toBe('execution-verified');
      expect(fx.timeline.chunks[1]?.credential).toBe('model-produced');
      for (const chunk of fx.timeline.chunks) {
        expect(chunk.source).toBe('task');
        expect(JSON.parse(chunk.content).taskId).toBe('task-1');
      }
      // hints 只读提示面，不作知识固化依据（域内无知识表：四表白名单即结构性保证）
      const hints = fx.service.hints('task-1');
      expect(hints.length).toBeGreaterThan(0);
      expect(hints.every((hint) => ['authoritative-likely', 'draft-likely', 'unknown'].includes(hint.credibilityHint))).toBe(true);
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.6 内容隔离（验收 4，C2）', () => {
  it('文件正文只进 Sidekick seam，不进域、不进时间线（零泄漏）', async () => {
    const fx = await setup({ files: FILES });
    try {
      await fx.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      const domainDump = JSON.stringify({
        nodes: fx.service.files('task-1'),
        edges: fx.service.edges('task-1'),
        runs: fx.service.runs('task-1'),
      });
      expect(domainDump).not.toContain(SECRET);
      expect(fx.timeline.chunks.map((chunk) => chunk.content).join('\n')).not.toContain(SECRET);
      // 正文确实进了子代理（否则标注无从谈起）：证据面专属，不外溢
      const heads = fx.annotator.requests.flatMap((request) => request.files.map((file) => file.head));
      expect(heads.join('\n')).toContain(SECRET);
      // 标注请求只含 path+head 两个字段（不含主上下文/任务描述/会话）
      for (const request of fx.annotator.requests) {
        expect(Object.keys(request).sort()).toEqual(['files', 'goalId', 'scanId', 'taskId']);
        for (const file of request.files) expect(Object.keys(file).sort()).toEqual(['head', 'path']);
      }
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.6 增量与 cache（验收 3）', () => {
  it('改 1 文件后只重标注该文件，时间线恰新增两条 chunk', async () => {
    const fx = await setup();
    try {
      const first = await fx.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      const firstAnnotated = fx.annotator.requests.at(-1)?.files.length ?? 0;
      expect(first.status).toBe('recorded');
      expect(firstAnnotated).toBeGreaterThan(1);

      fx.fs.put('/ws/proj/spec.md', `# 协议定稿\n\n${SECRET}\n\n[细节](./detail.md)\n`, 1_700_000_100_000);
      const second = await fx.service.scan(caller, { taskId: 'task-1' });
      expect(second.mode).toBe('incremental');
      expect(second.filesChanged).toBe(1);
      expect(fx.annotator.requests.at(-1)?.files.map((file) => file.path)).toEqual(['proj/spec.md']);
      // 时间线：每次扫描恰两条（inventory + notes）
      expect(fx.timeline.chunks).toHaveLength(4);
      expect(JSON.parse(fx.timeline.chunks[2]?.content ?? '{}')).toMatchObject({ taskId: 'task-1', filesChanged: 1 });
      // 幂等：再无变化时增量扫描零重标注（且不再向 Sidekick 发起空批注）
      const callsBefore = fx.annotator.requests.length;
      const third = await fx.service.scan(caller, { taskId: 'task-1' });
      expect(third.filesChanged).toBe(0);
      expect(fx.annotator.requests.length).toBe(callsBefore);
    } finally {
      await fx.dispose();
    }
  });

  it('cache 三级：内容变但 size/mtime 不变也能识别（contentHash 生效）', async () => {
    const fx = await setup({ files: { ...FILES, '/ws/proj/tiny.md': 'AAAA' } });
    try {
      const first = await fx.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      expect(first.filesChanged).toBeGreaterThan(0);
      // 同长替换：size 与 mtime 都不变，只有 hash 变
      const before = fx.fs.files.get('/ws/proj/tiny.md');
      fx.fs.put('/ws/proj/tiny.md', 'BBBB', before?.mtime ?? 0);
      const second = await fx.service.scan(caller, { taskId: 'task-1' });
      expect(second.filesChanged).toBe(1);
      expect(fx.annotator.requests.at(-1)?.files.map((file) => file.path)).toContain('proj/tiny.md');
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.6 重启恢复与 backup-and-skip（验收 2）', () => {
  it('重启后 file_nodes/edges/scan_cache 完整恢复，不变量门通过', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-ws-boot-'));
    const backend = createJsonBackend(dir);
    const fs = createMemoryFs(FILES);
    const tasks = createFakeTasks([{ id: 'task-1', localPath: 'proj' }]);
    try {
      const domain1 = await openTdaDomain(workspaceDomainSpec, { backend });
      const service1 = createWorkspaceService({
        domain: domain1,
        session: createMemorySink(),
        fs,
        config: { root: '/ws' },
        taskPool: tasks.seam,
        annotator: createFakeAnnotator(),
        timeline: createFakeTimeline().seam,
      });
      await service1.scan(caller, { taskId: 'task-1', mode: 'full' });
      const before = service1.files('task-1');
      await domain1.close();

      const domain2 = await openTdaDomain(workspaceDomainSpec, { backend });
      const service2 = createWorkspaceService({
        domain: domain2,
        session: createMemorySink('sess-ws-2'),
        fs,
        config: { root: '/ws' },
        taskPool: tasks.seam,
      });
      expect(service2.files('task-1')).toEqual(before);
      expect(service2.edges('task-1').length).toBeGreaterThan(0);
      expect(service2.runs('task-1')).toHaveLength(1);
      const registry = createTdaInvariantRegistry();
      const unregister = registerWorkspaceInvariants(registry, domain2, {
        taskLocalPath: () => 'proj',
      });
      await expect(registry.verify()).resolves.toBeUndefined();
      unregister();
      await domain2.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });

  it('cache 记录损坏 → backup-and-skip 跳过该行，重扫即重建（派生数据可重建）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-ws-corrupt-'));
    const backend = createJsonBackend(dir);
    const fs = createMemoryFs(FILES);
    const tasks = createFakeTasks([{ id: 'task-1', localPath: 'proj' }]);
    try {
      const domain1 = await openTdaDomain(workspaceDomainSpec, { backend });
      const service1 = createWorkspaceService({
        domain: domain1,
        session: createMemorySink(),
        fs,
        config: { root: '/ws' },
        taskPool: tasks.seam,
        annotator: createFakeAnnotator(),
        timeline: createFakeTimeline().seam,
      });
      await service1.scan(caller, { taskId: 'task-1', mode: 'full' });
      await domain1.close();

      // 注毒：把一行 cache 记录写成不合 schema 的形态
      const unit = await backend.open({ name: workspaceDomainSpec.name, version: workspaceDomainSpec.version });
      await unit.putRecord(compositeRecordKey('ws_scan_cache', 'task-1#proj/spec.md'), { corrupted: true });
      await unit.close();

      const skipped: string[] = [];
      const domain2 = await openTdaDomain(workspaceDomainSpec, {
        backend,
        onInvalidRecord: (info) => skipped.push(`${info.table}/${info.key}`),
      });
      expect(skipped).toEqual(['ws_scan_cache/task-1#proj/spec.md']);
      // 被跳过的 cache 行 → 该文件视为未缓存 → 重扫时重采集
      const service2 = createWorkspaceService({
        domain: domain2,
        session: createMemorySink('sess-ws-2'),
        fs,
        config: { root: '/ws' },
        taskPool: tasks.seam,
        annotator: createFakeAnnotator(),
        timeline: createFakeTimeline().seam,
      });
      const rescan = await service2.scan(caller, { taskId: 'task-1' });
      expect(rescan.filesChanged).toBeGreaterThan(0);
      expect(service2.files('task-1').find((file) => file.path === 'proj/spec.md')).toBeDefined();
      await domain2.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});

describe('T0.6 上限与降级（验收 6、7）', () => {
  it('maxFiles 上限命中 → truncated + unfinished（不静默丢文件）', async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) many[`/ws/proj/f${String(index).padStart(2, '0')}.md`] = `# ${index}`;
    const fx = await setup({ files: many, config: { maxFiles: 5 } });
    try {
      const run = await fx.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      expect(run.truncated).toBe(true);
      expect(run.status).toBe('failed');
      expect(run.unfinished?.some((item) => item.includes('headMaxFiles') || item.includes('proj/f'))).toBe(true);
      expect(fx.service.files('task-1')).toHaveLength(5);
    } finally {
      await fx.dispose();
    }
  });

  it('标注失败按 partial：库存仍落库，未完成显式记入 unfinished', async () => {
    const annotator = createFakeAnnotator({ ok: false, error: '结论未过 schema 校验' });
    const fx = await setup({ annotator });
    try {
      const run = await fx.service.scan(caller, { taskId: 'task-1', mode: 'full' });
      expect(run.status).toBe('failed');
      expect(run.unfinished?.join(' ')).toContain('语义标注未完成');
      expect(fx.timeline.chunks).toHaveLength(1); // 只有 inventory chunk
      expect(fx.timeline.chunks[0]?.credential).toBe('execution-verified');
    } finally {
      await fx.dispose();
    }
  });

  it('无 localPath 的任务拒绝扫描（扫描根锚定 T0.2 localPath）', async () => {
    const fx = await setup();
    try {
      fx.tasks.tasks.set('task-bare', {
        id: 'task-bare',
        revision: 0,
        goalId: 'goal-1',
        phase: 'active',
        writeScopes: [],
      });
      await expect(fx.service.scan(caller, { taskId: 'task-bare' })).rejects.toMatchObject({
        code: 'WORKSPACE_NO_LOCAL_PATH',
      });
    } finally {
      await fx.dispose();
    }
  });

  it('符号链接逃逸 workspace 即拒（realpath 前缀判定）', async () => {
    const escapeFs = createMemoryFs(FILES, { escapeAt: '/ws/proj', escapeTo: '/outside/elsewhere' });
    const fx = await setup({ fs: escapeFs });
    try {
      await expect(fx.service.scan(caller, { taskId: 'task-1' })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.6 并发串行（验收 8）', () => {
  it('同任务并发 scan 串行：第二个排队，不双跑', async () => {
    const base = createMemoryFs(FILES);
    let concurrent = 0;
    let maxConcurrent = 0;
    const wrapped: MemoryFs = {
      ...base,
      async walk(root, options) {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await base.walk(root, options);
        concurrent -= 1;
        return result;
      },
    };
    const fx = await setup({ fs: wrapped });
    try {
      const [a, b] = await Promise.all([
        fx.service.scan(caller, { taskId: 'task-1', mode: 'full' }),
        fx.service.scan(caller, { taskId: 'task-1', mode: 'full' }),
      ]);
      expect(maxConcurrent).toBe(1);
      expect(String(a.id)).not.toBe(String(b.id));
      expect(fx.service.runs('task-1')).toHaveLength(2);
    } finally {
      await fx.dispose();
    }
  });
});
