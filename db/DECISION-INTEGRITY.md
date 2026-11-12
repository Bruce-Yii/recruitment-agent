# DECISION-INTEGRITY · 0007 决策 / 面评完整性

> **一句话**：0007 把五件原本"只靠应用层自律"的事变成库层拒绝 ——
> ① 决策的阶段码必须在**本租户**目录里；② 同一 `(tenant, application, scope, stage)`
> 只能有一条 current 决策；③ 面评的评分标准必须属于**这个申请的那个岗位**；
> ④ 摘要引用的转写必须**同租户同 revision**；⑤ 直接 INSERT 终态面评不能绕过 actor。
>
> **一处事实更正**：任务书说 GAP-E 在 `decision` 上也成立。实测**不成立** ——
> `decision` 没有 `status` / `status_changed_by_actor_id` / `status_source_event_id` 列
> （实测 SQLSTATE `42703`），actor 由 `decided_by_actor_id NOT NULL` + 同租户外键强制
> （实测 `23502`）。本批**不**给 `decision` 新造状态列，只把证据记在 §5.2 与
> `verify-0007.sql` §7。

---

## 0. 文件与运行方式

| 文件 | 作用 |
|---|---|
| `db/migrations/0007_decision_integrity.sql` | 五段迁移（单事务；先检查再改；幂等） |
| `db/verify-0007.sql` | 自检：11 结构 + 11 正向 + 22 负向 + 7 数据面；结尾 `ROLLBACK` |
| `db/DECISION-INTEGRITY.md` | 本文件：裁定、代价、残留风险、运维步骤 |

```bash
# 迁移（自带 begin/commit，不要加 -1）
psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/migrations/0007_decision_integrity.sql
# 自检（必须是 psql：文件里有 \echo）
psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/verify-0007.sql
```

依赖：`0001`（decision / scorecard / ai_summary / transcript_artifact / actor）+
`0004`（stage_catalog 12 行、`uq_stage_catalog_tenant_code`、`uq_rubric_version_tenant_job_id`）+
`0006`（`uq_transcript_artifact_tenant_id_revision`，以及把 `interview_record` 的同类 2 列外键
修成 3 列 —— `verify-0007.sql` DATA-07 的"全库多列外键必须含 `tenant_id`"以它为前提）。
`0002 / 0003 / 0005` 与本文件无交集。若 0006 的被引用键不在位，0007 §4.2 会按列集合判断后
补建同名键（不重复建），但这只是兜底，不改变"0006 是必需依赖"。

---

## 1. GAP-A · `decision.stage_code` 必须存在于本租户的阶段目录

### 1.1 改造前（实测，`ra_v7` 基线 = 0001–0006）

```sql
insert into recruitment.decision (tenant_id, application_id, decision_scope, stage_code,
                                  result, decided_by_actor_id, reason)
values ('…0001','…0701','STAGE','BANANA','ADVANCE','…0102','probe');
-- exit=0；落库 1 行
```

同样的写法对 `'SCREENING'`（已作废的五档值）、`'INTERVIEW'`（0006 退场的旧默认值）
全部成功。根因不是"没人管字段"，而是**只有正则没有取值校验**：

| 对象 | 改造前 |
|---|---|
| `ck_decision_stage_code` | `CHECK (stage_code IS NULL OR stage_code ~ '^[A-Z][A-Z0-9_]{1,40}$')` —— 只管形状 |
| 引用 `stage_code` 的外键 | **0 条** |

### 1.2 改法

```sql
alter table recruitment.decision
  add constraint fk_decision_stage_catalog
  foreign key (tenant_id, stage_code)
  references recruitment.stage_catalog (tenant_id, code)
  on update restrict on delete restrict;
```

复合列而不是单列 `code`：阶段目录是**按租户**的（0004 §1），跨租户借用阶段名必须被拦。

### 1.3 NULL 的语义（写进合同，别让下一个人猜）

