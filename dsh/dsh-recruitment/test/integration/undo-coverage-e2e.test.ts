// 撤销覆盖 E2E：**真库 + 真 HTTP** 集成测试（一次性库 0001→0020 重放，结束 drop）。
//
// 本文件由 undo-coverage lane 的子代理 C（undo-c）编写，只依赖：
//   · src/http/actions.ts::handleInterviewSchedule   —— A 在此加 undo_log ORIGINAL 落库 + 响应 action_id
//   · src/http/batch-undo.ts::handleUndo             —— 已存在的撤销入口（走 scheduleInTransaction CANCEL 补偿）
//   · src/http/interviewer.ts::readInterviewerWorkspace —— B 在此补 to_regclass 旧库兼容（candidate_constraints）
//
// 覆盖四个场景（与派单任务书一一对应）：
//   ① 排期 → 撤销 → 状态回退：撤销成功时 interview 行不删、status='CANCELLED'、
//      undo_log 有 COMPENSATION 行、ORIGINAL.compensation_action_id 已链上；
//   ② 超窗 409：ORIGINAL.occurred_at 已过 5 分钟 → 409 UNDO_WINDOW_EXPIRED 且零写入；
//   ③ 重复撤销 already_undone：第二次 status='already_undone'，COMPENSATION 行数仍为 1；
//   ④ 面试官前简报能读到 PIN 与 HANDOFF（来自上一轮，from_previous_round:true），且无内部 id 字段。
//
// 纪律（与 batch-undo-http.test.ts / undo-log-db.test.ts 同口径）：
//   1. 独占一次性库 `createIsolatedTestDatabase('undo_cov')`，用完 drop；不碰 ra_s6s7 / ra_freeze_final；
//   2. 真 `node:http` server + 真 registerActionsHttp / registerBatchUndoHttp 注册 exact 路由（R2 可达性）；
//   3. 断言只信独立 SQL 读回（undo_log / interview / event_inbox / candidate_constraint）；
//   4. 拒绝路径断言「HTTP 码 + 目标表行数前后不变」（L5 反证）；
//   5. 口令只从 env 读，不写进任何文件/证据；
//   6. 不 mock 数据库；skipped === 0（连不上库直接失败，不静默跳过）。
//
// 注意：A 的 ORIGINAL 落库若尚未生效，场景①会从库按 target_interview_id 反查 action_id
// （这样骨架在 A 落地前也能编译、落地后自动走响应里的 action_id）。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  readInterviewerWorkspace,
  type InterviewerOverview,
  type InterviewerRow,
} from '../../src/http/interviewer.ts'
import { registerActionsHttp, type ActionHostContext, type ActionHttpDeps } from '../../src/http/actions.ts'
import { registerBatchUndoHttp, type BatchUndoHttpDeps } from '../../src/http/batch-undo.ts'
import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import type { QueryResultRow } from 'pg'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  criterion,
  createIsolatedTestDatabase,
  hex64,
  HR_ACTOR,
  inRolledBackTx,
  one,
  parsedFields,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
  type Scenario,
} from './db.ts'

const BASE = testDatabaseConfig()
const SESSION = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SCHEDULE_PATH = '/recruitment/api/action/interview/schedule'
const UNDO_PATH = '/recruitment/api/action/undo'
/** 演示种子里的面试官（HUMAN，104）。 */
const INTERVIEWER = '11111111-1111-4111-8111-000000000104'
/** 远期排期基准：2031 年后库里不会有任何已提交面试，避免 START_IN_PAST / CONFLICT_SLOT。 */
const SLOT_BASE_MS = Date.parse('2031-01-01T10:00:00+08:00') + Math.floor(Math.random() * 300 * 24 * 60) * 60_000
const START = new Date(SLOT_BASE_MS).toISOString()

const PIN_TEXT = '候选人要求：Offer 周五前答复，期望 45k（真库覆盖夹具）'
const HANDOFF_TEXT = '上一轮留给下一轮的追问：请确认他主导的分片方案是否落地（真库覆盖夹具）'

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let server: Server
let baseUrl = ''
let scenarioMain: Scenario
let scenarioStale: Scenario

interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

async function call(path: string, options: {
  readonly session?: string
  readonly body?: unknown
  readonly sameOrigin?: boolean
} = {}): Promise<HttpResult> {
  const headers: Record<string, string> = {}
  if (options.sameOrigin !== false) headers['x-recruitment-request'] = '1'
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: payload })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
  return { status: response.status, body, text }
}

async function query<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

