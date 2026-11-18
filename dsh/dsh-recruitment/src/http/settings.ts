// 工作空间设置的 HTTP 层（docs/34 §二.2-5；docs/17 D-112 配置产品化）。
//
// 自包含 `registerSettingsHttp(ctx, deps)`；**接线由 src/index.ts 的 lead 完成**，
// 本文件不碰入口。两条 exact 路由：
//   * GET  /recruitment/api/settings                —— 只读投影（前端设置页）
//   * POST /recruitment/api/action/settings/write  —— Host Action（人在界面点）
//
// 闸门全部照 `src/http/actions.ts`（同源/回环/session/alias/覆盖键/错误映射），
// 且**全部在碰 DB 之前**；未绑定 = 409 DEMO_ACTOR_UNMAPPED 零读取/零写入。
//
// 连接状态**只读展示、绝不撒谎**（V4/R4）：
//   * email 用 `resolveMailConfig(config, env)`：resolved===null → NOT_CONFIGURED；
//   * 飞书日历/妙记用 `resolveFeishuConnector(config, env)`：未装配 → NOT_CONFIGURED；
//     装配后 `adapter.probe()` 只可能给 NOT_CONNECTED/AUTH_REQUIRED（probe 恒
//     live_eligible=false、connection 永不 CONNECTED）——没做真实回读就绝不报 CONNECTED。
//
// config/env 全部由 deps 注入（不读 process.env 猜）。
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { createPool, closePool, withActor, withReadOnly, type ResolvedDatabaseConfig } from '../db/pool.ts'
import { appendSettingVersion, readAllSettings, readSetting, type SettingView } from '../db/settings.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorAlias,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import {
  WORKSPACE_SETTING_KEYS,
  isWorkspaceSettingKey,
  validateConfirmationText,
  validateWorkspaceSettingValue,
  type WorkspaceSettingKey,
} from '../domain/tenant-config.ts'
import { resolveMailConfig, type MailConfigInput, type MailEnvMap } from '../connectors/mail/contract.ts'
import {
  resolveFeishuConnector,
  type FeishuConnectorConfig,
} from '../connectors/feishu/wiring.ts'
import { sameOrigin } from './overview.ts'

// =====================================================================
//  契约常量
// =====================================================================

/** 两条 exact 路由（路径是契约，UI 按此调用；lead 接线时勿改）。 */
export const SETTINGS_PATHS = {
  read: '/recruitment/api/settings',
  write: '/recruitment/api/action/settings/write',
} as const

/** 写动作名（响应 `action` 字段 + 错误 detail）。 */
const ACTION_NAME = 'settings/write'

/** 允许调用写动作的 alias（与 actions.ts::ACTION_ALLOWED_ALIASES 同口径：只 recruiter）。 */
const ALLOWED_ALIASES: readonly DemoActorAlias[] = ['recruiter']

/**
 * body 里服务端派生的/身份相关键（命中即 400 ACTOR_OVERRIDE_REJECTED，零写入）。
 * 含任务点名的 confirmation_text_sha256（哈希只由服务端算）。
 */
const OVERRIDE_BODY_KEYS = [
  'actor_id',
  'tenant_id',
  'actor',
  'tenant',
  'alias',
  'actor_alias',
  'updated_by_actor_id',
  'created_by_actor_id',
  'confirmation_text_sha256',
  'confirmation_text_sha256_hex',
  'changed_from',
  'changed_to',
  'version_no',
] as const

/** 请求体上限 64 KiB（超限 413，零写入）。 */
const MAX_BODY_BYTES = 64 * 1024

/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 服务端默认（诚实缺省：GET 响应用 defaults_applied 告诉前端"这是默认不是已配置"）。 */
const DEFAULT_SETTINGS = {
  agent_silent_delegation: false,
  sla_thresholds: { screening_hours: 24, scorecard_hours: 48 },
} as const

/** 连接状态的封闭取值（与任务约定一致）。 */
type ConnectionState = 'CONNECTED' | 'NOT_CONFIGURED' | 'AUTH_REQUIRED'

