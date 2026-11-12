# tool-contracts.md · `recruitment_my_workbench`（只读）

**版本**：`workbench-tool 1.0.0`（与 `workbench-rules 1.0.0` 同一基线）
**日期**：2026-11-13
**范围**：**只写形状**——入参、出参、错误码、必守性质。**不含实现**（不写 SQL 成品、不写 TS）。
**规则来源**：`workbench-rules.md`（"什么算我的"）。**本文件与它冲突时以它为准**——这里只定义形状，不新造归属规则。
**沿用的既有约定**：`contracts/CONTRACT.md` §2.1（七条入参校验）、`contracts/job-screening/tool-contracts.md` §1.2（错误消息 JSON 格式）、§1.4（R4 三维标签）。**三处差异在 §1.4 / §1.6 / §7 显式列出，不静默偏离。**

---

## 0. 这个工具是什么，不是什么

| 维度 | 声明 |
|---|---|
| 一句话 | 给定一个人，返回**属于他的工作台**：五个"我的"区块 + 一个**恒返回**的"未分配/待认领"区 |
| 读 | 业务库（`recruitment` schema） |
| 写 | **无**。不写 `last_seen`、不标已读、不认领、不改任何 `status` |
| 判权限 | **不判**。D-33：v1.0 全部全局可见，本工具不是访问控制（`workbench-rules.md` §0.1） |
| 时间 | **有**。输出必带 `evaluated_at`（见 §1.4，**故意偏离**兄弟契约的"无时钟"） |
| 幂等 | 在 `(args, evaluated_at, 数据快照)` 三者相同的条件下逐字节相同 |

**四个"永远不做"**：

1. **不因"不是你的事"而拒绝**：没有 403、没有空结果冒充无权。查得到就是查得到。
2. **不隐藏 `unassigned`**：参数里没有 `include_unassigned` 这个开关（传了就是 `UNKNOWN_PARAM`）。
3. **不改数据**：调用前后 `record_version` 一个都不许动（§6 V-1）。
4. **不返回候选人联系方式**：不返回 `candidate.normalized_email` / `normalized_phone`。工作台是待办清单，不是档案视图（R7 最小化）。

---

## 1. 共同约定

### 1.1 参数解析（沿用 `CONTRACT.md` §2.1 的七条）

数组/标量 → 拒绝；未声明键 → 拒绝；必填缺失 → 拒绝；`string` 非空且 ≤ `maxLength`；`string[]` 逐元素校验 `enum`；**收集全部违反项一次性抛出**。

**本契约新增第 8 条**：`actor_id` 必须是 **UUID 文本形式**（`^[0-9a-fA-F]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`，小写化后比对）。
`"u_001"` / `"demo-interviewer"` 这类 id **不是合法 UUID** → `INVALID_ARGS(reason_code='ID_NOT_UUID')`。

**第 9 条（本工具特有）**：`sections` 数组里**不许有重复值**。`["tasks","tasks"]` → `INVALID_ARGS(DUPLICATE_SECTION)`。理由：重复值在语义上不改变结果，但它说明调用方在拼参数，而拼错的下一次就会是 `["tasks","task"]`。

### 1.2 错误消息格式（与 `contracts/job-screening/tool-contracts.md` §1.2 逐字一致）

```text
Error: <CODE>: <compact-json>
```

`<compact-json>` 的键：`code`（与消息前缀同值）、`reason_code`（该码下的封闭枚举）、`message`（一句中文）、`detail`（结构化，视 code 而定）。
JSON **单行、键序字典序**，便于 `JSON.parse` 与断言。

### 1.3 只读、可并发

| 性质 | 要求 |
|---|---|
| 只读 | 源码不出现 `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` / `fs` / `fetch` / 子进程（沿用 `CONTRACT.md` §6 静态扫描口径） |
| 并发安全 | 声明 `isConcurrencySafe: true`（纯读） |
| 副作用 | 零。连"记一次访问日志"都不许写业务库；要留痕写在应用日志，不进 `recruitment` schema |

### 1.4 ⚠️ 与兄弟契约的三处差异（**必须显式承认，不许静默偏离**）

| # | 兄弟契约（`contracts/job-screening/tool-contracts.md`）怎么规定 | 本工具 | 为什么必须不同 | 状态 |
|---|---|---|---|---|
| **D-1** | §1.3：**无时钟**，输出不含 `evaluated_at`/`now`，唯一时间输入是显式 `as_of` | **必带 `evaluated_at`**；无 `as_of` 入参 | 工作台的三个判定**本质上是"此刻"**：`due_at` 过没过期、`review_queue.deadline` 超没超时、"最近 14 天"从哪天算。把这些藏起来，等于让"3 条逾期"无法归属到任何一个时刻。`screening_evaluate` 要的是可复算的**判定**，工作台要的是有明确时间戳的**视图**——两者对时钟的需求相反 | **需总控裁决**：若要求与兄弟契约统一，则入参加可选 `as_of`（`≤ 服务端 now`），本契约 bump `1.1.0`；**但 `evaluated_at` 仍然必须回显**（否则 §6 V-5 无法验证） |
| **D-2** | §1.3：`evaluated_at` 与 `now` 都禁止 | 允许 `evaluated_at`、允许 `time_ref.at` | 同 D-1 | 同上 |
| **D-3** | §3.4：错误码 4 个封闭集，含 `BLOCKED_BY_REVIEW` | **只有 2 个**：`INVALID_ARGS` / `NOT_FOUND` | 工作台没有"不该看"的状态：**任何人的工作台都永远可以看**（包括空工作台）。把它写成 `BLOCKED_BY_REVIEW` 会让"这个人今天没活干"变成一个错误 | 接受，无需裁决 |

