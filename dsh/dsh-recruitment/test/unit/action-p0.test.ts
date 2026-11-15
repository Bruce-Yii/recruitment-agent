// D5 写操作 P0 · `src/http/actions.ts` 的**无真库**单元测试（子代理 A 交付物）。
//
// 覆盖 owner-d5-actions 指定的必测项（a–i 中的 P0 子集）：
//   a. 回环 host 恰好注册 10 条 exact 路由；非回环 host 零注册 + 一条 warn；
//   b. 未绑定 session → 409 DEMO_ACTOR_UNMAPPED/SESSION_NOT_BOUND（在碰 body / DB 之前）；
//   c. 缺 / 非法 `x-dsh-session` → 400 SESSION_REQUIRED / SESSION_ID_INVALID；
//   d. interviewer_a 调写动作 → 403 FORBIDDEN/ACTOR_NOT_AUTHORIZED（零写入，未建连）；
//   e. body 带 actor_id / tenant_id / human_confirmation → 400 ACTOR_OVERRIDE_REJECTED；
//      query / header 覆盖 → 400 同码；
//   f. 缺 `x-recruitment-request: 1` / 跨源 Origin → 403 FORBIDDEN/SAME_ORIGIN_REQUIRED；
//   g. 非 POST → 405 + `allow: POST`；
//   h. `screening/decide` 带 `decision_scope: FINAL` → 400 SCOPE_MISMATCH；
//      `decision/record` 缺 scope → 400 MISSING_REQUIRED；
//   i. `config` 统一入口：缺 entity / 非法 entity / 读 operation 三种 400；
//   另加：数据库未配置（`database: null`）→ 503 NOT_CONFIGURED（不假装成功）。
//
// 纪律（与 `test/integration/demo-actor-http.test.ts` 同形，但不连库）：
//   * 真 `node:http` server 监听 `127.0.0.1:0`；用 `registerActionsHttp` 注册到一个**收集式**
//     假 `webServer.register`（按 exact path 分发）——复刻 DSH 宿主对 `webServer` 的最小契约；
//   * 身份 = 产品真的 `createDemoActorIdentity()` 单例（进程内 registry），只 bind 不读库；
//   * `database` = 不可达的假配置（127.0.0.1:1）或 `null`：**本文件所有被断言的分支都发生在
//     建立任何 DB 连接之前**（身份/alias/同源/覆盖键/参数层），因此不需要 PG、也不会写库；
//   * 断言只看 HTTP 状态 + 封闭错误信封（`{error:{code,reason_code,message,detail?}}`）。
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerActionsHttp, type ActionHttpDeps } from '../../src/http/actions.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'

// ---------------------------------------------------------------------------
//  固定值
// ---------------------------------------------------------------------------

/** `0002_seed` 的演示租户（只用于构造假配置；本文件不连库）。 */
const TENANT = '11111111-1111-4111-8111-000000000001'
/** `recruiter` alias 的默认映射（`demo-actor/alias.ts:37-41`）。 */
const ACTOR_RECRUITER = '11111111-1111-4111-8111-000000000103'
const DEMO_APPLICATION = '11111111-1111-4111-8111-000000000701'

/** 已绑定 recruiter 的 session。 */
const SESSION_RECRUITER = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** 已绑定 interviewer_a 的 session（越权负例）。 */
const SESSION_INTERVIEWER = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
/** 形态合法但**未绑定** alias 的 session。 */
const SESSION_UNBOUND = 'session-ffffffff-ffff-4fff-8fff-ffffffffffff'

/** 10 条 exact 路由（顺序 = `ACTION_PATHS` 的声明顺序；`actions.ts:78-89`）。 */
const EXPECTED_ROUTES: readonly string[] = [
  'exact /recruitment/api/action/screening/decide',
  'exact /recruitment/api/action/decision/record',
  'exact /recruitment/api/action/stage/advance',
  'exact /recruitment/api/action/interview/schedule',
  'exact /recruitment/api/action/transcript/import',
  'exact /recruitment/api/action/job/rubric-approve',
  'exact /recruitment/api/action/config/role',
  'exact /recruitment/api/action/config/team',
  'exact /recruitment/api/action/config/pipeline',
  'exact /recruitment/api/action/config',
]

