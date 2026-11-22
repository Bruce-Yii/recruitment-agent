// G-12（Issue #35）人才再发现 HTTP 路由机检：注册形状 + loopback/sameOrigin/session/方法/
// 身份覆盖 fail-closed。成功投影由同文件的假 client 单测与真库集成测试覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REDISCOVERY_ROUTE_PREFIX,
  registerTalentRediscoveryHttp,
  type TalentRediscoveryHostContext,
} from '../../src/http/talent-rediscovery.ts'

const JOB = '11111111-1111-4111-8111-000000000401'
const PATH = `${REDISCOVERY_ROUTE_PREFIX}${JOB}/rediscovery`

interface Captured {
  readonly status: number
  readonly headers: Record<string, unknown>
  readonly json: Record<string, unknown>
}
class FakeResponse {
  status = 0
  headers: Record<string, unknown> = {}
  private chunks: string[] = []
  private settle!: (value: Captured) => void
  readonly done = new Promise<Captured>((resolve) => { this.settle = resolve })
  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status
    this.headers = headers ?? {}
    return this
  }
  end(chunk?: unknown): void {
    if (chunk !== undefined && chunk !== null) this.chunks.push(String(chunk))
    let json: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(this.chunks.join(''))
      json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch { /* 非 JSON 响应留空 */ }
    this.settle({ status: this.status, headers: this.headers, json })
  }
}
class FakeRequest {
  readonly headers: Record<string, string | undefined>
  readonly method: string
  readonly url: string
  constructor(options: { url?: string; method?: string; headers?: Record<string, string | undefined> } = {}) {
    this.url = options.url ?? PATH
    this.method = options.method ?? 'GET'
    this.headers = {
      host: '127.0.0.1:3181',
      'x-recruitment-request': '1',
      'x-dsh-session': `session-11111111-1111-4111-8111-0000000000aa`,
      ...options.headers,
    }
  }
}
function fakeServer(host = '127.0.0.1'): { ctx: TalentRediscoveryHostContext; routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }> } {
  const routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }> = []
  return {
    routes,
    ctx: {
      webServer: {
        host,
        port: 3181,
        register: (route) => {
          routes.push(route as unknown as (typeof routes)[number])
          return () => {}
        },
      },
    },
  }
}
async function send(server: ReturnType<typeof fakeServer>, req: FakeRequest): Promise<Captured> {
  const route = server.routes[0]
  assert.ok(route, '路由未注册')
  const res = new FakeResponse()
  await route.handler(req, res)
  return res.done
}

test('HTTP：非回环 host 不注册；回环注册更长 prefix', () => {
  const nonLoopback = fakeServer('0.0.0.0')
  registerTalentRediscoveryHttp(nonLoopback.ctx, null, [])
  assert.equal(nonLoopback.routes.length, 0)
  const loopback = fakeServer('127.0.0.1')
  registerTalentRediscoveryHttp(loopback.ctx, null, [])
  assert.equal(loopback.routes.length, 1)
  assert.deepEqual(
    { kind: loopback.routes[0]!.kind, path: loopback.routes[0]!.path },
    // 注册 prefix 不能带尾斜杠：宿主匹配条件是 pathname.startsWith(`${prefix}/`)。
    { kind: 'prefix', path: '/recruitment/api/recruiting/jobs' },
  )
})

test('HTTP：同源闸门 + session + 方法 + 身份覆盖 fail-closed', async () => {
  const server = fakeServer()
  registerTalentRediscoveryHttp(server.ctx, null, [])

  const noHeader = await send(server, new FakeRequest({ headers: { 'x-recruitment-request': undefined } }))
  assert.equal(noHeader.status, 403)
  assert.equal((noHeader.json.error as Record<string, unknown>).code, 'FORBIDDEN')

  const badOrigin = await send(server, new FakeRequest({ headers: { origin: 'http://evil.test:3181' } }))
  assert.equal(badOrigin.status, 403)

  const noSession = await send(server, new FakeRequest({ headers: { 'x-dsh-session': undefined } }))
  assert.equal(noSession.status, 400)
  assert.equal((noSession.json.error as Record<string, unknown>).code, 'INVALID_ARGS')

  const badSession = await send(server, new FakeRequest({ headers: { 'x-dsh-session': 'admin' } }))
  assert.equal(badSession.status, 400)

  const post = await send(server, new FakeRequest({ method: 'POST' }))
  assert.equal(post.status, 405)

  for (const key of ['actor_id', 'tenant_id']) {
    const override = await send(server, new FakeRequest({ url: `${PATH}?${key}=11111111-1111-4111-8111-000000000103` }))
    assert.equal(override.status, 400)
    assert.equal((override.json.error as Record<string, unknown>).reason_code, 'ACTOR_OVERRIDE_REJECTED')
  }
})

test('HTTP：数据库未配置 → 503；非法 job 形状 → 404（不连库）', async () => {
  const server = fakeServer()
  registerTalentRediscoveryHttp(server.ctx, null, ['database.host is required'])
  const unconfigured = await send(server, new FakeRequest())
  assert.equal(unconfigured.status, 503)
  assert.equal((unconfigured.json.error as Record<string, unknown>).code, 'NOT_CONFIGURED')

  const badPath = await send(server, new FakeRequest({ url: `${REDISCOVERY_ROUTE_PREFIX}not-a-uuid/rediscovery` }))
  assert.equal(badPath.status, 404)
})

test('HTTP：更长的 jobs prefix 不吞掉既有岗位详情（同口径 503 / 404）', async () => {
  const server = fakeServer()
  registerTalentRediscoveryHttp(server.ctx, null, [])
  // /jobs/:uuid（无 /rediscovery 尾缀）交给 readJobDetail 同一条路径；未配置库仍是 503。
  const detail = await send(server, new FakeRequest({ url: `${REDISCOVERY_ROUTE_PREFIX}${JOB}` }))
  assert.equal(detail.status, 503)
  // 完全不匹配的路径 404，不影响其它路由。
  const unknown = await send(server, new FakeRequest({ url: `${REDISCOVERY_ROUTE_PREFIX}${JOB}/unknown` }))
  assert.equal(unknown.status, 404)
})
