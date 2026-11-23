// Issue #60：CSV 导出 × HMAC Webhook 轻量同步的 HTTP 层。
//
// 精确路由（在 src/index.ts 单独接线；非回环 host 一律不注册）：
//   GET  /recruitment/api/export/applications.csv  —— recruiter + 同源 + session；人话列 CSV
//   POST /recruitment/api/action/webhook/test       —— recruiter + 同源 + session；真实 HTTP 状态
//
// 另导出 `WebhookDispatcher`：由 actions.ts / booking-invite.ts 在主事务成功**之后**调用，
// 以 fire-and-forget 方式发事件；失败绝不回滚主业务，只写 `event_inbox` 审计事件。
// 配置读自既有 `business_config`（external_webhook_config，appendSettingVersion 无迁移）。
import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { closePool, createPool, withActor, withReadOnly, type ResolvedDatabaseConfig } from '../db/pool.ts'
import { readSetting } from '../db/settings.ts'
import { DEMO_SESSION_HEADER, normalizeSessionId, resolveSessionActor, type DemoActorAlias, type DemoActorIdentity, type ResolvedExecutionActor } from '../demo-actor/index.ts'
import {
  buildApplicationsCsv,
  dispatchableConfig,
  maskedContact,
  type CsvApplicationRow,
  type WebhookEvent,
  WEBHOOK_EVENTS,
} from '../domain/export-webhook.ts'
import { sameOrigin } from './overview.ts'

// ---------------------------------------------------------------------------
//  契约常量
// ---------------------------------------------------------------------------

export const EXPORT_PATHS = {
  applicationsCsv: '/recruitment/api/export/applications.csv',
  webhookTest: '/recruitment/api/action/webhook/test',
} as const

const SETTING_KEY = 'external_webhook_config'
const ALLOWED_ALIASES: readonly DemoActorAlias[] = ['recruiter']
const MAX_BODY_BYTES = 64 * 1024
const OVERRIDE_BODY_KEYS = [
  'actor_id', 'tenant_id', 'actor', 'tenant', 'alias', 'actor_alias', 'version_no',
] as const
const NO_STORE = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 每次派发的 HTTP 超时（毫秒）；超时即视为失败并审计，绝不无限等待。 */
const DISPATCH_TIMEOUT_MS = 5000

/** 审计事件的固定类型（内部审计事实，provider=internal / trust=INTERNAL）。 */
const AUDIT_EVENT_TYPE = 'external_webhook.dispatch.failed'
const AUDIT_TEST_EVENT_TYPE = 'external_webhook.test.failed'

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  FORBIDDEN: 403,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_CONFIGURED: 503,
  INTERNAL: 500,
  INVARIANT_VIOLATION: 500,
}

// ---------------------------------------------------------------------------
//  错误 / 响应小工具（与 settings.ts 同形）
// ---------------------------------------------------------------------------

class HttpProblem extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'HttpProblem'
    this.status = status
    this.body = body
  }
}
function problem(status: number, code: string, reasonCode: string, message: string, detail?: unknown): HttpProblem {
  return new HttpProblem(status, {
    error: { code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) },
  })
}
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { ...NO_STORE, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}
function methodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(405, { allow, ...NO_STORE, 'content-type': 'application/json; charset=utf-8' })
  res.end()
}
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof HttpProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : message.slice(0, index)
      const body: Record<string, unknown> = { code }
      if (typeof parsed.reason_code === 'string' && parsed.reason_code !== '') body.reason_code = parsed.reason_code
      body.message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message
      if (parsed.detail !== undefined) body.detail = parsed.detail
      return { status: STATUS_BY_CODE[code] ?? 500, body: { error: body } }
    } catch { /* 不是产品错误形态，走兜底 */ }
  }
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'INTERNAL'
  return { status: STATUS_BY_CODE[code] ?? 500, body: { error: { code, reason_code: 'UNEXPECTED', message } } }
}
function guard(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try { await handler(req, res) } catch (error) {
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }
}

