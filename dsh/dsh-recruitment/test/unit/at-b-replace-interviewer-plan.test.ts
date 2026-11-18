// AT-4 / AT-5 的意图规划 / 写入 SQL / 闸门纯单测（**不连真库**，用可观测的 client 替身）。
//
// 证明四件事：
//   1. prepare 的五类负例（已替换 / CANCELLED / 已分配 / 非 HUMAN / 旧版本）在**零写 SQL**下失败；
//   2. 无人工批准 / 拒绝 → FORBIDDEN，写 SQL 数为 0（D-79 对第五个 intent 同样生效）；
//   3. 正向写：INSERT 新行 required_scorecard=true + UPDATE 旧行 replaced_* 且 required_scorecard=false，
//      审计事件复用 interviewer.withdrawn 且 normalizer_version='schema/interview-schedule'；
//   4. 幂等 STORE 同键重放零写入、不同参同键 → IDEMPOTENCY_KEY_REUSED；AT-4 的 round_label
//      进 CREATE 的 INSERT、RESCHEDULE 的 UPDATE 用 coalesce 保留原值。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseScheduleArgs,
  prepareSchedule,
  scheduleInTransaction,
  type ReplaceInterviewerCommand,
} from '../../src/tools/interview-schedule.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR = '11111111-1111-4111-8111-000000000103'
const APP = '11111111-1111-4111-8111-000000000701'
const CANDIDATE = '11111111-1111-4111-8111-000000000801'
const JOB = '11111111-1111-4111-8111-000000000401'
const INTERVIEW = '11111111-1111-4111-8111-000000000501'
const OLD_INTERVIEWER = '11111111-1111-4111-8111-000000000901'
const NEW_INTERVIEWER = '11111111-1111-4111-8111-000000000902'
const FROM = '11111111-1111-4111-8111-000000000104'
const TO = '11111111-1111-4111-8111-000000000102'
const EVENT = '11111111-1111-4111-8111-000000000a01'
const TASK = '11111111-1111-4111-8111-000000000a02'
const LABEL = '加面 · 交叉评估'
const START_ISO = '2031-01-01T02:00:00.000Z'
const END_ISO = '2031-01-01T03:00:00.000Z'
const REPLACED_AT = '2031-01-01T04:00:00.000Z'

const CFG: ResolvedDatabaseConfig = {
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password: 'not-used-in-unit-tests', password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT, actor_id: HR, statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000, max: 2,
}

const NOW = Date.parse('2030-12-01T00:00:00Z')
const allowOnce = async (): Promise<'allowed-once'> => 'allowed-once'
const deny = async (): Promise<'rejected'> => 'rejected'

interface Call {
  readonly sql: string
  readonly params: readonly unknown[]
}

interface StubOptions {
  readonly storeRows?: readonly Record<string, unknown>[]
  readonly oldRow?: Record<string, unknown> | null
  readonly actorKind?: string
  readonly assignedRows?: readonly Record<string, unknown>[]
  readonly interviewStatus?: string
  readonly recordVersion?: number
}

/**
 * 可观测 client 替身：按 SQL 关键字分发。**所有** SQL（含写）都记进 calls，
 * 因此"零写入"可以直接断言"没有 insert/update/delete 语句"。
 */
