// 飞书日历**只读**传输层：`lark-cli calendar +freebusy / +agenda` 的薄封装。
//
// 与 `transport.ts`（妙记全文回读）平行，但**只做忙闲/日程读取**，不新增任何
// 工具、不写任何飞书数据。硬约束：
//
//   1. **产品自己的应用档案**：每次真实调用 argv 最前面强制插入
//      `['--profile', 'recruitment']`（app `cli_aa72230051b8dcb7`，OAuth 有效）。
//      **绝不**回退默认档案 `cli_aae49f8438f8dce4`（那是开发者身份）。
//      profile 名是本文件常量，不接受调用方覆盖；要换 profile 必须改代码。
//   2. **只读命令**：只跑 `+freebusy` / `+agenda`，两者 `--help` 都标 `Risk: read`。
//      本文件**没有** `--yes`、没有 create/update/delete、没有任何写路径。
//   3. **外部读取失败 ≠ 没有空闲**：任何阶段失败都返回结构化 error，绝不以
//      空忙区间冒充「对方全天空」。典型失败：`AUTH_REQUIRED`（profile 缺
//      calendar scope / 凭据失效）、`NOT_CONNECTED`（没配 CLI 绝对路径）、
//      `CLI_NOT_FOUND` / `CLI_NON_ZERO_EXIT` / `ENVELOPE_UNRECOGNIZED`。
//   4. **标签按 R4**：只有真实回读成功且通道声明为平台通道，才给
//      `provenance='LIVE' / connection='CONNECTED'`；失败一律
//      `FIXTURE / AUTH_REQUIRED|NOT_CONNECTED`，trigger 恒 `MANUAL`（HTTP 手动触发）。
//
// 注入点：`runner` 可注入（单测用假 runner，不连网）；生产用
// `createCalendarProcessRunner()` + 绝对路径 CLI。所有诊断都不回显 argv、
// 不回显日程标题/正文（R7），只给 stage / code / 退出码 / 脱敏 stderr 前缀。
import { createProcessCliRunner } from './transport.ts'

// ---------------------------------------------------------------------------
//  常量
// ---------------------------------------------------------------------------

/** 产品自己的 lark-cli profile 名（**禁止**改成默认档案或交给调用方传）。 */
export const CALENDAR_CLI_PROFILE = 'recruitment'

/** 全局 flag：必须写在子命令之前。 */
export const CALENDAR_PROFILE_FLAG = '--profile'

/** 只读快捷命令。 */
export const CALENDAR_READ_COMMANDS = {
  freebusy: '+freebusy',
  agenda: '+agenda',
} as const

/** `--as` 取值：`+freebusy` 查他人必须 user 身份。 */
export const CALENDAR_IDENTITY = 'user'

/**
 * lark-cli 配置/授权层失败的结构投影（非敏感：只取 type/subtype/code）。
 * 2026-11-19 实测：profile `recruitment` 跑 `calendar +agenda` 返回 exit 3、
 * stdout 为 `{"ok":false,"identity":"user","error":{"type":"authorization",
 * "subtype":"missing_scope", ...}}`。这类失败不是传输抖动，重试不会变好。
 */
export interface CalendarAuthFailure {
  readonly type: string | null
  readonly subtype: string | null
  readonly code: string | null
}

/** 一次忙闲查询的入参。 */
export interface FreebusyQuery {
  /** 目标用户 open_id（`ou_` 前缀）。不传 = 当前登录用户（本人）。 */
  readonly user_id?: string
  /** 查询窗口（带偏移 ISO-8601 或 YYYY-MM-DD）。 */
  readonly start: string
  readonly end: string
}

/** 忙闲区间（epoch 毫秒半开区间），由真实回读解析而来。 */
export interface BusyInterval {
  readonly start_ms: number
  readonly end_ms: number
}

