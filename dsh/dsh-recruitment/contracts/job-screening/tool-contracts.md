# tool-contracts.md · S3/S8 两个工具的形状

**版本**：`tool-contracts 1.0.0`（与 `job-rubric 1.0.0` / `screening 1.0.0` 同一基线）
**日期**：2026-11-13
**范围**：**只写契约**——入参、出参、错误码、必守性质。**不含任何实现**（不写 SQL、不写 TS）
**规则来源**：`job-rubric-rules.md`（标准解析）、`screening-rules.md`（判定算法）。**本文件与那两份冲突时，以那两份为准**——这里只是形状。

---

## 0. 两个工具的边界（先划死，再谈字段）

| 工具 | 一句话 | 读 | 写 | 能产 `decision` 吗 |
|---|---|---|---|---|
| `recruitment_job_get` | 查一个岗位 + 它此刻适用的 Rubric 版本 | 库 | **无** | 否 |
| `recruitment_screening_evaluate` | 对**一个申请**做一次筛选评估，产出**带证据的建议** | 库 | **无** | **否**（`advisory: true`） |

**四个"永远不做"**（每个都有对应的库约束或红线）：

1. 不落决策：工具输出里没有 `decided_by_actor_id`，也没有 `decision` 的任何一个必填字段（`ck_decision_reason`/`INV-9`）。
2. 不钉 Rubric 版本：`application.rubric_version_id` 只读（`job-rubric-rules.md` §4.3）。
3. 不清人工队列：`business_task.status` / `resume_version.parse_status` 一个都不改（`screening-rules.md` §6.4、`APP-07`）。
4. 不接受模型传入的 `tenant_id` / `actor_id`：租户与身份**只能**来自执行上下文（`SET LOCAL recruitment.actor_id`，`INV-8`、`XINV-7`）。入参里出现这两个键 → `INVALID_ARGS`（不是静默忽略）。

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

**本契约新增第 8 条**：`string` 类型的 id 必须是 **UUID 文本形式**（`^[0-9a-fA-F]{8}-…$`，小写化后比对）。`job_0001` 这类 stub id **不是合法 UUID** → `INVALID_ARGS(reason_code='ID_NOT_UUID')`。这是与现有 stub 的**故意不兼容**（见 §4）。

### 1.2 错误消息格式（**替换** `CONTRACT.md` §2.2 的散文格式）

```text
Error: <CODE>: <compact-json>
```

`<compact-json>` 的键（`code` 在消息里出现两次是刻意的：一次给 grep，一次给 JSON 解析）：

| 键 | 必填 | 说明 |
|---|---|---|
| `code` | ✅ | 与消息前缀同一个值 |
| `reason_code` | ✅ | 该错误码下的**封闭枚举**（§3.2–§3.5） |
| `message` | ✅ | 一句给人看的中文说明 |
| `detail` | 视 code | 结构化明细（如 `blocking_items[]`、`violations[]`、`allowed[]`） |

**为什么要在消息体里塞 JSON**：`CONTRACT.md` §0 已证实本包**拿不到结构化 `error.info`**（无法 import `HarnessError`）。所以把结构放进 message 是当前唯一能同时让模型和日志读到稳定 code 的办法。JSON 必须**单行、键序稳定（字典序）**，便于断言。

### 1.3 只读、无时钟、幂等

| 性质 | 要求 |
|---|---|
| 只读 | 源码不出现 `INSERT`/`UPDATE`/`DELETE`/`fs`/`fetch`/子进程（沿用 `CONTRACT.md` §6 的静态扫描口径） |
| 无时钟 | 输出**不含** `evaluated_at`/`now`；唯一时间输入是显式 `as_of`，且原样回显 |
| 幂等 | 同一 `(args, 数据快照)` → 除 `evaluation_digest` 外逐字节相同 |
| 并发安全 | 声明 `isConcurrencySafe: true`（纯读） |

### 1.4 三维标签（R4，逐工具给语义，禁止混用一维枚举）

| 维度 | 取值 | `recruitment_job_get` 的含义 | `recruitment_screening_evaluate` 的含义 |
|---|---|---|---|
| `provenance` | `LIVE` \| `FIXTURE` | `LIVE` = 数据来自真实数据库行；**不**断言岗位在业务上真实 | `LIVE` = 简历材料可追到 `event_inbox.provider ≠ 'internal'` 的真实链路；否则 `FIXTURE` |
| `trigger` | `MANUAL` | 模型/人在会话里调用 | 同左 |
| `connection` | `CONNECTED` \| `NOT_CONNECTED` | `CONNECTED` = 直连业务库 | 同左（**与外部连接器无关**） |

