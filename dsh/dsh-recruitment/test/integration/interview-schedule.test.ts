// S8 排期（`intent=CREATE`）的集成测试：**连真库 ra_s6s7**，每个用例在自己的事务里跑、结束一律 ROLLBACK。
//
// 覆盖（`SPEC.md` §5.2 / `manual/interview-line/SPEC.md` §4）：
//   1. 成功 CREATE：落库字段、interviewer 行、meeting+binding、changes.created 逐行对得上、无 null；
//   2. 幂等：同 key 同参 → replayed=true + changes 空 + 行数不变（且**时间已过**时仍能重放 =
//      重放先于 START_IN_PAST）；同 key 不同参 → INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)；
//   3. 语义幂等：同 (application, round, slot) → ALREADY_SCHEDULED，零写入（含 CANCELLED 行）；
//   4. 冲突：面试官重叠 → CONFLICT_SLOT(INTERVIEWER_BUSY)；候选人重叠 → CANDIDATE_BUSY；均零写入；
//   5. 会议负例：external_meeting_id 已被别的面试绑 → MEETING_ALREADY_BOUND，零写入；
//      裸 SQL 第二条 active binding → 真实 23505 + uq_meeting_binding_active；
//   6. 非法 stage_code 裸 SQL → 真实 23503 + fk_interview_stage_catalog；
//   7. 缺面试官 → INTERVIEWER_REQUIRED；AGENT_WORKER 当面试官 → INTERVIEWER_NOT_HUMAN；
//      申请不存在 → NOT_FOUND(APPLICATION_NOT_FOUND)；过去时间 → START_IN_PAST；全部零写入。
//
// 断言错误用 `errorBody(error)`（`Error: <CODE>: <compact-json>` → JSON.parse）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { scheduleInTransaction } from '../../src/tools/interview-schedule.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  errorBody,
  inRolledBackTx,
  one,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
  HR_ACTOR,
  TENANT,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

// 种子数据里的两个 HUMAN actor（`0003` / 演示数据）。
const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
const INTERVIEWER_B = '11111111-1111-4111-8111-000000000102'

/** 服务端"现在"（测试注入，固定值让 START_IN_PAST 的判定与真实时钟无关）。 */
const NOW = Date.parse('2026-11-13T00:00:00Z')
/** 未来的开始时刻（+08:00）。 */
const START = '2026-11-20T10:00:00+08:00'
const START_ISO = '2026-11-20T02:00:00.000Z'
const END_ISO = '2026-11-20T03:00:00.000Z'

/** `seedScenario` 只要求 dimensions 能被 `digestOf` 规范化；判定规则在这里用不到。 */
const DIMENSIONS = [
  {
    key: 'work_exists',
    label: '有工作经历',
    kind: 'MUST_HAVE',
    weight: 1,
    field: 'work_experience',
    operator: 'EXISTS',
    value: true,
  },
]

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

/** 造一份 CREATE 入参（幂等键每次不同）。 */
function createArgs(applicationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'CREATE',
    idempotency_key: `it-${uniqueSuffix()}`,
    application_id: applicationId,
    round_no: 1,
    interviewers: [{ actor_id: INTERVIEWER_A }],
    scheduled_start_at: START,
    duration_minutes: 60,
    ...overrides,
  }
}

/** 数一行（`count(*)::int`）。 */
async function count(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: number }>(sql, [...params])
  const value = rows[0]?.n
  assert.ok(typeof value === 'number', `count query returned no row: ${sql.slice(0, 60)}`)
  return value
}

/** 五张表的行数快照（"零写入"的证明口径，W3）。 */
async function tableCounts(client: DatabaseClient): Promise<Record<string, number>> {
  return {
    interview: await count(client, 'select count(*)::int as n from recruitment.interview'),
    interviewer: await count(client, 'select count(*)::int as n from recruitment.interviewer'),
    meeting: await count(client, 'select count(*)::int as n from recruitment.meeting'),
    meeting_binding: await count(client, 'select count(*)::int as n from recruitment.meeting_binding'),
    business_task: await count(client, 'select count(*)::int as n from recruitment.business_task'),
  }
}

/** 断言两次快照逐表相等。 */
function assertNoWrites(before: Record<string, number>, after: Record<string, number>, label: string): void {
  assert.deepEqual(after, before, `${label}：失败路径必须零写入（五张表行数应完全不变）`)
}

