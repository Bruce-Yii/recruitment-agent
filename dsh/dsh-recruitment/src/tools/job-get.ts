// recruitment_job_get —— 查一个岗位 + 它此刻适用的 Rubric 版本（只读，直连 PG）。
//
// 为什么必须查库（Issue #1 §3 的验收硬指标）：旧版是 stub，给真实 UUID 会回
// `job "…" not found; known stub ids: job_0001, job_0002`，等于让 fixture 冒充工具面。
// 本文件只发 SELECT：读路径包在 `withReadOnly()` 的只读事务里，写语句会被数据库
// 直接拒成 `25006 read_only_sql_transaction`，不是"源码里没写 INSERT"这种自觉。
//
// 契约：`contracts/job-screening/tool-contracts.md` §2（**取代** `CONTRACT.md` §5 的
// stub 版工具面：入参从 `rubric_version: string` 改成 integer/uuid 两种，`stub` 字段删除，
// `provenance` 变成计算值）。与 §2 冲突时以该文件为准。
//
// 三个"不"（`tool-contracts.md` §0）：
//   1. 不落决策、不写 `decision`；
//   2. 不钉 `application.rubric_version_id`（钉版本是写侧的动作）；
//   3. 不接受模型传入的 tenant_id / actor_id（`parseContractArgs` 会直接拒）。
//
// 缺标准不报错：`job_get` 是**描述世界**的工具。"这个岗位还没有 Rubric" 是一条
// 可被查出来的事实（`rubric_absence`），不是异常。拒绝执行是 `evaluate` 的职责。
//
// D-141 第 6 条（2026-11-16 裁决）：除了 `job_id` 精确定位，还可以按 `code` / `title`
// 做**包含匹配**找岗位（`mode:'LOOKUP'` 的命中列表）。三个选择器必须**恰好给一个**；
// 多命中不替人挑（`needs_human_choice=true` + `next_tools=[]`）。只读不变。

import { parseContractArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { checkAsOf, contractError } from './contract.ts'
import { machineArgumentLines, shortHash, shortRef } from './render-ref.ts'
import { validateDimensions } from './screening-evaluate.ts'
// R4：`provenance` 的唯一判定实现（`contracts/tenant-provenance.md` §2）。
// 本工具**只读本产品业务库**，所以"读到了行"不等于"数据是真的"：演示租户的行同样真的在库里。
import { resolveTenantProvenance } from './candidate-get.ts'
import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'

const TOOL_NAME = 'recruitment_job_get'
const CONTRACT_VERSION = '1.0.0'

/** 三个查询选择器（D-141 第 6 条）：恰好给一个。 */
const SELECTOR_KEYS = ['job_id', 'code', 'title'] as const

/** 入参（`tool-contracts.md` §2.1；D-141 第 6 条加 code/title 包含匹配）。 */
const PARAMS: ParamMap = {
  job_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Job (requisition) id, UUID text form (e.g. 11111111-1111-4111-8111-000000000401). '
      + 'Exactly ONE of job_id / code / title must be given. Stub ids such as "job_0001" are rejected '
      + 'with INVALID_ARGS(ID_NOT_UUID).',
  },
  code: {
    kind: 'string',
    maxLength: 40,
    description: 'Job code, CONTAINS match (case-insensitive; leading/trailing whitespace and full-width spaces are '
      + 'normalized before both sides are compared). Exactly ONE of job_id / code / title must be given. '
      + 'Use it when you only know the code; the result is mode=LOOKUP with every match, and multiple matches '
      + 'set needs_human_choice=true (ask the human which job, do not guess).',
  },
  title: {
    kind: 'string',
    maxLength: 120,
    description: 'Job title, CONTAINS match (case-insensitive; whitespace/full-width spaces normalized). '
      + 'Exactly ONE of job_id / code / title must be given. Multiple matches set needs_human_choice=true '
      + '(ask the human which job, do not guess).',
  },
  rubric_version_no: {
    kind: 'integer',
    min: 1,
    max: 1000,
    description: 'Select this rubric version number (1-based). Mutually exclusive with rubric_version_id, and only '
      + 'accepted together with job_id (single-job mode) — it is rejected when code/title is used. '
      + 'Omit both to get the CURRENT version — i.e. the one job.current_rubric_version_id points at '
      + '(D-21/D-48), which is NOT necessarily the highest approved version_no.',
  },
  rubric_version_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Select this rubric version by id. Mutually exclusive with rubric_version_no, and only accepted '
      + 'together with job_id (single-job mode).',
  },
  as_of: {
    kind: 'string',
    maxLength: 40,
    description: 'ISO-8601 timestamp WITH an offset (e.g. 2026-11-13T00:00:00+08:00), not in the future. '
      + 'Decides which rubric version counts as current/approved. Defaults to the server clock. '
      + 'Accepted in all three selector modes (job_id / code / title).',
  },
}

/** `job` 行（只取本工具要展示的列）。 */
interface JobRow {
  readonly id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly department_id: string
  readonly requisition_id: string | null
  readonly current_job_version_id: string | null
  /**
   * D-21 的显式"当前 rubric"指针：**"当前"只由它说话，不是 `max(version_no)`**（D-48：
   * 指针为空 = 没有当前版本，不回退推导）。
   */
  readonly current_rubric_version_id: string | null
  readonly record_version: number
  readonly status_changed_at: string | Date
}

/** `job_version` 行。 */
interface JobVersionRow {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly description_md: string | null
  readonly requirements_md: string | null
  readonly approved_by_approval_id: string | null
}

/** `rubric_version` 行。 */
interface RubricRow {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly dimensions: readonly unknown[]
  readonly created_at: string | Date
  readonly approved_by_approval_id: string | null
  readonly created_by_actor_id: string | null
}

/** `approval` 行（判 `approved(v, as_of)` 只需要这几列）。 */
interface ApprovalRow {
  readonly resource_id: string
  readonly status: string
  readonly canonical_payload_hash: string
  readonly expires_at: string | Date | null
  readonly superseded_by_approval_id: string | null
}

/** 输出里的 rubric 块（`tool-contracts.md` §2.2）。 */
interface RubricValue {
  readonly version_id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly is_current: boolean
  readonly is_approved: boolean
  readonly approved_by_approval_id: string | null
  readonly created_by_actor_id: string | null
  readonly created_at: string
  readonly resolution: 'EXPLICIT_VERSION_NO' | 'EXPLICIT_VERSION_ID' | 'JOB_CURRENT'
  readonly criteria: readonly unknown[]
  readonly criteria_count: number
  readonly must_have_count: number
  readonly nice_to_have_count: number
  readonly disqualifier_count: number
  readonly executable: boolean
}

