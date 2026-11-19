// owner-noshow-tz / C：MARK_NO_SHOW 真库落库 + 下游拦截 + 负例零写入 + 时区/DST 的集成证据。
//
// 与 `noshow-write-path.test.ts`（A）互补：本文件**不 import 产品写路径的实现细节去断言输出**，
// 只读回库里的客观事实（interview / event_inbox / scorecard 行数与字段），让证据独立可读。
//
// 纪律（test/integration/db.ts）：
//   1. 每个用例在自己的事务里跑、结束一律 ROLLBACK —— 不污染共享库；
//   2. 连不上库就失败（不静默 skip，R3 要 skipped === 0 才算绿）；
//   3. 身份负例用产品真的 createDemoActorIdentity()（identity 已装配但 session 未绑定）
//      → DEMO_ACTOR_UNMAPPED，发生在建池/开事务**之前**，零写入；
//   4. 口令只从环境变量读（RECRUITMENT_DB_PASSWORD），不写进本文件。
//
// ⚠️ 依赖 Owner 接线的点（接线前相关用例会红，这是如实的红，不是放宽断言）：
//   - `MARK_NO_SHOW` intent 走 `scheduleInTransaction`；审计事件类型 `interview.no_show`；
//   - 非法 timezone 的 CREATE 在 400/INVALID_ARGS 与人话文案「时区要写成 Asia/Shanghai 这种」；
//   - `computeFreeSlots` 接受 IANA 时区（字段名由 Owner 定，见 §5 的适配层）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import {
  scheduleInTransaction,
  createInterviewScheduleTool,
} from '../../src/tools/interview-schedule.ts'
import { submitScorecardInTransaction } from '../../src/tools/scorecard-submit.ts'
import {
  isValidIanaTimezone,
  getTimezoneOffsetMinutes,
  localDateToUtcMs,
  formatInTimezone,
  displayTimezone,
} from '../../src/domain/timezone.ts'
import { computeFreeSlots } from '../../src/domain/interview-slots.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import type { InterviewSlotsHostContext } from '../../src/http/interview-slots.ts'
import {
  createIsolatedTestDatabase,
  errorBody,
  inRolledBackTx,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
  HR_ACTOR,
  TENANT,
  type IsolatedTestDatabase,
} from './db.ts'

const cfg = testDatabaseConfig()

// 一次性真库：用完 drop（本文件所有用例共用一个空库；每个用例仍跑在回滚事务里）。
let db: IsolatedTestDatabase
let pool: import('pg').Pool

test.before(async () => {
  db = await createIsolatedTestDatabase('noshow_tz_c')
  pool = db.pool
})
test.after(async () => {
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------
//  公共小工具
// ---------------------------------------------------------------------------

const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]
/** 远期基准，避开并发 lane 的已提交排期。 */
const SLOT_BASE_MS = Date.parse('2031-01-01T10:00:00+08:00') + Math.floor(Math.random() * 300 * 24 * 60) * 60_000
const at = (minutes: number): string => new Date(SLOT_BASE_MS + minutes * 60_000).toISOString()
const allowOnce = async (): Promise<'allowed-once'> => 'allowed-once'

function createArgs(applicationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'CREATE',
    idempotency_key: `ns-${uniqueSuffix()}`,
    application_id: applicationId,
    round_no: 1,
    interviewers: [{ actor_id: INTERVIEWER_A }],
    scheduled_start_at: at(0),
    duration_minutes: 60,
    ...overrides,
  }
}

function markArgs(
  interviewId: string,
  expectedRecordVersion: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    intent: 'MARK_NO_SHOW',
    idempotency_key: `ns-${uniqueSuffix()}:mark`,
    interview_id: interviewId,
    expected_record_version: expectedRecordVersion,
    reason: '面试官到场，候选人未出现，电话确认放弃本轮',
    confirmation_text: '确认：候选人未到场，按爽约记录，已电话联系。',
    subject: 'CANDIDATE',
    ...overrides,
  }
}

