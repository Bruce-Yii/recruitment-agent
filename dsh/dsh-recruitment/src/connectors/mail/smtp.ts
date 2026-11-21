// SMTP 发信传输层（rec/31 §4.2）：nodemailer 实现。
//
// 错误分类（工具 C 的 pump 用）：
//   * AUTH_REQUIRED —— 认证失败（授权码可修）；
//   * TRANSIENT    —— 超时/连接断开/4xx（可重试）；
//   * PERMANENT    —— 5xx 拒收（不可重试，终态）；
//   * NOT_CONNECTED —— 连不上主机（无响应）。
//
// R7 口令纪律：口令只从 env[password_env] 读（由 resolveMailConfig 解析），
// 不进配置字面量、不进日志、不进错误 message。错误信息如含口令/长 blob，
// 一律经 redactSmtpDiagnostic 打码（复用 feishu/sanitizeDiagnostic 的风格：
// 截断 + 抹掉长 blob + 抹掉常见口令键的值）。

import { MailTransportError, mailSummary } from './contract.ts'
import type { MailConfig as MailConfigBase, SmtpKind } from './contract.ts'

// 导出 MailConfig 类型别名，方便 C 从 smtp.ts 直接 import（也可从 index.ts）。
export type MailConfig = MailConfigBase

/** 发信入参（body 是摘要，不落全文）。 */
export interface SmtpSendInput {
  readonly to: string
  readonly subject: string
  /** 正文摘要（≤500 字符），不传全文。 */
  readonly body_summary: string
  /** 可选自定义头（白名单键；不接受 from/口令相关键）。 */
  readonly headers?: Readonly<Record<string, string>>
}

/** 发信结果。 */
export interface SmtpSendResult {
  readonly messageId: string
  readonly accepted: readonly string[]
  readonly rejected: readonly string[]
  readonly response: string
}

/**
 * 发信配置：与 IMAP 共用账号/口令，但端口/TLS/主机**必须走 SMTP 自己的值**。
 * 真机事实：QQ IMAP=993+implicit TLS，而 SMTP=587+STARTTLS（或 465+implicit TLS）；
 * 若误用 IMAP 的 993/tls，nodemailer 会在 993 上做 implicit TLS SMTP → 连接失败。
 * 因此显式声明 smtp_* 字段；旧调用方只给 host/port/tls 时按历史口径回退。
 */
export interface SmtpConfig extends MailConfigBase {
  readonly smtp_host?: string
  readonly smtp_port?: number
  readonly smtp_tls?: boolean
}

/** 可替换的发信传输层（测试用假实现）。 */
export interface SmtpTransport {
  send(mail: SmtpSendInput): Promise<SmtpSendResult>
  close(): Promise<void>
}

