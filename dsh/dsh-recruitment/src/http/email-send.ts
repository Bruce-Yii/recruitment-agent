// email/send —— 发信的 Host Remote Action（人类闸门 + durable_effect 幂等入队）。
//
// 独立 exact path `/recruitment/api/action/email/send`（与 `http/actions.ts` 的 10 条路径互不冲突）。
// 复用 `actions.ts` 的 fail-closed 口径：
//   * 非回环 host → 不注册路由；
//   * 缺/非法 `x-dsh-session` → 400；session 未绑定 alias → 409 DEMO_ACTOR_UNMAPPED；
//   * alias 不是 `recruiter` → 403；
//   * body 带服务端派生键（actor_id / tenant_id / to / email / body / subject / status …）→ 400 零写入；
//   * mail 或 database 未配置 → 503 零写入。
//
// 「人的闸门」= 预览与确认分离：
//   1) `POST {preview_only:true, ...业务语义}` → 只返回服务端组装的收件人/标题/正文预览/幂等键/
//      内容摘要；**不写库、不发送**（不调用 enqueue、不建连写事务）。
//   2) 人真点确认后 `POST {confirmation_text, ...同一业务语义}` → 才进入写事务：
//      `withActor` → `enqueueEmailSend`（幂等键已算好）→ 提交 → **独立只读连接**读回 durable_effect 行。
//   同键重复提交 → `created:false`、状态不变、无新行、无重发（唯一键 uq_durable_effect_idempotency）。
//   Agent 走 DSH 工具路径没有 session→alias 绑定与浏览器点击，调不到本路由。
//
// 收件地址与正文由服务端组装：body 只给业务语义（application_id 或 recipient_ref + template_key +
// variables）。地址从 `recruitment.candidate.normalized_email` 只读查询解析（`resolveRecipient` seam）。
// 不承诺模板真的放在外部系统：本文件只有最小 subject/body 生成器；未知 template_key → 400 零写入。
//
// 测试 seam（`EmailSendHttpDeps.io`）：生产缺省用真 pool / A 的 enqueue / 真只读查询；单测注入假实现，
// 不连真 PG、不连真 SMTP。B 的调用只需要传 4 个必填 deps，io 可省略。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'

import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type DatabaseClient,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { digestOf, isUuid } from '../tools/contract.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorAlias,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'
import {
  enqueueEmailSend,
  insertEmailAuthorization,
  resolveEmailAuthorization,
  type EmailAuthorizationConfigLike,
  type EmailAuthorizationDecision,
  type InsertEmailAuthorizationResult,
} from '../connectors/mail/durable-effect.ts'
import type { MailConfig } from '../connectors/mail/contract.ts'
import { RecruitmentToolError } from '../tools/errors.ts'

// =====================================================================
//  契约常量
// =====================================================================

export const EMAIL_SEND_PATH = '/recruitment/api/action/email/send'

/** 按范围授权的自动发送入口（Agent 通过 Host Action 触发；无浏览器点击，用授权判定代替闸门）。 */
export const EMAIL_SEND_AUTHORIZED_PATH = '/recruitment/api/action/email/send-authorized'

/** 按范围授权的**写入口**（人点 Host Action：新增/撤销 email.send.authorization 配置版本）。 */
export const EMAIL_AUTHORIZE_PATH = '/recruitment/api/action/email/authorize'

const ACTION_NAME = 'email/send'
/** 只有 Recruiter 能发信（与 `actions.ts` 的写动作同口径）。 */
const ALLOWED_ALIASES: readonly DemoActorAlias[] = ['recruiter']

/** body 里禁止出现的键：身份覆盖 + 服务端派生字段（收件人/标题/正文/状态/幂等键）。 */
const FORBIDDEN_BODY_KEYS = [
  'actor_id', 'tenant_id', 'actor', 'tenant', 'alias', 'actor_alias',
  'to', 'email', 'recipient_address', 'recipient_email', 'mail_to',
  'body', 'subject', 'status', 'idempotency_key', 'payload_hash',
  'confirmation_text_sha256', 'sent_at', 'external_id', 'effect_id',
] as const

/** 模板闭集（最小 map；不承诺外部系统真的有这些模板）。 */
const TEMPLATE_KEYS = ['INTERVIEW_INVITE', 'SCREENING_RESULT', 'OFFER'] as const
type TemplateKey = (typeof TEMPLATE_KEYS)[number]

/** 请求体上限：64 KiB。 */
const MAX_BODY_BYTES = 64 * 1024

const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

// =====================================================================
//  宿主上下文 / 依赖
// =====================================================================

/** 宿主侧 `webServer` 最小面（与 `actions.ts::ActionHostContext` 同形，B 可传同一个对象）。 */
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
export interface EmailSendHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 收件人解析结果（服务端组装，不来自 body）。 */
export interface ResolvedRecipient {
  readonly to: string
  readonly display_name: string
}

