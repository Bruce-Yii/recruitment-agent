# tool-contracts.md · S8/S9 两个工具的形状

**版本**：`tool-contracts 1.1.0`（与 `scheduling-rules 1.0.0` / `transcript-rules 1.0.0` 同一基线）
**日期**：2026-11-13（**1.1.0 补注：2026-11-14**，S8 四 intent 落地时回抄口径，见 §3.9）
**范围**：**只写契约**——入参、出参、错误码、必守性质。**不含任何实现**（不写 SQL、不写 TS）。
**规则来源**：`scheduling-rules.md`（S8）、`transcript-rules.md`（S9）。**本文件与那两份冲突时，以那两份为准**——这里只是形状。

> **1.0.0 → 1.1.0 改了什么（只补口径，不改语义）**：
> ① `schedule` 的允许写表从 5 张扩为 **6 张**（新增 `event_inbox`）：`scheduling-rules.md` §4.3/§4.4/SC-X5
> 要求服务层**显式**写 `interview.rescheduled` / `interview.cancelled` / `interviewer.withdrawn`，
> 而旧形状表没有给这个写留位置——按本文件首段的优先级（与 `scheduling-rules.md` 冲突时以它为准），
> 形状必须容纳规则要求的写。`changes.created/updated` 的 `table` 闭集同步加入 `event_inbox`。
> ② 把四 intent 落地时遇到的边界写成 §3.9 的可判定条款（不存在"实现者自己发明"的空间）。
> 按末段版本规则（出参增删字段 → bump `1.x.0`），故为 `1.1.0`；错误码集合与 `intent` 集合都没变。

---

## 0. 两个工具的边界（先划死，再谈字段）

| 工具 | 一句话 | 读 | 写 | 会对外发东西吗 | 能产 `decision` / `scorecard` 吗 |
|---|---|---|---|---|---|
| `recruitment_interview_get` | 查一场（或一份申请下的若干场）面试：谁面、几点、会议绑没绑、转写有没有 | 库 | **无** | 否 | 否 |
| `recruitment_interview_schedule` | 排定 / 改期 / 取消一场面试，并在**本地**登记会议绑定 | 库 | **有**（`interview` / `interviewer` / `meeting` / `meeting_binding` / `business_task` / `event_inbox`） | **否**（H-2） | 否 |

**六个"永远不做"**（每个都有对应的库约束或红线）：

1. **不写面评、不代填、不豁免**：`scorecard` 一个字段都不碰（`APP-07`、`scheduling-rules.md §5.2` SC-I5）。
2. **不落决策**：输出里没有 `decision` 的任何一个必填字段（`ck_decision_reason`、`INV-9`）。
3. **不创建/不删除飞书日历事件、不发邀请、不发邮件**：`schedule` 只登记调用方给的平台 ID（`scheduling-rules.md` H-2、`durable_effect` 才做外部写）。
4. **不接受模型传入的 `tenant_id` / `actor_id`**：租户与身份**只能**来自执行上下文（`SET LOCAL recruitment.actor_id`，`INV-8`、`XINV-7`）。入参里出现这两个键 → `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)`，**不是静默忽略**。
5. **不猜会议、不猜意图**：不按标题/姓名/模糊时间匹配（`APP-04`）；`CREATE` 撞到已有场次也不自动改成 `RESCHEDULE`，只回 `ALREADY_SCHEDULED` + hint。
6. **不返回转写正文**：`get` 只回状态、ID、计数、时间戳。正文与分页属另一个读工具（不在本文范围，见 §7）。

---

## 1. 共同约定

### 1.1 参数解析（沿用 `CONTRACT.md` §2.1 的七条，逐条不变）

1. `arguments` 必须是 JSON 对象；数组/标量 → `INVALID_ARGS`。
2. **未声明的键一律拒绝**（`additionalProperties: false`），错误里列出允许的键。
3. 必填缺失 → 拒绝；`string` 必须非空且不超 `maxLength`。
4. `integer` 必须是整数（`10` 通过，`"10"` / `10.5` 拒绝），并检查闭区间。
5. `boolean` 必须是布尔（`"true"` 拒绝）。
6. `string[]` 逐元素检查 `enum`。
7. **收集全部违反项一次性抛出**，不是遇到第一条就返回。

**本契约新增第 8、9 条**：