/** 输出规范值。 */
interface JobGetValue {
  readonly tool: string
  readonly contract_version: string
  readonly labels: {
    readonly provenance: 'LIVE' | 'FIXTURE'
    readonly trigger: 'MANUAL'
    readonly connection: 'CONNECTED' | 'NOT_CONNECTED'
  }
  readonly as_of: string
  readonly job: {
    readonly id: string
    readonly code: string
    readonly title: string
    readonly status: string
    readonly department_id: string
    readonly requisition_id: string | null
    readonly current_job_version_id: string | null
    readonly record_version: number
    readonly status_changed_at: string
  }
  readonly job_version: {
    readonly id: string
    readonly version_no: number
    readonly payload_hash: string
    readonly description_md: string | null
    readonly requirements_md: string | null
    readonly approved_by_approval_id: string | null
  } | null
  readonly rubric: RubricValue | null
  readonly rubric_absence: {
    readonly code: 'NO_RUBRIC_AT_ALL' | 'NO_APPROVED_RUBRIC' | 'RUBRIC_INVALID'
    readonly message: string
    readonly violations: readonly unknown[]
  } | null
  readonly rubric_versions: readonly {
    readonly version_no: number
    readonly version_id: string
    readonly is_current: boolean
    readonly is_approved: boolean
    readonly created_at: string
  }[]
}

/** LOOKUP 模式的一行命中（D-141 第 6 条）。 */
interface JobLookupMatch {
  readonly job_id: string
  readonly code: string
  readonly title: string
  readonly status: string
  /**
   * `job.current_rubric_version_id` → `rubric_version.version_no`。
   * 指针为空 / 查不到该版本 ⇒ 照实给 `null`（不是省略键：schema 用可空 oneOf 表达）。
   */
  readonly current_rubric_version_no: number | null
}

/** `next_tools[]`：与 `business-read.ts` 的 NextToolValue 同口径（`args_json` 是 JSON **字符串**）。 */
interface NextToolValue {
  readonly name: string
  readonly reason: string
  readonly args_json: string
}

/**
 * 本工具的统一出口（D-141 第 6 条）：**一个封闭根对象**，靠 `mode` 区分两种模式。
 *
 * `DETAIL`（job_id 单查）：`job` / `job_version` / `rubric` / `rubric_absence` /
 * `rubric_versions` 与改前**逐字段相同**；`matched=1`、`matches` 给本岗位一行摘要、
 * `needs_human_choice=false`、`next_tools=[]`。
 *
 * `LOOKUP`（code/title 包含匹配）：`job` / `job_version` / `rubric` / `rubric_absence`
 * 一律 `null`、`rubric_versions=[]`，命中明细全部在 `matches[]`；`matched` 是命中条数；
 * 多命中 `needs_human_choice=true` 且 `next_tools=[]`（不替人挑）。
 */
interface JobGetOutputValue {
  readonly tool: string
  readonly contract_version: string
  readonly labels: JobGetValue['labels']
  readonly as_of: string
  readonly mode: 'DETAIL' | 'LOOKUP'
  /** 命中条数（= `matches.length`）。DETAIL 路径恒为 1。 */
  readonly matched: number
  /** 命中多于一条 ⇒ true：必须问人（Agent 不得自己挑一条）。 */
  readonly needs_human_choice: boolean
  /** 单命中的下一跳（按 job_id 单查完整 JD/rubric）；DETAIL / 多命中为空数组。 */
  readonly next_tools: readonly NextToolValue[]
  readonly matches: readonly JobLookupMatch[]
  readonly job: JobGetValue['job'] | null
  readonly job_version: JobGetValue['job_version']
  readonly rubric: JobGetValue['rubric']
  readonly rubric_absence: JobGetValue['rubric_absence']
  readonly rubric_versions: JobGetValue['rubric_versions']
}

/** 规范输出 schema（只用官方强制子集：type/oneOf/properties/required/additionalProperties/items/enum/const）。 */
/** 可空对象的 schema 片段（官方子集没有 type 数组，用 oneOf 表达 null）。 */

const NULLABLE_OBJECT = (properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> => ({
  oneOf: [
    { type: 'object', properties, required: [...required], additionalProperties: false },
    { type: 'null' },
  ],
})

/** 可空字符串（数据库允许 NULL 的列）。 */
const NULLABLE_STRING: Record<string, unknown> = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
}

const CRITERION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  description: "One criterion echoed verbatim from rubric_version.dimensions (keys are closed by the rubric contract).",
}

const VIOLATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  description: 'One R-VAL structural violation from the rubric contract.',
}

/** 可空整数（`current_rubric_version_no`：指针为空/查不到照实给 null）。 */
const NULLABLE_INTEGER: Record<string, unknown> = {
  oneOf: [{ type: 'integer' }, { type: 'null' }],
}

/** `next_tools[]` 的一项（与 `business-read.ts` 的 next_tools 同形）。 */
const NEXT_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    reason: { type: 'string' },
    args_json: { type: 'string' },
  },
  required: ['name', 'reason', 'args_json'],
  additionalProperties: false,
}

/** 一行命中摘要（LOOKUP 的 `matches[]`；DETAIL 路径给本岗位一行）。 */
const LOOKUP_MATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    job_id: { type: 'string' },
    code: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    current_rubric_version_no: NULLABLE_INTEGER,
  },
  required: ['job_id', 'code', 'title', 'status', 'current_rubric_version_no'],
  additionalProperties: false,
}

