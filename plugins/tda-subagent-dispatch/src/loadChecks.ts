/**
 * tda-subagent-dispatch 插件级不变量：以插件自己的 npm 包名注册。
 *
 * T0.5 §4.1 十条不变量 → 检查/运行时/结构分层映射：
 *  1. 输入隔离        → **类型级结构**（buildBrief 只吃 DispatchTaskView 白名单窄视图，
 *                       签名上不可达主会话 surface）+ 单测"注入会话密钥不出现"；
 *  2. 输出隔离        → **结构**（服务对外无"取原始 output"方法：只有
 *                       `conclusionOf` 摘要 + `result.conclusionEntryId` 引用）
 *                       + 加载期 dispatch-conclusion-reference（引用格式与摘要配对）；
 *  3. schema 强制     → 运行时（派发门 assertConclusionSchema + structured 校验）
 *                       + 加载期 dispatch-schema-whitelist（白名单无指令字段，
 *                       防"schema 被改成可回传任务指令"）+ dispatch-role-schema
 *                       （角色 ↔ 结论 schema 一一对应）；
 *  4. capability 门   → 运行时强制（UNSUPPORTED_CAPABILITY，fail-loud 不降级）；
 *  5. 深度封顶        → 运行时（门拒 depth>0）+ 加载期 dispatch-depth-zero；
 *  6. 控制流分离      → **结构**（服务无 task 写方法，只有 claim/release/consume）；
 *  7. 预算门          → 运行时（门 + settle 必调 consume）；加载期无独立判据；
 *  8. 审批门          → schema（token 消费律）+ 加载期 dispatch-approval-accounting
 *                       （高风险已开跑必无 token 且留 consumedAt）；
 *  9. 并发帽          → 运行时（进程内 in-flight 计数）；
 * 10. 取消幂等        → 运行时（cancel 终态再入返回原单）；
 *  ＋ 孤儿显式终态     → 加载期 dispatch-orphan-free（apply 时 reconcile 后不应残留
 *                       starting/running；残留即抛，防"静默悬停"复发）。
 */
import {
  tdaPluginInstaller,
  type TdaDomain,
  type TdaInvariantCheck,
  type TdaInvariantRegistry,
} from '@tda/kernel';
import { ROLE_SCHEMAS, type DispatchTables } from './domain.ts';
import { assertConclusionSchema, CONCLUSION_SCHEMAS, schemaFieldNames } from './schema.ts';
import { assertToolFilterSafe } from './policy.ts';

export interface DispatchInvariantOptions {
  /** 任务池 seam（可选）：提供 taskId 存在性检查。 */
  readonly taskExists?: (taskId: string) => boolean;
  /**
   * 本次启动时刻（插件 apply 时注入）。**在途单判据以它为界**：
   * 只有"早于本次启动"却仍停在 starting/running 的单才算孤儿（宿主重启未收口）；
   * 本次启动之后建的在途单是**正在飞**，属正常状态——门不得误伤。
   * 缺省不判（无启动基准时降级）。
   */
  readonly bootAt?: number;
}

