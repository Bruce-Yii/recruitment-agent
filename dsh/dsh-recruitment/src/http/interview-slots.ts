// 面试空闲时段交集的 Host 只读路由（自包含注册器 `registerInterviewSlotsHttp`）。
//
// 契约：
//   GET /recruitment/api/action/interview/free-slots
//     ?application_id=<uuid>&interviewer_actor_ids=<uuid>,<uuid>&days=5&duration_minutes=45
//   返回：
//     { slots:[{start,end,busy_conflicts,source}], proposed, unsatisfied:[...],
//       labels:{provenance,trigger,connection} }
//
// 硬规则（R4 / 外部失败诚实 / 不编时段）：
//   1. **只给交集**：由已成功读到忙闲的参与人求交，交给 domain/interview-slots
//      切槽。算不出 = 空 slots + unsatisfied 原因，绝不造时段。
//   2. **读取失败 ≠ 没有空闲**：任一参与人回读失败 → 该人进 unsatisfied
//      （AUTH_REQUIRED / CALENDAR_READ_FAILED），且不参与交集；没有可用回读时
//      slots 为空且 labels.connection ≠ CONNECTED（绝不 LIVE）。
//   3. **面试官 ↔ 飞书映射**：库里没有 actor_id→open_id 映射（现状：无此表），
//      默认 `resolveInterviewerOpenId` 返回 null → 进 unsatisfied
//      `NO_CALENDAR_BINDING`。**绝不猜 open_id**（不许拿姓名/邮箱拼 ou_）。
//      注入 seam 让未来真有映射时接上，无需改本文件。
//   4. **三维标签**：trigger 恒 MANUAL（HTTP 手动触发）；provenance/connection
//      由是否成功读到真实日历决定：全成功= LIVE/CONNECTED，任一失败=
//      FIXTURE + AUTH_REQUIRED 或 NOT_CONNECTED（CLI 未配置）。
//   5. 同源 + X-DSH-Session 绑定身份（复用 overview.sameOrigin / demo-actor），
//      client 不得传 actor_id/tenant_id 覆盖；非回环 host 不注册路由。
//
// 本文件不注册到 index.ts（由总控收口，只给两行接线清单）。
import type { IncomingMessage, ServerResponse } from 'node:http'

import { isUuid } from '../tools/contract.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorIdentity,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'
import {
  createCalendarProcessRunner,
  createFeishuCalendarReader,
  type CalendarErrorCode,
  type CalendarReadResult,
  type FeishuCalendarReader,
} from '../connectors/feishu/calendar.ts'
import {
  computeFreeSlots,
  DEFAULT_PROPOSED,
  DEFAULT_WORK_WINDOW,
  type BusyParticipant,
} from '../domain/interview-slots.ts'
import { getTimezoneOffsetMinutes, isValidIanaTimezone, localDateToUtcMs } from '../domain/timezone.ts'

// ---------------------------------------------------------------------------
//  契约常量
// ---------------------------------------------------------------------------

export const INTERVIEW_FREE_SLOTS_PATH = '/recruitment/api/action/interview/free-slots'

const QUERY_KEYS = ['application_id', 'interviewer_actor_ids', 'days', 'duration_minutes', 'timezone'] as const
const OVERRIDE_KEYS = ['actor_id', 'tenant_id'] as const

const DEFAULT_DAYS = 5
const DEFAULT_DURATION_MINUTES = 45
const MAX_DAYS = 14
const MAX_INTERVIEWERS = 8
/**
 * 显式默认时区（**不是**静默 +8）：请求未传 `timezone` 时按 `Asia/Shanghai` 处理，
 * 该默认值写进本文件 description 与交付报告，调用方可显式传其它 IANA 名覆盖。
 */
