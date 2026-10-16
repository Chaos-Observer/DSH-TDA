/**
 * P5.4 DSH 工具面直传适配（任务池 9 工具 → DSH ToolDefinition 契约形状）。
 *
 * 换真边界实证（2026-10-15）：DSH `defineTool`（core/tools/src/schema.ts）与
 * `ToolRuntime`（index.ts）的 import 链都 value-import `@deepseek-ai/dsh-llm`
 * 的 `HarnessError` ——而 dsh-llm 主入口带 `@Remote` 装饰器，node strip-only 与
 * `--experimental-transform-types` 均 SyntaxError（P5.3 已实证装饰器是源码直吃
 * 硬边界）。**本体调用随 DSH 宿主/发货态构建产物接管**；本文件的职责是把 9 个
 * TaskToolDefinition 直传成 DSH `ctx.tools.register(definition)` 零改动可收的
 * ToolDefinition 形状，并用 ToolRuntime.register/execute 的**语义镜像宿主**
 * （重名拒绝 / 保留名 / render 必须 / ToolSchema 投影）在 TDA 侧可测。
 *
 * 契约对照（vendor/dsh/packages/core/tools/src）：
 *  - ToolDefinition：name/description/parameters(JSON Schema)/
 *    output{schema, render}/execute(args, exec)（index.ts:236, schema.ts:554）；
 *  - register 门：重名拒绝、`run_code` 保留（PTC 传输名）、
 *    output.render 须为函数（index.ts:1062，TypeError 文案同源）；
 *  - ToolRunContext：callId/name/arguments/signal/agent?（index.ts:326,393,418）。
 */
import { TdaError } from '@tda/kernel';
import type { JsonObject, SessionId } from '@tda/kernel';
import type { TaskToolCallContext, TaskToolDefinition } from './tools.ts';
import type { TaskActor } from './domain.ts';

// ── DSH core/tools 词表镜像（TDA 消费面；真类型随 DSH 宿主接线时切换）──

export interface DshTextContentBlock {
  readonly type: 'text';
  readonly text: string;
}

/** ToolRunContext 的 TDA 消费面（agent 只取 session.id；deferContext/concludeTurn 不用）。 */
export interface DshToolRunContext {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly signal: AbortSignal;
  readonly agent?: {
    readonly session?: {
      readonly id?: string;
    };
  };
}

/** DSH ToolDefinition 契约形状（ctx.tools.register 的直传面）。 */
export interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema（模型参数面；DSH 以 Record 透传，注册侧 assertSupportedJsonSchema）。 */
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    render(args: unknown, value: unknown): readonly DshTextContentBlock[];
  };
  execute(args: unknown, exec: DshToolRunContext): Promise<unknown>;
}

/** ToolSchema 投影（模型可见工具面：name/description/parameters）。 */
export interface DshToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** DSH ToolRuntime 保留名（RUN_CODE_NAME——PTC 模式呈现传输专用，注册/遮蔽皆拒）。 */
export const RUN_CODE_RESERVED_NAME = 'run_code';

// ── 参数校验（9 工具 schema 特征面的子集门；与 handler 内 requireString 双保险）──

/**
 * JSON Schema 子集校验：type(object/string/number/boolean/array) + required +
 * properties + items + enum——正是任务池 9 工具 parameters 用到的全部特征
 * （tools.ts 实测枚举）。返回路径限定的违规清单（DSH validateArgs 同形）。
 */
