# VENDORED — 执行器机制 vendor 记录

> 本文件是本目录**唯一**的来源与改动台账。改动任何一个 vendor 文件，都要在这里同步。
> 最后更新：2026-11-14（按 Notion `04｜Agent Runtime & Reuse Architecture` §08 重划范围后）

## 1. 来源与许可

| 项 | 值 |
|---|---|
| 来源仓库 | `dsh-superagent`（本地 clone：`recruitment-os/work/research/dsh-superagent-prototype`） |
| commit | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`（`feat: add the dsh-superagent research prototype`） |
| 许可 | **MIT**（`LICENSE`：Copyright (c) 2026 DeepSeek Harness Team） |
| 上游运行时 | 原型对标 `@deepseek-ai/dsh` 0.2.1-alpha.2；我们的运行时是 0.2.2-rc.3（`D:\12412\recruitment-runtime`） |

## 2. 判定依据（为什么是这些文件，不是全部）

Notion `04｜Agent Runtime & Reuse Architecture` §08（2026-11-08 源码级复用审查，锁定同一 commit）的结论：

| 上游模块 | 文档结论 | 本目录的做法 |
|---|---|---|
| Effects Queue / Outbox / Receipt / Passes / Intake 去重与订阅分发 | **优先直接 Vendor / 轻量适配** | ✅ 直接 vendor（§3） |
| `core/`（Ticket/Mandate/Assignment/Policy） | 不直接作为招聘 Domain Core；只复用「稳定身份、事务入口、Port 分层、Ticket/Assignment 分离原则」 | ⚠️ 只保留机制闭包与类型/Port 参考层（§3.2），**不采纳 Ticket/Mandate/Policy 作为我们的领域对象**（我们的领域对象 Candidate/Application/Job/Interview 在 PG 里） |
| `executor/dsh.ts` | 不直接搬——强绑 Coding Worktree / Shell / GitHub PR / Coding Prompt | ❌ 未搬；只提取 DSH Session 集成边界（§4.2） |
| `app/store.ts` / `migration.ts` | 不整体搬用 | ❌ 未搬 SQLite 版；改成 PG 实现（§4.1） |
| `sources/github-*`、PR 跟随、worktree 命名、Policy 的准入表 | 不搬 | ❌ 全部未 vendor（§5） |

**判断标准（本目录的准入规则）**：一段代码里出现 Worktree、PR、GitHub、Coding Prompt、Shell 白名单，就不进 vendor 目录。

## 3. 直接 vendor 的清单

### 3.1 文档点名的四块（共 373 行）

| 文件 | 行数 | 上游路径 | 改动 |
|---|---|---|---|
| `app/effects.ts` | 166 | `src/app/effects.ts` | 参数属性→显式字段；SQL 方言：`IFNULL`→`COALESCE`、表名限定 `recruitment.engine_effect`、`ON CONFLICT` 里的 `generation` 限定、`value::text`、INSERT 增加 `tenant_id` 列 |
| `app/outbox.ts` | 62 | `src/app/outbox.ts` | 参数属性→显式字段；宿主依赖 `SourceRegistry`+`Commands` 收窄为窄接口 `OutboxChannels`；**对账修复**（§9.12-9）：加 `lookup` 回读端口、发送前落「正在发送」标记、重试前先回读 |
| `app/passes.ts` | 80 | `src/app/passes.ts` | 参数属性→显式字段；`Engine` 类型改为结构化窄接口 `PassesEngine`（只需 receive/evaluateDue） |
| `core/intake.ts` | 65 | `src/core/intake.ts` | 参数属性→显式字段 |

### 3.2 Intake 去重与订阅分发的机制闭包（共 1,206 行）

Intake 的扇出逻辑写在 `Tickets`/`Replies` 里，无法只搬 intake 一个文件。闭包内文件全部**原样语义**，只做参数属性语法变换：

| 文件 | 行数 | 作用 |
|---|---|---|
| `core/model.ts` | 339 | 类型与不变量：Thread/Ticket/Assignment/Trigger。**参考层**：Assignment 的 pending/running/ended + report 结构是「Task/Attempt 分离」的实现参考，不作为我们的领域对象 |
| `core/ports.ts` | 124 | **Port 分层参考**：Repositories / Executor / Outbox / Assessor / Policy / SourceScope |
| `core/tickets.ts` | 425 | 订阅、扇出入口 `addInput/wake/subscribe`、Ticket 生命周期 |
| `core/replies.ts` | 93 | 允许发给通明的消息规则（acknowledgement/answer/result/attention） |
| `core/part.ts` | 80 | EnginePart 基类：repo/policy/clock/emit 与 fan-out 辅助 |
| `core/errors.ts` | 65 | UserError 与错误码 |
| `core/reasons.ts` | 38 | 原因码与文案 |
| `core/stage.ts` | 23 | 重试判定 |
| `core/ids.ts` | 5 | 稳定 ID 构造（`key(...)`） |
| `core/index.ts` | 14 | 裁剪后的 barrel（Engine/Evals/Assignments/MemoryRepositories **不再导出**） |

### 3.3 机制支撑（共 56 行）

| 文件 | 行数 | 改动 |
|---|---|---|
| `infra/health.ts` | 36 | `Health` 原从 `sources/host.ts` type-only 导入，本子集不搬 sources，故就地声明同形状类型 |
| `infra/text.ts` | 20 | 原样（`checkedImText` 供 Outbox 校验 IM 长度） |

**vendor 合计：1,635 行 / 17 个文件。**

## 4. 自写部分（不是 vendor）

### 4.1 PG 持久化适配层（`app/store.ts`，291 行）

替换上游 `app/store.ts` 的 SQLite 实现（node:sqlite）。**方法签名保持同一组**：

- 构造入口从「SQLite 文件路径」改为「PG 连接配置 + tenant_id」（唯一签名变化）；
- `atomic/afterCommit`、`triggers/threads/tickets/decisions`（实现 `Repositories`）、`receipts/replyStatus`、`get/set/delete/keys`、`db.prepare/get/all/run`、`close/healthState` 与上游同语义；
- 不再有：`settings()/saveSettings()/settingsHistory()/blockRevision()` 与 `read`（视图查询）——它们依赖未搬的 policy/views，本子集不使用；
- 迁移不再做 SQLite 10→11，改为**要求 `db/migrations/0012_engine_state.sql` 已应用**，否则构造即抛错（不降级成空库）。

表结构见 `db/migrations/0012_engine_state.sql`（9 张 `recruitment.engine_*` 表）。设计要点：
单列 uuid `id` 主键 + `tenant_id` 外键到 organization（沿用 verify.sql STRUCT-01/02/03）、JSONB 聚合行、`seq` identity 补 SQLite `rowid` 的插入序、`engine_trigger`/`engine_decision` 挂 `fn_block_delete` 禁删。

### 4.2 同步 PG 桥（`pg/bridge.ts` 154 行 + `pg/worker.ts` 83 行）

引擎的 `Repositories` 端口是**同步**的（`atomic<T>(work: () => T): T`），`pg` 只有异步 API。方案：worker 线程独占一条 `pg.Client`，主线程用 `Atomics.wait` + `receiveMessageOnPort` 同步等回包；`BEGIN/COMMIT/SAVEPOINT` 跨多次同步调用保持。

**实测代价（不许写成"可接受"，这是数字）**：

| 项 | 实测 |
|---|---|
| 单次同步往返 | **0.275 ms/call**（200 次取平均，本机 `ra_s6s7`，见 `work/engine-probe/probe-sync-store.mjs`） |
| 每次调用都阻塞宿主事件循环 | 是。查询期间 DSH 的 agent turn 不推进 |
| 引擎路径 `statement_timeout` | **5000 ms**（worker 连接上 `set statement_timeout`） |
| `lock_timeout` | 3000 ms |
| `idle_in_transaction_session_timeout` | 取 statement_timeout（≥1000 ms） |
| 语句超时后的行为 | PG 取消该语句并抛错；连接仍可用（测试断言：`select pg_sleep(6)` 抛错后 `select 1` 成功） |
| worker 崩溃/被杀后的行为 | 客户端兜底超时 = statement_timeout + 5s；超时即判定失联、终止 worker、标记 `state=error` 并抛错（**绝不静默返回空结果**）；下一次调用自动重建 worker 与新连接。**重建即丢失进行中的事务**，`Store.atomic` 会把该命令判为失败而不是半成功 |

### 4.3 DSH Session 集成边界（`dsh/session-boundary.ts`，59 行）

从上游 `executor/dsh.ts` + `app/sessions.ts` 提取的**窄接口**，只保留四件事 + 一个订阅：

```ts
interface DshSessionBoundary {
  createSession(input): Promise<{ sessionId }>        // 怎么建 Session
  postMessage(message): Promise<boolean>              // 怎么投一条消息（requestId 幂等 + 投前授权检查）
  awaitResult(sessionId, signal): Promise<Outcome|undefined>  // 怎么等结果
  cancel(sessionId, reason): Promise<void>            // 怎么停轮
  observeBackgroundJobs(sessionId, listener): () => void      // 怎么感知后台作业
}
```

没有任何 worktree/PR/Shell 概念进入这个文件。

### 4.4 `RecruitmentTaskExecutor`（`exec/recruitment-task-executor.ts`，**已退休，仅作参考**）

**2026-11-14 总控裁决：本文件不接线。** 任务身份与执行归 `src/runtime/**`（已接线并有真实证据：
`event_inbox → task_wakeup → business_task → task_attempt → agent_session`，DSH headless 真进程 +
真实模型 + 真实工具调用）。两个执行器写同一批表＝两套权威并存，所以本文件保留为**参考实现**，
不从任何入口注册；文件头已写死这一点。

原始设计记录（仅供参考，不要照此接线）：实现 core `Executor` 端口（start/deliver/stop），启动与投递经 Effects 入队；
每个任务一个稳定 worker Session；工具白名单是招聘工具（无 bash/write/edit/git）；任务消息写死"不做代码改动"。

### 4.5 招聘领域适配层（`adapters/recruitment-tasks.ts`，**已退休，仅作参考**）

**2026-11-14 总控裁决：本文件不接线。** runtime lane 以 `event_inbox → business_task` 为权威：
Task ID 由**业务对象幂等键**决定，并记录真实 DSH `runtime_session_id`；本文件则以引擎
Ticket/Assignment 为权威、用确定性 UUID 把引擎对象投影进 `business_task`/`task_attempt`/`agent_session`。
两者同时写同一批表 = **两套 ID 生成器 = 两套权威**（与 `RecruitmentTaskExecutor` 同一理由）。
此外本文件的状态映射（failed/blocked 的落点）也不适用于 runtime 的语义。
配套的 `test/integration/recruitment-task-adapter-pg.test.ts` **已一并移除**——留着会给第二套权威背书。

以下为原始设计记录（仅供参考，不要照此接线）：把机制里的任务模型映射到仓库既有的执行语义表。

| 引擎侧 | 招聘既有表 | 映射内容 |
|---|---|---|
| `Ticket` | `recruitment.business_task` | 确定性 UUID 主键（`taskIdOf`）、幂等键 `engine:ticket:<id>`、`business_refs` 存 Application/Interview 引用、状态机、`current_attempt_id`、`attempt_count`、`error_code`、`completed_at` |
| `Assignment` | `recruitment.task_attempt` | `attempt_no`、`worker_type='DSH'`、`worker_id`、状态、唯一有效租约、`error_class` |
| worker 会话 | `recruitment.agent_session` | `task_id`/`attempt_id` 关联、`runtime_kind='DSH'`、`runtime_version`、`model_route`、ACTIVE→ENDED/LOST |

它当时记录的三条护栏约定（对 runtime 侧仍然成立，值得参考）：
① 与业务写入同事务；② 不绕过 `fn_row_guard`（状态 UPDATE 前 `set_config('recruitment.actor_id', …, true)`）；
③ 不绕过 CHECK（RUNNING 必须有 current_attempt_id、FAILED 必须有 error_code、终态必须落 completed_at/ended_at、
时间戳用数据库时钟兜底）。

### 4.6 插件侧派发者：现状与边界（`src/index.ts` runtime 分支）

**已接线（总控 2026-11-14 落，`src/index.ts` runtime 分支内）**：`HealthBoard` + 同步桥 `Store`
（`statementTimeoutMs: 5_000`）+ `Effects`。三个 handler：

| effect kind | 消费者 | 语义 |
|---|---|---|
| `launch` / `delivery` | **runtime 自己的 tick**（`composed.router.tick`） | 派发是幂等的（库里 SKIP LOCKED），崩溃后重放安全；`quiet: true`（失败已记在 effect 行上，不重复升级健康） |
| `reply` | 无外发通道时**如实抛错**（`no outbound channel configured (v1.0: 外发通道未配置)`） | 不假装发出去；`quiet: true` |

**未装配（边界，v1.0 有意不做）**：

- **`Outbox` 不装配**：它需要一个真实的发送通道（`OutboxChannels.send` + `lookup`）。v1.0 没有配置外发通道，
  所以 `reply` 由上面的「如实抛错」处理；一旦有通道（例如飞书），再按 §4.6-a 装配 `Outbox` 并用它替换这条 handler。
- **`Passes` 不装配**：它驱动 `Engine.receive/evaluateDue`，而 v1.0 的引擎**没有 Engine 实现**（本 vendor 子集只保留了
  Intake/订阅分发机制，没有 `core/engine.ts`）。因此 `Passes` 保持就绪但未注册；需要时注入真实的 `PassesEngine` 再 `start()`。

**§4.6-a 装配 `Outbox`（将来有通道时）**：

```ts
const outbox = new Outbox({ store, effects, sources: <OutboxChannels 实现>, commands, paused: () => false })
// 用它替换上面 reply 的「如实抛错」handler（Effects.handle('reply', …) 同一 kind 只能注册一次）
```

**已知问题（需要 `src/index.ts` 的所有者修；HEAD `990062f` 实测仍是空转）**：当前接线**不会真正派发**。

1. `src/index.ts:405` 构造了 `engineEffects`，但**从未调用 `engineEffects.start()`**；
   `Effects.dispatch()` 第一行是 `if (!this.started || this.stopped) return`，所以队列只会"安全地排队"，永不执行。
2. `src/index.ts:418` 紧接着 `void engineEffects.drain()`，而 `drain()` 会把 `stopped = true` —— 即使先调了
   `start()`，这一行也会把派发停掉。
3. **缺周期性 kick**：runtime 在自己的异步事务里用 `effects-async.ts` 入队，不经过插件的 `Effects` 实例，
   因此不会触发它的 `kick()`。`Effects` 自己没有定时器（原型里靠 `Passes.start()` 的 2s interval 驱动，
   而 `Passes` 在 v1.0 未装配），所以启动后新入队的行会一直躺着。

A/B 实测（`work/engine-probe/probe-dispatcher-wiring.mjs`）：

```
A 现状接线（只 handle + drain，无 start）: 派发后仍在队列 = true     ← 空转
B 补 start + 300ms kick 定时器:            仍在队列 = false        ← 会派发
```

修法（语义不变）：

```ts
engineEffects.start()                                        // 替换 `void engineEffects.drain()`（第 418 行）
const pump = setInterval(() => engineEffects.kick(), 2000)   // 与 Passes.start 的 2s 同频
return () => {
  disposeHttp(); clearInterval(pump)
  void engineEffects.drain().finally(() => { engineStore.close(); void closePool(pool) })
}
```

（`drain()` 从装配时挪到关闭时：先停止接新活、等运行中的 effect 结束，再关同步桥。否则 in-flight 的同步语句会被杀在连接上。）

**依赖的已注册服务**：只有 `ctx`（logger）、`config.database`、环境变量 `RECRUITMENT_DB_PASSWORD`。
`Store`/`Effects`/`Outbox`/`Passes` 不依赖其他插件服务，也不直接依赖 Cordis Context。

**注意**：`Store` 构造时若 `recruitment.schema_migration` 里没有 `0012_engine_state`，会直接抛错（不静默退化成空库）。
这属于启动期错误，应当让注册失败而不是吞掉。

### 4.7 与 `0011_task_runtime.sql` / `0013_trace_chain.sql` 的关系

同一天另外两条 lane 新增了 `0011_task_runtime.sql`（给 `business_task`/`agent_session`/`event_inbox` 加运行时列与 `task_wakeup` 表）和 `0013_trace_chain.sql`（加 `correlation_id`）。**它们改的正是本适配层写入的表**，因此适配层按库的**实际列**工作，不假设某一边：

| 0011/0013 的列 | 适配层的处理 |
|---|---|
| `agent_session.runtime_session_id`（0011） | **由 runtime 写入**真实 DSH 会话 ID（适配层已退休，见 §4.5；它当时的探测逻辑不再在役） |
| `business_task.wake_count` / `last_wake_event_id`（0011） | 有默认值，适配层不写（唤醒事实属 Router 的职责，不该由执行器伪造） |
| `agent_session.runtime_worker_role`（0011，NOT NULL default 'WORKER'） | 走默认值 |
| `correlation_id`（0013） | 适配层留空；链路追踪应由产生事件的入口注入，不应在执行器里编造 |

`0011` 的 `fn_agent_session_identity_guard`（attempt 必须属于同一 task）与适配层的写入顺序天然一致（先 task → attempt → session），已由集成测试覆盖。

**当前状态：以上均未注册**。`RecruitmentTaskExecutor` 与 `RecruitmentTaskAdapter` 已能被直接构造并运行（集成测试为证），但没有从任何运行中的入口可达 —— 按 R2 不得称为可用能力。

**自写合计（在役）：约 696 行**（PG 适配层 320 + 异步副作用写半边 86 + 同步桥 237 + DSH 边界 59）。**已退休、不计入在役**：执行器 137 行、领域适配层 283 行（两份都保留作参考，不得接线）。

### 4.8 对账修复：外部动作成功但回执丢失（§9.12-9 / Notion 08 §9.8 第 5 条）

**原缺陷**（验收红）：`outbox.ts` 先 `sources.send()` 再 `receipts.settle()`，中间崩溃则既无回执也无回读；
退避到期后 `reply` effect 直接重发，同一 `message_id` 线上出现 2 条。根因是 `OutboxChannels` 只有
`instance/channelAllowed/send`，**没有回读端口**。

**修复**（三层）：

1. **端口**：`OutboxChannels` 增加可选 `lookup(message, commands): Promise<'present'|'absent'>`。
2. **发送前落标记**：`Store.receipts.markSending(id)` 在调用 `send()` **之前**把 `attempt:{state:'sending'}` 写进回执。
   从这一刻起"外部可能已经有这条消息"成为持久事实，跨进程重启也成立。
3. **重试前先对账**（`outbox.deliver` 的顺序，`receipts.behind` 之后）：
   - 回读 `present` → `settle('sent')` 补记，**不重发**；
   - 回读 `absent` → 才允许重发；
   - 回读不可用（源没实现 `lookup`）/抛错 → 归为未知：保持 `pending`，写 `reconcile:{outcome,reason}`，抛 `Later` 退避，
     **绝不默认重发**；
   - `send()` 返回 `waiting`（通道未装好，确定没出去）→ 清标记，允许正常重试；`send()` 抛错 → 保留标记，下次先对账。

**证据**：

- `test/acceptance/engine-gates.test.ts` §9.12-9 **由红转绿**，断言未改（`wire.length === 1` 仍是唯一判据）；
- 本 lane 补了三条正向/反向证据（`test/integration/engine-mechanisms-pg.test.ts`「回读端口」用例）：
  `present` → `send` 只被调用 1 次且回执变 `sent`；`absent` → 第 2 次 `send` 发生且线上只有 1 条；回读抛错 → `send` 仍只 1 次、回执 `pending`、原因落库。

### 4.9 职责切分：任务执行归 `src/runtime/**`，持久副作用归本目录

**裁决（2026-11-14，总控）**：`src/runtime/**` 那条 lane 已经完成并**接线**了任务执行
（`event_inbox → task_wakeup → business_task → task_attempt → agent_session`，DSH headless 真进程 +
真实模型 + 真实工具执行，有逐字证据）。本 lane 的 `RecruitmentTaskExecutor` 与它写同一批表，
等于"两套权威并存"，因此**按职责切开，只保留一个执行器**：

| 职责 | 归属 | 状态 |
|---|---|---|
| 任务身份与执行（business_task / task_attempt / agent_session 的推进） | `src/runtime/**` | ✅ 已接线、有真实证据 |
| 持久副作用：Effects 队列 | `src/engine/`（本目录） | ✅ 已由总控在 `src/index.ts` runtime 分支装配（§4.6） |
| 持久副作用：Outbox 回执 / Passes 驱动 | `src/engine/`（本目录） | ⏸ **未装配**：v1.0 无外发通道、无 Engine 实现（§4.6 边界） |
| 领域状态回写（Ticket→business_task 等） | `src/runtime/**` | runtime 以 `event_inbox → business_task` 为权威；本目录的 `adapters/recruitment-tasks.ts` ⛔ **退休**（两套 ID 生成器） |
| `RecruitmentTaskExecutor` | `exec/` | ⛔ **退休**，仅作参考，不接线（§4.4） |

**两者交界（runtime → 本目录）**：`src/engine/app/effects-async.ts`（本 lane 自写）。

- runtime 在自己的**异步事务**里调用 `enqueueEffect(client, …)` / `recordOutbound(client, …)`，
  副作用与业务写入**同一 PG 事务**（崩溃窗口为零）；
- 派发由持有**同步桥**的一侧（插件进程）用 `Effects` 完成（已装配：launch/delivery 由 runtime tick 消费、reply 无通道时如实失败）；对账端口 `Outbox.lookup` 随 `Outbox` 一起**未装配**，等外发通道接上再启用；
- 对账走 `Outbox.lookup`（§4.8）；runtime 需要知道某条消息状态时用 `readReceipt(client, messageId)`。

**runtime 能不能直接复用 `Effects` / `Outbox`？**

- **路径上能**：同一包内相对导入 `../engine/app/effects.ts` 即可，无包边界、无新依赖；
  `effects-async.ts` 对 `effects.ts` 只有 **type-only** 导入（运行时不会连带拉起同步桥的 worker 线程）。
- **直接用不行**：`Effects`/`Outbox` 的端口是**同步**的（`Store.db.prepare` + `atomic<T>(work: () => T): T`，
  引擎命令要求同步事务），而 `src/runtime/store.ts` 是**异步** `withActor/withReadOnly` + `DatabaseClient`。
  同步桥有自己的连接，**无法加入 runtime 的异步事务**——硬接会丢掉"业务写入与副作用同事务"这条保证。
- **最小暴露方式（已实现）**：runtime 只引 `src/engine/app/effects-async.ts` 一个文件，用
  `enqueueEffect` / `recordOutbound` / `readReceipt` 三个函数；不需要引入 `Store`、`Effects` 或同步桥。
  这就是"写半边在 runtime、派发半边在插件"的切分。

**证据**：`test/integration/engine-effects-junction-pg.test.ts` —— 用 runtime 同形态的异步事务入队通知与回执，
提交后由插件的 `Effects`/`Outbox` 从同一批表派发，回执 `pending → sent`，重复登记幂等。

```
$ node --test test/integration/engine-effects-junction-pg.test.ts
✔ runtime 的异步事务写副作用 → 插件的 Effects/Outbox 派发（同一批表）
ℹ pass 1  fail 0  skipped 0
```

## 5. 按文档判定**没有搬**的东西（逐条理由）
| 上游文件 | 没搬的理由 |
|---|---|
| `executor/dsh.ts`(670) / `executor/background.ts`(156) | 强绑 Coding Worktree / Shell / GitHub PR / Coding Prompt；只用其 DSH 边界（§4.3） |
| `app/sessions.ts`(348) / `app/delivery.ts`(83) / `app/prompts.ts`(244) / `app/role-models.ts`(42) / `app/retry-health.ts`(84) | coding 角色的 prompt/tool/skill 装饰、模型预算与 relay，均非四块机制所需 |
| `app/assessment.ts`(278) / `app/cards.ts`(94) / `app/context.ts`(28) / `app/links.ts`(68) / `app/resources.ts`(303) / `app/notices.ts`(125) / `app/tools/tool.ts`(33) | 主会话候选卡、资源读取、通知排版：属"Agent 如何向人展示"，不是任务机制 |
| `app/execution-environment.ts`(41) / `app/skill-files.ts`(32) / `app/cache.ts` / `app/versions.ts`(33) | 执行环境/技能/文本缓存/设置版本，非四块机制所需 |
| `policy.ts`(242) / `admission.ts` / `limits.ts` | Policy 与准入表是原型的 GitHub Agent 授权模型；我们的授权在招聘领域 |
| `deployment.ts` / `setup.ts` / `infra/commands.ts` / `infra/environment.ts` / `infra/paths.ts` | GitHub/GitHub-CLI 部署与校验、`gh` 代理；**不搬** |
| `sources/github*.ts` / `sources/feishu*.ts` / `sources/registry.ts` / `sources/kind.ts` / `sources/host.ts` / `sources/admission-context.ts` | Source 插件层（GitHub/Feishu 读取、轮询、鉴权）；我们的 Source 是招聘 intake 连接器 |
| `kv.ts` | 键定义依赖上面的 prompts/policy/sources 类型；本子集改用 `Store` 的字符串键（`get/set/keys`） |
| `prompts/**`、`skills/**`（资产） | 只服务 coding 角色与 github/feishu 技能文本，随 sessions/prompts 一起移出 |

**桩（store boundary stubs）**：本目录**没有**任何 GitHub/Feishu 桩——按新范围这些模块根本没进目录，因此不存在"改引用成桩"的问题。此前版本存在过 6 个桩（`sources/github.ts`、`github-pull.ts`、`github-read.ts`、`feishu.ts`、`feishu-read.ts`、`app/resources.ts`），已在本次重划中**整体删除**。

## 6. 工程约束（与仓库约定一致）

1. **参数属性已全部去除**：Node 24 默认 strip-only 不能执行 TS 参数属性（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`），而我们的插件 `main` 就是 `src/index.ts`，由 DSH 直接加载 TS。故 vendor 进来时把 `constructor(private readonly x: T)` 一律改成「显式字段 + 构造函数里赋值」，**纯语法等价**，逐文件改动已列在 §3。
2. **行尾统一 LF**；文件路径结构保持 `app/ core/ infra/` 与上游一致（相对 import 基本不需要改）。
3. **禁止依赖 `--experimental-transform-types`**：所有 vendor 文件必须在裸 `node --test` / DSH 默认加载下可执行。
4. 类型检查：`npx tsc -p tsconfig.engine.json`（只覆盖 `src/engine/**` 与本目录的集成测试，宿主其余代码不打包）。

## 7. 复跑

```powershell
cd dsh\dsh-recruitment
$env:RECRUITMENT_DB_PASSWORD='123456'
node --test test/integration/engine-mechanisms-pg.test.ts          # 四机制 + 回读对账 + 桥的失败语义
node --test test/integration/engine-effects-junction-pg.test.ts    # runtime 异步事务 ↔ 插件 Effects/Outbox
node --test test/acceptance/engine-gates.test.ts                   # §9.12-9 等运行时门槛（其他 lane 的验收）
npx tsc -p tsconfig.engine.json                                    # 类型检查
node work/engine-probe/probe-sync-store.mjs                        # 同步桥实测（含 0.275–0.35ms/call 数字）
```

> 两个 `test/integration/engine-*.test.ts` 共用同一租户的 `engine_*` 表，而 `engine_effect` 是**单一队列**
> （持有 Effects 的进程会消费同 kind 的行）。文件内部用 PG 会话级 advisory lock 串行化，
> 所以 `node --test` 并行跑文件也不会互相偷行；锁超时 30s，冲突会明确报错而不是挂住。

实测汇总（2026-11-14，`ra_s6s7`）：

- 本 lane 在役集成测试（mechanisms + junction）并行跑：**tests 5 / pass 5 / fail 0 / skipped 0**；
- `test/acceptance/engine-gates.test.ts` 回归：**tests 6 / pass 6 / fail 0 / skipped 0**；
- `npx tsc -p tsconfig.engine.json`：exit 0；
- 同步桥往返：**0.275–0.349 ms/call**；`select pg_sleep(6)` 被 statement_timeout 取消且连接仍可用；worker 被杀后下一次调用重建成功。

迁移：`node work/engine-probe/apply-migration.mjs ../../db/migrations/0012_engine_state.sql`（本机无 psql CLI）。
