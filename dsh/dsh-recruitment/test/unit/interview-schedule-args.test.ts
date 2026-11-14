// `parseScheduleArgs` 的纯函数矩阵（**不连库**）。
//
// 覆盖 `SPEC.md` §4.1 的全部拒绝路径 + §5.1 要求的默认值；**四个 intent**（D-62）的入参表各一节。
//
// 一条口径（`SPEC.md` §4.2 / 父代理 2026-11-13 的更正）：
//   `parseScheduleArgs` **只做形状/格式校验**，`START_IN_PAST` 属于 `scheduleInTransaction`
//   （必须在幂等 STORE 命中判定**之后**才判，否则同 key 同参的重放会因为时间已过被误判）。
//   所以这里**不**断言过去时间被拒，反而断言它形状合法；真正的 `START_IN_PAST` 由
//   `test/integration/interview-schedule.test.ts` 覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseScheduleArgs } from '../../src/tools/interview-schedule.ts'
import type { CreateCommand } from '../../src/tools/interview-schedule.ts'

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

/**
 * 类型收窄：`CREATE` 形状（本文件前 2/3 的用例只关心 CREATE 的字段）。
 * 抛错的用例（非法 intent / 非对象）仍然在 `assert.equal` 之前就抛，行为不变。
 * @param raw - 模型入参。
 * @param nowMs - 服务端"现在"。
 * @returns 已补默认值的 CREATE 命令。
 */
function parseCreateArgsForTest(raw: unknown, nowMs?: number): CreateCommand {
  const args = parseScheduleArgs(raw, nowMs)
  assert.equal(args.intent, 'CREATE')
  return args as CreateCommand
}

// ---------------------------------------------------------------------------
//  默认值
// ---------------------------------------------------------------------------

test('默认值：intent/slot_code/timezone/delivery_mode/面试官默认项 + 由 duration 推 end', () => {
  const args = parseCreateArgsForTest(base(), NOW)
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
  const args = parseCreateArgsForTest(base({ scheduled_start_at: '2026-11-20T02:00:00Z' }), NOW)
  assert.equal(args.scheduled_start_at, '2026-11-20T02:00:00.000Z')
})

test('面试官显式项原样保留（role / required_scorecard / scorecard_due_at）', () => {
  const args = parseCreateArgsForTest(base({
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
  const args = parseCreateArgsForTest(base({
    meeting: { provider: 'FEISHU', calendar_event_id: 'evt_1', external_meeting_id: 'meeting_1' },
  }), NOW)
  assert.ok(args.meeting !== undefined)
  assert.equal(args.meeting.meeting_role, 'PRIMARY')
  assert.equal(args.meeting.calendar_event_id, 'evt_1')
  assert.equal(args.meeting.external_meeting_id, 'meeting_1')
  assert.equal(args.meeting.account_scope, undefined)
})

test('args_digest：去掉 idempotency_key（同参不同键 → 同 digest；改 start → 变）', () => {
  const one = parseCreateArgsForTest(base({ idempotency_key: 'fixed-a' }), NOW)
  const two = parseCreateArgsForTest(base({ idempotency_key: 'fixed-b' }), NOW)
  assert.equal(one.args_digest, two.args_digest)
  const other = parseCreateArgsForTest(base({ idempotency_key: 'fixed-a', scheduled_start_at: '2026-11-20T14:00:00+08:00' }), NOW)
  assert.notEqual(one.args_digest, other.args_digest)
})

test('args_digest：默认值**不**补进 digest（显式写默认值 = 另一组参数）', () => {
  const omitted = parseCreateArgsForTest(base({ idempotency_key: 'fixed-c' }), NOW)
  const explicit = parseCreateArgsForTest(base({
    idempotency_key: 'fixed-c',
    intent: 'CREATE',
    slot_code: 'DEFAULT',
    timezone: 'Asia/Shanghai',
    delivery_mode: 'VIDEO',
  }), NOW)
  assert.notEqual(omitted.args_digest, explicit.args_digest)
})

test('过去时间**不在这里**拦（START_IN_PAST 属于 scheduleInTransaction，§4.2）', () => {
  const args = parseCreateArgsForTest(base({ scheduled_start_at: '2020-01-01T10:00:00+08:00' }), NOW)
  assert.equal(args.scheduled_start_at, '2020-01-01T02:00:00.000Z')
  // 与 now 相等也不拦：时点判定只在事务里、幂等 STORE 之后做。
  assert.equal(parseCreateArgsForTest(base({ scheduled_start_at: '2026-11-13T08:00:00+08:00' }), NOW)
    .scheduled_start_at, '2026-11-13T00:00:00.000Z')
})

// ---------------------------------------------------------------------------
//  形状：arguments 本身 / 未知键 / 身份键
// ---------------------------------------------------------------------------

test('arguments 不是对象 → TYPE_MISMATCH', () => {
  expectInvalidArgs(() => parseCreateArgsForTest([], NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseCreateArgsForTest('nope', NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseCreateArgsForTest(null, NOW), 'TYPE_MISMATCH')
})

test('未声明键 → UNKNOWN_PARAM（含 force / allow_conflict / skip_conflict_check / status / record_version / reason）', () => {
  for (const key of ['force', 'allow_conflict', 'skip_conflict_check', 'status', 'record_version', 'reason']) {
    expectInvalidArgs(() => parseCreateArgsForTest(base({ [key]: true }), NOW), 'UNKNOWN_PARAM')
  }
  expectInvalidArgs(() => parseCreateArgsForTest(base({ interviewer: [] }), NOW), 'UNKNOWN_PARAM')
})

test('tenant_id / actor_id → TENANT_OR_ACTOR_NOT_ALLOWED（不静默忽略）', () => {
  expectInvalidArgs(() => parseCreateArgsForTest(base({ tenant_id: APP }), NOW), 'TENANT_OR_ACTOR_NOT_ALLOWED')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ actor_id: ACTOR }), NOW), 'TENANT_OR_ACTOR_NOT_ALLOWED')
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
    expectInvalidArgs(() => parseCreateArgsForTest(raw, NOW), 'MISSING_REQUIRED')
  }
})

