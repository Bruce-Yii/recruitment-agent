# 01 · 招聘全业务链路

> **⚠️ 这是 10.0 全生命周期的业务链路图（愿景/边界参照），不是 v1.0 现状。** v1.0 只交付穿过 S6→S10 的一条纵向切片；现行产品说明看 [`26`](26-product-introduction.md)，口径看 [`24`](24-product-framework-v2.md)。本文件里的 12 阶段是**业务标签与边界**，不是模块清单，也不是进度指标。

**来源**：Notion 01（逐字）、PRD §04/§05、Notion 03/07、`docs/02`、`docs/10`。
**用途**：任何需求先定位到 12 阶段的哪一段；定位不到就是没想清楚。

---

## 0. 骨架

```
需求发现 → Requisition 审批 → Job/JD/Rubric → Posting → Sourcing
   → 简历接入(Intake) → 初筛(Screening) → 面试排期 → 面试执行与材料获取
   → 综合评价与决策 → Offer 与入职交接 → 人才沉淀与复盘
                                        ↑
                          v1.0 只切 3 → 10 这一段
```

---

## 1. 使用者边界（已定，不再讨论）

**产品使用者 = 6 类企业内部角色**：企业管理员 / 招聘负责人·HR 主管 / HR·招聘专员 / 用人部门·Hiring Manager / 面试官 / 审批人。

**候选人不是使用者**，是外部参与者 + 业务对象。
> 逐字（11 页 §3.1）：**"候选人是招聘业务中的外部参与者。系统需要支持企业流程所需的通知、资料接入和状态交互，但这不意味着本产品要建设 BOSS 直聘式的公开求职平台或独立候选人门户。"**

角色可配置的只是**职位名与职责边界**（"不能假定每家企业都有完全相同的岗位层级"），不是"候选人算一个角色"。

---

## 2. 系统做什么、不做什么（这条最容易做歪）

| 系统**做** | 系统**不做** |
|---|---|
| 提前识别、把信息备好备全 | 组织审批沟通、协商、催办 |
| 把待办放在正确的人的工作台上 | 代替人开会讨论岗位标准 |
| 记住批的是哪一版、谁批的、何时 | 把审批做成一条可协商的工作流 |
| 承载业务状态、证据、版本 | 承载聊天式协作 |

> **判据**：这件事如果"两个人当面/IM 五分钟说完"，那系统只负责**留下结果和落点**，不负责过程。

---

## 3. 四个业务入口（四种不同的"进入物理"）

| 入口 | 挂在哪阶段 | 系统做什么 | 硬边界（逐字要点） |
|---|---|---|---|
| **A 人工主动发起** | 1 → 2 | 理解不完整/非结构化表达，提取岗位、人数、部门、原因、目标、优先级、预算；缺关键条件时**追问或给结构化草案** | **"正式启动仍按企业审批规则执行"** |
| **B 系统主动发现** | 1 | 读组织/HRIS/编制/任职/离职/调岗/扩张/已批招聘计划，判断**是否可能**形成需求，形成**建议或草案** | **"离职、调岗、岗位空缺或组织变化只是信号，不等于企业一定需要补招"**；**"未经 HR / 负责人确认，不自动创建正式招聘需求，不自动启动招聘流程"** |
| **C 候选人被动进入** | 6 | 统一 Intake 流程 + 各自来源归因 | 见 §4 八类接入 |
| **D 企业主动寻访** | 5 → 6 | 在**授权公开来源**搜索线索，整理 Prospect 与证据 | **"系统不得把公开资料检索等同于候选人已同意联系；未经授权不得自动触达，也不得依赖未经确认的非官方抓取"** |

> **入口优先级（PRD §6.2）**：用户发起 = 基础能力；**已发生业务事件 = 核心优先级**；系统主动发现 = **后续优先级**，且不得挤占 v1.0 核心自动化链路。

---

## 4. 人才材料接入：八类入口，一个汇合点

