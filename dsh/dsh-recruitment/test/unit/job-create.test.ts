// 岗位线（S3）写工具的**冻结接口**单测：不连库，只证明契约的形状层与纯函数。
//
// 守什么（SPEC §9.1）：
//   1. `parameters` 是封闭对象根、`title` 必填、`criteria` 是 object 数组，
//      且通过官方 `assertSupportedJsonSchema`；
//   2. `output.schema` 通过官方 `assertSupportedJsonSchema`，样例值通过官方
//      `validateJsonSchemaValue`（带 rubric / 不带 rubric 两份样例）；
//   3. `normalizeCriteria` 补齐**恰好 9 键**、缺省写 null、顺序保持、undefined→null；
//   4. R-VAL 负例走 `validateDimensions`（写侧在入库前必须调用它）：权重和 0.9、
//      `field='name'`、只有 NICE_TO_HAVE、未知键；
//   5. `mapDatabaseError` 保留 SQLSTATE / constraint，`uq_job_code` 映射为
//      `DUPLICATE_JOB_CODE`（消息里必须还能看到 `23505`）；
//   6. 未配置替身：调用报 `NOT_CONFIGURED`，schema 仍封闭；
//   7. `render()` 含 code / job_id / `PENDING` / `recruitment_job_get`。
//
// 为什么不用 `@deepseek-ai/dsh-tools` 的静态 import：本包解析不到它
// （CONTRACT.md §0 的实测 ERR_MODULE_NOT_FOUND）。`manual/harness.manual.mjs`
// 的做法是从 `$DSH_HOME/profiles/node_modules` 按 file URL 动态加载官方模块；
// 这里沿用同一做法，并在加载不到时退化成本文件内的同子集检查器（不静默 skip，
// 只是把"官方校验"换成"同一套规则的本地实现"）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  CONTRACT_VERSION,
  JOB_CREATE_TOOL,
  JOB_UPDATE_TOOL,
  createJobCreateTool,
  createJobUpdateTool,
  mapDatabaseError,
  normalizeCriteria,
  unconfiguredJobCreateTool,
  unconfiguredJobUpdateTool,
} from '../../src/tools/job-create.ts'
import { validateDimensions } from '../../src/tools/screening-evaluate.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR_ACTOR = '11111111-1111-4111-8111-000000000103'
const DEPARTMENT = '11111111-1111-4111-8111-000000000010'
const JOB_ID = '11111111-1111-4111-8111-000000000401'
const JOB_VERSION_ID = '11111111-1111-4111-8111-000000000402'
const RUBRIC_VERSION_ID = '11111111-1111-4111-8111-000000000404'
const APPROVAL_ID = '11111111-1111-4111-8111-000000000405'

const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  tenant_id: TENANT,
  actor_id: HR_ACTOR,
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' }).resolved as NonNullable<
  ReturnType<typeof resolveDatabaseConfig>['resolved']
>

/** criterion 的 9 个合法键（JR §6.1）；normalizeCriteria 必须补齐成恰好这些。 */
const CRITERION_KEYS = [
  'field', 'key', 'kind', 'label', 'notes', 'operator', 'question', 'value', 'weight',
] as const

/** 官方校验器的最小接口（`dsh-tools/lib/index.js` 的导出）。 */
interface OfficialSchemaTools {
  assertSupportedJsonSchema(schema: unknown): void
  validateJsonSchemaValue(schema: unknown, value: unknown, path?: string): string[]
}

/** DSH 安装位置：优先 `$DSH_HOME`，与 harness.manual.mjs 的默认值一致。 */
const DSH_HOME = process.env.DSH_HOME ?? 'D:\\12412\\dsh-home'
const OFFICIAL_TOOLS_PATH = join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')

let official: OfficialSchemaTools | undefined
try {
  official = (await import(pathToFileURL(OFFICIAL_TOOLS_PATH).href)) as unknown as OfficialSchemaTools
} catch {
  official = undefined
  console.warn(`[job-create.test] 官方 dsh-tools 未加载（${OFFICIAL_TOOLS_PATH}），改用本地同子集检查器`)
}

