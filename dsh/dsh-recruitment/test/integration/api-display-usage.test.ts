// 集成测试：`GET /recruitment/api/usage?session_id=…`（CONTRACT §2 / §0）。
//
// 这条测试**不连数据库**：DSH 计量的来源是插件进程内的服务（`ctx.get('sessions')` /
// `ctx.get('sessionProjections')`），生产上用 DSH 的持久事实；测试用 fake `DshUsageAccess`
// 驱动**真 node:http + listen(0) + fetch**（不打桩 handler），断言：
//   * 200 的每个字段与 fake 投影值**逐字相等**（totals / context / context_breakdown /
//     session_stats / last 的 turn-step-buckets / contextWindow / as_of_seq）；
//   * 缺失的 projection key 进 `missing`、对应字段 `null`（**不补 0、不重算**）；
//   * `last` 两条路：优先 DSH fold（`stateOf`），回退事件扫描（≤500 条）；取不到 = null；
//   * 负例：400（缺参/未知参数）、403（不同源）、405（非 GET）、404（session 非 live）、
//     503（服务未挂载 / 投影读失败，且响应里**没有 totals 键**）；
//   * `quota` 恒 null + `quota_note`（不编造额度数字）；
//   * `resolveDshUsageAccess` 在「服务在 / get 抛错 / 没有 get」下分别返回适配器/null 且不抛；
//   * 非回环 host 不注册路由（fail-closed）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  registerDisplayUsageHttp,
  resolveDshUsageAccess,
  USAGE_CONTRACT_VERSION,
  USAGE_PATH,
  USAGE_QUOTA_NOTE,
  type DshSessionEventLike,
  type DshSessionLike,
  type DshSessionProjectionsLike,
  type DshSessionStoreLike,
  type DshUsageAccess,
  type DshUsageHostContext,
} from '../../src/http/display-usage.ts'

// =====================================================================
//  夹具：fake DSH 服务（形状与真实 DSH 服务一致的最小面）
// =====================================================================

/** 固定时钟：`captured_at` 必须逐字等于它。 */
const FIXED_NOW = new Date('2026-11-16T10:00:00.000Z')
const NOW_ISO = FIXED_NOW.toISOString()
/** 一个活会话 id（DSH 的 session id 是字符串，不是 UUID）。 */
const LIVE_SESSION = 'session-usage-live'
/** 同源头：Host 必须与真实监听端口逐字一致（harness 里拼好）。 */
const REQUEST_HEADER = 'x-recruitment-request'

/** 四个投影 key（CONTRACT §2）。 */
const PROJECTION_KEYS = ['tokenUsage', 'contextPressure', 'contextBreakdown', 'sessionStats']

/** fake 投影值：四桶 / context（含 contextWindow）/ 组成 / 会话统计。 */
const VALUES = {
  tokenUsage: { uncachedInputTokens: 1234, outputTokens: 567, cacheReadTokens: 890, cacheWriteTokens: 12 },
  contextPressure: { pressureTokens: 2136, projectedTokens: 2400, contextWindow: 1000000 },
  contextBreakdown: { systemTokens: 100, toolsTokens: 200, messageTokens: 300 },
  sessionStats: {
    turns: 3, steps: 5, llmMs: 1234, toolMs: 567, ttftMs: 89, ttftSteps: 2, decodeMs: 3456, decodeTokens: 789,
  },
} as const

/** DSH fold 里的 `last`（权威的 turn/step/buckets）。 */
const FOLD_LAST = {
  turn: 3,
  step: 2,
  buckets: { uncachedInputTokens: 1234, outputTokens: 567, cacheReadTokens: 890, cacheWriteTokens: 12 },
} as const

/** 造一个 fake live session：`seq = events.length`，`eventAt(i) = events[i]`。 */
function makeSession(id: string, events: readonly DshSessionEventLike[]): DshSessionLike {
  return {
    id,
    seq: events.length,
    eventAt(seq: number): DshSessionEventLike | undefined {
      return events[seq]
    },
  }
}

/** 造一条 `assistant/message`（可选带 usage）。 */
function assistantMessage(turn: number, step: number, usage?: Record<string, unknown>): DshSessionEventLike {
  return {
    type: 'assistant/message',
    data: { turn, step, ...usage === undefined ? {} : { usage } },
  }
}

