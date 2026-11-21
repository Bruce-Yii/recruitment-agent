// 撤销域纯逻辑单测（不连库）：precheckUndo 四道判定 + planCompensation 两条补偿路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  UNDO_WINDOW_MS,
  precheckUndo,
  planCompensation,
  type UndoPrecheckInput,
  type UndoTargetRef,
  type UndoPlan,
} from '../../src/domain/undo.ts'

const NOW_MS = Date.parse('2026-11-19T00:05:00.000Z')
const OCCURRED = '2026-11-19T00:00:00.000Z'
const ACTOR = '11111111-1111-4111-8111-0000000000a1'
const ACTION_ID = '11111111-1111-4111-8111-0000000000b1'
const APP_ID = '11111111-1111-4111-8111-0000000000c1'
const DECISION_ID = '11111111-1111-4111-8111-0000000000d1'
const INTERVIEW_ID = '11111111-1111-4111-8111-0000000000e1'
const CONFIRM_TEXT = '我确认撤销刚才的决定。'

function baseInput(overrides: Partial<UndoPrecheckInput> = {}): UndoPrecheckInput {
  return {
    tenant_id: '11111111-1111-4111-8111-000000000001',
    actor_id: ACTOR,
    action_id: ACTION_ID,
    action_type: 'DECISION',
    occurred_at: OCCURRED,
    actor_id_of_action: ACTOR,
    compensation_action_id: null,
    superseded_by_action_id: null,
    now_ms: NOW_MS,
    ...overrides,
  }
}

function baseTarget(overrides: Partial<UndoTargetRef> = {}): UndoTargetRef {
  return {
    application_id: APP_ID,
    decision_id: DECISION_ID,
    decision_scope: 'SCREENING',
    reason: '误判了候选人材料',
    confirmation_text: CONFIRM_TEXT,
    ...overrides,
  }
}

// ---------------------------------------------------------------- precheckUndo

test('precheckUndo: 恰好 5min 边界放行', () => {
  const r = precheckUndo(baseInput({ now_ms: Date.parse(OCCURRED) + UNDO_WINDOW_MS }))
  assert.deepEqual(r, { ok: true, target: 'DECISION' })
})

test('precheckUndo: 5min+1ms 拒绝 UNDO_WINDOW_EXPIRED', () => {
  const r = precheckUndo(baseInput({ now_ms: Date.parse(OCCURRED) + UNDO_WINDOW_MS + 1 }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'UNDO_WINDOW_EXPIRED')
})

test('precheckUndo: occurred_at 在未来（负 elapsed）fail-closed 拒绝', () => {
  const r = precheckUndo(baseInput({ occurred_at: '2026-11-19T00:06:00.000Z', now_ms: NOW_MS }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'UNDO_WINDOW_EXPIRED')
})

test('precheckUndo: 时间解析失败 fail-closed 拒绝', () => {
  const r = precheckUndo(baseInput({ occurred_at: 'not-a-date' }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'UNDO_WINDOW_EXPIRED')
})

test('precheckUndo: Date 对象形式的时间也能解析', () => {
  const r = precheckUndo(baseInput({ occurred_at: new Date(OCCURRED) }))
  assert.deepEqual(r, { ok: true, target: 'DECISION' })
})

test('precheckUndo: 第二次撤销 ALREADY_UNDONE 优先于时间与越权判定', () => {
  const r = precheckUndo(baseInput({
    compensation_action_id: '11111111-1111-4111-8111-0000000000f1',
    // 同时越权 + 过期 + superseded：幂等必须排第一
    actor_id: 'different-actor',
    occurred_at: '2020-01-01T00:00:00.000Z',
    superseded_by_action_id: '11111111-1111-4111-8111-0000000000a2',
  }))
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, 'ALREADY_UNDONE')
    assert.equal(r.detail?.compensation_action_id, '11111111-1111-4111-8111-0000000000f1')
  }
})

test('precheckUndo: actor 不匹配', () => {
  const r = precheckUndo(baseInput({ actor_id: '11111111-1111-4111-8111-0000000000a2' }))
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, 'ACTOR_MISMATCH')
    assert.equal(r.detail?.actual_actor_id, '11111111-1111-4111-8111-0000000000a2')
  }
})

