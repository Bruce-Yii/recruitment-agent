# scorecard-rules.md · 面评（S10 上半）领域规则

**版本**：`scorecard 1.1.0`（与 `decision 1.1.0` / `evaluation-tool-contracts 2.0.0` 同一基线）
**日期**：2026-11-13
**范围**：**面评**这一件事——谁能交、必须绑什么、交完能不能改、缺了怎么办、彼此看不看得见。**不含任何实现**（不写 SQL、不写 TS）
**上位**：老仓 `work/handoff/15-architecture-hv.md`（新仓未收录；阶段码口径已由 D-22 与 `db/stage_catalog` 取代，见 `contracts/STAGE-CODES.md`）（S10 = 面评 → 汇总 → 决策，v1.0 要做）、`work/handoff/11-pdf-acceptance-criteria.md` §9（**老仓，新仓未收录**；三态 / 拒绝可解释 / 可回溯）。**两者都不是本仓可查的依据**，冲突时以本仓 `db/` 与 `docs/17-decision-ledger.md` 为准。
**落库依据**：`db/SCHEMA.md`、`db/migrations/0001_init.sql`（行号即该文件行号）、`0005_version_binding.sql`、`0006_integrity_gaps.sql`（**约束被后续迁移改过的地方，一律按文件名 + 小节引用，不写行号**）。`0002_seed.sql` **无 DDL**；本文提到的所有"待补"DDL 一律指向 **`0007`**（`D-75`）。
**配套**：`decision-rules.md`（汇总与决策）、`tool-contracts.md`（三个工具的形状）

> **本文件的唯一职责**：回答「这份面评算不算数」。
> 它**不**回答「该不该录用」——那是 `decision-rules.md`；也**不**回答「工具怎么调」——那是 `tool-contracts.md`。

---

## 0. 引用图例（三份契约共用）

| 标记 | 含义 | 出处 |
|---|---|---|
| `INV-1`…`INV-10` / `XINV-1`…`XINV-10` / `APP-01`…`APP-09` / `N01`…`N32` | 数据不变量 / 跨模块不变量 / 应用层规则 / 负向测试 | `db/SCHEMA.md` §8 / §9 / §10 / §12 |
| `D11 §9.x` | PDF 验收标准第 9 章（三态、拒绝可解释、可回溯、受保护属性） | `work/handoff/11-pdf-acceptance-criteria.md`（**老仓，新仓未收录**；不可作为可查依据） |
| `ck_*` / `uq_*` / `fk_*` / `trg_*` / `fn_*` | 已存在的库约束、索引、触发器、函数（逐字取自迁移文件） | `0001_init.sql` / `0004_stage_catalog.sql` / `0005_version_binding.sql` / `0006_integrity_gaps.sql` |
| `0001:L####` / `0004:L###` / `0003:L###` | 行号证据（本文件的每条裁决都能落到一行） | 同上（**只对未被后续迁移改过的定义有效**；被 `0005` / `0006` 改过的，改按文件名 + 小节引用） |
| `D-xx` | 总控裁定 | `docs/17-decision-ledger.md` + 裁定编号（**不写行号**，`D-82`） |
| `SC-xx` / `DC-xx` | 本文件 / `decision-rules.md` 的规则编号 | — |

> **编号说明（故意的）**：规则用 `SC-` / `DC-` 前缀，**不用 `S`**。阶段码的唯一口径是 `S1`–`S12`（`D-22`），规则若叫 `S-1` 会与阶段码混读。

---

## 1. 七条不可协商的结论（先读这七行）

| # | 结论 | 依据 |
|---|---|---|
| **1** | **每个面试官自己交自己的，一人一轮一份当前面评。** 结构上做不到"一个人替三个人交"或"一个人交两份当前面评" | `uq_interviewer (interview_id, actor_id)` `0001:L984`；`uq_scorecard_current` `0001:L1322-1323` |
| **2** | **面评必须同时绑定三样：面试轮次、Rubric 版本、提交时间。** 少一样就不算面评，算草稿 | `INV-7`（"Scorecard 必须记录评价者和评分标准版本"）；`interview_id`/`interviewer_id`/`rubric_version_id` 三列 `NOT NULL` `0001:L1277-1280`；`ck_scorecard_submitted` `0001:L1314-1315` |
| **3** | **提交后一个字节都不能改。** 要改只能新增一行新修订，旧行留历史 | `fn_scorecard_guard` `0001:L213-230`；`trg_scorecard_submitted_guard` `0001:L1811-1813`；`ck_scorecard_status` 只允许 `PENDING·SUBMITTED·WAIVED` `0001:L1310`；`N11` |
| **4** | **缺就是缺：没交的面评既不是 0 分，也不进平均分的分母，也不算反对票。** | 本文件 §6；`D11 §9.2`；`docs/03 §14`（"某位面试官未提交也不能伪造评价完成"） |
| **5** | **"不通过"必须带具体理由**：只给一个 `REJECT` 结论、说不出是哪一项、为什么决定性的，**拒绝入库** | `D11 §9.3`（拒绝可解释）；`DC-24` |
| **6** | **草稿互相不可见**：汇总/决策只读 `SUBMITTED`/`WAIVED`，`PENDING` 行在面评之外**不存在** | 本文件 §8 |
| **7** | **面评缺不影响提交面评**：转写失败、Record 没出来，都不阻止面试官交面评（否则会逼人编造） | `docs/03 §14` 逐字："Transcript 分支失败不应阻止面试官提交 Scorecard"；`XINV-8` |

---

## 2. 对象与字段契约（逐列对齐 `0001_init.sql`）

### 2.1 关系

```
interview (1 Application, round_no, slot_code)  0001:L930-971
   └─n interviewer  (actor_id, required_scorecard, scorecard_due_at)  0001:L973-990
         └─0..1 scorecard  (当前行 = superseded_by_scorecard_id is null)  0001:L1274-1323
                └── 修订链：scorecard.revision_no = 1,2,3…
                    rubric_version_id → rubric_version（不可变）  0001:L588-611
```

### 2.2 权威列清单（只列本规则用到的）

