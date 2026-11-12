# screening-rules.md · 筛选（S7）规则

**版本**：`screening 1.0.0`（与 `job-rubric 1.0.0` / `tool-contracts 1.0.0` 同一基线）
**日期**：2026-11-13
**范围**：一次"筛选评估"从读取到 `verdict` 的**全部判定规则**，不含实现
**上位**：老仓 `work/handoff/15-architecture-hv.md`（新仓未收录；阶段码口径已由 D-22 与 `db/stage_catalog` 取代，见 `contracts/STAGE-CODES.md`）（S7 = 建议 + 人工确认）、`docs/11-pdf-acceptance-criteria.md` §9（**本文件的 §3、§8 与该章逐字对齐**）
**配套**：`job-rubric-rules.md`（标准从哪来、结构长什么样）、`tool-contracts.md`（工具形状）

> **本文件的唯一职责**：回答「给定这份材料 + 这条标准，结论是什么，依据是哪一页哪一行」。
> 它**不**回答「这个人该不该录用」——那是 `decision`，只能由人写。

---

## 0. 引用图例

| 标记 | 含义 | 出处 |
|---|---|---|
| `INV-1`…`INV-10` / `XINV-1`…`XINV-10` / `APP-01`…`APP-09` / `N01`…`N32` | 见 `job-rubric-rules.md` §0 | `db/SCHEMA.md` §8/§9/§10/§12 |
| `D11 §9.x` | PDF 验收标准第 9 章 | `docs/11-pdf-acceptance-criteria.md` |
| `J-1`…`J-8` / `R-VAL-*` | 岗位与标准规则 | `job-rubric-rules.md` |
| `converter` | `converter/src/resume_fields.py`（**已实现**的字段抽取与三态闸门） | 该文件行号 |

---

## 1. 五条红线（违反任一 = 本次交付不通过）

| # | 红线 | 机检方式 |
|---|---|---|
| **R-1** | **`unreadable` 绝不当 `absent`，更绝不当"不满足"。** 读不出来 → 只能产 `NEEDS_REVIEW`，永远不能进 `FAIL` | `verdict=FAIL` 时，**不存在** `tri_state='unreadable'` 的 reason 充当拒绝依据（§7.2 断言 A2） |
| **R-2** | **有未处理的人工队列项时，必须拒绝出结论**（`BLOCKED_BY_REVIEW`），**不得静默跳过该项**继续算 | §6 的 5 条查询任一命中 → 必抛错，且 `blocking_items[]` 非空 |
| **R-3** | **每条结论都要能回到"哪一页、哪个框、哪份原件"**：`field` + `tri_state` + `evidence(page/bbox/sha256)` 三者缺一不可 | §8 的证据完整性检查 |
| **R-4** | **受保护属性不得进特征**：不读、不算、不输出值 | 输出中不存在 `protected.*` 字段（枚举扫描，`D11 §9.6`） |
| **R-5** | **不得由模型估算替代可复算字段**（尤其是工作年限） | `timeline.*` 的 `bounds` 必须与 `parsed_fields.timeline` 一致（§4.2），不一致即 `INDETERMINATE` |

> 一句话：通用转换器的红线是「**读错了**」；筛选的红线是「**读错了、读不出、或有人在等着处理，却还是拿它做了对人的判断**」（`D11 §9` 开篇）。

---

## 2. 输入闭包：读什么、绝不读什么

### 2.1 一次评估**允许**读取的数据（闭包）

| 来源 | 字段 | 用途 |
|---|---|---|
| `job` | `id`/`title`/`status`/`record_version` | §5.1 门禁 |
| `application` | `id`/`job_id`/`candidate_id`/`job_version_id`/`rubric_version_id`/`lifecycle_status`/`current_stage_code`/`stage_blocked_reason`/`record_version` | 绑定、门禁、快照 |
| `resume_version` | `id`/`resume_id`/`version_no`/`parse_status`/`parse_error`/`source_asset_sha256`/`content_sha256`/`parser_name`/`parser_version`/`parsed_fields` | 材料与证据 |
| `resume` → `intake_asset` → `intake_record` → `event_inbox` | `candidate_id` / `sha256` / `validation_status` / `status` / `provider` / `trust_level` | §6 阻断、`labels.provenance` |
| `rubric_version` + `approval` | 见 `job-rubric-rules.md` §4.2 | 标准解析 |
| `business_task` | `id`/`status`/`business_refs`/`task_type` | §6.2 人工队列阻断 |
| `decision` | `id`/`result`/`rubric_version_id`/`decided_at`/`superseded_by_decision_id` | 只读回显"已有筛选结论"，用于提示 supersede |

### 2.2 **绝不**读取的数据（硬禁止）

| 数据 | 为什么 |
|---|---|
| `parsed_fields.protected_attributes.*` | `D11 §9.6`：隔离，不得进筛选特征；连读都不该读（读就有误用的可能） |
| `candidate.display_name` / `normalized_email` / `normalized_phone` | 身份识别归 S6（身份解析，属简历接入；`D11 §9.7`），筛选不碰身份。**用姓名/手机做筛选 = 身份筛选** |
| `candidate_merge` | 同上，合并是 S6（身份解析）的闸门 |
| `resume_version.parse_error` 的**自由文本** | 只允许取"是否非空"用于报错分类，不得把错误文本当字段值 |

> 实现建议：把 `parsed_fields` 用**白名单投影**读出来（只要 `fields` + `timeline` + `issues` + `screening`），而不是整块 `SELECT parsed_fields` 后到处取。这样"不读 protected"是结构保证，不是自觉。

---

## 3. 三态：定义、来源、以及"什么时候才配说 `absent`"

