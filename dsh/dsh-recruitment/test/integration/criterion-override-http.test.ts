// Issue #31 / G-08 · 人工纠偏 HTTP 路由真库集成测试（一次性库，0001→N 全量重放；结束 drop）。
//
// 覆盖：
//   ① 合法纠偏 → 200 + 纠偏摘要 + 独立只读读回（DB 真值）+ 同事务审计事件；
//   ② fail-closed 零写入：缺原话 / 非 rubric 维度 / 未绑定 session / 非 recruiter alias / 伪造服务端 hash /
//      同源闸门缺失 / 身份覆盖键（query/header/body）/ 未知键 / 非法 human_state；
//   ③ exact path 与错误状态映射（GET → 405；其它路径 → 404）；
//   ④ 幂等重复不写第二条审计事件。
//
// 只连一次性库，不碰 ra_s6s7；不发 npx / 不改产品代码。
import test, { before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'

import {
  createIsolatedTestDatabase,
  TENANT,
  HR_ACTOR,
  seedScenario,
  type IsolatedTestDatabase,
} from './db.ts'
import {
  CRITERION_OVERRIDE_CONTRACT,
  registerCriterionOverrideHttp,
  type CriterionOverrideHttpDeps,
} from '../../src/http/criterion-override.ts'
import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { withReadOnly } from '../../src/db/pool.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'

const SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_SESSION = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CONFIRM = '我确认：这条标准应该判为有对应。'
const CONFIRM_SHA = createHash('sha256').update(CONFIRM, 'utf8').digest('hex')

const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'edu_exists', label: '有教育经历', kind: 'MUST_HAVE', weight: 1, field: 'education', operator: 'EXISTS', value: true },
]

let db: IsolatedTestDatabase
let applicationId: string

before(async () => {
  db = await createIsolatedTestDatabase('criterion_override_http')
  const client = await db.pool.connect()
  try {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    applicationId = scenario.applicationId
  } finally {
    client.release()
  }
})

after(async () => {
  if (db !== undefined) await db.drop()
})

interface HttpHarness {
  readonly baseUrl: string
  readonly port: number
  close(): Promise<void>
}

async function startHttp(identity: DemoActorIdentity): Promise<HttpHarness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    Promise.resolve().then(() => handler(req, res)).catch(() => res.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  registerCriterionOverrideHttp(
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
    httpDeps(identity),
  )
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

function httpDeps(identity: DemoActorIdentity): CriterionOverrideHttpDeps {
  return {
    database: {
      host: '127.0.0.1',
      port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
      user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
      database: db.name,
      password: process.env.RECRUITMENT_DB_PASSWORD ?? '',
      password_env: 'RECRUITMENT_DB_PASSWORD',
      tenant_id: TENANT,
      actor_id: HR_ACTOR,
      statement_timeout_ms: 15000,
      connect_timeout_ms: 10000,
      max: 4,
    },
    databaseIssues: [],
    identity,
  }
}

interface CallOptions {
  readonly method?: string
  readonly path?: string
  readonly session?: string | null
  readonly body?: unknown
  readonly requestHeader?: string | null
  readonly host?: string
  readonly extraHeaders?: Record<string, string>
}

async function call(h: HttpHarness, opts: CallOptions = {}) {
  const headers: Record<string, string> = {}
  const requestHeader = opts.requestHeader === undefined ? '1' : opts.requestHeader
  if (requestHeader !== null) headers['x-recruitment-request'] = requestHeader
  if (opts.session !== null && opts.session !== undefined) headers['x-dsh-session'] = opts.session
  if (opts.host !== undefined) headers.host = opts.host
  if (opts.extraHeaders !== undefined) Object.assign(headers, opts.extraHeaders)
  let payload: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(opts.body)
  }
  const response = await fetch(`${h.baseUrl}${opts.path ?? CRITERION_OVERRIDE_CONTRACT.path}`, {
    method: opts.method ?? 'POST',
    headers,
    body: payload,
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
  return { status: response.status, body, text }
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    application_id: applicationId,
    criterion_key: 'work_exists',
    human_state: 'PRESENT',
    note: '简历第 2 页写了 2019-至今。',
    confirmation_text: CONFIRM,
    ...overrides,
  }
}

function boundIdentity(): DemoActorIdentity {
  const identity = createDemoActorIdentity().identity
  identity.registry.bind(SESSION, 'recruiter', { display_name: '招聘负责人' })
  return identity
}

async function tableCounts(): Promise<{ overrides: number; events: number }> {
  return withReadOnly(db.pool, async (client) => {
    const overrides = await client.query<{ n: string }>(
      'select count(*)::text as n from recruitment.criterion_override where tenant_id = $1', [TENANT])
    const events = await client.query<{ n: string }>(
      'select count(*)::text as n from recruitment.event_inbox where tenant_id = $1 and event_type = $2',
      [TENANT, EVENT_TYPES.CRITERION_OVERRIDE_RECORDED])
    return { overrides: Number(overrides.rows[0]?.n ?? '0'), events: Number(events.rows[0]?.n ?? '0') }
  })
}

async function assertSameCounts(before: { overrides: number; events: number }): Promise<void> {
  const after = await tableCounts()
  assert.deepEqual(after, before, '负例必须零写入（覆盖行 + 审计事件行数均不变）')
}

function errorReason(body: Record<string, unknown>): string {
  const error = body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `响应缺 error 信封：${JSON.stringify(body)}`)
  assert.equal(typeof error.reason_code, 'string')
  return error.reason_code as string
}