/** 真提交事务（一次性库，无需回滚；set actor 满足触发器）。 */
async function committedFixture<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    const value = await fn(client)
    await client.query('commit')
    return value
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function scheduleBody(applicationId: string, slotCode: string, minutesOffset = 0): Record<string, unknown> {
  return {
    intent: 'CREATE',
    idempotency_key: `undo-cov-${randomUUID()}`,
    application_id: applicationId,
    round_no: 1,
    slot_code: slotCode,
    interviewers: [{ actor_id: INTERVIEWER }],
    scheduled_start_at: new Date(SLOT_BASE_MS + minutesOffset * 60_000).toISOString(),
    duration_minutes: 60,
  }
}

/**
 * 从排期响应里取 action_id（A 落地后会在响应里给出；兼容顶层 / result / audit 三种位置），
 * 取不到则按 interview_id 从 undo_log ORIGINAL 反查（A 未落地时的骨架兜底）。
 */
async function resolveActionId(result: HttpResult, interviewId: string): Promise<string> {
  const candidates: unknown[] = [
    result.body.action_id,
    (result.body.result as Record<string, unknown> | undefined)?.action_id,
    (result.body.audit as Record<string, unknown> | undefined)?.action_id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') {
      console.log(`[EVIDENCE T① action_id 来源] 排期响应 → ${candidate}`)
      return candidate
    }
  }
  const rows = await query<{ action_id: string; operation_type: string; action_type: string | null }>(
    `select action_id::text as action_id, operation_type, action_type from recruitment.undo_log
      where tenant_id = $1 and kind = 'ORIGINAL' and target_interview_id = $2::uuid
      order by occurred_at desc limit 1`,
    [TENANT, interviewId],
  )
  assert.ok(rows[0]?.action_id, `排期后找不到 ORIGINAL action_id（A 是否落地？）：${result.text}`)
  console.log(`[EVIDENCE T① action_id 来源] DB 反查（响应未给 action_id）→ action_id=${rows[0]!.action_id}, operation_type=${rows[0]!.operation_type}, action_type=${rows[0]!.action_type}, target_interview_id=${interviewId}`)
  return rows[0]!.action_id
}

function assertError(result: HttpResult, status: number, code: string, reasonCode?: string): void {
  assert.equal(result.status, status, `HTTP ${status} expected: ${result.text}`)
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `error envelope expected: ${result.text}`)
  assert.equal(error.code, code, result.text)
  if (reasonCode !== undefined) assert.equal(error.reason_code, reasonCode, result.text)
}

