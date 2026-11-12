# DECISION-UNIQUENESS · 0008 决策唯一性改成可延迟 + FINAL 闭合

> **一句话**：0007 的 `uq_decision_current` 是**部分唯一索引**，它把契约规定的重评事务
> （先插新 current、再把旧行指向新行）**夹死在同一个事务里**；而且键里含 `stage_code`，
> `FINAL/S10` 与 `FINAL/NULL` 仍能同时 current。0008 把这两个不变量改写成
> **可延迟（`DEFERRABLE INITIALLY DEFERRED`）排斥约束**，并顺手补上 `interview_record`
> 与 `scorecard` 同型的"rubric 必须属于该申请岗位"缺口。
>
> **一句话的边界**：0008 只换/加约束与一列，不改 0001–0007 的业务语义；
> 第一个也是唯一的数据写入是 `interview_record.job_id` 的**派生回填**。
> 残留（SQLSTATE 从 23505 变 23P01、契约文档要跟着改）写在 §8，**没有"已修复"这种说法**。

---

## 0. 文件、运行方式、依赖

| 文件 | 作用 |
|---|---|
| `db/migrations/0008_decision_uniqueness.sql` | 三段迁移（单事务；先检查再改；幂等） |
| `db/verify-0008.sql` | 自检：7 结构 + 4 正向 + 4 负向 + 5 数据面；结尾 `ROLLBACK`、最后一行 `VERIFY-0008 PASS` |
| `db/DECISION-UNIQUENESS.md` | 本文件：裁定、代价、实测证据、残留、回滚 |
| `db/verify-0007.sql` | **只改断言方式**（3 处，见 §7）：把"`uq_decision_current` 是某种索引"改成"当前唯一性不变量成立"，并让 B-01..B-03 接受 23505 或 23P01 |

```bash
# 迁移（自带 begin/commit，不要加 -1）
psql -v ON_ERROR_STOP=1 -d ra_v8 -f db/migrations/0008_decision_uniqueness.sql
# 自检（必须是 psql：文件里有 \echo）
psql -v ON_ERROR_STOP=1 -d ra_v8 -f db/verify-0008.sql
```

**依赖**（§0 的依赖检查会在缺任何一项时 `raise` 42P01）：

* `0001`：`decision` / `interview_record` / `interview` / `application` / `rubric_version` / `actor`；
* `0004`：`rubric_version` 的 unique `(tenant_id, job_id, id)`（`uq_rubric_version_tenant_job_id`）；
* `0007`：`fk_scorecard_rubric_job`（0008 的 C 段与它同型；0007 是必需前置）。

**0008 动到的对象**（全部在 `recruitment` schema）：

| 对象 | 动作 |
|---|---|
| `decision.uq_decision_current` | 部分唯一索引 → **可延迟排斥约束**（同名；旧索引在同一事务里先验后删） |
| `decision.uq_decision_current_final` | 新增可延迟排斥约束（每个申请最多一条 current FINAL） |
| `interview_record.job_id` | 新增列（uuid、NOT NULL、无默认值） |
| `interview_record.fk_interview_record_rubric_job` | 新增 3 列复合外键 |
| `interview_record.trg_interview_record_job_guard` + `fn_interview_record_job_guard` | 新增触发器/函数（缺省填充 + 拒绝不一致） |

---

## 1. 两个问题（都是实测，不是推测）

实测环境：PostgreSQL **17.11**（Windows, `x86_64`），`ra_v8` = `0001 → 0007`（应用 0008 之前）。
契约原文：`dsh/dsh-recruitment/contracts/job-screening/job-rubric-rules.md:159-163`。

### 1.1 问题 ①（阻断级）· 部分唯一索引把重评事务夹死

0007 建的是（`0008 §0` 的日志原文）：

```
uq_decision_current(unique=t nulls_not_distinct=t exclusion=f
                    pred=(superseded_by_decision_id IS NULL))
```

它**在每条语句结束时立即检查**。契约 §5.2 的重评事务在同一事务里必须做两件事：
先 `INSERT` 新 current，再 `UPDATE` 旧行 `superseded_by_decision_id = 新行 id`。
实测两条顺序都不通：