/** 造一次快照（`values` 可裁剪，用于 missing 用例）。 */
function makeSnapshot(
  values: Readonly<Record<string, unknown>>,
  asOfSeq: number,
): { asOfSeq: number; values: Readonly<Record<string, unknown>> } {
  return { asOfSeq, values }
}

/** fake DshUsageAccess 的可选部件（缺省 = 不可用）。 */
interface FakeAccessOptions {
  readonly session?: DshSessionLike | null
  readonly snapshot?: DshSessionProjectionsLike['snapshot']
  readonly stateOf?: DshSessionProjectionsLike['stateOf']
  readonly tokenMeter?: unknown
}

/** 造 fake `DshUsageAccess`；`onSnapshotKeys` 记录端点实际请求的 key 列表。 */
function makeAccess(options: FakeAccessOptions = {}, onSnapshotKeys?: (keys: readonly string[]) => void): DshUsageAccess {
  const session = options.session === undefined ? makeSession(LIVE_SESSION, []) : options.session
  const sessions: DshSessionStoreLike = {
    get(id: string): DshSessionLike | undefined {
      if (session === null) return undefined
      return id === (session.id as string) ? session : undefined
    },
  }
  const snapshot = options.snapshot ?? ((target: DshSessionLike, keys: readonly string[]) => {
    onSnapshotKeys?.(keys)
    void target
    return makeSnapshot(VALUES, 11)
  })
  const projections: DshSessionProjectionsLike = {
    snapshot,
    ...options.stateOf === undefined ? {} : { stateOf: options.stateOf },
  }
  return {
    sessions,
    projections,
    ...options.tokenMeter === undefined ? {} : { tokenMeter: options.tokenMeter },
  }
}

// =====================================================================
//  harness：真 node:http + listen(0) + fetch（模拟宿主 webServer.register）
// =====================================================================

interface CapturedRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: Parameters<DshUsageHostContext['webServer']['register']>[0]['handler']
}

