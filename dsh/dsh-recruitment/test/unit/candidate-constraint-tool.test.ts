// recruitment_candidate_constraint 工具 + 两处读投影的单测（不连真库、不 import 产品 index.ts）。
//
// 覆盖：
//   * 工具形状（工具名/契约版本/isConcurrencySafe=false/封闭 schema）；
//   * parseToolArgs：合法 PIN/HANDOFF/UNPIN、超长 text、缺 interview_id、身份键/未知键、
//     HANDOFF 非法 source → INVALID_ARGS（零写入）；
//   * labels：出参三轴齐全，且经 buildThreeAxisLabels（假 client 返回 provenance 行）；
//   * render：短号 + machine arguments header，人读正文不含完整 UUID；
//   * 读投影：toApplicationValue 的 constraints 段、toInterviewRow 的 candidate_constraints 段
//     （含「上一轮留给本轮的追问」文本、pins 排序、墓碑过滤）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANDIDATE_CONSTRAINT_TOOL,
  CONTRACT_VERSION,
  createCandidateConstraintTool,
  parseToolArgs,
  recordCandidateConstraintInTransaction,
  renderCandidateConstraintValue,
  unconfiguredCandidateConstraintTool,
} from '../../src/tools/candidate-constraint.ts'
import {
  toApplicationValue,
  toCandidateConstraintsValue,
} from '../../src/tools/business-read.ts'
import {
  toInterviewRow,
  type InterviewExtensionRow,
  type InterviewerCandidateConstraints,
  type ToInterviewRowInput,
} from '../../src/http/interviewer.ts'
import { UNPIN_TOMBSTONE_TEXT, type CandidateConstraintRow } from '../../src/domain/candidate-constraint.ts'
import type { InterviewValue } from '../../src/tools/interview-get.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const CANDIDATE = '22222222-2222-4222-8222-000000000001'
const APPLICATION = '33333333-3333-4333-8333-000000000001'
const INTERVIEW = '44444444-4444-4444-8444-000000000001'
const ACTOR = '55555555-5555-4555-8555-000000000001'
const CONSTRAINT_ID = '66666666-6666-4666-8666-000000000001'

const FAKE_CONFIG = {
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  database: 'ra_fake',
  password: 'shape-test-only',
  tenant_id: TENANT,
  actor_id: ACTOR,
} as never

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

function errorBody(error: unknown): { code?: string; reason_code?: string } {
  assert.ok(error instanceof RecruitmentToolError, `必须是 RecruitmentToolError，实际 ${String(error)}`)
  const match = /"reason_code"\s*:\s*"([^"]+)"/.exec(error.message)
  return { code: error.code, reason_code: match?.[1] }
}

/** assert.throws 不返回错误对象（成功时返回 undefined），手动捕获。 */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('expected an error to be thrown')
}

function ccRow(overrides: Partial<CandidateConstraintRow> & { id: string }): CandidateConstraintRow {
  return {
    tenant_id: TENANT,
    candidate_id: CANDIDATE,
    kind: 'PIN',
    text: '不要加班',
    source: 'CHAT',
    application_id: null,
    interview_id: null,
    created_by_actor_id: ACTOR,
    created_at: '2026-01-01T00:00:00.000Z',
    superseded_by_constraint_id: null,
    record_version: 1,
    ...overrides,
  }
}

interface QueryCall { sql: string; params: unknown[] }
interface QueryResult { rows: unknown[]; rowCount?: number }
function fakeClient(results: QueryResult[]): {
  client: { query: (sql: string, params?: unknown[]) => Promise<QueryResult> }
  calls: QueryCall[]
} {
  const calls: QueryCall[] = []
  let index = 0
  const client = {
    query: async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      const result = results[index]
      index += 1
      if (result === undefined) throw new Error(`unexpected query #${index}: ${sql}`)
      return result
    },
  }
  return { client: client as never, calls }
}

// ---------------------------------------------------------------------------
//  1. 工具定义形状
// ---------------------------------------------------------------------------