function schedule(client: DatabaseClient, args: Record<string, unknown>, nowMs = Date.parse('2026-11-13T00:00:00Z')) {
  return scheduleInTransaction(client, cfg, args, nowMs, allowOnce)
}

function mark(client: DatabaseClient, args: Record<string, unknown>, nowMs = Date.parse('2026-11-13T00:00:00Z')) {
  return scheduleInTransaction(client, cfg, args, nowMs, allowOnce)
}

async function count(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: number }>(sql, [...params])
  const value = rows[0]?.n
  assert.ok(typeof value === 'number', `count query returned no row: ${sql.slice(0, 60)}`)
  return value
}

/** 失败路径"零写入"的快照（访谈 + 事件 + 面评 + 业务任务）。 */
async function counts(client: DatabaseClient): Promise<Record<string, number>> {
  return {
    interview: await count(client, 'select count(*)::int as n from recruitment.interview'),
    event_inbox: await count(client, 'select count(*)::int as n from recruitment.event_inbox'),
    scorecard: await count(client, 'select count(*)::int as n from recruitment.scorecard'),
    business_task: await count(client, 'select count(*)::int as n from recruitment.business_task'),
  }
}

async function expectError(
  run: Promise<unknown>,
  code: string,
  reasonCode?: string,
): Promise<Record<string, unknown>> {
  try {
    await run
  } catch (error) {
    assert.equal((error as { code?: string }).code, code,
      `实际错误：${error instanceof Error ? error.message : String(error)}`)
    const body = errorBody(error)
    assert.equal(body.code, code)
    if (reasonCode !== undefined) assert.equal(body.reason_code, reasonCode)
    return body
  }
  assert.fail(`期望抛 ${code}${reasonCode === undefined ? '' : `(${reasonCode})`}，但调用成功了`)
}

async function createInterview(client: DatabaseClient, overrides: Record<string, unknown> = {}) {
  const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
  // 每场面试换一个时段：本文件既有 committed 夹具（execute() 用例）也有回滚事务，
  // 时段相同会撞 uq / INTERVIEWER_BUSY，测的就不再是 MARK 而是冲突校验。
  const jitter = Math.floor(Math.random() * 20_000) * 60_000
  const value = await schedule(client, createArgs(scenario.applicationId, {
    scheduled_start_at: new Date(SLOT_BASE_MS + jitter).toISOString(),
    ...overrides,
  }))
  const interview = value.interview as Record<string, unknown>
  return { scenario, interviewId: String(interview.id), version: Number(interview.record_version) }
}

/** 直接用 SQL 读回一行面试（不经过任何产品函数）。 */
async function readInterview(client: DatabaseClient, interviewId: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select id, application_id, round_no, slot_code, status, record_version,
            status_changed_by_actor_id, scheduled_start_at, scheduled_end_at, timezone
       from recruitment.interview where id = $1 and tenant_id = $2`,
    [interviewId, TENANT],
  )
  const row = rows[0]
  assert.ok(row !== undefined, `interview ${interviewId} 没有落库`)
  return row
}

/** 本工具写出的审计事件（按事件类型 + payload.interview_id 过滤，独立 SQL）。 */
async function auditEvents(
  client: DatabaseClient,
  eventType: string,
  interviewId: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select event_id, event_type, provider, trust_level, idempotency_key, source_object_id, payload
       from recruitment.event_inbox
      where tenant_id = $1 and event_type = $2 and payload->>'interview_id' = $3
      order by recorded_at, event_id`,
    [TENANT, eventType, interviewId],
  )
  return rows
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// ===========================================================================
//  1. 爽约落库 + 审计（独立 SQL 读回）
// ===========================================================================

