// owner-star-progress 单测（纯函数 + 真 HTTP 闸门，不依赖数据库）：
//   A5 · progressOf 只在 done/total 都可靠时给值，否则 null（不编数字）；
//   A3 · registerStarHttp 的 fail-closed 闸门（非回环零注册 / sameOrigin / 未绑定 / 越权 /
//        身份覆盖键 / 非法 body）——全部在碰 DB 之前拒绝，因此用 database:null 即可验证零写入。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { progressOf } from '../../src/http/display-tasks.ts'
import { registerStarHttp, type StarHostContext } from '../../src/http/star.ts'
import { createDemoActorIdentity, DEMO_SESSION_HEADER } from '../../src/demo-actor/index.ts'

// ---------------------------------------------------------------------------
//  A5 · 任务进度投影
// ---------------------------------------------------------------------------

test('progressOf: 结构化 PROGRESS ref 给出 done/total', () => {
  assert.deepEqual(progressOf([{ kind: 'PROGRESS', done: 3, total: 10 }]), { done: 3, total: 10 })
  // kind 大小写不敏感（与 applicationIdOf 同口径）。
  assert.deepEqual(progressOf([{ kind: 'progress', done: 0, total: 8 }]), { done: 0, total: 8 })
})

test('progressOf: 没有可靠来源一律 null（不编数字）', () => {
  const nullCases: unknown[] = [
    null,
    undefined,
    'x',
    {},
    [],
    // 只有其它 ref（APPLICATION 等）——没有进度信息。
    [{ kind: 'APPLICATION', id: '11111111-1111-4111-8111-000000000701' }],
    // 缺 done 或 total。
    [{ kind: 'PROGRESS', done: 3 }],
    [{ kind: 'PROGRESS', total: 10 }],
    // total 非法（0 / 负数 / 非整数 / 非数字）。
    [{ kind: 'PROGRESS', done: 0, total: 0 }],
    [{ kind: 'PROGRESS', done: 0, total: -1 }],
    [{ kind: 'PROGRESS', done: 0, total: 1.5 }],
    [{ kind: 'PROGRESS', done: 0, total: '10' }],
    // done 非法（负数 / 超过 total / 非整数 / 非数字）。
    [{ kind: 'PROGRESS', done: -1, total: 10 }],
    [{ kind: 'PROGRESS', done: 11, total: 10 }],
    [{ kind: 'PROGRESS', done: 1.5, total: 10 }],
    [{ kind: 'PROGRESS', done: '3', total: 10 }],
  ]
  for (const refs of nullCases) {
    assert.equal(progressOf(refs), null, `expected null for ${JSON.stringify(refs)}`)
  }
})

// ---------------------------------------------------------------------------
//  A3 · 星标写路由闸门（真 HTTP，database:null ⇒ 任何到达 DB 的请求都会 503）
// ---------------------------------------------------------------------------

interface RouteHarness {
  readonly ctx: StarHostContext
  readonly deps: { database: null; databaseIssues: readonly string[]; identity: ReturnType<typeof createDemoActorIdentity>['identity'] }
  readonly server: Server
  readonly port: number
  readonly routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>
  close(): Promise<void>
}

