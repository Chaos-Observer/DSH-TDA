/**
 * 事件族注册表：审计总线（log-only session event）的唯一白名单。
 *
 * 六族对应 P0 六条业务线（T0.1–T0.6）；扩展族编号 7–11 预留（P1+）。
 * 未登记族双写即抛 UNKNOWN_EVENT_FAMILY——fail-loud，禁止插件私自造族。
 */
import { TdaError, type JsonObject } from './types.ts';

export type EventFamily =
  | 'goalTree/change'
  | 'taskPool/change'
  | 'timeline/write'
  | 'dispatch/change'
  | 'context/assemble'
  | 'workspace/scan'
  // P1 扩展族（编号 7–11，对应 T1.1–T1.5）。
  | 'recall/change'
  | 'memoryGov/change'
  | 'predict/change'
  | 'metaPath/change'
  | 'drift/calibrate'
  // P2 扩展族（编号 12–16，对应 T2.1–T2.3/T2.5/T2.6；T2.4 是 recall v2 同包扩展无新族）。
  | 'coach/change'
  | 'skill/change'
  | 'maintenance/change'
  | 'workflow/change'
  | 'pluginScout/change'
  // P3 扩展族（编号 17–19，对应 T3.1–T3.3；T3.4 验证层不立新族）。
  | 'knowledge/change'
  | 'supervision/change'
  | 'identity/change'
  // P4 扩展族（编号 20–22，对应 T4.1–T4.5；T4.3 图谱/ T4.4 展示不立族）。
  | 'executor/change'
  | 'planner/change'
  | 'intake/change';

/** 溯源总线实体种类：audit_index 的索引维度。 */
export type EntityKind =
  | 'goal'
  | 'task'
  | 'timeline'
  | 'dispatch'
  | 'assemble'
  | 'scan'
  | 'recall'
  | 'gov'
  | 'predict'
  | 'metaPath'
  | 'drift'
  | 'coach'
  | 'skill'
  | 'maintenance'
  | 'workflow'
  | 'pluginScout'
  | 'knowledge'
  | 'approval'
  | 'identity'
  | 'executor'
  | 'plan'
  | 'contingency'
  | 'requirement'
  | 'proposal';

interface EventFamilyMeta {
  /** 事件族的生产者（与插件包名对齐，IT1 起逐插件落实）。 */
  readonly producer: string;
  readonly entityKind: EntityKind;
}

export const EVENT_FAMILIES: Record<EventFamily, EventFamilyMeta> = {
  'goalTree/change': { producer: 'tda-goal-state', entityKind: 'goal' },
  'taskPool/change': { producer: 'tda-task-pool', entityKind: 'task' },
  'timeline/write': { producer: 'tda-timeline', entityKind: 'timeline' },
  'dispatch/change': { producer: 'tda-subagent-dispatch', entityKind: 'dispatch' },
  'context/assemble': { producer: 'tda-context', entityKind: 'assemble' },
  'workspace/scan': { producer: 'tda-workspace', entityKind: 'scan' },
  'recall/change': { producer: 'tda-recall', entityKind: 'recall' },
  'memoryGov/change': { producer: 'tda-governance', entityKind: 'gov' },
  'predict/change': { producer: 'tda-predictor', entityKind: 'predict' },
  'metaPath/change': { producer: 'tda-meta-thinking', entityKind: 'metaPath' },
  'drift/calibrate': { producer: 'tda-drift', entityKind: 'drift' },
  'coach/change': { producer: 'tda-coach', entityKind: 'coach' },
  'skill/change': { producer: 'tda-skill-registry', entityKind: 'skill' },
  'maintenance/change': { producer: 'tda-maintenance', entityKind: 'maintenance' },
  'workflow/change': { producer: 'tda-workflow', entityKind: 'workflow' },
  'pluginScout/change': { producer: 'tda-plugin-scout', entityKind: 'pluginScout' },
  'knowledge/change': { producer: 'tda-knowledge', entityKind: 'knowledge' },
  'supervision/change': { producer: 'tda-supervision', entityKind: 'approval' },
  'identity/change': { producer: 'tda-identity', entityKind: 'identity' },
  'executor/change': { producer: 'tda-executor', entityKind: 'executor' },
  'planner/change': { producer: 'tda-planner', entityKind: 'plan' },
  'intake/change': { producer: 'tda-intake', entityKind: 'requirement' },
};

export const entityKindOf = (family: EventFamily): EntityKind => EVENT_FAMILIES[family].entityKind;

export class UnknownEventFamilyError extends TdaError {
  // 显式字段声明（不用参数属性）：保持 erasable-syntax-only，Node strip-only 可直跑。
  readonly family: string;

  constructor(family: string) {
    super(
      'UNKNOWN_EVENT_FAMILY',
      `事件族 "${family}" 未在 EVENT_FAMILIES 登记，拒绝双写（白名单外禁止造族）`,
    );
    this.family = family;
  }
}

/** 运行期校验并窄化事件族；未登记族抛 UnknownEventFamilyError。 */
export function assertEventFamily(family: string): EventFamily {
  if (!Object.prototype.hasOwnProperty.call(EVENT_FAMILIES, family)) {
    throw new UnknownEventFamilyError(family);
  }
  return family as EventFamily;
}

/** log-only 事件：只追加、不修改；由 session sink 落盘并分配 seq。 */
export interface TdaLogEvent {
  readonly family: EventFamily;
  readonly businessId: string;
  readonly payload: JsonObject;
}
