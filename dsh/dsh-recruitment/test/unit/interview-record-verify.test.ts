// `recruitment_interview_record_verify`（S9 记录线的人类核验入口，D-B）的**冻结接口**单测：不连库。
//
// 守什么：
//   1. `parameters` 是封闭对象根（interview_record_id 必填、UUID 由 args.ts 的同一套校验）；
//   2. `output.schema` 只用 DSH 子集：**无 type 数组、无 `type:'null'`**；两份样本
//      （VERIFIED / NO_OP）零违反、值里零 null；
//   3. 参数层负例：非对象、缺必填、非 UUID、未知键、`tenant_id`/`actor_id` 拒收、reason 长度；
//   4. **人机闸门**（D-79）：缺依赖 = `unavailable`；只有 `allowed-once` 放行；
//      120s 常量复用 job_rubric_approve 的同一策略值；超时后晚到的 Allow **不采纳**；
//      `requireVerifyApprovalGranted` 拒绝时抛 `FORBIDDEN`；
//   5. **状态机以库为准**：只有 NEEDS_REVIEW/UNVERIFIED（且 current）可推进；
//      READY/VERIFIED 幂等；非当前 / 其它状态一律拒绝；
//   6. **合法前置**（artifact 可用、片段数 > 0、证据索引落地、rubric 未过期）逐条拒绝；
//   7. render 含两条状态轴 / 证据位点 / 读回命令；
//   8. 未配置替身：注册同一个工具名、schema 仍封闭、调用报 `NOT_CONFIGURED`。
//
// 为什么用官方 `dsh-tools` 校验器（与 job-create 单测同一做法）：本包无法静态 import
// `@deepseek-ai/dsh-tools`（`CONTRACT.md §0`），只能从 `$DSH_HOME/profiles` 按 file URL
// 动态加载；加载不到时退化成本文件内的同子集检查器，**不静默 skip**（会打印告警）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  CONTRACT_VERSION,
  INTERVIEW_RECORD_VERIFY_TOOL,
  VERIFIABLE_FROM,
  VERIFIED_TO,
  VERIFY_APPROVAL_TIMEOUT_MS,
  classifyRecordState,
  createInterviewRecordVerifyTool,
  evaluateRecordVerification,
  makeVerifyApprovalRequest,
  parseSectionsEvidence,
  parseVerifyArgs,
  refusalError,
  requireVerifyApprovalGranted,
  unconfiguredInterviewRecordVerifyTool,
  type InterviewRecordVerifyValue,
  type VerificationFacts,
} from '../../src/tools/interview-record-verify.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { apply } from '../../src/index.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR_ACTOR = '11111111-1111-4111-8111-000000000103'
const RECORD_ID = '11111111-1111-4111-8111-000000000901'
const INTERVIEW_ID = '11111111-1111-4111-8111-000000000101'
const APPLICATION_ID = '11111111-1111-4111-8111-000000000201'
const ARTIFACT_ID = '11111111-1111-4111-8111-000000000301'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000404'
const MEETING_ID = '11111111-1111-4111-8111-000000000501'
const SHA = 'a'.repeat(64)

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

const TOOL = createInterviewRecordVerifyTool(DATABASE)

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
  console.warn(`[interview-record-verify.test] 官方 dsh-tools 未加载（${OFFICIAL_TOOLS_PATH}），改用本地同子集检查器`)
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
 * 深扫值：类型 / enum / required / additionalProperties:false / items。
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

/** 一份规范的 `sections`（`transcript_import` 的真实形状，只取核验用到的键）。 */
function sectionsFor(citationSequences: readonly number[] = [0, 2]): Record<string, unknown> {
  return {
    schema: 'manual-import.sections/1',
    basis: { artifact_id: ARTIFACT_ID, revision: 1 },
    turns: citationSequences.map((sequence) => ({ sequence, text: `片段 ${sequence}` })),
    citations: citationSequences.map((sequence) => ({ kind: 'SEGMENT', sequence })),
  }
}