test('MARK_NO_SHOW：status=NO_SHOW、版本 +1、无新 interview 行；审计事件含 outcome/reason/sha256/subject', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { interviewId, version } = await createInterview(client)
    const beforeRow = await readInterview(client, interviewId)
    // 快照取在 MARK 之前：CREATE 本身会建 BIND_MEETING 待办，那不是 MARK 的写入。
    const before = await counts(client)
    const args = markArgs(interviewId, version)

    const out = await mark(client, args)
    assert.equal(out.status, 'OK')
    assert.equal(out.write, true)
    assert.equal(out.intent, 'MARK_NO_SHOW')
    assert.equal(out.replayed, false)

    // --- 独立 SQL 读回：同一行被改，没有新增行 ---
    const row = await readInterview(client, interviewId)
    assert.equal(row.status, 'NO_SHOW')
    assert.equal(row.record_version, version + 1, 'record_version 只 +1')
    assert.equal(row.status_changed_by_actor_id, HR_ACTOR)
    assert.equal(
      await count(client, 'select count(*)::int as n from recruitment.interview where application_id = $1',
        [beforeRow.application_id]),
      1,
      'uq_interview_slot 不产生第二条 interview 行',
    )
    const after = await counts(client)
    assert.equal(after.interview, before.interview)
    // event_inbox 至少 +2：fn_row_guard 的 status.changed + 显式审计事件。
    assert.ok(after.event_inbox >= before.event_inbox + 2, '状态变更 + 爽约审计都要留痕')

    // --- 审计 payload 逐字段读回 ---
    // A 的裁决：专用事件类型 interview.no_show；若最终仍复用 interview.cancelled，本断言须按实调整。
    const events = await auditEvents(client, 'interview.no_show', interviewId)
    assert.equal(events.length, 1, '恰好一条 interview.no_show 审计事件')
    const payload = events[0]?.payload as Record<string, unknown>
    assert.equal(payload.outcome, 'NO_SHOW')
    assert.equal(payload.reason, String(args.reason))
    assert.equal(payload.subject, 'CANDIDATE')
    assert.equal(payload.confirmation_text_sha256, sha256(String(args.confirmation_text)))
    assert.match(String(payload.confirmation_text_sha256), /^[0-9a-f]{64}$/)
    assert.equal(payload.from_status, 'SCHEDULED')
    assert.equal(payload.to_status, 'NO_SHOW')
    assert.equal(payload.interview_id, interviewId)
    // 人的原话绝不能落库（R7）：payload / 输出里只剩 sha256。
    assert.equal(JSON.stringify(payload).includes(String(args.confirmation_text)), false)
    assert.equal(JSON.stringify(out).includes(String(args.confirmation_text)), false)
    assert.equal((events[0]?.provider as string), 'internal')

    // --- 同一 idempotency_key 重放：零新增 ---
    const beforeReplay = await counts(client)
    const replay = await mark(client, args)
    assert.equal(replay.status, 'OK')
    assert.equal(replay.replayed, true)
    assert.deepEqual(await counts(client), beforeReplay, '重放零新增')
    assert.equal((await readInterview(client, interviewId)).record_version, version + 1, '重放不再涨版本')
    assert.equal((await auditEvents(client, 'interview.no_show', interviewId)).length, 1, '重放不重复写事件')
  })
})

test('MARK_NO_SHOW subject=INTERVIEWER 时 payload.subject 如实落 INTERVIEWER', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { interviewId, version } = await createInterview(client)
    const args = markArgs(interviewId, version, { subject: 'INTERVIEWER' })
    await mark(client, args)
    const events = await auditEvents(client, 'interview.no_show', interviewId)
    assert.equal(events.length, 1)
    assert.equal((events[0]?.payload as Record<string, unknown>).subject, 'INTERVIEWER')
  })
})

// ===========================================================================
//  2. 下游拦截：NO_SHOW 面试不得新增面评（SC-08）
// ===========================================================================

