# 实现施工方案 · 任务驱动生产力 Agent（TDA）

> 上游：《需求描述-任务驱动生产力Agent.md》v2.1（WHAT）、《架构与路线蓝图》v2.1（HOW 选型）、23 份规格文档（T0.0–T3.4，单任务施工依据）、《实施任务路线.md》（Gate 顺序）。
> 定位：**施工组织**。规格回答"每个插件怎么建"，本文回答"工程怎么总装"：目录/包划分、共享内核、迭代切分、规格→插件映射。
> 决策基线：五个决策点全部关闭（②T0.0 勘察/①T3.1 Graphiti/④T2.5 workflowEngine/⑤T3.2 高风险需审/③默认嵌 DSH 存储抽象可逆）；DSH 基座 = `D:\WorkSpace\Learn\project\Reference\deepseek-harness`。

---

## 1. 方案总纲（一页看懂）

**建设模式**：TDA = 一组 Cordis 插件（`tda-*`）+ 一个共享内核库 + 一个 Harness 常驻进程，以 bundle/preset 层叠方式装入 DSH 基座（T0.0 §1：Profile/Bundle 部署配置化，`cordis.yml` patch 可覆盖任何行）。**不改 DSH 一行代码**（adapter 透出层除外，T0.4 J7，走 patch 点）。

**三条总线**（全项目唯一允许的持久化/审计通道，任何插件不得另开）：

| 总线 | 机制 | 权威 |
|---|---|---|
| 状态总线 | `ctx.storage` sqlite domain（zod + DomainSpec + `defineDomain`） | domain 记录是唯一权威（C1） |
| 审计总线 | 每次 accepted 变更双写 log-only session event（T0.7 J2 规范） | session log 是证据链与回放源 |
| 溯源总线 | `audit_index` 派生索引（实体→seq 范围，T0.7 J7） | 可重建，非权威 |

**施工顺序**：P0 分 5 个迭代（IT0 内核 → IT1 数据面双基座 → IT2 任务池 → IT3 执行/上下文三并行 → IT4 轨迹收官），过 Gate G0 后按路线进 P1–P3。23 份规格 → 18 个插件包 + 1 内核 + 1 Harness daemon（映射表见 §5）。

**全局纪律**（所有迭代强制，源自规格共同裁定）：
1. **模式复制**：DSH 绑 session 的能力（goals/agentTeams/schedule/jobs）一律不扩展，复制其模式进自有 sqlite domain（T0.1 J1/T0.2 J1 同款原则）；
2. **零注入直通**：任何观察/治理/预测服务零 domain mutation 写权（T1.5 J1/T2.1 J11/T3.2 J10 同款）；
3. **模型工具面零新增默认**：只有规格明文列了工具集的插件才挂工具（如 T0.2 `dsh-tda-tool-task-pool`），结论统一走时间线 chunk + 主上下文摘要引用（T0.5 J5）；
4. **显式终态**：失败/半截/孤儿必须落 `failed/unfinished`，禁止静默重试与静默截断（C5）。

---

## 2. 工程结构（monorepo）

```
tda/                                  # pnpm workspace + TypeScript strict
├─ packages/
│  ├─ tda-kernel/                     # 共享内核（纯 TS 库，非 Cordis 插件；所有插件的唯一依赖）
│  │  ├─ src/domain.ts                # defineTdaDomain 工厂 + invalidRecords 分级策略（§3.1）
│  │  ├─ src/events.ts                # log-only 事件族注册表（T0.7 J2 收口，§3.2）
│  │  ├─ src/dualWrite.ts             # 双写器：domain accepted → session.append（§3.2）
│  │  ├─ src/auditIndex.ts            # audit_index 索引器 + locate（§3.3）
│  │  ├─ src/cas.ts                   # CAS 助手 + branded id 分配器（§3.4）
│  │  ├─ src/invariants.ts            # dsh-tda/invariant 注册助手（§3.5）
│  │  └─ src/types.ts                 # SessionId/GoalId/TaskId/EntryId 等 branded 类型
│  └─ tda-testkit/                    # 测试基建：kill -9 三场景 / replay-equivalence / 双写对账（T0.7 J8）
├─ plugins/                           # 每插件一个 Cordis 包（T0.0 §1 Extensions：versioned Cordis 包）
│  ├─ tda-goal-state/                 # T0.1 → ctx.goalTree
│  ├─ tda-task-pool/                  # T0.2 → ctx.taskPool
│  ├─ tda-timeline/                   # T0.3 → ctx.timeline
│  ├─ tda-context/                    # T0.4 → ctx.context（含 adapter 透出层 patch）
│  ├─ tda-subagent-dispatch/          # T0.5 → ctx.subagentDispatch
│  ├─ tda-workspace/                  # T0.6 → ctx.workspace
│  ├─ tda-trajectory/                 # T0.7 → ctx.trajectory（薄审计层）
│  └─ （P1–P3 插件同构递增，见 §5 映射表）
├─ harness/
│  └─ tda-harness/                    # L1 自建 Harness daemon：常驻调度宿主（T0.2 J8/§3.6）
├─ profiles/
│  ├─ cordis.yml                      # bundle 组合：DSH 基座层 + tda-* 插件层叠
│  └─ presets/                        # tda-p0 / tda-p1 … 按 Gate 渐进启用
├─ fixtures/                          # T3.4 红队载荷（只存 hash；禁入 sqlite/时间线/主上下文）
├─ test/                              # 跨插件集成测试（对账、resume、fork 冒烟）
├─ docs/                              # → 规格/方案文档即本目录 23+1 份
├─ pnpm-workspace.yaml
├─ tsconfig.base.json                 # strict；nominal branding 检查开
└─ .github/workflows/ci.yml           # CI 红线（§2.3）
```

### 2.1 每插件统一内部结构（模板，IT0 产出）

```
plugins/tda-*/
├─ src/index.ts        # Cordis plugin 定义：provide('ctx.xxx', service)（规格 §4.2 服务面）
├─ src/domain.ts       # defineTdaDomain(...)（规格 §3 schema；唯一允许出现 DomainSpec 的地方）
├─ src/service.ts      # ctx.* 服务实现（不变量运行时强制）
├─ src/events.ts       # 双写点：经 kernel.dualWrite 包装 accepted 变更（插件不直接 append）
├─ src/tools.ts        # 模型工具面（仅规格明文列出的插件；默认无此文件）
├─ src/loadChecks.ts   # 加载即校验：不变量违反 → 拒绝打开（fail-loud）
└─ test/
   ├─ invariants.spec.ts   # 每条不变量一个拒绝用例（规格验收项）
   └─ gate.spec.ts         # 对 Gate Gx 的贡献项验收（规格 §6）
```

规则：插件之间**禁止互相 import 内部模块**，只经 `ctx.*` 服务面调用（依赖倒置，同 T3.2 J5"监督服务只发票不代跑"的防总编排器原则）；跨插件数据需求一律走事件订阅（DSH 事件总线，如 goal-state 订阅 `taskPool/change` 汇聚账本，T0.2 §5）。

### 2.2 构建与工具链

- pnpm workspace + `tsc --strict`（branded id 防串型：GoalId/TaskId/EntryId/DispatchId 互不赋值）；
- vitest 单测 + 集成测试；`ctx.storage` 测试用 `json` backend 内存实例，CI 与冒烟用 `sqlite` backend 落盘（T0.0 §2 Storage 双 backend 现成）；
- DSH 以 **git submodule / 锁定 commit** 引入；升级 DSH = 跑全套冒烟后才可进主线（T0.0 §4 关注项③：pre-stable 政策要求跟住 API 演进）；
- 文档与实现同仓：规格即施工依据，实现后回填验收结果到规格 §6（路线文档既有惯例）。

### 2.3 CI 红线（不过不进主线）

| 门 | 内容 | 来源 |
|---|---|---|
| 类型门 | tsc strict + 无 `any` 逃逸 | 全局 |
| 不变量门 | 各插件 `invariants.spec.ts` 全绿（每条规格不变量有拒绝用例） | 各规格 §4.1 |
| 双写对账门 | domain 变更 ↔ log-only 事件逐一配对（`dsh-tda/invariant`） | T0.7 J4 |
| 冒烟门 | kill -9 三场景 + fork `deriveMessages` 前缀等值 + replay-equivalence | T0.7 J8 |
| 红队门 | T3.4 确定性用例库 verdict 纯函数（`env=ci-mock`，P3 启用；载荷是毒物禁进 live domain） | T3.4 J3/J8 |

