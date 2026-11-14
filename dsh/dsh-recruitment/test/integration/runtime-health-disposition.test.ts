// 集成验收：`GET /recruitment/runtime/health` 的 `disposition` 段（G10 · 契约 API-CONTRACT.md §3/§4）。
//
// 这条测试要回答的问题只有一个：**health 上报的数字是不是库事实**。
// 所以对照物必须是"另一条独立路径从同一个库读回来的数"，而不是实现自己的返回值：
//   * 用 `registerRuntimeHttp()` 注册出来的**真 handler** 处理一次真 health 请求
//     （假 host 只负责把请求/响应对象捕获下来，handler 内部的取数逻辑全部真跑）；
//   * 期望值来自本文件**逐字保留**的契约 §3 SQL（同一个 pool 的独立 query）；
//   * 两边逐字段比：计数必须精确相等，`oldest_received_at` 精确相等，
//     `oldest_wait_seconds` 因两次读数跨时钟允许 0..2 秒时差并**记录实测值**。
//
// 两态（契约要求的"无处置数 / 最老等待秒"必须真的会变）：
//   态 1：直接 SQL 造 1 条 in-scope 未处置事件（normalizer_version 非 schema/0001、
//         dispatch_state='RECEIVED'、received_at 回退 120 秒）→ undisposed=1 + 最老两字段非空；
//   态 2：回退水位让它变成可派发事件，`processPending()` 让它**路由成功**（FANNED_OUT/TASK_*），
//         再投递一条真实事件 → undisposed=0、最老两字段回到 null（不是 0）。
//
// 库：`createIsolatedTestDatabase('g10_health')` 一次性空库（0001→0016 全量重放），
// 跑完 DROP。**绝不**碰共享库 ra_s6s7。密码只从 `RECRUITMENT_DB_PASSWORD` 读。
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { withActor } from '../../src/db/pool.ts'
import { EventRuntime, createPgEventDispositionSink } from '../../src/runtime/event-runtime.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { registerRuntimeHttp, type RuntimeHostContext, type RuntimeHttpOptions } from '../../src/runtime/http.ts'
import type { Router } from '../../src/runtime/router.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import type { TaskRuntime } from '../../src/runtime/task-runtime.ts'
import type { InboundEvent } from '../../src/runtime/types.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  FILE_NAMESPACE,
  HR_ACTOR,
  TENANT,
  type IsolatedTestDatabase,
} from './db.ts'

/** 假宿主的监听端口：同源校验要求 `Host` 与它逐字一致。 */
const PORT = 43211
/** 合法的同源头（回环 + 端口一致 + 带 `x-recruitment-request: 1`）。 */
const SAME_ORIGIN_HEADERS = { host: `127.0.0.1:${PORT}`, 'x-recruitment-request': '1' }
/** 业务对象 id（business_refs 是 JSONB，不做外键；与运行时测试同一稳定 id）。 */
const DEMO_INTERVIEW = '22222222-2222-4222-8222-000000000002'
/** 态 1 造的积压事件"已经等了多久"（秒）。 */
const BACKLOG_AGE_SECONDS = 120

/**
 * 契约 §3 的冻结口径 SQL（**逐字保留**：这是对照物，不是实现的抄本）。
 *
 * 分三个 CTE：scope（应处置事件）→ undisposed（其中还没有处置行的）→
 * 一条查询返回 8 个数；无积压时 oldest 两列是 SQL NULL（不是 0）。
 */
const RAW_DISPOSITION_SQL = `
with scope as (
  select e.event_id, e.received_at
    from recruitment.event_inbox e
   where e.tenant_id = $1::uuid
     and (e.normalizer_version is distinct from 'schema/0001'
          or e.event_type like 'semantic.%'
          or e.event_type like 'router.%')
), undisposed as (
  select s.event_id, s.received_at
    from scope s
   where not exists (
     select 1 from recruitment.event_disposition d
      where d.tenant_id = $1::uuid and d.event_id = s.event_id)
)
select
  (select count(*) from recruitment.event_inbox where tenant_id = $1::uuid)::text   as events_total,
  (select count(*) from recruitment.event_inbox
    where tenant_id = $1::uuid
      and not (normalizer_version is distinct from 'schema/0001'
               or event_type like 'semantic.%' or event_type like 'router.%'))::text as events_internal_audit,
  (select count(*) from scope)::text                                                 as events_in_scope,
  (select count(*) from recruitment.event_disposition where tenant_id = $1::uuid)::text as events_disposed,
  (select count(*) from scope s join recruitment.event_disposition d
      on d.tenant_id = $1::uuid and d.event_id = s.event_id)::text                   as events_disposed_in_scope,
  (select count(*) from undisposed)::text                                            as events_undisposed,
  (select floor(extract(epoch from (now() - min(received_at))))::text from undisposed) as oldest_wait_seconds,
  (select to_char(min(received_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     from undisposed)                                                                as oldest_received_at
`