`stage_code` 可空，外键是默认的 `MATCH SIMPLE`：任一列 NULL → 整条外键不检查。
这是**有意**的：

* `NULL` 表示**不分阶段**（例如 FINAL 决策），它**不是**"任意阶段"，也**不是**一个合法 code；
* 正则 `stage_code ~ '^[A-Z]…'` 对 NULL 也不成立（`NULL OR …` 为 NULL），所以 NULL 只能来自"没写"，
  不可能来自"写了个空字符串"（`''` 会被正则拒绝）。

### 1.4 加外键后**仍然合法**的写法（不要误判成漏网）

* `stage_code IS NULL` —— §1.3。
* `'S11'`（Offer，`in_v1_scope = false`）—— 它在目录里。`in_v1_scope` 是 **v1.0 产品范围**，
  不是库层存在性；0007 不把它变成禁令。若产品要"v1.0 只允许 S1–S10"，那是一条
  **另外的**约束（例如对 `stage_catalog.in_v1_scope` 的 CHECK），不在本批授权内。

### 1.5 负向证据（`verify-0007.sql`）

| 用例 | 路径 | SQLSTATE | 实际消息 |
|---|---|---|---|
| `BANANA` | INSERT | `23503` | 违反外键 `fk_decision_stage_catalog` |
| `SCREENING` | INSERT | `23503` | 同上 |
| `INTERVIEW` | INSERT | `23503` | 同上 |
| `SX1`（只在**乙**租户目录） | INSERT | `23503` | 同上 |
| 改已有决策的 `stage_code` | UPDATE | `23514` | `IMMUTABLE_COLUMN`（`trg_decision_immutable` 先挡：decision 的列本就不可变） |
| 改被引用键 `stage_catalog.code`（S10 被决策引用） | UPDATE | `23503` | `ON UPDATE RESTRICT` 挡下 —— 证明 FK 在 UPDATE 路径活着 |

> 说明：`decision` 的 UPDATE 路径被更早的不可变护栏关死，所以"把 stage_code 改成非法值"
> 在 0007 之前也改不动（会 `23514`）。GAP-A 的真实入口是 **INSERT**；UPDATE 侧由
> 被引用键的 `RESTRICT` + 不可变护栏双重覆盖。

---

## 2. GAP-B · "当前决策"唯一性

### 2.1 改造前（实测）

同一 `(tenant, application, decision_scope, stage_code)` 可以同时有两条 current 行：

```sql
-- exit=0，落库 2 行
insert into recruitment.decision (tenant_id, application_id, decision_scope, stage_code,
                                  result, decided_by_actor_id, reason) values
  ('…0001','…0701','FINAL',null,'REJECT','…0102','first'),
  ('…0001','…0701','FINAL',null,'HIRED','…0102','second');
```

改造前 `decision` 上**没有任何**能表达 current 唯一性的唯一约束/索引（0 个）。
两条互相矛盾的 FINAL（REJECT + HIRED）可以并存，库一声不吭。

### 2.2 改法（部分唯一索引 + 处理 NULL）

```sql
create unique index uq_decision_current
  on recruitment.decision (tenant_id, application_id, decision_scope, stage_code)
  nulls not distinct
  where superseded_by_decision_id is null;
```

**为什么用 `NULLS NOT DISTINCT` 而不是 `coalesce(stage_code, '')`**（二选一，这里选前者）：

1. 问题本身是"两个 NULL 在这个索引里必须算相等"，`NULLS NOT DISTINCT`（PG15+）就是这句话的
   原生写法，不需要哨兵值。
2. `coalesce(...,'')` 是**编造一个阶段码**：`''` 不在目录里（正则也不允许），它只活在索引
   表达式里；`pg_indexes`、`\d`、以后的迁移结构断言都得多记一条"`''` 等于没有阶段"的暗规则。
3. 本机是 PG 17.11，`indnullsnotdistinct` 可直接在 `pg_index` 里断言（`verify-0007.sql` S-3）。

