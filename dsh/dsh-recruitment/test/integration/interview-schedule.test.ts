// S8 排期（`intent=CREATE | RESCHEDULE | CANCEL | WITHDRAW_INTERVIEWER`）的集成测试：
// **连真库 ra_s6s7**，每个用例在自己的事务里跑、结束一律 ROLLBACK。
//
// 覆盖（`SPEC.md` §5.2 / `manual/interview-line/SPEC.md` §4 / `contracts/interview/scheduling-rules.md`）：
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
//   8. D-79 闸门（缺省/拒绝/取消/超时）零写入；
//   9. 其余三个 intent（D-62）：每个都有 正向 + 幂等 + 闸门拒绝 + 非法状态迁移 四类。
//
// 断言错误用 `errorBody(error)`（`Error: <CODE>: <compact-json>` → JSON.parse）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeApprovalRequest, scheduleInTransaction } from '../../src/tools/interview-schedule.ts'
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
// 排期时段**不能写死**：本文件连的是共享真库 `ra_s6s7`，其它 lane / 手工操作会往库里
// 提交真实面试。写死 `2026-11-20T10:00+08:00` 时，并发 lane 恰好在同一时段、同一面试官
// （`INTERVIEWER_A`）建了一场面试，于是 approval 负例先被 `CONFLICT_SLOT` 拦掉——
// 测的就不再是闸门，而是"库里那一刻有没有空位"。
//
// 改成「远期基准 + 每次进程随机偏移」：2031 年之后库里不会有任何已提交数据，随机偏移
// 保证并发跑同一个测试文件的两个进程也不会互相撞。派生值一律用 `at()` 算，不许再写死。
const SLOT_BASE_MS = Date.parse('2031-01-01T10:00:00+08:00') + Math.floor(Math.random() * 300 * 24 * 60) * 60_000
/** 相对基准偏移 `minutes` 分钟的时刻（UTC ISO，便于与 `iso()` 的结果直接比较）。 */
const at = (minutes: number): string => new Date(SLOT_BASE_MS + minutes * 60_000).toISOString()
const START = at(0)
const START_ISO = at(0)
const END_ISO = at(60)

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

/**
 * D-79 的 approval 替身：默认放行一次。
 *
 * 本文件绝大多数用例验证的是「校验通过之后」的写路径，所以显式给一个「人已批准」的替身；
 * 闸门本身的负例见 §8（它们直接调 `scheduleInTransaction` 并给拒绝/缺省）。
 */
const allowOnce = async (): Promise<'allowed-once'> => 'allowed-once'

/**
 * 测试用排期入口：等价于 `scheduleInTransaction(client, cfg, args, nowMs, allowOnce)`。
 * @param client - 事务内连接。
 * @param args - CREATE 入参。
 * @param nowMs - 服务端"现在"（默认 `NOW`）。
 * @returns 契约出参。
 */