/** 常见口令键：值整段打码（沿用 feishu sanitizeDiagnostic 的风格）。 */
const SECRET_KEY = /"(pass|password|passcode|auth|token|secret|authorization|授权码)"\s*:\s*("(?:[^"\\]|\\.)*"|\[[\s\S]*?\]|\{[\s\S]*?\})/gi
/** key=value 形态的口令（nodemailer 错误信息偶尔用这种形式）。 */
const SECRET_KV = /\b(pass(word)?|passcode|auth|token|secret|authorization|授权码)\s*[=:]\s*("?)[^\s"',;]{3,}\3/gi
/** 长 token / base64 / 长 blob：抹掉（R7）。 */
const LONG_BLOB = /[A-Za-z0-9+/=_.-]{64,}/g
/** 连续中文 ≥8：抹掉（正文形态）。 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]{8,}/g

/** 把 provider 诊断文本打码 + 截断（只留 ≤300 字节，避免正文/PII/口令外泄）。 */
export function redactSmtpDiagnostic(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return ''
  const head = text.slice(0, 300)
  return head
    .replace(SECRET_KEY, (_m, key: string) => `"${key}":"<redacted>"`)
    .replace(SECRET_KV, (_m, key: string) => `${key}=<redacted>`)
    .replace(CJK_RUN, '[redacted:cjk]')
    .replace(LONG_BLOB, '[redacted:blob]')
}

/** nodemailer 错误 → 传输层分类（不暴露口令）。 */
export function classifySmtpError(error: unknown): MailTransportError {
  if (error instanceof MailTransportError) return error
  const raw = error instanceof Error ? error.message : String(error)
  const code = String((error as { code?: unknown } | null)?.code ?? '').toUpperCase()
  const authPattern = /AUTHENTICAT|AUTHORIZATION|INVALID_LOGIN|INVALID_CREDENTIALS|535|认证|授权码|PASS/i
  if (authPattern.test(raw) || authPattern.test(code)) {
    return new MailTransportError('AUTH_REQUIRED', redactSmtpDiagnostic(code || 'AUTH_FAILED'))
  }
  // 5xx 拒收 → PERMANENT（含 550/551/552/553、SMTP 5.1.1 等）。
  if (/^5\d\d/.test(code) || /\b5\d\d\b/.test(raw) || /PERMANENT|REJECTED|MAILBOX NOT FOUND/i.test(raw)) {
    return new MailTransportError('PERMANENT', redactSmtpDiagnostic(code || 'PERMANENT_REJECT'))
  }
  // 4xx / 超时 / 连接断开 → TRANSIENT。
  if (/^4\d\d/.test(code) || /\b4\d\d\b/.test(raw)
    || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|TIMEOUT|CONNECTION CLOSED|GREETING|TRY AGAIN/i.test(raw)) {
    return new MailTransportError('TRANSIENT', redactSmtpDiagnostic(code || 'TRANSIENT'))
  }
  return new MailTransportError('NOT_CONNECTED', redactSmtpDiagnostic(code || 'SMTP_ERROR'))
}

/** nodemailer 运行时类型（动态加载，兼容包未安装）。 */
interface NodemailerLike {
  createTransport(options: Record<string, unknown>): {
    sendMail(mail: Record<string, unknown>): Promise<Record<string, unknown>>
    close(): void
  }
}

let nodemailer: NodemailerLike | null = null
async function loadNodemailer(): Promise<NodemailerLike> {
  if (nodemailer !== null) return nodemailer
  // nodemailer 的类型由宿主 package.json 提供；未安装时编译期放宽，运行时动态加载。
  // @ts-ignore - optional dependency; loaded lazily at send() time
  const module = await import('nodemailer') as Record<string, unknown>
  const factory = module.createTransport ?? (module.default as Record<string, unknown> | undefined)?.createTransport
  if (typeof factory !== 'function') throw new MailTransportError('NOT_CONNECTED', 'NODEMAILER_UNAVAILABLE')
  nodemailer = { createTransport: factory as NodemailerLike['createTransport'] }
  return nodemailer
}

/** 造一个 SMTP 发信传输层。send() 之前不发网络请求。 */
/**
 * 纯函数：由配置算出 nodemailer 的 createTransport 选项（可直接单测，不加载 nodemailer）。
 * SMTP 端口/TLS/主机优先用 smtp_*；没有才回退 IMAP 值（旧测试/旧调用兼容）。
 */
export function smtpTransportOptions(config: SmtpConfig): Record<string, unknown> {
  const host = typeof config.smtp_host === 'string' && config.smtp_host.trim() !== '' ? config.smtp_host : config.host
  const port = typeof config.smtp_port === 'number' && Number.isFinite(config.smtp_port) ? config.smtp_port : config.port
  const secure = typeof config.smtp_tls === 'boolean' ? config.smtp_tls : config.tls
  return {
    host,
    port,
    secure,
    // 587 + secure:false 时强制 STARTTLS；服务端不提供 TLS 就直接失败，绝不降级明文发信。
    requireTLS: !secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  }
}

export function createSmtpTransport(config: SmtpConfig): SmtpTransport {
  let transporter: ReturnType<NodemailerLike['createTransport']> | null = null
  async function ensure(): Promise<ReturnType<NodemailerLike['createTransport']>> {
    if (transporter !== null) return transporter
    const lib = await loadNodemailer()
    transporter = lib.createTransport(smtpTransportOptions(config))
    return transporter
  }

  return {
    async send(mail: SmtpSendInput): Promise<SmtpSendResult> {
      let active: ReturnType<NodemailerLike['createTransport']>
      try {
        active = await ensure()
      } catch (error) {
        throw classifySmtpError(error)
      }
      let info: Record<string, unknown>
      try {
        info = await active.sendMail({
          from: config.user,
          to: mail.to,
          subject: mailSummary(mail.subject),
          text: mailSummary(mail.body_summary, 500),
          ...(mail.headers === undefined ? {} : { headers: mail.headers }),
        })
      } catch (error) {
        throw classifySmtpError(error)
      }
      const accepted = Array.isArray(info.accepted)
        ? info.accepted.map((entry) => String(typeof entry === 'object' && entry !== null ? ((entry as { address?: unknown }).address ?? '') : entry))
        : []
      const rejected = Array.isArray(info.rejected)
        ? info.rejected.map((entry) => String(typeof entry === 'object' && entry !== null ? ((entry as { address?: unknown }).address ?? '') : entry))
        : []
      return {
        messageId: String(info.messageId ?? ''),
        accepted,
        rejected,
        response: mailSummary(info.response ?? ''),
      }
    },
    async close(): Promise<void> {
      if (transporter === null) return
      const current = transporter
      transporter = null
      current.close()
    },
  }
}

/** 类型守卫：错误是否属于 SMTP 的临时/永久分类（供 pump 用）。 */
export function isSmtpKind(kind: SmtpKind, error: unknown): boolean {
  return error instanceof MailTransportError && error.kind === kind
}