/** 期望一次工具调用抛指定 `code`（可选 `reason_code`），返回解析后的 JSON 体。 */
async function expectToolError(
  run: Promise<unknown>,
  code: string,
  reasonCode?: string,
): Promise<Record<string, unknown>> {
  try {
    await run
  } catch (error) {
    assert.equal((error as { code?: string }).code, code)
    const body = errorBody(error)
    assert.equal(body.code, code)
    if (reasonCode !== undefined) assert.equal(body.reason_code, reasonCode)
    return body
  }
  assert.fail(`期望抛 ${code}${reasonCode === undefined ? '' : `(${reasonCode})`}，但调用成功了`)
}

/** 期望一条裸 SQL 撞真实约束：`23505`/`23503` + 约束名逐字相等。 */
async function expectPgError(run: Promise<unknown>, code: string, constraint: string): Promise<void> {
  try {
    await run
  } catch (error) {
    assert.equal((error as { code?: string }).code, code)
    assert.equal((error as { constraint?: string }).constraint, constraint)
    return
  }
  assert.fail(`期望 SQLSTATE ${code} @ ${constraint}，但语句成功了`)
}

/** 输出值里禁止 `null`（数据库 NULL 必须**省略键**），也不允许 `undefined` 值。 */
function assertNoNulls(value: unknown, path = '$'): void {
  if (value === null) assert.fail(`${path} 是 null：契约禁止输出 null，数据库 NULL 必须省略键`)
  if (value === undefined) assert.fail(`${path} 是 undefined`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNulls(item, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoNulls(child, `${path}.${key}`)
    }
  }
}

/** 直接 INSERT 一场 interview（测试代码可以写库；只用于制造"已有行"的夹具）。 */
async function insertInterviewRaw(
  client: DatabaseClient,
  applicationId: string,
  options: { roundNo?: number; slotCode?: string; stageCode?: string; status?: string } = {},
): Promise<string> {
  return await one(
    client,
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, stage_code, status,
        scheduled_start_at, scheduled_end_at, status_changed_by_actor_id)
     values ($1, $2, $3, $4, $5, $6, now() + interval '1 day', now() + interval '1 day 1 hour', $7)
     returning id`,
    [
      TENANT,
      applicationId,
      options.roundNo ?? 1,
      options.slotCode ?? 'DEFAULT',
      options.stageCode ?? 'S8',
      options.status ?? 'SCHEDULED',
      HR_ACTOR,
    ],
  )
}

/** 读回 `interview` 表的排期关键列。 */
async function readInterviewRow(client: DatabaseClient, interviewId: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select id, application_id, round_no, slot_code, stage_code, status, timezone,
            scheduled_start_at, scheduled_end_at, status_changed_by_actor_id, record_version,
            interview_template_version_id
       from recruitment.interview
      where id = $1 and tenant_id = $2`,
    [interviewId, TENANT],
  )
  const row = rows[0]
  assert.ok(row !== undefined, `interview ${interviewId} 没有落库`)
  return row
}

/** pg 的 `timestamptz` 可能是 `Date`，统一成 ISO 文本再比。 */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

// ---------------------------------------------------------------------------
//  1. 成功 CREATE
// ---------------------------------------------------------------------------