function schedule(
  client: DatabaseClient,
  args: Record<string, unknown>,
  nowMs: number = NOW,
): Promise<Record<string, unknown>> {
  return scheduleInTransaction(client, cfg, args, nowMs, allowOnce)
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

    const value = await schedule(client, args, NOW)

    // --- 顶层形状 ---
    assert.equal(value.tool, 'recruitment_interview_schedule')
    assert.equal(value.contract_version, '1.1.0')
    assert.equal(value.status, 'OK')
    assert.equal(value.write, true)
    assert.equal(value.replayed, false)
    assert.equal(value.intent, 'CREATE')
    // R4（`contracts/tenant-provenance.md`）：ra_s6s7 是 0002_seed 的演示租户（合成数据）⇒ FIXTURE；
    // 排期工具不接日历/会议平台 ⇒ connection=NOT_CONNECTED。**不许**再写死 LIVE（N10 / docs/23 P2-03）。
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
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
    const value = await schedule(client, createArgs(scenario.applicationId), NOW)

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
    const first = await schedule(client, args, NOW)
    assert.equal(first.replayed, false)
    const firstInterviewId = String((first.interview as Record<string, unknown>).id)
    const before = await tableCounts(client)

    // (a) 同一事务里重放同一 key + 同一参数。
    const replay = await schedule(client, args, NOW)
    assert.equal(replay.status, 'OK')
    assert.equal(replay.replayed, true)
    assert.deepEqual((replay.changes as Record<string, unknown>).created, [])
    assert.deepEqual((replay.changes as Record<string, unknown>).updated, [])
    assert.deepEqual((replay.changes as Record<string, unknown>).unchanged, [])
    assert.equal(String((replay.interview as Record<string, unknown>).id), firstInterviewId)
    assert.deepEqual(await tableCounts(client), before, '重放不得写任何行')

    // (b) 让"现在"越过开始时刻：重放必须仍然成功（START_IN_PAST 在 STORE 命中之后才判）。
    const longAfter = Date.parse('2027-01-01T00:00:00Z')
    const replayAfterStart = await schedule(client, args, longAfter)
    assert.equal(replayAfterStart.replayed, true, '时间已过的重放不能被误判成 START_IN_PAST')
    assert.equal(String((replayAfterStart.interview as Record<string, unknown>).id), firstInterviewId)
    assert.deepEqual(await tableCounts(client), before)

    // (c) 同 key 不同参 → IDEMPOTENCY_KEY_REUSED（detail 带两个 digest）。
    const changed = { ...args, scheduled_start_at: at(240) }
    const body = await expectToolError(
      schedule(client, changed, NOW),
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
    const first = await schedule(client, createArgs(scenario.applicationId), NOW)
    const firstInterviewId = String((first.interview as Record<string, unknown>).id)
    const before = await tableCounts(client)

    // 换一个幂等键、同一 slot：语义幂等与 key 无关。
    const body = await expectToolError(
      schedule(client, createArgs(scenario.applicationId), NOW),
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
      schedule(client, createArgs(scenario.applicationId), NOW),
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
    const first = await schedule(
      client, createArgs(firstScenario.applicationId, { scheduled_start_at: START }), NOW,
    )
    const firstInterviewId = String((first.interview as Record<string, unknown>).id)
    const before = await tableCounts(client)

    const body = await expectToolError(
      schedule(
        client,
        createArgs(secondScenario.applicationId, { scheduled_start_at: at(30) }),
        NOW,
      ),
      'CONFLICT_SLOT',
      'INTERVIEWER_BUSY',
    )
    const detail = body.detail as Record<string, unknown>
    const slot = detail.slot as Record<string, unknown>
    assert.equal(slot.start, at(30))
    assert.equal(slot.end, at(90), 'buffer=0 时 slot.end = start + duration')
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
    const first = await schedule(
      client, createArgs(scenario.applicationId, { round_no: 1 }), NOW,
    )
    const firstInterviewId = String((first.interview as Record<string, unknown>).id)
    const before = await tableCounts(client)

    const body = await expectToolError(
      schedule(
        client,
        createArgs(scenario.applicationId, {
          round_no: 2,
          scheduled_start_at: at(30),
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
    const first = await schedule(client, createArgs(firstScenario.applicationId, {
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
      schedule(client, createArgs(secondScenario.applicationId, {
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
    const first = await schedule(client, createArgs(scenario.applicationId, {
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
      schedule(client, createArgs(scenario.applicationId, { interviewers: [] }), NOW),
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
      schedule(client, createArgs(scenario.applicationId, {
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
      schedule(client, createArgs(scenario.applicationId, {
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
      schedule(client, createArgs('00000000-0000-4000-8000-0000000000aa'), NOW),
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
      schedule(client, createArgs(scenario.applicationId, {
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
      schedule(client, createArgs(scenario.applicationId), NOW),
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
    await schedule(client, createArgs(blockerScenario.applicationId, {
      meeting: { provider: 'FEISHU', external_meeting_id: externalId },
    }), NOW)

    // 目标申请：CREATE 会**先** INSERT interview + interviewer，之后才在 meeting 绑定处被拒。
    const targetScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    await expectToolError(
      schedule(client, createArgs(targetScenario.applicationId, {
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

// ---------------------------------------------------------------------------
//  8. D-79 人机闸门：写库前必须 allowed-once；缺省/拒绝/取消 → 五张表零写入
//     （P0：回滚事务实测过"无 approval 也写入成功"，这里是它的回归）
// ---------------------------------------------------------------------------

/** 期望一次调用抛 `FORBIDDEN` + 指定 `reason_code`，并核对 `detail`。 */
async function expectForbidden(
  run: Promise<unknown>,
  reasonCode: 'APPROVAL_UNAVAILABLE' | 'APPROVAL_NOT_GRANTED',
  approval: 'unavailable' | 'rejected' | 'cancelled' | 'timeout',
): Promise<Record<string, unknown>> {
  const body = await expectToolError(run, 'FORBIDDEN', reasonCode)
  assert.deepEqual(body.detail, { approval, tool: 'recruitment_interview_schedule' })
  return body
}

test('D-79：没有 approval（缺省）→ FORBIDDEN(APPROVAL_UNAVAILABLE)，五张表零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    await expectForbidden(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId), NOW),
      'APPROVAL_UNAVAILABLE',
      'unavailable',
    )
    assertNoWrites(before, await tableCounts(client), '无 approval')
  })
})

test('D-79：approval=rejected → FORBIDDEN(APPROVAL_NOT_GRANTED)，五张表零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    await expectForbidden(
      scheduleInTransaction(
        client, cfg, createArgs(scenario.applicationId), NOW, async () => 'rejected',
      ),
      'APPROVAL_NOT_GRANTED',
      'rejected',
    )
    assertNoWrites(before, await tableCounts(client), 'approval=rejected')
  })
})

test('D-79：approval=cancelled → FORBIDDEN(APPROVAL_NOT_GRANTED)，五张表零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    await expectForbidden(
      scheduleInTransaction(
        client, cfg, createArgs(scenario.applicationId), NOW, async () => 'cancelled',
      ),
      'APPROVAL_NOT_GRANTED',
      'cancelled',
    )
    assertNoWrites(before, await tableCounts(client), 'approval=cancelled')
  })
})

test('D-79：approval=allowed-once → 写入成功（interview 恰好 +1）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    const value = await scheduleInTransaction(
      client, cfg, createArgs(scenario.applicationId), NOW, allowOnce,
    )
    assert.equal(value.status, 'OK')
    assert.equal(value.replayed, false)
    assert.equal((await tableCounts(client)).interview, before.interview + 1)
  })
})

test('D-79：参数非法 → 拒绝且**不去问人**（approval 调用数 = 0）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    let approvalCalls = 0
    const spy = async (): Promise<'allowed-once'> => {
      approvalCalls += 1
      return 'allowed-once'
    }
    const before = await tableCounts(client)
    await expectToolError(
      scheduleInTransaction(
        client, cfg, createArgs(scenario.applicationId, { interviewers: [] }), NOW, spy,
      ),
      'INVALID_ARGS',
      'INTERVIEWER_REQUIRED',
    )
    assert.equal(approvalCalls, 0, '参数层就拒了，不得打扰人')
    assertNoWrites(before, await tableCounts(client), '参数非法')
  })
})

test('D-79：业务校验失败（申请不存在）→ 也不去问人（approval 调用数 = 0）', async () => {
  await inRolledBackTx(pool, async (client) => {
    let approvalCalls = 0
    const spy = async (): Promise<'allowed-once'> => {
      approvalCalls += 1
      return 'allowed-once'
    }
    const before = await tableCounts(client)
    await expectToolError(
      scheduleInTransaction(
        client, cfg, createArgs('00000000-0000-4000-8000-0000000000aa'), NOW, spy,
      ),
      'NOT_FOUND',
      'APPLICATION_NOT_FOUND',
    )
    assert.equal(approvalCalls, 0, '业务校验就拒了，不得打扰人')
    assertNoWrites(before, await tableCounts(client), '业务校验失败')
  })
})

// ---------------------------------------------------------------------------
//  8b. approval 等待超时（生产 120s 上界，测试注入 25ms）
//      超时按 cancelled 判 → FORBIDDEN(APPROVAL_NOT_GRANTED, approval='timeout')，五张表零写入；
//      超时后宿主才 resolve 的 Allow **不采纳**（防竞态写库）。
// ---------------------------------------------------------------------------

test('D-79：approval 等待超时 → FORBIDDEN(APPROVAL_NOT_GRANTED, approval=timeout)，五张表零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    // 宿主永远不回答；注入 25ms 超时（`APPROVAL_TIMEOUT_MS` 在生产是 120_000ms）。
    const approve = makeApprovalRequest(
      { request: () => new Promise<string>(() => undefined) },
      undefined,
      25,
    )
    await expectForbidden(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId), NOW, approve),
      'APPROVAL_NOT_GRANTED',
      'timeout',
    )
    assertNoWrites(before, await tableCounts(client), 'approval 超时')
  })
})

test('D-79：超时后原 approval 才 resolve → 仍然不采纳（竞态零写入）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    let resolveLate: ((value: string) => void) | undefined
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve
    })
    const approve = makeApprovalRequest({ request: () => late }, undefined, 25)
    await expectForbidden(
      scheduleInTransaction(client, cfg, createArgs(scenario.applicationId), NOW, approve),
      'APPROVAL_NOT_GRANTED',
      'timeout',
    )
    // 超时之后宿主 UI 才点了 Allow：工具已返回、事务已回滚，不得补写任何行。
    resolveLate?.('allowed-once')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assertNoWrites(before, await tableCounts(client), '超时后的批准')
  })
})

// ---------------------------------------------------------------------------
//  9. 其余三个 intent（D-62）：RESCHEDULE / CANCEL / WITHDRAW_INTERVIEWER
//     每个 intent 至少四类：正向 + 幂等 + 闸门拒绝 + 非法状态迁移。
//     **时段一律由 `at(minutes)` 派生**（文件头的 SLOT_BASE_MS 不许写死，见它的说明）。
// ---------------------------------------------------------------------------

