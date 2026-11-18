// D5 写操作 Host Remote Action（D-119：P0/P1/P2 全部接，不是只读）。
//
// 独立前缀 `/recruitment/api/action`（**不能**复用 `/recruitment/api`：`overview.ts` 已注册该
// 前缀，webServer 对重复 `(kind,path)` 直接 throw；本文件只注册 exact path，见 registerActionsHttp）。
//
// 冻结契约：`work/d5/ACTOR-CONTRACT.md` §2/§3、`work/d5/actions/CONTRACT.md`（本 lane 冻结的
// UI body/错误码契约）、`docs/17` D-119。
//
// 身份（与 W1 的 `/recruitment/api/actor`、写工具**同一套**）：
//   `x-dsh-session`（UUID 形态，同源 loopback 请求才有）
//     → `resolveSessionActor(identity, session_id)`（W1 的**同一个** registry 单例）
//     → alias（recruiter / interviewer_a / interviewer_b）→ 数据库 HUMAN actor UUID。
//   body / query / header 里的 `actor_id` / `tenant_id` 一律 400（身份只来自服务端绑定）：
//   D-33 / IR-M4d 的既有口径，与 `http/actor.ts` 完全一致。
//
// 每个端点都**复用现有工具工厂**（`createDecisionRecordTool` / `createStageAdvanceTool` /
// `createInterviewScheduleTool` / `createTranscriptImportTool` / `createJobRubricApproveTool` /
// `createConfig*Tool`）：参数校验、领域规则、事务、幂等、approval 位置全部仍在那份实现里，
// 本文件只做 ① HTTP 形状 ② 身份/同源/越权闸门 ③ 「人类点击 = allow-once approval」适配
// ④ 写后**独立 DB 读回**。**不重写任何业务规则**。
//
// 为什么「人类点击 = allow-once approval provider」而不是调用 DSH 真 approval：
//   本文件是 Host 人工动作（浏览器页面里人点的按钮）的执行入口；批准通道是进程内的、只属于
//   这一次 HTTP 请求的 allow-once 闸门（第一次 request 返回 `allowed-once`，第二次一律
//   `rejected` fail-closed）。DSH 的 `ctx.approval` 仍然只服务 Agent 工具路径（D-79），本文件
//   不注册、不冒充它——Agent 无法通过本文件取得任何批准（本文件路由只认 `x-dsh-session` 且
//   要求该 session 已由浏览器 PUT 绑定 alias；Agent 进程调不到同源 loopback HTTP）。
//
// fail-closed（全部在**碰 DB 之前**）：
//   * 非回环 host → 不注册任何路由；
//   * 缺/非法 `x-dsh-session` → 400；session 未绑定 alias → 409 `DEMO_ACTOR_UNMAPPED`；
//   * alias 不在该动作的授权 alias 集合（当前只有 `recruiter`）→ 403 `FORBIDDEN(ACTOR_NOT_AUTHORIZED)`；
//   * body 带 actor/tenant 或服务端派生键 → 400 `ACTOR_OVERRIDE_REJECTED`；
//   * 数据库未配置 → 503（不假装成功）。
//
// 响应：每个成功动作都返回 `{action, actor, approval, result, readback}`：
//   * `result` = 被复用工具的原样输出（领域事实 + 标签）；
//   * `readback` = 写事务提交后**另开只读连接独立 SQL 读回**的库行（不是回显请求、不是工具自述），
//     至少含对象 id / status（有该列的表）/ record_version / actor_id；各动作字段见 CONTRACT.md。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

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
import type { ReadonlyToolDefinition } from '../tools/definition.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorAlias,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'
import { confirmationTextSha256, createDecisionRecordTool, parseDecisionArgs } from '../tools/decision-record.ts'
import { createStageAdvanceTool } from '../tools/stage-advance.ts'
import { makeApprovalRequest, scheduleInTransaction, type ApprovalDecision } from '../tools/interview-schedule.ts'
import { createTranscriptImportTool, type TranscriptImportDeps } from '../tools/transcript-import.ts'
import { createJobRubricApproveTool } from '../tools/job-rubric-approve.ts'
import { createConfigRoleTool } from '../tools/config-role.ts'
import { createConfigTeamTool } from '../tools/config-team.ts'
import { createConfigPipelineTool } from '../tools/config-pipeline.ts'
import { sha256Text } from '../domain/criterion-override.ts'
import { insertScheduleUndoOriginal } from '../db/undo-log.ts'
import {
  ensureActiveApplication,
  loadJob,
  resolvePinnableRubricVersion,
} from '../tools/application-intake.ts'
import {
  insertCarryOverRefs,
  parseCarryOverRefs,
  validateCarryOverRefs,
} from '../db/carry-over.ts'
import { createCandidateConstraintTool } from '../tools/candidate-constraint.ts'
import { createJobCreateTool } from '../tools/job-create.ts'

// =====================================================================
//  契约常量
// =====================================================================

/** 独立前缀（见文件头；exact path 逐个注册）。 */
const ACTION_PREFIX = '/recruitment/api/action'

/** 端点 → exact path（路径是契约，UI 按此 POST）。 */
const ACTION_PATHS = {
  screeningDecide: `${ACTION_PREFIX}/screening/decide`,
  decisionRecord: `${ACTION_PREFIX}/decision/record`,
  stageAdvance: `${ACTION_PREFIX}/stage/advance`,
  interviewSchedule: `${ACTION_PREFIX}/interview/schedule`,
  transcriptImport: `${ACTION_PREFIX}/transcript/import`,
  rubricApprove: `${ACTION_PREFIX}/job/rubric-approve`,
  configRole: `${ACTION_PREFIX}/config/role`,
  configTeam: `${ACTION_PREFIX}/config/team`,
  configPipeline: `${ACTION_PREFIX}/config/pipeline`,
  config: `${ACTION_PREFIX}/config`,
  applicationTransfer: `${ACTION_PREFIX}/application/transfer`,
  candidateConstraint: `${ACTION_PREFIX}/candidate/constraint`,
  jobCreate: `${ACTION_PREFIX}/job/create`,
} as const

/** action 名称（响应 `action` 字段 + 错误 detail，机检口径）。 */
type ActionName =
  | 'screening/decide'
  | 'decision/record'
  | 'stage/advance'
  | 'interview/schedule'
  | 'transcript/import'
  | 'job/rubric-approve'
  | 'config/role'
  | 'config/team'
  | 'config/pipeline'
  | 'application/transfer'
  | 'candidate/constraint'
  | 'job/create'

/** 允许调用写动作的受控 alias（D-119 + D-118：招聘/决策/配置是 Recruiter 职责范围内的人工动作；
 *  interviewer_a/b 的工作台动作只有 W1 的 scorecard submit，不走本文件）。 */
const ACTION_ALLOWED_ALIASES: readonly DemoActorAlias[] = ['recruiter']

/** 客户端**不许**覆盖的身份头（命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
/** 客户端**不许**覆盖的身份键（query；命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_QUERY_KEYS = ['actor_id', 'tenant_id'] as const
/**
 * 客户端**不许**出现在 body 的身份/服务端派生键（命中即 400，且不碰 DB）。
 * 注意只匹配**精确键**：`interviewer_id` / `member_actor_id` / `applicant_id` 等业务 id 不受影响
 * （`config/team` 的 `member_actor_id`、`decision` 的 `basis_refs[].actor_id` 都是正常业务数据）。
 */
const ACTOR_OVERRIDE_BODY_KEYS = [
  'actor_id',
  'tenant_id',
  'actor',
  'tenant',
  'alias',
  'actor_alias',
  'decided_by_actor_id',
  'confirmed_by_actor_id',
  'created_by_actor_id',
  'approved_by_actor_id',
  'submitted_by_actor_id',
  // confirmation_text 的 sha256 由服务端计算；客户端不得传入派生值（三条新写动作共用）。
  'confirmation_text_sha256',
] as const
/** 决策动作额外禁止的 body 键：人工确认四要素与 decision 行字段由服务端生成（D-95 / DC-08）。 */
const DECISION_DERIVED_BODY_KEYS = [
  'human_confirmation',
  'approval_id',
  'stage_code',
  'decided_at',
  'status',
] as const

/** 请求体上限：64 KiB（超限 413，零写入）。 */
const MAX_BODY_BYTES = 64 * 1024

/** 配置类动作允许的**写** operation（读走既有只读投影/工具，不在本写入口重复暴露）。 */
const CONFIG_WRITE_OPERATIONS = {
  role: ['create', 'update'],
  team: ['create', 'update', 'add_member', 'remove_member'],
  pipeline: ['create', 'update', 'add_stage', 'add_stage_template'],
} as const

