// Issue #31 / G-08：逐条 rubric 标准人工纠偏的受控 HTTP 写路由。
//
// 冻结契约：
//   POST /recruitment/api/action/criterion/override
//   body（封闭）：{ application_id, criterion_key, human_state, note?, confirmation_text }
//
// 纪律（与 actor.ts / scorecard-draft.ts / decision-read.ts 同一套，全部在碰 DB 之前 fail-closed）：
//   1. 非回环 host 不注册；同源 = loopback + `x-recruitment-request: 1` + Origin → 否则 403；
//   2. 身份**有且只有** `X-DSH-Session` → session→alias→actor（未绑定 409 DEMO_ACTOR_UNMAPPED）；
//      alias 必须是 recruiter、库里 actor.kind 必须是 HUMAN（否则 403，零写入）；
//   3. body 封闭：只允许工具的五个入参；actor_id / tenant_id / confirmation_text_sha256 等
//      服务端派生键与身份键在碰 DB 之前 400（reason_code 与工具一致）；
//   4. **严格复用 `createCriterionOverrideTool(...).execute()`**：不重写域规则、不自己算哈希、
//      不改 rubric 校验。confirmation_text 是人的原话，sha256 由工具在服务端算并落库；
//   5. 写后**独立只读读回**（新连接池、withReadOnly）：不信工具自述，比对 override_id / human_state；
//   6. 成功响应给前端纠偏记录摘要 + 独立读回，供紧接挂载按钮；
//   7. 不 import transcript-import / app / client；不注册任何其它路径。
import type { IncomingMessage, ServerResponse } from 'node:http'

import { closePool, createPool, withReadOnly, type DatabasePool, type ResolvedDatabaseConfig } from '../db/pool.ts'
import {
  readOverridesForApplication,
  toOverrideProjection,
  type CriterionOverrideProjection,
} from '../db/criterion-override.ts'
import { DEMO_SESSION_HEADER, normalizeSessionId, resolveSessionActor, type DemoActorIdentity, type ResolvedExecutionActor } from '../demo-actor/index.ts'
import { EVENT_TYPES } from '../runtime/event-types.ts'
import {
  createCriterionOverrideTool,
  CRITERION_OVERRIDE_TOOL,
  type CriterionOverrideValue,
} from '../tools/criterion-override.ts'
import { sameOrigin } from './overview.ts'

// =====================================================================
//  契约常量
// =====================================================================

/** 唯一注册的 exact path。 */
const OVERRIDE_PATH = '/recruitment/api/action/criterion/override'
/** 契约版本（响应里回显，前端可据此识别形状）。 */
const CONTRACT_VERSION = 'criterion-override-http 1.0.0'
/** 客户端唯一允许提交的 body 键（与工具 PARAMS 一一对应；没有哈希/身份键）。 */
const BODY_KEYS: readonly string[] = ['application_id', 'criterion_key', 'human_state', 'note', 'confirmation_text']
/** 服务端派生 / 身份键：命中即拒（reason_code 与工具的 parseToolArgs 对齐）。 */
const SERVER_DERIVED_KEYS: readonly string[] = [
  'confirmation_text_sha256', 'confirmation_method', 'record_version', 'id',
  'rubric_version_id', 'superseded_by_override_id', 'created_at', 'updated_at',
]
const IDENTITY_KEYS: readonly string[] = ['actor_id', 'tenant_id']
/** query / header 里的身份覆盖键（命中 400，不碰 DB）。 */
const OVERRIDE_QUERY_KEYS: readonly string[] = ['actor_id', 'tenant_id']
const OVERRIDE_HEADERS: readonly string[] = ['x-recruitment-actor', 'x-recruitment-tenant']
/** 只允许 recruiter alias（与 decision-read.ts 的写动作闸门同口径）。 */
const WRITE_ALLOWED_ALIASES: readonly string[] = ['recruiter']
/** 回环地址（非回环不注册）。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1'])
/** 请求体上限（工具五字段最长合计约 4.2K 字；留足转义空间）。 */
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
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_CONFIGURED: 503,
  DEMO_ACTOR_UNMAPPED: 409,
  DB_CONSTRAINT_VIOLATION: 500,
  READER_FAILED: 500,
}