test('CREATE 成功：interview/interviewer/meeting/binding/task 全部落库，changes.created 逐行对得上', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const externalId = `feishu-${uniqueSuffix()}`
    const calendarId = `evt-${uniqueSuffix()}`
    const args = createArgs(scenario.applicationId, {
      interviewers: [
        { actor_id: INTERVIEWER_A },
        {
          actor_id: INTERVIEWER_B,
          role_in_interview: 'SHADOW',
          required_scorecard: false,
          scorecard_due_at: '2026-11-21T10:00:00+08:00',
        },
      ],
      meeting: { provider: 'FEISHU', external_meeting_id: externalId, calendar_event_id: calendarId },
    })

    const value = await scheduleInTransaction(client, cfg, args, NOW)

    // --- 顶层形状 ---
    assert.equal(value.tool, 'recruitment_interview_schedule')
    assert.equal(value.contract_version, '1.0.0')
    assert.equal(value.status, 'OK')
    assert.equal(value.write, true)
    assert.equal(value.replayed, false)
    assert.equal(value.intent, 'CREATE')
    assert.deepEqual(value.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
    assert.deepEqual(value.effects, { meeting_bound: true, external_call_made: false })
    assert.deepEqual(value.warnings, [])
    assert.deepEqual(value.next_actions, [])
    assert.deepEqual((value.command as Record<string, unknown>).idempotency_key, args.idempotency_key)
    assert.match(String((value.command as Record<string, unknown>).args_digest), /^sha256:[0-9a-f]{64}$/)
    assertNoNulls(value)

    const interview = value.interview as Record<string, unknown>
    const interviewId = String(interview.id)
    assert.match(interviewId, /^[0-9a-f-]{36}$/)

    // --- 读回值（与 get 同形的自证）---
    assert.equal(interview.stage_code, 'S8')
    assert.equal(interview.round_no, 1)
    assert.equal(interview.slot_code, 'DEFAULT')
    assert.equal(interview.status, 'SCHEDULED')
    assert.equal(interview.duration_minutes, 60)
    assert.equal(interview.scheduled_start_at, START_ISO)
    assert.equal(interview.scheduled_end_at, END_ISO)
    assert.equal(interview.timezone, 'Asia/Shanghai')
    assert.equal(interview.application_id.toLowerCase(), scenario.applicationId.toLowerCase())
    assert.equal((interview.meeting_binding as Record<string, unknown>).state, 'BOUND_ACTIVE')
    assert.equal((interview.meeting_binding as Record<string, unknown>).count, 1)
    assert.equal((interview.interviewers as unknown[]).length, 2)

    // --- 落库字段（不只看输出）---
    const row = await readInterviewRow(client, interviewId)
    assert.equal(row.stage_code, 'S8')
    assert.equal(row.round_no, 1)
    assert.equal(row.slot_code, 'DEFAULT')
    assert.equal(row.status, 'SCHEDULED')
    assert.equal(row.timezone, 'Asia/Shanghai')
    assert.equal(iso(row.scheduled_start_at), START_ISO)
    assert.equal(iso(row.scheduled_end_at), END_ISO, 'scheduled_end_at = start + 60min')
    assert.equal(row.status_changed_by_actor_id, HR_ACTOR, 'INSERT 也必须显式写 status_changed_by_actor_id')
    assert.equal(row.record_version, 1)
    assert.equal(row.interview_template_version_id, null, '没给模板时该列就是 NULL（输出里则省略键）')

    // --- interviewer 行 ---
    const interviewerRows = (await client.query<Record<string, unknown>>(
      `select id, actor_id, role_in_interview, required_scorecard, scorecard_due_at
         from recruitment.interviewer
        where interview_id = $1 and tenant_id = $2
        order by actor_id`,
      [interviewId, TENANT],
    )).rows
    assert.equal(interviewerRows.length, 2, 'interviewer 行数 = 入参面试官数')
    assert.equal(interviewerRows[0]?.actor_id, INTERVIEWER_B)
    assert.equal(interviewerRows[0]?.role_in_interview, 'SHADOW')
    assert.equal(interviewerRows[0]?.required_scorecard, false)
    assert.equal(iso(interviewerRows[0]?.scorecard_due_at), '2026-11-21T02:00:00.000Z')
    assert.equal(interviewerRows[1]?.actor_id, INTERVIEWER_A)
    assert.equal(interviewerRows[1]?.role_in_interview, 'INTERVIEWER')
    assert.equal(interviewerRows[1]?.required_scorecard, true)
    assert.equal(interviewerRows[1]?.scorecard_due_at, null)

    // --- meeting + binding ---
    const meetingRows = (await client.query<Record<string, unknown>>(
      `select m.id as meeting_id, m.provider, m.external_meeting_id, m.calendar_event_id, m.meeting_role,
              b.id as binding_id, b.binding_method, b.bound_by_actor_id, b.unbound_at
         from recruitment.meeting_binding b
         join recruitment.meeting m on m.id = b.meeting_id and m.tenant_id = b.tenant_id
        where b.interview_id = $1 and b.tenant_id = $2`,
      [interviewId, TENANT],
    )).rows
    assert.equal(meetingRows.length, 1)
    const meeting = meetingRows[0] as Record<string, unknown>
    assert.equal(meeting.provider, 'FEISHU')
    assert.equal(meeting.external_meeting_id, externalId)
    assert.equal(meeting.calendar_event_id, calendarId)
    assert.equal(meeting.meeting_role, 'PRIMARY')
    assert.equal(meeting.binding_method, 'SCHEDULED')
    assert.equal(meeting.bound_by_actor_id, HR_ACTOR)
    assert.equal(meeting.unbound_at, null)

    // --- changes.created 逐行对得上 ---
    const created = (value.changes as Record<string, unknown>).created as { table: string; id: string }[]
    assert.deepEqual(
      created.map((change) => change.table),
      ['interview', 'interviewer', 'interviewer', 'meeting', 'meeting_binding', 'business_task'],
    )
    assert.deepEqual(created.map((change) => change.id), [
      interviewId,
      interviewerRows[1]?.id,
      interviewerRows[0]?.id,
      String(meeting.meeting_id),
      String(meeting.binding_id),
      created[5]?.id,
    ])

    // --- 幂等 STORE ---
    const store = (await client.query<Record<string, unknown>>(
      `select id, task_type, status, result_ref, business_refs, completed_at
         from recruitment.business_task
        where tenant_id = $1 and idempotency_key = $2`,
      [TENANT, `interview_schedule:${String(args.idempotency_key)}`],
    )).rows
    assert.equal(store.length, 1, '幂等 STORE 必须恰好一行')
    const storeRow = store[0] as Record<string, unknown>
    assert.equal(storeRow.id, created[5]?.id)
    assert.equal(storeRow.task_type, 'INTERVIEW_SCHEDULE')
    assert.equal(storeRow.status, 'SUCCEEDED')
    assert.equal(storeRow.result_ref, interviewId)
    assert.ok(storeRow.completed_at instanceof Date)
    const refs = storeRow.business_refs as Record<string, unknown>[]
    assert.deepEqual(refs[0], { kind: 'INTERVIEW', id: interviewId })
    assert.equal(refs[1]?.args_digest, (value.command as Record<string, unknown>).args_digest)
    assert.equal(refs[1]?.result_interview_id, interviewId)

    // --- 写后立刻可查：再用同一事务读一遍（等价 get 的自证）---
    const again = await readInterviewRow(client, interviewId)
    assert.equal(again.id, interviewId)
  })
})