/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/**
 * 契约错误的 HTTP 映射（与 `http/actor.ts` 同口径；只补本 lane 会遇到的领域码）。
 * 未列出的码一律 500（不猜）。
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  DECISION_REQUIRES_HUMAN: 403,
  VERSION_CONFLICT: 409,
  ALREADY_DECIDED: 409,
  ALREADY_EXISTS: 409,
  ALREADY_SCHEDULED: 409,
  ALREADY_SUBMITTED: 409,
  CONFLICT_SLOT: 409,
  MEETING_ALREADY_BOUND: 409,
  NO_MEETING_BOUND: 409,
  AMBIGUOUS_MEETING: 400,
  SCORECARD_MISSING: 409,
  BLOCKED: 409,
  BLOCKED_BY_REVIEW: 409,
  NO_RUBRIC: 409,
  NO_TRANSCRIPT: 409,
  EVIDENCE_INSUFFICIENT: 422,
  INVALID_REFERENCE: 400,
  NOT_CONFIGURED: 503,
  DEMO_ACTOR_UNMAPPED: 409,
  DB_CONSTRAINT_VIOLATION: 500,
  INVARIANT_VIOLATION: 500,
  READER_FAILED: 500,
  // 三条新写动作（transfer/constraint/job-create）的领域拒绝码全部复用既有码：
  //   CANDIDATE_MISMATCH / CARRY_OVER_* / INTERVIEW_* / JOB_NOT_FOUND 等只作为
  //   reason_code 出现在 INVALID_ARGS(400) / NOT_FOUND(404) 的 detail 里，不另立顶层码。
}

// =====================================================================
//  宿主上下文 / 依赖（形状与 `http/actor.ts` 同窄接口）
// =====================================================================

/** 宿主侧用到的 `webServer` 最小面（与 overview / actor 的窄接口同形）。 */
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
export interface ActionHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** `registerActionsHttp` 的依赖：库配置 + 与工具/`http/actor.ts` **共享**的 Demo Actor 身份。 */
export interface ActionHttpDeps {
  /** 已解析的数据库配置；`null` = 未配置（路由仍注册，返回 503，不假装成功）。 */
  readonly database: ResolvedDatabaseConfig | null
  /** `database === null` 时缺失的配置项（只含变量名，不含密码）。 */
  readonly databaseIssues: readonly string[]
  /** session → alias 注册表 + alias → HUMAN actor 映射（由 `src/index.ts` 持有单例）。 */
  readonly identity: DemoActorIdentity
  /** 飞书连接器（可选；只有 transcript/import 的连接器回读路径用，缺省 = 该路径 fail-closed）。 */
  readonly connector?: TranscriptImportDeps['connector']
  /** 连接器缺失项（只含变量名）。 */
  readonly connectorIssues?: readonly string[]
}

// =====================================================================
//  HTTP 小工具（封闭错误信封：`{error:{code,reason_code,message,detail?}}`）
// =====================================================================

/** 本文件自己产生的、可直接返回的 HTTP 问题（不经过域错误映射）。 */
class ActionHttpProblem extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'ActionHttpProblem'
    this.status = status
    this.body = body
  }
}

