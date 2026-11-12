# `@recruitment/dsh-recruitment` · 怎么跑、怎么验

七个工具（`recruitment_resume_read` / `_resume_serialize` / `_structure_validate` /
`_candidate_get` / `_job_get` / **`_application_intake`（S6 写库）** /
**`_screening_evaluate`（S7 只读）**）。

S6/S7 的规则出处（本包内，不在本文件重复）：

| 文件 | 管什么 |
|---|---|
| `contracts/job-screening/tool-contracts.md` | S7 工具的入参/出参/错误码形状 |
| `contracts/job-screening/screening-rules.md` | 判定算法（三态、有界量、verdict 聚合） |
| `contracts/job-screening/job-rubric-rules.md` | Rubric 结构与版本解析（R-VAL / approved） |
| `contracts/identity/identity-resolution-rules.md` | 身份归一化与闸门 |
| `docs/16-design-rationale.md` §8 | 「D-46→D-52 身份规则简化到三条」 |

---

## 1. 环境

| 项 | 本机值 |
|---|---|
| PostgreSQL | 17.11 @ `127.0.0.1:5432`，超级用户 `postgres` |
| 库名 | **`ra_s6s7`**（本 lane 唯一使用的库；不要用别的） |
| Python | `D:\Python3.12.9\python.exe`（converter 需要） |
| 驱动 | `pg@8.23.1`，已在本包 `dependencies`（**不重装、不换**） |

密码**只从环境变量读**（默认 `RECRUITMENT_DB_PASSWORD`）；配置里只有变量名。

```powershell
$env:RECRUITMENT_DB_PASSWORD='123456'
```

### 1.1 建库 + 迁移（每步必须 exit=0）

```powershell
$psql='D:\12412\PostgreSQL\bin\psql.exe'
$env:PGPASSWORD='123456'; $env:PGCLIENTENCODING='UTF8'
& $psql -h 127.0.0.1 -U postgres -d postgres -c "create database ra_s6s7;"
cd D:\12412\dsh工作区\projects\recruitment-agent
foreach ($f in '0001_init','0002_seed','0003_review_queue','0004_stage_catalog','0005_version_binding','0006_integrity_gaps') {
  & $psql -h 127.0.0.1 -U postgres -d ra_s6s7 -v ON_ERROR_STOP=1 -q -f "db\migrations\$f.sql"
  Write-Output "EXIT_$f=$LASTEXITCODE"
}
```

### 1.2 演示夹具（可选，但 headless 要出真 verdict 就需要）

`0002_seed.sql` 的 rubric v1 没有 `approval` 行 ⇒ 按 `job-rubric-rules.md` §4.2 就是"未批准"
⇒ S7 只能返回 `NO_RUBRIC/NO_APPROVED_RUBRIC`。下面这条命令写一版**已批准**的 rubric v2
（两条机械型 `MUST_HAVE` + 一条判断型 `NICE_TO_HAVE`），`payload_hash` 用与工具同一份
`digestOf(canonicalJson(dimensions))` 算，保证 R-VAL-14 对得上：

```powershell
node manual/apply-demo-rubric.mjs      # 幂等；只写 rubric_version + approval + job 指针
```

---

## 2. 测试

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment

# 单元（不连库）
node --test "test/unit/*.test.ts"

# 集成（连 ra_s6s7，每个用例结束 ROLLBACK）
$env:RECRUITMENT_DB_PASSWORD='123456'
node --test "test/integration/*.test.ts"

