/**
 * @tda/testkit 桶导出：kill -9 三场景驱动 + replay-equivalence + 双写对账断言。
 *
 * 消费方（插件冒烟测试）把场景 .mjs 放进自己包内的 testkit-runtime/，
 * 脚本可 import '@tda/kernel' 与本包助手；Node 24 类型剥离直跑，零转译依赖。
 */
export * from './fileSessionSink.ts';
export * from './sessionLog.ts';
export * from './process.ts';
export * from './control.ts';
export * from './driver.ts';
export * from './replay.ts';
export * from './pairing.ts';
export * from './sessionHostFile.ts';
