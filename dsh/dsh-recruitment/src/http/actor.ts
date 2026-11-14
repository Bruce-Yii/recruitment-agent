// Demo Actor 的宿主 HTTP 路由（W1-B）：session → alias → HUMAN actor 的受控投影 +
// Scorecard Host Remote Action（一次性 nonce、单事务写、DB 读回）。
//
// 冻结契约：`work/d5/ACTOR-CONTRACT.md` §2/§4、`work/d5/w1/CONTEXT.md` §1/§2，
// 以及 owner-d5-w1 的增量冻结（2026-11-15）：
//   * `PUT /recruitment/api/actor`  body **只有** `{alias}`（浏览器永不提交 UUID）；
//   * `GET /recruitment/api/actor`  返回 `{session_id, alias, actor_id, display_name, roles}`；
//   * `GET /recruitment/api/action/scorecard/form` 返回 **D-89 `ScorecardFormSpec` 原样**
//     + `{nonce, expires_at, actor_alias}`（spec 由 `overview.ts::buildFormSpec` 生成；
//     本文件只负责按 interview 读行、归属校验、下发一次性 nonce）；
//   * `POST /recruitment/api/action/scorecard/submit` body 用 **D-89 表单提交形状** + `{nonce}`，
//     兼容 W0 契约的 `items` 别名（`items` 存在且无 `dimensions` 时当作 `dimensions`）；
//     成功响应精确键 `{scorecard_id,status,actor_id,record_version,interviewer_id,interview_id,replayed}`。
//
// 为什么这样切（与 overview.ts 的 D-89 表单路径同口径，见该文件头 §C）：
//   * **人类远程动作不调用 DSH approval**：D-79 约束的是 Agent 工具路径（模型替人写面评）。
//     本文件的身份来自浏览器 `X-DSH-Session` + 进程内注册表、请求必须过 loopback 同源闸门，
//     nonce 只发给浏览器页面；Agent 拿不到 nonce，也就无法冒充 Host 人工动作。
//   * **不复制 scorecard 域规则**：参数/业务校验与写库全部复用
//     `scorecard-submit.ts::prepareScorecard → writeScorecard`（同一个 `withActor` 事务里）。
//   * **fail-closed**：非回环 host 不注册路由；同源/覆盖头/覆盖键在**碰 DB 之前**拒绝；
//     nonce 缺失/未知/过期/已用 → 403/409 且零写入；未绑定 → 409 `DEMO_ACTOR_UNMAPPED`。
//
// 暴露面：只接受 loopback + `x-recruitment-request: 1`；所有响应 `cache-control: no-store`。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'

import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type DatabaseClient,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { isUuid } from '../tools/contract.ts'
import { prepareScorecard, writeScorecard } from '../tools/scorecard-submit.ts'
import {
  DEMO_ACTOR_ALIASES,
  DEMO_SESSION_HEADER,
  isDemoActorAlias,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorAlias,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import {
  buildFormSpec,
  deriveFormIdempotencyKey,
  parseScorecardFormSubmission,
  sameOrigin,
  validateDimensionKeys,
  type ScorecardFormSpec,
  type ScorecardFormSubmission,
} from './overview.ts'

// =====================================================================
//  契约常量（与 `overview.ts` 同一暴露面口径；不另设更小的值）
// =====================================================================

/** Demo Actor 绑定端点（exact）。 */
const ACTOR_PATH = '/recruitment/api/actor'
/** Scorecard Remote Action：拿 spec + 一次性 nonce（exact）。 */
const FORM_ACTION_PATH = '/recruitment/api/action/scorecard/form'
/** Scorecard Remote Action：带 nonce 提交（exact）。 */
const SUBMIT_ACTION_PATH = '/recruitment/api/action/scorecard/submit'
/** 客户端**不许**覆盖的身份头（命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
/** 客户端**不许**覆盖的身份键（query / body；命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_KEYS = ['actor_id', 'tenant_id'] as const
/** `PUT /actor` body 允许的键（只有 alias）。 */
const ACTOR_BODY_KEYS = ['alias'] as const
/** `GET /action/scorecard/form` 允许的查询参数。 */
const FORM_QUERY_KEYS = ['interview_id', 'application_id', 'rubric_version_id'] as const
/** 请求体上限：64 KiB（超限 413，零写入）。 */
const MAX_BODY_BYTES = 64 * 1024
/** nonce TTL 默认 120s（冻结口径）。 */
const DEFAULT_NONCE_TTL_MS = 120_000
/** 进程内 nonce 表上限（有界；超出丢最旧）。 */
const MAX_NONCE_ENTRIES = 2_048
/** 已过期 nonce 的保留期：过期后这段时间内仍能回 `NONCE_EXPIRED`（之后按未知处理）。 */
const NONCE_EXPIRED_RETENTION_MS = 60_000
/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 契约错误的 HTTP 映射（与 `overview.ts` 的 `STATUS_BY_CODE` 同口径 + Demo Actor 的 409）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  INTERVIEWER_MISMATCH: 403,
  FORBIDDEN: 403,
  ALREADY_SUBMITTED: 409,
  VERSION_CONFLICT: 409,
  EVIDENCE_INSUFFICIENT: 422,
  DB_CONSTRAINT_VIOLATION: 500,
  NOT_CONFIGURED: 503,
  DEMO_ACTOR_UNMAPPED: 409,
}

// =====================================================================
//  宿主上下文 / 依赖（形状冻结见 CONTEXT §1）
// =====================================================================

/** 宿主侧用到的 `webServer` 最小面（与 overview 的窄接口同形）。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 宿主上下文（`src/index.ts` 把 cordis Context 窄成这个形状再传进来）。 */
export interface ActorHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** `registerActorHttp` 的依赖：库配置 + 已装配的 Demo Actor 身份（与工具共享同一实例）。 */
export interface ActorHttpDeps {
  /** 已解析的数据库配置；`null` = 未配置（路由仍注册，返回 503，不假装成功）。 */
  readonly database: ResolvedDatabaseConfig | null
  /** `database === null` 时缺失的配置项（只含变量名，不含密码）。 */
  readonly databaseIssues: readonly string[]
  /** session → alias 注册表 + alias → HUMAN actor 映射（由 `src/index.ts` 持有单例）。 */
  readonly identity: DemoActorIdentity
  /** nonce 有效期（毫秒；默认 120s，非法值回落默认）。 */
  readonly nonceTtlMs?: number
}

