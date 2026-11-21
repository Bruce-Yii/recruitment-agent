// 妙记录音归属改绑 · 宿主 HTTP 路由（自包含注册器 `registerMinuteRebindHttp`）。
//
// 契约（docs/34 §二.2-3、docs/36 C2）：
//   POST /recruitment/api/action/interview/rebind-minute
//   body { interview_id, from_actor_id, to_actor_id, minute_token, confirmation_text, dry_run? }
//   成功返回 `{action, interview_id, from_actor_id, to_actor_id, dry_run, rebind_id,
//              confirmation_text_sha256, cli_summary, already_done}`。
//
// 闸门（全部在碰 DB / 调 CLI 之前 fail-closed，与 actor.ts / scorecard-draft.ts / star.ts 同一纪律）：
//   1. 非回环 host 不注册路由；sameOrigin（loopback + x-recruitment-request:1 + Origin）→ 403；
//   2. 身份**有且只有** `X-DSH-Session` → session→alias→HUMAN actor（共享 identity 单例）；
//      未绑定 → 409 DEMO_ACTOR_UNMAPPED；客户端 actor_id/tenant_id/hash 覆盖键 → 400；
//   3. **只允许对本人可管的面试**：当前 actor 必须是该 interview 已登记的 interviewer；
//      from/to 也必须是**同一场面试**已登记的 interviewer，且 from≠to（防跨面试/跨人改绑）；
//   4. confirmation_text 是人的原话（非空 ≤2000 字符），**sha256 只由服务端算**；
//   5. **平台身份映射**（speaker_id / open_id）必须由接线层配置提供，缺失 → 422
//      REBIND_IDENTITY_UNMAPPED（零外部写、零审计行）；minute_token 形状校验（≤512、无 @/控制字符）；
//   6. **幂等**：同一 (interview, minute_token, to_actor) 已有审计行 → 直接返回
//      already_done=true，**不再调 CLI、不再写**；并发冲突由库唯一键兜底（409）；
//   7. **本阶段只允许 dry_run**：`dry_run` 缺省按 true 处理；显式 false → 400
//      REAL_WRITE_NOT_ALLOWED（真实改绑留人点验收）。runner 永远不传 allow_real_write；
//   8. CLI 非零 → 502 `REBIND_FAILED` + 脱敏 stderr 摘要，**绝不报成功**，且不写审计行；
//   9. dry-run 成功 → 单事务写一条 `minute_rebind` 审计事实（谁/何时/哪个会议/从谁到谁/原话哈希/CLI 摘要）；
//      写后**独立只读读回**（不信自述）。
//
// 不新增工具、不加依赖、不碰 src/client/**、src/runtime/**、docs；index.ts 由总控收口（两行清单）。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type DatabaseClient,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import {
  appendMinuteRebind,
  findByIdempotencyKey,
  toRebindProjection,
  type MinuteRebindRow,
} from '../db/minute-rebind.ts'
import {
  rebindMinuteSpeaker,
  REBIND_DEFAULT_CLI,
  type RebindCliSummary,
  type RebindConnectorConfig,
} from '../connectors/feishu/rebind.ts'
import { sha256Text } from '../domain/criterion-override.ts'
import { isUuid } from '../tools/contract.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'

// =====================================================================
//  契约常量
// =====================================================================