```
### 顺序 1（契约原文：先 INSERT 新 current，再 UPDATE 旧行）
INSERT 新 current → 23505：重复键违反唯一约束"uq_decision_current"
  键值"(tenant_id, application_id, decision_scope, stage_code)=
        (…0001, …0701, SCREENING, null)" 已经存在
→ 事务被终止，剩下的 UPDATE 被忽略（25P02），ROLLBACK

### 顺序 2（反过来：先 UPDATE 旧行指向新行）
UPDATE 旧行 → 23503：违反外键约束 "fk_decision_superseded_by"
  键值对(superseded_by_decision_id)=(…d03) 没有在表 "decision" 中出现
（0001:1351-1352 的 `fk_decision_superseded_by` 是立即校验，新行还不存在）
→ ROLLBACK
```

**根因**：唯一性检查发生在"两条 current 并存的中间态"，而重评的本质就是
"中间态合法、终态唯一"。这不是实现写错，是**约束的检查时机选错了**。

### 1.2 问题 ② · 键里含 `stage_code`，`FINAL/S10` + `FINAL/NULL` 能同时 current

0007 的键是 `(tenant_id, application_id, decision_scope, stage_code)`。
`stage_code` 不同 = 键不同，所以：

```
BEGIN;
INSERT decision(FINAL, 'S10', 'HIRED');
INSERT decision(FINAL, NULL , 'REJECT');
COMMIT;   -- 实测结果：INSERT 0 2 / COMMIT（成功）
```

这正是最该防的场景（同一个申请有两条互相矛盾的最终决策），0007 挡不住。
`0008 §0` 的改造前快照里 `每个申请有 >1 条 current FINAL 的组数 = 0` 只是因为
**干净库**；有数据时就会是 1（§6.4 的脏数据实测正是这个形状）。

### 1.3 同型缺口 C **成立**（先核实，不硬造）

任务要求先确认 `interview_record` 有没有 `rubric_version_id`。实测有：

```
0001_init.sql:1188   rubric_version_id uuid not null,
0001_init.sql:1211   constraint fk_interview_record_rubric foreign key (rubric_version_id, tenant_id)
                       references recruitment.rubric_version (id, tenant_id),
```

也就是说：它只保证"这个 rubric 存在且同租户"，**不保证是该申请的那个岗位**。
与 0007 的 GAP-C 完全同型 —— 所以 C 段成立，按 0007 §3 的同一做法补。

---

## 2. 改法 A · 把"当前唯一"改成可延迟排斥约束

### 2.1 最终形态

```sql
alter table recruitment.decision
  add constraint uq_decision_current
  exclude using btree (
    tenant_id      with =,
    application_id with =,
    decision_scope with =,
    (coalesce(stage_code, '')) with =
  )
  where (superseded_by_decision_id is null)
  deferrable initially deferred;
```

`pg_get_constraintdef` 实测原文：

```
EXCLUDE USING btree (tenant_id WITH =, application_id WITH =, decision_scope WITH =,
                     COALESCE(stage_code, ''::text) WITH =)
WHERE ((superseded_by_decision_id IS NULL))
DEFERRABLE INITIALLY DEFERRED
```

### 2.2 为什么**必须**是 `EXCLUDE`（而不是继续用唯一索引/唯一约束）

| 想要的性质 | 唯一索引 | 可延迟 UNIQUE 约束 | EXCLUDE 约束 |
|---|---|---|---|
| 只约束 current 行（partial） | ✅ | ❌ **表约束不支持 WHERE** | ✅ `WHERE` |
| 推迟到 COMMIT 才检查（deferrable） | ❌ **索引没有 DEFERRABLE** | ✅ | ✅ |
| 两个 NULL 按相等（等价 `NULLS NOT DISTINCT`） | ✅（`NULLS NOT DISTINCT`） | ✅（同） | 需表达式（见 §2.3） |

三个要求里，**`partial` + `deferrable` 的交集在 PostgreSQL 里只有 `EXCLUDE`**：

* `CREATE UNIQUE INDEX ... WHERE ...` 能做 partial，但索引永远立即校验；
* `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (...)` 能 deferrable，但**不能带 WHERE**；
* `EXCLUDE` 是唯一同时支持 `WHERE` 与 `DEFERRABLE INITIALLY DEFERRED` 的约束形态
  （`CREATE TABLE` 文档：`DEFERRABLE` 适用于 UNIQUE / PRIMARY KEY / EXCLUDE / REFERENCES）。

