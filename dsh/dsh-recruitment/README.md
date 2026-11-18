# `@recruitment/dsh-recruitment` · 怎么跑、怎么验

**当前注册 31 个工具（30 + email_fetch）**（`src/index.ts` 工具数组；配置齐/缺两条路径都注册；外层再套 `withToolCallTrace` 逐次留痕）：

| 阶段 | 工具 |
|---|---|
| 简历读 / 解析 | `recruitment_resume_read`、`recruitment_document_read`、`recruitment_resume_serialize`、`recruitment_structure_validate`、`recruitment_page_image`、`recruitment_model_text_merge` |
| S3 岗位 | `recruitment_job_get`、`recruitment_job_create`、`recruitment_job_update`、`recruitment_job_rubric_approve`（人类批准入口，过 `ctx.approval`） |
| S6 接入 | `recruitment_application_intake`、`recruitment_candidate_get` |
| 阶段推进 | `recruitment_application_stage_advance`（`application.current_stage_code` 的唯一写入口，N8） |
| S7 初筛 | `recruitment_screening_evaluate`（只读；人决定落库走 `recruitment_decision_record`） |
| S8 面试 | `recruitment_interview_schedule`（D-62 四 intent：CREATE / RESCHEDULE / CANCEL / WITHDRAW_INTERVIEWER）、`recruitment_interview_get` |
| S9 转写 | `recruitment_transcript_import`、`recruitment_transcript_read` |
| S10 评价 / 决策 | `recruitment_scorecard_submit`、`recruitment_evaluation_summarize`、`recruitment_decision_record` |
| 追溯 / 配置 | `recruitment_trace_get`、`recruitment_config_role`、`recruitment_config_team`、`recruitment_config_pipeline` |