`evaluate` 的 `provenance` 判定式（可机检，`job-rubric-rules.md` §8 S-5 之外唯一用到的链路）：

```
provenance = 'LIVE'
  ⟺ 存在链路 resume_version → resume → intake_asset → intake_record → event_inbox
    且 event_inbox.provider <> 'internal'
  否则 'FIXTURE'
```

> **不因 `provenance='FIXTURE'` 就降级 `verdict`**：本工具只贴标签，不据此改判。是否允许 fixture 数据产生真实决策，由 D-1（demo gate 需 `provenance=LIVE`）在**写侧**决定。这条边界必须写死，否则会出现"演示数据被判成不合格"或"合成数据冒充真实通过"两种事故。

---

## 2. `recruitment_job_get`

### 2.1 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `job_id` | string | ✅ | UUID，≤36 | 岗位 id |
| `rubric_version_no` | integer | — | 1..1000 | 指定版本号（从小到大 1 起） |
| `rubric_version_id` | string | — | UUID | 指定版本 id |
| `as_of` | string | — | ISO-8601 带时区偏移（如 `2026-11-13T00:00:00+08:00`），**不得晚于服务端 now** | 用来确定"此刻的当前版本" |

**互斥**：`rubric_version_no` 与 `rubric_version_id` 同时给 → `INVALID_ARGS`。都不给 → 返回**当前版本**。

### 2.2 出参

```json
{
  "tool": "recruitment_job_get",
  "contract_version": "1.0.0",
  "labels": { "provenance": "LIVE", "trigger": "MANUAL", "connection": "CONNECTED" },
  "as_of": "2026-11-13T00:00:00+08:00",
  "job": {
    "id": "…", "code": "BE-001", "title": "后端工程师",
    "status": "OPEN",
    "department_id": "…", "requisition_id": "…",
    "current_job_version_id": "…",
    "record_version": 3,
    "status_changed_at": "2026-11-10T09:00:00+08:00"
  },
  "job_version": {
    "id": "…", "version_no": 2, "payload_hash": "…",
    "description_md": "…", "requirements_md": "…",
    "approved_by_approval_id": "…"
  },
  "rubric": {
    "version_id": "…", "version_no": 2, "payload_hash": "…",
    "is_current": true, "is_approved": true,
    "approved_by_approval_id": "…", "created_by_actor_id": "…",
    "created_at": "2026-11-11T10:00:00+08:00",
    "resolution": "JOB_CURRENT",
    "criteria": [
      { "key": "backend_years", "label": "后端方向 5 年以上", "kind": "MUST_HAVE",
        "weight": 0.4, "field": "timeline.covered_months_closed",
        "operator": "GTE", "value": 60, "question": null, "notes": "…" },
      { "key": "team_lead", "label": "有带团队经验", "kind": "NICE_TO_HAVE",
        "weight": 0.4, "field": null, "operator": null, "value": null,
        "question": "是否有 ≥1 年、≥3 人的直接带团队经历？", "notes": null },
      { "key": "notice_period", "label": "到岗时间不超过 60 天", "kind": "DISQUALIFIER",
        "weight": 0.2, "field": null, "operator": null, "value": null,
        "question": "期望到岗时间是否超过 60 天？", "notes": null }
    ],
    "criteria_count": 3, "must_have_count": 1, "nice_to_have_count": 1,
    "disqualifier_count": 1, "executable": true
  },
  "rubric_absence": null,
  "rubric_versions": [
    { "version_no": 1, "version_id": "…", "is_current": false, "is_approved": true,
      "created_at": "…" },
    { "version_no": 2, "version_id": "…", "is_current": true,  "is_approved": true,
      "created_at": "…" }
  ]
}
```

### 2.3 字段规则

