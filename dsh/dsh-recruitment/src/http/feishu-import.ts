// 真实飞书转写 → 产品链路（D5 P0-7，task-58）。
//
// 问题背景（独立验收 FAIL）：干净库里没有真实 Meeting/Interview 绑定，产品 UI 也没有
// 「导入真实转写」的入口 —— 只有工具级 connector。`recruitment_transcript_import` 的连接器
// 回读路径要求**已经存在** active 绑定会议（否则 NO_MEETING_BOUND），所以"先有会议绑定"这一步
// 在真实链路里没人做。本文件补的就是这一步 + 端到端产品入口：
//
//   POST /recruitment/api/feishu/import   body `{interview_id, minute_token}`
//     1. 同源 loopback + `x-dsh-session` → 进程内 alias → 数据库 HUMAN actor（只允许 recruiter）；
//     2. 用**现有** `resolveFeishuConnector(config.feishu)` 装配的真实传输层（lark-cli 绝对路径 +
//        profile=recruitment）**只读**回读该 minute（`fetchTranscript()`；不写任何外部系统）；
//     3. 回读对象必须过 `evaluateLiveGate` 的**全部** LIVE 证据（平台通道 / 回执绑内容哈希 /
//        sha 与正文重算一致 / 二次重读哈希 / 带偏移 fetched_at / 完整 / 非空）；
//        证据不齐或自相矛盾 → fail-closed，**一行不写**（Fixture 只能做负例，不能算通过）；
//     4. 单事务里创建/复用 Meeting（provider=FEISHU、external_meeting_id=minute_token）
//        与 active `meeting_binding`（binding_method=MANUAL、bound_by_actor_id=当前人）；
//     5. 复用 `importTranscriptInTransaction()`（**不重写任何转写域规则**）写
//        transcript_artifact / transcript_segment / interview_record（LIVE/MANUAL/CONNECTED）；
//     6. 事务提交后**另开只读连接**独立 SQL 读回，响应里的 `db_readback` 只来自库（不是回显请求）；
//        并核对 artifact.content_sha256 与本次外部回读的 content_sha256 一致（不一致 = 500，不假装成功）。
//
// 为什么 Meeting 用 minute_token 做 external_meeting_id（诚实说明）：
//   本机 lark-cli 的 `minutes +detail --transcript` 信封只给 `minute_token`（`data.minutes[]`），
//   **不给** VC meeting id（`source_entity_id` 只在事件订阅里才有，F2 未实现）。所以这一版把
//   "一次妙记产物" 锚定成一条 meeting 行：platform-issued 的 minute_token 就是这条 meeting 的平台
//   ID（不是标题/时间猜出来的），产物行仍用 `feishu:minutes:<token>`。事件路径接入后，同一 minute
//   可用真实 meeting id 迁移/补绑；在此之前不做任何猜测。
//
// 边界（R7）：本文件只把 minute 的 id / 字节数 / sha256 / 回执写进响应与库；**不回显正文**、
// 不落盘正文、不打印 token 之外的凭据。失败一律在**碰写事务之前**拒绝（零写入）。
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
import { isUuid } from '../tools/contract.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import {
  FEISHU_MINUTES_CONNECTOR_ID,
  FEISHU_MINUTES_PROVIDER,
  resolveFeishuConnector,
  type FeishuConnectorConfig,
  type FeishuConnectorDependency,
} from '../connectors/feishu/index.ts'
import {
  importTranscriptInTransaction,
  resolveImportSource,
  type TranscriptImportSource,
  type TranscriptImportValue,
} from '../tools/transcript-import.ts'
import { sameOrigin } from './overview.ts'

// =====================================================================
//  契约常量（W2b UI 按 `work/d5/feishu/CONTRACT.md` 接按钮）
// =====================================================================

/** 本端点前缀（路由仍逐条 exact 注册；前缀只用于契约命名）。 */
const FEISHU_PREFIX = '/recruitment/api/feishu'
/** 唯一路由（exact）：POST 导入一场真实飞书 minute。 */
const IMPORT_PATH = `${FEISHU_PREFIX}/import`
/** action 名（响应 `action` 字段与错误 detail 的机检口径）。 */
const ACTION_NAME = 'feishu/import'
/** 允许调用本写动作的受控 alias（与 D-119 写动作同一口径：招聘动作属 Recruiter 职责）。 */
const ALLOWED_ALIASES = ['recruiter'] as const
/** 客户端**不许**覆盖的身份头（命中即 400，不碰 DB）。 */
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
/** 客户端**不许**出现在 query / body 的身份键（命中即 400，不碰 DB）。 */
const ACTOR_OVERRIDE_KEYS = ['actor_id', 'tenant_id'] as const
/** body 顶层允许的键（精确形状；其它键一律 400）。 */
const BODY_KEYS = ['interview_id', 'minute_token'] as const
/** 请求体上限：64 KiB（超限 413，零写入）。 */
const MAX_BODY_BYTES = 64 * 1024
/** minute_token 上界（与工具参数表一致）。 */
const MAX_MINUTE_TOKEN_LENGTH = 255
/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const
/** 连接器回读在 artifact 里使用的 provider_artifact_id 前缀（LIVE 证据齐全时；见 transcript-import.ts）。 */
const FEISHU_LIVE_ARTIFACT_PREFIX = 'feishu:minutes:'

/** 契约错误码 → HTTP 状态（未列出的 → 500；不许把内部异常当业务码）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  FORBIDDEN_ALIAS: 403,
  ACTOR_NOT_AUTHORIZED: 403,
  AUTH_REQUIRED: 403,
  MEETING_ALREADY_BOUND: 409,
  VERSION_CONFLICT: 409,
  BLOCKED: 409,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_CONFIGURED: 503,
  INTERNAL: 500,
}

// =====================================================================
//  宿主上下文 / 依赖（形状仿 `actor.ts` / `actions.ts`，W0 在 index.ts 接线）
// =====================================================================

/** 宿主侧用到的 `webServer` 最小面（与 overview/actor 的窄接口同形）。 */
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
export interface FeishuImportHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/**
 * `registerFeishuImportHttp` 的依赖。
 *
 * `feishuConfig` / `env` 是给 `resolveFeishuConnector()` 的**原样**入参（index.ts 直接透传
 * `config.feishu` 与 `apply` 的 `env`）：连接器只能由插件配置装配，本文件不读 PATH / 不猜路径。
 * `connectorOverride` 只给测试/负例注入（生产路径必须走 resolveFeishuConnector）。
 */