/** 造一个契约形状的 HTTP 问题。 */
function actionHttpError(
  status: number,
  code: string,
  reasonCode: string,
  message: string,
  detail?: unknown,
): ActionHttpProblem {
  return new ActionHttpProblem(status, {
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
    throw actionHttpError(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > limit) {
      throw actionHttpError(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
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
    throw actionHttpError(
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
    throw actionHttpError(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw actionHttpError(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body' })
  }
  return raw as Record<string, unknown>
}

/**
 * 读可选的顶层 `expected_record_version`（乐观并发守卫；`stage/advance` 与 `decision/record`
 * 两个写路由共用）。
 *
 *   * **不传**（键不存在）→ 返回 `undefined`；调用方不加任何字段，行为逐字不变；
 *   * 传了 → 必须是整数且 ≥1；否则 400 `INVALID_ARGS`，
 *     reason_code = `TYPE_MISMATCH`（类型/非整数）或 `OUT_OF_RANGE`（<1），**零写入**。
 *
 * 版本判断本身**不在 HTTP 层做**（绝不"读回来再比"）：这里只校验形状并把值透传给域函数，
 * 由它在同一条 UPDATE 的 WHERE 里做原子守卫；不符时域函数抛
 * `VERSION_CONFLICT(STALE_RECORD_VERSION)`，经 `errorResponse`/`STATUS_BY_CODE` 映射成 409，
 * 信封 `{error:{code,reason_code,message,detail:{expected_record_version,actual_record_version}}}`。
 */
function readOptionalExpectedRecordVersion(body: Record<string, unknown>): number | undefined {
  if (!Object.hasOwn(body, 'expected_record_version')) return undefined
  const value = body.expected_record_version
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw actionHttpError(
      400,
      'INVALID_ARGS',
      'TYPE_MISMATCH',
      'expected_record_version 必须是整数（≥1）',
      { path: 'expected_record_version', expected: 'integer >= 1' },
    )
  }
  if (value < 1) {
    throw actionHttpError(
      400,
      'INVALID_ARGS',
      'OUT_OF_RANGE',
      'expected_record_version 必须 ≥ 1',
      { path: 'expected_record_version', value },
    )
  }
  return value
}

/** 同源校验（**复用** `overview.ts::sameOrigin`；不能过就 403）。 */
function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw actionHttpError(
      403,
      'FORBIDDEN',
      'SAME_ORIGIN_REQUIRED',
      '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）',
    )
  }
}

/** 拒绝 query / header 上的身份覆盖（`actor_id`/`tenant_id`、`x-recruitment-actor`/`x-recruitment-tenant`）。**不碰 DB**。 */
function rejectQueryOrHeaderOverrides(req: IncomingMessage, url: URL): void {
  const rejected: string[] = []
  for (const key of ACTOR_OVERRIDE_QUERY_KEYS) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  }
  if (rejected.length > 0) {
    throw actionHttpError(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
      { rejected },
    )
  }
}

/**
 * 拒绝 body 里的身份/服务端派生键。**不碰 DB**。
 * @param body - 已解析的 JSON body。
 * @param extraKeys - 该动作额外禁止的键（例如决策动作的 `human_confirmation`）。
 */
function rejectBodyOverrides(body: Record<string, unknown>, extraKeys: readonly string[] = []): void {
  const rejected = [...ACTOR_OVERRIDE_BODY_KEYS, ...extraKeys]
    .filter((key) => Object.hasOwn(body, key))
    .sort()
  if (rejected.length > 0) {
    throw actionHttpError(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 与人工确认只能来自服务端绑定，不接受客户端传入（D-33 / D-95）',
      { rejected },
    )
  }
}

/** 读 `X-DSH-Session` 头并归一化（身份**有且只有**这个头）。 */
function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw actionHttpError(
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

/** session → alias → actor（未绑定 / 别名无映射 → 409 `DEMO_ACTOR_UNMAPPED`，零写入）。 */
function requireBoundActor(identity: DemoActorIdentity, sessionId: string): ResolvedExecutionActor {
  return resolveSessionActor(identity, sessionId)
}

/**
 * 动作级 alias 闸门（本 lane 的产品策略：招聘写动作只由 Recruiter 身份执行）。
 * 越权 → 403 `FORBIDDEN(ACTOR_NOT_AUTHORIZED)`，**零写入**。
 * @param resolved - 已解析的执行者。
 * @param action - 动作名（错误 detail 用；统一入口 body 解析前用占位名）。
 */
function assertActionAlias(resolved: ResolvedExecutionActor, action: string): void {
  if ((ACTION_ALLOWED_ALIASES as readonly string[]).includes(resolved.alias)) return
  throw actionHttpError(
    403,
    'FORBIDDEN',
    'ACTOR_NOT_AUTHORIZED',
    `当前身份（${resolved.alias}）无权执行该招聘写动作（只允许 ${ACTION_ALLOWED_ALIASES.join(', ')}）`,
    { action, alias: resolved.alias, allowed_aliases: [...ACTION_ALLOWED_ALIASES] },
  )
}

/**
 * 把任意错误翻成 HTTP 状态 + 封闭错误信封（优先解析产品错误消息 `CODE: <compact-json>`）。
 * @param error - 任意错误。
 */
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof ActionHttpProblem) return { status: error.status, body: error.body }
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

/** 未配置库时的 503（含缺失项；只含变量名，不含密码）。 */
function notConfigured(issues: readonly string[]): ActionHttpProblem {
  return actionHttpError(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，写动作不可用', {
    issues: [...issues],
  })
}

/** 检查库已配置并返回配置（否则 503）。 */
function requireDatabase(deps: ActionHttpDeps): ResolvedDatabaseConfig {
  if (deps.database === null) throw notConfigured(deps.databaseIssues)
  return deps.database
}

/**
 * 在一个短连接池上执行 `fn`（HTTP 请求级；finally 关池，避免空闲 socket 挂住宿主）。
 * @param cfg - 已解析的库配置。
 * @param fn - 拿到连接池。
 */
async function withPool<T>(
  cfg: ResolvedDatabaseConfig,
  fn: (pool: DatabasePool) => Promise<T>,
): Promise<T> {
  const pool = createPool(cfg)
  try {
    return await fn(pool)
  } finally {
    await closePool(pool)
  }
}

// =====================================================================
//  一次性 allow-once approval（人类点击等价；单次请求内只放行一次）
// =====================================================================

/** approval 请求的最小形状（与各工具 `ApprovalRequester` 兼容）。 */
interface ApprovalRequestShape {
  readonly agent?: unknown
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** 一次请求的审批闸门（第一次 `allowed-once`，之后一律 `rejected`）。 */
interface AllowOnceGate {
  readonly approval: { request(req: ApprovalRequestShape): Promise<string> }
  summary(): { readonly requested: number; readonly result: string; readonly tool_names: readonly string[] }
}

/**
 * 造一个只属于本次 HTTP 请求的 allow-once 批准通道。
 *
 * 语义（与 DSH `ctx.approval` 的封闭结果一致）：
 *   * 第一次请求（且 `toolName` 与预期一致）→ `allowed-once`；
 *   * 第二次及以后 → `rejected`（fail-closed：一次人类点击只授权一次写）；
 *   * `toolName` 不一致 → `unavailable`（宿主/工具异常，不猜）。
 * 它**不是** DSH 的 approval 服务：只被本文件构造的工具实例看到，Agent 路径拿不到。
 * @param expectedToolName - 该动作复用工具的工具名（防串线）。
 */
function createAllowOnceGate(expectedToolName: string): AllowOnceGate {
  let requested = 0
  const toolNames: string[] = []
  let result = 'not-requested'
  return {
    approval: {
      async request(req: ApprovalRequestShape): Promise<string> {
        requested += 1
        toolNames.push(req.toolName)
        if (requested > 1) {
          result = 'rejected'
          return 'rejected'
        }
        if (req.toolName !== expectedToolName) {
          result = 'unavailable'
          return 'unavailable'
        }
        result = 'allowed-once'
        return 'allowed-once'
      },
    },
    summary() {
      return { requested, result, tool_names: [...toolNames] }
    },
  }
}

/** 没有 approval 的工具（config / stage / transcript）的常量摘要。 */
function noApprovalSummary(): { readonly requested: number; readonly result: string; readonly tool_names: readonly string[] } {
  return { requested: 0, result: 'not-applicable', tool_names: [] }
}

/**
 * 构造一次「工具执行上下文」：`exec.agent.id` = 当前 DSH session（与 Agent 路径同一条解析链）。
 * @param resolved - 已解析的执行者。
 */
function execOf(resolved: ResolvedExecutionActor): Record<string, unknown> {
  return {
    agent: { id: resolved.session_id },
    headers: { [DEMO_SESSION_HEADER]: resolved.session_id },
  }
}

// =====================================================================
//  请求读取（同源 + session + alias + body 的统一顺序）
// =====================================================================

/** 一次动作请求的公共上下文。 */
interface ActionRequestContext {
  readonly resolved: ResolvedExecutionActor
  readonly body: Record<string, unknown>
}

/**
 * 读一次写动作请求：session 必须已绑定 alias，且 alias 必须被该动作授权。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param action - 动作名。
 * @param extraBodyKeys - 该动作额外禁止的 body 键。
 * @returns `{resolved, body}`。
 */
async function readActionRequest(
  deps: ActionHttpDeps,
  req: IncomingMessage,
  action: ActionName,
  extraBodyKeys: readonly string[] = [],
): Promise<ActionRequestContext> {
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  assertActionAlias(resolved, action)
  // 先落实 400（body 形状 / 身份覆盖键），再检查库配置：未配置的 503 不应盖住客户端的
  // 明确错误（A 的契约取证：database:null 时覆盖键应仍是 400 ACTOR_OVERRIDE_REJECTED）。
  const body = await readJsonObject(req)
  rejectBodyOverrides(body, extraBodyKeys)
  requireDatabase(deps)
  return { resolved, body }
}

/** 成功响应的信封（`result` = 工具输出；`readback` = 独立 DB 读回）。 */
interface ActionResultEnvelope {
  readonly action: ActionName
  readonly actor: {
    readonly session_id: string
    readonly alias: string
    readonly actor_id: string
  }
  readonly approval: { readonly requested: number; readonly result: string; readonly tool_names: readonly string[] }
  readonly result: Record<string, unknown>
  readonly readback: Record<string, unknown>
}

/**
 * 写一次成功动作响应。
 * @param res - node 响应。
 * @param action - 动作名。
 * @param resolved - 执行者（服务端解析结果）。
 * @param approval - approval 闸门摘要。
 * @param output - 被复用工具的原样输出。
 * @param readback - 独立 DB 读回。
 */
function writeActionResult(
  res: ServerResponse,
  action: ActionName,
  resolved: ResolvedExecutionActor,
  approval: ActionResultEnvelope['approval'],
  output: unknown,
  readback: Record<string, unknown>,
): void {
  const value: ActionResultEnvelope = {
    action,
    actor: { session_id: resolved.session_id, alias: resolved.alias, actor_id: resolved.actor_id },
    approval,
    result: asRecord(output),
    readback,
  }
  json(res, 200, value)
}

/** `unknown` → 普通对象（工具输出必是对象；否则按空对象兜底，不冒充字段）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 从工具输出里按路径取一个非空字符串（取不到 → 500 READBACK_SUBJECT_MISSING，不猜）。 */
function requireOutputString(output: Record<string, unknown>, ...path: readonly string[]): string {
  let cursor: unknown = output
  for (const key of path) {
    cursor = asRecord(cursor)[key]
  }
  if (typeof cursor === 'string' && cursor !== '') return cursor
  throw actionHttpError(
    500,
    'INTERNAL',
    'READBACK_SUBJECT_MISSING',
    `工具输出缺 ${path.join('.')}（写后读回无法定位对象，不猜）`,
    { path: [...path] },
  )
}

// =====================================================================
//  独立 DB 读回（写事务提交后另开只读连接；SQL 只读、参数化）
// =====================================================================

/** 读回一行；没有行 → 500（写成功但读不到 = 数据异常，不返回假状态）。 */
function requireRow<T>(rows: readonly T[], what: string, detail: Record<string, unknown>): T {
  const row = rows[0]
  if (row === undefined) {
    throw actionHttpError(500, 'INTERNAL', 'READBACK_MISSING', `${what} 写事务已提交但读回不到该行`, detail)
  }
  return row
}

/** 决策表读回行（decision 没有 status 列：用 result + is_current 表达状态，见 CONTRACT.md）。 */
interface DecisionReadbackRow {
  decision_id: string
  application_id: string
  interview_id: string | null
  decision_scope: string
  stage_code: string | null
  result: string
  record_version: number
  actor_id: string
  decided_at: Date | string
  is_current: boolean
  superseded_by_decision_id: string | null
}

const DECISION_READBACK_SQL = `
  select d.id::text                     as decision_id,
         d.application_id::text         as application_id,
         d.interview_id::text           as interview_id,
         d.decision_scope,
         d.stage_code,
         d.result,
         d.record_version,
         d.decided_by_actor_id::text    as actor_id,
         d.decided_at,
         (d.superseded_by_decision_id is null) as is_current,
         d.superseded_by_decision_id::text as superseded_by_decision_id
    from recruitment.decision d
   where d.application_id = $1::uuid
     and d.tenant_id = $2::uuid
     and d.decision_scope = $3
   order by d.decided_at desc, d.created_at desc, d.id desc
   limit 1
`

/**
 * 读回某申请某 scope 的最新决策行（写后当前事实）。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id。
 * @param scope - SCREENING / STAGE / FINAL。
 */
async function readbackDecision(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  scope: string,
): Promise<DecisionReadbackRow> {
  const { rows } = await client.query<DecisionReadbackRow>(DECISION_READBACK_SQL, [applicationId, tenantId, scope])
  return requireRow(rows, 'decision', { application_id: applicationId, decision_scope: scope })
}

/** 申请表读回行（阶段推进的对象）。 */
interface ApplicationReadbackRow {
  application_id: string
  status: string
  stage_code: string
  record_version: number
  actor_id: string | null
  stage_changed_at: Date | string
  stage_entered_at: Date | string
}

const APPLICATION_READBACK_SQL = `
  select a.id::text                          as application_id,
         a.lifecycle_status                  as status,
         a.current_stage_code                as stage_code,
         a.record_version,
         a.stage_changed_by_actor_id::text   as actor_id,
         a.stage_changed_at,
         a.stage_entered_at
    from recruitment.application a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/**
 * 读回申请行（阶段推进后的当前事实）。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id。
 */
async function readbackApplication(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationReadbackRow> {
  const { rows } = await client.query<ApplicationReadbackRow>(APPLICATION_READBACK_SQL, [applicationId, tenantId])
  return requireRow(rows, 'application', { application_id: applicationId })
}

/** 面试表读回行。 */
interface InterviewReadbackRow {
  interview_id: string
  application_id: string
  status: string
  record_version: number
  actor_id: string | null
  round_no: number
  slot_code: string
  scheduled_start_at: Date | string | null
  scheduled_end_at: Date | string | null
  timezone: string
}

const INTERVIEW_READBACK_SQL = `
  select i.id::text                          as interview_id,
         i.application_id::text              as application_id,
         i.status,
         i.record_version,
         i.status_changed_by_actor_id::text  as actor_id,
         i.round_no,
         i.slot_code,
         i.scheduled_start_at,
         i.scheduled_end_at,
         i.timezone
    from recruitment.interview i
   where i.id = $1::uuid and i.tenant_id = $2::uuid
`

/** 面试官行读回（CREATE/RESCHEDULE/WITHDRAW 的分配事实）。 */
interface InterviewerReadbackRow {
  interviewer_id: string
  actor_id: string
  display_name: string
  role_in_interview: string
  required_scorecard: boolean
}

const INTERVIEWER_READBACK_SQL = `
  select ivr.id::text                  as interviewer_id,
         ivr.actor_id::text            as actor_id,
         a.display_name,
         ivr.role_in_interview,
         ivr.required_scorecard
    from recruitment.interviewer ivr
    join recruitment.actor a
      on a.id = ivr.actor_id and a.tenant_id = ivr.tenant_id
   where ivr.interview_id = $1::uuid and ivr.tenant_id = $2::uuid
   order by ivr.created_at, ivr.id
`

/**
 * 读回面试 + 面试官分配。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param interviewId - 面试 id。
 */
async function readbackInterview(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<InterviewReadbackRow & { interviewers: readonly InterviewerReadbackRow[] }> {
  const interview = await client.query<InterviewReadbackRow>(INTERVIEW_READBACK_SQL, [interviewId, tenantId])
  const interviewers = await client.query<InterviewerReadbackRow>(INTERVIEWER_READBACK_SQL, [interviewId, tenantId])
  return { ...requireRow(interview.rows, 'interview', { interview_id: interviewId }), interviewers: interviewers.rows }
}

/** transcript_artifact 读回行。 */
interface ArtifactReadbackRow {
  artifact_id: string
  meeting_id: string
  status: string
  record_version: number
  actor_id: string | null
  is_canonical: boolean
  provenance: string
  trigger_mode: string
  connection_state: string
  content_sha256: string | null
  source_revision: number
  language: string | null
  fetched_at: Date | string | null
}

const ARTIFACT_READBACK_SQL = `
  select ta.id::text                             as artifact_id,
         ta.meeting_id::text                     as meeting_id,
         ta.transcript_status                    as status,
         ta.record_version,
         ta.status_changed_by_actor_id::text     as actor_id,
         ta.is_canonical,
         ta.provenance,
         ta.trigger_mode,
         ta.connection_state,
         ta.content_sha256,
         ta.source_revision,
         ta.language,
         ta.fetched_at
    from recruitment.transcript_artifact ta
   where ta.id = $1::uuid and ta.tenant_id = $2::uuid
`

const SEGMENT_COUNT_SQL = `
  select count(*)::int as segment_count
    from recruitment.transcript_segment
   where artifact_id = $1::uuid and tenant_id = $2::uuid
`

/**
 * 读回转写 artifact + 段落数。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param artifactId - artifact id。
 */
async function readbackArtifact(
  client: DatabaseClient,
  tenantId: string,
  artifactId: string,
): Promise<ArtifactReadbackRow & { segment_count: number }> {
  const artifact = await client.query<ArtifactReadbackRow>(ARTIFACT_READBACK_SQL, [artifactId, tenantId])
  const segments = await client.query<{ segment_count: number }>(SEGMENT_COUNT_SQL, [artifactId, tenantId])
  return {
    ...requireRow(artifact.rows, 'transcript_artifact', { artifact_id: artifactId }),
    segment_count: segments.rows[0]?.segment_count ?? 0,
  }
}

/** approval / rubric_version / job 读回行。 */
interface ApprovalReadbackRow {
  approval_id: string
  status: string
  record_version: number
  actor_id: string | null
  decided_at: Date | string | null
  resource_type: string
  resource_id: string
  canonical_payload_hash: string
}

interface RubricReadbackRow {
  rubric_version_id: string
  version_no: number
  approved_by_approval_id: string | null
  created_by_actor_id: string | null
  payload_hash: string
}

interface JobReadbackRow {
  job_id: string
  current_rubric_version_id: string | null
  record_version: number
}

const APPROVAL_READBACK_SQL = `
  select ap.id::text                        as approval_id,
         ap.status,
         ap.record_version,
         ap.decision_by_actor_id::text      as actor_id,
         ap.decided_at,
         ap.resource_type,
         ap.resource_id::text               as resource_id,
         ap.canonical_payload_hash
    from recruitment.approval ap
   where ap.id = $1::uuid and ap.tenant_id = $2::uuid
`

const RUBRIC_READBACK_SQL = `
  select rv.id::text                         as rubric_version_id,
         rv.version_no,
         rv.approved_by_approval_id::text    as approved_by_approval_id,
         rv.created_by_actor_id::text        as created_by_actor_id,
         rv.payload_hash
    from recruitment.rubric_version rv
   where rv.id = $1::uuid and rv.tenant_id = $2::uuid
`

const JOB_READBACK_SQL = `
  select j.id::text                          as job_id,
         j.current_rubric_version_id::text   as current_rubric_version_id,
         j.record_version
    from recruitment.job j
   where j.id = $1::uuid and j.tenant_id = $2::uuid
`

/**
 * 读回 rubric 批准的三个对象（审批行、rubric 版本、岗位指针）。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param approvalId - 审批行 id（工具输出）。
 * @param rubricVersionId - rubric 版本 id（入参）。
 * @param jobId - 岗位 id（入参）。
 */
async function readbackRubricApproval(
  client: DatabaseClient,
  tenantId: string,
  approvalId: string,
  rubricVersionId: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const approval = await client.query<ApprovalReadbackRow>(APPROVAL_READBACK_SQL, [approvalId, tenantId])
  const rubric = await client.query<RubricReadbackRow>(RUBRIC_READBACK_SQL, [rubricVersionId, tenantId])
  const job = await client.query<JobReadbackRow>(JOB_READBACK_SQL, [jobId, tenantId])
  return {
    approval: requireRow(approval.rows, 'approval', { approval_id: approvalId }),
    rubric: requireRow(rubric.rows, 'rubric_version', { rubric_version_id: rubricVersionId }),
    job: requireRow(job.rows, 'job', { job_id: jobId }),
  }
}

/** role / team / pipeline 读回行。 */
interface RoleReadbackRow {
  role_id: string
  code: string
  name: string
  is_active: boolean
  record_version: number
  permission_scopes: readonly string[]
  actor_id: string | null
  updated_at: Date | string
}

interface TeamReadbackRow {
  team_id: string
  code: string
  name: string
  department_id: string
  is_active: boolean
  record_version: number
  actor_id: string | null
  updated_at: Date | string
}

interface TeamMemberReadbackRow {
  team_member_id: string
  actor_id: string
  display_name: string
  team_role: string
  is_active: boolean
  added_by_actor_id: string | null
}

interface PipelineReadbackRow {
  pipeline_template_id: string
  code: string
  name: string
  is_active: boolean
  record_version: number
  actor_id: string | null
  updated_at: Date | string
}

interface PipelineStageReadbackRow {
  stage_id: string
  stage_code: string
  sort_order: number
}

const ROLE_READBACK_SQL = `
  select r.id::text                     as role_id,
         r.code,
         r.name,
         r.is_active,
         r.record_version,
         r.permission_scopes,
         r.created_by_actor_id::text    as actor_id,
         r.updated_at
    from recruitment.role r
   where r.id = $1::uuid and r.tenant_id = $2::uuid
`

const TEAM_READBACK_SQL = `
  select t.id::text                       as team_id,
         t.code,
         t.name,
         t.department_id::text            as department_id,
         t.is_active,
         t.record_version,
         t.created_by_actor_id::text      as actor_id,
         t.updated_at
    from recruitment.hiring_team t
   where t.id = $1::uuid and t.tenant_id = $2::uuid
`

const TEAM_MEMBERS_READBACK_SQL = `
  select m.id::text                        as team_member_id,
         m.actor_id::text                  as actor_id,
         a.display_name,
         m.team_role,
         m.is_active,
         m.added_by_actor_id::text         as added_by_actor_id
    from recruitment.hiring_team_member m
    join recruitment.actor a
      on a.id = m.actor_id and a.tenant_id = m.tenant_id
   where m.team_id = $1::uuid and m.tenant_id = $2::uuid
   order by m.created_at, m.id
`

const PIPELINE_READBACK_SQL = `
  select p.id::text                       as pipeline_template_id,
         p.code,
         p.name,
         p.is_active,
         p.record_version,
         p.created_by_actor_id::text      as actor_id,
         p.updated_at
    from recruitment.pipeline_template p
   where p.id = $1::uuid and p.tenant_id = $2::uuid
`

const PIPELINE_STAGES_READBACK_SQL = `
  select s.id::text        as stage_id,
         s.stage_code,
         s.sort_order
    from recruitment.pipeline_template_stage s
   where s.pipeline_template_id = $1::uuid and s.tenant_id = $2::uuid
   order by s.sort_order, s.id
`

/**
 * 读回角色行。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param roleId - 角色 id。
 */
async function readbackRole(client: DatabaseClient, tenantId: string, roleId: string): Promise<RoleReadbackRow> {
  const { rows } = await client.query<RoleReadbackRow>(ROLE_READBACK_SQL, [roleId, tenantId])
  return requireRow(rows, 'role', { role_id: roleId })
}

/**
 * 读回团队行 + 成员。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param teamId - 团队 id。
 */
async function readbackTeam(
  client: DatabaseClient,
  tenantId: string,
  teamId: string,
): Promise<TeamReadbackRow & { members: readonly TeamMemberReadbackRow[] }> {
  const team = await client.query<TeamReadbackRow>(TEAM_READBACK_SQL, [teamId, tenantId])
  const members = await client.query<TeamMemberReadbackRow>(TEAM_MEMBERS_READBACK_SQL, [teamId, tenantId])
  return { ...requireRow(team.rows, 'hiring_team', { team_id: teamId }), members: members.rows }
}

/**
 * 读回流水线模板 + 阶段。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户。
 * @param pipelineTemplateId - 模板 id。
 */
async function readbackPipeline(
  client: DatabaseClient,
  tenantId: string,
  pipelineTemplateId: string,
): Promise<PipelineReadbackRow & { stages: readonly PipelineStageReadbackRow[] }> {
  const pipeline = await client.query<PipelineReadbackRow>(PIPELINE_READBACK_SQL, [pipelineTemplateId, tenantId])
  const stages = await client.query<PipelineStageReadbackRow>(PIPELINE_STAGES_READBACK_SQL, [pipelineTemplateId, tenantId])
  return {
    ...requireRow(pipeline.rows, 'pipeline_template', { pipeline_template_id: pipelineTemplateId }),
    stages: stages.rows,
  }
}

// =====================================================================
//  动作 1/2：POST screening/decide、POST decision/record
//    复用 `recruitment_decision_record`（SCREENING = S7；STAGE/FINAL = S10）。
//    服务端派生 human_confirmation（IN_APP_CONFIRM：人是通过这次同源 HTTP 点击授权的），
//    再走工具自己的 D-79 闸门 —— 本文件为这次请求提供 allow-once（见文件头）。
// =====================================================================

/** 决策工具名（allow-once 闸门绑定 + 调试报表）。 */
const DECISION_TOOL_NAME = 'recruitment_decision_record'

/**
 * 把 HTTP body 变成 `recruitment_decision_record` 的可执行入参。
 *
 * 服务端派生：
 *   * `decision_scope`（端点已定，body 不得改写成另一个 scope）；
 *   * `human_confirmation`：四要素全部服务端生成（confirmed_by = 当前 actor、confirmed_at = 服务端 now、
 *     method = IN_APP_CONFIRM、sha256 = 对 `{result, reason, override_rationale, basis_refs}` 的 v1 pre-image）。
 *     人在浏览器里点击“记录决策”= 对**这一版内容**的确认；body 不接受这四个字段（见 DECISION_DERIVED_BODY_KEYS）。
 * @param scope - SCREENING 或 STAGE/FINAL（端点决定）。
 * @param body - 已过身份键检查的 body。
 * @param resolved - 当前执行者。
 * @returns 交给 `parseDecisionArgs` / 工具 execute 的完整入参。
 */
function buildDecisionCommand(
  scope: 'SCREENING' | 'STAGE' | 'FINAL',
  body: Record<string, unknown>,
  resolved: ResolvedExecutionActor,
): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...body }
  if (scope === 'SCREENING') {
    if (raw.decision_scope !== undefined && raw.decision_scope !== 'SCREENING') {
      throw actionHttpError(
        400,
        'INVALID_ARGS',
        'SCOPE_MISMATCH',
        'screening/decide 只记录 SCREENING 决策；STAGE/FINAL 请用 decision/record',
        { decision_scope: raw.decision_scope },
      )
    }
    raw.decision_scope = 'SCREENING'
  } else {
    if (raw.decision_scope === undefined) {
      throw actionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "decision_scope"', {
        missing: ['decision_scope'],
        allowed: ['STAGE', 'FINAL'],
      })
    }
    if (raw.decision_scope !== 'STAGE' && raw.decision_scope !== 'FINAL') {
      throw actionHttpError(
        400,
        'INVALID_ARGS',
        'SCOPE_MISMATCH',
        'decision/record 只接受 STAGE / FINAL（SCREENING 请用 screening/decide）',
        { decision_scope: raw.decision_scope },
      )
    }
  }
  const nowMs = Date.now()
  // 先按领域 STEP 0 校验/归一化，再用**同一份**归一化结果构造人工确认哈希
  // （顺序陷阱：先校验后算 hash，避免把未归一化的 body 写进确认凭据）。
  const parsed = parseDecisionArgs(raw, nowMs)
  return {
    ...raw,
    human_confirmation: {
      confirmed_by_actor_id: resolved.actor_id,
      confirmed_at: new Date(nowMs).toISOString(),
      confirmation_method: 'IN_APP_CONFIRM',
      confirmation_text_sha256: confirmationHashOf(parsed),
    },
  }
}

/**
 * v1 pre-image 的人工确认哈希（DC-11 原口径：`{result, reason, override_rationale, basis_refs}`）。
 * **必须**与 `assertHumanDecider` 用同一个函数/同一份字段（不另写一份算法）。
 * @param parsed - `parseDecisionArgs` 的归一化结果。
 */
function confirmationHashOf(parsed: ReturnType<typeof parseDecisionArgs>): string {
  return confirmationTextSha256({
    result: parsed.result,
    reason: parsed.reason,
    override_rationale: parsed.override_rationale ?? null,
    basis_refs: parsed.basis_refs,
  })
}

/**
 * `POST /recruitment/api/action/screening/decide` 与 `POST .../decision/record` 的实现。
 * @param deps - 路由依赖。
 * @param mode - `'screening'` = 强制 SCREENING；`'record'` = 从 body 的 decision_scope 取 STAGE/FINAL。
 * @param action - 动作名。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleDecisionAction(
  deps: ActionHttpDeps,
  mode: 'screening' | 'record',
  action: ActionName,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { resolved, body } = await readActionRequest(deps, req, action, DECISION_DERIVED_BODY_KEYS)
  const database = requireDatabase(deps)
  // 只有 decision/record 端点吃顶层 expected_record_version；screening/decide 这条路径
  // 完全不动（该字段在 screening 上仍按改动前的既有规则处理，行为逐字不变）。
  // 校验在此、任何写之前完成；buildDecisionCommand 的返回值是 `{...body, human_confirmation}`，
  // 所以这个（已校验的）值会随 args 原样透传给工具/域层做原子版本守卫。
  if (mode === 'record') readOptionalExpectedRecordVersion(body)
  // screening/decide 的 scope 是端点语义；decision/record 的 scope 在 buildDecisionCommand
  // 里按 body 校验（只允许 STAGE/FINAL），这里传一个占位值，函数内会覆盖/校验。
  const scope: 'SCREENING' | 'STAGE' | 'FINAL' = mode === 'screening' ? 'SCREENING' : 'FINAL'
  const args = buildDecisionCommand(scope, body, resolved)
  const gate = createAllowOnceGate(DECISION_TOOL_NAME)
  const tool: ReadonlyToolDefinition = createDecisionRecordTool({
    database,
    approval: gate.approval,
    identity: deps.identity,
  })
  const output = await tool.execute(args, execOf(resolved))
  const parsed = parseDecisionArgs(args, Date.now())
  const readback = await withPool(database, async (pool) => withReadOnly(pool, async (client) => {
    const row = await readbackDecision(client, database.tenant_id, parsed.application_id, parsed.decision_scope)
    return { ...row }
  }))
  writeActionResult(res, action, resolved, gate.summary(), output, readback)
}

// =====================================================================
//  动作 3：POST stage/advance
//    复用 `recruitment_application_stage_advance`（唯一入参 application_id）。
//    status=ADVANCED / NO_OP / BLOCKED 都是工具的正常业务结论（HTTP 200），
//    `readback` 给库里的当前阶段与 record_version；没有写库时两者不变。
// =====================================================================

/**
 * `POST /recruitment/api/action/stage/advance` 的实现。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleStageAdvance(
  deps: ActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action: ActionName = 'stage/advance'
  const { resolved, body } = await readActionRequest(deps, req, action)
  const expectedRecordVersion = readOptionalExpectedRecordVersion(body)
  const database = requireDatabase(deps)
  const tool = createStageAdvanceTool(database, { identity: deps.identity })
  // 不传时把原始 body 原样交给工具（逐字等价）；传了才加这一个键。工具层把它当作
  // parseArgs 的合法可选参数接收，并透传给 advanceApplicationStage 的 input 做 WHERE 守卫。
  const toolInput = expectedRecordVersion === undefined
    ? body
    : { ...body, expected_record_version: expectedRecordVersion }
  const output = await tool.execute(toolInput, execOf(resolved))
  const outputRecord = asRecord(output)
  const applicationId = typeof outputRecord.application_id === 'string' && outputRecord.application_id !== ''
    ? outputRecord.application_id
    : body.application_id
  if (typeof applicationId !== 'string' || !isUuid(applicationId)) {
    throw actionHttpError(500, 'INTERNAL', 'READBACK_SUBJECT_MISSING', '阶段推进输出缺 application_id（不猜）')
  }
  const readback = await withPool(database, async (pool) => withReadOnly(pool, async (client) => (
    { ...(await readbackApplication(client, database.tenant_id, applicationId)) }
  )))
  writeActionResult(res, action, resolved, noApprovalSummary(), output, readback)
}

// =====================================================================
//  动作 4：POST interview/schedule
//    复用 `recruitment_interview_schedule`（CREATE / RESCHEDULE / CANCEL / WITHDRAW_INTERVIEWER，
//    D-79 approval 在工具内部、写库之前；本文件提供本次请求的 allow-once）。
// =====================================================================

/** 排期工具名（allow-once 闸门绑定）。 */
const SCHEDULE_TOOL_NAME = 'recruitment_interview_schedule'

/**
 * `POST /recruitment/api/action/interview/schedule` 的实现。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleInterviewSchedule(
  deps: ActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action: ActionName = 'interview/schedule'
  const { resolved, body } = await readActionRequest(deps, req, action)
  const database = requireDatabase(deps)
  const gate = createAllowOnceGate(SCHEDULE_TOOL_NAME)
  // 闸门照旧：allow-once（第一次 allowed-once / 第二次 rejected / 工具名不符 unavailable）。
  // makeApprovalRequest 与工具 execute() 用的是同一个函数，语义逐字不变。
  const execContext = execOf(resolved)
  const approve: () => Promise<ApprovalDecision> = makeApprovalRequest(gate.approval, execContext)
  // 写身份与工具 execute() 的 resolveWriteActor(exec, identity, config.actor_id) 同源：
  // readActionRequest 已用同一个 identity 单例把 session → alias → actor_id 解析过一遍，
  // 所以 resolved.actor_id 就是那次写要用的 actor（产品路径永不走 legacy 回退）。
  const writeConfig: ResolvedDatabaseConfig = { ...database, actor_id: resolved.actor_id }

  // 同事务写入口：业务写（scheduleInTransaction）+ undo_log ORIGINAL 写在同一个 withActor
  // 事务 client 里。batch-undo.ts:624 的排期撤销也是调这同一个函数（既有 CANCEL 路径），
  // 这里完全复用，不重写任何排期业务规则、不新增事件类型、不动 src/runtime/**。
  // 任一写失败 → withActor 整笔 ROLLBACK：不存在"业务成功但审计没落库"的半截状态。
  const output = await withPool(database, async (pool) => withActor(pool, resolved.actor_id, async (client) => {
    const written = asRecord(await scheduleInTransaction(client, writeConfig, body, Date.now(), approve))
    const interviewId = requireOutputString(written, 'interview', 'id')
    // 幂等重放没有新写（changes 为空、replayed=true）：不造第二条 ORIGINAL（撤销窗口只对真实写开放）。
    if (written.replayed !== true && written.write === true) {
      const interview = asRecord(written.interview)
      const operation = typeof written.intent === 'string' ? written.intent : 'CREATE'
      const roundNo = typeof interview.round_no === 'number' ? interview.round_no : body.round_no
      const slotCode = typeof interview.slot_code === 'string' ? interview.slot_code : body.slot_code
      const applicationId = typeof interview.application_id === 'string'
        ? interview.application_id
        : (typeof body.application_id === 'string' ? body.application_id : null)
      // 排期 HTTP body 没有人的 confirmation_text（D-79 批准在工具内部），所以这里没有
      // 可哈希的人话。用一个服务端派生的稳定值占位：撤销时 undo 接口用的是撤销请求自己的
      // confirmation_text 算 sha256，不读这个 ORIGINAL 的 hash；这里只需非空且形如 sha256。
      const confirmationTextSha256 = sha256Text(`scheduled-by:${resolved.actor_id}:${interviewId}`)
      await insertScheduleUndoOriginal(client, {
        tenant_id: database.tenant_id,
        action_id: randomUUID(),
        actor_id: resolved.actor_id,
        // reason 只放操作摘要（CANCEL 的 reason 1..500 约束由撤销路径使用）；不抄简历/会议原文。
        reason: `面试排期（${operation}）`,
        confirmation_text_sha256: confirmationTextSha256,
        target_interview_id: interviewId,
        ...(applicationId === null ? {} : { target_application_id: applicationId }),
        before_summary: {
          operation,
          ...(roundNo === undefined ? {} : { round_no: roundNo }),
          ...(slotCode === undefined ? {} : { slot_code: slotCode }),
        },
      })
    }
    return written
  }))
  const interviewId = requireOutputString(output, 'interview', 'id')
  // 写后独立读回：事务提交后另开只读连接，不回显工具输出（既有闸门不变）。
  const readback = await withPool(database, async (pool) => withReadOnly(pool, async (client) => (
    { ...(await readbackInterview(client, database.tenant_id, interviewId)) }
  )))
  writeActionResult(res, action, resolved, gate.summary(), output, readback)
}

// =====================================================================
//  动作 5：POST transcript/import
//    复用 `recruitment_transcript_import`（人工上传路径：content + source_kind；连接器回读路径
//    只有在宿主装配了 feishu connector 时才可用，否则工具自己返回 BLOCKED/NOT_CONFIGURED）。
// =====================================================================

/** 转写导入工具名。 */
const TRANSCRIPT_TOOL_NAME = 'recruitment_transcript_import'

/**
 * `POST /recruitment/api/action/transcript/import` 的实现。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleTranscriptImport(
  deps: ActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action: ActionName = 'transcript/import'
  const { resolved, body } = await readActionRequest(deps, req, action)
  const database = requireDatabase(deps)
  const tool = createTranscriptImportTool(database, {
    identity: deps.identity,
    connector: deps.connector,
    connector_issues: deps.connectorIssues ?? [],
  })
  const output = await tool.execute(body, execOf(resolved))
  const artifactId = requireOutputString(asRecord(output), 'artifact', 'id')
  const readback = await withPool(database, async (pool) => withReadOnly(pool, async (client) => (
    { ...(await readbackArtifact(client, database.tenant_id, artifactId)) }
  )))
  writeActionResult(res, action, resolved, noApprovalSummary(), output, readback)
}

// =====================================================================
//  动作 6：POST job/rubric-approve
//    复用 `recruitment_job_rubric_approve`（写审批行 + 移动 job 指针；approval 在工具内部）。
// =====================================================================

/** rubric 批准工具名（allow-once 闸门绑定）。 */
const RUBRIC_APPROVE_TOOL_NAME = 'recruitment_job_rubric_approve'

/**
 * `POST /recruitment/api/action/job/rubric-approve` 的实现。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleRubricApprove(
  deps: ActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action: ActionName = 'job/rubric-approve'
  const { resolved, body } = await readActionRequest(deps, req, action)
  const database = requireDatabase(deps)
  const gate = createAllowOnceGate(RUBRIC_APPROVE_TOOL_NAME)
  const tool = createJobRubricApproveTool(database, { approval: gate.approval, identity: deps.identity })
  const output = await tool.execute(body, execOf(resolved))
  const outputRecord = asRecord(output)
  const approvalId = requireOutputString(outputRecord, 'approval', 'approval_id')
  const jobId = requireOutputString(outputRecord, 'job', 'id')
  const rubricVersionId = requireOutputString(outputRecord, 'rubric', 'version_id')
  const readback = await withPool(database, async (pool) => withReadOnly(pool, async (client) => (
    await readbackRubricApproval(client, database.tenant_id, approvalId, rubricVersionId, jobId)
  )))
  writeActionResult(res, action, resolved, gate.summary(), output, readback)
}

// =====================================================================
//  动作 7/8/9：POST config/role、config/team、config/pipeline（+ 统一入口 config）
//    复用 `recruitment_config_*`（企业自建配置；**写** operation 才允许，读走既有只读投影）。
//    这里不需要 approval：配置写入不是 D-79 的人类决策闸门，身份就是当前 Recruiter。
// =====================================================================

/** 配置实体封闭集。 */
type ConfigEntity = keyof typeof CONFIG_WRITE_OPERATIONS

/** 配置实体 → 动作名。 */
const CONFIG_ACTION_BY_ENTITY: Readonly<Record<ConfigEntity, ActionName>> = {
  role: 'config/role',
  team: 'config/team',
  pipeline: 'config/pipeline',
}

/** 判断一个字符串是不是配置实体。 */
function isConfigEntity(value: unknown): value is ConfigEntity {
  return value === 'role' || value === 'team' || value === 'pipeline'
}

/**
 * 校验配置动作的 operation 只允许写（读 operation 不在写入口重复暴露）。
 * @param entity - 配置实体。
 * @param operation - body.operation。
 * @returns 原样返回（收窄后的字符串）。
 */
function requireConfigWriteOperation(entity: ConfigEntity, operation: unknown): string {
  const allowed = CONFIG_WRITE_OPERATIONS[entity] as readonly string[]
  if (typeof operation !== 'string' || operation === '') {
    throw actionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "operation"', {
      missing: ['operation'],
      allowed,
    })
  }
  if (!allowed.includes(operation)) {
    throw actionHttpError(
      400,
      'INVALID_ARGS',
      'READ_OPERATION_NOT_EXPOSED',
      '本写入口只接受写 operation；读/list/get 走既有只读投影，不在 action 端点重复暴露',
      { entity, operation, allowed },
    )
  }
  return operation
}

/**
 * `POST /recruitment/api/action/config/role|team|pipeline` 的实现（统一入口 `config` 也走这里）。
 * @param deps - 路由依赖。
 * @param entity - 配置实体。
 * @param body - 已过身份键检查的 body（统一入口已剥离 entity）。
 * @param action - 动作名。
 * @param resolved - 当前执行者。
 * @param req - node 请求（未使用，保留签名一致）。
 * @param res - node 响应。
 */
async function runConfigAction(
  deps: ActionHttpDeps,
  entity: ConfigEntity,
  body: Record<string, unknown>,
  action: ActionName,
  resolved: ResolvedExecutionActor,
  res: ServerResponse,
): Promise<void> {
  const database = requireDatabase(deps)
  const operation = requireConfigWriteOperation(entity, body.operation)
  const { operation: _operation, ...rest } = body
  const args: Record<string, unknown> = { ...rest, operation }
  const tool = entity === 'role'
    ? createConfigRoleTool(database, { identity: deps.identity })
    : entity === 'team'
      ? createConfigTeamTool(database, { identity: deps.identity })
      : createConfigPipelineTool(database, { identity: deps.identity })
  const output = await tool.execute(args, execOf(resolved))
  const outputRecord = asRecord(output)
  const readback = await withPool(database, async (pool) => withReadOnly(pool, async (client) => {
    if (entity === 'role') {
      const roleId = requireOutputString(outputRecord, 'role', 'role_id')
      return { ...(await readbackRole(client, database.tenant_id, roleId)) }
    }
    if (entity === 'team') {
      const teamId = requireOutputString(outputRecord, 'team', 'team_id')
      return { ...(await readbackTeam(client, database.tenant_id, teamId)) }
    }
    const pipelineTemplateId = requireOutputString(outputRecord, 'pipeline', 'pipeline_template_id')
    return { ...(await readbackPipeline(client, database.tenant_id, pipelineTemplateId)) }
  }))
  writeActionResult(res, action, resolved, noApprovalSummary(), output, readback)
}

/**
 * `POST /recruitment/api/action/config/<entity>` 的实现。
 * @param deps - 路由依赖。
 * @param entity - 配置实体。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleConfigAction(
  deps: ActionHttpDeps,
  entity: ConfigEntity,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action = CONFIG_ACTION_BY_ENTITY[entity]
  const { resolved, body } = await readActionRequest(deps, req, action)
  await runConfigAction(deps, entity, body, action, resolved, res)
}

/**
 * `POST /recruitment/api/action/config`（统一入口：`{entity, operation, ...}`）。
 * 存在的理由：W2 的 `recruiting_settings_write` 是**一个** seam 路径（`recruiting.ts` 的
 * action key 封闭集），设置页用它一次只发一个 POST；具体实体由 body 的 `entity` 选择。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleConfigUnified(
  deps: ActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 动作名在解析 body 前未知：先走 alias 闸门（统一入口的语义仍是配置写）。
  const action: ActionName = 'config/role'
  const { resolved, body } = await readActionRequest(deps, req, action)
  const entity = body.entity
  if (entity === undefined) {
    throw actionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "entity"', {
      missing: ['entity'],
      allowed: Object.keys(CONFIG_WRITE_OPERATIONS),
    })
  }
  if (!isConfigEntity(entity)) {
    throw actionHttpError(400, 'INVALID_ARGS', 'UNKNOWN_ENTITY', 'entity 只能是 role / team / pipeline', {
      entity: typeof entity === 'string' ? entity.slice(0, 64) : `[${typeof entity}]`,
      allowed: Object.keys(CONFIG_WRITE_OPERATIONS),
    })
  }
  const { entity: _entity, ...rest } = body
  await runConfigAction(deps, entity, rest, CONFIG_ACTION_BY_ENTITY[entity], resolved, res)
}

// =====================================================================
//  三条新写动作的独立 DB 读回（transfer / constraint / job-create）
// =====================================================================

/** transfer 读回：目标申请行（含新申请 id / 候选人 / 岗位 / 生命周期 / 阶段 / 版本）。 */
interface TransferApplicationReadbackRow {
  application_id: string
  candidate_id: string
  job_id: string
  lifecycle_status: string
  current_stage_code: string
  record_version: number
}

const TRANSFER_APPLICATION_READBACK_SQL = `
  select a.id::text                    as application_id,
         a.candidate_id::text           as candidate_id,
         a.job_id::text                 as job_id,
         a.lifecycle_status,
         a.current_stage_code,
         a.record_version
    from recruitment.application a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/** constraint 读回：candidate_constraint 行（append-only 事实）。 */
interface ConstraintReadbackRow {
  constraint_id: string
  kind: string
  text: string
  source: string
  application_id: string | null
  interview_id: string | null
  created_by_actor_id: string
  record_version: number
}

const CONSTRAINT_READBACK_SQL = `
  select c.id::text                       as constraint_id,
         c.kind,
         c.text,
         c.source,
         c.application_id::text           as application_id,
         c.interview_id::text             as interview_id,
         c.created_by_actor_id::text      as created_by_actor_id,
         c.record_version
    from recruitment.candidate_constraint c
   where c.id = $1::uuid and c.tenant_id = $2::uuid
`

/** job/create 读回：job 行 + 当前 job_version 行。 */
interface JobCreateJobReadbackRow {
  job_id: string
  code: string
  title: string
  status: string
  current_job_version_id: string | null
  record_version: number
}

interface JobCreateVersionReadbackRow {
  version_id: string
  version_no: number
  payload_hash: string
}

const JOB_CREATE_READBACK_SQL = `
  select j.id::text                       as job_id,
         j.code,
         j.title,
         j.status,
         j.current_job_version_id::text   as current_job_version_id,
         j.record_version
    from recruitment.job j
   where j.id = $1::uuid and j.tenant_id = $2::uuid
`

const JOB_CREATE_VERSION_READBACK_SQL = `
  select v.id::text        as version_id,
         v.version_no,
         v.payload_hash
    from recruitment.job_version v
   where v.id = $1::uuid and v.tenant_id = $2::uuid
`

/**
 * 读回 transfer 的目标申请 + 携带历史行数（行数按 application_id + tenant_id）。
 */
async function readbackTransfer(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<Record<string, unknown>> {
  const app = await client.query<TransferApplicationReadbackRow>(TRANSFER_APPLICATION_READBACK_SQL, [applicationId, tenantId])
  const refs = await client.query<{ carry_over_count: number }>(
    `select count(*)::int as carry_over_count
       from recruitment.application_carry_over
      where application_id = $1::uuid and tenant_id = $2::uuid`,
    [applicationId, tenantId],
  )
  return {
    ...requireRow(app.rows, 'application', { application_id: applicationId }),
    carry_over_count: refs.rows[0]?.carry_over_count ?? 0,
  }
}

/** 读回一条 candidate_constraint 行。 */
async function readbackConstraint(
  client: DatabaseClient,
  tenantId: string,
  constraintId: string,
): Promise<ConstraintReadbackRow> {
  const { rows } = await client.query<ConstraintReadbackRow>(CONSTRAINT_READBACK_SQL, [constraintId, tenantId])
  return requireRow(rows, 'candidate_constraint', { constraint_id: constraintId })
}

/** 读回新建岗位 + 当前版本行。 */
async function readbackJobCreate(
  client: DatabaseClient,
  tenantId: string,
  jobId: string,
  versionId: string,
): Promise<Record<string, unknown>> {
  const job = await client.query<JobCreateJobReadbackRow>(JOB_CREATE_READBACK_SQL, [jobId, tenantId])
  const version = await client.query<JobCreateVersionReadbackRow>(JOB_CREATE_VERSION_READBACK_SQL, [versionId, tenantId])
  return {
    job: requireRow(job.rows, 'job', { job_id: jobId }),
    job_version: requireRow(version.rows, 'job_version', { version_id: versionId }),
  }
}

// =====================================================================
//  动作 10：POST application/transfer（跨岗调剂）
//    复用 `ensureActiveApplication`（建/复用目标申请）+ `db/carry-over.ts` 三件套（历史携带）。
//    源申请只读；actor 来自 session 绑定；全部在一个 withActor 事务里。
// =====================================================================

/** 从 body 取必填 UUID（缺失/非字符串/非 UUID → 400 MISSING_REQUIRED / INVALID_ARGS）。 */
function requireBodyUuid(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value === '') {
    throw actionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', `缺必填字段 "${key}"`, { missing: [key] })
  }
  if (!isUuid(value)) {
    throw actionHttpError(400, 'INVALID_ARGS', 'INVALID_UUID', `字段 "${key}" 必须是 UUID`, { path: key })
  }
  return value
}

/**
 * 校验并取 confirmation_text（必填、非空字符串），返回服务端计算的 sha256。
 * 派生键 `confirmation_text_sha256` 已在 rejectBodyOverrides 里全局禁掉。
 */
function requireConfirmationSha256(body: Record<string, unknown>): string {
  const text = body.confirmation_text
  if (typeof text !== 'string' || text.trim() === '') {
    throw actionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "confirmation_text"（人点原话）', {
      missing: ['confirmation_text'],
    })
  }
  return sha256Text(text)
}