| # | 入口 | 关键约束 |
|---|---|---|
| 1 | 招聘表单（内部/外部/飞书表单） | 按企业权限和表单配置验证 |
| 2 | 岗位投递链接（官网/招聘页/渠道） | **仅通过官方接口、Webhook 或明确授权方式接入** |
| 3 | 招聘平台 / ATS（BOSS 等） | **以官方接口和企业授权为准**；未确认前不自动抓取 |
| 4 | 企业数据库与 HR 系统（候选人库、人才数据库、HRIS） | **只接招聘需要的数据，不重建 HRIS** |
| 5 | 企业协作工具（飞书/钉钉/企微的表单、消息、文件、推荐材料） | 按授权范围 |
| 6 | 企业邮箱 | 候选人投递、HR 转发及附件 |
| 7 | 内部推荐 / 猎头 / 合作伙伴 | 保留推荐人与来源关系 |
| 8 | 人工导入（拖拽单份或批量、上传文件夹） | 兜底路径，永远可用 |

**原则**：入口可以多，**汇合点必须唯一**。不管从哪进来，都汇成：
`一次"收到"（Intake Record）→ 下挂若干原始文件（Intake Asset）→ 每个文件解析出版本（Resume Version）→ 识别这是谁（Candidate）→ 决定建哪条应聘（Application）`

> 为什么必须分：不同入口的**信任度、重复判定方式、失败方式**完全不同（表单可能被刷、邮箱会重发、拖文件可能拖重、外部接口可能重复推）。**把差异关在入口层，后面只有一套逻辑**；否则每接一个渠道就复制一遍业务。
> 逐字（03 页）：**"渠道 Adapter 不得直接写 Candidate，也不得把 Event Inbox 当作候选人业务档案。"**

---

## 5. 十二阶段逐阶段

> 每阶段九栏：触发/输入 → 涉及对象 → Agent·系统动作 → 人工决策 → 产出/状态 → 关键事件 → 异常与恢复 → 归属 → v1.0。
> "归属"是【推断】，依据 `docs/11` 窗口所有权与 `origin/main` 实际包结构。

### 阶段 1 · 招聘需求发现

- **触发/输入**：新业务、人员缺口、编制变化、离职、岗位空缺、招聘计划、HR 主动指令
- **涉及对象**：Organization / Department / Requisition（草稿）、Source Event
- **Agent·系统动作**：汇总企业上下文与业务信号，识别可能的招聘需求，**生成草案**
- **人工决策**：HR / 负责人确认是否需要招聘
- **产出/状态**：Requisition Draft（非 Approved）
- **关键事件**：`requisition_signal_detected`
- **异常**：离职/冻结编制**不自动补招**；信号噪音要能人工驳回
- **归属**：W2 domain + W3 event；企业上下文来自 W6
- **v1.0**：❌ **Deferred**（PRD 明确主动发现后置）

### 阶段 2 · Requisition 创建与审批

- **触发**：需求草案或人工发起
- **对象**：Requisition、Approval、Department、User/Role
- **Agent 动作**：补齐部门、岗位、人数、预算、地点、原因、优先级、替补/新增；检查必要字段
- **人工**：按企业审批链批准/退回/暂缓；批准后形成正式 Requisition
- **状态**：`Draft → Pending Approval → Approved → Recruiting → Paused/Filled/Cancelled`
- **事件**：`requisition_submitted`、`requisition_approved`
- **异常**：退回要留理由；**不可被 Agent Mandate 替代**
- **归属**：W2 + W1 api + W4 web
- **v1.0**：❌ **Deferred**（种子预置文档/`docs/10` §4）

### 阶段 3 · Job / JD / Rubric 设计　★v1.0 起点

- **触发**：已批准需求或预置种子
- **对象**：Job、Job Version、**Rubric（版本化）**、Calibration Record（10.0）、Hiring Team
- **Agent 动作**：结合企业业务、部门目标、岗位缺口、HR 标准、面试官关注点、行业信息与**产品侧模板库**，**推荐**能力维度/权重/必需项/加分项/面试重点，**并给简明理由**；可联网检索公开优质 JD，但**必须保留来源/链接/时间/适用性，不得未经判断变成企业标准**
- **人工**：线下对齐后，在系统里**确认/调整/定版**
- **状态**：Job `Draft → Pending Review → Approved → Open → Paused → Closed/Archived`；Rubric 产生不可变版本
- **事件**：`job_kickoff_completed`、`job_description_drafted`
- **异常**：活跃 Application 不被新版本静默改写
- **归属**：**W2 domain** + **W1 api** + **W4 web**
- **v1.0**：✅ **P0-01/02**

