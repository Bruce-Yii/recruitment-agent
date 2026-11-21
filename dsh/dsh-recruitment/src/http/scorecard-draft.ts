// A4 面评草稿的宿主 HTTP 路由（自包含注册器 `registerScorecardDraftHttp`）。
//
// 契约：
//   GET  /recruitment/api/action/scorecard/draft?interview_id=<uuid>   —— 只读投影（返回最新草稿；无草稿返回 null）
//   POST /recruitment/api/action/scorecard/draft                        —— 追加一行草稿版本（append-only）
//     body `{ interview_id, payload: { assessments?: {criterion_key: value}, note?: string } }`
//     **不需要 confirmation_text**：草稿不是决定、不是人的最终判断（所以出现该键按未知键拒）。
//
// 边界（与 actor.ts / interviewer.ts 同一套纪律，全部在碰 DB 之前 fail-closed）：
//   1. 非回环 host 不注册路由；sameOrigin（loopback + x-recruitment-request: 1 + Origin）→ 403；
//   2. 身份**有且只有** `X-DSH-Session` → session→alias→HUMAN actor（复用 W1 单例 identity）；
//      未绑定 → 409 DEMO_ACTOR_UNMAPPED；客户端 `actor_id`/`tenant_id`（query/header/body）
//      在碰 DB 之前 400；
//   3. 本人是该场面试官（recruitment.interviewer 行）→ 否则 403 INTERVIEWER_MISMATCH；
//   4. **已提交面评不允许再写草稿**（当前 scorecard status ∈ {SUBMITTED, WAIVED} → 409
//      SCORECARD_ALREADY_SUBMITTED，零写入）；GET 不受此限（提交后仍可读回历史草稿）；
//   5. payload ≤ 32KB（应用端 UTF-8 字节数 + 库端 pg_column_size 两道）→ 413/400，零写入；
//   6. 写路径**单事务** withActor(actor_id)：只读守卫全部通过后才 saveDraft（append-only + 版本 +1）；
//      写后**独立只读读回**（不信 saveDraft 自述）；
//   7. **绝不调用** scorecard-submit / 不碰 `recruitment/scorecard/submit` 任何一行代码或表。
//
// 本文件不注册到 index.ts（由 owner 收口，只给两行接线清单）。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import { isUuid } from '../tools/contract.ts'
import { sameOrigin } from './overview.ts'
import {
  MAX_DRAFT_PAYLOAD_BYTES,
  assertDraftWritable,
  readDraft,
  saveDraft,
  validateDraftPayload,
  type ScorecardDraftRow,
} from '../db/scorecard-draft.ts'

// =====================================================================
//  契约常量
// =====================================================================

/** 两条路由共用同一个 exact path（方法分派）。 */
const DRAFT_PATH = '/recruitment/api/action/scorecard/draft'
/** 只读查询允许的参数（只有 interview_id）。 */
const QUERY_KEYS = ['interview_id'] as const
/** 写 body 允许的键（没有 confirmation_text，也没有身份键）。 */
const BODY_KEYS = ['interview_id', 'payload'] as const
/** 客户端不许覆盖的身份键（query / body，命中即 400，不碰 DB）。 */
const ACTOR_OVERRIDE_KEYS = ['actor_id', 'tenant_id'] as const
/** 客户端不许覆盖的身份头。 */
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
/** 非回环地址不注册。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1'])
/** 请求体上限：48 KiB（payload 本身 ≤ 32KB，留足 JSON 包装与转义空间）。 */
const MAX_BODY_BYTES = 48 * 1024
/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 契约错误码 → HTTP 状态（封闭集；未列出按 500）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  INTERVIEWER_MISMATCH: 403,
  FORBIDDEN: 403,
  SCORECARD_ALREADY_SUBMITTED: 409,
  DRAFT_PAYLOAD_TOO_LARGE: 413,
  DRAFT_PAYLOAD_TYPE: 400,
  DRAFT_PAYLOAD_UNKNOWN_KEY: 400,
  DRAFT_ASSESSMENTS_TYPE: 400,
  DRAFT_NOTE_TYPE: 400,
  NOT_CONFIGURED: 503,
  DEMO_ACTOR_UNMAPPED: 409,
  DB_CONSTRAINT_VIOLATION: 500,
}

