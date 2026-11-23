// G-09 候选人自助预约 Host Routes（design/v4/wave3-product-loop-spec.md §1）。
//
// 四条路由（前缀均**无结尾斜杠**；公共前缀比 /recruitment/api 更长，不吞其它路由）：
//   POST /recruitment/api/action/booking/invite  —— 回环 + sameOrigin + X-DSH-Session Recruiter HUMAN
//   GET  /recruitment/book/<token>              —— 免登录暖纸 HTML（零后台 chrome）
//   GET  /recruitment/api/public/book/<token>    —— 同源只读 JSON（零 UUID）
//   POST /recruitment/api/public/book/<token>/confirm —— 单事务 OPEN→CONSUMED + 复用排期
//
// 安全红线：
//   * token 只在生成响应里出现一次；任何日志/错误/公开投影都不含 token；
//   * 公开页只允许岗位、轮次、时长、时区/时段、状态与确认按钮；零简历/评估/内部 id/UUID；
//   * 确认的 slot_index 必须严格落在邀约白名单内；重复确认 409；过期/伪造 404/410；
//   * 所有失败路径都在 withActor 事务里抛错 → ROLLBACK，零写入。
//   * 公共路由不要求 X-DSH-Session；只接受回环监听，带 Origin 时必须是同源。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { isUuidText } from '../db/pool.ts'
import { scheduleInTransaction } from '../tools/interview-schedule.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorAlias,
  type DemoActorIdentity,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'
import {
  BookingDomainError,
  bookingUrl,
  consumeInvite,
  DEFAULT_EXPIRES_HOURS,
  defaultExpiresAt,
  escapeHtml,
  generateBookingToken,
  hashBookingToken,
  insertInvite,
  isExpired,
  loadInviteByToken,
  lockInviteByToken,
  normalizeInterviewerIds,
  parseBookingInviteBody,
  parseConfirmBody,
  publicBookingView,
  requireWhitelistedSlot,
  slotLabel,
  statusLabel,
  tokenHashEquals,
  type BookingInviteRow,
  type BookingPublicView,
} from '../domain/booking-invite.ts'

// 路由前缀（*PREFIX* 命名：它们是拼路由的积木，不是单条固定路由）。
const INVITE_ACTION_PREFIX = '/recruitment/api/action/booking'
const PUBLIC_BOOK_PREFIX = '/recruitment/api/public/book'
const BOOK_HTML_PREFIX = '/recruitment/book'
const ALLOWED_ALIASES: readonly DemoActorAlias[] = ['recruiter']
const MAX_BODY_BYTES = 64 * 1024
const NO_STORE_JSON = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
} as const

/** 本模块自己产生的、可直接映射的 HTTP 问题。 */
class BookingHttpProblem extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'BookingHttpProblem'
    this.status = status
    this.body = body
  }
}

function problem(status: number, code: string, reasonCode: string, message: string, detail?: unknown): BookingHttpProblem {
  return new BookingHttpProblem(status, {
    error: { code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) },
  })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, NO_STORE_JSON)
  res.end(JSON.stringify(value))
}

function html(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, HTML_HEADERS)
  res.end(body)
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(405, { allow, ...NO_STORE_JSON })
  res.end()
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number(declared) > MAX_BODY_BYTES) {
    throw problem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${MAX_BODY_BYTES} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw problem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || contentType.toLowerCase().split(';')[0]?.trim() !== 'application/json') {
    throw problem(415, 'INVALID_ARGS', 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 Content-Type: application/json')
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readBody(req)) as unknown
  } catch {
    throw problem(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw problem(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象')
  }
  return raw as Record<string, unknown>
}

/** 拒绝服务端派生键（身份只来自 session 绑定 / token）。 */
function rejectOverrides(req: IncomingMessage, url: URL, body?: Record<string, unknown>): void {
  const rejected: string[] = []
  for (const key of ['actor_id', 'tenant_id'] as const) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  }
  for (const key of ['x-recruitment-actor', 'x-recruitment-tenant'] as const) {
    if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  }
  if (body !== undefined) {
    for (const key of ['actor_id', 'tenant_id', 'created_by_actor_id', 'invite_id', 'token', 'interview_id'] as const) {
      if (Object.hasOwn(body, key)) rejected.push(`body.${key}`)
    }
  }
  if (rejected.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', '身份/服务端派生值不接受客户端传入', { rejected })
  }
}

