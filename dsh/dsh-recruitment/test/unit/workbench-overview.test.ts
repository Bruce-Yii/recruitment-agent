// 工作台投影 + D-89 面评表单 HTTP 路由的**单测**（不需要数据库）。
//
// 覆盖三块：
//   1. 路由接线：非回环不注册；注册的是 `/recruitment/api` 前缀；
//   2. HTTP 面：same-origin 403 / 方法 405 / Content-Type 415 / 非法 JSON 400 /
//      未配置时 overview 形状完整 / **actor 覆盖参数与头一律 400 且不碰 DB**；
//   3. 纯函数：`parseScorecardFormSubmission`（自由动态键 fail-closed）、
//      `validateDimensionKeys`（恰好覆盖）、`buildFormSpec`（维度顺序 = rubric 顺序）、
//      `deriveFormIdempotencyKey`（稳定、键序无关、形态合法）。
//
// 这些断言都不连库：`database = null` 时 handler 在碰 DB 之前就返回（这正是被测的性质）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFormSpec,
  deriveFormIdempotencyKey,
  parseScorecardFormSubmission,
  registerOverviewHttp,
  sameOrigin,
  validateDimensionKeys,
  type OverviewHostContext,
} from '../../src/http/overview.ts'

/**
 * 从契约错误消息 `<CODE>: <compact-json>` 里取回 JSON 体（与 `test/integration/db.ts::errorBody`
 * 同一口径；本单测不连库，所以不引入那个模块）。
 */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  const json = index >= 0 ? message.slice(index + 2) : message
  return JSON.parse(json) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
//  假 webServer / req / res（只实现 handler 真正用到的面）
// ---------------------------------------------------------------------------

interface Captured {
  status: number
  headers: Record<string, unknown>
  text: string
  json: Record<string, unknown>
}

class FakeResponse {
  status = 0
  headers: Record<string, unknown> = {}
  private chunks: string[] = []
  private settle!: (value: Captured) => void
  readonly done = new Promise<Captured>((resolve) => {
    this.settle = resolve
  })

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status
    this.headers = headers ?? {}
    return this
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined && chunk !== null) this.chunks.push(String(chunk))
    const text = this.chunks.join('')
    let json: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      json = {}
    }
    this.settle({ status: this.status, headers: this.headers, text, json })
  }
}

/** 最小 IncomingMessage 替身：headers / method / url + 可 async 迭代的 body。 */
class FakeRequest {
  readonly headers: Record<string, string | undefined>
  readonly method: string
  readonly url: string
  private readonly body: Buffer

  constructor(options: {
    url: string
    method?: string
    headers?: Record<string, string | undefined>
    body?: string
  }) {
    this.url = options.url
    this.method = options.method ?? 'GET'
    this.headers = { host: '127.0.0.1:3181', 'x-recruitment-request': '1', ...(options.headers ?? {}) }
    this.body = Buffer.from(options.body ?? '', 'utf8')
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    if (this.body.length > 0) yield this.body
  }
}

interface RouteCapture {
  kind: string
  path: string
  handler: (req: FakeRequest, res: FakeResponse) => void | Promise<void>
}

function makeContext(host = '127.0.0.1', port = 3181): {
  ctx: OverviewHostContext
  routes: RouteCapture[]
  warnings: string[]
} {
  const routes: RouteCapture[] = []
  const warnings: string[] = []
  const ctx: OverviewHostContext = {
    webServer: {
      host,
      port,
      register(route) {
        routes.push(route as unknown as RouteCapture)
        return () => {}
      },
    },
    logger: { warn: (message: string) => warnings.push(message) },
  }
  return { ctx, routes, warnings }
}