| 字段 | 规则 |
|---|---|
| `rubric.criteria[]` | **逐字回显 `rubric_version.dimensions` 的元素**，一个键都不许增删改。禁止在这里"顺便归一化"——一旦归一化，工具输出与库里的 `payload_hash` 就对不上，审批绑定失效（`job-rubric-rules.md` §6.6） |
| `rubric.is_current` | `version_id == current(job_id, as_of)`；没有可用当前版本时**全部** `false` |
| `rubric.is_approved` | §4.2 的 `approved(v, as_of)` 判定式 |
| `rubric.resolution` | `EXPLICIT_VERSION_NO` \| `EXPLICIT_VERSION_ID` \| `JOB_CURRENT`（与 `evaluate` 的 `APPLICATION_PINNED` **不是同一套枚举**，刻意区分：查岗位永远不带申请） |
| `rubric.executable` | `true` ⇔ 通过 `R-VAL-1..13`（纯结构校验，只看 `dimensions`）。`R-VAL-14`（`payload_hash` / 审批一致性）**不在这里判**，它的结果只体现在 `is_approved`。本工具**不因** `executable=false` 报错——那是 `evaluate` 的事 |
| `rubric` / `rubric_absence` | **恰好一个为 `null`**。两者同时 `null` 或同时非 `null` = 违约 |
| `job_version` | 取 `job.current_job_version_id` 指向的行；为空则 `null` |

### 2.4 `rubric_absence`（**本工具不因缺标准而报错**）

```json
{
  "code": "NO_RUBRIC_AT_ALL",
  "message": "该岗位还没有任何 Rubric 版本",
  "violations": []
}
```

`code` 封闭集：`NO_RUBRIC_AT_ALL` \| `NO_APPROVED_RUBRIC` \| `RUBRIC_INVALID`。`RUBRIC_INVALID` 时 `violations[]` 列出 `R-VAL-*` 的失败项（`{rule:"R-VAL-8", reason_code:"CRITERION_FIELD", path:"dimensions[2].field", got:"skills.k8s"}`）。

> **为什么 `job_get` 不抛 `NO_RUBRIC`**：它是**描述世界**的工具，不是执行工具。"没有标准"是关于这个岗位的一条事实，应该能被查出来；把它变成错误，会让"查岗位"在新建岗位时直接不可用。**拒绝执行**是 `evaluate` 的职责。

### 2.5 错误

只可能两种（其余一律 `INVALID_ARGS`）：

| `code` | `reason_code` | 何时 |
|---|---|---|
| `INVALID_ARGS` | `UNKNOWN_PARAM` \| `TYPE_MISMATCH` \| `MISSING_REQUIRED` \| `OUT_OF_RANGE` \| `MUTUALLY_EXCLUSIVE` \| `ID_NOT_UUID` \| `AS_OF_IN_FUTURE` \| `TENANT_OR_ACTOR_NOT_ALLOWED` | 见 §1.1 |
| `NOT_FOUND` | `JOB_NOT_FOUND` \| `RUBRIC_VERSION_NOT_FOUND` | `job_id` 无行；`version_no`/`version_id` 在该岗位下无行 |

```text
Error: NOT_FOUND: {"code":"NOT_FOUND","reason_code":"RUBRIC_VERSION_NOT_FOUND","message":"岗位 0199… 下没有 Rubric v9（现有：v1, v2）","detail":{"job_id":"0199…","requested_version_no":9,"known_version_nos":[1,2]}}
```

### 2.6 正例（可当验收样例）

```text
recruitment_job_get {"job_id":"0199c0de-0000-7000-8000-000000000001"}
→ job BE-001 后端工程师 [OPEN]  (labels: LIVE/MANUAL/CONNECTED)
  job_version v2  hash=3f2a… approved_by_approval_id=…
  rubric v2 (is_current=true, is_approved=true, resolution=JOB_CURRENT, executable=true)
    backend_years  [MUST_HAVE]      w=0.4  timeline.covered_months_closed GTE 60
    team_lead      [NICE_TO_HAVE]   w=0.4  (judgment) "是否有 ≥1 年、≥3 人的直接带团队经历？"
    notice_period  [DISQUALIFIER]   w=0.2  (judgment) "期望到岗时间是否超过 60 天？"
  versions: v1(is_current=false), v2(is_current=true)
```

---

## 3. `recruitment_screening_evaluate`

### 3.1 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `application_id` | string | ✅ | UUID | 评估对象是**申请**，不是"候选人 × 岗位"（`INV-1`） |
| `resume_version_id` | string | — | UUID | 指定材料版本；缺省取 `application.resume_version_id` |
| `rubric_version_id` | string | — | UUID | 指定标准版本（= `what_if`）；缺省按 `job-rubric-rules.md` §4.3 解析 |
| `as_of` | string | — | ISO-8601 带偏移，不得晚于 now | 时间相关判定的基准（审批过期、当前版本） |

