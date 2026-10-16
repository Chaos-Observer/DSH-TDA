/**
 * P5.4 插件门：任务池 9 工具 × DSH 工具契约（直传 + 注册宿主 + cordis 真装配）。
 *
 * 分层：
 *  - 本文件（进程内）：直传适配器语义——validateJsonSchemaSubset 子集门、
 *    callerFromExec、ToolSchema 投影形状（与 DSH ToolDefinition 契约对照）；
 *  - testkit-cordis/cordis-scenario.mjs（子进程 --experimental-transform-types）：
 *    **真 cordis Context** 装配入口 → 服务注入 → 9 工具经容器执行真任务树。
 *
 * 换真边界：defineTool/ToolRuntime 本体被 dsh-llm @Remote 装饰器链挡死
 * （SyntaxError 实证），本体随 DSH 宿主/发货态产物接管；此处交付的是
 * "ctx.tools.register 零改动可收"的直传面 + register 语义镜像宿主。
 */
import { mkdtempSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  callerFromExec,
  createDshToolRegistry,
  toDshToolDefinition,
  validateJsonSchemaSubset,
  RUN_CODE_RESERVED_NAME,
  type DshToolRunContext,
} from '../src/dshTools.ts';

const runtimeDir = fileURLToPath(new URL('../testkit-cordis/', import.meta.url));

const EXEC: DshToolRunContext = {
  callId: 'call-1',
  name: 'task_create',
  arguments: {},
  signal: new AbortController().signal,
  agent: { session: { id: 'sess-agent' } },
};

describe('P5.4 JSON Schema 子集门（9 工具 parameters 特征面）', () => {
  const schema = {
    type: 'object',
    required: ['taskId', 'expectedRevision'],
    properties: {
      taskId: { type: 'string' },
      expectedRevision: { type: 'number' },
      stage: { type: 'string', enum: ['planning', 'executing', 'waiting', 'verifying'] },
      evidence: { type: 'array', items: { type: 'string' } },
      approve: { type: 'boolean' },
    },
  };

  it('required / enum / items / 类型面全命中；路径限定违规清单', () => {
    expect(validateJsonSchemaSubset(schema, { taskId: 't', expectedRevision: 1 }, '')).toEqual([]);
    expect(validateJsonSchemaSubset(schema, { taskId: 't' }, '')).toEqual(['expectedRevision 必填']);
    expect(
      validateJsonSchemaSubset(schema, { taskId: 't', expectedRevision: 'x' }, ''),
    ).toEqual(['expectedRevision 必须是 number']);
    expect(
      validateJsonSchemaSubset(schema, { taskId: 't', expectedRevision: 1, stage: 'bogus' }, ''),
    ).toEqual(["stage 必须是 enum 之一（\"planning\"/\"executing\"/\"waiting\"/\"verifying\"）"]);
    expect(
      validateJsonSchemaSubset(schema, { taskId: 't', expectedRevision: 1, evidence: ['a', 2] }, ''),
    ).toEqual(['evidence.1 必须是 string']);
    expect(validateJsonSchemaSubset(schema, 'not-an-object', '')).toEqual(['(root) 必须是 object']);
  });
});

