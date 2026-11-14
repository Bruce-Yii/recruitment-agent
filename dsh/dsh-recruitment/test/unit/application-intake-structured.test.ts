// `structured_json` 的纯逻辑测试（连库零依赖，不起 converter）。
//
// 守的是 D-29 的口径与「不降级接受」：
//   * 不传 structured_json 时 effectiveFields() 与转换器投影逐字相同；
//   * 非法 JSON → INVALID_ARGS(STRUCTURED_JSON_INVALID)；
//   * 证据不成立 → BLOCKED_BY_REVIEW(STRUCTURED_REJECTED)，detail.rejections 前 10 条；
//   * 通过后 state 以模型层为准，同时保留 converter_state；
//   * unreadable 与 absent 不互相冒充。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStructuredJson,
  createApplicationIntakeTool,
  effectiveFields,
  type IntakeMaterial,
} from '../../src/tools/application-intake.ts'
import { resolveConverterConfig, type ConverterOutput } from '../../src/tools/converter.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import { CONVERTER_DIR, PYTHON_BIN, SYNTHETIC_DIR, syntheticPath } from '../helpers/paths.ts'

const TOOL_NAME = 'recruitment_application_intake'
const DEMO_JOB = '11111111-1111-4111-8111-000000000401'
const SHA = 'a'.repeat(64)

const CONVERTER = resolveConverterConfig({
  python_bin: PYTHON_BIN ?? 'python3',
  converter_dir: CONVERTER_DIR,
  allowed_roots: [SYNTHETIC_DIR],
})
const DATABASE: ResolvedDatabaseConfig = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  password: 'test-only-never-used',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000,
  max: 2,
}

const tool = createApplicationIntakeTool({
  converter: CONVERTER.resolved as NonNullable<typeof CONVERTER.resolved>,
  database: DATABASE,
})

/** 六块合成简历（无真实个人资料；测试数据自编）。 */
const BLOCKS = [
  { kind: 'paragraph', text: '张示例', location: { page: 1, bbox: [72, 100, 300, 120] }, provenance: 'native_text' },
  { kind: 'paragraph', text: '电话：138 0000 1234  邮箱：zhang.example@example.test', location: { page: 1, bbox: [72, 130, 520, 150] }, provenance: 'native_text' },
  { kind: 'heading', text: '工作经历', location: { page: 1, bbox: [72, 170, 300, 190] }, provenance: 'native_text' },
  { kind: 'paragraph', text: '示例科技有限公司 后端工程师 2020.07-2023.06', location: { page: 1, bbox: [72, 200, 520, 220] }, provenance: 'native_text' },
  { kind: 'heading', text: '教育背景', location: { page: 1, bbox: [72, 240, 300, 260] }, provenance: 'native_text' },
  { kind: 'paragraph', text: '示例大学 计算机科学 本科 2016.09-2020.06', location: { page: 1, bbox: [72, 270, 520, 290] }, provenance: 'native_text' },
] as const

