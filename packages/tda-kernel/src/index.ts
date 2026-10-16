/**
 * @tda/kernel 桶导出。
 *
 * IT1–IT4 所有插件的 domain/双写/索引代码量趋近零，全靠本包：
 * types（品牌 id/JSON/错误）→ events（事件族白名单）→ domain（状态总线）
 * → jsonBackend（参考后端）→ dualWrite（双写器+对账器）→ auditIndex（溯源索引）
 * → bus（事件分发面，IT2 起跨插件联动）→ cas（修订号/无洞 id）→ invariants（不变量注册）。
 *
 * 相对导入一律带 .ts 显式扩展：同时满足 tsc（allowImportingTsExtensions）、
 * Vite/vitest 与 Node 24 类型剥离直跑（kill -9 子进程无需转译器）。
 */
export * from './types.ts';
export * from './events.ts';
export * from './domain.ts';
export * from './jsonBackend.ts';
export * from './vendorBackend.ts';
export * from './dualWrite.ts';
export * from './auditIndex.ts';
export * from './bus.ts';
export * from './sessionHost.ts';
export * from './sessionHostDsh.ts';
export * from './cas.ts';
export * from './invariants.ts';
