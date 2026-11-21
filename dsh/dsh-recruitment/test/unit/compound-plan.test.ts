// 复合确认计划纯函数层单测（无 I/O，不连库，不 import 产品 index.ts）。
// 覆盖：parse 成功/拒绝、preflightShape 逐类校验、summarizeStep 人话三句、
//       fingerprintOf 确定性、边界。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPOUND_ACTIONS,
  fingerprintOf,
  parseCompoundPlan,
  preflightShape,
  summarizeStep,
  type CompoundPlan,
  type ParsedStep,
} from '../../src/domain/compound-plan.ts'

const APP = '11111111-1111-4111-8111-000000000001'
const INTERVIEW = '22222222-2222-4222-8222-000000000001'
const ACTOR_A = '33333333-3333-4333-8333-000000000001'
const ACTOR_B = '44444444-4444-4444-8444-000000000001'
const START = '2026-12-01T02:00:00.000Z'
const END = '2026-12-01T03:00:00.000Z'

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { confirmation_text: '确认执行以下操作？', steps: [], ...overrides }
}

function planOf(steps: readonly ParsedStep[], confirmationText = '确认执行以下操作？', previewOnly = false): CompoundPlan {
  return { steps, confirmation_text: confirmationText, preview_only: previewOnly }
}

function parsed(action: CompoundActionLike, args: Record<string, unknown> = {}, step = 0): ParsedStep {
  return { step, action, args }
}
type CompoundActionLike = ParsedStep['action']

function screeningArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { application_id: APP, result: 'PASS', reason: '证据充分', ...overrides }
}
function constraintArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { application_id: APP, kind: 'PIN', text: '不要加班', source: 'CHAT', ...overrides }
}
function scheduleArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { application_id: APP, intent: 'CREATE', scheduled_start_at: START, scheduled_end_at: END, ...overrides }
}

// ---------------------------------------------------------------------------
//  1. parseCompoundPlan —— 成功
// ---------------------------------------------------------------------------

test('COMPOUND_ACTIONS 闭集恰好三个且顺序固定', () => {
  assert.deepEqual([...COMPOUND_ACTIONS], ['screening_decide', 'candidate_constraint', 'interview_schedule'])
})

test('parse：三种合法 step 全部解析成功；args 去掉 action 键（浅拷贝）', () => {
  const result = parseCompoundPlan(raw({
    steps: [
      { action: 'screening_decide', ...screeningArgs() },
      { action: 'candidate_constraint', ...constraintArgs() },
      { action: 'interview_schedule', ...scheduleArgs() },
    ],
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.plan.steps.length, 3)
  assert.deepEqual(result.plan.confirmation_text, '确认执行以下操作？')
  assert.equal(result.plan.preview_only, false)
  assert.equal(result.plan.steps[0].step, 0)
  assert.equal(result.plan.steps[0].action, 'screening_decide')
  assert.deepEqual(result.plan.steps[0].args, screeningArgs())
  assert.equal(result.plan.steps[1].action, 'candidate_constraint')
  assert.deepEqual(result.plan.steps[1].args, constraintArgs())
  assert.equal(result.plan.steps[2].action, 'interview_schedule')
  assert.deepEqual(result.plan.steps[2].args, scheduleArgs())
  for (const s of result.plan.steps) assert.equal(Object.hasOwn(s.args, 'action'), false)
})

test('parse：preview_only 缺省当 false；preview_only:true 允许空确认文案', () => {
  const missing = parseCompoundPlan(raw({ confirmation_text: 'x', steps: [{ action: 'screening_decide', ...screeningArgs() }] }))
  assert.equal(missing.ok, true)
  if (missing.ok) assert.equal(missing.plan.preview_only, false)

  const preview = parseCompoundPlan(raw({ confirmation_text: '', preview_only: true, steps: [{ action: 'screening_decide', ...screeningArgs() }] }))
  assert.equal(preview.ok, true)
  if (preview.ok) {
    assert.equal(preview.plan.preview_only, true)
    assert.equal(preview.plan.confirmation_text, '')
  }
})

// ---------------------------------------------------------------------------
//  2. parseCompoundPlan —— 拒绝
// ---------------------------------------------------------------------------

test('parse：未知 action → UNSUPPORTED_STEP（preview_only=true 也拒）', () => {
  for (const previewOnly of [false, true]) {
    const result = parseCompoundPlan(raw({
      preview_only: previewOnly,
      steps: [{ action: 'email_send', to: 'x' }],
    }))
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.code, 'UNSUPPORTED_STEP')
    assert.equal(result.reason_code, 'UNSUPPORTED_STEP')
    assert.equal(result.step, 0)
    assert.match(result.message, /第 0 步/)
    assert.match(result.message, /暂不支持/)
  }
})

test('parse：raw 非对象 / null / 数组 → INVALID_ARGS TYPE_MISMATCH', () => {
  for (const bad of [undefined, null, 'x', 42, [], ['x']]) {
    const result = parseCompoundPlan(bad)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.code, 'INVALID_ARGS')
    assert.equal(result.reason_code, 'TYPE_MISMATCH')
  }
})