### 1.5 `sections` 的语义（**这是本契约最容易实现错的一处**）

| 输入 | 行为 |
|---|---|
| 缺省（键不存在） | 返回全部 5 个区块 |
| `["tasks"]` | **只返回 `tasks`**；其余 4 个区块**键不存在** |
| `[]`（空数组） | `INVALID_ARGS(EMPTY_SECTIONS)` —— **不**等价于"全给" |
| 含未知值 | `INVALID_ARGS(UNKNOWN_SECTION)`，`detail.allowed` 列出 5 个合法值 |
| 含重复值 | `INVALID_ARGS(DUPLICATE_SECTION)` |

**三条硬规矩**：

1. **未请求 ≠ 空**。未请求的区块**整个键不出现**；请求了但没有条目 → 出现且 `count = 0`、`items = []`。
   **绝不允许**用 `count: 0` 表示"没请求"——调用方无法区分"这块今天没事"和"我没问这块"，而这两件事的后续动作完全不同。
2. **输出键序固定**：`tasks, interviews, jobs, applications, pending_reviews`，**不随入参顺序变化**（否则同一语义两次调用的 JSON 不同，diff 与快照测试全部失效）。
3. **`unassigned` 不受 `sections` 影响，恒返回**。见 §1.6。

### 1.6 `unassigned` 为什么不在 `sections` 里

`unassigned` 是**顶层独立键**，不是第六个可选区块。理由（`workbench-rules.md` §0.3、§3.3）：

- 它可以被 `sections` 关掉，就会在某次调用里消失；而消失的那一次，恰恰是需要它的一次。
- 因此：**没有** `include_unassigned` 参数；传了 → `UNKNOWN_PARAM`（`detail.allowed` 里不含它）。
- 它的条数上限是固定常量 `UNASSIGNED_LIMIT = 20`，**不可由入参调整**（可调就意味着"调小一点眼不见为净"）。

### 1.7 契约常量（写死，不由入参覆盖）

| 常量 | 值 | 作用 | 为什么写死 |
|---|---|---|---|
| `CONTRACT_VERSION` | `"1.0.0"` | 出参回显 | — |
| `SECTION_LIMIT` | `20` | 每个区块的 `items` 上限 | 入参可调 → 有人调成 500，工作台退化成全表扫描 |
| `UNASSIGNED_LIMIT` | `20` | `unassigned` 的 `items` 上限 | 同上；且这是"看得见的积压量"，不该被调小 |
| `RECENT_APPLICATION_DAYS` | `14` | `applications` 的时间窗 | "最近"必须有数字；14 天 ≥ 一个完整的面试→决策周期 |
| `UUID_RE` | `^[0-9a-f]{8}-…-[0-9a-f]{12}$` | `business_refs.id` 的形态 guard | 库层只校验"是数组"（`0001_init.sql:1445-1446`），不加 guard 会 `22P02` |

**这些值是契约的一部分。** 改任何一个都要 bump 版本，不能在实现里"顺手调一下"。

### 1.8 三维标签（R4，逐维给语义，禁止混用一维枚举）

| 维度 | 取值 | 本工具的含义 |
|---|---|---|
| `provenance` | `LIVE` | **恒 `LIVE`**：每一行都来自业务库的真实行，没有 fixture 分支。注意：`LIVE` 只断言"这行存在"，**不断言**这行背后的业务是真实的（演示租户的行也是 `LIVE`，`0002_seed.sql:5-8` 已标 DEMO ONLY / SYNTHETIC） |
| `trigger` | `MANUAL` | 人在会话里问"我的工作台有什么"；**不是**定时推送 |
| `connection` | `CONNECTED` | 直连业务库。**与任何外部连接器无关**——工作台不读飞书、不读日历 |

> **禁止**在本工具里出现 `FIXTURE` 分支。工作台看的是**库**；库里的行是不是真实业务，由该行自己的 `event_inbox.provider` 链路决定，不归本工具判断（那会把两个正交维度压成一维，正是 R4 的原始事故）。

---

## 2. 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `actor_id` | `string` | ✅ | UUID 文本，`maxLength: 36` | **"我"是谁**。租户由 `actor.tenant_id` 推出，**不接受 `tenant_id` 入参** |
| `sections` | `string[]` | — | 元素 ∈ `{"tasks","interviews","jobs","applications","pending_reviews"}`；非空；无重复；`maxItems: 5` | 只看某几块。缺省 = 全部 |

