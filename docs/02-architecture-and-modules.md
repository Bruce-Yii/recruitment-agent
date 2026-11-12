# 02 · 架构与模块

**来源**：Notion 04（逐字，含 11-11 段）、09、10、03、02；`docs/05`、`docs/11`；`ADR-0005`、`ADR-0006`；`origin/main` 实际包结构。

---

## 1. 十层架构（每层职责 + 关键组件）

| 层 | 职责 | 关键组件 |
|---|---|---|
| User Experience | 用户交互与业务管理 | Web Workspace、Agent Chat、角色入口 |
| Agent Orchestration | 理解任务、规划、分配、汇总 | **Recruitment Router / Main Agent** |
| Context Assembly | 为任务准备必要上下文 | Thread Context、Enterprise Context、Candidate/Job Retrieval |
| Worker Execution | 按需完成专业任务 | Worker Session、Skills、Tools、受控 Sub-agent |
| Recruitment Domain Core | 业务对象、权限、状态 | Candidate、Application、Job、Interview、Offer |
| Workflow Engine | 确定性流程与状态迁移 | Pipeline、Approval、State Machine、Timers |
| Event Runtime | 后台主动触发与任务生命周期 | Event Intake、Queue、Scheduler、Retry、Watchdog |
| Connector Layer | 连接外部系统 | Email、Feishu、DingTalk、Meeting、Calendar、HRIS |
| Persistence | 持久化业务事实与执行状态 | DB、Object Storage、Event Log、Config Version |
| Observability / Evaluation | 运行质量与产品效果 | Trace、Audit、Metrics、Evaluation Dataset |

**分层是静态结构，序号不是排期。** 11-11 的三阶段优先级（Agent Execution → Durable Orchestration → Recruitment Domain）**只调整顺序，不改层数**。

---

## 2. Router 的九项职责 + 一条边界

识别用户/角色/组织/权限 → 理解意图并定位 Requisition/Job/Candidate/Application/Interview → 读业务事实与必要上下文（**不把全部历史塞进模型**）→ 拆成确定性 Workflow + 必要 Worker → 检查前置条件/权限/审批 → 跟踪状态、处理结果与异常 → 汇总回窗口或工作台 → 对需人决策的节点发起审批或确认。

> **边界**：Router **不亲自处理所有耗时任务**，也**不是所有业务数据的唯一存储位置**。

---

## 3. 八类 Worker（含"适合的执行方式"）

| Worker | 任务示例 | 适合的执行方式 |
|---|---|---|
| JD | 岗位研究、JD 生成与版本比较 | Workflow + LLM + 搜索工具 |
| Sourcing | 公开人才检索、线索整理 | 搜索工具 + 结构化抽取 |
| Resume | 文件解析、字段抽取、去重 | 解析工具 + LLM / 规则 |
| Screening | 岗位匹配、证据提取 | **固定评分流程 + LLM** |
| Scheduling | 约束收集、日历匹配、排期 | Scheduling Service + API |
| Interview | 转写获取、摘要、结构化记录 | Event Trigger + API + LLM |
| Evaluation | 多轮结果汇总、分歧分析 | **标准化 Scorecard + LLM** |
| Follow-up | 通知、邮件草稿、提醒、人才激活 | Workflow + Connector |

**Worker 可以是四种东西**：普通确定性代码/服务、Skill/Tool 调用、有独立上下文的 Agent Session、**必要时才运行的受控子 Agent**。

> 逐字：**"不要为了'多 Agent'而把所有功能都做成模型 Agent。确定性工作交给代码和工作流。"**

**Worker 协作边界**（逐字要点）：Router 分配并管理依赖；Worker 有独立上下文与明确输入输出；**Worker 不直接改写别人的运行上下文**；通过业务库/事件/Task Result/Router 汇总共享；共享数据必须有来源、状态、版本、业务归属；**只在任务确实需要时允许受控委派，不默认开自由对话式群聊**。
> 目的：减少上下文污染、责任不清、重复执行、结果冲突。

---

## 4. Harness 需要提供的九项能力

Context Assembly · Tool Registry · Execution Policy（权限/审批/超时/重试/并发/资源限制）· Task Lifecycle · Session Management · Memory & Retrieval（**不以模型对话记忆充当事实库**）· Result Validation · Trace & Audit · Error Handling。

---

## 5. 事件运行时 11 步

