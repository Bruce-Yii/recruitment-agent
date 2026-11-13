// `parseScheduleArgs` 的纯函数矩阵（**不连库**）。
//
// 覆盖 `SPEC.md` §4.1 的全部拒绝路径 + §5.1 要求的默认值。
//
// 一条口径（`SPEC.md` §4.2 / 父代理 2026-11-13 的更正）：
//   `parseScheduleArgs` **只做形状/格式校验**，`START_IN_PAST` 属于 `scheduleInTransaction`
//   （必须在幂等 STORE 命中判定**之后**才判，否则同 key 同参的重放会因为时间已过被误判）。
//   所以这里**不**断言过去时间被拒，反而断言它形状合法；真正的 `START_IN_PAST` 由
//   `test/integration/interview-schedule.test.ts` 覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseScheduleArgs } from '../../src/tools/interview-schedule.ts'

const APP = '11111111-1111-4111-8111-000000000701'
const ACTOR = '11111111-1111-4111-8111-000000000104'
const ACTOR_2 = '11111111-1111-4111-8111-000000000102'
const NOW = Date.parse('2026-11-13T00:00:00Z')
const START = '2026-11-20T10:00:00+08:00'

let keyCounter = 0

/** 一份合法的 CREATE 入参（每次给一个新幂等键，避免跨用例耦合）。 */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  keyCounter += 1
  return {
    idempotency_key: `unit-${keyCounter}`,
    application_id: APP,
    round_no: 1,
    interviewers: [{ actor_id: ACTOR }],
    scheduled_start_at: START,
    duration_minutes: 60,
    ...overrides,
  }
}

/** 从 `Error: <CODE>: <compact-json>` 里取回 JSON 体（`tool-contracts.md` §1.2）。 */
function bodyOf(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  const json = index >= 0 ? message.slice(index + 2) : message
  return JSON.parse(json) as Record<string, unknown>
}

/** 断言抛的是 `INVALID_ARGS`，且 `reason_code` 逐字等于给定期望。 */
function expectInvalidArgs(run: () => unknown, reasonCode: string): void {
  assert.throws(run, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
    const body = bodyOf(error)
    assert.equal(body.code, 'INVALID_ARGS')
    assert.equal(body.reason_code, reasonCode)
    return true
  })
}

// ---------------------------------------------------------------------------
//  默认值
// ---------------------------------------------------------------------------

test('默认值：intent/slot_code/timezone/delivery_mode/面试官默认项 + 由 duration 推 end', () => {
  const args = parseScheduleArgs(base(), NOW)
  assert.equal(args.intent, 'CREATE')
  assert.equal(args.slot_code, 'DEFAULT')
  assert.equal(args.timezone, 'Asia/Shanghai')
  assert.equal(args.delivery_mode, 'VIDEO')
  assert.equal(args.round_no, 1)
  assert.equal(args.duration_minutes, 60)
  assert.equal(args.scheduled_start_at, '2026-11-20T02:00:00.000Z')
  assert.equal(args.scheduled_end_at, '2026-11-20T03:00:00.000Z')
  assert.equal(args.start_ms, Date.parse('2026-11-20T02:00:00.000Z'))
  assert.equal(args.end_ms - args.start_ms, 60 * 60_000)
  const interviewer = args.interviewers[0]
  assert.ok(interviewer !== undefined)
  assert.equal(interviewer.role_in_interview, 'INTERVIEWER')
  assert.equal(interviewer.required_scorecard, true)
  assert.equal(interviewer.scorecard_due_at, undefined)
  assert.equal(args.meeting, undefined)
  assert.match(args.args_digest, /^sha256:[0-9a-f]{64}$/)
})

test('treats offset forms: Z 也算带偏移；写入前统一成 Z 的 ISO', () => {
  const args = parseScheduleArgs(base({ scheduled_start_at: '2026-11-20T02:00:00Z' }), NOW)
  assert.equal(args.scheduled_start_at, '2026-11-20T02:00:00.000Z')
})

test('面试官显式项原样保留（role / required_scorecard / scorecard_due_at）', () => {
  const args = parseScheduleArgs(base({
    interviewers: [
      { actor_id: ACTOR, role_in_interview: 'SHADOW', required_scorecard: false, scorecard_due_at: '2026-11-21T10:00:00+08:00' },
      { actor_id: ACTOR_2.toUpperCase() },
    ],
  }), NOW)
  assert.equal(args.interviewers.length, 2)
  assert.equal(args.interviewers[0]?.role_in_interview, 'SHADOW')
  assert.equal(args.interviewers[0]?.required_scorecard, false)
  assert.equal(args.interviewers[0]?.scorecard_due_at, '2026-11-21T02:00:00.000Z')
  assert.equal(args.interviewers[1]?.actor_id, ACTOR_2)
})

