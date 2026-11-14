# Golden Path S6 → S10 端到端尝试（2026-11-14）

> **身份**：lane `golden-path`（子代理）。任务：让**一条真实申请**从 S6 走到 S10 走通一次，用
> **真实工具对象 + 真实 PostgreSQL**，不许绕过工具直接写库。
>
> **纪律**：不接受自述；结论只来自本次现场执行的命令 + 真实输出 + DB 读回。
> **PII**：本目录只出现 id / 哈希 / 计数 / 打码值；简历与转写都是**合成**内容（R7）。
> **源码改动**：**零**。只新增 `manual/golden-path/**` 与 `evidence/experiments/2026-11-14-golden-path-e2e/**`；
> 未 commit / 未 push / 未切分支。完整 git 状态见 `git-state.txt`。

---

## 0. 一句话结论

**没有走通。整条链路断在 S7 决策，根因是一个没人负责的结构性缺口：没有任何产品工具会写
`application.rubric_version_id`（“申请钉住哪一版评分标准”）。**

- 12 跳里 **9 跳符合预期**（7 个真实成功 + 2 个闸门负例）：S6 接入（真建 candidate/application/resume_version/intake_asset）、
  S7 `screening_evaluate`（只读、出 PASS 建议 + `evaluation_digest`）、S8 排期（过 allow-once 人机闸门、真写
  interview/interviewer/meeting/meeting_binding/business_task）、S9 转写导入（真写 transcript_artifact +
  11 条 segment）、S10 面评（过 allow-once 人机闸门、真写 scorecard）；另有 2 个 deny 负例证明闸门 fail closed。
- **3 跳被同一缺陷硬挡住，错误码完全一致**：
  - S7 `decision_record(decision_scope='SCREENING')` → `NOT_FOUND / RUBRIC_VERSION_NOT_FOUND`
  - S10 `evaluation_summarize` → `NOT_FOUND / RUBRIC_VERSION_NOT_FOUND`
  - S10 `decision_record(decision_scope='STAGE')` → `NOT_FOUND / RUBRIC_VERSION_NOT_FOUND`
- 根因：**S6 的 `application_intake` 建申请时 INSERT 列里根本没有 `rubric_version_id`**
  （`src/tools/application-intake.ts:1565-1568`），其余工具（grep 全 `src/**`）也没有任何一处写它或写
  `job.current_rubric_version_id`。而上面三个工具都硬依赖“申请已钉住 rubric”
  （`decision-record.ts:2856`、`evaluation-summarize.ts:1190`）。
  所以 `both_bound=0`（有材料且有 rubric 的申请数）不是巧合，是**结构性的**：
  **凡是由 intake 工具创建的申请，永远拿不到 rubric pin，S7/S10 的决策就永远落不了库。**
- 附带事实：申请阶段码也没有推进者——`application.current_stage_code` 全程停在 `S6`（N8 复现）；
  转写工具因此不建 `interview_record`（警告 `RECORD_NOT_CREATED_NO_RUBRIC`），面评只能按显式
  `rubric_version_id` 提交（警告 `RUBRIC_EXPLICIT_NOT_PINNED`）。

> **为什么不是“harness 写错了”**：上面三条错误都是工具**自己**返回的契约错误（fail closed），
> 不是 harness 拼参失败；harness 的 `basis_refs` / D-95 v2 hash / as_of 都按契约构造，并且
> 我们**没有**为了继续而放宽任何闸门或直接 UPDATE 申请。见 §4 的判定。

---

## 1. 这次“真跑”的口径（哪些是真的，哪些是替身）

