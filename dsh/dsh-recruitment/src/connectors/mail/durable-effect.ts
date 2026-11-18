// 发信副作用层（rec/31 §4.2）：复用 recruitment.durable_effect 表（0 迁移）。
//
// 职责：
//   * enqueueEmailSend —— 幂等入队（同 application_id:template_key:version 只一条），
//     payload 只放摘要（recipient_ref/subject/body_summary/确认原话 sha/授权引用），
//     payload_hash = digestOf(payload)（复用 src/tools/contract.ts，R1）。
//   * claimPendingEffects / advanceEffect —— 供 pump 调用，状态只往后走
//     （SQL WHERE status IN (...) + record_version 乐观锁 + UPDATE ... RETURNING）。
//   * resolveEmailAuthorization —— 模式 B 按范围授权的**纯判定**（可单测），
//     授权策略放 business_config（config_key='email.send.authorization'，不新建表）。
//
// 关键 DB 事实（0001_init.sql:1561-1617, 87-169）：
//   * durable_effect.status 上装了 fn_row_guard('status','status') 触发器：
//     每次**状态迁移**自动写一条 event_inbox 内部事件，并自动填
//     status_changed_at / status_changed_by_actor_id / status_source_event_id / record_version。
//     ⇒ 本层**绝不手写**这些列；enqueue/advance 必须在 withActor 事务里调用（actor GUC）。
//     ⇒ 状态没变只改其他列时，触发器禁止手改 status_changed_at/status_source_event_id。
//   * ck_durable_effect_confirmed: CONFIRMED 必须 sent_at/confirmed_at 都非空；
//     ck_durable_effect_failed: FAILED_FINAL 必须 error_code 非空；
//     ck_durable_effect_unknown: UNKNOWN_OUTCOME 要求 last_readback_at IS NULL；
//     ck_durable_effect_attempts: attempt_count <= max_attempts。
//
// 状态机各状态的写入方：
//   PENDING          —— enqueueEmailSend（本层）。
//   CLAIMED          —— claimPendingEffects（本层）。
//   SENT             —— advanceEffect（SMTP 发送成功）。
//   UNKNOWN_OUTCOME  —— advanceEffect（超时/结果不明，不猜 SENT）。
//   RETRY_WAIT       —— advanceEffect（TRANSIENT，写 next_attempt_at + attempt_count）。
//   FAILED_FINAL     —— advanceEffect（PERMANENT 且 attempt_count>=max_attempts）。
//   CONFIRMED        —— advanceEffect（回执 MATCH，写 confirmed_at）。
//   CANCELLED / COMPENSATION_REQUIRED —— 预留给上层（C 的人闸门/补偿），本层不主动写。

import { randomUUID } from 'node:crypto'

import { digestOf } from '../../tools/contract.ts'
import type { DatabaseClient } from '../../db/pool.ts'
import { MailTransportError } from './contract.ts'

/** durable_effect.status 闭集（与 ck_durable_effect_status 一致）。 */
export type EffectStatus =
  | 'PENDING' | 'CLAIMED' | 'SENT' | 'CONFIRMED' | 'RETRY_WAIT' | 'UNKNOWN_OUTCOME'
  | 'FAILED_FINAL' | 'CANCELLED' | 'COMPENSATION_REQUIRED'

/** readback_state 闭集（与 ck_durable_effect_readback 一致）。 */
export type EffectReadbackState = 'NOT_READ' | 'MATCH' | 'MISMATCH' | 'NOT_FOUND' | 'UNREADABLE'

/** 入队入参。 */
export interface EnqueueEmailSendInput {
  readonly tenant_id: string
  readonly actor_id: string
  readonly application_id: string
  readonly recipient_ref: string
  readonly template_key: string
  readonly template_version: string
  readonly subject: string
  /**
   * 服务端解析出的收件地址（**最终要发的东西**，人预览看到的就是这一份）。
   * 派发器直接用它，不再二次解析收件人（避免预览与实际发送漂移）。
   */
  readonly to: string
  /**
   * 完整正文（**最终要发的东西**）。人预览看到的 body_preview 必须与它逐字一致。
   * 保留 body_summary 作审计摘要，但派发一律用 text。
   */
  readonly text: string
  /** 正文摘要（≤500 字符，审计用；派发不读它）。 */
  readonly body_summary: string
  /** 幂等键；缺省 `${application_id}:${template_key}:${template_version}`。 */
  readonly idempotency_key?: string
  /** 人对确认原话的 sha256（人工点击时由 HTTP 路由写入）。 */
  readonly confirmation_text_sha256?: string
  /** 授权引用：自动化 = resolveEmailAuthorization 命中的 authorization_ref；人工 = 'HUMAN_CLICK'。 */
  readonly authorization_ref?: string | null
  /** 授权人 actor id（人工点击 = 点击人；自动化 = 授权记录里的 authorized_by_actor_id）。 */
  readonly authorized_by_actor_id?: string | null
  /** email_class（OFFER 永不自动；用于 payload 留痕）。 */
  readonly email_class?: string
  readonly correlation_id?: string
  readonly causation_event_id?: string
}

