// Issue #36 / G-10 · 候选人去重提示的**只读**宿主路由。
//
// 端点：
//   GET /recruitment/api/recruiting/applications/:applicationId/duplicates
//
// 硬约束：
//   · 只读：默认在 `withReadOnly`（`begin transaction read only`）里跑 SELECT，任何写会被 PG 25006 拒绝；
//   · 严格同源 + loopback：非回环 host **不注册**（fail-closed）；每请求 Host 必须命中本机端口、
//     带 `x-recruitment-request: 1`、Origin（若带）必须同源；身份**只来自** `X-DSH-Session`
//     → session→alias→HUMAN actor（未绑定 409 `DEMO_ACTOR_UNMAPPED`，零写入）；
//   · 排除自身（applicationId / candidateId）、非法 id fail-closed（400）、未知 query 键拒绝；
//   · PII 不明文：手机 / 邮箱只返回脱敏提示（由 domain 模块计算），不返回原值；
//   · 不修改 `src/index.ts`：只导出 `registerCandidateDedupHttp`，接线行见交付报告。
//
// 路由注册用 `kind: 'prefix'` 挂在 `${RECRUITING_ROUTE_PREFIX}/applications/`，与
// `registerRecruitingHttp` 的 `${RECRUITING_ROUTE_PREFIX}` 前缀共存（最长前缀优先）；
// handler 内部用**精确正则**匹配 `.../:id/duplicates`，其它路径直接 404，零副作用。
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
import {
  findDuplicateCandidates,
  isValidApplicationId,
  maskEmail,
  maskPhone,
  type DedupCandidateFact,
  type DuplicateMatch,
} from '../domain/candidate-dedup.ts'
import {
  readApplicationDetail,
  type RecruitingActionSeams,
} from './recruiting.ts'

// ---------------------------------------------------------------------
//  冻结契约
// ---------------------------------------------------------------------

/** 契约版本（响应首字段；客户端据此判形态）。 */
export const CANDIDATE_DEDUP_CONTRACT_VERSION = 'candidate-dedup 1.0.0'
/** 路由前缀（ Recruiting Workspace 共用，最长前缀优先）。 */
export const CANDIDATE_DEDUP_ROUTE_PREFIX = '/recruitment/api/recruiting'
/** 精确路径模板（`:applicationId` 是占位符，不是字面量）。 */
export const CANDIDATE_DEDUP_PATH_TEMPLATE = `${CANDIDATE_DEDUP_ROUTE_PREFIX}/applications/:applicationId/duplicates`
/** 注册用的 prefix（path 参数必须从这里解析）。 */
export const CANDIDATE_DEDUP_REGISTER_PREFIX = `${CANDIDATE_DEDUP_ROUTE_PREFIX}/applications/`

/**
 * 本 prefix 接管 `/applications/:id` 时回退申请详情所需的 action seams。
 *
 * 宿主路由是「最长前缀优先」：注册 `/applications/` 后，普通的
 * `GET /recruitment/api/recruiting/applications/:id` 也会先命中本 handler。
 * 为了不吞掉既有申请详情（候选人页依赖它），非 `/duplicates` 的
 * `/applications/:id` 必须原样回退 `readApplicationDetail`。
 *
 * 该字面量与 `src/index.ts` 的注册 seam 同值；若接线层改 seam，需要同步。
 */
const FALLBACK_ACTION_SEAMS: RecruitingActionSeams = {
  screening_decide: '/recruitment/api/action/screening/decide',
  stage_advance: '/recruitment/api/action/stage/advance',
  decision_record: '/recruitment/api/action/decision/record',
  interview_schedule: '/recruitment/api/action/interview/schedule',
  transcript_import: '/recruitment/api/action/transcript/import',
  rubric_approve: '/recruitment/api/action/job/rubric-approve',
  recruiting_settings_write: '/recruitment/api/action/config',
}