**四条硬约束**：

1. `resume_version_id` 若不等于 `application.resume_version_id`，**必须**同时满足：该版本属于同一 `candidate`（`resume.candidate_id = application.candidate_id`），否则 `INVALID_ARGS(RESUME_NOT_BELONG_TO_CANDIDATE)`。`resume.candidate_id` 为空 → `BLOCKED_BY_REVIEW(MATERIAL_ATTRIBUTION_UNKNOWN)`（不许"大概是他的"）。
2. `rubric_version_id` 若不等于 `application.rubric_version_id`，输出**必须**标 `rubric.what_if = true`（`job-rubric-rules.md` §4.4）。
3. **绝不自动挑"最新简历"**（`D11 §9.8`：不得静默合并/择一）。多个材料版本并存时，只认 `application.resume_version_id` 或入参显式指定。
4. 不接受 `candidate_id` / `job_id` 入参（会诱导"绕过申请"这条唯一合法入口，破坏 `INV-1`）。

### 3.2 出参（完整形状）

```json
{
  "tool": "recruitment_screening_evaluate",
  "contract_version": "1.0.0",
  "status": "OK",
  "advisory": true,
  "read_only": true,
  "labels": { "provenance": "LIVE", "trigger": "MANUAL", "connection": "CONNECTED" },
  "as_of": "2026-11-13T00:00:00+08:00",

  "application": {
    "id": "…", "job_id": "…", "candidate_id": "…",
    "job_version_id": "…", "rubric_version_id": "…",
    "lifecycle_status": "ACTIVE", "current_stage_code": "SCREENING",
    "stage_blocked_reason": null, "record_version": 7
  },
  "job": { "id": "…", "title": "后端工程师", "status": "OPEN" },
  "resume_version": {
    "id": "…", "version_no": 1, "parse_status": "PARTIAL",
    "source_asset_sha256": "…", "content_sha256": "…",
    "parser_name": "pymupdf", "parser_version": "1.28.0",
    "page_count": 3, "hard_issue_count": 2
  },
  "rubric": {
    "version_id": "…", "version_no": 2, "payload_hash": "…",
    "is_current": true, "is_approved": true,
    "resolution": "APPLICATION_PINNED",
    "what_if": false, "rubric_pin_required": false,
    "criteria_count": 3
  },

  "preconditions": {
    "human_queue_checked": 7,
    "human_queue_clear": true,
    "material_bound": true,
    "material_ready": true,
    "rubric_approved": true
  },

  "verdict": "NEEDS_REVIEW",
  "verdict_summary": "1 条硬性条件已满足（闭区间已覆盖 74 个月）；1 条硬性条件读不出（教育章节存在但切不出条目）→ 需人工复核",
  "criteria_evaluated": true,
  "required_human_action": "REVIEW_UNREADABLE",

  "reasons": [
    {
      "code": "MUST_HAVE_SATISFIED",
      "failure_class": "HARD_PASS",
      "criterion_key": "backend_years",
      "kind": "MUST_HAVE",
      "outcome": "SATISFIED",
      "field": "timeline.covered_months_closed",
      "tri_state": "present",
      "bounds": "LOWER_BOUND",
      "expected": { "operator": "GTE", "value": 60, "unit": "MONTH" },
      "observed": { "value": 74, "lower_bound": 74, "upper_bound": null },
      "evidence": [
        { "resume_version_id": "…", "source_asset_sha256": "…",
          "page": 1, "bbox": [72.0, 248.0, 523.0, 271.2],
          "block": 9, "quote": "2019.03 - 至今  XX 科技  后端工程师",
          "provenance": "native_text" }
      ],
      "absence": null,
      "issue_codes": [],
      "message": "闭区间已覆盖 74 个月（≥60），即使开放区间不计入也已满足"
    },
    {
      "code": "MUST_HAVE_UNREADABLE",
      "failure_class": "UNREADABLE",
      "criterion_key": "edu_verifiable",
      "kind": "MUST_HAVE",
      "outcome": "UNREADABLE",
      "field": "education",
      "tri_state": "unreadable",
      "bounds": null,
      "expected": { "operator": "EXISTS", "value": true, "unit": null },
      "observed": null,
      "evidence": [],
      "absence": null,
      "issue_codes": ["resume_attribution_unverified"],
      "message": "教育章节存在但无法切出条目（entries_not_segmentable），字段保持 unreadable；不得据此判定不满足"
    }
  ],

  "bonus_signals": [
    { "code": "BONUS_SATISFIED", "failure_class": "HARD_PASS",
      "criterion_key": "team_lead", "kind": "NICE_TO_HAVE", "outcome": "SATISFIED",
      "field": null, "tri_state": "present", "bounds": null,
      "expected": null, "observed": null,
      "evidence": [ { "…": "…" } ], "absence": null, "issue_codes": [],
      "message": "第 2 页有「技术负责人，带 5 人」可直接引用" }
  ],

  "warnings": [
    { "code": "ABSENT_DOWNGRADED",
      "message": "材料 parse_status=PARTIAL 且有 2 个 HARD issue，上游给的 absent 已降级为 unreadable",
      "ref": { "field": "education", "source": "parsed_fields.fields.education.state" } }
  ],

  "snapshot": {
    "application_record_version": 7,
    "resume_version_id": "…",
    "resume_content_sha256": "…",
    "rubric_version_id": "…",
    "rubric_payload_hash": "…"
  },
  "prior_screening": null,
  "evaluation_digest": "9c1e…"
}
```