/** 合法的前置事实（每个负例只改一个字段）。 */
function facts(overrides: {
  record?: Partial<VerificationFacts['record']>
  artifact?: Partial<NonNullable<VerificationFacts['artifact']>> | null
  application_rubric_version_id?: string | null
  artifact_bound_to_interview?: boolean
  missing_citation_sequences?: readonly number[]
} = {}): VerificationFacts {
  const baseArtifact = {
    id: ARTIFACT_ID,
    meeting_id: MEETING_ID,
    source_revision: 1,
    transcript_status: 'READY',
    is_complete: true,
    has_more: false,
    char_count: 120,
    segment_count: 3,
  }
  const artifact = overrides.artifact === null
    ? null
    : { ...baseArtifact, ...(overrides.artifact ?? {}) }
  return {
    record: {
      id: RECORD_ID,
      interview_id: INTERVIEW_ID,
      transcript_artifact_id: ARTIFACT_ID,
      transcript_revision: 1,
      rubric_version_id: RUBRIC_ID,
      evidence_ok: true,
      sections: sectionsFor(),
      ...(overrides.record ?? {}),
    },
    artifact,
    application_rubric_version_id: overrides.application_rubric_version_id === undefined
      ? RUBRIC_ID
      : overrides.application_rubric_version_id,
    artifact_bound_to_interview: overrides.artifact_bound_to_interview ?? true,
    missing_citation_sequences: overrides.missing_citation_sequences ?? [],
  }
}

/** 两份规范样本（两个 outcome 各一份）。 */
function sampleValue(outcome: InterviewRecordVerifyValue['outcome']): Record<string, unknown> {
  const write = outcome === 'VERIFIED'
  const record: Record<string, unknown> = {
    id: RECORD_ID,
    interview_id: INTERVIEW_ID,
    application_id: APPLICATION_ID,
    status: VERIFIED_TO.status,
    verification_status: VERIFIED_TO.verification_status,
    record_version: write ? 2 : 2,
    is_current: true,
    evidence_ok: true,
    transcript_revision: 1,
    previous_status: write ? VERIFIABLE_FROM.status : VERIFIED_TO.status,
    previous_verification_status: write ? VERIFIABLE_FROM.verification_status : VERIFIED_TO.verification_status,
    verified_at: '2026-11-14T13:10:00.000Z',
    verified_by_actor_id: HR_ACTOR,
    verified_by_actor_kind: 'HUMAN',
  }
  return {
    tool: INTERVIEW_RECORD_VERIFY_TOOL,
    contract_version: CONTRACT_VERSION,
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
    outcome,
    replayed: outcome === 'NO_OP',
    gate: {
      requested: write,
      result: write ? 'allowed-once' : 'not-required',
    },
    record,
    artifact: {
      id: ARTIFACT_ID,
      source_revision: 1,
      transcript_status: 'READY',
      segment_count: 3,
      is_complete: true,
      has_more: false,
      content_sha256: SHA,
    },
    changes: {
      written: write,
      tables: write ? ['interview_record', 'event_inbox'] : [],
      event_ids: write ? ['11111111-1111-4111-8111-000000000e02'] : [],
    },
    next_action: {
      kind: 'READ_BACK',
      interview_record_id: RECORD_ID,
      verify_with: 'recruitment_transcript_read',
    },
  }
}

// ---------------------------------------------------------------------------
//  1. 工具形状 / schema 子集
// ---------------------------------------------------------------------------

test('工具名、契约版本、不可并发：核验是写工具（D-B 的入口）', () => {
  assert.equal(INTERVIEW_RECORD_VERIFY_TOOL, 'recruitment_interview_record_verify')
  assert.equal(TOOL.name, 'recruitment_interview_record_verify')
  assert.equal(CONTRACT_VERSION, '1.0.0')
  assert.equal(TOOL.isConcurrencySafe?.({}), false)
})

test('parameters 是封闭对象根：interview_record_id 必填，不许 tenant_id / actor_id', () => {
  const parameters = TOOL.parameters as Record<string, unknown>
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual([...(parameters.required as string[])].sort(), ['interview_record_id'])
  const properties = parameters.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(properties).sort(), ['interview_record_id', 'reason'])
  assert.deepEqual(schemaViolations(parameters), [])
})