/** 一场面试当前的排期关键列（直接用 SQL 读，不经过工具）。 */
interface InterviewStateRow {
  readonly status: string
  readonly record_version: number
  readonly scheduled_start_at: string | Date
  readonly scheduled_end_at: string | Date
  readonly status_source_event_id: string | null
}

/** 读一场面试的当前状态。 */
async function readState(client: DatabaseClient, interviewId: string): Promise<InterviewStateRow> {
  const { rows } = await client.query<InterviewStateRow>(
    `select status, record_version, scheduled_start_at, scheduled_end_at, status_source_event_id
       from recruitment.interview
      where id = $1 and tenant_id = $2`,
    [interviewId, TENANT],
  )
  const row = rows[0]
  assert.ok(row !== undefined, `interview ${interviewId} 不存在`)
  return row
}

/** CREATE 一场并返回 `{id, version}`（测试夹具）。 */
async function scheduleNew(
  client: DatabaseClient,
  applicationId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ readonly id: string; readonly version: number }> {
  const value = await schedule(client, createArgs(applicationId, overrides), NOW)
  const interview = value.interview as Record<string, unknown>
  return { id: String(interview.id), version: Number(interview.record_version) }
}

/** RESCHEDULE 入参（幂等键每次不同；默认挪到 `at(1440)`）。 */
function rescheduleArgs(
  interviewId: string,
  expectedRecordVersion: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    intent: 'RESCHEDULE',
    idempotency_key: `it-${uniqueSuffix()}`,
    interview_id: interviewId,
    expected_record_version: expectedRecordVersion,
    scheduled_start_at: at(1440),
    ...overrides,
  }
}

/** CANCEL 入参。 */
function cancelArgs(
  interviewId: string,
  expectedRecordVersion: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    intent: 'CANCEL',
    idempotency_key: `it-${uniqueSuffix()}`,
    interview_id: interviewId,
    expected_record_version: expectedRecordVersion,
    reason: '候选人改约，本次取消',
    ...overrides,
  }
}

/** WITHDRAW_INTERVIEWER 入参。 */
function withdrawArgs(
  interviewerId: string,
  expectedRecordVersion: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    intent: 'WITHDRAW_INTERVIEWER',
    idempotency_key: `it-${uniqueSuffix()}`,
    interviewer_id: interviewerId,
    expected_record_version: expectedRecordVersion,
    reason: '面试官临时请假',
    ...overrides,
  }
}

/** 取一场面试里某个 actor 的 interviewer 行 id。 */
async function interviewerRowId(
  client: DatabaseClient,
  interviewId: string,
  actorId: string,
): Promise<string> {
  return await one(
    client,
    `select id from recruitment.interviewer
      where tenant_id = $1 and interview_id = $2 and actor_id = $3`,
    [TENANT, interviewId, actorId],
  )
}

/** 本工具写出的审计事件（按 `payload.interview_id` 归到一场面试）。 */
async function readAuditEvents(
  client: DatabaseClient,
  eventType: string,
  interviewId: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select event_id, provider, event_type, trust_level, idempotency_key, source_object_id, payload
       from recruitment.event_inbox
      where tenant_id = $1 and event_type = $2 and payload->>'interview_id' = $3
      order by recorded_at, event_id`,
    [TENANT, eventType, interviewId],
  )
  return rows
}

/** `event_inbox` 行数（审计写入的零写入证明；失败路径必须不变）。 */
async function eventCount(client: DatabaseClient): Promise<number> {
  return await count(client, 'select count(*)::int as n from recruitment.event_inbox')
}

/** 一场面试当前全部 active binding（含 meeting 的角色与平台 ID）。 */
async function activeBindingRows(
  client: DatabaseClient,
  interviewId: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select b.id as binding_id, b.meeting_id, b.unbound_at, b.unbound_reason,
            m.meeting_role, m.external_meeting_id
       from recruitment.meeting_binding b
       join recruitment.meeting m on m.id = b.meeting_id and m.tenant_id = b.tenant_id
      where b.tenant_id = $1 and b.interview_id = $2 and b.unbound_at is null
      order by b.bound_at, b.id`,
    [TENANT, interviewId],
  )
  return rows
}

/** `changes` 里的 `table:id` 列表（逐行断言比只看长度更强）。 */
function changePairs(changes: Record<string, unknown>, bucket: 'created' | 'updated'): string[] {
  const rows = changes[bucket]
  assert.ok(Array.isArray(rows), `changes.${bucket} 必须是数组`)
  return rows.map((row) => {
    const item = row as Record<string, unknown>
    return `${String(item.table)}:${String(item.id)}`
  })
}

/** 期望一次调用抛 `FORBIDDEN`（D-79 闸门），并核对 `detail`。 */
async function expectForbiddenOutcome(
  run: Promise<unknown>,
  reasonCode: 'APPROVAL_UNAVAILABLE' | 'APPROVAL_NOT_GRANTED',
  approval: 'unavailable' | 'rejected' | 'cancelled' | 'timeout',
): Promise<void> {
  const body = await expectToolError(run, 'FORBIDDEN', reasonCode)
  assert.deepEqual(body.detail, { approval, tool: 'recruitment_interview_schedule' })
}

// ---------------------------------------------------------------------------
//  9a. RESCHEDULE
// ---------------------------------------------------------------------------

