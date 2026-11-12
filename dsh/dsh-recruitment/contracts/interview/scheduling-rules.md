# 面试安排规则（S9 · interview scheduling）

**日期**：2026-11-13
**范围**：S9「面试安排」——从「这一轮要面」到「某一时刻、某几个人、某个会议，已被排定 / 改期 / 取消」。
**不管**：谁该进面试（S8 筛选结论，见 `../job-screening/screening-rules.md`）、面完的转写怎么取（见 `transcript-rules.md`）、面评写什么与最终决策（S11）。
**性质**：合同。不含实现代码、不含 DDL。所有「必须 / 不得」都是可判定的断言，不是建议。
**上位口径**：与本文冲突时依次以 `work/handoff/15-architecture-hv.md`（S9 定位）、`db/SCHEMA.md` §8/§9/§10（INV / XINV / APP）、`work/control/DECISIONS-2026-11-12.md`（D-33 / D-46）为准。

> **阶段编号提醒（R5 单一权威）**：本文的 **S9 = 面试安排**、**S10 = 面试执行与材料获取**，沿用 `15-architecture-hv.md:46-49`。
> 而 `db/migrations/0002_seed.sql:240-242` 的 `stage_catalog` 里 **S8 = 面试规划与排期、S9 = 面试执行与材料获取** —— 两者**错位一格**。
> 落库写 `interview.stage_code` 时**以 `stage_catalog` 的 code 为准**（见 §13 G-4），**不得**把本文的章节号当 stage code 写进库。

---

## 0. 一句话

> **「排定」不是"库里多了一行 interview"，而是五件事同时成立：轮次明确、面试官是人且不与别的场次冲突、时间窗口是一个完整的绝对时刻区间、形式明确、会议绑定状态可判。**
> 少了任何一条，系统必须说"没排定"或"排定了但缺 X"，**不得**用"先建行、以后补"的方式假装排定。

三条贯穿全篇的裁决（后文每条规则都是它们的展开）：

| # | 裁决 | 一句话理由 |
|---|---|---|
| **H-1** | **改期 = 改同一行 interview，不是新建一行** | `uq_interview_slot`（`0001 L950`）物理禁止同 `(application, round_no, slot_code)` 两条；"新建 + 换 slot_code"会把 slot 语义（并行场次）搞坏，且让"这一轮有几场"不可数 |
| **H-2** | **排期工具只登记本地事实，不发起任何外部写**（不建飞书日历、不发邀请） | v1.0 的 `connection_state` 就是 `NOT_CONNECTED`；把外部写塞进同步工具，失败时既没回执也没对账（违反 `XINV-4`）。外部动作必须走 `durable_effect`（§7.4） |
| **H-3** | **绝不因为"绑不上会议"而拒绝排期** | 反过来做，会让"日历授权过期"直接变成"不能安排面试"。正确做法是排定成立 + 绑定状态显式为 `UNBOUND` + 落补绑任务（§7.3） |

---

## 1. 术语（后文只用这几个词）

| 词 | 定义 | 不是 |
|---|---|---|
| **场次（session）** | 一次 `interview` 行：`(application_id, round_no, slot_code)` 唯一确定 | 一轮。一轮可以有多个并行场次（用人经理场 / 专家场） |
| **排定（scheduled）** | 满足 §2 的 `SCHEDULABLE`，且 `interview.status='SCHEDULED'` 且 `scheduled_end_at` 非空 | 建了 interview 行 |
| **占位窗口 `EW(x)`** | 该场次**实际占用**的时间区间（§3.1） | `scheduled_start_at/end_at` 的字面值 |
| **冲突（conflict）** | 同一自然人（面试官或候选人）在两个占位窗口上相交（§3.2） | 会议室冲突、日历无空闲、时区看起来不一样 |
| **面试官行** | `interviewer` 表一行：`(interview_id, actor_id)` 唯一 | 人。同一个人在同场只能有一行 |
| **绑定（binding）** | `meeting_binding` 一行，且 `unbound_at is null` | 有了 meeting 行 |
| **改期（reschedule）** | 把已有场次的时间换成另一个；**同一行** | 新建场次 |
| **取消（cancel）** | 该场次不再举行；行保留、面评保留 | 删除、置空、移出轮次 |

---

## 2. 排定要素：`SCHEDULABLE` 判定式 · SC-S

一次安排请求 `args` 能落成"排定"，**当且仅当**下列 A1–A10 全部为真。任一为假 → 拒绝，并给出**唯一**的失败码（§2.3）。

### 2.1 十项条件

| # | 条件（判定式） | 落点 / 依据 |
|---|---|---|
| **A1** | `∃ application` 同租户，且 `lifecycle_status='ACTIVE'` | `fk_interview_application`（`0001 L951`）、`INV-1` |
| **A2** | `round_no ∈ [1,20]` 且为整数 | `ck_interview_round`（`0001 L963`）、`INV-4` |
| **A3** | `slot_code` 匹配 `^[A-Z][A-Z0-9_]{1,20}$`，且 `(application_id, round_no, slot_code)` 上**没有**任何 interview 行（含 CANCELLED，见 §6.4） | `ck_interview_slot_code`（`L964`）、`uq_interview_slot`（`L950`） |
| **A4** | `\|interviewers\| ≥ 1`，每个 `actor_id` 同租户存在且 `actor.kind='HUMAN'`，且集合内**无重复** | `fk_interviewer_actor`（`L987`）、`uq_interviewer`（`L984`）。**Agent / SYSTEM 不能当面试官** |
| **A5** | `scheduled_start_at` 是带时区偏移的绝对时刻，且 `> now`；`duration_minutes ∈ [15,480]`；`scheduled_end_at = scheduled_start_at + duration_minutes` 且**必须写入**（非空） | `ck_interview_window`（`L966`）、`ck_interview_scheduled`（`L968`）。**契约严于库**：库允许 `scheduled_end_at` 为空，本契约不允许（见 §13 S-2） |
| **A6** | `timezone` 是 IANA 名（只用于**展示**，不参与比较）；缺省取组织时区 | `interview.timezone`（`L941`） |
| **A7** | `delivery_mode ∈ {VIDEO, ONSITE, PHONE}`；**v1.0 只接受 `VIDEO`** | **无列** → §13 G-1 |
| **A8** | 无 §3 的面试官冲突、无候选人冲突（`intent=CREATE/RESCHEDULE` 时） | 应用层（§3）；`docs/04 §4` |
| **A9** | 若给了 `meeting`：`provider` 非空 ∧ (`calendar_event_id` ∨ `external_meeting_id`) 至少一个 ∧ 该 `(tenant, provider, external_meeting_id)` 未被**别的场次**占用 | `ck_meeting_identity`（`L1007`）、`uq_meeting_external`（`L1013`）、`uq_meeting_binding_active`（`L1044`） |
| **A10** | 关联的 `interview_template_version_id`（若给）与该 `job` 一致 | `fk_interview_template`（`L953`）、`fk_interview_template_job`（`L916`） |