1 验源 → 2 标准化并定位业务对象 → 3 用来源事件 ID/幂等键去重、存 Event Inbox → 4 按事件类型与业务状态选 Workflow → 5 创建或**唤醒稳定身份的 Business Task**，需执行才建 Attempt → 6 派发给确定性 Worker 或受控 Session → 7 业务服务校验写入，**同一 PG 事务登记 Durable Effect** → 8 提交后由 Effect Dispatcher 执行外部动作，Outbox 存回执/重试/失败 → 9 记录 Event/Task/Attempt/Session/Effect/Trace → 10 失败按错误类型处理，**恢复前回读外部事实，不假设 Exactly-once** → 11 Watchdog 查超时卡死，**语义级自动纠偏必须有验收标准和人工 Gate**。

### 两条事件路径不能混（关键）

| 路径 | 走什么 |
|---|---|
| **确定性事件路径** | 已知业务事件（`resume_received`、`transcript_ready`、`scorecard_submitted`、`application_stage_entered`…）**直接按类型与状态执行确定性 Workflow**；**不需要每个事件都先让模型判断"要不要接单"** |
| **语义准入路径** | 自然语言消息、未明确指向具体动作的主动发现信号、组织变化 → 先过**确定性 Gate**，再由 Router/Assessor 判断意图、目标、重复性、是否需要人确认；**只有获得明确授权或满足已启用的自动规则**才创建带 Mandate 的 Business Task |

> 同一 Event 可更新既有 Task 也可触发新 Task，但**必须先做幂等与业务对象关联**。
> **候选人 Screening / 面试评价不是原型的 Eval / Task Admission**，用不同 Schema、Prompt 和决策记录。

---

## 6. Workflow 与 Agent 的职责切分

| 归属 | 负责 |
|---|---|
| **Workflow** | 前置条件、状态迁移、任务依赖、审批门槛、超时与异常分支、数据写入与状态一致性 |
| **Agent** | 自然语言理解、复杂信息提取与分析、非结构化资料处理、匹配建议、任务规划与工具选择、结果解释与人机协作 |

> 逐字：**"模型可以提出状态迁移建议，但真正的业务状态变化由领域服务 / Workflow 执行和校验。"**

---

## 7. 九类长期状态对象（不可混用）

| 对象 | 语义 |
|---|---|
| Chat Thread | 用户交互窗口与聊天历史 |
| **Business Task** | 长期业务工作事项及**稳定身份**（批量简历分析、面试材料生成、转写获取、候选人通知） |
| **Task Attempt** | 一次具体执行尝试；**同一 Task 可多次 Attempt，重试不重建任务身份** |
| **Agent Session** | 一次或多次模型运行上下文；可恢复或替换，**不承担业务任务身份** |
| Source Thread | 外部邮件/消息/会议讨论上下文，**与 Chat Thread 分离** |
| Business Record | 招聘业务事实 |
| Event Inbox / Event Log | 外部事件去重入口与业务事件历史 |
| Durable Effect / Outbox | 需要跨进程恢复的外部副作用与发送回执 |
| Context Index | 可检索的企业知识与历史材料 |

> 跨会话继续时，从**持久化 Task、Event 和业务对象**恢复上下文，**不依赖原聊天窗口一直存在**。长上下文压缩/摘要/召回必须保留业务对象 ID、来源和版本。

---

## 8. 组件边界（谁拥有什么 / 绝不能拥有什么）

| 组件 | 拥有 | 绝不能拥有 |
|---|---|---|
| Web Workspace | UI 状态、交互、角色视图 | 业务真相、授权执行 |
| Recruitment Router | 意图、规划、路由、结果综合 | 任意直接写库 |
| Context Assembly | 有范围的检索 | 无限制访问全租户 |
| **Agent Runtime Adapter** | 执行会话生命周期、工具调用、受控 Subagent | **产品 Chat 历史、任务身份、业务真相** |
| Domain Services | 业务命令、事务、授权、状态不变量 | 模型推理、provider 字段 |
| Workflow Coordinator | 阶段、DAG、定时器、人工闸门 | 重复队列、重复领域记录 |
| pg-boss Workers | 持久执行、重试、并发 | 业务状态归属 |
| Connector Adapters | provider 认证、事件映射、API、回读 | 招聘领域语义 |
| Effect Dispatcher / Reconciliation | 外部副作用、回执、幂等、未知结果恢复 | 未批准的业务决策 |
| PostgreSQL | 权威持久化与事务一致性 | 把模型会话上下文当唯一记录 |
| File/Artifact Storage | 原始简历与转写产物 | 替代关系型业务模型 |

---

## 9. 代码结构与窗口归属

