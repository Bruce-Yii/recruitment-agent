// candidate_constraint 纯函数层单测（无 I/O，不连库）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONSTRAINT_ACTIONS,
  CONSTRAINT_KINDS,
  CONSTRAINT_SOURCES,
  MAX_CONSTRAINT_TEXT,
  UNPIN_TOMBSTONE_TEXT,
  isConstraintUuid,
  isIdempotentPin,
  parseCandidateConstraintArgs,
  toHandoffProjection,
  toPinProjection,
  type CandidateConstraintRow,
  type ConstraintKind,
  type ConstraintSource,
} from '../../src/domain/candidate-constraint.ts'

const CANDIDATE = '11111111-1111-4111-8111-000000000001'
const APPLICATION = '22222222-2222-4222-8222-000000000001'
const INTERVIEW = '33333333-3333-4333-8333-000000000001'
const ACTOR_A = '44444444-4444-4444-8444-000000000001'
const ACTOR_B = '44444444-4444-4444-8444-000000000002'

const PIN_BASE = {
  action: 'PIN',
  candidate_id: CANDIDATE,
  text: '  不要加班  ',
  source: 'CHAT',
} as const

const HANDOFF_BASE = {
  action: 'HANDOFF',
  application_id: APPLICATION,
  text: '候选人要求远程办公',
  source: 'WEIXIN',
  interview_id: INTERVIEW,
} as const

function row(overrides: Partial<CandidateConstraintRow> & { id: string; created_at: Date | string }): CandidateConstraintRow {
  return {
    tenant_id: '99999999-9999-4999-8999-000000000001',
    candidate_id: CANDIDATE,
    kind: 'PIN' as ConstraintKind,
    text: '置顶文本',
    source: 'CHAT' as ConstraintSource,
    application_id: null,
    interview_id: null,
    created_by_actor_id: ACTOR_A,
    superseded_by_constraint_id: null,
    record_version: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
//  1. 常量闭集
// ---------------------------------------------------------------------------

test('常量：CONSTRAINT_KINDS / SOURCES / ACTIONS / MAX / 墓碑文本 固定', () => {
  assert.deepEqual([...CONSTRAINT_KINDS], ['PIN', 'HANDOFF'])
  assert.deepEqual([...CONSTRAINT_SOURCES], ['CHAT', 'WEIXIN', 'PHONE', 'OTHER'])
  assert.deepEqual([...CONSTRAINT_ACTIONS], ['PIN', 'UNPIN', 'HANDOFF'])
  assert.equal(MAX_CONSTRAINT_TEXT, 500)
  assert.equal(UNPIN_TOMBSTONE_TEXT, '（已取消置顶）')
})

test('isConstraintUuid：合法/非法 UUID 形状', () => {
  assert.equal(isConstraintUuid(CANDIDATE), true)
  assert.equal(isConstraintUuid(CANDIDATE.toUpperCase()), true)
  assert.equal(isConstraintUuid('not-a-uuid'), false)
  assert.equal(isConstraintUuid(42), false)
})

// ---------------------------------------------------------------------------
//  2. parseCandidateConstraintArgs —— accept
// ---------------------------------------------------------------------------

test('parse：合法 PIN（candidate_id 定位）→ ok，text 已 btrim 归一化', () => {
  const result = parseCandidateConstraintArgs(PIN_BASE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, {
    action: 'PIN', candidate_id: CANDIDATE, text: '不要加班', source: 'CHAT',
  })
})

test('parse：合法 PIN（application_id 定位，两个都给）→ ok', () => {
  const result = parseCandidateConstraintArgs({ ...PIN_BASE, application_id: APPLICATION })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.candidate_id, CANDIDATE)
  assert.equal(result.value.application_id, APPLICATION)
})

test('parse：合法 HANDOFF（application_id + interview_id）→ ok', () => {
  const result = parseCandidateConstraintArgs(HANDOFF_BASE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.text, '候选人要求远程办公')
  assert.equal(result.value.interview_id, INTERVIEW)
})

test('parse：合法 UNPIN（只定位 + 可选 text/source）→ ok，不要求 interview_id', () => {
  const result = parseCandidateConstraintArgs({ action: 'UNPIN', candidate_id: CANDIDATE, text: '  不要加班  ', source: 'CHAT' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, { action: 'UNPIN', candidate_id: CANDIDATE, text: '不要加班', source: 'CHAT' })

  const minimal = parseCandidateConstraintArgs({ action: 'UNPIN', application_id: APPLICATION })
  assert.equal(minimal.ok, true)
})

test('parse：恰好 500 字的 text 接受', () => {
  const result = parseCandidateConstraintArgs({ ...PIN_BASE, text: 'x'.repeat(MAX_CONSTRAINT_TEXT) })
  assert.equal(result.ok, true)
})

// ---------------------------------------------------------------------------
//  3. parseCandidateConstraintArgs —— reject（全部 reason_code）
// ---------------------------------------------------------------------------

test('parse：非对象 / null / 数组 → TYPE_MISMATCH', () => {
  for (const raw of [undefined, null, 'x', 42, [], ['x']]) {
    const result = parseCandidateConstraintArgs(raw)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'TYPE_MISMATCH', `raw=${String(raw)}`)
  }
})

test('parse：服务端派生键（七个）逐一拒绝 → SERVER_DERIVED_REJECTED', () => {
  const derived = {
    tenant_id: APPLICATION,
    actor_id: APPLICATION,
    created_by_actor_id: APPLICATION,
    id: APPLICATION,
    created_at: '2026-01-01',
    record_version: 1,
    superseded_by_constraint_id: APPLICATION,
  }
  for (const key of Object.keys(derived)) {
    const result = parseCandidateConstraintArgs({ ...PIN_BASE, [key]: (derived as Record<string, unknown>)[key] })
    assert.equal(result.ok, false, `${key} 必须被拒`)
    if (result.ok) continue
    assert.equal(result.reason_code, 'SERVER_DERIVED_REJECTED')
    assert.match(result.message, new RegExp(key))
  }
})

test('parse：未知键 → UNKNOWN_PARAM', () => {
  const result = parseCandidateConstraintArgs({ ...PIN_BASE, surprise: 1 })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason_code, 'UNKNOWN_PARAM')
})