// =====================================================================
//  数据库读 SQL（全部只读；语义与 `overview.ts` 的 D-89 读路径一一对应）
// =====================================================================

/** 面试 + 申请（rubric 三绑定需要 `application.rubric_version_id` 与 `job_id`）。 */
const FORM_INTERVIEW_SQL = `
  select i.id::text             as id,
         i.application_id::text as application_id,
         i.round_no             as round_no,
         i.slot_code            as slot_code,
         i.status               as status,
         i.scheduled_start_at   as scheduled_start_at,
         a.job_id::text         as job_id,
         a.rubric_version_id::text as pinned_rubric_version_id
    from recruitment.interview i
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
   where i.id = $1::uuid and i.tenant_id = $2::uuid
`

/** 该 actor 是否这场面试已登记的 interviewer（SC-02；归属校验，不是权限系统）。 */
const FORM_INTERVIEWER_SQL = `
  select ivr.id::text as id, ivr.required_scorecard as required_scorecard
    from recruitment.interviewer ivr
   where ivr.interview_id = $1::uuid and ivr.actor_id = $2::uuid and ivr.tenant_id = $3::uuid
`

/** rubric 版本（形状与 `scorecard-submit.ts::loadRubric` 一致）。 */
const FORM_RUBRIC_SQL = `
  select rv.id::text as id, rv.job_id::text as job_id, rv.payload_hash as payload_hash,
         rv.dimensions as dimensions
    from recruitment.rubric_version rv
   where rv.id = $1::uuid and rv.tenant_id = $2::uuid
`

/** 当前面评（`superseded_by_scorecard_id is null`；`uq_scorecard_current` 保证至多一条）。 */
const FORM_CURRENT_SQL = `
  select sc.id::text as id, sc.status as status, sc.revision_no as revision_no,
         sc.record_version as record_version, sc.rubric_version_id::text as rubric_version_id
    from recruitment.scorecard sc
   where sc.interview_id = $1::uuid and sc.interviewer_id = $2::uuid and sc.tenant_id = $3::uuid
     and sc.superseded_by_scorecard_id is null
`

/**
 * 该场面试的 canonical transcript 是否 READY（与 `scorecard-submit.ts::isCanonicalTranscriptReady`
 * 同一语义：`meeting_binding` 链路 → `transcript_artifact.is_canonical` → `transcript_status='READY'`）。
 */
const FORM_TRANSCRIPT_READY_SQL = `
  select ta.transcript_status as transcript_status
    from recruitment.meeting_binding mb
    join recruitment.transcript_artifact ta
      on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id
   where mb.interview_id = $1::uuid and mb.tenant_id = $2::uuid
     and mb.unbound_at is null and ta.is_canonical
`

/** 有效 rubric 的维度（提交前覆盖预校验用；申请钉住优先，未钉住用显式 id）。 */
const EFFECTIVE_RUBRIC_SQL = `
  select rv.dimensions as dimensions
    from recruitment.interview i
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
    join recruitment.rubric_version rv
      on rv.id = coalesce(a.rubric_version_id, $3::uuid)
     and rv.tenant_id = a.tenant_id
     and rv.job_id = a.job_id
   where i.id = $1::uuid and i.tenant_id = $2::uuid
`

/** actor（存在性 / 同租户 / kind / display_name）。 */
const ACTOR_SQL = `
  select a.id::text as actor_id, a.kind as kind, a.display_name as display_name
    from recruitment.actor a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/** actor 的角色标签（D-33：标签，不参与归属判定；已撤销的不算）。 */
const ROLES_SQL = `
  select r.code as code
    from recruitment.actor_role ar
    join recruitment.role r on r.id = ar.role_id and r.tenant_id = ar.tenant_id
   where ar.actor_id = $1::uuid and ar.tenant_id = $2::uuid and ar.revoked_at is null
   order by r.code asc
`

/** 提交后**独立只读读回**（不信 `writeScorecard` 的自述）。 */
const SCORECARD_READBACK_SQL = `
  select sc.id::text                as scorecard_id,
         sc.status                  as status,
         sc.record_version          as record_version,
         sc.interview_id::text      as interview_id,
         sc.interviewer_id::text    as interviewer_id,
         sc.status_changed_by_actor_id::text as actor_id
    from recruitment.scorecard sc
   where sc.id = $1::uuid and sc.tenant_id = $2::uuid