test('RESCHEDULE 正向：改同一行的时间 + interview.rescheduled 事件（from/to/actor/reason/reschedule_no）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    const beforeEvents = await eventCount(client)
    const args = rescheduleArgs(created.id, created.version, {
      scheduled_start_at: at(1440),
      duration_minutes: 90,
      reason: '面试官改约',
    })

    const value = await schedule(client, args, NOW)

    assert.equal(value.intent, 'RESCHEDULE')
    assert.equal(value.contract_version, '1.1.0')
    assert.equal(value.status, 'OK')
    assert.equal(value.write, true)
    assert.equal(value.replayed, false)
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
    assert.deepEqual(value.effects, { meeting_bound: false, external_call_made: false })
    assertNoNulls(value)

    const interview = value.interview as Record<string, unknown>
    assert.equal(String(interview.id), created.id, 'H-1：改期必须改同一行，不新建')
    assert.equal(interview.status, 'SCHEDULED')
    assert.equal(interview.scheduled_start_at, at(1440))
    assert.equal(interview.scheduled_end_at, at(1530))
    assert.equal(interview.duration_minutes, 90)
    assert.equal(interview.record_version, created.version + 1)

    // 落库：同一行、只有一行。
    const state = await readState(client, created.id)
    assert.equal(state.status, 'SCHEDULED')
    assert.equal(iso(state.scheduled_start_at), at(1440))
    assert.equal(iso(state.scheduled_end_at), at(1530))
    assert.equal(state.record_version, created.version + 1)
    assert.equal(
      await count(
        client,
        'select count(*)::int as n from recruitment.interview where application_id = $1',
        [scenario.applicationId],
      ),
      1,
      '不得新建第二行（uq_interview_slot / H-1）',
    )

    // changes：updated 里有 interview；created 里有审计事件 + 幂等 STORE。
    const changes = value.changes as Record<string, unknown>
    assert.deepEqual(changePairs(changes, 'updated'), [`interview:${created.id}`])
    const createdPairs = changePairs(changes, 'created')
    assert.ok(createdPairs.some((pair) => pair.startsWith('event_inbox:')))
    assert.ok(createdPairs.some((pair) => pair.startsWith('business_task:')))

    // 显式审计事件（§4.4 / §11-①：同状态改时间 fn_row_guard 不写事件，必须服务层写）。
    const events = await readAuditEvents(client, 'interview.rescheduled', created.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.provider, 'internal')
    assert.equal(events[0]?.trust_level, 'INTERNAL')
    assert.equal(events[0]?.source_object_id, created.id)
    const payload = events[0]?.payload as Record<string, unknown>
    assert.deepEqual(payload.from, { start: START_ISO, end: END_ISO })
    assert.deepEqual(payload.to, { start: at(1440), end: at(1530) })
    assert.equal(payload.actor_id, HR_ACTOR)
    assert.equal(payload.reason, '面试官改约')
    assert.equal(payload.reschedule_no, 1)
    assert.equal(payload.status_from, 'SCHEDULED')
    assert.equal(payload.status_to, 'SCHEDULED')
    assert.equal(await eventCount(client), beforeEvents + 1, '只写一条显式事件（同状态改时间没有触发器的状态事件）')

    // 幂等 STORE（§4.3）。
    const store = (await client.query<Record<string, unknown>>(
      `select id, task_type, status, result_ref
         from recruitment.business_task
        where tenant_id = $1 and idempotency_key = $2`,
      [TENANT, `interview_schedule:${String(args.idempotency_key)}`],
    )).rows
    assert.equal(store.length, 1)
    assert.equal(store[0]?.task_type, 'INTERVIEW_SCHEDULE')
    assert.equal(store[0]?.status, 'SUCCEEDED')
    assert.equal(store[0]?.result_ref, created.id)
  })
})

test('RESCHEDULE 幂等：同 key 同参 → replayed=true 零写入；同 key 不同参 → IDEMPOTENCY_KEY_REUSED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    const args = rescheduleArgs(created.id, created.version)
    const first = await schedule(client, args, NOW)
    assert.equal(first.replayed, false)

    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)

    const replay = await schedule(client, args, NOW)
    assert.equal(replay.status, 'OK')
    assert.equal(replay.replayed, true)
    assert.equal(replay.intent, 'RESCHEDULE')
    assert.deepEqual((replay.changes as Record<string, unknown>).created, [])
    assert.deepEqual((replay.changes as Record<string, unknown>).updated, [])
    assert.deepEqual((replay.changes as Record<string, unknown>).unchanged, [])
    assert.equal(String((replay.interview as Record<string, unknown>).id), created.id)
    assert.equal((replay.interview as Record<string, unknown>).scheduled_start_at, at(1440))
    assert.deepEqual(await tableCounts(client), before, '重放不得写任何行')
    assert.equal(await eventCount(client), beforeEvents, '重放不得写审计事件')

    const body = await expectToolError(
      schedule(client, { ...args, scheduled_start_at: at(1500) }, NOW),
      'INVALID_ARGS',
      'IDEMPOTENCY_KEY_REUSED',
    )
    const detail = body.detail as Record<string, unknown>
    assert.match(String(detail.first_args_digest), /^sha256:[0-9a-f]{64}$/)
    assert.match(String(detail.this_args_digest), /^sha256:[0-9a-f]{64}$/)
    assert.notEqual(detail.first_args_digest, detail.this_args_digest)
    assert.deepEqual(await tableCounts(client), before, '键复用不得写任何行')
    assert.equal(await eventCount(client), beforeEvents)
  })
})

test('RESCHEDULE 闸门（D-79）：approval 缺省/拒绝 → FORBIDDEN，面试行不变、零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)

    // 缺省 approval = unavailable（fail closed）。
    await expectForbiddenOutcome(
      scheduleInTransaction(client, cfg, rescheduleArgs(created.id, created.version), NOW),
      'APPROVAL_UNAVAILABLE',
      'unavailable',
    )
    const afterUnavailable = await readState(client, created.id)
    assert.equal(afterUnavailable.status, 'SCHEDULED')
    assert.equal(afterUnavailable.record_version, created.version)
    assert.equal(iso(afterUnavailable.scheduled_start_at), START_ISO)

    // 人拒绝：同样一行不写。
    await expectForbiddenOutcome(
      scheduleInTransaction(
        client, cfg, rescheduleArgs(created.id, created.version), NOW, async () => 'rejected',
      ),
      'APPROVAL_NOT_GRANTED',
      'rejected',
    )
    assert.deepEqual(await tableCounts(client), before, '闸门拒绝必须零写入')
    assert.equal(await eventCount(client), beforeEvents, '闸门拒绝不得写审计事件')
  })
})

test('RESCHEDULE 非法迁移/版本冲突：POST_INTERVIEW → INVALID_STATE_TRANSITION；旧版本 → VERSION_CONFLICT，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    await client.query(
      `update recruitment.interview set status = 'POST_INTERVIEW' where id = $1 and tenant_id = $2`,
      [created.id, TENANT],
    )
    const posted = await readState(client, created.id)
    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)

    const body = await expectToolError(
      schedule(client, rescheduleArgs(created.id, posted.record_version), NOW),
      'INVALID_ARGS',
      'INVALID_STATE_TRANSITION',
    )
    assert.equal((body.detail as Record<string, unknown>).status, 'POST_INTERVIEW')
    assert.deepEqual(await tableCounts(client), before, '非法迁移必须零写入')
    assert.equal(await eventCount(client), beforeEvents)

    // 版本落后（用更大的期望版本制造 STALE，避免 0 被形状层栏成 OUT_OF_RANGE）。
    const secondScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const second = await scheduleNew(client, secondScenario.applicationId)
    const secondBefore = await tableCounts(client)
    const secondEvents = await eventCount(client)
    const versionBody = await expectToolError(
      schedule(client, rescheduleArgs(second.id, second.version + 1), NOW),
      'VERSION_CONFLICT',
      'STALE_RECORD_VERSION',
    )
    const detail = versionBody.detail as Record<string, unknown>
    assert.equal(detail.expected_record_version, second.version + 1)
    assert.equal(detail.actual_record_version, second.version)
    assert.deepEqual(await tableCounts(client), secondBefore, 'VERSION_CONFLICT 必须零写入')
    assert.equal(await eventCount(client), secondEvents, 'VERSION_CONFLICT 不得写审计事件')
  })
})