/** 入队结果。 */
export interface EnqueueEmailSendResult {
  readonly id: string
  readonly status: EffectStatus
  readonly created: boolean
}

/** 默认幂等键：application_id + 模板 + 版本。 */
export function emailEffectIdempotencyKey(input: {
  readonly application_id: string
  readonly template_key: string
  readonly template_version: string
}): string {
  return `${input.application_id}:${input.template_key}:${input.template_version}`
}

/** 正文摘要截断（只留摘要，不落全文，R7）。 */
export function mailBodySummary(value: string, maxChars: number = 500): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, Math.max(0, maxChars))
}

/**
 * 纯函数：构造 durable_effect.payload（跨模块契约的唯一实现）。
 * 供 enqueue 落库与"动作→派发器 round-trip"测试共用，防止两边各写一套形状再次漂移。
 */
export function buildEmailEffectPayload(input: EnqueueEmailSendInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tenant_id: input.tenant_id,
    application_id: input.application_id,
    recipient_ref: input.recipient_ref,
    template_key: input.template_key,
    template_version: input.template_version,
    subject: input.subject,
    // 最终要发的东西：人预览看到的就是这两份，派发器直接消费，不许二次组装。
    to: input.to,
    text: input.text,
    body_summary: mailBodySummary(input.body_summary),
    authorization_ref: input.authorization_ref ?? null,
    authorized_by_actor_id: input.authorized_by_actor_id ?? null,
  }
  if (input.confirmation_text_sha256 !== undefined) {
    payload.confirmation_text_sha256 = input.confirmation_text_sha256
  }
  if (input.email_class !== undefined) payload.email_class = input.email_class
  return payload
}

/**
 * 幂等入队。同键已存在 → 不新增行、created:false（用 ON CONFLICT DO NOTHING +
 * RETURNING，靠 uq_durable_effect_idempotency 唯一约束兜底）。
 * **必须在 withActor(pool, actorId, ...) 事务内调用**（触发器要求 actor GUC）。
 */
export async function enqueueEmailSend(
  client: DatabaseClient,
  input: EnqueueEmailSendInput,
): Promise<EnqueueEmailSendResult> {
  const idempotencyKey = input.idempotency_key?.trim() !== ''
    ? (input.idempotency_key as string)
    : emailEffectIdempotencyKey(input)
  const payload = buildEmailEffectPayload(input)
  const payloadHash = digestOf(payload)
  const businessRefs = [
    { type: 'APPLICATION', id: input.application_id },
    { type: 'ACTOR', id: input.actor_id },
  ]

  const inserted = await client.query<{ id: string; status: string }>(
    `insert into recruitment.durable_effect
       (tenant_id, effect_type, business_refs, idempotency_key, status, payload, payload_hash,
        attempt_count, max_attempts, correlation_id, causation_event_id)
     values ($1, 'EMAIL_SEND', $2::jsonb, $3, 'PENDING', $4::jsonb, $5, 0, 5, $6, $7)
     on conflict (tenant_id, idempotency_key) do nothing
     returning id, status`,
    [
      input.tenant_id,
      JSON.stringify(businessRefs),
      idempotencyKey,
      JSON.stringify(payload),
      payloadHash,
      input.correlation_id ?? null,
      input.causation_event_id ?? null,
    ],
  )
  const fresh = inserted.rows[0]
  if (fresh !== undefined) return { id: fresh.id, status: fresh.status as EffectStatus, created: true }
  // 冲突：回读已存在行的实际状态（不改动它）。
  const found = await client.query<{ id: string; status: string }>(
    'select id, status from recruitment.durable_effect where tenant_id = $1 and idempotency_key = $2',
    [input.tenant_id, idempotencyKey],
  )
  const existing = found.rows[0]
  if (existing === undefined) {
    throw new MailTransportError('INVALID_MESSAGE', 'ENQUEUE_RACE_ROW_VANISHED')
  }
  return { id: existing.id, status: existing.status as EffectStatus, created: false }
}

