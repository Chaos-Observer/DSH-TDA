/**
 * 会话主机 seam：DSH session（轨迹本体）的结构镜像。
 *
 * J1 钉死了边界：**TDA 不建自有轨迹存储**——轨迹资产 = 会话日志（JSONL、seq 连续）
 * + 各插件 domain。因此 T0.7 需要的不是"新存储"，而是**读得动日志**的一个窄面：
 *
 *  - `TdaSessionSink`（既有）：插件只往里写 TDA log-only 事件；
 *  - 本文件补的是**宿主侧**记录（DSH 核心面，不属 TDA 六族）：轮次括号
 *    `turn/start|turn/end`、崩溃恢复合成的 `interrupted` closer、模型可见的
 *    `conversation` 记录、fork 的 `session/end-seed` marker。
 *
 * 三条纪律由本文件的纯函数保证（不做 I/O；宿主实现只负责落盘）：
 *  1. **log-only 纯净**（§4.1-2）：`deriveMessages` 只投影 `conversation` 记录，
 *     TDA 事件**永不进入**模型可见面——"轨迹丰富但不污染模型历史"；
 *  2. **resume 不改写**（§4.1-5）：崩溃恢复以 `interrupted` 记录**只追加**闭合
 *     开放轮次，历史记录不重写（本文件只读，改写不可能发生）；
 *  3. **seed 不变量**（§4.1-6）：`checkSeedInvariants` 逐条校验 fork 的
 *     balanced 前缀 / seq 连续 / `inheritedEventCount` 精确 / marker 合规。
 */
import type { EventFamily, TdaLogEvent } from './events.ts';
import type { JsonObject, Seq, SessionId } from './types.ts';
import type { TdaSessionSink } from './dualWrite.ts';

/** 宿主记录种类（DSH 核心面；TDA 六族全部落在 `'tda'` 这一种里）。 */
export const HOST_RECORD_KINDS = [
  'tda',
  'turn/start',
  'turn/end',
  'interrupted',
  'conversation',
  'tool/call',
  'session/end-seed',
] as const;
export type HostRecordKind = (typeof HOST_RECORD_KINDS)[number];

interface HostRecordBase {
  readonly seq: Seq;
  readonly kind: HostRecordKind;
  readonly at: number;
}

/** TDA log-only 事件在宿主日志里的一行（payload 全量，供回放重建）。 */
export interface TdaHostRecord extends HostRecordBase {
  readonly kind: 'tda';
  readonly family: EventFamily;
  readonly businessId: string;
  readonly payload: JsonObject;
}

export interface TurnStartRecord extends HostRecordBase {
  readonly kind: 'turn/start';
  readonly turn: number;
}

export interface TurnEndRecord extends HostRecordBase {
  readonly kind: 'turn/end';
  readonly turn: number;
  readonly outcome: 'success' | 'failed' | 'aborted';
}

/** 崩溃恢复合成的事件（resume 只追加，不改写历史）。 */
export interface InterruptedRecord extends HostRecordBase {
  readonly kind: 'interrupted';
  readonly turn: number;
  readonly reason: string;
}

/** 模型可见的会话记录（唯一进入 `deriveMessages` 的种类）。 */
export interface ConversationRecord extends HostRecordBase {
  readonly kind: 'conversation';
  readonly turn: number;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
}

/**
 * 工具调用的**参数模式分类**（T1.3 J3：只存分类，不存参数值）。
 * 分类在**记录时**完成（见 `classifyToolArgClass`），日志里从此只有类别。
 */
export const TOOL_ARG_CLASSES = ['read', 'write', 'query', 'dispatch', 'other'] as const;
export type ToolArgClass = (typeof TOOL_ARG_CLASSES)[number];

/**
 * 工具调用记录（决策点证据；T1.3 轨迹预测器的 transition 源）。
 *
 * 为什么必须有这一种：预测器要预测"下一步动作"，而"动作"的最小可观测单位就是
 * 工具调用。会话日志若只有对话文本，抽取就只能解析自然语言——那既不确定也
 * 泄漏原文（J3）。故把工具调用提升为**结构化记录**：工具名（公开名）+ 参数
 * 模式分类 + 成败分类 + 失败类别，零原文。
 */