### 阶段 4 · Job Posting 发布

- **对象**：Job Posting（渠道实例）、Approval、Effect/Receipt
- **Agent 动作**：生成渠道文案、检查渠道要求与政策、记录发布任务与状态
- **人工**：有发布权限者确认后发布
- **状态**：published / internal / closed / draft（启用审批另有 pending / rejected）
- **事件**：`job_approved_for_posting`
- **异常**：外部发布不可撤销 → 审批绑 payload hash + 幂等 + 回执 + 回读；**渠道无官方接口时给明确人工发布交接，不得标为自动发布**
- **v1.0**：❌ **Deferred**

### 阶段 5 · 人才获取 / Sourcing

- **对象**：**Prospect**、Sourcing Activity（10.0）、Communication Record（10.0）、Candidate Acquisition Source
- **Agent 动作**：按岗位与人才画像在**授权公开来源**搜索，整理 Prospect 与证据（目标/查询条件/来源、公开资料引用、发现时间、负责人、与已有 Candidate 关联、是否人工审核）
- **人工**：确认线索、联系或转正式申请
- **事件**：`candidate_prospect_found`
- **异常**：公开资料 ≠ 同意联系；不假设未确认 API 可用
- **v1.0**：❌ **Deferred**

### 阶段 6 · 简历接入与处理（Intake）　★v1.0 核心

- **触发**：八类入口任一
- **对象**：Event Inbox → **Source Event → Intake Record → Intake Asset → Resume Version** → Candidate / Prospect / Application
- **Agent 动作**：取附件、解析、字段提取、**版本化**、身份识别、去重、关联；解析采用**可扩展结构化输出 + 原文证据引用，不只依赖正则，保留未映射信息**
- **人工**：解析失败、身份冲突、重复歧义交 HR
- **状态**：`RECEIVED → VALIDATING → READY_FOR_PROCESSING → PROCESSING → RESOLVED`；异常 `NEEDS_REVIEW / RETRY_WAIT / REJECTED / FAILED`
- **事件**：`resume_received`、`application_created`
- **异常**：解析失败保留原件与原因、可重试或手动补录、**不重复创建候选人**；重复投递用事件 ID/附件哈希/业务幂等键；**不静默覆盖历史**；**一份失败不阻塞整批**
- **归属**：**W2 domain** + **W1 api** + **W3 worker（`INTAKE_MATERIALIZE` 已实接）** + **W6** + **W4**
- **v1.0**：✅ **P0-03/04/05**

> **候选人与合并（2026-11-12 新方向）**：**高置信度多维匹配且无冲突时可自动归并**；只有真实歧义/冲突才人工复核。自动归并也必须保留来源、字段来源、历史档案映射与合并记录；**不合并/覆盖 Application**；错误归并支持可追溯纠正/拆分。Git `docs/03`/`docs/10` 仍写旧的人工确认流程，属**待同步实现口径**。

### 阶段 7 · 初筛 / Screening

- **触发**：Application 建立 + 前置满足 → **自动启动**（不需 HR 说"开始筛选"）
- **对象**：Screening Result、Resume Version、Rubric Version、Human Action
- **Agent 动作**：按维度权重提取**能力证据、匹配理由、缺失项、风险、待核实问题**；关键结论可回到简历版本与原文；可推荐是否进入下一步**并解释理由**
- **人工**：HR 决定 通过/淘汰/暂缓/补材料
- **事件**：`screening_completed` → 创建 HR 待审核 Task
- **异常**：**模型不能仅凭自身评分自动淘汰**；无效证据拒绝并修复
- **表达口径（逐字）**：简历未呈现的考察项**统一标「缺」**，不并列"未知/无"，不推测原因
- **归属**：W2 + W1 api + W4
- **v1.0**：✅ **P0-06**

### 阶段 8 · 面试规划与排期