// =====================================================================
//  宿主上下文（窄接口，由 index.ts 装配；本文件不 import index.ts）
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

export interface ScorecardDraftHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 注册器依赖：库配置 + 已装配的 Demo Actor 身份（与所有写工具/Host Action 共享同一单例）。 */
export interface ScorecardDraftHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  readonly identity: DemoActorIdentity
}

// =====================================================================
//  SQL（只读；全部带 tenant_id 过滤）
// =====================================================================

/** 本人是该场面试已登记的面试官行（身份绑定，不是权限系统）。 */
const INTERVIEWER_SQL = `
  select ivr.id::text as interviewer_id,
         ivr.required_scorecard as required_scorecard
    from recruitment.interviewer ivr
   where ivr.interview_id = $1::uuid and ivr.actor_id = $2::uuid and ivr.tenant_id = $3::uuid
`

// =====================================================================
//  HTTP 小工具（封闭错误信封 `{error:{code,reason_code,message,detail?}}`）
// =====================================================================

class DraftHttpProblem extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'DraftHttpProblem'
    this.status = status
    this.body = body
  }
}

/** 造一个契约形状的 HTTP 问题。 */
function problem(status: number, code: string, reasonCode: string, message: string, detail?: unknown): DraftHttpProblem {
  return new DraftHttpProblem(status, {
    error: { code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) },
  })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(405, { allow, ...NO_STORE })
  res.end()
}

/** 读请求体（上限 48 KiB；超限 413，零写入）。 */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number.isFinite(Number(declared)) && Number(declared) > limit) {
    throw problem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > limit) {
      throw problem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().split(';')[0]?.trim() === 'application/json'
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw problem(415, 'INVALID_ARGS', 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 Content-Type: application/json')
  }
  const text = await readBody(req, MAX_BODY_BYTES)
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    throw problem(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw problem(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body' })
  }
  return raw as Record<string, unknown>
}

/** 同源校验（复用 overview.ts 的唯一实现）。 */
function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw problem(
      403,
      'FORBIDDEN',
      'SAME_ORIGIN_REQUIRED',
      '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）',
    )
  }
}

