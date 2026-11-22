// G-09 自助预约真库集成测试（一次性库 0001→0024 全量重放，结束 drop；不碰 ra_s6s7）。
//
// 覆盖：
//   ① HR 生成邀约的回环/同源/session/Recruiter HUMAN 闸门 + token/URL 形状 + DB 落行；
//   ② 公开 HTML/JSON 零 UUID、零简历/评估文本，暖纸单列与 HTML 转义；伪造 token 404；过期 410；
//   ③ 确认 happy path：单事务创建真实 interview + 邀约 OPEN→CONSUMED + 行数 +1；
//   ④ 重复确认 409 零写入；非白名单 slot 400 零写入；过期/伪造 404/410 零写入；
//   ⑤ 冲突（既有 interview 占用面试官时段）→ 409 且全事务回滚（邀约仍 OPEN、行数不变）。
import test, { before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  createIsolatedTestDatabase,
  seedScenario,
  TENANT,
  HR_ACTOR,
  type IsolatedTestDatabase,
} from './db.ts'
import {
  registerBookingInviteHttp,
  renderBookingHtml,
} from '../../src/http/booking-invite.ts'
import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { withActor, withReadOnly, type ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import { scheduleInTransaction } from '../../src/tools/interview-schedule.ts'

const HR_SESSION = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const IO_SESSION = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
const INTERVIEWER_B = '11111111-1111-4111-8111-000000000102'
const INVITE_PATH = '/recruitment/api/action/booking/invite'

// 远期随机基准，避免与任何已有面试撞时段（与 interview-schedule.test.ts 同口径）。
const SLOT_BASE_MS = Date.parse('2031-06-01T10:00:00+08:00') + Math.floor(Math.random() * 300 * 24 * 60) * 60_000
const slotAt = (minutes: number): string => new Date(SLOT_BASE_MS + minutes * 60_000).toISOString()
const SLOTS = [
  { start: slotAt(0), end: slotAt(45) },
  { start: slotAt(120), end: slotAt(165) },
  { start: slotAt(240), end: slotAt(285) },
]
/** 每个用例独立的时段，避免并发/顺序执行时互相触发面试官冲突。 */
const shiftedSlots = (offsetMinutes: number) => [
  { start: slotAt(offsetMinutes), end: slotAt(offsetMinutes + 45) },
  { start: slotAt(offsetMinutes + 120), end: slotAt(offsetMinutes + 165) },
  { start: slotAt(offsetMinutes + 240), end: slotAt(offsetMinutes + 285) },
]

let db: IsolatedTestDatabase
let applicationId: string
let dbCfg: ResolvedDatabaseConfig

const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]

before(async () => {
  db = await createIsolatedTestDatabase('booking_invite_http')
  const client = await db.pool.connect()
  try {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    applicationId = scenario.applicationId
  } finally {
    client.release()
  }
  dbCfg = {
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
  }
})

after(async () => {
  if (db !== undefined) await db.drop()
})

interface Harness {
  readonly baseUrl: string
  readonly port: number
  readonly identity: DemoActorIdentity
  close(): Promise<void>
}

async function startHttp(): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] = []
  const identity = createDemoActorIdentity().identity
  identity.registry.bind(HR_SESSION, 'recruiter', { display_name: '招聘负责人' })
  identity.registry.bind(IO_SESSION, 'interviewer_a', { display_name: '面试官 A' })
  // 先起一个空 server 拿端口，再用该端口注册路由（sameOrigin 依赖监听端口）。
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    let handler = routes.get(pathname)
    if (handler === undefined) {
      handler = registered
        .filter((r) => r.kind === 'prefix' && (pathname === r.path || pathname.startsWith(`${r.path}/`)))
        .sort((a, b) => b.path.length - a.path.length)[0]?.handler
    }
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    const active = handler
    Promise.resolve().then(() => active(req, res)).catch(() => res.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  registerBookingInviteHttp(
    {
      webServer: {
        host: '127.0.0.1',
        port,
        register(route) {
          registered.push(route)
          if (route.kind === 'exact') routes.set(route.path, route.handler)
          return () => { /* noop */ }
        },
      },
    },
    { database: dbCfg, databaseIssues: [], identity },
  )
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    identity,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

interface CallResult {
  readonly status: number
  readonly text: string
  readonly json: Record<string, unknown>
}

async function call(h: Harness, opts: {
  method: string
  path: string
  session?: string | null
  body?: unknown
  requestHeader?: string | null
  origin?: string
}): Promise<CallResult> {
  const headers: Record<string, string> = {}
  const requestHeader = opts.requestHeader === undefined ? '1' : opts.requestHeader
  if (requestHeader !== null) headers['x-recruitment-request'] = requestHeader
  if (opts.session !== undefined && opts.session !== null) headers['x-dsh-session'] = opts.session
  if (opts.origin !== undefined) headers.origin = opts.origin
  let payload: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(opts.body)
  }
  const response = await fetch(`${h.baseUrl}${opts.path}`, {
    method: opts.method, headers, body: payload,
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* html */ }
  return { status: response.status, text, json: parsed }
}

function inviteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    application_id: applicationId,
    round_no: 3,
    duration_minutes: 45,
    interviewer_actor_ids: [INTERVIEWER_A, INTERVIEWER_B],
    timezone: 'Asia/Shanghai',
    slots: SLOTS,
    ...overrides,
  }
}