const REBIND_PATH = '/recruitment/api/action/interview/rebind-minute'
/** body 允许的键（`dry_run` 可选；其余必填）。 */
const BODY_KEYS = ['interview_id', 'from_actor_id', 'to_actor_id', 'minute_token', 'confirmation_text', 'dry_run'] as const
/** 客户端不许覆盖的身份/派生键（query / body / header 命中即 400，零写入）。 */
const ACTOR_OVERRIDE_BODY_KEYS = [
  'actor_id', 'tenant_id', 'actor', 'tenant', 'alias', 'actor_alias',
  'requested_by_actor_id', 'confirmation_text_sha256', 'confirmation_text_sha256_hex',
  'cli_summary', 'rebind_id', 'allow_real_write', 'from_speaker_id', 'to_user_id',
] as const
const ACTOR_OVERRIDE_QUERY_KEYS = ['actor_id', 'tenant_id', 'allow_real_write'] as const
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
/** 请求体上限 32 KiB（原话 ≤2000 字符 + 元数据）。 */
const MAX_BODY_BYTES = 32 * 1024
/** 原话长度上限。 */
const MAX_CONFIRMATION_CHARS = 2000
/** minute_token 长度上限（与库 ck 一致）。 */
const MAX_MINUTE_TOKEN_LENGTH = 512
/** 非回环地址不注册。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1'])
/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const
/** 错误码 → HTTP 状态（封闭集；未列出按 500）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  REBIND_ALREADY_DONE: 409,
  REAL_WRITE_NOT_ALLOWED: 400,
  REBIND_IDENTITY_UNMAPPED: 422,
  REBIND_FAILED: 502,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_CONFIGURED: 503,
  DB_CONSTRAINT_VIOLATION: 500,
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

/** 一条 actor → 平台身份映射（由接线层从配置提供；**不是** HTTP 入参）。 */
export interface RebindActorIdentity {
  /** opaque speaker_id（来自 transcript speakerlist API，不是显示名）。 */
  readonly from_speaker_id: string
  /** 新面试官 open_id（ou_ 开头）。 */
  readonly to_user_id: string
}

/** `src/index.ts` 把 cordis Context 窄成这个形状再传进来。 */
export interface MinuteRebindHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 路由依赖：库配置 + 身份单例 + CLI 连接器 + actor→平台身份映射。 */
export interface MinuteRebindHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  readonly identity: DemoActorIdentity
  /** CLI 连接器（runner 可注入假 spawn；profile 固定 recruitment）。 */
  readonly connector: RebindConnectorConfig
  /**
   * actor uuid → 平台身份（speaker_id / open_id）。接线层负责填真实值；
   * from/to 任一方缺映射 → 422 REBIND_IDENTITY_UNMAPPED，零外部写。
   */
  readonly identities: Readonly<Record<string, RebindActorIdentity>>
}

// =====================================================================
//  SQL（只读；全部带 tenant_id 过滤）
// =====================================================================

/** 当前 actor 是否是这场面试已登记的面试官（身份绑定，不是权限系统）。 */
const INTERVIEWER_SQL = `
  select ivr.id::text as interviewer_id
    from recruitment.interviewer ivr
   where ivr.interview_id = $1::uuid and ivr.actor_id = $2::uuid and ivr.tenant_id = $3::uuid
`

/** 面试是否存在（404 用；带 tenant 过滤）。 */
const INTERVIEW_SQL = `
  select i.id::text as id
    from recruitment.interview i
   where i.id = $1::uuid and i.tenant_id = $2::uuid
`

// =====================================================================
//  HTTP 小工具（封闭错误信封 `{error:{code,reason_code,message,detail?}}`）
// =====================================================================

class RebindHttpProblem extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'RebindHttpProblem'
    this.status = status
    this.body = body
  }
}

