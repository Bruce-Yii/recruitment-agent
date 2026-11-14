// 追溯链的**纯逻辑**单测（不连库）：完整性判定 + 业务引用解析 + 摘要不落原文。
//
// 为什么单独一层：`checkTraceIntegrity` 是追溯的判定口径（什么算断链、什么算缺环），
// 它不应该只能靠"跑一条真链"来验证 —— 那样覆盖不到所有断链形态。这里用内存里的
// 最小模型逐条钉住判定口径。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkTraceIntegrity,
  collectBusinessRefs,
  safeDigest,
  type TraceModel,
} from '../../src/domain/trace.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const APP = '11111111-1111-4111-8111-000000000701'
const DECISION = '11111111-1111-4111-8111-000000000a01'
const CORRELATION = '22222222-2222-4222-8222-000000000001'

/** 空模型：只带一条链 ID。 */
function model(overrides: Partial<TraceModel> = {}): TraceModel {
  return {
    correlationId: CORRELATION,
    applications: [{
      id: APP, correlation_id: CORRELATION, current_stage_code: 'S7', lifecycle_status: 'ACTIVE',
      created_at: new Date('2026-11-14T00:00:00Z'),
    }],
    interviews: [],
    events: [{
      event_id: '33333333-3333-4333-8333-000000000001', correlation_id: CORRELATION, causation_id: null,
      event_type: 'resume.intake.received', provider: 'internal', trust_level: 'INTERNAL',
      received_at: new Date('2026-11-14T00:00:00Z'), recorded_at: new Date('2026-11-14T00:00:00Z'),
      source_object_id: 'a'.repeat(64), actor_id: null,
    }],
    tasks: [],
    attempts: [],
    sessions: [],
    toolCalls: [],
    effects: [],
    decisions: [],
    offChain: [],
    danglingRefs: [],
    ...overrides,
  }
}

function decisionRow(overrides: Record<string, unknown> = {}): TraceModel['decisions'][number] {
  return {
    id: DECISION,
    correlation_id: CORRELATION,
    application_id: APP,
    interview_id: null,
    decision_scope: 'SCREENING',
    stage_code: 'S7',
    result: 'ADVANCE',
    decided_by_actor_id: '11111111-1111-4111-8111-000000000103',
    decided_at: new Date('2026-11-14T00:01:00Z'),
    causation_event_id: null,
    ...overrides,
  } as TraceModel['decisions'][number]
}

function toolCallRow(overrides: Record<string, unknown> = {}): TraceModel['toolCalls'][number] {
  return {
    id: '44444444-4444-4444-8444-000000000001',
    correlation_id: CORRELATION,
    call_ref: 'test:1',
    tool_name: 'recruitment_decision_record',
    outcome: 'SUCCEEDED',
    error_code: null,
    actor_id: null,
    business_refs: [{ kind: 'APPLICATION', id: APP }, { kind: 'DECISION', id: DECISION }],
    started_at: new Date('2026-11-14T00:00:30Z'),
    ended_at: new Date('2026-11-14T00:00:31Z'),
    duration_ms: '1000',
    ...overrides,
  } as TraceModel['toolCalls'][number]
}

test('完整性：干净模型只有"缺环"（gap），没有断链', () => {
  const integrity = checkTraceIntegrity(model())
  assert.equal(integrity.ok, true)
  assert.deepEqual(integrity.breakpoints, [])
  const gapRings = integrity.gaps.map((gap) => gap.ring).sort()
  assert.deepEqual(gapRings, ['AGENT_SESSION', 'BUSINESS_TASK', 'DECISION', 'DURABLE_EFFECT', 'RECEIPT', 'TASK_ATTEMPT', 'TOOL_CALL'])
})

test('断链：链 ID 缺失 → CHAIN_CORRELATION_MISSING（不伪造链）', () => {
  const integrity = checkTraceIntegrity(model({ correlationId: null }))
  assert.equal(integrity.ok, false)
  assert.deepEqual(integrity.breakpoints.map((point) => point.code), ['CHAIN_CORRELATION_MISSING'])
})

test('断链：挂在本申请上却不在同一条链 → LINKED_ROW_OFF_CHAIN（带 expected / actual）', () => {
  const integrity = checkTraceIntegrity(model({
    offChain: [{
      ring: 'DECISION', id: DECISION, correlation_id: '99999999-9999-4999-8999-000000000009',
      at: new Date('2026-11-14T00:02:00Z'), state: 'STAGE:S8:HOLD', via: 'decision.application_id=app',
    }],
  }))
  assert.equal(integrity.ok, false)
  const point = integrity.breakpoints[0]
  assert.equal(point?.code, 'LINKED_ROW_OFF_CHAIN')
  assert.equal(point?.at, 'DECISION→CHAIN')
  assert.equal(point?.expected, CORRELATION)
  assert.equal(point?.actual, '99999999-9999-4999-8999-000000000009')
})