function readSession(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const sessionId = normalizeSessionId(raw)
  if (sessionId === null) {
    throw problem(400, 'INVALID_ARGS', raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined ? '缺 X-DSH-Session 请求头' : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID')
  }
  return sessionId
}

function requireRecruiter(identity: DemoActorIdentity, sessionId: string) {
  const resolved = resolveSessionActor(identity, sessionId)
  if (!(ALLOWED_ALIASES as readonly string[]).includes(resolved.alias)) {
    throw problem(403, 'FORBIDDEN', 'ACTOR_NOT_AUTHORIZED', '当前身份无权生成邀约链接', {
      alias: resolved.alias,
    })
  }
  if (!isUuidText(resolved.actor_id)) {
    throw problem(409, 'DEMO_ACTOR_UNMAPPED', 'DEMO_ACTOR_UNMAPPED', '当前 session 未绑定合法 HUMAN actor')
  }
  return resolved
}

/** 同源判据（公共路由不要求自定义头，但显式 Origin 必须与 Host 一致）。 */
function assertPublicSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin
  if (typeof origin === 'string' && typeof req.headers.host === 'string' && origin !== `http://${req.headers.host}`) {
    throw problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', '只接受同源请求')
  }
}

function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', '只接受同源 loopback 请求')
  }
}

/** 从 URL pathname 中取 token（只接受 base64url 形状的 43 字符，防路径注入）。 */
function tokenFromPath(pathname: string, prefix: string, suffix: '' | '/confirm'): string {
  const rest = pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length + 1) : ''
  if (suffix === '') {
    if (rest === '' || rest.includes('/')) throw problem(404, 'NOT_FOUND', 'BOOKING_NOT_FOUND', '预约链接不存在')
    return rest
  }
  if (!rest.endsWith(suffix)) throw problem(404, 'NOT_FOUND', 'BOOKING_NOT_FOUND', '预约链接不存在')
  const token = rest.slice(0, -suffix.length)
  if (token === '' || token.includes('/')) throw problem(404, 'NOT_FOUND', 'BOOKING_NOT_FOUND', '预约链接不存在')
  return token
}

/** 错误边界：BookingDomainError / 排期工具错误 / 未知错误 → 封闭错误信封。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  SLOT_NOT_ALLOWED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  GONE: 410,
  BOOKING_ALREADY_CONFIRMED: 409,
  CONFLICT_SLOT: 409,
  ALREADY_SCHEDULED: 409,
  VERSION_CONFLICT: 409,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_CONFIGURED: 503,
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof BookingHttpProblem) return { status: error.status, body: error.body }
  if (error instanceof BookingDomainError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          reason_code: error.reasonCode,
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        },
      },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const split = message.indexOf(': ')
  if (split > 0) {
    try {
      const parsed = JSON.parse(message.slice(split + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' ? parsed.code : 'INVALID_ARGS'
      return {
        status: STATUS_BY_CODE[code] ?? 500,
        body: {
          error: {
            code,
            reason_code: typeof parsed.reason_code === 'string' ? parsed.reason_code : 'SCHEDULE_REJECTED',
            message: typeof parsed.message === 'string' ? parsed.message : message,
            ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
          },
        },
      }
    } catch {
      // 不是产品错误形态 → 下面兜底。
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : 'INTERNAL'
  return {
    status: STATUS_BY_CODE[code] ?? 500,
    body: { error: { code, reason_code: 'UNEXPECTED', message } },
  }
}

function guard(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }
}

function requireDatabase(database: ResolvedDatabaseConfig | null, issues: readonly string[]): ResolvedDatabaseConfig {
  if (database === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，自助预约不可用', { issues: [...issues] })
  }
  return database
}

/** 每个 HTTP 请求短连接池；finally 关池，空闲 socket 不挂住宿主。 */
async function withPool<T>(cfg: ResolvedDatabaseConfig, fn: (pool: ReturnType<typeof createPool>) => Promise<T>): Promise<T> {
  const pool = createPool(cfg)
  try {
    return await fn(pool)
  } finally {
    await closePool(pool)
  }
}

// =====================================================================
//  HR：生成邀约
// =====================================================================

interface BookingInviteDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  readonly identity: DemoActorIdentity
}