function problem(status: number, code: string, reasonCode: string, message: string, detail?: unknown): RebindHttpProblem {
  return new RebindHttpProblem(status, {
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

function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）')
  }
}

function rejectOverrides(req: IncomingMessage, url: URL, body: Record<string, unknown>): void {
  const rejected: string[] = []
  for (const key of ACTOR_OVERRIDE_QUERY_KEYS) if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  for (const key of ACTOR_OVERRIDE_HEADERS) if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  for (const key of ACTOR_OVERRIDE_BODY_KEYS) if (Object.hasOwn(body, key)) rejected.push(`body.${key}`)
  if (rejected.length > 0) {
    throw problem(
      400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant/原话哈希/平台身份/allow_real_write 只能来自服务端，不接受客户端传入（D-33 / D-95，零写入）',
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

function requireActor(deps: MinuteRebindHttpDeps, req: IncomingMessage): ResolvedExecutionActor {
  return resolveSessionActor(deps.identity, readSession(req))
}

function requireDatabase(deps: MinuteRebindHttpDeps): ResolvedDatabaseConfig {
  if (deps.database === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，改绑动作不可用', { issues: [...deps.databaseIssues] })
  }
  return deps.database
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof RebindHttpProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : message.slice(0, index)
      const reasonCode = typeof parsed.reason_code === 'string' && parsed.reason_code !== '' ? parsed.reason_code : code
      return {
        // 专属 reason_code 优先（如 REBIND_ALREADY_DONE=409），否则用顶层 code。
        status: STATUS_BY_CODE[reasonCode] ?? STATUS_BY_CODE[code] ?? 500,
        body: {
          error: {
            code,
            reason_code: reasonCode,
            ...(typeof parsed.reason_code === 'string' ? { reason_code: parsed.reason_code } : {}),
            message: typeof parsed.message === 'string' ? parsed.message : message,
            ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
          },
        },
      }
    } catch { /* 不是产品错误形态，兜底 */ }
  }
  const maybeCode = (error as { code?: unknown } | null)?.code
  const code = typeof maybeCode === 'string' && maybeCode !== '' ? maybeCode : 'INTERNAL'
  return { status: STATUS_BY_CODE[code] ?? 500, body: { error: { code, reason_code: 'UNEXPECTED', message } } }
}

// =====================================================================
//  入参解析（纯函数；全部在碰 DB / CLI 之前）
// =====================================================================

interface ParsedRebindBody {
  readonly interview_id: string
  readonly from_actor_id: string
  readonly to_actor_id: string
  readonly minute_token: string
  readonly confirmation_text: string
  readonly confirmation_sha256: string
  readonly dry_run: true
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw problem(400, 'INVALID_ARGS', 'MISSING_REQUIRED', `缺必填字段 "${field}"`, { missing: [field] })
  }
  if (!isUuid(value)) {
    throw problem(400, 'INVALID_ARGS', 'ID_NOT_UUID', `字段 "${field}" 必须是 UUID`, { field })
  }
  return value
}

function parseBody(body: Record<string, unknown>): ParsedRebindBody {
  const unknown = Object.keys(body).filter((key) => !(BODY_KEYS as readonly string[]).includes(key)).sort()
  if (unknown.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'UNKNOWN_PARAM', `未声明的键 "${unknown[0]}"（允许：${BODY_KEYS.join(', ')}）`, {
      unknown, allowed: [...BODY_KEYS],
    })
  }
  const interviewId = requireUuid(body.interview_id, 'interview_id')
  const fromActorId = requireUuid(body.from_actor_id, 'from_actor_id')
  const toActorId = requireUuid(body.to_actor_id, 'to_actor_id')
  if (fromActorId === toActorId) {
    throw problem(400, 'INVALID_ARGS', 'SAME_ACTOR', 'from_actor_id 与 to_actor_id 不能相同（没有换人）')
  }
  const minuteTokenRaw = body.minute_token
  if (typeof minuteTokenRaw !== 'string' || minuteTokenRaw.trim() === '') {
    throw problem(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "minute_token"', { missing: ['minute_token'] })
  }
  const minuteToken = minuteTokenRaw.trim()
  if (minuteToken.length > MAX_MINUTE_TOKEN_LENGTH) {
    throw problem(400, 'INVALID_ARGS', 'OUT_OF_RANGE', `minute_token 不得超过 ${MAX_MINUTE_TOKEN_LENGTH} 字符`, {
      length: minuteToken.length,
    })
  }
  if (/[\u0000-\u001f@]/.test(minuteToken)) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_TOKEN', 'minute_token 不得含控制字符或 @（会破坏平台回执）')
  }
  const confirmation = body.confirmation_text
  if (typeof confirmation !== 'string' || confirmation.trim() === '' || confirmation.length > MAX_CONFIRMATION_CHARS) {
    throw problem(
      400, 'INVALID_ARGS', 'MISSING_REQUIRED',
      `缺必填字段 "confirmation_text"（人的原话，非空且 ≤${MAX_CONFIRMATION_CHARS} 字符）`,
      { missing: ['confirmation_text'] },
    )
  }
  // 本阶段只允许 dry_run；缺省视为 true；显式 false 一律拒（真实写留人点验收）。
  if (Object.hasOwn(body, 'dry_run') && body.dry_run !== true) {
    throw problem(
      400, 'REAL_WRITE_NOT_ALLOWED', 'REAL_WRITE_NOT_ALLOWED',
      '本阶段只允许 dry_run：真实改绑须产品负责人/HR 在场时由人点验收，不接受接口直接触发',
    )
  }
  return {
    interview_id: interviewId,
    from_actor_id: fromActorId,
    to_actor_id: toActorId,
    minute_token: minuteToken,
    confirmation_text: confirmation,
    confirmation_sha256: sha256Text(confirmation),
    dry_run: true,
  }
}

