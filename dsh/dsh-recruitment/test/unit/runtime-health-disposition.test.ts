// 单测：`GET /recruitment/runtime/health` 的 `disposition` 段（G10 · 契约 API-CONTRACT.md §4）。
//
// 为什么不连库也能证明这件事：health 的处置段只有一个数据来源——
// `EventRuntime.dispositionHealth()`。本测试用**真 EventRuntime**（A 的实现）
// 配假 store + 假 sink，把「已挂 sink / 未挂 sink」两态的**完整 JSON** 与
// 契约 §4 的冻结形状做 deepEqual：多一个键、少一个键、把 null 换成 0 都会红。
//
// counts 部分用固定假对象断言 deepEqual：这条端点的既有消费者零影响，
// 不是"看起来没动"，而是"一个键都没动"。
//
// 其余路由行为（前缀外 404 / 跨源·缺头 403 / 未知 runtime 路径 405 / 非回环不注册）
// 在同一份测试里回归，因为它们和 health 共用同一个 handler 前置逻辑。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import type { EventDispositionHealth, EventDispositionSink } from '../../src/runtime/event-runtime.ts'
import { registerRuntimeHttp, type RuntimeHostContext, type RuntimeHttpOptions } from '../../src/runtime/http.ts'
import type { Router } from '../../src/runtime/router.ts'
import type { RuntimeStore } from '../../src/runtime/store.ts'
import type { TaskRuntime } from '../../src/runtime/task-runtime.ts'

/** 与 0002_seed / 运行时配置一致的演示租户（本测试不连库，只用于对象构造）。 */
const TENANT = '11111111-1111-4111-8111-000000000001'
/** 假宿主的监听端口：同源校验用的 `Host` 必须与它一致。 */
const PORT = 43117
/** 合法的同源头（回环 + 端口一致 + 带 `x-recruitment-request: 1`）。 */
const SAME_ORIGIN_HEADERS = { host: `127.0.0.1:${PORT}`, 'x-recruitment-request': '1' }

/** 一条被寄存器捕获到的 `register({kind,path,handler})` 调用。 */
interface CapturedRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 假宿主：host/port 可控，register 只记录不监听。 */
function createHost(host = '127.0.0.1'): {
  ctx: RuntimeHostContext
  routes: CapturedRoute[]
  warnings: string[]
} {
  const routes: CapturedRoute[] = []
  const warnings: string[] = []
  const ctx: RuntimeHostContext = {
    webServer: {
      host,
      port: PORT,
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    logger: { warn: (message: string) => warnings.push(message) },
  }
  return { ctx, routes, warnings }
}

/** 一次假请求的抓取结果（status / 头 / 原始 body）。 */
interface CapturedResponse {
  status: number | undefined
  headers: Record<string, unknown>
  body: string
  json: unknown
}

/** 直接调用捕获到的 handler（不走网络；handler 内部逻辑真跑）。 */
async function invoke(
  handler: CapturedRoute['handler'],
  options: { url: string; method?: string; headers?: Record<string, string> },
): Promise<CapturedResponse> {
  const out: CapturedResponse = { status: undefined, headers: {}, body: '', json: undefined }
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      out.status = status
      if (headers !== undefined) Object.assign(out.headers, headers)
      return res
    },
    end(chunk?: unknown) {
      out.body = chunk === undefined ? '' : String(chunk)
      out.json = out.body === '' ? undefined : JSON.parse(out.body)
      return res
    },
  } as unknown as ServerResponse
  const req = {
    url: options.url,
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
  } as unknown as IncomingMessage
  await handler(req, res)
  return out
}

/** 假 store：EventRuntime 只需要 `tenant`（本测试不路由事件，只读处置健康度）。 */
function fakeStore(): RuntimeStore {
  return { tenant: TENANT } as unknown as RuntimeStore
}

/** 假 Router：`counts()` 返回固定对象，并记录被调次数（403/404 必须不取数）。 */
function fakeRouter(counts: Record<string, number>): { router: Router; calls: () => number } {
  let countCalls = 0
  const router = {
    async counts(): Promise<Record<string, number>> {
      countCalls += 1
      return counts
    },
  } as unknown as Router
  return { router, calls: () => countCalls }
}

/** 最小假 TaskRuntime：health 不读任务（但 RuntimeHttpOptions 要求这个字段）。 */
function fakeTasks(): TaskRuntime {
  return { async read(): Promise<null> { return null } } as unknown as TaskRuntime
}

/** 假 sink：实现 `EventDispositionSink` 契约的全部两个方法，health 返回给定库事实。 */
function fakeSink(health: EventDispositionHealth): {
  sink: EventDispositionSink
  calls: { record: number; health: number }
} {
  const calls = { record: 0, health: 0 }
  const sink: EventDispositionSink = {
    async record(): Promise<boolean> {
      calls.record += 1
      return true
    },
    async health(): Promise<EventDispositionHealth> {
      calls.health += 1
      return health
    },
  }
  return { sink, calls }
}

