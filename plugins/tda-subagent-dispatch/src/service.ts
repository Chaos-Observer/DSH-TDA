/**
 * tda-subagent-dispatch 服务：ctx.subagentDispatch 服务面实现（T0.5 §4.2）。
 *
 * 设计裁定落地：
 *  - **派发策略层自建、执行通道复用**（J1）：本服务不实现执行器，只经
 *    `SubagentProvider` seam 调 one-shot `start()`（DSH `ctx.subagents` 的
 *    结构镜像），拿到 `SubagentRun{id,result,dispose}` 后自行编排
 *    claim → await → settle → dispose；
 *  - **prompt 只从任务记录构造**（J2）：`buildBrief` 的入参是 `DispatchTaskView`
 *    白名单窄视图，签名上拿不到主会话 surface/injection/pinned 句柄——输入隔离
 *    成为类型级保证（单测以"注入会话密钥不出现在 prompt"自证）；
 *  - **结论 schema 白名单强制**（J4）：schema 由 outputSchemaId 决定，字段名过
 *    指令词黑名单；structured 校验失败即降级 `conclusion-partial`，不当成功；
 *  - **主上下文零泄漏**（J5）：回传只落两处——`timeline.append`（model-produced）
 *    与 dispatch 记录；服务对外只暴露 `ConclusionView` 摘要 + entryId 引用；
 *  - **三层审计**（J11）：状态变更双写 `dispatch/change` LOG-ONLY 事件（全快照）；
 *    provider 的 `subagent/start|end` 观察事件与子会话 log 由装配层对账；
 *  - **服务从不改任务状态**（J4/不变量 6）：只 claim/release owner 与 consume 记账，
 *    `complete` 等任务定义变更必经 `taskPool` CAS。
 *
 * 相对规格签名的必要超集（不变量驱动，同 T0.1/T0.2 先例）：
 *  1. 所有 mutation 带 `DispatchRef`（expectedRevision）——CAS 严格（不变量 10/§4.1-9）；
 *  2. `approve/reject` 带 caller——"人类或 Lead 代行"需可判（J9）；
 *  3. `start/settle/cancel` 带 caller——审计归因与 owner 释放需可判；
 *  4. `buildBrief` 带 role——结论 schema 按角色分（J6 sidekick/lead 两套）；
 *  5. `DispatchResult.summary` / `orphaned` 与 `reconcileOrphans()`——前者供
 *     ConclusionView 渲染（J5），后者给宿主重启的在途 run 落显式终态（C5）。
 *
 * 进程内互斥锁：状态迁移 + 预算/owner 记账是复合写；**await 子代理结果与
 * run.dispose() 在锁外**（否则长跑子代理会阻塞 cancel）。
 */
import {
  allocateId,
  dualWrite,
  StaleRevisionError,
  TdaError,
  type AuditIndex,
  type DispatchId,
  type DualWriteContext,
  type DualWriteReconciler,
  type GoalId,
  type Revision,
  type SessionId,
  type TdaDomain,
  type TdaEventBus,
  type TdaSessionSink,
  type TaskId,
} from '@tda/kernel';
import {
  DISPATCH_TERMINAL,
  ROLE_SCHEMAS,
  ZERO_DISPATCH_CONSUMED,
  defaultSchemaOf,
  type AgentOptions,
  type DispatchActor,
  type DispatchApproval,
  type DispatchConsumed,
  type DispatchOrder,
  type DispatchOutcome,
  type DispatchResult,
  type DispatchRole,
  type DispatchSchemaId,
  type DispatchStatus,
  type DispatchTables,
  type RolePolicy,
} from './domain.ts';
import { dispatchChangePayload, dispatchPolicyPayload } from './events.ts';
import {
  assertConclusionSchema,
  conclusionView,
  CONCLUSION_SCHEMAS,
  validateConclusion,
  type ConclusionView,
  type ObjectJsonSchema,
} from './schema.ts';
import {
  assessRisk,
  assertToolFilterSafe,
  defaultRolePolicies,
  renderPersona,
  type DispatchTaskView,
} from './policy.ts';

export type { DispatchTaskView } from './policy.ts';

export interface DispatchRef {
  readonly expectedRevision: Revision;
}

export interface DispatchCaller {
  readonly actor: DispatchActor;
  readonly sessionId: SessionId;
  /** 目标会话的委派深度（不变量 5：只允许 depth=0）。 */
  readonly depth?: number | undefined;
  /** Lead 代行审批（J9：high 风险须人类或 Lead 代行批准）。 */
  readonly lead?: boolean | undefined;
}

export interface DispatchRequest {
  readonly taskId: TaskId;
  readonly role: DispatchRole;
  /** 审计文本（不进 brief，J2 禁止任务外的自由文本进 prompt）。 */
  readonly note?: string;
  /** 任务自带风险提示（J9 的 riskHint；TaskNode 无此列，故经请求带入）。 */
  readonly riskHint?: boolean;
  /** 覆盖角色默认 maxTokens（超策略阈值即升 high）。 */
  readonly maxTokens?: number;
  /**
   * 结论 schema 覆盖（仅**内部消费方**使用，如 T0.6 工作区标注）；必须是本角色
   * 允许的 schema（domain.ts ROLE_SCHEMAS）。模型通道不暴露此参数（工具只收
   * taskId+role），故"换 schema 绕白名单"对模型不可达。
   */
  readonly schemaId?: DispatchSchemaId;
}