test('非 UUID → ID_NOT_UUID（application_id / 面试官 actor_id / 模板 id）', () => {
  expectInvalidArgs(() => parseCreateArgsForTest(base({ application_id: 'app_0001' }), NOW), 'ID_NOT_UUID')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ interviewers: [{ actor_id: 'actor_1' }] }), NOW), 'ID_NOT_UUID')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ interview_template_version_id: 'tpl_1' }), NOW), 'ID_NOT_UUID')
})

test('裸本地时间（无偏移）→ TIMESTAMP_WITHOUT_OFFSET', () => {
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ scheduled_start_at: '2026-11-20T10:00:00' }), NOW),
    'TIMESTAMP_WITHOUT_OFFSET',
  )
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ interviewers: [{ actor_id: ACTOR, scorecard_due_at: '2026-11-21T10:00:00' }] }), NOW),
    'TIMESTAMP_WITHOUT_OFFSET',
  )
})

test('round_no 越界 → ROUND_OUT_OF_RANGE；非整数 → TYPE_MISMATCH', () => {
  expectInvalidArgs(() => parseCreateArgsForTest(base({ round_no: 0 }), NOW), 'ROUND_OUT_OF_RANGE')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ round_no: 21 }), NOW), 'ROUND_OUT_OF_RANGE')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ round_no: 1.5 }), NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ round_no: '2' }), NOW), 'TYPE_MISMATCH')
})

test('duration_minutes 越界 → DURATION_OUT_OF_RANGE；非整数 → TYPE_MISMATCH', () => {
  expectInvalidArgs(() => parseCreateArgsForTest(base({ duration_minutes: 14 }), NOW), 'DURATION_OUT_OF_RANGE')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ duration_minutes: 481 }), NOW), 'DURATION_OUT_OF_RANGE')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ duration_minutes: 0 }), NOW), 'DURATION_OUT_OF_RANGE')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ duration_minutes: 60.5 }), NOW), 'TYPE_MISMATCH')
})

