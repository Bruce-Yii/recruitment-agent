// recruitment_job_create / recruitment_job_update —— 岗位线的**唯一写库入口**（直连 PG）。
//
// 契约：`manual/job-line/SPEC.md`（冻结，v1）+ `contracts/job-screening/job-rubric-rules.md`
// （J-1..J-8 / R-VAL-1..14 / §6.6 canonical_json）。与 SPEC 冲突时以 SPEC 为准。
//
// 本文件的三条裁决（都不是实现细节，是会被人反复问的"为什么"）：
//
//   1. **Agent 不替人批准标准。** create/update 只写 `approval(status='PENDING')`；
//      批准是**人类动作**，只能走导出的 `decideRubricApproval()`（CLI
//      `manual/job-line/approve-rubric.mjs`，后续 Web 按钮复用同一函数）。理由：
//      `APP-07` / `docs/20 §2` 的人类闸门不可由模型冒充；`approval.decision_by_actor_id`
//      是人类责任的锚点，模型自己签等于没有责任人。`decideRubricApprovalInTransaction`
//      因此额外要求决定者 `actor.kind = 'HUMAN'`（SYSTEM / AGENT_WORKER 一律
//      `FORBIDDEN/ACTOR_NOT_HUMAN`）。
//
//   2. **版本不可变。** 改 JD / 改标准 = 追加新行（`version_no = max+1`），旧
//      `job_version` / `rubric_version` 一个字节都不 UPDATE（`J-1`、
//      `trg_job_version_immutable` / `trg_rubric_version_immutable` 的
//      `fn_guard_columns` 无白名单，库级直接 23514）。因此
//      `rubric_version.approved_by_approval_id` 永远留 null——批准状态只能靠
//      `approval` 行的 EXISTS 判（`job-rubric-rules.md` §4.2 第 3 条）。
//
//   3. **不新增 current 指针，不改库。** `current(job, as_of)` 由读侧
//      （`recruitment_job_get`）按 §4.2 推导；本文件只维护 `job.current_job_version_id`
//      （这是 0001 既有列，指向"最新 job_version"，不是"最新已批准 rubric"）。
//      不新建表 / 不新建列 / 不加索引（SPEC §1.5 的停止条件）。
//
// 一个容易踩的库级约束：`fn_row_guard` 挂在 `job.status` 与 `approval.status` 上，
// 它会给 `record_version` 自增并写 `status_changed_at/by`。所以输出里的
// `record_version` 一律取 `RETURNING` 的真实值，**绝不**自己 +1（D-18）。
// 另外任何一条 SQL 抛错后事务即进入 25P02，`mapDatabaseError` 只做"把当前错误
// 映射成契约错误"，不在 catch 里补查询；回滚由包装层（withActor / 测试的
// inRolledBackTx）统一负责。

import { randomBytes } from 'node:crypto'

import {
  collectArgViolations,
  toParameterSchema,
  type ArgViolation,
  type ArgViolationReason,
  type ParamMap,
} from './args.ts'
import { contractError, digestOf } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { validateDimensions } from './screening-evaluate.ts'
// R4 三维标签：`provenance` 按**这次调用**的租户事实算，不许写死 `LIVE`
// （`contracts/tenant-provenance.md`；判定式与 candidate_get / interview_schedule 共用同一份实现）。
import { buildThreeAxisLabels } from './candidate-get.ts'
import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { resolveWriteActor, type ToolActorDeps } from '../demo-actor/tool-actor.ts'

/** 工具名（模型可见，冻结）。 */
export const JOB_CREATE_TOOL = 'recruitment_job_create'
/** 工具名（模型可见，冻结）。 */
export const JOB_UPDATE_TOOL = 'recruitment_job_update'
/** 输出契约版本（SPEC §6）。 */
export const CONTRACT_VERSION = '1.0.0'

/** 写侧配置：只带已解析的库配置（tenant/actor 不来自模型入参）。 */
export interface JobWriteConfig {
  readonly database: ResolvedDatabaseConfig
}

/** criterion 的 9 个键（封闭；顺序即 normalize 后的输出键序）。 */
const CRITERION_KEYS = [
  'key', 'label', 'kind', 'weight', 'field', 'operator', 'value', 'question', 'notes',
] as const

const CRITERION_KINDS = ['MUST_HAVE', 'NICE_TO_HAVE', 'DISQUALIFIER'] as const
const CRITERION_OPERATORS = ['EXISTS', 'GTE', 'LTE'] as const

/** create 的 status 闭集（SPEC §3）。 */
const CREATE_STATUSES = ['DRAFT', 'OPEN'] as const
/** update 允许的 7 个合法状态（与 `ck_job_status` 一致）。 */
const JOB_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'OPEN', 'PAUSED', 'CLOSED', 'ARCHIVED'] as const

/** `job.code` 的库约束（`ck_job_code_format`），在这里先挡一次，错误更好读。 */
const JOB_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---------------------------------------------------------------------------
//  入参声明（标量走 args.ts 的同一套校验，criteria 手工合并——ParamMap 不支持 object[]）
// ---------------------------------------------------------------------------

const CREATE_SCALAR_PARAMS: ParamMap = {
  title: {
    kind: 'string',
    required: true,
    maxLength: 200,
    description: 'Job title, 1..200 characters after trimming (e.g. "后端工程师").',
  },
  code: {
    kind: 'string',
    maxLength: 41,
    description: 'Stable job code, ^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$, unique per tenant. '
      + 'Omit to auto-generate JOB-<YYYYMMDD>-<6 uppercase hex>.',
  },
  department_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Department UUID. Mutually exclusive with department_name. '
      + 'Omit both to use the tenant\'s only department (fails with DEPARTMENT_REQUIRED when there are several).',
  },
  department_name: {
    kind: 'string',
    maxLength: 200,
    description: 'Department name, case-insensitive exact match (1..200 chars). Mutually exclusive with department_id.',
  },
  description_md: {
    kind: 'string',
    maxLength: 20_000,
    description: 'JD body (markdown), at most 20000 characters. Omit description_md and requirements_md together '
      + 'to store the title as a placeholder JD (output job_version.jd_source = TITLE_PLACEHOLDER).',
  },
  requirements_md: {
    kind: 'string',
    maxLength: 20_000,
    description: 'Requirements section (markdown), at most 20000 characters.',
  },
  status: {
    kind: 'string',
    values: CREATE_STATUSES,
    description: 'Initial job status: DRAFT (default) or OPEN.',
  },
}

const UPDATE_SCALAR_PARAMS: ParamMap = {
  job_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Job id (UUID) returned by recruitment_job_create or recruitment_job_get. Must belong to the configured tenant.',
  },
  expected_record_version: {
    kind: 'integer',
    min: 1,
    max: 2_147_483_647,
    description: 'Optional optimistic-concurrency guard, >= 1. When it differs from job.record_version the call '
      + 'fails with INVALID_ARGS(VERSION_CONFLICT) and detail {expected, actual}.',
  },
  title: {
    kind: 'string',
    maxLength: 200,
    description: 'New title, 1..200 characters after trimming. Omit to keep the current title.',
  },
  description_md: {
    kind: 'string',
    maxLength: 20_000,
    description: 'New JD body (markdown), at most 20000 characters. Passing this or requirements_md appends a new '
      + 'job_version; the side you do not pass is copied from the current version.',
  },
  requirements_md: {
    kind: 'string',
    maxLength: 20_000,
    description: 'New requirements section, at most 20000 characters. See description_md.',
  },
  status: {
    kind: 'string',
    values: JOB_STATUSES,
    description: 'New status: DRAFT | PENDING_REVIEW | APPROVED | OPEN | PAUSED | CLOSED | ARCHIVED. '
      + 'A status change is a human-visible transition and is recorded in the event inbox.',
  },
}

/** `criteria` 数组的模型可见 schema（封闭 9 键；值语义交给 validateDimensions）。 */
const CRITERIA_PARAMETER_SCHEMA: Record<string, unknown> = {
  type: 'array',
  description:
    '1..50 rubric criteria. The object below is closed over exactly 9 keys and no others; only '
    + 'key/label/kind/weight are required. '
    + 'kind is MUST_HAVE | NICE_TO_HAVE | DISQUALIFIER (at least one MUST_HAVE or DISQUALIFIER). '
    + 'weight is 0..1 and the array MUST sum to 1 (tolerance 1e-6). '
    + 'A mechanical criterion gives field+operator+value together; a judgment criterion gives question instead '
    + 'and omits field/operator/value entirely (do not send null placeholders). '
    + 'Allowed mechanical fields: timeline.covered_months_closed / work_experience.entry_count / '
    + 'education.entry_count with GTE|LTE and an integer value; work_experience / education with EXISTS and true. '
    + 'name / phone / email / protected.* are forbidden as field.',
  items: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Stable machine key, ^[a-z][a-z0-9_]{1,40}$, unique inside the version.',
      },
      label: { type: 'string', description: 'Human label, 1..200 characters.' },
      kind: {
        type: 'string',
        enum: [...CRITERION_KINDS],
        description: 'MUST_HAVE | NICE_TO_HAVE | DISQUALIFIER.',
      },
      weight: {
        type: 'number',
        description: '0..1 display weight; the sum over the array must be 1 (tolerance 1e-6). Weight never decides.',
      },
      field: {
        type: 'string',
        description: 'Mechanical field from the closed whitelist (timeline.covered_months_closed, '
          + 'work_experience.entry_count, education.entry_count, work_experience, education).',
      },
      operator: {
        type: 'string',
        enum: [...CRITERION_OPERATORS],
        description: 'EXISTS (boolean fields) | GTE | LTE (integer fields).',
      },
      value: {
        oneOf: [{ type: 'boolean' }, { type: 'integer' }],
        description: 'EXISTS requires true; GTE/LTE require an integer (months for timeline.covered_months_closed).',
      },
      question: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Judgment criterion: one answerable yes/no question, 1..500 characters. '
          + 'Required when field/operator/value are absent (e.g. degrees, industry, soft skills).',
      },
      notes: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Optional explanation, at most 1000 characters; never used for a decision.',
      },
    },
    required: ['key', 'label', 'kind', 'weight'],
    additionalProperties: false,
  },
}

