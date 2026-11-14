# decision-rules.md · 汇总与决策（S10 下半）领域规则

**版本**：`decision 1.1.0`（与 `scorecard 1.1.0` / `evaluation-tool-contracts 2.0.0` 同一基线）
**日期**：2026-11-13
**范围**：**从一堆面评走到一条 `decision`** 的全部判定规则——何时能进决策、谁能决、依据怎么留、错了怎么改、下一轮给什么。**不含实现**
**上位**：老仓 `work/handoff/15-architecture-hv.md`（新仓未收录；阶段码口径已由 D-22 与 `db/stage_catalog` 取代，见 `contracts/STAGE-CODES.md`）（S10 = 面评 → 汇总 → 决策）、`work/handoff/11-pdf-acceptance-criteria.md` §9（**老仓，新仓未收录**；三态 / 拒绝可解释 / 可回溯）。**两者都不是本仓可查的依据**
**落库依据**：`db/SCHEMA.md`（`INV-9` 决策保留责任人/时间/结果/理由）、`db/migrations/0001_init.sql`（行号即该文件行号）、`0005_version_binding.sql`、`0006_integrity_gaps.sql`。`0002_seed.sql` **无 DDL**；本文提到的所有"待补"DDL 一律指向 **`0007`**（`D-75`）
**配套**：`scorecard-rules.md`（面评本身算不算数）、`tool-contracts.md`（工具形状）

> **本文件的唯一职责**：回答「这次能不能决定」「决定留下什么」「决定错了怎么办」。
> 它**不**回答「该不该录用这个人」——**那是人的判断，本系统没有这个能力，也不假装有。**

---

## 1. 九条不可协商的结论（先读这九行）

| # | 结论 | 依据 |
|---|---|---|
| **1** | **决策必须由人做出。系统只汇总、只记录、只校验，不代决、不建议结论。** 汇总里没有任何"系统推荐结果"字段 | `APP-07`；`ck_execution_mandate_no_business_approval` 明禁 `decide` `0001:L1647-1648`；`work/handoff/15-architecture-hv.md` 的 S10 定义（**老仓，新仓未收录**） |
| **2** | **缺面评不得当 0 分、不得进平均、不得当反对票。** 缺就是缺 | `scorecard-rules.md` §6；`D11 §9.2` |
| **3** | **`unreadable` 不得作为拒绝依据**——由读取/收听失败导致的"不符合"，只能进人工 | `D11 §9.2` / `§9.11` 红线 7；本文件 `DC-24`/`DC-25` |
| **4** | **决策记录必须可回溯**：引用了哪些面评、哪些维度、哪些证据坐标，都要能在 `basis_refs` 里指出来，且能被 digest 钉住 | `D11 §9.9`；`INV-9`；本文件 `DC-12`/`DC-16`/`DC-20` |
| **5** | **决策记录必须包含**结论、理由、决策人、时间、绑定的 Rubric 版本——**其中 Rubric 版本表里没有列，只能落 `basis_refs`** | `decision` 列清单 `0001:L1325-1361`（无 `rubric_version_id`）；`INV-9`；`DC-17` |
| **6** | **决策整行不可改**：修正只能新增一行 + 旧行 `superseded_by_decision_id` 指向新行；撤回链**单向**，不许改回 `NULL` | `fn_guard_columns` 白名单只允许改 `superseded_by_decision_id` `0001:L1785`；`ck_decision_self_supersede` `0001:L1359-1360` |
| **7** | **v1.0 无权限矩阵**（`D-33`）：决策人不是招聘负责人**也允许决**，但必须**记录**这个事实，不得静默 | `D-33`；本文件 `DC-14` |
| **8** | **决策不写回申请/面试的历史状态**：`application.lifecycle_status` / `interview.status` 一个都不改 | `SCHEMA §7` ④ 逐字"结论不写回 application 历史状态"；`docs/03:L88` |
| **9** | **没有"系统自己的决策"**：不存在 `actor.kind='SYSTEM'` 的录用/淘汰决策（自动合并可以记 `SYSTEM`，决策不行） | `D-41`（自动合并记 SYSTEM）反向适用；`APP-07` |

---

## 2. `decision` 对象（逐列对齐 `0001:L1325-1361`）

### 2.1 关系与"当前决策"的口径

```
application ──n decision(decision_scope ∈ {SCREENING, STAGE, FINAL})
                   │  current := superseded_by_decision_id is null
                   ├─0..1 interview_id   （STAGE 必填 / FINAL 必须为空）
                   ├─0..1 approval_id    （绑定审批，v1.0 不要求）
                   └──n decision         （撤回链：旧 → 新）
```

### 2.2 列清单与本文档怎么用

| 列 | 约束 | 本规则怎么用 | 依据 |
|---|---|---|---|
| `application_id` | `NOT NULL` + 复合外键 | 决策对象是**申请**，不是人也不是岗位 | `0001:L1328`、`L1343-1344` |
| `interview_id` | 可空 + 复合外键 | `STAGE` 必填、`FINAL` 必须为空（`DC-06`） | `0001:L1329`、`L1345-1346` |
| `decision_scope` | `SCREENING`/`STAGE`/`FINAL` | 本文只管 `STAGE`/`FINAL`；`SCREENING` 归 S7 写侧 | `ck_decision_scope` `0001:L1353` |
| `stage_code` | 可空，正则 `^[A-Z][A-Z0-9_]{1,40}$` | **S10 工具自己写死 `'S10'`**，不接受调用方传（否则能写进 `'INTERVIEW'` 这类目录外脏值——该列**没有外键**） | `ck_decision_stage_code` `0001:L1355`；`D-22` |
| `result` | `ADVANCE`/`HOLD`/`REJECT`/`WITHDRAW`/`HIRED` | `HIRED` 在 v1.0 **禁用**（`S11` 缓做）；其余按 §4.2 矩阵 | `ck_decision_result` `0001:L1354`；`SCHEMA §5`（Offer 缓做） |
| `decided_by_actor_id` | `NOT NULL` + 外键 | **只能**来自执行上下文，且必须 `actor.kind='HUMAN'` | `0001:L1333`、`L1347-1348`；`DC-10` |
| `decided_at` | `NOT NULL`，默认 `now()` | **服务端时钟**，不接受入参 | `0001:L1334`；`DC-48` |
| `reason` | `NOT NULL` + `btrim > 0`（`ck_decision_reason`） | 人话理由；`REJECT` 时**必须**引到具体维度（`DC-18`） | `0001:L1335`、`L1357`；`INV-9`；`N12` |
| `basis_refs` | `jsonb NOT NULL default '[]'`，`ck_decision_basis` **只校验"是数组"** | 可回溯的唯一载体；**空数组库是允许的**，契约必须拦住（`DC-12`） | `0001:L1336`、`L1358` |
| `approval_id` | 可空 + 外键 | v1.0 不要求；给了就必须校验（`DC-19`） | `0001:L1337`、`L1349-1350` |
| `superseded_by_decision_id` | 自引用 + 不得等于自身 | 撤回链；**唯一可 UPDATE 的列** | `0001:L1338`、`L1359-1360`、`L1785` |
| `record_version` | `default 1` | **`decision` 没有 `fn_row_guard`**，所以版本**不会自动 +1**（`DC-39`） | 9.2 清单 `0001:L1742-1760` 不含 `decision` |
| —（无列） | — | `rubric_version_id`、`summary_digest`、`missing_ack` **都没有列** → 全进 `basis_refs` | `0001:L1325-1361` |

### 2.3 `decision` 表**没有**的四样东西（实现者最容易假设它有的）

| 没有 | 后果 | 契约怎么补 |
|---|---|---|
| **`rubric_version_id` 列** | "决策绑定哪版标准"库里查不到 | 必须落 `basis_refs[]` 的 `RUBRIC_VERSION` 项（`DC-17`） |
| **`status` 列 / `status_changed_*`** | ① 决策**不会**自动写 `event_inbox`（`fn_row_guard` 不在本表）② 没有"生效/失效"状态，只有 `superseded_by` 指针 | 写侧必须在**同一事务**补一条内部事件（`DC-38`） |
| **`idempotency_key` 列** | **v1.0 不做客户端幂等**（`D-80`）：表里没有可落键的列，加列要迁移，而"重试同一请求"在工具调用里没有语义 | **取消这个承诺**。重复与并发只靠 `(tenant_id, application_id, decision_scope, stage_code)` 的 current 唯一性（`0007` 的部分唯一索引）→ 冲突 **23505** → `ALREADY_DECIDED` |
| **任何唯一约束（现状）** | `0001` 的 `decision` 确实**没有任何** unique 约束（只有 PK + 5 条 FK + `ix_decision_application`） | 现状：写侧先查 current（`superseded_by_decision_id is null`）+ 写后复核；`0007` 落地后：库层 23505 → `ALREADY_DECIDED`（`D-75` 第 2 条、`D-80`） |

> 上面第 3、4 条是本文档最危险的两条事实：`decision` 表**没有** `idempotency_key` 列，也**没有** `unique (tenant_id, application_id, decision_scope, stage_code) where superseded_by_decision_id is null` 这样的部分唯一索引。**但"看起来约束很全"的表加一条停车标志，不是 v1.0 的做法**——`0007` 才是落点（`D-75`）。
>
> **不许再用 `SELECT … FOR UPDATE` 当防线**（`D-80`）：它锁不到**不存在的**行，两条并发插入都能通过"查无 current"这一关。任何"靠 `FOR UPDATE` 防双插"的写法在本文档里都是**违规**。

---

## 3. 汇总（Evaluation Summary）：它是什么、不是什么

### 3.1 本质

**汇总是一个投影（projection），不是事实库。** 同一 `(args, 数据快照)` 必须能复算出**逐字节相同**的结果；没有表、没有 id（除了 digest）。

| 性质 | 要求 | 依据 |
|---|---|---|
| 只读 | 不改面评、不改任务、不建决策、不写 `event_inbox` | `SCHEMA §6` 逐字"只做投影，不建事实库" |
| 无时钟 | 输出**不含** `generated_at` / `now`；唯一时间输入是 **`as_of`（必填，不是可选）**，且原样回显。**不设"缺省取 now()"**：那会让同一输入在不同时刻算出不同 `overdue`/`digest`（违反 `D-16`） | 同 `screening-rules.md §11 D-1`；`D-16` |
| 确定 | 同一输入 → 同一 `summary_digest` | `D-16`："Evaluation Summary 派生不落表，要求同一输入可复算出同一结果" |
| 不产决策 | 输出里**没有** `result` / `decided_by_actor_id` / `decided_at` 这三个字段中的任何一个 | `APP-07`；`DC-01` |

### 3.2 输出形状（`tool-contracts.md` §3 是权威，这里只列语义）

```json
{
  "advisory": true, "read_only": true,
  "as_of": "2026-11-13T01:00:00+08:00",
  "decision_scope": "STAGE", "stage_code": "S10",
  "rubric":       { "version_id": "…", "version_no": 2, "payload_hash": "…", "source": "APPLICATION_PINNED" },
  "coverage":     { "required_total": 3, "submitted": 2, "waived": 0, "missing": 1,
                    "unusable": 0, "not_required": 0,
                    "overdue": 1, "completion_ratio": 0.6667 },
  "missing":      [ { "interviewer_id": "…", "actor_id": "…", "round_no": 1,
                      "slot_code": "DEFAULT", "scorecard_due_at": "…", "overdue": true } ],
  "tally":        { "advance": 2, "hold": 0, "reject": 0, "waived": 0 },
  "consensus":    "UNANIMOUS_ADVANCE",
  "consensus_scope": "PARTIAL_PANEL",
  "minority_reports": [],
  "aggregation":  { "method": "PER_DIMENSION_SUBMITTED_ONLY",
                    "average": null,
                    "average_refused_reason": "MISSING_SCORES",
                    "per_dimension": [ { "dimension_key": "backend_depth", "mean": 4.0,
                                         "denominator": 2, "excluded": 1, "values": [4, 4] } ] },
  "record":       { "state": "NOT_READY", "interview_record_id": "…", "verification_status": "UNVERIFIED" },
  "ready_for_decision": false,
  "blockers":     [ { "code": "SCORECARD_MISSING", "family": "COVERAGE",
                      "blocks_results": ["REJECT", "HIRED"], "detail": { "missing_count": 1 } } ],
  "permitted_results": ["ADVANCE", "HOLD", "WITHDRAW"],
  "warnings":     [ { "code": "PARTIAL_PANEL", "message": "3 人面板只交了 2 份，标签仍是 PARTIAL" } ],
  "required_human_action": "CHASE_SCORECARD",
  "snapshot":     { "application_record_version": 7, "rubric_version_id": "…",
                    "rubric_payload_hash": "…", "scorecard_ids": ["…", "…"] },
  "summary_digest": "9c1e…",
  "brief": null
}
```

**四个计数的口径（`SC-21/22/23/24/46` + `tool-contracts.md §3.4`）**：

