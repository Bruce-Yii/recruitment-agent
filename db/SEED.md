# db/SEED.md · 最小种子数据（`0002_seed.sql`）

**状态**：初版，待独立复核
**决策依据**：**D-14**（`work/control/DECISIONS-2026-11-12.md`）
**写范围**：只写数据。本文件 + `migrations/0002_seed.sql`，**不改** `0001_init.sql` / `SCHEMA.md` / `verify.sql` / `README.md`，不加任何 DDL。

> ⚠️ **演示用，非真实数据（DEMO ONLY / SYNTHETIC）**
> 全部行都是合成样例：演示租户、演示岗位、演示候选人、保留域名 `.test` 的假邮箱。
> 不含任何真实候选人资料 / 真实企业 / 真实邮箱 / 凭据（铁律 R7）。
> 任何查询都能读到 DEMO 标记：`organization.name` 含 `DEMO ONLY`，`job.title` 含「演示」，
> `business_config.payload.demo = true`，候选人姓名是「演示候选人-张样例」。

---

## 1. 为什么要有这个文件

D-14 指出的具体问题：

> `business_config.stage_catalog` 现在**没有任何配置行**，P1 第一次查阶段目录会是空表。
> → 必须补 `0002_seed.sql`：最小 stage_catalog + 一个 demo job + 一个 rubric version。否则联调必返工。

`0001_init.sql` 只建结构（39 表 / 约束 / 触发器），**一行数据都不写**。所以空库跑完 0001 之后：

| 现象 | 联调后果 |
|---|---|
| `business_config` 为空 | 阶段目录查不到 → 工具有"允许哪些阶段"的校验时直接空结果/报错 |
| `job` / `rubric_version` 为空 | `job_get` 类工具查无此岗 → 只能造数 |
| `candidate` / `application` 为空 | 按 candidate/application 查询的工具第一次就是空，无法判断是"没数据"还是"接错了" |

`0002_seed.sql` 就是把这个缺口补上，使**空库 → 0001 → 0002 之后立刻有可查询的最小数据集**。

---

## 2. 种了什么（首跑后的真实行数）

| 表 | 行数 | 内容 / 用途 |
|---|---:|---|
| `organization` | 1 | 演示租户（`DEMO ONLY`） |
| `department` | 1 | 研发部（演示）；`job.department_id` 是 NOT NULL 复合外键，必须前置 |
| `actor` | 4 | 企业管理员 / 招聘负责人 / HR 专员 / 面试官（固定 UUID，便于 `SET LOCAL` 复现） |
| `role` | 4 | `ORG_ADMIN` / `HIRING_MANAGER` / `HR_SPECIALIST` / `INTERVIEWER` |
| `actor_role` | 4 | 一人一角；管理员是引导账号（`granted_by_actor_id = null`） |
| `job` | 1 | 演示岗位，终态 **OPEN**（`DEMO-BE-001`） |
| `job_version` | 1 | v1，JD 内容非空；`payload_hash` 是内容真算的 sha256 |
| `rubric_version` | 1 | v1，绑定该 job；3 条维度，权重和 = 1.0 |
| `business_config` | 1 | **`stage_catalog`**：S1–S12 完整目录（code / name / order / kind / in_v1_scope） |
| `candidate` | 1 | 演示候选人（规范化邮箱 + 手机号） |
| `application` | 1 | 绑定上面的 candidate / job / job_version / rubric_version，当前阶段 **S7** |
| `event_inbox` | 2 | 两条**内部事件**：`job.status.changed`、`application.current_stage_code.changed`（不变量 8 自动产生，不是手写） |

固定 UUID 清单（全部 RFC 9562 v4 形式，`…-4xxx-8xxx-…`）：

