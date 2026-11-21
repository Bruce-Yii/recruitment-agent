// AT-4 / AT-5 入参层纯单测（**不连库**）：`parseScheduleArgs` 的形状/格式判定。
//
// AT-4：round_label 是 CREATE / RESCHEDULE 的可选显示层标签；1..200（btrim 后），
//       round_no / slot_code / uq_interview_slot 语义完全不变，digest 会把它算进去。
// AT-5：新 intent `REPLACE_INTERVIEWER` + 结构化键 `replace_interviewer`；
//       同演员、缺 reason、非法 UUID、未知键都在形状层 fail closed（零 SQL）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createInterviewScheduleTool,
  parseScheduleArgs,
  type CreateCommand,
  type ReplaceInterviewerCommand,
  type RescheduleCommand,
} from '../../src/tools/interview-schedule.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const APP = '11111111-1111-4111-8111-000000000701'
const INTERVIEW = '11111111-1111-4111-8111-000000000501'
const FROM = '11111111-1111-4111-8111-000000000104'
const TO = '11111111-1111-4111-8111-000000000102'
const START = '2031-01-01T10:00:00+08:00'

const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' }).resolved
if (DATABASE === null) throw new Error('测试配置解析失败')

let keyCounter = 0
const nextKey = (): string => `atb-${++keyCounter}`

/** 合法的 CREATE 入参。 */
function create(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'CREATE',
    idempotency_key: nextKey(),
    application_id: APP,
    round_no: 1,
    interviewers: [{ actor_id: FROM }],
    scheduled_start_at: START,
    duration_minutes: 60,
    ...overrides,
  }
}

/** 合法的 REPLACE_INTERVIEWER 入参。 */
function replace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'REPLACE_INTERVIEWER',
    idempotency_key: nextKey(),
    interview_id: INTERVIEW,
    expected_record_version: 3,
    replace_interviewer: { from_actor_id: FROM, to_actor_id: TO, reason: '原面试官临时出差' },
    ...overrides,
  }
}

/** 从 `Error: <CODE>: <compact-json>` 里取回 JSON 体。 */
function bodyOf(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as Record<string, unknown>
}

/** 断言抛的是指定 reason_code 的 INVALID_ARGS。 */
function expectInvalidArgs(run: () => unknown, reasonCode: string): void {
  assert.throws(run, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
    assert.equal(bodyOf(error).reason_code, reasonCode)
    return true
  })
}

// ---------------------------------------------------------------------------
// AT-4
// ---------------------------------------------------------------------------

test('AT-4 CREATE：round_label trim 后入库；round_no / slot_code 语义不变', () => {
  const args = parseScheduleArgs(create({ round_label: '  加面 · 交叉评估  ' })) as CreateCommand
  assert.equal(args.intent, 'CREATE')
  assert.equal(args.round_label, '加面 · 交叉评估')
  assert.equal(args.round_no, 1)
  assert.equal(args.slot_code, 'DEFAULT')
  assert.equal(args.duration_minutes, 60)
})

test('AT-4 省略 round_label → undefined；空/超长/非字符串 → OUT_OF_RANGE / TYPE_MISMATCH', () => {
  assert.equal((parseScheduleArgs(create()) as CreateCommand).round_label, undefined)
  expectInvalidArgs(() => parseScheduleArgs(create({ round_label: '   ' })), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(create({ round_label: 'x'.repeat(201) })), 'OUT_OF_RANGE')
  expectInvalidArgs(() => parseScheduleArgs(create({ round_label: 42 })), 'TYPE_MISMATCH')
})

test('AT-4 round_label 进 args_digest：同键换标签 = 不同参数；round_no 相同不代表同一命令', () => {
  const a = parseScheduleArgs(create({ idempotency_key: 'fixed-label' })) as CreateCommand
  const b = parseScheduleArgs(create({ idempotency_key: 'fixed-label', round_label: '加面 · 交叉评估' })) as CreateCommand
  assert.equal(a.round_no, b.round_no)
  assert.notEqual(a.args_digest, b.args_digest)
})

