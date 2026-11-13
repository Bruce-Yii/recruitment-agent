# tool-contracts.md · S10 三个工具的形状

**版本**：`evaluation-tool-contracts 2.0.0`（与 `scorecard 1.1.0` / `decision 1.1.0` 同一基线；**2.0.0 的原因**：错误码集合、`permitted_results` 语义与 `as_of` 必填都变了，下游会断——按 §8 的版本规则必须 minor 以上）
**日期**：2026-11-13
**范围**：**只写契约**——入参、出参、错误码、必守性质。**不含任何实现**（不写 SQL、不写 TS）
**规则来源**：`scorecard-rules.md`（面评规则）、`decision-rules.md`（汇总与决策规则）。**本文件与那两份冲突时，以那两份为准**——这里只是形状。

---

## 0. 三个工具的边界（先划死，再谈字段）

| 工具 | 一句话 | 读 | 写 | 能产 `decision` 吗 | 能改状态吗 |
|---|---|---|---|---|---|
| `recruitment_scorecard_submit` | 一位面试官交**自己**这一轮的面评 | 库（interview / interviewer / rubric / application） | **写**：`scorecard` 一行 | 否 | 否 |
| `recruitment_evaluation_summarize` | 把一个申请（或一场面试）的**面评票数与缺口**汇总成一份**只读**投影 | 库 | **无** | **否**（`advisory: true`） | 否 |
| `recruitment_decision_record` | 把**人已经做出的决定**连同依据记进 `decision` | 库 | **写**：`decision` 一行 + 旧行指针 + 内部事件 | **是（但必须人已确认）** | 否（见 `DC-47`） |

**六条"永远不做"**（每条都有对应的库约束或红线）：

1. **不代决**：`summarize` 的输出里没有 `result`、没有 `decided_by_actor_id`、没有 `decided_at`、没有 `recommended_result`、没有 `overall_score`（`APP-07`、`decision-rules.md` §1-1）。
2. **不用缺失面评算分**：`missing` 不进分母、不补 0、不补均值（`SC-22/23/24`）。
3. **不用 `unreadable` 拒绝人**：写侧 `SC-31` + 决策侧 `DC-24` 两道闸。
4. **不接受模型传入的 `tenant_id` / `actor_id` / `decided_by_actor_id` / `stage_code`**：租户与身份**只能**来自执行上下文（`SET LOCAL recruitment.actor_id`，`XINV-7`、`D-18`）；`stage_code` 只由工具写 `'S10'`（`DC-07`）。入参里出现这些键 → `INVALID_ARGS`（**不是静默忽略**）。
5. **不改任何状态**：`application.lifecycle_status` / `current_stage_code` / `interview.status` 一个都不动（`DC-47`、`decision-rules.md` N-5）。
6. **不输出恒真的权限字段**：没有 `can_submit` / `can_decide` / `allowed: true`（`D-33` 明令"不预留假接口"）。`permitted_results` 只表达**数据/流程门禁**，**不是**权限判定。

---

## 1. 共同约定

### 1.1 参数解析（沿用 `CONTRACT.md` §2.1 七条 + 本契约第 8 条）

1. `arguments` 必须是 JSON 对象；数组/标量 → `INVALID_ARGS`。
2. **未声明的键一律拒绝**（`additionalProperties: false`），错误里列出允许的键。**例外**：§1.6 的"保留键"是**声明过但一律拒收**的，它们报 `TENANT_OR_ACTOR_NOT_ALLOWED`（不是 `UNKNOWN_PARAM`）——因为"身份不该由调用方给"和"你不认识的键"是两种错误，不能混成一个。
3. 必填缺失 → 拒绝；`string` 必须非空且不超 `maxLength`。
4. `integer` 必须是整数（`10` 通过，`"10"` / `10.5` 拒绝），并检查闭区间。
5. `boolean` 必须是布尔（`"true"` 拒绝）。
6. 数组逐元素校验（元素是标量就查 `enum`，是对象就逐字段查）；**重复元素拒绝**（`acknowledged_missing` 里同一个人出现两次是数据错误）。
7. **收集全部违反项一次性抛出**，不是遇到第一条就返回。
8. `string` 类型的 id 必须是 **UUID 文本形式**（小写化后比对）。`iv_0001` / `sc_0001` 这类 stub id 不是合法 UUID → `INVALID_ARGS(ID_NOT_UUID)`。

### 1.2 错误消息格式

```text
Error: <CODE>: <compact-json>
```

`<compact-json>` 的键（`code` 在消息里出现两次是刻意的：一次给 grep，一次给 JSON 解析）：

| 键 | 必填 | 说明 |
|---|---|---|
| `code` | ✅ | 与消息前缀同一个值 |
| `reason_code` | ✅ | 该错误码下的**封闭枚举**（§5） |
| `family` | 仅 `BLOCKED_BY_REVIEW` | 阻断族（`COVERAGE` / `EVIDENCE` / `QUEUE` / `STATE`），与 `blockers[].family` 同一取值集 |
| `message` | ✅ | 一句给人看的中文说明 |
| `detail` | 视 code | 结构化明细（`missing[]`、`violations[]`、`blocking_items[]`、`allowed[]`、`constraint`） |

JSON 必须**单行**，键序固定为 **`code` → `reason_code` → `family`（缺则不占位）→ `message` → `detail`**，便于断言。**不再写"字典序"**：本文件的示例一律按这个顺序，字典序会与它们冲突（示例里 `detail` 在末尾，而不是 `code` 之后）。

> **示例必须真的能 `JSON.parse`**：`[…]` 这种占位写法在示例里出现就是违约（§7.1 第 7 条要求每个错误消息体都能解析）。

### 1.3 三维标签（R4，逐工具给语义，**禁止混用一维枚举**）

| 维度 | 取值 | `scorecard_submit` | `evaluation_summarize` | `decision_record` |
|---|---|---|---|---|
| `provenance` | `LIVE` \| `FIXTURE` | 同 `summarize`（面评归属的那场面试） | 见下方判定式 | 同 `summarize`，且**必须**写进 `basis_refs[SUMMARY].provenance` |
| `trigger` | `EVENT` \| `MANUAL` | `MANUAL` | `MANUAL` | `MANUAL` |
| `connection` | `CONNECTED` \| `NOT_CONNECTED` | `CONNECTED`（直连业务库） | 同左 | 同左 |

`provenance` 判定式（**可机检**，与 `job-screening/tool-contracts.md §1.4` 同一手法）：

```
provenance = 'LIVE'
  ⟺ 存在链路 resume_version → resume → intake_asset → intake_record → event_inbox
     且 event_inbox.provider <> 'internal'
   ∧ 该 interview 的 meeting（若有 meeting_binding）provider <> 'internal'
  否则 'FIXTURE'
```

> **不因 `provenance='FIXTURE'` 就拒绝或改判**：本层只贴标签。是否允许 fixture 数据产生真实决策，由**验收侧**决定（demo gate 要求 `provenance=LIVE`；该条属产品决定，`docs/17-decision-ledger.md` 未收录其编号，本文只引用结论、不依赖编号）。
> 但**必须**留痕：`decision_record` 在 `provenance='FIXTURE'` 时输出 `warnings: FIXTURE_BASIS`，并把标签写进 `basis_refs`——这样"这条决策是演练数据"永远可查，不会变成一份看起来像真的录用记录。

### 1.4 身份、租户与时钟

| 项 | 规则 | 依据 |
|---|---|---|
| actor | 只从 `SET LOCAL recruitment.actor_id` 取；入参不接受 | `D-18`、`XINV-7` |
| tenant | 只从执行上下文取；入参不接受 | 复合外键物理禁止跨租户（`SCHEMA §1`） |
| 时钟 | 写工具用服务端 `now()`；`summarize` 不输出任何墙钟字段，唯一时间输入是 **`as_of`（必填，且 `record` 也必须带同一个值）**，原样回显。**不设"缺省取 now()"**：那会让同一输入在不同时刻算出不同 `coverage.overdue` 与 `summary_digest`（`D-16`） | `SC-14`、`DC-48`、`D-16` |
| 并发 | 写工具必须带 `expected_record_version`（修订/撤回时） | `SCHEMA §1`、`D-18` |


### 1.5 幂等键（**只有提交面评需要；`decision` 在 v1.0 明确不做**）

| 规则 | 说明 |
|---|---|
| `recruitment_scorecard_submit` **必须**带 `idempotency_key`（1..128 字符，`^[A-Za-z0-9:_-]{1,128}$`） | 同 key + 同 payload → **返回原结果**（`replayed: true`），不新增行、不改 `record_version` |
| 同 key + 不同 payload → `INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)` | 幂等键不能被复用成"另一个操作" |
| 落点 | `scorecard` 无该列 → 落 `event_inbox`（`XINV-1`）；`0007` 给 `scorecard` 加列（`scorecard-rules.md` G-2） |
| **`recruitment_decision_record` 不带 `idempotency_key`** | `D-80`：取消"同一 key 重试返回同一条决策"这个承诺。`decision` 表没有可落键的列，加列要迁移，而"重试同一请求"在工具调用里没有语义。**传了该键 → `INVALID_ARGS(UNKNOWN_PARAM)`**（键不在 schema 里） |
| `decision` 的重复与并发 | 只靠 `(tenant_id, application_id, decision_scope, stage_code)` 只有一条 current（`0007` 的部分唯一索引）→ 冲突 **23505** → `ALREADY_DECIDED`。**不许**用 `SELECT … FOR UPDATE`（锁不到不存在的行） |

### 1.6 保留键（**声明在 schema 里，但一律拒收**）