| 对象 | UUID |
|---|---|
| 租户 | `11111111-1111-4111-8111-000000000001` |
| 部门 | `11111111-1111-4111-8111-000000000010` |
| 企业管理员 | `11111111-1111-4111-8111-000000000101` |
| 招聘负责人 | `11111111-1111-4111-8111-000000000102` |
| HR 专员 | `11111111-1111-4111-8111-000000000103` |
| 面试官 | `11111111-1111-4111-8111-000000000104` |
| role | `...0201` / `...0202` / `...0203` / `...0204` |
| actor_role | `...0301` / `...0302` / `...0303` / `...0304` |
| job | `11111111-1111-4111-8111-000000000401` |
| job_version | `11111111-1111-4111-8111-000000000402` |
| rubric_version | `11111111-1111-4111-8111-000000000403` |
| business_config（stage_catalog） | `11111111-1111-4111-8111-000000000501` |
| candidate | `11111111-1111-4111-8111-000000000601` |
| application | `11111111-1111-4111-8111-000000000701` |

阶段目录（12 个，`order` 升序；`in_v1_scope` 按 `docs/01 §9` 的 v1.0 切割）：

```
S1  招聘需求发现              in_v1_scope=false
S2  Requisition 创建与审批    false
S3  Job / JD / Rubric 设计    true
S4  Job Posting 发布          false
S5  人才获取 / Sourcing       false
S6  简历接入与处理（Intake）  true
S7  初筛 / Screening          true
S8  面试规划与排期            true
S9  面试执行与材料获取        true
S10 综合评价与招聘决策        true
S11 Offer 与入职交接          false
S12 人才沉淀与复盘            false
```

> 目录形状由本 seed 首次定义：`{"catalog_version":1,"demo":true,"stages":[{"order","code","name","kind","in_v1_scope"}...]}`。
> 下游若需要别的字段，先改本文件 + 回抄合同，不要私下加列。

---

## 3. 怎么跑

必须先有 `0001_init.sql`（本文件不改 schema，缺表会直接报错）。

```powershell
$env:PGPASSWORD = '<密码>'
$env:PGCLIENTENCODING = 'UTF8'          # Windows 控制台中文名不乱码
$psql = 'D:\12412\PostgreSQL\bin\psql.exe'

& $psql -U postgres -h 127.0.0.1 -d postgres `
    -c "DROP DATABASE IF EXISTS ra_seed_check WITH (FORCE);" -c "CREATE DATABASE ra_seed_check;"