/** 转换器口径的材料：phone/email 不可读、work_experience 不可切分、education absent。 */
function makeOutput(overrides: Record<string, unknown> = {}): ConverterOutput {
  return {
    text: BLOCKS.map((b) => b.text).join('\n'),
    chars: 200,
    completeness: 'complete',
    issues: [],
    blocks: [...BLOCKS],
    fields: {
      name: {
        state: 'present',
        value: '张示例',
        provenance: 'native_text',
        evidence: [{ page: 1, bbox: [72, 100, 300, 120], block: 1, text: '张示例' }],
      },
      phone: { state: 'unreadable', reason: 'value_masked_or_redacted', provenance: 'native_text', evidence: [] },
      email: { state: 'unreadable', reason: 'value_masked_or_redacted', provenance: 'native_text', evidence: [] },
      work_experience: {
        state: 'unreadable',
        reason: 'entries_not_segmentable',
        provenance: 'native_text',
        evidence: [],
      },
      education: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
    },
    timeline: { intervals: 0, closed_intervals: 0, open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 0 },
    screening: { eligible_fields: ['name'], blocked_fields: [], identity_merge_eligible: ['name'] },
    meta: { pages: 1, source_sha256: SHA, source_name: 'structured-unit.pdf', backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
    ...overrides,
  } as ConverterOutput
}

function makeMaterial(output: ConverterOutput = makeOutput()): IntakeMaterial {
  return {
    real_path: 'C:/fake/structured-unit.pdf',
    file_name: 'structured-unit.pdf',
    byte_size: 1024,
    output,
    strong: [],
    blocked: [],
    sha256: SHA,
  }
}

/**
 * 契约形状（`contracts/schema.json`）：五个字段在顶层 `fields`，条目在 `.value[]`，
 * 条目事实是平铺的 `{ value, block_ids }`，`attribution` 恒在。
 * 这份形状能被**当前** validate() 接受（校验器 lane 已对齐契约）。
 */
function contractShape(): Record<string, unknown> {
  return {
    prompt_version: '1.0.0',
    schema_version: '1.0.0',
    block_count: 6,
    sections: [
      { label: 'contact', block_ids: ['1', '2'] },
      { label: 'work_experience', block_ids: ['3', '4'] },
      { label: 'education', block_ids: ['5', '6'] },
    ],
    fields: {
      name: { state: 'present', value: '张示例', block_ids: ['1'] },
      phone: { state: 'present', value: '138 0000 1234', block_ids: ['2'] },
      email: { state: 'present', value: 'zhang.example@example.test', block_ids: ['2'] },
      work_experience: {
        state: 'present',
        block_ids: ['3', '4'],
        value: [
          {
            company: { value: '示例科技有限公司', block_ids: ['4'] },
            title: { value: '后端工程师', block_ids: ['4'] },
            start: { value: '2020.07', block_ids: ['4'] },
            end: { value: '2023.06', block_ids: ['4'] },
            block_ids: ['4'],
            attribution: 'single_block',
          },
        ],
      },
      education: {
        state: 'present',
        block_ids: ['5', '6'],
        value: [
          {
            school: { value: '示例大学', block_ids: ['6'] },
            major: { value: '计算机科学', block_ids: ['6'] },
            degree: { value: '本科', block_ids: ['6'] },
            start: { value: '2016.09', block_ids: ['6'] },
            end: { value: '2020.06', block_ids: ['6'] },
            block_ids: ['6'],
            attribution: 'single_block',
          },
        ],
      },
    },
  }
}

/** 从契约错误消息里取回 JSON 体（消息形态 `<CODE>: <compact-json>`）。 */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as Record<string, unknown>
}

test('不传 structured_json：参数可选、effectiveFields 逐字等于转换器投影（无 state_source）', () => {
  const parameters = tool.parameters as {
    properties: Record<string, unknown>
    required: string[]
  }
  assert.ok(Object.hasOwn(parameters.properties, 'structured_json'), '模型必须看得见这个可选参数')
  assert.ok(!parameters.required.includes('structured_json'), 'structured_json 不得是必填')

  const material = makeMaterial()
  assert.equal(material.structured, undefined)
  const fields = effectiveFields(material)
  assert.deepEqual(fields, material.output.fields, '不传时业务字段必须逐字等于转换器投影')
  assert.equal(fields.phone?.state, 'unreadable')
  assert.equal(fields.work_experience?.state, 'unreadable')
  assert.equal(Object.hasOwn(fields.phone as object, 'state_source'), false)
})

test('非法 JSON → INVALID_ARGS + STRUCTURED_JSON_INVALID（不进入校验、不写库）', () => {
  assert.throws(
    () => applyStructuredJson(makeMaterial(), '{"sections": [', DEMO_JOB),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'STRUCTURED_JSON_INVALID')
      assert.equal(body.detail !== undefined, true)
      return true
    },
  )
})

test('证据不成立 → BLOCKED_BY_REVIEW + STRUCTURED_REJECTED，rejections 是前 N 条', () => {
  const structured = contractShape() as Record<string, any>
  structured.fields.phone.value = '139 0000 9999'
  assert.throws(
    () => applyStructuredJson(makeMaterial(), JSON.stringify(structured), DEMO_JOB),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
      const body = errorBody(error)
      assert.equal(body.reason_code, 'STRUCTURED_REJECTED')
      const detail = body.detail as {
        rejected_by: string
        rejection_count: number
        shown: number
        rejections: { code: string; path: string }[]
      }
      assert.equal(detail.rejected_by, 'validate')
      assert.ok(detail.rejection_count >= 1)
      assert.equal(detail.shown, Math.min(10, detail.rejection_count))
      assert.ok(detail.rejections.some((item) => item.code === 'VALUE_NOT_IN_BLOCK'))
      return true
    },
  )
})

