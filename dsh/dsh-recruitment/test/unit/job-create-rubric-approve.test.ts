// `recruitment_job_rubric_approve`（S3 rubric 批准入口，N7）的**冻结接口**单测：不连库。
//
// 守什么：
//   1. `parameters` 是封闭对象根（job_id / rubric_version_id 必填、UUID 由 args.ts 的同一套校验）；
//   2. `output.schema` 只用 DSH 子集：**无 type 数组、无 `type:'null'`**（`test/unit/output-schema.test.ts` 口径）；
//      三份样本（APPROVED / CURRENT_UPDATED / NO_OP）零违反、值里零 null；
//   3. 参数层负例：非对象、缺必填、非 UUID、未知键、`tenant_id`/`actor_id` 拒收、reason 长度；
//   4. D-79 闸门纯函数：缺依赖 = `unavailable`；只有 `allowed-once` 放行；120s 常量的真实值；
//      超时后晚到的 Allow **不采纳**；
//   5. `render()` 含岗位 code / 版本号 / current 指针 / 读回命令；
//   6. 未配置替身：注册同一个工具名、schema 仍封闭、调用报 `NOT_CONFIGURED`。
//
// 为什么用官方 `dsh-tools` 校验器（与 job-create 单测同一做法）：本包无法静态 import
// `@deepseek-ai/dsh-tools`（`CONTRACT.md §0`），只能从 `$DSH_HOME/profiles` 按 file URL
// 动态加载；加载不到时退化成本文件内的同子集检查器，**不静默 skip**（会打印告警）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  APPROVAL_TIMEOUT_MS,
  CONTRACT_VERSION,
  JOB_RUBRIC_APPROVE_TOOL,
  createJobRubricApproveTool,
  makeApprovalRequest,
  parseApproveArgs,
  requireApprovalGranted,
  unconfiguredJobRubricApproveTool,
  type JobRubricApproveValue,
} from '../../src/tools/job-rubric-approve.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR_ACTOR = '11111111-1111-4111-8111-000000000103'
const JOB_ID = '11111111-1111-4111-8111-000000000401'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000404'
const APPROVAL_ID = '11111111-1111-4111-8111-000000000405'
const PREVIOUS_RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const HASH = 'a'.repeat(64)

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

const TOOL = createJobRubricApproveTool(DATABASE)

/** 官方校验器的最小接口（`dsh-tools/lib/index.js` 的导出）。 */
interface OfficialSchemaTools {
  assertSupportedJsonSchema(schema: unknown): void
  validateJsonSchemaValue(schema: unknown, value: unknown, path?: string): string[]
}

const DSH_HOME = process.env.DSH_HOME ?? 'D:\\12412\\dsh-home'
const OFFICIAL_TOOLS_PATH = join(
  DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js',
)

let official: OfficialSchemaTools | undefined
try {
  official = (await import(pathToFileURL(OFFICIAL_TOOLS_PATH).href)) as unknown as OfficialSchemaTools
} catch {
  official = undefined
  console.warn(`[job-create-rubric-approve.test] 官方 dsh-tools 未加载（${OFFICIAL_TOOLS_PATH}），改用本地同子集检查器`)
}

/** DSH 支持的约束关键字（json-schema.js 的 CONTRACT + annotations）。 */
const SUPPORTED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
/** 本工具允许的类型（**不含 null**：缺的值靠省略键表达）。 */
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

/**
 * 深扫 schema：子集外关键字 / type 数组 / `type:'null'` / required 不在 properties。
 * @param schema - 待检查的 JSON Schema 节点。
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
    if (!TYPES.has(type)) out.push(`${path}.type=${type} 不是本工具使用的类型（不许 null）`)
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
 * 深扫值：类型 / enum / const / required / additionalProperties:false / items。
 * @param schema - schema 节点。
 * @param value - 待校验的值。
 * @param path - 诊断路径。
 */
