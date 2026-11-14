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
| `app/outbox.ts` | 62 | `src/app/outbox.ts` | 参数属性→显式字段；宿主依赖 `SourceRegistry`+`Commands` 收窄为窄接口 `OutboxChannels` |
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

### 4.4 `RecruitmentTaskExecutor`（`exec/recruitment-task-executor.ts`，104 行）

按文档重写的执行器（**不是**搬 coding executor），落地方案：

- 实现 core 的 `Executor` 端口（`start/deliver/stop`），**启动与投递都经 Effects 入队**（与命令同事务，进程崩了不丢），真正的 Session 创建在 `launch()` 里做；
- 每个任务一个稳定 worker Session（`recruitment-worker-<ticketId>`），跨会话续做；
- 工具白名单是**招聘工具**（`RECRUITMENT_TOOLS`：resume_read / candidate_get / job_get / interview_get / transcript_read / report / note），**没有** bash/write/edit/git/worktree；
- 任务消息显式写明边界「不做代码改动、不碰仓库」。

**接线状态（R2 诚实标注）：尚未挂到任何 HTTP 路由或 Worker 入口，也还没接我们的领域表。** 现在它能被 Effects 驱动、被 `Tickets` 的 Executor 端口调用；距"可达"还差：①领域适配（Ticket ↔ Application/Interview 任务）；②插件入口注册（`src/index.ts` 属其他 lane）。未经接线不得当作能力交付。

**自写合计：691 行。**

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
node --test test/integration/engine-mechanisms-pg.test.ts   # 四机制 + 桥的失败语义
npx tsc -p tsconfig.engine.json                             # 类型检查
node work/engine-probe/probe-sync-store.mjs                 # 同步桥实测（含 0.275ms/call 数字）
```

迁移：`node work/engine-probe/apply-migration.mjs ../../db/migrations/0012_engine_state.sql`（本机无 psql CLI）。