test('output.schema 只用 DSH 子集：没有 type 数组、没有 type:null、required ⊆ properties', () => {
  assert.deepEqual(schemaViolations(TOOL.output.schema), [])
  if (official !== undefined) {
    official.assertSupportedJsonSchema(TOOL.output.schema)
    official.assertSupportedJsonSchema(TOOL.parameters)
  }
})

test('两份样本（VERIFIED / NO_OP）零违反，且值里没有 null', () => {
  for (const outcome of ['VERIFIED', 'NO_OP'] as const) {
    const value = sampleValue(outcome)
    assert.deepEqual(nullPaths(value), [], `${outcome} 样本不得出现 null`)
    assert.deepEqual(valueViolations(TOOL.output.schema, value), [], `${outcome} 样本违反 schema`)
    if (official !== undefined) {
      assert.deepEqual(official.validateJsonSchemaValue(TOOL.output.schema, value), [], `${outcome} 官方校验`)
    }
  }
})

test('可缺的键：artifact / verified_* 不出现也合法（读不到产物时省略，不写 null）', () => {
  const value = sampleValue('NO_OP')
  delete value.artifact
  const record = value.record as Record<string, unknown>
  delete record.verified_at
  delete record.verified_by_actor_id
  delete record.verified_by_actor_kind
  assert.deepEqual(valueViolations(TOOL.output.schema, value), [])
})

// ---------------------------------------------------------------------------
//  2. 参数层
// ---------------------------------------------------------------------------

test('合法入参被归一化（interview_record_id / 可选 reason）', () => {
  const args = parseVerifyArgs({ interview_record_id: RECORD_ID, reason: '证据与转写逐条对齐' })
  assert.deepEqual(args, { interview_record_id: RECORD_ID, reason: '证据与转写逐条对齐' })
  assert.equal(parseVerifyArgs({ interview_record_id: RECORD_ID }).reason, undefined)
})

/** 参数负例：只断言第一条违反项 + detail.violations 非空。 */
function parseRejects(raw: unknown, reasonCode: string, pathIncludes?: string): Record<string, unknown> {
  const body = errorBodyOf(() => parseVerifyArgs(raw))
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, reasonCode, `期望 ${reasonCode}，实际 ${String(body.reason_code)}`)
  const detail = body.detail as { allowed?: string[]; violations?: { reason_code: string; path: string }[] }
  const violations = detail.violations ?? []
  assert.ok(violations.length > 0, 'detail.violations 不得为空（TC §1.1 第 7 条）')
  assert.ok((detail.allowed ?? []).includes('interview_record_id'), 'detail.allowed 必须列出允许键')
  if (pathIncludes !== undefined) {
    assert.ok(violations[0]?.path.includes(pathIncludes), `期望 path 含 ${pathIncludes}，实际 ${violations[0]?.path}`)
  }
  return body
}

test('参数负例：非对象 / 缺必填 / 非 UUID / 未知键', () => {
  parseRejects([], 'TYPE_MISMATCH', 'arguments')
  parseRejects({}, 'MISSING_REQUIRED', 'interview_record_id')
  parseRejects({ interview_record_id: 'record_0001' }, 'ID_NOT_UUID', 'interview_record_id')
  parseRejects({ interview_record_id: RECORD_ID, approval_id: RECORD_ID }, 'UNKNOWN_PARAM', 'approval_id')
})

test('参数负例：tenant_id / actor_id 一律拒收（不许模型自报身份）；reason 越界', () => {
  for (const key of ['tenant_id', 'actor_id']) {
    parseRejects({ interview_record_id: RECORD_ID, [key]: HR_ACTOR }, 'TENANT_OR_ACTOR_NOT_ALLOWED', key)
  }
  parseRejects({ interview_record_id: RECORD_ID, reason: 'x'.repeat(501) }, 'OUT_OF_RANGE', 'reason')
  parseRejects({ interview_record_id: RECORD_ID, reason: '' }, 'TYPE_MISMATCH', 'reason')
})

// ---------------------------------------------------------------------------
//  3. D-79 人机闸门（纯函数）
// ---------------------------------------------------------------------------