function makeStub(options: StubOptions = {}): { client: DatabaseClient; calls: Call[] } {
  const calls: Call[] = []
  const oldRow: Record<string, unknown> = {
    id: OLD_INTERVIEWER,
    interview_id: INTERVIEW,
    actor_id: FROM,
    role_in_interview: 'INTERVIEWER',
    required_scorecard: true,
    scorecard_due_at: null,
    replaced_by_interviewer_id: null,
    interview_status: options.interviewStatus ?? 'SCHEDULED',
    record_version: options.recordVersion ?? 3,
    round_no: 1,
    slot_code: 'DEFAULT',
    ...(options.oldRow === undefined ? {} : options.oldRow),
  }
  const readbackInterview = {
    id: INTERVIEW, application_id: APP, candidate_id: CANDIDATE, job_id: JOB,
    round_no: 1, slot_code: 'DEFAULT', round_label: LABEL, stage_code: 'S8',
    status: 'SCHEDULED', record_version: 4,
    scheduled_start_at: START_ISO, scheduled_end_at: END_ISO,
    timezone: 'Asia/Shanghai', status_changed_at: START_ISO,
  }
  const commandInterview = {
    id: INTERVIEW, application_id: APP, status: 'SCHEDULED', record_version: 3,
    scheduled_start_at: START_ISO, scheduled_end_at: END_ISO, round_no: 1, slot_code: 'DEFAULT',
  }
  const readInterviewers = [
    {
      interviewer_id: OLD_INTERVIEWER, actor_id: FROM, display_name: '张工',
      role_in_interview: 'INTERVIEWER', required_scorecard: false, scorecard_due_at: null,
      replaced_by_interviewer_id: NEW_INTERVIEWER, replaced_at: REPLACED_AT,
      replacement_reason: '原面试官临时出差',
    },
    {
      interviewer_id: NEW_INTERVIEWER, actor_id: TO, display_name: '李工',
      role_in_interview: 'INTERVIEWER', required_scorecard: true, scorecard_due_at: null,
      replaced_by_interviewer_id: null, replaced_at: null, replacement_reason: null,
    },
  ]
  const client = {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
      calls.push({ sql, params: [...params] })
      const s = sql.replace(/\s+/g, ' ')
      let rows: unknown[] = []
      if (s.includes('from recruitment.business_task') && s.includes('idempotency_key')) {
        rows = [...(options.storeRows ?? [])]
      } else if (s.includes('r.replaced_by_interviewer_id') && s.includes('from recruitment.interviewer r')) {
        rows = options.oldRow === null ? [] : [oldRow]
      } else if (s.includes('from recruitment.actor') && s.includes('id = any')) {
        rows = [
          { id: FROM, kind: 'HUMAN', display_name: '张工' },
          { id: TO, kind: options.actorKind ?? 'HUMAN', display_name: '李工' },
        ]
      } else if (s.includes('from recruitment.interviewer') && s.includes('where tenant_id = $1 and interview_id = $2')) {
        rows = [...(options.assignedRows ?? [])]
      // 注意顺序：`recruitment.interviewer` 以 `recruitment.interview` 开头，必须先判 interviewer。
      } else if (s.includes('update recruitment.interviewer')) {
        rows = [{ id: OLD_INTERVIEWER }]
      } else if (s.includes('update recruitment.interview')) {
        rows = [{ id: INTERVIEW }]
      } else if (s.includes('insert into recruitment.interviewer')) {
        rows = [{ id: NEW_INTERVIEWER }]
      } else if (s.includes('insert into recruitment.interview')) {
        rows = [{ id: INTERVIEW, record_version: 1 }]
      } else if (s.includes('insert into recruitment.event_inbox')) {
        rows = [{ event_id: EVENT }]
      } else if (s.includes('insert into recruitment.business_task')) {
        rows = [{ id: TASK }]
      } else if (s.includes('with latest as')) {
        rows = [{ tenant_exists: true, demo: null, synthetic: null }]
      } else if (s.includes("payload ->> 'wait_minutes'")) {
        rows = [{ wait_minutes: '120' }]
      } else if (s.includes('from recruitment.application') && s.includes('lifecycle_status')) {
        rows = [{ id: APP, candidate_id: CANDIDATE, job_id: JOB, lifecycle_status: 'ACTIVE' }]
      } else if (s.includes('select a.candidate_id')) {
        rows = [{ candidate_id: CANDIDATE }]
      } else if (s.includes('with occupied as')) {
        rows = [] // 无冲突
      } else if (s.includes('from recruitment.interview where tenant_id = $1 and application_id = $2')) {
        rows = [] // CREATE 的语义幂等查询：该 (application, round, slot) 尚无行
      } else if (s.includes('from recruitment.interview where')) {
        rows = [commandInterview]
      } else if (s.includes('a.candidate_id') && s.includes('from recruitment.interview i')) {
        rows = [readbackInterview]
      } else if (s.includes('from recruitment.interviewer iv')) {
        rows = readInterviewers
      }
      // scorecard / meeting_binding / interview_record 一律空 → transcript 走 MISSING 分支。
      return { rows: rows as T[] }
    },
  } as unknown as DatabaseClient
  return { client, calls }
}

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'REPLACE_INTERVIEWER',
    idempotency_key: 'atb-replace-1',
    interview_id: INTERVIEW,
    expected_record_version: 3,
    replace_interviewer: { from_actor_id: FROM, to_actor_id: TO, reason: '原面试官临时出差' },
    ...overrides,
  }
}

function writeSql(calls: readonly Call[]): readonly Call[] {
  return calls.filter((call) => /\b(insert|update|delete)\s+(into\s+)?recruitment\./i.test(call.sql))
}

