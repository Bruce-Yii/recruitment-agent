# db/VERSION-BINDING.md · 0005「版本不得跨岗位引用」（D-49）

**裁定来源**：`work/control/DECISIONS-2026-11-12.md` → **D-49**（J 线 S-3，最该修）
**交付物**：`db/migrations/0005_version_binding.sql`（迁移）+ `db/verify-0005.sql`（自检）
**本文件**：说明改了什么、为什么这么改、怎么验的、还剩什么没覆盖、哪一处偏离了 D-49 字面。
**状态**：`ra_v5`（PG 17.11）实测通过；**未 commit、未 push**；未改 0001–0004 / verify.sql / SCHEMA.md。

---

## 1. 修的是哪个漏洞

`0001_init.sql` 里 `application` 的两个版本列只做了 **(id, tenant_id)** 外键：

```sql
-- 0001:864-867（改造前）
constraint fk_application_job_version foreign key (job_version_id, tenant_id)
  references recruitment.job_version (id, tenant_id),
constraint fk_application_rubric foreign key (rubric_version_id, tenant_id)
  references recruitment.rubric_version (id, tenant_id),
```

`(id, tenant_id)` 只保证「这个版本行存在且同租户」，**不保证它属于这条申请的岗位**。
于是 A 岗位的申请可以钉 B 岗位的 rubric —— "钉版本"（不变量 10）形同虚设：
历史评价会用错评分标准，而且数据库一声不吭。

---

## 2. 改造前后对照（真实 `pg_get_constraintdef` 输出）

### 2.1 `application` 上的版本外键

| | 约束名 | 定义 | on delete |
|---|---|---|---|
| **改造前** | `fk_application_job_version` | `FOREIGN KEY (job_version_id, tenant_id) REFERENCES recruitment.job_version(id, tenant_id)` | `a`（NO ACTION） |
| **改造前** | `fk_application_rubric` | `FOREIGN KEY (rubric_version_id, tenant_id) REFERENCES recruitment.rubric_version(id, tenant_id)` | `a`（NO ACTION） |
| **改造后** | `fk_application_rubric_job` | `FOREIGN KEY (tenant_id, rubric_version_id, job_id) REFERENCES recruitment.rubric_version(tenant_id, id, job_id) ON UPDATE RESTRICT ON DELETE RESTRICT` | `r`（RESTRICT） |
| **改造后** | `fk_application_job_version_job` | `FOREIGN KEY (tenant_id, job_version_id, job_id) REFERENCES recruitment.job_version(tenant_id, id, job_id) ON UPDATE RESTRICT ON DELETE RESTRICT` | `r`（RESTRICT） |

- 旧外键**退场**，新外键**接管**；同一个事务里先加后删，任何时刻都有一套在生效。
- `ON DELETE` 从 `NO ACTION` 变 `RESTRICT` 是有意的：`NO ACTION` 允许**延迟**检查（约束可 `DEFERRABLE` / 事务末尾才报），
  `RESTRICT` 立即拒绝 —— 版本被钉住就不该有任何"先删后补"的窗口。

### 2.2 `rubric_version` / `job_version` 上的被引用键

| 表 | 改造前 | 改造后新增 |
|---|---|---|
| `rubric_version` | `UNIQUE (id, tenant_id)`<br>`UNIQUE (job_id, version_no)` | `uq_rubric_version_id_job` = `UNIQUE (id, job_id)`（D-49 第 1 条）<br>`uq_rubric_version_tenant_id_job` = `UNIQUE (tenant_id, id, job_id)`（3 列外键的被引用键） |
| `job_version` | `UNIQUE (id, tenant_id)`<br>`UNIQUE (job_id, version_no)` | `uq_job_version_id_job` = `UNIQUE (id, job_id)`（D-49 第 1 条）<br>`uq_job_version_tenant_id_job` = `UNIQUE (tenant_id, id, job_id)`（3 列外键的被引用键） |

> 两对唯一键**不是重复**：`(id, job_id)` 是 D-49 的字面交付物，也是"一个版本行 = (版本, 岗位)"这条业务事实的载体；
> `(tenant_id, id, job_id)` 是 3 列外键必须指到的被引用键（PostgreSQL 只接受"被引用列组上有唯一约束"）。
> 因为 `id` 已是主键，`(id, job_id)` 不增加拦截力 —— 它是**声明**，`(tenant_id, id, job_id)` 才是**被引用的那张牌**。

---

## 3. ⚠️ 与 D-49 字面的偏离（请总控确认，不要当成笔误）

D-49 写的是 **2 列**：