### 3.3 字段规则

| 字段 | 规则 | 依据 |
|---|---|---|
| `status` | 恒为 `"OK"`（成功路径没有别的值）。它存在的唯一理由：让调用方不必靠"有没有 `verdict`"来判断成功与否 | — |
| `verdict` | `PASS` \| `FAIL` \| `NEEDS_REVIEW`，**CI 只认这三个值**（大小写敏感） | `screening-rules.md` §5 |
| `verdict_summary` | 由**固定模板**生成的单行中文摘要（数量 + 决定性原因），不含时钟/随机；只供展示，**判定以 `verdict` + `reasons[]` 为准** | — |
| `reasons[]` | **只装决定性条目**。`criteria_evaluated=true` 时条数 = `must_have_count + disqualifier_count`；`false` 时只装 GATE 条目（1 条起） | `screening-rules.md` §7.3 |
| `bonus_signals[]` | 只装 `NICE_TO_HAVE`，**与 `reasons[]` 同一 schema**（一个序列化器，两个数组） | `screening-rules.md` §5 V-3 |
| `reasons[].tri_state` | **只能** `present` \| `absent` \| `unreadable` \| `null`（`null` 仅当 `outcome='NEEDS_JUDGMENT'`）；出现第四个值 = 违约 | `D11 §9.2`、`screening-rules.md` §3.1 |
| `reasons[].evidence[]` | `tri_state='present'` 时 ≥1 条；`absent`/`unreadable` 时可空，但必须分别给 `absence` / `issue_codes[]` | `screening-rules.md` §8.2 |
| `preconditions.human_queue_checked` | 本次执行的阻断查询条数，当前必须 **= 7**（`screening-rules.md` §6.2 HQ-1…HQ-7）。**缺这个字段等于无法证明检查发生过** | `screening-rules.md` §6.3 |
| `criteria_evaluated` | GATE 命中时为 `false`，此时 `reasons[]` 只有 GATE 条目 | `screening-rules.md` §5 STEP 1 |
| `required_human_action` | 封闭枚举，见 `screening-rules.md` §9；按优先级取最大 | `screening-rules.md` §9 |
| `snapshot` | 写侧落 `decision` 前必须比对；不一致 → 重评，不得沿用 `evaluation_digest` | `screening-rules.md` §11 D-4 |
| `evaluation_digest` | `sha256(canonical_json({args, resolved_ids, rubric_payload_hash, resume_content_sha256, verdict, reasons}))`，小写 hex | `screening-rules.md` §11 D-3 |
| `prior_screening` | 已存在 `decision(scope='SCREENING')` 且未被 supersede 时回显 `{decision_id, result, rubric_version_id, decided_at}`；否则 `null`。**只读回显，不比较、不评价** | `INV-9` |

### 3.4 错误码（4 个，**封闭集**）

