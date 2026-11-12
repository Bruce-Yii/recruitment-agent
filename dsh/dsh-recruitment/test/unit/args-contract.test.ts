// 参数校验：旧格式（散文）不变 + 新格式（`Error: <CODE>: <json>`）逐条可机检。
//
// tool-contracts.md §1.1 的八条 + §5.1 的形状层检查都在这里落成断言：
//   * 未知键 → UNKNOWN_PARAM，消息里列出允许键
//   * tenant_id / actor_id → TENANT_OR_ACTOR_NOT_ALLOWED（不是静默忽略）
//   * job_0001 → ID_NOT_UUID
//   * 缺必填 → MISSING_REQUIRED；类型不符 → TYPE_MISMATCH；越界 → OUT_OF_RANGE
//   * 收集全部违反项（不是遇到第一条就返回）
//   * 消息体单行、可 JSON.parse、键序稳定
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectArgViolations,
  parseArgs,
  parseContractArgs,
  toParameterSchema,
  type ParamMap,
} from '../../src/tools/args.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'
import { canonicalJson, contractError } from '../../src/tools/contract.ts'

const UUID = '11111111-1111-4111-8111-000000000001'

const SPECS: ParamMap = {
  application_id: { kind: 'string', required: true, uuid: true, maxLength: 36, description: 'x' },
  resume_version_id: { kind: 'string', uuid: true, maxLength: 36, description: 'x' },
  max_blocks: { kind: 'integer', min: 1, max: 200, description: 'x' },
  include_contacts: { kind: 'boolean', description: 'x' },
  block_types: { kind: 'string[]', values: ['a', 'b'], description: 'x' },
}

/** 从契约错误里取回 JSON 体。 */
function bodyOf(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof RecruitmentToolError)
  const marker = error.message.indexOf(': ')
  const json = error.message.slice(marker + 2)
  assert.equal(json.includes('\n'), false, '消息体必须单行')
  return JSON.parse(json) as Record<string, unknown>
}

test('parseArgs 的散文消息逐字不变（stub 三工具的既有契约）', () => {
  assert.throws(
    () => parseArgs(SPECS, { application_id: UUID, bogus: 1 }),
    (error: unknown) => error instanceof RecruitmentToolError
      && error.message === 'INVALID_ARGS: unknown parameter "bogus" (allowed: application_id, resume_version_id, max_blocks, include_contacts, block_types)',
  )
  assert.throws(
    () => parseArgs(SPECS, { application_id: UUID, max_blocks: 'ten' }),
    (error: unknown) => error instanceof RecruitmentToolError
      && error.message === 'INVALID_ARGS: "max_blocks" must be an integer',
  )
  assert.throws(
    () => parseArgs(SPECS, {}),
    (error: unknown) => error instanceof RecruitmentToolError
      && error.message === 'INVALID_ARGS: missing required parameter "application_id"',
  )
  assert.throws(
    () => parseArgs(SPECS, []),
    (error: unknown) => error instanceof RecruitmentToolError
      && error.message === 'INVALID_ARGS: arguments must be a JSON object',
  )
})

test('parseContractArgs：未知键 → INVALID_ARGS/UNKNOWN_PARAM，detail 里列出 allowed 与 violations', () => {
  try {
    parseContractArgs(SPECS, { application_id: '11111111-1111-4111-8111-000000000001', bogus: 1 })
    assert.fail('应当抛错')
  } catch (error) {
    const body = bodyOf(error)
    assert.equal(body.code, 'INVALID_ARGS')
    assert.equal(body.reason_code, 'UNKNOWN_PARAM')
    assert.deepEqual((body.detail as { allowed: string[] }).allowed, Object.keys(SPECS))
    const violations = (body.detail as { violations: { reason_code: string; path: string }[] }).violations
    assert.equal(violations[0]?.reason_code, 'UNKNOWN_PARAM')
    assert.equal(violations[0]?.path, 'bogus')
  }
})