test('下游拦截：NO_SHOW 后调 recruitment_scorecard_submit → INVALID_ARGS(INTERVIEW_CANCELLED)，scorecard 零新增', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { scenario, interviewId, version } = await createInterview(client)
    await mark(client, markArgs(interviewId, version))
    assert.equal((await readInterview(client, interviewId)).status, 'NO_SHOW')

    // CREATE fixture 已含 INTERVIEWER_A 的面试官行，让守卫只因 NO_SHOW 拦，不因"不是面试官"提前拦。
    await client.query("select set_config('recruitment.actor_id', $1, true)", [INTERVIEWER_A])
    const before = await counts(client)

    const submitArgs = {
      interview_id: interviewId,
      idempotency_key: `sc-ns-${uniqueSuffix()}`,
      overall: 'HOLD',
      items: {
        transcript_basis: 'NO_TRANSCRIPT',
        work_exists: { assessment: 'MET', score: 4, note: '证据充分' },
      },
    }
    const body = await expectError(
      submitScorecardInTransaction(client, cfg, submitArgs, Date.now(), allowOnce),
      'INVALID_ARGS',
      'INTERVIEW_CANCELLED',
    )
    assert.equal((body.detail as Record<string, unknown>).interview_status, 'NO_SHOW')
    assert.equal(await count(client, 'select count(*)::int as n from recruitment.scorecard'), before.scorecard,
      'scorecard 零新增')
    assert.equal(await count(client, 'select count(*)::int as n from recruitment.event_inbox'), before.event_inbox,
      '面评事件也零新增')
    void scenario
  })
})

// ===========================================================================
//  3. 负例零写入
// ===========================================================================

test('负例：缺 reason / 缺 confirmation_text → INVALID_ARGS，interview + event_inbox 行数不变', async () => {
  for (const missing of ['reason', 'confirmation_text']) {
    await inRolledBackTx(pool, async (client) => {
      const { interviewId, version } = await createInterview(client)
      const args = markArgs(interviewId, version)
      delete args[missing]
      const before = await counts(client)
      await expectError(mark(client, args), 'INVALID_ARGS')
      assert.deepEqual(await counts(client), before, `缺 ${missing} 必须零写入`)
      assert.equal((await readInterview(client, interviewId)).status, 'SCHEDULED')
    })
  }
})

test('负例：未绑定身份（identity 已装配、session 未绑定）→ DEMO_ACTOR_UNMAPPED，零写入', async () => {
  // 身份闸门在建池之前 fail closed（tool-actor.ts:40-52）。先钉纯函数层，再钉真实 execute()。
  const { createDemoActorIdentity } = await import('../../src/demo-actor/index.ts')
  const { resolveWriteActor } = await import('../../src/demo-actor/tool-actor.ts')
  const { identity } = createDemoActorIdentity()
  assert.throws(
    () => resolveWriteActor({ agent: { id: 'session-not-bound' } }, identity, HR_ACTOR),
    (error: unknown) => (error as { code?: string }).code === 'DEMO_ACTOR_UNMAPPED',
    'identity 已装配但 session 未绑定 ⇒ DEMO_ACTOR_UNMAPPED（不回退 config.actor_id）',
  )

  // 真库上的 execute()：夹具必须已提交（execute 自建连接池，看不到未提交事务）。
  const { scenario, interviewId, version } = await withCommittedFixture(async (client) =>
    createInterview(client))
  const before = await countsOnPool()
  const tool = createInterviewScheduleTool(
    { ...cfg, database: db.name },
    { identity },
  )
  await assert.rejects(
    () => tool.execute(markArgs(interviewId, version), { agent: { id: 'session-not-bound' } }),
    (error: unknown) => (error as { code?: string }).code === 'DEMO_ACTOR_UNMAPPED',
  )
  assert.deepEqual(await countsOnPool(), before, '未绑定身份 execute() 必须零写入')
  void scenario
})

test('负例：越权（非面试官的陌生 actor 提交）→ FORBIDDEN，零写入', async () => {
  // 写身份来自 session 绑定的 actor，不接受入参覆盖：用 createDemoActorIdentity 把一个
  // 解析到"陌生 actor"的映射装进工具，execute 时用它的 session 调用 → 无 MARK_NO_SHOW 职权。
  const { createDemoActorIdentity } = await import('../../src/demo-actor/index.ts')
  const stranger = '11111111-1111-4111-8111-000000000099'
  const { identity } = createDemoActorIdentity({ recruiter: stranger })
  const sessionId = `session-${randomUUID()}`
  identity.registry.bind(sessionId, 'recruiter')
  const { interviewId, version } = await withCommittedFixture(async (client) => createInterview(client))
  const before = await countsOnPool()
  const tool = createInterviewScheduleTool({ ...cfg, database: db.name }, { identity })
  await expectError(
    tool.execute(markArgs(interviewId, version), { agent: { id: sessionId } }),
    'FORBIDDEN',
  )
  assert.deepEqual(await countsOnPool(), before, '越权 actor 必须零写入')
})