async function createInvite(h: Harness, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await call(h, {
    method: 'POST', path: INVITE_PATH, session: HR_SESSION, body: inviteBody(overrides),
  })
  assert.equal(response.status, 200, JSON.stringify(response.json))
  return response.json
}

async function countRows(sql: string, params: readonly unknown[] = []): Promise<number> {
  return await withReadOnly(db.pool, async (client) => {
    const { rows } = await client.query<{ n: number }>(sql, [...params])
    return rows[0]?.n ?? -1
  })
}

describe('G-09 · 生成邀约的闸门', () => {
  test('合法 HR 生成 200 + token/URL/72h；伪造 session / 非 Recruiter / 无同源头 / 身份覆盖全拒绝', async () => {
    const h = await startHttp()
    try {
      const ok = await createInvite(h)
      assert.match(String(ok.token), /^[A-Za-z0-9_-]{43}$/)
      assert.equal(ok.booking_url, `/recruitment/book/${String(ok.token)}`)
      assert.match(String(ok.expires_at), /^\d{4}-\d{2}-\d{2}T/)
      assert.equal((ok.slots as unknown[]).length, 3)
      assert.equal(await countRows('select count(*)::int as n from recruitment.booking_invite where application_id = $1', [applicationId]), 1)

      const noSession = await call(h, { method: 'POST', path: INVITE_PATH, body: inviteBody() })
      assert.equal(noSession.status, 400)
      const wrongAlias = await call(h, { method: 'POST', path: INVITE_PATH, session: IO_SESSION, body: inviteBody() })
      assert.equal(wrongAlias.status, 403)
      const noSameOrigin = await call(h, {
        method: 'POST', path: INVITE_PATH, session: HR_SESSION, requestHeader: null, body: inviteBody(),
      })
      assert.equal(noSameOrigin.status, 403)
      const override = await call(h, {
        method: 'POST', path: INVITE_PATH, session: HR_SESSION, body: inviteBody({ actor_id: HR_ACTOR }),
      })
      assert.equal(override.status, 400)
      // 所有失败路径零写入。
      assert.equal(await countRows('select count(*)::int as n from recruitment.booking_invite where application_id = $1', [applicationId]), 1)
    } finally {
      await h.close()
    }
  })
})