**被显式拒绝的键**（命中即 `INVALID_ARGS(UNKNOWN_PARAM)`，`detail.allowed` 列出 `["actor_id","sections"]`）：

| 键 | 为什么拒 |
|---|---|
| `tenant_id` | 租户只能来自 `actor` 行。允许传入 = 允许"代人查别的租户"，而 v1.0 连"本人"都没验过 |
| `include_unassigned` | §1.6：`unassigned` 不可关 |
| `limit` / `page` / `offset` | §1.7：常量写死 |
| `recent_days` / `as_of` | §1.7 / §1.4-D1：时间窗是契约常量；如需 `as_of` 要整体裁决 |
| `role` / `actor_role` / `scope` | D-33：角色是标签，不是过滤条件 |
| `include_contacts` | §0 第 4 条：工作台永不返回联系方式 |
| `section`（单数） | 拼错的高发词。**故意不宽容**：`section` 与 `sections` 一字之差，宽容它会让真正的拼写错误沉默 |

**参数示例**：

```json
{"actor_id": "11111111-1111-4111-8111-000000000102"}
{"actor_id": "11111111-1111-4111-8111-000000000104", "sections": ["interviews","pending_reviews"]}
```

---

## 3. 出参

### 3.1 顶层形状

```json
{
  "tool": "recruitment_my_workbench",
  "contract_version": "1.0.0",
  "status": "OK",
  "read_only": true,
  "labels": { "provenance": "LIVE", "trigger": "MANUAL", "connection": "CONNECTED" },
  "evaluated_at": "2026-11-13T01:05:25+08:00",

  "actor": {
    "id": "11111111-1111-4111-8111-000000000102",
    "display_name": "演示-招聘负责人",
    "kind": "HUMAN",
    "status": "ACTIVE",
    "department_id": "11111111-1111-4111-8111-000000000010",
    "department_name": "研发部（演示）"
  },

  "sections": {
    "tasks":        { "count": 0, "action_required_count": 0, "limit": 20, "truncated": false, "items": [] },
    "interviews":   { "count": 0, "action_required_count": 0, "limit": 20, "truncated": false, "items": [] },
    "jobs":         { "count": 1, "action_required_count": 0, "limit": 20, "truncated": false,
                      "items": [ { "…": "见 §3.3" } ] },
    "applications": { "count": 0, "action_required_count": 0, "limit": 20, "truncated": false, "items": [] },
    "pending_reviews": { "count": 0, "action_required_count": 0, "limit": 20, "truncated": false, "items": [] }
  },

  "unassigned": {
    "count": 3,
    "limit": 20,
    "truncated": false,
    "by_kind": { "TASK_NO_OWNER": 1, "REVIEW_QUEUE_UNCLAIMED": 1, "INTAKE_NEEDS_REVIEW": 1,
                 "APPROVAL_UNMAPPABLE": 0, "APPROVAL_NO_HIRING_MANAGER": 0,
                 "INTERVIEW_RECORD_UNASSIGNED": 0 },
    "items": [ { "…": "见 §3.4" } ]
  },

  "warnings": []
}
```

### 3.2 区块对象（`sections.*` 与 `unassigned` 共用）

| 字段 | 类型 | 规则 |
|---|---|---|
| `count` | integer ≥0 | **满足谓词的总行数**，不受 `limit` 影响。`count` 与 `items.length` 的差就是"没显示的" |
| `items` | array | ≤ `limit` 条 |
| `items.length` | — | `= min(count, limit)`。**恒等式，不是估计** |
| `limit` | integer | 该区块的常量上限（`SECTION_LIMIT` 或 `UNASSIGNED_LIMIT`），**回显**，便于调用方判断"是不是被截了" |
| `truncated` | boolean | `count > items.length`。**必须由上面两个数算出**，不许单独赋值 |
| `action_required_count` | integer ≥0 | **`sections.*` 才有**；= `required_action ∉ {"NONE","WAIT","MONITOR"}` 的条数（`unassigned` 无此字段：无主积压全部需要人，多一个恒等于 `count` 的字段没有信息量） |
| `by_kind` | object | **`unassigned` 才有**；6 个 `kind` **全部出现**（没有的写 `0`，不得省略）。理由：省略会让"这一类没有了"和"这类本来不统计"看起来一样 |