export interface ToolCallRecord extends HostRecordBase {
  readonly kind: 'tool/call';
  readonly turn: number;
  /** 工具公开名（非参数）。 */
  readonly tool: string;
  readonly argClass: ToolArgClass;
  readonly status: 'success' | 'failure';
  /** 失败类别（timeout/not-found/rejected/…；成败为 success 时缺席）。 */
  readonly errorClass?: string;
}

/** fork/restore 的 seed 边界 marker。 */
export interface SeedEndRecord extends HostRecordBase {
  readonly kind: 'session/end-seed';
  readonly note: string;
}

export type HostRecord =
  | TdaHostRecord
  | TurnStartRecord
  | TurnEndRecord
  | InterruptedRecord
  | ConversationRecord
  | ToolCallRecord
  | SeedEndRecord;

export interface HostTurn {
  readonly turn: number;
  readonly startedSeq: Seq;
  /** 闭合（`turn/end` 或 `interrupted`）时的 seq；未闭合则缺席。 */
  readonly endedSeq?: Seq;
  readonly closedBy?: 'turn/end' | 'interrupted';
}

/** 模型可见消息（`deriveMessages` 的输出；TDA 事件不在其中）。 */
export interface HostMessage {
  readonly seq: Seq;
  readonly turn: number;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
}

// ── 纯投影（宿主实现与消费方共用；不做 I/O） ──

export const tdaEvents = (records: readonly HostRecord[]): readonly TdaHostRecord[] =>
  records.filter((record): record is TdaHostRecord => record.kind === 'tda');

/** 轮次投影（按轮号升序；未闭合轮次的 `endedSeq` 缺席）。 */
/**
 * 规范化 JSON（**键序无关**）：JSON 对象的键序无语义，而 fork 会把记录重新拼装
 * （展开后补 seq/sessionId），键序因此变化——直接 JSON.stringify 比对会把
 * 「同一份数据」误判成「分歧」（IT4 fork 冒烟实测抓到）。故比对前按 key 排序。
 */
