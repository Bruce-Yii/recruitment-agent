# db/INTEGRITY-GAPS.md · 0006「五个库层拦不住的完整性缺口」（D-65 / D-59）

**裁定来源**：`work/control/DECISIONS-2026-11-12.md` → **D-65**（四个 schema 缺口打包进 0006）、**D-59**（`business_task.owner_actor_id` 单开 0006）、**D-66**（认可「面试官独立提交、不可代填」）

**交付物**：
| 文件 | 作用 |
|---|---|
| `db/migrations/0006_integrity_gaps.sql` | 迁移：五段（§1–§5），每段「先检查、再改」，单事务 |
| `db/verify-0006.sql` | 自检：11 条结构断言 + 7 条正向 + **14 条负向** + 4 条 GAP-5 动态 + 5 条数据面 |
| `db/INTEGRITY-GAPS.md` | 本文件：改了什么、为什么、怎么验的、还剩什么、哪一处偏离了字面 |

**状态**：`ra_v6`（PostgreSQL 17.11）实测通过。**本线未执行任何 `git commit` / `git push`**（仓库里已有外部提交收录了迁移与自检脚本，`git` 状态以仓库为准，会随其它 lane 变化）。
**未改** 0001–0005 / `verify.sql` / `SCHEMA.md`。
`db/verify.sql` 在 0006 之后仍 **`VERIFY PASS`**（STRUCT-01…07 全 PASS + 32 条负向全过）。

---

## 1. 修的是哪五个漏洞

先给「改造前到底能干什么」的**实测**，再给改法。五个缺口全部满足同一个判据：**错误写法在库层不报错**。

| # | 缺口 | 改造前实测（真的能过） | 改法 |
|---|---|---|---|
| **GAP-1** | `interview.stage_code` 默认 `'INTERVIEW'`，且该列**没有外键** | 默认值 `'INTERVIEW'`（不在 S1–S12）；`insert ... (stage_code='INTERVIEW')` **成功落库**（实测 exit=0） | 默认 `'S8'` + 外键 `(tenant_id, stage_code) → stage_catalog (tenant_id, code)` |
| **GAP-2** | `execution_mandate` 的 CHECK **没禁 `submit_scorecard`** | `insert ... allowed_actions='{submit_scorecard}'` **成功落库**（实测 exit=0）→ agent 代填面评在库层不拦 | 同一个 CHECK 里加 `submit_scorecard`（原 5 值全部保留） |
| **GAP-3** | `fk_interview_record_artifact` 只有 `(transcript_artifact_id, transcript_revision)`，**不含 tenant_id** | 甲租户的 `interview_record` 引用**乙租户**的 `transcript_artifact` **成功落库**（实测 exit=0） | 改成 `(tenant_id, artifact, revision)` 3 列复合外键 + 补被引用键 |
| **GAP-4** | `business_task` **没有 owner/assignee 列**（D-59） | 工作台只能用 `created_by_actor_id` 冒充责任人；建任务的人 ≠ 干活的人时无法表达 | 加可空 `owner_actor_id`（**不设默认值**）+ 同租户外键 |
| **GAP-5** | `meeting` / `meeting_binding` 的 `record_version` 是**死列**（有列、无触发器） | 一次 UPDATE 后 `record_version` **仍是 1**、`updated_at` **不变**（实测，见 §5）→ 拿 `WHERE record_version = 1` 做乐观并发**永远成功**，两人同时改同一条会议会静默覆盖 | 照 0001 的 `fn_touch` 写法挂 before update 触发器 |

> GAP-1 / GAP-3 与 0004 修掉 `application.current_stage_code` 的那个缺口**完全同型**：
> 正则管形状，**管不了取值**；形状对但不存在/不属于本租户的值，只有在库层加外键才拦得住。

---

## 2. 改造前后对照（真实 `pg_get_constraintdef` 输出）

### 2.1 GAP-1 · `interview.stage_code`

| | 名称 | 定义 / 值 |
|---|---|---|
| **改造前** | （默认值） | `'INTERVIEW'::text` |
| **改造前** | （该列外键） | **0 条**（`interview` 上共 5 条外键，没有一条引用 `stage_code`；改造后 6 条） |
| **改造后** | （默认值） | `'S8'::text` |
| **改造后** | `fk_interview_stage_catalog` | `FOREIGN KEY (tenant_id, stage_code) REFERENCES recruitment.stage_catalog(tenant_id, code) ON UPDATE RESTRICT ON DELETE RESTRICT` |