### 2.2 五要素与十条件的对应（回答"要哪些要素才算排定"）

| 要素 | 问题 | 对应条件 | 缺失时的结论 |
|---|---|---|---|
| **轮次** | 第几轮、并行第几场 | A2 + A3 | `INVALID_ARGS`（不可省） |
| **面试官** | 谁面、每人是否必须交面评 | A4 | `INVALID_ARGS(INTERVIEWER_REQUIRED)` |
| **时间** | 绝对起止时刻 | A5 | `INVALID_ARGS(START_IN_PAST / DURATION_OUT_OF_RANGE)` |
| **时长** | 占多久 | A5（`duration_minutes`） | 同上 —— **时长是必填，不是从"结束时间"倒推** |
| **形式** | 线上 / 现场 / 电话 | A7 | `INVALID_ARGS(UNSUPPORTED_DELIVERY_MODE)`（v1.0 只 `VIDEO`） |

> **"形式"为什么在 v1.0 恒为 `VIDEO`**：`interview` 表没有形式列（§13 G-1）。与其在一个不存在的列上编造语义，不如**把 v1.0 收窄成单一形式**：需要 `meeting_binding` 的线上视频面试。`ONSITE`/`PHONE` 在补列前一律拒绝 —— 拒绝是诚实的，静默当成线上会在材料获取环节制造"这场没会议当然没转写"的假象（§7.5）。

### 2.3 失败码（与工具契约一致）

| 失败条件 | 码 | `reason_code` |
|---|---|---|
| A2/A3 格式、A5 参数、A7 形式、A4 空集/重复 | `INVALID_ARGS` | `ROUND_OUT_OF_RANGE` / `SLOT_CODE_INVALID` / `START_IN_PAST` / `DURATION_OUT_OF_RANGE` / `UNSUPPORTED_DELIVERY_MODE` / `INTERVIEWER_REQUIRED` / `DUPLICATE_INTERVIEWER` |
| A3 已有行（任意状态） | `ALREADY_SCHEDULED` | —（`detail.existing_interview_id` + `hint`） |
| A1 申请不存在 | `NOT_FOUND` | `APPLICATION_NOT_FOUND` |
| A4 某人不存在 / 跨租户 | `NOT_FOUND` | `INTERVIEWER_NOT_FOUND`（跨租户一律 `NOT_FOUND`，**不确认对方存在**，与 `IR-C7` 同构） |
| A4 人存在但 `kind ≠ HUMAN` | `INVALID_ARGS` | `INTERVIEWER_NOT_HUMAN` |
| A10 模板不属于该岗位 | `INVALID_ARGS` | `TEMPLATE_JOB_MISMATCH` |
| A8 冲突 | `CONFLICT_SLOT` | `INTERVIEWER_BUSY` / `CANDIDATE_BUSY` |
| A9 会议已被别的场次绑 | `MEETING_ALREADY_BOUND` | — |

---

## 3. 冲突判定 · SC-C

`docs/04 §4` 列了排期要考虑的 **9 类约束**；本系统的取舍写死在 §3.4，**不做"尽量考虑"**。

### 3.1 占位窗口 `EW(x)`

```
D            = 15..480 分钟（该场次的 duration_minutes）
S(x)         = coalesce(m.actual_start_at, x.scheduled_start_at)
E(x)         = coalesce(m.actual_end_at, x.scheduled_start_at + D)
EW(x)        = [S(x), E(x))                      # 半开区间，右端不含
m            = x 上 uq_meeting_binding_active 的 meeting（unbound_at is null）；没有则 m 为空
```

**为什么 actual 优先**：一个已经开过的会**实际**占用了 11:00–12:20，即使它排的是 11:00–12:00；用计划值判断会让 12:10 的新场次"看起来没冲突"。`actual_*` 不存在时自动退回计划值，因此对未发生的会完全等价于用 `scheduled_*`。

### 3.2 冲突谓词

```
OVERLAP([s1,e1), [s2,e2)) = s1 < e2 ∧ s2 < e1              # 背靠背（e1 = s2）不算冲突

OCCUPYING_ACTOR(a) = { x ∈ interview :
      x.tenant_id = t ∧ x.status ∈ {'SCHEDULED','IN_PROGRESS'}
    ∧ ∃ r ∈ interviewer: r.interview_id = x.id ∧ r.actor_id = a
                       ∧ r.required_scorecard = true }        # 见 SC-C8

CONFLICT_INTERVIEWER(a, [s,e), B) = ∃ x ∈ OCCUPYING_ACTOR(a) :
      OVERLAP([s, e + B), EW(x)) ∧ x.id ≠ 本次场次

CONFLICT_CANDIDATE(c, [s,e))     = ∃ x ∈ interview :
      x.tenant_id = t ∧ x.application.candidate_id = c ∧ x.status ∈ {'SCHEDULED','IN_PROGRESS'}
    ∧ OVERLAP([s,e), EW(x)) ∧ x.id ≠ 本次场次
```

| # | 规则 | 判定 | 依据 |
|---|---|---|---|
| **SC-C1** | 面试官冲突按**自然人**算，不按"角色"或"部门" | 同一 `actor_id` 在两场上 → 冲突 | `docs/04 §4`「面试官可用时间」 |
| **SC-C2** | 缓冲 `B` 只加在**面试官**一侧（`[s, e+B)`），候选人一侧不加 | `B` 缺省 0，取自 `business_config(config_key='interview_scheduling_policy').buffer_minutes`；无配置行时用 **0** | `docs/04 §4`「面试时长与轮次间隔」 |
| **SC-C3** | 候选人冲突**跨轮次**也算 | 同一候选人在第 2 轮 10:00–11:00，第 1 轮排 10:30 → 冲突 | 同一自然人不能同时出现在两场（`docs/04 §4`「候选人可用时间」） |
| **SC-C4** | 只有 `SCHEDULED` / `IN_PROGRESS` 占位 | `POST_INTERVIEW` / `EVALUATION_READY` / `DECIDED` / `CANCELLED` / `NO_SHOW` / `RESCHEDULED` 都不占位 | 已结束或已作废的场次不构成未来冲突 |
| **SC-C5** | 全部比较在 `timestamptz`（绝对时刻）上做；`timezone` 只影响展示 | 两个不同时区的 10:00 是否相同，取决于偏移，不取决于 `timezone` 字面 | `docs/03 §19` 时间语义 |
| **SC-C6** | **会议室冲突不算冲突** | 没有任何"会议室"对象参与判定 | `docs/04 §4` 逐字：**「会议室不是常规排期模型的默认约束」** |
| **SC-C7** | 冲突结果必须**逐条**回列，不能只给布尔 | `conflicts[]` 每项含 `{kind, ref_kind, ref_id, window}`；空数组 = 无冲突 | 人要能一眼看到"撞了谁、撞在几点" |
| **SC-C8** | **只有 `required_scorecard=true` 的面试官行占位** | `required_scorecard=false`（旁听 / 已退出）的人**不构成面试官冲突** | 这是 §13 G-3 的**代价与收益**：没有 `interviewer.status` 列时，这是唯一能让"某人请假后时段被释放"的可判定办法。副作用：旁听者被同时安排到两场不会被拦 —— **这是已知限制**，补 `interviewer.status` 后应收紧为"只需 status ≠ REMOVED" |

