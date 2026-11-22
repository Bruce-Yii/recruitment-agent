// Issue #46 / G-15 · 申请追责时间线 HTTP 路由的**无库**单测（真 HTTP + 假 DB/client）。
//
// 覆盖：人话投影、零 UUID / 零完整 sha256 / 零「证据」、sameOrigin + X-DSH-Session 闸门、
// 非法 id / 未知 query / 非 GET / 未配置 fail-closed、零写入（只读事务 + SELECT）、
// 非 /trace 路径原样转交 dedup handler（申请详情与 /duplicates 不被吞）、
// 注册路径不带尾斜杠、非回环不注册、disposer 可注销。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  APPLICATION_TRACE_CONTRACT_VERSION,
  APPLICATION_TRACE_PATH_TEMPLATE,
  APPLICATION_TRACE_REGISTER_PREFIX,
  registerApplicationTraceHttp,
  projectApplicationTrace,
  scrubHumanText,
  type ApplicationTraceHostContext,
  type ApplicationTraceHttpDeps,
  type ApplicationTraceResponse,
} from '../../src/http/application-trace.ts'
import type { TraceResult, TraceRing } from '../../src/domain/trace.ts'
import { createDemoActorIdentity } from '../../src/demo-actor/index.ts'

const SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const APP_UUID = '22222222-2222-4222-8222-222222222222'
const ACTOR_UUID = '11111111-1111-4111-8111-000000000103' // recruiter alias
const SHA = 'a'.repeat(64)
const FAKE_DB = {
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'unit',
  password: 'unit-only', password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: ACTOR_UUID,
  statement_timeout_ms: 15000, connect_timeout_ms: 10000, max: 2,
} as const

const RINGS: TraceRing[] = [
  {
    ring: 'APPLICATION', id: APP_UUID, at: '2026-11-20T10:00:00.000Z',
    state: 'S7/ACTIVE', refs: { current_stage_code: 'S7', lifecycle_status: 'ACTIVE' }, on_chain: true,
  },
  {
    ring: 'EVENT', id: '33333333-3333-4333-8333-333333333333', at: '2026-11-21T09:00:00.000Z',
    actor_id: ACTOR_UUID, state: 'screening.requested', on_chain: true,
  },
  {
    ring: 'TOOL_CALL', id: '44444444-4444-4444-8444-444444444444', at: '2026-11-21T09:05:00.000Z',
    actor_id: ACTOR_UUID, state: 'SUCCEEDED',
    refs: { tool_name: 'screening_evaluate', call_ref: SHA, business_refs: [{ kind: 'APPLICATION', id: APP_UUID }] },
    on_chain: true,
  },
  {
    ring: 'DECISION', id: '55555555-5555-4555-8555-555555555555', at: '2026-11-22T10:15:00.000Z',
    actor_id: ACTOR_UUID, state: 'ADVANCE',
    refs: { decision_scope: 'SCREENING', stage_code: 'S7', application_id: APP_UUID, payload_hash: SHA, version_no: 1 },
    on_chain: true,
  },
]

const TRACE: TraceResult = {
  object: { type: 'APPLICATION', id: APP_UUID },
  correlation_id: '66666666-6666-4666-8666-666666666666',
  legacy_without_correlation: false,
  rings: RINGS,
  counts: { APPLICATION: 1, EVENT: 1, TOOL_CALL: 1, DECISION: 1 },
  integrity: { ok: true, checked_rings: 4, breakpoints: [], gaps: [] },
  redaction: { candidate_text_included: false, payload_included: false, note: 'test' },
}

interface Harness {
  readonly base: string
  readonly port: number
  readonly readCalls: string[]
  readonly delegated: string[]
  readonly registered: Array<{ kind: string; path: string }>
  close(): Promise<void>
}

