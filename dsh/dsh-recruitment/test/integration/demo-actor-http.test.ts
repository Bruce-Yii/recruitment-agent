// D5 W1-B：Demo Actor HTTP + Scorecard Host Remote Action 的**真库 + 真 HTTP** 集成测试。
//
// 覆盖 `work/d5/w1/CONTEXT.md` §2 的六条验收（逐条注释标号），纪律：
//   1. 每个文件独占一个 `createIsolatedTestDatabase('demoactor…')` 一次性库（不写 ra_s6s7）；
//   2. 连不上库就**失败**（不静默 skip；R3 要 `skipped === 0`）；
//   3. 断言只信**独立 SQL 读回**（本文件只 import 路由与工具的公开入口来驱动，不用产品代码自证）；
//   4. 断言不放宽：每个拒绝路径都同时断言「状态/错误码」+「目标表行数前后不变」。
//
// 真实度：库 = 真 PG（迁移 0001→0016 重放）+ 真 bootstrap 种子；HTTP = 真 `node:http` server
// 监听 127.0.0.1:0（模拟 DSH `webServer.register` 收集 handler 后按 exact path 分发）；
// 身份注册表 = 产品 `createDemoActorIdentity()` 的真实进程内实例（与工具共享）。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createDemoActorIdentity,
  type DemoActorIdentity,
} from '../../src/demo-actor/index.ts'
import { registerActorHttp, type ActorHttpDeps } from '../../src/http/actor.ts'
import { createScorecardSubmitTool } from '../../src/tools/scorecard-submit.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  errorBody,
  HR_ACTOR,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

// ---------------------------------------------------------------------------
//  路径 / 固定 id（与 0002_seed + bootstrap-demo 的演示种子一致）
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根（test/integration → test → dsh-recruitment → dsh → repo）。 */
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const BOOTSTRAP_SCRIPT = join(REPO_ROOT, 'scripts', 'bootstrap-demo.mjs')

/** 集成测试底座配置（密码只从环境变量来；缺了 `testDatabaseConfig()` 直接抛）。 */
const BASE = testDatabaseConfig()

const ACTOR_103 = '11111111-1111-4111-8111-000000000103' // recruiter / HR（802 上的未分配负例）
const ACTOR_104 = '11111111-1111-4111-8111-000000000104' // interviewer_a
const ACTOR_105 = '11111111-1111-4111-8111-000000000105' // interviewer_b（bootstrap 种子）
const DEMO_APPLICATION = '11111111-1111-4111-8111-000000000701'
const INTERVIEW_801 = '11111111-1111-4111-8111-000000000801' // round 1 / POST_INTERVIEW（A 已分配）
const INTERVIEW_802 = '11111111-1111-4111-8111-000000000802' // round 2 / SCHEDULED（A/B 都分配）

/** 三个合法 session（`session-<uuid>` 形态；与浏览器 localStorage 同形）。 */
const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SESSION_C = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SESSION_D = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SESSION_E = 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

/** 802 的 rubric 维度（0002_seed rubric v1/v2 同键）。 */
const DIMENSION_KEYS = ['backend_depth', 'async_pipeline', 'frontend_basics'] as const

/** 工具路径的参数（Review 提交；HOLD 不触发 ADVANCE/REJECT 的额外语义门槛）。 */
function toolArgs(interviewId: string, idempotencyKey: string): Record<string, unknown> {
  return {
    interview_id: interviewId,
    items: {
      transcript_basis: 'NO_TRANSCRIPT',
      backend_depth: { assessment: 'MET', score: 4, note: '讲清了分片键的选择' },
      async_pipeline: { assessment: 'NOT_MET', score: 2, note: '队列重放答不上来' },
      frontend_basics: { assessment: 'NOT_OBSERVED' },
    },
    overall: 'HOLD',
    idempotency_key: idempotencyKey,
  }
}