interface UsageServer {
  readonly baseUrl: string
  readonly port: number
  readonly registered: readonly CapturedRoute[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

/** 起真 http server，并用 `registerDisplayUsageHttp` 在其上注册路由（端口来自 listen(0)）。 */
async function startUsageServer(options: {
  readonly dsh?: DshUsageAccess | null
  readonly host?: string
  readonly getService?: (name: string) => unknown
  readonly now?: () => Date
}): Promise<UsageServer> {
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
  const ctx: DshUsageHostContext = {
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
    ...options.getService === undefined ? {} : { get: options.getService },
  }
  const dispose = options.dsh === undefined && options.getService === undefined
    ? registerDisplayUsageHttp(ctx, { now: options.now ?? (() => FIXED_NOW) })
    : registerDisplayUsageHttp(ctx, {
        ...options.dsh === undefined ? {} : { dsh: options.dsh },
        now: options.now ?? (() => FIXED_NOW),
      })
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

/** 一次 HTTP 调用。 */
interface HttpResult {
  readonly status: number
  readonly text: string
  readonly body: Record<string, unknown>
  readonly headers: Headers
}

/**
 * 发一次请求（默认带同源头与 Host 由 fetch 自动生成；需要模拟不同源时显式覆盖）。
 * @param target - harness。
 * @param method - HTTP 方法。
 * @param path - 路径（含 query）。
 * @param options - 额外头 / 是否省略同源头。
 */
async function httpCall(
  target: Pick<UsageServer, 'baseUrl'>,
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

/** 断言一个封闭错误体（`{"error":{code,reason_code,message}}`）。 */
function assertHttpError(result: HttpResult, status: number, code: string, reasonCode: string): void {
  assert.equal(result.status, status, `HTTP 状态应为 ${status}：${result.text}`)
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `响应必须是 {"error":{...}}：${result.text}`)
  assert.equal(error.code, code, `error.code 应为 ${code}：${result.text}`)
  assert.equal(error.reason_code, reasonCode, `error.reason_code 应为 ${reasonCode}：${result.text}`)
  assert.equal(typeof error.message, 'string', 'error.message 必须是字符串')
}

/** 响应里绝不允许出现机器绝对路径（R7 / CONTRACT §0）。 */
function assertNoMachinePath(text: string): void {
  assert.equal(/[A-Za-z]:\\/.test(text), false, `响应里不允许出现机器绝对路径：${text}`)
  assert.equal(/\\\\[./]/.test(text), false, `响应里不允许出现 UNC 路径：${text}`)
}

// =====================================================================
//  200 正例
// =====================================================================

test('200：四个投影值原样透出 + last 来自 DSH fold + captured_at 用注入时钟', async () => {
  let seenKeys: readonly string[] = []
  const access = makeAccess({
    snapshot: (session, keys) => {
      seenKeys = keys
      assert.equal((session.id as string), LIVE_SESSION)
      return makeSnapshot(VALUES, 11)
    },
    stateOf: () => ({ totals: VALUES.tokenUsage, last: FOLD_LAST }),
  })
  const server = await startUsageServer({ dsh: access })
  try {
    assert.deepEqual(
      server.registered.map((route) => ({ kind: route.kind, path: route.path })),
      [{ kind: 'exact', path: USAGE_PATH }],
      '端点必须是 exact 路由，路径由契约常量给出',
    )
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
    assert.equal(result.status, 200, `200 期望：${result.text}`)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(seenKeys, PROJECTION_KEYS, '必须请求 CONTRACT §2 的四个投影 key')
    assert.deepEqual(result.body, {
      tool: 'recruitment_usage',
      contract_version: USAGE_CONTRACT_VERSION,
      session_id: LIVE_SESSION,
      available: true,
      source: 'DSH_SESSION_PROJECTION',
      captured_at: NOW_ISO,
      as_of_seq: 11,
      totals: VALUES.tokenUsage,
      last: FOLD_LAST,
      context: VALUES.contextPressure,
      context_breakdown: VALUES.contextBreakdown,
      session_stats: VALUES.sessionStats,
      missing: [],
      quota: null,
      quota_note: USAGE_QUOTA_NOTE,
    }, '200 的每个字段必须与 fake 投影值逐字相等（含 contextWindow 与 last turn/step/buckets）')
    assertNoMachinePath(result.text)
  } finally {
    await server.close()
  }
})

test('last 回退：stateOf 缺失 → 扫事件取最新 assistant/message，并把 TokenUsage 映射成四桶', async () => {
  const session = makeSession(LIVE_SESSION, [
    assistantMessage(1, 1, { inputTokens: 1, outputTokens: 2 }), // 更老，不能被选
    { type: 'tool/call', data: {} },
    assistantMessage(2, 1, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 }), // 最新 usage
    { type: 'user/message', data: {} },
    { type: 'tool/call', data: {} },
  ])
  const access = makeAccess({ session })
  const server = await startUsageServer({ dsh: access })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
    assert.equal(result.status, 200, result.text)
    assert.deepEqual(result.body.last, {
      turn: 2,
      step: 1,
      // cacheWriteTokens 缺省 = 0（DSH 自己 `bucketsFrom` 的口径，不是四舍五入）
      buckets: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 },
    })
  } finally {
    await server.close()
  }
})

test('last：fold 的 null 是权威（不拿更老的 assistant/message 覆盖）', async () => {
  const session = makeSession(LIVE_SESSION, [assistantMessage(9, 1, { inputTokens: 9, outputTokens: 9 })])
  const access = makeAccess({
    session,
    stateOf: () => ({ totals: VALUES.tokenUsage, last: null }),
  })
  const server = await startUsageServer({ dsh: access })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
    assert.equal(result.status, 200, result.text)
    assert.equal(result.body.last, null, 'DSH fold 说没有 last，就不能从更老的事件里翻一个出来')
  } finally {
    await server.close()
  }
})