代价：**部分唯一约束**在 PG 里不存在，所以它只能是唯一**索引**，不在 `pg_constraint` 里
（结构断言走 `pg_index`）。另外 `NULLS NOT DISTINCT` 不能与 `WHERE` 以外的表达式索引组合使用
—— 这里不需要。

### 2.3 必须知道的行为后果：**"替换一条当前决策"不能再按老顺序做**

唯一索引是**立即**生效的，`fk_decision_superseded_by` 也是立即的。于是同一个
`(scope, stage_code)` 的"替换"两条路都撞墙（实测）：

| 顺序 | 操作 | SQLSTATE |
|---|---|---|
| 先插新行 | `insert ... 同键 current` | `23505` 重复键（`uq_decision_current`） |
| 先回填旧行 | `update 旧行 set superseded_by_decision_id = 新行id`（新行还不存在） | `23503` 违反 `fk_decision_superseded_by` |

也就是说：**同一 (scope, stage_code) 的决策只能"追加历史/换 key"，不能"先插后改"完成替换**。
这不是 0007 漏了什么，而是"立即部分唯一索引"这一形态的固有代价。可行的三条路：

1. 业务上把"替换"改成**另一个 stage_code / 另一个 scope**（键不同 → 不冲突）；或
2. 需要单事务内先插后改的，把唯一性改成 **`DEFERRABLE INITIALLY DEFERRED` 的排斥约束**
   （`EXCLUDE USING btree (...) WHERE (...)`，PG 支持 deferrable 的排斥约束）——
   这**不在本批授权内**，留给总控裁决；或
3. 业务接受"先让旧行失效、再插新行"的两阶段（旧行先指向……不可行，见上）。

> 结论：如果应用层已经实现了"insert 新决策 → update 旧决策.superseded_by"的替换流程，
> 0007 合入后它会立刻开始报 `23505`。这是**预期**的行为改动，但必须在合入前对齐顺序。

### 2.4 这个键**没有**覆盖的情形（残留，需知）

索引键包含 `stage_code`，所以**同一条申请的两条 FINAL 决策，只要 `stage_code` 不同
（例如 `FINAL/S10` 与 `FINAL/NULL`），仍然可以同时 current**。若产品语义是
"每个申请最多一条 current FINAL"，还需要一条额外的部分唯一索引
`(tenant_id, application_id) WHERE decision_scope = 'FINAL' AND superseded_by_decision_id IS NULL`。
**本批没有加**：任务书给的是四列键，加第二把锁属于扩大授权范围。`verify-0007.sql`
把它列为"未覆盖"，不做断言。

### 2.5 负向证据

| 用例 | 路径 | SQLSTATE |
|---|---|---|
| 第二条 current `FINAL` + `stage_code IS NULL` | INSERT | `23505`（`NULLS NOT DISTINCT` 生效） |
| 第二条 current `STAGE/S10` | INSERT | `23505` |
| 把 superseded 行改回 current | UPDATE | `23505` |

---

## 3. GAP-C · 面评的评分标准必须属于"这个申请的那个岗位"

### 3.1 改造前（实测）

`fk_scorecard_rubric` 只保证 `rubric_version_id` 存在且同租户。于是 A 岗位的面试
可以用 B 岗位的评分标准交面评：

```sql
-- 面试属于岗位一；rubric 属于岗位二；exit=0
insert into recruitment.scorecard (tenant_id, interview_id, interviewer_id, rubric_version_id,
                                   items, overall)
values ('…0001','…(岗位一的面试)','…(面试官)','…(岗位二的 rubric)','[]','POOR');
-- 读回：rubric_job = 岗位二，application_job = 岗位一，jobs_differ = t
```

### 3.2 为什么选 (a) 而不是纯触发器

采用任务书倾向的 **(a)**：加列 + 复合外键 + 触发器。

