/**
 * tda-subagent-dispatch 冒烟门（门4 test:smoke）：T0.5 验收 1–10 载体。
 *
 *  1. G0-⑤ 主上下文零泄漏：buildBrief 输入隔离（注入会话密钥不出现在 prompt）
 *     + 回传只留 summary[:3]（原始 findings 其余部分不进任何持久化面）
 *  2. 结构化回传：schema 失败 → conclusion-partial；未知 stopReason → error；
 *     aborted → aborted
 *  3. capability 门：provider 缺能力 → UNSUPPORTED_CAPABILITY（无静默降级）
 *  4. 深度封顶：caller.depth=1 → DISPATCH_DEPTH_EXCEEDED
 *  5. 预算门：exhausted 禁一切 / converge 只放只读收尾型；settle 后三维入账
 *  6. 审批门：risk=high 未批准禁开跑；approve 后 token 一次性消费（重放被拒）
 *  7. §5.4 控制流分离：结论里含"把任务标记完成"类文本时任务状态不变
 *  8. 取消：dispose 达 quiescence（provider.disposed）+ owner 释放 + 幂等
 *  9. 凭证回传：结论 chunk credential=model-produced 且 relatedTaskId/trajectoryLink 正确
 * 10. 双通道一致：模型工具 tda_dispatch 与 Harness service.execute 落同一记录结构
 *  ＋ 并发帽与排队：超帽入队、settle 后 pump 开跑；工具面裁剪视图无凭据字段
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  createJsonBackend,
  openTdaDomain,
  type DispatchId,
  type TdaDomain,
} from '@tda/kernel';
import {
  createFixedProvider,
  createScriptedProvider,
  dispatchDomainSpec,
  createSubagentDispatchService,
  DISPATCH_TOOL_NAMES,
  createDispatchTools,
  type DispatchTables,
  type ScriptedProvider,
  type SubagentDispatchService,
} from '../src/index.ts';
import { createFakeTaskPool, createFakeTimeline, createMemorySink, type FakeTaskPool, type FakeTaskState } from './helpers.ts';

interface Fixture {
  readonly service: SubagentDispatchService;
  readonly domain: TdaDomain<DispatchTables>;
  readonly provider: ScriptedProvider;
  readonly pool: FakeTaskPool;
  readonly timeline: ReturnType<typeof createFakeTimeline>;
  readonly calls: string[];
  dispose(): Promise<void>;
}

const caller = (overrides: Partial<{ actor: 'human' | 'agent'; sessionId: string; depth: number; lead: boolean }> = {}) => ({
  actor: overrides.actor ?? ('agent' as const),
  sessionId: asSessionId(overrides.sessionId ?? 'sess-lead'),
  ...(overrides.depth !== undefined ? { depth: overrides.depth } : {}),
  ...(overrides.lead !== undefined ? { lead: overrides.lead } : {}),
});

async function setup(options: {
  readonly tasks?: Partial<FakeTaskState> | readonly Partial<FakeTaskState>[];
  readonly provider?: ScriptedProvider;
  readonly maxParallel?: number;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-dispatch-'));
  const backend = createJsonBackend(dir);
  const domain = await openTdaDomain(dispatchDomainSpec, { backend });
  const sink = createMemorySink();
  const pool = createFakeTaskPool(options.tasks ?? {});
  const timeline = createFakeTimeline();
  const provider = options.provider ?? createFixedProvider({ findings: ['ok'], confidence: 1 });
  let now = 1_700_000_000_000;
  const service = createSubagentDispatchService({
    domain,
    session: sink,
    provider,
    taskPool: pool.seam,
    timeline: timeline.seam,
    now: () => now,
    ...(options.maxParallel !== undefined ? { maxParallel: options.maxParallel } : {}),
  });
  return {
    service,
    domain,
    provider,
    pool,
    timeline,
    calls: pool.calls,
    async dispose() {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}

describe('T0.5 派发门五检', () => {
  it('capability 门 fail-loud：provider 缺 outputSchema 能力即拒（不静默降级）', async () => {
    const fx = await setup({ provider: createScriptedProvider({ capabilities: { outputSchema: false } }) });
    try {
      await expect(
        fx.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'sidekick' }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    } finally {
      await fx.dispose();
    }
  });

  it('深度封顶：depth=1 的目标会话不得建单', async () => {
    const fx = await setup();
    try {
      await expect(
        fx.service.dispatch(caller({ depth: 1 }), { taskId: 'task-1' as never, role: 'sidekick' }),
      ).rejects.toMatchObject({ code: 'DISPATCH_DEPTH_EXCEEDED' });
    } finally {
      await fx.dispose();
    }
  });

  it('任务门：非 active / 提议未批准 / 已被他人认领均拒派', async () => {
    const paused = await setup({ tasks: { phase: 'paused' } });
    try {
      await expect(paused.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'sidekick' })).rejects.toMatchObject({
        code: 'DISPATCH_TASK_NOT_ACTIVE',
      });
    } finally {
      await paused.dispose();
    }
    const unapproved = await setup({ tasks: { proposal: { status: 'pending_approval' } } });
    try {
      await expect(
        unapproved.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'sidekick' }),
      ).rejects.toMatchObject({ code: 'DISPATCH_TASK_UNAPPROVED' });
    } finally {
      await unapproved.dispose();
    }
    const owned = await setup({ tasks: { ownerId: 'sess-other' } });
    try {
      await expect(owned.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'sidekick' })).rejects.toMatchObject({
        code: 'DISPATCH_TASK_OWNED',
      });
    } finally {
      await owned.dispose();
    }
  });

  it('预算三区：exhausted 禁一切；converge 只放行只读收尾型（Lead 写入型被拒）', async () => {
    const exhausted = await setup({ tasks: { budget: { zone: 'exhausted', consumed: { tokens: 0, toolCalls: 0, wallClockMs: 0, attentionUnits: 0 } } } });
    try {
      await expect(
        exhausted.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'sidekick' }),
      ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    } finally {
      await exhausted.dispose();
    }
    const converge = await setup({ tasks: { budget: { zone: 'converge', consumed: { tokens: 0, toolCalls: 0, wallClockMs: 0, attentionUnits: 0 } } } });
    try {
      // Sidekick 只读侦察 = 收尾型：放行
      await expect(converge.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'sidekick' })).resolves.toMatchObject({
        status: 'approved',
      });
      // Lead 的 sandbox=workspace-write = 写入型：收敛区拒
      await expect(converge.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'lead' })).rejects.toMatchObject({
        code: 'BUDGET_CONVERGE',
      });
    } finally {
      await converge.dispose();
    }
  });
});

describe('T0.5 输入隔离（G0-⑤ 主项）', () => {
  it('buildBrief 只读任务白名单字段：会话密钥/owner 不出现在 prompt', async () => {
    const fx = await setup({ tasks: { ownerId: 'sess-secret-xyz' } });
    try {
      const task = fx.pool.task;
      const brief = fx.service.buildBrief(task, 'sidekick');
      const text = brief.prompt.map((block) => block.text).join('\n');
      expect(text).toContain(task.subject);
      expect(text).toContain(task.description);
      expect(text).not.toContain('sess-secret-xyz');
      expect(text).not.toContain('ownerId');
      expect(text).not.toContain('budget');
      expect(brief.outputSchemaId).toBe('sidekick-conclusion');
      expect(brief.promptHash).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      await fx.dispose();
    }
  });

  it('回传只留 summary[:3]：主上下文面零泄漏，结论正文只落时间线（可溯）', async () => {
    const fx = await setup({
      provider: createFixedProvider({
        findings: ['f1', 'f2', 'f3', 'f4-secret', 'f5-secret'],
        confidence: 0.7,
      }),
    });
    try {
      const order = await fx.service.execute(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      expect(order.result?.outcome).toBe('conclusion');
      expect(order.result?.summary?.findings).toEqual(['f1', 'f2', 'f3']);

      // 主上下文面 = dispatch 记录 + ConclusionView：被裁掉的原始发现不得出现
      const view = fx.service.conclusionOf(order.id);
      expect(view?.findings).toEqual(['f1', 'f2', 'f3']);
      const surface = JSON.stringify(order) + JSON.stringify(view);
      expect(surface).not.toContain('f4-secret');
      expect(surface).not.toContain('f5-secret');

      // 设计边界：结论正文刻意落时间线（credential=model-produced，供溯源/召回侧凭证筛选），
      // 它与"主上下文零泄漏"不冲突——泄漏判据是主 surface，不是审计总线
      expect(fx.timeline.chunks[0]?.content).toContain('f4-secret');
      expect(fx.timeline.chunks[0]?.credential).toBe('model-produced');
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.5 结构化回传与凭证', () => {
  it('schema 失败 → conclusion-partial；未知 stopReason → error；aborted → aborted', async () => {
    const partial = await setup({
      provider: createScriptedProvider({ respond: () => ({ stopReason: 'completed', structured: { findings: 'not-an-array', confidence: 3 } }) }),
    });
    try {
      const order = await partial.service.execute(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      expect(order.result?.outcome).toBe('conclusion-partial');
      expect(order.result?.summary).toBeDefined();
    } finally {
      await partial.dispose();
    }

    const errored = await setup({
      provider: createScriptedProvider({ respond: () => ({ stopReason: 'blew-up-somehow', structured: { findings: [], confidence: 1 } }) }),
    });
    try {
      const order = await errored.service.execute(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      expect(order.result?.outcome).toBe('error');
      expect(order.result?.conclusionEntryId).toBeUndefined();
    } finally {
      await errored.dispose();
    }

    const aborted = await setup({
      provider: createScriptedProvider({ respond: () => ({ stopReason: 'aborted' }) }),
    });
    try {
      const order = await aborted.service.execute(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      expect(order.result?.outcome).toBe('aborted');
      expect(aborted.timeline.chunks).toHaveLength(0);
    } finally {
      await aborted.dispose();
    }
  });

  it('结论回传双落点：时间线 chunk credential=model-produced、relatedTaskId/trajectoryLink 正确', async () => {
    const fx = await setup({ provider: createFixedProvider({ findings: ['证据'], confidence: 0.5 }) });
    try {
      const order = await fx.service.execute(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      expect(fx.timeline.chunks).toHaveLength(1);
      const chunk = fx.timeline.chunks[0];
      expect(chunk?.credential).toBe('model-produced');
      expect(chunk?.source).toBe('task');
      expect(chunk?.relatedTaskId).toBe('task-1');
      expect(chunk?.trajectoryLink).toBe(String(order.childSessionId));
      expect(order.result?.conclusionEntryId).toMatch(/^tl-\d+$/);
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.5 审批门（J9）', () => {
  it('risk=high（Lead/workspace-write）未批准禁开跑；approve 后 token 一次性消费', async () => {
    const fx = await setup();
    try {
      const order = await fx.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'lead' });
      expect(order.risk).toBe('high');
      expect(order.status).toBe('requested');
      expect(order.approval?.status).toBe('pending');
      await expect(fx.service.start(caller(), order.id, { expectedRevision: order.revision })).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
      });

      // 非人类/非 Lead 代行不得批准
      await expect(
        fx.service.approve(caller(), order.id, { expectedRevision: order.revision }),
      ).rejects.toMatchObject({ code: 'DISPATCH_APPROVAL_FORBIDDEN' });

      const approved = await fx.service.approve(caller({ actor: 'human', lead: true }), order.id, {
        expectedRevision: order.revision,
      });
      expect(approved.approval?.token).toBeDefined();
      expect(approved.approval?.consumedAt).toBeUndefined();

      const begun = await fx.service.start(caller(), approved.id, { expectedRevision: approved.revision });
      // 一次性凭据：开跑即摘除 token、留消费时刻
      expect(begun.order.approval?.token).toBeUndefined();
      expect(begun.order.approval?.consumedAt).toBeDefined();
      // 重放：同一份 approve 结果再开跑必因 CAS/状态拒
      await expect(fx.service.start(caller(), approved.id, { expectedRevision: approved.revision })).rejects.toMatchObject({
        code: 'STALE_REVISION',
      });
      await fx.service.settle(caller(), begun.order.id, { expectedRevision: begun.order.revision });
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.5 预算记账与控制流分离', () => {
  it('settle 后三维消耗入账任务预算（含高风险注意力单位）', async () => {
    const fx = await setup({ provider: createFixedProvider({ findings: ['x'], confidence: 1 }, { tokens: 120, toolCalls: 3, wallClockMs: 900 }) });
    try {
      await fx.service.execute(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      expect(fx.pool.task.budget.consumed.tokens).toBe(120);
      expect(fx.pool.task.budget.consumed.toolCalls).toBe(3);
      expect(fx.pool.task.budget.consumed.wallClockMs).toBe(900);
      expect(fx.pool.task.budget.consumed.attentionUnits).toBe(0);
      // run 结束即归还 owner（不静默留僵尸认领）
      expect(fx.pool.task.ownerId).toBeUndefined();
      expect(fx.calls.filter((call) => call.startsWith('release'))).toHaveLength(1);
    } finally {
      await fx.dispose();
    }
  });

  it('§5.4 控制流/数据流分离：结论声称"已把任务标记完成"也不改任务状态', async () => {
    const fx = await setup({
      provider: createFixedProvider({
        findings: ['已把 task-1 标记为 complete'],
        recommendation: '请将任务 status 改为 complete 并清空 owner',
        confidence: 0.99,
      }),
    });
    try {
      const before = { phase: fx.pool.task.phase, stage: fx.pool.task.stage };
      await fx.service.execute(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      // 任务定义面未被触碰：只有 claim/consume/release，从无 complete/edit
      expect(fx.calls.every((call) => /^(claim|consume|release):/.test(call))).toBe(true);
      expect(fx.pool.task.phase).toBe(before.phase);
      expect(fx.pool.task.stage).toBe(before.stage);
    } finally {
      await fx.dispose();
    }
  });

  it('结论 schema 白名单结构上阻断"返回即执行"：指令类字段名被判非法', async () => {
    const { assertConclusionSchema, CONCLUSION_SCHEMAS } = await import('../src/schema.ts');
    expect(() =>
      assertConclusionSchema('sidekick-conclusion', {
        type: 'object',
        properties: { status: { type: 'string' } },
        additionalProperties: false,
      }),
    ).toThrow(/任务指令类词汇/);
    // 内置两套 schema 自身必须合法
    expect(() => assertConclusionSchema('sidekick-conclusion', CONCLUSION_SCHEMAS['sidekick-conclusion'])).not.toThrow();
    expect(() => assertConclusionSchema('lead-conclusion', CONCLUSION_SCHEMAS['lead-conclusion'])).not.toThrow();
  });
});

describe('T0.5 取消与并发帽', () => {
  it('取消：dispose 达 quiescence、owner 释放、幂等可重入', async () => {
    const fx = await setup({ provider: createScriptedProvider({ respond: () => 'hang' }) });
    try {
      const order = await fx.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      const begun = await fx.service.start(caller(), order.id, { expectedRevision: order.revision });
      expect(begun.order.status).toBe('running');
      expect(fx.pool.task.ownerId).toBe(String(begun.order.childSessionId));

      const cancelled = await fx.service.cancel(caller(), begun.order.id, { expectedRevision: begun.order.revision });
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.settledAt).toBeDefined();
      expect(fx.provider.disposed).toEqual([String(begun.order.childSessionId)]);
      expect(fx.pool.task.ownerId).toBeUndefined();

      // 幂等：终态再取消返回原单，不抛、不重复 dispose
      const again = await fx.service.cancel(caller(), cancelled.id, { expectedRevision: cancelled.revision });
      expect(again.revision).toBe(cancelled.revision);
      expect(fx.provider.disposed).toHaveLength(1);
    } finally {
      await fx.dispose();
    }
  });

  it('并发帽：超帽入队（不拒任务），settle 后 pump 开跑；排队序按 priority 降', async () => {
    const fx = await setup({
      tasks: [
        { id: 'task-1', priority: 1 },
        { id: 'task-2', priority: 9 },
      ],
      maxParallel: 1,
      provider: createFixedProvider({ findings: ['ok'], confidence: 1 }),
    });
    try {
      const first = await fx.service.dispatch(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      const begun = await fx.service.start(caller(), first.id, { expectedRevision: first.revision });
      expect(begun.started).toBe(true);

      const second = await fx.service.dispatch(caller(), { taskId: 'task-2' as never, role: 'sidekick' });
      const queued = await fx.service.start(caller(), second.id, { expectedRevision: second.revision });
      expect(queued.queued).toBe(true);
      expect(queued.started).toBe(false);
      expect(fx.service.queued()).toEqual([second.id]);

      await fx.service.settle(caller(), begun.order.id, { expectedRevision: begun.order.revision });
      const pumped = await fx.service.pump(caller());
      expect(pumped).toHaveLength(1);
      expect(pumped[0]?.order.taskId).toBe('task-2');
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.5 双通道一致与工具面', () => {
  it('模型工具 tda_dispatch 与 Harness service.execute 落同一记录结构（仅参数面不同）', async () => {
    const fx = await setup();
    try {
      const tools = createDispatchTools(fx.service);
      expect(tools.map((tool) => tool.name)).toEqual([...DISPATCH_TOOL_NAMES]);

      const dispatchTool = tools[0]!;
      const viaTool = (await dispatchTool.call({ actor: 'agent', sessionId: 'sess-lead' }, { taskId: 'task-1', role: 'sidekick' })) as {
        id: string;
        status: string;
        risk: string;
      };
      const viaService = await fx.service.execute(caller(), { taskId: 'task-1' as never, role: 'sidekick' });

      const toolOrder = fx.service.get(viaTool.id as DispatchId);
      expect(toolOrder?.outputSchemaId).toBe(viaService.outputSchemaId);
      expect(toolOrder?.maxDepth).toBe(viaService.maxDepth);
      expect(toolOrder?.toolFilter).toEqual(viaService.toolFilter);
      expect(toolOrder?.mode).toBe('spawn');
      // 裁剪视图不含凭据/agentOptions/promptHash
      expect(Object.keys(viaTool).sort()).toEqual(['ageMs', 'id', 'outcome', 'risk', 'role', 'status', 'taskId']);
    } finally {
      await fx.dispose();
    }
  });

  it('工具参数只有 taskId+role（无自由文本字段），越权与非法 role 被拒', async () => {
    const fx = await setup();
    try {
      const tools = createDispatchTools(fx.service);
      const dispatchTool = tools[0]!;
      expect(dispatchTool.inputSchema.required).toEqual(['taskId', 'role']);
      expect(Object.keys(dispatchTool.inputSchema.properties).sort()).toEqual(['role', 'taskId']);
      await expect(dispatchTool.call({ actor: 'agent', sessionId: 's' }, { taskId: 'task-1', role: 'root' })).rejects.toMatchObject({
        code: 'TOOL_ARGS_INVALID',
      });
      await expect(dispatchTool.call({ actor: 'agent', sessionId: 's' }, { taskId: '', role: 'sidekick' })).rejects.toMatchObject({
        code: 'TOOL_ARGS_INVALID',
      });
    } finally {
      await fx.dispose();
    }
  });
});

describe('T0.5 孤儿单显式终态（C5）', () => {
  it('在途单经 reconcileOrphans 落 error+orphaned，且 owner 归还', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tda-dispatch-orphan-'));
    const backend = createJsonBackend(dir);
    try {
      const domain = await openTdaDomain(dispatchDomainSpec, { backend });
      const pool = createFakeTaskPool();
      const provider = createScriptedProvider({ respond: () => 'hang' });
      const sink = createMemorySink();
      const options = { domain, session: sink, provider, taskPool: pool.seam };
      const first = createSubagentDispatchService(options);
      const order = await first.dispatch(caller(), { taskId: 'task-1' as never, role: 'sidekick' });
      const begun = await first.start(caller(), order.id, { expectedRevision: order.revision });
      expect(begun.order.status).toBe('running');
      await domain.close();

      // 重启：同一介质重开域，新服务实例对在途单收口
      const domain2 = await openTdaDomain(dispatchDomainSpec, { backend });
      const revived = createSubagentDispatchService({ ...options, domain: domain2 });
      const settled = await revived.reconcileOrphans();
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('settled');
      expect(settled[0]?.result?.outcome).toBe('error');
      expect(settled[0]?.result?.orphaned).toBe(true);
      expect((await revived.get(order.id))?.settledAt).toBeDefined();
      // 幂等：再次收口无事可做
      expect(await revived.reconcileOrphans()).toHaveLength(0);
      await domain2.close();
    } finally {
      await backend.close();
      // [test-rm-bypass] OS 删除路径间歇挂起，fire-and-forget（临时目录留待统一清理）
        // [test-rm-bypass] detached 子进程清理：OS 删除路径间歇挂起期间不占用 libuv 线程池
  spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    }
  });
});
