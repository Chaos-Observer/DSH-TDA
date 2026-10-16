/**
 * T4.4 · tda-display 插件出口（J1 纯投影：无 domain/无族/无 loadChecks registry）。
 */
import type { TdaEventBus } from '@tda/kernel';
import {
  DISPLAY_VERSION,
  type DisplayDeps,
  type StatusDisplayService,
} from './domain.ts';
import { createDisplayService } from './service.ts';

/** 装配柄（与其他插件同构：{ service }；display 无 domain 可暴露）。 */
export interface TdaDisplayHandle {
  readonly version: typeof DISPLAY_VERSION;
  readonly service: StatusDisplayService;
  dispose(): Promise<void>;
}

export interface TdaDisplayPluginInput extends DisplayDeps {
  /** v1 未消费（预留：U2 实时推送时用于订阅变更触发渲染提示）。 */
  readonly bus?: TdaEventBus | undefined;
  readonly now?: (() => number) | undefined;
}

export const tdaDisplayPlugin = {
  /**
   * 纯投影层装配：零 storage/invariants（无域可注册）；服务生命周期即插件生命周期。
   * startServer 由调用方显式触发（测试环境不起服务只调 snapshot/report）。
   */
  async apply(ctx: TdaDisplayPluginInput): Promise<TdaDisplayHandle> {
    const { bus: _bus, ...deps } = ctx;
    void _bus;
    const service = createDisplayService(deps);
    await service.initialize();
    return {
      version: DISPLAY_VERSION,
      service,
      dispose: () => service.dispose(),
    };
  },
};
