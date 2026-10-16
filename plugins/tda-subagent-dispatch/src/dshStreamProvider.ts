/**
 * P5.3 DSH StreamChunk 换真适配器（tda-subagent-dispatch 的执行通道第二形态）。
 *
 * 定位（对照《DSH真装配-勘察与施工图》§2 第 3 行）：
 *  - `createScriptedProvider`（provider.ts）保留为**测试注入面**——确定性结论、
 *    零 chunk 协议；真实通道 = 一个 DSH StreamChunk 流（`LlmAdapter.stream` 的
 *    结构镜像 face），由本文件桥到 TDA `SubagentProvider` seam。
 *  - **chunk 组装不自制**：直接复用 DSH 真件 `BlockAssembler`
 *    （vendor/dsh/packages/llm/llm/src/assembler.ts，agent loop 的唯一权威组装
 *    算法）——face 输出序列因此同时被 DSH 词表门校验（未知 chunk type 即抛）。
 *    装饰器边界：`@deepseek-ai/dsh-llm` 主入口 index.ts 带 @Remote（源码直吃
 *    硬边界），子路径 `./src/assembler.ts` 无装饰器可加载——故经**懒加载动态
 *    import** 引入，不拉主入口、不影响既有 kill -9 子进程链路。
 *  - 终止语义映射（对齐 service.ts `mapStopReason` 的消费词表）：
 *      stop → completed；tool-calls → completed（有可提取结论）/ error；
 *      max-tokens → max-tokens；aborted → aborted；error / 未知 → error。
 *    abort 场景沿用 DSH interrupted 语义：只收 `interruptedBlocks()`（工具调用
 *    不保留——中断先于派发，保留需伪造结果）。
 *  - J4 纪律不变：本适配器只做 **JSON 提取**（文本包裹/围栏均容忍），schema
 *    白名单校验仍归 dispatch 服务（structured 不过 → conclusion-partial）。
 */
import { asSessionId, type SessionId } from '@tda/kernel';
import type { BlockAssembler } from '@deepseek-ai/dsh-llm/src/assembler.ts';
import type {
  DshContentBlock,
  DshFinishReason,
  DshGenerateOptions,
  DshStreamChunk,
  DshTokenUsage,
} from '@deepseek-ai/dsh-llm/src/types.ts';
import { FULL_CAPABILITIES } from './provider.ts';
import type {
  SubagentProvider,
  SubagentResultLike,
  SubagentRun,
  SubagentStartRequest,
} from './service.ts';

// ── 词表再导出（TDA 侧消费 DSH 流式词表的唯一入口；结构见 vendor-types.d.ts）──

export type {
  DshContentBlock,
  DshFinishReason,
  DshGenerateOptions,
  DshStreamChunk,
  DshTokenUsage,
};

/** StreamFace：DSH `LlmAdapter.stream` / `PreparedAdapterCall.stream` 的结构镜像。 */
export type DshStreamFace = (request: DshGenerateOptions) => AsyncIterable<DshStreamChunk>;

export interface DshStreamProviderOptions {
  /** 执行通道：发出 DSH StreamChunk 流（真 LLM wire 适配或 scripted 测试面）。 */
  readonly face: DshStreamFace;
  /** 路由 provider（GenerateOptions.provider；缺省 'tda-dispatch'）。 */
  readonly provider?: string;
  /** 路由 model（缺省 'tda-subagent-oneshot'）。 */
  readonly model?: string;
}

export interface DshStreamProvider extends SubagentProvider {
  /** face 收到的请求（可观测：测试断言 system/user 形状）。 */
  readonly requests: DshGenerateOptions[];
  /** 已取消的 run id（与 scripted provider 的 disposed 对偶）。 */
  readonly aborted: readonly string[];
}

// ── DSH 真 BlockAssembler 懒加载（子进程零负担：不构造 provider 就不加载）──

type BlockAssemblerFactory = new () => BlockAssembler;
let assemblerFactory: Promise<BlockAssemblerFactory> | undefined;

async function loadBlockAssembler(): Promise<BlockAssemblerFactory> {
  assemblerFactory ??= (async () => {
    const mod = (await import('@deepseek-ai/dsh-llm/src/assembler.ts')) as {
      BlockAssembler: BlockAssemblerFactory;
    };
    return mod.BlockAssembler;
  })();
  return assemblerFactory;
}