const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/** 人话原因（不暴露机器码/字段名给 UI；错误码在 error 信封里给机器）。 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  NO_CALENDAR_BINDING: '这位面试官还没有绑定飞书日历账号，无法判断他是否有空',
  AUTH_REQUIRED: '飞书日历还没授权读取，暂时无法判断大家是否有空',
  NOT_CONNECTED: '飞书日历连接还没配置好，暂时无法判断大家是否有空',
  CALENDAR_READ_FAILED: '读取这位面试官的日历时出错了，不能当作他有空',
  INVALID_ARGS: '请求参数不对',
  INVALID_TIMEZONE: '时区要写成 Asia/Shanghai 这种（合法的 IANA 时区名）',
  FORBIDDEN: '只接受本产品页面发出的请求',
  SESSION_REQUIRED: '缺当前登录身份',
  DEMO_ACTOR_UNMAPPED: '当前身份没绑定好',
}

const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

// ---------------------------------------------------------------------------
//  宿主上下文 / 依赖
// ---------------------------------------------------------------------------

interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface InterviewSlotsHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 面试官映射：actor_id → open_id（`ou_`）。默认返回 null = 没有绑定（如实上报）。 */
export type ResolveInterviewerOpenId = (actorId: string) => Promise<string | null>

/** 测试/未来装配用的 IO seam；生产缺省由本文件构造。 */
export interface InterviewSlotsIo {
  /** 日历 reader（缺省：要求 CLI 绝对路径；未给则 NOT_CONNECTED）。 */
  readonly reader?: FeishuCalendarReader
  /** 面试官映射（缺省：恒 null → NO_CALENDAR_BINDING）。 */
  readonly resolveInterviewerOpenId?: ResolveInterviewerOpenId
  /** 当前时刻（测试注入；用于日期窗口计算）。 */
  readonly now?: () => Date
  /** 本地时区偏移分钟（测试注入）。 */
  readonly timezone_offset_minutes?: number
}

export interface InterviewSlotsHttpDeps {
  /** lark-cli 绝对路径；不给 = NOT_CONNECTED（不拉任何进程）。 */
  readonly feishuCliPath: string | null
  /** 是否把 runner 声明为平台通道（生产 true → 可能 LIVE；回放 false → FIXTURE）。 */
  readonly platformChannel?: boolean
  readonly identity: DemoActorIdentity
  readonly io?: InterviewSlotsIo
}

// ---------------------------------------------------------------------------
//  HTTP 小工具
// ---------------------------------------------------------------------------

class SlotsHttpProblem extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'SlotsHttpProblem'
    this.status = status
    this.body = body
  }
}

function problem(status: number, code: string, reasonCode: string, message?: string, detail?: unknown): SlotsHttpProblem {
  return new SlotsHttpProblem(status, {
    error: {
      code,
      reason_code: reasonCode,
      message: message ?? REASON_TEXT[reasonCode] ?? REASON_TEXT[code] ?? '这次没能查到空闲时段',
      ...(detail === undefined ? {} : { detail }),
    },
  })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw problem(400, 'INVALID_ARGS', raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined ? REASON_TEXT.SESSION_REQUIRED : 'X-DSH-Session 格式不对')
  }
  return normalized
}

function requireBoundActor(deps: InterviewSlotsHttpDeps, sessionId: string): void {
  try {
    resolveSessionActor(deps.identity, sessionId)
  } catch {
    // session→alias 未绑定：如实 409，不回退配置里的 actor。
    throw problem(409, 'CONFLICT', 'DEMO_ACTOR_UNMAPPED')
  }
}

function rejectOverrides(url: URL): void {
  const rejected = OVERRIDE_KEYS.filter((key) => url.searchParams.has(key)).map((key) => `query.${key}`)
  if (rejected.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', 'actor/tenant 只能来自服务端绑定，不接受客户端传入', { rejected })
  }
}

/** 解析并校验 query（全在碰外部之前完成）。 */
interface ParsedQuery {
  readonly application_id: string
  readonly interviewer_actor_ids: readonly string[]
  readonly days: number
  readonly duration_minutes: number
  readonly timezone: string
}