| | (a) 加列 + 复合外键 + 触发器 | (b) 纯触发器 |
|---|---|---|
| `rubric` 属于 `job_id` | **外键**（不能 disable） | 触发器（可 disable） |
| `job_id` 属于该申请 | 触发器 | 触发器 |
| 存量行 | 需要回填（可唯一推出） | 不需要 |
| 写入方改动 | 不写 `job_id` 也能工作（触发器推导） | 无 |

选 (a) 的核心理由：外键把"rubric 属于这个 job"变成物理事实；触发器只负责把
"这个 job 属于这个申请"补齐。纯触发器一旦被 `DISABLE TRIGGER` 或 bulk load 绕过，
库里仍会留下跨岗位面评，而外键不会。

### 3.3 回填：只回填**能唯一推出**的值，且只有一处数据写入

```sql
-- 唯一推导链：scorecard.interview_id → interview.application_id → application.job_id
-- 两段都是 NOT NULL 外键，所以每一行的 job_id 没有第二种可能。
update recruitment.scorecard s
   set job_id = d.job_id
  from (select sc.id as scorecard_id, a.job_id
          from recruitment.scorecard sc
          join recruitment.interview i   on i.id  = sc.interview_id and i.tenant_id = sc.tenant_id
          join recruitment.application a on a.id  = i.application_id and a.tenant_id = i.tenant_id
         where sc.job_id is null) d
 where d.scorecard_id = s.id;
```

* 只填 `job_id IS NULL` 的行；**已经有值且与推导值不一致 → 报错，不覆盖**。
* **不设默认值**（`job_id` 没有 `DEFAULT`）。触发器在"没写"时填充，是推导，不是默认。
* 回填是一次真实 `UPDATE`：PENDING 行的 `record_version` 会被 0001 的
  `trg_scorecard_guard_status` 自增 1、`updated_at = now()`。这是该触发器对**所有**
  UPDATE 的固有行为；0007 **不 disable 护栏**来假装"什么都没发生"。
  实测（模板库 + 一条 PENDING 面评）：`job_id` 被填成岗位一，`record_version 1 → 2`。
* 终态行（`SUBMITTED` / `WAIVED`）缺 `job_id` 时会撞 `fn_scorecard_guard`
  （`SCORECARD_IMMUTABLE`）。0007 **不 disable** 那条"评价不可覆盖"护栏，直接
  `raise` + 整笔回滚，把"要不要动已提交面评"交给人 —— 运维步骤见 §7。

### 3.4 改造后的三道锁

```text
scorecard.job_id  ──(触发器：= interview→application.job_id)──> 岗位
       │
       └──(复合外键 (tenant_id, job_id, rubric_version_id)
             → rubric_version (tenant_id, job_id, id))──> rubric 必须属于同一个岗位、同一个租户
```

* `scorecard.job_id`：`uuid NOT NULL`，**无默认值**。
* `fk_scorecard_rubric_job`：`(tenant_id, job_id, rubric_version_id) → rubric_version(tenant_id, job_id, id)`，
  `on update/delete restrict`；被引用键复用 0004 的 `uq_rubric_version_tenant_job_id`。
* `trg_scorecard_job_guard`：`before insert or update` → `fn_scorecard_job_guard()`；
  `job_id IS NULL` 时**填充**推导值，显式给了不一致的值 → `23514`。

### 3.5 负向证据

| 用例 | 路径 | SQLSTATE | 实际消息 |
|---|---|---|---|
| 用岗位二的 rubric 给岗位一面试交面评（不写 job_id） | INSERT | `23503` | 违反 `fk_scorecard_rubric_job` |
| 显式写 `job_id = 岗位二` | INSERT | `23514` | `SCORECARD_JOB_MISMATCH` |
| PENDING 面评换 rubric（换成岗位二的） | UPDATE | `23503` | 违反 `fk_scorecard_rubric_job` |
| PENDING 面评改 `job_id`（改成岗位二） | UPDATE | `23514` | `SCORECARD_JOB_MISMATCH` |

### 3.6 残留风险

