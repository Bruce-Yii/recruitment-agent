// undo-coverage（子代理 A / undo-a）：刚排的面试也能被 5 秒撤销 —— ORIGINAL 落库 + 同事务性证据。
//
// 纪律（与 batch-undo-http.test.ts / interview-schedule.test.ts 同口径）：
//   1. 独占一次性库 `createIsolatedTestDatabase('undoorig')`（0001→0020 重放），结束 drop；
//   2. 真 `node:http` server + 真 `registerActionsHttp` 注册 exact 路由（R2 可达性）；
//   3. 断言只信独立 SQL 读回（undo_log / interview），不回显工具输出、不 import 产品业务规则；
//   4. 负例断言「HTTP 非 2xx + 目标表行数前后不变」（L5 反证）；
//   5. 不碰 ra_s6s7 / ra_freeze_final，口令只从 env 读。
//
// 覆盖：
//   T1 排期成功 → undo_log 有 SINGLE_SCHEDULE / SCHEDULE / ORIGINAL 行，target_interview_id /
//      target_application_id / before_summary / actor / sha256 形状正确；
//   T2 业务失败（申请不存在）→ 零写入，undo_log 与 interview 行数不变（同事务回滚）；
//   T3 审计写失败（测试专用 trigger 阻断 SINGLE_SCHEDULE 插入）→ 业务写也回滚（同事务反证）；
//   T4 ORIGINAL 行真能被既有 undo 接口消费（CANCEL 补偿， interview → CANCELLED）。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerActionsHttp, type ActionHttpDeps } from '../../src/http/actions.ts'
import {
  registerBatchUndoHttp,
  type BatchUndoHttpDeps,
} from '../../src/http/batch-undo.ts'
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
const SESSION = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SCHEDULE_PATH = '/recruitment/api/action/interview/schedule'
const UNDO_PATH = '/recruitment/api/action/undo'
const INTERVIEWER = '11111111-1111-4111-8111-000000000104'
const UNKNOWN_APP = '00000000-0000-4000-8000-000000000099'
// 远期基准 + 每次进程随机偏移（隔离库无并发数据，但仍避免写死时间点）。
const SLOT_BASE_MS = Date.parse('2031-06-01T10:00:00+08:00') + Math.floor(Math.random() * 300 * 24 * 60) * 60_000
const at = (minutes: number): string => new Date(SLOT_BASE_MS + minutes * 60_000).toISOString()

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let server: Server
let baseUrl = ''
let scenario: Scenario

interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

async function call(path: string, options: {
  readonly session?: string
  readonly body?: unknown
  readonly omitSameOrigin?: boolean
} = {}): Promise<HttpResult> {
  const headers: Record<string, string> = {}
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

/** 造一份合法的 CREATE 排期 body。 */
function scheduleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'CREATE',
    idempotency_key: `undo-orig-${randomUUID()}`,
    application_id: scenario.applicationId,
    round_no: 1,
    slot_code: 'DEFAULT',
    interviewers: [{ actor_id: INTERVIEWER }],
    scheduled_start_at: at(0),
    duration_minutes: 60,
    ...overrides,
  }
}