export interface FeishuImportDeps {
  /** 已解析数据库配置；`null` = 未配置（路由仍注册，503，不假装成功）。 */
  readonly database: ResolvedDatabaseConfig | null
  /** `database === null` 时缺失的配置项（只含变量名，不含密码）。 */
  readonly databaseIssues: readonly string[]
  /** session → alias 注册表 + alias → HUMAN actor 映射（由 `src/index.ts` 持有单例）。 */
  readonly identity: DemoActorIdentity
  /** 插件配置的 `feishu` 段（原样交给 `resolveFeishuConnector`）。 */
  readonly feishuConfig?: FeishuConnectorConfig
  /** `${ENV}` 展开与凭据存在性判断（默认 `process.env`；测试可注入）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 测试/负例注入的连接器依赖；生产为 undefined（走真实装配）。 */
  readonly connectorOverride?: FeishuConnectorDependency
  /** `connectorOverride` 的配置问题（只进 detail，不含值）。 */
  readonly connectorOverrideIssues?: readonly string[]
}

// =====================================================================
//  行类型
// =====================================================================

/** 面试（存在性 + 响应回显；与 `actor.ts::FormInterviewRow` 同源语义）。 */
interface InterviewRow {
  id: string
  application_id: string
  round_no: number
  stage_code: string
  status: string
}

/** actor 行快照（存在 / 同租户 / kind）。 */
interface ActorRow {
  actor_id: string
  kind: string
  display_name: string
}

/** Meeting 行（创建/复用后的读回）。 */
interface MeetingRow {
  id: string
  provider: string
  external_meeting_id: string | null
  meeting_role: string
}

/** active 绑定行。 */
interface BindingRow {
  binding_id: string
  interview_id: string
  meeting_id: string
  binding_method: string
  bound_by_actor_id: string | null
}

/** 事务内写结果（提交前在事务里得出；提交后再独立读回核对）。 */
interface WriteOutcome {
  readonly value: TranscriptImportValue
  readonly meeting: MeetingRow
  readonly binding: BindingRow
  readonly reusedMeeting: boolean
  readonly reusedBinding: boolean
}

/** 独立读回（提交后另开只读连接；不 import 任何产品读投影）。 */
interface DbReadback {
  readonly artifact: {
    readonly id: string
    readonly meeting_id: string
    readonly provider: string
    readonly provider_artifact_id: string
    readonly source_revision: number
    readonly transcript_status: string
    readonly content_sha256: string
    readonly raw_bytes: number
    readonly segment_count: number
    readonly is_canonical: boolean
    readonly provenance: string
    readonly trigger_mode: string
    readonly connection_state: string
    readonly fetched_at: string | null
  }
  readonly interview_record: {
    readonly id: string
    readonly status: string
    readonly verification_status: string
    readonly transcript_revision: number
    readonly evidence_ok: boolean
    readonly is_current: boolean
  } | null
  readonly meeting: MeetingRow
  readonly meeting_binding: BindingRow
  readonly read_at: string
}

/** 提交后独立读回的 current interview_record 行。 */
interface RecordReadbackRow {
  readonly id: string
  readonly status: string
  readonly verification_status: string
  readonly transcript_revision: number
  readonly evidence_ok: boolean
  readonly is_current: boolean
}

// =====================================================================
//  HTTP 小工具（封闭错误信封：`{error:{code,reason_code,message,detail?}}`）
// =====================================================================

/** 本文件自己产生的、可直接返回的 HTTP 问题。 */
class FeishuImportProblem extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'FeishuImportProblem'
    this.status = status
    this.body = body
  }
}

/** 造一个契约形状的 HTTP 问题。 */
function httpProblem(status: number, code: string, reasonCode: string, message: string, detail?: unknown): FeishuImportProblem {
  return new FeishuImportProblem(status, {
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
    throw httpProblem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > limit) {
      throw httpProblem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
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
    throw httpProblem(415, 'INVALID_ARGS', 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 Content-Type: application/json', {
      got: req.headers['content-type'] ?? '',
    })
  }
  const text = await readBody(req, MAX_BODY_BYTES)
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    throw httpProblem(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw httpProblem(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body' })
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
    throw httpProblem(
      403,
      'FORBIDDEN',
      'SAME_ORIGIN_REQUIRED',
      '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）',
    )
  }
}

/**
 * 读 `X-DSH-Session` 头并归一化（身份**有且只有**这个头；与 actor/actions 同一口径）。
 * @param req - node 请求。
 */
function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw httpProblem(
      400,
      'INVALID_ARGS',
      raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined
        ? '缺 x-dsh-session 请求头（身份只来自当前 DSH Session）'
        : 'x-dsh-session 必须是 session-<uuid> 或裸 UUID',
    )
  }
  return normalized
}

/** 拒绝 query / header 里的身份覆盖（结构上是商城，不碰 DB）。 */
function rejectQueryOrHeaderOverrides(req: IncomingMessage, url: URL): void {
  const rejected: string[] = []
  for (const key of ACTOR_OVERRIDE_KEYS) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  }
  if (rejected.length > 0) {
    throw httpProblem(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
      { rejected },
    )
  }
}

