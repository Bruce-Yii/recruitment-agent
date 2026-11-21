// 邮件连接器契约层（rec/31 §4.1/§4.2）。
//
// 职责边界：只定义「传输层与编排层之间」的数据形状、错误分类与配置解析。
//   * 不写库、不连网络、不解析正文/附件 —— 那些分别在 transport / parse / orchestrator。
//   * 配置 fail-closed：缺任何必填项（host/user/password_env/port/tls/folder）就
//     resolved=null + issues；不猜默认值（与 src/db/pool.ts、src/tools/converter.ts 同口径）。
//   * 口令只从 env[password_env] 读，配置里只有变量名；password 不序列化、不打印、不进 issues。
//   * 结果对象里只有脱敏摘要：正文/PII/完整附件内容永不出现在会被渲染的字段里。

/** 收件箱传输层错误分类（工具 B 映射到 RecruitmentToolError）。 */
export type MailKind = 'AUTH_REQUIRED' | 'NOT_CONNECTED' | 'INVALID_MESSAGE'

/** 发信传输层错误分类（工具 C 的 pump 用）。 */
export type SmtpKind = 'AUTH_REQUIRED' | 'NOT_CONNECTED' | 'TRANSIENT' | 'PERMANENT'

/**
 * 邮件传输层失败。`kind` 是稳定的、供上层映射错误码的分类：
 *   * `AUTH_REQUIRED` —— 认证/授权码失败（可修凭据）；
 *   * `NOT_CONNECTED` —— 网络/超时/连接断开（不可修凭据）；
 *   * `INVALID_MESSAGE` —— 消息形态非法（解析/uid/附件坏掉）。
 * `message` 里只放分类与可复核的原因码，**绝不含口令/正文**。
 */
export class MailTransportError extends Error {
  readonly kind: MailKind | SmtpKind
  /** 可选原因码（provider 错误码 / 阶段名），不含凭据与正文。 */
  readonly reason?: string

  constructor(kind: MailKind | SmtpKind, reason?: string) {
    super(reason === undefined ? `mail transport error: ${kind}` : `mail transport error: ${kind}: ${reason}`)
    this.name = 'MailTransportError'
    this.kind = kind
    if (reason !== undefined) this.reason = reason
  }
}

/** 摘要截断上限（字符数）：主题/发件人/正文摘要都不会超过它。 */
export const MAIL_SUMMARY_MAX_CHARS = 200

/** 把任意文本变成可安全渲染的单行摘要（不保留换行/控制符）。 */
export function mailSummary(value: unknown, maxChars: number = MAIL_SUMMARY_MAX_CHARS): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]+/g, '').trim().slice(0, Math.max(0, maxChars))
}

/** 一封待处理邮件的信封（只含摘要，不含正文/附件）。 */
export interface MailEnvelope {
  readonly uid: number
  /** 全局 message-id（原始值，作为 event_inbox.provider_event_id 幂等键）。 */
  readonly message_id: string
  /** 主题摘要（≤200 字符）。 */
  readonly subject: string
  /** 发件人摘要（≤200 字符，邮箱只保留地址，不打印显示名里的 PII）。 */
  readonly from: string
  /** 邮件时间的 ISO 字符串；不可得时为空串。 */
  readonly date: string
}

/** 一个原始附件（只在内存里存在，落盘算完 sha 后即丢弃 content）。 */
export interface RawMailAttachment {
  readonly filename: string
  readonly contentType: string
  readonly content: Buffer
}

/**
 * 一封已下载的原始邮件（headers/text 均为摘要，content 只在附件里）。
 * `raw` 是内部字段：transport 下载的 RFC822 原始字节，仅供 parse.ts 用 simpleParser
 * 解析；编排层/渲染层**永不**读取或输出它。
 */
export interface RawMailMessage {
  readonly uid: number
  readonly message_id: string
  /** 头部白名单摘要（message-id/from/to/date/subject），值均为单行截断文本。 */
  readonly headers: Readonly<Record<string, string>>
  readonly attachments: readonly RawMailAttachment[]
  /** 正文摘要（≤200 字符），正文全文不进结果对象。 */
  readonly text: string
  /** 内部：原始 RFC822 字节。只有 parse.ts 使用；不会进入任何渲染结果。 */
  readonly raw?: Buffer
}

/** `listNew` 的入参（业务语义；不含口令/服务器地址）。 */
export interface ListNewInput {
  /** UID 水位：只返回 uid > since_uid 的邮件。 */
  readonly since_uid?: number
  /** 时间窗（天）：无水位时用 IMAP 原生 SINCE 搜索，禁止全量扫描。 */
  readonly since_days?: number
  /** 最多返回多少封（默认 20，硬上限 50）。 */
  readonly limit?: number
}

/** 可替换的收件传输层（测试用假实现直接实现此接口）。 */
export interface MailTransport {
  connect(): Promise<void>
  /**
   * 返回**窗口内最新的** limit 封（按 UID 降序 newer-first），最多 limit 封。
   *
   * 真缺陷复盘（2026-11-18）：旧实现无水位时 `search({all:true})` 后按 UID **升序**
   * 取前 N 条 → 拿到的是最老的 N 封，全部早于 since_days 窗口被编排层丢掉 →
   * 1073 封邮箱 `total=0`，永远拉不到新邮件。现在无水位时用 IMAP 原生
   * `SINCE DD-Mon-YYYY`，结果降序取最新；有水位时 `uid:n+1:*` 同样降序。
   */
  listNew(input: ListNewInput): Promise<readonly MailEnvelope[]>
  fetchMessage(uid: number): Promise<RawMailMessage>
  disconnect(): Promise<void>
}