---

## 3. 共享内核设计（tda-kernel）

内核是**纯库不是插件**：不提供 ctx 服务、不注册事件监听（监听归各插件/harness），只提供"所有插件都会重复写"的五件基础设施。设计目标：**插件的 `domain.ts/events.ts` 两块接近零业务代码**，只声明 schema 与事件 payload。

### 3.1 domain 注册工厂 + invalidRecords 分级

```ts type-equiv
/** 包住 DSH defineDomain + zod schema + sqlite backend；决策点③的唯一接触点。 */
interface TdaDomainSpec<Tables extends Record<string, unknown>> {
  readonly name: string                       // '@tda/goal-state' 等，全局唯一
  readonly version: number                    // 起步 1；SCHEMA_VERSION 单调递增（DSH 约定）
  readonly tables: Tables                     // zod schema 定义
  readonly invalidRecords: InvalidRecordsPolicy
  readonly layout?: 'single' | 'row'         // 默认 single（全快照小记录）
}
type InvalidRecordsPolicy = 'reject' | 'backup-and-skip'
```

`invalidRecords` 分级策略表（T0.0 §2：DSH 原生支持 `backup-and-skip`，派生数据友好；分级规则由内核统一执行，插件只声明）：

| 级别 | 判据 | 落表（规格实例） |
|---|---|---|
| `reject`（默认） | **权威数据**：损坏即拒绝打开，必须响 | goal_nodes / task_nodes / timeline_entries / dispatch_orders / dispatch_policy / approval_requests / gov_actions / workflow_events / knowledge_events / identity manifest / role_policy… |
| `backup-and-skip` | **派生/可重建**：备份损坏行后跳过，权威在别处 | audit_index / timeline_fts / predictions / mismatches / rehearsal_runs / drift_scores / task_runs(投影侧) / file_graph+scan_cache(T0.6 J8) / runs 投影(T2.5 J10/T2.6 J11)… |

工厂职责：zod→DomainSpec 编译、version 单调校验、加载时不变量预检（委托插件 `loadChecks.ts`）、backend 选择（sqlite 落盘 / json 测试）。**换存储只改内核**（决策点③可逆性的落地保障：T0.3 将来外接 Graphiti 适配也走此 seam）。

### 3.2 事件双写器（T0.7 J2 收口）

`events.ts` 是全项目**唯一事件族注册表**（P0 六族 + 扩展族，新族必须在此登记才能双写——防插件私造事件名绕过审计规范）：

| 族 | 生产者 | 编号 | 稳定业务 id |
|---|---|---|---|
| `goalTree/change` | goal-state | 1 | goalId |
| `taskPool/change` | task-pool | 2 | taskId（run 起止另带 runIndex） |
| `timeline/write` | timeline | 3 | entryId |
| `dispatch/change` | subagent-dispatch | 4 | orderId（与 DSH `subagent/start\|end` 经 childSessionId 对账） |
| `context/assemble` | context | 5 | sessionId+round |
| `workspace/scan` | workspace | 6 | scanId |
| 扩展族（P1–P3 按规格递增） | recall/memoryGov/predict/metaPath/drift-calibrate/coach/skill/maintenance/workflow(7)/pluginScout(8)/knowledge(9)/supervision(10)/identity(11) | — | 各规格 §4（predictionId/metaPathId/reviewId/skillId/proposalId/approvalId…） |

双写器契约：

```ts type-equiv
/** accepted 变更的统一出口：先落 domain（事务），后 append log-only event，同调用栈完成。 */
declare function dualWrite<T>(op: {
  domain: 'accept' | 'append'            // domain 侧已 accepted 的变更
  family: EventFamily                     // 必须是 events.ts 登记族
  payload: JsonValue                      // JSON 无损（Session.append 从源头强制）
  businessId: string                      // 配对事件稳定 id（T0.7 不变量 7）
  session: Session
}): void
// 硬规则（T0.7 J2/§4.1）：log-only（无 surfaceOp、不进 deriveMessages）；
// event seq 拥有序，domain 记录不重复存储 seq（T0.3 §2）；
// 关键点显式 ctx.sessions.flush(session) 作持久化屏障（dispatch settle 等，T0.7 §5）。
```

### 3.3 audit_index 索引器（T0.7 J7）

- 表：`entityKind#entityId#seqFrom → {sessionId, seqFrom, seqTo, at}`；`invalidRecords:'backup-and-skip'`（丢失=重扫 log 重建，T0.7 不变量 8）；
- **双写器自动调**：`dualWrite` 内部按族→entityKind 映射表（内核持有）自动写索引，插件零代码；`locate(entityKind, entityId)` 供 T3.2 投毒溯源/auditView/T1.3 transition 检索消费；
- entityKind 随插件递增登记（goal/task/timeline/dispatch/scan/assemble → coach-review/skill/approval/identity…），同样只认内核注册表。

### 3.4 CAS 与 id 分配助手

- `cas<T extends {revision:number}>(current, expected: number, mutate)`：期望 revision 不匹配即抛 `STALE_REVISION`，**不静默重试**（T0.1/T0.2 不变量 4；并发 claim 恰好一个成功的可测性来源）；
- id 分配器：`goal-<n>` / `task-<n>` / `tl-<n>` / `pin-<n>` 单调无洞无重，空间耗尽报错不复用（T0.3 不变量 5 同款），分配与 domain 写同事务。

### 3.5 不变量注册（dsh-tda/invariant）

`registerTdaInvariants(installer)` 统一向 `ctx.invariants.register('@deepseek-ai/dsh-tda', …)` 挂两类检查（T0.7 J4）：**内核级**（每个 domain accepted 变更有配对 log-only 事件、round↔turn 对应）+ **插件级**（各插件 `loadChecks.ts` 声明自有不变量，如 T0.1 树五条/T0.3 append-only）。DSH 核心关系之外的可合并扩展事件关系由声明它的插件所有——内核保证没有插件漏声明。

### 3.6 Harness daemon 宿主（tda-harness，L1 自建项）

需求 §3.5 常驻进程 + T0.2 J8 既定结论的工程落点：

- **周期调度 tick**：消费 `ctx.taskPool.due()/startRun()/completeRun` seam；P0 单进程 tick 1s（T0.2 U2），cold/busy 只补最新一次 due（承 DSH schedule 语义）；多 worker fencing 留 P1+；
- **事件监听**：DSH 事件总线订阅各 `*/change` 族驱动旁路服务（T0.6 三时点扫描钩子、T1.5 objective-edit 同步重算、T2.1 mismatch surge 检测）；
- **周期任务宿主表**（规格均已注明宿主=L1 Harness daemon）：T1.2 治理 scan / T1.5 drift 1h / T2.1 coach 24h / T2.3 维护 6h / T2.6 scout 24h；
- **让位纪律**：主任务 round 活跃期后台任务排队让位（§3.6 不侵蚀主任务，T2.1 J9/T2.6 J10 同款）；
- daemon 自身不持有业务权威（纯宿主），所有状态仍在各插件 domain——**daemon 可随时 kill 重启而零状态丢失**（G0-② 的工程保证）。

---

## 4. P0 迭代切分（IT0–IT4）

> 依赖基线：T0.1/T0.3 可并行；T0.4/T0.5/T0.6 依赖 T0.2 可并行；T0.7 规格依赖仅 T0.1，但 J2"事件族收口"需 T0.1–T0.6 双写点全部就位，故施工排 P0 最后。

```
IT0 kernel ──► IT1a T0.1 ──► IT2 T0.2 ──┬─► IT3a T0.5 ─┐
        ├───► IT1b T0.3 ────────────────► IT3b T0.6 ─┼──► IT4 T0.7 ──► Gate G0
                                        └─► IT3c T0.4 ─┘
```

### IT0 · 内核与工程骨架（基建，无规格对应）

> **状态：✅ 已完成**（2026-09-24 收口）。实测：`packages/tda-kernel` 22/22、`packages/tda-testkit` 3/3、`plugins/tda-smoke` 6/6。
> 落地件：`tda-kernel` 全件（`types/events/domain/jsonBackend/dualWrite/auditIndex/cas/invariants`；IT2 补 `bus.ts`）、`tda-testkit`（`driver/control/sessionLog/replay/pairing/process/fileSessionSink`）、`tda-smoke` 冒烟插件留作 CI 常驻样本、`harness/tda-harness` daemon 骨架、`profiles/cordis.yml`、CI 四门脚本（`gate:types/gate:invariants/gate:dualwrite/gate:smoke`）。
> 验收对账：冒烟插件 kill -9 三场景（idle/tear/boot）→ domain 恢复 + log 配对零差异 ✓；`dsh-tda/invariant` 注册生效并对漏双写用例报错 ✓；CI 四门框架就位 ✓。