```
(rubric_version_id, job_id) → rubric_version (id, job_id)
(job_version_id,  job_id) → job_version  (id, job_id)
```

**但 `db/verify.sql` 的 STRUCT-07 断言是**（`db/verify.sql` 第 2.7 节，当前 `verify.sql:207-219`；
行号会随其它 lane 编辑漂移，引用时请按 **STRUCT-07** 定位）：

> 凡 `conkey` 超过 1 列的复合外键，**必须含 `tenant_id`**（防跨租户引用）；
> 唯一豁免是 `source_revision` / `transcript_revision` 这类版本定位列。

2 列形态不含 `tenant_id` → **0005 一跑，`verify.sql` 立刻 STRUCT-07 FAIL**，
而 D-49 的验收第 4 条又要求 `verify.sql` 仍必须 `VERIFY PASS`。
**这两条按字面不可能同时成立。**

本文件的取舍：落地成 **3 列（含 `tenant_id`）**，即 `(tenant_id, <版本列>, job_id)`。

- 强度：**严格强于** D-49 的 2 列形态 —— 同一行同时保证"同 job"和"同租户"；
- 语义：D-49 要拦的"申请指向别岗位的版本"照样被拦（`V5-01`…`V5-07` 实测 `23503`）；
- 兼容：`verify.sql` STRUCT-07 实测 PASS（见 §6.4）。

**如果总控坚持 2 列**：唯一代价是 STRUCT-07 必须对这两个约束开口子 —— 那需要授权改 `verify.sql`，
本任务不允许，所以本文件选了"加严而不动别人文件"。这是**加严**，不是放宽。

---

## 4. "删旧外键"之前到底验证了什么（三道闸）

本迁移唯一的破坏性动作是 `drop constraint`，所以设了三道闸，且**全部在同一事务内**：

### 闸 0 · 迁移前自检：现有数据里有没有跨 job 引用（`§1`）

```sql
select ... from recruitment.application a
  join recruitment.rubric_version rv on rv.id = a.rubric_version_id
 where rv.job_id <> a.job_id or rv.tenant_id <> a.tenant_id;
```

有任意一条 → `raise exception ... using errcode = '23503'`，**整笔回滚**，并把
"哪条申请 / 钉的哪个版本 / 该版本实际属于哪个 job 和租户"逐条打印。

**不替人修数据**，理由写在文件头：跨 job 引用可能是"写错了"，也可能是"业务上真要换岗"，
迁移替人选任一种都是替人做决定，而且改完就再也看不出"曾经错过"。
实测（在 `ra_v5` 里造了一条真跨 job 引用后跑 0005）：

```
psql:.../0005_version_binding.sql:136: 错误:  VERSION_BINDING_CROSS_JOB: 以下申请的 rubric_version_id 指向**别的岗位/租户**的评分标准，复合外键无法建立。
      本迁移不会替你改数据：请人工确认这些申请应当钉哪个版本的 rubric（改数据后重跑本迁移）。
      application=11111111-1111-4111-8111-000000000701 (tenant=...0001 job=...0401) 钉的 rubric=...0903，该 rubric 属于 job=...0901 / tenant=...0001
=== 0005 on dirty data exit=3
```

失败后复查结构：新外键**没有**建上、旧外键**仍在**、无新增唯一键 —— 事务整体回滚，库停在跑之前的样子。
随后把那条申请改回 `...0403` 再跑 0005 → `PRE-CHECK PASS` + 成功（§6.2）。

### 闸 1 · 新外键必须已存在且 `convalidated`（`§4.1`）

```sql
select count(*) ... where conname in ('fk_application_rubric_job','fk_application_job_version_job')
                    and convalidated;
-- 结果 <> 2 → raise exception 'VERSION_BINDING_ABORT ... 拒绝删除旧外键'
```

为什么不能省：`drop` 成功而新外键因任何原因没建上（或建成了 `NOT VALID`），
库会**静默回到"版本可跨岗位"**，而且再跑一遍迁移也发现不了。
闸 1 就是这条自愈路径的入口 —— 它是"先验证再删"，不是"drop 了事"。

### 闸 2 · 旧外键若还在，先核对定义（`§4.2`）

用 `pg_constraint` 的 `conkey` / `confkey` / `confrelid`（**不是**字符串匹配）核对：

- `fk_application_rubric`：`(rubric_version_id, tenant_id)` → `rubric_version(id, tenant_id)`
- `fk_application_job_version`：`(job_version_id, tenant_id)` → `job_version(id, tenant_id)`

有一项不符 → `VERSION_BINDING_ABORT: 旧外键 % 的定义与预期不符，拒绝删除`。
防止误删别人改过的约束（比如有人把它换成了 CASCADE）。