| 项 | 口径 |
|---|---|
| 工具调用 | 真实工具对象：`create*Tool(...)` 后 `tool.execute(args, exec)`；不经过自研 API / 不经过模型 |
| 数据库 | 真实 PostgreSQL 17 / `ra_s6s7`；写只经过 `tool.execute()`；harness 的 `pg` 只做 **SELECT 读回**与行数统计 |
| 简历 → 文本 | 真实 converter（`converter/src/cli.py`，PyMuPDF）；合成 PDF 有原生文字层，`completeness=complete`、`issue_codes=[]`、`order_verified=true` |
| 人机闸门（S8/S10） | 真实闸门代码 + **allow-once / deny 替身**（任务书允许）。替身只替代“人”，不替代闸门：deny 负例实测 `FORBIDDEN/APPROVAL_NOT_GRANTED` 且**一行不写** |
| decision 的 D-95 | `IN_CHAT` + **逐字** `confirmation_text`（合成人话）+ 服务端同一份 `confirmationTextSha256` 实现算 v2 hash；`ctx.approval` 按 D-95 不再二次弹窗（实测 0 次调用） |
| 简历/转写内容 | 全部合成：候选人“林承宇”，电话/邮箱为示例值（`example.test`），转写是合成对话。**没有任何真实候选人资料** |
| 结论标签 | 不伪造 LIVE：intake/transcript/scorecard 都自报 `FIXTURE`；S8/S9 读工具与 S8 排期返回 `LIVE` 是**工具标签缺陷/口径歧义**（见 §6），本报告不据此宣称 LIVE |

复跑方式（`manual/golden-path/run-golden-path.mjs`，见 §10）。

---

## 2. 每跳结果表（官方 run A：`run-2026-11-14T08-42-17-972Z/`）

| # | 跳 | 工具 | 结果 | DB 读回（申请 `9d408044-e30c-42be-9c7a-bd6dda78456c`） |
|---|---|---|---|---|
| 0 | 预检 | psql / SQL | PASS | 岗位 `DEMO-BE-001` OPEN，rubric v2 `…404` 已批准且 hash 对齐；`both_bound=0`；`decision(SCREENING)=0` |
| 1 | **S6 接入** | `recruitment_application_intake` | **PASS** | +1 candidate / +1 application / +1 resume / +1 resume_version / +1 intake_asset / +1 intake_record / +1 event；`application.resume_version_id=…915`、**`rubric_version_id=null`**、`current_stage_code=S6`；`parse_status=PARSED` |
| 2 | **S7 建议（只读）** | `recruitment_screening_evaluate` | **PASS** | `verdict=PASS`、`criteria_evaluated=true`、`evaluation_digest=55d89fbb…`（全文见 hop-02 JSON）；`rubric.resolution=JOB_CURRENT`、`rubric_pin_required=true`、warning `RUBRIC_PIN_REQUIRED`；`decision` 行仍 0 |
| 3 | **S7 决策（写）** | `recruitment_decision_record(SCREENING)` | **BLOCKED（产品缺陷）** | `NOT_FOUND / RUBRIC_VERSION_NOT_FOUND`，`detail.application_id=9d40…`；`decision` 行 **0 条**，行数无变化 |
| 4 | S8 闸门负例 | `recruitment_interview_schedule` + deny | PASS（负例） | `FORBIDDEN/APPROVAL_NOT_GRANTED`；`interview` 行数不变（0 增量） |
| 5 | **S8 排期** | `recruitment_interview_schedule` + allow-once | **PASS** | +1 interview（`6efc6919…`，`SCHEDULED`，round 1，stage `S8`）/ +2 interviewer / +1 meeting / +1 meeting_binding / +1 business_task（`SUCCEEDED`）；`external_call_made=false` |
| 6 | **S8 面试读** | `recruitment_interview_get` | **PASS** | 面试 + 2 名面试官 + `BOUND_ACTIVE` 会议 + `transcript.state=PENDING` + `evaluation.evaluation_ready=false` |
| 7 | **S9 转写导入** | `recruitment_transcript_import` | **PASS** | +1 transcript_artifact（`74aae1db…`，canonical，`FIXTURE/MANUAL/NOT_CONNECTED`）/ +11 transcript_segment；**warning `RECORD_NOT_CREATED_NO_RUBRIC`**（因 rubric pin 缺失，不建 interview_record） |
| 8 | **S9 转写读** | `recruitment_transcript_read` | **PASS** | `transcript.state=READY`、`reason_code=CANONICAL_STATUS`、canonical 1 版（`74aae1db…`）；warning `RECORD_MISSING`（= F1 的连锁：没有 interview_record）；顶层 labels 报 `LIVE`（不认，见 F5） |
| 9 | S10 闸门负例 | `recruitment_scorecard_submit` + deny | PASS（负例） | `FORBIDDEN/APPROVAL_NOT_GRANTED`；`scorecard` 行数不变（0 增量） |
| 10 | **S10 面评** | `recruitment_scorecard_submit` + allow-once | **PASS** | +1 scorecard（`5c55f58f…`，`SUBMITTED/ADVANCE`，作者 = actor 103 的 interviewer 行 `c45cc4d8…`，rubric = v2）；warning `RUBRIC_EXPLICIT_NOT_PINNED`、`FIXTURE_BASIS` |
| 11 | **S10 汇总（读）** | `recruitment_evaluation_summarize` | **BLOCKED（同一根因）** | `NOT_FOUND / RUBRIC_VERSION_NOT_FOUND` |
| 12 | **S10 决策（写）** | `recruitment_decision_record(STAGE)` | **BLOCKED（同一根因）** | `NOT_FOUND / RUBRIC_VERSION_NOT_FOUND`；`decision` 行 0 条 |
| 13 | 终态读回 | psql | — | `application.current_stage_code=S6`；`rubric_version_id=null`；`decision=0`；interview 1 场；transcript 1 版 canonical；scorecard 1 条 |

