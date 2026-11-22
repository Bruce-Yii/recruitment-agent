// G-09 候选人自助预约的域规则与 DB 访问层（design/v4/wave3-product-loop-spec.md §1）。
//
// 纪律：
//   1. token 只以 sha256 落库；明文 token 只在 HTTP 成功响应里出现一次，**绝不进日志**；
//   2. 输入严格白名单（未知键拒绝），slots 2..5，均带偏移 ISO-8601，时长与 duration_minutes 一致；
//   3. 公开投影只含岗位标题/轮次/时长/时区/时段/状态，零 UUID、零内部 id、零简历/评估；
//   4. 确认的并发与原子性由调用方单事务承载：这里提供 `FOR UPDATE` 读行 + 条件 UPDATE；
//   5. 本文件不请求人工批准、不直接建池/开事务，全部由 http 层注入 client。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { DatabaseClient } from '../db/pool.ts'
import { isUuidText } from '../db/pool.ts'
import { isValidIanaTimezone } from './timezone.ts'

/** 邀约状态（公开页可展示的封闭集合）。 */
export type BookingInviteStatus = 'OPEN' | 'CONSUMED' | 'EXPIRED'

/** 一个白名单时段（绝对时刻，带偏移 ISO-8601）。 */
export interface BookingSlot {
  readonly start: string
  readonly end: string
}

/** 生成邀约的已校验入参。 */
export interface BookingInviteInput {
  readonly application_id: string
  readonly round_no: number
  readonly duration_minutes: number
  readonly interviewer_actor_ids: readonly string[]
  readonly timezone: string
  readonly slots: readonly BookingSlot[]
  readonly expires_hours: number
}

/** 生成邀约的返回（token 只在这里出现一次）。 */
export interface CreatedBookingInvite {
  readonly invite_id: string
  readonly token: string
  readonly booking_url: string
  readonly expires_at: string
  readonly slots: readonly BookingSlot[]
}

/** DB 行（只含本域用到的列）。 */
export interface BookingInviteRow {
  readonly id: string
  readonly tenant_id: string
  readonly application_id: string
  readonly created_by_actor_id: string
  readonly round_no: number
  readonly duration_minutes: number
  readonly interviewer_actor_ids: readonly string[] | unknown
  readonly timezone: string
  readonly slots: readonly BookingSlot[] | unknown
  readonly token_sha256: string
  readonly status: 'OPEN' | 'CONSUMED'
  readonly expires_at: string | Date
  readonly confirmed_slot_index: number | null
  readonly confirmed_interview_id: string | null
  readonly self_booked: boolean
  /** 仅 DB join 出来的展示字段，公开投影允许出现。 */
  readonly job_title?: string | null
}

/** 同源只读 JSON 的封闭形状（零 UUID）。 */
export interface BookingPublicView {
  readonly status: BookingInviteStatus
  readonly job_title: string
  readonly round_no: number
  readonly duration_minutes: number
  readonly timezone: string
  readonly slots: readonly BookingSlot[]
}

/** 本域的可预期失败（HTTP 层映射成封闭错误信封）。 */
export class BookingDomainError extends Error {
  readonly status: number
  readonly code: string
  readonly reasonCode: string
  readonly detail?: unknown

  constructor(status: number, code: string, reasonCode: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'BookingDomainError'
    this.status = status
    this.code = code
    this.reasonCode = reasonCode
    this.detail = detail
  }
}

const BOOKING_BODY_KEYS = [
  'application_id', 'round_no', 'duration_minutes', 'interviewer_actor_ids',
  'timezone', 'slots', 'expires_hours',
] as const
const BOOKING_BODY_KEY_SET: ReadonlySet<string> = new Set(BOOKING_BODY_KEYS)
const SLOT_KEYS = ['start', 'end'] as const
const SLOT_KEY_SET: ReadonlySet<string> = new Set(SLOT_KEYS)

/** 带偏移 ISO-8601（与 interview-schedule 同口径）。 */
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/** token ≥ 32 字节随机串（base64url，43 字符）。 */
const TOKEN_BYTES = 32
/** 默认有效期 72 小时；可配置范围 1..720 小时。 */
export const DEFAULT_EXPIRES_HOURS = 72
const MIN_EXPIRES_HOURS = 1
const MAX_EXPIRES_HOURS = 720
const HOUR_MS = 3_600_000

function fail(status: number, code: string, reasonCode: string, message: string, detail?: unknown): never {
  throw new BookingDomainError(status, code, reasonCode, message, detail)
}

/** 是普通对象（不是 null / 数组）。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 生成高熵一次性 token：32 字节 CSPRNG → base64url（43 字符，URL 安全）。
 * @returns 明文 token（只用于响应与 URL；调用方绝不打印）。
 */
