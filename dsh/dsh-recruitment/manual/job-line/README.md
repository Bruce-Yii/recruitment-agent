# S3 · 岗位线（Job / Rubric）· 交付说明与验收手册

> Lane：D1（Issue #4 / docs/20 §4）。分支 `feat/unified-document-intake`。
> 本 lane **不 commit、不 push**；`src/index.ts`、profile、DB schema 均未改。
> 依据：`contracts/job-screening/job-rubric-rules.md`（J-1..J-8、R-VAL-1..14、§4.2）
> 与 `contracts/job-screening/tool-contracts.md` §2（读侧 `job_get` 由 Lane C 实现，本 lane 只复用）。

## 1. 这一刀切了什么

| 能力 | 入口 | 落库 |
|---|---|---|
| 建岗位（job + job_version v1 + 可选 rubric v1 + PENDING approval） | `recruitment_job_create` | `recruitment.job` / `job_version` / `rubric_version` / `approval` |
| 改岗位（追加 job_version / rubric_version，改 title/status） | `recruitment_job_update` | 同上，只追加版本（旧行一个字节不改） |
| 读岗位（当前已批准 rubric） | `recruitment_job_get`（Lane C，**未改**） | 只读 |
| 人类批准标准 | `decideRubricApproval()`（CLI / 未来 Web 按钮，**不是模型工具**） | `approval` → APPROVED/REJECTED |

**文件**

- 新建 `src/tools/job-create.ts`（2002 行；create/update 工具 + 事务核心 + 批准函数）。
- 新建 `test/unit/job-create.test.ts`（17 条）、`test/integration/job-create.test.ts`（7 条）。
- 新建 `manual/job-line/**`（临时插件入口、headless 脚本、负例、取证）。
- **没有改**：`src/index.ts`、`src/tools/job-get.ts`、`application-intake.ts`、`screening-evaluate.ts`、
  `src/db/**`、`db/**`、`contracts/**`、`converter/**`、profile 目录。

### 三条业务裁决（实现了，不是口号）

1. **Agent 不替人批准。** create/update 只写 `approval(status='PENDING')`；`APPROVED` 只能由
   `decideRubricApproval()` 写入，且决定者必须是本租户 `kind='HUMAN'` 的 actor。工具 description
   明确告诉模型"PENDING 是预期状态、不要声称已批准"。
2. **版本不可变。** 改 JD / 标准 = 追加 `version_no = max+1`；旧 `job_version` / `rubric_version`
   不 UPDATE（库里 `trg_*_immutable` 兜底，实测 23514）；旧 `approval` 不 supersede。
   `rubric_version.approved_by_approval_id` 恒为 null（列不可变），读侧按 §4.2 的 EXISTS 判批准。
3. **缺标准是合法状态。** 不给 `criteria` 就只建 job + job_version；`job_get` 回 `NO_RUBRIC_AT_ALL`。

## 2. 工具契约（模型可见）

### `recruitment_job_create`

| 参数 | 必填 | 说明 |
|---|---|---|
| `title` | ✅ | 1–200；只给标题时 `description_md = title` 且输出 `jd_source=TITLE_PLACEHOLDER` |
| `code` | — | `^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$`；省略则 `JOB-<YYYYMMDD>-<6 hex>` |
| `department_id` / `department_name` | — | 互斥；都省略时用"该租户唯一部门"，多个部门则 `DEPARTMENT_REQUIRED` |
| `description_md` / `requirements_md` | — | ≤20000 |
| `status` | — | `DRAFT`（默认）\| `OPEN` |
| `criteria` | — | 1–50 条，9 键封闭；Σweight=1；至少 1 条 MUST_HAVE/DISQUALIFIER |

criteria 三种写法（工具 description 里同样有）：

- 机械型：`{key,label,kind,weight,field,operator,value}`，白名单
  `timeline.covered_months_closed` / `work_experience.entry_count` / `education.entry_count`（GTE|LTE，整数），
  `work_experience` / `education`（EXISTS，`value:true`）；
- 判断型：`{key,label,kind,weight,question}`——**学位/行业/软技能只能这么写**；
- 注释：`notes` 可选。

输出：`outcome / department / job / job_version / rubric(可 null) / next_action`；`rubric.approval.status`
恒为 `PENDING`（本工具写的那一行）。

### `recruitment_job_update`