- **目标**：把 §3 五件 + testkit + CI 红线 + `profiles/cordis.yml`（DSH 基座 + tda 空插件层叠 boot 通过）建出来；
- **施工**：tda-kernel 全件；tda-testkit（kill -9 harness / replay-equivalence 比较器 / 双写对账断言）；一个冒烟插件 `tda-smoke` 用内核建 domain+双写（随即删除或留作 CI 常驻样本）；
- **验收**：冒烟插件 kill -9 后 domain 恢复且 log 配对零差异；`dsh-tda/invariant` 注册生效并对漏双写用例报错；CI 四门（除红队）全绿框架就位；
- **出口**：IT1–IT4 所有插件的 domain/双写/索引代码量趋近零——**此迭代不产出任何业务功能，但决定后续 18 个插件的边际成本**。

### IT1 · 数据面双基座（T0.1 goal-state ∥ T0.3 timeline，可两人并行）

> **状态：✅ 已完成**（2026-09-24 收口）。实测：`plugins/tda-goal-state` 21/21、`plugins/tda-timeline` 19/19，两包类型检查干净。
> T0.1：五表 + `ctx.goalTree` 九方法 + phase×stage + 树不变量 5 条拒绝用例 + `goal:state` 注入（order 紧随 `plan:policy`）。
> T0.3：`timeline_entries` + 同库 FTS + 七方法 + append-only + supersede/invalidate 双通道 + 凭证五级 quarantine **服务端强制** + `search()` FTS+暴力余弦混合 + `credentialMin` 预筛。
> 验收对账：G0-② 数据面侧（kill -9 后目标树/焦点/预算/约束快照、时间线条目/链接/FTS 完整恢复，revision 不错乱；FTS 可从 domain 重建）✓；T0.1 验收 1–5、T0.3 验收 1–6 全绿 ✓。

- **T0.1**：`goal_nodes/goal_history/objective_edits/calibrations/constraint_snapshots` 五表 + `ctx.goalTree` 九方法 + phase×stage + 树不变量 5 条拒绝用例 + `goal:state` system-prompt section 注入焦点裁剪视图（order 紧随 `plan:policy`）；
- **T0.3**：`timeline_entries` + 同库 FTS5 + `ctx.timeline` 七方法 + append-only 铁律 + supersede/invalidate 双更正通道 + 凭证五级 quarantine **服务端强制**（§5.2 硬条款）+ `search()` FTS+暴力余弦混合 + `credentialMin` 预筛；
- **验收**：G0-② 数据面侧（kill -9 后目标树/焦点/预算/约束快照、时间线条目/链接/FTS 完整恢复，revision 不错乱；FTS 可从 domain 重建）；T0.1 验收 1–5、T0.3 验收 1–6 全绿；
- **出口**：`ctx.goalTree/ctx.timeline` 可被依赖；`constraint_snapshots` 成为 T0.4 pinned 区数据源之一（T0.1 §5 C6 联动）。

### IT2 · 任务池（T0.2 task-pool）

> **状态：✅ 已完成**（2026-09-24 收口）。实测：`plugins/tda-task-pool` 24/24、`harness/tda-harness` 4/4（含真装配集成门），全仓 7 包类型检查全绿。
> 落地件：三表 `task_nodes/task_history/task_runs` + 服务面 23 方法（施工方案原文记 21，实现期按提议通道与 `runs/history` 查询面补齐）+ 加载期不变量 7 项 + schema 恒等律 10 条 + 预算四维三区（`zone` 唯一实现 `zoneOfCaps`，schema 校验/服务重算/跨插件判定共用）+ 周期 run 模型（interval/cron + `due/startRun/completeRun` + `nextDueAt` durable）+ 模型工具 9 个（原文记 8，实现期补 `task_get` 单取面）+ 提议通道（P0 全审批，`reject` 归档态）。
> 联动面（双向，皆零 import，只经 `ctx.*` 服务面 + 事件）：任务 → 目标走**事件订阅 + 幂等纯投影**（`projectGoalStage`：executing>verifying>waiting>planning）推进目标 stage；预算汇聚走**服务面直调**（`goalLookup.consume` + STALE 重试），刻意不用事件反向累计以免全快照被误当增量重复计数。目标 → 任务走**同步直调** `assertSettled(goalId)` 作 `stage=verifying` 前置。
> 验收对账：G0-① 任务侧（真实任务 create→claim→complete(success/failed) 全 phase×stage 走通 + 周期任务连续 3 run 的 due 派生与失败计数正确）✓；G0-② 任务池侧（owner/预算账本/task_runs/nextDueAt 恢复）✓；T0.2 验收 1–7 全绿 ✓。
> daemon tick 最小闭环：`runtime.tick()` 消费 `due(now)` 逐条 `startRun` 开窗，预期内不可开跑者（让位/三区/待批/并发过期）计 `skipped`，其余照抛（fail-loud 不静默吞）；收尾由执行方调 `completeRun`，**宿主不代跑**（daemon 不持业务权威，可随时 kill 重启而零状态丢失）。

- **施工**：`task_nodes/task_history/task_runs` 三表 + `ctx.taskPool` 21 方法 + 不变量 9 条 + 预算四维三区（converge/exhausted 派生）+ 周期 run 模型（recurrence interval/cron + `due/startRun/completeRun` seam + `nextDueAt` durable 派生）+ **daemon tick 最小闭环**（§3.6 首个消费方）+ 模型工具集 `dsh-tda-tool-task-pool`（8 工具）+ 提议通道（P0 默认全审批）；
- **联动面**：goal-state 订阅 `taskPool/change` 做账本向上汇聚（`goal.consume`）+ `assertSettled(goalId)`（目标 verifying 前置）；
- **验收**：G0-① 任务侧（真实任务 create→claim→complete(success/failed) 全 phase×stage 走通 + 周期任务连续 3 run 的 due 派生与失败计数正确）；G0-② 任务池侧（owner/预算账本/task_runs/nextDueAt 恢复）；T0.2 验收 1–7 全绿；
- **出口**：`ready/claim` 成为 T0.5 派发入口；`localPath` 成为 T0.6 扫描起点。

#### IT2 收口补记（装配期才暴露的五个内核缺口，均已修复 + 补回归用例）

装配层是"三个单飞全绿的插件装在一起"才首次暴露缺陷的地方，五处缺口都不是业务逻辑错，而是**内核契约在"多插件共存 / 并发"维度上不完备**：

1. **事件总线缺失**：跨插件联动无从落脚。补 `tda-kernel/src/bus.ts`（`publish/subscribe/subscriberCount`），`businessId` 与事件族同闸白名单；订阅者抛错时**全部订阅者仍被通知**后聚合抛 `BusSubscriberFailedError`（不让一个坏订阅者污染已提交事实的回声）。
2. **`@tda/kernel` 重复注册**：每个插件各自持对账器（对账器随 `DualWriteContext` 注入，天然分片），却都往同一个 `ctx.invariants` 注册内核级检查 → 撞"注册名=确切包名，一名一注册"。改为按 registry 聚合对账器（`WeakMap<registry, bundle>`）：installer 覆盖该 registry 上**全部**对账器，任一插件漏双写都逃不过内核门；返回的退订只摘自己，末位摘除才整体注销包名注册。
3. **原子发布并发踩 tmp**：`JsonUnit.flush()` 的 `<name>.json.tmp` 是单一共享路径，并发 flush 会互相踩踏——Windows 报 `EPERM`；POSIX 上更隐蔽（一个 `rename` 可能搬走另一个尚未写满的 tmp，得到半份文件）。改为串行发布链（单次失败的 rejection 仍回给调用方，链本体吸收后继续排队）。
4. **并发首载丢更新（静默数据丢失）**：`ensureCache()` 原为 `if (cache) return cache; await loadAll()` 的 check-then-act——并发首写各自走一遍装载、各自 `new Map()`、各自 `this.cache = ...`，先写落在孤儿 Map 上，落盘只剩一条记录。改为缓存**装载 promise**（单飞），并发调用者共用同一 Map 实例；失败不缓存 promise（修正介质后可重试，`MALFORMED_MEDIUM` 的 fail-loud 语义不变）。
   > 触发条件：对**尚未装载**的 unit 并发写。插件路径上 `openTdaDomain` 先 `await domain.load()`、且服务面有进程内互斥锁，故线上未被触发——属**潜伏缺陷**，靠第 3 条的回归用例（24 路并发写新 unit）才现形。