### 2.3 为什么是 `coalesce(stage_code, '')` 而不是 `NULLS NOT DISTINCT`

* `NULLS NOT DISTINCT` 是**唯一索引/唯一约束**的关键字，`EXCLUDE` **语法上不接受**它；
* 排斥约束的判等走 btree 的 `=`，而 SQL 的 `=` 对 NULL 返回 NULL（不是 true）
  → 两行 `(SCREENING, NULL)` 默认**不冲突**，等于把 0007 的语义弄丢；
* 所以把 NULL 映射成一个哨兵再比较：`coalesce(stage_code, '')`。
  **空串安全**：`ck_decision_stage_code` 要求
  `stage_code is null or stage_code ~ '^[A-Z][A-Z0-9_]{1,40}$'`（至少 2 字符、首字符大写字母），
  所以没有任何合法 `stage_code` 会等于 `''`；
  NULL↔NULL 撞、NULL↔任何真实值不撞 —— 与 `NULLS NOT DISTINCT` 的语义**逐行等价**。
  （也可以用 `coalesce(stage_code, '<NULL>')` 之类哨兵；空串更短，且被 CHECK 保证不可达。）

### 2.4 等价性论证（为什么不是"语义变了"）

对任意两行 `r1, r2`（都满足 `superseded_by_decision_id IS NULL`），
"键相等"在 0007 下是
`tenant/application/scope 相等 AND (stage_code 相等 OR 两者皆 NULL)`；
在 0008 下是 `tenant/application/scope 相等 AND coalesce(stage,'') 相等`。
由 §2.3 的"空串不可达"，后者 ⇔ 前者。**只在 current 行上比较**这一点两者也一致
（谓词都在 `WHERE superseded_by_decision_id IS NULL` 上）。
所以 A 没有改变"哪些行算冲突"，只改变了"什么时候检查"。

### 2.5 对象替换顺序（同一事务；先验证新约束就绪，再删旧索引）

`uq_decision_current` 是 0007 的索引名，想复用这个符号名，做法是四步：

1. 用**临时名** `uq_decision_current_0008` 建排斥约束；
2. 验证临时约束 `contype='x' / condeferrable / condeferred / convalidated` 且定义含
   `coalesce(stage_code` / `superseded_by_decision_id is null` / `deferrable initially deferred`；
3. **先验证**旧索引确实是 0007 的目标形态（`indisunique + indnullsnotdistinct + 谓词 + 四列`），
   再 `drop index recruitment.uq_decision_current`（不是 `drop ... if exists` 蒙混；
   形态不对就 `raise` 拒绝删别人的对象）；
4. `alter table ... rename constraint uq_decision_current_0008 to uq_decision_current`
   （改名同时改 backing index 的名）。

事务内任何时刻都有保护对象：旧索引删之前新约束已就绪，删之后排斥约束接管。
第二遍走"已是目标形态，跳过"分支，**不 DDL**。

### 2.6 改后的行为（目标达成）

同一个事务里（实测，`ra_v8` = 0001→0008）：

```sql
BEGIN;
  -- 契约 §5.2 原样：先 INSERT 新 current（旧行还是 current！）
  INSERT INTO decision(... decision_scope='SCREENING', superseded_by_decision_id=NULL);
  -- → INSERT 0 1（没有 23505；这就是 DEFERRABLE）
  UPDATE  decision SET superseded_by_decision_id = $new WHERE id = $old;
  -- → UPDATE 1（新行已存在，没有 23503）
COMMIT;
-- → COMMIT（成功）
```

而"COMMIT 时仍有两条 current"→ **23P01**（排斥约束冲突），实测：

```
错误:  23P01: 互相冲突的键值违反排他约束"uq_decision_current"
描述:  键(tenant_id, application_id, decision_scope, COALESCE(stage_code, ''::text))=(…, SCREENING, )
       与已存在的键(…, SCREENING, )冲突
```

**SQLSTATE 变了**：0007 是 `23505`，0008 是 `23P01`。这不是退步，是"延迟到提交"的必然
（排斥约束的冲突报 23P01）。**残留与影响面写在 §8.1。**

---

## 3. 改法 B · 每个申请最多一条 current FINAL

