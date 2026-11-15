# 04 · 连接器与会议转写

**来源**：Notion 05（逐字，含 11-12 段）、07（逐字，含三次 Review 补段）、PRD §4.16。

---

# 第一部分 · 连接器

## 1. 六层企业上下文

| 层 | 典型信息 | 获取方式 | 作用范围 |
|---|---|---|---|
| 企业 | 业务、产品、战略、组织、部门、业务模式、文化 | 企业知识系统、文档、手动配置、对话补充 | 企业级 |
| 招聘团队 | 招聘理念、历史经验、优秀 JD、筛选习惯、规范 | 预设模板、设置、历史资料、HR 调整 | 团队级 |
| 部门 | 部门业务目标、组织分工、岗位缺口、技能结构、用人负责人要求 | 业务资料、部门负责人输入、HR 配置 | 部门级 |
| 岗位 | 招聘缺口、业务目标、职责、任职要求、能力模型、薪酬、优先级 | Requisition、Job 配置、用人部门输入 | 岗位级 |
| 角色/个人 | HR 关注点、面试官偏好、个人考察重点、评价习惯 | 勾选、权重、自定义维度、对话 | 个人或轮次级 |
| **实时业务** | 候选人、Application、历史面试、日历、转写、招聘状态、待办 | 业务库、事件、Connector | 业务对象级 |

> 逐字：**"企业业务系统接入是增强能力，不是 Demo 或产品启动的硬前置。"**
> 11-09 修正：企业上下文 = **接入 → 理解 → 应用**；保留真实来源、外部对象标识、更新时间/版本和授权范围；**"不复制整套外部系统，也不把没有接入的数据假设为已存在。"**

## 2. 十四个 Connector（含当前边界）

| 外部系统 | 主要用途 | 优先接入思路 | **当前边界** |
|---|---|---|---|
| Gmail / 企业邮箱 | 收简历、候选人沟通、通知、回复 | 官方 API / MCP / 邮件协议 / 现成 Connector | 账号授权与附件访问需验证 |
| 飞书表单 | 投递与信息收集 | 飞书开放平台 / CLI / API | 按企业权限与表单配置验证 |
| **BOSS 直聘** | 投递与主动人才搜索 | **官方授权接口优先；必要时人工导入** | **适用 API 未确认，不依赖非授权抓取** |
| GitHub | 公开技术人才寻访 | 官方 API、公开搜索 | **公开资料不等于候选人已同意联系** |
| 技术社区 / 公开主页 | 主动寻访 | 官方 API、公开页面、人工确认 | 按各平台规则与可用性 |
| 内部推荐 | 员工推荐 | 企业表单、内部消息或 HRIS | 保留推荐人与来源关系 |
| 企业微信 | HR 转发简历、沟通 | 官方接口 / 企业授权能力 | **与普通微信区分** |
| **普通微信** | HR 或候选人聊天中转发资料 | **先保留人工转发/文件导入路径** | **不假设存在稳定官方 CLI/API** |
| 飞书企业套件 | 组织、日历、消息、表单、会议、文档、流程 | 官方 API / CLI / MCP | 取决于企业是否使用及授权范围 |
| 钉钉企业套件 | 组织、日历、宜搭表单、会议、消息、流程 | 官方开放平台 API / 事件 | 具体会议与转写接口权限待验证 |
| 腾讯会议 | 面试会议、云录制、转写 | 官方会议 API / 事件订阅 | 套餐、授权、转写权限待验证 |
| 日历系统 | 面试官与候选人排期 | 企业日历 API / Connector | 按企业实际平台接入 |
| **HRIS / 组织系统** | 人员、部门、任职、岗位、编制、需求信号 | 企业授权 API / 数据同步 | **提前研究并定义统一 Adapter；具体接入按目标企业确定，不建设 HRIS 本身** |
| 企业知识系统 | 公司业务、产品、组织、制度背景 | API、文档同步、检索接口 | 可选；没有时支持人工配置与对话补充 |

## 3. 四级降级

| 级别 | 适用 |
|---|---|
| **L1 官方 API / CLI / MCP** | 企业授权且能力稳定的平台 |
| **L2 邮件、表单、文件导入** | 接口不足或账号暂无法授权 |
| **L3 人工确认和补录** | BOSS、普通微信等暂未确认自动化能力 |
| **L4 模拟 Connector / Fixture** | **仅用于自动化测试或明确标识的临时兜底，不得作为 v1.0 验收证据（D-122）；必须明确标记，不能伪装成真实线上接入** |

> **"系统应保留同一业务流程，不因渠道能力不同而重写招聘核心。"**

## 4. 排期：不是"调一个 Calendar Create Event"

Scheduling Service 至少考虑 **9 类约束**：候选人可用时间 / 面试官可用时间 / 多人共同参与 / 面试时长与轮次间隔 / 时区 / 会议链接与日历事件 / 企业工作时间与休息 / 改期取消冲突重排 / 候选人与面试官通知。
> Agent 负责理解与协调，**Scheduling Service 负责时间约束计算与日历状态**。
> 逐字：**"会议室不是常规排期模型的默认约束"**（不为低频长尾增加通用复杂度）。

## 5. 主动需求发现（后置能力）

**可订阅信号**：离职或调岗 / 岗位空缺与编制变化 / 新业务或部门扩张 / 已批准招聘计划 / 预算或岗位冻结变化 / 用人部门提出的业务需求。
**链路**：企业事件 → 识别组织/岗位变化 → 读取招聘计划与编制上下文 → 判断是否存在潜在需求 → 生成 Requisition Draft → HR/负责人审批 → 正式招聘流程。
> 逐字：**"人员减少、岗位空缺或组织变化只是信号，不直接等于补招。"**

## 6. 邮箱连接器不是系统登录（逐字边界）