5. **dispose 与在途事件回声竞争**：stage 同步是"已提交事实的回声"（floating promise），`dispose()` 直接关域会撞上晚到的 `edit`。订阅手柄补 `unsubscribe() + drain()`，装配期固定 dispose 序为 **退订 → drain → 关域**（`tda-goal-state` 插件内已按此序实现）。

> 五条共性：**单插件测试永远发现不了**——只有 `assembleRuntime` 真装配（三插件共用 registry/总线/目录）或针对并发路径专门造用例才暴露。这正是新增 `harness/tda-harness/test/integration.spec.ts` 的理由：插件门验规格符合性，集成门验装配与并发语义。

### IT3 · 执行与上下文三并行（T0.5 ∥ T0.6 ∥ T0.4，可三人并行）

> **状态：✅ 已完成**（2026-09-24 收口）。实测：`plugins/tda-subagent-dispatch` 35/35、`plugins/tda-workspace` 27/27、`plugins/tda-context` 24/24、`harness/tda-harness` 8/8（含新增 IT3 集成门 4 例）；全仓 **11 包**类型检查干净，四门全绿，合计 **191 用例**。
> 落地件：T0.5（两表 + 服务 15 方法 + 三套结论 schema 白名单 + 派发门五检 + 双角色策略 + 一次性审批 token + 并发帽排队/pump + 三层审计 + 工具 2 个 + 加载期检查 7 项）；T0.6（四表 `backup-and-skip` + 三层产出 + 路径/符号链接逃逸判定 + 上限显式终态 + 三级 cache 增量 + 时点扫描订阅 + 图谱查询面 + 加载期检查 6 项）；T0.4（钉扎定义表 + 分页树 + 预算四区 + 剥夺序 + gate 双路径 + 组装留痕 + 加载期检查 3 项）。
> 验收对账：**G0-③**（换页 = pageOut 旧页 + pageIn 新页；换页后含新任务页、底层时间线只增不改）✓；**G0-④**（pressure/overflow 双档遮蔽后 pinned 四类逐字节在场；同 focus 相邻两轮 system/pinned/memo 前缀逐字节相同）✓；**G0-⑤**（主上下文零泄漏：结论只以 `ConclusionView` 摘要 + entryId 引用出现，文件正文只进 Sidekick seam）✓；T0.5 验收 1–10、T0.6 验收 1–8、T0.4 验收 1–6 全绿 ✓。
- **T0.5 subagent-dispatch**：派发策略层 `ctx.subagentDispatch` + 复用 DSH `ctx.subagents.start` one-shot 执行通道；`buildBrief` 只从 TaskNode 白名单字段构造 prompt（输入隔离类型级保证）+ outputSchema 白名单强制结构化结论 + Lead/Sidekick 双角色 + minimal preset 降噪（fresh child + read-only + approval:never）+ 派发门五检 + 高风险审批 token + 并发帽 + 取消幂等 + 三层审计（`dispatch/change` 双写 + subagent 观察事件对账 + 子会话 log）；
- **T0.6 workspace**：两层扫描（确定性 inventory 本地 + 语义标注经 T0.5 Sidekick，文件正文零进主上下文）+ `localPath` 锚定禁逃逸 + 上限显式终态 + 三层产出（FileInventory/SemanticNotes/CredibilityHints）+ 局部图谱雏形（sqlite，T3.1 前置数据面）+ 双 chunk 分证汇时间线 + 三级 cache 增量 + claim/收敛/verifying 三时点事件驱动扫描；
- **T0.4 context**：compaction 基座（shadowedSeqs 权威集 + tokenMeter + 事务括号， retained-tail 策略经 `dsh-compaction-basic` patch 点替换）+ pinned 区（C6 四类，每轮从 domain 重渲染，字节级豁免）+ 分页树 memo/page（会话切换=任务切换=换 page，PageTable 进程内+启动从时间线/taskPool 重建）+ KV-cache 四区（前缀稳定排序 + 剥夺序 injection→history→memo，pinned 不剥）+ gate 双路径默认 static（adapter 透出层先 mock，有 key 实测后启用 perplexity）+ AssembleRecord 双写；
- **验收**：G0-③（切任务上下文换页、时间线连续不断）；G0-④（pinned 约束在压缩后仍在——Governance Decay 复演用例 0%→30% 不再现）；G0-⑤（子代理原始输出零泄漏，主上下文只放 ConclusionView 摘要+entryId 引用，回放主会话 log 可证）；
- **出口**：主循环可跑通"目标→任务→派发→结论回传→换页"完整编排；T0.4/T0.5/T0.6 各自验收项全绿。

#### IT3 收口补记（装配期暴露的三处内核/契约缺口 + 三处装配接线裁定，均已修复 + 补回归用例）

IT3 的装配面比 IT2 宽一倍（六条跨插件依赖、两处装配层桥接），因此暴露的东西也分成两类：

**A. 内核/契约在"多插件共存 × 生命周期"维度上不完备**

1. **log-only 族被误报为反向洞**：T0.4 §3.3 明定 `AssembleRecord` **不落 domain**，只走 log-only 事件 + T0.3 时间线；而对账器把"写窗口内零域变更"计为 `unmatchedWrites`（反向洞），于是**完全按规格实现**的行为被自己的门判成"漏双写"。修法：`DualWriteOp.logOnly` 显式声明——该事件不开配对窗口，不参与域↔事件配对；纪律写明"仅当该族域内确无对应表时才可置 true"（否则就是逃生通道）。回归用例覆盖"log-only 不留残窗 + 后续普通双写仍正常配对"。
2. **加载期不变量依赖的状态必须由启动序主动建立**：`dispatch-policy-coverage` 要求两角色策略行，而策略种子原挂在"首次派发时才写"的惰性路径上——一个**从未派发过**的运行时会带着空策略表过不了自己的门（集成门实测红灯）。修法：dispatch 增 `initialize()`（策略种子 + 孤儿收口），插件 `apply` 在**注册不变量之前**调用。教训泛化：**"加载期要查的"必须先于"注册检查"存在**。
3. **在途 ≠ 孤儿**：`dispatch-orphan-free` 原先把任何 `starting/running` 判为违规，把"正在飞"和"重启残留"混为一谈——调度期间跑不动门。修法：以 `bootAt`（装配时刻）为界，只有**早于本次启动**的在途单才算孤儿（须由 `reconcileOrphans` 收口）；本次启动之后建的属正常在飞。

**B. 规格条款落到装配层时的接线裁定**

4. **owner 归还必须按身份判定**（插件级真 bug）：工作区标注的派发发生在任务**已被调度器开窗认领**的窗口内（owner=scheduler）；子代理 `settle` 时无条件 `release` 会释放**别人的**认领，令执行窗口中途失去 owner。修法：`releaseIfOwned(taskId, childSessionId)` —— 只归还自己那份（owner 必须等于本派发的子会话 id）。
5. **T0.6 标注 schema 的落点**（规格"P0 内嵌"的实现形态）：标注结论是 `sidekick-conclusion` 的**超集**（+ files/edges/notes），故 dispatch 侧引入 `ROLE_SCHEMAS`（角色 → 可用 schema 集，含第三套 `sidekick-workspace-annotation`）。**模型通道不暴露 schema 参数**（工具仍只收 taskId+role），故"换 schema 绕白名单"对模型不可达；schema 白名单的指令词黑名单对新 schema 同样生效。
6. **装配层桥接（J5 纪律的落地）**：workspace 的 `annotate()` 是"派发 + 等结论"的复合语义，装配层用 dispatch `execute()` 实现，并**经 entryId 回读时间线条目**取回结构化标注——而不是让 dispatch 暴露原始 output（那会破坏"主上下文只放摘要 + 引用"）。回读这条路与任何审计消费方同源，因此零泄漏判据不被削弱。

> 共性：A 类是"内核契约在生命周期维度上不完备"（单插件单飞永远发现不了），B 类是"规格条款落到装配层时的接线语义"（插件各自的门也看不见）。两类都落在 `harness/tda-harness/test/integration-it3.spec.ts` 与各插件门里。

### IT4 · 轨迹收官（T0.7 trajectory）