### 3.3 冲突不是"建议"，是拒绝

排期请求一旦命中冲突 → `CONFLICT_SLOT`，**不落任何行**（单事务回滚）。**不允许**"先排上再提醒"：那样两场都成了事实，之后必须靠人手工改一条，等于把决策成本推给最晚知道情况的人。

> 例外的唯一形态：人明确要求"允许冲突"（例如同一人旁听两场）。v1.0 **不提供**该开关 —— 需要时先改 `business_config` 策略，不得在参数里塞一个 `force=true` 绕过（那是把不变量变成可选）。

### 3.4 9 类约束的落地取舍（明确"不做"）

| `docs/04 §4` 的约束 | v1.0 | 说明 |
|---|---|---|
| 候选人可用时间 | **只做冲突**，不做"求交" | 没有候选人空闲数据源；时间由人给出 |
| 面试官可用时间 | **只做冲突**，不查日历空闲 | 查空闲需要读日历授权，v1.0 `NOT_CONNECTED` |
| 多人共同参与 | ✅ 做 | 多面试官同场天然同时 |
| 面试时长与轮次间隔 | 时长 ✅；轮次间隔 = **buffer 常量**（`B`） | 不做"轮次间必须隔 N 天"这类策略推导 |
| 时区 | 只做绝对时刻 + 展示 | 不做"跨时区工作时间求交" |
| 会议链接与日历事件 | **只登记**，不创建（H-2） | §7 |
| 企业工作时间与休息 | **不做** | 无配置载体；靠人排 |
| 改期取消冲突重排 | ✅ 做 | §4 / §6 |
| 候选人与面试官通知 | **不做**（不代发） | 外部发送需 Effect + 回执（`XINV-4`） |

---

## 4. 改期 / 面试官变动：重排还是新建 · SC-R

### 4.1 裁决：一律改同一行（H-1）

`uq_interview_slot (application_id, round_no, slot_code)`（`0001 L950`）使"新建一条同场次"直接 `23505`。所以：

| 动作 | 做法 | 禁止 |
|---|---|---|
| 换时间 | `UPDATE interview SET scheduled_start_at, scheduled_end_at` 同一行 | 新建一行；换 `slot_code` 冒充 |
| 换面试官（增） | `INSERT interviewer` 一行 | 复用旧行改 `actor_id`（会破坏 `uq_interviewer` 语义与面评归属） |
| 换面试官（减 / 请假） | 见 §4.3 —— **不删行** | `DELETE interviewer`（`trg_interviewer_no_delete`） |

### 4.2 改期三步（顺序是规则的一部分）

```
1) 冲突重算：对新窗口重跑 §3.2（排除自己）。命中 → CONFLICT_SLOT，不写任何行。
2) 会议解绑/换绑：
   若本次要换会议（新 calendar_event_id 或新 external_meeting_id）：
     a. 旧 binding: unbound_at = now()，unbound_reason 必须非空（ck_meeting_binding_unbound，L1039）
     b. 旧 meeting: meeting_role = 'REPLACED'                             ← 保留历史，不删
     c. 新 meeting + 新 binding(binding_method='SCHEDULED')
3) UPDATE interview（同一事务）：
   - 时间变更
   - status：由 §8 的状态机决定（见下）
   - 必须 SET LOCAL recruitment.actor_id（D-18；否则 ACTOR_REQUIRED）
```

**`status` 在改期后是什么**（这条最容易搞错，见 §11-②）：

| 改期形态 | 改期后 status | 理由 |
|---|---|---|
| 直接给了新时间 | `SCHEDULED` | 该场次仍然"已排定"，只是时间变了 |
| 已受理但**新时间未定** | `RESCHEDULED` | 这是 `RESCHEDULED` 的唯一语义：**时间作废、待重排**。此时 `scheduled_start_at` 允许为空（`ck_interview_scheduled` 对 `RESCHEDULED` 不要求时间，`L968-970`） |
| 从 `RESCHEDULED` 补上新时间 | `SCHEDULED` | 回到已排定 |

> **`RESCHEDULED` 不是"改过期的历史标记"**。它是"这一场当前没有有效时间"。把它当成"曾经改期过"的永久烙印，会让 `ck_interview_scheduled` 的豁免被滥用成"永远不填时间也能存"。

### 4.3 面试官请假：不删行，落 `required_scorecard=false` + 事件

`interviewer` **没有** `status`/`removed_at` 列，且在禁删名单里（`0001 L1725`）。所以"某人请假不来了"只能这样表达：

| 步骤 | 动作 | 判定 |
|---|---|---|
| 1 | 该 `interviewer.required_scorecard = false` | 他不再阻塞 Evaluation Ready（`APP-05`） |
| 2 | 写一条内部事件 `provider='internal'`、`event_type='interviewer.withdrawn'`，`payload` 必须含 `{interview_id, actor_id, interviewer_id, reason, effective_from}` | 补位载体（无列 → §13 G-3） |
| 3 | 若该场次仍需举行 → 邀请替补 `INSERT interviewer`（新的 `actor_id`） | `uq_interviewer` 允许 |
| 4 | 若不补人且原 `required_scorecard` 全为 false → 允许排定但 `get` 必须报 `evaluation.required_scorecards = 0` 警告 | 防止"无人需交面评"却进入 Evaluation Ready |

**`required_scorecard=false` 的两种成因必须靠事件区分**：① 旁听（本来就不交）② 退出（请假/换人）。v1.0 用 `event_type` 区分，**不得**只看布尔值推断（§13 G-3 建议 0002 加 `interviewer.status`）。

### 4.4 历史怎么留（三类载体，缺一不可）

| 想知道的事 | 唯一载体 | 不能从哪看 |
|---|---|---|
| 这场的时间改过几次、从几点到几点、谁改的、为什么 | 内部事件 `event_type='interview.rescheduled'`，`payload = {interview_id, from:{start,end}, to:{start,end}, actor_id, reason, reschedule_no}` | 不能从 `interview` 行看（它只有当前值）；**不能从 `meeting` 看**（`meeting` 没有计划时间列，§13 G-2） |
| 上一场会议还存不存在 | `meeting` 行 + `meeting_role='REPLACED'` + `meeting_binding.unbound_at`（行永不删） | 不能靠"找不到就是取消了" |
| 状态迁移本身 | `fn_row_guard` 自动写的 `event_inbox`（`0001 L140-153`）+ `interview.status_source_event_id` | — |