### 3.3 条目对象（`items[]`，五个区块通用信封）

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `key` | string | ✅ | `"<kind>:<id>"`，**区块内唯一**。给前端做 React key / 勾选用 |
| `kind` | string | ✅ | 见 §3.6 封闭表 |
| `id` | string(UUID) | ✅ | **主键**。`SCORECARD_DUE` 用 `interviewer.id`（理由见 `workbench-rules.md` §2.5-C） |
| `title` | string | ✅ | 1..300 字符。**由固定模板生成**（§3.7），不含时钟/随机；**只作展示，永不用于匹配** |
| `status` | string | ✅ | 该实体的库内状态原值（如 `WAITING_HUMAN` / `SCHEDULED` / `OPEN`），**不做归一化**。理由：归一化后与库对不上，排查时无法 `grep` |
| `relation` | enum | ✅ | `OWNER` \| `REVIEWER` \| `HIRING_MANAGER` \| `INTERVIEWER` \| `AUTHOR` \| `TOUCHED` \| `UNCLAIMED`。多关系时取优先级首个 |
| `relations` | string[] | ✅ | **全部命中的关系**（≥1，含 `relation` 本身，按上述优先级排序）。单关系时长度 1 |
| `required_action` | enum | ✅ | 见 §3.6。**没有动作也必须给值**，用 `NONE`；**不许 `null`**（`null` 会让调用方分不清"不需要"和"没实现"） |
| `time_ref` | object \| null | ✅ | `{field, at, delta_hours}`。`delta_hours = round((at − evaluated_at)/3600, 1)`：**负 = 已过去（逾期/已开始），正 = 未来**。`at` 为 ISO-8601 带偏移；`field` 是产生 `at` 的库列名（`due_at` / `scheduled_start_at` / `opened_at` / `created_at` / `last_touched_at`），**写库列名，不写业务黑话** |
| `is_overdue` | boolean \| null | ✅ | 仅当存在**期限型**锚点时有值（`tasks` 的 `due_at`、`review_queue.deadline`、`approval.expires_at`）；否则 `null`。**不许**拿"面试开始时间已过"当逾期 |
| `ref` | object \| null | ✅ | `{section, id}` 跨区块互指（见 §3.8）。无互指时 `null` |
| `detail` | object | ✅ | 该 `kind` 的专属字段（§3.4/§3.5）。**不同 `kind` 的 `detail` 键集不同，但同一个 `kind` 必须恒定** |

**条目禁列**（出现即违约）：`candidate.normalized_email` / `candidate.normalized_phone` / `display_name` 之外的候选人标识（`resume_version_id` 可以，它是 id 不是 PII）；任何 `*_payload_hash`（工作台不承担审批绑定的证明职责）。

### 3.4 `unassigned.items[]` 的信封差异

| 字段 | 与 §3.3 的差异 |
|---|---|
| `relation` / `relations` | 恒为 `["UNCLAIMED"]`（不参与优先级计算） |
| `required_action` | 恒非空：`TASK_NO_OWNER`→`PROVIDE_DECISION`；`REVIEW_QUEUE_UNCLAIMED`→`RESOLVE_REVIEW_ITEM`；`APPROVAL_*`→`DECIDE_APPROVAL`；`INTAKE_NEEDS_REVIEW`→`REVIEW_INTAKE_RECORD`；`INTERVIEW_RECORD_UNASSIGNED`→`VERIFY_INTERVIEW_RECORD` |
| `why_unassigned` | **新增必填**，封闭枚举：`NO_OWNER_AND_NO_DERIVABLE_PERSON` \| `ASSIGNEE_NULL` \| `RESOURCE_TYPE_UNMAPPABLE` \| `DEPARTMENT_MANAGER_NULL` \| `NO_ASSIGNEE_COLUMN` \| `NO_INTERVIEWER_ASSIGNED` |
| `age_hours` | **新增必填**：`round((evaluated_at − time_ref.at)/3600, 1)`，即"它等了多久"。无主区最该显示的数是**等待时长**，不是"还剩多久"——它没有期限，只有年龄 |

> `age_hours = -delta_hours`。两个都给是为了让调用方**不必知道符号约定**；它们是同一个数，不一致即违约（§6 V-8）。

### 3.5 各 `kind` 的 `detail` 键集（恒定，不许有多有少）

