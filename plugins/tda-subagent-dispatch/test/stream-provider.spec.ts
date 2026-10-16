/**
 * P5.3 插件门：DshStreamProvider（StreamChunk 换真适配器）语义。
 *
 * 分工：vendor 门验证 DSH 真件（BlockAssembler/expandAssistantStream）对拍；
 * 本文件验证适配器自身的判定面——
 *  1. 通道：text JSON / tool-call arguments / prose+围栏包裹 / 无 JSON；
 *  2. 终止映射：stop/tool-calls/max-tokens/aborted/error/未知变体；
 *  3. 用量记账：totalTokens 优先，缺省 input+output；
 *  4. 取消：dispose → face 收 abort → 结果 aborted（对偶 scripted 的 hang）；
 *  5. 词表门：face 吐未知 chunk type → DSH 真 BlockAssembler 抛 → error。
 */
import { describe, expect, it } from 'vitest';
import {
  createDshStreamProvider,
  createScriptedStreamFace,
  extractJsonObject,
  mapFinishToStopReason,
  type DshStreamChunk,
} from '../src/dshStreamProvider.ts';
import type { SubagentStartRequest } from '../src/service.ts';

const REQ: SubagentStartRequest = {
  orderId: 'ord-1' as never,
  role: 'sidekick',
  prompt: [{ type: 'text', text: '按 outputSchema 回传结论。' }],
  outputSchema: { type: 'object', required: ['findings', 'confidence'] } as never,
  agentOptions: {} as never,
  toolFilter: [],
  maxDepth: 0,
  persona: '你是 sidekick。',
  parent: 'sess-main' as never,
  inheritsParentContext: false,
};

const CONCLUSION = { findings: ['流式链路打通'], confidence: 1 };

interface StreamResult {
  readonly stopReason: string;
  readonly structured?: unknown;
  readonly diagnostic?: string;
  readonly usage?: { readonly tokens?: number };
}

async function settle(provider: ReturnType<typeof createDshStreamProvider>): Promise<StreamResult> {
  const run = await provider.start(REQ);
  return (await run.result) as StreamResult;
}