export interface DispatchFilter {
  readonly taskId?: TaskId;
  readonly goalId?: GoalId;
  readonly role?: DispatchRole;
  readonly status?: DispatchStatus;
  readonly risk?: 'low' | 'high';
  readonly outcome?: DispatchOutcome;
}

/** 派发单裁剪视图（模型面 `dispatch_list`；不含 agentOptions/promptHash/凭据）。 */
export interface DispatchOrderView {
  readonly id: string;
  readonly taskId: string;
  readonly role: DispatchRole;
  readonly status: DispatchStatus;
  readonly risk: 'low' | 'high';
  readonly outcome?: DispatchOutcome;
  readonly ageMs: number;
}

export interface ContentBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface DispatchBrief {
  readonly prompt: readonly ContentBlock[];
  readonly outputSchema: ObjectJsonSchema;
  readonly outputSchemaId: DispatchSchemaId;
  readonly promptHash: string;
}

export interface SubagentCapabilities {
  readonly agentOptions: boolean;
  readonly outputSchema: boolean;
  readonly depthLimit: boolean;
  readonly toolFilter: boolean;
  readonly persona: boolean;
}

export interface SubagentStartRequest {
  readonly orderId: DispatchId;
  readonly role: DispatchRole;
  readonly prompt: readonly ContentBlock[];
  readonly outputSchema: ObjectJsonSchema;
  readonly agentOptions: AgentOptions;
  readonly toolFilter: readonly string[];
  readonly maxDepth: 0;
  readonly persona: string;
  readonly parent: SessionId;
  readonly inheritsParentContext: false;
}

export interface SubagentUsage {
  readonly tokens?: number;
  readonly toolCalls?: number;
  readonly wallClockMs?: number;
}

/** DSH `SubagentResult` 的结构镜像（只取 dispatch 需要的面）。 */
export interface SubagentResultLike {
  readonly stopReason: string;
  readonly structured?: unknown;
  readonly diagnostic?: string;
  readonly usage?: SubagentUsage;
}

/** DSH `SubagentRun` 的结构镜像：id 即子会话 id（claim owner）。 */
export interface SubagentRun {
  readonly id: SessionId;
  readonly result: Promise<SubagentResultLike>;
  dispose(): Promise<void>;
}

/** DSH `ctx.subagents` 的派发侧切片（spawn provider）。 */
export interface SubagentProvider {
  readonly name: string;
  readonly capabilities: SubagentCapabilities;
  start(req: SubagentStartRequest): Promise<SubagentRun>;
}

/** 任务池 seam（ctx.taskPool 的结构子集）。 */
export interface DispatchTaskPoolSeam {
  get(id: string): DispatchTaskView | undefined;
  claim(actor: DispatchActor, id: string, ref: { expectedRevision: number }, ownerId: string): Promise<unknown>;
  release(actor: DispatchActor, id: string, ref: { expectedRevision: number }): Promise<unknown>;
  consume(
    actor: DispatchActor,
    id: string,
    ref: { expectedRevision: number },
    usage: { tokens?: number; toolCalls?: number; wallClockMs?: number; attentionUnits?: number },
  ): Promise<unknown>;
}

/** 时间线 seam（ctx.timeline.append 的结构子集，J5 结论落点①）。 */
export interface DispatchTimelineSeam {
  append(
    writer: { readonly sessionId: string; readonly actor: DispatchActor; readonly at: number },
    chunk: {
      readonly content: string;
      readonly chunkType: 'fact' | 'method' | 'reflection' | 'skill';
      readonly source: 'task' | 'conversation' | 'study' | 'harness';
      readonly credential: 'user-original' | 'execution-verified' | 'model-produced' | 'tool-output' | 'external-content';
      readonly relatedTaskId?: string;
      readonly trajectoryLink?: string;
      readonly confidence?: number;
    },
  ): Promise<{ readonly id: string }>;
}

export interface DispatchStartResult {
  readonly order: DispatchOrder;
  readonly started: boolean;
  readonly queued: boolean;
}

export interface SubagentDispatchService {
  dispatch(caller: DispatchCaller, req: DispatchRequest): Promise<DispatchOrder>;
  approve(caller: DispatchCaller, orderId: DispatchId, ref: DispatchRef): Promise<DispatchOrder>;
  reject(caller: DispatchCaller, orderId: DispatchId, ref: DispatchRef, reason: string): Promise<DispatchOrder>;
  start(caller: DispatchCaller, orderId: DispatchId, ref: DispatchRef): Promise<DispatchStartResult>;
  settle(caller: DispatchCaller, orderId: DispatchId, ref: DispatchRef): Promise<DispatchOrder>;
  cancel(caller: DispatchCaller, orderId: DispatchId, ref: DispatchRef): Promise<DispatchOrder>;
  /** 便捷全序：派发 → 开跑 → 收尾（供工作区标注等内部消费方）。 */
  execute(caller: DispatchCaller, req: DispatchRequest): Promise<DispatchOrder>;
  /** 排空并发帽内可开跑的排队单（Harness tick / 派发方在 settle/cancel 后调用）。 */
  pump(caller: DispatchCaller): Promise<DispatchStartResult[]>;
  list(filter?: DispatchFilter): DispatchOrder[];
  get(orderId: DispatchId): DispatchOrder | undefined;
  view(orderId: DispatchId): DispatchOrderView | undefined;
  policy(role?: DispatchRole): RolePolicy | RolePolicy[];
  setPolicy(actor: DispatchActor, policy: RolePolicy): Promise<RolePolicy>;
  buildBrief(task: DispatchTaskView, role: DispatchRole, schemaId?: DispatchSchemaId): DispatchBrief;
  conclusionOf(orderId: DispatchId): ConclusionView | undefined;
  inFlight(): DispatchOrder[];
  queued(): readonly string[];
  /** 宿主重启后在途单的显式终态（C5）。 */
  reconcileOrphans(): Promise<DispatchOrder[]>;
  /**
   * 装配期初始化（**必须在注册不变量前调用**）：策略种子 + 孤儿单收口。
   *
   * 装配期教训（IT3 集成门）：加载期不变量所依赖的域状态（两角色策略行、
   * 在途单已收口）必须由启动序**主动建立**，不能挂在"首次使用时才种子"的
   * 惰性路径上——否则一个从未派发过的运行时会带着空策略表过不了自己的门。
   */
  /** 返回本次收口的孤儿单 id（IT4 resume 证据：ResumeEvidence.orphanDispatches）。 */
  initialize(): Promise<readonly string[]>;
}

