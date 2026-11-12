# db/SCHEMA.md · v1.0 领域库「对象 → 表 / 约束」映射

**状态**：初始版（`0001_init.sql`），待独立复核
**权威来源**：`docs/03-domain-and-runtime.md`（§1 三十四个业务对象 / §3 五组状态机 / §4 十条最小数据不变量 / §5 Intake 三层 / §6 Candidate 合并 / §9 Event Envelope / §10–§11 任务与尝试 / §13 Durable Effect / §16 十条跨模块不变量 / §18 并发与审批绑定 / §19 七种时间语义）、`docs/13-project-plan.md` §4 P1、`docs/01-business-lifecycle.md` §5/§9（v1.0 切割）、`docs/04-connectors-and-transcript.md` §11/§12/§16/§18/§20。

**一句话**：把 v1.0 需要的 36 行领域对象落成 **39 张表 / 161 个外键 / 181 条 CHECK / 55 个唯一约束（其中 10 个部分唯一索引）/ 72 个触发器**，约束写在库里，不写在文档里。

> 计数口径来自 `psql -f db/verify.sql` 第 1 节实测输出（PG 17.11）。

---

## 1. 全局约定

| 项 | 约定 | 依据 |
|---|---|---|
| schema | 全部对象在 `recruitment`，不与同库其它 schema 撞名 | 库可能被别的项目共用 |
| 主键 | 单列 `uuid`，`gen_random_uuid()`（PG13+ 内置，**不装扩展**） | 无需 pgcrypto |
| 例外 | `event_inbox` 主键叫 `event_id`（不是 `id`） | docs/03 §9 字段名逐字 |
| 多租户 | 除 `organization` 外每表 `tenant_id NOT NULL` 且有外键到 `organization`；关键关系用 **(id, tenant_id) 复合外键**，物理上禁止跨租户引用 | docs/03 §16 不变量 7 |
| 乐观并发 | 22 张可为变表带 `record_version`（所有状态表 + candidate/decision/approval/business_task/task_attempt/...），`fn_row_guard` / `fn_touch` 在每次 UPDATE 自动 +1；调用方必须 `WHERE record_version = $expected`，0 行即 `VERSION_CONFLICT`。**另 17 张不带**：要么整行不可变（新版本 = 新行，如 `rubric_version` / `job_version` / `resume_version` / `event_inbox` / `business_config` / `candidate_merge`），要么只是维度/挂接表（`organization` / `role` / `department` / `acquisition_channel` / `actor_role` / `interviewer` / `intake_asset` / `execution_mandate` / `resume`）或派生索引（`transcript_segment`） | docs/03 §18 |
| 状态审计 | 有状态的表都有 `status_changed_at / status_changed_by_actor_id / status_source_event_id`；`application` 另有一组 `stage_changed_*` | docs/03 §4 不变量 8、§19 |
| actor | 状态迁移必须能确定 actor：`SET LOCAL recruitment.actor_id = '<uuid>'`，或显式写 `status_changed_by_actor_id`；两者都没有 → `ACTOR_REQUIRED` | docs/03 §12（工具每次执行都要重新校验授权） |
| 内部事件 | 每次状态迁移由触发器自动写一条 `event_inbox`（`provider='internal'`、`trust_level='INTERNAL'`），事件 id 回填到 `status_source_event_id` | docs/03 §9 / §4 不变量 8 |
| 历史不可删 | 38 张表装了 `trg_*_no_delete`，物理 DELETE 直接报 `DELETE_FORBIDDEN`；修正只能追加新版本 / 软关闭。**唯一例外 `transcript_segment`**：它是"可重建的派生索引"（docs/04 §16），允许重建 | docs/03 §4 不变量 2、§6、§11 |
| 原文不可改 | `resume_version` / `rubric_version` / `job_version` / `business_config` / `interview_template_version` / `candidate_merge` 整行不可 UPDATE；`decision` / `ai_summary` 只允许改 `superseded_by_*` 指针（+ 状态）；`transcript_artifact` 只允许改状态与抓取元数据（白名单） | docs/03 §4 不变量 6/10、docs/04 §16 |
| 时间语义 | `occurred_at`（外部发生，没给就留空）/ `received_at` / `recorded_at` / `state_changed_at` / `sent_at` / `confirmed_at` / `last_readback_at` 分列，互不冒充 | docs/03 §19 |
| 枚举 | 一律 `text + CHECK`（不用 PG enum）：可读、可幂等重建、扩值只改 CHECK | 迁移可重复执行 |

