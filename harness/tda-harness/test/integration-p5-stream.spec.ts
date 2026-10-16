/**
 * P5.3 集成门：执行环端到端跑在 **DSH StreamChunk 真通道** 上。
 *
 * 与 integration-p4（scripted provider 直返结论）的差别：本门把派发执行通道
 * 换成 `createDshStreamProvider`——结论经 chunk 流（block-start → delta →
 * block-end → usage → finish）由 **DSH 真 BlockAssembler** 组装、适配器提取
 * JSON 后过 dispatch J4 门。两个变体：
 *  1. scripted stream face（协议可执行规格，确定性）；
 *  2. **真 wire**：OpenAI 兼容 chat/completions SSE（本机回环 node:http fixture，
 *     无外部网络/无 key）——P5.3 出口"真 LLM 下端到端 smoke"的可实证形态。
 */
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleRuntime, type TdaRuntime } from '../src/runtime.ts';
import {
  createDshStreamProvider,
  createOpenAiCompatStreamFace,
  createScriptedStreamFace,
  type DshStreamProviderOptions,
} from 'tda-subagent-dispatch';

function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface Rig {
  readonly runtime: TdaRuntime;
  dispose(): Promise<void>;
}

async function setup(subagents: DshStreamProviderOptions): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-harness-p5-stream-'));
  const clock = createClock();
  const runtime = await assembleRuntime({
    dir,
    now: clock.now,
    executorEnabled: true,
    subagents: createDshStreamProvider(subagents),
  });
  return {
    runtime,
    async dispose() {
      await runtime.dispose();
      // [test-rm-bypass] OS 删除路径间歇挂起，detached 子进程清理（不占 libuv 线程池）
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    },
  };
}

async function seedGoalAndTask(runtime: TdaRuntime): Promise<{ goalId: string; taskId: string }> {
  const goal = await runtime.goalTree.service.create('human', {
    objective: '验证流式执行通道',
    completionCriteria: ['结论经 StreamChunk 真通道回传'],
  });
  const task = await runtime.taskPool.service.create('human', {
    goalId: goal.id,
    subject: '流式链路冒烟',
  });
  return { goalId: String(goal.id), taskId: String(task.id) };
}

describe('P5.3 集成：执行环 × StreamChunk 真通道', () => {
  it('scripted stream face：结论经 chunk 流组装 → dispatch J4 → complete(success)', async () => {
    const rig = await setup({
      face: createScriptedStreamFace({
        structured: { findings: ['流式链路打通'], confidence: 1 },
        viaToolCall: true,
        usage: { inputTokens: 9, outputTokens: 6, totalTokens: 15 },
      }),
    });
    try {
      const { taskId } = await seedGoalAndTask(rig.runtime);
      const report = await rig.runtime.tick();
      expect(report.executed.some((entry) => entry.startsWith(`${taskId}:completed:success`))).toBe(true);
      const task = rig.runtime.taskPool.service.get(taskId as never);
      expect(task?.phase).toBe('complete');
      expect(task?.outcome).toBe('success');
      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
    }
  });

  it('真 wire：OpenAI 兼容 SSE（本机回环 HTTP）→ complete(success)', async () => {
    const seenBodies: unknown[] = [];
    const server: Server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += String(chunk);
      });
      request.on('end', () => {
        seenBodies.push(JSON.parse(body) as unknown);
        const conclusion = JSON.stringify({ findings: ['真 wire 通'], confidence: 1 });
        const half = Math.ceil(conclusion.length / 2);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: conclusion.slice(0, half) } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: conclusion.slice(half) } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 } })}\n\n`);
        response.write('data: [DONE]\n\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    expect(address).not.toBeNull();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const rig = await setup({ face: createOpenAiCompatStreamFace({ baseUrl: `http://127.0.0.1:${port}/v1` }) });
    try {
      const { taskId } = await seedGoalAndTask(rig.runtime);
      const report = await rig.runtime.tick();
      expect(report.executed.some((entry) => entry.startsWith(`${taskId}:completed:success`))).toBe(true);
      const task = rig.runtime.taskPool.service.get(taskId as never);
      expect(task?.phase).toBe('complete');
      expect(task?.outcome).toBe('success');

      // wire 形状断言：OpenAI chat/completions 请求带 model/system/user 三段
      expect(seenBodies).toHaveLength(1);
      const body = seenBodies[0] as { model: string; stream: boolean; messages: { role: string; content: string }[] };
      expect(body.stream).toBe(true);
      expect(body.model).toBe('tda-subagent-oneshot');
      expect(body.messages[0]?.role).toBe('system');
      expect(body.messages[body.messages.length - 1]?.role).toBe('user');
      expect(body.messages[body.messages.length - 1]?.content.length).toBeGreaterThan(0);

      await rig.runtime.verifyInvariants();
    } finally {
      await rig.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
