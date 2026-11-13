# S3 岗位线 · 冻结接口规范（v1，2026-11-13）

> 本文件由 S3 模块 Owner 写，**只读**。子代理不得修改本文件。
> 依据：`docs/20 §4 D1`（薄而真实：创建/更新岗位、标准确认、真实读取、版本引用）、
> `contracts/job-screening/job-rubric-rules.md`（J-1..J-8、R-VAL-1..14、§4.2 current）、
> `contracts/job-screening/tool-contracts.md` §2（job_get 读侧已由 Lane C 实现，**不改**）。

## 0. 范围与文件所有权

可写：

- `src/tools/job-create.ts`（新建；本 lane 唯一源码文件）
- `test/unit/job-create.test.ts`、`test/integration/job-create.test.ts`（新建）
- `manual/job-line/**`（新建；`SPEC.md` 除外——不得修改）

禁止碰：`src/index.ts`、`application-intake.ts`、`screening-evaluate.ts`（只可 import `validateDimensions`）、
`src/db/**`、`src/document/**`、`src/tools/job-get.ts`（只读复用）、`db/**`、`contracts/**`、`converter/**`、
profile 目录、`cordis.patch.yml`。**不 commit、不 push。**

## 1. 业务裁决（已由 Owner 定，不得改）

1. **Agent 不替人批准标准。** `recruitment_job_create` / `_update` 只写 `approval(status='PENDING')`；
   批准是**人类动作**，由导出的 `decideRubricApproval()` 完成（CLI `manual/job-line/approve-rubric.mjs`，
   后续 W0 的 Web 按钮复用同一函数）。理由：`APP-07` / `docs/20 §2` 的人类闸门不可由模型冒充。
2. **版本不可变。** 改 JD / 标准 = 新建 `job_version` / `rubric_version`（`version_no = max+1`），
   旧行一个字节都不 UPDATE（`J-1`、`trg_rubric_version_immutable`、`trg_job_version_immutable`）。
   `rubric_version.approved_by_approval_id` 因此永远留 null；读侧只按 `approval` EXISTS 判批准（§4.2 第 3 条）。
3. **`current(job, as_of)` 仍由读侧推导**（`job_get`），写侧**不**新增 current 指针，不改库。
4. **缺标准是合法状态**：`criteria` 可省略 → 只建 job + job_version；`job_get` 返回 `NO_RUBRIC_AT_ALL`。
5. **不新增 DB schema**（停止条件）：只用 `0001..0009` 已有表/约束/触发器。

## 2. 导出 API（冻结）

```ts
export const JOB_CREATE_TOOL = 'recruitment_job_create'
export const JOB_UPDATE_TOOL = 'recruitment_job_update'
export const CONTRACT_VERSION = '1.0.0'

export interface JobWriteConfig { readonly database: ResolvedDatabaseConfig }

export function createJobCreateTool(database: ResolvedDatabaseConfig): ReadonlyToolDefinition
export function createJobUpdateTool(database: ResolvedDatabaseConfig): ReadonlyToolDefinition
export function unconfiguredJobCreateTool(issues: readonly string[]): ReadonlyToolDefinition
export function unconfiguredJobUpdateTool(issues: readonly string[]): ReadonlyToolDefinition

// 事务级核心（集成测试用，放进必回滚事务；工具包装 = 解析 + 连接池 + withActor）
export async function createJobInTransaction(
  client: DatabaseClient, cfg: ResolvedDatabaseConfig, args: Record<string, unknown>,
): Promise<JobWriteValue>
export async function updateJobInTransaction(
  client: DatabaseClient, cfg: ResolvedDatabaseConfig, args: Record<string, unknown>,
): Promise<JobWriteValue>

// 人的批准动作（不是模型工具）
export interface DecideRubricApprovalInput {
  readonly approval_id: string
  readonly decision: 'APPROVE' | 'REJECT'
  readonly reason?: string
}
export interface DecideRubricApprovalValue {
  readonly approval_id: string
  readonly status: 'APPROVED' | 'REJECTED'
  readonly resource_type: 'RUBRIC_VERSION'
  readonly resource_id: string
  readonly job_id: string
  readonly rubric_version_no: number
  readonly canonical_payload_hash: string
  readonly decided_by_actor_id: string
  readonly decided_at: string
  readonly record_version: number
}
export async function decideRubricApprovalInTransaction(
  client: DatabaseClient, cfg: ResolvedDatabaseConfig, input: DecideRubricApprovalInput, actorId?: string,
): Promise<DecideRubricApprovalValue>
export async function decideRubricApproval(
  database: ResolvedDatabaseConfig, input: DecideRubricApprovalInput, actorId?: string,
): Promise<DecideRubricApprovalValue>

// 纯函数（单测可覆盖）
export function normalizeCriteria(criteria: readonly unknown[]): readonly Record<string, unknown>[]
export function mapDatabaseError(error: unknown): RecruitmentToolError
```