* 触发器可被 `ALTER TABLE … DISABLE TRIGGER` 关掉；关掉后"显式写错 job_id"不会被拦，
  但 `job_id` 仍必须写（`NOT NULL`），且 rubric 必须属于该 `job_id`（外键）。
  也就是说最坏情况下只剩"job_id 与申请岗位不一致"这一种脏数据，而不是"任意跨岗位"。
* `interview_record.rubric_version_id` 有同类问题（记录用的 rubric 是否等于申请岗位的 rubric），
  本批**未覆盖**（任务书只点名 `scorecard`）。

---

## 4. GAP-D · `ai_summary` 的转写引用必须同租户

### 4.1 改造前（实测）

```text
fk_ai_summary_artifact = FOREIGN KEY (transcript_artifact_id, transcript_revision)
                         REFERENCES transcript_artifact(id, source_revision)
```

两列不含 `tenant_id` → 甲租户的 `ai_summary` 可以引用乙租户的 `transcript_artifact`，
只要 revision 对得上。实测：`exit=0`，读回 `artifact_tenant = 乙`、`summary_tenant = 甲`。
它也是全库**唯一一条**"多列外键却不含 `tenant_id`"（0006 已把 `interview_record` 的同型外键修好）。

### 4.2 改法（三道闸，同 0005 §4 / 0006 §3.4）

```sql
-- 闸 1：先建新键（临时名 fk_ai_summary_artifact_0007）
alter table recruitment.ai_summary add constraint fk_ai_summary_artifact_0007
  foreign key (tenant_id, transcript_artifact_id, transcript_revision)
  references recruitment.transcript_artifact (tenant_id, id, source_revision)
  on update restrict on delete restrict;
-- 闸 2：验 convalidated（不是 NOT VALID）
-- 闸 3：drop 旧 2 列键 → rename 新键回正式名 fk_ai_summary_artifact
```

被引用键直接复用 0006 的 `uq_transcript_artifact_tenant_id_revision
UNIQUE (tenant_id, id, source_revision)`。

### 4.3 负向证据

| 用例 | 路径 | SQLSTATE |
|---|---|---|
| 甲租户摘要引用乙租户转写 | INSERT | `23503` |
| 同租户但 revision 对不上（声称 2，实际 1） | INSERT | `23503` |
| 把已有摘要改指向乙租户转写 | UPDATE | `23514`（`trg_ai_summary_immutable` 先挡：引用列本就不可变） |
| 把被引用的转写搬到另一个租户 | UPDATE | `23514`（`trg_transcript_artifact_immutable` 先挡） |

> 与 GAP-A 同型：引用两侧的列都被不可变护栏锁死，所以 UPDATE 路径由更早的护栏挡住；
> 复合外键的真实入口是 **INSERT**，UPDATE 侧由 `ON UPDATE RESTRICT` 兜底。

---

## 5. GAP-E · 直接 INSERT 终态行绕过 actor

### 5.1 scorecard 侧：**成立**（实测），本批修

改造前（实测，`exit=0`）：

```sql
insert into recruitment.scorecard (tenant_id, interview_id, interviewer_id, rubric_version_id,
                                   status, submitted_at, items)
values ('…','…','…','…','SUBMITTED', now(), '[]'::jsonb);        -- 不写 status_changed_by_actor_id
-- exit=0；读回 status_changed_by_actor_id IS NULL

insert into recruitment.scorecard (..., status, waive_reason)
values (..., 'WAIVED', '面试取消');                                -- 同样 exit=0
```

根因：`status_changed_by_actor_id` 只由 `trg_scorecard_guard_status`（`fn_row_guard`，
**BEFORE UPDATE**）管；INSERT 路径没有护栏。

改法（两道，互补）：

```sql
alter table recruitment.scorecard
  add constraint ck_scorecard_terminal_actor
  check (status = 'PENDING' or status_changed_by_actor_id is not null);
```