### 3.1 三态逐字对齐 `D11 §9.2`（**不许另立一套**）

| 三态 | 定义（`D11 §9.2` 原话） | 它在筛选里的**唯一**含义 |
|---|---|---|
| `present` | 原文有且已读出 | 可以做**正向或反向**判定：可以成为 `FAIL` 的依据 |
| `absent` | 原文确实没有提及 | 只能说"简历里没有"，**不构成 `FAIL`**（§4.4）；对 `DISQUALIFIER` 也**不构成 `CLEAR`**（§4.4） |
| `unreadable` | 原文有但读不出 | **只能产 `NEEDS_REVIEW`**；任何把它当 `absent` 或当"不满足"的实现直接判 `R-1` 违规 |

**禁止的第四态**：不得新增 `unknown` / `null` / `n/a` / `""`。缺失信息一律落进这三态之一；判断型 criterion 的"无机械三态"用 `tri_state: null` 表达，且**必须**同时有 `outcome='NEEDS_JUDGMENT'`（两者一一对应，不得只给其一）。

### 3.2 三态从哪里来（唯一来源，不得自造）

```
tri_state(criterion) :=
    parsed_fields.fields[<field 根>].state     -- 根 = field 路径的第一段（如 work_experience / education）
  ∨ derive_timeline_state(parsed_fields.timeline)   -- 仅当 field 以 "timeline." 开头，见 §4.2
  ∨ UNREADABLE(FIELD_STATE_UNDECLARED)              -- 上面两条都取不到
```

**四条细则**：

1. **根字段与派生字段**：`timeline.covered_months_closed` 的三态不直接存在 `fields` 里，由 §4.2 从 `parsed_fields.timeline` **推导**（`exact` → `present`；`lower_bound` → `present` 且带 `bounds='LOWER_BOUND'`；无可用值 → `absent` 或 `unreadable`，见 §4.2.3）。
2. **不得自造三态**：`parsed_fields.fields` 里没有这个键 → `UNREADABLE(FIELD_STATE_UNDECLARED)` + `warnings` 一条 `FIELD_STATE_UNDECLARED`。**不许推定 `absent`**（那是最容易被实现成"没写就是没有"的地方，也正是 `R-1` 的入口）。
3. **索引交叉校验**：`parsed_fields.screening.eligible_fields` / `blocked_fields` 是 `converter` 已经发布的同义索引。三者必须自洽：
   - `fields[x].state='present'` ⇔ `x ∈ eligible_fields`
   - `fields[x].state ≠ present` ⇔ `x ∈ blocked_fields` 且 `blocked_fields[].reason = fields[x].reason`
   - 不自洽 → `warnings: SCREENING_INDEX_INCONSISTENT`，并且**以 `fields[x].state` 为准**（它是原始三态，索引只是投影）。
4. **`absent` 的可证性**：见 §3.3。这是 `D11 §9.2` 与 `converter` 已经实现的那道闸门，**筛选不得重复实现，也不得绕过**。

### 3.3 `absent` 只在"整篇被读完"时才成立（**与 `converter` 的闸门完全一致**）

`converter` 已在字段层做了这道闸门（`resume_fields.py:907-936`），筛选读到的是**已经过闸**的 `state`。因此本契约**不重新判断**，而是要求筛选**尊重**这个结果：

| `resume_version.parse_status` | 已有 HARD issue? | 该字段的 `absent` 可信吗 | 筛选必须怎么做 |
|---|---|---|---|
| `PARSED` | 否 | ✅ 可信 → 保持 `absent` | 按 `absent` 处理（`MISSING`） |
| `PARTIAL` | 是 | ❌ **不可信** | 若上游仍给了 `absent` → 视为上游违约，**降级为 `UNREADABLE`**（`reason='document_not_fully_read'`）+ `warnings: ABSENT_DOWNGRADED` |
| `NEEDS_REVIEW` / `FAILED` / `PENDING` / `PARSING` | — | 不评估 | §6 阻断（`MATERIAL_*`） |

> **为什么这条必须写成"筛选自己也要兜一层"**：`converter` 的闸门是**当前实现**，不是库约束（`S-5`）。上游换实现、或历史行是旧解析器产的，闸门就可能缺失。**筛选是最后一道门**，不能依赖上游一定对。

判定"有 HARD issue"的口径（逐字复用 `converter/src/issues.py`）：`resume_version.parsed_fields.issues[]` 中存在 `code` 属于 `_HARD_ISSUE_CODES` 的项，**未知 code 一律按 HARD 处理**（保守优先，`issues.py:66-80` 原话）。若 `issues[]` 整个缺失 → 视为"有 HARD"，即 `absent` 不可信。

### 3.4 三态 → criterion 结果的映射（**唯一**入口）

| 三态 | 机械型结果 | 判断型结果 |
|---|---|---|
| `present` + 算子成立 | `SATISFIED`（`DISQUALIFIER` → **`TRIGGERED`**） | — |
| `present` + 算子不成立 | `UNSATISFIED`（`DISQUALIFIER` → **`CLEAR`**） | — |
| `present` 但量不可比（§4.2） | `INDETERMINATE` | — |
| `absent` | `MISSING` | — |
| `unreadable` | `UNREADABLE` | — |
| 无机械三态（判断型） | — | `NEEDS_JUDGMENT`（`tri_state: null`） |

**六种结果分两族**（`verdict` 只用这两族，`screening-rules.md` §5）：

| 族 | 结果 | 能导致 `FAIL` 吗 | 能导致 `PASS` 吗 |
|---|---|---|---|
| **结论族** | `SATISFIED` / `UNSATISFIED` / `TRIGGERED` / `CLEAR` | 只有 `UNSATISFIED`、`TRIGGERED` 能 | 只有 `SATISFIED`、`CLEAR` 能 |
| **不确定族** | `MISSING` / `UNREADABLE` / `INDETERMINATE` / `NEEDS_JUDGMENT` | **永远不能** | **永远不能** |