test('slot_code 不合正则 → SLOT_CODE_INVALID', () => {
  for (const slot of ['default', 'A', '1ABC', 'AB-C']) {
    expectInvalidArgs(() => parseCreateArgsForTest(base({ slot_code: slot }), NOW), 'SLOT_CODE_INVALID')
  }
  // 空串先被 args.ts 的"非空字符串"拦成 TYPE_MISMATCH，不是 SLOT_CODE_INVALID。
  expectInvalidArgs(() => parseCreateArgsForTest(base({ slot_code: '' }), NOW), 'TYPE_MISMATCH')
  // 合法边界：2 字符起、最长 21 字符
  assert.equal(parseCreateArgsForTest(base({ slot_code: 'AB' }), NOW).slot_code, 'AB')
  assert.equal(parseCreateArgsForTest(base({ slot_code: 'A'.repeat(21) }), NOW).slot_code, 'A'.repeat(21))
})

test('delivery_mode 非 VIDEO → UNSUPPORTED_DELIVERY_MODE', () => {
  for (const mode of ['ONSITE', 'PHONE', 'video']) {
    expectInvalidArgs(() => parseCreateArgsForTest(base({ delivery_mode: mode }), NOW), 'UNSUPPORTED_DELIVERY_MODE')
  }
})

test('intent 闭集是四个（**没有 COMPLETE**）：未知取值 → OUT_OF_RANGE', () => {
  for (const intent of ['create', 'COMPLETE', 'WITHDRAW', 'CANCEL_']) {
    expectInvalidArgs(() => parseScheduleArgs(base({ intent }), NOW), 'OUT_OF_RANGE')
  }
  assert.equal(parseCreateArgsForTest(base({ intent: 'CREATE' }), NOW).intent, 'CREATE')
})

test('idempotency_key 字符集/长度非法 → OUT_OF_RANGE', () => {
  expectInvalidArgs(() => parseCreateArgsForTest(base({ idempotency_key: 'has space' }), NOW), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ idempotency_key: 'has/slash' }), NOW), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ idempotency_key: 'k'.repeat(201) }), NOW), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ idempotency_key: '' }), NOW), 'TYPE_MISMATCH')
  // 合法字符集
  assert.equal(parseCreateArgsForTest(base({ idempotency_key: 'hire-42_r1:default.v1' }), NOW).idempotency_key,
    'hire-42_r1:default.v1')
})

// ---------------------------------------------------------------------------
//  interviewers
// ---------------------------------------------------------------------------

test('面试官空 / 缺 / 非数组 → INTERVIEWER_REQUIRED / TYPE_MISMATCH', () => {
  expectInvalidArgs(() => parseCreateArgsForTest(base({ interviewers: [] }), NOW), 'INTERVIEWER_REQUIRED')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ interviewers: 'x' }), NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ interviewers: [ACTOR] }), NOW), 'TYPE_MISMATCH')
})

test('面试官重复 actor_id → DUPLICATE_INTERVIEWER（大小写不同也算重复，不静默去重）', () => {
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ interviewers: [{ actor_id: ACTOR }, { actor_id: ACTOR }] }), NOW),
    'DUPLICATE_INTERVIEWER',
  )
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ interviewers: [{ actor_id: ACTOR }, { actor_id: ACTOR.toUpperCase() }] }), NOW),
    'DUPLICATE_INTERVIEWER',
  )
})

test('面试官元素缺 actor_id / 未知键 / 类型错', () => {
  expectInvalidArgs(() => parseCreateArgsForTest(base({ interviewers: [{}] }), NOW), 'MISSING_REQUIRED')
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ interviewers: [{ actor_id: ACTOR, display_name: 'x' }] }), NOW),
    'UNKNOWN_PARAM',
  )
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ interviewers: [{ actor_id: ACTOR, tenant_id: APP }] }), NOW),
    'TENANT_OR_ACTOR_NOT_ALLOWED',
  )
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ interviewers: [{ actor_id: ACTOR, required_scorecard: 'true' }] }), NOW),
    'TYPE_MISMATCH',
  )
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ interviewers: [{ actor_id: ACTOR, role_in_interview: 'lower' }] }), NOW),
    'OUT_OF_RANGE',
  )
})

// ---------------------------------------------------------------------------
//  meeting
// ---------------------------------------------------------------------------

test('meeting 无身份（两个 ID 都没给）→ MEETING_IDENTITY_REQUIRED', () => {
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ meeting: { provider: 'FEISHU' } }), NOW),
    'MEETING_IDENTITY_REQUIRED',
  )
})