/**
 * 把标量参数 schema 与 `criteria` 手工合并成对象根（`ParamMap` 表达不了 object[]）。
 * @param specs - 标量参数表。
 * @returns 模型可见的封闭对象根 schema。
 */
function writeParameterSchema(specs: ParamMap): Record<string, unknown> {
  const base = toParameterSchema(specs)
  const scalarProperties = base.properties as Record<string, unknown>
  return {
    type: 'object',
    properties: { ...scalarProperties, criteria: CRITERIA_PARAMETER_SCHEMA },
    required: [...(base.required as readonly string[])],
    additionalProperties: false,
  }
}

// ---------------------------------------------------------------------------
//  输出 schema（只有官方子集：type/oneOf/properties/required/additionalProperties/items/enum；
//  可空一律用 oneOf:[{...},{type:'null'}]，照 job-get.ts 的 NULLABLE_* 写法）
// ---------------------------------------------------------------------------

const NULLABLE_STRING: Record<string, unknown> = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
}

/**
 * 可空对象的 schema 片段。
 * @param properties - 对象属性。
 * @param required - 必填键。
 * @returns `oneOf:[object, null]` 片段。
 */
function nullableObject(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return {
    oneOf: [
      { type: 'object', properties, required: [...required], additionalProperties: false },
      { type: 'null' },
    ],
  }
}

/** 一条 criterion 在输出里逐字回显（只含实际给出的键：判断型没有 field/operator/value）。 */
const CRITERION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  description: 'One normalized criterion echoed verbatim: the 4 required keys plus only the optional keys '
    + 'that apply (a judgment criterion has no field/operator/value; a mechanical criterion has no question).',
}

const APPROVAL_OUTPUT_SCHEMA_PROPERTIES: Record<string, unknown> = {
  approval_id: { type: 'string' },
  status: {
    type: 'string',
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'WITHDRAWN'],
  },
  payload_schema_version: { type: 'integer' },
  canonical_payload_hash: { type: 'string' },
  requested_by_actor_id: NULLABLE_STRING,
}

const APPROVAL_OUTPUT_SCHEMA = nullableObject(APPROVAL_OUTPUT_SCHEMA_PROPERTIES, [
  'approval_id', 'status', 'payload_schema_version', 'canonical_payload_hash', 'requested_by_actor_id',
])

const RUBRIC_OUTPUT_SCHEMA = nullableObject({
  version_id: { type: 'string' },
  version_no: { type: 'integer' },
  payload_hash: { type: 'string' },
  criteria: { type: 'array', items: CRITERION_OUTPUT_SCHEMA },
  criteria_count: { type: 'integer' },
  must_have_count: { type: 'integer' },
  nice_to_have_count: { type: 'integer' },
  disqualifier_count: { type: 'integer' },
  is_approved: { type: 'boolean' },
  approval: APPROVAL_OUTPUT_SCHEMA,
}, [
  'version_id', 'version_no', 'payload_hash', 'criteria', 'criteria_count',
  'must_have_count', 'nice_to_have_count', 'disqualifier_count', 'is_approved', 'approval',
])

const JOB_VERSION_OUTPUT_SCHEMA = nullableObject({
  id: { type: 'string' },
  version_no: { type: 'integer' },
  payload_hash: { type: 'string' },
  description_md: NULLABLE_STRING,
  requirements_md: NULLABLE_STRING,
  approved_by_approval_id: NULLABLE_STRING,
  jd_source: { type: 'string', enum: ['PROVIDED', 'TITLE_PLACEHOLDER'] },
}, [
  'id', 'version_no', 'payload_hash', 'description_md', 'requirements_md',
  'approved_by_approval_id', 'jd_source',
])

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: [JOB_CREATE_TOOL, JOB_UPDATE_TOOL] },
    contract_version: { type: 'string' },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        // 岗位写工具不接任何外部系统（不读外部 ATS / 不读日历）：唯一如实取值是 NOT_CONNECTED。
        connection: { type: 'string', enum: ['NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    outcome: { type: 'string', enum: ['CREATED', 'UPDATED', 'UNCHANGED'] },
    department: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['id', 'name'],
      additionalProperties: false,
    },
    job: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        code: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        department_id: { type: 'string' },
        requisition_id: NULLABLE_STRING,
        current_job_version_id: NULLABLE_STRING,
        record_version: { type: 'integer' },
        status_changed_at: { type: 'string' },
      },
      required: [
        'id', 'code', 'title', 'status', 'department_id', 'requisition_id',
        'current_job_version_id', 'record_version', 'status_changed_at',
      ],
      additionalProperties: false,
    },
    job_version: JOB_VERSION_OUTPUT_SCHEMA,
    rubric: RUBRIC_OUTPUT_SCHEMA,
    next_action: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['APPROVE_RUBRIC', 'READ_BACK'] },
        job_id: { type: 'string' },
        approval_id: NULLABLE_STRING,
        verify_with: { type: 'string', enum: ['recruitment_job_get'] },
      },
      required: ['kind', 'job_id', 'approval_id', 'verify_with'],
      additionalProperties: false,
    },
  },
  required: [
    'tool', 'contract_version', 'labels', 'outcome', 'department', 'job',
    'job_version', 'rubric', 'next_action',
  ],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
//  输出值（与 SPEC §6 逐键对齐）
// ---------------------------------------------------------------------------

interface ApprovalValue {
  readonly approval_id: string
  readonly status: string
  readonly payload_schema_version: number
  readonly canonical_payload_hash: string
  readonly requested_by_actor_id: string | null
}

interface RubricValue {
  readonly version_id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly criteria: readonly Record<string, unknown>[]
  readonly criteria_count: number
  readonly must_have_count: number
  readonly nice_to_have_count: number
  readonly disqualifier_count: number
  readonly is_approved: boolean
  readonly approval: ApprovalValue | null
}

interface JobVersionValue {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly description_md: string | null
  readonly requirements_md: string | null
  readonly approved_by_approval_id: string | null
  readonly jd_source: 'PROVIDED' | 'TITLE_PLACEHOLDER'
}

interface JobValue {
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

/** 两个工具同形的规范输出值。 */
export interface JobWriteValue {
  readonly tool: string
  readonly contract_version: string
  /** R4 三维标签（`contracts/tenant-provenance.md`）：`provenance` 按租户事实算，不写死。 */
  readonly labels: {
    readonly provenance: 'LIVE' | 'FIXTURE'
    readonly trigger: 'MANUAL'
    readonly connection: 'NOT_CONNECTED'
  }
  readonly outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED'
  readonly department: { readonly id: string; readonly name: string }
  readonly job: JobValue
  readonly job_version: JobVersionValue | null
  readonly rubric: RubricValue | null
  readonly next_action: {
    readonly kind: 'APPROVE_RUBRIC' | 'READ_BACK'
    readonly job_id: string
    readonly approval_id: string | null
    readonly verify_with: 'recruitment_job_get'
  }
}

// ---------------------------------------------------------------------------
//  数据库行（只取本文件用到的列）
// ---------------------------------------------------------------------------

interface ActorRow {
  readonly kind: string
}

interface DepartmentRow {
  readonly id: string
  readonly name: string
}

interface JobRow {
  readonly id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly department_id: string
  readonly requisition_id: string | null
  readonly current_job_version_id: string | null
  readonly record_version: number
  readonly status_changed_at: string | Date
}

interface JobVersionRow {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly description_md: string | null
  readonly requirements_md: string | null
  readonly approved_by_approval_id: string | null
}

interface RubricRow {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly dimensions: readonly unknown[]
}

interface ApprovalRow {
  readonly id: string
  readonly status: string
  readonly payload_schema_version: number
  readonly canonical_payload_hash: string
  readonly requested_by_actor_id: string | null
}

interface ApprovalDecisionRow {
  readonly id: string
  readonly status: string
  readonly resource_type: string
  readonly resource_id: string
  readonly canonical_payload_hash: string
  readonly decision_by_actor_id: string | null
  readonly decided_at: string | Date | null
  readonly record_version: number
}

// ---------------------------------------------------------------------------
//  入参准备（纯函数：校验 + 归一化；工具包装与事务核心共用同一份）
// ---------------------------------------------------------------------------

/**
 * 一条参数违反项（与 `args.ts` 的 ArgViolation 同形，只在这里构造 criteria/互斥/trim 相关项）。
 * @param reason - 封闭 reason_code。
 * @param path - 参数路径。
 * @param message - 散文消息（与 collectArgViolations 风格一致）。
 */
function violation(reason: ArgViolationReason, path: string, message: string): ArgViolation {
  return { reason, path, message }
}

/**
 * 把违反项抛成契约错误（与 `parseContractArgs` 同形，首条 reason 即顶层 reason_code）。
 * @param specs - 标量参数表（用于 detail.allowed）。
 * @param violations - 至少一条违反项。
 */
function throwArgViolations(specs: ParamMap, violations: readonly ArgViolation[]): never {
  const first = violations[0] as ArgViolation
  throw contractError('INVALID_ARGS', {
    reason_code: first.reason,
    message: '参数不合法，逐条见 detail.violations',
    detail: {
      allowed: [...Object.keys(specs), 'criteria'],
      violations: violations.map((entry) => ({
        reason_code: entry.reason,
        path: entry.path,
        message: entry.message,
      })),
    },
  })
}

/**
 * 拆出标量参数并校验；`criteria` 单独拿走，避免被当成未知参数。
 * @param specs - 标量参数表。
 * @param raw - 模型给的 arguments。
 * @returns 已解析的标量与原始 criteria（可能 undefined）+ 违反项。
 */
function splitScalarsAndCriteria(
  specs: ParamMap,
  raw: unknown,
): { parsed: Record<string, unknown>; criteria: unknown; violations: ArgViolation[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    // 复用 args.ts 的 `arguments must be a JSON object`，不另造一条消息。
    const { violations } = collectArgViolations(specs, raw)
    return { parsed: {}, criteria: undefined, violations }
  }
  const record = raw as Record<string, unknown>
  const criteria = record.criteria
  const scalar: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (key === 'criteria') continue
    scalar[key] = record[key]
  }
  const { parsed, violations } = collectArgViolations(specs, scalar)
  return { parsed, criteria, violations }
}