test('parse：steps 空 / 非数组 / 超 50 步 → INVALID_ARGS', () => {
  const empty = parseCompoundPlan(raw({ steps: [] }))
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.reason_code, 'STEPS_OUT_OF_RANGE')

  const notArray = parseCompoundPlan(raw({ steps: { action: 'x' } }))
  assert.equal(notArray.ok, false)
  if (!notArray.ok) assert.equal(notArray.reason_code, 'STEPS_NOT_ARRAY')

  const tooMany = parseCompoundPlan(raw({
    steps: Array.from({ length: 51 }, () => ({ action: 'screening_decide', ...screeningArgs() })),
  }))
  assert.equal(tooMany.ok, false)
  if (!tooMany.ok) assert.equal(tooMany.reason_code, 'STEPS_OUT_OF_RANGE')
})

test('parse：confirmation_text 缺失 / 非字符串 / 空串（非 preview）→ INVALID_ARGS', () => {
  const missing = parseCompoundPlan({ steps: [{ action: 'screening_decide', ...screeningArgs() }] })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason_code, 'MISSING_CONFIRMATION_TEXT')

  const wrongType = parseCompoundPlan(raw({ confirmation_text: 42, steps: [{ action: 'screening_decide', ...screeningArgs() }] }))
  assert.equal(wrongType.ok, false)
  if (!wrongType.ok) assert.equal(wrongType.reason_code, 'CONFIRMATION_TEXT_TYPE')

  const empty = parseCompoundPlan(raw({ confirmation_text: '', steps: [{ action: 'screening_decide', ...screeningArgs() }] }))
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.reason_code, 'EMPTY_CONFIRMATION_TEXT')
})