& $psql -U postgres -h 127.0.0.1 -d ra_seed_check -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
& $psql -U postgres -h 127.0.0.1 -d ra_seed_check -v ON_ERROR_STOP=1 -f db/migrations/0002_seed.sql
& $psql -U postgres -h 127.0.0.1 -d ra_seed_check -v ON_ERROR_STOP=1 -f db/migrations/0002_seed.sql   # 第二遍：幂等
```

- **不要加 `-1`**：文件自带 `begin/commit`，再加 `-1` 会嵌套事务。
- 脚本里没有 `\echo` 等 psql 元命令 → 任何 PG 客户端都能执行。
- 只应指向一次性自建库（`ra_seed_check`）。**不要**对 `recruitment_os` 等已有库执行。

---

## 4. 幂等契约（连跑两遍 = 零 ERROR、零新增行、版本号不漂移）

| 手段 | 落点 |
|---|---|
| 固定 UUID + `on conflict do nothing` | 全部 11 条 INSERT（12 张表） |
| 状态迁移只在"还不是目标值"时执行 | `update job … where status <> 'OPEN'`；`update application … where current_stage_code <> 'S7'` |
| 后置回填只在为空时执行 | `job.current_job_version_id is null`、`department.hiring_manager_actor_id is null` |
| 整个文件一个事务 | `begin; … commit;`：任一步失败全回滚，不会半写 |

**为什么版本号不漂移**：`fn_row_guard` / `fn_touch` 只在 UPDATE 命中行时 +1；第二遍所有 UPDATE 都是 `UPDATE 0`，不会碰 `record_version`，也不会写 `event_inbox`。

实测（2026-11-13，PG 17.11）：

| 遍次 | exit | INSERT 结果 | UPDATE 结果 | event_inbox |
|---|---:|---|---|---:|
| 第 1 遍 | 0 | `1 / 1 / 4 / 4 / 4 / 1 / 1 / 1 / 1 / 1 / 1` 行 | `1`（部门回填）、`1`（job 版本回填）、`1`（DRAFT→OPEN）、`1`（S6→S7） | 2 |
| 第 2 遍 | 0 | 全部 `0` 行 | 全部 `0` 行 | 仍 2 |
| 第 3 遍（负向测试失败后再跑） | 0 | 全部 `0` 行 | 全部 `0` 行 | 仍 2 |

首跑后 `record_version`：`job = 3`（插入 1 → 回填版本 2 → 迁移 3）、`application = 2`（插入 1 → 迁移 2）。第二、三遍保持不变。

---

## 5. 不变量 / 写入规则遵守（逐条对应 README §6）

| 规则 | 本 seed 怎么做的 |
|---|---|
| **状态迁移必须给 actor**（不变量 8 / D-18） | 两处迁移前都 `set local recruitment.actor_id = '<固定 UUID>'`（**不是** `SET`，事务结束即失效）；job 用招聘负责人、application 用 HR 专员 |
| 迁移必须留来源事件 | 由 `fn_row_guard` 自动写 `event_inbox`（`provider='internal'`、`trust_level='INTERNAL'`）并回填 `status_source_event_id` / `stage_source_event_id`；seed **不手写事件** |
| 不手改审计列 | 没有任何 `set status_changed_at = …` / `status_source_event_id = …` |
| 配置不可静默变更 | `job_version` / `rubric_version` / `business_config` 只插入、不 UPDATE（它们本来整行不可改） |
| 不物理删除 | 全文件无 `delete` |
| 不写占位哈希 | 三处 `payload_hash` 都是 `encode(sha256(convert_to(<真实内容>,'UTF8')),'hex')`；实测回读 `true` |
| 初始行 ≠ 状态迁移 | `job` 先 DRAFT 再迁移到 OPEN；`application` 先 S6 再迁移到 S7 —— 因此两条审计链是真的，不是伪造的初始值 |

---

## 6. 验收记录（本机实跑，非转述）

环境：Windows 11 + PostgreSQL 17.11（`D:\12412\PostgreSQL`），库 `ra_seed_check`（一次性新建）。

| 项 | 命令 | 结果 |
|---|---|---|
| 建库 | `psql -d postgres -c "DROP DATABASE IF EXISTS ra_seed_check WITH (FORCE);" -c "CREATE DATABASE ra_seed_check;"` | exit 0 |
| 建表 | `psql -d ra_seed_check -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql` | exit 0 |
| 种子 1 | `… -f db/migrations/0002_seed.sql` | **exit 0**，`COMMIT` |
| 种子 2（幂等） | 同上再跑 | **exit 0**，全部 `INSERT 0 0` / `UPDATE 0` |
| 负向：重复 id | `insert into recruitment.organization (id,name) values ('11111111-…-000000000001','重复租户');` | **exit 1**，`错误: 23505: 重复键违反唯一约束"organization_pkey"`（`约束名: organization_pkey`），失败后 `organization` 仍 1 行 |
| 既有自检不被破坏 | `psql -d ra_seed_check -v ON_ERROR_STOP=1 -f db/verify.sql` | **exit 0**，末行 `VERIFY PASS`（32/32 负向测试仍按预期失败，脚本自带 ROLLBACK，不改数据） |

阶段目录回读（12 行，`code|name` 原样）：

```
S1|招聘需求发现
S2|Requisition 创建与审批
S3|Job / JD / Rubric 设计
S4|Job Posting 发布
S5|人才获取 / Sourcing
S6|简历接入与处理（Intake）
S7|初筛 / Screening
S8|面试规划与排期
S9|面试执行与材料获取
S10|综合评价与招聘决策
S11|Offer 与入职交接
S12|人才沉淀与复盘
```

---

## 7. 已知缺口 / 待裁决（**不要当成已解决**）

1. **`rubric_version` 没有 `is_current` 列。** 任务书要求"`is_current=true`"，但 `0001_init.sql` 的 `rubric_version` 只有
   `job_id + version_no + dimensions + payload_hash + approved_by_approval_id + created_by_actor_id`。
   本 seed **不加列**（写范围只允许数据，且"新增列"属 schema 变更，应走 `0003`）。
   当前表达方式：**只有 v1 一行 → 它就是当前版本**。多版本后"当前"只能由 `max(version_no)` 或
   （更好的）`job.current_rubric_version_id` 表达 —— 后者 **0001 没有建**。
   C 线 `job-get` 的 `is_current` 目前是 `version === record.current_rubric_version`（stub 内部常量，不读库）。
   → **需总控裁决**：给 `job` 补 `current_rubric_version_id`（0003），还是约定"当前 = 最大 version_no"。
2. **阶段 code 两套口径。** 本 seed 按任务书 + `docs/01` 用 **S1–S12**；C 线 `dsh/dsh-recruitment/CONTRACT.md`
   里 `application.stage` 的取值是 **APPLIED / SCREENING / INTERVIEW / OFFER / REJECTED**（5 个粗粒度）。
   本 seed 按 S-code 落，`application.current_stage_code='S7'`。两者必须在联调前对齐（改 C 线映射，或在
   catalog 里增加 `alias`/`contract_code` 字段），否则同一份数据会被读出两种阶段名。
3. **未种的表**（超出最小集，插件需要时再追加）：`requisition`、`acquisition_channel`、`job_posting`、
   `interview_template_version`、`interview`、`interviewer`、`meeting`、`transcript_*`、`scorecard`、`decision`、
   `business_task`、`execution_mandate`、`approval`。因此 `application.channel_id` / `resume_version_id` 为 null
   （两列本就可空）。
4. **两处后置回填是循环外键逼出来的**：`job.current_job_version_id`（`fk_job_current_version` 在 0001 §8 才补）、
   `department.hiring_manager_actor_id`（自引用 actor）。它们不是"先建后补"的偷懒，而是插序约束。
5. **`is_current` 之外还有一个小口径差**：`rubric_version.approved_by_approval_id` 本 seed 留空（没有种子审批流），
   所以这条 rubric 在语义上是"未审批版本"。若联调需要 `OPEN` 岗位有已审批 rubric，需一并种 `approval`。

---

## 8. 联调怎么用

```sql
-- 阶段目录（第一个要用的查询）
select payload -> 'stages' from recruitment.business_config
 where scope = 'ORGANIZATION' and config_key = 'stage_catalog';