export interface SubagentDispatchDeps {
  readonly domain: TdaDomain<DispatchTables>;
  readonly session: TdaSessionSink;
  readonly provider: SubagentProvider;
  readonly reconciler?: DualWriteReconciler;
  readonly index?: AuditIndex;
  readonly bus?: TdaEventBus;
  readonly taskPool?: DispatchTaskPoolSeam;
  readonly timeline?: DispatchTimelineSeam;
  readonly now?: () => number;
  /** 全局在飞帽（J10，默认 3）。 */
  readonly maxParallel?: number;
  /** 角色策略种子（缺省用 defaultRolePolicies）。 */
  readonly policies?: readonly RolePolicy[];
}

const ZERO_USAGE: DispatchConsumed = { ...ZERO_DISPATCH_CONSUMED };

/**
 * 收尾型派发的判据（J7 ②的落地口径）：**只读型侦察**（Sidekick + read-only）。
 *
 * 规格 J7 ① 已把可派 stage 限死为 {planning, executing}，故"收尾型"不能靠
 * `stage=verifying` 表达（verifying 在 ① 就被拒了）。取与预算纪律同向的读法：
 * 收敛区停止的是"再开新的写入型工作"，补证据的只读侦察仍可放行。
 */
export const isClosingDispatch = (policy: RolePolicy): boolean =>
  policy.role === 'sidekick' && policy.sandbox === 'read-only';

const usageOf = (usage?: SubagentUsage): DispatchConsumed => ({
  tokens: usage?.tokens ?? 0,
  toolCalls: usage?.toolCalls ?? 0,
  wallClockMs: usage?.wallClockMs ?? 0,
});

