// 邮件接入编排（rec/31 §4.1 核心）：IMAP 拉新邮件 → 解析 → 附件落盘算 sha →
// **复用现有简历接入链路**（buildMaterial / resolveIntakeSource / runConverter /
// intakeInTransaction），并在事务外另写一条**外部邮件事实事件**到 event_inbox。
//
// 三条硬约束（总控第四轮补强 + 任务书）：
//   1. 首次拉取只取最近 since_days 天（默认 7）+ UID 水位双保险，禁止全量扫描。
//      每轮推进水位（即使这封没有附件 / 重复 / 失败也推进到该封 uid）。
//   2. 单封附件总大小 20MB；超限跳过并记 reason，不静默截断。
//   3. 只处理带附件的邮件：没附件记 SEEN_NO_ATTACHMENT（推进去重位点），
//      不进简历流程；附件类型不在支持列表记 UNSUPPORTED_ATTACHMENT，不猜。
//
// 零写入保证：认证/网络失败必须在任何 DB 写入之前 fail；单封邮件处理失败时
// 该封不写任何库行（含邮件事件），但同批其他邮件继续。
//
// 去重口径：同一 message-id 已在 event_inbox（provider='email-imap'）→ 整封 DUPLICATE_MESSAGE；
// 同一附件 sha256 已在 intake_asset → 不重复走 intake（DUPLICATE_ASSET）。
// 三维标签 LIVE/EVENT/CONNECTED 在结果对象里标注（不是内部事件那套 FIXTURE/MANUAL）。

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'

import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../../db/pool.ts'
import { resolveWriteActor, type ToolActorDeps } from '../../demo-actor/tool-actor.ts'
import {
  buildMaterial,
  intakeInTransaction,
  resolveIntakeSource,
} from '../../tools/application-intake.ts'
import { runConverter, type ResolvedConverterConfig } from '../../tools/converter.ts'
import { shortHash, shortRef } from '../../tools/render-ref.ts'
import { EVENT_TYPES } from '../../runtime/event-types.ts'
import {
  MailTransportError,
  type MailConfig,
  type MailEnvelope,
  type MailTransport,
} from './contract.ts'
import { parseRawMail, rawBytesOf } from './parse.ts'

/** 一次拉取的输入。job_id 必填（intake 必须有目标岗位）。 */
export interface FetchAndIngestInput {
  readonly job_id: string
  /** 本轮最多处理多少封（默认 20，硬上限 50，由 transport 兜底）。 */
  readonly limit?: number
  /** UID 水位：只处理 uid > since_uid 的邮件。 */
  readonly since_uid?: number
  /**
   * 首次拉取的时间窗（天，默认 7）：由编排层按邮件 date 过滤，
   * 与 UID 水位双保险，禁止全量扫描。
   */
  readonly since_days?: number
  /**
   * 附件落地根目录（可选）。默认 = `allowed_roots[0]/.mail-intake/<message-id>/`，
   * 天然落在允许范围内；显式给的值必须仍在 allowed_roots 内，否则 fail-closed
   * （TEMP_ROOT_OUTSIDE_ALLOWED_ROOTS），不静默退回 os.tmpdir()。
   */
  readonly temp_root?: string
}

/** 依赖注入（全部可注入，测试用假 transport / 假 clock）。 */
export interface FetchAndIngestDeps {
  readonly transport: MailTransport
  readonly cfg: {
    readonly database: ResolvedDatabaseConfig
    readonly converter: ResolvedConverterConfig
    readonly mail: MailConfig
  }
  /** 写身份（产品路径由 src/index.ts 装配；测试可省略走 legacy 分支）。 */
  readonly identity?: ToolActorDeps
  /** DSH 工具执行上下文（resolveWriteActor 用）。 */
  readonly exec?: unknown
  /** 时间源（测试注入固定时间）。 */
  readonly clock?: () => Date
  /**
   * **仅测试用**：注入假 pool（避免真 PG）。产品路径不传，走 createPool/closePool。
   * 真链回归用它在无真库条件下断言"无附件 → SKIPPED/SEEN_NO_ATTACHMENT 而非 FAILED"。
   */
  readonly __poolForTest?: {
    readonly pool: unknown
    readonly close: () => Promise<void>
  }
}