/** 单测 seam：所有会碰外部IO的点都在此注入，生产缺省用真实现。 */
export interface EmailSendIo {
  /** 用 actor 身份在一个写事务里执行 `fn`（缺省 = createPool + withActor + closePool）。 */
  readonly withWrite?: <T>(cfg: ResolvedDatabaseConfig, actorId: string, fn: (client: DatabaseClient) => Promise<T>) => Promise<T>
  /** 只读事务（缺省 = createPool + withReadOnly + closePool）。 */
  readonly withRead?: <T>(cfg: ResolvedDatabaseConfig, fn: (client: DatabaseClient) => Promise<T>) => Promise<T>
  /** 入队函数（缺省 = A 的 `enqueueEmailSend`）。 */
  readonly enqueue?: typeof enqueueEmailSend
  /** 收件地址解析（缺省 = DB 只读查询 candidate.normalized_email）。 */
  readonly resolveRecipient?: (
    cfg: ResolvedDatabaseConfig,
    body: { readonly application_id?: string; readonly recipient_ref?: string },
  ) => Promise<ResolvedRecipient | null>
  /** 读取 email.send.authorization 有效配置行（缺省 = DB 只读查询 business_config）。 */
  readonly readAuthorizations?: (cfg: ResolvedDatabaseConfig) => Promise<readonly EmailAuthorizationConfigLike[]>
  /** 追加授权/撤销配置版本（缺省 = A 的 insertEmailAuthorization）。 */
  readonly insertAuthorization?: typeof insertEmailAuthorization
  /** 授权写入后独立只读连接读回新行（缺省 = DB 只读查询 business_config）。 */
  readonly readAuthorization?: (
    cfg: ResolvedDatabaseConfig,
    id: string,
  ) => Promise<{ id: string; version_no: number; payload_hash: string | null; effective_from: string }>
}

/** `registerEmailSendHttp` 的依赖（前 5 个必填，B 按此调用；`io` 仅测试注入）。 */
export interface EmailSendHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  readonly identity: DemoActorIdentity
  readonly mail: MailConfig | null
  readonly mailIssues: readonly string[]
  readonly io?: EmailSendIo
}

/** 入队结果（A 的返回形状；此处只取用得到的字段）。 */
interface EnqueueResult {
  readonly id: string
  readonly status: string
  readonly created: boolean
}

// =====================================================================
//  HTTP 小工具
// =====================================================================

class EmailHttpProblem extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'EmailHttpProblem'
    this.status = status
    this.body = body
  }
}

function problem(status: number, code: string, reasonCode: string, message: string, detail?: unknown): EmailHttpProblem {
  return new EmailHttpProblem(status, {
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

function methodNotAllowed(res: ServerResponse): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(405, { allow: 'POST', ...NO_STORE })
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
  const ct = req.headers['content-type']
  if (typeof ct !== 'string' || ct.toLowerCase().split(';')[0]?.trim() !== 'application/json') {
    throw problem(415, 'INVALID_ARGS', 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 Content-Type: application/json')
  }
  const text = await readBody(req)
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

function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', '只接受同源 loopback 请求')
  }
}

function rejectQueryOverrides(url: URL): void {
  const rejected: string[] = []
  for (const key of ['actor_id', 'tenant_id', 'to', 'email', 'subject', 'body'] as const) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  }
  if (rejected.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', '身份与服务端派生键不接受客户端传入', { rejected })
  }
}

function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw problem(400, 'INVALID_ARGS', raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined ? '缺 X-DSH-Session 请求头' : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID')
  }
  return normalized
}

function requireBoundActor(identity: DemoActorIdentity, sessionId: string): ResolvedExecutionActor {
  return resolveSessionActor(identity, sessionId)
}

function assertAlias(resolved: ResolvedExecutionActor): void {
  if ((ALLOWED_ALIASES as readonly string[]).includes(resolved.alias)) return
  throw problem(403, 'FORBIDDEN', 'ACTOR_NOT_AUTHORIZED',
    `当前身份（${resolved.alias}）无权发信（只允许 ${ALLOWED_ALIASES.join(', ')}）`,
    { action: ACTION_NAME, alias: resolved.alias, allowed_aliases: [...ALLOWED_ALIASES] })
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof EmailHttpProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { error: { code: 'INTERNAL', reason_code: 'UNEXPECTED', message } } }
}

function guard(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handler(req, res)
    } catch (error) {
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }
}

/** 短号（只给前 8 位；错误体不吐完整 UUID / 64hex）。 */
function shortId(value: string): string {
  return value.slice(0, 8)
}

// =====================================================================
//  业务语义解析 + 服务端组装
// =====================================================================

interface EmailCommand {
  readonly application_id?: string
  readonly recipient_ref?: string
  readonly template_key: TemplateKey
  readonly template_version: number
  readonly variables: Record<string, unknown>
  readonly idempotency_key: string
  readonly payload_hash: string
  readonly confirmation_text_sha256?: string
}

function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(value)
}

/**
 * 解析 body 里的业务语义，算幂等键与内容摘要（纯函数，不碰 IO）。
 * 幂等键口径：`${application_id}:${template_key}:${version}`（application_id 缺省时以 recipient_ref 代替）。
 */