export function generateBookingToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** token 形状（base64url of 32 bytes = 43 chars）。 */
export function isBookingToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

/** token 的 sha256（库里只存这个，查找也用它）。 */
export function hashBookingToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * 常量时间比较 token 哈希，避免通过查找时间侧信道枚举 token。
 * @param expected - 库中存的 hash。
 * @param actual - 请求 token 现算的 hash。
 */
export function tokenHashEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 预约页 URL（唯一对外暴露的 token 位置）。 */
export function bookingUrl(token: string): string {
  return `/recruitment/book/${token}`
}

/** 默认过期时刻（ISO）。 */
export function defaultExpiresAt(nowMs: number = Date.now(), hours: number = DEFAULT_EXPIRES_HOURS): string {
  return new Date(nowMs + hours * HOUR_MS).toISOString()
}

/** 邀约是否已过期（只按 expires_at 判定，不改库状态）。 */
export function isExpired(row: BookingInviteRow, nowMs: number = Date.now()): boolean {
  return Date.parse(row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at) <= nowMs
}

/** 公开状态：CONSUMED 优先，其次 EXPIRED，最后 OPEN。 */
export function publicStatus(row: BookingInviteRow, nowMs: number = Date.now()): BookingInviteStatus {
  if (row.status === 'CONSUMED') return 'CONSUMED'
  return isExpired(row, nowMs) ? 'EXPIRED' : 'OPEN'
}

/**
 * 校验生成邀约的 body；未知键一律拒绝（fail-closed），不返回任何 user text 之外的派生字段。
 * @param body - HTTP 层解析出的 JSON 对象。
 * @returns 已校验的入参。
 */
export function parseBookingInviteBody(body: unknown): BookingInviteInput {
  if (!isObject(body)) {
    fail(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象')
  }
  const unknown = Object.keys(body).filter((key) => !BOOKING_BODY_KEY_SET.has(key)).sort()
  if (unknown.length > 0) {
    fail(400, 'INVALID_ARGS', 'UNKNOWN_KEY', '请求体含未声明的键', { unknown })
  }

  const applicationId = body.application_id
  if (!isUuidText(applicationId)) {
    fail(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'application_id 必须是 UUID 文本', { path: 'application_id' })
  }

  const roundNo = body.round_no
  if (typeof roundNo !== 'number' || !Number.isInteger(roundNo) || roundNo < 1 || roundNo > 20) {
    fail(400, 'INVALID_ARGS', 'ROUND_OUT_OF_RANGE', 'round_no 必须是 1..20 的整数', { path: 'round_no' })
  }

  const duration = body.duration_minutes
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 15 || duration > 480) {
    fail(400, 'INVALID_ARGS', 'DURATION_OUT_OF_RANGE', 'duration_minutes 必须是 15..480 的整数', { path: 'duration_minutes' })
  }

  const actorIds = body.interviewer_actor_ids
  if (!Array.isArray(actorIds) || actorIds.length < 1 || actorIds.length > 10
      || actorIds.some((id) => !isUuidText(id))) {
    fail(400, 'INVALID_ARGS', 'INTERVIEWER_IDS_INVALID', 'interviewer_actor_ids 必须是 1..10 个 UUID 字符串', {
      path: 'interviewer_actor_ids',
    })
  }
  if (new Set(actorIds).size !== actorIds.length) {
    fail(400, 'INVALID_ARGS', 'DUPLICATE_INTERVIEWER', 'interviewer_actor_ids 不得重复')
  }

  const timezone = body.timezone
  if (typeof timezone !== 'string' || timezone.length > 64 || !isValidIanaTimezone(timezone)) {
    fail(400, 'INVALID_ARGS', 'INVALID_TIMEZONE', 'timezone 必须是合法 IANA 时区名', { path: 'timezone' })
  }

  const expiresHours = body.expires_hours ?? DEFAULT_EXPIRES_HOURS
  if (typeof expiresHours !== 'number' || !Number.isInteger(expiresHours)
      || expiresHours < MIN_EXPIRES_HOURS || expiresHours > MAX_EXPIRES_HOURS) {
    fail(400, 'INVALID_ARGS', 'EXPIRES_HOURS_OUT_OF_RANGE',
      `expires_hours 必须是 ${MIN_EXPIRES_HOURS}..${MAX_EXPIRES_HOURS} 的整数`, { path: 'expires_hours' })
  }

  const rawSlots = body.slots
  if (!Array.isArray(rawSlots) || rawSlots.length < 2 || rawSlots.length > 5) {
    fail(400, 'INVALID_ARGS', 'SLOTS_OUT_OF_RANGE', 'slots 必须含 2..5 个时段', { path: 'slots' })
  }
  const slots: BookingSlot[] = rawSlots.map((raw, index) => {
    if (!isObject(raw)) {
      fail(400, 'INVALID_ARGS', 'SLOT_TYPE_MISMATCH', `slots[${index}] 必须是对象`)
    }
    const unknownSlotKeys = Object.keys(raw).filter((key) => !SLOT_KEY_SET.has(key)).sort()
    if (unknownSlotKeys.length > 0) {
      fail(400, 'INVALID_ARGS', 'SLOT_UNKNOWN_KEY', `slots[${index}] 含未声明的键`, { unknown: unknownSlotKeys })
    }
    const start = raw.start
    const end = raw.end
    if (typeof start !== 'string' || !ISO_WITH_OFFSET_RE.test(start) || !Number.isFinite(Date.parse(start))) {
      fail(400, 'INVALID_ARGS', 'SLOT_START_INVALID', `slots[${index}].start 必须是带偏移的 ISO-8601 时刻`)
    }
    if (typeof end !== 'string' || !ISO_WITH_OFFSET_RE.test(end) || !Number.isFinite(Date.parse(end))) {
      fail(400, 'INVALID_ARGS', 'SLOT_END_INVALID', `slots[${index}].end 必须是带偏移的 ISO-8601 时刻`)
    }
    if (Date.parse(end) - Date.parse(start) !== duration * 60_000) {
      fail(400, 'INVALID_ARGS', 'SLOT_DURATION_MISMATCH',
        `slots[${index}] 时长与 duration_minutes 不一致`, { path: `slots[${index}]` })
    }
    return { start, end }
  })
  const sorted = [...slots].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && Date.parse(sorted[i - 1]!.start) >= Date.parse(sorted[i]!.start)) {
      fail(400, 'INVALID_ARGS', 'DUPLICATE_SLOT', 'slots 时段不得重复')
    }
  }

  return {
    application_id: applicationId as string,
    round_no: roundNo,
    duration_minutes: duration,
    interviewer_actor_ids: actorIds as string[],
    timezone,
    slots,
    expires_hours: expiresHours,
  }
}

