# DSH 真装配 · 勘察与施工图（2026-10-14，P4 收官后的系统性前置）

> 定位：把"DSH 真运行时接入"从愿景落成证据化施工图。勘察基线 = `D:/WorkSpace/Learn/project/Reference/deepseek-harness`（@deepseek-ai/dsh-root **v0.1.7-alpha.2**，422M monorepo，packages/*/* 工作区）。
> 结论先行：**TDA 内核与 DSH 的领域词汇高度同构**（DomainSpec/KvUnit/zod/品牌键/compatibleVersions/invalidRecords 全部原生对得上）——T0.x 规格当初"承 DSH 约定"的设计被真源码逐条验证；换真 seam 的主要工作是**适配器与装配形态**，不是重写。

---

## 1. 关键实证（逐条对照 DSH 真源码）

| # | 事实 | 证据（DSH 源码落点） | 对 TDA 的意义 |
|---|---|---|---|
| 1 | **DomainSpec 与 TdaDomainSpec 同构**：name/version/`compatibleVersions`/`invalidRecords: 'backup-and-skip'`/zod valueSchema/DomainTableSpec | `storage/storage-domain/src/spec.ts`（DomainSpec 完整定义，注释明说 per-record 布局与 backup-and-skip 语义） | T0.x 各 domain 的 spec **逐字段可直接映射**；IT15 给内核补的 compatibleVersions seam 与 DSH 原生语义一致——换真时零语义折损 |
| 2 | **SqliteKvUnit 是预编译语句 KV**：`u_<unit>_<table>` 表 + `unit_globals`；原子性靠 SQLite 本身；值存 JSON text | `storage/storage-sqlite/src/unit.ts` | TDA `createJsonBackend` 的替身面（put/delete/entries/global）与 KvUnit 契约一一对应——**只需一个 SqliteBackend→TdaStorageBackend 适配器**（方法名 upsert/remove/selectAll ↔ put/delete/entries） |
| 3 | **cordis profile patch 语义已实证**：YAML sequence；`- id` findLast 整块替换；`- insert` 追加；`disabled` 停用开关；`loadOptionalPatches('dsh', filename)` | `boot/plugin-manager/src/patch.ts`（writePluginEnabled） | `profiles/cordis.yml` 的全量层叠（2026-10-14 已完成，27 行）语义正确——**行位冻结可被 boot 真消费** |
| 4 | **DSH 插件范式 = cordis Context 注入**：`export const inject = ['tools', ...]` + `apply(ctx: Context)` + `ctx.tools.register(defineTool({...}))` | `boot/plugin-manager/src/tools.ts`（plugin_manager 工具全貌） | TDA 插件 `apply(deps)` 自管生命周期 → 真装配需**每插件一个 cordis 入口**（见 §3） |
| 5 | **defineTool 契约**：name/description/parameters(JSON-schema 型)/output.render/execute(args, exec)；exec 携 agent/callId/signal | `core/tools/src/schema.ts:554` | 任务池 9 工具与 intake/executor 的模型面可按此注册；`exec.signal` 对接 TDA 让位纪律 |
| 6 | **Session = append-only 事件日志 + surface 投影**：SessionEventMap **支持插件 declaration merging 扩自有事件类型**（`tool/ptc-dispatch` 即 DSH 自家插件扩的） | `core/session/src/surface.ts` + `core/tools/src/types.ts`（declare module '@deepseek-ai/dsh-session/types'） | TDA 22 个事件族可映射为 SessionEventMap 扩展——**"插件自有事件族"在 DSH 是一等公民**，双写对账门可保留在 TDA 内核层 |
| 7 | **LLM = Adapter 注册 + 流式契约**：`LlmRuntime.registerAdapter`，adapter 只需实现 `stream(options): AsyncIterable<StreamChunk>`；路由可原子 replace | `llm/llm/src/index.ts`（LlmRuntime/AdapterRegistrationHandle） | `createScriptedProvider` 替身 → 真 provider = 一个 StreamChunk 适配器；TDA provider 接口与其对齐成本低 |
| 8 | **compaction 拆分细致**：compaction-basic / command-compact / image-offload / tool-result-pruner | `packages/compaction/` | `createMemorySurface` 替身换真时按 T0.5 需求选 compaction-basic 起步 |

---

## 2. 四替身换真 seam 映射（assembleRuntime → 真装配）

| 替身（现码） | DSH 真落点 | 适配形态 | 工作量级 |
|---|---|---|---|
| `createJsonBackend` | `@deepseek-ai/dsh-storage`（sqlite Backend + SqliteKvUnit） | `createSqliteBackend(db)` 适配器：open(descriptor)→SqliteKvUnit 包装成 TdaKvTable（upsert→put / remove→delete / selectAll→entries）；DomainSpec 直传（name/version/compatibleVersions/invalidRecords 同名） | 小（一个文件 + 全量回归） |
| `openFileSessionHost` | `@deepseek-ai/dsh-core/session`（SessionLog + surface + SessionEventMap） | TdaSessionHost 适配：append/seq/sessionId 桥到 SessionLog；22 事件族注册进 SessionEventMap（declaration merging） | 中（事件类型映射 + kill -9 冒烟重跑） |
| `createScriptedProvider` | `@deepseek-ai/dsh-llm`（LlmRuntime.registerAdapter + StreamChunk） | `createDshLlmProvider(runtime)`：TDA provider 接口 → LlmAdapter.stream；scripted 保留为测试注入面 | 小-中 |
| `createMemorySurface` | `@deepseek-ai/dsh-compaction`（compaction-basic 起步） | TdaSurface 适配；v1 先接 basic，image-offload/pruner 随需求 | 中 |
| 任务池 9 工具未注册 | `core/tools` defineTool + `ctx.tools.register` | 每工具一个 defineTool 包装（parameters JSON-schema 化，execute 调 taskPool 服务面；riskHint 走 DSH User Approval） | 中（9 个工具 + 演示链路） |

---

## 3. 插件范式映射（TDA apply(deps) → cordis apply(ctx)）

TDA 插件自管生命周期（`tdaXxxPlugin.apply({...deps}) → handle`），DSH 是 cordis 容器管（`inject` + `apply(ctx: Context)`）。真装配的收敛形态：

```
plugins/tda-<name>/src/dsh.ts        ← 每插件一个 cordis 入口（新增，不改既有 src）
  export const inject = ['storage', 'session', 'llm', ...]
  export function apply(ctx: Context): void {
    const handle = tda<Name>Plugin.apply({ storage: wrap(ctx.storage), ... })  // 既有插件原样复用
    ctx.set('tda<Name>', handle.service)                                      // 服务面挂 cordis
    // dispose 挂 ctx 钩子
  }
```

- **既有 24 插件 src 零改动**（这是本施工图的第一原则——内核门/集成门资产全保留）；
- harness 保持"装配驱动/测试基座"角色不动；DSH 侧的 daemon 循环取代 harness 的 `runtime.tick()` 驱动（executor/planner 的 opt-in 开关、display 的 displayEnabled 随之改默认开）；
- display 的 HTTP 面由 DSH 侧启动序调 `startServer`（或随 U1 评估改 DSH surface 内嵌）。

## 4. 分阶段施工步骤（建议 P5，两周一档）

| 阶段 | 内容 | 出口 |
|---|---|---|
| **P5.0 vendor & build** | vendor DSH（锁定 v0.1.7-alpha.2 commit）入仓 vendor/；打通 pnpm 工作区引用（DSH packages 以 workspace 依赖引入，不改其源码）；CI 加 DSH 构建门 | `import '@deepseek-ai/dsh-storage'` 可从 TDA 侧解析 |
| **P5.1 storage 换真** | createSqliteBackend 适配器 + 24 插件 domain 全量回归（compatibleVersions/invalidRecords 行为对拍：TDA json vs DSH sqlite 语义一致性） | ✅ **已完成**（2026-10-14）：适配器 `packages/tda-kernel/src/vendorBackend.ts`（node:sqlite 同步实现，DSH 兼容物理布局）；vendor 门扩至 5/5（多表往返+重开持久化+jsonBackend 对拍 / 版本兼容集重戳 / backup 影子表）；**harness 装配 `storageBackend` 选项 + 执行环端到端在 sqlite 上跑通（integration-p4 4/4 含 verifyInvariants）** |

#### P5.1 收口补记（装配期三处实证）

1. **NUL 截断（介质键编码的根本原因）**：TDA domain 层复合键 `table\0key` 经 node:sqlite 绑定 UTF-8 转换**被截断 NUL**（C 字符串语义）——这正是 DSH 用多表而非复合键的原因。适配器介质侧改**长度前缀**编码 `<table.length>:<table><key>`（无歧义无控制字符），domain 层不动；
2. **坏 JSON = malformed-medium 而非 backup**（对齐 jsonBackend/DSH）：`loadAll` 的 JSON.parse 失败抛 `MALFORMED_MEDIUM` 整域拒绝；`backupRecord` 只处理"JSON 合法但 schema 不过"（挪 `records_backup` 影子表）；
3. **适配器不包 DSH SqliteStorageBackend 本体**而是自实现同布局（node:sqlite 同步）：DSH 本体 openUnit 异步 + tables 须预知 + 版本严格相等，与 TDA 同步读内存镜像/惰性建表/兼容集三层语义冲突；物理布局同构（user_version=1 + units + `u_<unit>_records` STRICT）保证 **TDA 写出的 db 可被 DSH 后端直接打开**——P5.4 DSH Service 接管的衔接条件；
4. **可擦除语法纪律（全量 sweep 真回归抓到）**：kill -9 冒烟子进程走 **Node 类型剥离直跑** .ts——TypeScript **参数属性（constructor private readonly）非可擦除**，vendorBackend 初版用了它 ⇒ 子进程加载 kernel 即炸，8 处 kill/子进程类测试全挂（非并行假红）。修法：显式字段声明 + 构造器赋值。**纪律：内核与被子进程加载的代码只用可擦除 TS 语法**（此前内核全库已遵守，本次是新增代码破例被全量门拦下——全量 sweep 的价值实证）。
| **P5.2 session 换真** | TdaSessionHost→SessionLog 适配 + 22 事件族 SessionEventMap 注册 + kill -9 冒烟三场景在真日志上重跑 | ✅ **已完成**（2026-10-15）：`packages/tda-kernel/src/sessionHostDsh.ts`——openDshCompatSessionHost 写 **DSH jsonl 物理格式**（header v4 + `{type:'tda/<x>', seq, time, ignorable:true, data}` 信封行）；vendor 门扩至 8/8（写读还原+seq / **DSH 真词表采纳** / 撕裂截断修复+字节不变）；**harness `sessionBackend` 装配选项 + 执行环端到端在 dsh-compat 日志上跑通（integration-p4 5/5 含 verifyInvariants）** |

#### P5.2 收口补记（装配期三处实证）

1. **ignorable = log-only 纯净的 DSH 对偶**（语义对撞点）：DSH SessionEvent 信封规定"未知 type 必须 `ignorable: true` 才被读者采纳，否则拒绝重建"——而 TDA 的 J1 纪律"TDA 事件永不进模型可见面、权威在各插件 domain"意味着 **TDA 事件丢失不影响会话重建**——两者天然同构，TDA 行恒 `ignorable: true` 是语义正确而非权宜；
2. **装饰器 = 源码直吃的硬边界**：`@deepseek-ai/dsh-session-persistence` 的 import 链拉进 llm 包的 `@Remote` 装饰器（TypertRemoteService）——node strip-only/transform-types 与 vitest 的 oxc 均**不可转换**（DSH 发货态走 tsdown 构建产物无此问题）。采纳校验因此**用 DSH 真词表复刻 storage-contract 判定**（`known-event-types.ts` 独立文件无装饰器可加载：未知 type 须 ignorable）——词表真、逻辑镜像；validateStoredEvents 本体的运行层调用随 P5.4 DSH 宿主内置；
3. **truncation-repair 必须在重开时做**（DSH format.ts 同语义）：kill -9 半行撕裂后若不截断，续写会粘在半行之后把好行一起拖进撕裂——重开即截断到最后完整换行（字节级"历史不变"断言守住）。另两个转写链教训：python→TS 转写链中 `\n` 字面会变真换行（生成代码用 String.fromCharCode(10)）；bash heredoc 会把 Write 的行尾污染成 `\r\r\n`（补丁脚本先规范化 `\r` 再锚点匹配）。
| **P5.3 llm + compaction 换真** | ✅ **已完成**（2026-10-15）：StreamChunk 换真适配器 `plugins/tda-subagent-dispatch/src/dshStreamProvider.ts`——`createDshStreamProvider`：SubagentProvider seam → DSH StreamFace（`LlmAdapter.stream` 结构镜像），**chunk 组装复用 DSH 真件 BlockAssembler**（懒加载动态 import，face 序列免费获得 DSH 词表门）；终止映射 stop/tool-calls→completed（可提取结论）/max-tokens/aborted/error，abort 走 interruptedBlocks 语义；**真 wire 通道 `openAiCompatFace.ts`**（OpenAI 兼容 chat/completions SSE → StreamChunk：SSE 解析/finish_reason 映射/usage 透传/signal 透传）；vendor 门扩至 **10/10**（P5.3 两门：BlockAssembler 对拍 + expandAssistantStream 无损往返）；**集成门 `integration-p5-stream.spec.ts` 2/2**：执行环端到端（scripted face + 真 SSE wire 两变体）在真 chunk 组装路径上 complete(success) + verifyInvariants；scripted provider 保留为测试注入面。compaction-basic：源码直吃不可行实证（见补记 3）——随 P5.4 DSH 宿主 | 真 wire SSE 下端到端 smoke 达成（本机回环无外部依赖）；DSH 宿主直连随 P5.4 |
#### P5.3 收口补记（装配期四处实证）

1. **装饰器边界图谱精确化**：`@deepseek-ai/dsh-llm` 只有 `src/index.ts` 带 `@Remote`（`LlmRuntime extends TypertRemoteService`），子路径 `./src/*`（types/assembler/assistant-stream/error/brand/message）无装饰器可直吃——P5.0 "exports 机械 src 化保留全部条件键"的决策在此兑现第二级红利：**包死不等于包内全死**，词表与纯逻辑真件按子路径取用；
2. **真件复用 > 词表复刻**：BlockAssembler 是 agent loop 的唯一权威组装算法（tolerant of delta-only protocols、max-tokens 丢 tool-call、interruptedBlocks 中断语义）——适配器直接 `new BlockAssembler()`，face 输出序列免费获得 DSH 词表门（未知 chunk type assertNever 即抛）——比 P5.2 的"词表复刻"更进一步的换真形态：**逻辑真而不止词表真**。懒加载动态 import 让 kill -9 子进程链路零负担（不构造 provider 就不加载 vendor 代码）；
3. **compaction-basic 换真不可行实证**：`BasicCompactionEngine` inject ['llm','tokenMeter','sessions'] 且 value-import `@deepseek-ai/dsh-llm`（index 装饰器）+ `@deepseek-ai/dsh-session/surface`（SurfaceManager）+ cordis Context——**独立适配器形态不存在**，接入点 = 完整 DSH agent 运行时，随 P5.4 宿主；TDA 侧 ContextSurfaceSeam 的 shadowedSeqs 权威集对偶词汇已在 T0.4 落对，届时只换 seam 实现；
4. **真 LLM 的可实证形态**：外部依赖（网络/key）外部化——OpenAI 兼容 wire 适配 + 本机回环 node:http fixture = 真 HTTP/SSE 协议路径 + 确定性结论；DeepSeek 等 native adapter 属运行期配置（API key），其 wire 协议由 DSH 宿主侧 adapter 承担（P5.4），TDA 只承诺 StreamFace 契约不变。
| **P5.4 工具注册 + 端到端** | ✅ **已完成**（2026-10-15）：任务池 9 工具直传 `plugins/tda-task-pool/src/dshTools.ts`（ToolDefinition 契约形状：name/description/parameters 零拷贝直传 + output.render 文本投影 + execute 内建参数子集门；`validateJsonSchemaSubset` 覆盖 9 工具 parameters 全部特征面；`createDshToolRegistry` = ToolRuntime.register 语义镜像宿主：重名拒绝/`run_code` 保留/缺 output.render 同文案 TypeError/disposer 精确反注册）。**cordis 真装配入口 `src/dsh.ts`**（static inject + Service.provide，与 DSH BasicCompactionEngine 同范式）：**真 cordis Context** 装配 → static inject 解析 → 9 工具经容器执行真任务树（建任务自动待批 J9/未批准不可认领/模型自批被拦 TASK_APPROVAL_FORBIDDEN/CAS STALE/参数门/未知工具/保留名/重名/disposer → 双写对账全过，`testkit-cordis/cordis-scenario.mjs` 子进程门）。**cordis.yml 27 行一致性门**（id 唯一 + name↔workspace 包逐一对应，vendor 门 12/12）。**Gate G4 四项 P5 介质复验全过**：planner/graph/intake 各增 sqlite 域 + dsh-compat 日志变体（executor 此前已有），四项闭环在 DSH 兼容介质上 verifyInvariants 全绿。**诚实边界**：defineTool/ToolRuntime 本体被 dsh-llm value-import（HarnessError）装饰器链挡死（SyntaxError 实证）——本体随 DSH 宿主/发货态产物接管，`registerInto` 是唯一接线点；boot/plugin-manager 不在 vendor 闭包，DSH daemon 级宿主 boot 随 DSH 发版形态评估 | **真 cordis 容器装配 TDA 插件入口首次真实发生**；DSH daemon boot 随宿主评估 |

## 5. 风险与未决

> **P5.0 状态：✅ 已完成**（2026-10-14 收口）。实际交付：
> - **vendor 落地**：`vendor/dsh/` = 运行闭包 31 包 + cordis 生态 3 包（**34 包 3.9MB**，远小于预估——闭包实测比 devDeps 口径砍掉 2/3）；锁定 `00102833df`（0.1.7-alpha.2）；重放脚本 `scripts/vendor-dsh.mjs`（幂等覆写 + 机械改写）+ `link-vendor.mjs`（junction，幂等）；
> - **出口达成**：`import '@deepseek-ai/dsh-storage-domain'` / `'@deepseek-ai/dsh-storage-sqlite'` 类型层（tsc paths 门面）+ 运行层（vitest 直吃 .ts 源码）双通；**vendor 门 `harness/test/vendor-gate.spec.ts` 2/2 转正**（defineDomain 同构 + SqliteStorageBackend KV 往返，含 node:sqlite 实库读写删）；
> - **机械改写两处**（VENDORED.md 详载）：删包内 tsconfig（防 vite 误加载 DSH 根配置）；exports 机械 src 化（**保留全部条件键**——只留 types/default 会丢 import/require，schemastery 实测踩坑）。

#### P5.0 装配期发现（P5.1 适配必读）

1. **命名规则差**：DSH `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 禁连字符 ⇒ TDA 域名 `tda-task-pool` 类需在适配器内做 `tda_task_pool` 双向映射（权威域名不变）；
2. **KV 原语名差**：DSH `SqliteKvUnit` = `putRecord/loadAll/deleteRecord/setGlobal`（loadAll 一次全表）；TDA `TdaKvTable` = `put/delete/entries`——适配器直翻；
3. **ambient 声明输给实体解析**（TS 语义实证）：同模块既有 ambient declare 又能从 node_modules 解析到实体 ⇒ **实体赢**。vendor 类型隔离的正确解 = **tsconfig.base paths → 集中类型门面**（`vendor/dsh/vendor-types.d.ts`：详细声明 + 拦截 stub），tsc 永不加载 vendor .ts；运行层不经 tsc 照吃源码。此模式是"消费外部源码树"的通用解；
4. **vendor 包 journalMode 绕过校验时无默认**（直调 backend 传 config 需显式 `journalMode: 'wal'`）。

- R-a：DSH 依赖图庞大（pnpm 工作区 + native/）——vendor 后构建链路是第一阶段的主要不确定度；缓解：P5.0 只求 import 可解析，不求全量 build；
- R-b：SessionLog 的事件载荷校验严格度未知（TDA 事件 payload 直接进 DSH 日志可能触发其 schema 门）——P5.2 先跑 smoke 事件再迁 22 族；
- R-c：DSH `Context` 的服务解析时机（lazy proxy 语义）与 TDA 装配期的 `requireGoal` 惰性代理解同构，但审批/sandboxPolicy 的注入面需逐插件核对；
- R-d：v0.1.7-alpha.2 是 alpha——vendor 锁 commit，升级随 DSH 发版节奏另行评估；
- U：cordis.yml 的 `disabled` 用户面（writePluginEnabled）与 TDA executor/planner/display 的装配开关如何统一——随 P5.4 拍板。

#### P5.4 收口补记（装配期四处实证）

1. **工具换真的第三级形态**：P5.2 词表真（known-event-types）→ P5.3 逻辑真（BlockAssembler 真件复用）→ P5.4 **契约形状真**（ToolDefinition 直传 + register 语义镜像）——本体不可达时的最大化换真：宿主接线点收敛为 `registerInto(ctx.tools)` 一个方法，DSH 宿主到位后零改动直传；
2. **cordis 运行层前提**：cordis Service 用**参数属性**（`constructor protected ctx`）——strip-only 报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，**必须 `--experimental-transform-types`**（transform-types 支持参数属性但不支持装饰器，两个边界互补）；DSH 自家插件（BasicCompactionEngine）即 static inject + Service.provide 范式，TDA 入口照抄即合；
3. **新纪律：cordis 入口禁止经插件 index 再导出**——index.ts 会把 cordis（参数属性）拉进 kill -9 子进程的 strip-only 加载链（验收 2 假红实证）。cordis 入口只许显式 import（场景脚本/DSH 宿主）；dshTools.ts（纯 @tda/kernel 依赖）可再导出；
4. **Gate G4 复验口径**：四项闭环（executor/planner/graph/intake）在 P5 真装配介质（DSH 兼容 sqlite 域 + DSH 词表 dsh-compat 日志）上复验全绿；"DSH 真运行时"的 daemon 级宿主 boot（boot/plugin-manager 未 vendor）随 DSH 发版形态评估——容器级真装配已在本阶段发生。


## 6. 与既有文档的关系

- `docs/T0.0-DSH环境勘察报告.md`：接口词汇级勘察（本文件的前身）；
- 本文件：真源码实证 + 换真施工图（取代 T0.0 中"待验证"级别的判断）；
- `docs/实现施工方案` §4：P5 章节将引用本表作为施工依据。
