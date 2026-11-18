// email-pump —— durable_effect 的轻量派发器（由宿主 tick 调用；本模块不自起定时器）。
//
// 职责边界：
//   * 只从 `claimPendingEffects` 取 PENDING/RETRY_WAIT 行 → 调注入的 transport.send → 用
//     `advanceEffect` 推进状态；
//   * 状态只往前走：所有 status 迁移走 A 的 `advanceEffect`（SQL `WHERE status IN (前驱)` +
//     record_version 乐观锁），本模块绝不写 status / record_version / status_changed_* /
//     事件（这些由 A + DB 触发器负责）；
//   * 超时/不确定结果 → UNKNOWN_OUTCOME（严禁猜 SENT）；传输层按 kind 分类；
//   * 回执**不按 external_id 匹配**：真机事实（QQ 服务端会改写 Message-ID）证明 SMTP 侧
//     id 与收件箱 id 必然不同。匹配用组合键「收件人 + 主题完全一致 + 发送时间 ± 窗口」，
//     由注入的 readback 回调实现；命中 → MATCH + CONFIRMED，读不到 → 预算耗尽报 NOT_FOUND，
//     读取失败/不可读 → UNREADABLE。非命中一律不改 status、不写 MATCH；
//   * `receipt_payload` 不在 A 的 patch 闭集里：经注入的 `io.markReadback` 单独写（宿主实现真
//     SQL，带 tenant + status='SENT' 守卫，不碰 status/record_version）。
//   * 不依赖真网络 / 真 DB：transport / readback / now / sleep / claim / advance / markReadback
//     都可注入。
//
// 宿主是否把它挂到现有 tick 由总控决定（本模块只导出 tick()/dispose()）。
import {
  advanceEffect,
  claimPendingEffects,
  listSentForReadback,
  type ClaimedEffect,
  type EffectAdvancePatch,
  type EffectReadbackState,
} from '../connectors/mail/durable-effect.ts'
import type { MailConfig } from '../connectors/mail/contract.ts'
import type { ResolvedDatabaseConfig } from '../db/pool.ts'

// =====================================================================
//  常量
// =====================================================================

/** email pump 派发周期（毫秒）。由宿主 setInterval 使用；测试断言固定 2s。 */
export const EMAIL_PUMP_INTERVAL_MS = 2000

/** 回执匹配时间窗（毫秒）：发送时间 ±10 分钟。 */
export const READBACK_TIME_WINDOW_MS = 10 * 60 * 1000

/** 默认回执预算：SENT 之后连续 N 次 tick 读不到才报 NOT_FOUND。 */
export const DEFAULT_READBACK_MAX_ATTEMPTS = 5

/**
 * 回执重试退避（毫秒）：第 1 次未命中后 5s、第 2 次 15s、第 3 次 30s、第 4+ 次 60s。
 * 真链事实：刚发完的瞬间邮件还没进 INBOX，立即查必然 null —— 必须排重试而不是记终态。
 */
export const READBACK_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const

export function readbackRetryDelay(attempt: number): number {
  const index = Math.max(0, Math.min(READBACK_RETRY_DELAYS_MS.length - 1, attempt - 1))
  return READBACK_RETRY_DELAYS_MS[index]!
}

// =====================================================================
//  类型
// =====================================================================

/** 发送错误种类（A 的 MailTransportError 带 kind；无 kind 的异常按 UNKNOWN 处理）。 */
export type SmtpErrorKind = 'AUTH_REQUIRED' | 'NOT_CONNECTED' | 'INVALID_MESSAGE' | 'TRANSIENT' | 'PERMANENT'

/** 可注入的 SMTP 发送函数（测试用假实现）。 */
export interface SendFunction {
  (mail: { to: string; subject: string; text: string; headers?: Record<string, string> }): Promise<{ messageId: string }>
}

/**
 * 回执查询回调：用组合键在收件箱匹配，**不按 external_id**（服务端会改写 Message-ID）。
 * `external_id` 仅作 SMTP 侧 id 的如实标识（写进 receipt_payload，不参与匹配）。
 * `null` = 读不到 / UNREADABLE（无法判定）；抛异常同样按 UNREADABLE 处理。
 */