/** 解析公开确认 body（只接受 `{slot_index}` 整数字段）。 */
export function parseConfirmBody(body: unknown): number {
  if (!isObject(body)) fail(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象')
  const unknown = Object.keys(body).filter((key) => key !== 'slot_index').sort()
  if (unknown.length > 0) fail(400, 'INVALID_ARGS', 'UNKNOWN_KEY', '请求体含未声明的键', { unknown })
  const index = body.slot_index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 4) {
    fail(400, 'INVALID_ARGS', 'SLOT_INDEX_INVALID', 'slot_index 必须是 0..4 的整数', { path: 'slot_index' })
  }
  return index
}

/**
 * 校验 slot_index 严格属于该邀约白名单（按 DB 保存的数组顺序）。
 * 防篡改：只比对完整 `{start,end}` 是否在白名单；越界/非白名单 → 400 SLOT_NOT_ALLOWED。
 */
export function requireWhitelistedSlot(row: BookingInviteRow, index: number): BookingSlot {
  const slots = normalizeSlots(row.slots)
  const slot = slots[index]
  if (slot === undefined) {
    fail(400, 'SLOT_NOT_ALLOWED', 'SLOT_NOT_ALLOWED', '所选时段不属于本次邀约', {
      slot_index: index, allowed_count: slots.length,
    })
  }
  return slot
}

/** DB jsonb → BookingSlot[]（形状由写侧约束 + 迁移 CHECK 保证，这里仍做防御性校验）。 */
export function normalizeSlots(value: unknown): readonly BookingSlot[] {
  if (!Array.isArray(value)) return []
  const out: BookingSlot[] = []
  for (const item of value) {
    if (isObject(item) && typeof item.start === 'string' && typeof item.end === 'string') {
      out.push({ start: item.start, end: item.end })
    }
  }
  return out
}

/** DB jsonb → 面试官 actor id 列表。 */
export function normalizeInterviewerIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string')
}

/** 公开只读投影：**零 UUID / 零内部 id / 零 token**。 */
export function publicBookingView(row: BookingInviteRow, nowMs: number = Date.now()): BookingPublicView {
  return {
    status: publicStatus(row, nowMs),
    job_title: typeof row.job_title === 'string' && row.job_title !== '' ? row.job_title : '招聘岗位',
    round_no: row.round_no,
    duration_minutes: row.duration_minutes,
    timezone: row.timezone,
    slots: normalizeSlots(row.slots).map((slot) => ({ start: slot.start, end: slot.end })),
  }
}

