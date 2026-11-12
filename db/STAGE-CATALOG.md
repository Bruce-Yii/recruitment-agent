# db/STAGE-CATALOG.md · 阶段目录真表 + 当前 Rubric 指针（`0004_stage_catalog.sql`）

**状态**：初版，待独立复核（实现者不验收自己的工作，铁律 R8）
**决策依据**：**D-23**（建 `stage_catalog` 并给 `application.current_stage_code` 加外键）、
**D-21**（`job.current_rubric_version_id` 显式指针）、**D-22**（阶段 code 唯一口径 = S1–S12）
　　—— `work/control/DECISIONS-2026-11-12.md`
**写范围**：`db/migrations/0004_stage_catalog.sql` + `db/verify-0004.sql` + 本文件。
　　　　　　**未改** `0001_init.sql` / `0002_seed.sql` / `0003_review_queue.sql` / `SCHEMA.md` / `verify.sql` / `SEED.md`。
**前置**：同一库已按序跑过 `0001_init.sql` → `0002_seed.sql`（0003 与本迁移无交集，先跑后跑都可）。

---

## 1. 要堵的两个静默错误

| # | 静默错误（D-23 / D-21 原话的场景） | 0004 之前 | 0004 之后 |
|---|---|---|---|
| 1 | 往 `application.current_stage_code` 写一个**目录里不存在**的 code | 只有正则 `^[A-Z][A-Z0-9_]{1,40}$`，`'SCREENING'`、`'S99'`、`'BANANA'` 全能写进库 → 查得到申请、查不到阶段名 | `23503` 外键拒绝；删/改被引用的 code 也拒绝 |
| 2 | 用 `max(version_no)` 当"当前 rubric 版本" | 回滚到 v1 之后 `max()` 仍然返回 v3（回滚是不可见的）→ 评价用错版本、且查不出来 | `job.current_rubric_version_id` 显式记录；且外键保证它只能是**本岗位**的 rubric |

两条都不是"可能出错"，而是**出错时数据库不会说话**。这就是要建真约束的理由。

---

## 2. 落点：建了什么

### 2.1 `stage_catalog`（新表，40 张表里的第 40 张）

```sql
create table recruitment.stage_catalog (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references recruitment.organization (id),
  code         text        not null,      -- 'S1' … 'S12'
  name         text        not null,
  sort_order   integer     not null,      -- 1..12
  in_v1_scope  boolean     not null,
  created_at   timestamptz not null default now()
);
```

| 约束 | 定义 | 拦的是什么 |
|---|---|---|
| `uq_stage_catalog_tenant_code` | `unique (tenant_id, code)` | **业务键**；同一个租户不能有两个 S1 |
| `uq_stage_catalog_tenant_order` | `unique (tenant_id, sort_order)` | 两个阶段占同一顺序 → "按顺序取阶段"结果不确定 |
| `ck_stage_catalog_code` | `code ~ '^[A-Z][A-Z0-9_]{1,40}$'` | 与 `application.ck_application_stage_code` 同一正则（外键 + 正则双保险） |
| `ck_stage_catalog_name` | `length(btrim(name)) between 1 and 120` | 空名 |
| `ck_stage_catalog_sort_order` | `sort_order between 1 and 12` | v1.0 固定 12 个阶段（D-22） |
| `ix_stage_catalog_order` | `(tenant_id, sort_order)` | 联调最常用查询 |

### 2.2 `application` 的外键

```sql
alter table recruitment.application
  add constraint fk_application_stage_catalog
  foreign key (tenant_id, current_stage_code)
  references recruitment.stage_catalog (tenant_id, code)
  on update restrict on delete restrict;    -- 显式：不级联
```

- **按租户**：复合外键带 `tenant_id`，甲租户的目录不能被乙租户的申请引用。
- `on delete restrict`：**删除被引用的阶段直接拒绝**（不级联改写历史申请里的 code —— 级联才是新的静默错误）。
- `on update restrict`：改被引用的 code 也拒绝（`event_inbox` 的历史事件里记的是旧 code，改名会让历史对不上）。

### 2.3 `job.current_rubric_version_id`（D-21）

