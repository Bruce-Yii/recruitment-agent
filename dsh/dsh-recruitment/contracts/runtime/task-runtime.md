# 任务运行时契约 · Business Task / Task Attempt / Agent Session / Event Runtime

**状态**：本合同随 `db/migrations/0011_task_runtime.sql` + `src/runtime/**` 一起交付。
**权威来源**：Notion `04｜Agent Runtime & Reuse Architecture` §10（事件运行时）、
§12（上下文、会话与长期状态）；`docs/03-domain-and-runtime.md` §9–§13；
`db/verify.sql` STRUCT-01..07。
**范围**：v1.0 的"事件驱动自动执行"与"长任务跨会话"。
**不覆盖**：语义准入的 Router / Assessor 判断本身（只落 `ROUTER_TRIAGE` 任务等
Router 处置）、外部副作用对账（`durable_effect`）、多租户调度（v1.0 不做）。

---

## 1. 三层身份（不可混用）

| 层 | 表 | 身份规则 | 失败/重试时 |
|---|---|---|---|
| Business Task | `business_task` | `id` 稳定；`idempotency_key` 在租户内唯一 | **ID 不变**；重试只新增 Attempt |
| Task Attempt | `task_attempt` | `(task_id, attempt_no)` 唯一；`fencing_token` 单调 | 每次执行独立状态/错误/结果；同一 Task 同时最多一个活跃租约 |
| Agent Session | `agent_session` | 每次执行一行；`runtime_session_id` 对回真实 DSH 会话 | Session 结束只标 `ENDED`/`LOST`，**不承担任务身份** |

**结构保证**：`business_task` **没有** 指向 `agent_session` 的外键列；Session 丢失
在结构上无法让 Task 丢失。`trg_agent_session_identity_guard` 额外拒绝
"Session 认领别的 Task 的 Attempt"、"ROUTER 角色挂 attempt"、"挂 attempt 但无 task_id"。

**允许的合法映射**：一个 Task 可以有 N 个 Attempt；每个 Attempt 可以有多个
Agent Session（**不同 DSH Session** 时，例如重建会话）；**同一 DSH Session 的续跑接管既有
`agent_session` 行**（更新 `attempt_id`/`status`/`last_heartbeat`，不插新行）；一个 DSH Session
只能对应同一租户/runtime 的一行 `agent_session`（`uq_agent_session_runtime`）。
> 2026-11-15 G2 实现回抄：续跑（`resume_sessions=true` 且 worker 复用同一 `runtime_session_id`）
> 复用既有行；这正是 G2 修掉的 P0（旧实现每 Attempt 插新行 → finish 撞唯一约束、attempt 停 RUNNING）。

---

## 2. Event Runtime

### 2.1 输入信封

必填：`tenantId`（必须等于运行时租户）、`provider`、`eventType`、`payload`（JSON 对象）、
`trustLevel ∈ {UNTRUSTED_EXTERNAL, INTERNAL}`。
`providerEventId` 与 `sourceObjectId` 至少一个；两者都没有 → `INVALID_EVENT`。

幂等键：
1. 有 `providerEventId` → `provider:providerEventId`，`idempotency_source=PROVIDER_EVENT_ID`；
2. 没有 → 必须给 `sourceObjectId`，键 = `provider:fallback:<object>:<type>:sha256(canonical(payload))`，
   `idempotency_source=FALLBACK_KEY`（0001 `ck_event_inbox_fallback_*` 的逐字要求）。

### 2.2 处理顺序（一次 `receive`）

1. 校验信封（不合法 → 不落库，`INVALID_EVENT`）；
2. **先落 Event Inbox**（独立事务提交）；
3. 再路由（独立事务）：定位业务对象 → 建/唤醒 Task → 标记 `dispatch_state=ROUTED`；
4. 路由失败 → `dispatch_state=FAILED` + `route_error`，事件保留；`processPending()`
   按 `route_attempts < max_route_attempts` 重试。**事件不会因路由崩了而丢**。

### 2.3 幂等（库层，不是内存）

- `uq_event_inbox_idempotency (tenant_id, idempotency_key)`；
- `uq_event_inbox_provider_event (tenant_id, provider, provider_event_id) WHERE provider_event_id IS NOT NULL`；
- `uq_task_wakeup_event (task_id, event_id)`：同一事件对同一 Task 只唤醒一次；
- `uq_business_task_idempotency (tenant_id, idempotency_key)`：同一事件/同一业务
  对象不重复建 Task。

同一事件投递两次的期望结果：`event_inbox` 1 行、`business_task` 1 行、
`task_wakeup` 1 行、`task_attempt` 0 行、第二次返回 `outcome=duplicate`。

### 2.4 两条路径