export interface ReadbackQuery {
  readonly external_id: string
  readonly tenant_id: string
  /** 主题（完全一致才匹配）。 */
  readonly subject: string
  /** 收件人（自己或抄送自己）。 */
  readonly to: string
  /** SMTP 侧的发送时间 ISO（发送窗口中心）。 */
  readonly sent_at: string
  /** 窗口半径（毫秒）：sent_at ± time_window_ms。 */
  readonly time_window_ms: number
}

/** 回执匹配结果。`matched_message_id` 是**收件箱里**的 id（可能 ≠ SMTP 侧 external_id）。 */
export interface ReadbackResult {
  readonly matched: boolean
  readonly matched_message_id?: string
  readonly method?: string
  readonly payload?: Record<string, unknown>
  /** 脱敏诊断（连接失败/读取异常时填）：分类或异常名 + 前 120 字，不含口令/正文。 */
  readonly error?: string
}

export interface ReadbackFunction {
  (query: ReadbackQuery): Promise<ReadbackResult | null>
}

/** 回执 IMAP 传输层的最小面（listNew/fetchMessage 前必须先 connect）。 */
export interface ReadbackTransport {
  connect(): Promise<void>
  listNew(input: { limit?: number }): Promise<readonly {
    uid: number; subject: string; from: string; message_id: string; date: string
  }[]>
  fetchMessage(uid: number): Promise<{
    message_id: string; subject: string; headers: Readonly<Record<string, string>>; text: string
  }>
  disconnect(): Promise<void>
}

/**
 * 用 IMAP 收件箱做回执查询（组合键：收件人 + 主题完全一致 + 时间窗）。
 *
 * 真链回执卡死根因：`index.ts` 旧闭包直接 `listNew()` 而**从未 connect()**，
 * guardConnected 抛 NOT_CONNECTED → 被 pump 当 UNREADABLE，永远匹配不到。
 * 现在每次查询自己 connect / finally disconnect，并把连接/查询异常脱敏写进
 * `error` 字段供库外诊断（下次不用猜"为什么读不到"）。
 */
export function createImapReadback(
  factory: (mail: MailConfig) => ReadbackTransport,
  mail: MailConfig,
): ReadbackFunction {
  return async (query) => {
    const transport = factory(mail)
    try {
      await transport.connect()
      const envelopes = await transport.listNew({ limit: 100 })
      const center = Date.parse(query.sent_at)
      for (const env of envelopes) {
        if (env.subject !== query.subject) continue
        const at = Date.parse(env.date)
        if (!Number.isFinite(at) || !Number.isFinite(center)) continue
        if (Math.abs(at - center) > query.time_window_ms) continue
        const message = await transport.fetchMessage(env.uid)
        const headersTo = message.headers.to ?? ''
        if (headersTo !== '' && !headersTo.includes(query.to)) continue
        return {
          matched: true,
          matched_message_id: message.message_id || env.message_id,
          method: 'subject+recipient+time_window',
        }
      }
      return null
    } catch (error) {
      // 脱敏诊断：只留错误分类/名字 + 前 120 字，绝不含口令/正文。
      const kind = (error as { kind?: unknown } | null)?.kind
      const name = error instanceof Error ? error.name : ''
      const head = (error instanceof Error ? error.message : String(error)).slice(0, 120)
      const detail = typeof kind === 'string' && kind !== '' ? kind : (name || 'ERROR')
      return {
        matched: false,
        error: `${detail}: ${head}`,
        method: 'subject+recipient+time_window',
      }
    } finally {
      await transport.disconnect().catch(() => undefined)
    }
  }
}

/** 写回执列（不写 status！）；宿主用真 SQL 落在 durable_effect，带 tenant + status='SENT' 守卫。 */
export interface ReadbackMark {
  readonly readback_state: EffectReadbackState
  readonly receipt_payload: Record<string, unknown>
  readonly last_readback_at: string
  /** 未命中时的下次复查时间（ISO）；命中/终态不写。 */
  readonly next_attempt_at?: string | null
}