---

## 2. 对象清单口径（先说清 34 还是 36）

`docs/03 §1` 标题写「**三十四个**业务对象」，但它的表体**实为 36 行**（逐行编号 1–36，最后一行是「Business Config / Rubric Version」）。

- 本 schema **按表体 36 行逐条映射**，不增不减；
- 报告里同时标注这个不一致：**文档数字 34 / 表行 36**，请总控裁决要不要回抄 docs/03。
- 卡片里「第 35 个领域对象」的禁令，本 schema 按「不得出现 36 行之外的**新对象**」执行；表数 ≠ 对象数（docs/03 §1 逐字：**「以上为逻辑对象清单，不等于最终数据库表数量；落库时可按成熟模块的实际数据模型映射。」**）。

---

## 3. 对象 → 表映射（36 行，逐条）

图例：`表` = 有独立表；`列映射` = 落在其它表的列上；`缓做` = 不建表（见 §5）。

| # | docs/03 §1 对象 | 落库形态 | 关键约束 / 说明 |
|---|---|---|---|
| 1 | Organization | `organization` | 租户根；本表**没有** `tenant_id`（它就是租户） |
| 2 | Department | `department` | `parent_department_id` 自引用复合外键；`hiring_manager_actor_id` 指向 `actor` |
| 3 | User / Role | `actor` + `role` + `actor_role` | `actor.kind ∈ HUMAN/SYSTEM/AGENT_WORKER`；邮箱**先小写规范化再唯一**（`uq_actor_email`） |
| 4 | Requisition | `requisition` | 7 状态 CHECK；`headcount/filled_headcount` 数量一致；`FILLED` 必须填满 |
| 5 | Job | `job` + `job_version` | 7 状态 CHECK；`job_version` 不可变，`application.job_version_id` 固定引用（新版本不静默改写已开始申请） |
| 6 | Job Posting | `job_posting` | 独立身份与状态（不变量 3）；`PUBLISHED/INTERNAL` 必须有 approval |
| 7 | Candidate | `candidate` + `candidate_merge` | 强标识（规范化邮箱/手机）在 **ACTIVE** 状态下部分唯一 → 不重复建候选人；身份状态只能由 `candidate_merge` 驱动 |
| 8 | Prospect | **缓做** | 阶段 5 Sourcing 在 v1.0 = Deferred（docs/01 §9） |
| 9 | Resume | `resume` + `resume_version` | 版本不可覆盖（整行不可 UPDATE）；保留原件哈希 `source_asset_sha256` |
| 10 | Candidate Acquisition Source / Channel | `acquisition_channel` | 只表达**业务渠道**；技术 Connector 身份在 `event_inbox.provider`，两者不混（docs/03 §1 逐字要求） |
| 11 | Application | `application` | 不变量 1 的 (candidate, job) NOT NULL 复合外键；**四轴分列**，见 §7 |
| 12 | Pipeline Template | **缓做** | 模板族 v1.0 不做，见 §5 / M-3 |
| 13 | Pipeline Instance | **列映射** | `application.current_stage_code` + `stage_changed_at/by/source_event` + 内部事件历史（1 Application : 1 Instance） |
| 14 | Stage | **缓做** | stage 取值来自 `business_config(scope='STAGE'/'ORGANIZATION', key='stage_catalog')`，见 M-3 |
| 15 | Interview Template | `interview_template_version` | 不可变；`round_no` + Focus Attributes + 问题模板 + Feedback Form |
| 16 | Stage Activity Template | **缓做** | v1.0 的阶段活动直接落 `business_task`（`task_type` + `business_refs`） |
| 17 | Interview | `interview` | 不变量 4：`application_id NOT NULL` + `round_no` + `slot_code`（同轮可多场）；8 状态 CHECK |
| 18 | Interviewer | `interviewer` | `(interview_id, actor_id)` 唯一；`required_scorecard` 决定 Evaluation Ready 条件 |
| 19 | Meeting | `meeting` + `meeting_binding` | **不存标题**（结构上禁止按标题猜绑定）；`meeting_binding` 部分唯一索引保证「一个会议同时只绑一个面试」 |
| 20 | Transcript | `transcript_artifact` + `transcript_segment` + `transcript_processing_run` | 1 Meeting : N Artifact，`(meeting, artifact_id, source_revision)` 唯一；原文列不可改；`READY` 必须 `is_complete`；`LIVE` 必须有读取回执 |
| 21 | AI Summary | `ai_summary` | 独立表；必须引用 `(artifact, revision)` + 非空 `cited_segments`；只能 SUPERSEDED，不能改原文 |
| 22 | Interview Record | `interview_record` | `(artifact_id, transcript_revision)` 复合外键 → 必须指向**真实存在**的版本；`READY` 必须 `verification_status='VERIFIED'` |
| 23 | Scorecard | `scorecard` | 不变量 7：`interviewer_id` + `rubric_version_id` 均 NOT NULL；每人每轮一份当前（部分唯一）；提交后内容冻结，修订 = 新 `revision_no` |
| 24 | Decision | `decision` | 不变量 9：责任人 / 时间 / 结果 / 理由全 NOT NULL；整行不可改，修正用 `superseded_by_decision_id` |
| 25 | Approval | `approval` | 绑内容：`resource_record_version` + `payload_schema_version` + `canonical_payload_hash`；已决不可改判；`REJECTED` 必须写理由 |
| 26 | Offer | **缓做** | 阶段 11 在 v1.0 = Deferred，且 PRD 未冻结字段/薪酬/审批链 |
| 27 | Talent Pool | **缓做** | 阶段 12 v1.0 仅指标采集 |
| 28 | Business Task | `business_task` | 11 状态 CHECK；`idempotency_key` 唯一（同一事件不重复建任务）；`RUNNING` 必须有 `current_attempt_id`；`FAILED` 必须有 `error_code` |
| 29 | Task Attempt | `task_attempt` | `(task_id, attempt_no)` 唯一；**部分唯一索引**保证同一 Task 同时只有一个有效租约；`fencing_token` 单调；可重试失败必须给 `retry_after` |
| 30 | Agent Session | `agent_session` | 只登记执行上下文；`business_task` **不引用** session → Session 丢失 ≠ Task 丢失（结构保证） |
| 31 | Chat Thread | `chat_thread` | 一个 Thread 可触发多个 Task（`business_task.chat_thread_id`） |
| 32 | Source Thread | **缓做** | 外部邮件/消息上下文，golden path 不依赖；事件原文在 `event_inbox.payload_ref` |
| 33 | Event Inbox / Event | `event_inbox` | 14 个 Envelope 字段；`(tenant, idempotency_key)` 唯一；备用键必须绑对象 ID（禁止只按文本哈希）；`trust_level` 枚举 |
| 34 | Durable Effect / Outbox | `durable_effect` | 9 状态；`idempotency_key` 唯一（重试沿用原 Effect ID）；`CONFIRMED` 必须 `sent_at + confirmed_at`；`UNKNOWN_OUTCOME` 未回读 |
| 35 | Agent Execution Policy / Mandate | `execution_mandate` | 技术授权；**CHECK 禁止** `approve/reject/decide/merge_candidate/waive_scorecard` 出现在 `allowed_actions` → 闸门不可绕过 |
| 36 | Business Config / Rubric Version | `business_config` + `rubric_version` | 都不可变（新版本 = 新行）；`(scope, scope_id, key, version_no)` 唯一；`rubric_version` 被 Scorecard 固定引用 |

