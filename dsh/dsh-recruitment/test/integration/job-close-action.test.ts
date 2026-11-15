// D5 岗位生命周期 · `job/close` Host Remote Action 的**真库 + 真 HTTP** 集成测试（task-55-B）。
//
// 唯一权威口径：`work/d5/joblife/CONTRACT.md`。纪律（照 `demo-actor-http.test.ts`）：
//   1. 本文件独占一个 `createIsolatedTestDatabase('jobclose')` 一次性空库（迁移 0001→0016 重放）；
//      **不写** `ra_s6s7`，`assertPrivateDatabase` 守卫，`after` 里 `db.drop()`；
//   2. 连不上库就**失败**（不静默 skip；R3 要求 skipped === 0）；
//   3. 断言只信**独立 SQL 读回**（本文件只 import 路由入口与进程内 identity 驱动，不用产品代码自证）；
//   4. 每条拒绝路径都同时断言「HTTP 错误码」+「目标表行数 / record_version / 事件数前后全等」。
//
// 夹具（CONTRACT §2 的终止矩阵，全部由本文件用 SQL 自建；0002_seed 只提供租户/部门/HUMAN actor）：
//   JOB(OPEN) ── 5 条 application：3 ACTIVE + 1 ON_HOLD + 1 CLOSED（既有终态，不得变）
//   ├── 面试：2 SCHEDULED（→CANCELLED）、1 POST_INTERVIEW + 1 IN_PROGRESS（不动，计数）、1 CANCELLED（不动，计数）
//   └── business_task：2 未完成（一种 `{"type":…}` 引擎形状、一种 `{"kind":"JOB"…}` trace 形状）
//        + 1 RUNNING（带 CLAIMED attempt）+ 1 SUCCEEDED（不动）+ 1 引用**另一个岗位**的 PENDING（不在范围）
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  createDemoActorIdentity,
  type DemoActorIdentity,
} from '../../src/demo-actor/index.ts'
import {
  JOB_CLOSE_PATH,
  JOB_CREATE_PATH,
  JOB_DRAFT_PATH,
  closeJobInTransaction,
  registerJobActionHttp,
  type JobActionHttpDeps,
} from '../../src/http/actions-job.ts'
import { withActor, type ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  hex64,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

// ---------------------------------------------------------------------------
//  固定 id（本文件独占的一次性库；UUID 形状合法即可，不做版本位语义）
// ---------------------------------------------------------------------------

/** 演示部门（0002_seed …010）。 */
const DEMO_DEPARTMENT = '11111111-1111-4111-8111-000000000010'
/** 关岗的确认人 = 0002_seed 的 HUMAN recruiter（`…103` / 演示-HR 专员）。 */
const ACTOR_103 = '11111111-1111-4111-8111-000000000103'

/** 主用例的岗位（OPEN）。 */
const JOB = '11111111-1111-4111-8111-000000000c01'
const JOB_VERSION = '11111111-1111-4111-8111-000000000c02'
/** 与本岗位无关的另一个岗位（scope 反证：它的业务任务不得被取消）。 */
const OTHER_JOB = '11111111-1111-4111-8111-000000000c03'
/** 回滚反证用的独立岗位（故障注入前它是 OPEN）。 */
const JOB2 = '11111111-1111-4111-8111-000000000c04'
const JOB2_VERSION = '11111111-1111-4111-8111-000000000c05'
/** 库里真实存在的 AGENT_WORKER（非 HUMAN 反证：alias 映射到它 → 403）。 */
const AGENT_ACTOR = '11111111-1111-4111-8111-000000000c06'
/** 库里**不存在**的 actor（fail-closed 反证：映射到它 → 409 ACTOR_ROW_MISSING）。 */
const MISSING_ACTOR = '11111111-1111-4111-8111-000000009999'

/** 候选人（每个 ACTIVE 申请一条独立候选人，避开 `uq_application_active_cycle`）。 */
const C1 = '11111111-1111-4111-8111-000000000e01'
const C2 = '11111111-1111-4111-8111-000000000e02'
const C3 = '11111111-1111-4111-8111-000000000e03'
const C4 = '11111111-1111-4111-8111-000000000e04'
const C5 = '11111111-1111-4111-8111-000000000e05'
const C6 = '11111111-1111-4111-8111-000000000e06'
const C7 = '11111111-1111-4111-8111-000000000e07'

/** 申请：A1/A2/A3=ACTIVE、A_HOLD=ON_HOLD、A_CLOSED=已 CLOSED（不得变）。 */
const A1 = '11111111-1111-4111-8111-000000000d01'
const A2 = '11111111-1111-4111-8111-000000000d02'
const A3 = '11111111-1111-4111-8111-000000000d03'
const A_HOLD = '11111111-1111-4111-8111-000000000d04'
const A_CLOSED = '11111111-1111-4111-8111-000000000d05'
/** 回滚反证岗位 JOB2 的申请。 */
const A2NEW = '11111111-1111-4111-8111-000000000d06'
/** 重放用例在关岗后新增的在途申请（replayed=true 仍须终止残留）。 */
const A_NEW = '11111111-1111-4111-8111-000000000d07'

/** 面试：I1/I2=SCHEDULED（→CANCELLED）、I3=POST_INTERVIEW（不动）、I4=CANCELLED（不动）、I5=IN_PROGRESS（不动）。 */
const I1 = '11111111-1111-4111-8111-000000000f01'
const I2 = '11111111-1111-4111-8111-000000000f02'
const I3 = '11111111-1111-4111-8111-000000000f03'
const I4 = '11111111-1111-4111-8111-000000000f04'
const I5 = '11111111-1111-4111-8111-000000000f05'
const I2NEW = '11111111-1111-4111-8111-000000000f06'
const I_NEW = '11111111-1111-4111-8111-000000000f07'

/** business_task：T1/T2/T3 未完成（→CANCELLED）、T4=SUCCEEDED、T5 引用别的岗位。 */
const T1 = '11111111-1111-4111-8111-000000001a01'
const T2 = '11111111-1111-4111-8111-000000001a02'
const T3 = '11111111-1111-4111-8111-000000001a03'
const T4 = '11111111-1111-4111-8111-000000001a04'
const T5 = '11111111-1111-4111-8111-000000001a05'
const T2NEW = '11111111-1111-4111-8111-000000001a06'
const T_NEW = '11111111-1111-4111-8111-000000001a07'
/** T3 的活跃执行尝试（CLAIMED，持有有效租约）。 */
const ATT3 = '11111111-1111-4111-8111-000000001b01'

/** 三个合法 session（`session-<uuid>` 形态；与浏览器 localStorage 同形）。 */
const SESSION_RECRUITER = 'session-11111111-1111-4111-8111-000000000001'
const SESSION_UNBOUND = 'session-22222222-2222-4222-8222-000000000002'
const SESSION_AGENT = 'session-33333333-3333-4333-8333-000000000003'
const SESSION_MISSING_ACTOR = 'session-44444444-4444-4444-8444-000000000004'

/** 集成测试底座配置（密码只从环境变量来；缺了 `testDatabaseConfig()` 直接抛）。 */
const BASE = testDatabaseConfig()

// ---------------------------------------------------------------------------
//  一次性库 + SQL 夹具
// ---------------------------------------------------------------------------

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let server: JobActionServer

/** 独立的 SQL 读回（连本用例的一次性库；不经过任何产品模块）。 */
async function query<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

/** 在一个显式事务里跑夹具（需要 `SET LOCAL recruitment.actor_id` 的状态迁移必须走这里）。 */
async function withTx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [ACTOR_103])
    const value = await fn(client)
    await client.query('commit')
    return value
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      // 保留第一个错误。
    }
    throw error
  } finally {
    client.release()
  }
}

/**
 * 造夹具：1 个 OPEN 岗位（+版本） + 5 条申请 + 5 场面试 + 5 条任务（含 RUNNING/attempt） +
 * 另一个岗位（scope 反证） + 一个 AGENT_WORKER（非 HUMAN 反证）。
 */