/**
 * criteria 的**结构**校验（值语义留给 validateDimensions）：数组、1..50、元素是 object。
 * @param criteria - 入参 `criteria`（可能 undefined）。
 * @param violations - 原地追加。
 */
function checkCriteriaShape(criteria: unknown, violations: ArgViolation[]): void {
  if (criteria === undefined) return
  if (!Array.isArray(criteria)) {
    violations.push(violation('TYPE_MISMATCH', 'criteria', '"criteria" must be an array of criterion objects'))
    return
  }
  if (criteria.length < 1 || criteria.length > 50) {
    violations.push(violation(
      'OUT_OF_RANGE',
      'criteria',
      `"criteria" must contain 1..50 entries (got ${criteria.length})`,
    ))
  }
  for (const [index, item] of criteria.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      violations.push(violation(
        'TYPE_MISMATCH',
        `criteria[${index}]`,
        `"criteria[${index}]" must be a JSON object`,
      ))
    }
  }
}

/**
 * 校验并归一化 criteria（SPEC §5）：先验 raw（抓多余键），再归一化，再防御性二次验。
 * @param criteria - 已通过结构校验的 criteria 数组。
 * @returns 投影到封闭 9 键子集的归一化数组（缺省的可选键不写 null，直接省略）+ 其 canonical hash。
 */
function validateAndNormalizeCriteria(
  criteria: readonly unknown[],
): { normalized: readonly Record<string, unknown>[]; payload_hash: string } {
  // 先验 raw：归一化会丢掉多余键，所以多余键只能在归一化**之前**抓到（R-VAL-2）。
  const rawViolations = validateDimensions(criteria)
  if (rawViolations.length > 0) throwRubricInvalid(rawViolations)
  const normalized = normalizeCriteria(criteria)
  const normalizedViolations = validateDimensions(normalized)
  if (normalizedViolations.length > 0) throwRubricInvalid(normalizedViolations)
  return { normalized, payload_hash: digestOf(normalized) }
}

/**
 * 把 R-VAL 违反项抛成 `INVALID_ARGS / RUBRIC_INVALID`（detail 沿用 validateDimensions 的结构）。
 * @param violations - validateDimensions 的返回。
 */
function throwRubricInvalid(violations: readonly { rule: string; reason_code: string; path: string; got?: unknown }[]): never {
  throw contractError('INVALID_ARGS', {
    reason_code: 'RUBRIC_INVALID',
    message: 'criteria 没有通过 R-VAL-1..13，逐条见 detail.violations',
    detail: {
      violations: violations.map((entry) => ({
        rule: entry.rule,
        reason_code: entry.reason_code,
        path: entry.path,
        ...(entry.got === undefined ? {} : { got: entry.got }),
      })),
    },
  })
}

/**
 * 空白字符串视为"没给"：`ck_job_version_content` 要求至少一侧 btrim 后非空。
 * @param value - 入参原值。
 * @returns 原字符串，或 null。
 */
function blankToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value
}

/** create 的已校验入参。 */
interface PreparedCreate {
  readonly title: string
  readonly code: string | undefined
  readonly department_id: string | undefined
  readonly department_name: string | undefined
  readonly description_md: string | null
  readonly requirements_md: string | null
  readonly status: 'DRAFT' | 'OPEN'
  readonly criteria: readonly Record<string, unknown>[] | undefined
  readonly criteria_payload_hash: string | undefined
}

/** update 的已校验入参（undefined = 这一侧没给，与"给了 null"区分）。 */
interface PreparedUpdate {
  readonly job_id: string
  readonly expected_record_version: number | undefined
  readonly title: string | undefined
  readonly description_md: string | null | undefined
  readonly requirements_md: string | null | undefined
  readonly status: string | undefined
  readonly criteria: readonly Record<string, unknown>[] | undefined
  readonly criteria_payload_hash: string | undefined
}

/**
 * 校验 create 入参（结构 + trim 后的 title + 部门互斥 + criteria）。
 * @param raw - 模型给的 arguments。
 * @returns 已校验并归一化的入参。
 */
function prepareCreateArgs(raw: unknown): PreparedCreate {
  const { parsed, criteria, violations } = splitScalarsAndCriteria(CREATE_SCALAR_PARAMS, raw)
  checkCriteriaShape(criteria, violations)

  if (typeof parsed.department_id === 'string' && typeof parsed.department_name === 'string') {
    violations.push(violation(
      'MUTUALLY_EXCLUSIVE',
      'department_id',
      '"department_id" and "department_name" are mutually exclusive',
    ))
  }
  if (typeof parsed.code === 'string' && !JOB_CODE_RE.test(parsed.code)) {
    violations.push(violation(
      'OUT_OF_RANGE',
      'code',
      '"code" must match ^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$',
    ))
  }
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : undefined
  if (typeof parsed.title === 'string' && (title === undefined || title.length < 1 || title.length > 200)) {
    violations.push(violation('OUT_OF_RANGE', 'title', '"title" must be 1..200 characters after trimming'))
  }
  const departmentName = typeof parsed.department_name === 'string' ? parsed.department_name.trim() : undefined
  if (typeof parsed.department_name === 'string'
    && (departmentName === undefined || departmentName.length < 1 || departmentName.length > 200)) {
    violations.push(violation(
      'OUT_OF_RANGE',
      'department_name',
      '"department_name" must be 1..200 characters after trimming',
    ))
  }

  if (violations.length > 0) throwArgViolations(CREATE_SCALAR_PARAMS, violations)

  const normalizedCriteria = criteria === undefined
    ? undefined
    : validateAndNormalizeCriteria(criteria as readonly unknown[])

  return {
    title: title as string,
    code: parsed.code as string | undefined,
    department_id: parsed.department_id as string | undefined,
    department_name: departmentName,
    description_md: parsed.description_md === undefined ? null : blankToNull(parsed.description_md),
    requirements_md: parsed.requirements_md === undefined ? null : blankToNull(parsed.requirements_md),
    status: (parsed.status as 'DRAFT' | 'OPEN' | undefined) ?? 'DRAFT',
    criteria: normalizedCriteria?.normalized,
    criteria_payload_hash: normalizedCriteria?.payload_hash,
  }
}

/**
 * 校验 update 入参。
 * @param raw - 模型给的 arguments。
 * @returns 已校验并归一化的入参。
 */
function prepareUpdateArgs(raw: unknown): PreparedUpdate {
  const { parsed, criteria, violations } = splitScalarsAndCriteria(UPDATE_SCALAR_PARAMS, raw)
  checkCriteriaShape(criteria, violations)

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : undefined
  if (typeof parsed.title === 'string' && (title === undefined || title.length < 1 || title.length > 200)) {
    violations.push(violation('OUT_OF_RANGE', 'title', '"title" must be 1..200 characters after trimming'))
  }

  if (violations.length > 0) throwArgViolations(UPDATE_SCALAR_PARAMS, violations)

  const normalizedCriteria = criteria === undefined
    ? undefined
    : validateAndNormalizeCriteria(criteria as readonly unknown[])

  return {
    job_id: parsed.job_id as string,
    expected_record_version: parsed.expected_record_version as number | undefined,
    title,
    description_md: parsed.description_md === undefined ? undefined : blankToNull(parsed.description_md),
    requirements_md: parsed.requirements_md === undefined ? undefined : blankToNull(parsed.requirements_md),
    status: parsed.status as string | undefined,
    criteria: normalizedCriteria?.normalized,
    criteria_payload_hash: normalizedCriteria?.payload_hash,
  }
}

// ---------------------------------------------------------------------------
//  纯函数（单测可覆盖）
// ---------------------------------------------------------------------------

/**
 * 把入参 criterion 投影到**封闭的 9 键**子集：只保留**真的给了值**的键
 * （`undefined` / `null` 一律省略），数组顺序与给出的值原样保留，多余键被丢弃
 * （多余键由调用方在归一化前用 validateDimensions 拒绝）。
 *
 * **为什么不给缺省键写 `null`**（这是 2026-11-14 那个 S7 崩溃的根因）：
 * 判断型准则本来就没有 `field` / `operator` / `value`，机械型准则本来就没有 `question`；
 * 把「没有这个键」写成「这个键的值是 null」是**数据形状不诚实**——读侧只要有一处没判空，
 * 就会把 `field: null` 当成机械型字段送进 `resolveFieldFact()`（实测:
 * `TypeError: Cannot read properties of null (reading 'startsWith')`，
 * 凡是用产品入口建的、含判断型准则的 rubric 在 S7 一律崩）。落库形状要说真话：
 * 没有的键就不出现；`question` / `notes` 入参允许显式 `null`，按"没给"处理。
 * @param criteria - 模型给的（已通过结构校验）数组。
 * @returns 归一化数组（R-VAL-14 的 payload_hash 就对这个值求）。
 */
export function normalizeCriteria(criteria: readonly unknown[]): readonly Record<string, unknown>[] {
  return criteria.map((item) => {
    const record = typeof item === 'object' && item !== null && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {}
    const normalized: Record<string, unknown> = {}
    for (const key of CRITERION_KEYS) {
      const value = record[key]
      // `null` 与"没给"同义（输入 schema 允许 question/notes 显式 null）：不写这个键。
      if (value !== undefined && value !== null) normalized[key] = value
    }
    return normalized
  })
}

/** pg 错误里本文件关心的字段。 */
interface PgErrorInfo {
  readonly sqlstate: string
  readonly constraint: string | undefined
  readonly table: string | undefined
  readonly message: string
}

/**
 * 认出"数据库错误"（pg 的 `code` 是 5 位 SQLSTATE）并取出契约需要的字段。
 * @param error - 任意抛出物。
 * @returns 信息；不是数据库错误时为 null。
 */