**合计**：28 行有表 · 1 行列映射（#13）· 7 行缓做（#8/#12/#14/#16/#26/#27/#32）= **36**。

---

## 4. v1.0 覆盖率结论

**v1.0 判定口径**：`docs/01 §9` 的 v1.0 切割 = 阶段 **3 / 6 / 7 / 8 / 9 / 10**（阶段 1/2/4/5/11 Deferred，阶段 12 仅指标采集）。把上述阶段的对象并上「跨切面运行时」（事件 / 任务 / 尝试 / 副作用 / 授权 / 配置）+ 阶段 3 的 Job/Job Version/Rubric + 阶段 6 的 Intake 三层 + 阶段 8–10 的 Interview/Meeting/Transcript/Record/Scorecard/Decision/Approval，得到 v1.0 对象集 **29 个**：

| 阶段 | 对象 | 落点 | 有表？ |
|---|---|---|---|
| 3 Job/JD/Rubric | Job、Job Version、Rubric 版本、Hiring Team | `job`、`job_version`、`rubric_version`、`actor/actor_role` | ✅ |
| 6 Intake | Event Inbox、Intake Record、Intake Asset、Resume Version、Candidate、Application、Channel | `event_inbox`、`intake_record`、`intake_asset`、`resume_version`、`candidate`、`application`、`acquisition_channel` | ✅ |
| 7 Screening | Resume Version、Rubric Version、Human Action、Screening Result | `resume_version`、`rubric_version`、`actor`、`decision(scope='SCREENING')` | ✅（M-1） |
| 8 排期 | Interview、Interview Template、Meeting Binding、Interviewer、Calendar Event | `interview`、`interview_template_version`、`meeting`+`meeting_binding`、`interviewer`、`meeting.calendar_event_id` | ✅（M-4） |
| 9 面试与材料 | Meeting、Transcript Artifact→Segment、Chunk Manifest、Interview Record、Provider Receipt | `meeting`、`transcript_artifact`+`transcript_segment`、`transcript_processing_run.chunk_manifest`、`interview_record`、`transcript_artifact.read_receipt_ref`+`durable_effect.receipt_ref` | ✅（M-5/M-6） |
| 10 评价与决策 | Scorecard、Decision、Evaluation Summary、Next Round Brief | `scorecard`、`decision`、（派生，见 §6） | ✅（M-2） |
| 跨切面运行时 | Business Task、Task Attempt、Agent Session、Chat Thread、Durable Effect、Mandate、Business Config、Approval | 对应 8 张表 | ✅ |

