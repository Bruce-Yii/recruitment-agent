// recruitment_email_fetch —— 邮箱收件最小链接入（Agent 可触发，工具数 30 → 31；逐条标准人工纠偏再加一 = 32）。
//
// 职责边界（与 src/connectors/mail/** 的分工）：
//   * 连接器（子代理 A）负责：IMAP 传输 + UID 水位 + 去重 + 附件转换 + intake 写库，
//     并把三维标签里的 `connection` 原样返回（CONNECTED / NOT_CONNECTED / AUTH_REQUIRED）。
//   * 本文件**只**做四件事：封闭入参契约、错误码映射、fail-closed 替身、render 投影。
//     不连 IMAP、不连 PG、不解析邮件、不接触 candidate PII。
//
// 安全口径（D-138 O1 / R4 / R7）：
//   1. 入参只有业务语义 `job_id`（UUID）/ `limit` / `since_uid`；host/user/password/folder/
//      tenant/actor 一律不接受（parseContractArgs 的 additionalProperties:false + 显式检查）。
//   2. 人读正文只放短号 / 附件名 / 前 8 位 hash 前缀 / 业务短号 / action；完整 UUID、
//      64 位 hash、邮件正文、PII 不进人读正文；job_id 的完整值只在 machine arguments 区。
//   3. 认证失败 → AUTH_REQUIRED（零写入）；网络失败 → NOT_CONNECTED（零写入）；
//      配置缺项 → NOT_CONFIGURED（仍注册同一工具名的替身）。失败时连接态照实渲染。
//   4. 成功时三维标签 LIVE / EVENT / CONNECTED（A 原样给出）；失败时 connection 取 A 的真实值。
//
// 与 A 的接口采用**结构化窄类型**（不 import type A 的文件）：A 并发落盘，结构化类型天然兼容，
// 测试注入假 transport / 假 fetch 时不依赖任何真实网络或 DB。

import { parseContractArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import { contractError } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import type { RecruitmentErrorCode } from './errors.ts'
import { MACHINE_ARGS_HEADER, machineArgumentLines, shortHash, shortRef } from './render-ref.ts'
import type { ResolvedDatabaseConfig } from '../db/pool.ts'
import type { ResolvedConverterConfig } from './converter.ts'
import type { ToolActorDeps } from '../demo-actor/tool-actor.ts'

/** 工具名（注册面唯一）。 */
export const EMAIL_FETCH_TOOL = 'recruitment_email_fetch'

/** 插件配置 `mail` 段（与 A 的 MailConfig 输入形状兼容）。口令只从 env 读。 */
export interface MailConnectorConfig {
  readonly host?: string
  readonly user?: string
  readonly password_env?: string
  readonly port?: number
  readonly tls?: boolean
  readonly folder?: string
  /** SMTP 发信端口（同一账号；发信走 Host Action，不新增工具）。 */
  readonly smtp_port?: number
  readonly smtp_tls?: boolean
  /** SMTP 主机，缺省等于 host。 */
  readonly smtp_host?: string
  /** 首次扫描只回看过去 N 天（默认 7，禁止全量扫历史）；可写 `${ENV}` 引用。 */
  readonly since_days?: number | string
  /** 可选 UID 水位（覆盖 since_days）。 */
  readonly since_uid?: number
}

/** 已解析的 mail 配置（password 只在内存里用于建连，不序列化、不进日志/render）。 */
export interface ResolvedMailConfig {
  readonly host: string
  readonly user: string
  readonly password_env: string
  readonly password: string
  readonly port: number
  readonly tls: boolean
  readonly folder: string
  readonly smtp_port: number
  readonly smtp_tls: boolean
  readonly smtp_host: string
  /** 首次拉取时间窗（天），默认 7；A 的编排层读它防止全量扫描。 */
  readonly since_days: number
  /** 起始 UID 水位（默认 0）。 */
  readonly since_uid: number
  /** 额外可读根目录（与 A 的 MailConfig 同形）。 */
  readonly allowed_roots: readonly string[]
}

/** `${NAME}` 环境变量引用；单遍展开，不递归。 */
const ENV_REFERENCE_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 展开字符串里的 `${NAME}`。**未展开 / 未设置 / 空白**都让该字段视为缺失（fail-closed）。
 * bundle patch 的普通字符串**不做** `${ENV}` 插值（cordis.patch.yml 注释确认），
 * 所以我们必须自己展开；`${...}` 残留不能当真实 host/user 用。
 */
export function expandMailEnv(value: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
  if (typeof value !== 'string') return ''
  return value.replace(ENV_REFERENCE_RE, (_match, name: string) => {
    const resolved = env[name]
    return typeof resolved === 'string' && resolved.trim() !== '' ? resolved : ''
  })
}

/**
 * 解析 mail 配置。缺任何必填项 → `{resolved:null, issues[]}`（注册替身、调用报 NOT_CONFIGURED）。
 * `${ENV}` 未展开（env 无值 / 展开后仍含 `${`）按缺失处理，绝不把字面 `${X}` 当 host。
 */
export function resolveMailConfig(
  config: MailConnectorConfig,
  env: Readonly<Record<string, string | undefined>>,
): { resolved: ResolvedMailConfig | null; issues: readonly string[] } {
  const issues: string[] = []
  const host = expandMailEnv(config.host, env).trim()
  const user = expandMailEnv(config.user, env).trim()
  const folder = config.folder === undefined ? 'INBOX' : expandMailEnv(config.folder, env).trim()
  const passwordEnv = typeof config.password_env === 'string' ? config.password_env.trim() : ''
  // 任务书：password_env 也是必填项之一——显式缺省/空值一律 fail-closed，不猜默认变量名。
  if (passwordEnv === '') issues.push('config.mail.password_env is required (the variable name of the password)')
  // port/tls/folder 必填：不猜默认（A 的 resolveMailConfig 同口径；任务书明确缺项 → NOT_CONFIGURED）。
  const port = config.port
  const tls = config.tls
  const smtpPort = config.smtp_port
  const smtpTls = config.smtp_tls
  const smtpHost = expandMailEnv(config.smtp_host ?? config.host, env).trim()

  if (host === '' || host.includes('${')) issues.push('config.mail.host is required (unexpanded ${ENV} counts as missing)')
  if (user === '' || user.includes('${')) issues.push('config.mail.user is required (unexpanded ${ENV} counts as missing)')
  if (folder === '' || folder.includes('${')) issues.push('config.mail.folder is required (unexpanded ${ENV} counts as missing)')
  if (smtpHost === '' || smtpHost.includes('${')) issues.push('config.mail.smtp_host is required (unexpanded ${ENV} counts as missing)')
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push('config.mail.port must be an integer in 1..65535')
  }
  if (typeof smtpPort !== 'number' || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) {
    issues.push('config.mail.smtp_port must be an integer in 1..65535')
  }
  if (typeof tls !== 'boolean') issues.push('config.mail.tls is required (true or false)')
  if (typeof smtpTls !== 'boolean') issues.push('config.mail.smtp_tls is required (true or false)')
  const password = env[passwordEnv]
  if (typeof password !== 'string' || password === '' || password.includes('${')) {
    issues.push(`environment variable ${passwordEnv} is not set (the mail password is only read from the environment)`)
  }
  // since_days：唯一允许的默认值 7（与 A 的 MAIL_DEFAULT_SINCE_DAYS 一致）。
  let sinceDays = 7
  if (typeof config.since_days === 'number') {
    if (Number.isFinite(config.since_days) && config.since_days > 0) sinceDays = Math.floor(config.since_days)
    else issues.push('config.mail.since_days must be a positive number')
  } else if (typeof config.since_days === 'string' && config.since_days.trim() !== '') {
    const raw = config.since_days.trim()
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw)
    const value = match === null ? raw : env[match[1] as string]
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
      host, user, password_env: passwordEnv, password: password as string,
      port: port ?? 993, tls: tls ?? true, folder,
      smtp_port: smtpPort ?? 587, smtp_tls: smtpTls ?? false, smtp_host: smtpHost,
      since_days: sinceDays, since_uid: sinceUid,
      allowed_roots: [],
    },
    issues: [],
  }
}