| 字段 | 口径 |
|---|---|
| `coverage.submitted` | `required_interviewers` 里**可用**的 current `SUBMITTED` 面评数（形状校验通过的） |
| `coverage.waived` | `required_interviewers` 里 current `WAIVED` 的行数 |
| `coverage.missing` | `required_total - submitted - waived`（**含 `unusable`**：交了但这张不能用，理由不是"没交"） |
| `coverage.unusable` | `missing` 的**子集**：有 current `SUBMITTED` 但形状不合法的人数（`⊆ missing`，`submitted + waived + missing == required_total` 仍成立） |
| `coverage.not_required` | `required_scorecard=false` 的面试官（含 observer）交的可用面评数。**不进分母、不进 `tally`**（`SC-46`），只做透明计数 |

### 3.3 `consensus` 的封闭词汇（**只描述，不决定**）

```
tally 记 a=h.advance, h=h.hold, r=h.reject, w=h.waived, n = a+h+r

consensus :=
  NO_SUBMISSIONS      if n = 0                       -- 全缺或全豁免
  UNANIMOUS_ADVANCE   if n > 0 ∧ r = 0 ∧ h = 0
  UNANIMOUS_REJECT    if n > 0 ∧ a = 0 ∧ h = 0
  MAJORITY_ADVANCE    if a > r + h
  MAJORITY_REJECT     if r > a + h
  SPLIT               otherwise                       -- 含平票

consensus_scope := FULL_PANEL    if missing = 0
                   PARTIAL_PANEL otherwise
```

| # | 规则 | 依据 |
|---|---|---|
| **DC-01** | `consensus` **只是对已交面评的描述**，不是建议、不是结论、不得被写入 `decision.result`（写侧不许做 `result := consensus` 的映射） | `APP-07`；本文件 §1-1 |
| **DC-02** | `tally` 四项之和必须等于 `coverage.submitted + coverage.waived`（`w` 单列，故 `a+h+r = submitted`）。**不等的实现即违约**。**断言范围的正确读法**：`coverage.submitted` 是**形状校验通过**的那部分面评数（§3.2 表），**不是** `select count(*) where status='SUBMITTED'` 的行数——机检时若直接对库计数，必须先把 `unusable` 剔除，否则形状不合法的行会让 M-2 假红（`tool-contracts.md §3.4`/§7.0） | 断言 M-2 |
| **DC-03** | `minority_reports[]` 必须**原文**带出少数派面评的 `reject_reasons[]` / `note`，不得摘要、不得合并、不得只留条数 | `D11 §9.9`；少数派意见是决策人最需要看到的东西，摘要即丢失 |
| **DC-04** | 存在缺失时 `consensus_scope='PARTIAL_PANEL'`，且 `aggregation.average` **必须为 `null`**、`average_refused_reason='MISSING_SCORES'`。**对称的另一半**（否则断言在 `submitted=0` 时失真）：`missing=0 ∧ submitted=0`（全豁免）时 `average` **同样**为 `null`，但 `average_refused_reason='NO_SUBMITTED_SCORECARD'`、`method='NOT_COMPUTED'` | `scorecard-rules.md` SC-24；断言 M-1（`⟺` 的完整形态） |

**`warnings[]` 封闭集（汇总）**——只提示、不改门禁，但**必须出现**：

| `code` | 何时 |
|---|---|
| `PARTIAL_PANEL` | `missing > 0`（面板不完整，但票数照报） |
| `MINORITY_DISSENT` | `minority_reports[]` 非空 |
| `SCORECARD_WAIVED` | `waived > 0`（豁免不等于有分，原 `waive_reason` 必须回显） |
| `SCORECARD_SHAPE_INVALID` | 有面评形状不合法被剔除出 tally（`tool-contracts.md §3.4`） |
| `SCORECARD_RUBRIC_MISMATCH` | **SC-11**：有面评绑的 `rubric_version_id` ≠ 申请钉住的版本，被剔除出 tally/aggregation/snapshot（`detail.application_rubric_version_id` + 每条 `{scorecard_id, interviewer_id, status, rubric_version_id}`）。**不许静默跳过**：调用方必须看得见"哪几条、两边版本" |
| `RECORD_NOT_READY` | `record.state='NOT_READY'`（转写/记录没就绪，**不阻塞**决策，见 `DC-23`） |
| `HIRING_MANAGER_UNSET` | 该部门的 `hiring_manager_actor_id` 为空（`DC-15`） |
| `FIXTURE_BASIS` | `provenance='FIXTURE'`（§1.3） |

---

## 4. 什么时候可以进入决策

### 4.1 三段式：可汇总 / 可决策 / 可落库

| 阶段 | 条件 | 谁做 |
|---|---|---|
| **可汇总** | `application` 存在且至少 1 个 `interview`；`rubric` 可解析 | `summarize`（永远允许，缺面评也允许——**汇总的职责就是报告缺**） |
| **可决策**（人能拍板） | 达到 §4.2 的门槛矩阵。**未达门槛时人仍然可以决定"暂不决定"（`HOLD`）** | 人（在界面里） |
| **可落库**（工具接受） | §4.3 的判定顺序全过 | `decision_record` |

> **"可汇总"永不因缺面评而报错**：这一点与 `recruitment_job_get` "不因缺 Rubric 报错"同构（`job-screening/tool-contracts.md §2.4`）。一个描述世界的工具，把"缺"变成错误，会让"查一下缺什么"这件正事没法做。

### 4.2 门槛矩阵（**本文件的核心裁决**）

| `result` | 面评齐备（`missing=∅`） | 面评缺失 | 额外要求 | 依据 |
|---|---|---|---|---|
| **`WITHDRAW`** | ✅ | **✅ 免确认** | 无。**面试官没交卡不能阻止候选人自己退出**；也**不得**因为 `submitted=0` 或"没有 SCORECARD basis"而阻断（`basis_refs` 只需 ≥1 条 `SUMMARY` + `RUBRIC_VERSION` + `AUTHORITY`，`DC-12`） | 候选人撤回是候选人的事实，与内部评价无关；零面评的撤回不得被"至少 1 条 SCORECARD basis"卡住 |
| **`HOLD`** | ✅ | **✅ 免确认** | 无。`HOLD` 是安全方向（"暂不决定"）；同样**不得**因零面评而阻断 | `ck_decision_result` 无"待确认"值，`HOLD` 是它的唯一合法表达 |
| **`ADVANCE`**（`STAGE`） | ✅ | ✅ **需显式带缺失确认** | ① `submitted_count ≥ 1`（零提交 → `EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)`）；② `missing_disposition='PROCEED_WITH_MISSING'` + `acknowledged_missing[]` 与 `missing[]` **集合完全相等** + 每条带 `why_proceed` 非空 | 中间轮次推进不能因为一个人不交卡就全组停摆；但没有人写过任何评价的"推进"不是推进，是空转 |
| **`ADVANCE`**（`FINAL`） | ✅ | **❌ `SCORECARD_MISSING`** | ① `submitted_count ≥ 1`；② `tally.reject > 0` 时需 `acknowledged_dissent=true` + `override_rationale` 非空；③ **`acknowledged_missing` 不放行本行**（见下方 §4.2.1） | 终局结论影响最大，不接受残缺面板 |
| **`REJECT`** | ✅ | **❌ `SCORECARD_MISSING`** | ① `submitted_count ≥ 1`；② **≥1 份 `SUBMITTED` 面评 `overall='REJECT'`**，其 `reject_reasons[]` 全部由 `NOT_MET` 支撑（`DC-27`）；③ `tally` 与 `consensus` 相反时需 dissent 确认（`DC-28`） | `D11 §9.11` 红线 7 的正面防线 |
| **`HIRED`** | — | — | **v1.0 一律 `INVALID_ARGS(RESULT_NOT_IN_V1_SCOPE)`** | `work/handoff/15-architecture-hv.md` §5（**老仓，新仓未收录**）：S11 Offer/入职 = 不做；建一条无下游的 `HIRED` 只会污染指标 |

> **本节的两条新口径（2026-11-13 总控裁定的 B6 / B7，条文已写全，引用以本节为准）**：
> ① **不对称成立且写清两边**——缺面评**不**阻断 `WITHDRAW`/`HOLD`；缺任何一名必交面试官的面评**阻断** `ADVANCE(FINAL)`/`REJECT`，"逐条确认"只对 `ADVANCE(STAGE)` 有效。
> ② **零提交一律不放行 `ADVANCE`**（`submitted_count = 0` → `EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)`，全豁免也算），同时**不得**用"至少 1 条 `SCORECARD` basis"去卡零面评的 `WITHDRAW`/`HOLD`。
> `"B6/B7"` 是**本轮裁定批次的编号**，不是项目 `D-` 编号；`docs/17-decision-ledger.md` 尚未收录它们，所以条文在这里写全，不留给读者去别处查。

**三条必须记住的不对称：**

1. **`WITHDRAW` / `HOLD` 不受面评门槛约束**——把"暂不决定"和"候选人自己撤了"卡在面评上，是最常见的自锁（候选人已入职别家，系统却不让他撤回）。**两种情形都不因缺面评而阻断，也不因"零面评"而阻断**。
2. **`REJECT` 比 `ADVANCE` 严**：`ADVANCE` 缺人可推进（`STAGE` 带逐条确认），`REJECT` 缺一个人都不行。**方向是不对称的，这是故意的**——错误淘汰的代价远大于多面试一轮的代价。
3. **"齐备"只算 `SUBMITTED ∪ WAIVED`**，`PENDING` 与无行等价（`scorecard-rules.md` §6.2）；形状不合法的 `SUBMITTED` 也只算 `missing`（`coverage.unusable`，`tool-contracts.md §3.4`）。

### 4.2.1 两种情形的准确边界（**别再靠"恒允许 / 全阻断"这种一句话记忆**）

| 情形 | 结论 | 为什么 |
|---|---|---|
| 缺面评（`missing ≠ ∅`） + `WITHDRAW` / `HOLD` | **放行**，不需要任何确认，不需要 `acknowledged_missing` | 候选人退出 / 人选择"暂不决定"都是**安全方向**；拿面评卡住它们只会制造自锁 |
| 缺任何一名**必交**面试官（`required_scorecard=true`）的面评 + `ADVANCE(FINAL)` / `REJECT` | **阻断**，`SCORECARD_MISSING`。**`acknowledged_missing` 不放行**（它只对 `ADVANCE(STAGE)` 有效） | 终局与淘汰是不可逆方向；"逐条确认缺谁"在这里等于把错误结论合法化（取更严的一侧；`Q-5` 已登记） |
| `submitted_count = 0`（零提交，含全豁免） + `ADVANCE`（任何 scope） | **阻断**，`EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)` | 没有任何人写过任何一条评价时，"推进"没有任何依据；全豁免 ≠ 有依据 |

### 4.3 `decision_record` 的判定顺序（**顺序本身是规则**）

```
STEP 0  参数层校验（未知键 / 类型 / 枚举 / 互斥 / UUID / as_of 必填）  → INVALID_ARGS
STEP 1  身份：作者取自上下文；人工确认四要素齐全                  → DECISION_REQUIRES_HUMAN
STEP 2  目标存在：application / interview / rubric / 面评引用      → NOT_FOUND
STEP 3  已存在当前同类决策？                                      → ALREADY_DECIDED
        （带了 supersedes 则跳过本步，走 §8 撤回流程）
STEP 4  重算汇总，比对入参 summary_digest                          → INVALID_ARGS(SUMMARY_STALE)
STEP 5  未处理的人工队列项 / 未澄清的 unreadable                   → BLOCKED_BY_REVIEW
STEP 6  结果门禁（§4.2 矩阵 + §7 四道防线）                        → SCORECARD_MISSING
                                                                   / EVIDENCE_INSUFFICIENT
                                                                   （含 NO_SUBMITTED_SCORECARD）
STEP 7  写入（decision 行 + 旧行指针 + 内部事件），带版本条件        → VERSION_CONFLICT
                                                                   （0007 之后并发重复 → 23505 → ALREADY_DECIDED）
```

| # | 规则 | 依据 |
|---|---|---|
| **DC-05** | 上述顺序**必须**照做：先判"该不该决"再判"决得对不对"。反过来的实现（先算门禁再查身份）会把"Agent 试图代决"报成"面评缺失"，掩盖真正的违规 | 与 `screening-rules.md §5 STEP 0` 同构 |
| **DC-06** | `decision_scope='STAGE'` ⇒ `interview_id` 必填，否则 `INVALID_ARGS(STAGE_REQUIRES_INTERVIEW)`；`='FINAL'` ⇒ `interview_id` 必须为空，否则 `INVALID_ARGS(FINAL_SCOPE_NO_INTERVIEW)`；其它值 ⇒ `INVALID_ARGS(DECISION_SCOPE_NOT_S10)` | 禁止"自动取最后一轮"——那是 `D11 §9.8`"不得静默择一"的同构错误 |
| **DC-07** | `stage_code` **不由调用方提供**，工具写 `'S10'`；调用方传了非 `'S10'` 的值 → `INVALID_ARGS(STAGE_CODE_NOT_S10)` | `0001:L1355` 只有正则无外键；`D-22` 唯一口径；`D-24` 同构（脏 code 是静默错误） |