- 接入的是**企业邮箱账户与邮件事件**：投递接收、正文/附件读取、候选人沟通、回复处理、招聘通知。
- 授权是**对外部邮箱资源**的授权。
- **"这与 Recruitment OS 自身用户身份认证是两件事。邮箱登录不是产品核心业务功能，不能因为要接企业邮箱就建设邮箱密码登录。"**

## 7. 邮件发送（11-12 补充）

初期提供可编辑邮件模板与 Agent 生成草稿；同时把主流邮箱官方 API 的发送/草稿/回复能力列为**较早的 Connector 候选**（Gmail `messages.send`、Microsoft Graph `sendMail`）。
> 但需验证企业账号类型、OAuth Scope、管理员授权、限流、回执与实际投递状态。
> 逐字要点：**"Graph 的 202 Accepted 仅表示请求被接受处理，不等于收件人已收到邮件。"**
> 外部发送仍必须过授权/审批，并记录 Effect、Receipt 和回读。**"仅复制邮件不能算作已经发送。"**

## 8. BOSS 直聘接口需求清单（待官方核验，6 项）

职位创建/更新/发布/下架及状态回读 · 人才搜索及候选人资料/简历读取 · 投递事件/详情/附件读取 · 招聘沟通消息与候选人回复及状态回读 · 面试邀约与状态 · 事件订阅/Webhook/增量同步。
> **"在官方接口和授权路径未核实前，不将这些能力写成已开放。"**

---

# 第二部分 · 会议转写

## 9. 设计边界（六条）

1. 会议平台负责 **ASR、说话人区分、原始会议转写**；**当前不自研 ASR / Speaker Diarization**。
2. Recruitment OS 负责：会议与 Interview 的**准确关联**、**完整转写获取**、持久化、结构化记录、评价收集、跨轮次上下文。
3. 会议录制告知、平台内部权限机制**不是本轮重点**；授权失效只保留明确的重授权入口与任务恢复。
4. 不建设生产级多租户、复杂数据治理或独立媒体存储平台。
5. **不引入 JD × Resume 项目的专业评估方法**作为招聘面试模块。
6. 成熟能力优先直接复用，再通过 Connector Adapter 接入；**"不以'参考思路后全部重写'作为默认方案。"**

## 10. 先修正原始链路两点

① **Meeting 与 Interview 必须在面试排期时提前绑定**，不能等转写生成后才靠 Meeting ID 临时找；
② **转写处理与面试官评价必须并行**，面试官不必等 AI 记录生成才提交评价。

结构：`面试前绑定 → 会后事件触发 → 转写分支 + Scorecard 分支并行 → 评价与决策汇合 → 下一轮上下文`

## 11. 对象关系基线

| 关系 | 说明 |
|---|---|
| Interview → Application → Candidate / Job | Candidate 与 Application **不在 Transcript 中重复作为权威关系维护** |
| 1 Interview : N Meeting | 改期、重新发起会议、断线后重新开会 |
| 1 Meeting : N Transcript Artifact | 平台拆成多个文件，或产生不同转写产物 |
| 1 Artifact : N 导入版本 | **平台修订转写时创建新版本，不静默覆盖历史** |
| Interview Record → 具体 Transcript 版本 | 必须引用具体版本 |
| Scorecard → Interview + 每位面试官 | 每人独立一份 |
| Next Round Brief → 前序 Record / Scorecard / Decision 的具体版本 | 版本化快照 |

## 12. Meeting ID 不能作为唯一匹配依据

必须按 **6 个维度**命名：`Provider` / `Tenant·Account Scope` / `Calendar Event ID` / `External Meeting ID` / `Recording Artifact ID` / `Actual Start-End`。

> 逐字：**"一条日程不保证只对应一个 Meeting ID；一个 Meeting 也不保证只产生一个转写文件。"** 因此不能把三者混成一个字段，也不能假设一对一。

**绑定顺序（面试预约时）**：建 Interview（关联 Application/Job/Candidate/轮次/面试官）→ 创建或关联 Calendar Event → 保存 Meeting Binding（平台还没给实际 Meeting ID 时先存 Calendar Event ID 与预计时间）→ 会议开始/结束事件给出实际 Meeting ID 时**补全 Meeting 记录**。

**解析顺序（转写事件到达时）**：优先 `Provider + Tenant + External Meeting ID` 查 Meeting → 有 Calendar Event ID 则作辅助校验 → 只有 Calendar Event ID 时**读取该日程下全部实际会议实例**再定位，**不只取第一个** → 仍无法唯一 → `NEEDS_LINKING` 由 HR 人工绑定。

> 逐字：**"禁止只凭会议标题、候选人姓名或模糊时间自动绑定。模糊匹配最多提供候选项，不能直接写入业务关系。"**

## 13. 三个平台的真实字段

> 统一原则：**"事件是触发信号，完整转写 API 的回读结果才是转写数据来源。" 不把某一次 webhook 的 payload 当作完整逐字稿。**

### 飞书
- 订阅 `minutes.minute.generated_v1` → 提供 `minute_token` + 会议来源的 `minute_source.source_entity_id`（Meeting ID）+ 唯一 `event_id`。
- 取全文：`minutes +detail --transcript`（能处理生成中）。
- 有 Meeting ID 无 minute_token：`vc +recording` 查询录制取得 minute_token。
- **`2091003` = 产物仍在生成 → 等待后重试；`2091005` = 无读取权限 → 进授权/权限异常状态。**
- **该事件订阅当前标注为 user identity，不能默认 Bot 也能订阅。**
- `vc.recording.recording_transcript_generated_v1` 是**转写片段事件**，不带完整 Meeting 关联，**不作为批量归档的唯一依据**。
- Calendar Event 与实际 Meeting 可能一对多；**飞书妙记与会议 Note 是不同产物，不自动拼成一份转写**。
- **直接复用 Lark CLI（MIT）**，但**不把 CLI 的身份/会话/本地路径泄漏到 Domain Core**。

