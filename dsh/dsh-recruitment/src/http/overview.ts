// 宿主侧只读 HTTP 路由：给 Web 工作台面板提供「待人工决定」投影。
//
// 为什么单独一层（不塞进 src/index.ts）：
//   1. 路由只做一件事——把库里**已有的**申请/决定投影出来；面板只读它，不直连数据库
//      （客户端不许持有 DB 凭据）。
//   2. 只读不是"源码里没写 INSERT"这种自觉：查询跑在 `begin transaction read only`
//      里（`db/pool.ts` 的 `withReadOnly`），任何写语句都会被 PG 以
//      `25006 read_only_sql_transaction` 拒绝。
//   3. 暴露面按最坏情况设计：**只允许 loopback + 同源**，非回环地址直接不注册路由
//      （不是返回 403 之后还挂在那里）。路由前缀 `/recruitment/api`，没有写方法。
//
// 数据口径（只来自 `decision` / `application` 两张表）：
//   一个 ACTIVE 申请在 **人工决策闸门**上、且该闸门**没有当前有效的真人决定**时，算"待人工决定"。
//   闸门只有两个（`contracts/STAGE-CODES.md` + `contracts/evaluation/decision-rules.md`）：
//     S7  初筛        → decision_scope = 'SCREENING'（stage_code 写死 'S7'）
//     S10 综合评价/决策 → decision_scope ∈ ('STAGE','FINAL')（stage_code 写死 'S10'）
//   "当前有效" = `superseded_by_decision_id is null`（被新决定取代的旧行不算数）。
//   S6 接入 / S8 排期 / S9 面试执行不是"等真人拍板"的闸门，因此不进这个列表——
//   把它们算进来会让"待人工决定"变成"所有在办申请"，那正是工作台失去意义的形态。
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { closePool, createPool, withReadOnly, type ResolvedDatabaseConfig } from '../db/pool.ts'

/** 一条"在等真人决定"的申请。 */
export interface PendingDecisionRow {
  /** 申请 id（UUID 文本）。 */
  readonly application_id: string
  /** 申请当前所在的人工闸门阶段码（`S7` / `S10`）。 */
  readonly stage_code: string
  /** 为什么在等：闸门语义 + 是否被阶段阻断原因阻塞。 */
  readonly reason: string
}

/** 计数（全部为非负整数；无数据时为 0，不是 `undefined` / `NaN`）。 */
export interface OverviewCounts {
  /** 待人工决定总条数。 */
  readonly pending_total: number
  /**
   * 按闸门阶段码聚合的**待人工决定**条数。
   *
   * 名字里必须带 `pending`：曾经叫 `by_stage`，与下面的 `active_by_stage` 极易混淆，
   * 读的人会以为它是"在办申请按阶段"（实测连总控本人都误读过一次）。
   * 两个集合的语义不同：待人工 = 卡在闸门上等人；在办 = 所有 ACTIVE 申请。
   */
  readonly pending_by_stage: Readonly<Record<string, number>>
  /** 在办（`lifecycle_status='ACTIVE'`）申请总数，作为分母/上下文。 */
  readonly active_total: number
  /** 在办申请按当前阶段码聚合（与 `pending_by_stage` 是两个不同集合，别混用）。 */
  readonly active_by_stage: Readonly<Record<string, number>>
}

/** 工作台投影响应（客户端据此渲染；`configured=false` 时列表必为空，绝不编造数据）。 */
export interface OverviewResponse {
  /** 数据库配置是否完整。false 时 `pending` 为空、`issues` 说明缺什么。 */
  readonly configured: boolean
  readonly pending: readonly PendingDecisionRow[]
  readonly counts: OverviewCounts
  /** `configured=false` 时缺失的配置项（不含密码值）。 */
  readonly issues?: readonly string[]
}