/**
 * 规范输出 schema：**一个封闭根对象**（`type:'object'` + `additionalProperties:false`），
 * DETAIL / LOOKUP 两种模式靠 `mode` 区分。
 *
 * 为什么不是根 `oneOf`（2026-11-16 父 lane 纠正）：既有断言
 * `test/unit/label-honesty.test.ts` 直接消费 `output.schema.properties.labels` 与根 `required`
 * 里的 `'labels'`，根 `oneOf` 会把这条消费面打断（既有断言不许改）。统一根对象的额外好处：
 * DETAIL 值只是"既有字段 + 5 个恒有键"，消费者按老字段读永远不会 miss。
 *
 * 两种模式都恒给这 5 个键：`mode` / `matched` / `needs_human_choice` / `next_tools` / `matches`。
 * LOOKUP 模式下 `job` / `job_version` / `rubric` / `rubric_absence` 一律 `null`、
 * `rubric_versions` 为 `[]`（"这次没有读单个岗位"是显式事实，不是省键）。
 * `job` 从必填对象改成可空 oneOf（对象分支与改前**逐字相同**），仍在 required 里。
 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['CONNECTED', 'NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    as_of: { type: 'string' },
    /** `DETAIL` = 按 job_id 单查（下面 job/job_version/rubric/… 是完整内容）；`LOOKUP` = 按 code/title 的命中列表。 */
    mode: { type: 'string', enum: ['DETAIL', 'LOOKUP'] },
    matched: { type: 'integer' },
    needs_human_choice: { type: 'boolean' },
    next_tools: { type: 'array', items: NEXT_TOOL_SCHEMA },
    matches: { type: 'array', items: LOOKUP_MATCH_SCHEMA },
    job: NULLABLE_OBJECT({
      id: { type: 'string' },
      code: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string' },
      department_id: { type: 'string' },
      requisition_id: NULLABLE_STRING,
      current_job_version_id: NULLABLE_STRING,
      record_version: { type: 'integer' },
      status_changed_at: { type: 'string' },
    }, [
      'id', 'code', 'title', 'status', 'department_id', 'requisition_id',
      'current_job_version_id', 'record_version', 'status_changed_at',
    ]),
    job_version: NULLABLE_OBJECT({
      id: { type: 'string' },
      version_no: { type: 'integer' },
      payload_hash: { type: 'string' },
      description_md: NULLABLE_STRING,
      requirements_md: NULLABLE_STRING,
      approved_by_approval_id: NULLABLE_STRING,
    }, ['id', 'version_no', 'payload_hash', 'description_md', 'requirements_md', 'approved_by_approval_id']),
    rubric: NULLABLE_OBJECT({
      version_id: { type: 'string' },
      version_no: { type: 'integer' },
      payload_hash: { type: 'string' },
      is_current: { type: 'boolean' },
      is_approved: { type: 'boolean' },
      approved_by_approval_id: NULLABLE_STRING,
      created_by_actor_id: NULLABLE_STRING,
      created_at: { type: 'string' },
      resolution: { type: 'string', enum: ['EXPLICIT_VERSION_NO', 'EXPLICIT_VERSION_ID', 'JOB_CURRENT'] },
      criteria: { type: 'array', items: CRITERION_SCHEMA },
      criteria_count: { type: 'integer' },
      must_have_count: { type: 'integer' },
      nice_to_have_count: { type: 'integer' },
      disqualifier_count: { type: 'integer' },
      executable: { type: 'boolean' },
    }, [
      'version_id', 'version_no', 'payload_hash', 'is_current', 'is_approved',
      'approved_by_approval_id', 'created_by_actor_id', 'created_at', 'resolution',
      'criteria', 'criteria_count', 'must_have_count', 'nice_to_have_count',
      'disqualifier_count', 'executable',
    ]),
    rubric_absence: NULLABLE_OBJECT({
      code: { type: 'string', enum: ['NO_RUBRIC_AT_ALL', 'NO_APPROVED_RUBRIC', 'RUBRIC_INVALID'] },
      message: { type: 'string' },
      violations: { type: 'array', items: VIOLATION_SCHEMA },
    }, ['code', 'message', 'violations']),
    rubric_versions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          version_no: { type: 'integer' },
          version_id: { type: 'string' },
          is_current: { type: 'boolean' },
          is_approved: { type: 'boolean' },
          created_at: { type: 'string' },
        },
        required: ['version_no', 'version_id', 'is_current', 'is_approved', 'created_at'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'tool', 'contract_version', 'labels', 'as_of', 'mode', 'matched', 'needs_human_choice',
    'next_tools', 'matches', 'job', 'job_version', 'rubric', 'rubric_absence', 'rubric_versions',
  ],
  additionalProperties: false,
}


/** `timestamptz` 可能是 pg 给的 `Date`，也可能是测试造的字符串。 */
function toMs(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN
  if (value instanceof Date) return value.getTime()
  return Date.parse(value)
}

/** 必填时间列 → ISO 文本。 */
function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/** 可空时间列 → ISO 文本或 null。 */
function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : iso(value)
}

/**
 * JR §4.2 `approved(v, as_of)`：版本存在、已批准、hash 对得上、未被取代、未过期。
 * 从这里**不**读 `rubric_version.approved_by_approval_id`——那是可空指针，不保证
 * 指向的审批是 APPROVED，也不保证 hash 一致（`job-rubric-rules.md` §4.2 第 3 条）。
 */
function approvedAt(version: RubricRow, approvals: readonly ApprovalRow[], asOfIso: string): ApprovalRow | null {
  const asOf = Date.parse(asOfIso)
  if (!Number.isFinite(asOf) || toMs(version.created_at) > asOf) return null
  for (const approval of approvals) {
    if (approval.resource_id !== version.id) continue
    if (approval.status !== 'APPROVED') continue
    if (approval.canonical_payload_hash !== version.payload_hash) continue
    if (approval.superseded_by_approval_id !== null) continue
    const expiresAt = toMs(approval.expires_at)
    if (Number.isFinite(expiresAt) && expiresAt <= asOf) continue
    return approval
  }
  return null
}

/**
 * `current(job, as_of)`：**只认 `job.current_rubric_version_id` 这个显式指针**（D-21 / D-48）。
 *
 * 为什么不再按 `max(version_no)` 推导：批准 v2 不等于把 v3 顶成当前，回滚到 v1 也只能
 * 靠指针表达。按最大值取会让"回滚"这个业务动作在只读侧完全看不见，并且和写侧
 * （`recruitment_job_rubric_approve` 维护指针）说出两个不同的"当前"。
 *
 * 指针为空 / 指向的版本不属于该岗位 → `undefined`（= 没有当前版本，**不回退**）。
 * **注意**：这里只回答"哪一版被指针指着"，不回答"它是否已批准" —— 那是
 * {@link approvedAt} 的事，两个事实分开报（`is_current` / `is_approved`）。
 * @param versions - 该岗位的全部 rubric 版本。
 * @param currentRubricVersionId - `job.current_rubric_version_id`。
 * @returns 指针指向的版本；没有则 `undefined`。
 */
