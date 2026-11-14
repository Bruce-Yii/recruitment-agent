# db/ · v1.0 领域库（PostgreSQL）

> **关于迁移文件头注释里的 `work/control/DECISIONS-2026-11-12.md:<行号>`**
> 那是**旧仓**（`D:\12412\dsh工作区\projects\recruitment-os`，冻结只读）的路径，在本仓库不存在。
> 该文件 530 行已逐字复制进本仓 **`docs/17-decision-ledger.md`**（唯一权威源，R5）。
> 已提交的迁移文件**不为了改注释而改动**（改注释会改变文件哈希，破坏既有验收记录里记录的 SHA256）；
> 引用时请按裁定编号去 `docs/17` 查，不要按行号。

**这里只有表结构、约束和自检脚本，没有业务代码。**
业务逻辑属于 DSH 插件里的工具实现（`docs/13` §1「工具即服务端」），本目录只负责：**让不变量在库里成立**。

| 文件 | 作用 |
|---|---|
| `migrations/0001_init.sql` | 建 schema / 39 张表 / 161 个外键 / 181 条 CHECK / 72 个触发器。**幂等**，可重复执行 |
| `migrations/0002_seed.sql` | 种子：租户、4 个 actor、12 条阶段目录、示例岗位 / rubric / 候选人 |
| `migrations/0003_review_queue.sql` | 转换层人工复核：`conversion_run` / `review_queue` / `review_audit` + 状态机触发器 |
| `migrations/0004_stage_catalog.sql` | `stage_catalog` 真表 + `application.current_stage_code` 外键 + `job.current_rubric_version_id` 显式指针 |
| `migrations/0005_version_binding.sql` | 申请绑定的 rubric / job 版本必须是**本岗位**的（三列复合外键，含 tenant_id） |
| `migrations/0006_integrity_gaps.sql` | 五个完整性缺口：`interview.stage_code` 默认值+外键、`execution_mandate` 禁 `submit_scorecard`、`fk_interview_record_artifact` 补 tenant_id、`business_task.owner_actor_id`、`meeting`/`meeting_binding` 的 `record_version` 触发器 |
| `migrations/0007_decision_integrity.sql` | 决策完整性（含 `decision.stage_code` 外键、`scorecard.job_id` 回填） |
| `migrations/0008_decision_uniqueness.sql` | 决策唯一性（`uq_decision_current`，DEFERRABLE EXCLUDE） |
| `migrations/0009_application_identity.sql` | 申请身份 `(tenant, candidate, job, ACTIVE)` 部分唯一 |
| `migrations/0010_migration_ledger.sql` | 迁移台账 `schema_migration`（0001–0009 回填 + 自登记；此后每条迁移自己登记自己） |
| `migrations/0011_task_runtime.sql` | 任务运行时：`task_wakeup` |
| `migrations/0012_engine_state.sql` | 执行引擎状态：`engine_*` 9 张表（trigger / disposition / trigger_thread / thread / ticket / decision / outbox / effect / kv） |
| `migrations/0013_trace_chain.sql` | 执行追溯：`tool_call` |
| `migrations/0014_tenant_config.sql` | 企业自建配置：`role` 扩列（权限范围/描述/版本）+ `hiring_team` / `hiring_team_member` + `pipeline_template` / `pipeline_template_stage` / `pipeline_template_stage_template` |
| `migrations/0015_runtime_cutover.sql` | 历史事件 cutover 水位：`runtime_watermark`（每租户一行/只进不退）+ `runtime_watermark_change`（append-only 审计）+ 三段显式写入函数 + 组织创建自动建水位 |
| `verify-0003.sql` … `verify-0010.sql` | 每个迁移配套自检，各自独立建库可跑，**全部通过才 exit 0**（0011–0015 的自检写在迁移文件内；CI 另有台账比对兜底） |
| `SCHEMA.md` | 对象 → 表/约束映射、状态机、不变量台账、缓做清单、映射裁决 |
| `verify.sql` | 自检：结构断言 + 状态机覆盖 + 对象覆盖 + **32 条负向测试** + 正向断言，**全部通过才 exit 0**，结尾 ROLLBACK 不改数据 |
| `README.md` | 本文件：怎么跑、怎么验、写入方必须遵守什么 |