/** 解析失败消息 `<CODE>: <compact-json>`；不是产品错误形态 → null。 */
function parseProductError(error: unknown): Record<string, unknown> | null {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index <= 0) return null
  try {
    const parsed = JSON.parse(message.slice(index + 2)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 把任意错误翻成 HTTP 状态 + 封闭错误信封。
 *
 * 连接器/转写工具的 fail-closed 出口按**冻结口径**映射（见 CONTRACT.md §4）：
 *   * `TRANSPORT_NOT_CONFIGURED` / `NO_APP_CREDENTIALS` → 503 `NOT_CONFIGURED`（产品没有读的能力）；
 *   * `AUTH_REQUIRED` / `PROVIDER_NO_PERMISSION` → 403 `FORBIDDEN`（能连但没权限）；
 *   * `READBACK_INVALID` / 其它 BLOCKED → 409 `BLOCKED`（读到了但证据不成立 / 平台暂时失败）；
 *   * 参数类 → 400；找不到 → 404；其余 → 500。
 * @param error - 任意错误。
 */
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof FeishuImportProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const parsed = parseProductError(error)
  if (parsed !== null) {
    const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : 'INTERNAL'
    const reasonCode = typeof parsed.reason_code === 'string' ? parsed.reason_code : ''
    const detail = typeof parsed.detail === 'object' && parsed.detail !== null && !Array.isArray(parsed.detail)
      ? (parsed.detail as Record<string, unknown>)
      : undefined
    const errorCode = typeof detail?.error_code === 'string' ? detail.error_code : ''
    const line = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message

    if (code === 'INVALID_ARGS') {
      return {
        status: 400,
        body: { error: { code, reason_code: reasonCode || 'INVALID_ARGS', message: line, ...(detail === undefined ? {} : { detail }) } },
      }
    }
    if (code === 'NOT_FOUND') {
      return {
        status: 404,
        body: { error: { code, reason_code: reasonCode || 'NOT_FOUND', message: line, ...(detail === undefined ? {} : { detail }) } },
      }
    }
    if (code === 'NOT_CONFIGURED') {
      return {
        status: 503,
        body: { error: { code, reason_code: reasonCode || 'NOT_CONFIGURED', message: line, ...(detail === undefined ? {} : { detail }) } },
      }
    }
    if (code === 'BLOCKED') {
      const authRequired = reasonCode === 'AUTH_REQUIRED' || reasonCode === 'PROVIDER_NO_PERMISSION'
        || errorCode === 'AUTH_REQUIRED'
      const noCredentials = errorCode === 'NO_APP_CREDENTIALS' || reasonCode === 'NO_APP_CREDENTIALS'
      const transportMissing = reasonCode === 'TRANSPORT_NOT_CONFIGURED' || errorCode === 'TRANSPORT_NOT_CONFIGURED'
      if (transportMissing || noCredentials) {
        return {
          status: 503,
          body: {
            error: {
              code: 'NOT_CONFIGURED',
              reason_code: transportMissing ? 'TRANSPORT_NOT_CONFIGURED' : 'NO_APP_CREDENTIALS',
              message: line,
              ...(detail === undefined ? {} : { detail }),
            },
          },
        }
      }
      if (authRequired) {
        return {
          status: 403,
          body: { error: { code: 'FORBIDDEN', reason_code: 'AUTH_REQUIRED', message: line, ...(detail === undefined ? {} : { detail }) } },
        }
      }
      return {
        status: 409,
        body: { error: { code: 'BLOCKED', reason_code: reasonCode || 'CONNECTOR_BLOCKED', message: line, ...(detail === undefined ? {} : { detail }) } },
      }
    }
    // NO_MEETING_BOUND / AMBIGUOUS_MEETING 等在本路线上不该出现（我们自己建绑定）：
    // 出现即实现不自治，按 500 暴露而不是当业务码掩盖。
    return {
      status: STATUS_BY_CODE[code] ?? 500,
      body: { error: { code, reason_code: reasonCode || 'UNEXPECTED', message: line, ...(detail === undefined ? {} : { detail }) } },
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'INTERNAL'
  return { status: STATUS_BY_CODE[code] ?? 500, body: { error: { code, reason_code: 'UNEXPECTED', message } } }
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
//  身份 / 数据库读辅助
// =====================================================================

/** 未配置库时的 503（含缺失项；只含变量名，不含密码）。 */
function databaseNotConfigured(issues: readonly string[]): FeishuImportProblem {
  return httpProblem(503, 'NOT_CONFIGURED', 'DB_NOT_CONFIGURED', '数据库未配置，真实转写导入不可用', {
    issues: [...issues],
  })
}

/**
 * 在一个短连接池上执行 `fn`（HTTP 请求级；finally 关池，避免空闲 socket 挂住宿主）。
 * @param deps - 路由依赖。
 * @param fn - 拿到已解析配置与连接池。
 */
async function withDatabase<T>(
  deps: FeishuImportDeps,
  fn: (cfg: ResolvedDatabaseConfig, pool: DatabasePool) => Promise<T>,
): Promise<T> {
  if (deps.database === null) throw databaseNotConfigured(deps.databaseIssues)
  const cfg = deps.database
  const pool = createPool(cfg)
  try {
    return await fn(cfg, pool)
  } finally {
    await closePool(pool)
  }
}

/** 面试（不存在 → 404 `INTERVIEW_NOT_FOUND`；预检用，事务内会再查一次）。 */
const INTERVIEW_SQL = `
  select i.id::text             as id,
         i.application_id::text as application_id,
         i.round_no             as round_no,
         i.stage_code           as stage_code,
         i.status               as status
    from recruitment.interview i
   where i.id = $1::uuid and i.tenant_id = $2::uuid
`

/** actor 行（存在 / 同租户 / kind）。 */
const ACTOR_SQL = `
  select a.id::text as actor_id, a.kind as kind, a.display_name as display_name
    from recruitment.actor a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/** 按平台标识找 meeting（`uq_meeting_external` 的同一口径）。 */
const MEETING_BY_EXTERNAL_SQL = `
  select id::text as id, provider, external_meeting_id, meeting_role
    from recruitment.meeting
   where tenant_id = $1::uuid and provider = $2 and external_meeting_id = $3
`

/** 一条 meeting 的 active 绑定（`uq_meeting_binding_active` 保证至多一条）。 */
const ACTIVE_BINDING_SQL = `
  select b.id::text as binding_id, b.interview_id::text as interview_id, b.meeting_id::text as meeting_id,
         b.binding_method, b.bound_by_actor_id::text as bound_by_actor_id
    from recruitment.meeting_binding b
   where b.tenant_id = $1::uuid and b.meeting_id = $2::uuid and b.unbound_at is null
`

/** 提交后独立读回：artifact（含 raw_text 的真实字节数与 segment 数；不取正文）。 */
const ARTIFACT_READBACK_SQL = `
  select ta.id::text                      as id,
         ta.meeting_id::text              as meeting_id,
         ta.provider                      as provider,
         ta.provider_artifact_id          as provider_artifact_id,
         ta.source_revision               as source_revision,
         ta.transcript_status             as transcript_status,
         ta.provenance                    as provenance,
         ta.trigger_mode                  as trigger_mode,
         ta.connection_state              as connection_state,
         ta.content_sha256                as content_sha256,
         octet_length(ta.raw_text)        as raw_bytes,
         ta.is_canonical                  as is_canonical,
         ta.fetched_at                    as fetched_at,
         (select count(*)::int from recruitment.transcript_segment ts
           where ts.tenant_id = ta.tenant_id and ts.artifact_id = ta.id) as segment_count
    from recruitment.transcript_artifact ta
   where ta.id = $1::uuid and ta.tenant_id = $2::uuid
`

/** 提交后独立读回：该面试当前 interview_record（只取回显列）。 */
const CURRENT_RECORD_SQL = `
  select r.id::text                       as id,
         r.status                         as status,
         r.verification_status            as verification_status,
         r.transcript_revision            as transcript_revision,
         r.evidence_ok                    as evidence_ok,
         r.is_current                     as is_current
    from recruitment.interview_record r
   where r.tenant_id = $1::uuid and r.interview_id = $2::uuid and r.is_current
   order by r.created_at desc, r.id
   limit 1
`

/** 时间统一成 ISO-8601（pg 可能给 Date 或字符串）。 */
function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** pg 的 count/bigint 以字符串返回：统一转数字。 */
function toCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

/** 读面试（预检 / 事务内复检）；不存在 → 404。 */
async function loadInterviewOrFail(client: DatabaseClient, tenantId: string, interviewId: string): Promise<InterviewRow> {
  const { rows } = await client.query<InterviewRow>(INTERVIEW_SQL, [interviewId, tenantId])
  const row = rows[0]
  if (row === undefined) {
    throw httpProblem(404, 'NOT_FOUND', 'INTERVIEW_NOT_FOUND', '该租户下没有这场面试', { interview_id: interviewId })
  }
  return row
}

/** 读 actor 并断言是 HUMAN（Demo Actor 只投影给人）。 */
async function loadHumanActorOrFail(client: DatabaseClient, tenantId: string, actorId: string): Promise<ActorRow> {
  const { rows } = await client.query<ActorRow>(ACTOR_SQL, [actorId, tenantId])
  const row = rows[0]
  if (row === undefined) {
    throw httpProblem(409, 'DEMO_ACTOR_UNMAPPED', 'ACTOR_ROW_MISSING', 'alias 映射的 actor 在库里不存在或不属于该租户（fail-closed）', {
      actor_id: actorId,
    })
  }
  if (row.kind !== 'HUMAN') {
    throw httpProblem(403, 'FORBIDDEN', 'ACTOR_NOT_HUMAN', `Demo Actor alias 只能映射到 HUMAN actor（实际 kind=${row.kind}）`, {
      actor_id: row.actor_id,
      kind: row.kind,
    })
  }
  return row
}

// =====================================================================
//  连接器 / 回读证据（真实只读；发生在任何写事务之前）
// =====================================================================

/** 装配连接器：测试注入优先；否则**只能**由插件配置经 `resolveFeishuConnector` 装配。 */
function resolveConnector(deps: FeishuImportDeps): {
  connector?: FeishuConnectorDependency
  issues: readonly string[]
} {
  if (deps.connectorOverride !== undefined) {
    return { connector: deps.connectorOverride, issues: deps.connectorOverrideIssues ?? [] }
  }
  const resolved = resolveFeishuConnector(deps.feishuConfig ?? {}, deps.env ?? process.env)
  return { connector: resolved.connector, issues: resolved.issues }
}

/**
 * 回读 + LIVE 证据闸门（**写事务之前**）。失败一律抛错（= 零写入）。
 *
 * 为什么在工具之外再卡一道 LIVE：产品入口的语义是"导入真实转写"，不是"导入一段字节"。
 * 工具可以诚实降级成 FIXTURE（并清楚标注）；本产品入口**只接受通过全部 LIVE 证据的回读**，
 * 否则宁可失败也不把 Fixture 写成 READY（R4 / D-1 A 口径）。
 * @param args - 已校验的 `{interview_id, minute_token}`。
 * @param connector - 已装配连接器（undefined = 默认态）。
 * @param issues - 装配问题（只进 detail）。
 */
async function readLiveSource(
  args: Record<string, unknown>,
  connector: FeishuConnectorDependency | undefined,
  issues: readonly string[],
): Promise<TranscriptImportSource> {
  const source = await resolveImportSource(args, connector, issues)
  if (source.mode !== 'CONNECTOR_READBACK') {
    // 本端点的入参只有 minute_token，不可能走人工正文路径；出现即实现错误。
    throw httpProblem(500, 'INTERNAL', 'SOURCE_MODE_UNEXPECTED', '内部错误：真实导入只允许连接器回读来源', {
      mode: source.mode,
    })
  }
  if (source.liveGate.gate !== 'LIVE') {
    const connection = source.labels.connection
    const violations = [...source.liveGate.violations]
    const detail = {
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      connector_result: 'READ_NOT_LIVE',
      connection_state: connection,
      violations,
      creates_artifact: false,
    }
    if (connection === 'AUTH_REQUIRED') {
      throw httpProblem(
        403,
        'FORBIDDEN',
        'AUTH_REQUIRED',
        '飞书连接器读到字节，但证据不足以构成 LIVE 回读（连接态=AUTH_REQUIRED）：'
          + `缺 ${violations.join('；')}。本入口只接受证据齐全的真实转写，未写任何行。`,
        detail,
      )
    }
    throw httpProblem(
      409,
      'BLOCKED',
      'READBACK_INVALID',
      '飞书回读未通过 LIVE 证据闸门（缺项见 detail.violations）：本入口只接受证据齐全的真实转写，'
        + 'Fixture/不完整回读不能算通过，未写任何行。',
      detail,
    )
  }
  return source
}

// =====================================================================
//  Meeting / 绑定 的创建或复用（单事务；失败整体回滚 = 零写入）
// =====================================================================

/** pg 唯一键冲突（`23505`）。 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

/**
 * 找到或创建 meeting（`(tenant, provider, external_meeting_id)` 命中即复用；并发插入撞 23505 再读）。
 * @param client - 写事务内客户端（recruitment.actor_id 已设置）。
 * @param tenantId - 租户（来自服务端配置）。
 * @param minuteToken - 平台 minute_token（本版作为 meeting 的平台标识，见文件头）。
 */
async function ensureMeeting(
  client: DatabaseClient,
  tenantId: string,
  minuteToken: string,
): Promise<{ meeting: MeetingRow; reused: boolean }> {
  const found = await client.query<MeetingRow>(MEETING_BY_EXTERNAL_SQL, [tenantId, FEISHU_MINUTES_PROVIDER, minuteToken])
  const existing = found.rows[0]
  if (existing !== undefined) return { meeting: existing, reused: true }

  await client.query('savepoint feishu_meeting_insert')
  try {
    const inserted = await client.query<MeetingRow>(
      `insert into recruitment.meeting (tenant_id, provider, account_scope, external_meeting_id, meeting_role)
       values ($1::uuid, $2, null, $3, 'PRIMARY')
       returning id::text as id, provider, external_meeting_id, meeting_role`,
      [tenantId, FEISHU_MINUTES_PROVIDER, minuteToken],
    )
    const row = inserted.rows[0]
    if (row === undefined) throw new Error('meeting INSERT 未返回行')
    await client.query('release savepoint feishu_meeting_insert')
    return { meeting: row, reused: false }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    // 并发插入：回滚到插入前，再按唯一键读回那一行（不重复建、不覆盖）。
    await client.query('rollback to savepoint feishu_meeting_insert')
    const again = await client.query<MeetingRow>(MEETING_BY_EXTERNAL_SQL, [tenantId, FEISHU_MINUTES_PROVIDER, minuteToken])
    const row = again.rows[0]
    if (row === undefined) throw error
    return { meeting: row, reused: true }
  }
}

/**
 * 找到或创建该 meeting 的 active 绑定。
 *
 * 已绑到**别的面试** → 409 `MEETING_ALREADY_BOUND`（一行不写；解绑是人的动作，本端点不越权）。
 * @param client - 写事务内客户端。
 * @param tenantId - 租户。
 * @param meetingId - meeting 行 id。
 * @param interviewId - 目标面试 id。
 * @param actorId - 绑定人（`binding_method=MANUAL` 必填，库约束 `ck_meeting_binding_manual_actor`）。
 */
async function ensureBinding(
  client: DatabaseClient,
  tenantId: string,
  meetingId: string,
  interviewId: string,
  actorId: string,
): Promise<{ binding: BindingRow; reused: boolean }> {
  const found = await client.query<BindingRow>(ACTIVE_BINDING_SQL, [tenantId, meetingId])
  const existing = found.rows[0]
  if (existing !== undefined) {
    if (existing.interview_id !== interviewId) {
      throw httpProblem(
        409,
        'MEETING_ALREADY_BOUND',
        'MEETING_ALREADY_BOUND',
        '该飞书 minute 对应的会议已绑定到另一场面试：不夺权、不自动改绑（需人先解绑），本次未写入任何行',
        { meeting_id: meetingId, bound_interview_id: existing.interview_id, requested_interview_id: interviewId },
      )
    }
    return { binding: existing, reused: true }
  }

  await client.query('savepoint feishu_binding_insert')
  try {
    const inserted = await client.query<BindingRow>(
      `insert into recruitment.meeting_binding (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
       values ($1::uuid, $2::uuid, $3::uuid, 'MANUAL', $4::uuid)
       returning id::text as binding_id, interview_id::text as interview_id, meeting_id::text as meeting_id,
                 binding_method, bound_by_actor_id::text as bound_by_actor_id`,
      [tenantId, meetingId, interviewId, actorId],
    )
    const row = inserted.rows[0]
    if (row === undefined) throw new Error('meeting_binding INSERT 未返回行')
    await client.query('release savepoint feishu_binding_insert')
    return { binding: row, reused: false }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    await client.query('rollback to savepoint feishu_binding_insert')
    const again = await client.query<BindingRow>(ACTIVE_BINDING_SQL, [tenantId, meetingId])
    const row = again.rows[0]
    if (row === undefined) throw error
    if (row.interview_id !== interviewId) {
      throw httpProblem(
        409,
        'MEETING_ALREADY_BOUND',
        'MEETING_ALREADY_BOUND',
        '并发下该会议被绑定到另一场面试：不夺权、不自动改绑，本次未写入任何行',
        { meeting_id: meetingId, bound_interview_id: row.interview_id, requested_interview_id: interviewId },
      )
    }
    return { binding: row, reused: true }
  }
}

// =====================================================================
//  事务内实现（复用 transcript_import 域路径；所有写入在同一事务里）
// =====================================================================

/**
 * 在调用方给定的事务里完成：Meeting/绑定 ensure → 复用 `importTranscriptInTransaction` 写转写。
 *
 * 任何一步失败→抛错→外层 `withActor` 回滚，**meeting/binding/artifact/segment/record 全部不落库**
 *（这也让"回读证据不成立"不会留下半条绑定）。
 * @param client - 写事务内客户端（GUC actor 已设置）。
 * @param writeCfg - 写配置（tenant / actor 只来自服务端解析）。
 * @param interviewId - 目标面试。
 * @param minuteToken - 平台 minute_token。
 * @param source - 已通过 LIVE 闸门的回读来源（不会二次读外部）。
 */
async function importInTransaction(
  client: DatabaseClient,
  writeCfg: ResolvedDatabaseConfig,
  interviewId: string,
  minuteToken: string,
  source: TranscriptImportSource,
): Promise<WriteOutcome> {
  const tenantId = writeCfg.tenant_id
  const actorId = writeCfg.actor_id
  // 事务内复检面试（预检之后数据可能变了；不复检就会出现"给不存在的面试建会议"）。
  await loadInterviewOrFail(client, tenantId, interviewId)
  await loadHumanActorOrFail(client, tenantId, actorId)

  const ensured = await ensureMeeting(client, tenantId, minuteToken)
  const bound = await ensureBinding(client, tenantId, ensured.meeting.id, interviewId, actorId)

  const value = await importTranscriptInTransaction(
    client,
    writeCfg,
    { interview_id: interviewId, minute_token: minuteToken, meeting_id: ensured.meeting.id },
    undefined,
    { source },
  )

  // 写事务内自检（仍然在事务里：抛错 = 回滚 = 零写入，不会留下半条链）。
  const labels = value.labels
  if (labels.provenance !== 'LIVE' || labels.trigger !== 'MANUAL' || labels.connection !== 'CONNECTED') {
    throw httpProblem(
      500,
      'INTERNAL',
      'LABELS_NOT_LIVE',
      '内部一致性错误：回读已过 LIVE 闸门，但转写工具落库标签不是 LIVE/MANUAL/CONNECTED；本次事务回滚，未写入任何行',
      { labels: { ...labels } },
    )
  }
  const expectedSha = source.readback.content_sha256
  if (value.artifact.content_sha256 !== expectedSha) {
    throw httpProblem(
      409,
      'BLOCKED',
      'READBACK_INVALID',
      '回读对象与落库 artifact 的 content_sha256 不一致（回读不自洽）：本次事务回滚，未写入任何行',
      { connector_content_sha256: expectedSha, artifact_content_sha256: value.artifact.content_sha256, creates_artifact: false },
    )
  }
  const providerArtifactId = value.artifact.provider_artifact_id
  if (typeof providerArtifactId !== 'string' || !providerArtifactId.startsWith(FEISHU_LIVE_ARTIFACT_PREFIX)) {
    throw httpProblem(500, 'INTERNAL', 'ARTIFACT_IDENTITY_UNEXPECTED', '内部错误：LIVE 产物的 provider_artifact_id 前缀不对', {
      provider_artifact_id: typeof providerArtifactId === 'string' ? providerArtifactId : null,
    })
  }

  return {
    value,
    meeting: ensured.meeting,
    binding: bound.binding,
    reusedMeeting: ensured.reused,
    reusedBinding: bound.reused,
  }
}

// =====================================================================
//  提交后独立只读读回（响应事实只来自这里 + 本次外部回读证据）
// =====================================================================

/**
 * 独立只读读回（另开只读事务；不 import 任何产品读投影）。
 * @param pool - 连接池。
 * @param cfg - 已解析配置（tenant / actor 只从这里来）。
 * @param interviewId - 目标面试。
 * @param outcome - 写事务的结果（只取 id / 绑定 id 作为查询键）。
 */
async function readBack(
  pool: DatabasePool,
  cfg: ResolvedDatabaseConfig,
  interviewId: string,
  outcome: WriteOutcome,
): Promise<DbReadback> {
  const tenantId = cfg.tenant_id
  const artifactId = outcome.value.artifact.id
  return await withReadOnly(pool, async (client) => {
    const artifacts = await client.query<{
      id: string
      meeting_id: string
      provider: string
      provider_artifact_id: string
      source_revision: number
      transcript_status: string
      provenance: string
      trigger_mode: string
      connection_state: string
      content_sha256: string
      raw_bytes: number | string
      is_canonical: boolean
      fetched_at: Date | string | null
      segment_count: number | string
    }>(ARTIFACT_READBACK_SQL, [artifactId, tenantId])
    const artifact = artifacts.rows[0]
    if (artifact === undefined) {
      throw httpProblem(500, 'INTERNAL', 'READBACK_MISSING', '写事务已提交但独立读回不到该 artifact 行（数据异常，请人工核查）', {
        artifact_id: artifactId,
      })
    }
    const records = await client.query<RecordReadbackRow>(CURRENT_RECORD_SQL, [tenantId, interviewId])
    const meetings = await client.query<MeetingRow>(MEETING_BY_EXTERNAL_SQL, [
      tenantId,
      FEISHU_MINUTES_PROVIDER,
      outcome.meeting.external_meeting_id,
    ])
    const meeting = meetings.rows[0]
    if (meeting === undefined) {
      throw httpProblem(500, 'INTERNAL', 'READBACK_MISSING', '独立读回不到 meeting 行（数据异常）', {
        meeting_id: outcome.meeting.id,
      })
    }
    const bindings = await client.query<BindingRow>(ACTIVE_BINDING_SQL, [tenantId, outcome.meeting.id])
    const binding = bindings.rows[0]
    if (binding === undefined) {
      throw httpProblem(500, 'INTERNAL', 'READBACK_MISSING', '独立读回不到 active 绑定行（数据异常）', {
        meeting_id: outcome.meeting.id,
      })
    }
    return {
      artifact: {
        id: artifact.id,
        meeting_id: artifact.meeting_id,
        provider: artifact.provider,
        provider_artifact_id: artifact.provider_artifact_id,
        source_revision: artifact.source_revision,
        transcript_status: artifact.transcript_status,
        content_sha256: artifact.content_sha256,
        raw_bytes: toCount(artifact.raw_bytes),
        segment_count: toCount(artifact.segment_count),
        is_canonical: artifact.is_canonical,
        provenance: artifact.provenance,
        trigger_mode: artifact.trigger_mode,
        connection_state: artifact.connection_state,
        fetched_at: iso(artifact.fetched_at),
      },
      interview_record: records.rows[0] === undefined
        ? null
        : {
          id: records.rows[0].id,
          status: records.rows[0].status,
          verification_status: records.rows[0].verification_status,
          transcript_revision: records.rows[0].transcript_revision,
          evidence_ok: records.rows[0].evidence_ok,
          is_current: records.rows[0].is_current,
        },
      meeting: meeting,
      meeting_binding: binding,
      read_at: new Date().toISOString(),
    }
  })
}

// =====================================================================
//  body 校验（纯函数）
// =====================================================================

/**
 * 解析 + 校验 `{interview_id, minute_token}`（形状/未知键/身份键/UUID/token 字符）。
 * @param body - 已解析 JSON body。
 * @returns 规范化后的两字段。
 */
function parseImportBody(body: Record<string, unknown>): { interviewId: string; minuteToken: string } {
  const rejected = ACTOR_OVERRIDE_KEYS.filter((key) => Object.hasOwn(body, key)).map((key) => `body.${key}`)
  if (rejected.length > 0) {
    throw httpProblem(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
      { rejected },
    )
  }
  const unknown = Object.keys(body).filter((key) => !(BODY_KEYS as readonly string[]).includes(key)).sort()
  if (unknown.length > 0) {
    throw httpProblem(
      400,
      'INVALID_ARGS',
      'UNKNOWN_PARAM',
      `未声明的键 "${unknown[0]}"（允许：${BODY_KEYS.join(', ')}）`,
      { unknown, allowed: [...BODY_KEYS] },
    )
  }
  const missing = BODY_KEYS.filter((key) => !Object.hasOwn(body, key))
  if (missing.length > 0) {
    throw httpProblem(400, 'INVALID_ARGS', 'MISSING_REQUIRED', `缺必填字段 ${missing.join(', ')}`, { missing })
  }
  const interviewId = body.interview_id
  if (typeof interviewId !== 'string' || !isUuid(interviewId)) {
    throw httpProblem(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'interview_id 必须是 UUID 文本', { field: 'interview_id' })
  }
  const minuteTokenRaw = body.minute_token
  if (typeof minuteTokenRaw !== 'string' || minuteTokenRaw.trim() === '') {
    throw httpProblem(400, 'INVALID_ARGS', 'TYPE_MISMATCH', 'minute_token 必须是非空字符串', { field: 'minute_token' })
  }
  const minuteToken = minuteTokenRaw.trim()
  if (minuteToken.length > MAX_MINUTE_TOKEN_LENGTH) {
    throw httpProblem(400, 'INVALID_ARGS', 'OUT_OF_RANGE', `minute_token 不得超过 ${MAX_MINUTE_TOKEN_LENGTH} 字符`, {
      minute_token_length: minuteToken.length,
    })
  }
  // 回执形态 `lark:minutes+detail:<token>@sha256:<hex>`：token 里出现 @ / 换行会让回执不可解析
  //（工具层还有一道同样的自检；这里是更早的一道）。
  if (minuteToken.includes('@') || /[\r\n]/.test(minuteToken)) {
    throw httpProblem(400, 'INVALID_ARGS', 'OUT_OF_RANGE', 'minute_token 不得含 "@" 或换行（会破坏读取回执）', {
      minute_token_length: minuteToken.length,
    })
  }
  return { interviewId, minuteToken }
}

// =====================================================================
//  路由处理
// =====================================================================

/**
 * `POST /recruitment/api/feishu/import`：真实飞书 minute → Meeting 绑定 → Transcript READY。
 *
 * 顺序即纪律（每一步都在"更贵/更脏"的动作之前 fail-closed）：
 *   同源 → 方法 → session/alias/授权 → body → 库/连接器配置 → 只读预检（面试/人名）→
 *   外部只读回读 + LIVE 闸门 → 单事务（Meeting/绑定 + 转写写入）→ 提交 → 独立只读读回 → 200。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleImport(deps: FeishuImportDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // ---- 1 身份（x-dsh-session 是唯一来源）----
  const sessionId = readSessionHeader(req)
  let resolved: ResolvedExecutionActor
  try {
    resolved = resolveSessionActor(deps.identity, sessionId)
  } catch (error) {
    const parsed = parseProductError(error)
    const reason = typeof parsed?.reason_code === 'string' ? parsed.reason_code : 'SESSION_NOT_BOUND'
    throw httpProblem(409, 'DEMO_ACTOR_UNMAPPED', reason, '当前 session 未绑定 Demo Actor alias（先 PUT /recruitment/api/actor）', {
      session_id: sessionId,
    })
  }
  if (!(ALLOWED_ALIASES as readonly string[]).includes(resolved.alias)) {
    throw httpProblem(403, 'FORBIDDEN', 'ACTOR_NOT_AUTHORIZED', '真实转写导入是招聘操作，只允许 recruiter alias 调用', {
      alias: resolved.alias,
      allowed: [...ALLOWED_ALIASES],
    })
  }

  // ---- 2 body 形状（未知键/身份键/缺参/UUID/token 字符）----
  const body = await readJsonObject(req)
  const { interviewId, minuteToken } = parseImportBody(body)

  // ---- 3 配置（库 / 连接器）----
  if (deps.database === null) throw databaseNotConfigured(deps.databaseIssues)
  const database = deps.database
  const { connector, issues } = resolveConnector(deps)
  if (connector === undefined || connector.transport_configured !== true) {
    throw httpProblem(
      503,
      'NOT_CONFIGURED',
      'TRANSPORT_NOT_CONFIGURED',
      '飞书连接器没有装配传输层：插件配置缺 config.feishu.cli（lark-cli 绝对路径）/ profile，'
        + '本入口默认不拉起任何子进程、不读正文、不写任何行',
      { connector: FEISHU_MINUTES_CONNECTOR_ID, issues: [...issues], transport_configured: false },
    )
  }

  // ---- 4 只读预检（面试存在 / 当前人是 HUMAN；不碰任何写）----
  const writeCfg: ResolvedDatabaseConfig = { ...database, actor_id: resolved.actor_id }
  await withDatabase(deps, async (cfg, pool) => {
    await withReadOnly(pool, async (client) => {
      await loadInterviewOrFail(client, cfg.tenant_id, interviewId)
      await loadHumanActorOrFail(client, cfg.tenant_id, resolved.actor_id)
    })
  })

  // ---- 5 外部只读回读 + LIVE 闸门（在任何写事务之前；失败 = 零写入）----
  const source = await readLiveSource({ interview_id: interviewId, minute_token: minuteToken }, connector, issues)

  // ---- 6 单事务：Meeting/绑定 + 转写写入（复用域路径）----
  const outcome = await withDatabase(deps, async (cfg, pool) => {
    const writeConfig: ResolvedDatabaseConfig = { ...cfg, actor_id: resolved.actor_id }
    return await withActor(pool, resolved.actor_id, async (client) =>
      importInTransaction(client, writeConfig, interviewId, minuteToken, source))
  })

  // ---- 7 提交后独立只读读回（响应事实只来自库 + 外部回读证据）----
  const outcomeForReadback = outcome
  const readback = await withDatabase(deps, async (cfg, pool) =>
    readBack(pool, { ...cfg, actor_id: resolved.actor_id }, interviewId, outcomeForReadback))

  // 独立读回与本次外部回读证据必须一致（不一致 = 不假装成功；写已提交，按 500 暴露并留证据）。
  if (readback.artifact.content_sha256 !== source.readback.content_sha256) {
    throw httpProblem(
      500,
      'INTERNAL',
      'READBACK_INVALID',
      '独立读回的 artifact.content_sha256 与本次飞书回读不一致：数据异常，需人工核查',
      {
        connector_content_sha256: source.readback.content_sha256,
        artifact_content_sha256: readback.artifact.content_sha256,
        artifact_id: readback.artifact.id,
      },
    )
  }
  const expectedProviderArtifactId = `${FEISHU_LIVE_ARTIFACT_PREFIX}${minuteToken}`
  if (readback.artifact.provider_artifact_id !== expectedProviderArtifactId) {
    throw httpProblem(
      500,
      'INTERNAL',
      'READBACK_INVALID',
      '独立读回的 provider_artifact_id 与 minute_token 不一致：数据异常，需人工核查',
      { provider_artifact_id: readback.artifact.provider_artifact_id, minute_token: minuteToken },
    )
  }
  if (readback.interview_record !== null) {
    if (outcome.value.record === undefined || readback.interview_record.id !== outcome.value.record.id) {
      throw httpProblem(
        500,
        'INTERNAL',
        'READBACK_INVALID',
        '独立读回的 current interview_record 与写事务结果不一致：数据异常，需人工核查',
        { readback_record_id: readback.interview_record.id, written_record_id: outcome.value.record?.id ?? null },
      )
    }
  }

  const artifact = outcome.value.artifact
  const response: Record<string, unknown> = {
    action: ACTION_NAME,
    status: 'READY',
    transcript_status: 'READY',
    labels: {
      provenance: source.labels.provenance,
      trigger: source.labels.trigger,
      connection: source.labels.connection,
    },
    actor: { session_id: resolved.session_id, alias: resolved.alias, actor_id: resolved.actor_id },
    interview: {
      id: outcome.value.interview.id,
      application_id: outcome.value.interview.application_id,
      round_no: outcome.value.interview.round_no,
      stage_code: outcome.value.interview.stage_code,
      status: outcome.value.interview.status,
    },
    meeting: {
      id: outcome.meeting.id,
      provider: outcome.meeting.provider,
      external_meeting_id: outcome.meeting.external_meeting_id,
      meeting_role: outcome.meeting.meeting_role,
      binding_id: outcome.binding.binding_id,
      binding_method: outcome.binding.binding_method,
      reused_meeting: outcome.reusedMeeting,
      reused_binding: outcome.reusedBinding,
    },
    minutes: {
      minute_token: source.readback.minute_token,
      content_sha256: source.readback.content_sha256,
      file_bytes: source.readback.file_bytes,
      chars: source.content.length,
      fetched_at: source.readback.fetched_at,
      read_receipt_ref: source.readback.read_receipt_ref,
      transport: source.readback.transport,
      is_complete: source.readback.is_complete,
      ...(source.readback.reread_sha256 === undefined ? {} : { reread_sha256: source.readback.reread_sha256 }),
    },
    artifact: {
      id: artifact.id,
      meeting_id: artifact.meeting_id,
      provider: artifact.provider,
      provider_artifact_id: artifact.provider_artifact_id,
      source_revision: artifact.source_revision,
      transcript_status: artifact.transcript_status,
      content_sha256: artifact.content_sha256,
      bytes: source.readback.file_bytes,
      char_count: artifact.char_count,
      segment_count: artifact.segment_count,
      is_canonical: artifact.is_canonical,
      replayed: outcome.value.replayed,
    },
    changes: outcome.value.changes,
    db_readback: readback,
  }
  if (outcome.value.record !== undefined) response.record = outcome.value.record
  json(res, 200, response)
}

// =====================================================================
//  注册入口
// =====================================================================

/** 回环地址判据（只接受 127.0.0.1 / ::1；其余地址不注册路由）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/**
 * 注册真实飞书转写导入路由；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警（fail-closed：宁可面板没入口，也不把"拉真实外部 CLI"的写动作
 * 挂到网络可达地址上）。路由是 exact `/recruitment/api/feishu/import`。
 * @param ctx - 宿主上下文（含 webServer 服务）。
 * @param deps - 库配置 + Demo Actor 身份 + 插件 feishu 配置。
 * @returns 注销函数。
 */
export function registerFeishuImportHttp(ctx: FeishuImportHostContext, deps: FeishuImportDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 飞书转写导入路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const handler = guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    assertSameOrigin(req, port)
    rejectQueryOrHeaderOverrides(req, url)
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await handleImport(deps, req, res)
  })
  return webServer.register({ kind: 'exact', path: IMPORT_PATH, handler })
}