test('parse：action 缺失 → MISSING_REQUIRED；非法 → ENUM_INVALID', () => {
  const missing = parseCandidateConstraintArgs({ candidate_id: CANDIDATE, text: 'x', source: 'CHAT' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason_code, 'MISSING_REQUIRED')

  for (const action of ['DELETE', 'pin', '', 42]) {
    const result = parseCandidateConstraintArgs({ ...PIN_BASE, action })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'ENUM_INVALID', `action=${String(action)}`)
  }
  const nullAction = parseCandidateConstraintArgs({ ...PIN_BASE, action: null })
  assert.equal(nullAction.ok, false)
  if (!nullAction.ok) assert.equal(nullAction.reason_code, 'MISSING_REQUIRED', 'action=null 视为缺失')
})

test('parse：candidate_id 与 application_id 都缺 → MISSING_REQUIRED', () => {
  const result = parseCandidateConstraintArgs({ action: 'PIN', text: 'x', source: 'CHAT' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason_code, 'MISSING_REQUIRED')
})

test('parse：candidate_id / application_id 非法 UUID → ID_NOT_UUID', () => {
  for (const key of ['candidate_id', 'application_id'] as const) {
    const result = parseCandidateConstraintArgs({ ...PIN_BASE, [key]: 'not-a-uuid' })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'ID_NOT_UUID', `${key}`)
  }
})

test('parse：PIN/HANDOFF text 缺失/空/超长 → MISSING_REQUIRED / OUT_OF_RANGE', () => {
  for (const text of [undefined, null, '', '    ']) {
    const result = parseCandidateConstraintArgs({ ...PIN_BASE, text })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'MISSING_REQUIRED', `text=${String(text)}`)
  }
  const long = parseCandidateConstraintArgs({ ...PIN_BASE, text: 'x'.repeat(MAX_CONSTRAINT_TEXT + 1) })
  assert.equal(long.ok, false)
  if (!long.ok) assert.equal(long.reason_code, 'OUT_OF_RANGE')

  const wrongType = parseCandidateConstraintArgs({ ...PIN_BASE, text: 42 })
  assert.equal(wrongType.ok, false)
  if (!wrongType.ok) assert.equal(wrongType.reason_code, 'TYPE_MISMATCH')
})

test('parse：PIN/HANDOFF source 缺失/非法 → MISSING_REQUIRED / ENUM_INVALID', () => {
  const missing = parseCandidateConstraintArgs({ ...PIN_BASE, source: undefined })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason_code, 'MISSING_REQUIRED')

  for (const source of ['EMAIL', 'pin', 42]) {
    const result = parseCandidateConstraintArgs({ ...PIN_BASE, source })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'ENUM_INVALID', `source=${String(source)}`)
  }
})

test('parse：HANDOFF 缺 interview_id → MISSING_REQUIRED；非法 → ID_NOT_UUID', () => {
  const missing = parseCandidateConstraintArgs({ action: 'HANDOFF', candidate_id: CANDIDATE, text: 'x', source: 'CHAT' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason_code, 'MISSING_REQUIRED')

  const invalid = parseCandidateConstraintArgs({ ...HANDOFF_BASE, interview_id: 'bad' })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.reason_code, 'ID_NOT_UUID')
})