/** 契约错误的 HTTP 状态映射（照 actions.ts::STATUS_BY_CODE；未列的一律 500）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  FORBIDDEN: 403,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_CONFIGURED: 503,
  INVARIANT_VIOLATION: 500,
  INTERNAL: 500,
}

// =====================================================================
//  宿主上下文 / 依赖（窄接口）
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

/** 宿主上下文（`src/index.ts` 把 cordis Context 窄成这个形状再传进来）。 */
export interface SettingsHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** `registerSettingsHttp` 的依赖。配置解析所需的 config/env **全部注入**，不读进程环境。 */
export interface SettingsHttpDeps {
  /** 已解析的数据库配置；`null` = 未配置（路由仍注册，返回 503，不假装成功）。 */
  readonly database: ResolvedDatabaseConfig | null
  /** `database === null` 时缺失的配置项（只含变量名，不含密码）。 */
  readonly databaseIssues: readonly string[]
  /** session → alias 注册表 + alias → HUMAN actor 映射（与其它 HTTP 共享的同一个实例）。 */
  readonly identity: DemoActorIdentity
  /** mail 配置段（来自 cordis.patch.yml；缺省空对象 = 未配置）。 */
  readonly mailConfig: MailConfigInput
  /** mail 的 `${ENV}` / 口令存在性数据（只含变量名，不含口令值）。 */
  readonly mailEnv: MailEnvMap
  /** 飞书配置段（缺省空对象 = 未装配）。 */
  readonly feishuConfig: FeishuConnectorConfig
  /** 飞书 `${ENV}` / 凭据存在性数据（只判布尔，不读值）。 */
  readonly feishuEnv: Readonly<Record<string, string | undefined>>
  /**
   * 可选观测钩子（**仅测试用**；生产接线不传）：在校验全部通过、sha256 算好、
   * 但还没碰 DB 时回调一次，入参就是即将交给 `appendSettingVersion` 的字段。
   * 用来机检"哈希由服务端算 / 写入参数不被客户端覆盖 / 拒绝路径零写入"。
   */
  readonly hooks?: {
    readonly beforeWrite?: (input: {
      readonly key: WorkspaceSettingKey
      readonly value: unknown
      readonly confirmationTextSha256: string
      readonly actorId: string
      readonly tenantId: string | null
    }) => void
    /** 测试用：替换 GET 的只读投影数据源（返回空数组 = 全部走诚实缺省）。 */
    readonly readAll?: (tenantId: string) => Promise<SettingView[]>
  }
}

// =====================================================================
//  HTTP 小工具（与 actions.ts 同形）
// =====================================================================

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