/** 可注入的 claim / advance / 事务包装 / 回执落库（测试用假实现；缺省用 A 的真函数）。 */
export interface PumpIo {
  readonly claim?: (client: unknown, opts: { limit?: number }) => Promise<readonly ClaimedEffect[]>
  /** 扫"已 SENT 但回执未完且到期"的行（不改状态）。缺省用 A 的 listSentForReadback。 */
  readonly listForReadback?: (client: unknown, opts: { limit?: number }) => Promise<readonly ClaimedEffect[]>
  readonly advance?: (client: unknown, effectId: string, patch: EffectAdvancePatch) => Promise<{ id: string; status: string; record_version: number }>
  /** 用 actor 身份执行一个事务（缺省直接把同一个 client 交给回调；宿主注入真 withActor）。 */
  readonly withWrite?: <T>(fn: (client: unknown) => Promise<T>) => Promise<T>
  /**
   * 只更新 durable_effect 的回执列（receipt_payload / readback_state / last_readback_at），
   * **不改 status、record_version、不写审计事件**。缺省 = noop（测试注入 spy 断言）。
   */
  readonly markReadback?: (client: unknown, effectId: string, mark: ReadbackMark) => Promise<void>
}

/** `createEmailPump` 依赖。 */
export interface EmailPumpDeps {
  readonly database: ResolvedDatabaseConfig
  readonly mail: MailConfig
  /** 发送实现；缺省 = null（没有发送能力时 tick 不 claim，零动作）。 */
  readonly transport?: SendFunction | null
  /** 回执查询；缺省 = 返回 null（不启用时永远 NOT_READ）。 */
  readonly readback?: ReadbackFunction | null
  readonly now?: () => Date
  readonly sleep?: (ms: number) => Promise<void>
  readonly retryDelayMs?: number
  readonly batchLimit?: number
  /** SENT 之后连续读不到多少次才报 NOT_FOUND（缺省 5）。 */
  readonly readbackMaxAttempts?: number
  /** 回执匹配时间窗半径（缺省 10 分钟）。 */
  readonly readbackTimeWindowMs?: number
  /** 测试 seam（claim / advance / 事务包装 / markReadback）。 */
  readonly io?: PumpIo
}

/** tick 计数结果。 */
export interface PumpTickResult {
  claimed: number
  sent: number
  retry: number
  unknown: number
  failed: number
  /** 本次 tick 做了多少次回执查询（含读不到 / 抛异常）。 */
  readback_checked: number
  /** 本次 tick 命中组合键并推进到 CONFIRMED 的数量。 */
  confirmed: number
  /** 本次 tick 预算耗尽、如实报 NOT_FOUND 的数量（状态仍 SENT）。 */
  not_found: number
  /** 本次 tick 回执读取失败/不可读、如实报 UNREADABLE 的数量（状态仍 SENT）。 */
  unreadable: number
}

/** 邮件 body 的 JSON 形状（A 的 enqueue 写入 payload；字段防御性读取）。 */
interface MailPayload {
  to?: unknown
  subject?: unknown
  text?: unknown
  body_summary?: unknown
}

// =====================================================================
//  纯函数：错误分类 / payload 解析（可直接单测）
// =====================================================================

/** 分类结果。 */
export type SendOutcome =
  | { readonly kind: 'SENT'; readonly messageId: string }
  | { readonly kind: 'AUTH_REQUIRED' | 'PERMANENT' | 'TRANSIENT' | 'NOT_CONNECTED' | 'UNKNOWN'; readonly errorCode: string }

/**
 * 把 transport.send 的结果/异常分类成确定的 outcome（纯函数，不碰 IO）。
 * 有 `kind` 的错误按闭集映射；没有 `kind` 的异常（含超时 / 网络不确定 / 未知形状）一律 UNKNOWN。
 */
