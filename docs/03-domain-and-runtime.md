# 03 · 领域模型与运行时契约

**来源**：Notion 03（逐字）、10（逐字）、08 §13；`docs/03`、`docs/06`。

---

# 第一部分 · 领域模型

## 1. 三十四个业务对象（含义 + 关键关系）

| 对象 | 含义 | 关键关系 |
|---|---|---|
| Organization | 企业/租户 | 拥有 Department、User、Policy、Requisition |
| Department | 部门或业务组织 | 提出 Requisition，关联 Hiring Manager |
| User / Role | 企业用户和角色 | 管理权限、职责与可见范围 |
| Requisition | 招聘需求 | 审批后创建或关联 Job |
| Job | 企业内部正式岗位 | 使用 Pipeline Template，产生多个 Posting 和 Application |
| Job Posting | 某渠道上的发布实例 | 关联 Job、Channel、发布时间与状态 |
| Candidate | 候选人个人档案 | 可拥有多个 Resume 和 Application |
| Prospect | 主动寻访得到的人才线索 | 确认后可关联或创建 Candidate |
| Resume | 简历原文件及版本 | 关联 Candidate 和来源；保留原件与解析版本 |
| Candidate Acquisition Source / Channel | 候选人获取来源和渠道 | 邮件/表单/平台/推荐/寻访；**与技术 Connector Source 分开** |
| Application | 某候选人针对某岗位的一次招聘申请 | 关联 Candidate、Job、Pipeline Instance |
| Pipeline Template | 可复用的招聘流程模板 | 定义 Stage、Interview Template、Stage Activity Template、条件与审批 |
| Pipeline Instance | 某条 Application 实际运行的流程 | 当前阶段、历史迁移、并行分支、阻塞 |
| Stage | 招聘流程阶段 | 可串行/并行/条件跳转；进入可触发活动模板 |
| Interview Template | 面试模板 | 本轮目标、Briefing、Focus Attributes、问题模板、Feedback Form |
| Stage Activity Template | 阶段活动模板 | 进入/离开阶段要创建的待办、通知、排期、材料收集 |
| Interview | 一次具体面试实例 | 按模板创建，关联 Application、Stage、Interviewer、Meeting |
| Interviewer | 参与某轮面试的用户 | 拥有本轮任务与 Scorecard |
| Meeting | 外部会议实例 | 关联会议平台、会议 ID、日历事件 |
| Transcript | 会议原始转写 | 关联 Meeting / Interview |
| AI Summary | Agent 生成的摘要 | 引用 Transcript 和时间戳，**不覆盖原文** |
| Interview Record | 结构化面试事实 | 关联 Interview、Transcript、Candidate |
| Scorecard | 某位面试官独立评价 | 关联 Interview、Interviewer、评分标准版本 |
| Decision | 阶段或最终决策 | 决策人、结果、理由、时间 |
| Approval | 需求/岗位/Offer 等审批实例 | 关联审批对象、审批链与结果 |
| Offer | 录用方案及版本 | 关联 Application、Approval、候选人响应 |
| Talent Pool | 人才库/分组 | 关联 Candidate 与可复用状态 |
| Business Task | 长期后台工作事项 | 关联一个或多个业务对象；**不等于 Requisition/Application/Interview** |
| Task Attempt | 一次具体执行尝试 | **不能用新 Task 代替重试** |
| Agent Session | 模型执行上下文 | 关联 Attempt；**不承担业务事实和任务身份** |
| Chat Thread | 用户可追溯的聊天窗口 | 一个 Thread 可触发多个 Business Task |
| Source Thread | 外部邮件/消息/会议讨论上下文 | **不等于用户 Chat Thread** |
| Event Inbox / Event | 外部或内部事件接收记录 | 来源 ID、幂等键、原始事实 |
| Durable Effect / Outbox | 需跨进程恢复的外部副作用 | 回执、重试、失败状态 |
| Agent Execution Policy / Mandate | Agent 对某任务的执行授权 | **不替代 HR 业务审批** |
| Business Config / Rubric Version | 各层配置版本 | 被筛选、面试、评价、决策引用 |

> 逐字：**"以上为逻辑对象清单，不等于最终数据库表数量；落库时可按成熟模块的实际数据模型映射。"**

## 2. 四组必须分离的对象

### Candidate / Resume / Application
逐字：**"Candidate 是人，Resume 是简历文件及版本，Application 是针对某岗位的一次招聘申请。一个人可以有多份简历、多个岗位申请；不能把三者压成同一个对象。"**
例：同一人 11 月申请 A 岗、12 月申请 B 岗、次年再次申请 A 岗 → **一个 Candidate + 多条独立 Application**。
同岗位再次申请是新建、重新激活还是冷却期限制，**由企业规则决定**。

### Requisition / Job / Job Posting
需求（为什么招、几个、预算、审批）→ 正式岗位定义 → 渠道发布实例。一个 Requisition 可产生多个 Job；一个 Job 可发多个渠道；各渠道状态独立。

### Pipeline Template / Interview Template / Pipeline Instance
- Stage 可含**多个** Interview Template / Slot（同轮可同时有用人经理面试 + 业务专家面试，**分别产生实际 Interview 和独立 Scorecard**）。
- Stage Activity Template 定义进入阶段自动创建的业务待办（安排面试、发材料、催交 Scorecard、背景调查、准备 Offer）。
- **"模板更新不应静默改写已开始的招聘申请；应明确选择继续沿用旧版本或迁移到新版本。"**

### Interview / Transcript / Summary / Record / Scorecard
原始转写、AI 摘要和人工评价**不能互相覆盖**；摘要保留对原文的引用与时间戳；1 Interview 可关联多 Meeting；1 Meeting 可产生多 Artifact；**转写状态、Scorecard 状态、决策状态分轴**。

## 3. 五组状态机

```
Requisition: Draft → Pending Approval → Approved → Recruiting → Paused / Filled / Cancelled
Job:         Draft → Pending Review → Approved → Open → Paused → Closed / Archived
Interview:   Scheduled → In Progress → Post Interview → Evaluation Ready → Decided
             (+ Rescheduled / Cancelled / No Show)
Offer:       Draft → Pending Approval → Approved → Sent → Accepted / Declined / Expired / Withdrawn
```

