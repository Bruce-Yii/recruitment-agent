// Interviewer Workspace（W3-A）read model + 只读 HTTP 路由的**单测**（不需要数据库）。
//
// 覆盖三块：
//   1. 路由接线：非回环不注册（fail-closed）；回环注册 `/recruitment/api/interviewer` 前缀；
//   2. HTTP 层判定顺序（全部在**碰 DB 之前**拒）：同源 → 身份覆盖 → 方法 → query → session →
//      resolver(409) → alias(403) → database=null(503)；`database = null` 时任何需要 DB 的路径
//      都走不到，正是"没碰 DB"的证明；
//   3. 纯函数：`parseInterviewerQuery` / `requireSessionId` / `toInterviewRow`（**只挑自己的
//      面评**、brief 三态、materials 降级、rubric 越界）/ `deriveCounts`。
//
// 这些断言都不连库。假 `InterviewValue` 用 `readInterviewValue()` 的公开类型构造 —— 这样
// "行映射只读自己那一行面评"是用**两个人都有面评**的情形证明的（不是靠空数据蒙过去）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  InterviewerHttpProblem,
  deriveCounts,
  parseInterviewerQuery,
  readInterviewerWorkspace,
  registerInterviewerHttp,
  requireSessionId,
  toInterviewRow,
  type InterviewExtensionRow,
  type InterviewerHostContext,
  type InterviewerRow,
  type InterviewerSessionActorResolver,
  type ToInterviewRowInput,
} from '../../src/http/interviewer.ts'
import type { InterviewValue, InterviewerValue } from '../../src/tools/interview-get.ts'

// ---------------------------------------------------------------------------
//  契约错误消息 `<CODE>: <compact-json>` → JSON 体（与 test/integration/db.ts::errorBody 同口径）
// ---------------------------------------------------------------------------

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

/** 最小 IncomingMessage 替身（本端点没有 body，只实现 headers/method/url）。 */
class FakeRequest {
  readonly headers: Record<string, string | undefined>
  readonly method: string
  readonly url: string

  constructor(options: {
    url: string
    method?: string
    headers?: Record<string, string | undefined>
  }) {
    this.url = options.url
    this.method = options.method ?? 'GET'
    this.headers = {
      host: '127.0.0.1:3181',
      'x-recruitment-request': '1',
      ...(options.headers ?? {}),
    }
  }
}

interface RouteCapture {
  kind: string
  path: string
  handler: (req: FakeRequest, res: FakeResponse) => void | Promise<void>
}

function makeContext(host = '127.0.0.1', port = 3181): {
  ctx: InterviewerHostContext
  routes: RouteCapture[]
  warnings: string[]
} {
  const routes: RouteCapture[] = []
  const warnings: string[] = []
  const ctx: InterviewerHostContext = {
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
  options: { url: string; method?: string; headers?: Record<string, string | undefined> },
): Promise<Captured> {
  const req = new FakeRequest(options)
  const res = new FakeResponse()
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`handler 未在 2000ms 内结束：${options.method ?? 'GET'} ${options.url}`)),
      2000,
    )
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
//  夹具常量
// ---------------------------------------------------------------------------

const ALIAS_A = 'interviewer_a'
const ACTOR_A = '11111111-1111-4111-8111-000000000104'
const ACTOR_B = '11111111-1111-4111-8111-000000000105'
const SESSION_A = 'session-fceba596-0000-4000-8000-00000000000a'
const INTERVIEW_ID = '11111111-1111-4111-8111-000000000901'
const APPLICATION_ID = '11111111-1111-4111-8111-000000000902'
const CANDIDATE_ID = '11111111-1111-4111-8111-000000000903'
const JOB_ID = '11111111-1111-4111-8111-000000000401'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const TEMPLATE_ID = '11111111-1111-4111-8111-000000000404'
const SCORECARD_A = '11111111-1111-4111-8111-000000000a01'
const SCORECARD_B = '11111111-1111-4111-8111-000000000b01'
const HASH_A = 'a'.repeat(64)

const OVERVIEW_URL = '/recruitment/api/interviewer/overview'

/** 一个可用的 resolver（`interpreter_a` 绑定 SESSION_A）。 */
function resolverFor(options: {
  sessionId?: string
  alias?: string
  actorId?: string
  displayName?: string
} = {}): InterviewerSessionActorResolver {
  const sessionId = options.sessionId ?? SESSION_A
  const binding = {
    session_id: sessionId,
    alias: options.alias ?? ALIAS_A,
    actor_id: options.actorId ?? ACTOR_A,
    display_name: options.displayName ?? '演示-面试官 A',
  }
  return {
    resolve(value: string) {
      return value === sessionId ? binding : undefined
    },
  }
}

// ---------------------------------------------------------------------------
//  1. 路由接线
// ---------------------------------------------------------------------------

test('非回环监听：**不注册**路由并告警（fail-closed，不是 403 之后还挂着）', () => {
  const { ctx, routes, warnings } = makeContext('0.0.0.0')
  const dispose = registerInterviewerHttp(ctx, null, undefined, ['config.database.host is required'])
  assert.equal(routes.length, 0, '0.0.0.0 不得注册面试官工作台路由')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /不是回环地址/)
  dispose()
})

