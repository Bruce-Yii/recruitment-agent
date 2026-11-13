# S8 · 面试线（interview line）· 交付说明与验收手册

**日期**：2026-11-13
**分支**：`feat/unified-document-intake`（本地 = 远端 `5581c26`）
**上游合同**（**未修改**）：`contracts/interview/scheduling-rules.md`、`contracts/interview/tool-contracts.md`、
`contracts/interview/transcript-rules.md` §4；数据库 `db/migrations/0001..0009`（**未修改**）。
**实现规格**：`SPEC.md`（本目录）。

---

## 1. 这一刀切了什么

薄而真实的一条：**「给某条申请安排一场面试」→ 落库 → 立刻读回**。

| 工具 | 实现 | 明确不做 |
|---|---|---|
| `recruitment_interview_schedule` | `intent=CREATE`：`interview`（`stage_code='S8'`，外键到 `stage_catalog`）+ 每个面试官一行 `interviewer`（`round_no` / `slot_code` / `required_scorecard`）+ 可选 `meeting` + `meeting_binding`（`binding_method='SCHEDULED'`）+ 未绑会议时的 `business_task(INTERVIEW_MEETING_BIND, WAITING_EXTERNAL)` + 幂等 STORE；面试官/候选人冲突拒绝；`uq_interview_slot` / `uq_meeting_binding_active` / `fk_interview_stage_catalog` 的 SQLSTATE 翻译 | `RESCHEDULE` / `CANCEL` / `WITHDRAW_INTERVIEWER`（后续切片；`intent` enum 里**没有**它们，不会假装成功）；建飞书日历/发邀请；通知 |
| `recruitment_interview_get` | 单场 / 按申请查询；`interview` + `interviewer`（含当前面评）+ `meeting_binding`（1 面试 : N 会议）+ `transcript.state`（TR-D 七条）+ `evaluation` 计数/blockers + warnings | `transcript.artifacts[]` 明细、`open_tasks[]`（thin slice 收窄，见 §6） |

**一句话**：`stage_code=S8`、`round_no`、`interviewer`、`meeting`、`meeting_binding` 都真的落库，能用
`recruitment_interview_get` 读回；同一会议绑第二场面试会被库用 `23505` 拒绝；非法 `stage_code` 会被
`0006` 的外键用 `23503` 拒绝；缺面试官在参数层就被拒。

### 文件

| 文件 | 作用 |
|---|---|
| `src/tools/interview-schedule.ts` | 写工具（`intent=CREATE`） |
| `src/tools/interview-get.ts` | 只读工具 + 共享的 `readInterviewValue` / `INTERVIEW_VALUE_SCHEMA` |
| `test/unit/interview-schedule-args.test.ts`、`test/integration/interview-schedule.test.ts` | schedule 的参数层与真库测试（事务回滚） |
| `test/unit/interview-get-args.test.ts`、`test/integration/interview-get.test.ts` | get 的参数层与真库测试（事务回滚） |
| `test/unit/interview-output-schema.test.ts` | 两个工具的 output schema 只用 DSH 子集、无 `type:'null'`、输出值无 `null` |
| `manual/interview-line/**` | 本文件、`SPEC.md`、headless 验收脚本、DB 读回、负例、harness（**不属产品运行时**） |

**没有改**：`src/index.ts`（注册由 W0 集成，见 §5）、`src/db/**`、`contracts/**`、`db/**`、`converter/**`、
`src/document/**`、`application-intake.ts`、`screening-evaluate.ts`。

---

## 2. 跑测试（真库）

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment
$env:RECRUITMENT_DB_PASSWORD='123456'