function pgErrorInfo(error: unknown): PgErrorInfo | null {
  if (typeof error !== 'object' || error === null) return null
  const record = error as Record<string, unknown>
  if (typeof record.code !== 'string' || !/^[0-9A-Z]{5}$/.test(record.code)) return null
  return {
    sqlstate: record.code,
    constraint: typeof record.constraint === 'string' ? record.constraint : undefined,
    table: typeof record.table === 'string' ? record.table : undefined,
    message: typeof record.message === 'string' ? record.message : 'database error',
  }
}

/**
 * 把数据库错误映射成封闭的契约错误（SPEC §7）。**不吞信息**：
 * 三个可归因的 SQLSTATE（23505/23503/23514）进 INVALID_ARGS 并带
 * `detail:{sqlstate,constraint,table}`；其它 SQLSTATE 走 `READER_FAILED/DATABASE_FAILED`
 * 且正文保留原始消息；已构造好的 `RecruitmentToolError` 原样返回；
 * 非数据库错误（没有 SQLSTATE 的编程错误）**原样抛出**，不伪装成 SQL 失败。
 * @param error - 任意抛出物。
 * @returns 契约错误（或原样返回的契约错误）。
 */
export function mapDatabaseError(error: unknown): RecruitmentToolError {
  if (error instanceof RecruitmentToolError) return error
  const info = pgErrorInfo(error)
  if (info === null) throw error

  const detail = {
    sqlstate: info.sqlstate,
    constraint: info.constraint,
    table: info.table,
  }
  if (info.sqlstate === '23505') {
    if (info.constraint === 'uq_job_code') {
      return contractError('INVALID_ARGS', {
        reason_code: 'DUPLICATE_JOB_CODE',
        message: '岗位 code 已存在（同租户唯一；SQLSTATE 23505 / uq_job_code）',
        detail: { ...detail, code: 'DUPLICATE_JOB_CODE' },
      })
    }
    return contractError('INVALID_ARGS', {
      reason_code: 'UNIQUE_VIOLATION',
      message: `唯一约束冲突（SQLSTATE 23505 / ${info.constraint ?? 'unknown'}）`,
      detail,
    })
  }
  if (info.sqlstate === '23503') {
    return contractError('INVALID_ARGS', {
      reason_code: 'FOREIGN_KEY_VIOLATION',
      message: `外键约束冲突（SQLSTATE 23503 / ${info.constraint ?? 'unknown'}）`,
      detail,
    })
  }
  if (info.sqlstate === '23514') {
    return contractError('INVALID_ARGS', {
      reason_code: 'CONSTRAINT_VIOLATION',
      message: `检查约束失败（SQLSTATE 23514 / ${info.constraint ?? 'unknown'}）：${info.message.slice(0, 400)}`,
      detail,
    })
  }
  return contractError('READER_FAILED', {
    reason_code: 'DATABASE_FAILED',
    message: `数据库操作失败（SQLSTATE ${info.sqlstate}）：${info.message.slice(0, 400)}`,
    detail: { sqlstate: info.sqlstate },
  })
}

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

/**
 * `timestamptz` 列 → ISO 文本。
 * @param value - pg 给的 Date 或字符串。
 */
function iso(value: string | Date | null): string | null {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/**
 * 生成 `JOB-<YYYYMMDD>-<6 位大写 hex>`（日期取服务端 UTC，保证任何时区都可复现）。
 * @returns 合法且长度 2..41 的岗位 code。
 */
function generateJobCode(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `JOB-${day}-${randomBytes(3).toString('hex').toUpperCase()}`
}

/**
 * `jd_source`：只有"标题即 JD"的占位版本才是 TITLE_PLACEHOLDER（库不存这个标记，
 * 所以用 create 时写入的那条不变量反推：requirements 为空且 description 恰等于 title）。
 * @param jobVersion - 版本行（可空）。
 * @param jobTitle - 当前标题。
 */
function jdSourceOf(jobVersion: JobVersionRow | undefined, jobTitle: string): 'PROVIDED' | 'TITLE_PLACEHOLDER' {
  if (jobVersion === undefined) return 'PROVIDED'
  return jobVersion.requirements_md === null && jobVersion.description_md === jobTitle
    ? 'TITLE_PLACEHOLDER'
    : 'PROVIDED'
}

/**
 * 组装输出里的 `job_version` 块。
 * @param row - job_version 行。
 * @param jdSource - 占位/真实 JD 的判定结果。
 */
function jobVersionValue(row: JobVersionRow, jdSource: 'PROVIDED' | 'TITLE_PLACEHOLDER'): JobVersionValue {
  return {
    id: row.id,
    version_no: row.version_no,
    payload_hash: row.payload_hash,
    description_md: row.description_md,
    requirements_md: row.requirements_md,
    approved_by_approval_id: row.approved_by_approval_id,
    jd_source: jdSource,
  }
}

/**
 * 组装输出里的 `approval` 块。
 * @param row - approval 行。
 */
function approvalValue(row: ApprovalRow): ApprovalValue {
  return {
    approval_id: row.id,
    status: row.status,
    payload_schema_version: row.payload_schema_version,
    canonical_payload_hash: row.canonical_payload_hash,
    requested_by_actor_id: row.requested_by_actor_id,
  }
}

/**
 * 按 kind 统计（只用于输出概览；结构问题由 validateDimensions 负责）。
 * @param criteria - 归一化 criteria。
 */
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

/**
 * 组装输出里的 `rubric` 块。
 * @param row - rubric_version 行（dimensions 即归一化 criteria）。
 * @param approval - 最近的 approval 行（可能没有：旧数据或手工造的夹具）。
 */
function rubricValue(row: RubricRow, approval: ApprovalRow | undefined): RubricValue {
  const criteria = row.dimensions as readonly Record<string, unknown>[]
  const counts = countKinds(criteria)
  const approvalBlock = approval === undefined ? null : approvalValue(approval)
  return {
    version_id: row.id,
    version_no: row.version_no,
    payload_hash: row.payload_hash,
    criteria,
    criteria_count: criteria.length,
    must_have_count: counts.must,
    nice_to_have_count: counts.nice,
    disqualifier_count: counts.disq,
    // 读侧 §4.2 才是有权威的判据；本输出的布尔只是"这一行是否已有一份匹配的 APPROVED"。
    is_approved: approvalBlock !== null
      && approvalBlock.status === 'APPROVED'
      && approvalBlock.canonical_payload_hash === row.payload_hash,
    approval: approvalBlock,
  }
}

/**
 * 组装 `next_action`：有 PENDING 审批就提示人批准，否则读回。
 * @param jobId - 岗位 id。
 * @param rubric - 本次输出里的 rubric 块（可空）。
 */
function nextAction(
  jobId: string,
  rubric: RubricValue | null,
): JobWriteValue['next_action'] {
  const approvalId = rubric?.approval?.approval_id ?? null
  return {
    kind: rubric?.approval?.status === 'PENDING' ? 'APPROVE_RUBRIC' : 'READ_BACK',
    job_id: jobId,
    approval_id: approvalId,
    verify_with: 'recruitment_job_get',
  }
}

/**
 * 组装岗位块。
 * @param row - job 行（可能来自 INSERT 或 UPDATE ... RETURNING）。
 */
function jobValue(row: JobRow): JobValue {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    status: row.status,
    department_id: row.department_id,
    requisition_id: row.requisition_id,
    current_job_version_id: row.current_job_version_id,
    record_version: row.record_version,
    status_changed_at: iso(row.status_changed_at) as string,
  }
}

/**
 * 组装整份输出（两个工具同形）。
 * @param tool - 工具名。
 * @param outcome - CREATED / UPDATED / UNCHANGED。
 * @param department - 已解析的部门。
 * @param job - job 行。
 * @param jobVersion - job_version 行。
 * @param jdSource - JD 来源标记。
 * @param rubric - rubric 块（可空）。
 * @param labels - R4 三维标签（调用方用 `buildThreeAxisLabels` 按租户事实算出后传入）。
 */
function jobWriteValue(
  tool: string,
  outcome: JobWriteValue['outcome'],
  department: DepartmentRow,
  job: JobRow,
  jobVersion: JobVersionRow | undefined,
  jdSource: 'PROVIDED' | 'TITLE_PLACEHOLDER',
  rubric: RubricValue | null,
  labels: JobWriteValue['labels'],
): JobWriteValue {
  return {
    tool,
    contract_version: CONTRACT_VERSION,
    labels,
    outcome,
    department: { id: department.id, name: department.name },
    job: jobValue(job),
    job_version: jobVersion === undefined ? null : jobVersionValue(jobVersion, jdSource),
    rubric,
    next_action: nextAction(job.id, rubric),
  }
}

// ---------------------------------------------------------------------------
//  事务核心：recruitment_job_create
// ---------------------------------------------------------------------------

/**
 * 列出租户下的部门（用于 `known_departments` 候选）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 */
async function listDepartments(client: DatabaseClient, tenantId: string): Promise<DepartmentRow[]> {
  const { rows } = await client.query<DepartmentRow>(
    `select id, name
       from recruitment.department
      where tenant_id = $1
      order by lower(name), id`,
    [tenantId],
  )
  return rows
}

/**
 * 解析部门（SPEC §3）：`department_id` → `department_name` → 该租户唯一部门。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param input - 已校验的 create 入参。
 */
