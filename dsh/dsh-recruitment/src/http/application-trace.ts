// Issue #46 / G-15 · 决策追责时间线的**只读**宿主路由 + 人话投影。
//
// 端点：GET /recruitment/api/recruiting/applications/:applicationId/trace
//
// 纪律（与 `recruiting.ts` / `candidate-dedup.ts` 同一口径）：
//   · 只读：所有查询走 `withReadOnly`（`begin transaction read only`），任何写被 PG 25006 拒绝；
//   · 严格 loopback + `sameOrigin()`（overview.ts 唯一实现）+ `X-DSH-Session`（session→alias→HUMAN
//     actor 必须已绑定，未绑定 409；identity 只来自插件配置）；
//   · actor/tenant 覆盖参数与未知 query 键 → 400，且在碰库之前失败（fail-closed）；
//   · 投影零 UUID / 零完整 sha256 / 零「证据」二字：items.id 是稳定的短序号键，
//     actor_label 是别名人话，detail 只含阶段 / 版本 / 步骤事实；
//   · 复用 `domain/trace.ts::loadTrace(client, tenantId, 'APPLICATION', applicationId)`；
//     不新建事实表、不新增工具、不写库。
//
// 路由注册说明（宿主 webServer：exact 表 → 最长前缀 → fallback；同 (kind,path) 重复注册抛错）：
//   `RECRUITING_ROUTE_PREFIX` 已由 recruiting.ts 占用；`.../applications` 由本模块独占注册
//   （candidate-dedup.ts 的注册点改由本模块托管）。注册路径不带尾斜杠——宿主匹配
//   `pathname.startsWith(`${prefix}/`)`。本 handler 只分派两类路径：
//     `/applications/:id/trace`  → 本文件的追责时间线；
//     其它（含 `/duplicates` 与普通 `/applications/:id` 详情）→ 原样转交 candidate-dedup
//     的 handler（它已把普通详情回退到 readApplicationDetail，并带同值 action seam）。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
} from '../demo-actor/session-registry.ts'
import {
  resolveSessionActor,
  type DemoActorIdentity,
} from '../demo-actor/resolve.ts'
import { loadTrace, TraceQueryError, type TraceResult, type TraceRing } from '../domain/trace.ts'
import { isValidApplicationId } from '../domain/candidate-dedup.ts'
import { sameOrigin } from './overview.ts'
import { RECRUITING_ROUTE_PREFIX } from './recruiting.ts'
import {
  registerCandidateDedupHttp,
  type CandidateDedupHostContext,
} from './candidate-dedup.ts'

// ---------------------------------------------------------------------
//  冻结契约
// ---------------------------------------------------------------------

export const APPLICATION_TRACE_CONTRACT_VERSION = 'application-trace 1.0.0'
/** 解析常量（保留尾斜杠，便于拼路径）；实际注册路径见 `APPLICATION_TRACE_REGISTER_PREFIX`。 */
export const APPLICATION_TRACE_ROUTE_PREFIX = `${RECRUITING_ROUTE_PREFIX}/applications/`
/** 注册路径（**不带尾斜杠**：宿主会做 `pathname.startsWith(`${prefix}/`)`）。 */
export const APPLICATION_TRACE_REGISTER_PREFIX = APPLICATION_TRACE_ROUTE_PREFIX.replace(/\/$/, '')
/** 精确路径尾缀（用于测试与文档；`:applicationId` 是占位符）。 */
export const APPLICATION_TRACE_PATH_TEMPLATE = `${APPLICATION_TRACE_ROUTE_PREFIX}:applicationId/trace`
/** 时间线尾缀。 */
const TRACE_SUFFIX = '/trace'

export interface ApplicationTraceItem {
  /** 稳定短序号键（如 `T1`）：**不是**库里的 UUID。 */
  readonly id: string
  /** ISO-8601 时间；该环无时间时为 null（不编时间）。 */
  readonly at: string | null
  /** 环节类别（机器码，人可读，如 DECISION / TOOL_CALL）。 */
  readonly kind: string
  /** 人话事件标题（如「初筛通过」）。 */
  readonly title: string
  /** 人话操作人（如「招聘负责人」）；不可解析的 actor 用「系统记录」，绝不回显 UUID。 */
  readonly actor_label: string
  /** 人话摘要：阶段 / 版本 / 步骤事实；不含 UUID 与完整哈希。 */
  readonly detail: string
}