> **Requisition 有一条关键边界**（逐字）：**"人员离职事件只产生需求信号，不直接把 Requisition 设为 Approved。"**

### Application 拆四轴（不设单一线性 status）
| 轴 | 表达什么 |
|---|---|
| **Application Lifecycle** | 这条申请是否还在流程中：ACTIVE / ON_HOLD / WITHDRAWN / CLOSED（**具体枚举待 Schema 阶段冻结**） |
| **Pipeline Instance** | 当前 Stage、迁移、并行分支、历史。Screening / HR Review / Interview / Evaluation / Offer 是**可配置 Stage 示例，不是固定序列** |
| **Resume / Intake Processing** | 附件接收、解析、失败、人工补录、候选人关联。**"不能把 PARSING 当成招聘阶段。"** |
| **Decision** | ADVANCE / HOLD / REJECT / HIRED 等结果、责任人、依据。**不通过覆盖 Application 历史状态表达结论** |

### Candidate
**"Candidate 的全局身份状态不等于某一条 Application 的招聘进度。"** 档案可合并，但合并需明确身份匹配依据和历史迁移规则。

## 4. 十条最小数据不变量

1. 一个 Application 必须关联一个 Candidate 和一个 Job
2. Candidate 合并不删除历史 Application
3. Requisition、Job、Job Posting 各自有独立身份和状态
4. Interview 必须关联明确的 Application 和面试轮次
5. **Meeting 与 Interview 通过平台 ID / 内部映射绑定，不能靠标题猜测**
6. **Transcript 原文不可被 AI Summary 覆盖**
7. **Scorecard 必须记录评价者和使用的评分标准版本**
8. Workflow 状态迁移必须有来源事件或用户动作、执行时间和结果
9. 重要审批和决策保留责任人、时间、结果和理由
10. **配置变更不静默改变历史已完成评价或已结束申请**

## 5. Intake 三层模型

```
Event Inbox（技术事件）→ Source Event（标准化来源发生）→ Intake Record（一份可独立处理的材料包）
  → Intake Asset（原文件、类型、大小、checksum、来源、校验结果）
  → Resume Version（不可覆盖）
  → Candidate / Prospect / Application
```
- 逐字：**"一封转发邮件包含三份候选人资料，应拆成三条 Intake Record。"**
- **"渠道 Adapter 不得直接写 Candidate，也不得把 Event Inbox 当作候选人业务档案。"**
- 主动寻访产生 **Prospect + Sourcing Activity**，不伪装成邮件/表单 Intake。

## 6. Candidate 合并

1. 规范化邮箱、电话、稳定平台 ID、已验证个人主页等**强标识**用于匹配建议。
2. 姓名、学校、公司、经历、语义相似**只产生 Duplicate Review**，**不允许 LLM 独立决定合并**。
3. 合并前展示双方档案、冲突字段、字段来源、全部 Resume Version、全部 Application。
4. 授权 HR 选主档并确认；写**不可变 Merge Record + 别名映射 + 操作者 + 时间 + 字段处理 + 来源版本**。
5. **不删除历史引用，不合并或覆盖 Application。**
6. 反向操作用**引用原 Merge Record 的补偿式 Split**，不抹审计历史。
7. 合并命令携带双方 `expected_record_version`；版本变化返回冲突，要求刷新后重认。

> **2026-11-12 新方向**：**高置信度多维匹配且无冲突时可自动归并**；只有真实歧义/冲突才人工复核。自动归并同样必须保留上述记录与可追溯纠正。Git `docs/03`/`docs/10` 仍写"必须人工确认"，属**待同步实现口径**。

## 7. 10.0 后续对象（不阻塞 v1.0）

**Sourcing Activity**（检索来源/查询条件、公开资料引用、发现时间、负责人、触达状态与结果）· **Communication Record**（邮件/消息/电话方向、渠道、参与者、时间、外部消息引用、结果、下一步责任人）· **Calibration Record**（业务目标、成功画像、必需/加分能力、职责边界、团队责任、轮次覆盖、Rubric 版本、确认人）· **Onboarding Handoff**（关联已接受 Offer、Candidate、Job、目标系统、负责人、字段快照、发送/确认状态、外部回执）。

**两个"只做投影，不建事实库"**：Candidate Timeline 由 Sourcing Activity / Communication Record / Interview / Stage Activity / Decision 投影；Human Attention Inbox 由待 Approval / Task / 逾期 Scorecard / Connector Incident / 人工复核项聚合。

**两个"不新增"**：**Opening 只在需要对每个名额独立管理生命周期时才独立建模**；**Interview Plan 不新增独立核心实体**（继续由 Pipeline Template / Stage / Interview Template·Slot / Stage Activity Template 表达）。

---

# 第二部分 · 运行时契约

## 8. 五类事实必须分开

| 类型 | 代表对象 | 回答 |
|---|---|---|
| 招聘业务事实 | Candidate、Application、Job、Interview、Scorecard、Decision | 业务当前是什么状态 |
| 外部事件事实 | Event Inbox / Integration Event | 外部实际发生了什么 |
| 待完成的业务工作 | **Business Task** | 系统还需要完成什么 |
| 某次执行事实 | Task Attempt、Agent Session、Tool Call | 某次执行如何运行、结果如何 |
| 外部副作用事实 | Durable Effect、Outbox、Receipt | 系统对外发出了什么、外部是否确认 |

**四条禁令（逐字）**：不能把会议转写事件当成 Interview；不能把 Agent Session 当成长期任务；不能把 Tool Call 成功当成招聘业务完成；不能把模型生成的摘要当成原始转写。

## 9. Event Envelope 十四个字段

`event_id` / `tenant_id` / `provider` / `provider_event_id` / `event_type` / `schema_version` / `occurred_at`（外部发生，**不等于收到时间**）/ `received_at` / `correlation_id` / `causation_id` / `idempotency_key`（优先 `provider + tenant + provider_event_id`）/ `payload_ref`（**大文件不进事件表**）/ `payload`（**平台原始字段不得直接成为业务契约**）/ `trust_level`（**外部文本始终不可信，不因 webhook 验源而变成指令**）。

