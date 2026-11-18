# 27 · 后端架构审查：路由与执行线（2026-11-18）

> **这份是什么**：总控对"事件 → 任务 → 执行"这条线的一次架构审查与建议，**不是裁决**。
> 采纳与否由产品负责人拍板；采纳后写成 `docs/17` 裁决再由 lane 落地。
> **范围**：只看后端（路由 / 任务 / 执行 / 副作用）。**不碰前端**——界面怎么显示不归这里。
> **证据**：事实均给 `file:line` 或 `psql` 读回；数字取自 `ra_live_e2e_20261118`（真 Host 跑过的库）。

---

## 1. 一句话结论

**执行线的"骨架"是对的，"接缝"是空的。**
三层身份（Task / Attempt / Session）、PG 行锁 + 租约 + `SKIP LOCKED`、幂等键、advisory lock 防重入——这些该有的都有，而且没有第二个状态 owner。
但**只有 2 类事件真的会生成任务**、**成功判据是模型说"我做完了"而不是业务事实变了**、**失败之后没有"等人接手"的出口**。所以它的形状像一条执行线，实际只承担了"简历解析"和"面评汇总"两件事。

---

## 2. 现在这条线到底怎么走（事实）

### 2.1 事件 → 路由

`src/runtime/routing.ts` + `src/runtime/event-types.ts`：

| 路径 | 规则 | 今天的结果 |
|---|---|---|
| **确定性路由** | 登记表里 `routing.kind='DETERMINISTIC'` 的事件，按 `taskType` 直接建任务 | **只有 2 条**：`resume.intake.received → RESUME_PARSE`、`scorecard.submit → EVALUATION_SYNTHESIZE` |
| **忽略** | 登记表里 `kind='IGNORED'`（行守卫类事件等） | 绝大多数事件走这里 |
| **语义准入** | 未登记 + `INTERNAL` + 声明为 `semantic.*`/`router.*` 或带 `intent` | 只建 `ROUTER_TRIAGE`，且**永不自动派发**（`ROUTER_ONLY_TASK_TYPES`） |

**结论**：`decision.record`、`application.current_stage_code.changed`、`job.closed`、`approval.status.changed` 这些业务事实变更，全部**只被记录、不产生后续动作**（库里 10 类事件、4 类任务状态变更，见 §6 读回）。这不是 bug，是"还没接线"。

### 2.2 Task / Attempt / Session 三层身份

`src/runtime/task-runtime.ts:1-11` 的设计是对的：
- `business_task` 一行，ID 在重试间不变；
- `task_attempt` 每次执行一条，`attempt_no` 递增，独立错误与结果；
- `agent_session` 每次执行登记，结束只标 ENDED/LOST，**不改 Task 身份**。

状态机（库约束实测）：
- Task：`PENDING / READY / RUNNING / WAITING_EXTERNAL / WAITING_HUMAN / RETRY_WAIT / SUCCEEDED / FAILED / CANCEL_REQUESTED / CANCELLED / SUPERSEDED`
- Attempt：`CLAIMED / RUNNING / SUCCEEDED / FAILED_RETRYABLE / FAILED_FINAL / TIMED_OUT / CANCELLED / ABANDONED`
- 错误分类：`TRANSIENT / WAIT_EXTERNAL / AUTH_REQUIRED / INVALID_INPUT / BUSINESS_CONFLICT / PERMANENT / UNKNOWN_OUTCOME / WORKER_LOST`

**这套状态机比大多数招聘系统都细**，问题不在状态机，在"谁去写它"。

### 2.3 调度

- `router.tick()` 一次做三件：重放待路由事件 → 回收失联 Attempt → **派发一个** Task（`router.ts:63-85`）。
- 单轮只派一个，是刻意的：tick 是**幂等恢复入口**，不是并发调度器；并发靠多调用方各自 tick + `SKIP LOCKED`。
- 自动 tick 由 `tick-loop.ts` 起，用 **PG 会话级 advisory lock** 防多实例重复派发（`tick-loop.ts:1-4`）。
- 认领：`status in ('PENDING','READY','RETRY_WAIT') and next_run_at <= now()` 按 `priority, next_run_at, created_at` 排序，`FOR UPDATE SKIP LOCKED`（`store/claim.ts:56-61`）。