### 闸 3 · 迁移后复核（`§5`）

新外键 `confdeltype='r'` / `confupdtype='r'` / `convalidated`；旧外键**必须已退场**；
**不存在"不含 job_id 的版本外键"**（防后门被加回来）；数据面跨岗位引用 `= 0`；`unique (id, job_id)` 在位。

---

## 5. 幂等怎么做的

| 动作 | 幂等手段 |
|---|---|
| 加唯一键 | 先查 `pg_constraint` 里**列集合相等**（`array_agg(attname order by attname)`）再建，不看约束名 —— 0004 若已建 `uq_rubric_version_tenant_job_id (tenant_id, job_id, id)`（同列集、异列序），**复用**而不叠一个同义索引 |
| 加外键 | 先查约束名 + `conrelid` 是否存在 |
| 删旧外键 | `drop constraint if exists`，且存在时先核对定义（闸 2） |
| 数据 | 本文件**没有** `INSERT` / `UPDATE` / `DELETE`；`§1` 的检查是只读查询 |

**结构指纹实测**（连跑两遍后再跑第三遍，比较 `recruitment` 全 schema 的约束清单 md5）：

```
--- 第二遍跑完后的结构指纹 ---
 n_constraints |           fingerprint
---------------+----------------------------------
           440 | 0eaa854d7dcb095fc46c0bbcfbdfef51
--- 再跑第三遍 ---
0005 第三遍 exit=0
--- 第三遍跑完后的结构指纹（应与上面逐字相同）---
           440 | 0eaa854d7dcb095fc46c0bbcfbdfef51
```

行数相同、指纹逐字相同 = **第二遍/第三遍零新增、零改动**。

---

## 6. 验收（真实命令 + 真实输出）

环境：PG 17.11 / `psql` 17，库 `ra_v5`，`PGCLIENTENCODING=UTF8`。

### 6.1 主链（0001 + 0002 + 0005 ×2 + verify-0005 + verify.sql）

```
0001_init.sql                        exit=0
0002_seed.sql                         exit=0
0005_version_binding.sql（第一遍）     exit=0
0005_version_binding.sql（第二遍）     exit=0
verify-0005.sql                       exit=0   V5 PASS
verify.sql                            exit=0   VERIFY PASS
```

第一遍关键日志：

```
0005 PRE-CHECK PASS 现有 application：1 条（钉了 rubric 的 1 条 / JD 版本对得上 job 的 1 条）全部同 job 同租户，无跨岗位引用
0005 已加 rubric_version unique (id, job_id) [uq_rubric_version_id_job]
0005 已加 job_version unique (id, job_id) [uq_job_version_id_job]
0005 已加 rubric_version unique (tenant_id, id, job_id) [uq_rubric_version_tenant_id_job]
0005 已加 job_version unique (tenant_id, id, job_id) [uq_job_version_tenant_id_job]
0005 已加 fk_application_rubric_job / fk_application_job_version_job
0005 闸 1 PASS 新复合外键 2/2 已建立并 convalidated
0005 已删旧外键 fk_application_rubric（原定义：FOREIGN KEY (rubric_version_id, tenant_id) REFERENCES recruitment.rubric_version(id, tenant_id)）
0005 已删旧外键 fk_application_job_version（原定义：...）
0005 旧外键清理完成：本次删除 2 条
0005 POST-CHECK PASS 复合外键 2 条（含 job_id + tenant_id，restrict/validated）+ 旧外键已退场 + 跨岗位引用 0 条
```

第二遍关键日志（全部 `跳过` / `复用` / `删除 0 条`）：

```
0005 rubric_version 已有 unique (id, job_id)（等价唯一键），跳过
0005 rubric_version 已有等价唯一键 (tenant_id, id, job_id)，复用
0005 fk_application_rubric_job 已存在，跳过
0005 旧外键 fk_application_rubric 不存在（此前已迁移过），跳过
0005 旧外键清理完成：本次删除 0 条
```

### 6.2 脏数据拒绝 + 修好后恢复（同库实测）

```
造脏：app 0701 (job 0401) 改钉 job 0901 的 rubric 0903 → 旧 2 列外键允许，成功
跑 0005 → 错误 VERSION_BINDING_CROSS_JOB（见 §4）  exit=3
复查 → 新外键未建、旧外键仍在、无新增唯一键（整笔回滚）
人工改回 rubric 0403 → 跑 0005 → PRE-CHECK PASS → POST-CHECK PASS  exit=0
```

### 6.3 负向测试（`db/verify-0005.sql`，断言真实 SQLSTATE）