/** 客户端身份覆盖（query / header / body）在碰 DB 之前拒。 */
function rejectOverrides(req: IncomingMessage, url: URL, body?: Record<string, unknown>): void {
  const rejected: string[] = []
  for (const key of ACTOR_OVERRIDE_KEYS) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
    if (body !== undefined && Object.hasOwn(body, key)) rejected.push(`body.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  }
  if (rejected.length > 0) {
    throw problem(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
      { rejected },
    )
  }
}

/** 读 `X-DSH-Session` 头并归一化（身份有且只有这个头）。 */
function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw problem(
      400,
      'INVALID_ARGS',
      raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined ? '缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）' : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID',
    )
  }
  return normalized
}

/** session → alias → actor（未绑定 → 409 DEMO_ACTOR_UNMAPPED，零写入）。 */
function requireBoundActor(identity: DemoActorIdentity, sessionId: string): ResolvedExecutionActor {
  return resolveSessionActor(identity, sessionId)
}

/** 未配置库时的 503（issues 只含变量名，不含密码）。 */
function notConfigured(issues: readonly string[]): DraftHttpProblem {
  return problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，面评草稿不可用', { issues: [...issues] })
}

/** 把任意错误翻成 HTTP 状态 + 封闭错误信封（与 actor.ts::errorResponse 同口径）。 */
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof DraftHttpProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    const prefix = message.slice(0, index)
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : prefix
      const reasonCode = typeof parsed.reason_code === 'string' && parsed.reason_code !== '' ? parsed.reason_code : code
      // 状态优先用 reason_code 的专属映射（413 超限 / 409 已提交），否则用顶层 code。
      const status = STATUS_BY_CODE[reasonCode] ?? STATUS_BY_CODE[code] ?? 500
      const body: Record<string, unknown> = { code, reason_code: reasonCode }
      body.message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message
      if (parsed.detail !== undefined) body.detail = parsed.detail
      return { status, body: { error: body } }
    } catch {
      // 不是产品错误形态：走下面的兜底。
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'INTERNAL'
  return { status: STATUS_BY_CODE[code] ?? 500, body: { error: { code, reason_code: 'UNEXPECTED', message } } }
}

/** 路由处理函数的统一错误边界。 */
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

/** 短连接池（每请求建、finally 关；避免空闲 socket 挂住宿主）。 */
async function withDatabase<T>(
  deps: ScorecardDraftHttpDeps,
  fn: (cfg: ResolvedDatabaseConfig, pool: DatabasePool) => Promise<T>,
): Promise<T> {
  if (deps.database === null) throw notConfigured(deps.databaseIssues)
  const cfg = deps.database
  const pool = createPool(cfg)
  try {
    return await fn(cfg, pool)
  } finally {
    await closePool(pool)
  }
}

/** 校验 interview_id query/body 值（必填 + UUID）。 */
function requireInterviewId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw problem(400, 'INVALID_ARGS', 'MISSING_REQUIRED', `缺必填字段 ${path}`, { missing: [path] })
  }
  if (!isUuid(value)) {
    throw problem(400, 'INVALID_ARGS', 'ID_NOT_UUID', `${path} 必须是 UUID 文本`, { field: path })
  }
  return value
}

/** 查"本人是该场面试官"的面试官行 id（不存在 → 403，零写入）。 */
async function requireInterviewer(
  client: { query<T>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }> },
  tenantId: string,
  interviewId: string,
  actorId: string,
): Promise<string> {
  const { rows } = await client.query<{ interviewer_id: string }>(INTERVIEWER_SQL, [interviewId, actorId, tenantId])
  const row = rows[0]
  if (row === undefined) {
    throw problem(
      403,
      'INTERVIEWER_MISMATCH',
      'ACTOR_NOT_INTERVIEWER',
      '当前 actor 不是这场面试已登记的面试官（草稿只给本人填）',
      { interview_id: interviewId, actor_id: actorId },
    )
  }
  return row.interviewer_id
}

/** 草稿行 → 只读投影（不吐 tenant 等内部机器字段；payload 是调用方给的原文副本）。 */
function toDraftProjection(row: ScorecardDraftRow | null): Record<string, unknown> | null {
  if (row === null) return null
  return {
    interview_id: row.interview_id,
    interviewer_actor_id: row.interviewer_actor_id,
    payload: row.payload,
    record_version: row.record_version,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

// =====================================================================
//  路由处理
// =====================================================================

/** GET：只读投影（不含任何写；返回最新草稿或 null）。 */
async function handleGet(
  deps: ScorecardDraftHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  // 身份覆盖先拒（碰 DB / 参数形状之前，与 interviewer.ts 同一纪律）。
  rejectOverrides(req, url)
  const unknown = [...url.searchParams.keys()].filter((key) => !(QUERY_KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'UNKNOWN_PARAM', `未声明的查询参数 "${unknown[0]}"（允许：${QUERY_KEYS.join(', ')}）`, { unknown })
  }
  const interviewId = requireInterviewId(url.searchParams.get('interview_id'), 'query.interview_id')
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)

  await withDatabase(deps, async (cfg, pool) => {
    const draft = await withReadOnly(pool, async (client) => {
      await requireInterviewer(client, cfg.tenant_id, interviewId, resolved.actor_id)
      return readDraft(client, cfg.tenant_id, interviewId, resolved.actor_id)
    })
    json(res, 200, { interview_id: interviewId, draft: toDraftProjection(draft) })
  })
}

/** POST：追加一行草稿版本（写前只读守卫全部通过）。 */
async function handlePost(deps: ScorecardDraftHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const body = await readJsonObject(req)
  rejectOverrides(req, url, body)
  const unknown = Object.keys(body).filter((key) => !(BODY_KEYS as readonly string[]).includes(key)).sort()
  if (unknown.length > 0) {
    throw problem(
      400,
      'INVALID_ARGS',
      'UNKNOWN_PARAM',
      `未声明的键 "${unknown[0]}"（允许：${BODY_KEYS.join(', ')}；草稿不需要 confirmation_text）`,
      { unknown, allowed: [...BODY_KEYS] },
    )
  }
  const interviewId = requireInterviewId(body.interview_id, 'body.interview_id')
  // validateDraftPayload 的机检码通过 errorResponse 映射（超限 413；形状错 400）。
  const payload = validateDraftPayload(body.payload)
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)

  await withDatabase(deps, async (cfg, pool) => {
    // 单事务：只读守卫（面试官 / 未提交）+ 追加写，失败整体回滚 = 零写入。
    const written = await withActor(pool, resolved.actor_id, async (client) => {
      const interviewerId = await requireInterviewer(client, cfg.tenant_id, interviewId, resolved.actor_id)
      await assertDraftWritable(client, cfg.tenant_id, interviewId, interviewerId)
      return saveDraft(client, {
        tenant_id: cfg.tenant_id,
        interview_id: interviewId,
        interviewer_id: interviewerId,
        interviewer_actor_id: resolved.actor_id,
        payload,
      })
    })
    // 独立只读读回（不信 saveDraft 自述）。
    const readback = await withReadOnly(pool, (client) =>
      readDraft(client, cfg.tenant_id, interviewId, resolved.actor_id))
    if (readback === null || readback.record_version !== written.record_version) {
      throw problem(500, 'DB_CONSTRAINT_VIOLATION', 'DRAFT_READBACK_MISMATCH', '草稿读回与写入版本不一致', {
        expected: written.record_version,
        actual: readback?.record_version ?? null,
      })
    }
    json(res, 200, {
      interview_id: interviewId,
      draft_id: written.draft_id,
      record_version: written.record_version,
      draft: toDraftProjection(readback),
    })
  })
}

/**
 * 注册面评草稿路由；返回 disposer（插件卸载即注销）。
 *
 * @param ctx - 宿主上下文（webServer + 可选 logger）。
 * @param deps - 数据库配置 + Demo Actor 身份单例（与 scorecard/submit 共享同一 registry）。
 * @returns 注销函数。
 */
export function registerScorecardDraftHttp(ctx: ScorecardDraftHostContext, deps: ScorecardDraftHttpDeps): () => void {
  const { webServer } = ctx
  if (!LOOPBACK_HOSTS.has(webServer.host)) {
    ctx.logger?.warn(`recruitment: 面评草稿路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0

  const handler = guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== DRAFT_PATH) {
      json(res, 404, { error: 'not found' })
      return
    }
    assertSameOrigin(req, port)
    if (req.method === 'GET') {
      await handleGet(deps, req, res, url)
      return
    }
    if (req.method === 'POST') {
      await handlePost(deps, req, res, url)
      return
    }
    methodNotAllowed(res, 'GET, POST')
  })

  return webServer.register({ kind: 'exact', path: DRAFT_PATH, handler })
}

/** 契约常量导出（测试用；与路由实现同一份，避免测试里写死漂移）。 */
export const SCORECARD_DRAFT_CONTRACT = {
  path: DRAFT_PATH,
  methods: ['GET', 'POST'] as const,
  queryKeys: QUERY_KEYS,
  bodyKeys: BODY_KEYS,
  maxPayloadBytes: MAX_DRAFT_PAYLOAD_BYTES,
  statusByCode: STATUS_BY_CODE,
} as const