test('D-79：approval 缺省 → makeVerifyApprovalRequest 返回 unavailable（= 拒绝写库）', async () => {
  assert.equal(await makeVerifyApprovalRequest(undefined, undefined)(), 'unavailable')
})

test('D-79：makeVerifyApprovalRequest 透传 toolName/agent/signal，封闭集原样返回', async () => {
  const agent = { id: 'agent-1' }
  const controller = new AbortController()
  let seen: Record<string, unknown> | undefined
  const approval = {
    async request(req: Record<string, unknown>): Promise<string> {
      seen = req
      return 'allowed-once'
    },
  }
  const approve = makeVerifyApprovalRequest(approval, { agent, signal: controller.signal })
  assert.equal(await approve(), 'allowed-once')
  assert.equal(seen?.toolName, INTERVIEW_RECORD_VERIFY_TOOL)
  assert.equal(seen?.agent, agent)
  assert.equal(seen?.signal, controller.signal)
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const) {
    const fn = makeVerifyApprovalRequest({ request: async () => outcome }, undefined)
    assert.equal(await fn(), outcome)
  }
  // 封闭集之外的字符串 → 不猜，按 unavailable（fail closed）。
  assert.equal(await makeVerifyApprovalRequest({ request: async () => 'allow' }, undefined)(), 'unavailable')
})

test('D-79：requireVerifyApprovalGranted 只在 allowed-once 放行，其余 FORBIDDEN + reason_code', () => {
  requireVerifyApprovalGranted('allowed-once')
  for (const [outcome, reasonCode] of [
    ['rejected', 'APPROVAL_NOT_GRANTED'],
    ['cancelled', 'APPROVAL_NOT_GRANTED'],
    ['timeout', 'APPROVAL_NOT_GRANTED'],
    ['unavailable', 'APPROVAL_UNAVAILABLE'],
  ] as const) {
    const body = errorBodyOf(() => requireVerifyApprovalGranted(outcome))
    assert.equal(body.code, 'FORBIDDEN')
    assert.equal(body.reason_code, reasonCode)
    assert.deepEqual(body.detail, { approval: outcome, tool: INTERVIEW_RECORD_VERIFY_TOOL })
  }
})

test('D-101：等待上限 120s（复用同一策略值）；测试注入 20ms → timeout，晚到的 allowed-once 不采纳', async () => {
  assert.equal(VERIFY_APPROVAL_TIMEOUT_MS, 120_000)
  const never = { request: () => new Promise<string>(() => undefined) }
  assert.equal(await makeVerifyApprovalRequest(never, undefined, 20)(), 'timeout')

  let resolveLate: ((value: string) => void) | undefined
  const late = new Promise<string>((resolve) => {
    resolveLate = resolve
  })
  const approve = makeVerifyApprovalRequest({ request: () => late }, undefined, 20)
  assert.equal(await approve(), 'timeout')
  resolveLate?.('allowed-once')
  await new Promise((resolve) => setTimeout(resolve, 40))
})

// ---------------------------------------------------------------------------
//  4. 状态分类（状态机以库为准）
// ---------------------------------------------------------------------------

test('状态分类：NEEDS_REVIEW/UNVERIFIED + current → 可核验', () => {
  const verdict = classifyRecordState({
    id: RECORD_ID,
    status: 'NEEDS_REVIEW',
    verification_status: 'UNVERIFIED',
    is_current: true,
  })
  assert.deepEqual(verdict, { kind: 'VERIFIABLE' })
})

test('状态分类：READY/VERIFIED + current → 幂等（NO_OP 由此判定，不问人、零写入）', () => {
  const verdict = classifyRecordState({
    id: RECORD_ID,
    status: 'READY',
    verification_status: 'VERIFIED',
    is_current: true,
  })
  assert.deepEqual(verdict, { kind: 'IDEMPOTENT' })
})