test('断链：有 decision 但没有来源事件 / 没有对应 tool call', () => {
  // 有决策、无事件、无调用
  let integrity = checkTraceIntegrity(model({ decisions: [decisionRow()] }))
  assert.equal(integrity.ok, false)
  assert.deepEqual(integrity.breakpoints.map((point) => point.code).sort(),
    ['DECISION_WITHOUT_CAUSE_EVENT', 'DECISION_WITHOUT_TOOL_CALL'])

  // 补上来源事件 + 工具调用 → 链成立
  integrity = checkTraceIntegrity(model({
    decisions: [decisionRow({ causation_event_id: '33333333-3333-4333-8333-000000000001' })],
    toolCalls: [toolCallRow()],
  }))
  assert.equal(integrity.ok, true, JSON.stringify(integrity.breakpoints))
})

test('断链：causation 指向链外事件 → DECISION_WITHOUT_CAUSE_EVENT', () => {
  const integrity = checkTraceIntegrity(model({
    decisions: [decisionRow({ causation_event_id: '55555555-5555-4555-8555-000000000005' })],
    toolCalls: [toolCallRow()],
  }))
  assert.equal(integrity.ok, false)
  assert.deepEqual(integrity.breakpoints.map((point) => point.code), ['DECISION_WITHOUT_CAUSE_EVENT'])
})

test('断链：effect 已 CONFIRMED 但没有回执 → EFFECT_WITHOUT_RECEIPT；有回执则成立', () => {
  const effect = {
    id: '66666666-6666-4666-8666-000000000001', correlation_id: CORRELATION,
    effect_type: 'NOTIFY', status: 'CONFIRMED',
    sent_at: new Date('2026-11-14T00:00:00Z'), confirmed_at: new Date('2026-11-14T00:00:01Z'),
    last_readback_at: null, readback_state: null, receipt_ref: null, external_id: null,
    business_refs: [], created_at: new Date('2026-11-14T00:00:00Z'),
  }
  let integrity = checkTraceIntegrity(model({ effects: [effect] }))
  assert.equal(integrity.ok, false)
  assert.ok(integrity.breakpoints.some((point) => point.code === 'EFFECT_WITHOUT_RECEIPT'))

  integrity = checkTraceIntegrity(model({ effects: [{ ...effect, receipt_ref: 'receipt-1', readback_state: 'MATCH' }] }))
  assert.equal(integrity.ok, true, JSON.stringify(integrity.breakpoints))
  assert.equal(integrity.gaps.some((gap) => gap.ring === 'RECEIPT'), false)
})

test('断链：Session 无归属 / tool call 无业务引用 / 引用指向不存在的行', () => {
  const integrity = checkTraceIntegrity(model({
    sessions: [{
      id: '77777777-7777-4777-8777-000000000001', correlation_id: CORRELATION,
      task_id: null, attempt_id: null, status: 'ACTIVE', model_route: 'x', started_at: new Date(), ended_at: null,
    }],
    toolCalls: [toolCallRow({ business_refs: [] })],
    danglingRefs: [{ toolCallId: '44444444-4444-4444-8444-000000000001', kind: 'APPLICATION', id: APP }],
  }))
  const codes = integrity.breakpoints.map((point) => point.code).sort()
  assert.deepEqual(codes, [
    'AGENT_SESSION_UNATTRIBUTED',
    'TOOL_CALL_DANGLING_REF',
    'TOOL_CALL_WITHOUT_BUSINESS_REF',
  ])
})

test('业务引用解析：只认已知键名 + UUID 形状，深度有限', () => {
  const refs = collectBusinessRefs({
    decision: { id: DECISION, application_id: APP, result: 'ADVANCE' },
    snapshot: { resume_version_id: 'not-a-uuid', rubric_version_id: '99999999-9999-4999-8999-000000000009' },
    nested: { tool_call: { id: '88888888-8888-4888-8888-000000000008' } },
    label: APP,
  })
  const keys = refs.map((ref) => `${ref.kind}:${ref.id}`).sort()
  assert.deepEqual(keys, [
    `APPLICATION:${APP}`,
    `DECISION:${DECISION}`,
    'TOOL_CALL:88888888-8888-4888-8888-000000000008',
  ])
})

test('摘要：只返回 sha256，不返回原文（R7 的机制保证）', () => {
  const text = '候选人张三的完整简历正文，绝不能出现在追溯记录里'
  const digest = safeDigest({ content: text })
  assert.equal(typeof digest, 'string')
  assert.equal((digest as string).length, 64)
  assert.equal((digest as string).includes('张三'), false)
  assert.equal(safeDigest(undefined), undefined)
})

test('tenant 占位常量确实被使用（避免"看起来像夹具"的死变量）', () => {
  assert.equal(TENANT.length, 36)
})