test('last：stateOf 抛错 → 回退事件扫描（不把端点打红）', async () => {
  const session = makeSession(LIVE_SESSION, [assistantMessage(4, 2, { inputTokens: 7, outputTokens: 8 })])
  const access = makeAccess({
    session,
    stateOf: () => {
      throw new Error('deprecated stateOf failed')
    },
  })
  const server = await startUsageServer({ dsh: access })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
    assert.equal(result.status, 200, result.text)
    assert.deepEqual(result.body.last, {
      turn: 4,
      step: 2,
      buckets: { uncachedInputTokens: 7, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  } finally {
    await server.close()
  }
})

test('last 扫描上限 500：窗口内的取到，窗口外（第 501 条以后）取不到 → null', async () => {
  // 事件总长 600：index 200 的 usage 在「最新 500 条」（100..599）窗口内；index 99 的在外。
  const inside = new Array<DshSessionEventLike>(600).fill({ type: 'tool/call', data: {} })
  inside[200] = assistantMessage(7, 1, { inputTokens: 3, outputTokens: 4 })
  const outside = new Array<DshSessionEventLike>(600).fill({ type: 'tool/call', data: {} })
  outside[99] = assistantMessage(5, 1, { inputTokens: 1, outputTokens: 2 })

  for (const [events, expected] of [[inside, { turn: 7 }], [outside, null]] as const) {
    const access = makeAccess({ session: makeSession(LIVE_SESSION, events) })
    const server = await startUsageServer({ dsh: access })
    try {
      const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
      assert.equal(result.status, 200, result.text)
      if (expected === null) {
        assert.equal(result.body.last, null, '扫描上限 500 条之外的 usage 不能拿来冒充 last')
      } else {
        assert.equal((result.body.last as Record<string, unknown>).turn, expected.turn)
      }
    } finally {
      await server.close()
    }
  }
})

test('missing：快照只给部分 key → 对应字段 null + missing 名单（绝不补 0）', async () => {
  const partial = { tokenUsage: VALUES.tokenUsage, sessionStats: VALUES.sessionStats }
  const access = makeAccess({ snapshot: () => makeSnapshot(partial, 5) })
  const server = await startUsageServer({ dsh: access })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
    assert.equal(result.status, 200, result.text)
    assert.deepEqual(result.body.missing, ['contextPressure', 'contextBreakdown'])
    assert.deepEqual(result.body.totals, VALUES.tokenUsage, '有的 key 原样透出')
    assert.deepEqual(result.body.session_stats, VALUES.sessionStats)
    assert.equal(result.body.context, null, '没有 contextPressure 就是 null，不是 0')
    assert.equal(result.body.context_breakdown, null, '没有 contextBreakdown 就是 null，不是 0')
  } finally {
    await server.close()
  }
})

test('quota 恒 null + 说明性字段（不得编造额度数字）', async () => {
  const access = makeAccess({ stateOf: () => ({ last: FOLD_LAST }) })
  const server = await startUsageServer({ dsh: access })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
    assert.equal(result.status, 200, result.text)
    assert.equal(result.body.quota, null)
    assert.equal(result.body.quota_note, USAGE_QUOTA_NOTE)
    assert.equal(typeof result.body.quota_note, 'string', '必须解释为什么是 null')
  } finally {
    await server.close()
  }
})

test('deps.dsh 省略时从 ctx.get 解析服务（插件进程内路径）', async () => {
  const access = makeAccess({ stateOf: () => ({ last: null }) })
  const server = await startUsageServer({
    getService: (name: string) => {
      if (name === 'sessions') return access.sessions
      if (name === 'sessionProjections') return access.projections
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 0 }) }
      return undefined
    },
  })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
    assert.equal(result.status, 200, result.text)
    assert.deepEqual(result.body.totals, VALUES.tokenUsage)
  } finally {
    await server.close()
  }
})

// =====================================================================
//  负例
// =====================================================================

test('400：缺 session_id', async () => {
  const server = await startUsageServer({ dsh: makeAccess() })
  try {
    const result = await httpCall(server, 'GET', USAGE_PATH)
    assertHttpError(result, 400, 'INVALID_ARGS', 'MISSING_REQUIRED')
    assert.equal('totals' in result.body, false, '负例不得带任何计量数字')
  } finally {
    await server.close()
  }
})

test('400：未知查询参数', async () => {
  const server = await startUsageServer({ dsh: makeAccess() })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}&tenant_id=x`)
    assertHttpError(result, 400, 'INVALID_ARGS', 'UNKNOWN_PARAM')
  } finally {
    await server.close()
  }
})

test('403：缺同源头 / Origin 不同源', async () => {
  const server = await startUsageServer({ dsh: makeAccess() })
  try {
    const missingHeader = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`, {
      omitRequestHeader: true,
    })
    assertHttpError(missingHeader, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')
    const badOrigin = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`, {
      headers: { origin: 'http://evil.example' },
    })
    assertHttpError(badOrigin, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')
  } finally {
    await server.close()
  }
})

test('405：非 GET（allow: GET）', async () => {
  const server = await startUsageServer({ dsh: makeAccess() })
  try {
    for (const method of ['POST', 'HEAD', 'DELETE']) {
      const result = await httpCall(server, method, `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
      assert.equal(result.status, 405, `${method} 必须 405：${result.text}`)
      assert.equal(result.headers.get('allow'), 'GET')
    }
  } finally {
    await server.close()
  }
})