| 表 | 列 | 约束 / 取值 | 本规则怎么用 |
|---|---|---|---|
| `scorecard` | `interview_id` `interviewer_id` `rubric_version_id` | 三列均 `NOT NULL`，且各有复合外键带 `tenant_id`（`0001:L1298-1303`） | §4 三绑定的物理保证 |
| `scorecard` | `revision_no` | `>= 1`（`ck_scorecard_revision` `0001:L1311`）；`uq_scorecard_revision (interview_id, interviewer_id, revision_no)` `0001:L1297` | §5 修订计数器 |
| `scorecard` | `status` | `PENDING` / `SUBMITTED` / `WAIVED`（`ck_scorecard_status` `0001:L1310`） | §8 可见性、§6 缺失判定 |
| `scorecard` | `submitted_at` | `SUBMITTED` 时必须非空（`ck_scorecard_submitted` `0001:L1314-1315`） | §4.3 提交时间 |
| `scorecard` | `items` | `jsonb`；`SUBMITTED` 时必须非空（`ck_scorecard_submitted` `0001:L1314-1315`）；**形状无库约束** | §4.4（本契约定义形状：**对象**，以 rubric 维度 `key` 为键 + 保留键 `transcript_basis`） |
| `scorecard` | `overall` | `text`，**无 CHECK**——所以枚举只能在契约里定 | §4.5。**列名就是 `overall`**（`0001:L1286`）；`scorecard` 表**没有** `recommendation` 列，下文一律用 `overall` |
| `scorecard` | `rationale` | `text`，**无 CHECK** | §7（REJECT 理由） |
| `scorecard` | `payload_hash` | `null` 或 64 位小写 hex（`ck_scorecard_hash` `0001:L1312`） | §9 幂等与不可改写 |
| `scorecard` | `waive_reason` | `WAIVED` 时必须非空（`ck_scorecard_waived` `0001:L1316-1317`） | §6.3 |
| `scorecard` | `status_changed_by_actor_id` / `status_changed_at` / `status_source_event_id` | 三列**全部可空**（`0001:L1290-1292`），外键到 `actor` / `event_inbox`（`0001:L1306-1309`）；**没有任何 CHECK 要求终态行必须填** | §4.7（终态行必须带 actor + 事件，`0007` 在库层加拦截） |
| `scorecard` | `superseded_by_scorecard_id` | 自引用外键（`0001:L1304-1305`）；不得等于自身（`0001:L1318-1319`） | §5 修订链 |
| `interview` | `round_no` / `slot_code` | `round_no` 1..20（`0001:L963`）；`slot_code` 正则（`0001:L964`）；`uq_interview_slot` `0001:L950` | **面评的"轮次"只能经 interview 得到**：`scorecard` 表里没有 `round_no` 列 |
| `interviewer` | `required_scorecard` | `boolean NOT NULL default true`（`0001:L979`） | §6.1 "必填面评"的唯一口径 |
| `interviewer` | `scorecard_due_at` | 可空（`0001:L980`） | §6.4 逾期 |
| `rubric_version` | `dimensions` / `payload_hash` | 非空 array（`0001:L609-610`）；64 hex（`0001:L608`） | §4.2 面评分项必须来自这里 |
| `rubric_version` | 整行 | 不可 `UPDATE`（9.3 白名单为空 `0001:L1779`） | §10 配置不静默改写历史评价 |

### 2.3 四个**不在**表里的东西（必须在契约层补）

| 缺什么 | 为什么不能靠库 | 契约怎么补 |
|---|---|---|
| **"轮次"的独立列** | `scorecard` 只有 `interview_id`（`0001:L1277`），没有 `round_no` / `slot_code` | 输出必须回显 `round_no` + `slot_code`（经 `interview` 联结），写入时以 `interview_id` 为准，**禁止**让调用方传轮次（传了就是两个真相源） |
| **`items` 的形状** | `items jsonb`，`ck_scorecard_submitted` 只校验非空（`0001:L1314-1315`） | §4.4 定义封闭形状（**对象**），并在汇总时二次校验（`tool-contracts.md` §3.4） |
| **`overall` 的枚举** | `text` 无 CHECK（`0001:L1286`） | §4.5 定死 `ADVANCE·HOLD·REJECT`，写侧不合法即 `INVALID_ARGS` |
| **"这份 rubric 属于这个岗位"** | `fk_scorecard_rubric` 是 `(rubric_version_id, tenant_id)` **两列**（`0001:L1302-1303`），**不含 `job_id`** → 拿别的岗位的 Rubric 打分，库一声不吭 | **SC-47**：写侧必须校验 `rubric_version.job_id = application.job_id`；`0007` 加库层约束（`D-54`、`D-75` 第 3 条） |

---

## 3. 谁是作者：身份只从执行上下文来

### 3.1 规则

| # | 规则 | 判定方式 | 依据 |
|---|---|---|---|
| **SC-01** | 面评的作者 = **执行上下文的 actor**（`SET LOCAL recruitment.actor_id`），不接受入参指定 | 入参出现 `interviewer_id` / `actor_id` / `tenant_id` → `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)` | `D-18`（`SET LOCAL` + 统一封装）；`XINV-7` |
| **SC-02** | 作者必须**是该场面试已登记的面试官**：存在 `interviewer` 行 `(interview_id, actor_id)` | 无行 → `INTERVIEWER_MISMATCH(ACTOR_NOT_INTERVIEWER)` | `uq_interviewer` `0001:L984` |
| **SC-03** | 作者必须是 `actor.kind='HUMAN'` | 非 HUMAN → `INTERVIEWER_MISMATCH(ACTOR_NOT_HUMAN)` | `APP-07`（Agent 不得写面评内容）；`ck_execution_mandate_no_business_approval` 禁 `waive_scorecard` `0001:L1647-1648` |
| **SC-04** | 同一位面试官对同一场面试**同时只有一份当前面评** | 已有 current(`SUBMITTED`/`WAIVED`) 行 → `ALREADY_SUBMITTED`（要改走 §5 修订） | `uq_scorecard_current` `0001:L1322-1323` |
| **SC-05** | **不得代填**：任何以 A 的身份写 B 的面评的路径都不存在（不是"被权限拦住"，是**结构上没有这条路径**） | 入参无 `interviewer_id`（SC-01）+ 作者取自上下文（SC-01） ⇒ 两者必然同一人 | `D-33`（v1.0 不做权限），所以"禁止代填"**不能**靠权限，只能靠没有这个入参 |

> **SC-05 为什么重要**：`D-33` 已经把 v1.0 的权限矩阵**撤销**（全局可见、角色只做标签）。因此"不能代填"**绝不能**实现成"检查 A 有没有资格代填"——那会是一个永远返回 true 的假接口（`D-33` 明令"不预留假接口"）。正确做法是**入参里根本没有"作者"这个字段**。

### 3.2 一个必须写死的边界

`D-33` 之后，**同租户所有人都能看见所有已提交面评**（含内容）。这不是漏洞，是有意的产品降级。但它带来两个必须显式写的约束：

1. **可见 ≠ 可改**：看得见别人的面评，改不了（SC-03 + SC-04 + `fn_scorecard_guard`）。
2. **不得输出"权限判定"字段**：工具里**不许**出现 `can_decide: true` / `can_submit: true` 这类恒真字段（`D-33` 原话："不预留假接口"）。门禁只表达**数据/流程**条件，不表达**权限**。

---

## 4. 三绑定：轮次、Rubric 版本、提交时间

### 4.1 轮次（round）

| # | 规则 | 依据 |
|---|---|---|
| **SC-06** | 面评归属的轮次 = `interview.round_no` + `interview.slot_code`；同一轮可以有**多个** `Interview`（用人经理场 + 专家场），**各自独立面评** | `uq_interview_slot (application_id, round_no, slot_code)` `0001:L950`；`docs/03:L63` 逐字："同轮可同时有用人经理面试 + 业务专家面试，分别产生实际 Interview 和独立 Scorecard" |
| **SC-07** | 调用方**只传** `interview_id`，**不传** `round_no`/`slot_code`；输出里回显这两个值供核对 | 两个真相源的经典错误；`0001:L1277` 只有 `interview_id` |
| **SC-08** | `interview.status` **不作为**提交前置（`SCHEDULED` 也能交，补录场景要允许）；但 `CANCELLED` / `NO_SHOW` 的面试**不得**产生新的 `SUBMITTED` 面评 | 补录是真实需求（面试结束 3 天后才写）；取消的场次写面评会让汇总把不存在的过程算进去 |

