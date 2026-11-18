// criterion_override 纯函数层单测（无 I/O，不连库）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  effectiveState,
  HUMAN_STATES,
  isIdempotentSameState,
  parseCriterionOverrideArgs,
  sha256Text,
} from '../../src/domain/criterion-override.ts'

const APP = '11111111-1111-4111-8111-000000000001'
const BASE = {
  application_id: APP,
  criterion_key: 'work_exists',
  human_state: 'PRESENT',
  confirmation_text: '确认：这条有对应。',
} as const

// ---------------------------------------------------------------------------
//  1. parseCriterionOverrideArgs —— accept
// ---------------------------------------------------------------------------

test('parse：最小合法入参（无 note / 无额外键）→ ok', () => {
  const result = parseCriterionOverrideArgs(BASE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, BASE)
})

test('parse：带 note + 非业务未知键（trace_id）→ ok，未知键被忽略', () => {
  const result = parseCriterionOverrideArgs({
    ...BASE,
    note: '简历第 2 页写了 2019-至今。',
    trace_id: 'abc',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.note, '简历第 2 页写了 2019-至今。')
  assert.equal('trace_id' in result.value, false)
})

test('parse：三种 human_state 全接受；HUMAN_STATES 闭集恰好三值', () => {
  assert.deepEqual([...HUMAN_STATES], ['PRESENT', 'ABSENT', 'UNREADABLE'])
  for (const human_state of HUMAN_STATES) {
    const result = parseCriterionOverrideArgs({ ...BASE, human_state })
    assert.equal(result.ok, true, `${human_state} 应被接受`)
  }
})

// ---------------------------------------------------------------------------
//  2. parseCriterionOverrideArgs —— reject（全部 reason_code）
// ---------------------------------------------------------------------------

test('parse：非对象 / null / 数组 → INVALID_ARGS', () => {
  for (const raw of [undefined, null, 'x', 42, [], ['x']]) {
    const result = parseCriterionOverrideArgs(raw)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'INVALID_ARGS', `raw=${String(raw)}`)
  }
})

test('parse：服务端派生字段（六个）逐一拒绝 → SERVER_DERIVED_REJECTED', () => {
  const derived = {
    actor_id: APP,
    tenant_id: APP,
    confirmation_text_sha256: 'a'.repeat(64),
    confirmation_method: 'IN_CHAT',
    record_version: 1,
    id: APP,
  }
  for (const key of Object.keys(derived)) {
    const result = parseCriterionOverrideArgs({ ...BASE, [key]: (derived as Record<string, unknown>)[key] })
    assert.equal(result.ok, false, `${key} 必须被拒`)
    if (result.ok) continue
    assert.equal(result.reason_code, 'SERVER_DERIVED_REJECTED')
    assert.match(result.message, new RegExp(key))
  }
})

test('parse：非法/缺失 application_id → INVALID_ARGS', () => {
  for (const application_id of [undefined, null, 'not-a-uuid', 123, '']) {
    const result = parseCriterionOverrideArgs({ ...BASE, application_id })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'INVALID_ARGS')
  }
})

test('parse：criterion_key 空 / 超 200 / 非字符串 → INVALID_ARGS', () => {
  for (const criterion_key of [undefined, '', '   ', 'a'.repeat(201), 42]) {
    const result = parseCriterionOverrideArgs({ ...BASE, criterion_key })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'INVALID_ARGS')
  }
})

test('parse：非法 human_state → INVALID_HUMAN_STATE', () => {
  for (const human_state of [undefined, 'MAYBE', 'present', '', 42]) {
    const result = parseCriterionOverrideArgs({ ...BASE, human_state })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'INVALID_HUMAN_STATE')
  }
})

test('parse：note 超 2000 → NOTE_TOO_LONG；非字符串 → INVALID_ARGS', () => {
  const long = parseCriterionOverrideArgs({ ...BASE, note: 'a'.repeat(2001) })
  assert.equal(long.ok, false)
  if (!long.ok) assert.equal(long.reason_code, 'NOTE_TOO_LONG')

  const wrongType = parseCriterionOverrideArgs({ ...BASE, note: 42 })
  assert.equal(wrongType.ok, false)
  if (!wrongType.ok) assert.equal(wrongType.reason_code, 'INVALID_ARGS')

  const exact = parseCriterionOverrideArgs({ ...BASE, note: 'a'.repeat(2000) })
  assert.equal(exact.ok, true, '恰好 2000 字应接受')
})

test('parse：confirmation_text 缺失 → MISSING_CONFIRMATION_TEXT；空/非字符串 → INVALID_CONFIRMATION_TEXT', () => {
  const missing = parseCriterionOverrideArgs({ application_id: APP, criterion_key: 'k', human_state: 'PRESENT' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason_code, 'MISSING_CONFIRMATION_TEXT')

  for (const confirmation_text of [null, '', 42]) {
    const result = parseCriterionOverrideArgs({ ...BASE, confirmation_text })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.reason_code, 'INVALID_CONFIRMATION_TEXT')
  }
})

// ---------------------------------------------------------------------------
//  3. sha256Text —— 已知向量
// ---------------------------------------------------------------------------

test('sha256Text：abc 的已知向量（原始 UTF-8 字节，小写 64 hex）', () => {
  assert.equal(
    sha256Text('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('sha256Text：空串 / 中文输入稳定且形状为 64 hex', () => {
  assert.equal(sha256Text(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.match(sha256Text('确认：有对应。'), /^[0-9a-f]{64}$/)
})

// ---------------------------------------------------------------------------
//  4. effectiveState —— 人优先
// ---------------------------------------------------------------------------

test('effectiveState：人覆盖（三态任一）优先于 AI 原判定', () => {
  for (const human of HUMAN_STATES) {
    assert.equal(effectiveState('AI_PRESENT', human), human)
  }
})

test('effectiveState：无人覆盖回落 AI；两者都空 → null', () => {
  assert.equal(effectiveState('AI_PRESENT', null), 'AI_PRESENT')
  assert.equal(effectiveState('AI_PRESENT', undefined), 'AI_PRESENT')
  assert.equal(effectiveState(null, null), null)
  assert.equal(effectiveState(undefined, undefined), null)
  assert.equal(effectiveState('', ''), '', '空串是有效值，不被当 null')
})

// ---------------------------------------------------------------------------
//  5. isIdempotentSameState —— note-only 语义
// ---------------------------------------------------------------------------

test('isIdempotentSameState：同三态 + 同 note（含 null/undefined 归一）→ true', () => {
  assert.equal(isIdempotentSameState('PRESENT', 'PRESENT', null, undefined), true)
  assert.equal(isIdempotentSameState('ABSENT', 'ABSENT', '理由', '理由'), true)
  assert.equal(isIdempotentSameState('PRESENT', 'PRESENT', '', null), true, 'note 的 null/undefined/空串等价')
})

test('isIdempotentSameState：三态不同或 note 不同 → false', () => {
  assert.equal(isIdempotentSameState('PRESENT', 'ABSENT', null, null), false)
  assert.equal(isIdempotentSameState('PRESENT', 'PRESENT', '旧理由', '新理由'), false)
  assert.equal(isIdempotentSameState(null, 'PRESENT', null, null), false)
  assert.equal(isIdempotentSameState(undefined, 'PRESENT', null, ''), false, '当前态缺失不算幂等')
})