| `kind` | 出现在 | `detail` 键 |
|---|---|---|
| `business_task` | `tasks` | `task_type`, `priority`(1..5), `due_at`, `next_run_at`, `refs`(`[{kind,id}]`) |
| `interview` | `interviews` | `interview_id`, `application_id`, `job_id`, `job_title`, `candidate_id`, `candidate_display_name`, `round_no`, `slot_code`, `scheduled_start_at`, `scheduled_end_at`, `role_in_interview`, `required_scorecard`, `needs_scorecard` |
| `job` | `jobs` | `job_id`, `code`, `department_id`, `department_name`, `current_job_version_id`, `current_rubric_version_id`, `open_application_count` |
| `application` | `applications` | `application_id`, `candidate_id`, `candidate_display_name`, `job_id`, `job_title`, `lifecycle_status`, `current_stage_code`, `last_action`, `last_touched_at` |
| `APPROVAL_PENDING` | `pending_reviews` | `resource_type`, `resource_id`, `requested_by_actor_id`, `expires_at`, `resource_title` |
| `REVIEW_QUEUE_ITEM` | `pending_reviews` | `run_id`, `source_name`, `deadline`, `completeness`, `issue_codes`（后三者不在 `review_queue` 上，须经 `review_queue.run_id → conversion_run` 取） |
| `SCORECARD_DUE` | `pending_reviews` | `interview_id`, `interviewer_id`, `required_scorecard`, `scorecard_status`(`PENDING`\|`NONE`), `scheduled_start_at` |
| `HUMAN_TASK` | `pending_reviews` | `task_type`, `priority`, `due_at` |
| `INTERVIEW_RECORD_REVIEW` | `pending_reviews` | `interview_id`, `verification_status`, `chunk_coverage`, `evidence_ok` |
| `TASK_NO_OWNER` | `unassigned` | 同 `business_task` |
| `REVIEW_QUEUE_UNCLAIMED` | `unassigned` | 同 `REVIEW_QUEUE_ITEM` |
| `APPROVAL_UNMAPPABLE` | `unassigned` | 同 `APPROVAL_PENDING` |
| `APPROVAL_NO_HIRING_MANAGER` | `unassigned` | 同 `APPROVAL_PENDING` |
| `INTAKE_NEEDS_REVIEW` | `unassigned` | `intake_record_id`, `sender_ref`, `subject`, `event_id` |
| `INTERVIEW_RECORD_UNASSIGNED` | `unassigned` | 同 `INTERVIEW_RECORD_REVIEW` |

> `SCORECARD_DUE` 的 `scorecard_status` 只有两个值：`PENDING`（已有卡行、未交）或 `NONE`（还没建卡行）。**故意不暴露 `revision_no`**：那是实现细节，工作台的读者只需要"交没交"。

### 3.6 两个封闭枚举（`relation` / `required_action`）

| `relation` | 判据（一句话） | 优先级 |
|---|---|---|
| `OWNER` | 记录本身有直接指向我的责任字段（`business_task.created_by_actor_id`） | 1（最高） |
| `REVIEWER` | 轮到我**裁定一道闸门**（`review_queue.assignee` / `approval` 待决 / `interview_record` 待校验） | 2 |
| `HIRING_MANAGER` | 我是该资源所属部门的 `department.hiring_manager_actor_id` | 3 |
| `INTERVIEWER` | `interviewer.actor_id = me` | 4 |
| `AUTHOR` | 我写了 `job_version` / `rubric_version` | 5 |
| `TOUCHED` | 只是"我最后动过"（`job.status_changed_by_actor_id` / 申请的四类 touch） | 6 |
| `UNCLAIMED` | 无主（**只**用于 `unassigned`） | — |

| `required_action` | 含义 | 算不算 `action_required_count` |
|---|---|---|
| `PROVIDE_DECISION` | 轮到人给结论（`WAITING_HUMAN` 任务 / 人工任务） | ✅ |
| `DECIDE_APPROVAL` | 批 / 驳 | ✅ |
| `RESOLVE_REVIEW_ITEM` | 处理人工队列条目（改 / 批 / 驳 / 重跑） | ✅ |
| `SUBMIT_SCORECARD` | 交面评 | ✅ |
| `VERIFY_INTERVIEW_RECORD` | 校验记录与证据 | ✅ |
| `REVIEW_INTAKE_RECORD` | 复核接入记录 | ✅ |
| `CONFIRM_CANCEL` | 确认取消请求 | ✅ |
| `WAIT` | 等外部系统（`WAITING_EXTERNAL`），**别催** | ❌ |
| `MONITOR` | 系统自己在跑（`PENDING`/`READY`/`RUNNING`/`RETRY_WAIT`） | ❌ |
| `NONE` | 纯展示（`jobs` / `applications`） | ❌ |

> `WAIT` 与 `MONITOR` **不合并且 `NONE`**：`WAIT` 要人"别去动它"，`MONITOR` 要人"看着点"，`NONE` 是"没你的事"。三者的界面文案与用户行为不同，压成一个值就会有人去手动跑一个正在等飞书回调的任务。

### 3.7 `title` 模板（固定，可断言）

| `kind` | 模板 |
|---|---|
| `business_task` / `HUMAN_TASK` / `TASK_NO_OWNER` | `business_task.title` 原值（库里有 `NOT NULL` + 长度约束，`0001_init.sql:1449`） |
| `interview` | `"{candidate_display_name} · 第{round_no}轮 · {slot_code}"` |
| `job` | `"{code} {title}"` |
| `application` | `"{candidate_display_name} · {job_title} · {current_stage_code}"` |
| `APPROVAL_*` | `"待审批：{resource_type} · {resource_title}"`（`resource_title` 取 `job.title` / `requisition.title` / `job_posting` 的岗位名；取不到写 `"（标题不可得）"`，**不许留空**） |
| `REVIEW_QUEUE_*` | `"待复核：{source_name}（{completeness}）"` |
| `SCORECARD_DUE` | `"面评待提交：{candidate_display_name} · 第{round_no}轮"` |
| `INTERVIEW_RECORD_*` | `"记录待校验：{candidate_display_name} · 第{round_no}轮"` |
| `INTAKE_NEEDS_REVIEW` | `"待复核接入：{subject or sender_ref or file_name}"`（三选一，全空则写 `intake_record` 的 id 前 8 位） |

