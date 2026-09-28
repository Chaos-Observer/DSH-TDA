/**
 * tda-task-pool 模型工具集（T0.2 §4.3，挂 `dsh-tda-tool-task-pool`）。
 *
 * 纪律（实现施工方案 §1 全局纪律 3）：
 *  - **模型面裁剪视图**：只读工具返回裁剪字段（不含全快照 diff），
 *    全快照只在 domain 与 log 里（主上下文只留决策与编排，C2）；
 *  - **agent 调用自动待批**：create/edit 经模型面调用一律以 actor='agent' 进服务，
 *    服务侧自动带 `proposedBy='agent'` + `pending_approval`（J9：未批准不可认领）；
 *  - **approve 仅人类/Lead**：工具层不自设例外，服务侧硬拦（TASK_APPROVAL_FORBIDDEN）；
 *  - **零新增写路径**：工具 handler 只调 ctx.taskPool 服务面，不碰 domain/双写器。
 *
 * IT2 形态：框架无关定义（name/description/parameters/handler）。IT3 接 DSH
 * `ctx.tools` 时逐条注册即可，handler 语义不变。
 */
import type { GoalId, JsonObject, SessionId, TaskId } from '@tda/kernel';
import { TdaError } from '@tda/kernel';
import type { TaskActor, TaskNode, TaskStage } from './domain.ts';
import type {
  ConsumedUsage,
  CreateTaskRequest,
  EditTaskRequest,
  TaskListFilter,
  TaskPoolService,
} from './service.ts';

/** 模型可见工具名（规格 §4.3 九项）。 */
export const TASK_POOL_TOOL_NAMES = [
  'task_create',
  'task_edit',
  'task_list',
  'task_get',
  'task_claim',
  'task_release',
  'task_complete',
  'task_propose',
  'task_approve',
] as const;

export type TaskPoolToolName = (typeof TASK_POOL_TOOL_NAMES)[number];

export interface TaskToolCallContext {
  /** 调用者身份：模型发起的调用一律 'agent'；人类面（审批/改派）为 'human'。 */
  readonly actor: TaskActor;
  /** 调用者会话 id（claim 的 owner 归属与 release 鉴权）。 */
  readonly sessionId: SessionId;
  /** 调用者是否为 Lead/人类（approve 与 reassign 的权限判据）。 */
  readonly lead?: boolean;
}

export interface TaskToolDefinition {
  readonly name: TaskPoolToolName;
  readonly description: string;
  /** JSON Schema（IT3 接 DSH 工具注册表时直传）。 */
  readonly parameters: JsonObject;
  handler(args: JsonObject, ctx: TaskToolCallContext): Promise<JsonObject>;
}

/** 裁剪视图：模型面只看到决策所需字段（不含 description/写入作用域/历史）。 */
export const toTaskView = (node: TaskNode): JsonObject => ({
  id: node.id,
  // revision 必在视图内：模型后续 edit/claim/complete 均须回传 expectedRevision（CAS 严格）
  revision: node.revision,
  goalId: node.goalId,
  subject: node.subject,
  phase: node.phase,
  stage: node.stage,
  ...(node.outcome !== undefined ? { outcome: node.outcome } : {}),
  ...(node.blockedReason !== undefined
    ? { blockedReason: { code: node.blockedReason.code, message: node.blockedReason.message } }
    : {}),
  ...(node.ownerId !== undefined ? { ownerId: node.ownerId } : {}),
  ...(node.parentTaskId !== undefined ? { parentTaskId: node.parentTaskId } : {}),
  blockedBy: [...node.blockedBy],
  priority: node.priority,
  zone: node.budget.zone,
  consumed: { ...node.budget.consumed },
  runCount: node.runCount,
  consecutiveFailures: node.consecutiveFailures,
  ...(node.nextDueAt !== undefined ? { nextDueAt: node.nextDueAt } : {}),
  ...(node.schedule.dueAt !== undefined ? { dueAt: node.schedule.dueAt } : {}),
  ...(node.proposal !== undefined ? { proposalStatus: node.proposal.status } : {}),
  ...(node.deletedAt !== undefined ? { deletedAt: node.deletedAt } : {}),
});

const requireString = (args: JsonObject, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new TdaError('TOOL_INVALID_ARGS', `工具参数 ${key} 必填且为非空字符串`);
  }
  return value;
};

const optionalNumber = (args: JsonObject, key: string): number | undefined => {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new TdaError('TOOL_INVALID_ARGS', `工具参数 ${key} 必须为数字`);
  return value;
};