/** raw SQL 的一行（bigint 一律以文本读回；两列可为 NULL）。 */
interface RawHealthRow {
  events_total: string
  events_internal_audit: string
  events_in_scope: string
  events_disposed: string
  events_disposed_in_scope: string
  events_undisposed: string
  oldest_wait_seconds: string | null
  oldest_received_at: string | null
}

/** health 响应体的窄形状（用 Record 承载，避免测试依赖实现的类型别名）。 */
interface HealthBody {
  ok: boolean
  counts: Record<string, number>
  disposition: Record<string, unknown>
  [key: string]: unknown
}

/** 一条被捕获的 `register({kind,path,handler})`。 */
interface CapturedRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

let db: IsolatedTestDatabase
let store: RuntimeStore
let events: EventRuntime
/** 由 `registerRuntimeHttp` 注册出来的真 handler（health 请求走它，不走网络）。 */
let handler: CapturedRoute['handler']

before(async () => {
  db = await createIsolatedTestDatabase('g10_health')
  // 守卫：真提交用例必须独占一次性库，不许回落到共享的 ra_s6s7。
  assertPrivateDatabase(db.name)
  assert.match(db.name, /^ra_g10_health_/, '库名必须是一次性库（ra_g10_health_<pid>_<rand>）')
  store = new RuntimeStore({ pool: db.pool, tenantId: TENANT, actorId: HR_ACTOR })
  const sink = createPgEventDispositionSink(db.pool, TENANT)
  events = new EventRuntime({ store, dispositions: sink })

  const routes: CapturedRoute[] = []
  const ctx: RuntimeHostContext = {
    webServer: {
      host: '127.0.0.1',
      port: PORT,
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    logger: { warn: () => {} },
  }
  const options: RuntimeHttpOptions = {
    store,
    // counts 走真 store：health 的 counts 必须是既有读数原样，不是另算一份。
    router: { counts: () => store.runtimeCounts() } as unknown as Router,
    events,
    tasks: { async read(): Promise<null> { return null } } as unknown as TaskRuntime,
  }
  registerRuntimeHttp(ctx, options)
  assert.equal(routes.length, 1, '运行时前缀路由必须注册一次')
  handler = routes[0]!.handler
})

after(async () => {
  if (db !== undefined) await db.drop()
})

/** 直接调用捕获到的 handler（不走网络；handler 内部的取数逻辑真跑）。 */
async function invoke(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number | undefined; headers: Record<string, unknown>; body: string }> {
  const out = { status: undefined as number | undefined, headers: {} as Record<string, unknown>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      out.status = status
      if (headers !== undefined) Object.assign(out.headers, headers)
      return res
    },
    end(chunk?: unknown) {
      out.body = chunk === undefined ? '' : String(chunk)
      return res
    },
  } as unknown as ServerResponse
  const req = {
    url,
    method: options.method ?? 'GET',
    headers: options.headers ?? SAME_ORIGIN_HEADERS,
  } as unknown as IncomingMessage
  await handler(req, res)
  return out
}

/** 发一次真 health 请求并解析 JSON（非 200 直接失败：健康端点不许 500）。 */
async function health(): Promise<HealthBody> {
  const response = await invoke('/recruitment/runtime/health')
  assert.equal(response.status, 200, `health 必须 200，实际 ${response.status}: ${response.body}`)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  return JSON.parse(response.body) as HealthBody
}

/** 独立读回：同一个 pool 的另一条 query（不经过运行时/store 的计数路径）。 */
async function rawHealth(): Promise<RawHealthRow> {
  const { rows } = await db.pool.query<RawHealthRow>(RAW_DISPOSITION_SQL, [TENANT])
  const row = rows[0]
  assert.ok(row, 'raw SQL 必须返回一行')
  return row
}

/**
 * 逐字段对账：8 个读数里 6 个计数精确相等，`oldest_received_at` 精确相等，
 * `oldest_wait_seconds` 允许 0..2 秒时差（两次读数之间时钟会走）并返回实测值。
 * @returns health 报的 `events_undisposed_oldest_wait_seconds`（无积压时 null）。
 */
