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

---

## 7. 本轮证据

见 `evidence/` 与本文件末尾（由 Owner 在验收后补：四个测试数、headless `tool/call`+`tool/result` 原文、
DB 读回、负例 SQLSTATE）。