/** 一条待认领的副作用（pump 读全部所需字段）。 */
export interface ClaimedEffect {
  readonly id: string
  readonly tenant_id: string
  readonly status: EffectStatus
  readonly idempotency_key: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly payload_hash: string | null
  readonly attempt_count: number
  readonly max_attempts: number
  readonly external_id: string | null
  readonly error_code: string | null
  readonly next_attempt_at: string | null
  readonly readback_state: EffectReadbackState | null
  readonly receipt_payload?: Record<string, unknown> | null
  readonly sent_at: string | null
  readonly recipient_ref: string
  readonly subject: string
  readonly body_summary: string
}

interface ClaimRow {
  id: string
  tenant_id: string
  status: string
  idempotency_key: string
  payload: Record<string, unknown>
  payload_hash: string | null
  attempt_count: number
  max_attempts: number
  external_id: string | null
  error_code: string | null
  next_attempt_at: string | null
  readback_state: string | null
  receipt_payload: Record<string, unknown> | null
  sent_at: string | null
}

function asClaimed(row: ClaimRow): ClaimedEffect {
  const payload = row.payload ?? {}
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    status: row.status as EffectStatus,
    idempotency_key: row.idempotency_key,
    payload,
    payload_hash: row.payload_hash,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    external_id: row.external_id,
    error_code: row.error_code,
    next_attempt_at: row.next_attempt_at,
    readback_state: (row.readback_state as EffectReadbackState | null) ?? null,
    receipt_payload: row.receipt_payload ?? null,
    sent_at: row.sent_at,
    recipient_ref: typeof payload.recipient_ref === 'string' ? payload.recipient_ref : '',
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    body_summary: typeof payload.body_summary === 'string' ? payload.body_summary : '',
  }
}

/**
 * 扫"已 SENT 但回执未完"的行供 pump 复查（**不改状态**，SENT 保持 SENT）。
 *
 * 真链回执卡死根因：旧实现只在本 tick 刚 SENT 的行上查一次回执，刚发完的瞬间
 * 邮件还没进 INBOX → null 被当终态 → 之后再也不查。现在每 tick 都扫：
 *   status='SENT' and readback_state in ('NOT_READ','UNREADABLE')
 *   and (next_attempt_at is null or next_attempt_at <= now())
 * 已 CONFIRMED / NOT_FOUND 的行不在扫描范围（终态不重复扫）。
 * 用 FOR UPDATE SKIP LOCKED 保证多实例不重复复查。
 */
export async function listSentForReadback(
  client: DatabaseClient,
  input: { limit?: number },
): Promise<readonly ClaimedEffect[]> {
  const requested = typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? Math.max(1, Math.floor(input.limit))
    : 20
  const limit = Math.min(100, requested)
  const { rows } = await client.query<ClaimRow>(
    `select id, tenant_id, status, idempotency_key, payload, payload_hash,
            attempt_count, max_attempts, external_id, error_code,
            next_attempt_at, readback_state, receipt_payload, sent_at
       from recruitment.durable_effect
      where status = 'SENT'
        and (readback_state is null or readback_state in ('NOT_READ', 'UNREADABLE'))
        and (next_attempt_at is null or next_attempt_at <= now())
      order by sent_at
      limit $1
        for update skip locked`,
    [limit],
  )
  return rows.map(asClaimed)
}

/**
 * 认领待发送/待重试的副作用：PENDING / RETRY_WAIT（且 next_attempt_at 到期）→ CLAIMED。
 * 状态迁移触发 fn_row_guard 自动写审计事件/审计列（本层不手写）。
 * **必须在 withActor 事务内调用**。
 */
export async function claimPendingEffects(
  client: DatabaseClient,
  input: { limit?: number },
): Promise<readonly ClaimedEffect[]> {
  const requested = typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? Math.max(1, Math.floor(input.limit))
    : 20
  const limit = Math.min(100, requested)
  const { rows } = await client.query<ClaimRow>(
    `update recruitment.durable_effect
        set status = 'CLAIMED'
      where id in (
        select id from recruitment.durable_effect
         where status in ('PENDING', 'RETRY_WAIT')
           and (next_attempt_at is null or next_attempt_at <= now())
         order by created_at
         limit $1
         for update skip locked
      )
      returning id, tenant_id, status, idempotency_key, payload, payload_hash,
                attempt_count, max_attempts, external_id, error_code,
                next_attempt_at, readback_state, receipt_payload, sent_at`,
    [limit],
  )
  return rows.map(asClaimed)
}

