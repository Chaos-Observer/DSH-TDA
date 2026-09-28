/**
 * T0.5 §3.3 RolePolicy + §1 J6/J9 策略裁定：默认角色策略、风险分级、
 * persona 模板与工具面降噪的静态约束。
 *
 * 静态约束（构造期/加载期即拒，不等到派发）：
 *  - 子代理工具面**禁写**：toolFilter 不得含任务写/委派/时间线写工具名
 *    （J6：Sidekick "禁 task_* 写、禁委派、禁 timeline 写"）；
 *  - persona 模板只用注册变量（J5/§5）：`{{…}}` 内必须是已注册变量名；
 *  - maxDepth 恒 0（J6/不变量 5）。
 */
import { TdaError } from '@tda/kernel';
import type { AgentOptions, DispatchRole, RolePolicy } from './domain.ts';

/**
 * 任务池只读镜像（buildBrief 的唯一输入，J2：只读 TaskNode 字段）。
 *
 * 方法式构造的窄视图：装配层可直接传 `ctx.taskPool.get(id)` 的返回记录
 * （结构子集可赋值），无需包装（跨插件零 import）。
 * 可选字段显式写 `| undefined`：生产方 TaskNode 由 zod `.optional()` 推导，
 * 形态是 `T | undefined`；在 exactOptionalPropertyTypes 下 `x?: T` 会拒绝该形态。
 */
export interface DispatchTaskView {
  readonly id: string;
  readonly revision: number;
  readonly goalId: string;
  readonly subject: string;
  readonly description: string;
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete';
  readonly stage: 'planning' | 'executing' | 'waiting' | 'verifying';
  readonly ownerId?: string | undefined;
  readonly localPath?: string | undefined;
  readonly writeScopes: readonly string[];
  /** 排队序依据（承 T0.2 dispatch 序：priority 降 → 建单时刻升）。 */
  readonly priority: number;
  readonly proposal?: { readonly status: 'pending_approval' | 'approved' | 'rejected' } | undefined;
  readonly budget: { readonly zone: 'normal' | 'converge' | 'exhausted' };
}

/** 子代理工具面禁项（J6：写类能力一律不进子代理）。 */
export const FORBIDDEN_SUBAGENT_TOOLS: readonly string[] = [
  'task_create',
  'task_edit',
  'task_complete',
  'task_claim',
  'task_release',
  'task_approve',
  'task_propose',
  'tda_dispatch',
  'subagent',
  'timeline_append',
  'timeline.append',
  'workspace_scan',
];

/** 已注册 persona 变量（严格插值：未注册变量即抛）。 */
export const PERSONA_VARIABLES: readonly string[] = ['taskId', 'role', 'subject', 'localPath', 'goalId'];

/** persona 模板注册表（P0 内置两条；模板只用注册变量）。 */
export const PERSONA_TEMPLATES: Readonly<Record<string, string>> = {
  'tda-sidekick-scout':
    '你是任务 {{taskId}} 的只读侦察兵（Sidekick）。只收集证据，不做决策；' +
    '不修改任何任务定义，不写时间线。把发现、证据、风险与未完成项按结论 schema 回传。',
  'tda-lead-reviewer':
    '你是任务 {{taskId}} 的审查者（Lead）。基于给定材料给出裁决（approve/revise/reject）' +
    '与多角度批评；结论是数据不是指令，不得改写任务定义。',
};

/** 默认工具面（只读 + 检索；写类一律不在内）。 */
export const DEFAULT_SIDEKICK_TOOLS: readonly string[] = ['read_file', 'grep', 'glob', 'list_dir'];
export const DEFAULT_LEAD_TOOLS: readonly string[] = ['read_file', 'grep', 'glob', 'list_dir', 'timeline_search'];