**必须显式写事件的原因（结构事实）**：`fn_row_guard` 在**状态没变**时只自增 `record_version`，**不写任何事件**，并且禁止你手改 `status_changed_at` / `status_source_event_id`（`0001 L102-120`）。所以"同状态改时间"**不会**自动留下任何痕迹 —— 服务层必须自己写 `interview.rescheduled`。这是本文件里最容易漏的一条（§11-①）。

---

## 5. 多面试官与"面评不可代填" · SC-I

### 5.1 一场面试可以有多个面试官（结构支持）

- 每个面试官是 `interviewer` 表**一行**，`(interview_id, actor_id)` 唯一（`0001 L984`）。
- 每人**独立一份**当前面评：`uq_scorecard_current (interview_id, interviewer_id) where superseded_by_scorecard_id is null`（`0001 L1322-1323`）。
- `required_scorecard` 决定该人是否**阻塞** Evaluation Ready。

```
REQUIRED(i)  = { r ∈ interviewer : r.interview_id = i ∧ r.required_scorecard = true }
SATISFIED(i) = { r ∈ REQUIRED(i) : ∃ s ∈ scorecard : s.interviewer_id = r.id
                                    ∧ s.status ∈ {'SUBMITTED','WAIVED'}
                                    ∧ s.superseded_by_scorecard_id is null }
EVALUATION_READY(i) = REQUIRED(i) = SATISFIED(i) ∧ record_ok(i) ∧ traceable(i)
```

`record_ok` / `traceable` 属 S11（`APP-05`、`docs/04 §18`）；本文只负责 `REQUIRED = SATISFIED` 这一半。

### 5.2 不可代填：判定式与"谁来守"

| # | 规则 | 判定式 | 依据 |
|---|---|---|---|
| **SC-I1** | 一份面评只能由**它自己的面试官**提交 | `scorecard.status_changed_by_actor_id = interviewer.actor_id`。不等 → 视为代填 | `fn_row_guard` 把 `SET LOCAL recruitment.actor_id` 写进 `status_changed_by_actor_id`（`0001 L122-136`），这是**唯一**能证明"谁按的提交"的列 |
| **SC-I2** | Agent / 模型**永不**写面评分项、文字、结论 | `actor.kind ≠ 'AGENT_WORKER'` 才允许写 `scorecard.items/overall/rationale` | `APP-07`、`docs/04 §17 禁止①`、`SCHEMA §10` |
| **SC-I3** | 豁免（`WAIVED`）也是人的动作 | `WAIVED` 必须有 `waive_reason`（`ck_scorecard_waived`，`L1316`）+ 人 actor | `ck_scorecard_waived`；`execution_mandate` 的 CHECK 已禁 `waive_scorecard`（`0001 L1648`） |
| **SC-I4** | 提交后面评冻结 | 任何改动 → `23514 SCORECARD_IMMUTABLE`；修订 = 新 `revision_no`（`fn_scorecard_guard`，`L213-230`） | `INV-7`、`docs/04 §19`「记录已修订」 |
| **SC-I5** | 排期工具**不创建、不修改、不提交**任何 `scorecard` 行 | 静态扫描：工具实现里零 `scorecard` 写入 | `APP-07` |

> **为什么这条必须是契约而不是"习惯"**：`execution_mandate` 的 CHECK 只禁了 `approve/reject/decide/merge_candidate/waive_scorecard`（`0001 L1648`），**没有禁 `submit_scorecard`**。也就是说，**库不会拦住 agent 提交面评**。能拦的只有 SC-I1 的 actor 比对 + SC-I5 的静态扫描。这一条是从"库里没拦"倒推出来的契约，必须写死（§13 G-5）。

### 5.3 一人交了、一人没交

`REQUIRED ≠ SATISFIED` 时：`interview.status` **不得**进入 `EVALUATION_READY`，但**允许**：

- 已交的人的面评保留且可见（`docs/04 §22 P0`：允许一人先交、一人待交）；
- 未交的人 `PENDING`，可按 `scorecard_due_at` 提醒（`interviewer.scorecard_due_at`，`L980`）；
- 任何"用一个人的面评代表整场"的做法均为越权（`docs/04 §18` Evaluation Ready 三条件）。

---

## 6. 取消 · SC-X

### 6.1 允许的入口与出口

```
CANCELLABLE = { 'SCHEDULED', 'RESCHEDULED' }
CANCEL: CANCELLABLE --cancel(reason 非空)--> 'CANCELLED'
```

| 当前 status | 能否 cancel | 结论 |
|---|---|---|
| `SCHEDULED` / `RESCHEDULED` | ✅ | 正常取消 |
| `IN_PROGRESS` / `POST_INTERVIEW` | ❌ | `INVALID_ARGS(INVALID_STATE_TRANSITION)`。已经发生了的面试不叫"取消"；候选人撤回走 `decision(result='WITHDRAW')` |
| `EVALUATION_READY` / `DECIDED` | ❌ | 已评价/已决策的场次不得被"取消"改写结论 |
| `CANCELLED` | ❌（幂等：同 reason 重复取消 → 成功且不写行） | 不重复写事件 |
| `NO_SHOW` | ❌ | 未到场是事实，不是取消 |

### 6.2 取消时对"已提交面评"的处理（这是本节的重点）

| # | 规则 | 理由 / 依据 |
|---|---|---|
| **SC-X1** | 已提交的 `scorecard` **保留原样**，不删、不撤、不改状态 | `trg_scorecard_no_delete`（`0001 L1727`）+ `fn_scorecard_guard`（提交后冻结）+ `INV-2` 精神 |
| **SC-X2** | 取消后 `REQUIRED(i)` **不再阻塞** Evaluation Ready（该场次不需要"评价齐备"了） | 一场没发生的面试没有"必需面评" |
| **SC-X3** | 取消后**禁止**新增 `SUBMITTED` 面评；`PENDING` 保持 `PENDING` 不催办 | 否则会出现"取消后 3 天又冒出一份面评"，且该场次没有原文可核 |
| **SC-X4** | 已提交面评若被下游 `decision` 引用，`basis_refs` 必须显式带 `interview_status='CANCELLED'` | 让读的人知道"这条依据来自一场被取消的面试"（`INV-9` 可追溯） |
| **SC-X5** | 取消**必须**给出非空 `reason` | `interview` 无 `cancel_reason` 列（§13 G-1）→ 落内部事件 `interview.cancelled` 的 `payload.reason`；缺失 → `INVALID_ARGS(REASON_REQUIRED)` |
| **SC-X6** | 取消后会议：若 `meeting.actual_start_at is null` → 解绑（`unbound_at` + `unbound_reason='INTERVIEW_CANCELLED'`）并把 `meeting_role='CANCELLED'`；若已发生 → **不解绑** | 会议是否发生是可判定事实；已发生的会议仍可能有材料要取（`docs/04 §20 A`：`CANCELLED` 旧会议保留但不纳入本轮记录） |