```
apps/
  api/        Fastify API（路由装配、认证、授权上下文）
  web/        React/Vite 工作台
  worker/     pg-boss Worker 与任务执行器
packages/
  contracts/  共享 ID / 枚举 / 错误码 / Event Envelope / DTO / Authorization Context
  domain/     W2：Candidate / Resume / Intake / Asset / Application / Screening / Merge
  domain-w5/  W5：Interview / Meeting Binding / Transcript / Chunk / Record / Scorecard / Decision / Brief
  db/         连接、迁移 runner、ledger、baseline
  platform/   配置、日志、认证、授权上下文装配
  runtime/    Event / Task / Attempt / Mandate / Effect / Outbox / 恢复 / Chat 持久化
  connectors/ W6：provider 适配、分页、回执、Fixture
  testing/    W7：跨模块验收、Fixture、E2E、恢复、证据
scripts/db/   迁移与种子脚本
fixtures/     W7 跨模块夹具
```

**迁移并行安全**：唯一根 `packages/db/migrations/` + 唯一 runner；W1 拥有 `0001_w1_baseline.sql` 与 runner/ledger；W2/W3/W5 各自在 `w2/**`、`w3/**`、`w5/**` **追加**，互不编辑，**不允许第二个迁移目录**；每条迁移记 applied ID / owner / checksum。

| 窗口 | 拥有路径 | 不得修改 |
|---|---|---|
| **W1** | `packages/contracts/**`、`packages/platform/**`、`packages/db/src/**`、根配置/锁文件/CI、`apps/api` 装配骨架、`apps/worker` 引导 | 各域模块内部 |
| **W2** | `packages/domain/**`、`apps/api/src/domain/w2-*`、`packages/db/migrations/w2/**` | 共享契约、队列内部、UI 外壳 |
| **W3** | `packages/runtime/**`、worker 执行器、Chat 持久化、`migrations/w3/**` | 招聘域表、UI 路由 |
| **W4** | `apps/web/**` | 域持久化、队列内部、provider 适配 |
| **W5** | `packages/domain-w5/**`、`apps/api/src/domain/w5-*`、`migrations/w5/**` | 通用队列、ASR、共享契约 |
| **W6** | `packages/connectors/**` | 共享契约、域 schema、其他模块内部 |
| **W7** | `packages/testing/**`、`docs/qa/**`、`fixtures/**` | 生产功能实现；**不得为了让测试通过而改模块** |

---

## 10. 模块 ↔ 功能 ↔ 阶段 三维映射

| 业务域 | 主要对象 | 阶段 | 归属 | 主要代码位置 |
|---|---|---|---|---|
| 招聘需求与审批 | Requisition、Approval | 1–2 | W2 | `packages/domain` |
| **岗位与标准** | Job、Job Version、Rubric Version | **3** | W2 + W4 | `packages/domain`、`apps/web` |
| 渠道发布 | Job Posting | 4 | W6 + W2 | `packages/connectors` |
| 人才寻访 | Prospect、Sourcing Activity、Communication Record | 5 | W2 + W6 | `packages/domain`、`packages/connectors` |
| **接入与身份** | Source Event、Intake Record/Asset、Resume Version、Candidate、Application、Merge Record | **6** | **W2 + W3 + W6** | `packages/domain`、`runtime`（`INTAKE_MATERIALIZE`）、`connectors` |
| **初筛** | Screening Result、Human Action | **7** | W2 + W4 | `packages/domain`、`apps/web` |
| **面试与绑定** | Interview、Interviewer、Meeting Binding | **8** | W5 | `packages/domain-w5` |
| **转写与记录** | Transcript Artifact、Segment、Chunk Manifest、Interview Record | **9** | **W6 + W5 + W3** | `connectors`、`domain-w5`、`runtime`（`TRANSCRIPT_FETCH`） |
| **评价与决策** | Scorecard、Evaluation、Decision、Next Round Brief | **10** | W5 + W4 | `domain-w5`、`apps/web` |
| Offer 与交接 | Offer、Onboarding Handoff | 11 | W2/W5 + W6 | 未实现（Deferred） |
| 人才与复盘 | Talent Pool、派生指标 | 12 | 复用事实 owner | 不新增模块 |
| 横切：事件与任务 | Event Inbox、Business Task、Attempt、Mandate、Effect、Receipt | 全链 | **W3** | `packages/runtime` |
| 横切：授权与契约 | Authorization Context、permission_version、resource scope | 全链 | **W1** | `contracts`、`platform` |
| 横切：Agent 执行 | Agent Session、Tool Call、Chat Thread | 全链 | W3（Phase 1 另立 `packages/agent-execution`） | `runtime`、`agent-execution` |
| 横切：验收 | 验收矩阵、Fixture、E2E、证据 | 全链 | **W7** | `packages/testing`、`docs/qa` |