test('meeting 缺 provider → MISSING_REQUIRED；非对象 → TYPE_MISMATCH', () => {
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ meeting: { calendar_event_id: 'evt_1' } }), NOW),
    'MISSING_REQUIRED',
  )
  expectInvalidArgs(() => parseCreateArgsForTest(base({ meeting: 'FEISHU' }), NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseCreateArgsForTest(base({ meeting: [] }), NOW), 'TYPE_MISMATCH')
})

test('meeting_role 给 REPLACED / CANCELLED → MEETING_ROLE_NOT_ALLOWED', () => {
  for (const role of ['REPLACED', 'CANCELLED']) {
    expectInvalidArgs(
      () => parseCreateArgsForTest(base({ meeting: { provider: 'FEISHU', calendar_event_id: 'evt_1', meeting_role: role } }), NOW),
      'MEETING_ROLE_NOT_ALLOWED',
    )
  }
  const ok = parseCreateArgsForTest(base({
    meeting: { provider: 'FEISHU', calendar_event_id: 'evt_1', meeting_role: 'CONTINUATION' },
  }), NOW)
  assert.equal(ok.meeting?.meeting_role, 'CONTINUATION')
})

test('meeting 未知键 / 超长字段 → UNKNOWN_PARAM / OUT_OF_RANGE', () => {
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ meeting: { provider: 'FEISHU', calendar_event_id: 'evt_1', external_id: 'x' } }), NOW),
    'UNKNOWN_PARAM',
  )
  expectInvalidArgs(
    () => parseCreateArgsForTest(base({ meeting: { provider: 'P'.repeat(65), calendar_event_id: 'evt_1' } }), NOW),
    'OUT_OF_RANGE',
  )
})

test('两条解析路径（parseScheduleArgs / 无 nowMs）结果一致', () => {
  const raw = base()
  const withNow = parseCreateArgsForTest(raw, NOW)
  const withoutNow = parseCreateArgsForTest(raw)
  assert.equal(withNow.args_digest, withoutNow.args_digest)
  assert.equal(withNow.scheduled_start_at, withoutNow.scheduled_start_at)
})

// ---------------------------------------------------------------------------
//  四个 intent 的入参表（D-62 / `tool-contracts.md` §3.2）
//    `intent` 决定**整套**键集：跨 intent 的键一律 UNKNOWN_PARAM（不静默忽略）。
// ---------------------------------------------------------------------------

const INTERVIEW = '11111111-1111-4111-8111-000000000901'

/** 一份合法的 RESCHEDULE 入参（每次给一个新幂等键）。 */
function rescheduleBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  keyCounter += 1
  return {
    intent: 'RESCHEDULE',
    idempotency_key: `unit-${keyCounter}`,
    interview_id: INTERVIEW,
    expected_record_version: 3,
    scheduled_start_at: START,
    ...overrides,
  }
}

/** 一份合法的 CANCEL 入参。 */
function cancelBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  keyCounter += 1
  return {
    intent: 'CANCEL',
    idempotency_key: `unit-${keyCounter}`,
    interview_id: INTERVIEW,
    expected_record_version: 3,
    reason: '候选人改约',
    ...overrides,
  }
}

/** 一份合法的 WITHDRAW_INTERVIEWER 入参。 */
function withdrawBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  keyCounter += 1
  return {
    intent: 'WITHDRAW_INTERVIEWER',
    idempotency_key: `unit-${keyCounter}`,
    interviewer_id: ACTOR,
    expected_record_version: 3,
    reason: '面试官请假',
    ...overrides,
  }
}