test('parse：preview_only 非布尔 → INVALID_ARGS', () => {
  const result = parseCompoundPlan(raw({ preview_only: 'yes', steps: [{ action: 'screening_decide', ...screeningArgs() }] }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason_code, 'PREVIEW_ONLY_TYPE')
})

test('parse：step 非对象 / 缺 action 字符串 → INVALID_ARGS', () => {
  const nonObject = parseCompoundPlan(raw({ steps: ['x', null] }))
  assert.equal(nonObject.ok, false)
  if (!nonObject.ok) assert.equal(nonObject.reason_code, 'STEP_TYPE_MISMATCH')

  const missingAction = parseCompoundPlan(raw({ steps: [{ application_id: APP }] }))
  assert.equal(missingAction.ok, false)
  if (!missingAction.ok) assert.equal(missingAction.reason_code, 'STEP_ACTION_MISSING')
})

// ---------------------------------------------------------------------------
//  3. preflightShape
// ---------------------------------------------------------------------------

test('preflightShape：三类全部合法 → 全 ok，blocked_reason 为空', () => {
  const plan = planOf([
    parsed('screening_decide', screeningArgs(), 0),
    parsed('candidate_constraint', constraintArgs(), 1),
    parsed('candidate_constraint', constraintArgs({ kind: 'HANDOFF', interview_id: INTERVIEW }), 2),
    parsed('interview_schedule', scheduleArgs(), 3),
    parsed('interview_schedule', scheduleArgs({ intent: 'CANCEL' }), 4),
    parsed('interview_schedule', scheduleArgs({ interviewer_actor_ids: [ACTOR_A, ACTOR_B] }), 5),
  ])
  const result = preflightShape(plan)
  assert.equal(result.length, 6)
  for (const r of result) {
    assert.equal(r.ok, true, `step ${r.step} 应 ok`)
    assert.equal(r.blocked_reason, '')
  }
})

test('preflightShape：screening_decide 缺字段/枚举错 → blocked + 人话原因', () => {
  const bad: readonly Record<string, unknown>[] = [
    { result: 'PASS', reason: 'x' },                                             // 缺 application_id
    screeningArgs({ application_id: 'bad', reason: 'x' }),
    screeningArgs({ result: 'MAYBE' }),
    screeningArgs({ reason: '' }),
    screeningArgs({ reason: 42 }),
  ]
  for (const args of bad) {
    const result = preflightShape(planOf([parsed('screening_decide', args)]))
    assert.equal(result[0].ok, false)
    assert.ok(result[0].blocked_reason.length > 0, '必须有中文原因')
    assert.match(result[0].blocked_reason, /[\u4e00-\u9fa5]/)
  }
})

test('preflightShape：candidate_constraint 缺字段/枚举错/超长 → blocked', () => {
  const cases: readonly Record<string, unknown>[] = [
    { kind: 'PIN', text: 'x', source: 'CHAT' },                                   // 缺 application_id
    constraintArgs({ application_id: 'bad' }),
    constraintArgs({ kind: 'BLOCK' }),
    constraintArgs({ text: '' }),
    constraintArgs({ text: 'x'.repeat(501) }),
    constraintArgs({ source: 'EMAIL' }),
    constraintArgs({ kind: 'HANDOFF' }),                                          // 缺 interview_id
    constraintArgs({ kind: 'HANDOFF', interview_id: 'bad' }),
  ]
  for (const args of cases) {
    const result = preflightShape(planOf([parsed('candidate_constraint', args)]))
    assert.equal(result[0].ok, false, `args=${JSON.stringify(args)} 应 blocked`)
    assert.match(result[0].blocked_reason, /[\u4e00-\u9fa5]/)
  }
})

test('preflightShape：interview_schedule 缺字段/枚举错/时间非法 → blocked', () => {
  const cases: readonly Record<string, unknown>[] = [
    { intent: 'CREATE' },                                                        // 缺 application_id
    scheduleArgs({ application_id: 'bad' }),
    scheduleArgs({ intent: 'DELETE' }),
    scheduleArgs({ scheduled_start_at: '2026-12-01 02:00:00' }),                 // 非 ISO-8601 带时区
    scheduleArgs({ scheduled_end_at: 'not-a-date' }),
    scheduleArgs({ scheduled_start_at: END, scheduled_end_at: START }),          // start >= end
    scheduleArgs({ interviewer_actor_ids: [ACTOR_A, 'bad'] }),
    scheduleArgs({ interviewer_actor_ids: 'not-array' }),
  ]
  for (const args of cases) {
    const result = preflightShape(planOf([parsed('interview_schedule', args)]))
    assert.equal(result[0].ok, false, `args=${JSON.stringify(args)} 应 blocked`)
    assert.match(result[0].blocked_reason, /[\u4e00-\u9fa5]/)
  }
})

test('preflightShape：CANCEL / WITHDRAW_INTERVIEWER 不要求时间；intent 缺省当 CREATE', () => {
  const cancel = preflightShape(planOf([parsed('interview_schedule', scheduleArgs({ intent: 'CANCEL' }))]))
  assert.equal(cancel[0].ok, true)
  const withdraw = preflightShape(planOf([parsed('interview_schedule', scheduleArgs({ intent: 'WITHDRAW_INTERVIEWER' }))]))
  assert.equal(withdraw[0].ok, true)
  const noIntent = preflightShape(planOf([parsed('interview_schedule', {
    application_id: APP, scheduled_start_at: START, scheduled_end_at: END,
  })]))
  assert.equal(noIntent[0].ok, true)
})

// ---------------------------------------------------------------------------
//  4. summarizeStep
// ---------------------------------------------------------------------------

test('summarizeStep：三类各返回三句非空中文，不含内部编号/字段名', () => {
  const samples: readonly ParsedStep[] = [
    parsed('screening_decide', screeningArgs({ result: 'HOLD' })),
    parsed('candidate_constraint', constraintArgs({ kind: 'HANDOFF' })),
    parsed('interview_schedule', scheduleArgs({ intent: 'RESCHEDULE' })),
  ]
  for (const s of samples) {
    const summary = summarizeStep(s)
    for (const key of ['will_do', 'affects', 'on_failure'] as const) {
      const value = summary[key]
      assert.equal(typeof value, 'string', `${key} 必须是字符串`)
      assert.ok(value.length > 0, `${key} 不能为空`)
      assert.match(value, /[\u4e00-\u9fa5]/, `${key} 必须有中文`)
    }
  }
  assert.ok(summarizeStep(samples[0]).will_do.includes('HOLD'))
  assert.ok(summarizeStep(samples[1]).will_do.includes('交接提醒'))
  assert.ok(summarizeStep(samples[2]).will_do.includes('改期'))
  const all = JSON.stringify(samples.map(summarizeStep))
  for (const token of [APP, INTERVIEW, 'sha256', 'application_id']) {
    assert.equal(all.includes(token), false, `摘要不能出现 ${token}`)
  }
})

// ---------------------------------------------------------------------------
//  5. fingerprintOf
// ---------------------------------------------------------------------------

test('fingerprintOf：同输入相同；64 位 hex', () => {
  const steps = [parsed('screening_decide', screeningArgs()), parsed('candidate_constraint', constraintArgs())]
  const a = fingerprintOf('确认？', steps)
  const b = fingerprintOf('确认？', [parsed('screening_decide', screeningArgs()), parsed('candidate_constraint', constraintArgs())])
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('fingerprintOf：步骤顺序不同 → 不同指纹；确认文本不同 → 不同指纹', () => {
  const s1 = parsed('screening_decide', screeningArgs(), 0)
  const s2 = parsed('candidate_constraint', constraintArgs(), 1)
  const base = fingerprintOf('确认？', [s1, s2])
  const reordered = fingerprintOf('确认？', [
    parsed('candidate_constraint', constraintArgs(), 0),
    parsed('screening_decide', screeningArgs(), 1),
  ])
  assert.notEqual(base, reordered)
  assert.notEqual(base, fingerprintOf('另一个确认文本', [s1, s2]))
})

test('fingerprintOf：args 键顺序不同仍相同（稳定序列化）', () => {
  const a = fingerprintOf('确认？', [parsed('screening_decide', { application_id: APP, result: 'PASS', reason: '证据充分' })])
  const b = fingerprintOf('确认？', [parsed('screening_decide', { reason: '证据充分', result: 'PASS', application_id: APP })])
  assert.equal(a, b)
})