// ---------------------------------------------------------------------------
//  闸门（与 settings/actions 同口径）
// ---------------------------------------------------------------------------

function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED',
      '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）')
  }
}
function readSession(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw problem(400, 'INVALID_ARGS', raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined ? '缺 X-DSH-Session 请求头' : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID')
  }
  return normalized
}
function requireRecruiter(identity: DemoActorIdentity, sessionId: string): ResolvedExecutionActor {
  const resolved = resolveSessionActor(identity, sessionId)
  if (!(ALLOWED_ALIASES as readonly string[]).includes(resolved.alias)) {
    throw problem(403, 'FORBIDDEN', 'ACTOR_NOT_AUTHORIZED',
      `当前身份（${resolved.alias}）无权导出申请或推送 Webhook（只允许 recruiter）`,
      { action: 'export/webhook', alias: resolved.alias, allowed_aliases: [...ALLOWED_ALIASES] })
  }
  return resolved
}
function requireDatabase(deps: ExportHttpDeps): ResolvedDatabaseConfig {
  if (deps.database === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，导出不可用', {
      issues: [...deps.databaseIssues],
    })
  }
  return deps.database
}
async function withPool<T>(cfg: ResolvedDatabaseConfig, fn: (pool: ReturnType<typeof createPool>) => Promise<T>): Promise<T> {
  const pool = createPool(cfg)
  try { return await fn(pool) } finally { await closePool(pool) }
}

// ---------------------------------------------------------------------------
//  依赖 / 宿主
// ---------------------------------------------------------------------------

export interface ExportHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  readonly identity: DemoActorIdentity
  /** 可选：测试用；替换 CSV 查询/设置读取数据源（生产不传）。 */
  readonly hooks?: {
    readonly readApplications?: (filters: { job_id?: string; stage?: string }) => Promise<readonly CsvApplicationRow[]>
    /** 返回 external_webhook_config 的库值（或 null = 未配置）。 */
    readonly readWebhookSetting?: () => Promise<unknown>
    /** 替换审计失败事件写入（测试用）。 */
    readonly recordFailedAudit?: (input: { event: WebhookEvent; error: string }) => Promise<void>
  }
}
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}
export interface ExportHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

// ---------------------------------------------------------------------------
//  CSV 查询（人话投影；零内部 id / 零完整哈希 / 零禁用词）
// ---------------------------------------------------------------------------

interface CsvRowDb {
  readonly candidate_name: string
  readonly phone: string | null
  readonly email: string | null
  readonly job_title: string
  readonly stage: string
  readonly screening_conclusion: string | null
  readonly scorecard_progress: string | null
  readonly final_decision: string | null
  readonly updated_at: string | Date
}
const RESULT_LABELS: Readonly<Record<string, string>> = {
  ADVANCE: '通过', HOLD: '暂缓', REJECT: '未通过', WITHDRAW: '撤回', HIRED: '录用',
}

function decisionLabel(raw: string | null): string | null {
  if (raw === null) return null
  return RESULT_LABELS[raw] ?? raw
}

/**
 * 只读查询：application → candidate / job，加三条标量子查询。
 * 永不 select 内部 id / sha256 / 材料正文；租户恒绑定。
 */
