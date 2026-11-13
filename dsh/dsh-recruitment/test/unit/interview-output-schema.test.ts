// S8 两个工具的形状层回归闸门（与 `test/unit/output-schema.test.ts` 同一套判据）。
//
// 守三件事（都来自真实事故）：
//   1. `output.schema` / `parameters` 只用 DSH 支持的子集关键字，且**没有**
//      `type: 'null'` / `type` 数组（DSH 校验器不支持 type 数组，`null` 会让整次调用
//      `INVALID_TOOL_OUTPUT`；见 `test/unit/output-schema.test.ts` 的文件头）；
//   2. 参数根是封闭对象（`additionalProperties: false`，未声明键一律拒绝）；
//   3. 并发语义：`get` 只读可并行、`schedule` 是写不可并行。
//
// 本文件**不连库**：真实输出值里的 `null` 由两个集成测试的 `assertNoNull` 守。
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import {
  createInterviewScheduleTool,
  unconfiguredInterviewScheduleTool,
} from '../../src/tools/interview-schedule.ts'
import {
  createInterviewGetTool,
  unconfiguredInterviewGetTool,
} from '../../src/tools/interview-get.ts'

/** 配置只用于构造工具；本文件不连库，密码是占位值。 */
const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' }).resolved

if (DATABASE === null) throw new Error('测试配置解析失败')

/** DSH 支持的约束关键字（`json-schema.js` 的 CONSTRAINT_KEYWORDS + annotations）。 */
const SUPPORTED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

/**
 * 深扫 schema，返回所有违规。
 * @param schema - 待检查的 schema 节点。
 * @param path - 报错时用的路径前缀。
 * @returns 违规描述数组（空 = 合规）。
 */
function schemaViolations(schema: unknown, path = 'schema'): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${path} 不是对象`]
  }
  const node = schema as Record<string, unknown>
  const out: string[] = []
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  const type = node.type
  if (Array.isArray(type)) out.push(`${path}.type 是数组（DSH 不支持）`)
  else if (typeof type === 'string') {
    if (type === 'null') out.push(`${path}.type 是 'null'`)
    else if (!TYPES.has(type)) out.push(`${path}.type=${type} 不是本工具使用的类型`)
  } else if (node.oneOf === undefined) {
    out.push(`${path}.type 缺失且没有 oneOf`)
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
  for (const [key, child] of Object.entries(properties ?? {})) {
    out.push(...schemaViolations(child, `${path}.${key}`))
  }
  if (node.items !== undefined) out.push(...schemaViolations(node.items, `${path}.items`))
  for (const [index, child] of (Array.isArray(node.oneOf) ? node.oneOf : []).entries()) {
    out.push(...schemaViolations(child, `${path}.oneOf[${index}]`))
  }
  return out
}

const schedule = createInterviewScheduleTool(DATABASE)
const get = createInterviewGetTool(DATABASE)

test('S8 两个工具的 parameters / output.schema 只用 DSH 子集，且没有 type:null / type 数组', () => {
  for (const tool of [schedule, get]) {
    assert.deepEqual(schemaViolations(tool.parameters, 'parameters'), [], `${tool.name} parameters`)
    assert.deepEqual(schemaViolations(tool.output.schema, 'output'), [], `${tool.name} output`)
  }
})

test('S8 两个工具的参数根都是封闭对象（未声明键一律拒绝）', () => {
  for (const tool of [schedule, get]) {
    const parameters = tool.parameters as Record<string, unknown>
    assert.equal(parameters.type, 'object')
    assert.equal(parameters.additionalProperties, false)
    assert.ok(Array.isArray(parameters.required), `${tool.name} 必须有 required 数组`)
  }
})

test('S8 并发语义：get 只读可并行，schedule 是写不可并行', () => {
  assert.equal(get.isConcurrencySafe?.({}), true)
  assert.equal(schedule.isConcurrencySafe?.({}), false)
})

test('S8 未配置替身仍注册同名工具，且调用报 NOT_CONFIGURED（不静默降级）', async () => {
  for (const tool of [
    unconfiguredInterviewScheduleTool(['config.database.host is required']),
    unconfiguredInterviewGetTool(['config.database.host is required']),
  ]) {
    assert.equal(tool.name.startsWith('recruitment_interview_'), true)
    assert.equal((tool.parameters as Record<string, unknown>).additionalProperties, false)
    await assert.rejects(async () => tool.execute({}, {}), /NOT_CONFIGURED/)
  }
})