// ── 结构化提取（J4 的前置：只提取，不校验）──

/** 字符串感知的配平扫描：从 text 中取第一个完整 JSON 对象（容忍 prose/围栏包裹）。 */
export function extractJsonObject(text: string): unknown | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export interface ExtractedConclusion {
  readonly structured?: unknown;
  /** 结论取自 tool-call arguments（true）还是文本 JSON（false）。 */
  readonly viaToolCall: boolean;
}

/** 组装块 → 结论：tool-call arguments 优先，文本 JSON 兜底。 */
export function structuredFromBlocks(blocks: readonly DshContentBlock[]): ExtractedConclusion {
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      const parsed = extractJsonObject(block.arguments);
      if (parsed !== undefined) return { structured: parsed, viaToolCall: true };
    }
  }
  const text = blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
  const parsed = extractJsonObject(text);
  return parsed === undefined ? { viaToolCall: false } : { structured: parsed, viaToolCall: false };
}

// ── 终止映射 ──

export function mapFinishToStopReason(
  finish: DshFinishReason,
  structured: unknown | undefined,
): { stopReason: string; diagnostic?: string } {
  switch (finish.kind) {
    case 'stop':
      return { stopReason: 'completed' };
    case 'tool-calls':
      return structured !== undefined
        ? { stopReason: 'completed' }
        : { stopReason: 'error', diagnostic: 'tool-calls 终止但无可提取结论' };
    case 'max-tokens':
      return { stopReason: 'max-tokens' };
    case 'aborted':
      return { stopReason: 'aborted', diagnostic: finish.failure.message };
    case 'error':
      return { stopReason: 'error', diagnostic: finish.failure.message };
    default:
      return { stopReason: 'error', diagnostic: '未知 finish 词表变体' };
  }
}

function usageToSubagentUsage(usage: DshTokenUsage): { tokens: number } {
  return {
    tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
  };
}

// ── 主适配器 ──

export function createDshStreamProvider(options: DshStreamProviderOptions): DshStreamProvider {
  const provider = options.provider ?? 'tda-dispatch';
  const model = options.model ?? 'tda-subagent-oneshot';
  const requests: DshGenerateOptions[] = [];
  let counter = 0;
  const abortedRuns = new Set<string>();

  const run = async (req: SubagentStartRequest, signal: AbortSignal): Promise<SubagentResultLike> => {
    const assembler = new (await loadBlockAssembler())();
    const request: DshGenerateOptions = {
      provider,
      model,
      ...(req.persona === '' ? {} : { system: req.persona }),
      messages: [{ role: 'user', content: req.prompt.map((block) => ({ type: 'text', text: block.text }) as DshContentBlock) }],
      ...(signal === undefined ? {} : { signal }),
    };
    requests.push(request);
    let aborted = false;
    let thrown: string | undefined;
    try {
      for await (const chunk of options.face(request)) {
        if (signal.aborted) {
          aborted = true;
          break;
        }
        // DSH 真件即词表门：未知 chunk type 在 push 内抛（assertNever）
        assembler.push(chunk);
      }
    } catch (error) {
      if (signal.aborted) {
        aborted = true;
      } else {
        thrown = error instanceof Error ? error.message : String(error);
      }
    }
    if (signal.aborted) aborted = true;

    if (aborted) {
      const blocks = assembler.interruptedBlocks();
      const { structured } = structuredFromBlocks(blocks);
      return {
        stopReason: 'aborted',
        ...(structured !== undefined ? { structured } : {}),
      };
    }
    if (thrown !== undefined) {
      return { stopReason: 'error', diagnostic: thrown };
    }
    const finish = assembler.finish;
    const blocks = assembler.blocks();
    const { structured } = structuredFromBlocks(blocks);
    const mapped = mapFinishToStopReason(finish, structured);
    const usage = assembler.usage;
    return {
      stopReason: mapped.stopReason,
      ...(structured !== undefined ? { structured } : {}),
      ...(mapped.diagnostic !== undefined ? { diagnostic: mapped.diagnostic } : {}),
      ...(usage !== undefined ? { usage: usageToSubagentUsage(usage) } : {}),
    };
  };

  return {
    name: 'dsh-stream',
    capabilities: { ...FULL_CAPABILITIES },
    requests,
    start(req: SubagentStartRequest): Promise<SubagentRun> {
      counter += 1;
      const id = asSessionId(`sub-${counter}`);
      const controller = new AbortController();
      const result: Promise<SubagentResultLike> = run(req, controller.signal);
      return Promise.resolve({
        id,
        result,
        async dispose(): Promise<void> {
          abortedRuns.add(String(id));
          controller.abort();
        },
      });
    },
    /** 测试观测：run id 是否被取消（与 scripted provider 的 disposed 对偶）。 */
    get aborted(): readonly string[] {
      return [...abortedRuns];
    },
  };
}

