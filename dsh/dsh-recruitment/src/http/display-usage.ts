// 宿主侧只读 HTTP 路由：DSH 会话计量展示（`GET /recruitment/api/usage?session_id=…`）。
//
// 这个文件只做三件事（**不新建计量**，D-140 / docs/24 §3「展示」）：
//
//   1. 从**插件进程内**的 DSH 服务读真实计量：
//      · `ctx.get('sessions')`            → SessionStore.get(id) 拿 live `Session`；
//      · `ctx.get('sessionProjections')`  → 注册表 `snapshot(session, keys)` 的 wire 值；
//      · `ctx.get('tokenMeter')`          → **可选**（CONTRACT §2：不作为必需面，也不作为四桶来源）。
//      数据来源是 DSH 的持久事实（会话事件 + 投影 fold），本文件一个数字都不自己算。
//
//   2. 原样透出四个投影 key 的 wire 值：
//      `tokenUsage`（四桶 totals）/ `contextPressure` / `contextBreakdown` / `sessionStats`。
//      **不重算、不四舍五入、不补 0**：没注册/没值的 key 进 `missing`，对应字段为 `null`。
//
//   3. `last` = 最新一步的 usage。优先用 DSH 自己的 fold
//      （`sessionProjections.stateOf(session,'tokenUsage').last`，turn/step/buckets 与 DSH 同源），
//      stateOf 不存在/抛错/形状不认识时退回**扫事件**：从 `session.seq` 往前最多 500 条
//      `eventAt`，取最新一条 `assistant/message` 且 `data.usage` 是对象的（CONTRACT §2 的持久事实）。
//
// 失败路径全部是**可解释的拒绝**，绝不返回假 0 / 假 totals：
//   · 服务未挂载        → 503 `NOT_CONFIGURED` / `DSH_USAGE_SERVICES_NOT_MOUNTED`
//   · session 不是 live → 404 `NOT_FOUND` / `DSH_SESSION_NOT_LIVE`
//   · 投影读取抛错      → 503 `NOT_CONFIGURED` / `DSH_USAGE_READ_FAILED`
//
// 安全边界与 `http/overview.ts` 同一口径：只在**回环** webServer 上注册（非回环不注册，fail-closed）；
// 每个请求校验 `sameOrigin`（Host 必须是本机端口 + `x-recruitment-request: 1` + Origin 缺省或同源）；
// 只有 GET（其余 405 + `allow: GET`）；响应 `cache-control: no-store`；错误体固定
// `{"error":{"code","reason_code","message"}}`，message 里**不出现机器绝对路径与凭据**。
import type { IncomingMessage, ServerResponse } from 'node:http'

import { sameOrigin } from './overview.ts'

/** 端点路径（exact 路由；CONTRACT §2 冻结）。 */
export const USAGE_PATH = '/recruitment/api/usage'
/** 契约版本（CONTRACT §2：`contract_version: "1.0.0"`）。 */
export const USAGE_CONTRACT_VERSION = '1.0.0'
/**
 * `quota` 恒 `null` 的说明（CONTRACT §2：DSH 对非第一方 route 无额度读数，不得编造）。
 * 这是**说明性字段**，不是一个数字。
 */
export const USAGE_QUOTA_NOTE = 'DSH 无跨 provider 额度读数'

/** 同源标记头：页面 fetch 必须带上它。 */
const REQUEST_HEADER = 'x-recruitment-request'
/** `session_id` 的长度上限：DSH session id 是短标识，超长一律 400（不把任意长串往服务里塞）。 */
const MAX_SESSION_ID_LENGTH = 512
/** `last` 的事件扫描上限（CONTRACT §2：扫描上限 500 条）。 */
const LAST_SCAN_LIMIT = 500
/** 只读的四个投影 key（顺序即 `missing` 的枚举顺序）。 */
const PROJECTION_KEYS = ['tokenUsage', 'contextPressure', 'contextBreakdown', 'sessionStats'] as const
/** 响应绝不缓存（读的是活的会话事实）。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

// =====================================================================
//  DSH 服务的最小窄接口（**不 import 任何 DSH 包**：插件进程里只用 ctx.get 的服务面）
// =====================================================================

/** 一条 DSH 会话事件的最小面（只读 `type` / `data`）。 */
export interface DshSessionEventLike {
  readonly type?: unknown
  readonly data?: unknown
}

