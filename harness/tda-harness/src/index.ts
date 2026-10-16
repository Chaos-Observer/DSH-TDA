/**
 * tda-harness 桶导出：daemon 骨架 + IT0 运行时装配。
 *
 * IT1 起本包经 profiles/cordis.yml 由 DSH boot 层叠启动；
 * main.ts 仅为 IT0 本地直跑入口（Node 类型剥离，零转译）。
 */
export * from './daemon.ts';
export * from './runtime.ts';
export * from './llmSeams.ts';