**模板里出现 `{…}` 却取不到值时**：写 §3.7 的兜底文案，**不许**输出 `"null"` / `"undefined"` / 空串（空串会违反 1..300 的长度约束）。

### 3.8 排序（**契约的一部分**——决定 `truncated` 截掉的是哪些）

每个区块的输出顺序必须是**全序**（最后一级用主键，保证同快照下确定），否则 `truncated=true` 时"被截掉的是谁"不确定，断言无法写。

| 区块 | `ORDER BY`（升/降列名用库列名） |
|---|---|
| `tasks` | `is_overdue DESC, priority ASC, due_at ASC NULLS LAST, created_at ASC, id ASC` |
| `interviews` | `scheduled_start_at ASC NULLS LAST, id ASC` |
| `jobs` | `status_changed_at DESC, id ASC` |
| `applications` | `last_touched_at DESC, application_id ASC` |
| `pending_reviews` | `is_overdue DESC, time_ref.at ASC NULLS LAST, id ASC` |
| `unassigned` | `time_ref.at ASC NULLS LAST, id ASC`（**最老优先**：等最久的最该先被看见） |

### 3.9 `warnings[]`（不改变 `status`，不拦截）

| `code` | 何时 | 影响 |
|---|---|---|
| `ACTOR_DISABLED` | `actor.status='DISABLED'` | **照常出结果**。不拦截的理由：D-33 明确"不校验 actor"，把 DISABLED 变成错误就是一次权限检查 |
| `ACTOR_NOT_HUMAN` | `actor.kind ∈ {SYSTEM, AGENT_WORKER}` | 照常出结果；大多数区块会是 0（系统账号不建任务也不当面试官）。**不许**返回 `NOT_FOUND`：这条 actor 真的存在 |
| `ACTOR_NO_DEPARTMENT` | `actor.department_id IS NULL` | `HIRING_MANAGER` 派生永远不命中；提示"你可能缺岗位视图" |
| `UNASSIGNED_TRUNCATED` | `unassigned.count > UNASSIGNED_LIMIT` | 提示"积压超过 20 条，只显示了最老的 20 条" |

`warnings[]` 元素的形状：`{code, message}`，`message` 是一句中文。**`warnings` 不得为空数组以外的 `null`**。

---

## 4. 错误码（2 个，封闭集）

### 4.1 `INVALID_ARGS`（7 个 `reason_code`）

| `reason_code` | 何时 | `detail` |
|---|---|---|
| `MISSING_REQUIRED` | 缺 `actor_id` | `{missing:["actor_id"]}` |
| `UNKNOWN_PARAM` | 出现未声明键 | `{unknown:["include_unassigned"], allowed:["actor_id","sections"]}` |
| `TYPE_MISMATCH` | 类型不对（`actor_id: 123` / `sections: "tasks"`） | `{path:"sections", expected:"string[]", got:"string"}` |
| `ID_NOT_UUID` | `actor_id` 不是 UUID 文本 | `{field:"actor_id", got:"u_001"}` |
| `UNKNOWN_SECTION` | `sections` 含未知值 | `{unknown:["task"], allowed:["tasks","interviews","jobs","applications","pending_reviews"]}` |
| `EMPTY_SECTIONS` | `sections: []` | `{field:"sections"}` |
| `DUPLICATE_SECTION` | `sections` 含重复值 | `{duplicated:["tasks"]}` |

```text
Error: INVALID_ARGS: {"code":"INVALID_ARGS","detail":{"allowed":["actor_id","sections"],"unknown":["include_unassigned"]},"message":"未声明的参数 include_unassigned；本工具不接受关闭 unassigned（workbench-rules §3.3）","reason_code":"UNKNOWN_PARAM"}
```

### 4.2 `NOT_FOUND`（1 个 `reason_code`）

| `reason_code` | 何时 | `detail` |
|---|---|---|
| `ACTOR_NOT_FOUND` | `actor` 表里没有这个 id | `{actor_id:"…"}` |

```text
Error: NOT_FOUND: {"code":"NOT_FOUND","detail":{"actor_id":"0199c0de-0000-7000-8000-00000000ffff"},"message":"actor 不存在","reason_code":"ACTOR_NOT_FOUND"}
```

**只有这两种。** 特别地：

| 情形 | **不是**错误 |
|---|---|
| 五个区块全 0 | `status="OK"`（新人本来就可能没活） |
| `unassigned` 全 0 | `status="OK"` |
| `actor.status='DISABLED'` | `status="OK"` + warning |
| actor 属于别的租户 | **不存在这个概念**：租户由 actor 推出，没有"调用方租户"可供越界 |

---

## 5. 出参的必填性（`output.schema` 用官方强制子集表达）