test('precheckUndo: superseded_by_action_id 非空', () => {
  const r = precheckUndo(baseInput({ superseded_by_action_id: '11111111-1111-4111-8111-0000000000a3' }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'UNDO_SUPERSEDED')
})

test('precheckUndo: 判定顺序 ACTOR_MISMATCH 优先于 SUPERSEDED 与 EXPIRED', () => {
  const r = precheckUndo(baseInput({
    actor_id: 'wrong-actor',
    superseded_by_action_id: 'later-action',
    occurred_at: '2020-01-01T00:00:00.000Z',
  }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'ACTOR_MISMATCH')
})

test('precheckUndo: 判定顺序 SUPERSEDED 优先于 EXPIRED', () => {
  const r = precheckUndo(baseInput({
    superseded_by_action_id: 'later-action',
    occurred_at: '2020-01-01T00:00:00.000Z',
  }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'UNDO_SUPERSEDED')
})

test('precheckUndo: 空串占位与 null 等价（不触发幂等/superseded）', () => {
  const r = precheckUndo(baseInput({
    compensation_action_id: '',
    superseded_by_action_id: '',
  }))
  assert.deepEqual(r, { ok: true, target: 'DECISION' })
})

test('precheckUndo: 返回 target 跟随 action_type', () => {
  const r = precheckUndo(baseInput({ action_type: 'SCHEDULE' }))
  assert.deepEqual(r, { ok: true, target: 'SCHEDULE' })
})

// ------------------------------------------------------------ planCompensation

const NOW_ISO = '2026-11-19T00:05:00.000Z'

test('planCompensation DECISION: 产生 supersedes + SUPERSEDES basis ref 且字段自洽', () => {
  const plan = planCompensation(baseTarget(), 'DECISION', ACTOR, NOW_ISO)
  assert.equal(plan.kind, 'DECISION')
  assert.equal(plan.domain, 'recordDecisionInTransaction')
  if (plan.kind !== 'DECISION') return
  const a = plan.args
  assert.equal(a.application_id, APP_ID)
  assert.equal(a.decision_scope, 'SCREENING')
  assert.equal(a.as_of, NOW_ISO)
  assert.equal(a.result, 'WITHDRAW')
  assert.equal(a.reason, '撤销：误判了候选人材料')

  const supersedes = a.supersedes as { decision_id: string; reason: string; expected_record_version: number }
  assert.equal(supersedes.decision_id, DECISION_ID)
  assert.equal(supersedes.reason, a.reason)
  // 占位由 Owner 覆盖
  assert.equal(supersedes.expected_record_version, 0)

  const basis = a.basis_refs as Array<Record<string, unknown>>
  assert.equal(basis.length, 1)
  assert.equal(basis[0].kind, 'SUPERSEDES')
  assert.equal(basis[0].decision_id, supersedes.decision_id)
  assert.equal(basis[0].reason, supersedes.reason)
  assert.equal(basis[0].opened_by_actor_id, ACTOR)

  const hc = a.human_confirmation as Record<string, unknown>
  assert.equal(hc.confirmed_by_actor_id, ACTOR)
  assert.equal(hc.confirmed_at, NOW_ISO)
  assert.equal(hc.confirmation_method, 'IN_CHAT')
  assert.equal(hc.confirmation_text, CONFIRM_TEXT)
  assert.equal(
    hc.confirmation_text_sha256,
    createHash('sha256').update(CONFIRM_TEXT, 'utf8').digest('hex'),
  )
  assert.match(plan.note, /expected_record_version=0/)
})

test('planCompensation DECISION: STAGE scope 带 interview_id、不带保留键 stage_code', () => {
  const plan = planCompensation(
    baseTarget({ decision_scope: 'STAGE', decision_stage_code: 'S10', interview_id: INTERVIEW_ID }),
    'DECISION', ACTOR, NOW_ISO,
  )
  assert.equal(plan.kind, 'DECISION')
  if (plan.kind !== 'DECISION') return
  assert.equal(plan.args.interview_id, INTERVIEW_ID)
  assert.equal(Object.hasOwn(plan.args, 'stage_code'), false)
})

test('planCompensation SCHEDULE: intent=CANCEL、reason 带撤销前缀、无身份键', () => {
  const plan = planCompensation(
    baseTarget({ interview_id: INTERVIEW_ID }), 'SCHEDULE', ACTOR, NOW_ISO,
  )
  assert.equal(plan.kind, 'SCHEDULE')
  assert.equal(plan.domain, 'scheduleInTransaction')
  if (plan.kind !== 'SCHEDULE') return
  assert.equal(plan.args.intent, 'CANCEL')
  assert.equal(plan.args.interview_id, INTERVIEW_ID)
  assert.equal(plan.args.reason, '撤销：误判了候选人材料')
  assert.ok((plan.args.reason as string).length <= 500)
  assert.equal(plan.args.expected_record_version, 0)
  assert.match(plan.note, /expected_record_version=0/)
})

test('planCompensation: 已经是撤销前缀的 reason 不重复加前缀', () => {
  const plan: UndoPlan = planCompensation(
    baseTarget({ reason: '撤销：原本就带前缀' }), 'SCHEDULE', ACTOR, NOW_ISO,
  )
  assert.equal(plan.kind, 'SCHEDULE')
  if (plan.kind !== 'SCHEDULE') return
  assert.equal(plan.args.reason, '撤销：原本就带前缀')
})

test('planCompensation: 两条路径顶层 args 都不含 actor_id/tenant_id 等身份键', () => {
  const forbidden = ['actor_id', 'tenant_id', 'decided_by_actor_id', 'interviewer_id', 'submitted_at', 'decided_at', 'status']
  for (const kind of ['DECISION', 'SCHEDULE'] as const) {
    const plan = planCompensation(baseTarget({ interview_id: INTERVIEW_ID }), kind, ACTOR, NOW_ISO)
    for (const key of forbidden) {
      assert.equal(Object.hasOwn(plan.args, key), false, `${kind} args 不应含 ${key}`)
    }
  }
})