### 2.4 执行与收尾

`worker.ts`：spawn `dsh --profile <worker> --json --permission-mode <mode> <prompt>`，读 NDJSON；**拿到 `final` 就算成功**（`worker.ts:193-198`）：
```
if (exit.final !== null) return { errorCode: null, errorClass: null, retryable: false }
if (killed)               return { errorCode: 'WORKER_LOST', errorClass: 'WORKER_LOST', retryable: true }
return { errorCode: 'WORKER_NO_FINAL', errorClass: 'TRANSIENT', retryable: true }
```

---

## 3. 拿真实招聘闭环对照

真实闭环（v1.0）：简历到达 → 读得懂 → 人看得明白 → 面得下去 → 评得出来 → 人做决定 → 事后查得到。

| 闭环环节 | 业务上是不是"长活" | 今天靠谁 | 判断 |
|---|---|---|---|
| S6 简历到达 → 解析 | **是**（转换/OCR/结构化，可失败可重试） | `RESUME_PARSE` 任务 | ✅ 该有，有 |
| S7 初筛（对照标准、给建议） | 否（人在等，要秒回） | Agent 在会话里同步做 | ✅ 不该进任务队列 |
| S8 约面试 | 否（人操作） | Host Action 同步 | ✅ |
| S9 转写进来 → 处理 | **是**（长文、分块、摘要） | **同步导入**，`transcript_processing_run` 表**没有写入方** | ⚠️ 悬空 |
| S9→S10 面评提交 | 否（人点） | Host Action + 事件 | ✅ |
| S10 汇总（面评齐 → 汇总） | **是**（要等 N 份、要读多份面评） | `EVALUATION_SYNTHESIZE` 任务 | ⚠️ 有任务，但**不检查"是否齐了"** |
| S10 人做决定 | 否 | Host Action 同步 | ✅ |
| 决定之后（阶段/生命周期/通知） | 部分 | 同事务同步派生 | ✅（不需要异步） |
| 卡住的任务 → 谁来处理 | — | 没有出口（见 §4-P1b） | ❌ |

---

## 4. 七个问题（按严重度）

### P1-a · "任务成功"= 模型说完成了，不是业务事实变了

`classifyWorkerExit` 只要 NDJSON 里出现 `final` 就判成功。也就是说：**只要模型肯收尾，任务就算做完**，哪怕它一行业务数据都没写。
真实招聘里"简历解析完成"的定义是"字段落库、校验通过、能被人看见"，不是"模型说了句 done"。

> **建议**：给每个 `task_type` 配一个**业务后置条件**（一个只读断言函数），Attempt 的成功 = `final` 且后置条件通过；反之记 `BUSINESS_CONFLICT` 或 `INVALID_INPUT`（进 §4-P1-b 的出口）。
> 这项工作不需要改调度器，只需要在 `finishAttempt` 之前插一步读回。

### P1-b · 失败之后没有"等人接手"的出口

- 失败命运由**错误分类**决定：`UNKNOWN_MODEL` 归 `INVALID_INPUT` / 不可重试 → 第一次就 `FAILED_FINAL`（`worker.ts:161-164`，这是对的——配置错误重试也没用）；`TRANSIENT` 类才会 `RETRY_WAIT`（默认上限 3，`task-runtime.ts:80`）。
- 但**不管哪种终态失败，都没有"需要人处理"的出口**：`WAITING_HUMAN` 只被语义 triage 写（`store/events.ts:201`），**业务任务从不写它**。

**这不是"要不要做站内提醒"的问题**（产品负责人已明确指出：前端本来就有一份"需要你处理"的待办，HR 和面试官各自看自己的）。**前端的位置已经有了，缺的是后端往里写事实**：解析失败的简历现在只会变成 `business_task` 里一行 `FAILED`，没有任何"需要人处理"的业务事实，所以前端那份待办里永远不显示它。