| 键 | 出现在 | 为什么拒收 |
|---|---|---|
| `tenant_id` | 三个工具 | 租户只从上下文取（复合外键已物理禁止跨租户） |
| `actor_id` / `interviewer_id` | submit / summarize | 作者只从上下文取（`SC-01`、`SC-05`） |
| `decided_by_actor_id` | record | 决策人只从上下文取（`DC-10`） |
| `stage_code` | 三个工具 | 工具写死 `'S10'`（`DC-07`） |
| `round_no` / `slot_code` | 三个工具 | 轮次由 `interview_id` 决定（`SC-07`） |
| `submitted_at` / `decided_at` | submit / record | 时间由服务端取（`SC-14`、`DC-48`） |
| `status`（scorecard 的） | submit | 本工具只产 `SUBMITTED`（`SC-26`） |

> 报错示例：`Error: INVALID_ARGS: {"code":"INVALID_ARGS","reason_code":"TENANT_OR_ACTOR_NOT_ALLOWED","message":"tenant_id 只能来自执行上下文，不接受入参","detail":{"rejected_keys":["tenant_id"],"allowed":["interview_id","rubric_version_id","items","overall","reject_reasons","revision","idempotency_key"]}}`

---

## 2. `recruitment_scorecard_submit`

### 2.1 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `interview_id` | string | ✅ | UUID | 面评归属的面试（**轮次由它决定**，`SC-06/07`） |
| `rubric_version_id` | string | 条件 | UUID | **仅当** `application.rubric_version_id` 为空时必填（`SC-10`） |
| `items` | **object** | ✅ | 键数 **1..50**（上限 = `R-VAL-1` 的 `dimensions` 上限，**不另设更小的常数**）；键集 = 维度 key ∪ `{transcript_basis}`，**恰好覆盖** | 逐维度评价（`SC-12/13`、`D-74`） |
| `items.transcript_basis` | string | ✅ | `TRANSCRIPT` \| `NO_TRANSCRIPT`；转写 `READY` 时必须 `TRANSCRIPT`，否则**必须** `NO_TRANSCRIPT` | 保留键（`TR-E2`）；`scorecard` 无该列（`TR §13 G-1`） |
| `items.<dimension_key>.assessment` | string | ✅ | `MET` \| `NOT_MET` \| `NOT_OBSERVED` \| `UNREADABLE` | 四态（`SC-31`、`scorecard-rules.md §4.5`） |
| `items.<dimension_key>.score` | integer | — | 1..5；`assessment ∈ {NOT_OBSERVED, UNREADABLE}` 时**必须缺省或 `null`** | 展示用，不进决策（`scorecard-rules.md` Q-2） |
| `items.<dimension_key>.note` | string | 条件 | ≤2000；`NOT_MET` 时必填 | 观察记录 |
| `items.<dimension_key>.evidence[]` | object[] | — | 0..20 项 | 证据 |
| `items.<dimension_key>.evidence[].kind` | string | ✅（有 evidence 时） | **仅有 `SEGMENT`**（`TRANSCRIPT_SEGMENT` 已作废，`D-74`/`TR-E3`） | — |
| `items.<dimension_key>.evidence[].transcript_artifact_id` `transcript_revision` `segment_id` `quote` | string/int/string/string | ✅ | `quote` 必须是转写原文片段（≤1000） | `D11 §9.9` |
| `overall` | string | ✅ | `ADVANCE` \| `HOLD` \| `REJECT` | 一句话结论（`scorecard-rules.md §4.6`；**列名就是 `overall`**，不是 `recommendation`） |
| `reject_reasons[]` | object[] | 条件 | `overall='REJECT'` 时 1..10 项 | `D11 §9.3` |
| `reject_reasons[].dimension_key` | string | ✅ | 必须是 `items` 里的一个**维度键**，且其 `assessment='NOT_MET'`（`SC-30`） | 具体哪一项 |
| `reject_reasons[].observation` | string | ✅ | 1..1000 | 现场观察到的具体表现 |
| `reject_reasons[].why_decisive` | string | ✅ | 1..1000 | 为什么这一项是决定性的 |
| `reject_reasons[].evidence[]` | object[] | — | 可空 | 同上 |
| `reject_reasons[].evidence_state` | string | 条件 | `evidence[]` 为空时**必填** `MEMORY_ONLY` | 显式承认凭记忆（`SC-32`） |
| `revision` | object | — | 修订时必填 | 见 §2.5 |
| `idempotency_key` | string | ✅ | 见 §1.5 | 仅本工具需要；`record` **不接受**（`D-80`） |

**不接受**（出现即 `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)`）：`interviewer_id`、`actor_id`、`tenant_id`、`round_no`、`slot_code`、`submitted_at`、`status`、`stage_code`。

> **为什么 `items` 是对象**：`interview/transcript-rules.md` TR-E2 与 `interview/tool-contracts.md` §2.3 已按 `items.transcript_basis` 读；对象还能天然检出"漏评一维"（缺键），数组要扫描且允许重复 key（`D-74`）。
>
> **为什么上限是 50 而不是 40**：`job-rubric-rules.md` §6.2 `R-VAL-1` 允许 `dimensions` 长度 **1–50**。契约再设一个 40 的上限，等于把"评不全"变成"契约允许评不全"——**上限只能有一个来源**。
>
> **为什么不收 `status`**：`WAIVED` 必须走独立人工命令（`SC-26`）；`PENDING` 本契约不产生（`scorecard-rules.md §6.2`）。

### 2.2 出参

```json
{
  "tool": "recruitment_scorecard_submit",
  "contract_version": "2.0.0",
  "status": "OK",
  "replayed": false,
  "labels": { "provenance": "LIVE", "trigger": "MANUAL", "connection": "CONNECTED" },
  "scorecard": {
    "id": "…", "revision_no": 1, "status": "SUBMITTED",
    "interview_id": "…", "interviewer_id": "…", "actor_id": "…",
    "rubric_version_id": "…", "rubric_payload_hash": "…",
    "rubric_resolution": "APPLICATION_PINNED",
    "transcript_basis": "TRANSCRIPT",
    "payload_hash": "…", "submitted_at": "2026-11-13T01:10:00+08:00",
    "status_changed_by_actor_id": "…", "status_source_event_id": "…",
    "record_version": 1
  },
  "interview": {
    "round_no": 1, "slot_code": "DEFAULT",
    "scheduled_start_at": "2026-11-12T14:00:00+08:00",
    "status": "POST_INTERVIEW"
  },
  "coverage": {
    "dimensions_total": 3,
    "dimensions_assessed": 3,
    "by_assessment": { "met": 1, "not_met": 1, "not_observed": 1, "unreadable": 0 }
  },
  "superseded": null,
  "warnings": [ { "code": "NO_TIMESTAMPED_EVIDENCE",
                  "message": "1 条 reject_reason 未附转写证据，已按 MEMORY_ONLY 记录" } ]
}
```

修订时 `superseded` 为 `{scorecard_id, revision_no}`；`scorecard.revision_no` = 旧值 + 1。

### 2.3 字段规则

| 字段 | 规则 | 依据 |
|---|---|---|
| `scorecard.id` | 恒为新 id（修订也是新 id，不是同 id 改内容） | `SC-18` |
| `scorecard.status` | 恒为 `SUBMITTED`（本工具不产生 `PENDING`/`WAIVED`） | `scorecard-rules.md §6.2`、`SC-26` |
| `scorecard.status_changed_by_actor_id` / `status_source_event_id` | **必填且非空**：终态行必须自带 actor 与内部事件（`SC-44`）。`INSERT` 不会触发 `fn_row_guard`（它只挂 `BEFORE UPDATE`），所以工具必须显式写这三列 + 先写 `event_inbox` 行。回显供机检 | `SC-44`；`0001:L1741-1767`；`0007` 在库层加拦截（`D-75` 第 5 条） |
| `scorecard.submitted_at` | **服务端时钟**，与 `created_at` 同值 | `SC-14/16` |
| `rubric_resolution` | `APPLICATION_PINNED` \| `EXPLICIT_VERSION_ID`（**没有 `JOB_CURRENT`**：面评绝不使用岗位当前版本） | `SC-09/10/11` |
| `coverage.dimensions_total` | 必须 = `jsonb_array_length(rubric_version.dimensions)`（**不含保留键** `transcript_basis`） | `SC-13` |
| `coverage.dimensions_assessed` | 必须 = `dimensions_total`（否则 `INVALID_ARGS(DIMENSION_COVERAGE_INCOMPLETE)`） | `SC-13` |
| `items` 的上限 | 维度数 1..50，与 `R-VAL-1` 一致；**本契约不设更小的上限** | `job-rubric-rules.md §6.2` |
| `warnings[]` | 不影响写入，但必须出现。封闭集见 §2.6 | — |
| `labels.provenance` | 按 §1.3 判定式算，**不因 FIXTURE 改判** | `R4` |

### 2.4 错误（**封闭集**）

| `code` | `reason_code` | 何时 |
|---|---|---|
| `INVALID_ARGS` | §5.1 的 `S-*` 一组 | 参数层 |
| `NOT_FOUND` | `INTERVIEW_NOT_FOUND` \| `RUBRIC_VERSION_NOT_FOUND` \| `APPLICATION_NOT_FOUND` | id 无行 |
| `INTERVIEWER_MISMATCH` | `ACTOR_NOT_INTERVIEWER` \| `ACTOR_NOT_HUMAN` | `SC-02/03` |
| `ALREADY_SUBMITTED` | `SCORECARD_ALREADY_SUBMITTED` \| `SCORECARD_ALREADY_SUPERSEDED` | 已有 current 行且未走 `revision`（`SC-04`）；或 `revision.supersedes_scorecard_id` 指向的不是当前行 |
| `VERSION_CONFLICT` | `RECORD_VERSION_MISMATCH` | 修订时 `expected_record_version` 不匹配（`SC-39`） |
| `EVIDENCE_INSUFFICIENT` | `REJECT_BASIS_UNREADABLE` \| `REJECT_REASON_NOT_BACKED` | `SC-30/31` |
| `DB_CONSTRAINT_VIOLATION` | `SCORECARD_IMMUTABLE` \| `UNIQUE_VIOLATION` \| `FK_VIOLATION` | 见 §5.3 |

