// 候选人星标（主推标记）HTTP Host Remote Action。
//
// 只注册一条 exact 路由：
//   POST /recruitment/api/action/application/star
//   body { application_id, starred, confirmation_text }
//
// 闸门照 `http/actions.ts` / `http/batch-undo.ts` 既有模式（逐条照抄判据，不复制业务逻辑）：
//   * 非回环 host → 不注册任何路由（fail-closed）；
//   * sameOrigin（Host=127.0.0.1/localhost:<port> + x-recruitment-request:1）；
//   * `x-dsh-session` → resolveSessionActor（与写工具共享同一个 identity 单例）；
//     未绑定 → 409 DEMO_ACTOR_UNMAPPED；越权（非 recruiter）→ 403 FORBIDDEN（零写入）；
//   * 身份覆盖键（actor_id/tenant_id/… 与 confirmation_text_sha256）在 body/query/header
//     出现即 400 零写入；
//   * `confirmation_text` 是人的原话，sha256 只由服务端算（sha256Text）；
//   * 数据库未配置 → 503（不假装成功）。
//
// 语义：`starred` 是人工判断（亮星/取消星）。每次请求追加一条 application_star 事实行
// （append-only），并另开只读连接读回"最新一行"作为当前值。actor 只来自 session 绑定。
// 不新增工具（工具面 33 不变）、不新增事件类型、不碰 application 业务列。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { findLatestApplicationStar, insertApplicationStar } from '../db/application-star.ts'
import { sha256Text } from '../domain/criterion-override.ts'
import { isUuid } from '../tools/contract.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorAlias,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'

// =====================================================================
//  契约常量
// =====================================================================

const STAR_PATH = '/recruitment/api/action/application/star'

/** 允许调用写动作的受控 alias（与 http/actions.ts 同口径）。 */
const ALLOWED_ALIASES: readonly DemoActorAlias[] = ['recruiter']

/** 请求体上限 64 KiB（超限 413，零写入）。 */
const MAX_BODY_BYTES = 64 * 1024

/** 身份 / 服务端派生键：命中即 400（零写入）。 */
const ACTOR_OVERRIDE_BODY_KEYS = [
  'actor_id', 'tenant_id', 'actor', 'tenant', 'alias', 'actor_alias',
  'confirmation_text_sha256', 'confirmation_text_sha256_hex',
] as const
const ACTOR_OVERRIDE_QUERY_KEYS = ['actor_id', 'tenant_id'] as const
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const

/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 错误码 → HTTP 状态（未列出的码一律 500，不猜）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_CONFIGURED: 503,
  DB_CONSTRAINT_VIOLATION: 500,
  INVARIANT_VIOLATION: 500,
}

// =====================================================================
//  宿主上下文 / 依赖
// =====================================================================

interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** `src/index.ts` 把 cordis Context 窄成这个形状再传进来。 */
export interface StarHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 路由依赖：库配置 + 与写工具共享的 Demo Actor 身份单例。 */
export interface StarHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  readonly identity: DemoActorIdentity
}

// =====================================================================
//  HTTP 小工具（封闭错误信封）
// =====================================================================

class StarProblem extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'StarProblem'
    this.status = status
    this.body = body
  }
}

function problem(status: number, code: string, reasonCode: string, message: string, detail?: unknown): StarProblem {
  return new StarProblem(status, {
    error: { code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) },
  })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(405, { allow, ...NO_STORE })
  res.end()
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number.isFinite(Number(declared)) && Number(declared) > MAX_BODY_BYTES) {
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
  const text = await readBody(req)
  let raw: unknown
  try { raw = JSON.parse(text) as unknown } catch {
    throw problem(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw problem(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body' })
  }
  return raw as Record<string, unknown>
}

function rejectOverrides(req: IncomingMessage, url: URL, body: Record<string, unknown>): void {
  const rejected: string[] = []
  for (const key of ACTOR_OVERRIDE_QUERY_KEYS) if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  for (const key of ACTOR_OVERRIDE_HEADERS) if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  for (const key of ACTOR_OVERRIDE_BODY_KEYS) if (Object.hasOwn(body, key)) rejected.push(`body.${key}`)
  if (rejected.length > 0) {
    throw problem(
      400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 与服务端派生 hash 只能来自服务端，不接受客户端传入（D-33 / D-95，零写入）',
      { rejected },
    )
  }
}

function readSession(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw problem(
      400, 'INVALID_ARGS',
      raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined ? '缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）' : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID',
    )
  }
  return normalized
}

function requireActor(deps: StarHttpDeps, req: IncomingMessage): ResolvedExecutionActor {
  // resolveSessionActor 未绑定时抛 DEMO_ACTOR_UNMAPPED（零写入）。
  const resolved = resolveSessionActor(deps.identity, readSession(req))
  if (!(ALLOWED_ALIASES as readonly string[]).includes(resolved.alias)) {
    throw problem(
      403, 'FORBIDDEN', 'ACTOR_NOT_AUTHORIZED',
      `当前身份（${resolved.alias}）无权执行该招聘写动作（只允许 ${ALLOWED_ALIASES.join(', ')}）`,
      { alias: resolved.alias, allowed_aliases: [...ALLOWED_ALIASES] },
    )
  }
  return resolved
}

function requireDatabase(deps: StarHttpDeps): ResolvedDatabaseConfig {
  if (deps.database === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，写动作不可用', {
      issues: [...deps.databaseIssues],
    })
  }
  return deps.database
}