```sql
alter table recruitment.decision
  add constraint uq_decision_current_final
  exclude using btree (tenant_id with =, application_id with =)
  where (decision_scope = 'FINAL' and superseded_by_decision_id is null)
  deferrable initially deferred;
```

* 同样是 `EXCLUDE`：`partial`（只要 current FINAL）+ `deferrable`，理由同 §2.2；
* 键只有 `(tenant_id, application_id)`，**故意不含 `stage_code`** —— 这正是问题 ② 的修法：
  FINAL/S10 与 FINAL/NULL 现在撞同一个键；
* **它不会把合法的 FINAL 重评拦死**：重评时"先插新 FINAL、再让旧 FINAL 指向新行"的
  中间态有两条 current FINAL，但 COMMIT 前就修好了 → 合法（实测见 §6.2 的 P-2）。

---

## 4. 改法 C · `interview_record` 的 rubric 必须属于该申请的岗位

### 4.1 选型与代价（任务要求在两种做法里选一个并说明）

**选 (a)：加 `job_id` + 复合外键 + 缺省填充触发器**（与 0007 §3 同一做法）。

| | (a) 复合外键 + 触发器（选中） | (b) 纯触发器 |
|---|---|---|
| 跨岗位 rubric 能否落库 | **不能**（外键是硬的，不能 disable） | 触发器被 disable / bulk load 绕过时可以 |
| rubric 的 job 被改 | **被 FK 的 ON UPDATE RESTRICT 挡住** | 已有行会静默变成跨岗位，直到下次 DML |
| 代价 | 多一份派生副本 `job_id`；`application.job_id` 目前可变，改了它副本会变旧 | 无副本；但保证是"软的" |
| 与 0007 的一致性 | 同型缺口同型修法，运维/审计只需理解一套 | 两套 |

0007 §3 的原文理由是"复合外键把'rubric 属于 job_id'变成物理事实；触发器只负责把
'job_id 属于这个申请'补齐"——同一缺口用同一形状，比在两张表上采用两种强度更可审计。

### 4.2 实现（与 0007 §3 逐段对应）

1. `interview_record.job_id uuid`（先可空加列，回填后 `set not null`；**无默认值**）；
2. 回填：只填 `job_id IS NULL` 的行，值只来自
   `interview.application_id → application.job_id`（两段都是 NOT NULL 外键，唯一推导）；
   已有 `job_id` 且与推导值不一致 → `raise`，**不覆盖**；
3. `fk_interview_record_rubric_job (tenant_id, job_id, rubric_version_id) →
   rubric_version (tenant_id, job_id, id)`，复用 0004 的 `uq_rubric_version_tenant_job_id`；
4. `fn_interview_record_job_guard`（BEFORE INSERT OR UPDATE，逐行）：
   `job_id IS NULL` → 填推导值；显式给了不一致的值 → `23514`
   （与 0007 的 `fn_scorecard_job_guard` 同构）。

### 4.3 回填的代价（实测）

在 `ra_bk`（0001→0007 + 一条 `record_version=1` 的 `interview_record`）上跑 0008：

```
0008 GAP-C 回填 interview_record.job_id：1 行（唯一推导 interview → application.job_id；
     这些行的 record_version 被 trg_interview_record_guard_status 自增 1）
回填后： record_version = 2，job_id = 1111…0401
第二遍： 无需回填（0 行），record_version 仍为 2
```

即：**存量行会被真实 UPDATE 一次**（0001 的 `fn_row_guard` 对所有 UPDATE 的固有行为：
`record_version + 1`、`updated_at = now()`）。0008 **不 disable** 任何护栏来假装"什么都没发生"。
终态行没有额外护栏问题（`interview_record` 不像 `scorecard` 有"提交即冻结"的专用触发器）。

---

## 5. 幂等 / 对象数 / 数据改动

### 5.1 对象数快照（`ra_v7chk`=0001→0007 与 `ra_v8`=0001→0008；同一查询）

| 对象 | 0007 之后 | 0008 之后 | 第二遍 0008 之后 |
|---|---|---|---|
| tables | 43 | 43 | 43 |
| columns | 633 | **634**（+`interview_record.job_id`） | 634 |
| constraints | 500 | **503**（`+`A 的排斥约束、B、C 外键；0007 的索引不是约束） | 503 |
| indexes | 143 | **144**（旧唯一索引被排斥索引替换 + B 的索引） | 144 |
| triggers（非内部） | 84 | **85** | 85 |
| functions | 17 | **18** | 18 |
| `decision` / `interview_record` 行数 | 0 / 0 | 0 / 0 | 0 / 0 |