# 全部（既有 73 条 + 新增）
node --test
```

**报数必须三个都看**：`tests / pass / fail / skipped`。`skipped > 0` 不算绿。
集成测试**不会静默 skip**：缺环境变量时直接失败，并提示先跑 §1.1（R3：skip 会让"没跑"看起来像"绿了"）。

`test/integration/db.ts` 是夹具底座（文件名不含 `.test`，不会被当成测试文件）。
它造的每一条 `candidate` / `application` / `rubric_version` / `approval` / `resume_version`
都在事务里，跑完即回滚。

### 2.1 单测覆盖什么

| 文件 | 守什么 |
|---|---|
| `db-config.test.ts` | 密码只从环境变量读、缺配置逐条列 issues、UUID 校验 |
| `args-contract.test.ts` | CONTRACT.md §2.2 散文格式**逐字不变** + 新 `Error: <CODE>: <compact-json>` 的 reason_code 分类 |
| `identity.test.ts` | IR-N1/N2 归一化、`AUTO_OK` 闸门、三档结论（新建/关联/拒绝） |
| `material.test.ts` | HARD issue 表、`parse_status` 映射、`parsed_fields` 白名单投影（不含 protected） |
| `screening-rules.test.ts` | P1/P2/P3/P5 探针、absent 降级、索引自洽、证据 sha 校验、R-VAL-1..13 |
| `screening-readonly.test.ts` | S7 模块图**无** INSERT/UPDATE/DELETE、不 import `withActor` |
| `output-schema.test.ts` | schema 只用 DSH 支持子集、**没有 `type:null`/type 数组**、输出值**无 null**、required/additionalProperties |

### 2.2 集成覆盖什么

`intake.test.ts`：幂等（同 `(sha256, job_id)` 不出第二条 application）、IR-N5 写规范形、
关联≠合并（不写 `candidate_merge`）、`resolve()` 命中 MERGED 档挂到存活档、
身份读不出 → `BLOCKED_BY_REVIEW` 且**一行不写**、`REGION_AMBIGUOUS_PHONE`、
OCR/平台噪声不得作标识、`parse_status` 三档、非本租户 actor、路径越界、
模型传 `actor_id` 被拒。

`screening.test.ts`：PASS / FAIL（A1+A2）/ NEEDS_REVIEW（absent、unreadable、indeterminate）/
GATE_JOB_CLOSED / GATE_APPLICATION_NOT_ACTIVE / BLOCKED（HQ-1/HQ-2/HQ-6/HQ-7）/
NO_RUBRIC（NO_APPROVED_RUBRIC、RUBRIC_INVALID、RUBRIC_HASH_MISMATCH、UNSUPPORTED_PAYLOAD_SCHEMA_VERSION）/
`RESUME_NOT_BELONG_TO_CANDIDATE` / what_if / **只读不变量**（`record_version`、decision 行数、
parse_status 全不变）/ **`withReadOnly` 里写库被数据库拒绝（25006）** / D-18 的 `SET LOCAL` 不泄漏。

---

## 3. 手工联调（真 PDF、真库）

```powershell
$env:RECRUITMENT_DB_PASSWORD='123456'
$env:PYTHONIOENCODING='utf-8'
node manual/s6s7-live.mjs [PDF 绝对路径]   # 默认 platform_noise.pdf
```

打印**不含**姓名/手机号/邮箱（只给 id、state、计数、错误码）。

> ⚠️ `converter/corpus/synthetic/platform_noise.pdf` 里是**真实个人资料**（放在合成语料目录里
> 是已知缺陷，见 `evidence/r2-tool-reachability-2026-11-13.md` §4-3）。它只用于本地联调，
> 证据文件里一律打码；不要把它提交进仓库（`.gitignore` 已忽略 `*.pdf`）。

---

## 4. 配置契约（`cordis.patch.yml` 的 `config` 段）

```yaml
config:
  converter:            # resume_read / serialize / validate / application_intake 要
    python_bin: 'D:\Python3.12.9\python.exe'
    converter_dir: '...\converter'
    allowed_roots: ['...\converter\corpus\synthetic']
    timeout_ms: 60000
  database:             # application_intake（写）/ screening_evaluate（读）要
    host: 127.0.0.1
    port: 5432
    user: postgres
    database: ra_s6s7
    password_env: RECRUITMENT_DB_PASSWORD   # 只放变量名，密码不进配置
    tenant_id: '<uuid>'
    actor_id: '<uuid>'