// ── scripted stream face（协议可执行规格 + 测试注入面）──

export interface ScriptedStreamFaceSpec {
  /** 结论 structured（text 通道 = JSON 文本流出；tool-call 通道 = arguments 流出）。 */
  readonly structured?: unknown;
  /** 覆盖文本流出内容（缺省 = JSON.stringify(structured)；两者皆缺省 = 空 text 块）。 */
  readonly text?: string;
  /** structured 走 tool-call 通道（缺省 false = text 通道）。 */
  readonly viaToolCall?: boolean;
  readonly usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  readonly finishKind?: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error';
  /** finish 为 aborted/error 时的 failure 载荷（缺省 message='scripted failure'）。 */
  readonly failure?: { message: string; code: string };
  /** 挂起直到 abort（取消场景；abort 后按 DSH 语义抛 AbortError 样错误）。 */
  readonly hangUntilAbort?: boolean;
  /** 每 chunk 间让出一个宏任务（留取消窗口）。 */
  readonly yieldBetweenChunks?: boolean;
}

const yieldMacro = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 确定性 StreamChunk 序列生成器。序列形态即 **协议可执行规格**：
 * block-start → delta(s) → block-end → usage → finish（usage 先于 finish，
 * 与 DSH adapter 契约一致）；每索引至多一块；tool-call arguments 按 3 段流出
 * （验证 delta 拼接）。
 */
export function createScriptedStreamFace(spec: ScriptedStreamFaceSpec = {}): DshStreamFace {
  return async function* (request: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
    if (spec.hangUntilAbort === true) {
      // 挂起直到取消：abort 后按 DSH 契约抛错（LlmRuntime 归一化为 aborted finish）
      await new Promise<void>((_resolve, reject) => {
        if (request.signal?.aborted === true) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        request.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      });
      return;
    }
    if (spec.viaToolCall === true) {
      const args = spec.structured === undefined ? '{}' : JSON.stringify(spec.structured);
      const third = Math.max(1, Math.ceil(args.length / 3));
      const fragments = [args.slice(0, third), args.slice(third, third * 2), args.slice(third * 2)].filter((part) => part !== '');
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      for (const fragment of fragments) {
        yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'return_conclusion', argumentsDelta: fragment };
        if (spec.yieldBetweenChunks === true) await yieldMacro();
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call-1', name: 'return_conclusion', arguments: args },
      };
    } else {
      const text = spec.text ?? (spec.structured === undefined ? '' : JSON.stringify(spec.structured));
      const third = Math.max(1, Math.ceil(text.length / 2));
      const parts = text.length === 0 ? [''] : [text.slice(0, third), text.slice(third)];
      yield { type: 'block-start', index: 0, blockType: 'text' };
      for (const part of parts) {
        if (part !== '') yield { type: 'text-delta', index: 0, text: part };
        if (spec.yieldBetweenChunks === true) await yieldMacro();
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    }
    if (spec.usage !== undefined) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: spec.usage.inputTokens ?? 0,
          outputTokens: spec.usage.outputTokens ?? 0,
          ...(spec.usage.totalTokens !== undefined ? { totalTokens: spec.usage.totalTokens } : {}),
        },
      };
    }
    const kind = spec.finishKind ?? 'stop';
    const failure = { message: spec.failure?.message ?? 'scripted failure', code: spec.failure?.code ?? 'SCRIPTED' };
    const reason: DshFinishReason =
      kind === 'aborted'
        ? { kind: 'aborted', failure }
        : kind === 'error'
          ? { kind: 'error', failure }
          : { kind };
    yield { type: 'finish', reason };
  };
}

export type { SessionId };