### 2.5 修订（`revision` 对象）

```json
"revision": {
  "supersedes_scorecard_id": "…",
  "expected_record_version": 1,
  "revision_reason": "当时把 d2 判成 NOT_MET，回听录音后确认是我听错了"
}
```

| 规则 | 说明 |
|---|---|
| 三字段全必填 | 少一个 → `INVALID_ARGS(REVISION_FIELDS_INCOMPLETE)` |
| `supersedes_scorecard_id` 必须是**当前**行 | 不是 current → `ALREADY_SUBMITTED(SCORECARD_ALREADY_SUPERSEDED)` |
| 写入顺序 | **反向插 → 换指针 → 清空**（`scorecard-rules.md §5.2`）。顺序错必撞 `uq_scorecard_current`(23505) 或 `fk_scorecard_superseded_by`(23503) |
| 第 1 步的 `INSERT` | 那是**终态行**（`status='SUBMITTED'`）→ 必须同时写 `status_changed_by_actor_id` + `status_changed_at` + `status_source_event_id`（`SC-44`）。**`INSERT` 不触发 `fn_row_guard`**（它只挂 `BEFORE UPDATE`），漏写库不报错 |
| 已存在 `PENDING` 当前行（历史数据或别的路径留下） | **必须原地转正**：`UPDATE` 该行为 `SUBMITTED`（`old.status='PENDING'` 时 `fn_scorecard_guard` 不拦，`0001:L219`）。直接 `INSERT` 会撞 `uq_scorecard_current` **23505**——该索引**不看 status**（`0001:L1322-1323`） |
| 原地转正的那条 `UPDATE` **不是"一行就够"** | 它会触发 `fn_row_guard`：必须已在事务里 `SET LOCAL recruitment.actor_id`（否则 `ACTOR_REQUIRED` 23514），触发器**自己**会写一条 `event_inbox` 行、回填 `status_source_event_id`、并把 `record_version` 置为**旧值 + 1**。所以：`WHERE record_version = <旧值>`、出参回显**旧值 + 1**、**不要**手写 `record_version = record_version + 1`（`SC-45`） |
| 修订后不变量 | `current` 行数仍恰好 1，`revision_no` +1，旧行永在（禁删） |

### 2.6 `warnings[]` 封闭集

| `code` | 何时 |
|---|---|
| `NO_TIMESTAMPED_EVIDENCE` | 存在 `evidence_state='MEMORY_ONLY'`（`SC-32`） |
| `FIXTURE_BASIS` | `provenance='FIXTURE'` |
| `RUBRIC_EXPLICIT_NOT_PINNED` | `rubric_resolution='EXPLICIT_VERSION_ID'`（申请未钉版本，写侧应尽快补钉） |

> `CANCELLED` / `NO_SHOW` 的面试**不得**新增面评（`SC-08`）——那是**错误** `INVALID_ARGS(INTERVIEW_CANCELLED)`，不是 warning，不应出现在本表里。

### 2.7 正例

```text
recruitment_scorecard_submit {"interview_id":"0199…91","idempotency_key":"sc:iv91:X:1",
  "items":{"transcript_basis":"TRANSCRIPT",
           "backend_depth":{"assessment":"MET","score":4,"note":"…"},
           "system_design":{"assessment":"NOT_MET","score":1,"note":"…"},
           "collab":{"assessment":"NOT_OBSERVED"}},
  "overall":"REJECT",
  "reject_reasons":[{"dimension_key":"system_design",
     "observation":"给出的是一个单体 + 主从，追问容量估算时回避了两次",
     "why_decisive":"该维度是 MUST_HAVE，且已给两次澄清机会","evidence":[],
     "evidence_state":"MEMORY_ONLY"}]}
→ scorecard 0199…d1 rev=1 SUBMITTED  (labels: LIVE/MANUAL/CONNECTED)
  rubric v2 (APPLICATION_PINNED)  transcript_basis=TRANSCRIPT  3/3 维度已评：met=1 not_met=1 not_observed=1
  status_changed_by_actor_id=0199…a1  status_source_event_id=0199…e1
  warnings: NO_TIMESTAMPED_EVIDENCE
```

---

## 3. `recruitment_evaluation_summarize`

### 3.1 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `application_id` | string | ✅ | UUID | 汇总对象是**申请** |
| `decision_scope` | string | ✅ | `STAGE` \| `FINAL` \| `SCREENING`（SCREENING 是 **S7 写侧**：无 `interview_id`/`summary_digest`、`stage_code='S7'`，见 `decision-rules.md §17.1`；2026-11-14 起不再拒收） | 决定门禁口径（`DC-06`） |
| `interview_id` | string | 条件 | `STAGE` 必填；`FINAL` 必须缺省 | 指定汇哪一场 |
| `as_of` | string | ✅ **必填** | ISO-8601 带偏移，**不得晚于服务端 now** | 时间相关判定的**唯一**基准（逾期、审批）。**不设缺省**：缺省成 `now()` 会让同一输入在不同时刻算出不同 `overdue`/`summary_digest`（`D-16`、`SC-27`） |
| `require_complete` | boolean | — | 默认 `false` | `true` 且存在缺失 → 抛 `SCORECARD_MISSING`（供"决策前预检"用） |

**不接受**：`tenant_id`、`actor_id`、`interviewer_id`、`stage_code`、`round_no`。

### 3.2 出参

完整形状见 `decision-rules.md §3.2`（**那里是语义权威**）。本契约补充四条形状硬约束：

| # | 约束 | 机检 |
|---|---|---|
| 1 | `advisory` 恒 `true`，`read_only` 恒 `true`；`as_of` 原样回显 | 断言 |
| 2 | **不存在** `result` / `decided_by_actor_id` / `decided_at` / `recommended_result` / `overall_score` / `score` 这些键（任意层级） | 键名枚举扫描，命中即违约（`N-1`） |
| 3 | `aggregation.average ≠ null` **⟺** `coverage.missing = 0 ∧ coverage.submitted ≥ 1`；为 `null` 时 `average_refused_reason` 必须出现，取值：`missing > 0` → `MISSING_SCORES`；`submitted = 0` → `NO_SUBMITTED_SCORECARD` | 断言 **M-1（完整形态，见 §7.0）**（`DC-04`） |
| 4 | `permitted_results[]` 必须是 §3.5 表格的**计算值**，不得是常量 | 断言 |
| 5 | `coverage.submitted + coverage.waived + coverage.missing = coverage.required_total` ∧ `coverage.unusable ≤ coverage.missing` ∧ `coverage.unusable = DB 里"current 且 status='SUBMITTED' 但形状不合法"的行数` | 断言 M-3 |

### 3.3 字段规则

| 字段 | 规则 | 依据 |
|---|---|---|
| `coverage.required_total` | = `count(interviewer where required_scorecard=true)` 的**并集**（`FINAL` 时跨全部面试的并集） | `SC-21` |
| `coverage.submitted` / `waived` / `missing` | 三者之和必须 = `required_total`。**`submitted` 只算形状校验通过的**（`§3.4`） | `SC-21`；`§3.4` |
| `coverage.unusable` | `missing` 的**子集**：有 current `SUBMITTED` 但形状不合法的人数。**它不另占一个桶**（否则 `submitted+waived+missing` 就不等于 `required_total`） | `§3.4`；断言 M-3 |
| `coverage.not_required` | `required_scorecard=false`（含 `role_in_interview='OBSERVER'`）的面试官交的**可用**面评数。**不进分母、不进 `tally`**，只做透明计数 | `SC-46` |
| `coverage.overdue` | `missing` 中 `scorecard_due_at < as_of` 的个数。**`as_of` 必填，不取 `now()`** | `SC-27` |
| `missing[]` | 每项 `{interviewer_id, actor_id, round_no, slot_code, scorecard_due_at, overdue}`。**不含任何"进行中"信息** | `SC-35` |
| `tally` | 只统计 **`required_interviewers`** 的、**形状合规**的、**当前**行：`status='SUBMITTED'` 计入 `a/h/r`，`status='WAIVED'` 计入 `w`。`a+h+r = submitted`，`w = waived` | `DC-02`；`SC-46`（observer 不得计入） |
| `consensus` / `consensus_scope` | 按 `decision-rules.md §3.3` 的公式 | `DC-01` |
| `minority_reports[]` | 少数派**原文**（`reject_reasons[]` 完整带出） | `DC-03` |
| `aggregation.method` | `PER_DIMENSION_SUBMITTED_ONLY`（`submitted ≥ 1`，逐维度均值只在已提交上算）\| `NOT_COMPUTED`（`submitted = 0`，**含全豁免**）。**永不出现"总分/综合得分"** | `SC-24` |
| `aggregation.average` | `null` 当 `missing > 0` **或** `submitted = 0`；否则可为数值 | `SC-24`；M-1 |
| `aggregation.average_refused_reason` | `MISSING_SCORES` \| `NO_SUBMITTED_SCORECARD`（封闭二值）；`average ≠ null` 时必须缺省 | M-1 |
| `aggregation.per_dimension[].denominator` | 该维度**已提交且合规**的面评数 | `SC-22` |
| `aggregation.per_dimension[].excluded` | 该维度因缺失/豁免/形状不合法/非必填而被排除的人数（`denominator + excluded = required_total`） | `SC-22`；M-3 |
| `record.state` | `READY` \| `NOT_READY` \| `ABSENT` \| `NOT_CITED`（`DC-23`） | `0001:L1228` |
| `ready_for_decision` | `missing=∅` ∧ **`submitted ≥ 1`** ∧ 无 `blocks_all=true` 的 blocker。**`submitted` 那一项不能省**：全豁免时 `missing=∅`，但 `ADVANCE` 仍被 `NO_SUBMITTED_SCORECARD` 挡住——否则会出现"`ready_for_decision=true` 而 `permitted_results` 里没有 `ADVANCE`"的自相矛盾 | §3.5；`decision-rules.md §4.2.1` |
| `blockers[]` | `{code, family, blocks_results[], detail}`；**空数组表示没有阻断** | §3.5 |
| `permitted_results[]` | 见 §3.5 | `DC-47` |
| `required_human_action` | 封闭枚举：`SUPERSEDE_EXISTING_DECISION` > `RESOLVE_BLOCKER` > `RESOLVE_UNREADABLE` > `CHASE_SCORECARD` > `CONFIRM_DECISION`（按此优先级取一） | 与 `screening-rules.md §9` 同一手法 |
| `snapshot` | `{application_record_version, rubric_version_id, rubric_payload_hash, scorecard_ids[]}` | `DC-20` |
| `summary_digest` | 按 `DC-20` 的固定子集算 `sha256`，小写 hex（子集**含 `as_of`**） | `DC-20` |
| `brief` | 按 `DC-41..46`；不满足时 `null` + `brief_absence.code` | `DC-41` |