test('状态分类：非当前行即使已 READY/VERIFIED 也拒绝（RECORD_NOT_CURRENT）', () => {
  const verdict = classifyRecordState({
    id: RECORD_ID,
    status: 'READY',
    verification_status: 'VERIFIED',
    is_current: false,
  })
  assert.equal(verdict.kind, 'REFUSED')
  if (verdict.kind !== 'REFUSED') return
  assert.equal(verdict.code, 'INVALID_ARGS')
  assert.equal(verdict.reason_code, 'RECORD_NOT_CURRENT')
  assert.equal((verdict.detail as Record<string, unknown>).interview_record_id, RECORD_ID)
})

test('状态分类：其它状态一律拒绝（PENDING / PARTIAL / FAILED / READY+UNVERIFIED 脏行）', () => {
  for (const [status, verification] of [
    ['PENDING', 'UNVERIFIED'],
    ['PROCESSING', 'UNVERIFIED'],
    ['PARTIAL', 'UNVERIFIED'],
    ['FAILED', 'FAILED'],
    ['NEEDS_REVIEW', 'VERIFIED'],
    ['READY', 'UNVERIFIED'],
  ] as const) {
    const verdict = classifyRecordState({
      id: RECORD_ID,
      status,
      verification_status: verification,
      is_current: true,
    })
    assert.equal(verdict.kind, 'REFUSED', `${status}/${verification} 必须被拒绝`)
    if (verdict.kind !== 'REFUSED') continue
    assert.equal(verdict.reason_code, 'STATUS_NOT_VERIFIABLE')
    const detail = verdict.detail as Record<string, unknown>
    assert.equal(detail.status, status)
    assert.equal(detail.verification_status, verification)
    assert.deepEqual(detail.verifiable_from, { ...VERIFIABLE_FROM })
    assert.deepEqual(detail.verified_to, { ...VERIFIED_TO })
  }
})

// ---------------------------------------------------------------------------
//  5. sections 证据索引解析
// ---------------------------------------------------------------------------

test('sections 解析：真实形状（basis + citations[SEQMENT]）被接受，序号去重', () => {
  const parsed = parseSectionsEvidence(sectionsFor([0, 2, 2]))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.basis, { artifact_id: ARTIFACT_ID, revision: 1 })
  assert.deepEqual(parsed.citation_sequences, [0, 2])
})

test('sections 解析：字符串 JSON 也收（jsonb 的两种返回形态）', () => {
  const parsed = parseSectionsEvidence(JSON.stringify(sectionsFor([1])))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.citation_sequences, [1])
})

test('sections 解析负例：非对象 / 不可解析 / 缺 basis / citations 空或非法', () => {
  const cases: readonly [unknown, string][] = [
    [null, 'SECTIONS_INVALID'],
    ['not-json', 'SECTIONS_INVALID'],
    [[], 'SECTIONS_INVALID'],
    [{ citations: [{ kind: 'SEGMENT', sequence: 0 }] }, 'SECTIONS_INVALID'],
    [{ basis: { artifact_id: ARTIFACT_ID, revision: 1 } }, 'SECTIONS_NO_CITATIONS'],
    [{ basis: { artifact_id: ARTIFACT_ID, revision: 1 }, citations: [] }, 'SECTIONS_NO_CITATIONS'],
    [{ basis: { artifact_id: ARTIFACT_ID, revision: 1 }, citations: [null] }, 'SECTIONS_INVALID'],
    [{ basis: { artifact_id: ARTIFACT_ID, revision: 1 }, citations: [{ kind: 'TURN', sequence: 0 }] }, 'SECTIONS_INVALID'],
    [{ basis: { artifact_id: ARTIFACT_ID, revision: 1 }, citations: [{ kind: 'SEGMENT', sequence: '0' }] }, 'SECTIONS_INVALID'],
    [{ basis: { artifact_id: ARTIFACT_ID, revision: 1 }, citations: [{ kind: 'SEGMENT', sequence: 1.5 }] }, 'SECTIONS_INVALID'],
  ]
  for (const [input, reasonCode] of cases) {
    const parsed = parseSectionsEvidence(input)
    assert.equal(parsed.ok, false, `应拒绝：${JSON.stringify(input)}`)
    if (parsed.ok) continue
    assert.equal(parsed.reason_code, reasonCode)
    assert.equal(parsed.code, 'BLOCKED_BY_REVIEW')
    assert.ok(parsed.message.length > 0)
  }
})

