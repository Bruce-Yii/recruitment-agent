// IANA 时区校验与 DST 感知换算（纯函数，零 I/O、零时钟、零库、零网络）。
//
// 背景（审计 REPORT.md §③ / P2）：旧代码把时区当固定 `+8` 偏移或纯展示字段用，
// 真机 `UTC+5` / `Not/AZone` 都能落库，且夏令时切换那天排期会算错一小时。
// 本文件只提供**纯函数底座**，不读 `Date.now()`、不读进程时区、不连库、不发网络；
// 接线（写侧校验、读侧兼容展示）由调用方完成。
//
// 所有偏移的符号约定：**东为正**（+08:00 = 480，纽约冬令时 -05:00 = -300）。
// 只依赖 ECMAScript 标准 `Intl`，不引入任何依赖。

/** 本地年月日（墙上日历日期，不含时刻）。 */
export interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/**
 * IANA 名形态兜底正则（仅当 `Intl.supportedValuesOf` 不可用时使用）。
 * 允许 `Area/Location`、`Etc/GMT+5`、`UTC` 等；显式拒绝 `UTC+5` / `GMT-8`
 * 这类"偏移伪装成时区名"的写法。
 */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+/-]*(\/[A-Za-z0-9_+/-]+)*$/
const OFFSET_LOOKALIKE = /^(UTC|GMT|UT)[+-]/i
/** `supportedValuesOf` 只列规范名，会漏掉这些 ICU 认识的合法别名/固定偏移区。 */
const ALIASES = /^(UTC|GMT|UT|Etc\/(GMT|UTC|UCT|Zulu)([+-]\d{1,2})?)$/i

/** 进程支持的 IANA 时区白名单；`undefined` 表示该 Node/ICU 不支持此 API。 */
function supportedTimezones(): readonly string[] | undefined {
  const fn = (Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[]
  }).supportedValuesOf
  if (typeof fn !== 'function') return undefined
  try {
    return fn.call(Intl, 'timeZone')
  } catch {
    return undefined
  }
}

/**
 * 判断字符串是否是**可构造**且**看起来像 IANA 名**的时区。
 *
 * - 先用 `Intl.DateTimeFormat(undefined, { timeZone: value })` 试探（拒绝 `Not/AZone`、
 *   emoji、空串等）；
 * - 再用 `Intl.supportedValuesOf('timeZone')` 做白名单交叉校验，以拒绝 `UTC+5`
 *   这类被 ICU 宽松解析为偏移的伪名；该 API 不可用时退回形态正则 +
 *   显式拒绝 `UTC[+-]` / `GMT[+-]` / `UT[+-]`。
 *
 * `UTC` / `Etc/GMT+5` 是合法 IANA 名，返回 true。
 */
export function isValidIanaTimezone(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  if (OFFSET_LOOKALIKE.test(value)) return false
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: value })
  } catch {
    return false
  }
  if (ALIASES.test(value)) return true
  const whiteList = supportedTimezones()
  if (whiteList !== undefined) return whiteList.includes(value)
  return IANA_SHAPE.test(value)
}

/** 把 `CalendarDate` 归一为其**本地正午**对应的绝对时刻（epoch ms）。 */
function localDateNoonAsMs(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day, 12, 0, 0, 0)
}

/**
 * 解析 `longOffset` 输出，兼容下列 ICU 形态：
 * `GMT+08:00`、`GMT-04:00`、`GMT-5`、`UTC+08:00`、`+08:00`、`GMT`。
 * 返回分钟（东为正）；解析失败返回 `undefined`（调用方按 0 处理并视为非法输入）。
 */
function parseLongOffset(text: string): number | undefined {
  const match = /(?:GMT|UTC)?\s*([+-])(\d{1,2})(?::?(\d{2}))?/.exec(text)
  if (!match) return undefined
  const hours = Number(match[2])
  const minutes = match[3] === undefined ? 0 : Number(match[3])
  if (hours > 23 || minutes > 59) return undefined
  const total = hours * 60 + minutes
  return match[1] === '-' ? -total : total
}