async function resolveDepartment(
  client: DatabaseClient,
  tenantId: string,
  input: PreparedCreate,
): Promise<DepartmentRow> {
  if (input.department_id !== undefined) {
    const { rows } = await client.query<DepartmentRow>(
      `select id, name from recruitment.department where id = $1 and tenant_id = $2`,
      [input.department_id, tenantId],
    )
    const row = rows[0]
    if (row !== undefined) return row
    const known = await listDepartments(client, tenantId)
    throw contractError('INVALID_ARGS', {
      reason_code: 'DEPARTMENT_NOT_FOUND',
      message: `租户下没有部门 ${input.department_id}`,
      detail: { department_id: input.department_id, known_departments: known },
    })
  }

  if (input.department_name !== undefined) {
    const { rows } = await client.query<DepartmentRow>(
      `select id, name
         from recruitment.department
        where tenant_id = $1 and lower(btrim(name)) = lower(btrim($2))
        order by lower(name), id`,
      [tenantId, input.department_name],
    )
    if (rows.length === 1) return rows[0] as DepartmentRow
    if (rows.length === 0) {
      const known = await listDepartments(client, tenantId)
      throw contractError('INVALID_ARGS', {
        reason_code: 'DEPARTMENT_NOT_FOUND',
        message: `租户下没有名为 ${input.department_name} 的部门`,
        detail: { department_name: input.department_name, known_departments: known },
      })
    }
    // 0001 没有 department.name 的唯一约束，同名多行必须让调用方选 id（不猜）。
    throw contractError('INVALID_ARGS', {
      reason_code: 'DEPARTMENT_REQUIRED',
      message: `部门名 ${input.department_name} 命中 ${rows.length} 行，请改用 department_id`,
      detail: { department_name: input.department_name, known_departments: rows },
    })
  }

  const all = await listDepartments(client, tenantId)
  if (all.length === 1) return all[0] as DepartmentRow
  if (all.length === 0) {
    throw contractError('INVALID_ARGS', {
      reason_code: 'DEPARTMENT_NOT_FOUND',
      message: '租户下没有任何部门，无法建岗位（请先建部门或显式给 department_id）',
      detail: { known_departments: [] },
    })
  }
  throw contractError('INVALID_ARGS', {
    reason_code: 'DEPARTMENT_REQUIRED',
    message: `租户下有 ${all.length} 个部门，必须显式给 department_id 或 department_name`,
    detail: { known_departments: all },
  })
}

/**
 * 建岗位（+ 可选 v1 标准）并返回规范值。**必须在调用方的事务里执行**
 * （工具包装用 `withActor`；集成测试用回滚事务）。
 * @param client - 事务内客户端。
 * @param cfg - 已解析的库配置（tenant/actor 只从这里来）。
 * @param args - 模型入参（本函数自己再校验一次，保证集成测试直调也安全）。
 * @returns 规范输出值（outcome='CREATED'）。
 */
export async function createJobInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
): Promise<JobWriteValue> {
  const input = prepareCreateArgs(args)

  try {
    // 1. actor 必须属于配置租户；否则 FORBIDDEN（不是 NOT_FOUND：这是身份问题）。
    const actorResult = await client.query<ActorRow>(
      `select kind from recruitment.actor where id = $1 and tenant_id = $2`,
      [cfg.actor_id, cfg.tenant_id],
    )
    if (actorResult.rows[0] === undefined) {
      throw contractError('FORBIDDEN', {
        reason_code: 'ACTOR_NOT_IN_TENANT',
        message: `actor ${cfg.actor_id} 不存在或不属于租户 ${cfg.tenant_id}`,
        detail: { actor_id: cfg.actor_id, tenant_id: cfg.tenant_id },
      })
    }

    // 2. 部门解析。
    const department = await resolveDepartment(client, cfg.tenant_id, input)

    // 3. criteria 已在 prepareCreateArgs 里归一化 + 求 hash（R-VAL-14 的写侧一半）。
    // 4. job 行。
    const code = input.code ?? generateJobCode()
    const jobInsert = await client.query<JobRow>(
      `insert into recruitment.job (tenant_id, department_id, code, title, status)
       values ($1, $2, $3, $4, $5)
       returning id, code, title, status, department_id, requisition_id,
                 current_job_version_id, record_version, status_changed_at`,
      [cfg.tenant_id, department.id, code, input.title, input.status],
    )
    const job = jobInsert.rows[0]
    if (job === undefined) {
      throw new RecruitmentToolError('READER_FAILED', 'job insert returned no row')
    }

    // 5. job_version v1。两个字段都省略时，description_md = title（TITLE_PLACEHOLDER），
    //    绝不伪造"真实 JD 内容"；落库值就是参与 payload_hash 的值。
    const placeholder = input.description_md === null && input.requirements_md === null
    const descriptionMd = placeholder ? job.title : input.description_md
    const requirementsMd = input.requirements_md
    const jobVersionHash = digestOf({ description_md: descriptionMd, requirements_md: requirementsMd })
    const jobVersionInsert = await client.query<JobVersionRow>(
      `insert into recruitment.job_version
         (tenant_id, job_id, version_no, description_md, requirements_md, payload_hash, created_by_actor_id)
       values ($1, $2, 1, $3, $4, $5, $6)
       returning id, version_no, payload_hash, description_md, requirements_md, approved_by_approval_id`,
      [cfg.tenant_id, job.id, descriptionMd, requirementsMd, jobVersionHash, cfg.actor_id],
    )
    const jobVersion = jobVersionInsert.rows[0]
    if (jobVersion === undefined) {
      throw new RecruitmentToolError('READER_FAILED', 'job_version insert returned no row')
    }
    const jdSource: 'PROVIDED' | 'TITLE_PLACEHOLDER' = placeholder ? 'TITLE_PLACEHOLDER' : 'PROVIDED'

    // 6. 有 criteria 才有 rubric/approval（缺标准是合法状态：job_get 回 NO_RUBRIC_AT_ALL）。
    let rubric: RubricValue | null = null
    if (input.criteria !== undefined) {
      const rubricInsert = await client.query<RubricRow>(
        `insert into recruitment.rubric_version
           (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
         values ($1, $2, 1, $3::jsonb, $4, $5)
         returning id, version_no, payload_hash, dimensions`,
        [
          cfg.tenant_id,
          job.id,
          JSON.stringify(input.criteria),
          input.criteria_payload_hash as string,
          cfg.actor_id,
        ],
      )
      const rubricRow = rubricInsert.rows[0]
      if (rubricRow === undefined) {
        throw new RecruitmentToolError('READER_FAILED', 'rubric_version insert returned no row')
      }
      // 批准是人的动作：这里只写 PENDING（ruling 1）。
      const approvalInsert = await client.query<ApprovalRow>(
        `insert into recruitment.approval
           (tenant_id, resource_type, resource_id, resource_record_version,
            payload_schema_version, canonical_payload_hash, status, requested_by_actor_id)
         values ($1, 'RUBRIC_VERSION', $2, 1, 1, $3, 'PENDING', $4)
         returning id, status, payload_schema_version, canonical_payload_hash, requested_by_actor_id`,
        [cfg.tenant_id, rubricRow.id, input.criteria_payload_hash as string, cfg.actor_id],
      )
      const approval = approvalInsert.rows[0]
      if (approval === undefined) {
        throw new RecruitmentToolError('READER_FAILED', 'approval insert returned no row')
      }
      rubric = rubricValue(rubricRow, approval)
    }

    // 7. 一个 UPDATE 收尾：把 current_job_version_id 指向 v1。
    //    fn_row_guard 会自增 record_version，所以必须用 RETURNING 的真实值。
    const touched = await client.query<{ record_version: number; status_changed_at: string | Date }>(
      `update recruitment.job
          set current_job_version_id = $3
        where id = $1 and tenant_id = $2
        returning record_version, status_changed_at`,
      [job.id, cfg.tenant_id, jobVersion.id],
    )
    const finalTouch = touched.rows[0]
    const finalJob: JobRow = {
      ...job,
      current_job_version_id: jobVersion.id,
      record_version: finalTouch?.record_version ?? job.record_version,
      status_changed_at: finalTouch?.status_changed_at ?? job.status_changed_at,
    }

    // R4 三维标签：按租户事实算（演示租户 ⇒ FIXTURE），不写死 LIVE。
    const labels = await buildThreeAxisLabels(client, cfg.tenant_id)
    return jobWriteValue(JOB_CREATE_TOOL, 'CREATED', department, finalJob, jobVersion, jdSource, rubric, labels)
  } catch (error) {
    // 只映射当前错误，不在 catch 里补查询（25P02：事务已被终止）。
    throw mapDatabaseError(error)
  }
}

// ---------------------------------------------------------------------------
//  事务核心：recruitment_job_update
// ---------------------------------------------------------------------------

/** 版本自增的下一个 version_no。 */
async function nextVersionNo(
  client: DatabaseClient,
  table: 'job_version' | 'rubric_version',
  tenantId: string,
  jobId: string,
): Promise<number> {
  // 表名来自本文件的字面量联合，不是模型输入（无注入面）。
  const { rows } = await client.query<{ next_version_no: number }>(
    `select coalesce(max(version_no), 0) + 1 as next_version_no
       from recruitment.${table}
      where tenant_id = $1 and job_id = $2`,
    [tenantId, jobId],
  )
  return rows[0]?.next_version_no ?? 1
}

/**
 * 更新岗位：只追加版本，旧行一个字节都不改（ruling 2）。
 * **必须在调用方的事务里执行**（会 `select ... for update` 锁住 job 行）。
 * @param client - 事务内客户端。
 * @param cfg - 已解析的库配置。
 * @param args - 模型入参（本函数自己再校验一次）。
 * @returns 规范输出值（CREATED 不可能出现；UPDATED / UNCHANGED）。
 */
