/**
 * T0.5 §4.3 模型可见工具集（挂 `dsh-tda-tool-subagent-dispatch`，最小集）。
 *
 * | 工具 | 动作 | 参数 |
 * |---|---|---|
 * | `tda_dispatch` | 派发 | 仅 taskId + role（brief 由 task 记录构造，J2） |
 * | `dispatch_list` | 读 | 在飞/近期派发裁剪视图 |
 *
 * 硬约束（J4/不变量 1、2）：
 *  - `tda_dispatch` **无自由文本参数**——模型不能把主对话内容粘进 prompt；
 *  - 工具返回**只有裁剪视图**（id/taskId/role/status/risk/outcome/age），
 *    不含 agentOptions/promptHash/approval token/结论正文；
 *  - DSH 原生 `subagent` 工具保留给非任务执行的临时探索，任务执行面一律走本工具。
 */
import { asSessionId, asTaskId, TdaError } from '@tda/kernel';
import type { DispatchRole } from './domain.ts';
import type { DispatchOrderView, SubagentDispatchService } from './service.ts';

export const DISPATCH_TOOL_NAMES = ['tda_dispatch', 'dispatch_list'] as const;
export type DispatchToolName = (typeof DISPATCH_TOOL_NAMES)[number];

export interface DispatchToolCallContext {
  readonly actor: 'human' | 'agent' | 'coach' | 'scheduler';
  readonly sessionId: string;
  readonly depth?: number | undefined;
  readonly lead?: boolean | undefined;
}

export interface DispatchToolDefinition {
  readonly name: DispatchToolName;
  readonly description: string;
  /** 参数 JSON Schema（无自由文本字段）。 */
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
  /** 是否需要人类/Lead 权限（本插件无审批类工具，恒 false）。 */
  readonly requiresHuman: boolean;
  call(ctx: DispatchToolCallContext, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

const toView = (view: DispatchOrderView): DispatchOrderView => view;
export function createDispatchTools(service: SubagentDispatchService): readonly DispatchToolDefinition[] {
  return [
    {
      name: 'tda_dispatch',
      description:
        '把任务派发给子代理（Sidekick/Lead）执行并回收结构化结论。' +
        '参数只有 taskId 与 role：prompt 由任务记录构造，不能传入对话内容。' +
        '结论只以摘要 + entryId 引用回主上下文，不泄露子代理原始输出。',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '派发依据的任务 id' },
          role: { type: 'string', enum: ['sidekick', 'lead'], description: '子代理角色' },
        },
        required: ['taskId', 'role'],
        additionalProperties: false,
      },
      requiresHuman: false,
      async call(ctx, args) {
        const taskId = args.taskId;
        const role = args.role;
        if (typeof taskId !== 'string' || taskId === '') {
          throw new TdaError('TOOL_ARGS_INVALID', 'tda_dispatch 需要非空 taskId');
        }
        if (role !== 'sidekick' && role !== 'lead') {
          throw new TdaError('TOOL_ARGS_INVALID', 'tda_dispatch 的 role 只能是 sidekick | lead');
        }
        const order = await service.execute(
          {
            actor: ctx.actor,
            sessionId: asSessionId(ctx.sessionId),
            ...(ctx.depth !== undefined ? { depth: ctx.depth } : {}),
            ...(ctx.lead !== undefined ? { lead: ctx.lead } : {}),
          },
          { taskId: asTaskId(taskId), role: role as DispatchRole },
        );
        const view = service.view(order.id);
        if (view === undefined) {
          throw new TdaError('DISPATCH_NOT_FOUND', `派发单消失：${order.id}`);
        }
        return toView(view);
      },
    },
    {
      name: 'dispatch_list',
      description: '列出在飞/近期派发单的裁剪视图（id/taskId/role/status/risk/outcome/age）。',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '可选：只看某任务的派发' },
          status: {
            type: 'string',
            enum: ['requested', 'approved', 'starting', 'running', 'settled', 'cancelled'],
          },
        },
        required: [],
        additionalProperties: false,
      },
      requiresHuman: false,
      async call(_ctx, args) {
        const filter: {
          taskId?: ReturnType<typeof asTaskId>;
          status?: DispatchOrderView['status'];
        } = {
          ...(typeof args.taskId === 'string' && args.taskId !== '' ? { taskId: asTaskId(args.taskId) } : {}),
          ...(typeof args.status === 'string' ? { status: args.status as DispatchOrderView['status'] } : {}),
        };
        return service
          .list(filter)
          .map((order) => service.view(order.id))
          .filter((view): view is DispatchOrderView => view !== undefined);
      },
    },
  ];
}