function valueViolations(schema: unknown, value: unknown, path = 'value'): string[] {
  const node = schema as Record<string, unknown>
  if (Array.isArray(node.oneOf)) {
    const results = (node.oneOf as unknown[]).map((branch) => valueViolations(branch, value, path))
    const passing = results.filter((violations) => violations.length === 0).length
    return passing === 1 ? [] : results.flat().slice(0, 2)
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
      default: return true
    }
  }
  const out: string[] = []
  if (!typeOk()) return [`${path} 类型不符（期望 ${type}）`]
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) {
    out.push(`${path} 不在 enum 里：${JSON.stringify(value)}`)
  }
  if (type === 'array' && node.items !== undefined) {
    (value as unknown[]).forEach((item, index) => out.push(...valueViolations(node.items, item, `${path}[${index}]`)))
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

/** 深扫 null（DSH 输出不许出现 null；缺的值靠省略键表达）。 */
function nullPaths(value: unknown, path = 'value'): string[] {
  if (value === null) return [path]
  if (Array.isArray(value)) return value.flatMap((item, index) => nullPaths(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => nullPaths(child, `${path}.${key}`))
  }
  return []
}

/** 从 `Error: <CODE>: <json>` 里取出错误体（TC §1.2）。 */
function errorBodyOf(fn: () => unknown): Record<string, unknown> {
  try {
    fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const index = message.indexOf(': ')
    assert.ok(index > 0, `错误消息不是 <CODE>: <json> 形态：${message}`)
    const code = message.slice(0, index)
    const body = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
    assert.equal(body.code, code, '消息前缀的 code 必须与 JSON 里的 code 相同（TC §1.2）')
    return body
  }
  assert.fail('期望抛错但没抛')
}

/** 三份规范样本（三个 outcome 各一份）。 */
function sampleValue(outcome: JobRubricApproveValue['outcome']): Record<string, unknown> {
  const write = outcome !== 'NO_OP'
  const job: Record<string, unknown> = {
    id: JOB_ID,
    code: 'BE-001',
    title: '后端工程师',
    status: 'OPEN',
    current_rubric_version_id: RUBRIC_ID,
    record_version: 3,
  }
  if (outcome === 'APPROVED') job.previous_current_rubric_version_id = PREVIOUS_RUBRIC_ID
  return {
    tool: JOB_RUBRIC_APPROVE_TOOL,
    contract_version: CONTRACT_VERSION,
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
    outcome,
    replayed: outcome !== 'APPROVED',
    gate: {
      requested: write,
      result: write ? 'allowed-once' : 'not-required',
    },
    job,
    rubric: {
      version_id: RUBRIC_ID,
      version_no: 2,
      payload_hash: HASH,
      is_approved: true,
      is_current: true,
    },
    approval: {
      approval_id: APPROVAL_ID,
      status: 'APPROVED',
      decided_at: '2026-11-14T09:00:00.000Z',
      decided_by_actor_id: HR_ACTOR,
      canonical_payload_hash: HASH,
      record_version: 2,
    },
    changes: {
      written: write,
      tables: write ? ['approval', 'job', 'event_inbox'] : [],
      event_ids: write ? ['11111111-1111-4111-8111-000000000e01'] : [],
    },
    next_action: { kind: 'READ_BACK', job_id: JOB_ID, verify_with: 'recruitment_job_get' },
  }
}

// ---------------------------------------------------------------------------
//  1. 工具形状 / schema 子集
// ---------------------------------------------------------------------------

test('工具名、契约版本、不可并发：approve 是写工具（N7 的入口）', () => {
  assert.equal(JOB_RUBRIC_APPROVE_TOOL, 'recruitment_job_rubric_approve')
  assert.equal(TOOL.name, 'recruitment_job_rubric_approve')
  assert.equal(CONTRACT_VERSION, '1.0.0')
  assert.equal(TOOL.isConcurrencySafe?.({}), false)
})

test('parameters 是封闭对象根：job_id / rubric_version_id 必填，不许 tenant_id / actor_id', () => {
  const parameters = TOOL.parameters as Record<string, unknown>
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual([...(parameters.required as string[])].sort(), ['job_id', 'rubric_version_id'])
  const properties = parameters.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(properties).sort(), ['job_id', 'reason', 'rubric_version_id'])
  assert.deepEqual(schemaViolations(parameters), [])
})

test('output.schema 只用 DSH 子集：没有 type 数组、没有 type:null、required ⊆ properties', () => {
  assert.deepEqual(schemaViolations(TOOL.output.schema), [])
  if (official !== undefined) {
    // 官方校验器是最终裁决（本包运行时就是它）。
    official.assertSupportedJsonSchema(TOOL.output.schema)
    official.assertSupportedJsonSchema(TOOL.parameters)
  }
})