test('回环监听：注册 `/recruitment/api/interviewer` 前缀路由并返回 disposer', () => {
  const { ctx, routes } = makeContext('127.0.0.1')
  let disposed = false
  ctx.webServer.register = (route) => {
    routes.push(route as unknown as RouteCapture)
    return () => {
      disposed = true
    }
  }
  const dispose = registerInterviewerHttp(ctx, null, undefined, [])
  assert.equal(routes.length, 1)
  assert.equal(routes[0]?.kind, 'prefix')
  // 契约 §1.1 写的是 '/recruitment/api'，但宿主 `register()` 对重复 (kind,path) **抛错**，
  // 而该前缀已被 overview.ts 占用（再注册会让插件整个 inject 失败）。
  // 宿主路由是「exact 优先、其次最长前缀」，所以注册更长前缀，对外 URL 与契约逐字相同。
  assert.equal(routes[0]?.path, '/recruitment/api/interviewer')
  dispose()
  assert.equal(disposed, true)
})

// ---------------------------------------------------------------------------
//  2. HTTP 层：能拒就拒，且都在碰 DB 之前
// ---------------------------------------------------------------------------

test('非 same-origin 请求 → 403（缺 x-recruitment-request 标记头）', async () => {
  const { ctx, routes } = makeContext()
  registerInterviewerHttp(ctx, null, resolverFor(), [])
  const response = await callHandler(routes[0]!.handler, {
    url: `${OVERVIEW_URL}?alias=${ALIAS_A}`,
    headers: { 'x-recruitment-request': undefined },
  })
  assert.equal(response.status, 403)
  assert.equal(response.json.error, 'same-origin loopback request required')
})

test('本前缀下的未知路径 → 404（不把未声明的端点当成可用）', async () => {
  const { ctx, routes } = makeContext()
  registerInterviewerHttp(ctx, null, resolverFor(), [])
  const response = await callHandler(routes[0]!.handler, {
    url: '/recruitment/api/interviewer/nope',
  })
  assert.equal(response.status, 404)
})

test('actor 覆盖企图（query / header）→ 400 ACTOR_OVERRIDE_REJECTED，且不触 DB', async () => {
  const { ctx, routes } = makeContext()
  // database=null + resolver 未注入：这条路径能返回 400 本身就证明"没走到 HTTP 后半段"。
  registerInterviewerHttp(ctx, null, undefined, ['config.database.database is required'])
  const handler = routes[0]!.handler
  for (const options of [
    { url: `${OVERVIEW_URL}?alias=${ALIAS_A}&actor_id=${ACTOR_B}` },
    { url: `${OVERVIEW_URL}?alias=${ALIAS_A}&tenant_id=11111111-1111-4111-8111-000000000001` },
    { url: `${OVERVIEW_URL}?alias=${ALIAS_A}`, headers: { 'x-recruitment-actor': ACTOR_B } },
    {
      url: `${OVERVIEW_URL}?alias=${ALIAS_A}`,
      headers: { 'x-recruitment-tenant': '11111111-1111-4111-8111-000000000001' },
    },
  ]) {
    const response = await callHandler(handler, options)
    assert.equal(response.status, 400, `应 400：${JSON.stringify(options)}`)
    const error = errorOf(response.json)
    assert.equal(error.code, 'INVALID_ARGS')
    assert.equal(error.reason_code, 'ACTOR_OVERRIDE_REJECTED')
    assert.ok(typeof error.message === 'string' && error.message.length > 0)
  }
})

test('方法不对 → 405 且带 allow: GET', async () => {
  const { ctx, routes } = makeContext()
  registerInterviewerHttp(ctx, null, resolverFor(), [])
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await callHandler(routes[0]!.handler, {
      url: `${OVERVIEW_URL}?alias=${ALIAS_A}`,
      method,
    })
    assert.equal(response.status, 405, `${method} 应 405`)
    assert.equal(response.headers.allow, 'GET')
  }
})

test('query 形状：未知参数 / 缺 alias / interview_id 非 UUID → 400（原因码逐个断言）', async () => {
  const { ctx, routes } = makeContext()
  registerInterviewerHttp(ctx, null, resolverFor(), [])
  const handler = routes[0]!.handler

  const unknown = await callHandler(handler, { url: `${OVERVIEW_URL}?alias=${ALIAS_A}&limit=500` })
  assert.equal(unknown.status, 400)
  assert.equal(errorOf(unknown.json).reason_code, 'UNKNOWN_PARAM')

  const missing = await callHandler(handler, { url: OVERVIEW_URL })
  assert.equal(missing.status, 400)
  assert.equal(errorOf(missing.json).reason_code, 'MISSING_REQUIRED')

  const blankAlias = await callHandler(handler, { url: `${OVERVIEW_URL}?alias=%20` })
  assert.equal(blankAlias.status, 400)
  assert.equal(errorOf(blankAlias.json).reason_code, 'MISSING_REQUIRED')

  for (const value of ['not-a-uuid', '', '1111']) {
    const response = await callHandler(handler, {
      url: `${OVERVIEW_URL}?alias=${ALIAS_A}&interview_id=${encodeURIComponent(value)}`,
    })
    assert.equal(response.status, 400, `interview_id=${JSON.stringify(value)} 应 400`)
    assert.equal(errorOf(response.json).reason_code, 'ID_NOT_UUID')
  }
})