test('createCandidateConstraintTool：工具名/契约版本/isConcurrencySafe=false/封闭 schema', () => {
  const tool = createCandidateConstraintTool({ database: FAKE_CONFIG })
  assert.equal(tool.name, CANDIDATE_CONSTRAINT_TOOL)
  assert.equal(CANDIDATE_CONSTRAINT_TOOL, 'recruitment_candidate_constraint')
  assert.equal(CONTRACT_VERSION, 'candidate-constraint 1.0.0')
  assert.equal(tool.isConcurrencySafe?.({}), false)
  assertDshSubset(tool.parameters, `${tool.name}.parameters`)
  assertDshSubset(tool.output.schema, `${tool.name}.output`)
  assert.equal(tool.parameters.additionalProperties, false)
  const props = tool.parameters.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(props).sort(), [
    'action', 'application_id', 'candidate_id', 'interview_id', 'source', 'text',
  ])
  assert.deepEqual([...tool.parameters.required as string[]].sort(), ['action'])
  const serialized = JSON.stringify(tool.parameters)
  for (const key of ['tenant_id', 'actor_id', 'created_by_actor_id', 'id', 'created_at', 'record_version', 'superseded_by_constraint_id']) {
    assert.ok(!serialized.includes(`"${key}"`), `参数 schema 不能声明 ${key}`)
  }
})

test('unconfiguredCandidateConstraintTool：同名 + NOT_CONFIGURED + 同一封闭 schema', async () => {
  const tool = unconfiguredCandidateConstraintTool(['database.password'])
  assert.equal(tool.name, CANDIDATE_CONSTRAINT_TOOL)
  assertDshSubset(tool.output.schema, `${tool.name}.output`)
  assert.equal(tool.isConcurrencySafe?.({}), false)
  const error = await tool.execute({}).then(() => undefined, (e: unknown) => e)
  assert.equal(errorBody(error).code, 'NOT_CONFIGURED')
})

// ---------------------------------------------------------------------------
//  2. parseToolArgs：合法 / 拒绝
// ---------------------------------------------------------------------------

test('parseToolArgs：合法 PIN / HANDOFF / UNPIN 归一化', () => {
  assert.deepEqual(parseToolArgs({
    action: 'PIN', candidate_id: CANDIDATE, text: '  不要加班  ', source: 'CHAT',
  }), { action: 'PIN', candidate_id: CANDIDATE, text: '不要加班', source: 'CHAT' })
  assert.deepEqual(parseToolArgs({
    action: 'HANDOFF', application_id: APPLICATION, text: '下一轮追问分片重放', source: 'WEIXIN', interview_id: INTERVIEW,
  }), {
    action: 'HANDOFF', application_id: APPLICATION, text: '下一轮追问分片重放', source: 'WEIXIN', interview_id: INTERVIEW,
  })
  assert.deepEqual(parseToolArgs({ action: 'UNPIN', candidate_id: CANDIDATE }), {
    action: 'UNPIN', candidate_id: CANDIDATE,
  })
})

test('parseToolArgs：超长 text / 缺 interview_id / 缺 text/source → INVALID_ARGS', () => {
  const overlong = 'x'.repeat(501)
  for (const [args, reason] of [
    [{ action: 'PIN', candidate_id: CANDIDATE, text: overlong, source: 'CHAT' }, 'OUT_OF_RANGE'],
    [{ action: 'HANDOFF', candidate_id: CANDIDATE, text: 'x', source: 'CHAT' }, 'MISSING_REQUIRED'],
    [{ action: 'PIN', candidate_id: CANDIDATE, text: 'x' }, 'MISSING_REQUIRED'],
    [{ action: 'PIN', candidate_id: CANDIDATE, source: 'CHAT' }, 'MISSING_REQUIRED'],
  ] as const) {
    const error = captureError(() => parseToolArgs(args))
    assert.ok(error instanceof RecruitmentToolError)
    assert.equal(errorBody(error).code, 'INVALID_ARGS')
    assert.equal(errorBody(error).reason_code, reason)
  }
})