8. `string` 类型的 id 必须是 **UUID 文本形式**（小写化后比对 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`）。`interview_0001` 这类 stub id → `INVALID_ARGS(ID_NOT_UUID)`。
9. 时间是**带偏移的 ISO-8601**（`2026-11-20T10:00:00+08:00`）。不带偏移的裸本地时间（`2026-11-20T10:00:00`）→ `INVALID_ARGS(TIMESTAMP_WITHOUT_OFFSET)`。理由：`interview.scheduled_start_at` 是 `timestamptz`；不带偏移的时间在"谁的时区"上有歧义，而这种歧义会在跨时区面试官身上变成**差 8 小时的排期错误**（`docs/03 §19` 时间语义）。

### 1.2 错误消息格式（与 `contracts/job-screening/tool-contracts.md §1.2` 同一格式）

```text
Error: <CODE>: <compact-json>
```

| 键 | 必填 | 说明 |
|---|---|---|
| `code` | ✅ | 与消息前缀同一个值 |
| `reason_code` | ✅ | 该错误码下的**封闭枚举**（§3） |
| `message` | ✅ | 一句给人看的中文说明 |
| `detail` | 视 code | 结构化明细 |

JSON 必须**单行、键序稳定（字典序）**，可 `JSON.parse`。

### 1.3 只读 / 写 / 幂等 / 并发

| 性质 | `recruitment_interview_get` | `recruitment_interview_schedule` |
|---|---|---|
| 写库 | **零写入**（静态扫描：无 `INSERT`/`UPDATE`/`DELETE`/`fs`/`fetch`/子进程） | 允许写 §0 列的 6 张表（含 `event_inbox` 的**内部审计事件**）；**不得**写其它表 |
| 时钟 | 输出**不含** `evaluated_at`/`now`；唯一时间输入是显式 `as_of`，原样回显 | 写操作的时间由 DB 生成（`now()`）；**输出不含** `scheduled_by_now` 之类字段 |
| 幂等 | 天然（同一 `(args, 数据快照)` → 逐字节相同） | **必须**显式幂等键（§4.3） |
| 并发 | `isConcurrencySafe: true` | `isConcurrencySafe: false` |
| 事务 | 无 | 单事务；**任何失败都必须整笔回滚**（`changes` 全空是"没写"的证明） |

### 1.4 三维标签（R4，逐工具给语义，禁止混用一维枚举）

| 维度 | 取值 | `get` 的含义 | `schedule` 的含义 |
|---|---|---|---|
| `provenance` | `LIVE` \| `FIXTURE` | `LIVE` = 数据来自真实数据库行；**不**断言面试在业务上真实发生 | 按 `contracts/tenant-provenance.md §2` 的判定式算：`LIVE` 需要该租户**被显式声明为非合成**；缺声明 / 有合成标记 ⇒ `FIXTURE`（**不再**用"这次真的写进了库"当 `LIVE` 证据） |
| `trigger` | `EVENT` \| `MANUAL` | `MANUAL` = 模型/人在会话里调用 | `MANUAL`（本工具不被事件驱动） |
| `connection` | `CONNECTED` \| `NOT_CONNECTED` \| `AUTH_REQUIRED` | `CONNECTED` = 直连业务库（**与外部会议平台无关**） | **恒为 `NOT_CONNECTED`** |

> **2026-11-14 修正（N10 / `docs/23` P2-03）**：`schedule` 的 `provenance` 原先写成
> "`LIVE` = 真实写入了库"，把"写进库"当成了"数据真实"。`ra_s6s7` 是 `0002_seed` 的**演示租户 + 合成数据**，
> 按旧口径排期会返回 `LIVE`——合成数据冒充真实能力。现在统一按 `contracts/tenant-provenance.md §2`
> 的判定式（与 `recruitment_job_create` / `_job_update` / `_candidate_get` 同一个实现），fail-closed：
> 没有"非合成"的**正面证据**就是 `FIXTURE`；`connection` 仍是 `NOT_CONNECTED`（两个维度正交，不合并）。

> **`connection` 的关键裁决**：`schedule` 的 `connection` 恒为 `NOT_CONNECTED`，因为**本工具不发起任何外部调用**（H-2）。这正是 `R4` 想表达的那件事：*"产品有没有能力自己读/自己写外部系统"* 和 *"这次调用有没有改到我们的库"* 是**两个正交的事实**，不许用一个"success" 压平。
> **artifact 级的三维不进 `labels`**：每个转写产物的 `provenance` / `trigger_mode` / `connection_state` 是**那一行数据**的属性（`transcript_artifact` 上真有这三列，`0001 L1058-1060`），在 `transcript.artifacts[]` 里逐个回显。**禁止**把它们汇总成一个值塞进 `labels`。

---

## 2. `recruitment_interview_get`

### 2.1 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `interview_id` | string | 二选一 | UUID | 查单场 |
| `application_id` | string | 二选一 | UUID | 查该申请下的全部场次 |
| `round_no` | integer | — | 1..20 | 仅当给了 `application_id` 时可用；用于只看某一轮 |
| `require_transcript` | boolean | — | 默认 `false` | **调用方声明**："没有完整转写就不要给我结果" |
| `as_of` | string | — | ISO-8601 带偏移，**不得晚于服务端 now** | 派生状态（`transcript.state`、是否已过期）的基准时刻 |

**互斥与依赖（逐条可判定）**：

| 情况 | 结论 |
|---|---|
| 两个 id 都给 | `INVALID_ARGS(MUTUALLY_EXCLUSIVE)` |
| 两个 id 都不给 | `INVALID_ARGS(MISSING_REQUIRED)` |
| 只给 `round_no` | `INVALID_ARGS(MISSING_REQUIRED)`（`round_no` 依附 `application_id`） |
| 给了 `interview_id` 又给 `round_no` | `INVALID_ARGS(MUTUALLY_EXCLUSIVE)`（单场查询与轮次过滤语义冲突） |

### 2.2 出参

```json
{
  "tool": "recruitment_interview_get",
  "contract_version": "1.0.0",
  "status": "OK",
  "read_only": true,
  "labels": { "provenance": "LIVE", "trigger": "MANUAL", "connection": "CONNECTED" },
  "as_of": "2026-11-13T00:00:00+08:00",
  "query": { "mode": "BY_INTERVIEW", "interview_id": "…", "application_id": null, "round_no": null },
  "count": 1,
  "interviews": [
    {
      "id": "…",
      "application_id": "…",
      "candidate_id": "…",
      "job_id": "…",
      "round_no": 1,
      "slot_code": "DEFAULT",
      "stage_code": "S8",
      "status": "SCHEDULED",
      "record_version": 4,
      "scheduled_start_at": "2026-11-20T10:00:00+08:00",
      "scheduled_end_at": "2026-11-20T11:00:00+08:00",
      "duration_minutes": 60,
      "timezone": "Asia/Shanghai",
      "status_changed_at": "2026-11-13T09:00:00+08:00",
      "is_overdue_start": false,

      "interviewers": [
        {
          "interviewer_id": "…", "actor_id": "…", "display_name": "李工",
          "role_in_interview": "INTERVIEWER",
          "required_scorecard": true,
          "scorecard_due_at": "2026-11-21T10:00:00+08:00",
          "scorecard": { "scorecard_id": "…", "status": "SUBMITTED",
                         "revision_no": 1, "submitted_at": "2026-11-20T12:30:00+08:00",
                         "transcript_basis": "TRANSCRIPT" }
        }
      ],

      "meeting_binding": {
        "state": "BOUND_ACTIVE",
        "count": 1,
        "bindings": [
          {
            "binding_id": "…", "meeting_id": "…",
            "binding_method": "SCHEDULED",
            "bound_at": "2026-11-13T09:00:00+08:00",
            "bound_by_actor_id": "…",
            "provider": "FEISHU", "account_scope": null,
            "external_meeting_id": "…", "calendar_event_id": "evt_1",
            "meeting_role": "PRIMARY",
            "actual_start_at": null, "actual_end_at": null
          }
        ]
      },

      "transcript": {
        "state": "READY",
        "reason_code": "CANONICAL_STATUS",
        "canonical_artifact_id": "…",
        "canonical_revision": 1,
        "is_complete": true,
        "content_sha256": "…",
        "segment_count": 412,
        "coverage": { "artifacts_total": 1, "artifacts_ready": 1, "meetings_total": 1 },
        "no_transcript": false,
        "artifacts": [
          { "artifact_id": "…", "provider": "FEISHU", "provider_artifact_id": "…",
            "source_revision": 1, "variant_type": "ORIGINAL", "language": "zh",
            "transcript_status": "READY", "is_canonical": true, "is_complete": true,
            "has_more": false, "page_count": 12,
            "provenance": "LIVE", "trigger_mode": "EVENT", "connection_state": "CONNECTED",
            "fetched_at": "2026-11-20T12:05:00+08:00" }
        ],
        "open_tasks": []
      },

      "evaluation": {
        "required_scorecards": 2, "submitted": 1, "waived": 0, "pending": 1,
        "evaluation_ready": false,
        "blockers": [
          { "code": "SCORECARD_PENDING", "ref": { "interviewer_id": "…", "actor_id": "…" } },
          { "code": "RECORD_NOT_READY", "ref": { "interview_record_id": null } }
        ]
      },

      "warnings": []
    }
  ]
}
```

### 2.3 字段规则

| 字段 | 规则 | 依据 |
|---|---|---|
| `query.mode` | `BY_INTERVIEW` \| `BY_APPLICATION`，与入参一一对应 | — |
| `count` | `= interviews.length`（**恒等于**，不允许"总数另算"） | — |
| `duration_minutes` | `= (scheduled_end_at - scheduled_start_at) / 60`；任一为空 → `null`。**派生，不落库** | `scheduling-rules.md §2 A5` |
| `is_overdue_start` | `as_of > scheduled_start_at ∧ status ∈ {SCHEDULED, RESCHEDULED}` | 让"该开始却没开始"可机检 |
| `interviewers[]` | 按 `actor_id` 字典序稳定排序（**不许依赖 DB 返回顺序**） | 幂等输出（§1.3） |
| `interviewers[].scorecard` | 只取**当前**那一份（`superseded_by_scorecard_id is null`）；没有 → `null` | `uq_scorecard_current`（`0001 L1322`） |
| `scorecard.transcript_basis` | 从 `scorecard.items.transcript_basis` 读出；缺该键 → `"UNKNOWN"` 并出 `MISSING_TRANSCRIPT_BASIS` 警告 | `transcript-rules.md` TR-E2 |
| `meeting_binding.state` | `BOUND_ACTIVE` / `UNBOUND` / `NONE_EXPECTED`，判定见 `scheduling-rules.md §7.2`（`\|BIND(i)\| ≥ 1` → `BOUND_ACTIVE`） | 同一算法，不许两处实现 |
| `meeting_binding` | **恒为对象**（`state` 必须能读到，否则调用方要先判空再判状态）；`bindings[]` 是**全部** active binding（1 面试 : N 会议，`docs/04 §11`），`state='BOUND_ACTIVE'` 时非空、其余为空数组。按 `(meeting_role, bound_at, meeting_id)` 稳定排序 | 避免"看起来有绑定"；也避免把 `CONTINUATION` 会议藏起来 |
| `meeting_binding.count` | `= bindings.length`（**恒等于**）。`count ≥ 2` 是正常现象（正式会 + 断线续接），**不是**不变量被破 | `docs/04 §11`；库只在 meeting 侧唯一（`uq_meeting_binding_active`），interview 侧不唯一 |
| `transcript.state` | **唯一算法**在 `transcript-rules.md §4 TR-D`（7 条优先级），不得在此另写一套 | `TR-D1` |
| `transcript.no_transcript` | `= (state ≠ 'READY')` | 与 §3.6 的 `NO_TRANSCRIPT` 同源（`state` 是唯一来源，别另算一遍） |
| `transcript.artifacts[]` | 按 `(meeting_id, source_revision, variant_type)` 稳定排序；含**全部** revision（含非 canonical） | `docs/04 §11` 版本可查 |
| `transcript.open_tasks[]` | 该面试/其会议下未终结的 `business_task`（`status ∈ {PENDING, READY, RUNNING, WAITING_EXTERNAL, WAITING_HUMAN, RETRY_WAIT}`），按 `due_at` 升序 | `transcript-rules.md` TR-F6 |
| `evaluation.evaluation_ready` | `REQUIRED = SATISFIED ∧ record_ok ∧ traceable`（`APP-05`）。本工具**只回显**，不写状态 | `scheduling-rules.md §5.1` |
| `evaluation.blockers[]` | 未满足项逐条列，`code` 封闭枚举：`SCORECARD_PENDING` / `RECORD_NOT_READY` / `NO_REQUIRED_EVALUATOR` / `TRANSCRIPT_MISSING` | 让人知道"还差什么" |
| `warnings[]` | `{code, message, ref}`；`code` 封闭枚举见 §2.4 | — |

### 2.4 `warnings` 的封闭枚举

| `code` | 何时 | 严重度 |
|---|---|---|
| `MEETING_NOT_BOUND` | `meeting_binding.state='UNBOUND'` | 中（S9 会因此取不到材料） |
| `MEETING_NOT_BOUND_OVERDUE` | 同上 ∧ `is_overdue_start` | 高 |
| `CANONICAL_MISSING` | 有 `READY` 但没有 canonical（`transcript-rules.md` TR-D 序 3） | 中 |
| `NO_REQUIRED_EVALUATOR` | `evaluation.required_scorecards = 0` | 高（没人需要交评，却可能进 Evaluation Ready） |
| `MISSING_TRANSCRIPT_BASIS` | 面评 `items` 里没有 `transcript_basis` | 中（违反 TR-E2） |
| `INTERVIEWER_WITHDRAWN` | 存在 `event_type='interviewer.withdrawn'` 的事件 | 低（信息性） |
| `STATUS_OVERDUE_POST_INTERVIEW` | 会议实际结束 > 24h 且 `status` 仍为 `IN_PROGRESS` | 中 |

> `warnings` **不改变 `status`**：`status` 恒为 `"OK"`。警告是"这次查询看到的问题"，不是"查询失败"。

### 2.5 错误

| `code` | `reason_code` | 何时 |
|---|---|---|
| `INVALID_ARGS` | `UNKNOWN_PARAM` \| `TYPE_MISMATCH` \| `MISSING_REQUIRED` \| `OUT_OF_RANGE` \| `MUTUALLY_EXCLUSIVE` \| `ID_NOT_UUID` \| `TIMESTAMP_WITHOUT_OFFSET` \| `AS_OF_IN_FUTURE` \| `TENANT_OR_ACTOR_NOT_ALLOWED` | §1.1 |
| `NOT_FOUND` | `INTERVIEW_NOT_FOUND` \| `APPLICATION_NOT_FOUND` | 按主键查不到（**含跨租户**：一律 `NOT_FOUND`，不确认对方存在，`IR-C7` 同构） |
| `NO_TRANSCRIPT` | `NO_MEETING_BOUND` \| `NO_ARTIFACT_AFTER_WAIT` \| `ONLY_PARTIAL` \| `ONLY_AUTH_REQUIRED` \| `NEEDS_LINKING` \| `CANONICAL_STATUS` \| `WAITING` | **仅当** `require_transcript=true` ∧ `transcript.state ≠ 'READY'`。**`reason_code` 直接透传 `transcript-rules.md §4 TR-D` 的 `reason_code`**（两处必须逐字相同，不许各造一套） |

```text
Error: NO_TRANSCRIPT: {"code":"NO_TRANSCRIPT","reason_code":"NO_MEETING_BOUND","message":"该场面试没有绑定任何会议，因此不可能取得转写","detail":{"interview_id":"0199…","transcript_state":"MISSING","meetings_total":0,"open_tasks":[{"task_type":"BIND_MEETING","status":"WAITING_EXTERNAL"}]}}
```

**为什么 `NO_TRANSCRIPT` 是错误而不是字段**：`require_transcript=true` 是调用方**主动声明的硬前置**（典型场景：S10 要生成面试记录）。对这样的调用，"没有转写"意味着**后续所有工作都不该开始**，用 `null` 或空数组表达会让调用方一不留神就在无原文的基础上继续跑。**默认 `false`** 时则相反：缺材料是常态，应该作为状态回显（`transcript.state`），不能报错 —— 否则"查一场还没发生的面试"永远失败。

### 2.6 正例

```text
recruitment_interview_get {"interview_id":"0199c0de-0000-7000-8000-000000000101"}
→ interview 0199…0101  round=1 slot=DEFAULT  [SCHEDULED]  2026-11-20 10:00–11:00 (+08:00)
  (labels: LIVE/MANUAL/CONNECTED)  as_of=2026-11-13T00:00:00+08:00
  interviewers: 李工(required, SUBMITTED rev1/TRANSCRIPT) · 王工(required, PENDING)
  meeting_binding: BOUND_ACTIVE  FEISHU evt_1 → PRIMARY  (binding_method=SCHEDULED)
  transcript: READY  canonical=…@rev1  segments=412  1/1 artifacts ready
  evaluation: required=2 submitted=1 waived=0 pending=1 → evaluation_ready=false
              blockers: SCORECARD_PENDING(王工), RECORD_NOT_READY
  warnings: —