/**
 * 不可达的库配置：`port: 1` + 不存在的库名。
 * 作用只是让 `requireDatabase()` 通过，使测试能走到它之后**纯内存**的校验分支；
 * 任何真的建连都会立刻失败——如果某个断言意外走到建连，测试会以非预期状态失败（不是假绿）。
 */
const UNREACHABLE_DB: ResolvedDatabaseConfig = {
  host: '127.0.0.1',
  port: 1,
  user: 'nobody',
  database: 'no_such_db_p0_unit',
  password: 'not-a-real-password',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT,
  actor_id: ACTOR_RECRUITER,
  statement_timeout_ms: 1_000,
  connect_timeout_ms: 200,
  max: 1,
}

// ---------------------------------------------------------------------------
//  HTTP harness（真 node:http；假 webServer.register 收集 exact handler）
// ---------------------------------------------------------------------------

interface ActionServer {
  readonly baseUrl: string
  readonly port: number
  readonly registered: readonly { kind: string; path: string }[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

/**
 * 起真 HTTP server → listen(0) 拿到端口 → 把 `{host, port, register}` 交给 `registerActionsHttp`。
 * 顺序是刻意的：`sameOrigin(req, port)` 用的就是 listen 后的真实端口。
 * @param deps - 路由依赖（`database` 可以是 `null` 或不可达配置）。
 * @param host - `webServer.host`（非回环负例用）。
 */
async function startActionServer(
  deps: ActionHttpDeps,
  host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1',
): Promise<ActionServer> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const warnings: string[] = []
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found (exact route)' }))
      return
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        try {
          res.destroy()
        } catch {
          // 连接已坏：忽略（测试失败会从断言侧暴露）。
        }
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  const dispose = registerActionsHttp(
    {
      webServer: {
        host,
        port: address.port,
        register(route) {
          registered.push({ kind: route.kind, path: route.path })
          routes.set(route.path, route.handler)
          return () => {
            routes.delete(route.path)
          }
        },
      },
      logger: {
        warn(message: string) {
          warnings.push(message)
        },
      },
    },
    deps,
  )
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    registered,
    warnings,
    async close(): Promise<void> {
      dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
  readonly headers: Headers
}

interface CallOptions {
  readonly session?: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  readonly contentType?: string
  readonly omitRequestHeader?: boolean
}

/**
 * 发一次同源请求（默认带 `x-recruitment-request: 1`；给了 session 才带 `x-dsh-session`）。
 * @param target - harness。
 * @param method - HTTP 方法。
 * @param path - 含 query 的路径。
 * @param options - session / body / 额外头 / 是否省略同源头。
 */
async function httpCall(
  target: Pick<ActionServer, 'baseUrl'>,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.omitRequestHeader !== true) headers['x-recruitment-request'] = '1'
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = options.contentType ?? 'application/json'
    payload = JSON.stringify(options.body)
  }
  const response = await fetch(`${target.baseUrl}${path}`, { method, headers, body: payload })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body, text, headers: response.headers }
}

/**
 * 用 `node:http` 发一次请求：用于 fetch 不允许设置的 forbidden header（`Origin`）。
 * @param target - harness。
 * @param method - HTTP 方法。
 * @param path - 路径。
 * @param headers - 请求头（大小写不敏感）。
 */
async function rawCall(
  target: Pick<ActionServer, 'baseUrl' | 'port'>,
  method: string,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: target.port, method, path, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** 断言封闭错误信封 `{error:{code,reason_code?,message,detail?}}`。 */
function assertHttpError(result: HttpResult, status: number, code: string, reasonCode?: string): void {
  assert.equal(result.status, status, `HTTP 状态应为 ${status}：${result.text}`)
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `响应必须是 {"error":{...}}：${result.text}`)
  assert.equal(error.code, code, `error.code 应为 ${code}：${result.text}`)
  if (reasonCode !== undefined) {
    assert.equal(error.reason_code, reasonCode, `error.reason_code 应为 ${reasonCode}：${result.text}`)
  }
  assert.equal(typeof error.message, 'string', 'error.message 必须是字符串')
}

/** 取 `error.detail`（没有就失败）。 */
function errorDetail(result: HttpResult): Record<string, unknown> {
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `响应必须是 {"error":{...}}：${result.text}`)
  const detail = error.detail as Record<string, unknown> | undefined
  assert.ok(detail !== undefined, `错误必须带 detail：${result.text}`)
  return detail
}