async function startHarness(options: {
  readonly boundSession?: boolean
  readonly registerOnHost?: string
  readonly unconfigured?: boolean
  readonly trace?: TraceResult
  readonly loaderThrowsNotFound?: boolean
} = {}): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
      ?? [...routes.entries()].filter(([p]) => pathname.startsWith(`${p}/`)).sort((a, b) => b[0].length - a[0].length)[0]?.[1]
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }))
      return
    }
    Promise.resolve().then(() => handler(req, res)).catch(() => res.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const identity = createDemoActorIdentity().identity
  if (options.boundSession !== false) identity.registry.bind(SESSION, 'recruiter')

  const readCalls: string[] = []
  const delegated: string[] = []
  const registered: Array<{ kind: string; path: string }> = []
  const ctx: ApplicationTraceHostContext = {
    webServer: {
      host: options.registerOnHost ?? '127.0.0.1',
      port,
      register(route) {
        registered.push({ kind: route.kind, path: route.path })
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
  }
  const deps: ApplicationTraceHttpDeps = {
    database: options.unconfigured === true ? null : FAKE_DB,
    databaseIssues: ['environment variable RECRUITMENT_DB_PASSWORD is not set'],
    identity,
    runReadOnly: async (fn) => {
      readCalls.push('begin transaction read only')
      const result = await fn({} as never)
      readCalls.push('commit')
      return result
    },
    loadTraceData: async () => {
      readCalls.push('SELECT')
      if (options.loaderThrowsNotFound === true) throw new Error('NOT_FOUND: trace unavailable')
      return options.trace ?? TRACE
    },
    duplicatesHandler: async (req, res) => {
      delegated.push(req.url ?? '/')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ marker: 'dedup-handler', contract_version: 'candidate-dedup 1.0.0' }))
    },
  }
  registerApplicationTraceHttp(ctx, deps)
  return {
    base: `http://127.0.0.1:${port}`, port, readCalls, delegated, registered,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

async function call(
  h: Harness,
  path: string,
  options: { session?: string | null; method?: string; requestHeader?: string | null; origin?: string | null } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { host: `127.0.0.1:${h.port}` }
  if (options.requestHeader !== null) headers['x-recruitment-request'] = options.requestHeader ?? '1'
  if (options.session !== null) headers['x-dsh-session'] = options.session ?? SESSION
  if (options.origin !== undefined && options.origin !== null) headers['origin'] = options.origin
  const response = await fetch(`${h.base}${path}`, { method: options.method ?? 'GET', headers })
  const text = await response.text()
  let body: any = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body, headers: response.headers }
}

const TRACE_PATH = `${APPLICATION_TRACE_REGISTER_PREFIX}/${APP_UUID}/trace`

test('G-15 注册：不带尾斜杠的更长 prefix；非回环零注册；disposer 可注销', async () => {
  const h = await startHarness()
  assert.deepEqual(h.registered, [{ kind: 'prefix', path: '/recruitment/api/recruiting/applications' }])
  assert.equal(APPLICATION_TRACE_PATH_TEMPLATE.endsWith('/:applicationId/trace'), true)
  const ok = await call(h, TRACE_PATH)
  assert.equal(ok.status, 200)
  await h.close()

  for (const host of ['0.0.0.0', 'example.com', '[::]']) {
    const bad = await startHarness({ registerOnHost: host })
    const res = await call(bad, TRACE_PATH)
    assert.equal(res.status, 404)
    await bad.close()
  }
})

test('G-15 人话投影：稳定短 id、人话标题/操作人/摘要、integrity_ok', async () => {
  const h = await startHarness()
  const res = await call(h, TRACE_PATH)
  assert.equal(res.status, 200)
  const body = res.body as ApplicationTraceResponse
  assert.equal(body.contract_version, APPLICATION_TRACE_CONTRACT_VERSION)
  assert.equal(body.application_id, APP_UUID)
  assert.equal(body.integrity_ok, true)
  assert.deepEqual(body.items.map((item) => item.id), ['T1', 'T2', 'T3', 'T4'])
  assert.equal(body.items[3].title, '初筛通过')
  assert.equal(body.items[3].actor_label, '招聘负责人')
  assert.match(body.items[3].detail, /阶段 S7/)
  assert.match(body.items[3].detail, /版本 1/)
  assert.equal(body.items[0].at, '2026-11-20T10:00:00.000Z')
  await h.close()
})

test('G-15 零 UUID / 零完整 sha256 / 零「证据」：只查人话字段', async () => {
  const projected = projectApplicationTrace(TRACE, createDemoActorIdentity().identity)
  const human = JSON.stringify(projected.items)
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  assert.equal(uuidRe.test(human), false, human)
  assert.equal(human.includes(SHA), false)
  assert.equal(new RegExp(`\\b[0-9a-f]{64}\\b`, 'i').test(human), false)
  assert.equal(human.includes('证据'), false)
  assert.equal(scrubHumanText(`${APP_UUID} ${SHA} 证据`).includes('证据'), false)
  const h = await startHarness()
  const res = await call(h, TRACE_PATH)
  assert.equal(uuidRe.test(JSON.stringify(res.body.items)), false)
  await h.close()
})