---

## 4. 单条 criterion 求值

### 4.1 机械型（`EXISTS` / `GTE` / `LTE`）

| 算子 | 字段 | `present` 时的求值 | 得到 |
|---|---|---|---|
| `EXISTS` | `work_experience` / `education` | 恒成立（因为 `present` 就是"读到了"） | `SATISFIED` |
| `GTE` | `work_experience.entry_count` / `education.entry_count` | `v ≥ value` | `SATISFIED` / `UNSATISFIED` |
| `LTE` | 同上 | `v ≤ value` | 同上 |
| `GTE` / `LTE` | `timeline.covered_months_closed` | **见 §4.2**，不是简单比较 | 三选一 |

### 4.2 有界量求值——**本文件最容易做错的一节**

#### 4.2.1 为什么不能直接比较

`converter` 的 `timeline.covered_months_closed` **只是"闭区间覆盖月数"**，它**故意**不把开放区间换算成月数：

> `resume_fields.py:698-699` 原文：`open-ended intervals are not converted to months (a date-stamped run would make the output non-reproducible)`

所以当简历里有"至今"（`open_ended_intervals > 0`）或年粒度区间（`year_only_intervals > 0`）时，**这个数只是下界，不是总量**。

**如果实现者直接拿它做 `GTE 60` 比较，会出现系统性误杀**：一个"2018.07–至今"的候选人（8 年）在这个数上可能很小，被判 `UNSATISFIED` → `FAIL`。这是本契约里**代价最高的一个 bug**。

#### 4.2.2 `bounds` 判定（先算这个，再比较）

```
EXACT  ⟺  timeline.open_ended_intervals = 0
        ∧  timeline.year_only_intervals  = 0
        ∧  issues[] 中不存在 code = 'resume_timeline_inversion'

LOWER_BOUND  其他情况
UNAVAILABLE  timeline 缺失 / covered_months_closed 不是整数 / work_experience != 'present'
```

#### 4.2.3 求值表（`M ∈ {covered_months_closed}`，`n = value`）

| `bounds` | `GTE n` | `LTE n` |
|---|---|---|
| `EXACT` | `M ≥ n` → `SATISFIED`；否则 `UNSATISFIED` | `M ≤ n` → `SATISFIED`；否则 `UNSATISFIED` |
| `LOWER_BOUND` | `M ≥ n` → **`SATISFIED`**（下界已够，结论成立）；`M < n` → **`INDETERMINATE`**（总量未知，**不得判 `UNSATISFIED`**） | `M > n` → **`UNSATISFIED`**（下界已超上限，反证成立）；否则 → **`INDETERMINATE`** |
| `UNAVAILABLE` | `MISSING`（若 `work_experience='absent'`）或 `UNREADABLE`（其余） | 同左 |

**结论方向是不对称的，必须记住**：
- **下界够 → 成立**（真的够）；
- **下界不够 → 不知道**（不能当不满足）；
- **下界已超上限 → 不成立**（真的超了）。

`INDETERMINATE` 的 `code` 仍是 `MUST_HAVE_INDETERMINATE` / `DISQUALIFIER_INDETERMINATE`（§7.3），但**必须**回带 `bounds='LOWER_BOUND'` 与 `observed.lower_bound`，并在 `message` 里说清"差多少 + 为什么不能确定"。**不许**为了省事把它写成 `UNSATISFIED`。

> 若产品要求"年限必须能判"，正确做法是**上游补一个可复算的 `total_months_upto_as_of`**（用 `as_of` 补齐开放区间，输出可复现），而不是让筛选去估算。这是 `job-rubric-rules.md` §9 第 2 条的变更路径。

### 4.3 判断型（无 `field`）

- 结果恒为 `NEEDS_JUDGMENT`，`tri_state = null`；
- **永不影响 `FAIL`**，即使一个模型"觉得"候选人不满足（`D11 §9.3`、`APP-07`）；
- 输出必须带 `question`（rubric 里的原问句），供人工/下游直接作答；
- 允许附 `notes`（模型观察），但 `notes` **不是证据**，不得进 `evidence[]`。

### 4.4 判定矩阵（`kind` × 结果 → 对 `verdict` 的作用）

| 结果 | `MUST_HAVE` | `NICE_TO_HAVE` | `DISQUALIFIER` |
|---|---|---|---|
| `SATISFIED` | 计入 PASS 必要条件 | 加分信号 | —（`DISQUALIFIER` 不会得到这个值） |
| `UNSATISFIED` | **→ FAIL** | **无影响**（只进 `bonus_signals[]`） | — |
| `TRIGGERED` | — | — | **→ FAIL** |
| `CLEAR` | — | — | 不产生正向证据 |
| `MISSING` | → NEEDS_REVIEW | 无影响 | **→ NEEDS_REVIEW**（不因"没写"就放行） |
| `UNREADABLE` | → NEEDS_REVIEW | 无影响（记 warning） | **→ NEEDS_REVIEW** |
| `INDETERMINATE` | → NEEDS_REVIEW | 无影响 | **→ NEEDS_REVIEW** |
| `NEEDS_JUDGMENT` | → NEEDS_REVIEW | 无影响 | **→ NEEDS_REVIEW** |

**两条不对称，是刻意的**：