test('X-DSH-Session：缺失 → SESSION_HEADER_REQUIRED；超 200 字 → SESSION_HEADER_INVALID', async () => {
  const { ctx, routes } = makeContext()
  registerInterviewerHttp(ctx, null, resolverFor(), [])
  const handler = routes[0]!.handler

  const missing = await callHandler(handler, { url: `${OVERVIEW_URL}?alias=${ALIAS_A}` })
  assert.equal(missing.status, 400)
  assert.equal(errorOf(missing.json).code, 'INVALID_ARGS')
  assert.equal(errorOf(missing.json).reason_code, 'SESSION_HEADER_REQUIRED')

  const tooLong = await callHandler(handler, {
    url: `${OVERVIEW_URL}?alias=${ALIAS_A}`,
    headers: { 'x-dsh-session': `session-${'x'.repeat(200)}` },
  })
  assert.equal(tooLong.status, 400)
  assert.equal(errorOf(tooLong.json).reason_code, 'SESSION_HEADER_INVALID')
})

test('resolver 未注入 / 未绑定 → 409 DEMO_ACTOR_UNMAPPED（fail-closed，不猜身份）', async () => {
  const handlers: ((req: FakeRequest, res: FakeResponse) => void | Promise<void>)[] = []

  const notInjected = makeContext()
  registerInterviewerHttp(notInjected.ctx, null, undefined, [])
  handlers.push(notInjected.routes[0]!.handler)

  const unknownSession = makeContext()
  registerInterviewerHttp(unknownSession.ctx, null, resolverFor(), [])
  handlers.push(unknownSession.routes[0]!.handler)

  const nullBinding = makeContext()
  registerInterviewerHttp(nullBinding.ctx, null, { resolve: () => null }, [])
  handlers.push(nullBinding.routes[0]!.handler)

  for (const [index, handler] of handlers.entries()) {
    const response = await callHandler(handler, {
      url: `${OVERVIEW_URL}?alias=${ALIAS_A}`,
      // handler#0：resolver 未注入（任何 session 都不成立）；
      // handler#1：resolver 已注入但**没绑定这个 session**；
      // handler#2：resolver 恒返回 null。
      headers: { 'x-dsh-session': index === 1 ? 'session-unbound-0000-4000-8000-00000000000b' : SESSION_A },
    })
    assert.equal(response.status, 409, `handler#${index} 应 409`)
    const error = errorOf(response.json)
    assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
    assert.equal(error.reason_code, 'SESSION_NOT_BOUND')
  }
})

test('alias 不匹配 → 403 ALIAS_MISMATCH / SESSION_ALIAS_MISMATCH（resolver 解析成功后仍拒绝）', async () => {
  const { ctx, routes } = makeContext()
  let resolved = 0
  registerInterviewerHttp(ctx, null, {
    resolve(sessionId: string) {
      resolved += 1
      return sessionId === SESSION_A
        ? { session_id: SESSION_A, alias: ALIAS_A, actor_id: ACTOR_A, display_name: '演示-面试官 A' }
        : undefined
    },
  }, [])
  const response = await callHandler(routes[0]!.handler, {
    url: `${OVERVIEW_URL}?alias=recruiter`,
    headers: { 'x-dsh-session': SESSION_A },
  })
  assert.equal(resolved, 1, '先解析绑定（否则无从比较 alias）')
  assert.equal(response.status, 403)
  const error = errorOf(response.json)
  assert.equal(error.code, 'ALIAS_MISMATCH')
  assert.equal(error.reason_code, 'SESSION_ALIAS_MISMATCH')
  assert.equal((error.detail as Record<string, unknown>).requested_alias, 'recruiter')
})

test('身份都合法但 database=null → 503 NOT_CONFIGURED（detail.issues 说明缺什么，不假装空数据）', async () => {
  const { ctx, routes } = makeContext()
  const issues = ['config.database.host is required', 'environment variable RECRUITMENT_DB_PASSWORD is not set (the database password is only read from the environment)']
  registerInterviewerHttp(ctx, null, resolverFor(), issues)
  const response = await callHandler(routes[0]!.handler, {
    url: `${OVERVIEW_URL}?alias=${ALIAS_A}`,
    headers: { 'x-dsh-session': SESSION_A },
  })
  assert.equal(response.status, 503)
  const error = errorOf(response.json)
  assert.equal(error.code, 'NOT_CONFIGURED')
  assert.equal(error.reason_code, 'NOT_CONFIGURED')
  assert.deepEqual((error.detail as Record<string, unknown>).issues, issues)
  // 密码值永远不进 detail（只给变量名）。
  assert.equal(response.text.includes('123456'), false)
})

// ---------------------------------------------------------------------------
//  3. 纯函数：parseInterviewerQuery / requireSessionId
// ---------------------------------------------------------------------------

test('parseInterviewerQuery：合法形态（别名去空白、interview_id 可选）', () => {
  assert.deepEqual(parseInterviewerQuery(new URL(`http://x${OVERVIEW_URL}?alias=${ALIAS_A}`)), {
    alias: ALIAS_A,
  })
  assert.deepEqual(
    parseInterviewerQuery(new URL(`http://x${OVERVIEW_URL}?alias=%20${ALIAS_A}%20&interview_id=${INTERVIEW_ID}`)),
    { alias: ALIAS_A, interviewId: INTERVIEW_ID },
  )
})

