// 批量不通过 / 撤销（5 秒 Toast）两条 HTTP 入口的**真库 + 真 HTTP** 集成测试。
//
// 纪律（与 demo-actor-http.test.ts / job-draft-create-action.test.ts 同口径）：
//   1. 独占一次性库 `createIsolatedTestDatabase('batchundo')`（0001→0020 重放），结束 drop；
//   2. 真 `node:http` server + 真 registerBatchUndoHttp 注册 exact 路由（R2 可达性）；
//   3. 断言只信独立 SQL 读回（decision / event_inbox / undo_log / batch_operation / application）；
//   4. 每条拒绝路径都断言「HTTP 码 + 目标表行数前后不变」（L5 反证）；
//   5. 不写口令/凭据进文件（口令只从 env 读）。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerBatchUndoHttp, type BatchUndoHttpDeps } from '../../src/http/batch-undo.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  criterion,
  createIsolatedTestDatabase,
  HR_ACTOR,
  parsedFields,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
  type Scenario,
} from './db.ts'

const BASE = testDatabaseConfig()
const SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_UNBOUND = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BATCH_PATH = '/recruitment/api/action/decision/batch-reject'
const UNDO_PATH = '/recruitment/api/action/undo'
// REJECT 理由必须点到一个 rubric dimension_key（决策域 DC-18 闸门，不能绕过）。
const REASON = '批量不通过：work_exists 维度下候选人经历与岗位要求不符'
const CONFIRMATION = '确认：这批申请都不通过。'
const UNKNOWN_APP = '00000000-0000-4000-8000-000000000099'

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let server: Server
let baseUrl = ''
let scenarioA: Scenario
let scenarioB: Scenario

interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

async function call(
  path: string,
  options: {
    readonly session?: string
    readonly body?: unknown
    readonly omitSameOrigin?: boolean
    readonly headers?: Record<string, string>
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.omitSameOrigin !== true) headers['x-recruitment-request'] = '1'
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

async function query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

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

function rejectBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    application_ids: [scenarioA.applicationId, UNKNOWN_APP],
    reason: REASON,
    confirmation_text: CONFIRMATION,
    ...overrides,
  }
}

function assertError(result: HttpResult, status: number, code: string, reasonCode?: string): void {
  assert.equal(result.status, status, `HTTP ${status} expected: ${result.text}`)
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `error envelope expected: ${result.text}`)
  assert.equal(error.code, code, result.text)
  if (reasonCode !== undefined) assert.equal(error.reason_code, reasonCode, result.text)
}