- 外键指向 **`(tenant_id, code)`** 而不是 `code`：阶段目录是按租户的（0004 §1 的裁决口径），
  跨租户借用阶段名必须在库层被拦。强度与 D-65 字面一致，且更强（同时锁租户）。
- `ck_interview_stage_code` 的正则**没有动**：正则管形状（大小写/空串），外键管取值。
  两条并存不是冗余 —— 单独任一条都漏一半。改完后 `'INTERVIEW'` 由**外键**拒绝（实测 23503）。

### 2.2 GAP-2 · `execution_mandate` 的禁令 CHECK

| | 名称 | 定义 |
|---|---|---|
| **改造前** | `ck_execution_mandate_no_business_approval` | `CHECK ((NOT (allowed_actions && ARRAY['approve'::text, 'reject'::text, 'decide'::text, 'merge_candidate'::text, 'waive_scorecard'::text])))` |
| **改造后** | `ck_execution_mandate_no_business_approval` | `CHECK ((NOT (allowed_actions && ARRAY['approve'::text, 'reject'::text, 'decide'::text, 'merge_candidate'::text, 'waive_scorecard'::text, 'submit_scorecard'::text])))` |

- **只加一个禁止值**，原 5 个一个没少（`verify-0006.sql` S-4 逐个断言，少一个就 FAIL）。
- 没有另起一条 CHECK：同一件事写两处，日后必有一处漏改。

### 2.3 GAP-3 · `interview_record → transcript_artifact`

| | 名称 | 定义 |
|---|---|---|
| **改造前** | `fk_interview_record_artifact` | `FOREIGN KEY (transcript_artifact_id, transcript_revision) REFERENCES recruitment.transcript_artifact(id, source_revision)` |
| **改造后** | `fk_interview_record_artifact` | `FOREIGN KEY (tenant_id, transcript_artifact_id, transcript_revision) REFERENCES recruitment.transcript_artifact(tenant_id, id, source_revision) ON UPDATE RESTRICT ON DELETE RESTRICT` |
| **改造后（新增被引用键）** | `uq_transcript_artifact_tenant_id_revision` | `UNIQUE (tenant_id, id, source_revision)` |

- 被引用键是**必须**补的：`transcript_artifact` 原有 `uq(id, tenant_id)` / `uq(id, source_revision)`，
  没有任何一条的列集合是 `{tenant_id, id, source_revision}` —— 3 列外键无处可指。
- 沿用原约束名 `fk_interview_record_artifact`：库里只有一条「面试记录 → 转写版本」的外键，
  名字不随形态改变而漂移（本文件、SCHEMA.md、台账引用的都是这个名字）。
- 改动顺序：**先建新 → 验 convalidated → 再删旧**（同 0005 §4 的三道闸）。同事务内任何时刻都有一套在生效。

### 2.4 GAP-4 · `business_task.owner_actor_id`（D-59）

| | 内容 |
|---|---|
| **改造前** | `business_task` 上 `owner*` 列 = **（无）**；`owner_actor_id` 不存在 |
| **改造后** | `owner_actor_id uuid`（**nullable、无 DEFAULT**） |
| **改造后（外键）** | `fk_business_task_owner_actor` = `FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES recruitment.actor(id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT` |

- **不设默认值**（D-59 逐字）：默认值会把「还没分配」显示成「分配给了某人」，是一种静默错误。
- 没有用 `business_refs.kind` 表达责任人；迁移里还专门有一条前置检查**拒绝**库里已经出现这种形态（见 §3）。

### 2.5 GAP-5 · `meeting` / `meeting_binding` 的 `record_version`

| | 内容 |
|---|---|
| **改造前** | 两张表的 before update 触发器 = **0 个**；实测 UPDATE 后 `record_version` 仍为 1、`updated_at` 不变 |
| **改造后** | `trg_meeting_touch` = `CREATE TRIGGER trg_meeting_touch BEFORE UPDATE ON recruitment.meeting FOR EACH ROW EXECUTE FUNCTION recruitment.fn_touch()` |
| **改造后** | `trg_meeting_binding_touch` = `CREATE TRIGGER trg_meeting_binding_touch BEFORE UPDATE ON recruitment.meeting_binding FOR EACH ROW EXECUTE FUNCTION recruitment.fn_touch()` |

- **没有新造函数**：直接用 0001 §0 已有的 `recruitment.fn_touch()`（`updated_at = now()`、`record_version = old + 1`）。
  与其它 21 张可变表的并发语义完全一致 —— 这是修复，不是新增一套机制。