// 认证失败统一用 `RecruitmentToolError('AUTH_REQUIRED', detail)`（共享闭集见
// src/tools/errors.ts）。AUTH_REQUIRED = 配了但凭据/授权码不对；NOT_CONFIGURED = 没配。
// 不用 contractError：其 ContractErrorCode 是另一份封闭集，不含 AUTH_REQUIRED。
// RecruitmentToolError 的 constructor 自动加 `${code}: ` 前缀，message 前缀保持不变。

/** 三维连接态闭集（与 A 的 `EmailFetchResult.connection` 同形）。 */
export type EmailFetchConnection = 'CONNECTED' | 'NOT_CONNECTED' | 'AUTH_REQUIRED'

/** A 的 `MailTransportError.kind` 的窄投影。 */
export type MailTransportErrorKind = 'AUTH_REQUIRED' | 'NOT_CONNECTED' | 'INVALID_MESSAGE'

/** 判定一个异常是不是 A 的传输层错误（按 `kind` 闭集，不依赖 A 的类实例）。 */
export function isMailTransportErrorLike(value: unknown): value is { kind: MailTransportErrorKind; message?: string } {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'AUTH_REQUIRED' || kind === 'NOT_CONNECTED' || kind === 'INVALID_MESSAGE'
}

/**
 * 入参声明。**只有三个业务语义字段**；`additionalProperties:false` + 显式校验拒绝
 * host/user/password/folder/tenant/actor。
 */
const PARAMS: ParamMap = {
  job_id: {
    kind: 'string',
    required: true,
    uuid: true,
    description: '招聘任务的 UUID。intake 写库要用它；只能用业务标识，不接受 tenant/actor。',
  },
  limit: {
    kind: 'integer',
    min: 1,
    max: 50,
    description: '本轮最多处理几封新邮件（1..50，默认 20）。',
  },
  since_uid: {
    kind: 'integer',
    min: 1,
    description: 'UID 水位：只处理 UID 大于此值的邮件（最小 1；不传表示从上次水位继续）。',
  },
}
const PARAMETER_SCHEMA = toParameterSchema(PARAMS)

/** A 的 `EmailFetchResultItem` 的本工具消费面（不含正文 / PII，A 已脱敏到短号/前缀）。 */
export interface EmailFetchItemView {
  readonly message_id: string
  readonly subject?: string
  readonly status: string
  readonly kind?: string
  readonly reason?: string
  readonly attachments: readonly {
    readonly filename: string
    readonly sha256_prefix: string
    readonly mime_type?: string
    readonly bytes?: number
    readonly outcome?: string
    readonly reason?: string
  }[]
  readonly application?: { readonly id_suffix: string; readonly action: string }
  readonly resume_version?: { readonly id_suffix: string; readonly no: number; readonly action: string }
  readonly labels?: { readonly provenance: string; readonly trigger: string; readonly connection: string }
}

/** A 的 `EmailFetchResult` 的本工具消费面。 */
export interface EmailFetchResultView {
  readonly total: number
  readonly ingested: number
  readonly duplicates: number
  readonly skipped: number
  readonly failed: number
  readonly connection: EmailFetchConnection
  readonly results: readonly EmailFetchItemView[]
}

/** A 的 `fetchAndIngest(input, deps)` 的可注入签名（测试注入假实现）。 */
export type FetchAndIngestLike = (
  input: { job_id: string; limit?: number; since_uid?: number },
  deps: {
    transport: unknown
    cfg: { database: ResolvedDatabaseConfig; converter: ResolvedConverterConfig; mail: ResolvedMailConfig }
    identity?: ToolActorDeps
    exec?: unknown
  },
) => Promise<EmailFetchResultView>