```sql
alter table recruitment.job add column current_rubric_version_id uuid;   -- 可空

alter table recruitment.rubric_version
  add constraint uq_rubric_version_tenant_job_id unique (tenant_id, job_id, id);

alter table recruitment.job
  add constraint fk_job_current_rubric
  foreign key (tenant_id, id, current_rubric_version_id)
  references recruitment.rubric_version (tenant_id, job_id, id)
  on update restrict on delete restrict;
```

关键在**外键的列组合**：`(tenant_id, job.id, current_rubric_version_id) → (tenant_id, rubric_version.job_id, rubric_version.id)`
= "这个 rubric 的 `job_id` 必须正好等于这个 job 的 `id`"。
所以 **A 岗位不可能指向 B 岗位的 rubric** —— 哪怕那个 UUID 真实存在、哪怕它属于同租户。
`MATCH SIMPLE`（PG 默认）意味着 `current_rubric_version_id is null` 时不做检查 → "岗位还没有 rubric" 这个合法状态仍然成立。

---

## 3. 12 行目录（与 0002 逐字一致）

| code | name | sort_order | in_v1_scope |
|---|---|---:|---|
| S1 | 招聘需求发现 | 1 | false |
| S2 | Requisition 创建与审批 | 2 | false |
| S3 | Job / JD / Rubric 设计 | 3 | **true** |
| S4 | Job Posting 发布 | 4 | false |
| S5 | 人才获取 / Sourcing | 5 | false |
| S6 | 简历接入与处理（Intake） | 6 | **true** |
| S7 | 初筛 / Screening | 7 | **true** |
| S8 | 面试规划与排期 | 8 | **true** |
| S9 | 面试执行与材料获取 | 9 | **true** |
| S10 | 综合评价与招聘决策 | 10 | **true** |
| S11 | Offer 与入职交接 | 11 | false |
| S12 | 人才沉淀与复盘 | 12 | false |

**种子不是手抄的**：`0004` 从 `business_config`（`scope='ORGANIZATION'`、`config_key='stage_catalog'`、`effective_to is null`，取每租户 `version_no` 最大的那条）的 `payload.stages[]` **派生**插入。
理由：任务要求"与 0002 逐字一致"；手抄 12 行 = 造出第二个真相源，抄错一个字就是新的静默漂移。派生让"一致"成为结构事实，并且**按租户**成立（与 0002 的 `scope='ORGANIZATION'` 对齐）。

`verify-0004.sql` 的 **V4-03** 用双向 `EXCEPT` 断言"表 vs 配置"完全一致（不是只看行数）。

> `kind`（业务域：DEMAND/REQUISITION/…）**留在 `business_config` 的 JSON 快照里**，本表不建该列：
> D-23 只要求 code/name/sort_order/in_v1_scope；要加列先改决策 + `SCHEMA.md`，不要在迁移里悄悄扩。
> 另外 `kind` 这个列名会触发 `verify.sql` STRUCT-04（枚举列必须有 CHECK），加了就得再抄一份 12 值枚举。

---

## 4. 加外键**之前**怎么处理已存在数据（重点）

`0002` 已经把 demo 申请推到了 `current_stage_code='S7'`。加外键时如果目录里没有 `S7`，`ALTER TABLE … ADD CONSTRAINT` 会直接 `23503` 失败。
`0004` 的顺序是固定的，**不能换**：

| 步 | 动作 | 失败会怎样 |
|---|---|---|
| 1 | `create table if not exists stage_catalog` | — |
| 2 | 校验配置形状（`stages` 必须是数组；元素必须带齐 code/name/order/in_v1_scope 且类型正确） | `raise exception 22023`，整笔回滚（**不静默跳过坏元素**——跳过就是少一个阶段） |
| 3 | 从配置**派生**插入（`on conflict (tenant_id, code) do nothing`） | — |
| 4 | 校验目录完整性：有配置的租户必须正好 12 行、顺序 1..12 连续 | `raise exception 23514` |
| 5 | **PRE-FK 检查**：列出所有 `current_stage_code` 不在本租户目录里的 application | `raise exception 23503` + 脏值清单（`application=<id> tenant=<id> code=<值>`） |
| 6 | 加 `fk_application_stage_catalog` | — |

