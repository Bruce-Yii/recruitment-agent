// `recruitment_evaluation_summarize` 的单测（**不连库**）。
//
// 覆盖任务书要求的纯函数层与形状层：
//   * 参数层负例（未知键 / 保留键 / 类型 / UUID / scope 三条 / as_of 缺失·格式·未来 /
//     require_complete 类型）；
//   * rationale 的 `REJECT_REASONS_JSON: ` 解析（最后一行、坏 JSON、非数组）；
//   * items 形状二次校验（TC §3.4 的每一条）；
//   * consensus 公式全分支（DC §3.3）；
//   * summary_digest 的确定性与 as_of 敏感性（DC-20）；
//   * 输出键名黑名单扫描（N-1 / N-8）；
//   * output.schema 的官方子集 + 样例值零违反；
//   * 源码只读静态扫描。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  computeEvaluationSummaryIn,
  consensusOf,
  createEvaluationSummarizeTool,
  parseRejectReasons,
  scorecardShapeViolations,
  summaryDigestOf,
} from '../../src/tools/evaluation-summarize.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR = '11111111-1111-4111-8111-000000000103'
const APPLICATION = '11111111-1111-4111-8111-000000000701'
const INTERVIEW = '11111111-1111-4111-8111-000000000901'
const RUBRIC = '11111111-1111-4111-8111-000000000403'
const AS_OF = '2026-11-13T01:00:00+08:00'
const NOW = Date.parse('2026-11-13T10:00:00+08:00')

/** 单测只要 tenant_id；actor 由 compute 里的 GUC 查询用假 client 代替。 */
const CFG = { tenant_id: TENANT, actor_id: HR } as unknown as ResolvedDatabaseConfig

/** 合法入参的骨架（各负例只改一个字段）。 */
const VALID = {
  application_id: APPLICATION,
  decision_scope: 'STAGE',
  interview_id: INTERVIEW,
  as_of: AS_OF,
}

/** 参数层负例不该碰库：任何 query 都立刻失败。 */
function fakeClient(): DatabaseClient {
  return {
    query: async () => {
      throw new Error('参数层/纯函数单测不应访问数据库')
    },
  } as unknown as DatabaseClient
}

/** 从 `Error: <CODE>: <json>` 里取回 JSON 体。 */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as Record<string, unknown>
}

/** 调一次并断言抛契约错误，返回错误体。 */
async function toolError(raw: unknown): Promise<Record<string, unknown>> {
  let thrown: unknown
  try {
    await computeEvaluationSummaryIn(fakeClient(), CFG, raw, NOW)
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, '应当抛错但没有抛')
  return errorBody(thrown)
}

// =====================================================================
//  参数层
// =====================================================================

test('参数层：非对象根 / 未知键 / 保留键 / 类型 / UUID 一次收集', async () => {
  const root = await toolError([])
  assert.equal(root.code, 'INVALID_ARGS')
  assert.equal(root.reason_code, 'TYPE_MISMATCH')

  const unknown = await toolError({ ...VALID, foo: 1 })
  assert.equal(unknown.reason_code, 'UNKNOWN_PARAM')
  const unknownDetail = unknown.detail as Record<string, unknown>
  assert.ok((unknownDetail.allowed as string[]).includes('application_id'))

  for (const key of ['tenant_id', 'actor_id', 'interviewer_id', 'stage_code', 'round_no', 'slot_code']) {
    const body = await toolError({ ...VALID, [key]: 'x' })
    assert.equal(body.reason_code, 'TENANT_OR_ACTOR_NOT_ALLOWED', key)
    assert.ok((body.detail as Record<string, unknown>).rejected_keys !== undefined)
  }

  const type = await toolError({ ...VALID, application_id: 5 })
  assert.equal(type.reason_code, 'TYPE_MISMATCH')

  const uuid = await toolError({ ...VALID, application_id: 'iv_0001' })
  assert.equal(uuid.reason_code, 'ID_NOT_UUID')

  const bool = await toolError({ ...VALID, require_complete: 'true' })
  assert.equal(bool.reason_code, 'TYPE_MISMATCH')
})