function bodyOf(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
//  1. prepare 负例（全部零写 SQL）
// ---------------------------------------------------------------------------

test('AT-5 prepare 负例：已替换 / CANCELLED / 新人已分配 / 非 HUMAN / 旧版本 → 零写 SQL', async () => {
  const cases: { name: string; options: StubOptions; code: string; reason: string }[] = [
    {
      name: 'already-replaced',
      options: { oldRow: { replaced_by_interviewer_id: NEW_INTERVIEWER, replaced_at: REPLACED_AT, replacement_reason: '旧' } },
      code: 'INVALID_ARGS', reason: 'ALREADY_REPLACED',
    },
    { name: 'cancelled', options: { interviewStatus: 'CANCELLED' }, code: 'INVALID_ARGS', reason: 'INVALID_STATE_TRANSITION' },
    { name: 'already-assigned', options: { assignedRows: [{ id: NEW_INTERVIEWER }] }, code: 'INVALID_ARGS', reason: 'INTERVIEWER_ALREADY_ASSIGNED' },
    { name: 'not-human', options: { actorKind: 'AGENT_WORKER' }, code: 'INVALID_ARGS', reason: 'INTERVIEWER_NOT_HUMAN' },
    { name: 'stale-version', options: { recordVersion: 9 }, code: 'VERSION_CONFLICT', reason: 'STALE_RECORD_VERSION' },
  ]
  for (const item of cases) {
    const { client, calls } = makeStub(item.options)
    const command = parseScheduleArgs(raw()) as ReplaceInterviewerCommand
    await assert.rejects(
      async () => prepareSchedule(client, CFG, command, NOW, { forUpdate: false }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, item.code, item.name)
        assert.equal(bodyOf(error).reason_code, item.reason, item.name)
        return true
      },
      item.name,
    )
    assert.deepEqual(writeSql(calls), [], `${item.name}：负例必须零写 SQL`)
  }
})

test('AT-5 prepare 负例：同演员在 prepare 层也被拦（绕过 parse 的防御）', async () => {
  const { client, calls } = makeStub()
  const command = { ...(parseScheduleArgs(raw()) as ReplaceInterviewerCommand), to_actor_id: FROM }
  await assert.rejects(
    async () => prepareSchedule(client, CFG, command, NOW, { forUpdate: false }),
    (error: unknown) => {
      assert.equal(bodyOf(error).reason_code, 'REPLACE_SAME_ACTOR')
      return true
    },
  )
  assert.deepEqual(writeSql(calls), [])
})

// ---------------------------------------------------------------------------
//  2. D-79 闸门 / 幂等
// ---------------------------------------------------------------------------

test('AT-5 无人工批准 / 拒绝 → FORBIDDEN，零写 SQL（第五 intent 同样过闸门）', async () => {
  for (const approve of [undefined, deny]) {
    const { client, calls } = makeStub()
    await assert.rejects(
      async () => scheduleInTransaction(client, CFG, raw({ idempotency_key: 'atb-gate' }), NOW, approve),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'FORBIDDEN')
        return true
      },
    )
    assert.deepEqual(writeSql(calls), [], '闸门拒绝后不得有任何写 SQL')
  }
})

test('AT-5 幂等 STORE：同键同参重放零写；同键不同参 → IDEMPOTENCY_KEY_REUSED', async () => {
  const first = parseScheduleArgs(raw({ idempotency_key: 'atb-idem' })) as ReplaceInterviewerCommand
  const store = {
    id: TASK,
    business_refs: [
      { kind: 'INTERVIEW', id: INTERVIEW },
      { args_digest: first.args_digest, result_interview_id: INTERVIEW },
    ],
  }
  const replay = makeStub({ storeRows: [store] })
  const value = await scheduleInTransaction(replay.client, CFG, raw({ idempotency_key: 'atb-idem' }), NOW, allowOnce)
  assert.equal(value.replayed, true)
  assert.deepEqual(value.changes, { created: [], updated: [], unchanged: [] })
  assert.deepEqual(writeSql(replay.calls), [])

  const reused = makeStub({ storeRows: [store] })
  await assert.rejects(
    async () => scheduleInTransaction(reused.client, CFG, raw({ idempotency_key: 'atb-idem', expected_record_version: 4 }), NOW, allowOnce),
    (error: unknown) => {
      assert.equal(bodyOf(error).reason_code, 'IDEMPOTENCY_KEY_REUSED')
      return true
    },
  )
  assert.deepEqual(writeSql(reused.calls), [])
})

// ---------------------------------------------------------------------------
//  3. 正向写 SQL 形状 + 读回投影
// ---------------------------------------------------------------------------