test('三份样本（APPROVED / CURRENT_UPDATED / NO_OP）零违反，且值里没有 null', () => {
  for (const outcome of ['APPROVED', 'CURRENT_UPDATED', 'NO_OP'] as const) {
    const value = sampleValue(outcome)
    assert.deepEqual(nullPaths(value), [], `${outcome} 样本不得出现 null`)
    assert.deepEqual(valueViolations(TOOL.output.schema, value), [], `${outcome} 样本违反 schema`)
    if (official !== undefined) {
      assert.deepEqual(official.validateJsonSchemaValue(TOOL.output.schema, value), [], `${outcome} 官方校验`)
    }
  }
})

test('可缺的键：previous_current_rubric_version_id 不出现也合法（NO_OP / 首次批准）', () => {
  const value = sampleValue('APPROVED')
  delete (value.job as Record<string, unknown>).previous_current_rubric_version_id
  assert.deepEqual(valueViolations(TOOL.output.schema, value), [])
})

// ---------------------------------------------------------------------------
//  2. 参数层
// ---------------------------------------------------------------------------

test('合法入参被归一化（job_id / rubric_version_id / 可选 reason）', () => {
  const args = parseApproveArgs({ job_id: JOB_ID, rubric_version_id: RUBRIC_ID, reason: '标准已对齐' })
  assert.deepEqual(args, { job_id: JOB_ID, rubric_version_id: RUBRIC_ID, reason: '标准已对齐' })
  assert.equal(parseApproveArgs({ job_id: JOB_ID, rubric_version_id: RUBRIC_ID }).reason, undefined)
})

/** 参数负例：只断言第一条违反项 + detail.violations 非空。 */
function parseRejects(raw: unknown, reasonCode: string, pathIncludes?: string): Record<string, unknown> {
  const body = errorBodyOf(() => parseApproveArgs(raw))
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, reasonCode, `期望 ${reasonCode}，实际 ${String(body.reason_code)}`)
  const detail = body.detail as { allowed?: string[]; violations?: { reason_code: string; path: string }[] }
  const violations = detail.violations ?? []
  assert.ok(violations.length > 0, 'detail.violations 不得为空（TC §1.1 第 7 条）')
  assert.ok((detail.allowed ?? []).includes('job_id'), 'detail.allowed 必须列出允许键')
  if (pathIncludes !== undefined) {
    assert.ok(violations[0]?.path.includes(pathIncludes), `期望 path 含 ${pathIncludes}，实际 ${violations[0]?.path}`)
  }
  return body
}

test('参数负例：非对象 / 缺必填 / 非 UUID', () => {
  parseRejects([], 'TYPE_MISMATCH', 'arguments')
  parseRejects({ rubric_version_id: RUBRIC_ID }, 'MISSING_REQUIRED', 'job_id')
  parseRejects({ job_id: JOB_ID }, 'MISSING_REQUIRED', 'rubric_version_id')
  parseRejects({ job_id: 'job_0001', rubric_version_id: RUBRIC_ID }, 'ID_NOT_UUID', 'job_id')
  parseRejects({ job_id: JOB_ID, rubric_version_id: 'v2' }, 'ID_NOT_UUID', 'rubric_version_id')
})

test('参数负例：tenant_id / actor_id 一律拒收（不许模型自报身份，TC §0 第 4 条）', () => {
  for (const key of ['tenant_id', 'actor_id']) {
    parseRejects({ job_id: JOB_ID, rubric_version_id: RUBRIC_ID, [key]: HR_ACTOR }, 'TENANT_OR_ACTOR_NOT_ALLOWED', key)
  }
})

test('参数负例：未知键 → UNKNOWN_PARAM（不静默忽略）；reason 超长 → OUT_OF_RANGE', () => {
  parseRejects({ job_id: JOB_ID, rubric_version_id: RUBRIC_ID, approval_id: APPROVAL_ID }, 'UNKNOWN_PARAM', 'approval_id')
  parseRejects({ job_id: JOB_ID, rubric_version_id: RUBRIC_ID, reason: 'x'.repeat(501) }, 'OUT_OF_RANGE', 'reason')
  parseRejects({ job_id: JOB_ID, rubric_version_id: RUBRIC_ID, reason: '' }, 'TYPE_MISMATCH', 'reason')
})

// ---------------------------------------------------------------------------
//  3. D-79 人机闸门（纯函数）
// ---------------------------------------------------------------------------

test('D-79：approval 缺省 → makeApprovalRequest 返回 unavailable（= 拒绝写库）', async () => {
  assert.equal(await makeApprovalRequest(undefined, undefined)(), 'unavailable')
})