### 4.2 Rubric 版本（**本节是本文件最容易做错的地方**）

| # | 规则 | 依据 |
|---|---|---|
| **SC-09** | 面评绑定的是**该申请钉住的版本** `application.rubric_version_id`，**不是** `job.current_rubric_version_id` | `application.rubric_version_id` `0001:L839`；`INV-10`（配置变更不静默改变历史评价）；`J-*` 同构裁决见 `job-rubric-rules.md §4.3`。**注意**：`0001` 建表时的 `fk_application_rubric`（`0001:L866-867`）**已被 `0005_version_binding.sql` §3 DROP**，现形态是 `fk_application_rubric_job`：`(tenant_id, rubric_version_id, job_id) → rubric_version (tenant_id, id, job_id)`（`D-53`） |
| **SC-10** | **不做任何 fallback**：`application.rubric_version_id` 为空时，**必须**由调用方显式给 `rubric_version_id`；不给 → `INVALID_ARGS(RUBRIC_UNRESOLVED)`。**禁止**悄悄用"岗位当前版本"顶上 | `D-21`（当前版本是**业务状态**，必须显式指针）；`0001:L839` 该列**可空**，所以"悄悄顶"在库里根本拦不住 |
| **SC-11** | 显式给 `rubric_version_id` 且 ≠ 申请钉住的版本 → `INVALID_ARGS(RUBRIC_MISMATCH)`；**没有**"what-if 面评"这回事（对比筛选的 `what_if`） | 面评会进决策依据，允许换标准评分等于允许**用 A 标准评价、用 B 标准淘汰** |
| **SC-12** | `items` 的键集**必须恰好等于** `rubric_version.dimensions[].key` 的集合 **∪ `{transcript_basis}`**（保留键，`TR-E2`）：不许多、不许少、不许改名。缺一个维度 = 漏评（`DIMENSION_COVERAGE_INCOMPLETE`），多一个 = 编了 rubric 里没有的维度（`DIMENSION_NOT_IN_RUBRIC`） | `0001:L609-610`（`dimensions` 是非空 array）；`D-74`（对象形态天然检出漏评）；`interview/transcript-rules.md` TR-E2 |
| **SC-13** | 覆盖率必须 **100%**：`dimensions` 里每个 `key` 恰好一个 `items` 键；维度数上限**只由 rubric 决定**（`R-VAL-1` 允许 **1–50**），契约**不得**另设更小的常数上限（任何常数都会把"评不全"变成"契约允许评不全"） | 与 `D-31` 同构（"每块恰好归入一个 section"）；`job-rubric-rules.md §6.2` `R-VAL-1` |
| **SC-47** | 面评绑的 rubric **必须是该申请那个岗位的**：`rubric_version.job_id = application.job_id`（经 `interview.application_id` 反查）。不成立 → `INVALID_ARGS(RUBRIC_NOT_OF_JOB)`。**哪条路径才需要这条检查**：走 `APPLICATION_PINNED` 时 `fk_application_rubric_job` 已在库层保证（`0005` §3）；**真正需要契约兜的是 `EXPLICIT_VERSION_ID` 路径**（`SC-10` 给了一个版本 id，库只校验"存在且同租户"）。**不能指望 `scorecard` 侧的库约束**：`fk_scorecard_rubric` 是两列、不含 `job_id`（`0001:L1302-1303`），`scorecard` 表也没有 `job_id` 列；`0007` 补库层约束（`D-54`、`D-75` 第 3 条） | `D-54` 明确登记了这条漏洞（"评分卡能拿别的岗位的标准打分"）；`0007` 待落地 |

### 4.3 提交时间（submitted_at）

| # | 规则 | 依据 |
|---|---|---|
| **SC-14** | `submitted_at` **由服务端取时钟**（`now()`），**不接受入参** | 可由调用方给定 = 可以伪造"面试当天就交了"或"补录成了当天"。`0001:L1283` 只是一列时间，无来源校验 |
| **SC-15** | 输出必须回显 `submitted_at` + `interview.scheduled_start_at`，供人判断"距面试多久才交"（不做任何自动判定） | 逾期与否是 §6.4 的事，不改写时间 |
| **SC-16** | `submitted_at` 与 `created_at` 必须同一次写入、同值（不允许"先建行后补交"制造两个时间） | 减少一个可疑字段；`N10` 已挡住"`SUBMITTED` 无 `submitted_at`"，但挡不住两者不一致 |

### 4.4 `items` 的形状（契约定义，库不校验）

**`items` 是一个对象**，不是数组：键 = rubric 维度 `key`（恰好覆盖，SC-12/13），外加**保留键** `transcript_basis`（`TR-E2`）。`D-74` 裁定对象形态，理由：① 已提交的 `interview/transcript-rules.md` TR-E2/TR-E3 与 `interview/tool-contracts.md` §2.3 两处已依赖对象形态；② 对象缺键就是"漏评一维"，数组要扫描且允许重复 key。

```json
{
  "transcript_basis": "TRANSCRIPT",
  "backend_depth": {
    "assessment": "MET",
    "score": 4,
    "note": "能讲清分库分表的一致性问题，举了自己项目里 2 个具体案例",
    "evidence": [
      { "kind": "SEGMENT",
        "transcript_artifact_id": "…", "transcript_revision": 1,
        "segment_id": "…", "quote": "我们当时把订单表按用户 ID 分了 64 片…" }
    ]
  },
  "system_design": { "assessment": "NOT_OBSERVED", "score": null, "note": null, "evidence": [] }
}
```

| 字段 | 规则 | 依据 |
|---|---|---|
| `items` 本身 | **对象**（不是数组）。键集 = `rubric_version.dimensions[].key` ∪ `{transcript_basis}`，**恰好覆盖**（SC-12/13） | `D-74`；`0001:L609-610` |
| `items.transcript_basis` | **保留键，必填**，`TRANSCRIPT` \| `NO_TRANSCRIPT`：转写 `READY` 时必须 `TRANSCRIPT`，否则**必须** `NO_TRANSCRIPT`（`TR-E2`）；它与维度同名是**非法**的（维度 key 不得为 `transcript_basis`） | `interview/transcript-rules.md` TR-E2、`interview/tool-contracts.md` §2.3；库无该列（`TR §13 G-1`） |
| `items.<dimension_key>.assessment` | **封闭四态**：`MET` / `NOT_MET` / `NOT_OBSERVED` / `UNREADABLE`（语义见 §4.5） | `D11 §9.2` 三态在面评语的落法：人也会"看不到"与"判不了" |
| `items.<dimension_key>.score` | 仅 `MET`/`NOT_MET` 时允许 `1..5`；`NOT_OBSERVED`/`UNREADABLE` 时**必须 `null`** | 给"判不了"打 1 分，等价于把 `unreadable` 当"不满足"（`D11 §9.2` 红线） |
| `note` | `NOT_MET` 时**必须非空**；其余可空 | §7 |
| `evidence[]` | 可空。有则每条必须带 `transcript_artifact_id` + `transcript_revision` + `segment_id` + `quote`；`quote` 必须是转写原文片段 | `D11 §9.9`（可回溯）；但**不得强制**——见 SC-32 |
| `evidence[].kind` | **只有 `SEGMENT`**。旧写法 `TRANSCRIPT_SEGMENT` **已作废**（`D-74` / `TR-E3`），出现即 `INVALID_ARGS(ENUM_INVALID)`。`transcript_basis='NO_TRANSCRIPT'` 时**不得**出现 `kind='SEGMENT'`（`TR-E3`）→ `INVALID_ARGS(TRANSCRIPT_BASIS_CONFLICT)` | `D-74`；`interview/transcript-rules.md` TR-E3 |