export function classifySendResult(
  result: { messageId: string } | undefined,
  error: unknown,
): SendOutcome {
  if (error !== undefined && error !== null) {
    const kind = (error as { kind?: unknown }).kind
    if (kind === 'AUTH_REQUIRED' || kind === 'PERMANENT' || kind === 'TRANSIENT' || kind === 'NOT_CONNECTED') {
      const code = typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code !== ''
        ? (error as { code: string }).code
        : kind
      return { kind, errorCode: code }
    }
    // 超时 / 不确定 / 无 kind → UNKNOWN（严禁猜 SENT）
    return { kind: 'UNKNOWN', errorCode: 'SEND_OUTCOME_UNKNOWN' }
  }
  if (result !== undefined && typeof result.messageId === 'string' && result.messageId !== '') {
    return { kind: 'SENT', messageId: result.messageId }
  }
  return { kind: 'UNKNOWN', errorCode: 'SEND_OUTCOME_UNKNOWN' }
}

/** payload 缺最终发送字段时的明确错误（不许静默 fallback 到审计摘要）。 */
export class MailPayloadInvalidError extends Error {
  readonly code = 'PAYLOAD_INVALID' as const
  constructor(detail: string) {
    super(`PAYLOAD_INVALID: ${detail}`)
    this.name = 'MailPayloadInvalidError'
  }
}

/**
 * 从 effect.payload 取**最终要发的东西**。
 *
 * 契约（人点/授权动作写，pump 读）：`to` / `subject` / `text` 必须与用户预览看到的一致。
 * **不 fallback 到 body_summary**——那是审计摘要（≤500 字符、可能被截断），拿它发信
 * 会让"预览的"与"实际发的"漂移。字段缺失直接抛 `MailPayloadInvalidError`，
 * 由 tick 捕获并推进到 FAILED_FINAL/PAYLOAD_INVALID（不再静默 PENDING）。
 */
export function parseMailPayload(payload: unknown): { to: string; subject: string; text: string } {
  const record = typeof payload === 'object' && payload !== null ? payload as MailPayload : {}
  const to = typeof record.to === 'string' ? record.to.trim() : ''
  const subject = typeof record.subject === 'string' ? record.subject : ''
  const text = typeof record.text === 'string' ? record.text : ''
  const missing: string[] = []
  if (to === '') missing.push('to')
  if (subject === '') missing.push('subject')
  if (text === '') missing.push('text')
  if (missing.length > 0) {
    throw new MailPayloadInvalidError(`payload 缺最终发送字段：${missing.join(', ')}`)
  }
  return { to, subject, text }
}

/** 从 ClaimedEffect 取发送/重试所需字段（防御性，A 的行形状可能增加字段）。 */
function rowFields(row: ClaimedEffect): {
  payload: unknown
  attemptCount: number
  maxAttempts: number
  externalId: string
  sentAt: string
  receipt_payload: unknown
} {
  const record = row as unknown as Record<string, unknown>
  const attempt = typeof record.attempt_count === 'number' ? record.attempt_count : 0
  const max = typeof record.max_attempts === 'number' ? record.max_attempts : 5
  const externalId = typeof record.external_id === 'string' ? record.external_id : ''
  const sentAt = typeof record.sent_at === 'string' && record.sent_at !== ''
    ? record.sent_at
    : typeof record.sent_at === 'object' && record.sent_at instanceof Date
      ? record.sent_at.toISOString()
      : ''
  return { payload: record.payload, attemptCount: attempt, maxAttempts: max, externalId, sentAt, receipt_payload: record.receipt_payload }
}

// =====================================================================
//  pump
// =====================================================================

/**
 * 造一个派发器。`tick()` 由宿主/测试调用；本模块不注册 setInterval。
 * `dispose()` 标记已释放，之后 tick 直接返回全 0（不发送）。
 */