test('CREATE 不带 meeting：排定照常成立 + MEETING_NOT_BOUND + BIND_MEETING 任务（H-3）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const value = await scheduleInTransaction(client, cfg, createArgs(scenario.applicationId), NOW)

    assert.equal(value.status, 'OK')
    assert.deepEqual(value.effects, { meeting_bound: false, external_call_made: false })
    const warnings = value.warnings as { code: string }[]
    assert.deepEqual(warnings.map((warning) => warning.code), ['MEETING_NOT_BOUND'])
    const actions = value.next_actions as { code: string; task_id: string; due_at: string }[]
    assert.equal(actions.length, 1)
    assert.equal(actions[0]?.code, 'BIND_MEETING')
    assert.equal(actions[0]?.due_at, START_ISO)

    const interview = value.interview as Record<string, unknown>
    const interviewId = String(interview.id)
    assert.equal((interview.meeting_binding as Record<string, unknown>).state, 'UNBOUND')
    assert.equal((interview.meeting_binding as Record<string, unknown>).count, 0)

    const bindTask = (await client.query<Record<string, unknown>>(
      `select id, task_type, status, due_at, business_refs, created_by_actor_id
         from recruitment.business_task
        where tenant_id = $1 and idempotency_key = $2`,
      [TENANT, `bind_meeting:${interviewId}`],
    )).rows
    assert.equal(bindTask.length, 1)
    assert.equal(bindTask[0]?.id, actions[0]?.task_id)
    assert.equal(bindTask[0]?.task_type, 'INTERVIEW_MEETING_BIND')
    assert.equal(bindTask[0]?.status, 'WAITING_EXTERNAL')
    assert.equal(iso(bindTask[0]?.due_at), START_ISO)
    assert.equal(bindTask[0]?.created_by_actor_id, HR_ACTOR)
    assert.deepEqual(bindTask[0]?.business_refs, [{ kind: 'INTERVIEW', id: interviewId }])
    assertNoNulls(value)
  })
})