test('D-79：makeApprovalRequest 透传 toolName/agent/signal，封闭集原样返回', async () => {
  const agent = { id: 'agent-1' }
  const controller = new AbortController()
  let seen: Record<string, unknown> | undefined
  const approval = {
    async request(req: Record<string, unknown>): Promise<string> {
      seen = req
      return 'allowed-once'
    },
  }
  const approve = makeApprovalRequest(approval, { agent, signal: controller.signal })
  assert.equal(await approve(), 'allowed-once')
  assert.equal(seen?.toolName, 'recruitment_job_rubric_approve')
  assert.equal(seen?.agent, agent)
  assert.equal(seen?.signal, controller.signal)
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const) {
    const fn = makeApprovalRequest({ request: async () => outcome }, undefined)
    assert.equal(await fn(), outcome)
  }
  // 封闭集之外的字符串 → 不猜，按 unavailable（fail closed）。
  assert.equal(await makeApprovalRequest({ request: async () => 'allow' }, undefined)(), 'unavailable')
})

test('D-79：requireApprovalGranted 只在 allowed-once 放行，其余 FORBIDDEN + reason_code', () => {
  requireApprovalGranted('allowed-once')
  for (const [outcome, reasonCode] of [
    ['rejected', 'APPROVAL_NOT_GRANTED'],
    ['cancelled', 'APPROVAL_NOT_GRANTED'],
    ['timeout', 'APPROVAL_NOT_GRANTED'],
    ['unavailable', 'APPROVAL_UNAVAILABLE'],
  ] as const) {
    const body = errorBodyOf(() => requireApprovalGranted(outcome))
    assert.equal(body.code, 'FORBIDDEN')
    assert.equal(body.reason_code, reasonCode)
    assert.deepEqual(body.detail, { approval: outcome, tool: 'recruitment_job_rubric_approve' })
  }
})

test('D-101：等待上限 120s；测试注入 20ms → timeout，晚到的 allowed-once 不改变结论', async () => {
  assert.equal(APPROVAL_TIMEOUT_MS, 120_000)
  const never = { request: () => new Promise<string>(() => undefined) }
  assert.equal(await makeApprovalRequest(never, undefined, 20)(), 'timeout')

  let resolveLate: ((value: string) => void) | undefined
  const late = new Promise<string>((resolve) => {
    resolveLate = resolve
  })
  const approve = makeApprovalRequest({ request: () => late }, undefined, 20)
  assert.equal(await approve(), 'timeout')
  resolveLate?.('allowed-once')
  await new Promise((resolve) => setTimeout(resolve, 40))
})

// ---------------------------------------------------------------------------
//  4. render
// ---------------------------------------------------------------------------

test('render 含岗位 code / rubric 版本 / current 指针 / 闸门与读回命令', () => {
  const text = (TOOL.output.render({}, sampleValue('APPROVED')) as { text: string }[])[0]?.text ?? ''
  assert.match(text, /rubric v2/)

  assert.match(text, /BE-001/)
  assert.match(text, /current_rubric_version_id:/)
  assert.match(text, /replayed=false/)
  assert.match(text, /gate: requested=true result=allowed-once/)
  assert.match(text, /recruitment_job_get\(job_id=/)
})

test('render（NO_OP）：outcome=no_op、不问人、零写入', () => {
  const text = (TOOL.output.render({}, sampleValue('NO_OP')) as { text: string }[])[0]?.text ?? ''
  assert.match(text, /no_op/)
  assert.match(text, /replayed=true/)
  assert.match(text, /gate: requested=false result=not-required/)
  assert.match(text, /changes: written=false/)
})

// ---------------------------------------------------------------------------
//  5. 未配置替身
// ---------------------------------------------------------------------------

test('未配置替身：注册同一个工具名、schema 仍封闭、调用报 NOT_CONFIGURED', async () => {
  const tool = unconfiguredJobRubricApproveTool(['environment variable RECRUITMENT_DB_PASSWORD is not set'])
  assert.equal(tool.name, JOB_RUBRIC_APPROVE_TOOL)
  const parameters = tool.parameters as Record<string, unknown>
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(schemaViolations(parameters), [])
  assert.deepEqual(schemaViolations(tool.output.schema), [])
  await assert.rejects(
    () => tool.execute({ job_id: JOB_ID, rubric_version_id: RUBRIC_ID }, {}),
    (error: Error & { code?: string }) => error.code === 'NOT_CONFIGURED',
  )
})