test('参数层：scope 三条（SCREENING / STAGE 缺面试 / FINAL 带面试）', async () => {
  const screening = await toolError({ ...VALID, decision_scope: 'SCREENING' })
  assert.equal(screening.code, 'INVALID_ARGS')
  assert.equal(screening.reason_code, 'DECISION_SCOPE_NOT_S10')

  const badEnum = await toolError({ ...VALID, decision_scope: 'stage' })
  assert.equal(badEnum.reason_code, 'ENUM_INVALID')

  const stage = await toolError({
    application_id: APPLICATION, decision_scope: 'STAGE', as_of: AS_OF,
  })
  assert.equal(stage.reason_code, 'STAGE_REQUIRES_INTERVIEW')

  const final = await toolError({ ...VALID, decision_scope: 'FINAL' })
  assert.equal(final.reason_code, 'FINAL_SCOPE_NO_INTERVIEW')
})

test('参数层：as_of 缺失 / 无偏移格式 / 未来', async () => {
  const missing = await toolError({
    application_id: APPLICATION, decision_scope: 'STAGE', interview_id: INTERVIEW,
  })
  assert.equal(missing.reason_code, 'MISSING_REQUIRED')

  const format = await toolError({ ...VALID, as_of: '2026-11-13T01:00:00' })
  // DESIGN §2：格式错按 TYPE_MISMATCH（TC §5.1 没有 AS_OF_FORMAT）。
  assert.equal(format.reason_code, 'TYPE_MISMATCH')

  const future = await toolError({ ...VALID, as_of: '2099-01-01T00:00:00+08:00' })
  assert.equal(future.reason_code, 'AS_OF_IN_FUTURE')
})

test('错误体：单行、可 JSON.parse、键序 code→reason_code→message→detail（TC §1.2）', async () => {
  let thrown: unknown
  try {
    await computeEvaluationSummaryIn(fakeClient(), CFG, { decision_scope: 'STAGE' }, NOW)
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof Error)
  const message = thrown.message
  assert.equal(message.includes('\n'), false, '错误消息必须单行')
  const index = message.indexOf(': ')
  const body = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
  assert.deepEqual(Object.keys(body), ['code', 'reason_code', 'message', 'detail'])
})

// =====================================================================
//  rationale 解析（DESIGN §3.5②）
// =====================================================================

test('rationale：取最后一个 REJECT_REASONS_JSON 行，坏 JSON / 缺失 / 非数组都失败', () => {
  assert.deepEqual(parseRejectReasons('REJECT_REASONS_JSON: []'), { ok: true, reasons: [] })
  const two = 'REJECT_REASONS_JSON: ["first"]\nREJECT_REASONS_JSON: ["last"]'
  assert.deepEqual(parseRejectReasons(two), { ok: true, reasons: ['last'] })
  const revision = '修订原因：当时听错了\nREJECT_REASONS_JSON: [{"dimension_key":"d1"}]'
  const parsed = parseRejectReasons(revision)
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal((parsed.reasons[0] as Record<string, unknown>).dimension_key, 'd1')

  assert.deepEqual(parseRejectReasons('没有这一行'), { ok: false })
  assert.deepEqual(parseRejectReasons('REJECT_REASONS_JSON: {bad json'), { ok: false })
  assert.deepEqual(parseRejectReasons('REJECT_REASONS_JSON: {"a":1}'), { ok: false })
  assert.deepEqual(parseRejectReasons(null), { ok: false })
})

// =====================================================================
//  items 形状（TC §3.4）
// =====================================================================

const DIMENSIONS = ['backend_depth', 'async_pipeline', 'frontend_basics']

function validItems(): Record<string, unknown> {
  return {
    transcript_basis: 'NO_TRANSCRIPT',
    backend_depth: { assessment: 'MET', score: 4, note: '好', evidence: [] },
    async_pipeline: { assessment: 'MET', score: 4, note: '好', evidence: [] },
    frontend_basics: { assessment: 'MET', score: 3, note: '可', evidence: [] },
  }
}