/** FNV-1a 64 位（BigInt 实现，跨平台稳定）：brief 内容指纹，供审计对账。 */
export function hashBrief(text: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** §2.1 stopReason → outcome 映射（未知变体一律按 error）。 */
export function mapStopReason(stopReason: string, structuredOk: boolean, hasStructured: boolean): DispatchOutcome {
  switch (stopReason) {
    case 'completed':
      if (!hasStructured || !structuredOk) return 'conclusion-partial';
      return 'conclusion';
    case 'aborted':
      return 'aborted';
    default:
      // error / max-tokens / refusal / 未知变体
      return 'error';
  }
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** provider 诊断消毒契约（§5）：≤4096 UTF-8 字节，超出即截断并标注。 */
export function sanitizeDiagnostic(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (byteLength(raw) <= 4096) return raw;
  const buffer = Buffer.from(raw, 'utf8').subarray(0, 4096);
  return `${buffer.toString('utf8')}（诊断超 4096 字节已截断）`;
}

export function createSubagentDispatchService(deps: SubagentDispatchDeps): SubagentDispatchService {
  const orders = deps.domain.table('dispatch_orders');
  const policies = deps.domain.table('dispatch_policy');
  const clock = deps.now ?? ((): number => Date.now());
  const totalMaxParallel = deps.maxParallel ?? 3;

  const context: DualWriteContext = {
    ...(deps.reconciler ? { reconciler: deps.reconciler } : {}),
    ...(deps.index ? { index: deps.index } : {}),
  };

  /** 在飞 run（进程内；重启后由 reconcileOrphans 收口）。 */
  const inFlight = new Map<string, SubagentRun>();
  /** 排队单（进程内，按 T0.2 dispatch 序排序）。 */
  const queue = new Set<string>();

  let lock: Promise<unknown> = Promise.resolve();
  const withLock = async <T>(op: () => Promise<T>): Promise<T> => {
    const result = lock.then(op, op);
    lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const mustGet = (orderId: DispatchId): DispatchOrder => {
    const order = orders.get(orderId);
    if (order === undefined) {
      throw new TdaError('DISPATCH_NOT_FOUND', `派发单不存在：${orderId}`);
    }
    return order;
  };

  /** CAS 前置：期望修订号不匹配即抛 STALE_REVISION（先于一切状态判据）。 */
  const fresh = (order: DispatchOrder, ref: DispatchRef): DispatchOrder => {
    if (order.revision !== ref.expectedRevision) {
      throw new StaleRevisionError(order.id, ref.expectedRevision, order.revision);
    }
    return order;
  };

  const policyOf = (role: DispatchRole): RolePolicy => {
    const cached = policies.get(role);
    if (cached === undefined) {
      throw new TdaError('DISPATCH_POLICY_MISSING', `角色 ${role} 无策略行（dispatch_policy 必覆盖两角色）`);
    }
    return cached;
  };

  /** 单次状态变更统一出口：domain 先行 → append 事件 → 分发总线（同调用栈）。 */
  const commit = async (order: DispatchOrder): Promise<DispatchOrder> => {
    const payload = dispatchChangePayload(order);
    const seq = await dualWrite(
      deps.session,
      {
        family: 'dispatch/change',
        businessId: order.id,
        payload,
        domainWrite: async () => {
          await orders.put(order.id, order);
        },
      },
      context,
    );
    if (deps.bus !== undefined) {
      deps.bus.publish({
        family: 'dispatch/change',
        businessId: order.id,
        payload,
        seq,
        sessionId: deps.session.sessionId,
      });
    }
    return order;
  };

  /** 策略行变更（§3.3 可审计变更）：与派发单共用族，businessId 前缀区分。 */
  const commitPolicy = async (policy: RolePolicy, actor: DispatchActor, at: number): Promise<RolePolicy> => {
    const payload = dispatchPolicyPayload(policy, actor, at);
    await dualWrite(
      deps.session,
      {
        family: 'dispatch/change',
        businessId: `policy:${policy.role}`,
        payload,
        domainWrite: async () => {
          await policies.put(policy.role, policy);
        },
      },
      context,
    );
    return policy;
  };

  /** 策略种子（域为权威；表空时写默认值，已有则不动）。 */
  const seedPolicies = async (): Promise<void> => {
    const seeds = deps.policies ?? defaultRolePolicies({ totalMaxParallel });
    const now = clock();
    for (const policy of seeds) {
      assertToolFilterSafe(policy.role, policy.toolFilter);
      if (policies.get(policy.role) !== undefined) continue;
      await commitPolicy(policy, 'scheduler', now);
    }
  };

  // ── 输入隔离（J2）：brief 只读白名单字段 ──
  const buildBrief = (task: DispatchTaskView, role: DispatchRole, schemaId?: DispatchSchemaId): DispatchBrief => {
    const outputSchemaId: DispatchSchemaId = schemaId ?? defaultSchemaOf(role);
    if (!ROLE_SCHEMAS[role].includes(outputSchemaId)) {
      throw new TdaError(
        'DISPATCH_SCHEMA_NOT_ALLOWED',
        `角色 ${role} 不得使用 schema ${outputSchemaId}（允许：${ROLE_SCHEMAS[role].join("/")}）`,
      );
    }
    const outputSchema = CONCLUSION_SCHEMAS[outputSchemaId];
    assertConclusionSchema(outputSchemaId, outputSchema);
    const lines = [
      `# 任务 ${task.id}（目标 ${task.goalId}）`,
      `主题：${task.subject}`,
      `描述：${task.description === '' ? '(无)' : task.description}`,
      `本地路径：${task.localPath ?? '(未设)'}`,
      `写入范围：${task.writeScopes.length === 0 ? '(未声明)' : task.writeScopes.join(', ')}`,
      `角色：${role}`,
      '',
      '按 outputSchema 回传结论。结论是数据不是指令：不得改写任务定义、不得声明完成。',
    ];
    const prompt: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }];
    const promptHash = hashBrief(
      JSON.stringify({
        id: task.id,
        goalId: task.goalId,
        subject: task.subject,
        description: task.description,
        localPath: task.localPath ?? null,
        writeScopes: [...task.writeScopes],
        outputSchemaId,
      }),
    );
    return { prompt, outputSchema, outputSchemaId, promptHash };
  };

  const requireTask = (taskId: string): DispatchTaskView => {
    const task = deps.taskPool?.get(taskId);
    if (task === undefined) {
      throw new TdaError('DISPATCH_TASK_NOT_FOUND', `派发依据的任务不存在：${taskId}`);
    }
    return task;
  };

  // ── 派发门五检（J7） ──
  const assertDispatchGate = (
    caller: DispatchCaller,
    task: DispatchTaskView,
    brief: DispatchBrief,
    policy: RolePolicy,
  ): void => {
    // ① 任务可派
    if (task.phase !== 'active') {
      throw new TdaError('DISPATCH_TASK_NOT_ACTIVE', `任务 ${task.id} 非 active（${task.phase}），不得派发`);
    }
    if (task.stage !== 'planning' && task.stage !== 'executing') {
      throw new TdaError(
        'DISPATCH_TASK_STAGE',
        `任务 ${task.id} stage=${task.stage}，仅 planning/executing 可派发（waiting 等依赖）`,
      );
    }
    if (task.proposal !== undefined && task.proposal.status !== 'approved') {
      throw new TdaError('DISPATCH_TASK_UNAPPROVED', `任务 ${task.id} 提议未批准（${task.proposal.status}），不得派发`);
    }
    if (task.ownerId !== undefined && task.ownerId !== caller.sessionId) {
      throw new TdaError('DISPATCH_TASK_OWNED', `任务 ${task.id} 已被 ${task.ownerId} 认领，不得并发派发`);
    }
    // ② 预算三区（承 T0.2 J6 三区行为）：耗尽禁一切；收敛区只放"收尾型"派发
    if (task.budget.zone === 'exhausted') {
      throw new TdaError('BUDGET_EXHAUSTED', `任务 ${task.id} 预算耗尽（exhausted），禁止一切新派发`);
    }
    if (task.budget.zone === 'converge' && !isClosingDispatch(policy)) {
      throw new TdaError(
        'BUDGET_CONVERGE',
        `任务 ${task.id} 处于收敛区（converge），仅放行收尾型派发（只读侦察补证据；写入型工作须提额）`,
      );
    }
    // ③ provider capability fail-loud（不静默降级）
    const caps = deps.provider.capabilities;
    const required: readonly (keyof SubagentCapabilities)[] = [
      'agentOptions',
      'outputSchema',
      'depthLimit',
      'toolFilter',
      'persona',
    ];
    for (const key of required) {
      if (!caps[key]) {
        throw new TdaError(
          'UNSUPPORTED_CAPABILITY',
          `provider "${deps.provider.name}" 不支持 ${key}（capability 门 fail-loud，不静默降级）`,
        );
      }
    }
    // ④ outputSchema 合法（object-rooted + 无指令字段 + additionalProperties:false）
    assertConclusionSchema(brief.outputSchemaId, brief.outputSchema);
    // ⑤ 深度封顶：只允许为 depth=0 会话建单
    if ((caller.depth ?? 0) !== 0) {
      throw new TdaError(
        'DISPATCH_DEPTH_EXCEEDED',
        `目标会话 depth=${caller.depth ?? 0}，只允许为 depth=0 会话派发（不变量 5）`,
      );
    }
    // ⑥ 工具面静态安全（J6）：写类能力不得进子代理
    assertToolFilterSafe(policy.role, policy.toolFilter);
  };

  // ── 并发帽 ──
  const inflightOfRole = (role: DispatchRole): number => {
    let count = 0;
    for (const key of inFlight.keys()) {
      if (orders.get(key)?.role === role) count += 1;
    }
    return count;
  };

  const capacityAvailable = (role: DispatchRole): boolean => {
    if (inFlight.size >= totalMaxParallel) return false;
    return inflightOfRole(role) < policyOf(role).maxParallel;
  };

  /** 排队序（承 T0.2 dispatch 序）：任务 priority 降 → 建单时刻升。 */
  const queueOrder = (): DispatchOrder[] =>
    [...queue]
      .map((id) => orders.get(id))
      .filter((order): order is DispatchOrder => order !== undefined)
      .sort((a, b) => {
        const priorityA = deps.taskPool?.get(a.taskId)?.priority ?? 0;
        const priorityB = deps.taskPool?.get(b.taskId)?.priority ?? 0;
        if (priorityA !== priorityB) return priorityB - priorityA;
        return a.createdAt - b.createdAt;
      });

  /** 一次性凭据消费：摘除 token、留 consumedAt（exactOptionalPropertyTypes：不挂 undefined 键）。 */
  const consumeToken = (approval: DispatchApproval | undefined, at: number): DispatchApproval | undefined => {
    if (approval === undefined) return undefined;
    const next: DispatchApproval = {
      status: approval.status,
      at: approval.at,
      ...(approval.by !== undefined ? { by: approval.by } : {}),
      consumedAt: approval.consumedAt ?? at,
      ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
    };
    return next;
  };

  // ── 主体 ──
  const dispatchInternal = async (caller: DispatchCaller, req: DispatchRequest): Promise<DispatchOrder> =>
    withLock(async () => {
      const task = requireTask(req.taskId);
      const policy = policyOf(req.role);
      const brief = buildBrief(task, req.role, req.schemaId);
      const agentOptions: AgentOptions = {
        ...policy.agentOptions,
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      };
      assertDispatchGate(caller, task, brief, policy);

      const at = clock();
      const assessment = assessRisk({
        role: req.role,
        policy,
        agentOptions,
        task,
        ...(req.riskHint !== undefined ? { riskHint: req.riskHint } : {}),
      });
      const id = allocateId(orders, 'dispatch') as DispatchId;
      const approval: DispatchApproval | undefined = assessment.risk === 'high' ? { status: 'pending', at } : undefined;
      const order: DispatchOrder = {
        id,
        revision: 0,
        taskId: task.id,
        goalId: task.goalId,
        role: req.role,
        mode: 'spawn',
        provider: 'spawn',
        agentOptions,
        toolFilter: [...policy.toolFilter],
        maxDepth: 0,
        sandbox: policy.sandbox,
        personaTemplateId: policy.personaTemplateId,
        outputSchemaId: brief.outputSchemaId,
        risk: assessment.risk,
        ...(approval !== undefined ? { approval } : {}),
        status: assessment.risk === 'high' ? 'requested' : 'approved',
        promptHash: brief.promptHash,
        createdAt: at,
      };
      return commit(order);
    });

  const approve = async (caller: DispatchCaller, orderId: DispatchId, ref: DispatchRef): Promise<DispatchOrder> =>
    withLock(async () => {
      if (caller.actor !== 'human' && caller.lead !== true) {
        throw new TdaError('DISPATCH_APPROVAL_FORBIDDEN', '审批仅限人类或 Lead 代行（J9）');
      }
      const order = fresh(mustGet(orderId), ref);
      if (order.status !== 'requested') {
        throw new TdaError('INVALID_TRANSITION', `派发单 ${order.id} 状态 ${order.status}，仅 requested 可批准`);
      }
      const at = clock();
      const next: DispatchOrder = {
        ...order,
        revision: order.revision + 1,
        status: 'approved',
        approval: {
          status: 'approved',
          at,
          by: caller.actor,
          // 一次性批准凭据（消费后摘除，防重放）
          token: `tok-${order.id}-${order.revision + 1}`,
        },
      };
      return commit(next);
    });

  const reject = async (
    caller: DispatchCaller,
    orderId: DispatchId,
    ref: DispatchRef,
    reason: string,
  ): Promise<DispatchOrder> =>
    withLock(async () => {
      if (caller.actor !== 'human' && caller.lead !== true) {
        throw new TdaError('DISPATCH_APPROVAL_FORBIDDEN', '审批仅限人类或 Lead 代行（J9）');
      }
      const order = fresh(mustGet(orderId), ref);
      if (DISPATCH_TERMINAL.has(order.status)) {
        throw new TdaError('INVALID_TRANSITION', `派发单 ${order.id} 已是终态 ${order.status}`);
      }
      const at = clock();
      const next: DispatchOrder = {
        ...order,
        revision: order.revision + 1,
        status: 'cancelled',
        approval: { status: 'rejected', at, by: caller.actor, reason },
        settledAt: at,
      };
      return commit(next);
    });

  const startInternal = async (
    caller: DispatchCaller,
    orderId: DispatchId,
    ref: DispatchRef,
  ): Promise<DispatchStartResult> =>
    withLock(async () => {
      const order = fresh(mustGet(orderId), ref);
      if (order.status !== 'approved') {
        throw new TdaError('INVALID_TRANSITION', `派发单 ${order.id} 状态 ${order.status}，仅 approved 可开跑`);
      }
      if (!capacityAvailable(order.role)) {
        queue.add(order.id);
        return { order, started: false, queued: true };
      }
      // 开跑前复核任务仍可派（建单到开跑之间任务可能已收敛/终态）
      const task = requireTask(order.taskId);
      if (task.phase !== 'active') {
        throw new TdaError('DISPATCH_TASK_NOT_ACTIVE', `任务 ${task.id} 已非 active（${task.phase}），拒绝开跑`);
      }
      if (task.budget.zone === 'exhausted') {
        throw new TdaError('BUDGET_EXHAUSTED', `任务 ${task.id} 预算已耗尽，拒绝开跑（三区行为）`);
      }

      const brief = buildBrief(task, order.role, order.outputSchemaId);
      const at = clock();
      const approval = consumeToken(order.approval, at);
      const starting: DispatchOrder = {
        ...order,
        revision: order.revision + 1,
        status: 'starting',
        ...(approval !== undefined ? { approval } : {}),
      };
      await commit(starting);

      let run: SubagentRun;
      try {
        run = await deps.provider.start({
          orderId: starting.id,
          role: starting.role,
          prompt: brief.prompt,
          outputSchema: brief.outputSchema,
          agentOptions: starting.agentOptions,
          toolFilter: starting.toolFilter,
          maxDepth: 0,
          persona: renderPersona(starting.personaTemplateId, {
            taskId: starting.taskId,
            role: starting.role,
            subject: task.subject,
            localPath: task.localPath ?? '',
            goalId: starting.goalId,
          }),
          parent: caller.sessionId,
          inheritsParentContext: false,
        });
      } catch (error) {
        const failed: DispatchOrder = {
          ...starting,
          revision: starting.revision + 1,
          status: 'settled',
          settledAt: clock(),
          result: {
            stopReason: 'error',
            outcome: 'error',
            diagnostic: sanitizeDiagnostic(`provider.start 失败：${error instanceof Error ? error.message : String(error)}`),
            consumed: { ...ZERO_USAGE },
          },
        };
        await commit(failed);
        throw error;
      }

      inFlight.set(starting.id, run);
      const running: DispatchOrder = {
        ...starting,
        revision: starting.revision + 1,
        status: 'running',
        childSessionId: String(run.id),
      };
      await commit(running);

      // 子会话即 owner（§4.2 执行序）
      if (deps.taskPool !== undefined && task.ownerId === undefined) {
        try {
          await deps.taskPool.claim('scheduler', running.taskId, { expectedRevision: task.revision }, String(run.id));
        } catch (error) {
          // 认领失败：run 已发布却不能占位——取消并显式终态，不静默留僵尸
          await run.dispose();
          inFlight.delete(running.id);
          const cancelled: DispatchOrder = {
            ...running,
            revision: running.revision + 1,
            status: 'cancelled',
            settledAt: clock(),
          };
          await commit(cancelled);
          throw error;
        }
      }
      return { order: running, started: true, queued: false };
    });

  /** 子代理消耗汇入任务预算（J8）：CAS 过期即重读重试（重试责任在调用方）。 */
  const consumeTask = async (taskId: string, usage: DispatchConsumed, attentionUnits: number): Promise<void> => {
    if (deps.taskPool === undefined) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = deps.taskPool.get(taskId);
      if (task === undefined) return;
      try {
        await deps.taskPool.consume(
          'scheduler',
          taskId,
          { expectedRevision: task.revision },
          {
            tokens: usage.tokens,
            toolCalls: usage.toolCalls,
            wallClockMs: usage.wallClockMs,
            attentionUnits,
          },
        );
        return;
      } catch (error) {
        if ((error as { code?: string }).code === 'STALE_REVISION' && attempt < 2) continue;
        throw error;
      }
    }
  };

  /**
   * 归还认领——**只归还自己那份**（owner 必须等于本派发的子会话 id）。
   *
   * 交叉场景（IT3 装配期发现）：工作区标注的派发发生在任务已被调度器开窗认领
   * 的窗口内（owner=scheduler）。子代理 settle 时若无条件 release，会把**别人的**
   * 认领一起释放，令执行窗口中途失去 owner。故按 owner 身份判定后归还。
   */
  const releaseIfOwned = async (taskId: string, owner: string | undefined): Promise<void> => {
    if (deps.taskPool === undefined || owner === undefined) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = deps.taskPool.get(taskId);
      if (task === undefined || task.ownerId !== owner) return;
      try {
        await deps.taskPool.release('scheduler', taskId, { expectedRevision: task.revision });
        return;
      } catch (error) {
        if ((error as { code?: string }).code === 'STALE_REVISION' && attempt < 2) continue;
        throw error;
      }
    }
  };

  const settle = async (caller: DispatchCaller, orderId: DispatchId, ref: DispatchRef): Promise<DispatchOrder> => {
    const order = fresh(mustGet(orderId), ref);
    if (order.status !== 'running') {
      throw new TdaError('INVALID_TRANSITION', `派发单 ${order.id} 状态 ${order.status}，仅 running 可结算`);
    }
    const run = inFlight.get(order.id);
    if (run === undefined) {
      throw new TdaError(
        'DISPATCH_RUN_MISSING',
        `派发单 ${order.id} 的 run 句柄不在进程内（宿主重启？走 reconcileOrphans）`,
      );
    }
    // 锁外等待子代理结果（长跑 run 不得阻塞 cancel）
    const raw = await run.result;
    const diagnostic = sanitizeDiagnostic(raw.diagnostic);
    const usage = usageOf(raw.usage);
    const hasStructured = raw.structured !== undefined;
    const validation = hasStructured ? validateConclusion(order.outputSchemaId, raw.structured) : undefined;
    const structuredOk = validation?.ok === true;
    const outcome = mapStopReason(raw.stopReason, structuredOk, hasStructured);

    let conclusionEntryId: string | undefined;
    let summary: { findings: string[]; confidence: number } | undefined;
    if (outcome === 'conclusion' || outcome === 'conclusion-partial') {
      summary = extractSummary(raw.structured);
      if (deps.timeline !== undefined) {
        const entry = await deps.timeline.append(
          { sessionId: String(caller.sessionId), actor: caller.actor, at: clock() },
          {
            content: JSON.stringify({
              orderId: order.id,
              taskId: order.taskId,
              role: order.role,
              outcome,
              conclusion: structuredOk ? raw.structured : null,
              schemaErrors: structuredOk ? [] : (validation?.errors ?? []),
            }),
            chunkType: 'fact',
            source: 'task',
            credential: 'model-produced',
            relatedTaskId: order.taskId,
            ...(order.childSessionId !== undefined ? { trajectoryLink: order.childSessionId } : {}),
            confidence: structuredOk ? 0.8 : 0.4,
          },
        );
        conclusionEntryId = String(entry.id);
      }
    }

    const result: DispatchResult = {
      stopReason: raw.stopReason,
      outcome,
      ...(conclusionEntryId !== undefined ? { conclusionEntryId } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(diagnostic !== undefined ? { diagnostic } : {}),
      consumed: usage,
    };

    const settled = await withLock(async () => {
      const current = mustGet(order.id);
      const next: DispatchOrder = {
        ...current,
        revision: current.revision + 1,
        status: 'settled',
        result,
        settledAt: clock(),
      };
      return commit(next);
    });

    // J8 记账（三维 + 注意力单位）；owner 归还：run 已结束不得留僵尸认领
    await consumeTask(order.taskId, usage, order.risk === 'high' ? 1 : 0);
    inFlight.delete(order.id);
    await releaseIfOwned(order.taskId, order.childSessionId);
    await run.dispose();
    return settled;
  };

  const cancel = async (_caller: DispatchCaller, orderId: DispatchId, ref: DispatchRef): Promise<DispatchOrder> => {
    const order = fresh(mustGet(orderId), ref);
    if (DISPATCH_TERMINAL.has(order.status)) return order; // 幂等：终态再取消返回原单
    const run = inFlight.get(order.id);
    if (run !== undefined) {
      await run.dispose(); // dispose 幂等，必达 quiescence
      inFlight.delete(order.id);
    }
    queue.delete(order.id);
    await releaseIfOwned(order.taskId, order.childSessionId);
    return withLock(async () => {
      const current = mustGet(order.id);
      if (DISPATCH_TERMINAL.has(current.status)) return current;
      const next: DispatchOrder = {
        ...current,
        revision: current.revision + 1,
        status: 'cancelled',
        settledAt: clock(),
      };
      return commit(next);
    });
  };

  const start = async (caller: DispatchCaller, orderId: DispatchId, ref: DispatchRef): Promise<DispatchStartResult> => {
    await ensureSeeded();
    return startInternal(caller, orderId, ref);
  };

  const pump = async (caller: DispatchCaller): Promise<DispatchStartResult[]> => {
    await ensureSeeded();
    const started: DispatchStartResult[] = [];
    for (const queued of queueOrder()) {
      if (!capacityAvailable(queued.role)) break;
      const current = orders.get(queued.id);
      if (current === undefined || current.status !== 'approved') {
        queue.delete(queued.id);
        continue;
      }
      queue.delete(queued.id);
      started.push(await startInternal(caller, current.id, { expectedRevision: current.revision }));
    }
    return started;
  };

  const execute = async (caller: DispatchCaller, req: DispatchRequest): Promise<DispatchOrder> => {
    await ensureSeeded();
    const order = await dispatchInternal(caller, req);
    if (order.status === 'requested') {
      throw new TdaError('DISPATCH_APPROVAL_REQUIRED', `派发单 ${order.id} 为高风险（risk=high），须经 approve 后开跑`);
    }
    const begun = await start(caller, order.id, { expectedRevision: order.revision });
    if (!begun.started) {
      throw new TdaError('DISPATCH_QUEUED', `派发单 ${order.id} 已入队（并发帽已满），待 pump 后开跑`);
    }
    return settle(caller, begun.order.id, { expectedRevision: begun.order.revision });
  };

  const matches = (order: DispatchOrder, filter?: DispatchFilter): boolean => {
    if (filter === undefined) return true;
    if (filter.taskId !== undefined && order.taskId !== filter.taskId) return false;
    if (filter.goalId !== undefined && order.goalId !== filter.goalId) return false;
    if (filter.role !== undefined && order.role !== filter.role) return false;
    if (filter.status !== undefined && order.status !== filter.status) return false;
    if (filter.risk !== undefined && order.risk !== filter.risk) return false;
    if (filter.outcome !== undefined && order.result?.outcome !== filter.outcome) return false;
    return true;
  };

  const reconcileOrphans = async (): Promise<DispatchOrder[]> => {
    const orphans = [...orders.entries()]
      .map(([, order]) => order)
      .filter((order) => order.status === 'starting' || order.status === 'running');
    const settled: DispatchOrder[] = [];
    for (const orphan of orphans) {
      await releaseIfOwned(orphan.taskId, orphan.childSessionId);
      const next: DispatchOrder = {
        ...orphan,
        revision: orphan.revision + 1,
        status: 'settled',
        settledAt: clock(),
        result: {
          stopReason: 'error',
          outcome: 'error',
          diagnostic: '宿主重启致子代理运行中断：该派发以显式终态收口（C5，不静默悬停）',
          consumed: { ...ZERO_USAGE },
          orphaned: true,
        },
      };
      settled.push(await commit(next));
    }
    return settled;
  };

  // 策略种子在首次使用时落域（域为权威；重复启动不重复写）
  let seeded = false;
  const ensureSeeded = async (): Promise<void> => {
    if (seeded) return;
    await withLock(async () => {
      if (seeded) return;
      await seedPolicies();
      seeded = true;
    });
  };

  return {
    async initialize() {
      await ensureSeeded();
      const orphans = await reconcileOrphans();
      return orphans.map((order) => String(order.id));
    },
    async dispatch(caller, req) {
      await ensureSeeded();
      return dispatchInternal(caller, req);
    },
    async approve(caller, orderId, ref) {
      await ensureSeeded();
      return approve(caller, orderId, ref);
    },
    async reject(caller, orderId, ref, reason) {
      await ensureSeeded();
      return reject(caller, orderId, ref, reason);
    },
    start,
    settle,
    cancel,
    execute,
    pump,
    list: (filter) =>
      [...orders.entries()]
        .map(([, order]) => order)
        .filter((order) => matches(order, filter))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    get: (orderId) => orders.get(orderId),
    view: (orderId) => {
      const order = orders.get(orderId);
      if (order === undefined) return undefined;
      return {
        id: order.id,
        taskId: order.taskId,
        role: order.role,
        status: order.status,
        risk: order.risk,
        ...(order.result !== undefined ? { outcome: order.result.outcome } : {}),
        ageMs: clock() - order.createdAt,
      };
    },
    policy: (role) => (role !== undefined ? policyOf(role) : [policyOf('sidekick'), policyOf('lead')]),
    async setPolicy(actor, policy) {
      assertToolFilterSafe(policy.role, policy.toolFilter);
      await commitPolicy(policy, actor, clock());
      return policy;
    },
    buildBrief,
    conclusionOf: (orderId) => {
      const order = orders.get(orderId);
      const result = order?.result;
      if (order === undefined || result === undefined) return undefined;
      if (result.outcome !== 'conclusion' && result.outcome !== 'conclusion-partial') return undefined;
      return conclusionView({
        taskId: order.taskId,
        role: order.role,
        outcome: result.outcome,
        value: result.summary ?? { findings: [], confidence: 0 },
        ...(result.conclusionEntryId !== undefined ? { entryId: result.conclusionEntryId } : {}),
      });
    },
    inFlight: () =>
      [...inFlight.keys()]
        .map((id) => orders.get(id))
        .filter((order): order is DispatchOrder => order !== undefined),
    queued: () => [...queue],
    reconcileOrphans,
  };
}

/** 结论摘要提取（J5：主上下文只放 findings[:3] + confidence）。 */
export function extractSummary(structured: unknown): { findings: string[]; confidence: number } {
  const record = (structured ?? {}) as { findings?: unknown; confidence?: unknown };
  const findings = Array.isArray(record.findings)
    ? record.findings.filter((item): item is string => typeof item === 'string').slice(0, 3)
    : [];
  const confidence = typeof record.confidence === 'number' ? record.confidence : 0;
  return { findings, confidence };
}
