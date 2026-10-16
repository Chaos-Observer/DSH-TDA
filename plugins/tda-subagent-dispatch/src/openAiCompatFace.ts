/**
 * P5.3 OpenAI 兼容 wire 适配：chat/completions SSE → DSH StreamChunk。
 *
 * 这是 P5.3 出口"真 LLM 下端到端 smoke"的真通道：本机回环 HTTP（无外部网络、
 * 无 key 依赖的 fixture server 即可驱动）上跑真 SSE 解析——
 *  - `delta.content` → text-delta；`delta.reasoning_content` → reasoning-delta；
 *  - `choices[0].finish_reason` → finish 词表映射
 *    （stop→stop / length→max-tokens / tool_calls→tool-calls /
 *     content_filter→error / 未知→error）；
 *  - `usage`（include_usage 末块）→ usage chunk（先于 finish）；
 *  - `options.signal` 透传 fetch——abort 让 reader 拒绝，由上层适配器归一化为
 *    aborted（对齐 DSH "adapter may throw, LlmRuntime normalizes" 契约）。
 * 只发文本面（结论 JSON 走文本通道）；tools/image 面随需求另立。
 */
import type { DshContentBlock, DshFinishReason, DshGenerateOptions, DshStreamChunk, DshTokenUsage } from '@deepseek-ai/dsh-llm/src/types.ts';
import type { DshStreamFace } from './dshStreamProvider.ts';

export interface OpenAiCompatFaceOptions {
  /** 形如 http://127.0.0.1:7392/v1（本适配器拼 /chat/completions）。 */
  readonly baseUrl: string;
  /** 静态 model 覆盖（缺省用请求里的 model）。 */
  readonly model?: string;
  readonly apiKey?: string;
  /** 注入 fetch（测试/代理）；缺省全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

interface OpenAiChunk {
  readonly choices?: readonly {
    readonly delta?: { readonly content?: string; readonly reasoning_content?: string };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

function mapFinishReason(raw: string | undefined): DshFinishReason {
  switch (raw) {
    case undefined:
      return { kind: 'stop' };
    case 'stop':
      return { kind: 'stop' };
    case 'length':
      return { kind: 'max-tokens' };
    case 'tool_calls':
      return { kind: 'tool-calls' };
    case 'content_filter':
      return { kind: 'error', failure: { message: 'content_filter', code: 'CONTENT_FILTER' } };
    default:
      return { kind: 'error', failure: { message: `未知 finish_reason: ${raw}`, code: 'UNKNOWN_FINISH' } };
  }
}

function mapUsage(usage: NonNullable<OpenAiChunk['usage']>): DshTokenUsage {
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
  };
}

export function createOpenAiCompatStreamFace(options: OpenAiCompatFaceOptions): DshStreamFace {
  const doFetch = options.fetchImpl ?? fetch;
  return async function* (request: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
    const system = request.system;
    const userText = request.messages
      .map((message) => message.content
        .map((block: DshContentBlock) => (block.type === 'text' ? block.text : ''))
        .join('\n'))
      .join('\n');
    const response = await doFetch(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model ?? request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          ...(system === undefined ? [] : [{ role: 'system', content: system }]),
          { role: 'user', content: userText },
        ],
      }),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`openai-compat 通道失败：HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const index = 0;
    let text = '';
    try {
      yield { type: 'block-start', index, blockType: 'text' };
      const decoder = new TextDecoder();
      let buffer = '';
      let finishRaw: string | undefined;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          let event: OpenAiChunk;
          try {
            event = JSON.parse(payload) as OpenAiChunk;
          } catch {
            continue; // 容忍心跳/非 JSON 行
          }
          const choice = event.choices?.[0];
          const delta = choice?.delta;
          if (typeof delta?.content === 'string' && delta.content !== '') {
            text += delta.content;
            yield { type: 'text-delta', index, text: delta.content };
          }
          if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
            yield { type: 'reasoning-delta', index, text: delta.reasoning_content };
          }
          if (choice?.finish_reason !== undefined) finishRaw = choice.finish_reason;
          if (event.usage !== undefined) {
            yield { type: 'usage', usage: mapUsage(event.usage) };
          }
        }
      }
      yield { type: 'block-end', index, block: { type: 'text', text } };
      yield { type: 'finish', reason: mapFinishReason(finishRaw) };
    } finally {
      // 上层 break/abort 时释放连接（reader.cancel 幂等容忍已完成流）
      await reader.cancel().catch(() => undefined);
    }
  };
}