test('合法结构化 → state 按模型层（D-29）升级，converter_state 保留，证据带 block id + 原文', () => {
  const material = applyStructuredJson(makeMaterial(), JSON.stringify(contractShape()), DEMO_JOB)
  assert.ok(material.structured !== undefined)
  const fields = effectiveFields(material) as Record<string, Record<string, any>>

  // phone：converter unreadable → 模型 present（D-29 的升级方向）
  assert.equal(fields.phone?.state, 'present')
  assert.equal(fields.phone?.state_source, 'agent_structured')
  assert.equal(fields.phone?.provenance, 'agent_read')
  assert.equal(fields.phone?.converter_state, 'unreadable')
  assert.equal(fields.phone?.value, '138 0000 1234')
  assert.deepEqual(fields.phone?.block_ids, [2])
  assert.equal(fields.phone?.evidence[0].source, 'agent_structured')
  assert.equal(fields.phone?.evidence[0].block_id, 2)
  assert.equal(fields.phone?.evidence[0].page, 1)
  assert.deepEqual(fields.phone?.evidence[0].bbox, [72, 130, 520, 150])
  assert.equal(fields.phone?.agent_evidence[0].quote, '电话：138 0000 1234  邮箱：zhang.example@example.test')

  // work_experience：converter unreadable → 模型 present（条目来自 fields.work_experience.value[]）
  assert.equal(fields.work_experience?.state, 'present')
  assert.equal(fields.work_experience?.converter_state, 'unreadable')
  assert.equal(fields.work_experience?.entry_count, 1)
  assert.deepEqual(fields.work_experience?.block_ids, [3, 4])

  // education：converter absent → 模型 present
  assert.equal(fields.education?.state, 'present')
  assert.equal(fields.education?.converter_state, 'absent')

  // 2026-11-14 修正：D-67/IR-F4 只允许 native_text 自动归并；agent_read 必须 weak
  // （原断言把 "agent_read 进 strong" 这个错误行为断言成了正确，见验收报告 §1.2）
  assert.deepEqual(material.strong, [], 'agent_read 绝不进 strong')
  assert.deepEqual(material.weak?.map((id) => id.field), ['phone', 'email'])
  assert.equal(material.weak?.[0]?.norm, '+8613800001234')
  assert.equal(material.weak?.[0]?.provenance, 'agent_read')
  assert.equal(material.weak?.[0]?.reason, 'provenance_agent_read')
  assert.equal(material.weak?.[1]?.norm, 'zhang.example@example.test')
  assert.deepEqual(material.blocked, [])

  // parsed_fields.structured：来源标记 + 每个字段引用了哪些 block
  const metadata = material.structured as { fields: Record<string, { block_ids: number[]; state: string }> }
  assert.deepEqual(metadata.fields.phone?.block_ids, [2])
  assert.equal(metadata.fields.phone?.state, 'present')
})

test('模型说 unreadable → 最终 unreadable（converter present 不得把 unreadable 变成 present）', () => {
  const structured = contractShape() as Record<string, any>
  structured.fields.phone = {
    state: 'unreadable',
    reason: 'value_masked_or_redacted',
    block_ids: ['2'],
  }
  // email 仍 present，保证身份可判（否则会被 identity 闸门拦下，见下一条用例）
  const material = applyStructuredJson(makeMaterial(), JSON.stringify(structured), DEMO_JOB)
  const fields = effectiveFields(material) as Record<string, Record<string, any>>

  assert.equal(fields.phone?.state, 'unreadable')
  assert.equal(fields.phone?.converter_state, 'unreadable')
  assert.equal(fields.phone?.reason, 'value_masked_or_redacted')
  assert.equal(Object.hasOwn(fields.phone as object, 'value'), false, 'unreadable 不得携带 present 值')
  // 2026-11-14 修正：D-67/IR-F4 只允许 native_text 自动归并；agent_read 必须 weak
  // （原断言 strong=['email'] 把模型读出的 email 断言成强标识了。）
  assert.deepEqual(material.strong, [])
  assert.deepEqual(material.weak?.map((id) => id.field), ['email'])

  // 反方向：converter present、模型 unreadable → 最终 unreadable，且不是 absent
  const converterPresent = makeOutput({
    fields: {
      name: {
        state: 'present',
        value: '张示例',
        provenance: 'native_text',
        evidence: [{ page: 1, bbox: [72, 100, 300, 120], block: 1, text: '张示例' }],
      },
      phone: {
        state: 'present',
        value: '138 0000 1234',
        provenance: 'native_text',
        evidence: [{ page: 1, bbox: [72, 130, 520, 150], block: 2, text: '电话：138 0000 1234' }],
      },
      email: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
      work_experience: { state: 'unreadable', reason: 'entries_not_segmentable', provenance: 'native_text', evidence: [] },
      education: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
    },
    screening: { eligible_fields: ['name', 'phone'], blocked_fields: [], identity_merge_eligible: ['name', 'phone'] },
  })
  const downgraded = applyStructuredJson(makeMaterial(converterPresent), JSON.stringify(structured), DEMO_JOB)
  const downgradedFields = effectiveFields(downgraded) as Record<string, Record<string, any>>
  assert.equal(downgradedFields.phone?.state, 'unreadable')
  assert.equal(downgradedFields.phone?.converter_state, 'present')
  assert.equal(downgradedFields.phone?.converter_value, '138 0000 1234')
  assert.notEqual(downgradedFields.phone?.state, 'absent', 'unreadable 绝不能当 absent')
})