// ---------------------------------------------------------------------------
//  2. 幂等重放 / 键复用
// ---------------------------------------------------------------------------

test('同 key 同参 → replayed=true、changes 空、行数不变；时间已过也照样重放（重放先于 START_IN_PAST）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const args = createArgs(scenario.applicationId, {
      meeting: { provider: 'FEISHU', external_meeting_id: `feishu-${uniqueSuffix()}` },
    })
    const first = await scheduleInTransaction(client, cfg, args, NOW)
    assert.equal(first.replayed, false)
    const firstInterviewId = String((first.interview as Record<string, unknown>).id)
    const before = await tableCounts(client)

    // (a) 同一事务里重放同一 key + 同一参数。
    const replay = await scheduleInTransaction(client, cfg, args, NOW)
    assert.equal(replay.status, 'OK')
    assert.equal(replay.replayed, true)
    assert.deepEqual((replay.changes as Record<string, unknown>).created, [])
    assert.deepEqual((replay.changes as Record<string, unknown>).updated, [])
    assert.deepEqual((replay.changes as Record<string, unknown>).unchanged, [])
    assert.equal(String((replay.interview as Record<string, unknown>).id), firstInterviewId)
    assert.deepEqual(await tableCounts(client), before, '重放不得写任何行')

    // (b) 让"现在"越过开始时刻：重放必须仍然成功（START_IN_PAST 在 STORE 命中之后才判）。
    const longAfter = Date.parse('2027-01-01T00:00:00Z')
    const replayAfterStart = await scheduleInTransaction(client, cfg, args, longAfter)
    assert.equal(replayAfterStart.replayed, true, '时间已过的重放不能被误判成 START_IN_PAST')
    assert.equal(String((replayAfterStart.interview as Record<string, unknown>).id), firstInterviewId)
    assert.deepEqual(await tableCounts(client), before)

    // (c) 同 key 不同参 → IDEMPOTENCY_KEY_REUSED（detail 带两个 digest）。
    const changed = { ...args, scheduled_start_at: '2026-11-20T14:00:00+08:00' }
    const body = await expectToolError(
      scheduleInTransaction(client, cfg, changed, NOW),
      'INVALID_ARGS',
      'IDEMPOTENCY_KEY_REUSED',
    )
    const detail = body.detail as Record<string, unknown>
    assert.match(String(detail.first_args_digest), /^sha256:[0-9a-f]{64}$/)
    assert.match(String(detail.this_args_digest), /^sha256:[0-9a-f]{64}$/)
    assert.notEqual(detail.first_args_digest, detail.this_args_digest)
    assert.deepEqual(await tableCounts(client), before, '键复用不得写任何行')
  })
})

// ---------------------------------------------------------------------------
//  3. 语义幂等（§6.4）
// ---------------------------------------------------------------------------

test('语义幂等：同 (application, round, slot) → ALREADY_SCHEDULED，零写入（CANCELLED 行同样占位）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const first = await scheduleInTransaction(client, cfg, createArgs(scenario.applicationId), NOW)
    const firstInterviewId = String((first.interview as Record<string, unknown>).id)
    const before = await tableCounts(client)

    // 换一个幂等键、同一 slot：语义幂等与 key 无关。
    const body = await expectToolError(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId), NOW),
      'ALREADY_SCHEDULED',
      'SLOT_OCCUPIED',
    )
    const detail = body.detail as Record<string, unknown>
    assert.equal(detail.existing_interview_id, firstInterviewId)
    assert.equal(detail.existing_status, 'SCHEDULED')
    assert.match(String(detail.hint), /RESCHEDULE/)
    assert.deepEqual(await tableCounts(client), before, 'ALREADY_SCHEDULED 必须零写入')

    // §6.4：CANCELLED 行仍然占着 (application, round_no, slot_code)。
    await client.query(
      `update recruitment.interview set status = 'CANCELLED' where id = $1 and tenant_id = $2`,
      [firstInterviewId, TENANT],
    )
    const cancelledBody = await expectToolError(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId), NOW),
      'ALREADY_SCHEDULED',
      'SLOT_OCCUPIED',
    )
    assert.equal((cancelledBody.detail as Record<string, unknown>).existing_status, 'CANCELLED')
    assert.equal((cancelledBody.detail as Record<string, unknown>).existing_interview_id, firstInterviewId)
  })
})