export async function updateJobInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
): Promise<JobWriteValue> {
  const input = prepareUpdateArgs(args)

  try {
    const jobResult = await client.query<JobRow>(
      `select id, code, title, status, department_id, requisition_id,
              current_job_version_id, record_version, status_changed_at
         from recruitment.job
        where id = $1 and tenant_id = $2
        for update`,
      [input.job_id, cfg.tenant_id],
    )
    const job = jobResult.rows[0]
    if (job === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'JOB_NOT_FOUND',
        message: `该租户下没有岗位 ${input.job_id}`,
        detail: { job_id: input.job_id },
      })
    }
    if (input.expected_record_version !== undefined && input.expected_record_version !== job.record_version) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'VERSION_CONFLICT',
        message: `岗位 ${input.job_id} 的 record_version 不是 ${input.expected_record_version}`,
        detail: { expected: input.expected_record_version, actual: job.record_version },
      })
    }

    const departmentResult = await client.query<DepartmentRow>(
      `select id, name from recruitment.department where id = $1 and tenant_id = $2`,
      [job.department_id, cfg.tenant_id],
    )
    const department = departmentResult.rows[0] ?? { id: job.department_id, name: '' }

    // 当前 job_version（"未给的一侧沿用当前版本"的基准，也是输出兜底）。
    let currentVersion: JobVersionRow | undefined
    if (job.current_job_version_id !== null) {
      const currentResult = await client.query<JobVersionRow>(
        `select id, version_no, payload_hash, description_md, requirements_md, approved_by_approval_id
           from recruitment.job_version
          where id = $1 and tenant_id = $2`,
        [job.current_job_version_id, cfg.tenant_id],
      )
      currentVersion = currentResult.rows[0]
    }

    // 新 job_version：只有"给了任一侧 JD"才可能追加；hash 相同则视为幂等重试。
    let newJobVersion: JobVersionRow | undefined
    let mergedDescription = currentVersion?.description_md ?? null
    let mergedRequirements = currentVersion?.requirements_md ?? null
    if (input.description_md !== undefined || input.requirements_md !== undefined) {
      mergedDescription = input.description_md !== undefined
        ? input.description_md
        : (currentVersion?.description_md ?? null)
      mergedRequirements = input.requirements_md !== undefined
        ? input.requirements_md
        : (currentVersion?.requirements_md ?? null)
      const hash = digestOf({ description_md: mergedDescription, requirements_md: mergedRequirements })
      if (currentVersion === undefined || hash !== currentVersion.payload_hash) {
        const versionNo = await nextVersionNo(client, 'job_version', cfg.tenant_id, job.id)
        const insert = await client.query<JobVersionRow>(
          `insert into recruitment.job_version
             (tenant_id, job_id, version_no, description_md, requirements_md, payload_hash, created_by_actor_id)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning id, version_no, payload_hash, description_md, requirements_md, approved_by_approval_id`,
          [
            cfg.tenant_id, job.id, versionNo, mergedDescription, mergedRequirements,
            hash, cfg.actor_id,
          ],
        )
        newJobVersion = insert.rows[0]
        if (newJobVersion === undefined) {
          throw new RecruitmentToolError('READER_FAILED', 'job_version insert returned no row')
        }
      }
    }

    // 新 rubric_version + 新 PENDING approval；旧 approval **不** supersede（历史批准保持）。
    let rubricRow: RubricRow | undefined
    let rubricApproval: ApprovalRow | undefined
    let rubricCreated = false
    if (input.criteria !== undefined) {
      const latestResult = await client.query<RubricRow>(
        `select id, version_no, payload_hash, dimensions
           from recruitment.rubric_version
          where tenant_id = $1 and job_id = $2
          order by version_no desc
          limit 1`,
        [cfg.tenant_id, job.id],
      )
      const latest = latestResult.rows[0]
      if (latest !== undefined && latest.payload_hash === input.criteria_payload_hash) {
        // 与最近一版 hash 相同：不新建（幂等重试），输出仍回显那一版。
        rubricRow = latest
        const approvalResult = await client.query<ApprovalRow>(
          `select id, status, payload_schema_version, canonical_payload_hash, requested_by_actor_id
             from recruitment.approval
            where tenant_id = $1 and resource_type = 'RUBRIC_VERSION' and resource_id = $2
            order by created_at desc, id desc
            limit 1`,
          [cfg.tenant_id, latest.id],
        )
        rubricApproval = approvalResult.rows[0]
      } else {
        const versionNo = (latest?.version_no ?? 0) + 1
        const insert = await client.query<RubricRow>(
          `insert into recruitment.rubric_version
             (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
           values ($1, $2, $3, $4::jsonb, $5, $6)
           returning id, version_no, payload_hash, dimensions`,
          [
            cfg.tenant_id, job.id, versionNo, JSON.stringify(input.criteria),
            input.criteria_payload_hash as string, cfg.actor_id,
          ],
        )
        rubricRow = insert.rows[0]
        if (rubricRow === undefined) {
          throw new RecruitmentToolError('READER_FAILED', 'rubric_version insert returned no row')
        }
        const approvalInsert = await client.query<ApprovalRow>(
          `insert into recruitment.approval
             (tenant_id, resource_type, resource_id, resource_record_version,
              payload_schema_version, canonical_payload_hash, status, requested_by_actor_id)
           values ($1, 'RUBRIC_VERSION', $2, $3, 1, $4, 'PENDING', $5)
           returning id, status, payload_schema_version, canonical_payload_hash, requested_by_actor_id`,
          [
            cfg.tenant_id, rubricRow.id, rubricRow.version_no,
            input.criteria_payload_hash as string, cfg.actor_id,
          ],
        )
        rubricApproval = approvalInsert.rows[0]
        if (rubricApproval === undefined) {
          throw new RecruitmentToolError('READER_FAILED', 'approval insert returned no row')
        }
        rubricCreated = true
      }
    }

    // job 的 title / status / current_job_version_id 合并成**一条** UPDATE；无变化则跳过，
    // 否则 fn_row_guard 会把 record_version 白白 +1（那会让"幂等重试"看起来像改动）。
    const nextTitle = input.title ?? job.title
    const nextStatus = input.status ?? job.status
    const nextCurrentVersionId = newJobVersion?.id ?? job.current_job_version_id
    const jobChanged = nextTitle !== job.title
      || nextStatus !== job.status
      || nextCurrentVersionId !== job.current_job_version_id

    let finalJob = job
    if (jobChanged) {
      const updated = await client.query<JobRow>(
        `update recruitment.job
            set title = $3,
                status = $4,
                current_job_version_id = $5
          where id = $1 and tenant_id = $2
          returning id, code, title, status, department_id, requisition_id,
                    current_job_version_id, record_version, status_changed_at`,
        [job.id, cfg.tenant_id, nextTitle, nextStatus, nextCurrentVersionId],
      )
      finalJob = updated.rows[0] ?? job
    }

    const rubric = rubricRow === undefined ? null : rubricValue(rubricRow, rubricApproval)
    const jobVersion = newJobVersion ?? currentVersion
    const outcome: JobWriteValue['outcome'] = jobChanged || newJobVersion !== undefined || rubricCreated
      ? 'UPDATED'
      : 'UNCHANGED'

    // R4 三维标签：按租户事实算（演示租户 ⇒ FIXTURE），不写死 LIVE。
    const labels = await buildThreeAxisLabels(client, cfg.tenant_id)

    return jobWriteValue(
      JOB_UPDATE_TOOL,
      outcome,
      department,
      finalJob,
      jobVersion,
      jdSourceOf(jobVersion, finalJob.title),
      rubric,
      labels,
    )
  } catch (error) {
    throw mapDatabaseError(error)
  }
}

// ---------------------------------------------------------------------------
//  人的批准动作（不是模型工具）
// ---------------------------------------------------------------------------

/** `decideRubricApproval` 的入参（人类动作）。 */
export interface DecideRubricApprovalInput {
  readonly approval_id: string
  readonly decision: 'APPROVE' | 'REJECT'
  readonly reason?: string
}

/** `decideRubricApproval` 的返回值。 */
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

/**
 * 以人类身份批/拒一份 rubric 审批。**必须在调用方事务里执行**。
 *
 * 校验顺序（每步都有真实负例）：
 *   1. 入参形状（decision / approval_id / REJECT 必须给 reason）；
 *   2. 决定者 `actor.kind`（0 行 → ACTOR_NOT_IN_TENANT；非 HUMAN → ACTOR_NOT_HUMAN）；
 *   3. approval 存在且属于本租户（租户隔离负例走这里）；
 *   4. approval 仍是 PENDING（重复批准 → APPROVAL_NOT_PENDING，detail 带当前 status）；
 *   5. canonical_payload_hash 与 rubric_version.payload_hash 一致（R-VAL-14 的读侧一半）。
 *
 * 不碰 `rubric_version.approved_by_approval_id`：那一列是历史行，不可变（ruling 2）。
 * @param client - 事务内客户端。
 * @param cfg - 已解析的库配置。
 * @param input - 批准/拒绝入参。
 * @param actorId - 决定者（缺省 = 配置里的 actor，通常是 HR）。
 * @returns 决定后的审批值。
 */
