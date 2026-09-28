/**
 * tda-timeline 域定义（T0.3 §3 数据模型）：单表权威 + 派生 FTS（进程内，见 fts.ts）。
 *
 *  - timeline_entries：TimelineEntry 全量（权威，append-only，layout single）；
 *    invalidRecords 缺省 reject——时间线是权威数据（§3.2），损坏必须响。
 *  - timeline_fts 不进 domain：FTS 是派生索引（§3.2"崩溃恢复以 domain 为准
 *    重建"），以进程内倒排实现（src/fts.ts，留 sqlite FTS5 seam）。若入 domain
 *    则每次写索引都要配对事件、损坏即整域拒打开——两者都与派生定位冲突。
 *
 * 相对规格 §3.1 的一处必要补充：条目增 `reason?: string` 字段。规格 §4.2 的
 * supersede 签名带 reason 参数，而 §3.1 十八字段无处安放——理由不入域则审计
 * 不可归因（§5.5"记忆写入可回放溯源"）。payload 仍与记录逐字段一致
 * （replay-equivalence 不受影响）。
 *
 * schema superRefine 固化两条加载即拒的恒等律：
 *  - 字段完备（不变量 3）：chunk 必填 chunkType 且不得携带 invalidates；
 *    invalidation 必填 invalidates 且不得携带 chunkType/supersedes；
 *  - 计证强约束（不变量 4 / §5.2）：tool-output / external-content 恒
 *    quarantine=true（服务端强制，注入场景亦不可绕过）。
 */
import { asEntryId, asTaskId, defineTdaDomain } from '@tda/kernel';
import { z } from 'zod';