/** 工具构造依赖（生产由 apply 传入 A 的真实 transport/fetch；测试传假实现）。 */
export interface EmailFetchToolDeps {
  readonly fetch: FetchAndIngestLike
  readonly transport: unknown
  readonly database: ResolvedDatabaseConfig
  readonly converter: ResolvedConverterConfig
  readonly mail: ResolvedMailConfig
  readonly identity?: ToolActorDeps
}

/** 输出 schema：只声明业务标识与计量；不含正文 / PII / 完整 UUID / 64 位 hash。 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    job_id: { type: 'string' },
    total: { type: 'integer' },
    ingested: { type: 'integer' },
    duplicates: { type: 'integer' },
    skipped: { type: 'integer' },
    failed: { type: 'integer' },
    connection: { type: 'string', enum: ['CONNECTED', 'NOT_CONNECTED', 'AUTH_REQUIRED'] },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['EVENT', 'MANUAL'] },
        connection: { type: 'string', enum: ['CONNECTED', 'NOT_CONNECTED', 'AUTH_REQUIRED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          status: { type: 'string' },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filename: { type: 'string' },
                sha256_prefix: { type: 'string' },
                outcome: { type: 'string' },
              },
              required: ['filename', 'sha256_prefix'],
              additionalProperties: false,
            },
          },
          application: {
            type: 'object',
            properties: { id_suffix: { type: 'string' }, action: { type: 'string' } },
            required: ['id_suffix', 'action'],
            additionalProperties: false,
          },
          resume_version: {
            type: 'object',
            properties: { id_suffix: { type: 'string' }, no: { type: 'integer' }, action: { type: 'string' } },
            required: ['id_suffix', 'no', 'action'],
            additionalProperties: false,
          },
        },
        required: ['message_id', 'status', 'attachments'],
        additionalProperties: false,
      },
    },
  },
  required: ['tool', 'job_id', 'total', 'ingested', 'duplicates', 'skipped', 'failed', 'connection', 'labels', 'results'],
  additionalProperties: false,
}

/** 配置缺项时注册的同名替身：schema 不漂移，调用即 NOT_CONFIGURED，零写入。 */
export function unconfiguredEmailFetchTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: EMAIL_FETCH_TOOL,
    description:
      'Fetch recent inbox mail for one job and ingest new resumes. '
      + `Currently NOT CONFIGURED: ${issues.join('; ')}. Calls return NOT_CONFIGURED.`,
    parameters: PARAMETER_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${EMAIL_FETCH_TOOL} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw contractError('NOT_CONFIGURED', {
        reason_code: 'MAIL_CONFIG_MISSING',
        message: `${EMAIL_FETCH_TOOL} is not configured: ${issues.join('; ')}`,
      })
    },
  }
}

/**
 * 错误码映射：AUTH_REQUIRED / NOT_CONNECTED / READER_FAILED（INVALID_MESSAGE 归后者）。
 * 非传输层异常统一 READER_FAILED（其它失败用既有闭集，不新造码）。
 */
export function mapFetchError(error: unknown): {
  code: RecruitmentErrorCode
  detail: string
  connection: EmailFetchConnection
} {
  const message = error instanceof Error ? error.message : String(error)
  if (isMailTransportErrorLike(error)) {
    if (error.kind === 'AUTH_REQUIRED') return { code: 'AUTH_REQUIRED', detail: message, connection: 'AUTH_REQUIRED' }
    if (error.kind === 'NOT_CONNECTED') return { code: 'NOT_CONNECTED', detail: message, connection: 'NOT_CONNECTED' }
    return { code: 'READER_FAILED', detail: message, connection: 'CONNECTED' }
  }
  return { code: 'READER_FAILED', detail: message, connection: 'NOT_CONNECTED' }
}