node --test "test/unit/interview-*.test.ts"
node --test "test/integration/interview-*.test.ts"
node --test                                  # 全量（不许新增失败）
```

集成测试全部在 `inRolledBackTx` 里跑，结束 `ROLLBACK`，**不污染 `ra_s6s7`**；缺环境变量直接红，不静默 skip。

> 报数口径：`tests / pass / fail / skipped` 四个数。本轮结果见 §7。

---

## 3. 真实 headless（一句自然语言）

产品注册点 `src/index.ts` 归 W0，本 lane 不改。为了**在真实 DSH runtime 里**证明模型能按自然语言调到
这两个工具，本目录带一个**只注册 S8 两个工具**的最小 harness（`harness/`），它 import 的是
`src/tools/interview-{schedule,get}.ts` 的**真实实现**，没有复制逻辑、没有 mock：

```
manual/interview-line/harness/package.json     name: dsh-recruitment-s8-demo
manual/interview-line/harness/index.ts         apply(): register(createInterviewScheduleTool / createInterviewGetTool)
manual/interview-line/harness/cordis.patch.yml 只给 database 段（tenant_id / actor_id 只从这里来）
```

一次性建 profile（本机已建好 `rec-agent-s8`；重建步骤）：

```powershell
$env:DSH_HOME='D:\12412\dsh-home'
dsh --profile rec-agent-s8 --from-default-profile headless --dump-config
Copy-Item "$env:DSH_HOME\profiles\rec-agent-test\cordis.patch.yml" "$env:DSH_HOME\profiles\rec-agent-s8\cordis.patch.yml" -Force
dsh plugin --profile rec-agent-s8 add link:D:/12412/dsh工作区/projects/recruitment-agent/dsh/dsh-recruitment/manual/interview-line/harness
```

跑一句话验收：

```powershell
$env:RECRUITMENT_DB_PASSWORD='123456'
D:\Python3.12.9\python.exe manual\interview-line\run-headless.py
```

goal 只给业务事实（哪条申请、第 1 轮、两个面试官、**下周三下午两点**、60 分钟、线上、飞书会议标识），
**不提工具名、不给步骤**。证据落在 `manual/interview-line/evidence/<时间戳>/`：

- `goal.txt`（逐字输入）
- `dsh-stdout.txt` / `dsh-stderr.txt`
- `session-path.txt`（本次 `session.v3.jsonl.zstd`）
- `tool-trace.txt`（从会话日志抽出的 `tool/call` + `tool/result` **原文**）

---

## 4. DB 读回与负例

```powershell
# 读回（interview / interviewer / meeting / meeting_binding / business_task）
node manual/interview-line/readback.mjs --interview <interview_id>
node manual/interview-line/readback.mjs --application <application_id>

# 负例（全部在回滚事务里）
node manual/interview-line/negatives.mjs --application <application_id>
```

负例断言（真实 SQLSTATE）：

| 探针 | 期望 |
|---|---|
| 同一 meeting 第二条 active binding（裸 SQL） | `23505` / `uq_meeting_binding_active` |
| 非法 `stage_code`（裸 SQL） | `23503` / `fk_interview_stage_catalog`（`0006` 的外键） |
| 缺面试官（工具） | `INVALID_ARGS(INTERVIEWER_REQUIRED)`，零写入 |
| 同一会议绑第二场（工具） | `MEETING_ALREADY_BOUND`，零写入 |

---

## 5. 给 W0 的注册签名（**不改 `src/index.ts` 的回报**）

```ts
import {
  createInterviewScheduleTool,
  unconfiguredInterviewScheduleTool,
} from './tools/interview-schedule.ts'
import {
  createInterviewGetTool,
  unconfiguredInterviewGetTool,
} from './tools/interview-get.ts'

// apply() 里，与 jobGet 同一模式（只要 database 段）：
const interviewSchedule = database.resolved === null
  ? unconfiguredInterviewScheduleTool(database.issues)
  : createInterviewScheduleTool(database.resolved)
const interviewGet = database.resolved === null
  ? unconfiguredInterviewGetTool(database.issues)
  : createInterviewGetTool(database.resolved)