/**
 * `POST /recruitment/api/action/application/transfer` 的实现。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleApplicationTransfer(
  deps: ActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action: ActionName = 'application/transfer'
  const { resolved, body } = await readActionRequest(deps, req, action)
  const database = requireDatabase(deps)
  const confirmationSha256 = requireConfirmationSha256(body)
  const applicationId = requireBodyUuid(body, 'application_id')
  const targetJobId = requireBodyUuid(body, 'target_job_id')
  const refs = parseCarryOverRefs(body.carry_over_refs)

  // 写配置：`actor_id` 只来自 session → alias 解析（不读 body/query/header）。
  const writeConfig: ResolvedDatabaseConfig = { ...database, actor_id: resolved.actor_id }
  const result = await withPool(database, async (pool) => withActor(pool, writeConfig.actor_id, async (client) => {
    // 1) 源申请只读：candidate_id + resume_version_id（租户隔离，缺失 → 404）。
    const source = await client.query<{ candidate_id: string; resume_version_id: string | null }>(
      `select candidate_id::text as candidate_id, resume_version_id::text as resume_version_id
         from recruitment.application
        where id = $1::uuid and tenant_id = $2::uuid`,
      [applicationId, writeConfig.tenant_id],
    )
    const sourceRow = source.rows[0]
    if (sourceRow === undefined) {
      throw actionHttpError(404, 'NOT_FOUND', 'SOURCE_APPLICATION_NOT_FOUND', '源申请不在本租户下或不存在', {
        application_id: applicationId,
      })
    }
    if (sourceRow.resume_version_id === null) {
      throw actionHttpError(404, 'NOT_FOUND', 'SOURCE_RESUME_VERSION_NOT_FOUND', '源申请没有 resume_version_id，无法跨岗调剂', {
        application_id: applicationId,
      })
    }

    // 2) 目标岗位只读 + 已批准 rubric 钉法（与 intake 一致，不复制 SQL / 判定）。
    const job = await loadJob(client, writeConfig.tenant_id, targetJobId)
    if (job.current_job_version_id === null) {
      throw actionHttpError(404, 'NOT_FOUND', 'JOB_VERSION_NOT_FOUND', '目标岗位还没有 job_version', { job_id: targetJobId })
    }
    const pinnableRubricVersionId = await resolvePinnableRubricVersion(
      client, writeConfig.tenant_id, job.id, job.current_rubric_version_id,
    )

    // 3) 建/复用目标申请（同候选人、同 resume 版本，actor 来自 session 绑定）。
    const application = await ensureActiveApplication(client, {
      tenantId: writeConfig.tenant_id,
      candidateId: sourceRow.candidate_id,
      jobId: targetJobId,
      jobVersionId: job.current_job_version_id,
      resumeVersionId: sourceRow.resume_version_id,
      rubricVersionId: pinnableRubricVersionId,
    })

    // 4) 历史引用（可选）：形状/归属校验 + 幂等插入，全在同一事务。
    let inserted = 0
    if (refs !== undefined && refs.length > 0) {
      await validateCarryOverRefs(client, writeConfig.tenant_id, application.id, refs)
      inserted = await insertCarryOverRefs(client, writeConfig.tenant_id, application.id, refs, writeConfig.actor_id)
    }

    return {
      application_id: application.id,
      candidate_id: sourceRow.candidate_id,
      application_action: application.action,
      confirmation_text_sha256: confirmationSha256,
      carry_over: { requested: refs?.length ?? 0, inserted },
    }
  }))

  const readback = await withPool(database, async (pool) => withReadOnly(pool, async (client) => (
    await readbackTransfer(client, database.tenant_id, result.application_id)
  )))
  writeActionResult(res, action, resolved, noApprovalSummary(), result, readback)
}

// =====================================================================
//  动作 11：POST candidate/constraint（候选人约束 PIN/UNPIN/HANDOFF）
//    直接复用 `createCandidateConstraintTool(...).execute`，不复制约束写入逻辑。
// =====================================================================

/**
 * `POST /recruitment/api/action/candidate/constraint` 的实现。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleCandidateConstraint(
  deps: ActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action: ActionName = 'candidate/constraint'
  const { resolved, body } = await readActionRequest(deps, req, action)
  const database = requireDatabase(deps)
  requireConfirmationSha256(body)

  // 剥离 confirmation_text；args 不含任何身份键（rejectBodyOverrides 已保证）。
  const { confirmation_text: _confirmationText, ...args } = body
  const tool = createCandidateConstraintTool({ database, identity: deps.identity })
  const output = await tool.execute(args, execOf(resolved))
  const constraintId = requireOutputString(asRecord(output), 'constraint_id')
  const readback = await withPool(database, async (pool) => withReadOnly(pool, async (client) => (
    { ...(await readbackConstraint(client, database.tenant_id, constraintId)) }
  )))
  writeActionResult(res, action, resolved, noApprovalSummary(), output, readback)
}

// =====================================================================
//  动作 12：POST job/create（新建岗位）
//    直接复用 `createJobCreateTool(...).execute`；rubric 保持 PENDING，不调用 approve。
// =====================================================================

/**
 * `POST /recruitment/api/action/job/create` 的实现。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleJobCreate(
  deps: ActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action: ActionName = 'job/create'
  const { resolved, body } = await readActionRequest(deps, req, action)
  const database = requireDatabase(deps)
  requireConfirmationSha256(body)

  // 标题必填（域层也有校验，这里先给明确的缺失错误）。
  const title = body.title
  if (typeof title !== 'string' || title.trim() === '') {
    throw actionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "title"', { missing: ['title'] })
  }
  // headcount 在 recruitment.requisition 表，不在 job 表；job_create 域路径只接受可选
  // requisition_id（链接已有需求单），本接口不创建需求单。若静默接受 headcount 会返回
  // 200 但 HC 没落库、界面却显示已填 —— 那是假报（R4 / docs/29 ASYNC-2 同类）。
  // 因此明确拒绝，人话告知人去需求单维护 HC（零写入）。
  if (Object.hasOwn(body, 'headcount')) {
    throw actionHttpError(
      400,
      'INVALID_ARGS',
      'UNSUPPORTED_FIELD',
      'headcount 由岗位需求单（requisition）维护，建岗接口不接收；请先建需求单再关联（零写入）',
      { field: 'headcount' },
    )
  }

  // 剥离 confirmation_text；dept → department_id / department_name（UUID → id，否则 → name）。
  const { confirmation_text: _confirmationText, dept, ...rest } = body
  const args: Record<string, unknown> = { ...rest }
  if (dept !== undefined) {
    if (typeof dept !== 'string' || dept.trim() === '') {
      throw actionHttpError(400, 'INVALID_ARGS', 'INVALID_ARGS', 'dept 必须是非空字符串', { path: 'dept' })
    }
    if (isUuid(dept)) args.department_id = dept
    else args.department_name = dept
  }

  const tool = createJobCreateTool(database, { identity: deps.identity })
  const output = await tool.execute(args, execOf(resolved))
  const outputRecord = asRecord(output)
  const jobId = requireOutputString(outputRecord, 'job', 'id')
  const versionId = requireOutputString(outputRecord, 'job_version', 'id')
  const readback = await withPool(database, async (pool) => withReadOnly(pool, async (client) => (
    await readbackJobCreate(client, database.tenant_id, jobId, versionId)
  )))
  writeActionResult(res, action, resolved, noApprovalSummary(), output, readback)
}

// =====================================================================
//  注册入口
// =====================================================================

/** 回环地址判据（只接受 127.0.0.1 / ::1；其余地址不注册路由）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/**
 * 把一个 handler 包成「同源 loopback + 只接受 POST」的 exact 路由处理函数。
 * @param port - 本机 Web 监听端口（sameOrigin 用）。
 * @param handle - 动作处理函数。
 */