test('items 形状：合法面评零违规', () => {
  const shape = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS,
    items: validItems(),
    overall: 'ADVANCE',
    rationale: 'REJECT_REASONS_JSON: []',
  })
  assert.deepEqual(shape.violations, [])
  assert.equal(shape.transcriptBasis, 'NO_TRANSCRIPT')
})

test('items 形状：数组 / 缺维度 / 多键 / 四态 / ADVANCE 未评 / NO_TRANSCRIPT 带 SEGMENT', () => {
  const array = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS, items: [], overall: 'ADVANCE', rationale: null,
  })
  assert.ok(array.violations.includes('ITEMS_NOT_OBJECT'))

  const missing = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS,
    items: {
      transcript_basis: 'NO_TRANSCRIPT',
      backend_depth: { assessment: 'MET' },
      async_pipeline: { assessment: 'MET' },
    },
    overall: 'ADVANCE',
    rationale: null,
  })
  assert.ok(missing.violations.includes('DIMENSION_MISSING:frontend_basics'))

  const extra = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS,
    items: { ...validItems(), extra_dimension: { assessment: 'MET' } },
    overall: 'ADVANCE',
    rationale: null,
  })
  assert.ok(extra.violations.includes('ITEM_NOT_IN_RUBRIC:extra_dimension'))

  const bad = validItems()
  bad.backend_depth = { assessment: 'UNKNOWN' }
  const badAssessment = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS, items: bad, overall: 'ADVANCE', rationale: null,
  })
  assert.ok(badAssessment.violations.includes('ASSESSMENT_INVALID:backend_depth'))

  const unassessed = validItems()
  unassessed.backend_depth = { assessment: 'NOT_OBSERVED' }
  const advance = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS, items: unassessed, overall: 'ADVANCE', rationale: null,
  })
  assert.ok(advance.violations.includes('ADVANCE_WITH_UNASSESSED:backend_depth'))

  const segment = validItems()
  segment.backend_depth = {
    assessment: 'MET',
    score: 4,
    note: '好',
    evidence: [{ kind: 'SEGMENT', segment_id: 'x' }],
  }
  const noTranscript = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS, items: segment, overall: 'ADVANCE', rationale: null,
  })
  assert.ok(noTranscript.violations.includes('NO_TRANSCRIPT_SEGMENT:backend_depth'))
})

test('items 形状：REJECT 必须带可解析 reject_reasons，且每条落在 NOT_MET 维度', () => {
  const items = validItems()
  items.backend_depth = { assessment: 'NOT_MET', score: 1, note: '反证', evidence: [] }
  const rationale = 'REJECT_REASONS_JSON: [{"dimension_key":"backend_depth"}]'
  const ok = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS, items, overall: 'REJECT', rationale,
  })
  assert.deepEqual(ok.violations, [])

  const notBacked = validItems()
  const bad = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS,
    items: notBacked,
    overall: 'REJECT',
    rationale: 'REJECT_REASONS_JSON: [{"dimension_key":"backend_depth"}]',
  })
  assert.ok(bad.violations.includes('REJECT_DIMENSION_NOT_NOT_MET:backend_depth'))

  const unparsable = scorecardShapeViolations({
    rubricDimensionKeys: DIMENSIONS, items, overall: 'REJECT', rationale: '没有编码行',
  })
  assert.ok(unparsable.violations.includes('RATIONALE_NOT_PARSABLE'))
})

// =====================================================================
//  consensus（DC §3.3）
// =====================================================================