1. **`MUST_HAVE` 的"缺"与"读不出"都不淘汰人**，只有**反证**（`UNSATISFIED`）才淘汰。理由：简历天然是摘要，不写 ≠ 不具备（`D11 §9.2` + handoff `01 §5` 阶段 7「简历未呈现的考察项统一标缺，不推测原因」）。
2. **`DISQUALIFIER` 的"缺"与"读不出"都要人工看**。理由：排除条件若无法判断，系统不能宣称"他不受这条限制"——**放行同样是一个决定**。

---

## 5. `verdict` 聚合算法（确定性，按顺序执行，前一步命中即返回）

```
STEP 0  前置（不满足 → 抛错，不产出 verdict）
        - 未处理的人工队列项 / 材料未就绪 → BLOCKED_BY_REVIEW   (§6)
        - 无可用 Rubric                     → NO_RUBRIC          (job-rubric-rules §4)
        - 申请 / 材料 / 版本不存在            → NOT_FOUND
        - 入参非法                          → INVALID_ARGS

STEP 1  门禁（命中 → NEEDS_REVIEW，criteria_evaluated=false，直接返回）
        job.status ∈ {CLOSED, ARCHIVED, DRAFT, PENDING_REVIEW, APPROVED}
          或 application.lifecycle_status ∈ {WITHDRAWN, CLOSED}
        → verdict = NEEDS_REVIEW，reasons = [GATE_*]，criteria_evaluated = false

STEP 2  逐 criterion 求值（§3.4 / §4）
        - MUST_HAVE / NICE_TO_HAVE / DISQUALIFIER 各自得到 §3.4 的六种结果之一
        - 判断型 → NEEDS_JUDGMENT

STEP 3  FAIL（充分条件，不看不确定项）
        ∃ MUST_HAVE = UNSATISFIED   ∨   ∃ DISQUALIFIER = TRIGGERED
        → verdict = FAIL

STEP 4  NEEDS_REVIEW
        ∃ MUST_HAVE ∈ {MISSING, UNREADABLE, INDETERMINATE, NEEDS_JUDGMENT}
          或 ∃ DISQUALIFIER ∈ {MISSING, UNREADABLE, INDETERMINATE, NEEDS_JUDGMENT}
        → verdict = NEEDS_REVIEW

STEP 5  PASS（其余全部）
        所有 MUST_HAVE = SATISFIED  ∧  所有 DISQUALIFIER = CLEAR
        → verdict = PASS
```

**四条必须照做的性质**：

| # | 性质 | 为什么 |
|---|---|---|
| **V-1** | **FAIL 优先于 NEEDS_REVIEW**：一条反证已足以得出"不符合"，其他未读项不改变这个事实 | 否则任何一份有扫描页的简历都能"逃避反证" |
| **V-2** | **NEEDS_REVIEW 优先于 PASS**：只要有一处不确定，就不许宣布通过 | `D11 §9.2`；"读不出"不能变成"合格" |
| **V-3** | **`NICE_TO_HAVE` 对 `verdict` 零影响**：不阻塞 PASS、不促成 FAIL | `job-rubric-rules.md` §6.5 裁决 |
| **V-4** | **STEP 1 命中时不评估 criterion**（`criteria_evaluated=false`） | 已关闭的岗位不值得消耗自动判定，也避免"关岗后再批量给建议" |

**`verdict` ≠ `decision.result`**。写入时按这张表映射，且**必须由 `actor.kind='HUMAN'` 落库**（`APP-07`、`N27`）：

| `verdict` | 建议的 `decision.result` | 说明 |
|---|---|---|
| `PASS` | `ADVANCE` | 只是建议；人可以改成 `HOLD`/`REJECT` |
| `FAIL` | `REJECT` | 同上 |
| `NEEDS_REVIEW` | `HOLD` | `ck_decision_result` 没有"待确认"值，只能落 `HOLD` |

---

## 6. 未处理的人工队列项：如何阻断

### 6.1 阻断的边界（先划清，否则 `BLOCKED_BY_REVIEW` 会被滥用）

| 情形 | 用哪个机制 | 理由 |
|---|---|---|
| **已经有人在那条上待办**（任务在 `WAITING_HUMAN`） | **抛错 `BLOCKED_BY_REVIEW`** | 再出一份建议 = 抢跑 / 覆盖人工结论；必须硬拒绝 |
| **材料还没准备好**（解析没完成 / 解析失败 / 待复核 / 原件无效） | **抛错 `BLOCKED_BY_REVIEW`**（`family='MATERIAL'`） | 这不是"判不出"，是"现在还轮不到判"；出 `NEEDS_REVIEW` 会让人误以为可以复核了 |
| **岗位/申请状态不允许自动结论** | **`NEEDS_REVIEW` + GATE reason**（不抛错） | 这是业务状态，不是"有人在处理"；抛错会让调用方无法区分"重试就好"与"要人介入" |

### 6.2 阻断判定（**7 条检查，任一命中即阻断**；全部可落成 SQL）

记：
`app` = 目标 `application`，`rv` = 本次使用的 `resume_version`，
`ir` = `rv.resume_id → resume.intake_asset_id → intake_asset.intake_record_id` 得到的 `intake_record`。

| # | family | `reason_code` | 判定 |
|---|---|---|---|
| **HQ-1** | `HUMAN_QUEUE` | `HUMAN_TASK_WAITING` | `∃ business_task t : t.status='WAITING_HUMAN'` 且 `t.business_refs` 含下列任一 ref：`{"kind":"APPLICATION","id":app.id}` / `{"kind":"CANDIDATE","id":app.candidate_id}` / `{"kind":"RESUME_VERSION","id":rv.id}` |
| **HQ-2** | `HUMAN_QUEUE` | `PARSE_NEEDS_REVIEW` | `rv.parse_status = 'NEEDS_REVIEW'` |
| **HQ-3** | `HUMAN_QUEUE` | `INTAKE_NEEDS_REVIEW` | `ir.status = 'NEEDS_REVIEW'` |
| **HQ-4** | `MATERIAL` | `MATERIAL_PARSE_FAILED` | `rv.parse_status = 'FAILED'` |
| **HQ-5** | `MATERIAL` | `MATERIAL_NOT_READY` | `rv.parse_status ∈ {'PENDING','PARSING'}` |