function assertMatchesRaw(actual: Record<string, unknown>, raw: RawHealthRow, label: string): number | null {
  assert.equal(actual.available, true, `${label}: 已挂 sink 必须 available=true`)
  assert.equal(actual.events_total, Number(raw.events_total), `${label}: events_total`)
  assert.equal(actual.events_internal_audit, Number(raw.events_internal_audit), `${label}: events_internal_audit`)
  assert.equal(actual.events_in_scope, Number(raw.events_in_scope), `${label}: events_in_scope`)
  assert.equal(actual.events_disposed, Number(raw.events_disposed), `${label}: events_disposed`)
  assert.equal(actual.events_disposed_in_scope, Number(raw.events_disposed_in_scope), `${label}: events_disposed_in_scope`)
  assert.equal(actual.events_undisposed, Number(raw.events_undisposed), `${label}: events_undisposed`)
  // 最老时间戳是**稳定**值：两边必须逐字相等（秒数会随时间增长，时间戳不会）。
  assert.equal(
    actual.events_undisposed_oldest_received_at,
    raw.oldest_received_at,
    `${label}: oldest_received_at 必须与独立读回精确相等`,
  )
  if (raw.oldest_wait_seconds === null) {
    assert.equal(actual.events_undisposed_oldest_wait_seconds, null, `${label}: 无积压时秒数必须是 null 而不是 0`)
    return null
  }
  const reported = actual.events_undisposed_oldest_wait_seconds
  assert.equal(typeof reported, 'number', `${label}: 有积压时秒数必须是数字`)
  const drift = Math.abs((reported as number) - Number(raw.oldest_wait_seconds))
  assert.ok(drift <= 2, `${label}: oldest_wait_seconds 时差 ${drift}s 超过允许的 2s（health=${reported} raw=${raw.oldest_wait_seconds}）`)
  return reported as number
}

/**
 * counts 原样透传校验：键集必须完全一致；除时间派生键外逐值相等，
 * `*_wait_seconds` 允许 0..2 秒漂移（两次调用之间时钟会走）。
 */
