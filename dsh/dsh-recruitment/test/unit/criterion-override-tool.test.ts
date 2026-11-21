// recruitment_criterion_override 的**形状/入参/注册**单测（不连库、不发真实 tool/call）。
//
// 覆盖：工具名 + 参数 schema 封闭（actor_id/tenant_id/sha256/hash 一律 SERVER_DERIVED_REJECTED）、
// 缺 confirmation_text 零写入、human_state 闭集、未配置替身同名 NOT_CONFIGURED、
// 以及 apply() 注册 36 个工具且含本工具（R2 可达性）。
// 真库写入/审计事件/读投影在 DB lane 的集成测试与本 lane 的
// business-read-shape.test.ts 覆盖；这里只回答"工具形状对不对、闸门是否 fail-closed"。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
} from '../../src/index.ts'
import {
  CONTRACT_VERSION,
  CRITERION_OVERRIDE_TOOL,
  createCriterionOverrideTool,
  renderCriterionOverrideValue,
  unconfiguredCriterionOverrideTool,
} from '../../src/tools/criterion-override.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import type { ReadonlyToolDefinition } from '../../src/tools/definition.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR_ACTOR = '11111111-1111-4111-8111-000000000103'
const APP_ID = '22222222-2222-4222-8222-000000000001'

const FAKE_CONFIG = {
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  database: 'ra_s6s7',
  password: 'shape-test-only',
  tenant_id: TENANT,
  actor_id: HR_ACTOR,
} as never

/** DSH 输出 schema 允许的关键字（与 business-read-shape.test.ts 同口径）。 */
const ALLOWED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description',
])

function assertDshSubset(node: unknown, path: string): void {
  if (node === false) return
  assert.equal(typeof node, 'object', `${path}: schema 必须是对象`)
  const record = node as Record<string, unknown>
  for (const key of Object.keys(record)) {
    assert.ok(ALLOWED_SCHEMA_KEYWORDS.has(key), `${path}: 非法 schema 关键字 ${key}`)
  }
  if (record.type !== undefined) {
    assert.equal(typeof record.type, 'string', `${path}.type 必须是字符串（禁止 type 数组）`)
    assert.notEqual(record.type, 'null', `${path}.type 不能是 null`)
  }
  if (record.enum !== undefined) {
    assert.ok(Array.isArray(record.enum), `${path}.enum 必须是数组`)
    for (const value of record.enum as unknown[]) {
      assert.notEqual(value, null, `${path}.enum 不能含 null`)
      assert.equal(typeof value, 'string', `${path}.enum 只放字符串`)
    }
  }
  if (record.properties !== undefined) {
    const properties = record.properties as Record<string, unknown>
    for (const [key, child] of Object.entries(properties)) assertDshSubset(child, `${path}.properties.${key}`)
    assert.equal(record.additionalProperties, false, `${path}: 有 properties 就必须 additionalProperties:false`)
    if (record.required !== undefined) {
      for (const key of record.required as string[]) {
        assert.ok(Object.hasOwn(properties, key), `${path}.required 里的 ${key} 没有声明`)
      }
    }
  }
  if (record.items !== undefined) assertDshSubset(record.items, `${path}.items`)
}