补充两条**结构性问题**（同样阻断，但不属于"队列"）：

| # | family | `reason_code` | 判定 |
|---|---|---|---|
| **HQ-6** | `MATERIAL` | `MATERIAL_NOT_BOUND` | `application.resume_version_id IS NULL` 且入参未给 `resume_version_id` |
| **HQ-7** | `MATERIAL` | `INTAKE_ASSET_INVALID` | `intake_asset.validation_status = 'INVALID'` |

**`business_refs` 元素的形状**（本契约定义，库目前只校验"是 array"，见 `job-rubric-rules.md` §8 S-4）：

```json
{"kind": "APPLICATION|CANDIDATE|RESUME_VERSION|INTAKE_RECORD|JOB|DECISION|INTERVIEW", "id": "<uuid>"}
```

判定用**集合包含**（`jsonb @>`），不做模糊匹配；`kind` 大小写敏感。

### 6.3 **不得静默跳过**：证明这次检查真的做了

三条机制，缺一不可：

1. **抛错必带明细**：`BLOCKED_BY_REVIEW` 的错误体必须含 `blocking_items[]`，每项 `{code, family, ref_kind, ref_id}`，至少 1 项。**空数组 = 违约**（等于"报了个错但说不出为什么"）。
2. **不抛错时也要留痕**：成功输出里必须有 `preconditions.human_queue_clear = true` 与 `preconditions.human_queue_checked = 7`（本次执行了几条阻断检查，当前固定 7，即 §6.2 的 HQ-1…HQ-7）。**没有这个字段 = 无法证明检查发生过**。
3. **不做"部分放行"**：只要有一条命中，整次评估不出任何 criterion 结果。不允许"跳过有问题的那条 criterion，其余照算"——那正是"静默跳过"。

### 6.4 人工队列项怎么"清"

筛选工具**不清**、**不改**、**不标记**。清的方式只有让 §6.2 的查询不再命中（`business_task` 离开 `WAITING_HUMAN`、`parse_status` 变 `PARSED`/`PARTIAL`、`intake_record` 离开 `NEEDS_REVIEW`）。

**为什么工具不能"顺手标记为已读"**：那等于 Agent 替人关闸门（`APP-07`、`execution_mandate` 的 `ck_execution_mandate_no_business_approval`），而且会让人以为"有人处理过了"。

---

## 7. 硬性不满足 vs 读取失败：输出怎么区分

### 7.1 一个字段，三条正交的信息

| 信息 | 字段 | 取值 |
|---|---|---|
| **发生了什么** | `reason.code` | 见 §7.3 的封闭表 |
| **你凭什么这么说** | `reason.tri_state` | `present` / `absent` / `unreadable` / `null`（判断型） |
| **它有多硬** | `reason.failure_class` | `HARD_FAIL` / `HARD_PASS` / `NOT_PROVEN` / `UNREADABLE` / `INDETERMINATE` / `JUDGMENT` / `GATE` |

**三者必须同时出现**。只有 `code` 而没有 `tri_state` = 违反 `R-3`；只有 `tri_state` 而没有 `evidence` = 违反 `R-3`。

### 7.2 四条机检断言（验收时直接跑）

- **A1**：`verdict=FAIL` ⇒ 存在至少一条 `reason` 满足 `code ∈ {MUST_HAVE_UNSATISFIED, DISQUALIFIER_TRIGGERED}` ∧ `tri_state='present'` ∧ `evidence.length ≥ 1`。
- **A2**：`verdict=FAIL` ⇒ **不存在**任何 `tri_state='unreadable'` 的 reason 被用作拒绝依据。等价说法：把输出里所有 `tri_state='unreadable'` 的 reason 删掉后，`verdict` 仍然是 `FAIL`。
- **A3**：`verdict=NEEDS_REVIEW` ⇒ 不存在 `code ∈ {MUST_HAVE_UNSATISFIED, DISQUALIFIER_TRIGGERED}`（否则应走 STEP 3）。
- **A4**：`verdict=PASS` ⇒ 每条 `MUST_HAVE` 都有 `code='MUST_HAVE_SATISFIED'` 且 `evidence.length ≥ 1`。

### 7.3 `reason.code` 封闭表（12 条 + `BONUS_*` 一族 + 4 条 GATE）