function pickCurrent(
  versions: readonly RubricRow[],
  currentRubricVersionId: string | null,
): RubricRow | undefined {
  if (currentRubricVersionId === null) return undefined
  return versions.find((version) => version.id === currentRubricVersionId)
}

/** 统计 criterion 的 kind 分布；任何结构问题留给 `validateDimensions`。 */
function countKinds(criteria: readonly unknown[]): { must: number; nice: number; disq: number } {
  let must = 0
  let nice = 0
  let disq = 0
  for (const raw of criteria) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const kind = (raw as Record<string, unknown>).kind
    if (kind === 'MUST_HAVE') must += 1
    else if (kind === 'NICE_TO_HAVE') nice += 1
    else if (kind === 'DISQUALIFIER') disq += 1
  }
  return { must, nice, disq }
}

/** 按 §2.2 组装一条 rubric；`executable` 是 R-VAL-1..13 的结论，不吞掉 violations。 */
function rubricValue(
  resolved: RubricRow,
  current: RubricRow | undefined,
  approvals: readonly ApprovalRow[],
  asOfIso: string,
  resolution: RubricValue['resolution'],
): RubricValue {
  const violations = validateDimensions(resolved.dimensions)
  const counts = countKinds(resolved.dimensions)
  return {
    version_id: resolved.id,
    version_no: resolved.version_no,
    payload_hash: resolved.payload_hash,
    is_current: current !== undefined && current.id === resolved.id,
    is_approved: approvedAt(resolved, approvals, asOfIso) !== null,
    approved_by_approval_id: resolved.approved_by_approval_id,
    created_by_actor_id: resolved.created_by_actor_id,
    created_at: iso(resolved.created_at),
    resolution,
    criteria: resolved.dimensions,
    criteria_count: resolved.dimensions.length,
    must_have_count: counts.must,
    nice_to_have_count: counts.nice,
    disqualifier_count: counts.disq,
    executable: violations.length === 0,
  }
}

/** 契约错误 detail 里的已知版本号（升序）。 */
function knownVersionNos(versions: readonly RubricRow[]): readonly number[] {
  return versions.map((version) => version.version_no)
}

/**
 * 本工具出口的三维标签（R4，`contracts/tenant-provenance.md` §2 / §3）。
 *
 * `provenance` **只能**由 {@link resolveTenantProvenance} 按**这次调用**的租户事实算：
 * 演示租户 / 缺声明 / 有合成标记 ⇒ `FIXTURE`。`trigger` 与 `connection` 与它正交：
 * 本工具不被事件驱动（`MANUAL`），`connection` 按其工具契约解释为"直连业务库"（`CONNECTED`）。
 * @param provenance - 本次调用算出的数据真假（`LIVE` 只在有正面证据时出现）。
 * @returns 三轴标签对象（每次调用新建，不共享可变常量）。
 */
function jobGetLabels(provenance: 'LIVE' | 'FIXTURE'): JobGetValue['labels'] {
  return {
    provenance,
    trigger: 'MANUAL',
    connection: 'CONNECTED',
  }
}

/**
 * 在只读事务里跑完整查询 + 解析。
 * @param client - 只读事务内的客户端。
 * @param cfg - 已解析的数据库配置（tenant_id 只从这里来）。
 * @param args - 已校验的入参。
 * @param asOfIso - 本次判定的基准时刻（入参或服务端 now）。
 */