async function seedFixture(): Promise<void> {
  await query(
    `insert into recruitment.job (id, tenant_id, department_id, code, title, status)
     values ($1, $2, $3, 'JOBCLOSE-B-001', '关岗测试岗位（一次性库夹具）', 'OPEN'),
            ($4, $2, $3, 'JOBCLOSE-B-OTHER', '无关岗位（scope 反证）', 'OPEN'),
            ($5, $2, $3, 'JOBCLOSE-B-002', '回滚反证岗位', 'OPEN')`,
    [JOB, TENANT, DEMO_DEPARTMENT, OTHER_JOB, JOB2],
  )
  await query(
    `insert into recruitment.job_version (id, tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
     values ($1, $2, $3, 1, '关岗测试 JD（夹具）', $4, $5),
            ($6, $2, $7, 1, '回滚反证 JD（夹具）', $8, $5)`,
    [JOB_VERSION, TENANT, JOB, hex64('jobclose-jv-1'), ACTOR_103, JOB2_VERSION, JOB2, hex64('jobclose-jv-2')],
  )
  await query(
    `update recruitment.job set current_job_version_id = $2 where id = $1`,
    [JOB, JOB_VERSION],
  )
  await query(
    `update recruitment.job set current_job_version_id = $2 where id = $1`,
    [JOB2, JOB2_VERSION],
  )

  await query(
    `insert into recruitment.candidate (id, tenant_id, display_name)
     values ($1,$8,'关岗测试候选人-1'), ($2,$8,'关岗测试候选人-2'), ($3,$8,'关岗测试候选人-3'),
            ($4,$8,'关岗测试候选人-4'), ($5,$8,'关岗测试候选人-5'), ($6,$8,'关岗测试候选人-6'),
            ($7,$8,'关岗测试候选人-7')`,
    [C1, C2, C3, C4, C5, C6, C7, TENANT],
  )

  // 申请：3 ACTIVE + 1 ON_HOLD + 1 已 CLOSED（每个 ACTIVE 用不同候选人，避开部分唯一索引）。
  await query(
    `insert into recruitment.application
       (id, tenant_id, candidate_id, job_id, job_version_id, lifecycle_status, current_stage_code)
     values ($1,$6,$7,$8,$9,'ACTIVE','S7'),
            ($2,$6,$10,$8,$9,'ACTIVE','S8'),
            ($3,$6,$11,$8,$9,'ACTIVE','S7'),
            ($4,$6,$12,$8,$9,'ON_HOLD','S7'),
            ($5,$6,$13,$8,$9,'CLOSED','S10')`,
    [A1, A2, A3, A_HOLD, A_CLOSED, TENANT, C1, JOB, JOB_VERSION, C2, C3, C4, C5],
  )
  // 回滚反证岗位的在途申请。
  await query(
    `insert into recruitment.application
       (id, tenant_id, candidate_id, job_id, job_version_id, lifecycle_status, current_stage_code)
     values ($1,$2,$3,$4,$5,'ACTIVE','S7')`,
    [A2NEW, TENANT, C6, JOB2, JOB2_VERSION],
  )

  // 面试（`stage_code` 必须是 stage_catalog 的 S1..S12，否则 fk_interview_stage_catalog 会拦）。
  await query(
    `insert into recruitment.interview
       (id, tenant_id, application_id, round_no, slot_code, stage_code, status, scheduled_start_at, scheduled_end_at)
     values ($1,$7,$8,1,'DEFAULT','S8','SCHEDULED', now() + interval '1 day', now() + interval '1 day 1 hour'),
            ($2,$7,$9,1,'DEFAULT','S8','SCHEDULED', now() + interval '2 day', now() + interval '2 day 1 hour'),
            ($3,$7,$10,1,'DEFAULT','S8','POST_INTERVIEW', now() - interval '1 day', now() - interval '23 hour'),
            ($4,$7,$11,1,'DEFAULT','S8','CANCELLED', now() + interval '3 day', now() + interval '3 day 1 hour'),
            ($5,$7,$9,2,'DEFAULT','S8','IN_PROGRESS', now() - interval '2 hour', now() + interval '1 hour'),
            ($6,$7,$12,1,'DEFAULT','S8','SCHEDULED', now() + interval '4 day', now() + interval '4 day 1 hour')`,
    [I1, I2, I3, I4, I5, I2NEW, TENANT, A1, A2, A3, A_HOLD, A2NEW],
  )

  // business_task：两种 business_refs 元素形状都要覆盖（引擎 `type` 小写 / trace `kind` 大写）。
  // business_refs 在 JS 里造好再当 jsonb 参数传（不在 SQL 里拼字符串，避免 `|| '…'::jsonb` 的优先级坑）。
  const taskRows: { id: string; refs: Record<string, string>[]; title: string; key: string; status: string; completed: boolean }[] = [
    // 引擎适配层形状（`type` 小写）+ trace 形状（`kind` 大写）都要覆盖。
    { id: T1, refs: [{ type: 'application', id: A1 }, { kind: 'APPLICATION', id: A1 }], title: '关岗：申请级未完成任务', key: 'jobclose-b:t1', status: 'PENDING', completed: false },
    { id: T2, refs: [{ kind: 'JOB', id: JOB }, { type: 'job', id: JOB }], title: '关岗：岗位级未完成任务', key: 'jobclose-b:t2', status: 'READY', completed: false },
    { id: T3, refs: [{ type: 'interview', id: I1 }, { kind: 'INTERVIEW', id: I1 }], title: '关岗：面试级未完成任务（RUNNING）', key: 'jobclose-b:t3', status: 'PENDING', completed: false },
    { id: T4, refs: [{ kind: 'APPLICATION', id: A2 }], title: '关岗：已完成任务（不得变）', key: 'jobclose-b:t4', status: 'SUCCEEDED', completed: true },
    { id: T5, refs: [{ type: 'job', id: OTHER_JOB }], title: '关岗：别的岗位的任务（不在范围）', key: 'jobclose-b:t5', status: 'PENDING', completed: false },
    { id: T2NEW, refs: [{ type: 'application', id: A2NEW }], title: '回滚反证：未完成任务', key: 'jobclose-b:t2new', status: 'PENDING', completed: false },
  ]
  for (const row of taskRows) {
    await query(
      `insert into recruitment.business_task
         (id, tenant_id, task_type, business_refs, title, idempotency_key, status, completed_at)
       values ($1,$2,'TEST',$3::jsonb,$4,$5,$6, case when $7 then now() else null end)`,
      [row.id, TENANT, JSON.stringify(row.refs), row.title, row.key, row.status, row.completed],
    )
  }

  // RUNNING 必须有 current_attempt_id（ck_business_task_running）；先落 attempt，再改状态（走 GUC + fn_row_guard）。
  await query(
    `insert into recruitment.task_attempt
       (id, tenant_id, task_id, attempt_no, worker_type, worker_id, status, lease_expires_at)
     values ($1,$2,$3,1,'TEST_WORKER','worker-jobclose-b','CLAIMED', now() + interval '30 minute')`,
    [ATT3, TENANT, T3],
  )
  await withTx(async (client) => {
    await client.query(
      `update recruitment.business_task
          set status = 'RUNNING', current_attempt_id = $2
        where id = $1 and tenant_id = $3`,
      [T3, ATT3, TENANT],
    )
  })

  // 非 HUMAN actor（alias 映射到它 → 403 ACTOR_NOT_HUMAN）。
  await query(
    `insert into recruitment.actor (id, tenant_id, kind, display_name)
     values ($1,$2,'AGENT_WORKER','关岗测试-Agent Worker')`,
    [AGENT_ACTOR, TENANT],
  )
}