describe('P5.4 直传适配 + 注册宿主（ToolRuntime 语义镜像）', () => {
  it('ToolDefinition 形状：name/description/parameters 直传，output.render 为 Native 文本投影', async () => {
    const def = {
      name: 'task_get' as const,
      description: '读取任务视图。',
      parameters: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
      handler: async () => ({ id: 'task-1', revision: 2 }),
    };
    const definition = toDshToolDefinition(def);
    expect(definition.name).toBe('task_get');
    expect(definition.parameters).toBe(def.parameters); // 直传（零拷贝）
    expect(typeof definition.output.render).toBe('function');
    const rendered = definition.output.render({}, { id: 'task-1' });
    expect(rendered).toEqual([{ type: 'text', text: '{"id":"task-1"}' }]);
    // execute：参数门 → handler → output 门
    await expect(definition.execute({ taskId: 'task-1' }, EXEC)).resolves.toEqual({ id: 'task-1', revision: 2 });
    await expect(definition.execute({}, EXEC)).rejects.toMatchObject({ code: 'TOOL_INVALID_ARGS' });
  });

  it('callerFromExec：exec.agent.session.id → actor=agent；缺失显式失败', () => {
    expect(callerFromExec(EXEC)).toEqual({ actor: 'agent', sessionId: 'sess-agent' });
    const noAgent: DshToolRunContext = { callId: 'call-x', name: 'task_get', arguments: {}, signal: new AbortController().signal };
    expect(() => callerFromExec(noAgent)).toThrowError(/TOOL_CALLER_UNRESOLVED|session\.id/);
  });

  it('register 门：重名拒绝 / run_code 保留 / 缺 output.render 同文案 TypeError / disposer 精确', () => {
    const registry = createDshToolRegistry();
    const def = {
      name: 'task_get',
      description: 'x',
      parameters: {},
      output: { schema: {}, render: () => [] },
      execute: async () => ({}),
    };
    const dispose = registry.register(def);
    expect(registry.names).toEqual(['task_get']);
    expect(() => registry.register({ ...def })).toThrowError(/重名/);
    expect(() => registry.register({ ...def, name: RUN_CODE_RESERVED_NAME })).toThrowError(/保留/);
    expect(() =>
      registry.register({ name: 'bad', description: 'x', parameters: {}, execute: async () => ({}) } as never),
    ).toThrowError(TypeError);
    expect(() =>
      registry.register({ name: 'bad', description: 'x', parameters: {}, execute: async () => ({}) } as never),
    ).toThrowError('tool "bad" must declare output { schema, render, presentationMeta? }');
    dispose();
    expect(registry.has('task_get')).toBe(false);
  });

  it('list() 投影 = ToolSchema 面（name/description/parameters）；未知名显式失败', async () => {
    const registry = createDshToolRegistry();
    registry.register({
      name: 'task_list',
      description: '列出任务。',
      parameters: { type: 'object', properties: {} },
      output: { schema: {}, render: () => [] },
      execute: async () => ({}),
    });
    expect(registry.list()).toEqual([
      { name: 'task_list', description: '列出任务。', parameters: { type: 'object', properties: {} } },
    ]);
    await expect(registry.execute('nope', {}, EXEC)).rejects.toMatchObject({ code: 'TOOL_UNKNOWN' });
  });
});

describe('P5.4 cordis 真装配（子进程 --experimental-transform-types）', () => {
  it('真 cordis Context：static inject 解析 → 9 工具 ToolSchema → 经容器执行真任务树', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-p54-cordis-'));
    const run = spawnSync(
      process.execPath,
      ['--experimental-transform-types', join(runtimeDir, 'cordis-scenario.mjs'), dir],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CI: '1' } },
    );
    const ok = run.status === 0 && (run.stdout ?? '').includes('CORDIS-GATE-OK');
    try {
      expect(ok).toBe(true);
    } finally {
      if (!ok) {
        console.error(['cordis 场景失败 exit='.concat(String(run.status)), run.stdout, run.stderr].join(String.fromCharCode(10)));
      }
      // [test-rm-bypass] detached 子进程清理（不占 libuv 线程池）
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    }
  }, 90_000);
});

describe('P5.6 loader 真挂载（行 → 模块解析 → apply(config) → 服务面自检）', () => {
  it('真 Loader+Include 把 tda-task-pool 行挂成可服务（子进程 transform-types）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tda-p56-loader-'));
    const scenario = join(runtimeDir, 'loader-mount.mjs');
    const run = spawnSync(
      process.execPath,
      ['--experimental-transform-types', scenario, dir],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CI: '1' } },
    );
    const ok = run.status === 0 && (run.stdout ?? '').includes('LOADER-MOUNT-OK');
    try {
      expect(ok).toBe(true);
    } finally {
      if (!ok) {
        console.error(['loader-mount 失败 exit='.concat(String(run.status)), run.stdout, run.stderr].join(String.fromCharCode(10)));
      }
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    }
  }, 150_000);
});