### 4.5 四态的定义（**不许互相顶替**）

| `assessment` | 含义 | 能作为 `REJECT` 的面评依据吗 | 能作为 `ADVANCE` 的面评依据吗 |
|---|---|---|---|
| `MET` | 亲眼观察到且满足 | 否 | **是**（且必须有 `note` 或 `evidence`） |
| `NOT_MET` | 亲眼观察到且不满足（**反证**） | **是**（必须有 `note` + 在 `reject_reasons[]` 里点名） | 否 |
| `NOT_OBSERVED` | 问了但候选人没体现，或没来得及问 | **否** | **否**（"没看到"不等于"不行"，也不等于"行"） |
| `UNREADABLE` | 材料/证据读不出来（转写缺失、录音损坏、无法回听），或现场条件不允许判断 | **否**（`D11 §9.2` 红线） | **否** |

> **一行记住**：`NOT_MET` 是唯一能"往下拉"的值；`NOT_OBSERVED`/`UNREADABLE` 是"两个方向都不许"的值。把 `UNREADABLE` 当 `NOT_MET` 用，就是 `D11 §9.11` 红线 7 在 S10 的复发形态。

### 4.6 `overall`（一句话结论）

| 值 | 含义 | 条件 |
|---|---|---|
| `ADVANCE` | 建议进入下一轮 / 录用 | **全部** `dimensions` 的 `assessment='MET'`（有 `NOT_OBSERVED`/`UNREADABLE` 就不许说 ADVANCE，见 SC-33） |
| `HOLD` | 说不好 / 有读不出的维度 / 需要别人再看 | 兜底值（`ck_decision_result` 里没有"待确认"，S7 的同类裁决见 `screening-rules.md §5`） |
| `REJECT` | 建议不进入 | 至少 1 条 `NOT_MET`，且 `reject_reasons[]` 非空（§7） |

### 4.7 写路径的两条硬约束（**不是"一行 UPDATE/INSERT"能解决的**）

| # | 规则 | 依据 |
|---|---|---|
| **SC-44** | **终态行必须带 actor + 内部事件**：任何直接 `INSERT` 出 `status ∈ {SUBMITTED, WAIVED}` 的行，**必须**同时显式写 `status_changed_by_actor_id`（= 执行上下文 actor）、`status_changed_at`、`status_source_event_id`（指向同一事务里先写入的 `event_inbox` 行）。**不能指望库拦**：`fn_row_guard` 是 **BEFORE UPDATE**（`trg_scorecard_guard_status`，`0001:L1751` 在清单里、`0001:L1763-1765` 建的是 update 触发器），`INSERT` **根本不触发它** → 不写 actor 也能插进去，且事件线上**什么都没有**。`0007` 在库层加拦截（`D-75` 第 5 条） | `0001:L1290-1292` 三列可空、无 CHECK；`0001:L1741-1767` 全是 `before update`；`D-75`；`XINV-9` |
| **SC-45** | **`PENDING → SUBMITTED` 不能只写"一行 UPDATE"**：同一条 `UPDATE` 会触发 `fn_row_guard`，它（a）**要求能在库端确定 actor**（`SET LOCAL recruitment.actor_id` 或显式写 `status_changed_by_actor_id`，否则 `ACTOR_REQUIRED` 23514，`0001:L122-132`）；（b）**自己插一条 `event_inbox` 行**并回填 `status_source_event_id`（`0001:L140-153`）；（c）把 `record_version` 置为**旧值 + 1**、`status_changed_at` 置 `now()`（`0001:L155-167`）。因此工具必须：① 同一事务内 `SET LOCAL recruitment.actor_id`；② `WHERE record_version = <更新前的值>`，出参回显**旧值 + 1**；③ **不要**在 `SET` 里手写 `record_version = record_version + 1`（会被触发器覆盖，写了只是误导）。**注意**：`UPDATE` 还必须是原地转正（同一行），新插一行会撞 `uq_scorecard_current` 23505（§6.2） | `0001:L83-169`（`fn_row_guard` 全文）；`0001:L130-132`（`ACTOR_REQUIRED`）；`0001:L219`（`old.status='PENDING'` 时 `fn_scorecard_guard` 不拦）；`SCHEMA §1` |

> **SC-44 与 SC-45 的关系**：正常提交走 `INSERT`（SC-44：必须自带 actor + 事件）；历史/别的路径留下 `PENDING` 行时走原地 `UPDATE`（SC-45：库会自动补事件，但仍必须有 actor）。**两条路径都必须留痕**——这是 `XINV-9`"关键结论可追溯到人工决策"在面评层的落点。

---

## 5. 提交后不可修改：修订路径

### 5.1 规则

| # | 规则 | 依据 |
|---|---|---|
| **SC-17** | `status <> 'PENDING'` 之后，**除 `superseded_by_scorecard_id` 外所有列**都不可改；改了报 `SCORECARD_IMMUTABLE`(23514) | `fn_scorecard_guard` `0001:L213-230`（比较时排除 6 列：1 列业务指针 + 5 列审计/并发列，`0001:L220-223`） |
| **SC-18** | 修订 = **新一行** `revision_no + 1` + 旧行 `superseded_by_scorecard_id` 指向新行。旧行**永不删除**（物理 `DELETE` 直接报 `DELETE_FORBIDDEN`） | 9.1 禁删清单含 `scorecard` `0001:L1721-1732`；`INV-2` 同构精神 |
| **SC-19** | 修订**必须**带 `revision_reason`（非空），写进新行 `rationale` 的开头一行 `修订原因：…`，或进新的 `items.<dimension_key>.note` | `scorecard` 无 `revision_reason` 列（`0001:L1274-1320`）——只能借 `rationale`，所以必须规定格式，否则"为什么改"会丢 |
| **SC-20** | 修订不得**降低证据标准**：新行的 `items` 必须仍满足 §4.4/§4.6（可机检），不得靠"改成 HOLD"绕过 §7 | 与 `D-32` 同构：不允许"为了让流程过而放宽校验" |

### 5.2 执行顺序（**顺序错了必然撞约束**）

写侧必须在**一个事务**内按下面顺序执行，否则会撞两个不同的约束：

| 步 | 动作 | 天真的写法会撞什么 |
|---|---|---|
| 1 | `INSERT` 新行，`revision_no = old.revision_no + 1`，`status='SUBMITTED'`，**且 `superseded_by_scorecard_id = old.id`**（临时"反向"指向） | 若第 1 步就让 `superseded_by` 为 `NULL` → `uq_scorecard_current` **23505**（同一 `(interview, interviewer)` 已有 current 行，`0001:L1322-1323`） |
| 2 | `UPDATE` 旧行 `SET superseded_by_scorecard_id = new.id` | 若先做这一步（新行还不存在）→ `fk_scorecard_superseded_by` **23503**（`0001:L1304-1305`，外键是**立即**校验，不可延迟） |
| 3 | `UPDATE` 新行 `SET superseded_by_scorecard_id = NULL` | 不做这一步，最终**没有任何 current 行**，`summarize` 会报"该面试官未提交"——最隐蔽的一种错 |

