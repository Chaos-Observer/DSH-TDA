/**
 * 事件双写器：状态总线（domain）与审计总线（log-only event）的唯一配对点。
 *
 * 契约：
 *  1. 先落 domain（durability）后 append log-only event，同一调用栈；
 *  2. event seq 拥有序（sink 分配）；domain 记录不存 seq；
 *  3. 任一步抛错则整 op 抛（fail-loud），调用方不得做部分成功假设；
 *  4. audit_index 由双写器内部按族→entityKind 自动写，插件零代码。
 */
import { TdaError, type JsonObject, type Seq, type SessionId } from './types.ts';
import { assertEventFamily, entityKindOf, type EventFamily, type TdaLogEvent } from './events.ts';
import type { AuditIndex } from './auditIndex.ts';

/** session sink：log-only 事件的落盘点（append 返回 seq，flush 保证 durability）。 */
export interface TdaSessionSink {
  readonly sessionId: SessionId;
  append(event: TdaLogEvent): Seq;
  flush(): void;
}

/** 观察到的 domain 变更（喂给对账器）。 */
export interface DomainChangeRecord {
  readonly domain: string;
  readonly table: string;
  readonly key: string;
  readonly operation: 'put' | 'deleted';
}

export interface DualWriteOp {
  readonly family: EventFamily;
  readonly businessId: string;
  readonly payload: JsonObject;
  /** 状态总线写入；须经 domain 表 API（自身发 domain/changed）。 */
  readonly domainWrite: () => void | Promise<void>;
  /**
   * 声明"本事件在域内**没有**对应记录"（log-only 家族，如 T0.4 的 AssembleRecord：
   * §3.3 明定组装记录只落 log-only 事件 + T0.3 时间线，不落 domain）。
   *
   * 语义：**不参与域↔事件配对**——对账器不为其开窗，否则"有事件无域变更"会被
   * 误报成反向洞（unmatchedWrites），把"设计上无域记录"错判成"漏双写"。
   *
   * 纪律（避免沦为逃生通道）：仅当**该族在域内确无对应表**时才可置 true；
   * 一旦某族既有域记录又有 log-only 事件，配对义务就回到调用方（应改用普通
   * 双写并在同一窗口落域）。IT3 由各插件的加载期检查与 code review 共同把关。
   */
  readonly logOnly?: boolean;
}

export interface DualWriteReport {
  readonly ok: boolean;
  /** 域变更未配对事件（漏双写）。 */
  readonly unpairedChanges: readonly DomainChangeRecord[];
  /** 窗口内零域变更的双写次数（反向洞：有事件无域变更）。 */
  readonly unmatchedWrites: number;
  /** 中途失败的双写窗口次数。 */
  readonly failedWindows: number;
  /** 成功配对的双写次数。 */
  readonly pairedWrites: number;
  /** 派生窗口内的域变更次数（仅域写、无事件——不计入配对，见 dualWriteDerived）。 */
  readonly derivedChanges: number;
}

/** 双写对账器：以"写窗口"归属 domain/changed，供不变量门消费。 */
export interface DualWriteReconciler {
  beginWrite(): void;
  endWrite(): void;
  failWindow(): void;
  /**
   * 派生窗口：窗口内的域变更**不参与配对**（派生数据的权威在事件流，域只是索引/缓存）。
   * 与 log-only 对称：log-only = 有事件无域记录，derived = 有域记录无事件。
   */
  beginDerived(): void;
  endDerived(): void;
  observeChange(change: DomainChangeRecord): void;
  reconcile(): DualWriteReport;
}