function problem(
  status: number,
  code: string,
  reasonCode: string,
  message: string,
  detail?: unknown,
): HttpProblem {
  return new HttpProblem(status, {
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

/** 读 `X-DSH-Session` 头并归一化（身份**有且只有**这个头）。 */
function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw problem(
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

/** session → alias → actor（未绑定 / 别名无映射 → 409 DEMO_ACTOR_UNMAPPED，零读取/零写入）。 */
function requireBoundActor(deps: SettingsHttpDeps, sessionId: string): ResolvedExecutionActor {
  return resolveSessionActor(deps.identity, sessionId)
}

/** 动作级 alias 闸门（只 recruiter；越权 → 403，零写入）。 */
function assertAllowedAlias(resolved: ResolvedExecutionActor): void {
  if ((ALLOWED_ALIASES as readonly string[]).includes(resolved.alias)) return
  throw problem(
    403,
    'FORBIDDEN',
    'ACTOR_NOT_AUTHORIZED',
    `当前身份（${resolved.alias}）无权执行该写动作（只允许 ${ALLOWED_ALIASES.join(', ')}）`,
    { action: ACTION_NAME, alias: resolved.alias, allowed_aliases: [...ALLOWED_ALIASES] },
  )
}

/** 统一错误边界（照 actions.ts::errorResponse：优先解析 `CODE: <compact-json>`）。 */
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
    } catch {
      // 不是产品错误形态：走下面的最小兜底。
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'INTERNAL'
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

function requireDatabase(deps: SettingsHttpDeps): ResolvedDatabaseConfig {
  if (deps.database === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，设置读写不可用', {
      issues: [...deps.databaseIssues],
    })
  }
  return deps.database
}

async function withPool<T>(
  cfg: ResolvedDatabaseConfig,
  fn: (pool: ReturnType<typeof createPool>) => Promise<T>,
): Promise<T> {
  const pool = createPool(cfg)
  try {
    return await fn(pool)
  } finally {
    await closePool(pool)
  }
}

/** 读请求体（上限 64 KiB；超限 413）。 */
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

/** 读 JSON 请求体 → 普通对象（415/413/400 的封闭映射；不做业务校验）。 */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || contentType.toLowerCase().split(';')[0]?.trim() !== 'application/json') {
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

/** 拒绝 body 里的身份/服务端派生键（命中即 400，且**不碰 DB**）。 */
function rejectBodyOverrides(body: Record<string, unknown>): void {
  const rejected = OVERRIDE_BODY_KEYS.filter((key) => Object.hasOwn(body, key)).sort()
  if (rejected.length > 0) {
    throw problem(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 与确认哈希只能由服务端派生，不接受客户端传入（零写入）',
      { rejected },
    )
  }
}

// =====================================================================
//  连接状态（只读展示，诚实不撒谎）
// =====================================================================

interface ConnectionProjection {
  readonly state: ConnectionState
  readonly detail?: string
}

/**
 * email 连接状态：resolved===null → NOT_CONFIGURED（detail 只含变量名/类别）。
 * resolved 非 null 也只是"配置齐了"，**不做真实回读**，所以最多 AUTH_REQUIRED
 * （需要真连接验证），绝不报 CONNECTED。
 */
function emailState(deps: SettingsHttpDeps): ConnectionProjection {
  const { resolved, issues } = resolveMailConfig(deps.mailConfig, deps.mailEnv)
  if (resolved === null) {
    return { state: 'NOT_CONFIGURED', detail: issues.join('; ') }
  }
  // 配置齐但未做真实 IMAP 回读 → 不许撒谎说 CONNECTED。
  return { state: 'AUTH_REQUIRED', detail: '配置已就绪，但未完成真实邮箱回读' }
}

/**
 * 飞书连接状态（日历 / 妙记共用同一份解析）。
 * 未装配 → NOT_CONFIGURED；装配后 probe() 只给 NOT_CONNECTED / AUTH_REQUIRED，
 * 恒不 CONNECTED（adapter.ts 的诚实口径）。
 */
function feishuState(deps: SettingsHttpDeps): ConnectionProjection {
  const resolved = resolveFeishuConnector(deps.feishuConfig, deps.feishuEnv)
  if (!resolved.transport_configured || resolved.connector === undefined) {
    return { state: 'NOT_CONFIGURED', detail: resolved.issues.join('; ') }
  }
  const probe = resolved.connector.adapter.probe()
  if (probe.connection_state === 'NOT_CONNECTED') {
    return { state: 'NOT_CONFIGURED', detail: probe.missing.join(', ') }
  }
  // probe 只可能是 NOT_CONNECTED / AUTH_REQUIRED；即便将来变了也不许把未回读报成 CONNECTED。
  return { state: 'AUTH_REQUIRED', detail: probe.missing.join(', ') }
}

// =====================================================================
//  GET /recruitment/api/settings —— 只读投影
// =====================================================================

async function handleRead(deps: SettingsHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = readSessionHeader(req)
  requireBoundActor(deps, sessionId) // 未绑定 → 409，零读取（在开池之前）
  const value = deps.hooks?.readAll !== undefined
    ? await deps.hooks.readAll('test-tenant')
    : await withPool(requireDatabase(deps), (pool) =>
        withReadOnly(pool, (client) =>
          readAllSettings(client, deps.database!.tenant_id, WORKSPACE_SETTING_KEYS),
        ),
      )

  const byKey = new Map(value.map((row) => [row.config_key, row.value]))
  const silent = byKey.get('agent_silent_delegation')
  const sla = byKey.get('sla_thresholds')
  const defaultsApplied: string[] = []

  const silentValue = typeof silent === 'boolean' ? silent : (defaultsApplied.push('agent_silent_delegation'), DEFAULT_SETTINGS.agent_silent_delegation)
  const slaValue = isSlaThresholds(sla)
    ? sla
    : (defaultsApplied.push('sla_thresholds'), { ...DEFAULT_SETTINGS.sla_thresholds })

  json(res, 200, {
    connections: {
      email: emailState(deps),
      feishu_calendar: feishuState(deps),
      feishu_minutes: feishuState(deps),
    },
    settings: {
      agent_silent_delegation: silentValue,
      sla_thresholds: slaValue,
    },
    ...(defaultsApplied.length > 0 ? { defaults_applied: defaultsApplied } : {}),
  })
}

/** 库里读出的值是否是可直接展示的 SLA 对象（严格两字段整数；否则走诚实缺省）。 */
function isSlaThresholds(value: unknown): value is { screening_hours: number; scorecard_hours: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return Number.isInteger(raw.screening_hours)
    && Number.isInteger(raw.scorecard_hours)
    && Object.keys(raw).every((key) => key === 'screening_hours' || key === 'scorecard_hours')
}

// =====================================================================
//  POST /recruitment/api/action/settings/write —— Host Action
// =====================================================================

interface WriteResult {
  readonly action: typeof ACTION_NAME
  readonly version_no: number
  readonly key: WorkspaceSettingKey
  readonly value: unknown
  readonly changed_from: unknown
  /** 业务 alias（不吐内部 UUID）。 */
  readonly updated_by_actor_id: string
  readonly confirmation_text_sha256: string
}

async function handleWrite(deps: SettingsHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 闸门顺序（全部在碰 DB 之前）：session 头 → 未绑定 409 → alias → body → 覆盖键 → 校验 → sha256。
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps, sessionId)
  assertAllowedAlias(resolved)

  const body = await readJsonObject(req)
  rejectBodyOverrides(body)

  const key = body.key
  if (!isWorkspaceSettingKey(key)) {
    throw problem(400, 'INVALID_ARGS', 'SETTING_KEY_UNKNOWN', '未知或只读的设置键', { allowed: [...WORKSPACE_SETTING_KEYS] })
  }
  // 复用 Owner 的纯校验（严格布尔 / SLA 1..720 / 缺字段未知字段拒绝）。
  const value = validateWorkspaceSettingValue(key, body.value)
  // 复用 Owner 的确认原话校验（1..2000，非空）；哈希只由服务端算。
  const confirmationText = validateConfirmationText(body.confirmation_text)
  const confirmationTextSha256 = createHash('sha256').update(confirmationText, 'utf8').digest('hex')

  // 测试观测点（生产不传）：到这里校验全过、哈希已算好、尚未碰 DB。
  deps.hooks?.beforeWrite?.({
    key,
    value,
    confirmationTextSha256,
    actorId: resolved.actor_id,
    tenantId: deps.database?.tenant_id ?? null,
  })

  const cfg = requireDatabase(deps)

  const appended = await withPool(cfg, (pool) =>
    withActor(pool, resolved.actor_id, (client) =>
      appendSettingVersion(client, {
        tenantId: cfg.tenant_id,
        configKey: key,
        value,
        actorId: resolved.actor_id,
        confirmationTextSha256,
      }),
    ),
  )

  // 写后**独立只读读回**（另开只读事务，读精确键）。
  const readback = await withPool(cfg, (pool) =>
    withReadOnly(pool, (client) => readSetting(client, cfg.tenant_id, key)),
  )
  if (readback === null) {
    throw problem(500, 'INTERNAL', 'READBACK_MISSING', '写事务已提交但独立读回不到该行')
  }

  const result: WriteResult = {
    action: ACTION_NAME,
    version_no: readback.version_no,
    key,
    value: readback.value,
    changed_from: appended.changed_from,
    updated_by_actor_id: resolved.alias, // 业务 alias，不吐内部 UUID
    confirmation_text_sha256: confirmationTextSha256,
  }
  json(res, 200, result)
}

// =====================================================================
//  注册入口
// =====================================================================

/** 回环地址判据（只接受 127.0.0.1 / ::1；其余地址不注册路由）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/**
 * 注册两条设置路由；返回 disposer（插件卸载即注销）。
 * 非回环监听时不注册并 warn（fail-closed）。
 */
export function registerSettingsHttp(ctx: SettingsHostContext, deps: SettingsHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 设置路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const routes: readonly (readonly [
    string,
    'GET' | 'POST',
    (deps: SettingsHttpDeps, req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ])[] = [
    [SETTINGS_PATHS.read, 'GET', handleRead],
    [SETTINGS_PATHS.write, 'POST', handleWrite],
  ]
  const disposers = routes.map(([path, method, handler]) =>
    webServer.register({
      kind: 'exact',
      path,
      handler: guard(async (req, res) => {
        assertSameOrigin(req, port)
        if (req.method !== method) {
          methodNotAllowed(res, method)
          return
        }
        await handler(deps, req, res)
      }),
    }),
  )
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