```text
trg_scorecard_terminal_actor_guard (BEFORE INSERT)
  └─ 终态行没写 actor 时，从 0001 的可信服务端通道 SET LOCAL recruitment.actor_id 取；
     两条路都没有 → 23514 ACTOR_REQUIRED
```

为什么两条都要：

* `CHECK` 是声明式的、**不能 disable**，对 INSERT/UPDATE 都生效 —— 这是"硬"的那半。
* 触发器沿用 0001 已有的 actor 约定（`fn_row_guard` 的 UPDATE 路径也是这么取 actor），
  让既有写入方（例如 `db/verify.sql` 的夹具，它在事务开头就 `SET LOCAL recruitment.actor_id`）
  不必因为本迁移而全挂；同时列表最终一定被填上，`CHECK` 照样成立。

负向证据：

| 用例 | 路径 | SQLSTATE |
|---|---|---|
| INSERT `SUBMITTED`，无 actor、无 session actor | INSERT | `23514`（`ACTOR_REQUIRED`，触发器；`CHECK` 是兜底） |
| INSERT `WAIVED`，无 actor、无 session actor | INSERT | `23514` |
| PENDING → SUBMITTED 不给 actor | UPDATE | `23514`（这条路径 0007 之前就有 `fn_row_guard`，不是本批新增） |

### 5.2 decision 侧：**本缺口不成立**（实测，不硬改）

任务书写"`decision` / `scorecard` 都有 `status_changed_by_actor_id` 与
`status_source_event_id` 列"。实测：

```sql
-- ① decision 没有这个列
insert into recruitment.decision (..., status_changed_by_actor_id) values (...);
-- SQLSTATE 42703：关系 "decision" 的 "status_changed_by_actor_id" 字段不存在

-- ② decision 没有 status 列、也没有 status_source_event_id；
--    它的 16 个列是：
--    id, tenant_id, application_id, interview_id, decision_scope, stage_code, result,
--    decided_by_actor_id, decided_at, reason, basis_refs, approval_id,
--    superseded_by_decision_id, record_version, created_at, updated_at

-- ③ actor 在 INSERT 上已被强制
insert into recruitment.decision (..., result, reason) values (...);
-- SQLSTATE 23502：null value in column "decided_by_actor_id" ... violates not-null constraint
```

`decision` 的每一行**本身就是终态事实**（没有状态轴），并且
`decided_by_actor_id NOT NULL` + `fk_decision_actor (decided_by_actor_id, tenant_id) → actor(id, tenant_id)`
保证 actor 一定存在、一定同租户。所以"直接 INSERT 一条已终态的行而不写 actor"在
`decision` 上不是可写状态 —— **本缺口不成立**。

本批**不**给 `decision` 新造 `status` / `status_changed_by_actor_id` 列：那会让
"决策"多出一条并不存在的状态轴，是顺着错的前提做，而且与 0001 §9.3 的
decision 不可变语义冲突。

---

## 6. 幂等 / 数据面 / 回滚

### 6.1 幂等（连续跑两遍）

第二遍**零 ERROR、零新增对象、零数据改动**。所有对象都先查
`pg_constraint` / `pg_index` / `pg_trigger` / `pg_proc` 再建，不用 `drop … if exists` 重建
（唯一例外是 GAP-D 的"先建新键 → 验 convalidated → 删旧键 → 改名"，第二遍会走
"已是 3 列形态，跳过"分支，不会再走那条路）。

实测对象数快照（`ra_v7`，0001→0007 之后，第二遍前后完全一致）：

| 对象 | 第一遍后 | 第二遍后 |
|---|---|---|
| tables | 43 | 43 |
| columns | 633 | 633 |
| constraints | 500 | 500 |
| indexes | 143 | 143 |
| triggers（非内部） | 84 | 84 |
| functions | 17 | 17 |
| `decision + scorecard + ai_summary + stage_catalog + rubric_version` 行数 | 13 | 13 |

第二遍的日志里每个对象都打印 `已存在且形态正确，跳过`。

