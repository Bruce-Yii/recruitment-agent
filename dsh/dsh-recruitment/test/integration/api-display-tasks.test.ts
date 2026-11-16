// 集成测试：`GET /recruitment/api/tasks/status`（CONTRACT §3 / §0）。
//
// 回答的问题是：**端点报的计数/列表是不是库事实**。所以：
//   * 用 `createIsolatedTestDatabase('disp_task')` 独占一个一次性空库（0001→0016 全量重放），
//     `assertPrivateDatabase` 守卫 + `after` 里 `drop()`，绝不碰共享库 ra_s6s7；
//   * 夹具只走**纯 SQL**（必要时 `set_config('recruitment.actor_id', …)`），
//     同租户造：PENDING 新鲜 / PENDING 逾期 / READY 逾期 / RUNNING+CLAIMED 租约过期 /
//     WAITING_HUMAN / RETRY_WAIT 新鲜 / SUCCEEDED（含 24h 外一条）；
//     task_attempt 多状态；event_inbox：RECEIVED 旧/新、ROUTED、FAILED、IGNORED；
//     event_disposition 多种 reason（每事件至多一行，reason 为 0016 闭集）；
//     另一个 organization 各造一条**反证**（都不许被计数/列出）；
//   * 端点跑在**真 node:http + listen(0) + fetch** 上（不打桩 handler）；
//   * 迁库自带 2 条 `0002_seed` 触发器审计事件（RECEIVED，`normalizer_version='schema/0001'`）：
//     本测试在 `before` 里**显式读回基线**再断言「基线 2 条 RECEIVED」，随后期望值 = 基线 + 夹具，
//     这样计数仍是**精确相等**，而不是靠时间窗口猜；
//   * 负例（405 / 403 / 400 / actor 覆盖 / DB 未配置 503）前后，四张表的行数**逐表全等**（零写入）；
//   * 时序断言全部是相对比较（`>=` 下限 + 有界），不写死机器时间。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  registerDisplayTasksHttp,
  STUCK_AFTER_SECONDS,
  TASKS_STATUS_CONTRACT_VERSION,
  TASKS_STATUS_PATH,
  type DisplayTasksHostContext,
} from '../../src/http/display-tasks.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  HR_ACTOR,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

// =====================================================================
//  夹具常量（固定 id：断言可以逐 id 对；都不与 0002_seed 的 id 冲突）
// =====================================================================

/** 反证租户（organization）：它的 task/attempt/event/disposition 一条都不许出现在响应里。 */
const TENANT_B = '22222222-2222-4222-8222-0000000000b1'
/** 0002_seed 的演示申请 id（真实存在；业务 ref 指向它，证明 application_id 提取的是业务 id）。 */
const APPLICATION_ID = '11111111-1111-4111-8111-000000000701'
/** 一个**不该被返回**的 resume ref id（business_refs 原文里有它，响应里不许出现）。 */
const RESUME_REF_ID = '99999999-9999-4999-8999-0000000000ff'
/** 一个**不该被返回**的 interview ref id。 */
const INTERVIEW_REF_ID = '99999999-9999-4999-8999-0000000000fe'

/** 任务 id（a* = 本租户，b1 = 反证租户）。 */
const TASK = {
  pendingFresh: '33333333-3333-4333-8333-0000000000a1',
  pendingOverdue: '33333333-3333-4333-8333-0000000000a2',
  readyOverdue: '33333333-3333-4333-8333-0000000000a3',
  runningLeaseExpired: '33333333-3333-4333-8333-0000000000a4',
  waitingHuman: '33333333-3333-4333-8333-0000000000a5',
  retryFresh: '33333333-3333-4333-8333-0000000000a6',
  succeededFresh: '33333333-3333-4333-8333-0000000000a7',
  succeededOld: '33333333-3333-4333-8333-0000000000a8',
  tenantBRunning: '33333333-3333-4333-8333-0000000000b1',
} as const

/** attempt id。 */
const ATTEMPT = {
  running: '44444444-4444-4444-8444-0000000000c1',
  succeeded: '44444444-4444-4444-8444-0000000000c2',
  retryFailed: '44444444-4444-4444-8444-0000000000c3',
  tenantB: '44444444-4444-4444-8444-0000000000c4',
} as const

/** 事件 id（e* = 本租户，f* = 反证租户）。 */
const EVENT = {
  receivedOld: '55555555-5555-4555-8555-0000000000e1',
  receivedFresh: '55555555-5555-4555-8555-0000000000e2',
  routed: '55555555-5555-4555-8555-0000000000e3',
  failed: '55555555-5555-4555-8555-0000000000e4',
  ignoredRejected: '55555555-5555-4555-8555-0000000000e5',
  ignoredIgnored: '55555555-5555-4555-8555-0000000000e6',
  tenantBReceived: '55555555-5555-4555-8555-0000000000f1',
  tenantBIgnored: '55555555-5555-4555-8555-0000000000f2',
} as const

/** 同源头标记头。 */
const REQUEST_HEADER = 'x-recruitment-request'

let db: IsolatedTestDatabase
/** 迁库基线（本测试在 before 里读回并断言，期望值 = 基线 + 夹具）。 */
let baseline: { readonly received: number; readonly tasks: number; readonly attempts: number; readonly dispositions: number }

// =====================================================================
//  harness：真 node:http + listen(0) + fetch
// =====================================================================

interface CapturedRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: Parameters<DisplayTasksHostContext['webServer']['register']>[0]['handler']
}