- **对象**：Interview、Interview Template/Slot、**Meeting Binding**、Interviewer、Calendar Event
- **Agent 动作**：读**真实约束**（候选人可用、面试官日历、时区、时长、轮次间隔、企业工时），提可行时间，准备邀约与材料
- **人工**：HR/候选人确认；改期取消冲突可恢复
- **状态**：`Scheduled → In Progress → Post Interview → Evaluation Ready → Decided`（+ Rescheduled/Cancelled/No Show）
- **事件**：`interview_requested`、`interview_scheduled`、`interview_rescheduled/cancelled`
- **异常**：**会议室不是常规排期默认约束**；改期后旧 Meeting 转写不与新 Meeting 拼接
- **归属**：**W5** + W1 api + W6（日历）+ W4
- **v1.0**：✅ **P0-07**（真实排期能力受限）

### 阶段 9 · 面试执行与材料获取　★最容易翻车

- **对象**：Meeting、**Transcript Artifact → Segment**、Chunk Manifest、**Interview Record**、Provider Receipt
- **Agent 动作**：① 会前自动备料（JD/Rubric、简历要点、前序客观摘要、本轮 Focus Attributes、问题建议）② 会后取**全部 Artifact 与全部分页** ③ 存原文 + 标准化 Segment ④ 分块提事实并校验证据 ⑤ 生成 Interview Record
- **人工**：面试官独立评价；**不要求重复上传系统已能取得的材料**
- **状态**：Artifact `DISCOVERED → FETCHING → PARTIAL → READY`（异常 `WAITING_EXTERNAL/RETRYABLE_FAILED/AUTH_REQUIRED/NEEDS_LINKING`）；Record `PENDING → PROCESSING → PARTIAL → READY`（异常 `FAILED/NEEDS_REVIEW`）
- **事件**：`meeting_ended`、`transcript_ready`
- **异常**：见 `04-connectors-and-transcript.md` 的七条保真规则 + 11 行恢复表
- **归属**：**W6** + **W5** + **W3（`TRANSCRIPT_FETCH` 是当前唯一 fail-closed 断点）** + W4
- **v1.0**：✅ **P0-08（强制真实飞书）/ P0-09**

### 阶段 10 · 综合评价与招聘决策

- **对象**：**Scorecard（每人一份）**、Evaluation Summary、**Decision**、Next Round Brief
- **Agent 动作**：汇总多轮、提取证据、**展示维度差异与分歧**、列未验证问题；仅 ADVANCE 且下一轮已创建后才生成版本化 Brief
- **人工**：HR/HM 作 通过/下一轮/暂缓/淘汰
- **状态**：Scorecard `PENDING → SUBMITTED/WAIVED`；Decision `PENDING → ADVANCE/HOLD/REJECT/WITHDRAW`；Brief `NOT_CREATED → READY → SUPERSEDED`
- **异常**：**不简单平均掩盖分歧**；**未提交不能被 Agent 伪造或补齐**；源记录变化时 Brief 标 SUPERSEDED，**不静默改写已给下轮面试官看过的版本**
- **归属**：**W5** + W1 api + W4
- **v1.0**：✅ **P0-10/11/12**

> **两张默认行为**（PRD §4.19）：单个候选人**默认按轮次顺序推进**；**横向比较发生在多个候选人共同到达同一决策节点时**（例如都完成终面）。不把不同阶段的评价混在一起比。

### 阶段 11 · Offer 与入职交接

- **对象**：Offer（版本化）、Approval、Effect/Receipt、Onboarding Handoff
- **状态**：`Draft → Pending Approval → Approved → Sent → Accepted/Declined/Expired/Withdrawn`
- **异常**：条件变更 → 新版本 + 原审批失效；**绝不按旧版本审批发送已改动的 Offer**
- **v1.0**：❌ **Deferred**（PRD 明确不在本 PRD 冻结字段/薪酬/谈判/审批链）

### 阶段 12 · 人才沉淀与复盘

- **对象**：Talent Pool、Application 历史、**指标（从底层记录推导）**
- **人工**：HR 决定人才库分类、后续联系、策略调整
- **异常**：只推演真实存在的事实；缺失字段不伪造；不拿页面停留冒充人工处理时间
- **v1.0**：⚠️ **仅指标事件采集**

---

## 6. 两条并行支线（v1.0 的核心结构）