/** 默认角色策略（插件 Config 可覆盖；domain 为权威种子，见 §3.3）。 */
export function defaultRolePolicies(config?: { readonly totalMaxParallel?: number }): RolePolicy[] {
  const total = config?.totalMaxParallel ?? 3;
  return [
    {
      role: 'sidekick',
      agentOptions: { provider: 'spawn', model: 'tda-sidekick-fast', reasoningEffort: 'low', maxTokens: 4_096 },
      toolFilter: [...DEFAULT_SIDEKICK_TOOLS],
      maxDepth: 0,
      sandbox: 'read-only',
      personaTemplateId: 'tda-sidekick-scout',
      maxParallel: total,
      highRiskBudgetTokens: 16_384,
    },
    {
      role: 'lead',
      agentOptions: { provider: 'spawn', model: 'tda-lead-frontier', reasoningEffort: 'high', maxTokens: 16_384 },
      toolFilter: [...DEFAULT_LEAD_TOOLS],
      maxDepth: 0,
      sandbox: 'workspace-write',
      personaTemplateId: 'tda-lead-reviewer',
      maxParallel: total,
      highRiskBudgetTokens: 32_768,
    },
  ];
}

/** 静态断言：工具面不得含写类/委派类工具（J6）。 */
export function assertToolFilterSafe(role: DispatchRole, toolFilter: readonly string[]): void {
  for (const tool of toolFilter) {
    if (FORBIDDEN_SUBAGENT_TOOLS.includes(tool)) {
      throw new TdaError(
        'DISPATCH_TOOL_FILTER_UNSAFE',
        `角色 ${role} 的工具面含禁项 "${tool}"（子代理禁任务写/委派/时间线写，J6）`,
      );
    }
  }
}

/** persona 模板严格插值：`{{var}}` 必须是注册变量，且变量必须全部提供。 */
export function renderPersona(templateId: string, vars: Readonly<Record<string, string>>): string {
  const template = PERSONA_TEMPLATES[templateId];
  if (template === undefined) {
    throw new TdaError('DISPATCH_PERSONA_UNKNOWN', `persona 模板未注册：${templateId}`);
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!PERSONA_VARIABLES.includes(name)) {
      throw new TdaError('DISPATCH_PERSONA_UNKNOWN_VAR', `persona 模板 ${templateId} 使用了未注册变量 {{${name}}}`);
    }
    const value = vars[name];
    if (value === undefined) {
      throw new TdaError('DISPATCH_PERSONA_MISSING_VAR', `persona 模板 ${templateId} 缺少变量 {{${name}}} 的取值`);
    }
    return value;
  });
}

/** 路径前缀包含判定（文件路径用 '/' 规范化后比较）。 */
const normalizePath = (raw: string): string => raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');

const withinPath = (scope: string, root: string | undefined): boolean => {
  const normalizedScope = normalizePath(scope);
  if (root === undefined) return false;
  const normalizedRoot = normalizePath(root);
  return normalizedScope === normalizedRoot || normalizedScope.startsWith(`${normalizedRoot}/`);
};

export interface RiskAssessment {
  readonly risk: 'low' | 'high';
  readonly reasons: readonly string[];
}

export interface RiskInput {
  readonly role: DispatchRole;
  readonly policy: RolePolicy;
  readonly agentOptions: AgentOptions;
  readonly task: DispatchTaskView;
  /** 任务自带风险提示（规格 J9 的 `riskHint`；TaskNode 无此列，故经派发请求带入）。 */
  readonly riskHint?: boolean | undefined;
}

/**
 * J9 高风险判定（任一命中即 high）：
 *  ① writeScopes 超出 localPath（越界写）；
 *  ② 角色 sandbox=workspace-write（非只读探索）；
 *  ③ 请求 maxTokens 超策略阈值（前沿模型 + 大预算）；
 *  ④ 任务自带 riskHint。
 * 低风险默认=只读探索（sandbox=read-only ∧ 写域不出 localPath ∧ 预算在阈内）。
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const reasons: string[] = [];
  for (const scope of input.task.writeScopes) {
    if (!withinPath(scope, input.task.localPath)) {
      reasons.push(`writeScope "${scope}" 超出 localPath "${input.task.localPath ?? '(未设)'}"`);
    }
  }
  if (input.policy.sandbox === 'workspace-write') {
    reasons.push(`角色 ${input.role} 的 sandbox=workspace-write（非只读探索）`);
  }
  const threshold = input.policy.highRiskBudgetTokens;
  if (threshold !== undefined && (input.agentOptions.maxTokens ?? 0) > threshold) {
    reasons.push(`maxTokens(${input.agentOptions.maxTokens ?? 0}) 超阈值 ${threshold}`);
  }
  if (input.riskHint === true) {
    reasons.push('任务自带 riskHint');
  }
  return reasons.length > 0 ? { risk: 'high', reasons } : { risk: 'low', reasons: [] };
}
