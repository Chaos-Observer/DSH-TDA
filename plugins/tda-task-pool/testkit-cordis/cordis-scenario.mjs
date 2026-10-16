/**
 * P5.4 cordis 真装配场景（子进程 node --experimental-transform-types 直跑——
 * cordis Service 用参数属性，strip-only 不可加载）。
 *
 * 证明面：**真 cordis Context** 装配 tda-task-pool 工具入口（static inject 解析
 * → Service provide → 服务就绪）→ 9 工具 ToolSchema 投影 → 经容器执行真任务树
 * （建任务自动待批 / 未批准不可认领 / 模型自批被拦 / CAS STALE / 参数门 / 保留名）
 * → 双写对账全过。
 */
import assert from 'node:assert/strict';
import { asSessionId, createJsonBackend, createTdaInvariantRegistry } from '@tda/kernel';
import { createFileSessionSink } from '@tda/testkit';
import { Context } from '@deepseek-ai/cordis';
import { tdaTaskPoolPlugin, TASK_POOL_TOOL_NAMES } from '../src/index.ts';
import { TdaTaskPoolDepsService, TdaTaskPoolToolsService } from '../src/dsh.ts';
import { createDshToolRegistry } from '../src/dshTools.ts';

const dir = process.argv[2];
const backend = createJsonBackend(dir);
const invariants = createTdaInvariantRegistry();
const sink = createFileSessionSink(dir + '/session.jsonl', asSessionId('sess-cordis'));
const handle = await tdaTaskPoolPlugin.apply({ storage: backend, invariants, session: sink, now: () => 1700000000000 });

// ── 真 cordis 容器：依赖注入点 + 工具入口 ──
const ctx = new Context();
ctx.plugin(TdaTaskPoolDepsService, { taskPool: handle.service, sessionId: () => 'sess-cordis' });
ctx.plugin(TdaTaskPoolToolsService);

// cordis fiber 微任务序：等服务面就绪（3s 帽）
let tools;
for (let i = 0; i < 300 && tools === undefined; i += 1) {
  tools = ctx.tdaTaskPoolTools;
  if (tools === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.ok(tools !== undefined, 'tdaTaskPoolTools 未在 3s 内就绪');
assert.deepEqual([...tools.toolNames].sort(), [...TASK_POOL_TOOL_NAMES].sort());
assert.equal(tools.definitions.length, 9);

// ── 模型可见投影：9 工具 ToolSchema（name/description/parameters）──
const list = tools.registry.list();
assert.equal(list.length, 9);
assert.deepEqual([...list.map((tool) => tool.name)].sort(), [...TASK_POOL_TOOL_NAMES].sort());
for (const tool of list) {
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.length > 0);
  assert.equal(tool.parameters.type, 'object');
}

const exec = (callId, name) => ({
  callId,
  name,
  arguments: {},
  signal: new AbortController().signal,
  agent: { session: { id: 'sess-cordis' } },
});

// ── 1) agent 建任务 → 自动待批（J9：模型创建即提议）──
const created = await tools.registry.execute(
  'task_create',
  { goalId: 'goal-1', subject: 'cordis 工具面任务' },
  exec('call-1', 'task_create'),
);
assert.equal(created.proposalStatus, 'pending_approval');
assert.equal(typeof created.revision, 'number');

// ── 2) 定义侧参数门：缺必填 / enum 越界（先于 handler）──
await assert.rejects(
  () => tools.registry.execute('task_create', { subject: 'x' }, exec('call-2', 'task_create')),
  (error) => error.code === 'TOOL_INVALID_ARGS',
);
await assert.rejects(
  () => tools.registry.execute('task_edit', { taskId: created.id, expectedRevision: created.revision, stage: 'bogus' }, exec('call-3', 'task_edit')),
  (error) => error.code === 'TOOL_INVALID_ARGS',
);

// ── 3) 未批准不可认领（工具面直撞 J9）──
await assert.rejects(
  () => tools.registry.execute('task_claim', { taskId: created.id, expectedRevision: created.revision }, exec('call-4', 'task_claim')),
  (error) => error.code === 'TASK_NOT_APPROVED',
);

// ── 4) 模型自批被硬拦（approve 仅人类/Lead）──
await assert.rejects(
  () => tools.registry.execute('task_approve', { taskId: created.id, expectedRevision: created.revision, approve: true }, exec('call-5', 'task_approve')),
  (error) => error.code === 'TASK_APPROVAL_FORBIDDEN',
);

// ── 5) 人类面批准（工具面调用者恒 agent，审批走服务面）→ ready → 工具认领 → 完成 ──
const approved = await handle.service.approveProposal('human', created.id, { expectedRevision: created.revision }, true);
const claimed = await tools.registry.execute(
  'task_claim',
  { taskId: created.id, expectedRevision: approved.revision },
  exec('call-6', 'task_claim'),
);
assert.equal(claimed.phase, 'active');
assert.equal(String(claimed.ownerId), 'sess-cordis');
const done = await tools.registry.execute(
  'task_complete',
  { taskId: created.id, expectedRevision: claimed.revision, outcome: 'success', evidence: ['cordis-face'] },
  exec('call-7', 'task_complete'),
);
assert.equal(done.phase, 'complete');
assert.equal(done.outcome, 'success');

// ── 6) CAS STALE 经工具面显式失败 ──
await assert.rejects(
  () => tools.registry.execute('task_edit', { taskId: created.id, expectedRevision: 1, subject: 'stale' }, exec('call-8', 'task_edit')),
  (error) => error.code === 'STALE_REVISION',
);

// ── 7) 未知工具 / 保留名 / 重名（ToolRuntime.register 语义镜像）──
await assert.rejects(
  () => tools.registry.execute('nope', {}, exec('call-9', 'nope')),
  (error) => error.code === 'TOOL_UNKNOWN',
);
const probeRegistry = createDshToolRegistry();
const probeDefinition = { name: 'probe', description: 'x', parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) };
const disposeProbe = probeRegistry.register(probeDefinition);
assert.ok(probeRegistry.has('probe'));
assert.throws(
  () => probeRegistry.register({ ...probeDefinition, name: 'run_code' }),
  /保留/,
  'run_code 保留名必须拒绝',
);
assert.throws(
  () => probeRegistry.register({ ...probeDefinition }),
  /重名/,
  '重名注册必须拒绝',
);
assert.throws(
  () => probeRegistry.register({ name: 'no-output', description: 'x', parameters: {}, execute: async () => ({}) }),
  /must declare output/,
  '缺 output.render 必须按 ToolRuntime 同文案拒绝',
);
// disposer 精确反注册：dispose 后可重注册，再注册又撞重名
disposeProbe();
assert.ok(!probeRegistry.has('probe'));
probeRegistry.register({ ...probeDefinition });
assert.ok(probeRegistry.has('probe'));
assert.throws(() => probeRegistry.register({ ...probeDefinition }), /重名/);

// ── 双写对账 + 不变量全过 ──
await invariants.verify();
console.log('CORDIS-GATE-OK');
process.exit(0);