行数前后对比（官方 run A，预检 → 终态，**真实打印自 harness**）：

```text
{"application":1,"business_task":1,"candidate":1,"event_inbox":2,"intake_asset":1,"intake_record":1,
 "interview":1,"interviewer":2,"meeting":1,"meeting_binding":1,"resume":1,"resume_version":1,
 "scorecard":1,"transcript_artifact":1,"transcript_segment":11}
```

**判定**：S6 / S7 建议 / S8 / S9 / S10 面评这 5 个写工具**在真实库上确实工作**；
但“S7 人决定落库 → S10 汇总 → S10 人决定落库”这一条业务链**没有走通**。
`docs/18` 的 Golden Path 第 4 步仍然无法完成——不是当时说的“decision_record 不收 SCREENING”
（D-103 已修），而是**更上游**：申请没有 rubric pin，SCREENING 决策连绑定都做不了。

---

## 3. 终态 DB 读回（psql 直查摘要；全文 `db-readback-final.txt`）

```text
-- 申请：有材料，无 rubric pin，仍停在 S6
 id=9d408044-e30c-42be-9c7a-bd6dda78456c  stage=S6  lifecycle=ACTIVE
 rubric_version_id=<null>  resume_version_id=d3de2b99-b2d5-4de8-8cc6-b7643b924915  record_version=1

-- 材料链
 intake_asset=be358974…  sha256=9754a77f…(合成 PDF, VALID)  resume=1ae8e83f…  version_no=1  parse_status=PARSED
 event_inbox=f35f2ebe…  provider=internal  trust_level=INTERNAL  idempotency_key=resume.intake:9754a77f…

-- 决策
 本申请 decision = 0 条
 全库 decision：STAGE/S10 = 1（历史种子，非本链）；SCREENING = 0；FINAL = 0

-- 面试 / 会议
 interview=6efc6919… (round 1, DEFAULT, S8, SCHEDULED, 2026-12-02 10:00+08)
 interviewer: actor 103（演示-HR 专员）、actor 104（演示-面试官），都 required_scorecard=t
 meeting=SYNTHETIC_DEMO / synthetic-meeting-9d408044e30c，binding=SCHEDULED（active）

-- 转写 / 面评
 transcript_artifact=74aae1db…  source_revision=1  is_canonical=t  provenance=FIXTURE
                    trigger_mode=MANUAL  connection_state=NOT_CONNECTED  status=READY  segments=11
 scorecard=5c55f58f…  status=SUBMITTED  overall=ADVANCE  interviewer=actor 103  rubric=…404  record_version=1

-- 全库
 applications=15  with_material=13  with_rubric=2  both_bound=0     ← pin 缺失是系统性的
```

---

## 4. 失败清单（诚实版；不绕过、不改库）

### F1（P0，S7 断链根因）· `application.rubric_version_id` 没有产品写入路径