| 编号 | 用例 | 期望 | **实测** |
|---|---|---|---|
| V5-01 | 申请指向**别的 job** 的 rubric（同租户） | 23503 | `23503` `违反外键约束 "fk_application_rubric_job"` |
| V5-02 | 申请指向**别的 job** 的 job_version | 23503 | `23503` `违反外键约束 "fk_application_job_version_job"` |
| V5-03 | 反方向：job2 的申请钉 job1 的 rubric | 23503 | `23503` `fk_application_rubric_job` |
| V5-04 | 跨租户：甲租户申请钉乙租户的 rubric | 23503 | `23503` `fk_application_rubric_job` |
| V5-05 | `UPDATE` 把 rubric 改成别的 job 的 | 23503 | `23503` |
| V5-06 | `UPDATE` 把 job_version 改成别的 job 的 | 23503 | `23503` |
| V5-07 | `UPDATE` 已钉版本后改 `job_id`（版本跟着"换岗"） | 23503 | `23503` |
| V5-08 | 改 `rubric_version.job_id` 想"洗白"跨岗位引用 | 23514 | `23514` `IMMUTABLE_COLUMN ... job_id 不允许修改` |
| V5-09 | 改 `job_version.job_id` 同上 | 23514 | `23514` |
| V5-10 | 删除被引用的 `rubric_version` | 拒绝 | 触发器路径 `23514 DELETE_FORBIDDEN`；**关掉禁删触发器后** `23503` 外键 RESTRICT |
| V5-11 | 删除被引用的 `job_version` | 拒绝 | 同上（`23514` / `23503`） |
| POS-05-01/02/03 | 同 job 引用、`rubric` 为 `NULL`、岗位二自己的版本组合 | 成功 | 3 条全部成功落库 |

> 删除那条特意做了两条路径：正常删除先被 `trg_*_no_delete` 拦成 `23514`
> （那是"历史不可删"，**证明不了外键建对了**）；把禁删触发器临时关掉（块内 `disable`/`enable`，
> 脚本结尾 `ROLLBACK`）后仍被 `23503` 拦，才证明 `ON DELETE RESTRICT` 真的在起作用。

### 6.4 既有不变量没被破坏（D-49 验收第 4 条）

```
=== verify.sql exit=0
错误行数：0
STRUCT-01 PASS … STRUCT-06 PASS 历史事实禁删触发器 38 个
STRUCT-07 PASS 复合外键都带 tenant_id（防跨租户引用）      ← 关键：3 列形态正是为了过这一条
COV-01 PASS 对象覆盖：有表 28 / 列映射 1 / 缓做 7（合计 36）
INV-10 PASS 配置变更不静默改变历史评价或已结束申请 → … + application.job_version_id 固定引用
NEGATIVE SUMMARY 32 条负向测试全部按预期失败
 VERIFY PASS：结构断言 + 状态机覆盖 + 对象覆盖 + 32 条负向测试全部通过
```

### 6.5 与 0004 的兼容（额外跑，非 D-49 要求）

在同一 `ra_v5` 上跑完整 `0001 → 0002 → 0003 → 0004` 再跑 0005：

```
0005 已加 rubric_version unique (id, job_id) [uq_rubric_version_id_job]
0005 rubric_version 已有等价唯一键 (tenant_id, id, job_id)（如 0004 的 uq_*_tenant_job_id），复用   ← 不重复建索引
0005 已加 job_version unique (tenant_id, id, job_id) [uq_job_version_tenant_id_job]
0005 已删旧外键 fk_application_rubric / fk_application_job_version
0005 POST-CHECK PASS …                                  exit=0
verify-0005 exit=0（V5 PASS）  verify-0004 exit=0（VERIFY-0004 PASS）  verify.sql exit=0（VERIFY PASS）
```

答案：0004 的 `uq_rubric_version_tenant_job_id UNIQUE (tenant_id, job_id, id)` 被**复用**，
外键接受它（PostgreSQL 只按列集合匹配被引用键，列序无关）。

---

## 7. 复现命令

```powershell
$env:PGPASSWORD='123456'; $env:PGCLIENTENCODING='UTF8'
$psql='D:\12412\PostgreSQL\bin\psql.exe'
& $psql -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE IF EXISTS ra_v5 WITH (FORCE);" -c "CREATE DATABASE ra_v5;"
& $psql -U postgres -h 127.0.0.1 -d ra_v5 -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v5 -v ON_ERROR_STOP=1 -f db/migrations/0002_seed.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v5 -v ON_ERROR_STOP=1 -f db/migrations/0005_version_binding.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v5 -v ON_ERROR_STOP=1 -f db/migrations/0005_version_binding.sql   # 幂等
& $psql -U postgres -h 127.0.0.1 -d ra_v5 -v ON_ERROR_STOP=1 -f db/verify-0005.sql
& $psql -U postgres -h 127.0.0.1 -d ra_v5 -v ON_ERROR_STOP=1 -f db/verify.sql
```