`RecruitmentToolError` / `contractError` / `digestOf` 全部复用现有模块，不另造错误体系。

## 3. `recruitment_job_create` 入参

| 参数 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `title` | string | ✅ | trim 后 1–200 |
| `code` | string | — | `^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$`；省略则生成 `JOB-<YYYYMMDD>-<6位大写hex>` |
| `department_id` | uuid | — | 与 `department_name` 互斥 |
| `department_name` | string | — | trim 后 1–200，大小写不敏感精确匹配 |
| `description_md` | string | — | ≤ 20000 |
| `requirements_md` | string | — | ≤ 20000 |
| `status` | enum | — | `DRAFT` \| `OPEN`，默认 `DRAFT` |
| `criteria` | object[] | — | 1–50 条，见 §5；省略 = 不建 rubric |

**部门解析顺序**：`department_id` → `department_name` → 该租户唯一部门（恰好 1 个时）。
解析不到 → `INVALID_ARGS / DEPARTMENT_NOT_FOUND`，`detail.known_departments = [{id,name}]`；
租户有多个部门且未指定 → `INVALID_ARGS / DEPARTMENT_REQUIRED`（同样列出候选）。

**JD**：`description_md` 与 `requirements_md` 都省略时，写 `description_md = title`，
并在输出 `job_version.jd_source = "TITLE_PLACEHOLDER"`；否则 `jd_source = "PROVIDED"`。
（`ck_job_version_content` 要求至少一个非空，且不伪造真实 JD 内容。）

**写序（同一事务）**：

1. `select kind from actor where id=$cfg.actor_id and tenant_id=$cfg.tenant_id`，0 行 → `FORBIDDEN / ACTOR_NOT_IN_TENANT`。
2. 解析部门（§上）。
3. 归一化 + 校验 criteria（§5），`payload_hash = digestOf(normalized)`。
4. `insert into job(tenant_id, department_id, code, title, status) returning ...`。
5. `insert into job_version(tenant_id, job_id, version_no=1, description_md, requirements_md, payload_hash, created_by_actor_id)`
   —— `payload_hash = digestOf({ description_md, requirements_md })`（最终值，含 null）。
6. 有 criteria 时：`insert into rubric_version(tenant_id, job_id, version_no=1, dimensions, payload_hash, created_by_actor_id) returning id`；
   `insert into approval(tenant_id, resource_type='RUBRIC_VERSION', resource_id, resource_record_version=1,
   payload_schema_version=1, canonical_payload_hash=payload_hash, status='PENDING', requested_by_actor_id)`。
7. `update job set current_job_version_id=$new where id=$job`（`RETURNING` 取 `record_version`、`status_changed_at`）。

## 4. `recruitment_job_update` 入参

| 参数 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `job_id` | uuid | ✅ | 必须属于配置租户 |
| `expected_record_version` | integer | — | ≥1；与库中不一致 → `INVALID_ARGS / VERSION_CONFLICT` |
| `title` | string | — | trim 后 1–200 |
| `description_md` / `requirements_md` | string | — | ≤20000；任一给出即新建 `job_version`（未给的一侧沿用当前版本） |
| `criteria` | object[] | — | 1–50；与最近一版 hash 相同则不新建 |
| `status` | enum | — | 7 个合法状态；与当前相同则不更新 |

**更新规则**：