/** HTTP 表单提交 body（D-89 形状；`nonce` 由 GET form 下发）。 */
function submissionBody(
  interviewId: string,
  nonce: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    interview_id: interviewId,
    application_id: DEMO_APPLICATION,
    dimensions: {
      backend_depth: { assessment: 'MET', score: 4, note: '讲清了分片键的选择' },
      async_pipeline: { assessment: 'NOT_MET', score: 2, note: '队列重放答不上来' },
      frontend_basics: { assessment: 'NOT_OBSERVED' },
    },
    transcript_basis: 'NO_TRANSCRIPT',
    overall: 'HOLD',
    nonce,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
//  一次性库 + bootstrap 种子
// ---------------------------------------------------------------------------

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let server: ActorServer

test.before(async () => {
  db = await createIsolatedTestDatabase('demoactor')
  assertPrivateDatabase(db.name)
  cfg = { ...BASE, database: db.name }

  // 真 bootstrap（allow-once）：补 rubric 审批 + D5 W1 的演示种子（105 / 801 / 802 / A/B 分配）。
  const boot = await runBootstrap(db.name)
  assert.equal(boot.code, 0, `bootstrap 必须 exit 0；实际 code=${String(boot.code)}\n${boot.stdout.slice(-3000)}\n${boot.stderr.slice(-2000)}`)

  // 独立 SQL 读回种子（不拿脚本自述当证据）。
  const actors = await query<{ id: string; kind: string; display_name: string }>(
    'select id::text as id, kind, display_name from recruitment.actor where id in ($1, $2) and tenant_id = $3 order by id',
    [ACTOR_104, ACTOR_105, TENANT],
  )
  assert.equal(actors.length, 2, 'bootstrap 应保证 104/105 两个 HUMAN actor 存在')
  assert.deepEqual(actors.map((row) => row.kind), ['HUMAN', 'HUMAN'])
  assert.equal(actors[1]?.display_name, '演示-面试官 B')
  const role = await query<{ n: number }>(
    `select count(*)::int as n
       from recruitment.actor_role ar
       join recruitment.role r on r.id = ar.role_id and r.tenant_id = ar.tenant_id
      where ar.actor_id = $1 and ar.tenant_id = $2 and r.code = 'INTERVIEWER' and ar.revoked_at is null`,
    [ACTOR_105, TENANT],
  )
  assert.equal(role[0]?.n, 1, 'bootstrap 必须给 105 授予 INTERVIEWER 角色')
  const interviews = await query<{ id: string; status: string }>(
    'select id::text as id, status from recruitment.interview where id in ($1, $2) and tenant_id = $3 order by round_no',
    [INTERVIEW_801, INTERVIEW_802, TENANT],
  )
  assert.equal(interviews.length, 2, 'bootstrap 应保证 801/802 两场演示面试存在')
  assert.equal(interviews[0]?.status, 'POST_INTERVIEW')
  assert.equal(interviews[1]?.status, 'SCHEDULED')
  const negative = await query<{ n: number }>(
    'select count(*)::int as n from recruitment.interviewer where interview_id = $1 and actor_id = $2 and tenant_id = $3',
    [INTERVIEW_802, ACTOR_103, TENANT],
  )
  assert.equal(negative[0]?.n, 0, '802 上 103 必须未分配（负例）')

  // 真 HTTP server + 真实 webServer.register 契约。
  const created = createDemoActorIdentity()
  assert.deepEqual([...created.issues], [], '缺省 alias 映射不应有配置问题')
  identity = created.identity
  server = await startActorServer({ database: cfg, databaseIssues: [], identity })

  // 绑定 A / B（各一次；后续用例共享这个进程内注册表）。
  for (const [session, alias] of [[SESSION_A, 'interviewer_a'], [SESSION_B, 'interviewer_b']] as const) {
    const put = await httpCall(server, 'PUT', '/recruitment/api/actor', { session, body: { alias } })
    assert.equal(put.status, 200, `绑定 ${alias} 应 200：${put.text}`)
  }
})

test.after(async () => {
  if (server !== undefined) await server.close()
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------
//  基础 helper（独立 SQL / 真 HTTP / 子进程）
// ---------------------------------------------------------------------------

/** 独立 SQL 读回（连本用例的一次性库；不经过任何产品模块）。 */
async function query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

/** 一场面试的 scorecard 行（独立读回；按创建时间排序）。 */
interface ScorecardDbRow {
  id: string
  status: string
  record_version: number
  interview_id: string
  interviewer_id: string
  status_changed_by_actor_id: string | null
}

async function scorecardRows(interviewId: string): Promise<ScorecardDbRow[]> {
  return await query<ScorecardDbRow>(
    `select sc.id::text as id, sc.status, sc.record_version,
            sc.interview_id::text as interview_id, sc.interviewer_id::text as interviewer_id,
            sc.status_changed_by_actor_id::text as status_changed_by_actor_id
       from recruitment.scorecard sc
      where sc.interview_id = $1 and sc.tenant_id = $2
      order by sc.created_at, sc.id`,
    [interviewId, TENANT],
  )
}

/** 一场面试面试官行的 id（`uq_interviewer` 保证唯一）。 */
async function interviewerRowId(interviewId: string, actorId: string): Promise<string> {
  const rows = await query<{ id: string }>(
    'select id::text as id from recruitment.interviewer where interview_id = $1 and actor_id = $2 and tenant_id = $3',
    [interviewId, actorId, TENANT],
  )
  assert.equal(rows.length, 1, `interviewer 行应恰好一条（${interviewId}/${actorId}）`)
  return rows[0]!.id
}

/** 合成面试的轮次计数（同一申请下唯一，避免 `uq_interview_slot` 冲突）。 */
let fixtureRound = 10

/**
 * 造一场**没有面评**的合成面试（真提交到本用例的一次性库；只给工具路径用例用，
 * 避免与 bootstrap 的 801/802 状态纠缠）。
 * @param actorId - 这场面试的登记面试官。
 * @returns 新面试 id。
 */
async function createInterviewFixture(actorId: string): Promise<string> {
  fixtureRound += 1
  const rows = await query<{ id: string }>(
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, stage_code, status, scheduled_start_at, scheduled_end_at)
     values ($1, $2, $3, 'D79TEST', 'S8', 'SCHEDULED',
             now() + interval '1 day', now() + interval '1 day' + interval '1 hour')
     returning id::text as id`,
    [TENANT, DEMO_APPLICATION, fixtureRound],
  )
  const interviewId = rows[0]!.id
  await query(
    'insert into recruitment.interviewer (tenant_id, interview_id, actor_id, required_scorecard) values ($1, $2, $3, true)',
    [TENANT, interviewId, actorId],
  )
  return interviewId
}

/** 跑 `scripts/bootstrap-demo.mjs`（cwd = 仓库根；env 只指向本用例的一次性库）。 */
function runBootstrap(databaseName: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('RECRUITMENT_') || key.startsWith('DEMO_')) continue
    env[key] = value
  }
  env.RECRUITMENT_DB_PASSWORD = BASE.password
  env.RECRUITMENT_DB_HOST = BASE.host
  env.RECRUITMENT_DB_PORT = String(BASE.port)
  env.RECRUITMENT_DB_USER = BASE.user
  env.RECRUITMENT_DB_NAME = databaseName
  env.RECRUITMENT_TENANT_ID = TENANT
  env.RECRUITMENT_ACTOR_ID = HR_ACTOR
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOOTSTRAP_SCRIPT], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`bootstrap 超时（120s）\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`))
    }, 120_000)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------------------
//  真 HTTP harness（端口 0；模拟 webServer.register 收集 exact handler）
// ---------------------------------------------------------------------------

interface ActorServer {
  readonly baseUrl: string
  readonly port: number
  readonly registered: readonly { kind: string; path: string }[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

/**
 * 起一个真 `node:http` server，并用 `registerActorHttp` 在其上注册路由。
 * 顺序是刻意的：先 listen（拿到真实端口），再把 `{host, port, register}` 传给路由
 * ——`sameOrigin(req, port)` 用的就是这个端口。
 * @param deps - 路由依赖。
 */
async function startActorServer(deps: ActorHttpDeps): Promise<ActorServer> {
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
          // 连接已坏：忽略。
        }
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  const dispose = registerActorHttp(
    {
      webServer: {
        host: '127.0.0.1',
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

/** 一次 HTTP 调用的结果。 */
interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

/**
 * 发一次同源请求（默认带 `x-recruitment-request: 1` 与 `X-DSH-Session`）。
 * @param target - harness。
 * @param method - HTTP 方法。
 * @param path - 请求路径（含 query）。
 * @param options - session / body / 覆盖头 / 是否省略同源头。
 */
async function httpCall(
  target: Pick<ActorServer, 'baseUrl'>,
  method: string,
  path: string,
  options: {
    readonly session?: string
    readonly body?: unknown
    readonly headers?: Readonly<Record<string, string>>
    readonly contentType?: string
    readonly omitRequestHeader?: boolean
  } = {},
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
  return { status: response.status, body, text }
}

/** 断言一个封闭错误体：`{error:{code, reason_code?, message}}`。 */
function assertHttpError(result: HttpResult, status: number, code: string, reasonCode?: string): void {
  assert.equal(result.status, status, `HTTP 状态应为 ${status}：${result.text}`)
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `响应必须是 {"error":{...}}：${result.text}`)
  assert.equal(error.code, code, `error.code 应为 ${code}：${result.text}`)
  if (reasonCode !== undefined) {
    assert.equal(error.reason_code, reasonCode, `error.reason_code 应为 ${reasonCode}：${result.text}`)
  }
  assert.equal(typeof error.message, 'string')
}

// ---------------------------------------------------------------------------
//  验收 1：同一进程注册表，两个 session 绑定 A/B → GET /actor 返不同 actor UUID（DB 读回核实）
// ---------------------------------------------------------------------------

test('验收1：A/B 两个 session → GET /actor 返回不同 HUMAN actor UUID（独立 SQL 读回）', async () => {
  assert.deepEqual(
    server.registered.map((route) => `${route.kind} ${route.path}`),
    [
      'exact /recruitment/api/actor',
      'exact /recruitment/api/action/scorecard/form',
      'exact /recruitment/api/action/scorecard/submit',
    ],
    '只能注册三条 exact 路由（不放大暴露面）',
  )

  const getA = await httpCall(server, 'GET', '/recruitment/api/actor', { session: SESSION_A })
  assert.equal(getA.status, 200, getA.text)
  assert.deepEqual(getA.body, {
    session_id: SESSION_A,
    alias: 'interviewer_a',
    actor_id: ACTOR_104,
    display_name: '演示-面试官',
    roles: ['INTERVIEWER'],
  })
  const getB = await httpCall(server, 'GET', '/recruitment/api/actor', { session: SESSION_B })
  assert.equal(getB.status, 200, getB.text)
  assert.deepEqual(getB.body, {
    session_id: SESSION_B,
    alias: 'interviewer_b',
    actor_id: ACTOR_105,
    display_name: '演示-面试官 B',
    roles: ['INTERVIEWER'],
  })
  assert.notEqual(getA.body.actor_id, getB.body.actor_id, 'A/B 必须映射到不同的 actor UUID')

  // ---- 独立 SQL 读回：两个 actor 都是 HUMAN，且 105 的 INTERVIEWER 角色真的在库里 ----
  const rows = await query<{ id: string; kind: string; display_name: string }>(
    'select id::text as id, kind, display_name from recruitment.actor where id in ($1, $2) and tenant_id = $3 order by id',
    [ACTOR_104, ACTOR_105, TENANT],
  )
  assert.deepEqual(rows.map((row) => [row.id, row.kind, row.display_name]), [
    [ACTOR_104, 'HUMAN', '演示-面试官'],
    [ACTOR_105, 'HUMAN', '演示-面试官 B'],
  ])

  // ---- 负例：未绑定 / 非法 session / 缺同源头 / 跨源 Origin / 覆盖头 / 覆盖键 ----
  const unbound = await httpCall(server, 'GET', '/recruitment/api/actor', { session: SESSION_D })
  assertHttpError(unbound, 409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND')

  const noSession = await httpCall(server, 'GET', '/recruitment/api/actor')
  assertHttpError(noSession, 400, 'INVALID_ARGS', 'SESSION_REQUIRED')

  const badSession = await httpCall(server, 'GET', '/recruitment/api/actor', { session: 'not-a-session' })
  assertHttpError(badSession, 400, 'INVALID_ARGS', 'SESSION_ID_INVALID')

  const noRequestHeader = await httpCall(server, 'GET', '/recruitment/api/actor', {
    session: SESSION_A,
    omitRequestHeader: true,
  })
  assertHttpError(noRequestHeader, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')

  const crossOrigin = await httpCall(server, 'GET', '/recruitment/api/actor', {
    session: SESSION_A,
    headers: { origin: 'http://evil.example' },
  })
  assertHttpError(crossOrigin, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')

  const headerOverride = await httpCall(server, 'GET', '/recruitment/api/actor', {
    session: SESSION_A,
    headers: { 'x-recruitment-actor': ACTOR_103 },
  })
  assertHttpError(headerOverride, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')

  const queryOverride = await httpCall(server, 'GET', `/recruitment/api/actor?tenant_id=${TENANT}`, {
    session: SESSION_A,
  })
  assertHttpError(queryOverride, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')

  const bodyOverride = await httpCall(server, 'PUT', '/recruitment/api/actor', {
    session: SESSION_C,
    body: { alias: 'interviewer_a', actor_id: ACTOR_103 },
  })
  assertHttpError(bodyOverride, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')

  const unknownAlias = await httpCall(server, 'PUT', '/recruitment/api/actor', {
    session: SESSION_C,
    body: { alias: 'admin' },
  })
  assertHttpError(unknownAlias, 400, 'INVALID_ARGS', 'UNKNOWN_ACTOR_ALIAS')

  const method = await httpCall(server, 'PATCH', '/recruitment/api/actor', { session: SESSION_A })
  assert.equal(method.status, 405, method.text)

  // ---- 非回环 host：不注册任何路由（fail-closed）+ 告警 ----
  const warnings: string[] = []
  let registeredCount = 0
  const dispose = registerActorHttp(
    {
      webServer: {
        host: '0.0.0.0',
        port: 1,
        register() {
          registeredCount += 1
          return () => {}
        },
      },
      logger: { warn(message: string) { warnings.push(message) } },
    },
    { database: cfg, databaseIssues: [], identity },
  )
  dispose()
  assert.equal(registeredCount, 0, '非回环地址不得注册任何路由')
  assert.equal(warnings.length, 1, '非回环地址必须告警')
  assert.match(warnings[0] ?? '', /不是回环地址/)
})

// ---------------------------------------------------------------------------
//  验收 2：同一 Interview 两份 Scorecard（A/B）→ 两行、interviewer/作者不同 + DB 读回
// ---------------------------------------------------------------------------

test('验收2：A/B 各 GET nonce + POST submit → 库里两行面评，interviewer_id / 作者不同', async () => {
  const before = await scorecardRows(INTERVIEW_802)
  assert.equal(before.length, 0, '夹具基线：802 上不应有面评')

  // ---- A：拿 form spec + nonce（D-89 spec 原样 + 三个顶层字段）----
  const formA = await httpCall(server, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_802}`, {
    session: SESSION_A,
  })
  assert.equal(formA.status, 200, formA.text)
  assert.equal(formA.body.tool, 'recruitment_scorecard_form')
  assert.equal(formA.body.contract_version, 'scorecard-form 1.0.0')
  assert.deepEqual(formA.body.actor, { actor_id: ACTOR_104, display_name: '演示-面试官' })
  assert.equal((formA.body.interview as Record<string, unknown>).id, INTERVIEW_802)
  assert.equal((formA.body.interview as Record<string, unknown>).application_id, DEMO_APPLICATION)
  assert.deepEqual(
    (formA.body.rubric as { dimensions: { key: string }[] }).dimensions.map((dimension) => dimension.key),
    [...DIMENSION_KEYS],
  )
  assert.deepEqual(
    (formA.body.dimensions as { key: string }[]).map((dimension) => dimension.key),
    [...DIMENSION_KEYS],
  )
  assert.deepEqual(formA.body.overall_options, ['ADVANCE', 'HOLD', 'REJECT'])
  assert.equal((formA.body.transcript_basis as Record<string, unknown>).value, 'NO_TRANSCRIPT')
  assert.equal((formA.body.transcript_basis as Record<string, unknown>).locked, true)
  assert.equal(formA.body.mode, 'CREATE')
  assert.equal(formA.body.actor_alias, 'interviewer_a')
  const nonceA = formA.body.nonce
  assert.equal(typeof nonceA, 'string')
  assert.ok((nonceA as string).length >= 40, 'nonce 必须是 32B 随机 base64url（≥40 字符）')
  assert.equal(new Date(String(formA.body.expires_at)).getTime() > Date.now(), true, 'expires_at 必须在未来')

  const formB = await httpCall(server, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_802}`, {
    session: SESSION_B,
  })
  assert.equal(formB.status, 200, formB.text)
  assert.equal(formB.body.actor_alias, 'interviewer_b')
  assert.deepEqual(formB.body.actor, { actor_id: ACTOR_105, display_name: '演示-面试官 B' })
  const nonceB = formB.body.nonce as string
  assert.notEqual(nonceA, nonceB, '两个 session 的 nonce 必须不同')

  // ---- 未分配者（recruiter=103）拿 form → 403 ACTOR_NOT_INTERVIEWER，行数不变 ----
  const putC = await httpCall(server, 'PUT', '/recruitment/api/actor', { session: SESSION_C, body: { alias: 'recruiter' } })
  assert.equal(putC.status, 200, putC.text)
  const formC = await httpCall(server, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_802}`, {
    session: SESSION_C,
  })
  assertHttpError(formC, 403, 'INTERVIEWER_MISMATCH', 'ACTOR_NOT_INTERVIEWER')
  assert.equal((await scorecardRows(INTERVIEW_802)).length, 0, '拿表单被拒不得写库')

  // ---- A 提交 ----
  const submitA = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_A,
    body: submissionBody(INTERVIEW_802, nonceA as string),
  })
  assert.equal(submitA.status, 200, submitA.text)
  assert.deepEqual(Object.keys(submitA.body).sort(), [
    'actor_id', 'interview_id', 'interviewer_id', 'record_version', 'replayed', 'scorecard_id', 'status',
  ], '成功响应必须精确是 7 个键')
  assert.equal(submitA.body.status, 'SUBMITTED')
  assert.equal(submitA.body.actor_id, ACTOR_104)
  assert.equal(submitA.body.interview_id, INTERVIEW_802)
  assert.equal(submitA.body.interviewer_id, await interviewerRowId(INTERVIEW_802, ACTOR_104))
  assert.equal(submitA.body.record_version, 1)
  assert.equal(submitA.body.replayed, false)

  // ---- B 提交（同一个 Interview，不同人）----
  const submitB = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_B,
    body: submissionBody(INTERVIEW_802, nonceB),
  })
  assert.equal(submitB.status, 200, submitB.text)
  assert.equal(submitB.body.status, 'SUBMITTED')
  assert.equal(submitB.body.actor_id, ACTOR_105)
  assert.equal(submitB.body.interviewer_id, await interviewerRowId(INTERVIEW_802, ACTOR_105))
  assert.notEqual(submitA.body.scorecard_id, submitB.body.scorecard_id)

  // ---- 独立 SQL 读回：两行、作者不同、interviewer 不同 ----
  const after = await scorecardRows(INTERVIEW_802)
  assert.equal(after.length, 2, `802 上应恰好两行面评（实际 ${JSON.stringify(after)}）`)
  assert.deepEqual(after.map((row) => row.status), ['SUBMITTED', 'SUBMITTED'])
  const authorSet = new Set(after.map((row) => row.status_changed_by_actor_id))
  assert.deepEqual([...authorSet].sort(), [ACTOR_104, ACTOR_105], '两行的作者必须不同（A/B）')
  const interviewerSet = new Set(after.map((row) => row.interviewer_id))
  assert.equal(interviewerSet.size, 2, '两行的 interviewer 行必须不同')
  assert.deepEqual(
    after.map((row) => row.id).sort(),
    [String(submitA.body.scorecard_id), String(submitB.body.scorecard_id)].sort(),
    '响应里的 scorecard_id 必须等于库里的行',
  )
})