test('parseToolArgs：身份键 / 未知键 / HANDOFF 非法 source → INVALID_ARGS（零写入）', () => {
  const identityKeys = ['tenant_id', 'actor_id', 'created_by_actor_id', 'id', 'created_at', 'record_version', 'superseded_by_constraint_id']
  for (const key of identityKeys) {
    const error = captureError(() => parseToolArgs({
      action: 'PIN', candidate_id: CANDIDATE, text: 'x', source: 'CHAT', [key]: 'evil',
    }))
    assert.equal(errorBody(error).code, 'INVALID_ARGS')
    assert.equal(errorBody(error).reason_code, 'SERVER_DERIVED_REJECTED', `${key} 必须是 SERVER_DERIVED_REJECTED`)
  }
  const unknown = captureError(() => parseToolArgs({
    action: 'PIN', candidate_id: CANDIDATE, text: 'x', source: 'CHAT', evil: 1,
  }))
  assert.equal(errorBody(unknown).reason_code, 'UNKNOWN_PARAM')
  const badSource = captureError(() => parseToolArgs({
    action: 'HANDOFF', candidate_id: CANDIDATE, text: 'x', source: 'EMAIL', interview_id: INTERVIEW,
  }))
  assert.equal(errorBody(badSource).reason_code, 'ENUM_INVALID')
})

// ---------------------------------------------------------------------------
//  3. 事务核心：labels 三轴 + 审计事件 + 幂等 no-op
// ---------------------------------------------------------------------------

test('recordCandidateConstraintInTransaction：labels 三轴齐全，经 buildThreeAxisLabels（假 client）', async () => {
  // 查询顺序：provenance → 我的 resolveCandidateId（出参用）→ recordConstraint 内的
  //          resolveCandidateId → PIN 幂等 select → INSERT → 审计 event_inbox → 出参读回。
  const { client, calls } = fakeClient([
    { rows: [{ tenant_exists: true, demo: null, synthetic: 'false' }] },
    { rows: [{ id: CANDIDATE }] },
    { rows: [{ id: CANDIDATE }] },
    { rows: [] },
    { rows: [{ id: CONSTRAINT_ID }] },
    { rows: [{ event_id: CONSTRAINT_ID }] },
    { rows: [{ created_by_actor_id: ACTOR, created_at: '2026-01-02T00:00:00.000Z' }] },
  ])
  const value = await recordCandidateConstraintInTransaction(
    client,
    { database: FAKE_CONFIG },
    ACTOR,
    { action: 'PIN', candidate_id: CANDIDATE, text: '不要加班', source: 'CHAT' },
  )
  assert.deepEqual(value.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
  assert.equal(value.action, 'PIN')
  assert.equal(value.inserted, true)
  assert.equal(value.created_by, ACTOR)
  assert.ok(calls.some((call) => call.sql.includes('event_inbox')), '必须写一条审计事件')
})

test('recordCandidateConstraintInTransaction：幂等 no-op 不写第二条审计事件', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ tenant_exists: false, demo: null, synthetic: null }] },
    { rows: [{ id: CANDIDATE }] },
    { rows: [{ id: CANDIDATE }] },
    { rows: [ccRow({ id: CONSTRAINT_ID, text: '不要加班', source: 'CHAT' })] },
    { rows: [{ created_by_actor_id: ACTOR, created_at: '2026-01-01T00:00:00.000Z' }] },
  ])
  const value = await recordCandidateConstraintInTransaction(
    client,
    { database: FAKE_CONFIG },
    ACTOR,
    { action: 'PIN', candidate_id: CANDIDATE, text: '不要加班', source: 'CHAT' },
  )
  assert.equal(value.inserted, false)
  assert.equal(value.labels.provenance, 'FIXTURE')
  assert.equal(calls.filter((call) => call.sql.includes('event_inbox')).length, 0, '幂等 no-op 不写审计事件')
})

// ---------------------------------------------------------------------------
//  4. render：短号 + 机器参数区
// ---------------------------------------------------------------------------

