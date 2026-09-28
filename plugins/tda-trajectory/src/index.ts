/**
 * tda-trajectory 插件出口（六文件模板：domain/service/loadChecks/index + 冒烟脚本）。
 *
 * T0.7 是**横切**插件（映射表"层=横切"）：它不产事件族（消费全族），
 * 只提供审计索引 + 回放/恢复校验 + 审计视图三件事。
 *
 * 装配序要点：**索引重建先于不变量注册**（启动序纪律，IT3 教训）——
 * 崩溃后索引可能落后/损坏（`backup-and-skip` 跳过坏行），启动即从日志重扫自愈，
 * 这样"加载期检查"面对的一定是已自洽的索引。
 *
 * dispose 序（承 IT2/IT3）：**退订 → drain（等在途索引写）→ 关域**。
 */
import {
  openTdaDomain,
  registerTdaInvariants,
  createDualWriteReconciler,
  type TdaDomain,
  type TdaEventBus,
  type TdaInvariantRegistry,
  type TdaSessionHost,
  type TdaStorageBackend,
} from '@tda/kernel';
import { trajectoryDomainSpec, type TrajectoryTables } from './domain.ts';
import {
  createTrajectoryService,
  subscribeTrajectoryIndex,
  type TrajectoryDomainSource,
  type TrajectoryService,
  type TrajectorySubscribeHandle,
} from './service.ts';
import { registerTrajectoryInvariants } from './loadChecks.ts';

export {
  trajectoryDomainSpec,
  AuditIndexEntrySchema,
  AUDIT_ENTITY_KINDS,
  ENTITY_FAMILY,
  auditIndexKey,
  type TrajectoryTables,
  type AuditIndexEntry,
  type AuditEntityKind,
} from './domain.ts';
export {
  createTrajectoryService,
  subscribeTrajectoryIndex,
  type TrajectoryService,
  type TrajectoryDeps,
  type TrajectoryDomainSource,
  type TrajectoryEventRef,
  type TrajectorySubscribeHandle,
  type ResumeEvidence,
  type ResumeReport,
  type ReplayReport,
  type ReplayMismatch,
  type AuditEntry,
  type AuditFilter,
} from './service.ts';
export {
  registerTrajectoryInvariants,
  trajectoryInvariantChecks,
  type TrajectoryInvariantOptions,
} from './loadChecks.ts';

/** Cordis ctx 的结构镜像（接 DSH 时替换为真实 ctx）。 */
export interface TdaPluginContext {
  readonly storage: TdaStorageBackend;
  readonly invariants: TdaInvariantRegistry;
  /** 会话主机 seam（DSH session 结构镜像）；缺省则仅做索引（无回放/纯净检查）。 */
  readonly host?: TdaSessionHost;
  /** 各插件域的只读现状（装配层注入；用于 replayCheck 的逐 revision 比对）。 */
  readonly sources?: readonly TrajectoryDomainSource[];
  readonly bus?: TdaEventBus;
  readonly now?: () => number;
  readonly onError?: (message: string) => void;
  /** 启动即从日志重扫重建索引（缺省 true；自愈崩溃后落后的索引）。 */
  readonly rebuildOnBoot?: boolean;
}

export interface TdaTrajectoryHandle {
  readonly service: TrajectoryService;
  readonly domain: TdaDomain<TrajectoryTables>;
  readonly link?: TrajectorySubscribeHandle;
  dispose(): Promise<void>;
}

export interface TdaTrajectoryPlugin {
  readonly name: string;
  apply(ctx: TdaPluginContext): Promise<TdaTrajectoryHandle>;
}

export const tdaTrajectoryPlugin: TdaTrajectoryPlugin = {
  name: 'tda-trajectory',
  async apply(ctx) {
    const reconciler = createDualWriteReconciler();
    const domain = await openTdaDomain(trajectoryDomainSpec, {
      backend: ctx.storage,
      onChange: (change) =>
        reconciler.observeChange({
          domain: change.domain,
          table: change.table,
          key: change.key,
          operation: change.operation,
        }),
    });
    const service = createTrajectoryService({
      domain,
      reconciler,
      ...(ctx.host !== undefined ? { host: ctx.host } : {}),
      ...(ctx.sources !== undefined ? { sources: ctx.sources } : {}),
      ...(ctx.bus !== undefined ? { bus: ctx.bus } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      ...(ctx.onError !== undefined ? { onError: ctx.onError } : {}),
    });
    const link =
      ctx.bus !== undefined ? subscribeTrajectoryIndex({ bus: ctx.bus, service }) : undefined;
    // 启动序：先自愈索引（从日志重扫或增量摄入），再注册不变量（加载期要查的先存在）
    if (ctx.host !== undefined) {
      if (ctx.rebuildOnBoot ?? true) {
        await service.rebuildIndex();
      } else {
        await service.ingest();
      }
    }
    const unregisterKernel = registerTdaInvariants(ctx.invariants, reconciler);
    const unregisterPlugin = registerTrajectoryInvariants(ctx.invariants, domain, {
      ...(ctx.host !== undefined ? { host: ctx.host } : {}),
    });
    return {
      service,
      domain,
      ...(link !== undefined ? { link } : {}),
      async dispose() {
        link?.unsubscribe();
        await link?.drain();
        unregisterKernel();
        unregisterPlugin();
        await domain.close();
      },
    };
  },
};