test('RESCHEDULE 冲突重算：新时段撞面试官/候选人 → CONFLICT_SLOT，面试行不变、零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 面试官冲突：两个不同申请、同一面试官 A。
    const firstScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const secondScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const first = await scheduleNew(client, firstScenario.applicationId, { scheduled_start_at: START })
    const second = await scheduleNew(client, secondScenario.applicationId, { scheduled_start_at: at(1440) })
    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)

    const body = await expectToolError(
      schedule(client, rescheduleArgs(second.id, second.version, { scheduled_start_at: at(30) }), NOW),
      'CONFLICT_SLOT',
      'INTERVIEWER_BUSY',
    )
    const conflicts = (body.detail as Record<string, unknown>).conflicts as Record<string, unknown>[]
    assert.ok(conflicts.length >= 1, 'CONFLICT_SLOT 必须逐条回列冲突')
    assert.equal(conflicts[0]?.kind, 'INTERVIEWER')
    assert.equal(conflicts[0]?.ref_kind, 'INTERVIEW')
    assert.equal(conflicts[0]?.ref_id, first.id, '改期要排除自己、只报**别的**场次')
    assert.equal((await readState(client, second.id)).record_version, second.version)
    assert.deepEqual(await tableCounts(client), before)
    assert.equal(await eventCount(client), beforeEvents)

    // 候选人冲突：同一申请的 round 1 / round 2（不同面试官、不同时段），把 round 2 挪进 round 1 的窗口。
    const thirdScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const round1 = await scheduleNew(client, thirdScenario.applicationId, {
      round_no: 1,
      scheduled_start_at: at(3000),
    })
    const round2 = await scheduleNew(client, thirdScenario.applicationId, {
      round_no: 2,
      scheduled_start_at: at(1440),
      interviewers: [{ actor_id: INTERVIEWER_B }],
    })
    const candidateBody = await expectToolError(
      schedule(client, rescheduleArgs(round2.id, round2.version, { scheduled_start_at: at(3030) }), NOW),
      'CONFLICT_SLOT',
      'CANDIDATE_BUSY',
    )
    const candidateConflicts = (candidateBody.detail as Record<string, unknown>).conflicts as Record<string, unknown>[]
    assert.ok(candidateConflicts.length >= 1)
    assert.equal(candidateConflicts[0]?.kind, 'CANDIDATE')
    assert.equal(candidateConflicts[0]?.ref_id, round1.id)
  })
})

test('RESCHEDULE 换会议：旧 binding 解绑 + 旧 meeting 标 REPLACED + 新 binding 生效（§4.2 第 2 步）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const oldExternal = `feishu-${uniqueSuffix()}`
    const newExternal = `feishu-${uniqueSuffix()}`
    const created = await scheduleNew(client, scenario.applicationId, {
      meeting: { provider: 'FEISHU', external_meeting_id: oldExternal },
    })

    const value = await schedule(client, rescheduleArgs(created.id, created.version, {
      meeting: { provider: 'FEISHU', external_meeting_id: newExternal },
    }), NOW)

    assert.equal(value.replayed, false)
    assert.deepEqual(value.effects, { meeting_bound: true, external_call_made: false })
    const binding = (value.interview as Record<string, unknown>).meeting_binding as Record<string, unknown>
    assert.equal(binding.state, 'BOUND_ACTIVE')
    assert.equal(binding.count, 1)
    const bindings = binding.bindings as Record<string, unknown>[]
    assert.equal(bindings[0]?.external_meeting_id, newExternal)
    assert.equal(bindings[0]?.meeting_role, 'PRIMARY')
    assert.deepEqual(value.warnings, [])

    // 旧 binding 解绑（unbound_reason 必须非空，ck_meeting_binding_unbound）+ 旧 meeting REPLACED。
    const old = (await client.query<Record<string, unknown>>(
      `select b.id as binding_id, b.unbound_at, b.unbound_reason, m.id as meeting_id, m.meeting_role
         from recruitment.meeting m
         join recruitment.meeting_binding b on b.meeting_id = m.id and b.tenant_id = m.tenant_id
        where m.tenant_id = $1 and m.external_meeting_id = $2`,
      [TENANT, oldExternal],
    )).rows[0]
    assert.ok(old !== undefined)
    assert.equal(old.unbound_reason, 'INTERVIEW_RESCHEDULED')
    assert.ok(
      old.unbound_at instanceof Date || typeof old.unbound_at === 'string',
      'unbound_at 必须被写（行保留、软关闭）',
    )
    assert.equal(old.meeting_role, 'REPLACED')
    const updatedPairs = changePairs(value.changes as Record<string, unknown>, 'updated')
    assert.ok(updatedPairs.includes(`meeting:${String(old.meeting_id)}`))
    assert.ok(updatedPairs.includes(`meeting_binding:${String(old.binding_id)}`))
    assert.ok(
      changePairs(value.changes as Record<string, unknown>, 'created').some((pair) => pair.startsWith('meeting:')),
      '新 meeting 行要出现在 changes.created',
    )
  })
})

test('RESCHEDULE 复活已取消的场次（§6.3）：CANCELLED → SCHEDULED，仍是同一行', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    const cancelled = await schedule(client, cancelArgs(created.id, created.version), NOW)
    assert.equal((cancelled.interview as Record<string, unknown>).status, 'CANCELLED')
    const afterCancel = await readState(client, created.id)

    const value = await schedule(
      client,
      rescheduleArgs(created.id, afterCancel.record_version, { scheduled_start_at: at(2880) }),
      NOW,
    )
    assert.equal(value.intent, 'RESCHEDULE')
    assert.equal((value.interview as Record<string, unknown>).status, 'SCHEDULED')
    assert.equal(String((value.interview as Record<string, unknown>).id), created.id)
    assert.equal((await readState(client, created.id)).status, 'SCHEDULED')
  })
})

// ---------------------------------------------------------------------------
//  9b. CANCEL
// ---------------------------------------------------------------------------