test('404：session 不是 live（SessionStore.get 未命中）', async () => {
  const server = await startUsageServer({ dsh: makeAccess() })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=session-unknown`)
    assertHttpError(result, 404, 'NOT_FOUND', 'DSH_SESSION_NOT_LIVE')
    assert.equal('totals' in result.body, false)
  } finally {
    await server.close()
  }
})

test('503：服务未挂载（deps.dsh=null）→ DSH_USAGE_SERVICES_NOT_MOUNTED，且没有 totals 键', async () => {
  const server = await startUsageServer({ dsh: null })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
    assertHttpError(result, 503, 'NOT_CONFIGURED', 'DSH_USAGE_SERVICES_NOT_MOUNTED')
    assert.equal('totals' in result.body, false, '未挂载时绝不能给假 totals')
    assertNoMachinePath(result.text)
  } finally {
    await server.close()
  }
})

test('503：投影快照抛错 → DSH_USAGE_READ_FAILED，body 里没有 totals 键', async () => {
  const access = makeAccess({
    snapshot: () => {
      throw new Error('projection fold failed: D:\\secret\\path') // 故意带路径：不许冒到响应里
    },
  })
  const server = await startUsageServer({ dsh: access })
  try {
    const result = await httpCall(server, 'GET', `${USAGE_PATH}?session_id=${LIVE_SESSION}`)
    assertHttpError(result, 503, 'NOT_CONFIGURED', 'DSH_USAGE_READ_FAILED')
    assert.equal('totals' in result.body, false, '读失败时绝不能返回假 totals/假 0')
    assertNoMachinePath(result.text)
  } finally {
    await server.close()
  }
})

test('非回环 host：不注册路由（fail-closed）', async () => {
  const server = await startUsageServer({ dsh: makeAccess(), host: '0.0.0.0' })
  try {
    assert.deepEqual(server.registered, [], '非回环监听不允许注册任何路由')
    assert.equal(server.warnings.length, 1)
    assert.match(server.warnings[0]!, /不是回环地址/)
  } finally {
    await server.close()
  }
})

// =====================================================================
//  resolveDshUsageAccess：缺服务不抛，返回 null（端点 503 的可测适配器）
// =====================================================================

test('resolveDshUsageAccess：服务在 → 适配器；get 抛错 / 无 get / 形状不对 → null，且都不抛', () => {
  const access = makeAccess({ tokenMeter: { measure: () => null } })
  const ok = resolveDshUsageAccess({
    webServer: { host: '127.0.0.1', port: 1, register: () => () => {} },
    get(name: string) {
      if (name === 'sessions') return access.sessions
      if (name === 'sessionProjections') return access.projections
      if (name === 'tokenMeter') return access.tokenMeter
      return undefined
    },
  })
  assert.notEqual(ok, null, '两个必需服务都在时必须返回适配器')
  assert.equal(ok!.sessions, access.sessions)
  assert.equal(ok!.projections, access.projections)
  assert.deepEqual(ok!.tokenMeter, access.tokenMeter)

  // get 抛错 → null（不冒泡）
  assert.doesNotThrow(() => {
    const resolved = resolveDshUsageAccess({
      webServer: { host: '127.0.0.1', port: 1, register: () => () => {} },
      get() {
        throw new Error('service proxy unavailable')
      },
    })
    assert.equal(resolved, null)
  })

  // 没有 get（headless 上下文）→ null
  assert.equal(
    resolveDshUsageAccess({ webServer: { host: '127.0.0.1', port: 1, register: () => () => {} } }),
    null,
  )
  // null/undefined ctx → null
  assert.equal(resolveDshUsageAccess(null), null)
  assert.equal(resolveDshUsageAccess(undefined), null)

  // 服务形状不对（返回空对象 / 缺 snapshot）→ null
  const missingSnapshot = resolveDshUsageAccess({
    webServer: { host: '127.0.0.1', port: 1, register: () => () => {} },
    get(name: string) {
      return name === 'sessions' ? access.sessions : {}
    },
  })
  assert.equal(missingSnapshot, null)

  // tokenMeter 缺失不影响可用性（CONTRACT §2：可选面）
  const noTokenMeter = resolveDshUsageAccess({
    webServer: { host: '127.0.0.1', port: 1, register: () => () => {} },
    get(name: string) {
      if (name === 'sessions') return access.sessions
      if (name === 'sessionProjections') return access.projections
      return undefined
    },
  })
  assert.notEqual(noTokenMeter, null)
  assert.equal('tokenMeter' in noTokenMeter!, false)
})