---

## 11. 十一个工作台区域 + 六个角色首页

**11 个区域**：招聘总览 / **Agent 工作区** / 招聘需求 / 岗位管理 / 人才中心 / 招聘流程 / 面试中心 / 评价与决策 / Offer·入职 / 人才库 / 配置中心。

**招聘总览的注意力顺序（逐字）**："优先展示需要当前角色处理的审批/待办/逾期评价/异常任务，其次展示招聘流程与连接器健康，最后提供历史追溯。"

**6 个角色默认首页**：管理员（企业配置与连接状态）· 招聘负责人（全局总览）· HR（我的岗位与候选人待办）· 用人部门（部门招聘与岗位）· 面试官（我的面试与待评价）· 审批人（待审批事项）。

**多窗口 Chat 的四对象分离**：Chat Thread / Business Task / Task Attempt / Agent Session。

**Human Attention Inbox 是视图不是事实表（逐字）**："只聚合已有 Approval、Business Task、Scorecard、Incident 和 Review 记录，不重复保存一份任务事实。"

**配置 6 级作用域**：企业 → 招聘团队 → 部门 → 岗位 → 面试轮次 → 面试官个人。**企业 Hard Policy 不可被低层级覆盖**；**面试官个人偏好默认不改变岗位正式 Rubric**。
> 但 **默认 UI 不把六层全部展开**（PRD §8.2）；复杂配置属于按需定制。

---

## 12. 依赖方向与扩展点

**允许**：
```
apps/web ──► API DTO（contracts）           （不直连 DB）
apps/api ──► domain | domain-w5 | runtime ──► db
apps/worker ──► runtime ──► connectors（通过 port 抽象）
所有包 ──► contracts
```
**禁止**：`contracts` 反向依赖任何包；`connectors` 引入 `@recruitment/domain-w5`（W6 用结构镜像保持零依赖）；Web 直连数据库。

**扩展点**：
- 新外部系统 → Connector 适配器（能力声明 / 授权状态 / 归一化事件 / 归一化读结果 / 分页游标 / 幂等与限流 / 错误分类 / 回执与回读）
- 新业务规则 → 领域命令（带 `expected_record_version` + `command_id` + actor/mandate）
- 新模型能力 → Agent Tool（白名单 + 服务端授权 + 严格 schema），**不是新 Agent Runtime**
- 新指标 → 从既有业务/运行事实**推导**，不建独立事实表

---

## 13. 当前架构权威与未决事项

| 项 | 内容 |
|---|---|
| **活动章程** | `docs/17` + `ADR-0006`，在 PR #109（**Draft，不得合并**）的 `review/reuse-first-architecture-reset-2026-11-10-v3` |
| **已废弃** | `docs/16` = historical；`docs/05` 的 "Scheme B confirmed" 已被 ADR-0006 标为历史 |
| **ADR-0006 核心** | 成熟模块是默认；**无自动 KEEP**；禁止 regex/规则式 NL 解释器；禁止无 LLM 的确定性**兜底**（但**保留**确定性事件路由与准入 Gate） |
| **产品纠正 2026-11-11（binding）** | ① Agent Execution System 先行 ② Durable Orchestration 次之 ③ 招聘域切片第三；Recruitment OS 拥有 Chat Thread；**Odoo 只是组件来源候选、非宿主**；**Strands / DSH / Pi 均未采纳** |
| **基础执行底座** | PostgreSQL + pg-boss + 多实例 Worker + provider-neutral Runtime Adapter。**已由 D-5 批准继续沿用**。Notion 里叫「基础执行底座」，**没有「方案 B」这个词** |
| ⚠️ **D-6 新方向** | **2026-11-12 产品负责人决定：短期直接基于 DSH Web 版开发**（界面好改、扩展能力完整）。**与 ADR-0005「DSH Desktop/GUI 不是产品运行时依赖」、ADR-0006「DSH 未采纳」直接冲突**，必须在文档里显式标注取代关系，否则又是两套权威并存 |
| ⚠️ **章程不在 main** | `main` 仍写 "Scheme B confirmed"；ADR-0006/docs/17 只在 PR #109。**基于 main 开发会南辕北辙。** |