// ---------------------------------------------------------------------------
//  共享进程内身份：recruiter / interviewer_a 各绑一个 session
// ---------------------------------------------------------------------------

let identity: DemoActorIdentity
let server: ActionServer
let unconfigured: ActionServer

before(async () => {
  const created = createDemoActorIdentity()
  assert.deepEqual([...created.issues], [], '缺省 alias 映射不应有配置问题')
  identity = created.identity
  identity.registry.bind(SESSION_RECRUITER, 'recruiter')
  identity.registry.bind(SESSION_INTERVIEWER, 'interviewer_a')

  // 主 server：库"已配置"但不可达（用于走到 requireDatabase() 之后的纯内存校验）。
  server = await startActionServer({ database: UNREACHABLE_DB, databaseIssues: [], identity })
  // 对照 server：库未配置（503 分支）。
  unconfigured = await startActionServer({ database: null, databaseIssues: ['config.database.host is required'], identity })
})

after(async () => {
  await server.close()
  await unconfigured.close()
})

// ---------------------------------------------------------------------------
//  a. 路由注册（回环 vs 非回环）
// ---------------------------------------------------------------------------

describe('a. 路由注册', () => {
  test('回环 host：恰好注册 10 条 exact 路由（9 动作 + 统一 config），路径逐字一致', () => {
    assert.deepEqual(
      server.registered.map((route) => `${route.kind} ${route.path}`),
      EXPECTED_ROUTES,
      '只允许这 10 条 exact 路由（不放大暴露面）',
    )
    // kind 必须全是 exact（prefix 会把 /recruitment/api/action/** 全吃掉，违反最小暴露面）。
    assert.deepEqual([...new Set(server.registered.map((route) => route.kind))], ['exact'])
    // 路径唯一（宿主对重复 (kind,path) 会抛错）。
    assert.equal(new Set(server.registered.map((route) => route.path)).size, 10)
  })

  test('非回环 host（0.0.0.0）：零注册 + 一条 warn（fail-closed）', async () => {
    const nonLoopback = await startActionServer({ database: UNREACHABLE_DB, databaseIssues: [], identity }, '0.0.0.0')
    try {
      assert.deepEqual(nonLoopback.registered, [], '非回环 host 不得注册任何写动作路由')
      assert.equal(nonLoopback.warnings.length, 1, '必须且只能 warn 一次（可观察的 fail-closed）')
      assert.match(nonLoopback.warnings[0] as string, /未注册[\s\S]*不是回环地址/)
    } finally {
      await nonLoopback.close()
    }
  })
})

// ---------------------------------------------------------------------------
//  b. 未绑定 session（在 body / DB 之前）
// ---------------------------------------------------------------------------