function parseCommand(body: Record<string, unknown>): EmailCommand {
  const rejected = [...FORBIDDEN_BODY_KEYS].filter((key) => Object.hasOwn(body, key)).sort()
  if (rejected.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
      '身份与收件人/正文/状态等服务端派生字段不接受客户端传入', { rejected })
  }

  const appRaw = body.application_id
  const refRaw = body.recipient_ref
  const hasApp = appRaw !== undefined
  const hasRef = refRaw !== undefined
  if (hasApp === hasRef) {
    throw problem(400, 'INVALID_ARGS', 'MISSING_REQUIRED',
      '必须且只能给一个：application_id（UUID）或 recipient_ref（字符串引用）',
      { application_id: hasApp ? 'present' : 'absent', recipient_ref: hasRef ? 'present' : 'absent' })
  }
  let applicationId: string | undefined
  let recipientRef: string | undefined
  if (hasApp) {
    if (!isUuid(appRaw)) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_APPLICATION_ID', 'application_id 必须是 UUID')
    }
    applicationId = (appRaw as string).toLowerCase()
  } else {
    if (typeof refRaw !== 'string' || refRaw.trim() === '' || refRaw.length > 200) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_RECIPIENT_REF', 'recipient_ref 必须是 1..200 字符串引用')
    }
    recipientRef = refRaw
  }

  if (!isTemplateKey(body.template_key)) {
    throw problem(400, 'INVALID_ARGS', 'UNKNOWN_TEMPLATE_KEY', '未知 template_key（零写入）',
      { allowed: [...TEMPLATE_KEYS] })
  }
  const templateKey = body.template_key

  let version = 1
  if (body.template_version !== undefined) {
    if (typeof body.template_version !== 'number' || !Number.isInteger(body.template_version)
      || body.template_version < 1 || body.template_version > 1000) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_TEMPLATE_VERSION', 'template_version 必须是 1..1000 的整数')
    }
    version = body.template_version
  }

  let variables: Record<string, unknown> = {}
  if (body.variables !== undefined) {
    if (typeof body.variables !== 'object' || body.variables === null || Array.isArray(body.variables)) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_VARIABLES', 'variables 必须是 JSON 对象')
    }
    variables = body.variables as Record<string, unknown>
    if (Object.keys(variables).length > 50) {
      throw problem(400, 'INVALID_ARGS', 'TOO_MANY_VARIABLES', 'variables 最多 50 个键')
    }
  }

  let confirmationTextSha256: string | undefined
  if (body.confirmation_text !== undefined) {
    if (typeof body.confirmation_text !== 'string'
      || body.confirmation_text.trim() === '' || body.confirmation_text.length > 2000) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_CONFIRMATION_TEXT',
        'confirmation_text 必须是 1..2000 字符串（人的确认原话）')
    }
    confirmationTextSha256 = createHash('sha256').update(body.confirmation_text, 'utf8').digest('hex')
  }

  const base = applicationId ?? `ref:${recipientRef}`
  const idempotencyKey = `${base}:${templateKey}:${version}`
  const payloadHash = digestOf({
    application_id: applicationId ?? null,
    recipient_ref: recipientRef ?? null,
    template_key: templateKey,
    template_version: version,
    variables,
  })
  return {
    ...(applicationId === undefined ? {} : { application_id: applicationId }),
    ...(recipientRef === undefined ? {} : { recipient_ref: recipientRef }),
    template_key: templateKey,
    template_version: version,
    variables,
    idempotency_key: idempotencyKey,
    payload_hash: payloadHash,
    ...(confirmationTextSha256 === undefined ? {} : { confirmation_text_sha256: confirmationTextSha256 }),
  }
}

/** 最小模板：key → subject/body 生成器（占位模板，不承诺外部系统真实存在）。 */
function renderTemplate(key: TemplateKey, recipient: ResolvedRecipient, variables: Record<string, unknown>): {
  subject: string
  body: string
} {
  const name = recipient.display_name
  const extra = Object.keys(variables).length === 0 ? '' : `（${Object.keys(variables).join(', ')}）`
  switch (key) {
    case 'INTERVIEW_INVITE':
      return { subject: `面试邀请 · ${name}`, body: `${name}，您好：这是一封面试邀请${extra}。` }
    case 'SCREENING_RESULT':
      return { subject: `初筛结果 · ${name}`, body: `${name}，您好：这是您的初筛结果通知${extra}。` }
    case 'OFFER':
      return { subject: `录用通知 · ${name}`, body: `${name}，您好：这是您的录用通知${extra}。` }
  }
}

// =====================================================================
//  缺省 IO（真 pool / A 的 enqueue / DB 只读解析收件人）
// =====================================================================

async function defaultWithWrite<T>(
  cfg: ResolvedDatabaseConfig,
  actorId: string,
  fn: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const pool = createPool(cfg)
  try {
    return await withActor(pool, actorId, fn)
  } finally {
    await closePool(pool)
  }
}

async function defaultWithRead<T>(cfg: ResolvedDatabaseConfig, fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const pool = createPool(cfg)
  try {
    return await withReadOnly(pool, fn)
  } finally {
    await closePool(pool)
  }
}

const RESOLVE_BY_APPLICATION_SQL = `
  select c.normalized_email as email, c.display_name as name
    from recruitment.application a
    join recruitment.candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`
const RESOLVE_BY_CANDIDATE_SQL = `
  select normalized_email as email, display_name as name
    from recruitment.candidate
   where id = $1::uuid and tenant_id = $2::uuid
`

