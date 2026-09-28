/**
 * tda-trajectory 域定义（T0.7 §3.3）：**一张派生索引表**，仅此一张。
 *
 *  - `audit_index`：实体 → 日志位置（sessionId + seq 范围）映射；**派生数据**
 *    （权威在会话日志：§4.1-8 丢失可由 log 重扫重建），故 `invalidRecords:
 *    'backup-and-skip'`。
 *
 * 刻意**不建**的东西（J1：零新增持久化通道）：轨迹本体不在本域——轨迹 =
 * 会话日志（JSONL、seq 连续）+ 各插件 domain。T0.7 只提供"读得动、找得到、
 * 验得了"的三件能力（server 面的 index/locate/replayCheck/resumeCheck/auditView）。
 *
 * 写路径刻意**不产事件**（T0.7 消费全族、不产族 → 映射表"消费全族不产族"）：
 * 本域写入走 `dualWriteDerived`（仅域、无事件），与 log-only 构成第三种合法组合
 * （权威=域+事件 / 仅事件 / 仅域）。若这里再产事件，就会形成"索引事件引发新索引"
 * 的自指放大。
 *
 * schema 恒等律：
 *  1. `seqFrom ≤ seqTo`（同实体多次变更共用一条记录、seqTo 前移）；
 *  2. entityKind 必须在 TDA 六族对应集内（不认新实体种类）；
 *  3. entityId 不得为空（空 id 的索引无溯源价值）。
 */
import { defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

/** 与内核 `EntityKind` 对齐的实体种类（六族一一对应）。 */
export const AUDIT_ENTITY_KINDS = [
  'goal',
  'task',
  'timeline',
  'dispatch',
  'assemble',
  'scan',
  // P1 扩展族（T1.1–T1.5）
  'recall',
  'gov',
  'predict',
  'metaPath',
  'drift',
  // P2 扩展族（T2.1–T2.3/T2.5/T2.6；T2.4 是 recall v2 同包扩展无新族）
  'coach',
  'skill',
  'maintenance',
  'workflow',
  'pluginScout',
  // P3 扩展族（T3.1–T3.3；T3.4 验证层不立新族）
  'knowledge',
  'approval',
  'identity',
] as const;
export type AuditEntityKind = (typeof AUDIT_ENTITY_KINDS)[number];

export const AuditIndexEntrySchema = z
  .object({
    entityKind: z.enum(AUDIT_ENTITY_KINDS),
    entityId: z.string(),
    sessionId: z.string(),
    /** 含（该实体在本会话中首次出现的 seq）。 */
    seqFrom: z.number(),
    /** 含（该实体最后一次变更的 seq；同实体多次变更时前移）。 */
    seqTo: z.number(),
    at: z.number(),
  })
  .superRefine((entry, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (entry.seqFrom > entry.seqTo) {
      issue(`seqFrom(${entry.seqFrom}) 不得大于 seqTo(${entry.seqTo})`);
    }
    if (entry.entityId === '') issue('entityId 不得为空（空 id 的索引无溯源价值）');
    if (entry.seqFrom < 1) issue(`seqFrom 须 ≥1（seq 从 1 起），收到 ${entry.seqFrom}`);
  });

export type AuditIndexEntry = z.infer<typeof AuditIndexEntrySchema>;

export type TrajectoryTables = {
  audit_index: typeof AuditIndexEntrySchema;
};

export const trajectoryDomainSpec = defineTdaDomain({
  name: 'tda-trajectory',
  version: 1,
  tables: {
    audit_index: AuditIndexEntrySchema,
  },
  layout: 'single',
  // 派生数据：损坏可重建（§4.1-8），跳过而非拒载
  invalidRecords: 'backup-and-skip',
});

/** 索引记录键（唯一实现；键即纪律——不在键上的记录永不生效）。 */
export const auditIndexKey = (entry: Pick<AuditIndexEntry, 'entityKind' | 'entityId' | 'seqFrom'>): string =>
  `${entry.entityKind}#${entry.entityId}#${entry.seqFrom}`;

/** 实体种类 → 生产该种类的唯一事件族（六族一一对应，J2）。 */
export const ENTITY_FAMILY: Readonly<Record<AuditEntityKind, string>> = {
  goal: 'goalTree/change',
  task: 'taskPool/change',
  timeline: 'timeline/write',
  dispatch: 'dispatch/change',
  assemble: 'context/assemble',
  scan: 'workspace/scan',
  recall: 'recall/change',
  gov: 'memoryGov/change',
  predict: 'predict/change',
  metaPath: 'metaPath/change',
  drift: 'drift/calibrate',
  coach: 'coach/change',
  skill: 'skill/change',
  maintenance: 'maintenance/change',
  workflow: 'workflow/change',
  pluginScout: 'pluginScout/change',
  knowledge: 'knowledge/change',
  approval: 'supervision/change',
  identity: 'identity/change',
};
