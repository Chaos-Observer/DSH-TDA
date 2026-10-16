/**
 * P5 vendor 类型 shim：让 vendor/dsh 的 .ts 源码**脱离 TDA 严格 tsc**（ambient
 * declaration 优先于 node_modules 解析——DSH 源码按其自身宽松工具链消费，TDA
 * 侧运行层照常直吃源码）。声明面仅覆盖 TDA 直接 import 的模块；真结构对照
 * vendor 源码抄录（DomainSpec 同构见《DSH真装配-勘察与施工图》§1.1）。
 */

declare module '@deepseek-ai/dsh-storage-domain' {
  /** 最小 ZodType 面（TDA 的 zod 实例满足结构即可）。 */
  interface VendorZodType {
    parse(value: unknown): unknown;
  }
  export interface DomainTableSpec<K extends string = string, V = unknown> {
    readonly valueSchema: VendorZodType;
    readonly __key?: K;
  }
  export interface DomainGlobalSpec<G> {
    readonly schema: VendorZodType;
    readonly initial: G;
  }
  export interface DomainSpec {
    readonly name: string;
    readonly version: number;
    readonly layout?: 'single' | 'per-record';
    readonly compatibleVersions?: readonly number[];
    readonly invalidRecords?: 'backup-and-skip';
    readonly global?: DomainGlobalSpec<unknown>;
    readonly tables: Record<string, DomainTableSpec>;
  }
  export function defineDomain<S extends DomainSpec>(spec: S): S;
  export function domainTable<S extends DomainSpec>(spec: S): void;
  export function descriptorOf(spec: DomainSpec): {
    readonly name: string;
    readonly version: number;
    readonly compatibleVersions?: readonly number[];
    readonly tables: readonly string[];
    readonly hasGlobal: boolean;
  };
}

declare module '@deepseek-ai/dsh-storage-sqlite' {
  export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist';
  export interface Config {
    readonly path: string;
    readonly journalMode?: JournalMode;
  }
  /** KvUnitDescriptor（dsh-storage 主包导出的结构镜像）。 */
  export interface KvUnitDescriptor {
    readonly name: string;
    readonly version: number;
    readonly tables: readonly string[];
    readonly hasGlobal: boolean;
  }
  export interface KvUnit {
    loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>;
    putRecord(table: string, key: string, value: unknown): Promise<void>;
    deleteRecord(table: string, key: string): Promise<void>;
    setGlobal(value: unknown): Promise<void>;
    close(): Promise<void>;
  }
  export class SqliteStorageBackend {
    readonly kv: { open: (descriptor: KvUnitDescriptor) => Promise<KvUnit> };
    constructor(config: Config);
    close(): Promise<void>;
  }
}

// ── P5.2：dsh-session-persistence 详细声明（TDA 直接消费 validateStoredEvents）──

declare module '@deepseek-ai/dsh-session-persistence' {
  export interface SessionHeaderLike {
    readonly id: string;
    readonly version: number;
  }
  /** DSH SessionEvent 信封（TDA 侧写入的最小面；未知 type 靠 ignorable 跳过）。 */
  export interface SessionEventLike {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly ignorable?: true;
    readonly data: unknown;
  }
  /**
   * 后端共享存储校验：词表门（未知 type 须 ignorable）+ 逐事件 adopt（校验并冻结）。
   * TDA 写出的 dsh-compat 日志经本函数做"DSH 真代码可采纳"验证。
   */
  export function validateStoredEvents(
    meta: SessionHeaderLike,
    events: SessionEventLike[],
    location?: unknown,
  ): SessionEventLike[];
  export function assertVersion(meta: { readonly id: string; readonly version: number }, location?: unknown): void;
  export function assertStoredId(id: string, meta: SessionHeaderLike): void;
}

// ── P5.2：dsh-session 词表子路径（无装饰器的独立文件，运行层可直吃）──

declare module '@deepseek-ai/dsh-session/src/known-event-types.ts' {
  export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string>;
}

// ── P5.3：dsh-llm 词表子路径（无装饰器的独立文件，运行层可直吃；详细声明）──
// 结构对照 vendor/dsh/packages/llm/llm/src/types.ts 抄录（TDA 消费面：text/reasoning/
// tool-call 三块 + StreamChunk 全 union；image/file/tool-addition/removal 等暂不消费）。

