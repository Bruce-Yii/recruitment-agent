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
  buildCurrentOverrides,
  createBusinessReadTools,
  summarizeRubricCriteria,
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

// ---------------------------------------------------------------------------
//  人工纠偏读投影（criteria_summary 的五个新键；ADD-only，旧键不动）
// ---------------------------------------------------------------------------

test('criteria_summary 的五个新键在 output schema 里恒在且 additionalProperties:false', () => {
  const applicationGet = createBusinessReadTools({ database: FAKE_CONFIG })[0]
  assert.ok(applicationGet)
  const root = applicationGet.output.schema as Record<string, unknown>
  const rootProps = root.properties as Record<string, Record<string, unknown>>
  const applications = rootProps.applications as Record<string, unknown>
  const applicationItems = applications.items as Record<string, unknown>
  const props = applicationItems.properties as Record<string, Record<string, unknown>>
  const rubric = props.rubric as Record<string, unknown>
  const rubricProps = rubric.properties as Record<string, Record<string, unknown>>
  const criteria = rubricProps.criteria_summary as Record<string, unknown>
  const items = criteria.items as Record<string, unknown>
  const itemProps = items.properties as Record<string, Record<string, unknown>>
  for (const key of ['ai_state', 'human_state', 'effective_state', 'override_note', 'overridden_at']) {
    assert.equal(itemProps[key]?.type, 'string', `${key} 必须是 type:string（DSH 不支持 null/type 数组）`)
    assert.ok((items.required as string[]).includes(key), `${key} 必须恒在（required）`)
  }
})

test('summarizeRubricCriteria：不传 overrides 时旧形状逐字不变（五个新键不出现）', () => {
  const summary = summarizeRubricCriteria([{ key: 'edu_match', label: '学历匹配', kind: 'MUST_HAVE', weight: 1 }])
  assert.deepEqual(summary.criteria_summary[0], {
    key: 'edu_match', label: '学历匹配', kind: 'MUST_HAVE', weight: 1,
  })
})

test('summarizeRubricCriteria：传 overrides 时合入五键，human 赢、note/time 来自当前行', () => {
  const overrides = buildCurrentOverrides([{
    id: 'o-1',
    tenant_id: 't',
    application_id: 'app-1',
    rubric_version_id: 'rv-1',
    criterion_key: 'edu_match',
    human_state: 'UNREADABLE',
    note: '材料里没写',
    actor_id: 'a-1',
    confirmation_method: 'IN_CHAT',
    confirmation_text_sha256: 'f'.repeat(64),
    superseded_by_override_id: null,
    record_version: 1,
    created_at: new Date('2026-01-02T03:04:05.000Z'),
    updated_at: new Date('2026-01-02T03:04:05.000Z'),
  }])
  const map = overrides.get('app-1')
  assert.ok(map)
  const summary = summarizeRubricCriteria(
    [{ key: 'edu_match' }, { key: 'no_override' }],
    8,
    map,
  )
  const withOverride = summary.criteria_summary[0] as Record<string, unknown>
  assert.equal(withOverride.ai_state, '', 'v1.0 没有 AI 逐条状态列，恒空串')
  assert.equal(withOverride.human_state, 'UNREADABLE')
  assert.equal(withOverride.effective_state, 'UNREADABLE', '人赢')
  assert.equal(withOverride.override_note, '材料里没写')
  assert.equal(withOverride.overridden_at, '2026-01-02T03:04:05.000Z')
  const without = summary.criteria_summary[1] as Record<string, unknown>
  assert.equal(without.human_state, '')
  assert.equal(without.effective_state, '')
  assert.equal(without.override_note, '')
  assert.equal(without.overridden_at, '')
})

test('buildCurrentOverrides：被取代的行不进 current；同键多条 current 取最新（确定性）', () => {
  const row = (id: string, created: string, superseded: string | null) => ({
    id,
    tenant_id: 't',
    application_id: 'app-1',
    rubric_version_id: 'rv-1',
    criterion_key: 'edu_match',
    human_state: 'PRESENT' as const,
    note: null,
    actor_id: 'a-1',
    confirmation_method: 'IN_CHAT',
    confirmation_text_sha256: 'f'.repeat(64),
    superseded_by_override_id: superseded,
    record_version: 1,
    created_at: new Date(created),
    updated_at: new Date(created),
  })
  const map = buildCurrentOverrides([
    row('old', '2026-01-01T00:00:00.000Z', 'new'),
    row('new', '2026-01-02T00:00:00.000Z', null),
    row('dup-early', '2026-01-03T00:00:00.000Z', null),
    row('dup-late', '2026-01-04T00:00:00.000Z', null),
  ]).get('app-1')
  assert.ok(map)
  assert.equal(map.get('edu_match')?.id, 'dup-late')
})