test('parseInterviewerQuery：未知参数 / 缺 alias / 非 UUID 都抛 InterviewerHttpProblem(400)', () => {
  const cases: { url: string; reason: string }[] = [
    { url: `?alias=${ALIAS_A}&sectionLimit=100`, reason: 'UNKNOWN_PARAM' },
    { url: '', reason: 'MISSING_REQUIRED' },
    { url: `?alias=${ALIAS_A}&interview_id=x_1`, reason: 'ID_NOT_UUID' },
  ]
  for (const item of cases) {
    assert.throws(
      () => parseInterviewerQuery(new URL(`http://x${OVERVIEW_URL}${item.url}`)),
      (error: unknown) => {
        assert.ok(error instanceof InterviewerHttpProblem, `${item.url} 应抛 InterviewerHttpProblem`)
        assert.equal(error.status, 400)
        assert.equal((error.body.error as Record<string, unknown>).reason_code, item.reason)
        return true
      },
      item.url,
    )
  }
})

test('requireSessionId：返回原文（不规范化）；缺失/重复/空/超长都 400 且原因码正确', () => {
  assert.equal(requireSessionId({ headers: { 'x-dsh-session': SESSION_A } }), SESSION_A)
  const cases: { headers: Record<string, string | string[] | undefined>; reason: string }[] = [
    { headers: {}, reason: 'SESSION_HEADER_REQUIRED' },
    { headers: { 'x-dsh-session': '   ' }, reason: 'SESSION_HEADER_REQUIRED' },
    { headers: { 'x-dsh-session': [SESSION_A, SESSION_A] }, reason: 'SESSION_HEADER_INVALID' },
    { headers: { 'x-dsh-session': `s${'x'.repeat(200)}` }, reason: 'SESSION_HEADER_INVALID' },
  ]
  for (const item of cases) {
    assert.throws(
      () => requireSessionId({ headers: item.headers }),
      (error: unknown) => {
        assert.ok(error instanceof InterviewerHttpProblem)
        assert.equal(error.status, 400)
        assert.equal((error.body.error as Record<string, unknown>).code, 'INVALID_ARGS')
        assert.equal((error.body.error as Record<string, unknown>).reason_code, item.reason)
        return true
      },
    )
  }
})

// ---------------------------------------------------------------------------
//  4. toInterviewRow：只用假值，不连库
// ---------------------------------------------------------------------------

/** 一个面试官（`readInterviewValue()` 的元素形状）。 */
function interviewerValue(options: {
  actorId: string
  displayName?: string
  requiredScorecard?: boolean
  dueAt?: string
  scorecard?: { id: string; status: string; revisionNo: number; submittedAt?: string; transcriptBasis: string }
}): InterviewerValue {
  return {
    interviewer_id: `ivr-${options.actorId.slice(-4)}`,
    actor_id: options.actorId,
    display_name: options.displayName ?? `演示-面试官 ${options.actorId.slice(-3)}`,
    role_in_interview: 'INTERVIEWER',
    required_scorecard: options.requiredScorecard ?? true,
    ...(options.dueAt === undefined ? {} : { scorecard_due_at: options.dueAt }),
    ...(options.scorecard === undefined ? {} : {
      scorecard: {
        scorecard_id: options.scorecard.id,
        status: options.scorecard.status,
        revision_no: options.scorecard.revisionNo,
        ...(options.scorecard.submittedAt === undefined ? {} : { submitted_at: options.scorecard.submittedAt }),
        transcript_basis: options.scorecard.transcriptBasis,
      },
    }),
  }
}

/** 假 `InterviewValue`（默认：两个面试官都有面评 + 已绑定 1 场会议 + READY 转写）。 */
function interviewValue(overrides: {
  status?: string
  recordVersion?: number
  interviewers?: readonly InterviewerValue[]
  transcript?: { state: string; reasonCode: string; noTranscript?: boolean }
  meetingBinding?: { state: string; count: number; bindings?: readonly Record<string, unknown>[] }
} = {}): InterviewValue {
  const transcript = overrides.transcript ?? { state: 'READY', reasonCode: 'CANONICAL_STATUS' }
  const meetingBinding = overrides.meetingBinding ?? { state: 'BOUND_ACTIVE', count: 1, bindings: [] }
  return {
    id: INTERVIEW_ID,
    application_id: APPLICATION_ID,
    candidate_id: CANDIDATE_ID,
    job_id: JOB_ID,
    round_no: 2,
    slot_code: 'DEFAULT',
    stage_code: 'INTERVIEW',
    status: overrides.status ?? 'SCHEDULED',
    record_version: overrides.recordVersion ?? 3,
    scheduled_start_at: '2026-11-10T02:00:00.000Z',
    scheduled_end_at: '2026-11-10T03:00:00.000Z',
    duration_minutes: 60,
    timezone: 'Asia/Shanghai',
    status_changed_at: '2026-11-01T00:00:00.000Z',
    is_overdue_start: true,
    interviewers: overrides.interviewers ?? [
      interviewerValue({ actorId: ACTOR_A, scorecard: { id: SCORECARD_A, status: 'SUBMITTED', revisionNo: 1, submittedAt: '2026-11-10T03:00:00.000Z', transcriptBasis: 'TRANSCRIPT' } }),
      interviewerValue({ actorId: ACTOR_B, scorecard: { id: SCORECARD_B, status: 'PENDING', revisionNo: 1, transcriptBasis: 'UNKNOWN' } }),
    ],
    meeting_binding: {
      state: meetingBinding.state as InterviewValue['meeting_binding']['state'],
      count: meetingBinding.count,
      bindings: (meetingBinding.bindings ?? []) as unknown as InterviewValue['meeting_binding']['bindings'],
    },
    transcript: {
      state: transcript.state as InterviewValue['transcript']['state'],
      reason_code: transcript.reasonCode as InterviewValue['transcript']['reason_code'],
      no_transcript: transcript.noTranscript ?? transcript.state !== 'READY',
    },
    evaluation: {
      required_scorecards: 1,
      submitted: 1,
      waived: 0,
      pending: 0,
      evaluation_ready: false,
      blockers: [],
    },
    warnings: [],
  }
}