- **哪一跳**：HOP 3 `recruitment_decision_record(decision_scope='SCREENING')`，以及 HOP 11/12。
- **错误码**（工具自己返回的契约错误，原样）：
  - `NOT_FOUND / RUBRIC_VERSION_NOT_FOUND`
    `"该申请没有钉住 Rubric 版本，决策无法绑定标准（DC-17）"`
    `detail={"application_id":"9d408044-e30c-42be-9c7a-bd6dda78456c"}`
- **根因（代码级，不是环境）**：
  1. S6 建申请只写
     `(tenant_id, candidate_id, job_id, job_version_id, resume_version_id, lifecycle_status, current_stage_code)`
     —— 没有 `rubric_version_id`（`src/tools/application-intake.ts:1565-1568`）；复用已有申请时也只改
     `resume_version_id`（`…:1593-1600`）。
  2. grep 全 `src/**/*.ts`：**没有任何工具**写 `application.rubric_version_id`，也没有任何工具写
     `job.current_rubric_version_id`（该列存在但只有种子数据/手工脚本维护）。
     19 个注册工具里不存在“钉标准”的动作。
  3. 但写侧硬依赖它：`decision-record.ts:2856-2860`（S7/S10 决策都要先读申请的 pin）、
     `evaluation-summarize.ts:1190-1194`（汇总只用申请钉住的版本，不做 fallback）。
  4. 数据佐证：本 lane run 之后 `with_material=13 / with_rubric=2 / both_bound=0`。
     仅有的 2 条有 pin 的申请来自 `0002_seed.sql` / `manual/transcript-line/seed-demo.mjs` 的
     **直接 SQL**，不是产品工具。
- **影响**：任何由 intake 工具创建的申请，**S7 人决定无处落库**，S10 汇总与终局决策同样不可能。
  这不是“验收没跑到”，是“产品路径不存在”。
- **为什么本 lane 不停下来改**：改它需要动 `src/tools/application-intake.ts`（或新增工具/合同），
  属于任务书明令禁止的写范围；且“intake 时按哪一版 rubric 钉”是产品口径选择（见 §9 决策 1）。

### F2 · S10 `evaluation_summarize` 被同一 pin 挡住

- HOP 11：`NOT_FOUND / RUBRIC_VERSION_NOT_FOUND`，`"申请没有钉住 Rubric 版本，汇总无法二次校验 items"`。
- 这是 F1 的直接下游：汇总工具拒绝 fallback（SC-09/10），所以没有 pin 就没有 S10 汇总，也就没有
  `summary_digest`，S10 决策的 `basis_refs[SUMMARY]` 同样无法合法构造。

### F3 · S10 `decision_record(STAGE)` 被同一 pin 挡住

- HOP 12：`NOT_FOUND / RUBRIC_VERSION_NOT_FOUND`，`"该申请没有钉住 Rubric 版本，决策无法绑定标准（DC-17）"`。
- 注意：它在 **STEP 2（存在性/绑定）** 就失败，早于 summary 语义校验；说明这不是“我们没给对 summary_digest”，
  而是申请自身缺事实。

### F4 · 阶段推进没有执行者（N8 复现）

- `application.current_stage_code` 从 S6 创建后**从未变化**：S6 后 = S6，S8/S9/S10 工具都跑完仍然是 S6。
- 证据：HOP 13 读回 + `db-readback-final.txt` §1；grep `src/**` 只有 `application-intake.ts:1567`
  写 `'S6'`，没有任何工具更新阶段码。
- 影响：即使 F1 修好、决策能落库，“S6→S10 的阶段事实”在数据上也观察不到；
  Web 工作台按阶段统计会永远看到一堆 S6。需要产品决定 v1.0 是否提供受控推进命令（§9 决策 2）。

### F5 · S8/S9 读工具与 S8 排期的 `provenance=LIVE` 与合成内容不一致（R4 冲突，N10/P2-03 的同类）

- HOP 5 排期返回 `labels={"provenance":"LIVE","trigger":"MANUAL","connection":"NOT_CONNECTED"}`，
  同时 `external_meeting_id=synthetic-meeting-…`、`provider=SYNTHETIC_DEMO`、`external_call_made=false`；
  这是 `interview-schedule` 写死 `LIVE` 的已知缺陷。