async function defaultResolveRecipient(
  cfg: ResolvedDatabaseConfig,
  input: { readonly application_id?: string; readonly recipient_ref?: string },
): Promise<ResolvedRecipient | null> {
  return defaultWithRead(cfg, async (client) => {
    let row: { email: string | null; name: string } | undefined
    if (input.application_id !== undefined) {
      const { rows } = await client.query<{ email: string | null; name: string }>(
        RESOLVE_BY_APPLICATION_SQL, [input.application_id, cfg.tenant_id])
      row = rows[0]
    } else if (input.recipient_ref !== undefined) {
      // recipient_ref 必须是候选人 UUID（字符串引用）；形态不符直接视为找不到（fail-closed）。
      if (!isUuid(input.recipient_ref)) return null
      const { rows } = await client.query<{ email: string | null; name: string }>(
        RESOLVE_BY_CANDIDATE_SQL, [input.recipient_ref, cfg.tenant_id])
      row = rows[0]
    }
    if (row === undefined || typeof row.email !== 'string' || row.email.trim() === '') return null
    return { to: row.email, display_name: row.name }
  })
}

/** 读取租户下 `email.send.authorization` 的配置行（只读；版本降序，撤销=追加新版本）。 */
const READ_AUTHORIZATIONS_SQL = `
  select id::text          as id,
         scope,
         scope_id::text    as scope_id,
         config_key,
         version_no,
         payload,
         payload_hash,
         effective_from,
         effective_to
    from recruitment.business_config
   where tenant_id = $1::uuid and config_key = 'email.send.authorization'
   order by version_no desc, created_at desc, id desc
`

async function defaultReadAuthorizations(cfg: ResolvedDatabaseConfig): Promise<readonly EmailAuthorizationConfigLike[]> {
  return defaultWithRead(cfg, async (client) => {
    const { rows } = await client.query<EmailAuthorizationConfigLike>(READ_AUTHORIZATIONS_SQL, [cfg.tenant_id])
    return rows
  })
}

/** 授权写入后独立只读连接读回新配置行（不是回显请求）。 */
const READ_AUTHORIZATION_BY_ID_SQL = `
  select id::text as id, version_no, payload_hash, effective_from::text as effective_from
    from recruitment.business_config
   where id = $1::uuid and tenant_id = $2::uuid and config_key = 'email.send.authorization'
`
async function defaultReadAuthorization(
  cfg: ResolvedDatabaseConfig,
  id: string,
): Promise<{ id: string; version_no: number; payload_hash: string | null; effective_from: string }> {
  return defaultWithRead(cfg, async (client) => {
    const { rows } = await client.query<{ id: string; version_no: number; payload_hash: string | null; effective_from: string }>(
      READ_AUTHORIZATION_BY_ID_SQL, [id, cfg.tenant_id])
    const row = rows[0]
    if (row === undefined) {
      throw problem(500, 'INTERNAL', 'READBACK_MISSING', '授权已提交但读不到该配置行')
    }
    return row
  })
}

/** durable_effect 读回行（只取返回需要的列）。 */
interface EffectReadbackRow {
  effect_id: string
  status: string
  idempotency_key: string
  payload_hash: string | null
  record_version: number
  attempt_count: number
  sent_at: Date | string | null
  confirmed_at: Date | string | null
}

const EFFECT_READBACK_SQL = `
  select id::text              as effect_id,
         status,
         idempotency_key,
         payload_hash,
         record_version,
         attempt_count,
         sent_at,
         confirmed_at
    from recruitment.durable_effect
   where id = $1::uuid and tenant_id = $2::uuid
`

async function readbackEffect(cfg: ResolvedDatabaseConfig, effectId: string, withRead: EmailSendIo['withRead']): Promise<EffectReadbackRow> {
  const read = withRead ?? defaultWithRead
  return read(cfg, async (client) => {
    const { rows } = await client.query<EffectReadbackRow>(EFFECT_READBACK_SQL, [effectId, cfg.tenant_id])
    const row = rows[0]
    if (row === undefined) {
      throw problem(500, 'INTERNAL', 'READBACK_MISSING', '发信入队已提交但读不到该行')
    }
    return row
  })
}

// =====================================================================
//  handler
// =====================================================================