test('负例：状态不允许（CANCELLED 后再 MARK）→ INVALID_ARGS(INVALID_STATE_TRANSITION)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { interviewId, version } = await createInterview(client)
    await schedule(client, {
      intent: 'CANCEL',
      idempotency_key: `ns-${uniqueSuffix()}:cancel`,
      interview_id: interviewId,
      expected_record_version: version,
      reason: '候选人改约',
    })
    const cancelled = await readInterview(client, interviewId)
    assert.equal(cancelled.status, 'CANCELLED')
    const before = await counts(client)
    await expectError(mark(client, markArgs(interviewId, Number(cancelled.record_version))),
      'INVALID_ARGS', 'INVALID_STATE_TRANSITION')
    assert.deepEqual(await counts(client), before, 'CANCELLED 再 MARK 必须零写入')
  })
})

test('负例：已是 NO_SHOW（任何 key）→ 幂等成功 already_marked=true、零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { interviewId, version } = await createInterview(client)
    const first = await mark(client, markArgs(interviewId, version))
    assert.equal(first.status, 'OK')
    const marked = await readInterview(client, interviewId)
    const before = await counts(client)
    const second = await mark(client, markArgs(interviewId, Number(marked.record_version)))
    assert.equal(second.status, 'OK')
    assert.equal(second.already_marked, true, 'lead 裁决：已 NO_SHOW 是幂等成功，不是 409')
    assert.deepEqual(await counts(client), before, '重复标记零写入')
  })
})

test('负例：版本不匹配 → VERSION_CONFLICT(STALE_RECORD_VERSION)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { interviewId, version } = await createInterview(client)
    const before = await counts(client)
    await expectError(mark(client, markArgs(interviewId, version + 5)),
      'VERSION_CONFLICT', 'STALE_RECORD_VERSION')
    assert.deepEqual(await counts(client), before)
  })
})

// ---------------------------------------------------------------------------
//  已提交夹具的小工具（execute() 自建池需要跨连接可见）；drop 一次性库时统一清理。
// ---------------------------------------------------------------------------

async function withCommittedFixture<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    const value = await fn(client as DatabaseClient)
    await client.query('commit')
    return value
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function countsOnPool(): Promise<Record<string, number>> {
  const client = await pool.connect()
  try {
    return await counts(client as DatabaseClient)
  } finally {
    client.release()
  }
}

// ===========================================================================
//  4. 时区非法拒绝（CREATE）
//     Owner 接线前的骨架：纯函数层断言先跑；HTTP/工具层断言按接线后的实际行为断言。
// ===========================================================================