// ---------------------------------------------------------------------------
//  4. 冲突（拒绝，不是建议）
// ---------------------------------------------------------------------------

test('面试官冲突 → CONFLICT_SLOT(INTERVIEWER_BUSY)，detail.conflicts 逐条，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 两场不同的申请（候选人不同），同一面试官。
    const firstScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const secondScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const first = await scheduleInTransaction(
      client, cfg, createArgs(firstScenario.applicationId, { scheduled_start_at: '2026-11-20T10:00:00+08:00' }), NOW,
    )
    const firstInterviewId = String((first.interview as Record<string, unknown>).id)
    const before = await tableCounts(client)

    const body = await expectToolError(
      scheduleInTransaction(
        client,
        cfg,
        createArgs(secondScenario.applicationId, { scheduled_start_at: '2026-11-20T10:30:00+08:00' }),
        NOW,
      ),
      'CONFLICT_SLOT',
      'INTERVIEWER_BUSY',
    )
    const detail = body.detail as Record<string, unknown>
    const slot = detail.slot as Record<string, unknown>
    assert.equal(slot.start, '2026-11-20T02:30:00.000Z')
    assert.equal(slot.end, '2026-11-20T03:30:00.000Z', 'buffer=0 时 slot.end = start + duration')
    const conflicts = detail.conflicts as Record<string, unknown>[]
    assert.ok(conflicts.length >= 1, 'CONFLICT_SLOT 必须逐条回列冲突')
    assert.equal(conflicts[0]?.kind, 'INTERVIEWER')
    assert.equal(conflicts[0]?.ref_kind, 'INTERVIEW')
    assert.equal(conflicts[0]?.ref_id, firstInterviewId)
    assert.equal(conflicts[0]?.actor_id, INTERVIEWER_A)
    const window = conflicts[0]?.window as Record<string, unknown>
    assert.equal(window.start, START_ISO)
    assert.equal(window.end, END_ISO)

    assert.deepEqual(await tableCounts(client), before, '冲突必须零写入（W3）')
  })
})

test('候选人冲突（跨轮次）→ CONFLICT_SLOT(CANDIDATE_BUSY)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const first = await scheduleInTransaction(
      client, cfg, createArgs(scenario.applicationId, { round_no: 1 }), NOW,
    )
    const firstInterviewId = String((first.interview as Record<string, unknown>).id)
    const before = await tableCounts(client)

    const body = await expectToolError(
      scheduleInTransaction(
        client,
        cfg,
        createArgs(scenario.applicationId, {
          round_no: 2,
          scheduled_start_at: '2026-11-20T10:30:00+08:00',
          interviewers: [{ actor_id: INTERVIEWER_B }],
        }),
        NOW,
      ),
      'CONFLICT_SLOT',
      'CANDIDATE_BUSY',
    )
    const conflicts = (body.detail as Record<string, unknown>).conflicts as Record<string, unknown>[]
    assert.ok(conflicts.length >= 1)
    assert.equal(conflicts[0]?.kind, 'CANDIDATE')
    assert.equal(conflicts[0]?.ref_id, firstInterviewId)
    assert.deepEqual(await tableCounts(client), before)
  })
})

// ---------------------------------------------------------------------------
//  5. 会议负例
// ---------------------------------------------------------------------------