/** 状态推进 patch（只能往后走；attempt_count 是"设置为该值"，不是 +1）。 */
export interface EffectAdvancePatch {
  readonly status: EffectStatus
  readonly sent_at?: string
  readonly external_id?: string
  readonly next_attempt_at?: string | null
  readonly error_code?: string | null
  readonly attempt_count?: number
  readonly last_readback_at?: string
  readonly readback_state?: EffectReadbackState
  /** 乐观锁：期望的当前 record_version（缺省则不校验版本，只校验来源态）。 */
  readonly expected_record_version?: number
}

/** 每个目标状态允许的来源态（禁止 SENT→PENDING 这类倒退）。 */
const ALLOWED_FROM: Readonly<Record<EffectStatus, readonly EffectStatus[]>> = {
  PENDING: [], // 入队态，advance 不退回到 PENDING
  CLAIMED: ['PENDING', 'RETRY_WAIT'],
  SENT: ['CLAIMED', 'UNKNOWN_OUTCOME'],
  CONFIRMED: ['SENT', 'UNKNOWN_OUTCOME'],
  RETRY_WAIT: ['CLAIMED', 'UNKNOWN_OUTCOME'],
  UNKNOWN_OUTCOME: ['CLAIMED', 'RETRY_WAIT'],
  FAILED_FINAL: ['CLAIMED', 'RETRY_WAIT', 'UNKNOWN_OUTCOME'],
  CANCELLED: ['PENDING', 'CLAIMED', 'RETRY_WAIT', 'UNKNOWN_OUTCOME'],
  COMPENSATION_REQUIRED: ['SENT', 'CONFIRMED', 'FAILED_FINAL', 'UNKNOWN_OUTCOME'],
}

/** 状态推进结果。 */
export interface EffectAdvanceResult {
  readonly id: string
  readonly status: EffectStatus
  readonly record_version: number
}

/**
 * 推进副作用状态。用 `UPDATE ... WHERE id = $1 AND status IN (...) [AND record_version = $N]
 * RETURNING` 保证状态只往后走 + 乐观锁。无行返回 → 抛 kind='INVALID_MESSAGE'
 * （非法转移 / 版本冲突 / effect 不存在）。
 *
 * 不写 status_changed_at / status_changed_by_actor_id / status_source_event_id / record_version
 * —— 全部由 fn_row_guard 触发器自动填。
 */
export async function advanceEffect(
  client: DatabaseClient,
  effectId: string,
  patch: EffectAdvancePatch,
): Promise<EffectAdvanceResult> {
  const from = ALLOWED_FROM[patch.status]
  if (from.length === 0) throw new MailTransportError('INVALID_MESSAGE', 'ILLEGAL_STATUS_TARGET')
  if (patch.status === 'FAILED_FINAL' && (typeof patch.error_code !== 'string' || patch.error_code.trim() === '')) {
    throw new MailTransportError('INVALID_MESSAGE', 'FAILED_FINAL_REQUIRES_ERROR_CODE')
  }
  if (patch.status === 'UNKNOWN_OUTCOME' && patch.last_readback_at !== undefined) {
    // ck_durable_effect_unknown: last_readback_at 必须为 null。
    throw new MailTransportError('INVALID_MESSAGE', 'UNKNOWN_OUTCOME_READBACK_CONFLICT')
  }
  if (patch.attempt_count !== undefined && (!Number.isInteger(patch.attempt_count) || patch.attempt_count < 0)) {
    throw new MailTransportError('INVALID_MESSAGE', 'INVALID_ATTEMPT_COUNT')
  }

  const sets: string[] = ['status = $2']
  const values: unknown[] = [effectId, patch.status]
  function bind(value: unknown, column: string): void {
    values.push(value)
    sets.push(`${column} = $${values.length}`)
  }
  if (patch.sent_at !== undefined) bind(patch.sent_at, 'sent_at')
  if (patch.external_id !== undefined) bind(patch.external_id, 'external_id')
  if (patch.next_attempt_at !== undefined) bind(patch.next_attempt_at, 'next_attempt_at')
  if (patch.error_code !== undefined) bind(patch.error_code, 'error_code')
  if (patch.attempt_count !== undefined) bind(patch.attempt_count, 'attempt_count')
  if (patch.last_readback_at !== undefined) bind(patch.last_readback_at, 'last_readback_at')
  if (patch.readback_state !== undefined) bind(patch.readback_state, 'readback_state')
  if (patch.status === 'CONFIRMED') bind(new Date().toISOString(), 'confirmed_at')

  values.push([...from])
  const statusListParam = `$${values.length}`
  let versionClause = ''
  if (patch.expected_record_version !== undefined && Number.isInteger(patch.expected_record_version)) {
    values.push(patch.expected_record_version)
    versionClause = ` and record_version = $${values.length}`
  }
  const { rows } = await client.query<{ id: string; status: string; record_version: number }>(
    `update recruitment.durable_effect
        set ${sets.join(', ')}
      where id = $1 and status = any(${statusListParam}::text[])${versionClause}
      returning id, status, record_version`,
    values,
  )
  const row = rows[0]
  if (row === undefined) throw new MailTransportError('INVALID_MESSAGE', 'EFFECT_TRANSITION_CONFLICT')
  return { id: row.id, status: row.status as EffectStatus, record_version: row.record_version }
}