async function queryJob(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  asOfIso: string,
): Promise<JobGetValue> {
  const jobId = args.job_id as string
  const jobResult = await client.query<JobRow>(
    `select id, code, title, status, department_id, requisition_id, current_job_version_id,
            current_rubric_version_id, record_version, status_changed_at
       from recruitment.job
      where id = $1 and tenant_id = $2`,
    [jobId, cfg.tenant_id],
  )
  const job = jobResult.rows[0]
  if (job === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'JOB_NOT_FOUND',
      message: `该租户下没有岗位 ${jobId}`,
      detail: { job_id: jobId },
    })
  }

  // R4：provenance 反映**这次调用**的数据来源，不写死 `LIVE`。
  // 只读业务库 ⇒ 数据真假取决于该租户是否被显式声明为非合成（演示租户一律 FIXTURE）。
  const provenance = await resolveTenantProvenance(client, cfg.tenant_id)

  let jobVersion: JobVersionRow | undefined
  if (job.current_job_version_id !== null) {
    const versionResult = await client.query<JobVersionRow>(
      `select id, version_no, payload_hash, description_md, requirements_md, approved_by_approval_id
         from recruitment.job_version
        where id = $1 and tenant_id = $2`,
      [job.current_job_version_id, cfg.tenant_id],
    )
    jobVersion = versionResult.rows[0]
  }

  const rubricResult = await client.query<RubricRow>(
    `select id, version_no, payload_hash, dimensions, created_at,
            approved_by_approval_id, created_by_actor_id
       from recruitment.rubric_version
      where tenant_id = $1 and job_id = $2
      order by version_no`,
    [cfg.tenant_id, job.id],
  )
  const versions = rubricResult.rows

  // 只取本岗位 rubric 的审批行，避免把全租户审批读进内存。
  const approvalResult = await client.query<ApprovalRow>(
    `select a.resource_id, a.status, a.canonical_payload_hash, a.expires_at,
            a.superseded_by_approval_id
       from recruitment.approval a
       join recruitment.rubric_version r
         on r.id = a.resource_id and r.tenant_id = a.tenant_id
      where a.tenant_id = $1 and a.resource_type = 'RUBRIC_VERSION' and r.job_id = $2`,
    [cfg.tenant_id, job.id],
  )
  const approvals = approvalResult.rows

  const current = pickCurrent(versions, job.current_rubric_version_id)
  const currentOrNull = current === undefined ? null : current
  const requestedNo = args.rubric_version_no as number | undefined
  const requestedId = args.rubric_version_id as string | undefined

  let resolution: RubricValue['resolution']
  let resolved: RubricRow | undefined
  if (requestedId !== undefined) {
    resolution = 'EXPLICIT_VERSION_ID'
    resolved = versions.find((version) => version.id === requestedId)
    if (resolved === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'RUBRIC_VERSION_NOT_FOUND',
        message: `岗位 ${jobId} 下没有该 Rubric 版本 id`,
        detail: { job_id: jobId, rubric_version_id: requestedId, known_version_nos: knownVersionNos(versions) },
      })
    }
  } else if (requestedNo !== undefined) {
    resolution = 'EXPLICIT_VERSION_NO'
    resolved = versions.find((version) => version.version_no === requestedNo)
    if (resolved === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'RUBRIC_VERSION_NOT_FOUND',
        message: `岗位 ${jobId} 下没有 Rubric v${requestedNo}`,
        detail: { job_id: jobId, requested_version_no: requestedNo, known_version_nos: knownVersionNos(versions) },
      })
    }
  } else {
    resolution = 'JOB_CURRENT'
    if (versions.length === 0) {
      return {
        tool: TOOL_NAME,
        contract_version: CONTRACT_VERSION,
        labels: jobGetLabels(provenance),
        as_of: asOfIso,
        job: {
          id: job.id,
          code: job.code,
          title: job.title,
          status: job.status,
          department_id: job.department_id,
          requisition_id: job.requisition_id,
          current_job_version_id: job.current_job_version_id,
          record_version: job.record_version,
          status_changed_at: iso(job.status_changed_at),
        },
        job_version: jobVersion === undefined ? null : {
          id: jobVersion.id,
          version_no: jobVersion.version_no,
          payload_hash: jobVersion.payload_hash,
          description_md: jobVersion.description_md,
          requirements_md: jobVersion.requirements_md,
          approved_by_approval_id: jobVersion.approved_by_approval_id,
        },
        rubric: null,
        rubric_absence: {
          code: 'NO_RUBRIC_AT_ALL',
          message: `岗位 ${jobId} 还没有任何 Rubric 版本`,
          violations: [],
        },
        rubric_versions: versions.map((version) => ({
          version_no: version.version_no,
          version_id: version.id,
          is_current: false,
          is_approved: approvedAt(version, approvals, asOfIso) !== null,
          created_at: iso(version.created_at),
        })),
      }
    }
    // current() 只认指针；JOB_CURRENT 还要"指针指向的版本在 as_of 已批准" + "可执行"（R-VAL）。
    // 三个事实分开报，别把"没有指针"说成"没有审批"。
    if (current === undefined) {
      return absenceValue(job, jobVersion, versions, approvals, asOfIso, provenance, {
        code: 'NO_APPROVED_RUBRIC',
        message: job.current_rubric_version_id === null
          ? `岗位 ${jobId} 有 ${versions.length} 个 Rubric 版本，但 job.current_rubric_version_id 为空：`
            + '没有"当前版本"（D-21/D-48：当前只由该指针表达，不回退到 max(version_no)）'
          : `岗位 ${jobId} 的 job.current_rubric_version_id=${job.current_rubric_version_id} 不属于该岗位的 Rubric 版本`,
        violations: [],
      })
    }
    if (approvedAt(current, approvals, asOfIso) === null) {
      return absenceValue(job, jobVersion, versions, approvals, asOfIso, provenance, {
        code: 'NO_APPROVED_RUBRIC',
        message: `岗位当前 Rubric v${current.version_no}（指针指向的版本）在 ${asOfIso} 时刻没有处于已批准状态的审批`,
        violations: [],
      })
    }
    const currentViolations = validateDimensions(current.dimensions)
    if (currentViolations.length > 0) {
      return absenceValue(job, jobVersion, versions, approvals, asOfIso, provenance, {
        code: 'RUBRIC_INVALID',
        message: `当前 Rubric v${current.version_no} 没有通过 R-VAL-1..13，不可执行`,
        violations: currentViolations,
      })
    }
    resolved = current
  }

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    labels: jobGetLabels(provenance),
    as_of: asOfIso,
    job: {
      id: job.id,
      code: job.code,
      title: job.title,
      status: job.status,
      department_id: job.department_id,
      requisition_id: job.requisition_id,
      current_job_version_id: job.current_job_version_id,
      record_version: job.record_version,
      status_changed_at: iso(job.status_changed_at),
    },
    job_version: jobVersion === undefined ? null : {
      id: jobVersion.id,
      version_no: jobVersion.version_no,
      payload_hash: jobVersion.payload_hash,
      description_md: jobVersion.description_md,
      requirements_md: jobVersion.requirements_md,
      approved_by_approval_id: jobVersion.approved_by_approval_id,
    },
    rubric: rubricValue(resolved, currentOrNull ?? undefined, approvals, asOfIso, resolution),
    rubric_absence: null,
    rubric_versions: versions.map((version) => ({
      version_no: version.version_no,
      version_id: version.id,
      is_current: current !== undefined && current.id === version.id,
      is_approved: approvedAt(version, approvals, asOfIso) !== null,
      created_at: iso(version.created_at),
    })),
  }
}

/**
 * 查询串侧的归一化（D-141 第 6 条）：全角空格 → 半角空格、去首尾空白、转小写。
 *
 * 与 SQL 侧**同一口径**：`lower(btrim(replace(col, chr(12288), ' ')))`。
 * 库里值由 SQL 归一化（不把整列拉进内存），查询串由这里归一化 —— 两边各做一次，
 * 不互相替代。返回值可能是空串，调用方负责拒绝（不静默当"没给"）。
 * @param value - 模型给的原始查询串。
 * @returns 归一化后的查询串。
 */
function normalizeSearchText(value: string): string {
  return value.replace(/\u3000/g, ' ').trim().toLowerCase()
}

/** LOOKUP 模式的一行原始查询结果。 */
interface JobLookupRow {
  readonly id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly current_rubric_version_no: number | null
}

/** 包含匹配的两列（`job_id` 单查不走这里）。 */
type LookupMode = 'code' | 'title'

/**
 * 按 `code` / `title` 的**包含匹配**找岗位（D-141 第 6 条；只读）。
 *
 * 三条硬口径：
 *   1. 归一化在 **SQL 侧**做（`REPLACE(chr(12288)) → BTRIM → LOWER`），查询串在 JS 侧做；
 *   2. 包含判定用 `position($q in normalized_col) > 0`，**不用 LIKE** —— 否则查询串里的
 *      `%` / `_` 会变成通配符，`code='%'` 就会命中全表；
 *   3. `code` 只匹配 `job.code`，`title` 只匹配 `job.title`，不互相串。
 *
 * 0 命中是**错误**（`NOT_FOUND / JOB_NOT_FOUND`），不是空列表：调用方→模型→人需要知道
 * "这个片段不存在"，而不是以为"查询成功但没有岗位"。
 * @param client - 只读事务内的客户端。
 * @param cfg - 已解析的数据库配置（`tenant_id` 只从这里来）。
 * @param by - 匹配哪一列（封闭枚举，不是模型自由文本）。
 * @param rawValue - 模型给的原始查询串（未归一化；非空已由入参层保证）。
 * @param asOfIso - 本次调用的基准时刻（LOOKUP 只回显，不参与筛选）。
 * @returns LOOKUP 规范输出（命中 ≥ 1）。
 * @throws RecruitmentToolError - 0 命中时 `NOT_FOUND / JOB_NOT_FOUND`。
 */