// tools 数组里追加：
//   interviewSchedule,
//   interviewGet,
```

- 两个工具名：`recruitment_interview_schedule` / `recruitment_interview_get`。
- 只需要 `database` 配置；`tenant_id` / `actor_id` 只来自配置，**不接受模型传入**。
- `schedule` 的 `isConcurrencySafe` 为 `false`（写），`get` 为 `true`（只读）。
- `cordis.patch.yml` **不需要**新增配置段（复用现有 `database`）。

---

## 6. 与合同的偏差（诚实清单）

| # | 合同 | 本实现 | 为什么 |
|---|---|---|---|
| D-1 | `intent` 四值（CREATE/RESCHEDULE/CANCEL/WITHDRAW_INTERVIEWER） | 只 `CREATE` | 本轮是 S8 薄切片；其余三个 intent 没有实现，**不放进 enum**，不会被误当成成功 |
| D-2 | 输出里 `null` 字段（`scheduled_end_at: null` 等） | 数据库 NULL 一律**省略键** | DSH 校验器不支持 `type` 数组，`null` 会整次 `INVALID_TOOL_OUTPUT`（真实事故，见 `test/unit/output-schema.test.ts`） |
| D-3 | `transcript` 块含 `artifacts[]` / `coverage` / `open_tasks[]` | 只回 `state / reason_code / no_transcript`（`transcript.state` 仍严格按 TR-D 七条） | S8 只负责排期；明细属 S9 读工具 |
| D-4 | `application.lifecycle_status != ACTIVE` 的失败码 | `INVALID_ARGS(APPLICATION_NOT_ACTIVE)` | 合同 §2.3 漏了这个分支；该 `reason_code` 是本实现补的（记录在此，不私改合同） |
| D-5 | `CANCEL`/`RESCHEDULE` 的 `event` 审计 | 未实现 | 与 D-1 同因 |
| D-6 | `meeting.calendar_event_id` 无唯一索引 | 工具按 `(tenant, provider, external_meeting_id)` 优先匹配；只有 `calendar_event_id` 时按 `(tenant, provider, calendar_event_id)` 找最近一行再绑 | 防止同一日历事件被重复建 meeting 行；库只在 meeting 侧约束 active binding |
| D-7 | `evaluation.submitted/waived/pending` 的口径未写死 | **只数 `required_scorecard=true` 的面试官**（与 blockers 同一集合），恒有 `required = submitted + waived + pending` | 照字面"数全部当前面评"会出现 `pending=0` 却仍有 `SCORECARD_PENDING` blocker 的自相矛盾（实现自检发现） |
| D-8 | `schedule.interview` 与 `get.interviews[]` 同形 | 直接复用 `INTERVIEW_VALUE_SCHEMA`（静态 import），不另写一份 | 避免两个工具的形状各自漂移；真实值已用回滚 probe 验证可过一次过 |
| D-9 | `NO_TRANSCRIPT` / `CONFLICT_SLOT` / `ALREADY_SCHEDULED` / `MEETING_ALREADY_BOUND` 不在 `src/tools/errors.ts` 的 `RecruitmentErrorCode` | 用本文件 `s8Error()` / `contractError('NO_TRANSCRIPT' as …)` 以**同一消息格式**构造；未改 `errors.ts`（不在写范围） | W0 集成时应把这些码并入 `RecruitmentErrorCode`，然后删掉类型断言 |

---

## 7. 本轮证据（2026-11-13）

### 7.1 测试（真库 `ra_s6s7`，四个数）

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment
$env:RECRUITMENT_DB_PASSWORD='123456'
node --test "test/unit/interview-*.test.ts"          # schedule 27 + get 15 + 形状闸门 4
node --test "test/integration/interview-*.test.ts"   # schedule 16 + get 13
node --test                                          # 全量
```

| 范围 | tests | pass | fail | skipped |
|---|---|---|---|---|
| S8 单元 `interview-*.test.ts` | 46 | 46 | 0 | 0 |
| S8 集成 `interview-*.test.ts` | 29 | 29 | 0 | 0 |
| 全量 `node --test` | 708 | 708 | 0 | 0 |

（基线是 389；后续增量来自本 lane 43 + 其它并行 lane。集成用例全部在 `inRolledBackTx` 里跑、结束 `ROLLBACK`。）

### 7.2 真实 headless（一句自然语言 → `tool/call` + `tool/result` 原文）

- 入口：`dsh --profile rec-agent-s8 $env:NL_GOAL`（headless，真实模型 `beam-free`）
- 会话：`session-f6ea98c2-7482-4e6d-b4eb-096d3665b948`
- 证据目录：`manual/interview-line/evidence/20261113-200552/`
  （`goal.txt` / `tool-trace.txt` / `dsh-stdout.txt` / `dsh-stderr.txt` / `session-path.txt` / `db-readback.txt` / `negatives.txt`）

