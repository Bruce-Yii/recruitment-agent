// 输出契约的形状层（TC §5.1 / §5.3 第 5、6 条）+ "输出里没有 null" 的回归闸门。
//
// 背景（真实事故，2026-11-13）：`recruitment_resume_read` 在 `absent` 时返回
// `value: null`，而 schema 写的是 `type: 'string'`，DSH 的校验器不支持 type 数组
// （`dsh-tools/lib/types/json-schema.js:245`），于是整次调用 INVALID_TOOL_OUTPUT。
// 68 条单测全绿也没抓到，因为它们从没校验过工具的输出值。
//
// 本文件做三件事，全部可机检：
//   1. schema 本身只用 DSH 支持的子集关键字，且**任何节点都没有 `type: 'null'`**；
//   2. 两个工具的输出值里**不存在 null**（深扫），missing 一律靠"省略键"；
//   3. `required` 里的键在真实值里都存在、且没有 schema 未声明的多余键
//      （等价于 additionalProperties:false 的本地检查）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createApplicationIntakeTool } from '../../src/tools/application-intake.ts'
import { createScreeningEvaluateTool } from '../../src/tools/screening-evaluate.ts'
import { resolveConverterConfig } from '../../src/tools/converter.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const CONVERTER = resolveConverterConfig({
  python_bin: 'D:\\Python3.12.9\\python.exe',
  converter_dir: 'D:\\12412\\dsh工作区\\projects\\recruitment-agent\\converter',
  allowed_roots: ['D:\\12412\\dsh工作区\\projects\\recruitment-agent\\converter\\corpus\\synthetic'],
})
const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' })

/** DSH 支持的约束关键字（`json-schema.js` 的 CONSTRAINT_KEYWORDS + annotations）。 */
const SUPPORTED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