/** 一次成功回读的结果。 */
export interface CalendarReadback {
  /** 忙区间（可能为空 = 这段窗口真的没有忙碌，不是读取失败）。 */
  readonly busy: readonly BusyInterval[]
  /** 通道：`LIVE`（平台通道 + 真实回读）或 `FIXTURE`（测试/回放通道）。 */
  readonly transport: 'LIVE' | 'FIXTURE'
  /** 本次读取时刻（带偏移 ISO-8601，由调用方注入的时钟给出）。 */
  readonly fetched_at: string
  /** 读到的区间条数（诊断用，不含标题/正文）。 */
  readonly busy_count: number
}

/** 读取结局：成功 / 失败（无「空忙区间冒充失败」的第三条路）。 */
export type CalendarReadResult =
  | { readonly status: 'READ'; readonly readback: CalendarReadback }
  | { readonly status: 'FAILED'; readonly error: CalendarReadError }

/** 机器可判的错误码（闭集）。 */
export type CalendarErrorCode =
  | 'NOT_CONNECTED'
  | 'CLI_NOT_FOUND'
  | 'CLI_NOT_EXECUTABLE'
  | 'CLI_SPAWN_FAILED'
  | 'CLI_TIMEOUT'
  | 'CLI_NON_ZERO_EXIT'
  | 'AUTH_REQUIRED'
  | 'ENVELOPE_UNRECOGNIZED'
  | 'BAD_TIME_RANGE'

/** 传输失败落在哪一段。 */
export type CalendarStage = 'locate-cli' | 'invoke' | 'parse' | 'validate' | 'config'

/** 人话错误（message 可直接给人看；不含 argv / 标题 / 正文 / 凭据）。 */
export class CalendarReadError extends Error {
  readonly code: CalendarErrorCode
  readonly stage: CalendarStage
  readonly exit_code: number | null
  readonly auth: CalendarAuthFailure | null

  constructor(init: {
    readonly code: CalendarErrorCode
    readonly stage: CalendarStage
    readonly message: string
    readonly exit_code?: number | null
    readonly auth?: CalendarAuthFailure | null
  }) {
    super(init.message)
    this.name = 'CalendarReadError'
    this.code = init.code
    this.stage = init.stage
    this.exit_code = init.exit_code ?? null
    this.auth = init.auth ?? null
  }
}

// ---------------------------------------------------------------------------
//  子进程 runner（可注入）
// ---------------------------------------------------------------------------

/** 一次 CLI 调用的结局（沿用妙记传输层的口径）。 */
export interface CalendarCliRunResult {
  readonly status: 'OK' | 'NON_ZERO_EXIT' | 'SPAWN_FAILED' | 'TIMEOUT' | 'SIGNALED'
  readonly exit_code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly spawn_error_code?: string
  readonly signal?: string | null
}

/** 可注入 runner：`args` 已含 `--profile recruitment`，runner 不得再改。 */
export type CalendarCliRunner = (args: readonly string[]) => Promise<CalendarCliRunResult>

/** 造一个真实子进程 runner（只读命令，不带 shell，带超时与输出上限）。 */
export function createCalendarProcessRunner(config: {
  readonly command: string
  readonly timeout_ms?: number
}): CalendarCliRunner {
  // 复用 transport.ts 的唯一子进程出口（AGENTS 静态扫描：只有 transport.ts 能碰子进程）。
  const runner = createProcessCliRunner({
    command: config.command,
    ...(config.timeout_ms === undefined ? {} : { timeout_ms: config.timeout_ms }),
  })
  return async (args) => {
    const result = await runner({ args: [...args], timeout_ms: config.timeout_ms ?? 30000, attempt: 1 })
    return {
      status: result.status as CalendarCliRunResult['status'],
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
      ...(result.spawn_error_code === undefined ? {} : { spawn_error_code: result.spawn_error_code }),
    }
  }
}

