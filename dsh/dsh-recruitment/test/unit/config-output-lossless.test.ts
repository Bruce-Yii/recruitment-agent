// `recruitment_config_*` 三个工具的输出契约回归门：**值必须是 lossless JSON**。
//
// 真实事故（2026-11-14，E1–E4 审计 F-1）：`recruitment_config_role` 在真实 DSH 会话里
// 能执行，但注册表拒收返回值：
//   Error: tool "recruitment_config_role" returned invalid output: value is not lossless JSON
//
// 根因：`pg` 对 `timestamptz` 的默认解析结果是 **`Date` 对象**（不是字符串）；
// 领域层行→视图映射（`toRoleView` / `toTeamView` / `toPipelineView`）原样把它放进了
// 出参，而 DSH 只接受"普通 JSON 数据"——非普通对象（Date / Map / Set / 类实例）、
// `undefined`、非有限数、循环引用一律拒收（`dsh-util-values` 的 `isJsonValue`）。
//
// 为什么旧测试没抓到：
//   1. 集成测试只断言了 `status` / `code` / 数组内容，没断言过"整个值能过 DSH"；
//   2. `JSON.stringify(Date)` 恰好会调用 `toJSON()` 吐出 ISO 字符串，所以只做
//      "序列化不报错"的检查是绿的——**必须是"往返后 deepEqual + lossless 谓词 +
//      output.schema"三件套**才抓得住"值本身不是 JSON 数据"这一类缺陷。
//
// 本文件不连库：用**假 DatabaseClient** 喂 pg 真实会产出的行形状（时间列 = Date），
// 走的是领域层真实的 list/get 映射函数（不是复制一份映射逻辑）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveDatabaseConfig, type DatabaseClient } from '../../src/db/pool.ts'
import {
  getPipeline,
  getRole,
  getTeam,
  listPipelines,
  listRoles,
  listTeams,
} from '../../src/domain/tenant-config.ts'
import { createConfigRoleTool } from '../../src/tools/config-role.ts'
import { createConfigTeamTool } from '../../src/tools/config-team.ts'
import { createConfigPipelineTool } from '../../src/tools/config-pipeline.ts'

// =====================================================================
//  lossless JSON 谓词（与 DSH 注册表同一套规则；测试内最小实现，不引依赖）
// =====================================================================

/**
 * 深扫"不是 lossless JSON"的值，返回违规路径（空数组 = 合规）。
 *
 * 判据与 `@deepseek-ai/dsh-util-values` 的 `isJsonValue` 等价（本工具用到的部分）：
 *   * 只允许 null / boolean / string / 有限 number（拒绝 NaN、±Infinity、-0）；
 *   * 数组必须是普通数组、无空洞、无额外自有键；
 *   * 对象必须原型为 `Object.prototype` 或 `null`（拒 Date / Map / Set / 类实例）；
 *   * 只允许可枚举字符串键（拒绝 symbol 键 / 不可枚举键）；
 *   * 拒绝循环引用与 `undefined`。
 * @param value - 待检查的值。
 * @param path - 报错路径。
 * @param ancestors - 当前递归栈上的对象（只用来判环）。
 * @returns 违规描述数组。
 */
function losslessViolations(value: unknown, path = 'value', ancestors = new Set<object>()): string[] {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return []
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return [`${path} 是非有限数（${String(value)}）`]
    if (Object.is(value, -0)) return [`${path} 是 -0（JSON 往返会变成 0）`]
    return []
  }
  if (typeof value !== 'object') return [`${path} 是 ${typeof value}（JSON 里没有这个类型）`]
  if (ancestors.has(value)) return [`${path} 是循环引用`]
  const prototype = Object.getPrototypeOf(value) as object | null
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return [`${path} 是数组子类（原型不是 Array.prototype）`]
    const out: string[] = []
    if (Reflect.ownKeys(value).length !== value.length + 1) out.push(`${path} 是稀疏数组或有额外自有键`)
    ancestors.add(value)
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) out.push(`${path}[${index}] 是空洞`)
      else out.push(...losslessViolations(value[index], `${path}[${index}]`, ancestors))
    }
    ancestors.delete(value)
    return out
  }
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (prototype as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
    return [`${path} 不是普通对象（${name} 实例；JSON 里没有这个类型）`]
  }
  const keys = Reflect.ownKeys(value)
  const illegal = keys.filter((key) => typeof key !== 'string'
    || !Object.prototype.propertyIsEnumerable.call(value, key))
  if (illegal.length > 0) return [`${path} 有非可枚举字符串键：${illegal.map(String).join(', ')}`]
  ancestors.add(value)
  const out = keys.flatMap((key) => losslessViolations(
    (value as Record<string, unknown>)[key as string], `${path}.${String(key)}`, ancestors,
  ))
  ancestors.delete(value)
  return out
}