### 3.4 `items` 形状的**二次校验**（本工具是最后一道门）

面评 `items` 的形状库不校验（`0001:L1314-1315`），所以汇总必须再校验一遍；不合法 → `warnings: SCORECARD_SHAPE_INVALID` 且该面评**从 `tally` 中剔除**：`coverage.submitted` **不计它**，它落进 `coverage.unusable`（`⊆ missing`，理由不是"没交"而是"这份不可用"），并在 `blockers` 加 `{code:'SCORECARD_UNUSABLE', family:'COVERAGE', blocks_all:false, blocks_results:['REJECT','HIRED']}`。

校验项（与 `scorecard-rules.md` §4.4/§4.6 一致）：`items` 是**对象**（不是数组）且键集 = 维度 ∪ `{transcript_basis}`、`assessment` 四态封闭、`overall` 三值封闭、`REJECT` 必有 `reject_reasons` 且每条 `dimension_key` 是 `NOT_MET` 的维度、`ADVANCE` 不含 `NOT_OBSERVED`/`UNREADABLE`、`transcript_basis='NO_TRANSCRIPT'` 时不得出现 `kind='SEGMENT'`（`TR-E3`）。

> **这条为什么必须放在读侧**：`SCORECARD_SHAPE_INVALID` 只在**历史行**或**别的写入路径**上出现（正常提交已被写侧拦住）。读侧不校验，就会让一份形状坏掉的面评影响票数。
>
> **为什么机检必须容忍它**（`H7`）：形状不合法的行**仍然**是 DB 里 `status='SUBMITTED'` 的行。若断言直接拿 `select count(*) ... where status='SUBMITTED'` 去比 `tally` 总和，就会把"被正确剔除"判成"票数不符"。**正确做法**：先把 `unusable` 减掉，或用 `coverage.submitted`（它已经是剔除后的数）——见 §7.0 的 M-2 说明。

### 3.5 门禁与 `permitted_results` 的计算（**唯一权威表**）

`result` 的允许性（`T = tally`，`M = missing`）：

| 结果 | 条件 | 不满足时 |
|---|---|---|
| `HIRED` | **永不**（v1.0） | `INVALID_ARGS(RESULT_NOT_IN_V1_SCOPE)`（STEP 0 就拦） |
| `WITHDRAW` | **恒允许**（不受 `M`、不受 `submitted=0`、不受"没有 SCORECARD basis"影响） | — |
| `HOLD` | **恒允许**（同上） | — |
| `ADVANCE` | **先决：`submitted ≥ 1`**（零提交 → `EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)`）。`scope=STAGE`：恒允许（`M≠∅` 时需 `PROCEED_WITH_MISSING` + 逐条 `acknowledged_missing`）<br>`scope=FINAL`：`M=∅`，且 `T.reject>0` 时需 dissent 确认。**`acknowledged_missing` 不放行 FINAL**（`§4.2.1`） | `SCORECARD_MISSING` / `EVIDENCE_INSUFFICIENT` |
| `REJECT` | **先决：`submitted ≥ 1`**。`M=∅` ∧ ∃ 面评 `overall='REJECT'`（或 `SCREENING_DECISION` 反证，`DC-27` 例外）；`consensus` 为 ADVANCE 方向时另需 dissent 确认（`DC-28`） | `SCORECARD_MISSING` / `EVIDENCE_INSUFFICIENT` |

`blockers[]` 的 `code` 与后果（**封闭集**）：

| `code` | `family` | `blocks_results[]` | 错误码映射 |
|---|---|---|---|
| `SCORECARD_MISSING` | `COVERAGE` | `['REJECT','HIRED']`（`FINAL` 时全部） | `SCORECARD_MISSING(REQUIRED_SCORECARDS_INCOMPLETE)`。**只在 `missing > 0` 时出现**；`submitted=0 且 missing=0`（全豁免）**不产生它**，那种情况由下一条 `NO_SUBMITTED_SCORECARD` 负责 |
| `NO_SUBMITTED_SCORECARD` | `EVIDENCE` | `['ADVANCE','REJECT','HIRED']`（**`submitted=0` 时恒出现**；`WITHDRAW`/`HOLD` 不受它影响） | `EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)` |
| `SCORECARD_UNUSABLE` | `COVERAGE` | `['REJECT','HIRED']` | `EVIDENCE_INSUFFICIENT(SCORECARD_SHAPE_INVALID)` |
| `NO_REJECTING_SCORECARD` | `EVIDENCE` | `['REJECT']` | `EVIDENCE_INSUFFICIENT(REJECT_WITHOUT_REJECTING_SCORECARD)` |
| `UNREADABLE_NOT_RESOLVED` | `EVIDENCE` | `['REJECT']` | `BLOCKED_BY_REVIEW(REJECT_BASIS_UNREADABLE)` |
| `OPEN_REVIEW_TASK` | `QUEUE` | **全部** | `BLOCKED_BY_REVIEW(OPEN_REVIEW_TASK)` |
| `RECORD_NOT_VERIFIED` | `EVIDENCE` | 仅当决策引用 record | `BLOCKED_BY_REVIEW(RECORD_NOT_VERIFIED)` |
| `ALREADY_DECIDED` | `STATE` | **全部**（带 supersedes 时解除） | `ALREADY_DECIDED(SCOPE_ALREADY_DECIDED)` |

`permitted_results[]` = `['ADVANCE','HOLD','WITHDRAW','REJECT']` 减去被阻断者，**顺序固定**（便于断言）。

> **`WITHDRAW` / `HOLD` 永远是最后留下的两个**：它们只被 `OPEN_REVIEW_TASK` / `ALREADY_DECIDED` 这类"程序上现在不能写"的阻断挡住，**不被 `SCORECARD_MISSING` / `SCORECARD_UNUSABLE` / `NO_SUBMITTED_SCORECARD` 挡住**（`decision-rules.md §4.2.1`：缺面评与零面评都不影响这两项）。`submitted=0` 时 `permitted_results` 至少含 `['HOLD','WITHDRAW']`。

### 3.6 只读与确定性

| 性质 | 要求 | 依据 |
|---|---|---|
| 只读 | 源码不出现 `INSERT`/`UPDATE`/`DELETE`/`fs`/`fetch`/子进程 | `CONTRACT.md §6` 口径 |
| 无时钟 | 输出不含 `generated_at`/`now`；`as_of` 原样回显 | `screening-rules.md §11 D-1` |
| 幂等 | 同一 `(args, 数据快照)` → 除 `summary_digest` 外逐字节相同（digest 也相同，只要快照相同） | `D-16` |
| 并发安全 | 声明 `isConcurrencySafe: true`（纯读） | — |
| 不清队列 | 不把任何 `business_task` 改成别的状态（清队列是人的动作） | `screening-rules.md §6.4` 同构 |

### 3.7 错误（**封闭集**）

| `code` | `reason_code` | 何时 |
|---|---|---|
| `INVALID_ARGS` | §5.1 的通用组 + `D-` 组的 scope 三条（`STAGE_REQUIRES_INTERVIEW` / `FINAL_SCOPE_NO_INTERVIEW` / `DECISION_SCOPE_NOT_S10`）+ `AS_OF_IN_FUTURE` | 参数层 |
| `NOT_FOUND` | `APPLICATION_NOT_FOUND` \| `INTERVIEW_NOT_FOUND` \| `RUBRIC_VERSION_NOT_FOUND` | — |
| `SCORECARD_MISSING` | `REQUIRED_SCORECARDS_INCOMPLETE` | **仅当** `require_complete=true`（`§3.1`）。默认不抛——**汇总的职责就是报告缺** |

### 3.8 正例（C1 夹具）