/**
 * 一个 DSH live `Session` 的最小面：`id` / `seq` / `eventAt`。
 * `seq` 是「下一条事件的序号 = 日志长度」（DSH 的 `seq = log.length` 连续契约），
 * 所以最后一条事件是 `eventAt(seq - 1)`。
 */
export interface DshSessionLike {
  readonly id?: unknown
  readonly seq: number
  eventAt?(seq: number): DshSessionEventLike | undefined
}

/** `ctx.get('sessions')` 的最小面（SessionStore.get → live Session；未命中 undefined）。 */
export interface DshSessionStoreLike {
  get(id: string): DshSessionLike | undefined
}

/** 一次投影快照：`asOfSeq` 是共享水位，`values` 是按 key 的 wire 值。 */
export interface DshProjectionSnapshotLike {
  readonly asOfSeq: number
  readonly values: Readonly<Record<string, unknown>>
}

/** `ctx.get('sessionProjections')` 的最小面。`stateOf` 可选（deprecated，仅作 `last` 的优先读面）。 */
export interface DshSessionProjectionsLike {
  snapshot(session: DshSessionLike, keys: readonly string[]): DshProjectionSnapshotLike
  stateOf?(session: DshSessionLike, key: string): unknown
}

/** 计量读取所需的 DSH 服务访问器（`deps.dsh` / 测试 fake 都是这个形状）。 */
export interface DshUsageAccess {
  readonly sessions: DshSessionStoreLike
  readonly projections: DshSessionProjectionsLike
  /** 可选：`ctx.get('tokenMeter')` 的探测结果（CONTRACT §2：不是必需面，不用于四桶）。 */
  readonly tokenMeter?: unknown
}

/** 宿主 `webServer` 的最小面（与 `http/overview.ts` 一致，避免依赖宿主包类型）。 */
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
 * 本端点需要的宿主上下文：`webServer` + 可选 `logger` + cordis `ctx.get`。
 *
 * `get` 是**可选**的：没有它（或它抛错）时 `resolveDshUsageAccess` 返回 `null`，
 * 端点报 503「服务未挂载」，而不是让异常冒到 HTTP 层。
 */
export interface DshUsageHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
  get?(name: string): unknown
}

/** 注册入口的依赖（`dsh === undefined` 时用 `resolveDshUsageAccess(ctx)`；`null` 强制不可用）。 */
export interface DisplayUsageDeps {
  readonly dsh?: DshUsageAccess | null
  readonly now?: () => Date
}

// =====================================================================
//  小工具（纯函数）
// =====================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非负有限数（token 桶的合法值）。 */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 非负整数（turn/step/seq）。 */
function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value)
}

/** 四桶（与 DSH `TokenUsageProjection` 逐字同名）。 */
export interface UsageBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** `last` 的一步（DSH 持久事实：turn/step + 该步 usage 四桶）。 */
export interface UsageLastStep {
  readonly turn: number
  readonly step: number
  readonly buckets: UsageBuckets
}