test('RESCHEDULE 形状：id/版本规范化、只给 duration 时 start 缺省、两者都不给 → NO_CHANGE', () => {
  const both = parseScheduleArgs(rescheduleBase({
    scheduled_start_at: START,
    duration_minutes: 90,
    reason: '面试官改约',
    interviewer_additions: [{ actor_id: ACTOR }, { actor_id: ACTOR_2, required_scorecard: false }],
    meeting: { provider: 'FEISHU', external_meeting_id: 'feishu-new' },
  }), NOW)
  assert.equal(both.intent, 'RESCHEDULE')
  if (both.intent !== 'RESCHEDULE') assert.fail('intent 必须是 RESCHEDULE')
  assert.equal(both.interview_id, INTERVIEW.toLowerCase())
  assert.equal(both.expected_record_version, 3)
  assert.equal(both.scheduled_start_at, '2026-11-20T02:00:00.000Z')
  assert.equal(both.start_ms, Date.parse(START))
  assert.equal(both.duration_minutes, 90)
  assert.equal(both.reason, '面试官改约')
  assert.equal(both.interviewer_additions.length, 2)
  assert.equal(both.interviewer_additions[1]?.required_scorecard, false)
  assert.equal(both.meeting?.external_meeting_id, 'feishu-new')
  assert.match(both.args_digest, /^sha256:[0-9a-f]{64}$/)

  // 只给 duration：开始时刻留给事务层沿用现有值（形状层不补）。
  const onlyDuration = parseScheduleArgs(rescheduleBase({ scheduled_start_at: undefined, duration_minutes: 30 }), NOW)
  if (onlyDuration.intent !== 'RESCHEDULE') assert.fail('intent 必须是 RESCHEDULE')
  assert.equal(onlyDuration.scheduled_start_at, undefined)
  assert.equal(onlyDuration.start_ms, undefined)
  assert.equal(onlyDuration.duration_minutes, 30)

  // 两者都不给 → NO_CHANGE（§3.2 的逐字要求）。
  expectInvalidArgs(
    () => parseScheduleArgs(rescheduleBase({ scheduled_start_at: undefined }), NOW),
    'NO_CHANGE',
  )
})