test('CANCEL 正向：status=CANCELLED + interview.cancelled 事件 + 未发生的会议解绑并标 CANCELLED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const external = `feishu-${uniqueSuffix()}`
    const created = await scheduleNew(client, scenario.applicationId, {
      meeting: { provider: 'FEISHU', external_meeting_id: external },
    })
    const beforeEvents = await eventCount(client)
    const args = cancelArgs(created.id, created.version, { reason: '候选人已接受其它 offer' })

    const value = await schedule(client, args, NOW)

    assert.equal(value.intent, 'CANCEL')
    assert.equal(value.contract_version, '1.1.0')
    assert.equal(value.replayed, false)
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
    assert.deepEqual(value.effects, { meeting_bound: false, external_call_made: false })
    assertNoNulls(value)

    const interview = value.interview as Record<string, unknown>
    assert.equal(interview.status, 'CANCELLED')
    assert.equal(interview.record_version, created.version + 1)
    assert.equal(
      String((interview.meeting_binding as Record<string, unknown>).state),
      'NONE_EXPECTED',
      '取消后没有 active binding → NONE_EXPECTED（§7.2）',
    )

    // 行保留（trg_interview_no_delete），版本 +1，触发器回填 status_source_event_id。
    const state = await readState(client, created.id)
    assert.equal(state.status, 'CANCELLED')
    assert.equal(state.record_version, created.version + 1)
    assert.ok(state.status_source_event_id !== null, 'fn_row_guard 必须回填 status_source_event_id')

    // 显式审计事件（SC-X5：interview 没有 cancel_reason 列，理由只能落事件 payload）。
    const events = await readAuditEvents(client, 'interview.cancelled', created.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.provider, 'internal')
    assert.equal(events[0]?.trust_level, 'INTERNAL')
    assert.equal(events[0]?.source_object_id, created.id)
    const payload = events[0]?.payload as Record<string, unknown>
    assert.equal(payload.reason, '候选人已接受其它 offer')
    assert.equal(payload.from_status, 'SCHEDULED')
    assert.equal(payload.to_status, 'CANCELLED')
    assert.equal(payload.actor_id, HR_ACTOR)
    assert.equal(await eventCount(client), beforeEvents + 2, '触发器状态事件 + 显式取消事件各 1 条')

    // SC-X6：会议尚未发生 → 解绑（理由非空）+ meeting_role=CANCELLED。
    assert.deepEqual(await activeBindingRows(client, created.id), [])
    const meeting = (await client.query<Record<string, unknown>>(
      `select b.unbound_at, b.unbound_reason, m.meeting_role
         from recruitment.meeting_binding b
         join recruitment.meeting m on m.id = b.meeting_id and m.tenant_id = b.tenant_id
        where b.tenant_id = $1 and b.interview_id = $2`,
      [TENANT, created.id],
    )).rows[0]
    assert.equal(meeting?.unbound_reason, 'INTERVIEW_CANCELLED')
    assert.ok(meeting?.unbound_at instanceof Date || typeof meeting?.unbound_at === 'string')
    assert.equal(meeting?.meeting_role, 'CANCELLED')

    const changes = value.changes as Record<string, unknown>
    const updatedPairs = changePairs(changes, 'updated')
    assert.ok(updatedPairs.includes(`interview:${created.id}`))
    assert.ok(updatedPairs.some((pair) => pair.startsWith('meeting_binding:')))
    assert.ok(updatedPairs.some((pair) => pair.startsWith('meeting:')))
    assert.ok(changePairs(changes, 'created').some((pair) => pair.startsWith('event_inbox:')))
    assert.ok(changePairs(changes, 'created').some((pair) => pair.startsWith('business_task:')))
  })
})

test('CANCEL 幂等：同 key 重放零写入；换 key 重复取消 → 成功且零写入、不重复写事件（§6.1）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    const args = cancelArgs(created.id, created.version, { reason: '同一理由' })
    const first = await schedule(client, args, NOW)
    assert.equal(first.replayed, false)
    const afterCancel = await readState(client, created.id)

    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)

    // (a) 同 key 同参 → 重放：零写入。
    const replay = await schedule(client, args, NOW)
    assert.equal(replay.replayed, true)
    assert.equal(replay.intent, 'CANCEL')
    assert.equal((replay.interview as Record<string, unknown>).status, 'CANCELLED')
    assert.deepEqual((replay.changes as Record<string, unknown>).created, [])
    assert.deepEqual((replay.changes as Record<string, unknown>).updated, [])
    assert.deepEqual(await tableCounts(client), before, '重放不得写任何行')
    assert.equal(await eventCount(client), beforeEvents, '重放不得写审计事件')

    // 同 key 不同参（reason 变了）→ IDEMPOTENCY_KEY_REUSED，零写入。
    const reused = await expectToolError(
      schedule(client, { ...args, reason: '另一个理由' }, NOW),
      'INVALID_ARGS',
      'IDEMPOTENCY_KEY_REUSED',
    )
    assert.match(String((reused.detail as Record<string, unknown>).first_args_digest), /^sha256:[0-9a-f]{64}$/)
    assert.deepEqual(await tableCounts(client), before, '键复用不得写任何行')
    assert.equal(await eventCount(client), beforeEvents)

    // (b) 换 key 重复取消 → 幂等成功、零写入、不重复写事件（§6.1 的"CANCELLED 上重复取消"）。
    const noop = await schedule(
      client,
      cancelArgs(created.id, afterCancel.record_version, { reason: '同一理由' }),
      NOW,
    )
    assert.equal(noop.status, 'OK')
    assert.equal(noop.replayed, false)
    assert.equal((noop.interview as Record<string, unknown>).status, 'CANCELLED')
    assert.deepEqual((noop.changes as Record<string, unknown>).created, [])
    assert.deepEqual((noop.changes as Record<string, unknown>).updated, [])
    assert.deepEqual(await tableCounts(client), before, '重复取消不得写任何行')
    assert.equal(await eventCount(client), beforeEvents, '不重复写事件')
    assert.equal((await readState(client, created.id)).record_version, afterCancel.record_version, '不得再 bump 版本')
  })
})

test('CANCEL 闸门（D-79）：approval 缺省/拒绝 → FORBIDDEN，面试仍 SCHEDULED、零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)

    await expectForbiddenOutcome(
      scheduleInTransaction(client, cfg, cancelArgs(created.id, created.version), NOW),
      'APPROVAL_UNAVAILABLE',
      'unavailable',
    )
    const afterUnavailable = await readState(client, created.id)
    assert.equal(afterUnavailable.status, 'SCHEDULED')
    assert.equal(afterUnavailable.record_version, created.version)

    await expectForbiddenOutcome(
      scheduleInTransaction(
        client, cfg, cancelArgs(created.id, created.version), NOW, async () => 'rejected',
      ),
      'APPROVAL_NOT_GRANTED',
      'rejected',
    )
    assert.deepEqual(await tableCounts(client), before, '闸门拒绝必须零写入')
    assert.equal(await eventCount(client), beforeEvents, '闸门拒绝不得写审计事件')
  })
})