export function createTaskPoolTools(service: TaskPoolService): TaskToolDefinition[] {
  const defs: TaskToolDefinition[] = [
    {
      name: 'task_create',
      description:
        '创建任务（必挂目标）。模型创建即"提议"，处于待批准态、不可认领；human/Lead 创建即生效。',
      parameters: {
        type: 'object',
        required: ['goalId', 'subject'],
        properties: {
          goalId: { type: 'string', description: '挂靠目标 id（必填）' },
          subject: { type: 'string', description: '任务标题' },
          description: { type: 'string' },
          parentTaskId: { type: 'string' },
          blockedBy: { type: 'array', items: { type: 'string' } },
          localPath: { type: 'string', description: 'workspace 相对路径（禁绝对/..）' },
          writeScopes: { type: 'array', items: { type: 'string' } },
          priority: { type: 'number' },
        },
      },
      async handler(args, ctx) {
        const req: CreateTaskRequest = {
          goalId: requireString(args, 'goalId') as GoalId,
          subject: requireString(args, 'subject'),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...(typeof args.parentTaskId === 'string' ? { parentTaskId: args.parentTaskId as TaskId } : {}),
          ...(Array.isArray(args.blockedBy) ? { blockedBy: args.blockedBy as readonly TaskId[] } : {}),
          ...(typeof args.localPath === 'string' ? { localPath: args.localPath } : {}),
          ...(Array.isArray(args.writeScopes) ? { writeScopes: args.writeScopes as readonly string[] } : {}),
          ...(optionalNumber(args, 'priority') !== undefined ? { priority: optionalNumber(args, 'priority') as number } : {}),
        };
        return toTaskView(await service.create(ctx.actor, req));
      },
    },
    {
      name: 'task_propose',
      description: '以 agent 名义提议任务（含周期任务）；一律进待批准队列（J9）。',
      parameters: {
        type: 'object',
        required: ['goalId', 'subject'],
        properties: {
          goalId: { type: 'string' },
          subject: { type: 'string' },
          description: { type: 'string' },
          recurrence: {
            type: 'object',
            description: '周期定义：{ kind: "interval", intervalMs } 或 { kind: "cron", cron }',
          },
        },
      },
      async handler(args) {
        const req: CreateTaskRequest = {
          goalId: requireString(args, 'goalId') as GoalId,
          subject: requireString(args, 'subject'),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...(args.recurrence !== undefined
            ? { recurrence: args.recurrence as never }
            : {}),
        };
        return toTaskView(await service.propose('agent', req));
      },
    },
    {
      name: 'task_approve',
      description: '批准/驳回提议任务（仅人类/Lead；模型自批被服务端硬拦）。',
      parameters: {
        type: 'object',
        required: ['taskId', 'expectedRevision', 'approve'],
        properties: {
          taskId: { type: 'string' },
          expectedRevision: { type: 'number' },
          approve: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      async handler(args, ctx) {
        if (ctx.lead !== true && ctx.actor !== 'human') {
          throw new TdaError('TASK_APPROVAL_FORBIDDEN', '批准提议需人类/Lead 权限');
        }
        const revision = optionalNumber(args, 'expectedRevision');
        if (revision === undefined) throw new TdaError('TOOL_INVALID_ARGS', 'expectedRevision 必填');
        const node = await service.approveProposal(
          'human',
          requireString(args, 'taskId') as TaskId,
          { expectedRevision: revision },
          args.approve === true,
          typeof args.reason === 'string' ? args.reason : undefined,
        );
        return toTaskView(node);
      },
    },
    {
      name: 'task_edit',
      description: '编辑任务字段（title/stage/priority/路径/周期/预算）。CAS：须带 expectedRevision。',
      parameters: {
        type: 'object',
        required: ['taskId', 'expectedRevision'],
        properties: {
          taskId: { type: 'string' },
          expectedRevision: { type: 'number' },
          subject: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'number' },
          stage: { type: 'string', enum: ['planning', 'executing', 'waiting', 'verifying'] },
          localPath: { type: 'string' },
          progress: { type: 'string' },
        },
      },
      async handler(args, ctx) {
        const revision = optionalNumber(args, 'expectedRevision');
        if (revision === undefined) throw new TdaError('TOOL_INVALID_ARGS', 'expectedRevision 必填');
        const req: EditTaskRequest = {
          ...(typeof args.subject === 'string' ? { subject: args.subject } : {}),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...(optionalNumber(args, 'priority') !== undefined ? { priority: optionalNumber(args, 'priority') as number } : {}),
          ...(typeof args.stage === 'string' ? { stage: args.stage as TaskStage } : {}),
          ...(typeof args.localPath === 'string' ? { localPath: args.localPath } : {}),
          ...(typeof args.progress === 'string' ? { progress: args.progress } : {}),
        };
        return toTaskView(
          await service.edit(ctx.actor, requireString(args, 'taskId') as TaskId, { expectedRevision: revision }, req),
        );
      },
    },
    {
      name: 'task_list',
      description: '列出任务裁剪视图（可按目标/阶段/owner/优先级过滤）。',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string' },
          stage: { type: 'string', enum: ['planning', 'executing', 'waiting', 'verifying'] },
          onlyReady: { type: 'boolean', description: '只列可认领集' },
          priorityMin: { type: 'number' },
        },
      },
      async handler(args) {
        const filter: TaskListFilter = {
          ...(typeof args.goalId === 'string' ? { goalId: args.goalId as GoalId } : {}),
          ...(typeof args.stage === 'string' ? { stage: args.stage as TaskStage } : {}),
          ...(optionalNumber(args, 'priorityMin') !== undefined
            ? { priorityMin: optionalNumber(args, 'priorityMin') as number }
            : {}),
        };
        const nodes = args.onlyReady === true ? service.ready(filter) : service.list(filter);
        return { tasks: nodes.map(toTaskView) };
      },
    },
    {
      name: 'task_get',
      description: '读取单个任务裁剪视图 + 最近若干条变更摘要。',
      parameters: {
        type: 'object',
        required: ['taskId'],
        properties: { taskId: { type: 'string' } },
      },
      async handler(args) {
        const id = requireString(args, 'taskId') as TaskId;
        const node = service.get(id);
        if (node === undefined) {
          throw new TdaError('TASK_NOT_FOUND', `任务不存在：${id}`);
        }
        return {
          task: toTaskView(node),
          history: service.history(id).slice(-5).map((record) => ({
            revision: record.revision,
            operation: record.operation,
            actor: record.actor,
            summary: record.summary,
            at: record.at,
          })),
        };
      },
    },
    {
      name: 'task_claim',
      description: '认领任务（进入 executing，owner=当前会话）；依赖未完成/待批准/收敛区会被拒。',
      parameters: {
        type: 'object',
        required: ['taskId', 'expectedRevision'],
        properties: { taskId: { type: 'string' }, expectedRevision: { type: 'number' } },
      },
      async handler(args, ctx) {
        const revision = optionalNumber(args, 'expectedRevision');
        if (revision === undefined) throw new TdaError('TOOL_INVALID_ARGS', 'expectedRevision 必填');
        const node = await service.claim(
          ctx.actor,
          requireString(args, 'taskId') as TaskId,
          { expectedRevision: revision },
          ctx.sessionId,
        );
        return toTaskView(node);
      },
    },
    {
      name: 'task_release',
      description: '释放任务（owner 归还回 planning）。',
      parameters: {
        type: 'object',
        required: ['taskId', 'expectedRevision'],
        properties: { taskId: { type: 'string' }, expectedRevision: { type: 'number' } },
      },
      async handler(args, ctx) {
        const revision = optionalNumber(args, 'expectedRevision');
        if (revision === undefined) throw new TdaError('TOOL_INVALID_ARGS', 'expectedRevision 必填');
        const node = await service.release(
          ctx.actor,
          requireString(args, 'taskId') as TaskId,
          { expectedRevision: revision },
        );
        return toTaskView(node);
      },
    },
    {
      name: 'task_complete',
      description: '完成任务（outcome 必填；预算耗尽时必带 unfinished 清单）。',
      parameters: {
        type: 'object',
        required: ['taskId', 'expectedRevision', 'outcome'],
        properties: {
          taskId: { type: 'string' },
          expectedRevision: { type: 'number' },
          outcome: { type: 'string', enum: ['success', 'failed'] },
          evidence: { type: 'array', items: { type: 'string' } },
          unfinished: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
      },
      async handler(args, ctx) {
        const revision = optionalNumber(args, 'expectedRevision');
        if (revision === undefined) throw new TdaError('TOOL_INVALID_ARGS', 'expectedRevision 必填');
        const outcome = args.outcome === 'failed' ? 'failed' : 'success';
        const node = await service.complete(
          ctx.actor,
          requireString(args, 'taskId') as TaskId,
          { expectedRevision: revision },
          {
            outcome,
            ...(Array.isArray(args.evidence) ? { evidence: args.evidence as readonly string[] } : {}),
            ...(Array.isArray(args.unfinished) ? { unfinished: args.unfinished as readonly string[] } : {}),
            ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
          },
        );
        return toTaskView(node);
      },
    },
  ];
  return defs;
}

/** 预留：预算记账工具面（P0 不开放给模型，仅调度/编排层经服务面调用）。 */
export type ReservedConsumedUsage = ConsumedUsage;