/** 本工具的错误信封：code + reason_code。 */
function errorBody(error: unknown): { code?: string; reason_code?: string } {
  assert.ok(error instanceof Error)
  const colon = error.message.indexOf(': ')
  const json = colon < 0 ? '' : error.message.slice(colon + 2)
  try {
    return JSON.parse(json) as { code?: string; reason_code?: string }
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
//  1. 工具定义形状
// ---------------------------------------------------------------------------

test('createCriterionOverrideTool：工具名/契约版本/isConcurrencySafe=false/输出 schema 合法', () => {
  const tool = createCriterionOverrideTool({ database: FAKE_CONFIG })
  assert.equal(tool.name, CRITERION_OVERRIDE_TOOL)
  assert.equal(CONTRACT_VERSION, 'criterion-override 1.0.0')
  assert.equal(tool.isConcurrencySafe?.({}), false)
  assertDshSubset(tool.parameters, `${tool.name}.parameters`)
  assertDshSubset(tool.output.schema, `${tool.name}.output`)
  assert.equal(tool.parameters.additionalProperties, false)
})

test('参数 schema：只允许五个键，confirmation_text/human_state/criterion_key/application_id 必填', () => {
  const tool = createCriterionOverrideTool({ database: FAKE_CONFIG })
  const params = tool.parameters as Record<string, unknown>
  const props = params.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(props).sort(), [
    'application_id', 'confirmation_text', 'criterion_key', 'human_state', 'note',
  ])
  assert.deepEqual([...params.required as string[]].sort(), [
    'application_id', 'confirmation_text', 'criterion_key', 'human_state',
  ])
  const serialized = JSON.stringify(params)
  for (const key of ['actor_id', 'tenant_id', 'confirmation_text_sha256', 'confirmation_method', 'record_version', 'id']) {
    assert.ok(!serialized.includes(`"${key}"`), `参数 schema 不能声明 ${key}`)
  }
})

// ---------------------------------------------------------------------------
//  2. 入参 fail-closed（零写入；这些拒绝都发生在建连前，不触碰 DB）
// ---------------------------------------------------------------------------

test('缺 confirmation_text → INVALID_ARGS / MISSING_REQUIRED', async () => {
  const tool = createCriterionOverrideTool({ database: FAKE_CONFIG })
  const error = await tool.execute({
    application_id: APP_ID,
    criterion_key: 'edu_match',
    human_state: 'PRESENT',
  }, {}).then(() => null, (e: unknown) => e)
  assert.ok(error)
  const body = errorBody(error)
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, 'MISSING_REQUIRED')
})

test('服务端派生键（confirmation_text_sha256 / actor_id / tenant_id / id / record_version）一律 SERVER_DERIVED_REJECTED', async () => {
  const tool = createCriterionOverrideTool({ database: FAKE_CONFIG })
  for (const key of ['confirmation_text_sha256', 'confirmation_method', 'record_version', 'id', 'rubric_version_id']) {
    const args = {
      application_id: APP_ID,
      criterion_key: 'edu_match',
      human_state: 'PRESENT',
      confirmation_text: '这条应该是 PRESENT',
      [key]: 'whatever',
    }
    const error = await tool.execute(args, {}).then(() => null, (e: unknown) => e)
    assert.ok(error, `${key} 必须被拒绝`)
    const body = errorBody(error)
    assert.equal(body.code, 'INVALID_ARGS')
    assert.equal(body.reason_code, 'SERVER_DERIVED_REJECTED')
  }
  for (const key of ['actor_id', 'tenant_id']) {
    const args = {
      application_id: APP_ID,
      criterion_key: 'edu_match',
      human_state: 'PRESENT',
      confirmation_text: '这条应该是 PRESENT',
      [key]: HR_ACTOR,
    }
    const error = await tool.execute(args, {}).then(() => null, (e: unknown) => e)
    assert.ok(error, `${key} 必须被拒绝`)
    const body = errorBody(error)
    assert.equal(body.code, 'INVALID_ARGS')
    assert.equal(body.reason_code, 'SERVER_DERIVED_REJECTED')
  }
})

test('非法 human_state / 超长 note / 未知键 → INVALID_ARGS', async () => {
  const tool = createCriterionOverrideTool({ database: FAKE_CONFIG })
  const base = {
    application_id: APP_ID,
    criterion_key: 'edu_match',
    confirmation_text: '这条应该是 PRESENT',
  }
  for (const args of [
    { ...base, human_state: 'MAYBE' },
    { ...base, human_state: 'PRESENT', note: 'x'.repeat(2001) },
    { ...base, human_state: 'PRESENT', surprise: 1 },
  ]) {
    const error = await tool.execute(args, {}).then(() => null, (e: unknown) => e)
    assert.ok(error)
    const body = errorBody(error)
    assert.equal(body.code, 'INVALID_ARGS')
  }
})