- 为什么不是 `fn_row_guard`：这两张表**没有状态列**（`meeting_role` / `binding_method` 都不是状态轴）。
  套 `fn_row_guard` 需要虚构 status 列并向 `event_inbox` 写事件 —— 属 R2 假接线（与 D-47 的豁免理由同源）。

---

## 3. 每个缺口「先检查、再改」的具体做法

一段一条（`0006` §1–§5），**检查不通过就 raise + 整笔回滚**，并把「哪一行、错在哪」逐条列出来。
**本迁移不替任何人改数据** —— 迁移替人改数据，会把「写错了」变成「看不出来写错过了」。

| 缺口 | 前置检查（发现即中止） | 中止时 SQLSTATE | 中止时输出什么 |
|---|---|---|---|
| GAP-1 | 现有 `interview` 的 `(tenant_id, stage_code)` 是否已在自己租户的 `stage_catalog` 里 | `23503` `STAGE_CATALOG_MISSING` | 每条：`interview=<id> tenant=<id> stage_code=<code>` |
| GAP-2 | ① 现有 mandate 的 `allowed_actions` 是否已含 `submit_scorecard`；② 是否用了大小写变体（`SUBMIT_SCORECARD` 等） | `23514` `MANDATE_ALREADY_ALLOWS_SUBMIT_SCORECARD` / `MANDATE_ACTION_CASE_VARIANT` | 每条：`mandate=<id> tenant=<id> actor=<id> allowed_actions={...}` |
| GAP-3 | ① 跨租户引用；② `transcript_revision` 与 artifact 实际 `source_revision` 不符；③ 指向不存在的 artifact（孤儿行） | `23503` `INTERVIEW_RECORD_CROSS_TENANT_ARTIFACT` / `_REVISION_MISMATCH` / `_ORPHAN_ARTIFACT` | 每条：`interview_record=<id>(tenant=...) → artifact=<id>(tenant=...)` |
| GAP-4 | ① 列若已存在，类型必须是 `uuid`；② 是否有任务已经用 `business_refs.kind ∈ {OWNER, OWNER_ACTOR, ASSIGNEE, RESPONSIBLE}` 表达责任人 | `42804` `OWNER_ACTOR_COLUMN_UNEXPECTED` / `23514` `OWNER_EXPRESSED_VIA_BUSINESS_REFS` | 每行：`business_task=<id> refs=[...]` |
| GAP-5 | ① 这两张表上不能已有**别的** before update 触发器（双触发器 = 一次 UPDATE 加两次版本）；② `record_version` / `updated_at` 不能已经坏了（`< 1`、为空、`updated_at < created_at`） | `23514` `TOUCH_TRIGGER_CONFLICT` / `TOUCH_AUDIT_COLUMNS_CORRUPT` | 每行：`meeting=<id> record_version=... created_at=... updated_at=...` |

### 3.1 六个中止路径的实测（临时库，每场景一个库，事后已 DROP）

| 场景 | 造了什么脏数据 | 结果 |
|---|---|---|
| A · GAP-1 | `insert interview ... stage_code='INTERVIEW'` | `错误: STAGE_CATALOG_MISSING: ...` → **exit=3**；库里无 `fk_interview_stage_catalog`、无 `owner_actor_id`、无 `trg_meeting_touch`，脏行**原样保留** |
| B · GAP-5 | `insert meeting ... created_at=now(), updated_at=now()-1h` | `错误: TOUCH_AUDIT_COLUMNS_CORRUPT: ...` → **exit=3**；**GAP-1..GAP-4 的 DDL 全部被回滚**（5 项检查全 0） |
| C · GAP-3 | 甲租户 `interview_record` 指向乙租户 artifact | `错误: INTERVIEW_RECORD_CROSS_TENANT_ARTIFACT: ...` → **exit=3** |
| D · GAP-2 | `insert mandate ... allowed_actions='{submit_scorecard}'` | `错误: MANDATE_ALREADY_ALLOWS_SUBMIT_SCORECARD: ...` → **exit=3** |
| E · GAP-2 | `insert mandate ... allowed_actions='{SUBMIT_SCORECARD}'`（大小写变体） | `错误: MANDATE_ACTION_CASE_VARIANT: ...` → **exit=3**（CHECK 拦不住的那种写法，由前置检查拒绝） |
| F · GAP-4 | `insert business_task ... business_refs=[{"kind":"OWNER",...}]` | `错误: OWNER_EXPRESSED_VIA_BUSINESS_REFS: ...` → **exit=3**（D-59 明确禁止用 `business_refs.kind` 表达责任人） |