describe('P5.3 结论提取', () => {
  it('text 通道：JSON 文本流出 → structured 提取 + usage 记账', async () => {
    const provider = createDshStreamProvider({
      face: createScriptedStreamFace({ structured: CONCLUSION, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    });
    const result = await settle(provider);
    expect(result.stopReason).toBe('completed');
    expect(result.structured).toEqual(CONCLUSION);
    expect(result.usage).toEqual({ tokens: 15 });
  });

  it('tool-call 通道：分片 arguments 拼接 → structured 提取（viaToolCall）', async () => {
    const provider = createDshStreamProvider({
      face: createScriptedStreamFace({ structured: CONCLUSION, viaToolCall: true, usage: { inputTokens: 3, outputTokens: 4 } }),
    });
    const result = await settle(provider);
    expect(result.stopReason).toBe('completed');
    expect(result.structured).toEqual(CONCLUSION);
    expect(result.usage).toEqual({ tokens: 7 }); // totalTokens 缺省 = input+output
  });

  it('prose + 围栏包裹的 JSON 也能提取；无 JSON → completed 无 structured', async () => {
    expect(extractJsonObject('前置说明\n```json\n{"a":1}\n```\n后缀')).toEqual({ a: 1 });
    expect(extractJsonObject('完全不是 JSON')).toBeUndefined();
    expect(extractJsonObject('字符串里的 } 不配平 {"k":"}"}')).toEqual({ k: '}' });

    const provider = createDshStreamProvider({
      face: createScriptedStreamFace({ text: '模型只说了句废话，没有结论 JSON。' }),
    });
    const result = await settle(provider);
    expect(result.stopReason).toBe('completed');
    expect(result.structured).toBeUndefined();
  });

  it('tool-calls 终止但无可提取结论 → error（带诊断）', () => {
    const mapped = mapFinishToStopReason({ kind: 'tool-calls' }, undefined);
    expect(mapped.stopReason).toBe('error');
    expect(mapped.diagnostic).toContain('tool-calls');
  });
});

describe('P5.3 终止映射与异常面', () => {
  it('max-tokens / error（failure 进诊断）/ 未知 finish 变体', async () => {
    const maxTokens = createDshStreamProvider({ face: createScriptedStreamFace({ structured: CONCLUSION, finishKind: 'max-tokens' }) });
    expect((await settle(maxTokens)).stopReason).toBe('max-tokens');

    const error = createDshStreamProvider({
      face: createScriptedStreamFace({ finishKind: 'error', failure: { message: '上游 502', code: 'UPSTREAM' } }),
    });
    const errorResult = await settle(error);
    expect(errorResult.stopReason).toBe('error');
    expect(errorResult.diagnostic).toBe('上游 502');

    const unknown = createDshStreamProvider({
      face: createScriptedStreamFace({ finishKind: 'refusal' as never }),
    });
    expect((await settle(unknown)).stopReason).toBe('error');
  });

  it('face 抛错（非 abort）→ error + 诊断', async () => {
    const provider = createDshStreamProvider({
      face: async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' } as DshStreamChunk;
        throw new Error('连接中断');
      },
    });
    const result = await settle(provider);
    expect(result.stopReason).toBe('error');
    expect(result.diagnostic).toBe('连接中断');
  });

  it('face 吐未知 chunk type → DSH 真 BlockAssembler 词表门抛出 → error', async () => {
    const provider = createDshStreamProvider({
      face: async function* () {
        yield { type: 'mystery-chunk', index: 0 } as never;
      },
    });
    const result = await settle(provider);
    expect(result.stopReason).toBe('error');
  });

  it('aborted finish（face 主动）→ aborted + failure 诊断', async () => {
    const provider = createDshStreamProvider({
      face: createScriptedStreamFace({ finishKind: 'aborted', failure: { message: '运行时取消', code: 'ABORT' } }),
    });
    const result = await settle(provider);
    expect(result.stopReason).toBe('aborted');
    expect(result.diagnostic).toBe('运行时取消');
  });
});

describe('P5.3 取消（dispose → abort → aborted）', () => {
  it('hangUntilAbort face：dispose 后结果必达 aborted（quiescence 对偶）', async () => {
    const provider = createDshStreamProvider({
      face: createScriptedStreamFace({ hangUntilAbort: true, yieldBetweenChunks: true }),
    });
    const run = await provider.start(REQ);
    const disposePromise = run.dispose();
    const result = await Promise.race([
      run.result,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('取消后结果未达（非 quiescence）')), 2_000)),
    ]);
    expect(result.stopReason).toBe('aborted');
    await disposePromise;
    expect(provider.aborted).toContain(String(run.id));
  });

  it('abort 窗口内的半流 → interruptedBlocks 语义（text 可保留，结果 aborted）', async () => {
    let gate: (() => void) | undefined;
    const gatePromise = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const provider = createDshStreamProvider({
      face: async function* (request) {
        yield { type: 'block-start', index: 0, blockType: 'text' } as DshStreamChunk;
        yield { type: 'text-delta', index: 0, text: '被中断前的半句' } as DshStreamChunk;
        // 等待取消（信号到 → 抛）
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
          gate?.();
        });
      },
    });
    const run = await provider.start(REQ);
    await gatePromise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await run.dispose();
    const result = await run.result;
    expect(result.stopReason).toBe('aborted');
  });
});

describe('P5.3 请求形状', () => {
  it('prompt→user text blocks、persona→system、可观测 requests', async () => {
    const provider = createDshStreamProvider({
      face: createScriptedStreamFace({ structured: CONCLUSION }),
    });
    await settle(provider);
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request.provider).toBe('tda-dispatch');
    expect(request.model).toBe('tda-subagent-oneshot');
    expect(request.system).toBe('你是 sidekick。');
    expect(request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '按 outputSchema 回传结论。' }] }]);
  });
});
