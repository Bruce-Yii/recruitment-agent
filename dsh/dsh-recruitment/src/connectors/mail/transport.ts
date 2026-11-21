// IMAP 收件传输层（rec/31 §4.1）：imapflow 实现 MailTransport。
//
// 只做四件事：connect / listNew（按 UID 水位递增）/ fetchMessage（下载原始字节 + 附件 buffer）/ disconnect。
//
// 认证失败分类（真链第六跑后的 EM-5 口径）：QQ 只给 `Command failed`，没有 code/name，
// 靠消息匹配分不出"网络不通"与"凭据被拒"。判据（有依据，不瞎匹配）：
//   1. error.authenticationFailed === true（imapflow 部分版本有）→ AUTH_REQUIRED；
//   2. 错误明确匹配认证/网络特征 → 按既有 classifyImapError；
//   3. **模糊错误** → 纯 TCP 可达性探测（3s）：连得上 = 服务器在但凭据被拒 → AUTH_REQUIRED；
//      连不上/超时 = 网络不通 → NOT_CONNECTED。探测只建 TCP 连接，不登录、不读邮件、零写入。
// 不解析正文、不写库、不嗅探类型 —— 那些属于 parse.ts / orchestrator.ts。
//
// 依赖 `imapflow`（由调用方 package.json 注入；本文件不在依赖未安装时硬失败于模块加载，
// 而在 connect() 时才动态加载并分类错误）。
// 严格区分认证失败（AUTH_REQUIRED）与网络/超时（NOT_CONNECTED）：
//   * imapflow 错误 message/code 含 AUTHENTICATION/AUTHORIZATION/LOGIN/认证/授权码
//     ⇒ AUTH_REQUIRED（凭据可修）；
//   * 其余（ECONNREFUSED/ETIMEDOUT/ENOTFOUND/socket 关闭/超时）⇒ NOT_CONNECTED；
//   * 消息形态坏（uid 非法/原始字节缺失）⇒ INVALID_MESSAGE。
// 错误信息只带分类与 provider code，不带口令、不带正文。

import { connect as netConnect, type Socket } from 'node:net'

import {
  MailTransportError,
  mailSummary,
  type ListNewInput,
  type MailConfig,
  type MailEnvelope,
  type MailTransport,
  type RawMailMessage,
} from './contract.ts'

