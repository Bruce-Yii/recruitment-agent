// Issue #60：CSV 导出 × 轻量 Webhook 外部同步的纯领域层。
//
// 纪律（与 docs/41 §一 Phase 2 / design/v4/settings-progressive-disclosure-spec.md 对齐）：
//   * CSV 全人话列，**零内部 UUID / 零完整 sha256 / 零「证据」**；联系方式恒脱敏；
//     任何以 `= + - @` 开头的单元格前置单引号，阻断表格软件公式注入；
//     输出带 UTF-8 BOM（Excel 中文不乱码）。
//   * external_webhook_config 是 append-only 设置值：`secret` 只在写入口出现，
//     在落库前换成 `secret_hash`（sha256），GET 投影**永不回传任何明文/哈希**，
//     只给 `secret_set` 布尔；URL 只允许 https，回环 http://127.0.0.1 需显式 opt-in。
//   * 事件集合封闭：decision.recorded / stage.advanced / booking.confirmed。
//   * 校验全部服务端完成（fail-closed），拒绝未知字段/缺字段/越界/错误类型。
//   * 本文件不访问 DB / 网络 / 进程环境；派发器在 `http/export.ts` 用依赖注入实现。
import { createHash } from 'node:crypto'

import { canonicalJson } from '../tools/contract.ts'
import { RecruitmentToolError } from '../tools/errors.ts'
import { maskEmail, maskPhone } from './candidate-dedup.ts'

// ---------------------------------------------------------------------------
//  错误（与 tenant-config.ts 同形：`CODE: <compact-json>`）
// ---------------------------------------------------------------------------

export type ExportWebhookErrorCode = 'INVALID_ARGS' | 'INVARIANT_VIOLATION'

function exportWebhookError(
  code: ExportWebhookErrorCode,
  reasonCode: string,
  message: string,
  detail?: Record<string, unknown>,
): RecruitmentToolError {
  const body: Record<string, unknown> = { code, reason_code: reasonCode, message }
  if (detail !== undefined) body.detail = detail
  return new RecruitmentToolError(code as never, canonicalJson(body))
}

// ---------------------------------------------------------------------------
//  external_webhook_config
// ---------------------------------------------------------------------------

/** 允许订阅的事件（封闭集；顺序固定以便稳定投影）。 */
export const WEBHOOK_EVENTS = [
  'decision.recorded',
  'stage.advanced',
  'booking.confirmed',
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/** 写入口的配置形状（secret 是可选明文，只在写请求中出现）。 */
export interface ExternalWebhookConfigWrite {
  readonly enabled: boolean
  readonly url: string
  readonly events: readonly WebhookEvent[]
  readonly secret?: string
}

/** 落库/读取的内部形状（secret 永不明文，只有 sha256 哈希）。 */
export interface ExternalWebhookConfigStored {
  readonly enabled: boolean
  readonly url: string
  readonly events: readonly WebhookEvent[]
  /** secret 的 sha256（64 位十六进制）；从未设置 secret 时不存在该键。 */
  readonly secret_hash?: string
}

/** GET 投影（绝不回传明文/哈希；只给 secret_set 布尔）。 */
export interface ExternalWebhookConfigView {
  readonly enabled: boolean
  readonly url: string
  readonly events: readonly WebhookEvent[]
  readonly secret_set: boolean
}

/** 默认值（诚实缺省：未配置 = 关闭、空 URL、不订阅）。 */
export const DEFAULT_EXTERNAL_WEBHOOK_CONFIG: ExternalWebhookConfigView = {
  enabled: false,
  url: '',
  events: [],
  secret_set: false,
}

const SHA256_RE = /^[0-9a-f]{64}$/
const ALLOWED_WRITE_KEYS = ['enabled', 'url', 'events', 'secret'] as const
const ALLOWED_STORED_KEYS = ['enabled', 'url', 'events', 'secret_hash'] as const

/** URL 强校验：`https://` 任意主机，或显式 opt-in 的 `http://127.0.0.1[:port]` / `http://[::1][:port]`。 */
/** 判断主机名是否指向云元数据、私网、回环或内网域名（防 SSRF）。 */
export function isPrivateOrMetadataHost(hostnameRaw: string): boolean {
  const host = hostnameRaw.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return true
  }
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}