```

- 两段都缺 → 工具**仍然注册**，调用返回 `NOT_CONFIGURED` 并列出缺什么（不静默降级、不返回假数据）。
- `tenant_id` / `actor_id` **不接受模型传入**（`tool-contracts.md` §0 第 4 条）：入参里出现
  `tenant_id` / `actor_id` → `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)`。
- 写库只用 `withActor`（`SET LOCAL recruitment.actor_id`，**不用 `SET`**，D-18）；
  读库只用 `withReadOnly`（`begin transaction read only`，写语句被数据库拒绝）。

---

## 5. 已知偏差 / 缺口（必须与契约一起读）

1. **错误消息两代并存**（`tool-contracts.md` §4 第 6 条要求显式记录）：
   stub 三工具仍是 `CONTRACT.md` §2.2 的散文格式；S6/S7 用 `Error: <CODE>: <compact-json>`。
   理由：改掉旧格式会同时改 3 个已在用的工具与它们的负例断言，且本 lane 无权裁决"统一改"。
   **接点**：`src/tools/errors.ts` 的 `RecruitmentErrorCode` 已能同时承载两套；真要统一，
   只需把 `parseArgs` 的抛错换成 `parseContractArgs`。
2. **输出里没有 `null`**（契约里画成 `null` 的字段一律**省略键**）：DSH 校验器不支持
   `type` 数组（`dsh-tools/lib/types/json-schema.js:245`），`null` 会让整次调用
   `INVALID_TOOL_OUTPUT`。判断型的 `tri_state` 因此省略，用 `outcome='NEEDS_JUDGMENT'` 消歧
   （`screening-rules.md` §3.1 本来就要求两者一一对应）。
3. **`expected` 的标量拆成两个键**（`value_integer` / `value_boolean`）：同一个 schema 节点
   无法同时是 `boolean` 与 `integer`（DSH 不支持 `oneOf` 混标量），拆键比丢类型更可机检。
4. **`work_experience.entry_count` / `education.entry_count` 当前恒为 `INDETERMINATE`**：
   `converter` 的 `fields[*]` 目前不发布 `entry_count`（只有 `state/value/evidence/reason`）。
   按 `screening-rules.md` §3.2「取不到三态就 UNREADABLE，不猜」，这里降级为
   `INDETERMINATE`（"读到了 state，但量不可比"），**不判不满足**。
   **接点**：`converter/src/resume_fields.py` 发布 `entry_count` 后本项自然变可判。
5. **`IR-N2` ④ 的顺序副作用**：号码只要匹配 `^1[3-9]\d{9}$` 就先加 `+86`，再看显式国际前缀，
   所以 `+1 415 555 0100` 会被归一成 `+8614155550100`。两侧一致 ⇒ 匹配仍确定，但这是一条
   应回抄进 `identity-resolution-rules.md` 的已知缺陷（`test/unit/identity.test.ts` 有断言）。
6. **`decision` 表没有 `rubric_version_id` 列**：`prior_screening.rubric_version_id` 从
   `decision.basis_refs[]` 里回读（`tool-contracts.md` §3.7 的 `{kind:'RUBRIC_VERSION', id}`）；
   取不到就省略该键。库只校验 `basis_refs` 是 array（`0001_init.sql:1358`）。
7. **S6 建申请时不钉 `rubric_version_id`**：钉版本是写侧/人工动作（`job-rubric-rules.md` §4.3
   第 3 步），所以新申请的 S7 评估走 `JOB_CURRENT` 并输出 `rubric_pin_required=true` +
   `warnings: RUBRIC_PIN_REQUIRED`。阶段停在 `S6`（推进到 `S7` 也是一次状态迁移，不由本工具代做）。
8. **`manual/harness.manual.mjs` 在本次改动之前就已经跑不绿**（它用旧入参 `resume_id` 调
   `recruitment_resume_read`，且 `apply(ctx)` 不传 config ⇒ 直接 `NOT_CONFIGURED`；A 段还写死
   "恰好 3 个工具"）。本次没有修它（不在本 lane 范围），改用
   `manual/s6s7-live.mjs` + `manual/extract-session-tools.py` 做 S6/S7 的真实取证。

---

## 6. 从运行入口取证（R2 的标准做法）

```powershell
# 1) 配置树里确实有 database 段
dsh --profile rec-agent-test --dump-config | Select-String -Pattern 'recruitment|database|tenant_id|actor_id'

# 2) 真实 headless（一次调用两个工具；每次消耗真实模型额度，别反复试）
$env:RECRUITMENT_DB_PASSWORD='123456'
dsh --profile rec-agent-test "调用 recruitment_application_intake ..."

# 3) 从会话日志抓 tool/call + tool/result 原文（模型转述不算证据）
D:\Python3.12.9\python.exe manual\extract-session-tools.py `
  "D:\12412\dsh-home\sessions\--D-12412-dsh~5DE5~4F5C~533A-projects-recruitment-os--\<session>\session.v3.jsonl.zstd"
```

`manual/extract-session-tools.py` 会对手机号/邮箱打码（R7），并按 `callId` 把
`tool/call` 与 `tool/result` 配对（`tool/result` 事件本身不带工具名）。