### 钉钉
- `meeting_asr_result_event` 给 ASR 片段（`conferenceId`、`scheduleConferenceId`、`recordId`、`speakerUnionId`、词级 `words` 时间）。
- `flash_minutes_open_event` 是**状态信号，不是完整逐字稿**。
- 完整文本走 `GET /v1.0/conference/videoConferences/{conferenceId}/cloudRecords/getTexts`，`hasMore` + 分页参数继续取。
- **应用类型差异**：企业内部应用、第三方企业应用支持；第三方个人应用暂不支持。
- **调用额度**：标准版累计 1 万次/月、专业版 50 万/月、专属版 500 万/月 → **事件触发后一次性完整拉取并分页，不用高频轮询**。
- ⚠️ **该 API 参考页最后修改 2024-01-16 且来自 Apifox 镜像，不作最终契约；编码前必须在官方 API Explorer 复核字段、额度、分页参数（分页参数在页内一处写 `hasMore`/分页参数，另一处写 `nextToken`，本身矛盾）。**

### 腾讯会议
- `smart.transcripts` 在会议结束且云录制转写生成后触发，含 `meeting_id`、`meeting_code`、`recording_files[]`；**一个事件可能有多个 `record_file_id`，必须全部处理**。
- 详情走 `GET /v1/records/transcripts/details`，参数 `record_file_id` + `meeting_id` + 操作者身份；返回段落/句子/词级时间戳/`speaker_info`，按 `pid`/`limit` 分页并检查 `more`。
- **只支持商业版、企业版、教育版**，需相应录制查看权限；**2026-02-10 起新创建应用需携带 STS-Token**。

## 14. 统一 Adapter 三组字段

**TranscriptReady Event**：`provider` / `tenant_ref` / `provider_event_id` / `external_meeting_id` / `calendar_event_id`（可选）/ `recording_artifact_ids[]` / `source_event_time` / `raw_event_payload`

**Transcript Fetch Result**：`artifact_id` / `source_revision`·`fetched_at` / `raw_payload` 或 `raw_text` / `segments[]` / `next_cursor` / `has_more` / `is_complete` / `source_error`·`retryable`

**Normalized Transcript Segment**：`provider_segment_id` / `sequence` / `speaker_ref`（平台 ID，无则空）/ `speaker_label`（平台显示名）/ `start_ms`·`end_ms` / `text` / `raw_source_ref`

> Adapter 负责：接收事件、解析平台标识、查询完整转写、翻页、映射说话人字段、错误分类。
> **Domain Core 不直接判断 `minute_token` / `conferenceId` / `record_file_id` 的语义。**

## 15. 内部执行链路 A–F（31 步要点）

**A 面试前绑定**：建 Interview → 绑定 Application/Candidate/Job/Stage·Round/Interviewers → 创建或关联 Calendar Event → 建 Meeting Binding（Provider/Tenant/Calendar Event ID/预计时间/参会人）→ 实际 Meeting ID 会在会后补齐。

**B 接收事件与定位**：事件进 Event Intake → 验源、标准化、用 `provider_event_id` 去重 → 用 `provider+tenant+meeting_id/recording_id` 精确查 Meeting → 找到唯一 Interview 后**创建或恢复同一条 Transcript Fetch Task** → 无法唯一匹配进 `NEEDS_LINKING`，**不调用 LLM 猜测**。

**C 完整获取与持久化**：取该 Meeting 下**全部** Artifact → 按平台分页规则**读取全部内容，不只第一页/第一段** → 原始响应完整保存 + 标准化句段另存 → 检查所有分页完成、所有文件处理完、重复片段已去重、内容非意外截断 → **只有完整性 Gate 通过才 READY**；否则 `PARTIAL / WAITING_EXTERNAL / RETRYABLE_FAILED`。

**D 生成结构化记录**：组装本轮必要上下文（岗位标准版本、轮次配置、面试计划、当前 Transcript 版本），**不加载候选人全部历史** → 按**说话轮次 + Token Budget** 切分（**不按固定字符数粗暴截断**）→ 每 Chunk 提取问题/回答/案例/个人职责/行动/结果指标/未说明内容 + 证据引用 → Consolidator 跨 Chunk 合并、按能力维度组织、**不做评分** → Validator 校验每个 Segment ID/时间戳/原文片段真实存在 + **Chunk Coverage 完整** → 全成功且证据通过才 `Interview Record Ready`；部分失败标 `PARTIAL_RECORD` 并**只重试失败 Chunk**。

**E 独立评价与汇合**：每位面试官独立 Scorecard；会后触发评价提醒；**Scorecard 可在 Record 生成前提交**；Record Ready 后可查看结构化事实与原文；每份记录评价者/标准版本/分项/文字/提交时间/修订；**必需 Scorecard 全交或授权 Waive 并记原因**才进 `EVALUATION_READY`；Agent 汇总差异、证据、待核实，**不简单平均、不代替 HR 决定**。

**F 下一轮上下文**：ADVANCE 且下一轮已创建/确认 → 生成 Next Round Brief（关联前序 Record/Scorecard/Decision **具体版本**）→ 下轮面试官在工作台看到授权范围内 Brief，**能从关键事实跳回原始转写时间点** → **Brief 是版本化快照**，前序修订时标记可刷新，**不静默改写已使用内容**。

## 16. 存储

**四张逻辑表**：
- `transcript_artifact`：provider、artifact ID、来源 Meeting、版本、状态、生成/抓取时间、内容哈希、原始响应或原始文本
- `transcript_segment`：顺序、说话人 ID/名称、起止时间、文本、`provider_segment_id`
- `transcript_processing_run`：transcript revision、chunk manifest、成功/失败 Chunk、模型与 Prompt 版本
- `interview_record`：结构化结果、版本、来源 Transcript revision、岗位/轮次配置版本、验证状态