**结论：v1.0 需要的对象 100% 有落点**（28 张对象表 + 1 个列映射 + 3 张 §5 的支撑表）。`db/verify.sql` 第 4 节会把 36 行逐条断言一遍（表不存在即整体失败）。

---

## 5. 缓做对象（7 个，不建表）与理由

| 对象 | 缓做理由（可追溯到哪一节） | 什么时候做 |
|---|---|---|
| Prospect | `docs/01 §9` 阶段 5 Sourcing = **Deferred**（10.0 对象）；`docs/03 §7` 也把 Sourcing Activity 列为 10.0 | 接 BOSS/公开来源时（P2 之后） |
| Pipeline Template | v1.0 Golden Path 只有一条流程；模板族一旦建表就要冻结「并行/条件跳转/版本迁移」语义，代价大于收益 | 第二家企业/第二条流程要跑时 |
| Stage | 阶段取值先落 `business_config.stage_catalog`（code + kind + 顺序），不建独立实体；`application.current_stage_code` 引用它 | 要按岗位配置不同阶段序列时 |
| Stage Activity Template | v1.0 的「进入阶段要建什么待办」直接由 `business_task(task_type, business_refs)` 表达 | 待办种类 > 5 或要按模板批量生成时 |
| Offer | `docs/01 §9` 阶段 11 = Deferred；`docs/10` 明确本 PRD 不冻结薪酬/谈判/审批链 | P3 之后单独的 Offer 设计 |
| Talent Pool | `docs/01 §9` 阶段 12 v1.0 只有指标采集，`docs/03 §7` 属 10.0 | 人才沉淀产品化时 |
| Source Thread | 外部邮件/消息上下文不进 golden path；原始证据已由 `event_inbox.payload_ref` + `intake_asset` 保留 | 要按邮件线程聚合沟通时 |

> 缓做 ≠ 删除：`docs/03 §9` 逐字「设计范围 ≠ 交付范围」。新增时只加新迁移文件（`0002_*.sql`），不改 `0001`。

---

## 6. 不在 36 行清单内、但确实落表的 3 张表

| 表 | 为什么要有 | 归属 |
|---|---|---|
| `intake_record` | docs/03 §5 Intake 三层：**一封转发邮件三份资料 → 三条 Intake Record**；没有它就无法表达「一次收到」与「文件」的层级 | 属 #9 Resume 的上游接收记录（docs/03 §5 逐字） |
| `intake_asset` | 同上：原文件、类型、大小、checksum、来源、校验结果 | 同上 |
| `candidate_merge` | docs/03 §6 第 4 条要求 **不可变 Merge Record + 别名映射 + 操作者 + 时间 + 字段处理 + 来源版本**；不变量 2（合并不删历史 Application）必须靠它留下审计 | 属 #7 Candidate 的合并记录，**不是新对象** |