| `code` | `failure_class` | 出现在 | 与哪些 `verdict` 相容 | 通俗解释 |
|---|---|---|---|---|
| `MUST_HAVE_SATISFIED` | `HARD_PASS` | `reasons[]` | PASS 或 NEEDS_REVIEW | 硬性条件已满足，有原文为证 |
| `MUST_HAVE_UNSATISFIED` | `HARD_FAIL` | `reasons[]` | **仅 FAIL**（FAIL 时至少一条） | 原文**反证**了这条要求 |
| `MUST_HAVE_MISSING` | `NOT_PROVEN` | `reasons[]` | NEEDS_REVIEW 或 FAIL | 简历里确实没写 |
| `MUST_HAVE_UNREADABLE` | `UNREADABLE` | `reasons[]` | NEEDS_REVIEW 或 FAIL | 写了解析不出 / 整篇没读完 |
| `MUST_HAVE_INDETERMINATE` | `INDETERMINATE` | `reasons[]` | NEEDS_REVIEW 或 FAIL | 读到了，但这个量不足以比较（§4.2） |
| `MUST_HAVE_NEEDS_JUDGMENT` | `JUDGMENT` | `reasons[]` | NEEDS_REVIEW 或 FAIL | 这条要求机器判不了，要人答 |
| `DISQUALIFIER_TRIGGERED` | `HARD_FAIL` | `reasons[]` | **仅 FAIL**（FAIL 时至少一条） | 命中排除条件 |
| `DISQUALIFIER_CLEAR` | `HARD_PASS` | `reasons[]` | PASS 或 NEEDS_REVIEW | 明确不命中排除条件 |
| `DISQUALIFIER_MISSING` | `NOT_PROVEN` | `reasons[]` | NEEDS_REVIEW 或 FAIL | 无法确认是否命中 |
| `DISQUALIFIER_UNREADABLE` | `UNREADABLE` | `reasons[]` | NEEDS_REVIEW 或 FAIL | 同上，原因是读不出 |
| `DISQUALIFIER_INDETERMINATE` | `INDETERMINATE` | `reasons[]` | NEEDS_REVIEW 或 FAIL | 同上，原因是量不可比 |
| `DISQUALIFIER_NEEDS_JUDGMENT` | `JUDGMENT` | `reasons[]` | NEEDS_REVIEW 或 FAIL | 同上，机器判不了 |
| `BONUS_*`（四点位同上） | 同上 | **`bonus_signals[]` only** | 任意 | 加分项，不决定结论 |
| `GATE_JOB_CLOSED` | `GATE` | `reasons[]` | **仅 NEEDS_REVIEW** | 岗位已关闭 |
| `GATE_JOB_ARCHIVED` | `GATE` | `reasons[]` | **仅 NEEDS_REVIEW** | 岗位已归档 |
| `GATE_JOB_NOT_OPEN` | `GATE` | `reasons[]` | **仅 NEEDS_REVIEW** | 岗位尚未开放 |
| `GATE_APPLICATION_NOT_ACTIVE` | `GATE` | `reasons[]` | **仅 NEEDS_REVIEW** | 申请已撤回/已关闭 |

**"与哪些 verdict 相容"这一列怎么读**（这里最容易审错）：

1. 一个 `FAIL` 输出里**同时**会有 `MUST_HAVE_UNSATISFIED`（反证）**和** `MUST_HAVE_UNREADABLE`（没读出来的那几条）——这正是 V-1「FAIL 优先」的意思：反证已成立，但未读项仍然要列出来给人看。所以"NEEDS_REVIEW 或 FAIL"不是含糊，是**同一份输出可以两者都有**。
2. `GATE_*` 只能出现在 `criteria_evaluated=false` 的输出里，此时 `reasons[]` **只有 GATE 条目**，`verdict` 必为 `NEEDS_REVIEW`。
3. `MUST_HAVE_SATISFIED` / `DISQUALIFIER_CLEAR` 可以出现在 `NEEDS_REVIEW` 输出里（其余条目不确定）；但**只有它们俩凑齐所有 `MUST_HAVE`/`DISQUALIFIER` 时**才可能是 `PASS`（V-2）。

**`warnings[]`（不影响 `verdict`，但必须出现）的封闭表**：

| `code` | 何时 |
|---|---|
| `APPLICATION_ON_HOLD` | `application.lifecycle_status='ON_HOLD'` |
| `JOB_PAUSED` | `job.status='PAUSED'` |
| `FIELD_STATE_UNDECLARED` | criterion 引用的字段在 `parsed_fields` 里没有三态（§3.2） |
| `ABSENT_DOWNGRADED` | 上游给了 `absent` 但材料不完整，被降级为 `unreadable`（§3.3） |
| `SCREENING_INDEX_INCONSISTENT` | `eligible_fields`/`blocked_fields` 与 `fields[*].state` 不一致（§3.2） |
| `EVIDENCE_SHA_MISMATCH` | `evidence[*].source_sha256 ≠ resume_version.source_asset_sha256`（§8.2） |
| `RUBRIC_PIN_REQUIRED` | 本次解析走 `JOB_CURRENT`，写侧落 `decision` 前必须先钉版本 |
| `WHAT_IF_EVALUATION` | `what_if=true`，结论不得落 `decision` |

---

## 8. 证据契约（每条结论的"最小可回溯集"）

### 8.1 `reasons[]` 元素的形状（与 `bonus_signals[]` 共用同一 schema）

```json
{
  "code": "MUST_HAVE_UNSATISFIED",
  "failure_class": "HARD_FAIL",
  "criterion_key": "backend_years",
  "kind": "MUST_HAVE",
  "outcome": "UNSATISFIED",
  "field": "timeline.covered_months_closed",
  "tri_state": "present",
  "bounds": "EXACT",
  "expected": {"operator": "GTE", "value": 60, "unit": "MONTH"},
  "observed": {"value": 41},
  "evidence": [
    {"resume_version_id": "…", "source_asset_sha256": "…",
     "page": 2, "bbox": [72.0, 310.5, 523.2, 334.8],
     "block": 17, "quote": "2019.03 - 2022.08  XX 科技  后端工程师",
     "provenance": "native_text"}
  ],
  "message": "要求后端方向 ≥60 个月；已复算闭区间 41 个月，且无开放区间"
}
```

### 8.2 三种三态各自**必须**带的证据（缺一即违约）

