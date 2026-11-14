// 企业自建配置的**纯校验与契约**单测（不连库）。
//
// 回答四个可机检的问题：
//   1. 五项服务端校验（权限范围 / code / name / UUID 列表 / 版本号）在**没有数据库**时
//      就已经拦住非法输入 —— 它们不依赖表的 CHECK 才生效（DB 只是第二道）；
//   2. 归一化是**集合语义**：权限范围去重 + 排序（否则幂等判定会因为数组顺序而撒谎）；
//   3. 三个工具的入参 schema 里**没有** tenant_id / actor_id（身份只能来自插件配置），
//      根节点 additionalProperties=false（未知字段一律拒绝）；
//   4. 三个工具的出参 schema 里 status 的枚举就是 CONFIG_STATUSES（没被悄悄放宽），
//      且 labels 三轴是必填。
//
// 与集成测试的分工：`test/integration/tenant-config.test.ts` 证明"能落库、能隔离、
// 能挡并发"；本文件证明"错的输入根本到不了数据库"。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PERMISSION_SCOPES,
  TEAM_ROLES,
  normalizeActorIds,
  normalizePermissionScopes,
  normalizeUuidList,
  optionalDescription,
  requireCode,
  requireRecordVersion,
  requireTeamRole,
  requireUuid,
} from '../../src/domain/tenant-config.ts'
import { CONFIG_STATUSES } from '../../src/tools/config-shared.ts'
import { createConfigRoleTool, unconfiguredConfigRoleTool } from '../../src/tools/config-role.ts'
import { createConfigTeamTool } from '../../src/tools/config-team.ts'
import { createConfigPipelineTool } from '../../src/tools/config-pipeline.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'

/** 只用于造工具定义（读 schema）；本文件不会执行任何工具。 */
const CFG = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  password: 'unused-in-this-test',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000,
  max: 2,
} as ResolvedDatabaseConfig

/** 从工具错误消息里取回 JSON 体（`<CODE>: <compact-json>`）。 */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as Record<string, unknown>
}

// =====================================================================
//  1. 权限范围（封闭集 + 集合语义）
// =====================================================================

test('权限范围：去重 + 字典序排序（集合语义，顺序不是信息）', () => {
  const normalized = normalizePermissionScopes(
    ['JOB_WRITE', 'APPLICATION_READ', 'JOB_WRITE', 'CONFIG_ADMIN'],
    { requireNonEmpty: true },
  )
  assert.deepEqual(normalized, ['APPLICATION_READ', 'CONFIG_ADMIN', 'JOB_WRITE'])
})

test('权限范围：集合外的值 → INVALID_ARGS（reason_code 可机检，附 allowed）', () => {
  assert.throws(
    () => normalizePermissionScopes(['JOB_READ', 'SUPERUSER'], { requireNonEmpty: true }),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'PERMISSION_SCOPE_UNKNOWN')
      assert.deepEqual((body.detail as { allowed: string[] }).allowed, [...PERMISSION_SCOPES])
      return true
    },
  )
})

test('权限范围：非数组 / 元素非字符串 → INVALID_ARGS', () => {
  assert.throws(
    () => normalizePermissionScopes('JOB_READ', { requireNonEmpty: true }),
    (error: unknown) => errorBody(error).reason_code === 'PERMISSION_SCOPES_NOT_ARRAY',
  )
  assert.throws(
    () => normalizePermissionScopes(['JOB_READ', 42], { requireNonEmpty: false }),
    (error: unknown) => errorBody(error).reason_code === 'PERMISSION_SCOPE_NOT_STRING',
  )
})

test('权限范围：新建必须 >=1；更新允许清空（它是企业的显式决定）', () => {
  assert.throws(
    () => normalizePermissionScopes([], { requireNonEmpty: true }),
    (error: unknown) => errorBody(error).reason_code === 'PERMISSION_SCOPES_EMPTY',
  )
  assert.deepEqual(normalizePermissionScopes([], { requireNonEmpty: false }), [])
})

// =====================================================================
//  2. code / name / UUID / 版本号 / team_role
// =====================================================================

test('code：形状与迁移里的 CHECK 同一条正则（大写、字母开头、2–41）', () => {
  assert.equal(requireCode('TEAM_APAC_RD'), 'TEAM_APAC_RD')
  for (const bad of ['team_apac', '1TEAM', 'T', 'TEAM-APAC', 'A'.repeat(42)]) {
    assert.throws(() => requireCode(bad), (error: unknown) => errorBody(error).code === 'INVALID_ARGS', bad)
  }
})