test('RESCHEDULE 校验：ID/时间/时长/版本/重复面试官都按契约拒', () => {
  expectInvalidArgs(() => parseScheduleArgs(rescheduleBase({ interview_id: 'interview_0001' }), NOW), 'ID_NOT_UUID')
  expectInvalidArgs(() => parseScheduleArgs(rescheduleBase({ scheduled_start_at: '2026-11-20T10:00:00' }), NOW), 'TIMESTAMP_WITHOUT_OFFSET')
  expectInvalidArgs(() => parseScheduleArgs(rescheduleBase({ duration_minutes: 14 }), NOW), 'DURATION_OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(rescheduleBase({ duration_minutes: 60.5 }), NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseScheduleArgs(rescheduleBase({ expected_record_version: 0 }), NOW), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(rescheduleBase({ expected_record_version: 1.5 }), NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseScheduleArgs(rescheduleBase({ expected_record_version: undefined }), NOW), 'MISSING_REQUIRED')
  expectInvalidArgs(() => parseScheduleArgs(rescheduleBase({ interview_id: undefined }), NOW), 'MISSING_REQUIRED')
  expectInvalidArgs(
    () => parseScheduleArgs(rescheduleBase({
      interviewer_additions: [{ actor_id: ACTOR }, { actor_id: ACTOR.toUpperCase() }],
    }), NOW),
    'DUPLICATE_INTERVIEWER',
  )
  // 空 additions 合法（只增不减，空 = 没加人）。
  const emptyAdditions = parseScheduleArgs(rescheduleBase({ interviewer_additions: [] }), NOW)
  if (emptyAdditions.intent !== 'RESCHEDULE') assert.fail('intent 必须是 RESCHEDULE')
  assert.deepEqual(emptyAdditions.interviewer_additions, [])
})

test('CANCEL / WITHDRAW_INTERVIEWER：reason 缺失或空白 → REASON_REQUIRED（不是 TYPE_MISMATCH）', () => {
  const cancel = parseScheduleArgs(cancelBase(), NOW)
  assert.equal(cancel.intent, 'CANCEL')
  if (cancel.intent !== 'CANCEL') assert.fail('intent 必须是 CANCEL')
  assert.equal(cancel.reason, '候选人改约')
  expectInvalidArgs(() => parseScheduleArgs(cancelBase({ reason: undefined }), NOW), 'REASON_REQUIRED')
  expectInvalidArgs(() => parseScheduleArgs(cancelBase({ reason: '   ' }), NOW), 'REASON_REQUIRED')
  expectInvalidArgs(() => parseScheduleArgs(cancelBase({ reason: 123 }), NOW), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseScheduleArgs(cancelBase({ reason: 'r'.repeat(501) }), NOW), 'OUT_OF_RANGE')

  const withdraw = parseScheduleArgs(withdrawBase(), NOW)
  assert.equal(withdraw.intent, 'WITHDRAW_INTERVIEWER')
  if (withdraw.intent !== 'WITHDRAW_INTERVIEWER') assert.fail('intent 必须是 WITHDRAW_INTERVIEWER')
  assert.equal(withdraw.interviewer_id, ACTOR)
  assert.equal(withdraw.reason, '面试官请假')
  expectInvalidArgs(() => parseScheduleArgs(withdrawBase({ reason: undefined }), NOW), 'REASON_REQUIRED')
  expectInvalidArgs(() => parseScheduleArgs(withdrawBase({ interviewer_id: 'interviewer_0001' }), NOW), 'ID_NOT_UUID')
  expectInvalidArgs(() => parseScheduleArgs(withdrawBase({ expected_record_version: undefined }), NOW), 'MISSING_REQUIRED')
})

test('每个 intent 的入参表相互独立：跨 intent 的键 → UNKNOWN_PARAM；身份键仍硬拒', () => {
  // CREATE 不接受 RESCHEDULE / CANCEL / WITHDRAW 的键。
  for (const extra of [
    { interview_id: INTERVIEW },
    { expected_record_version: 1 },
    { reason: 'x' },
    { interviewer_additions: [] },
    { interviewer_id: ACTOR },
  ]) {
    expectInvalidArgs(() => parseScheduleArgs(base(extra), NOW), 'UNKNOWN_PARAM')
  }
  // RESCHEDULE 不接受 CREATE 的键（加人只能走 interviewer_additions，不删行）。
  for (const extra of [
    { application_id: APP },
    { round_no: 1 },
    { interviewers: [{ actor_id: ACTOR }] },
    { timezone: 'Asia/Shanghai' },
  ]) {
    expectInvalidArgs(() => parseScheduleArgs(rescheduleBase(extra), NOW), 'UNKNOWN_PARAM')
  }
  // CANCEL 不接受改期/会议字段。
  for (const extra of [
    { scheduled_start_at: START },
    { duration_minutes: 60 },
    { meeting: { provider: 'FEISHU', external_meeting_id: 'm1' } },
    { expected_record_version: 3, interviewer_id: ACTOR },
  ]) {
    expectInvalidArgs(() => parseScheduleArgs(cancelBase(extra), NOW), 'UNKNOWN_PARAM')
  }
  // 四个 intent 都不接受 tenant_id / actor_id（不静默忽略，§0 第 4 条）。
  for (const raw of [base({ actor_id: ACTOR }), rescheduleBase({ tenant_id: APP }), cancelBase({ actor_id: ACTOR })]) {
    expectInvalidArgs(() => parseScheduleArgs(raw, NOW), 'TENANT_OR_ACTOR_NOT_ALLOWED')
  }
  expectInvalidArgs(() => parseScheduleArgs(withdrawBase({ actor_id: ACTOR }), NOW), 'TENANT_OR_ACTOR_NOT_ALLOWED')
})

test('四条命令的 args_digest 覆盖原始入参：reason/时间不同 → digest 不同；同参不同键 → 相同', () => {
  const digest = (raw: Record<string, unknown>): string => parseScheduleArgs(raw, NOW).args_digest
  const a = rescheduleBase({ idempotency_key: 'fixed-r1', reason: '理由 A' })
  const b = rescheduleBase({ idempotency_key: 'fixed-r1', reason: '理由 B' })
  assert.notEqual(digest(a), digest(b))
  assert.equal(
    digest({ ...a, idempotency_key: 'another-key' }),
    digest(a),
    'digest 必须剔除 idempotency_key（同参不同键 → 同一 digest）',
  )
  assert.notEqual(
    digest(cancelBase({ idempotency_key: 'fixed-c1', reason: '理由 A' })),
    digest(cancelBase({ idempotency_key: 'fixed-c1', reason: '理由 B' })),
  )
  // 省略默认值 与 显式写默认值 是两组参数（digest 的对象是 args 本身）。
  assert.notEqual(
    digest(rescheduleBase({ idempotency_key: 'fixed-r2' })),
    digest(rescheduleBase({ idempotency_key: 'fixed-r2', scheduled_start_at: START, duration_minutes: 60 })),
  )
})