**为什么第 3 步能过 `fn_scorecard_guard`**：该触发器比较新旧行时**排除**了 `superseded_by_scorecard_id`（`0001:L220-223`），所以"清空指针"不算篡改。

> **这就是"三步舞"**：**反向插 → 换指针 → 清空**。任何两步写法都过不去。第 1 步是 `INSERT` 一条 `SUBMITTED` 新行 → 必须同时满足 **SC-44**（自带 `status_changed_by_actor_id` + `status_source_event_id` + 内部事件）。
>
> **`DC-36`（撤回决策）现在与本文同构，不再是"恰好相反"**：`0007` 给 `decision` 加上 current 部分唯一索引之后（`D-75` 第 2 条），"先插后指"会让两条 current 并存 → 23505，所以决策撤回也必须走三步舞。理由见 `decision-rules.md §8.2`。**但两段代码仍不得共用**：面评有 `fn_row_guard`（`record_version` 自动 +1、自动补事件），`decision` 没有（要手动 +1、手动补事件）。

---

## 6. 缺失面评：**缺就是缺**

### 6.1 "必填面评"的唯一口径

```
required_interviewers(i) := { x ∈ interviewer | x.interview_id = i ∧ x.required_scorecard = true }
usable(s)                := s.items 通过 §4.4 / §4.6 的形状校验        -- 校验项见 tool-contracts.md §3.4
done(i)                  := { x ∈ required_interviewers(i) |
                              ∃ s: s.current(i, x)
                                 ∧ ( s.status = 'WAIVED'
                                     ∨ (s.status = 'SUBMITTED' ∧ usable(s)) ) }
unusable(i)              := { x ∈ required_interviewers(i) |
                              ∃ s: s.current(i, x) ∧ s.status = 'SUBMITTED' ∧ ¬usable(s) }
missing(i)               := required_interviewers(i) \ done(i)          -- 含 unusable（"交了但这张不能用"）
not_required(i)          := { x ∈ interviewer | x.required_scorecard = false ∧ 存在 usable 的 current SUBMITTED }
current(i,x)             := scorecard where interview_id=i.id ∧ interviewer_id=x.id
                                  ∧ superseded_by_scorecard_id is null        -- 0001:L1322-1323
```

| # | 规则 | 判定方式 | 依据 |
|---|---|---|---|
| **SC-21** | 分母**只能**是 `required_interviewers`（`required_scorecard=true`），**不是** `interviewer` 表总行数 | `0001:L979`；把"旁听者"也算必填会让永远凑不齐 | `interviewer.required_scorecard` 这一列存在的唯一理由 |
| **SC-22** | **缺不是 0 分**：`missing` 里的面试官不得以任何形式进入分数计算（不加 0、不按 0 摊、不补均值） | 机检：输出中所有数值型聚合的 `denominator + excluded == required_total`（`DC-04`） | 本契约 |
| **SC-23** | **缺不是反对票**：`missing` 不计入 `tally.reject`，也不计入 `tally.hold` | 机检：`tally.advance + tally.hold + tally.reject + tally.waived == done`（`DC-02`） | 把"没交"当"反对"是最常见的错误淘汰路径 |
| **SC-24** | **缺不是平均**：`missing ≠ ∅` 时**不输出**任何"综合得分/总分"（`average=null` + `average_refused_reason='MISSING_SCORES'`）；逐维度均值可以给，但**必须**显式带 `denominator` 与 `excluded`，且 `method='PER_DIMENSION_SUBMITTED_ONLY'`。`submitted=0`（含全豁免）时 `method='NOT_COMPUTED'`、`average=null`、`average_refused_reason='NO_SUBMITTED_SCORECARD'` | `DC-04`；断言 M-1（`tool-contracts.md` §7.0） | "缺 1 个就按 2 个人平均"会把 3 人面板悄悄变成 2 人面板 |
| **SC-25** | **`WAIVED` ≠ 缺**：走完人工豁免流程的一行算"已处理"，但仍**不进分数**（`tally.waived`，分母排除），且 `waive_reason` 必须原样出现在汇总里 | `ck_scorecard_waived` `0001:L1316-1317`；`APP-05`（"必需 Scorecard 全交 **或 Waive**"） | 豁免是人的决定，必须留理由；不是"没交" |
| **SC-26** | 面评提交工具**不接受** `status='WAIVED'`：豁免是独立的人工命令，不得在"提交"里顺手豁免 | `APP-07`；`ck_execution_mandate_no_business_approval` 明禁 Agent `waive_scorecard` `0001:L1647-1648` | 否则会出现"面评没写，但被提交动作自动豁免" |
| **SC-46** | **`tally` 与均值的统计空间 = `required_interviewers`**。`required_scorecard=false` 的面试官（含 `role_in_interview='OBSERVER'` 的旁听者）**就算交了可用面评**，也**不进 `tally`、不进任何分母**；它们只在 `coverage.not_required` 里计一个数（不静默丢弃）。**否则**：observer 的面评会进 `tally`，而它不在分母里 → `tally` 总和 ≠ `coverage.submitted`（M-2 直接失败） | `0001:L978-979`（`role_in_interview` / `required_scorecard` 两列）；`DC-02`；本契约 §6.1 的 `not_required` | 分母与票数必须来自**同一个集合**，否则两个数字各说各话 |

### 6.2 `PENDING` 行怎么算

| 情形 | 算已交吗 | 为什么 |
|---|---|---|
| 无行 | 否 | 最干净 |
| `PENDING` 行（有 `items` 但没提交） | **否，且不算"进行中"**——在汇总里**与无行完全等价**（`missing`，不是 `in_progress`） | 读草稿 = 看见别人没写完的东西（§8）；把草稿算成"进行中"会让决策人以为"快好了"而等 |

> 本契约的三个工具**不产生任何 `PENDING` 行**（`scorecard_submit` 直接写 `SUBMITTED`）。若将来增加"存草稿"工具，它必须同时满足 SC-34 与 SC-35，且**不得**让 `summarize` 看见草稿。
>
> **一个必须知道的连带后果**：`uq_scorecard_current` **不看 `status`**（`0001:L1322-1323`），所以同一 `(interview, interviewer)` 只要有一条 `PENDING` 当前行，`INSERT` 一条 `SUBMITTED` 就会撞 23505。若历史数据或别的路径留下了 `PENDING` 行，提交**必须原地转正**（`UPDATE ... SET status='SUBMITTED'`；`old.status='PENDING'` 时 `fn_scorecard_guard` 不拦，`0001:L219`），不能新插一行。

### 6.3 `WAIVED` 的两种合法来源（都不在这三个工具里）

1. 面试官被临时替换 → 原 `interviewer` 行 `required_scorecard` 改 false（**需独立命令**，不在本契约）；
2. 组织决定免评 → 独立的人工豁免命令写 `WAIVED` + `waive_reason`。

**两种都不允许**由 `scorecard_submit` 或 `summarize` 产生。