async function handleEmailSend(deps: EmailSendHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  assertAlias(resolved)

  const url = new URL(req.url ?? '/', 'http://localhost')
  rejectQueryOverrides(url)

  const body = await readJsonObject(req)
  const command = parseCommand(body)

  // 未配置检查在参数解析之后：客户端明确错误（400）优先于服务端的 503。
  if (deps.database === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，发信不可用', { issues: [...deps.databaseIssues] })
  }
  if (deps.mail === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '邮件连接器未配置，发信不可用', { issues: [...deps.mailIssues] })
  }
  const database = deps.database
  const io = deps.io ?? {}
  const resolveRecipient = io.resolveRecipient ?? defaultResolveRecipient

  // 收件地址由服务端解析（body 不接受地址）；找不到 / 无邮箱 → 400 零写入。
  const recipient = await resolveRecipient(database, {
    ...(command.application_id === undefined ? {} : { application_id: command.application_id }),
    ...(command.recipient_ref === undefined ? {} : { recipient_ref: command.recipient_ref }),
  })
  if (recipient === null) {
    throw problem(400, 'RECIPIENT_UNRESOLVED', 'RECIPIENT_UNRESOLVED',
      '收件人无法从服务端资料解析（或资料里没有邮箱），零写入')
  }
  const rendered = renderTemplate(command.template_key, recipient, command.variables)

  // 预览：只组装，不写库、不发送。
  if (body.preview_only === true) {
    json(res, 200, {
      action: ACTION_NAME,
      preview: true,
      to: recipient.to,
      subject: rendered.subject,
      body_preview: rendered.body,
      template_key: command.template_key,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash,
    })
    return
  }

  // 确认：必须有人的确认原话（人的闸门）。
  if (command.confirmation_text_sha256 === undefined) {
    throw problem(403, 'CONFIRMATION_REQUIRED', 'HUMAN_CONFIRMATION_REQUIRED',
      '需要 confirmation_text（人的确认原话）才会发信；请先预览再由真人确认')
  }

  // 同一事务：withActor → enqueue（幂等键已算好）。重复提交由唯一键挡住，created:false。
  // A 的 input 要求 application_id 与 recipient_ref 同时给出：application_id 缺省时用解析到的
  // recipient_ref（候选人 UUID）占位，保证两列都非空且不猜。
  const enqueue = io.enqueue ?? enqueueEmailSend
  const withWrite = io.withWrite ?? defaultWithWrite
  const applicationId = command.application_id ?? (isUuid(command.recipient_ref ?? '') ? command.recipient_ref! : database.actor_id)
  const recipientRef = command.recipient_ref ?? applicationId
  const result: EnqueueResult = await withWrite(database, resolved.actor_id, async (client) => (
    await enqueue(client, {
      tenant_id: database.tenant_id,
      actor_id: resolved.actor_id,
      application_id: applicationId,
      recipient_ref: recipientRef,
      template_key: command.template_key,
      template_version: String(command.template_version),
      subject: rendered.subject,
      // 人预览看到的 to / body_preview 就是最终发送内容（同一份，不二次解析）。
      to: recipient.to,
      text: rendered.body,
      body_summary: rendered.body.slice(0, 500),
      idempotency_key: command.idempotency_key,
      authorization_ref: 'HUMAN_CLICK',
      authorized_by_actor_id: resolved.actor_id,
      ...(command.confirmation_text_sha256 === undefined ? {} : { confirmation_text_sha256: command.confirmation_text_sha256 }),
    })
  ))

  // 写后独立只读连接读回（不是回显请求）。
  const readback = await readbackEffect(database, result.id, io.withRead)

  json(res, 200, {
    action: ACTION_NAME,
    effect: {
      id: shortId(result.id),
      status: result.status,
      created: result.created,
      idempotency_key: shortId(command.idempotency_key),
    },
    readback: {
      effect_id: shortId(readback.effect_id),
      status: readback.status,
      idempotency_key: shortId(readback.idempotency_key),
      payload_hash: readback.payload_hash === null ? null : shortId(readback.payload_hash),
      record_version: readback.record_version,
      attempt_count: readback.attempt_count,
    },
  })
}

// =====================================================================
//  按范围授权的自动发送入口（模式 B）
// =====================================================================

/** 自动入口 body 禁止的键（在人工入口基础上再加 session 相关）。 */
const FORBIDDEN_AUTHORIZED_BODY_KEYS = [...FORBIDDEN_BODY_KEYS] as const

interface AuthorizedCommand {
  readonly application_id: string
  readonly job_id: string
  readonly recipient_ref: string
  readonly email_class: string
  readonly template_key: TemplateKey
  readonly template_version: number
  readonly variables: Record<string, unknown>
  readonly idempotency_key: string
  readonly payload_hash: string
}

/**
 * 解析自动入口的业务语义（纯函数）。与人工入口不同：application_id / job_id / recipient_ref /
 * email_class 都是必填业务语义；收件人依然由服务端解析，不接受地址。
 */