// ---------------------------------------------------------------------------
//  验收 3：未分配者（802 上的 recruiter=103）→ form/submit 403，行数不变
// ---------------------------------------------------------------------------

test('验收3：未分配者 recruiter(103) → form/submit 均 403 ACTOR_NOT_INTERVIEWER，scorecard 行数不变', async () => {
  const before = await scorecardRows(INTERVIEW_802)
  assert.equal(before.length, 2, '前置：验收 2 已写入两行')

  // form 路径：已在上一个用例覆盖；这里再独立断言一次（session C 仍绑定 recruiter）。
  const form = await httpCall(server, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_802}`, {
    session: SESSION_C,
  })
  assertHttpError(form, 403, 'INTERVIEWER_MISMATCH', 'ACTOR_NOT_INTERVIEWER')

  // submit 路径：C 先绑 interviewer_a 拿 nonce，再**改绑 recruiter** 后提交 →
  // 服务端在提交时用**当前的** alias 解析执行人（103），必须 403 且零写入。
  const putAsA = await httpCall(server, 'PUT', '/recruitment/api/actor', { session: SESSION_C, body: { alias: 'interviewer_a' } })
  assert.equal(putAsA.status, 200, putAsA.text)
  const formForC = await httpCall(server, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_802}`, {
    session: SESSION_C,
  })
  assert.equal(formForC.status, 200, formForC.text)
  const nonceC = formForC.body.nonce as string

  const putAsRecruiter = await httpCall(server, 'PUT', '/recruitment/api/actor', { session: SESSION_C, body: { alias: 'recruiter' } })
  assert.equal(putAsRecruiter.status, 200, putAsRecruiter.text)

  const submit = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_C,
    body: submissionBody(INTERVIEW_802, nonceC),
  })
  assertHttpError(submit, 403, 'INTERVIEWER_MISMATCH', 'ACTOR_NOT_INTERVIEWER')

  const after = await scorecardRows(INTERVIEW_802)
  assert.equal(after.length, before.length, '被拒路径必须零写入（行数不变）')
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id), '既有行不得被改动')
})

