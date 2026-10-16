/**
 * P5.4 cordis 入口（施工图 §3 插件范式映射的 task-pool 落点）。
 *
 * 形态：`static inject` + Service 子类（与 DSH 自家 BasicCompactionEngine 同范式
 * ——cordis class plugin）。运行层前提：cordis Service 用**参数属性**
 * （constructor `protected ctx`）——必须 `node --experimental-transform-types`
 * （strip-only 报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，2026-10-15 实证；DSH 发货态
 * 走 tsdown 构建产物无此问题）。
 *
 * inject 面（v1 装配期）：单一注入点 `tdaTaskPoolDeps`（束）供给——DSH 宿主接管
 * 后按名拆分为真实底座服务（storage/session/bus/goalLookup 逐名进 inject），
 * 本文件的工具注册语义不变。
 *
 * 工具面：9 个 TaskToolDefinition 经 dshTools.toDshToolDefinition 直传成 DSH
 * ToolDefinition 契约形状；`registerInto` 是 DSH 宿主 `ctx.tools.register` 的
 * 唯一接线点（本体注册随 DSH 宿主/发货态产物接管——装饰器边界实证见 dshTools.ts）。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { asSessionId, type SessionId } from '@tda/kernel';
import type { TaskToolCallContext } from './tools.ts';
import { createTaskPoolTools, TASK_POOL_TOOL_NAMES } from './tools.ts';
import {
  createDshToolRegistry,
  toDshToolDefinition,
  type DshToolDefinition,
  type DshToolRegistry,
  type DshToolRunContext,
} from './dshTools.ts';
import type { TaskPoolService } from './service.ts';

/** 注入束（v1）：任务池服务 + 会话身份兜底解析。 */
export interface TdaTaskPoolDeps {
  readonly taskPool: TaskPoolService;
  /** exec.agent 未携带会话身份时的兜底（宿主当前会话 id）。 */
  readonly sessionId: () => string;
}

/** 注入点服务（`ctx.tdaTaskPoolDeps.value`）。 */
export class TdaTaskPoolDepsService extends Service {
  static override provide = 'tdaTaskPoolDeps';
  readonly value: TdaTaskPoolDeps;
  constructor(ctx: Context, config: TdaTaskPoolDeps) {
    super(ctx);
    this.value = config;
  }
}

/**
 * `ctx.tdaTaskPoolTools`：9 工具的注册宿主（ToolRuntime 语义镜像）。
 * list() 即模型可见 ToolSchema 投影；execute() 经定义侧参数门进真服务面。
 */
export class TdaTaskPoolToolsService extends Service {
  static override provide = 'tdaTaskPoolTools';
  static override inject = ['tdaTaskPoolDeps'];
  readonly registry: DshToolRegistry;
  readonly toolNames: readonly string[] = TASK_POOL_TOOL_NAMES;
  readonly definitions: readonly DshToolDefinition[];

  constructor(ctx: Context) {
    super(ctx);
    const deps = (ctx as Context & { tdaTaskPoolDeps: TdaTaskPoolDepsService }).tdaTaskPoolDeps.value;
    const registry = createDshToolRegistry();
    const definitions: DshToolDefinition[] = [];
    for (const def of createTaskPoolTools(deps.taskPool)) {
      const definition = toDshToolDefinition(def, {
        resolveCaller: (exec: DshToolRunContext): TaskToolCallContext => {
          const id = exec.agent?.session?.id;
          return typeof id === 'string' && id !== ''
            ? { actor: 'agent', sessionId: id as SessionId }
            : { actor: 'agent', sessionId: asSessionId(deps.sessionId()) };
        },
      });
      definitions.push(definition);
      registry.register(definition);
    }
    this.registry = registry;
    this.definitions = definitions;
  }

  /**
   * DSH 宿主接线点：把全部定义注册进 `ctx.tools`（每个返回精确 disposer）。
   * 本体 = DSH ToolRuntime（发货态产物/宿主内置）；本方法只消费其 register 门。
   */
  registerInto(host: { register(definition: DshToolDefinition): () => void }): readonly (() => void)[] {
    return this.definitions.map((definition) => host.register(definition));
  }
}