> **建议**：终态失败时，除了把 Task 标 `FAILED`，再**写一条"需要人处理"的业务事实**（复用既有 `WAITING_HUMAN` 语义，不新建表），并带一句人话原因（"这份简历没能读出来" vs "凭据失效" vs "文件太大"）。前端不用改，它已经在读这类待办了。

### P2-a · 路由表只登记了 2 个事件

其余业务事件全部 `IGNORED`。这不是错，但要承认：**今天是"有两个后台任务的产品"，不是"有执行线的产品"**。

> **建议**：只补"真的需要后续动作"的那几条，别为了对称把事件都接上：
> - `interview.completed`（或 record READY）→ 生成/唤醒"等面评"事实（不是提醒，是状态）；
> - `decision.record` → 直接结束生命周期（现在在事务里同步做了，确认无遗漏即可）；
> - `transcript.imported` → 若走异步，则登记 `TRANSCRIPT_PROCESS`。
> 补的时候保持现有纪律：**登记表是唯一权威**，别在别处手抄事件名（这是 2026-11-14 那场事故的根因）。

### P2-b · `dependency_refs` 是空字段（**但不是缺陷，是闲置**）

库里有 `business_task.dependency_refs`，代码里**一次都没用过**（全仓 0 命中）。

**更正我最初的判断**：我原以为会出现"面评没齐就汇总出假结论"。查过之后不成立——
- `recruitment_evaluation_summarize` 会按 `submitted / missing / waived` 如实算，缺人时 `average=null` 并给 `missing` 数，**不会编一个假汇总**；
- 决策闸门在 `decision-record.ts` 里会抛 **`SCORECARD_MISSING`**（合同 TC §4.1），缺面评的正式决策根本落不了库。

所以"缺一份就等"这条产品规则**已经在闸门上生效**，不靠任务调度保证。

> **真正剩下的只是一点效率问题**：每份面评提交都会唤醒一次汇总任务（幂等，不会建多条），缺人时它跑一趟只是算出"还缺 2 份"。这是"每次变化就重算"的正常做法，不是错误。
> **建议**：不动它。如果将来汇总变贵（比如要读转写），再考虑用 `dependency_refs` 做派发前 gate；现在加是过度设计。

### P2-c · 没有"延后任务"（**v1.0 不需要，别做**）

`next_run_at` 有字段、claim 也按它过滤，但**没有任何写入方设置未来时间**。

**这不构成缺口**：招聘里"到点了要提醒"的东西（面评逾期、待办堆积），**读的时候算一次就行**——`overview.ts` 现在就是这么干的，前端也已经有"需要你处理"的清单。真正的延时任务只在"到点要主动推一条消息出去"时才需要，而产品明确**不做站内催办**（`docs/24 §4`）。

> **建议**：不动。把它写成一句口径（"逾期与待办一律读时计算，不建延时任务"），避免下一轮有人以为字段空着就是没实现。

### P3-a · 转写处理的异步线是悬空的

`transcript_processing_run` 表存在、有状态机（`chunk_total/chunk_failed`）、`overview` 也在读它判"卡住"——但**全仓没有写入方**。
今天转写是在 `transcript_import` 请求里同步做完的：短的够用，长的（两小时会议、多语种、分块摘要）会顶到请求超时。

> **建议**：要么明确"v1.0 同步就够，表只是预留"并写进台账；要么补 `TRANSCRIPT_PROCESS` 任务（事件 `transcript.imported` → 任务），把表真正用起来。**二选一，别让它继续空着**——空表最贵，它会让人以为有这条线。

### P3-b · 副作用层（durable_effect / receipt）有表无写入方

五事实里的"副作用 + 回执"，`trace.ts` 已经如实写了"没有写入方"。v1.0 确实没有外部写（合规上也该如此），所以：
> **建议**：在台账里把这一层**显式标成"v1.0 不用，v1.1 出站时启用"**，并从"已完成能力"的清单里拿掉。空着不写，比写了没有更难发现。