/**
 * 断言一个工具输出值同时满足三件事：
 * 1. 是 lossless JSON（DSH 注册表的硬门槛）；
 * 2. `JSON.parse(JSON.stringify(x))` 能**无损往返**（deepEqual）；
 * 3. 通过该工具的 `output.schema`。
 * @param label - 断言失败时的定位信息。
 * @param schema - 工具出参 schema。
 * @param value - 工具出参值。
 */
function assertSerializableOutput(label: string, schema: unknown, value: unknown): void {
  assert.deepEqual(losslessViolations(value), [], `${label}: 不是 lossless JSON`)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: JSON 往返不是无损的`)
  assert.deepEqual(valueViolations(schema, value), [], `${label}: 不符合 output.schema`)
}

// =====================================================================
//  output.schema 的最小值校验（type / enum / required / additionalProperties / items）
// =====================================================================

/**
 * 按 output.schema 校验值（本仓出参只用到这些关键字；不引依赖）。
 * @param schema - schema 节点。
 * @param value - 待校验值。
 * @param path - 报错路径。
 * @returns 违规描述数组。
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
    ;(value as unknown[]).forEach((item, index) => {
      out.push(...valueViolations(node.items, item, `${path}[${index}]`))
    })
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>
    const properties = (node.properties ?? {}) as Record<string, unknown>
    for (const key of (node.required ?? []) as string[]) {
      if (!Object.hasOwn(record, key)) out.push(`${path}.${key} 缺失（required）`)
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) out.push(`${path}.${key} 是 schema 未声明的键`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) out.push(...valueViolations(properties[key], child, `${path}.${key}`))
    }
  }
  return out
}

// =====================================================================
//  假 DatabaseClient：喂 pg 真实形状的行（timestamptz → Date）
// =====================================================================

/** 路由：SQL 命中某个正则时返回预置行。 */
interface FakeRoute {
  readonly match: RegExp
  readonly rows: readonly unknown[]
}

/**
 * 造一个只认预置 SQL 的假连接；没预置到的 SQL 直接失败（不静默返回空）。
 * @param routes - SQL 匹配 → 行。
 * @returns 可当 `DatabaseClient` 用的对象。
 */
function fakeClient(routes: readonly FakeRoute[]): DatabaseClient {
  const client = {
    async query(sql: string): Promise<{ rows: readonly unknown[]; rowCount: number }> {
      const route = routes.find((candidate) => candidate.match.test(sql))
      if (route === undefined) throw new Error(`fakeClient: 未预置的 SQL：${sql.slice(0, 80)}`)
      return { rows: route.rows, rowCount: route.rows.length }
    },
  }
  return client as unknown as DatabaseClient
}

const TENANT = '11111111-1111-4111-8111-000000000001'
const ROLE_ID = '11111111-1111-4111-8111-000000000a01'
const ROLE_ID_MINIMAL = '11111111-1111-4111-8111-000000000a02'
const TEAM_ID = '11111111-1111-4111-8111-000000000b01'
const PIPELINE_ID = '11111111-1111-4111-8111-000000000c01'
const STAGE_ID = '11111111-1111-4111-8111-000000000c02'
const TEMPLATE_VERSION_ID = '11111111-1111-4111-8111-000000000d01'

/** pg 给出来的时间列：**Date 对象**，不是字符串。 */
const CREATED_AT = new Date('2026-11-12T17:36:55.612Z')
const UPDATED_AT = new Date('2026-11-14T11:14:17.926Z')
const ADDED_AT = new Date('2026-11-13T02:03:04.005Z')

const LABELS = { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' } as const

/** 工具构造只需要配置（不连库；密码是占位值）。 */
const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  tenant_id: TENANT,
  actor_id: '11111111-1111-4111-8111-000000000103',
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' }).resolved
if (DATABASE === null) throw new Error('测试配置解析失败')

const roleTool = createConfigRoleTool(DATABASE)
const teamTool = createConfigTeamTool(DATABASE)
const pipelineTool = createConfigPipelineTool(DATABASE)

/** 一条 pg 角色行（完整行）。 */
const ROLE_ROW = Object.freeze({
  id: ROLE_ID,
  code: 'HIRING_MANAGER',
  name: '招聘经理',
  description: '负责岗位与初筛',
  permission_scopes: ['JOB_WRITE', 'JOB_READ', 'JOB_READ'],
  is_active: true,
  record_version: 3,
  created_by_actor_id: '11111111-1111-4111-8111-000000000103',
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
})

/** 一条 pg 角色行（最简/历史种子行：可空列全 null、scopes 空、版本取 1）。 */
const ROLE_ROW_MINIMAL = Object.freeze({
  id: ROLE_ID_MINIMAL,
  code: 'LEGACY_VIEWER',
  name: '历史只读角色',
  description: null,
  permission_scopes: [] as string[],
  is_active: false,
  record_version: 1,
  created_by_actor_id: null,
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
})

/** 一条 pg 团队行（带部门名）。 */
const TEAM_ROW = Object.freeze({
  id: TEAM_ID,
  code: 'RD_HIRING',
  name: '研发招聘小组',
  department_id: '11111111-1111-4111-8111-000000000010',
  department_name: '研发部',
  description: null,
  is_active: true,
  record_version: 2,
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
})

/** 一条 pg 团队成员行（`created_at as added_at`，也是 Date）。 */
const TEAM_MEMBER_ROW = Object.freeze({
  team_id: TEAM_ID,
  actor_id: '11111111-1111-4111-8111-000000000103',
  display_name: '演示 HR',
  team_role: 'RECRUITER',
  is_active: true,
  added_at: ADDED_AT,
})

/** 一条 pg 流水线模板行。 */
const PIPELINE_ROW = Object.freeze({
  id: PIPELINE_ID,
  code: 'RD_DEFAULT',
  name: '研发默认流程',
  description: null,
  is_active: true,
  record_version: 4,
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
})

/** 一条 pg 流水线阶段行（阶段名来自 stage_catalog）。 */
const STAGE_ROW = Object.freeze({
  id: STAGE_ID,
  pipeline_template_id: PIPELINE_ID,
  stage_code: 'S6',
  stage_name: '申请接入',
  sort_order: 1,
})

/** 一条 pg 阶段→面试模板版本引用行。 */
const REF_ROW = Object.freeze({
  stage_id: STAGE_ID,
  interview_template_version_id: TEMPLATE_VERSION_ID,
  is_required: true,
  template_code: 'TECH_SCREEN',
  version_no: 2,
})

/** 三个工具的出参壳（与 `config-role.ts` / `config-team.ts` / `config-pipeline.ts` 的工厂同形）。 */
function roleListValue(roles: readonly unknown[]): unknown {
  return { tool: 'recruitment_config_role', contract_version: '1.0.0', operation: 'list', status: 'OK', roles, labels: LABELS }
}

function roleGetValue(role: unknown): unknown {
  return { tool: 'recruitment_config_role', contract_version: '1.0.0', operation: 'get', status: 'OK', role, labels: LABELS }
}

function teamListValue(teams: readonly unknown[]): unknown {
  return { tool: 'recruitment_config_team', contract_version: '1.0.0', operation: 'list', status: 'OK', teams, labels: LABELS }
}

function teamGetValue(team: unknown): unknown {
  return { tool: 'recruitment_config_team', contract_version: '1.0.0', operation: 'get', status: 'OK', team, labels: LABELS }
}

function pipelineListValue(pipelines: readonly unknown[]): unknown {
  return { tool: 'recruitment_config_pipeline', contract_version: '1.0.0', operation: 'list', status: 'OK', pipelines, labels: LABELS }
}

function pipelineGetValue(pipeline: unknown): unknown {
  return { tool: 'recruitment_config_pipeline', contract_version: '1.0.0', operation: 'get', status: 'OK', pipeline, labels: LABELS }
}

// =====================================================================
//  用例
// =====================================================================

test('config_role list：pg 的 Date 时间戳被映射为 ISO 文本，值过 lossless + 往返 + schema', async () => {
  const client = fakeClient([
    { match: /from recruitment\.role/, rows: [ROLE_ROW, ROLE_ROW_MINIMAL] },
  ])
  const roles = await listRoles(client, { tenantId: TENANT })
  const value = roleListValue(roles)
  assertSerializableOutput('config_role list', roleTool.output.schema, value)

  // 根因回归：时间列必须以字符串形态出现在出参里（不是一个能 toJSON 的对象）。
  const first = (value as { roles: { created_at: unknown; updated_at: unknown }[] }).roles[0]
  assert.equal(typeof first.created_at, 'string')
  assert.equal(first.created_at, CREATED_AT.toISOString())
  assert.equal(first.updated_at, UPDATED_AT.toISOString())
})

test('config_role get：可空列省略键 + 历史空 scopes + 版本边界值仍是 lossless JSON', async () => {
  const client = fakeClient([{ match: /from recruitment\.role/, rows: [ROLE_ROW_MINIMAL] }])
  const role = await getRole(client, { tenantId: TENANT, roleId: ROLE_ID_MINIMAL })
  const value = roleGetValue(role)
  assertSerializableOutput('config_role get', roleTool.output.schema, value)

  const record = role as unknown as Record<string, unknown>
  assert.equal(Object.hasOwn(record, 'description'), false, 'null 描述必须省略键，不用 null 占位')
  assert.equal(Object.hasOwn(record, 'created_by_actor_id'), false, 'null 创建人必须省略键')
  assert.deepEqual(record.permission_scopes, [])
  assert.equal(record.record_version, 1)
})

test('config_team list/get：成员 added_at 与团队时间列都是 ISO 文本，值过三件套', async () => {
  const client = fakeClient([
    { match: /from recruitment\.hiring_team_member m/, rows: [TEAM_MEMBER_ROW] },
    { match: /from recruitment\.hiring_team t/, rows: [TEAM_ROW] },
  ])
  const teams = await listTeams(client, { tenantId: TENANT })
  assertSerializableOutput('config_team list', teamTool.output.schema, teamListValue(teams))
  const member = (teams[0]?.members[0]) as unknown as Record<string, unknown>
  assert.equal(typeof member.added_at, 'string')
  assert.equal(member.added_at, ADDED_AT.toISOString())

  const clientForGet = fakeClient([
    { match: /from recruitment\.hiring_team_member m/, rows: [TEAM_MEMBER_ROW] },
    { match: /from recruitment\.hiring_team t/, rows: [TEAM_ROW] },
  ])
  const team = await getTeam(clientForGet, { tenantId: TENANT, teamId: TEAM_ID })
  assertSerializableOutput('config_team get', teamTool.output.schema, teamGetValue(team))
})

test('config_team：空成员集合（0 行成员）也不产生非 lossless 值', async () => {
  const client = fakeClient([
    { match: /from recruitment\.hiring_team_member m/, rows: [] },
    { match: /from recruitment\.hiring_team t/, rows: [TEAM_ROW] },
  ])
  const teams = await listTeams(client, { tenantId: TENANT })
  assert.equal(teams[0]?.members.length, 0)
  assertSerializableOutput('config_team 空成员', teamTool.output.schema, teamListValue(teams))
})

test('config_pipeline list/get：阶段与模板引用嵌套结构里的时间列都是 ISO 文本', async () => {
  const routes: FakeRoute[] = [
    { match: /from recruitment\.pipeline_template_stage_template r/, rows: [REF_ROW] },
    { match: /from recruitment\.pipeline_template_stage s/, rows: [STAGE_ROW] },
    { match: /from recruitment\.pipeline_template\b/, rows: [PIPELINE_ROW] },
  ]
  const pipelines = await listPipelines(fakeClient(routes), { tenantId: TENANT })
  assertSerializableOutput('config_pipeline list', pipelineTool.output.schema, pipelineListValue(pipelines))
  const pipeline = (pipelines[0]) as unknown as Record<string, unknown>
  assert.equal(typeof pipeline.created_at, 'string')
  assert.equal(pipeline.created_at, CREATED_AT.toISOString())

  // 空阶段 / 空模板引用：结构仍然合法且可序列化。
  const emptyRoutes: FakeRoute[] = [
    { match: /from recruitment\.pipeline_template_stage s/, rows: [] },
    { match: /from recruitment\.pipeline_template\b/, rows: [PIPELINE_ROW] },
  ]
  const empty = await listPipelines(fakeClient(emptyRoutes), { tenantId: TENANT })
  assert.equal(empty[0]?.stages.length, 0)

  const getRoutes: FakeRoute[] = [
    { match: /from recruitment\.pipeline_template_stage_template r/, rows: [REF_ROW] },
    { match: /from recruitment\.pipeline_template_stage s/, rows: [STAGE_ROW] },
    { match: /from recruitment\.pipeline_template\b/, rows: [PIPELINE_ROW] },
  ]
  const pipelineValue = await getPipeline(fakeClient(getRoutes), { tenantId: TENANT, pipelineTemplateId: PIPELINE_ID })
  assertSerializableOutput('config_pipeline get', pipelineTool.output.schema, pipelineGetValue(pipelineValue))
})

test('空集合（list 无行）也不产生非 lossless 值：三个工具都返回空数组', async () => {
  assertSerializableOutput('config_role 空列表', roleTool.output.schema,
    roleListValue(await listRoles(fakeClient([{ match: /from recruitment\.role/, rows: [] }]), { tenantId: TENANT })))
  assertSerializableOutput('config_team 空列表', teamTool.output.schema,
    teamListValue(await listTeams(fakeClient([{ match: /from recruitment\.hiring_team t/, rows: [] }]), { tenantId: TENANT })))
  assertSerializableOutput('config_pipeline 空列表', pipelineTool.output.schema,
    pipelineListValue(await listPipelines(fakeClient([{ match: /from recruitment\.pipeline_template\b/, rows: [] }]), { tenantId: TENANT })))
})