/** 假扩展行（默认：无模板 + 有 rubric + 有已解析简历）。 */
function extensionRow(overrides: Partial<InterviewExtensionRow> = {}): InterviewExtensionRow {
  return {
    interview_id: INTERVIEW_ID,
    application_job_id: JOB_ID,
    candidate_display_name: '测试候选人',
    job_code: 'JOB-001',
    job_title: '后端工程师',
    template_version_id: null,
    template_objective: null,
    template_briefing_summary: null,
    template_focus: [],
    template_questions: [],
    template_payload_hash: null,
    pinned_rubric_version_id: RUBRIC_ID,
    rubric_version_id: RUBRIC_ID,
    rubric_payload_hash: HASH_A,
    rubric_dimensions: [
      { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
      { key: 'async_pipeline', label: '异步流水线', kind: 'MUST_HAVE', weight: 0.3 },
    ],
    resume_version_id: '11111111-1111-4111-8111-000000000905',
    resume_parse_status: 'PARSED',
    resume_parser_name: 'pymupdf',
    resume_parser_version: '1.0.0',
    resume_content_sha256: 'b'.repeat(64),
    resume_parsed_fields: { fields: { name: { state: 'present' } } },
    scorecard_id: SCORECARD_A,
    scorecard_record_version: 3,
    scorecard_overall: 'ADVANCE',
    ...overrides,
  }
}

function mapRow(overrides: {
  value?: InterviewValue
  extension?: InterviewExtensionRow
  actorId?: string
} = {}): { row: InterviewerRow; issues: readonly string[]; input: ToInterviewRowInput } {
  const input: ToInterviewRowInput = {
    value: overrides.value ?? interviewValue(),
    extension: overrides.extension ?? extensionRow(),
    actorId: overrides.actorId ?? ACTOR_A,
  }
  const mapped = toInterviewRow(input)
  return { ...mapped, input }
}

test('toInterviewRow：只挑**自己**那一行的面评；另一个人的 scorecard/actor 不出现在任何位置', () => {
  const { row } = mapRow()
  assert.equal(row.scorecard.state, 'SUBMITTED')
  assert.equal(row.scorecard.scorecard_id, SCORECARD_A, '只能用我自己那一行（actor_id === 我）')
  assert.equal(row.scorecard.record_version, 3, '同一 scorecard_id 时补 record_version')
  assert.equal(row.scorecard.overall, 'ADVANCE')
  assert.equal(row.required_action, 'REVIEW_SCORECARD')

  const serialized = JSON.stringify(row)
  assert.equal(serialized.includes(SCORECARD_B), false, '别人的面评 id 不得出现在响应里')
  assert.equal(serialized.includes(ACTOR_B), false, '别人的 actor id 不得出现在响应里')
  assert.equal(serialized.includes('演示-面试官 105'), false, '别人的展示名不得出现在响应里')
})

test('toInterviewRow：我没有面评 → state=NONE 且七个字段全 null；必填 → SUBMIT_SCORECARD', () => {
  const { row } = mapRow({
    value: interviewValue({ interviewers: [interviewerValue({ actorId: ACTOR_A })] }),
    extension: extensionRow({ scorecard_id: null, scorecard_record_version: null, scorecard_overall: null }),
  })
  assert.equal(row.scorecard.state, 'NONE')
  assert.deepEqual(row.scorecard, {
    state: 'NONE',
    scorecard_id: null,
    status: null,
    revision_no: null,
    record_version: null,
    submitted_at: null,
    transcript_basis: null,
    overall: null,
  })
  assert.equal(row.required_action, 'SUBMIT_SCORECARD')
})

test('toInterviewRow：草稿 → PENDING；豁免 → WAIVED + required_action=NONE；可选面评未填 → NONE', () => {
  const pending = mapRow({
    value: interviewValue({
      interviewers: [interviewerValue({
        actorId: ACTOR_A,
        scorecard: { id: SCORECARD_A, status: 'PENDING', revisionNo: 2, transcriptBasis: 'UNKNOWN' },
      })],
    }),
  }).row
  assert.equal(pending.scorecard.state, 'PENDING')
  assert.equal(pending.required_action, 'SUBMIT_SCORECARD')

  const waived = mapRow({
    value: interviewValue({
      interviewers: [interviewerValue({
        actorId: ACTOR_A,
        scorecard: { id: SCORECARD_A, status: 'WAIVED', revisionNo: 1, transcriptBasis: 'UNKNOWN' },
      })],
    }),
  }).row
  assert.equal(waived.scorecard.state, 'WAIVED')
  assert.equal(waived.required_action, 'NONE')

  const optional = mapRow({
    value: interviewValue({ interviewers: [interviewerValue({ actorId: ACTOR_A, requiredScorecard: false })] }),
    extension: extensionRow({ scorecard_id: null }),
  }).row
  assert.equal(optional.scorecard.state, 'NONE')
  assert.equal(optional.required_action, 'NONE', '非必填面评未填时不算"待提交"')
})

test('toInterviewRow：scorecard_id 两次读取不一致 → record_version/overall 回 null（不混行）', () => {
  const { row } = mapRow({ extension: extensionRow({ scorecard_id: '11111111-1111-4111-8111-000000000aff' }) })
  assert.equal(row.scorecard.scorecard_id, SCORECARD_A, '身份仍以 readInterviewValue 为准')
  assert.equal(row.scorecard.record_version, null)
  assert.equal(row.scorecard.overall, null)
})

test('toInterviewRow：找不到自己那一行 → NOT_FOUND(INTERVIEWER_ROW_MISSING)（不猜成"未填"）', () => {
  assert.throws(
    () => mapRow({ value: interviewValue({ interviewers: [interviewerValue({ actorId: ACTOR_B })] }) }),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'NOT_FOUND')
      assert.equal(body.reason_code, 'INTERVIEWER_ROW_MISSING')
      return true
    },
  )
})