// ---------------------------------------------------------------------------
//  模式 B：按范围授权（纯判定，配置放 recruitment.business_config）
// ---------------------------------------------------------------------------

/** business_config 行的最小形状（只读判定用；列来自 0001_init.sql:561-586）。 */
export interface EmailAuthorizationConfigLike {
  readonly id?: string
  readonly scope?: string
  readonly scope_id?: string | null
  readonly config_key?: string
  readonly version_no?: number
  readonly payload: Readonly<Record<string, unknown>>
  readonly effective_from: string | Date
  readonly effective_to?: string | Date | null
  readonly payload_hash?: string
}

/** 授权判定的输入。 */
export interface EmailAuthorizationInput {
  readonly application_id: string
  readonly job_id: string
  readonly recipient_ref: string
  readonly email_class: string
  readonly template_key: string
  readonly now: string | Date
}

/** 授权判定结果。reason 闭集在 resolveEmailAuthorization 文档里列出。 */
export interface EmailAuthorizationDecision {
  readonly allowed: boolean
  readonly authorization_ref: string | null
  readonly authorized_by_actor_id: string | null
  readonly reason: string
}

function asMillis(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

/**
 * 纯判定：按范围授权（模式 B，v1.0 只实现 B）。
 *
 * 规则顺序：
 *   1. email_class === 'OFFER' → 永不自动，reason='OFFER_REQUIRES_HUMAN'；
 *   2. 逐候选（business_config 行）：
 *      - 生效窗：effective_from <= now < effective_to（effective_to 空 = 不封顶）；
 *      - expires_at 必须 > now（缺失 = 不过期）；
 *      - revoked_at 非空 / revoked===true → 不可授；
 *      - authorized_by_actor_id 必须非空；
 *      - email_class / template_key 严格相等；
 *      - scope 命中：job_ids 或 application_ids 集合命中；
 *        recipient_refs 给了则 recipient_ref 必须命中（空集合 = 不匹配）。
 *   3. 命中 → allowed:true + authorization_ref + authorized_by_actor_id；
 *   4. 不命中 → reason 取优先级：
 *      REVOKED > OFFER_REQUIRES_HUMAN(仅 OFFER) > EXPIRED > OUT_OF_SCOPE
 *      > NO_AUTHORIZATION（字段不匹配）> NOTHING_EFFECTIVE（都不在生效窗）。
 *
 * payload 约定字段：authorization_id / authorization_ref / authorized_by_actor_id /
 * email_class / template_key / scope:{job_ids,application_ids,recipient_refs} /
 * expires_at / revoked_at / revoked / confirmation_text。
 * 撤销 = 追加新版本（旧版本不改历史），新版本 payload.revoked=true 或 revoked_at 非空。
 */
export function resolveEmailAuthorization(
  configs: readonly EmailAuthorizationConfigLike[],
  input: EmailAuthorizationInput,
): EmailAuthorizationDecision {
  const deny = (reason: string): EmailAuthorizationDecision => ({
    allowed: false, authorization_ref: null, authorized_by_actor_id: null, reason,
  })
  if (input.email_class === 'OFFER') return deny('OFFER_REQUIRES_HUMAN')
  const nowMs = asMillis(input.now)
  if (nowMs === null) return deny('NOTHING_EFFECTIVE')

  let sawRevoked = false
  let sawExpired = false
  let sawOutOfScope = false
  let sawMismatch = false
  let sawEffectiveCandidate = false

  for (const config of configs) {
    if (config.config_key !== undefined && config.config_key !== 'email.send.authorization') continue
    const fromMs = asMillis(config.effective_from)
    const toMs = asMillis(config.effective_to)
    if (fromMs === null || fromMs > nowMs) continue
    if (toMs !== null && nowMs >= toMs) continue
    sawEffectiveCandidate = true

    const payload = config.payload ?? {}
    const rawExpires = payload.expires_at
    const expiresMs = rawExpires instanceof Date ? rawExpires.getTime()
      : typeof rawExpires === 'string' ? Date.parse(rawExpires) : Number.NaN
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
      sawExpired = true
      continue
    }
    const revoked = payload.revoked === true
      || (typeof payload.revoked_at === 'string' && payload.revoked_at.trim() !== '')
      || (payload.revoked_at instanceof Date)
    if (revoked) {
      sawRevoked = true
      continue
    }
    const actor = typeof payload.authorized_by_actor_id === 'string'
      ? payload.authorized_by_actor_id.trim()
      : ''
    if (actor === '') continue
    if (payload.email_class !== input.email_class || payload.template_key !== input.template_key) {
      sawMismatch = true
      continue
    }
    const scope = (payload.scope !== null && typeof payload.scope === 'object')
      ? payload.scope as Record<string, unknown>
      : {}
    const jobIds = stringArray(scope.job_ids)
    const applicationIds = stringArray(scope.application_ids)
    const recipientRefs = stringArray(scope.recipient_refs)
    const scopeHit = jobIds.includes(input.job_id) || applicationIds.includes(input.application_id)
    if (!scopeHit) {
      sawOutOfScope = true
      continue
    }
    if (recipientRefs.length > 0 && !recipientRefs.includes(input.recipient_ref)) {
      sawOutOfScope = true
      continue
    }
    const ref = typeof payload.authorization_id === 'string' && payload.authorization_id.trim() !== ''
      ? payload.authorization_id
      : typeof payload.authorization_ref === 'string' && payload.authorization_ref.trim() !== ''
        ? payload.authorization_ref
        : config.id !== undefined
          ? config.id
          : `business_config:v${config.version_no ?? 1}`
    return { allowed: true, authorization_ref: ref, authorized_by_actor_id: actor, reason: 'AUTHORIZED' }
  }

  if (sawRevoked) return deny('REVOKED')
  if (sawExpired) return deny('EXPIRED')
  if (sawOutOfScope) return deny('OUT_OF_SCOPE')
  if (sawMismatch) return deny('NO_AUTHORIZATION')
  if (sawEffectiveCandidate) return deny('OUT_OF_SCOPE')
  return deny('NOTHING_EFFECTIVE')
}