> **2026-11-14 增补（P0-3）**：上面两条只覆盖 **S10**（`STAGE`/`FINAL`）。
> `decision_scope='SCREENING'`（S7 的人决定）此前**没有写侧**：`decision_record` 明确拒收它，
> 而 `0008` 之后的 `decision` 实况是 `STAGE=1 / SCREENING=0`。现在 `decision_record` **接受** `SCREENING`，
> 写死 `stage_code='S7'`、不需要 `interview_id`/`summary_digest`、不走 §4.2 的面评门禁。
> 完整口径见 **§17.1**（本节只作指引；与 §17.1 冲突时以 §17.1 为准）。

### 4.4 两个"不作为前置"的裁决（否则必然死锁）

| # | 规则 | 为什么 | 依据 |
|---|---|---|---|
| **DC-47** | **不以 `interview.status` 为决策前置，决策也不改任何状态。** 门禁只看**事实**（面评是否齐备、record 是否就绪、有无未澄清的 `unreadable`、有无未处理的人工任务） | ① `interview.status='EVALUATION_READY'` **没有任何工具推进**（`G-5`），拿它当前置就是死锁；② 即使推进了，状态也是**影子**——真值是 `decision` 行；③ `SCHEMA §7` ④ 逐字"结论不写回 application 历史状态" | `ck_interview_status` `0001:L959-961`；`SCHEMA §7` ④；`docs/03:L88` |
| **DC-48** | `decided_at` **由服务端取时钟**，不接受入参；输出原样回显 | 可由调用方给定 = 可伪造"当天就决定了"。`0001:L1334` 只是一列时间，库不校验来源 | `0001:L1334`；与 SC-14 同一理由 |

> **DC-47 的连带效果（必须知道）**：工具落完决策后 `interview.status` 仍是 `POST_INTERVIEW`。这是**故意的**——把"决策"和"状态推进"拆成两个命令，任一失败都不会让另一方半成功。界面显示"已决策"应以 `decision` 的 current 行为准，不以 `interview.status` 为准。

---

## 5. 决策必须由人做出

### 5.1 人工确认的"三要素"

```json
"human_confirmation": {
  "confirmed_by_actor_id": "<uuid>",      // 必须 = 执行上下文 actor，且 actor.kind='HUMAN'
  "confirmed_at": "2026-11-13T01:20:00+08:00",
  "confirmation_method": "IN_APP_CONFIRM", // 封闭：IN_APP_CONFIRM | SIGNED_RECORD
  "confirmation_text_sha256": "<64 hex>"   // 人实际确认的那段文字/表单内容的 sha256
}
```

| # | 规则 | 判定 | 依据 |
|---|---|---|---|
| **DC-08** | 三要素缺一 → `DECISION_REQUIRES_HUMAN(NO_HUMAN_CONFIRMATION)` | — | `APP-07` |
| **DC-09** | `confirmed_by_actor_id` ≠ 上下文 actor → `DECISION_REQUIRES_HUMAN(CONFIRMATION_SUBJECT_MISMATCH)`（**不能替别人确认**） | — | `D-33` 下没有权限层，唯一能防代确认的就是"确认人 = 调用者" |
| **DC-10** | 上下文 actor `kind ≠ 'HUMAN'` → `DECISION_REQUIRES_HUMAN(DECIDER_NOT_HUMAN)` | 即使 `actor.kind='SYSTEM'` 也拒 | `ck_execution_mandate_no_business_approval` `0001:L1647-1648`；§1-9 |
| **DC-11** | `confirmation_text_sha256` 必须等于 **服务端**对"被确认内容"算出的 hash，被确认内容的规范化 JSON **必须且只包含** `{result, reason, override_rationale, basis_refs}` 四个键（`override_rationale` 未给时写 `null`，键不省略）。不等即 `DECISION_REQUIRES_HUMAN(CONFIRMATION_TEXT_MISMATCH)`。**（2026-11-14 增补：`IN_CHAT` 的 pre-image 是 **v2** = 这四键 + 原话 + 确认人 + 确认时间 + 版本标记，见 §17.2；四键口径作为 v1 保留给旧记录）** | 这一条才能证明"人确认的是这一版内容"，不是"人点了个按钮"。**`override_rationale` 必须在 hash 里**：它是"反着来"的唯一理由，若不进 hash，就能出现"人确认时没有理由、落库时理由被程序塞进去"——`DC-28` 的留痕会变成可后补的装饰 | 与 `approval.canonical_payload_hash` 同一手法（`0001:L421-423`）；`INV-9`；`DC-29` |

> **为什么"三要素"不够、还要 hash**：如果只记"某人某时点了确认"，那么**确认之后理由被改写**（或被程序改写）就无法发现。hash 把"确认"绑到"内容"上，这是 `approval` 表已经用过的做法（`resource_record_version` + `canonical_payload_hash`，`0001:L421-423`）。
>
> **为什么不能只靠 `actor.kind`**：`actor.kind` 是**行数据**，一个被误配成 `HUMAN` 的 SYSTEM actor 会让所有闸门失效。所以契约要求**同时**：`kind='HUMAN'` + 上下文 actor = 确认人 + 内容 hash 三方对齐。库层面只有 `execution_mandate` 的 CHECK（`0001:L1647-1648`）能挡 Agent，剩下的只能靠这三条。

> **2026-11-14 增补（D-95 / P1-2）**：`confirmation_method` 增加 **`IN_CHAT`**（人在对话里明确指示过就**只做一次决策**，不再弹二次确认）；
> `IN_CHAT` 必须带 **`confirmation_text`（人的原话）**，且原话进 `confirmation_text_sha256` 的 **v2 pre-image**。
> 旧口径（四键）作为 **v1** 保留，库里已落的旧 hash 仍按 v1 验。完整口径与版本化理由见 **§17.2**。

### 5.2 系统对"结论"的边界

| 允许 | 禁止 |
|---|---|
| 汇总票数、列出少数派、标出缺失与未读、报告"当前门禁允许哪些结果" | 说"建议录用 / 建议淘汰"；给"综合得分"；给"通过概率"；按多数票自动落 `decision` |
| 提示"这类情况历史上通常…"（若有此功能，属 S12 复盘，不在 v1.0） | 把 `consensus` 直接映射成 `result`（`DC-01`） |

---

## 6. 可回溯：`basis_refs` 的结构

### 6.1 `kind` 封闭集（9 种，**多一种都不行**）

| `kind` | 何时必须出现 | 关键字段 |
|---|---|---|
| `SCORECARD` | **默认每次决策至少 1 条**；**唯一例外**：`result ∈ {WITHDRAW, HOLD}` ∧ `submitted_count = 0` → **允许 0 条**（不得因缺它报 `BASIS_REF_EMPTY`） | `id`,`revision_no`,`interviewer_id`,`payload_hash`,`overall`,`transcript_basis`,`transcript_state`,`fields[]`（`dimension_key`+`assessment`+`evidence[]`）；**可选** `rubric_version_id`（给了必须等于库里该面评绑定的版本）。**`overall` 就是 `scorecard.overall` 列**（不是 `recommendation`）；`transcript_basis`/`transcript_state` 是 `TR-E7` 强制要求 |
| `SUMMARY` | **每次必带** | `summary_digest`,`contract_version`,`coverage`,`tally`,`consensus` |
| `RUBRIC_VERSION` | **每次必带** | `id`,`version_no`,`payload_hash` |
| `INTERVIEW_RECORD` | 仅当决策引用了 Record 内容 | `id`,`transcript_artifact_id`,`transcript_revision`,`verification_status`（必须 `VERIFIED`） |
| `SCREENING_DECISION` | 从 S7 推进来的决策 | `id`,`result`,`decided_at`（只读引用，不改写） |
| `AUTHORITY` | **每次必带** | `actor_id`,`is_hiring_manager`（`DC-14`） |
| `OVERRIDE` | 结论与 `consensus` 相反时 | `acknowledged_dissent`:true,`override_rationale` |
| `MISSING_ACK` | `PROCEED_WITH_MISSING` 时 | `interviewer_ids[]`,`rationale` |
| `SUPERSEDES` | 撤回/重开时 | `decision_id`,`reason`,`opened_by_actor_id` |

| # | 规则 | 判定 | 依据 |
|---|---|---|---|
| **DC-12** | `basis_refs` **必须非空**（库只校验 array，`[]` 合法 —— `0001:L1358`） | 空 → `INVALID_ARGS(BASIS_REF_EMPTY)`。**"非空" ≠ "必须含 SCORECARD"**：零面评的 `WITHDRAW`/`HOLD` 只带 `SUMMARY` + `RUBRIC_VERSION` + `AUTHORITY` 即合法（见 §4.2 的两条新口径；上表例外） | `D11 §9.9`；`INV-9` |
| **DC-13** | `kind` 必须 ∈ 上表 9 种；出现 `AI_SUMMARY` **或任何其它值** → `INVALID_ARGS(BASIS_KIND_FORBIDDEN)` | **AI 摘能不能作为对人的决策依据**——它只能给人读，不能进依据 | `XINV-8`（原始/派生/人工评价分存）；`docs/03:L67-68`"原始转写、AI 摘要和人工评价不能互相覆盖" |
| **DC-14** | `AUTHORITY` 必带，且 `is_hiring_manager` **由服务端按 `DC-15` 计算**（**不是**根据权限、**不是**采信入参）：出参与落库一律写**计算值**。调用方若在 `basis_refs[AUTHORITY]` 里给了 `is_hiring_manager`，必须与服务端计算值一致，否则 `INVALID_ARGS(BASIS_AUTHORITY_MISMATCH)`（**不静默覆盖、也不静默采信**）。`false` 时输出 `warnings: DECIDER_NOT_HIRING_MANAGER`，**不阻断** | 见 `DC-15`；口径唯一化：**"计算值"是唯一真相，入参只是待校验的副本** | `D-33`（无权限）；`D-46→D-52`（不为罕见情况设闸门；按 `D-52` 引用） |
| **DC-15** | `is_hiring_manager(actor, application) := ∃ d · d.id = application.job.department_id ∧ d.hiring_manager_actor_id = actor`。`hiring_manager_actor_id` 为空 → 全员 `false` + `warnings: HIRING_MANAGER_UNSET` | `job.department_id` 在 **`0001:L507`**（`NOT NULL`；**`L506` 是 `job.tenant_id`**，不要引错）；`department.hiring_manager_actor_id` `0001:L331`。**注意：`requisition` 表没有任何 owner 列**（`0001:L473-502`），所以"招聘负责人"无法从需求单推出 | 可判定：一条 join 就能算 |
| **DC-16** | `SUMMARY` 项的 `summary_digest` 必须 = 本次重算的 digest（`DC-20`）；不等 → `INVALID_ARGS(SUMMARY_STALE)` | 防止"用旧面板的汇总做新决策"（比如 3 人面板，决策时只交了 1 人） | `screening-rules.md §11 D-4` 同构 |
| **DC-17** | `RUBRIC_VERSION` 的 `payload_hash` 必须 = `rubric_version.payload_hash` 且 `id` = `application.rubric_version_id` | 这是"决策绑定 Rubric 版本"的**唯一**落点（表里没列） | `0001:L594`（hash）、`L839`（钉版本）；`INV-10` |
| **DC-18** | `result='REJECT'` ⇒ `reason` 必须**至少包含一个** `dimension_key`（子串匹配，大小写敏感） | 只写"不合适"三个字 → `INVALID_ARGS(DECISION_REASON_NO_DIMENSION)` | `D11 §9.3`；`INV-9` |
| **DC-19** | 若给 `approval_id`：`approval.resource_type='DECISION'` ∧ `resource_id = 本次 decision.id` ∧ `status='APPROVED'` ∧ `decided_at ≤ decision.decided_at`；否则 `INVALID_ARGS(APPROVAL_BINDING_INVALID)` | 库只支持前两条的**前半**：`ck_approval_resource_type` 含 `'DECISION'`（`0001:L448-449`）、非 `PENDING` 必须有 `decided_at` + `decision_by_actor_id`（`ck_approval_decided_fields`，`0001:L455-459`）。**"`resource_id` = 本决策 id" 和 "`decided_at ≤ decision.decided_at`" 两条库层完全不保证**（`approval.resource_id` 只是普通 uuid 列，`0001:L420`，没有反向外键），只能由写侧校验。**顺序陷阱**：`decision` 整行不可改 ⇒ 必须**预生成 decision id** 先建 approval 再插 decision（`G-3`） | `0001:L448-449`、`0001:L455-459`（**不要引 `L461-462`**：那是 `ck_approval_supersede_link` 与 `ck_approval_expiry`，与本条无关） |
| **DC-20** | `summary_digest := sha256(canonical_json(§3.2 的固定子集))`，子集**只含** `contract_version / as_of / application_id / decision_scope / interview_id / rubric{version_id,payload_hash} / scorecards[{id,revision_no,interviewer_id,payload_hash,status}] (按 interviewer_id 排序) / record{id,revision,verification_status} / coverage / tally / missing[ids] / blockers[codes]`，**不含任何墙钟与随机**。`as_of` 必须进子集：`coverage.overdue` 由它决定，不写进去就会出现"不同 `as_of` 同一 digest"（`record` 就无法保证用同一个基准重算） | 子集固定是"同一输入复算出同一结果"的前提（`D-16`） | `D-16`；`screening-rules.md §11 D-3` |