/** GET `/.../duplicates` 的响应（不含手机 / 邮箱原值）。 */
export interface CandidateDuplicatesResponse {
  readonly contract_version: string
  readonly evaluated_at: string
  readonly application_id: string
  /** 疑似同一人的其它申请（排除自身；空数组 = 未发现）。 */
  readonly duplicates: ReadonlyArray<DuplicateMatch>
  /**
   * 当前申请自身的脱敏提示（只有种类 + 掩码，不给原文）。
   * 没有可用手机 / 邮箱时对应字段为 null；仅供 HR 核对 UI 展示。
   */
  readonly subject_hints: {
    readonly phone: string | null
    readonly email: string | null
  }
}

/** 宿主侧用到的最小 `webServer` 面（与 recruiting.ts 一致）。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 宿主上下文窄接口。 */
export interface CandidateDedupHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 一次只读载入：由调用方给 client（生产路径由 withReadOnly 保证只读）。 */
export type LoadDedupFacts = (
  client: DatabaseClient,
  tenantId: string,
) => Promise<ReadonlyArray<DedupCandidateFact>>

/** 依赖注入（便于无库单测；默认 loader 走真库 SELECT）。 */
export interface CandidateDedupHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly identity: DemoActorIdentity
  /** 未配置时的缺失项（只回显变量名，不含密码）。 */
  readonly databaseIssues?: ReadonlyArray<string>
  /**
   * 覆盖只读数据载入（测试用）。生产路径不传：默认 `createPool + withReadOnly + loadFactsFromDb`。
   * 注入实现必须**只含 SELECT**；handler 本身不执行任何写。
   */
  readonly loadFacts?: LoadDedupFacts
  /**
   * 覆盖只读事务执行器（测试用，便于断言「零写入」）。默认 `createPool + withReadOnly + closePool`。
   */
  readonly runReadOnly?: <T>(fn: (client: DatabaseClient) => Promise<T>) => Promise<T>
}

// ---------------------------------------------------------------------
//  默认只读载入（SQL 只 SELECT，全部按 tenant_id 收口）
// ---------------------------------------------------------------------

interface DedupFactRow {
  readonly application_id: string
  readonly candidate_id: string
  readonly display_name: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly channel_id: string | null
  readonly channel_name: string | null
  readonly history_keys: readonly string[] | null
}

const LOAD_FACTS_SQL = `
  select
    a.id::text as application_id,
    a.candidate_id::text as candidate_id,
    c.display_name,
    c.normalized_phone as phone,
    c.normalized_email as email,
    a.channel_id::text as channel_id,
    ch.name as channel_name,
    (
      select coalesce(array_agg('MERGED:' || cm.merged_candidate_id::text), '{}')
      from recruitment.candidate_merge cm
      where cm.tenant_id = a.tenant_id
        and (cm.surviving_candidate_id = a.candidate_id or cm.merged_candidate_id = a.candidate_id)
    ) as history_keys
  from recruitment.application a
  join recruitment.candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
  left join recruitment.acquisition_channel ch on ch.id = a.channel_id and ch.tenant_id = a.tenant_id
  where a.tenant_id = $1
  order by a.applied_at desc, a.id
  limit 500
`

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 默认事实载入：一条 SELECT，只读；把库里的规范化字段交给 domain 纯函数再做一次归一化。
 * @param client - 只读事务里的 DB client。
 * @param tenantId - 租户 id（只来自插件配置）。
 * @returns 候选人事实数组。
 */
export async function loadFactsFromDb(client: DatabaseClient, tenantId: string): Promise<DedupCandidateFact[]> {
  const result = await client.query<DedupFactRow>(LOAD_FACTS_SQL, [tenantId])
  return result.rows.map((row) => ({
    applicationId: row.application_id,
    candidateId: row.candidate_id,
    displayName: asStringOrNull(row.display_name),
    phone: asStringOrNull(row.phone),
    email: asStringOrNull(row.email),
    channelId: asStringOrNull(row.channel_id),
    channelName: asStringOrNull(row.channel_name),
    historyKeys: Array.isArray(row.history_keys) ? row.history_keys : [],
  }))
}

// ---------------------------------------------------------------------
//  HTTP 层
// ---------------------------------------------------------------------