test('G-15 零写入：每请求恰好一次只读事务 + 一次只读 SELECT', async () => {
  const h = await startHarness()
  const res = await call(h, TRACE_PATH)
  assert.equal(res.status, 200)
  assert.deepEqual(h.readCalls, ['begin transaction read only', 'SELECT', 'commit'])
  assert.ok(h.readCalls.every((s) => !/insert|update|delete|merge/i.test(s)))
  await h.close()
})

test('G-15 同源/session 闸门：403/400/409 均零读库', async () => {
  const h = await startHarness()
  const noHeader = await call(h, TRACE_PATH, { requestHeader: null })
  assert.equal(noHeader.status, 403)
  assert.equal(noHeader.body.error.reason_code, 'SAME_ORIGIN_REQUIRED')
  const badOrigin = await call(h, TRACE_PATH, { origin: 'http://evil.example' })
  assert.equal(badOrigin.status, 403)
  await h.close()

  const h2 = await startHarness()
  const noSession = await call(h2, TRACE_PATH, { session: null })
  assert.equal(noSession.status, 400)
  assert.equal(noSession.body.error.reason_code, 'SESSION_REQUIRED')
  assert.deepEqual(h2.readCalls, [])
  const badSession = await call(h2, TRACE_PATH, { session: 'not-a-session' })
  assert.equal(badSession.status, 400)
  const unbound = await startHarness({ boundSession: false })
  const unboundRes = await call(unbound, TRACE_PATH)
  assert.equal(unboundRes.status, 409)
  assert.equal(unboundRes.body.error.code, 'DEMO_ACTOR_UNMAPPED')
  assert.deepEqual(unbound.readCalls, [])
  await unbound.close()
  await h2.close()
})

test('G-15 非法 id / 未知 query / 非 GET / 未配置 fail-closed（零读库）', async () => {
  const h = await startHarness()
  for (const path of [
    `${APPLICATION_TRACE_REGISTER_PREFIX}/%20/trace`,
    `${APPLICATION_TRACE_REGISTER_PREFIX}/a%2Fb/trace`,
    `${APPLICATION_TRACE_REGISTER_PREFIX}/a%20b/trace`,
  ]) {
    const res = await call(h, path)
    assert.ok(res.status === 400 || res.status === 404, `${path} → ${res.status}`)
    if (res.status === 400) assert.equal(res.body.error.reason_code, 'ID_INVALID')
  }
  const unknown = await call(h, `${TRACE_PATH}?tenant_id=evil`)
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error.reason_code, 'ACTOR_OVERRIDE_REJECTED')
  const unknownKey = await call(h, `${TRACE_PATH}?foo=1`)
  assert.equal(unknownKey.status, 400)
  assert.equal(unknownKey.body.error.reason_code, 'UNKNOWN_PARAM')
  const wrongMethod = await call(h, TRACE_PATH, { method: 'POST' })
  assert.equal(wrongMethod.status, 400)
  assert.equal(wrongMethod.body.error.reason_code, 'METHOD_NOT_ALLOWED')
  const notFound = await startHarness({ loaderThrowsNotFound: true })
  const nf = await call(notFound, TRACE_PATH)
  assert.equal(nf.status, 404)
  assert.equal(nf.body.error.code, 'NOT_FOUND')
  await notFound.close()
  await h.close()

  const unconfigured = await startHarness({ unconfigured: true })
  const res = await call(unconfigured, TRACE_PATH)
  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'NOT_CONFIGURED')
  assert.deepEqual(unconfigured.readCalls, [])
  await unconfigured.close()
})

test('G-15 非 /trace 路径不吞：普通详情与 /duplicates 原样转交 dedup handler', async () => {
  const h = await startHarness()
  const detail = await call(h, `${APPLICATION_TRACE_REGISTER_PREFIX}/${APP_UUID}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.marker, 'dedup-handler')
  const duplicates = await call(h, `${APPLICATION_TRACE_REGISTER_PREFIX}/${APP_UUID}/duplicates`)
  assert.equal(duplicates.status, 200)
  assert.equal(duplicates.body.contract_version, 'candidate-dedup 1.0.0')
  assert.deepEqual(h.delegated, [
    `/recruitment/api/recruiting/applications/${APP_UUID}`,
    `/recruitment/api/recruiting/applications/${APP_UUID}/duplicates`,
  ])
  assert.deepEqual(h.readCalls, []) // 转交路径不触发 trace 查询
  await h.close()
})