**唯一权威源**：事件类型的登记表是 `src/runtime/event-types.ts` 的 `EVENT_TYPE_REGISTRY`。
发射方（`src/tools/**`、`src/domain/**`）引用 `EVENT_TYPES` 常量，路由方从注册表**派生**
确定性路由表与显式忽略表——两侧不存在第二份手抄字符串。
机检：`test/runtime/event-types.test.ts` 扫描 `src/**` 全部 `event_inbox` 发射点，要求每个
发射名都已登记（发射未登记的名字 → 测试红），并反向要求每个登记项的生产者文件确实引用注册表。

**确定性事件**（登记为 `DETERMINISTIC`，无需模型判断，按业务对象 + 任务类型稳定建 Task；
同一对象的后续事件唤醒同一 Task）：

| 事件名 | 产生者 | 业务对象 | Task 类型 |
|---|---|---|---|
| `resume.intake.received` | `recruitment_application_intake` | `INTAKE_RECORD`（按事件行反查 `intake_record.event_id`；payload 只有 sha256，没有对象 UUID） | `RESUME_PARSE` |
| `scorecard.submit` | `recruitment_scorecard_submit` | `INTERVIEW`（payload `interview_id`） | `EVALUATION_SYNTHESIZE` |

**显式忽略**（登记为 `IGNORED`，不建 Task，`route_error` 写 `REGISTERED_IGNORED: <原因>`）：

| 事件名 | 产生者 | 为什么不触发 |
|---|---|---|
| `decision.record` | `recruitment_decision_record` | 人工决策已由工具在同一事务落库；v1.0 没有"决策后自动执行"的任务类型，二次触发会重复推进 |
| `interview.rescheduled` / `interview.cancelled` / `interviewer.withdrawn` | `recruitment_interview_schedule` | 同一事务已写幂等 STORE Task（`INTERVIEW_SCHEDULE`/`INTERVIEW_MEETING_BIND`）；事件只是审计事实（理由只能落 payload），再触发会执行两遍 |
| `job.rubric_version.approved` | `recruitment_job_rubric_approve` | 批准已由命令事务写库；`schema/0001` 审计事件不进待路由队列 |
| `application.rubric_version.pinned` | `src/domain/stage-advance.ts` | 同上 |
| `<table>.<column>.changed`（19 个挂载点） | `db/migrations/0001_init.sql` 的 `fn_row_guard` | 状态迁移审计事实；`normalizer_version='schema/0001'` 不进待路由队列，后续工作由发出迁移的命令路径负责 |

> **不允许**"表里没有 → 落到语义 Gate"作为已知类型的归宿：那是隐式的、不可审计的。
> 已知类型必须二选一（`DETERMINISTIC` / `IGNORED`），`IGNORED` 必须写原因。
> 未登记 = 未接线（语义准入只服务外部未知信号，不服务本项目的发射方）。

**语义准入**：未登记的类型必须先过 `DefaultSemanticGate`（准入规则未放宽）：
- 只接受 `trustLevel=INTERNAL`；
- 事件类型显式 `semantic.*` / `router.*`，或 `payload.intent` 非空；
- 通过后只创建 `ROUTER_TRIAGE` Task，状态 `WAITING_HUMAN`，**不自动派发 Worker**。
- 未通过 → `dispatch_state=IGNORED` + `route_error=SEMANTIC_GATE_REJECTED:...`，不建 Task。

确定性事件缺少业务对象 ID → `IGNORED`（`BUSINESS_OBJECT_NOT_FOUND`），不猜 ID。

### 2.5 分派状态机

`RECEIVED → ROUTED | IGNORED | FAILED`；`FAILED` 可重试回到 `ROUTED/IGNORED`。
`ROUTED`/`IGNORED`/`FAILED` 必须有 `routed_at`；`FAILED` 必须有 `route_error`；
`routed_task_id` 只允许出现在 `ROUTED`。列级不可变白名单只放行这些运行时投影列，
事件主体（provider/payload/幂等键/trust/occurred_at）仍不可改。

### 2.6 启动水位（cutover）：历史事件永不派发

`tick()` 处理待路由事件的**第一步**是读该租户的 `recruitment.runtime_watermark.cutover_at`
（`db/migrations/0015_runtime_cutover.sql`）：

- `received_at < cutover_at` → **历史**：只把 dispatch 投影标成 `IGNORED`，
  `route_error = BEFORE_RUNTIME_CUTOVER: ...`；不建 Task、不写 `task_wakeup`、
  不入队副作用、**不改事件主体任何列**；
- `received_at >= cutover_at` → 正常派发（与没有水位时语义一致）；
- 该租户没有水位行 → `CUTOVER_WATERMARK_MISSING`（**fail closed**：不猜一个"现在"，
  也不静默返回空）。

判定列是**库生成的 `received_at`**（入库时刻），不是事件 payload 里的 `occurred_at`
—— 后者来自外部、可被伪造，用外部时间做 cutover 等于让外部决定"我要不要被派发"。
水位只能前进；把它改小必须走 `recruitment.fn_runtime_watermark_rewind`（要求 actor +
非空理由，并由触发器写 REWIND 审计行）。完整规则、各写入函数与运维步骤见
`contracts/runtime/runtime-cutover.md`。