export function createDualWriteReconciler(): DualWriteReconciler {
  let windowOpen = false;
  let windowChanges: DomainChangeRecord[] = [];
  const unpairedChanges: DomainChangeRecord[] = [];
  let unmatchedWrites = 0;
  let failedWindows = 0;
  let pairedWrites = 0;
  let derivedDepth = 0;
  let derivedChanges = 0;

  return {
    beginWrite() {
      if (windowOpen) {
        throw new TdaError('NESTED_WRITE_WINDOW', '双写窗口未结束即开始新窗口（双写不得嵌套/并发）');
      }
      windowOpen = true;
      windowChanges = [];
    },
    endWrite() {
      if (!windowOpen) {
        throw new TdaError('NO_OPEN_WRITE_WINDOW', '结束双写窗口时无已开窗口');
      }
      windowOpen = false;
      if (windowChanges.length > 0) {
        pairedWrites += 1;
      } else {
        unmatchedWrites += 1;
      }
      windowChanges = [];
    },
    failWindow() {
      if (!windowOpen) {
        throw new TdaError('NO_OPEN_WRITE_WINDOW', '失败双写窗口时无已开窗口');
      }
      windowOpen = false;
      failedWindows += 1;
      // 窗口内已落盘的域变更失去配对事件，计入漏双写
      unpairedChanges.push(...windowChanges);
      windowChanges = [];
    },
    beginDerived() {
      derivedDepth += 1;
    },
    endDerived() {
      if (derivedDepth === 0) {
        throw new TdaError('NO_OPEN_DERIVED_WINDOW', '结束派生窗口时无已开窗口');
      }
      derivedDepth -= 1;
    },
    observeChange(change) {
      if (derivedDepth > 0) {
        // 派生窗口：权威在事件流，此处只统计不配对
        derivedChanges += 1;
        return;
      }
      if (windowOpen) {
        windowChanges.push(change);
      } else {
        unpairedChanges.push(change);
      }
    },
    reconcile() {
      return {
        ok: unpairedChanges.length === 0 && unmatchedWrites === 0 && failedWindows === 0,
        unpairedChanges: [...unpairedChanges],
        unmatchedWrites,
        failedWindows,
        pairedWrites,
        derivedChanges,
      };
    },
  };
}

export interface DualWriteContext {
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
}

/**
 * 派生写主入口：**仅域写、不产事件**（派生数据的权威在事件流，域只是索引/缓存）。
 *
 * 与 log-only 对称，构成"域记录 × 事件"的第三种合法组合：
 *   - 权威：域 + 事件（`dualWrite`）
 *   - 仅事件：无域记录（`dualWrite(..., { logOnly: true })`）
 *   - 仅域：无事件（本函数）——T0.7 的 `audit_index` 是首例（§3.3：派生数据、
 *     丢失可由 log 重扫重建）
 *
 * 纪律：仅当**权威副本在事件流里确实存在**时才可用（否则这段状态将失去可回放性）。
 */
export async function dualWriteDerived(
  domainWrite: () => void | Promise<void>,
  context?: DualWriteContext,
): Promise<void> {
  const reconciler = context?.reconciler;
  reconciler?.beginDerived();
  try {
    await domainWrite();
  } finally {
    reconciler?.endDerived();
  }
}

/** 双写主入口：assert 族 → 开窗 → 落 domain → append event → 记索引 → 关窗 → flush。 */
export async function dualWrite(
  session: TdaSessionSink,
  op: DualWriteOp,
  context?: DualWriteContext,
): Promise<Seq> {
  const family = assertEventFamily(op.family);
  const reconciler = context?.reconciler;
  // log-only 事件：域内无对应记录，不参与配对（见 DualWriteOp.logOnly 注释）
  if (op.logOnly !== true) {
    reconciler?.beginWrite();
    try {
      await op.domainWrite();
    } catch (error) {
      reconciler?.failWindow();
      throw error;
    }
  }
  let seq: Seq;
  try {
    seq = session.append({ family, businessId: op.businessId, payload: op.payload });
  } catch (error) {
    if (op.logOnly !== true) reconciler?.failWindow();
    throw error;
  }
  context?.index?.record(entityKindOf(family), op.businessId, session.sessionId, seq);
  if (op.logOnly !== true) reconciler?.endWrite();
  session.flush();
  return seq;
}