before(async () => {
  db = await createIsolatedTestDatabase('undo_cov')
  assertPrivateDatabase(db.name)
  cfg = { ...BASE, database: db.name }
  await committedFixture(async (client) => {
    const common = {
      dimensions: [
        criterion({ key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true }),
      ],
      fields: parsedFields({ entryCount: 1 }),
      approve: true,
      pinRubric: true,
      bindMaterial: true,
    } as const
    scenarioMain = await seedScenario(client, common)
    scenarioStale = await seedScenario(client, common)
  })
  identity = createDemoActorIdentity().identity
  identity.registry.bind(SESSION, 'recruiter')

  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve().then(() => handler(req, res)).catch(() => { try { res.destroy() } catch { /* ignore */ } })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  const webServer: ActionHostContext['webServer'] = {
    host: '127.0.0.1',
    port,
    register(route) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const actionDeps: ActionHttpDeps = { database: cfg, databaseIssues: [], identity }
  const batchDeps: BatchUndoHttpDeps = { database: cfg, databaseIssues: [], identity }
  registerActionsHttp({ webServer }, actionDeps)
  registerBatchUndoHttp({ webServer }, batchDeps)
})

after(async () => {
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (db !== undefined) await db.drop()
})

// =====================================================================
//  ① 排期 → 撤销 → 状态回退（行保留、CANCELLED、COMPENSATION + 链上 ORIGINAL）
// =====================================================================

test('① 排期后撤销成功：interview 行不删、status=CANCELLED、COMPENSATION 落库且 ORIGINAL 链上', async () => {
  const body = scheduleBody(scenarioMain.applicationId, 'UNDOCOV')
  const scheduled = await call(SCHEDULE_PATH, { session: SESSION, body })
  assert.equal(scheduled.status, 200, `排期应成功：${scheduled.text}`)
  const resultRecord = scheduled.body.result as Record<string, unknown> | undefined
  const interviewRecord = resultRecord?.interview as Record<string, unknown> | undefined
  const interviewId = String(interviewRecord?.id ?? '')
  assert.match(interviewId, /^[0-9a-f-]{36}$/i, `排期响应应带 interview.id：${scheduled.text}`)

  const before = await query<{ n: string; status: string }>(
    `select count(*)::text as n, max(status) as status from recruitment.interview
      where id = $1::uuid and tenant_id = $2`,
    [interviewId, TENANT],
  )
  assert.equal(before[0]?.n, '1', '排期后 interview 行必须真实存在')
  assert.equal(before[0]?.status, 'SCHEDULED', '排期后状态应为 SCHEDULED')

  const actionId = await resolveActionId(scheduled, interviewId)
  const undone = await call(UNDO_PATH, {
    session: SESSION,
    body: { action_id: actionId, confirmation_text: '确认撤销刚才那场面试（真库覆盖场景①）。' },
  })
  assert.equal(undone.status, 200, `撤销应成功：${undone.text}`)
  assert.equal(undone.body.status, 'undone', undone.text)
  const compensationActionId = String(undone.body.compensation_action_id ?? '')
  assert.match(compensationActionId, /^[0-9a-f-]{36}$/i, '响应应带 compensation_action_id')

  // 独立 SQL 读回：COMPENSATION 行落库。
  const comp = await query<{ n: string; operation_type: string }>(
    `select count(*)::text as n, max(operation_type) as operation_type
       from recruitment.undo_log
      where tenant_id = $1 and kind = 'COMPENSATION' and action_id = $2::uuid`,
    [TENANT, compensationActionId],
  )
  assert.equal(comp[0]?.n, '1', 'COMPENSATION 行必须落库')
  assert.equal(comp[0]?.operation_type, 'UNDO')

  // ORIGINAL.compensation_action_id 已链上。
  const original = await query<{ compensation_action_id: string | null }>(
    `select compensation_action_id::text as compensation_action_id from recruitment.undo_log
      where tenant_id = $1 and kind = 'ORIGINAL' and action_id = $2::uuid`,
    [TENANT, actionId],
  )
  assert.equal(original[0]?.compensation_action_id, compensationActionId, 'ORIGINAL 必须指向补偿行')

  // 面试行仍在（不物理删），状态回退到 CANCELLED。
  const after = await query<{ n: string; status: string }>(
    `select count(*)::text as n, max(status) as status from recruitment.interview
      where id = $1::uuid and tenant_id = $2`,
    [interviewId, TENANT],
  )
  assert.equal(after[0]?.n, '1', '撤销成功不得物理删除面试行')
  assert.equal(after[0]?.status, 'CANCELLED', '撤销成功状态必须回退到 CANCELLED')

  // 既有 interview.cancelled 审计事件必须落库。
  const events = await query<{ n: string }>(
    `select count(*)::text as n from recruitment.event_inbox
      where tenant_id = $1 and event_type = 'interview.cancelled'`,
    [TENANT],
  )
  assert.ok(Number(events[0]?.n) >= 1, 'interview.cancelled 审计事件必须落库')
  console.log(`[EVIDENCE T① undo 响应] ${JSON.stringify({
    action: undone.body.action, status: undone.body.status, action_id: undone.body.action_id,
    compensation_action_id: undone.body.compensation_action_id, target: undone.body.target,
    audit: undone.body.audit, confirmation_text_sha256: undone.body.confirmation_text_sha256,
  })}`)
  console.log(`[EVIDENCE T① SQL 读回] ${JSON.stringify({
    interview_id: interviewId,
    interview_before: before[0], interview_after: after[0],
    compensation: comp[0], original_pointer: original[0], cancelled_events: events[0]?.n,
  })}`)
  ;(globalThis as Record<string, unknown>).__undoCovActionId = actionId
  ;(globalThis as Record<string, unknown>).__undoCovCompensationId = compensationActionId
})

// =====================================================================
//  ② 超窗 409：occurred_at 已过 5 分钟 → UNDO_WINDOW_EXPIRED 且零写入
// =====================================================================

test('② 超窗撤销 → 409 UNDO_WINDOW_EXPIRED 且零写入（undo_log 行数不变、interview 状态不变）', async () => {
  const staleActionId = randomUUID()
  const staleInterviewId = await committedFixture(async (client) => {
    const interviewId = await one(
      client,
      `insert into recruitment.interview
         (tenant_id, application_id, round_no, slot_code, stage_code, status,
          scheduled_start_at, scheduled_end_at, status_changed_by_actor_id)
       values ($1, $2, 1, 'STALE', 'S8', 'SCHEDULED',
              now() + interval '2 days', now() + interval '2 days 1 hour', $3)
       returning id::text as id`,
      [TENANT, scenarioStale.applicationId, HR_ACTOR],
    )
    // undo_log  immutability 触发器只允许改 compensation/superseded 指针，occurred_at 改不了；
    // 直接在 INSERT 时给一个 6 分钟前的 occurred_at（与 batch-undo-http.test.ts 同款手法）。
    await client.query(
      `insert into recruitment.undo_log
        (tenant_id, action_id, kind, operation_type, action_type, actor_id, reason,
         confirmation_text_sha256, occurred_at, target_application_id, target_interview_id)
       values ($1, $2::uuid, 'ORIGINAL', 'SINGLE_SCHEDULE', 'SCHEDULE', $3, '超窗夹具',
               $4, now() - interval '6 minutes', $5::uuid, $6::uuid)`,
      [TENANT, staleActionId, HR_ACTOR, hex64('undo-cov-stale'), scenarioStale.applicationId, interviewId],
    )
    return interviewId
  })

  const before = await query<{ undo_log: string; interview_status: string }>(
    `select (select count(*)::text from recruitment.undo_log
              where tenant_id = $1 and kind = 'COMPENSATION') as undo_log,
            (select status from recruitment.interview where id = $2::uuid and tenant_id = $1) as interview_status`,
    [TENANT, staleInterviewId],
  )
  const result = await call(UNDO_PATH, {
    session: SESSION,
    body: { action_id: staleActionId, confirmation_text: '超窗撤销应被拒。' },
  })
  assertError(result, 409, 'UNDO_WINDOW_EXPIRED', 'UNDO_WINDOW_EXPIRED')
  const after = await query<{ undo_log: string; interview_status: string }>(
    `select (select count(*)::text from recruitment.undo_log
              where tenant_id = $1 and kind = 'COMPENSATION') as undo_log,
            (select status from recruitment.interview where id = $2::uuid and tenant_id = $1) as interview_status`,
    [TENANT, staleInterviewId],
  )
  assert.deepEqual(after, before, '超窗撤销必须零写入：undo_log 行数与 interview 状态都不许变')
  console.log(`[EVIDENCE T② 超窗] ${JSON.stringify({
    stale_action_id: staleActionId, stale_interview_id: staleInterviewId,
    error: result.body.error, before, after,
  })}`)
})

// =====================================================================
//  ③ 重复撤销：第二次 already_undone 且 COMPENSATION 行数仍为 1
// =====================================================================

test('③ 重复撤销 → 第二次 already_undone，COMPENSATION 行数仍为 1（零写入）', async () => {
  const actionId = (globalThis as Record<string, unknown>).__undoCovActionId as string
  const compensationId = (globalThis as Record<string, unknown>).__undoCovCompensationId as string
  const before = await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log
      where tenant_id = $1 and kind = 'COMPENSATION' and action_id = $2::uuid`,
    [TENANT, compensationId],
  )
  assert.equal(before[0]?.n, '1', '前置：场景①只写了一条 COMPENSATION')

  const second = await call(UNDO_PATH, {
    session: SESSION,
    body: { action_id: actionId, confirmation_text: '再撤销一次（应被幂等拒绝）。' },
  })
  assert.equal(second.status, 200, second.text)
  assert.equal(second.body.status, 'already_undone', second.text)

  const after = await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log
      where tenant_id = $1 and kind = 'COMPENSATION' and action_id = $2::uuid`,
    [TENANT, compensationId],
  )
  assert.equal(after[0]?.n, '1', '重复撤销不得写第二条 COMPENSATION')
  console.log(`[EVIDENCE T③ 重复撤销] ${JSON.stringify({
    action_id: actionId, compensation_action_id: compensationId,
    second_status: second.body.status, comp_rows_before: before[0]?.n, comp_rows_after: after[0]?.n,
  })}`)
})