// ---------------------------------------------------------------------------
//  6. 合法前置（逐条拒绝；每条都必须零写入）
// ---------------------------------------------------------------------------

test('前置校验：证据链完整的记录通过（sections/citations/片段/rubric 全部对齐）', () => {
  assert.deepEqual(evaluateRecordVerification(facts()), { ok: true })
})

test('前置校验负例矩阵：任一环不成立 → 结构化拒绝（BLOCKED_BY_REVIEW / NOT_FOUND）', () => {
  const cases: readonly [string, VerificationFacts, string, string][] = [
    ['artifact 不存在', facts({ artifact: null }), 'NOT_FOUND', 'TRANSCRIPT_ARTIFACT_NOT_FOUND'],
    ['修订号对不上', facts({ artifact: { source_revision: 2 } }), 'BLOCKED_BY_REVIEW', 'ARTIFACT_REVISION_MISMATCH'],
    ['转写未 READY', facts({ artifact: { transcript_status: 'PARTIAL' } }), 'BLOCKED_BY_REVIEW', 'TRANSCRIPT_NOT_READY'],
    ['原文未取齐', facts({ artifact: { is_complete: false } }), 'BLOCKED_BY_REVIEW', 'TRANSCRIPT_INCOMPLETE'],
    ['还有分页', facts({ artifact: { has_more: true } }), 'BLOCKED_BY_REVIEW', 'TRANSCRIPT_HAS_MORE'],
    ['原文为空', facts({ artifact: { char_count: 0 } }), 'BLOCKED_BY_REVIEW', 'TRANSCRIPT_EMPTY'],
    ['没有片段', facts({ artifact: { segment_count: 0 } }), 'BLOCKED_BY_REVIEW', 'TRANSCRIPT_NO_SEGMENTS'],
    ['会议没绑过该面试', facts({ artifact_bound_to_interview: false }), 'BLOCKED_BY_REVIEW', 'TRANSCRIPT_NOT_BOUND'],
    ['evidence_ok=false', facts({ record: { evidence_ok: false } }), 'BLOCKED_BY_REVIEW', 'EVIDENCE_OK_FALSE'],
    ['basis 指错 artifact', facts({ record: { sections: { ...sectionsFor(), basis: { artifact_id: 'other', revision: 1 } } } }), 'BLOCKED_BY_REVIEW', 'SECTIONS_BASIS_MISMATCH'],
    ['basis 指错版本', facts({ record: { sections: { ...sectionsFor(), basis: { artifact_id: ARTIFACT_ID, revision: 9 } } } }), 'BLOCKED_BY_REVIEW', 'SECTIONS_BASIS_MISMATCH'],
    ['引用了不存在的片段', facts({ missing_citation_sequences: [2] }), 'BLOCKED_BY_REVIEW', 'CITATION_SEGMENT_MISSING'],
    ['记录钉的 rubric 过期', facts({ application_rubric_version_id: 'other-rubric' }), 'BLOCKED_BY_REVIEW', 'RECORD_RUBRIC_STALE'],
    ['申请没有钉 rubric', facts({ application_rubric_version_id: null }), 'BLOCKED_BY_REVIEW', 'RECORD_RUBRIC_STALE'],
  ]
  for (const [label, input, code, reasonCode] of cases) {
    const verdict = evaluateRecordVerification(input)
    assert.equal(verdict.ok, false, `${label} 应被拒绝`)
    if (verdict.ok) continue
    assert.equal(verdict.code, code, `${label} 的 code`)
    assert.equal(verdict.reason_code, reasonCode, `${label} 的 reason_code`)
    assert.ok(verdict.message.length > 0, `${label} 必须有说明`)
    assert.ok(Object.keys(verdict.detail).length > 0, `${label} 的 detail 不得为空`)
    // 拒绝结论转成契约错误时，code/reason_code 原样进入 message 前缀的 JSON。
    const body = errorBodyOf(() => { throw refusalError(verdict) })
    assert.equal(body.code, code)
    assert.equal(body.reason_code, reasonCode)
  }
})