### 6.3 取消 ≠ 删除，也 ≠ 可以重排同一 slot 之外的任意玩法

- 行永不删（`trg_interview_no_delete`），`status='CANCELLED'`。
- 取消后该时段**不再占位**（不在 `OCCUPYING` 集合，§3.2 SC-C4）→ 面试官可被别的场次使用。
- **取消后要再面同一场次**：只能 `intent=RESCHEDULE`（同一行从 `CANCELLED` 回到 `SCHEDULED`），因为 `uq_interview_slot` 仍然占着这个 `(application, round_no, slot_code)`。

### 6.4 对 `ALREADY_SCHEDULED` 的定义（受 §6.3 影响，必须一起读）

```
ALREADY_SCHEDULED(args) ⟺ ∃ i ∈ interview :
     i.application_id = args.application_id
   ∧ i.round_no       = args.round_no
   ∧ i.slot_code      = args.slot_code
   （不论 i.status 是什么，含 CANCELLED）
```

`intent=CREATE` 命中 → `ALREADY_SCHEDULED`，`detail` 给 `existing_interview_id` + `existing_status` + `hint='use intent=RESCHEDULE'`。**不**尝试自动转成改期（工具不允许"猜调用意图"）。

---

## 7. 与 `meeting_binding` 的关系 · SC-B

### 7.1 什么时候绑

`docs/04 §10` 逐字：**「Meeting 与 Interview 必须在面试排期时提前绑定，不能等转写生成后才靠 Meeting ID 临时找」**。
所以绑定是**排期动作的一部分**，不是 S10 的补救动作：

| 时点 | 绑什么 | `binding_method` |
|---|---|---|
| 排期时（有人给了日历事件 ID） | `meeting(calendar_event_id=…)` + binding | `SCHEDULED` |
| 排期时（人给了真实 `external_meeting_id`） | `meeting(external_meeting_id=…)` + binding | `SCHEDULED` |
| 会后事件到达、按平台 ID 精确命中 | 补 `external_meeting_id` / 新建 meeting + binding | `EVENT_MATCH` |
| 人工在界面里指认 | binding | `MANUAL`（必须 `bound_by_actor_id`，`ck_meeting_binding_manual_actor`，`L1038`） |

**禁止**：只凭标题 / 候选人姓名 / 模糊时间自动写 binding（`docs/04 §12` 逐字；`APP-04`）。模糊匹配**最多**产出候选列表。

### 7.2 绑定状态（供 `recruitment_interview_get` 原样回显）

```
BIND(i) = { b ∈ meeting_binding : b.interview_id = i.id ∧ b.unbound_at is null }

binding_state(i) =
  'BOUND_ACTIVE'  if |BIND(i)| ≥ 1
  'UNBOUND'       if |BIND(i)| = 0 ∧ i.status ∈ {'SCHEDULED','RESCHEDULED','IN_PROGRESS'}
  'NONE_EXPECTED' if |BIND(i)| = 0 ∧ i.status ∈ {'CANCELLED','NO_SHOW'}
```

`BOUND_ACTIVE` 时**必须**回列每一条：`{binding_id, meeting_id, binding_method, bound_at, bound_by_actor_id, provider, account_scope, external_meeting_id, calendar_event_id, meeting_role, actual_start_at, actual_end_at}`。

> `|BIND(i)| ≥ 2` 是**正常**的（正式会 + 断线续接，`docs/04 §11`）。库层只在**会议**一侧保证唯一（`uq_meeting_binding_active` 建在 `meeting_id` 上，`0001 L1044-1045`），面试一侧**不唯一**——所以"一场面试只能有一个会议绑定"是错的，"一场会议只能绑一场面试"才对（`transcript-rules.md §6`）。

### 7.3 绑不上怎么办（三条路径，全部有明确结论）

| 情形 | 结论 | 落什么 |
|---|---|---|
| 调用方**没给**会议信息（线上会议还没建） | **排定照常成立**（H-3），`binding_state='UNBOUND'` | 写 `business_task(task_type='INTERVIEW_MEETING_BIND', status='WAITING_EXTERNAL', idempotency_key='bind_meeting:'||interview_id, business_refs=[{kind:'INTERVIEW',id}])`；`due_at = scheduled_start_at` |
| 给了会议信息但该 `external_meeting_id` 已被**别的**场次绑 | 拒绝：`MEETING_ALREADY_BOUND` | 不落任何行（`uq_meeting_external` / `uq_meeting_binding_active` 会 23505；服务层必须翻译成该码，不能把 500 抛给用户） |
| 给了会议信息但**平台侧**创建/查询失败（授权、限流） | 这不是排期工具的错误 —— 工具不做外部调用（H-2）；失败体现在 connector 侧 | 工具返回 `UNBOUND` + `warnings[{code:'MEETING_NOT_BOUND'}]`；外部失败由 `durable_effect(status='AUTH_REQUIRED'/'RETRYABLE_FAILED', receipt_ref=…)` 记录（`XINV-4`） |

**三条硬约束**：

1. **不得**因为 `UNBOUND` 而把 `interview.status` 降级或拒绝排期。
2. **不得**在 `UNBOUND` 时假装"没有会议"是正常终态 —— 必须在 `get` 里可见，且在 `due_at` 到期后升级为人工待办（`WAITING_HUMAN`）。
3. **不得**为了凑出 `external_meeting_id` 去猜或编造平台 ID（`docs/04 §21`「平台没有提供的字段保持缺失，不得编造」）。

### 7.4 若将来要"自动建会议"（明确不在 v1.0）

必须走：`business_task` → `durable_effect(status='PENDING' → 'CLAIMED' → 'SENT')` → 平台回读 → `CONFIRMED`（`sent_at + confirmed_at` 双非空，`ck_durable_effect_confirmed`）。且 `docs/04 §7` 逐字：**「Graph 的 202 Accepted 仅表示请求被接受处理，不等于收件人已收到邮件」** —— 同理，日历 API 返回 200 不等于候选人收到了邀请。**没有回读就不算发出**（`XINV-10`）。

### 7.5 S9 → S10 的因果链（跨文件不变量，必须记住）

```
没有 meeting  →  没有 transcript_artifact（meeting_id NOT NULL）
没有 binding  →  事件到达时无法定位 interview → NEEDS_LINKING
```