| `tri_state` | 必带 | 形式 | 依据 |
|---|---|---|---|
| `present` | ≥1 条 `evidence[]`，每条含 `page`(≥1) + `bbox`(4 个数) + `source_asset_sha256` | 精确到框 | `D11 §9.9`、`D11 §2 D1`（结构化字段必须回指 `page + bbox`） |
| `absent` | `absence` 对象（**没有 bbox 是正常的**） | `{document_sha256, page_count, completeness:"complete", searched_scopes:[...], basis:"parsed_fields.fields.<x>.state=absent", hard_issue_count:0}` | `D11 §9.2`、`§9.3` |
| `unreadable` | ≥1 个 `issue_codes[]`（来自 `parsed_fields.issues[].code` 或 `fields[x].reason`） | 代码而非散文 | `D11 §1 B3`（不可静默）、`§9.3` |
| `null`（判断型） | `question` 非空 | 原问句 | `job-rubric-rules.md` §6.1 |

**`bbox` 的坐标约定**（否则同一份 PDF 两个人算出的框不可比）：

- 坐标系：PDF 用户空间，**原点在页左上，y 向下**，单位 pt（1/72 inch）——与 `PyMuPDF` 的 `get_text("blocks")` 一致；
- 顺序固定 `[x0, y0, x1, y1]`，且 `x0 < x1`、`y0 < y1`；
- 与 `page` 联合唯一确定一个矩形；**页码从 1 起**（`D11 §1` 的 `location.page` 同口径）。

**`source_asset_sha256` 必须等于 `resume_version.source_asset_sha256`**（原件哈希，不是正文哈希）。不一致 → `warnings: EVIDENCE_SHA_MISMATCH`，且**所有引用该证据的 criterion 一律降为 `UNREADABLE`**（证据不可信 = 没读出来）。

### 8.3 证据的"不许"清单

1. 不许用 `parsed_fields` 之外的推断（"看起来像大厂"→ 不是证据）；
2. 不许把 `notes`/`message` 里的文字当 `quote`（`quote` 必须是原文片段）；
3. 不许跨区块拼装出一条"完整"经历（`D11 §9.1`：`converter` 已经把跨区块的情况标成 `unreadable`，筛选不得再拼回去）；
4. 不许给 `absent` 编一个 bbox（那是在无中生有，`D11 §5` 红线 2）。

---

## 9. 什么情况能自动出结论、什么情况必须人工

| 情形态 | 条件 | 输出 | 是否需要人 |
|---|---|---|---|
| **自动 PASS（建议）** | 所有 `MUST_HAVE` 都是机械型且 `SATISFIED`；所有 `DISQUALIFIER` 为 `CLEAR`；无 GATE | `verdict=PASS` | **要**（人写 `decision`；工具不落库） |
| **自动 FAIL（建议）** | ∃ 机械型 `MUST_HAVE=UNSATISFIED` 或 `DISQUALIFIER=TRIGGERED` | `verdict=FAIL` | **要**（同上） |
| **必须人工** | 任一 `MUST_HAVE` 或任一 `DISQUALIFIER` ∈ 不确定族 | `verdict=NEEDS_REVIEW` | 要，且要**指定补什么**（见下行） |
| **必须人工** | 存在 `NEEDS_JUDGMENT`（判断型 criterion） | `verdict=NEEDS_REVIEW` + `question` | 要，答问题 |
| **必须人工** | 岗位/申请状态门禁 | `verdict=NEEDS_REVIEW` + `GATE_*` | 要，先处理岗位状态 |
| **拒绝执行** | 人工队列项 / 材料未就绪 | `BLOCKED_BY_REVIEW`（无 `verdict`） | 要，先清队列 |
| **拒绝执行** | 无可用 Rubric | `NO_RUBRIC`（无 `verdict`） | 要，先建/批标准 |

**一条必须记住的话**：本工具**永远只产建议**。"自动出结论"= 自动产出一份**带完整证据的建议**，不是自动录用或自动淘汰。落库的那一步永远要 `actor.kind='HUMAN'`。

**`required_human_action`（输出字段，封闭枚举）**——告诉队列"这活该给谁"：

| 值 | 何时 |
|---|---|
| `NONE` | 无需人（不存在；本工具不产生"无需人"的结论，保留给未来） |
| `CONFIRM_DECISION` | `PASS`/`FAIL`，人只需确认 |
| `REVIEW_MISSING_FIELDS` | 有 `MISSING`：找候选人补材料 |
| `REVIEW_UNREADABLE` | 有 `UNREADABLE`：修解析/换原件 |
| `REVIEW_INDETERMINATE` | 有 `INDETERMINATE`：人算年限 |
| `ANSWER_JUDGMENT` | 有 `NEEDS_JUDGMENT`：回答 `question` |
| `RESOLVE_BLOCKER` | GATE 命中：先处理岗位/申请状态 |

多个同时成立时取**最大优先级**：`RESOLVE_BLOCKER` > `ANSWER_JUDGMENT` > `REVIEW_UNREADABLE` > `REVIEW_INDETERMINATE` > `REVIEW_MISSING_FIELDS` > `CONFIRM_DECISION`。

---

## 10. 受保护属性：不读、不算、不输出

| 规则 | 判定 |
|---|---|
| `criterion.field` 落在 `protected.*` 或 `job-rubric-rules.md` §6.3 禁止名单 | Rubric 非法 → `NO_RUBRIC/RUBRIC_INVALID(PROTECTED_ATTRIBUTE_IN_CRITERIA)` |
| 输出里出现 `protected.*` 的任何值 | 违约（`R-4`），机检枚举扫描 |
| 用 `protected_attributes` 里的 `photo`/`age` 反推 | 禁止；`converter` 已把它隔离在 `parsed_fields.fields` 之外，筛选连读都不读 |

依据：`D11 §9.6`（不是"隐私口号"，是产品正确性——否则会做出歧视性筛选且无法申诉）、`D11 §9.11` 红线 9。

---

## 11. 确定性与幂等