test('meeting：默认 meeting_role=PRIMARY，两个 ID 可同时给', () => {
  const args = parseScheduleArgs(base({
    meeting: { provider: 'FEISHU', calendar_event_id: 'evt_1', external_meeting_id: 'meeting_1' },
  }), NOW)
  assert.ok(args.meeting !== undefined)
  assert.equal(args.meeting.meeting_role, 'PRIMARY')
  assert.equal(args.meeting.calendar_event_id, 'evt_1')
  assert.equal(args.meeting.external_meeting_id, 'meeting_1')
  assert.equal(args.meeting.account_scope, undefined)
})

test('args_digest：去掉 idempotency_key（同参不同键 → 同 digest；改 start → 变）', () => {
  const one = parseScheduleArgs(base({ idempotency_key: 'fixed-a' }), NOW)
  const two = parseScheduleArgs(base({ idempotency_key: 'fixed-b' }), NOW)
  assert.equal(one.args_digest, two.args_digest)
  const other = parseScheduleArgs(base({ idempotency_key: 'fixed-a', scheduled_start_at: '2026-11-20T14:00:00+08:00' }), NOW)
  assert.notEqual(one.args_digest, other.args_digest)
})

test('args_digest：默认值**不**补进 digest（显式写默认值 = 另一组参数）', () => {
  const omitted = parseScheduleArgs(base({ idempotency_key: 'fixed-c' }), NOW)
  const explicit = parseScheduleArgs(base({
    idempotency_key: 'fixed-c',
    intent: 'CREATE',
    slot_code: 'DEFAULT',
    timezone: 'Asia/Shanghai',
    delivery_mode: 'VIDEO',
  }), NOW)
  assert.notEqual(omitted.args_digest, explicit.args_digest)
})

test('过去时间**不在这里**拦（START_IN_PAST 属于 scheduleInTransaction，§4.2）', () => {
  const args = parseScheduleArgs(base({ scheduled_start_at: '2020-01-01T10:00:00+08:00' }), NOW)
  assert.equal(args.scheduled_start_at, '2020-01-01T02:00:00.000Z')
  // 与 now 相等也不拦：时点判定只在事务里、幂等 STORE 之后做。
  assert.equal(parseScheduleArgs(base({ scheduled_start_at: '2026-11-13T08:00:00+08:00' }), NOW)
    .scheduled_start_at, '2026-11-13T00:00:00.000Z')
})

// ---------------------------------------------------------------------------
//  形状：arguments 本身 / 未知键 / 身份键
// ---------------------------------------------------------------------------