### 6.2 数据面（迁移后全库断言，`verify-0007.sql` §6）

1. 没有 `decision.stage_code` 落在自己租户目录之外（NULL 除外）；
2. 没有重复的 current 决策（NULL `stage_code` 按相等处理）；
3. 没有 `scorecard.job_id IS NULL`；
4. 没有 rubric 不属于该申请岗位的 `scorecard`；
5. 没有跨租户的 `ai_summary → transcript_artifact`；
6. 没有终态 `scorecard` 缺 actor；
7. 全库多列外键**全部**含 `tenant_id`（0 条例外）。

### 6.3 回滚

反向 DDL 写在 `0007_decision_integrity.sql` 文件末尾的注释里。回滚 = **重新打开**这五个缺口，
不是修复；回滚 `scorecard.job_id` 会丢回填值。回滚前先确认没有代码依赖这五条保证。

---

## 7. 运维：终态 `scorecard` 的 `job_id` 回填（一次性 SQL）

**只有在 0007 §3.2.4 报 `SCORECARD_JOB_BACKFILL_BLOCKED` 时才需要这一步。**
该报错说：库里有已是 `SUBMITTED` / `WAIVED` 的面评缺 `job_id`，而 0007 拒绝 disable
`fn_scorecard_guard`（"评价不可覆盖"）去绕开它。

先看清是哪几行：

```sql
select s.id, s.status, s.interview_id, i.application_id, a.job_id as derived_job_id
  from recruitment.scorecard s
  join recruitment.interview i   on i.id = s.interview_id and i.tenant_id = s.tenant_id
  join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
 where s.job_id is null;   -- 首跑失败时这一列可能还不存在，先按 §3.2.4 的报错清单核对 id
```

**逐行确认"这些面评确实只是缺一个可从申请唯一推出的岗位"之后**，在一个事务里执行：

```sql
begin;
-- 首跑失败会整笔回滚，所以 job_id 列要在这里补上（0007 首次执行时还没走到 add column）
alter table recruitment.scorecard add column if not exists job_id uuid;

-- 只在这一次 UPDATE 期间关掉两条护栏：目的是不让"补派生列"被当成"改评价内容"，
-- 并且不触碰 record_version / updated_at。事务提交前必须恢复。
alter table recruitment.scorecard disable trigger trg_scorecard_guard_status;
alter table recruitment.scorecard disable trigger trg_scorecard_submitted_guard;

update recruitment.scorecard s
   set job_id = d.job_id
  from (select sc.id as scorecard_id, a.job_id
          from recruitment.scorecard sc
          join recruitment.interview i   on i.id = sc.interview_id and i.tenant_id = sc.tenant_id
          join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
         where sc.job_id is null) d
 where d.scorecard_id = s.id;

alter table recruitment.scorecard enable trigger trg_scorecard_guard_status;
alter table recruitment.scorecard enable trigger trg_scorecard_submitted_guard;
commit;
```

然后重跑 0007。它会看到 `job_id` 已无 NULL，直接进入 `set not null`。

> ⚠️ 这是唯一一处允许 disable 护栏的地方，而且必须由人执行、人负责。
> 0007 自己不这么做 —— 迁移替人决定"已提交面评可以改"，正是本项目反模式清单里的
> "把写错了变成看不出来写错过了"。

---

## 8. 本批**没有**覆盖的（残留风险，按重要性排）