第二遍的日志里每个对象都是"已存在且形态正确，跳过"，`0` 条 ERROR（实测第二条运行
`exit=0`、错误行数 0）。带数据再跑第三遍（`ra_v8` 已有合同事务写入的 2 条 decision）：
`decision` 行指纹 `md5` 前后一致（`e5c29c7f…`），**零数据改动**。

### 5.2 唯一的 DDL 例外

`create or replace function recruitment.fn_interview_record_job_guard()` 在第二遍仍会执行
（与 0007 §3.8 的写法一致）。它**不新增对象**（`pg_proc` 计数不变），只是把同一函数体再写一次；
对象数快照已证明 `functions = 18` 两遍相同。

### 5.3 数据改动

* 唯一的数据写入：GAP-C 的**派生回填**（只填空值；干净库 0 行）；
* 不替人作废决策、不替人换 rubric、不设默认值、不 disable 护栏。

---

## 6. `verify-0008.sql` 覆盖什么

### 6.1 §1 结构断言（7 条）

| # | 断言 |
|---|---|
| S-1 | `uq_decision_current` 是 `EXCLUDE`、`condeferrable`/`condeferred`/`convalidated` 全 `t`、键含 `coalesce(stage_code`、谓词是"未取代"、backing index 同名且 `indisunique=f`/`indisexclusion=t` |
| S-2 | `uq_decision_current_final` 同上，谓词是 `scope='FINAL'` 且未取代 |
| S-3 | **旧对象已不存在**：decision 上 0 个 `unique + nulls not distinct + 该谓词` 的索引；名叫 `uq_decision_current` 的索引关系恰好 1 个 |
| S-4 | `interview_record.job_id`：uuid / NOT NULL / 无默认值 |
| S-5 | `fk_interview_record_rubric_job` 3 列 + 被引用键在位 |
| S-6 | 触发器（BEFORE INSERT OR UPDATE，逐行）+ 函数在位 |
| S-7 | decision 上恰好 2 个排斥约束（没有第三个残留） |

### 6.2 §4 正向（4 条）

* **P-1 = 本迁移存在的理由**：契约 §5.2 的两步重评在**同一事务内**成功。
  脚本里先 INSERT 新 current（此时旧行还是 current）、再 UPDATE 旧行，
  两条都成功；随后 `SET CONSTRAINTS ALL IMMEDIATE`（**等价于 COMMIT 时的检查**）通过
  —— 证明"延迟"没有放过任何一条。
* P-2：FINAL 重评（`FINAL/NULL → FINAL/S10`）同样两步成功，且终态每个申请仍只有一条 current FINAL。
* P-3/P-4：不写 `job_id` 由触发器推导为申请岗位；显式写**正确**的 `job_id` 可以落库
  （不是"只允许 NULL"）。

### 6.3 §5 负向（4 条，逐条断言 SQLSTATE）

| # | 场景 | 实测 SQLSTATE |
|---|---|---|
| N-1 | 同一 `(application, scope, stage)` 第二条 current | `23P01`（接 `23505`） |
| N-2 | `FINAL/S10` + `FINAL/NULL` 两条 current（A 的键挡不住，必须 B 挡） | `23P01`（接 `23505`） |
| N-3 | `interview_record` 用**别的岗位**的 rubric | `23503` |
| N-4 | 显式写**别的岗位**的 `job_id` | `23514`（触发器） |

### 6.4 为什么负向是 `SET CONSTRAINTS ALL IMMEDIATE` 而不是真 COMMIT

`verify-0008.sql` 整体是一个事务、结尾 `ROLLBACK`（自检不改库），脚本内不能 COMMIT。
`SET CONSTRAINTS ALL IMMEDIATE` 触发的就是**提交时**会做的那次检查，所以语义等价。
真 COMMIT 失败的两个场景另外单独实测过（见 §6.5）。

### 6.5 真 COMMIT 的两次失败（`ra_v8`，单独 psql 调用）