/** DSH 支持的约束关键字（json-schema.js 的 CONTRACT + annotations）。 */
const SUPPORTED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * 深扫 schema：子集外关键字 / type 数组 / type+oneOf 并存 / required 不在 properties。
 * @param schema - 待检查的原始 JSON Schema 节点。
 * @param path - 诊断路径。
 */
function schemaViolations(schema: unknown, path = 'schema'): string[] {
  const out: string[] = []
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${path} 不是对象`]
  }
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  const type = node.type
  if (Array.isArray(type)) out.push(`${path}.type 是数组（DSH 不支持 type 数组）`)
  else if (typeof type === 'string') {
    if (!TYPES.has(type)) out.push(`${path}.type=${type} 不是 JSON Schema 基础类型`)
  } else if (!hasOneOf) {
    out.push(`${path}.type 缺失`)
  }
  if (hasOneOf && Object.hasOwn(node, 'type')) out.push(`${path} 同时声明 type 与 oneOf`)
  if (hasOneOf) {
    const oneOf = node.oneOf
    if (!Array.isArray(oneOf) || oneOf.length < 2) out.push(`${path}.oneOf 必须是至少 2 个分支的数组`)
    else oneOf.forEach((branch, index) => out.push(...schemaViolations(branch, `${path}.oneOf[${index}]`)))
  }
  const properties = node.properties as Record<string, unknown> | undefined
  const required = node.required as string[] | undefined
  if (required !== undefined) {
    for (const key of required) {
      if (properties === undefined || !Object.hasOwn(properties, key)) {
        out.push(`${path}.required 里有未声明的键 ${key}`)
      }
    }
  }
  if (properties !== undefined) {
    for (const [key, child] of Object.entries(properties)) out.push(...schemaViolations(child, `${path}.${key}`))
  }
  if (node.items !== undefined) out.push(...schemaViolations(node.items, `${path}.items`))
  return out
}

/**
 * 深扫值：类型 / enum / const / required / additionalProperties:false / items / oneOf。
 * @param schema - schema 节点。
 * @param value - 待校验的值。
 * @param path - 诊断路径。
 */
function valueViolations(schema: unknown, value: unknown, path = 'value'): string[] {
  const node = schema as Record<string, unknown>
  if (Array.isArray(node.oneOf)) {
    const results = (node.oneOf as unknown[]).map((branch) => valueViolations(branch, value, path))
    const passing = results.filter((violations) => violations.length === 0).length
    if (passing === 1) return []
    if (passing > 1) return [`${path} 同时匹配 ${passing} 个 oneOf 分支`]
    return results.flat().slice(0, 2)
  }
  const type = node.type as string | undefined
  const typeOk = (): boolean => {
    switch (type) {
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
      case 'array': return Array.isArray(value)
      case 'string': return typeof value === 'string'
      case 'integer': return typeof value === 'number' && Number.isInteger(value)
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'boolean': return typeof value === 'boolean'
      case 'null': return value === null
      default: return true
    }
  }
  const out: string[] = []
  if (!typeOk()) return [`${path} 类型不符（期望 ${type}）`]
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) {
    out.push(`${path} 不在 enum 里：${JSON.stringify(value)}`)
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) out.push(`${path} 不等于 const`)
  if (type === 'array' && node.items !== undefined) {
    ;(value as unknown[]).forEach((item, index) => out.push(...valueViolations(node.items, item, `${path}[${index}]`)))
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>
    const properties = (node.properties ?? {}) as Record<string, unknown>
    for (const key of (node.required ?? []) as string[]) {
      if (!Object.hasOwn(record, key)) out.push(`${path}.${key} 缺失（required）`)
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) out.push(`${path}.${key} 是未声明的键`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) out.push(...valueViolations(properties[key], child, `${path}.${key}`))
    }
  }
  return out
}

/** 官方 + 本地双检（官方不可用时只跑本地同子集检查器）。 */
function assertSupported(schema: unknown, label: string): void {
  assert.deepEqual(schemaViolations(schema), [], `${label} 形状层违反：只用 DSH 支持子集`)
  if (official !== undefined) {
    assert.doesNotThrow(() => official?.assertSupportedJsonSchema(schema), `${label} 被官方 assertSupportedJsonSchema 拒绝`)
  }
}

/** 官方 + 本地双检样例值。 */
function assertValueValid(schema: unknown, value: unknown, label: string): void {
  assert.deepEqual(valueViolations(schema, value), [], `${label} 未通过本地同子集校验`)
  if (official !== undefined) {
    assert.deepEqual(official.validateJsonSchemaValue(schema, value, ''), [], `${label} 未通过官方 validateJsonSchemaValue`)
  }
}

/** 从契约错误里取回 JSON 体（`<CODE>: <compact-json>`）。 */
function errorBody(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof RecruitmentToolError, `应当是 RecruitmentToolError，实际 ${String(error)}`)
  const marker = error.message.indexOf(': ')
  assert.ok(marker > 0, `消息里没有 "<CODE>: " 前缀：${error.message}`)
  return JSON.parse(error.message.slice(marker + 2)) as Record<string, unknown>
}

/** 一条完整的 9 键 criterion（默认合法；覆盖字段造负例）。 */
function criterion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'work_exists',
    label: '有工作经历',
    kind: 'MUST_HAVE',
    weight: 1,
    field: 'work_experience',
    operator: 'EXISTS',
    value: true,
    question: null,
    notes: null,
    ...overrides,
  }
}

/** 规范化后的两条硬性标准（render / sample 值共用）。 */
const NORMALIZED_CRITERIA = [
  criterion({ key: 'work_exists', weight: 0.5 }),
  criterion({
    key: 'months_gte36', label: '至少 36 个月', weight: 0.5,
    field: 'timeline.covered_months_closed', operator: 'GTE', value: 36,
  }),
]

/** 一份与 SPEC §6 同形的输出样例（带 rubric）。 */
function sampleValue(withRubric = true): Record<string, unknown> {
  return {
    tool: JOB_CREATE_TOOL,
    contract_version: CONTRACT_VERSION,
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    outcome: 'CREATED',
    department: { id: DEPARTMENT, name: '研发部（演示）' },
    job: {
      id: JOB_ID,
      code: 'S3-TEST-001',
      title: '后端工程师（演示）',
      status: 'DRAFT',
      department_id: DEPARTMENT,
      requisition_id: null,
      current_job_version_id: JOB_VERSION_ID,
      record_version: 1,
      status_changed_at: '2026-11-13T02:00:00.000Z',
    },
    job_version: {
      id: JOB_VERSION_ID,
      version_no: 1,
      payload_hash: 'a'.repeat(64),
      description_md: '一条演示 JD',
      requirements_md: null,
      approved_by_approval_id: null,
      jd_source: 'PROVIDED',
    },
    rubric: withRubric
      ? {
        version_id: RUBRIC_VERSION_ID,
        version_no: 1,
        payload_hash: 'b'.repeat(64),
        criteria: NORMALIZED_CRITERIA,
        criteria_count: 2,
        must_have_count: 2,
        nice_to_have_count: 0,
        disqualifier_count: 0,
        is_approved: false,
        approval: {
          approval_id: APPROVAL_ID,
          status: 'PENDING',
          payload_schema_version: 1,
          canonical_payload_hash: 'b'.repeat(64),
          requested_by_actor_id: HR_ACTOR,
        },
      }
      : null,
    next_action: withRubric
      ? { kind: 'APPROVE_RUBRIC', job_id: JOB_ID, approval_id: APPROVAL_ID, verify_with: 'recruitment_job_get' }
      : { kind: 'READ_BACK', job_id: JOB_ID, approval_id: null, verify_with: 'recruitment_job_get' },
  }
}

const createTool = createJobCreateTool(DATABASE)
const updateTool = createJobUpdateTool(DATABASE)

test('导出常量与工具名符合冻结契约（SPEC §2）', () => {
  assert.equal(JOB_CREATE_TOOL, 'recruitment_job_create')
  assert.equal(JOB_UPDATE_TOOL, 'recruitment_job_update')
  assert.equal(CONTRACT_VERSION, '1.0.0')
  assert.equal(createTool.name, JOB_CREATE_TOOL)
  assert.equal(updateTool.name, JOB_UPDATE_TOOL)
  assert.equal(typeof createTool.execute, 'function')
  assert.equal(typeof createTool.output.render, 'function')
  assert.equal(typeof updateTool.execute, 'function')
})

test('parameters：对象根封闭、title 必填、criteria 是 object 数组、官方 assertSupportedJsonSchema 通过', () => {
  const parameters = createTool.parameters as Record<string, unknown>
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(parameters.required, ['title'])
  assertSupported(parameters, 'recruitment_job_create.parameters')

  const properties = parameters.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(properties.title.type, 'string')
  assert.equal(properties.criteria.type, 'array')
  assert.equal((properties.criteria.items as Record<string, unknown>).type, 'object')
  // 若 schema 把 criterion 的 9 个键画出来，必须**恰好**是这 9 个（R-VAL-2 的封闭集）；
  // SPEC §9.1 只强制 "array of object"，所以没画 properties 时不在这里判死。
  const itemProperties = (properties.criteria.items as Record<string, unknown>).properties as Record<string, unknown> | undefined
  if (itemProperties !== undefined) {
    assert.deepEqual(Object.keys(itemProperties).sort(), [...CRITERION_KEYS])
  }
  // status 是封闭枚举 DRAFT | OPEN（SPEC §3）
  assert.deepEqual((properties.status.enum as string[]).sort(), ['DRAFT', 'OPEN'])
})

test('update parameters：job_id 必填，其余可选；官方校验通过', () => {
  const parameters = updateTool.parameters as Record<string, unknown>
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(parameters.required, ['job_id'])
  assertSupported(parameters, 'recruitment_job_update.parameters')
  const properties = parameters.properties as Record<string, Record<string, unknown>>
  assert.equal(properties.job_id.type, 'string')
  assert.equal(properties.expected_record_version.type, 'integer')
  assert.equal(properties.criteria.type, 'array')
})

test('output.schema：官方 assertSupportedJsonSchema 通过，且 required 覆盖 SPEC §6 的键', () => {
  for (const tool of [createTool, updateTool]) {
    assertSupported(tool.output.schema, `${tool.name}.output.schema`)
  }
  const schema = createTool.output.schema as Record<string, unknown>
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  const required = schema.required as string[]
  for (const key of ['tool', 'contract_version', 'labels', 'outcome', 'department', 'job', 'job_version', 'rubric', 'next_action']) {
    assert.ok(required.includes(key), `output.schema 缺 required ${key}`)
  }
  const properties = schema.properties as Record<string, Record<string, unknown>>

  /** 可空对象用 oneOf 表达时，取其中的 object 分支。 */
  const objectNode = (node: Record<string, unknown>): Record<string, unknown> => {
    if (node.type === 'object') return node
    const branches = (node.oneOf ?? []) as Record<string, unknown>[]
    const objectBranch = branches.find((branch) => branch.type === 'object')
    assert.ok(objectBranch !== undefined, '找不到 object 分支')
    return objectBranch as Record<string, unknown>
  }

  const jobRequired = objectNode(properties.job).required as string[]
  for (const key of ['id', 'code', 'title', 'status', 'department_id', 'requisition_id',
    'current_job_version_id', 'record_version', 'status_changed_at']) {
    assert.ok(jobRequired.includes(key), `job 缺 required ${key}`)
  }
  const jobVersionRequired = objectNode(properties.job_version).required as string[]
  for (const key of ['id', 'version_no', 'payload_hash', 'jd_source']) {
    assert.ok(jobVersionRequired.includes(key), `job_version 缺 required ${key}`)
  }
  const rubricRequired = objectNode(properties.rubric).required as string[]
  for (const key of ['version_id', 'version_no', 'payload_hash', 'criteria', 'is_approved', 'approval']) {
    assert.ok(rubricRequired.includes(key), `rubric 缺 required ${key}`)
  }
  const approvalRequired = objectNode((objectNode(properties.rubric).properties as Record<string, Record<string, unknown>>).approval).required as string[]
  for (const key of ['approval_id', 'status', 'canonical_payload_hash']) {
    assert.ok(approvalRequired.includes(key), `approval 缺 required ${key}`)
  }
})

test('带 rubric 的输出样例值通过官方 validateJsonSchemaValue', () => {
  assertValueValid(createTool.output.schema, sampleValue(true), 'create 样例值（带 rubric）')
  assertValueValid(updateTool.output.schema, sampleValue(true), 'update 样例值（带 rubric）')
})

test('不带 rubric 的输出样例值（rubric=null）也通过官方校验', () => {
  assertValueValid(createTool.output.schema, sampleValue(false), 'create 样例值（rubric=null）')
})

test('output.schema 有牙：删掉 job.code 会被判违反（不是 additionalProperties:true 的兜底）', () => {
  const broken = sampleValue(false)
  delete (broken.job as Record<string, unknown>).code
  assert.ok(valueViolations(createTool.output.schema, broken).length > 0)
  if (official !== undefined) {
    assert.ok(official.validateJsonSchemaValue(createTool.output.schema, broken, '').length > 0)
  }
})

test('normalizeCriteria：补齐恰好 9 键、缺省 null、顺序保持', () => {
  const normalized = normalizeCriteria([
    { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
    { key: 'degree', label: '本科及以上', kind: 'NICE_TO_HAVE', weight: 0.5, question: '候选人是否具备本科及以上学历？' },
  ])
  assert.equal(normalized.length, 2)
  assert.deepEqual(Object.keys(normalized[0] as Record<string, unknown>).sort(), [...CRITERION_KEYS])
  assert.deepEqual(Object.keys(normalized[1] as Record<string, unknown>).sort(), [...CRITERION_KEYS])
  // 顺序保持
  assert.equal((normalized[0] as Record<string, unknown>).key, 'work_exists')
  assert.equal((normalized[1] as Record<string, unknown>).key, 'degree')
  // 缺省写 null，而不是 undefined / 丢键
  const second = normalized[1] as Record<string, unknown>
  assert.equal(second.field, null)
  assert.equal(second.operator, null)
  assert.equal(second.value, null)
  assert.equal(second.notes, null)
  assert.equal(Object.hasOwn(second, 'notes'), true)
  // 给出的值原样保留
  assert.equal((normalized[0] as Record<string, unknown>).weight, 0.5)
  assert.equal((normalized[0] as Record<string, unknown>).value, true)
})

test('normalizeCriteria：undefined → null；未知键不被规范化保留（由 validateDimensions 抓住）', () => {
  const normalized = normalizeCriteria([
    {
      key: 'a', label: 'A', kind: 'MUST_HAVE', weight: 1,
      field: 'work_experience', operator: 'EXISTS', value: true,
      question: undefined, notes: undefined, bogus: '不要静默吞掉',
    },
  ])
  const only = normalized[0] as Record<string, unknown>
  assert.equal(only.question, null)
  assert.equal(only.notes, null)
  assert.deepEqual(Object.keys(only).sort(), [...CRITERION_KEYS])
  // 写入前的 job-create 必须先 validateDimensions(raw)：多余键在这里报 CRITERION_UNKNOWN_KEY
  const violations = validateDimensions([{
    key: 'a', label: 'A', kind: 'MUST_HAVE', weight: 1,
    field: 'work_experience', operator: 'EXISTS', value: true, bogus: 'x',
  }])
  assert.ok(violations.some((violation) => violation.reason_code === 'CRITERION_UNKNOWN_KEY'))
})

test('R-VAL 负例：权重和 0.9 → WEIGHT_SUM（两者都是合法数值，只有 Σ 不合法）', () => {
  const violations = validateDimensions([
    criterion({ key: 'a', weight: 0.5 }),
    criterion({ key: 'b', weight: 0.4, field: 'timeline.covered_months_closed', operator: 'GTE', value: 36 }),
  ])
  assert.ok(violations.some((violation) => violation.reason_code === 'WEIGHT_SUM'))
})

test('R-VAL 负例：field=name → PROTECTED_ATTRIBUTE_IN_CRITERIA（个资红线）', () => {
  const violations = validateDimensions([criterion({ field: 'name', operator: 'EXISTS', value: true })])
  assert.ok(violations.some((violation) => violation.reason_code === 'PROTECTED_ATTRIBUTE_IN_CRITERIA'))
})

test('R-VAL 负例：只有 NICE_TO_HAVE → NO_DECIDING_CRITERIA', () => {
  const violations = validateDimensions([
    criterion({
      key: 'degree', label: '本科及以上', kind: 'NICE_TO_HAVE', weight: 1,
      field: null, operator: null, value: null, question: '候选人是否具备本科及以上学历？',
    }),
  ])
  assert.ok(violations.some((violation) => violation.reason_code === 'NO_DECIDING_CRITERIA'))
})

test('R-VAL 负例：未知键 → CRITERION_UNKNOWN_KEY（规范化不能掩盖它）', () => {
  const violations = validateDimensions([criterion({ bogus: 1 })])
  assert.ok(violations.some((violation) => violation.reason_code === 'CRITERION_UNKNOWN_KEY'))
})

test('mapDatabaseError：23505/uq_job_code → DUPLICATE_JOB_CODE，消息保留 23505 与 constraint', () => {
  const error = mapDatabaseError({ code: '23505', constraint: 'uq_job_code', table: 'job' })
  assert.ok(error instanceof RecruitmentToolError)
  assert.equal(error.code, 'INVALID_ARGS')
  assert.match(error.message, /23505/)
  const body = errorBody(error)
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, 'DUPLICATE_JOB_CODE')
  const detail = body.detail as Record<string, unknown>
  assert.equal(detail.sqlstate, '23505')
  assert.equal(detail.constraint, 'uq_job_code')
})

test('mapDatabaseError：其它唯一/外键/检查约束仍保留 SQLSTATE 与 constraint', () => {
  const cases = [
    { code: '23505', constraint: 'uq_rubric_version', expected: 'UNIQUE_VIOLATION' },
    { code: '23503', constraint: 'fk_job_department', expected: 'FOREIGN_KEY_VIOLATION' },
    { code: '23514', constraint: 'ck_job_status', expected: 'CONSTRAINT_VIOLATION' },
  ]
  for (const item of cases) {
    const error = mapDatabaseError({ code: item.code, constraint: item.constraint })
    const body = errorBody(error)
    const detail = body.detail as Record<string, unknown>
    assert.equal(body.code, 'INVALID_ARGS', item.code)
    assert.equal(body.reason_code, item.expected, item.code)
    assert.equal(detail.sqlstate, item.code)
    assert.equal(detail.constraint, item.constraint)
    assert.match(error.message, new RegExp(item.code))
  }
})

test('未配置替身：调用报 NOT_CONFIGURED，schema 仍封闭且通过官方校验', async () => {
  const issues = ['config.database.host is required', 'environment variable RECRUITMENT_DB_PASSWORD is not set']
  const tools: readonly [ReturnType<typeof unconfiguredJobCreateTool>, string][] = [
    [unconfiguredJobCreateTool(issues), JOB_CREATE_TOOL],
    [unconfiguredJobUpdateTool(issues), JOB_UPDATE_TOOL],
  ]
  for (const [tool, expectedName] of tools) {
    assert.equal(tool.name, expectedName)
    const parameters = tool.parameters as Record<string, unknown>
    assert.equal(parameters.additionalProperties, false)
    assertSupported(parameters, `${tool.name}(unconfigured).parameters`)
    assertSupported(tool.output.schema, `${tool.name}(unconfigured).output.schema`)
    await assert.rejects(
      () => tool.execute({}, undefined),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_CONFIGURED')
        assert.equal(body.reason_code, 'PLUGIN_NOT_CONFIGURED')
        assert.deepEqual((body.detail as Record<string, unknown>).issues, issues)
        return true
      },
    )
  }
})

test('render()：含 code、job_id、PENDING 与下一步读回提示 recruitment_job_get', () => {
  for (const tool of [createTool, updateTool]) {
    const blocks = tool.output.render({}, sampleValue(true)) as readonly { type: string; text: string }[]
    assert.ok(Array.isArray(blocks) && blocks.length >= 1)
    const text = blocks.map((block) => block.text).join('\n')
    assert.match(text, /S3-TEST-001/, `${tool.name} render 缺 code`)
    assert.match(text, new RegExp(JOB_ID), `${tool.name} render 缺 job_id`)
    assert.match(text, /PENDING/, `${tool.name} render 缺 PENDING（人类批准提示）`)
    assert.match(text, /recruitment_job_get/, `${tool.name} render 缺下一步读回提示`)
  }
})