/** 固定的 counts 对象：断言原样透传（键值都不许被 health 改名/过滤）。 */
const FIXED_COUNTS: Record<string, number> = {
  events: 7,
  events_routed: 3,
  events_failed: 1,
  tasks: 2,
  tasks_succeeded: 1,
  tasks_failed: 0,
  attempts: 4,
  sessions: 2,
  events_legacy_undispatched: 5,
  events_legacy_undispatched_ignored: 4,
  events_legacy_internal_audit: 11,
  events_before_cutover_pending: 0,
  events_ignored_before_cutover: 4,
  events_legacy_oldest_wait_seconds: 0,
}

/** 契约 §4 未挂 sink 的冻结形状（available:false + 全 null + 原因）。 */
const NOT_ATTACHED = {
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
}

/** 注册一次运行时路由并取回 health handler。 */
function register(options: {
  events: EventRuntime
  counts?: Record<string, number>
  host?: string
}): {
  healthRoute: CapturedRoute | undefined
  routerCalls: () => number
  warnings: string[]
} {
  const { ctx, routes, warnings } = createHost(options.host ?? '127.0.0.1')
  const { router, calls } = fakeRouter(options.counts ?? FIXED_COUNTS)
  const httpOptions: RuntimeHttpOptions = {
    store: fakeStore(),
    router,
    events: options.events,
    tasks: fakeTasks(),
  }
  registerRuntimeHttp(ctx, httpOptions)
  const healthRoute = routes.find((route) => route.path === '/recruitment/runtime' && route.kind === 'prefix')
  return { healthRoute, routerCalls: calls, warnings }
}

const HEALTH_URL = '/recruitment/runtime/health'

describe('GET /recruitment/runtime/health: disposition 段（G10 契约 §4）', () => {
  test('已挂 sink：disposition 十一个字段按契约形状透传，counts 一个键都不动', async () => {
    // 有积压的真实读数：数字照抄，null 照抄（不是 0）。
    const backlog: EventDispositionHealth = {
      eventsTotal: 20,
      eventsInternalAudit: 17,
      eventsInScope: 3,
      eventsDisposed: 2,
      eventsDisposedInScope: 2,
      eventsUndisposed: 1,
      eventsUndisposedOldestWaitSeconds: 137,
      eventsUndisposedOldestReceivedAt: '2026-11-15T03:00:00.000Z',
    }
    const { sink, calls } = fakeSink(backlog)
    const events = new EventRuntime({ store: fakeStore(), dispositions: sink })
    const { healthRoute, routerCalls } = register({ events })
    assert.ok(healthRoute, '运行时前缀路由必须注册')

    const response = await invoke(healthRoute.handler, { url: HEALTH_URL, headers: SAME_ORIGIN_HEADERS })
    assert.equal(response.status, 200)
    // 冻结形状：whole-body deepEqual（多键/少键/改名都会红）。
    assert.deepEqual(response.json, {
      ok: true,
      counts: FIXED_COUNTS,
      disposition: {
        available: true,
        events_total: 20,
        events_internal_audit: 17,
        events_in_scope: 3,
        events_disposed: 2,
        events_disposed_in_scope: 2,
        events_undisposed: 1,
        events_undisposed_oldest_wait_seconds: 137,
        events_undisposed_oldest_received_at: '2026-11-15T03:00:00.000Z',
        write_failures: 0,
        last_write_error: null,
      },
    })
    // counts 是原样对象（不是被 health 重新拼的 0）。
    assert.deepEqual((response.json as { counts: unknown }).counts, FIXED_COUNTS)
    assert.equal(calls.health, 1, 'health 每请求只读一次库事实（不做两次读数）')
    assert.equal(calls.record, 0, 'health 是只读端点，不写处置')
    assert.equal(routerCalls(), 1, 'counts 必须被调用（既有读数不退化）')
    // 安全头不退化
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  })

  test('已挂 sink 但无积压：最老等待两字段是 null（不是 0），write_failures 如实照抄', async () => {
    const clean: EventDispositionHealth = {
      eventsTotal: 20,
      eventsInternalAudit: 17,
      eventsInScope: 3,
      eventsDisposed: 3,
      eventsDisposedInScope: 3,
      eventsUndisposed: 0,
      eventsUndisposedOldestWaitSeconds: null,
      eventsUndisposedOldestReceivedAt: null,
    }
    const { sink } = fakeSink(clean)
    const events = new EventRuntime({ store: fakeStore(), dispositions: sink })
    const { healthRoute } = register({ events })
    assert.ok(healthRoute)

    const response = await invoke(healthRoute.handler, { url: HEALTH_URL, headers: SAME_ORIGIN_HEADERS })
    assert.equal(response.status, 200)
    const disposition = (response.json as { disposition: Record<string, unknown> }).disposition
    assert.equal(disposition.available, true)
    assert.equal(disposition.events_undisposed, 0)
    assert.equal(disposition.events_undisposed_oldest_wait_seconds, null)
    assert.equal(disposition.events_undisposed_oldest_received_at, null)
    assert.equal(disposition.write_failures, 0)
    assert.equal(disposition.last_write_error, null)
  })

  test('未挂 sink：available:false + reason + 全 null（绝不用 0 冒充真实读数）', async () => {
    const events = new EventRuntime({ store: fakeStore() })
    // 契约 §1：未挂 sink 时 dispositionHealth() 必须返回 null，由 http 层如实报不可用。
    assert.equal(await events.dispositionHealth(), null)
    const { healthRoute, routerCalls } = register({ events })
    assert.ok(healthRoute)

    const response = await invoke(healthRoute.handler, { url: HEALTH_URL, headers: SAME_ORIGIN_HEADERS })
    assert.equal(response.status, 200)
    assert.deepEqual(response.json, { ok: true, counts: FIXED_COUNTS, disposition: NOT_ATTACHED })
    // 数据字段一个都不是数字 0（只有 write_failures 允许为 0：进程内计数器初值）。
    const disposition = (response.json as { disposition: Record<string, unknown> }).disposition
    for (const field of [
      'events_total',
      'events_internal_audit',
      'events_in_scope',
      'events_disposed',
      'events_disposed_in_scope',
      'events_undisposed',
      'events_undisposed_oldest_wait_seconds',
      'events_undisposed_oldest_received_at',
    ]) {
      assert.equal(disposition[field], null, `${field} 必须是 null，不许拿 0 冒充`)
    }
    assert.equal(routerCalls(), 1, '未挂 sink 不影响既有 counts')
  })
})

