# DSH 宿主 boot 勘察与评估（2026-10-15，P5 收官后的宿主侧系统性前置）

> 定位：回答"P5 之后，daemon 级 DSH 宿主离我们还有多远"。勘察基线 = 参照树
> `D:/WorkSpace/Learn/project/Reference/deepseek-harness` @ 00102833df（0.1.7-alpha.2）。
> 结论先行：**容器级真装配已达成（P5.4/P5.5），daemon 级 boot 在"源码直吃"约束下
> 不可达**——阻断点有二：①装饰器链（host/agent/llm 适配层）；②app-boot index 的
> npm 闭包断供（resolve.exports/ajv 不在本机，参照树未安装依赖）。解锁路径 =
> DSH 发货态构建产物（tsdown lib/）或 npm 分发包，随 DSH 发版评估。

---

## 1. 宿主 boot 链路与加载性裁定（逐跳实证）

| 跳 | DSH 落点 | 加载性 | 证据 |
|---|---|---|---|
| bin 入口 | `apps/cli`（`dsh` bin） | 未勘察（apps/* 不在 vendor 闭包） | pnpm-workspace `apps/*` |
| 命令行 | `packages/boot/cmdline` | 单文件；依赖 app-boot | src/index.ts |
| **profile/patch 装载** | `packages/boot/app-boot` | ❌ **index 不可加载**：re-export 链拉 `config-schema/*` + `package-meta` → `profile-resolution/resolver.ts` → **`resolve.exports`**（npm）；projector 链涉 **ajv**——两包本机全无（npm 离线缓存 ENOTCACHED；参照树 node_modules 未安装） | index.ts:22-25 + grep 实证 |
| **patch 语义真件** | `vendor/include`（`entryListSchema` + `applyEntryPatches`） | ✅ **可加载**（transform-types；闭包 = cordis + cosmokit + js-yaml + node builtins，零装饰器） | P5.5 门 `testkit-p55/profile-consume.mjs` 全过 |
| loader 生态 | `vendor/loader` / `vendor/group` | ✅ 可加载（同上闭包） | 同上，双包 import 实测 |
| plugin-manager | `packages/boot/plugin-manager` | ❌ index 带 `@Remote`；**patch.ts 子路径也断**——value-import `loadOptionalPatches`（住 app-boot index，见上）+ `writeFileAtomic`（util/atomic-write 可加载，但救不了 import 链） | import 链实证 |
| **工具面** | `core/tools`（ToolRuntime/defineTool） | ❌ index 与 schema.ts 均 value-import dsh-llm 主入口（@Remote 装饰器）——P5.4 已实证 SyntaxError | P5.4 补记 |
| **llm/host/agent 循环** | `core/agent` + llm 适配层 | ❌ 装饰器链（dsh-llm index @Remote；agent 链未逐一验证，但 tools→llm 已断，host 循环必然再断） | P5.2/P5.3/P5.4 实证链 |
| cordis 容器 | `vendor/cordis` | ✅ 可加载（**需 --experimental-transform-types**：Service 用参数属性；strip-only ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX） | P5.4 容器门实证 |

两类源码直吃硬边界（互补，不可绕过）：
1. **装饰器**（node strip-only / --experimental-transform-types / vitest oxc 均不可转换）——dsh-llm、typert、plugin-manager index、host/agent 层；
2. **参数属性**（strip-only 不可、transform-types 可）——cordis 全家、include/loader。

## 2. P5.5 达成：profile 层被 DSH 真代码消费（宿主链可达的最深点）

- **vendor 扩容**：37 包（+3 = root-vendor `loader`/`group`/`include`，boot 生态三件，全部无装饰器）；vendor/dsh/node_modules 增 `js-yaml`/`yaml` junction（实体 `.workbuddy/npm-tmp`，网络安装一次的持久项目数据；link-vendor.mjs 幂等重建）；
- **真消费门**（vendor 门 13/13）：`entryListSchema`（js-yaml Schema，`!!js` 表达式词表）解析 `profiles/cordis.yml` → 27 行 PatchOptions；`applyEntryPatches` 全语义作用在 dsh-base 基座条目表上——**根追加**（无 id insert）/ **`- id` 整块替换不合并**（patch.ts 同语义）/ **name 防呆跳过** / **disabled 切换** / **未命中 warn fail-soft**——cordis.yml 的 boot 消费语义从此有真代码背书，不再依赖"读源码对拍"；
- **不可达薄壳**：`loadOptionalPatches` 的读文件+parse 十行薄壳按源码等价复刻（schema 与 patch 语义两件核心真件为真）——app-boot index 解锁后可直接换回。

## 3. daemon boot 解锁路径（三选一，随 DSH 发版评估）

1. **发货态构建产物**（首选）：DSH 发版走 tsdown lib/——装饰器与参数属性在构建期消解；届时 vendor 改指 lib 产物（P5.0 的 exports 机械 src 化反向），host/agent/tools/llm 全链解开；TDA 侧接线点不变（`registerInto(ctx.tools)` + 各插件 cordis 入口）；
2. **npm 分发包**：DSH 发 npm 包则闭包由包管理器解决（resolve.exports/ajv 等自动到位）；
3. **参照树补装依赖 + 扩 vendor**（不推荐）：安装参照树 node_modules 后扩 vendor 闭包（app-boot + cmdline + host + agent + …，估计 +15 包以上），仍被装饰器挡死——投入产出不成比例。

## 4. TDA 侧就绪度（宿主到来时的接线清单）

| 面 | 状态 | 接线点 |
|---|---|---|
| 存储 | ✅ sqlite 域 DSH 兼容物理布局（P5.1） | DSH Service 接管 `<dir>/tda.db` |
| 会话日志 | ✅ dsh-compat jsonl + ignorable 对偶（P5.2） | DSH session-persistence 内置 |
| LLM 通道 | ✅ StreamChunk face 契约 + OpenAI 兼容 wire（P5.3） | DSH LlmAdapter 注册 |
| 工具面 | ✅ ToolDefinition 直传 + registerInto（P5.4） | `ctx.tools.register` |
| 插件入口 | ⚠️ 仅 task-pool 有 cordis 入口范本（src/dsh.ts） | 其余 23 插件按 §3 范式补 dsh.ts |
| profile | ✅ 27 行真消费语义背书（P5.5） | mountRootInclude 型 boot 直挂 |
| 装配开关 | ✅ executor/planner/display opt-in 已拍板 | 随主循环形态改默认开（cordis.yml disabled 用户面对接） |

## 5. P5.6 达成（2026-10-16）：loader 级真挂载——行 → 模块解析 → 插件 apply 全链路真通

- **根级 workspace 链接**：link-workspace.mjs 增根级 junction 段（28 个 tda-* 包 → 根 node_modules）——loader 裸说明符 `import('tda-task-pool')` 从 vendor 树向上可达；
- **插件 loader 入口**：tda-task-pool index.ts 增 **default export 插件**（name/provide/reusable + 自举式 apply：按 config.dir 自建三槽（json/sqlite backend + invariants + 内存 sink）→ tdaTaskPoolPlugin.apply → `reflect.provide('taskPool', service)` + 服务面自检日志）——不 import cordis（strip-only 纪律不破）；
- **真挂载门**（loader-mount，31/31 包内全绿）：真 Loader+Include 把行文件挂成可服务——Include 读 entry-list → Loader 裸说明符解析模块 → unwrapExports 取 default → **apply(config) 端到端**（config.dir 送达）→ 服务面自检 → registry fiber ACTIVE；
- **cordis 本 fork 三条装载语义实证**（踩坑记录，宿主接线必读）：
  1. `provide` 字段只是宿主元数据——服务供给必须显式 `ctx.provide/reflect.provide`；
  2. **effect 契约**：apply 返回值只能是 undefined 或 disposer 函数——返回 service 对象会被 safeCollect 判 `Invalid effect`（fiber FAILED，无 logger 时静默）；
  3. **裸容器必须先装 logger**（`ctx.provide('logger', …)`）——EntryGroup.update 的 catch 走 `ctx.logger.error`，无 logger 时装载错误被静默吞掉（本阶段最大排查成本来源）；
- **边界**：挂载作用域内服务可达（provide 自证 object）；根作用域经 registry fiber.ctx 的外部内省读不到（cordis 作用域 filter 语义）——宿主 agent 天然在行作用域内运行，无阻塞；dispose 语义（domain.close 随 fiber unload）随宿主拍板。

## 5. 与既有文档的关系

- 《DSH真装配-勘察与施工图》：P5.0–P5.4 施工与收口（本文承接其 P5.4 补记的"宿主随发版评估"）；
- 本文：宿主侧裁定 + P5.5 达成记录——P5 章节收口后宿主议题的权威落点。