- HOP 6 `interview_get`、HOP 8 `transcript_read` 对**同一条 fixture 链路**也返回
  `provenance=LIVE`（而 `transcript_artifact` 自己的 `provenance=FIXTURE`）。
  按 R4 的字面定义（provenance = 数据是真的还是造的），这批结果的顶层标签应为 FIXTURE，
  或至少要在契约里明确“读工具的 provenance 指读取动作而非数据来源”——现在没有这个定义，属口径歧义。
- **本报告不认这些 LIVE**：本次没有真实外部会议/真实平台转写；不得用于 demo gate（D-1 要求真实 provider artifact）。
  修复归契约（钉死 fixture 租户/读工具标签语义），不在本 lane 写范围。

### F6 · rubric pin 缺失的下游连锁（不是新缺陷，是 F1 的可见后果）

- `transcript_import` 建不了 `interview_record`：warning
  `RECORD_NOT_CREATED_NO_RUBRIC（TR-E4）`——`interview_record.rubric_version_id NOT NULL`。
- `scorecard_submit` 只能按入参 `rubric_version_id` 提交：warning
  `RUBRIC_EXPLICIT_NOT_PINNED（SC-10）`——工具行为正确，但证明“申请本应有的 pin 不存在”。
- 这两条使 S9/S10 的“证据链完整性”降级：转写有了、记录没有；面评有了、标准不是申请钉的。

### 不算失败、但必须写明的边界

- **没有真实模型 / 没有 agent_read**：本次 intake 未传 `structured_json`，身份来自 converter 的
  `native_text`（phone/email），因此没有覆盖 D-67 的 `agent_read` 分支（该分支另有回归测试）。
- **没有 Web 宿主会话**：本 lane 用 `apply()` 级别的工具对象执行，不是模型在 Web/headless 会话里调用；
  R2 的“宿主会话”证据仍需一次 Web 复跑（docs/23 §6.3 第 4 条）。
- **approval 是替身**：allow-once 表示“人允许一次”，但不是真人在 UI 点的；D-95 的 IN_CHAT 原话是
  harness 按任务书给出的合成“人话”。按 docs/23 P1-06 的结构性残余，这只能证明工具路径，
  **不能**把“人机闸门不可绕过”写成已由真人验证。

---

## 5. 重复执行：第二次为什么不能“再来一套”

官方 **run A**（`08:42:17Z`）真实创建；**run B**（`08:42:31Z`，同一 fixture、同一环境）**零新增行**：

```text
行数对比（预检 → 终态）：{}
s6-intake             : application_action=REUSED  candidate_created=false  resume_version_action=UNCHANGED  idempotent_replay=true
s8-schedule           : replayed=true   changes.created=[]
s9-transcript-import  : replayed=true   （同一 (meeting, provider_artifact_id) 相同 content_sha256 → TR-U8）
s10-scorecard         : replayed=true
s10-scorecard-denied  : ALREADY_SUBMITTED/SCORECARD_ALREADY_SUBMITTED（业务拒绝路径，零写入）
s7/s10 decision       : 仍然 NOT_FOUND/RUBRIC_VERSION_NOT_FOUND（没有行可写，也无从重放）
```

机制（按工具契约，不是 harness 自己造的）：

1. **候选人/申请身份**：intake 按 `phone/email` 强标识匹配候选人；同一 candidate+job 的 ACTIVE
   申请唯一（`uq_application_active_cycle`）→ `REUSED`；同一原件 sha256 不新增 `resume_version`
   （`resume_version_action=UNCHANGED`）。
2. **排期**：`idempotency_key` 在 harness 里按 **application_id** 派生
   （`gp-e2e:<application_id>:schedule-r1`）。同一申请重跑 = 同 key + 同参数 → `replayed=true`；
   不同申请不会串 key（早期迭代里用过全局 key，撞了 `IDEMPOTENCY_KEY_REUSED`，已修，见 §7）。
3. **转写**：同 `(meeting, provider_artifact_id)` + 相同 `content_sha256` → replay（TR-U8），不新增 revision。
4. **面评**：`idempotency_key` 按 application 派生；同 key + 同 payload → `replayed=true`。
5. **决策**：根本没有写过行，所以“重复”仍是被同一个 pin 挡住（这不是幂等性，是阻断）。