### P4 · 语义准入事实上不存在

`ROUTER_TRIAGE` 建了任务，但 `ROUTER_ONLY_TASK_TYPES` 让它**永不派发**，等于"事件被收下、然后没人看"。

> **建议**：要么给 triage 一个真人入口（"有一条看不懂的信号，要不要处理"），要么在 v1.0 直接拒绝这类事件并写清 reason（现在 reason 写了，但任务行会堆积成噪声）。我倾向后者：**v1.0 不做语义入口**。

---

## 5. 我不建议做的（防止过度架构）

1. **不引 pg-boss / 不自研队列**（D-109 已经论证过）。现在的 PG 行锁 + 租约够用。
2. **不做通用工作流引擎**。DAG 只需表达"面评齐了才汇总"这一层，`dependency_refs` 够。
3. **不做动态优先级/抢占**。招聘不是实时调度问题。
4. **不把 tick 改成并发派发**。单派发 + 多调用方是正确取舍；真有并发需求先量化。
5. **不为"对称"把所有事件都接上路由**。每条路由都是要维护的业务语义。

---

## 6. 现场读回（证据）

`ra_live_e2e_20261118`（真 Host 跑过）：

```
business_task: RESUME_PARSE / FAILED / attempt_count=1 / UNKNOWN_MODEL
               EVALUATION_SYNTHESIZE / FAILED / attempt_count=1 / UNKNOWN_MODEL
task_attempt : 2 行，均 attempt_no=1 / FAILED_FINAL（终态，不会自动重跑）
event_inbox  : 10 类事件，其中 business 类 5 种（resume.intake.received / scorecard.submit /
               decision.record / application.current_stage_code.changed / job.status.changed 等）
```

两条任务都是**同一个原因**失败（worker 没登记模型，已修）。`UNKNOWN_MODEL` 归 `INVALID_INPUT` / 不可重试，所以第一次就 `FAILED_FINAL`——**这个判定本身是对的**，但它暴露的正是 P1-b：**失败之后没有任何"需要人处理"的出口**——它们在库里躺了 20 分钟，工作台没提示、没人知道。

---

## 7. 关于"吸收 DeepSeek 超级架构"（**口径更正**）

`docs/17` **D-105** 的标题写的是"研究结论，**未采纳其代码**"——**这句是错的/过时的，本次审查更正**：

| 事实 | 证据 |
|---|---|
| 仓库里**确实 vendor 了** `dsh-superagent-prototype` 的机制代码（MIT，commit `8c32a9d…`） | `dsh/dsh-recruitment/src/engine/**`（`core/` `app/` `infra/` `pg/` `dsh/` `exec/`），台账 `src/engine/VENDORED.md`（来源/许可/逐文件改动） |
| 引入时间是 `2bae294`（2026-11-14），**D-105 之后**，且**没有写进台账** → 按 R5 属"未决定就被做了" | `git log` + VENDORED.md §1 |
| 但它的**领域对象没被采纳**：Ticket/Mandate/Policy 只留类型与 Port 参考，招聘领域对象仍在 PG | `VENDORED.md §2` |
| 它**被装配了**：`src/index.ts:651-676` 用 vendor 的 `Store`/`Effects` 做**副作用派发器**（`launch`/`delivery` → 触发 `router.tick()`；`reply` → v1.0 无外发通道，如实抛错） | `index.ts:651-676` |
| 但它的票据/触发器表**一行都没写过**：真 Host 跑完整链后 `engine_ticket / engine_trigger / engine_disposition / engine_outbox / engine_effect` 全部 **0 行** | `ra_live_e2e_20261118` psql 读回 |

**所以准确说法是三句**：
1. 我们**没有**整体采纳 superagent 的领域模型（正确）；
2. 我们**确实** vendor 了它的效应/出站机制，并把它当成一个**薄桥**接在运行时旁边（`launch`/`delivery` 只用来踢 `router.tick()`）——这层今天等价于"一个 2 秒一次的 pump"，没有证据表明它必须存在；
3. 真正的执行线（任务真相、认领、租约、恢复）**是我们自己写的 PG 行锁那条**（D-109/D-122 C1），不在 vendor 范围内。