/** 服务端算 confirmation_text 的 sha256（人的原话；派生 hash 禁从 body 传入）。 */
function confirmationSha256(body: Record<string, unknown>): { text: string; sha256: string } {
  const text = body.confirmation_text
  if (typeof text !== 'string' || text.trim() === '' || text.length > 2000) {
    throw problem(
      400, 'INVALID_ARGS', 'MISSING_REQUIRED',
      '缺必填字段 "confirmation_text"（人的原话，非空且 ≤2000 字符）',
      { missing: ['confirmation_text'] },
    )
  }
  return { text, sha256: sha256Text(text) }
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof StarProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : message.slice(0, index)
      return {
        status: STATUS_BY_CODE[code] ?? 500,
        body: {
          error: {
            code,
            ...(typeof parsed.reason_code === 'string' ? { reason_code: parsed.reason_code } : {}),
            message: typeof parsed.message === 'string' ? parsed.message : message,
            ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
          },
        },
      }
    } catch { /* 不是产品错误形态，下面兜底 */ }
  }
  const maybeCode = (error as { code?: unknown } | null)?.code
  const code = typeof maybeCode === 'string' && maybeCode !== '' ? maybeCode : 'INTERNAL'
  return {
    status: STATUS_BY_CODE[code] ?? 500,
    body: { error: { code, reason_code: 'UNEXPECTED', message } },
  }
}

function guard(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try { await handler(req, res) } catch (error) {
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }
}

// =====================================================================
//  POST /recruitment/api/action/application/star
// =====================================================================

/** 成功响应：事实 + 当前值（独立读回）。 */
interface StarResponse {
  readonly action: 'application/star'
  readonly application_id: string
  readonly actor: { readonly session_id: string; readonly alias: string; readonly actor_id: string }
  readonly starred: boolean
  readonly star_id: string
  readonly confirmation_text_sha256: string
}

async function handleStar(deps: StarHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  // 闸门顺序与 actions.ts 一致：session→actor / 越权 / body 形状与身份覆盖 / 库配置。
  // 任一步失败都在碰 DB 之前 fail-closed（零写入）。
  const resolved = requireActor(deps, req)
  const body = await readJsonObject(req)
  rejectOverrides(req, url, body)
  const confirmation = confirmationSha256(body)

  const applicationId = body.application_id
  if (typeof applicationId !== 'string' || applicationId === '') {
    throw problem(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "application_id"', { missing: ['application_id'] })
  }
  if (!isUuid(applicationId)) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_UUID', '字段 "application_id" 必须是 UUID', { path: 'application_id' })
  }
  if (typeof body.starred !== 'boolean') {
    throw problem(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '字段 "starred" 必须是 boolean', { path: 'starred' })
  }

  // 所有 4xx 客户端错误（身份/形状）都在库配置检查之前完成：
  // 未配置库的 503 不应盖住明确的客户端错误（与 actions.ts::readActionRequest 同口径）。
  const database = requireDatabase(deps)

  // 写：actor 只来自 session → alias 解析；application_id 带租户条件，越权申请不存在 → 404 零写入。
  // 短连接池：finally 关池，避免空闲 socket 挂住宿主（与 http/actions.ts 的 withPool 同款）。
  const writePool = createPool(database)
  let starId: string
  try {
    starId = await withActor(writePool, resolved.actor_id, async (client) => {
      // 先只读确认申请属于本租户（越权 fail-closed，且不写星标事实）。
      const app = await client.query<{ id: string }>(
        `select id::text as id from recruitment.application where id = $1::uuid and tenant_id = $2::uuid`,
        [applicationId, database.tenant_id],
      )
      if (app.rows[0] === undefined) {
        throw problem(404, 'NOT_FOUND', 'APPLICATION_NOT_FOUND', '申请不在本租户下或不存在', { application_id: applicationId })
      }
      return insertApplicationStar(client, {
        tenant_id: database.tenant_id,
        application_id: applicationId,
        starred: body.starred as boolean,
        actor_id: resolved.actor_id,
        confirmation_text_sha256: confirmation.sha256,
      })
    })
  } finally {
    await closePool(writePool)
  }

  // 独立只读读回"当前值 = 最新一行"（不是回显请求）。
  const readPool = createPool(database)
  let current: boolean
  try {
    current = await withReadOnly(readPool, async (client) => {
      const row = await findLatestApplicationStar(client, database.tenant_id, applicationId)
      return row === undefined ? false : row.starred === true
    })
  } finally {
    await closePool(readPool)
  }

  json(res, 200, {
    action: 'application/star',
    application_id: applicationId,
    actor: { session_id: resolved.session_id, alias: resolved.alias, actor_id: resolved.actor_id },
    starred: current,
    star_id: starId,
    confirmation_text_sha256: confirmation.sha256,
  } satisfies StarResponse)
}

// =====================================================================
//  注册入口
// =====================================================================

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

function postRoute(port: number, handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return guard(async (req, res) => {
    if (!sameOrigin(req, port)) {
      throw problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）')
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const key of ACTOR_OVERRIDE_QUERY_KEYS) {
      if (url.searchParams.has(key)) {
        throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', 'actor/tenant 不接受 query 覆盖', { rejected: [`query.${key}`] })
      }
    }
    for (const key of ACTOR_OVERRIDE_HEADERS) {
      if (req.headers[key] !== undefined) {
        throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', 'actor/tenant 不接受 header 覆盖', { rejected: [`header.${key}`] })
      }
    }
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    await handle(req, res)
  })
}

/**
 * 注册星标写路由；非回环不注册（fail-closed），返回 disposer。
 * @param ctx - 宿主上下文（含 webServer）。
 * @param deps - 库配置 + Demo Actor 身份（与工具共享的同一个实例）。
 * @returns 注销函数。
 */
export function registerStarHttp(ctx: StarHostContext, deps: StarHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 星标路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  return webServer.register({ kind: 'exact', path: STAR_PATH, handler: postRoute(port, (req, res) => handleStar(deps, req, res)) })
}