> 本文 §1–§3 的建库 / 联调步骤与 S6/S7 测试仍是有效口径；S3/S8/S9/S10 的工具契约见
> `contracts/` 下对应子目录，不在本文件重复。

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
# 0001→0015 全链重放（0010 是迁移台账，跳步会 verify-0010 红；0011–0015 各自带自检）
foreach ($f in '0001_init','0002_seed','0003_review_queue','0004_stage_catalog','0005_version_binding','0006_integrity_gaps','0007_decision_integrity','0008_decision_uniqueness','0009_application_identity','0010_migration_ledger','0011_task_runtime','0012_engine_state','0013_trace_chain','0014_tenant_config','0015_runtime_cutover') {
  & $psql -h 127.0.0.1 -U postgres -d ra_s6s7 -v ON_ERROR_STOP=1 -q -f "db\migrations\$f.sql"
  Write-Output "EXIT_$f=$LASTEXITCODE"
}
foreach ($v in 'verify-0003','verify-0004','verify-0005','verify-0006','verify-0007','verify-0008','verify-0009','verify-0010','verify') {
  & $psql -h 127.0.0.1 -U postgres -d ra_s6s7 -v ON_ERROR_STOP=1 -q -f "db\$v.sql"
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

**正确跑法只有两种**（`node --test <目录>` 在 Node 24 + Windows 上会把目录当模块加载，
报 `Error: Cannot find module ...\test\acceptance` —— 那是"跑不起来"，**不是**"没有测试"、更不是"跳过"）：

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment
$env:RECRUITMENT_DB_PASSWORD='123456'

# 全部（默认：node --test 的文件级并行；run-all 自己展开 test/**/*.test.ts，不依赖 shell glob）
node test/run-all.mjs
# 等价于 pnpm test / npm test

# 串行（只用于排查并发问题；不是默认口径）
node test/run-all.mjs --test-concurrency=1

# 只跑某一类
node --test "test/unit/*.test.ts"          # 单元（不连库）
node --test "test/integration/*.test.ts"   # 集成（连 ra_s6s7，每个用例结束 ROLLBACK）
node --test "test/acceptance/*.test.ts"    # 验收门槛
node --test "test/runtime/*.test.ts"       # 运行时（每个文件一个一次性空库）
```

`package.json` 里有同名脚本：`test` / `test:serial` / `test:unit` / `test:db`。
**报数必须四个都看**：`tests / pass / fail / skipped`。`skipped > 0` 不算绿。
集成测试**不会静默 skip**：缺环境变量时直接失败，并提示先跑 §1.1（R3：skip 会让"没跑"看起来像"绿了"）。

### 2.0 并发跑（默认）的隔离模型

`node --test` 默认**并行跑测试文件**（每个文件一个子进程）。所有测试按下面三类隔离，
**不要**用 `--test-concurrency=1` 掩盖干扰、也不要给测试加 skip：

| 类型 | 用在哪 | 隔离方式 |
|---|---|---|
| **事务回滚**（默认） | 绝大多数 `test/integration/*.test.ts`、`test/acceptance/*.test.ts` | `inRolledBackTx()` 里造夹具，结束一律 `ROLLBACK`；事务是 `REPEATABLE READ`，**同一个快照**下做"写前 count / 写后 count"的零写入断言，别的并行文件提交行不会让它漂移 |
| **一次性空库**（真提交） | `test/runtime/*.test.ts`、引擎 effect/outbox 相关（`test/acceptance/engine-gates.test.ts`、`test/integration/engine-*-pg.test.ts`） | `createIsolatedTestDatabase()` 建一个 `ra_<label>_<pid>_<rand>` 空库并按 0001→N 重放迁移，跑完 `DROP DATABASE ... WITH (FORCE)`；引擎的 effect 队列是**全局按 kind 消费**的（`src/engine/app/effects.ts`），只有独占库才不会互相偷行 |
| **提交 + 清理**（少数） | `test/integration/stage-advance.test.ts` 的已提交夹具、`tenant-config.test.ts` 的清理 | 只用唯一键（`uniqueSuffix()`）；**先提交删除，再单独验证**——验证失败不会把删除一起回滚（曾经放在同一事务里，断言一红就把夹具永久留在库里） |

守护这些纪律的是 `test/isolation.test.ts`：它静态扫描所有测试文件的"共享库裸写 / 整租户清引擎表 /
`advisory lock` 串行 / 固定未来时段"等反模式，并跨进程断言 `uniqueSuffix()`、`FILE_NAMESPACE`、
一次性库名**真的不重叠**。

`test/integration/db.ts` 是夹具底座（文件名不含 `.test`，不会被当成测试文件）。
它造的每一条 `candidate` / `application` / `rubric_version` / `approval` / `resume_version`
都在事务里，跑完即回滚。

### 2.1 单测覆盖什么（下表是 S6/S7 阶段的代表用例，不是全部）

> 31 个工具的单测还有：`job-create.test.ts`（S3）、`interview-*.test.ts`（S8）、`transcript-*.test.ts`（S9）、
> `evaluation-*.test.ts` / `evaluation-decision-record.test.ts`（S10）、`application-intake-structured.test.ts`、
> `vision-fallback.test.ts`（`webServer` 可选注入的守卫）等；另有 `stage-advance.test.ts`（N8）、
> `job-create-rubric-approve.test.ts`（N7）、`trace-integrity.test.ts`、`tenant-config-validate.test.ts`；
> 以 `test/unit/` 目录实际文件为准。

| 文件 | 守什么 |
|---|---|
| `db-config.test.ts` | 密码只从环境变量读、缺配置逐条列 issues、UUID 校验 |
| `args-contract.test.ts` | CONTRACT.md §2.2 散文格式**逐字不变** + 新 `Error: <CODE>: <compact-json>` 的 reason_code 分类 |
| `identity.test.ts` | IR-N1/N2 归一化、`AUTO_OK` 闸门、三档结论（新建/关联/拒绝） |
| `material.test.ts` | HARD issue 表、`parse_status` 映射、`parsed_fields` 白名单投影（不含 protected） |
| `screening-rules.test.ts` | P1/P2/P3/P5 探针、absent 降级、索引自洽、证据 sha 校验、R-VAL-1..13 |
| `screening-readonly.test.ts` | S7 模块图**无** INSERT/UPDATE/DELETE、不 import `withActor` |
| `output-schema.test.ts` | schema 只用 DSH 支持子集、**没有 `type:null`/type 数组**、输出值**无 null**、required/additionalProperties |

### 2.2 集成覆盖什么（下表是 S6/S7 阶段的代表用例，不是全部）

> S3/S8/S9/S10 的集成用例在 `test/integration/` 同名文件里（`job-create.test.ts`、
> `interview-{schedule,get}.test.ts`、`transcript-{import,read}.test.ts`、`evaluation-*.test.ts` 等）。

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
  converter:            # resume_read / document_read / serialize / validate / application_intake / page_image / model_text_merge 要
    python_bin: 'D:\Python3.12.9\python.exe'
    converter_dir: '...\converter'
    allowed_roots: ['...\converter\corpus\synthetic']
    timeout_ms: 60000
  database:             # 所有查 / 写库工具要：candidate_get / job_* / application_intake / screening_evaluate /
                        # interview_* / transcript_* / scorecard_submit / evaluation_summarize / decision_record
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

1. **错误消息两代并存；D-63 已裁定统一（不是"无权裁决"）**：`docs/17` D-63（`:491-494`）
   裁定一次性统一为 `Error: <CODE>: <compact-json>`，**不允许两套并存**（R5）。
   **现状仍未全部切换**：`resume-read` / `candidate-get` / `document-read` / `page-image` /
   `structure-tools` / `vision-fallback` 仍用 `parseArgs` 的散文格式（`src/tools/args.ts:23-24`），
   其余工具用 `parseContractArgs`。**接点**：把 `parseArgs` 的抛错换成 `parseContractArgs`，
   并同步改负例断言（`test/unit/args-contract.test.ts` 当前守着旧格式逐字不变——切换时必须一起改）。
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
   `warnings: RUBRIC_PIN_REQUIRED`。阶段停在 `S6`；推进到 `S7` 不是本工具代做——2026-11-14 起由
   `recruitment_application_stage_advance`（`src/tools/stage-advance.ts`，注册于 `src/index.ts:588`）
   作为唯一受控入口（N8 已实现，只承认已发生事实、不新增授权），见 `docs/18 §3`。
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