> 这三张表都来自 docs/03 正文，不是自造。若总控认定它们算「额外对象」，删掉它们会直接削弱不变量 2 与 §5 的 Intake 模型 —— 这条请在复核时裁决。

**未建表、也不打算建表的阶段产物**（因为 docs/03 §1 没有把它们列为对象，建表就等于发明第 37 个对象）：

| 产物 | 表达方式 |
|---|---|
| Screening Result（阶段 7） | `decision(decision_scope='SCREENING', stage_code='SCREENING')` + `basis_refs` 指回 `resume_version` / `rubric_version` |
| Evaluation Summary（阶段 10） | `interview_record` + 多份 `scorecard` 的**派生汇总**（docs/03 §7「只做投影，不建事实库」同理） |
| Next Round Brief（阶段 10） | 同上，派生 + 版本化快照（若 P3 要求持久化，需先把它写进 docs/03，再开 `0002`） |
| Calendar Event（阶段 8） | `meeting.calendar_event_id`（外部标识，不重建日历对象） |
| Source Event（阶段 6，docs/03 §5 的中间层） | `event_inbox.normalized_event_type` + `normalizer_version` + `processed_at`（同一行表达接收与标准化） |

---

## 7. 状态机 → 约束

| 轴 | 落点 | CHECK 名 | 取值 |
|---|---|---|---|
| Requisition | `requisition.status` | `ck_requisition_status` | DRAFT · PENDING_APPROVAL · APPROVED · RECRUITING · PAUSED · FILLED · CANCELLED |
| Job | `job.status` | `ck_job_status` | DRAFT · PENDING_REVIEW · APPROVED · OPEN · PAUSED · CLOSED · ARCHIVED |
| Interview | `interview.status` | `ck_interview_status` | SCHEDULED · IN_PROGRESS · POST_INTERVIEW · EVALUATION_READY · DECIDED · RESCHEDULED · CANCELLED · NO_SHOW |
| **Application 四轴** ① | `application.lifecycle_status` | `ck_application_lifecycle_status` | ACTIVE · ON_HOLD · WITHDRAWN · CLOSED（docs/03 §3 要求 Schema 阶段冻结 → 本处冻结为这 4 个） |
| **Application 四轴** ② | `application.current_stage_code` + 内部事件 | — | 可配置的 stage code（`^[A-Z][A-Z0-9_]{1,40}$`），不是固定序列 |
| **Application 四轴** ③ | `resume_version.parse_status` / `intake_record.status` | `ck_resume_version_status` / `ck_intake_record_status` | PARSING 是**处理状态**，不允许当招聘阶段（docs/03 §3 逐字） |
| **Application 四轴** ④ | `decision.result` | `ck_decision_result` | ADVANCE · HOLD · REJECT · WITHDRAW · HIRED（结论不写回 application 历史状态） |
| Business Task | `business_task.status` | `ck_business_task_status` | PENDING · READY · RUNNING · WAITING_EXTERNAL · WAITING_HUMAN · RETRY_WAIT · SUCCEEDED · FAILED · CANCEL_REQUESTED · CANCELLED · SUPERSEDED（11 个） |
| Task Attempt | `task_attempt.status` | `ck_task_attempt_status` | CLAIMED · RUNNING · SUCCEEDED · FAILED_RETRYABLE · FAILED_FINAL · TIMED_OUT · CANCELLED · ABANDONED（7 + CLAIMED） |
| Durable Effect | `durable_effect.status` | `ck_durable_effect_status` | PENDING · CLAIMED · SENT · CONFIRMED · RETRY_WAIT · UNKNOWN_OUTCOME · FAILED_FINAL · CANCELLED · COMPENSATION_REQUIRED（9 个） |
| Transcript Artifact | `transcript_artifact.transcript_status` | `ck_transcript_artifact_status` | DISCOVERED · FETCHING · PARTIAL · READY · WAITING_EXTERNAL · RETRYABLE_FAILED · AUTH_REQUIRED · NEEDS_LINKING |
| Interview Record | `interview_record.status` | `ck_interview_record_status` | PENDING · PROCESSING · PARTIAL · READY · FAILED · NEEDS_REVIEW |
| Scorecard | `scorecard.status` | `ck_scorecard_status` | PENDING · SUBMITTED · WAIVED |
| Intake | `intake_record.status` | `ck_intake_record_status` | RECEIVED · VALIDATING · READY_FOR_PROCESSING · PROCESSING · RESOLVED · NEEDS_REVIEW · RETRY_WAIT · REJECTED · FAILED |
| Job Posting | `job_posting.status` | `ck_job_posting_status` | DRAFT · PENDING_APPROVAL · PUBLISHED · INTERNAL · CLOSED · REJECTED |

