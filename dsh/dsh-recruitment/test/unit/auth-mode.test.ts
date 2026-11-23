// Issue #61：认证模式的纯 HTTP 行为单测（preview 零回归 + production 闸门/404/alias）。
// 这里不连库：闸门在「无 cookie」时就地返回 401/302，不需要 DB。
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { createDemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerAppShell } from '../../src/http/app-shell.ts'
import { installAuthGate, resolveAuthMode } from '../../src/http/auth-gate.ts'

interface Route {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface FakeRes {
  status: number
  headers: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string>): ServerResponse
  setHeader(name: string, value: string): void
  end(body?: string): void
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    status: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = { ...res.headers, ...(headers ?? {}) }
      return res as unknown as ServerResponse
    },
    setHeader(name, value) { res.headers[name.toLowerCase()] = value },
    end(body) { res.body = body ?? '' },
  }
  return res
}

function harness() {
  const routes = new Map<string, Route>()
  const original = {
    host: '127.0.0.1',
    port: 49347,
    register(route: Route) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  }
  const child = { webServer: original }
  return { routes, original, child }
}

async function dispatch(
  routes: Map<string, Route>,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<FakeRes> {
  const pathname = path.split('?')[0] ?? path
  let route = routes.get(pathname)
  if (route === undefined) {
    const prefix = [...routes.values()]
      .filter((r) => r.kind === 'prefix' && (pathname === r.path || pathname.startsWith(`${r.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
    route = prefix
  }
  if (route === undefined) {
    const res = fakeRes()
    res.status = 404
    return res
  }
  const req = {
    method: options.method ?? 'GET',
    url: path,
    headers: { host: '127.0.0.1:49347', ...(options.headers ?? {}) },
  } as unknown as IncomingMessage
  const res = fakeRes()
  await route.handler(req, res as unknown as ServerResponse)
  return res
}

test('resolveAuthMode：只有显式 production 开启，缺省/非法值都是 preview', () => {
  assert.equal(resolveAuthMode('production'), 'production')
  assert.equal(resolveAuthMode('preview'), 'preview')
  assert.equal(resolveAuthMode(undefined), 'preview')
  assert.equal(resolveAuthMode('PRODUCTION'), 'preview')
})

test('preview 模式：闸门 no-op，/recruitment/test 仍绑定身份，previewAlias 仍生效', async () => {
  const h = harness()
  const restore = installAuthGate(h.child, 'preview', null, { database: null, identity: createDemoActorIdentity().identity })
  assert.equal(h.child.webServer, h.original) // preview 不遮蔽 webServer

  const { identity } = createDemoActorIdentity()
  registerAppShell({ webServer: h.child.webServer }, {
    identity,
    previewAlias: 'recruiter',
    authMode: 'preview',
  })
  const res = await dispatch(h.routes, '/recruitment/test?as=interviewer_a')
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, '/recruitment/app')
  const sid = /rc_sid=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1] ?? ''
  assert.notEqual(sid, '')
  assert.equal(identity.registry.get(decodeURIComponent(sid))?.alias, 'interviewer_a')
  restore()
})

test('production 模式：/recruitment/test 404，previewAlias 被忽略，app 未登录 302，API 401', async () => {
  const h = harness()
  const identity = createDemoActorIdentity().identity
  const deps = { database: null, identity }
  const restore = installAuthGate(h.child, 'production', null, deps)
  assert.notEqual(h.child.webServer, h.original) // 生产安装影子层

  registerAppShell({ webServer: h.child.webServer }, {
    identity,
    previewAlias: 'recruiter', // 必须被忽略
    authMode: 'production',
  })
  // 模拟另一个模块在闸门安装后注册 API 路由（真实宿主中由 registerOverviewHttp 完成）。
  h.child.webServer.register({
    kind: 'exact',
    path: '/recruitment/api/recruiting/overview',
    handler(_req, res) { res.writeHead(200); res.end('{"ok":true}') },
  })

  const testPage = await dispatch(h.routes, '/recruitment/test?as=recruiter')
  assert.equal(testPage.status, 404)

  const app = await dispatch(h.routes, '/recruitment/app')
  assert.equal(app.status, 302)
  assert.match(app.headers.location ?? '', /^\/recruitment\/login\?next=/)

  const session = await dispatch(h.routes, '/recruitment/app/session')
  assert.equal(session.status, 401)

  const api = await dispatch(h.routes, '/recruitment/api/recruiting/overview')
  assert.equal(api.status, 401)
  assert.equal(JSON.parse(api.body).error.code, 'UNAUTHENTICATED')

  // 显式身份绑定入口在 production 也被关闭：未登录先被闸门 401；即便登录，app-shell 也返回 404。
  const actor = await dispatch(h.routes, '/recruitment/app/session/actor', { method: 'POST' })
  assert.equal(actor.status, 401)

  restore()
  assert.equal(h.child.webServer, h.original)
})