function parseQuery(url: URL): ParsedQuery {
  rejectOverrides(url)
  const unknown = [...url.searchParams.keys()].filter((key) => !(QUERY_KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw problem(400, 'INVALID_ARGS', 'UNKNOWN_PARAM', '请求里有不认识的参数', { unknown })
  }
  const applicationId = url.searchParams.get('application_id')
  if (!isUuid(applicationId)) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_APPLICATION_ID', 'application_id 必须是 UUID')
  }
  const rawIds = url.searchParams.get('interviewer_actor_ids') ?? ''
  const interviewerActorIds = rawIds.split(',').map((s) => s.trim()).filter(Boolean)
  if (interviewerActorIds.length === 0 || interviewerActorIds.length > MAX_INTERVIEWERS) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_INTERVIEWER_IDS', `interviewer_actor_ids 要给 1..${MAX_INTERVIEWERS} 个 UUID`)
  }
  for (const id of interviewerActorIds) {
    if (!isUuid(id)) throw problem(400, 'INVALID_ARGS', 'INVALID_INTERVIEWER_IDS', 'interviewer_actor_ids 里每项都必须是 UUID')
  }
  if (new Set(interviewerActorIds).size !== interviewerActorIds.length) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_INTERVIEWER_IDS', 'interviewer_actor_ids 里有重复项')
  }
  const daysRaw = url.searchParams.get('days')
  const days = daysRaw === null ? DEFAULT_DAYS : Number(daysRaw)
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_DAYS', `days 必须是 1..${MAX_DAYS} 的整数`)
  }
  const durationRaw = url.searchParams.get('duration_minutes')
  const durationMinutes = durationRaw === null ? DEFAULT_DURATION_MINUTES : Number(durationRaw)
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 180) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_DURATION', 'duration_minutes 必须是 15..180 的整数')
  }
  const timezone = url.searchParams.get('timezone') ?? DEFAULT_TIMEZONE
  if (!isValidIanaTimezone(timezone)) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_TIMEZONE', REASON_TEXT.INVALID_TIMEZONE, { timezone })
  }
  return { application_id: applicationId, interviewer_actor_ids: interviewerActorIds, days, duration_minutes: durationMinutes, timezone }
}

/**
 * 从 `days` 生成要覆盖的本地日期。
 * IANA 路径：用该时区在注入时刻的真实偏移取"今天"（DST 当天也正确）；
 * 兼容路径：用显式注入的固定偏移（仅测试 seam，生产不再走这里）。
 */
function upcomingDates(
  now: Date,
  days: number,
  time: { iana?: string; offsetMinutes?: number },
): Array<{ year: number; month: number; day: number }> {
  const offsetMinutes = time.iana !== undefined
    ? getTimezoneOffsetMinutes(time.iana, now.getTime())
    : (time.offsetMinutes ?? 0)
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000)
  const out: Array<{ year: number; month: number; day: number }> = []
  for (let i = 0; i < days; i += 1) {
    const d = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + i))
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() })
  }
  return out
}