```
NEG-1（同键第二条 current）：INSERT 0 1 成功 → COMMIT 时
  ERROR 23P01: 互相冲突的键值违反排他约束"uq_decision_current"
NEG-2（FINAL/S10 + FINAL/NULL）：INSERT 0 2 成功 → COMMIT 时
  ERROR 23P01: 互相冲突的键值违反排他约束"uq_decision_current_final"
两次失败都没有留下数据（库里仍只有合同事务写入的 2 行）
```

### 6.6 §6 数据面（5 条）

无重复 current（NULL 按相等）/ 每个申请最多一条 current FINAL / 没有 `job_id IS NULL` /
没有跨岗位 rubric 的 `interview_record` / 全库多列外键全部含 `tenant_id`（新外键不破 0007 §6.9）。

### 6.7 夹具为什么要一条"专用申请"

§3 为决策测试建了一条**专用申请**（`8888…7a2`，属于 job 401），**不借用** 0002 的演示申请
`1111…0701`。原因：演示申请上可能已经有 current 决策（例如业务联调、或本文件 §2.6 的
合同事务），如果 verify-0008 直接往 `0701` 上插"重评前"的 current 决策，就会撞上已存在的
current 而误报。用专用申请后，`verify-0008.sql` 在**有数据的库**上也能复跑——实测：
`ra_v8` 上已有合同事务写入的 2 条决策（1 条 current SCREENING），重跑 verify-0008 仍
`exit=0` 且全绿。

---

## 7. `verify-0007.sql` 的适配（只改断言方式，共 3 处）

任务要求：如果 verify-0007 断言 `uq_decision_current` 是"唯一索引"，改成断言**不变量**。
改动如下（行号以 0008 落地后的文件为准）：

| 行 | 改动 | 为什么 |
|---|---|---|
| 108–128（原 S-3 整段） | 删掉"`pg_index` 形态 = unique + nulls not distinct + 四列 + 谓词"的断言，改成**数据面不变量**：`group by tenant_id, application_id, decision_scope, coalesce(stage_code,'') having count(*) > 1` 必须 0 组；notice 里写明"执行层由 §5 B-01..B-03 实测，23505/23P01 均接受" | 0008 之后对象形态**必然**变化（索引→排斥约束），继续断言对象名/形态会让 verify-0007 只因"实现换了"而红。不变量才是 0007 要保证的东西；"真能拦住"由 B-01..B-03 行为测试负责——若约束被整个删掉，B-01 会"成功"从而 verify 失败 |
| 522–535（POS-7-04） | 夹具那条"不同 scope 并存"的决策从 `FINAL/S10` 改成 `SCREENING/NULL`，notice 说明原因 | 0008 之后"每个申请最多一条 current FINAL"，而同一夹具的 POS-7-02 已经造了一条 `FINAL/NULL` current；夹具本身必须先合法，否则一开 `SET CONSTRAINTS` 就会被 23P01 顶掉（而且 ROLLBACK 会掩盖这类违规，让 verify 变成"假绿"） |
| 641 + 691–703 + 804 | 在 §5 负向块前加 **`set constraints all immediate;`**；B-01/B-02/B-03 的期望 SQLSTATE 从 `'23505'` 改成 `'23505|23P01'`；断言比较从 `v_state <> r.expect` 改成 `not (v_state = any (string_to_array(r.expect,'|')))` | 0008 把 GAP-B 改成延迟检查，若不 `SET CONSTRAINTS ... IMMEDIATE`，B-01..B-03 的 INSERT/UPDATE 会**成功**（冲突留到 COMMIT），负向测试就会报"居然成功了"。这一句在"无 0008"的库上是 no-op，所以 verify-0007 在**有/无 0008 两种库上都能跑** |

**双库实测**（同一份改后的 verify-0007）：

* `ra_v7chk`（0001→0007，无 0008）：`exit=0`，B-01..B-03 报 **23505**；
* `ra_v8`（0001→0008）：`exit=0`，B-01..B-03 报 **23P01**。

`verify-0007` 的其它 8 条结构断言、11 条正向、19 条其它负向、7 条数据面**一行未动**。

---

## 8. 残留（**没有**闭合的部分，按影响排序）

### 8.1 `23505 → 23P01` 的 SQLSTATE 变化，契约/工具映射还没改（**最重要**）