test('render：人读正文只给短号；完整 UUID 只在 machine arguments 区', () => {
  const blocks = renderCandidateConstraintValue({}, {
    tool: CANDIDATE_CONSTRAINT_TOOL,
    contract_version: CONTRACT_VERSION,
    action: 'PIN',
    candidate_id: CANDIDATE,
    constraint_id: CONSTRAINT_ID,
    superseded_id: '',
    inserted: true,
    text: '不要加班',
    source: 'CHAT',
    created_by: ACTOR,
    created_at: '2026-01-01T00:00:00.000Z',
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
  })
  const text = blocks.map((block) => block.text).join('\n')
  assert.match(text, /recruitment_candidate_constraint/)
  assert.match(text, /candidate: …0001/)
  assert.match(text, /constraint: …0001/)
  const header = blocks.map((b) => b.text).join('\n').split('\n')
    .find((line) => line.startsWith('machine arguments'))
  assert.ok(header, '必须有 machine arguments 区')
  assert.match(header, /never show ids or hashes to the human/)
  assert.ok(text.includes(`  candidate_id=${CANDIDATE}`))
  assert.ok(text.includes(`  constraint_id=${CONSTRAINT_ID}`))
  const human = text.slice(0, text.indexOf('machine arguments'))
  assert.ok(!human.includes(CANDIDATE), '人读正文不能出现完整 candidate UUID')
  assert.ok(!human.includes(CONSTRAINT_ID), '人读正文不能出现完整 constraint UUID')
})

// ---------------------------------------------------------------------------
//  5. 读投影 1：toApplicationValue 的 constraints 段
// ---------------------------------------------------------------------------

test('toCandidateConstraintsValue：pins 排序 + 墓碑过滤 + handoff 短号（不吐 UUID）', () => {
  const older = ccRow({ id: 'a'.repeat(36), text: '先做 A', created_at: '2026-01-02T00:00:00Z' })
  const newer = ccRow({ id: 'b'.repeat(36), text: '再做 B', created_at: '2026-01-01T00:00:00Z' })
  const tombstone = ccRow({ id: 'c'.repeat(36), text: UNPIN_TOMBSTONE_TEXT, created_at: '2026-01-03T00:00:00Z' })
  const handoff = ccRow({
    id: 'd'.repeat(36), kind: 'HANDOFF', text: '上一轮问到分片重放', interview_id: INTERVIEW,
    created_at: '2026-01-04T00:00:00Z',
  })
  const value = toCandidateConstraintsValue([newer, older, tombstone], [handoff])
  assert.deepEqual(value.pins.map((p) => p.text), ['再做 B', '先做 A'])
  assert.deepEqual(Object.keys(value.pins[0]).sort(), ['created_at', 'created_by', 'source', 'text'])
  assert.equal(value.handoffs.length, 1)
  assert.equal(value.handoffs[0].from_previous_round, true)
  assert.equal(value.handoffs[0].text, '上一轮问到分片重放')
  assert.equal(value.handoffs[0].interview_ref, '…0001')
  assert.ok(!JSON.stringify(value).includes(INTERVIEW), '结构化输出不能出现完整 interview UUID')
})

test('toApplicationValue：constraints 段恒给出（pins/handoffs），空时均为 []', () => {
  const appRow = {
    id: APPLICATION,
    current_stage_code: 'S6',
    lifecycle_status: 'ACTIVE',
    record_version: 1,
    applied_at: null,
    stage_entered_at: null,
    candidate_id: CANDIDATE,
    display_name: '测试候选人',
    identity_status: 'ACTIVE',
    normalized_email: null,
    normalized_phone: null,
    job_id: '77777777-7777-4777-8777-000000000001',
    job_code: 'JOB-1',
    job_title: '后端',
    job_status: 'OPEN',
    job_version_id: '88888888-8888-4888-8888-000000000001',
    current_job_version_id: null,
    current_rubric_version_id: null,
    pinned_rubric_version_id: null,
    resume_version_id: null,
  } as never
  const constraints = toCandidateConstraintsValue(
    [ccRow({ id: 'a'.repeat(36), text: '不要加班' })],
    [],
  )
  const value = toApplicationValue(
    appRow, new Map(), new Map(), [], [], [], [], [], new Map(), [], constraints, false,
  )
  assert.deepEqual(value.constraints.pins.map((p) => p.text), ['不要加班'])
  assert.deepEqual(value.constraints.handoffs, [])
  const empty = toApplicationValue(
    appRow, new Map(), new Map(), [], [], [], [], [], new Map(), [],
    { pins: [], handoffs: [] }, false,
  )
  assert.deepEqual(empty.constraints, { pins: [], handoffs: [] })
})

// ---------------------------------------------------------------------------
//  6. 读投影 2：toInterviewRow 的 candidate_constraints 段
// ---------------------------------------------------------------------------