// ---------------------------------------------------------------------------
//  验收 4：缺失映射 fail-closed（未绑定 409 零写入；工具路径 DEMO_ACTOR_UNMAPPED 零写入）
// ---------------------------------------------------------------------------

test('验收4：未绑定 session → HTTP 409 零写入；工具路径 identity 装配但未绑定 → DEMO_ACTOR_UNMAPPED 零写入', async () => {
  const before802 = await scorecardRows(INTERVIEW_802)
  const before801 = await scorecardRows(INTERVIEW_801)

  // ---- HTTP：未绑定 session 三条路由全部 409（且非 nonce/参数错误）----
  const getActor = await httpCall(server, 'GET', '/recruitment/api/actor', { session: SESSION_D })
  assertHttpError(getActor, 409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND')
  const getForm = await httpCall(server, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_802}`, {
    session: SESSION_D,
  })
  assertHttpError(getForm, 409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND')
  const submit = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_D,
    body: submissionBody(INTERVIEW_802, 'fabricated-nonce'),
  })
  assertHttpError(submit, 409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND')
  assert.equal((await scorecardRows(INTERVIEW_802)).length, before802.length, '未绑定路径必须零写入')

  // ---- 工具路径：identity 已装配、session 未绑定 → DEMO_ACTOR_UNMAPPED（在建池/开事务之前）----
  const tool = createScorecardSubmitTool({ database: cfg, identity })
  let failure: unknown
  try {
    await tool.execute(toolArgs(INTERVIEW_801, 'demo-actor-unbound-tool'), { agent: { id: SESSION_D } })
  } catch (error) {
    failure = error
  }
  assert.ok(failure !== undefined, '未绑定 session 的工具调用必须失败，不得回退 config.actor_id')
  // `RecruitmentToolError` 的稳定 code 是 message 前缀 + `.code`；detail JSON 里只有 reason_code。
  assert.equal((failure as { code?: unknown }).code, 'DEMO_ACTOR_UNMAPPED')
  const body = errorBody(failure)
  assert.equal(body.reason_code, 'SESSION_NOT_BOUND')
  assert.equal((await scorecardRows(INTERVIEW_801)).length, before801.length, '工具拒绝必须零写入')

  // ---- 配置缺映射：alias 没有 UUID → PUT 409 ALIAS_NOT_MAPPED（不静默回退默认值）----
  const broken = createDemoActorIdentity({ interviewer_b: 'not-a-uuid' })
  assert.equal(broken.issues.length, 1, '非法配置必须产生 issue（配置写坏要能被看见）')
  const brokenServer = await startActorServer({ database: cfg, databaseIssues: [], identity: broken.identity })
  try {
    const put = await httpCall(brokenServer, 'PUT', '/recruitment/api/actor', {
      session: SESSION_E,
      body: { alias: 'interviewer_b' },
    })
    assertHttpError(put, 409, 'DEMO_ACTOR_UNMAPPED', 'ALIAS_NOT_MAPPED')
    assert.equal((await scorecardRows(INTERVIEW_802)).length, before802.length, '缺映射路径必须零写入')
  } finally {
    await brokenServer.close()
  }
})

// ---------------------------------------------------------------------------
//  验收 5：Agent 不能绕过 nonce（无/伪造/重放/跨面试/跨 session）；工具路径仍走 D-79 approval
// ---------------------------------------------------------------------------

test('验收5：无 nonce / 伪造 nonce / 重放已用 nonce / 跨面试 nonce → 403/409 零写入', async () => {
  const before802 = await scorecardRows(INTERVIEW_802)
  const before801 = await scorecardRows(INTERVIEW_801)

  // ---- 无 nonce ----
  const noNonce = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_A,
    body: submissionBody(INTERVIEW_802, ''),
  })
  assertHttpError(noNonce, 403, 'NONCE_REQUIRED', 'NONCE_REQUIRED')

  // ---- 伪造 nonce（服务端从未下发）----
  const fakeNonce = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_A,
    body: submissionBody(INTERVIEW_802, 'A'.repeat(43)),
  })
  assertHttpError(fakeNonce, 403, 'NONCE_INVALID', 'NONCE_INVALID')

  // ---- 重放已用 nonce：重新拿一个，成功提交后再用同一个 nonce 提交一次 ----
  const form = await httpCall(server, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_801}`, {
    session: SESSION_A,
  })
  assert.equal(form.status, 200, form.text)
  const nonceReplay = form.body.nonce as string
  const firstUse = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_A,
    body: submissionBody(INTERVIEW_801, nonceReplay, { application_id: DEMO_APPLICATION }),
  })
  assert.equal(firstUse.status, 200, firstUse.text)
  assert.equal(firstUse.body.replayed, false)
  const replay = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_A,
    body: submissionBody(INTERVIEW_801, nonceReplay),
  })
  assertHttpError(replay, 409, 'NONCE_ALREADY_USED', 'NONCE_ALREADY_USED')
  assert.equal((await scorecardRows(INTERVIEW_801)).length, before801.length + 1, 'nonce 重放不得新增第二行')

  // ---- 跨面试 nonce：801 的 nonce 拿去提交 802（既有两行）----
  const form801 = await httpCall(server, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_801}`, {
    session: SESSION_A,
  })
  assert.equal(form801.status, 200, form801.text)
  const nonce801 = form801.body.nonce as string
  const crossInterview = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_A,
    body: submissionBody(INTERVIEW_802, nonce801),
  })
  assertHttpError(crossInterview, 403, 'NONCE_INVALID', 'NONCE_BINDING_MISMATCH')

  // ---- 跨 session nonce：801 的 nonce 由 B 提交（服务端先校验 nonce 的 session 绑定，不碰 DB）----
  const crossSession = await httpCall(server, 'POST', '/recruitment/api/action/scorecard/submit', {
    session: SESSION_B,
    body: submissionBody(INTERVIEW_801, nonce801),
  })
  assertHttpError(crossSession, 403, 'NONCE_INVALID', 'NONCE_BINDING_MISMATCH')

  // ---- 以上所有拒绝路径：802 行数完全不变 ----
  assert.equal((await scorecardRows(INTERVIEW_802)).length, before802.length, '被拒路径不得写 802')

  // ---- 过期 nonce（TTL 40ms 的独立 server；同库同 identity）----
  const shortTtl = await startActorServer({ database: cfg, databaseIssues: [], identity, nonceTtlMs: 40 })
  try {
    // 用 A（801 的登记面试官；A 已提交过 801 → 表单进入 REVISE，仍可拿 nonce）。
    const formShort = await httpCall(shortTtl, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_801}`, {
      session: SESSION_A,
    })
    assert.equal(formShort.status, 200, formShort.text)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const expired = await httpCall(shortTtl, 'POST', '/recruitment/api/action/scorecard/submit', {
      session: SESSION_A,
      body: submissionBody(INTERVIEW_801, formShort.body.nonce as string),
    })
    assertHttpError(expired, 409, 'NONCE_EXPIRED', 'NONCE_EXPIRED')
    assert.equal((await scorecardRows(INTERVIEW_801)).length, before801.length + 1, '过期 nonce 不得写库')
  } finally {
    await shortTtl.close()
  }

  // ---- Agent 工具路径仍走 D-79 approval：approval 缺省 = unavailable = 拒绝、零写入 ----
  // 用一场**没有面评**的合成面试（否则 prepare 会先抛 ALREADY_SUBMITTED，测不到闸门）。
  const gateInterview = await createInterviewFixture(ACTOR_104)
  const agentTool = createScorecardSubmitTool({ database: cfg, identity }) // 故意不传 approval
  let forbidden: unknown
  try {
    await agentTool.execute(toolArgs(gateInterview, 'd79-approval-unavailable'), { agent: { id: SESSION_A } })
  } catch (error) {
    forbidden = error
  }
  assert.ok(forbidden !== undefined, 'Agent 无 approval 通道时必须被拒（不得用工具冒充 Host 人工动作）')
  const forbiddenBody = errorBody(forbidden)
  assert.equal(forbiddenBody.code, 'FORBIDDEN')
  assert.equal(forbiddenBody.reason_code, 'APPROVAL_UNAVAILABLE')
  assert.deepEqual(forbiddenBody.detail, { approval: 'unavailable', tool: 'recruitment_scorecard_submit' })
  assert.equal((await scorecardRows(gateInterview)).length, 0, 'D-79 拒绝必须零写入')
  assert.equal((await scorecardRows(INTERVIEW_801)).length, before801.length + 1, 'D-79 拒绝不得影响既有行')
})

// ---------------------------------------------------------------------------
//  验收 6（补充机检）：提交后的响应字段 = 独立 DB 读回；同一 session 重开表单看到 REVISE
// ---------------------------------------------------------------------------

test('补充：提交后 GET form → mode/current 反映库内真实面评（不造假本地状态）', async () => {
  const form = await httpCall(server, 'GET', `/recruitment/api/action/scorecard/form?interview_id=${INTERVIEW_802}`, {
    session: SESSION_A,
  })
  assert.equal(form.status, 200, form.text)
  assert.equal(form.body.mode, 'REVISE', 'A 已提交过 802 → 表单必须进入 REVISE')
  const current = form.body.current as Record<string, unknown>
  assert.equal(current.status, 'SUBMITTED')
  assert.equal(current.record_version, 1)
  assert.equal(current.rubric_version_id, (form.body.rubric as Record<string, unknown>).id)

  const rows = await scorecardRows(INTERVIEW_802)
  const rowA = rows.find((row) => row.status_changed_by_actor_id === ACTOR_104)
  assert.ok(rowA !== undefined)
  assert.equal(current.id, rowA.id, '表单 current.id 必须等于库里 A 的现行面评行')
})