### 6.4 逾期（只是提示，不是闸门）

| # | 规则 | 依据 |
|---|---|---|
| **SC-27** | `as_of > interviewer.scorecard_due_at` 且该面试官仍在 `missing` → 汇总标 `overdue=true` + `required_human_action='CHASE_SCORECARD'`。**基准是调用方给的 `as_of`（必填），不是墙钟 `now()`**——用 `now()` 会让同一 `(args, 数据快照)` 在不同时刻算出不同结果（`D-16`） | `0001:L980`；`tool-contracts.md` §3.1（`as_of` 必填） |
| **SC-28** | **逾期本身不阻断任何决策**（除 `REJECT`/`FINAL` 的"齐备"要求外），也不自动升级为人工队列项 | **`D-46→D-52`** 的元规则（`D-52` 作废 `D-46` 并重申："设计前先问：这在我们这里会发生吗？发生了是不是本来就该人管？"）：把罕见情况做成闸门，会让 99% 的正常流程承担成本。逾期在真实招聘里是**常态**，不是异常。**引用一律写成 `D-46→D-52`**（理由按 `D-52`，不按已作废的 `D-46`） |

---

## 7. `REJECT` 必须带具体理由（可判定）

### 7.1 形状

```json
{
  "overall": "REJECT",
  "reject_reasons": [
    { "dimension_key": "backend_depth",
      "observation": "问了分库分表的一致性方案，候选人答成'加机器就行'，追问两次仍无法说明分片键选择",
      "why_decisive": "该维度是 Rubric 的 MUST_HAVE，且现场已给出两次澄清机会",
      "evidence": [] }
  ]
}
```

### 7.2 规则

| # | 规则 | 判定 | 依据 |
|---|---|---|---|
| **SC-29** | `overall='REJECT'` ⇒ `reject_reasons[]` **至少 1 条**，且每条 `dimension_key` / `observation` / `why_decisive` **三个字段都非空** | 任一缺失 → `INVALID_ARGS(REJECT_REASON_INCOMPLETE)` | `D11 §9.3`"任何'不符合'的判定必须携带该字段的三态 + 证据坐标"；`INV-9` 同构（决策必须留理由） |
| **SC-30** | 每条 `reject_reasons[].dimension_key` 必须是 `items` 里的一个**维度键**（不是保留键 `transcript_basis`），且 `items[该键].assessment='NOT_MET'` | 对不上 → `INVALID_ARGS(REJECT_REASON_NOT_BACKED)` | 否则会出现"理由说 A 不行，分项里 A 是 MET"的自相矛盾面评 |
| **SC-31** | `reject_reasons[]` 的 `dimension_key` 集合 ⊆ `{assessment='NOT_MET'}` 的维度集合；**出现 `UNREADABLE` / `NOT_OBSERVED` 的维度作为拒绝理由 → `EVIDENCE_INSUFFICIENT(REJECT_BASIS_UNREADABLE)`** | 同上 | `D11 §9.11` 红线 7；这是**本文件与 `DC-24` 共用的那道闸** |
| **SC-32** | `evidence` 允许为空，但为空时该条必须带 `evidence_state='MEMORY_ONLY'`（显式承认"凭现场记忆，没有时间戳证据"） | 缺 `evidence_state` 且 `evidence=[]` → `INVALID_ARGS(REJECT_EVIDENCE_UNDECLARED)` | `D11 §9.9` 要可回溯，但**强制要时间戳会逼人编造**（转写可以缺失，`docs/03 §14`）——显式声明是唯一诚实解 |
| **SC-33** | `overall='ADVANCE'` ⇒ ① 不存在 `NOT_OBSERVED`/`UNREADABLE` 的 item；② **每条 `MET` 至少带 `note` 或 `evidence`**（通过也要能解释） | ① 存在 → `INVALID_ARGS(ADVANCE_WITH_UNASSESSED_DIMENSION)`；② 违反 → `INVALID_ARGS(ADVANCE_WITHOUT_BASIS)` | ①「有一项判不了」却说「建议录用」，与 `DC-24` 的"REJECT 不得用 unreadable"是同一枚硬币的两面；② 零依据的"全部通过"会让决策 `basis_refs` 只剩一个空壳 |

---

## 8. 草稿互相不可见

| # | 规则 | 判定方式 | 依据 |
|---|---|---|---|
| **SC-34** | 任何工具/接口**不得**返回其他面试官 `status='PENDING'` 行的 `items`/`overall`/`rationale` | 实现侧查询必须带 `status <> 'PENDING'`（或显式 `status in ('SUBMITTED','WAIVED')`）；静态扫描 + 一条夹具断言 | `uq_scorecard_current` 允许同人有 `PENDING` 行（`0001:L1322-1323` 不看 status），所以"有没有草稿"库是知道的，只是不许读 |
| **SC-35** | **提交前，作者自己也读不到"别人的草稿"**——不是"看不到分数"，是**连存在性都不暴露** | 汇总里 `missing` 只给 `interviewer_id` + 是否逾期，**不给**"他在写/写到一半" | 一旦暴露"某人在写"，决策人会等，而"等"本身会改变结论方向 |
| **SC-36** | 提交后**内容对全租户可见**（`D-33`：全局可见），但**可见不影响可改**（SC-17/SC-03） | — | `D-33` 的落地口径 3/4 |

> **SC-34/35 不是隐私要求，是产品正确性要求**：互相能看见草稿 → 后交的人会"对齐"前面的人（锚定效应），独立评价失效，汇总就失去意义。`docs/03:L35` 逐字把 Scorecard 定义为"某位面试官**独立**评价"。

---

## 9. 幂等与并发

| # | 规则 | 判定 | 依据 |
|---|---|---|---|
| **SC-37** | 提交必须带 `idempotency_key`（1..128 字符）。同 `key` + 同 `payload_hash` → 返回**同一条** `scorecard_id`，`replayed=true`，**不新增行、不改 `record_version`** | 同 key 不同 payload → `INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)` | `XINV-1`（同一来源事件重复到达不重复建对象）；`uq_business_task_idempotency` 同构 |
| **SC-38** | `payload_hash = sha256(canonical_json(提交内容))`，小写 hex，落 `scorecard.payload_hash` | 不合法 → `INVALID_ARGS(PAYLOAD_NOT_CANONICAL)` | `ck_scorecard_hash` `0001:L1312`；`approval.canonical_payload_hash` 同构 `0001:L423` |
| **SC-39** | 修订必须带 `expected_record_version`（旧行的）；不匹配 → `VERSION_CONFLICT` | 0 行更新即冲突 | `SCHEMA §1` 乐观并发；`D-18`（不缓存旧版本号） |
| **SC-40** | `scorecard.record_version` 由 `fn_row_guard` 自动 +1（`0001:L115-118`，`trg_scorecard_guard_status` 在 9.2 清单里 `0001:L1751`）；**调用方仍必须带 `WHERE record_version = expected`** | 自动 +1 不代表可以不带版本条件 | `SCHEMA §1` |

---

## 10. 配置变更不影响历史面评