test('AT-5 正向：新人 required_scorecard=true / 旧人 false + replaced_* + 复用已登记审计事件', async () => {
  const { client, calls } = makeStub()
  const value = await scheduleInTransaction(client, CFG, raw(), NOW, allowOnce)
  assert.equal(value.intent, 'REPLACE_INTERVIEWER')
  assert.equal(value.replayed, false)
  const changes = value.changes as { created: { table: string }[] }
  assert.deepEqual(changes.created.map((row) => row.table).sort(), ['business_task', 'event_inbox', 'interviewer'])

  const inserts = calls.filter((call) => call.sql.includes('insert into recruitment.interviewer'))
  assert.equal(inserts.length, 1, '只插一条新的面试官分配行')
  assert.match(inserts[0]!.sql, /required_scorecard/)
  assert.deepEqual(inserts[0]!.params.slice(0, 4), [TENANT, INTERVIEW, TO, 'INTERVIEWER'])
  assert.equal(inserts[0]!.params[4], null, '新人 scorecard_due_at 从旧行复制（本例为 null）')

  const marks = calls.filter((call) => call.sql.includes('update recruitment.interviewer'))
  assert.equal(marks.length, 1, '旧行只 UPDATE 一次（不删行）')
  assert.match(marks[0]!.sql, /replaced_by_interviewer_id = \$3/)
  assert.match(marks[0]!.sql, /replacement_reason = \$4/)
  assert.match(marks[0]!.sql, /required_scorecard = false/)
  assert.deepEqual(marks[0]!.params, [OLD_INTERVIEWER, TENANT, NEW_INTERVIEWER, '原面试官临时出差'])

  const events = calls.filter((call) => call.sql.includes('insert into recruitment.event_inbox'))
  assert.equal(events.length, 1)
  const eventParams = events[0]!.params
  assert.equal(eventParams[2], 'interviewer.withdrawn', '复用已登记事件类型，不新增事件')
  assert.match(events[0]!.sql, /'schema\/interview-schedule'/, 'normalizer_version 用已登记口径')
  const payload = JSON.parse(String(eventParams[5])) as Record<string, unknown>
  assert.equal(payload.interview_id, INTERVIEW)
  assert.equal(payload.from_actor_id, FROM)
  assert.equal(payload.to_actor_id, TO)
  assert.equal(payload.reason, '原面试官临时出差')
  assert.equal(payload.replacement_interviewer_id, NEW_INTERVIEWER)
  assert.equal(payload.interviewer_id, undefined, '不能冒充 WITHDRAW 的退出事件（会破坏其幂等判重）')

  // 读回投影（AT-4 + AT-5）：round_label 与 replacements 都可见。
  const interview = value.interview as Record<string, unknown>
  assert.equal(interview.round_label, LABEL)
  assert.deepEqual(interview.replacements, [{
    from_actor_id: FROM, to_actor_id: TO, reason: '原面试官临时出差', replaced_at: REPLACED_AT,
  }])
  const interviewers = interview.interviewers as Record<string, unknown>[]
  const old = interviewers.find((row) => row.actor_id === FROM)
  const fresh = interviewers.find((row) => row.actor_id === TO)
  assert.equal(old?.required_scorecard, false, '旧 actor 不再需要交面评 → 不会阻塞 Evaluation Ready')
  assert.equal(fresh?.required_scorecard, true, '新 actor 拥有新面评')
  assert.equal(old?.replaced_by_interviewer_id, NEW_INTERVIEWER)
  assert.equal(old?.replacement_reason, '原面试官临时出差')
})

test('AT-4 正向 SQL：CREATE 把 round_label 写进 interview 列；RESCHEDULE 用 coalesce 保留原值', async () => {
  const created = makeStub()
  const createValue = await scheduleInTransaction(created.client, CFG, {
    intent: 'CREATE', idempotency_key: 'atb-label-create', application_id: APP, round_no: 2,
    interviewers: [{ actor_id: FROM }], scheduled_start_at: START_ISO,
    duration_minutes: 60, round_label: '  加面 · 交叉评估  ',
  }, NOW, allowOnce)
  assert.equal(createValue.replayed, false)
  const interviewInsert = created.calls.find((call) => call.sql.includes('insert into recruitment.interview'))
  assert.ok(interviewInsert !== undefined)
  assert.match(interviewInsert.sql, /round_label/)
  assert.equal(interviewInsert.params[10], LABEL, 'round_label trim 后作为最后一个参数写入')

  const rescheduled = makeStub()
  await scheduleInTransaction(rescheduled.client, CFG, {
    intent: 'RESCHEDULE', idempotency_key: 'atb-label-reschedule', interview_id: INTERVIEW,
    expected_record_version: 3, duration_minutes: 45,
  }, NOW, allowOnce)
  const updates = rescheduled.calls.filter((call) => call.sql.includes('update recruitment.interview'))
  assert.ok(updates.length >= 1)
  assert.match(updates[0]!.sql, /round_label = coalesce\(\$6::text, round_label\)/)
  assert.equal(updates[0]!.params[5], null, '不给 label 时保留原值，不抹成 null')
})