test('时区纯函数层：UTC+5 / Not/AZone / emoji 拒绝；Asia/Shanghai / America/New_York 合法', () => {
  for (const bad of ['UTC+5', 'Not/AZone', '🌏', 'GMT-8', '']) {
    assert.equal(isValidIanaTimezone(bad), false, `${bad} 必须是非法时区`)
  }
  for (const good of ['Asia/Shanghai', 'America/New_York', 'UTC', 'Etc/GMT+5']) {
    assert.equal(isValidIanaTimezone(good), true, `${good} 必须是合法 IANA 名`)
  }
  assert.throws(() => formatInTimezone(Date.now(), 'UTC+5'), RangeError)
  assert.equal(displayTimezone('UTC+5'), '未知时区（原值：UTC+5）')
  assert.equal(displayTimezone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(displayTimezone(null), '未记录时区')
})

test('HTTP free-slots：非法 timezone → 400 INVALID_ARGS(INVALID_TIMEZONE) + 人话文案（已接线，当下可跑）', async () => {
  const { registerInterviewSlotsHttp, INTERVIEW_FREE_SLOTS_PATH } =
    await import('../../src/http/interview-slots.ts')
  const { createDemoActorIdentity } = await import('../../src/demo-actor/index.ts')
  const identity = createDemoActorIdentity().identity
  const session = `session-${randomUUID()}`
  identity.registry.bind(session, 'recruiter')
  const routes: { path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void> }[] = []
  const ctx: InterviewSlotsHostContext = {
    webServer: {
      host: '127.0.0.1', port: 49347,
      register(route) {
        routes.push(route as (typeof routes)[number])
        return () => {}
      },
    },
  }
  const dispose = registerInterviewSlotsHttp(ctx, { feishuCliPath: null, identity })
  try {
    assert.equal(routes.length, 1)
    assert.equal(routes[0]?.path, INTERVIEW_FREE_SLOTS_PATH)
    for (const bad of ['UTC+5', 'Not/AZone', '🌏']) {
      const req = {
        url: `${INTERVIEW_FREE_SLOTS_PATH}?application_id=${randomUUID()}`
          + `&interviewer_actor_ids=11111111-1111-4111-8111-000000000104`
          + `&days=1&duration_minutes=45&timezone=${encodeURIComponent(bad)}`,
        method: 'GET',
        headers: { host: '127.0.0.1:49347', 'x-recruitment-request': '1', 'x-dsh-session': session },
      } as unknown as import('node:http').IncomingMessage
      let status = 0
      let body = ''
      const res = {
        headersSent: false,
        writeHead(s: number) { status = s; return this },
        end(b?: string) { if (b !== undefined) body = b; return this },
      } as unknown as import('node:http').ServerResponse
      await routes[0]!.handler(req, res)
      assert.equal(status, 400, `timezone=${bad} 必须 400`)
      const parsed = JSON.parse(body) as { error: { code: string; reason_code: string; message: string; detail: { timezone: string } } }
      assert.equal(parsed.error.code, 'INVALID_ARGS')
      assert.equal(parsed.error.reason_code, 'INVALID_TIMEZONE')
      assert.equal(parsed.error.message, '时区要写成 Asia/Shanghai 这种（合法的 IANA 时区名）')
      assert.equal(parsed.error.detail.timezone, bad)
    }
  } finally {
    dispose()
  }
})

test('CREATE 非法 timezone → INVALID_ARGS(INVALID_TIMEZONE) + 人话「时区要写成 Asia/Shanghai 这种」，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    for (const bad of ['UTC+5', 'Not/AZone', '🌏']) {
      const before = await counts(client)
      const body = await expectError(schedule(client, createArgs(scenario.applicationId, { timezone: bad })),
        'INVALID_ARGS', 'INVALID_TIMEZONE')
      const text = JSON.stringify(body)
      assert.match(text, /时区要写成 Asia\/Shanghai 这种/, '错误必须给人话，不是裸 code：' + text)
      assert.deepEqual((body.detail as Record<string, unknown>).timezone, bad)
      assert.deepEqual(await counts(client), before, `${bad} 必须零写入`)
    }
  })
})

test('CREATE 合法 timezone（Asia/Shanghai / America/New_York）→ 落库原值', async () => {
  await inRolledBackTx(pool, async (client) => {
    for (const tz of ['Asia/Shanghai', 'America/New_York']) {
      const { interviewId } = await createInterview(client, { timezone: tz })
      assert.equal((await readInterview(client, interviewId)).timezone, tz)
    }
  })
})

// ===========================================================================
//  5. DST 时段（2026-03-07 / 03-09 跨 NY 春跳；上海恒定 +08:00）
// ===========================================================================