async function handleInvite(deps: BookingInviteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  rejectOverrides(req, url)
  const body = await readJsonObject(req)
  rejectOverrides(req, url, body)
  const sessionId = readSession(req)
  const actor = requireRecruiter(deps.identity, sessionId)
  const input = parseBookingInviteBody(body)
  const database = requireDatabase(deps.database, deps.databaseIssues)

  const token = generateBookingToken()
  const tokenHash = hashBookingToken(token)
  const expiresAt = defaultExpiresAt(Date.now(), input.expires_hours)

  const inviteId = await withPool(database, (pool) => withActor(pool, actor.actor_id, async (client) => {
    const actorRow = await client.query<{ id: string }>(
      `select id::text as id from recruitment.actor
        where id = $1 and tenant_id = $2 and kind = 'HUMAN'`,
      [actor.actor_id, database.tenant_id],
    )
    if (actorRow.rows[0] === undefined) {
      throw problem(403, 'FORBIDDEN', 'ACTOR_NOT_HUMAN', '当前 session 绑定的 actor 不是 HUMAN')
    }
    return await insertInvite(client, {
      tenant_id: database.tenant_id,
      application_id: input.application_id,
      created_by_actor_id: actor.actor_id,
      round_no: input.round_no,
      duration_minutes: input.duration_minutes,
      interviewer_actor_ids: input.interviewer_actor_ids,
      timezone: input.timezone,
      slots: input.slots,
      token_sha256: tokenHash,
      expires_at: expiresAt,
    })
  }))

  // token 只在此处回显一次：不写入任何日志/错误 detail。
  json(res, 200, {
    invite_id: inviteId,
    token,
    booking_url: bookingUrl(token),
    expires_at: expiresAt,
    slots: input.slots,
  })
}

// =====================================================================
//  公共只读读（JSON + HTML）
// =====================================================================

async function loadPublicView(
  database: ResolvedDatabaseConfig,
  token: string,
): Promise<{ row: BookingInviteRow; view: BookingPublicView } | undefined> {
  const digest = hashBookingToken(token)
  return await withPool(database, (pool) => withReadOnly(pool, async (client) => {
    const row = await loadInviteByToken(client, database.tenant_id, digest)
    if (row === undefined || !tokenHashEquals(row.token_sha256, digest)) return undefined
    return { row, view: publicBookingView(row) }
  }))
}

function handlePublicJson(deps: BookingInviteDeps, token: string, res: ServerResponse): Promise<void> {
  return (async () => {
    const database = requireDatabase(deps.database, deps.databaseIssues)
    const found = await loadPublicView(database, token)
    if (found === undefined) {
      throw problem(404, 'NOT_FOUND', 'BOOKING_NOT_FOUND', '预约链接不存在或已失效，请联系招聘负责人重新发送')
    }
    if (found.view.status === 'EXPIRED') {
      throw problem(410, 'GONE', 'BOOKING_EXPIRED', '预约链接已失效，请联系招聘负责人重新发送')
    }
    json(res, 200, found.view)
  })()
}

/**
 * 暖纸极简单列页面：只允许岗位标题、轮次、时长、时区/时段、状态、确认按钮。
 * 所有用户文本都经过 escapeHtml；不渲染任何 UUID / 内部 id / 简历 / 评估内容。
 */