> Postgres 已在技术栈时原始响应用 **JSONB**；不要为这条链路专门加一套数据库、Kafka 或向量库。
> **原始与派生分开**：原文不可被摘要/Record/人工修订覆盖；Segment 是可重建的派生索引并保留到原文的来源关系；AI Summary 只是快速浏览视图；音视频留在平台，只存 provider artifact ID/链接，**不下载自建媒体仓库**。

**为什么不把全文塞进模型**：一次性输入易丢局部细节、证据定位和跨段关系。做法是保留原始句段与时间戳 → 按平台句段与说话轮次组织 → 按 Token Budget 切块（**约 3k–5k tokens/Chunk**，不拆开完整说话轮次）→ Chunk 间保留 **1–2 个相邻说话轮次**作重叠、最终按 Segment ID 去重 → 生成 Chunk Manifest → **所有 Chunk 完成后再汇总，不能把部分结果标为完整记录**。

## 17. Interview Record 的八个区块 + 五条禁止

**区块**：Interview Overview / Neutral Summary（**不打分、不下录用结论**）/ Q&A（问题、回答摘要、发言人、时间戳）/ Evidence by Competency（案例、职责、行动、结果、原文证据）/ Covered Topics / Unclear-Unverified / Follow-up Suggestions / Source References（每项关键事实关联 Segment ID、时间戳、原文）。

**禁止**：① 不让模型生成面试官主观分数 ② 不把候选人自述改写成已外部验证的客观事实 ③ 不输出没有 Segment 依据的具体经历、数字或结论 ④ 不因某个 Chunk 失败而静默丢失该段 ⑤ 不覆盖原始转写或面试官原始评价。

> 每个 Record 保存 `schema_version` / `prompt_version` / `model_id` / `transcript_revision_id` / `rubric_version`。

## 18. 六条状态轴（不得压平）

| 状态轴 | 状态 |
|---|---|
| Interview | `SCHEDULED → IN_PROGRESS → POST_INTERVIEW → EVALUATION_READY → DECIDED`（+ RESCHEDULED / CANCELLED / NO_SHOW） |
| Transcript Artifact | `DISCOVERED → FETCHING → PARTIAL → READY`（异常 `WAITING_EXTERNAL / RETRYABLE_FAILED / AUTH_REQUIRED / NEEDS_LINKING`） |
| Interview Record | `PENDING → PROCESSING → PARTIAL → READY`（异常 `FAILED / NEEDS_REVIEW`） |
| **Scorecard（每位面试官）** | `PENDING → SUBMITTED`（特殊 `WAIVED`） |
| Decision | `PENDING → ADVANCE / HOLD / REJECT / WITHDRAW` |
| Next Round Brief | `NOT_CREATED → READY → SUPERSEDED` |

> **`Transcript READY` 只代表完整原文已成功获取；`Interview Record READY` 才代表结构化处理与证据校验完成。**

**Evaluation Ready 三条件**：必需 Scorecard 全交或授权 Waive；Record 完成或授权记录缺失原因；对象、配置版本、证据引用可回溯。

## 19. 异常恢复十一行

| 场景 | 处理 |
|---|---|
| 同一事件重复推送 | 按 `provider+tenant+event_id` 去重，不重复建 Task |
| 多个事件指向同一 Artifact | 按 provider artifact ID 复用同一 Transcript Task |
| Meeting 无法唯一匹配 Interview | `NEEDS_LINKING`，HR 人工绑定 |
| 转写仍在生成 | `WAITING_EXTERNAL`，保留任务，新事件或人工重试后继续 |
| API 分页中断 | **保留已完成页与 cursor，支持断点续取；不能标 READY** |
| 多个 Recording Artifact | **全部读取**并按来源/时间排序，不只取第一份 |
| Connector 授权过期 | `AUTH_REQUIRED`，重授权后恢复原 Task |
| Chunk 处理失败 | 保留成功 Chunk，**只重试失败 Chunk** |
| Evidence 引用不存在 | Validator 拒绝该项，记录失败并要求重跑/人工检查 |
| 面试官未提交评价 | 保留 PENDING，按配置提醒升级 |
| 记录已修订 | 创建新版本；旧 Brief 不静默改变，必要时提示刷新 |

## 20. 二次 Review：四条精确化（以该节为准）

**A. 多个 Meeting ≠ 转写可全部拼接**：每次会议必须明确关系——`PRIMARY`（本轮正式会议）/ `CONTINUATION`（断线续接，只有明确关联才纳入同一 Transcript Set）/ `REPLACED`·`CANCELLED`（改期或取消的旧会议，保留历史但不纳入本轮记录）。
> 逐字：**"改期后旧 Meeting 不应与新 Meeting 的转写拼接；断线续接也不能只靠时间接近自动认定。"**

**B. 多个 Artifact ≠ 多个连续片段**：可能是拆分文件、不同语言、原文与智能优化版本。每个 artifact 单独保存 ID、语言、版本/类型、生成时间、原始响应；**只有平台元数据明确表示是同一连续录制的分段且时间范围不冲突时，才合并为 Transcript Set**；翻译稿/优化稿/重复产物保留为不同 variant，本轮选一个 **canonical variant**；**不能判断时保留多个 Artifact，进人工选择或按企业配置选原文版本；不得静默拼接。**

**C. 说话人边界**：**只消费平台返回的 `speaker_ref`/`speaker_label`，不自研声音识别或说话人分离**；能精确映射到参会人时才映射到 Interviewer/Candidate；只给显示名或 Speaker A/B 就**原样保留，不能根据姓名相似、发言内容或声音自行猜测身份**。