test('DST 纯函数层：NY 03-07 = -05:00、03-09 = -04:00；上海两天都是 +08:00', () => {
  const mar7 = { year: 2026, month: 3, day: 7 }
  const mar8 = { year: 2026, month: 3, day: 8 }
  const mar9 = { year: 2026, month: 3, day: 9 }
  assert.equal(getTimezoneOffsetMinutes('America/New_York', mar7), -300)
  assert.equal(getTimezoneOffsetMinutes('America/New_York', mar8), -240, '03-08 春跳')
  assert.equal(getTimezoneOffsetMinutes('America/New_York', mar9), -240)
  assert.equal(getTimezoneOffsetMinutes('Asia/Shanghai', mar7), 480)
  assert.equal(getTimezoneOffsetMinutes('Asia/Shanghai', mar9), 480)

  // 本地 10:00 换成 UTC：03-07 是 15:00Z，03-09 是 14:00Z（不漂移 1 小时）。
  assert.equal(new Date(localDateToUtcMs('America/New_York', mar7, 10 * 60)).toISOString(),
    '2026-03-07T15:00:00.000Z')
  assert.equal(new Date(localDateToUtcMs('America/New_York', mar9, 10 * 60)).toISOString(),
    '2026-03-09T14:00:00.000Z')
  assert.match(formatInTimezone(localDateToUtcMs('America/New_York', mar7, 10 * 60), 'America/New_York'),
    /-05:00$/)
  assert.match(formatInTimezone(localDateToUtcMs('America/New_York', mar9, 10 * 60), 'America/New_York'),
    /-04:00$/)

  // 边界：春跳 02:30 不存在的本地时间必须向前落到合法时刻，不能回退一小时。
  const gap = localDateToUtcMs('America/New_York', mar8, 2 * 60 + 30)
  assert.equal(formatInTimezone(gap, 'America/New_York'), '2026-03-08T03:30:00.000-04:00')
})

test('DST 域层：computeFreeSlots 传 iana_timezone 覆盖 03-07 / 03-09，槽偏移 -05:00 / -04:00 且边界不漂移', () => {
  const participant = { participant_id: 'p1', busy: [] }
  const inputFor = (tz: string, day: number) => ({
    participants: [participant],
    dates: [{ year: 2026, month: 3, day }],
    iana_timezone: tz,
    duration_minutes: 60,
    proposed: 1,
    source: 'FIXTURE' as const,
  })
  const ny7 = computeFreeSlots(inputFor('America/New_York', 7))
  const ny9 = computeFreeSlots(inputFor('America/New_York', 9))
  assert.ok(ny7.length > 0 && ny9.length > 0, 'IANA 路径必须真的产出候选槽')
  assert.match(ny7[0]?.start ?? '', /-05:00$/)
  assert.match(ny9[0]?.start ?? '', /-04:00$/)
  // 工作窗 09:00 起，30 分钟网格 → 03-07 09:00 -05:00 = 14:00Z；03-09 09:00 -04:00 = 13:00Z。
  assert.equal(ny7[0]?.start, '2026-03-07T09:00:00.000-05:00')
  assert.equal(ny9[0]?.start, '2026-03-09T09:00:00.000-04:00')
  assert.equal(new Date(ny7[0]?.start ?? '').toISOString(), '2026-03-07T14:00:00.000Z')
  assert.equal(new Date(ny9[0]?.start ?? '').toISOString(), '2026-03-09T13:00:00.000Z')

  const sh7 = computeFreeSlots(inputFor('Asia/Shanghai', 7))
  const sh9 = computeFreeSlots(inputFor('Asia/Shanghai', 9))
  assert.match(sh7[0]?.start ?? '', /\+08:00$/)
  assert.match(sh9[0]?.start ?? '', /\+08:00$/)
  assert.equal(sh7[0]?.start, '2026-03-07T09:00:00.000+08:00')
  assert.equal(sh9[0]?.start, '2026-03-09T09:00:00.000+08:00')

  // 春跳当天（03-08）的槽必须落在新偏移 -04:00，不能回退一小时到 -05:00。
  const ny8 = computeFreeSlots(inputFor('America/New_York', 8))
  assert.ok(ny8.length > 0)
  assert.match(ny8[0]?.start ?? '', /-04:00$/)
})