**goal（逐字，没有工具名、没有步骤）**

```text
给招聘系统里的这条申请安排一场面试：application_id=11111111-1111-4111-8111-000000000701，第 1 轮，场次代码 S8T2005。面试官是「演示-面试官」（actor_id=11111111-1111-4111-8111-000000000104）和「演示-HR 专员」（actor_id=11111111-1111-4111-8111-000000000103），两人都要交面评。时间是下周三下午三点（今天是 2026-11-13 周五），时长 60 分钟，线上视频面试。会议先按飞书会议登记：provider=FEISHU，external_meeting_id=feishu-s8-demo-20261113-200552。排好后用读工具把这场面试回读给我确认，我需要看到时间、面试官和会议绑定。全程自己决定怎么做，不要问我。
```

**`tool/call` #1（原文）**

```json
{"name":"recruitment_interview_schedule","callId":"call-514f7473-da1b-4714-aea2-679e91cafb49","arguments":"{\"application_id\":\"11111111-1111-4111-8111-000000000701\",\"delivery_mode\":\"VIDEO\",\"duration_minutes\":60,\"idempotency_key\":\"demo-s8-20261113-200552\",\"interviewers\":[{\"actor_id\":\"11111111-1111-4111-8111-000000000104\",\"required_scorecard\":true},{\"actor_id\":\"11111111-1111-4111-8111-000000000103\",\"required_scorecard\":true}],\"meeting\":{\"provider\":\"FEISHU\",\"external_meeting_id\":\"feishu-s8-demo-20261113-200552\",\"meeting_role\":\"PRIMARY\"},\"round_no\":1,\"scheduled_start_at\":\"2026-11-18T15:00:00+08:00\",\"slot_code\":\"S8T2005\",\"timezone\":\"Asia/Shanghai\"}"}
```

**`tool/result` #1（模型可见原文）**

```text
interview 838dc59e-3cfd-4f20-92a8-39a4efdd2c0f round=1 slot=S8T2005 [SCHEDULED] stage=S8  2026-11-18T07:00:00.000Z → 2026-11-18T08:00:00.000Z
  application=11111111-1111-4111-8111-000000000701 candidate=11111111-1111-4111-8111-000000000601 job=11111111-1111-4111-8111-000000000401 timezone=Asia/Shanghai
  interviewers: 演示-HR 专员(INTERVIEWER, required) · 演示-面试官(INTERVIEWER, required)
  meeting_binding: BOUND_ACTIVE (1 active)
  replayed=false  changes.created=6  labels: LIVE/MANUAL/NOT_CONNECTED
    + interview 838dc59e-3cfd-4f20-92a8-39a4efdd2c0f
    + interviewer 01cd78fe-0dcf-40b7-8053-82d4c84d9fad
    + interviewer 4bc71a64-e377-4dd3-917f-54421e2b5e84
    + meeting 4e7936a0-6d97-4a79-89a1-5a7647b1650f
    + meeting_binding d59b62ee-4ce6-4785-a38a-33e183f04a79
    + business_task f1f0f95d-9e33-429e-bab0-23ad43e413ac
```

模型自己把「下周三下午三点」算成 `2026-11-18T15:00:00+08:00`（今天 2026-11-13 周五 → 下周三 11-18），
并自己补了 `delivery_mode=VIDEO` / `timezone=Asia/Shanghai` / `meeting_role=PRIMARY`。

**`tool/call` #2（原文）**

```json
{"name":"recruitment_interview_get","callId":"call-4e86e014-f71f-4b5f-87f8-8b781dfc01dc","arguments":"{\"interview_id\":\"838dc59e-3cfd-4f20-92a8-39a4efdd2c0f\"}"}
```

**`tool/result` #2（模型可见原文）**