---

## 1. 前置

- PostgreSQL **17**（本机 `D:\12412\PostgreSQL`，实测 17.11）
- `psql` 可用；**不需要任何扩展**（`gen_random_uuid()` 是 PG13+ 内置）
- **不要**指向已有业务库：本文档所有示例都用一次性自建库（如 `ra_schema_check`）

```powershell
$env:PGPASSWORD = '<密码>'
$psql = 'D:\12412\PostgreSQL\bin\psql.exe'
```

## 2. 建一个干净库

```powershell
& $psql -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE IF EXISTS ra_schema_check WITH (FORCE);" `
                                                   -c "CREATE DATABASE ra_schema_check;"
```

## 3. 跑迁移（空库 → 全量）

```powershell
# 按 0001→0015 顺序全链重放（每条都自带 begin/commit，幂等）
foreach ($f in Get-ChildItem db/migrations/*.sql | Sort-Object Name) {
  & $psql -U postgres -h 127.0.0.1 -d ra_schema_check -v ON_ERROR_STOP=1 -q -f $f.FullName
}
# 迁移配套自检（目录驱动：0011–0015 的自检写在迁移文件内，没有独立 verify-00XX）
foreach ($v in Get-ChildItem db/verify-*.sql | Sort-Object Name) {
  & $psql -U postgres -h 127.0.0.1 -d ra_schema_check -v ON_ERROR_STOP=1 -q -f $v.FullName
}
```

- **不要加 `-1`**：文件自带 `begin/commit`，再加 `-1` 会嵌套事务。
- **幂等**：再跑一次必须 exit 0、对象数不变。验证方法：

```powershell
& $psql -U postgres -h 127.0.0.1 -d ra_schema_check -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql   # 第二遍
& $psql -U postgres -h 127.0.0.1 -d ra_schema_check -t -A `
  -c "select 'tables='||count(*) from information_schema.tables where table_schema='recruitment';" `
  -c "select 'triggers='||count(*) from information_schema.triggers where trigger_schema='recruitment';"
# 0001_init.sql 单跑：期望 tables=39  triggers=72（两遍一致）——**这是 0001 基线**。
# 全链（0001→0015）实测（**2026-11-14 21:00**，`ra_s6s7`）：62 张基表 + 3 个视图（information_schema 口径 = 65）；
#   fn_block_delete 触发器 52 个、非内部触发器 117 个（`db/verify.sql` §1 实测）。
# 用 verify.sql 数基表时别把视图算进去，否则会得出 65 这个数。
```

输出里会有大量 `注意: 关系 ... 的触发器 ... 不存在，跳过` —— 这是 `DROP TRIGGER IF EXISTS` 的正常提示，不是错误。

## 4. 跑自检

```powershell
& $psql -U postgres -h 127.0.0.1 -d ra_schema_check -v ON_ERROR_STOP=1 -f db/verify.sql
# 期望：最后一行 VERIFY PASS，且 exit code = 0
```

`verify.sql` 覆盖：

| 节 | 内容 | 失败会怎样 |
|---|---|---|
| 1 | 对象清单计数 | 打印 |
| 2 | 7 条结构断言（主键 / tenant_id / 状态列有 CHECK / 状态表有审计触发器 / 禁删触发器数量 / 复合外键带 tenant） | `RAISE EXCEPTION` → exit ≠ 0 |
| 3 | 12 条状态机取值逐值核对 | 同上 |
| 4 | docs/03 §1 三十六行逐行覆盖（表不存在即失败） | 同上 |
| 5 | 夹具（结束回滚） | — |
| 6 | **32 条负向测试**，逐条打印真实 `SQLSTATE § message_text` | 某条没失败 / SQLSTATE 不符 → 失败 |
| 7 | 正向断言（合法路径不被堵死、乐观并发生效、合并保留历史） | 同上 |
| 8 | 十条最小不变量台账 | 打印 |
| 9 | 行数核对 + `ROLLBACK` | 脚本不留下任何数据 |

> 脚本必须用 **psql** 跑（里面用了 `\echo` 元命令）。用别的客户端请把 `\echo` 行删掉。

## 5. 连接方式（插件侧）

所有对象在 schema **`recruitment`**，不在 `public`（防与同库其它项目撞名）。两种接法：

```sql
-- ① 每条 SQL 带 schema 前缀（推荐，显式）
select * from recruitment.candidate where id = $1;

-- ② 连接级设置 search_path
-- DSN 示例（密码用环境变量，不要写进文件）：
-- postgresql://<user>:<password>@127.0.0.1:5432/<db>?options=-csearch_path%3Drecruitment%2Cpublic
```

**不要改这些表的属主/权限策略来"省事"**：本文档不涉及权限管理，v1.0 单租户、单应用连接。

## 6. 写入方必须遵守的 3 条硬规则

### 6.1 状态迁移必须给出 actor

```sql
begin;
set local recruitment.actor_id = '11111111-1111-1111-1111-111111111111';  -- 或显式写 status_changed_by_actor_id
update recruitment.application set current_stage_code = 'INTERVIEW' where id = $1;
commit;
```

没给 actor → `ACTOR_REQUIRED`（SQLSTATE 23514）。这不是麻烦，是不变量 8 的唯一落点：**每次状态迁移都会自动写一条内部事件并回填 `status_source_event_id`**，事后可追溯是谁、何时、从什么改到什么。

`SET LOCAL` 只在当前事务有效，用完即失效（这正是我们要的：工具每次执行都要重新校验授权）。

### 6.2 乐观并发：改状态必须带 `record_version`

```sql
update recruitment.application
   set lifecycle_status = 'CLOSED'
 where id = $1
   and record_version = $expected_record_version;   -- 0 行 = VERSION_CONFLICT，立刻回滚并重读
```

`record_version` 由触发器自动 +1，**不要手写**。

### 6.3 不许物理删除

52 张表装了 `trg_*_no_delete`（`fn_block_delete` 触发器，`verify.sql` STRUCT-06 实测 52 个，2026-11-14 21:00 `ra_s6s7` 实测），`DELETE` 直接报 `DELETE_FORBIDDEN`。要"删"就软关闭（状态迁移）或新建版本。

## 7. 常见报错 → 怎么处理

| 报错前缀 | SQLSTATE | 含义 | 正确反应 |
|---|---|---|---|
| `ACTOR_REQUIRED` | 23514 | 状态迁移没给 actor | `SET LOCAL recruitment.actor_id` 后重试 |
| `STATUS_AUDIT_TAMPER` | 23514 | 想手改 `*_changed_at` / `*_source_event_id` | 不要伪造时间；走真正的状态迁移 |
| `IMMUTABLE_COLUMN` | 23514 | 改了不可变的历史列（原文 / 配置版本 / 已提交评价） | 新建版本，不要改旧行 |
| `DELETE_FORBIDDEN` | 23514 | 物理删除历史事实 | 软关闭 / 新建版本 |
| `SCORECARD_IMMUTABLE` | 23514 | 改已提交的面评 | 新建 `revision_no`，旧行 `superseded_by_scorecard_id` 指向新行 |
| `APPROVAL_FINAL` | 23514 | 改已决审批 | 新建审批，旧审批置 `SUPERSEDED` |
| `CANDIDATE_IDENTITY_UNTRACKED` | 23514 | 绕过 Merge Record 直接改身份状态 | 先写 `candidate_merge` |
| `MERGE_SURVIVOR_NOT_ACTIVE` / `MERGE_TARGET_NOT_ACTIVE` | 23514 | 合并双方不是 ACTIVE | 重读双方状态再合并 |
| 唯一约束冲突 | 23505 | 幂等键 / 强标识 / 有效租约 / 会议绑定 重复 | 见下表 |
| 外键冲突 | 23503 | 引用了不存在或**别的租户**的行 | 检查 `tenant_id` 是否传错 |

唯一约束冲突的具体含义：

| 约束 | 说明 |
|---|---|
| `uq_event_inbox_idempotency` | 同一来源事件重复到达 → **返回已有状态**，不要报错给上游 |
| `uq_business_task_idempotency` | 同一事件不重复建任务 → 复用已有 task |
| `uq_durable_effect_idempotency` | 重试沿用原 Effect ID → 复用已有 effect |
| `uq_task_attempt_active_lease` | 已有 Worker 持租约 → 不是重试，是竞争；让它过期或用 `fencing_token` |
| `uq_meeting_binding_active` | 会议已绑别的面试（Golden Path 的 409） |
| `uq_candidate_active_email` / `uq_candidate_active_phone` | 强标识已存在 → 走 `candidate_merge`，不要新建 ACTIVE 候选人 |
| `uq_scorecard_current` | 该面试官对该轮已有当前面评 → 修订请新建 `revision_no` |

## 8. 迁移纪律

1. **`0001_init.sql` 一旦被提交，不再修改语义**；改动写成 `0002_*.sql`、`0003_*.sql`。
2. 新迁移同样要幂等：`CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` / `DROP TRIGGER IF EXISTS` / 加约束放 `DO $$ ... IF NOT EXISTS (pg_constraint) ... $$`。
3. 新增表必须能在 `docs/03` 找到对应对象；找不到就先改文档，不要先建表。
4. 每次改完都要跑 `verify.sql`，并同步更新 `SCHEMA.md` 的映射表与不变量台账。

## 9. 这个目录不做什么

- 不写业务逻辑、不写 HTTP 路由、不写 DSH 工具（那些在插件包里）
- 不建 `docs/03` 没有的对象（唯一例外见 `SCHEMA.md` §6，且已列明理由）
- 不碰 `recruitment_os` 或任何已有业务库
- 不做生产级多租户/权限/分区（v1.0 不需要，`docs/05 §8`）

## 10. 本机实测记录

| 项 | 结果 |
|---|---|
| 环境 | Windows 11 + PostgreSQL 17.11（`D:\12412\PostgreSQL`） |
| 空库跑迁移 | `0001_init.sql` 单跑实测：39 表 / 161 外键 / 181 CHECK / 55 唯一 / 72 触发器（0001 基线） |
| 全链（0001→0015）实测 | **62 张基表 + 3 视图**（`verify.sql` §1 口径：62；`information_schema.tables` 含视图 = 65）；foreign_keys 217 / check 259 / unique 91 / partial 16 / triggers 117 / functions 41；`fn_block_delete` 52 个（**2026-11-14 21:00** `ra_s6s7` 实测） |
| 0015 落库 | `0015_runtime_cutover` 已应用到本机 `ra_s6s7`（台账 `applied_at = 2026-11-14 20:17:05 +08`）：+2 表（`runtime_watermark` / `runtime_watermark_change`）→ 62 基表 / 52 禁删触发器 / 117 触发器 / 41 函数；上一行已按此回抄。迁移文件已入库（commit `2329d2e`） |
| 幂等 | 同库连跑第二遍 exit 0，零 ERROR，对象数不变 |
| 自检 | `verify.sql` → `VERIFY PASS`，exit 0（32/32 负向测试按预期失败）；COV-01 = 有表 30 / 列映射 1 / 缓做 5 |
| 数据库 | 只在自建库 `ra_schema_check` 上执行；未触碰任何已有库 |