before(async () => {
  db = await createIsolatedTestDatabase('undoorig')
  assertPrivateDatabase(db.name)
  cfg = { ...BASE, database: db.name }
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    scenario = await seedScenario(client, {
      dimensions: [
        criterion({ key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true }),
      ],
      fields: parsedFields({ entryCount: 1 }),
      approve: true,
      pinRubric: true,
      bindMaterial: true,
    })
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }

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
  const webServer = {
    host: '127.0.0.1',
    port,
    register(route: { readonly path: string; readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const deps: ActionHttpDeps = { database: cfg, databaseIssues: [], identity }
  registerActionsHttp({ webServer }, deps)
  registerBatchUndoHttp({ webServer }, { database: cfg, databaseIssues: [], identity } satisfies BatchUndoHttpDeps)
})

after(async () => {
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------

test('T1 排期成功：undo_log 落 SINGLE_SCHEDULE ORIGINAL 且目标引用正确（独立 SQL 读回）', async () => {
  const before = Number((await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log where tenant_id = $1 and kind = 'ORIGINAL'`, [TENANT],
  ))[0]?.n)
  const result = await call(SCHEDULE_PATH, { session: SESSION, body: scheduleBody() })
  assert.equal(result.status, 200, result.text)
  const readback = result.body.readback as Record<string, unknown> | undefined
  const interviewId = typeof readback?.interview_id === 'string' ? readback.interview_id : ''
  assert.ok(interviewId !== '', '排期响应 readback 必须有 interview id')

  const after = Number((await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log where tenant_id = $1 and kind = 'ORIGINAL'`, [TENANT],
  ))[0]?.n)
  assert.equal(after, before + 1, '一次真实排期只写一条 ORIGINAL')

  const rows = await query<{
    action_id: string
    operation_type: string
    action_type: string | null
    actor_id: string
    target_interview_id: string | null
    target_application_id: string | null
    before_summary: Record<string, unknown>
    confirmation_text_sha256: string
    occurred_at: string
  }>(
    `select action_id::text, operation_type, action_type, actor_id::text,
            target_interview_id::text, target_application_id::text, before_summary,
            confirmation_text_sha256, occurred_at::text
       from recruitment.undo_log
      where tenant_id = $1 and kind = 'ORIGINAL' and target_interview_id = $2::uuid`,
    [TENANT, interviewId],
  )
  assert.equal(rows.length, 1, '按 interview_id 可查到唯一 ORIGINAL（C 的撤销路径依赖此查询）')
  const row = rows[0] as NonNullable<typeof rows[number]>
  assert.equal(row.operation_type, 'SINGLE_SCHEDULE')
  assert.equal(row.action_type, 'SCHEDULE')
  assert.equal(row.actor_id, HR_ACTOR, 'ORIGINAL actor 必须与撤销预检的 actor_id_of_action 同源')
  assert.equal(row.target_interview_id, interviewId)
  assert.equal(row.target_application_id, scenario.applicationId, 'target_application_id 填好（审计更完整）')
  assert.equal(row.before_summary.operation, 'CREATE')
  assert.equal(row.before_summary.round_no, 1)
  assert.equal(row.before_summary.slot_code, 'DEFAULT')
  assert.match(row.confirmation_text_sha256, /^[0-9a-f]{64}$/, '服务端派生 sha256 形状')
  assert.ok(!Number.isNaN(Date.parse(row.occurred_at)), 'occurred_at 是库里生成的时间戳')

  const interview = (await query<{ status: string }>(
    `select status from recruitment.interview where id = $1::uuid and tenant_id = $2`, [interviewId, TENANT],
  ))[0]
  assert.equal(interview?.status, 'SCHEDULED', '业务写本身也真的落库')
  ;(globalThis as Record<string, unknown>).__undoA = {
    interviewId,
    actionId: row.action_id,
  }
})

test('T2 业务失败（申请不存在）：零写入，undo_log 与 interview 行数不变', async () => {
  const beforeUndo = Number((await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log where tenant_id = $1`, [TENANT],
  ))[0]?.n)
  const beforeInterview = Number((await query<{ n: string }>(
    `select count(*)::text as n from recruitment.interview where tenant_id = $1`, [TENANT],
  ))[0]?.n)
  const result = await call(SCHEDULE_PATH, {
    session: SESSION,
    body: scheduleBody({ application_id: UNKNOWN_APP }),
  })
  assert.notEqual(result.status, 200, result.text)
  const afterUndo = Number((await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log where tenant_id = $1`, [TENANT],
  ))[0]?.n)
  const afterInterview = Number((await query<{ n: string }>(
    `select count(*)::text as n from recruitment.interview where tenant_id = $1`, [TENANT],
  ))[0]?.n)
  assert.equal(afterUndo, beforeUndo, '业务失败时 ORIGINAL 不落库')
  assert.equal(afterInterview, beforeInterview, '业务失败时 interview 也不落库')
})

test('T3 审计写失败（测试专用 trigger）：同事务回滚，业务写不落库', async () => {
  const beforeUndo = Number((await query<{ n: string }>(
    `select count(*)::text as n from recruitment.undo_log where tenant_id = $1`, [TENANT],
  ))[0]?.n)
  const beforeInterview = Number((await query<{ n: string }>(
    `select count(*)::text as n from recruitment.interview where tenant_id = $1`, [TENANT],
  ))[0]?.n)
  try {
    await query(`create function recruitment.fn_undo_a_block_schedule_original() returns trigger as $$
      begin
        raise exception 'undo-a test: block SINGLE_SCHEDULE ORIGINAL';
      end; $$ language plpgsql`)
    await query(`create trigger trg_undo_a_block_schedule_original
      before insert on recruitment.undo_log
      for each row when (new.operation_type = 'SINGLE_SCHEDULE')
      execute function recruitment.fn_undo_a_block_schedule_original()`)

    const result = await call(SCHEDULE_PATH, { session: SESSION, body: scheduleBody({ slot_code: 'ALT' }) })
    assert.notEqual(result.status, 200, result.text)

    const afterUndo = Number((await query<{ n: string }>(
      `select count(*)::text as n from recruitment.undo_log where tenant_id = $1`, [TENANT],
    ))[0]?.n)
    const afterInterview = Number((await query<{ n: string }>(
      `select count(*)::text as n from recruitment.interview where tenant_id = $1`, [TENANT],
    ))[0]?.n)
    assert.equal(afterUndo, beforeUndo, '审计写失败 → undo_log 零写入')
    assert.equal(afterInterview, beforeInterview, '审计写失败 → 业务写也整笔回滚（同事务铁证）')
  } finally {
    await query('drop trigger if exists trg_undo_a_block_schedule_original on recruitment.undo_log')
    await query('drop function if exists recruitment.fn_undo_a_block_schedule_original()')
  }
})

test('T4 ORIGINAL 行能被既有 undo 接口消费：撤销后排期 interview → CANCELLED', async () => {
  const saved = (globalThis as Record<string, unknown>).__undoA as { interviewId: string; actionId: string }
  const result = await call(UNDO_PATH, {
    session: SESSION,
    body: { action_id: saved.actionId, confirmation_text: '确认撤销刚才那场面试排期。' },
  })
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.status, 'undone', result.text)
  const target = result.body.target as Record<string, unknown> | undefined
  assert.equal(target?.interview_id, saved.interviewId, '撤销目标 interview_id 来自 ORIGINAL 行')

  const interview = (await query<{ status: string }>(
    `select status from recruitment.interview where id = $1::uuid and tenant_id = $2`, [saved.interviewId, TENANT],
  ))[0]
  assert.equal(interview?.status, 'CANCELLED', '既有 CANCEL 补偿路径真的把面试改成 CANCELLED（不删行）')
  const comp = await query<{ operation_type: string }>(
    `select operation_type from recruitment.undo_log
      where tenant_id = $1 and kind = 'COMPENSATION' and action_id = $2::uuid`,
    [TENANT, result.body.compensation_action_id],
  )
  assert.equal(comp.length, 1, 'COMPENSATION 行落库')
  const original = (await query<{ compensation_action_id: string | null }>(
    `select compensation_action_id::text from recruitment.undo_log
      where tenant_id = $1 and kind = 'ORIGINAL' and action_id = $2::uuid`,
    [TENANT, saved.actionId],
  ))[0]
  assert.equal(original?.compensation_action_id, result.body.compensation_action_id, 'ORIGINAL 指针已链接到补偿行')
})