/**
 * 配置面（来自 cordis.patch.yml 的 mail 段）。
 * 口令只以 `password_env`（环境变量名）形式出现；不提供 password 字面量字段。
 */
export interface MailConfigInput {
  readonly host?: string
  readonly port?: number
  readonly user?: string
  /** 存放口令的环境变量名（默认 RECRUITMENT_MAIL_PASSWORD）。 */
  readonly password_env?: string
  /** 是否使用 TLS（imapflow tls: true；SMTP 465 亦然）。必填，不猜。 */
  readonly tls?: boolean
  /** 收件文件夹（如 INBOX）。必填，不猜。 */
  readonly folder?: string
  /** 可选的额外可读根目录（附件落地子目录总会加入）。 */
  readonly allowed_roots?: readonly string[]
  /**
   * 首次拉取只取最近 N 天的邮件（默认 7，这是唯一允许的默认值）。
   * 防止首次接入全量扫描整箱（rec/31 §5 风险 1 + 总控第四轮补强）。
   * 也可写 `${ENV}` 变量名由 resolveMailConfig 展开。
   */
  readonly since_days?: number | string
  /** 起始 UID 水位（可选；优先于 since_days）。 */
  readonly since_uid?: number
}

/** 已解析并校验通过的邮件配置。password 只在内存里，来自 env，绝不序列化。 */
export interface MailConfig {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password_env: string
  readonly tls: boolean
  readonly folder: string
  readonly allowed_roots: readonly string[]
  /** 口令明文：仅内存，来自 env[password_env]，传给 transport/smtp 建连。 */
  readonly password: string
  /** 首次拉取的时间窗（天）；默认 7，唯一允许的默认值。 */
  readonly since_days: number
  /** 起始 UID 水位；未配置时为 0。 */
  readonly since_uid: number
}

export const MAIL_DEFAULT_PASSWORD_ENV = 'RECRUITMENT_MAIL_PASSWORD'
/** 首次拉取默认时间窗（天）：总控第四轮补强，唯一允许的默认值。 */
export const MAIL_DEFAULT_SINCE_DAYS = 7

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 环境变量表（与 process.env 同形）。 */
export type MailEnvMap = Readonly<Record<string, string | undefined>>

/**
 * 校验并解析 mail 配置。fail-closed：任何必填项缺失/非法 ⇒ resolved=null + issues；
 * 不猜默认值、不写口令进 issues，也不接受配置里出现口令字面量。
 */
export function resolveMailConfig(
  config: MailConfigInput,
  env: MailEnvMap,
): { resolved: MailConfig | null; issues: readonly string[] } {
  const issues: string[] = []
  const host = nonEmpty(config.host)
  const user = nonEmpty(config.user)
  const passwordEnv = nonEmpty(config.password_env) === ''
    ? MAIL_DEFAULT_PASSWORD_ENV
    : nonEmpty(config.password_env)
  const folder = nonEmpty(config.folder)
  const tls = config.tls

  if (host === '') issues.push('config.mail.host is required')
  if (user === '') issues.push('config.mail.user is required')
  if (folder === '') issues.push('config.mail.folder is required')
  if (typeof tls !== 'boolean') issues.push('config.mail.tls is required (true or false)')

  const port = config.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push('config.mail.port must be an integer in 1..65535')
  }

  const password = env[passwordEnv]
  if (typeof password !== 'string' || password === '') {
    issues.push(`environment variable ${passwordEnv} is not set (the mail password is only read from the environment)`)
  }

  // since_days 唯一允许默认值 7；支持 ${ENV} 引用（与 converter 的白名单展开同形，单遍）。
  let sinceDays = MAIL_DEFAULT_SINCE_DAYS
  if (typeof config.since_days === 'number') {
    if (Number.isFinite(config.since_days) && config.since_days > 0) sinceDays = Math.floor(config.since_days)
    else issues.push('config.mail.since_days must be a positive number')
  } else if (typeof config.since_days === 'string' && config.since_days.trim() !== '') {
    const raw = config.since_days.trim()
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw)
    const value = match === null ? raw : env[match[1]!]
    if (value === undefined || value.trim() === '') {
      issues.push(`config.mail.since_days references undefined environment variable ${match?.[1] ?? raw}`)
    } else {
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) issues.push('config.mail.since_days must be a positive number')
      else sinceDays = Math.floor(parsed)
    }
  }
  const sinceUid = typeof config.since_uid === 'number' && Number.isFinite(config.since_uid) && config.since_uid >= 0
    ? Math.floor(config.since_uid)
    : 0

  if (issues.length > 0) return { resolved: null, issues }
  return {
    resolved: {
      host,
      port: port as number,
      user,
      password_env: passwordEnv,
      tls: tls as boolean,
      folder,
      allowed_roots: (config.allowed_roots ?? []).filter((root) => typeof root === 'string' && root.trim() !== ''),
      password: password as string,
      since_days: sinceDays,
      since_uid: sinceUid,
    },
    issues: [],
  }
}