| `code` | 何时 | 有没有 `verdict` |
|---|---|---|
| `BLOCKED_BY_REVIEW` | §3.5 的 7 条阻断检查任一命中，**或** §3.1 第 1 条的"材料归属未知" | **无**（连 `NEEDS_REVIEW` 都不给） |
| `NO_RUBRIC` | 无可用/不可执行的 Rubric | 无 |
| `NOT_FOUND` | 申请 / 材料版本 / 标准版本不存在 | 无 |
| `INVALID_ARGS` | 参数层问题 | 无 |

> **这一层必须想清楚**：`BLOCKED_BY_REVIEW` 与 `NEEDS_REVIEW` **不是程度差异，是性质差异**。
> `BLOCKED_BY_REVIEW` = "**现在不该判**"（有人在处理 / 材料没就绪）→ 出任何 `verdict` 都是越权；
> `NEEDS_REVIEW` = "**判了，但判不出**"→ 必须出 `verdict`，因为下游要知道"这次评估的结论是需要人工"。

### 3.5 `BLOCKED_BY_REVIEW` 的 7 个 `reason_code`

| `family` | `reason_code` | 触发条件（详见 `screening-rules.md` §6.2） |
|---|---|---|
| `HUMAN_QUEUE` | `HUMAN_TASK_WAITING` | HQ-1：`business_task.status='WAITING_HUMAN'` 且 `business_refs` 指向该 application/candidate/resume_version |
| `HUMAN_QUEUE` | `PARSE_NEEDS_REVIEW` | HQ-2：`resume_version.parse_status='NEEDS_REVIEW'` |
| `HUMAN_QUEUE` | `INTAKE_NEEDS_REVIEW` | HQ-3：`intake_record.status='NEEDS_REVIEW'` |
| `MATERIAL` | `MATERIAL_PARSE_FAILED` | HQ-4：`resume_version.parse_status='FAILED'` |
| `MATERIAL` | `MATERIAL_NOT_READY` | HQ-5：`parse_status ∈ {'PENDING','PARSING'}` |
| `MATERIAL` | `MATERIAL_NOT_BOUND` | HQ-6：申请未绑材料且入参未给 |
| `MATERIAL` | `INTAKE_ASSET_INVALID` | HQ-7：`intake_asset.validation_status='INVALID'` |

> **第 8 个 `reason_code`**：`MATERIAL_ATTRIBUTION_UNKNOWN` 由 §3.1 第 1 条（显式传入的材料版本归属未知）触发，**不属于**上面 7 条阻断检查。所以 `BLOCKED_BY_REVIEW` 的 `reason_code` 枚举共 **8** 个，而 `preconditions.human_queue_checked` 恒为 **7**（两者不要混为一谈）。

错误体（`blocking_items` **至少 1 项**，空数组 = 违约）：

```text
Error: BLOCKED_BY_REVIEW: {"code":"BLOCKED_BY_REVIEW","reason_code":"HUMAN_TASK_WAITING","family":"HUMAN_QUEUE","message":"该候选人有一条待人工处理的任务，筛选不得越过它出结论","detail":{"application_id":"0199…","blocking_items":[{"code":"HUMAN_TASK_WAITING","family":"HUMAN_QUEUE","ref_kind":"CANDIDATE","ref_id":"0199…","task_id":"0199…","task_type":"RESOLVE_IDENTITY_CONFLICT"}]}}
```

### 3.6 `NO_RUBRIC` 的 5 个 `reason_code`

| `reason_code` | 触发 | `detail` |
|---|---|---|
| `NO_RUBRIC_AT_ALL` | 该岗位 0 个 Rubric 版本 | `{job_id}` |
| `NO_APPROVED_RUBRIC` | 有版本但 `approved(as_of)` 全为假（`job-rubric-rules.md` §4.2） | `{job_id, versions:[{version_no,status}]}` |
| `RUBRIC_JOB_MISMATCH` | `application.rubric_version_id` 或入参版本不属于 `application.job_id` | `{application_job_id, rubric_job_id, rubric_version_id}` |
| `RUBRIC_INVALID` | `R-VAL-1..14` 任一失败（`violations[].reason_code` 取 `R-VAL` 行右列的码，含 `RUBRIC_HASH_MISMATCH`） | `{violations:[{rule,reason_code,path,got}]}` |
| `UNSUPPORTED_PAYLOAD_SCHEMA_VERSION` | `approval.payload_schema_version ≠ 1` | `{got}` |

### 3.7 与 `decision.basis_refs` 的对接（**写侧必须照这个结构存**）

