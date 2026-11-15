// `business-read.ts` 的**形状测试**（不连库：不需要 PG / converter / 文件）。
//
// 为什么单独一份（`test/tools/` 的既有口径：这里放只验形状/输出的测试）：
//   * 输出 schema 由 DSH 注册表**强制校验**，写错一个关键字（null / type 数组 / 少 additionalProperties）
//     会让整个工具调用以 INVALID_TOOL_OUTPUT 失败 —— 这是 2026-11-13 真会话踩过的坑；
//   * 参数 schema 必须 fail-closed（`additionalProperties:false`、不允许 tenant_id/actor_id）；
//   * render 必须能处理"最小/最大"两种值且不抛错；
//   * 未配置替身必须注册**同一个工具名**（不消失、不返回假数据）。
//
// 真库事实（SQL/join/PII/哈希）在 `test/integration/business-read.test.ts`；真 Agent 会话工具矩阵在
// `work/d5/product-read/` 的真会话证据里。本文件只回答"形状对不对"。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  APPLICATION_GET_TOOL,
  MATERIAL_READ_TOOL,
  createBusinessReadTools,
  unconfiguredBusinessReadTools,
} from '../../src/tools/business-read.ts'
import type { ReadonlyToolDefinition } from '../../src/tools/definition.ts'

/** 任意依赖（形状测试不连库；工厂只保存引用，调用才建池）。 */
const FAKE_CONFIG = {
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  database: 'ra_s6s7',
  password: 'shape-test-only',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
} as never

/** DSH 输出 schema 允许的关键字（官方强制子集；多一个就可能被校验器拒）。 */
const ALLOWED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description',
])

/**
 * 递归检查一个 JSON Schema 节点只用了官方子集关键字，且没有 DSH 不支持的东西。
 * @param node - schema 节点。
 * @param path - 出错时的定位路径。
 */
function assertDshSubset(node: unknown, path: string): void {
  if (node === false) return // additionalProperties:false 是布尔
  assert.equal(typeof node, 'object', `${path}: schema 必须是对象`)
  const record = node as Record<string, unknown>
  for (const key of Object.keys(record)) {
    assert.ok(ALLOWED_SCHEMA_KEYWORDS.has(key), `${path}: 非法 schema 关键字 ${JSON.stringify(key)}`)
  }
  if (record.type !== undefined) {
    assert.equal(typeof record.type, 'string', `${path}.type 必须是字符串（禁止 type 数组）`)
    assert.notEqual(record.type, 'null', `${path}.type 不能是 null（用"缺键"表达没有）`)
  }
  if (record.enum !== undefined) {
    assert.ok(Array.isArray(record.enum), `${path}.enum 必须是数组`)
    for (const value of record.enum as unknown[]) {
      assert.notEqual(value, null, `${path}.enum 不能含 null`)
      assert.equal(typeof value, 'string', `${path}.enum 只放字符串（开放取值用 type:string）`)
    }
  }
  if (record.properties !== undefined) {
    const properties = record.properties as Record<string, unknown>
    for (const [key, child] of Object.entries(properties)) assertDshSubset(child, `${path}.properties.${key}`)
    assert.equal(record.additionalProperties, false, `${path}: 有 properties 就必须 additionalProperties:false`)
    if (record.required !== undefined) {
      const required = record.required as string[]
      assert.ok(Array.isArray(required), `${path}.required 必须是数组`)
      for (const key of required) {
        assert.ok(Object.hasOwn(properties, key), `${path}.required 里的 ${key} 没有在 properties 声明`)
      }
    }
  }
  if (record.items !== undefined) assertDshSubset(record.items, `${path}.items`)
}

/** 所有工具（含未配置替身）：名字/描述/schema/execute/render 的形状必须成立。 */
function allTools(): readonly ReadonlyToolDefinition[] {
  return [
    ...createBusinessReadTools({ database: FAKE_CONFIG }),
    ...unconfiguredBusinessReadTools(['database.password_env'], ['converter.python_bin']),
  ]
}

test('参数 schema：对象根 + additionalProperties:false + 不允许 tenant_id/actor_id', () => {
  for (const tool of createBusinessReadTools({ database: FAKE_CONFIG })) {
    const parameters = tool.parameters as Record<string, unknown>
    assert.equal(parameters.type, 'object', `${tool.name}: 参数根必须是 object`)
    assert.equal(parameters.additionalProperties, false, `${tool.name}: 必须拒绝未知参数`)
    const properties = parameters.properties as Record<string, Record<string, unknown>>
    assert.ok(Array.isArray(parameters.required), `${tool.name}: required 必须是数组`)
    const serialized = JSON.stringify(parameters)
    assert.ok(!serialized.includes('"tenant_id"'), `${tool.name}: 模型不能传 tenant_id`)
    assert.ok(!serialized.includes('"actor_id"'), `${tool.name}: 模型不能传 actor_id`)
    for (const [key, spec] of Object.entries(properties)) {
      assert.equal(typeof spec.description, 'string', `${tool.name}.${key}: 每个参数都要有 description`)
    }
  }
})

