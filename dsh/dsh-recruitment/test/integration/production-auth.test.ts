// Issue #61：生产登录的真实库 + 真 HTTP 集成测试。
//
// 纪律（与 demo-actor-http.test.ts 同款）：
//   1. 独占一次性库（重放 0001..0025，含 0025 种子账号）；
//   2. 真 `node:http` 监听 127.0.0.1:0 + 真 `webServer.register` 分发语义；
//   3. 断言只信独立 SQL 读回（token 只存 sha256 / revoked_at 即时生效）；
//   4. 覆盖：坏口令 401、cookie 持久（模拟 Host 重启）、logout 旧 cookie 401、
//      /recruitment/test 404、preview alias 被忽略、两种角色正确路由。

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerAppShell } from '../../src/http/app-shell.ts'
import { installAuthGate } from '../../src/http/auth-gate.ts'
import { registerAuthHttp, type AuthHostContext } from '../../src/http/auth.ts'
import { tokenSha256 } from '../../src/db/auth.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

const BASE = testDatabaseConfig()

interface Route {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface Host {
  readonly server: Server
  readonly port: number
  readonly routes: Map<string, Route>
  readonly identity: DemoActorIdentity
  close(): Promise<void>
}

async function startHost(database: ResolvedDatabaseConfig, identity: DemoActorIdentity, previewAlias?: string): Promise<Host> {
  const routes = new Map<string, Route>()
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const exact = routes.get(path)
    const route = exact ?? [...routes.values()]
      .filter((r) => r.kind === 'prefix' && (path === r.path || path.startsWith(`${r.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"code":"NOT_FOUND"}}')
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const original = {
    host: '127.0.0.1',
    port,
    register(route: Route) { routes.set(route.path, route); return () => { routes.delete(route.path) } },
  }
  const child = { webServer: original }
  installAuthGate(child, 'production', database, { database, identity })
  registerAuthHttp(child as unknown as AuthHostContext, { database, identity })
  registerAppShell(
    { webServer: child.webServer as unknown as { host: string; port: number | undefined; register(r: Route): () => void } },
    { identity, previewAlias, authMode: 'production' },
  )
  // 模拟业务 API 模块（闸门应统一挡住未登录请求）
  child.webServer.register({
    kind: 'exact',
    path: '/recruitment/api/recruiting/overview',
    handler(_req, res) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') },
  })
  return {
    server,
    port,
    routes,
    identity,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

interface CallResult {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

async function call(host: Host, path: string, options: {
  method?: string
  cookie?: string
  body?: unknown
} = {}): Promise<CallResult> {
  const url = `http://127.0.0.1:${host.port}${path}`
  const headers: Record<string, string> = {}
  if (options.cookie) headers.cookie = options.cookie
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  })
  const responseHeaders: Record<string, string | string[]> = Object.fromEntries(res.headers.entries())
  const cookies = res.headers.getSetCookie?.() ?? []
  if (cookies.length > 0) responseHeaders['set-cookie'] = cookies
  return { status: res.status, headers: responseHeaders, body: await res.text() }
}

function cookieFrom(result: CallResult, name: string): string {
  const raw = result.headers['set-cookie'] ?? ''
  const list = Array.isArray(raw) ? raw : String(raw).split(/,(?=\s*rc_)/)
  for (const entry of list) {
    const [pair] = entry.split(';')
    const index = (pair ?? '').indexOf('=')
    if (index < 0) continue
    if ((pair ?? '').slice(0, index).trim() === name) return (pair ?? '').slice(index + 1).trim()
  }
  return ''
}

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig

before(async () => {
  db = await createIsolatedTestDatabase('auth61')
  assertPrivateDatabase(db.name)
  cfg = { ...BASE, database: db.name }
  // 0025 种子必须真的存在（独立 SQL 读回，不依赖迁移脚本自述）。
  const rows = await db.pool.query<{ username: string; password_hash: string }>(
    'select username, password_hash from recruitment.auth_user where tenant_id = $1 order by username',
    [cfg.tenant_id],
  )
  assert.deepEqual(rows.rows.map((r) => r.username), ['interviewer', 'recruiter'])
  for (const row of rows.rows) {
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
  }
})

after(async () => { await db?.drop() })

test('E2E：坏口令 401，正确口令 200 + HttpOnly/SameSite cookie + 只存 token sha256', async () => {
  const host = await startHost(cfg, createDemoActorIdentity().identity)
  try {
    const bad = await call(host, '/recruitment/api/auth/login', {
      method: 'POST',
      body: { username: 'recruiter', password: 'definitely-wrong' },
    })
    assert.equal(bad.status, 401)
    assert.equal(JSON.parse(bad.body).error.reason_code, 'BAD_CREDENTIALS')

    const good = await call(host, '/recruitment/api/auth/login', {
      method: 'POST',
      body: { username: 'recruiter', password: 'Recruiter@2026' },
    })
    assert.equal(good.status, 200)
    const session = JSON.parse(good.body)
    assert.equal(session.alias, 'recruiter')
    assert.match(session.sid, /^session-[0-9a-f-]{36}$/)
    const rawCookies = good.headers['set-cookie']
    const cookieText = Array.isArray(rawCookies) ? rawCookies.join('|') : String(rawCookies ?? '')
    assert.match(cookieText, /rc_auth=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax/)
    const token = cookieFrom(good, 'rc_auth')
    assert.match(token, /^[0-9a-f]{64}$/)

    // 独立 SQL 读回：库里只有 sha256，token 明文不在库里。
    const rows = await db.pool.query<{ token_sha256: string; alias: string; revoked_at: Date | null }>(
      'select token_sha256, alias, revoked_at from recruitment.auth_session where session_id = $1 and tenant_id = $2',
      [session.sid, cfg.tenant_id],
    )
    assert.equal(rows.rows.length, 1)
    assert.equal(rows.rows[0]?.token_sha256, tokenSha256(token))
    assert.equal(rows.rows[0]?.alias, 'recruiter')
    assert.equal(rows.rows[0]?.revoked_at, null)

    const cookie = `rc_auth=${token}; rc_sid=${encodeURIComponent(session.sid)}`
    const authed = await call(host, '/recruitment/app/session', { cookie })
    assert.equal(authed.status, 200)
    assert.equal(JSON.parse(authed.body).alias, 'recruiter')

    const api = await call(host, '/recruitment/api/recruiting/overview', { cookie })
    assert.equal(api.status, 200)
  } finally {
    await host.close()
  }
})

test('E2E：模拟 Host 重启（全新 registry + 新宿主实例）后旧 cookie 刷新仍登录', async () => {
  const first = await startHost(cfg, createDemoActorIdentity().identity)
  let token = ''
  let sid = ''
  try {
    const login = await call(first, '/recruitment/api/auth/login', {
      method: 'POST',
      body: { username: 'interviewer', password: 'Interviewer@2026' },
    })
    assert.equal(login.status, 200)
    token = cookieFrom(login, 'rc_auth')
    sid = JSON.parse(login.body).sid as string
    assert.equal(JSON.parse(login.body).alias, 'interviewer_a')
  } finally {
    await first.close()
  }

  // 全新 identity/registry = Host 重启后的进程内状态；DB 会话仍是权威。
  const restarted = await startHost(cfg, createDemoActorIdentity().identity, 'recruiter' /* 必须被忽略 */)
  try {
    const cookie = `rc_auth=${token}; rc_sid=${encodeURIComponent(sid)}`
    const page = await call(restarted, '/recruitment/app', { cookie })
    assert.equal(page.status, 200)
    const session = await call(restarted, '/recruitment/app/session', { cookie })
    assert.equal(session.status, 200)
    assert.equal(JSON.parse(session.body).alias, 'interviewer_a')
    assert.deepEqual(JSON.parse(session.body).roles, ['INTERVIEWER'])
    const testRoute = await call(restarted, '/recruitment/test?as=recruiter', { cookie, method: 'GET' })
    assert.equal(testRoute.status, 404)
  } finally {
    await restarted.close()
  }
})

test('E2E：logout 撤销会话，旧 cookie 立即 401', async () => {
  const host = await startHost(cfg, createDemoActorIdentity().identity)
  try {
    const login = await call(host, '/recruitment/api/auth/login', {
      method: 'POST',
      body: { username: 'recruiter', password: 'Recruiter@2026' },
    })
    const token = cookieFrom(login, 'rc_auth')
    const sid = JSON.parse(login.body).sid as string
    const cookie = `rc_auth=${token}; rc_sid=${encodeURIComponent(sid)}`

    const logout = await call(host, '/recruitment/api/auth/logout', { method: 'POST', cookie })
    assert.equal(logout.status, 200)
    assert.match(cookieFrom(logout, 'rc_auth'), /^$/)

    const session = await call(host, '/recruitment/app/session', { cookie })
    assert.equal(session.status, 401)
    const api = await call(host, '/recruitment/api/recruiting/overview', { cookie })
    assert.equal(api.status, 401)
    const app = await call(host, '/recruitment/app', { cookie })
    assert.equal(app.status, 302)
    assert.match(app.headers.location ?? '', /^\/recruitment\/login\?next=/)

    const rows = await db.pool.query<{ revoked_at: Date | null }>(
      'select revoked_at from recruitment.auth_session where token_sha256 = $1 and tenant_id = $2',
      [tokenSha256(token), cfg.tenant_id],
    )
    assert.notEqual(rows.rows[0]?.revoked_at, null)
  } finally {
    await host.close()
  }
})

test('E2E：未登录访问 app / API / test 的表现，登录页零 DSH chrome', async () => {
  const host = await startHost(cfg, createDemoActorIdentity().identity)
  try {
    const app = await call(host, '/recruitment/app')
    assert.equal(app.status, 302)
    assert.match(app.headers.location ?? '', /^\/recruitment\/login\?next=/)
    const api = await call(host, '/recruitment/api/recruiting/overview')
    assert.equal(api.status, 401)
    const testRoute = await call(host, '/recruitment/test?as=recruiter')
    assert.equal(testRoute.status, 404)

    const loginPage = await call(host, '/recruitment/login')
    assert.equal(loginPage.status, 200)
    assert.match(loginPage.body, /data-testid="login-page"/)
    assert.doesNotMatch(loginPage.body, /__DSH_BOOT__|recruiting-workspace|sidebar|token=/i)
  } finally {
    await host.close()
  }
})

test('角色不匹配显式 role → 403，不创建会话', async () => {
  const host = await startHost(cfg, createDemoActorIdentity().identity)
  try {
    const before = await db.pool.query<{ n: number }>(
      'select count(*)::int as n from recruitment.auth_session where tenant_id = $1',
      [cfg.tenant_id],
    )
    const res = await call(host, '/recruitment/api/auth/login', {
      method: 'POST',
      body: { username: 'interviewer', password: 'Interviewer@2026', role: 'recruiter' },
    })
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).error.reason_code, 'ROLE_MISMATCH')
    const after = await db.pool.query<{ n: number }>(
      'select count(*)::int as n from recruitment.auth_session where tenant_id = $1',
      [cfg.tenant_id],
    )
    assert.equal(after.rows[0]?.n, before.rows[0]?.n)
  } finally {
    await host.close()
  }
})