/** 从 DSH 投影的 `last.buckets`（已是四桶形状）读；形状不认识 → undefined。 */
function bucketsOfProjection(value: unknown): UsageBuckets | undefined {
  if (!isPlainObject(value)) return undefined
  const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = value
  if (!isNonNegativeNumber(uncachedInputTokens) || !isNonNegativeNumber(outputTokens)
    || !isNonNegativeNumber(cacheReadTokens) || !isNonNegativeNumber(cacheWriteTokens)) return undefined
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

/**
 * 从 DSH `TokenUsage`（`assistant/message.data.usage`）映射到四桶。
 *
 * 映射与 DSH token-meter 的 `bucketsFrom` **同一语义**：`inputTokens` 是**未缓存**输入；
 * cache 两桶缺省按 0 处理（provider 没报就是 0，这是 DSH 自己的口径，不是我们补的）。
 */
function bucketsOfTokenUsage(value: unknown): UsageBuckets | undefined {
  if (!isPlainObject(value)) return undefined
  const input = value.inputTokens
  const output = value.outputTokens
  const cacheRead = value.cacheReadTokens
  const cacheWrite = value.cacheWriteTokens
  if (!isNonNegativeNumber(input) || !isNonNegativeNumber(output)) return undefined
  if (cacheRead !== undefined && !isNonNegativeNumber(cacheRead)) return undefined
  if (cacheWrite !== undefined && !isNonNegativeNumber(cacheWrite)) return undefined
  return {
    uncachedInputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
  }
}

/**
 * 把 `sessionProjections.stateOf(session,'tokenUsage')` 的 fold 状态读成 `last`。
 *
 * 返回三态：`undefined` = 形状不认识（调用方退回事件扫描）；
 * `null` = DSH 自己说「当前没有 last」（例如 `llm/retry-started` 把同一步的 last 清掉）；
 * 对象 = 可用。**`null` 是权威的**，不能拿更老的 assistant/message 去覆盖它。
 */
function lastOfProjectionState(state: unknown): UsageLastStep | null | undefined {
  if (!isPlainObject(state) || !Object.hasOwn(state, 'last')) return undefined
  const last = state.last
  if (last === null) return null
  if (!isPlainObject(last)) return undefined
  const { turn, step } = last
  if (!isNonNegativeInteger(turn) || !isNonNegativeInteger(step)) return undefined
  const buckets = bucketsOfProjection(last.buckets)
  if (buckets === undefined) return undefined
  return { turn, step, buckets }
}

/**
 * 事件扫描：从 `session.seq` 往前最多 `LAST_SCAN_LIMIT` 条，取最新一条
 * `assistant/message` 且 `data.usage` 是对象的事件（CONTRACT §2 的 `last` 定义）。
 *
 * 只读 `eventAt`（DSH 的持久日志读面）；任何读失败都返回 `null`（不编造、不让异常冒泡）。
 */
function scanLastUsage(session: DshSessionLike): UsageLastStep | null {
  const seq = session.seq
  if (!Number.isFinite(seq) || seq <= 0) return null
  const eventAt = session.eventAt
  if (typeof eventAt !== 'function') return null
  const newest = Math.floor(seq) - 1
  const oldest = Math.max(0, newest - LAST_SCAN_LIMIT + 1)
  for (let index = newest; index >= oldest; index -= 1) {
    let event: DshSessionEventLike | undefined
    try {
      event = eventAt.call(session, index)
    } catch {
      return null
    }
    if (event === undefined || event === null) continue
    if (event.type !== 'assistant/message') continue
    const data = event.data
    if (!isPlainObject(data)) continue
    if (!isPlainObject(data.usage)) continue
    const { turn, step } = data
    if (!isNonNegativeInteger(turn) || !isNonNegativeInteger(step)) continue
    const buckets = bucketsOfTokenUsage(data.usage)
    if (buckets === undefined) continue
    return { turn, step, buckets }
  }
  return null
}

/**
 * 读 `last`：优先 DSH 自己的 fold（`stateOf`），不可用时退回事件扫描。
 * 两条路都是 DSH 持久事实，不是自建计量（CONTRACT §2）。
 */
function readLastUsage(access: DshUsageAccess, session: DshSessionLike): UsageLastStep | null {
  const stateOf = access.projections.stateOf
  if (typeof stateOf === 'function') {
    try {
      const folded = lastOfProjectionState(stateOf.call(access.projections, session, 'tokenUsage'))
      // `null` 是 fold 的权威结论（例如 retry 清掉了 last）；只有 undefined 才退回扫事件。
      if (folded !== undefined) return folded
    } catch {
      // stateOf 是 deprecated 的可选读面：抛错不算失败，退回事件扫描。
    }
  }
  return scanLastUsage(session)
}

/**
 * 解析插件进程内的 DSH 服务访问器。
 *
 * 纪律（CONTRACT §2 / 任务书）：`ctx.get` 不存在、抛错，或 `sessions` / `sessionProjections`
 * 任一缺失/形状不对 → 返回 `null`（端点报 503 未挂载），**绝不让异常冒到 HTTP 层**。
 * `tokenMeter` 是可选面：单独探测，缺失或抛错都不影响可用性（它也不是四桶来源）。
 *
 * @param ctx - 宿主上下文（cordis Context 的窄面）。
 * @returns 适配器，或 `null`（= 服务未挂载/不可用）。
 */
export function resolveDshUsageAccess(ctx: DshUsageHostContext | null | undefined): DshUsageAccess | null {
  const get = ctx?.get
  if (ctx === null || ctx === undefined || typeof get !== 'function') return null
  let sessions: unknown
  let projections: unknown
  try {
    sessions = get.call(ctx, 'sessions')
    projections = get.call(ctx, 'sessionProjections')
  } catch {
    return null
  }
  if (!isPlainObject(sessions) || typeof sessions.get !== 'function') return null
  if (!isPlainObject(projections) || typeof projections.snapshot !== 'function') return null
  // tokenMeter：可选面（CONTRACT §2）。探测可达性写入适配器，但**不参与**可用性判定。
  let tokenMeter: unknown
  try {
    tokenMeter = get.call(ctx, 'tokenMeter')
  } catch {
    tokenMeter = undefined
  }
  return {
    sessions: sessions as unknown as DshSessionStoreLike,
    projections: projections as unknown as DshSessionProjectionsLike,
    ...tokenMeter === undefined ? {} : { tokenMeter },
  }
}

/** 读一个投影 key：有值就原样给，没有就记进 missing 并给 null（不造 0）。 */
function pickProjection(
  values: Readonly<Record<string, unknown>>,
  key: string,
  missing: string[],
): unknown {
  if (Object.hasOwn(values, key) && values[key] !== undefined) return values[key]
  missing.push(key)
  return null
}

/** 规范一次快照；形状不认识时抛（端点映射为 503 `DSH_USAGE_READ_FAILED`）。 */
function normalizeSnapshot(raw: unknown): DshProjectionSnapshotLike {
  if (!isPlainObject(raw)) throw new Error('projection snapshot is not an object')
  const asOfSeq = raw.asOfSeq
  const values = raw.values
  if (!isNonNegativeInteger(asOfSeq)) throw new Error('projection snapshot has no numeric asOfSeq')
  if (!isPlainObject(values)) throw new Error('projection snapshot has no values object')
  return { asOfSeq, values }
}

/** ISO 时间；`now()` 返回非法 Date 时退回当前时刻（形状完整）。 */
function capturedAtIso(now: () => Date): string {
  const value = now()
  const ms = value instanceof Date ? value.getTime() : Number.NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString()
}

// =====================================================================
//  响应体（形状是 CONTRACT §2 的契约）
// =====================================================================

/** `GET /recruitment/api/usage` 的 200 响应（字段是契约：不增删语义）。 */
export interface UsageResponse {
  readonly tool: 'recruitment_usage'
  readonly contract_version: string
  readonly session_id: string
  readonly available: true
  readonly source: 'DSH_SESSION_PROJECTION'
  readonly captured_at: string
  readonly as_of_seq: number
  readonly totals: unknown
  readonly last: UsageLastStep | null
  readonly context: unknown
  readonly context_breakdown: unknown
  readonly session_stats: unknown
  readonly missing: readonly string[]
  readonly quota: null
  readonly quota_note: string
}

/**
 * 组装 200 响应（**纯函数**，不碰 DSH/HTTP）。
 * @param sessionId - 请求里的 session id（原样回显）。
 * @param snapshot - DSH 投影快照（wire 值只读透出）。
 * @param last - 最新一步 usage（拿不到 null）。
 * @param capturedAt - 本次读取时刻（ISO）。
 */
export function buildUsageResponse(
  sessionId: string,
  snapshot: DshProjectionSnapshotLike,
  last: UsageLastStep | null,
  capturedAt: string,
): UsageResponse {
  const missing: string[] = []
  const totals = pickProjection(snapshot.values, 'tokenUsage', missing)
  const context = pickProjection(snapshot.values, 'contextPressure', missing)
  const contextBreakdown = pickProjection(snapshot.values, 'contextBreakdown', missing)
  const sessionStats = pickProjection(snapshot.values, 'sessionStats', missing)
  return {
    tool: 'recruitment_usage',
    contract_version: USAGE_CONTRACT_VERSION,
    session_id: sessionId,
    available: true,
    source: 'DSH_SESSION_PROJECTION',
    captured_at: capturedAt,
    as_of_seq: snapshot.asOfSeq,
    totals,
    last,
    context,
    context_breakdown: contextBreakdown,
    session_stats: sessionStats,
    missing,
    quota: null,
    quota_note: USAGE_QUOTA_NOTE,
  }
}

// =====================================================================
//  HTTP 层
// =====================================================================

/** 写 JSON 响应（固定 no-store + nosniff）。 */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/** 固定错误体：`{"error":{"code","reason_code","message"}}`（code 只用 CONTRACT §0 闭集）。 */
function jsonError(res: ServerResponse, status: number, code: string, reasonCode: string, message: string): void {
  json(res, status, { error: { code, reason_code: reasonCode, message } })
}

/** 回环判据：只接受 127.0.0.1 / ::1（其余地址**不注册**路由）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/**
 * 注册会话计量路由；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警：fail-closed——宁可面板读不到计量，也不把宿主会话事实
 * 挂到网络可达的地址上（CONTRACT §0）。
 *
 * @param ctx - 宿主上下文（含 webServer；`get` 用于解析 DSH 服务）。
 * @param deps - `dsh` 访问器（undefined = 从 ctx 解析；null = 强制不可用）与时钟。
 * @returns 注销函数。
 */
export function registerDisplayUsageHttp(ctx: DshUsageHostContext, deps: DisplayUsageDeps = {}): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 会话计量路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  // `deps.dsh === undefined` = 生产路径：**每个请求**用 ctx.get 解析服务（而不是注册时解析一次）。
  // 理由：注册发生在插件启动早期，服务图可能尚未完全挂载；按请求解析让「服务后到」也能自愈，
  // 解析失败就报 503 未挂载（不缓存一个永久 null）。
  const providedAccess: DshUsageAccess | null | undefined = deps.dsh
  const now = deps.now ?? ((): Date => new Date())

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 同源校验：Host 必须是本机端口 + 标记头 + Origin 缺省/同源。
    if (!sameOrigin(req, port)) {
      jsonError(res, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', '只允许本机回环 + 同源请求（Host/Origin/x-recruitment-request 校验未通过）')
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', ...NO_STORE })
      res.end()
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // 查询参数白名单：只有 session_id（未知参数 400，不静默忽略）。
      const allowed = ['session_id'] as const
      const unknown = [...url.searchParams.keys()].filter(
        (key) => !(allowed as readonly string[]).includes(key),
      )
      if (unknown.length > 0) {
        jsonError(res, 400, 'INVALID_ARGS', 'UNKNOWN_PARAM', `未声明的查询参数 "${unknown[0]}"（允许：session_id）`)
        return
      }
      const sessionId = url.searchParams.get('session_id')
      if (sessionId === null || sessionId.trim() === '') {
        jsonError(res, 400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填查询参数 session_id')
        return
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH) {
        jsonError(res, 400, 'INVALID_ARGS', 'OUT_OF_RANGE', `session_id 不得超过 ${MAX_SESSION_ID_LENGTH} 个字符`)
        return
      }
      const access = providedAccess === undefined ? resolveDshUsageAccess(ctx) : providedAccess
      // 服务未挂载：503（绝不退回 200 + 假 totals）。
      if (access === null) {
        jsonError(
          res, 503, 'NOT_CONFIGURED', 'DSH_USAGE_SERVICES_NOT_MOUNTED',
          'DSH 会话计量服务未挂载（sessions / sessionProjections 不可达），读不到真实计量',
        )
        return
      }
      // session 必须是 live Session（DSH 的 SessionStore 只持有活会话）；否则 404。
      let session: DshSessionLike | undefined
      try {
        session = access.sessions.get(sessionId ?? '')
      } catch {
        session = undefined
      }
      if (session === undefined || session === null) {
        jsonError(
          res, 404, 'NOT_FOUND', 'DSH_SESSION_NOT_LIVE',
          '该 session 不是 DSH 活会话（SessionStore.get 未命中），不返回假的 0',
        )
        return
      }
      // 投影读取：抛错/形状不认识 → 503 READ_FAILED（不带任何半成品数字）。
      let snapshot: DshProjectionSnapshotLike
      try {
        snapshot = normalizeSnapshot(access.projections.snapshot(session, PROJECTION_KEYS))
      } catch {
        jsonError(
          res, 503, 'NOT_CONFIGURED', 'DSH_USAGE_READ_FAILED',
          'DSH 会话投影读取失败，未返回任何计量数字',
        )
        return
      }
      // last 是可选样本：取不到就是 null（不编造），不影响 totals 的原样透出。
      const last = readLastUsage(access, session)
      json(res, 200, buildUsageResponse(sessionId, snapshot, last, capturedAtIso(now)))
    } catch {
      // 兜底：任何未预期异常都变成固定 500 错误体（message 不含路径/凭据/异常原文）。
      jsonError(res, 500, 'INTERNAL', 'UNEXPECTED', '读取会话计量时发生未预期错误')
    }
  }

  return webServer.register({ kind: 'exact', path: USAGE_PATH, handler })
}