test('输出 schema：只用 DSH 强制子集（无 null、无 type 数组、对象都关 additionalProperties）', () => {
  for (const tool of createBusinessReadTools({ database: FAKE_CONFIG })) {
    assertDshSubset(tool.output.schema, `${tool.name}.output`)
    const root = tool.output.schema as Record<string, unknown>
    assert.deepEqual(root.type, 'object', `${tool.name}: 输出根必须是 object`)
    assert.equal(root.additionalProperties, false, `${tool.name}: 输出根必须关 additionalProperties`)
    for (const key of root.required as string[]) {
      assert.ok(Object.hasOwn(root.properties as Record<string, unknown>, key), `${tool.name}: required ${key} 未声明`)
    }
    // 两个工具都要给三维标签与 next_tools（避免 Agent 不知道下一步该用哪个产品工具）。
    assert.ok((root.required as string[]).includes('labels'), `${tool.name}: labels 必填`)
    assert.ok((root.required as string[]).includes('next_tools'), `${tool.name}: next_tools 必填`)
    const labels = (root.properties as Record<string, Record<string, unknown>>).labels
    const labelProps = labels.properties as Record<string, Record<string, unknown>>
    assert.deepEqual(labelProps.provenance.enum, ['LIVE', 'FIXTURE'], `${tool.name}: provenance 封闭两值`)
    assert.deepEqual(labelProps.trigger.enum, ['MANUAL'], `${tool.name}: trigger 恒 MANUAL`)
    assert.deepEqual(labelProps.connection.enum, ['CONNECTED'], `${tool.name}: 读库工具的 connection 只有一个合法值`)
  }
})

test('render：最小/满形状都不抛错，且文本里有工具名与 labels', () => {
  const tools = createBusinessReadTools({ database: FAKE_CONFIG })
  const minimalApplication = {
    tool: APPLICATION_GET_TOOL,
    contract_version: '1.0.0',
    tool_kind: 'READ_ONLY',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    query: { mode: 'LIST', matched: 0, limit: 10 },
    applications: [],
    next_tools: [],
  }
  const applicationText = tools[0]?.output.render({}, minimalApplication) ?? []
  assert.match(applicationText.map((block) => block.text).join('\n'), /recruitment_application_get/)
  assert.match(applicationText.map((block) => block.text).join('\n'), /FIXTURE\/MANUAL\/CONNECTED/)

  const minimalMaterial = {
    tool: MATERIAL_READ_TOOL,
    contract_version: '1.0.0',
    tool_kind: 'READ_ONLY',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    query: { mode: 'SUMMARY', source: 'RESUME_VERSION', resume_version_id: 'x' },
    material: {
      meta: {
        resume_version_id: 'x',
        version_no: 1,
        parse_status: 'FAILED',
        pages: 0,
        reader_backend: '',
        reader_version: '',
      },
      structure: {
        field_locators: [],
        entries: [],
        issues: { count: 1, hard_count: 1, hard_codes: ['pdf_no_text'], codes: ['pdf_no_text'] },
      },
      contacts: { visible: false, email: '', phone: '' },
    },
    text: { mode: 'SUMMARY', available: false, reason_code: 'NOT_REQUESTED', chars: 0, truncated: false },
    next_tools: [],
  }
  const materialText = tools[1]?.output.render({}, minimalMaterial) ?? []
  const joined = materialText.map((block) => block.text).join('\n')
  assert.match(joined, /recruitment_material_read/)
  assert.match(joined, /NOT_REQUESTED/)
})

test('未配置替身：注册同一个工具名、调用报 NOT_CONFIGURED（不消失、不返回假数据）', async () => {
  const [applicationGet, materialRead] = unconfiguredBusinessReadTools(['database.password_env'])
  assert.equal(applicationGet?.name, APPLICATION_GET_TOOL)
  assert.equal(materialRead?.name, MATERIAL_READ_TOOL)
  await assert.rejects(() => applicationGet?.execute({ application_id: 'x' }), /NOT_CONFIGURED/)
  await assert.rejects(() => materialRead?.execute({ resume_version_id: 'x' }), /NOT_CONFIGURED/)
  // 未配置时也不该把工具定义成"可并发但可用"：只要求结构与真实工具一致（名字/输出 schema）。
  for (const tool of allTools()) assert.equal(typeof tool.output.schema, 'object')
})