`job_id`（必填）+ `expected_record_version`（可选乐观锁）+ `title/description_md/requirements_md/status/criteria`。
- 新 JD → `job_version(version_no=max+1)`，未给的一侧沿用当前版本；hash 相同则**不新建**。
- 新标准 → `rubric_version(version_no=max+1)` + 新 `approval(PENDING)`；hash 与最近一版相同则**不新建**。
- 全无变化 → `outcome=UNCHANGED`（幂等重试安全）。

### 错误（真实 SQLSTATE）

`INVALID_ARGS`（`ID_NOT_UUID`/`RUBRIC_INVALID`+violations/`DEPARTMENT_*`/`VERSION_CONFLICT`/
`DUPLICATE_JOB_CODE`+`{sqlstate:'23505',constraint:'uq_job_code'}`/`CONSTRAINT_VIOLATION`+23514）、
`NOT_FOUND`（`JOB_NOT_FOUND`/`APPROVAL_NOT_FOUND`）、`FORBIDDEN`（`ACTOR_NOT_IN_TENANT`/`ACTOR_NOT_HUMAN`）、
`READER_FAILED`（`DATABASE_FAILED`）。消息形态沿用 `Error: <CODE>: <compact-json>`。

## 3. 跑测试（真实四数）

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment
$env:RECRUITMENT_DB_PASSWORD='123456'

node --test "test/unit/job-create.test.ts"          # 17 tests / 17 pass / 0 fail / 0 skipped
node --test "test/integration/job-create.test.ts"   #  7 tests /  7 pass / 0 fail / 0 skipped
node --test                                          # 全包
```

本轮全包实测：**tests 688 / pass 686 / fail 2 / skipped 0**。
2 条失败是 D4（`test/integration/evaluation-summarize.test.ts`，scorecard/decision 汇总），
**不是本 lane 的文件、不 import 本 lane 代码**（另一 lane 正在改 `evaluation-summarize.ts`）。
本 lane 的 24 条（17+7）全绿；`skipped=0`。

集成测全部在 `inRolledBackTx` 里跑，结束 `ROLLBACK`，不污染 `ra_s6s7`；缺环境变量直接红，不静默 skip。

## 4. 真实 headless（一句自然语言）

`src/index.ts` 归 W0，本 lane 不改；用 `--patch` 把两个**真实实现**以独立插件
`recruitment-job-line` 挂进同一个 `rec-agent-test` profile（patch 只在本命令生效，profile 未改）：

```powershell
$env:RECRUITMENT_DB_PASSWORD='123456'
dsh --profile rec-agent-test --patch "<repo>\dsh\dsh-recruitment\manual\job-line\patch.yml" `
  "建一个后端工程师岗位，标准是 3 年经验 + 本科；建好后把岗位读回来给我看。"
```

本轮实测（26s，exit 0，见 `evidence/20261113-195702/`）：

- Agent 自己把"3 年经验"转成 `timeline.covered_months_closed GTE 36`，把"本科"写成判断型
  `question="候选人是否具备本科及以上学历？"`，权重 0.5/0.5；
- `recruitment_job_create` → job `792a10f9-…`（code `JOB-20261113-D0EA8E`）；
- 紧接着 `recruitment_job_get` → `NO_APPROVED_RUBRIC`（PENDING 未批准，Agent 如实报告，没有冒充批准）；
- 人工批准后第二次 headless（`evidence/20261113-195939/`）→ `job_get` 读回
  `is_current=true, is_approved=true, executable=true`，两条 criteria 与建库时逐字一致。

复跑：

```powershell
pwsh -NoProfile -File manual\job-line\run-headless.ps1 -Goal "建一个后端工程师岗位，标准是 3 年经验 + 本科；建好后把岗位读回来给我看。"
D:\Python3.12.9\python.exe manual\job-line\extract-tool-trace.py --list
D:\Python3.12.9\python.exe manual\job-line\extract-tool-trace.py <session-id>
```

## 5. 人的批准 + DB 读回 + 负例

```powershell
# 1) 人类批准（PENDING → APPROVED；拒绝用 --reject --reason "…"）
node manual\job-line\approve-rubric.mjs <approval_id>

# 2) job_get 读回 + 四张表打码行
node manual\job-line\read-back.mjs <job_id>

# 3) 负例（真实写库；不删行，脚本会打印本次写入的 job_id 汇总）
node manual\job-line\negatives.mjs
```

负例实测（`evidence/20261113-195702/negatives.txt`，7/7 与契约一致）：