async function queryJobLookup(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  by: LookupMode,
  rawValue: string,
  asOfIso: string,
): Promise<JobGetOutputValue> {
  const normalized = normalizeSearchText(rawValue)
  // `by` 是封闭枚举，列名只可能是这两列之一（不是字符串拼接模型输入）。
  const column = by === 'code' ? 'j.code' : 'j.title'
  const result = await client.query<JobLookupRow>(
    `select j.id, j.code, j.title, j.status, rv.version_no as current_rubric_version_no
       from recruitment.job j
       left join recruitment.rubric_version rv
         on rv.id = j.current_rubric_version_id and rv.tenant_id = j.tenant_id
      where j.tenant_id = $1
        and position($2 in lower(btrim(replace(${column}, chr(12288), ' ')))) > 0
      order by j.code asc, j.title asc, j.id asc`,
    [cfg.tenant_id, normalized],
  )
  const rows = result.rows
  if (rows.length === 0) {
    const shown = rawValue.replace(/\u3000/g, ' ').trim()
    throw contractError('NOT_FOUND', {
      reason_code: 'JOB_NOT_FOUND',
      message: by === 'code'
        ? `没有找到岗位：编码里包含「${shown}」的岗位不存在。请确认岗位编码，或改用完整岗位标题查询。`
        : `没有找到岗位：标题里包含「${shown}」的岗位不存在。请确认岗位标题，或改用岗位编码查询。`,
      detail: { query: { by, value: rawValue, normalized } },
    })
  }

  // R4：provenance 反映**这次调用**的数据来源（与单查同一份实现，不写死 LIVE）。
  const provenance = await resolveTenantProvenance(client, cfg.tenant_id)
  const matches: readonly JobLookupMatch[] = rows.map((row) => ({
    job_id: row.id,
    code: row.code,
    title: row.title,
    status: row.status,
    current_rubric_version_no: row.current_rubric_version_no,
  }))
  const only = matches.length === 1 ? matches[0] : undefined
  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    labels: jobGetLabels(provenance),
    as_of: asOfIso,
    mode: 'LOOKUP',
    matched: matches.length,
    // 多命中 = 必须问人（O20 同口径）：不替人挑"第一条"，也不给 next_tools 暗示。
    needs_human_choice: matches.length > 1,
    next_tools: only === undefined ? [] : [{
      name: TOOL_NAME,
      reason: '按 job_id 读取该岗位的完整 JD / rubric / 版本列表',
      args_json: JSON.stringify({ job_id: only.job_id }),
    }],
    matches,
    // LOOKUP 没有读"某一个岗位的完整内容"：这几个键是显式 null / 空数组（不是省键）。
    job: null,
    job_version: null,
    rubric: null,
    rubric_absence: null,
    rubric_versions: [],
  }
}

/**
 * 把单查结果包装成统一出口（D-141 第 6 条）：**既有字段逐字段不变**，只补 5 个恒有键。
 *
 * `matches` 的一行摘要是本岗位的 `{job_id, code, title, status, current_rubric_version_no}`；
 * `current_rubric_version_no` 取 `rubric_versions` 里 `is_current=true` 的那一版
 * （= `job.current_rubric_version_id` 指向的版本，D-21/D-48；没有指针 ⇒ null）。
 * @param value - `queryJob()` 的单查规范值（改前形状）。
 * @returns 统一出口值（`mode:'DETAIL'`）。
 */
function detailOutput(value: JobGetValue): JobGetOutputValue {
  const current = value.rubric_versions.find((version) => version.is_current)
  return {
    ...value,
    mode: 'DETAIL',
    matched: 1,
    needs_human_choice: false,
    next_tools: [],
    matches: [{
      job_id: value.job.id,
      code: value.job.code,
      title: value.job.title,
      status: value.job.status,
      current_rubric_version_no: current === undefined ? null : current.version_no,
    }],
  }
}


/**
 * 在**已有事务**里跑完整查询（测试与生产走同一条 `queryJob` 路径，标签也因此同源）。
 *
 * 给集成测试一个能落在回滚事务里的入口：`createJobGetTool().execute` 自己开池，
 * 看不到事务内造的夹具；而 R4 要证明"标签随租户事实变"，必须能在同一事务里
 * 造一个**被显式声明为非合成**的租户再读一遍。
 * @param client - 事务内客户端。
 * @param config - 已解析的数据库配置（`tenant_id` 只从这里来）。
 * @param args - **已校验**的入参（校验在 `execute` 的入参层，与 `queryJob` 同口径）。
 * @param asOfIso - 本次判定的基准时刻。
 * @returns 规范输出值（`labels.provenance` 由 `resolveTenantProvenance` 算出）。
 */
export async function readJobValue(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  asOfIso: string,
): Promise<JobGetValue> {
  return queryJob(client, config, args, asOfIso)
}

/**
 * 构造 `rubric` 为 null 的返回值（`rubric_absence` 恰有一个非 null，见 §2.3）。
 * @param provenance - 本次调用按租户事实算出的数据真假（R4；不许写死）。
 */
function absenceValue(
  job: JobRow,
  jobVersion: JobVersionRow | undefined,
  versions: readonly RubricRow[],
  approvals: readonly ApprovalRow[],
  asOfIso: string,
  provenance: 'LIVE' | 'FIXTURE',
  absence: JobGetValue['rubric_absence'],
): JobGetValue {
  const current = pickCurrent(versions, job.current_rubric_version_id)
  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    labels: jobGetLabels(provenance),
    as_of: asOfIso,
    job: {
      id: job.id,
      code: job.code,
      title: job.title,
      status: job.status,
      department_id: job.department_id,
      requisition_id: job.requisition_id,
      current_job_version_id: job.current_job_version_id,
      record_version: job.record_version,
      status_changed_at: iso(job.status_changed_at),
    },
    job_version: jobVersion === undefined ? null : {
      id: jobVersion.id,
      version_no: jobVersion.version_no,
      payload_hash: jobVersion.payload_hash,
      description_md: jobVersion.description_md,
      requirements_md: jobVersion.requirements_md,
      approved_by_approval_id: jobVersion.approved_by_approval_id,
    },
    rubric: null,
    rubric_absence: absence,
    rubric_versions: versions.map((version) => ({
      version_no: version.version_no,
      version_id: version.id,
      is_current: current !== undefined && current.id === version.id,
      is_approved: approvedAt(version, approvals, asOfIso) !== null,
      created_at: iso(version.created_at),
    })),
  }
}

