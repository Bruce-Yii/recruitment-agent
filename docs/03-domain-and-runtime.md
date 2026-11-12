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