function parseAuthorizedCommand(body: Record<string, unknown>): AuthorizedCommand {
  const rejected = [...FORBIDDEN_AUTHORIZED_BODY_KEYS].filter((key) => Object.hasOwn(body, key)).sort()
  if (rejected.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
      '身份与收件人/正文/状态等服务端派生字段不接受客户端传入', { rejected })
  }
  if (!isUuid(body.application_id)) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_APPLICATION_ID', 'application_id 必须是 UUID')
  }
  if (!isUuid(body.job_id)) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_JOB_ID', 'job_id 必须是 UUID')
  }
  const app = (body.application_id as string).toLowerCase()
  const job = (body.job_id as string).toLowerCase()
  const ref = body.recipient_ref
  if (typeof ref !== 'string' || ref.trim() === '' || ref.length > 200) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_RECIPIENT_REF', 'recipient_ref 必须是 1..200 字符串引用')
  }
  const emailClass = body.email_class
  if (typeof emailClass !== 'string' || emailClass.trim() === '' || emailClass.length > 64) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_EMAIL_CLASS', 'email_class 必须是 1..64 字符串')
  }
  if (!isTemplateKey(body.template_key)) {
    throw problem(400, 'INVALID_ARGS', 'UNKNOWN_TEMPLATE_KEY', '未知 template_key（零写入）',
      { allowed: [...TEMPLATE_KEYS] })
  }
  let version = 1
  if (body.template_version !== undefined) {
    if (typeof body.template_version !== 'number' || !Number.isInteger(body.template_version)
      || body.template_version < 1 || body.template_version > 1000) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_TEMPLATE_VERSION', 'template_version 必须是 1..1000 的整数')
    }
    version = body.template_version
  }
  let variables: Record<string, unknown> = {}
  if (body.variables !== undefined) {
    if (typeof body.variables !== 'object' || body.variables === null || Array.isArray(body.variables)) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_VARIABLES', 'variables 必须是 JSON 对象')
    }
    variables = body.variables as Record<string, unknown>
    if (Object.keys(variables).length > 50) {
      throw problem(400, 'INVALID_ARGS', 'TOO_MANY_VARIABLES', 'variables 最多 50 个键')
    }
  }
  // 幂等键：批次口径 `${application_id}:${template_key}:${version}`，与人工入口一致。
  const idempotencyKey = `${app}:${body.template_key}:${version}`
  const payloadHash = digestOf({
    application_id: app, job_id: job, recipient_ref: ref,
    email_class: emailClass, template_key: body.template_key, template_version: version, variables,
  })
  return {
    application_id: app, job_id: job, recipient_ref: ref, email_class: emailClass,
    template_key: body.template_key, template_version: version, variables,
    idempotency_key: idempotencyKey, payload_hash: payloadHash,
  }
}

/** 授权拒绝 reason → HTTP 状态（403 统一；OFFER 必须人点给明确提示）。 */
function authorizationDenied(decision: EmailAuthorizationDecision): EmailHttpProblem {
  const status = 403
  return problem(status, 'FORBIDDEN', decision.reason,
    `自动发信未获授权（${decision.reason}），请走人工确认发信路径`,
    { reason: decision.reason, hint: EMAIL_SEND_PATH })
}

/**
 * `POST /recruitment/api/action/email/send-authorized` —— 按范围授权的自动发送。
 * 不需要 session→alias 浏览器点击；授权判定代替人的闸门。allowed:false → 403 零写入。
 */
async function handleAuthorizedSend(deps: EmailSendHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  rejectQueryOverrides(url)
  const body = await readJsonObject(req)
  const command = parseAuthorizedCommand(body)

  if (deps.database === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，发信不可用', { issues: [...deps.databaseIssues] })
  }
  if (deps.mail === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '邮件连接器未配置，发信不可用', { issues: [...deps.mailIssues] })
  }
  const database = deps.database
  const io = deps.io ?? {}

  // 读授权配置 → 纯判定（不命中 = 403 零写入，绝不 enqueue）。
  const readAuthorizations = io.readAuthorizations ?? defaultReadAuthorizations
  const configs = await readAuthorizations(database)
  const decision = resolveEmailAuthorization(configs, {
    application_id: command.application_id,
    job_id: command.job_id,
    recipient_ref: command.recipient_ref,
    email_class: command.email_class,
    template_key: command.template_key,
    now: new Date().toISOString(),
  })
  if (!decision.allowed || decision.authorization_ref === null || decision.authorized_by_actor_id === null) {
    throw authorizationDenied(decision)
  }
  const authorizationRef: string = decision.authorization_ref
  const authorizedByActorId: string = decision.authorized_by_actor_id

  // 授权通过 → 服务端解析收件人（body 不接受地址）→ 组装模板。
  const resolveRecipient = io.resolveRecipient ?? defaultResolveRecipient
  const recipient = await resolveRecipient(database, {
    application_id: command.application_id,
    recipient_ref: command.recipient_ref,
  })
  if (recipient === null) {
    throw problem(400, 'RECIPIENT_UNRESOLVED', 'RECIPIENT_UNRESOLVED',
      '收件人无法从服务端资料解析（或资料里没有邮箱），零写入')
  }
  const rendered = renderTemplate(command.template_key, recipient, command.variables)

  const enqueue = io.enqueue ?? enqueueEmailSend
  const withWrite = io.withWrite ?? defaultWithWrite
  // 自动发送的执行 actor = 授权里登记的 actor（授权即职权来源），不是请求方传的 actor。
  const result: EnqueueResult = await withWrite(database, authorizedByActorId, async (client) => (
    await enqueue(client, {
      tenant_id: database.tenant_id,
      actor_id: authorizedByActorId,
      application_id: command.application_id,
      recipient_ref: command.recipient_ref,
      template_key: command.template_key,
      template_version: String(command.template_version),
      subject: rendered.subject,
      // 自动入口同理：预览/授权范围判定的就是这份 to/text，派发直接消费。
      to: recipient.to,
      text: rendered.body,
      body_summary: rendered.body.slice(0, 500),
      idempotency_key: command.idempotency_key,
      email_class: command.email_class,
      authorization_ref: authorizationRef,
      authorized_by_actor_id: authorizedByActorId,
    })
  ))
  const readback = await readbackEffect(database, result.id, io.withRead)

  json(res, 200, {
    action: 'email/send-authorized',
    effect: {
      id: shortId(result.id),
      status: result.status,
      created: result.created,
      idempotency_key: shortId(command.idempotency_key),
    },
    authorization: {
      ref: shortId(authorizationRef),
    },
    readback: {
      effect_id: shortId(readback.effect_id),
      status: readback.status,
      idempotency_key: shortId(readback.idempotency_key),
      payload_hash: readback.payload_hash === null ? null : shortId(readback.payload_hash),
      record_version: readback.record_version,
      attempt_count: readback.attempt_count,
    },
  })
}