/** 从接线层映射里取平台身份；缺失即 422（零外部写、零审计行）。 */
function requirePlatformIdentity(
  deps: MinuteRebindHttpDeps,
  fromActorId: string,
  toActorId: string,
): { from_speaker_id: string; to_user_id: string } {
  const from = deps.identities[fromActorId]
  const to = deps.identities[toActorId]
  const missing: string[] = []
  if (from === undefined || from.from_speaker_id.trim() === '') missing.push(`from:${fromActorId}`)
  if (to === undefined || !to.to_user_id.startsWith('ou_')) missing.push(`to:${toActorId}`)
  if (missing.length > 0) {
    throw problem(
      422, 'REBIND_IDENTITY_UNMAPPED', 'PLATFORM_IDENTITY_MISSING',
      '缺少 actor → 平台身份映射（speaker_id / open_id），不允许猜测或调用外部写',
      { missing },
    )
  }
  return {
    from_speaker_id: (from as RebindActorIdentity).from_speaker_id,
    to_user_id: (to as RebindActorIdentity).to_user_id,
  }
}

/** 当前 actor + from/to 都必须是这场面试的 interviewer（本人可管 + 防跨面试改绑）。 */
async function assertInterviewerScope(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  actorId: string,
  fromActorId: string,
  toActorId: string,
): Promise<void> {
  const interview = await client.query<{ id: string }>(INTERVIEW_SQL, [interviewId, tenantId])
  if (interview.rows[0] === undefined) {
    throw problem(404, 'NOT_FOUND', 'INTERVIEW_NOT_FOUND', '该租户下没有这场面试', { interview_id: interviewId })
  }
  for (const [actor, role] of [
    [actorId, 'requested_by'],
    [fromActorId, 'from'],
    [toActorId, 'to'],
  ] as const) {
    const { rows } = await client.query<{ interviewer_id: string }>(INTERVIEWER_SQL, [interviewId, actor, tenantId])
    if (rows[0] === undefined) {
      throw problem(
        403, 'FORBIDDEN', 'ACTOR_NOT_INTERVIEWER',
        `${role} 不是这场面试已登记的面试官（只允许对本人在场的面试改绑），零写入`,
        { interview_id: interviewId, actor_id: actor, role },
      )
    }
  }
}

// =====================================================================
//  POST /recruitment/api/action/interview/rebind-minute
// =====================================================================

interface RebindResponse {
  readonly action: 'interview/rebind-minute'
  readonly interview_id: string
  readonly from_actor_id: string
  readonly to_actor_id: string
  readonly dry_run: true
  readonly rebind_id: string | null
  readonly confirmation_text_sha256: string
  readonly cli_summary: RebindCliSummary
  readonly already_done: boolean
}