function registerHandlers(
  routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>,
  host: string,
  db: null,
  identity: ReturnType<typeof createDemoActorIdentity>['identity'],
): void {
  const ctx: StarHostContext = {
    webServer: {
      host,
      port: undefined,
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
  }
  registerStarHttp(ctx, { database: db, databaseIssues: ['RECRUITMENT_DB_PASSWORD'], identity })
}

async function startHarness(host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1'): Promise<RouteHarness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const { identity } = createDemoActorIdentity()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handler = routes.get(url.pathname)
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  // 注册时把 port 告诉路由：用真实端口作为 sameOrigin 的判据。
  const ctx: StarHostContext = {
    webServer: {
      host,
      port,
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
  }
  registerStarHttp(ctx, { database: null, databaseIssues: ['RECRUITMENT_DB_PASSWORD'], identity })
  return {
    ctx,
    deps: { database: null, databaseIssues: ['RECRUITMENT_DB_PASSWORD'], identity },
    server,
    port,
    routes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function postBody(h: RouteHarness, body: object, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${h.port}/recruitment/api/action/application/star`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-recruitment-request': '1',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

test('registerStarHttp: 非回环 host 零注册（fail-closed）', async () => {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const { identity } = createDemoActorIdentity()
  registerHandlers(routes, '0.0.0.0', null, identity)
  assert.equal(routes.size, 0)
})

test('registerStarHttp: 回环 host 只注册一条 exact 路由', async () => {
  const h = await startHarness()
  try {
    assert.deepEqual([...h.routes.keys()], ['/recruitment/api/action/application/star'])
  } finally {
    await h.close()
  }
})

test('star 闸门: 缺 session → 400；未绑定 session → 409 DEMO_ACTOR_UNMAPPED', async () => {
  const h = await startHarness()
  try {
    const body = { application_id: '11111111-1111-4111-8111-000000000701', starred: true, confirmation_text: '主推' }
    const missing = await postBody(h, body)
    assert.equal(missing.status, 400)
    assert.equal((await missing.json() as { error: { reason_code: string } }).error.reason_code, 'SESSION_REQUIRED')

    const unbound = await postBody(h, body, { [DEMO_SESSION_HEADER]: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    assert.equal(unbound.status, 409)
    assert.equal((await unbound.json() as { error: { code: string } }).error.code, 'DEMO_ACTOR_UNMAPPED')
  } finally {
    await h.close()
  }
})

test('star 闸门: 越权 alias（interviewer_a）→ 403 FORBIDDEN', async () => {
  const h = await startHarness()
  try {
    h.deps.identity.registry.bind('session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'interviewer_a')
    const res = await postBody(
      h,
      { application_id: '11111111-1111-4111-8111-000000000701', starred: true, confirmation_text: '主推' },
      { [DEMO_SESSION_HEADER]: 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    )
    assert.equal(res.status, 403)
    const parsed = await res.json() as { error: { code: string; reason_code: string } }
    assert.equal(parsed.error.code, 'FORBIDDEN')
    assert.equal(parsed.error.reason_code, 'ACTOR_NOT_AUTHORIZED')
  } finally {
    await h.close()
  }
})

test('star 闸门: 身份覆盖键（body/header/query）→ 400 ACTOR_OVERRIDE_REJECTED', async () => {
  const h = await startHarness()
  try {
    h.deps.identity.registry.bind('session-cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'recruiter')
    const session = { [DEMO_SESSION_HEADER]: 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
    const base = { application_id: '11111111-1111-4111-8111-000000000701', starred: true, confirmation_text: '主推' }

    const bodyOverride = await postBody(h, { ...base, actor_id: '11111111-1111-4111-8111-000000000104' }, session)
    assert.equal(bodyOverride.status, 400)
    assert.equal((await bodyOverride.json() as { error: { reason_code: string } }).error.reason_code, 'ACTOR_OVERRIDE_REJECTED')

    const hashOverride = await postBody(h, { ...base, confirmation_text_sha256: 'a'.repeat(64) }, session)
    assert.equal(hashOverride.status, 400)
    assert.equal((await hashOverride.json() as { error: { reason_code: string } }).error.reason_code, 'ACTOR_OVERRIDE_REJECTED')

    const headerOverride = await postBody(h, base, { ...session, 'x-recruitment-tenant': '11111111-1111-4111-8111-000000000001' })
    assert.equal(headerOverride.status, 400)
    assert.equal((await headerOverride.json() as { error: { reason_code: string } }).error.reason_code, 'ACTOR_OVERRIDE_REJECTED')

    const queryOverride = await fetch(
      `http://127.0.0.1:${h.port}/recruitment/api/action/application/star?tenant_id=11111111-1111-4111-8111-000000000001`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-recruitment-request': '1', ...session },
        body: JSON.stringify(base),
      },
    )
    assert.equal(queryOverride.status, 400)
    assert.equal((await queryOverride.json() as { error: { reason_code: string } }).error.reason_code, 'ACTOR_OVERRIDE_REJECTED')
  } finally {
    await h.close()
  }
})

test('star 闸门: 跳过同源 → 403；合法 recruiter 但库未配置 → 503（不假装成功）', async () => {
  const h = await startHarness()
  try {
    h.deps.identity.registry.bind('session-dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'recruiter')
    const session = { [DEMO_SESSION_HEADER]: 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd' }
    const base = { application_id: '11111111-1111-4111-8111-000000000701', starred: true, confirmation_text: '主推' }

    const crossOrigin = await fetch(`http://127.0.0.1:${h.port}/recruitment/api/action/application/star`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...session }, // 缺 x-recruitment-request
      body: JSON.stringify(base),
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal((await crossOrigin.json() as { error: { reason_code: string } }).error.reason_code, 'SAME_ORIGIN_REQUIRED')

    const okGate = await postBody(h, base, session)
    assert.equal(okGate.status, 503)
    assert.equal((await okGate.json() as { error: { code: string } }).error.code, 'NOT_CONFIGURED')
  } finally {
    await h.close()
  }
})

test('star 闸门: 非法 body（starred 非 bool / 非法 UUID / 缺确认原话）→ 400 零写入', async () => {
  const h = await startHarness()
  try {
    h.deps.identity.registry.bind('session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'recruiter')
    const session = { [DEMO_SESSION_HEADER]: 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }
    const appId = '11111111-1111-4111-8111-000000000701'
    for (const body of [
      { application_id: appId, starred: 'true', confirmation_text: '主推' },
      { application_id: 'not-a-uuid', starred: true, confirmation_text: '主推' },
      { application_id: appId, starred: true },
    ]) {
      const res = await postBody(h, body, session)
      assert.equal(res.status, 400, JSON.stringify(body))
    }
  } finally {
    await h.close()
  }
})