```

---

## 3. `recruitment_interview_schedule`

### 3.1 `intent` 的四个值与"为什么合在一个工具里"

| `intent` | 做什么 | 覆盖的边（`scheduling-rules.md §8`） |
|---|---|---|
| `CREATE`（默认） | 新建一场面试 + 必要时登记会议绑定 | `∅ → SCHEDULED` |
| `RESCHEDULE` | 改同一行的**时间**（可含换会议、加面试官） | `SCHEDULED → SCHEDULED` / `SCHEDULED → RESCHEDULED` / `RESCHEDULED → SCHEDULED` / `CANCELLED → SCHEDULED` |
| `CANCEL` | 取消该场次 | `SCHEDULED/RESCHEDULED → CANCELLED` |
| `WITHDRAW_INTERVIEWER` | 某面试官退出（请假/换人）：`required_scorecard=false` + 事件 | 不改 `interview.status`；`scheduling-rules.md §4.3` |

**为什么四合一而不是四个工具名**：S8 只有这四种写动作，且四种都必须走**同一套**冲突重算、幂等键、actor 校验、审计事件。拆成四个工具会把这四件事复制四份，只要有一份漏了就出"某条路径绕过了冲突检查"这类事故（`R2` 的经典失败形态）。
**代价与条件**：`intent` 是**必填还是默认**、以及要不要拆名，需要上级裁决（§5 第 7 条）。若拆名，**语义与错误码必须逐字沿用本文件**，且 `contract_version` 升 `2.0.0`。

### 3.2 入参

**通用（四个 intent 都必填）**：

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `intent` | string | ✅ | `CREATE`\|`RESCHEDULE`\|`CANCEL`\|`WITHDRAW_INTERVIEWER` | 动作 |
| `idempotency_key` | string | ✅ | 1..200，`^[A-Za-z0-9_.:-]+$` | 幂等键（§4.3） |

**`CREATE` 专用**：

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `application_id` | string | ✅ | UUID | 场次挂在哪个申请下（`INV-1`） |
| `round_no` | integer | ✅ | 1..20 | 轮次（`INV-4`） |
| `slot_code` | string | — | 默认 `"DEFAULT"`，`^[A-Z][A-Z0-9_]{1,20}$` | 同轮并行场次（`uq_interview_slot`） |
| `interviewers` | array | ✅ | `minItems:1`，元素见 §3.3 | 面试官集合 |
| `scheduled_start_at` | string | ✅ | ISO-8601 带偏移，**晚于 now** | 开始时刻 |
| `duration_minutes` | integer | ✅ | 15..480 | 时长（**必填，不从结束时间倒推**） |
| `timezone` | string | — | IANA 名，默认组织时区 | 仅展示 |
| `delivery_mode` | string | — | 默认 `"VIDEO"`；**v1.0 只接受 `VIDEO`** | 形式（见 `scheduling-rules.md` G-1） |
| `meeting` | object | — | 见 §3.4 | 给了就顺手登记绑定；不给 = `UNBOUND`（不报错） |
| `interview_template_version_id` | string | — | UUID | 关联本轮模板（必须属于同一 job） |

**`RESCHEDULE` 专用**：

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `interview_id` | string | ✅ | UUID | 哪一场 |
| `expected_record_version` | integer | ✅ | ≥1 | 乐观并发（`D-18`） |
| `scheduled_start_at` | string | 至少一个 | ISO-8601 带偏移，晚于 now | 新开始时刻 |
| `duration_minutes` | integer | 至少一个 | 15..480 | 新时长 |
| `meeting` | object | — | 见 §3.4 | 换会议（旧 binding 解绑、旧 meeting 标 `REPLACED`） |
| `interviewer_additions` | array | — | 元素同 §3.3 | **只增不减**；已存在 → `warnings: ALREADY_ASSIGNED` |
| `reason` | string | — | 1..500 | 改期理由（写进 `interview.rescheduled` 事件） |

> `scheduled_start_at` 与 `duration_minutes` 至少要给一个 → 否则 `INVALID_ARGS(NO_CHANGE)`。
> **只给 `duration_minutes` 时**：`scheduled_end_at = 现有 scheduled_start_at + 新时长`。

**`CANCEL` 专用**：

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `interview_id` | string | ✅ | UUID | 哪一场 |
| `expected_record_version` | integer | ✅ | ≥1 | 乐观并发 |
| `reason` | string | ✅ | 1..500 | 取消理由（`SC-X5`） |

**`WITHDRAW_INTERVIEWER` 专用**：

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `interviewer_id` | string | ✅ | UUID | `interviewer` 行 id（**不是** `actor_id`） |
| `reason` | string | ✅ | 1..500 | 退出理由 |
| `expected_record_version` | integer | ✅ | ≥1 | 该 interviewer 所属 `interview` 的版本 |

**不允许的入参**（出现即 `INVALID_ARGS(UNKNOWN_PARAM)` 或 `TENANT_OR_ACTOR_NOT_ALLOWED`）：
`tenant_id`、`actor_id`、`force`、`allow_conflict`、`skip_conflict_check`、`status`（不允许调用方直接指定状态）、`record_version`（必须用 `expected_record_version`，避免"故意用错名字"）。

### 3.3 `interviewers[]` / `interviewer_additions[]` 元素

```json
{ "actor_id": "uuid", "role_in_interview": "INTERVIEWER", "required_scorecard": true, "scorecard_due_at": "2026-11-21T10:00:00+08:00" }
```

| 键 | 必填 | 约束 | 语义 |
|---|---|---|---|
| `actor_id` | ✅ | UUID，`actor.kind='HUMAN'`，同租户 | `INTERVIEWER_NOT_HUMAN` / `INTERVIEWER_NOT_FOUND` |
| `role_in_interview` | — | `^[A-Z][A-Z0-9_]{1,30}$`，默认 `INTERVIEWER` | 仅标签（`D-33`：角色不用于拦截） |
| `required_scorecard` | — | boolean，默认 `true` | 是否阻塞 Evaluation Ready（`APP-05`） |
| `scorecard_due_at` | — | ISO-8601 带偏移 | 提醒时间（`interviewer.scorecard_due_at`） |

**集合内 `actor_id` 重复** → `INVALID_ARGS(DUPLICATE_INTERVIEWER)`（不是静默去重）。

### 3.4 `meeting` 对象

```json
{ "provider": "FEISHU", "account_scope": null, "calendar_event_id": "evt_1",
  "external_meeting_id": null, "meeting_role": "PRIMARY" }