| # | 规则 | 依据 |
|---|---|---|
| **SC-41** | `rubric_version` 整行不可 `UPDATE`（白名单为空 `0001:L1779`，`N21`）。改标准 = 新建版本 | `INV-10` |
| **SC-42** | 已提交面评的 `rubric_version_id` **永不改绑**（`fn_scorecard_guard` 把它算进不可改列 `0001:L220-223`） | `INV-10` |
| **SC-43** | 岗位换人（招聘负责人变更）不影响面评有效性；但**新决策必须记录当时的负责人**（`DC-14` 的 `AUTHORITY` basis） | `D-33` 无权限，所以"换了人"只能记录、不能拦截 |

---

## 11. 契约严于库的 7 处（必须知道，别指望数据库拦）

| # | 库只保证 | 契约额外要求 | 拦不住会怎样 |
|---|---|---|---|
| **1** | `items` 列**可空**（`0001:L1285`）；`SUBMITTED` 时非空由 `ck_scorecard_submitted` 强制（`0001:L1314-1315`） | 形状（**对象**）+ 覆盖率 100% + 四态封闭 + `transcript_basis` 保留键（§4.4/§4.5/SC-12/SC-13） | 一份"只填了 1 个维度"的面评照样入库，汇总看起来"齐了" |
| **2** | `overall` 是 `text`，无 CHECK（`0001:L1286`） | 封闭 `ADVANCE·HOLD·REJECT`（§4.6） | 出现 `no hire` / `不通过` / `reject ` 三种写法，统计失真 |
| **3** | `REJECT` 只要 `status='SUBMITTED'`（`0001:L1314-1315`） | `reject_reasons[]` 三步非空 + 必须 `NOT_MET` 支撑（SC-29/30/31） | "不通过"没有理由——`INV-9` 的精神在面评层完全落空 |
| **4** | `scorecard` 无 `round_no`（`0001:L1274-1320`） | 轮次经 `interview` 只读回显（SC-06/07） | 汇总把第 1 轮和第 2 轮的面评混在一起算 |
| **5** | 无 `is_current` 列，current = `superseded_by IS NULL`（`0001:L1322-1323`） | 修订必须写历史链 + `revision_reason`（SC-18/19） | 三步舞做错 → 没有 current 行 → 汇总报"全员未提交" |
| **6** | `status_changed_by_actor_id` / `status_source_event_id` **可空**，且 `fn_row_guard` 只管 `UPDATE`（`0001:L1741-1767`） | 终态行**必须**自带 actor + 内部事件（**SC-44**） | 一行 `INSERT ... status='SUBMITTED'` 落库后：不知道谁交的、事件线上不存在（`XINV-9` 落空） |
| **7** | `fk_scorecard_rubric` 只有两列、不含 `job_id`（`0001:L1302-1303`） | rubric 必须属于该申请的岗位（**SC-47**） | 拿别的岗位的 Rubric 打分，库不报错、汇总也不会发现 |

---

## 12. 库缺口（本文依赖、但迁移里没有）

> 全部 fail-closed：缺口未补时返回明确错误码，**不做"近似实现"**。

| # | 缺口 | 影响 | 临时口径（v1.0 可用） | 需要的变更 |
|---|---|---|---|---|
| **G-1** | `scorecard` **没有** `reject_reasons` / `revision_reason` / `evidence_state` 列 | §7 的理由、§5 的修订原因、SC-32 的声明都只能挤进 `rationale`（自由文本） | 三者都写进 `rationale`，**固定格式**：首行 `修订原因：…`，随后 `reject_reasons` 的 JSON 代码块；汇总解析失败 → `INVALID_ARGS(RATIONALE_NOT_PARSABLE)` | **`0007`** 增 `reject_reasons jsonb` / `revision_reason text` / `evidence_state text`（`0002_seed.sql` **无 DDL**，不要写 `0002`） |
| **G-2** | `scorecard` 无 `idempotency_key` 列 | SC-37 的幂等只能靠"先查再插"（有竞态） | 幂等键落 `event_inbox`（`provider='internal'` + `idempotency_key` 唯一 `XINV-1`），面评行本身不带键 | **`0007`** 增 `scorecard.idempotency_key` + 唯一索引 |
| **G-3** | 修订三步舞**很脆**（§5.2） | 任何一步顺序错都撞约束，且第 3 步漏了会"没有 current 行" | 按 §5.2 写死顺序 + 一条回归测试（改前 `current` 1 行，改后 `current` 1 行且 `revision_no+1`） | **`0007`** 可考虑 `is_current boolean` 或把 `fk_scorecard_superseded_by` 改 `DEFERRABLE INITIALLY DEFERRED`，把三步缩成两步 |
| **G-4** | `interviewer` 表无 `status`，被替换的面试官无法"退出必填集" | 只能把 `required_scorecard` 改 false（一个 DDL 语义的列被当状态用） | 允许改 `required_scorecard`，但必须在 `event_inbox` 留一条人工事件（改的人 + 原因） | **`0007`** 增 `interviewer.status ∈ {ACTIVE, REPLACED, EXCUSED}` |
| **G-5** | `interview` 的 `EVALUATION_READY` 状态**没有工具推进** | 若把它设成决策前置会死锁 | `decision_record` **不以** `interview.status` 为前置（`DC-47`） | 独立命令 `interview_status_advance`（不在本契约） |
| **G-6** | **终态行不要求 actor**：`INSERT ... status='SUBMITTED'` 不触发 `fn_row_guard`（BEFORE UPDATE），三列审计列全可空（`0001:L1290-1292`） | SC-44 只能靠写侧纪律；漏写时库一声不吭，事件线上没有这条面评 | 写侧强制（SC-44）+ 一条回归断言（`SUBMITTED` 行 `status_changed_by_actor_id is not null` 且 `status_source_event_id` 指向存在的 `event_inbox` 行） | **`0007`** 库层拦截（`ck_scorecard_terminal_actor`：`status='PENDING' or status_changed_by_actor_id is not null`）——`D-75` 第 5 条 |

---

## 13. 本文档范围内，系统**绝不**做什么

| # | 绝不 | 机检方式 |
|---|---|---|
| **N-1** | **绝不代填**：任何以他人身份写面评的路径都不存在 | 入参 schema 里没有 `interviewer_id`/`actor_id`/`tenant_id`（`additionalProperties:false`，SC-01） |
| **N-2** | **绝不把缺失面评当 0 分 / 当平均分的分母 / 当反对票** | `denominator + excluded == required_total` ∧ `tally` 总和 == `done`（SC-22/23/24）；**统计空间只含 `required_interviewers`**（SC-46） |
| **N-3** | **绝不用 `UNREADABLE` / `NOT_OBSERVED` 作为 `REJECT` 的依据** | `reject_reasons[].dimension_key` 全部映射到 `assessment='NOT_MET'`（SC-31） |
| **N-4** | **绝不修改已提交的面评**（只允许新增修订 + 旧行指针） | `SCORECARD_IMMUTABLE` 触发器 + 修订测试（SC-17） |
| **N-5** | **绝不读草稿**，也绝不暴露"有人正在写" | 查询条件 `status in ('SUBMITTED','WAIVED')`（SC-34/35） |
| **N-6** | **绝不让面评内容变成决策**：面评只有 `overall`（列名就是 `overall`，**不是** `recommendation`），没有 `decision` 的任何一个必填字段 | 工具输出无 `decided_by_actor_id` / `decided_at`（`decision-rules.md` §1-1 / N-1） |
| **N-7** | **绝不用"岗位当前 Rubric"替换"申请钉住的 Rubric"**，也绝不用**别的岗位**的 Rubric | `rubric_version_id == application.rubric_version_id`（SC-09/10/11）∧ `rubric_version.job_id == application.job_id`（SC-47） |
| **N-8** | **绝不输出恒真的权限字段**（`can_submit`/`can_decide` 之类） | 输出 schema 里 grep `can_` 得 0（`D-33`） |
| **N-9** | **绝不让 `items` 退化成数组**（`items[].dimension_key` 这种形态已作废） | 写侧 schema：`items` 必须是 object 且 `additionalProperties:false`；出现数组 → `INVALID_ARGS(TYPE_MISMATCH)`（`D-74`） |
| **N-10** | **绝不写终态行不带 actor**（不留"匿名提交"） | `status in ('SUBMITTED','WAIVED')` 的行 `status_changed_by_actor_id is not null` ∧ `status_source_event_id` 指向存在的 `event_inbox` 行（SC-44 / G-6） |