async function loadApplications(
  deps: ExportHttpDeps,
  cfg: ResolvedDatabaseConfig,
  filters: { job_id?: string; stage?: string },
): Promise<readonly CsvApplicationRow[]> {
  if (deps.hooks?.readApplications !== undefined) return deps.hooks.readApplications(filters)
  const params: unknown[] = [cfg.tenant_id]
  let where = ''
  if (filters.job_id !== undefined) {
    params.push(filters.job_id)
    where += ` and a.job_id = $${params.length}::uuid`
  }
  if (filters.stage !== undefined) {
    params.push(filters.stage)
    where += ` and a.current_stage_code = $${params.length}`
  }
  return withPool(cfg, (pool) => withReadOnly(pool, async (client) => {
    const { rows } = await client.query<CsvRowDb>(
      `select c.display_name as candidate_name, c.normalized_phone as phone, c.normalized_email as email,
              j.title as job_title, a.current_stage_code as stage,
              (select d.result from recruitment.decision d
                where d.tenant_id = a.tenant_id and d.application_id = a.id
                  and d.decision_scope = 'SCREENING' and d.superseded_by_decision_id is null
                order by d.decided_at desc limit 1) as screening_conclusion,
              (select count(*) filter (where sc.status = 'SUBMITTED')::text || '/' ||
                      count(*)::text
                 from recruitment.scorecard sc
                 join recruitment.interview iv
                   on iv.id = sc.interview_id and iv.tenant_id = sc.tenant_id
                where sc.tenant_id = a.tenant_id and iv.application_id = a.id
                  and sc.superseded_by_scorecard_id is null) as scorecard_progress,
              (select d.result from recruitment.decision d
                where d.tenant_id = a.tenant_id and d.application_id = a.id
                  and d.decision_scope = 'FINAL' and d.superseded_by_decision_id is null
                order by d.decided_at desc limit 1) as final_decision,
              a.updated_at
         from recruitment.application a
         join recruitment.candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
         join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
        where a.tenant_id = $1${where}
        order by a.updated_at desc, c.display_name asc`,
      params,
    )
    return rows.map((r) => {
      const contact = maskedContact(r.phone, r.email)
      const iso = r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
      return {
        candidate_name: r.candidate_name,
        phone: contact.phone,
        email: contact.email,
        job_title: r.job_title,
        stage: r.stage,
        screening_conclusion: decisionLabel(r.screening_conclusion),
        scorecard_progress: r.scorecard_progress,
        final_decision: decisionLabel(r.final_decision),
        updated_at: iso,
      } satisfies CsvApplicationRow
    })
  }))
}