也就是说：**§7.3 的"绑不上"直接决定 §9/`transcript-rules.md` 的"取不到"**。排期时省掉的那一步，会在 S10 变成一条 24 小时后才被发现的人工待办。这是本文件唯一的跨阶段后果，写在这里防止两个阶段各自"看起来都没错"。

---

## 8. 面试状态机（S9 视角）· SC-M

`ck_interview_status`（`0001 L959-961`）的 8 个值与允许的边（`APP-06`：边集由领域服务控制，不写进 DB）：

```
                    ┌───────────── RESCHEDULE(给新时间) ─────────────┐
                    ▼                                               │
  (新建) ─CREATE─► SCHEDULED ─RESCHEDULE(不给时间)─► RESCHEDULED ───┘
                    │  │                                │
                    │  └─start─► IN_PROGRESS ─end─► POST_INTERVIEW
                    │                                   │
                    │                                   └─面评齐─► EVALUATION_READY ─decision─► DECIDED
                    ├─cancel─► CANCELLED ─RESCHEDULE─► SCHEDULED   （§6.3）
                    └─no_show─► NO_SHOW
```

| 边 | 谁触发 | 附加要求 | 依据 |
|---|---|---|---|
| `∅ → SCHEDULED` | 排期 | §2 全部条件 | `INV-4` |
| `SCHEDULED → RESCHEDULED` | 改期（新时间未定） | 冲突重算通过（若给了时间）；`scheduled_start_at` 可空 | `ck_interview_scheduled` |
| `RESCHEDULED → SCHEDULED` | 补时间 | 必须有 `scheduled_end_at` | A5 |
| `SCHEDULED → SCHEDULED`（仅时间变） | 改期 | **必须显式写 `interview.rescheduled` 事件**（`fn_row_guard` 不会写，§4.4） | §11-① |
| `CANCELLED → SCHEDULED` | 复活重排 | 同改期 | §6.3 |
| `SCHEDULED → CANCELLED` | 取消 | `reason` 非空；§6.2 | `SC-X5` |
| `SCHEDULED → IN_PROGRESS` | S10（会议开始） | 有 `actual_start_at` 或人工确认 | `docs/04 §18` |
| `IN_PROGRESS → POST_INTERVIEW` | S10（会议结束） | 有 `actual_end_at` 或人工确认 | 同上 |
| `POST_INTERVIEW → EVALUATION_READY` | S11 | `REQUIRED = SATISFIED` + `record_ok` + `traceable` | `APP-05` |
| `EVALUATION_READY → DECIDED` | S11 | `decision` 行存在 | `INV-9` |
| `SCHEDULED → NO_SHOW` | 人 | 会议已到点且无 `actual_start_at` | — |

**本文不实现** `IN_PROGRESS` 之后的边（属 S10/S11），只登记"哪些边在本文的写工具里被允许"：`CREATE` / `RESCHEDULE` / `CANCEL` 三种 intent 覆盖的边就是 §8 表里带"排期/改期/取消"字样的那些。

---

## 9. 幂等与并发 · SC-K

| # | 规则 | 判定 / 落点 | 依据 |
|---|---|---|---|
| **SC-K1** | 写命令**必须**带 `idempotency_key` | 落 `business_task.idempotency_key = 'interview_schedule:' || key`（`uq_business_task_idempotency`，`L1430`） | `XINV-1`、`XINV-4` |
| **SC-K2** | 同 key + 同参 → 幂等重放，返回首次结果，**不写任何新行** | 比对 `business_task.business_refs` 里的 `args_digest = sha256(canonical_json(args 去掉 idempotency_key))` | 同上 |
| **SC-K3** | 同 key + 不同参 → `INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)` | digest 不等 | `APP-03` 精神（不许"大概同一个请求"） |
| **SC-K4** | 语义级幂等**不依赖** key：同 `(application, round_no, slot_code)` 已有行 → `ALREADY_SCHEDULED` | §6.4 | `uq_interview_slot` |
| **SC-K5** | 并发两次同 key → 后者 `23505`，服务层翻译成"重放"而非 500 | `uq_business_task_idempotency` | `XINV-1` |
| **SC-K6** | 改期/取消必须带 `expected_record_version`，0 行更新 → `VERSION_CONFLICT`，**不重试、不 last-write-wins** | `fn_row_guard` 每次 UPDATE 自增 `record_version`（`L159`） | `docs/03 §18`、`D-18` |
| **SC-K7** | 面试官集合的变更必须在**同一事务**里 touch `interview` 行（`UPDATE interview SET updated_at=now()` 即可自增版本），否则两个人并发"各加一个面试官"都会成功且都没看见对方 | `interviewer` **没有** `record_version` 列 | §13 S-5 |
| **SC-K8** | actor 必须 `SET LOCAL recruitment.actor_id`（**不是** `SET`，连接池会泄漏） | 否则 `ACTOR_REQUIRED`（`L127`） | `D-18` |

---

## 10. 判定用例（6 条，输入 → 结论）

记号：`T1` 租户；`A` 面试官（`actor.kind=HUMAN`）；`C` 候选人；`app1` 是 `C` 在 `job1` 上的 ACTIVE 申请。全部用例除注明外 `intent=CREATE`、`delivery_mode=VIDEO`、`B=0`。

| # | 输入（关键差异） | 结论 | 理由 / 依据 |
|---|---|---|---|
| **C1** | `app1`+`round=1`+`slot='DEFAULT'`；面试官 `[A1,A2]`；`2026-11-20T10:00+08:00`，`duration=60`；`meeting={provider:'FEISHU', calendar_event_id:'evt_1'}`；无冲突 | **排定成功**：`interview.status='SCHEDULED'`，`scheduled_end_at=11:00`，2 行 `interviewer`，`meeting_binding(binding_method='SCHEDULED')`，`binding_state='BOUND_ACTIVE'`，`transcript.state='PENDING'` | §2 A1–A10 全过；`uq_interview_slot` 无占用 |
| **C2** | 同一面试官 `A1` 已有一场 `SCHEDULED` `10:00–11:00`；新场 `10:30–11:30` | **`CONFLICT_SLOT`**（`reason_code='INTERVIEWER_BUSY'`），`detail.conflicts=[{kind:'INTERVIEWER',ref_id:<已存在场次>,window:{start:'10:00',end:'11:00'}}]`，**不落任何行** | §3.2 `OVERLAP`；SC-C1/SC-C7 |
| **C3** | 同上但新场 `11:00–12:00`（背靠背） | **排定成功**（无冲突） | 半开区间 `[10:00,11:00)` 与 `[11:00,12:00)` 不相交（§3.1） |
| **C4** | `(app1,1,'DEFAULT')` 已有 `SCHEDULED` `10:00–11:00`；`intent=RESCHEDULE`，`interview_id=<该行>`，新时间 `14:00`，`expected_record_version=3` | **同一行更新**：`record_version` 4，`status` 仍 `SCHEDULED`，**不新建 interview**；必须写出 `interview.rescheduled` 事件（`payload.from/to`）；旧 binding 解绑 + 旧 meeting `REPLACED`（若换会议） | H-1；§4.2；§4.4 |
| **C5** | 面试官 `A2` 请假；`A2` 的 `required_scorecard` 原为 `true`；该场其余不变 | 允许：`A2.required_scorecard=false` + `interviewer.withdrawn` 事件；**不得** `DELETE interviewer`；`evaluation.required_scorecards` 减 1；若减到 0 → `get` 出 `NO_REQUIRED_EVALUATOR` 警告 | §4.3；`trg_interviewer_no_delete`；`APP-05` |
| **C6** | 某场已 `POST_INTERVIEW` 且有 1 份 `SUBMITTED` 面评；请求 `intent=CANCEL` | **`INVALID_ARGS(INVALID_STATE_TRANSITION)`**，不落行 | §6.1：已发生的面试不叫取消 → 应走 `decision(WITHDRAW)`。**若该场是 `SCHEDULED`**（异常但可能，例如提前交评）→ 允许取消；面评**保留**（SC-X1）、不再阻塞（SC-X2）、之后不得新增（SC-X3） |