第 5 步是这次"处理已存在数据"的全部答案，它的原则是：**不猜、不改、不删**。

- 迁移**不会**替人把 `'SCREENING'` 映射成 `'S7'`，也不会删掉那条申请。脏 code 说明**有人写错了**，只有人能决定它应该是哪个阶段；
- 自动修数据会把"写错了"变成"看不出来写错过了"，正好是 D-23 要消灭的那类问题；
- 所以：一旦有脏值，本迁移**整笔回滚**（`begin/commit` 包住 + `ON_ERROR_STOP`），并打印清单让人处理，而不是留下"表建好了、外键没加上"的半套状态。

**没有用 `NOT VALID` + `VALIDATE` 的原因**：`NOT VALID` 只跳过"已有行"的校验，**新写入照样校验**，对本场景没有任何好处；而且它会让"外键到底生效了没有"变成一个需要额外查询的状态。这里数据量是 12 行 + 1 条申请，直接全量校验更诚实。

---

## 5. 幂等契约（连跑两遍 = 零 ERROR、零新增行）

| 手段 | 落点 |
|---|---|
| `create table if not exists` / `create index if not exists` | §1 |
| `alter table … add column if not exists` | §4 |
| 所有约束放进 `DO $$ … if not exists (select 1 from pg_constraint …) … $$` | 与 `0001 §8` 的循环外键同一写法 |
| 种子 `insert … on conflict (tenant_id, code) do nothing` | §2（第二遍 `INSERT 0 0`） |
| 回填只动 `current_rubric_version_id is null` 的行 | §4.1（第二遍 `UPDATE 0`） |
| 整个文件一个事务 | `begin; … commit;`：任一步失败全回滚，不留半套结构 |

实测（PG 17.11，库 `ra_stage_check`）：

| 遍次 | exit | 关键行 | 说明 |
|---|---:|---|---|
| 第 1 遍 | 0 | `INSERT 0 12` / `UPDATE 1` / `COMMIT` | 12 行目录 + 回填 1 个 job |
| 第 2 遍 | 0 | `INSERT 0 0` / `UPDATE 0` / `COMMIT` | 零 ERROR、零新增、`record_version` 不漂移 |

`job.record_version` 会因为回填 **3 → 4**（这是 `0002` 之后的一次真实 UPDATE，不是漂移）。调用方若缓存了旧版本号，拿到的是正确的 `VERSION_CONFLICT`。`application.record_version` 保持 `2`（加外键/改默认值不碰行）。

---

## 6. 回填规则（D-21）与"此后禁止 max()"

```
迁移时刻：对每个 current_rubric_version_id is null 的 job
          取它自己 version_no 最大的 rubric（同版本号再按 created_at, id 定序）
```

- 迁移时刻没有任何"曾经回滚过"的历史可依赖，取最高版本是**唯一不撒谎的初值**；
- 回填完成后 **本列就是权威**：任何代码（插件、工具、报表）都**不得**再用 `max(version_no)` 推导当前版本；
- 回滚到旧版本 = 把指针改成旧 rubric 的 id（`0004` 的 POS-02 已实测：指向本岗位的旧版本被允许）；
- 指向别的岗位的 rubric → `23503`（NV-02 已实测）。

---

## 7. 与 D-23 字面写法的一处偏离（**需总控确认**）

D-23 写的是 `stage_catalog(code PK, name, sort_order, in_v1_scope)`。本实现是
`uuid 主键 + tenant_id + unique(tenant_id, code)`，外键指向 `(tenant_id, code)`。

**为什么不能照字面做**：

1. `SCHEMA.md §1` 全局约定：主键 = 单列 uuid（`gen_random_uuid()`）；除 `organization` 外每表 `tenant_id NOT NULL` + 外键。
2. `db/verify.sql §2` 的结构断言（**没有改它，是它本来就这么写**）：
   - STRUCT-01：每张表必须是**单列 uuid 主键，且列名是 `id` 或 `event_id`**；
   - STRUCT-02：除 `organization` 外每张表必须有 **NOT NULL `tenant_id`**；
   - STRUCT-03：有 `tenant_id` 就必须有到 `organization` 的外键。
   → `code text primary key` + 无 `tenant_id` 会让 `verify.sql` 在 §2 直接 FAIL。