export function buildCalendarArgs(command: '+freebusy' | '+agenda', query: FreebusyQuery): string[] {
  const args: string[] = [CALENDAR_PROFILE_FLAG, CALENDAR_CLI_PROFILE, 'calendar', command, '--as', CALENDAR_IDENTITY]
  if (command === '+freebusy' && query.user_id !== undefined) {
    if (!/^ou_[A-Za-z0-9_-]{1,128}$/.test(query.user_id)) {
      throw new CalendarReadError({
        code: 'BAD_TIME_RANGE',
        stage: 'validate',
        message: 'user_id 必须是 ou_ 前缀的合法 open_id（不许猜、不许传邮箱或姓名）',
      })
    }
    args.push('--user-id', query.user_id)
  }
  args.push('--start', query.start, '--end', query.end, '--format', 'json')
  return args
}

/** `YYYY-MM-DD` 或带偏移 ISO 时间：只做形态校验，不猜时区。 */
function validTime(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}([T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
}

// ---------------------------------------------------------------------------
//  解析（fail-closed）
// ---------------------------------------------------------------------------

/** 从 CLI 信封里取一条 `type/subtype/code`（不取 message，避免租户内容）。 */
function authFailureFromJson(text: string): CalendarAuthFailure | null {
  try {
    const root = JSON.parse(text) as unknown
    if (typeof root !== 'object' || root === null) return null
    const error = (root as Record<string, unknown>).error
    if (typeof error !== 'object' || error === null) return null
    const node = error as Record<string, unknown>
    return {
      type: typeof node.type === 'string' ? node.type : null,
      subtype: typeof node.subtype === 'string' ? node.subtype : null,
      code: typeof node.code === 'string' || typeof node.code === 'number' ? String(node.code) : null,
    }
  } catch {
    return null
  }
}

/** 把 `[start,end)` 的 ISO 字符串解析成 epoch ms；任一端非法返回 null（不猜）。 */
function parseBusyInterval(item: unknown): BusyInterval | null {
  if (typeof item !== 'object' || item === null) return null
  const node = item as Record<string, unknown>
  const rawStart = node.start ?? node.start_time
  const rawEnd = node.end ?? node.end_time
  const startObj = typeof rawStart === 'object' && rawStart !== null ? (rawStart as Record<string, unknown>) : null
  const endObj = typeof rawEnd === 'object' && rawEnd !== null ? (rawEnd as Record<string, unknown>) : null
  const startText = startObj !== null
    ? (typeof startObj.date_time === 'string' ? startObj.date_time : startObj.timestamp)
    : rawStart
  const endText = endObj !== null
    ? (typeof endObj.date_time === 'string' ? endObj.date_time : endObj.timestamp)
    : rawEnd
  const startMs = typeof startText === 'number' ? startText : typeof startText === 'string' ? Date.parse(startText) : NaN
  const endMs = typeof endText === 'number' ? endText : typeof endText === 'string' ? Date.parse(endText) : NaN
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null
  return { start_ms: startMs, end_ms: endMs }
}

/**
 * 解析 `+freebusy` stdout。fail-closed：形状不认识 → `ENVELOPE_UNRECOGNIZED`；
 * `ok:false` + `error.type ∈ {authorization, config, auth}` 或
 * `subtype ∈ {missing_scope, not_configured}` → `AUTH_REQUIRED`。
 * **不回显任何标题/正文**（只解析忙闲起止时间）。
 */
export function parseFreebusyEnvelope(stdout: string): BusyInterval[] {
  let root: unknown
  try {
    root = JSON.parse(stdout.trim())
  } catch {
    throw new CalendarReadError({
      code: 'ENVELOPE_UNRECOGNIZED',
      stage: 'parse',
      message: '日历 CLI 输出不是 JSON：不按「没有忙碌」处理，交人工排查',
    })
  }
  if (typeof root !== 'object' || root === null) {
    throw new CalendarReadError({ code: 'ENVELOPE_UNRECOGNIZED', stage: 'parse', message: '日历 CLI 输出根不是对象：不猜语义' })
  }
  const envelope = root as Record<string, unknown>
  if (envelope.ok === false) {
    const auth = authFailureFromJson(stdout)
    const isAuth = auth !== null
      && (auth.type === 'authorization' || auth.type === 'config' || auth.type === 'auth'
        || auth.subtype === 'missing_scope' || auth.subtype === 'not_configured')
    throw new CalendarReadError({
      code: isAuth ? 'AUTH_REQUIRED' : 'CLI_NON_ZERO_EXIT',
      stage: isAuth ? 'parse' : 'invoke',
      message: isAuth
        ? '飞书日历读取未获授权（profile 缺 calendar scope 或凭据失效）：没有读到忙闲，不冒充「双方都有空」'
        : '日历 CLI 返回 ok=false：不猜语义、不产出忙闲区间',
      auth,
    })
  }
  const data = envelope.data
  // 真机实测：应用级 scope 未开时 `+freebusy` 仍返回 ok:true 但 data:null（不报错）。
  // 这不是「双方都有空」，而是「读不到忙闲」——如实报 AUTH_REQUIRED，绝不冒充空闲。
  if (data === null || data === undefined) {
    throw new CalendarReadError({ code: 'AUTH_REQUIRED', stage: 'parse', message: '飞书日历忙闲读不到（应用级日历只读权限未开通或该用户无数据）：不冒充空闲' })
  }
  if (typeof data !== 'object') {
    throw new CalendarReadError({ code: 'ENVELOPE_UNRECOGNIZED', stage: 'parse', message: '日历 CLI 信封里没有 data 对象' })
  }
  const dataNode = data as Record<string, unknown>
  let rawBusy: unknown
  for (const key of ['busy', 'busy_times', 'busy_intervals']) {
    if (Array.isArray(dataNode[key])) { rawBusy = dataNode[key]; break }
  }
  if (rawBusy === undefined) {
    for (const containerKey of ['freebusys', 'items', 'users']) {
      const container = dataNode[containerKey]
      if (!Array.isArray(container)) continue
      for (const entry of container) {
        if (typeof entry !== 'object' || entry === null) continue
        const candidate = (entry as Record<string, unknown>).busy
        if (Array.isArray(candidate)) { rawBusy = candidate; break }
      }
      if (rawBusy !== undefined) break
    }
  }
  if (!Array.isArray(rawBusy)) {
    throw new CalendarReadError({
      code: 'ENVELOPE_UNRECOGNIZED',
      stage: 'parse',
      message: '日历 CLI 信封里找不到忙区间数组（data.busy / data.freebusys[].busy）：不认识的形状不当成「空闲」',
    })
  }
  const busy: BusyInterval[] = []
  for (const item of rawBusy) {
    const interval = parseBusyInterval(item)
    if (interval !== null) busy.push(interval)
  }
  return busy
}

// ---------------------------------------------------------------------------
//  传输层
// ---------------------------------------------------------------------------

/** 传输层配置。 */
export interface CalendarTransportConfig {
  /** 必填：怎么跑 CLI（生产用 `createCalendarProcessRunner({command: 绝对路径})`）。 */
  readonly runner: CalendarCliRunner
  /** 这条 runner 是不是真实平台通道（只有插件配置装配时才置 true）。 */
  readonly platform_channel?: boolean
  /** 时钟注入（测试用）。 */
  readonly now?: () => Date
  /** 是否允许把 `ok:true` 的空 busy 当成「真的没有忙碌」（默认 true）。 */
  readonly allow_empty_busy?: boolean
}

/** 传输层出口。 */
export interface FeishuCalendarReader {
  readonly profile: typeof CALENDAR_CLI_PROFILE
  readonly describe: () => { readonly profile: string; readonly platform_channel: boolean; readonly commands: readonly string[] }
  readonly readFreebusy: (query: FreebusyQuery) => Promise<CalendarReadResult>
  readonly readAgenda: (query: FreebusyQuery) => Promise<CalendarReadResult>
}

/** ISO-8601（带本地偏移）的当前时刻，格式与 `labels.ts` 同源。 */
function nowIso(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T`
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 把 runner 的失败结局翻成结构化错误（人话 + 码，不回显 argv）。 */
function errorFromRun(result: CalendarCliRunResult, platformChannel: boolean): CalendarReadError {
  const spawnCode = result.spawn_error_code ?? ''
  if (result.status === 'SPAWN_FAILED') {
    if (spawnCode === 'ENOENT') {
      return new CalendarReadError({
        code: 'CLI_NOT_FOUND', stage: 'locate-cli',
        message: '找不到 lark-cli 可执行文件：日历不可用，不按「没有空闲」处理',
      })
    }
    if (spawnCode === 'EACCES' || spawnCode === 'EPERM') {
      return new CalendarReadError({
        code: 'CLI_NOT_EXECUTABLE', stage: 'locate-cli',
        message: 'lark-cli 不可执行：日历不可用，不按「没有空闲」处理',
      })
    }
    return new CalendarReadError({
      code: 'CLI_SPAWN_FAILED', stage: 'locate-cli',
      message: `lark-cli 启动失败（${spawnCode || '未知系统错误'}）：没有读到日历`,
    })
  }
  if (result.status === 'TIMEOUT') {
    return new CalendarReadError({ code: 'CLI_TIMEOUT', stage: 'invoke', message: 'lark-cli 日历查询超时：没有读到忙闲，不按「空闲」处理' })
  }
  if (result.status === 'SIGNALED') {
    return new CalendarReadError({ code: 'CLI_SPAWN_FAILED', stage: 'invoke', message: 'lark-cli 被信号终止：没有读到忙闲' })
  }
  // 非零退出：先判授权层（stdout 或 stderr 里的 JSON error.type/subtype）。
  const auth = authFailureFromJson(result.stdout) ?? authFailureFromJson(result.stderr)
  if (auth !== null && (auth.type === 'authorization' || auth.type === 'config' || auth.type === 'auth'
      || auth.subtype === 'missing_scope' || auth.subtype === 'not_configured')) {
    return new CalendarReadError({
      code: 'AUTH_REQUIRED', stage: 'invoke', exit_code: result.exit_code, auth,
      message: '飞书日历读取未获授权（profile 缺 calendar scope 或凭据失效）：没有读到忙闲，不冒充「双方都有空」',
    })
  }
  return new CalendarReadError({
    code: 'CLI_NON_ZERO_EXIT', stage: 'invoke', exit_code: result.exit_code,
    message: `lark-cli 日历查询失败（退出码 ${String(result.exit_code)}）：没有读到忙闲，不冒充「空闲」`,
  })
}

/**
 * 造一个日历只读 reader。真实调用强制带 `--profile recruitment`。
 * @param config - runner 必填；`platform_channel=false` 时回读 `transport=FIXTURE`。
 */
export function createFeishuCalendarReader(config: CalendarTransportConfig): FeishuCalendarReader {
  const runner = config.runner
  const now = config.now ?? ((): Date => new Date())
  const platformChannel = config.platform_channel === true
  const transport: 'LIVE' | 'FIXTURE' = platformChannel ? 'LIVE' : 'FIXTURE'

  async function read(command: '+freebusy' | '+agenda', query: FreebusyQuery): Promise<CalendarReadResult> {
    if (!validTime(query.start) || !validTime(query.end)) {
      return { status: 'FAILED', error: new CalendarReadError({
        code: 'BAD_TIME_RANGE', stage: 'validate', message: '查询起止时间必须是 YYYY-MM-DD 或带偏移 ISO-8601',
      }) }
    }
    let args: string[]
    try {
      args = buildCalendarArgs(command, query)
    } catch (error) {
      return { status: 'FAILED', error: error as CalendarReadError }
    }
    const result = await runner(args)
    if (result.status !== 'OK') {
      return { status: 'FAILED', error: errorFromRun(result, platformChannel) }
    }
    try {
      const busy = command === '+freebusy'
        ? parseFreebusyEnvelope(result.stdout)
        : parseAgendaEnvelope(result.stdout)
      return {
        status: 'READ',
        readback: { busy, transport, fetched_at: nowIso(now()), busy_count: busy.length },
      }
    } catch (error) {
      return { status: 'FAILED', error: error as CalendarReadError }
    }
  }

  return {
    profile: CALENDAR_CLI_PROFILE,
    describe: () => ({ profile: CALENDAR_CLI_PROFILE, platform_channel: platformChannel, commands: ['+freebusy', '+agenda'] }),
    readFreebusy: (query) => read('+freebusy', query),
    readAgenda: (query) => read('+agenda', query),
  }
}

/**
 * 解析 `+agenda` stdout（真链探测用）。复用与 freebusy 相同的信封/错误判定，
 * 只取每条日程的 start/end 作为忙碌区间，**不保留标题/描述**（R7）。
 */
export function parseAgendaEnvelope(stdout: string): BusyInterval[] {
  // 与 freebusy 同样的 fail-closed 信封解析；agenda 的日程在 data.items[] / data.agenda[]。
  let root: unknown
  try {
    root = JSON.parse(stdout.trim())
  } catch {
    throw new CalendarReadError({ code: 'ENVELOPE_UNRECOGNIZED', stage: 'parse', message: '日历 CLI 输出不是 JSON：不按「没有日程」处理' })
  }
  if (typeof root !== 'object' || root === null) {
    throw new CalendarReadError({ code: 'ENVELOPE_UNRECOGNIZED', stage: 'parse', message: '日历 CLI 输出根不是对象' })
  }
  const envelope = root as Record<string, unknown>
  if (envelope.ok === false) {
    const auth = authFailureFromJson(stdout)
    const isAuth = auth !== null
      && (auth.type === 'authorization' || auth.type === 'config' || auth.type === 'auth'
        || auth.subtype === 'missing_scope' || auth.subtype === 'not_configured')
    throw new CalendarReadError({
      code: isAuth ? 'AUTH_REQUIRED' : 'CLI_NON_ZERO_EXIT', stage: isAuth ? 'parse' : 'invoke',
      message: isAuth ? '飞书日历未获授权（缺 calendar scope）：没有读到日程' : '日历 CLI 返回 ok=false：不猜语义',
      auth,
    })
  }
  const data = envelope.data
  // 真实形态：`+agenda` 在没有日程时返回 `data: []`（**数组**），不是对象；有日程时是 data.items[]。
  if (Array.isArray(data)) {
    const busy: BusyInterval[] = []
    for (const item of data) {
      const interval = parseBusyInterval(item)
      if (interval !== null) busy.push(interval)
    }
    return busy
  }
  if (typeof data !== 'object' || data === null) {
    throw new CalendarReadError({ code: 'ENVELOPE_UNRECOGNIZED', stage: 'parse', message: '日历 CLI 信封里没有 data 对象' })
  }
  const dataNode = data as Record<string, unknown>
  let items: unknown
  for (const key of ['items', 'agenda', 'events', 'activities']) {
    if (Array.isArray(dataNode[key])) { items = dataNode[key]; break }
  }
  if (!Array.isArray(items)) {
    throw new CalendarReadError({
      code: 'ENVELOPE_UNRECOGNIZED', stage: 'parse',
      message: '日历 CLI 信封里找不到日程数组（data.items / data.agenda）：不认识的形状不当成「空闲」',
    })
  }
  const busy: BusyInterval[] = []
  for (const item of items) {
    const interval = parseBusyInterval(item)
    if (interval !== null) busy.push(interval)
  }
  return busy
}