**D. 状态轴修正**：见 §18。**"Transcript READY 只代表完整原文已成功获取；Interview Record READY 才代表 Agent 结构化处理和证据校验已经完成。"**

## 21. 2026-11-09 原样接入边界（最重要的一条）

Recruitment OS 直接处理的是**平台已经生成的正式 Transcript Artifact**，不是重建会议平台或 ASR。
- 原始响应/原文按接收结果保存，**不被 AI 摘要、标准化处理或人工修订覆盖**。
- Adapter 只做下游业务所需的最小结构映射，保留原始 Artifact ID、Provider、版本/修订信息、来源引用。
- **平台没有提供的说话人、时间戳、段落 ID 等字段保持缺失；不得自行编造或用推测值补齐。**
- **不把平台未提供的字段包装成额外的用户侧问题或复杂告警**；只有实际业务动作因此无法完成时才进相应处理路径。
- 逐字：**"完整性要求针对'平台实际返回的全部产物和分页是否取全'，不是要求平台必须提供它本身没有的数据。"**
- `fetched_at`、内部处理状态、Chunk Manifest 属**Recruitment OS 自己的处理记录**，与平台原始内容分开保存。

## 22. 一天 Demo 的实际实现顺序

**P0 必须跑通（10 步）**：建 Interview + Meeting Binding → 用**真实飞书会议转写的产品链路**产生 Transcript Ready 事件（真实会议 → Interview → 产品工具导入 → READY；**Fixture 只用于自动化测试/临时兜底，不得作为验收证据**，见 D-122）→ Event Intake 去重并准确定位 Interview → 获取完整转写（有分页必须拉完）→ 持久化原文与标准化 Segment → 生成 Chunk Manifest、分块提取、汇总、证据引用校验 → 展示 Interview Record 与原文时间戳引用 → 为两位面试官建独立 Scorecard（允许一人先交、一人待交）→ 评价齐备后展示分歧与证据，由 HR 作阶段决策 → 进下一轮时生成并展示 Next Round Brief。

**P1**：真实会议事件订阅与自动回调 / 多平台并行接入 / 失败自动重试与授权恢复 / 更细的 Brief 可见字段配置 / 音视频播放器与时间轴联动。

**当前不做**：自研 ASR / 说话人分离 / 自建音视频存储平台 / Kafka·独立向量库·复杂文档处理基础设施 / 生产级多租户 / 重新实现会议平台内部授权与合规。

## 23. 来源读取位点、处置记录与出站重试（外部事实的机检层，v0.3 增量；决策 D-106）

> **本节补什么**：§13 说"事件是触发信号，回读才是数据"，§15 说"链路怎么走"，§19 说"出错了怎么办"，§21 说"平台没有的不许补"。但**没有一条**规定：① 读过的外部事件还能不能重放；② 每条外部事件最后去了哪里；③ 发出去的消息失败了退多久、什么时候算丢。本节补这三件事——它们是"外部事实诚实"的**机检层**：不靠人标注，靠记录。
> **来源**：`参考 dsh-superagent docs/001-domain.md §Concepts / §Glossary（Source:"Holds its read position … A restart must not replay events"；Disposition:"The record of a Trigger being filtered, evaluated or fanned out"）`、`docs/003-execution.md §Source failure / §Channel failure / §Stored work`、`docs/006-deployment.md §Stored work / §Channel failure`、`src/app/outbox.ts`、`src/app/effects.ts`。
> **原型是研究代码，只借规则不借实现**：不 vendor 其代码，不采用其单机 SQLite（D-5/D-109：PG 权威 + 无自建队列；v1.0 不引入 pg-boss，见 D-122）。本节只写规则；**实现状态见 §23.6**。

### 23.0 四个术语（与既有字段不撞车）

| 本节用语 | 定义 | 明确**不是** |
|---|---|---|
| **读取位点** `read_position` | 一个来源实例（或一个订阅线程）**已经消费到哪**的持久位置 | 不是 §14 的 `next_cursor`（单次抓取的翻页游标）；不是 `fetched_at`（一次读取的时间） |
| **事件去向** `event_disposition` | 一条外部事件**最终去哪**的记录，取值 `FILTERED` / `EVALUATED` / `FANNED_OUT` | **不是** S10 评价里的 `missing_disposition`（"缺面评时允不允许推进"）；两者**禁止共用列名** |
| **出站消息** `reply` | 对外部渠道发出的消息（经 Outbox → Effect） | 不是工作单元内部的 `relay`（`docs/03 §21.5`，转发给主 Session / 人） |
| **连续失败数** `consecutive_failures` | 同一 `(kind, item)` 连续失败次数，成功一次清零 | 不是 `attempts` 总数（总数只用于审计，不用来升级） |

### 23.1 读取位点：重启不得重放已处理事件

**规则**

1. 每个来源实例**必须**持久化自己的读取位点；来源若有多个订阅线程，则**每个线程一条**，并另存"最保守的可推进位置"用于重启。
2. **推进条件**：位点之前的**每一条**事件都已有处置记录（§23.2）且处理完成（成功 / 明确过滤 / 明确评估 / 明确扇出）。**有事件没有处置记录 → 位点不得越过它。**
3. 位点必须与"处理结果 + 处置记录"**同一事务**提交；**禁止**先推进位点再补处置，或先处置再补位点（两种都会在崩溃窗口里丢事实）。
4. 重启后从位点继续，**不得**从头重读已处理区间；"位点之后未处理"的区间**允许**重读，重复投递由 §15 B 的事件去重兜第二道。
5. 位点只能由**该来源实例自己的消费者**推进；人工"重跑"必须**显式**改位点并留审计（谁、为什么、从哪改到哪）。