`verify.sql` 第 3 节逐条断言：CHECK 定义里必须含上面每一个取值（少一个就 FAIL）。

---

## 8. 十条最小数据不变量 → DB 约束（docs/03 §4）

| # | 不变量 | 由什么保证（DB） | 负向测试 |
|---|---|---|---|
| 1 | Application 必须关联 Candidate 和 Job | `fk_application_candidate` / `fk_application_job` + 两列 `NOT NULL` | N01 / N02 / N03 |
| 2 | Candidate 合并不删除历史 Application | `trg_application_no_delete`（物理删直接报错）+ `candidate_merge` 不改 `application` + 外键 NO ACTION + `POS-05` 断言合并后 Application 条数不变 | N20 |
| 3 | Requisition / Job / Job Posting 各自独立身份与状态 | 三张独立表 + 三套主键/状态 CHECK | N04 |
| 4 | Interview 必须关联明确的 Application 和面试轮次 | `fk_interview_application` + `round_no NOT NULL CHECK(1..20)` + `slot_code`（同轮多场） | — |
| 5 | Meeting 与 Interview 靠平台 ID 绑定，不能靠标题 | `meeting` 表**没有 title 列**；`ck_meeting_identity`（外部 meeting id 或 calendar event id 至少一个）；`uq_meeting_binding_active`（一个会议同时只绑一个面试） | N28 |
| 6 | Transcript 原文不可被 AI Summary 覆盖 | `transcript_artifact` 的原文列在不可变白名单之外；`ai_summary` 独立表、只引用 `(artifact, revision)` | N23 |
| 7 | Scorecard 必须记录评价者和评分标准版本 | `interviewer_id` + `rubric_version_id` 双 NOT NULL 复合外键 | — |
| 8 | Workflow 状态迁移必须有来源事件 / 动作、时间、结果 | `fn_row_guard`：状态变 → 必须给 actor（`ACTOR_REQUIRED`）、自动写内部事件、回填 `status_source_event_id`；状态未变 → 不许改 `*_changed_at`（`STATUS_AUDIT_TAMPER`） | N15 / N16 |
| 9 | 重要审批和决策保留责任人、时间、结果、理由 | `ck_approval_decided_fields`、`ck_decision_reason`、`decided_by_actor_id NOT NULL`、`ck_approval_reject_reason` | N12 / N13 |
| 10 | 配置变更不静默改变历史评价或已结束申请 | `rubric_version` / `business_config` / `job_version` / `interview_template_version` 整行不可 UPDATE；`scorecard.rubric_version_id`、`application.job_version_id` 固定引用 | N21 |

---

## 9. 十条跨模块不变量 → 覆盖（docs/03 §16）

| # | 不变量 | 覆盖 | 说明 |
|---|---|---|---|
| 1 | 同一来源事件重复到达不重复建对象/任务 | **DB** | `uq_event_inbox_idempotency`、`uq_business_task_idempotency`、`uq_durable_effect_idempotency` |
| 2 | 重试保持 task_id、产生新 attempt_id | **DB** | `uq_task_attempt_no (task_id, attempt_no)` + 终态/重试字段 CHECK |
| 3 | Session 结束或丢失不删除 Task | **DB（结构）** | `business_task` 不引用 `agent_session`，会话死不掉任务 |
| 4 | 外部副作用必须有 Effect/Receipt 与幂等键 | **DB** | `durable_effect.idempotency_key NOT NULL UNIQUE`；`CONFIRMED` 需 `sent_at+confirmed_at` |
| 5 | 外部结果未知先对账 | **DB + APP** | `readback_state` 枚举 + `ck_durable_effect_unknown`；对账流程在应用层 |
| 6 | 业务状态迁移由领域服务校验 | **DB + APP** | 状态枚举 CHECK + `fn_row_guard`；"哪条边允许"由领域服务（APP-06） |
| 7 | 跨租户与资源访问由可信服务端授权 | **DB + APP** | 复合外键 + `tenant_id NOT NULL` 挡住越权引用；授权判定在服务端 + `execution_mandate` |
| 8 | 原始资料 / 模型派生 / 人工评价分别存储并保留来源版本 | **DB** | `transcript_artifact` / `transcript_segment` / `ai_summary` / `interview_record` / `scorecard` 五张表分离，且都带 revision 或 rubric 版本引用 |
| 9 | 关键日志能通过 correlation_id / business_refs 追溯 | **DB** | `event_inbox.correlation_id/causation_id`、`business_task.business_refs`、`durable_effect.correlation_id` |
| 10 | 完成状态必须由业务验收或读回确认 | **DB** | `ck_transcript_artifact_ready`、`ck_interview_record_ready`、`ck_durable_effect_confirmed`、`ck_transcript_processing_run_success` |

