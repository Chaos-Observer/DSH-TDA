# VENDORED · DSH（DeepSeek Harness）

- **来源**：`D:/WorkSpace/Learn/project/Reference/deepseek-harness`
- **锁定 commit**：`00102833df`（release `dsh-0.1.7-alpha.2`，@deepseek-ai/dsh-root）
- **vendor 日期**：2026-10-14（P5.0，见《DSH真装配-勘察与施工图》）
- **重放**：`node scripts/vendor-dsh.mjs`（幂等覆写；改写规则见脚本头注释）

## 范围

- `packages/`：运行闭包 31 包（storage×4 / core×5 / llm×3 / compaction×4 / session×2 / sandbox×2 / 其余按依赖）
- `root-vendor/`：cordis 生态 3 包（cordis / schemastery / cosmokit）
- 共 34 包，3.9MB（含 tests）

## 唯一机械改写（不碰业务源码一行）

1. **删除包内 `tsconfig*.json`**——防 vite/tsc 沿目录误加载 DSH 根配置；
2. **`package.json` exports 机械 src 化**——vendor 语境不构建 `lib/`，types/default/import/require 全部映射到 `./src/*.ts`（后缀 .d.ts/.js/.mjs/.cjs → .ts）。注意保留**全部条件键**（只留 types/default 会丢 import/require 条件——schemastery 实测踩坑）。

## 解析双面（关键机制）

| 层 | 机制 |
|---|---|
| **运行层**（vitest/node） | `link-vendor.mjs` 建 junction：`node_modules/@deepseek-ai/<name>` → vendor 包；Node/vite 经 src 化 exports 直吃 `.ts` 源码 |
| **类型层**（tsc） | `tsconfig.base.json` paths：`"@deepseek-ai/*" → "./vendor/dsh/vendor-types.d.ts"`（集中类型门面：2 个详细声明 + 32 个拦截 stub）——**vendor .ts 完全脱离 TDA 严格 tsc**（DSH 自家用 esbuild 系构建器，本就不跑严格 tsc；ambient 声明会被 node_modules 实体解析压过，paths 门面是实测可行解） |

## 装配期发现（P5.1 适配必读）

1. **命名规则**：DSH `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 禁连字符——TDA 域名 `tda-task-pool` 类需映射 `tda_task_pool`（P5.1 适配器内做双向映射，权威域名不变）；
2. **KV 原语名差**：DSH `SqliteKvUnit` = `putRecord/loadAll/deleteRecord/setGlobal`（loadAll 一次取全表）；TDA `TdaKvTable` = `put/delete/entries`——适配器直翻；
3. **journalMode 必传**：绕过 schemastery 校验直调 backend 时 `journalMode` 无默认（PRAGMA 崩）；经 Config schema 校验则有 `wal` 默认；
4. **类型保真度**：`vendor-types.d.ts` 前段 2 个详细声明对照源码抄录；需要新模块的真类型时在门面前段增补（勿用 stub 顶替消费面）。