**接收规则 6 条**：验来源/签名/租户，验不过不触发；用来源幂等键写 Event Inbox，重复到达只返回已有状态；**没有事件 ID 才用备用键，且不能只按文本哈希去重**（两条真实相同的消息会被误合并）；存原始引用+标准化结果+解析器版本+接收时间；**处理线程只做验源/去重/关联/持久化**，下载大文件、分页、模型推理交 Worker；**事件可能重复、延迟、乱序，不能假设按发生时间到达**。

## 10. Business Task 十一个状态

字段：`task_id`、`tenant_id`、`task_type`、`business_refs`、`title/description/priority`、`trigger_event_id / origin_command_id`、`created_by_actor`、`idempotency_key`、`dependency_refs`、`status/due_at/next_run_at`、`execution_mandate_id`、`current_attempt_id/attempt_count`、`result_ref/error_code/error_summary`、`schema_version/record_version/created_at/updated_at/completed_at`。

| 状态 | 含义 | 有运行中 Attempt |
|---|---|---|
| PENDING | 前置未满足 | 否 |
| READY | 可领取 | 否 |
| RUNNING | 有 Attempt 执行 | 是 |
| **WAITING_EXTERNAL** | 等外部事件/产物/回调 | 否 |
| **WAITING_HUMAN** | 等人工审批/补充/决策 | 否 |
| RETRY_WAIT | 可重试失败，等下次调度 | 否 |
| SUCCEEDED | 业务验收条件已满足 | 否 |
| FAILED | 永久失败或达重试上限 | 否 |
| CANCEL_REQUESTED | 已请求取消，确认副作用中 | 可能 |
| CANCELLED | 已安全取消 | 否 |
| SUPERSEDED | 被新版本替代，保留历史 | 否 |

> **任务状态表达业务进度，不等于 Agent 是否在线**；进入 WAITING_EXTERNAL 后 **Worker 可以退出**，事件到达再唤醒**同一个 Task**。

## 11. Task Attempt 七个状态 + 租约

`CLAIMED → RUNNING → SUCCEEDED / FAILED_RETRYABLE / FAILED_FINAL / TIMED_OUT / CANCELLED / ABANDONED`

字段：`attempt_id`、`task_id`、`attempt_no`、`worker_type`、`worker_id`、`status`、`claimed_at/started_at/heartbeat_at/lease_expires_at/ended_at`、`agent_session_ids`、`input_snapshot_ref/output_ref`、`error_class/error_code/error_detail`、`retryable/retry_after/execution_duration`、`trace_id/correlation_id`。

- **重试不能创建新 Task，也不能覆盖上次记录。**
- 领取必须**原子化**；同一 Task 同一时刻只能有一个有效租约（除非显式定义并行子任务）。
- 超 `lease_expires_at` → Watchdog 标 **ABANDONED**。
- **ABANDONED 不等于任务失败**，也不意味着可以直接重发邮件/重建会议；**必须先读 Effect/Receipt 和外部真实状态**。
- 新 Attempt 用新 `attempt_id` 与递增 `attempt_no`，**保留前序输入/输出/错误**。

## 12. Agent Session 与执行身份

Session 是模型上下文，不是任务身份：1 Attempt 可用多 Session，1 Task 可跨多次 Attempt；**Session 丢失 ≠ Task 丢失**；Session 记所属 Task/Attempt、Worker 类型、模型路由、Runtime 版本、权限配置版本；**模型的对话/工具调用/流式事件不直接成为业务事实**。

**Actor / Mandate 字段**：`actor_id / actor_type`（Human / System / Agent Worker）、`tenant_id`、`role / permission_version`、`resource_scope`、`allowed_tools`、`allowed_actions`、`approval_refs`、`expires_at / revoked_at`。
> 逐字：**"工具每次执行都应重新校验授权，不能只在 Session 创建时校验一次。"**
> **Mandate 是技术执行授权，不是 HR 业务审批。**

## 13. Durable Effect 九个状态

`PENDING → CLAIMED → SENT → CONFIRMED`；异常 `RETRY_WAIT / UNKNOWN_OUTCOME / FAILED_FINAL / CANCELLED / COMPENSATION_REQUIRED`。

- **`SENT` 不一定代表对方业务系统最终完成**；`CONFIRMED` 才算。
- `UNKNOWN_OUTCOME`：可能已成功但无可靠回执 → **先对账，不盲目重发**。
- `COMPENSATION_REQUIRED`：无法简单撤销，需取消/更新/人工补偿。

**原子性与幂等 6 条**：同一事务写业务状态 + Outbox → 提交后 Dispatcher 执行 → 稳定幂等键、重试沿用原 Effect ID → 支持回读就先回读 → **不宣称全局 Exactly-once；真实语义是可恢复的 At-least-once + 幂等 + 回读对账** → 外部成功但本地写回失败**不能新建 Effect**，先通过回执/业务对象回读完成 reconciliation。

## 14. Workflow 五种汇合条件

`ALL_SUCCESS` / `ANY_SUCCESS` / `MANUAL_GATE` / `OPTIONAL`（失败不阻塞但必须记录）/ `CANCEL_PROPAGATION`（**已发生的外部副作用进入补偿或对账，不静默删除**）。

**面试转写示例 7 步**，两条硬约束：**"Transcript 分支失败不应阻止面试官提交 Scorecard"**；**"某位面试官未提交也不能伪造评价完成"**。

## 15. 八类错误与默认处理

| 错误类型 | 例子 | 默认处理 |
|---|---|---|
| TRANSIENT | 网络超时、429、5xx | 有退避的有限重试 |
| WAIT_EXTERNAL | 转写未生成、候选人未回复 | 等待事件或到期查询，**不占 Worker** |
| AUTH_REQUIRED | Token 过期、权限撤销 | 暂停 Connector，要求重授权后恢复 |
| INVALID_INPUT | 文件损坏、必填缺失 | 人工补录/修正，不盲重试 |
| BUSINESS_CONFLICT | 申请已关闭、岗位冻结、版本冲突 | 重读业务事实 |
| PERMANENT | 不支持的接口、资源不存在 | FAILED_FINAL，保留原因 |
| UNKNOWN_OUTCOME | 副作用请求后连接断开 | **先回读对账** |
| WORKER_LOST | 进程退出、租约过期 | Attempt 标 ABANDONED，恢复前查 Effect |