`required` 必须包含：`tool` / `contract_version` / `status` / `read_only` / `labels` / `evaluated_at` / `actor` / `sections` / `unassigned` / `warnings`。
`sections` 的 `required` 只能是 `tasks, interviews, jobs, applications, pending_reviews` 的**子集**（按入参），但 `properties` 必须**声明全部 5 个**（否则"未请求的键不出现"无法与 `additionalProperties:false` 共存）。
`additionalProperties: false` 在**每一层**都要显式写：顶层、`actor`、`sections.*`、`unassigned`、`items[]`、`time_ref`、`ref`、`detail`（按 `kind` 用 `oneOf` 分派）。

---

## 6. 十二条必守性质（全部可机检）

| # | 性质 | 怎么检 |
|---|---|---|
| **V-1** | **只读** | 静态扫描无写关键字；调用前后 `select sum(record_version)` 对 `business_task`/`application`/`review_queue`/`interview` 四表**不变** |
| **V-2** | **`unassigned` 恒在** | `sections:["jobs"]` 时响应里 `unassigned` 仍存在且 `count` 与全量调用一致 |
| **V-3** | **未请求 ≠ 空** | `sections:["jobs"]` 时响应 `sections` 只有 `jobs` 一个键；`"tasks" in sections == false` |
| **V-4** | **计数自洽** | 每个区块 `items.length == min(count, limit)` 且 `truncated == (count > limit)`；不满足即违约 |
| **V-5** | **幂等（含时钟口径）** | 同一 `evaluated_at` + 同一快照连调两次 → 除 `warnings` 顺序外**逐字节相同**（`evaluated_at` 需可注入才能测；见 §1.4-D1 的裁决项） |
| **V-6** | **区块内 id 唯一** | 每个区块内 `items[].id` 无重复（跨区块**允许**重复，那是不同视角；跨区块互指须给 `ref`，见 §3.3） |
| **V-7** | **枚举封闭** | `relation` / `required_action` / `why_unassigned` 只出现 §3.4/§3.6 列出的值 |
| **V-8** | **年龄与增量同源** | `unassigned.items[].age_hours == -time_ref.delta_hours`（四舍五入后） |
| **V-9** | **不泄露联系方式** | 输出全文 grep `@` 与手机号正则 → 0 命中（`display_name` 除外，它不含 `@`） |
| **V-10** | **状态原值** | `items[].status` ∈ 该表 `CHECK` 的取值集合；出现 `"PENDING "`（带空格）或小写化 → 违约 |
| **V-11** | **`title` 非空** | 每个 `items[].title` 长度 ∈ 1..300，且不含 `"null"` / `"undefined"` |
| **V-12** | **错误体可解析** | 每类错误的消息体在 `Error: <CODE>: ` 之后可 `JSON.parse`，键序字典序 |

---

## 7. 与其它工具的关系（边界，不是替代）

| 工具 | 工作台与它的关系 |
|---|---|
| `recruitment_job_get` | 工作台给 `job_id` 与 `relation`；**岗位详情、Rubric 版本、JD 正文一律去那边拿**。工作台不重复返回 `description_md` |
| `recruitment_screening_evaluate` | 工作台的 `applications` 区块**不产生**筛选建议，也**不阻断**在人工队列上。要评估就调那个工具，它会自己抛 `BLOCKED_BY_REVIEW` |
| `recruitment_candidate_get` | 候选人档案（含脱敏联系方式）在那边；工作台只给 `candidate_id` + `display_name` |
| 未来的 list / search 工具 | "看全部"走那边（§4 推论 1）。**工作台不加 `scope=all`** |
| 写侧（认领 / 转派 / 提交面评） | 不在本工具。本工具不提供任何 `write` 型 `required_action` 的执行能力——它只说"要做什么"，**不说"我已替你做了"** |

---

## 8. 验收清单

### 8.1 形状层

| # | 输入 | 期望 |
|---|---|---|
| 1 | `{}` | `INVALID_ARGS(MISSING_REQUIRED)` |
| 2 | `{"actor_id":"u_001"}` | `INVALID_ARGS(ID_NOT_UUID)` |
| 3 | `{"actor_id":"<有效>","tenant_id":"…"}` | `INVALID_ARGS(UNKNOWN_PARAM)`，`allowed=["actor_id","sections"]` |
| 4 | `{"actor_id":"<有效>","include_unassigned":false}` | `INVALID_ARGS(UNKNOWN_PARAM)` —— **这条是"不隐藏积压"的机检入口** |
| 5 | `{"actor_id":"<有效>","sections":[]}` | `INVALID_ARGS(EMPTY_SECTIONS)` |
| 6 | `{"actor_id":"<有效>","sections":["task"]}` | `INVALID_ARGS(UNKNOWN_SECTION)`，`allowed` 5 值 |
| 7 | `{"actor_id":"<有效>","sections":["tasks","tasks"]}` | `INVALID_ARGS(DUPLICATE_SECTION)` |
| 8 | `{"actor_id":"0199c0de-0000-7000-8000-00000000ffff"}` | `NOT_FOUND(ACTOR_NOT_FOUND)` |
| 9 | 全部错误体 | 单行、`JSON.parse` 通过、键序字典序 |