// ---- brief 三态 -----------------------------------------------------------

test('brief：有模板行 → TEMPLATE（objective/briefing.summary/focus/questions/版本 id/哈希）', () => {
  const { row } = mapRow({
    extension: extensionRow({
      template_version_id: TEMPLATE_ID,
      template_objective: '验证后端深度与异步经验',
      template_briefing_summary: '本场聚焦分片与重放',
      template_focus: [
        { key: 'backend_depth', label: '后端工程深度', weight: 0.5 },
        { attribute: 'no-key-should-be-skipped' },
      ],
      template_questions: ['讲讲你设计过的分片方案', { question: '遇到过消息重放吗？' }, { text: '如何压测？' }, { nope: 1 }],
      template_payload_hash: 'c'.repeat(64),
    }),
  })
  assert.equal(row.brief.available, true)
  assert.equal(row.brief.source, 'TEMPLATE')
  assert.equal(row.brief.objective, '验证后端深度与异步经验')
  assert.equal(row.brief.briefing, '本场聚焦分片与重放')
  assert.deepEqual(row.brief.focus, [{ key: 'backend_depth', label: '后端工程深度', weight: 0.5 }])
  assert.deepEqual(row.brief.questions, ['讲讲你设计过的分片方案', '遇到过消息重放吗？', '如何压测？'])
  assert.equal(row.brief.template_version_id, TEMPLATE_ID)
  assert.equal(row.brief.template_payload_hash, 'c'.repeat(64))
  assert.equal(row.brief.reason, null)
})

test('brief：无模板 + 有 rubric 维度 → JOB_RUBRIC（objective=job.title，questions=[]，不冒充模板原文）', () => {
  const { row } = mapRow()
  assert.equal(row.brief.available, true)
  assert.equal(row.brief.source, 'JOB_RUBRIC')
  assert.equal(row.brief.objective, '后端工程师', '没有模板时目标退到岗位名（岗位事实）')
  assert.equal(row.brief.briefing, null)
  assert.deepEqual(row.brief.questions, [], 'rubric 维度不得被当成"建议问题"')
  assert.deepEqual(row.brief.focus, [
    { key: 'backend_depth', label: '后端工程深度', weight: 0.5 },
    { key: 'async_pipeline', label: '异步流水线', weight: 0.3 },
  ])
  assert.equal(row.brief.template_version_id, null)
  assert.equal(row.brief.template_payload_hash, null)
  assert.equal(row.brief.reason, null)
})

test('brief：无模板 + 无 rubric → NONE + reason 非空（不可用、无目标、无重点）', () => {
  const { row, issues } = mapRow({
    extension: extensionRow({
      pinned_rubric_version_id: null,
      rubric_version_id: null,
      rubric_payload_hash: null,
      rubric_dimensions: [],
    }),
  })
  assert.equal(row.brief.available, false)
  assert.equal(row.brief.source, 'NONE')
  assert.equal(row.brief.objective, null)
  assert.deepEqual(row.brief.focus, [])
  assert.ok(typeof row.brief.reason === 'string' && row.brief.reason.length > 0)
  assert.deepEqual(issues, [], '没有钉 rubric 不是异常，不进 issues')
})

// ---- materials 三条降级路径 ----------------------------------------------

test('materials：未绑定简历 → available:false/NO_MATERIAL_BOUND 且 resume=null', () => {
  const { row } = mapRow({
    extension: extensionRow({
      resume_version_id: null,
      resume_parse_status: null,
      resume_parser_name: null,
      resume_parser_version: null,
      resume_content_sha256: null,
      resume_parsed_fields: null,
    }),
  })
  assert.equal(row.materials.authorization, 'INTERVIEW_ASSIGNMENT')
  assert.equal(row.materials.available, false)
  assert.equal(row.materials.reason, 'NO_MATERIAL_BOUND')
  assert.equal(row.materials.resume, null)
})

test('materials：解析失败 → PARSE_FAILED（保留元数据但 fields 为空，不把半成品当已解析）', () => {
  const { row } = mapRow({
    extension: extensionRow({
      resume_parse_status: 'FAILED',
      resume_parsed_fields: { fields: { name: { state: 'present' } } },
    }),
  })
  assert.equal(row.materials.available, false)
  assert.equal(row.materials.reason, 'PARSE_FAILED')
  assert.equal(row.materials.resume?.parse_status, 'FAILED')
  assert.deepEqual(row.materials.resume?.fields, {})
})

test('materials：未解析完成（PENDING/PARSING）→ NOT_PARSED（不谎称可用）', () => {
  for (const status of ['PENDING', 'PARSING']) {
    const { row } = mapRow({ extension: extensionRow({ resume_parse_status: status }) })
    assert.equal(row.materials.available, false, `${status} 不应可用`)
    assert.equal(row.materials.reason, 'NOT_PARSED')
  }
})

