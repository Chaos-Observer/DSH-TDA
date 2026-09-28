/**
 * T0.4 会话 surface seam（DSH `ctx.compaction` / session surface 的结构镜像）。
 *
 * 隔离意图：context 插件**不实现**压缩内核（J1：复用 DSH compaction 为执行基座），
 * 只做三件事——pinned 豁免区、统一分页树、困惑度 gate；因此它对外只依赖
 * 一个很窄的面：
 *  - 读 surface 消息（history 段的原料）与**已遮蔽 seq 集**（权威集）；
 *  - 把 gate 的遮蔽决策**写回同一权威集**（不变量 4：禁止旁路删除 surface 内容）；
 *  - 读 DSH 双档压力信号（pressure / context-overflow），作为遮蔽原因的第一来源。
 *
 * `createMemorySurface` 是本地参考实现：接 DSH 时替换为 ctx.compaction 适配，
 * 其余（service/gate/pages）零改动。
 */
import { asSessionId, type SessionId } from '@tda/kernel';
import type { ShadowReason } from './domain.ts';

export interface SurfaceMessage {
  readonly seq: number;
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly content: string;
  /** 归属 page（缺省 = 常驻，不随换页折叠）。 */
  readonly pageId?: string;
  /** 该消息结束一个 tool-call/result 配对组（段边界之一，不变量 3）。 */
  readonly pairBoundary?: boolean;
}

export interface ShadowEntry {
  readonly seqs: readonly number[];
  readonly reason: ShadowReason;
}

export interface PressureSignal {
  readonly level: 'none' | 'pressure' | 'overflow';
  readonly seqs?: readonly number[];
}

export interface ContextSurfaceSeam {
  readonly sessionId: SessionId;
  messages(): readonly SurfaceMessage[];
  /** 已遮蔽 seq 集（DSH shadowedSeqs 权威集）。 */
  shadowedSeqs(): readonly number[];
  /** 遮蔽决策落地：只允许追加到权威集，不允许调用方自行删消息。 */
  shadow(entry: ShadowEntry): void;
  /** 双档压力（缺省视为 none）。 */
  pressure?(): PressureSignal | undefined;
}

/** 内存参考实现（测试/本地宿主）。 */
export function createMemorySurface(options: {
  readonly sessionId?: string;
  readonly messages?: readonly SurfaceMessage[];
  readonly shadowed?: readonly number[];
  readonly pressure?: () => PressureSignal | undefined;
} = {}): ContextSurfaceSeam & { readonly applied: ShadowEntry[]; push(message: SurfaceMessage): void } {
  const shadowed = new Set<number>(options.shadowed ?? []);
  const applied: ShadowEntry[] = [];
  const messages: SurfaceMessage[] = [...(options.messages ?? [])];
  return {
    sessionId: asSessionId(options.sessionId ?? 'sess-context'),
    applied,
    messages: () => messages,
    push(message) {
      messages.push(message);
    },
    shadowedSeqs: () => [...shadowed].sort((a, b) => a - b),
    shadow(entry) {
      applied.push(entry);
      for (const seq of entry.seqs) shadowed.add(seq);
    },
    ...(options.pressure !== undefined ? { pressure: options.pressure } : {}),
  };
}