test('consensus：六个封闭词汇全分支', () => {
  assert.equal(consensusOf({ advance: 0, hold: 0, reject: 0, waived: 0 }), 'NO_SUBMISSIONS')
  assert.equal(consensusOf({ advance: 3, hold: 0, reject: 0, waived: 0 }), 'UNANIMOUS_ADVANCE')
  assert.equal(consensusOf({ advance: 0, hold: 0, reject: 3, waived: 0 }), 'UNANIMOUS_REJECT')
  assert.equal(consensusOf({ advance: 2, hold: 0, reject: 1, waived: 0 }), 'MAJORITY_ADVANCE')
  assert.equal(consensusOf({ advance: 2, hold: 1, reject: 0, waived: 0 }), 'MAJORITY_ADVANCE')
  assert.equal(consensusOf({ advance: 1, hold: 0, reject: 2, waived: 0 }), 'MAJORITY_REJECT')
  assert.equal(consensusOf({ advance: 1, hold: 2, reject: 0, waived: 0 }), 'SPLIT')
  assert.equal(consensusOf({ advance: 1, hold: 1, reject: 0, waived: 0 }), 'SPLIT')
  assert.equal(consensusOf({ advance: 1, hold: 1, reject: 1, waived: 0 }), 'SPLIT')
  assert.equal(consensusOf({ advance: 0, hold: 1, reject: 0, waived: 0 }), 'SPLIT')
})

// =====================================================================
//  summary_digest（DC-20）
// =====================================================================

function digestFacts(): Parameters<typeof summaryDigestOf>[0] {
  return {
    as_of: AS_OF,
    application_id: APPLICATION,
    decision_scope: 'STAGE',
    interview_id: INTERVIEW,
    rubric_version_id: RUBRIC,
    rubric_payload_hash: 'a'.repeat(64),
    scorecards: [
      { id: 'sc-2', revision_no: 1, interviewer_id: 'iv-b', payload_hash: 'b'.repeat(64), status: 'SUBMITTED' },
      { id: 'sc-1', revision_no: 1, interviewer_id: 'iv-a', payload_hash: 'c'.repeat(64), status: 'SUBMITTED' },
    ],
    record: { id: null, revision: null, verification_status: null },
    coverage: {
      required_total: 2, submitted: 2, waived: 0, missing: 0,
      unusable: 0, not_required: 0, overdue: 0, completion_ratio: 1,
    },
    tally: { advance: 2, hold: 0, reject: 0, waived: 0 },
    missing: [],
    blockers: [],
  }
}

test('summary_digest：64 hex、与键/数组顺序无关、as_of 与 rubric 变化会变', () => {
  const facts = digestFacts()
  const baseline = summaryDigestOf(facts)
  assert.match(baseline, /^[0-9a-f]{64}$/)

  const reordered = summaryDigestOf({
    ...facts,
    scorecards: [...facts.scorecards].reverse(),
    blockers: [...facts.blockers].reverse(),
    missing: [...facts.missing].reverse(),
  })
  assert.equal(reordered, baseline)

  const otherAsOf = summaryDigestOf({ ...facts, as_of: '2026-11-13T02:00:00+08:00' })
  assert.notEqual(otherAsOf, baseline)

  const otherRubric = summaryDigestOf({ ...facts, rubric_payload_hash: 'd'.repeat(64) })
  assert.notEqual(otherRubric, baseline)

  const otherScore = summaryDigestOf({
    ...facts,
    tally: { advance: 1, hold: 1, reject: 0, waived: 0 },
  })
  assert.notEqual(otherScore, baseline)
})

// =====================================================================
//  输出形状 / 黑名单 / render
// =====================================================================