function postRoute(
  port: number,
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    assertSameOrigin(req, port)
    rejectQueryOrHeaderOverrides(req, url)
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await handle(req, res)
  })
}

/**
 * 注册 D5 全部写操作 Host Remote Action；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警（fail-closed：写动作绝不挂到网络可达地址）。
 * 13 条 exact 路由（9 个既有动作端点 + 1 个设置统一入口 + 3 条新写动作
 * transfer / constraint / job-create；见文件头与 CONTRACT.md）。
 * @param ctx - 宿主上下文（含 webServer 服务）。
 * @param deps - 库配置 + Demo Actor 身份（与工具共享的同一个实例）+ 可选连接器。
 * @returns 注销函数。
 */
export function registerActionsHttp(ctx: ActionHostContext, deps: ActionHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 写动作路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const routes: readonly (readonly [string, (req: IncomingMessage, res: ServerResponse) => Promise<void>])[] = [
    [ACTION_PATHS.screeningDecide, postRoute(port, (req, res) => handleDecisionAction(deps, 'screening', 'screening/decide', req, res))],
    [ACTION_PATHS.decisionRecord, postRoute(port, (req, res) => handleDecisionAction(deps, 'record', 'decision/record', req, res))],
    [ACTION_PATHS.stageAdvance, postRoute(port, (req, res) => handleStageAdvance(deps, req, res))],
    [ACTION_PATHS.interviewSchedule, postRoute(port, (req, res) => handleInterviewSchedule(deps, req, res))],
    [ACTION_PATHS.transcriptImport, postRoute(port, (req, res) => handleTranscriptImport(deps, req, res))],
    [ACTION_PATHS.rubricApprove, postRoute(port, (req, res) => handleRubricApprove(deps, req, res))],
    [ACTION_PATHS.configRole, postRoute(port, (req, res) => handleConfigAction(deps, 'role', req, res))],
    [ACTION_PATHS.configTeam, postRoute(port, (req, res) => handleConfigAction(deps, 'team', req, res))],
    [ACTION_PATHS.configPipeline, postRoute(port, (req, res) => handleConfigAction(deps, 'pipeline', req, res))],
    [ACTION_PATHS.config, postRoute(port, (req, res) => handleConfigUnified(deps, req, res))],
    [ACTION_PATHS.applicationTransfer, postRoute(port, (req, res) => handleApplicationTransfer(deps, req, res))],
    [ACTION_PATHS.candidateConstraint, postRoute(port, (req, res) => handleCandidateConstraint(deps, req, res))],
    [ACTION_PATHS.jobCreate, postRoute(port, (req, res) => handleJobCreate(deps, req, res))],
  ]
  const disposers = routes.map(([path, handler]) => webServer.register({ kind: 'exact', path, handler }))
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