**判定条件（可机检）**

- 重启前后 `read_position` **单调不减**（人工重跑留痕的除外）。
- 已消费区间的 `(source, provider_event_id)` 的处置记录数**不因重启增加**。
- 存在 `read_position` 越过了"无处置记录的事件" → 合同违反。

**边界**

- 位点是**来源级**的，不是租户级 / 全局级：一个来源坏掉不影响别的来源推进（原型："The GitHub Source reads each Issue, pull request and Thread on its own"）。
- 分页拉取中途失败 → **位点不动**；§19"保留已完成页与 cursor、支持断点续取"继续有效——`cursor` 是页内游标，位点是来源位置，**两者分开存**。
- 事件表达的是"只在一段时间内成立"的条件（例：转写仍在生成）→ 位点**停在该事件**，同线程后续事件不得越过它；回读由 §15 C 的完整性 Gate 触发，**不靠位点重放**。

**失败时的行为**

- 位点写失败（库不可用）→ 不消费、不丢弃：处理结果与位点同事务，整体失败重来（幂等由 §15 B 兜）。
- 位点丢失（例如来源配置重建）→ 视为**从未读过**：从头读但**每条都记处置**，并用事件去重保证不重复建 Task；来源健康必须报 `READ_POSITION_LOST`，**不得**静默当成"没数据"。
- 位点倒退（人工重跑除外）→ 合同违反，**停机等人工**（否则会重放外部副作用）。

> 来源：参考 dsh-superagent `docs/001-domain.md` §Concepts（Source 规则："Holds its read position and its own bot identity"；"A restart must not replay events"）+ `docs/003-execution.md` §Source failure（"Its read position stays where it was, so a later notification or a poll of its Thread reads what the failed reads missed"）。原型是研究代码，只借规则不借实现。

### 23.2 事件去向：不允许静默丢弃

**规则**

1. 每条进入 Event Inbox 的外部事件，**必须**在有限时间内留下**终态处置**：`FANNED_OUT`（扇出到工作单元 / 订阅线程）/ `EVALUATED`（进准入判定，产生了接受 / 忽略 / 未完成的结论）/ `FILTERED`（进入领域**之前**被过滤）。
2. `FILTERED` **必须**带**封闭集合**里的原因码，不允许自由文本：`SELF_MESSAGE`（来源自己的 bot / 账号发的）、`OUT_OF_SCOPE`（不在该来源实例监听范围）、`DUPLICATE`（同 `(tenant, idempotency_key)` 已存在）、`UNTRUSTED_SOURCE`（验源失败）、`MALFORMED`（解析不出）、`POLICY_DENIED`（人 / 规则明确不允许）。
3. `EVALUATED` **必须**带判定引用（`accept` / `ignore` / `unavailable`，见 `docs/02 §5` 语义准入路径）；`FANNED_OUT` **必须**带目标列表（工作单元 id 或订阅 id），不得为空。
4. 一条事件**可以**同时有 `FANNED_OUT` 与 `EVALUATED`（既扇出给订阅单元、又进研判），此时是**两条记录**，不是一条记录的两个取值。
5. "已入库但无处置"= **未处理完成**：必须在来源健康里可见（计数 + 最老一条的等待时长），且**位点不得越过它**（§23.1.2）。
6. **禁止用日志代替处置记录**：日志重启就没了，不算记录。

**判定条件（可机检）**

- 稳态下 `count(event_inbox) − count(distinct 有处置的 event_id) = 0`；处理中的差额必须能在健康里看到（不是看不见）。
- 每条 `FILTERED` 的原因 ∈ 6 个封闭值；每条 `EVALUATED` 有判定引用；每条 `FANNED_OUT` 的目标非空。
- 出现"事件在 Inbox、超过阈值仍无处置"→ 来源健康报错（阈值**未定**，见 §23.6 V-15）。

**边界**

- **与 `docs/02 §5` 两条事件路径的对应**（防止出现第三套词）：确定性事件路径 → `FANNED_OUT`（按类型与状态直接路由到既有 / 新建工作单元）；语义准入路径 → `EVALUATED`（先确定性 Gate，再由 Router / Assessor 出 accept / ignore / unavailable）；进入领域前的丢弃（bot 自己的消息、不在监听范围、验源不过）→ `FILTERED`。
- 一条事件被 `FILTERED` **不是错误**：过滤是正常去向，只要留了原因码。
- 处置记录属 §21 的"我们自己的处理记录"：**不得**塞进事件的 `payload`（那会被当成平台字段），**不得**改写平台原始内容。
- 承载：优先落在既有 `recruitment.event_inbox`（`0001_init.sql` 已有 `processed_at`）；`disposition` / `disposition_reason` / `disposition_at` 是加列还是加子表**待决策**（§23.6 V-10），按 `docs/03 §20` 先证不能复用再加最小字段。

**失败时的行为**

- 消费者崩在"已入库、未处置"之间 → 重启后必须**重做**这条事件的处置（不是丢弃）；位点未推进保证它会被再看到。
- 处置记录写失败 → 与位点同事务，整体失败重来。
- 确实无法处置（平台返回残缺 / 未知类型）→ 记 `FILTERED / MALFORMED` 并把来源健康标 `error`，**不静默跳过**。

> 来源：参考 dsh-superagent `docs/001-domain.md` §Glossary（Disposition 去向："The record of a Trigger being filtered, evaluated or fanned out"）+ Source 规则（"Drops the bot's own messages and Triggers outside what it listens to before they enter the domain"）+ `docs/003-execution.md` §Source failure（"A malformed item in a GitHub list or a Feishu page is skipped, and the Source's state counts it"）。原型是研究代码，只借规则不借实现。

### 23.3 出站消息：先落库、退避重试、dropped 留痕

**规则**