test('前置校验：detail 里不回显转写正文（只给 id/计数/序号）', () => {
  const verdict = evaluateRecordVerification(facts({ missing_citation_sequences: [3] }))
  assert.equal(verdict.ok, false)
  if (verdict.ok) return
  const text = JSON.stringify(verdict.detail)
  assert.equal(text.includes('面试官'), false)
  assert.equal(text.includes('候选人'), false)
  assert.deepEqual(verdict.detail.missing_sequences, [3])
})

// ---------------------------------------------------------------------------
//  7. render
// ---------------------------------------------------------------------------

test('render 含两条状态轴 / 证据位点 / 闸门与读回命令', () => {
  const text = (TOOL.output.render({}, sampleValue('VERIFIED')) as { text: string }[])[0]?.text ?? ''
  assert.match(text, /verified interview record/)
  assert.match(text, /NEEDS_REVIEW\/UNVERIFIED -> READY\/VERIFIED/)
  assert.match(text, /segments=3/)
  assert.match(text, /replayed=false/)
  assert.match(text, /gate: requested=true result=allowed-once/)
  assert.match(text, /recruitment_transcript_read\(interview_id=/)
})

test('render（NO_OP）：replayed=true、不问人、零写入', () => {
  const text = (TOOL.output.render({}, sampleValue('NO_OP')) as { text: string }[])[0]?.text ?? ''
  assert.match(text, /no_op interview record/)
  assert.match(text, /READY\/VERIFIED -> READY\/VERIFIED/)
  assert.match(text, /replayed=true/)
  assert.match(text, /gate: requested=false result=not-required/)
  assert.match(text, /changes: written=false/)
})

// ---------------------------------------------------------------------------
//  8. 未配置替身
// ---------------------------------------------------------------------------

test('未配置替身：注册同一个工具名、schema 仍封闭、调用报 NOT_CONFIGURED', async () => {
  const tool = unconfiguredInterviewRecordVerifyTool(['environment variable RECRUITMENT_DB_PASSWORD is not set'])
  assert.equal(tool.name, INTERVIEW_RECORD_VERIFY_TOOL)
  const parameters = tool.parameters as Record<string, unknown>
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(schemaViolations(parameters), [])
  assert.deepEqual(schemaViolations(tool.output.schema), [])
  await assert.rejects(
    () => tool.execute({ interview_record_id: RECORD_ID }, {}),
    (error: Error & { code?: string }) => error.code === 'NOT_CONFIGURED',
  )
})

// ---------------------------------------------------------------------------
//  9. 注册点（R2：不只存在于包内，必须从运行入口 apply() 可达）
// ---------------------------------------------------------------------------

test('apply() 注册 33 个工具（30 + email_fetch + criterion_override + candidate_constraint），且包含 recruitment_interview_record_verify 与 recruitment_email_fetch', () => {
  const registered: { name: string }[] = []
  const ctx = {
    tools: { register: (tool: { name: string }) => registered.push(tool) },
    effect: (fn: () => unknown) => fn(),
    inject: (_names: readonly string[], _cb: (child: unknown) => void) => {},
  }
  // 库指向 127.0.0.1:1：apply() 只造工具定义、不建连；真正调用才会失败（fail closed）。
  apply(ctx as never, {
    database: {
      host: '127.0.0.1',
      port: 1,
      user: 'postgres',
      database: 'ra_s6s7',
      tenant_id: TENANT,
      actor_id: HR_ACTOR,
    },
  }, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' })

  const names = registered.map((tool) => tool.name)
  assert.equal(names.length, 33, `注册数必须是 33（30 + email_fetch + criterion_override + candidate_constraint），实际 ${names.length}：${names.join(', ')}`)
  assert.equal(new Set(names).size, 33, '工具名不得重复')
  assert.ok(names.includes(INTERVIEW_RECORD_VERIFY_TOOL), `注册点少了记录核验工具：${names.join(', ')}`)
  assert.ok(names.includes('recruitment_email_fetch'), `注册点少了邮箱收件工具：${names.join(', ')}`)
})