0007 之后，"同一个 `(app, scope, stage)` 已有 current" 在写入时抛 `23505`；
0008 之后，这个冲突在 **COMMIT 时**抛 `23P01`（排斥约束）。受影响的外部引用
（都**不在本 lane 的写范围**，本 lane 只允许改 `db/0008*`、`db/verify-0008.sql`、
`db/DECISION-UNIQUENESS.md`、`db/verify-0007.sql`）：

| 文件:行 | 现在写的 | 0008 之后应改成 |
|---|---|---|
| `dsh/dsh-recruitment/contracts/evaluation/tool-contracts.md:506` | "`0007` 之后由 23505 触发" | 23505 **或 23P01**（0008 之后是 23P01） |
| 同上 `:509` | "`uq_decision_current` 的 23505 必须映射成 `ALREADY_DECIDED`" | 同上；且要注明"错误在 COMMIT 时出现，不在语句时" |
| 同上 `:601` | "唯一的'不是兜底'的 23505" | 同一语义现在可能是 23P01 |
| 同上 `:665` | P7 场景写"由 `uq_decision_current` 的 23505 触发" | 同上 |
| `dsh/dsh-recruitment/contracts/evaluation/decision-rules.md:390` | 描述"临时反向指针的三步舞"来绕过 0007 的索引 | 0008 之后两步顺序已合法；三步舞仍可用但不再是必须，建议收敛到契约 §5.2 的两步 |
| 同上 `:606`（Q-3） | "契约已按'索引存在'写" | 索引已被排斥约束替换，这一行的前提变了 |

**代码面**：本仓库的 `dsh/` / `converter/` 里 grep `23505` / `23P01` / `ALREADY_DECIDED`
命中 **0 处**（截至本次实测），所以当前没有已实现的映射会被打断；但契约层必须同步，
否则下一个人按 `23505` 写映射会在 0008 库上漏掉 `23P01`。

### 8.2 `db/DECISION-INTEGRITY.md`（0007 的说明文档）仍然描述旧对象

该文件 §1.2（`create unique index uq_decision_current ... nulls not distinct`）、
`:149`（"先插新行 → 23505"）、`:519`（"11 条结构断言"里的索引形态）都还写着 0007 的形态。
它**不在本 lane 的写范围**，需要单独一次文档同步（否则又是"两套权威并存"，违反 R5）。

### 8.3 `application.job_id` 可变 → `interview_record.job_id`（以及 0007 的 `scorecard.job_id`）会变旧

0001 §9.3 的列级不可变清单里**没有** `application`，所以 `application.job_id` 今天可以被改。
改了之后：

* 新插入的 `interview_record` / `scorecard` 会按**新** `job_id` 填；
* 已有行的 `job_id` 仍是旧值，此后对该行**任何 UPDATE** 都会被触发器
  （`JOB_MISMATCH` / `SCORECARD_JOB_MISMATCH`）拦下，直到人工修正那次派生值。

0008 不把 `application.job_id` 冻结（那会改 0001 的业务语义），只把代价写在这里。
这是 0007 的 `scorecard.job_id` 就已经存在的同型残留，0008 让它多了一张表。

### 8.4 `fk_decision_superseded_by` 仍是**立即**校验：先 UPDATE 后 INSERT 仍然 23503

0008 修的是"契约规定的顺序"（先 INSERT 新行 → 再 UPDATE 旧行）。反过来（先 UPDATE
指向一个还不存在的 id）仍然会 23503 —— 这不是缺陷：要让"指向未来的行"合法，需要把
自引用外键也改成 DEFERRABLE，那会放宽"指针必须指向真实决策"的保证，**本文件不做**。
契约 §5.2 就是正确顺序，0008 让它第一次真正可执行。

### 8.5 校验强度：排斥约束与唯一索引一样可以被 `session_replication_role = replica` 绕过

DDL 级别没有软肋，但超级用户/复制模式可以关掉约束检查——这与所有 PostgreSQL 约束一致，
不是 0008 引入的。

### 8.6 CI 与文档的覆盖缺口（都不在本 lane 的写范围）

* `.github/workflows/ci.yml`（外部已把 0008 加进迁移/自检循环，本次未验证该改动）的
  **幂等步骤仍然只重跑 0006 + 0007**（`0006 + 0007 must be idempotent`），没有重跑 0008。
  本次的幂等证据是本机实测（§5.1：对象数两遍一致、带数据第三遍指纹不变、0 ERROR）；
  CI 侧需要把 0008 加进那一步，否则"幂等"在 CI 上是没有覆盖的。