/** 一条 criterion 的模型可见行（§2.6 的正例格式）。 */
function criterionLine(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '    ?  (malformed criterion)'
  const criterion = raw as Record<string, unknown>
  const key = typeof criterion.key === 'string' ? criterion.key : '?'
  const kind = typeof criterion.kind === 'string' ? criterion.kind : '?'
  const weight = typeof criterion.weight === 'number' ? String(criterion.weight) : '?'
  const label = typeof criterion.label === 'string' ? ` — ${criterion.label}` : ''
  const evidence = typeof criterion.field === 'string'
    ? `${criterion.field} ${typeof criterion.operator === 'string' ? criterion.operator : '?'} ${JSON.stringify(criterion.value)}`
    : typeof criterion.question === 'string'
      ? `(judgment) ${JSON.stringify(criterion.question)}`
      : '(no field, no question)'
  return `    ${key}  [${kind}]  w=${weight}  ${evidence}${label}`
}

/**
 * LOOKUP 模式的 render（O1 口径，见 `render-ref.ts`）：人读正文只给
 * `code` / 标题 / 状态 / rubric vN / **短号**（`shortRef`）；完整 `job_id` 只出现在末尾
 * 的 `machine arguments` 区（模型要原样复制才能按 `job_id` 单查完整 JD / rubric）。
 *
 * 多命中时明示"要问人"（与 `needs_human_choice` 同一句结论），不在这里替人挑一条。
 * @param v - LOOKUP 模式出口值（命中 ≥ 1；`job` 等单查字段为 null）。
 * @returns 一个 text 块。
 */