> 错误必须含机器可判断的 `error_code`、可读 summary、`retryable`、`retry_after`、source/provider、对象 ID；**"不能只存模型自然语言描述"**。

## 16. 十条跨模块不变量

1. 同一来源事件重复到达，不重复创建业务对象或任务
2. 重试保持 `task_id` 不变、产生新 `attempt_id`
3. Agent Session 结束或丢失，**不删除 Business Task**
4. 任何外部副作用必须有 Effect/Receipt 和幂等键
5. 外部结果未知时先对账，不盲目重发
6. **业务状态迁移由领域服务校验，不由模型直接写任意状态**
7. 所有跨租户与资源访问由可信服务端授权，**不依赖 Prompt**
8. 原始资料、模型派生记录、人工评价分别存储并保留来源版本
9. 所有关键日志能通过 `correlation_id` / `business_refs` 追溯
10. **完成状态必须通过业务验收条件或外部读回确认，不以 Agent 自报为准**

## 17. 十条契约测试（最低集合）

① 同一 Event 连投两次 → 一条 Inbox + 一个幂等 Task ② 失败重试 → task_id 不变、attempt_id 变化、历史保留 ③ 租约后崩溃 → 过期可恢复，**不允许两个有效 Worker 同时执行同一 Task** ④ 外部动作成功但回执丢失 → **先读回不重发** ⑤ **等待外部时不占并发槽**，事件到达唤醒原 Task ⑥ **等待人工审批时 Agent 不得绕过 Gate** ⑦ **权限撤销后已排队未执行的工具必须重校验并拒绝** ⑧ 同一 Interview 的 Transcript 与 Scorecard 并行完成，一方失败另一方仍可写入 ⑨ **乱序事件不能把已关闭 Application 静默回滚** ⑩ 每个关键结论都能定位来源事件、原始资料或人工决策。

## 18. 并发与审批绑定（v0.2 增量冻结）

**乐观并发**：每个改状态的 Domain Command 带 `expected_record_version` + `command_id/idempotency_key` + Actor + 目标资源；同一 PG 事务内比较版本并迁移；不匹配返回 `VERSION_CONFLICT / BUSINESS_CONFLICT`，**不允许静默 last-write-wins**；唯一性用 DB 唯一索引/原子写入，必要时行锁，**不引入分布式锁**；**Candidate Merge、Application Stage Change、Scorecard Revision、Decision、Offer Change 全部适用**；Worker 领取用 `fencing_token`。

**Approval 绑内容**：Approval 记 `resource_type/id` + `resource_record_version` + `payload_schema_version` + `canonical_payload_hash` + 审批人/决定/原因/时间。Dispatcher 执行前**四项校验**：① 当前版本 == 批准版本 ② 当前 Payload Hash == 批准 Hash ③ Approval 未撤销/未过期/未被替代 ④ Actor/Mandate 仍有权限。
**内容实质变化 → 原 Approval 失效，必须重新预览和审批**，至少覆盖 Offer、Job Posting、对外通知。

## 19. 七种时间语义（不能互相冒充）

`occurred_at`（来源系统实际发生；**外部没给就留空**）/ `received_at`（OS 收到）/ `recorded_at`（持久化）/ `started_at`·`ended_at`（任务、Attempt、确有起止的人工活动）/ `state_changed_at` / `sent_at`·`confirmed_at`·`last_readback_at`。
> 逐字：**"时间戳应表达真实事件，不以记录创建时间冒充外部发生时间。"**

## 20. 五条"不过度建设"

指标是对已有事实的计算与投影，**不默认新增 Metric/Analytics 实体**；不为每个报表建重复事实表；不做无业务价值的全量点击埋点；只有真实问题答不了才加最小字段，**且先查与 Event/Audit/Task/Attempt/Effect 的重复**；**逻辑记录要求不授权新增表或执行迁移**。

## 21. 执行器会话与后台作业（v0.3 增量冻结）

> **本节补什么**：§8–§20 回答了"事实怎么分、状态怎么走、错误怎么分类"，但**没有一条**规定**执行器**（真正跑 Agent 的那一层）在一个工作单元里怎么活、怎么被唤醒、崩了怎么恢复。本节把 `docs/17` **D-105 第 4 条**从一句话展开为可判定条款。
> **术语边界**：本节"执行器"= 跑 Agent 的执行单元（DSH Session 的宿主），**不是** `docs/17` D-99 的"恢复计划执行器"（`src/document/recovery/execute.ts`，那是修文档的），也不是 `docs/02 §3` 的八类业务 Worker。
> **来源**：`参考 dsh-superagent docs/003-execution.md §The Executor / §Background work and worker slots / §Concurrency / §Restart / §Stored work`；`docs/006-deployment.md §Stored work / §Channel failure`；`src/app/effects.ts`、`src/app/outbox.ts`。同一研究见 `docs/17` **D-105**。
> **原型是研究代码，只借规则不借实现**：不 vendor 其代码，不采用其 `store.ts` 的单机 SQLite（与 D-5/D-109 的「PG 权威 + 无自建队列」底座冲突；v1.0 不引入 pg-boss，见 D-122）。本节只写规则；**实现状态见 §21.8，一律不得当成"已具备"**。

### 21.0 术语对照（防止与既有对象混用）

| 本节用语 | 原型中的词 | 本项目的承载对象 | 明确**不是** |
|---|---|---|---|
| **工作单元** | Ticket | **Business Task**（§10，稳定身份） | 不是 Agent Session（§12）、不是 Attention、不是一条聊天窗口 |
| **执行轮次（turn）** | turn | 无独立对象，是 Attempt（§11）内的一个执行步 | 轮次结束 **≠** Attempt 结束 |
| **执行器 Session** | Executor Session `worker-<ticket id>` | Agent Session（§12）的一种，每单元固定一个 | 不是 Task 身份；丢了不丢 Task |
| **工作单元目录** | Ticket directory | 执行根下的固定目录 | 不是身份，不能用来反查 Task |
| **并发槽位** | worker slot | 调度资源（`maxWorkers` + 1 个人工超额槽） | 不是数据库锁，不承担写冲突正确性（§18 的 `fencing_token` 才是） |
| **后台作业** | background job / subagent | 运行时跑在轮次之外、轮次结束后仍在进行的作业 | 不是 Business Task，也不是 Attempt |