| # | 残留 | 影响 | 建议 |
|---|---|---|---|
| 1 | 同一 `(scope, stage_code)` 的"替换"顺序被两把立即约束夹死（§2.3） | 应用层若按"先插新行再回填 superseded_by"实现，会开始 `23505` | 合入前对齐写入顺序；或由总控裁决改成 deferrable exclusion constraint |
| 2 | 四列键允许 `FINAL/S10` 与 `FINAL/NULL` 同时 current（§2.4） | "每个申请最多一条 current FINAL"仍未强制 | 另立 `(tenant, application) WHERE scope='FINAL'` 的部分唯一索引（需授权） |
| 3 | `interview_record.rubric_version_id` 未绑定到申请岗位 | 与 GAP-C 同型，但不在本批点名范围 | 另开一段，复用 0007 的 `job_id` 模式 |
| 4 | `decision` 的 supersede 环（A→B、B→A）没有被禁止 | 可能出现"零条 current" | 现有 `ck_decision_self_supersede` 只挡自指；可在应用层或未来迁移加环检测 |
| 5 | `scorecard.job_id` 的填充依赖触发器 | 关掉触发器后仍需显式写（`NOT NULL` 兜底），但"job_id 与申请不一致"这一种脏数据可能回来 | 把 `ALTER TABLE ... DISABLE TRIGGER` 纳入审计；或改成应用层必写 + 去掉填充（会破坏既有写入方） |
| 6 | `verify-0007.sql` 的负向用例 D-03/D-04、A-05 打在**更早的**不可变护栏上 | 它们证明的是"UPDATE 路径进不到 FK"，不是"FK 在 UPDATE 上拒绝" | A-06 用被引用键的 `ON UPDATE RESTRICT` 补了 FK 在 UPDATE 路径的证据；D 侧没有等价写法（两侧列都不可变） |

---

## 9. 自检与验收

```bash
# 1) 全新库 + 迁移链
psql -c "drop database if exists ra_v7;" -c "create database ra_v7;"
for f in 0001_init 0002_seed 0003_review_queue 0004_stage_catalog \
         0005_version_binding 0006_integrity_gaps 0007_decision_integrity; do
  psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/migrations/$f.sql || exit 1
done
# 2) 幂等：再跑一遍 0007
psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/migrations/0007_decision_integrity.sql
# 3) 自检（顺序不能变）
psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/verify-0007.sql
psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/verify-0006.sql
psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/verify-0005.sql
psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/verify-0004.sql
psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/verify-0003.sql
psql -v ON_ERROR_STOP=1 -d ra_v7 -f db/verify.sql
```

`verify-0007.sql` 覆盖：

* **11 条结构断言**：`fk_decision_stage_catalog` / `uq_decision_current`（unique + nulls not distinct +
  谓词）/ `scorecard.job_id`（uuid / NOT NULL / 无默认）/ `fk_scorecard_rubric_job` + 被引用键 /
  `trg_scorecard_job_guard` / `fn_scorecard_job_guard` / `fk_ai_summary_artifact`（3 列）+
  被引用键 / `ck_scorecard_terminal_actor` / `trg_scorecard_terminal_actor_guard`，
  外加两条"无后门"断言（不含 `tenant_id` 的第二条外键）。
* **11 条正向**：合法阶段码、NULL 阶段、不同 scope 并存、superseded 形态、不写 `job_id` 的推导、
  显式正确 `job_id`、同租户摘要、显式 actor 的 SUBMITTED、session actor 的 WAIVED、
  PENDING 不要求 actor。
* **22 条负向**：A:6 / B:3 / C:4 / D:4 / E:5；每条打印数据库**真实**返回的 SQLSTATE 与消息。
* **7 条数据面**：见 §6.2。

---

## 10. 需要总控裁决的三件事

1. **替换顺序**（§2.3）：保持立即部分唯一索引 + 改应用层写入顺序，还是改成
   `DEFERRABLE INITIALLY DEFERRED` 的排斥约束？
2. **FINAL 唯一性**（§2.4）：要不要再加一条 `(tenant, application) WHERE scope='FINAL'` 的部分唯一索引？
3. **`interview_record.rubric_version_id`**（§8 第 3 条）：是否在同一批补上 GAP-C 的同型绑定？

> 另：`db/verify.sql` 的夹具在 0007 之后必须用目录内的 `stage_code`。
> 那一行已经从 `'INTERVIEW'` 改成 `'S8'`（1 行），并已随 0007 的提交一起入库；
> 该文件不在 0007 的写范围内。