function renderJobLookup(v: JobGetOutputValue): readonly TextBlock[] {
  const labels = `${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`
  const lines: string[] = [
    `岗位查询：命中 ${v.matched} 个岗位  (labels: ${labels})`,
  ]
  for (const match of v.matches) {
    const rubric = match.current_rubric_version_no === null
      ? 'rubric —'
      : `rubric v${match.current_rubric_version_no}`
    lines.push(`  ${match.code} ${match.title} [${match.status}]  ${rubric}  ${shortRef(match.job_id)}`)
  }
  if (v.needs_human_choice) {
    lines.push('  命中多个岗位：必须让 HR 选定一个，不要替人挑（选定后再用 job_id 单查完整 JD / rubric）')
  }
  lines.push(`as_of ${v.as_of}`)
  // 机器参数区：job_id 是调用方回收窄查询 / 下游工具的唯一句柄，完整值只允许出现在这里。
  lines.push(...machineArgumentLines(v.matches.map((match) => ({ key: 'job_id', value: match.job_id }))))
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 造一个"数据库没配置"的替身：工具照常注册，调用时报 NOT_CONFIGURED 并列出缺什么。
 * 这比让工具消失更好——模型能看到"为什么查不了"，而不是以为工具不存在。
 */
export function unconfiguredJobGetTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Get one job (requisition) and its rubric from the business database. Currently NOT CONFIGURED: '
      + 'the plugin config is missing database settings (or the database password environment variable). '
      + 'Calls return NOT_CONFIGURED.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${TOOL_NAME} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw contractError('NOT_CONFIGURED', {
        reason_code: 'PLUGIN_NOT_CONFIGURED',
        message: '数据库配置不完整，岗位查询不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}

/**
 * 造真实的岗位查询工具。
 * @param config - 已解析的数据库配置（tenant_id 只从这里来，模型无法传入）。
 */
export function createJobGetTool(config: ResolvedDatabaseConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Get one job (requisition) and the rubric version that applies at a given time, read straight from the '
      + 'business database (labels: provenance is computed from the tenant\'s synthetic marker — FIXTURE for demo/'
      + 'undeclared tenants, LIVE only when the tenant is explicitly declared non-synthetic; trigger=MANUAL, '
      + 'connection=CONNECTED means "direct business DB read"). Query selectors: give EXACTLY ONE of '
      + 'job_id (UUID) / code / title. job_id returns one job in full: the job row, its current job_version (JD '
      + 'text), the resolved rubric with every criterion echoed verbatim, all rubric version numbers with '
      + 'is_current/is_approved, and rubric_absence when the job has no approved rubric (this tool reports absence '
      + 'instead of failing); the value is mode=DETAIL, matched=1 and matches[] holds that job\'s summary. '
      + 'code/title are CONTAINS matches (case-insensitive, leading/trailing whitespace and '
      + 'full-width spaces normalized) and return mode=LOOKUP with a matches[] list of '
      + '{job_id, code, title, status, current_rubric_version_no}; when more than one job matches, '
      + 'needs_human_choice=true and next_tools is empty — you MUST ask the human which job they mean instead of '
      + 'picking one yourself. A lookup with zero matches fails with NOT_FOUND/JOB_NOT_FOUND. Omit '
      + 'rubric_version_no/rubric_version_id to get the current approved version; pin a version by passing one of '
      + 'them (mutually exclusive, job_id mode only). Use rubric.version_id when a downstream step must reference '
      + 'the exact rubric. Read-only.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const output = value as JobGetOutputValue
        // DETAIL / LOOKUP 共用一个封闭根对象；渲染按 `mode` 分派。
        // `job === null` 只可能来自 LOOKUP（或 schema 合成值的 sparse 变体）——
        // 两种都走列表 render，避免在"没有岗位内容"时访问 v.job.*。
        if (output.mode === 'LOOKUP' || output.job === null) {
          return renderJobLookup(output)
        }
        const v = output as unknown as JobGetValue
        const labels = `${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`
        // O1 残留：人读正文只给业务标识（岗位 code+标题）与短号；完整 UUID 只在机检/结构化
        // 字段和末尾的 machine arguments 区（模型要复制才能调下游工具）。
        const lines: string[] = [
          `job ${v.job.code} ${v.job.title} [${v.job.status}]  (labels: ${labels})`,
          `  岗位 ${shortRef(v.job.id)}  record_version=${v.job.record_version}`,
        ]
        if (v.job_version === null) {
          lines.push('job_version: none (job.current_job_version_id is null)')
        } else {
          lines.push(
            `job_version v${v.job_version.version_no}  hash=${shortHash(v.job_version.payload_hash)}`,
          )
          if (v.job_version.description_md !== null) {
            lines.push(`  description_md: ${v.job_version.description_md}`)
          }
          if (v.job_version.requirements_md !== null) {
            lines.push(`  requirements_md: ${v.job_version.requirements_md}`)
          }
        }
        if (v.rubric === null) {
          const absence = v.rubric_absence
          lines.push(`rubric: none (${absence === null ? 'unknown' : absence.code}) — ${absence === null ? '' : absence.message}`)
          for (const violation of absence === null ? [] : absence.violations) {
            const record = violation as Record<string, unknown>
            lines.push(`  VIOLATION ${String(record.rule)} ${String(record.reason_code)} @ ${String(record.path)}`)
          }
        } else {
          lines.push(
            `rubric v${v.rubric.version_no} (is_current=${String(v.rubric.is_current)}, `
            + `is_approved=${String(v.rubric.is_approved)}, resolution=${v.rubric.resolution}, `
            + `executable=${String(v.rubric.executable)}, 版本 ${shortRef(v.rubric.version_id)})`,
          )
          for (const criterion of v.rubric.criteria) lines.push(criterionLine(criterion))
        }
        lines.push(
          `versions: ${v.rubric_versions
            .map((version) => `v${version.version_no}(is_current=${String(version.is_current)}, `
              + `is_approved=${String(version.is_approved)})`)
            .join(', ') || 'none'}`,
        )
        lines.push(`as_of ${v.as_of}`)
        // 机器参数区：rubric 版本 id 是**本工具才能发现**的值，模型要拿它调
        // `recruitment_job_rubric_approve` / `recruitment_screening_evaluate`（pin 版本），
        // 所以完整值只允许出现在这里，且 header 明示不要给用户看。
        lines.push(...machineArgumentLines([
          { key: 'job_id', value: v.job.id },
          ...(v.rubric === null ? [] : [{ key: 'rubric_version_id', value: v.rubric.version_id }]),
        ]))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const args = parseContractArgs(PARAMS, rawArgs)

      // D-141 第 6 条：三个选择器（job_id / code / title）必须**恰好给一个**。
      // 顺序：先"一个都没给/给多了"，再"归一化后为空"，最后"rubric 参数只配 job_id 模式"。
      const given: Record<string, string> = {}
      for (const key of SELECTOR_KEYS) {
        const value = args[key]
        if (value !== undefined) given[key] = value as string
      }
      const selectorKeys = Object.keys(given)
      if (selectorKeys.length === 0) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'MISSING_REQUIRED',
          message: '缺少查询条件：job_id / code / title 必须恰好给一个（当前一个都没给）。'
            + '要精确定位某个岗位用 job_id；只记得编码或标题片段时用 code / title 做包含匹配。',
          detail: { allowed: [...SELECTOR_KEYS], given },
        })
      }
      if (selectorKeys.length > 1) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'MUTUALLY_EXCLUSIVE',
          message: `job_id / code / title 只能给一个（当前给了 ${selectorKeys.join(', ')}）`,
          detail: { allowed: [...SELECTOR_KEYS], given },
        })
      }
      const by: LookupMode | null = given.code !== undefined
        ? 'code'
        : given.title !== undefined
          ? 'title'
          : null
      if (by !== null) {
        const rawValue = given[by] as string
        // `'   '` / `'\u3000'` 能通过"非空字符串"校验，但归一化后没有可搜索内容：
        // 明确拒绝（TYPE_MISMATCH，D-141 §6），**不**静默当成"没给"或"全表匹配"。
        if (normalizeSearchText(rawValue) === '') {
          throw contractError('INVALID_ARGS', {
            reason_code: 'TYPE_MISMATCH',
            message: `${by} 归一化（去首尾空白 / 全角空格、转小写）后为空，无法做包含匹配；`
              + `请给出岗位${by === 'code' ? '编码' : '标题'}的一部分`,
            detail: { param: by, value: rawValue, normalized: '' },
          })
        }
      }
      const requestedNo = args.rubric_version_no
      const requestedId = args.rubric_version_id
      if (by !== null && (requestedNo !== undefined || requestedId !== undefined)) {
        // 这两个参数只在 job_id 单查模式有意义；按 code/title 查询时**不静默忽略**。
        throw contractError('INVALID_ARGS', {
          reason_code: 'MUTUALLY_EXCLUSIVE',
          message: 'rubric_version_no / rubric_version_id 只与 job_id 单查模式一起用；'
            + '按 code / title 查询时不接受它们',
          detail: {
            allowed: [...SELECTOR_KEYS],
            given: {
              ...given,
              ...(requestedNo === undefined ? {} : { rubric_version_no: requestedNo }),
              ...(requestedId === undefined ? {} : { rubric_version_id: requestedId }),
            },
          },
        })
      }
      if (requestedNo !== undefined && requestedId !== undefined) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'MUTUALLY_EXCLUSIVE',
          message: 'rubric_version_no 与 rubric_version_id 只能给一个',
          detail: {
            given: { rubric_version_no: requestedNo, rubric_version_id: requestedId },
          },
        })
      }
      const nowMs = Date.now()
      const requestedAsOf = typeof args.as_of === 'string' ? args.as_of : undefined
      if (requestedAsOf !== undefined) {
        const checked = checkAsOf(requestedAsOf, nowMs)
        if (checked.ok !== true) {
          throw contractError('INVALID_ARGS', {
            reason_code: checked.reason_code,
            message: checked.message,
            detail: { as_of: requestedAsOf },
          })
        }
      }
      const asOfIso = requestedAsOf ?? new Date(nowMs).toISOString()

      const pool = createPool(config)
      try {
        return await withReadOnly(pool, async (client) => (by === null
          // job_id 单查：既有字段逐字段不变，只补 mode/matched/matches/needs_human_choice/next_tools。
          ? detailOutput(await queryJob(client, config, args, asOfIso))
          : queryJobLookup(client, config, by, given[by] as string, asOfIso)))
      } finally {
        await closePool(pool)
      }
    },
  }
}