export function validateJsonSchemaSubset(schema: unknown, value: unknown, path: string): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as {
    type?: string;
    required?: readonly string[];
    properties?: Record<string, unknown>;
    items?: unknown;
    enum?: readonly unknown[];
  };
  const at = (sub: string): string => {
    if (path === '') return sub;
    return sub === '(root)' ? path : `${path}.${sub}`;
  };
  if (node.enum !== undefined) {
    if (!node.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
      return [`${at('(root)')} 必须是 enum 之一（${node.enum.map((item) => JSON.stringify(item)).join('/')}）`];
    }
    return [];
  }
  switch (node.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`${at('(root)')} 必须是 object`];
      }
      const record = value as Record<string, unknown>;
      const violations: string[] = [];
      for (const key of node.required ?? []) {
        if (record[key] === undefined) violations.push(`${at(key)} 必填`);
      }
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        if (record[key] === undefined) continue;
        violations.push(...validateJsonSchemaSubset(child, record[key], at(key)));
      }
      return violations;
    }
    case 'string':
      return typeof value === 'string' ? [] : [`${at('(root)')} 必须是 string`];
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [`${at('(root)')} 必须是 number`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at('(root)')} 必须是 boolean`];
    case 'array': {
      if (!Array.isArray(value)) return [`${at('(root)')} 必须是 array`];
      if (node.items === undefined) return [];
      const violations: string[] = [];
      value.forEach((item, index) => {
        violations.push(...validateJsonSchemaSubset(node.items, item, `${at(String(index))}`));
      });
      return violations;
    }
    default:
      return [];
  }
}

// ── exec → 调用者映射 ──

export interface DshToolCallerOptions {
  /** DSH exec → TDA 调用者上下文（模型发起调用：actor 恒 'agent'）。 */
  resolveCaller(exec: DshToolRunContext): TaskToolCallContext;
}

/** 默认映射：sessionId 取 exec.agent.session.id（宿主未注入 agent 时显式失败）。 */
export function callerFromExec(exec: DshToolRunContext): TaskToolCallContext {
  const id = exec.agent?.session?.id;
  if (typeof id !== 'string' || id === '') {
    throw new TdaError('TOOL_CALLER_UNRESOLVED', 'exec.agent.session.id 缺失：宿主须注入 agent 会话身份');
  }
  return { actor: 'agent' as TaskActor, sessionId: id as SessionId };
}

// ── 直传适配 ──

/**
 * TaskToolDefinition → DSH ToolDefinition 契约形状：
 *  - name/description/parameters **原样直传**（tools.ts 的 JSON Schema 即为此准备）；
 *  - execute 先过参数子集门（违规即 TOOL_INVALID_ARGS，对应 defineTool 内联
 *    validate→ToolArgsError 的位置），再映射调用者进 handler；handler 返回的
 *    JsonObject 过 output 门（{type:'object'}——canonical value 面，真 output
 *    schema 随 DSH 宿主拍板）；
 *  - render：Native 文本投影（JSON.stringify——模型可读的最小面）。
 */
export function toDshToolDefinition(
  def: TaskToolDefinition,
  options: Partial<DshToolCallerOptions> = {},
): DshToolDefinition {
  const resolveCaller = options.resolveCaller ?? callerFromExec;
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: { type: 'object' },
      render(_args: unknown, value: unknown): readonly DshTextContentBlock[] {
        return [{ type: 'text', text: JSON.stringify(value) }];
      },
    },
    async execute(args: unknown, exec: DshToolRunContext): Promise<unknown> {
      const violations = validateJsonSchemaSubset(def.parameters, args, '');
      if (violations.length > 0) {
        throw new TdaError('TOOL_INVALID_ARGS', `参数校验失败：${violations.join('; ')}`);
      }
      const value = await def.handler(args as JsonObject, resolveCaller(exec));
      const outputViolations = validateJsonSchemaSubset({ type: 'object' }, value, 'output');
      if (outputViolations.length > 0) {
        throw new TdaError('TOOL_OUTPUT_INVALID', `输出不符 canonical 形状：${outputViolations.join('; ')}`);
      }
      return value;
    },
  };
}

// ── 注册宿主（ToolRuntime.register/execute 语义镜像；本体随 DSH 宿主接管）──

export interface DshToolRegistry {
  /** 注册（返回精确反注册 disposer；重名/保留名/render 缺失即拒）。 */
  register(definition: DshToolDefinition): () => void;
  /** 模型可见工具面投影（listTools 语义）。 */
  list(): readonly DshToolSchema[];
  has(name: string): boolean;
  /** 经定义侧 execute（参数门内建）执行；未知名显式失败。 */
  execute(name: string, args: unknown, exec: DshToolRunContext): Promise<unknown>;
  readonly names: readonly string[];
}

export function createDshToolRegistry(): DshToolRegistry {
  const tools = new Map<string, DshToolDefinition>();
  return {
    register(definition: DshToolDefinition): () => void {
      const name = definition.name;
      if (name === RUN_CODE_RESERVED_NAME) {
        throw new TdaError('TOOL_NAME_RESERVED', `工具名 "${name}" 为 PTC 模式呈现传输保留（DSH ToolRuntime.register 同语义）`);
      }
      if (tools.has(name)) {
        throw new TdaError('TOOL_NAME_DUP', `工具重名：${name}`);
      }
      const output = (definition as Partial<DshToolDefinition>).output;
      if (
        output === undefined
        || typeof output !== 'object'
        || typeof output.render !== 'function'
        || (output as { presentationMeta?: unknown }).presentationMeta !== undefined
          && typeof (output as { presentationMeta?: unknown }).presentationMeta !== 'function'
      ) {
        throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
      }
      tools.set(name, definition);
      return () => {
        if (tools.get(name) === definition) tools.delete(name);
      };
    },
    list(): readonly DshToolSchema[] {
      return [...tools.values()].map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }));
    },
    has(name: string): boolean {
      return tools.has(name);
    },
    async execute(name: string, args: unknown, exec: DshToolRunContext): Promise<unknown> {
      const definition = tools.get(name);
      if (definition === undefined) {
        throw new TdaError('TOOL_UNKNOWN', `未知工具：${name}`);
      }
      return definition.execute(args, exec);
    },
    get names(): readonly string[] {
      return [...tools.keys()];
    },
  };
}