export function validateWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_URL_INVALID',
      'Webhook 地址必须是 1–2048 字符的字符串。')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_URL_INVALID',
      'Webhook 地址必须是合法 URL（https://，或本地测试专用 http://127.0.0.1）。')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_URL_CREDENTIALS',
      'Webhook 地址不允许内嵌用户名/密码。')
  }
  if (parsed.hash !== '' || parsed.search !== '') {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_URL_QUERY_FRAGMENT',
      'Webhook 地址不允许查询串或片段。')
  }
  if (parsed.protocol === 'https:') {
    if (isPrivateOrMetadataHost(parsed.hostname)) {
      throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_URL_SSRF_BLOCKED',
        'Webhook 地址禁止指向内网私网、回环或云元数据地址（防 SSRF）。')
    }
    return parsed.toString()
  }
  if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')) {
    return parsed.toString()
  }
  throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_URL_SCHEME',
    'Webhook 地址必须是 https://；本地测试允许 http://127.0.0.1（显式回环 opt-in）。')
}

/** secret 强度校验：16–512 字符，非纯空白。 */
export function validateWebhookSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || value.trim() === '') {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_SECRET_INVALID',
      '签名密钥必须是 16–512 字符的非空白字符串。')
  }
  return value
}

/**
 * 校验写入口的配置并返回**可直接落库**的形状（secret 已换成 secret_hash）。
 *
 * 强 fail-closed：未知字段 / 缺字段 / 类型错误 / 事件非封闭集 / 空事件集合（enabled=true 时）一律拒。
 * 不传 secret 时保留旧哈希由 HTTP 层在写路径合并（本函数只负责"本次写"的形状）。
 */
export function validateExternalWebhookConfig(value: unknown): ExternalWebhookConfigStored {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_CONFIG_NOT_OBJECT',
      'external_webhook_config 必须是对象。')
  }
  const raw = value as Record<string, unknown>
  const unknown = Object.keys(raw).filter((k) => !(ALLOWED_WRITE_KEYS as readonly string[]).includes(k)).sort()
  if (unknown.length > 0) {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_CONFIG_UNKNOWN_FIELD',
      'external_webhook_config 不接受未知字段。', { unknown })
  }
  const missing = (['enabled', 'url', 'events'] as const).filter((k) => !Object.hasOwn(raw, k))
  if (missing.length > 0) {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_CONFIG_MISSING_FIELD',
      'external_webhook_config 缺必填字段。', { missing: [...missing] })
  }
  if (typeof raw.enabled !== 'boolean') {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_ENABLED_NOT_BOOLEAN', 'enabled 必须是布尔值。')
  }
  const url = validateWebhookUrl(raw.url)
  if (!Array.isArray(raw.events) || raw.events.length === 0) {
    throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_EVENTS_INVALID',
      'events 必须是非空数组，取值为订阅事件的封闭集。')
  }
  const seen = new Set<string>()
  const events: WebhookEvent[] = []
  for (const item of raw.events) {
    if (typeof item !== 'string' || !(WEBHOOK_EVENTS as readonly string[]).includes(item)) {
      throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_EVENT_UNKNOWN',
        'events 只能包含 decision.recorded / stage.advanced / booking.confirmed。',
        { allowed: [...WEBHOOK_EVENTS] })
    }
    if (seen.has(item)) {
      throw exportWebhookError('INVALID_ARGS', 'WEBHOOK_EVENT_DUPLICATE', 'events 不允许重复。')
    }
    seen.add(item)
    events.push(item as WebhookEvent)
  }
  events.sort((a, b) => WEBHOOK_EVENTS.indexOf(a) - WEBHOOK_EVENTS.indexOf(b))
  const secretHash = raw.secret === undefined ? undefined : hashSecret(validateWebhookSecret(raw.secret))
  return {
    enabled: raw.enabled,
    url,
    events,
    ...(secretHash === undefined ? {} : { secret_hash: secretHash }),
  }
}

/** 计算 secret 的 sha256（服务端唯一一处）。 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * 把"本次写入值"与"旧库值"合并（未传 secret 时保留旧 secret_hash；传了就轮换）。
 * 供 settings 写路径在 appendSettingVersion 之前调用。
 */
export function mergeWebhookSecret(
  incoming: ExternalWebhookConfigStored,
  previous: unknown,
): ExternalWebhookConfigStored {
  if (incoming.secret_hash !== undefined) return incoming
  const priorHash = storedConfigFromValue(previous)?.secret_hash
  return priorHash === undefined ? incoming : { ...incoming, secret_hash: priorHash }
}