/** 机器码 → HTTP 状态（封闭表）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  FORBIDDEN: 403,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_CONFIGURED: 503,
  NOT_FOUND: 404,
}

class DedupHttpProblem extends Error {
  readonly status: number
  readonly code: string
  readonly reasonCode: string | null
  readonly detail?: Readonly<Record<string, unknown>>

  constructor(
    status: number,
    code: string,
    reasonCode: string | null,
    message: string,
    detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.reasonCode = reasonCode
    this.detail = detail
  }
}

function problem(
  status: number,
  code: string,
  reasonCode: string | null,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): never {
  throw new DedupHttpProblem(status, code, reasonCode, message, detail)
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

/** 读 `X-DSH-Session` 并归一化（身份有且只有这个头）。 */
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

/** 从 URL 路径里提取 applicationId；不匹配模板 → 404（不读库）。 */
function parseApplicationId(pathname: string): string | null {
  const prefix = CANDIDATE_DEDUP_REGISTER_PREFIX
  if (!pathname.startsWith(prefix)) return null
  if (!pathname.endsWith('/duplicates')) return null
  const middle = pathname.slice(prefix.length, pathname.length - '/duplicates'.length)
  // middle 形如 `<id>`（可能含编码后的斜杠）；不含额外 `/`。
  if (middle === '' || middle.includes('/')) return null
  try {
    return decodeURIComponent(middle)
  } catch {
    return null
  }
}

/**
 * 解析普通申请详情路径 `/applications/:id`（不含 `/duplicates`）。
 *
 * 因为 `registerRecruitingHttp` 的 prefix 更短，宿主会先把普通详情请求交给本
 * handler；必须原样回退申请详情，否则候选人页会 404。
 */
function parseApplicationDetailId(pathname: string): string | null {
  const prefix = CANDIDATE_DEDUP_REGISTER_PREFIX
  if (!pathname.startsWith(prefix)) return null
  const middle = pathname.slice(prefix.length)
  if (middle === '' || middle.includes('/') || middle.endsWith('/duplicates')) return null
  try {
    return decodeURIComponent(middle)
  } catch {
    return null
  }
}

/** 错误边界：任何异常都翻成封闭 JSON 信封，不抛进宿主事件循环。 */
function errorBody(error: unknown): { status: number; body: unknown } {
  if (error instanceof DedupHttpProblem) {
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
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { error: { code: 'INTERNAL', message } } }
}

/**
 * 注册候选人去重提示路由（返回 disposer）。
 *
 * 非回环监听时**不注册**（fail-closed）；数据库未配置时 503 NOT_CONFIGURED。
 * @param ctx - 宿主上下文（含 webServer）。
 * @param deps - 依赖（数据库配置 / 身份 / 可选测试注入）。
 * @returns 注销函数。
 */