| # | 规则 | 依据 |
|---|---|---|
| **D-1** | 同一 `(入参, 数据库快照)` → **同一输出**（除 `evaluation_digest` 之外逐字节相同）。输出**不含** `evaluated_at` 之类墙钟字段；唯一的时间输入是显式 `as_of`，且原样回显 | `CONTRACT.md` §2.3（无时钟、无随机） |
| **D-2** | 工具**不写任何行**：不钉 `rubric_version_id`、不改 `business_task`、不建 `decision`、不写 `event_inbox` | `APP-07`、§6.4 |
| **D-3** | 输出带 `evaluation_digest`（对规范化后的 `{args, resolved_ids, rubric_payload_hash, resume_content_sha256, verdict, reasons}` 求 `sha256`），写侧把它存进 `decision.basis_refs`，用于证明"当时用的是哪一次评估" | `XINV-9`（可追溯）、`D11 §9.9` |
| **D-4** | 输出带 `snapshot`（`application.record_version` / `resume_version.id` / `resume_version.content_sha256` / `rubric_version.payload_hash`）。写侧落 `decision` 前必须比对，不一致 → 重评，不得沿用旧 digest | `INV`/`XINV-10`（完成状态必须被确认）、乐观并发（`SCHEMA.md` §1） |

---

## 12. 与现有 schema 对不上的地方（补充 `job-rubric-rules.md` §8）

| # | 缺口 | 影响 | 建议 |
|---|---|---|---|
| **P-1** | 库**没有** `evaluation` / `screening_result` 表（`SCHEMA.md` M-1：Screening Result = `decision(scope='SCREENING')`） | 本工具的输出是**瞬态**的，唯一持久化载体是 `decision.basis_refs`（只校验"是 array"，`L1358`） | 维持 M-1；写侧必须按 `tool-contracts.md` §3.7 的 `basis_refs` 结构存 |
| **P-2** | `decision.result` 枚举里**没有"待确认"**（`ADVANCE·HOLD·REJECT·WITHDRAW·HIRED`） | `NEEDS_REVIEW` 无处可落 | 落 `HOLD`（§5 表）；**不要**为了表达 `NEEDS_REVIEW` 去扩枚举（会动状态机） |
| **P-3** | `decision` 没有"结论依据的是哪一版材料/哪一次评估"的列 | `D11 §9.9` 只能靠 `basis_refs` 自觉 | `basis_refs` 里必存 `resume_version_id` + `rubric_version_id` + `evaluation_digest`（`tool-contracts.md` §3.7） |
| **P-4** | `resume_version.parse_status` 只有 `PENDING·PARSING·PARSED·PARTIAL·FAILED·NEEDS_REVIEW`，**没有"完整度"字段** | §3.3 的"能不能说 absent"只能靠 `parse_status + issues[]` 推断 | 本契约按 §3.3 推断（可判定）；若上游将来加 `completeness`，本表按 `job-rubric-rules.md` §9 第 2 条变更 |
| **P-5** | `business_refs` 元素形状无库约束 | §6.2 的 HQ-1 查询依赖它 | 见 `job-rubric-rules.md` §8 S-4 |
| **P-6** | 没有"人工队列"实体，只有 `business_task` | `HQ-1` 是唯一能表达"有人正在处理这件事"的地方 | 维持；若将来要做统一收件箱，再抽象 |

---

## 13. 自检清单（可机检）

| # | 检查 | 期望 |
|---|---|---|
| 1 | 用 `parse_status='PARTIAL'` 且上游给了 `absent` 的材料评估 | 结果 `UNREADABLE` + `warnings: ABSENT_DOWNGRADED`，`verdict` 不是 `FAIL` |
| 2 | 造一条 `MUST_HAVE` 只有 `absent` 的简历 | `verdict=NEEDS_REVIEW`（**不是** `FAIL`） |
| 3 | 造一条 `MUST_HAVE` 有原文反证的简历 | `verdict=FAIL` + 该 reason 的 `tri_state='present'` + `page/bbox/sha256` 齐全 |
| 4 | 让 `business_task` 进入 `WAITING_HUMAN` 且 ref 指向该 candidate | 调用必抛 `BLOCKED_BY_REVIEW`，`blocking_items[0].code='HUMAN_TASK_WAITING'` |
| 5 | 手工删掉阻断检查（模拟"静默跳过"） | 机检应能发现：输出缺 `preconditions.human_queue_clear` |
| 6 | 把一份 `FAIL` 输出里**唯一**的 `HARD_FAIL` 条目改成 `UNREADABLE`（保留其余条目） | 删掉全部 `unreadable` 后 `verdict` **不再是** `FAIL` → 断言 A2 失败 → 判定违约（这才是"拿读取失败当拒绝依据"的真实形态；仅**存在** `unreadable` 条目不算违约，见 §7.3 注 1） |
| 7 | 简历有"至今"的区间 + `GTE 60` | 结果 `INDETERMINATE`（`bounds='LOWER_BOUND'`），**不是** `UNSATISFIED` |
| 8 | 同上但换成 `GTE 12` | `SATISFIED`（下界已够） |
| 9 | 岗位 `CLOSED` | `verdict=NEEDS_REVIEW` + `GATE_JOB_CLOSED` + `criteria_evaluated=false` |
| 10 | 任一 `NICE_TO_HAVE=UNSATISFIED` | `verdict` 仍可为 `PASS`，该项出现在 `bonus_signals[]` |
| 11 | 输出里 grep `protected` | 0 命中 |
| 12 | 同参连调两次 | 除 `evaluation_digest` 外逐字节相同（`D-1`） |
| 13 | 给一条 `field` 不在白名单的 Rubric | `NO_RUBRIC/RUBRIC_INVALID(CRITERION_FIELD)`，且**不产生** `verdict` |