```text
recruitment_evaluation_summarize {"application_id":"0199…71","decision_scope":"STAGE",
  "interview_id":"0199…91","as_of":"2026-11-13T01:00:00+08:00"}
→ advisory=true read_only=true  as_of=2026-11-13T01:00:00+08:00   rubric v2 (APPLICATION_PINNED)  (labels: LIVE/MANUAL/CONNECTED)
  coverage 3 required = 2 submitted + 0 waived + 1 missing (unusable=0, not_required=0, 1 overdue)
    missing: interviewer 0199…92 (round 1/DEFAULT, due 2026-11-12T12:00+08:00, overdue)
  tally advance=2 hold=0 reject=0 waived=0
  consensus UNANIMOUS_ADVANCE (PARTIAL_PANEL)
  aggregation PER_DIMENSION_SUBMITTED_ONLY  average=null (MISSING_SCORES)
  ready_for_decision=false
  blockers [SCORECARD_MISSING → blocks REJECT,HIRED]
  permitted_results [ADVANCE, HOLD, WITHDRAW]
  required_human_action CHASE_SCORECARD
  brief null (NO_DECISION)
```

---

## 4. `recruitment_decision_record`

### 4.1 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `application_id` | string | ✅ | UUID | — |
| `decision_scope` | string | ✅ | `STAGE` \| `FINAL` | `DC-06` |
| `interview_id` | string | 条件 | `STAGE` 必填 / `FINAL` 禁止 | `DC-06` |
| `as_of` | string | ✅ **必填** | ISO-8601 带偏移，不得晚于服务端 now；**必须与 `summarize` 那次用的 `as_of` 相同**，否则重算出的 `summary_digest` 必然不等 → `SUMMARY_STALE` | `DC-16`/`DC-20`（`as_of` 进 digest 子集） |
| `result` | string | ✅ | `ADVANCE` \| `HOLD` \| `REJECT` \| `WITHDRAW`（`HIRED` → `INVALID_ARGS`） | **人做出的结论** |
| `reason` | string | ✅ | 1..4000；`REJECT` 时必须含至少一个 `dimension_key`（`DC-18`） | **人写的理由** |
| `basis_refs[]` | object[] | ✅ | 1..200；`kind` 必须 ∈ `decision-rules.md` §6.1 的 9 种 | 依据（`DC-12/13`） |
| `summary_digest` | string | ✅ | 64 hex，必须 = 本次重算值 | 绑汇总（`DC-16`） |
| `human_confirmation` | object | ✅ | §4.2 | **人工确认标记** |
| `missing_disposition` | string | 条件 | `PROCEED_WITH_MISSING`（`missing≠∅` 且 `result='ADVANCE'` **且 `scope='STAGE'`** 时必填；`FINAL` 不接受它 → `MISSING_ACK_REQUIRED` 不适用，直接 `SCORECARD_MISSING`） | `§4.2` 矩阵、§4.2.1 |
| `acknowledged_missing[]` | object[] | 条件 | 同上（**只对 `ADVANCE(STAGE)` 有效**）；元素集合必须与 `missing[].interviewer_id` 集合**完全相等**（不重复、不多不少） | 逐条确认缺谁 |
| `acknowledged_missing[].interviewer_id` | string | ✅ | UUID | 缺的那位 |
| `acknowledged_missing[].why_proceed` | string | ✅ | 1..1000 | 为什么可以不等人 |
| `acknowledged_dissent` | boolean | 条件 | 结论与 `consensus` 相反时必填 `true` | `DC-28` |
| `override_rationale` | string | 条件 | 同上，非空；**进 `confirmation_text_sha256` 的 pre-image**（`DC-11`） | `DC-28/29` |
| `supersedes` | object | — | `{decision_id, reason, expected_record_version}` | 撤回/重开（`§8`） |
| `approval_id` | string | — | UUID；v1.0 建议不给（`G-3`） | `DC-19` |

**不接受**：`decided_by_actor_id`、`decided_at`、`tenant_id`、`actor_id`、`stage_code`、**`idempotency_key`**（`D-80`：v1.0 不做客户端幂等，键不在 schema 里 → `INVALID_ARGS(UNKNOWN_PARAM)`）。

### 4.2 `human_confirmation`（**这是"必须人工"的落点**）

```json
"human_confirmation": {
  "confirmed_by_actor_id": "…",
  "confirmed_at": "2026-11-13T01:20:00+08:00",
  "confirmation_method": "IN_APP_CONFIRM",
  "confirmation_text_sha256": "…"
}
```

| 校验 | 不通过 → |
|---|---|
| 四字段齐全 | `DECISION_REQUIRES_HUMAN(NO_HUMAN_CONFIRMATION)` |
| `confirmed_by_actor_id` = 上下文 actor | `DECISION_REQUIRES_HUMAN(CONFIRMATION_SUBJECT_MISMATCH)` |
| 上下文 actor `kind='HUMAN'` | `DECISION_REQUIRES_HUMAN(DECIDER_NOT_HUMAN)` |
| `confirmation_text_sha256` = 服务端对 `canonical_json({result, reason, override_rationale, basis_refs})` 的 hash（四个键**必须都在**；`override_rationale` 未给时写 `null`，**不省略键**） | `DECISION_REQUIRES_HUMAN(CONFIRMATION_TEXT_MISMATCH)` |
| `confirmed_at` 与 `decided_at` 相差 ≤ 24h，且 `≤ decided_at` | `DECISION_REQUIRES_HUMAN(CONFIRMATION_STALE)` |

> **`confirmation_text_sha256` 的作用**：证明"人确认的是**这一版**结论与理由"。否则"点了个确认，随后理由被改写"无法发现——这正是 `approval` 表用 `canonical_payload_hash` 解决过的问题（`0001:L421-423`）。
>
> **为什么 `override_rationale` 必须进 hash**（`H6`）：它是"反着来"的**唯一**理由（`DC-28/29`）。若不进 hash，人确认时 `override_rationale` 为空、落库前被程序塞一段"看起来很合理"的理由，`approval` 式的留痕就变成了可后补的装饰。口径：**hash 覆盖人看到的全部内容**，包括那条理由。

### 4.3 出参

```json
{
  "tool": "recruitment_decision_record",
  "contract_version": "2.0.0",
  "status": "OK",
  "replayed": false,
  "labels": { "provenance": "LIVE", "trigger": "MANUAL", "connection": "CONNECTED" },
  "decision": {
    "id": "…", "application_id": "…", "interview_id": "…",
    "decision_scope": "STAGE", "stage_code": "S10", "result": "ADVANCE",
    "decided_by_actor_id": "…", "decided_at": "2026-11-13T01:20:00+08:00",
    "record_version": 1, "superseded_by_decision_id": null
  },
  "gate": {
    "as_of": "2026-11-13T01:00:00+08:00",
    "ready_for_decision": false,
    "missing_disposition": "PROCEED_WITH_MISSING",
    "acknowledged_missing": [ { "interviewer_id": "…92",
                               "why_proceed": "该面试官负责的维度已由 X/Y 交叉覆盖，且下一轮会补" } ],
    "permitted_results_echo": ["ADVANCE", "HOLD", "WITHDRAW"],
    "summary_digest": "9c1e…"
  },
  "superseded": null,
  "event": { "event_id": "…", "provider": "internal", "trust_level": "INTERNAL" },
  "warnings": [
    { "code": "DECIDER_NOT_HIRING_MANAGER",
      "message": "决策人不是该部门的招聘负责人；v1.0 不拦截，仅记录" },
    { "code": "PROCEEDED_WITH_MISSING_SCORECARDS",
      "message": "1 份必填面评缺失（面试官 0199…92，已逾期），已逐条确认" }
  ]
}
```

撤回时 `superseded = {decision_id: 旧行, record_version: 旧行新版本}`。

### 4.4 字段规则

| 字段 | 规则 | 依据 |
|---|---|---|
| `decision.stage_code` | **恒 `'S10'`**（工具写死，不受入参影响） | `DC-07` |
| `decision.decided_by_actor_id` | = 上下文 actor（同时 = `confirmed_by_actor_id`） | `DC-10`（库 §4.2 校验） |
| `decision.decided_at` | 服务端时钟 | `DC-48` |
| `decision.record_version` | 新行为 1；撤回时旧行 `+1`、新行为 1 | `DC-39` |
| `gate.ready_for_decision` | 必须与 `summarize` 同参数下的返回值一致（**同一个函数**，不是第二份实现） | `DC-16` |
| `basis_refs` 落库 | **逐字**写入 `decision.basis_refs`，不裁剪、不改写 | `INV-9` |
| `event` | 每次写入**必须**有（含撤回），`provider='internal'`、`trust_level='INTERNAL'`、`idempotency_key='decision:'\|\|id`、`idempotency_source='FALLBACK_KEY'`、`source_object_id=id`、`provider_event_id=NULL`。**这个键是 `event_inbox` 的必填列，不是客户端幂等承诺**（`D-80`；`N07` 要求 `FALLBACK_KEY` 绑 `source_object_id` 且不带 `provider_event_id`） | `DC-38`、`N07`、`D-80` |
| `warnings[]` | 封闭集见 §4.7 | — |

### 4.5 错误（**封闭集**）