### 21.1 一个工作单元 = 一个持久 Session + 一个固定目录

**规则**

1. 执行器为每个 Business Task 创建并**固定**一个执行器 Session，名称恒为 `worker-<task_id>`；名称只由 `task_id` 派生，**不含**标题、时间、attempt 序号、人名。
2. 同一 Business Task 的**所有** Attempt 复用同一个 Session、同一个目录；按 §11 换了 `attempt_id`，**不换** Session、**不换**目录。
3. 目录恒为 `<execution_root>/<task_id>/`；`execution_root` 是部署级配置（执行根），目录名只由 `task_id` 派生。
4. 恢复：Session 可 resume 时直接接管；不可 resume 时用同一 `task_id` **重建** Session 并记一条 `session_recreated` 事实（原 Session 引用 + 原因）；**不得**因此新建 Business Task，**不得**换目录。
5. 工作单元结束（`SUCCEEDED` / `FAILED` / `CANCELLED` / `SUPERSEDED`）后 Session 与目录**保留不删**（审计、复盘、再唤醒需要），只是不再被自动唤醒。

**判定条件（可机检）**

- 任一 `task_id` 下，`session.name = 'worker-' || task_id` 的**有效**记录恰好 1 条（`session_recreated` 之后只有最新一条有效，历史保留）。
- 同一 `task_id` 的两次 Attempt，`directory` 字段**逐字相等**。
- 同一 `task_id` 出现 ≥2 条"没有重建原因"的 Session → **判违反**。

**边界**

- 一个 Attempt 内**可以**有主/路由 Session 与子 Session（subagent 派生的上下文）；本节约束的是**执行器 Session 这个唯一入口**，不限制模型侧派生上下文。
- 显式定义的并行子任务（§11 括注）各用自己的子 Session，但目录仍在**同一个**工作单元目录之下（`<execution_root>/<task_id>/…`），不得各自开一个 ID 命名空间。
- 原型用 `git worktree` 给每个工单建检出目录，**本项目未采用**：v1.0 没有 per-unit 代码工作区（`docs/18 §1`"没有自研 Worker/队列"）。将来若要，属**新能力**，须另立决策，不能从本节推出来。

**失败时的行为**

- 命名冲突（`worker-<task_id>` 已被另一个 task 占用）→ **拒绝启动**该单元，报 `EXECUTOR_SESSION_CONFLICT`，**不覆盖**已有 Session。
- 目录创建失败 → Attempt 记 `FAILED_RETRYABLE`（类名沿用 §15 的 `TRANSIENT` / `INVALID_INPUT`，不新增错误类），**不得**改到临时目录里"先跑完再说"。
- 取不到 Session 或目录且无法重建 → 该单元进 `WAITING_HUMAN`，**不静默新建**一个看起来一样的单元。

> 来源：参考 dsh-superagent `docs/003-execution.md` §The Executor（"Each Ticket gets an Executor Session named `worker-<ticket id>` and a directory named after the Ticket's short name"）+ §Restart（"Sessions, directories, Subscriptions … survive a restart"）。原型是研究代码，只借规则不借实现。

### 21.2 后台作业上限：轮次结束 ≠ 等待

**规则**

1. 一个轮次结束时若仍有后台作业（shell 后台作业 / subagent）在跑，该工作单元**保持"工作中"**：`task.status` 仍为 `RUNNING`、Attempt 不结束、`heartbeat_at` 继续刷新、**继续占槽位**；**不得**报成 `WAITING_EXTERNAL` / `WAITING_HUMAN`（§10 的状态定义不变，"什么时候算等待"以本条为准）。
2. 后台作业完成 → 在**同一个槽位**唤醒该 Session，把结果作为下一轮输入；唤醒**不新建** Business Task。是否换新的 `attempt_id` **只看 §11 的租约边界**：同一 Attempt 内续跑则复用 `attempt_id` 只刷新心跳；租约过期/进程中断才换（后者见 §21.4）。
3. **上限 30 分钟**，从**轮次结束时刻**起算。到点必须做三件事：
   - kill 仍在跑的 **shell 后台作业**；
   - 工作单元转为等待（有待人工项 → `WAITING_HUMAN`，否则 → `WAITING_EXTERNAL`），并释放槽位；
   - 报告必须写明：**哪些作业被 kill**、**哪些 subagent 仍在跑**、执行器最后一段话。
4. 被 kill 作业**已产生的输出必须持久化**，并作为该 Session **下一轮的第一条输入**（"结果留给下一轮读"）；输出为空也要留一条空结果，**不许省略**。
5. **subagent 不 kill**：到 30 分钟允许其继续；它的完成**不唤醒**执行器，执行器下一轮自己读结果。
6. **人工交接立即释放**：出现 `ready` / `blocked` / `failed` 报告，或出现一条等待回答的 Attention（`docs/17` D-105 第 1 条的 Attention 对象）时，**立即**释放槽位。交接时 subagent 停止；已在跑的 shell 作业（例如留给人工 review 的本地 server）**可继续到该 Assignment 结束**，**不占槽、不受 30 分钟限制**，其完成不唤醒执行器。

**判定条件（可机检）**

- `轮次结束 ∧ 存在 running 后台作业` → 必须同时满足 `task.status = RUNNING`、`attempt.heartbeat_at` 在刷新、`slot_held = true`。写成任何 `WAITING_*` → **判违反**。
- `轮次结束时刻 + 30min` 之后仍存在 running **shell 作业** → 判违反（必须已 kill 且有记录）。
- 每条 kill 记录必须含 `job_id` + `killed_at` + `last_output_ref`（非空；空输出记 `<empty>`）；缺 `last_output_ref` → 判"结果没留给下一轮"，违反。
- 交接后：`slot_held = false`，且该 shell 作业在 30 分钟判定中被**显式排除**（需 `exempt = HANDOFF` 记录），不得靠"反正没人查"。

**边界**

- "等待外部 / 等待人工"（§17 ⑤、§10）**不占槽**，与本条不冲突：交接即释放。
- 处理暂停期间不启动新轮次，但**不打断**已在跑的后台作业；30 分钟上限照常计时（暂停是否顺延**未定**，见 §21.8 V-4；未定之前按不顺延实现）。
- 本节只设**时间**上限；同时跑几个作业属 Execution Policy（`docs/02 §4`），本节不设数量上限。

