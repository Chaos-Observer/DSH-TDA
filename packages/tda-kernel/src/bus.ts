/**
 * 进程内事件总线：log-only 事件的运行期分发面（IT2 起跨插件联动的唯一通道）。
 *
 * 定位（承实现施工方案 §2.1"插件之间禁止互相 import，跨插件数据需求一律走事件订阅"）：
 *  - 总线**不是**权威：权威永在 domain（状态总线）与 session log（审计总线）；
 *  - 总线只承载"已提交事实"的通知——插件在自己的统一提交出口（commit）里，
 *    dualWrite 返回 seq 之后 publish，禁止在 domain 写之前 publish
 *    （否则订阅者会看到尚未 durable 的形态）；
 *  - 族白名单复用 events.ts：未登记族 publish 即抛（与双写器同一道闸，防私造族）；
 *  - 订阅者错误向上传播（fail-loud），但**不改变已提交事实**：publish 在提交之后，
 *    订阅失败只表示联动面待修，权威数据已 durable。
 *
 * 长程演进：IT4/T0.7 resume 与 Harness 常驻调度都是本接口的消费方；
 * 需要跨进程/持久化派发时，在本 seam 之后换实现，插件侧零改动。
 */
import { assertEventFamily, type EventFamily } from './events.ts';
import { TdaError, type JsonObject, type Seq, type SessionId } from './types.ts';

/** 总订阅键：订阅全部族（Harness 审计/落盘用途）。 */
export const BUS_WILDCARD = '*' as const;

export interface TdaBusEvent {
  readonly family: EventFamily;
  readonly businessId: string;
  readonly payload: JsonObject;
  /** 事件在 session log 中的序号（拥有序在事件侧，domain 记录不存 seq）。 */
  readonly seq: Seq;
  readonly sessionId: SessionId;
}

export type TdaBusHandler = (event: TdaBusEvent) => void;

export interface TdaEventBus {
  /** 分发已提交事件；任一订阅者抛错则全部通知后聚合抛。 */
  publish(event: TdaBusEvent): void;
  subscribe(family: EventFamily | typeof BUS_WILDCARD, handler: TdaBusHandler): () => void;
  subscriberCount(family?: EventFamily | typeof BUS_WILDCARD): number;
}

export class BusSubscriberFailedError extends TdaError {
  // 显式字段声明（不用参数属性）：保持 erasable-syntax-only，Node strip-only 可直跑。
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(
      'BUS_SUBSCRIBER_FAILED',
      `${failures.length} 个订阅者处理事件失败（已提交事实不受影响，联动面待修）：${failures.join('；')}`,
    );
    this.failures = failures;
  }
}

export class InvalidBusHandlerError extends TdaError {
  constructor(detail: string) {
    super('INVALID_BUS_HANDLER', detail);
  }
}

export function createTdaEventBus(): TdaEventBus {
  const byFamily = new Map<EventFamily, TdaBusHandler[]>();
  const wildcard: TdaBusHandler[] = [];

  const add = (list: TdaBusHandler[], handler: TdaBusHandler): (() => void) => {
    list.push(handler);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  };

  return {
    publish(event) {
      // 族白名单与双写器同闸：总线不得成为造族绕过审计的旁路
      const family = assertEventFamily(event.family);
      const targets = [...(byFamily.get(family) ?? []), ...wildcard];
      const failures: string[] = [];
      for (const handler of targets) {
        try {
          handler(event);
        } catch (error) {
          failures.push(`[${family}/${event.businessId}] ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new BusSubscriberFailedError(failures);
      }
    },

    subscribe(family, handler) {
      if (typeof handler !== 'function') {
        throw new InvalidBusHandlerError('订阅回调必须是函数');
      }
      if (family === BUS_WILDCARD) return add(wildcard, handler);
      const normalized = assertEventFamily(family);
      let list = byFamily.get(normalized);
      if (list === undefined) {
        list = [];
        byFamily.set(normalized, list);
      }
      return add(list, handler);
    },

    subscriberCount(family) {
      if (family === undefined) {
        let total = wildcard.length;
        for (const list of byFamily.values()) total += list.length;
        return total;
      }
      if (family === BUS_WILDCARD) return wildcard.length;
      return byFamily.get(assertEventFamily(family))?.length ?? 0;
    },
  };
}