// =====================================================================
//  授权写入口（人点 Host Action：新增/撤销 email.send.authorization）
// =====================================================================

/** 授权入口额外禁止的键：服务端派生字段（身份 / 配置键 / 版本 / 哈希 / 生效窗）。 */
const FORBIDDEN_AUTHORIZE_BODY_KEYS = [
  ...FORBIDDEN_BODY_KEYS,
  'authorized_by_actor_id', 'config_key', 'version_no',
  'effective_from', 'effective_to', 'scope_id', 'created_by_actor_id',
  'revoked', 'revoked_at', 'authorization_ref',
  'confirmation_text_sha256',
] as const

/** email_class 闭集（OFFER 仍在集合内，但授权入口直接拒绝，不允许授权）。 */
const AUTHORIZE_EMAIL_CLASSES = ['INTERVIEW_NOTICE', 'SCREENING_RESULT', 'OFFER'] as const
type AuthorizeEmailClass = (typeof AUTHORIZE_EMAIL_CLASSES)[number]

interface AuthorizeCommand {
  readonly email_class: AuthorizeEmailClass
  readonly scope: { job_ids?: readonly string[]; application_ids?: readonly string[]; recipient_refs?: readonly string[] }
  readonly template_key: TemplateKey
  readonly expires_at: string
  readonly confirmation_text_sha256: string
  readonly revoke: boolean
  readonly revoke_authorization_id?: string
}

function parseIdArray(value: unknown, key: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 200) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_SCOPE',
      `scope.${key} 必须是 0..200 的字符串数组`)
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '' || item.length > 200) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_SCOPE', `scope.${key} 元素必须是 1..200 字符串`)
    }
    out.push(item)
  }
  return out
}

/** 解析授权入参（纯函数）：只收业务语义，身份/配置键一律拒绝。 */
function parseAuthorizeCommand(body: Record<string, unknown>): AuthorizeCommand {
  const rejected = [...FORBIDDEN_AUTHORIZE_BODY_KEYS].filter((key) => Object.hasOwn(body, key)).sort()
  if (rejected.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
      '身份与配置键/版本/哈希/生效窗等服务端派生字段不接受客户端传入', { rejected })
  }

  if (typeof body.email_class !== 'string'
    || !(AUTHORIZE_EMAIL_CLASSES as readonly string[]).includes(body.email_class)) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_EMAIL_CLASS', '未知 email_class（零写入）',
      { allowed: [...AUTHORIZE_EMAIL_CLASSES] })
  }
  const emailClass = body.email_class as AuthorizeEmailClass
  if (emailClass === 'OFFER') {
    throw problem(403, 'FORBIDDEN', 'OFFER_REQUIRES_HUMAN', 'OFFER 永不自动授权，必须人点发信')
  }

  if (!isTemplateKey(body.template_key)) {
    throw problem(400, 'INVALID_ARGS', 'UNKNOWN_TEMPLATE_KEY', '未知 template_key（零写入）',
      { allowed: [...TEMPLATE_KEYS] })
  }

  if (typeof body.expires_at !== 'string' || body.expires_at.trim() === '') {
    throw problem(400, 'INVALID_ARGS', 'INVALID_EXPIRES_AT', 'expires_at 必须是 ISO 时间字符串')
  }
  const expiresMs = Date.parse(body.expires_at)
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_EXPIRES_AT', 'expires_at 必须是大于当前时间的 ISO 时间（零写入）')
  }

  if (typeof body.confirmation_text !== 'string'
    || body.confirmation_text.trim() === '' || body.confirmation_text.length > 2000) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_CONFIRMATION_TEXT',
      'confirmation_text 必须是 1..2000 字符串（人的确认原话，零写入）')
  }
  const confirmationTextSha256 = createHash('sha256').update(body.confirmation_text, 'utf8').digest('hex')

  const revoke = body.revoke === true
  if (revoke && (typeof body.authorization_id !== 'string' || body.authorization_id.trim() === '')) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_AUTHORIZATION_ID', '撤销必须给 authorization_id')
  }

  const rawScope = body.scope
  let scope: AuthorizeCommand['scope'] = {}
  if (revoke) {
    // 撤销版本沿用空 scope（判定函数遇到 revoked 直接拒，无需 scope 命中）。
    scope = {}
  } else {
    if (rawScope === undefined || typeof rawScope !== 'object' || rawScope === null || Array.isArray(rawScope)) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_SCOPE', 'scope 必须是含 job_ids / application_ids / recipient_refs 的对象')
    }
    const scopeObj = rawScope as Record<string, unknown>
    const jobIds = parseIdArray(scopeObj.job_ids, 'job_ids')
    const applicationIds = parseIdArray(scopeObj.application_ids, 'application_ids')
    const recipientRefs = parseIdArray(scopeObj.recipient_refs, 'recipient_refs')
    if (jobIds === undefined && applicationIds === undefined) {
      throw problem(400, 'INVALID_ARGS', 'INVALID_SCOPE', 'scope 必须至少给 job_ids 或 application_ids')
    }
    scope = {
      ...(jobIds === undefined ? {} : { job_ids: jobIds }),
      ...(applicationIds === undefined ? {} : { application_ids: applicationIds }),
      ...(recipientRefs === undefined ? {} : { recipient_refs: recipientRefs }),
    }
  }

  return {
    email_class: emailClass,
    scope,
    template_key: body.template_key,
    expires_at: body.expires_at,
    confirmation_text_sha256: confirmationTextSha256,
    revoke,
    ...(revoke ? { revoke_authorization_id: body.authorization_id as string } : {}),
  }
}