/** 附件在结果里的业务摘要（sha 只前 8 位，文件名已安全化）。 */
export interface EmailAttachmentResult {
  readonly filename: string
  readonly sha256_prefix: string
  readonly mime_type: string
  readonly bytes: number
  readonly outcome: 'INGESTED' | 'DUPLICATE_ASSET' | 'SKIPPED'
  readonly reason?: string
}

/** 单封邮件的业务摘要（不含正文/PII/完整 UUID/hash）。 */
export interface EmailFetchMessageResult {
  /** message-id 短号（≤12 字符）。 */
  readonly message_id: string
  /** 主题短摘要（≤80 字符）。 */
  readonly subject: string
  readonly status: 'INGESTED' | 'DUPLICATE_MESSAGE' | 'DUPLICATE_ASSET' | 'SKIPPED' | 'FAILED'
    | 'SEEN_NO_ATTACHMENT' | 'UNSUPPORTED_ATTACHMENT'
  /**
   * 仅失败/跳过/重复时有：分类码。传输错误（AUTH_REQUIRED/NOT_CONNECTED/INVALID_MESSAGE…）
   * 之外还有 **DB_ERROR**（数据库写失败，不是邮箱断连）——V4 标签诚实：
   * 运维看到 DB_ERROR 去查库，看到 NOT_CONNECTED 去查网络，不能混。
   */
  readonly kind?: MailTransportError['kind'] | 'DB_ERROR'
  readonly reason?: string
  readonly attachments: readonly EmailAttachmentResult[]
  readonly application?: { readonly id_suffix: string; readonly action: 'CREATED' | 'REUSED' }
  readonly resume_version?: {
    readonly id_suffix: string
    readonly no: number
    readonly action: 'APPENDED' | 'UNCHANGED'
  }
  readonly labels: {
    readonly provenance: 'LIVE'
    readonly trigger: 'EVENT'
    readonly connection: 'CONNECTED' | 'NOT_CONNECTED' | 'AUTH_REQUIRED'
  }
}

/** 顶层结果（工具 B 的 render 用；与任务书签名一致）。 */
export interface EmailFetchResult {
  readonly total: number
  readonly ingested: number
  readonly duplicates: number
  readonly skipped: number
  readonly failed: number
  readonly connection: 'CONNECTED' | 'NOT_CONNECTED' | 'AUTH_REQUIRED'
  readonly results: readonly EmailFetchMessageResult[]
  /** 本轮处理到的最大 uid（水位推进值；工具 B 可持久化）。 */
  readonly next_since_uid: number
}

export type FetchAndIngestResult = EmailFetchResult

const PROVIDER = 'email-imap'
const EVENT_TYPE = 'RECRUITMENT_EMAIL_RECEIVED'
const NORMALIZED_EVENT_TYPE = EVENT_TYPES.RESUME_INTAKE_RECEIVED
const NORMALIZER_VERSION = 'email-imap/1.0.0'

function shortMessageId(messageId: string): string {
  return messageId.length <= 12 ? messageId : messageId.slice(0, 12)
}

function shortSubject(subject: string): string {
  const clean = subject.replace(/[\r\n\t]+/g, ' ').trim()
  return clean.length <= 80 ? clean : `${clean.slice(0, 77)}...`
}

/** 日期解析：ISO 字符串或邮件头日期；无法解析返回 null（按时间窗无法判定 → 保守跳过）。 */
function parseDate(value: string): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function isInsideRoot(candidate: string, root: string): boolean {
  const abs = resolvePath(candidate)
  const base = resolvePath(root)
  return abs === base || abs.startsWith(base.endsWith('\\') || base.endsWith('/') ? base : `${base}\\`)
    || abs.startsWith(`${base}/`)
}