- `select ... from job where id=$1 and tenant_id=$2 for update`；0 行 → `NOT_FOUND / JOB_NOT_FOUND`。
- 新 `job_version.version_no = max(version_no)+1`；`payload_hash = digestOf({description_md, requirements_md})`；
  若 hash 与当前版本相同 → **不新建**，`changed.job_version=false`（幂等重试）。
- 新 `rubric_version.version_no = max(version_no)+1` + 新 `approval(PENDING)`；若与最近一版 hash 相同 → 不新建。
- 旧 `approval` **不** supersede（旧版本历史批准保持；读侧 `current` = 已批准里 version_no 最大）。
- job 的 `title/status/current_job_version_id` 合并为**一条** UPDATE（未变化则跳过）。
- 全部无变化 → `outcome='UNCHANGED'`。

## 5. `criteria` 归一化与校验（R-VAL-1..13 复用）

- 只允许 9 个键：`key,label,kind,weight,field,operator,value,question,notes`；多键由 `validateDimensions` 报
  `CRITERION_UNKNOWN_KEY`。
- `normalizeCriteria()`：每个对象补齐为**恰好 9 键**，缺省写 `null`（`required`/存在的键保留原值）；
  数组顺序保持。
- 校验次序：先 `validateDimensions(raw)`（能抓住多余键），再 `normalizeCriteria(raw)` 后 `validateDimensions(normalized)`
  （防御性二次校验）。任一违反 → `INVALID_ARGS`，`reason_code='RUBRIC_INVALID'`，
  `detail.violations = [{rule, reason_code, path, got}]`（沿用 `validateDimensions` 的返回结构）。
- `payload_hash` 用 `digestOf(normalized)`，落库的 `dimensions` 就是 normalized（JSONB 往返后 canonical 一致）。

## 6. 输出值（两种工具同形）

```jsonc
{
  "tool": "recruitment_job_create" | "recruitment_job_update",
  "contract_version": "1.0.0",
  "labels": { "provenance": "LIVE", "trigger": "MANUAL", "connection": "CONNECTED" },
  "outcome": "CREATED" | "UPDATED" | "UNCHANGED",
  "department": { "id": "uuid", "name": "研发部（演示）" },
  "job": {
    "id": "uuid", "code": "string", "title": "string", "status": "DRAFT",
    "department_id": "uuid", "requisition_id": null, "current_job_version_id": "uuid",
    "record_version": 1, "status_changed_at": "ISO"
  },
  "job_version": {
    "id": "uuid", "version_no": 1, "payload_hash": "64hex",
    "description_md": "string|null", "requirements_md": "string|null",
    "approved_by_approval_id": null, "jd_source": "PROVIDED" | "TITLE_PLACEHOLDER"
  },
  "rubric": {
    "version_id": "uuid", "version_no": 1, "payload_hash": "64hex",
    "criteria": [ /* normalized，逐字回显 */ ],
    "criteria_count": 2, "must_have_count": 2, "nice_to_have_count": 0, "disqualifier_count": 0,
    "is_approved": false,
    "approval": {
      "approval_id": "uuid", "status": "PENDING", "payload_schema_version": 1,
      "canonical_payload_hash": "64hex", "requested_by_actor_id": "uuid"
    }
  },
  "next_action": { "kind": "APPROVE_RUBRIC" | "READ_BACK", "job_id": "uuid", "approval_id": "uuid|null",
                   "verify_with": "recruitment_job_get" }
}
```

- `rubric` 可空（未给 criteria）；`job_version` 恒非空。
- 输出 schema 只用官方支持子集（`type/properties/required/additionalProperties/items/enum/oneOf`；
  无 `type:null`、无 type 数组）。可直接照 `job-get.ts` 的 `NULLABLE_*` 写法。
- `render()`：给人看的中文/英文混排，至少含 code/title/status、job_id、版本号、rubric 概览、
  `approval PENDING → 需人类批准`、`next: recruitment_job_get(job_id=…)`。

## 7. 错误契约（封闭）

统一 `contractError(code, {reason_code, message, detail?})`，消息即 `Error: <CODE>: <compact-json>`。