export function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (typeof input === "object" && input !== null) {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, walk(record[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

/**
 * 工具参数 → 模式分类（**只看参数键名与类型，不读值**）。
 *
 * 这是"零原文泄漏"（T1.3 J3）在写入侧的唯一入口：一旦分类完成，参数值就再也
 * 不会进入日志。规则刻意保守——**认不出就 `other`**，宁少不漏。
 */
export function classifyToolArgClass(tool: string, args: unknown): ToolArgClass {
  if (tool.startsWith('dispatch') || tool.includes('subagent')) return 'dispatch';
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const keys = Object.keys(record);
  if (keys.some((key) => key === 'query' || key === 'text' || key === 'pattern' || key === 'search')) return 'query';
  if (keys.some((key) => key === 'path' || key === 'file' || key === 'target')) {
    // 有内容载荷 = 写，否则读
    return keys.some((key) => key === 'content' || key === 'value' || key === 'body') ? 'write' : 'read';
  }
  if (keys.some((key) => key === 'content' || key === 'value' || key === 'body')) return 'write';
  return 'other';
}

export function projectTurns(records: readonly HostRecord[]): readonly HostTurn[] {
  const order: number[] = [];
  const starts = new Map<number, Seq>();
  const ends = new Map<number, { readonly seq: Seq; readonly closedBy: 'turn/end' | 'interrupted' }>();
  for (const record of records) {
    if (record.kind === 'turn/start') {
      if (!starts.has(record.turn)) order.push(record.turn);
      starts.set(record.turn, record.seq);
      continue;
    }
    if (record.kind === 'turn/end' || record.kind === 'interrupted') {
      ends.set(record.turn, {
        seq: record.seq,
        closedBy: record.kind === 'interrupted' ? 'interrupted' : 'turn/end',
      });
    }
  }
  return order
    .sort((a, b) => a - b)
    .map((turn) => {
      const startedSeq = starts.get(turn) ?? 0;
      const end = ends.get(turn);
      return end === undefined
        ? { turn, startedSeq }
        : { turn, startedSeq, endedSeq: end.seq, closedBy: end.closedBy };
    });
}

/** 未闭合轮次（`turn/start` 无对应 `turn/end`/`interrupted`）——resume 的合成依据。 */
export const openTurns = (records: readonly HostRecord[]): readonly number[] =>
  projectTurns(records)
    .filter((turn) => turn.endedSeq === undefined)
    .map((turn) => turn.turn);

/**
 * 模型可见面投影（DSH `deriveMessages` 的 TDA 侧近似）。
 * **只**取 `conversation` 记录——这正是"log-only 纯净"可自动断言的原因。
 */
export const deriveMessages = (records: readonly HostRecord[]): readonly HostMessage[] =>
  records
    .filter((record): record is ConversationRecord => record.kind === 'conversation')
    .map((record) => ({ seq: record.seq, turn: record.turn, role: record.role, content: record.content }));

export interface SeedInvariantInput {
  /** 父会话完整日志。 */
  readonly parent: readonly HostRecord[];
  /** 子会话（fork 产物）完整日志。 */
  readonly child: readonly HostRecord[];
  /** fork 边界：**已闭合轮次**的序号。 */
  readonly boundary: number;
  /** 调用方声明的继承记录数（须等于实际前缀长度）。 */
  readonly inheritedEventCount: number;
}

export interface SeedInvariantReport {
  readonly ok: boolean;
  /** 违规清单（人读；空 = 通过）。 */
  readonly violations: readonly string[];
}

/**
 * fork seed 不变量（§4.1-6，六条）：
 *  1. 边界必须是**已闭合轮次**（禁开放轮次内前缀）；缺该轮次即违规；
 *  2. balanced 前缀：子会话前缀记录与父会话同前缀**逐字段 JSON 等值**；
 *  3. `inheritedEventCount` 精确（等于实际继承记录数）；
 *  4. seq 从 1 起连续无洞（fork 后重新编号）；
 *  5. `session/end-seed` marker 恰一条，且位于继承前缀之后；
 *  6. TDA 事件集合是父会话前缀 TDA 事件集合的子集（log-only 关系不因 fork 失真）。
 */
export function checkSeedInvariants(input: SeedInvariantInput): SeedInvariantReport {
  const violations: string[] = [];
  const parentTurns = projectTurns(input.parent);
  const boundaryTurn = parentTurns.find((turn) => turn.turn === input.boundary);
  if (boundaryTurn === undefined) {
    violations.push(`边界轮次 ${input.boundary} 在父会话中不存在`);
  } else if (boundaryTurn.endedSeq === undefined) {
    violations.push(`边界轮次 ${input.boundary} 未闭合（禁开放轮次内前缀）`);
  }
  const boundarySeq = boundaryTurn?.endedSeq;
  const parentPrefix = boundarySeq === undefined ? [] : input.parent.filter((record) => record.seq <= boundarySeq);

  const seedRecords = input.child.filter((record) => record.kind === 'session/end-seed');
  if (seedRecords.length !== 1) {
    violations.push(`子会话须恰有 1 条 session/end-seed marker，实为 ${seedRecords.length}`);
  }
  const seedSeq = seedRecords[0]?.seq;
  const inherited = seedSeq === undefined ? input.child : input.child.filter((record) => record.seq < seedSeq);

  if (inherited.length !== input.inheritedEventCount) {
    violations.push(`inheritedEventCount 声明 ${input.inheritedEventCount}，实际继承 ${inherited.length}`);
  }
  if (inherited.length !== parentPrefix.length) {
    violations.push(`balanced 前缀长度不等：父 ${parentPrefix.length} / 子 ${inherited.length}`);
  }
  const limit = Math.min(inherited.length, parentPrefix.length);
  for (let index = 0; index < limit; index += 1) {
    const parentRecord = parentPrefix[index] as HostRecord;
    const childRecord = inherited[index] as HostRecord;
    // seq 与 sessionId 不参与比对：fork 后子会话重新编号、并换上自己的会话 id——
    // 这正是 fork 的语义（前缀内容等值），其余字段逐字节且键序无关
    if (
      canonicalJson({ ...parentRecord, seq: 0, sessionId: null }) !==
      canonicalJson({ ...childRecord, seq: 0, sessionId: null })
    ) {
      violations.push(`第 ${index + 1} 条继承记录与父会话前缀分歧`);
      break;
    }
  }
  for (let index = 0; index < input.child.length; index += 1) {
    if (input.child[index]?.seq !== index + 1) {
      violations.push(`子会话 seq 不连续：第 ${index + 1} 条为 ${input.child[index]?.seq ?? '(缺)'}`);
      break;
    }
  }
  if (seedSeq !== undefined) {
    const tdaAfter = input.child.filter((record) => record.seq > seedSeq && record.kind === 'tda');
    if (tdaAfter.length > 0) {
      violations.push(`seed marker 之后不得再有继承的 TDA 事件（实为 ${tdaAfter.length} 条）`);
    }
  }
  const parentTdaKeys = new Set(
    parentPrefix
      .filter((record): record is TdaHostRecord => record.kind === 'tda')
      .map((record) => `${record.family}\u0000${record.businessId}`),
  );
  for (const record of inherited) {
    if (record.kind !== 'tda') continue;
    const key = `${record.family}\u0000${record.businessId}`;
    if (!parentTdaKeys.has(key)) {
      violations.push(`子会话出现父会话前缀之外的 TDA 事件：${record.family}/${record.businessId}`);
      break;
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 会话主机（DSH session 的结构镜像）。
 *
 * 插件仍只依赖 `TdaSessionSink`（append/flush）；本面供 **Harness 与 T0.7** 使用：
 * 轮次括号、resume 合成 closer、模型可见面投影、日志全量读。
 */
export interface TdaSessionHost extends TdaSessionSink {
  readonly sessionId: SessionId;
  /** 完整日志（按 seq 升序；含 TDA 事件与宿主记录）。 */
  records(): readonly HostRecord[];
  /**
   * 开启一个轮次（`turn/start`），回传**轮次编号**（0 起）。
   *
   * 刻意回传轮号而非 seq：`endTurn(at, turn, outcome)` 也按轮号寻址，两者必须同轴；
   * 早期实现回传 seq，调用方顺手当轮号用，会让 `turn/end` 落到另一个轮次上——
   * 后果是 resume 数出错误的开放轮次数（IT4 冒烟实测抓到）。
   */
  beginTurn(at: number): number;
  /** 闭合轮次（`turn/end`）。 */
  endTurn(at: number, turn: number, outcome: 'success' | 'failed' | 'aborted'): Seq;
  /** 写入模型可见消息（`conversation`）。 */
  appendMessage(
    message: { readonly turn: number; readonly role: 'user' | 'assistant' | 'tool'; readonly content: string },
    at: number,
  ): Seq;
  /**
   * 写入工具调用记录（**结构化、零原文**）。调用方负责用
   * `classifyToolArgClass` 把参数折算成类别后再落盘。
   */
  appendToolCall(
    call: {
      readonly turn: number;
      readonly tool: string;
      readonly argClass: ToolArgClass;
      readonly status: 'success' | 'failure';
      readonly errorClass?: string;
    },
    at: number,
  ): Seq;
  /** 崩溃恢复：为开放轮次合成 `interrupted` closer（**只追加**）。 */
  closeTurn(turn: number, reason: string, at: number): Seq;
  /** fork/restore 的 seed 边界 marker。 */
  appendSeedEnd(note: string, at: number): Seq;
  /** 下一个可分配的 seq（1 起）。 */
  nextSeq(): Seq;
}

export type { TdaLogEvent };