async function handleCsv(deps: ExportHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = readSession(req)
  requireRecruiter(deps.identity, sessionId) // interviewer → 403，零读取
  const cfg = requireDatabase(deps)
  const url = new URL(req.url ?? '/', 'http://localhost')
  const rawJobId = url.searchParams.get('job_id')
  const rawStage = url.searchParams.get('stage')
  // 轻量形状校验（job_id 不必 DB 预检；非法 uuid 返回空结果不会泄露信息）。
  if (rawJobId !== null && (rawJobId.length > 64 || !/^[0-9a-zA-Z-]+$/.test(rawJobId))) {
    throw problem(400, 'INVALID_ARGS', 'JOB_ID_INVALID', 'job_id 参数形状非法')
  }
  if (rawStage !== null && (rawStage.length > 64 || !/^[A-Z][A-Z0-9_]{1,40}$/.test(rawStage))) {
    throw problem(400, 'INVALID_ARGS', 'STAGE_INVALID', 'stage 参数形状非法')
  }
  const rows = await loadApplications(deps, cfg, {
    ...(rawJobId === null ? {} : { job_id: rawJobId }),
    ...(rawStage === null ? {} : { stage: rawStage }),
  })
  const csv = buildApplicationsCsv(rows)
  const body = Buffer.from(csv, 'utf8') // BOM 由 csv 字符串自带，Buffer 不破坏
  res.writeHead(200, {
    ...NO_STORE,
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="recruitment-applications.csv"',
    'content-length': String(body.length),
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
//  Webhook 派发器（async fail-open）
// ---------------------------------------------------------------------------

export interface WebhookDispatchPayload {
  readonly application_id?: string
  readonly job_id?: string
  readonly [key: string]: unknown
}

export interface DispatchResult {
  readonly ok: boolean
  readonly status?: number
  readonly error?: string
}

/**
 * 读取配置并以 HMAC-SHA256 签名发一次 POST。
 * 所有失败（含网络/非 2xx/超时/配置非法）都返回 `ok:false`，**绝不抛给主流程**。
 */
async function postSigned(
  cfg: ResolvedDatabaseConfig,
  deps: ExportHttpDeps,
  url: string,
  secretHash: string,
  event: WebhookEvent,
  payload: WebhookDispatchPayload,
  auditEventType: string,
): Promise<DispatchResult> {
  // 签名密钥 = secret_hash（sha256 原文）；HMAC key 用它派生的 buffer（服务端持哈希，不持明文）。
  const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload })
  const signature = `sha256=${createHmac('sha256', Buffer.from(secretHash, 'hex')).update(body, 'utf8').digest('hex')}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-recruitment-event': event,
        'x-recruitment-signature': signature,
      },
      body,
      signal: controller.signal,
    })
    // 必须读完 body 才能释放连接（否则 Node 连接泄漏）。
    await response.arrayBuffer().catch(() => {})
    if (!response.ok) {
      await recordFailedAudit(cfg, deps, auditEventType, event, `HTTP ${response.status}`, payload)
      return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    }
    return { ok: true, status: response.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await recordFailedAudit(cfg, deps, auditEventType, event, message.slice(0, 300), payload)
    return { ok: false, error: message.slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}

/** 独立事务写一条内部审计事件（失败静默；审计写入不允许再影响主流程）。 */
async function recordFailedAudit(
  cfg: ResolvedDatabaseConfig,
  deps: ExportHttpDeps,
  eventType: string,
  event: WebhookEvent,
  detail: string,
  payload: WebhookDispatchPayload,
): Promise<void> {
  if (deps.hooks?.recordFailedAudit !== undefined) {
    try { await deps.hooks.recordFailedAudit({ event, error: detail }) } catch { /* fail-open */ }
    return
  }
  try {
    await withPool(cfg, (pool) => withActor(pool, cfg.actor_id, async (client) => {
      await client.query(
        `insert into recruitment.event_inbox
           (tenant_id, provider, provider_event_id, event_type, schema_version,
            occurred_at, received_at, recorded_at, idempotency_key, idempotency_source,
            source_object_id, payload, trust_level, normalized_event_type, normalizer_version)
         values ($1, 'internal', null, $2, 1, now(), now(), now(), $3, 'FALLBACK_KEY',
                 $4, $5::jsonb, 'INTERNAL', $2, 'issue-60')`,
        [
          cfg.tenant_id,
          eventType,
          `webhook-failed:${randomUUID()}`,
          typeof payload.application_id === 'string' ? payload.application_id : `event:${event}`,
          JSON.stringify({ event, error: detail, source: 'external-webhook-dispatch' }),
        ],
      )
    }))
  } catch {
    // 审计失败不抛出：fail-open 底线优先。
  }
}

/** 派发器的窄接口（注入给 actions.ts / booking-invite.ts）。 */
export interface WebhookDispatcher {
  /** 主业务成功后调用（不 await 也可以；实现自身 async 且永不抛）。 */
  emit(event: WebhookEvent, payload: WebhookDispatchPayload): Promise<DispatchResult>
}

/**
 * 建一个派发器。每次 emit 都独立读配置（保证配置改动即时生效），
 * 并在读配置/网络失败时只返回 `ok:false`，不抛出。
 */
export function createWebhookDispatcher(deps: ExportHttpDeps): WebhookDispatcher {
  return {
    async emit(event, payload): Promise<DispatchResult> {
      if (deps.database === null) return { ok: false, error: 'database not configured' }
      try {
        const cfg = deps.database
        const stored = deps.hooks?.readWebhookSetting !== undefined
          ? await deps.hooks.readWebhookSetting()
          : (await withPool(cfg, (pool) => withReadOnly(pool, (client) =>
              readSetting(client, cfg.tenant_id, SETTING_KEY))))?.value
        const active = dispatchableConfig(stored)
        if (active === null || !active.events.includes(event)) return { ok: false, error: 'not configured' }
        return await postSigned(cfg, deps, active.url, active.secret_hash as string, event, payload, AUDIT_EVENT_TYPE)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/** 无操作派发器（依赖未注入时的安全缺省：绝不外发、绝不抛错）。 */
export const NOOP_WEBHOOK_DISPATCHER: WebhookDispatcher = {
  async emit() { return { ok: false, error: 'dispatcher not configured' } },
}

// ---------------------------------------------------------------------------
//  POST /recruitment/api/action/webhook/test —— 真实状态码
// ---------------------------------------------------------------------------

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || contentType.toLowerCase().split(';')[0]?.trim() !== 'application/json') {
    throw problem(415, 'INVALID_ARGS', 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json')
  }
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number(declared) > MAX_BODY_BYTES) {
    throw problem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${MAX_BODY_BYTES} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw problem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', '请求体过大')
    chunks.push(buffer)
  }
  let raw: unknown
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw problem(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw problem(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象')
  }
  return raw as Record<string, unknown>
}

async function handleWebhookTest(deps: ExportHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = readSession(req)
  requireRecruiter(deps.identity, sessionId) // interviewer → 403，零读取
  const body = await readJsonObject(req)
  const rejected = OVERRIDE_BODY_KEYS.filter((k) => Object.hasOwn(body, k)).sort()
  if (rejected.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', '身份键由服务端派生', { rejected })
  }
  const cfg = requireDatabase(deps)
  const stored = deps.hooks?.readWebhookSetting !== undefined
    ? await deps.hooks.readWebhookSetting()
    : (await withPool(cfg, (pool) => withReadOnly(pool, (client) =>
        readSetting(client, cfg.tenant_id, SETTING_KEY))))?.value
  const active = dispatchableConfig(stored)
  if (active === null) {
    throw problem(503, 'NOT_CONFIGURED', 'WEBHOOK_NOT_READY',
      'Webhook 未就绪：需开启、配置合法地址、设置签名密钥并订阅至少一个事件')
  }
  // 测试事件固定为 decision.recorded（不改变订阅集合，只做一次真实外发）。
  const event: WebhookEvent = WEBHOOK_EVENTS[0]
  const result = await postSigned(cfg, deps, active.url, active.secret_hash as string, event, {
    test: true,
    application_id: 'test',
  }, AUDIT_TEST_EVENT_TYPE)
  if (!result.ok) {
    // 绝不伪造成功：真实上游状态码原样回传（无状态码的网络错误用 502）。
    const status = result.status !== undefined && result.status >= 400 && result.status < 600
      ? result.status
      : 502
    json(res, status, {
      error: {
        code: 'WEBHOOK_DELIVERY_FAILED',
        reason_code: 'UPSTREAM_ERROR',
        message: 'Webhook 测试推送失败（未伪造成功）',
        detail: { status: result.status ?? null, error: result.error ?? null },
      },
    })
    return
  }
  json(res, 200, { status: 'DELIVERED', http_status: result.status ?? 200, event })
}

// ---------------------------------------------------------------------------
//  注册
// ---------------------------------------------------------------------------

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

export function registerExportHttp(ctx: ExportHostContext, deps: ExportHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 导出/Webhook 路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const routes: readonly (readonly [string, 'GET' | 'POST', (req: IncomingMessage, res: ServerResponse) => Promise<void>])[] = [
    [EXPORT_PATHS.applicationsCsv, 'GET', (req, res) => handleCsv(deps, req, res)],
    [EXPORT_PATHS.webhookTest, 'POST', (req, res) => handleWebhookTest(deps, req, res)],
  ]
  const disposers = routes.map(([path, method, handler]) =>
    webServer.register({
      kind: 'exact',
      path,
      handler: guard(async (req, res) => {
        assertSameOrigin(req, port)
        if (req.method !== method) { methodNotAllowed(res, method); return }
        await handler(req, res)
      }),
    }),
  )
  return () => {
    for (const dispose of disposers) { try { dispose() } catch { /* 卸载尽力而为 */ } }
  }
}

/** 测试用：对原文计算 HMAC（与派发器同一算法），供接收端断言。 */
export function signatureFor(secretHash: string, body: string): string {
  return `sha256=${createHmac('sha256', Buffer.from(secretHash, 'hex')).update(body, 'utf8').digest('hex')}`
}

/** 测试用：对 secret 计算 sha256（与写入口同一算法）。 */
export function secretHashOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}