**覆盖检查**：正常排定(C1) · 面试官冲突(C2) · 边界不相交(C3) · 改期同一行(C4) · 面试官变动(C5) · 取消与已交面评(C6)。

---

## 11. 实现者最容易搞错的 8 个点（①–③ 是必须裁决的，已裁决）

| # | 容易写成 | 为什么错 | 裁决 |
|---|---|---|---|
| **①** | "改期就 `UPDATE` 一下时间，反正状态没变也不用写事件" | `fn_row_guard` 在状态不变时**只自增版本、不写事件**，且禁止手改 `status_changed_at`（`0001 L102-120`）。于是这场面试的时间变化**零痕迹**：事后没人能回答"它原来排几点、谁改的" | 服务层**必须**显式写 `interview.rescheduled`，`payload` 含 `from/to/actor_id/reason`（§4.4）。审计不能指望触发器 |
| **②** | 把 `RESCHEDULED` 当成"改过期的永久标记"，新时间也保持 `RESCHEDULED` | 该状态在 `ck_interview_scheduled` 里**豁免时间必填**（`L968-970`）；一旦把它当终态，就会出现"没有时间的面试永远合法"，S10 无从判断该不该取材料 | `RESCHEDULED` = **当前无有效时间**；给了新时间必须回 `SCHEDULED`（§4.2 表） |
| **③** | "取消后想再面同一轮同一场 → 直接 `CREATE` 一条新的" | `uq_interview_slot` 仍占着 `(app, round, slot)` → `23505`。换成新 `slot_code` 绕过，会让"这一轮到底几场"永久说不清 | 取消后重排**只能** `RESCHEDULE` 同一行（§6.3）；`ALREADY_SCHEDULED` 定义涵盖 CANCELLED（§6.4） |
| ④ | 因为绑不上会议就拒绝排期，或把 `meeting` 建成一个占位行（空 ID） | 前者让"日历授权过期"变成"不能面试"；后者违反 `ck_meeting_identity`（`L1007`），只能靠编造 ID 通过 | 排定成立 + `UNBOUND` + 补绑任务（§7.3）。**永不编造平台 ID** |
| ⑤ | 把"时长"从 `scheduled_end_at - scheduled_start_at` 反推，允许 `end` 为空 | 库允许 `end` 空（`ck_interview_window` 只在两者都非空时比较，`L966`），于是"没有时长的面试"能存进去；冲突判定会退化成"点 vs 区间" | 契约严于库：`scheduled_end_at` **必填**，`duration_minutes` 是入参不是推导值（§2 A5、§13 S-2） |
| ⑥ | 用 `scheduled_*` 判断一个**已经开过**的会占没占位 | 实际开会常超时（排 60 分钟开了 80 分钟），用计划值会放行一个真冲突 | `EW(x)` 里 `actual_*` 优先（§3.1） |
| ⑦ | 用 `required_scorecard=false` 当"旁听"的同义词，或反过来当"还在"的依据 | 它有两种成因（旁听 / 已退出，§4.3），并且**直接决定占不占位**（SC-C8）：读错就会要么把请假的人永久锁死时段，要么让旁听者被排进两场 | 认定"退出"必须看 `event_type='interviewer.withdrawn'`；认定"占位"只用 `required_scorecard=true`（§4.3、§3.2） |
| ⑧ | 认为 `execution_mandate` 已经禁掉了 agent 写面评 | CHECK 只禁 `approve/reject/decide/merge_candidate/waive_scorecard`（`L1648`），**没禁 `submit_scorecard`** | 靠 `SC-I1`（`status_changed_by_actor_id = interviewer.actor_id`）+ `SC-I5`（工具零 scorecard 写入）守（§5.2、§13 G-5） |

> **方法论注（D-46 的教训）**：不要为罕见场景堆闸门（§3.4 明确不做"工作时间求交"），但也**不要**把"同一人同一时段两场"当罕见 —— 在真实招聘里它每天都在发生，所以它是拒绝项而不是提示项（§3.3）。

---

## 12. 系统不做的事（明确清单）

| 不做 | 为什么 | 谁做 |
|---|---|---|
| 不代面试官提交面评、不生成分数/结论 | `APP-07`、`docs/04 §17 禁止①` | 每位面试官本人（`SC-I1`） |
| 不猜会议（不按标题/姓名/模糊时间绑定） | `docs/04 §12` 逐字、`APP-04` | 人工绑定（`binding_method='MANUAL'`） |
| 不创建飞书日历事件、不发邀请、不发邮件 | H-2；外部写必须 Effect + 回读（`XINV-4`/`XINV-10`） | connector（v1.0 由人在平台操作，工具只登记） |
| 不查任何人的日历空闲、不推断候选人可用时间 | §3.4；无授权数据源 | 人给时间 |
| 不做会议室/场地资源管理 | `docs/04 §4` 逐字 | 线下行政 |
| 不做"自动找最优时间" | 同上；且无空闲数据 | 人 |
| 不删除任何 interview / interviewer / scorecard 行 | `trg_*_no_delete`、`INV-2` | 无人（结构禁止） |
| 不因冲突自动改期 | §3.3 | 人发起 `RESCHEDULE` |
| 不做耗时/准时率统计 | v1.0 范围外 | 复盘（S12，指标后置） |

---

## 13. 与现有 schema 对不上的地方（需要 `0002` 的清单）

> 全部 fail-closed：缺口未补时对应动作返回明确错误码，**不做"近似实现"**。