```
Transcript Ready ──► 取转写 → Interview Record
Scorecard Submitted / Waived ──► 各面试官评价状态
                        ↓
              两者满足完成条件 → Evaluation Ready → 决策
```
**Meeting / Transcript / Interview Record / Scorecard / Decision 各自独立状态。转写不阻塞面评。**

---

## 7. 异常与恢复总表（10 条）

| # | 场景 | 系统行为 |
|---|---|---|
| 1 | 简历解析失败 | 保留原件与原因，允许重试或人工补录，**不重复创建候选人** |
| 2 | 重复简历/重复申请 | 先匹配 Candidate 再按岗位时间规则处理 Application，**不静默覆盖历史** |
| 3 | 渠道重复推送 | 来源事件 ID / 附件哈希 / 业务幂等键防重 |
| 4 | 候选人改期/取消/缺席 | 更新 Interview 状态、释放或重排、通知相关角色 |
| 5 | 转写尚未生成 | 任务等待，按平台事件或定时查询恢复，**不要求面试官上传** |
| 6 | 面试官未提交评价 | 按岗位配置提醒升级；授权 Waive 需理由 |
| 7 | 面试官意见冲突 | 保留各自 Scorecard，生成分歧摘要交负责人 |
| 8 | 退出/暂停/冻结 | 关闭或暂停对应对象，**不删除历史** |
| 9 | Offer 拒绝/过期/变更 | 保留历史版本与决策记录，按规则重启 |
| 10 | 外部授权失效 | 标记 Connector 异常，**保留待执行任务**，修复后继续 |

---

## 8. 关键事件目录（25+，逐字）

`requisition_signal_detected`、`requisition_submitted`、`requisition_approved`、`job_kickoff_completed`、`job_description_drafted`、`job_approved_for_posting`、`resume_received`、`candidate_prospect_found`、`application_created`、`screening_completed`、`application_stage_changed`、`stage_activity_completed`、`scorecard_due`、`scorecard_overdue`、`interview_requested`、`interview_scheduled`、`interview_rescheduled`、`interview_cancelled`、`meeting_ended`、`transcript_ready`、`scorecard_submitted`、`evaluation_conflict_detected`、`hiring_decision_recorded`、`offer_approved`、`offer_sent`、`offer_accepted`、`offer_declined`、`candidate_withdrew`、`application_stalled`

> 逐字边界：**"事件名是内部逻辑示例，不代表已冻结的 API 契约。"**

---

## 9. v1.0 切割

| 阶段 | v1.0 | 依据 |
|---|---|---|
| 1 需求发现 | ❌ Deferred | PRD §4.1 / `docs/10` §4 |
| 2 Requisition 审批 | ❌ Deferred（种子预置） | PRD §13.2 / `docs/10` §4 |
| **3 Job/JD/Rubric** | ✅ P0-01/02 | 起点 |
| 4 Posting | ❌ Deferred | `docs/10` §4 |
| 5 Sourcing | ❌ Deferred | 10.0 对象 |
| **6 Intake** | ✅ P0-03/04/05 | 核心 |
| **7 Screening** | ✅ P0-06 | 核心 |
| **8 排期** | ✅ P0-07 | 核心（真实排期受限） |
| **9 面试与材料** | ✅ P0-08/09 | **强制真实飞书** |
| **10 评价与决策** | ✅ P0-10/11/12 | 核心 |
| 11 Offer/入职 | ❌ Deferred | `docs/10` §4 |
| 12 沉淀与复盘 | ⚠️ 仅指标采集 | `docs/10` §5 |

> **设计范围 ≠ 交付范围**（逐字）："这些能力仍属于 10.0 产品目标，不因 v1.0 暂缓而删除。"

---

## 10. 九个人类闸门（不可绕过）

1. 确认"确实要招"
2. 批 Requisition
3. 确认岗位校准
4. 确认并定版 JD/Rubric
5. 确认候选人合并（真歧义时）
6. 决定初筛下一步
7. 确认排期
8. 面试官独立提交 Scorecard（或授权 Waive）
9. 终局 ADVANCE / HOLD / REJECT

> 逐字：**"Agent 提供分析、建议、资料准备和授权范围内的动作；正式招聘业务决策由相应权限的人作出。"**
> 逐字：**"不得将本项目描述为自动淘汰、自动录用或由模型替代招聘负责人决策的系统。"**