test('CANCEL 非法状态迁移：IN_PROGRESS/POST_INTERVIEW/NO_SHOW/EVALUATION_READY/DECIDED → INVALID_STATE_TRANSITION，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const statuses = ['IN_PROGRESS', 'POST_INTERVIEW', 'NO_SHOW', 'EVALUATION_READY', 'DECIDED']
    for (const [index, status] of statuses.entries()) {
      const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
      // 每个状态用不同时段：IN_PROGRESS 仍占位（SC-C4），同面试官同窗口会先撞冲突。
      const created = await scheduleNew(client, scenario.applicationId, {
        scheduled_start_at: at(720 * index),
      })
      await client.query(
        `update recruitment.interview set status = $1 where id = $2 and tenant_id = $3`,
        [status, created.id, TENANT],
      )
      const current = await readState(client, created.id)
      const before = await tableCounts(client)
      const beforeEvents = await eventCount(client)

      const body = await expectToolError(
        schedule(client, cancelArgs(created.id, current.record_version), NOW),
        'INVALID_ARGS',
        'INVALID_STATE_TRANSITION',
      )
      assert.equal((body.detail as Record<string, unknown>).status, status)
      assert.deepEqual(await tableCounts(client), before, `${status} 上的 CANCEL 必须零写入`)
      assert.equal(await eventCount(client), beforeEvents, `${status} 上的 CANCEL 不得写审计事件`)
    }

    // 旧版本（SC-K6）：VERSION_CONFLICT，detail 给真实版本。
    const versionScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    // 避开上面各状态用例仍占位的窗口（IN_PROGRESS 占位，SC-C4）。
    const versionTarget = await scheduleNew(client, versionScenario.applicationId, {
      scheduled_start_at: at(720 * statuses.length),
    })
    const versionBefore = await tableCounts(client)
    const versionEvents = await eventCount(client)
    const versionBody = await expectToolError(
      schedule(client, cancelArgs(versionTarget.id, versionTarget.version + 1), NOW),
      'VERSION_CONFLICT',
      'STALE_RECORD_VERSION',
    )
    const versionDetail = versionBody.detail as Record<string, unknown>
    assert.equal(versionDetail.expected_record_version, versionTarget.version + 1)
    assert.equal(versionDetail.actual_record_version, versionTarget.version)
    assert.deepEqual(await tableCounts(client), versionBefore)
    assert.equal(await eventCount(client), versionEvents)
  })
})

// ---------------------------------------------------------------------------
//  9c. WITHDRAW_INTERVIEWER
// ---------------------------------------------------------------------------

test('WITHDRAW_INTERVIEWER 正向：required_scorecard=false + interviewer.withdrawn 事件 + touch interview（status 不变）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId, {
      interviewers: [{ actor_id: INTERVIEWER_A }, { actor_id: INTERVIEWER_B }],
    })
    const interviewerId = await interviewerRowId(client, created.id, INTERVIEWER_A)
    const beforeEvents = await eventCount(client)
    const args = withdrawArgs(interviewerId, created.version, { reason: '面试官请假' })

    const value = await schedule(client, args, NOW)

    assert.equal(value.intent, 'WITHDRAW_INTERVIEWER')
    assert.equal(value.contract_version, '1.1.0')
    assert.equal(value.replayed, false)
    assertNoNulls(value)

    const interview = value.interview as Record<string, unknown>
    assert.equal(interview.status, 'SCHEDULED', '§4.3：不改 interview.status')
    assert.equal(interview.record_version, created.version + 1, 'SC-K7：必须 touch interview 借版本')
    assert.equal((interview.interviewers as unknown[]).length, 2, '不删 interviewer 行')

    const rows = (await client.query<Record<string, unknown>>(
      `select id, actor_id, required_scorecard
         from recruitment.interviewer
        where interview_id = $1 and tenant_id = $2
        order by actor_id`,
      [created.id, TENANT],
    )).rows
    assert.equal(rows.length, 2, '不删行（trg_interviewer_no_delete）')
    const target = rows.find((row) => row.id === interviewerId)
    assert.equal(target?.required_scorecard, false, '退出者不再阻塞 Evaluation Ready（§4.3 第 1 步）')

    // §4.3 第 2 步的 payload 必填键。
    const events = await readAuditEvents(client, 'interviewer.withdrawn', created.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.source_object_id, interviewerId)
    const payload = events[0]?.payload as Record<string, unknown>
    assert.equal(payload.interview_id, created.id)
    assert.equal(payload.interviewer_id, interviewerId)
    assert.equal(payload.actor_id, INTERVIEWER_A)
    assert.equal(payload.reason, '面试官请假')
    assert.equal(payload.effective_from, new Date(NOW).toISOString())
    assert.equal(await eventCount(client), beforeEvents + 1, '只写一条 interviewer.withdrawn 事件')

    const updatedPairs = changePairs(value.changes as Record<string, unknown>, 'updated')
    assert.ok(updatedPairs.includes(`interview:${created.id}`))
    assert.ok(updatedPairs.includes(`interviewer:${interviewerId}`))
    assert.ok(changePairs(value.changes as Record<string, unknown>, 'created').some((pair) => pair.startsWith('event_inbox:')))
  })
})

test('WITHDRAW_INTERVIEWER 幂等：同 key 重放零写入；换 key 重复退出 → 成功且零写入、不重复写事件', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    const interviewerId = await interviewerRowId(client, created.id, INTERVIEWER_A)
    const args = withdrawArgs(interviewerId, created.version)
    const first = await schedule(client, args, NOW)
    assert.equal(first.replayed, false)
    const afterWithdraw = await readState(client, created.id)

    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)

    const replay = await schedule(client, args, NOW)
    assert.equal(replay.replayed, true)
    assert.deepEqual((replay.changes as Record<string, unknown>).created, [])
    assert.deepEqual((replay.changes as Record<string, unknown>).updated, [])
    assert.deepEqual(await tableCounts(client), before, '重放不得写任何行')
    assert.equal(await eventCount(client), beforeEvents, '重放不得写审计事件')

    // 同 key 不同参（reason 变了）→ IDEMPOTENCY_KEY_REUSED，零写入。
    const reused = await expectToolError(
      schedule(client, { ...args, reason: '另一个理由' }, NOW),
      'INVALID_ARGS',
      'IDEMPOTENCY_KEY_REUSED',
    )
    assert.match(String((reused.detail as Record<string, unknown>).first_args_digest), /^sha256:[0-9a-f]{64}$/)
    assert.deepEqual(await tableCounts(client), before, '键复用不得写任何行')
    assert.equal(await eventCount(client), beforeEvents)

    // 换 key 再退一次（该人已退出）→ 幂等成功、零写入、不重复写事件。
    const noop = await schedule(
      client,
      withdrawArgs(interviewerId, afterWithdraw.record_version, { reason: '再次提交' }),
      NOW,
    )
    assert.equal(noop.status, 'OK')
    assert.equal(noop.replayed, false)
    assert.deepEqual((noop.changes as Record<string, unknown>).created, [])
    assert.deepEqual((noop.changes as Record<string, unknown>).updated, [])
    assert.deepEqual(await tableCounts(client), before, '重复退出不得写任何行')
    assert.equal(await eventCount(client), beforeEvents, '不重复写事件')
    assert.equal(
      (await readState(client, created.id)).record_version,
      afterWithdraw.record_version,
      '不得再 bump 版本',
    )
  })
})