| `code` | `reason_code` | 何时 |
|---|---|---|
| `INVALID_ARGS` | §5.1 的 `D-*` 一组 | 参数层（含 `SUMMARY_STALE`、`BASIS_REF_EMPTY`、`BASIS_KIND_FORBIDDEN`、`BASIS_TRANSCRIPT_STATE_MISSING`、`BASIS_AUTHORITY_MISMATCH`、`OVERRIDE_NOT_ACKNOWLEDGED`、`MISSING_ACK_REQUIRED`、`MISSING_ACK_MISMATCH`、`SUPERSEDE_*`、`UNKNOWN_PARAM`（含 `idempotency_key`）） |
| `NOT_FOUND` | `APPLICATION_NOT_FOUND` \| `INTERVIEW_NOT_FOUND` \| `RUBRIC_VERSION_NOT_FOUND` \| `DECISION_NOT_FOUND` \| `SCORECARD_NOT_FOUND` | 含 `basis_refs` 引用了不存在的行 |
| `SCORECARD_MISSING` | `REQUIRED_SCORECARDS_INCOMPLETE` | `REJECT` 带缺失 / `FINAL` 带缺失（`§4.2` 矩阵、§4.2.1）。**`acknowledged_missing` 不能把它变成放行** |
| `BLOCKED_BY_REVIEW` | `OPEN_REVIEW_TASK` \| `REJECT_BASIS_UNREADABLE` \| `UNREADABLE_NOT_RESOLVED` \| `RECORD_NOT_VERIFIED` | `blocking_items[]` **至少 1 项**，空数组 = 违约 |
| `DECISION_REQUIRES_HUMAN` | §4.2 五个 | — |
| `ALREADY_DECIDED` | `SCOPE_ALREADY_DECIDED` | 同 `(tenant_id, application_id, decision_scope, stage_code)` 已有 current 且未带 `supersedes`；**`0007` 之后由 23505 触发**（不靠 `FOR UPDATE`，`D-80`） |
| `EVIDENCE_INSUFFICIENT` | `REJECT_WITHOUT_REJECTING_SCORECARD` \| `SCORECARD_SHAPE_INVALID` \| `BASIS_RUBRIC_HASH_MISMATCH` \| **`NO_SUBMITTED_SCORECARD`** | `DC-27`；零提交时 `ADVANCE`/`REJECT` 恒被 `NO_SUBMITTED_SCORECARD` 挡（`decision-rules.md §4.2.1`） |
| `VERSION_CONFLICT` | `DECISION_RECORD_VERSION_MISMATCH` | 撤回时 `expected_record_version` 不匹配（`DC-39`） |
| `DB_CONSTRAINT_VIOLATION` | `DECISION_IMMUTABLE` \| `UNIQUE_VIOLATION` \| `FK_VIOLATION` | §5.3（**`uq_decision_current` 的 23505 必须映射成 `ALREADY_DECIDED`，不是兜底**） |

### 4.6 判定顺序（**必须照做**，与 `decision-rules.md §4.3` 一致）

```
STEP 0 参数（含 HIRED 禁用、scope/interview 互斥、as_of 必填、idempotency_key 不在 schema）
STEP 1 身份 + human_confirmation 四校验（hash pre-image 含 override_rationale）
STEP 2 存在性（应用/面试/rubric/basis_refs 指向的行）
STEP 3 已存在 current 同类决策 → ALREADY_DECIDED（带 supersedes 则走撤回校验）
STEP 4 重算汇总（同一个 as_of），比对 summary_digest → SUMMARY_STALE
STEP 5 阻断检查（open review task / unreadable / record）
STEP 6 结果门禁（§3.5 矩阵 + DC-21..DC-29 + 零提交 NO_SUBMITTED_SCORECARD）
STEP 7 写入 + 内部事件（带版本条件；0007 之后 23505 → ALREADY_DECIDED）
```

### 4.7 `warnings[]` 封闭集

| `code` | 何时 |
|---|---|
| `DECIDER_NOT_HIRING_MANAGER` | `is_hiring_manager=false`（`DC-14`） |
| `HIRING_MANAGER_UNSET` | `department.hiring_manager_actor_id` 为空 |
| `PROCEEDED_WITH_MISSING_SCORECARDS` | `missing_disposition='PROCEED_WITH_MISSING'` |
| `MINORITY_DISSENT` | `minority_reports[]` 非空 |
| `OVERRIDE_APPLIED` | `result` 与 `consensus` 相反 |
| `REJECT_BASIS_MEMORY_ONLY` | 拒绝依据 `evidence_state='MEMORY_ONLY'`（`DC-22`） |
| `FIXTURE_BASIS` | `provenance='FIXTURE'` |
| `SUPERSEDES_APPLIED` | 本次是撤回/重开 |
| `APPROVAL_ATTACHED` | 给了 `approval_id` 且已按 `DC-19` 校验通过（v1.0 不要求，仅记录） |

### 4.8 正例（C2 夹具 + 反着来）

```text
recruitment_decision_record {"application_id":"0199…71","decision_scope":"STAGE",
 "interview_id":"0199…91","as_of":"2026-11-13T01:00:00+08:00","result":"REJECT",
 "reason":"system_design 维度两次澄清后仍未给出容量估算，且该维度是 MUST_HAVE",
 "basis_refs":[{"kind":"SUMMARY","…":"…"},{"kind":"RUBRIC_VERSION","…":"…"},{"kind":"AUTHORITY","actor_id":"…","is_hiring_manager":false},
               {"kind":"SCORECARD","overall":"REJECT","transcript_basis":"TRANSCRIPT","transcript_state":"READY","…":"Z 的 rejecting scorecard，reject_reasons 原文"},
               {"kind":"OVERRIDE","acknowledged_dissent":true,"override_rationale":"…"}],
 "summary_digest":"9c1e…",
 "human_confirmation":{"confirmed_by_actor_id":"…","confirmed_at":"…","confirmation_method":"IN_APP_CONFIRM","confirmation_text_sha256":"…"},
 "acknowledged_dissent":true,"override_rationale":"两位面试官通过，但硬性维度有明确反证，我按标准拒"}
→ decision 0199…d1 STAGE REJECT  (labels: LIVE/MANUAL/CONNECTED)
  gate ready=true  permitted [ADVANCE,HOLD,REJECT,WITHDRAW]
  warnings MINORITY_DISSENT / OVERRIDE_APPLIED / DECIDER_NOT_HIRING_MANAGER
  event 0199…e1 (internal/INTERNAL)
```

---

## 5. 错误码总表（**10 + 1，封闭集**）

### 5.1 `INVALID_ARGS` 的 `reason_code`（按工具分组，全封闭）

| `reason_code` | 工具 | 含义 |
|---|---|---|
| `UNKNOWN_PARAM` | 三个 | 出现未声明的键（`allowed[]` 列出允许键） |
| `TYPE_MISMATCH` | 三个 | 类型不对 |
| `MISSING_REQUIRED` | 三个 | 必填缺失 |
| `OUT_OF_RANGE` | 三个 | 超闭区间 / 超 `maxLength` |
| `ENUM_INVALID` | 三个 | 不在枚举内（`allowed[]` 列出取值） |
| `MUTUALLY_EXCLUSIVE` | 三个 | 互斥键同时给 |
| `ID_NOT_UUID` | 三个 | id 不是 UUID |
| `TENANT_OR_ACTOR_NOT_ALLOWED` | 三个 | 传了 `tenant_id`/`actor_id`/`interviewer_id`/`decided_by_actor_id` |
| `AS_OF_IN_FUTURE` | summarize / record | `as_of > now`（`as_of` 是**必填**；缺 → `MISSING_REQUIRED`） |
| **`S-` 组** | **submit** | `DIMENSION_COVERAGE_INCOMPLETE` / `DIMENSION_NOT_IN_RUBRIC` / `DIMENSION_DUPLICATED` / `ASSESSMENT_SCORE_CONFLICT` / `NOT_MET_NOTE_MISSING` / `REJECT_REASON_INCOMPLETE` / `REJECT_REASON_NOT_BACKED` / `REJECT_EVIDENCE_UNDECLARED` / `ADVANCE_WITH_UNASSESSED_DIMENSION` / `ADVANCE_WITHOUT_BASIS` / `INTERVIEW_CANCELLED` / `RUBRIC_UNRESOLVED` / `RUBRIC_MISMATCH` / **`RUBRIC_NOT_OF_JOB`** / **`TRANSCRIPT_BASIS_MISSING`** / **`TRANSCRIPT_BASIS_CONFLICT`** / `PAYLOAD_NOT_CANONICAL` / `IDEMPOTENCY_KEY_REUSED` / `REVISION_FIELDS_INCOMPLETE` / `RUBRIC_NOT_PARSABLE` |
| **`D-` 组** | **record** | `STAGE_REQUIRES_INTERVIEW` / `FINAL_SCOPE_NO_INTERVIEW` / `DECISION_SCOPE_NOT_S10` / `STAGE_CODE_NOT_S10` / `RESULT_NOT_IN_V1_SCOPE` / `SUMMARY_STALE` / `BASIS_REF_EMPTY` / `BASIS_KIND_FORBIDDEN` / **`BASIS_TRANSCRIPT_STATE_MISSING`** / **`BASIS_AUTHORITY_MISMATCH`** / `DECISION_REASON_NO_DIMENSION` / `OVERRIDE_NOT_ACKNOWLEDGED` / `MISSING_ACK_REQUIRED` / `MISSING_ACK_MISMATCH` / `SUPERSEDE_LINK_CANNOT_BE_CLEARED` / `SUPERSEDE_LINK_ALREADY_SET` / `SUPERSEDE_TARGET_MISMATCH` / `APPROVAL_BINDING_INVALID`（**`IDEMPOTENCY_KEY_REUSED` 已从本组删除**：`record` 不接受幂等键，`D-80`） |