test('会议已被别的面试绑 → MEETING_ALREADY_BOUND，零写入；裸 SQL 第二条 active binding = 23505', async () => {
  await inRolledBackTx(pool, async (client) => {
    const firstScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const secondScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const externalId = `feishu-${uniqueSuffix()}`

    // interview #1：用工具正常建会 + 绑定。
    const first = await scheduleInTransaction(client, cfg, createArgs(firstScenario.applicationId, {
      meeting: { provider: 'FEISHU', external_meeting_id: externalId },
    }), NOW)
    const firstInterviewId = String((first.interview as Record<string, unknown>).id)
    const meetingId = await one(
      client,
      `select m.id from recruitment.meeting m
         join recruitment.meeting_binding b on b.meeting_id = m.id
        where b.interview_id = $1 and b.tenant_id = $2`,
      [firstInterviewId, TENANT],
    )
    const before = await tableCounts(client)

    // interview #2：同一 external_meeting_id → 拒绝（换一个面试官，避免先撞面试官冲突）。
    const body = await expectToolError(
      scheduleInTransaction(client, cfg, createArgs(secondScenario.applicationId, {
        interviewers: [{ actor_id: INTERVIEWER_B }],
        meeting: { provider: 'FEISHU', external_meeting_id: externalId },
      }), NOW),
      'MEETING_ALREADY_BOUND',
      'BOUND_TO_OTHER_INTERVIEW',
    )
    const detail = body.detail as Record<string, unknown>
    assert.equal(detail.meeting_id, meetingId)
    assert.equal(detail.existing_interview_id, firstInterviewId)
    assert.deepEqual(await tableCounts(client), before, 'MEETING_ALREADY_BOUND 必须零写入')

    // 裸 SQL：同一 meeting 的第二条 active binding 必须被库拦住（真实 23505 + 约束名）。
    const secondInterviewId = await insertInterviewRaw(client, secondScenario.applicationId, { roundNo: 3 })
    await expectPgError(
      client.query(
        `insert into recruitment.meeting_binding
           (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
         values ($1, $2, $3, 'MANUAL', $4)`,
        [TENANT, meetingId, secondInterviewId, HR_ACTOR],
      ),
      '23505',
      'uq_meeting_binding_active',
    )
    // 事务已被这条失败语句置为 aborted；后面的断言不再查库（inRolledBackTx 负责 ROLLBACK）。
  })
})

test('同一 (tenant, provider, external_meeting_id) 的第二行 meeting = 23505 uq_meeting_external', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const externalId = `feishu-${uniqueSuffix()}`
    const first = await scheduleInTransaction(client, cfg, createArgs(scenario.applicationId, {
      meeting: { provider: 'FEISHU', external_meeting_id: externalId },
    }), NOW)
    assert.equal(first.status, 'OK')

    await expectPgError(
      client.query(
        `insert into recruitment.meeting (tenant_id, provider, external_meeting_id)
         values ($1, 'FEISHU', $2)`,
        [TENANT, externalId],
      ),
      '23505',
      'uq_meeting_external',
    )
  })
})

// ---------------------------------------------------------------------------
//  6. 非法 stage_code（0006 的外键）
// ---------------------------------------------------------------------------

test('非法 stage_code → 真实 SQLSTATE 23503 + fk_interview_stage_catalog', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    await expectPgError(
      client.query(
        `insert into recruitment.interview
           (tenant_id, application_id, round_no, slot_code, stage_code, status,
            scheduled_start_at, scheduled_end_at, status_changed_by_actor_id)
         values ($1, $2, 1, 'DEFAULT', 'S99', 'SCHEDULED',
                 now() + interval '1 day', now() + interval '1 day 1 hour', $3)`,
        [TENANT, scenario.applicationId, HR_ACTOR],
      ),
      '23503',
      'fk_interview_stage_catalog',
    )
  })
})

// ---------------------------------------------------------------------------
//  7. 拒绝路径（全部零写入）
// ---------------------------------------------------------------------------

test('缺面试官 → INTERVIEWER_REQUIRED，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    const body = await expectToolError(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId, { interviewers: [] }), NOW),
      'INVALID_ARGS',
      'INTERVIEWER_REQUIRED',
    )
    assert.deepEqual((body.detail as Record<string, unknown>).path, 'interviewers')
    assert.deepEqual(await tableCounts(client), before)
  })
})

test('AGENT_WORKER 当面试官 → INTERVIEWER_NOT_HUMAN，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    // `ck_actor_kind` 允许 HUMAN / SYSTEM / AGENT_WORKER。
    const agentActorId = await one(
      client,
      `insert into recruitment.actor (tenant_id, kind, display_name)
       values ($1, 'AGENT_WORKER', $2) returning id`,
      [TENANT, `集成测试 Agent ${uniqueSuffix()}`],
    )
    const before = await tableCounts(client)
    const body = await expectToolError(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId, {
        interviewers: [{ actor_id: agentActorId }],
      }), NOW),
      'INVALID_ARGS',
      'INTERVIEWER_NOT_HUMAN',
    )
    assert.equal((body.detail as Record<string, unknown>).actor_id, agentActorId)
    assert.equal((body.detail as Record<string, unknown>).kind, 'AGENT_WORKER')
    assert.deepEqual(await tableCounts(client), before)
  })
})