预期：全部 `exit=0`；`verify-0005` 打印 `V5 PASS`；`verify.sql` 打印 `VERIFY PASS` 且 `STRUCT-07 PASS`。
（`db/verify-0005.sql` 自身在事务里跑完 `ROLLBACK`，不留数据；不依赖 0004，缺 `stage_catalog` 时自动跳过补目录块。）

---

## 8. 本迁移**没有**覆盖的（残留风险，建议后续 0006 / 新裁定）

D-49 只点名 `application`，以下三处仍是"能指向别的岗位的 rubric"，**如实登记，没有顺手改**（不在写范围内）：

| # | 位置 | 现状 | 影响 |
|---|---|---|---|
| S-3b | `interview_template_version.rubric_version_id` | `(rubric_version_id, tenant_id) → rubric_version(id, tenant_id)` | 模板可以引用别的岗位的 rubric。因 `job_id` 可空（租户级通用模板），要强约束需先定"租户级模板能不能钉岗位 rubric" |
| S-3c | `interview_record.rubric_version_id` | 同上（2 列） | 面试记录可以引用别的岗位的评分标准 → 记录里的评价维度与申请岗位不一致 |
| S-3d | `scorecard.rubric_version_id` | 同上（2 列，不变量 7 只要求 NOT NULL） | 评价卡可以用别的岗位的 rubric 打分，且与 `application.rubric_version_id` 无任何关联约束 |

三条都是同构问题，修法同 0005（加 `(tenant_id, id, job_id)` 唯一键 + 含 `job_id` 的复合外键），
但每条都要先回答"这张表的 job 从哪来"（记录/评分卡没有 `job_id` 列，得经 `interview → application` 反查，
纯外键做不到，需要生成列或触发器）——**属于设计决策，不是迁移技巧**，所以留给定裁。

另外两点边界，避免被误读成"漏了"：

1. **`application.job_id` 本身仍可改**（改的同时必须把两个版本换成新岗位的）——本迁移保证的是
   "版本必须与 job 一致"，不是"job 永不可变"。若业务要求"进了某阶段就不许换岗"，那是另一条裁定（需要阶段条件，纯外键表达不了）。
2. **没加引用侧索引**：`application` 上没有 `(tenant_id, rubric_version_id, job_id)` 索引，
   删除版本时的 RESTRICT 检查会走顺序扫描。v1.0 单流程、申请表量小，故意不加（避免为一次删除多养一个索引）；
   量级上来后再补一条 `create index`。

---

## 9. 待总控确认的 2 件事

1. **D-49 的 2 列 vs 本文件的 3 列**（§3）：本文件按"加严 + 兼容 STRUCT-07"落地，
   建议把 D-49 的字面改成 3 列，避免下一个人照字面写出一个 `verify.sql` FAIL 的迁移。
2. **S-3b/c/d 是否开 0006**（§8）：同构漏洞在下游三张表仍然存在，建议单独立项，不要混进 0005。

---

## 10. 文件与行数

| 文件 | 作用 |
|---|---|
| `db/migrations/0005_version_binding.sql` | 迁移（幂等，单事务，含 §0 现场快照 / §1 前置自检 / §2 被引用键 / §3 新外键 / §4 三道闸删旧 / §5 后置自检） |
| `db/verify-0005.sql` | 自检（结构断言 + 夹具 + 3 正向 + 9 负向 + 2×2 删除路径 + 数据面复核，结尾 ROLLBACK） |
| `db/VERSION-BINDING.md` | 本文件（决策记录 + 证据） |

未改动：`0001` / `0002` / `0003` / `0004` / `db/verify.sql` / `db/SCHEMA.md`（`git status` 可核：这些文件均无 ` M`）。

> ⚠️ 并发提示：本仓库当时有**其它 lane 在同时写**（`git status` 里 `db/REVIEW-QUEUE.md`、`dsh-*`、`converter/` 等改动不是本任务产生；
> HEAD 在 01:04:03 有一次他人提交）。本任务只产出上面三个新文件，均为 `untracked`，**没有 commit、没有 push**。
> 若复核时发现 `db/verify.sql` 的 STRUCT-07 行号与我引用不同，按节号定位即可 —— 断言内容未变：
> "`conkey` 超过 1 列的复合外键必须含 `tenant_id`（豁免 `source_revision` / `transcript_revision`）"。