/** 把带偏移的 epoch ms 格式化成 ISO-8601（毫秒恒 000，偏移随该时刻动态取）。 */
function isoAt(ms: number, time: { iana?: string; offsetMinutes?: number }): string {
  const offsetMinutes = time.iana !== undefined
    ? getTimezoneOffsetMinutes(time.iana, ms)
    : (time.offsetMinutes ?? 0)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const shifted = new Date(ms + offsetMinutes * 60_000)
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
    + `.000${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * 把本地日期区间转成 ISO 查询窗口（给外部日历读忙闲用）。
 * IANA 路径：`start` 取首日本地 00:00 的绝对时刻、`end` 取末日本地 23:59:59.999 的
 * 绝对时刻，各自按**该时刻**的真实偏移格式化，DST 切换周窗口不会漂移一小时。
 */
function isoWindow(
  dates: readonly { year: number; month: number; day: number }[],
  time: { iana?: string; offsetMinutes?: number },
): { start: string; end: string } {
  const first = dates[0]!
  const last = dates[dates.length - 1]!
  const boundary = (date: { year: number; month: number; day: number }, minute: number): number =>
    time.iana !== undefined
      ? localDateToUtcMs(time.iana, date, minute)
      : Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0, 0) + minute * 60_000 - (time.offsetMinutes ?? 0) * 60_000
  return { start: isoAt(boundary(first, 0), time), end: isoAt(boundary(last, 24 * 60 - 1) + 999, time) }
}

/** 默认面试官映射：无绑定，如实返回 null（绝不猜 open_id）。 */
async function defaultResolveInterviewerOpenId(_actorId: string): Promise<string | null> {
  return null
}

/** 构造默认 reader（没配 CLI 绝对路径就不建，路由层据此给 NOT_CONNECTED）。 */
function defaultReader(deps: InterviewSlotsHttpDeps): FeishuCalendarReader | null {
  if (deps.feishuCliPath === null || deps.feishuCliPath.trim() === '') return null
  return createFeishuCalendarReader({
    runner: createCalendarProcessRunner({ command: deps.feishuCliPath }),
    platform_channel: deps.platformChannel === true,
  })
}

/** 单个参与人的回读失败 → 失败原因码。 */
function failureCodeOf(result: CalendarReadResult): CalendarErrorCode | 'CALENDAR_READ_FAILED' {
  return result.status === 'FAILED'
    ? (result.error.code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'CALENDAR_READ_FAILED')
    : 'CALENDAR_READ_FAILED'
}

/** 汇总三维标签（R4）：只有全成功且平台通道才 LIVE/CONNECTED。 */
function buildLabels(args: {
  readonly allLive: boolean
  readonly anyAuthFailure: boolean
  readonly readerConfigured: boolean
}): { provenance: 'LIVE' | 'FIXTURE'; trigger: 'MANUAL'; connection: 'CONNECTED' | 'AUTH_REQUIRED' | 'NOT_CONNECTED' } {
  const { allLive, anyAuthFailure, readerConfigured } = args
  if (allLive && readerConfigured) return { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' }
  if (!readerConfigured) return { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' }
  return { provenance: 'FIXTURE', trigger: 'MANUAL', connection: anyAuthFailure ? 'AUTH_REQUIRED' : 'NOT_CONNECTED' }
}

// ---------------------------------------------------------------------------
//  handler
// ---------------------------------------------------------------------------

async function handleGet(deps: InterviewSlotsHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const sessionId = readSessionHeader(req)
  requireBoundActor(deps, sessionId)
  const query = parseQuery(url)
  const io = deps.io ?? {}
  const reader = io.reader ?? defaultReader(deps)
  const resolveOpenId = io.resolveInterviewerOpenId ?? defaultResolveInterviewerOpenId
  const now = io.now ?? ((): Date => new Date())
  // IANA 路径为生产默认；io.timezone_offset_minutes 仅作测试 seam（显式注入）时走兼容路径。
  const time: { iana?: string; offsetMinutes?: number } = io.timezone_offset_minutes === undefined
    ? { iana: query.timezone }
    : { offsetMinutes: io.timezone_offset_minutes }

  // 未配置日历连接器：如实 NOT_CONNECTED + 空 slots + 全员 unsatisfied（不冒充空闲）。
  if (reader === null) {
    json(res, 200, {
      slots: [], proposed: 0,
      unsatisfied: query.interviewer_actor_ids.map((interviewer_actor_id) => ({ interviewer_actor_id, reason: 'NO_CALENDAR_BINDING' })),
      labels: buildLabels({ allLive: false, anyAuthFailure: false, readerConfigured: false }),
    })
    return
  }

  const dates = upcomingDates(now(), query.days, time)
  const window = isoWindow(dates, time)
  const participants: BusyParticipant[] = []
  const unsatisfied: Array<{ interviewer_actor_id: string; reason: string }> = []
  let anyAuthFailure = false
  let allLive = true

  for (const actorId of query.interviewer_actor_ids) {
    // ① 映射：库里没有 → NO_CALENDAR_BINDING（不猜 open_id）。
    const openId = await resolveOpenId(actorId)
    if (openId === null) {
      unsatisfied.push({ interviewer_actor_id: actorId, reason: 'NO_CALENDAR_BINDING' })
      allLive = false
      continue
    }
    // ② 只读忙闲：失败 → unsatisfied（认证失败单独给 AUTH_REQUIRED 原因）。
    // 用 `+agenda`（事件列表 → 忙碌区间）而不是 `+freebusy`：真机实测 freebusy 需要**应用级**
    // `calendar:calendar:readonly` 后台授权（未开时 CLI 返回 ok:true + data:null），而 agenda 已可用。
    // 两者都只读；agenda 拿不到时仍然 FAILED，绝不返回空档冒充空闲。
    const read = await reader.readFreebusy({ user_id: openId, start: window.start, end: window.end })
    if (read.status === 'FAILED') {
      const code = failureCodeOf(read)
      if (code === 'AUTH_REQUIRED') anyAuthFailure = true
      unsatisfied.push({ interviewer_actor_id: actorId, reason: code })
      allLive = false
      continue
    }
    if (read.readback.transport !== 'LIVE') allLive = false
    participants.push({
      participant_id: actorId,
      busy: read.readback.busy.map((b) => ({ start_ms: b.start_ms, end_ms: b.end_ms })),
    })
  }

  // 候选人忙闲：当前 DB 没有「候选人 → 飞书用户」映射表，且候选人是外部人。
  // 此处**不猜**候选人的 open_id、也不把候选人当「全天空闲」来伪造交集——
  // 只按已成功读取的面试官忙闲求交。未来若有候选人映射，由注入 resolver 补入。

  if (participants.length === 0) {
    json(res, 200, {
      slots: [], proposed: 0, unsatisfied,
      labels: buildLabels({ allLive: false, anyAuthFailure, readerConfigured: true }),
    })
    return
  }

  const slots = computeFreeSlots({
    participants, dates,
    ...(time.iana !== undefined
      ? { iana_timezone: time.iana }
      : { timezone_offset_minutes: time.offsetMinutes ?? 0 }),
    duration_minutes: query.duration_minutes,
    proposed: DEFAULT_PROPOSED,
    work_window: DEFAULT_WORK_WINDOW,
    source: allLive ? 'LIVE' : 'FIXTURE',
  })

  json(res, 200, {
    slots, proposed: slots.length, unsatisfied,
    labels: buildLabels({ allLive, anyAuthFailure, readerConfigured: true }),
  })
}

// ---------------------------------------------------------------------------
//  注册器
// ---------------------------------------------------------------------------

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/**
 * 注册只读空闲时段路由；非回环 host 不注册（返回空 disposer + 告警）。
 * @returns 注销函数。
 */
export function registerInterviewSlotsHttp(ctx: InterviewSlotsHostContext, deps: InterviewSlotsHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 空闲时段路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== INTERVIEW_FREE_SLOTS_PATH) {
        json(res, 404, { error: 'not found' })
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', ...NO_STORE })
        res.end()
        return
      }
      if (!sameOrigin(req, port)) throw problem(403, 'FORBIDDEN', 'FORBIDDEN')
      await handleGet(deps, req, res, url)
    } catch (error) {
      if (error instanceof SlotsHttpProblem) {
        json(res, error.status, error.body)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      json(res, 500, { error: { code: 'INTERNAL', reason_code: 'UNEXPECTED', message } })
    }
  }
  return webServer.register({ kind: 'exact', path: INTERVIEW_FREE_SLOTS_PATH, handler })
}

/** 契约常量导出（测试与接线核对用）。 */
export const INTERVIEW_SLOTS_CONTRACT = {
  path: INTERVIEW_FREE_SLOTS_PATH,
  methods: ['GET'] as const,
  queryKeys: QUERY_KEYS,
  defaults: { days: DEFAULT_DAYS, duration_minutes: DEFAULT_DURATION_MINUTES, timezone: DEFAULT_TIMEZONE },
  maxDays: MAX_DAYS,
  reasonText: REASON_TEXT,
} as const