### 8.2 语义层（实现最容易做错的 8 个探针）

| # | 探针 | 期望 | 典型错法 |
|---|---|---|---|
| **P1** | `sections:["jobs"]`，库里有 3 条无主积压 | 响应里 `unassigned.count=3`（**照常**） | 把 `unassigned` 也当第六个 section 一起过滤 → 积压消失 |
| **P2** | 新人，五块全 0 | `status="OK"`，五块都在（未指定 `sections` 时），`items=[]`、`count=0` | 返回 `NOT_FOUND` / `null` / 省略空区块 |
| **P3** | `WAITING_HUMAN` 但 `created_by_actor_id` 为空、refs 为空 | 出现在**所有人**的 `unassigned`，不出现在任何人的 `tasks` | 归给部门用人经理（等于发明了一条指派规则） |
| **P4** | 面试官没写 `role_in_interview`（默认 `INTERVIEWER`） | 其 `interviews` 照常出现 | 用 `role_in_interview='HIRING_MANAGER'` 过滤 → 漏人 |
| **P5** | 同一申请有 4 类 touch（stage / lifecycle / decision / scorecard） | `applications.count=1` | 4 条（`union all` 后忘了 `group by`） |
| **P6** | 同一岗位命中 `HIRING_MANAGER` + `INTERVIEWER` | `jobs.count=1`，`relations` 长度 2 | 2 条 |
| **P7** | `business_refs` 含 `{"kind":"INTERVIEW","id":"not-a-uuid"}` | 该 ref 视为不匹配，**不报错** | 抛 `22P02`，整次调用 500 |
| **P8** | `approval.resource_type='DECISION'` 且 `PENDING` | 进 `unassigned`（`why=RESOURCE_TYPE_UNMAPPABLE`） | 算给申请人（`requested_by_actor_id` 语义反了） |

### 8.3 证据层

| # | 检查 | 期望 |
|---|---|---|
| 1 | `labels` 三维 | `LIVE` / `MANUAL` / `CONNECTED`，且**没有** `FIXTURE` 分支 |
| 2 | 输出 grep `FIXTURE` | 0 命中 |
| 3 | 输出 grep `@` | 0 命中（V-9） |
| 4 | 调用前后四表 `record_version` 之和 | 不变（V-1） |
| 5 | 与 `workbench-rules.md` §6 三用例 | 建夹具 `F-WB-A/B/C` 后逐条对齐；**不建夹具不算通过** |

---

## 9. 本文件明确不规定的事

| 不规定 | 归谁 |
|---|---|
| 归属谓词本身 | `workbench-rules.md`（本文件只引用） |
| SQL 怎么写、要不要视图/缓存 | 实现方；**禁止**在工具层拼字符串 |
| 分页 / 游标 | v1.0 不做（常量上限足够）。要分页先改 `SECTION_LIMIT` 的语义并 bump 版本 |
| 界面怎么排、`unassigned` 折叠还是置顶 | 前端。契约只保证**拿得到** |
| 认领动作 | 写侧工具（`review_queue.assignee` 的更新受 `fn_review_queue_before_update` + `SET LOCAL recruitment.actor_id` 约束） |
| 将来开权限后 `actor_id` 从哪来 | 另一份 ADR。**开权限前必须先有调用方身份**，而不是继续信入参 —— 见下面这条风险 |

---

## 10. 风险登记（与 D-33 的风险登记同一条脉络）

| # | 风险 | 现状 | 将来必须补 |
|---|---|---|---|
| **W-1** | **任何知道 `actor` UUID 的调用方，都能拿到那个人的工作台**。因为 `actor_id` 是入参而不是调用方身份 | **v1.0 接受**：本来全部数据全局可见（D-33），工作台给不出比全局查询更多的东西 | 开权限时，`actor_id` 必须来自**会话身份**，不能来自入参。**在此之前不得写一个永远返回 true 的 `can()`**（D-33 原文） |
| **W-2** | 工作台对"无主积压"只有一个 20 条的窗口 | 有 `truncated` + `warnings` 提示 | 积压 > 20 时需要一个真正的认领界面（写侧），不是靠调大 `limit` |
| **W-3** | `business_task` 用 `created_by_actor_id` 当责任人，创建者 ≠ 责任人时无解 | `workbench-rules.md` §7 缺口 8 | `0005` 加 `business_task.owner_actor_id`（**不要**扩展 `business_refs.kind`，那会与 `screening-rules.md` §6.2 冲突） |
| **W-4** | 与兄弟契约的"无时钟"冲突（§1.4-D1） | 本契约显式记录并给出回退方案 | 总控裁决后回抄；**不允许两套口径并存而无记录**（R5） |

**版本变更**：新增区块 / 新增 `kind` / 新增 `reason_code` → `1.1.0`；`relation` / `required_action` / `why_unassigned` 枚举变化，或 `sections` 语义变化 → `2.0.0`（下游会断）。