test('UUID / 版本号 / 成员角色：封闭集与下界都在服务端拒绝', () => {
  assert.equal(requireUuid('11111111-1111-4111-8111-000000000103', 'role_id'), '11111111-1111-4111-8111-000000000103')
  assert.throws(() => requireUuid('not-a-uuid', 'role_id'), (error: unknown) => errorBody(error).reason_code === 'ID_NOT_UUID')

  assert.equal(requireRecordVersion(3), 3)
  assert.throws(() => requireRecordVersion(0), (error: unknown) => errorBody(error).reason_code === 'EXPECTED_RECORD_VERSION_INVALID')
  assert.throws(() => requireRecordVersion(1.5), (error: unknown) => errorBody(error).reason_code === 'EXPECTED_RECORD_VERSION_INVALID')

  assert.equal(requireTeamRole(undefined, 'RECRUITER'), 'RECRUITER')
  assert.equal(requireTeamRole('APPROVER', 'RECRUITER'), 'APPROVER')
  assert.throws(
    () => requireTeamRole('OWNER', 'RECRUITER'),
    (error: unknown) => errorBody(error).reason_code === 'TEAM_ROLE_UNKNOWN',
  )
  assert.deepEqual([...TEAM_ROLES], ['HIRING_MANAGER', 'RECRUITER', 'COORDINATOR', 'INTERVIEWER', 'APPROVER'])
})

test('描述：不传 / null（清空）/ 文本三态；空白与超长被拒', () => {
  assert.equal(optionalDescription(undefined), undefined)
  assert.equal(optionalDescription(null), null)
  assert.equal(optionalDescription('  企业自建的流程说明  '), '企业自建的流程说明')
  assert.throws(() => optionalDescription('   '), (error: unknown) => errorBody(error).reason_code === 'DESCRIPTION_LENGTH')
  assert.throws(
    () => optionalDescription('x'.repeat(1001)),
    (error: unknown) => errorBody(error).reason_code === 'DESCRIPTION_LENGTH',
  )
})

test('UUID 列表：去重 + 排序；非 UUID 元素被拒（不靠模型自觉）', () => {
  const a = '11111111-1111-4111-8111-000000000101'
  const b = '11111111-1111-4111-8111-000000000102'
  assert.deepEqual(normalizeUuidList([b, a, b], 'member_actor_ids'), [a, b])
  assert.deepEqual(normalizeActorIds(undefined), [])
  assert.throws(
    () => normalizeActorIds(['11111111-1111-4111-8111-000000000101', 'abc']),
    (error: unknown) => errorBody(error).reason_code === 'UUID_LIST_ELEMENT_NOT_UUID',
  )
})

// =====================================================================
//  3. 入参 schema：身份键不许出现；根节点严格
// =====================================================================

test('三个工具的入参 schema：不含 tenant_id / actor_id，根节点 additionalProperties=false', () => {
  const tools = [
    createConfigRoleTool(CFG),
    createConfigTeamTool(CFG),
    createConfigPipelineTool(CFG),
    unconfiguredConfigRoleTool(['config.database.host is required']),
  ]
  for (const tool of tools) {
    const schema = tool.parameters as {
      type: string
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: boolean
    }
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false, '未知参数必须被拒')
    assert.equal(Object.hasOwn(schema.properties, 'tenant_id'), false, '租户不许由模型传入')
    assert.equal(Object.hasOwn(schema.properties, 'actor_id'), false, '执行身份不许由模型传入')
    assert.deepEqual(schema.required, ['operation'], '只有 operation 是全局必填；其余按动作在服务端校验')
    assert.equal(Object.hasOwn(schema.properties, 'operation'), true)
  }
})

// =====================================================================
//  4. 出参 schema：status 封闭集 + labels 三轴必填
// =====================================================================

test('出参 schema：status 枚举 = CONFIG_STATUSES，labels 三轴必填，operation 枚举封闭', () => {
  const cases: { tool: ReturnType<typeof createConfigRoleTool>; operations: string[] }[] = [
    { tool: createConfigRoleTool(CFG), operations: ['create', 'update', 'list', 'get'] },
    {
      tool: createConfigTeamTool(CFG),
      operations: ['create', 'update', 'add_member', 'remove_member', 'list', 'get'],
    },
    {
      tool: createConfigPipelineTool(CFG),
      operations: ['create', 'update', 'add_stage', 'add_stage_template', 'list', 'get'],
    },
  ]
  for (const { tool, operations } of cases) {
    const schema = tool.output.schema as {
      properties: Record<string, { enum?: string[]; required?: string[]; properties?: Record<string, unknown> }>
      required: string[]
    }
    assert.deepEqual(schema.properties.status?.enum, [...CONFIG_STATUSES])
    assert.deepEqual(schema.properties.operation?.enum, operations)
    assert.deepEqual(
      schema.properties.labels?.required,
      ['provenance', 'trigger', 'connection'],
      'R4：三维标签必须三轴齐备',
    )
    const labelsProps = schema.properties.labels?.properties ?? {}
    assert.deepEqual((labelsProps.provenance as { enum: string[] }).enum, ['LIVE', 'FIXTURE'], 'provenance 不许出现第四种取值')
    assert.deepEqual((labelsProps.trigger as { enum: string[] }).enum, ['MANUAL'])
    assert.deepEqual((labelsProps.connection as { enum: string[] }).enum, ['NOT_CONNECTED'])
    for (const key of ['tool', 'contract_version', 'operation', 'status', 'labels']) {
      assert.equal(schema.required.includes(key), true, `${tool.name} 出参必须包含 ${key}`)
    }
  }
})