// =====================================================================
//  ④ 面试官前简报：PIN + HANDOFF（来自上一轮，from_previous_round:true），无内部 id
// =====================================================================

test('④ 面试官 overview 读到 PIN 与上一轮 HANDOFF（from_previous_round=true），且不吐内部 id', async () => {
  await inRolledBackTx(db.pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [criterion({ key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true })],
      fields: parsedFields({ entryCount: 1 }),
      approve: true,
      pinRubric: true,
      bindMaterial: true,
    })

    // 上一轮（round 1）：HANDOFF 由这一轮的面试官留下，指向下一轮（本轮 round 2）的 interview_id。
    const priorInterviewId = await one(
      client,
      `insert into recruitment.interview
         (tenant_id, application_id, round_no, slot_code, status,
          scheduled_start_at, scheduled_end_at, status_changed_by_actor_id)
       values ($1, $2, 1, 'PRIOR', 'POST_INTERVIEW', now() - interval '3 days',
              now() - interval '3 days' + interval '1 hour', $3) returning id::text as id`,
      [TENANT, scenario.applicationId, HR_ACTOR],
    )
    // 本轮（round 2）：被简报的面试；HANDOFF.interview_id 必须指向它（读投影按本轮 id 取）。
    const currentInterviewId = await one(
      client,
      `insert into recruitment.interview
         (tenant_id, application_id, round_no, slot_code, status,
          scheduled_start_at, scheduled_end_at, status_changed_by_actor_id)
       values ($1, $2, 2, 'CURRENT', 'SCHEDULED', now() + interval '1 day',
              now() + interval '1 day 1 hour', $3) returning id::text as id`,
      [TENANT, scenario.applicationId, HR_ACTOR],
    )
    await one(
      client,
      `insert into recruitment.interviewer (tenant_id, interview_id, actor_id, required_scorecard)
       values ($1, $2, $3, true) returning id::text as id`,
      [TENANT, currentInterviewId, INTERVIEWER],
    )

    // 候选级 PIN（按 candidate_id 读）+ 上一轮留下的 HANDOFF（指向本轮 interview）。
    await one(
      client,
      `insert into recruitment.candidate_constraint
        (tenant_id, candidate_id, kind, text, source, application_id, created_by_actor_id)
       values ($1, $2, 'PIN', $3, 'CHAT', $4, $5) returning id::text as id`,
      [TENANT, scenario.candidateId, PIN_TEXT, scenario.applicationId, HR_ACTOR],
    )
    const handoffId = await one(
      client,
      `insert into recruitment.candidate_constraint
        (tenant_id, candidate_id, kind, text, source, application_id, interview_id, created_by_actor_id)
       values ($1, $2, 'HANDOFF', $3, 'CHAT', $4, $5, $6) returning id::text as id`,
      [TENANT, scenario.candidateId, HANDOFF_TEXT, scenario.applicationId, currentInterviewId, HR_ACTOR],
    )

    // 独立读回：夹具真的在库里（不是测试想象）。
    const rows = await client.query<{ kind: string; text: string; interview_id: string | null }>(
      `select kind, text, interview_id::text as interview_id from recruitment.candidate_constraint
        where tenant_id = $1 and candidate_id = $2 and superseded_by_constraint_id is null
        order by kind, created_at`,
      [TENANT, scenario.candidateId],
    )
    assert.equal(rows.rows.length, 2, 'PIN + HANDOFF 两行必须真实存在')
    assert.ok(rows.rows.some((row) => row.kind === 'PIN' && row.text === PIN_TEXT))
    assert.ok(rows.rows.some((row) => row.kind === 'HANDOFF' && row.text === HANDOFF_TEXT && row.interview_id === currentInterviewId))

    const overview: InterviewerOverview = await readInterviewerWorkspace(client, cfg, {
      alias: 'interviewer_a', actor_id: INTERVIEWER, display_name: 'A', session_id: 'session-undo-cov-brief',
    }, { interviewId: currentInterviewId })
    const row: InterviewerRow | undefined = overview.interviews.find((item) => item.interview_id === currentInterviewId)
    assert.ok(row !== undefined, '简报必须包含本轮 interview 行')

    const cc = row!.candidate_constraints
    assert.ok(cc.pins.some((pin) => pin.text === PIN_TEXT), `pins 必须含 PIN 文本：${JSON.stringify(cc.pins)}`)
    assert.ok(cc.handoff !== null, 'handoff 必须存在')
    assert.equal(cc.handoff!.text, HANDOFF_TEXT, 'handoff 文本必须来自上一轮 HANDOFF 行')
    assert.equal(cc.handoff!.from_previous_round, true, 'handoff 必须标记 from_previous_round=true')

    // 无内部 id 字段：PIN/HANDOFF 投影只含 text/source/created_by/created_at(+from_previous_round)。
    const json = JSON.stringify(cc)
    for (const id of [handoffId, scenario.candidateId, scenario.applicationId, priorInterviewId, currentInterviewId]) {
      assert.equal(json.includes(id), false, `候选约束投影不得出现内部 id ${id}`)
    }
    for (const pin of cc.pins) {
      assert.deepEqual(Object.keys(pin).sort(), ['created_at', 'created_by', 'source', 'text'], 'PIN 投影不得带 id')
    }
    assert.deepEqual(Object.keys(cc.handoff!).sort(), [
      'created_at', 'created_by', 'from_previous_round', 'source', 'text',
    ], 'HANDOFF 投影不得带 id')
    console.log(`[EVIDENCE T④ candidate_constraints] ${JSON.stringify(cc)}`)
    console.log(`[EVIDENCE T④ brief.questions] ${JSON.stringify(row!.brief.questions)}`)
  })
})