-- 岗位 + rubric + 申请
select j.id, j.code, j.title, j.status, jv.version_no, rv.id as rubric_id, rv.dimensions
  from recruitment.job j
  join recruitment.job_version jv on jv.job_id = j.id and jv.id = j.current_job_version_id
  left join recruitment.rubric_version rv on rv.job_id = j.id
 where j.code = 'DEMO-BE-001';

select a.id, a.current_stage_code, a.lifecycle_status, a.record_version,
       c.display_name, j.code
  from recruitment.application a
  join recruitment.candidate c on c.id = a.candidate_id
  join recruitment.job j on j.id = a.job_id;
```

**改状态必须带 actor + `record_version`**（否则报 `ACTOR_REQUIRED` / 0 行）：

```sql
begin;
set local recruitment.actor_id = '11111111-1111-4111-8111-000000000103';
update recruitment.application
   set current_stage_code = 'S8'
 where id = '11111111-1111-4111-8111-000000000701'
   and record_version = 2;        -- 0 行 = VERSION_CONFLICT，回滚重读
commit;
```

---

## 9. 以后加种子的约定

1. **固定 UUID**：沿用 `11111111-1111-4111-8111-0000000000NN` 段，新对象从 `…000000000801` 起编号，不要用 `gen_random_uuid()`（测试无法复现）。
2. **只写数据**：种子文件不建表、不改列、不加索引；schema 变更走 `0003_*.sql` 并同步 `SCHEMA.md`。
3. **每个 INSERT 都 `on conflict do nothing`**；UPDATE 必须带"还不是目标值"的守卫，否则重跑会改 `record_version` / 写假事件。
4. **状态迁移一律 `set local recruitment.actor_id`**（D-18），并让触发器自己写事件 —— 不要为了省事变 `insert into event_inbox`。
5. **加完同步本文件的 §2 清单与行数**，并重跑 §3 的两遍幂等 + 重复 id 负向测试。