async function handleRebind(
  deps: MinuteRebindHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  // 形状/覆盖键闸门先跑（与 scorecard-draft 同口径：这些 fail-closed 不依赖 DB / 绑定）。
  const body = await readJsonObject(req)
  rejectOverrides(req, url, body)
  const parsed = parseBody(body)
  const platform = requirePlatformIdentity(deps, parsed.from_actor_id, parsed.to_actor_id)
  const resolved = requireActor(deps, req)
  const database = requireDatabase(deps)

  // ---- 只读幂等检查 + 本人可管校验（碰外部写之前，单事务只读）----
  const existing = await withReadOnlyDatabase(database, async (client) => {
    await assertInterviewerScope(
      client, database.tenant_id, parsed.interview_id,
      resolved.actor_id, parsed.from_actor_id, parsed.to_actor_id,
    )
    return findByIdempotencyKey(
      client, database.tenant_id, parsed.interview_id, parsed.minute_token, parsed.to_actor_id,
    )
  })

  if (existing.found) {
    // 幂等：同一 interview+minute+to 已完成 → 不再调 CLI、不再写审计行。
    json(res, 200, {
      action: 'interview/rebind-minute',
      interview_id: parsed.interview_id,
      from_actor_id: parsed.from_actor_id,
      to_actor_id: parsed.to_actor_id,
      dry_run: true,
      rebind_id: existing.record.id,
      confirmation_text_sha256: existing.record.confirmation_text_sha256,
      cli_summary: existing.record.cli_summary as unknown as RebindCliSummary,
      already_done: true,
    } satisfies RebindResponse)
    return
  }

  // ---- CLI dry-run（本阶段唯一允许的外部动作；--dry-run 不产生任何外部写）----
  const outcome = await rebindMinuteSpeaker(deps.connector, {
    minute_token: parsed.minute_token,
    from_speaker_id: platform.from_speaker_id,
    to_user_id: platform.to_user_id,
    dry_run: parsed.dry_run,
    // allow_real_write 永不传：真实外部写留人点验收。
  })
  if (outcome.status === 'FAILED') {
    // 如实报失败 + 脱敏 stderr 摘要；不写审计行、绝不报成功。
    const { status, body: errorBody } = errorResponse(outcome.error)
    const envelope = errorBody as { error: Record<string, unknown> }
    envelope.error.detail = { ...((envelope.error.detail as Record<string, unknown>) ?? {}), cli_summary: outcome.summary }
    json(res, status, errorBody)
    return
  }
  if (outcome.status !== 'DRY_RUN') {
    // 防御：本阶段不可能走到真实 OK（没有 allow_real_write）；万一走到，按失败处理。
    throw problem(502, 'REBIND_FAILED', 'UNEXPECTED_REAL_WRITE', '出现了本阶段不允许的真实外部写结局（零成功宣称）')
  }

  // ---- 单事务写审计事实（CLI 已成功 dry-run；失败回滚 = 零写入）----
  const written = await withActorDatabase(database, resolved.actor_id, async (client) => {
    // 事务内再查一次幂等（缩小并发窗口；唯一键是最终兜底）。
    const again = await findByIdempotencyKey(
      client, database.tenant_id, parsed.interview_id, parsed.minute_token, parsed.to_actor_id,
    )
    if (again.found) return { rebind_id: again.record.id, raced: true }
    const inserted = await appendMinuteRebind(client, {
      tenant_id: database.tenant_id,
      interview_id: parsed.interview_id,
      from_actor_id: parsed.from_actor_id,
      to_actor_id: parsed.to_actor_id,
      requested_by_actor_id: resolved.actor_id,
      minute_token: parsed.minute_token,
      confirmation_text_sha256: parsed.confirmation_sha256,
      cli_summary: outcome.summary as unknown as Record<string, unknown>,
      dry_run: true,
    })
    return { rebind_id: inserted.rebind_id, raced: false }
  })

  // 独立只读读回（不信 append 自述）。
  const readback = await withReadOnlyDatabase(database, async (client) => {
    const { rows } = await client.query<MinuteRebindRow>(
      `select id::text, tenant_id::text, interview_id::text, from_actor_id::text, to_actor_id::text,
              requested_by_actor_id::text, minute_token, confirmation_text_sha256, cli_summary,
              dry_run, created_at
         from recruitment.minute_rebind where id = $1::uuid and tenant_id = $2`,
      [written.rebind_id, database.tenant_id],
    )
    return rows[0] ?? null
  })
  if (readback === null) {
    throw problem(500, 'DB_CONSTRAINT_VIOLATION', 'REBIND_READBACK_MISMATCH', '改绑审计读回不到刚写入的行', {
      rebind_id: written.rebind_id,
    })
  }

  json(res, 200, {
    action: 'interview/rebind-minute',
    interview_id: parsed.interview_id,
    from_actor_id: parsed.from_actor_id,
    to_actor_id: parsed.to_actor_id,
    dry_run: true,
    rebind_id: written.rebind_id,
    confirmation_text_sha256: readback.confirmation_text_sha256,
    cli_summary: readback.cli_summary as unknown as RebindCliSummary,
    already_done: written.raced,
    ...(readback === null ? {} : { rebind: toRebindProjection(readback) }),
  } satisfies RebindResponse)
}