export function dispatchInvariantChecks(
  domain: TdaDomain<DispatchTables>,
  options: DispatchInvariantOptions = {},
): TdaInvariantCheck[] {
  return [
    {
      name: 'dispatch-schema-whitelist',
      run(fail) {
        for (const [schemaId, schema] of Object.entries(CONCLUSION_SCHEMAS)) {
          try {
            assertConclusionSchema(schemaId as keyof typeof CONCLUSION_SCHEMAS, schema);
          } catch (error) {
            fail(`结论 schema ${schemaId} 非法：${error instanceof Error ? error.message : String(error)}`);
          }
          const names = schemaFieldNames(schema);
          if (names.length === 0) fail(`结论 schema ${schemaId} 无字段（空 schema 不可作回传契约）`);
        }
      },
    },
    {
      name: 'dispatch-role-schema',
      run(fail) {
        const orders = domain.table('dispatch_orders');
        for (const [key, order] of orders.entries()) {
          if (!ROLE_SCHEMAS[order.role].includes(order.outputSchemaId)) {
            fail(`派发单 ${key} 的 role=${order.role} 不得使用 outputSchemaId=${order.outputSchemaId}`);
          }
          if (order.maxDepth !== 0) {
            fail(`派发单 ${key} 的 maxDepth=${order.maxDepth}，子代理禁再委派（须恒 0）`);
          }
        }
      },
    },
    {
      name: 'dispatch-approval-accounting',
      run(fail) {
        const orders = domain.table('dispatch_orders');
        for (const [key, order] of orders.entries()) {
          if (order.risk === 'high' && order.approval === undefined) {
            fail(`派发单 ${key} 为高风险却无审批记录（未批准禁派）`);
            continue;
          }
          const started = order.status === 'starting' || order.status === 'running' || order.status === 'settled';
          if (!started) continue;
          if (order.approval?.token !== undefined) {
            fail(`派发单 ${key} 已开跑却仍持批准 token（一次性凭据须已消费，防重放）`);
          }
          if (order.risk === 'high' && order.approval?.consumedAt === undefined) {
            fail(`派发单 ${key} 高风险已开跑却无 token 消费时刻（consumedAt）`);
          }
          if (order.approval !== undefined && order.approval.status !== 'approved' && order.status !== 'cancelled') {
            fail(`派发单 ${key} 已开跑但审批状态为 ${order.approval.status}（应 approved）`);
          }
        }
      },
    },
    {
      name: 'dispatch-conclusion-reference',
      run(fail) {
        const orders = domain.table('dispatch_orders');
        for (const [key, order] of orders.entries()) {
          const result = order.result;
          if (result === undefined) continue;
          const hasConclusion = result.outcome === 'conclusion' || result.outcome === 'conclusion-partial';
          if (hasConclusion && result.summary === undefined) {
            fail(`派发单 ${key} outcome=${result.outcome} 却无结论摘要（主上下文无摘要可渲染）`);
          }
          if (!hasConclusion && (result.summary !== undefined || result.conclusionEntryId !== undefined)) {
            fail(`派发单 ${key} outcome=${result.outcome} 不得携带结论引用/摘要`);
          }
          if (result.outcome === 'conclusion' && result.conclusionEntryId === undefined) {
            fail(`派发单 ${key} outcome=conclusion 却无 conclusionEntryId（结论未落时间线）`);
          }
          if (result.conclusionEntryId !== undefined && !/^tl-\d+$/.test(result.conclusionEntryId)) {
            fail(`派发单 ${key} 的 conclusionEntryId "${result.conclusionEntryId}" 不似时间线条目 id`);
          }
          if (result.diagnostic !== undefined && Buffer.byteLength(result.diagnostic, 'utf8') > 4096) {
            fail(`派发单 ${key} 的 diagnostic 超 4096 字节（provider 消毒契约）`);
          }
        }
      },
    },
    {
      name: 'dispatch-policy-coverage',
      run(fail) {
        const policies = domain.table('dispatch_policy');
        for (const role of ['sidekick', 'lead'] as const) {
          const policy = policies.get(role);
          if (policy === undefined) {
            fail(`角色 ${role} 无策略行（dispatch_policy 必覆盖两角色）`);
            continue;
          }
          if (policy.maxDepth !== 0) fail(`角色 ${role} 的 maxDepth=${policy.maxDepth}（须恒 0）`);
          try {
            assertToolFilterSafe(role, policy.toolFilter);
          } catch (error) {
            fail(`角色 ${role} 工具面非法：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
    },
    {
      name: 'dispatch-orphan-free',
      run(fail) {
        const bootAt = options.bootAt;
        if (bootAt === undefined) return; // 无启动基准：降级（由装配期保证 initialize 已跑）
        const orders = domain.table('dispatch_orders');
        for (const [key, order] of orders.entries()) {
          if (order.status !== 'starting' && order.status !== 'running') continue;
          if (order.createdAt < bootAt) {
            fail(
              `派发单 ${key} 建单于本次启动之前却仍停在 ${order.status}` +
                '（宿主重启后在途单须经 initialize → reconcileOrphans 落显式终态，C5）',
            );
          }
        }
      },
    },
    {
      name: 'dispatch-task-reference',
      run(fail) {
        if (options.taskExists === undefined) return; // 未装配任务池：降级
        const orders = domain.table('dispatch_orders');
        for (const [key, order] of orders.entries()) {
          if (!options.taskExists(order.taskId)) {
            fail(`派发单 ${key} 指向不存在的任务 ${order.taskId}`);
          }
        }
      },
    },
  ];
}

export function registerDispatchInvariants(
  registry: TdaInvariantRegistry,
  domain: TdaDomain<DispatchTables>,
  options: DispatchInvariantOptions = {},
): () => void {
  return registry.register('tda-subagent-dispatch', tdaPluginInstaller(dispatchInvariantChecks(domain, options)));
}