test('parseContractArgs：tenant_id / actor_id 单独分类（§0 第 4 条，不是普通未知键）', () => {
  for (const key of ['tenant_id', 'actor_id']) {
    try {
      parseContractArgs(SPECS, { application_id: '11111111-1111-4111-8111-000000000001', [key]: 'x' })
      assert.fail('应当抛错')
    } catch (error) {
      const body = bodyOf(error)
      assert.equal(body.reason_code, 'TENANT_OR_ACTOR_NOT_ALLOWED')
      assert.match(String(body.message), /参数不合法/)
    }
  }
})

test('parseContractArgs：非 UUID 的 id → ID_NOT_UUID（与 stub 的 job_0001 故意不兼容）', () => {
  try {
    parseContractArgs(SPECS, { application_id: 'job_0001' })
    assert.fail('应当抛错')
  } catch (error) {
    assert.equal(bodyOf(error).reason_code, 'ID_NOT_UUID')
  }
})

test('parseContractArgs：一次给出全部违反项（7 条规则的第 7 条）', () => {
  try {
    parseContractArgs(SPECS, {
      application_id: 'not-a-uuid',
      max_blocks: 999,
      include_contacts: 'true',
      block_types: ['a', 'zzz'],
    })
    assert.fail('应当抛错')
  } catch (error) {
    const violations = (bodyOf(error).detail as { violations: { reason_code: string; path: string }[] }).violations
    const paths = violations.map((v) => v.path)
    assert.deepEqual(paths, ['application_id', 'max_blocks', 'include_contacts', 'block_types[1]'])
    assert.deepEqual(violations.map((v) => v.reason_code), [
      'ID_NOT_UUID', 'OUT_OF_RANGE', 'TYPE_MISMATCH', 'OUT_OF_RANGE',
    ])
  }
})

test('collectArgViolations 不抛错，只返回分类后的违反项', () => {
  const { parsed, violations } = collectArgViolations(SPECS, { application_id: 42 })
  assert.equal(violations.length, 1)
  assert.deepEqual(violations.map((v) => v.reason), ['TYPE_MISMATCH'])
  assert.equal(parsed.max_blocks, undefined)
  // 缺必填单独可测
  const missing = collectArgViolations(SPECS, {})
  assert.deepEqual(missing.violations.map((v) => v.reason), ['MISSING_REQUIRED'])
})

test('toParameterSchema 显式 additionalProperties:false，且不含子集外关键字', () => {
  const schema = toParameterSchema(SPECS)
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['application_id'])
  const text = JSON.stringify(schema)
  for (const banned of ['minLength', 'pattern', 'minimum', 'format', 'oneOf']) {
    assert.equal(text.includes(banned), false, `${banned} 不在 DSH 支持子集内`)
  }
})

test('contractError：消息 = `<CODE>: <compact-json>`，键序字典序、单行', () => {
  const error = contractError('BLOCKED_BY_REVIEW', {
    reason_code: 'HUMAN_TASK_WAITING',
    message: 'x',
    detail: { blocking_items: [{ code: 'HUMAN_TASK_WAITING', family: 'HUMAN_QUEUE' }] },
  })
  assert.ok(error instanceof RecruitmentToolError)
  assert.ok(error.message.startsWith('BLOCKED_BY_REVIEW: '))
  const json = error.message.slice('BLOCKED_BY_REVIEW: '.length)
  assert.equal(json.includes('\n'), false)
  const parsed = JSON.parse(json) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed), ['code', 'detail', 'message', 'reason_code'])
  assert.equal(parsed.code, 'BLOCKED_BY_REVIEW')
  assert.equal(parsed.reason_code, 'HUMAN_TASK_WAITING')
  // 同一对象两次序列化必须逐字节相同（键序稳定）
  assert.equal(canonicalJson(parsed), json)
})

test('canonicalJson：键排序、无空白、数组保序、整数最简', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, 'x'], c: true }), '{"a":[2,"x"],"b":1,"c":true}')
  assert.equal(canonicalJson({ z: null }), '{"z":null}')
  assert.equal(canonicalJson({ w: 0.5 }), '{"w":0.5}')
  // undefined 键被丢弃（JSON 语义），不会变成 null
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
})