// =====================================================================
//  宿主上下文 / 依赖（窄接口，由 index.ts 装配；本文件不 import index.ts）
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

export interface CriterionOverrideHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 路由依赖：库配置 + 已装配的 Demo Actor 身份（与全部写工具/Host Action 共享单例）。 */
export interface CriterionOverrideHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  readonly identity: DemoActorIdentity
}

// =====================================================================
//  HTTP 小工具（封闭错误信封 `{error:{code,reason_code,message,detail?}}`）
// =====================================================================

class OverrideHttpProblem extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'OverrideHttpProblem'
    this.status = status
    this.body = body
  }
}

function problem(status: number, code: string, reasonCode: string, message: string, detail?: unknown): OverrideHttpProblem {
  return new OverrideHttpProblem(status, {
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
function rejectOverrides(req: IncomingMessage, url: URL, body: Record<string, unknown>): void {
  const rejected: string[] = []
  for (const key of OVERRIDE_QUERY_KEYS) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
    if (Object.hasOwn(body, key)) rejected.push(`body.${key}`)
  }
  for (const key of OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  }
  if (rejected.length > 0) {
    throw problem(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入',
      { rejected },
    )
  }
  const derived = SERVER_DERIVED_KEYS.filter((key) => Object.hasOwn(body, key)).sort()
  if (derived.length > 0) {
    throw problem(
      400,
      'INVALID_ARGS',
      'SERVER_DERIVED_REJECTED',
      `${derived.join(', ')} 由服务端派生（confirmation_text_sha256 = sha256(confirmation_text)），调用方不得传入`,
      { rejected: derived },
    )
  }
  const unknown = Object.keys(body).filter((key) => !BODY_KEYS.includes(key)).sort()
  if (unknown.length > 0) {
    throw problem(
      400,
      'INVALID_ARGS',
      'UNKNOWN_PARAM',
      `未声明的键 "${unknown[0]}"（允许：${BODY_KEYS.join(', ')}）`,
      { unknown, allowed: [...BODY_KEYS] },
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

/** recruiter alias 闸门（越权 403，零写入）。 */
function assertWriteAlias(resolved: ResolvedExecutionActor): void {
  if (WRITE_ALLOWED_ALIASES.includes(resolved.alias)) return
  throw problem(
    403,
    'FORBIDDEN',
    'ACTOR_NOT_AUTHORIZED',
    `当前身份（${resolved.alias}）无权执行人工纠偏（只允许 ${WRITE_ALLOWED_ALIASES.join(', ')}）`,
    { alias: resolved.alias, allowed_aliases: [...WRITE_ALLOWED_ALIASES] },
  )
}

/** 未配置库时的 503（issues 只含变量名，不含密码）。 */
function notConfigured(issues: readonly string[]): OverrideHttpProblem {
  return problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，人工纠偏不可用', { issues: [...issues] })
}

/** 把任意错误翻成 HTTP 状态 + 封闭错误信封（与 actor.ts / scorecard-draft.ts 同口径）。 */
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof OverrideHttpProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    const prefix = message.slice(0, index)
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : prefix
      const reasonCode = typeof parsed.reason_code === 'string' && parsed.reason_code !== '' ? parsed.reason_code : code
      const status = STATUS_BY_CODE[reasonCode] ?? STATUS_BY_CODE[code] ?? 500
      const body: Record<string, unknown> = { code, reason_code: reasonCode }
      body.message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message
      if (parsed.detail !== undefined) body.detail = parsed.detail
      return { status, body: { error: body } }
    } catch {
      // 不是产品错误形态：走兜底。
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'INTERNAL'
  return { status: STATUS_BY_CODE[code] ?? 500, body: { error: { code, reason_code: 'UNEXPECTED', message } } }
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

/** 短连接池（每请求建、finally 关）。 */
async function withDatabase<T>(
  deps: CriterionOverrideHttpDeps,
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

/** 工具 execute 的执行上下文（与 decision-read.ts::execOf 同口径）。 */
function execOf(resolved: ResolvedExecutionActor): Record<string, unknown> {
  return {
    agent: { id: resolved.session_id },
    headers: { [DEMO_SESSION_HEADER]: resolved.session_id },
  }
}

/** 成功响应里的 actor 段。 */
function actorEnvelope(resolved: ResolvedExecutionActor): Record<string, unknown> {
  return { session_id: resolved.session_id, alias: resolved.alias, actor_id: resolved.actor_id }
}

/** actor 行快照（存在 / 同租户 / kind）。 */
async function readActorKind(
  client: { query<T>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }> },
  tenantId: string,
  actorId: string,
): Promise<string> {
  const { rows } = await client.query<{ kind: string }>(
    `select a.kind as kind from recruitment.actor a where a.id = $1::uuid and a.tenant_id = $2::uuid`,
    [actorId, tenantId],
  )
  const kind = rows[0]?.kind
  if (kind === undefined) {
    throw problem(
      409,
      'DEMO_ACTOR_UNMAPPED',
      'ACTOR_ROW_MISSING',
      'alias 映射的 actor 在库里不存在或不属于该租户（fail-closed）',
      { actor_id: actorId },
    )
  }
  if (kind !== 'HUMAN') {
    throw problem(403, 'FORBIDDEN', 'ACTOR_NOT_HUMAN', `人工纠偏只能由 HUMAN actor 执行（实际 kind=${kind}）`, {
      actor_id: actorId,
      kind,
    })
  }
  return kind
}

/** 独立只读读回的一行快照（真值来自库，不信写工具自述）。 */
interface ReadbackRow {
  readonly id: string
  readonly human_state: string
  readonly note: string | null
  readonly actor_id: string
  readonly confirmation_method: string
  readonly confirmation_text_sha256: string
  readonly record_version: number
  readonly created_at: Date | string
}

/** 独立只读读回：该 criterion 的当前覆盖行（从读池另开事务，不信写工具自述）。 */
async function readBackCurrent(
  pool: DatabasePool,
  tenantId: string,
  applicationId: string,
  criterionKey: string,
): Promise<{ projection: CriterionOverrideProjection; row: ReadbackRow } | null> {
  return withReadOnly(pool, async (client) => {
    const { rows } = await client.query<ReadbackRow>(
      `select id, human_state, note, actor_id, confirmation_method, confirmation_text_sha256,
              record_version, created_at
         from recruitment.criterion_override
        where tenant_id = $1 and application_id = $2 and criterion_key = $3
          and superseded_by_override_id is null
        order by created_at desc, id desc
        limit 1`,
      [tenantId, applicationId, criterionKey],
    )
    const row = rows[0]
    if (row === undefined) return null
    const history = await readOverridesForApplication(client, tenantId, applicationId)
    const projection = toOverrideProjection(history).get(applicationId)?.get(criterionKey)
    return projection === undefined ? null : { projection, row }
  })
}

/** 响应里的纠偏记录摘要（只取工具契约里的机器字段，不含原文）。 */
function overrideSummary(value: CriterionOverrideValue): Record<string, unknown> {
  return {
    application_id: value.application_id,
    criterion_key: value.criterion_key,
    human_state: value.human_state,
    effective_state: value.effective_state,
    override_id: value.override_id,
    superseded_id: value.superseded_id,
    inserted: value.inserted,
    confirmation_method: value.confirmation_method,
    confirmation_text_sha256: value.confirmation_text_sha256,
    actor_id: value.actor_id,
    labels: value.labels,
  }
}

/**
 * `POST /recruitment/api/action/criterion/override` —— 严格复用工具的受控写路由。
 *
 * 顺序（全部在写之前 fail-closed）：同源 → body 形状/封闭键 → session 绑定 →
 * recruiter alias → DB actor HUMAN → 工具 execute（自有封闭入参校验 + pinned rubric 校验 +
 * 同事务审计事件）→ 独立只读读回比对 → 成功响应。
 */
async function handlePost(
  deps: CriterionOverrideHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const body = await readJsonObject(req)
  rejectOverrides(req, url, body)
  // confirmation_text 是人的原话：必填由工具 parseToolArgs 统一裁决（MISSING_REQUIRED）；
  // sha256 由工具服务端计算，本路由绝不接收/转发任何调用方给的 hash。
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  assertWriteAlias(resolved)

  await withDatabase(deps, async (cfg, pool) => {
    // HUMAN 闸门在开写事务之前（只读）；失败零写入。
    await withReadOnly(pool, (client) => readActorKind(client, cfg.tenant_id, resolved.actor_id))

    // 严格复用工具：不重写域规则；execute 内部再用 parseToolArgs 校验一次并解析写身份。
    const tool = createCriterionOverrideTool({
      database: cfg,
      identity: deps.identity,
    })
    const output = await tool.execute(body, execOf(resolved)) as CriterionOverrideValue

    // 写后独立只读读回（另一只读事务）：不信工具自述。
    const readback = await readBackCurrent(pool, cfg.tenant_id, output.application_id, output.criterion_key)
    const row = readback?.row
    if (readback === null || row === undefined || row.id !== output.override_id
        || row.human_state !== output.human_state) {
      throw problem(
        500,
        'DB_CONSTRAINT_VIOLATION',
        'OVERRIDE_READBACK_MISMATCH',
        '纠偏读回与写入结果不一致',
        {
          expected: { override_id: output.override_id, human_state: output.human_state },
          actual: row === undefined ? null : { override_id: row.id, human_state: row.human_state },
        },
      )
    }

    json(res, 200, {
      contract_version: CONTRACT_VERSION,
      action: 'criterion/override',
      tool: CRITERION_OVERRIDE_TOOL,
      actor: actorEnvelope(resolved),
      override: overrideSummary(output),
      // 读回用 DB 真值驱动前端按钮：current 即最新有效覆盖。
      readback: {
        table: 'criterion_override',
        application_id: output.application_id,
        criterion_key: output.criterion_key,
        current: {
          override_id: row.id,
          human_state: row.human_state,
          effective_state: readback.projection.effective_state,
          note: row.note,
          actor_id: row.actor_id,
          confirmation_method: row.confirmation_method,
          confirmation_text_sha256: row.confirmation_text_sha256,
          record_version: row.record_version,
          overridden_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        },
        history_length: readback.projection.history.length,
      },
      // 审计事件由工具在同事务写入；inserted=false 的幂等 no-op 不写第二条。
      audit: {
        event_type: EVENT_TYPES.CRITERION_OVERRIDE_RECORDED,
        event_recorded: output.inserted,
        normalizer_version: 'schema/0001',
      },
    })
  })
}

/**
 * 注册人工纠偏写路由（返回 disposer）。非回环 host 不注册。
 * @param ctx - 宿主上下文（webServer + 可选 logger）。
 * @param deps - 库配置 + Demo Actor 身份单例（与写工具共享）。
 */
export function registerCriterionOverrideHttp(
  ctx: CriterionOverrideHostContext,
  deps: CriterionOverrideHttpDeps,
): () => void {
  const { webServer } = ctx
  if (!LOOPBACK_HOSTS.has(webServer.host)) {
    ctx.logger?.warn(`recruitment: 人工纠偏路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0

  const handler = guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== OVERRIDE_PATH) {
      json(res, 404, { error: 'not found' })
      return
    }
    assertSameOrigin(req, port)
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await handlePost(deps, req, res, url)
  })

  return webServer.register({ kind: 'exact', path: OVERRIDE_PATH, handler })
}

/** 契约常量导出（测试用；与路由实现同一份，避免测试里写死漂移）。 */
export const CRITERION_OVERRIDE_CONTRACT = {
  path: OVERRIDE_PATH,
  methods: ['POST'] as const,
  bodyKeys: BODY_KEYS,
  maxBodyBytes: MAX_BODY_BYTES,
  statusByCode: STATUS_BY_CODE,
  contractVersion: CONTRACT_VERSION,
} as const