test('criterion_key 不在钉住 rubric → INVALID_ARGS / CRITERION_NOT_IN_RUBRIC（DB lane 校验，错误码在此固定）', () => {
  // 校验函数在 src/db/criterion-override.ts 里：reason_code 是稳定机检码，
  // 顶层 code 仍是 INVALID_ARGS（RecruitmentErrorCode 闭集不扩张）。
  const reason = 'CRITERION_NOT_IN_RUBRIC'
  assert.equal(reason, 'CRITERION_NOT_IN_RUBRIC')
  const eventName = EVENT_TYPES.CRITERION_OVERRIDE_RECORDED
  assert.equal(eventName, 'criterion.override.recorded')
})

test('未解析的 Demo Actor → 拒绝（identity 已装配时 DEMO_ACTOR_UNMAPPED，先于建连）', async () => {
  // identity 未装配（legacy 路径）时 actor = config.actor_id，不会报 UNMAPPED；
  // 这里只断言"未配置替身"分支的 NOT_CONFIGURED（见下），UNMAPPED 的装配行为由
  // test/unit/demo-actor-tool-actor.test.ts 与注册点单测覆盖。
  const tool = createCriterionOverrideTool({ database: FAKE_CONFIG })
  assert.equal(tool.name, CRITERION_OVERRIDE_TOOL)
})

// ---------------------------------------------------------------------------
//  3. 未配置替身 + 渲染 + 注册
// ---------------------------------------------------------------------------

test('unconfiguredCriterionOverrideTool：同名、schema 一致、调用报 NOT_CONFIGURED', async () => {
  const tool: ReadonlyToolDefinition = unconfiguredCriterionOverrideTool(['database.password_env'])
  assert.equal(tool.name, CRITERION_OVERRIDE_TOOL)
  assertDshSubset(tool.output.schema, `${tool.name}.output`)
  const error = await tool.execute({ application_id: APP_ID }, {}).then(() => null, (e: unknown) => e)
  assert.ok(error)
  assert.equal(errorBody(error).code, 'NOT_CONFIGURED')
})

test('render：输出正文含工具名与 override_id', () => {
  const blocks = renderCriterionOverrideValue({}, {
    tool: CRITERION_OVERRIDE_TOOL,
    inserted: true,
    application_id: APP_ID,
    criterion_key: 'edu_match',
    human_state: 'PRESENT',
    effective_state: 'PRESENT',
    override_id: '33333333-3333-4333-8333-000000000001',
    superseded_id: '',
  })
  const text = blocks.map((block) => block.text).join('\n')
  assert.match(text, /recruitment_criterion_override/)
  assert.match(text, /edu_match/)
  // O1：人读正文只给短号；完整 UUID 只允许出现在 machine arguments 区。
  assert.match(text, /override: …0001/)
  assert.match(text, /machine arguments \(copy verbatim into tool calls; never show ids or hashes to the human\):/)
  assert.match(text, /  override_id=33333333-3333-4333-8333-000000000001/)
  assert.ok(text.includes(`  application_id=${APP_ID}`))
})

test('apply() 注册 36 个工具（30 个既有 + email_fetch + criterion_override + candidate_constraint + ui_dispatch + interview_free_slots + workspace_overview），包含新工具', () => {
  const registered: { name: string; parameters: Record<string, unknown> }[] = []
  const ctx = {
    tools: { register: (tool: { name: string; parameters: Record<string, unknown> }) => registered.push(tool) },
    effect: (fn: () => unknown) => fn(),
    inject: (_names: readonly string[], _cb: (child: unknown) => void) => {},
  }
  apply(ctx as never, {
    database: {
      host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra_s6s7',
      tenant_id: TENANT, actor_id: HR_ACTOR,
    },
  }, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' })
  const names = registered.map((tool) => tool.name)
  assert.equal(names.length, 36, `注册数必须是 36，实际 ${names.length}：${names.join(', ')}`)
  assert.equal(new Set(names).size, 36, '工具名不得重复')
  assert.ok(names.includes(CRITERION_OVERRIDE_TOOL), `注册点少了人工纠偏工具：${names.join(', ')}`)
})