**失败时的行为**

- kill 失败（进程不可杀 / 无权限）→ 记**孤儿作业**事实（`job_id` + `pid` + 最后输出 + 失败原因）并按 §21.6 升级为系统问题，**不得**删记录当作已停。
- 到点仍有 running shell 作业且无 kill 记录 → 合同违反：该工作单元**不得**进入 `SUCCEEDED`。
- 上限能力未实现时标 `NOT_IMPLEMENTED`，**不得**在验收里写成已具备（`docs/06` E1–E4 口径）。

> 来源：参考 dsh-superagent `docs/003-execution.md` §Background work and worker slots（"keeps its worker slot and stays working … not reported as waiting"；"at most 30 minutes … shell jobs are killed … The Executor reads killed-job results on its next turn"；"A handoff to a person frees the slot immediately"；交接后 shell job "hold no slot and are exempt from the 30-minute limit"）。原型是研究代码，只借规则不借实现。

### 21.3 人工唤醒可以插队：新工作不能挡住人继续已有工作

**规则**

1. 并发槽位 = `maxWorkers`（部署配置，正整数）+ **1 个"人工超额槽"**（全局唯一，恒为 1，不随消息条数增加）。
2. 槽位占用区间：从 launch / 唤醒开始（**含**目录准备），到以下任一为止：① 人工交接（§21.2.6）；② 轮次结束且无后台作业。
3. 真人消息唤醒**已存在**的工作单元（继续、纠偏、回答、要求进度）→ 普通槽位满时**可以用**人工超额槽。
4. 人工超额槽也被占 → 该真人输入**排队**，但排在**所有非真人输入之前**，并在下一个普通槽位空出时优先取它。
5. 新建工作单元（launch 一个新 Task）**只能用普通槽位**；自动输入（事件、CI、定时回读）同样只能用普通槽位。
6. 由此得到本节的不变量：**"人继续已有工作" > "新工作"**。新工作（无论谁发起）永远不能把人挤到队列后面。

**判定条件（可机检）**

- 并发占用数 `occ` 恒满足 `occ ≤ maxWorkers + 1`；`occ = maxWorkers + 1` 时，那第 N+1 个必须是一条 `actor_type = HUMAN ∧ target_task_id 已存在` 的输入。
- `actor_type ≠ HUMAN`、或 `target_task_id` 不存在（新建）→ **一律不占**超额槽。
- 排序：同一时刻可执行的候选里，"真人-继续已有"必须先于"新 launch"。
- 出现"自动输入占了超额槽"或"真人-继续被新 launch 挤后"→ **判 FAIL**（这是"新工作挡住人"复发的唯一入口）。

**边界**

- 真人**新建**工作不用超额槽：超额槽保"继续"，不保"新开"。
- 状态查询 / 心跳类请求也算人发起，且**不产生**一轮执行（不占槽或只短暂占超额槽），二者都不挡住工作。
- 同一条真人消息唤醒同一单元只占一个槽；N 条真人消息**不会**变成 N+1 个额外槽。

**失败时的行为**

- 拿不到槽位的真人输入 → 按 §21.5 **先存后做**落库排队；**不得**丢弃，**不得**退化成"请稍后再试"。
- 排队超过阈值仍未拿到槽 → 按 §21.6 上报系统问题（阈值**未定**，见 §21.8 V-8）；此时人看到的是"系统忙"，**不是沉默**。
- 超额槽被自动输入误用 → 合同违反，验收直接 FAIL。

> 来源：参考 dsh-superagent `docs/003-execution.md` §Concurrency（"one extra slot for a person's message or a status request"；"New work therefore cannot prevent a person from continuing an existing Ticket"；其他 Input "wait for a normal slot"）。原型是研究代码，只借规则不借实现。

### 21.4 重启恢复：先核对现场，再重做任何外部动作

**规则**

1. 进程重启时，**所有运行中**的工作单元：结束当前 Attempt（§11 记 `ABANDONED`，`error_class = WORKER_LOST`，类名沿用 §15），并为它们启动**新的 Attempt**，顺序按**最早开始优先**。
2. 新 Attempt 的**第一条输入必须是 recovery note**。recovery note 至少含四项：① 工作单元目录；② `git` 现场（分支 / HEAD / 未提交改动；无 `git` 则写明"无"）；③ 已知外部副作用清单（本单元已发出的 Effect / Outbox / Receipt 及状态，`UNKNOWN_OUTCOME` 排最前）；④ 一句话硬要求：**先核对目录、`git` 历史与外部系统事实，再重做任何外部动作**。
3. **核对完成前禁止任何外部写动作**：发消息、推送分支、提交、建 / 改会议、写外部系统一律不得执行；只读核对不限。
4. 核对结论必须落成事实，三选一：
   - 确认外部动作**未发生** → 可以重做；
   - 确认外部动作**已发生** → 走 §13 `UNKNOWN_OUTCOME` 对账（**先回读，不重发**）；
   - 现场与记录**不一致** → 进 `WAITING_HUMAN`，**不自动重做**。
5. 重启前**不在运行中**的单元（`WAITING_*` / `READY` / `BLOCKED` / `FAILED`，无 running Attempt）**保持原状**，不重启；**除非**那些报告之后又到达了新的输入——此时才重启。

**判定条件（可机检）**

- 重启后，每个旧 `RUNNING` Attempt 必须变成 `ABANDONED`；仍为 `RUNNING` → 违反 §11 单租约，判违反。
- 新 Attempt 的 `input_snapshot_ref` 必须指向一条 recovery note；缺 note → 判违反。
- 在 recovery note 的"核对完成"事实缺失时，外部写动作的调用计数必须为 **0**；审计里每条外部写调用之前必须有一条 `recovery_check` 记录。

**边界**

- "重启"包括崩溃、被 kill、插件 stop / restart。**优雅关闭**同样按本条处理：先等后台作业最多 **10 秒**（原型阈值），到点仍未结束的按 §21.2 处理（kill shell 作业、留输出）；关闭后再启动时，被中断的 Attempt 一律 `ABANDONED`，**不得**当成"没跑过"直接续上。
- 目录 / `git` 核对只对**真有目录、真有 `git`** 的单元适用；没有外部写能力的单元至少核对"是否存在未完成的外部动作记录"。
- recovery note **不是重试许可**：它不授权重发任何"可能已经发生"的动作。