/**
 * `POST /recruitment/api/action/email/authorize` —— 人点授权写入口（不是 Agent 工具）。
 *
 * 前置闸门与人工发信一致：loopback / 同源 / session→alias 绑定 / 仅 recruiter /
 * 未配置 503。失败全部在碰 DB 前 fail-closed，零写入。
 * 写入 = 追加 business_config 新版本（不 UPDATE 历史）；撤销 = 追加 revoked 新版本。
 */
async function handleAuthorize(deps: EmailSendHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = readSessionHeader(req)
  let resolved: ResolvedExecutionActor
  try {
    resolved = requireBoundActor(deps.identity, sessionId)
  } catch (error) {
    if (error instanceof RecruitmentToolError && error.code === 'DEMO_ACTOR_UNMAPPED') {
      throw problem(409, 'CONFLICT', 'DEMO_ACTOR_UNMAPPED',
        'session 未绑定 recruiter 身份，拒绝授权（零写入）')
    }
    throw error
  }
  assertAlias(resolved)

  const url = new URL(req.url ?? '/', 'http://localhost')
  rejectQueryOverrides(url)
  const body = await readJsonObject(req)
  const command = parseAuthorizeCommand(body)

  if (deps.database === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，授权不可用', { issues: [...deps.databaseIssues] })
  }
  const database = deps.database
  const io = deps.io ?? {}
  const insertAuthorization = io.insertAuthorization ?? insertEmailAuthorization
  const withWrite = io.withWrite ?? defaultWithWrite

  const result: InsertEmailAuthorizationResult = await withWrite(database, resolved.actor_id, async (client) => (
    await insertAuthorization(client, {
      tenant_id: database.tenant_id,
      actor_id: resolved.actor_id,
      scope: command.scope,
      email_class: command.email_class,
      template_key: command.template_key,
      expires_at: command.expires_at,
      confirmation_text_sha256: command.confirmation_text_sha256,
      revoke: command.revoke,
      ...(command.revoke_authorization_id === undefined ? {} : { revoke_authorization_id: command.revoke_authorization_id }),
    })
  ))

  // 写后独立只读连接读回（不是回显请求）。
  const readAuthorization = io.readAuthorization ?? defaultReadAuthorization
  const readback = await readAuthorization(database, result.id)

  json(res, 200, {
    action: 'email/authorize',
    authorization: {
      id: shortId(result.id),
      version_no: result.version_no,
      authorization_ref: shortId(result.authorization_ref),
    },
    readback: {
      id: shortId(readback.id),
      version_no: readback.version_no,
      payload_hash: readback.payload_hash === null ? null : shortId(readback.payload_hash),
      effective_from: readback.effective_from,
    },
  })
}

// =====================================================================
//  注册入口
// =====================================================================

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/**
 * 注册 `email/send` 写动作（exact path，POST only）。非回环 host 不注册并告警。
 * @returns 注销函数。
 */
export function registerEmailSendHttp(ctx: EmailSendHostContext, deps: EmailSendHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: email/send 路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const post = (handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => guard(async (req, res) => {
    assertSameOrigin(req, port)
    const url = new URL(req.url ?? '/', 'http://localhost')
    rejectQueryOverrides(url)
    if (req.method !== 'POST') {
      methodNotAllowed(res)
      return
    }
    await handle(req, res)
  })
  const disposeSend = webServer.register({
    kind: 'exact', path: EMAIL_SEND_PATH, handler: post((req, res) => handleEmailSend(deps, req, res)),
  })
  const disposeAuthorized = webServer.register({
    kind: 'exact', path: EMAIL_SEND_AUTHORIZED_PATH, handler: post((req, res) => handleAuthorizedSend(deps, req, res)),
  })
  const disposeAuthorize = webServer.register({
    kind: 'exact', path: EMAIL_AUTHORIZE_PATH, handler: post((req, res) => handleAuthorize(deps, req, res)),
  })
  return () => {
    for (const dispose of [disposeSend, disposeAuthorized, disposeAuthorize]) {
      try {
        dispose()
      } catch {
        // 宿主卸载尽力而为。
      }
    }
  }
}