| 场景 | code | reason_code | detail |
|---|---|---|---|
| 未知参数/类型/缺必填/非法 UUID | `INVALID_ARGS` | 由 `collectArgViolations` 给出（`ID_NOT_UUID` 等） | `violations[]` |
| criteria 违反 R-VAL | `INVALID_ARGS` | `RUBRIC_INVALID` | `violations[]` |
| 部门解析不到/多个未指定 | `INVALID_ARGS` | `DEPARTMENT_NOT_FOUND` / `DEPARTMENT_REQUIRED` | `known_departments` |
| 岗位不存在（update） | `NOT_FOUND` | `JOB_NOT_FOUND` | `job_id` |
| 记录版本冲突 | `INVALID_ARGS` | `VERSION_CONFLICT` | `{expected, actual}` |
| 重复 code（**真 SQLSTATE**） | `INVALID_ARGS` | `DUPLICATE_JOB_CODE` | `{sqlstate:'23505', constraint:'uq_job_code', code}` |
| 其它唯一/外键/检查约束 | `INVALID_ARGS` | `UNIQUE_VIOLATION`/`FOREIGN_KEY_VIOLATION`/`CONSTRAINT_VIOLATION` | `{sqlstate, constraint, table}` |
| actor 不在租户 | `FORBIDDEN` | `ACTOR_NOT_IN_TENANT` | `{actor_id, tenant_id}` |
| 审批不存在/状态不对/hash 不匹配/拒绝缺理由 | `NOT_FOUND`/`INVALID_ARGS` | `APPROVAL_NOT_FOUND`/`APPROVAL_NOT_PENDING`/`PAYLOAD_HASH_MISMATCH`/`REASON_REQUIRED` | 对应 id/status |
| 其它数据库失败 | `READER_FAILED` | `DATABASE_FAILED` | `{sqlstate}`（沿用 screening 的既有映射） |
| 未配置 | `NOT_CONFIGURED` | `PLUGIN_NOT_CONFIGURED` | `{issues}` |

`mapDatabaseError` 必须保留 `error.code`（SQLSTATE）与 `error.constraint`，**不得吞掉**。

## 8. 工具 description 必须写清（模型每轮都能看见）

1. 这个工具做什么、job_id 从哪来、`recruitment_job_get` 用于读回。
2. criteria 的形状：9 个键、`kind` 三值、`weight` **Σ=1**（差 ≤1e-6）、机械型白名单
   （`timeline.covered_months_closed` / `work_experience.entry_count` / `education.entry_count` 配 `GTE|LTE`，
   `work_experience` / `education` 配 `EXISTS`+`true`）、判断型必须给 `question`、
   至少 1 条 `MUST_HAVE`/`DISQUALIFIER`、禁止 `name/phone/email/protected.*`。
3. 学位/学历、行业、软技能等**不在白名单**的要求必须写成判断型 `question`（例：
   "候选人是否具备本科及以上学历？"），**不得**编造字段。
4. 创建的 rubric 是 `PENDING`，**不算已批准**；在人类批准前 `recruitment_job_get` 会回
   `NO_APPROVED_RUBRIC`——这是预期状态，不是错误。
5. 前者 "3 年经验" = `timeline.covered_months_closed GTE 36`（单位月，整数）。

## 9. 测试要求

### 9.1 `test/unit/job-create.test.ts`（不连库）

- `parameters`：对象根封闭、`title` 必填、`criteria` 是 array of object、`assertSupportedJsonSchema` 通过。
- `output.schema`：`assertSupportedJsonSchema` 通过；样例值通过 `validateJsonSchemaValue`。
- `normalizeCriteria`：补 null、顺序不变、`undefined`→null、多余键不被静默吞掉（validate 报错）。
- R-VAL 负例：权重和 0.9 → `WEIGHT_SUM`；`field='name'` → `PROTECTED_ATTRIBUTE_IN_CRITERIA`；
  只有 `NICE_TO_HAVE` → `NO_DECIDING_CRITERIA`；未知键 → `CRITERION_UNKNOWN_KEY`。
- `mapDatabaseError`：`{code:'23505',constraint:'uq_job_code'}` → `DUPLICATE_JOB_CODE` 且消息里带 `23505`。
- 未配置替身：调用报 `NOT_CONFIGURED`，schema 仍封闭。
- `render()`：含 code、job_id、`PENDING`、`recruitment_job_get`。

### 9.2 `test/integration/job-create.test.ts`（连 `ra_s6s7`，**全部在回滚事务里**）