/**
 * 生产运行时 seam：A 的 `fetchAndIngest` / `createImapTransport` 由 `apply()` 装配后注入这里。
 * 测试直接给 `createEmailFetchTool` 传假实现，不经过这个单例。
 */
export const emailFetchRuntime: {
  fetch: FetchAndIngestLike | null
  createTransport: ((mail: ResolvedMailConfig) => unknown) | null
} = { fetch: null, createTransport: null }

/**
 * 用 A 的真实实现构造工具（生产入口）。
 * @throws RecruitmentToolError - A 的运行时尚未注入时 fail-closed（不返回假成功）。
 */
export function createWiredEmailFetchTool(input: {
  database: ResolvedDatabaseConfig
  converter: ResolvedConverterConfig
  mail: ResolvedMailConfig
  identity?: ToolActorDeps
}): ReadonlyToolDefinition {
  if (emailFetchRuntime.fetch === null || emailFetchRuntime.createTransport === null) {
    throw new RecruitmentToolError('NOT_CONFIGURED', 'mail transport/orchestration runtime is not wired')
  }
  return createEmailFetchTool({
    fetch: emailFetchRuntime.fetch,
    transport: emailFetchRuntime.createTransport(input.mail),
    database: input.database,
    converter: input.converter,
    mail: input.mail,
    ...(input.identity === undefined ? {} : { identity: input.identity }),
  })
}