describe('G-08 人工纠偏 HTTP 路由 · 真库端到端', () => {
  test('合法纠偏 → 200：摘要 + 独立读回 + 审计事件（真库）', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const result = await call(h, { session: SESSION, body: validBody() })
    assert.equal(result.status, 200, result.text)
    const body = result.body as {
      contract_version: string
      action: string
      tool: string
      actor: { alias: string; actor_id: string }
      override: { application_id: string; criterion_key: string; human_state: string; inserted: boolean; override_id: string; confirmation_text_sha256: string; actor_id: string }
      readback: { table: string; current: { override_id: string; human_state: string; record_version: number; confirmation_text_sha256: string } }
      audit: { event_type: string; event_recorded: boolean; normalizer_version: string }
    }
    assert.equal(body.action, 'criterion/override')
    assert.equal(body.tool, 'recruitment_criterion_override')
    assert.equal(body.actor.alias, 'recruiter')
    assert.equal(body.actor.actor_id, HR_ACTOR)
    assert.equal(body.override.inserted, true)
    assert.equal(body.override.confirmation_text_sha256, CONFIRM_SHA, 'hash 由服务端算，不回显原文')
    assert.equal(body.readback.table, 'criterion_override')
    assert.equal(body.readback.current.override_id, body.override.override_id, '独立读回指向同一行')
    assert.equal(body.readback.current.human_state, 'PRESENT')
    assert.equal(body.readback.current.confirmation_text_sha256, CONFIRM_SHA)
    assert.equal(body.audit.event_type, EVENT_TYPES.CRITERION_OVERRIDE_RECORDED)
    assert.equal(body.audit.event_recorded, true)

    // 真库独立核对：覆盖行 + 审计事件 payload。
    const verified = await withReadOnly(db.pool, async (client) => {
      const row = await client.query<Record<string, unknown>>(
        `select id, human_state, confirmation_text_sha256, actor_id from recruitment.criterion_override
          where tenant_id = $1 and application_id = $2 and criterion_key = 'work_exists'
            and superseded_by_override_id is null`, [TENANT, applicationId])
      const event = await client.query<Record<string, unknown>>(
        `select payload, event_type, normalizer_version from recruitment.event_inbox
          where tenant_id = $1 and event_type = $2 and payload->>'application_id' = $3`,
        [TENANT, EVENT_TYPES.CRITERION_OVERRIDE_RECORDED, applicationId])
      return { row: row.rows[0], event: event.rows[0] }
    })
    assert.equal(verified.row?.id, body.override.override_id)
    assert.equal(verified.row?.confirmation_text_sha256, CONFIRM_SHA)
    assert.equal(verified.row?.actor_id, HR_ACTOR)
    assert.ok(verified.event !== undefined, '审计事件必须真写进 event_inbox')
    assert.equal(verified.event.normalizer_version, 'schema/0001')
    const payload = verified.event.payload as Record<string, unknown>
    assert.equal(payload.application_id, applicationId)
    assert.equal(payload.criterion_key, 'work_exists')
    assert.equal(payload.confirmation_text_sha256, CONFIRM_SHA)
    assert.equal(payload.actor_id, HR_ACTOR)
    const after = await tableCounts()
    assert.equal(after.overrides - before.overrides, 1)
    assert.equal(after.events - before.events, 1)
    await h.close()
  })

  test('幂等重复纠偏 → inserted=false 且不写第二条审计事件', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const result = await call(h, { session: SESSION, body: validBody() })
    assert.equal(result.status, 200, result.text)
    assert.equal((result.body.override as { inserted: boolean }).inserted, false)
    assert.equal((result.body.audit as { event_recorded: boolean }).event_recorded, false)
    await assertSameCounts(before)
    await h.close()
  })

  test('缺原话 confirmation_text → 400 MISSING_REQUIRED（零写入）', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const body = validBody()
    delete body.confirmation_text
    const result = await call(h, { session: SESSION, body })
    assert.equal(result.status, 400, result.text)
    assert.equal(errorReason(result.body), 'MISSING_REQUIRED')
    await assertSameCounts(before)
    await h.close()
  })

  test('非 rubric 维度 → 400 CRITERION_NOT_IN_RUBRIC（零写入）', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const result = await call(h, { session: SESSION, body: validBody({ criterion_key: 'not_in_rubric' }) })
    assert.equal(result.status, 400, result.text)
    assert.equal(errorReason(result.body), 'CRITERION_NOT_IN_RUBRIC')
    await assertSameCounts(before)
    await h.close()
  })

  test('伪造服务端派生 hash → 400 SERVER_DERIVED_REJECTED（零写入）', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const result = await call(h, {
      session: SESSION,
      body: validBody({ confirmation_text_sha256: '0'.repeat(64) }),
    })
    assert.equal(result.status, 400, result.text)
    assert.equal(errorReason(result.body), 'SERVER_DERIVED_REJECTED')
    await assertSameCounts(before)
    await h.close()
  })

  test('未绑定 session → 409 DEMO_ACTOR_UNMAPPED（零写入）', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const result = await call(h, {
      session: 'session-ffffffff-ffff-4fff-8fff-ffffffffffff',
      body: validBody(),
    })
    assert.equal(result.status, 409, result.text)
    const error = result.body.error as Record<string, unknown>
    assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
    assert.equal(error.reason_code, 'SESSION_NOT_BOUND')
    await assertSameCounts(before)
    await h.close()
  })

  test('非 recruiter alias → 403 ACTOR_NOT_AUTHORIZED（零写入）', async () => {
    const identity = createDemoActorIdentity().identity
    identity.registry.bind(OTHER_SESSION, 'interviewer_a', { display_name: '面试官 A' })
    const h = await startHttp(identity)
    const before = await tableCounts()
    const result = await call(h, { session: OTHER_SESSION, body: validBody() })
    assert.equal(result.status, 403, result.text)
    assert.equal(errorReason(result.body), 'ACTOR_NOT_AUTHORIZED')
    await assertSameCounts(before)
    await h.close()
  })

  test('同源闸门：缺 x-recruitment-request → 403 SAME_ORIGIN_REQUIRED（零写入）', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const result = await call(h, { session: SESSION, body: validBody(), requestHeader: null })
    assert.equal(result.status, 403, result.text)
    assert.equal(errorReason(result.body), 'SAME_ORIGIN_REQUIRED')
    await assertSameCounts(before)
    await h.close()
  })

  test('身份覆盖键（query/header/body）→ 400 ACTOR_OVERRIDE_REJECTED（零写入）', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const cases: CallOptions[] = [
      { path: `${CRITERION_OVERRIDE_CONTRACT.path}?actor_id=${HR_ACTOR}` },
      { extraHeaders: { 'x-recruitment-actor': HR_ACTOR } },
      { body: validBody({ tenant_id: TENANT }) },
    ]
    for (const extra of cases) {
      const result = await call(h, { session: SESSION, body: validBody(), ...extra })
      assert.equal(result.status, 400, result.text)
      assert.equal(errorReason(result.body), 'ACTOR_OVERRIDE_REJECTED')
    }
    await assertSameCounts(before)
    await h.close()
  })

  test('未知 body 键 / 非法 human_state → 400（零写入）', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const unknownKey = await call(h, { session: SESSION, body: validBody({ surprise: 1 }) })
    assert.equal(unknownKey.status, 400, unknownKey.text)
    assert.equal(errorReason(unknownKey.body), 'UNKNOWN_PARAM')
    const badState = await call(h, { session: SESSION, body: validBody({ human_state: 'MAYBE' }) })
    assert.equal(badState.status, 400, badState.text)
    assert.equal(errorReason(badState.body), 'INVALID_HUMAN_STATE')
    await assertSameCounts(before)
    await h.close()
  })

  test('exact path / 方法映射：GET → 405 allow:POST；其它路径 → 404', async () => {
    const h = await startHttp(boundIdentity())
    const before = await tableCounts()
    const get = await call(h, { session: SESSION, method: 'GET' })
    assert.equal(get.status, 405, get.text)
    const other = await call(h, { session: SESSION, path: '/recruitment/api/action/criterion/override/extra' })
    assert.equal(other.status, 404, other.text)
    await assertSameCounts(before)
    await h.close()
  })
})