test('materials：已解析 → available:true + fields = parsed_fields 原样', () => {
  const parsed = { fields: { name: { state: 'present', value: '测试候选人' } }, timeline: { intervals: 1 } }
  const { row } = mapRow({ extension: extensionRow({ resume_parsed_fields: parsed }) })
  assert.equal(row.materials.available, true)
  assert.equal(row.materials.reason, null)
  assert.deepEqual(row.materials.resume?.fields, parsed)
  assert.equal(row.materials.resume?.parser_name, 'pymupdf')
  assert.equal(row.materials.resume?.content_sha256, 'b'.repeat(64))
})

// ---- rubric 越界 ----------------------------------------------------------

test('rubric：钉住且属于该岗位 → 五键维度（question 缺失时是 null）', () => {
  const { row } = mapRow({
    extension: extensionRow({
      rubric_dimensions: [
        { key: 'alpha', label: '甲', kind: 'MUST_HAVE', weight: 0.6, question: '举例说明' },
        { key: 'beta', kind: 'NICE_TO_HAVE', weight: 0.4 },
      ],
    }),
  })
  assert.equal(row.rubric?.rubric_version_id, RUBRIC_ID)
  assert.equal(row.rubric?.job_id, JOB_ID)
  assert.equal(row.rubric?.payload_hash, HASH_A)
  assert.deepEqual(row.rubric?.dimensions, [
    { key: 'alpha', label: '甲', kind: 'MUST_HAVE', weight: 0.6, question: '举例说明' },
    { key: 'beta', label: 'beta', kind: 'NICE_TO_HAVE', weight: 0.4, question: null },
  ])
})

test('rubric：未钉住 → null（不猜版本）', () => {
  const { row, issues } = mapRow({
    extension: extensionRow({ pinned_rubric_version_id: null, rubric_version_id: null }),
  })
  assert.equal(row.rubric, null)
  assert.deepEqual(issues, [])
})

test('rubric：钉住了但不属于该申请岗位 → null + issues 追加说明（不猜）', () => {
  const { row, issues } = mapRow({
    extension: extensionRow({
      pinned_rubric_version_id: RUBRIC_ID,
      rubric_version_id: null,
      rubric_payload_hash: null,
      rubric_dimensions: null,
    }),
  })
  assert.equal(row.rubric, null, 'rubric 越界必须置空')
  assert.equal(issues.length, 1)
  assert.match(issues[0] ?? '', /不属于该申请的岗位/)
  assert.match(issues[0] ?? '', /不猜版本/)
  // brief 也不得拿越界的 rubric 冒充 JOB_RUBRIC。
  assert.equal(row.brief.source, 'NONE')
  assert.ok(row.brief.reason !== null && row.brief.reason.length > 0)
})

// ---- transcript / 其它字段 ------------------------------------------------

test('transcript：state/reason_code/no_transcript 原样来自 readInterviewValue；meetings_total 取 meeting_binding.count', () => {
  const { row } = mapRow({
    value: interviewValue({
      transcript: { state: 'MISSING', reasonCode: 'NO_MEETING_BOUND', noTranscript: true },
      // §1.5 直取 meeting_binding.count（活跃绑定条数，含 REPLACED/CANCELLED）：本用例把它与
      // bindings 条数写成不同值，明确"不在这里重算 M(i)"。
      meetingBinding: {
        state: 'BOUND_ACTIVE',
        count: 2,
        bindings: [
          { meeting_role: 'PRIMARY', binding_id: 'b1', meeting_id: 'm1' },
          { meeting_role: 'REPLACED', binding_id: 'b2', meeting_id: 'm2' },
        ],
      },
    }),
  })
  assert.deepEqual(row.transcript, {
    state: 'MISSING',
    reason_code: 'NO_MEETING_BOUND',
    no_transcript: true,
    meeting_binding_state: 'BOUND_ACTIVE',
    meetings_total: 2,
  })
})

test('toInterviewRow：其它字段（候选人/岗位/轮次/时间/记录版本/角色/必填）原样透传', () => {
  const { row } = mapRow({ value: interviewValue({ status: 'POST_INTERVIEW', recordVersion: 7 }) })
  assert.equal(row.interview_id, INTERVIEW_ID)
  assert.equal(row.application_id, APPLICATION_ID)
  assert.deepEqual(row.candidate, { candidate_id: CANDIDATE_ID, display_name: '测试候选人' })
  assert.deepEqual(row.job, { job_id: JOB_ID, code: 'JOB-001', title: '后端工程师' })
  assert.equal(row.round_no, 2)
  assert.equal(row.slot_code, 'DEFAULT')
  assert.equal(row.status, 'POST_INTERVIEW')
  assert.equal(row.stage_code, 'INTERVIEW')
  assert.equal(row.scheduled_start_at, '2026-11-10T02:00:00.000Z')
  assert.equal(row.scheduled_end_at, '2026-11-10T03:00:00.000Z')
  assert.equal(row.timezone, 'Asia/Shanghai')
  assert.equal(row.record_version, 7)
  assert.equal(row.role_in_interview, 'INTERVIEWER')
  assert.equal(row.required_scorecard, true)
  assert.equal(row.scorecard_due_at, null)
})