**失败时的行为**

- 核对缺失 / 被跳过 → 该单元**不得**继续任何外部写，进 `WAITING_HUMAN` 并报系统问题。
- 重启后 Session 不可 resume → 按 §21.1.4 重建并记 `session_recreated`，recovery note 照发。
- 同一单元连续 3 次"一重启就崩" → 停止自动重启，按 §21.6 升级，等人工。

> 来源：参考 dsh-superagent `docs/003-execution.md` §Restart（"Running Assignments end with `host restarted`… new ones start with a recovery note that tells the Executor to check its directory, git history and GitHub before repeating any outside action, oldest Ticket first"；非运行态 "stay as they are"）+ §Executor blocked or failed。原型是研究代码，只借规则不借实现。

### 21.5 先存后做：决定之后要做的事，先落库再执行

**规则**

1. 执行器"**决定之后才做**"的动作，必须先在同一事务里写一条持久 work 记录（`kind` / `key` / `payload` / `due` / `consecutive_failures` / `target` / `created_at`），**提交之后**才执行。至少覆盖四类：
   - `delivery`：把输入投递给某工作单元的 Session；
   - `launch`：启动一次执行；
   - `relay`：把报告 / 结果转发给主 Session 或人；
   - `reply`：对外部渠道发送消息（细则见 `docs/04 §23.3`）。
2. **禁止**：先执行、成功后补记录；只在内存队列里排队；失败后"下次再说"。
3. 失败重试：指数退避。**默认** `2s` 起、每次翻倍、上限 `60s`；`reply` 例外：`5s` 起、上限 `300s`（`docs/04 §23.3`，以那一处为准）。
4. **"暂不可执行"不算失败**：处理暂停、槽位满、前置未满足 → 按初值重排（`due = now + 初值`），`consecutive_failures` **不增加**。
5. 升级阈值：**连续 3 次**才上报为系统问题（定义见 §21.6）。
6. 保序：`relay` / `notice` 这类有序 kind，前一条没成功会**挡住**后面的同类（挡住 ≠ 丢单，记录仍在队列里）；`reply` 按（工作单元, 会话）保序（`docs/04 §23.3`）。
7. 重启：等待中的记录留在库里；正在跑的记录**不删除**，重启后按 §21.4 重试；已有外部回执的先回读。

**判定条件（可机检）**

- 每次投递 / launch / 转发 / 外发，审计里都能找到一条**先于它**的 work 记录（`created_at ≤ 该动作发生时间`），且重试时 `key` 不变。
- `consecutive_failures` 只在**真失败**时 +1；`Later` 类重排后**不变**。
- `consecutive_failures ≥ 3` → 系统问题条目存在；为 1–2 时**不得**出现系统问题条目。
- 重启前后同一 kind 的待办记录数**不减**（未完成记录不因重启消失）。

**边界**

- `launch` 的失败处理与 `delivery` / `relay` **不同**：通过性失败（`408 / 429 / 5xx`、连接被拒 / 重置 / 超时）重试 3 次；**非通过性失败直接判该单元失败**（不无限重试启动）。
- 一次性的真实外部写仍受 R7 约束（未经授权不做真实外部写）；本节只规定"要做就必须先存"。
- work 记录**复用** §13 的 Effect / Outbox 承载，不为 delivery / launch / relay 新造一套并行队列；现有表放不下时按 §20 先证不能复用，再加最小字段。

**失败时的行为**

- 永久不可达 → `dropped`，**必须**记原因与时间（drop 条件见 `docs/04 §23.3`），且不再重排。
- 连续 3 次失败 → 系统问题；该项**保留**在队列里等人工，**不自动丢弃**。
- 重启后记录丢失（库里本来有、重启后没有）→ 合同违反：该动作**不得**被当成"已经做过"或"不需要做"。

> 来源：参考 dsh-superagent `docs/003-execution.md` §Stored work（"What dsh-superagent does after a decision … is stored first and done afterwards"；`2` 秒起、翻倍到一分钟；"only after one item failed three times in a row"；"Relays … keep their order"）+ §Executor blocked or failed（通过性失败重试 3 次、launch 失败不自动重试）+ `src/app/effects.ts`（`FAILURES_BEFORE_ERROR = 3`；`Later` 重排不加失败数；关机时保留 running 行以便下次启动重试）。原型是研究代码，只借规则不借实现。

### 21.6 三振才报错（本节唯一定义，`docs/04 §23.4` 引用此处）

1. 计数粒度：**(kind, item)** 的**连续**失败次数；成功一次**清零**。
2. 1–2 次：只记录（`state = ready`），**不**进系统问题。
3. 3 次：该 kind 的系统问题条目变 `error`，带最后一次错误；恢复后**自动**清除。
4. **不计数的情形**（否则系统会被正常等待刷成告警）：`Later` 类"暂不可执行"（暂停、槽位满、前置未满足）；`WAIT_EXTERNAL`（§15，正常等待）；`AUTH_REQUIRED`（§15，配置 / 授权问题，走"重授权后恢复"）。
5. 可见位置例外：`delivery` 失败**显示在工作单元上**（该单元的 `error_code` / 报告），**不**进全局系统问题面板；其余 kind 进全局。
6. **不适用**：内容质量问题（Chunk 失败、Evidence 引用不存在等，见 `docs/04 §19`）按各自的行处理，不并入本节。

> 判定：`consecutive_failures` 与系统问题条目**双向一致**；`AUTH_REQUIRED` 连发 10 次也**不得**产生系统问题；两次失败后一次成功，系统问题条目必须消失。
> 来源：参考 dsh-superagent `docs/003-execution.md` §Stored work / §Source failure（"three failed polls in a row … any successful poll resets the count"）+ `src/app/effects.ts`（`FAILURES_BEFORE_ERROR = 3`；`quiet` 让 delivery 失败显示在工单上）。原型是研究代码，只借规则不借实现。

### 21.7 与现有条款的关系（逐条，判据不并存两套）