```

| 键 | 必填 | 约束 | 语义 |
|---|---|---|---|
| `provider` | ✅ | 非空，1..64 | 平台标识（`meeting.provider`） |
| `account_scope` | — | 1..200 | 租户内账号区分（`meeting.account_scope`） |
| `calendar_event_id` | 二选一 | 1..200 | 日历事件 ID |
| `external_meeting_id` | 二选一 | 1..200 | 平台会议 ID |
| `meeting_role` | — | `PRIMARY`\|`CONTINUATION`，默认 `PRIMARY` | 会议角色（`ck_meeting_role` 的 4 值里只有这 2 个可由调用方给；`REPLACED`/`CANCELLED` 由系统在改期/取消时写） |

- 两个 ID 都不给 → `INVALID_ARGS(MEETING_IDENTITY_REQUIRED)`（对齐 `ck_meeting_identity`，`0001 L1007`）。
- `external_meeting_id` 已被**别的**面试的 active binding 占用 → `MEETING_ALREADY_BOUND`。
- 同一 `external_meeting_id` 已存在但**未绑定** → 复用该 `meeting` 行再建 binding（不报错）。

### 3.5 出参

```json
{
  "tool": "recruitment_interview_schedule",
  "contract_version": "1.0.0",
  "status": "OK",
  "write": true,
  "replayed": false,
  "labels": { "provenance": "LIVE", "trigger": "MANUAL", "connection": "NOT_CONNECTED" },
  "intent": "CREATE",
  "command": { "idempotency_key": "hire-42-r1-default-v1", "args_digest": "sha256:9c1e…" },

  "interview": { "…": "与 recruitment_interview_get 的 interviews[] 元素**同一形状、同一规则**" },

  "changes": {
    "created": [
      { "table": "interview", "id": "…" },
      { "table": "interviewer", "id": "…" },
      { "table": "interviewer", "id": "…" },
      { "table": "meeting", "id": "…" },
      { "table": "meeting_binding", "id": "…" },
      { "table": "business_task", "id": "…" }
    ],
    "updated": [],
    "unchanged": [ { "table": "application", "id": "…", "reason": "READ_ONLY" } ]
  },

  "effects": {
    "meeting_bound": true,
    "external_call_made": false
  },

  "warnings": [],
  "next_actions": [
    { "code": "BIND_MEETING", "task_id": "…", "due_at": "2026-11-20T10:00:00+08:00" }
  ]
}
```

| 字段 | 规则 |
|---|---|
| `replayed` | `true` ⇔ 本次是幂等重放（§4.3）；此时 `changes` 的 `created`/`updated` **必须为空** |
| `changes.created/updated` | **逐行**列出真正被写的 `(table, id)`；`table` 闭集：`interview` / `interviewer` / `meeting` / `meeting_binding` / `business_task` / `event_inbox`（第 6 项是 §4.4 / SC-X5 / §4.3 要求的**显式审计事件**）。**这张表就是"写没写"的证据**（失败时三数组全空） |
| `changes.unchanged` | 只为可观测性；不允许用它掩盖"该写没写" |
| `effects.external_call_made` | **恒为 `false`**（H-2）。若某天变成 `true`，必须同时出现 `durable_effect` 引用 |
| `next_actions[]` | 由本次写操作派生出的待办；`code` **闭集只有一个**：`BIND_MEETING`（未绑会议时）。**S8 不得创建 `SUPPLY_TRANSCRIPT`**——材料待办属 S9（`transcript-rules.md` TR-F3/TR-F7），S9 建它就是越权 |
| `interview` | 与 `get` 的元素同形；**这就是"写完立刻可查"的自证**（不需要再查一次） |

**`warnings[]` 的封闭枚举（schedule 专用，与 `get` 的不是同一套）**：

| `code` | 何时 | 是否算成功 |
|---|---|---|
| `MEETING_NOT_BOUND` | 本次没有给 `meeting`（或给了但没建成 binding），`interview` 仍已排定 | ✅ 成功（`scheduling-rules.md` H-3） |
| `ALREADY_ASSIGNED` | `RESCHEDULE` 的 `interviewer_additions[]` 里有已在该场的 `actor_id` | ✅ 成功（幂等语义，不报错） |
| `BINDING_REUSED` | 给了 `external_meeting_id`，该 `meeting` 行已存在但未绑定 → 复用后新建 binding | ✅ 成功 |
| `MEETING_ROLE_DOWNGRADED` | 该面试已有 `PRIMARY` 会议，本次 `meeting_role` 被强制为 `CONTINUATION` | ✅ 成功（`TR-B1` 每条面试至多 1 个 `PRIMARY`） |

### 3.6 错误码（**封闭集，7 个**）

| `code` | 产生者 | `reason_code` 枚举 | 何时 | `changes` |
|---|---|---|---|---|
| `INVALID_ARGS` | 两个工具 | 见 §3.7 | 参数层 / 状态边不允许 | 空 |
| `NOT_FOUND` | 两个工具 | `APPLICATION_NOT_FOUND` \| `INTERVIEW_NOT_FOUND` \| `INTERVIEWER_NOT_FOUND` | 主键查不到（含跨租户 → 一律 `NOT_FOUND`） | 空 |
| `CONFLICT_SLOT` | schedule | `INTERVIEWER_BUSY` \| `CANDIDATE_BUSY` | 命中 `scheduling-rules.md §3.2` | 空 |
| `ALREADY_SCHEDULED` | schedule | `SLOT_OCCUPIED` | `CREATE` 命中已存在的 `(application, round_no, slot_code)`（含 `CANCELLED`，`scheduling-rules.md §6.4`） | 空 |
| `MEETING_ALREADY_BOUND` | schedule | `BOUND_TO_OTHER_INTERVIEW` | 该会议已被**别的**面试的 active binding 占用 | 空 |
| `VERSION_CONFLICT` | schedule | `STALE_RECORD_VERSION` | `UPDATE … WHERE record_version = $expected` 影响 0 行 | 空 |
| `NO_TRANSCRIPT` | **仅 get** | 见 §2.5 | `require_transcript=true` ∧ 无完整转写 | — |

**`NO_TRANSCRIPT` 为什么不属于 `schedule`**：给它挂上会诱导实现者写出"没有转写就不能安排面试"的逻辑 —— 那正好把 S8 和 S9 的因果**倒过来**（面试先发生，才有转写）。**唯一**合法的"要求先有转写"的场景是"读结果/生成记录"，那是 `get` 的 `require_transcript`。

### 3.7 `INVALID_ARGS` 的 `reason_code` 封闭枚举

| `reason_code` | 触发 | 归属 |
|---|---|---|
| `UNKNOWN_PARAM` | 出现未声明的键（含 `force`/`allow_conflict`） | 两者 |
| `TYPE_MISMATCH` | 类型不对 | 两者 |
| `MISSING_REQUIRED` | 该 intent 的必填项缺失 | 两者 |
| `OUT_OF_RANGE` | `round_no`/`duration_minutes` 越界 | 两者 |
| `MUTUALLY_EXCLUSIVE` | 两个 id 都给 / `interview_id` + `round_no` | get |
| `ID_NOT_UUID` | 非 UUID | 两者 |
| `TIMESTAMP_WITHOUT_OFFSET` | 时间没带偏移 | 两者 |
| `AS_OF_IN_FUTURE` | `as_of` 晚于 now | get |
| `START_IN_PAST` | `scheduled_start_at` 不晚于 now | schedule |
| `DURATION_OUT_OF_RANGE` | `duration_minutes ∉ [15,480]` | schedule |
| `SLOT_CODE_INVALID` | `slot_code` 不合正则 | schedule |
| `UNSUPPORTED_DELIVERY_MODE` | `delivery_mode ≠ VIDEO`（v1.0） | schedule |
| `INTERVIEWER_REQUIRED` | `interviewers` 为空 | schedule |
| `DUPLICATE_INTERVIEWER` | 同一 `actor_id` 出现两次 | schedule |
| `INTERVIEWER_NOT_HUMAN` | `actor.kind ≠ HUMAN`（人不存在/跨租户 → `NOT_FOUND`） | schedule |
| `TEMPLATE_JOB_MISMATCH` | `interview_template_version_id` 不属于该 `application.job_id` | schedule |
| `MEETING_IDENTITY_REQUIRED` | `meeting` 对象里两个 ID 都没给 | schedule |
| `MEETING_ROLE_NOT_ALLOWED` | 调用方试图给 `REPLACED`/`CANCELLED` | schedule |
| `NO_CHANGE` | `RESCHEDULE` 没给任何可改字段 | schedule |
| `REASON_REQUIRED` | `CANCEL` / `WITHDRAW_INTERVIEWER` 的 `reason` 为空 | schedule |
| `IDEMPOTENCY_KEY_REUSED` | 同 key 不同参（§4.3） | schedule |
| `INVALID_STATE_TRANSITION` | 该边不在 `scheduling-rules.md §8`（含 `CANCEL` 打到 `POST_INTERVIEW`） | schedule |
| `TENANT_OR_ACTOR_NOT_ALLOWED` | 入参里出现 `tenant_id`/`actor_id` | 两者 |

### 3.8 错误体样例

```text
Error: CONFLICT_SLOT: {"code":"CONFLICT_SLOT","reason_code":"INTERVIEWER_BUSY","message":"面试官 李工 在该时段已有一场面试","detail":{"interview_id":null,"slot":{"start":"2026-11-20T10:30:00+08:00","end":"2026-11-20T11:30:00+08:00"},"conflicts":[{"kind":"INTERVIEWER","ref_kind":"INTERVIEW","ref_id":"0199…","actor_id":"0199…","window":{"start":"2026-11-20T10:00:00+08:00","end":"2026-11-20T11:00:00+08:00"}}]}}