> 场景 B 是「整笔回滚」最硬的一条证据：前置检查在**第 5 段**，前 4 段 DDL 已经执行过，
> 中止后 `fk_interview_stage_catalog` / `owner_actor_id` / 3 列外键 / CHECK 新值 / 默认 `'S8'` **全部不在库里**。

---

## 4. 负向测试（14 条，SQLSTATE 为数据库真实返回）

`db/verify-0006.sql` §5；每条都断言 SQLSTATE，脚本单事务、结尾 `ROLLBACK`（不留数据）。

| 编号 | 缺口 | 用例 | 期望 = 实测 SQLSTATE | 数据库真实报错（约束名） |
|---|---|---|---|---|
| G1-01 | GAP-1 | 写入旧默认值 `INTERVIEW` | **23503** | `fk_interview_stage_catalog` |
| G1-02 | GAP-1 | 写入形状合法但目录里没有的 `S99` | **23503** | `fk_interview_stage_catalog` |
| G1-03 | GAP-1 | 把已存在的面试改到作废的五档值 `SCREENING` | **23503** | `fk_interview_stage_catalog` |
| G2-01 | GAP-2 | mandate 只有 `{submit_scorecard}` | **23514** | `ck_execution_mandate_no_business_approval` |
| G2-02 | GAP-2 | `{read, submit_scorecard}`（混在合法动作里） | **23514** | 同上 |
| G2-03 | GAP-2 | 给已签发 mandate **追加** `submit_scorecard`（UPDATE 路径） | **23514** | 同上 |
| G3-01 | GAP-3 | 甲租户 record 引用**乙租户** artifact | **23503** | `fk_interview_record_artifact` |
| G3-02 | GAP-3 | 同租户但 `revision=2`（artifact 只有 1） | **23503** | `fk_interview_record_artifact` |
| G3-03 | GAP-3 | 把已有 record 改指向乙租户 artifact（UPDATE 路径） | **23503** | `fk_interview_record_artifact` |
| G4-01 | GAP-4 | `owner_actor_id` 指向**不存在**的 actor | **23503** | `fk_business_task_owner_actor` |
| G4-02 | GAP-4 | `owner_actor_id` 指向**另一个租户**的 actor | **23503** | `fk_business_task_owner_actor` |
| G4-03 | GAP-4 | 把已有任务的负责人改成不存在的 actor（UPDATE 路径） | **23503** | `fk_business_task_owner_actor` |
| G5-01 | GAP-5 | `meeting.record_version = null` | **23502** | `record_version` NOT NULL |
| G5-02 | GAP-5 | `meeting_binding.record_version = null` | **23502** | `record_version` NOT NULL |

每条都有 INSERT 路径与 UPDATE 路径的覆盖（G1-03 / G2-03 / G3-03 / G4-03 是 UPDATE 路径）；
每个缺口 ≥ 2 条（GAP-1:3 / GAP-2:3 / GAP-3:3 / GAP-4:3 / GAP-5:2）。

配套的**正向**用例（`verify-0006.sql` §4，7 条）确认约束没有把正常业务堵死：
不写阶段 → `S8`；显式 `S9` → 成功；`{read,fetch,summarize}` → 成功；
同租户同 revision 的 `interview_record` → 成功；`owner_actor_id` 可写同租户 actor、也可不写；一次 UPDATE 只加 1 个版本。

---

## 5. GAP-5 为什么不是「SQLSTATE 负向测试」

`fn_touch` 的语义是**静默覆盖**（版本号永远是 `old + 1`，调用方写什么都改不动），
这与 0001 里 `fn_row_guard` 对 `record_version` 的处理**完全一致**。
所以「死列变活」这件事没有一种"写法会报错"的负向形态，它只能是**动态断言**：

| 断言 | 结果（实测） |
|---|---|
| 6.1 更新后 `record_version` 自增 1、`updated_at` 前移 | `record_version 1 → 2`，`updated_at 00:27:45.89 → 01:27:45.89`（事务时钟 `01:27:45.89`） |
| 6.2 手写 `record_version = 99` | 被覆盖为 `3`（= 上一版 + 1）→ **版本号不可伪造** |
| 6.3 `WHERE record_version = 1`（过期版本） | 影响 **0 行** → `VERSION_CONFLICT` 由调用方处理 |
| 6.4 `meeting_binding` 同构 | `record_version 2 → 3` |

