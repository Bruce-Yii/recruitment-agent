// 客户端**纯函数**格式化层：把任意脏值收紧成可渲染的字符串/数字。
//
// 为什么单独一层：视图模型里每一个时间、字节数、sha256、枚举都要先经过这里，
// 保证空响应 / 坏类型 / 非法日期不会变成 `NaN` / `undefined` / `Invalid Date`。
// 本文件**不 import react、不碰 DOM**，可被 `node --test` 直接覆盖。
//
// 口径：
//   · 取不到的一律降级成 `''` / `0` / `null`，**不编造业务值**；
//   · 时间统一格式化成本地 `YYYY-MM-DD HH:mm`（`docs/18` 演示时区 Asia/Shanghai）；
//   · 字节数按 `formatsize` 口径给 B / KB / MB / GB（需求点名"字节数 → MB"）；
//   · sha256 只展示前 10 位 + `…`（完整哈希留在服务端 / 原始响应里）。

/** 状态 chip 的五个色档（与 V5.6.1 `.chip.blue/green/amber/red/默认灰` 一一对应）。 */
export type ChipTone = 'blue' | 'green' | 'amber' | 'red' | 'gray'

/** 取非空字符串；数字/布尔/对象不算字符串（避免把坏类型伪装成文本）。 */
export function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? fallback : trimmed
  }
  return fallback
}

/** 取非负有限整数；否则 0（杜绝 NaN / Infinity / 字符串数字 / 负数）。 */
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

/** 取非负有限数字；否则 null（用于 `page_count` 这类"可能没有"的字段）。 */
export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 取布尔；只认严格 true（字符串 'true' 不算）。 */
export function bool(value: unknown): boolean {
  return value === true
}

/** 取普通对象；null / 数组 / 标量一律降级成空对象。 */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 取数组；非数组降级成空数组（调用方自行过滤元素）。 */
export function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 字符串数组归一化：丢弃非字符串 / 空白项，保留顺序。 */
export function stringList(value: unknown): string[] {
  const out: string[] = []
  for (const item of items(value)) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
  }
  return out
}

/** 只保留白名单里的枚举值；未知值降级成 `''`（不把未知枚举渲染成合法选项）。 */
export function oneOf(value: unknown, allowed: readonly string[]): string {
  const candidate = text(value)
  return allowed.includes(candidate) ? candidate : ''
}

/** 把若干文本拼成一句（跳过空串），默认分隔符 ` · `。 */
export function joinTexts(parts: readonly string[], separator = ' · '): string {
  return parts.filter((part) => part !== '').join(separator)
}

/** 本地时区 `YYYY-MM-DD HH:mm`；null / 空串 / 非法日期 → `''`。 */
export function formatDateTime(value: unknown): string {
  const raw = text(value)
  if (raw === '') return ''
  const parsed = new Date(raw)
  const time = parsed.valueOf()
  if (!Number.isFinite(time)) return ''
  return `${formatDateParts(parsed)} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`
}

/** 本地时区 `YYYY-MM-DD`；null / 空串 / 非法日期 → `''`。 */
export function formatDate(value: unknown): string {
  const raw = text(value)
  if (raw === '') return ''
  const parsed = new Date(raw)
  if (!Number.isFinite(parsed.valueOf())) return ''
  return formatDateParts(parsed)
}

/** 字节数 → 可读体量（B / KB / MB / GB）。0 → `0 B`；负数 / 非数字 / null → `''`。 */
export function formatBytes(value: unknown): string {
  const bytes = numberOrNull(value)
  if (bytes === null) return ''
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return unit === 0 ? `${String(Math.round(size))} B` : `${size.toFixed(1)} ${units[unit]}`
}

/** sha256 截断展示：64 位十六进制 → 前 10 位 + `…`；短文本原样返回；空 → `''`。 */
export function shortSha(value: unknown): string {
  const raw = text(value)
  if (raw === '') return ''
  if (/^[0-9a-fA-F]{16,}$/.test(raw)) return `${raw.slice(0, 10)}…`
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw
}

/** 头像里的首字（中文取第一个字符；空 → `·`）。 */
export function initial(value: unknown): string {
  const raw = text(value)
  return raw === '' ? '·' : Array.from(raw)[0] ?? '·'
}

/** 百分比：分母为 0 时返回 0（不产生 NaN）。 */
export function ratioPercent(numerator: unknown, denominator: unknown): number {
  const top = count(numerator)
  const bottom = count(denominator)
  if (bottom === 0) return 0
  return Math.round((top / bottom) * 100)
}

/** 任意未知值的一行预览（用于 rubric 的 `value` 这类无契约字段；不渲染 `[object Object]`）。 */
export function preview(value: unknown, maxLength = 108): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value.slice(0, 8)) {
      const rendered = preview(item, 32)
      if (rendered !== '') parts.push(rendered)
    }
    return parts.join('、')
  }
  try {
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string') return ''
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized
  } catch {
    return ''
  }
}

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value)
}

/** 本地 `YYYY-MM-DD`。 */
function formatDateParts(date: Date): string {
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}