function fakeInterviewValue(): InterviewValue {
  return {
    id: INTERVIEW,
    application_id: APPLICATION,
    candidate_id: CANDIDATE,
    job_id: '77777777-7777-4777-8777-000000000001',
    round_no: 2,
    slot_code: 'DEFAULT',
    stage_code: 'INTERVIEW',
    status: 'SCHEDULED',
    record_version: 3,
    scheduled_start_at: '2026-11-10T02:00:00.000Z',
    scheduled_end_at: '2026-11-10T03:00:00.000Z',
    duration_minutes: 60,
    timezone: 'Asia/Shanghai',
    status_changed_at: '2026-11-01T00:00:00.000Z',
    is_overdue_start: false,
    interviewers: [{
      id: '99999999-9999-4999-8999-000000000001',
      actor_id: ACTOR,
      role_in_interview: 'INTERVIEWER',
      required_scorecard: true,
      scorecard: undefined,
    }],
    meeting_binding: { state: 'BOUND_ACTIVE', count: 0, bindings: [] },
    transcript: { state: 'MISSING', reason_code: 'CANONICAL_STATUS', no_transcript: true },
    evaluation: {
      required_scorecards: 1, submitted: 0, waived: 0, pending: 1,
      evaluation_ready: false, blockers: [],
    },
    warnings: [],
  } as never
}

function fakeExtension(): InterviewExtensionRow {
  return {
    interview_id: INTERVIEW,
    application_id: APPLICATION,
    candidate_id: CANDIDATE,
    application_job_id: '77777777-7777-4777-8777-000000000001',
    candidate_display_name: '测试候选人',
    job_code: 'JOB-1',
    job_title: '后端',
    template_version_id: null,
    template_objective: null,
    template_briefing_summary: null,
    template_focus: [],
    template_questions: [],
    template_payload_hash: null,
    pinned_rubric_version_id: null,
    rubric_version_id: null,
    rubric_payload_hash: null,
    rubric_dimensions: [],
    resume_version_id: null,
    resume_parse_status: null,
    resume_parser_name: null,
    resume_parser_version: null,
    resume_content_sha256: null,
    resume_parsed_fields: null,
    scorecard_id: null,
    scorecard_record_version: null,
    scorecard_overall: null,
  }
}

test('toInterviewRow：candidate_constraints 含 pins + 本轮 handoff，brief 有「上一轮留给本轮的追问」', () => {
  const candidateConstraints: InterviewerCandidateConstraints = {
    pins: [
      { text: '先做 A', source: 'CHAT', created_by: ACTOR, created_at: '2026-01-02T00:00:00Z' },
      { text: '再做 B', source: 'CHAT', created_by: ACTOR, created_at: '2026-01-01T00:00:00Z' },
    ],
    handoff: {
      text: '上一轮问到分片重放，本轮接着问',
      source: 'WEIXIN',
      created_by: ACTOR,
      created_at: '2026-01-04T00:00:00Z',
      from_previous_round: true,
    },
  }
  const input: ToInterviewRowInput = {
    value: fakeInterviewValue(),
    extension: fakeExtension(),
    actorId: ACTOR,
    candidateConstraints,
  }
  const { row } = toInterviewRow(input)
  assert.deepEqual(row.candidate_constraints, candidateConstraints)
  assert.deepEqual(row.candidate_constraints.pins.map((p) => p.text), ['先做 A', '再做 B'])
  assert.equal(row.candidate_constraints.handoff?.from_previous_round, true)
  assert.ok(
    row.brief.questions.some((q) => q === '上一轮留给本轮的追问：上一轮问到分片重放，本轮接着问'),
    'brief.questions 必须含「上一轮留给本轮的追问：...」',
  )
})

test('toInterviewRow：无候选约束时 candidate_constraints 恒为 {pins:[],handoff:null}，brief 不变', () => {
  const input: ToInterviewRowInput = {
    value: fakeInterviewValue(),
    extension: fakeExtension(),
    actorId: ACTOR,
  }
  const { row } = toInterviewRow(input)
  assert.deepEqual(row.candidate_constraints, { pins: [], handoff: null })
  assert.deepEqual(row.brief.questions, [])
})