/** 写一条外部邮件事实事件（PROVIDER_EVENT_ID 幂等；事务外调用方保证先于 intake）。 */
async function insertMailFactEvent(
  client: DatabaseClient,
  tenantId: string,
  envelope: MailEnvelope,
  attachmentShas: readonly string[],
  status: string,
  now: Date,
): Promise<void> {
  // payload 是脱敏摘要：不含正文、发件人邮箱（PII）、完整附件内容。
  const payload = {
    message_id_ref: shortMessageId(envelope.message_id),
    subject: shortSubject(envelope.subject),
    occurred_at: envelope.date || now.toISOString(),
    attachment_count: attachmentShas.length,
    sha256_prefixes: attachmentShas.map((sha) => sha.slice(0, 8)),
    status,
    source_kind: 'EMAIL_IMAP',
  }
  // uq_event_inbox_provider_event 是**部分唯一索引**：
  //   create unique index ... on event_inbox (tenant_id, provider, provider_event_id)
  //     where provider_event_id is not null
  // 真链第五跑根因：ON CONFLICT 没带同样的谓词 → PostgreSQL 报
  // "没有匹配ON CONFLICT说明的唯一或者排除约束" → 8 封全 EVENT_WRITE_FAILED。
  // 部分索引的 ON CONFLICT 必须显式重复 WHERE 谓词才能匹配。
  await client.query(
    `insert into recruitment.event_inbox
       (tenant_id, provider, provider_event_id, event_type, schema_version,
        occurred_at, received_at, recorded_at,
        idempotency_key, idempotency_source, source_object_id, payload, trust_level,
        normalized_event_type, normalizer_version)
     values ($1, $2, $3, $4, 1, $5, $6, $6, $7, 'PROVIDER_EVENT_ID', $3, $8::jsonb,
             'UNTRUSTED_EXTERNAL', $9, $10)
     on conflict (tenant_id, provider, provider_event_id) where provider_event_id is not null do nothing`,
    [
      tenantId,
      PROVIDER,
      envelope.message_id,
      EVENT_TYPE,
      now.toISOString(),
      now.toISOString(),
      `${PROVIDER}:${envelope.message_id}`,
      JSON.stringify(payload),
      NORMALIZED_EVENT_TYPE,
      NORMALIZER_VERSION,
    ],
  )
}

/** 该 message-id 是否已有邮件事实事件（幂等判定）。 */
async function mailFactExists(client: DatabaseClient, tenantId: string, messageId: string): Promise<boolean> {
  const { rows } = await client.query<{ event_id: string }>(
    `select event_id from recruitment.event_inbox
      where tenant_id = $1 and provider = $2 and provider_event_id = $3`,
    [tenantId, PROVIDER, messageId],
  )
  return rows.length > 0
}

/** 该附件 sha 是否已有 intake_asset（业务层去重标识）。 */
async function assetExists(client: DatabaseClient, tenantId: string, sha256: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    'select id from recruitment.intake_asset where tenant_id = $1 and sha256 = $2 limit 1',
    [tenantId, sha256],
  )
  return rows.length > 0
}

/**
 * 解析附件落地根目录（真链第五跑修复）。
 *
 * 旧实现默认 `os.tmpdir()/dsh-recruitment-mail`，不在 converter.allowed_roots 内 →
 * 新 PDF 靶子被判 OUTSIDE_ALLOWED_ROOTS 而没入库。新口径：
 *   1. 没有 allowed_roots → fail-closed，返回 null（调用方报 NOT_CONFIGURED，不硬塞 temp）；
 *   2. 显式 temp_root 必须落在 allowed_roots 内，否则 fail-closed（TEMP_ROOT_OUTSIDE_ALLOWED_ROOTS）；
 *   3. 默认 = `<allowed_roots[0]>/.mail-intake/<safe message-id>/`，天然在允许范围内。
 */
export function resolveTempRoot(
  explicit: string | undefined,
  allowedRoots: readonly string[],
  messageId: string,
): string | null {
  if (allowedRoots.length === 0) return null
  if (explicit !== undefined) {
    const root = resolvePath(explicit)
    return allowedRoots.some((allowed) => isInsideRoot(root, allowed)) ? root : null
  }
  const base = resolvePath(allowedRoots[0]!)
  const safeId = messageId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'mail'
  return join(base, '.mail-intake', safeId)
}