| # | 缺口 | 影响 | 需要的变更 | v1.0 现行口径 |
|---|---|---|---|---|
| **G-1** | `interview` **没有** `delivery_mode`（形式）列，也**没有** `cancel_reason` 列（`0001 L930-971`） | "形式"无法落库（A7）；取消理由只能进事件 `payload` | `0002`: `interview.delivery_mode text not null default 'VIDEO'` + CHECK `in ('VIDEO','ONSITE','PHONE')`；`interview.cancel_reason text` | v1.0 只接受 `VIDEO`；取消理由落 `interview.cancelled` 事件 `payload.reason` |
| **G-2** | `meeting` **没有计划时间列**（只有 `actual_start_at/actual_end_at`，`L1000-1001`） | 改期后"旧会议原本排几点"无结构化留痕；§3.1 的 `EW` 对未发生的会议只能靠 `interview.scheduled_*` | `0002`: `meeting.scheduled_start_at/end_at` | 旧时间只存在于 `interview.rescheduled` 事件；`meeting` 只记 `REPLACED` 事实 |
| **G-3** | `interviewer` **没有** `status`/`removed_at`/`record_version`，且在禁删名单里（`L973-990`、`L1725`） | 请假/换人无法结构化表达（§4.3）；并发修改无版本保护（§9 SC-K7） | `0002`: `interviewer.status text` + CHECK `('INVITED','CONFIRMED','DECLINED','REMOVED')`、`removed_at`、`record_version` + `fn_touch` | `required_scorecard=false` + `interviewer.withdrawn` 事件；面试官变更时 touch `interview` 借版本 |
| **G-4** | `interview.stage_code` 默认 `'INTERVIEW'`（`L937`），**不在 S1–S12**，且**没有**外键到 `stage_catalog` | 与 D-22（S1–S12 唯一口径）冲突；`application.current_stage_code` 已被 0004 加了外键，`interview` 没有 → D-23 的问题在另一张表复发 | `0002`: 默认值改 `'S8'`（`stage_catalog` 里"面试规划与排期"）+ 复合外键 `(tenant_id, stage_code) → stage_catalog(tenant_id, code)` | 写入端**必须**显式给 `stage_code`，取值只能来自 `stage_catalog`；本章节号 (S9/S10) **不是** stage code（见文首提醒） |
| **G-5** | `execution_mandate` 的 CHECK **未禁** `submit_scorecard`（`L1648`） | 库层不阻止 agent 代填面评（§5.2、§11-⑧） | `0002`: 把 `submit_scorecard` 加进禁用动作数组 | 契约用 `SC-I1`（actor 比对）+ `SC-I5`（静态扫描）守 |
| **G-6** | `meeting_binding.record_version` / `meeting.record_version` 有列但**没有触发器自增**（只在禁删名单里，`L1726`） | 用 `expected_record_version` 保护 meeting/binding 更新是**假的**（永远相等） | `0002`: 给两表加 `fn_touch` | 契约**不得**声称对 meeting/binding 做乐观并发；靠 §9 SC-K7 在 `interview` 上借版本 |

**三处"契约严于库"**（必须显式知道，别指望数据库拦）：

| # | 库允许 | 契约要求 | 理由 |
|---|---|---|---|
| S-1 | `interview.status` 可被任意 UPDATE 成任意合法枚举值（CHECK 只看取值） | 只允许 §8 的边 | `APP-06`：边集是领域服务的事 |
| S-2 | `scheduled_end_at` 可空（`ck_interview_window` 只在双非空时比较） | 排定后**必须非空** | 没有时长就没有占位窗口，冲突判定失效（§11-⑤） |
| S-3 | 同一 `(application, round_no, slot_code)` 的 `CANCELLED` 行永远占着唯一索引 | 取消后重排必须走 `RESCHEDULE` | §6.3 / §6.4 |

---

## 14. 依据索引

| 代号 | 位置 | 本文用它裁定了什么 |
|---|---|---|
| `15-arch §1` | `work/handoff/15-architecture-hv.md:46-49` | S9 = 面试安排（阶段编号口径） |
| `15-arch §5` | 同上 `:143` | v1.0 S9 = "简版"（单形式、不查空闲、不建会） |
| `docs/04 §4` | `work/handoff/04-connectors-and-transcript.md:53-57` | 9 类排期约束的取舍；会议室不是默认约束 |
| `docs/04 §10` | 同上 `:96-99` | 会后不能才绑；处理与评价并行 |
| `docs/04 §11` | 同上 `:104-112` | 1 Interview : N Meeting；改期/断线的关系 |
| `docs/04 §12` | 同上 `:115-125` | 绑定靠平台 6 维 ID；禁止标题/姓名/模糊时间 |
| `docs/04 §18` | 同上 `:200-213` | 状态轴不得压平；Evaluation Ready 三条件 |
| `docs/04 §19` | 同上 `:215-229` | 重复事件去重、`NEEDS_LINKING`、不标 READY |
| `docs/04 §20 A` | 同上 `:233` | `PRIMARY/CONTINUATION/REPLACED/CANCELLED` 的语义 |
| `SCHEMA §8 INV-1/4/7` | `db/SCHEMA.md:171/175/178` | 申请关联、轮次、面评双非空 |
| `SCHEMA §9 XINV-1/4/10` | 同上 `:189/192/198` | 幂等、副作用回执、完成须回读 |
| `SCHEMA §10 APP-04/05/06/07` | 同上 `:209-212` | 禁模糊绑、Evaluation Ready、边集、Agent 不代填 |
| `SCHEMA §12 N28` | 同上 `:264` | 同一会议绑第二个面试 = 23505 |
| `0001 L930-971` | `db/migrations/0001_init.sql` | `interview` 全部列与 CHECK |
| `0001 L973-990` | 同上 | `interviewer`（无 status、`uq_interviewer`） |
| `0001 L1016-1045` | 同上 | `meeting_binding`（`uq_meeting_binding_active`、`MANUAL` 必须留人） |
| `0001 L102-120` | 同上 | 状态不变时**不写事件**（§4.4 的根因） |
| `0001 L213-230` | 同上 | 已提交面评冻结 |
| `0001 L1648` | 同上 | mandate 禁用动作清单（未含 `submit_scorecard`） |
| `0004 L55-72` | `db/migrations/0004_stage_catalog.sql` | `stage_catalog` 结构（G-4 的外键目标） |
| `D-18` | `work/control/DECISIONS-2026-11-12.md:65` | `SET LOCAL` + 不缓存版本号 |
| `D-33` | 同上 `:196` | v1.0 不做权限矩阵 → 本文**不写**任何"谁能排期"的拦截 |
| `D-46` | 同上 `:299` | 方法论：不为罕见场景设闸门（§3.4 / §11 注） |