describe('G-09 · 公开页零敏感信息', () => {
  test('HTML/JSON 只有允许字段；零 UUID、零简历/评估、XSS 转义；伪造 404、过期 410', async () => {
    const h = await startHttp()
    try {
      const invite = await createInvite(h)
      const token = String(invite.token)
      const json = await call(h, { method: 'GET', path: `/recruitment/api/public/book/${token}` })
      assert.equal(json.status, 200)
      assert.deepEqual(Object.keys(json.json).sort(),
        ['duration_minutes', 'job_title', 'round_no', 'slots', 'status', 'timezone'])
      assert.equal(json.json.status, 'OPEN')
      assert.ok(!json.text.includes(applicationId))
      assert.ok(!json.text.includes(token))
      assert.ok(!json.text.includes('简历'))
      assert.ok(!json.text.includes('评估'))

      const page = await call(h, { method: 'GET', path: `/recruitment/book/${token}` })
      assert.equal(page.status, 200)
      assert.match(page.text, /#F9F8F5/)
      assert.match(page.text, /max-width:520px/)
      assert.match(page.text, /集成测试岗位/)
      assert.match(page.text, /确认此时段/)
      assert.ok(!page.text.includes(applicationId))
      assert.ok(!page.text.includes('aaaaaaaa-aaaa'))
      assert.ok(!page.text.includes('简历'))
      assert.ok(!page.text.includes('评估'))

      const forged = await call(h, { method: 'GET', path: `/recruitment/api/public/book/${'Z'.repeat(43)}` })
      assert.equal(forged.status, 404)
      const forgedPage = await call(h, { method: 'GET', path: `/recruitment/book/${'Z'.repeat(43)}` })
      assert.equal(forgedPage.status, 404)
      assert.match(forgedPage.text, /已失效/)

      await withActor(db.pool, HR_ACTOR, async (client) => {
        await client.query(
          `update recruitment.booking_invite set expires_at = now() - interval '1 hour'
            where id = $1 and tenant_id = $2`,
          [invite.invite_id, TENANT],
        )
      })
      const expired = await call(h, { method: 'GET', path: `/recruitment/api/public/book/${token}` })
      assert.equal(expired.status, 410)
    } finally {
      await h.close()
    }
  })

  test('岗位标题中的 HTML 标签被转义（公开页 XSS 负例）', () => {
    // 域层单测已覆盖 escapeHtml/renderBookingHtml；此处断言 HTTP 公开页同源渲染路径不含注入脚本。
    // 若数据库里出现含标签的标题，页面必须转义而不是原样输出。
    const page = renderBookingHtml({
      status: 'OPEN', job_title: '<script>alert(1)</script>', round_no: 1,
      duration_minutes: 45, timezone: 'Asia/Shanghai', slots: [],
    }, 'A'.repeat(43))
    assert.ok(!page.includes('<script>alert'))
    assert.ok(page.includes('&lt;script&gt;'))
  })
})

describe('G-09 · 确认与原子性', () => {
  test('happy path：真实 interview +1、invite CONSUMED、self_booked 标记与 HR actor 归属', async () => {
    const h = await startHttp()
    try {
      const invite = await createInvite(h)
      const token = String(invite.token)
      const before = await countRows('select count(*)::int as n from recruitment.interview')
      const result = await call(h, {
        method: 'POST', path: `/recruitment/api/public/book/${token}/confirm`,
        body: { slot_index: 1 },
      })
      assert.equal(result.status, 200, JSON.stringify(result.json))
      assert.equal(result.json.status, 'CONFIRMED')
      assert.equal(await countRows('select count(*)::int as n from recruitment.interview'), before + 1)
      const row = await withReadOnly(db.pool, async (client) => {
        const { rows } = await client.query<Record<string, unknown>>(
          `select booking_state, confirmed_slot_index, self_booked,
                  created_by_actor_id::text as creator, confirmed_interview_id::text as iid
             from recruitment.booking_invite where id = $1 and tenant_id = $2`,
          [invite.invite_id, TENANT],
        )
        return rows[0] ?? {}
      })
      assert.equal(row.booking_state, 'CONSUMED')
      assert.equal(row.confirmed_slot_index, 1)
      assert.equal(row.self_booked, true)
      assert.equal(row.creator, HR_ACTOR)
      const interview = await withReadOnly(db.pool, async (client) => {
        const { rows } = await client.query<Record<string, unknown>>(
          `select id::text as id, application_id::text as app, status_changed_by_actor_id::text as actor,
                  scheduled_start_at, round_no
             from recruitment.interview where id = $1 and tenant_id = $2`,
          [row.iid, TENANT],
        )
        return rows[0] ?? {}
      })
      assert.equal(interview.app, applicationId)
      assert.equal(interview.actor, HR_ACTOR)
      assert.equal(interview.round_no, 3)
      assert.equal(Date.parse(String(interview.scheduled_start_at)), Date.parse(SLOTS[1]!.start))
      assert.equal((result.json.confirmed_slot as Record<string, unknown>).start, SLOTS[1]!.start)
    } finally {
      await h.close()
    }
  })

  test('重复确认 409 且 interview/invite 零额外写入', async () => {
    const h = await startHttp()
    try {
      const invite = await createInvite(h, { round_no: 4, slots: shiftedSlots(10_000) })
      const token = String(invite.token)
      const first = await call(h, {
        method: 'POST', path: `/recruitment/api/public/book/${token}/confirm`, body: { slot_index: 0 },
      })
      assert.equal(first.status, 200)
      const before = await countRows('select count(*)::int as n from recruitment.interview')
      const again = await call(h, {
        method: 'POST', path: `/recruitment/api/public/book/${token}/confirm`, body: { slot_index: 0 },
      })
      assert.equal(again.status, 409)
      assert.equal(again.json.error && (again.json.error as Record<string, unknown>).code, 'BOOKING_ALREADY_CONFIRMED')
      assert.equal(await countRows('select count(*)::int as n from recruitment.interview'), before)
    } finally {
      await h.close()
    }
  })

  test('非白名单 slot 400 SLOT_NOT_ALLOWED 零写入', async () => {
    const h = await startHttp()
    try {
      const invite = await createInvite(h, { round_no: 5, slots: shiftedSlots(20_000).slice(0, 2) })
      const token = String(invite.token)
      const before = await countRows('select count(*)::int as n from recruitment.interview')
      const tampered = await call(h, {
        method: 'POST', path: `/recruitment/api/public/book/${token}/confirm`, body: { slot_index: 4 },
      })
      assert.equal(tampered.status, 400)
      assert.equal((tampered.json.error as Record<string, unknown>).code, 'SLOT_NOT_ALLOWED')
      assert.equal(await countRows('select count(*)::int as n from recruitment.interview'), before)
      const state = await withReadOnly(db.pool, async (client) => {
        const { rows } = await client.query<{ s: string }>(
          'select booking_state as s from recruitment.booking_invite where id = $1', [invite.invite_id],
        )
        return rows[0]?.s
      })
      assert.equal(state, 'OPEN')
    } finally {
      await h.close()
    }
  })

  test('过期/伪造 token 确认 410/404 零写入', async () => {
    const h = await startHttp()
    try {
      const invite = await createInvite(h, { slots: shiftedSlots(30_000) })
      const token = String(invite.token)
      await withActor(db.pool, HR_ACTOR, async (client) => {
        await client.query(
          `update recruitment.booking_invite set expires_at = now() - interval '1 minute'
            where id = $1 and tenant_id = $2`,
          [invite.invite_id, TENANT],
        )
      })
      const before = await countRows('select count(*)::int as n from recruitment.interview')
      const expired = await call(h, {
        method: 'POST', path: `/recruitment/api/public/book/${token}/confirm`, body: { slot_index: 0 },
      })
      assert.equal(expired.status, 410)
      const forged = await call(h, {
        method: 'POST', path: `/recruitment/api/public/book/${'Z'.repeat(43)}/confirm`, body: { slot_index: 0 },
      })
      assert.equal(forged.status, 404)
      assert.equal(await countRows('select count(*)::int as n from recruitment.interview'), before)
    } finally {
      await h.close()
    }
  })

  test('面试官时段冲突 → 409 且整笔事务回滚：邀约仍 OPEN，行数完全不变', async () => {
    const h = await startHttp()
    try {
      // 先在同一申请的另一轮占用面试官 A 的时段（冲突检测复用既有排期规则）。
      await withActor(db.pool, HR_ACTOR, async (client) => {
        await scheduleInTransaction(client, dbCfg, {
          intent: 'CREATE',
          idempotency_key: `booking-conflict-${Date.now()}`,
          application_id: applicationId,
          round_no: 6,
          scheduled_start_at: shiftedSlots(40_000)[0]!.start,
          duration_minutes: 45,
          interviewers: [{ actor_id: INTERVIEWER_A }],
        }, Date.now(), async () => 'allowed-once')
      })
      const invite = await createInvite(h, { round_no: 6, slots: shiftedSlots(40_000) })
      const token = String(invite.token)
      const beforeInterview = await countRows('select count(*)::int as n from recruitment.interview')
      const beforeInvite = await countRows('select count(*)::int as n from recruitment.booking_invite')
      const conflicting = await call(h, {
        method: 'POST', path: `/recruitment/api/public/book/${token}/confirm`, body: { slot_index: 0 },
      })
      assert.equal(conflicting.status, 409, JSON.stringify(conflicting.json))
      assert.equal(await countRows('select count(*)::int as n from recruitment.interview'), beforeInterview)
      assert.equal(await countRows('select count(*)::int as n from recruitment.booking_invite'), beforeInvite)
      const state = await withReadOnly(db.pool, async (client) => {
        const { rows } = await client.query<{ s: string; iid: string | null }>(
          'select booking_state as s, confirmed_interview_id::text as iid from recruitment.booking_invite where id = $1',
          [invite.invite_id],
        )
        return rows[0] ?? {}
      })
      assert.equal(state.s, 'OPEN')
      assert.equal(state.iid, null)
    } finally {
      await h.close()
    }
  })
})