> 实现提示：`now()` 在**同一事务内是常量**，所以夹具把新行的 `created_at/updated_at` 放到 1 小时前
> （`record_version = 1`，自洽：建了就没改过），这样「更新后 `updated_at` 前移」才是可观察的。
> 若复用一条本事务里已经 UPDATE 过的行，`updated_at` 不会再次变化 —— 这不是触发器没生效。

SQLSTATE 类的两条（G5-01/02）测的是「计数器不能缺席」：`record_version` 是 NOT NULL，
null 无法参与 `WHERE record_version = $expected` 的比较，乐观并发会退化成"永远不等"。

---

## 6. ⚠️ 与裁定 / 字面的偏离（请复核时确认，不要当成笔误）

### 6.1 GAP-4 用了**复合外键**（D-59 字面写单列）

D-59 写 `owner_actor_id → actor (id)`。本文件用：

```sql
foreign key (owner_actor_id, tenant_id) references recruitment.actor (id, tenant_id)
```

理由三条：
1. 本表其它 actor 外键（`fk_business_task_actor` / `fk_business_task_status_actor`）**全是复合写法**；
2. `SCHEMA.md §1` 的全局约定是「关键关系用 `(id, tenant_id)` 复合外键，物理上禁止跨租户引用」；
3. 单列形态允许甲租户的任务把「责任人」指向乙租户的 actor —— 工作台按 actor 过滤时，
   **跨租户的人会看到别人租户的任务**，而这正是 `owner_actor_id` 要服务的那张表。

强度**严格强于**字面（同租户 + 存在性同时成为物理约束），D-59 要拦的「指向不存在的 actor」照样拦（实测 23503），
可空语义不变（`MATCH SIMPLE`：`owner_actor_id is null` 时不检查）。**语义没有被改动。**

### 6.2 GAP-3 沿用了原约束名

0005 的做法是「新名字 + 删旧名字」，本文件是「同名重建」。原因：库里只有一条
`interview_record → transcript_artifact` 的外键，改名会让 `SCHEMA.md` / 台账 / 下游 SQL
里的名字指向一条**不存在**的约束。风险已用两道闸兜住（先建后删 + 删前核对旧定义）。

### 6.3 GAP-2 保留了「大小写敏感」的精确匹配

CHECK 与 0001 原有 5 个值同一口径：`submit_scorecard` 精确匹配。
`SUBMIT_SCORECARD` / `Submit_Scorecard` 这类写法**拦不住**，所以迁移里单加了一条前置检查：
只要库里有大小写变体就**拒绝迁移**，要求人工归一化。
（没有把 CHECK 改成 `lower()` 比较：那会改变 0001 既有约束的语义，超出 D-65 的授权范围。）

### 6.4 GAP-1 没有改动 `ck_interview_stage_code`

D-65 只要求「改默认 + 加外键」。正则继续保留 —— 它挡的是形状（小写、空串、下划线开头），
外键挡的是取值。两条各管一半，谁也替代不了谁。

---

## 7. 已知残余（0006 **明确不修**，请勿误认为已修）

| # | 残余 | 为什么不在 0006 | 建议 |
|---|---|---|---|
| 1 | **`ai_summary.fk_ai_summary_artifact`** 仍是 `(transcript_artifact_id, transcript_revision)` 2 列 | D-65 只点了 `interview_record`；本文件严格按五个缺口交付，不夹带第六处（否则又是一次"顺手改"扩权） | **0007**：与 GAP-3 同型，改法与 §2.3 完全一样（被引用键已经就位，可直接复用） |
| 2 | D-54 · 三张下游表的 rubric 引用（`interview_template_version` / `interview_record` / `scorecard` 只做 `(id, tenant_id)`，可引用别的岗位的 rubric） | D-65 明确「**单独 0007**，不混进 0006」；且它**是设计决策**（三张表都没有 `job_id` 列，纯外键做不到，需生成列或触发器） | 0007 + 新裁定 |
| 3 | `decision.stage_code` 只有正则、无外键 | 不在 D-65 的五个缺口内；`decision.stage_code` 是**可空**的历史结论字段，加外键会改变"旧结论允许指向已停用阶段"的语义 | 需要单独裁定（不是纯技术修复） |
| 4 | `interview.stage_code` 与 `application.current_stage_code` **没有联动约束**（面试阶段可以不等于申请阶段） | 这是业务语义（面试可能提前进入下一阶段），D-65 未要求 | 若产品要求强联动，需先写进 docs/03 |