| # | 场景 | 真实结果 |
|---|---|---|
| ① | 只建岗位、无标准 | `job_get` → `rubric_absence.code=NO_RUBRIC_AT_ALL` |
| ② | 标准 PENDING 未批准 | `job_get` → `rubric_absence.code=NO_APPROVED_RUBRIC` |
| ③ | 非法 UUID | `INVALID_ARGS/ID_NOT_UUID`（`department_id='not-a-uuid'`、`job_id='job_0001'`） |
| ④ | 重复 code | `INVALID_ARGS/DUPLICATE_JOB_CODE`，`detail.sqlstate=23505`、`constraint=uq_job_code` |
| ⑤ | weight Σ=0.9 | `INVALID_ARGS/RUBRIC_INVALID`，violations 含 `R-VAL-6 WEIGHT_SUM` |
| ⑥ | 同一 approval 批两次 | 第二次 `INVALID_ARGS/APPROVAL_NOT_PENDING`（detail 带 `status=APPROVED`） |
| ⑦ | REJECT 缺 reason | `INVALID_ARGS/REASON_REQUIRED` |

## 6. 给 W0 的注册签名（**不改 `src/index.ts` 的回报**）

```ts
// src/index.ts 顶部
import {
  createJobCreateTool,
  createJobUpdateTool,
  unconfiguredJobCreateTool,
  unconfiguredJobUpdateTool,
} from './tools/job-create.ts'

// apply() 里，紧跟 jobGet 之后
const jobCreate = database.resolved === null
  ? unconfiguredJobCreateTool(database.issues)
  : createJobCreateTool(database.resolved)
const jobUpdate = database.resolved === null
  ? unconfiguredJobUpdateTool(database.issues)
  : createJobUpdateTool(database.resolved)

// tools 数组里加两项（放在 jobGet 之后、intake 之前）
const tools: readonly ReadonlyToolDefinition[] = [
  resumeRead,
  ...structureTools,
  candidateGet,
  jobGet,
  jobCreate,
  jobUpdate,
  intake,
  evaluate,
  pageImage,
  modelTextMerge,
]
```

**Web/CLI 的人类批准入口**（不要注册成模型工具）：

```ts
import { decideRubricApproval } from './tools/job-create.ts'
// 由 W0 的 Web 按钮 / 路由以"当前登录人类 actor"调用
await decideRubricApproval(database, { approval_id, decision: 'APPROVE' }, humanActorId)
```

`manual/job-line/plugin-entry.ts` + `patch.yml` 是 W0 集成前的临时入口；集成后可以删，不删也不影响。

## 7. 与合同/SPEC 的偏差（诚实清单）

1. `job_version` / `rubric.approval` 在**输出 schema** 里是 nullable（SPEC §6 写"恒非空"）。正常写路径恒非空；
   只有"历史岗位 current_job_version_id 为 NULL + update 不传 JD"这种旧数据才会 null。属防御，不改语义。
2. update 侧 `jd_source` 只能反推（`requirements_md IS NULL && description_md === title` → TITLE_PLACEHOLDER），
   若有人真把 JD 正文写成与标题完全相同会被误标。create 侧是精确标记。
3. `expected_record_version` 只做"给值时校验"；不给就乐观锁缺失（仍靠 `SELECT … FOR UPDATE` 串行化）。
4. SPEC §4 里 `changed.job_version=false` 这类内部标志没有单独输出；幂等结果用 `outcome=UNCHANGED` 表达。
5. `decideRubricApprovalInTransaction` 多两个入参校验码（`DECISION_INVALID`、`UNSUPPORTED_PAYLOAD_SCHEMA_VERSION`），
   以及 `FORBIDDEN/ACTOR_NOT_HUMAN`；都属收紧，不放松合同。
6. 空白的 `description_md` / `requirements_md` 归一成"未给"（否则会以 23514 失败，报错难读）。
7. **没做**：招聘需求审批、模板平台、Rubric 回滚指针、`job.current_rubric_version_id`（不改 schema）、
   Web UI（W0）；本 lane 只到"工具 + 真库 + headless 证据"。

## 8. 本轮证据

| 目录 | 内容 |
|---|---|
| `evidence/20261113-195702/` | 自然语言建岗位的 `tool/call`+`tool/result` 原文、人工批准、job_get 读回、四表打码行、R-VAL-14 复核、7 条负例 |
| `evidence/20261113-195939/` | 批准后的第二次 headless：Agent 读回 `is_approved=true / is_current=true` 并复述两条标准 |
