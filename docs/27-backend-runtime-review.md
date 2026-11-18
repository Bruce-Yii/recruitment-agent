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
- 但**不管哪种终态失败，都没有"需要人处理"的出口**：`WAITING_HUMAN` 只被语义 triage 写（`store/events.ts:201`），**业务任务从不写它**；工作台的"等待人工的任务"因此只显示 triage 任务——**解析失败的简历不会出现在任何"需要你处理"的列表里**。

真实业务里这条必须存在：HR 要知道"这份简历没读出来，要么重试、要么我自己看"。

> **建议**：把 `FAILED`（`PERMANENT / INVALID_INPUT / AUTH_REQUIRED`）映射成 `WAITING_HUMAN` + 一条可读的"需要人处理"事实（写进既有 `business_task` 行，不新建表），工作台的"等待人工"自然就能显示出来。同时把错误分类翻成人话（"模型不认识这个文件" vs "文件太大" vs "凭据失效"）。

### P2-a · 路由表只登记了 2 个事件

其余业务事件全部 `IGNORED`。这不是错，但要承认：**今天是"有两个后台任务的产品"，不是"有执行线的产品"**。

> **建议**：只补"真的需要后续动作"的那几条，别为了对称把事件都接上：
> - `interview.completed`（或 record READY）→ 生成/唤醒"等面评"事实（不是提醒，是状态）；
> - `decision.record` → 直接结束生命周期（现在在事务里同步做了，确认无遗漏即可）；
> - `transcript.imported` → 若走异步，则登记 `TRANSCRIPT_PROCESS`。
> 补的时候保持现有纪律：**登记表是唯一权威**，别在别处手抄事件名（这是 2026-11-14 那场事故的根因）。

### P2-b · `dependency_refs` 是个空字段，没有 DAG

库里有 `business_task.dependency_refs`，代码里**一次都没用过**（全仓 0 命中）。
`EVALUATION_SYNTHESIZE` 现在靠"每份面评提交都唤醒同一个任务"的幂等来近似，**不检查"该来的面评是不是都来了"**——一旦有人在 1/3 时就点汇总，任务会照跑。

> **建议**：在 claim（或 dispatch 前）加一道**依赖 gate**：`dependency_refs` 里每条 ref 都处于终态才允许派发，否则 `WAITING_EXTERNAL`（这正好是既有状态，不用新造）。工作量小，收益是把"假事实"挡在门外。

### P2-c · 没有"延后任务"

`next_run_at` 有字段、claim 也按它过滤，但**没有任何写入方设置未来时间**。于是"面试前提醒""面评逾期""超时自动交接"这类**有时间维度**的业务动作没有承载。

> **建议**：先别写代码。先回答产品问题：**提醒算不算"系统内沟通"？**（`docs/24 §4` 明令不主动做站内催办）。如果答案是"只做事实、不发消息"（例如工作台显示"已逾期 3 天"），那根本不需要延时任务——读的时候算就行，现在的 `overview` 就是这么干的。如果要发消息，那就先立裁决，别偷偷加。

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

## 7. 关于"吸收 DeepSeek 超级架构"

澄清一下口径（`docs/17` **D-105** 记录过）：`dsh-superagent-prototype` 是官方**研究原型**，我们借的是它的**形状**——人机闸门（Human Attention）、任务真相在库、面板按"注意力"组织；**没有采纳它的代码**，执行线是按 PG 行锁自建的（D-109/D-122 C1）。

所以"路由和执行线"这件事，**不是从它继承来的，是我们自己写的**。它写得对不对，得拿招聘业务来判——本文就是干这个的。结论：骨架对，但上面三个 P1/P2 的接缝还空着。

---

## 8. 如果要动手，我建议的顺序

| 顺序 | 做什么 | 为什么排这个位置 | 代价 |
|---|---|---|---|
| 1 | **业务后置条件**（P1-a） | 不修的话，"成功"永远是模型自说自话；后面所有统计都不可信 | 每个 task_type 一个只读断言；不动调度器 |
| 2 | **失败出口 → 等人处理**（P1-b） | 这是 HR 真能感觉到的："这份简历没过，你要不要处理" | 复用 `WAITING_HUMAN` + 现有工作台列表 |
| 3 | **依赖 gate**（P2-b） | 防"面评没齐就汇总"这类假事实 | 一处 claim 前检查 |
| 4 | **路由补 1–2 条**（P2-a） | 按真实需要补，别对称补 | 只改登记表 |
| 5 | 转写异步化（P3-a） | 等有真实长会议样本再决定同步还是异步 | 二选一，先写口径 |
| 6 | 语义入口（P4） | **建议 v1.0 不做**，直接拒 | 一行 reason |

**1–4 是后端的事，我一个人可以派 lane 做；5–6 需要产品口径先定。**

---

## 9. 需要产品拍板的（不是技术问题）

1. **提醒算不算"站内沟通"**（P2-c）——算，就要立裁决并说清代价；不算，就只做"事实展示"。
2. **失败任务归谁处理**（P1-b）——HR 自己处理，还是管理员？决定它在谁的待办里出现。
3. **转写同步够不够**（P3-a）——取决于有没有真实的长会议样本。