export const TIMELINE_KINDS = ['chunk', 'invalidation'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** chunk 四类型（§3.4.3：事实/方法/反思/技能）。 */
export const TIMELINE_CHUNK_TYPES = ['fact', 'method', 'reflection', 'skill'] as const;
export type TimelineChunkType = (typeof TIMELINE_CHUNK_TYPES)[number];

/** 写入管道（§3.4.1 PIPE/Channel：任务执行/对话摘要/学习笔记）。 */
export const TIMELINE_SOURCES = ['task', 'conversation', 'study'] as const;
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

/** 信任分层凭证五级（§3.4.4 / J5）。 */
export const TIMELINE_CREDENTIALS = [
  'user-original',
  'execution-verified',
  'model-produced',
  'tool-output',
  'external-content',
] as const;
export type TimelineCredential = (typeof TIMELINE_CREDENTIALS)[number];

/** 写入方角色（WriterRef.actor）。 */
export const TIMELINE_WRITERS = ['agent', 'human', 'coach', 'scheduler'] as const;
export type TimelineWriter = (typeof TIMELINE_WRITERS)[number];

/**
 * 凭证等级（credentialMin 预筛的排序依据）：user-original 最高，
 * external-content 最低。tool-output/external-content 另受 quarantine 强制。
 */
export const CREDENTIAL_RANK: Record<TimelineCredential, number> = {
  'user-original': 4,
  'execution-verified': 3,
  'model-produced': 2,
  'tool-output': 1,
  'external-content': 0,
};

/** 计证强约束凭证集（§5.2：工具输出/外部内容永不直接固化，恒检疫）。 */
export const QUARANTINE_CREDENTIALS: ReadonlySet<TimelineCredential> = new Set<TimelineCredential>([
  'tool-output',
  'external-content',
]);

/** 写入方归因（§3.4.5 / §6.5：session + actor + 时刻，可回放溯源）。 */
export const WriterRefSchema = z.object({
  sessionId: z.string(),
  actor: z.enum(TIMELINE_WRITERS),
  at: z.number(),
});

export type WriterRef = z.infer<typeof WriterRefSchema>;

/**
 * 时间线条目（不可变；无 revision——条目不可变、id 寻址，§4.2 无 CAS）。
 * id 经 transform 带 EntryId 品牌（运行期零成本）：服务 API 的 EntryId 参数
 * 与回传记录无缝衔接，编译期防跨业务线 id 混用（同 T0.1 GoalNode 处理）。
 */
export const TimelineEntrySchema = z
  .object({
    id: z.string().transform(asEntryId),
    kind: z.enum(TIMELINE_KINDS),
    /** chunk：内容本体；invalidation：作废原因（§3.1）。 */
    content: z.string().min(1),
    /** kind=chunk 必填（§3.4.3）；invalidation 不得携带。 */
    chunkType: z.enum(TIMELINE_CHUNK_TYPES).optional(),
    source: z.enum(TIMELINE_SOURCES),
    credential: z.enum(TIMELINE_CREDENTIALS),
    /** credential ∈ {tool-output, external-content} 时恒 true（J5，服务端强制）。 */
    quarantine: z.boolean(),
    /** 弱链接（J8：无外键、无级联——任务 tombstone 不影响条目读取）。 */
    relatedTaskId: z.string().transform(asTaskId).optional(),
    /** §3.4.5：session/event 引用，支撑技能反查轨迹。 */
    trajectoryLink: z.string().optional(),
    /** kind=chunk：本记录取代的目标 chunk（Mem0 add-only override）。 */
    supersedes: z.string().transform(asEntryId).optional(),
    /** kind=invalidation 必填：作废目标 chunk（Graphiti 双时序）。 */
    invalidates: z.string().transform(asEntryId).optional(),
    /**
     * supersede 更正理由（§4.2 签名 reason 参数落点，见文件头补充说明）。
     * 键序约束：必须与 buildChunkEntry（src/service.ts）及
     * timelineWritePayload（src/events.ts）的逐字段顺序一致——domain put
     * 落盘 parse 输出（键序 = schema 定义序），replay-equivalence 以
     * JSON.stringify 整体比对，任一字段错位即分歧。
     */
    reason: z.string().optional(),
    confidence: z.number().optional(),
    /** P0 占位不计量（J4；动量/情感归 T2.4）。 */
    emotionWeight: z.number().optional(),
    /** 语义向量 float32（未嵌入为空，FTS 仍可用；U1 选型未决）。 */
    vector: z.array(z.number()).optional(),
    writer: WriterRefSchema,
    createdAt: z.number(),
  })
  .superRefine((entry, ctx) => {
    // 字段完备律（不变量 3）
    if (entry.kind === 'chunk') {
      if (entry.chunkType === undefined) {
        ctx.addIssue({ code: 'custom', message: 'kind=chunk 必填 chunkType（§3.4.3）' });
      }
      if (entry.invalidates !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'kind=chunk 不得携带 invalidates（作废只能经 invalidation 记录）' });
      }
    } else {
      if (entry.invalidates === undefined) {
        ctx.addIssue({ code: 'custom', message: 'kind=invalidation 必填 invalidates（作废目标）' });
      }
      if (entry.chunkType !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'kind=invalidation 不得携带 chunkType' });
      }
      if (entry.supersedes !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'kind=invalidation 不得携带 supersedes（更正经 chunk 发起）' });
      }
    }
    // 引用完整之禁自指（不变量 2 的 schema 侧；指向不存在/指向 invalidation 属跨记录检查，归加载期）
    if (entry.supersedes !== undefined && entry.supersedes === entry.id) {
      ctx.addIssue({ code: 'custom', message: 'supersedes 不得自指' });
    }
    if (entry.invalidates !== undefined && entry.invalidates === entry.id) {
      ctx.addIssue({ code: 'custom', message: 'invalidates 不得自指' });
    }
    // 计证强约束（不变量 4 / §5.2）：低凭证恒检疫，schema 层即拒
    if (QUARANTINE_CREDENTIALS.has(entry.credential) && !entry.quarantine) {
      ctx.addIssue({
        code: 'custom',
        message: `credential=${entry.credential} 必须 quarantine=true（§5.2 工具输出/外部内容永不直接固化）`,
      });
    }
  });

export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export type TimelineTables = {
  timeline_entries: typeof TimelineEntrySchema;
};

export const timelineDomainSpec = defineTdaDomain({
  name: 'tda-timeline',
  version: 1,
  tables: {
    timeline_entries: TimelineEntrySchema,
  },
  layout: 'single',
});