* `db/README.md` 的迁移清单、`db/SCHEMA.md` 的列/不变量描述、`db/DECISION-INTEGRITY.md`
  的 0007 形态描述都还停在 0008 之前（`interview_record.job_id`、两条排斥约束没有写进去）。
  这些文件不在本 lane 写范围，需要一次单独的文档同步（R5：否则又是两套权威并存）。


---

## 9. 迁移失败 / 回滚 / 运维

### 9.1 三类脏数据 → 迁移会 `raise` + 整笔回滚 + 逐行列出（**不替人改数据**）

实测（`ra_dirty_ab` / `ra_dirty_c`，都在 0001→0007 上造脏数据后跑 0008）：

```
A 段：DECISION_CURRENT_DUPLICATE（23505）
  tenant=…0001 application=…0701 scope=SCREENING stage=NULL
  ids=[7777…a1, 7777…a2]
B 段：DECISION_CURRENT_FINAL_DUPLICATE（23505）
  tenant=…0001 application=…0701
  final_ids=[7777…b1(stage=S10,result=HIRED), 7777…b2(stage=NULL,result=REJECT)]
C 段：INTERVIEW_RECORD_RUBRIC_JOB_MISMATCH（23503）
  interview_record=7777…0801 rubric=7777…0404 rubric_job=7777…0402 application_job=…0401
```

三次失败后对象数都**完全不变**（`constraints=500 / columns=633 / has_job_id=0`），
即"整笔回滚"不是口号。

处理方式：人工确认保留哪一条 current / 哪一条 FINAL / 哪条记录的 rubric，改数据后重跑；
0008 不会自己选。

### 9.2 回滚

反向 DDL 写在 `0008_decision_uniqueness.sql` 文件末尾的注释里。摘要：

```sql
alter table recruitment.decision drop constraint if exists uq_decision_current;
create unique index uq_decision_current
  on recruitment.decision (tenant_id, application_id, decision_scope, stage_code)
  nulls not distinct where superseded_by_decision_id is null;
alter table recruitment.decision drop constraint if exists uq_decision_current_final;
drop trigger  if exists trg_interview_record_job_guard on recruitment.interview_record;
drop function if exists recruitment.fn_interview_record_job_guard();
alter table recruitment.interview_record drop constraint if exists fk_interview_record_rubric_job;
alter table recruitment.interview_record drop column     if exists job_id;
```

⚠️ 回滚 A = 把"同一事务重评"重新夹死（23505）+ 重新打开 `FINAL/S10` 与 `FINAL/NULL` 并存；
回滚 C = 重新打开"面试记录用别的岗位的 rubric"。**这是退回，不是修复。**

### 9.3 运维顺序

```
0001 → … → 0007 → 0008 → verify-0008 → verify-0007 → verify-0006 → … → verify.sql
```

0008 **必须在 0007 之后**（依赖检查会拦）；verify-0008 与 verify-0007 的顺序无所谓，
但建议先 verify-0008（它断言 0008 的对象），再 verify-0007（它只断言 0007 的语义）。

---

## 10. 验收命令与结果（本机实测，PostgreSQL 17.11）

```
drop/create ra_v8
0001_init                      exit=0
0002_seed                      exit=0
0003_review_queue              exit=0
0004_stage_catalog             exit=0
0005_version_binding           exit=0
0006_integrity_gaps            exit=0
0007_decision_integrity        exit=0
0008_decision_uniqueness       exit=0   （第一遍）
0008_decision_uniqueness       exit=0   （第二遍，幂等；0 错误）
verify-0008.sql                exit=0   → VERIFY-0008 PASS
verify-0007.sql                exit=0   → VERIFY-0007 PASS
verify-0006.sql                exit=0   → VERIFY-0006 PASS
verify-0005.sql                exit=0   → V5 PASS
verify-0004.sql                exit=0   → VERIFY-0004 PASS
verify-0003.sql                exit=0   → VERIFY-0003 PASS
verify.sql                     exit=0   → VERIFY PASS
```

另：契约两步重评事务在 `ra_v8` 上原样执行 → `COMMIT` 成功（见 §2.6）；
真 COMMIT 的两次负向失败见 §6.5；`23505 / 23P01` 的双库表现见 §7。
