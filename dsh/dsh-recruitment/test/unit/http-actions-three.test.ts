// 三条新写动作 HTTP 路由（transfer / constraint / job/create）的**无真库**契约单元测试。
//
// 冻结契约：`work/d5/http-actions/CONTRACT.md`（owner-http-actions lane）。
// 本文件只依赖**已存在的公共 API** `registerActionsHttp(ctx, deps)` 与三条 path **字符串字面量**，
// 不 import 实现方新增的任何内部导出（实现与本测试并行开发）。
//
// 纪律（与 `test/unit/action-p0.test.ts` 同形）：
//   * 真 `node:http` server 监听 127.0.0.1:0；用收集式假 `webServer.register` 按 exact path 分发，
//     复刻 DSH 宿主对 `webServer` 的最小契约；
//   * 身份 = 产品真的 `createDemoActorIdentity()` 进程内单例，只 bind 不读库；
//   * `database` = 不可达配置（127.0.0.1:1 + 不存在的库名）：本文件所有被断言的分支都发生在
//     建立任何 DB 连接之前（同源 / session / alias / 覆盖键 / confirmation_text 必填），
//     任何意外建连都会立刻失败 → 以非预期状态码暴露，**不是假绿**；
//   * 断言只看 HTTP 状态 + 封闭错误信封（`{error:{code,reason_code,message,detail?}}`）。
//     "负例零 DB 写入"由「不可达库配置 + 负例仍返回明确的 4xx 契约错误」共同证明：
//     若负例路径先建连/写库，就会拿不到这个 4xx（连接失败 → 500/连接异常）。
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

/** 三条新路由的 exact path（契约字面量，不 import 实现常量）。 */
const TRANSFER_PATH = '/recruitment/api/action/application/transfer'
const CONSTRAINT_PATH = '/recruitment/api/action/candidate/constraint'
const JOB_CREATE_PATH = '/recruitment/api/action/job/create'
const THREE_PATHS: readonly string[] = [TRANSFER_PATH, CONSTRAINT_PATH, JOB_CREATE_PATH]

/** `0002_seed` 的演示租户（只用于构造假配置；本文件不连库）。 */
const TENANT = '11111111-1111-4111-8111-000000000001'
/** `recruiter` alias 的默认映射（`demo-actor/alias.ts`）。 */
const ACTOR_RECRUITER = '11111111-1111-4111-8111-000000000103'
/** 合法 UUID 形状的占位 id（负例 body 用；不要求库里存在）。 */
const UUID_A = '11111111-1111-4111-8111-000000000701'
const UUID_B = '11111111-1111-4111-8111-000000000401'

const SESSION_RECRUITER = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_INTERVIEWER = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SESSION_UNBOUND = 'session-ffffffff-ffff-4fff-8fff-ffffffffffff'

/**
 * 不可达的库配置：`port: 1` + 不存在的库名。
 * 作用只是让 `requireDatabase()` 通过，使测试能走到它之后**纯内存**的校验分支；
 * 任何真的建连都会立刻失败——若某个负例意外走到建连，测试会以非预期状态失败（不是假绿）。
 */
const UNREACHABLE_DB: ResolvedDatabaseConfig = {
  host: '127.0.0.1',
  port: 1,
  user: 'nobody',
  database: 'no_such_db_http_actions_three_unit',
  password: 'not-a-real-password',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT,
  actor_id: ACTOR_RECRUITER,
  statement_timeout_ms: 1_000,
  connect_timeout_ms: 200,
  max: 1,
}

/** 每条路由一份"最小合法" body（通过闸门后才有机会谈业务；负例只改其中一项）。 */
function validBody(path: string): Record<string, unknown> {
  if (path === TRANSFER_PATH) {
    return { application_id: UUID_A, target_job_id: UUID_B, confirmation_text: '同意跨岗调剂' }
  }
  if (path === CONSTRAINT_PATH) {
    return { action: 'PIN', candidate_id: UUID_A, text: '优先排下一轮', source: 'CHAT', confirmation_text: '同意置顶约束' }
  }
  return { title: '后端工程师', confirmation_text: '同意新建岗位' }
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
 * 起真 HTTP server → listen(0) 拿端口 → 把 `{host, port, register}` 交给 `registerActionsHttp`。
 * 顺序刻意：sameOrigin(req, port) 用的就是 listen 后的真实端口。
 * @param deps - 路由依赖。
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
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', reason_code: 'NO_EXACT_ROUTE' } }))
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
  readonly body?: Record<string, unknown>
  readonly headers?: Readonly<Record<string, string>>
  readonly omitRequestHeader?: boolean
  /** 覆盖 Host 头（错 Host 的同源负例）。 */
  readonly host?: string
}