Error: ALREADY_SCHEDULED: {"code":"ALREADY_SCHEDULED","reason_code":"SLOT_OCCUPIED","message":"该申请第 1 轮 DEFAULT 场次已存在（状态 SCHEDULED）","detail":{"existing_interview_id":"0199…","existing_status":"SCHEDULED","hint":"如需改时间请用 intent=RESCHEDULE"}}

Error: VERSION_CONFLICT: {"code":"VERSION_CONFLICT","reason_code":"STALE_RECORD_VERSION","message":"该面试已被他人修改（期望版本 3，实际 4）","detail":{"interview_id":"0199…","expected_record_version":3,"actual_record_version":4}}
```

### 3.9 四 intent 落地时补的可判定口径（2026-11-14，`1.1.0`）

> 这些不是新语义，是把 §3.1 / §4.2 / §6 / §8 **没写到的边界**写成可判定条款：
> 实现者不需要"自己发明"，复核者也不需要靠读代码猜口径。

| # | 情形 | 结论 |
|---|---|---|
| **B-1** | `RESCHEDULE` 成功后 `interview.status` | 恒为 `SCHEDULED`。§3.2 要求 `scheduled_start_at` 与 `duration_minutes` 至少给一个（否则 `NO_CHANGE`），因此**经本工具产不出** `RESCHEDULED`（"时间作废、待重排"）这个中间态；§8 的 `SCHEDULED → RESCHEDULED` 边仍合法，只是需要"只作废时间"的入口，v1.0 不提供（本工具只允许 `RESCHEDULED` 作为**源**状态）。 |
| **B-2** | `RESCHEDULE` 只给 `duration_minutes`，且该场当前没有 `scheduled_start_at` | `INVALID_ARGS(MISSING_REQUIRED)`（`detail.path='scheduled_start_at'`）：`ck_interview_scheduled` 不允许 `SCHEDULED` 行缺开始时间，不能用"空开始 + 新时长"拼窗口。 |
| **B-3** | `RESCHEDULE` 只给 `duration_minutes` | 时长由现有窗口换算 `(end - start) / 60000`，必须是 15..480 的**整数**分钟（否则 `DURATION_OUT_OF_RANGE`）；且**改期后的窗口必须晚于 now**，否则 `START_IN_PAST`（对"只改时长"同样成立：过期窗口不能借改时长复活）。 |
| **B-4** | `RESCHEDULE` 的 `meeting` 指向**已经绑在本场**的会议 | 视为空操作：不新建 binding、也不解绑其它会议（不把"重复提交同一个会议"写成破坏）；不产生 `BINDING_REUSED`。 |
| **B-5** | `CANCEL` 打到已经 `CANCELLED` 的行 | **成功且零写入**（§6.1）：不改 `interview`、不写事件、**也不写幂等 STORE**。该分支 `replayed=false`（本次没有"首次结果"可重放），调用方重试得到同一个库内事实；不得报 `INVALID_STATE_TRANSITION`。 |
| **B-6** | `WITHDRAW_INTERVIEWER` 打到已经退出的人（存在 `interviewer.withdrawn` 事件） | **成功且零写入**（不重复写事件、不重复 touch `interview` 版本、不写 STORE）。判"已退出"只看事件，**不看** `required_scorecard` 布尔值（§11-⑦：旁听与退出的成因不同）。 |
| **B-7** | `WITHDRAW_INTERVIEWER` 对 `interview.status` 的要求 | **不设限制**：该 intent 不改 `status`（§3.1 / §4.3），也不在 §8 的边集里，故不对任何状态额外拦截；版本与存在性仍要过。 |
| **B-8** | `WITHDRAW_INTERVIEWER` 的 `effective_from` | 取**本次调用的服务端时刻**（DB `now()` 的 ISO 文本）：退出是"人现在做的动作"，不拿 `scheduled_start_at` 冒充生效时刻。 |
| **B-9** | 审计事件进不进 `changes` | 进。本工具**显式**写的 `event_inbox` 行逐条出现在 `changes.created[table='event_inbox']`；`fn_row_guard` 因状态迁移**自动**写的 `interview.status.changed` 事件不由工具写，故不列（它的证据是读回行里的 `status_source_event_id`）。 |
| **B-10** | 审计事件的形状 | `provider='internal'` / `trust_level='INTERNAL'` / `idempotency_source='FALLBACK_KEY'`（无 `provider_event_id`，`source_object_id` = interview id 或 interviewer id）；`idempotency_key='interview_schedule:' || K || ':' || event_type`，同一命令对同一事件类型只可能写一次（`uq_event_inbox_idempotency` 兜底）。 |
| **B-11** | `RESCHEDULE` 对未绑会议的场次 | 排定照常成立（H-3）；改期后仍无 active binding → `warnings: MEETING_NOT_BOUND`（与 CREATE 同口径）。**不**新建/不刷新补绑任务（`next_actions: BIND_MEETING` 仍是 CREATE 的语义；补绑任务 `due_at` 的刷新不在 v1.0 契约内）。 |
| **B-12** | `RESCHEDULE` 的 `interviewer_additions` | 只增不减；已在场 → `warnings: ALREADY_ASSIGNED`（不算失败）；新增的人与既有面试官**一起**参与新窗口的冲突判定（A8）。 |

---

## 4. 幂等与冲突返回（写操作的硬要求）

### 4.1 冲突返回的形状（可机检）

`CONFLICT_SLOT.detail` **必须**含：

| 键 | 必填 | 说明 |
|---|---|---|
| `slot` | ✅ | 本次请求的窗口 `{start, end}`（含 buffer 前） |
| `conflicts[]` | ✅ | **至少 1 项**（空数组 = 违约，那时不该报 `CONFLICT_SLOT`） |
| `conflicts[].kind` | ✅ | `INTERVIEWER` \| `CANDIDATE` |
| `conflicts[].ref_kind` / `ref_id` | ✅ | 撞上的那一场（`INTERVIEW`） |
| `conflicts[].window` | ✅ | 被占用窗口 `EW`（`schedule-rules §3.1`） |
| `conflicts[].actor_id` | `kind=INTERVIEWER` 时必填 | 哪个人撞了 |

**排序要求**：`conflicts[]` 按 `(kind, ref_id)` 字典序，保证同一输入输出稳定（可断言）。

### 4.2 冲突是"拒绝"不是"建议"

命中 `CONFLICT_SLOT` → **不落任何行**（单事务回滚，`changes` 三数组全空）。**不提供** `force` 参数（`scheduling-rules.md §3.3`）：一旦提供，所有调用方都会在遇到冲突时加 `force=true`。

### 4.3 幂等键（`CREATE` / `RESCHEDULE` / `CANCEL` / `WITHDRAW_INTERVIEWER` 全适用）

```
K        = args.idempotency_key
STORE    = business_task  (tenant_id, idempotency_key = 'interview_schedule:' || K)
DIGEST   = 'sha256:' || hex( sha256( canonical_json( args 去掉 idempotency_key ) ) )
```

| 情形 | 判定 | 结果 |
|---|---|---|
| `STORE` 无行 | 首次 | 正常执行；执行成功后 `STORE.business_refs` 写入 `{args_digest: DIGEST, result_interview_id: …}`，`STORE.status='SUCCEEDED'` |
| `STORE` 有行 ∧ `args_digest` 相同 | 重放 | 返回**首次结果**（`interview` 从库重新读、`changes` 全空、`replayed=true`）。**不写任何新行** |
| `STORE` 有行 ∧ `args_digest` 不同 | 键复用 | `INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)`，`detail` 带 `first_args_digest` / `this_args_digest` |
| 执行失败（任何错误码） | — | **不留下 `SUCCEEDED` 的 STORE**：失败时该任务行 `status ∈ {FAILED, CANCELLED}` 或整笔回滚（推荐后者）。**禁止**把失败也记成可重放成功 |
| 并发两次同 key | 后者撞 `uq_business_task_idempotency`（`0001 L1430`）→ `23505` | 服务层必须把它翻译成"重放查询 → 返回首次结果"，**不得**抛 500 |

**不写 STORE 的例外（只有两处，且都是"成功但零域写入"）**：`CANCEL` 打到已 `CANCELLED`（§3.9 B-5）、
`WITHDRAW_INTERVIEWER` 打到已退出的人（§3.9 B-6）。它们不改变任何业务事实，若写 STORE 就违反
§6.1 的"成功且不写行"；重试仍安全，因为状态/事件检查本身就是幂等的。

**幂等键由调用方生成**（不由工具生成）：工具生成就等于"每次调用都是新请求"，幂等失效。
**语义级幂等不依赖 key**：`CREATE` 撞已有场次 → `ALREADY_SCHEDULED`（`scheduling-rules.md §6.4`）；即使调用方每次都换 key，也造不出第二场。

### 4.4 乐观并发

| intent | `expected_record_version` 指谁 | 0 行更新 → |
|---|---|---|
| `RESCHEDULE` / `CANCEL` | `interview.record_version` | `VERSION_CONFLICT` |
| `WITHDRAW_INTERVIEWER` | 该 `interviewer` 所属 `interview.record_version`（`interviewer` 无版本列） | `VERSION_CONFLICT` |

**禁止**：重试时沿用旧版本号（`D-18`：调用方必须 `RETURNING record_version` 并逐次重读）；**禁止** last-write-wins。

---

## 5. 与现有 `CONTRACT.md` 的关系（必须显式处理的 7 处差异）

`CONTRACT.md` §5 已登记 3 个**只读 stub** 工具（`recruitment_resume_read` / `recruitment_candidate_get` / `recruitment_job_get`）。本文件**新增**两个工具名，不改动那 3 个。

| # | 项 | 现状（`CONTRACT.md`） | 本契约 | 处理 |
|---|---|---|---|---|
| 1 | 工具名 | 3 个只读 stub | 新增 `recruitment_interview_get` / `recruitment_interview_schedule` | 兼容（新名字）。**不需要**改那 3 个 |
| 2 | 错误消息格式 | §2.2 散文（`job "job_9999" not found; …`） | `Error: <CODE>: <json>` | **破坏性**。与 `job-screening/tool-contracts.md §4` 是**同一个未决事项**：建议一次性统一（`errors.ts` 改一处），否则 `R5` 会在错误格式上再破一次 |
| 3 | id 形态 | `job_0001` 这类 stub | 强制 UUID（§1.1 第 8 条） | **破坏性**（故意的） |
| 4 | `stub` 字段 | 恒 `true` | 字段删除 | 破坏性 |
| 5 | **写工具** | 3 个全是只读，`CONTRACT.md §6` 的"只读证明"（静态扫描无 `INSERT/UPDATE/DELETE`）**不适用** | `schedule` 是写工具 | **需要新的证明口径**，见 §5.1 |
| 6 | `isConcurrencySafe` | 未声明 | `get: true` / `schedule: false` | 新增（对齐 `job-screening` 已用的做法） |
| 7 | `intent` 四合一 | 无先例 | §3.1 | **需上级裁决**：接受四合一，或拆成 4 个工具名（拆名则 `contract_version` → `2.0.0`，语义与错误码逐字沿用） |

### 5.1 写工具的"可证明"口径（替代只读静态扫描）

| # | 证明项 | 怎么查 |
|---|---|---|
| W1 | **只写 6 张表** | 静态扫描：除 `interview` / `interviewer` / `meeting` / `meeting_binding` / `business_task` / `event_inbox`（内部审计事件）外零写语句 |
| W2 | **零外部调用** | 静态扫描：无 `fetch` / `http` / 子进程 / SDK import；`effects.external_call_made` 恒 `false` |
| W3 | **失败零写入** | 用 7 个错误码各跑一次，断言 `changes.created/updated` 为空 ∧ 相关表行数不变 |
| W4 | **单事务** | 注入一个后半段失败（如 binding 时 `23505`），断言 `interview` 行也不存在 |
| W5 | **写后可查** | 成功返回的 `interview` 与随后 `get` 的结果逐字段一致（除 `as_of`） |
| W6 | **actor 真实** | `SET LOCAL recruitment.actor_id`；`status_changed_by_actor_id` 与上下文 actor 相等（`ACTOR_REQUIRED`、`INV-8`） |

---

## 6. 验收用例（8 条，输入 → 结论）

**这 8 条是"实现者最容易做错"的探针**，每条都可机检。前置：`T1` 租户；`A1/A2` 是 `HUMAN` 面试官；`C` 候选人；`app1` = `C` 在 `job1` 的 ACTIVE 申请。

| # | 输入 | 期望结论 | 依据 |
|---|---|---|---|
| **E1** | `get {interview_id: i1}`；`i1` 已 `SCHEDULED`、`PRIMARY` 会议已绑、canonical artifact `READY`；`A1` 已交、`A2` 未交 | `status="OK"`；`count=1`；`meeting_binding.state="BOUND_ACTIVE"` ∧ `bindings.length=1`；`transcript.state="READY"`；`transcript.no_transcript=false`；`evaluation{pending:1, evaluation_ready:false, blockers:[SCORECARD_PENDING]}` | §2.3、`transcript-rules §4` |
| **E2** | `get {interview_id: i2}`；`i2` 已到点但**从未绑会议**（`meeting=∅`） | **不报错**；`meeting_binding.state="UNBOUND"` ∧ `bindings=[]`；`transcript.state="MISSING"`、`reason_code="NO_MEETING_BOUND"`；`warnings` 含 `MEETING_NOT_BOUND`（逾期则 `MEETING_NOT_BOUND_OVERDUE`） | §2.4、`transcript-rules §4 序1`、`§5 TR-F3` |
| **E3** | `get {interview_id: i2, require_transcript: true}`（同上数据） | `Error: NO_TRANSCRIPT`，`reason_code="NO_MEETING_BOUND"`，`detail.transcript_state="MISSING"` + `open_tasks[]`；**不得**返回 `status:"OK"` 加空数组 | §2.5、§3.6 |
| **E4** | `get {application_id: <不存在>}` | `Error: NOT_FOUND`，`reason_code="APPLICATION_NOT_FOUND"` | §2.5 |
| **E5** | `schedule {intent:"CREATE", app1, round:1, slot:"DEFAULT", interviewers:[A1,A2], start:2026-11-20T10:00+08:00, duration:60, meeting:{provider:FEISHU, calendar_event_id:evt_1}, idempotency_key:"k1"}`；无冲突 | `status="OK"`、`replayed=false`；`changes.created` 恰含 1×`interview` + 2×`interviewer` + 1×`meeting` + 1×`meeting_binding`；`interview.status="SCHEDULED"`；`scheduled_end_at=11:00`；`effects.external_call_made=false`；`labels.connection="NOT_CONNECTED"` | §3.5、§1.4、`scheduling-rules §2` |
| **E6** | 同上，但 `A1` 在 `10:30–11:30` 已有一场 `SCHEDULED`；`start:10:30, duration:60` | `Error: CONFLICT_SLOT`，`reason_code="INTERVIEWER_BUSY"`；`detail.conflicts.length ≥ 1` 且含 `kind="INTERVIEWER"`、`window`；**`changes` 三数组全空**（`interview` 表行数不变 → W3） | §4.1、§4.2、`scheduling-rules §3.2` |
| **E7** | `(app1,1,"DEFAULT")` 已存在（`status="CANCELLED"`）；`intent="CREATE"` 同 slot + 新 key | `Error: ALREADY_SCHEDULED`，`detail.existing_interview_id` + `existing_status="CANCELLED"` + `hint` 指向 `intent=RESCHEDULE`；**不得**自动改期、**不得**新建（否则撞 `uq_interview_slot` 成 500） | §3.6、`scheduling-rules §6.3/§6.4` |
| **E8** | (a) 用 E5 的**同一 key 同一参数**再调一次；(b) 用**同一 key 不同参数**（`start` 改 14:00）再调一次 | (a) `status="OK"`、`replayed=true`、`changes.created` 为空、`interview.id` 与首次相同（表行数不变）；(b) `Error: INVALID_ARGS`、`reason_code="IDEMPOTENCY_KEY_REUSED"`，`detail` 带两个 digest | §4.3、`XINV-1` |

**补充边界（不计入 8 条，但同一批必须跑）**：

| 探针 | 期望 |
|---|---|
| `RESCHEDULE` 传过期 `expected_record_version` | `VERSION_CONFLICT`，`detail.actual_record_version` 为真实值，零写入 |
| `CANCEL` 打到 `POST_INTERVIEW` | `INVALID_ARGS(INVALID_STATE_TRANSITION)`，零写入 |
| `meeting.external_meeting_id` 已被别的面试绑 | `MEETING_ALREADY_BOUND`，零写入 |
| `interviewers:[{actor_id:<AGENT_WORKER>}]` | `INVALID_ARGS(INTERVIEWER_NOT_HUMAN)` |
| 入参带 `force:true` / `tenant_id` | `INVALID_ARGS(UNKNOWN_PARAM)` / `TENANT_OR_ACTOR_NOT_ALLOWED` |
| `scheduled_start_at:"2026-11-20T10:00:00"`（无偏移） | `INVALID_ARGS(TIMESTAMP_WITHOUT_OFFSET)` |
| 成功调用后 `SELECT count(*) FROM scorecard` | 不变（`get` 与 `schedule` 都不碰面评） |

---

## 7. 本文件明确**不**规定的事

| 不规定 | 归谁 |
|---|---|
| SQL 怎么写、索引怎么建、是否用 `FOR UPDATE` | 实现方（不得在工具层拼 SQL 字符串） |
| **转写正文怎么读、怎么分页** | 另一个读工具（`recruitment_transcript_read`，未在本任务范围；正文体积与 cursor 语义必须单独定契约，见 `transcript-rules §8.3 TR-C9`） |
| 面评怎么提交、怎么豁免 | 人 + 评分类工具（`APP-07`；`execution_mandate` 已禁 `waive_scorecard`） |
| 日历事件怎么创建、邀请怎么发 | connector + `durable_effect`（`XINV-4` / `XINV-10`）；v1.0 由人在平台操作 |
| "我的面试"这类个人工作台怎么过滤 | UI + `D-33`（角色只作标签，不做拦截） |
| `transcript.state` 的算法 | `transcript-rules.md §4`（**唯一实现**；本文件只引用不重述） |
| 面试官移除/请假的 UI 入口 | `WITHDRAW_INTERVIEWER` intent + `scheduling-rules §4.3`；`interviewer.status` 列属 `0002` |
| 跨 meeting 的 canonical（`transcript_set`） | `0002`（`D-17`、`SCHEMA M-6`） |

**三维标签的唯一口径**：`provenance` 答"数据真不真"、`trigger` 答"谁触发"、`connection` 答"能不能自己读写外部系统"。三者**永不合并**成一个"success"（`R4`）。

**版本变更**：出参增删字段 → bump `1.x.0`；错误码集合、`intent` 集合或 `transcript.state` 取值变化 → bump `2.0.0`（下游会断）。