export interface ApplicationTraceResponse {
  readonly contract_version: string
  readonly application_id: string
  readonly items: ReadonlyArray<ApplicationTraceItem>
  readonly integrity_ok: boolean
}

// ---------------------------------------------------------------------
//  人话投影（纯函数；单测可直接覆盖）
// ---------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const SHA256_RE = /\b[0-9a-f]{64}\b/gi

/** 兜底脱敏：即使上游 refs 带入 id/哈希，也不让它们出现在人话文案里。 */
export function scrubHumanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(UUID_RE, '［已隐藏］')
    .replace(SHA256_RE, '［已隐藏］')
    .replace(/证据/g, '依据')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** actor UUID → 人话别名；未知 actor 一律「系统记录」（不回显 UUID）。 */
export function humanActorLabel(
  actorId: string | undefined,
  identity?: DemoActorIdentity,
): string {
  if (actorId === undefined || actorId === '') return '系统记录'
  const labels: Readonly<Record<string, string>> = {
    recruiter: '招聘负责人',
    interviewer_a: '面试官 A',
    interviewer_b: '面试官 B',
  }
  if (identity !== undefined) {
    for (const [alias, mapped] of Object.entries(identity.actors)) {
      if (mapped === actorId && labels[alias] !== undefined) return labels[alias]
    }
  }
  // 已知 UUID 但不在 alias 映射里：仍不回显，只给一个诚实的人话占位。
  return '系统记录'
}

/** 环节类别 → 人话标题（结果状态只作为补充事实，不编造业务结论）。 */
const RING_TITLES: Readonly<Record<string, string>> = {
  APPLICATION: '提交申请',
  INTERVIEW: '安排面试',
  EVENT: '收到流程事件',
  BUSINESS_TASK: '创建待办任务',
  TASK_ATTEMPT: '执行任务',
  AGENT_SESSION: '记录处理过程',
  TOOL_CALL: '运行一次处理步骤',
  DURABLE_EFFECT: '完成外部动作',
  RECEIPT: '收到外部回执',
  DECISION: '记录人工决定',
}

const RESULT_TITLES: Readonly<Record<string, string>> = {
  ADVANCE: '初筛通过',
  REJECT: '未通过',
  HOLD: '暂缓',
  WITHDRAW: '撤回',
  HIRE: '录用',
  SUCCEEDED: '处理完成',
  FAILED: '处理失败',
  CONFIRMED: '已确认',
}

/** 只读 refs 里的白名单事实键（永不取 id / hash / payload）。 */
const DETAIL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['current_stage_code', '阶段'],
  ['lifecycle_status', '状态'],
  ['decision_scope', '决定范围'],
  ['stage_code', '阶段'],
  ['task_type', '任务'],
  ['tool_name', '步骤'],
  ['effect_type', '动作'],
  ['model_route', '模型路由'],
  ['readback_state', '回读状态'],
  ['outcome', '结果'],
  ['provider', '来源'],
  ['trust_level', '信任级别'],
  ['version_no', '版本'],
  ['duration_ms', '耗时(毫秒)'],
]