describe('health 之外：同源/回环安全与其它路由行为不变', () => {
  test('非 runtime 前缀 → 404，且不读任何库计数', async () => {
    const { healthRoute, routerCalls } = register({ events: new EventRuntime({ store: fakeStore() }) })
    assert.ok(healthRoute)
    const response = await invoke(healthRoute.handler, {
      url: '/recruitment/api/overview',
      headers: SAME_ORIGIN_HEADERS,
    })
    assert.equal(response.status, 404)
    assert.deepEqual(response.json, { error: 'not found' })
    assert.equal(routerCalls(), 0)
  })

  test('跨源 Host / 缺 x-recruitment-request / 带外部 Origin → 403（health 也一样）', async () => {
    const { healthRoute, routerCalls } = register({ events: new EventRuntime({ store: fakeStore() }) })
    assert.ok(healthRoute)
    const cases: Array<Record<string, string>> = [
      { host: `evil.example:${PORT}`, 'x-recruitment-request': '1' },
      { host: `127.0.0.1:${PORT + 1}`, 'x-recruitment-request': '1' },
      { host: `127.0.0.1:${PORT}` },
      { host: `127.0.0.1:${PORT}`, 'x-recruitment-request': '1', origin: 'http://evil.example' },
    ]
    for (const headers of cases) {
      const response = await invoke(healthRoute.handler, { url: HEALTH_URL, headers })
      assert.equal(response.status, 403, `headers=${JSON.stringify(headers)} 必须被拒`)
      assert.equal((response.json as { error: string }).error, 'same-origin loopback request required')
    }
    assert.equal(routerCalls(), 0, '403 必须在取数之前返回')
  })

  test('未知 runtime 路径 / health 非 GET → 405（allow 头不变）', async () => {
    const { healthRoute } = register({ events: new EventRuntime({ store: fakeStore() }) })
    assert.ok(healthRoute)
    for (const request of [
      { url: '/recruitment/runtime/nope' },
      { url: HEALTH_URL, method: 'POST' },
    ]) {
      const response = await invoke(healthRoute.handler, { ...request, headers: SAME_ORIGIN_HEADERS })
      assert.equal(response.status, 405, `${request.method ?? 'GET'} ${request.url} 必须是 405`)
      assert.equal(response.headers.allow, 'GET, POST')
      assert.equal(response.body, '')
    }
  })

  test('非回环 webServer.host → 不注册路由并告警（fail closed 不变）', async () => {
    const { ctx, routes, warnings } = createHost('0.0.0.0')
    const disposer = registerRuntimeHttp(ctx, {
      store: fakeStore(),
      router: fakeRouter(FIXED_COUNTS).router,
      events: new EventRuntime({ store: fakeStore() }),
      tasks: fakeTasks(),
    })
    assert.deepEqual(routes, [], '非回环地址不许注册运行时路由')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /不是回环地址/)
    disposer()
  })
})
