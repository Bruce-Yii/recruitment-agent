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
}

export interface ReadbackFunction {
  (query: ReadbackQuery): Promise<ReadbackResult | null>
}

/** 写回执列（不写 status！）；宿主用真 SQL 落在 durable_effect，带 tenant + status='SENT' 守卫。 */
export interface ReadbackMark {
  readonly readback_state: EffectReadbackState
  readonly receipt_payload: Record<string, unknown>
  readonly last_readback_at: string
}

/** 可注入的 claim / advance / 事务包装 / 回执落库（测试用假实现；缺省用 A 的真函数）。 */
export interface PumpIo {
  readonly claim?: (client: unknown, opts: { limit?: number }) => Promise<readonly ClaimedEffect[]>
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

/** 从 effect.payload 里防御性取邮件字段；取不到就空串（不猜）。 */
export function parseMailPayload(payload: unknown): { to: string; subject: string; text: string } {
  const record = typeof payload === 'object' && payload !== null ? payload as MailPayload : {}
  const to = typeof record.to === 'string' ? record.to : ''
  const subject = typeof record.subject === 'string' ? record.subject : ''
  const text = typeof record.text === 'string'
    ? record.text
    : typeof record.body_summary === 'string' ? record.body_summary : ''
  return { to, subject, text }
}

/** 从 ClaimedEffect 取发送/重试所需字段（防御性，A 的行形状可能增加字段）。 */
function rowFields(row: ClaimedEffect): {
  payload: unknown
  attemptCount: number
  maxAttempts: number
  externalId: string
  sentAt: string
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
  return { payload: record.payload, attemptCount: attempt, maxAttempts: max, externalId, sentAt }
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
  const claimFn = io.claim ?? (() => claimPendingEffects(undefined as never, { limit: batchLimit }))
  const advanceFn = io.advance ?? ((client: unknown, id: string, patch: EffectAdvancePatch) => advanceEffect(client as never, id, patch))
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
    outcome: 'NOT_FOUND' | 'UNREADABLE' | 'MATCH',
    attempts: number,
  ): Record<string, unknown> {
    return {
      method: result?.method ?? (outcome === 'MATCH' ? 'subject+recipient+time_window' : 'subject+recipient+time_window'),
      matched_message_id: result?.matched_message_id ?? null,
      smtp_message_id: externalId,
      id_note: 'external_id 是 SMTP 侧 message-id；服务端可能改写，不作为收件箱匹配依据',
      outcome,
      attempts,
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
        const mail = parseMailPayload(payload)
        // 缺收件人/正文：不发送，直接 FAILED_FINAL（不猜收件人）。
        if (mail.to === '' || mail.text === '') {
          try {
            await withWriteFn(async (client) => advanceFn(client, row.id, {
              status: 'FAILED_FINAL',
              error_code: 'MAIL_PAYLOAD_INCOMPLETE',
              attempt_count: attemptCount,
            }))
            counts.failed += 1
          } catch {
            // advance 被乐观锁/前驱状态拒绝（例如已被别的 tick 处理）：跳过，不重复计数。
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

      // 回执阶段：对每个外部 id 非空的 SENT 行做一次组合键查询。
      // 读不到累计次数；达到预算 → 报 NOT_FOUND（只写回执列，状态保持 SENT）；
      // 读取抛异常 → 立即报 UNREADABLE（同样不改状态）；命中 → CONFIRMED + MATCH。
      if (readbackFn !== null) {
        for (const row of rows) {
          const fresh = justSent.get(row.id)
          const fields = rowFields(row)
          const externalId = fresh?.messageId ?? fields.externalId
          if (externalId === '') continue
          const mail = parseMailPayload(fields.payload)
          const sentAt = fresh?.sentAt ?? fields.sentAt
          counts.readback_checked += 1

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

          if (readError !== undefined) {
            // 读取失败/不可读：如实写 UNREADABLE，状态保持 SENT（绝不 CONFIRMED）。
            missingBudget.delete(row.id)
            try {
              await withWriteFn(async (client) => markReadbackFn(client, row.id, {
                readback_state: 'UNREADABLE',
                receipt_payload: receipt(externalId, null, 'UNREADABLE', 1),
                last_readback_at: now().toISOString(),
              }))
            } catch {
              // fail-soft：回执落库失败不影响本次 tick。
            }
            counts.unreadable += 1
            continue
          }

          if (receiptResult !== null && receiptResult.matched === true) {
            missingBudget.delete(row.id)
            // 命中：写好回执列（含 matched_message_id），再推进状态到 CONFIRMED。
            try {
              await withWriteFn(async (client) => markReadbackFn(client, row.id, {
                readback_state: 'MATCH',
                receipt_payload: receipt(externalId, receiptResult, 'MATCH', 1),
                last_readback_at: now().toISOString(),
              }))
            } catch {
              // 回执列写失败仍可推进状态（SENT→CONFIRMED 不依赖回执列）。
            }
            try {
              await withWriteFn(async (client) => advanceFn(client, row.id, {
                status: 'CONFIRMED',
                readback_state: 'MATCH',
                last_readback_at: now().toISOString(),
              }))
              counts.confirmed += 1
            } catch {
              // 状态不是 SENT（前驱不匹配）→ 不确认，跳过。
            }
            continue
          }

          // 读到了但不匹配（matched:false）或彻底读不到（null）：都算"未见回执"。
          // 按预算累计；达到上限才报 NOT_FOUND，状态始终 SENT。
          const attempts = (missingBudget.get(row.id) ?? 0) + 1
          missingBudget.set(row.id, attempts)
          if (attempts < readbackMaxAttempts) continue
          missingBudget.delete(row.id)
          // 注：matched:false（读到了但不匹配）也报 NOT_FOUND —— "没找到与本次发送对应的回执"；
          // 不写 MISMATCH（MISMATCH 暗示对上了但内容不符，这里无法证明是同一封）。
          try {
            await withWriteFn(async (client) => markReadbackFn(client, row.id, {
              readback_state: 'NOT_FOUND',
              receipt_payload: receipt(externalId, receiptResult, 'NOT_FOUND', attempts),
              last_readback_at: now().toISOString(),
            }))
          } catch {
            // fail-soft。
          }
          counts.not_found += 1
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