3. 阶段目录本来就是**按租户**的配置（`0002` 的 `business_config` 是 `scope='ORGANIZATION'`）。全局 `code` 主键反而会让"A 企业改了 S7 的名字"影响 B 企业。

**强度没有降低**：写入 `current_stage_code` 时，`(tenant_id, current_stage_code)` 必须命中 `(tenant_id, code)` 唯一键 —— 与"指向 code 主键"是同一件事，且多了一层租户隔离。NV-01 / NV-08 两条负向测试分别验证"不存在的 code"与"别的租户才有的 code"都被拒。

若总控坚持字面口径（`code` 主键、目录全局、表无 tenant_id），需要同时接受：`verify.sql` STRUCT-01/02/03 变红 + 目录失去租户隔离。**这一处请裁决后回抄 SCHEMA.md / D-23。**

---

## 8. 连带修正：`application.current_stage_code` 默认值 `'SCREENING'` → `'S6'`

`0001` 把该列的默认值写成 `'SCREENING'`。D-22 已宣告五档粗粒度值作废，`'SCREENING'` 不在 S1–S12 里。
如果不改默认值：**任何"不写阶段就插入申请"的语句都会永远撞外键**，报错指向 `fk_application_stage_catalog` 而不是"默认值过期" —— 换个方式继续静默。

故 `0004` 里 `alter column current_stage_code set default 'S6'`（`0002 §7` 的既有流程就是 S6 Intake 起步 → S7 初筛；`SET DEFAULT` 幂等）。
**这属于 D-22 的必然推论，不在 D-23 字面范围内，已在回传里标出**；若要保留 `'SCREENING'` 请明确指示（那样所有省略该列的写入都会失败）。

---

## 9. 已知冲突：既有 `db/verify.sql` 在加外键后必红（**未修，需授权**）

`db/verify.sql:394-398`（§5 夹具）插入一条 application，**显式写死** `current_stage_code='SCREENING'`。
D-23 的外键要求"目录外的 code 必须被拒"，`'SCREENING'` 不在 S1–S12 —— 两者**逻辑上互斥**，不是实现选择问题：

- 任何"能拒绝 `'SCREENING'`"的设计都会让这条夹具失败；
- 任何"让这条夹具通过"的设计都等于放行脏 code（D-23 未达成）。

实测（同一库，先后顺序）：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 0001+0002，**未加** 0004 | `psql -f db/verify.sql` | **`VERIFY PASS`，exit 0**（基线是绿的） |
| 再加 0004 | `psql -f db/verify.sql` | **exit 3**，`db/verify.sql:398: 错误: 插入或更新表 "application" 违反外键约束 "fk_application_stage_catalog"`；`描述: 键值对(tenant_id, current_stage_code)=(aaaaaaaa-0000-0000-0000-000000000001, SCREENING)没有在表"stage_catalog"中出现` |
| 把 verify.sql 复制到 `%TEMP%` 打 **2 处补丁** 后跑 | 同上 | **`VERIFY PASS`，exit 0** |

2 处补丁（**没有改仓库里的 verify.sql**，写范围不允许）：

1. 夹具租户 `aaaaaaaa-…-0001` 建好后，给它种一份同样的目录（`select … from stage_catalog where tenant_id='1111…0001'`）；
2. `db/verify.sql:398` 的 `'SCREENING'` → `'S7'`。

除这两处外，`verify.sql` 的 7 条结构断言 / 12 条状态机 / 36 行对象覆盖 / 32 条负向测试 / 正向断言**全部仍然通过** —— 即 0004 没有破坏任何既有不变量，唯一"破坏"是夹具里那个已作废的 code。
**修法请总控裁决**（改夹具 vs 改 D-23），本文件不擅自改。

### 9.1 另一条跨 lane 的红（不是 0004 引起的）

`0003_review_queue.sql` 的三张表主键列名是 `run_id` / `item_id` / `audit_id`。
只要 0003 在库里，`verify.sql` §2 就 FAIL：