async function assertCountsFidelity(actual: Record<string, number>, label: string): Promise<void> {
  const expected = await store.runtimeCounts()
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: counts 键集必须与 runtimeCounts() 完全一致`)
  for (const key of Object.keys(expected)) {
    const drift = Math.abs(Number(actual[key]) - Number(expected[key]))
    if (key.endsWith('_wait_seconds')) {
      assert.ok(drift <= 2, `${label}: counts.${key} 漂移 ${drift}s 超过 2s`)
    } else {
      assert.equal(Number(actual[key]), Number(expected[key]), `${label}: counts.${key} 必须原样透传`)
    }
  }
}

/** 态 1 夹具：直接 SQL 造一条 in-scope、未处置、已是终态前的 RECEIVED 事件。 */
async function insertInScopeUndisposedEvent(name: string): Promise<string> {
  const { rows } = await db.pool.query<{ event_id: string }>(
    `insert into recruitment.event_inbox (
       tenant_id, provider, provider_event_id, event_type, schema_version,
       occurred_at, idempotency_key, idempotency_source,
       payload, trust_level, normalized_event_type, normalizer_version,
       dispatch_state, received_at, recorded_at
     ) values (
       $1::uuid, 'internal', $2, $3, 1,
       now() - interval '3 minutes', $4, 'PROVIDER_EVENT_ID',
       $5::jsonb, 'INTERNAL', $3, 'runtime/0011',
       'RECEIVED', now() - ($6 || ' seconds')::interval, now()
     )
     returning event_id::text as event_id`,
    [
      TENANT,
      `g10b-provider-${name}`,
      EVENT_TYPES.SCORECARD_SUBMIT,
      `g10b:${FILE_NAMESPACE}:${name}`,
      JSON.stringify({ interview_id: DEMO_INTERVIEW, payload_hash: 'c'.repeat(64) }),
      String(BACKLOG_AGE_SECONDS),
    ],
  )
  const eventId = rows[0]?.event_id
  assert.ok(eventId, '夹具事件必须落库并返回 event_id')
  return eventId
}

/** 一条真实的 `scorecard.submit` 事件（运行时测试同款；走 receive 的真实路由路径）。 */
function scorecardEvent(providerEventId: string, payloadHash: string): InboundEvent {
  return {
    tenantId: TENANT,
    provider: 'internal',
    providerEventId,
    eventType: EVENT_TYPES.SCORECARD_SUBMIT,
    occurredAt: '2026-11-15T04:00:00.000Z',
    payload: { interview_id: DEMO_INTERVIEW, payload_hash: payloadHash },
    trustLevel: 'INTERNAL',
  }
}

/** 按 event_id 读回处置行（独立 SQL，不 import 产品代码的读回实现）。 */
async function readDispositions(eventIds: readonly string[]): Promise<Array<{
  event_id: string
  disposition: string
  reason_code: string
  target_task_ids: string
}>> {
  const { rows } = await db.pool.query<{
    event_id: string
    disposition: string
    reason_code: string
    target_task_ids: string
  }>(
    `select event_id::text as event_id, disposition, reason_code, target_task_ids::text as target_task_ids
       from recruitment.event_disposition
      where tenant_id = $1::uuid and event_id = any($2::uuid[])
      order by event_id`,
    [TENANT, [...eventIds]],
  )
  return rows
}

describe('GET /recruitment/runtime/health: disposition 读数与独立 SQL 读回一致', () => {
  test('基线：空库无积压 → in-scope=0、最老两字段 null；counts 原样透传', async (t) => {
    const body = await health()
    assert.equal(body.ok, true)
    const disposition = body.disposition
    assert.equal(disposition.available, true)
    assert.equal(disposition.events_in_scope, 0, '种子事件是 schema/0001 内部审计，不计入应处置')
    assert.equal(disposition.events_disposed, 0)
    assert.equal(disposition.events_undisposed, 0)
    assert.equal(disposition.events_undisposed_oldest_wait_seconds, null, '无积压必须是 null，不是 0')
    assert.equal(disposition.events_undisposed_oldest_received_at, null)
    assert.equal(disposition.write_failures, 0)
    assert.equal(disposition.last_write_error, null)
    // 内部审计事件是"透明展示"的独立读数，不是被丢掉：总数 = 内部审计 + 应处置。
    assert.equal(
      disposition.events_total,
      (disposition.events_internal_audit as number) + (disposition.events_in_scope as number),
      'events_total 必须 = internal_audit + in_scope',
    )
    t.diagnostic(`baseline: total=${disposition.events_total} internal_audit=${disposition.events_internal_audit} in_scope=${disposition.events_in_scope}`)
    t.diagnostic(`isolated db: ${db.name}（跑完 drop database ... with (force)）`)
    assertMatchesRaw(disposition, await rawHealth(), 'baseline')
    await assertCountsFidelity(body.counts, 'baseline')
    // 空库里没有任何处置行（0016 回填只回填 IGNORED/ROUTED 历史，此处没有）。
    const { rows } = await db.pool.query<{ n: string }>('select count(*)::text as n from recruitment.event_disposition')
    assert.equal(Number(rows[0]!.n), 0)
  })

  test('态1 有 1 条 in-scope 未处置事件 → undisposed=1 + 最老等待秒非空；态2 路由成功后归 0/null', async (t) => {
    // ---------- 态 1：直接 SQL 造一条未处置的在范围内事件 ----------
    const backlogEventId = await insertInScopeUndisposedEvent('backlog')
    const state1 = await health()
    const d1 = state1.disposition
    assert.equal(d1.events_in_scope, 1, '这条事件属于应处置范围')
    assert.equal(d1.events_disposed, 0)
    assert.equal(d1.events_disposed_in_scope, 0)
    assert.equal(d1.events_undisposed, 1)
    assert.equal(typeof d1.events_undisposed_oldest_received_at, 'string', '有积压时最老时间必须非空')
    const oldestRaw1 = await rawHealth()
    const reportedWait = assertMatchesRaw(d1, oldestRaw1, 'state1')
    // 秒数必须是真的"等了 120 秒"量级，而不是硬编码 0（这就是这个字段存在的理由）。
    assert.ok((reportedWait ?? -1) >= BACKLOG_AGE_SECONDS, `态1 最老等待秒必须 >= ${BACKLOG_AGE_SECONDS}s，实际 ${reportedWait}`)
    assert.equal(d1.write_failures, 0)
    assert.equal(d1.last_write_error, null)
    t.diagnostic(`state1: undisposed=${d1.events_undisposed} oldest_wait_seconds=${reportedWait} oldest_received_at=${d1.events_undisposed_oldest_received_at}`)
    await assertCountsFidelity(state1.counts, 'state1')

    // ---------- 态 2：让积压事件真的路由成功 + 再投递一条真实事件 ----------
    // 回退水位：造出来的事件 received_at（120 秒前）要晚于水位才会被 tick 派发。
    // 走产品函数（带 actor + 理由 + 审计行），不是直接 UPDATE 水位表。
    await withActor(db.pool, HR_ACTOR, async (client) => {
      await client.query(
        `select recruitment.fn_runtime_watermark_rewind(
           $1::uuid, now() - interval '10 minutes',
           'G10-B 集成测试：回退水位以派发测试造的历史事件（一次性库）')`,
        [TENANT],
      )
    })

    const receipt = await events.receive(scorecardEvent(`g10b-real-${FILE_NAMESPACE}`, 'd'.repeat(64)))
    assert.equal(receipt.outcome, 'stored')
    assert.equal(receipt.dispatchState, 'ROUTED', '真实事件必须路由成功')
    assert.equal(receipt.taskCreated, true, '首条事件必须创建 Task（否则"路由成功"没有业务后果）')
    assert.ok(receipt.taskId, '路由成功必须带回 task id')

    const processed = await events.processPending()
    const swept = processed.find((item) => item.eventId === backlogEventId)
    assert.ok(swept, '积压事件必须被 processPending 处理到')
    assert.equal(swept!.dispatchState, 'ROUTED', '积压事件必须路由成功（不是只被标记）')

    const state2 = await health()
    const d2 = state2.disposition
    assert.equal(d2.events_undisposed, 0, '两条事件都有处置后必须归 0')
    assert.equal(d2.events_undisposed_oldest_wait_seconds, null, '无积压时秒数回到 null（不是 0）')
    assert.equal(d2.events_undisposed_oldest_received_at, null)
    assert.equal(d2.events_disposed, d2.events_in_scope, '稳态下每条应处置事件都有一行处置')
    assert.equal(d2.events_disposed_in_scope, d2.events_in_scope)
    assert.equal(d2.write_failures, 0, '写处置不得失败')
    assert.equal(d2.last_write_error, null)
    assertMatchesRaw(d2, await rawHealth(), 'state2')
    t.diagnostic(`state2: disposed=${d2.events_disposed} in_scope=${d2.events_in_scope} undisposed=${d2.events_undisposed}`)
    await assertCountsFidelity(state2.counts, 'state2')

    // 独立 SQL 读回两条处置：都应是 FANNED_OUT，且创建/唤醒各一次（同一个 INTERVIEW 业务对象）。
    const rows = await readDispositions([backlogEventId, receipt.eventId])
    assert.equal(rows.length, 2, '两条事件必须各留下恰好一行处置')
    for (const row of rows) assert.equal(row.disposition, 'FANNED_OUT', '确定性路由产生扇出处置')
    assert.deepEqual(
      rows.map((row) => row.reason_code).sort(),
      ['TASK_CREATED', 'TASK_WOKEN'],
      '同业务对象：第一条建 Task，第二条唤醒已有 Task（原因码必须区分）',
    )
    const realRow = rows.find((row) => row.event_id === receipt.eventId)!
    assert.deepEqual(JSON.parse(realRow.target_task_ids), [receipt.taskId], '处置里的 target_task_ids 必须指向真实 task')
  })

  test('未挂 sink 的运行时：即使库里有数据也如实报 available:false + 全 null（不拿 0 冒充）', async () => {
    const routes: CapturedRoute[] = []
    const ctx: RuntimeHostContext = {
      webServer: {
        host: '127.0.0.1',
        port: PORT,
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    }
    // 同一个真 store，但运行时实例**没有**挂处置 sink（= 未接线的树上的形态）。
    registerRuntimeHttp(ctx, {
      store,
      router: { counts: () => store.runtimeCounts() } as unknown as Router,
      events: new EventRuntime({ store }),
      tasks: { async read(): Promise<null> { return null } } as unknown as TaskRuntime,
    })
    assert.equal(routes.length, 1)
    const saved = handler
    handler = routes[0]!.handler
    try {
      const body = await health()
      assert.deepEqual(body.disposition, {
        available: false,
        reason: 'DISPOSITION_SINK_NOT_ATTACHED',
        events_total: null,
        events_internal_audit: null,
        events_in_scope: null,
        events_disposed: null,
        events_disposed_in_scope: null,
        events_undisposed: null,
        events_undisposed_oldest_wait_seconds: null,
        events_undisposed_oldest_received_at: null,
        write_failures: 0,
        last_write_error: null,
      })
      // 库里此刻明明有 2 条已处置事件：报 null 而不是 0 才是"如实不可用"。
      const raw = await rawHealth()
      assert.ok(Number(raw.events_disposed) > 0, '前置：库里确实有处置行')
      await assertCountsFidelity(body.counts, 'not-attached')
    } finally {
      handler = saved
    }
  })
})