/**
 * 发一次请求（默认带 `x-recruitment-request: 1`；给了 session 才带 `x-dsh-session`）。
 * Host 默认是 harness 的真实 `127.0.0.1:<port>`（满足 sameOrigin）。
 */
async function httpCall(
  target: Pick<ActionServer, 'baseUrl' | 'port'>,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.omitRequestHeader !== true) headers['x-recruitment-request'] = '1'
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  headers['host'] = options.host ?? `127.0.0.1:${target.port}`
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
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

/** 用 `node:http` 原样发出请求（fetch 会吞掉某些 forbidden header；这里主要给 Host 覆盖用）。 */
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

before(async () => {
  const created = createDemoActorIdentity()
  assert.deepEqual([...created.issues], [], '缺省 alias 映射不应有配置问题')
  identity = created.identity
  identity.registry.bind(SESSION_RECRUITER, 'recruiter')
  identity.registry.bind(SESSION_INTERVIEWER, 'interviewer_a')

  server = await startActionServer({ database: UNREACHABLE_DB, databaseIssues: [], identity })
})

after(async () => {
  await server.close()
})

// ---------------------------------------------------------------------------
//  a. 路由注册（回环 vs 非回环）
// ---------------------------------------------------------------------------

describe('a. 三条新路由的注册点', () => {
  test('回环 host：三条 exact path 全部注册，kind=exact', () => {
    const byPath = new Map(server.registered.map((route) => [route.path, route.kind]))
    for (const path of THREE_PATHS) {
      assert.equal(byPath.get(path), 'exact', `必须注册 exact 路由 ${path}（实际 kind=${String(byPath.get(path))}）`)
    }
    // 三条路径唯一，且不重复（宿主对重复 (kind,path) 会抛错）。
    assert.equal(new Set(THREE_PATHS).size, 3)
    for (const path of THREE_PATHS) {
      assert.equal(server.registered.filter((route) => route.path === path).length, 1, `${path} 不得重复注册`)
    }
  })

  test('非回环 host（0.0.0.0）：三条都不注册 + 一条 warn（fail-closed）', async () => {
    const nonLoopback = await startActionServer({ database: UNREACHABLE_DB, databaseIssues: [], identity }, '0.0.0.0')
    try {
      for (const path of THREE_PATHS) {
        assert.ok(
          !nonLoopback.registered.some((route) => route.path === path),
          `非回环 host 不得注册 ${path}`,
        )
      }
      assert.deepEqual(nonLoopback.registered, [], '非回环 host 不得注册任何写动作路由')
      assert.equal(nonLoopback.warnings.length, 1, '必须且只能 warn 一次（可观察的 fail-closed）')
      assert.match(nonLoopback.warnings[0] as string, /未注册[\s\S]*不是回环地址/)
    } finally {
      await nonLoopback.close()
    }
  })
})

// ---------------------------------------------------------------------------
//  b–f. 每条路由共同的 fail-closed 闸门（碰 DB 之前）
// ---------------------------------------------------------------------------