> **状态：✅ 已完成**（2026-09-24 收口）。实测：`plugins/tda-trajectory` 22/22、`packages/tda-kernel` 37/37、`harness/tda-harness` 16/16（含 resume 冒烟 4 例 + fork/replay 冒烟 4 例）；全仓 **12 包**类型检查干净，四门全绿，合计 **234 用例**。
> 落地件：会话主机 seam（`packages/tda-kernel/src/sessionHost.ts`：轮次括号 / conversation / interrupted closer / seed marker + `deriveMessages` 纯投影 + `checkSeedInvariants` 六条）；文件会话主机（testkit `openFileSessionHost` / `forkFileSessionHost` / `readHostRecords`）；`plugins/tda-trajectory`（`audit_index` 派生表 + `index/record/ingest/locate/replayCheck/resumeCheck/auditView/rebuildIndex` + 加载期检查 4 项）；harness 装配扩展为 **九插件 + resume 恢复序五步**；CI 第四门新增 harness `test:smoke`（resume 三场景 + fork/replay）。
> 验收对账（T0.7 §6）：1）**G0-②** kill -9 三场景（轮次执行中 / 工具调用后 / dispatch 在飞）→ 历史字节不变 + closer 合成 + 域日志一致 + 孤儿单显式终态 ✓；2）**G0-③** 组装留痕 ↔ 消息面交叉验证（AssembleRecord 的 round↔turn 与 history 段 seq 引用）✓；3）replay-equivalence 全链零违规（含撕裂尾分方向报告）✓；4）fork 冒烟（前缀等值 + seed 六条 + 三条拒绝用例）✓；5）§5.5 溯源自检（抽样 + 全量 locate）✓；6）log-only 纯净自动断言 ✓；7）`tda-trajectory` 不变量注册并通过（双写配对由内核门、round↔turn 由插件门）✓；8）冒烟两件套进 CI ✓。

- **施工**：六事件族全量对账 + `audit_index` 全域接入（`ctx.trajectory.index/locate/replayCheck/resumeCheck/auditView`）+ `dsh-tda/invariant` 增补（双写配对 + round↔turn）+ resume 恢复序五步 + 孤儿单显式终态（`failed+unfinished`）+ fork 边界策略与 seed 不变量 + 冒烟三场景（kill -9 轮次执行中/工具调用后/dispatch 在飞 + fork 后 `deriveMessages` 前缀等值 + replay-equivalence）**进 CI**；
- **验收**：G0 五条件对账表全绿（①端到端②重启不丢③换页连续④pinned 在场⑤零泄漏）；T0.7 验收 1–8 全绿；
- **出口**：**Gate G0 过**。P1 开工条件就绪：audit_index/trajectoryLink/transition 事件时序可供 T1.3/T1.1 消费。

### P1 迭代切分（IT5–IT7）

> **状态：✅ P1 全部完成**（2026-09-24 收口）。实测：T1.1 `tda-recall` 33/33、T1.2 `tda-governance` 35/35、T1.3 `tda-predictor` 29/29、T1.4 `tda-meta-thinking` 26/26、T1.5 `tda-drift` 27/27、harness 19/19（含 P1 集成门 3 例）；全仓 **16 包**类型检查干净，合计 **387 用例**全绿。
> 落地件：五插件（各含 domain/事件/服务面/加载期不变量/三门测试）+ 内核 `tool/call` 宿主记录与 `classifyToolArgClass` + goal-state `recordCalibration`/`objectiveEdits`/`calibrations` seam + governance 多资产分区（assetKind）+ 轨迹 sources 扩 P1 五族 + harness `driveP1()` 周期驱动。
> Gate G1 验收对账：G1-①（相似任务 injection 命中 method ✓，T1.1 门 1）· G1-②（投毒闭环：隔离→不转正→外部验证→supersede 转正→原条目可溯 ✓，T1.2 门 1 + T1.1 门 2）· G1-③（漂移捕获+温和校准+零目标写权 ✓，T1.5 门 1/4/11）· G1-④（mismatch 可观测可用 ✓，T1.3 门 1/2）· 元思维（拓扑/回放验证才缓存/失败自动退役/双路径路由 ✓，T1.4 门 1–8）· P1 集成门（装配闭环 + replayCheck 覆盖 P1 五族 + 重启恢复 ✓）。

```
IT5 T1.1 recall ─┬─► IT6 T1.3 predictor ─┬─► IT7 T1.4 meta-thinking ──► Gate G1
IT5 T1.2 gov ────┘   IT6 T1.5 drift ─────┘
```

- **IT5**：T1.1 召回 + T1.2 治理管道（P1 数据面与治理基座）；T0.1 补 `recordCalibration`/`objectiveEdits` seam（U7 履约）；
- **IT6**：T1.3 预测器 + T1.5 漂移（都消费 transitions 与注入区；漂移的一致性/波动口径依赖 T1.3 的 transition 面）；
- **IT7**：T1.4 元思维库（消费治理第三实例 + transitions + T0.7 fork seam）+ harness 全量装配 + Gate G1 对账；
- **验收**：G1 四条主项（召回命中/投毒闭环/漂移校准/mismatch 可观测）+ 各规格 §6 验收逐条；
- **出口**：P1 认知层就绪——`ctx.recall/governance/predictor/drift/metaThinking` 可被 T2.x 消费；`EmbeddingProvider`/`perplexity gate`/`主动策略召回` 留 P2。

#### P1 收口补记（装配与跨插件协作暴露的六处问题，均已修复 + 有回归用例）

1. **"消费全族事件做审计"必须在装配层补 sources**：P1 五族事件进日志后，`replayCheck` 会按 sources 逐族比对——sources 缺一族即报"日志有域无"。修法：harness sources 显式纳入 recall/gov/predict/metaPath/drift 五族（含 businessId 前缀特例 `calibration:<n>`）。
2. **"派生 vs 权威"要按数据本性选，而不是按表所在地选**：transitions 可重抽 → 派生（无事件）；predictions 的 `injected` 依赖 T0.4 预算裁决（外部状态，无法由日志重放）→ 权威（事件全快照）；audit_index 必持久但不产事件 → 派生。三例同族不同判，纪律 #12 的三组合是"按可回放性"判定的。
3. **promise 链锁不可重入（两次踩到）**：evaluate 持锁内调 `this.calibrate`（也要锁）→ 自锁死（drift）；supersede 持锁内调 `this.propose` → 自锁死（meta）。修法一律是**拆 applyXxx 无锁实现**，公开方法只是加锁包装。
4. **"裁决时参数"必须随记录落盘**：θ 调高不能回溯撤销已注入的预测（可回放性）——`Prediction.theta` 与 `recall_log.paramsRevision` 同一纪律。
5. **coverage 的分母必须取"可映射的步骤种类"**：拓扑含轨迹里不可能出现的步骤（如 refute）会让 verdict 永远 fail——测试拓扑改用 TOKEN_TO_STEP 可映射集（标定留 U1/U2）。
6. **多资产治理的分区口径**：gov_actions/states 混存 memory 与 meta-thinking 两分区，投影检查按分区各自比对；固化前置（validating/凭证三条件）只对 memory 生效——元思维的证据是 rehearsal pass，强行套用会把"回放验证才缓存"误判成"无凭证"。

#### IT4 收口补记（两处内核/契约缺口 + 四处插件级真缺陷，均已修复 + 补回归用例）

**A. 内核/契约**

1. **"仅域写"是第三种合法组合**（内核补 `dualWriteDerived` + 对账器**派生窗**）：`域记录 × 事件` 共有三种组合——权威（域+事件）、仅事件（`logOnly`，IT3 补）、**仅域（派生）**。T0.7 的 `audit_index` 是第三种的唯一实例：它必须持久化，却又不能产事件（否则"索引事件引发新索引"自指放大）。派生窗内的域变更不计入配对（`derivedChanges` 单独计数）。
2. **`beginTurn` 必须回传轮次编号**（真缺陷）：原签名回传 `Seq`，调用方顺手当轮号用，于是 `turn/end` 落到另一个轮次上——resume 便会数出**错误的开放轮次数**（冒烟实测：应 1 变 2）。已改为回传轮号并写明"两者必须同轴"。

**B. 轨迹层（T0.7 自身的两处真缺陷）**