/**
 * 取指定 IANA 时区在给定时刻的 UTC 偏移（分钟，东为正），DST 感知。
 *
 * - 传 `number`：语义为该**绝对时刻**（epoch ms）的实时偏移。
 * - 传 `CalendarDate`：语义为"**该本地日期正午对应的绝对时刻**的偏移"。
 *   正午取样避开跨日边界，也避开绝大多数 DST 切换点（切换通常发生在凌晨）；
 *   若调用方要的是当天 09:00 的准确偏移，应自行换算成 epoch ms 后传入。
 *
 * 非法时区或缺省偏移返回 0；调用方应先用 `isValidIanaTimezone` 拒绝非法值。
 */
export function getTimezoneOffsetMinutes(
  timeZone: string,
  date: CalendarDate | number,
): number {
  const at = typeof date === 'number' ? date : localDateNoonAsMs(date)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(at))
  const name = parts.find((part) => part.type === 'timeZoneName')?.value
  if (name === undefined) return 0
  return parseLongOffset(name) ?? 0
}

/**
 * 把某 IANA 时区的本地墙上时间换算为 epoch ms，DST 正确。
 *
 * 算法：先以"目标日期正午偏移"作首次猜测换算成 UTC，再用该猜测 UTC 的
 * 真实偏移修正一次（两步收敛，覆盖绝大多数 DST 跳变）。
 *
 * 歧义/缺口的选择（调用方据此接线）：
 * - **spring-forward 缺口**（本地时间不存在，如 2026-03-08 02:30 NY）：
 *   两步修正后结果会回落到缺口前的时刻；本函数再向前推进到缺口后的
 *   **第一个合法时刻**（即"靠后的合法时刻"），保证返回的时间在该时区
 *   格式化回来时不早于请求时间。
 * - **fall-back 重叠**（同一墙上时间出现两次）：取**靠后的**那一次（DST 结束后）。
 */
export function localDateToUtcMs(
  timeZone: string,
  date: CalendarDate,
  minuteOfDay: number,
): number {
  const wallUtc = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0, 0) + minuteOfDay * 60_000
  const guess = getTimezoneOffsetMinutes(timeZone, date)
  let at = wallUtc - guess * 60_000
  // 用该绝对时刻的真实偏移修正一次。
  at = wallUtc - getTimezoneOffsetMinutes(timeZone, at) * 60_000
  // spring-forward 缺口：格式化回来的墙上时间早于请求时间 → 向前推进到合法时刻。
  const wallBack = wallTimeMsInTimezone(at, timeZone)
  if (wallBack < wallUtc) {
    const jumped = wallUtc + (wallUtc - wallBack)
    at = wallUtc - getTimezoneOffsetMinutes(timeZone, jumped) * 60_000
  }
  return at
}

/** 把 epoch ms 格式化成该时区的"墙上时间" epoch 表示（不含偏移，用于缺口检测）。 */
function wallTimeMsInTimezone(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs))
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0')
  return Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second'),
    0,
  )
}

/**
 * 把绝对时刻格式化为带 IANA 时区偏移的 ISO-8601，例如
 * `2026-03-08T10:00:00.000-05:00`。历史非法/缺失时区由 `displayTimezone` 负责
 * 如实展示；本函数在收到非法时区时抛错，绝不会偷偷按 +8 格式化。
 */
export function formatInTimezone(epochMs: number, timeZone: string): string {
  if (!isValidIanaTimezone(timeZone)) {
    throw new RangeError(`非法 IANA 时区：${timeZone}`)
  }
  const offset = getTimezoneOffsetMinutes(timeZone, epochMs)
  return formatWithOffset(epochMs, offset)
}

/** 与 `formatWithOffset` 同一格式规则（东为正，毫秒恒 000）。 */
function formatWithOffset(ms: number, offsetMinutes: number): string {
  const shifted = new Date(ms + offsetMinutes * 60_000)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const offsetText = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
    + `.000${offsetText}`
  )
}

/**
 * 读侧兼容老数据：合法 IANA 时区原样返回；非法/缺失如实说明，**绝不假装是 +8**。
 */
export function displayTimezone(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') return '未记录时区'
  if (isValidIanaTimezone(value)) return value
  return `未知时区（原值：${value}）`
}