/** 把任意文本转义成 HTML 文本节点（XSS 红线：公开页所有用户文本都走这里）。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 时段在公开页上的可读标签（IANA 时区名 + 带偏移时间，均经过 HTML 转义）。 */
export function slotLabel(slot: BookingSlot, timezone: string): string {
  return `${escapeHtml(timezone)} · ${escapeHtml(slot.start)} → ${escapeHtml(slot.end)}`
}

/** 状态中文文案（只给公开页用，与公开状态枚举一一对应）。 */
export function statusLabel(status: BookingInviteStatus): string {
  if (status === 'OPEN') return '待确认'
  if (status === 'CONSUMED') return '已确认'
  return '已失效'
}

// ---------------------------------------------------------------------------
//  DB 访问（自己不开事务；全部在调用方的 client 里执行）
// ---------------------------------------------------------------------------

const INVITE_SELECT_COLUMNS = `
  select i.id::text                  as id,
  i.tenant_id::text                  as tenant_id,
  i.application_id::text             as application_id,
  i.created_by_actor_id::text        as created_by_actor_id,
  i.round_no                         as round_no,
  i.duration_minutes                 as duration_minutes,
  i.interviewer_actor_ids            as interviewer_actor_ids,
  i.timezone                         as timezone,
  i.slots                            as slots,
  i.token_sha256                     as token_sha256,
  i.booking_state                    as status,
  i.expires_at                       as expires_at,
  i.confirmed_slot_index             as confirmed_slot_index,
  i.confirmed_interview_id::text     as confirmed_interview_id,
  i.self_booked                      as self_booked,
  (select j.title from recruitment.job j
    where j.id = a.job_id and j.tenant_id = i.tenant_id) as job_title
  from recruitment.booking_invite i
  join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
`

/** 只读按 token hash 取邀约（无行 → undefined；不打印 token）。 */
export async function loadInviteByToken(
  client: DatabaseClient,
  tenantId: string,
  tokenHash: string,
): Promise<BookingInviteRow | undefined> {
  const { rows } = await client.query<BookingInviteRow>(
    `${INVITE_SELECT_COLUMNS} where i.tenant_id = $1 and i.token_sha256 = $2`,
    [tenantId, tokenHash],
  )
  return rows[0]
}

/**
 * 确认事务里按 token hash 取邀约并锁行（FOR UPDATE）。
 * 必须与 OPEN→CONSUMED 的 UPDATE 在同一个事务里调用，防并发双确认。
 */
export async function lockInviteByToken(
  client: DatabaseClient,
  tenantId: string,
  tokenHash: string,
): Promise<BookingInviteRow | undefined> {
  const { rows } = await client.query<BookingInviteRow>(
    `${INVITE_SELECT_COLUMNS} where i.tenant_id = $1 and i.token_sha256 = $2 for update of i`,
    [tenantId, tokenHash],
  )
  return rows[0]
}

/** 插入一条 OPEN 邀约；返回 id（token 明文不进 DB）。 */
export async function insertInvite(client: DatabaseClient, input: {
  readonly tenant_id: string
  readonly application_id: string
  readonly created_by_actor_id: string
  readonly round_no: number
  readonly duration_minutes: number
  readonly interviewer_actor_ids: readonly string[]
  readonly timezone: string
  readonly slots: readonly BookingSlot[]
  readonly token_sha256: string
  readonly expires_at: string
}): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.booking_invite
       (tenant_id, application_id, created_by_actor_id, round_no, duration_minutes,
        interviewer_actor_ids, timezone, slots, token_sha256, expires_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10)
     returning id::text as id`,
    [
      input.tenant_id, input.application_id, input.created_by_actor_id,
      input.round_no, input.duration_minutes,
      JSON.stringify([...input.interviewer_actor_ids]), input.timezone,
      JSON.stringify(input.slots), input.token_sha256, input.expires_at,
    ],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('insertInvite: no id returned')
  return id
}

/**
 * 单事务里的 OPEN → CONSUMED 条件更新（乐观锁：只有仍为 OPEN 才写）。
 * 0 行 = 已被并发确认 → 409 BOOKING_ALREADY_CONFIRMED。
 */
export async function consumeInvite(client: DatabaseClient, input: {
  readonly tenant_id: string
  readonly invite_id: string
  readonly slot_index: number
  readonly interview_id: string
}): Promise<boolean> {
  const { rowCount } = await client.query(
    `update recruitment.booking_invite
        set booking_state = 'CONSUMED', confirmed_slot_index = $3, confirmed_interview_id = $4,
            updated_at = now(), self_booked = true
      where tenant_id = $1 and id = $2 and booking_state = 'OPEN'`,
    [input.tenant_id, input.invite_id, input.slot_index, input.interview_id],
  )
  return (rowCount ?? 0) === 1
}