/** 造真实工具。transport/fetch 由 apply 注入 A 的实现；测试注入假实现，不连真 IMAP/PG。 */
export function createEmailFetchTool(deps: EmailFetchToolDeps): ReadonlyToolDefinition {
  return {
    name: EMAIL_FETCH_TOOL,
    description:
      'Fetch recent inbox mail for ONE job and ingest new resumes (EVENT-driven, LIVE). '
      + 'Only business arguments are accepted: job_id, limit (1..50, default 20), since_uid (UID watermark, >= 1). '
      + 'You cannot pass host/user/password/folder/tenant/actor — those come from the plugin config. '
      + 'Duplicate message-ids and unchanged attachments are skipped; connection failures fail closed with '
      + 'zero writes (AUTH_REQUIRED / NOT_CONNECTED). Human-readable output shows short references only.',
    parameters: PARAMETER_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      // O1：人读正文只用短号 / 业务标识；完整 id 在末尾 machine arguments 区（header 带告诫）。
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as EmailFetchResultView & { job_id?: string }
        const lines: string[] = [
          `mail fetch: ${v.total} message(s) seen, ${v.ingested} ingested, `
            + `${v.duplicates} duplicate, ${v.skipped} skipped, ${v.failed} failed`,
        ]
        for (const item of v.results) {
          const files = item.attachments.length === 0
            ? 'none'
            : item.attachments
              // 防御：sha_prefix 即使上游给了完整 64hex 也必须截断（D-138 O1：render 不吐内部编号）。
              .map((a) => `${a.filename}[${shortHash(a.sha256_prefix)}${a.outcome === undefined ? '' : `/${a.outcome}`}]`)
              .join(', ')
          const bits = [`msg=${shortRef(item.message_id)}`, `files=${files}`]
          if (item.application !== undefined) {
            bits.push(`application=${shortRef(item.application.id_suffix)}/${item.application.action}`)
          }
          if (item.resume_version !== undefined) {
            const rv = item.resume_version
            bits.push(`resume_version=${shortRef(rv.id_suffix)}#${rv.no}/${rv.action}`)
          }
          bits.push(`action=${item.status}`)
          if (item.reason !== undefined) bits.push(`reason=${item.reason}`)
          if (item.kind !== undefined) bits.push(`kind=${item.kind}`)
          lines.push(`  ${bits.join(' ')}`)
        }
        lines.push(
          `  labels: ${v.results[0]?.labels?.provenance ?? 'LIVE'}/`
            + `${v.results[0]?.labels?.trigger ?? 'EVENT'}/${v.connection}`,
        )
        // 完整 job_id 只在 machine arguments 区（header 明确告诫不要给用户看）。
        lines.push(...machineArgumentLines(
          typeof v.job_id === 'string' && v.job_id !== '' ? [{ key: 'job_id', value: v.job_id }] : [],
        ))
        void MACHINE_ARGS_HEADER
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      // 写库工具：同一 job 的两次收件不能并行（UID 水位竞态）。
      return false
    },
    async execute(rawArgs: unknown, _exec: unknown): Promise<unknown> {
      const args = parseContractArgs(PARAMS, rawArgs)
      const jobId = args.job_id as string
      const limit = args.limit as number | undefined
      const sinceUid = args.since_uid as number | undefined
      let result: EmailFetchResultView
      try {
        result = await deps.fetch(
          { job_id: jobId, ...(limit === undefined ? {} : { limit }), ...(sinceUid === undefined ? {} : { since_uid: sinceUid }) },
          {
            transport: deps.transport,
            cfg: { database: deps.database, converter: deps.converter, mail: deps.mail },
            ...(deps.identity === undefined ? {} : { identity: deps.identity }),
          },
        )
      } catch (error) {
        // transport 抛错时映射成稳定错误码（连接态如实给，零写入由 A 保证）。
        const mapped = mapFetchError(error)
        if (mapped.code === 'AUTH_REQUIRED') {
          throw new RecruitmentToolError('AUTH_REQUIRED', mapped.detail)
        }
        throw contractError(mapped.code as 'NOT_CONNECTED' | 'READER_FAILED', {
          reason_code: mapped.code === 'NOT_CONNECTED' ? 'MAIL_CONNECTION_FAILED' : 'MAIL_FETCH_FAILED',
          message: `mail fetch failed (connection=${mapped.connection}): ${mapped.detail}`,
        })
      }
      // A 的编排层把 connect/list 失败作为**带连接态的零写入结果**返回（不抛异常）。
      // 工具层在 try 之外把它翻成稳定错误码，避免自己的异常被上面的 catch 二次映射。
      const connection: EmailFetchConnection = result.connection ?? 'CONNECTED'
      if (connection === 'AUTH_REQUIRED') {
        throw new RecruitmentToolError('AUTH_REQUIRED', 'mail authentication failed; zero writes')
      }
      if (connection === 'NOT_CONNECTED') {
        throw contractError('NOT_CONNECTED', {
          reason_code: 'MAIL_CONNECTION_FAILED',
          message: 'mail server is not connected; zero writes',
        })
      }
      return {
        tool: EMAIL_FETCH_TOOL,
        job_id: jobId,
        total: result.total,
        ingested: result.ingested,
        duplicates: result.duplicates,
        skipped: result.skipped,
        failed: result.failed,
        connection,
        labels: { provenance: 'LIVE', trigger: 'EVENT', connection },
        results: result.results.map((item) => ({
          message_id: item.message_id,
          ...(item.subject === undefined ? {} : { subject: item.subject }),
          status: item.status,
          // 取证面：每条结果都带人话 reason（SEEN_NO_ATTACHMENT / DUPLICATE_ASSET /
          // UNSUPPORTED_TYPE / AUTH_REQUIRED …），库外可判"为什么跳过/失败"，
          // 不进人读正文（render 另有口径），但结构化 value 里必须可查。
          ...(item.reason === undefined ? {} : { reason: item.reason }),
          ...(item.kind === undefined ? {} : { kind: item.kind }),
          attachments: item.attachments.map((a) => ({
            filename: a.filename,
            sha256_prefix: a.sha256_prefix,
            ...(a.outcome === undefined ? {} : { outcome: a.outcome }),
            ...(a.reason === undefined ? {} : { reason: a.reason }),
          })),
          ...(item.application === undefined ? {} : { application: item.application }),
          ...(item.resume_version === undefined ? {} : { resume_version: item.resume_version }),
          ...(item.labels === undefined ? {} : { labels: item.labels }),
        })),
      }
    },
  }
}