### 6.1.1 SC-11 版本绑定（2026-11-14 增补，binding）

> **同一场决策里，所有参与的面评必须绑在同一个 rubric 版本上，且该版本 = `application.rubric_version_id`。**

* 汇总侧：版本不一致的面评**不进** `tally`/`aggregation`/`snapshot`/`digest`，并在
  `warnings[]` 报 `SCORECARD_RUBRIC_MISMATCH`（写明哪几条、两边版本）。必填面试官的这条
  同时落进 `missing`，面板因此不完整 → 既有门禁不放行 `ADVANCE`/`REJECT`。
* 决策侧：STEP 2（存在性）就把**全部现行面评**（current `SUBMITTED`/`WAIVED`）与
  `application.rubric_version_id` 逐条比对，任何一条不一致 → 拒绝
  `EVIDENCE_INSUFFICIENT(SCORECARD_RUBRIC_MISMATCH)`，`detail` 带
  `application_rubric_version_id` + 每条冲突面评的 `{scorecard_id, interviewer_id, status, rubric_version_id}`；
  `basis_refs[SCORECARD].rubric_version_id` 给了也要与库值一致。**零写入**。
* 为什么必须两边都做：汇总的职责是"如实报告世界"（剔除 + 可见警告），决策是"承诺"——
  不能把"面板里有一部分票来自旧版标准"当成没发生过。`stage-advance` 的补钉前置
  （`RUBRIC_PIN_CONFLICT_WITH_SCORECARD`）是第三道闸：从源头不让"申请钉 V2 而面评绑 V1"成立。
* **例外（不对称，2026-11-14 追加，binding）**：**`HOLD` / `WITHDRAW` 不受这条版本绑定约束。**
  它们是**止血动作**（"暂不决定" / "候选人自己退出"），不是对候选人的结论；而"因为面评绑错了
  版本所以先 hold 住"恰恰需要把那份错配面评**作为依据引用出来**，否则记录里看不出止血原因。
  因此这两种结果：
  - **不**因"现行面评里有版本错配"而在 STEP 2 被拒（面板级闸门只对 `ADVANCE`/`REJECT` 生效）；
  - `basis_refs[SCORECARD]` **允许**引用版本与申请 pin 不一致的面评。
  **其余校验一条都没有放宽**：面评必须属于本申请 / 本场面试、`overall` 必须等于库值、
  声明面不得与事实矛盾、`transcript_basis`/`transcript_state` 照旧必填。
  `ADVANCE` / `REJECT` 照旧拒绝。这与 §4.2.1「缺面评不阻断 `HOLD`/`WITHDRAW`」是**同一套不对称
  原则**：安全方向的动作用评价门槛卡住，只会制造"明知错配也只能让申请悬着"的自锁。

### 6.2 证据坐标的层级（不是每条都要求 bbox）```
decision.basis_refs[SCORECARD].fields[].evidence[]
   ├─ 若面评引用了转写 → {kind:"SEGMENT", transcript_artifact_id, transcript_revision, segment_id, quote}
   ├─ 若面评引用了简历 → {kind:"RESUME_SPAN", resume_version_id, source_asset_sha256, page, bbox}   （来自 S7 的 basis 透传）
   └─ 若都没有（凭现场记忆）→ [] 且该面评须 `evidence_state="MEMORY_ONLY"`（scorecard-rules SC-32）