export async function decideRubricApprovalInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  input: DecideRubricApprovalInput,
  actorId?: string,
): Promise<DecideRubricApprovalValue> {
  const approvalId = typeof input.approval_id === 'string' ? input.approval_id.trim() : ''
  if (!UUID_RE.test(approvalId)) {
    throw contractError('INVALID_ARGS', {
      reason_code: 'ID_NOT_UUID',
      message: 'approval_id 必须是 UUID',
      detail: { approval_id: input.approval_id },
    })
  }
  if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') {
    throw contractError('INVALID_ARGS', {
      reason_code: 'DECISION_INVALID',
      message: 'decision 只能是 APPROVE 或 REJECT',
      detail: { decision: input.decision },
    })
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (input.decision === 'REJECT' && reason === '') {
    // ck_approval_reject_reason 的库级兜底在下面，但先给人话（否则只会看到 23514）。
    throw contractError('INVALID_ARGS', {
      reason_code: 'REASON_REQUIRED',
      message: '拒绝审批必须给 reason（拒绝理由会进入审批历史）',
      detail: { approval_id: approvalId, decision: input.decision },
    })
  }

  const decidedBy = actorId ?? cfg.actor_id
  if (!UUID_RE.test(decidedBy)) {
    throw contractError('INVALID_ARGS', {
      reason_code: 'ID_NOT_UUID',
      message: 'actorId 必须是 UUID',
      detail: { actor_id: decidedBy },
    })
  }

  try {
    // 1. 决定者必须是本租户的 **HUMAN**：SYSTEM / AGENT_WORKER 不能替人签字。
    const actorResult = await client.query<ActorRow>(
      `select kind from recruitment.actor where id = $1 and tenant_id = $2`,
      [decidedBy, cfg.tenant_id],
    )
    const actor = actorResult.rows[0]
    if (actor === undefined) {
      throw contractError('FORBIDDEN', {
        reason_code: 'ACTOR_NOT_IN_TENANT',
        message: `actor ${decidedBy} 不存在或不属于租户 ${cfg.tenant_id}`,
        detail: { actor_id: decidedBy, tenant_id: cfg.tenant_id },
      })
    }
    if (actor.kind !== 'HUMAN') {
      throw contractError('FORBIDDEN', {
        reason_code: 'ACTOR_NOT_HUMAN',
        message: `actor ${decidedBy} 的 kind 是 ${actor.kind}，审批只允许 HUMAN`,
        detail: { actor_id: decidedBy, kind: actor.kind },
      })
    }

    // 若显式指定了与配置不同的决定者，让库级审计列（status_changed_by_actor_id）
    // 记到这个人头上。is_local=true ⇒ 只在本事务内有效，不泄漏给连接池（IR-M4d）。
    if (actorId !== undefined && actorId !== cfg.actor_id) {
      await client.query("select set_config('recruitment.actor_id', $1, true)", [actorId])
    }

    // 2. 锁住审批行（两个人同时批同一份，只会有一个赢）。
    const approvalResult = await client.query<ApprovalRow & { resource_type: string; resource_id: string }>(
      `select id, resource_type, resource_id, status, payload_schema_version,
              canonical_payload_hash, requested_by_actor_id
         from recruitment.approval
        where id = $1 and tenant_id = $2
        for update`,
      [approvalId, cfg.tenant_id],
    )
    const approval = approvalResult.rows[0]
    if (approval === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'APPROVAL_NOT_FOUND',
        message: `该租户下没有审批 ${approvalId}`,
        detail: { approval_id: approvalId },
      })
    }
    if (approval.resource_type !== 'RUBRIC_VERSION') {
      throw contractError('NOT_FOUND', {
        reason_code: 'APPROVAL_NOT_FOUND',
        message: `审批 ${approvalId} 不是 RUBRIC_VERSION 审批（resource_type=${approval.resource_type}）`,
        detail: { approval_id: approvalId, resource_type: approval.resource_type },
      })
    }
    if (approval.status !== 'PENDING') {
      throw contractError('INVALID_ARGS', {
        reason_code: 'APPROVAL_NOT_PENDING',
        message: `审批 ${approvalId} 已经是 ${approval.status}，不能重复决定`,
        detail: { approval_id: approvalId, status: approval.status },
      })
    }

    // 3. 审批绑的是内容：hash 对不上就说明"被批准的是另一份标准"。
    const rubricResult = await client.query<{ id: string; job_id: string; version_no: number; payload_hash: string }>(
      `select id, job_id, version_no, payload_hash
         from recruitment.rubric_version
        where id = $1 and tenant_id = $2`,
      [approval.resource_id, cfg.tenant_id],
    )
    const rubric = rubricResult.rows[0]
    if (rubric === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'RUBRIC_VERSION_NOT_FOUND',
        message: `审批 ${approvalId} 指向的 rubric_version 不存在（不属于本租户？）`,
        detail: { approval_id: approvalId, resource_id: approval.resource_id },
      })
    }
    if (approval.payload_schema_version !== 1) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'UNSUPPORTED_PAYLOAD_SCHEMA_VERSION',
        message: `审批 ${approvalId} 的 payload_schema_version 是 ${approval.payload_schema_version}，本契约只支持 1`,
        detail: { approval_id: approvalId, payload_schema_version: approval.payload_schema_version },
      })
    }
    if (approval.canonical_payload_hash !== rubric.payload_hash) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'PAYLOAD_HASH_MISMATCH',
        message: `审批 ${approvalId} 绑定的 hash 与 rubric v${rubric.version_no} 不一致`,
        detail: {
          approval_id: approvalId,
          approval_hash: approval.canonical_payload_hash,
          rubric_hash: rubric.payload_hash,
        },
      })
    }

    // 4. 落决定。fn_row_guard 会补 status_changed_at/by + record_version+1；
    //    ck_approval_decided_fields 要求 decided_at 与 decision_by_actor_id 同时非空。
    const decisionStatus = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'
    const decided = await client.query<ApprovalDecisionRow>(
      `update recruitment.approval
          set status = $3,
              decision_by_actor_id = $4,
              decided_at = now(),
              reason = $5
        where id = $1 and tenant_id = $2
        returning id, status, resource_type, resource_id, canonical_payload_hash,
                  decision_by_actor_id, decided_at, record_version`,
      [approvalId, cfg.tenant_id, decisionStatus, decidedBy, reason === '' ? null : reason],
    )
    const row = decided.rows[0]
    if (row === undefined || row.decision_by_actor_id === null || row.decided_at === null) {
      throw new RecruitmentToolError('READER_FAILED', 'approval update returned an incomplete row')
    }
    if (row.status !== 'APPROVED' && row.status !== 'REJECTED') {
      throw new RecruitmentToolError('READER_FAILED', `approval update returned status ${row.status}`)
    }

    return {
      approval_id: row.id,
      status: row.status,
      resource_type: 'RUBRIC_VERSION',
      resource_id: row.resource_id,
      job_id: rubric.job_id,
      rubric_version_no: rubric.version_no,
      canonical_payload_hash: row.canonical_payload_hash,
      decided_by_actor_id: row.decision_by_actor_id,
      decided_at: iso(row.decided_at) as string,
      record_version: row.record_version,
    }
  } catch (error) {
    throw mapDatabaseError(error)
  }
}

/**
 * 人的批准动作（自带连接池 + 事务 + actor；供 CLI / 未来的 Web 按钮复用）。
 * @param database - 已解析的库配置。
 * @param input - 批准/拒绝入参。
 * @param actorId - 决定者（缺省 = 配置里的 actor）。
 * @returns 决定后的审批值。
 */
export async function decideRubricApproval(
  database: ResolvedDatabaseConfig,
  input: DecideRubricApprovalInput,
  actorId?: string,
): Promise<DecideRubricApprovalValue> {
  const effectiveActor = actorId ?? database.actor_id
  const pool = createPool(database)
  try {
    return await withActor(
      pool,
      effectiveActor,
      async (client) => decideRubricApprovalInTransaction(client, database, input, actorId),
    )
  } catch (error) {
    throw mapDatabaseError(error)
  } finally {
    await closePool(pool)
  }
}

// ---------------------------------------------------------------------------
//  模型可见说明（SPEC §8 五条；模型只靠 description 就能写出合法 criteria）
// ---------------------------------------------------------------------------

/** 两个工具共用的 criteria 契约（§8 第 2/3/5 条）。 */
const CRITERIA_HELP = [
  '',
  'criteria — CLOSED KEY SET (9 rubric keys), ANY EXTRA KEY IS REJECTED',
  '{"key","label","kind","weight","field","operator","value","question","notes"}',
  '- key: ^[a-z][a-z0-9_]{1,40}$, unique inside the version.',
  '- label: 1..200 characters.',
  '- kind: MUST_HAVE | NICE_TO_HAVE | DISQUALIFIER. At least one MUST_HAVE or DISQUALIFIER is mandatory; '
    + 'a version made only of NICE_TO_HAVE cannot decide anything.',
  '- weight: 0..1, and the sum over the whole array MUST be 1 (tolerance 1e-6). Weight is display/sort only; '
    + 'it never decides a verdict.',
  '- Omit the keys that do not apply. Do NOT send null placeholders: a judgment criterion has no '
    + 'field/operator/value keys at all, and a mechanical criterion has no question key. The stored rubric keeps '
    + 'the honest shape (an absent key means "not applicable"), and a null placeholder is rejected by the reader.',
  '- Mechanical criterion: field + operator + value together, or none of the three.',
  '  * numeric fields (operator GTE | LTE, integer value): timeline.covered_months_closed, '
    + 'work_experience.entry_count, education.entry_count',
  '  * boolean fields (operator EXISTS, value MUST be true): work_experience, education',
  '  * "3 years of experience" => field=timeline.covered_months_closed, operator=GTE, value=36 '
    + '(unit = MONTHS, integer: 3 x 12).',
  '- Judgment criterion (NO field/operator/value keys): question is mandatory, 1..500 characters, one '
    + 'answerable yes/no question.',
  '- FORBIDDEN as field: name, phone, email, protected.* (age / gender / marital status / native place / photo) '
    + 'and any field not listed above.',
  '',
  'DEGREES, INDUSTRY, SOFT SKILLS ARE NOT MECHANICAL',
  'There is no degree / major / industry field. Express them as a judgment criterion with question, e.g.',
  '  {"key":"bachelor_or_above","label":"本科及以上学历","kind":"MUST_HAVE","weight":0.5,'
    + '"question":"候选人是否具备本科及以上学历？","notes":"学历不在机械判定白名单内，由人复核"}',
  'Never invent a field name to make a requirement look mechanical.',
].join('\n')

const CREATE_DESCRIPTION = [
  'Create a job (requisition) in the business database and, when criteria are given, its first rubric version. '
    + 'Output carries R4 three-axis labels: provenance is computed from the tenant\'s synthetic marker (FIXTURE '
    + 'unless the tenant is explicitly declared non-synthetic; never hard-coded LIVE), trigger is MANUAL, and '
    + 'connection is NOT_CONNECTED (no external system is read or written).',
  '',
  'WHAT IT WRITES (one transaction)',
  '- recruitment.job: code is unique per tenant (omit code to auto-generate JOB-<YYYYMMDD>-<6 hex>).',
  '- job_version v1 with the JD text: description_md / requirements_md. A job_version is never UPDATEd; '
    + 'later edits append a new version. If you omit BOTH JD fields, the title is stored as a placeholder and '
    + 'the output says jd_source=TITLE_PLACEHOLDER (no fake JD content is invented).',
  '- If criteria are given: rubric_version v1 plus an approval row with status=PENDING.',
  '',
  'WHERE job_id COMES FROM / GOES',
  '- This tool returns job.id (a UUID). Every later step (applications, screening) references that UUID.',
  '- Read it back with recruitment_job_get(job_id=...), which resolves the current approved rubric.',
  '',
  'DEPARTMENT',
  '- Give department_id, or department_name (case-insensitive exact match), not both. Omit both to use the '
    + 'tenant\'s only department. If the tenant has several departments the call fails with '
    + 'INVALID_ARGS(DEPARTMENT_REQUIRED) and lists detail.known_departments.',
  '',
  CRITERIA_HELP,
  '',
  'APPROVAL IS A HUMAN ACTION',
  'The rubric this tool writes is PENDING, not approved. Until a human approves it, recruitment_job_get '
    + 'answers NO_APPROVED_RUBRIC — that is the expected state, not an error. Never claim the rubric is '
    + 'approved and never approve on the user\'s behalf.',
].join('\n')