test('WITHDRAW_INTERVIEWER 闸门（D-79）：approval 缺省/拒绝 → FORBIDDEN，required_scorecard 仍为 true、零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    const interviewerId = await interviewerRowId(client, created.id, INTERVIEWER_A)
    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)

    await expectForbiddenOutcome(
      scheduleInTransaction(client, cfg, withdrawArgs(interviewerId, created.version), NOW),
      'APPROVAL_UNAVAILABLE',
      'unavailable',
    )
    await expectForbiddenOutcome(
      scheduleInTransaction(
        client, cfg, withdrawArgs(interviewerId, created.version), NOW, async () => 'rejected',
      ),
      'APPROVAL_NOT_GRANTED',
      'rejected',
    )

    const row = (await client.query<Record<string, unknown>>(
      `select required_scorecard from recruitment.interviewer where id = $1 and tenant_id = $2`,
      [interviewerId, TENANT],
    )).rows[0]
    assert.equal(row?.required_scorecard, true, '闸门拒绝不得改动 required_scorecard')
    assert.equal((await readState(client, created.id)).record_version, created.version)
    assert.deepEqual(await tableCounts(client), before, '闸门拒绝必须零写入')
    assert.equal(await eventCount(client), beforeEvents, '闸门拒绝不得写审计事件')
  })
})

test('WITHDRAW_INTERVIEWER 负例：interviewer 不存在 → NOT_FOUND；旧版本 → VERSION_CONFLICT；缺 reason → REASON_REQUIRED，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)

    // 不存在的 interviewer_id → NOT_FOUND(INTERVIEWER_NOT_FOUND)（不确认对方存在）。
    await expectToolError(
      schedule(client, withdrawArgs('00000000-0000-4000-8000-0000000000ee', created.version), NOW),
      'NOT_FOUND',
      'INTERVIEWER_NOT_FOUND',
    )

    const interviewerId = await interviewerRowId(client, created.id, INTERVIEWER_A)
    // 旧版本 → VERSION_CONFLICT，detail 给真实值。
    const versionBody = await expectToolError(
      schedule(client, withdrawArgs(interviewerId, created.version + 1), NOW),
      'VERSION_CONFLICT',
      'STALE_RECORD_VERSION',
    )
    const detail = versionBody.detail as Record<string, unknown>
    assert.equal(detail.expected_record_version, created.version + 1)
    assert.equal(detail.actual_record_version, created.version)

    // 缺 reason → REASON_REQUIRED（§3.7 / SC-X5；参数层就拒，不碰库、不问人）。
    const missingReason = withdrawArgs(interviewerId, created.version)
    delete missingReason.reason
    await expectToolError(schedule(client, missingReason, NOW), 'INVALID_ARGS', 'REASON_REQUIRED')

    assert.deepEqual(await tableCounts(client), before, '负例必须零写入')
    assert.equal(await eventCount(client), beforeEvents, '负例不得写审计事件')
    assert.equal(
      (await client.query<{ required_scorecard: boolean }>(
        `select required_scorecard from recruitment.interviewer where id = $1 and tenant_id = $2`,
        [interviewerId, TENANT],
      )).rows[0]?.required_scorecard,
      true,
      '负例不得把 required_scorecard 改成 false',
    )
  })
})

test('CANCEL 对已发生的会议不解绑（SC-X6）：binding 仍 active、meeting_role 不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const external = `feishu-${uniqueSuffix()}`
    const created = await scheduleNew(client, scenario.applicationId, {
      meeting: { provider: 'FEISHU', external_meeting_id: external },
    })
    // 会议"已经发生"：actual_* 由平台回读写入，不是排期工具写的（§3.1：actual 优先）。
    await client.query(
      `update recruitment.meeting
          set actual_start_at = $1::timestamptz, actual_end_at = $2::timestamptz
        where tenant_id = $3 and external_meeting_id = $4`,
      [START, END_ISO, TENANT, external],
    )

    const value = await schedule(client, cancelArgs(created.id, created.version), NOW)
    assert.equal((value.interview as Record<string, unknown>).status, 'CANCELLED')
    assert.deepEqual(value.effects, { meeting_bound: true, external_call_made: false })

    const bindings = await activeBindingRows(client, created.id)
    assert.equal(bindings.length, 1, 'SC-X6：已发生的会议不解绑（之后仍可能有材料要取）')
    assert.equal(bindings[0]?.meeting_role, 'PRIMARY', 'meeting_role 不改成 CANCELLED')
    assert.equal(bindings[0]?.external_meeting_id, external)
  })
})

test('RESCHEDULE 从 RESCHEDULED（无有效时间）补时间 → SCHEDULED；只给时长 → MISSING_REQUIRED（B-2）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await scheduleNew(client, scenario.applicationId)
    // 制造"时间作废、待重排"的行（v1.0 没有产生它的入口：本工具只把 RESCHEDULED 当**源**状态读）。
    await client.query(
      `update recruitment.interview
          set status = 'RESCHEDULED', scheduled_start_at = null, scheduled_end_at = null
        where id = $1 and tenant_id = $2`,
      [created.id, TENANT],
    )
    const pending = await readState(client, created.id)
    assert.equal(pending.status, 'RESCHEDULED')
    assert.equal(pending.scheduled_start_at, null)

    // B-2：只给 duration 拼不出窗口（ck_interview_scheduled 不允许 SCHEDULED 行缺开始时间）。
    const before = await tableCounts(client)
    await expectToolError(
      schedule(client, rescheduleArgs(created.id, pending.record_version, {
        scheduled_start_at: undefined,
        duration_minutes: 30,
      }), NOW),
      'INVALID_ARGS',
      'MISSING_REQUIRED',
    )
    assert.deepEqual(await tableCounts(client), before, 'B-2 的拒绝必须零写入')

    // 补上新时间 → §8 的 RESCHEDULED → SCHEDULED 边。
    const value = await schedule(client, rescheduleArgs(created.id, pending.record_version, {
      scheduled_start_at: at(1440),
      duration_minutes: 45,
    }), NOW)
    assert.equal((value.interview as Record<string, unknown>).status, 'SCHEDULED')
    assert.equal((value.interview as Record<string, unknown>).scheduled_start_at, at(1440))
    assert.equal((value.interview as Record<string, unknown>).scheduled_end_at, at(1485))
    assert.equal((await readState(client, created.id)).status, 'SCHEDULED')
  })
})

test('RESCHEDULE / CANCEL 的面试不存在 → NOT_FOUND(INTERVIEW_NOT_FOUND)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const before = await tableCounts(client)
    const beforeEvents = await eventCount(client)
    const missing = '00000000-0000-4000-8000-0000000000dd'
    await expectToolError(
      schedule(client, rescheduleArgs(missing, 1), NOW),
      'NOT_FOUND',
      'INTERVIEW_NOT_FOUND',
    )
    await expectToolError(
      schedule(client, cancelArgs(missing, 1), NOW),
      'NOT_FOUND',
      'INTERVIEW_NOT_FOUND',
    )
    assert.deepEqual(await tableCounts(client), before, 'NOT_FOUND 必须零写入')
    assert.equal(await eventCount(client), beforeEvents, 'NOT_FOUND 不得写审计事件')
  })
})