test('toInterviewRow：没有 scheduled_* 的面试（CANCELLED/NO_SHOW 允许）→ null 而不是 undefined', () => {
  const value = interviewValue({ status: 'CANCELLED' })
  const withoutSchedule: InterviewValue = { ...value }
  delete (withoutSchedule as { scheduled_start_at?: string }).scheduled_start_at
  delete (withoutSchedule as { scheduled_end_at?: string }).scheduled_end_at
  const { row } = mapRow({ value: withoutSchedule })
  assert.equal(row.scheduled_start_at, null)
  assert.equal(row.scheduled_end_at, null)
  assert.equal(row.status, 'CANCELLED')
})

// ---------------------------------------------------------------------------
//  5. deriveCounts：六个计数（§1.4 的口径）
// ---------------------------------------------------------------------------

/** 造一行只关心计数相关字段的 InterviewerRow。 */
function countRow(options: {
  status?: string
  requiredScorecard?: boolean
  scorecardState?: InterviewerRow['scorecard']['state']
  transcriptState?: InterviewerRow['transcript']['state']
}): InterviewerRow {
  return {
    interview_id: `iv-${Math.random().toString(36).slice(2, 8)}`,
    application_id: APPLICATION_ID,
    candidate: { candidate_id: CANDIDATE_ID, display_name: '候选人' },
    job: { job_id: JOB_ID, code: 'JOB-001', title: '后端工程师' },
    round_no: 1,
    slot_code: 'DEFAULT',
    status: options.status ?? 'SCHEDULED',
    stage_code: 'INTERVIEW',
    scheduled_start_at: null,
    scheduled_end_at: null,
    timezone: 'Asia/Shanghai',
    record_version: 1,
    role_in_interview: 'INTERVIEWER',
    required_scorecard: options.requiredScorecard ?? true,
    scorecard_due_at: null,
    brief: {
      available: false, source: 'NONE', objective: null, briefing: null, focus: [], questions: [],
      template_version_id: null, template_payload_hash: null, reason: '无',
    },
    rubric: null,
    materials: { authorization: 'INTERVIEW_ASSIGNMENT', available: false, reason: 'NO_MATERIAL_BOUND', resume: null },
    transcript: {
      state: options.transcriptState ?? 'MISSING',
      reason_code: 'NO_MEETING_BOUND',
      no_transcript: (options.transcriptState ?? 'MISSING') !== 'READY',
      meeting_binding_state: 'UNBOUND',
      meetings_total: 0,
    },
    scorecard: {
      state: options.scorecardState ?? 'NONE',
      scorecard_id: null, status: null, revision_no: null, record_version: null,
      submitted_at: null, transcript_basis: null, overall: null,
    },
    required_action: 'SUBMIT_SCORECARD',
  }
}

test('deriveCounts：assigned/open/pending/submitted/transcript ready+missing 逐个对得上', () => {
  const rows: InterviewerRow[] = [
    // 1: 未终结 + 必填未填 → open + pending；转写 READY
    countRow({ status: 'SCHEDULED', scorecardState: 'NONE', transcriptState: 'READY' }),
    // 2: 草稿 → 也算 pending；转写 MISSING
    countRow({ status: 'POST_INTERVIEW', scorecardState: 'PENDING', transcriptState: 'MISSING' }),
    // 3: 已提交 → submitted（不算 pending）
    countRow({ status: 'POST_INTERVIEW', scorecardState: 'SUBMITTED', transcriptState: 'READY' }),
    // 4: 终态 DECIDED → 不算 open；可选面评未填 → 不算 pending
    countRow({ status: 'DECIDED', requiredScorecard: false, scorecardState: 'NONE', transcriptState: 'PARTIAL' }),
    // 5: 终态 CANCELLED
    countRow({ status: 'CANCELLED', transcriptState: 'PENDING' }),
    // 6: 终态 NO_SHOW
    countRow({ status: 'NO_SHOW', transcriptState: 'AUTH_REQUIRED' }),
  ]
  assert.deepEqual(deriveCounts(rows), {
    assigned_total: 6,
    open_interview_total: 3,
    // §1.4 的字面规则只有两个条件（required_scorecard ∧ state ∈ {NONE,PENDING}），**不**排除终态：
    // 行 1/2/5/6 都满足 → 4。"哪些面试还开着"是 open_interview_total 的口径，两个桶各管一件事。
    pending_scorecard_total: 4,
    submitted_scorecard_total: 1,
    transcript_ready_total: 2,
    transcript_missing_total: 1,
  })
})

test('deriveCounts：空列表 → 全 0（不是 undefined/NaN）', () => {
  assert.deepEqual(deriveCounts([]), {
    assigned_total: 0,
    open_interview_total: 0,
    pending_scorecard_total: 0,
    submitted_scorecard_total: 0,
    transcript_ready_total: 0,
    transcript_missing_total: 0,
  })
})

// ---------------------------------------------------------------------------
//  6. readInterviewerWorkspace：DB 读失败必须抛错（不得伪装成空列表）
// ---------------------------------------------------------------------------

test('readInterviewerWorkspace：任何一次 DB 读失败 → 抛错（不把故障说成"没有面试"）', async () => {
  const failing = {
    query: async (): Promise<never> => {
      throw new Error('connection reset by peer')
    },
  }
  await assert.rejects(
    readInterviewerWorkspace(
      failing as unknown as Parameters<typeof readInterviewerWorkspace>[0],
      { tenant_id: '11111111-1111-4111-8111-000000000001' } as unknown as Parameters<typeof readInterviewerWorkspace>[1],
      { alias: ALIAS_A, actor_id: ACTOR_A, display_name: '演示-面试官 A' },
    ),
    /connection reset by peer/,
  )
})