```json
"basis_refs": [
  { "kind": "SCREENING_EVALUATION",
    "contract_version": "1.0.0",
    "evaluation_digest": "9c1e…",
    "verdict": "NEEDS_REVIEW",
    "rubric_version_id": "…", "rubric_payload_hash": "…",
    "resume_version_id": "…", "resume_content_sha256": "…",
    "reasons_digest": "…",
    "criteria_evaluated": true,
    "counts": { "must_have": 1, "must_have_satisfied": 1, "must_have_unsatisfied": 0,
                "unreadable": 1, "missing": 0, "indeterminate": 0, "needs_judgment": 0 } },
  { "kind": "RUBRIC_VERSION", "id": "…" },
  { "kind": "RESUME_VERSION", "id": "…" }
]
```

`reasons_digest = sha256(canonical_json(reasons))`。有了它，`D11 §9.9`（"当时看到的是哪一版、哪一行"）才闭合：`decision` → `basis_refs` → `evaluation_digest` → 评估输出 → `page/bbox/sha256`。

> `ck_decision_basis` 只校验"是 array"（`0001_init.sql:1358`），所以这个结构**库拦不住**，只能靠写侧。记入 `screening-rules.md` §12 P-1。

---

## 4. 与现有 `CONTRACT.md` 的关系（必须显式处理的 6 处差异）

`recruitment_job_get` **同名**存在于 `CONTRACT.md` §5（stub 版）。本契约**取代**它的工具面，**不是**新开一个工具名。

| # | 项 | stub 版（`CONTRACT.md` §5） | 本契约 | 处理 |
|---|---|---|---|---|
| 1 | `rubric_version` 入参 | `string`（`"v2"`） | `rubric_version_no: integer` \| `rubric_version_id: uuid` | **破坏性**：`"v2"` 会 `INVALID_ARGS`。理由：字符串版本号会引出 `v2.1`/`V2`/`2` 三种写法，无法与 `version_no integer` 对齐 |
| 2 | `status` 枚举 | `OPEN·PAUSED·CLOSED`（3 值） | `ck_job_status` 全 7 值 | 兼容（3 值是子集） |
| 3 | `provenance` | 常量 `FIXTURE` | 计算值（§1.4） | **破坏性**：断言 `provenance=='FIXTURE'` 的地方会挂 |
| 4 | `stub` | 恒 `true` | **字段删除** | **破坏性** |
| 5 | `criteria[]` | `key/label/kind/weight` | 追加 `field/operator/value/question/notes`，`weight` 语义收紧为"展示用" | 兼容（新增可选键）；但 `weight` 的含义变了，需在 `labels`/注释里写清 |
| 6 | 错误消息 | 散文（`job "job_9999" not found; …`） | `Error: <CODE>: <json>` | **破坏性**：解析散文的地方要改。**需上级裁决**：是统一改 5 个工具，还是只让新工具用 json（会造成两套格式） |

> 建议：**一次性统一**（`errors.ts` 改一处），否则 `R5 单一权威` 会在错误格式上再破一次。
> 若上级决定不统一，则本契约 §1.2 降级为"新工具专用"，并在 `CONTRACT.md` §2.2 加一行"新工具用 json 格式"的例外说明——**必须回抄**，不能两套并存而无记录。

---

## 5. 验收清单（可直接执行，全部可机检）

### 5.1 形状层

| # | 检查 | 期望 |
|---|---|---|
| 1 | 两个工具的 `parameters` 都显式 `additionalProperties: false` | 传未知键 → `INVALID_ARGS(UNKNOWN_PARAM)`，消息里列出允许键 |
| 2 | `evaluate` 传 `tenant_id` 或 `actor_id` | `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)` |
| 3 | `evaluate` 传 `candidate_id`（而非 `application_id`） | `INVALID_ARGS(UNKNOWN_PARAM)` |
| 4 | `job_id="job_0001"` | `INVALID_ARGS(ID_NOT_UUID)` |
| 5 | `as_of` 给未来时间 | `INVALID_ARGS(AS_OF_IN_FUTURE)` |
| 6 | `job_get` 同时给 `rubric_version_no` 与 `rubric_version_id` | `INVALID_ARGS(MUTUALLY_EXCLUSIVE)` |
| 7 | 所有错误消息体 | 单行、可 `JSON.parse`（在 `Error: <CODE>: ` 之后） |
| 8 | 两个工具的 `output.schema` | 对 3 组 `verdict` + 4 类错误各跑一次，零违反 |