before(async () => {
  db = await createIsolatedTestDatabase('batchundo')
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
    scenarioA = await seedScenario(client, common)
    scenarioB = await seedScenario(client, common)
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
  const deps: BatchUndoHttpDeps = { database: cfg, databaseIssues: [], identity }
  registerBatchUndoHttp(
    {
      webServer: {
        host: '127.0.0.1',
        port,
        register(route) {
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
    },
    deps,
  )
})

after(async () => {
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (db !== undefined) await db.drop()
})

test('0. 接线可达：两条 exact 路由已注册（R2）', async () => {
  const missing = await call(BATCH_PATH, { session: SESSION, omitSameOrigin: true })
  assertError(missing, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')
  const wrongMethod = await fetch(`${baseUrl}${BATCH_PATH}`, { method: 'GET', headers: { 'x-recruitment-request': '1' } })
  assert.equal(wrongMethod.status, 405)
})

test('1. 闸门：未绑定 session / 越权 alias / 身份覆盖键（零写入）', async () => {
  const before = (await query<{ n: string }>('select count(*)::text as n from recruitment.batch_operation'))[0]?.n
  const unbound = await call(BATCH_PATH, { session: SESSION_UNBOUND, body: rejectBody() })
  assertError(unbound, 409, 'DEMO_ACTOR_UNMAPPED')
  const noSession = await call(BATCH_PATH, { body: rejectBody() })
  assertError(noSession, 400, 'INVALID_ARGS', 'SESSION_REQUIRED')
  const override = await call(BATCH_PATH, { session: SESSION, body: rejectBody({ actor_id: HR_ACTOR }) })
  assertError(override, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
  const hashOverride = await call(BATCH_PATH, { session: SESSION, body: rejectBody({ confirmation_text_sha256: 'a'.repeat(64) }) })
  assertError(hashOverride, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
  const after = (await query<{ n: string }>('select count(*)::text as n from recruitment.batch_operation'))[0]?.n
  assert.equal(after, before, '闸门拒绝路径必须零写入')
})

test('2. 批量不通过：一成功一失败，HTTP 200（部分失败不回滚）+ DB 读回', async () => {
  const result = await call(BATCH_PATH, { session: SESSION, body: rejectBody() })
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.action, 'decision/batch-reject')
  assert.equal(result.body.succeeded, 1, result.text)
  assert.equal(result.body.failed, 1, result.text)
  const results = result.body.results as Record<string, unknown>[]
  assert.equal(results.length, 2)
  const ok = results.find((r) => r.application_id === scenarioA.applicationId)
  const bad = results.find((r) => r.application_id === UNKNOWN_APP)
  assert.equal(ok?.ok, true, result.text)
  assert.ok(typeof ok?.action_id === 'string', '成功项必须带 action_id 供撤销')
  assert.equal(bad?.ok, false, result.text)
  assert.ok(typeof bad?.reason_code === 'string' && bad.reason_code !== '', result.text)

  // 独立 SQL 读回：成功那条有 REJECT 决策 + S7 阶段 + CLOSED lifecycle + decision.record 事件。
  const decisions = await query<{ decision_id: string; result: string; stage_code: string; superseded_by: string | null }>(
    `select id::text as decision_id, result, stage_code, superseded_by_decision_id::text as superseded_by
       from recruitment.decision where tenant_id = $1 and application_id = $2`,
    [TENANT, scenarioA.applicationId],
  )
  assert.equal(decisions.length, 1, '成功项恰好一条决策')
  assert.equal(decisions[0]?.result, 'REJECT')
  assert.equal(decisions[0]?.stage_code, 'S7')
  const app = (await query<{ status: string; stage: string }>(
    'select lifecycle_status as status, current_stage_code as stage from recruitment.application where id = $1 and tenant_id = $2',
    [scenarioA.applicationId, TENANT],
  ))[0]
  assert.equal(app?.status, 'CLOSED')
  assert.equal(app?.stage, 'S7')
  const events = await query<{ n: string }>(
    `select count(*)::text as n from recruitment.event_inbox
      where tenant_id = $1 and event_type = 'decision.record'
        and payload->>'application_id' = $2`,
    [TENANT, scenarioA.applicationId],
  )
  assert.ok(Number(events[0]?.n) >= 1, '既有 decision.record 事件必须落库')
  const badDecisions = await query<{ n: string }>(
    'select count(*)::text as n from recruitment.decision where tenant_id = $1 and application_id = $2',
    [TENANT, UNKNOWN_APP],
  )
  assert.equal(badDecisions[0]?.n, '0', '失败项零写入决策')
  const audit = result.body.audit as Record<string, unknown>
  assert.equal(audit.undo_log_rows, 1)
  const opRows = await query<{ n: string; succeeded: string; failed: string }>(
    `select count(*)::text as n, max(succeeded_count)::text as succeeded, max(failed_count)::text as failed
       from recruitment.batch_operation where tenant_id = $1 and action_id = $2::uuid`,
    [TENANT, result.body.action_id],
  )
  assert.equal(opRows[0]?.n, '1')
  assert.equal(opRows[0]?.succeeded, '1')
  assert.equal(opRows[0]?.failed, '1')
  ;(globalThis as Record<string, unknown>).__batchActionId = result.body.action_id
  ;(globalThis as Record<string, unknown>).__perItemActionId = ok?.action_id
  ;(globalThis as Record<string, unknown>).__decisionId = decisions[0]?.decision_id
})

test('3. 幂等：同 (application_id, reason) 重复提交不产生第二条 current 决策', async () => {
  const decisionCountBefore = (await query<{ n: string }>(
    'select count(*)::text as n from recruitment.decision where tenant_id = $1 and application_id = $2',
    [TENANT, scenarioA.applicationId],
  ))[0]?.n
  const second = await call(BATCH_PATH, { session: SESSION, body: rejectBody() })
  assert.equal(second.status, 200, second.text)
  const secondResults = second.body.results as Record<string, unknown>[]
  const okAgain = secondResults.find((r) => r.application_id === scenarioA.applicationId)
  assert.equal(okAgain?.ok, true, second.text)
  assert.equal(okAgain?.reason_code, 'ALREADY_DECIDED_IDEMPOTENT', second.text)
  const decisionCountAfter = (await query<{ n: string }>(
    'select count(*)::text as n from recruitment.decision where tenant_id = $1 and application_id = $2',
    [TENANT, scenarioA.applicationId],
  ))[0]?.n
  assert.equal(decisionCountAfter, decisionCountBefore, '幂等重放零写入第二条决策')
})

test('4. 撤销：补偿而非删除（既有 supersede 路径 + undo_log COMPENSATION）', async () => {
  const actionId = (globalThis as Record<string, unknown>).__perItemActionId as string
  const oldDecisionId = (globalThis as Record<string, unknown>).__decisionId as string
  const decisionsBefore = (await query<{ n: string }>(
    'select count(*)::text as n from recruitment.decision where tenant_id = $1 and application_id = $2',
    [TENANT, scenarioA.applicationId],
  ))[0]?.n
  const result = await call(UNDO_PATH, {
    session: SESSION,
    body: { action_id: actionId, confirmation_text: '确认撤销刚才那批不通过。' },
  })
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.status, 'undone')
  assert.ok(typeof result.body.compensation_action_id === 'string')

  // 独立 SQL 读回：旧决策仍在（不物理删），已被新 WITHDRAW 决策 supersede。
  const old = (await query<{ result: string; superseded_by: string | null }>(
    'select result, superseded_by_decision_id::text as superseded_by from recruitment.decision where id = $1 and tenant_id = $2',
    [oldDecisionId, TENANT],
  ))[0]
  assert.equal(old?.result, 'REJECT')
  assert.ok(old?.superseded_by !== null, '旧行必须保留且被换指针（不物理删）')
  const decisionsAfter = await query<{ result: string }>(
    `select result from recruitment.decision where tenant_id = $1 and application_id = $2`,
    [TENANT, scenarioA.applicationId],
  )
  assert.equal(decisionsAfter.length, Number(decisionsBefore) + 1, '撤销反向插一条，历史不删')
  assert.ok(decisionsAfter.some((d) => d.result === 'REJECT'), '旧 REJECT 行仍在')
  assert.ok(decisionsAfter.some((d) => d.result === 'WITHDRAW'), '新 WITHDRAW 行已插入')
  const comp = await query<{ action_id: string; operation_type: string }>(
    `select action_id::text, operation_type from recruitment.undo_log
      where tenant_id = $1 and kind = 'COMPENSATION' and action_id = $2::uuid`,
    [TENANT, result.body.compensation_action_id],
  )
  assert.equal(comp.length, 1, 'COMPENSATION 行必须落库')
  assert.equal(comp[0]?.operation_type, 'UNDO')
  const original = (await query<{ compensation_action_id: string | null }>(
    `select compensation_action_id::text from recruitment.undo_log
      where tenant_id = $1 and kind = 'ORIGINAL' and action_id = $2::uuid`,
    [TENANT, actionId],
  ))[0]
  assert.equal(original?.compensation_action_id, result.body.compensation_action_id, 'ORIGINAL 行必须指向补偿行')
  ;(globalThis as Record<string, unknown>).__compensationActionId = result.body.compensation_action_id
})

test('5. 撤销幂等：第二次 already_undone 且零写入', async () => {
  const actionId = (globalThis as Record<string, unknown>).__perItemActionId as string
  const before = await query<{ table_name: string; n: string }>(
    `select 'undo_log' as table_name, count(*)::text as n from recruitment.undo_log where tenant_id = $1
     union all select 'decision', count(*)::text from recruitment.decision where tenant_id = $1
     union all select 'batch_operation', count(*)::text from recruitment.batch_operation where tenant_id = $1`,
    [TENANT],
  )
  const second = await call(UNDO_PATH, {
    session: SESSION,
    body: { action_id: actionId, confirmation_text: '再撤销一次（应被幂等拒绝）。' },
  })
  assert.equal(second.status, 200, second.text)
  assert.equal(second.body.status, 'already_undone', second.text)
  const after = await query<{ table_name: string; n: string }>(
    `select 'undo_log' as table_name, count(*)::text as n from recruitment.undo_log where tenant_id = $1
     union all select 'decision', count(*)::text from recruitment.decision where tenant_id = $1
     union all select 'batch_operation', count(*)::text from recruitment.batch_operation where tenant_id = $1`,
    [TENANT],
  )
  assert.deepEqual(after, before, '第二次撤销必须零写入')
})

test('6. 时限：5 分钟窗口外的撤销 → 409 UNDO_WINDOW_EXPIRED 且零写入', async () => {
  const staleActionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  await committedFixture(async (client) => {
    await client.query(
      `insert into recruitment.undo_log
        (tenant_id, action_id, kind, operation_type, action_type, actor_id, reason,
         confirmation_text_sha256, occurred_at, target_application_id)
       values ($1, $2::uuid, 'ORIGINAL', 'SINGLE_DECISION', 'DECISION', $3, '超时的旧操作',
               $4, now() - interval '6 minutes', $5::uuid)`,
      [TENANT, staleActionId, HR_ACTOR, 'a'.repeat(64), scenarioB.applicationId],
    )
  })
  const before = await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log
      where tenant_id = $1 and kind = 'COMPENSATION'`, [TENANT],
  )
  const result = await call(UNDO_PATH, {
    session: SESSION,
    body: { action_id: staleActionId, confirmation_text: '超时撤销应被拒。' },
  })
  assertError(result, 409, 'UNDO_WINDOW_EXPIRED', 'UNDO_WINDOW_EXPIRED')
  const after = await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log
      where tenant_id = $1 and kind = 'COMPENSATION'`, [TENANT],
  )
  assert.equal(after[0]?.n, before[0]?.n, '超时撤销必须零写入')
})

test('7. UNDO_SUPERSEDED：被后续动作影响的动作不可撤销（零写入）', async () => {
  const actionId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  await committedFixture(async (client) => {
    await client.query(
      `insert into recruitment.undo_log
        (tenant_id, action_id, kind, operation_type, action_type, actor_id, reason,
         confirmation_text_sha256, occurred_at, target_application_id, superseded_by_action_id)
       values ($1, $2::uuid, 'ORIGINAL', 'SINGLE_DECISION', 'DECISION', $3, '已被后续动作影响',
               $4, now(), $5::uuid, $6::uuid)`,
      [TENANT, actionId, HR_ACTOR, 'b'.repeat(64), scenarioB.applicationId, UNKNOWN_APP],
    )
  })
  const before = (await query<{ n: string }>(
    "select count(*)::text as n from recruitment.undo_log where tenant_id = $1 and kind = 'COMPENSATION'", [TENANT],
  ))[0]?.n
  const result = await call(UNDO_PATH, {
    session: SESSION,
    body: { action_id: actionId, confirmation_text: '已被影响的撤销应被拒。' },
  })
  assertError(result, 409, 'UNDO_SUPERSEDED', 'UNDO_SUPERSEDED')
  const after = (await query<{ n: string }>(
    "select count(*)::text as n from recruitment.undo_log where tenant_id = $1 and kind = 'COMPENSATION'", [TENANT],
  ))[0]?.n
  assert.equal(after, before, 'UNDO_SUPERSEDED 必须零写入')
})

test('7b. 排期撤销：走既有 interview_schedule CANCEL（行保留、status=CANCELLED、既有事件）', async () => {
  const actionId = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  let interviewId = ''
  await committedFixture(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into recruitment.interview
         (tenant_id, application_id, round_no, slot_code, stage_code, status,
          scheduled_start_at, scheduled_end_at, status_changed_by_actor_id)
       values ($1, $2, 1, 'UNDO_TEST', 'S8', 'SCHEDULED',
              now() + interval '1 day', now() + interval '1 day 1 hour', $3)
       returning id::text as id`,
      [TENANT, scenarioB.applicationId, HR_ACTOR],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('interview insert failed')
    interviewId = row.id
    await client.query(
      `insert into recruitment.undo_log
        (tenant_id, action_id, kind, operation_type, action_type, actor_id, reason,
         confirmation_text_sha256, occurred_at, target_application_id, target_interview_id)
       values ($1, $2::uuid, 'ORIGINAL', 'SINGLE_SCHEDULE', 'SCHEDULE', $3, '原排期动作',
               $4, now(), $5::uuid, $6::uuid)`,
      [TENANT, actionId, HR_ACTOR, 'c'.repeat(64), scenarioB.applicationId, interviewId],
    )
  })
  const interviewsBefore = (await query<{ n: string }>(
    'select count(*)::text as n from recruitment.interview where id = $1::uuid and tenant_id = $2',
    [interviewId, TENANT],
  ))[0]?.n
  const result = await call(UNDO_PATH, {
    session: SESSION,
    body: { action_id: actionId, confirmation_text: '确认撤销刚才那场面试。' },
  })
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.status, 'undone')
  const after = (await query<{ status: string; version: number }>(
    'select status, record_version as version from recruitment.interview where id = $1::uuid and tenant_id = $2',
    [interviewId, TENANT],
  ))[0]
  assert.equal(after?.status, 'CANCELLED', '排期撤销 = CANCEL 状态迁移')
  assert.ok((after?.version ?? 0) > 1, 'record_version 必须递增（既有 update 路径）')
  const interviewsAfter = (await query<{ n: string }>(
    'select count(*)::text as n from recruitment.interview where id = $1::uuid and tenant_id = $2',
    [interviewId, TENANT],
  ))[0]?.n
  assert.equal(interviewsAfter, interviewsBefore, '历史面试行一律不物理删除')
  const events = await query<{ n: string }>(
    `select count(*)::text as n from recruitment.event_inbox
      where tenant_id = $1 and event_type = 'interview.cancelled'`,
    [TENANT],
  )
  assert.ok(Number(events[0]?.n) >= 1, '既有 interview.cancelled 审计事件必须落库')
  const comp = await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log
      where tenant_id = $1 and kind = 'COMPENSATION' and action_id = $2::uuid`,
    [TENANT, result.body.compensation_action_id],
  )
  assert.equal(comp[0]?.n, '1', 'COMPENSATION 行必须落库')
})

test('8. 入参边界：application_ids 1..50 / reason ≤500 / confirmation_text 必填', async () => {
  const before = (await query<{ n: string }>(
    'select count(*)::text as n from recruitment.batch_operation where tenant_id = $1', [TENANT],
  ))[0]?.n
  const empty = await call(BATCH_PATH, { session: SESSION, body: rejectBody({ application_ids: [] }) })
  assertError(empty, 400, 'INVALID_ARGS')
  const tooMany = await call(BATCH_PATH, { session: SESSION, body: rejectBody({ application_ids: Array(51).fill(scenarioA.applicationId) }) })
  assertError(tooMany, 400, 'INVALID_ARGS')
  const longReason = await call(BATCH_PATH, { session: SESSION, body: rejectBody({ reason: 'x'.repeat(501) }) })
  assertError(longReason, 400, 'INVALID_ARGS')
  const noText = await call(BATCH_PATH, { session: SESSION, body: rejectBody({ confirmation_text: '  ' }) })
  assertError(noText, 400, 'INVALID_ARGS')
  const after = (await query<{ n: string }>(
    'select count(*)::text as n from recruitment.batch_operation where tenant_id = $1', [TENANT],
  ))[0]?.n
  assert.equal(after, before, '入参拒绝路径必须零写入')
})