/** 调一次 handler 并拿到响应（2000ms 兜底，避免写错时测试挂死）。 */
async function callHandler(
  handler: (req: FakeRequest, res: FakeResponse) => void | Promise<void>,
  options: { url: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<Captured> {
  const req = new FakeRequest(options)
  const res = new FakeResponse()
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handler 未在 2000ms 内结束：${options.method ?? 'GET'} ${options.url}`)), 2000)
  })
  try {
    await Promise.race([handler(req, res), guard])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return await res.done
}

/** 取 `error` 子对象（契约错误形状 `{error:{code,reason_code,message}}`）。 */
function errorOf(body: Record<string, unknown>): Record<string, unknown> {
  const error = body.error
  assert.ok(typeof error === 'object' && error !== null && !Array.isArray(error), 'error 必须是对象')
  return error as Record<string, unknown>
}

// ---------------------------------------------------------------------------
//  1. 路由接线
// ---------------------------------------------------------------------------

test('非回环监听：**不注册**路由并告警（fail-closed，不是 403 后还挂着）', () => {
  const { ctx, routes, warnings } = makeContext('0.0.0.0')
  const dispose = registerOverviewHttp(ctx, null, ['config.database.host is required'])
  assert.equal(routes.length, 0, '0.0.0.0 不得注册工作台路由')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /不是回环地址/)
  dispose()
})

test('回环监听：注册 `/recruitment/api` 前缀路由并返回 disposer', () => {
  const { ctx, routes } = makeContext('127.0.0.1')
  let disposed = false
  ctx.webServer.register = (route) => {
    routes.push(route as unknown as RouteCapture)
    return () => {
      disposed = true
    }
  }
  const dispose = registerOverviewHttp(ctx, null, [])
  assert.equal(routes.length, 1)
  assert.equal(routes[0]?.kind, 'prefix')
  assert.equal(routes[0]?.path, '/recruitment/api')
  dispose()
  assert.equal(disposed, true)
})

// ---------------------------------------------------------------------------
//  2. HTTP 面（database = null：任何需要 DB 的路径都不会被走到，直接证明没碰 DB）
// ---------------------------------------------------------------------------

test('sameOrigin：Host/标记头/Origin 三个条件缺一不可', () => {
  const base = { headers: { host: '127.0.0.1:3181', 'x-recruitment-request': '1' } }
  assert.equal(sameOrigin(base, 3181), true)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3182', 'x-recruitment-request': '1' } }, 3181), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3181' } }, 3181), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3181', 'x-recruitment-request': '1', origin: 'http://evil.test' } }, 3181), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3181', 'x-recruitment-request': '1', origin: 'http://127.0.0.1:3181' } }, 3181), true)
})

test('非 same-origin 请求 → 403（缺 x-recruitment-request 标记头）', async () => {
  const { ctx, routes } = makeContext()
  registerOverviewHttp(ctx, null, [])
  const response = await callHandler(routes[0]!.handler, {
    url: '/recruitment/api/overview',
    headers: { 'x-recruitment-request': undefined },
  })
  assert.equal(response.status, 403)
  assert.equal(response.json.error, 'same-origin loopback request required')
})

test('方法不对 → 405：overview 只允许 GET，scorecard-form 允许 GET/POST', async () => {
  const { ctx, routes } = makeContext()
  registerOverviewHttp(ctx, null, [])
  const overview = await callHandler(routes[0]!.handler, { url: '/recruitment/api/overview', method: 'POST' })
  assert.equal(overview.status, 405)
  assert.equal(overview.headers.allow, 'GET')
  const form = await callHandler(routes[0]!.handler, { url: '/recruitment/api/scorecard-form', method: 'PUT' })
  assert.equal(form.status, 405)
  assert.equal(form.headers.allow, 'GET, POST')
})

test('actor 覆盖企图（query / header）→ 400 ACTOR_OVERRIDE_REJECTED，且不触 DB', async () => {
  const { ctx, routes } = makeContext()
  registerOverviewHttp(ctx, null, ['config.database.database is required'])
  const handler = routes[0]!.handler

  for (const options of [
    { url: '/recruitment/api/overview?actor_id=11111111-1111-4111-8111-000000000102' },
    { url: '/recruitment/api/overview?tenant_id=11111111-1111-4111-8111-000000000001' },
    { url: '/recruitment/api/overview', headers: { 'x-recruitment-actor': '11111111-1111-4111-8111-000000000102' } },
    { url: '/recruitment/api/overview', headers: { 'x-recruitment-tenant': '11111111-1111-4111-8111-000000000001' } },
    { url: '/recruitment/api/scorecard-form?interview_id=11111111-1111-4111-8111-000000000501&actor_id=x' },
  ]) {
    const response = await callHandler(handler, options)
    assert.equal(response.status, 400, `应 400：${JSON.stringify(options)}`)
    const error = errorOf(response.json)
    assert.equal(error.code, 'INVALID_ARGS')
    assert.equal(error.reason_code, 'ACTOR_OVERRIDE_REJECTED')
    assert.ok(typeof error.message === 'string' && error.message.length > 0)
  }
})

test('未配置（database=null）overview：200 + configured=false + 形状完整（六列表/四 unassigned/全 0 计数）', async () => {
  const { ctx, routes } = makeContext()
  registerOverviewHttp(ctx, null, ['environment variable RECRUITMENT_DB_PASSWORD is not set'])
  const response = await callHandler(routes[0]!.handler, { url: '/recruitment/api/overview' })
  assert.equal(response.status, 200)
  const body = response.json
  assert.equal(body.contract_version, 'workbench-overview 1.0.0')
  assert.equal(body.configured, false)
  assert.equal(body.actor, null, '未配置时没有可信 actor：不编造')
  assert.deepEqual(body.pending, [])
  assert.deepEqual(body.issues, ['environment variable RECRUITMENT_DB_PASSWORD is not set'])
  const lists = body.lists as Record<string, unknown>
  for (const key of [
    'pending_decisions', 'my_interviews', 'overdue_scorecards', 'pending_reviews', 'connector_incidents', 'waiting_human_tasks',
  ]) {
    assert.deepEqual(lists[key], [], `lists.${key} 必须是空数组`)
  }
  const unassigned = body.unassigned as Record<string, unknown>
  assert.equal(unassigned.note, '全租户共享，没有唯一责任人（D-33 / R-WB-3）')
  for (const key of ['pending_decisions', 'pending_reviews', 'waiting_human_tasks', 'connector_incidents']) {
    assert.deepEqual(unassigned[key], [], `unassigned.${key} 必须是空数组`)
  }
  const counts = body.counts as Record<string, number>
  for (const key of [
    'pending_total', 'active_total', 'my_interviews_total', 'overdue_scorecards_total',
    'pending_reviews_total', 'connector_incidents_total', 'waiting_human_total', 'unassigned_total',
  ]) {
    assert.equal(counts[key], 0, `counts.${key} 必须是 0（不是 undefined/NaN）`)
  }
  assert.deepEqual(counts.pending_by_stage, {})
  assert.deepEqual(counts.active_by_stage, {})
})

test('表单 GET：未知 query 键 → 400 UNKNOWN_PARAM；缺 interview_id → 400 MISSING_REQUIRED；非 UUID → 400 ID_NOT_UUID', async () => {
  const { ctx, routes } = makeContext()
  registerOverviewHttp(ctx, null, [])
  const handler = routes[0]!.handler

  const unknown = await callHandler(handler, { url: '/recruitment/api/scorecard-form?interview_id=11111111-1111-4111-8111-000000000501&limit=5' })
  assert.equal(unknown.status, 400)
  assert.equal(errorOf(unknown.json).reason_code, 'UNKNOWN_PARAM')

  const missing = await callHandler(handler, { url: '/recruitment/api/scorecard-form' })
  assert.equal(missing.status, 400)
  assert.equal(errorOf(missing.json).reason_code, 'MISSING_REQUIRED')

  const bad = await callHandler(handler, { url: '/recruitment/api/scorecard-form?interview_id=not-a-uuid' })
  assert.equal(bad.status, 400)
  assert.equal(errorOf(bad.json).reason_code, 'ID_NOT_UUID')
})

test('表单 GET：database=null 且参数合法 → 503 NOT_CONFIGURED（不假装空表单）', async () => {
  const { ctx, routes } = makeContext()
  registerOverviewHttp(ctx, null, [])
  const response = await callHandler(routes[0]!.handler, {
    url: '/recruitment/api/scorecard-form?interview_id=11111111-1111-4111-8111-000000000501',
  })
  assert.equal(response.status, 503)
  assert.equal(errorOf(response.json).code, 'NOT_CONFIGURED')
})

test('表单 POST：非 JSON Content-Type → 415；非法 JSON → 400（都不写库，DB 都没连）', async () => {
  const { ctx, routes } = makeContext()
  registerOverviewHttp(ctx, null, [])
  const handler = routes[0]!.handler

  const wrongType = await callHandler(handler, {
    url: '/recruitment/api/scorecard-form',
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  })
  assert.equal(wrongType.status, 415)
  assert.equal(errorOf(wrongType.json).reason_code, 'UNSUPPORTED_MEDIA_TYPE')

  const badJson = await callHandler(handler, {
    url: '/recruitment/api/scorecard-form',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(badJson.status, 400)
  assert.equal(errorOf(badJson.json).reason_code, 'INVALID_JSON')
})

test('表单 POST：database=null + 合法 JSON → 503 NOT_CONFIGURED', async () => {
  const { ctx, routes } = makeContext()
  registerOverviewHttp(ctx, null, [])
  const response = await callHandler(routes[0]!.handler, {
    url: '/recruitment/api/scorecard-form',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ interview_id: '11111111-1111-4111-8111-000000000501', dimensions: {}, transcript_basis: 'NO_TRANSCRIPT', overall: 'HOLD' }),
  })
  assert.equal(response.status, 503)
  assert.equal(errorOf(response.json).code, 'NOT_CONFIGURED')
})

// ---------------------------------------------------------------------------
//  3. 纯函数：parseScorecardFormSubmission（自由动态键 fail-closed）
// ---------------------------------------------------------------------------

/** 一份合法提交体（rubric 三个维度）。 */
function validSubmission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    interview_id: '11111111-1111-4111-8111-000000000501',
    dimensions: {
      backend_depth: { assessment: 'MET', score: 4, note: '讲清了分片' },
      async_pipeline: { assessment: 'NOT_MET', score: 2, note: '重放答不上来' },
      frontend_basics: { assessment: 'NOT_OBSERVED' },
    },
    transcript_basis: 'NO_TRANSCRIPT',
    overall: 'HOLD',
    ...overrides,
  }
}

test('parseScorecardFormSubmission：合法提交被规范化（只留已声明键）', () => {
  const parsed = parseScorecardFormSubmission(validSubmission())
  assert.equal(parsed.interview_id, '11111111-1111-4111-8111-000000000501')
  assert.deepEqual(Object.keys(parsed.dimensions).sort(), ['async_pipeline', 'backend_depth', 'frontend_basics'])
  assert.equal(parsed.transcript_basis, 'NO_TRANSCRIPT')
  assert.equal(parsed.overall, 'HOLD')
  assert.equal(parsed.idempotency_key, '', '没给幂等键时由服务端派生（这里留空串哨兵）')
})

test('parseScorecardFormSubmission：未知顶层键 → 400 UNKNOWN_PARAM（零写入）', () => {
  for (const extra of [{ status: 'SUBMITTED' }, { tenant_id: 'x' }, { actor_id: 'x' }, { include_unassigned: true }]) {
    assert.throws(() => parseScorecardFormSubmission(validSubmission(extra)), (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'UNKNOWN_PARAM')
      return true
    })
  }
})

test('parseScorecardFormSubmission：缺必填键 → 400 MISSING_REQUIRED', () => {
  for (const key of ['interview_id', 'dimensions', 'transcript_basis', 'overall']) {
    const raw = validSubmission()
    delete raw[key]
    assert.throws(() => parseScorecardFormSubmission(raw), (error: unknown) => {
      assert.equal(errorBody(error).reason_code, 'MISSING_REQUIRED')
      return true
    })
  }
})

test('parseScorecardFormSubmission：维度对象多余键 / 保留键 / score 越界 / 枚举非法 全部 400', () => {
  const cases: { label: string; raw: Record<string, unknown>; reason: string }[] = [
    {
      label: '维度对象多余键',
      raw: validSubmission({ dimensions: { backend_depth: { assessment: 'MET', score: 4, weight: 0.5 } } }),
      reason: 'UNKNOWN_PARAM',
    },
    {
      label: 'dimensions 里出现保留键 transcript_basis',
      raw: validSubmission({ dimensions: { transcript_basis: 'TRANSCRIPT' } }),
      reason: 'UNKNOWN_PARAM',
    },
    {
      label: 'score 越界（6）',
      raw: validSubmission({ dimensions: { backend_depth: { assessment: 'MET', score: 6 } } }),
      reason: 'OUT_OF_RANGE',
    },
    {
      label: 'score 非整数',
      raw: validSubmission({ dimensions: { backend_depth: { assessment: 'MET', score: 3.5 } } }),
      reason: 'TYPE_MISMATCH',
    },
    {
      label: 'NOT_OBSERVED 带 score',
      raw: validSubmission({ dimensions: { backend_depth: { assessment: 'NOT_OBSERVED', score: 3 } } }),
      reason: 'ASSESSMENT_SCORE_CONFLICT',
    },
    {
      label: 'assessment 不在封闭集',
      raw: validSubmission({ dimensions: { backend_depth: { assessment: 'GOOD' } } }),
      reason: 'ENUM_INVALID',
    },
    {
      label: 'note 超长',
      raw: validSubmission({ dimensions: { backend_depth: { assessment: 'MET', note: 'x'.repeat(2001) } } }),
      reason: 'OUT_OF_RANGE',
    },
    { label: 'transcript_basis 非法', raw: validSubmission({ transcript_basis: 'GUESS' }), reason: 'ENUM_INVALID' },
    { label: 'overall 非法', raw: validSubmission({ overall: 'MAYBE' }), reason: 'ENUM_INVALID' },
    { label: 'interview_id 非 UUID', raw: validSubmission({ interview_id: 'u_001' }), reason: 'ID_NOT_UUID' },
  ]
  for (const item of cases) {
    assert.throws(() => parseScorecardFormSubmission(item.raw), (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS', `${item.label}：code`)
      assert.equal(body.reason_code, item.reason, `${item.label}：reason_code`)
      return true
    }, item.label)
  }
})

// ---------------------------------------------------------------------------
//  4. 纯函数：validateDimensionKeys（键集必须恰好相等）
// ---------------------------------------------------------------------------

const RUBRIC_KEYS = ['backend_depth', 'async_pipeline', 'frontend_basics'] as const

test('validateDimensionKeys：恰好覆盖（顺序无关）→ ok', () => {
  assert.deepEqual(validateDimensionKeys(['frontend_basics', 'backend_depth', 'async_pipeline'], [...RUBRIC_KEYS]), { ok: true })
})

test('validateDimensionKeys：多出 rubric 没有的键 → DIMENSION_NOT_IN_RUBRIC（detail.unexpected）', () => {
  assert.throws(
    () => validateDimensionKeys(['backend_depth', 'async_pipeline', 'frontend_basics', 'my_made_up_key'], [...RUBRIC_KEYS]),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'DIMENSION_NOT_IN_RUBRIC')
      assert.deepEqual((body.detail as Record<string, unknown>).unexpected, ['my_made_up_key'])
      return true
    },
  )
})

test('validateDimensionKeys：缺维度 → DIMENSION_COVERAGE_INCOMPLETE（detail.missing）', () => {
  assert.throws(
    () => validateDimensionKeys(['backend_depth'], [...RUBRIC_KEYS]),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'DIMENSION_COVERAGE_INCOMPLETE')
      assert.deepEqual((body.detail as Record<string, unknown>).missing, ['async_pipeline', 'frontend_basics'])
      return true
    },
  )
})

// ---------------------------------------------------------------------------
//  5. 纯函数：buildFormSpec（维度顺序 = rubric 顺序；键只来自 rubric）
// ---------------------------------------------------------------------------

const RUBRIC_DIMENSIONS = [
  { key: 'alpha', label: '维度甲', kind: 'MUST_HAVE', weight: 0.6 },
  { key: 'beta', label: '维度乙', kind: 'MUST_HAVE', weight: 0.3, question: '举例说明' },
  { key: 'gamma', label: '维度丙', kind: 'NICE_TO_HAVE', weight: 0.1 },
] as const

function formInput(overrides: Record<string, unknown> = {}) {
  return {
    actor: { actor_id: '11111111-1111-4111-8111-000000000104', display_name: '演示-面试官' },
    interview: {
      id: '11111111-1111-4111-8111-000000000901',
      application_id: '11111111-1111-4111-8111-000000000902',
      round_no: 2,
      slot_code: 'DEFAULT',
      status: 'POST_INTERVIEW',
      scheduled_start_at: '2026-11-10T02:00:00.000Z',
      job_id: '11111111-1111-4111-8111-000000000401',
      pinned_rubric_version_id: '11111111-1111-4111-8111-000000000403',
    },
    rubric: {
      id: '11111111-1111-4111-8111-000000000403',
      job_id: '11111111-1111-4111-8111-000000000401',
      payload_hash: 'a'.repeat(64),
      dimensions: RUBRIC_DIMENSIONS,
    },
    current: undefined,
    transcriptReady: false,
    ...overrides,
  }
}

test('buildFormSpec：dimensions 顺序 = rubric 顺序，键只来自 rubric（客户端拿不到别的键）', () => {
  const spec = buildFormSpec(formInput())
  assert.equal(spec.contract_version, 'scorecard-form 1.0.0')
  assert.equal(spec.tool, 'recruitment_scorecard_form')
  assert.deepEqual(spec.dimensions.map((dimension) => dimension.key), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(spec.rubric.dimensions.map((dimension) => dimension.key), ['alpha', 'beta', 'gamma'])
  // 每个维度的 assessment 选项就是服务端封闭集；客户端只能从这里取值。
  for (const dimension of spec.dimensions) {
    assert.deepEqual([...dimension.controls.assessment], ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'])
    assert.deepEqual(dimension.controls.score, { min: 1, max: 5 })
    assert.equal(dimension.controls.note_required, false)
    const expectedKeys = ['controls', 'key', 'kind', 'label', 'weight']
    if (dimension.question !== undefined) expectedKeys.push('question')
    assert.deepEqual(Object.keys(dimension).sort(), expectedKeys.sort())
  }
  assert.equal(spec.dimensions[1]?.question, '举例说明')
  assert.deepEqual(spec.overall_options, ['ADVANCE', 'HOLD', 'REJECT'])
  assert.deepEqual(spec.transcript_basis, {
    value: 'NO_TRANSCRIPT',
    options: ['TRANSCRIPT', 'NO_TRANSCRIPT'],
    locked: true,
  })
  assert.deepEqual(spec.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
})

test('buildFormSpec：transcript READY → TRANSCRIPT；mode 由 current 决定', () => {
  const ready = buildFormSpec(formInput({ transcriptReady: true }))
  assert.equal(ready.transcript_basis.value, 'TRANSCRIPT')

  const create = buildFormSpec(formInput({ current: undefined }))
  assert.equal(create.mode, 'CREATE')
  assert.equal(create.current, null)

  const pending = buildFormSpec(formInput({
    current: { id: 'c1', status: 'PENDING', revision_no: 1, record_version: 1, rubric_version_id: 'r1' },
  }))
  assert.equal(pending.mode, 'CREATE')
  assert.equal(pending.current?.status, 'PENDING')

  const submitted = buildFormSpec(formInput({
    current: { id: 'c2', status: 'SUBMITTED', revision_no: 1, record_version: 2, rubric_version_id: 'r1' },
  }))
  assert.equal(submitted.mode, 'REVISE')
  assert.equal(submitted.current?.record_version, 2)

  const waived = buildFormSpec(formInput({
    current: { id: 'c3', status: 'WAIVED', revision_no: 1, record_version: 1, rubric_version_id: 'r1' },
  }))
  assert.equal(waived.mode, 'ALREADY_SUBMITTED')
})

// ---------------------------------------------------------------------------
//  6. 纯函数：deriveFormIdempotencyKey
// ---------------------------------------------------------------------------

test('deriveFormIdempotencyKey：形态合法、确定性、与 dimensions 键序无关、不同内容不同键', () => {
  const base = parseScorecardFormSubmission(validSubmission())
  const keyA = deriveFormIdempotencyKey('11111111-1111-4111-8111-000000000104', base)
  assert.match(keyA, /^[A-Za-z0-9:_-]{1,128}$/)
  assert.ok(keyA.startsWith('scform:'))
  assert.equal(keyA.length, 'scform:'.length + 64)

  // 同样内容、dimensions 键序不同 → 同一个键（重放必须命中）。
  const reordered = parseScorecardFormSubmission(validSubmission({
    dimensions: {
      frontend_basics: { assessment: 'NOT_OBSERVED' },
      async_pipeline: { assessment: 'NOT_MET', score: 2, note: '重放答不上来' },
      backend_depth: { assessment: 'MET', score: 4, note: '讲清了分片' },
    },
  }))
  assert.equal(deriveFormIdempotencyKey('11111111-1111-4111-8111-000000000104', reordered), keyA)

  // 内容不同 → 不同键；actor 不同 → 不同键。
  const changed = parseScorecardFormSubmission(validSubmission({ overall: 'ADVANCE' }))
  assert.notEqual(deriveFormIdempotencyKey('11111111-1111-4111-8111-000000000104', changed), keyA)
  assert.notEqual(deriveFormIdempotencyKey('11111111-1111-4111-8111-000000000102', base), keyA)
})