3. **"消费全族"不能依赖"生产者发布总线"**：`goal-state`/`timeline` 从不向总线发布（总线是 IT2 为**双向联动**引入的联动面，不是审计面），只订阅总线会让审计索引**整族漏掉**——`goal` 与 `timeline` 两个实体种类在索引里完全不见。修法：索引的**权威来源改回会话日志**（J1/J2 早已定死"轨迹 = 日志"），新增 `ingest()` 增量摄入；总线订阅降级为**快速路径**，`link.drain()` 的语义 = 先日志摄入、再等总线在途写。回归用例：只写日志不发布总线，仍可被索引。
4. **索引写必须串行**：`record()` 是 fire-and-forget，同一实体的多个事件（如派发单的建单/开跑/发布/结算四条）并发进入 `index()`，两者都先 `findExisting` 再写 → 竞态下各建一条条目（键含 `seqFrom`，互不覆盖）→ 索引**逐实体堆积重复行**。修法：`withWriteLock` 串行链。回归用例：同一实体突发四条事件 → 恰一条条目且 `seqTo` 取最大值。

**C. 口径裁定（不是缺陷，但必须写死）**

5. **`replayCheck` 的偏差必须分方向**：契约"先域后事件"下，kill -9 允许**域超前**（`tornRevisions`：域已 fsync、事件未 append）——这是唯一合法的偏差方向，不计违规但要可读；**域落后 / 幽灵（日志有域无）/ 幽灵实体（域有日志无）**才是真违规。若不分方向，任何一次 kill -9 都会让"回放等价"这条硬判据失去意义。
6. **fork 前缀比对的两个口径**：`seq` 与 `sessionId` 不参与比对（fork 后重新编号、换上子会话 id，这正是 fork 的语义），且必须**键序无关**（fork 会把记录重新拼装，键序变化会让朴素 `JSON.stringify` 误判成"分歧"——冒烟实测抓到）。
7. **域现状来源必须与索引口径一致**：`dispatch` 的策略行与派发单共用 `dispatch/change` 族（businessId 前缀 `policy:`），来源若只枚举 `dispatch_orders`，`replayCheck` 会报两处"域缺"。装配层来源与索引口径必须同源——这条由冒烟抓到并转成回归。

> 共性：A/B 是"内核与轨迹层在**数据来源与写入时序**维度上不完备"，C 是"判据方向与比对口径必须写死，否则门会自己骗自己"。

**迭代切分原则**：① 每迭代出口=下一迭代的编译期依赖（ctx 服务面先稳定）；② 验收即规格 §6 原文，不新造标准；③ 任一迭代 CI 红线圈养禁止（红绿灯文化：红=停线修，不带病进下迭代）。

---

### P2 迭代切分（IT8–IT10）

#### IT8 · coach 元进程 ∥ 技能生命周期（T2.1 ∥ T2.2）
- **T2.1 tda-coach**：四表（reviews/candidates/scan_state/params，全 backup-and-skip）+ `ctx.coach` 八方法。核心裁定落地：J1 独立元进程（deps 只有四类窄面：只读 reads / 目标库 rehearse 委托 / PIPE append / 迁移执行器）；J3 分类键聚类（零原文，证据引用不拷贝）；J12 质量门四项前置；J5 无直接固化权（submit 经 T1.4/T2.2 治理阀）；J6 跨模型迁移验证（transfer.verified=true 才可 submit）；J9 吞吐帽四维+让位轮询；J10 高风险审批一次性 token。
- **T2.2 tda-skill-registry**：四表 + `ctx.skillRegistry`。J1 治理第四实例（assetKind='skill'，lifecycle 零本地实现）；J4 晋升双条件（rehearsal pass ∧ ≥1 真实复用成功；adoptExternal 人类即阀例外）；J5 rehearsal 协议复用（连续 3 fail 自动 retire[rehearsal-fail]）；J7 Elo 在线评分（每条落 usage_log 可复算）；J9 写时冲突三型只标不裁（同名拒绝/near-dup/contradiction）；J10 技能≠编排（schema 拒编排控制流）。
- **内核扩展**：事件族 12–16（coach/change、skill/change、maintenance/change、workflow/change、pluginScout/change）+ 实体种类 +5；治理 `promoteAsset` 通道（非记忆资产的 draft→validating）+ `use-fail` 退役信号。

#### IT9 · recall v2 ∥ 维护闭环（T2.4 ∥ T2.3）
- **T2.4 recall v2（同包扩展，不新立插件）**：五元计分（+momentum/emotion）；scorerVersion 降级开关——'v1' 时权重强制为 0 严格退化（CI 断言逐分一致）；动量双尺度从 recall_log 确定性重算（注入 1.0/使用 2.0，指数衰减+tanh 饱和，防富者愈富）；注意力质心缺席=0.5 中性（派生不落库）；情感资格分流（model-produced 恒 0，w_emotion≤0.2 硬帽）；主动两路（strategicBrief 阶段路 + tda_recall 工具路）同 gate 同留痕；gate 先行不削弱（中毒条目任何参数任何路不浮现）。
- **T2.3 tda-maintenance**：四表 + `ctx.maintenance`。J1 编排非权威（唯一写路径=治理+supersede，executed 必回填 govActionId）；J2 升格三源阈值化（三信号数值+阈值快照随提议落盘）；J3 降级无第二判据（reason.kind 白名单=既有检测器产出）；J6 跨资产统一治理分（Elo/reuse/recency/verify 四元，无 Elo 取 0.5 中性）；J8 高风险三类审批（容量淘汰/invalidate/冲突合并）；J7 吞吐帽+主任务活跃期 defer。

#### IT10 · 工作流 ∥ 插件调研 ∥ 收官（T2.5 ∥ T2.6 + harness 装配 + Gate G2）
- **T2.5 tda-workflow**：四表（defs 版本链/events 权威/runs 投影/params）+ `ctx.workflow`。J3 定义双部件（meta zod 永不 eval + scriptHash FNV-1a 冻结）；J4 contract 七类断言确定性校验（前置不过不启动/后置不当成功/硬边界显式终态）；J5 控制流数据流分离（运行内容不得改写定义——注入内容只以 args 流动）；J6 局部重规划（预算内自动单步重试；超阈 planner 产新版本 append，run 切版本续跑；整体回滚仅经治理）；J7 审批挂起语义（无超时自动过，token 一次性）；J8 模板第五实例（外部验证阀=回放验证∧≥1 真实复用，零复用固化拒绝）。
- **T2.6 tda-plugin-scout**：四表 + `ctx.pluginScout`。J3 四维确定性计分（评分先于叙述，scorer 不接收叙述输入）；J9-③ 安全一票否决（unresolved high/critical ⇒ grade=C，composite 照记）；J7 徽章=结构化信号纯函数；J4 冒烟两层（registry L4/L5 直接消费 + A+ 候选自建 fresh+scratch 三断言，失败降 B+smoke-failed）；J5 三零权限+人类采纳唯一入口（T2.2 adoptExternal，scout 只打 adoption-candidate 徽章）；J9-④ 白名单+cache 降级（stale-data 徽章+partial，无伪造 fresh）。
- **出口**：P2 认知与执行层就绪——`ctx.coach/skillRegistry/maintenance/workflow/pluginScout` + recall v2 主动通道；T3.x 出口：知识图谱 seam（T2.3 J2③）、监督仪表盘数据面（T3.2）、跨模型身份（T3.3）、红队面（T3.4）。

#### P2 收口补记（施工期新发现，均已修复/固化）
1. **domain 表 put 是异步的**：同步路径里 fire-and-forget `table.put` 会让状态"看似写了实则未落"（coach params/scan_state 两次踩到）。修法：启动序 initialize 时 await 播种 + 运行期以内存权威引用为准 + 双写窗口内 await 落盘。
2. **双写窗口内 domainWrite 必须返回 Promise**：block 箭头返回 void 会让 onChange 溢出窗口（域变更落在下一窗口/窗外=漏配对假红）。凡多行写入用 `async () => { await ...; await ...; }`。
3. **payload 键序必须与 schema 定义序一致**：compareReplay 是 stringify 逐字节比对，键序漂移=回放分歧假红（recall v2 扩字段时踩到）。
4. **scorer 挂载契约以"版本开关"落地**：v1/v2 同函数分派（scorerVersion 参数），比替换函数更可回放——回放用当时版本+params 快照解释分数。

#### P2 装配补记（harness 收官，装配期暴露的两处契约缺口，均已修复）

1. **promote 证据要求按分区收窄**：GovActionSchema 的"promote 必带五元证据"只对 memory 生效——非记忆资产（skill/workflow）的晋升证据是所属插件的 rehearsal pass（落各自 runs 表），schema 层强制 memory 式证据会把"回放验证通过"误判成"无凭证"（P2 集成门实测抓到）。同时 promote 不得挂退役原因（归因律全域生效），promoteAsset 的 note 只进日志载荷。
2. **scout 快照注入面**：生产接 dsh.so（域名白名单+cache 降级在 seam 内），装配层 v1 用注入行数组——smoke 三断言在 harness 桥内以 scratch 模拟承载，真实沙箱随 T3.4。