```
psql:db/verify.sql:174: 错误: STRUCT-01 这些表的主键不是单列 id/event_id：conversion_run, review_queue, review_audit
```

实测（0001→0002→0003→0004）：exit 3，失败点在 STRUCT-01，**根本没走到 §5 的夹具**。
即"四支迁移全链 VERIFY PASS"当前不成立，与 0004 无关；请 0003 的 lane 决定是改列名还是改 `verify.sql` 的断言口径。

---

## 10. 怎么跑（含自检）

```powershell
$env:PGPASSWORD = '<密码>'
$env:PGCLIENTENCODING = 'UTF8'            # Windows 控制台中文不乱码
$psql = 'D:\12412\PostgreSQL\bin\psql.exe'

& $psql -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE IF EXISTS ra_stage_check WITH (FORCE);" -c "CREATE DATABASE ra_stage_check;"
& $psql -U postgres -h 127.0.0.1 -d ra_stage_check -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
& $psql -U postgres -h 127.0.0.1 -d ra_stage_check -v ON_ERROR_STOP=1 -f db/migrations/0002_seed.sql
& $psql -U postgres -h 127.0.0.1 -d ra_stage_check -v ON_ERROR_STOP=1 -f db/migrations/0004_stage_catalog.sql
& $psql -U postgres -h 127.0.0.1 -d ra_stage_check -v ON_ERROR_STOP=1 -f db/migrations/0004_stage_catalog.sql   # 第二遍：幂等
& $psql -U postgres -h 127.0.0.1 -d ra_stage_check -v ON_ERROR_STOP=1 -f db/verify-0004.sql
```

- **不要加 `-1`**（文件自带 `begin/commit`）。
- `verify-0004.sql` 自带 `begin … rollback`，跑完**不改变数据库任何一行**，可反复跑。
- 只指向一次性自建库。**不要**对 `recruitment_os` 或任何已有业务库执行。

---

## 11. 实测记录（2026-11-13，PG 17.11，库 `ra_stage_check`）

| # | 步骤 | exit | 关键输出 |
|---|---:|---:|---|
| 0 | DROP/CREATE `ra_stage_check` | 0 | `DROP DATABASE` / `CREATE DATABASE` |
| 1 | `0001_init.sql` | 0 | `CREATE TRIGGER` / `COMMIT` |
| 2 | `0002_seed.sql` | 0 | `UPDATE 1` / `COMMIT` |
| 3 | `db/verify.sql`（**未加 0004**，基线） | 0 | `VERIFY PASS：结构断言 + 状态机覆盖 + 对象覆盖 + 32 条负向测试全部通过` |
| 4 | `0004_stage_catalog.sql` 第 1 遍 | 0 | `INSERT 0 12` / `UPDATE 1` / `COMMIT`；`0004 PRE-FK PASS`、`0004 POST-CHECK PASS` |
| 5 | `0004_stage_catalog.sql` 第 2 遍 | 0 | `INSERT 0 0` / `UPDATE 0` / `COMMIT` |
| 6 | `db/verify-0004.sql` | 0 | `VERIFY-0004 PASS`；V4-01…V4-06 + NV-01…NV-08 + POS-01/02 全 PASS |
| 7 | `db/verify.sql`（加 0004 后） | **3** | `verify.sql:398 … 违反外键约束 "fk_application_stage_catalog"`（见 §9） |
| 8 | 临时补丁副本（`%TEMP%`，非仓库文件） | 0 | `VERIFY PASS`（证明只差 §9 的 2 处夹具口径） |

对象数变化（`0004` 前后）：**表 39→40 · 外键 161→164 · 唯一 55→58 · CHECK 181→184 · 触发器 72→72**。
（新增 = 1 表 + 3 外键〔本表 tenant 外键 + 两个新外键〕+ 3 唯一 + 3 CHECK；触发器**没有**新增，理由见 §12.2。）

12 行回读（`order by sort_order`）：