```

> **证据 `kind` 只有 `SEGMENT`**（`D-74` / `TR-E3`）：`TRANSCRIPT_SEGMENT` 这个名字**已作废**，见到即违约。
> **`basis_refs[SCORECARD]` 必须带 `transcript_basis` 与该场次的 `transcript_state`**（`TR-E7`）：让"这个决定有没有原文支撑"可查。缺任一个 → `INVALID_ARGS(BASIS_TRANSCRIPT_STATE_MISSING)`。

| # | 规则 | 依据 |
|---|---|---|
| **DC-21** | 每一条 `REJECT` 依据必须能落到 `SCORECARD` 项里的**具体 `dimension_key`**，且该维度 `assessment='NOT_MET'`；落到不存在的维度 → `INVALID_ARGS(REJECT_REASON_NOT_BACKED)` | `D11 §9.3` |
| **DC-22** | `evidence=[]` 且该面评 `evidence_state='MEMORY_ONLY'` 时，`decision` **仍可成立**，但必须**由决策人显式确认**（`human_confirmation` 已覆盖）且输出 `warnings: REJECT_BASIS_MEMORY_ONLY` | 强制时间戳会逼人编造（`docs/03 §14` 允许无转写）；**但必须公开承认**——"排除要有记录"（`D11 §9.5` 同构） |
| **DC-23** | 引用 `INTERVIEW_RECORD` ⇒ 该 record 必须 `status='READY'` ∧ `verification_status='VERIFIED'`（`ck_interview_record_ready` `0001:L1228`）；否则 `BLOCKED_BY_REVIEW(RECORD_NOT_VERIFIED)`。**不引用它则不检查**（转写失败不能阻塞决策，`docs/03 §14`） | `0001:L1182-1229`、`L1231-1232`（current） |

---

## 7. 错误淘汰的四道防线（本文件最重要的一节）

> 一句话：**系统绝不允许"因为读不出 / 没交 / 没人反对"而淘汰一个人。**

### 防线 1 · `unreadable` 不得作为拒绝依据

| # | 规则 | 判定 | 依据 |
|---|---|---|---|
| **DC-24** | `result='REJECT'` 的每一条依据，其维度 `assessment` 必须是 `NOT_MET`。若任一依据落到 `UNREADABLE` 或 `NOT_OBSERVED` → `BLOCKED_BY_REVIEW(REJECT_BASIS_UNREADABLE)`，`detail` 列出具体维度与面评 | 这是 `scorecard-rules.md` SC-31 的**第二道闸**（提交时挡一次，决策时再挡一次，因为历史行可能由别的路径写入） | `D11 §9.2`、`§9.11` 红线 7 |
| **DC-25** | `result='REJECT'` 且 `blockers` 含 `UNREADABLE_NOT_RESOLVED` → 必须先把该维度澄清成 `MET`/`NOT_MET`（走面评修订），不得"跳过它继续拒" | 机检：删掉所有 `unreadable` 依据后，`REJECT` 仍成立（断言 A2 同构） | `screening-rules.md §7.2 A2` |

### 防线 2 · 缺面评不得成为拒绝理由

| # | 规则 | 依据 |
|---|---|---|
| **DC-26** | `result='REJECT'` 时 `missing` 必须为 `∅`；否则 `SCORECARD_MISSING` | §4.2 矩阵 |
| **DC-27** | **`REJECT` 必须有"投了不通过票的人"**：`∃ s ∈ 当前面评, s.status='SUBMITTED' ∧ s.overall='REJECT' ∧ s.reject_reasons[] ≠ ∅`；不满足 → `EVIDENCE_INSUFFICIENT(REJECT_WITHOUT_REJECTING_SCORECARD)`。**注意 `overall` 是列名**（`scorecard.overall`，`0001:L1286`）——`recommendation` 在任何表里都**不是列**（`0001:L1274-1320`），不要照抄那个名字 | 2 个通过 + 1 个未交 → 没有人说过"不行"，这时"淘汰"只能是决策人的个人判断，而**个人判断不是不行，是不能伪装成"面试结论"**——若要拒，必须让人在 `override_rationale` 里说清（此时 `REJECT` 需 `OVERRIDE` basis） |

> **DC-27 的例外形态**：`tally.reject = 0` 时，若存在一条 **current**（`superseded_by_decision_id is null`）、`decision_scope='SCREENING'`、`result='REJECT'`、同一 `application_id` 的 S7 决策，且**它的依据链里能引到至少一条 `failure_class='HARD_FAIL'` 的条目**（`screening-rules.md §7.2`：`MUST_HAVE_UNSATISFIED` / `DISQUALIFIER_TRIGGERED` 只能是 `HARD_FAIL`）→ 允许 `REJECT`，但 `basis_refs` **必须**带 `SCREENING_DECISION`，且该决策**未被 supersede**。这是**唯一**允许"没有面试官投反对票也能拒"的路径。
>
> **这里不许再写 `verdict=FAIL`**：`verdict` 是 **S7 工具出参**的字段名（`job-screening/tool-contracts.md` §7.2），**不是任何表的列**。落在 `decision` 行上的只有 `result`（`ck_decision_result`，`0001:L1354`）；`failure_class` 也只存在于 S7 输出的 `reasons[]` 里，处于 `basis_refs` 内层。写成列名会让实现者去找一个不存在的字段。

### 防线 3 · 没读出来的字段不得进入依据

| 场景 | 正确行为 | 错误行为（= 事故） |
|---|---|---|
| 转写缺失（`transcript_artifact` 无 `READY`） | 面评可提交（§1-7），决策依据不含 `SEGMENT` | 拒决策 / 或编造 segment 引用 |
| `interview_record.verification_status='UNVERIFIED'` | 不作为依据；`record.state='NOT_CITED'` | 引用未校验的模型产物当证据 |
| 简历某字段 `unreadable`（来自 S7 basis） | 该字段不得出现在 `REJECT` 依据链上 | 用"没读出来"当"不满足" |

### 防线 4 · 结论与面板相反时，必须有人签字

| # | 规则 | 判定 | 依据 |
|---|---|---|---|
| **DC-28** | `result` 与 `consensus` 方向相反（`REJECT` vs `MAJORITY/UNANIMOUS_ADVANCE`，或 `ADVANCE` vs `UNANIMOUS/MAJORITY_REJECT`）→ 必须有 `acknowledged_dissent=true` **且** `override_rationale` 非空（≥1 字符，非空白） | 缺失 → `INVALID_ARGS(OVERRIDE_NOT_ACKNOWLEDGED)` | `D11 §9.9`（可回溯）；用人经理有最终权（真实业务），但**反着来必须写明理由** |
| **DC-29** | `override_rationale` 必须进 `basis_refs[OVERRIDE]`（不能只放在 `reason` 里） | 否则"为什么反着来"会随界面消失 | 同上 |

> **为什么不直接禁止相反结论**：`D-46→D-52` 的教训是"不要为想象中的罕见情况设硬闸门"（`D-52` 作废 `D-46` 并重申："设计前先问：这在我们这里会发生吗？发生了是不是本来就该人管？"）。用人经理推翻面试小组是真实业务（`D-33` 也明确 v1.0 不做权限）。**正确做法不是拦，是留痕 + 显式确认。**

---

## 8. 决策之后：撤回 / 重开

### 8.1 能改吗？——不是"改"，是"覆盖"

| # | 规则 | 依据 |
|---|---|---|
| **DC-30** | 已落的 `decision` **内容一个字都不能改**（只有 `superseded_by_decision_id` 可 UPDATE） | `fn_guard_columns` 白名单 `0001:L1785` |
| **DC-31** | 撤回 = **新增一条** `decision`（新 `result`/`reason`/`basis_refs`）+ 旧行 `superseded_by_decision_id = 新行 id`。**两行都永远在**（物理 DELETE 直接报 `DELETE_FORBIDDEN`） | 9.1 禁删清单含 `decision` `0001:L1721-1732`；`INV-9` |
| **DC-32** | 撤回链**单向**：`superseded_by_decision_id` 只允许 `NULL → id`；把它改回 `NULL`（"复活"旧决策）→ `INVALID_ARGS(SUPERSEDE_LINK_CANNOT_BE_CLEARED)` | 库只保证"这列能改"（白名单 `0001:L1785`），不管方向。**现状**（无索引）：改回 `NULL` 会让两条 current 并存且库不拦；**`0007` 之后**：Step 2 的单向条件（`AND superseded_by_decision_id IS NULL`）与 current 唯一索引一起兜，复活会撞 **23505** |
| **DC-33** | 新行**必须**带 `basis_refs[SUPERSEDES]`：`{decision_id: 旧行, reason: 非空, opened_by_actor_id: 上下文 actor}` | "为什么推翻上一次"必须留在库里 |
| **DC-34** | 新行**必须**重新汇总：入参 `summary_digest` 必须是**当前**重算值（`DC-16`）；沿用旧 digest → `INVALID_ARGS(SUMMARY_STALE)` | 面评可能已经变了（缺的那份补交了），沿用旧汇总等于拿旧事实做新决定 |
| **DC-35** | 撤回的 `result` 可以是任何合法值，**包括 `HOLD`**（"回到待定"）。`ck_decision_result` 没有"撤销"值，**不得**为此扩枚举 | 扩枚举会动状态机（代价远大于收益） |

### 8.2 执行顺序（**与面评修订同构：三步舞**）

> 前提：`0007` 会给 `decision` 加 current 部分唯一索引（`D-75` 第 2 条）。**本表的顺序按"索引存在"写**——见 `DC-36` 的两阶段说明。

| 步 | 动作 | 写错会怎样 |
|---|---|---|
| 1 | `INSERT` 新 `decision`，**且 `superseded_by_decision_id = 旧行 id`**（临时"反向"指向） | 若第 1 步就让 `superseded_by` 为 `NULL` → `uq_decision_current` **23505**（旧行还是 current，两条 current 撞索引） |
| 2 | `UPDATE` 旧行 `SET superseded_by_decision_id = new.id, record_version = old.record_version + 1 WHERE id = 旧 AND record_version = expected AND superseded_by_decision_id IS NULL` | 若先做这一步（新行还不存在）→ `fk_decision_superseded_by` **23503**（`0001:L1351-1352`，外键是**立即**校验）；若不做版本条件 → 并发下静默改错行 |
| 3 | `UPDATE` 新行 `SET superseded_by_decision_id = NULL` | 不做这一步，最终**没有任何 current 决策**——`ALREADY_DECIDED` 检查会认为"可以再决一次"，于是同一个 `(app, scope, stage)` 反复重开 |

| # | 规则 | 依据 |
|---|---|---|
| **DC-36** | 撤回的写入顺序 **必须**是"**反向插 → 换指针 → 清空**"，与面评修订（`scorecard-rules.md §5.2`）**同构**；两段代码**仍不得共用**：面评有 `fn_row_guard`（`record_version` 自动 +1、自动补事件），`decision` 没有（手动 +1、手动补事件） | `0007` 之后 `decision` 有 current 部分唯一索引（`D-75` 第 2 条），所以**必须先让位**；`scorecard` 有 `uq_scorecard_current`（`0001:L1322-1323`），同理 |

> **两阶段口径（必须写进实现注释）**：
> - **`0007` 之前（当前库）**：`decision` 没有任何唯一约束（§2.3），"先插后指"也跑得通——**但契约不许按它实现**，否则 `0007` 一落地就全炸。这一阶段仍然走三步舞：第 1 步插一条 `superseded_by = 旧行` 的新行是**合法**的（FK 指向存在的行），不会因为缺索引而失败。
> - **`0007` 之后**：三步舞是**唯一**可行的写法；漏第 3 步会留下 0 条 current。
> - **并发重复**：`0007` 之后由库抛 **23505** → 工具映射 `ALREADY_DECIDED(SCOPE_ALREADY_DECIDED)`，**不重试、不覆盖**；`0007` 之前由 STEP 3 的检查 + `WHERE superseded_by_decision_id IS NULL` 的条件更新兜（0 行 → `ALREADY_DECIDED`）。
> - **禁止**用 `SELECT … FOR UPDATE` 当并发防线（`D-80`）：它锁不到不存在的行。

> **2026-11-14 增补（P1-1）**：`0008` 已把 `uq_decision_current`（和 `uq_decision_current_final`）改成
> **`DEFERRABLE INITIALLY DEFERRED` 的排斥约束（EXCLUDE）**。于是"同一申请已有当前决策"的库冲突
> **在 COMMIT 时抛 `23P01`（exclusion_violation）**，不再是 `23505`。写侧必须把 `23P01` 也映射成
> `ALREADY_DECIDED(SCOPE_ALREADY_DECIDED)`；只映射 `23505` = 契约失效（实测会漏出库内部码）。
> 详见 **§17.3**。

### 8.3 审计要求（撤回时全部必须有）

| # | 要求 | 为什么 |
|---|---|---|
| **DC-37** | 两次决策**都留在表里**，`decided_by_actor_id` 各自独立（可以是两个人） | 谁推翻谁，必须能追 |
| **DC-38** | **必须写一条内部事件**（`event_inbox`，`provider='internal'`、`trust_level='INTERNAL'`），`payload` 含 `{decision_id, supersedes_decision_id, from_result, to_result, actor_id}`；`idempotency_key='decision:'\|\|new_id`、`idempotency_source='FALLBACK_KEY'`、`source_object_id=new_id`、`provider_event_id=NULL`。**这个 `idempotency_key` 是 `event_inbox` 的必填列（`FALLBACK_KEY` 规则要求），不是客户端幂等承诺**——`D-80` 已取消"同一 key 重试返回同一条决策"，重复调用由 `0007` 的 current 唯一索引 + `ALREADY_DECIDED` 拦 | `decision` 无 `status` 列 ⇒ **不产生任何自动事件**（9.2 清单 `0001:L1742-1760` 不含它）。不补事件 = 决策这件事在事件线上不存在（`XINV-9`）；`FALLBACK_KEY` 必须绑 `source_object_id` 且不得同带 `provider_event_id`（`N07`） |
| **DC-39** | 旧行 `record_version` **必须手动 +1**（写在 UPDATE 里） | `decision` 没有 `fn_row_guard`（§2.3），不手动加就永远停在 1，乐观并发形同虚设 |
| **DC-40** | 已被撤回的决策**不得**再被"再撤回一次"（`superseded_by` 已非空 → 只能沿链向前）。旧行再被指向一条新行 → `INVALID_ARGS(SUPERSEDE_LINK_ALREADY_SET)` | 防分叉（两条新决策都指向同一条旧决策） |

> **防分叉的真相（`0007` 也治不了这一条）**：current 唯一索引只保证"同时只有一条 current"，**不阻止** `A←B` 与 `A←C` 前后脚出现（先 `A←B`，再把 A 的指针改成 C 就会伪造出一段不存在的历史）。所以 `DC-40` 必须靠应用层的**条件更新**兜：`UPDATE ... WHERE id = 旧 AND superseded_by_decision_id IS NULL`，0 行 → `SUPERSEDE_LINK_ALREADY_SET`。

---

## 9. Next Round Brief

### 9.1 什么时候生成

| # | 规则 | 依据 |
|---|---|---|
| **DC-41** | Brief **只在**"已存在 current `decision` 且 `result='ADVANCE'`"时生成；否则 `brief=null` + `brief_absence.code ∈ {NO_DECISION, NOT_ADVANCED, FINAL_SCOPE}` | 没有"要进下一轮"这个事实，就没有"下一轮要注意什么" |
| **DC-42** | Brief 是**派生**的，**不落表**（`D-16`）：同一输入 → 同一 `brief_digest`；没有 id，只有 digest | `D-16` 逐字："Evaluation Summary / Next Round Brief → 派生不落表（v1.0）；要求：同一输入可复算出同一结果" |
| **DC-43** | 生成 Brief **不改任何东西**（不建 `interview`、不动 `application.current_stage_code`、不建任务） | 改状态是独立命令；S11（Offer 与入职交接）在 v1.0 为 Deferred（`work/handoff/15-architecture-hv.md` §5，**老仓，新仓未收录**） |

### 9.2 内容来源（**逐项给来源，不许"总结一下"**）

| `brief` 字段 | 来源 | 为什么只能是它 |
|---|---|---|
| `next_round.round_no` | 上一 current decision 对应的 `interview.round_no + 1` | 数字可复算 |
| `carry_over[]` | 上一轮所有 `assessment ∈ {NOT_OBSERVED, UNREADABLE}` 的 `dimension_key` + 其出处面评 id | **这是 Brief 存在的唯一理由**：上一轮没考察到的，下一轮必须补 |
| `unanswered_questions[]` | `rubric_version.dimensions[].question`（判断型维度）中，上一轮无 `note` 的项 | 把这些题的原文带过去，不重写 |
| `absent_interviewers[]` | 上一轮 `missing[]`（含 `overdue`） | 下一轮要不要请这些人，是人的决定 |
| `evidence_refs[]` | 上一轮 `INTERVIEW_RECORD` 的 `sections[]` 坐标（若 READY）；否则空 | 只给坐标，不给模型摘要 |
| `brief_digest` | `sha256(canonical_json(上述全部))` | 防篡改 |

| # | 规则 | 依据 |
|---|---|---|
| **DC-44** | Brief **没有**自由文本总结字段（不允许 `summary` / `impression` / `recommendation`）。**结构上没有这个字段，就不可能有"上一轮的偏见被文字带进下一轮"** | `D11 §9.1`（归属正确性）与 §9.6 的精神：结论性文字会被下一轮锚定 |
| **DC-45** | Brief **不可手工编辑**。人若认为 Brief 缺了考察项，唯一合法路径是：① 新增一轮的 `interview_template_version`（加题）② 或新建 `rubric_version`（加维度）。**不得改写 `brief` 文本** | `D-32`（不得为通过而放宽）；`INV-10`（标准变更 = 新版本）。没有可写字段（`DC-44`）+ 有 digest（`DC-42`）⇒ 篡改必然被发现 |
| **DC-46** | 汇总/工具输出里的 `brief` 必须带 `derived_from`：`{decision_id, summary_digest, rubric_version_id, interview_ids[]}` | 让"这版 Brief 依据的是哪次汇总"可追 |

---

## 10. 系统**绝不**做什么（本文件范围内，共 9 条）

| # | 绝不 | 怎么查出来 |
|---|---|---|
| **N-1** | **绝不代决**：不产出 `result`、不产出"建议录用/淘汰"、不按票数自动落库 | 三个工具的输出 schema 里 grep `result` / `decided_by` / `recommend` 在 `summarize` 上得 0；`decision_record` 的 `result` 必填由人给 |
| **N-2** | **绝不用缺失面评算分**（0 分 / 平均 / 分母） | 断言 M-1/M-3（`denominator + excluded == required_total`；`average` 在 `missing>0` **或** `submitted=0` 时恒 `null`，见 M-1 的完整形态） |
| **N-3** | **绝不用 `unreadable` 字段拒绝人** | 断言 A2（删掉所有 `unreadable` 依据后 `REJECT` 必须仍成立） |
| **N-4** | **绝不修改已落的决策**（只允许加新行 + 单向链） | `IMMUTABLE_COLUMN` 触发器 + `DC-32` |
| **N-5** | **绝不改申请/面试状态**（`lifecycle_status` / `current_stage_code` / `interview.status` 全不动） | 调用前后 `record_version` 不变 |
| **N-6** | **绝不把 AI 摘要当依据** | `basis_refs[].kind` 枚举不含 `AI_SUMMARY`（`DC-13`） |
| **N-7** | **绝不因"决策人不是负责人"而阻断**（`D-33` 无权限；只记录） | `DC-14`：`warnings` 有、错误码没有 |
| **N-8** | **绝不输出恒真的权限字段**（`can_decide` / `allowed: true` 之类） | 输出 schema 里 grep `can_` 得 0（`D-33`"不预留假接口"）；`permitted_results` 只表达**数据门禁**，文档必须写明它不是权限 |
| **N-9** | **绝不在零面评（`submitted=0`，含全豁免）时 `ADVANCE`**，也**绝不**因"至少 1 条 `SCORECARD` basis"卡住零面评的 `WITHDRAW`/`HOLD` | `submitted_count=0` → `EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)`；`WITHDRAW`/`HOLD` 的 `basis_refs` 可 0 条 `SCORECARD`（`DC-12` 例外） |

---

## 11. 10 个判定用例（输入 → 结论 → 理由）

**公共夹具**：租户 `T1`；申请 `APP`（`current_stage_code='S10'`，`rubric_version_id=V2`）；面试 `I1`（`round_no=1`, `slot_code='DEFAULT'`）；三名面试官 `X`/`Y`/`Z` 均 `required_scorecard=true`，`Z.scorecard_due_at` 已过；`V2` 有 3 个维度 `d1/d2/d3`（全 `MUST_HAVE`）。

| # | 输入（关键差异） | 期望结论 | 理由 / 依据 |
|---|---|---|---|
| **C1**（必考） | `X`/`Y` 各交一份 `SUBMITTED`（`overall=ADVANCE`，三维度全 `MET`）；`Z` **未交**。问：能否决策？ | `summarize(scope=STAGE)`：`coverage={3,2,0,1}`、`ready_for_decision=false`、`consensus='UNANIMOUS_ADVANCE'`、`consensus_scope='PARTIAL_PANEL'`、`permitted_results=['ADVANCE','HOLD','WITHDRAW']`、`required_human_action='CHASE_SCORECARD'`。<br>**`ADVANCE`(STAGE)**：可落，但需 `missing_disposition='PROCEED_WITH_MISSING'` + `acknowledged_missing=[{interviewer_id:Z, why_proceed:非空}]`（其集合与 `missing[]` **完全相等**）→ 落库成功。<br>**`REJECT`**：`SCORECARD_MISSING`。<br>**`HOLD`/`WITHDRAW`**：直接可落，无需确认。<br>**`FINAL` scope 的 `ADVANCE`**：`SCORECARD_MISSING`（`permitted_results=[]`）。 | §4.2 矩阵；SC-21/22/23；`DC-26`。**"能否决策"的答案是分层的：能（有限制），不是"能"也不是"不能"。** |
| **C2**（必考） | `X`/`Y` = `ADVANCE`；`Z` = `REJECT`（`d1` 为 `NOT_MET`，`reject_reasons[0]` 完整）。三份全交。问：汇总怎么说？ | `tally={2,0,1,0}`、`consensus='MAJORITY_ADVANCE'`、`consensus_scope='FULL_PANEL'`、`minority_reports=[{Z, reject_reasons 原文}]`、`warnings` 含 `MINORITY_DISSENT`、`ready=true`、`permitted=['ADVANCE','HOLD','WITHDRAW','REJECT']`。<br>`ADVANCE` → 直接可落。<br>`REJECT` → 可落，**但**需 `acknowledged_dissent=true` + `override_rationale` 非空（`DC-28`）+ `basis_refs` 含 `OVERRIDE`。<br>**绝不**：输出"综合得分 0.67"或"建议 ADVANCE"。 | `DC-01`/`DC-03`；汇总**只描述票数**，不产生结论。三份齐 ⇒ `REJECT` 合法（有 1 份真反对票，`DC-27` 满足）。 |
| **C3**（必考） | `Z` 想因 `d2` 拒人，但 `d2` 的 `assessment='UNREADABLE'`（录音损坏，无法回听）。`X`/`Y` 全 `MET`。 | **提交阶段即被拦**：`EVIDENCE_INSUFFICIENT(REJECT_BASIS_UNREADABLE)`（SC-31）。`Z` 只能改 `HOLD`（+ `d2` 保持 `UNREADABLE`）或补出 `NOT_MET`。<br>若历史数据里已存在"用 `UNREADABLE` 拒绝"的面评 → 决策阶段 `BLOCKED_BY_REVIEW(REJECT_BASIS_UNREADABLE)`，`detail` 点名 `{interviewer:Z, dimension_key:'d2'}`。<br>若 `Z` 最终 `HOLD`，则 `REJECT` 因 `tally.reject=0` → `EVIDENCE_INSUFFICIENT(REJECT_WITHOUT_REJECTING_SCORECARD)`。 | **两道闸**：SC-31（写）+ `DC-24`（决）。`D11 §9.2`/`§9.11` 红线 7。**"只能进人工"= 该维度进 `RESOLVE_UNREADABLE` 队列，决策不得越过它。** |
| **C4**（必考） | 决策人 = HR 小王；`job.department_id` 的 `hiring_manager_actor_id` = 老李。 | **允许**（不是权限问题）。落库后 `basis_refs[AUTHORITY]={actor_id:小王, is_hiring_manager:false}` + `warnings` 含 `DECIDER_NOT_HIRING_MANAGER`，`decided_by_actor_id=小王`。**不报错、不静默。**<br>若 `hiring_manager_actor_id` 为空 → 全员 `is_hiring_manager=false` + `warnings: HIRING_MANAGER_UNSET`。 | `D-33`（v1.0 无 RBAC，角色只做标签）；`DC-14`/`DC-15`。**"要记录"的落点是 `basis_refs`，不是日志。** |
| **C5**（必考） | 已有一条 current `FINAL REJECT`（决策人老李）。小王认为错了，要改 `ADVANCE`。 | 走 §8 三步舞：`1)` 插新 `decision(result='ADVANCE', superseded_by=旧行.id)`；`2)` 旧行 `superseded_by=new.id` 且 `record_version+1`（`WHERE superseded_by_decision_id IS NULL`）；`3)` 新行 `superseded_by=NULL`；`4)` 写内部事件。<br>必带 `basis_refs[SUPERSEDES]` + **重新汇总**（`summary_digest` 必须重算，`DC-34`）。<br>若直接 `UPDATE` 旧行内容 → `IMMUTABLE_COLUMN`（23514）。<br>若把旧行 `superseded_by` 改回 `NULL` → `INVALID_ARGS(SUPERSEDE_LINK_CANNOT_BE_CLEARED)`。 | `DC-30`~`DC-40`。**两行都留着**，"谁推翻谁"可追。 |
| **C6** | 同一面试官对同一场面试**第二次**提交（`revision_no=1` 已 `SUBMITTED`），带不同 `idempotency_key`。 | `ALREADY_SUBMITTED`；提示走修订（三绑定重发 + `revision_no=2` + `revision_reason`）。修订按 `scorecard-rules.md §5.2` 三步舞执行，最终 `current` 仍恰好 1 行。 | `uq_scorecard_current` `0001:L1322-1323`；SC-04/18。**天真两步写法**：先插新行 → 23505；先改旧行 → 23503。 |
| **C7** | 调用方传 `interviewer_id=Z`，上下文 actor=`X`；或上下文 actor 是 `AGENT_WORKER`。 | 前者：`INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)`（`interviewer_id` 是**保留键**：声明在 schema 里但一律拒收，`tool-contracts.md §1.6`）。后者：`INTERVIEWER_MISMATCH(ACTOR_NOT_HUMAN)`。另：`X` 不是 `I1` 的登记面试官 → `INTERVIEWER_MISMATCH(ACTOR_NOT_INTERVIEWER)`。 | SC-01/02/03/05。**"不可代填"是结构性的，不是权限性的**（`D-33` 下无权限可依）。 |
| **C8** | `Z` 的面评是 `WAIVED`（`waive_reason` 非空，走独立人工命令）。 | `coverage={3,2,1,0}`、`ready_for_decision=true`、`tally.waived=1`、`aggregation.per_dimension[].denominator=2 & excluded=1`、`warnings` 含 `SCORECARD_WAIVED` 且 `waive_reason` 原文回显。<br>`scorecard_submit` **不接受** `WAIVED`（`INVALID_ARGS`）。 | SC-25/26；`ck_scorecard_waived` `0001:L1316-1317`；`APP-05`。**豁免 ≠ 缺，也 ≠ 有分。** |
| **C9** | `job.current_rubric_version_id = V3`（新发布），但 `application.rubric_version_id = V2`。`X` 提交时传 `V3`。 | `INVALID_ARGS(RUBRIC_MISMATCH)`。以 `V2` 提交则可；决策 `basis_refs[RUBRIC_VERSION]={V2.id, V2.payload_hash}`。事后 `V3` 发布**不改写**任何已有面评/决策（`N21`）。 | SC-09/10/11；`INV-10`；`D-21`。**"当前版本"不是"本次评价的版本"**——这是最容易做错的一点。 |
| **C10** | 有实现按 `(8+8+0)/3=5.33` 输出"综合得分"，把 `Z` 的缺失当 0 分。 | **违约。** 正确输出：`aggregation.method='PER_DIMENSION_SUBMITTED_ONLY'`、`average=null`、`average_refused_reason='MISSING_SCORES'`、`per_dimension[].denominator=2`、`excluded=1`。机检断言：`average` 为 `null` ∧ `denominator+excluded==required_total` ∧ `tally.a+h+r == coverage.submitted`。 | SC-22/23/24；`DC-04`。**这就是"缺就是缺"的可判定形态**：不是口号，是三个可跑的断言。 |
| **C11**（新增·必考） | `X`/`Y`/`Z` 三人**全豁免**（`Z` 走独立人工命令；`X`/`Y` 被替换，`required_scorecard` 改 false 后只剩 `Z` 一名必交且 `WAIVED`）→ `submitted=0`、`waived=1`、`missing=0`。问：能 `ADVANCE` 吗？ | `summarize`：`coverage.submitted=0`、`method='NOT_COMPUTED'`、`average=null`、`average_refused_reason='NO_SUBMITTED_SCORECARD'`、`consensus='NO_SUBMISSIONS'`、`blockers` 含 `NO_SUBMITTED_SCORECARD`。<br>**`ADVANCE`（任何 scope）→ `EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)`**（即使 `missing=0`，`acknowledged_missing` 也无从确认）。<br>**`HOLD`/`WITHDRAW` → 可落**，`basis_refs` 只需 `SUMMARY`+`RUBRIC_VERSION`+`AUTHORITY`（0 条 `SCORECARD` 合法）。<br>**`REJECT`** → `EVIDENCE_INSUFFICIENT(REJECT_WITHOUT_REJECTING_SCORECARD)`（没人投反对票）。 | §4.2 矩阵 + §4.2.1（两条新口径）；`DC-12` 例外；断言 M-1 的 `submitted=0` 分支。**"全豁免"不是"全体通过"**——豁免只说明"这个人不用评"，不说明"这个人行"。 |

**覆盖检查**：必考 6 项（C1 三缺一 / C2 两通过一不通过 / C3 unreadable / C4 非负责人 / C5 反悔 / C11 零提交与全豁免）全覆盖；追加 5 项覆盖幂等与修订（C6）、代填与 Agent（C7）、豁免（C8）、Rubric 升版（C9）、缺失算分（C10）。

---

## 12. 实现者最容易搞错的 12 个点（**全部已裁决**）

| # | 容易写成 | 为什么错 | 裁决 |
|---|---|---|---|
| **①** | 用 `job.current_rubric_version_id` 给面评打分/算决策 | 申请钉的是 `application.rubric_version_id`（`0001:L839`）；两者在"标准升版后"必然不同 | 只用申请钉住的版本（SC-09；`DC-17`） |
| **②** | 缺面评时按 0 分补齐，或按已交人数平均 | 把 3 人面板悄悄变成 2 人面板，且把"没交"读成"差" | `average=null` + `denominator/excluded` 显式（C10） |
| **③** | 面评修订两步走（先插新行 or 先改旧行） | 先插 → `uq_scorecard_current` 23505；先改 → `fk_scorecard_superseded_by` 23503 | 三步舞：反向插 → 换指针 → 清空（`scorecard-rules.md §5.2`） |
| **④** | 撤回决策用"先插后指"两步（以为 `decision` 没有唯一索引就可以先插） | `0007` 会给 `decision` 加 current 部分唯一索引（`D-75` 第 2 条）→ 先插一条 `superseded_by=NULL` 的新行必然撞 **23505**；**契约按"索引存在"写**，否则 `0007` 一落地就全炸 | 三步舞：反向插 → 换指针 → 清空（`DC-36`，与面评同构） |
| **⑤** | 以为 `decision.record_version` 会自动加 1 | `decision` 不在 9.2 的 `fn_row_guard` 清单里（`0001:L1742-1760`），**永远停在 1** | 手动 `+1` + `WHERE record_version=expected`（`DC-39`） |
| **⑥** | 以为 `basis_refs` 非空是库保证的 | `ck_decision_basis` 只校验 `jsonb_typeof='array'`，`[]` 合法（`0001:L1358`） | 契约强制非空 + 9 种 `kind`（`DC-12/13`） |
| **⑦** | 以为 `decision` 有 `rubric_version_id` 列 | 表里没有（`0001:L1325-1361`），"决策绑标准"只能落 `basis_refs` | `DC-17` |
| **⑧** | 把 `interview.status='EVALUATION_READY'` 当决策前置 | **没有任何工具推进这个状态**（`G-5`）→ 永远卡住 | 不以 `interview.status` 为前置；改为以**事实**（面评齐/record/阻断）为前置（`DC-47`） |
| **⑨** | 用 `review_queue` 当通用人工队列 | `review_queue.run_id` 外键指向 `conversion_run`（`0003:L275-276`），它是**转换队列**，装不下"这个人的面评问题" | 阻断只认 `business_task(status='WAITING_HUMAN')` + `business_refs`（与 S7 `HQ-1` 同一口径） |
| **⑩** | 在"提交"里顺手把面评设成 `WAIVED`，或把 `PENDING` 当"已交" | 豁免是人的决定（`APP-07`）；`PENDING` 是草稿 | SC-25/26、§6.2 |
| **⑪** | 把 `decided_at` / `submitted_at` 放进入参 | 可伪造"当场就交了""按时决定了" | 一律服务端时钟（SC-14、`DC-48`） |
| **⑫** | 汇总里加 `recommended_result` / `overall_score` 帮用户"省事" | 这就是代决——`APP-07` 的唯一实质含义 | 输出 schema 里**没有这两个字段**（§1-1、N-1） |

---

## 13. 与现有表结构对得上的证据（逐条可查）

| # | 本文档的主张 | 证据（文件:行） | 由什么保证 |
|---|---|---|---|
| 1 | 面评必须记录评价者与标准版本 | `0001:L1277-1280`（三列 `NOT NULL`）+ `0001:L1298-1303`（复合外键） | 库（`INV-7`） |
| 2 | 一人一轮一份当前面评 | `0001:L984`（`uq_interviewer`）+ `0001:L1322-1323`（`uq_scorecard_current`） | 库 |
| 3 | 面评提交后不可改 | `0001:L213-230`（`fn_scorecard_guard`）+ `0001:L1811-1813`（触发器）+ `verify.sql:610`（`N11`） | 库 |
| 4 | 提交必须有时间与分项 | `0001:L1314-1315`（`ck_scorecard_submitted`）+ `verify.sql:606`（`N10`） | 库 |
| 5 | 豁免必须有理由 | `0001:L1316-1317`（`ck_scorecard_waived`） | 库 |
| 6 | 必填面评由 `required_scorecard` 决定 | `0001:L979` | 库 |
| 7 | 决策必须留责任人/时间/结果/理由 | `0001:L1333-1335`、`L1357`（`ck_decision_reason`）+ `verify.sql:613`（`N12`） | 库（`INV-9`） |
| 8 | 决策整行不可改、只允许 supersede 指针 | `0001:L1785`（列白名单只有 `superseded_by_decision_id`）+ `0001:L1359-1360`（禁自指） | 库 |
| 9 | 决策历史不可物理删 | `0001:L1721-1732`（禁删清单含 `decision`/`scorecard`） | 库 |
| 10 | `basis_refs` 只校验"是数组"（**空数组合法**） | `0001:L1336`（default `'[]'`）+ `L1358`（`ck_decision_basis`） | **库不足** → `DC-12` |
| 11 | `decision` 没有 Rubric 版本列 | `0001:L1325-1361` 全列清单 | **库不足** → `DC-17` |
| 12 | `decision` 没有当前唯一约束（**现状**） | `0001:L1325-1361` 无 `uq_*`；仅 `ix_decision_application` `L1363` | **库不足** → §4.3 STEP 3；`0007` 补（`D-75`）/ `G-1` |
| 13 | 决策不自动产生内部事件 | 9.2 状态护栏清单 `0001:L1742-1760` 不含 `decision`（无 `status` 列） | **库不足** → `DC-38` |
| 14 | Agent 结构上不能决策/豁免 | `0001:L1647-1648`（`ck_execution_mandate_no_business_approval`：禁 `approve/reject/decide/merge_candidate/waive_scorecard`） | 库（`APP-07`） |
| 15 | 审批可绑决策（**只到"类型"与"已决字段"**） | `0001:L448-449`（`resource_type` 含 `'DECISION'`）+ `L455-459`（非 `PENDING` 必须有审批人+时间） | 库。**`resource_id = 本决策 id` 与 `decided_at ≤ decision.decided_at` 库层不保证** → 契约（`DC-19`） |
| 16 | 决策不改写申请历史状态 | `application.lifecycle_status` 与 `decision.result` 是两处（`0001:L843` vs `L1332`）；`SCHEMA §7` ④ 逐字"结论不写回" | 契约（`DC-47`/N-5） |
| 17 | 招聘负责人只能从部门推 | `job.department_id` 在 **`0001:L507`**（`L506` 是 `job.tenant_id`）；`department.hiring_manager_actor_id` `0001:L331`；`requisition` 无 owner 列 `0001:L473-502` | 契约（`DC-15`） |
| 18 | 阶段码必须是 S1–S12 | `ck_decision_stage_code` 只有正则 `0001:L1355`（**无外键**）；`stage_catalog` 在 `0004` | **库不足** → `DC-07`；`0007` 补外键（`D-75` 第 1 条） |
| 19 | 当前 Rubric 版本是显式指针 | `0004:L243`（`job.current_rubric_version_id`） | 库（`D-21`） |
| 20 | 转写未就绪不得阻塞面评 | `docs/03:L214` 逐字 + `XINV-8` | 契约（§1-7） |
| 21 | Record 必须引用真实转写版本 | `0001:L1209-1210`（**建表时**是 2 列 `(artifact_id, revision)`）；`0006_integrity_gaps.sql` §3 **已改成 3 列** `(tenant_id, transcript_artifact_id, transcript_revision) → transcript_artifact(tenant_id, id, source_revision)`（**沿用原约束名**，`D-77`）；`L1228`（`READY` 必须 `VERIFIED`）+ `L1231-1232`（current） | 库 |
| 22 | 人工队列只有 `business_task` 一种表达 | `business_task.status` 11 值（`SCHEMA §7`）；`review_queue` 的 `run_id` 外键指向 `conversion_run` `0003:L275-276` | 结构 |

---

## 14. 契约严于库的地方与库缺口

### 14.1 契约严于库（8 处，必须知道）

| # | 库允许 | 契约禁止 | 为什么必须补 |
|---|---|---|---|
| 1 | `basis_refs = '[]'` | 必须非空 + 9 种 `kind` | 否则"可回溯"只是文档里的一句话 |
| 2 | 两条 current 同类决策并存（**现状**；`0007` 之后由 partial unique 拦，23505） | `ALREADY_DECIDED` | 现状无部分唯一索引（`G-1`）；`0007` 才是落点（`D-75`/`D-80`） |
| 3 | `superseded_by` 改回 `NULL` | 单向链（`DC-32`） | 库只管"这列能改"，不管方向 |
| 4 | `stage_code='INTERVIEW'`（正则过） | 只允许 `'S10'` | 无外键到 `stage_catalog`（`0004` 只给 `application` 加了）；`0007` 补 |
| 5 | `result='HIRED'` 合法 | v1.0 禁用 | `ck_decision_result` 是全量枚举，不区分版本（`SCHEMA §5` Offer 缓做） |
| 6 | `decided_by_actor_id` 只要是个 actor | 必须 `kind='HUMAN'` + 人工确认三要素 + 内容 hash（含 `override_rationale`） | 库只有 `mandate` 的 CHECK，而 `actor.kind` 是行数据 |
| 7 | `submitted_count = 0`（全豁免）时 `missing=∅`，`ADVANCE` 在面评门槛上是"齐备" | `EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)` | "齐备"不等于"有依据"（见 §4.2.1） |
| 8 | `basis_refs[SCORECARD]` 可以不带 `transcript_basis`/`transcript_state` | 必须带（`TR-E7`） | 否则"这个决定有没有原文支撑"查不到；兄弟契约 `TR-E7` 已强制 |

### 14.2 库缺口（`G-*`，全部 fail-closed）

| # | 缺口 | 影响 | 临时口径 | 需要的变更 |
|---|---|---|---|---|
| **G-1** | `decision` 无 `uq (tenant_id, application_id, decision_scope, stage_code) WHERE superseded_by_decision_id IS NULL`（`stage_code` 可空，`0007` 必须处理 NULL） | 两条 current 决策并存；`ALREADY_DECIDED` 只能靠应用层 | 写入前查 current（`SELECT … WHERE superseded_by_decision_id IS NULL`，**不加 `FOR UPDATE`**——它锁不到不存在的行，`D-80`）+ 写后用 `WHERE superseded_by_decision_id IS NULL` 的条件更新兜；`0007` 之后 23505 → `ALREADY_DECIDED` | **`0007`** 加部分唯一索引（`D-75` 第 2 条；`0002_seed.sql` **无 DDL**，不要写 `0002`）。**本契约 §8.2 已按"索引存在"写，加索引不需要再改顺序** |
| **G-2** | `decision` 无 `status` / 无 `status_changed_*` | 决策不产生内部事件；无"生效/失效"状态 | 写侧补内部事件（`DC-38`） | **`0007`** 增 `status` + 挂 `fn_row_guard`（代价：会改 `verify.sql` 的断言） |
| **G-3** | `decision.approval_id` 与 `approval.resource_id` **互相依赖**，而 `decision` 整行不可改 | 若要求决策先审批，**永远写不进去** | v1.0 **不要求** `approval_id`（置 `null`）；若给，必须**预生成 decision id**（`DC-19`） | **`0007`** 或产品裁决"决策是否需要审批" |
| **G-4** | `decision` 无 `summary_digest` / `missing_ack` 列 | 撤回时的"新汇总"只能靠 `basis_refs` 表达 | 全落 `basis_refs`（`DC-16`/`DC-34`） | **`0007`** 增两列（便于查询"哪些决策是带缺失做的"） |
| **G-5** | `interview.EVALUATION_READY` 无工具推进 | 若设为前置会死锁 | 不作前置（`DC-47`/⑧） | 独立命令（不在本契约） |
| **G-6** | `review_queue` 是转换队列（`run_id` FK 到 `conversion_run`） | 不能用它承载"面评/未读澄清"的人工项 | 只用 `business_task(WAITING_HUMAN)` + `business_refs` | **`0007`** 若要做统一收件箱，需抽象（`docs/03 §11` 的 Human Attention Inbox） |

---

## 15. 依据索引

| 代号 | 位置 | 本文用它裁定了什么 |
|---|---|---|
| `INV-9` | `db/SCHEMA.md:180` | 决策保留责任人/时间/结果/理由（`DC-12`/`DC-18`） |
| `INV-10` | 同上 `:181` | 配置变更不改历史评价（`DC-45`、C9） |
| `XINV-8` | 同上 `:196` | 原始/派生/人工评价分存（`DC-13` 禁 AI 摘要作依据） |
| `XINV-9` | 同上 `:197` | 关键结论可追溯到事件/资料/人工决策（`DC-38`） |
| `APP-05` | 同上 `:210` | "必需 Scorecard 全交或 Waive"（§4.2 齐备口径） |
| `APP-07` | 同上 `:212` | Agent 不得写面评、不得代做闸门（§1-1、§5、N-1） |
| `N07` / `N10` / `N11` / `N12` / `N21` | 同上 `:243`、`:246-249`、`:257` | `FALLBACK_KEY` 绑对象 ID、SUBMITTED 必填字段、已交不可改、理由必填、Rubric 不可改 |
| `0001:L1325-1361` | `decision` 建表 | §2 全表、§13 第 10–13 条 |
| `0001:L1274-1323` | `scorecard` 建表 + 两个唯一约束 | `DC-26`、§8.2 顺序对照 |
| `0001:L1785` | `decision` 的列级不可变白名单 | `DC-30`/`DC-32` |
| `0001:L1742-1760` | 9.2 状态护栏清单（**不含 `decision`**） | `DC-38`/`DC-39`、`DC-47` |
| `0001:L1647-1648` | `ck_execution_mandate_no_business_approval` | §1-1、`DC-10` |
| `0001:L1721-1732` | 禁删清单 | `DC-31` |
| `0001:L448-449` / `L455-459` | `approval` 的 `resource_type` 含 `DECISION`、已决必有审批人 | `DC-19`/`G-3` |
| `0001:L1182-1232` | `interview_record`（`READY` 必须 `VERIFIED`、current 唯一）。**`fk_interview_record_artifact` 已由 `0006_integrity_gaps.sql` §3 改成 3 列**（含 `tenant_id`，沿用原名，`D-77`） | `DC-23` |
| `0001:L507` / `L331` | `job.department_id`（**`L506` 是 `job.tenant_id`**）/ `department.hiring_manager_actor_id` | `DC-15` |
| `0003:L255-302` / `L275-276` | `review_queue` 是转换队列 | ⑨、`G-6` |
| `0004:L243` | `job.current_rubric_version_id` | `DC-17`（**不是**本次评价版本） |
| `SCHEMA §6` / `§7` ④ | `db/SCHEMA.md:137`、`:154` | 汇总不落表（`DC-42`）；结论不写回状态（`DC-04`） |
| `D11 §9.2 / §9.3 / §9.9 / §9.11` | `work/handoff/11-pdf-acceptance-criteria.md` §9（**老仓，新仓未收录**；不写行号） | 三态、拒绝可解释、可回溯、红线 7 |
| `docs/03 §14` | `docs/03-domain-and-runtime.md:214` | 转写失败不阻塞面评；不得伪造完成 |
| `docs/03:L88` | 同上 | 结论不覆盖 Application 历史状态（§1-8） |
| `handoff 15 §5` | 老仓 `work/handoff/15-architecture-hv.md` §5（**新仓未收录**；阶段码口径已由 D-22 与 `db/stage_catalog` 取代，见 `contracts/STAGE-CODES.md`；**不写行号**） | S10 做、S11 不做（`HIRED` 禁用） |
| `D-16` | `docs/17-decision-ledger.md`（D-16） | Summary/Brief 派生不落表、可复算 |
| `D-21` / `D-22` | 同上（D-21、D-22） | Rubric 显式指针；阶段码 S1–S12 |
| `D-32` | 同上（D-32） | 不得为通过而放宽校验（`DC-45`） |
| `D-33` | 同上（D-33） | 无 RBAC、角色只做标签、不预留假接口（`DC-14`、N-8） |
| `D-41` | 同上（D-41） | 自动决策必须记 actor（§1-9） |
| `D-46→D-52` | 同上（**D-52 作废 D-46**） | 不为罕见情况设闸门——元规则**按 `D-52` 引用**（`DC-28`） |
| `D-74` | 同上（D-74） | 证据 kind 用 `SEGMENT`；`items` 是对象（§6.2） |
| `D-75` / `D-80` | 同上（D-75、D-80） | `0007` 的五处缺口；取消客户端幂等键、不用 `FOR UPDATE`（§2.3、§8.2、`G-1`） |
| `D-77` / `D-53` | 同上（D-77、D-53） | `fk_interview_record_artifact` 沿用原名改 3 列；`fk_application_rubric_job` 是 3 列 |
| `TR-E7` | `contracts/interview/transcript-rules.md` §9.3（兄弟契约，**冲突时以它为准**） | `basis_refs[SCORECARD]` 必须带 `transcript_basis` + `transcript_state`（§6.1/§6.2） |

---

## 16. 需要拍板的口径（我不代决）

| # | 问题 | 我按什么执行 | 需要谁 |
|---|---|---|---|
| **Q-1** | `FINAL` 决策是否需要审批（`approval_id`） | v1.0 **不要求**（`G-3`：要求就写不进去，除非预生成 id） | 产品负责人 |
| **Q-2** | `REJECT` 是否允许"只有 `SCREENING_DECISION` 反证、无面试官反对票" | 允许（`DC-27` 例外形态），但必须带 `SCREENING_DECISION` basis | 产品负责人（涉及"初筛能否直接淘汰"） |
| **Q-3** | 是否加 `uq_decision_current`（`G-1`） | **契约已按"索引存在"写**（§8.2 三步舞），加索引**不需要**再改顺序；`0007` 落地前用条件更新兜 | 总控（`0007` 排期；`0002_seed.sql` **无 DDL**） |
| **Q-4** | `score`（1–5）是否进任何决策统计 | **不进**（`scorecard-rules.md` Q-2） | 产品负责人 |
| **Q-5** | `ADVANCE(FINAL)` / `REJECT` 缺面评时能否用 `acknowledged_missing` 放行 | **不能**：`acknowledged_missing` 只对 `ADVANCE(STAGE)` 有效（§4.2.1）。取更严一侧，避免把"终局缺面板 / 错误淘汰"变成可确认的旁路 | 总控（若确要放行 `FINAL`，需明确裁定 + 同步改 §7 防线） |

---

## 17. 2026-11-14 增补（S7 `SCREENING` 写侧 / `IN_CHAT` + v2 pre-image / `23P01`）

> **性质**：本节是**追加**，不修改 §4 / §5 / §6 / §8 的既有 `DC-*` 条目。与它们冲突时，以本节为准
> （`AGENTS §5` 时间优先：2026-11-14 的裁定晚于 `decision 1.1.0` 的 2026-11-13 基线）。
> **触发**：独立验收窗口 2026-11-14 实测出的 P0-3（S7 人决定没有落库路径）、P1-1（`23P01` 未映射）、
> P1-2（D-95 的 `confirmation_text` 未进 pre-image、契约未回抄 `IN_CHAT`）。P1-3（`pdf_text_recovered_by_ocr`
> 被 `src/db/material.ts` 当 HARD）属 S6 材料层，不在本文件范围。

### 17.1 `decision_scope='SCREENING'` 的写侧口径（补 `DC-06` 的空白）

**背景（三条同时成立才叫缺口）**：① `DC-06` 只定义 `STAGE`/`FINAL`，`SCREENING` → `DECISION_SCOPE_NOT_S10`；
② §2.2 写"`SCREENING` 归 S7 写侧"，但**S7 写侧从未实现**；③ `docs/18-golden-path.md` 第 4 步要求
`screening_evaluate → decision_record(scope='SCREENING')`，而 0008 之后的库实况是 `STAGE=1 / SCREENING=0`。
现在 `recruitment_decision_record` **接受** `SCREENING`。

**S7-01 落库形状**

| 项 | 口径 |
|---|---|
| `decision_scope` | `'SCREENING'` |
| `stage_code` | **工具写死 `'S7'`**（`stage_catalog` 在册）；调用方仍**不得**传 `stage_code`（`DC-07` 的保留键规则不变） |
| `interview_id` | **必须为空**（S7 还没有面试）。传了 → `INVALID_ARGS(SCREENING_SCOPE_NO_INTERVIEW)` |
| `summary_digest` | **不接受**（S7 没有 S10 汇总）。传了 → `INVALID_ARGS(SCREENING_SCOPE_NO_SUMMARY)` |
| `result` | 只允许 `ADVANCE` / `HOLD` / `REJECT` / `WITHDRAW`。**S7 不是终局**：`HIRED` 仍按 v1.0 全局禁用（`RESULT_NOT_IN_V1_SCOPE`），不产生 `FINAL` 语义 |
| 不适用字段 | `missing_disposition` / `acknowledged_missing` / `acknowledged_dissent` / `override_rationale` → `INVALID_ARGS(MUTUALLY_EXCLUSIVE)`（S7 没有面评面板、没有 `consensus`；理由写 `reason`） |
| `supersedes` | **可用**。重评 = 新增一条 `SCREENING` 行 + 旧行 `superseded_by_decision_id` 指向新行（`job-rubric-rules.md §5.2` 的写侧顺序），撤销链仍单向 |

**S7-02 `basis_refs` 的 kind 封闭集（对 `DC-13` 的局部口径，不改 `DC-13` 本身）**

`DC-13` 的"九种，多一种都不行"**只约束 S10**（`STAGE`/`FINAL`）。S7 写侧按
`job-screening/tool-contracts.md §3.7` 的结构存，允许的 kind 只有五种：

| `kind` | 何时 | 关键字段 |
|---|---|---|
| `SCREENING_EVALUATION` | `result ∈ {ADVANCE, REJECT}` **必须**；`HOLD`/`WITHDRAW` 可 0 条（安全方向不受证据缺失影响，与 §4.2.1 同构） | `evaluation_digest`(64 hex)、`verdict`、`rubric_version_id`、`rubric_payload_hash`、`resume_version_id`、`resume_content_sha256`（必填）；`contract_version`、`reasons_digest`、`criteria_evaluated`、`counts`、`provenance`（可选） |
| `RUBRIC_VERSION` | **每次必带** | `id` = `application.rubric_version_id`、`payload_hash` = 库值（`DC-17` 同口径） |
| `AUTHORITY` | **每次必带** | `actor_id` = 上下文 actor、`is_hiring_manager` = 服务端计算值（`DC-14` 同口径） |
| `RESUME_VERSION` | 可选 | `id`（必填）+ `content_sha256`（可选，给了就与库值核对） |
| `SUPERSEDES` | 撤回/重开时 | 同 §6.1（`DC-33` 不变） |

其余 kind（`SCORECARD` / `SUMMARY` / `INTERVIEW_RECORD` / `SCREENING_DECISION` / `MISSING_ACK` / `OVERRIDE`）
在 `SCREENING` 下 → `INVALID_ARGS(BASIS_KIND_FORBIDDEN)`：S7 没有面评，把别的场次的面评当 S7 依据是污染，
而 `SCREENING_DECISION` 是"S10 引用 S7"，S7 不能引用自己。

**S7-03 服务端只核对绑定，不重算 verdict**

- `SCREENING_EVALUATION.rubric_version_id` 必须是申请钉住的那版、`rubric_payload_hash` 必须等于库值
  → 否则 `EVIDENCE_INSUFFICIENT(BASIS_SCREENING_RUBRIC_MISMATCH)`；
- `resume_version_id` 必须是该租户下存在的材料版本；申请钉了材料时必须是那一份；
  `resume_content_sha256` 必须等于 `resume_version.content_sha256`
  → 否则 `EVIDENCE_INSUFFICIENT(BASIS_SCREENING_RESUME_MISMATCH)` / `NOT_FOUND(RESUME_VERSION_NOT_FOUND)`；
- **不重算** screening 结论：S7 的输出是瞬态投影（`screening-rules.md §11 D-3/P-1`），重算等于在本工具里
  写第二份实现。**残余风险**：`evaluation_digest` 无法由本工具复算 → 靠"绑定三件套 + `basis_refs` 原样落库
  + 同事务内部事件（含 digest）"可追，不是密码学意义的重放证明。

**S7-04 人机闸门**：`D-95` 口径**不变** —— `IN_CHAT` + 人的原话（或 `approval`，见 §17.2）；
`decided_by_actor_id` 仍只来自执行上下文，`actor.kind` 必须 `HUMAN`。

**S7-05 唯一性**：当前唯一键 = `(tenant_id, application_id, 'SCREENING', 'S7')`；`0008` 的排斥约束在
**COMMIT** 检查，冲突 `23P01` → `ALREADY_DECIDED(SCOPE_ALREADY_DECIDED)`（§17.3）。
第二次不同结果的 SCREENING 决策必须走 `supersedes`。

**S7-06 出参差异**：`gate` 键**只有 S10 有**（S7 没有汇总，不硬造 `summary_digest`）。`labels.provenance`
取 `SCREENING_EVALUATION.provenance`，缺省按 `FIXTURE`（R4：没有证据不许自称 `LIVE`），`FIXTURE_BASIS`
warning 的门槛因此与 S10 不同（S7 看依据里的 provenance，而不是重算汇总的 provenance）。
内部事件 payload 记 `screening_evaluation_digest` 以便回查。

**S7-07 `DC-18` 仍适用**：`result='REJECT'` 时 `reason` 必须点到至少一个 rubric criterion 的 `key`
（S7 的 criterion 键名是 `key`，S10 是 `dimension_key`；两处都按"子串、大小写敏感"判）。

**S7-08 不改状态（`DC-47`/`N-5` 不变）**：本工具只落 `decision` 一行；`application.current_stage_code` /
`lifecycle_status` / `interview.status` 一个都不动。`docs/18` 第 4→5 步的"推进到 S8"由独立命令完成。

### 17.2 `confirmation_method` 增加 `IN_CHAT`；`confirmation_text_sha256` 的 pre-image **v1/v2**（补 `DC-08`/`DC-11`）

**枚举**（补 §5.1 的 `IN_APP_CONFIRM | SIGNED_RECORD`）：`IN_CHAT | IN_APP_CONFIRM | SIGNED_RECORD`。

| 项 | 口径 |
|---|---|
| `IN_CHAT` | 人在对话里**明确指示过**（`D-95`：人只做**一次**决策，问一次即执行，不再弹二次确认）。**必须**带 `confirmation_text`（人的原话，逐字、非空、≤2000 字符）；缺失 → `INVALID_ARGS(MISSING_REQUIRED)`（参数层）/ `DECISION_REQUIRES_HUMAN(NO_HUMAN_CONFIRMATION)`（确认层） |
| `IN_APP_CONFIRM` / `SIGNED_RECORD` | 保留（确实需要留痕签名的场景），仍走 `approval` 通道（`D-79`） |

**pre-image v1（旧口径，2026-11-14 之前的记录；也是无原话的确认方式）**

```
confirmation_text_sha256 := sha256(canonical_json({result, reason, override_rationale, basis_refs}))
```

四键，`override_rationale` 缺省写 `null`、**键不省略**。**键集合不得增删**：库里已落的旧 sha256 就是按它算的，
往 v1 里加键会让**所有旧记录验不过**（把历史记录变成假红）。

**pre-image v2（`D-95`，仅 `IN_CHAT`）**

```
confirmation_text_sha256 := sha256(canonical_json({
  preimage_version: 2,
  result, reason, override_rationale, basis_refs,
  confirmation_text, confirmed_by_actor_id, confirmed_at
}))
```

**为什么版本化**：v2 把"人说过的那句话 + 谁说的 + 什么时候说的"绑进 hash（`D-95` 的原话要求）；
不加版本标记就无法区分"旧四键 hash"与"新七键 hash"，旧记录会全部失配。

**服务端的选择规则（不猜）**：`confirmation_text` 非空 → **只接受 v2**；为空 → **只接受 v1**。
不等 → `DECISION_REQUIRES_HUMAN(CONFIRMATION_TEXT_MISMATCH)`，`detail` 带 `expected` / `provided` /
`preimage_version`。

**残余风险（沿用 `D-95` 原话）**：工具无法证明"人真的说过这句话"——Agent 理论上可以编造
`confirmation_text`。缓解是**可审计**而不是可阻止：原话 + 哈希 + 会话日志三者对不上就能查出来。

**落库位置**：`decision` 表没有 confirmation 列（`0001:L1325-1361`）→ 原话/哈希/版本号写进同事务的内部事件
`event_inbox`（`event_type='decision.record'`，payload 键 `human_confirmation_method` /
`human_confirmation_text` / `human_confirmation_text_sha256` / `human_confirmation_preimage_version`）。
事件与 `decision` 行同事务，事后可与会话日志对账，且不可改。

### 17.3 `23P01`（exclusion_violation）→ `ALREADY_DECIDED`（补 §2.3 / §8.2 的 `23505` 口径）

**0008 改了什么**：`uq_decision_current` 从 0007 的**部分唯一索引**改成
`EXCLUDE USING btree (tenant_id with =, application_id with =, decision_scope with =, (coalesce(stage_code,'')) with =)
WHERE superseded_by_decision_id IS NULL DEFERRABLE INITIALLY DEFERRED`；
另加 `uq_decision_current_final`（`(tenant_id, application_id)`，`WHERE decision_scope='FINAL' AND superseded IS NULL`）。
原因见 `db/migrations/0008_decision_uniqueness.sql` 文件头（重评事务在同一事务里要"先插新 current、再改旧行"，
立即检查的唯一索引两步都死）。

| 事实 | 后果 |
|---|---|
| 排斥约束是可延迟的 | 重复 current 由 **COMMIT** 时报错，SQLSTATE **`23P01`**（不再是 `23505`） |
| `23505` 仍可能来自其它唯一约束 | 原映射保留（`constraint='uq_decision_current'` → `ALREADY_DECIDED`；其它 → `DB_CONSTRAINT_VIOLATION(UNIQUE_VIOLATION)`） |
| 写侧必须映射 `23P01` | 一律 `ALREADY_DECIDED(SCOPE_ALREADY_DECIDED)`，`detail` 带 `constraint` / `sqlstate`。**不重试、不覆盖** |
| 时点陷阱 | STEP 7 的 `try/catch` 抓不到 COMMIT：工具入口（`execute`）必须对 `withActor` 抛出的错误**再映射一次** |
| 测试怎么真触发 | 可延迟约束可在同一事务内用 `SET CONSTRAINTS recruitment.uq_decision_current_final IMMEDIATE`（**schema 限定**：按 search_path 解析约束名）提前检查 → 真跑出一条 `23P01`（集成测试即此口径） |