/** 对三条路由逐一跑同一个负例族；`make` 决定该负例的请求形态。 */
async function forEachPath(
  label: string,
  make: (path: string) => { session?: string; body?: Record<string, unknown>; options?: Omit<CallOptions, 'session' | 'body'> },
  assertOne: (path: string, result: HttpResult) => void,
): Promise<void> {
  for (const path of THREE_PATHS) {
    const spec = make(path)
    const result = await httpCall(server, 'POST', path, {
      ...(spec.options ?? {}),
      ...(spec.session !== undefined ? { session: spec.session } : {}),
      ...(spec.body !== undefined ? { body: spec.body } : {}),
    })
    try {
      assertOne(path, result)
    } catch (error) {
      assert.fail(`${label} @ ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

describe('b. 无 x-dsh-session → 400 SESSION_REQUIRED', () => {
  test('三条路由都先拒 session（在 body/DB 之前）', async () => {
    await forEachPath(
      '缺 session',
      (path) => ({ body: validBody(path) }),
      (_path, result) => assertHttpError(result, 400, 'INVALID_ARGS', 'SESSION_REQUIRED'),
    )
  })
})

describe('c. session 未绑定 → 409 DEMO_ACTOR_UNMAPPED', () => {
  test('三条路由都先拒未绑定 session（在 body/DB 之前）', async () => {
    await forEachPath(
      '未绑定 session',
      (path) => ({ session: SESSION_UNBOUND, body: validBody(path) }),
      (_path, result) => assertHttpError(result, 409, 'DEMO_ACTOR_UNMAPPED'),
    )
  })
})

describe('d. 非 recruiter alias → 403 FORBIDDEN(ACTOR_NOT_AUTHORIZED)', () => {
  test('三条路由都拒绝 interviewer_a（在 body/DB 之前）', async () => {
    await forEachPath(
      '越权 alias',
      (path) => ({ session: SESSION_INTERVIEWER, body: validBody(path) }),
      (_path, result) => {
        assertHttpError(result, 403, 'FORBIDDEN', 'ACTOR_NOT_AUTHORIZED')
        assert.equal(errorDetail(result).alias, 'interviewer_a')
        assert.deepEqual(errorDetail(result).allowed_aliases, ['recruiter'])
      },
    )
  })
})

describe('e. body 身份/服务端派生键 → 400 ACTOR_OVERRIDE_REJECTED', () => {
  for (const key of ['actor_id', 'tenant_id', 'confirmation_text_sha256'] as const) {
    test(`三条路由都拒绝 body.${key}（服务端派生键，零写入）`, async () => {
      await forEachPath(
        `body.${key}`,
        (path) => ({ session: SESSION_RECRUITER, body: { ...validBody(path), [key]: 'override' } }),
        (_path, result) => {
          assertHttpError(result, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
          assert.ok(
            (errorDetail(result).rejected as unknown[]).includes(key),
            `detail.rejected 必须含 ${key}：${result.text}`,
          )
        },
      )
    })
  }
})

describe('f. 缺 confirmation_text → 400 MISSING_REQUIRED', () => {
  test('三条路由都要求人点原话（在碰 DB 之前）', async () => {
    await forEachPath(
      '缺 confirmation_text',
      (path) => {
        const body = { ...validBody(path) }
        delete body.confirmation_text
        return { session: SESSION_RECRUITER, body }
      },
      (_path, result) => {
        assertHttpError(result, 400, 'INVALID_ARGS', 'MISSING_REQUIRED')
        // 不锁死 detail 的具体形状（实现方可能只给 message）；状态码 + reason_code 即契约。
      },
    )
  })
})

describe('g. 同源闸门 → 403 SAME_ORIGIN_REQUIRED', () => {
  test('三条路由：缺 x-recruitment-request:1 → 403（在 session/alias/DB 之前）', async () => {
    await forEachPath(
      '缺同源头',
      (path) => ({ session: SESSION_RECRUITER, body: validBody(path), options: { omitRequestHeader: true } }),
      (_path, result) => assertHttpError(result, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED'),
    )
  })

  test('三条路由：错 Host（evil.example）→ 403（在 session/alias/DB 之前）', async () => {
    for (const path of THREE_PATHS) {
      const result = await rawCall(server, 'POST', path, {
        host: 'evil.example',
        'x-recruitment-request': '1',
        'x-dsh-session': SESSION_RECRUITER,
        'content-type': 'application/json',
      })
      assert.equal(result.status, 403, `${path} 错 Host 应 403：${result.text}`)
      const body = JSON.parse(result.text) as { error?: { code?: string; reason_code?: string } }
      assert.equal(body.error?.code, 'FORBIDDEN', `${path}: ${result.text}`)
      assert.equal(body.error?.reason_code, 'SAME_ORIGIN_REQUIRED', `${path}: ${result.text}`)
    }
  })
})

describe('h. 负例前置顺序：同源闸门在 session 之前', () => {
  test('既缺 session 又缺同源头 → 先 403 SAME_ORIGIN_REQUIRED（不是 400 SESSION_REQUIRED）', async () => {
    for (const path of THREE_PATHS) {
      const result = await httpCall(server, 'POST', path, {
        body: validBody(path),
        omitRequestHeader: true,
      })
      assertHttpError(result, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')
    }
  })
})