/** 路由前缀：`/recruitment/api/overview`。 */
const ROUTE_PREFIX = '/recruitment/api'
/** 唯一端点路径。 */
const OVERVIEW_PATH = `${ROUTE_PREFIX}/overview`
/** 同源标记头：页面 fetch 必须带上它（阻止其它站点/表单发起"顺便读一下"）。 */
const REQUEST_HEADER = 'x-recruitment-request'
/** 响应绝不缓存（读的是真实业务状态）。 */
const NO_STORE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const

/**
 * 人工决策闸门的"为什么等"文案。
 * 只描述**库里确实缺什么**（没有当前有效决定），不猜业务原因。
 */
const GATE_REASON: Readonly<Record<string, string>> = {
  S7: 'S7 初筛：还没有人工作出的筛选决定（decision_scope=SCREENING 未记录）',
  S10: 'S10 综合评价：等待人工给出面试轮次或最终决定（decision_scope=STAGE/FINAL 未记录）',
}

/**
 * 待人工决定查询。
 *
 * `$1` = `tenant_id`（UUID；来自插件配置，不接受模型/客户端传入）。
 * 判定顺序：先在办申请 → 再限定人工闸门阶段 → 再排除"该闸门已有当前有效决定"。
 * `stage_code` 与 `decision.stage_code` 用等值比较，避免把 S10 的决定算到 S7 头上。
 */
const PENDING_SQL = `
  select a.id::text                    as application_id,
         a.current_stage_code          as stage_code,
         a.stage_blocked_reason        as stage_blocked_reason
    from recruitment.application a
   where a.tenant_id = $1::uuid
     and a.lifecycle_status = 'ACTIVE'
     and a.current_stage_code in ('S7', 'S10')
     and not exists (
           select 1
             from recruitment.decision d
            where d.tenant_id = a.tenant_id
              and d.application_id = a.id
              and d.superseded_by_decision_id is null
              and d.stage_code = a.current_stage_code
              and (   (a.current_stage_code = 'S7'  and d.decision_scope = 'SCREENING')
                   or (a.current_stage_code = 'S10' and d.decision_scope in ('STAGE', 'FINAL')))
         )
   order by a.current_stage_code, a.id
`

/** 在办申请按当前阶段分组（只用于上下文计数，不参与"待人工"判定）。 */
const ACTIVE_BY_STAGE_SQL = `
  select a.current_stage_code as stage_code,
         count(*)::int        as n
    from recruitment.application a
   where a.tenant_id = $1::uuid
     and a.lifecycle_status = 'ACTIVE'
   group by a.current_stage_code
   order by a.current_stage_code
`

/** 数据库未配置时的空投影：形状完整、计数为 0——面板因此不会渲染出 `undefined`/`NaN`。 */
function unconfiguredOverview(issues: readonly string[]): OverviewResponse {
  return {
    configured: false,
    pending: [],
    counts: { pending_total: 0, pending_by_stage: {}, active_total: 0, active_by_stage: {} },
    issues,
  }
}

/** 把一行的阶段阻断原因拼进 reason（没有就原样返回闸门文案）。 */
function pendingReason(stageCode: string, blockedReason: string | null): string {
  const base = GATE_REASON[stageCode] ?? `阶段 ${stageCode} 在等人工决定`
  return blockedReason === null || blockedReason.trim() === ''
    ? base
    : `${base}；当前阶段受阻：${blockedReason}`
}

interface PendingDbRow {
  application_id: string
  stage_code: string
  stage_blocked_reason: string | null
}

/**
 * 读取工作台投影（只读事务；调用方负责保证 `database` 已解析）。
 *
 * 每次调用新建一个短连接池并在 `finally` 里关闭：插件工具不在进程里长期持有空闲连接。
 * @param database - 已校验通过的数据库配置。
 * @returns 投影响应；空库返回空列表 + 0 计数（不是错误）。
 */