`driveP2()`：coach 周期复盘 → 维护 cycle → scout scan（registry 空时零评估不算失败）；各自吞吐帽与 fail-open 兜底。trajectory sources 扩 P2 五族（entityId = 事件 businessId：`review:`/`candidate:`/`skill:`/`skill-rehearsal:`/`skill-use:`/`maintenance-proposal:`/`maintenance-action:`/`maintenance-report:`/`workflow-def:`/`workflow-run:`/`workflow-event:`/`scout-assessment:`/`scout-run:`/`scout-event:` + 各 params）。

#### P3 收口补记（T3.1–T3.4 全部落地 + harness 23 插件装配 + Gate G3）

- **IT11 T3.1 tda-knowledge（16 用例）**：三权威分工（内容=时间线 chunk / 结构=Graphiti seam / 映射=本 domain）+ 蒸馏管线（确定性聚类 → distiller seam → 验证 → draft）+ 出库阀（≥1 真实复用 ∧ 证据完备 ∨ 人类 token，经治理 assetKind='knowledge'）+ 物化 chunk（J8 召回零改造）+ 凭证继承（min 证据凭证）+ invalidate/reassert（失效不删、回滚=append supersedes）+ 双帽防迷宫（depthCap/fanInCap）+ 外置降级（provider 缺席 → 事件图投影 + 队列重放）。
- **IT12a T3.2 tda-supervision（15 用例）**：统一审批队列 + 规则表定级（禁 LLM；元规则不可逆⇒high 服务端断言）+ 一次性 token 防重放（过期回 pending 可重签，无任何时间路径自动 resolved）+ ResumeTicket 只发票不代跑 + 注意力三区（normal/pressure/exhausted：medium+low 转 digest，flush 聚合计费，veto 仅可逆）+ 请求洪水帽。approval_requests 取 domain 级 reject（内核粒度最严档，人类决策丢失=拒开）。
- **IT12b T3.3 tda-identity（11 用例）**：manifest 引用权威零内容复制 + 快照 SHA-256 哈希链（只存 hash 不存正文）+ 带验证迁移三分级（verified/degraded/failed，rehearsal seam 委托不新造）+ 导入重新入管道（快照自述零信任）+ 人类审批必携（T3.2 kind='identity-migration'）+ 迁移期连续性（版本链 supersede 不改旧版；空身份=概念 v1，落库从 v2 起）。
- **IT13a T3.4 tda-security（8 用例）**：验证层零运行时能力（env='ci-mock' 构造即校验）+ 用例库（注入三面 + 渗透五组，fixture 只存 SHA-256，正文在 fixtures/redteam/ 隔离区）+ 确定性 verdict（executor 纯函数）+ 发现闭环（fixed 强制 regressionRunId+fixSpecRef；risk-accepted 四要素显式化）+ Gate 阻断（open critical/high ⇒ gateBlocked()）+ 对账矩阵（§5 五条款无裸奔）+ 五实例一致（memory 载荷×5 实例遍跑）。
- **harness 装配 23 插件**：knowledge（timeline/governance 双向桥，Graphiti v1 降级=事件图投影）；identity（rehearsal 桥 v1 确定性 coverage 探针）；security（env=ci-mock + 三面真探针：记忆注入走 **recall gate**〔FTS 可见≠注入，防线在 gate 不在检索层〕、token 重放走 supervision 真审批、毒身份走真 hash 校验）+ sources 扩 P3 三族 + driveP3()。
- **新踩的坑（P3 补记）**：①空身份 manifest v1 是概念行不落库，版本基线从 1 起算（首个变更产 v2）；②迁移/发现类"第二事件"窗口必须有自己的域写（否则 unmatchedWrites 反向洞）；③红队探针的判定层必须打在**防线本体**（gate）而非上游可见性（检索）——判定层选错会把防线误判 breached。

## 5. 23 份规格 → 插件映射表

| 规格 | 插件包 | ctx 服务 | 层 | 阶段 | domain 表（权威/派生） | 事件族 | invalidRecords |
|---|---|---|---|---|---|---|---|
| T0.0 勘察 | —（决策②关闭，无代码） | — | — | P0 | — | — | — |
| T0.1 | tda-goal-state | ctx.goalTree | L5 | P0 | goal_nodes/goal_history（权威）+objective_edits/calibrations/constraint_snapshots | goalTree/change | reject |
| T0.2 | tda-task-pool | ctx.taskPool | L4 | P0 | task_nodes/task_history（权威）+task_runs | taskPool/change | reject |
| T0.3 | tda-timeline | ctx.timeline | L2 | P0 | timeline_entries（权威）+timeline_fts（派生） | timeline/write | reject / fts backup-and-skip |
| T0.4 | tda-context | ctx.context | L2 | P0 | pinned 定义（权威）；AssembleRecord 双写落 event+时间线；PageTable 进程内重建 | context/assemble | reject（定义）/ 记录不落 domain |
| T0.5 | tda-subagent-dispatch | ctx.subagentDispatch | L4 | P0 | dispatch_orders/dispatch_policy（权威）；在飞集合启动重建 | dispatch/change | reject |
| T0.6 | tda-workspace | ctx.workspace | L3 | P0 | file_nodes/edges/scan_cache（**全派生可重建**） | workspace/scan | backup-and-skip |
| T0.7 | tda-trajectory | ctx.trajectory | 横切 | P0 | audit_index（派生） | 消费全族不产族 | backup-and-skip |
| T1.1 | tda-recall | ctx.recall | L2 | P1 | recall_params（权威）+recall_log | recall/change | reject |
| T1.2 | tda-governance | ctx.governance | 横切 | P1 | gov_actions/memory_gov_states/gov_scan_state | memoryGov/change | reject |
| T1.3 | tda-predictor | ctx.predictor | L2 | P1 | transitions/predict_params/extract_state（权威）+predictions/mismatches（派生） | predict/change | 派生表 backup-and-skip |
| T1.4 | tda-meta-thinking | ctx.metaThinking | L3 | P1 | meta_paths（权威）+rehearsal_runs（派生）；lifecycle 归 ctx.governance | metaPath/change | backup-and-skip（runs） |
| T1.5 | tda-drift | ctx.drift | L5 | P1 | drift_scores（派生）；calibrations 读 T0.1 表 | drift/calibrate | backup-and-skip |
| T2.1 | tda-coach | ctx.coach | 横切 | P2 | coach_reports/candidates | coach/change | reject |
| T2.2 | tda-skill-registry | ctx.skillRegistry | L3 | P2 | skill_usage_log；consolidated 物化进 DSH ctx.skills | skill/change | reject |
| T2.3 | tda-maintenance | ctx.maintenance | 横切 | P2 | maintenance_actions/reports（派生） | maintenance/change | reject |
| T2.4 | tda-recall v2（同包扩展，不新立插件） | ctx.recall | L2 | P2 | 扩展 recall_params/parts/recall_log 字段 | recall/change | 同 T1.1 |
| T2.5 | tda-workflow | ctx.workflow | L4 | P2 | workflow_defs/workflow_events（权威）+runs/params（派生） | workflow/change | reject / runs backup |
| T2.6 | tda-plugin-scout | ctx.pluginScout | 横切 | P2 | plugin_assessments/events（权威）+runs/params（派生） | pluginScout/change | reject / runs backup |
| T3.1 | tda-knowledge | ctx.knowledge | L3 | P3 | knowledge_entries/events（权威）+runs/params；结构在 Graphiti 外置 | knowledge/change | reject |
| T3.2 | tda-supervision | ctx.supervision | 横切 | P3 | approval_requests/attention_ledger | supervision/change | reject |
| T3.3 | tda-identity | ctx.identity | 横切 | P3 | manifests/snapshots/migration_records | identity/change | reject |
| T3.4 | tda-security | ctx.security | 横切（验证层） | P3 | redteam_cases/verdicts（派生，env=ci-mock） | 不立新族（发现闭环回功能规格事件） | backup-and-skip |
| — | tda-harness | daemon 宿主（无 ctx 服务） | L1 | P0 起 | 不持业务权威 | 订阅全族 | — |