export function createEmailPump(deps: EmailPumpDeps): { tick(): Promise<PumpTickResult>; dispose(): void } {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? (async () => {})
  const retryDelayMs = deps.retryDelayMs ?? 30_000
  const batchLimit = deps.batchLimit ?? 20
  const readbackMaxAttempts = Number.isInteger(deps.readbackMaxAttempts) && (deps.readbackMaxAttempts as number) > 0
    ? deps.readbackMaxAttempts as number
    : DEFAULT_READBACK_MAX_ATTEMPTS
  const timeWindowMs = typeof deps.readbackTimeWindowMs === 'number' && deps.readbackTimeWindowMs > 0
    ? deps.readbackTimeWindowMs
    : READBACK_TIME_WINDOW_MS
  const io = deps.io ?? {}
  // 真链发信卡死根因（lead 定位）：旧默认实现 `() => claimPendingEffects(undefined, …)`
  // 把 withActor 传进来的事务 client **丢了**，client.query 立刻抛，被 tick().catch(warn) 吞掉
  // → effect 永远 PENDING。现在把 withWriteFn 给的 client 原样透传（与 advanceFn 同口径）。
  const claimFn = io.claim ?? ((client: unknown, opts: { limit?: number }) =>
    claimPendingEffects(client as never, opts))
  const listReadbackFn = io.listForReadback ?? ((client: unknown, opts: { limit?: number }) =>
    listSentForReadback(client as never, opts))
  const advanceFn = io.advance ?? ((client: unknown, id: string, patch: EffectAdvancePatch) => advanceEffect(client as never, id, patch))
  // 注意：以下两个默认实现**只用于纯测试**（无 withWrite/无 markReadback 时）；
  // 产品路径必须注入 withWrite（withActor 事务）与 markReadback（真 SQL），否则不会落库。
  const withWriteFn = io.withWrite ?? (async <T,>(fn: (client: unknown) => Promise<T>): Promise<T> => fn(undefined))
  const markReadbackFn = io.markReadback ?? (async () => { /* noop：宿主没注入时不落库，只计数/返回 */ })
  const readbackFn = deps.readback ?? null
  let disposed = false
  /** 每个 effect 的「连续读不到」计数（进程内内存；重启后从 0 重新开始，符合 fail-soft）。 */
  const missingBudget = new Map<string, number>()

  /** 组装给 markReadback 的 receipt_payload：如实标注 external_id 是 SMTP 侧 id。 */
  function receipt(
    externalId: string,
    result: ReadbackResult | null,
    outcome: 'NOT_FOUND' | 'UNREADABLE' | 'MATCH' | 'NOT_READ',
    attempts: number,
  ): Record<string, unknown> {
    return {
      method: result?.method ?? 'subject+recipient+time_window',
      matched_message_id: result?.matched_message_id ?? null,
      smtp_message_id: externalId,
      id_note: 'external_id 是 SMTP 侧 message-id；服务端可能改写，不作为收件箱匹配依据',
      outcome,
      attempts,
      // 脱敏诊断：连接失败/读取异常时库外可直接看到原因，不用再猜。
      ...(result?.error === undefined ? {} : { error: result.error }),
      ...(result?.payload === undefined ? {} : { detail: result.payload }),
    }
  }

  return {
    async tick(): Promise<PumpTickResult> {
      const counts: PumpTickResult = {
        claimed: 0, sent: 0, retry: 0, unknown: 0, failed: 0,
        readback_checked: 0, confirmed: 0, not_found: 0, unreadable: 0,
      }
      if (disposed || deps.transport == null) return counts

      // claim 在真实现里是写（PENDING→CLAIMED），必须在 withActor 事务内；宿主通过 io.withWrite 注入。
      const rows = await withWriteFn(async (client) => claimFn(client, { limit: batchLimit }))
      counts.claimed = rows.length

      /** 本 tick 刚 SENT 的行 → 发送时间用 now()，与组合键的窗口中心一致。 */
      const justSent = new Map<string, { messageId: string; sentAt: string; to: string; subject: string }>()

      for (const row of rows) {
        const { payload, attemptCount, maxAttempts } = rowFields(row)
        let mail: ReturnType<typeof parseMailPayload>
        try {
          mail = parseMailPayload(payload)
        } catch (error) {
          // 契约不一致（动作写 to/text，pump 读 body_summary 之类）必须进入**可诊断终态**，
          // 绝不能静默抛被 tick().catch(warn) 吞掉 → 永远 PENDING（真链发信卡死根因）。
          const invalid = error instanceof MailPayloadInvalidError ? error : new MailPayloadInvalidError(String(error))
          try {
            await withWriteFn(async (client) => advanceFn(client, row.id, {
              status: 'FAILED_FINAL',
              error_code: invalid.code,
              attempt_count: attemptCount,
            }))
            counts.failed += 1
          } catch {
            // 已被其它 tick 推进/乐观锁冲突：跳过，不重复计数。
          }
          continue
        }

        let result: { messageId: string } | undefined
        let error: unknown
        try {
          result = await deps.transport!(mail)
        } catch (caught) {
          error = caught
        }
        const outcome = classifySendResult(result, error)

        if (outcome.kind === 'SENT') {
          const sentAt = now().toISOString()
          try {
            await withWriteFn(async (client) => advanceFn(client, row.id, {
              status: 'SENT',
              sent_at: sentAt,
              external_id: outcome.messageId,
              attempt_count: attemptCount,
            }))
            counts.sent += 1
            justSent.set(row.id, { messageId: outcome.messageId, sentAt, to: mail.to, subject: mail.subject })
          } catch {
            // 同上：状态已被推进，跳过。
          }
          continue
        }

        if (outcome.kind === 'AUTH_REQUIRED' || outcome.kind === 'PERMANENT') {
          try {
            await withWriteFn(async (client) => advanceFn(client, row.id, {
              status: 'FAILED_FINAL',
              error_code: outcome.errorCode,
              attempt_count: attemptCount,
            }))
            counts.failed += 1
          } catch {
            // 跳过。
          }
          continue
        }

        // TRANSIENT / NOT_CONNECTED → RETRY_WAIT（除非次数用尽 → FAILED_FINAL）。
        if (outcome.kind === 'TRANSIENT' || outcome.kind === 'NOT_CONNECTED') {
          if (attemptCount + 1 >= maxAttempts) {
            try {
              await withWriteFn(async (client) => advanceFn(client, row.id, {
                status: 'FAILED_FINAL',
                error_code: outcome.errorCode,
                attempt_count: maxAttempts,
              }))
              counts.failed += 1
            } catch {
              // 跳过。
            }
          } else {
            try {
              await withWriteFn(async (client) => advanceFn(client, row.id, {
                status: 'RETRY_WAIT',
                error_code: outcome.errorCode,
                attempt_count: attemptCount + 1,
                next_attempt_at: new Date(now().getTime() + retryDelayMs).toISOString(),
              }))
              counts.retry += 1
            } catch {
              // 跳过。
            }
            await sleep(retryDelayMs)
          }
          continue
        }

        // UNKNOWN → UNKNOWN_OUTCOME（严禁猜 SENT；不写 sent_at / external_id / last_readback_at）。
        try {
          await withWriteFn(async (client) => advanceFn(client, row.id, {
            status: 'UNKNOWN_OUTCOME',
            error_code: outcome.errorCode,
            attempt_count: attemptCount,
          }))
          counts.unknown += 1
        } catch {
          // 跳过。
        }
      }

      // 回执阶段（真链第六跑后重做三态语义）：
      //   * 候选 = 本 tick 刚 SENT 的行 + 库里"已 SENT 但回执未完且到期"的行（每 tick 都扫）；
      //   * null / matched:false = "这次没找到" → 可重试：写 next_attempt_at 退避，状态保持 SENT；
      //     连续 N 次（readbackMaxAttempts）都没找到才写 NOT_FOUND（终态）；
      //   * 抛异常 / IMAP 不可读 = UNREADABLE：如实记录，但**同样排重试**（不是终态）；
      //   * 命中 = MATCH + CONFIRMED（写 matched_message_id / method）。
      //   * 已 CONFIRMED / NOT_FOUND 的行不会被 listSentForReadback 返回（终态不重复扫）。
      if (readbackFn !== null) {
        let dueRows: readonly ClaimedEffect[] = []
        try {
          dueRows = await withWriteFn((client) => listReadbackFn(client, { limit: batchLimit }))
        } catch {
          dueRows = [] // 扫描失败不影响本 tick 的发送结果；下一 tick 再扫。
        }
        const byId = new Map<string, ClaimedEffect>()
        for (const row of rows) byId.set(row.id, row)
        for (const row of dueRows) if (!byId.has(row.id)) byId.set(row.id, row)

        for (const row of byId.values()) {
          const fresh = justSent.get(row.id)
          const fields = rowFields(row)
          const externalId = fresh?.messageId ?? fields.externalId
          if (externalId === '') continue
          let mail: ReturnType<typeof parseMailPayload>
          try {
            mail = parseMailPayload(fields.payload)
          } catch {
            continue
          }
          const sentAt = fresh?.sentAt ?? fields.sentAt
          counts.readback_checked += 1

          // 持久化的尝试次数（进程重启不丢）：优先读 receipt_payload.attempts，
          // 否则用进程内 missingBudget（兼容旧行 / 测试）。
          const receiptAttempts = typeof (fields.receipt_payload as Record<string, unknown> | undefined)?.attempts === 'number'
            ? (fields.receipt_payload as Record<string, unknown>).attempts as number
            : 0
          const previous = Math.max(missingBudget.get(row.id) ?? 0, receiptAttempts)

          let receiptResult: ReadbackResult | null = null
          let readError: unknown
          try {
            receiptResult = await readbackFn({
              external_id: externalId,
              tenant_id: deps.database.tenant_id,
              subject: fresh?.subject ?? mail.subject,
              to: fresh?.to ?? mail.to,
              sent_at: sentAt,
              time_window_ms: timeWindowMs,
            })
          } catch (caught) {
            readError = caught
            receiptResult = null
          }

          // ① 命中：MATCH + CONFIRMED（终态）。
          if (receiptResult !== null && receiptResult.matched === true) {
            missingBudget.delete(row.id)
            const at = now().toISOString()
            try {
              await withWriteFn((client) => markReadbackFn(client, row.id, {
                readback_state: 'MATCH',
                receipt_payload: receipt(externalId, receiptResult, 'MATCH', previous + 1),
                last_readback_at: at,
                next_attempt_at: null,
              }))
            } catch { /* 回执列写失败仍可推进状态 */ }
            try {
              await withWriteFn((client) => advanceFn(client, row.id, {
                status: 'CONFIRMED', readback_state: 'MATCH', last_readback_at: at,
              }))
              counts.confirmed += 1
            } catch { /* 前驱不匹配 → 已被其它流程处理 */ }
            continue
          }

          const attempts = previous + 1

          // ② 抛异常 / 读不到 = UNREADABLE，但**排重试**（不是终态）；
          //    只有预算耗尽时才转 NOT_FOUND（终态），状态始终 SENT。
          if (attempts >= readbackMaxAttempts) {
            missingBudget.delete(row.id)
            const state: EffectReadbackState = readError === undefined ? 'NOT_FOUND' : 'UNREADABLE'
            try {
              await withWriteFn((client) => markReadbackFn(client, row.id, {
                readback_state: state,
                receipt_payload: receipt(externalId, receiptResult, state, attempts),
                last_readback_at: now().toISOString(),
                next_attempt_at: null,
              }))
            } catch { /* fail-soft */ }
            if (state === 'NOT_FOUND') counts.not_found += 1
            else counts.unreadable += 1
            continue
          }

          // 未命中且未耗尽：写回执状态 + 退避下次复查时间，**状态保持 SENT**。
          missingBudget.set(row.id, attempts)
          const state: EffectReadbackState = readError === undefined ? 'NOT_READ' : 'UNREADABLE'
          const nextAt = new Date(now().getTime() + readbackRetryDelay(attempts)).toISOString()
          try {
            await withWriteFn((client) => markReadbackFn(client, row.id, {
              readback_state: state,
              receipt_payload: receipt(externalId, receiptResult, state, attempts),
              last_readback_at: now().toISOString(),
              next_attempt_at: nextAt,
            }))
          } catch { /* fail-soft：下次 tick 仍会扫到（next_attempt_at 为空视为到期） */ }
          if (readError !== undefined) counts.unreadable += 1
        }
      }

      return counts
    },
    dispose(): void {
      disposed = true
      missingBudget.clear()
    },
  }
}