### 5.2 语义层（**这 6 条是"实现者最容易做错"的探针**）

| # | 探针 | 期望 | 错法 |
|---|---|---|---|
| **P1** | 简历有"至今"区间 + `GTE 60`，`covered_months_closed=74` | `MUST_HAVE_SATISFIED`（下界已够） | 错法：直接比较 → 若为 41 就判 `FAIL`（误杀在岗候选人） |
| **P2** | 同上但 `covered_months_closed=41` | `MUST_HAVE_INDETERMINATE` + `bounds='LOWER_BOUND'` | 错法：判 `UNSATISFIED`（把"不知道"当"不满足"） |
| **P3** | `MUST_HAVE` 只有 `absent` | `NEEDS_REVIEW` | 错法：`FAIL`（把"没写"当"不具备"，`R-1` 的入口） |
| **P4** | `parse_status='NEEDS_REVIEW'` | 抛 `BLOCKED_BY_REVIEW(PARSE_NEEDS_REVIEW)` | 错法：照常评估并给 `NEEDS_REVIEW`（抢跑人工队列） |
| **P5** | `NICE_TO_HAVE=UNSATISFIED` + 其余全满足 | `PASS`，该项只在 `bonus_signals[]` | 错法：`FAIL`（把加分项当硬性） |
| **P6** | 岗位 `CLOSED` | `NEEDS_REVIEW` + `GATE_JOB_CLOSED` + `criteria_evaluated=false` | 错法：抛 `BLOCKED_BY_REVIEW`（把业务状态当人工队列，废掉那个码） |

### 5.3 证据层

| # | 检查 | 期望 |
|---|---|---|
| 1 | `verdict=FAIL` 输出里**每一条 `failure_class='HARD_FAIL'` 的 `reasons[]`** | `tri_state='present'` 且 `evidence.length≥1` 且 `page/bbox/source_asset_sha256` 齐全（`screening-rules.md` §7.2 A1/A2）。**注意**：同一份 FAIL 输出里还会有 `UNREADABLE`/`MISSING` 条目，它们按下面第 2、3 行判，不能要求它们有 `evidence` |
| 2 | 任一 `tri_state='absent'` | `absence` 非空且 `hard_issue_count=0` |
| 3 | 任一 `tri_state='unreadable'` | `issue_codes.length≥1` |
| 4 | 全部 `evidence[].source_asset_sha256` | == `resume_version.source_asset_sha256`，否则出 `EVIDENCE_SHA_MISMATCH` 且相关 criterion 降 `UNREADABLE` |
| 5 | 输出里 grep `protected` | 0 命中 |
| 6 | 输出里 grep `evaluated_at` / `now` | 0 命中（`D-1`） |
| 7 | 同参连调两次 | 除 `evaluation_digest` 外逐字节相同 |

### 5.4 只读层

| # | 检查 | 期望 |
|---|---|---|
| 1 | 静态扫描 | 无 `INSERT`/`UPDATE`/`DELETE`/`fs`/`fetch`/子进程（`CONTRACT.md` §6 口径） |
| 2 | 调用前后 | `application.record_version`、`resume_version.parse_status`、`business_task.status`、`decision` 行数**全部不变** |
| 3 | DB 角色权限 | 用**只读账号**跑（`GRANT SELECT`）。若实现需要写权限，说明实现越界 |

---

## 6. 本文件明确**不**规定的事

| 不规定 | 归谁 |
|---|---|
| SQL 怎么写、索引怎么建 | 实现方（且不得在工具层拼 SQL 字符串） |
| 解析器怎么产 `parsed_fields` | S6/S7 契约（`converter` 现状见 `resume_fields.py`） |
| `decision` 怎么落、谁来签 | 写侧 + `APP-07` + `ck_execution_mandate_no_business_approval` |
| 岗位关闭后怎么转岗/归档 | `job-rubric-rules.md` §7.3（人工动作，工具不做） |
| 队列 UI 长什么样 | 前端；本契约只保证 `required_human_action` 与 `blocking_items[]` 够用 |

**版本变更**：出参增删字段 → bump `tool-contracts 1.x.0`；`verdict` 或错误码集合变化 → bump `2.0.0`（因为下游会断）。