describe('b. 未绑定 session', () => {
  test('合法 session 但未绑定 alias → 409 DEMO_ACTOR_UNMAPPED/SESSION_NOT_BOUND；无 body 也先拒（不碰 body）', async () => {
    // 故意不带 body / content-type：如果实现先读 body，这里会变成 415/400 而不是 409。
    const result = await httpCall(server, 'POST', '/recruitment/api/action/screening/decide', {
      session: SESSION_UNBOUND,
    })
    assertHttpError(result, 409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND')
    // 现状：`DEMO_ACTOR_UNMAPPED` 的 detail（session_id）被序列化进 message 的 compact-json，
    // 错误信封本身**没有** `detail` 键（见 `src/http/actions.ts::errorResponse` 的现状）。
    assert.match(result.text, /session-ffffffff-ffff-4fff-8fff-ffffffffffff/)
  })
})

// ---------------------------------------------------------------------------
//  c. 缺 / 非法 session header
// ---------------------------------------------------------------------------

describe('c. session header', () => {
  test('缺 x-dsh-session → 400 INVALID_ARGS/SESSION_REQUIRED', async () => {
    const result = await httpCall(server, 'POST', '/recruitment/api/action/stage/advance')
    assertHttpError(result, 400, 'INVALID_ARGS', 'SESSION_REQUIRED')
  })

  test('session 形态非法（非 UUID）→ 400 INVALID_ARGS/SESSION_ID_INVALID', async () => {
    const result = await httpCall(server, 'POST', '/recruitment/api/action/stage/advance', {
      session: 'not-a-session',
    })
    assertHttpError(result, 400, 'INVALID_ARGS', 'SESSION_ID_INVALID')
  })
})

// ---------------------------------------------------------------------------
//  d. alias 越权
// ---------------------------------------------------------------------------

describe('d. alias 越权', () => {
  test('interviewer_a 调任一写动作 → 403 FORBIDDEN/ACTOR_NOT_AUTHORIZED；无 body 也先拒', async () => {
    for (const path of [
      '/recruitment/api/action/screening/decide',
      '/recruitment/api/action/stage/advance',
      '/recruitment/api/action/decision/record',
      '/recruitment/api/action/config',
    ]) {
      const result = await httpCall(server, 'POST', path, { session: SESSION_INTERVIEWER })
      assertHttpError(result, 403, 'FORBIDDEN', 'ACTOR_NOT_AUTHORIZED')
      const detail = errorDetail(result)
      assert.equal(detail.alias, 'interviewer_a')
      assert.deepEqual(detail.allowed_aliases, ['recruiter'])
    }
  })
})

// ---------------------------------------------------------------------------
//  e. 身份 / 服务端派生键覆盖
// ---------------------------------------------------------------------------

describe('e. body 覆盖键', () => {
  test('body 带 actor_id / tenant_id / human_confirmation → 400 ACTOR_OVERRIDE_REJECTED（三条都列出）', async () => {
    const result = await httpCall(server, 'POST', '/recruitment/api/action/screening/decide', {
      session: SESSION_RECRUITER,
      body: {
        application_id: DEMO_APPLICATION,
        actor_id: ACTOR_RECRUITER,
        tenant_id: TENANT,
        human_confirmation: { confirmed_by_actor_id: ACTOR_RECRUITER },
      },
    })
    assertHttpError(result, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
    const detail = errorDetail(result)
    assert.deepEqual(detail.rejected, ['actor_id', 'human_confirmation', 'tenant_id'])
  })

  test('query ?actor_id= / header x-recruitment-actor → 400 ACTOR_OVERRIDE_REJECTED（在方法/body 之前）', async () => {
    const viaQuery = await httpCall(
      server,
      'POST',
      `/recruitment/api/action/screening/decide?actor_id=${ACTOR_RECRUITER}`,
    )
    assertHttpError(viaQuery, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
    assert.deepEqual(errorDetail(viaQuery).rejected, ['query.actor_id'])

    const viaHeader = await httpCall(server, 'POST', '/recruitment/api/action/screening/decide', {
      headers: { 'x-recruitment-actor': ACTOR_RECRUITER },
    })
    assertHttpError(viaHeader, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
    assert.deepEqual(errorDetail(viaHeader).rejected, ['header.x-recruitment-actor'])
  })
})

// ---------------------------------------------------------------------------
//  f. 同源闸门
// ---------------------------------------------------------------------------

describe('f. 同源闸门', () => {
  test('缺 x-recruitment-request: 1 → 403 FORBIDDEN/SAME_ORIGIN_REQUIRED', async () => {
    const result = await httpCall(server, 'POST', '/recruitment/api/action/screening/decide', {
      session: SESSION_RECRUITER,
      omitRequestHeader: true,
    })
    assertHttpError(result, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')
  })

  test('跨源 Origin → 403 FORBIDDEN/SAME_ORIGIN_REQUIRED', async () => {
    // fetch 会丢弃 forbidden header `Origin`，所以这里用 node:http 原样发出。
    const result = await rawCall(server, 'POST', '/recruitment/api/action/screening/decide', {
      'x-recruitment-request': '1',
      'x-dsh-session': SESSION_RECRUITER,
      origin: 'http://evil.example',
    })
    assert.equal(result.status, 403, result.text)
    const body = JSON.parse(result.text) as { error?: { code?: string; reason_code?: string } }
    assert.equal(body.error?.code, 'FORBIDDEN')
    assert.equal(body.error?.reason_code, 'SAME_ORIGIN_REQUIRED')
  })
})

// ---------------------------------------------------------------------------
//  g. 方法闸门
// ---------------------------------------------------------------------------

describe('g. 方法闸门', () => {
  test('GET → 405 且 allow: POST（同源通过后、进 handler 之前拒绝）', async () => {
    const result = await httpCall(server, 'GET', '/recruitment/api/action/screening/decide', {
      session: SESSION_RECRUITER,
    })
    assert.equal(result.status, 405, result.text)
    assert.equal(result.headers.get('allow'), 'POST', '405 必须带 allow: POST')
    assert.equal(result.text, '', '405 不返回业务 JSON（不假装成功）')
  })
})

// ---------------------------------------------------------------------------
//  h. 决策端点 scope 闸门（参数层的最早分叉）
// ---------------------------------------------------------------------------

describe('h. 决策 scope 闸门', () => {
  test('screening/decide 带 decision_scope:FINAL → 400 INVALID_ARGS/SCOPE_MISMATCH', async () => {
    const result = await httpCall(server, 'POST', '/recruitment/api/action/screening/decide', {
      session: SESSION_RECRUITER,
      body: { decision_scope: 'FINAL' },
    })
    assertHttpError(result, 400, 'INVALID_ARGS', 'SCOPE_MISMATCH')
    assert.equal(errorDetail(result).decision_scope, 'FINAL')
  })

  test('decision/record 缺 decision_scope → 400 INVALID_ARGS/MISSING_REQUIRED', async () => {
    const result = await httpCall(server, 'POST', '/recruitment/api/action/decision/record', {
      session: SESSION_RECRUITER,
      body: { application_id: DEMO_APPLICATION },
    })
    assertHttpError(result, 400, 'INVALID_ARGS', 'MISSING_REQUIRED')
    assert.deepEqual(errorDetail(result).missing, ['decision_scope'])
    assert.deepEqual(errorDetail(result).allowed, ['STAGE', 'FINAL'])
  })
})

// ---------------------------------------------------------------------------
//  i. config 统一入口（entity / operation 分派，均在建连之前）
// ---------------------------------------------------------------------------

describe('i. config 统一入口', () => {
  test('缺 entity → 400 INVALID_ARGS/MISSING_REQUIRED', async () => {
    const result = await httpCall(server, 'POST', '/recruitment/api/action/config', {
      session: SESSION_RECRUITER,
      body: { operation: 'create' },
    })
    assertHttpError(result, 400, 'INVALID_ARGS', 'MISSING_REQUIRED')
    assert.deepEqual(errorDetail(result).missing, ['entity'])
    assert.deepEqual(errorDetail(result).allowed, ['role', 'team', 'pipeline'])
  })

  test('非法 entity → 400 INVALID_ARGS/UNKNOWN_ENTITY', async () => {
    const result = await httpCall(server, 'POST', '/recruitment/api/action/config', {
      session: SESSION_RECRUITER,
      body: { entity: 'nope', operation: 'create' },
    })
    assertHttpError(result, 400, 'INVALID_ARGS', 'UNKNOWN_ENTITY')
    assert.equal(errorDetail(result).entity, 'nope')
  })

  test('读 operation（role/list）→ 400 INVALID_ARGS/READ_OPERATION_NOT_EXPOSED', async () => {
    const result = await httpCall(server, 'POST', '/recruitment/api/action/config', {
      session: SESSION_RECRUITER,
      body: { entity: 'role', operation: 'list' },
    })
    assertHttpError(result, 400, 'INVALID_ARGS', 'READ_OPERATION_NOT_EXPOSED')
    assert.deepEqual(errorDetail(result).allowed, ['create', 'update'])
  })
})

// ---------------------------------------------------------------------------
//  补充：数据库未配置 → 503（不假装成功；参数/身份闸门在前，建连在后）
// ---------------------------------------------------------------------------

describe('数据库未配置', () => {
  test('已绑定 recruiter + 合法 body：database=null → 503 NOT_CONFIGURED（不假装成功）', async () => {
    const result = await httpCall(unconfigured, 'POST', '/recruitment/api/action/stage/advance', {
      session: SESSION_RECRUITER,
      body: { application_id: DEMO_APPLICATION },
    })
    assertHttpError(result, 503, 'NOT_CONFIGURED', 'NOT_CONFIGURED')
    const detail = errorDetail(result)
    assert.deepEqual(detail.issues, ['config.database.host is required'])
  })
})