用 `test/integration/db.ts` 的 `testDatabaseConfig / createTestPool / inRolledBackTx / uniqueSuffix`，
调用 `createJobInTransaction` / `updateJobInTransaction` / `decideRubricApprovalInTransaction`：

1. 建岗位 + criteria → job/job_version/rubric_version/approval 四行都在；`approval.status='PENDING'`；
   `rubric.payload_hash === digestOf(rows.dimensions)`（R-VAL-14）。
2. 未给 criteria → 只有 job + job_version，无 rubric/approval 行。
3. 重复 code → 捕获 `DUPLICATE_JOB_CODE`，`detail.sqlstate === '23505'`。
4. 更新：v2 job_version、v2 rubric + 新 PENDING approval；旧 v1 行 `dimensions/payload_hash` 未变；
   job.current_job_version_id 指向 v2；再提交相同内容 → `outcome='UNCHANGED'`。
5. 批准：`decideRubricApprovalInTransaction(APPROVE)` → status APPROVED、decided_by_actor_id=actor、
   再批一次 → `APPROVAL_NOT_PENDING`；`REJECT` 无 reason → `REASON_REQUIRED`。
6. 租户隔离：用另一个 tenant_id 的 cfg 调 update → `JOB_NOT_FOUND`；approval 同理。
7. `UPDATE rubric_version SET dimensions=...` 直接写库 → 期望 SQLSTATE `23514`（J-1 库级兜底）。

### 9.3 `manual/job-line/**`（真实入口 + 证据）

- `plugin-entry.ts`：cordis 插件入口，`name='recruitment-job-line'`、`inject=['tools']`，
  `apply(ctx, config)` 用 `resolveDatabaseConfig(config?.database ?? {}, process.env)` 注册
  `createJobCreateTool` / `createJobUpdateTool`（未配置则注册 `unconfigured*`）。
  **不得**修改 `src/index.ts`；这是 W0 集成前本 lane 的临时入口。
- `patch.yml`：`- insert: [{id: recruitment-job-line, name: './plugin-entry.ts', config: {database: {...}}}]`
  （patch 相对路径 → file URL；`database` 与 profile 同参：127.0.0.1:5432/postgres/ra_s6s7、
  `password_env: RECRUITMENT_DB_PASSWORD`、seed tenant/actor）。
- `approve-rubric.mjs <approval_id> [--reject --reason <text>]`：人类批准动作，打印 JSON。
- `read-back.mjs <job_id>`：打印 `recruitment_job_get` 的 render + value JSON + 打码 SQL 行
  （`job` / `job_version` / `rubric_version` / `approval`；uuid 只留前 8 位 + `…`）。
- `negatives.mjs`：真实 PG 上跑负例并打印 `Error: ...` 原文（缺标准、未批准、非法 UUID、
  重复 code、权重和≠1、重复批准）。
- `extract-tool-trace.py <session-id|session.v3.jsonl.zstd>`：解压多帧 zstd，按顺序打印
  `tool/call`（name + arguments）与 `tool/result`（text 原文）。可参考
  `manual/natural-language-acceptance.py` 的 `read_events()`（`read_across_frames=True`）。
- `run-headless.ps1`：设 `$env:RECRUITMENT_DB_PASSWORD`，用
  `dsh --profile rec-agent-test --patch <abs patch.yml> "<一句话目标>"` 跑真实 headless，
  stdout/stderr 落盘到 `manual/job-line/evidence/<stamp>/`。**不修改 profile。**

## 10. 完成定义（缺一不算）

- `node --test`（`$env:RECRUITMENT_DB_PASSWORD='123456'`）四个数：tests / pass / fail / skipped，
  **fail=0、skipped=0**，且不低于基线 389 pass。
- `manual/job-line/negatives.mjs` 全部负例输出真实 `Error: ...`（含 SQLSTATE）。
- `dsh --profile rec-agent-test --patch manual/job-line/patch.yml --dump-config` 能看到
  `recruitment-job-line` 条目（证明插件入口可达，不花模型额度）。
- 代码风格与现有文件一致：中文注释解释“为什么”、JSDoc、无新依赖、ESM `.ts` 相对导入。