/** 深扫 schema：返回所有违规（子集外关键字 / type 数组 / type:'null' / required 不在 properties）。 */
function schemaViolations(schema: unknown, path = 'schema'): string[] {
  const out: string[] = []
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${path} 不是对象`]
  }
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  const type = node.type
  if (Array.isArray(type)) out.push(`${path}.type 是数组（DSH 不支持 type 数组）`)
  else if (typeof type === 'string') {
    if (!TYPES.has(type)) out.push(`${path}.type=${type} 不是本工具使用的类型`)
  } else if (node.oneOf === undefined) {
    out.push(`${path}.type 缺失`)
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

/** 深扫值：返回所有为 null 的路径（数组下标用 [i]）。 */
function nullPaths(value: unknown, path = 'value'): string[] {
  if (value === null) return [path]
  if (Array.isArray(value)) return value.flatMap((item, index) => nullPaths(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => nullPaths(child, `${path}.${key}`))
  }
  return []
}

/**
 * 走一遍真实值对 schema 的校验（只用本文件用到的子集）：
 * 类型、enum、required、additionalProperties:false、数组 items。
 */
function valueViolations(schema: unknown, value: unknown, path = 'value'): string[] {
  const node = schema as Record<string, unknown>
  const out: string[] = []
  const type = node.type as string | undefined
  const typeOk = (): boolean => {
    switch (type) {
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
      case 'array': return Array.isArray(value)
      case 'string': return typeof value === 'string'
      case 'integer': return typeof value === 'number' && Number.isInteger(value)
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'boolean': return typeof value === 'boolean'
      default: return true
    }
  }
  if (!typeOk()) return [`${path} 类型不符（期望 ${type}）`]
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) {
    out.push(`${path} 不在 enum 里：${JSON.stringify(value)}`)
  }
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

const intake = createApplicationIntakeTool({
  converter: CONVERTER.resolved as NonNullable<typeof CONVERTER.resolved>,
  database: DATABASE.resolved as NonNullable<typeof DATABASE.resolved>,
})
const evaluate = createScreeningEvaluateTool(DATABASE.resolved as NonNullable<typeof DATABASE.resolved>)

test('两个新工具的 output.schema 只用 DSH 支持子集，且没有 type:null / type 数组', () => {
  for (const tool of [intake, evaluate]) {
    const violations = schemaViolations(tool.output.schema)
    assert.deepEqual(violations, [], `${tool.name}: ${violations.join('; ')}`)
  }
})

test('两个新工具的 parameters 是封闭对象根（additionalProperties:false）', () => {
  for (const tool of [intake, evaluate]) {
    const parameters = tool.parameters as Record<string, unknown>
    assert.equal(parameters.type, 'object')
    assert.equal(parameters.additionalProperties, false)
    assert.deepEqual(schemaViolations(parameters), [])
  }
})

test('S6/S7 的 consurrency 语义：evaluate 可并行，intake 不可', () => {
  assert.equal(evaluate.isConcurrencySafe?.({}), true)
  assert.equal(intake.isConcurrencySafe?.({}), false)
})

/** S7 的一份完整样例（真实跑库时返回的形状；这里造一份等价样本）。 */
function sampleEvaluateValue(): Record<string, unknown> {
  return {
    tool: 'recruitment_screening_evaluate',
    contract_version: '1.0.0',
    status: 'OK',
    advisory: true,
    read_only: true,
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    application: {
      id: '11111111-1111-4111-8111-000000000701',
      job_id: '11111111-1111-4111-8111-000000000401',
      candidate_id: '11111111-1111-4111-8111-000000000601',
      job_version_id: '11111111-1111-4111-8111-000000000402',
      lifecycle_status: 'ACTIVE',
      current_stage_code: 'S7',
      record_version: 3,
    },
    job: { id: '11111111-1111-4111-8111-000000000401', title: '后端工程师（演示）', status: 'OPEN' },
    resume_version: {
      id: '11111111-1111-4111-8111-000000000901',
      version_no: 1,
      parse_status: 'PARTIAL',
      source_asset_sha256: 'a'.repeat(64),
      content_sha256: 'b'.repeat(64),
      parser_name: 'pymupdf',
      parser_version: '1.0.0',
      page_count: 1,
      hard_issue_count: 0,
    },
    rubric: {
      version_id: '11111111-1111-4111-8111-000000000404',
      version_no: 2,
      payload_hash: 'c'.repeat(64),
      is_current: true,
      is_approved: true,
      resolution: 'JOB_CURRENT',
      what_if: false,
      rubric_pin_required: true,
      criteria_count: 3,
    },
    preconditions: {
      human_queue_checked: 7,
      human_queue_clear: true,
      material_bound: true,
      material_ready: true,
      rubric_approved: true,
    },
    verdict: 'NEEDS_REVIEW',
    verdict_summary: '2 条硬性条件：0 满足 / 0 反证 / 2 不确定；0 条排除条件命中 → 需人工复核',
    criteria_evaluated: true,
    required_human_action: 'ANSWER_JUDGMENT',
    reasons: [
      {
        code: 'MUST_HAVE_UNREADABLE',
        failure_class: 'UNREADABLE',
        criterion_key: 'work_exists',
        kind: 'MUST_HAVE',
        outcome: 'UNREADABLE',
        field: 'work_experience',
        tri_state: 'unreadable',
        bounds: 'UNAVAILABLE',
        expected: { operator: 'EXISTS', value_boolean: true },
        evidence: [],
        issue_codes: ['reading_order_unverified: page(s) 1'],
        message: '工作经历有原文但读不出',
      },
      {
        code: 'MUST_HAVE_SATISFIED',
        failure_class: 'HARD_PASS',
        criterion_key: 'years',
        kind: 'MUST_HAVE',
        outcome: 'SATISFIED',
        field: 'timeline.covered_months_closed',
        tri_state: 'present',
        bounds: 'LOWER_BOUND',
        expected: { operator: 'GTE', value_integer: 60, unit: 'MONTH' },
        observed: { lower_bound: 74 },
        evidence: [{
          resume_version_id: '11111111-1111-4111-8111-000000000901',
          source_asset_sha256: 'a'.repeat(64),
          page: 1,
          bbox: [72, 200, 523, 224],
          block: 3,
          quote: '示例原文',
          provenance: 'native_text',
        }],
        issue_codes: [],
        message: '闭区间下界已覆盖 74 个月',
      },
    ],
    bonus_signals: [
      {
        code: 'BONUS_NEEDS_JUDGMENT',
        failure_class: 'JUDGMENT',
        criterion_key: 'team_lead',
        kind: 'NICE_TO_HAVE',
        outcome: 'NEEDS_JUDGMENT',
        question: '是否有 ≥1 年、≥3 人的直接带团队经历？',
        evidence: [],
        issue_codes: [],
        message: '判断型',
      },
    ],
    warnings: [{ code: 'RUBRIC_PIN_REQUIRED', message: '写侧落 decision 前必须先钉版本' }],
    snapshot: {
      application_record_version: 3,
      resume_version_id: '11111111-1111-4111-8111-000000000901',
      resume_content_sha256: 'b'.repeat(64),
      rubric_version_id: '11111111-1111-4111-8111-000000000404',
      rubric_payload_hash: 'c'.repeat(64),
    },
    evaluation_digest: 'd'.repeat(64),
  }
}

test('S7 输出值：无 null、required 齐全、无未声明键', () => {
  const value = sampleEvaluateValue()
  assert.deepEqual(nullPaths(value), [])
  assert.deepEqual(valueViolations(evaluate.output.schema, value), [])
})

test('S7 的 prior_screening 是可省略键（decision 表没有 rubric_version_id 列）', () => {
  const value = sampleEvaluateValue()
  // 没有 prior_screening 也必须合法（不是 required）
  assert.deepEqual(valueViolations(evaluate.output.schema, value), [])
  const withPrior = {
    ...value,
    prior_screening: {
      decision_id: '11111111-1111-4111-8111-000000000a01',
      result: 'HOLD',
      decided_at: '2026-11-13T01:00:00.000Z',
    },
  }
  assert.deepEqual(valueViolations(evaluate.output.schema, withPrior), [])
})

test('contract 里画成 null 的字段：实现一律省略键（absence / observed / expected / tri_state）', () => {
  const value = sampleEvaluateValue()
  const reasons = value.reasons as Record<string, unknown>[]
  // 判断型没有 tri_state/field/expected，且**不得**用 null 占位
  const judgment = (value.bonus_signals as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(Object.hasOwn(judgment, 'tri_state'), false)
  assert.equal(Object.hasOwn(judgment, 'field'), false)
  assert.equal(Object.hasOwn(judgment, 'expected'), false)
  // 机械型 present 才有 observed 与 evidence
  const satisfied = reasons[1] as Record<string, unknown>
  assert.ok(Array.isArray(satisfied.evidence))
  assert.equal((satisfied.evidence as unknown[]).length, 1)
})

test('S6 输出 schema 也拒绝 null（样本值深扫）', () => {
  const sample = {
    tool: 'recruitment_application_intake',
    contract_version: '1.0.0',
    status: 'OK',
    created: true,
    candidate_created: true,
    idempotent_replay: false,
    candidate_id: '11111111-1111-4111-8111-000000000601',
    application_id: '11111111-1111-4111-8111-000000000701',
    matched_by: 'created',
    resume_id: '11111111-1111-4111-8111-000000000801',
    resume_version_id: '11111111-1111-4111-8111-000000000901',
    intake_record_id: '11111111-1111-4111-8111-000000000a01',
    intake_asset_id: '11111111-1111-4111-8111-000000000b01',
    event_id: '11111111-1111-4111-8111-000000000c01',
    provenance: 'FIXTURE',
    labels: {
      provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED',
      source_kind: 'LOCAL_FILE', event_provider: 'internal',
    },
    source: {
      file_name: 'x.pdf', sha256: 'a'.repeat(64), pages: 1, byte_size: 1024,
      completeness: 'complete', parse_status: 'PARSED', hard_issue_count: 0,
    },
    identity: {
      strong_ids: ['email', 'phone'],
      blocked_fields: [{ field: 'name', reason: 'field_state_absent' }],
      evidence: [{ field: 'phone', page: 1, bbox: [1, 2, 3, 4], block: 0 }],
    },
    job: { id: 'j', code: 'BE-001', title: 't', status: 'OPEN' },
    application: {
      job_id: 'j', job_version_id: 'jv', stage_code: 'S6',
      lifecycle_status: 'ACTIVE', record_version: 1,
    },
  }
  assert.deepEqual(nullPaths(sample), [])
  assert.deepEqual(valueViolations(intake.output.schema, sample), [])
})