**什么情况下不可重复（写清楚，避免把“第二次空转”当万能）**：

- 换一份 fixture（不同电话/邮箱/文件哈希）→ 新候选人、新申请，会真实新建；
- 换 `SCHEDULED_START_AT`（README 里是 `2026-12-02T10:00:00+08:00`）或换 `external_meeting_id` → 参数变，
  同 key 会 `IDEMPOTENCY_KEY_REUSED`；**2026-12-02 之后复跑必须把该常量改到未来**；
- 清库/换库 → 第一次 run 会重新 CREATE；
- 如果在同一 application 上手工改过 `resume_version_id` / 阶段码，replay 判定会变（本 lane 没有这么做）。

> **run C（`run-2026-11-14T08-54-41-513Z`，当前 harness 版本）**：官方 A/B 之后，harness 只改过一行注释
> （把使用示例里的本机演示密码换成占位符），为消除 `summary.harness.sha256` 与文件不一致，在最终版上又跑了一次。
> 结果与 run B 相同：**12 跳全部符合预期、零新增行**；该 run 的 `summary.harness.sha256=23fcaec…`
> 与当前 `manual/golden-path/run-golden-path.mjs` 一致。run A/B 的 `091f8ffa…` 是运行时版本（逻辑相同）。

---

## 6. R4 标签：本报告认什么、不认什么

| 数据 | provenance | trigger | connection | 依据 |
|---|---|---|---|---|
| S6 接入 | **FIXTURE** | MANUAL | CONNECTED | 合成 PDF（`event_provider=internal`），工具自报 |
| S7 只读建议 | **FIXTURE** | MANUAL | CONNECTED | 材料链事件是 internal；建议值来自 rubric v2（种子批准） |
| S8 排期 | ⚠️ 工具报 **LIVE** | MANUAL | NOT_CONNECTED | **不认**：会议/日历 id 是合成值，`external_call_made=false`；这是 F5 的标签缺陷 |
| S8 面试读 | ⚠️ 工具报 **LIVE** | MANUAL | CONNECTED | **不认**（同一 fixture 链路）；R4 口径歧义，见 F5 |
| S9 转写 | **FIXTURE** | MANUAL | NOT_CONNECTED | `source_kind=DEMO_SAMPLE`，工具附 `FIXTURE_CONTENT_NOT_LIVE` |
| S9 转写读 | ⚠️ 工具报 **LIVE** | MANUAL | CONNECTED | **不认**：artifact 级 provenance=FIXTURE；见 F5 |
| S10 面评 | **FIXTURE** | MANUAL | CONNECTED | 依据链含 fixture 事件，工具附 `FIXTURE_BASIS` |
| S7/S10 决策 | —— | —— | —— | **没有写任何行**，不存在可贴标签的产物 |
| 材料读取 | —— | —— | —— | converter 真读了合成 PDF（`native_text`、`completeness=complete`），但不是 LIVE 简历 |

一句话：**本次没有一条 LIVE 外部事实**。S8 的 `LIVE` 是工具层面的已知缺陷，不得用于 demo gate。

---

## 7. 试跑残留（数据卫生；不直接写库，故未清理）

正式证据之前，harness 迭代过几次（fixture 身份碰撞 / 外部会议号复用 / 幂等 key 冲突），每次失败都在
S6 留下了**合成**候选人+申请。它们全部经工具创建，`normalized_email` 形如 `lin.chengyu.gp*@example.test`，
**没有一个有 rubric pin，也没有决策**。因为任务禁止直接写库，本 lane 没有删：