```text
recruitment_interview_get 1.0.0  (labels: LIVE/MANUAL/CONNECTED)  as_of=2026-11-13T12:06:02.419Z
query: {"mode":"BY_INTERVIEW","interview_id":"838dc59e-3cfd-4f20-92a8-39a4efdd2c0f"}  count=1
interview 838dc59e-3cfd-4f20-92a8-39a4efdd2c0f  round=1 slot=S8T2005 stage=S8 [SCHEDULED]  2026-11-18T07:00:00.000Z – 2026-11-18T08:00:00.000Z
  application_id=11111111-1111-4111-8111-000000000701  candidate_id=11111111-1111-4111-8111-000000000601  job_id=11111111-1111-4111-8111-000000000401
  interviewers:
  演示-HR 专员(required, no scorecard)
  演示-面试官(required, no scorecard)
  meeting_binding: BOUND_ACTIVE  FEISHU feishu-s8-demo-20261113-200552 → PRIMARY (binding_method=SCHEDULED, meeting_id=4e7936a0-6d97-4a79-89a1-5a7647b1650f)
  transcript: PENDING WAITING (no_transcript=true)
  evaluation: required=2 submitted=0 waived=0 pending=2 → evaluation_ready=false
    blockers: SCORECARD_PENDING(11111111-1111-4111-8111-000000000103), SCORECARD_PENDING(11111111-1111-4111-8111-000000000104), RECORD_NOT_READY(-)
  warnings: —
```

### 7.3 DB 读回（`db-readback.txt` 全文）

| 表 | 关键列（真实值） |
|---|---|
| `interview` | `id=838dc59e-…`，`application_id=…0701`，`stage_code=S8`，`round_no=1`，`slot_code=S8T2005`，`status=SCHEDULED`，`scheduled_start_at=2026-11-18T07:00:00Z`，`scheduled_end_at=2026-11-18T08:00:00Z`，`timezone=Asia/Shanghai`，`record_version=1`，`status_changed_by_actor_id=…0103` |
| `interviewer` | 2 行：`actor=…0103 演示-HR 专员` / `actor=…0104 演示-面试官`，`role_in_interview=INTERVIEWER`，`required_scorecard=true`，`kind=HUMAN` |
| `meeting` | `id=4e7936a0-…`，`provider=FEISHU`，`external_meeting_id=feishu-s8-demo-20261113-200552`，`meeting_role=PRIMARY` |
| `meeting_binding` | `id=d59b62ee-…`，`binding_method=SCHEDULED`，`bound_by_actor_id=…0103`，`unbound_at=null` |
| `business_task` | `INTERVIEW_SCHEDULE / SUCCEEDED`，`idempotency_key=interview_schedule:demo-s8-20261113-200552`，`business_refs` 含 `args_digest=sha256:8dfe8f4a…` 与 `result_interview_id` |

### 7.4 负例（`negatives.txt` 全文）

```text
[PASS] NEG1 缺面试官被拒且零写入 — code=INVALID_ARGS reason_code=INTERVIEWER_REQUIRED interview_rows=5（ROLLBACK 后仍 5）
[PASS] NEG2 同一会议绑第二场被拒且零写入 — code=MEETING_ALREADY_BOUND reason_code=BOUND_TO_OTHER_INTERVIEW interview_rows=5（ROLLBACK 后仍 5）
[PASS] NEG3 第二条 active binding 被库拒绝 — SQLSTATE=23505 constraint=uq_meeting_binding_active
[PASS] NEG4 非法 stage_code 被外键拒绝 — SQLSTATE=23503 constraint=fk_interview_stage_catalog
=== negatives: pass=4 fail=0 ===
```

真实 SQLSTATE 原文（子代理 A 的裸 SQL 探针，同一库）：

```text
code=23505  constraint=uq_meeting_binding_active
message=重复键违反唯一约束"uq_meeting_binding_active"

code=23503  constraint=fk_interview_stage_catalog
message=插入或更新表 "interview" 违反外键约束 "fk_interview_stage_catalog"
```

### 7.5 外部事实（必须记一笔）

- 本 lane **未 commit、未 push**。但在 2026-11-13 19:16，另一个执行者把当时工作区快照提交成
  `6741e61 WIP(modules)…`（**含本 lane 当时的部分文件**），并把 `feat/unified-document-intake`
  推到该 commit。此后本 lane 的修正仍以未提交的工作区改动存在。
- 因此「本地 = 远端」的事实从 `5581c26` 变成了 `6741e61`；**交付以工作区当前状态为准**，
  集成仍需 W0 决定是否 squash / 重做提交。