declare module '@deepseek-ai/dsh-llm/src/types.ts' {
  export interface DshTextBlock {
    readonly type: 'text';
    readonly text: string;
  }
  export interface DshReasoningBlock {
    readonly type: 'reasoning';
    readonly text: string;
  }
  export interface DshToolCallBlock {
    readonly type: 'tool-call';
    readonly id: string;
    readonly name: string;
    /** Raw JSON string as produced by the model. */
    readonly arguments: string;
  }
  export type DshContentBlock = DshTextBlock | DshReasoningBlock | DshToolCallBlock;
  /** Serializable provider or transport failure facts（TDA 消费面只读 message/code）。 */
  export interface DshLlmFailure {
    readonly message: string;
    readonly code: string;
  }
  export type DshFinishReason =
    | { readonly kind: 'stop' }
    | { readonly kind: 'tool-calls' }
    | { readonly kind: 'max-tokens' }
    | { readonly kind: 'aborted'; readonly failure: DshLlmFailure }
    | { readonly kind: 'error'; readonly failure: DshLlmFailure };
  export interface DshTokenUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
  }
  export type DshStreamChunk =
    | { readonly type: 'block-start'; readonly index: number; readonly blockType: 'text' | 'reasoning' | 'tool-call' }
    | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
    | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
    | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
    | { readonly type: 'block-end'; readonly index: number; readonly block: DshContentBlock }
    | { readonly type: 'usage'; readonly usage: DshTokenUsage }
    | { readonly type: 'finish'; readonly reason: DshFinishReason };
  /** 一次性请求的最小消息面（TDA 侧只发 user text blocks）。 */
  export interface DshRequestMessage {
    readonly role: 'user';
    readonly content: readonly DshContentBlock[];
  }
  /** GenerateOptions 的 TDA 消费面（对齐 dsh-llm 同名类型的结构子集）。 */
  export interface DshGenerateOptions {
    readonly provider: string;
    readonly model: string;
    readonly system?: string;
    readonly messages: readonly DshRequestMessage[];
    readonly signal?: AbortSignal;
  }
}

declare module '@deepseek-ai/dsh-llm/src/assembler.ts' {
  import type {
    DshContentBlock,
    DshFinishReason,
    DshStreamChunk,
    DshTokenUsage,
  } from '@deepseek-ai/dsh-llm/src/types.ts';
  /**
   * DSH 真件：chunk→block 增量组装器（agent loop 的唯一权威组装算法）。
   * P5.3 起被 tda-subagent-dispatch 的 StreamChunk 适配器复用——face 输出序列
   * 由它做词表门校验（未知 chunk type 即抛，assertNever）。
   */
  export declare class BlockAssembler {
    push(chunk: DshStreamChunk): void;
    blocks(): DshContentBlock[];
    interruptedBlocks(): DshContentBlock[];
    readonly usage: DshTokenUsage | undefined;
    readonly finish: DshFinishReason;
  }
}

declare module '@deepseek-ai/dsh-llm/src/assistant-stream.ts' {
  import type { DshStreamChunk } from '@deepseek-ai/dsh-llm/src/types.ts';
  /** 紧凑 attempt 记录（lossless；门测试用于 expandAssistantStream 往返校验）。 */
  export type AssistantStreamRecord =
    | { readonly type: 'text-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }
    | { readonly type: 'reasoning-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }
    | { readonly type: 'tool-call-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly id: string; readonly name?: string; readonly args: readonly string[] }
    | { readonly type: 'chunk'; readonly time: number; readonly chunk: DshStreamChunk };
  export interface TimedStreamChunk {
    readonly time: number;
    readonly chunk: DshStreamChunk;
  }
  export declare class AssistantStreamAccumulator {
    push(value: TimedStreamChunk): TimedStreamChunk;
    snapshot(): readonly AssistantStreamRecord[];
  }
  /** Validating path for records read at a durable boundary（无损展开回 chunk 序列）。 */
  export declare function expandAssistantStream(stream: readonly AssistantStreamRecord[]): readonly TimedStreamChunk[];
  export declare function assembleAssistantStream(
    stream: readonly AssistantStreamRecord[],
    assembler?: BlockAssembler,
  ): BlockAssembler;
}

// ── 其余 vendor 模块的拦截 stub（ambient 优先于 node_modules 解析 → vendor .ts 脱离 tsc）──

declare module '@deepseek-ai/cordis' {
  // P5.4：TDA 消费面详细声明（真源码 vendor/dsh/root-vendor/cordis/src；
  //   运行层必须 node --experimental-transform-types——Service 用参数属性）。
  export declare class Context {
    constructor(options?: unknown);
    plugin(plugin: unknown, config?: unknown): unknown;
    dispose(): Promise<void> | void;
    // 服务经声明合并/运行期挂载访问（ctx.tdaTaskPoolTools 等）
    [key: string]: any;
  }
  export declare class Service {
    static provide?: string;
    static inject?: readonly string[];
    constructor(ctx: Context, name?: string);
    readonly ctx: Context;
    name: string;
  }
}

declare module '@deepseek-ai/cosmokit' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-agent' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-attachment' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-brand' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-commands' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-compaction' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-compaction-basic' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-compaction-image-offload' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-compaction-tool-result-pruner' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-invariants' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-llm' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-llm-retry' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-ptc-runtime' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-sandbox' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-sandbox-policy' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-scope' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-session' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-session-persistence' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-session-projection' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-storage' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-storage-json' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-system-prompt' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-timeout' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-token-meter' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-tools' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-user-approval' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-util-crypto' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-util-values' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/dsh-workspace' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}

declare module '@deepseek-ai/schemastery' {
  // vendor 运行层直吃源码；类型层按需在前段增补详细声明
  export type _VendorModule = unknown;
}