export async function readOverview(database: ResolvedDatabaseConfig): Promise<OverviewResponse> {
  const pool = createPool(database)
  try {
    const [pendingRows, activeRows] = await withReadOnly(pool, async (client) => {
      const pending = await client.query<PendingDbRow>(PENDING_SQL, [database.tenant_id])
      const active = await client.query<{ stage_code: string; n: number }>(ACTIVE_BY_STAGE_SQL, [database.tenant_id])
      return [pending.rows, active.rows] as const
    })

    const pending: PendingDecisionRow[] = pendingRows.map((row) => ({
      application_id: row.application_id,
      stage_code: row.stage_code,
      reason: pendingReason(row.stage_code, row.stage_blocked_reason),
    }))
    const pendingByStage: Record<string, number> = {}
    for (const row of pending) pendingByStage[row.stage_code] = (pendingByStage[row.stage_code] ?? 0) + 1
    // 在办按阶段：查询本来就返回了明细，之前只取总和把明细丢掉了（"算了不输出"）。
    const activeByStage: Record<string, number> = {}
    let activeTotal = 0
    for (const row of activeRows) {
      const n = Number.isFinite(row.n) ? row.n : 0
      activeByStage[row.stage_code] = (activeByStage[row.stage_code] ?? 0) + n
      activeTotal += n
    }

    return {
      configured: true,
      pending,
      counts: {
        pending_total: pending.length,
        pending_by_stage: pendingByStage,
        active_total: activeTotal,
        active_by_stage: activeByStage,
      },
    }
  } finally {
    await closePool(pool)
  }
}

/** 写一个 JSON 响应（固定 no-store + nosniff）。 */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/**
 * 同源校验：必须同时满足
 *   1. `Host` 是本机监听地址（`127.0.0.1:<port>` 或 `localhost:<port>`）；
 *   2. 带 `x-recruitment-request: 1`（浏览器里只有本产品页面会带）；
 *   3. `Origin` 缺省（同源 GET 通常不带）或等于 `http://<host>`。
 * @param req - node 请求对象（只读 headers）。
 * @param port - 本机 Web 监听端口。
 * @returns 是否放行。
 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  if (req.headers[REQUEST_HEADER] !== '1') return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://${host}`
}

/** 回环地址判据（只接受 127.0.0.1 / ::1；其余地址不注册路由）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/** 宿主侧用到的 `webServer` 最小面（只取注册、host、port）。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * 宿主上下文的窄接口（`webServer` 由 cordis 服务注入；`logger` 可选）。
 * 导出它是因为 `src/index.ts` 需要把 cordis 的 `Context` 窄成这个形状再传进来——
 * 插件包不依赖 `@deepseek-ai/dsh-host-webserver` 的类型，收窄面就够用。
 */
export interface OverviewHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/**
 * 注册只读工作台路由；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警：这是 fail-closed——宁可面板读不到，
 * 也不把业务投影挂到一个网络可达的地址上。
 * @param ctx - 宿主上下文（含 webServer 服务）。
 * @param database - 已解析的数据库配置；`null` 表示未配置（路由仍存在，返回空投影 + issues）。
 * @param issues - 未配置时缺失的配置项。
 * @returns 注销函数。
 */
export function registerOverviewHttp(
  ctx: OverviewHostContext,
  database: ResolvedDatabaseConfig | null,
  issues: readonly string[],
): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 工作台路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== OVERVIEW_PATH) {
      json(res, 404, { error: 'not found' })
      return
    }
    if (!sameOrigin(req, webServer.port ?? 0)) {
      json(res, 403, { error: 'same-origin loopback request required' })
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', ...NO_STORE })
      res.end()
      return
    }
    if (database === null) {
      json(res, 200, unconfiguredOverview(issues))
      return
    }
    try {
      json(res, 200, await readOverview(database))
    } catch (error) {
      // 读库失败必须可解释：面板显示错误，而不是显示"没有待办"（那是把故障说成空）。
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