`

// =====================================================================
//  行类型（与 overview.ts 的 D-89 行形状一致）
// =====================================================================

interface FormInterviewRow {
  id: string
  application_id: string
  round_no: number
  slot_code: string
  status: string
  scheduled_start_at: Date | string | null
  job_id: string
  pinned_rubric_version_id: string | null
}

interface FormRubricRow {
  id: string
  job_id: string
  payload_hash: string
  dimensions: readonly unknown[]
}

interface FormCurrentRow {
  id: string
  status: string
  revision_no: number
  record_version: number
  rubric_version_id: string
}

interface ScorecardReadbackRow {
  scorecard_id: string
  status: string
  record_version: number
  interviewer_id: string
  interview_id: string
  actor_id: string | null
}

// =====================================================================
//  HTTP 小工具（封闭错误信封：`{error:{code,reason_code,message,detail?}}`）
// =====================================================================

/** 本文件自己产生的、可直接返回的 HTTP 问题（不经过域错误映射）。 */
class ActorHttpProblem extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'ActorHttpProblem'
    this.status = status
    this.body = body
  }
}

/** 造一个契约形状的 HTTP 问题。 */
function actorHttpError(
  status: number,
  code: string,
  reasonCode: string,
  message: string,
  detail?: unknown,
): ActorHttpProblem {
  return new ActorHttpProblem(status, {
    error: { code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) },
  })
}

/** 写 JSON 响应（固定 no-store + nosniff；防止重复写头）。 */
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/** 405（带 allow）。 */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(405, { allow, ...NO_STORE })
  res.end()
}

/** 读请求体（上限 64 KiB；超限 413）。 */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number.isFinite(Number(declared)) && Number(declared) > limit) {
    throw actorHttpError(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > limit) {
      throw actorHttpError(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Content-Type 必须是 JSON（允许带 charset）。 */
function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().split(';')[0]?.trim() === 'application/json'
}

/** 读 JSON 请求体 → 普通对象（415/413/400 的封闭映射；不做业务校验）。 */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw actorHttpError(
      415,
      'INVALID_ARGS',
      'UNSUPPORTED_MEDIA_TYPE',
      '请求体必须是 Content-Type: application/json',
      { got: req.headers['content-type'] ?? '' },
    )
  }
  const text = await readBody(req, MAX_BODY_BYTES)
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    throw actorHttpError(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw actorHttpError(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body' })
  }
  return raw as Record<string, unknown>
}

/**
 * 同源校验（**复用** `overview.ts::sameOrigin`；不能过就 403）。
 * @param req - node 请求。
 * @param port - 本机 Web 监听端口。
 */
function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw actorHttpError(
      403,
      'FORBIDDEN',
      'SAME_ORIGIN_REQUIRED',
      '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）',
    )
  }
}

/**
 * 拒绝客户端在 query / header 覆盖身份（`actor_id`/`tenant_id`、`x-recruitment-actor`/`x-recruitment-tenant`）。
 * **不碰 DB**。
 * @param req - node 请求。
 * @param url - 解析后的 URL。
 */
function rejectQueryOrHeaderOverrides(req: IncomingMessage, url: URL): void {
  const rejected: string[] = []
  for (const key of ACTOR_OVERRIDE_KEYS) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  }
  if (rejected.length > 0) {
    throw actorHttpError(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
      { rejected },
    )
  }
}

/**
 * 拒绝 body 里的身份覆盖键（`actor_id`/`tenant_id`）。**不碰 DB**。
 * @param body - 已解析的 JSON body。
 */
function rejectBodyOverrides(body: Record<string, unknown>): void {
  const rejected = ACTOR_OVERRIDE_KEYS.filter((key) => Object.hasOwn(body, key)).map((key) => `body.${key}`)
  if (rejected.length > 0) {
    throw actorHttpError(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
      { rejected },
    )
  }
}

/**
 * 读 `X-DSH-Session` 头并归一化（身份**有且只有**这个头）。
 * @param req - node 请求。
 * @returns 规范 session id（`session-<lowercase uuid>`）。
 */
function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw actorHttpError(
      400,
      'INVALID_ARGS',
      raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined
        ? '缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）'
        : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID',
    )
  }
  return normalized
}

/**
 * session → alias → actor（未绑定 / 别名无映射 → 409 `DEMO_ACTOR_UNMAPPED`，零写入）。
 * @param identity - 已装配身份。
 * @param sessionId - 已归一的 session id。
 */
function requireBoundActor(identity: DemoActorIdentity, sessionId: string): ResolvedExecutionActor {
  // `resolveSessionActor` 抛 `DEMO_ACTOR_UNMAPPED: {reason_code,…}`；
  // 外层 `errorResponse` 把它映射成 409（与工具路径同一个错误码/原因码）。
  return resolveSessionActor(identity, sessionId)
}

/**
 * 把任意错误翻成 HTTP 状态 + 封闭错误信封（优先解析产品错误消息 `CODE: <compact-json>`）。
 * @param error - 任意错误。
 */
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof ActorHttpProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    const prefix = message.slice(0, index)
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : prefix
      const body: Record<string, unknown> = { code }
      if (typeof parsed.reason_code === 'string' && parsed.reason_code !== '') body.reason_code = parsed.reason_code
      body.message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message
      if (parsed.detail !== undefined) body.detail = parsed.detail
      return { status: STATUS_BY_CODE[code] ?? 500, body: { error: body } }
    } catch {
      // 不是产品错误形态：下面按最小形状兜底。
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'INTERNAL'
  return {
    status: STATUS_BY_CODE[code] ?? 500,
    body: { error: { code, reason_code: 'UNEXPECTED', message } },
  }
}

/** 路由处理函数的统一错误边界（每条路径都有 JSON 错误体，不把异常抛进宿主事件循环）。 */
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

// =====================================================================
//  一次性 nonce（进程内、有界、单次消费）
// =====================================================================

/** 一条已下发的 scorecard nonce（绑定 session + interview + application）。 */
interface ScorecardNonceEntry {
  readonly session_id: string
  readonly interview_id: string
  readonly application_id: string
  readonly actor_alias: DemoActorAlias
  readonly actor_id: string
  readonly expires_at_ms: number
  used: boolean
}

/** nonce 的校验结论（`ok` 之外的四种分别映射 403/409，且都零写入）。 */
type NonceInspection =
  | { readonly state: 'ok'; readonly entry: ScorecardNonceEntry }
  | { readonly state: 'absent' | 'unknown' | 'expired' | 'used' }

/**
 * 一次性 nonce 仓库：
 *   * 32 字节随机数 → base64url（43 字符）；
 *   * 绑定 `session_id + interview_id + application_id`，TTL 默认 120s；
 *   * 单次消费（`consume` 置 used；重放回 409 `NONCE_ALREADY_USED`）；
 *   * 有界（超出丢最旧）+ 过期清理（过期后保留一小段，便于区分"过期"与"未知"）。
 */
class ScorecardNonceStore {
  readonly #entries = new Map<string, ScorecardNonceEntry>()
  readonly #ttlMs: number
  readonly #maxEntries: number
  readonly #now: () => number

  constructor(options: { ttlMs: number; maxEntries: number; now?: () => number }) {
    this.#ttlMs = options.ttlMs
    this.#maxEntries = options.maxEntries
    this.#now = options.now ?? Date.now
  }

  /** 当前条数（测试/诊断用）。 */
  get size(): number {
    return this.#entries.size
  }

  /**
   * 下发一个 nonce。
   * @param binding - `{session_id, interview_id, application_id, actor_alias, actor_id}`。
   * @returns `{nonce, expires_at}`（ISO-8601）。
   */
  issue(binding: {
    readonly session_id: string
    readonly interview_id: string
    readonly application_id: string
    readonly actor_alias: DemoActorAlias
    readonly actor_id: string
  }): { nonce: string; expires_at: string } {
    const now = this.#now()
    this.#prune(now)
    const expiresAtMs = now + this.#ttlMs
    let nonce = randomBytes(32).toString('base64url')
    // 32 字节随机碰撞概率可忽略；仍做防御性重试，不写死"不会撞"。
    for (let attempt = 0; attempt < 3 && this.#entries.has(nonce); attempt += 1) {
      nonce = randomBytes(32).toString('base64url')
    }
    this.#entries.set(nonce, { ...binding, expires_at_ms: expiresAtMs, used: false })
    this.#evictOverflow()
    return { nonce, expires_at: new Date(expiresAtMs).toISOString() }
  }

  /**
   * 查一个 nonce 的可用性（**不消费**）。
   * @param nonce - 客户端提交的 nonce（任意类型）。
   * @returns 校验结论。
   */
  inspect(nonce: unknown): NonceInspection {
    if (typeof nonce !== 'string' || nonce === '') return { state: 'absent' }
    const entry = this.#entries.get(nonce)
    if (entry === undefined) return { state: 'unknown' }
    if (entry.used) return { state: 'used' }
    if (this.#now() > entry.expires_at_ms) return { state: 'expired' }
    return { state: 'ok', entry }
  }

  /**
   * 消费一个 nonce（单次）。调用方必须已 `inspect` 通过。
   * @param entry - `inspect` 返回的条目。
   */
  consume(entry: ScorecardNonceEntry): void {
    entry.used = true
  }

  /** 清理"过期足够久"的条目（过期后保留一小段，便于回 409 `NONCE_EXPIRED`）。 */
  #prune(now: number): void {
    for (const [nonce, entry] of this.#entries) {
      if (now > entry.expires_at_ms + NONCE_EXPIRED_RETENTION_MS) this.#entries.delete(nonce)
    }
  }

  /** 超出容量丢最旧（Map 插入序）。 */
  #evictOverflow(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) return
      this.#entries.delete(oldest.value)
    }
  }
}

/** 把 `nonceTtlMs` 归一成正整数（非法/缺省 → 120_000）。 */
function normalizeNonceTtl(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : DEFAULT_NONCE_TTL_MS
}

/**
 * nonce 校验结论 → HTTP 问题（冻结口径：缺失 403 NONCE_REQUIRED、未知 403 NONCE_INVALID、
 * 过期 409 NONCE_EXPIRED、已用 409 NONCE_ALREADY_USED；全部零写入）。
 * @param state - `inspect` 的非 ok 状态。
 */
function nonceProblem(state: 'absent' | 'unknown' | 'expired' | 'used'): ActorHttpProblem {
  if (state === 'absent') {
    return actorHttpError(403, 'NONCE_REQUIRED', 'NONCE_REQUIRED', '缺 nonce：面评提交必须先拿一次性 nonce（Agent 无法伪造）')
  }
  if (state === 'unknown') {
    return actorHttpError(403, 'NONCE_INVALID', 'NONCE_INVALID', 'nonce 未知（未由本进程下发或已过期足够久）')
  }
  if (state === 'expired') {
    return actorHttpError(409, 'NONCE_EXPIRED', 'NONCE_EXPIRED', 'nonce 已过期（TTL 内未提交），请重新打开表单')
  }
  return actorHttpError(409, 'NONCE_ALREADY_USED', 'NONCE_ALREADY_USED', 'nonce 已被使用过（一次性）；重放不会写库')
}

/**
 * nonce 绑定不符 → 403（不是该 session / 不是这场面试 / 不是这个申请）。
 * @param detail - 机器可判的差异上下文。
 */
function nonceBindingProblem(detail: Record<string, unknown>): ActorHttpProblem {
  return actorHttpError(403, 'NONCE_INVALID', 'NONCE_BINDING_MISMATCH', 'nonce 与本次请求的 session/interview/application 不匹配', detail)
}

// =====================================================================
//  身份 / 数据库读辅助
// =====================================================================

/** 未配置库时的 503（含缺失项；只含变量名，不含密码）。 */
function notConfigured(issues: readonly string[]): ActorHttpProblem {
  return actorHttpError(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，Demo Actor / 面评动作不可用', {
    issues: [...issues],
  })
}

/**
 * 在一个短连接池上执行 `fn`（HTTP 请求级；finally 关池，避免空闲 socket 挂住宿主）。
 * @param deps - 路由依赖。
 * @param fn - 拿到已解析配置与连接池。
 */
async function withDatabase<T>(
  deps: ActorHttpDeps,
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

/** actor 行快照（存在 / 同租户 / kind / display_name）+ 角色标签。 */
interface ActorRowSnapshot {
  readonly actor_id: string
  readonly kind: string
  readonly display_name: string
  readonly roles: readonly string[]
}

/**
 * 读 actor 行 + 角色；不存在 = `null`。
 * @param client - 只读/写事务内客户端。
 * @param tenantId - 租户（只来自服务端配置）。
 * @param actorId - alias 映射出来的 UUID。
 */
async function readActorSnapshot(
  client: DatabaseClient,
  tenantId: string,
  actorId: string,
): Promise<ActorRowSnapshot | null> {
  const actor = await client.query<{ actor_id: string; kind: string; display_name: string }>(ACTOR_SQL, [actorId, tenantId])
  const row = actor.rows[0]
  if (row === undefined) return null
  const roles = await client.query<{ code: string }>(ROLES_SQL, [actorId, tenantId])
  return {
    actor_id: row.actor_id,
    kind: row.kind,
    display_name: row.display_name,
    roles: roles.rows.map((role) => role.code),
  }
}

/**
 * 断言 actor 是 HUMAN（Demo Actor 只投影给人；Agent 不得借 alias 写面评）。
 * @param snapshot - actor 行快照。
 */
function assertHumanActor(snapshot: ActorRowSnapshot): void {
  if (snapshot.kind !== 'HUMAN') {
    throw actorHttpError(
      403,
      'FORBIDDEN',
      'ACTOR_NOT_HUMAN',
      `Demo Actor alias 只能映射到 HUMAN actor（实际 kind=${snapshot.kind}）`,
      { actor_id: snapshot.actor_id, kind: snapshot.kind },
    )
  }
}

/**
 * 读一场面试（不存在 → 404 `INTERVIEW_NOT_FOUND`）。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param interviewId - 面试 id（调用方已校验 UUID 形状）。
 */
async function loadInterview(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<FormInterviewRow> {
  const { rows } = await client.query<FormInterviewRow>(FORM_INTERVIEW_SQL, [interviewId, tenantId])
  const row = rows[0]
  if (row === undefined) {
    throw actorHttpError(404, 'NOT_FOUND', 'INTERVIEW_NOT_FOUND', '该租户下没有这场面试', { interview_id: interviewId })
  }
  return row
}

/**
 * rubric 三绑定（与 `scorecard-submit.ts::resolveRubric` / overview `readFormSpec` 同语义）。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param interview - 面试行（含申请钉住版本与 job_id）。
 * @param explicitId - 可选显式 rubric 版本 id。
 */
async function resolveRubric(
  client: DatabaseClient,
  tenantId: string,
  interview: FormInterviewRow,
  explicitId: string | undefined,
): Promise<FormRubricRow> {
  const pinned = interview.pinned_rubric_version_id
  let rubricId: string
  if (pinned !== null) {
    if (explicitId !== undefined && explicitId !== pinned) {
      throw actorHttpError(
        400,
        'INVALID_ARGS',
        'RUBRIC_MISMATCH',
        '入参的 rubric_version_id 与申请钉住的版本不一致；没有 what-if 面评（SC-11）',
        { pinned_rubric_version_id: pinned, rubric_version_id: explicitId },
      )
    }
    rubricId = pinned
  } else {
    if (explicitId === undefined) {
      throw actorHttpError(
        400,
        'INVALID_ARGS',
        'RUBRIC_UNRESOLVED',
        '该申请没有钉住 rubric 版本，必须显式给 rubric_version_id（不做 fallback，SC-10）',
        { application_id: interview.application_id },
      )
    }
    rubricId = explicitId
  }
  const { rows } = await client.query<FormRubricRow>(FORM_RUBRIC_SQL, [rubricId, tenantId])
  const rubric = rows[0]
  if (rubric === undefined) {
    throw actorHttpError(404, 'NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', '该租户下没有这个 rubric 版本', {
      rubric_version_id: rubricId,
    })
  }
  if (rubric.job_id !== interview.job_id) {
    throw actorHttpError(
      400,
      'INVALID_ARGS',
      'RUBRIC_NOT_OF_JOB',
      '这个 rubric 版本不属于该申请的岗位（拿别的岗位的标准打分不被接受，SC-47）',
      { rubric_version_id: rubric.id, rubric_job_id: rubric.job_id, application_job_id: interview.job_id },
    )
  }
  return rubric
}

/** rubric 维度 key（只认对象且有非空 `key`）。 */
function dimensionKeysOf(rubric: { dimensions: readonly unknown[] }): string[] {
  const keys: string[] = []
  for (const raw of rubric.dimensions) {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const key = (raw as Record<string, unknown>).key
      if (typeof key === 'string' && key !== '') keys.push(key)
    }
  }
  return keys
}

/**
 * 预校验维度覆盖（读有效 rubric 的维度 → `validateDimensionKeys`）。
 * 只在能确定「有效 rubric 且属于该申请岗位」时校验；其它情形返回 `false`，
 * 交给 `prepareScorecard` 抛它自己的契约错误（错误归因更准，不抢在它前面）。
 * @param client - 只读事务内客户端。
 * @param cfg - 已解析配置。
 * @param submission - 已过形状校验的表单提交体。
 * @returns 是否完成了覆盖校验。
 */
async function prevalidateDimensionCoverage(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  submission: ScorecardFormSubmission,
): Promise<boolean> {
  const { rows } = await client.query<{ dimensions: readonly unknown[] }>(EFFECTIVE_RUBRIC_SQL, [
    submission.interview_id,
    cfg.tenant_id,
    submission.rubric_version_id ?? null,
  ])
  const rubric = rows[0]
  if (rubric === undefined) return false
  const rubricKeys = dimensionKeysOf({ dimensions: Array.isArray(rubric.dimensions) ? rubric.dimensions : [] })
  if (rubricKeys.length === 0) return false
  validateDimensionKeys(Object.keys(submission.dimensions), rubricKeys)
  return true
}

// =====================================================================
//  路由 1：GET / PUT /recruitment/api/actor
// =====================================================================

/**
 * `GET /recruitment/api/actor`：返回当前 session 的绑定。
 * 未绑定 → 409 `DEMO_ACTOR_UNMAPPED`（fail-closed，浏览器刷新后需重新 PUT）。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleActorGet(deps: ActorHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  await withDatabase(deps, async (cfg, pool) => {
    const snapshot = await withReadOnly(pool, (client) => readActorSnapshot(client, cfg.tenant_id, resolved.actor_id))
    if (snapshot === null) {
      throw actorHttpError(
        409,
        'DEMO_ACTOR_UNMAPPED',
        'ACTOR_ROW_MISSING',
        'alias 映射的 actor 在库里不存在或不属于该租户（fail-closed）',
        { actor_id: resolved.actor_id },
      )
    }
    assertHumanActor(snapshot)
    json(res, 200, {
      session_id: resolved.session_id,
      alias: resolved.alias,
      actor_id: snapshot.actor_id,
      display_name: snapshot.display_name,
      roles: [...snapshot.roles],
    })
  })
}

/**
 * `PUT /recruitment/api/actor`：绑定当前 session 到受控 alias。
 *
 * 校验顺序（全部在写之前）：body 只有 `{alias}` → alias 属于封闭集 → alias 有映射 →
 * DB 里 actor 存在 / 同租户 / HUMAN。通过后 `registry.bind(session, alias, {display_name})`
 * （进程内、不落库），返回与 GET 同形的投影。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleActorPut(deps: ActorHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = readSessionHeader(req)
  const body = await readJsonObject(req)
  rejectBodyOverrides(body)
  if (!Object.hasOwn(body, 'alias')) {
    throw actorHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "alias"', { missing: ['alias'] })
  }
  const unknown = Object.keys(body).filter((key) => !(ACTOR_BODY_KEYS as readonly string[]).includes(key)).sort()
  if (unknown.length > 0) {
    throw actorHttpError(
      400,
      'INVALID_ARGS',
      'UNKNOWN_PARAM',
      `未声明的键 "${unknown[0]}"（允许：${ACTOR_BODY_KEYS.join(', ')}；alias → UUID 的映射只在服务端）`,
      { unknown, allowed: [...ACTOR_BODY_KEYS] },
    )
  }
  const alias = body.alias
  if (!isDemoActorAlias(alias)) {
    throw actorHttpError(400, 'INVALID_ARGS', 'UNKNOWN_ACTOR_ALIAS', 'alias 不在受控集合里', {
      alias: typeof alias === 'string' ? alias.slice(0, 64) : `[${typeof alias}]`,
      allowed: [...DEMO_ACTOR_ALIASES],
    })
  }
  const actorId = deps.identity.actors[alias]
  if (actorId === undefined) {
    // 映射缺失 = fail-closed；绝不回退到 config.actor_id。
    throw actorHttpError(409, 'DEMO_ACTOR_UNMAPPED', 'ALIAS_NOT_MAPPED', '该 alias 没有配置 actor 映射（fail-closed）', {
      alias,
    })
  }
  await withDatabase(deps, async (cfg, pool) => {
    const snapshot = await withReadOnly(pool, (client) => readActorSnapshot(client, cfg.tenant_id, actorId))
    if (snapshot === null) {
      throw actorHttpError(
        409,
        'DEMO_ACTOR_UNMAPPED',
        'ACTOR_ROW_MISSING',
        'alias 映射的 actor 在库里不存在或不属于该租户（fail-closed）',
        { alias, actor_id: actorId },
      )
    }
    assertHumanActor(snapshot)
    const binding = deps.identity.registry.bind(sessionId, alias, { display_name: snapshot.display_name })
    json(res, 200, {
      session_id: binding.session_id,
      alias: binding.alias,
      actor_id: snapshot.actor_id,
      display_name: snapshot.display_name,
      roles: [...snapshot.roles],
    })
  })
}

// =====================================================================
//  路由 2：GET /recruitment/api/action/scorecard/form
// =====================================================================

/**
 * `GET /recruitment/api/action/scorecard/form?interview_id=[&application_id=][&rubric_version_id=]`
 *
 * 返回 **D-89 表单 spec 原样** + `{nonce, expires_at, actor_alias}`：
 *   * 未绑定 → 409 `DEMO_ACTOR_UNMAPPED`；
 *   * 不是该 Interview 的登记面试官 → 403 `ACTOR_NOT_INTERVIEWER`；
 *   * 给了 `application_id` 但与该 Interview 的申请不一致 → 400 `APPLICATION_MISMATCH`；
 *   * 成功 → 一次性 nonce（绑定 session + interview + application，TTL 120s）。
 * @param deps - 路由依赖。
 * @param nonces - 进程内 nonce 仓库。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleFormGet(
  deps: ActorHttpDeps,
  nonces: ScorecardNonceStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  const url = new URL(req.url ?? '/', 'http://localhost')

  const unknown = [...url.searchParams.keys()].filter((key) => !(FORM_QUERY_KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw actorHttpError(400, 'INVALID_ARGS', 'UNKNOWN_PARAM', `未声明的查询参数 "${unknown[0]}"（允许：${FORM_QUERY_KEYS.join(', ')}）`, {
      unknown,
      allowed: [...FORM_QUERY_KEYS],
    })
  }
  const interviewId = url.searchParams.get('interview_id')
  if (interviewId === null || interviewId === '') {
    throw actorHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填查询参数 interview_id', { missing: ['interview_id'] })
  }
  if (!isUuid(interviewId)) {
    throw actorHttpError(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'interview_id 必须是 UUID 文本', { field: 'interview_id' })
  }
  const applicationIdRaw = url.searchParams.get('application_id')
  if (applicationIdRaw !== null && !isUuid(applicationIdRaw)) {
    throw actorHttpError(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'application_id 必须是 UUID 文本', { field: 'application_id' })
  }
  const rubricVersionIdRaw = url.searchParams.get('rubric_version_id')
  if (rubricVersionIdRaw !== null && !isUuid(rubricVersionIdRaw)) {
    throw actorHttpError(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'rubric_version_id 必须是 UUID 文本', { field: 'rubric_version_id' })
  }

  await withDatabase(deps, async (cfg, pool) => {
    const spec: ScorecardFormSpec = await withReadOnly(pool, async (client) => {
      const interview = await loadInterview(client, cfg.tenant_id, interviewId)
      if (applicationIdRaw !== null && interview.application_id !== applicationIdRaw) {
        throw actorHttpError(
          400,
          'INVALID_ARGS',
          'APPLICATION_MISMATCH',
          'application_id 与这场面试所属的申请不一致',
          { interview_id: interview.id, interview_application_id: interview.application_id, application_id: applicationIdRaw },
        )
      }
      const interviewer = await client.query<{ id: string }>(FORM_INTERVIEWER_SQL, [
        interview.id,
        resolved.actor_id,
        cfg.tenant_id,
      ])
      const interviewerRow = interviewer.rows[0]
      if (interviewerRow === undefined) {
        throw actorHttpError(
          403,
          'INTERVIEWER_MISMATCH',
          'ACTOR_NOT_INTERVIEWER',
          '当前 actor 不是这场面试已登记的面试官（表单只给本人填，SC-02）',
          { interview_id: interview.id, actor_id: resolved.actor_id },
        )
      }
      const rubric = await resolveRubric(client, cfg.tenant_id, interview, rubricVersionIdRaw ?? undefined)
      const current = await client.query<FormCurrentRow>(FORM_CURRENT_SQL, [
        interview.id,
        interviewerRow.id,
        cfg.tenant_id,
      ])
      const transcript = await client.query<{ transcript_status: string }>(FORM_TRANSCRIPT_READY_SQL, [
        interview.id,
        cfg.tenant_id,
      ])
      const transcriptReady = transcript.rows.some((row) => row.transcript_status === 'READY')
      const actorSnapshot = await readActorSnapshot(client, cfg.tenant_id, resolved.actor_id)
      if (actorSnapshot === null) {
        throw actorHttpError(
          409,
          'DEMO_ACTOR_UNMAPPED',
          'ACTOR_ROW_MISSING',
          'alias 映射的 actor 在库里不存在或不属于该租户（fail-closed）',
          { actor_id: resolved.actor_id },
        )
      }
      assertHumanActor(actorSnapshot)
      return buildFormSpec({
        actor: { actor_id: actorSnapshot.actor_id, display_name: actorSnapshot.display_name },
        interview,
        rubric,
        current: current.rows[0],
        transcriptReady,
      })
    })

    // nonce 只在**全部只读校验通过后**下发；绑定的是服务端读到的 application（不信任 query）。
    const issued = nonces.issue({
      session_id: resolved.session_id,
      interview_id: spec.interview.id,
      application_id: spec.interview.application_id,
      actor_alias: resolved.alias,
      actor_id: resolved.actor_id,
    })
    json(res, 200, {
      ...spec,
      nonce: issued.nonce,
      expires_at: issued.expires_at,
      actor_alias: resolved.alias,
    })
  })
}

// =====================================================================
//  路由 3：POST /recruitment/api/action/scorecard/submit
// =====================================================================

/** 提交 body 的适配结果（把 W0 的 `items` 别名与 `application_id` 剥离成 D-89 形状）。 */
interface AdaptedSubmitBody {
  /** 交给 `parseScorecardFormSubmission` 的 D-89 形状。 */
  readonly submissionRaw: Record<string, unknown>
  /** 可选的 `application_id`（若给了，会与 nonce/interview 的申请比对）。 */
  readonly applicationId?: string
  /** 原样取出的 nonce。 */
  readonly nonce: string | undefined
}

/**
 * 适配提交 body：
 *   * 没有顶层 `note`（note 只在每个 dimension 里；出现即 400）；
 *   * `items` 存在且没有 `dimensions` → 当作 `dimensions`（W0 契约兼容）；
 *     `items` 里的保留键 `transcript_basis` 提升到顶层（仅当顶层没有时）；
 *   * `application_id` 只用于一致性校验，不进入领域参数；
 *   * 其余键原样交给 `parseScorecardFormSubmission`（未知键由它统一拒）。
 * @param body - 已解析 JSON body。
 */
function adaptSubmitBody(body: Record<string, unknown>): AdaptedSubmitBody {
  if (Object.hasOwn(body, 'note')) {
    throw actorHttpError(
      400,
      'INVALID_ARGS',
      'TOP_LEVEL_NOTE_NOT_ALLOWED',
      '没有顶层 note 字段：note 只在每个维度里（dimensions.<key>.note）',
      { path: 'note', hint: 'dimensions.<rubric dimension key>.note' },
    )
  }
  const raw: Record<string, unknown> = { ...body }
  const nonce = body.nonce
  delete raw.nonce

  let applicationId: string | undefined
  if (Object.hasOwn(body, 'application_id')) {
    const value = body.application_id
    if (typeof value !== 'string' || value === '') {
      throw actorHttpError(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '"application_id" 必须是非空字符串', { path: 'application_id' })
    }
    applicationId = value
  }
  delete raw.application_id

  if (Object.hasOwn(body, 'items')) {
    if (Object.hasOwn(body, 'dimensions')) {
      throw actorHttpError(
        400,
        'INVALID_ARGS',
        'AMBIGUOUS_DIMENSIONS',
        '`items` 与 `dimensions` 不能同时出现（items 只是 W0 契约的别名）',
      )
    }
    const items = body.items
    if (typeof items !== 'object' || items === null || Array.isArray(items)) {
      throw actorHttpError(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '"items" 必须是对象（键 = rubric 维度 key）', {
        path: 'items',
      })
    }
    const dimensions: Record<string, unknown> = { ...(items as Record<string, unknown>) }
    if (Object.hasOwn(dimensions, 'transcript_basis')) {
      if (!Object.hasOwn(raw, 'transcript_basis')) raw.transcript_basis = dimensions.transcript_basis
      delete dimensions.transcript_basis
    }
    raw.dimensions = dimensions
  }
  delete raw.items
  return {
    submissionRaw: raw,
    ...(applicationId === undefined ? {} : { applicationId }),
    nonce: typeof nonce === 'string' ? nonce : undefined,
  }
}

/**
 * 表单提交体 → `recruitment_scorecard_submit` 的原始入参（沿用 `scorecard-submit.ts` 的写路径）。
 * @param submission - 已过形状校验的提交体。
 * @param idempotencyKey - 幂等键（客户端给了就用，否则由 `deriveFormIdempotencyKey` 派生）。
 */
function submissionToSubmitArgs(submission: ScorecardFormSubmission, idempotencyKey: string): Record<string, unknown> {
  const items: Record<string, unknown> = { ...submission.dimensions }
  items.transcript_basis = submission.transcript_basis
  return {
    interview_id: submission.interview_id,
    ...(submission.rubric_version_id === undefined ? {} : { rubric_version_id: submission.rubric_version_id }),
    items,
    overall: submission.overall,
    ...(submission.reject_reasons === undefined ? {} : { reject_reasons: submission.reject_reasons }),
    ...(submission.revision === undefined ? {} : { revision: submission.revision }),
    idempotency_key: idempotencyKey,
  }
}

/**
 * 从 `writeScorecard` / 幂等重放输出里取 scorecard id（取不到就报错，不猜）。
 * @param value - 域函数的输出。
 */
function scorecardIdOf(value: Record<string, unknown>): string {
  const scorecard = value.scorecard
  if (typeof scorecard === 'object' && scorecard !== null && !Array.isArray(scorecard)) {
    const id = (scorecard as Record<string, unknown>).id
    if (typeof id === 'string' && id !== '') return id
  }
  throw new Error(`scorecard-submit 输出缺 scorecard.id：${JSON.stringify(value).slice(0, 300)}`)
}

/**
 * `POST /recruitment/api/action/scorecard/submit`
 *
 * 流程（顺序即纪律）：
 *   1. 同源 + `X-DSH-Session` + 已绑定 alias（未绑定 409，零写入）；
 *   2. nonce 校验（缺失 403 / 未知 403 / 过期 409 / 已用 409，**全都不碰 DB**）；
 *   3. body 适配 + D-89 形状校验（未知键/枚举/范围 → 400）；
 *   4. 只读校验：nonce 绑定三件套一致、面试存在、**该 actor 是这场面试的 interviewer**
 *      （不是 → 403 `ACTOR_NOT_INTERVIEWER`）、维度覆盖预校验；
 *   5. 消费 nonce（一次性；此后任何失败都不写库）；
 *   6. **单事务** `withActor(actor_id)`：`prepareScorecard → writeScorecard`
 *      （复用现有域函数，不重写规则；失败整体回滚 = 零写入）；
 *   7. 独立只读 DB 读回，返回精确键：
 *      `{scorecard_id,status,actor_id,record_version,interviewer_id,interview_id,replayed}`。
 * @param deps - 路由依赖。
 * @param nonces - 进程内 nonce 仓库。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleSubmit(
  deps: ActorHttpDeps,
  nonces: ScorecardNonceStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  const body = await readJsonObject(req)
  rejectBodyOverrides(body)

  // ---- 2 nonce 校验（不碰 DB、零写入）----
  const inspection = nonces.inspect(body.nonce)
  if (inspection.state !== 'ok') throw nonceProblem(inspection.state)
  const nonceEntry = inspection.entry
  if (nonceEntry.session_id !== resolved.session_id) {
    throw nonceBindingProblem({ nonce_session_id: nonceEntry.session_id, session_id: resolved.session_id })
  }

  // ---- 3 body 适配 + D-89 形状校验 ----
  const adapted = adaptSubmitBody(body)
  const submission = parseScorecardFormSubmission(adapted.submissionRaw)
  if (submission.interview_id !== nonceEntry.interview_id) {
    throw nonceBindingProblem({
      nonce_interview_id: nonceEntry.interview_id,
      interview_id: submission.interview_id,
    })
  }
  if (adapted.applicationId !== undefined && adapted.applicationId !== nonceEntry.application_id) {
    throw actorHttpError(
      400,
      'INVALID_ARGS',
      'APPLICATION_MISMATCH',
      'application_id 与 nonce 绑定的申请不一致',
      { application_id: adapted.applicationId, nonce_application_id: nonceEntry.application_id },
    )
  }

  await withDatabase(deps, async (cfg, pool) => {
    // ---- 4 只读校验（分配可能自 GET form 之后变化，所以提交时重新查）----
    await withReadOnly(pool, async (client) => {
      const interview = await loadInterview(client, cfg.tenant_id, submission.interview_id)
      if (interview.application_id !== nonceEntry.application_id) {
        throw actorHttpError(
          400,
          'INVALID_ARGS',
          'APPLICATION_MISMATCH',
          '这场面试所属的申请与 nonce 绑定的申请不一致（数据在取 nonce 之后变了）',
          { interview_application_id: interview.application_id, nonce_application_id: nonceEntry.application_id },
        )
      }
      const interviewer = await client.query<{ id: string }>(FORM_INTERVIEWER_SQL, [
        interview.id,
        resolved.actor_id,
        cfg.tenant_id,
      ])
      if (interviewer.rows[0] === undefined) {
        throw actorHttpError(
          403,
          'INTERVIEWER_MISMATCH',
          'ACTOR_NOT_INTERVIEWER',
          '当前 actor 不是这场面试已登记的面试官（一人只能交自己的面评，SC-02/SC-05）',
          { interview_id: interview.id, actor_id: resolved.actor_id },
        )
      }
      const actorSnapshot = await readActorSnapshot(client, cfg.tenant_id, resolved.actor_id)
      if (actorSnapshot === null) {
        throw actorHttpError(
          409,
          'DEMO_ACTOR_UNMAPPED',
          'ACTOR_ROW_MISSING',
          'alias 映射的 actor 在库里不存在或不属于该租户（fail-closed）',
          { actor_id: resolved.actor_id },
        )
      }
      assertHumanActor(actorSnapshot)
      await prevalidateDimensionCoverage(client, cfg, submission)
    })

    // ---- 5 消费 nonce（一次性；在此之前一行都没写）----
    const recheck = nonces.inspect(body.nonce)
    if (recheck.state !== 'ok') throw nonceProblem(recheck.state)
    nonces.consume(recheck.entry)

    // ---- 6 单事务 prepare → write（复用域函数；失败整体回滚）----
    const idempotencyKey = submission.idempotency_key !== ''
      ? submission.idempotency_key
      : deriveFormIdempotencyKey(resolved.actor_id, submission)
    const rawArgs = submissionToSubmitArgs(submission, idempotencyKey)
    const written = await withActor(pool, resolved.actor_id, async (client) => {
      const prepared = await prepareScorecard(client, cfg, rawArgs)
      if (prepared.kind === 'result') {
        // 幂等重放：不写库、直接返回原结果。
        return { scorecardId: scorecardIdOf(prepared.value), replayed: true }
      }
      const value = await writeScorecard(client, cfg, prepared)
      return { scorecardId: scorecardIdOf(value), replayed: value.replayed === true }
    })

    // ---- 7 独立只读读回（响应只来自库，不回显请求）----
    const readback = await withReadOnly(pool, async (client) => {
      const { rows } = await client.query<ScorecardReadbackRow>(SCORECARD_READBACK_SQL, [
        written.scorecardId,
        cfg.tenant_id,
      ])
      const row = rows[0]
      if (row === undefined) {
        throw actorHttpError(
          500,
          'INTERNAL',
          'READBACK_MISSING',
          '面评写事务已提交但读回不到该行（数据异常，请人工核查）',
          { scorecard_id: written.scorecardId },
        )
      }
      return row
    })
    json(res, 200, {
      scorecard_id: readback.scorecard_id,
      status: readback.status,
      actor_id: readback.actor_id ?? resolved.actor_id,
      record_version: readback.record_version,
      interviewer_id: readback.interviewer_id,
      interview_id: readback.interview_id,
      replayed: written.replayed,
    })
  })
}

// =====================================================================
//  注册入口
// =====================================================================

/** 回环地址判据（只接受 127.0.0.1 / ::1；其余地址不注册路由）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/**
 * 注册 Demo Actor + Scorecard Host Remote Action 路由；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警（fail-closed：宁可面板读不到，也不把写动作挂到网络可达地址）。
 * 三条 exact 路由：`/recruitment/api/actor`（GET+PUT 同一路径，方法分发）、
 * `/recruitment/api/action/scorecard/form`、`/recruitment/api/action/scorecard/submit`。
 * @param ctx - 宿主上下文（含 webServer 服务）。
 * @param deps - 库配置 + Demo Actor 身份 + nonce TTL。
 * @returns 注销函数。
 */
export function registerActorHttp(ctx: ActorHostContext, deps: ActorHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: actor 动作路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const nonces = new ScorecardNonceStore({
    ttlMs: normalizeNonceTtl(deps.nonceTtlMs),
    maxEntries: MAX_NONCE_ENTRIES,
  })

  // ---- /recruitment/api/actor：GET（读绑定）+ PUT（写绑定）----
  const actorHandler = guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    assertSameOrigin(req, port)
    rejectQueryOrHeaderOverrides(req, url)
    if (req.method === 'GET') {
      await handleActorGet(deps, req, res)
      return
    }
    if (req.method === 'PUT') {
      await handleActorPut(deps, req, res)
      return
    }
    methodNotAllowed(res, 'GET, PUT')
  })

  // ---- /recruitment/api/action/scorecard/form：GET（spec + nonce）----
  const formHandler = guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    assertSameOrigin(req, port)
    rejectQueryOrHeaderOverrides(req, url)
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET')
      return
    }
    await handleFormGet(deps, nonces, req, res)
  })

  // ---- /recruitment/api/action/scorecard/submit：POST（带 nonce 写）----
  const submitHandler = guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    assertSameOrigin(req, port)
    rejectQueryOrHeaderOverrides(req, url)
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await handleSubmit(deps, nonces, req, res)
  })

  const disposers = [
    webServer.register({ kind: 'exact', path: ACTOR_PATH, handler: actorHandler }),
    webServer.register({ kind: 'exact', path: FORM_ACTION_PATH, handler: formHandler }),
    webServer.register({ kind: 'exact', path: SUBMIT_ACTION_PATH, handler: submitHandler }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 注销失败不掩盖别的问题（宿主卸载本来就是尽力而为）。
      }
    }
  }
}