> `S-` / `D-` 只是**分组前缀**，不是错误码；消息里 `reason_code` 的值就是上表右侧那个字符串。
>
> **新增三个 `reason_code` 的来由**：`RUBRIC_NOT_OF_JOB`（`SC-47`：rubric 必须属于该申请岗位）；`TRANSCRIPT_BASIS_MISSING` / `TRANSCRIPT_BASIS_CONFLICT`（`TR-E2`/`TR-E3`：保留键必填、`NO_TRANSCRIPT` 不得带 `SEGMENT` 证据）；`BASIS_TRANSCRIPT_STATE_MISSING`（`TR-E7`）；`BASIS_AUTHORITY_MISMATCH`（`DC-14`：`is_hiring_manager` 由服务端计算，入参不一致必须报错而不是静默覆盖）。

### 5.2 状态与门禁类（5 个必须有的 + 4 个辅助；`INVALID_ARGS` 见 §5.1）

| `code` | 谁会用 | 语义 |
|---|---|---|
| `NOT_FOUND` | 三个 | 目标不存在 |
| `SCORECARD_MISSING` | record（+ summarize 仅当 `require_complete`） | 必填面评缺失 |
| `BLOCKED_BY_REVIEW` | record | 现在不该判（队列 / 未澄清 unreadable / 未校验 record） |
| `DECISION_REQUIRES_HUMAN` | record | 人工确认标记不成立 |
| `ALREADY_DECIDED` | record | 已有 current 同类决策 |
| `ALREADY_SUBMITTED` | submit | 已有 current 面评 |
| `INTERVIEWER_MISMATCH` | submit | 提交者不能成为该面评作者 |
| `EVIDENCE_INSUFFICIENT` | submit / record | 依据不足（含 unreadable 当依据） |
| `VERSION_CONFLICT` | submit / record | 乐观并发失败 |

### 5.3 `DB_CONSTRAINT_VIOLATION`（**兜底，不是逃生门**）

| 规则 | 说明 |
|---|---|
| 只在数据库抛出 `23505` / `23514` / `23503` 时使用 | `detail` 必须含 `sqlstate` + `constraint`（逐字取自库） |
| **治理规则**：一旦出现，说明契约没覆盖到 → 必须**补契约**，**不得**改库去迁就实现（`D-32`） | 同 `SC-20`（不得降低证据标准） |
| 已知会出现的四种 | `SCORECARD_IMMUTABLE`（并发修订）、`DECISION_IMMUTABLE`（试图改决策内容）、`UNIQUE_VIOLATION`（并发提交撞 `uq_scorecard_current`）、`uq_decision_current`（**`0007` 之后**，并发重复决策） |
| **唯一的"不是兜底"的 23505** | `0007` 的 `uq_decision_current` 冲突**必须**映射成 `ALREADY_DECIDED(SCOPE_ALREADY_DECIDED)`，**不得**报成 `DB_CONSTRAINT_VIOLATION`——这是 `D-80` 指定的并发防线（库层索引），不是"契约没覆盖"

### 5.4 `BLOCKED_BY_REVIEW` 的错误体（`blocking_items[]` **不得为空**）

```text
Error: BLOCKED_BY_REVIEW: {"code":"BLOCKED_BY_REVIEW","reason_code":"REJECT_BASIS_UNREADABLE","family":"EVIDENCE","message":"拒绝依据落在读不出的维度上，必须先进人工澄清","detail":{"application_id":"0199…71","blocking_items":[{"code":"REJECT_BASIS_UNREADABLE","family":"EVIDENCE","interviewer_id":"0199…92","dimension_key":"d2","assessment":"UNREADABLE","scorecard_id":"0199…d1"}]}}
```

> 键序：`code` → `reason_code` → `family` → `message` → `detail`（§1.2）。整行可 `JSON.parse`（`…` 都在字符串里，不影响解析）。

---

## 6. 三个工具共同的 6 条（与 `decision-rules.md` §10 对应）

| # | 绝不 | 机检 |
|---|---|---|
| 1 | 不代决（`summarize` 无 `result`/`recommended_result`/`overall_score`） | 键名扫描 |
| 2 | 不用缺失面评算分 | 断言 M-1/M-2/M-3 |
| 3 | 不用 `unreadable` 拒绝人 | 断言 A2（删掉全部 `unreadable` 依据后 `REJECT` 仍成立） |
| 4 | 不改任何状态 | 调用前后 `application.record_version` / `interview.record_version` 不变 |
| 5 | 不输出恒真权限字段 | 输出里 grep `can_` 得 0 |
| 6 | 不在输出里放墙钟（写工具只放自己那一列 `submitted_at`/`decided_at`） | `summarize` 输出里 grep `generated_at` / `evaluated_at` / `now` 得 0；允许 `as_of` 与数据自带时间列（`scorecard_due_at`、`submitted_at`）**原样回显** |

---

## 7. 验收清单（可直接执行）

### 7.0 四个机检断言（三份文档共用编号）

| 编号 | 断言 | 对应规则 |
|---|---|---|
| **M-1** | **完整形态（下面的 ⇔ 才是对的，`missing>0` 只是其中一半）**：`aggregation.average ≠ null` **⟺** `coverage.missing = 0 ∧ coverage.submitted ≥ 1`。为 `null` 时 `average_refused_reason` 必须出现，且 `missing > 0` → `MISSING_SCORES`、`submitted = 0`（**含全豁免**）→ `NO_SUBMITTED_SCORECARD` | `DC-04`、`SC-24` |
| **M-2** | `tally.advance + tally.hold + tally.reject == coverage.submitted` ∧ `tally.waived == coverage.waived`。**容忍"形状不合法"的读法**：`coverage.submitted` 是**形状校验通过**的面评数，**不是** `select count(*) from scorecard where status='SUBMITTED' and superseded_by_scorecard_id is null`。形状不合法的行**必须**先被剔除（它们进 `coverage.unusable`，不在这里），否则断言会假红/假绿 | `DC-02`、`SC-23`、`SC-46` |
| **M-3** | 每个 `aggregation.per_dimension[]` 满足 `denominator + excluded == coverage.required_total`；且 `coverage.submitted + coverage.waived + coverage.missing == coverage.required_total` ∧ `coverage.unusable ≤ coverage.missing` ∧ `coverage.unusable == DB 侧"current 且 `SUBMITTED` 但形状不合法"的**面试官**数` | `SC-22`、`DC-04` |
| **A2** | `result='REJECT'` 时，删掉所有 `assessment ∈ {UNREADABLE, NOT_OBSERVED}` 的依据后，**仍至少剩 1 条 `NOT_MET` 依据**（即 `REJECT` 不依赖任何读不出的东西） | `DC-24`、`SC-31` |

### 7.1 形状层

| # | 检查 | 期望 |
|---|---|---|
| 1 | 三个工具 `parameters` 都 `additionalProperties: false` | 未知键 → `INVALID_ARGS(UNKNOWN_PARAM)` 且 `allowed[]` 非空 |
| 2 | `submit` 传 `interviewer_id` / `decided_by_actor_id` / `tenant_id` | `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)` |
| 3 | `interview_id="iv_0001"` | `INVALID_ARGS(ID_NOT_UUID)` |
| 4 | `record` 传 `result="HIRED"` | `INVALID_ARGS(RESULT_NOT_IN_V1_SCOPE)` |
| 5 | `record` 传 `stage_code` | `INVALID_ARGS(UNKNOWN_PARAM)`（键都不存在） |
| 6 | `summarize` 传 `decision_scope="SCREENING"` | `INVALID_ARGS(DECISION_SCOPE_NOT_S10)`（**summarize 仍只服务 S10**；SCREENING 决策写侧走 `decision_record`，见 `decision-rules.md §17.1`） |
| 7 | 所有错误消息体 | 单行、可 `JSON.parse`（在 `Error: <CODE>: ` 之后）；键序 `code`→`reason_code`→(`family`)→`message`→`detail` |
| 8 | 三个工具的 `output.schema` | 每个错误码 + 正常路径各跑一次，零违反 |
| 9 | `summarize` / `record` **不传** `as_of` | `INVALID_ARGS(MISSING_REQUIRED)`（`as_of` 必填，`D-16`） |
| 10 | `record` 传 `idempotency_key` | `INVALID_ARGS(UNKNOWN_PARAM)`（`D-80`：本工具不做客户端幂等） |
| 11 | `submit` 的 `items` 传**数组** | `INVALID_ARGS(TYPE_MISMATCH)`（`items` 是对象，`D-74`） |
| 12 | `submit` 的 `items` 缺 `transcript_basis` / 值为 `NO_TRANSCRIPT` 却带 `kind='SEGMENT'` | `INVALID_ARGS(TRANSCRIPT_BASIS_MISSING)` / `INVALID_ARGS(TRANSCRIPT_BASIS_CONFLICT)`（`TR-E2`/`TR-E3`） |
| 13 | `submit` 用**别的岗位**的 `rubric_version_id` | `INVALID_ARGS(RUBRIC_NOT_OF_JOB)`（`SC-47`） |

### 7.2 语义层（**这 8 条是"实现者最容易做错"的探针**）