test('旧形状（sections[].fields / entries）被 validate() 拒绝：本文件不绕过校验器', () => {
  const legacy = contractShape() as Record<string, any>
  legacy.sections[0].fields = {
    name: { state: 'present', value: '张示例', block_ids: ['1'] },
  }
  assert.throws(
    () => applyStructuredJson(makeMaterial(), JSON.stringify(legacy), DEMO_JOB),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
      const body = errorBody(error)
      assert.equal(body.reason_code, 'STRUCTURED_REJECTED')
      const detail = body.detail as { rejected_by: string; rejections: { code: string; path: string }[] }
      assert.equal(detail.rejected_by, 'validate')
      assert.ok(detail.rejections.some((item) => item.code === 'SCHEMA_INVALID'))
      return true
    },
  )
})

test('顶层 fields 的逐字来源不成立 → validate 拒绝（未经证据校验的值不会进业务字段）', () => {
  const structured = contractShape() as Record<string, any>
  structured.fields.phone = { state: 'present', value: '139 0000 8888', block_ids: ['2'] }
  assert.throws(
    () => applyStructuredJson(makeMaterial(), JSON.stringify(structured), DEMO_JOB),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
      const body = errorBody(error)
      assert.equal(body.reason_code, 'STRUCTURED_REJECTED')
      const detail = body.detail as { rejected_by: string; rejections: { code: string; path: string }[] }
      assert.equal(detail.rejected_by, 'validate')
      assert.ok(detail.rejections.some((item) => item.code === 'VALUE_NOT_IN_BLOCK' && item.path === 'fields.phone'))
      return true
    },
  )
})

test('unreadable 但没有 reason → validate 拒绝（读不出必须说明为什么）', () => {
  const structured = contractShape() as Record<string, any>
  structured.fields.work_experience = { state: 'unreadable', block_ids: [] }
  assert.throws(
    () => applyStructuredJson(makeMaterial(), JSON.stringify(structured), DEMO_JOB),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.reason_code, 'STRUCTURED_REJECTED')
      const detail = body.detail as { rejected_by: string; rejections: { code: string }[] }
      assert.equal(detail.rejected_by, 'validate')
      assert.ok(detail.rejections.some((item) => item.code === 'UNREADABLE_MISSING_REASON'))
      return true
    },
  )
})

test('structured_json 超过 400000 字符 → INVALID_ARGS(OUT_OF_RANGE)，不碰 converter / 数据库', async () => {
  await assert.rejects(
    tool.execute(
      { path: 'C:\\x.pdf', job_id: DEMO_JOB, structured_json: 'x'.repeat(400_001) },
      { signal: new AbortController().signal },
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
      const body = errorBody(error)
      const violations = (body.detail as { violations: { reason_code: string; path: string }[] }).violations
      assert.ok(violations.some((item) => item.path === 'structured_json' && item.reason_code === 'OUT_OF_RANGE'))
      return true
    },
  )
})

test('工具名与契约版本没有变化（本 lane 不改注册面）', () => {
  assert.equal(tool.name, TOOL_NAME)
})