| 现有条款 | 关系 | 判据以哪处为准 | 说明 |
|---|---|---|---|
| §10 Business Task 十一状态 | **补充** | 状态**定义**以 §10 为准；"轮次结束但有后台作业**算不算**等待"**以 §21.2 为准** | §10 没有覆盖"轮次结束"这个时点，不构成矛盾 |
| §11 Task Attempt 七状态 + 租约 | **补充**（`ABANDONED` 多一条触发路径） | 状态与租约字段以 §11 为准；`ABANDONED` 的触发条件多一条：进程重启时运行中的 Attempt 一律 `ABANDONED`（§21.4.1） | §11 原写"超 `lease_expires_at` → Watchdog 标 `ABANDONED`"，重启是另一条**独立**触发路径，**不取代**它 |
| §12 Agent Session 与执行身份 | **补充 + 冲突不成立** | "Session 是不是任务身份"看 §12；"执行器该建几个 Session"看 §21.1 | §12 继续有效（Session 是模型上下文、Session 丢失 ≠ Task 丢失）；§21.1 只收紧执行器**实现**，不推翻"1 Attempt 可用多 Session"——后者是运行时的**上界许可**，不是"每次 attempt 必须换 Session"的要求 |
| §12"1 Attempt 可用多 Session" | **继续有效**（原文一字未改） | §12 原文 | §21.1 没有删改这句；两者一个说"允许多少"，一个说"实现必须固定" |
| §13 Durable Effect 九状态与原子性 6 条 | **继续有效**（本节不扩大、不削弱） | 对外部副作用**仍以 §13 为准**（`SENT ≠ CONFIRMED`、`UNKNOWN_OUTCOME` 先对账） | §21.5 覆盖的是 `delivery / launch / relay / reply` 这些 **§13 里没有对象**的执行器内部动作；`reply` 例外：状态机以 §13 为准，退避参数以 `docs/04 §23.3` 为准 |
| §15 八类错误 | **补充** | 错误分类以 §15 为准；本节只用它的类名（`WORKER_LOST` / `INVALID_INPUT` / `TRANSIENT`），**不新增错误类** | 唯一参数补充：升级为"系统问题"的阈值 = **连续 3 次**（§21.6）；§15"有退避的有限重试"继续有效，但不定义阈值 |
| §17 ⑤「等待外部时不占并发槽」 | **继续有效 + 边界明确** | ⑤ 继续有效；"有后台作业在跑 ≠ 等待外部"以 §21.2 为准 | 两个判据不重合，不会同时成立 |
| §18 并发与审批绑定（`fencing_token` / `expected_record_version`） | **继续有效** | 写冲突唯一判据仍是 §18 | 槽位是**调度**语义，不是锁；§21.3 的槽位计数**不得**被当作并发写正确性的依据 |
| §20 五条"不过度建设" | **继续有效，且本节受其约束** | §20 原文 | §21 不新增 Metric / Analytics 实体；排队复用队列已有顺序字段，work 记录复用 Effect / Outbox；放不下时先证不能复用再加最小字段 |
| `docs/06 §8` 三维诚实标签 | **继续有效**（本节不改维度、不改取值） | 标签语义仍以 `docs/06 §8` + 各 `contracts/*/tool-contracts.md §1.4` 为准 | 三维标签回答"数据真不真 / 怎么触发 / 能不能自己读"，**不回答**"执行器有没有在跑"；禁止用标签代替执行事实 |
| `docs/18 §1`「没有自研 Worker / 队列」 | **冲突不成立**（措辞近似，对象不同） | 事实陈述以 `docs/18` 为准；合同要求以本节为准 | `docs/18` 说的是**当前底座里没有**自研 worker / 队列（事实，继续有效）；本节写的是**合同要求**执行器必须满足什么（不是宣称已经有了）。二者同时成立：**规则在、实现无** |
| `docs/17` **D-105**（只复用原型形状、未采纳其代码） | **继续有效**（本节是 D-105 第 4 条的落地） | 决策以 `docs/17` 为准 | 本节只把 D-105 第 4 条从一句话展开为可判定条款，**不扩大**采纳范围 |

### 21.8 实现状态与待验证（不许把本节读成"已经具备"）

| # | 事项 | 现状 | 验证方法 |
|---|---|---|---|
| V-1 | 执行器本身 | **G1 已实现**（插件进程内 tick-loop，PG advisory lock，2026-11-15）；G2（Worker Session 真执行）进行中；仍无队列 | 按 §21 每条"判定条件"写契约测试；G2 落地前不得声称 Worker 闭环 |
| V-2 | Session 跨进程 resume | **G2 进行中**（复用 DSH session-persistence + --session-id） | 同一 Session 起一轮 → kill 进程 → 重启 → resume，检查上下文与工具集是否完整；失败则走 §21.1.4 重建路径 |
| V-3 | 30 分钟上限与 5s/60s 转后台阈值 | **待验证**（原型在 DSH 0.2.1-rc.3 上验证，我们的宿主版本不同） | 起一条 `sleep 1900` 的 shell 命令 → 观察是否转后台、轮次结束后 30 分钟是否被 kill、输出是否留到下一轮 |
| V-4 | 处理暂停是否顺延 30 分钟上限 | **未定**（原型未写，本节未规定） | 暂停 10 分钟后恢复，观察 kill 时刻是否顺延；**无论结果如何，先写进合同再实现** |
| V-5 | 并发槽位能否用现有队列表达（并发上限 + 一个超额槽 + 排序） | **待验证**（当前无队列；D-109 已定 PG 原生租约，pg-boss 不再作为 v1.0 候选，见 D-122） | 起 `maxWorkers+1` 并发，投一条高优先级任务，看它能否在满槽时立即执行、且不挤掉在跑任务；做不到则先按 R1 证候选池不足再决定 |
| V-6 | "真人-继续" vs "新 launch" 的排序键 | **待验证** | 并发跑 2 条人工输入 + 3 个自动 launch，核对执行顺序符合 §21.3 判定条件 |
| V-7 | recovery note 的"核对完成"事实怎么落 | **待验证** | 审计里加一条 `recovery_check` 事实，用契约测试断言"无该事实时外部写调用数 = 0" |
| V-8 | 排队超时阈值（§21.3 失败行为） | **未定** | 需产品负责人给一个数（建议 30 分钟，与 V-3 同量级）；**未定前不得写成已实现** |