---

## 3. Task / Attempt 生命周期

### 3.1 状态映射（Attempt 结果 → Task 状态）

| Worker 结果 | Attempt 状态 | Task 状态 | 备注 |
|---|---|---|---|
| succeeded | SUCCEEDED | SUCCEEDED | `result_ref` 回写；业务校验仍由领域服务负责 |
| failed + retryable + attempt_no < max | FAILED_RETRYABLE | RETRY_WAIT | `retry_after` 必填；Task ID 不变 |
| failed + 不可重试 / 超过上限 | FAILED_FINAL | FAILED | `error_code` 必填；`completed_at` 落库 |
| waiting | FAILED_RETRYABLE (`WAIT_EXTERNAL`) | WAITING_EXTERNAL | 可被新事件唤醒 |
| blocked | FAILED_RETRYABLE (`WAIT_EXTERNAL`) | WAITING_HUMAN | 等待人工处置 |
| 租约过期/进程丢失 | ABANDONED (`WORKER_LOST`) | RETRY_WAIT | 下一次 tick 新建 Attempt |
| 超时/取消 | FAILED_RETRYABLE (`TRANSIENT`) | RETRY_WAIT | 进程被 kill，Session 标 LOST |

任务终态：`SUCCEEDED` / `FAILED` / `CANCELLED` / `SUPERSEDED`。终态 Task 被新事件
唤醒时回到 `PENDING`（清 `completed_at`、失败字段），**ID 不变**。

### 3.2 认领与租约

`tick()` 用 `SELECT ... FOR UPDATE SKIP LOCKED` 认领 `PENDING/READY/RETRY_WAIT`
且 `next_run_at <= now()` 的 Task（排除 `ROUTER_TRIAGE`），插入 Attempt 后把 Task
置 `RUNNING` + `current_attempt_id`。

- `uq_task_attempt_active_lease (task_id) WHERE status IN ('CLAIMED','RUNNING')`
  保证同一 Task 同一时刻只有一个活跃 Attempt；
- `lease_expires_at` 必须大于 Worker 超时（`runtime.lease_ms > runtime.timeout_ms`），
  否则会被自己的回收流程误杀；
- 回收只处理 `CLAIMED/RUNNING` 且租约过期的 Attempt；`ix_task_attempt_lease_reclaim`
  是这条扫描的索引。

### 3.3 结果边界（诚实）

`outcomeState=succeeded` 只表示 **Worker 报告并解析出了成功结果**；本运行时能校验的
是结构（JSON 形状、`result_ref`、Session 存在）。**不把 Worker 自述当业务成功**
（Notion §13）：真正的业务结果校验（例如 Application 是否真的推进）必须由领域服务
读回后另写事实；在该校验存在前，Task 的 `SUCCEEDED` 只是"执行层成功"。本合同
不授权越过任何人工闸门或业务审批。

---

## 4. HTTP 入口（默认关闭）

只有 `config.runtime.enabled === true` 且数据库/Worker profile 配置齐全时才注册；
监听地址非回环时**不注册**（fail closed）。所有端点要求 loopback + 同源头
`x-recruitment-request: 1`。

| 方法 | 路径 | 语义 |
|---|---|---|
| POST | `/recruitment/runtime/events` | 投递一个事件；重复事件返回 duplicate |
| POST | `/recruitment/runtime/tick` | 重放待路由事件 → 回收失联 Attempt → 派发一个 Task；可重复调用 |
| POST | `/recruitment/runtime/events/pending` | 只重放待路由事件 |
| GET | `/recruitment/runtime/tasks/:id` | 三层身份投影（task/attempts/sessions/wakeups） |
| GET | `/recruitment/runtime/tasks?limit=` | 最近任务 |
| GET | `/recruitment/runtime/health` | 事件/任务/尝试/会话计数 |

`tick` 的幂等不靠进程内标志：重复调用时 Task 已是 `RUNNING` 或终态、Attempt 唯一
租约、`SKIP LOCKED` 共同保证不会重复派发。单轮只派发一个 Task；并发由多个调用方
各自 tick 决定。

---

## 5. 证据与标签

- `provenance`：`LIVE` 仅当执行事实来自真实进程/真实工具副作用；测试替身不产生
  该标签。
- `DSH_SESSION`：`REAL` = `runtime_session_id` 来自真实 DSH 进程的 `session` 事件，
  且 `agent_session.runtime_session_id` 与之一致。
- `TOOL_EXECUTION`：`REAL` = DSH 会话日志里有对应 `tool/call`，且工具副作用
  （文件/DB 行）可读回并与参数匹配；模型文本自述不算。
- `MODEL`：实际 provider/model 原样记录；mock 必须写 `TEST_DOUBLE`。

未按此标注的能力视为未验证，不得进入验收结论。