映射要点：
1. **层归属照蓝图 §2**：L5 目标/元认知、L4 任务执行、L3 资产库、L2 记忆、L1 运行时、横切治理/身份/监督/安全——插件目录不按层分目录（扁平 `plugins/`），层只在映射表与依赖规则中体现；
2. **T2.4 不新立插件**（T2.4 J1：v2 是 T1.1 计分器扩展+主动通道，pipeline/gate 位置不动）——映射表 23 规格 → 20 个 `tda-*` 业务包（含 v2 复用）+ kernel + testkit + harness；
3. **T3.4 零运行时能力**（J1）：只建测试/CI 资产（fixtures + 用例库 + verdicts），不挂模型工具、不加服务——`tda-security` 本质是 `fixtures/` + CI 门，不进 bundle 运行时；
4. **事件族编号以规格为准**（T2.5 第七/T2.6 第八/T3.1 第九/T3.2 第十/T3.3 第十一），内核 `events.ts` 是唯一登记处，未登记族双写即抛。

---

## 6. 风险与未决（工程面）

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | **DSH pre-stable API 漂移**（T0.0 §4 关注项①③）：agent-team experimental、storage/domain seam 可能变 | 依赖其 seam 的插件（T0.1–T0.7 全系）要跟改 | 模式复制原则已隔离核心风险（自有 domain 不依赖 agent-team）；锁定 DSH commit + 升级跑全套冒烟；内核是唯一接触点，DSH 侧改动收敛到内核单点 |
| R2 | **adapter 透出层无 key 实测**（T0.4 J7/T0.0 §6）：流式+logprobs 组合行为文档未明示 | T0.4 perplexity gate 正式版启用时间 | P0 默认 static 路径机制不失效（J6）；透出层先 mock 进 CI；有 key 首个实测项=流式 logprobs + `-9999.0` 哨兵聚合 |
| R3 | **EmbeddingProvider 选型未定**（T0.3 U1）：本地 ONNX vs 远程 API | T0.3 向量检索实际效果 | P0 FTS5 先行 + `vector` 字段占位；seam 已留（J7），选型不改数据结构只换 provider 实现 |
| R4 | **IT3 三并行耦合**：T0.6 语义标注依赖 T0.5 Sidekick 就绪；T0.4 pinned 依赖 T0.1/T0.2 数据面 | IT3 内部其实有先后 | 施工序：T0.5 先行（T0.6 等其 dispatch seam）→ T0.4/T0.6 并行；IT3 出口判定以 T0.5 验收为前置 |
| R5 | **audit_index 重建正确性依赖双写一致**（T0.7 不变量 8）：若双写有洞，重扫=放大错误 | 溯源链可信度 | 双写对账门进 CI（§2.3）；重扫程式本身有 replay-equivalence 测试覆盖 |
| R6 | **daemon 单进程 tick 是 P0 临时形态**（T0.2 U2）：常驻进程模型（单 tick vs 多 worker fencing）未定 | P1+ 周期任务密度上升后的调度瓶颈 | P0 单进程够用（G0 场景）；harness 与业务权威解构（§3.6）保证换进程模型不动插件；多 worker fencing 设计留 P1 排期 |
| R7 | **红队载荷管理**（T3.4 J8/J9）：fixture 是毒物，误入 live domain=自己投毒 | 安全事故 | `fixtures/` 独立目录 + CI env=ci-mock 隔离断言 + grep 自检（载荷只存 hash）；P0 建目录即建规约 |

**工程面未决**（不阻塞 IT0 开工，随迭代关闭）：
- U-e1：monorepo 包名空间（`@tda/*` scope）与 DSH 插件 id 命名最终对齐（`@deepseek-ai/dsh-tda-*` 既有先例，T0.7 §5）——IT0 定；
- U-e2：`tda-testkit` 的 kill -9 在 Windows CI 的等效实现（`process.kill(pid,'SIGKILL')` 平台差异）——**IT0 已定**：`killAndWait` 归一化 `outcome.hardKilled`（POSIX=exit signal 'SIGKILL'；Windows 信号不可观测、signal 恒 null，以 TerminateProcess 固定退出码 1 判定，实测 `{code:1,signal:null}`），kill -9 场景断言一律用 `hardKilled` 不直断 signal；
- U-e3：T0.4 adapter 透出层是 patch `dsh-compaction-basic` 同款 patch 点还是独立 adapter 包——IT3 定（以 DSH 实际 patch 面为准）。

---

## 7. 与路线文档的衔接

- 本方案通过后，`实施任务路线.md` 各任务的"实现待排期"标注按 **IT0→IT4→P1(IT5+)…** 的顺序排期；Gate G0 出口判定 = IT4 验收 + 五条件对账表；
- P1–P3 的迭代切分在本方案骨架上同构复制（每阶段：数据面→执行面→旁路观察层→收官对账），具体切分随各阶段开工前细化，不预先锁死；
- 规格 §6 验收结果回填、路线进度标记、memory 追加沿用既定工作模式不变。

### 7.1 实现进度（截至 2026-09-24）

| 迭代 | 范围 | 状态 | 实测 |
| --- | --- | --- | --- |
| **IT0** | 内核五件 + testkit + CI 四门 + daemon 骨架 | ✅ 完成 | kernel 23/23、testkit 3/3、smoke 6/6 |
| **IT1** | T0.1 goal-state ∥ T0.3 timeline | ✅ 完成 | goal-state 21/21、timeline 19/19 |
| **IT2** | T0.2 task-pool + 联动面 + daemon tick 闭环 | ✅ 完成 | task-pool 24/24、harness 4/4 |
| **IT3** | T0.5 dispatch ∥ T0.6 workspace ∥ T0.4 context（T0.5 先行）+ 装配层桥接 | ✅ 完成 | dispatch 35/35、workspace 27/27、context 24/24、harness 8/8 |
| **IT4** | T0.7 轨迹收官（会话主机 + 审计索引 + resume/replay 冒烟）→ **Gate G0** | ✅ 完成 | trajectory 22/22、kernel 37/37、harness 16/16 |
| **IT5–IT7** | P1 五插件（T1.1–T1.5）+ harness 装配 14 插件 → **Gate G1** | ✅ 完成 | recall 33、governance 35、predictor 29、meta-thinking 26、drift 27、harness 19 |
| **IT8** | T2.1 tda-coach ∥ T2.2 tda-skill-registry（治理 promoteAsset 通道 + use-fail 信号） | ✅ 完成 | coach 23、skill-registry 20 |
| **IT9** | T2.4 recall v2（同包扩展）∥ T2.3 tda-maintenance | ✅ 完成 | recall 41（含 v2 门 8）、maintenance 12 |
| **IT10** | T2.5 tda-workflow ∥ T2.6 tda-plugin-scout + harness 装配 19 插件（P2 五件 seam + sources 扩五族 + driveP2 + P2 集成门）→ **Gate G2** | ✅ 完成 | workflow 13、plugin-scout 9、harness 22（含 P2 集成门 3）；全仓 21 包类型门干净 |

执行命令（Windows/pnpm 不可直接 PATH 调用时用仓库内 `.shim/pnpm.cmd`；vitest 可 `node node_modules/vitest/vitest.mjs run --root <包>` 直跑）：

```
pnpm -r --if-present run typecheck     # 门1 类型
pnpm run gate:invariants               # 门2 不变量
pnpm run gate:dualwrite                # 门3 双写配对
pnpm run gate:smoke                    # 门4 冒烟（kill-9 / replay / 配对）
```

**当前红灯项：无。** 全仓 **12 包**类型检查干净；四门全绿；合计 **234 用例**。IT2 收口补记见 §4 的五条内核缺口、IT3 收口补记见 §4 的六条、IT4 收口补记见 §4 的七条（两处内核/契约 + 两处轨迹层真缺陷 + 三条口径裁定），均已修复并带回归用例。

**下一步（P1 开工）**：Gate G0 已过 → 按《实施任务路线》进 P1（T1.1 引力场最小召回 ∥ T1.2 记忆治理管道 ∥ T1.3 轨迹预测器 ∥ T1.4 元思维库 ∥ T1.5 目标漂移检测）。P1 可直接消费的 P0 出口：①`ctx.trajectory.locate/auditView`（transition 序列与实体→seq 定位，T1.3 轨迹预测器的输入）；②`trajectoryLink` 字段（T0.3 chunk / T0.5 dispatch / T0.6 scan 三处已就绪，T1.1 子目标级示例反查）；③`credentialMin` 预筛与 `quarantined` 标记（T1.1 provenance gate 的数据面）；④`registerScorer` seam（T1.1 引力场计分器挂载点）；⑤`corpus`/`audit_index` 的容量治理归 T1.2。