| # | 探针 | 期望 | 错法 |
|---|---|---|---|
| **P1** | 3 面试官 2 提交 1 未交，`summarize(STAGE)` | `coverage={3,2,0,1}`、`ready=false`、`permitted=[ADVANCE,HOLD,WITHDRAW]`、`aggregation.average=null` | 输出"综合得分"或把 missing 算 0（`scorecard-rules.md` C10） |
| **P2** | 同上，`record(REJECT)` | `SCORECARD_MISSING` | 允许带缺失拒人（= 错误淘汰） |
| **P3** | 同上，`record(ADVANCE)` 不带 `acknowledged_missing` | `INVALID_ARGS(MISSING_ACK_REQUIRED)` | 默认放行（"缺人推进"变成静默默认） |
| **P4** | 2 通过 1 不通过 | `consensus=MAJORITY_ADVANCE`、`minority_reports` 带原文、`warnings: MINORITY_DISSENT` | 输出"建议通过"（`DC-01` 违规） |
| **P5** | 面评 `d2='UNREADABLE'` 且 `overall='REJECT'` | `EVIDENCE_INSUFFICIENT(REJECT_BASIS_UNREADABLE)` | 照收（`D11 §9.11` 红线 7） |
| **P6** | 决策人非招聘负责人 | **成功** + `basis_refs[AUTHORITY]` + `warnings[DECIDER_NOT_HIRING_MANAGER]` | 报 `FORBIDDEN`（v1.0 无权限，`D-33`） |
| **P7** | 同一申请第二次 `record`（同一 scope + stage，未带 `supersedes`） | `ALREADY_DECIDED(SCOPE_ALREADY_DECIDED)`（`0007` 之后由 `uq_decision_current` 的 23505 触发） | 直接插第二行 |
| **P8** | `record` 带 `supersedes` 但 `summary_digest` 沿用旧的 | `INVALID_ARGS(SUMMARY_STALE)` | 用旧汇总做新决定（`DC-34`） |
| **P9** | 三人全豁免（`submitted=0`、`waived=3`、`missing=0`），分别 `record(ADVANCE)` / `record(HOLD)` / `record(WITHDRAW)` | 前者 `EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)`；后两者**成功**，`basis_refs` 可 0 条 `SCORECARD` | 把"全豁免"当"全体通过"（`decision-rules.md §4.2.1`）；或反过来用"至少 1 条 SCORECARD basis"把撤回卡死 |
| **P10** | `ADVANCE(FINAL)` 带完整 `acknowledged_missing` + `missing_disposition`（试图用确认绕过缺面评） | `SCORECARD_MISSING`（**`acknowledged_missing` 不放行 FINAL**） | 让"终局缺面板"靠点确认过关（§4.2.1） |
| **P11** | 决策人传 `basis_refs[AUTHORITY].is_hiring_manager=true`，而服务端按 `DC-15` 算出 `false` | `INVALID_ARGS(BASIS_AUTHORITY_MISMATCH)` | 静默采信入参 = 决策人自己给自己盖章（`DC-14`） |
| **P12** | 面评 `transcript_basis='NO_TRANSCRIPT'`，决策 `basis_refs[SCORECARD]` 不带 `transcript_state` | `INVALID_ARGS(BASIS_TRANSCRIPT_STATE_MISSING)` | "这个决定有没有原文支撑"查不到（`TR-E7`） |

### 7.3 证据层

| # | 检查 | 期望 |
|---|---|---|
| 1 | `record(REJECT)` 的 `basis_refs` | 含 ≥1 `SCORECARD` + 1 `SUMMARY` + 1 `RUBRIC_VERSION` + 1 `AUTHORITY`；`REJECT` 另有 `OVERRIDE`（若与 consensus 相反）。**唯一例外**：`result ∈ {WITHDRAW, HOLD}` ∧ `submitted_count = 0` → `SCORECARD` 可为 0 条（`DC-12` 例外；`decision-rules.md §4.2.1`） |
| 2 | `basis_refs[].kind` | 全部 ∈ 9 种，**无 `AI_SUMMARY`** |
| 3 | `REJECT` 的每条依据 | 落到 `assessment='NOT_MET'` 的维度；落在 `UNREADABLE`/`NOT_OBSERVED` → `BLOCKED_BY_REVIEW` |
| 4 | `basis_refs[RUBRIC_VERSION]` | `payload_hash` == `rubric_version.payload_hash`；`id` == `application.rubric_version_id`，且该 rubric 的 `job_id` == `application.job_id`（`DC-17`、`SC-47`） |
| 4b | `basis_refs[SCORECARD]` | **必须**含 `overall`（= `scorecard.overall`）、`transcript_basis`、`transcript_state`（`TR-E7`）；**不得**含 `recommendation`（不是列） |
| 5 | `decision.basis_refs` 落库值 | 与出参 `basis_refs` **逐字节相同** |
| 6 | `record` 的内部事件 | 存在且 `provider='internal'`、`source_object_id=decision.id`、`provider_event_id` 为 `NULL` |
| 7 | 决策后 `decision` 行 | `record_version=1`；撤回后旧行 `=2`、新行 `=1`；**`current` 行恰好 1 条**（`superseded_by_decision_id is null`） |
| 8 | `submit` 落库的面评行 | `status_changed_by_actor_id is not null` ∧ `status_source_event_id` 指向存在的 `event_inbox` 行（`SC-44`；`0007` 之前靠写侧保证） |

### 7.4 只读层

| # | 检查 | 期望 |
|---|---|---|
| 1 | `summarize` 静态扫描 | 无 `INSERT`/`UPDATE`/`DELETE`/`fs`/`fetch`/子进程 |
| 2 | `summarize` 调用前后 | `scorecard` / `decision` / `business_task` / `interview` 的 `record_version` 与行数**全部不变** |
| 3 | `summarize` 用**只读账号**跑 | 必须能跑通；需要写权限 = 实现越界 |
| 4 | 同参连调两次 | 逐字节相同（含 `summary_digest`） |

### 7.5 写层

| # | 检查 | 期望 |
|---|---|---|
| 1 | **`submit`**：同 `idempotency_key` + 同 payload 连调两次 | 第二次 `replayed=true`，行数 +0，`record_version` 不变 |
| 2 | **`submit`**：同 key + 改一个字段 | `INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)` |
| 2b | **`record`**：同一个请求（**不带** `idempotency_key`，`D-80`）连调两次 | 第二次 `ALREADY_DECIDED(SCOPE_ALREADY_DECIDED)`，**行数 +0**、`record_version` 不变。**不得**出现"重试返回同一条决策"的行为，也不得把它实现成幂等回放 |
| 3 | 修订：天真两步（先插） | `DB_CONSTRAINT_VIOLATION(UNIQUE_VIOLATION)`，`constraint='uq_scorecard_current'` |
| 4 | 修订：天真两步（先改旧行） | `DB_CONSTRAINT_VIOLATION(FK_VIOLATION)`，`constraint='fk_scorecard_superseded_by'` |
| 5 | 修订：三步舞 | 成功；`current` 行数仍 1，`revision_no=2`，旧行仍在 |
| 6 | 撤回：先指旧行 | `DB_CONSTRAINT_VIOLATION(FK_VIOLATION)`，`constraint='fk_decision_superseded_by'` |
| 7 | 撤回：三步舞（反向插 → 换指针 → 清空） | 成功；`current` 行数恰好 1；有单向链；旧行 `record_version+1`；内部事件存在 |
| 7b | 撤回：两阶段口径 | **`0007` 之前**：三步舞也必须成功（不能因为"没有索引"就退回两步）；**`0007` 之后**：两步写法（第 1 步直接插 `superseded_by=NULL`）必须返回 `ALREADY_DECIDED`（23505 映射），**不是** `DB_CONSTRAINT_VIOLATION` |
| 8 | 把旧行 `superseded_by` 改回 `NULL` | `INVALID_ARGS(SUPERSEDE_LINK_CANNOT_BE_CLEARED)` |
| 9 | 对已提交面评 `UPDATE items` | `DB_CONSTRAINT_VIOLATION(SCORECARD_IMMUTABLE)` |
| 10 | `submit` 落库后面评行的三列审计 | `status_changed_by_actor_id` 非空、`status_changed_at` 非空、`status_source_event_id` 指向存在的 `event_inbox` 行（`SC-44`） |
| 11 | **`PENDING` 原地转正**（人为造一条 `PENDING` 当前行） | 成功且 `record_version` = 旧值 + 1、`status_source_event_id` 由 `fn_row_guard` 回填、`event_inbox` 多一行；**不是**"一行 UPDATE 什么都不发生"（`SC-45`） |

---

## 8. 本文件明确**不**规定的事

| 不规定 | 归谁 |
|---|---|
| SQL 怎么写、索引怎么建、三步舞怎么封装 | 实现方（不得在工具层拼 SQL 字符串） |
| `WAIVED` 由哪个人工命令产生 | 独立命令（`scorecard-rules.md §6.3`） |
| `interview.status` / `application.current_stage_code` 由谁推进 | 独立命令（`DC-47`、`G-5`） |
| 人工队列怎么"清" | 让人处理掉 `business_task`（工具不清，`§3.6`） |
| 队列 UI / 决策页长什么样 | 前端；本契约只保证 `permitted_results` + `blockers[]` + `minority_reports[]` 够用 |
| Next Round Brief 怎么渲染 | 前端；本契约只保证它是纯结构 + 有 digest（`DC-44/45`） |

**版本变更**：出参增删字段 → bump `evaluation-tool-contracts 1.x.0`；错误码集合、`permitted_results` 语义或 `assessment` 四态变化 → bump `2.0.0`（因为下游会断）。

---

## 9. 需要回抄的地方（本文档不改，只登记）

| # | 位置 | 要改什么 | 为什么 |
|---|---|---|---|
| 1 | `dsh/dsh-recruitment/CONTRACT.md` | 增一节指向 `contracts/evaluation/`（三个工具） | 否则新工具只活在子目录里，`R5` 单一权威失效 |
| 2 | `CONTRACT.md` §2.2 错误格式 | 统一为 `Error: <CODE>: <json>`（与 `job-screening/tool-contracts.md §1.2` 同一处待裁决） | 否则会出现两套错误格式 |
| 3 | `db/SCHEMA.md` §12 | 建议加负向测试 `N33`（两条 current 决策）、`N34`（`superseded_by` 改回 NULL） | `G-1`/`DC-32` 目前无库测试兜底 |