// ---------------------------------------------------------------------------
//  授权写入（人点 Host Action：新增配置版本，不改历史）
// ---------------------------------------------------------------------------

/** 授权写入入参（身份由 withActor 事务的 actor 提供，不接受客户端传入）。 */
export interface InsertEmailAuthorizationInput {
  readonly tenant_id: string
  /** 授权人 / 撤销人 actor id（来自 session→alias 身份解析，不是 body）。 */
  readonly actor_id: string
  /** 授权作用域对象（job_ids / application_ids / recipient_refs）。 */
  readonly scope: Readonly<Record<string, unknown>>
  /** 允许发送的电邮类别（闭集由 HTTP 路由校验；OFFER 永不自动）。 */
  readonly email_class: string
  readonly template_key: string
  /** 授权过期时间（ISO 时间字符串，必须 > now，由 HTTP 路由校验）。 */
  readonly expires_at: string
  /** 人的确认原话 sha256；不存原文（R7）。 */
  readonly confirmation_text_sha256: string
  /** 撤销模式：给被撤销的 authorization_id / authorization_ref；不改写历史版本。 */
  readonly revoke?: boolean
  readonly revoke_authorization_id?: string
}

/** 授权写入结果（短号与版本号；完整 UUID / 64hex 不吐给客户端）。 */
export interface InsertEmailAuthorizationResult {
  readonly id: string
  readonly version_no: number
  readonly authorization_id: string
  readonly authorization_ref: string
  readonly created: true
  /** 新版本的生效窗起点（ISO）；= 旧最大版本 effective_to + 1ms（无旧版时 = now）。 */
  readonly effective_from: string
}