> 第 1 条已在 `ra_v6` 上实测确认是**当前唯一**的多列外键不含 `tenant_id` 的残余（其它都被 0005 / 0006 处理了）。

---

## 8. 验收（命令 + 真实结果）

```powershell
$env:PGPASSWORD='123456'; $env:PGCLIENTENCODING='UTF8'
$psql='D:\12412\PostgreSQL\bin\psql.exe'
& $psql -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE IF EXISTS ra_v6 WITH (FORCE);" -c "CREATE DATABASE ra_v6;"
& $psql -U postgres -h 127.0.0.1 -d ra_v6 -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v6 -v ON_ERROR_STOP=1 -f db/migrations/0002_seed.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v6 -v ON_ERROR_STOP=1 -f db/migrations/0004_stage_catalog.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v6 -v ON_ERROR_STOP=1 -f db/migrations/0005_version_binding.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v6 -v ON_ERROR_STOP=1 -f db/migrations/0006_integrity_gaps.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v6 -v ON_ERROR_STOP=1 -f db/migrations/0006_integrity_gaps.sql   # 幂等
& $psql -U postgres -h 127.0.0.1 -d ra_v6 -v ON_ERROR_STOP=1 -f db/verify-0006.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v6 -v ON_ERROR_STOP=1 -f db/verify.sql
```

| 步骤 | exit | 关键输出 |
|---|---|---|
| DROP/CREATE | 0 | `DROP DATABASE` / `CREATE DATABASE` |
| 0001 | 0 | — |
| 0002 | 0 | — |
| 0004 | 0 | `0004 POST-CHECK PASS 目录 12 行 + demo job 已回填当前 rubric` |
| 0005 | 0 | `0005 POST-CHECK PASS 复合外键 2 条（含 job_id + tenant_id，restrict/validated）+ 旧外键已退场 + 跨岗位引用 0 条` |
| **0006（首跑）** | **0** | `0006 改造前 GAP-1：... 'INTERVIEW'::text；引用 stage_code 的外键 = 0 条` → `0006 POST-CHECK PASS 五个缺口全部落地` → `0006 DONE` |
| **0006（重跑）** | **0** | 全部走「已存在，跳过」/「已有等价唯一键，复用」/「已是 3 列形态，跳过」→ `0006 POST-CHECK PASS` → `0006 DONE` |
| **verify-0006** | **0** | `STRUCT-0006 PASS 五个缺口的 11 条结构断言全部通过`、`NEGATIVE-0006 SUMMARY 14 条负向测试全部按预期失败`、`VERIFY-0006 PASS` |
| **verify.sql** | **0** | `STRUCT-01…07 PASS`、`NEGATIVE SUMMARY 32 条负向测试全部按预期失败`、**`VERIFY PASS`** |

**幂等性的数值证据**（同一库连续跑第 3 遍，前后快照一致）：

```
--- BEFORE 3rd run ---   constraints=452  triggers=74  unique_indexes=112  stage_default='S8'::text
--- AFTER  3rd run ---   constraints=452  triggers=74  unique_indexes=112  stage_default='S8'::text
```

---

## 9. 文件清单与回滚

| 文件 | 行数 | 说明 |
|---|---|---|
| `db/migrations/0006_integrity_gaps.sql` | **890** | §0 现场 → §1 GAP-1 → §2 GAP-2 → §3 GAP-3 → §4 GAP-4 → §5 GAP-5 → §6 后置自检 → §7 改造后定义 → `commit` |
| `db/verify-0006.sql` | **849** | 单事务、结尾 `ROLLBACK`，不留数据 |
| `db/INTEGRITY-GAPS.md` | **284** | 本文件 |

**本迁移没有任何 `INSERT / UPDATE / DELETE`** —— §1–§5 的检查全是只读查询。
所以回滚是**纯结构操作**，反向 DDL 逐条写在 `0006_integrity_gaps.sql` 末尾；
唯一会丢数据的是回滚 `owner_actor_id`（D-59 明确禁止用 `business_refs.kind` 替代，库里没有第二载体）。

**不改的东西**：`0001`–`0005` / `db/verify.sql` / `db/SCHEMA.md` 一行未动。
`verify.sql` 的 32 条负向与 7 条 STRUCT 断言在 0006 之后仍全 PASS（上面第 9 步）。