// ---- 短连接池封装（每请求建、finally 关；与 scorecard-draft 同款）----
async function withReadOnlyDatabase<T>(cfg: ResolvedDatabaseConfig, fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const pool: DatabasePool = createPool(cfg)
  try { return await withReadOnly(pool, fn) } finally { await closePool(pool) }
}
async function withActorDatabase<T>(cfg: ResolvedDatabaseConfig, actorId: string, fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const pool: DatabasePool = createPool(cfg)
  try { return await withActor(pool, actorId, fn) } finally { await closePool(pool) }
}

// =====================================================================
//  注册入口
// =====================================================================

/** 路由处理函数的统一错误边界。 */
function guarded(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try { await handler(req, res) } catch (error) {
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }
}

/**
 * 注册妙记改绑路由；非回环不注册（fail-closed），返回 disposer。
 * @param ctx - 宿主上下文（webServer + 可选 logger）。
 * @param deps - 库配置 + 身份单例 + CLI 连接器 + actor→平台身份映射。
 * @returns 注销函数。
 */
export function registerMinuteRebindHttp(ctx: MinuteRebindHostContext, deps: MinuteRebindHttpDeps): () => void {
  const { webServer } = ctx
  if (!LOOPBACK_HOSTS.has(webServer.host)) {
    ctx.logger?.warn(`recruitment: 妙记改绑路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const handler = guarded(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== REBIND_PATH) { json(res, 404, { error: 'not found' }); return }
    assertSameOrigin(req, port)
    for (const key of ACTOR_OVERRIDE_QUERY_KEYS) {
      if (url.searchParams.has(key)) {
        throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', 'actor/tenant/allow_real_write 不接受 query 覆盖', {
          rejected: [`query.${key}`],
        })
      }
    }
    for (const key of ACTOR_OVERRIDE_HEADERS) {
      if (req.headers[key] !== undefined) {
        throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', 'actor/tenant 不接受 header 覆盖', {
          rejected: [`header.${key}`],
        })
      }
    }
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    await handleRebind(deps, req, res, url)
  })
  return webServer.register({ kind: 'exact', path: REBIND_PATH, handler })
}

/** 契约常量导出（测试用；与路由实现同一份，避免测试里写死漂移）。 */
export const MINUTE_REBIND_CONTRACT = {
  path: REBIND_PATH,
  methods: ['POST'] as const,
  bodyKeys: BODY_KEYS,
  statusByCode: STATUS_BY_CODE,
  maxConfirmationChars: MAX_CONFIRMATION_CHARS,
  maxMinuteTokenLength: MAX_MINUTE_TOKEN_LENGTH,
  defaultCli: REBIND_DEFAULT_CLI,
} as const