export function registerCandidateDedupHttp(
  ctx: CandidateDedupHostContext,
  deps: CandidateDedupHttpDeps,
): () => void {
  const { webServer } = ctx
  if (webServer.host !== '127.0.0.1' && webServer.host !== '::1') {
    ctx.logger?.warn(`recruitment: 候选人去重路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const load: LoadDedupFacts = deps.loadFacts ?? loadFactsFromDb

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname

      // 1a. 普通申请详情回退（`/applications/:id`）：本 prefix 比既有 recruiting
      // prefix 更长，必须把非 duplicates 请求原样交回 readApplicationDetail，
      // 否则候选人页/概览会因 404 崩掉。行为与既有 GET 申请详情一致。
      const detailApplicationId = deps.runReadOnly === undefined
        ? parseApplicationDetailId(pathname)
        : null
      if (detailApplicationId !== null) {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
          res.end()
          return
        }
        const detailHost = req.headers.host
        if (detailHost !== `127.0.0.1:${port}` && detailHost !== `localhost:${port}`) {
          problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', 'same-origin loopback request required')
        }
        if (req.headers['x-recruitment-request'] !== '1') {
          problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', 'same-origin loopback request required')
        }
        const detailOrigin = req.headers.origin
        if (detailOrigin !== undefined && detailOrigin !== `http://${detailHost}`) {
          problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', 'same-origin loopback request required')
        }
        if (deps.database === null) {
          problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置', {
            issues: [...(deps.databaseIssues ?? [])],
          })
        }
        const detailPool = createPool(deps.database)
        try {
          const value = await withReadOnly(detailPool, (client) => readApplicationDetail(
            { database: deps.database as ResolvedDatabaseConfig, client, actionSeams: FALLBACK_ACTION_SEAMS },
            detailApplicationId,
          ))
          json(res, 200, value)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.startsWith('NOT_FOUND:')) {
            json(res, 404, { error: { code: 'NOT_FOUND', message } })
            return
          }
          throw error
        } finally {
          await closePool(detailPool)
        }
        return
      }

      // 1. 路径形状（不匹配就 404，不碰身份 / 库）。
      const applicationId = parseApplicationId(pathname)
      if (applicationId === null) {
        json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
        return
      }

      // 2. 方法闸门：只读 GET。
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
        res.end()
        return
      }

      // 3. 同源闸门：Host + x-recruitment-request + Origin（与 overview.ts 同一口径）。
      const host = req.headers.host
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', 'same-origin loopback request required')
      }
      if (req.headers['x-recruitment-request'] !== '1') {
        problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', 'same-origin loopback request required')
      }
      const origin = req.headers.origin
      if (origin !== undefined && origin !== `http://${host}`) {
        problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', 'same-origin loopback request required')
      }

      // 4. 身份闸门：X-DSH-Session → 已绑定 alias（未绑定 409，零写入）。
      const sessionId = readSessionHeader(req)
      try {
        resolveSessionActor(deps.identity, sessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        problem(409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND', `X-DSH-Session 未绑定执行身份：${message}`)
      }

      // 5. 封闭 query 键集：不接受任何 actor/tenant 覆盖或未知参数。
      for (const key of url.searchParams.keys()) {
        problem(400, 'INVALID_ARGS', 'UNKNOWN_PARAM', `查询串包含未定义的键：${key}`, {
          allowed: [],
        })
      }

      // 6. 非法 id fail-closed（解码后校验，含控制字符 / 路径分隔符一律 400）。
      if (!isValidApplicationId(applicationId)) {
        problem(400, 'INVALID_ARGS', 'ID_INVALID', 'applicationId 缺省或非法')
      }

      // 7. 数据库未配置：503（不假装能读）。
      if (deps.database === null) {
        problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置', {
          issues: [...(deps.databaseIssues ?? [])],
        })
      }

      // 8. 只读执行：注入 runReadOnly（测试）或 createPool + withReadOnly + closePool（生产）。
      const tenantId = deps.database.tenant_id
      let facts: ReadonlyArray<DedupCandidateFact>
      if (deps.runReadOnly !== undefined) {
        facts = await deps.runReadOnly((client) => load(client, tenantId))
      } else {
        const pool = createPool(deps.database)
        try {
          facts = await withReadOnly(pool, (client) => load(client, tenantId))
        } finally {
          await closePool(pool)
        }
      }
      const subject = facts.find((fact) => fact.applicationId === applicationId)
      if (subject === undefined) {
        problem(404, 'NOT_FOUND', 'APPLICATION_NOT_FOUND', `application ${applicationId} 不存在`)
      }
      const duplicates = findDuplicateCandidates(subject, facts, { limit: 50 })
      const body: CandidateDuplicatesResponse = {
        contract_version: CANDIDATE_DEDUP_CONTRACT_VERSION,
        evaluated_at: new Date().toISOString(),
        application_id: applicationId,
        duplicates,
        subject_hints: {
          phone: maskPhone(subject.phone),
          email: maskEmail(subject.email),
        },
      }
      json(res, 200, body)
    } catch (error) {
      const { status, body } = errorBody(error)
      json(res, status, body)
    }
  }

  return webServer.register({
    kind: 'prefix',
    path: CANDIDATE_DEDUP_REGISTER_PREFIX,
    handler,
  })
}