// imapflow 尚未安装为类型依赖：动态加载 + 运行时结构类型，避免包缺失时编译失败。
// 包由 B 加进 package.json 后此处无需改动；若将来要吃真实类型，替换局部接口即可。
interface ImapFlowLike {
  connect(): Promise<unknown>
  logout(): Promise<unknown>
  mailboxOpen(path: string, options?: Record<string, unknown>): Promise<unknown>
  search(criteria: Record<string, unknown>, options?: Record<string, unknown>): Promise<number[]>
  /** 第三参数 options 的 uid:true 决定首参按 UID 解释（imapflow 真实签名）。 */
  fetchOne(
    sequence: number,
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
}

let imapFlowCtor: (new (options: Record<string, unknown>) => ImapFlowLike) | null = null

/**
 * **仅测试用**：注入假 imapflow 构造器，避免动态 import 真包/真网络。
 * 产品路径永不调用；传 null 复位（让下一次 connect 重新动态加载真包）。
 */
export function __setImapFlowCtorForTest(
  ctor: (new (options: Record<string, unknown>) => ImapFlowLike) | null,
): void {
  imapFlowCtor = ctor
}

/** 供单测断言真实 envelope 投影；与 listNew/fetchMessage 同一实现（不复制口径）。 */
export function envelopeHeaders(source: unknown): Readonly<Record<string, string>> {
  return headerSummary(source)
}

async function loadImapFlow(): Promise<new (options: Record<string, unknown>) => ImapFlowLike> {
  if (imapFlowCtor !== null) return imapFlowCtor
  // imapflow 的类型由宿主 package.json 提供；未安装时编译期放宽，运行时动态加载。
  // @ts-ignore - optional dependency; loaded lazily at connect() time
  const module = await import('imapflow') as Record<string, unknown>
  const candidate = module.ImapFlow
  if (typeof candidate !== 'function') {
    throw new MailTransportError('NOT_CONNECTED', 'IMAPFLOW_CTOR_MISSING')
  }
  imapFlowCtor = candidate as new (options: Record<string, unknown>) => ImapFlowLike
  return imapFlowCtor
}

/** 默认单次 listNew 上限：总控第四轮补强，20（原 100 改为 20）。 */
export const MAIL_LIST_DEFAULT_LIMIT = 20
/** 硬上限：即使调用方给更大 limit，也不一次拉超过此值（总控第四轮补强，50）。 */
export const MAIL_LIST_HARD_LIMIT = 50

/**
 * QQ 邮箱 IMAP 要求客户端在登录前发 `ID` 命令，否则认证失败。
 * imapflow 通过 connect options 的 `clientInfo` 字段发送（name/version/vendor/contact）。
 * 这是 QQ 的硬性要求（总控第四轮补强），不是可选优化。
 */
const IMAP_CLIENT_INFO = {
  name: 'dsh-recruitment-mail',
  version: '1.0.0',
  vendor: 'recruitment-agent',
  contact: 'recruitment@example.invalid',
} as const

/** IMAP 搜索条件里 `SINCE` 的月份缩写（RFC 3501，固定英文，不受 locale 影响）。 */
const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * 把 `since_days` 换算成 IMAP 原生 SINCE 条件（'DD-Mon-YYYY'，服务端按日期过滤）。
 * 用 UTC 自然日计算（IMAP SINCE 只精确到日，时区差异由编排层的第二道时间窗兜底）。
 * @param sinceDays - 回看天数（<=0 视为 7 的默认由调用方处理，这里只做防御）
 * @param now - 当前时刻（测试注入）
 */
export function imapSinceDate(sinceDays: number, now: Date = new Date()): string {
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? Math.floor(sinceDays) : 7
  const date = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${dd}-${IMAP_MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`
}

/**
 * 纯函数：构造 IMAP search criteria。有 UID 水位 → `uid:n+1:*`（增量）；
 * 无水位 → `since:'DD-Mon-YYYY'`（**禁止 all**，否则先拿最老的 N 封 → total=0）。
 */
export function imapSearchCriteria(since: number, sinceDays: number, now: Date = new Date()): Record<string, unknown> {
  return since > 0 ? { uid: `${since + 1}:*` } : { since: imapSinceDate(sinceDays, now) }
}

/**
 * 纯函数：从 search 返回的 UID 里挑**最新的** limit 个（降序 newer-first）。
 * 去重、过滤 <= since 的水位、降序、截断。真缺陷复盘：旧实现升序取前 N = 最老的 N 封。
 */
export function selectNewestUids(uids: readonly number[], since: number, limit: number): number[] {
  return [...new Set(uids.filter((u) => typeof u === 'number' && Number.isFinite(u) && u > since))]
    .sort((a, b) => b - a)
    .slice(0, Math.max(0, limit))
}

/** imapflow 错误 → 传输层错误分类（不暴露口令/正文）。 */
export function classifyImapError(error: unknown): MailTransportError {
  if (error instanceof MailTransportError) return error
  const raw = error instanceof Error ? error.message : String(error)
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code.toUpperCase()
    : ''
  const authPattern = /AUTHENTICAT|AUTHORIZATION|LOGIN_FAILED|INVALID_CREDENTIALS|认证|授权码|BAD CREDENTIALS/i
  if (authPattern.test(raw) || authPattern.test(code)) {
    return new MailTransportError('AUTH_REQUIRED', code || 'AUTH_FAILED')
  }
  const netPattern = /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ESOCKET|CONNECTION|CLOSED|TIMEOUT|UNABLE TO CONNECT|SOCKET/i
  if (netPattern.test(raw) || netPattern.test(code)) {
    return new MailTransportError('NOT_CONNECTED', code || 'CONNECTION_FAILED')
  }
  // 其余 provider 错误按"连不上/不可用"处理：不猜成认证问题（授权码是否失效要由明确信号决定）。
  return new MailTransportError('NOT_CONNECTED', code || 'IMAP_ERROR')
}

/** TCP 可达性探测超时（ms）。只建连接，不登录、不读数据。 */
export const MAIL_TCP_PROBE_TIMEOUT_MS = 3_000

/** 可注入的 TCP 探测器（测试用假实现；产品走真实 net.connect）。 */
export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>

/** 真实 TCP 探测：连上（含 TLS 握手前的纯 TCP 建立）= true；拒绝/超时/任何错误 = false。 */
export const realTcpProbe: TcpProbe = (host, port, timeoutMs) => new Promise<boolean>((resolve) => {
  let settled = false
  const finish = (value: boolean): void => {
    if (settled) return
    settled = true
    resolve(value)
  }
  let socket: Socket
  try {
    socket = netConnect({ host, port })
  } catch {
    finish(false)
    return
  }
  socket.setTimeout(timeoutMs)
  socket.once('connect', () => { socket.destroy(); finish(true) })
  socket.once('timeout', () => { socket.destroy(); finish(false) })
  socket.once('error', () => { socket.destroy(); finish(false) })
})

/** 模块级可覆盖探测器（仅测试注入；传 null 复位为 realTcpProbe）。 */
let tcpProbeOverride: TcpProbe | null = null
export function __setTcpProbeForTest(probe: TcpProbe | null): void {
  tcpProbeOverride = probe
}

/**
 * 判据（EM-5）：错误是否"模糊"——QQ 真机只给 `Command failed`（无 code/name），
 * 既不匹配认证特征也不匹配网络特征。只有模糊错误才需要做 TCP 探测。
 */
export function isAmbiguousImapError(error: unknown): boolean {
  if (error instanceof MailTransportError) return false
  const raw = error instanceof Error ? error.message : String(error)
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code.toUpperCase()
    : ''
  // 任何明确特征都不是模糊错误（已交给 classifyImapError 处理）。
  if (/AUTHENTICAT|AUTHORIZATION|LOGIN_FAILED|INVALID_CREDENTIALS|认证|授权码|BAD CREDENTIALS/i.test(raw + code)) return false
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ESOCKET|CONNECTION|CLOSED|TIMEOUT|UNABLE TO CONNECT|SOCKET/i.test(raw + code)) return false
  return true
}

/**
 * 对 connect 失败做带 TCP 探测的分类（只在错误模糊时探测）：
 *   - authenticationFailed === true（部分 imapflow 版本有）→ AUTH_REQUIRED（最高优先）；
 *   - 错误明确 → classifyImapError；
 *   - 模糊 → TCP 可达=true ⇒ AUTH_REQUIRED（服务器在、凭据被拒）；false ⇒ NOT_CONNECTED。
 */
export async function classifyConnectError(
  error: unknown,
  host: string,
  port: number,
): Promise<MailTransportError> {
  const authFailed = (error as { authenticationFailed?: unknown } | null)?.authenticationFailed
  if (authFailed === true) return new MailTransportError('AUTH_REQUIRED', 'AUTHENTICATION_FAILED')
  const classified = classifyImapError(error)
  if (!isAmbiguousImapError(error)) return classified
  const probe = tcpProbeOverride ?? realTcpProbe
  let reachable = false
  try {
    reachable = await probe(host, port, MAIL_TCP_PROBE_TIMEOUT_MS)
  } catch {
    reachable = false
  }
  return reachable
    ? new MailTransportError('AUTH_REQUIRED', 'AUTH_REJECTED_TCP_REACHABLE')
    : new MailTransportError('NOT_CONNECTED', classified.reason ?? 'CONNECTION_FAILED')
}

/**
 * 从 imapflow 的 envelope 里取地址摘要。
 *
 * 真机事实（imapflow 直连）：envelope.from / envelope.to 是
 * `[{ address:'hr@qq.com', name:'...' }]` 对象数组，不是字符串数组；
 * message-id 字段是 camelCase `messageId`，不是 RFC 头名 `message-id`。
 * 旧实现只认 `'message-id'` 与字符串数组 → 真链拿回空壳时又用合成 id 兜底，
 * 把"读不到"伪装成"读到了"，掩盖了 fetchOne 少传第三参数的缺陷。
 */
function addressSummary(value: unknown): string {
  if (typeof value === 'string') return mailSummary(value)
  if (!Array.isArray(value) || value.length === 0) return ''
  // 跳过无效元素（name 非 string / address 非 string / null），取第一个**可用**地址；
  // 全部无效 → 空串（不产出假地址）。
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') return mailSummary(item)
    if (typeof item === 'object' && item !== null) {
      const address = (item as Record<string, unknown>).address
      if (typeof address === 'string' && address.trim() !== '') return mailSummary(address)
    }
  }
  return ''
}

/**
 * 把 imapflow envelope 投影成头部白名单（只摘摘要，绝不返回完整头/正文）。
 *
 * 运行时类型自查（2026-11-18 第四轮真链）：imapflow 的 `envelope.date` 是 **JS Date 对象**，
 * 不是字符串；旧实现 `typeof record.date === 'string'` 直接排除 → date 空 → 编排层
 * "日期无法判定"跳过 → total=0（第三次真链仍 0 的根因）。同类问题一并审：
 *   * messageId / subject：imapflow 给的是 string（按 string 判，安全）；
 *   * from / to：`[{address,name}]` 对象数组；`addressSummary` 只取 string 型 address，
 *     name 非 string 不影响（我们只输出 address），安全；
 *   * date：Date 对象优先（toISOString，不走 mailSummary 截断），字符串其次（trim 非空）。
 */
function headerSummary(source: unknown): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  if (source === null || typeof source !== 'object') return out
  const record = source as Record<string, unknown>
  const messageId = typeof record.messageId === 'string' ? record.messageId : ''
  if (messageId !== '') out['message-id'] = mailSummary(messageId)
  const from = addressSummary(record.from)
  if (from !== '') out.from = from
  const to = addressSummary(record.to)
  if (to !== '') out.to = to
  const date = record.date
  if (date instanceof Date && Number.isFinite(date.getTime())) {
    out.date = date.toISOString() // ISO 定长，不经 mailSummary 截断（保真）
  } else if (typeof date === 'string' && date.trim() !== '') {
    out.date = date.trim()
  }
  // undefined / 非法 Date / 空串：不产出 date 键，绝不填假值。
  const subject = record.subject
  if (typeof subject === 'string') out.subject = mailSummary(subject)
  return out
}

/**
 * 从 envelope 头部取真实 message-id。**没有就不编**（不再返回 `uid-N@imap-local`）——
 * 合成 id 会让 dedup 事件写进"假的事实"，并把 fetchOne 读空壳的真缺陷掩盖成"读到了"。
 */
function realMessageId(headers: Readonly<Record<string, string>>): string {
  const raw = headers['message-id'] ?? ''
  return raw.replace(/^<|>$/g, '').trim()
}

/** 造一个 IMAP 收件传输层。connect() 之前不发任何网络请求（零写入/零外联）。 */
export function createImapTransport(config: MailConfig): MailTransport {
  let client: ImapFlowLike | null = null
  let connected = false

  function guardConnected(): ImapFlowLike {
    if (client === null || !connected) {
      throw new MailTransportError('NOT_CONNECTED', 'NOT_CONNECTED')
    }
    return client
  }

  return {
    async connect(): Promise<void> {
      if (connected && client !== null) return
      let ctor: new (options: Record<string, unknown>) => ImapFlowLike
      try {
        ctor = await loadImapFlow()
      } catch (error) {
        throw classifyImapError(error)
      }
      try {
        const instance = new ctor({
          host: config.host,
          port: config.port,
          secure: config.tls,
          auth: { user: config.user, pass: config.password },
          // QQ IMAP 硬性要求：登录前必须发 ID 命令（imapflow 由 clientInfo 发出）。
          clientInfo: { ...IMAP_CLIENT_INFO },
          logger: false,
          emitLogs: false,
          disableAutoIdle: true,
        })
        await instance.connect()
        await instance.mailboxOpen(config.folder, { readOnly: true })
        client = instance
        connected = true
      } catch (error) {
        client = null
        connected = false
        // 模糊错误（QQ 的 "Command failed"）用 TCP 探测区分"服务器在但凭据被拒"与"网络不通"。
        throw await classifyConnectError(error, config.host, config.port)
      }
    },

    async listNew(input: ListNewInput): Promise<readonly MailEnvelope[]> {
      const active = guardConnected()
      const since = typeof input.since_uid === 'number' && Number.isFinite(input.since_uid)
        ? Math.max(0, Math.floor(input.since_uid))
        : 0
      const requested = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.floor(input.limit)
        : MAIL_LIST_DEFAULT_LIMIT
      const limit = Math.max(0, Math.min(MAIL_LIST_HARD_LIMIT, requested))
      if (limit === 0) return []
      let uids: number[]
      try {
        // 真缺陷修复（2026-11-18）：无水位时**禁止** search({all:true})，
        // 否则 1073 封邮箱先拿最老的 N 封 → 全被 since_days 时间窗丢掉 → total=0。
        // 无水位用 IMAP 原生 SINCE（服务端按日期过滤）；有水位用 uid:n+1:*。
        uids = await active.search(imapSearchCriteria(since, input.since_days ?? 7), { uid: true })
      } catch (error) {
        throw classifyImapError(error)
      }
      // **降序**取最新的 limit 封（newer-first）。旧实现升序取前 N 条 = 最老的 N 封，
      // 与编排层的 since_days 时间窗叠加后永远拿不到新邮件（真链 total=0 根因）。
      const sorted = selectNewestUids(uids, since, limit)
      const out: MailEnvelope[] = []
      for (const uid of sorted) {
        try {
          // 真缺陷修复（2026-11-18 第二轮）：imapflow 的 fetchOne(seq, query, options)
          // 第三参数 {uid:true} 决定首参按 UID 解释。漏传 → 按序列号取，uid=1125
          // 在 1073 封的邮箱里不存在 → envelope=null → 空壳元数据 → total=0。
          // query 里的 `uid:true` 只是"响应带 uid 字段"，不是 options，两者不能混。
          const message = await active.fetchOne(uid, {
            uid: true,
            envelope: true,
            headers: false,
            bodyStructure: false,
          }, { uid: true })
          if (message === null) continue
          const env = (message as { envelope?: Record<string, unknown> }).envelope
          // envelope 为空 = 这封没读出来：如实跳过，绝不合成 message-id 冒充真实事实。
          if (env === null || typeof env !== 'object') continue
          const headers = headerSummary(env)
          const realId = realMessageId(headers)
          if (realId === '') continue
          out.push({
            uid,
            message_id: realId,
            subject: headers['subject'] ?? '',
            from: headers['from'] ?? '',
            date: headers['date'] ?? '',
          })
        } catch (error) {
          // 单封信封读取失败：分类后交给编排层决定该封跳过，不能让整批崩掉。
          throw classifyImapError(error)
        }
      }
      return out
    },

    async fetchMessage(uid: number): Promise<RawMailMessage> {
      const active = guardConnected()
      if (!Number.isInteger(uid) || uid < 1) {
        throw new MailTransportError('INVALID_MESSAGE', 'INVALID_UID')
      }
      let message: unknown
      try {
        // 与 listNew 同样的坑：第三参数 {uid:true} 必须给，否则 uid 被当序列号，
        // 真链下一跑就会在下载原始字节这一步拿回空壳。
        message = await active.fetchOne(uid, {
          uid: true,
          envelope: true,
          source: true,
        }, { uid: true })
      } catch (error) {
        throw classifyImapError(error)
      }
      if (message === null || typeof message !== 'object') {
        throw new MailTransportError('INVALID_MESSAGE', 'MESSAGE_GONE')
      }
      const envelope = (message as { envelope?: unknown }).envelope
      if (envelope === null || typeof envelope !== 'object') {
        throw new MailTransportError('INVALID_MESSAGE', 'ENVELOPE_MISSING')
      }
      const headers = headerSummary(envelope)
      const source = (message as { source?: unknown }).source
      const raw = source instanceof Uint8Array
        ? Buffer.from(source)
        : typeof source === 'string'
          ? Buffer.from(source, 'binary')
          : null
      if (raw === null) throw new MailTransportError('INVALID_MESSAGE', 'SOURCE_MISSING')
      const realId = realMessageId(headers)
      if (realId === '') throw new MailTransportError('INVALID_MESSAGE', 'MESSAGE_ID_MISSING')
      const subject = headers['subject'] ?? ''
      return {
        uid,
        message_id: realId,
        headers,
        attachments: [],
        text: mailSummary(subject),
        raw,
      }
    },

    async disconnect(): Promise<void> {
      if (client === null) return
      const current = client
      client = null
      connected = false
      try {
        await current.logout()
      } catch {
        // 断开失败不掩盖之前的结果；imapflow 的 logout 关闭 socket 后即为断开。
      }
    },
  }
}