> **这一点必须由产品负责人拍一下**（已入 `docs/17` D-151）：vendor 的 engine 层是**保留为薄效应桥**、还是**退役**？留着就要接受"两个状态 owner 的表在库里空着"，退役就要把 `index.ts` 的装配拆掉、把 `engine_*` 表标成保留。**不允许继续现在这种"装了、没人喂、也没人说不装"的状态。**

---

## 8. 如果要动手，我建议的顺序

| 顺序 | 做什么 | 为什么排这个位置 | 代价 |
|---|---|---|---|
| 1 | **业务后置条件**（P1-a） | 不修的话，"成功"永远是模型自说自话；后面所有统计都不可信 | 每个 task_type 一个只读断言；不动调度器 |
| 2 | **失败出口 → 等人处理**（P1-b） | 这是 HR 真能感觉到的："这份简历没过，你要不要处理" | 复用 `WAITING_HUMAN` + 现有工作台列表 |
| 3 | ~~依赖 gate~~（**已撤回**） | 查证后不成立：决策闸门已用 `SCORECARD_MISSING` 挡住缺面评的正式决策，汇总本身也会如实报 `missing`。不做。 | — |
| 4 | **路由补 1–2 条**（P2-a） | 按真实需要补，别对称补 | 只改登记表 |
| 5 | 转写异步化（P3-a） | 等有真实长会议样本再决定同步还是异步 | 二选一，先写口径 |
| 6 | 语义入口（P4） | **建议 v1.0 不做**，直接拒 | 一行 reason |

**1–4 是后端的事，我一个人可以派 lane 做；5–6 需要产品口径先定。**

---

## 9. 需要产品拍板的（不是技术问题）

1. ~~提醒算不算"站内沟通"~~ —— **已不是问题**：产品负责人指出前端本来就有"需要你处理"的待办（HR 与面试官各看各的），缺的是后端往里写事实（见 P1-b）。**问错了，撤回。**
2. **失败任务归谁处理**（P1-b）——**已拍：可以**（写进"需要你处理"的待办，由当前操办这条申请的人看到）。剩余唯一要定的是措辞：说"没能读出来"还是"需要你重试"。
3. **转写同步够不够**（P3-a）——取决于有没有真实的长会议样本。**待定**。

---

## 10. 三条线对照（产品负责人要求：自建 / DSH 原生 / 超级架构，逐个查）

> 证据：`work/research/2026-11-18-dsh-native-execution.md`（DSH 原生能力清点，逐条 `包:行`）、
> `work/research/2026-11-18-superagent-execution-model.md`（原型执行模型，含原文引句）、
> 本仓库 `src/runtime/**`、`src/engine/VENDORED.md`。

### 10.1 三类各自的真相在哪

| | 真相存在哪 | 重启后 | 能不能承担"招聘任务" |
|---|---|---|---|
| **A 自建（我们）** | PG `business_task / task_attempt / agent_session` | ✅ 租约回收 + 同 task id 新 attempt | ✅ 就是干这个的 |
| **B DSH 原生** | 会话日志（JSONL）+ 进程内存 | 会话能恢复（合成收尾，不续跑）；**作业/任务板/审批待办都不跨进程** | ❌ 只能当执行载体 |
| **C superagent 原型** | 单机 SQLite（9 张表） | 运行中的 Assignment 判 `host restarted` 结束，按最老工单重开 + recovery note | ❌ 第二状态 owner，且是单机 |

### 10.2 能力逐项对照（这张表是这次研究的主要产出）