/** 夹具完整性自检（不拿"迁移跑通"当证据；只断言本用例真正依赖的行）。 */
async function assertFixtureIntegrity(): Promise<void> {
  const jobs = await query<{ id: string; status: string }>(
    'select id::text as id, status from recruitment.job where id = any($1::uuid[]) order by id',
    [[JOB, OTHER_JOB, JOB2]],
  )
  assert.deepEqual(jobs.map((row) => row.status), ['OPEN', 'OPEN', 'OPEN'], '夹具：三个岗位都必须是 OPEN')
  const apps = await query<{ status: string; n: number }>(
    `select lifecycle_status as status, count(*)::int as n
       from recruitment.application where tenant_id = $1 and job_id = $2
      group by 1 order by 1`,
    [TENANT, JOB],
  )
  assert.deepEqual(apps, [{ status: 'ACTIVE', n: 3 }, { status: 'CLOSED', n: 1 }, { status: 'ON_HOLD', n: 1 }])
  const interviews = await query<{ status: string; n: number }>(
    `select i.status, count(*)::int as n
       from recruitment.interview i
       join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
      where a.tenant_id = $1 and a.job_id = $2
      group by 1 order by 1`,
    [TENANT, JOB],
  )
  assert.deepEqual(interviews, [
    { status: 'CANCELLED', n: 1 },
    { status: 'IN_PROGRESS', n: 1 },
    { status: 'POST_INTERVIEW', n: 1 },
    { status: 'SCHEDULED', n: 2 },
  ])
  const tasks = await query<{ status: string; n: number }>(
    'select status, count(*)::int as n from recruitment.business_task where tenant_id = $1 group by 1 order by 1',
    [TENANT],
  )
  assert.deepEqual(tasks, [
    { status: 'PENDING', n: 3 },
    { status: 'READY', n: 1 },
    { status: 'RUNNING', n: 1 },
    { status: 'SUCCEEDED', n: 1 },
  ])
  const attempt = await query<{ status: string }>(
    'select status from recruitment.task_attempt where id = $1 and tenant_id = $2',
    [ATT3, TENANT],
  )
  assert.deepEqual(attempt.map((row) => row.status), ['CLAIMED'], '夹具：T3 必须有活跃 attempt')
}

before(async () => {
  db = await createIsolatedTestDatabase('jobclose')
  assertPrivateDatabase(db.name)
  cfg = { ...BASE, database: db.name }
  await seedFixture()
  await assertFixtureIntegrity()

  const created = createDemoActorIdentity()
  assert.deepEqual([...created.issues], [], '缺省 alias 映射不应有配置问题')
  identity = created.identity
  // 生产里这一步是浏览器 `PUT /recruitment/api/actor`（`http/actor.ts`）；本测试只测 job-action 路由，
  // 所以直接写**同一个**进程内 registry（`src/index.ts` 里两者共享该单例）。
  identity.registry.bind(SESSION_RECRUITER, 'recruiter', { display_name: '演示-HR 专员' })
  server = await startJobActionServer({ database: cfg, databaseIssues: [], identity })
})