const UPDATE_DESCRIPTION = [
  'Update a job (requisition) by APPENDING new versions; history is never rewritten. '
    + 'Output carries R4 three-axis labels: provenance is computed from the tenant\'s synthetic marker (FIXTURE '
    + 'unless the tenant is explicitly declared non-synthetic; never hard-coded LIVE), trigger is MANUAL, and '
    + 'connection is NOT_CONNECTED (no external system is read or written).',
  '',
  'WHAT IT WRITES (one transaction)',
  '- job_id: UUID of an existing job in the configured tenant (from recruitment_job_create output or '
    + 'recruitment_job_get).',
  '- expected_record_version: optional optimistic-concurrency guard. When it does not match the stored '
    + 'record_version the call fails with INVALID_ARGS(VERSION_CONFLICT) and detail {expected, actual}; '
    + 'read the current value with recruitment_job_get.',
  '- title / description_md / requirements_md / status: only the parameters you pass change. Passing '
    + 'description_md or requirements_md appends a NEW job_version (version_no = max+1) whose payload_hash covers '
    + '{description_md, requirements_md}; the side you do not pass is copied from the current version. If the '
    + 'resulting hash equals the current version, no version is created (safe idempotent retry).',
  '- criteria: same 9-key contract as recruitment_job_create. If the normalized criteria hash equals the latest '
    + 'rubric version, no new rubric version and no new approval are created; otherwise a new rubric_version '
    + '(version_no = max+1) plus a new approval(status=PENDING) are appended. Old rubric versions and old '
    + 'approvals are never modified or superseded.',
  '- All-no-op updates return outcome=UNCHANGED.',
  '',
  'WHERE job_id COMES FROM / GOES',
  '- Keep the job.id this call returns; read the job back with recruitment_job_get(job_id=...).',
  '',
  CRITERIA_HELP,
  '',
  'APPROVAL IS A HUMAN ACTION',
  'A newly appended rubric version is PENDING, not approved. Until a human approves it, '
    + 'recruitment_job_get answers NO_APPROVED_RUBRIC — that is the expected state, not an error. Never '
    + 'claim the rubric is approved and never approve on the user\'s behalf.',
].join('\n')

// ---------------------------------------------------------------------------
//  render（给人看的混排文本）
// ---------------------------------------------------------------------------

/**
 * 一条 criterion 的展示行。
 * @param raw - 归一化 criterion。
 */
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
 * 渲染模型可见文本（SPEC §6：至少含 code/title/status、job_id、版本号、rubric 概览、
 * `approval PENDING → 需人类批准`、`next: recruitment_job_get(job_id=…)`）。
 * 签名必须是 `(args, value)`：DSH 运行时按两参调用 `output.render`，只写一个参数会把
 * `args` 当规范值渲染（真实事故：单测 `render()` 读到 `v.outcome === undefined` 直接抛）。
 * @param _args - 本次调用的入口（本工具渲染不依赖它）。
 * @param value - 本工具的规范输出值。
 */
function renderJobWrite(_args: unknown, value: unknown): readonly TextBlock[] {
  const v = value as JobWriteValue
  const labels = v.labels === undefined
    ? 'LABELS_MISSING'
    : `${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`
  const lines: string[] = [
    `${v.outcome.toLowerCase()} job ${v.job.code} ${v.job.title} [${v.job.status}]  (labels: ${labels})`,
    `  job_id=${v.job.id}  record_version=${v.job.record_version}  `
      + `department=${v.department.name} (${v.department.id})`,
  ]
  if (v.job_version === null) {
    lines.push('  job_version: none')
  } else {
    lines.push(
      `  job_version v${v.job_version.version_no}  hash=${v.job_version.payload_hash.slice(0, 8)}…  `
      + `jd_source=${v.job_version.jd_source}  `
      + `description_md=${v.job_version.description_md === null ? 'null' : `${v.job_version.description_md.length} chars`}  `
      + `requirements_md=${v.job_version.requirements_md === null ? 'null' : `${v.job_version.requirements_md.length} chars`}`,
    )
  }
  if (v.rubric === null) {
    lines.push('  rubric: none (this call did not write a rubric)')
  } else {
    lines.push(
      `  rubric v${v.rubric.version_no}  version_id=${v.rubric.version_id}  `
      + `(${v.rubric.criteria_count} criteria: ${v.rubric.must_have_count} must / `
      + `${v.rubric.nice_to_have_count} nice / ${v.rubric.disqualifier_count} disqualifier, `
      + `is_approved=${String(v.rubric.is_approved)})`,
    )
    for (const criterion of v.rubric.criteria) lines.push(criterionLine(criterion))
    const approval = v.rubric.approval
    if (approval === null) {
      lines.push('  approval: none (this rubric version has no approval row; treat it as NOT approved)')
    } else {
      lines.push(
        `  approval ${approval.approval_id} ${approval.status}`
        + (approval.status === 'PENDING' ? ' → 需人类批准（PENDING；批准不是模型的动作）' : ''),
      )
    }
  }
  lines.push(`next: recruitment_job_get(job_id=${v.job.id})`)
  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------
//  工具定义
// ---------------------------------------------------------------------------

/**
 * 未配置替身：工具照常注册，调用时报 NOT_CONFIGURED 并列出缺什么。
 * 这比让工具消失更好——模型能看到"为什么写不了"，而不是以为工具不存在。
 * @param issues - `resolveDatabaseConfig` 给出的缺陷清单。
 */
export function unconfiguredJobCreateTool(issues: readonly string[]): ReadonlyToolDefinition {
  return unconfiguredWriteTool(JOB_CREATE_TOOL, CREATE_DESCRIPTION, CREATE_SCALAR_PARAMS, issues)
}

/**
 * 未配置替身（update）。
 * @param issues - `resolveDatabaseConfig` 给出的缺陷清单。
 */
export function unconfiguredJobUpdateTool(issues: readonly string[]): ReadonlyToolDefinition {
  return unconfiguredWriteTool(JOB_UPDATE_TOOL, UPDATE_DESCRIPTION, UPDATE_SCALAR_PARAMS, issues)
}

/**
 * 造未配置替身（两个工具同形）。
 * @param name - 工具名。
 * @param description - 正常工具的说明（保持模型可见的能力描述不变）。
 * @param specs - 标量参数表。
 * @param issues - 缺陷清单。
 */
function unconfiguredWriteTool(
  name: string,
  description: string,
  specs: ParamMap,
  issues: readonly string[],
): ReadonlyToolDefinition {
  return {
    name,
    description: `${description}\n\nCurrently NOT CONFIGURED: the plugin config is missing database settings `
      + '(or the database password environment variable). Calls return NOT_CONFIGURED.',
    parameters: writeParameterSchema(specs),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${name} is not configured: ${issues.join('; ')}` }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(): Promise<unknown> {
      throw contractError('NOT_CONFIGURED', {
        reason_code: 'PLUGIN_NOT_CONFIGURED',
        message: '数据库配置不完整，岗位写入不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}

/**
 * 造真实的岗位创建工具。
 * @param database - 已解析的库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param deps - 可选依赖：`identity` 由 `src/index.ts` 装配（产品路径）；缺省 = 测试兼容。
 */
export function createJobCreateTool(
  database: ResolvedDatabaseConfig,
  deps: ToolActorDeps = {},
): ReadonlyToolDefinition {
  return {
    name: JOB_CREATE_TOOL,
    description: CREATE_DESCRIPTION,
    parameters: writeParameterSchema(CREATE_SCALAR_PARAMS),
    output: { schema: OUTPUT_SCHEMA, render: renderJobWrite },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // 写身份先于建连解析：identity 已装配时缺失映射在此 fail-closed（零写入）。
      const writeActor = resolveWriteActor(exec, deps.identity, database.actor_id)
      // GUC 与 created_by / requested_by 列共用同一作者（Demo Actor 解析结果）。
      const writeConfig: ResolvedDatabaseConfig = { ...database, actor_id: writeActor.actor_id }
      // 先做契约层校验（不连库就失败），再把原始入参交给事务核心（核心会再校验一次，
      // 保证集成测试直调 in-transaction 函数时行为一致）。
      prepareCreateArgs(rawArgs)
      const pool = createPool(database)
      try {
        return await withActor(
          pool,
          writeActor.actor_id,
          async (client) => createJobInTransaction(client, writeConfig, rawArgs as Record<string, unknown>),
        )
      } catch (error) {
        throw mapDatabaseError(error)
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 造真实的岗位更新工具。
 * @param database - 已解析的库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param deps - 可选依赖：`identity` 由 `src/index.ts` 装配（产品路径）；缺省 = 测试兼容。
 */
export function createJobUpdateTool(
  database: ResolvedDatabaseConfig,
  deps: ToolActorDeps = {},
): ReadonlyToolDefinition {
  return {
    name: JOB_UPDATE_TOOL,
    description: UPDATE_DESCRIPTION,
    parameters: writeParameterSchema(UPDATE_SCALAR_PARAMS),
    output: { schema: OUTPUT_SCHEMA, render: renderJobWrite },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // 写身份先于建连解析：identity 已装配时缺失映射在此 fail-closed（零写入）。
      const writeActor = resolveWriteActor(exec, deps.identity, database.actor_id)
      // GUC 与 created_by / requested_by 列共用同一作者（Demo Actor 解析结果）。
      const writeConfig: ResolvedDatabaseConfig = { ...database, actor_id: writeActor.actor_id }
      prepareUpdateArgs(rawArgs)
      const pool = createPool(database)
      try {
        return await withActor(
          pool,
          writeActor.actor_id,
          async (client) => updateJobInTransaction(client, writeConfig, rawArgs as Record<string, unknown>),
        )
      } catch (error) {
        throw mapDatabaseError(error)
      } finally {
        await closePool(pool)
      }
    },
  }
}