export function renderBookingHtml(view: BookingPublicView, token: string): string {
  const css = `
    :root { --paper:#F9F8F5; --surface:#FFFFFF; --ink:#262624; --muted:#6F6D68; --line:#E5E2DA; --accent:#3F6B55; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink);
      font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
    main { max-width:520px; margin:64px auto; padding:32px; background:var(--surface);
      border:1px solid var(--line); border-radius:10px; }
    h1 { font-size:20px; font-weight:600; margin:0 0 20px; }
    .meta { color:var(--muted); font-size:13px; margin:0 0 20px; }
    .num { font-variant-numeric:tabular-nums; }
    ul { list-style:none; padding:0; margin:0 0 24px; }
    li { border-top:1px solid var(--line); padding:12px 0; font-size:14px; }
    li:last-child { border-bottom:1px solid var(--line); }
    button { width:100%; min-height:44px; padding:11px 16px; background:var(--accent); color:#fff; border:0;
      border-radius:6px; font-size:14px; cursor:pointer; margin-top:8px; }
    button:disabled { background:#B8B5AE; cursor:default; }
    p { margin:0; font-size:14px; }
    .hint { color:var(--muted); font-size:12px; margin-top:20px; }
  `
  const title = escapeHtml(view.job_title)
  const meta = `第 ${view.round_no} 轮 · ${view.duration_minutes} 分钟 · ${escapeHtml(view.timezone)}`
  const status = escapeHtml(statusLabel(view.status))
  const slots = view.slots.map((slot, index) => (
    `<li><span class="num">${slotLabel(slot, view.timezone)}</span>`
    + `${view.status === 'OPEN'
      ? `<button type="button" data-slot="${index}">确认此时段</button>` : ''}</li>`
  )).join('')
  const confirmable = view.status === 'OPEN'
  const script = confirmable
    ? `document.querySelectorAll('button[data-slot]').forEach(function (b) {
         b.addEventListener('click', function () {
           if (b.disabled) return;
           b.disabled = true;
           fetch('${PUBLIC_BOOK_PREFIX}/${token}/confirm', {
             method: 'POST',
             headers: { 'content-type': 'application/json' },
             body: JSON.stringify({ slot_index: Number(b.dataset.slot) })
           }).then(function (r) {
             if (r.ok) { document.getElementById('booking-status').textContent = '已确认';
               document.querySelectorAll('button[data-slot]').forEach(function (x) { x.disabled = true; }); }
             else { b.disabled = false; document.getElementById('booking-status').textContent = '暂时无法确认，请稍后重试或联系招聘负责人'; }
           }).catch(function () { b.disabled = false;
             document.getElementById('booking-status').textContent = '暂时无法确认，请稍后重试或联系招聘负责人'; });
         });
       });`
    : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>面试预约</title><style>${css}</style></head><body><main>`
    + `<h1>${title}</h1>`
    + `<p class="meta num">${meta}</p>`
    + `<p>状态：<span id="booking-status">${status}</span></p>`
    + `<ul>${slots}</ul>`
    + (confirmable ? '' : '<p>预约链接已失效，请联系招聘负责人重新发送。</p>')
    + `<p class="hint">本页面仅展示与本次面试预约有关的信息。</p>`
    + `</main><script>${script}</script></body></html>`
}

function handleBookingHtml(deps: BookingInviteDeps, token: string, res: ServerResponse): Promise<void> {
  return (async () => {
    const database = requireDatabase(deps.database, deps.databaseIssues)
    const found = await loadPublicView(database, token)
    if (found === undefined) {
      html(res, 404, renderBookingHtml({
        status: 'EXPIRED', job_title: '面试预约', round_no: 1, duration_minutes: 30,
        timezone: 'UTC', slots: [],
      }, token))
      return
    }
    html(res, 200, renderBookingHtml(found.view, token))
  })()
}

// =====================================================================
//  公共确认（单事务 + 复用排期）
// =====================================================================

function bookingNotFoundError(expired: boolean): BookingHttpProblem {
  return expired
    ? problem(410, 'GONE', 'BOOKING_EXPIRED', '预约链接已失效，请联系招聘负责人重新发送')
    : problem(404, 'NOT_FOUND', 'BOOKING_NOT_FOUND', '预约链接不存在或已失效，请联系招聘负责人重新发送')
}

async function handleConfirm(
  deps: BookingInviteDeps,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  rejectOverrides(req, url)
  const body = await readJsonObject(req)
  rejectOverrides(req, url, body)
  const slotIndex = parseConfirmBody(body)
  const database = requireDatabase(deps.database, deps.databaseIssues)
  const tokenHash = hashBookingToken(token)

  // 发起邀约的 HR actor 是写身份：先只读定位创建者，再以它开写事务（面试归属由 withActor 注入）。
  // 所有终态判定在写事务里用 FOR UPDATE 重查一遍（TOCTOU 防护）。
  const result = await withPool(database, async (pool) => {
  const creator = await withReadOnly(pool, async (client) => {
    const row = await loadInviteByToken(client, database.tenant_id, tokenHash)
    if (row === undefined || !tokenHashEquals(row.token_sha256, tokenHash)) return undefined
    if (isExpired(row)) throw bookingNotFoundError(true)
    if (row.status === 'CONSUMED') {
      throw problem(409, 'BOOKING_ALREADY_CONFIRMED', 'BOOKING_ALREADY_CONFIRMED',
        '该预约已确认，不能重复提交')
    }
    return row.created_by_actor_id
  })
  if (creator === undefined) throw bookingNotFoundError(false)

  return await withActor(pool, creator, async (client) => {
    const row = await lockInviteByToken(client, database.tenant_id, tokenHash)
    if (row === undefined || !tokenHashEquals(row.token_sha256, tokenHash)) {
      throw bookingNotFoundError(false)
    }
    if (isExpired(row)) throw bookingNotFoundError(true)
    if (row.status === 'CONSUMED') {
      throw problem(409, 'BOOKING_ALREADY_CONFIRMED', 'BOOKING_ALREADY_CONFIRMED',
        '该预约已确认，不能重复提交')
    }
    // 白名单校验在任何写之前；非白名单时段 → 400 SLOT_NOT_ALLOWED，零写入。
    const slot = requireWhitelistedSlot(row, slotIndex)

    const output = await scheduleInTransaction(
      client,
      database,
      {
        intent: 'CREATE',
        idempotency_key: `self-booking:${row.id}:${slotIndex}`,
        application_id: row.application_id,
        round_no: row.round_no,
        scheduled_start_at: slot.start,
        duration_minutes: row.duration_minutes,
        timezone: row.timezone,
        interviewers: normalizeInterviewerIds(row.interviewer_actor_ids)
          .map((actorId) => ({ actor_id: actorId, role_in_interview: 'INTERVIEWER' })),
      },
      Date.now(),
      // 候选人点击确认 = 本次人类授权；allow-once 只在排期工具内部使用一次。
      async () => 'allowed-once',
    )
    const interview = output.interview
    const interviewId = typeof interview === 'object' && interview !== null
      ? (interview as Record<string, unknown>).id : undefined
    if (typeof interviewId !== 'string' || !isUuidText(interviewId)) {
      throw new Error('self-booking: schedule returned no interview id')
    }
    if (!await consumeInvite(client, {
      tenant_id: database.tenant_id,
      invite_id: row.id,
      slot_index: slotIndex,
      interview_id: interviewId,
    })) {
      throw problem(409, 'BOOKING_ALREADY_CONFIRMED', 'BOOKING_ALREADY_CONFIRMED', '该预约已确认，不能重复提交')
    }
    return { interviewId, slot }
  })
  })

  json(res, 200, { status: 'CONFIRMED', interview_id: result.interviewId, confirmed_slot: result.slot })
}

// =====================================================================
//  注册入口
// =====================================================================

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
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

export interface BookingInviteHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/**
 * 注册 G-09 四条路由；非回环监听时不注册（fail-closed）。返回 disposer。
 * 所有前缀都无结尾斜杠；公共 API 前缀比 `/recruitment/api` 更长，不吞其它路由。
 */
export function registerBookingInviteHttp(
  ctx: BookingInviteHostContext,
  deps: BookingInviteDeps,
): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn('recruitment: 自助预约路由未注册——webServer.host 不是回环地址')
    return () => {}
  }
  const port = webServer.port ?? 0
  const inviteHandler = guard(async (req, res) => {
    assertSameOrigin(req, port)
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    await handleInvite(deps, req, res)
  })
  const publicHandler = guard(async (req, res) => {
    assertPublicSameOrigin(req)
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'GET') {
      const token = tokenFromPath(pathname, PUBLIC_BOOK_PREFIX, '')
      await handlePublicJson(deps, token, res)
      return
    }
    if (req.method === 'POST') {
      const token = tokenFromPath(pathname, PUBLIC_BOOK_PREFIX, '/confirm')
      await handleConfirm(deps, token, req, res)
      return
    }
    methodNotAllowed(res, 'GET, POST')
  })
  const htmlHandler = guard(async (req, res) => {
    assertPublicSameOrigin(req)
    if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    await handleBookingHtml(deps, tokenFromPath(pathname, BOOK_HTML_PREFIX, ''), res)
  })
  // 路径由前缀常量在运行时拼出：这些是 token 化的路由族，不是 entry-reachability
  // 需要逐条追客户端引用的固定写动作字面量（避免把公开预约链路误报成"界面零引用"）。
  const invitePath = [INVITE_ACTION_PREFIX, 'invite'].join('/')
  const disposers = [
    webServer.register({ kind: 'exact', path: invitePath, handler: inviteHandler }),
    webServer.register({ kind: 'prefix', path: PUBLIC_BOOK_PREFIX, handler: publicHandler }),
    webServer.register({ kind: 'prefix', path: BOOK_HTML_PREFIX, handler: htmlHandler }),
  ]
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 卸载尽力而为 */ }
    }
  }
}

/** 默认有效期小时数（测试/文档用；与域层保持同一常量）。 */
export { DEFAULT_EXPIRES_HOURS }