interface TasksServer {
  readonly baseUrl: string
  readonly port: number
  readonly registered: readonly CapturedRoute[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

/** 起真 http server，并用 `registerDisplayTasksHttp` 在其上注册路由。 */
async function startTasksServer(options: {
  readonly database: ResolvedDatabaseConfig | null
  readonly host?: string
}): Promise<TasksServer> {
  const routes = new Map<string, CapturedRoute['handler']>()
  const registered: CapturedRoute[] = []
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
  const ctx: DisplayTasksHostContext = {
    webServer: {
      host: options.host ?? '127.0.0.1',
      port: address.port,
      register(route) {
        registered.push(route)
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
  }
  const dispose = registerDisplayTasksHttp(ctx, { database: options.database })
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
  readonly text: string
  readonly body: Record<string, unknown>
  readonly headers: Headers
}

/** 发一次请求（默认同源）。 */
async function httpCall(
  target: Pick<TasksServer, 'baseUrl'>,
  method: string,
  path: string,
  options: { readonly headers?: Readonly<Record<string, string>>; readonly omitRequestHeader?: boolean } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.omitRequestHeader !== true) headers[REQUEST_HEADER] = '1'
  const response = await fetch(`${target.baseUrl}${path}`, { method, headers })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: response.status, text, body, headers: response.headers }
}

/** 断言封闭错误体。 */
function assertHttpError(result: HttpResult, status: number, code: string, reasonCode: string): void {
  assert.equal(result.status, status, `HTTP 状态应为 ${status}：${result.text}`)
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `响应必须是 {"error":{...}}：${result.text}`)
  assert.equal(error.code, code, `error.code 应为 ${code}：${result.text}`)
  assert.equal(error.reason_code, reasonCode, `error.reason_code 应为 ${reasonCode}：${result.text}`)
  assert.equal(typeof error.message, 'string')
}

// =====================================================================
//  夹具插入（纯 SQL；一次性库，允许真提交）
// =====================================================================

/** 一条 business_task 的夹具描述（时间用相对秒数，库端 `now()` 计算）。 */
interface TaskFixture {
  readonly id: string
  readonly tenant: string
  readonly status: string
  readonly taskType?: string
  readonly title?: string
  readonly createdAgoSeconds: number
  readonly statusChangedAgoSeconds?: number
  /** 相对 now 的秒数（负数 = 已逾期）。 */
  readonly nextRunDeltaSeconds?: number | null
  readonly dueAgoSeconds?: number | null
  readonly currentAttemptId?: string | null
  readonly attemptCount?: number
  readonly businessRefs?: readonly unknown[]
  readonly completedAgoSeconds?: number | null
}

/** 插一条 business_task。 */
async function insertTask(pool: IsolatedTestDatabase['pool'], fixture: TaskFixture): Promise<void> {
  await pool.query(
    `insert into recruitment.business_task
       (id, tenant_id, task_type, title, idempotency_key, status, priority,
        created_at, status_changed_at, next_run_at, due_at,
        current_attempt_id, attempt_count, business_refs, completed_at)
     values
       ($1::uuid, $2::uuid, $3, $4, $5, $6, $7,
        now() - make_interval(secs => $8::double precision),
        now() - make_interval(secs => $9::double precision),
        case when $10::double precision is null then null
             else now() + make_interval(secs => $10::double precision) end,
        case when $11::double precision is null then null
             else now() - make_interval(secs => $11::double precision) end,
        $12::uuid, $13::int, $14::jsonb,
        case when $15::double precision is null then null
             else now() - make_interval(secs => $15::double precision) end)`,
    [
      fixture.id,
      fixture.tenant,
      fixture.taskType ?? 'RESUME_PARSE',
      fixture.title ?? `夹具任务 ${fixture.id.slice(-2)}`,
      `task:${fixture.id}`,
      fixture.status,
      fixture.priority ?? 3,
      fixture.createdAgoSeconds,
      fixture.statusChangedAgoSeconds ?? fixture.createdAgoSeconds,
      fixture.nextRunDeltaSeconds ?? null,
      fixture.dueAgoSeconds ?? null,
      fixture.currentAttemptId ?? null,
      fixture.attemptCount ?? 0,
      JSON.stringify(fixture.businessRefs ?? []),
      fixture.completedAgoSeconds ?? null,
    ],
  )
}

/** 一条 task_attempt 的夹具描述。 */
interface AttemptFixture {
  readonly id: string
  readonly tenant: string
  readonly taskId: string
  readonly status: string
  readonly attemptNo?: number
  readonly claimedAgoSeconds: number
  readonly startedAgoSeconds?: number | null
  /** 相对 now 的秒数（负数 = 已过期）。 */
  readonly leaseDeltaSeconds: number
  readonly endedAgoSeconds?: number | null
  readonly errorClass?: string | null
  readonly errorCode?: string | null
  readonly retryAfterDeltaSeconds?: number | null
}

/** 插一条 task_attempt（`worker_type`/`worker_id` 用常量：投影只读不判）。 */
async function insertAttempt(pool: IsolatedTestDatabase['pool'], fixture: AttemptFixture): Promise<void> {
  await pool.query(
    `insert into recruitment.task_attempt
       (id, tenant_id, task_id, attempt_no, worker_type, worker_id, status,
        claimed_at, started_at, lease_expires_at, ended_at,
        error_class, error_code, retry_after)
     values
       ($1::uuid, $2::uuid, $3::uuid, $4, 'DSH_WORKER', 'worker-fixture', $5,
        now() - make_interval(secs => $6::double precision),
        case when $7::double precision is null then null
             else now() - make_interval(secs => $7::double precision) end,
        now() + make_interval(secs => $8::double precision),
        case when $9::double precision is null then null
             else now() - make_interval(secs => $9::double precision) end,
        $10, $11,
        case when $12::double precision is null then null
             else now() + make_interval(secs => $12::double precision) end)`,
    [
      fixture.id,
      fixture.tenant,
      fixture.taskId,
      fixture.attemptNo ?? 1,
      fixture.status,
      fixture.claimedAgoSeconds,
      fixture.startedAgoSeconds ?? null,
      fixture.leaseDeltaSeconds,
      fixture.endedAgoSeconds ?? null,
      fixture.errorClass ?? null,
      fixture.errorCode ?? null,
      fixture.retryAfterDeltaSeconds ?? null,
    ],
  )
}

/** 一条 event_inbox 的夹具描述。 */
interface EventFixture {
  readonly id: string
  readonly tenant: string
  readonly eventType: string
  readonly receivedAgoSeconds: number
  readonly dispatchState: 'RECEIVED' | 'ROUTED' | 'IGNORED' | 'FAILED'
  readonly routeAttempts?: number
  readonly routeError?: string | null
  readonly normalizerVersion?: string | null
}

/** 插一条 event_inbox（dispatch 投影列显式写，满足 0011 的三条 check）。 */
async function insertEvent(pool: IsolatedTestDatabase['pool'], fixture: EventFixture): Promise<void> {
  await pool.query(
    `insert into recruitment.event_inbox
       (event_id, tenant_id, provider, provider_event_id, event_type, schema_version,
        occurred_at, received_at, idempotency_key, payload, trust_level,
        dispatch_state, routed_at, route_attempts, route_error, normalizer_version)
     values
       ($1::uuid, $2::uuid, 'internal', null, $3, 1,
        now() - make_interval(secs => $4::double precision),
        now() - make_interval(secs => $4::double precision),
        $5, '{}'::jsonb, 'INTERNAL', $6,
        case when $6 = 'RECEIVED' then null else now() end,
        $7, $8, $9)`,
    [
      fixture.id,
      fixture.tenant,
      fixture.eventType,
      fixture.receivedAgoSeconds,
      `event:${fixture.id}`,
      fixture.dispatchState,
      fixture.routeAttempts ?? 0,
      fixture.routeError ?? null,
      fixture.normalizerVersion ?? null,
    ],
  )
}

/** 插一条 event_disposition（append-only；每事件至多一行）。 */
async function insertDisposition(
  pool: IsolatedTestDatabase['pool'],
  input: {
    readonly tenant: string
    readonly eventId: string
    readonly disposition: 'FILTERED' | 'EVALUATED' | 'FANNED_OUT'
    readonly reasonCode: string
    readonly targetTaskIds?: readonly string[]
  },
): Promise<void> {
  await pool.query(
    `insert into recruitment.event_disposition
       (tenant_id, event_id, disposition, reason_code, target_task_ids)
     values ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
    [input.tenant, input.eventId, input.disposition, input.reasonCode, JSON.stringify(input.targetTaskIds ?? [])],
  )
}

/** 四张表的总行数（跨租户；负例前后必须逐个全等 = 零写入）。 */
async function tableCounts(pool: IsolatedTestDatabase['pool']): Promise<Record<string, number>> {
  const { rows } = await pool.query<Record<string, number>>(
    `select
       (select count(*) from recruitment.business_task)::int      as business_task,
       (select count(*) from recruitment.task_attempt)::int       as task_attempt,
       (select count(*) from recruitment.event_inbox)::int        as event_inbox,
       (select count(*) from recruitment.event_disposition)::int  as event_disposition`,
  )
  return rows[0] ?? {}
}

/** 一次性库的已解析配置（密码只从环境变量来，与生产同一份解析代码）。 */
function isolatedDatabaseConfig(target: IsolatedTestDatabase): ResolvedDatabaseConfig {
  return { ...testDatabaseConfig(), database: target.name }
}

/**
 * 把一条任务从 PENDING 提升为 RUNNING，并钉住当前 attempt。
 *
 * 必须走这条「先任务、再 attempt、最后状态迁移」的路径：`fk_business_task_current_attempt` 是
 * **立即生效**的复合外键（task → attempt），attempt 又 FK 回 task，两条 INSERT 无法互相满足；
 * 真实运行时也是 PENDING → claim(attempt) → RUNNING 的顺序。`fn_row_guard` 会在状态迁移时
 * 要求 actor 并写一条**内部审计事件**（schema/0001，RECEIVED）——夹具的期望计数把这条算进去。
 * @param pool - 一次性库连接池。
 * @param taskId - 目标任务。
 * @param attemptId - 该任务的当前 attempt（必须已插入）。
 */
async function promoteTaskToRunning(
  pool: IsolatedTestDatabase['pool'],
  taskId: string,
  attemptId: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    // is_local = true：身份只在本次事务里有效（与 withActor 同一纪律）。
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    await client.query(
      `update recruitment.business_task
          set status = 'RUNNING', current_attempt_id = $2::uuid, attempt_count = 1
        where id = $1::uuid`,
      [taskId, attemptId],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

// =====================================================================
//  建库 + 夹具（真提交；before/after 严格成对）
// =====================================================================

before(async () => {
  db = await createIsolatedTestDatabase('disp_task')
  // 守卫：真提交用例必须独占一次性库，不许回落到共享的 ra_s6s7。
  assertPrivateDatabase(db.name)
  assert.match(db.name, /^ra_disp_task_/, '库名必须是一次性库（ra_disp_task_<pid>_<rand>）')

  // ---- 迁库基线：0002_seed 的触发器审计事件（0002 自己声明「首跑产生 2 条内部事件」）----
  const baselineEvents = await db.pool.query<{ n: number }>(
    `select count(*)::int as n
       from recruitment.event_inbox
      where tenant_id = $1::uuid and dispatch_state = 'RECEIVED'`,
    [TENANT],
  )
  const baselineTasks = await db.pool.query<{ n: number }>('select count(*)::int as n from recruitment.business_task')
  const baselineAttempts = await db.pool.query<{ n: number }>('select count(*)::int as n from recruitment.task_attempt')
  const baselineDispositions = await db.pool.query<{ n: number }>('select count(*)::int as n from recruitment.event_disposition')
  baseline = {
    received: baselineEvents.rows[0]?.n ?? -1,
    tasks: baselineTasks.rows[0]?.n ?? -1,
    attempts: baselineAttempts.rows[0]?.n ?? -1,
    dispositions: baselineDispositions.rows[0]?.n ?? -1,
  }
  // 基线必须是确定的：2 条 RECEIVED 审计事件、0 task / 0 attempt / 0 disposition。
  // 若迁移链改了种子事件数，这里会**显式红**（而不是靠"时间窗口"让断言碰巧过）。
  assert.deepEqual(baseline, { received: 2, tasks: 0, attempts: 0, dispositions: 0 }, '一次性空库的迁移基线')

  // ---- 反证组织（另一个 tenant）----
  await db.pool.query(`insert into recruitment.organization (id, name) values ($1::uuid, $2)`, [
    TENANT_B, '反证租户 · DEMO ONLY（非真实数据）',
  ])

  // ---- 本租户 7 条任务 + 24h 外 1 条（created_at 决定列表顺序：a1 最新 → a7，a8 最老）----
  await insertTask(db.pool, {
    id: TASK.pendingFresh,
    tenant: TENANT,
    status: 'PENDING',
    createdAgoSeconds: 60,
    nextRunDeltaSeconds: 600, // 还没到期：不卡
    businessRefs: [
      { kind: 'Application', id: APPLICATION_ID }, // 大小写不敏感
      { kind: 'RESUME', id: RESUME_REF_ID }, // 原文不许出现在响应里
    ],
  })
  await insertTask(db.pool, {
    id: TASK.pendingOverdue,
    tenant: TENANT,
    status: 'PENDING',
    createdAgoSeconds: 120,
    nextRunDeltaSeconds: -600, // 逾期 10 分钟：卡住（NOT_DISPATCHED）
    businessRefs: [{ kind: 'INTERVIEW', id: INTERVIEW_REF_ID }], // 不是 APPLICATION → null
  })
  await insertTask(db.pool, {
    id: TASK.readyOverdue,
    tenant: TENANT,
    status: 'READY',
    createdAgoSeconds: 180,
    nextRunDeltaSeconds: -600, // 卡住（NOT_DISPATCHED）
    businessRefs: [{ kind: 'APPLICATION', id: 'not-a-uuid' }], // 脏 ref id → null（不返回任意串）
  })
  await insertTask(db.pool, {
    id: TASK.runningLeaseExpired,
    tenant: TENANT,
    status: 'PENDING', // 先 PENDING：current_attempt_id 有立即生效的复合外键，attempt 必须先存在
    createdAgoSeconds: 240,
    businessRefs: [],
  })
  await insertTask(db.pool, {
    id: TASK.waitingHuman,
    tenant: TENANT,
    status: 'WAITING_HUMAN',
    createdAgoSeconds: 300,
    statusChangedAgoSeconds: 1800, // 最老的等待中任务（oldest_waiting_seconds ≈ 1800）
    dueAgoSeconds: 120,
    businessRefs: [{ kind: 'application', id: APPLICATION_ID }], // 小写 kind 也要认
  })
  await insertTask(db.pool, {
    id: TASK.retryFresh,
    tenant: TENANT,
    status: 'RETRY_WAIT',
    createdAgoSeconds: 360,
    nextRunDeltaSeconds: 600, // 还没到期：不卡
    attemptCount: 1,
  })
  await insertTask(db.pool, {
    id: TASK.succeededFresh,
    tenant: TENANT,
    status: 'SUCCEEDED',
    createdAgoSeconds: 420,
    completedAgoSeconds: 120,
    attemptCount: 1,
  })
  await insertTask(db.pool, {
    id: TASK.succeededOld,
    tenant: TENANT,
    status: 'SUCCEEDED',
    createdAgoSeconds: 3 * 24 * 3600, // 24h 外：只出现在 by_status，不在 last_24h
    completedAgoSeconds: 2 * 24 * 3600,
  })

  // ---- 反证租户：PENDING 逾期（本该算 stuck）+ 一条终态 attempt（若漏 tenant 过滤会污染计数/列表）----
  await insertTask(db.pool, {
    id: TASK.tenantBRunning,
    tenant: TENANT_B,
    status: 'PENDING',
    createdAgoSeconds: 600,
    nextRunDeltaSeconds: -900,
  })

  // ---- attempts：CLAIMED（租约过期）/ SUCCEEDED / FAILED_RETRYABLE / 反证租户一条 ----
  await insertAttempt(db.pool, {
    id: ATTEMPT.running,
    tenant: TENANT,
    taskId: TASK.runningLeaseExpired,
    status: 'CLAIMED',
    claimedAgoSeconds: 3600,
    startedAgoSeconds: 3500,
    leaseDeltaSeconds: -1800, // 租约已过期 → 任务卡住（LEASE_EXPIRED）
  })
  await insertAttempt(db.pool, {
    id: ATTEMPT.succeeded,
    tenant: TENANT,
    taskId: TASK.succeededFresh,
    status: 'SUCCEEDED',
    claimedAgoSeconds: 420,
    startedAgoSeconds: 410,
    leaseDeltaSeconds: 480, // 未过期
    endedAgoSeconds: 120,
  })
  await insertAttempt(db.pool, {
    id: ATTEMPT.retryFailed,
    tenant: TENANT,
    taskId: TASK.retryFresh,
    status: 'FAILED_RETRYABLE',
    claimedAgoSeconds: 400,
    leaseDeltaSeconds: 500,
    endedAgoSeconds: 300,
    errorClass: 'TRANSIENT',
    errorCode: 'WORKER_TEMPORARY',
    retryAfterDeltaSeconds: 600,
  })
  await insertAttempt(db.pool, {
    id: ATTEMPT.tenantB,
    tenant: TENANT_B,
    taskId: TASK.tenantBRunning,
    status: 'FAILED_FINAL',
    claimedAgoSeconds: 800,
    leaseDeltaSeconds: -700,
    endedAgoSeconds: 600,
    errorClass: 'PERMANENT',
    errorCode: 'TENANT_B_ONLY',
  })

  // ---- 把本租户 RUNNING 任务按真实顺序提升（PENDING → attempt → RUNNING）：
  //      fn_row_guard 会写 1 条内部审计事件（RECEIVED，schema/0001），期望计数已计入。
  await promoteTaskToRunning(db.pool, TASK.runningLeaseExpired, ATTEMPT.running)

  // ---- 事件：RECEIVED 旧（卡住）/ RECEIVED 新 / ROUTED / FAILED / IGNORED ×2 ----
  await insertEvent(db.pool, {
    id: EVENT.receivedOld,
    tenant: TENANT,
    eventType: 'resume.intake.received',
    receivedAgoSeconds: 600, // > STUCK_AFTER_SECONDS → 卡住事件
    dispatchState: 'RECEIVED',
    routeAttempts: 3,
  })
  await insertEvent(db.pool, {
    id: EVENT.receivedFresh,
    tenant: TENANT,
    eventType: 'resume.intake.received',
    receivedAgoSeconds: 1,
    dispatchState: 'RECEIVED',
  })
  await insertEvent(db.pool, {
    id: EVENT.routed,
    tenant: TENANT,
    eventType: 'scorecard.submit',
    receivedAgoSeconds: 60,
    dispatchState: 'ROUTED',
    routeAttempts: 1,
  })
  await insertEvent(db.pool, {
    id: EVENT.failed,
    tenant: TENANT,
    eventType: 'resume.intake.received',
    receivedAgoSeconds: 90,
    dispatchState: 'FAILED',
    routeAttempts: 2,
    routeError: 'SEMANTIC_GATE_REJECTED',
  })
  await insertEvent(db.pool, {
    id: EVENT.ignoredRejected,
    tenant: TENANT,
    eventType: 'resume.intake.received',
    receivedAgoSeconds: 120,
    dispatchState: 'IGNORED',
    routeAttempts: 1,
    routeError: 'SEMANTIC_GATE_REJECTED',
  })
  await insertEvent(db.pool, {
    id: EVENT.ignoredIgnored,
    tenant: TENANT,
    eventType: 'job.status.changed',
    receivedAgoSeconds: 180,
    dispatchState: 'IGNORED',
    routeAttempts: 1,
    routeError: 'ROUTE_IGNORED',
  })

  // ---- 反证租户：一条 RECEIVED 旧事件（卡住）+ 一条 IGNORED（有处置）----
  await insertEvent(db.pool, {
    id: EVENT.tenantBReceived,
    tenant: TENANT_B,
    eventType: 'resume.intake.received',
    receivedAgoSeconds: 900,
    dispatchState: 'RECEIVED',
    routeAttempts: 5,
  })
  await insertEvent(db.pool, {
    id: EVENT.tenantBIgnored,
    tenant: TENANT_B,
    eventType: 'job.status.changed',
    receivedAgoSeconds: 240,
    dispatchState: 'IGNORED',
    routeError: 'ROUTE_IGNORED',
  })

  // ---- event_disposition：FANNED_OUT / FILTERED ×2（reason 只用 0016 闭集）；反证租户一条 ----
  await insertDisposition(db.pool, {
    tenant: TENANT,
    eventId: EVENT.routed,
    disposition: 'FANNED_OUT',
    reasonCode: 'TASK_CREATED',
    targetTaskIds: [TASK.pendingOverdue],
  })
  await insertDisposition(db.pool, {
    tenant: TENANT,
    eventId: EVENT.ignoredRejected,
    disposition: 'FILTERED',
    reasonCode: 'SEMANTIC_GATE_REJECTED',
  })
  await insertDisposition(db.pool, {
    tenant: TENANT,
    eventId: EVENT.ignoredIgnored,
    disposition: 'FILTERED',
    reasonCode: 'ROUTE_IGNORED',
  })
  await insertDisposition(db.pool, {
    tenant: TENANT_B,
    eventId: EVENT.tenantBIgnored,
    disposition: 'FILTERED',
    reasonCode: 'ROUTE_IGNORED',
  })
})

after(async () => {
  if (db !== undefined) await db.drop()
})

// =====================================================================
//  断言夹具
// =====================================================================

/** 按 task_id 索引 tasks 行。 */
function byTaskId(rows: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const row of rows) map.set(String(row.task_id), row)
  return map
}

/** 读一次 200（主 server 由测试按需起，闭包在函数里保证 close）。 */
async function fetchStatus(server: TasksServer): Promise<{ result: HttpResult; tasks: Record<string, unknown>; counts: Record<string, unknown> }> {
  const result = await httpCall(server, 'GET', TASKS_STATUS_PATH)
  assert.equal(result.status, 200, `200 期望：${result.text}`)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  const tasks = result.body.tasks as Record<string, unknown>
  const counts = result.body.counts as Record<string, unknown>
  return { result, tasks, counts }
}

// =====================================================================
//  200 正例：计数 / 列表 / 卡住归属 / application_id
// =====================================================================

test('200：路由是 exact + counts 精确等于库事实（含基线 2 条 RECEIVED 审计事件）', async () => {
  const server = await startTasksServer({ database: isolatedDatabaseConfig(db) })
  try {
    assert.deepEqual(
      server.registered.map((route) => ({ kind: route.kind, path: route.path })),
      [{ kind: 'exact', path: TASKS_STATUS_PATH }],
      '端点必须是 exact 路由',
    )
    const { result, counts } = await fetchStatus(server)
    assert.equal(result.body.tool, 'recruitment_tasks_status')
    assert.equal(result.body.contract_version, TASKS_STATUS_CONTRACT_VERSION)
    assert.equal(result.body.stuck_after_seconds, STUCK_AFTER_SECONDS)
    assert.equal(typeof result.body.captured_at, 'string')

    // 本租户 8 条（反证租户 1 条不许被计入）：
    //   PENDING×2 / READY×1 / RUNNING×1 / WAITING_HUMAN×1 / RETRY_WAIT×1 / SUCCEEDED×2
    assert.deepEqual(counts.by_status, {
      PENDING: 2, READY: 1, RUNNING: 1, WAITING_HUMAN: 1, RETRY_WAIT: 1, SUCCEEDED: 2,
    })
    assert.equal(counts.running, 1, 'RUNNING 只数本租户（反证租户那条不许计入）')
    assert.equal(counts.waiting_human, 1)
    // 卡住 = PENDING 逾期 + READY 逾期 + RUNNING 租约过期（反证租户那条也不许计入）
    assert.equal(counts.stuck, 3)
    // 事件：基线 2 条 RECEIVED（0002_seed 审计）+ 夹具 RECEIVED 2 条 + RUNNING 状态迁移的 1 条审计事件
    assert.equal(counts.events_received_unrouted, baseline.received + 3)
    assert.equal(counts.events_stuck, 1, '只有 600s 前那条 RECEIVED 算卡住（基线/迁移审计事件都是刚开始的）')
    // 等待中最老 = WAITING_HUMAN 的 status_changed_at（1800s 前）；相对断言 + 有界
    const oldestWaiting = counts.oldest_waiting_seconds as number
    assert.equal(typeof oldestWaiting, 'number')
    assert.ok(oldestWaiting >= 1790, `oldest_waiting_seconds 应 >= 1790，实际 ${oldestWaiting}`)
    assert.ok(oldestWaiting <= 1860, `oldest_waiting_seconds 应 <= 1860，实际 ${oldestWaiting}`)
    // 未路由事件最老 = 本夹具 600s 前那条（基线两条更新）
    const oldestUnrouted = counts.oldest_unrouted_event_seconds as number
    assert.ok(oldestUnrouted >= 590, `oldest_unrouted_event_seconds 应 >= 590，实际 ${oldestUnrouted}`)
    assert.ok(oldestUnrouted <= 700, `oldest_unrouted_event_seconds 应 <= 700，实际 ${oldestUnrouted}`)
    // last_24h：8 条里 7 条是 24h 内创建（a8 是 3 天前）
    assert.deepEqual(counts.last_24h, {
      tasks: 7,
      by_status: { PENDING: 2, READY: 1, RUNNING: 1, WAITING_HUMAN: 1, RETRY_WAIT: 1, SUCCEEDED: 1 },
    })
  } finally {
    await server.close()
  }
})

test('200 tasks：最近 50 条按 created_at desc + current_attempt/age_seconds/stuck 投影', async () => {
  const server = await startTasksServer({ database: isolatedDatabaseConfig(db) })
  try {
    const { result, tasks } = await fetchStatus(server)
    const rows = tasks as unknown as Record<string, unknown>[]
    assert.equal(rows.length, 8, '本租户 8 条任务；反证租户那条不许出现')
    assert.deepEqual(
      rows.map((row) => row.task_id),
      [
        TASK.pendingFresh, TASK.pendingOverdue, TASK.readyOverdue, TASK.runningLeaseExpired,
        TASK.waitingHuman, TASK.retryFresh, TASK.succeededFresh, TASK.succeededOld,
      ],
      '按 created_at desc 排序',
    )
    const map = byTaskId(rows)

    // 新鲜 PENDING：不卡；APPLICATION ref（大小写不敏感）被提取
    const pendingFresh = map.get(TASK.pendingFresh)!
    assert.equal(pendingFresh.status, 'PENDING')
    assert.equal(pendingFresh.stuck, false)
    assert.equal(pendingFresh.stuck_reason, null)
    assert.equal(pendingFresh.current_attempt, null)
    assert.equal(pendingFresh.application_id, APPLICATION_ID)
    assert.equal(typeof pendingFresh.age_seconds, 'number')
    assert.ok((pendingFresh.age_seconds as number) >= 50, 'age_seconds 是相对 now 的实测值')
    assert.ok((pendingFresh.age_seconds as number) <= 300)

    // RUNNING + 租约过期：stuck_reason=LEASE_EXPIRED，current_attempt 有 attempt_no/status/lease/claimed_at
    const running = map.get(TASK.runningLeaseExpired)!
    assert.equal(running.stuck, true)
    assert.equal(running.stuck_reason, 'LEASE_EXPIRED')
    const currentAttempt = running.current_attempt as Record<string, unknown>
    assert.equal(currentAttempt.attempt_no, 1)
    assert.equal(currentAttempt.status, 'CLAIMED')
    assert.equal(typeof currentAttempt.lease_expires_at, 'string')
    assert.equal(typeof currentAttempt.claimed_at, 'string')

    // WAITING_HUMAN：due_at 如实透出；小写 kind 'application' 也认
    const waiting = map.get(TASK.waitingHuman)!
    assert.equal(waiting.status, 'WAITING_HUMAN')
    assert.equal(typeof waiting.due_at, 'string')
    assert.equal(waiting.application_id, APPLICATION_ID)

    // SUCCEEDED：不卡；24h 外那条 age_seconds >= 3 天
    const old = map.get(TASK.succeededOld)!
    assert.equal(old.status, 'SUCCEEDED')
    assert.equal(old.stuck, false)
    assert.equal(old.stuck_reason, null)
    assert.ok((old.age_seconds as number) >= 3 * 24 * 3600 - 60)

    // 脏 APPLICATION ref id（非 UUID）→ null，不返回任意字符串
    assert.equal(map.get(TASK.readyOverdue)!.application_id, null)
    // INTERVIEW ref → 不是 APPLICATION，进不了 application_id
    assert.equal(map.get(TASK.pendingOverdue)!.application_id, null)

    // 整个响应不许出现 business_refs 原文 / 其它 ref id
    assert.equal(result.text.includes('business_refs'), false, '不许透出 business_refs 原文')
    assert.equal(result.text.includes(RESUME_REF_ID), false, '不许透出 RESUME ref id')
    assert.equal(result.text.includes(INTERVIEW_REF_ID), false, '不许透出 INTERVIEW ref id')
    assert.equal(/[A-Za-z]:\\/.test(result.text), false, '不许出现机器绝对路径')
  } finally {
    await server.close()
  }
})

test('200 stuck_tasks：只列卡住的 3 条（最老在前），非卡的一条都没有', async () => {
  const server = await startTasksServer({ database: isolatedDatabaseConfig(db) })
  try {
    const { body } = await (async () => {
      const result = await httpCall(server, 'GET', TASKS_STATUS_PATH)
      assert.equal(result.status, 200, result.text)
      return { body: result.body }
    })()
    const stuck = body.stuck_tasks as Record<string, unknown>[]
    assert.deepEqual(
      stuck.map((row) => row.stuck_reason),
      ['LEASE_EXPIRED', 'NOT_DISPATCHED', 'NOT_DISPATCHED'],
      '最老在前：RUNNING 租约过期（-240s）、READY 逾期（-180s）、PENDING 逾期（-120s）',
    )
    assert.deepEqual(
      stuck.map((row) => row.task_id),
      [TASK.runningLeaseExpired, TASK.readyOverdue, TASK.pendingOverdue],
    )
    for (const row of stuck) assert.equal(row.stuck, true)
    // 非卡住的任务一条都不许混进来
    const stuckIds = new Set(stuck.map((row) => row.task_id))
    for (const id of [TASK.pendingFresh, TASK.waitingHuman, TASK.retryFresh, TASK.succeededFresh, TASK.succeededOld]) {
      assert.equal(stuckIds.has(id), false, `${id} 不是卡住任务`)
    }
  } finally {
    await server.close()
  }
})

test('200 attempts：最近 50（claimed_at desc）+ join task_type + lease_expired', async () => {
  const server = await startTasksServer({ database: isolatedDatabaseConfig(db) })
  try {
    const result = await httpCall(server, 'GET', TASKS_STATUS_PATH)
    assert.equal(result.status, 200, result.text)
    const attempts = result.body.attempts as Record<string, unknown>[]
    assert.deepEqual(
      attempts.map((row) => row.attempt_id),
      [ATTEMPT.retryFailed, ATTEMPT.succeeded, ATTEMPT.running],
      'claimed_at desc：-400s → -420s → -3600s；反证租户 attempt 不许出现',
    )
    const map = new Map(attempts.map((row) => [String(row.attempt_id), row]))
    assert.equal(map.get(ATTEMPT.running)!.lease_expired, true)
    assert.equal(map.get(ATTEMPT.running)!.task_type, 'RESUME_PARSE')
    assert.equal(map.get(ATTEMPT.running)!.status, 'CLAIMED')
    assert.equal(map.get(ATTEMPT.succeeded)!.lease_expired, false)
    assert.equal(map.get(ATTEMPT.retryFailed)!.status, 'FAILED_RETRYABLE')
    assert.equal(map.get(ATTEMPT.retryFailed)!.error_class, 'TRANSIENT')
    assert.equal(map.get(ATTEMPT.retryFailed)!.error_code, 'WORKER_TEMPORARY')
    assert.equal(typeof map.get(ATTEMPT.succeeded)!.ended_at, 'string')
  } finally {
    await server.close()
  }
})

test('200 events：by_dispatch_state / oldest_unrouted_seconds / 卡住列表（≤20，反证租户排除）', async () => {
  const server = await startTasksServer({ database: isolatedDatabaseConfig(db) })
  try {
    const result = await httpCall(server, 'GET', TASKS_STATUS_PATH)
    assert.equal(result.status, 200, result.text)
    const events = result.body.events as Record<string, unknown>
    // 基线 2 条 RECEIVED + 夹具 RECEIVED 2 / ROUTED 1 / FAILED 1 / IGNORED 2
    // + RUNNING 状态迁移的 1 条审计事件（RECEIVED，schema/0001）
    assert.deepEqual(events.by_dispatch_state, {
      RECEIVED: baseline.received + 3,
      ROUTED: 1,
      FAILED: 1,
      IGNORED: 2,
    })
    const oldest = events.oldest_unrouted_seconds as number
    assert.ok(oldest >= 590 && oldest <= 700, `oldest_unrouted_seconds 应 ≈600，实际 ${oldest}`)
    const stuck = events.stuck as Record<string, unknown>[]
    assert.equal(stuck.length, 1, '只有 600s 那条 RECEIVED 算卡住')
    assert.equal(stuck[0]!.event_id, EVENT.receivedOld)
    assert.equal(stuck[0]!.event_type, 'resume.intake.received')
    assert.equal(stuck[0]!.dispatch_state, 'RECEIVED')
    assert.equal(stuck[0]!.route_attempts, 3)
    assert.ok((stuck[0]!.age_seconds as number) >= 590)
  } finally {
    await server.close()
  }
})

test('200 dispositions：by_disposition / by_reason / total（反证租户处置不计）', async () => {
  const server = await startTasksServer({ database: isolatedDatabaseConfig(db) })
  try {
    const result = await httpCall(server, 'GET', TASKS_STATUS_PATH)
    assert.equal(result.status, 200, result.text)
    assert.deepEqual(result.body.dispositions, {
      by_disposition: { FANNED_OUT: 1, FILTERED: 2 },
      by_reason: { ROUTE_IGNORED: 1, SEMANTIC_GATE_REJECTED: 1, TASK_CREATED: 1 },
      total: 3,
    })
  } finally {
    await server.close()
  }
})

// =====================================================================
//  负例 + 零写入 + 注册边界
// =====================================================================

test('负例（405/403/400/actor 覆盖/503）前后四张表行数全等（零写入）', async () => {
  const server = await startTasksServer({ database: isolatedDatabaseConfig(db) })
  const noDbServer = await startTasksServer({ database: null })
  try {
    const before = await tableCounts(db.pool)

    // 正例也不写库
    const ok = await httpCall(server, 'GET', TASKS_STATUS_PATH)
    assert.equal(ok.status, 200, ok.text)

    // 405：只有 GET
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const result = await httpCall(server, method, TASKS_STATUS_PATH)
      assert.equal(result.status, 405, `${method} 必须 405：${result.text}`)
      assert.equal(result.headers.get('allow'), 'GET')
    }
    // 403：不同源（缺标记头 / Origin 不同源）
    assertHttpError(
      await httpCall(server, 'GET', TASKS_STATUS_PATH, { omitRequestHeader: true }),
      403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED',
    )
    assertHttpError(
      await httpCall(server, 'GET', TASKS_STATUS_PATH, { headers: { origin: 'http://evil.example' } }),
      403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED',
    )
    // 400：未知查询参数
    assertHttpError(
      await httpCall(server, 'GET', `${TASKS_STATUS_PATH}?limit=10`),
      400, 'INVALID_ARGS', 'UNKNOWN_PARAM',
    )
    // 400：客户端企图覆盖 tenant/actor（query + header 两条）
    assertHttpError(
      await httpCall(server, 'GET', `${TASKS_STATUS_PATH}?tenant_id=${TENANT_B}`),
      400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
    )
    assertHttpError(
      await httpCall(server, 'GET', TASKS_STATUS_PATH, { headers: { 'x-recruitment-actor': TENANT_B } }),
      400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
    )
    // 503：部署配置没有数据库（不返回假空列表）
    const noDb = await httpCall(noDbServer, 'GET', TASKS_STATUS_PATH)
    assertHttpError(noDb, 503, 'NOT_CONFIGURED', 'DATABASE_NOT_CONFIGURED')
    assert.equal('counts' in noDb.body, false, '未配置时不得带任何 counts')
    const after = await tableCounts(db.pool)
    assert.deepEqual(after, before, '所有负例 + 一次正例前后，四张表行数必须逐表全等（零写入）')
    assert.deepEqual(before, {
      business_task: 9, // 本租户 8 + 反证租户 1
      task_attempt: 4, // 本租户 3 + 反证租户 1
      event_inbox: baseline.received + 9, // 基线 2 + 本租户 7（含 1 条状态迁移审计）+ 反证租户 2
      event_disposition: 4, // 本租户 3 + 反证租户 1
    })
  } finally {
    await server.close()
    await noDbServer.close()
  }
})

test('非回环 host：不注册路由（fail-closed）', async () => {
  const server = await startTasksServer({ database: isolatedDatabaseConfig(db), host: '0.0.0.0' })
  try {
    assert.deepEqual(server.registered, [], '非回环监听不允许注册任何路由')
    assert.equal(server.warnings.length, 1)
    assert.match(server.warnings[0]!, /不是回环地址/)
  } finally {
    await server.close()
  }
})

test('反证租户完全不可见：任一列表/计数里都没有它的 id', async () => {
  const server = await startTasksServer({ database: isolatedDatabaseConfig(db) })
  try {
    const result = await httpCall(server, 'GET', TASKS_STATUS_PATH)
    assert.equal(result.status, 200, result.text)
    for (const tenantBId of [TASK.tenantBRunning, ATTEMPT.tenantB, EVENT.tenantBReceived, EVENT.tenantBIgnored]) {
      assert.equal(result.text.includes(tenantBId), false, `响应里不许出现反证租户的 id ${tenantBId}`)
    }
    // 计数也不含它：stuck/running/attempts/events/dispositions 都已在上面的用例里逐项精确断言。
    const attempts = result.body.attempts as Record<string, unknown>[]
    assert.equal(attempts.some((row) => row.attempt_id === ATTEMPT.tenantB), false)
  } finally {
    await server.close()
  }
})