function detailFromRing(ring: TraceRing): string {
  const parts: string[] = []
  if (ring.state !== undefined && ring.state !== '') parts.push(`状态 ${ring.state}`)
  if (ring.refs !== undefined && typeof ring.refs === 'object') {
    const refs = ring.refs as Record<string, unknown>
    for (const [key, label] of DETAIL_KEYS) {
      const value = refs[key]
      if (typeof value === 'string' && value !== '') parts.push(`${label} ${value}`)
      else if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${label} ${value}`)
    }
  }
  if (parts.length === 0) parts.push('按流程记录的事实')
  return scrubHumanText(parts.join('，'))
}

function titleFromRing(ring: TraceRing): string {
  const state = typeof ring.state === 'string' ? ring.state : ''
  const result = RESULT_TITLES[state] ?? state
  const base = RING_TITLES[ring.ring] ?? '记录一次流转'
  // state 是封闭枚举时用人话结果覆盖；未知 state 只作为补充，不编业务结论。
  if (ring.ring === 'DECISION' && result !== state && state !== '') return scrubHumanText(result)
  if (ring.ring === 'TOOL_CALL' && result !== state && state !== '') return scrubHumanText(`处理步骤${result}`)
  return base
}

/** loadTrace 结果 → 人话时间线（零 UUID / 零完整 sha256 / 零「证据」）。 */
export function projectApplicationTrace(
  result: TraceResult,
  identity?: DemoActorIdentity,
): ApplicationTraceResponse {
  const items = result.rings.map((ring, index) => ({
    id: `T${index + 1}`,
    at: ring.at ?? null,
    kind: ring.ring,
    title: titleFromRing(ring),
    actor_label: humanActorLabel(ring.actor_id, identity),
    detail: detailFromRing(ring),
  }))
  return {
    contract_version: APPLICATION_TRACE_CONTRACT_VERSION,
    application_id: result.object.id,
    items,
    integrity_ok: result.integrity.ok,
  }
}

// ---------------------------------------------------------------------
//  HTTP 层
// ---------------------------------------------------------------------

interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface ApplicationTraceHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

export type TraceLoader = (
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
) => Promise<TraceResult>

export interface ApplicationTraceHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly identity: DemoActorIdentity
  readonly databaseIssues?: ReadonlyArray<string>
  /** 测试注入：只读执行器（生产走 createPool + withReadOnly）。 */
  readonly runReadOnly?: <T>(fn: (client: DatabaseClient) => Promise<T>) => Promise<T>
  /** 测试注入：替身 loader（必须只读）。 */
  readonly loadTraceData?: TraceLoader
  /** 测试注入：替身去重 handler（生产由 registerCandidateDedupHttp 捕获）。 */
  readonly duplicatesHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

class TraceHttpProblem extends Error {
  readonly status: number
  readonly code: string
  readonly reasonCode: string | null
  readonly detail?: Readonly<Record<string, unknown>>

  constructor(status: number, code: string, reasonCode: string | null, message: string, detail?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'TraceHttpProblem'
    this.status = status
    this.code = code
    this.reasonCode = reasonCode
    this.detail = detail
  }
}

function problem(status: number, code: string, reasonCode: string | null, message: string, detail?: Readonly<Record<string, unknown>>): never {
  throw new TraceHttpProblem(status, code, reasonCode, message, detail)
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function errorBody(error: unknown): { status: number; body: unknown } {
  if (error instanceof TraceHttpProblem) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          ...(error.reasonCode === null ? {} : { reason_code: error.reasonCode }),
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        },
      },
    }
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } } }
}

/**
 * 从已注册前缀下解析 `/trace` 路径；非 `/trace` 一律交回 dedup handler（包括
 * `/duplicates` 与普通申请详情）。不匹配 / 含额外路径段 → null。
 */
function parseTracePath(pathname: string): string | null {
  const prefix = APPLICATION_TRACE_REGISTER_PREFIX
  if (!pathname.startsWith(`${prefix}/`)) return null
  const rest = pathname.slice(prefix.length + 1)
  if (rest === '' || !rest.endsWith(TRACE_SUFFIX) || rest.includes('//')) return null
  const encodedId = rest.slice(0, -TRACE_SUFFIX.length)
  if (encodedId === '' || encodedId.includes('/')) return null
  try {
    return decodeURIComponent(encodedId)
  } catch {
    return null
  }
}

function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    problem(
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
 * 注册追责时间线路由（返回 disposer）。
 *
 * 非回环 host 不注册（fail-closed）；数据库未配置时 503。
 * 非 `/trace`（含 `/duplicates` 与普通申请详情）原样交给 candidate-dedup 的 handler，
 * 它已把普通详情回退到 readApplicationDetail，故既有读模型完全不变。
 */
export function registerApplicationTraceHttp(
  ctx: ApplicationTraceHostContext,
  deps: ApplicationTraceHttpDeps,
): () => void {
  const { webServer } = ctx
  if (webServer.host !== '127.0.0.1' && webServer.host !== '::1') {
    ctx.logger?.warn(`recruitment: application-trace 路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0

  // 托管 candidate-dedup 的 handler：用窄 stub 捕获它，不在 index.ts 重复注册同一 prefix。
  let disposeDuplicates: () => void = () => {}
  let dedupHandler = deps.duplicatesHandler
  if (dedupHandler === undefined) {
    const stubCtx: CandidateDedupHostContext = {
      webServer: {
        host: webServer.host,
        port: webServer.port,
        register(route) {
          dedupHandler = route.handler
          return () => { dedupHandler = undefined }
        },
      },
      logger: ctx.logger,
    }
    disposeDuplicates = registerCandidateDedupHttp(stubCtx, {
      database: deps.database,
      databaseIssues: deps.databaseIssues,
      identity: deps.identity,
    })
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const applicationId = parseTracePath(url.pathname)

      // 1. 非 /trace（普通详情、/duplicates、未知子路径）原样转交 dedup handler；
      //    它内部已做同源/session 闸门、普通详情回退与 404，行为与既有路由完全一致。
      if (applicationId === null) {
        if (dedupHandler === undefined) {
          json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
          return
        }
        await dedupHandler(req, res)
        return
      }

      // 2. /trace：方法 → 同源/session → 封闭 query → id 形状 → 未配置 → 只读查询。
      if (req.method !== 'GET') {
        problem(400, 'INVALID_ARGS', 'METHOD_NOT_ALLOWED', '只支持 GET')
      }
      if (!sameOrigin(req, port)) {
        problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', 'same-origin loopback request required')
      }
      const sessionId = readSessionHeader(req)
      try {
        resolveSessionActor(deps.identity, sessionId)
      } catch (error) {
        problem(409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND', `X-DSH-Session 未绑定执行身份：${error instanceof Error ? error.message : String(error)}`)
      }
      for (const key of url.searchParams.keys()) {
        problem(400, 'INVALID_ARGS', key === 'actor_id' || key === 'tenant_id' ? 'ACTOR_OVERRIDE_REJECTED' : 'UNKNOWN_PARAM', `查询串包含未定义的键：${key}`)
      }
      if (!isValidApplicationId(applicationId)) {
        problem(400, 'INVALID_ARGS', 'ID_INVALID', 'applicationId 缺省或非法')
      }
      if (deps.database === null) {
        problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置', { issues: [...(deps.databaseIssues ?? [])] })
      }

      const tenantId = deps.database.tenant_id
      const loader: TraceLoader = deps.loadTraceData
        ?? ((client, tenant, applicationId) => loadTrace(client, {
          tenantId: tenant,
          objectType: 'APPLICATION',
          objectId: applicationId,
        }))
      const runReadOnly = deps.runReadOnly
        ?? (async <T,>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> => {
          const pool = createPool(deps.database as ResolvedDatabaseConfig)
          try {
            return await withReadOnly(pool, fn)
          } finally {
            await closePool(pool)
          }
        })
      let trace: TraceResult
      try {
        trace = await runReadOnly((client) => loader(client, tenantId, applicationId))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof TraceQueryError && error.code === 'NOT_FOUND'
          || message.startsWith('NOT_FOUND:')) {
          problem(404, 'NOT_FOUND', 'APPLICATION_NOT_FOUND', `application ${applicationId} 没有可追责记录`)
        }
        throw error
      }
      json(res, 200, projectApplicationTrace(trace, deps.identity))
    } catch (error) {
      const { status, body } = errorBody(error)
      json(res, status, body)
    }
  }

  const disposeTrace = webServer.register({
    kind: 'prefix',
    path: APPLICATION_TRACE_REGISTER_PREFIX,
    handler,
  })
  return () => {
    disposeTrace()
    disposeDuplicates()
  }
}