test('AT-4 RESCHEDULE 接受 round_label；CANCEL / WITHDRAW 不接受（跨 intent 键仍硬拒）', () => {
  const reschedule = parseScheduleArgs({
    intent: 'RESCHEDULE', idempotency_key: nextKey(), interview_id: INTERVIEW,
    expected_record_version: 3, duration_minutes: 45, round_label: '二面 · 加试',
  }) as RescheduleCommand
  assert.equal(reschedule.round_label, '二面 · 加试')
  expectInvalidArgs(() => parseScheduleArgs({
    intent: 'CANCEL', idempotency_key: nextKey(), interview_id: INTERVIEW,
    expected_record_version: 3, reason: '取消', round_label: '不该出现',
  }), 'UNKNOWN_PARAM')
})

// ---------------------------------------------------------------------------
// AT-5
// ---------------------------------------------------------------------------

test('AT-5 + MARK_NO_SHOW：六 intent 闭集含两个新值，规范化出完整命令', () => {
  const tool = createInterviewScheduleTool(DATABASE)
  const params = tool.parameters as {
    properties: { intent: { enum: string[] }; replace_interviewer: { required: string[] } }
  }
  assert.deepEqual([...params.properties.intent.enum].sort(), [
    'CREATE', 'RESCHEDULE', 'CANCEL', 'WITHDRAW_INTERVIEWER', 'REPLACE_INTERVIEWER', 'MARK_NO_SHOW',
  ].sort())
  assert.deepEqual(params.properties.replace_interviewer.required, ['from_actor_id', 'to_actor_id', 'reason'])

  const cmd = parseScheduleArgs(replace()) as ReplaceInterviewerCommand
  assert.equal(cmd.intent, 'REPLACE_INTERVIEWER')
  assert.equal(cmd.interview_id, INTERVIEW)
  assert.equal(cmd.expected_record_version, 3)
  assert.equal(cmd.from_actor_id, FROM)
  assert.equal(cmd.to_actor_id, TO)
  assert.equal(cmd.reason, '原面试官临时出差')
  assert.match(cmd.args_digest, /^sha256:[0-9a-f]{64}$/)
})

test('AT-5 同演员 / 缺 reason / 空白 reason / 超长 reason → fail closed', () => {
  expectInvalidArgs(() => parseScheduleArgs(replace({
    replace_interviewer: { from_actor_id: FROM, to_actor_id: FROM, reason: '换自己' },
  })), 'REPLACE_SAME_ACTOR')
  expectInvalidArgs(() => parseScheduleArgs(replace({
    replace_interviewer: { from_actor_id: FROM, to_actor_id: TO },
  })), 'REASON_REQUIRED')
  expectInvalidArgs(() => parseScheduleArgs(replace({
    replace_interviewer: { from_actor_id: FROM, to_actor_id: TO, reason: '   ' },
  })), 'REASON_REQUIRED')
  expectInvalidArgs(() => parseScheduleArgs(replace({
    replace_interviewer: { from_actor_id: FROM, to_actor_id: TO, reason: 'x'.repeat(501) },
  })), 'OUT_OF_RANGE')
})

test('AT-5 对象缺失 / 非对象 / 未知键 / 非法 UUID / 缺 interview_id → fail closed', () => {
  expectInvalidArgs(() => parseScheduleArgs(replace({ replace_interviewer: undefined })), 'MISSING_REQUIRED')
  expectInvalidArgs(() => parseScheduleArgs(replace({ replace_interviewer: TO })), 'TYPE_MISMATCH')
  expectInvalidArgs(() => parseScheduleArgs(replace({
    replace_interviewer: { from_actor_id: FROM, to_actor_id: TO, reason: 'r', tenant_id: APP },
  })), 'TENANT_OR_ACTOR_NOT_ALLOWED')
  expectInvalidArgs(() => parseScheduleArgs(replace({
    replace_interviewer: { from_actor_id: 'not-a-uuid', to_actor_id: TO, reason: 'r' },
  })), 'ID_NOT_UUID')
  const noInterview = replace()
  delete noInterview.interview_id
  expectInvalidArgs(() => parseScheduleArgs(noInterview), 'MISSING_REQUIRED')
})

test('AT-5 顶层 reason 兼容入口仍要求非空；intent 大小写/未知值不变', () => {
  const cmd = parseScheduleArgs(replace({
    replace_interviewer: { from_actor_id: FROM, to_actor_id: TO },
    reason: '顶层理由',
  })) as ReplaceInterviewerCommand
  assert.equal(cmd.reason, '顶层理由')
  expectInvalidArgs(() => parseScheduleArgs({
    intent: 'REPLACE_INTERVIEWERS', idempotency_key: nextKey(),
  }), 'OUT_OF_RANGE')
})