1. 对外发送**必须先落库**（Outbox / Receipt）再发；同一消息的任何重试**沿用原消息 ID**，不新建记录。
2. 退避：首次失败后 **5 秒**重试，之后每次**翻倍**，上限 **300 秒**——即 `5s → 10s → 20s → 40s → 80s → 160s → 300s → 300s …`。
3. 保序：同一工作单元发给同一会话的消息按入队顺序发；前一条没发出去时后一条**等**；前一条**连续失败 3 次并升级为系统问题后**，后续消息**放行**（不再被它挡住）。
4. `dropped` 只有两种原因，且**必须**记录原因 + 时间 + 归属工作单元：
   - `CHANNEL_IGNORED`：来源答复该会话**永不接收**（例：会话被锁、对象已删除）；
   - `CHANNEL_GONE`：来源**不再监听**该会话。
   其他情况（来源关闭 / 不可达 / 限流）**不是** dropped，一律**等待**。
5. dropped 的消息**保留记录**、**永不再入队**；展示上"已发"与"已丢"必须可区分（dropped 的确认消息读作 dropped，不读作 sent）。
6. 有失败尝试但未 dropped 的消息 = **系统问题**，直到发出或被撤回。

**判定条件（可机检）**

- 同一逻辑消息的所有尝试共享一个 `message_id`，`attempt_no` 递增。
- 退避序列符合 `5s × 2^n`（上限 300s）；出现"每次固定 5s"或"退避不封顶"→ 违规。
- `status = dropped` 的行必须有 `dropped_reason ∈ {CHANNEL_IGNORED, CHANNEL_GONE}` + `dropped_at`；缺任一项 → 违规。
- 同一（工作单元, 会话）内，若消息 A 未出且未达 3 次失败，消息 B **不得**先出。

**边界**

- 本节只管**出站**；入站失败仍按 §19（`WAITING_EXTERNAL` / `AUTH_REQUIRED` / `RETRYABLE_FAILED` 继续有效）。
- 状态机以 `docs/03 §13` 为准（`PENDING → CLAIMED → SENT → CONFIRMED` + 异常态）；本节 `5s → 300s` 只是**出站 kind 的默认退避参数**，`SENT ≠ CONFIRMED` 与"先回读"继续有效。
- 当前 v1.0 的 8 步链路**没有对外发送**（`docs/18 §3`）——本节是**合同条款**，实现状态见 §23.6；在真实 provider 上跑过一次之前，**不得**声明"重试已具备"。
- 真实外部写受 R7 约束（不使用真实候选人资料、不做真实外部写）；验证只能用测试会话 / fixture 渠道。

**失败时的行为**

- 人工撤回 → 记 `withdrawn` 并取消排队，**不**记 dropped。
- 永久失败但**不满足**上述两种 drop 原因 → 保留为系统问题等人工，**不**自动标 dropped（自动标就是静默丢消息）。
- 重启：排队中与正在发的消息都必须从库恢复；"正在发"按"可能已发出"处理 → **先回读**（`docs/03 §13` `UNKNOWN_OUTCOME`），不重复发。

> 来源：参考 dsh-superagent `docs/003-execution.md` §Channel failure（"Outgoing messages are stored and sent as stored work, retried with backoff from 5 seconds, doubling up to 300"；同一工单同一会话保序，"until that one has failed three times in a row"；drop 条件与"keeps its record, with when and why it was dropped"）+ `docs/006-deployment.md` §Channel failure + `src/app/outbox.ts`（`retry: [5000, 300_000]`）。原型是研究代码，只借规则不借实现。

### 23.4 三振才报错（口径在 `docs/03 §21.6`，本节只列适用与例外）

**定义不在这里重复**：连续失败计数、1–2 次只记录、3 次才升级、成功即清零——**唯一定义在 `docs/03 §21.6`**；本节只说明它在外部事实这条链上的适用对象与例外，避免两套口径。

1. **适用**：来源读取失败（按**来源**聚合计"连续几次轮询失败"）、出站消息失败、事件处置失败。
2. **不计数**（最容易被搞成告警轰炸的四类）：
   - `AUTH_REQUIRED`（授权过期：这是配置问题，走 §19"重授权后恢复"，**不计失败次数**）；
   - `WAIT_EXTERNAL`（转写仍在生成：正常等待，§15 / §19）；
   - 处理暂停 / 槽位满 / 前置未满足（"暂不可执行"，`Later` 语义，见 `docs/03 §21.5.4`）；
   - 人工显式重试 → **重新计数**（既不清零，也不沿用旧计数）。
3. **不适用**：内容质量问题（Chunk 失败、Evidence 引用不存在等）按 §19 各自的行处理，**不并入**三振——它们是内容问题，不是连接失败。
4. 恢复后系统问题条目**自动清除**（"each part clears its own entry once it works again"）。

> 判定：`consecutive_failures` 与系统问题条目**双向一致**；`AUTH_REQUIRED` 连发 10 次也**不得**产生系统问题；单次网络抖动（1 次失败后成功）后系统问题条目必须消失。
> 来源：参考 dsh-superagent `docs/003-execution.md` §Source failure（"counts towards an error of the Source, which it reports after three failed polls in a row by default; any successful poll resets the count"）+ §Stored work + `src/app/effects.ts`（`FAILURES_BEFORE_ERROR = 3`；`Later` 不计数）。原型是研究代码，只借规则不借实现。

### 23.5 与现有条款的关系（逐条，判据不并存两套）