---

## 10. 应用层保证（DB 声明不了，逐条给理由）

| ID | 规则 | 为什么只能应用层 |
|---|---|---|
| APP-01 | 「离职/调岗事件只产生需求信号，不直接把 Requisition 设为 Approved」 | 这是**语义**判定（信号 ≠ 需求）。DB 只保证 Approved 必须有 actor + 来源事件（不变量 8），无法判断"这次审批的理由是不是一条离职事件" |
| APP-02 | 同岗位重复申请：新建 / 复活 / 冷却期 | docs/03 §2 逐字「由企业规则决定」——规则是数据（`business_config`），不是约束 |
| APP-03 | 禁止"只按文本哈希去重" | 幂等键怎么来的，DB 看不见。DB 已尽力：`FALLBACK_KEY` 必须绑 `source_object_id` 且不得同时有 `provider_event_id` |
| APP-04 | 禁止模糊匹配自动写 Meeting↔Interview | 相似度是模型输出。DB 只允许 `binding_method ∈ SCHEDULED/MANUAL/EVENT_MATCH`，MANUAL 必须留人 |
| APP-05 | Evaluation Ready 三条件（必需 Scorecard 全交或 Waive + Record 完成或缺原因 + 可回溯） | 跨表聚合（interview → interviewer → scorecard → interview_record）。要写成约束只能上 CONSTRAINT TRIGGER，v1.0 先由领域服务在同一事务里校验并留证 |
| APP-06 | 「哪条状态边允许走」 | CHECK 只保证取值合法；`DRAFT→OPEN` 这类边由领域服务控制（否则把 5 组状态机的边集写进 DB 会变成第二个真相源） |
| APP-07 | Agent 不得写 Scorecard 内容、不得代替人做闸门 | 身份与调用路径在运行时。DB 已尽力：`execution_mandate` 的 CHECK 禁止 `approve/decide/merge_candidate/waive_scorecard` |
| APP-08 | 跨租户 / 资源访问授权（不变量 7） | 授权主体是请求上下文。DB 保证的是"数据层面不可能跨租户引用" |
| APP-09 | 「PARSING 不能当招聘阶段」 | 状态轴分离靠写入方不用错列；DB 保证 `resume_version.parse_status` 与 `application.lifecycle_status` 是两个字段 |

---

## 11. 映射裁决（M-1 … M-8，可被总控推翻）

| # | 裁决 | 理由 |
|---|---|---|
| M-1 | Screening Result **不建表**，用 `decision(decision_scope='SCREENING')` 表达 | 它不是 docs/03 §1 的 36 行之一；建表等于发明对象。阶段决策本来就在 `Decision`（"阶段或最终决策"）里 |
| M-2 | Evaluation Summary / Next Round Brief **不建表**（派生 + 版本化快照） | 同上；docs/03 §7「只做投影，不建事实库」。若 P3 要求 Brief 可被下轮面试官读到具体版本，需先把 Brief 写进 docs/03，再开 `0002` |
| M-3 | Pipeline Instance → `application` 的列 + 内部事件历史；Stage 的取值 → `business_config.stage_catalog` | v1.0 是 1 Application : 1 Instance，独立表纯冗余；stage 是配置不是实体。**若总控要求"阶段迁移历史表"，请明确要哪张，我加 0002** |
| M-4 | Calendar Event → `meeting.calendar_event_id`（不建日历对象） | docs/03 §1 没有 Calendar 对象；排期约束计算在 Scheduling Service（docs/04 §4），不在库里 |
| M-5 | Transcript 用三张表（artifact / segment / processing_run） | docs/04 §16 逐字给了「四张逻辑表」（含 `interview_record`）；segment 是"可重建的派生索引" |
| M-6 | canonical variant 的粒度 = **Meeting**（部分唯一索引） | docs/04 §20 B 说"本轮选一个 canonical variant"。本轮可含多个 Meeting，各自选 canonical 是更保守的落法（宁多不丢）；若要跨 Meeting 选一个，需要 `transcript_set` 实体 → 属 0002 |
| M-7 | `interview_record` / `ai_summary` 用 `(artifact_id, revision)` 复合外键 | 让"必须引用具体 Transcript 版本"（docs/04 §11）成为物理约束，而不只是口头规则 |
| M-8 | 多写一张 `candidate_merge`（§6 的 Merge Record） | 不变量 2 + docs/03 §6 的第 4/5/7 条（不可变记录、别名映射、expected_record_version）必须有落地载体 |