/** 附件落盘到受控临时目录：不在 allowed_roots 内则返回 null（由编排层报 SKIPPED 而非报错）。 */
async function landAttachment(
  attachment: { filename: string; buffer: Buffer },
  tempRoot: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  const root = resolvePath(tempRoot)
  if (allowedRoots.length === 0) return null
  const inside = allowedRoots.some((allowed) => isInsideRoot(root, allowed))
  if (!inside) return null
  await mkdir(root, { recursive: true })
  const target = join(root, attachment.filename)
  if (!isInsideRoot(target, root)) return null
  await writeFile(target, attachment.buffer)
  return target
}

/** 生成失败结果（统一形状，kind 可选）。**只用于"有附件但处理失败"**。 */
function failResult(
  envelope: MailEnvelope | null,
  messageId: string,
  reason: string,
  kind?: MailTransportError['kind'] | 'DB_ERROR',
): EmailFetchMessageResult {
  return {
    message_id: shortMessageId(messageId),
    subject: envelope === null ? '' : shortSubject(envelope.subject),
    status: 'FAILED',
    ...(kind === undefined ? {} : { kind }),
    reason,
    attachments: [],
    labels: { provenance: 'LIVE', trigger: 'EVENT', connection: kind === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'CONNECTED' },
  }
}

/**
 * 生成"读不出来"的跳过结果（统一形状）。
 *
 * 真链复盘（2026-11-18 第四跑）：9 封无附件的订阅/广告邮件被记 FAILED，
 * 但它们根本没进入附件处理——失败发生在 fetchMessage / parseRawMail 阶段。
 * 按设计口径：**没附件的邮件不该记 FAILED**，只有"有附件但处理失败"才是 FAILED；
 * 读不出来（连附件有没有都不知道）如实记 SKIPPED/UNREADABLE，不重试、不算失败。
 */
function unreadableResult(
  envelope: MailEnvelope,
  reason: string,
  kind?: MailTransportError['kind'],
): EmailFetchMessageResult {
  return {
    message_id: shortMessageId(envelope.message_id),
    subject: shortSubject(envelope.subject),
    status: 'SKIPPED',
    reason: `UNREADABLE:${reason}`,
    ...(kind === undefined ? {} : { kind }),
    attachments: [],
    labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
  }
}

/**
 * 核心编排。connect 失败在**任何 DB 写之前**返回顶层错误码；同批每封独立处理，
 * 失败只影响该封；finally 里 disconnect。
 */