```
 code |           name           | sort_order | in_v1_scope
------+--------------------------+------------+-------------
 S1   | 招聘需求发现             |          1 | f
 S2   | Requisition 创建与审批   |          2 | f
 S3   | Job / JD / Rubric 设计   |          3 | t
 S4   | Job Posting 发布         |          4 | f
 S5   | 人才获取 / Sourcing      |          5 | f
 S6   | 简历接入与处理（Intake） |          6 | t
 S7   | 初筛 / Screening         |          7 | t
 S8   | 面试规划与排期           |          8 | t
 S9   | 面试执行与材料获取       |          9 | t
 S10  | 综合评价与招聘决策       |         10 | t
 S11  | Offer 与入职交接         |         11 | f
 S12  | 人才沉淀与复盘           |         12 | f
(12 行记录)
```

回填回读：

```
    code     |      current_rubric_version_id       | rubric_belongs_to_same_job | version_no
-------------+--------------------------------------+----------------------------+-----------
 DEMO-BE-001 | 11111111-1111-4111-8111-000000000403 | t                          |          1
```

负向测试（`verify-0004.sql` §4 真实返回，不是自述）：

| 编号 | 用例 | 期望 | 实际 SQLSTATE | 实际约束 |
|---|---|---:|---|---|
| NV-01 | 写不存在的 stage code `S99` | 23503 | 23503 | `fk_application_stage_catalog` |
| NV-02 | `current_rubric_version_id` 指向**别的 job** 的 rubric | 23503 | 23503 | `fk_job_current_rubric` |
| NV-03 | 插入重复 stage code（同租户再插 `SX1`） | 23505 | 23505 | `uq_stage_catalog_tenant_code` |
| NV-04 | 删除被 application 引用的 stage code `S7` | 23503 | 23503 | `fk_application_stage_catalog` |
| NV-05 | 两个阶段占同一 `sort_order` | 23505 | 23505 | `uq_stage_catalog_tenant_order` |
| NV-06 | `sort_order = 13` 越界 | 23514 | 23514 | `ck_stage_catalog_sort_order` |
| NV-07 | stage code 格式非法 `stage7` | 23514 | 23514 | `ck_stage_catalog_code` |
| NV-08 | 用**别的租户**才有的 code `SX1` | 23503 | 23503 | `fk_application_stage_catalog` |

正向断言：POS-01 合法 `S6→S7` 迁移 1 行成功（触发器照常写内部事件）；POS-02 指针指向本 job 的旧版本 1 行成功（**回滚场景不被误伤**）。

---

## 12. 未做的事 / 待裁决

1. **`db/verify.sql` 的夹具口径**（§9）：需要总控授权改 2 处，否则"加 0004 后 VERIFY PASS"做不到。**这是当前唯一挡住验收项 5 的东西。**
2. **目录行没有 `trg_stage_catalog_no_delete` 禁删触发器**：目录是**配置**，不是历史事实；"被引用就不能删"已由外键 `on delete restrict` 精确表达（`23503`）。未被引用的阶段允许删除 = 允许"退役一个没人用的阶段"。若总控认为目录行也应禁删，加 4 行即可（会让 NV-04 的 SQLSTATE 变成 23514）。
3. **单一权威**：`0004` 之后 `stage_catalog` **表**是运行时权威，`business_config(scope='ORGANIZATION', key='stage_catalog')` 退回"版本化输入快照"。将来改阶段名/顺序必须走新迁移并同步两边，否则 `verify-0004` 的 V4-03（双向 EXCEPT）会红 —— 这是故意留的"漂移报警"。**这条要不要写进 `SCHEMA.md §1`，请裁决**（我未改 SCHEMA.md）。
4. **C 线 `CONTRACT.md` 仍是五档**（APPLIED/SCREENING/…）：D-22 已裁定作废，但不在本写范围，需 C 线改。
5. **`decision.stage_code` 没有外键**：`verify.sql:455` 里的 `'INTERVIEW'` 同样是作废口径，但它没有 FK 也不进目录，本次不动（是否也要加目录外键 = 新决策）。
6. **编号**：`0003_review_queue.sql` 是另一条 lane 的（review queue），与本迁移无依赖；`0004` 的编号由总控指定，`0001 §8`/`SCHEMA.md` 说的"下一个是 0003"已过时，需要回抄。