---

## 12. 负向测试索引（`db/verify.sql` 第 6 节，共 32 条）

| 编号 | 断言 | 期望 SQLSTATE |
|---|---|---|
| N01 | Application 关联不存在的 Candidate（不变量 1） | 23503 |
| N02 | Application 缺 Job（不变量 1） | 23502 |
| N03 | 跨租户引用 Candidate | 23503 |
| N04 | Job 状态写非法枚举 | 23514 |
| N05 | 同一事件重复建 Business Task | 23505 |
| N06 | 同一 provider 事件重复进 Event Inbox | 23505 |
| N07 | 备用幂等键同时又给 provider_event_id | 23514 |
| N08 | 转写 READY 但 `is_complete=false` | 23514 |
| N09 | `LIVE` 转写没有读取回执 | 23514 |
| N10 | Scorecard SUBMITTED 缺时间/分项 | 23514 |
| N11 | 已提交 Scorecard 被改写 | 23514 |
| N12 | Decision 理由为空 | 23514 |
| N13 | Approval 批准但无审批人/时间 | 23514 |
| N14 | 已决 Approval 被改内容 | 23514 |
| N15 | 状态迁移没有 actor | 23514 |
| N16 | 手改 `status_changed_at` | 23514 |
| N17 | 同一 Task 两个有效租约 | 23505 |
| N18 | 可重试失败缺 `retry_after` | 23514 |
| N19 | Task RUNNING 但没有 attempt | 23514 |
| N20 | 删除 Candidate | 23514 |
| N21 | 修改 Rubric 版本 | 23514 |
| N22 | 修改 Resume 版本解析结果 | 23514 |
| N23 | 改写平台原始转写原文 | 23514 |
| N24 | 直接改 Candidate 身份状态 | 23514 |
| N25 | 合并没有匹配依据 | 23514 |
| N26 | 重复创建 ACTIVE 候选人（强标识唯一） | 23505 |
| N27 | Mandate 含业务审批动作 | 23514 |
| N28 | 同一会议绑第二个面试 | 23505 |
| N29 | Record 标 READY 但证据未校验 | 23514 |
| N30 | 有失败 Chunk 却标 SUCCEEDED | 23514 |
| N31 | 同一幂等键再建 Effect | 23505 |
| N32 | Event `trust_level` 非法 | 23514 |

---

## 13. 已知风险 / 待总控裁决

1. **`docs/03 §1` 写 34、表体 36 行** —— 本 schema 按 36 行做。要不要回抄 docs/03？
2. **7 个缓做对象**里，`Stage` 与 `Pipeline Template` 是唯一可能影响 P1 联调的（阶段 7/8 的"当前阶段"目前是 `business_config.stage_catalog` 里的 code）。若 C 线的工具要按 stage 查状态，需要这份目录（本仓库未创建任何配置行）。
3. **Actor 强制**：所有状态迁移必须 `SET LOCAL recruitment.actor_id`。插件侧（C 线）必须遵守，否则状态改不动 —— 这是**故意**的（不变量 8），但会增加一层调用约定，需要在联调前对齐。
4. **`canonical` 粒度为 Meeting**（M-6）：与 docs/04 §20 B「本轮选一个」有偏差，若要严格，需要 `transcript_set`（0002）。
5. **`intake_record` / `intake_asset` / `candidate_merge` 三张"清单外表"**：来自 docs/03 §5/§6，若认定为"额外对象"，需重写 §5 的 Intake 表达（会削弱不变量 2 的审计能力）。