---

## 14. 依据索引

| 代号 | 位置 | 本文用它裁定了什么 |
|---|---|---|
| `INV-7` | `db/SCHEMA.md:178` | 面评必须记录评价者与标准版本（SC-02/SC-09） |
| `INV-9` / `INV-10` | `db/SCHEMA.md:180-181` | 理由必填、配置不改历史（SC-17/SC-41/42） |
| `XINV-1` / `XINV-8` | `db/SCHEMA.md:189`、`:196` | 幂等（SC-37）；转写与面评并行互不阻塞（§1-7） |
| `APP-05` | `db/SCHEMA.md:210` | "必需 Scorecard 全交或 Waive"（SC-25） |
| `APP-07` | `db/SCHEMA.md:212` | Agent 不得写面评内容（SC-03、SC-26） |
| `0001:L1274-1323` | `scorecard` 建表 + 两个唯一约束 | §2 全表、§5 顺序、§6.1 口径 |
| `0001:L213-230` + `:1811-1813` | `fn_scorecard_guard` + 触发器 | SC-17/18/42 |
| `0001:L973-990` | `interviewer` | SC-21/27（`required_scorecard` / `scorecard_due_at`） |
| `0001:L930-971` | `interview` | SC-06/07/08（轮次由 interview 决定） |
| `0001:L839` | `application.rubric_version_id` | SC-09/10/11。**注意**：同处的 `fk_application_rubric`（`0001:L866-867`）**已被 `0005_version_binding.sql` §3 DROP**，现行为 `fk_application_rubric_job`（3 列，含 `tenant_id` + `job_id`，`D-53`）；`0001` 的行号只说明"建表时是什么" |
| `0001:L588-611` + `:1779` | `rubric_version` 及其不可变 | SC-12/41 |
| `0001:L1302-1303` | `fk_scorecard_rubric` 两列、**不含 `job_id`** | SC-47（rubric 必须属于该申请岗位；`0007` 补约束） |
| `0001:L1290-1292` + `:1741-1767` | 三列审计列可空 + `fn_row_guard` 只挂 `before update` | SC-44/45、G-6 |
| `0001:L1647-1648` | `ck_execution_mandate_no_business_approval` | SC-03/26（Agent 不能豁免面评） |
| `0001:L1721-1732` | 禁删清单（含 `scorecard`） | SC-18 |
| `0001:L1751` | `scorecard` 在 9.2 状态护栏清单里 | SC-40 |
| `verify.sql:606` | `N10`（SUBMITTED 缺时间/分项） | §1-2 |
| `verify.sql:610` | `N11`（已交被改写） | §1-3 |
| `D11 §9.2 / §9.3 / §9.9 / §9.11` | `work/handoff/11-pdf-acceptance-criteria.md` §9（**老仓，新仓未收录**；不写行号） | 三态、拒绝可解释、可回溯、红线 |
| `docs/03 §14` | `docs/03-domain-and-runtime.md:214` | 面评不被转写失败阻塞、不得伪造完成（§1-7、SC-32） |
| `docs/03:L35` | 同上 | Scorecard = "某位面试官独立评价"（§8 的独立性依据） |
| `D-18` | `docs/17-decision-ledger.md`（D-18） | `SET LOCAL` actor、不缓存版本号（SC-01、SC-39） |
| `D-21` | 同上（D-21） | 当前 Rubric 版本是显式指针，不用 `max(version_no)`（SC-10） |
| `D-22` | 同上（D-22） | 阶段码唯一口径 S1–S12（§0 编号说明） |
| `D-31` / `D-32` | 同上（D-31、D-32） | "每块恰好归一次"、不得放宽校验迁就输入（SC-13、SC-20） |
| `D-33` | 同上（D-33） | 无 RBAC、角色只做标签、不预留假接口（SC-05、§3.2、N-8） |
| `D-46→D-52` | 同上（**D-52 作废 D-46**） | "不要为罕见情况设闸门"的元规则**按 D-52 引用**（SC-28） |
| `D-53` | 同上（D-53） | `fk_application_rubric_job` 是 3 列（含 `tenant_id`）——`0005` 的落地形态 |
| `D-54` / `D-75` | 同上（D-54、D-75） | scorecard 的 rubric 绑定缺口归 `0007`；终态行 actor 拦截归 `0007` |
| `D-74` | 同上（D-74） | `items` 是对象、证据 kind 用 `SEGMENT`（SC-12、§4.4） |
| `TR-E2` / `TR-E3` / `TR-E7` | `contracts/interview/transcript-rules.md` §9（兄弟契约，**冲突时以它为准**） | `transcript_basis` 保留键、`SEGMENT` kind、决策依据必须带 `transcript_basis`/`transcript_state` |

---

## 15. 需要拍板的口径（我不代决）

| # | 问题 | 我按什么执行 | 需要谁 |
|---|---|---|---|
| **Q-1** | 是否允许"逾期 N 天自动催办 → 自动豁免" | **不允许**（SC-28 只提示不升级） | 产品负责人（涉及流程制度） |
| **Q-2** | `score`（1–5 分）在 v1.0 是否进入任何决策依据 | **不进入**：只做展示，决策只看 `assessment`（§4.4） | 产品负责人（若要做"分数门槛"需先冻结换算规则） |
| **Q-3** | 被替换的面试官（G-4）能否改 `required_scorecard` | 可以，但必须留人工事件 | 总控（`0007` 是否本轮做；`0002_seed.sql` **无 DDL**，加列只能进 `0007`） |
| **Q-4** | `ADVANCE(FINAL)` / `REJECT` 缺面评时，`acknowledged_missing` 能否放行 | **不放行**：本契约把 `acknowledged_missing` 的适用范围**只**给 `ADVANCE(STAGE)`（`decision-rules.md §4.2`），`ADVANCE(FINAL)`/`REJECT` 只要有必交面试官缺面评就 `SCORECARD_MISSING`。理由：放行等于把"错误淘汰/终局缺面板"变成可确认的旁路，与 §7 四道防线和 `D11 §9.11` 红线 7 冲突（**更严的一侧优先**） | 总控（若确实要放行 `FINAL`，需一条明确裁定 + 把 §7 防线一起改） |