| 能力 | DSH 0.2.2-rc.3 原生 | superagent 原型 | 我们的现状 | 判定 |
|---|---|---|---|---|
| 后台作业 | `ctx.jobs`：进程内 `Map`，进程死即丢（`dsh-jobs-local/src/index.ts:169`） | `effect` 表：先存后做、2s→60s 重试、三振 | `engine_effect` 表 + `Effects` 派发器（vendor） | **只能借形状**；DSH jobs 不能当执行线 |
| 定时/提醒 | `schedule`：**真持久**（`<DSH_HOME>/storages/schedule.json`），重启只补最近一次，至少一次投递 | 无独立调度，靠 Passes 2s 轮询 | 未使用（逾期读时算） | **不需要**：产品不做站内催办 |
| 任务/工单 | `agent-team` 任务板 = **Lead 会话日志投影**，CAS revision + DAG，单进程 | Ticket 聚合 + Assignment 六态 | `business_task` 三态身份（PG） | 形状可借（CAS/DAG），**真相不能借** |
| 子代理并发 | `subagent`/`fork`：同进程、可续接；**跨进程未实现**（`dsh-subagent/README.md:240,252`） | worker slots：`maxWorkers` + **1 个人工超额槽**，不会挤掉在跑的 | 单 tick 单派发 + PG `SKIP LOCKED` | 人工槽位语义**值得借**（今天没有"人的消息优先"的表达） |
| 持久编排 | `workflow`：**无 journal，重启不能续**（`dsh-workflow/README.md:127`） | — | — | **不用** |
| 人机闸门 | `ctx.approval`：open-turn 内 one-shot，**pending 在进程内存**（`dsh-user-approval/README.md:164-168`） | `Attention` 领域对象 + `person/answer`（非阻断、无超时） | PG 决策闸门（`SCORECARD_MISSING` 等）+ 浏览器点 | 闸门状态**必须留 PG**；只借卡片形状 |
| 长任务恢复 | 会话级恢复（合成收尾，不续跑中断轮） | 运行中一律判死、重开 + recovery note | attempt 递增 + 租约回收 | 我们的口径已对；可借"重开时附 recovery note" |

### 10.3 结论：三层，不是三选一

1. **真相层 = 必须自建（PG）**。DSH 的真相是"会话日志 + 进程内存"，prototype 的真相是"单机 SQLite"——两者都不能承担跨进程、可审计、要追责的招聘任务。这一条不因为"吸收谁"而改变（D-109 / D-122 C1）。
2. **执行载体 = DSH**。会话、审批卡片、计量、子代理、会话日志（当审计轨迹）——这些是我们不该自研的（R1）。
3. **设计形状 = superagent**。效应先存后做 + 三振、worker slots（含 1 个人工槽）、Attention 的思路——借形状，不借 owner。

**一句话**：我们不是"选了其中一套"，而是**拿 PG 当账本、拿 DSH 当手、拿 prototype 当图纸**。今天的毛病是：图纸借进来了（vendor），但**账本和手之间的接缝没接完**（§4 的 P1/P2）。

### 10.4 三条可落地的（按性价比）

1. **先给 engine 层定性**（保留薄桥 or 退役）——现在它装着、0 行、没人说得清为什么在。这是最便宜的清理。
2. **借"人工超额槽"的语义**：`router.tick()` 今天对"人的即时请求"和"后台批处理"一视同仁。至少要表达"人点的那一下优先"，否则批量导入时 HR 的操作会排在后面。**只需在 claim 的排序里加一档，不动架构。**
3. **重开 attempt 时写 recovery note**（借 prototype 的做法）：现在新 attempt 只知道"上次失败了"，不知道"上次做到哪"。`task-context.ts` 已经有 UNKNOWNS 机制，把上次 attempt 的 summary/错误摘一句进去即可。

### 10.5 明确不做（防止被"吸收超级架构"带偏）

- 不把 DSH `jobs` / `agent-team` 任务板 / `workflow` 当我们的执行线——三个都**不跨进程**。
- 不把 `ctx.approval` 当跨轮闸门——它只在 open turn 内有效、pending 在内存里。
- 不引第二个调度器 / 第二个状态 owner（含 SQLite）。
- 不为"对称"把 Ticket/Mandate/Policy 搬进领域——我们的领域对象在 PG（Candidate/Application/Job/Interview）。