| 现有条款 | 关系 | 判据以哪处为准 | 说明 |
|---|---|---|---|
| §13「事件是触发信号，回读结果才是数据来源」 | **继续有效** | §13 原文 | 读位点只决定"从哪继续读"，**不改变**"以回读结果为准" |
| §14 `next_cursor` / `has_more` | **继续有效** | §14 原文 | 分页游标 ≠ 读取位点（§23.0），**两者分开存**，不得互相顶替 |
| §15 A–F 内部执行链路 | **继续有效** | §15 原文 | 本节不改链路顺序；只在 §15 B 的去重之外加"位点"这一道 |
| §15 B「用 `provider_event_id` 去重」 | **继续有效，但不再是唯一防线** | 去重判据在 §15 B；"不重放"判据在 §23.1 | 去重只能防"重复建 Task"，防不住"整段重读"。**冲突不成立**：去重处理重复投递，位点处理重放 |
| §19 十一行 | **继续有效**；其中 3 行由本节补前提 | 各行的错误处理以 §19 为准；"位点能不能推进"以 §23.1.2 为准 | ①「同一事件重复推送 → 去重」→ 补：位点保证不重放，去重兜底；②「转写仍在生成 → `WAITING_EXTERNAL`」→ 补：**`WAITING_EXTERNAL` 不是已处理，位点停在该事件不推进**（否则"人工重试后继续"会失去对象）；③「API 分页中断 → 保留 cursor」→ 补：位点不动，cursor 单独存 |
| 时间语义（`docs/03 §19` 七种时间，`occurred_at` 不得被记录时间冒充） | **继续有效** | `docs/03 §19` | `disposition_at` / `dropped_at` / `read_position_updated_at` 属**我们自己的处理时间**，**禁止**写进 `occurred_at` |
| §21 原样接入边界（最重要的一条） | **继续有效，本节受其约束** | §21 原文 | 位点 / 处置 / 出站记录全部是 §21 最后一条所指的"Recruitment OS 自己的处理记录"：**不塞进平台原始内容、不包装成"平台缺字段"的告警** |
| `docs/06 §8` 三维诚实标签 | **继续有效；本节不新增第四维、不改取值** | 标签语义仍以 `docs/06 §8` + 各 `contracts/*/tool-contracts.md §1.4` 为准 | 本节补的是**判据**不是**标签**：`connection = CONNECTED` 只答"有读的能力"，`provenance = LIVE` 只答"这批数据是真的"；**"这次真读了"只能由读取位点 + 处置记录 + `read_receipt_ref` 证明** |
| `docs/06 §8`「绝不 READY 冒充已读取」 | **继续有效 + 由本节第一次给出机检判据** | 禁令本身在 `docs/06`；判据在 §23.1 / §23.2 | 这是本次唯一"旧条款只有禁令、没有判据"的补齐，属**补充**。因为不改取值、不冲突，`docs/06` **无需回抄**（不会形成两套权威） |
| `docs/07` FR-X9 三维诚实标注（P0） | **继续有效** | `docs/07` 原文 | 本节不新增需求编号；要立新需求走 `docs/07` 流程 |
| `docs/04 §22` P1「失败自动重试与授权恢复」 | **继续有效（范围不同，冲突不成立）** | P1 范围仍以 §22 为准 | §22 的 P1 指**会议转写链路的自动恢复**；§23.3 只约束**出站消息**。两者不重合，出站重试不因这条被降级为 P1 |
| 各 `contracts/*/tool-contracts.md §1.4` | **继续有效**（本节不改任何 tool contract） | 契约文件仍是**接口形状**的唯一权威 | 本节只定判据；`contracts/**` 本次**未改动**（写范围外） |

### 23.6 实现状态与待验证（不许把本节读成"已经具备"）

| # | 事项 | 现状 | 验证方法 |
|---|---|---|---|
| V-9 | 读取位点 | **未实现**：代码里没有 `read_position` / `cursor` 字段；`src/connectors/feishu` 只有骨架，`fetchTranscript()` 恒 `BLOCKED` | 真实凭据就绪后：连续两次读同一范围，第二次必须 0 新增处置；kill 进程重启后续读，不得重放 |
| V-10 | 处置记录的承载落点 | **待决策**：`event_inbox` 加最小列，还是加子表 | 先查 `processed_at` 能否区分三种去向与 6 个原因码（不能）；按 `docs/03 §20` 证不能复用后再选；**选前不改 schema** |
| V-11 | `FILTERED` 原因码封闭集合是否够用 | **待验证** | 用 §19 十一行 + 近 30 天的夹具事件逐条归类；出现归不进去的，先立决策再扩枚举，**不许**就地加自由文本 |
| V-12 | 出站 `5s → 300s` 退避 | **未实现**：当前无 Outbox（`dsh/dsh-recruitment/src` 里无 outbox / retry） | 测试会话里让发送连续失败 8 次，核对间隔序列与上限；再核对 dropped 三字段齐全 |
| V-13 | 保序与"三振后放行" | **未实现** | 并发投 3 条同一（工作单元, 会话）消息，让第 1 条一直失败：前 2 次失败时后 2 条不得先发；第 3 次失败后必须放行 |
| V-14 | `AUTH_REQUIRED` 不计数 | **待验证** | 让 transport 连续返回 401 十次，来源健康必须停在 `AUTH_REQUIRED`，**不**产生系统问题条目 |
| V-15 | "无处置事件"的可见性阈值 | **未定** | 需产品负责人给阈值（建议 1 个轮询周期 + 5 分钟）；**未定前**健康只显示计数，不判失败 |
| V-16 | `event_disposition` 与既有 `missing_disposition` 的撞名风险 | **已核实不撞车**：全仓 grep，`missing_disposition` 只出现在评价链路（`src/tools/decision-record.ts:391/464/570` 的入参、`contracts/evaluation/*` 的条件字段），`event_disposition` **零命中**（本节是首次出现） | 后续新增字段沿用两个名字前再 grep 一次；任何工具出参若同时出现两个 `*disposition`，**必须改名**（`contracts/**` / `src/**` 属写范围外，需另派 lane） |