const AUTHORIZATION_CONFIG_KEY = 'email.send.authorization'
const AUTHORIZATION_SCOPE = 'ORGANIZATION'

interface MaxVersionRow {
  version_no: number
  effective_to: string | Date | null
}

/**
 * 追加一条 `email.send.authorization` 配置版本（ORGANIZATION / scope_id=null）。
 *
 * 版本约定（**彻底不 UPDATE 任何旧行**）：
 *   1. 读当前租户该 config_key 的 max(version_no) 及其 effective_to；
 *   2. 新版本 = max+1（无旧版则 1）；
 *   3. effective_from = 旧最大版本 effective_to + 1ms（无旧版 / 旧版 effective_to 为空则 now()）。
 *      这样任意时刻至多一个版本生效，resolveEmailAuthorization 遍历顺序无关；
 *   4. 直接 INSERT 新行，绝不 UPDATE 旧行的 payload_hash / effective_to / payload。
 *
 * 撤销 = 同一函数 revoke:true，payload.revoked=true + revoked_at=now()，
 * 被撤授权 id 写进 authorization_id；旧历史版本保持原样。
 *
 * **必须在 withActor(pool, actor, ...) 事务内调用**（created_by_actor_id 外键 + actor GUC）。
 * payload 只存确认原话 sha256（不存原文），payload_hash = digestOf(payload)。
 */
export async function insertEmailAuthorization(
  client: DatabaseClient,
  input: InsertEmailAuthorizationInput,
): Promise<InsertEmailAuthorizationResult> {
  const maxResult = await client.query<MaxVersionRow>(
    `select version_no, effective_to
       from recruitment.business_config
      where tenant_id = $1::uuid and scope = $2 and scope_id is null and config_key = $3
      order by version_no desc
      limit 1`,
    [input.tenant_id, AUTHORIZATION_SCOPE, AUTHORIZATION_CONFIG_KEY],
  )
  const previous = maxResult.rows[0]
  const versionNo = previous === undefined ? 1 : Number(previous.version_no) + 1

  // 生效窗起点：旧版 effective_to + 1ms（不封顶则 now）。这样不 UPDATE 旧行也不会有两版同时生效。
  let effectiveFrom: string
  const previousTo = previous?.effective_to == null ? null : new Date(previous.effective_to).getTime()
  if (previousTo !== null && Number.isFinite(previousTo)) {
    effectiveFrom = new Date(previousTo + 1).toISOString()
  } else {
    effectiveFrom = new Date().toISOString()
  }

  const authorizationId = `auth:${randomUUID()}`
  const issuedAt = new Date().toISOString()
  const payload: Record<string, unknown> = {
    authorization_id: authorizationId,
    authorization_ref: authorizationId,
    authorized_by_actor_id: input.actor_id,
    email_class: input.email_class,
    template_key: input.template_key,
    scope: input.scope,
    expires_at: input.expires_at,
    confirmation_text_sha256: input.confirmation_text_sha256,
    ...(input.revoke === true
      ? {
          revoked: true,
          revoked_at: issuedAt,
          revoked_authorization_id: input.revoke_authorization_id ?? null,
        }
      : {}),
  }
  const payloadHash = digestOf(payload)

  const inserted = await client.query<{ id: string }>(
    `insert into recruitment.business_config
       (tenant_id, scope, scope_id, config_key, version_no, payload, payload_hash,
        effective_from, effective_to, created_by_actor_id)
     values ($1::uuid, $2, null, $3, $4, $5::jsonb, $6, $7::timestamptz, null, $8::uuid)
     returning id::text as id`,
    [
      input.tenant_id, AUTHORIZATION_SCOPE, AUTHORIZATION_CONFIG_KEY, versionNo,
      JSON.stringify(payload), payloadHash, effectiveFrom, input.actor_id,
    ],
  )
  const row = inserted.rows[0]
  if (row === undefined) throw new MailTransportError('INVALID_MESSAGE', 'AUTHORIZATION_INSERT_RACE')

  return {
    id: row.id,
    version_no: versionNo,
    authorization_id: authorizationId,
    authorization_ref: authorizationId,
    created: true,
    effective_from: effectiveFrom,
  }
}