test('面试官不存在 / 跨租户 → NOT_FOUND(INTERVIEWER_NOT_FOUND)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    await expectToolError(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId, {
        interviewers: [{ actor_id: '00000000-0000-4000-8000-0000000000ff' }],
      }), NOW),
      'NOT_FOUND',
      'INTERVIEWER_NOT_FOUND',
    )
    assert.deepEqual(await tableCounts(client), before)
  })
})

test('申请不存在 → NOT_FOUND(APPLICATION_NOT_FOUND)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const before = await tableCounts(client)
    await expectToolError(
      scheduleInTransaction(client, cfg, createArgs('00000000-0000-4000-8000-0000000000aa'), NOW),
      'NOT_FOUND',
      'APPLICATION_NOT_FOUND',
    )
    assert.deepEqual(await tableCounts(client), before)
  })
})

test('开始时间已过 → START_IN_PAST，零写入（时点校验在事务里、幂等 STORE 之后）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    const body = await expectToolError(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId, {
        scheduled_start_at: '2020-01-01T10:00:00+08:00',
      }), NOW),
      'INVALID_ARGS',
      'START_IN_PAST',
    )
    assert.equal((body.detail as Record<string, unknown>).path, 'scheduled_start_at')
    assert.deepEqual(await tableCounts(client), before)
  })
})

test('申请不是 ACTIVE → INVALID_ARGS(APPLICATION_NOT_ACTIVE)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS, lifecycleStatus: 'WITHDRAWN' })
    const before = await tableCounts(client)
    await expectToolError(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId), NOW),
      'INVALID_ARGS',
      'APPLICATION_NOT_ACTIVE',
    )
    assert.deepEqual(await tableCounts(client), before)
  })
})

// ---------------------------------------------------------------------------
//  8. 单事务（W4）：失败要在**同一个未回滚的事务里**撤销已写的行
// ---------------------------------------------------------------------------

test('MEETING_ALREADY_BOUND 在同一个未回滚的事务里不留脏行（savepoint 撤销，事务仍可用）', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 先给"别人的面试"建会 + 绑定。
    const blockerScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const externalId = `feishu-${uniqueSuffix()}`
    await scheduleInTransaction(client, cfg, createArgs(blockerScenario.applicationId, {
      meeting: { provider: 'FEISHU', external_meeting_id: externalId },
    }), NOW)

    // 目标申请：CREATE 会**先** INSERT interview + interviewer，之后才在 meeting 绑定处被拒。
    const targetScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    await expectToolError(
      scheduleInTransaction(client, cfg, createArgs(targetScenario.applicationId, {
        // 换一个面试官：本用例要探的是 A9（会议已被绑），不能先被 A8（冲突）拦掉。
        interviewers: [{ actor_id: INTERVIEWER_B }],
        meeting: { provider: 'FEISHU', external_meeting_id: externalId },
      }), NOW),
      'MEETING_ALREADY_BOUND',
      'BOUND_TO_OTHER_INTERVIEW',
    )

    // 关键：**不回滚整个测试事务**，直接在同一事务里数行（比"外层回滚后行数不变"更强）。
    const after = await tableCounts(client)
    assert.equal(after.interview, before.interview, 'interview 行数不变：已插入的 interview 必须被 savepoint 撤销')
    assert.equal(after.interviewer, before.interviewer, 'interviewer 行数不变')
    assert.equal(after.meeting, before.meeting, 'meeting 行数不变')
    assert.equal(after.meeting_binding, before.meeting_binding, 'meeting_binding 行数不变')
    assert.equal(after.business_task, before.business_task, 'business_task 行数不变')
    // 该申请名下必须一行 interview 都没有（不是"恰好等量替换"）。
    assert.equal(
      await count(
        client,
        'select count(*)::int as n from recruitment.interview where application_id = $1',
        [targetScenario.applicationId],
      ),
      0,
    )
    // 事务仍然可用（说明是 savepoint 回滚，不是事务已被废掉）。
    assert.equal(
      await count(client, 'select count(*)::int as n from recruitment.organization where id = $1', [TENANT]),
      1,
    )
  })
})
