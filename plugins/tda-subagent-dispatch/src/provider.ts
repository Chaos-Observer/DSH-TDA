/**
 * 本地参考 SubagentProvider（IT3 用；接 DSH 时替换为 `ctx.subagents` 适配）。
 *
 * 定位与内核 `jsonBackend` 相同：**可执行的参考实现**，让派发全序
 * （start → run → settle → dispose）在没有 DSH 运行时的环境里可测、可冒烟、
 * 可回放。它刻意只实现 seam 的语义面（capability 声明 / run 句柄 / result /
 * dispose 幂等 / 子会话 id），不模拟真实模型行为——真实行为属 provider 侧。
 *
 * 用途：
 *  - 单测：脚本化结论（含 schema 失败、aborted、max-tokens、未知 stopReason）；
 *  - 集成：确定性结论回传，使"派发→结论→换页"闭环可复现；
 *  - 取消：`hang` 脚本让 result 永不 resolve，验证 cancel 必达 quiescence。
 */
import { asSessionId, type SessionId } from '@tda/kernel';
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResultLike,
  SubagentRun,
  SubagentStartRequest,
} from './service.ts';

export const FULL_CAPABILITIES: SubagentCapabilities = {
  agentOptions: true,
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
};

export interface ScriptedProviderSpec {
  readonly name?: string;
  /** capability 声明（缺省全支持；置 false 以验证 UNSUPPORTED_CAPABILITY 门）。 */
  readonly capabilities?: Partial<SubagentCapabilities>;
  /** 单次派发的结论脚本；返回 `hang:true` 表示 result 永不 resolve（取消场景）。 */
  readonly respond?: (req: SubagentStartRequest) => SubagentResultLike | 'hang' | Promise<SubagentResultLike | 'hang'>;
  /** start() 抛错（验证开跑失败的显式终态）。 */
  readonly failStart?: string;
}

export interface ScriptedProvider extends SubagentProvider {
  readonly starts: SubagentStartRequest[];
  readonly disposed: string[];
  readonly active: string[];
}

/** 脚本化 provider（确定性 run id：sub-1、sub-2…）。 */
export function createScriptedProvider(spec: ScriptedProviderSpec = {}): ScriptedProvider {
  const starts: SubagentStartRequest[] = [];
  const disposed: string[] = [];
  const active = new Set<string>();
  let counter = 0;

  return {
    name: spec.name ?? 'scripted-spawn',
    capabilities: { ...FULL_CAPABILITIES, ...spec.capabilities },
    starts,
    disposed,
    get active() {
      return [...active];
    },
    async start(req: SubagentStartRequest): Promise<SubagentRun> {
      if (spec.failStart !== undefined) {
        throw new Error(spec.failStart);
      }
      counter += 1;
      const id = asSessionId(`sub-${counter}`);
      starts.push(req);
      active.add(String(id));
      const script = spec.respond ?? ((): SubagentResultLike => ({ stopReason: 'completed', structured: { findings: ['ok'], confidence: 1 } }));
      const result = Promise.resolve().then(async (): Promise<SubagentResultLike> => {
        const produced = await script(req);
        if (produced === 'hang') {
          return new Promise<SubagentResultLike>(() => {
            // 永不 resolve：仅用于验证 cancel 的 dispose 必达 quiescence
          });
        }
        return produced;
      });
      return {
        id,
        result,
        async dispose() {
          if (disposed.includes(String(id))) return; // 幂等
          disposed.push(String(id));
          active.delete(String(id));
        },
      };
    },
  };
}

/** 便捷：固定结论的 provider（集成测试常用）。 */
export function createFixedProvider(value: unknown, usage: { tokens?: number; toolCalls?: number; wallClockMs?: number } = {}): ScriptedProvider {
  return createScriptedProvider({
    respond: () => ({ stopReason: 'completed', structured: value, usage }),
  });
}

export type { SessionId };