export async function fetchAndIngest(
  input: FetchAndIngestInput,
  deps: FetchAndIngestDeps,
): Promise<FetchAndIngestResult> {
  const now = deps.clock?.() ?? new Date()
  const results: EmailFetchMessageResult[] = []
  const { transport, cfg } = deps
  const tenantId = cfg.database.tenant_id
  const sinceDays = input.since_days ?? cfg.mail.since_days
  const timeFloor = now.getTime() - Math.max(0, sinceDays) * 24 * 60 * 60 * 1000
  let watermark = Math.max(0, input.since_uid ?? cfg.mail.since_uid ?? 0)

  let envelopes: readonly MailEnvelope[] = []
  try {
    await transport.connect()
  } catch (error) {
    const mapped = error instanceof MailTransportError ? error : new MailTransportError('NOT_CONNECTED', 'CONNECT_FAILED')
    const connection = mapped.kind === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'NOT_CONNECTED'
    // 认证/网络失败：零 DB 写入，且提前返回（不建连接池）。
    return {
      total: 0, ingested: 0, duplicates: 0, skipped: 0, failed: 0,
      connection, results: [], next_since_uid: watermark,
    }
  }

  try {
    // 把时间窗下推到传输层：无水位时用 IMAP 原生 SINCE 搜索（禁止 all），
    // 且传输层按 UID 降序取最新 limit 封。下面的时间窗过滤保留为第二道防线
    // （防服务端日期不准 / 假 transport 返回乱序），不能再依赖它来"筛出"新邮件。
    envelopes = await transport.listNew({
      since_uid: watermark,
      since_days: sinceDays,
      limit: input.limit,
    })
  } catch (error) {
    const mapped = error instanceof MailTransportError ? error : new MailTransportError('NOT_CONNECTED', 'LIST_FAILED')
    const connection = mapped.kind === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'NOT_CONNECTED'
    return {
      total: 0, ingested: 0, duplicates: 0, skipped: 0, failed: 0,
      connection, results: [], next_since_uid: watermark,
    }
  }

  // 时间窗过滤：没有日期的邮件保守跳过（不进全量扫描），并报 SEEN_NO_ATTACHMENT 语义。
  const inWindow = envelopes.filter((envelope) => {
    const ts = parseDate(envelope.date)
    return ts !== null && ts >= timeFloor
  })

  // 一个连接池复用整批；withActor 每封开一个事务。
  const pool = (deps.__poolForTest?.pool ?? createPool(cfg.database)) as ReturnType<typeof createPool>
  try {
    for (const envelope of inWindow) {
      if (envelope.uid > watermark) watermark = envelope.uid
      // 先判重（只读优化）。真链第四跑复盘：这一步失败时旧实现把整封记 FAILED，
      // 导致 9 封无附件邮件全 FAILED。去重检查只是**优化**——失败不等于"这封失败"：
      // 继续走后续流程，最终写 event_inbox 时 `ON CONFLICT DO NOTHING` 仍保证幂等。
      // 因此这里失败只记一个标记（reason 里如实体现），不跳过、不 FAILED。
      let already = false
      let dedupUnavailable = false
      try {
        already = await withActor(pool, cfg.database.actor_id, (client) =>
          mailFactExists(client, tenantId, envelope.message_id))
      } catch {
        dedupUnavailable = true
      }
      if (already) {
        results.push({
          message_id: shortMessageId(envelope.message_id),
          subject: shortSubject(envelope.subject),
          status: 'DUPLICATE_MESSAGE',
          reason: 'MESSAGE_ALREADY_RECORDED',
          attachments: [],
          labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
        })
        continue
      }

      // 下载 + 解析（不在事务里，避免长事务占连接）。
      let parsed
      try {
        const message = await transport.fetchMessage(envelope.uid)
        const raw = rawBytesOf(message)
        if (raw === null) throw new MailTransportError('INVALID_MESSAGE', 'RAW_MISSING')
        parsed = await parseRawMail(raw, message)
      } catch (error) {
        // 连原始字节都拿不到/解析不出来 ⇒ 还不知道有没有附件 ⇒ 按"读不出来"跳过（SKIPPED），
        // 不记 FAILED（FAILED 只留给"有附件但处理失败"，见 failResult 的注释）。
        const mapped = error instanceof MailTransportError ? error : new MailTransportError('INVALID_MESSAGE', 'PARSE_FAILED')
        results.push(unreadableResult(envelope, mapped.reason ?? 'PARSE_FAILED', mapped.kind))
        continue
      }

      // 没有可用附件 → 只推进位点，不进简历流程（总控第四轮补强 3）。
      if (parsed.attachments.length === 0) {
        const reason = parsed.skipped.length > 0
          ? (parsed.skipped.some((s) => s.reason === 'ATTACHMENT_TOO_LARGE')
              ? 'UNSUPPORTED_TYPE:ATTACHMENT_TOO_LARGE'
              : `UNSUPPORTED_TYPE:${parsed.skipped[0]!.reason}`)
          : 'SEEN_NO_ATTACHMENT'
        // 轻量事实事件：保证 message-id 去重位点持久化（写一条 event_inbox 行）。
        try {
          await withActor(pool, cfg.database.actor_id, (client) =>
            insertMailFactEvent(client, tenantId, envelope, [], reason, now))
        } catch {
          // 位点写入失败：该封按 FAILED 处理，水位已推进但下次会重试该 message-id。
          // 数据库写失败不是邮箱断连：kind 用 DB_ERROR（V4 诚实，别让运维查网络）。
          results.push(failResult(envelope, envelope.message_id, 'EVENT_WRITE_FAILED', 'DB_ERROR'))
          continue
        }
        const status = parsed.skipped.length > 0 && reason.startsWith('UNSUPPORTED_TYPE')
          ? 'UNSUPPORTED_ATTACHMENT'
          : 'SEEN_NO_ATTACHMENT'
        results.push({
          message_id: shortMessageId(envelope.message_id),
          subject: shortSubject(envelope.subject),
          status,
          reason: dedupUnavailable ? `${reason}:DEDUP_CHECK_UNAVAILABLE` : reason,
          attachments: parsed.skipped.map((s) => ({
            filename: s.filename,
            sha256_prefix: '—',
            mime_type: '—',
            bytes: s.bytes,
            outcome: 'SKIPPED',
            reason: s.reason,
          })),
          labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
        })
        continue
      }

      // 逐附件处理：先查 sha 去重，再落盘 + converter + intake。
      const attachmentResults: EmailAttachmentResult[] = []
      let anyIngested = false
      let applicationInfo: EmailFetchMessageResult['application']
      let versionInfo: EmailFetchMessageResult['resume_version']
      let processingFailed = false
      const mailboxEventShas: string[] = []

      for (const attachment of parsed.attachments) {
        let duplicate: boolean
        try {
          duplicate = await withActor(pool, cfg.database.actor_id, (client) =>
            assetExists(client, tenantId, attachment.sha256))
        } catch {
          attachmentResults.push({
            filename: attachment.filename, sha256_prefix: shortHash(attachment.sha256),
            mime_type: attachment.contentType, bytes: attachment.bytes,
            outcome: 'SKIPPED', reason: 'DEDUP_CHECK_FAILED',
          })
          processingFailed = true
          continue
        }
        if (duplicate) {
          attachmentResults.push({
            filename: attachment.filename, sha256_prefix: shortHash(attachment.sha256),
            mime_type: attachment.contentType, bytes: attachment.bytes,
            outcome: 'DUPLICATE_ASSET', reason: 'SHA_ALREADY_INGESTED',
          })
          mailboxEventShas.push(attachment.sha256)
          continue
        }

        const tempRoot = resolveTempRoot(input.temp_root, cfg.converter.allowed_roots, envelope.message_id)
        if (tempRoot === null) {
          // fail-closed：没配 allowed_roots（NOT_CONFIGURED）或显式 temp_root 越界
          // （TEMP_ROOT_OUTSIDE_ALLOWED_ROOTS）——不静默退回 os.tmpdir() 再失败。
          const reason = cfg.converter.allowed_roots.length === 0
            ? 'NOT_CONFIGURED'
            : 'TEMP_ROOT_OUTSIDE_ALLOWED_ROOTS'
          attachmentResults.push({
            filename: attachment.filename, sha256_prefix: shortHash(attachment.sha256),
            mime_type: attachment.contentType, bytes: attachment.bytes,
            outcome: 'SKIPPED', reason,
          })
          processingFailed = true
          continue
        }
        const landed = await landAttachment(attachment, tempRoot, cfg.converter.allowed_roots)
        if (landed === null) {
          attachmentResults.push({
            filename: attachment.filename, sha256_prefix: shortHash(attachment.sha256),
            mime_type: attachment.contentType, bytes: attachment.bytes,
            outcome: 'SKIPPED', reason: 'OUTSIDE_ALLOWED_ROOTS',
          })
          continue
        }

        let source
        try {
          source = await resolveIntakeSource(landed, cfg.converter)
        } catch {
          attachmentResults.push({
            filename: attachment.filename, sha256_prefix: shortHash(attachment.sha256),
            mime_type: attachment.contentType, bytes: attachment.bytes,
            outcome: 'SKIPPED', reason: 'UNSUPPORTED_TYPE',
          })
          continue
        }
        let output
        try {
          output = await runConverter(cfg.converter, source.real_path)
        } catch {
          attachmentResults.push({
            filename: attachment.filename, sha256_prefix: shortHash(attachment.sha256),
            mime_type: attachment.contentType, bytes: attachment.bytes,
            outcome: 'SKIPPED', reason: 'CONVERTER_FAILED',
          })
          processingFailed = true
          continue
        }

        // 写身份：与既有写工具同源；identity 未装配时走 legacy（测试兼容）。
        const writeActor = resolveWriteActor(deps.exec, deps.identity?.identity, cfg.database.actor_id)
        const database: ResolvedDatabaseConfig = { ...cfg.database, actor_id: writeActor.actor_id }
        const material = buildMaterial(source.real_path, output, source.media_type)

        try {
          // 事务 1：外部邮件事实事件（PROVIDER_EVENT_ID 幂等，先于 intake）。
          await withActor(pool, database.actor_id, (client) =>
            insertMailFactEvent(client, tenantId, envelope, [attachment.sha256], 'PROCESSING', now))
          // 事务 2：复用既有 intake 全链路（候选人/申请/resume/intake 三层）。
          const value = await withActor(pool, database.actor_id, (client) =>
            intakeInTransaction(client, database, material, input.job_id))
          applicationInfo = {
            id_suffix: shortRef(value.application_id),
            action: value.application_action,
          }
          versionInfo = {
            id_suffix: shortRef(value.resume_version_id),
            no: value.resume_version_no,
            action: value.resume_version_action,
          }
          attachmentResults.push({
            filename: attachment.filename, sha256_prefix: shortHash(attachment.sha256),
            mime_type: source.media_type, bytes: attachment.bytes,
            outcome: 'INGESTED',
          })
          mailboxEventShas.push(attachment.sha256)
          anyIngested = true
        } catch {
          // 该附件处理失败：事务已回滚，不写邮件事件（事件事务先提交但整封按失败处理，
          // 为避免"事件已写但 intake 失败"的悬挂事实，下一次同 message-id 会走
          // DUPLICATE_MESSAGE；这里记 FAILED，不假装成功）。
          attachmentResults.push({
            filename: attachment.filename, sha256_prefix: shortHash(attachment.sha256),
            mime_type: source.media_type, bytes: attachment.bytes,
            outcome: 'SKIPPED', reason: 'INTAKE_FAILED',
          })
          processingFailed = true
        }
      }

      if (processingFailed || !anyIngested) {
        results.push({
          message_id: shortMessageId(envelope.message_id),
          subject: shortSubject(envelope.subject),
          status: 'SKIPPED',
          reason: processingFailed ? 'PARTIAL_OR_FAILED' : 'ALL_ATTACHMENTS_DUPLICATE',
          attachments: attachmentResults,
          labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
        })
      } else {
        results.push({
          message_id: shortMessageId(envelope.message_id),
          subject: shortSubject(envelope.subject),
          status: attachmentResults.some((a) => a.outcome === 'DUPLICATE_ASSET') ? 'DUPLICATE_ASSET' : 'INGESTED',
          attachments: attachmentResults,
          ...(applicationInfo === undefined ? {} : { application: applicationInfo }),
          ...(versionInfo === undefined ? {} : { resume_version: versionInfo }),
          labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
        })
      }
    }
  } finally {
    if (deps.__poolForTest !== undefined) await deps.__poolForTest.close()
    else await closePool(pool)
    await transport.disconnect()
  }

  const ingested = results.filter((r) => r.status === 'INGESTED').length
  const duplicates = results.filter((r) => r.status === 'DUPLICATE_MESSAGE' || r.status === 'DUPLICATE_ASSET').length
  const skipped = results.filter((r) => r.status === 'SKIPPED' || r.status === 'SEEN_NO_ATTACHMENT'
    || r.status === 'UNSUPPORTED_ATTACHMENT').length
  const failed = results.filter((r) => r.status === 'FAILED').length
  return {
    total: results.length,
    ingested, duplicates, skipped, failed,
    connection: 'CONNECTED',
    results,
    next_since_uid: watermark,
  }
}