| candidate_id | application_id | 阶段 | 材料 | rubric | interview | decision | 备注 |
|---|---|---|---|---|---|---|---|
| `c928afec-32d2-4814-96b1-302632e7e81b` | `9088069a-105d-4f60-9838-ca99b52b4e86` | S6 | 有 | 无 | 0 | 0 | 第 1 次试跑被 shell 管道截断 |
| `bf6c114b-9a81-4fed-927f-93c898875e66` | `0c2c0f88-4d92-447f-b775-86aa2bcc9d10` | S6 | 有 | 无 | 1 | 0 | 早期完整试跑（含 S8/S9/S10 面评，无决策） |
| `07d17c9e-bc8a-41da-91c6-2f1957530265` | `4dfc1184-8be9-467d-84c7-c0f7ecc8c0da` | S6 | 有 | 无 | 0 | 0 | 闸门 key 冲突试验 |
| `652e5907-97f9-421c-8f77-15ad6a2c68ad` | `0067457a-774b-4efa-b9f8-0c114c48e6e4` | S6 | 有 | 无 | 0 | 0 | 面试官时间冲突试验 |
| `5511419c-ffba-401c-a594-357b1f5ee06d` | `030c9bb4-a03f-4170-9593-b175fc923b10` | S6 | 有 | 无 | 0 | 0 | 外部会议号复用试验 |
| **`96485f3c-0e73-43e8-89c3-7d87bb53f9cd`** | **`9d408044-e30c-42be-9c7a-bd6dda78456c`** | **S6** | **有** | **无** | **1** | **0** | **官方 run A/B（本报告主证据）** |

> 这 6 条合成申请也正好是 F1 的批量证据：**6/6 都是 `has_material=true, has_rubric=false`**。
> 如果上层决定清理，请用受控脚本（不要直接 DELETE）并留审计；本 lane 不代为处理。

---

## 8. 证据边界（诚实声明）

1. **工作树不是单一 commit 快照**：官方 run 跑在 `HEAD=92bdc41` + **其它 lane 的未提交 WIP**
   （`src/index.ts`、`src/tools/transcript-import.ts`、`src/connectors/feishu/**`、`package.json` 等）之上。
   这些文件不是本 lane 改的（`git-state.txt` / `git-state-after.txt` 用 `git status --porcelain` 区分了归属）。
   其中 `transcript-import.ts` 的 WIP 与本 lane 的 HOP 7/8 相关 → **干净快照上应复跑一次**；
   F1/F2/F3 涉及的 `application-intake.ts` / `decision-record.ts` / `evaluation-summarize.ts` **不在并发改动清单里**，
   结论不受影响。
   收尾时并发 lane 又新增了 `src/engine/`、`prompts/`、`skills/`、`docs/18`、`contracts/**` 等 WIP；
   **这些 WIP 里也没有任何“写 application.rubric_version_id”的入口**（收尾快照 `git-state-after.txt` 可与
   `git diff` 复核），F1 不是被并发改动临时造成的。
2. **没有真实模型**：intake 未传 `structured_json`，未覆盖 agent 结构化路径。
3. **没有 Web/headless 宿主会话**：只有“注册工厂产出的工具对象 → execute()”，与 docs/23 的 R2 边界同级。
4. **approval 与 IN_CHAT 是替身**：见 §1 与 §6。
5. **没有阶段推进**：见 F4；`current_stage_code` 保持 S6 是产品现状，不是 harness 遗漏。
6. **DB 是共享的 `ra_s6s7`**：本 lane 的 6 条合成申请是新增数据（见 §7）；没有建/删库，没有改他人数据。
7. **harness 版本**：run A/B 由 `091f8ffa…` 版本产出；之后仅把使用注释里的本机演示密码换成占位符（一行），
   run C（`23fcaec…`，当前文件）复跑结果一致（零新增行、12 跳同结论）。三份 summary 的
   `harness.sha256` 可逐份核对。

---

## 9. 需要上层决策 / 下一步（本 lane 按停止条件停在这里）

1. **【决策 A · 最关键】申请钉住 rubric 的责任归谁？** 三个可选修法（需改 `src/**`，本 lane 无权限）：
   - (a) `application_intake` 建申请时把 `job.current_rubric_version_id` 写进 `application.rubric_version_id`
     （若无已批准版本则 intake 报 `BLOCKED`/`PENDING`，不能静默 null）；
   - (b) `application_intake` 增加显式 `rubric_version_id` 入参（由调用方/S3 决定钉哪版），缺省时仍要明确失败；
   - (c) 新增独立“钉标准”工具（人类/招聘负责人动作，带审批与事件）。
   **建议 (a)+(b) 组合**：默认钉岗位当前已批准版本，允许 S3 显式指定；任何时候库里不允许
   “有材料无 rubric”的申请进入 S7（或在 S7 明确 BLOCK，而不是到 decision 才报 NOT_FOUND）。
   **需要产品负责人拍板**，因为它改变 S6 合同与 D-103 的前置假设。