test('arguments 不是对象 → TYPE_MISMATCH', () => {
  expectInvalidArgs(() => parseScheduleArgs([], NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseScheduleArgs('nope', NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseScheduleArgs(null, NOW), 'TYPE_MISMATCH')
})

test('未声明键 → UNKNOWN_PARAM（含 force / allow_conflict / skip_conflict_check / status / record_version / reason）', () => {
  for (const key of ['force', 'allow_conflict', 'skip_conflict_check', 'status', 'record_version', 'reason']) {
    expectInvalidArgs(() => parseScheduleArgs(base({ [key]: true }), NOW), 'UNKNOWN_PARAM')
  }
  expectInvalidArgs(() => parseScheduleArgs(base({ interviewer: [] }), NOW), 'UNKNOWN_PARAM')
})

test('tenant_id / actor_id → TENANT_OR_ACTOR_NOT_ALLOWED（不静默忽略）', () => {
  expectInvalidArgs(() => parseScheduleArgs(base({ tenant_id: APP }), NOW), 'TENANT_OR_ACTOR_NOT_ALLOWED')
  expectInvalidArgs(() => parseScheduleArgs(base({ actor_id: ACTOR }), NOW), 'TENANT_OR_ACTOR_NOT_ALLOWED')
})

// ---------------------------------------------------------------------------
//  必填 / 类型 / 格式
// ---------------------------------------------------------------------------

test('缺必填 → MISSING_REQUIRED', () => {
  for (const key of [
    'idempotency_key', 'application_id', 'round_no', 'interviewers', 'scheduled_start_at', 'duration_minutes',
  ]) {
    const raw = base()
    delete raw[key]
    expectInvalidArgs(() => parseScheduleArgs(raw, NOW), 'MISSING_REQUIRED')
  }
})

test('非 UUID → ID_NOT_UUID（application_id / 面试官 actor_id / 模板 id）', () => {
  expectInvalidArgs(() => parseScheduleArgs(base({ application_id: 'app_0001' }), NOW), 'ID_NOT_UUID')
  expectInvalidArgs(() => parseScheduleArgs(base({ interviewers: [{ actor_id: 'actor_1' }] }), NOW), 'ID_NOT_UUID')
  expectInvalidArgs(() => parseScheduleArgs(base({ interview_template_version_id: 'tpl_1' }), NOW), 'ID_NOT_UUID')
})

test('裸本地时间（无偏移）→ TIMESTAMP_WITHOUT_OFFSET', () => {
  expectInvalidArgs(
    () => parseScheduleArgs(base({ scheduled_start_at: '2026-11-20T10:00:00' }), NOW),
    'TIMESTAMP_WITHOUT_OFFSET',
  )
  expectInvalidArgs(
    () => parseScheduleArgs(base({ interviewers: [{ actor_id: ACTOR, scorecard_due_at: '2026-11-21T10:00:00' }] }), NOW),
    'TIMESTAMP_WITHOUT_OFFSET',
  )
})

test('round_no 越界 → OUT_OF_RANGE；非整数 → TYPE_MISMATCH', () => {
  expectInvalidArgs(() => parseScheduleArgs(base({ round_no: 0 }), NOW), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(base({ round_no: 21 }), NOW), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(base({ round_no: 1.5 }), NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseScheduleArgs(base({ round_no: '2' }), NOW), 'TYPE_MISMATCH')
})

test('duration_minutes 越界 → DURATION_OUT_OF_RANGE；非整数 → TYPE_MISMATCH', () => {
  expectInvalidArgs(() => parseScheduleArgs(base({ duration_minutes: 14 }), NOW), 'DURATION_OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(base({ duration_minutes: 481 }), NOW), 'DURATION_OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(base({ duration_minutes: 0 }), NOW), 'DURATION_OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(base({ duration_minutes: 60.5 }), NOW), 'TYPE_MISMATCH')
})

test('slot_code 不合正则 → SLOT_CODE_INVALID', () => {
  for (const slot of ['default', 'A', '1ABC', 'AB-C']) {
    expectInvalidArgs(() => parseScheduleArgs(base({ slot_code: slot }), NOW), 'SLOT_CODE_INVALID')
  }
  // 空串先被 args.ts 的"非空字符串"拦成 TYPE_MISMATCH，不是 SLOT_CODE_INVALID。
  expectInvalidArgs(() => parseScheduleArgs(base({ slot_code: '' }), NOW), 'TYPE_MISMATCH')
  // 合法边界：2 字符起、最长 21 字符
  assert.equal(parseScheduleArgs(base({ slot_code: 'AB' }), NOW).slot_code, 'AB')
  assert.equal(parseScheduleArgs(base({ slot_code: 'A'.repeat(21) }), NOW).slot_code, 'A'.repeat(21))
})

test('delivery_mode 非 VIDEO → UNSUPPORTED_DELIVERY_MODE', () => {
  for (const mode of ['ONSITE', 'PHONE', 'video']) {
    expectInvalidArgs(() => parseScheduleArgs(base({ delivery_mode: mode }), NOW), 'UNSUPPORTED_DELIVERY_MODE')
  }
})

test('intent 只接受 CREATE → OUT_OF_RANGE', () => {
  for (const intent of ['RESCHEDULE', 'CANCEL', 'WITHDRAW_INTERVIEWER', 'create']) {
    expectInvalidArgs(() => parseScheduleArgs(base({ intent }), NOW), 'OUT_OF_RANGE')
  }
  assert.equal(parseScheduleArgs(base({ intent: 'CREATE' }), NOW).intent, 'CREATE')
})

test('idempotency_key 字符集/长度非法 → OUT_OF_RANGE', () => {
  expectInvalidArgs(() => parseScheduleArgs(base({ idempotency_key: 'has space' }), NOW), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(base({ idempotency_key: 'has/slash' }), NOW), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(base({ idempotency_key: 'k'.repeat(201) }), NOW), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(base({ idempotency_key: '' }), NOW), 'TYPE_MISMATCH')
  // 合法字符集
  assert.equal(parseScheduleArgs(base({ idempotency_key: 'hire-42_r1:default.v1' }), NOW).idempotency_key,
    'hire-42_r1:default.v1')
})

// ---------------------------------------------------------------------------
//  interviewers
// ---------------------------------------------------------------------------

test('面试官空 / 缺 / 非数组 → INTERVIEWER_REQUIRED / TYPE_MISMATCH', () => {
  expectInvalidArgs(() => parseScheduleArgs(base({ interviewers: [] }), NOW), 'INTERVIEWER_REQUIRED')
  expectInvalidArgs(() => parseScheduleArgs(base({ interviewers: 'x' }), NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseScheduleArgs(base({ interviewers: [ACTOR] }), NOW), 'TYPE_MISMATCH')
})

test('面试官重复 actor_id → DUPLICATE_INTERVIEWER（大小写不同也算重复，不静默去重）', () => {
  expectInvalidArgs(
    () => parseScheduleArgs(base({ interviewers: [{ actor_id: ACTOR }, { actor_id: ACTOR }] }), NOW),
    'DUPLICATE_INTERVIEWER',
  )
  expectInvalidArgs(
    () => parseScheduleArgs(base({ interviewers: [{ actor_id: ACTOR }, { actor_id: ACTOR.toUpperCase() }] }), NOW),
    'DUPLICATE_INTERVIEWER',
  )
})

test('面试官元素缺 actor_id / 未知键 / 类型错', () => {
  expectInvalidArgs(() => parseScheduleArgs(base({ interviewers: [{}] }), NOW), 'MISSING_REQUIRED')
  expectInvalidArgs(
    () => parseScheduleArgs(base({ interviewers: [{ actor_id: ACTOR, display_name: 'x' }] }), NOW),
    'UNKNOWN_PARAM',
  )
  expectInvalidArgs(
    () => parseScheduleArgs(base({ interviewers: [{ actor_id: ACTOR, tenant_id: APP }] }), NOW),
    'TENANT_OR_ACTOR_NOT_ALLOWED',
  )
  expectInvalidArgs(
    () => parseScheduleArgs(base({ interviewers: [{ actor_id: ACTOR, required_scorecard: 'true' }] }), NOW),
    'TYPE_MISMATCH',
  )
  expectInvalidArgs(
    () => parseScheduleArgs(base({ interviewers: [{ actor_id: ACTOR, role_in_interview: 'lower' }] }), NOW),
    'OUT_OF_RANGE',
  )
})

// ---------------------------------------------------------------------------
//  meeting
// ---------------------------------------------------------------------------

test('meeting 无身份（两个 ID 都没给）→ MEETING_IDENTITY_REQUIRED', () => {
  expectInvalidArgs(
    () => parseScheduleArgs(base({ meeting: { provider: 'FEISHU' } }), NOW),
    'MEETING_IDENTITY_REQUIRED',
  )
})

test('meeting 缺 provider → MISSING_REQUIRED；非对象 → TYPE_MISMATCH', () => {
  expectInvalidArgs(
    () => parseScheduleArgs(base({ meeting: { calendar_event_id: 'evt_1' } }), NOW),
    'MISSING_REQUIRED',
  )
  expectInvalidArgs(() => parseScheduleArgs(base({ meeting: 'FEISHU' }), NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseScheduleArgs(base({ meeting: [] }), NOW), 'TYPE_MISMATCH')
})

test('meeting_role 给 REPLACED / CANCELLED → MEETING_ROLE_NOT_ALLOWED', () => {
  for (const role of ['REPLACED', 'CANCELLED']) {
    expectInvalidArgs(
      () => parseScheduleArgs(base({ meeting: { provider: 'FEISHU', calendar_event_id: 'evt_1', meeting_role: role } }), NOW),
      'MEETING_ROLE_NOT_ALLOWED',
    )
  }
  const ok = parseScheduleArgs(base({
    meeting: { provider: 'FEISHU', calendar_event_id: 'evt_1', meeting_role: 'CONTINUATION' },
  }), NOW)
  assert.equal(ok.meeting?.meeting_role, 'CONTINUATION')
})

test('meeting 未知键 / 超长字段 → UNKNOWN_PARAM / OUT_OF_RANGE', () => {
  expectInvalidArgs(
    () => parseScheduleArgs(base({ meeting: { provider: 'FEISHU', calendar_event_id: 'evt_1', external_id: 'x' } }), NOW),
    'UNKNOWN_PARAM',
  )
  expectInvalidArgs(
    () => parseScheduleArgs(base({ meeting: { provider: 'P'.repeat(65), calendar_event_id: 'evt_1' } }), NOW),
    'OUT_OF_RANGE',
  )
})

test('两条解析路径（parseScheduleArgs / 无 nowMs）结果一致', () => {
  const raw = base()
  const withNow = parseScheduleArgs(raw, NOW)
  const withoutNow = parseScheduleArgs(raw)
  assert.equal(withNow.args_digest, withoutNow.args_digest)
  assert.equal(withNow.scheduled_start_at, withoutNow.scheduled_start_at)
})