const SAMPLE_SUMMARY: Record<string, unknown> = {
  tool: 'recruitment_evaluation_summarize',
  contract_version: '2.0.0',
  advisory: true,
  read_only: true,
  as_of: AS_OF,
  application_id: APPLICATION,
  interview_id: INTERVIEW,
  decision_scope: 'STAGE',
  stage_code: 'S10',
  labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
  rubric: {
    version_id: RUBRIC, version_no: 1, payload_hash: 'a'.repeat(64), source: 'APPLICATION_PINNED',
  },
  coverage: {
    required_total: 1, submitted: 1, waived: 0, missing: 0,
    unusable: 0, not_required: 0, overdue: 0, completion_ratio: 1,
  },
  missing: [],
  tally: { advance: 1, hold: 0, reject: 0, waived: 0 },
  consensus: 'UNANIMOUS_ADVANCE',
  consensus_scope: 'FULL_PANEL',
  minority_reports: [],
  aggregation: {
    method: 'PER_DIMENSION_SUBMITTED_ONLY',
    average: 4,
    per_dimension: [
      { dimension_key: 'backend_depth', mean: 4, denominator: 1, excluded: 0, values: [4] },
    ],
  },
  record: { state: 'ABSENT' },
  ready_for_decision: true,
  blockers: [],
  permitted_results: ['ADVANCE', 'HOLD', 'WITHDRAW', 'REJECT'],
  required_human_action: 'CONFIRM_DECISION',
  warnings: [],
  snapshot: {
    application_record_version: 1,
    rubric_version_id: RUBRIC,
    rubric_payload_hash: 'a'.repeat(64),
    scorecard_ids: ['11111111-1111-4111-8111-000000000a01'],
  },
  summary_digest: 'b'.repeat(64),
  brief: null,
  brief_absence: { code: 'NO_DECISION' },
}

const FORBIDDEN_KEYS = new Set([
  'result', 'decided_by_actor_id', 'decided_at', 'recommended_result', 'overall_score', 'score',
])

const SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** schema 子集检查：不支持的关键字 / type 数组 / type:'null' / required 不在 properties。 */
function schemaViolations(schema: unknown, path = 'schema'): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${path} 不是对象`]
  }
  const node = schema as Record<string, unknown>
  const out: string[] = []
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) out.push(`${path}.${key} 不是受支持关键字`)
  }
  const type = node.type
  if (Array.isArray(type)) out.push(`${path}.type 是数组`)
  else if (typeof type === 'string' && !SCHEMA_TYPES.has(type)) out.push(`${path}.type=${type}`)
  else if (type === undefined && node.oneOf === undefined && node.const === undefined) {
    out.push(`${path} 既无 type 也无 oneOf/const`)
  }
  const properties = node.properties as Record<string, unknown> | undefined
  const required = node.required as string[] | undefined
  for (const key of required ?? []) {
    if (properties === undefined || !Object.hasOwn(properties, key)) {
      out.push(`${path}.required 里有未声明键 ${key}`)
    }
  }
  for (const [key, child] of Object.entries(properties ?? {})) {
    out.push(...schemaViolations(child, `${path}.${key}`))
  }
  if (node.items !== undefined) out.push(...schemaViolations(node.items, `${path}.items`))
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((child, index) => out.push(...schemaViolations(child, `${path}.oneOf[${index}]`)))
  }
  return out
}

/** 值校验（覆盖本文件用到的子集：type/required/additionalProperties/items/enum/oneOf/const）。 */
function valueViolations(schema: unknown, value: unknown, path = 'value'): string[] {
  const node = schema as Record<string, unknown>
  const out: string[] = []
  if (Array.isArray(node.oneOf)) {
    const matches = node.oneOf.filter((child) => valueViolations(child, value, path).length === 0)
    if (matches.length !== 1) out.push(`${path} oneOf 命中 ${matches.length} 个`)
    return out
  }
  if ('const' in node && node.const !== value) {
    out.push(`${path} 不等于 const`)
    return out
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
      case 'null': return value === null
      default: return true
    }
  }
  if (!typeOk()) return [`${path} 类型不符（期望 ${type}）`]
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) {
    out.push(`${path} 不在 enum`)
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
      if (!Object.hasOwn(record, key)) out.push(`${path}.${key} 缺失`)
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) out.push(`${path}.${key} 未声明`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) out.push(...valueViolations(properties[key], child, `${path}.${key}`))
    }
  }
  return out
}

function collectKeys(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeys(item, `${path}[${index}]`, out))
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(key)
    collectKeys(child, `${path}.${key}`, out)
  }
}

test('工具定义：名称、并发安全、parameters 封闭、output.schema 只用官方子集', () => {
  const tool = createEvaluationSummarizeTool({ database: CFG })
  assert.equal(tool.name, 'recruitment_evaluation_summarize')
  assert.equal(tool.isConcurrencySafe?.({}), true)
  const parameters = tool.parameters as Record<string, unknown>
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(schemaViolations(parameters), [])
  assert.deepEqual(schemaViolations(tool.output.schema), [])

  // parameters 里声明了保留键，但运行时拒收（TC §1.6）。
  const properties = parameters.properties as Record<string, unknown>
  for (const key of ['tenant_id', 'actor_id', 'interviewer_id', 'stage_code', 'round_no']) {
    assert.ok(Object.hasOwn(properties, key), key)
  }
})

test('输出键名黑名单：任意层级都没有 result/decided_*/recommended_result/overall_score/score/can_', () => {
  const keys: string[] = []
  collectKeys(SAMPLE_SUMMARY, 'summary', keys)
  collectKeys(createEvaluationSummarizeTool({ database: CFG }).output.schema, 'schema', keys)
  for (const key of keys) {
    assert.equal(FORBIDDEN_KEYS.has(key), false, `出现禁用键 ${key}`)
    assert.equal(key.startsWith('can_'), false, `出现恒真权限键 ${key}`)
  }
  // scorecard_ids 必须保留（snapshot 契约字段），且它不等于 score。
  assert.ok(keys.includes('scorecard_ids'))
})

test('输出样例值：schema 零违反（含 average/brief 的 null 形态）', () => {
  const tool = createEvaluationSummarizeTool({ database: CFG })
  assert.deepEqual(valueViolations(tool.output.schema, SAMPLE_SUMMARY), [])

  const nullAverage = {
    ...SAMPLE_SUMMARY,
    aggregation: {
      method: 'PER_DIMENSION_SUBMITTED_ONLY',
      average: null,
      average_refused_reason: 'MISSING_SCORES',
      per_dimension: [],
    },
    ready_for_decision: false,
  }
  assert.deepEqual(valueViolations(tool.output.schema, nullAverage), [])

  const brief = {
    ...SAMPLE_SUMMARY,
    brief: {
      next_round: { round_no: 2 },
      carry_over: [],
      unanswered_questions: [],
      absent_interviewers: [],
      evidence_refs: [],
      derived_from: {
        decision_id: '11111111-1111-4111-8111-000000000d01',
        summary_digest: 'b'.repeat(64),
        rubric_version_id: RUBRIC,
        interview_ids: [INTERVIEW],
      },
      brief_digest: 'c'.repeat(64),
    },
  }
  assert.deepEqual(valueViolations(tool.output.schema, brief), [])
})

test('render：中文摘要含 coverage/tally/consensus/permitted_results/blockers 计数，无 can_', () => {
  const tool = createEvaluationSummarizeTool({ database: CFG })
  const blocks = tool.output.render({}, SAMPLE_SUMMARY)
  assert.equal(blocks.length, 1)
  const text = blocks[0]?.text ?? ''
  for (const token of ['coverage', 'tally', 'consensus', 'permitted_results', 'blockers']) {
    assert.ok(text.includes(token), token)
  }
  assert.equal(/can_/.test(text), false)
})

test('源码只读静态扫描：没有写语句 / 写事务封装 / fs / fetch / 子进程', async () => {
  const text = await readFile(join(PLUGIN_DIR, 'src/tools/evaluation-summarize.ts'), 'utf8')
  const patterns: readonly (readonly [string, RegExp])[] = [
    ['写表', /\binsert\s+into\b/i],
    ['改表', /\bupdate\s+\w+\s+set\b/i],
    ['删表', /\bdelete\s+from\b/i],
    ['写事务封装', /\bwithActor\b/],
    ['子进程', /\bchild_process\b/],
    ['网络', /\bfetch\s*\(/],
    ['文件系统', /from\s+'node:fs/],
  ]
  for (const [label, pattern] of patterns) {
    assert.equal(pattern.test(text), false, `${label} 命中`)
  }
  assert.match(text, /withReadOnly/)
})