test('parse：PIN/UNPIN 若给 interview_id 也校验 UUID', () => {
  for (const action of ['PIN', 'UNPIN'] as const) {
    const result = parseCandidateConstraintArgs({ action, candidate_id: CANDIDATE, text: 'x', source: 'CHAT', interview_id: 'bad' })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'ID_NOT_UUID', `action=${action}`)
  }
})

// ---------------------------------------------------------------------------
//  4. isIdempotentPin
// ---------------------------------------------------------------------------

test('isIdempotentPin：同 text（含首尾空白差异）+ 同 source → true', () => {
  assert.equal(isIdempotentPin(' 不要加班 ', '不要加班', 'CHAT', 'CHAT'), true)
  assert.equal(isIdempotentPin('x', 'x', 'OTHER', 'OTHER'), true)
})

test('isIdempotentPin：text 或 source 不同 → false', () => {
  assert.equal(isIdempotentPin('甲', '乙', 'CHAT', 'CHAT'), false)
  assert.equal(isIdempotentPin('x', 'x', 'CHAT', 'WEIXIN'), false)
})

// ---------------------------------------------------------------------------
//  5. 读投影（过滤 superseded / 墓碑、排序、不吐 id）
// ---------------------------------------------------------------------------

test('toPinProjection：过滤 superseded 与墓碑、按 created_at asc 然后 id asc 排序、只吐四字段', () => {
  const rows: CandidateConstraintRow[] = [
    row({ id: 'b', created_at: '2026-01-02T00:00:00Z', text: '后' , created_by_actor_id: ACTOR_B }),
    row({ id: 'a', created_at: '2026-01-01T00:00:00Z', text: '先' }),
    row({ id: 'c', created_at: '2026-01-01T00:00:00Z', text: '同刻小 id 在前' }),
    row({ id: 'd', created_at: '2026-01-03T00:00:00Z', superseded_by_constraint_id: 'b' }),
    row({ id: 'e', created_at: '2026-01-04T00:00:00Z', text: UNPIN_TOMBSTONE_TEXT }),
    row({ id: 'f', created_at: '2026-01-05T00:00:00Z', kind: 'HANDOFF' }),
  ]
  const projected = toPinProjection(rows)
  assert.deepEqual(projected, [
    { text: '先', source: 'CHAT', created_by: ACTOR_A, created_at: '2026-01-01T00:00:00Z' },
    { text: '同刻小 id 在前', source: 'CHAT', created_by: ACTOR_A, created_at: '2026-01-01T00:00:00Z' },
    { text: '后', source: 'CHAT', created_by: ACTOR_B, created_at: '2026-01-02T00:00:00Z' },
  ])
  for (const item of projected) {
    assert.deepEqual(Object.keys(item).sort(), ['created_at', 'created_by', 'source', 'text'])
  }
})

test('toPinProjection：Date 类型的 created_at 转 ISO 字符串', () => {
  const projected = toPinProjection([row({ id: 'a', created_at: new Date('2026-05-06T07:08:09Z') })])
  assert.equal(projected[0].created_at, '2026-05-06T07:08:09.000Z')
})

test('toHandoffProjection：只取 HANDOFF 当前行、带 from_previous_round、不吐 id', () => {
  const rows: CandidateConstraintRow[] = [
    row({ id: 'h2', kind: 'HANDOFF', text: '交接二', interview_id: INTERVIEW, created_at: '2026-02-02T00:00:00Z' }),
    row({ id: 'h1', kind: 'HANDOFF', text: '交接一', interview_id: INTERVIEW, created_at: '2026-02-01T00:00:00Z', created_by_actor_id: ACTOR_B }),
    row({ id: 'x', kind: 'PIN', text: '不是交接', created_at: '2026-01-01T00:00:00Z' }),
    row({ id: 'y', kind: 'HANDOFF', text: '已取代', interview_id: INTERVIEW, created_at: '2026-01-01T00:00:00Z', superseded_by_constraint_id: 'h1' }),
  ]
  const projected = toHandoffProjection(rows)
  assert.deepEqual(projected, [
    { text: '交接一', source: 'CHAT', created_by: ACTOR_B, created_at: '2026-02-01T00:00:00Z', from_previous_round: true },
    { text: '交接二', source: 'CHAT', created_by: ACTOR_A, created_at: '2026-02-02T00:00:00Z', from_previous_round: true },
  ])
  for (const item of projected) {
    assert.equal(Object.hasOwn(item, 'id'), false)
    assert.equal(Object.hasOwn(item, 'interview_id'), false)
  }
})

test('读投影：空输入 → 空数组', () => {
  assert.deepEqual(toPinProjection([]), [])
  assert.deepEqual(toHandoffProjection([]), [])
})