/**
 * 从库值恢复内部形状（严格：未知键 / 错误类型 / 非法 hash 一律当作未配置，绝不猜）。
 */
export function storedConfigFromValue(value: unknown): ExternalWebhookConfigStored | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((k) => !(ALLOWED_STORED_KEYS as readonly string[]).includes(k))) return null
  if (typeof raw.enabled !== 'boolean' || typeof raw.url !== 'string' || !Array.isArray(raw.events)) return null
  const events: WebhookEvent[] = []
  for (const item of raw.events) {
    if (typeof item !== 'string' || !(WEBHOOK_EVENTS as readonly string[]).includes(item)) return null
    events.push(item as WebhookEvent)
  }
  if (raw.secret_hash !== undefined
    && (typeof raw.secret_hash !== 'string' || !SHA256_RE.test(raw.secret_hash))) return null
  return {
    enabled: raw.enabled,
    url: raw.url,
    events,
    ...(typeof raw.secret_hash === 'string' ? { secret_hash: raw.secret_hash } : {}),
  }
}

/** GET 投影：绝不返回 secret_hash / secret 明文，只给布尔。 */
export function webhookConfigView(value: unknown): ExternalWebhookConfigView {
  const stored = storedConfigFromValue(value)
  if (stored === null) return { ...DEFAULT_EXTERNAL_WEBHOOK_CONFIG }
  return {
    enabled: stored.enabled,
    url: stored.url,
    events: [...stored.events],
    secret_set: stored.secret_hash !== undefined,
  }
}

/** 派发器实际使用的有效配置（必须有 URL；secret 未设置则不签名？——不：无 secret 一律拒绝派发）。 */
export function dispatchableConfig(value: unknown): ExternalWebhookConfigStored | null {
  const stored = storedConfigFromValue(value)
  if (stored === null || !stored.enabled || stored.secret_hash === undefined) return null
  try { validateWebhookUrl(stored.url) } catch { return null }
  if (stored.events.length === 0) return null
  return stored
}

// ---------------------------------------------------------------------------
//  CSV 导出
// ---------------------------------------------------------------------------

/** 人话列（顺序即契约；零 UUID / 零 sha256 / 零禁用词）。 */
export const CSV_HEADERS = [
  '候选人姓名',
  '掩码手机号',
  '掩码邮箱',
  '应聘岗位',
  '当前阶段',
  '初筛结论',
  '面评进度',
  '终审结论',
  '更新时间',
] as const

/** 一行 CSV 的入参（全部是可直接展示的人话；不接收内部 id）。 */
export interface CsvApplicationRow {
  readonly candidate_name: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly job_title: string | null
  readonly stage: string | null
  readonly screening_conclusion: string | null
  readonly scorecard_progress: string | null
  readonly final_decision: string | null
  readonly updated_at: string | null
}

/** CSV 单元格转义：公式注入防护 + 引号/换行/回车转码。 */
export function csvCell(value: string | null | undefined): string {
  if (value === undefined || value === null) return ''
  let text = String(value)
  // 禁止出现内部 id / 完整哈希：即便上游误传，也在出口兜底剔除。
  text = scrubInternal(text)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** 出口兜底：内部 UUID / 64 位十六进制哈希不允许进入导出文本。 */
function scrubInternal(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[内部编号]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[内部编号]')
    .replace(/证据/g, '依据')
}

/** 联系方式只给掩码（复用候选判重的同一份脱敏函数，不维护第二套规则）。 */
export function maskedContact(phone: string | null, email: string | null): {
  readonly phone: string | null
  readonly email: string | null
} {
  return { phone: maskPhone(phone), email: maskEmail(email) }
}

/** 把人话行渲染成一行 CSV。 */
export function csvRow(row: CsvApplicationRow): string {
  return [
    row.candidate_name,
    row.phone,
    row.email,
    row.job_title,
    row.stage,
    row.screening_conclusion,
    row.scorecard_progress,
    row.final_decision,
    row.updated_at,
  ].map(csvCell).join(',')
}

/**
 * 构造完整 CSV（UTF-8 BOM + 表头 + 每行 CRLF 结束）。
 * 表头/单元格全部经过同一份转义与兜底。
 */
export function buildApplicationsCsv(rows: readonly CsvApplicationRow[]): string {
  const lines = [CSV_HEADERS.map((h) => csvCell(h)).join(','), ...rows.map(csvRow)]
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