after(async () => {
  if (server !== undefined) await server.close()
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------
//  真 HTTP harness（端口 0；模拟 webServer.register 收集 exact handler）
// ---------------------------------------------------------------------------

interface JobActionServer {
  readonly baseUrl: string
  readonly port: number
  readonly registered: readonly { kind: string; path: string }[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

/**
 * 起一个真 `node:http` server，并用 `registerJobActionHttp` 在其上注册路由。
 * 顺序是刻意的：先 listen（拿到真实端口），再把 `{host, port, register}` 传给路由
 * ——`sameOrigin` 用的就是这个端口。
 * @param deps - 路由依赖。
 */
async function startJobActionServer(deps: JobActionHttpDeps): Promise<JobActionServer> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const warnings: string[] = []
  const httpServer: Server = createServer((req, res) => {
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
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const address = httpServer.address() as AddressInfo
  const dispose = registerJobActionHttp(
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
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}

interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
  readonly headers: Headers
}

/** `httpCall` 的可选参数。 */
interface HttpCallOptions {
  readonly session?: string
  readonly body?: unknown
  readonly rawBody?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly contentType?: string
  readonly omitRequestHeader?: boolean
}

/**
 * 发一次同源请求（默认带 `x-recruitment-request: 1` 与 `X-DSH-Session`）。
 * @param options - session / body / 原始 body / 覆盖头 / 是否省略同源头。
 */
async function httpCall(
  target: Pick<JobActionServer, 'baseUrl'>,
  method: string,
  path: string,
  options: HttpCallOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.omitRequestHeader !== true) headers['x-recruitment-request'] = '1'
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.rawBody !== undefined) {
    headers['content-type'] = options.contentType ?? 'application/json'
    payload = options.rawBody
  } else if (options.body !== undefined) {
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

/** 主用例的合法 body（`confirm` 严格 true）。 */
function closeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { job_id: JOB, confirm: true, ...overrides }
}

// ---------------------------------------------------------------------------
//  独立 SQL 状态快照（拒绝路径的"零写入"判据：行数 + record_version + 事件 全等）
// ---------------------------------------------------------------------------

/**
 * 租户内**全部**执行/业务表的状态快照。
 * 拒绝路径必须让快照前后完全相等（行数、record_version、completed/ended 标记、事件直方图）。
 */
async function snapshotAll(): Promise<Record<string, unknown>> {
  const [jobs, applications, interviews, tasks, attempts, counts, eventTypes] = await Promise.all([
    query('select id::text as id, status, record_version from recruitment.job where tenant_id = $1 order by id', [TENANT]),
    query(`select id::text as id, job_id::text as job_id, lifecycle_status as status, record_version
             from recruitment.application where tenant_id = $1 order by id`, [TENANT]),
    query(`select id::text as id, status, record_version from recruitment.interview
            where tenant_id = $1 order by id`, [TENANT]),
    query(`select id::text as id, status, record_version, (completed_at is not null) as completed
             from recruitment.business_task where tenant_id = $1 order by id`, [TENANT]),
    query(`select id::text as id, status, record_version, (ended_at is not null) as ended
             from recruitment.task_attempt where tenant_id = $1 order by id`, [TENANT]),
    query(`select
             (select count(*)::int from recruitment.decision) as decision_rows,
             (select count(*)::int from recruitment.durable_effect) as durable_effect_rows,
             (select count(*)::int from recruitment.event_inbox) as event_inbox_rows,
             (select count(*)::int from recruitment.engine_effect) as engine_effect_rows,
             (select count(*)::int from recruitment.engine_outbox) as engine_outbox_rows,
             (select count(*)::int from recruitment.engine_ticket) as engine_ticket_rows,
             (select count(*)::int from recruitment.engine_kv) as engine_kv_rows`, []),
    query('select event_type, count(*)::int as n from recruitment.event_inbox group by 1 order by 1', []),
  ])
  return { jobs, applications, interviews, tasks, attempts, counts: counts[0], eventTypes }
}

/** 拒绝路径断言：整库快照前后完全一致（零写入）。 */
function assertNoWrite(before: unknown, after: unknown, label: string): void {
  assert.deepEqual(after, before, `${label}：拒绝路径必须零写入（行数 / record_version / 事件全等）`)
}

/** 一次 `select ...` 取单个对象（缺行直接失败）。 */
async function stateOf(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>> {
  const rows = await query<Record<string, unknown>>(sql, params)
  assert.equal(rows.length, 1, `期望恰好 1 行：${sql.slice(0, 80)}`)
  return rows[0] as Record<string, unknown>
}

/** 把 timestamptz 的读回值（Date 或 ISO 文本）规范成 ISO 字符串（`String(Date)` 会丢毫秒）。 */
function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

/** 岗位行状态。 */
function jobRow(id: string): Promise<Record<string, unknown>> {
  return stateOf(
    `select status, record_version, status_changed_by_actor_id::text as status_changed_by_actor_id,
            status_source_event_id::text as status_source_event_id, status_changed_at
       from recruitment.job where id = $1 and tenant_id = $2`,
    [id, TENANT],
  )
}

/** 表内状态 + record_version（按 id 聚成对象，便于整对象 deepEqual）。 */
async function idStatusVersions(sql: string, params: readonly unknown[]): Promise<Record<string, { status: string; record_version: number }>> {
  const rows = await query<{ id: string; status: string; record_version: number }>(sql, params)
  const map: Record<string, { status: string; record_version: number }> = {}
  for (const row of rows) map[row.id] = { status: row.status, record_version: row.record_version }
  return map
}

// ---------------------------------------------------------------------------
//  用例 1：路由注册 / fail-closed（非回环不注册、未配置 503、方法 405）
// ---------------------------------------------------------------------------

test('用例1：只注册三条 exact 路由（draft/create/close）；非回环不注册并告警；DB 未配置 → 503；GET → 405（全部零写入）', async () => {
  assert.deepEqual(
    server.registered.map((route) => `${route.kind} ${route.path}`),
    [`exact ${JOB_DRAFT_PATH}`, `exact ${JOB_CREATE_PATH}`, `exact ${JOB_CLOSE_PATH}`],
    'job-action 前缀下只允许这三条 exact 路由（task-57 的 draft/create + task-51 的 close）',
  )
  assert.equal(JOB_CLOSE_PATH, '/recruitment/api/job-action/job/close', '路径是契约（CONTRACT §1）')

  // ---- 非回环 host：不注册任何路由 + 告警（fail-closed）----
  const warnings: string[] = []
  let registeredCount = 0
  const dispose = registerJobActionHttp(
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

  // ---- DB 未配置 → 503 NOT_CONFIGURED（不假装成功）----
  const unconfigured = await startJobActionServer({
    database: null,
    databaseIssues: ['config.database.host is required'],
    identity,
  })
  const before503 = await snapshotAll()
  try {
    const denied = await httpCall(unconfigured, 'POST', JOB_CLOSE_PATH, {
      session: SESSION_RECRUITER,
      body: closeBody(),
    })
    assertHttpError(denied, 503, 'NOT_CONFIGURED', 'NOT_CONFIGURED')
    const error = denied.body.error as Record<string, unknown>
    assert.deepEqual((error.detail as Record<string, unknown>).issues, ['config.database.host is required'])
  } finally {
    await unconfigured.close()
  }
  assertNoWrite(before503, await snapshotAll(), '503 NOT_CONFIGURED')

  // ---- 方法不对 → 405 + allow: POST ----
  const method = await httpCall(server, 'GET', JOB_CLOSE_PATH, { session: SESSION_RECRUITER })
  assert.equal(method.status, 405, method.text)
  assert.equal(method.headers.get('allow'), 'POST')
})

// ---------------------------------------------------------------------------
//  用例 2：人类闸门 —— `confirm` 必须严格 === true，否则 400 CONFIRM_REQUIRED 且零写入
// ---------------------------------------------------------------------------

test('用例2：confirm 缺失/false/"true"/1 → 400 CONFIRM_REQUIRED，零写入（岗位仍 OPEN）', async () => {
  const cases: { label: string; body: Record<string, unknown> }[] = [
    { label: '缺失', body: { job_id: JOB } },
    { label: 'false', body: { job_id: JOB, confirm: false } },
    { label: '字符串 "true"', body: { job_id: JOB, confirm: 'true' } },
    { label: '数字 1', body: { job_id: JOB, confirm: 1 } },
  ]
  for (const item of cases) {
    const before = await snapshotAll()
    const result = await httpCall(server, 'POST', JOB_CLOSE_PATH, { session: SESSION_RECRUITER, body: item.body })
    assertHttpError(result, 400, 'INVALID_ARGS', 'CONFIRM_REQUIRED')
    assertNoWrite(before, await snapshotAll(), `confirm=${item.label}`)
  }
  // 岗位仍是 OPEN（闸门确实拦在写之前）
  assert.equal((await jobRow(JOB)).status, 'OPEN', '未确认不得关岗')
  // 三个数：没有产生任何 job.closed 事件
  const jobClosedEvents = await query<{ n: number }>(
    "select count(*)::int as n from recruitment.event_inbox where event_type = 'job.closed'",
  )
  assert.equal(jobClosedEvents[0]?.n, 0, '未确认不得落 job.closed 事件')
})

// ---------------------------------------------------------------------------
//  用例 3：身份 / 同源 / body 封闭键 / job_id 形状（全部 4xx + 零写入）
// ---------------------------------------------------------------------------

test('用例3：未知键 / 覆盖键 / session / 同源 / job_id / reason / JSON 形状 → 4xx 且零写入', async () => {
  type Case = HttpCallOptions & { label: string; pathSuffix?: string; status: number; code: string; reason?: string }
  const cases: Case[] = [
    // body 封闭键集
    { label: '未知 body 键', session: SESSION_RECRUITER, body: closeBody({ bogus: 1 }), status: 400, code: 'INVALID_ARGS', reason: 'UNKNOWN_BODY_KEY' },
    { label: 'body.actor_id 覆盖', session: SESSION_RECRUITER, body: closeBody({ actor_id: ACTOR_103 }), status: 400, code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
    { label: 'body.tenant_id 覆盖', session: SESSION_RECRUITER, body: closeBody({ tenant_id: TENANT }), status: 400, code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
    { label: 'header x-recruitment-actor 覆盖', session: SESSION_RECRUITER, body: closeBody(), headers: { 'x-recruitment-actor': ACTOR_103 }, status: 400, code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
    { label: 'header x-recruitment-tenant 覆盖', session: SESSION_RECRUITER, body: closeBody(), headers: { 'x-recruitment-tenant': TENANT }, status: 400, code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
    { label: 'query.tenant_id 覆盖', session: SESSION_RECRUITER, body: closeBody(), pathSuffix: `?tenant_id=${TENANT}`, status: 400, code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
    // 身份
    { label: '缺 x-dsh-session', body: closeBody(), status: 400, code: 'INVALID_ARGS', reason: 'SESSION_REQUIRED' },
    { label: 'x-dsh-session 形态非法', session: 'not-a-session', body: closeBody(), status: 400, code: 'INVALID_ARGS', reason: 'SESSION_ID_INVALID' },
    { label: 'session 未绑定 alias', session: SESSION_UNBOUND, body: closeBody(), status: 409, code: 'DEMO_ACTOR_UNMAPPED', reason: 'SESSION_NOT_BOUND' },
    // 同源
    { label: '缺 x-recruitment-request', session: SESSION_RECRUITER, body: closeBody(), omitRequestHeader: true, status: 403, code: 'FORBIDDEN', reason: 'SAME_ORIGIN_REQUIRED' },
    { label: '跨源 Origin', session: SESSION_RECRUITER, body: closeBody(), headers: { origin: 'http://evil.example' }, status: 403, code: 'FORBIDDEN', reason: 'SAME_ORIGIN_REQUIRED' },
    // job_id 形状
    { label: '缺 job_id', session: SESSION_RECRUITER, body: { confirm: true }, status: 400, code: 'INVALID_ARGS', reason: 'JOB_ID_INVALID' },
    { label: 'job_id 非 UUID', session: SESSION_RECRUITER, body: { job_id: 'not-a-uuid', confirm: true }, status: 400, code: 'INVALID_ARGS', reason: 'JOB_ID_INVALID' },
    { label: 'job_id 不存在', session: SESSION_RECRUITER, body: { job_id: '11111111-1111-4111-8111-00000000dead', confirm: true }, status: 404, code: 'NOT_FOUND', reason: 'JOB_NOT_FOUND' },
    // reason
    { label: 'reason 空串', session: SESSION_RECRUITER, body: closeBody({ reason: '   ' }), status: 400, code: 'INVALID_ARGS', reason: 'REASON_INVALID' },
    { label: 'reason 超 500', session: SESSION_RECRUITER, body: closeBody({ reason: 'x'.repeat(501) }), status: 400, code: 'INVALID_ARGS', reason: 'REASON_INVALID' },
    { label: 'reason 非字符串', session: SESSION_RECRUITER, body: closeBody({ reason: 42 }), status: 400, code: 'INVALID_ARGS', reason: 'REASON_INVALID' },
    // body 形状
    { label: '非法 JSON', session: SESSION_RECRUITER, rawBody: '{"job_id":', status: 400, code: 'INVALID_ARGS', reason: 'INVALID_JSON' },
    { label: 'body 是数组', session: SESSION_RECRUITER, rawBody: '[]', status: 400, code: 'INVALID_ARGS', reason: 'TYPE_MISMATCH' },
    { label: 'content-type 不是 JSON', session: SESSION_RECRUITER, body: closeBody(), contentType: 'text/plain', status: 415, code: 'INVALID_ARGS', reason: 'UNSUPPORTED_MEDIA_TYPE' },
  ]
  for (const item of cases) {
    const before = await snapshotAll()
    const path = `${JOB_CLOSE_PATH}${item.pathSuffix ?? ''}`
    const result = await httpCall(server, 'POST', path, item)
    assertHttpError(result, item.status, item.code, item.reason)
    assertNoWrite(before, await snapshotAll(), item.label)
  }
  assert.equal((await jobRow(JOB)).status, 'OPEN', '全部拒绝路径之后岗位仍 OPEN')
})

// ---------------------------------------------------------------------------
//  用例 4：非 HUMAN（403 ACTOR_NOT_HUMAN）/ alias 映射的 actor 行缺失（409）
// ---------------------------------------------------------------------------

test('用例4：非 HUMAN actor → 403 ACTOR_NOT_HUMAN；actor 行缺失 → 409 ACTOR_ROW_MISSING（均零写入）', async () => {
  // ---- 非 HUMAN：库里真实存在的 AGENT_WORKER，alias 映射到它（registry 直接绑定，模拟浏览器 PUT 之后的状态）----
  const agentIdentity = createDemoActorIdentity({ recruiter: AGENT_ACTOR }).identity
  agentIdentity.registry.bind(SESSION_AGENT, 'recruiter', { display_name: '关岗测试-Agent Worker' })
  const agentServer = await startJobActionServer({ database: cfg, databaseIssues: [], identity: agentIdentity })
  try {
    const before = await snapshotAll()
    const denied = await httpCall(agentServer, 'POST', JOB_CLOSE_PATH, { session: SESSION_AGENT, body: closeBody() })
    assertHttpError(denied, 403, 'FORBIDDEN', 'ACTOR_NOT_HUMAN')
    const detail = (denied.body.error as Record<string, unknown>).detail as Record<string, unknown>
    assert.equal(detail.kind, 'AGENT_WORKER', '403 的 detail 必须回写真实 kind（可判）')
    assertNoWrite(before, await snapshotAll(), 'AGENT_WORKER 关岗')
  } finally {
    await agentServer.close()
  }

  // ---- actor 行缺失：alias 映射到库里不存在的 UUID → 409（fail-closed，不回退 config.actor_id）----
  const missingIdentity = createDemoActorIdentity({ recruiter: MISSING_ACTOR }).identity
  missingIdentity.registry.bind(SESSION_MISSING_ACTOR, 'recruiter', { display_name: 'missing' })
  const missingServer = await startJobActionServer({ database: cfg, databaseIssues: [], identity: missingIdentity })
  try {
    const before = await snapshotAll()
    const denied = await httpCall(missingServer, 'POST', JOB_CLOSE_PATH, { session: SESSION_MISSING_ACTOR, body: closeBody() })
    assertHttpError(denied, 409, 'DEMO_ACTOR_UNMAPPED', 'ACTOR_ROW_MISSING')
    assertNoWrite(before, await snapshotAll(), 'actor 行缺失')
  } finally {
    await missingServer.close()
  }
})

// ---------------------------------------------------------------------------
//  用例 5：主用例 —— 一个事务原子终止在途；响应计数 + 独立 SQL 读回双向断言
// ---------------------------------------------------------------------------

test('用例5：POST job/close → 200；job→CLOSED、4 在途申请→CLOSED、2 未开始面试→CANCELLED、3 任务→CANCELLED(+1 attempt)，事件齐全', async () => {
  // ---- 基线（独立 SQL；不假设任何 record_version）----
  const jobBefore = await jobRow(JOB)
  const appsBefore = await idStatusVersions(
    'select id::text as id, lifecycle_status as status, record_version from recruitment.application where tenant_id = $1 and job_id = $2',
    [TENANT, JOB],
  )
  const interviewsBefore = await idStatusVersions(
    `select i.id::text as id, i.status, i.record_version
       from recruitment.interview i
       join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
      where a.tenant_id = $1 and a.job_id = $2`,
    [TENANT, JOB],
  )
  const tasksBefore = await idStatusVersions(
    'select id::text as id, status, record_version from recruitment.business_task where id = any($1::uuid[])',
    [[T1, T2, T3, T4, T5]],
  )
  const attemptBefore = await stateOf(
    'select status, record_version, (ended_at is not null) as ended from recruitment.task_attempt where id = $1',
    [ATT3],
  )
  const otherJobBefore = await jobRow(OTHER_JOB)
  assert.deepEqual(Object.values(appsBefore).map((row) => row.status).sort(), ['ACTIVE', 'ACTIVE', 'ACTIVE', 'CLOSED', 'ON_HOLD'])
  assert.deepEqual(Object.values(interviewsBefore).map((row) => row.status).sort(), ['CANCELLED', 'IN_PROGRESS', 'POST_INTERVIEW', 'SCHEDULED', 'SCHEDULED'])
  assert.equal(jobBefore.status, 'OPEN')

  // 事件基线：用数据库时钟括起来（主用例写入的事件必须落在 bracket 之后）
  const bracket = (await query<{ t: Date }>('select clock_timestamp() as t'))[0]!.t

  // ---- 唯一一次真实的关岗调用（reason 只进内部审计事件）----
  const reason = '业务收缩：该岗位已停止招聘（jobclose 集成测试）'
  const result = await httpCall(server, 'POST', JOB_CLOSE_PATH, {
    session: SESSION_RECRUITER,
    body: { job_id: JOB, confirm: true, reason },
  })
  assert.equal(result.status, 200, result.text)

  // ---- 响应精确键集 + 精确值（CONTRACT §1）----
  assert.deepEqual(Object.keys(result.body).sort(), ['actor', 'contract_version', 'job', 'replayed', 'terminated'])
  assert.equal(result.body.contract_version, '1.0.0')
  assert.equal(result.body.replayed, false)
  assert.deepEqual(Object.keys(result.body.terminated as Record<string, unknown>).sort(), [
    'applications_already_closed', 'applications_closed', 'applications_total',
    'interviews_already_terminal', 'interviews_cancelled', 'interviews_occurred_kept',
    'task_attempts_cancelled', 'tasks_cancelled',
  ])
  const expectedTerminated = {
    applications_total: 4,
    applications_closed: 4,
    applications_already_closed: 1,
    interviews_cancelled: 2,
    interviews_already_terminal: 1,
    interviews_occurred_kept: 2,
    tasks_cancelled: 3,
    task_attempts_cancelled: 1,
  }
  assert.deepEqual(result.body.terminated, expectedTerminated, '终止计数必须精确（不接受"至少"）')
  assert.deepEqual(result.body.actor, { actor_id: ACTOR_103, alias: 'recruiter', display_name: '演示-HR 专员' })

  // 响应 job 字段 = 事务提交后的读回（不是请求回显）
  const jobAfter = await jobRow(JOB)
  assert.equal(jobAfter.status, 'CLOSED')
  assert.equal(jobAfter.record_version, Number(jobBefore.record_version) + 1, '关岗只允许 record_version +1')
  assert.equal(jobAfter.status_changed_by_actor_id, ACTOR_103, '作者必须是确认人（recruiter=103）')
  assert.ok(jobAfter.status_source_event_id !== null, '状态迁移必须挂内部事件 id')
  assert.notEqual(
    new Date(isoOf(jobAfter.status_changed_at)).getTime(),
    new Date(isoOf(jobBefore.status_changed_at)).getTime(),
    'status_changed_at 必须推进',
  )
  const responseJob = result.body.job as Record<string, unknown>
  assert.deepEqual(Object.keys(responseJob).sort(), ['job_id', 'record_version', 'status', 'status_changed_at', 'status_changed_by_actor_id'])
  assert.equal(responseJob.job_id, JOB)
  assert.equal(responseJob.status, 'CLOSED')
  assert.equal(responseJob.record_version, jobAfter.record_version)
  assert.equal(responseJob.status_changed_by_actor_id, ACTOR_103)
  assert.equal(
    new Date(isoOf(responseJob.status_changed_at)).getTime(),
    new Date(isoOf(jobAfter.status_changed_at)).getTime(),
    '响应 status_changed_at 必须等于库里的值（读回，不是本地时间）',
  )

  // ---- 独立 SQL 读回：申请（4 在途 → CLOSED 且 +1；原 CLOSED 不动）----
  const appsAfter = await idStatusVersions(
    'select id::text as id, lifecycle_status as status, record_version from recruitment.application where tenant_id = $1 and job_id = $2',
    [TENANT, JOB],
  )
  for (const id of [A1, A2, A3, A_HOLD]) {
    assert.equal(appsAfter[id]?.status, 'CLOSED', `申请 ${id} 必须终止为 CLOSED`)
    assert.equal(appsAfter[id]?.record_version, appsBefore[id]!.record_version + 1, `申请 ${id} 必须 record_version +1`)
  }
  assert.deepEqual(appsAfter[A_CLOSED], appsBefore[A_CLOSED], '既有 CLOSED 申请不得被改写（历史保留）')
  const inFlightLeft = await query<{ n: number }>(
    `select count(*)::int as n from recruitment.application
      where tenant_id = $1 and job_id = $2 and lifecycle_status in ('ACTIVE','ON_HOLD')`,
    [TENANT, JOB],
  )
  assert.equal(inFlightLeft[0]?.n, 0, '关岗后不得残留 ACTIVE/ON_HOLD')

  // ---- 独立 SQL 读回：面试（2 SCHEDULED → CANCELLED；POST_INTERVIEW/IN_PROGRESS/CANCELLED 一律不动）----
  const interviewsAfter = await idStatusVersions(
    `select i.id::text as id, i.status, i.record_version
       from recruitment.interview i
       join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
      where a.tenant_id = $1 and a.job_id = $2`,
    [TENANT, JOB],
  )
  for (const id of [I1, I2]) {
    assert.equal(interviewsAfter[id]?.status, 'CANCELLED', `未开始面试 ${id} 必须取消`)
    assert.equal(interviewsAfter[id]?.record_version, interviewsBefore[id]!.record_version + 1)
  }
  for (const id of [I3, I5, I4]) {
    assert.deepEqual(interviewsAfter[id], interviewsBefore[id], `面试 ${id} 不得被改写（已发生/终态照样保留）`)
  }

  // ---- 独立 SQL 读回：任务（3 未完成 → CANCELLED + completed_at；SUCCEEDED / 别的岗位不动）----
  const tasksAfter = await query<{ id: string; status: string; record_version: number; completed: boolean }>(
    'select id::text as id, status, record_version, (completed_at is not null) as completed from recruitment.business_task where id = any($1::uuid[]) order by id',
    [[T1, T2, T3, T4, T5]],
  )
  const taskMap = new Map(tasksAfter.map((row) => [row.id, row]))
  for (const id of [T1, T2, T3]) {
    assert.equal(taskMap.get(id)?.status, 'CANCELLED', `任务 ${id} 必须被取消`)
    assert.equal(taskMap.get(id)?.completed, true, `任务 ${id} 必须落 completed_at`)
    assert.equal(taskMap.get(id)?.record_version, tasksBefore[id]!.record_version + 1)
  }
  assert.deepEqual(
    { status: taskMap.get(T4)?.status, record_version: taskMap.get(T4)?.record_version },
    tasksBefore[T4],
    'SUCCEEDED 任务不得被改写',
  )
  assert.deepEqual(
    { status: taskMap.get(T5)?.status, record_version: taskMap.get(T5)?.record_version },
    tasksBefore[T5],
    '引用别的岗位的任务不在 scope（不得误伤）',
  )
  assert.deepEqual(await jobRow(OTHER_JOB), otherJobBefore, '无关岗位不得被改写')

  // ---- 独立 SQL 读回：task_attempt（活跃 → CANCELLED + ended_at）----
  const attemptAfter = await stateOf(
    'select status, record_version, (ended_at is not null) as ended from recruitment.task_attempt where id = $1',
    [ATT3],
  )
  assert.equal(attemptAfter.status, 'CANCELLED')
  assert.equal(attemptAfter.ended, true, '取消 attempt 必须落 ended_at（释放有效租约）')
  assert.equal(attemptAfter.record_version, Number(attemptBefore.record_version) + 1)

  // ---- 不写 decision / 不删行 / 不动 durable_effect / engine_* ----
  const invariants = await query<Record<string, number>>(
    `select
       (select count(*)::int from recruitment.decision where tenant_id = $1) as decision_rows,
       (select count(*)::int from recruitment.application where tenant_id = $1) as application_rows,
       (select count(*)::int from recruitment.interview where tenant_id = $1) as interview_rows,
       (select count(*)::int from recruitment.business_task where tenant_id = $1) as business_task_rows,
       (select count(*)::int from recruitment.task_attempt where tenant_id = $1) as task_attempt_rows,
       (select count(*)::int from recruitment.durable_effect) as durable_effect_rows,
       (select count(*)::int from recruitment.engine_effect) as engine_effect_rows,
       (select count(*)::int from recruitment.engine_outbox) as engine_outbox_rows,
       (select count(*)::int from recruitment.engine_ticket) as engine_ticket_rows,
       (select count(*)::int from recruitment.engine_kv) as engine_kv_rows`,
    [TENANT],
  )
  assert.deepEqual(invariants[0], {
    decision_rows: 0,
    application_rows: 7,
    interview_rows: 6,
    business_task_rows: 6,
    task_attempt_rows: 1,
    durable_effect_rows: 0,
    engine_effect_rows: 0,
    engine_outbox_rows: 0,
    engine_ticket_rows: 0,
    engine_kv_rows: 0,
  }, '关岗不得写 decision / 删行 / 动 durable_effect 与 engine_*')

  // ---- 审计事件：fn_row_guard 自动写的内部事件 + 一条动作级 job.closed ----
  const events = await query<{ event_type: string; provider: string; trust_level: string; idempotency_key: string; source_object_id: string | null; payload: Record<string, unknown> }>(
    `select event_type, provider, trust_level, idempotency_key, source_object_id, payload
       from recruitment.event_inbox where recorded_at >= $1 order by event_type, event_id`,
    [bracket],
  )
  const eventsByType = new Map<string, typeof events>()
  for (const event of events) {
    const list = eventsByType.get(event.event_type) ?? []
    list.push(event)
    eventsByType.set(event.event_type, list)
  }
  assert.deepEqual(
    [...eventsByType.entries()].map(([type, list]) => `${type}:${list.length}`).sort(),
    [
      'application.lifecycle_status.changed:4',
      'business_task.status.changed:3',
      'interview.status.changed:2',
      'job.closed:1',
      'job.status.changed:1',
      'task_attempt.status.changed:1',
    ],
    '本事务必须恰好写 12 条内部事件（1 动作级 + 11 状态迁移）',
  )
  assert.equal(events.length, 12)

  // job.status.changed
  const jobEvents = eventsByType.get('job.status.changed') ?? []
  assert.equal(jobEvents.length, 1)
  assert.equal(jobEvents[0]!.payload.table, 'job')
  assert.equal(jobEvents[0]!.payload.record_id, JOB)
  assert.equal(jobEvents[0]!.payload.from, 'OPEN')
  assert.equal(jobEvents[0]!.payload.to, 'CLOSED')
  assert.equal(jobEvents[0]!.payload.actor_id, ACTOR_103)
  assert.equal(jobEvents[0]!.provider, 'internal')
  assert.equal(jobEvents[0]!.trust_level, 'INTERNAL')

  // application.lifecycle_status.changed（4 条，from/to/actor 正确）
  const appEvents = eventsByType.get('application.lifecycle_status.changed') ?? []
  assert.deepEqual(
    appEvents.map((event) => `${String(event.payload.record_id)}:${String(event.payload.from)}→${String(event.payload.to)}:${String(event.payload.actor_id)}`).sort(),
    [
      `${A1}:ACTIVE→CLOSED:${ACTOR_103}`,
      `${A2}:ACTIVE→CLOSED:${ACTOR_103}`,
      `${A3}:ACTIVE→CLOSED:${ACTOR_103}`,
      `${A_HOLD}:ON_HOLD→CLOSED:${ACTOR_103}`,
    ].sort(),
  )
  // interview.status.changed（2 条 SCHEDULED→CANCELLED）
  const interviewEvents = eventsByType.get('interview.status.changed') ?? []
  assert.deepEqual(
    interviewEvents.map((event) => `${String(event.payload.record_id)}:${String(event.payload.from)}→${String(event.payload.to)}`).sort(),
    [`${I1}:SCHEDULED→CANCELLED`, `${I2}:SCHEDULED→CANCELLED`].sort(),
  )
  // business_task.status.changed（3 条；T3 从 RUNNING 取消）
  const taskEvents = eventsByType.get('business_task.status.changed') ?? []
  assert.deepEqual(
    taskEvents.map((event) => `${String(event.payload.record_id)}:${String(event.payload.from)}→${String(event.payload.to)}`).sort(),
    [
      `${T1}:PENDING→CANCELLED`,
      `${T2}:READY→CANCELLED`,
      `${T3}:RUNNING→CANCELLED`,
    ].sort(),
  )
  // task_attempt.status.changed（1 条 CLAIMED→CANCELLED）
  const attemptEvents = eventsByType.get('task_attempt.status.changed') ?? []
  assert.deepEqual(
    attemptEvents.map((event) => `${String(event.payload.record_id)}:${String(event.payload.from)}→${String(event.payload.to)}`),
    [`${ATT3}:CLAIMED→CANCELLED`],
  )

  // 动作级 job.closed：幂等键 = job-close:<job_id>:<record_version_after>
  const jobClosedEvents = eventsByType.get('job.closed') ?? []
  assert.equal(jobClosedEvents.length, 1, '恰好一条动作级 job.closed 事件')
  const jobClosed = jobClosedEvents[0]!
  assert.equal(jobClosed.idempotency_key, `job-close:${JOB}:${jobAfter.record_version}`)
  assert.equal(jobClosed.source_object_id, JOB)
  assert.equal(jobClosed.provider, 'internal')
  assert.equal(jobClosed.trust_level, 'INTERNAL')
  assert.equal(jobClosed.payload.job_id, JOB)
  assert.equal(jobClosed.payload.reason, reason)
  assert.equal(jobClosed.payload.actor_id, ACTOR_103)
  assert.equal(jobClosed.payload.alias, 'recruiter')
  assert.equal(jobClosed.payload.replayed, false)
  assert.deepEqual(jobClosed.payload.terminated, expectedTerminated, '动作级事件的终止计数必须与响应一致')

  // 证据行（`node --test` 会把它留在输出里，B-REPORT 直接引用；内容是**提交后的 SQL 读回**）
  console.log('[EVIDENCE job/close 主用例 SQL 读回] ' + JSON.stringify({
    job: {
      status: jobAfter.status,
      record_version: jobAfter.record_version,
      status_changed_by_actor_id: jobAfter.status_changed_by_actor_id,
      status_source_event_id: jobAfter.status_source_event_id,
    },
    applications: appsAfter,
    interviews: interviewsAfter,
    tasks: Object.fromEntries(tasksAfter.map((row) => [row.id, { status: row.status, record_version: row.record_version, completed: row.completed }])),
    attempt: attemptAfter,
    events: [...eventsByType.entries()].map(([type, list]) => `${type}:${list.length}`).sort(),
    job_closed_event: { idempotency_key: jobClosed.idempotency_key, source_object_id: jobClosed.source_object_id, payload_terminated: jobClosed.payload.terminated },
  }))
})

// ---------------------------------------------------------------------------
//  用例 6：事务原子性 —— 动作级事件写失败 → 整笔回滚（岗位/申请/面试/任务零变化）
// ---------------------------------------------------------------------------

test('用例6：job.closed 事件写失败 → 整笔事务回滚（JOB2 仍 OPEN、在途仍 ACTIVE、无新事件），去掉故障后同样可关', async () => {
  const job2Before = await jobRow(JOB2)
  const app2Before = await stateOf(
    'select lifecycle_status as status, record_version from recruitment.application where id = $1',
    [A2NEW],
  )
  const interview2Before = await stateOf('select status, record_version from recruitment.interview where id = $1', [I2NEW])
  const task2Before = await stateOf(
    'select status, record_version, (completed_at is not null) as completed from recruitment.business_task where id = $1',
    [T2NEW],
  )
  const eventsBefore = await query<{ n: number }>('select count(*)::int as n from recruitment.event_inbox')

  // ---- 故障注入：任何 event_type='job.closed' 的插入都抛（模拟"审计写失败"）----
  await query(`create or replace function recruitment.fn_test_fail_job_closed() returns trigger
               language plpgsql as $$
               begin
                 if new.event_type = 'job.closed' then
                   raise exception 'FAULT_INJECTION_JOB_CLOSED_EVENT';
                 end if;
                 return new;
               end $$`)
  await query(`create trigger trg_test_fail_job_closed before insert on recruitment.event_inbox
               for each row execute function recruitment.fn_test_fail_job_closed()`)
  try {
    const failed = await httpCall(server, 'POST', JOB_CLOSE_PATH, {
      session: SESSION_RECRUITER,
      body: { job_id: JOB2, confirm: true },
    })
    assert.equal(failed.status, 500, `故障注入下必须是 500：${failed.text}`)
    const error = failed.body.error as Record<string, unknown>
    assert.match(String(error.message), /FAULT_INJECTION_JOB_CLOSED_EVENT/, '错误必须来自注入的审计失败')
  } finally {
    await query('drop trigger if exists trg_test_fail_job_closed on recruitment.event_inbox')
    await query('drop function if exists recruitment.fn_test_fail_job_closed()')
  }

  // ---- 独立 SQL：整笔回滚（一行都没变）----
  assert.deepEqual(await jobRow(JOB2), job2Before, '审计失败 → 岗位状态/版本必须回滚')
  assert.deepEqual(await stateOf('select lifecycle_status as status, record_version from recruitment.application where id = $1', [A2NEW]), app2Before)
  assert.deepEqual(await stateOf('select status, record_version from recruitment.interview where id = $1', [I2NEW]), interview2Before)
  assert.deepEqual(
    await stateOf('select status, record_version, (completed_at is not null) as completed from recruitment.business_task where id = $1', [T2NEW]),
    task2Before,
  )
  assert.deepEqual(await query<{ n: number }>('select count(*)::int as n from recruitment.event_inbox'), eventsBefore, '回滚后不得留下任何事件')
  const leaked = await query<{ n: number }>("select count(*)::int as n from recruitment.event_inbox where event_type = 'job.closed' and source_object_id = $1", [JOB2])
  assert.equal(leaked[0]?.n, 0, '失败的关闭不得留下 job.closed 事件')

  // ---- 去掉故障后同一个岗位可以正常关闭（证明失败原因就是注入的审计写失败）----
  const ok = await httpCall(server, 'POST', JOB_CLOSE_PATH, {
    session: SESSION_RECRUITER,
    body: { job_id: JOB2, confirm: true, reason: '回滚反证后重试' },
  })
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(ok.body.terminated, {
    applications_total: 1,
    applications_closed: 1,
    applications_already_closed: 0,
    interviews_cancelled: 1,
    interviews_already_terminal: 0,
    interviews_occurred_kept: 0,
    tasks_cancelled: 1,
    task_attempts_cancelled: 0,
  })
  assert.equal((await jobRow(JOB2)).status, 'CLOSED')
})

// ---------------------------------------------------------------------------
//  用例 7：幂等重放 —— 已 CLOSED → 200 replayed=true、job.record_version 不再变、终态行不再变
// ---------------------------------------------------------------------------

test('用例7：重放 → 200 replayed=true，job.record_version 不再变、终态行不再变、不重复落 job.closed；残留仍被终止', async () => {
  const jobClosed = await jobRow(JOB)
  const appsClosed = await idStatusVersions(
    'select id::text as id, lifecycle_status as status, record_version from recruitment.application where tenant_id = $1 and job_id = $2 order by id',
    [TENANT, JOB],
  )
  const interviewsClosed = await idStatusVersions(
    `select i.id::text as id, i.status, i.record_version
       from recruitment.interview i
       join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
      where a.tenant_id = $1 and a.job_id = $2 order by i.id`,
    [TENANT, JOB],
  )
  const tasksClosed = await idStatusVersions(
    'select id::text as id, status, record_version from recruitment.business_task where id = any($1::uuid[]) order by id',
    [[T1, T2, T3, T4, T5]],
  )
  const jobClosedEventKey = `job-close:${JOB}:${jobClosed.record_version}`
  const eventCountBefore = await query<{ n: number }>('select count(*)::int as n from recruitment.event_inbox')

  // ---- (a) 纯重放：全部都是"已经终止"，零写入 ----
  const replay = await httpCall(server, 'POST', JOB_CLOSE_PATH, {
    session: SESSION_RECRUITER,
    body: { job_id: JOB, confirm: true },
  })
  assert.equal(replay.status, 200, replay.text)
  assert.equal(replay.body.replayed, true, '已 CLOSED 的岗位再确认 → replayed=true')
  assert.deepEqual(replay.body.terminated, {
    applications_total: 0,
    applications_closed: 0,
    applications_already_closed: 5,
    interviews_cancelled: 0,
    interviews_already_terminal: 3,
    interviews_occurred_kept: 2,
    tasks_cancelled: 0,
    task_attempts_cancelled: 0,
  })
  assert.equal((replay.body.job as Record<string, unknown>).record_version, jobClosed.record_version, '重放不得再涨 record_version')
  assert.deepEqual(await jobRow(JOB), jobClosed, '重放不得改岗位行')
  assert.deepEqual(await idStatusVersions('select id::text as id, lifecycle_status as status, record_version from recruitment.application where tenant_id = $1 and job_id = $2', [TENANT, JOB]), appsClosed)
  assert.deepEqual(
    await idStatusVersions(`select i.id::text as id, i.status, i.record_version from recruitment.interview i join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id where a.tenant_id = $1 and a.job_id = $2`, [TENANT, JOB]),
    interviewsClosed,
  )
  assert.deepEqual(
    await idStatusVersions('select id::text as id, status, record_version from recruitment.business_task where id = any($1::uuid[])', [[T1, T2, T3, T4, T5]]),
    tasksClosed,
  )
  assert.deepEqual(await query<{ n: number }>('select count(*)::int as n from recruitment.event_inbox'), eventCountBefore, '纯重放不得写任何事件（同一版本号不重复落 job.closed）')

  // ---- (b) 关岗后又来了新的在途（申请/面试/任务）→ replayed=true 但仍必须终止残留 ----
  // 候选人 C7 已在 `seedFixture` 里落库（本用例只需要新的申请/面试/任务）。
  await query(
    `insert into recruitment.application (id, tenant_id, candidate_id, job_id, job_version_id, lifecycle_status, current_stage_code)
     values ($1,$2,$3,$4,$5,'ACTIVE','S7')`,
    [A_NEW, TENANT, C7, JOB, JOB_VERSION],
  )
  await query(
    `insert into recruitment.interview
       (id, tenant_id, application_id, round_no, slot_code, stage_code, status, scheduled_start_at, scheduled_end_at)
     values ($1,$2,$3,1,'DEFAULT','S8','SCHEDULED', now() + interval '5 day', now() + interval '5 day 1 hour')`,
    [I_NEW, TENANT, A_NEW],
  )
  await query(
    `insert into recruitment.business_task (id, tenant_id, task_type, business_refs, title, idempotency_key, status)
     values ($1,$2,'TEST',$3::jsonb,'重放后新增的未完成任务',$4,'PENDING')`,
    [T_NEW, TENANT, JSON.stringify([{ kind: 'APPLICATION', id: A_NEW }]), 'jobclose-b:tnew2'],
  )
  const bracketResidual = (await query<{ t: Date }>('select clock_timestamp() as t'))[0]!.t
  const replayResidual = await httpCall(server, 'POST', JOB_CLOSE_PATH, {
    session: SESSION_RECRUITER,
    body: { job_id: JOB, confirm: true, reason: '重放：终止关岗后残留' },
  })
  assert.equal(replayResidual.status, 200, replayResidual.text)
  assert.equal(replayResidual.body.replayed, true)
  assert.deepEqual(replayResidual.body.terminated, {
    applications_total: 1,
    applications_closed: 1,
    applications_already_closed: 5,
    interviews_cancelled: 1,
    interviews_already_terminal: 3,
    interviews_occurred_kept: 2,
    tasks_cancelled: 1,
    task_attempts_cancelled: 0,
  })
  assert.equal((replayResidual.body.job as Record<string, unknown>).record_version, jobClosed.record_version, '重放终止残留也不得涨岗位 record_version')
  assert.deepEqual(await jobRow(JOB), jobClosed, '重放终止残留不得改岗位行')
  // 残留真的被终止（独立 SQL）
  assert.equal((await stateOf('select lifecycle_status as status from recruitment.application where id = $1', [A_NEW])).status, 'CLOSED')
  assert.equal((await stateOf('select status from recruitment.interview where id = $1', [I_NEW])).status, 'CANCELLED')
  const residualTask = await stateOf('select status, (completed_at is not null) as completed from recruitment.business_task where id = $1', [T_NEW])
  assert.equal(residualTask.status, 'CANCELLED')
  assert.equal(residualTask.completed, true)
  // 这一轮只写 3 条状态迁移事件；job.closed 仍是原来那一条（同一 record_version → 同幂等键）
  const residualEvents = await query<{ event_type: string; n: number }>(
    `select event_type, count(*)::int as n from recruitment.event_inbox
      where recorded_at >= $1 group by 1 order by 1`,
    [bracketResidual],
  )
  assert.deepEqual(residualEvents, [
    { event_type: 'application.lifecycle_status.changed', n: 1 },
    { event_type: 'business_task.status.changed', n: 1 },
    { event_type: 'interview.status.changed', n: 1 },
  ])
  const jobClosedEvents = await query<{ n: number }>(
    "select count(*)::int as n from recruitment.event_inbox where event_type = 'job.closed' and idempotency_key = $1",
    [jobClosedEventKey],
  )
  assert.equal(jobClosedEvents[0]?.n, 1, '同一次关闭（同一 record_version）只允许一条 job.closed 事件')

  // ---- (c) 再一次纯重放：零写入 ----
  const stableBefore = await snapshotAll()
  const replayAgain = await httpCall(server, 'POST', JOB_CLOSE_PATH, { session: SESSION_RECRUITER, body: { job_id: JOB, confirm: true } })
  assert.equal(replayAgain.status, 200, replayAgain.text)
  assert.equal(replayAgain.body.replayed, true)
  assertNoWrite(stableBefore, await snapshotAll(), '第三次纯重放')
})

// ---------------------------------------------------------------------------
//  用例 8：导出的 write seam（`closeJobInTransaction`）在已关闭岗位上是幂等重放
// ---------------------------------------------------------------------------

test('用例8：直调 closeJobInTransaction（已 CLOSED 岗位）→ replayed=true、零写入（导出 seam 可复用）', async () => {
  const before = await snapshotAll()
  const written = await withActor(db.pool, ACTOR_103, (client) =>
    closeJobInTransaction(client, cfg, { job_id: JOB, actor_id: ACTOR_103, actor_alias: 'recruiter' }))
  assert.equal(written.replayed, true)
  assert.equal(written.job_updated, false)
  assert.equal(written.job_closed_event_id, null, '同一 record_version 不重复落 job.closed 事件')
  assert.deepEqual(written.terminated, {
    applications_total: 0,
    applications_closed: 0,
    applications_already_closed: 6,
    interviews_cancelled: 0,
    interviews_already_terminal: 4,
    interviews_occurred_kept: 2,
    tasks_cancelled: 0,
    task_attempts_cancelled: 0,
  })
  assert.equal(written.record_version_after, Number((await jobRow(JOB)).record_version))
  assertNoWrite(before, await snapshotAll(), '直调 seam 重放')
  // 顺带证明 `closeJobInTransaction` 的 HUMAN 断言也在导出 seam 上生效（非 HUMAN → 403 且零写入）
  let failure: unknown
  try {
    await withActor(db.pool, AGENT_ACTOR, (client) =>
      closeJobInTransaction(client, cfg, { job_id: JOB2, actor_id: AGENT_ACTOR, actor_alias: 'recruiter' }))
  } catch (error) {
    failure = error
  }
  assert.ok(failure !== undefined, '非 HUMAN actor 直调也必须被拒')
  assert.match(String((failure as Error).message), /ACTOR_NOT_HUMAN|403/)
  assertNoWrite(before, await snapshotAll(), '直调 seam 非 HUMAN')
})