2. **【决策 B】阶段推进**：v1.0 是否提供受控的 `application.current_stage_code` 推进入口
   （带 actor / `stage_catalog` 校验 / 事件）；还是明确“阶段码只是标签、v1.0 不做推进”，
   并把 docs/18 的阶段表改成非流程承诺。二者必须选一（N8）。
3. **【决策 C】S8 标签**：契约里钉死“fixture 租户”的机检口径，修掉 `interview_schedule` 写死 `LIVE`
   （N10/P2-03）。本 lane 的合成会议/转写不能算 LIVE；读工具（`interview_get` / `transcript_read`）的 `LIVE` 语义也需一并钉死。
4. **修好 A 之后**：直接复跑本 harness（§10），预期新增 PASS：
   - `decision(SCREENING, S7)` 1 条；`evaluation_summarize` 返回 `summary_digest`；
   - `decision(STAGE, S10)` 1 条（需真实 `summary_digest` + SCORECARD/SUMMARY/INTERVIEW_RECORD/AUTHORITY basis）；
   - 若决策 B 提供推进命令：`application.current_stage_code` 最终应为 S10。
   这三条是“Golden Path 真贯通”的最小判据（本 lane 的报告届时可被复审复用）。
5. **复审时**：在干净 commit 上复跑 `manual/golden-path/run-golden-path.mjs`，并核对本文件的
   `run-*` 三份 summary（run A 建、run B/C 全 replay）。注意 §7 的残留会改变“预检行数”，
   但不影响 run A 的 delta 判定。

---

## 10. 文件清单与复跑

```text
manual/golden-path/
  run-golden-path.mjs                 # harness：真实工具 execute + 读回 + 行数对比 + 证据落盘
  fixtures/build_synthetic_resume.py  # 合成简历生成器（PyMuPDF，内置 CJK 字体，无真实 PII）
  fixtures/synthetic-resume-golden-path.pdf  # sha256=9754a77f…（10920 bytes，2 页，native_text）

evidence/experiments/2026-11-14-golden-path-e2e/
  README.md                    # 本文件
  commands.txt                 # 命令原文 + 真实输出（E1）
  git-state.txt                # HEAD / status / diff：证明本 lane 未改 src、未 commit（第一快照）
  git-state-after.txt          # 收尾第二快照：并发 lane 又改了哪些文件；本 lane 仍只有两个新增目录
  db-readback-final.sql        # 终态读回 SQL（只读，打码）
  db-readback-final.txt        # 终态读回真实输出（E2）
  console-run-A-08-42-17.log   # 官方 run A 完整 stdout（退出码 0）
  console-run-B-08-42-31.log   # 官方 run B 完整 stdout（退出码 0，零新增行）
  console-run-C-08-54-41.log   # 最终 harness 版本复跑（退出码 0，零新增行；sha 与当前文件一致）
  fixture.json                 # fixture 路径/sha256/R7 说明
  run-2026-11-14T08-42-17-972Z/  # run A：run.log、hop-00..13 JSON、summary.json、fixture 副本
  run-2026-11-14T08-42-31-029Z/  # run B：同上（replay 证据）
  run-2026-11-14T08-54-41-513Z/  # run C：同上（最终 harness 版本，replay 证据）
```

复跑（PowerShell；密码只走环境变量）：

```powershell
cd "D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment"
$env:RECRUITMENT_DB_PASSWORD='<本机演示库密码，按约定注入，不落盘>'
$env:GOLDEN_PATH_HEAD=(git -C "D:\12412\dsh工作区\projects\recruitment-agent" rev-parse HEAD)
# 若 2026-12-02 已过，先把 run-golden-path.mjs 的 SCHEDULED_START_AT 改到未来
node manual/golden-path/run-golden-path.mjs
```

harness 会把新的 `run-<stamp>/` 写进本目录；退出码 0 = 12 跳全部符合预期（含 3 个 expected-blocker 与
2 个 negative-control），非 0 = 出现意外失败（`summary.failures` 非空）。
