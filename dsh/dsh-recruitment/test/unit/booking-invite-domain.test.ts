// G-09 自助预约域规则单测（token 高熵/过期/白名单/公开投影/HTML 转义）。
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  BookingDomainError,
  DEFAULT_EXPIRES_HOURS,
  bookingUrl,
  defaultExpiresAt,
  escapeHtml,
  generateBookingToken,
  hashBookingToken,
  isExpired,
  isBookingToken,
  parseBookingInviteBody,
  parseConfirmBody,
  publicBookingView,
  publicStatus,
  requireWhitelistedSlot,
  slotLabel,
  statusLabel,
  tokenHashEquals,
  type BookingInviteRow,
} from '../../src/domain/booking-invite.ts'
import { renderBookingHtml } from '../../src/http/booking-invite.ts'

const APP = '22222222-2222-4222-8222-222222222222'
const IO1 = '33333333-3333-4333-8333-333333333333'
const IO2 = '44444444-4444-4444-8444-444444444444'

function row(overrides: Partial<BookingInviteRow> = {}): BookingInviteRow {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    application_id: APP,
    created_by_actor_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    round_no: 2,
    duration_minutes: 45,
    interviewer_actor_ids: [IO1, IO2],
    timezone: 'Asia/Shanghai',
    slots: [
      { start: '2026-12-01T10:00:00+08:00', end: '2026-12-01T10:45:00+08:00' },
      { start: '2026-12-01T14:00:00+08:00', end: '2026-12-01T14:45:00+08:00' },
      { start: '2026-12-02T09:00:00+08:00', end: '2026-12-02T09:45:00+08:00' },
    ],
    token_sha256: hashBookingToken('x'.repeat(43)),
    status: 'OPEN',
    expires_at: new Date(Date.parse('2026-12-01T00:00:00Z') + 72 * 3_600_000).toISOString(),
    confirmed_slot_index: null,
    confirmed_interview_id: null,
    self_booked: true,
    job_title: '后端工程师',
    ...overrides,
  }
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    application_id: APP,
    round_no: 2,
    duration_minutes: 45,
    interviewer_actor_ids: [IO1, IO2],
    timezone: 'Asia/Shanghai',
    slots: [
      { start: '2026-12-01T10:00:00+08:00', end: '2026-12-01T10:45:00+08:00' },
      { start: '2026-12-01T14:00:00+08:00', end: '2026-12-01T14:45:00+08:00' },
    ],
    ...overrides,
  }
}

function rejects(fn: () => unknown, reason: string): void {
  assert.throws(fn, (error: unknown) => error instanceof BookingDomainError, reason)
}

describe('G-09 · token 与有效期', () => {
  test('token ≥ 32 字节 CSPRNG，base64url，URL 安全，每次不同', () => {
    const a = generateBookingToken()
    const b = generateBookingToken()
    assert.equal(a.length, 43)
    assert.equal(Buffer.from(a, 'base64url').length, 32)
    assert.ok(isBookingToken(a))
    assert.notEqual(a, b)
    assert.equal(bookingUrl(a), `/recruitment/book/${a}`)
  })

  test('token hash 稳定且与 token 不同；常量时间比较', () => {
    const token = generateBookingToken()
    const h = hashBookingToken(token)
    assert.match(h, /^[0-9a-f]{64}$/)
    assert.notEqual(h, token)
    assert.equal(hashBookingToken(token), h)
    assert.ok(tokenHashEquals(h, h))
    assert.ok(!tokenHashEquals(h, hashBookingToken(generateBookingToken())))
  })

  test('默认 72 小时过期；expires_hours 形状与范围受控', () => {
    const now = Date.parse('2026-11-23T00:00:00Z')
    assert.equal(defaultExpiresAt(now), new Date(now + DEFAULT_EXPIRES_HOURS * 3_600_000).toISOString())
    assert.equal(DEFAULT_EXPIRES_HOURS, 72)
    assert.ok(parseBookingInviteBody(body({ expires_hours: 24 })).expires_hours === 24)
    rejects(() => parseBookingInviteBody(body({ expires_hours: 0 })), 'expires_hours 下界')
    rejects(() => parseBookingInviteBody(body({ expires_hours: 721 })), 'expires_hours 上界')
    rejects(() => parseBookingInviteBody(body({ expires_hours: '72' })), 'expires_hours 类型')
  })

  test('过期/已确认状态判定诚实', () => {
    const at = Date.parse('2026-12-01T00:00:00Z')
    assert.ok(!isExpired(row(), at))
    assert.ok(isExpired(row({ expires_at: new Date(at - 1).toISOString() }), at))
    assert.equal(publicStatus(row({ status: 'CONSUMED' }), at), 'CONSUMED')
    assert.equal(publicStatus(row({ expires_at: new Date(at - 1).toISOString() }), at), 'EXPIRED')
  })
})

describe('G-09 · 邀约 body 白名单', () => {
  test('合法 body 通过；未知键/非 UUID/坏时区拒绝', () => {
    const parsed = parseBookingInviteBody(body())
    assert.equal(parsed.slots.length, 2)
    assert.equal(parsed.round_no, 2)
    rejects(() => parseBookingInviteBody(body({ actor_id: 'x' })), '身份覆盖键')
    rejects(() => parseBookingInviteBody(body({ application_id: 'not-uuid' })), 'application_id 形状')
    rejects(() => parseBookingInviteBody(body({ timezone: 'UTC+5' })), '伪时区')
    rejects(() => parseBookingInviteBody(body({ timezone: 'Not/AZone' })), '非法时区')
  })

  test('slots 2..5、时长一致、无重复、带偏移', () => {
    rejects(() => parseBookingInviteBody(body({ slots: [body().slots[0]] })), '槽位太少')
    rejects(() => parseBookingInviteBody(body({ slots: [1, 2, 3, 4, 5, 6] })), '槽位太多')
    rejects(() => parseBookingInviteBody(body({
      slots: [{ start: '2026-12-01T10:00:00+08:00', end: '2026-12-01T11:00:00+08:00' }, body().slots[1]],
    })), '时长与 duration 不一致')
    rejects(() => parseBookingInviteBody(body({
      slots: [{ start: '2026-12-01 10:00:00', end: '2026-12-01T10:45:00+08:00' }, body().slots[1]],
    })), '无偏移时间')
    rejects(() => parseBookingInviteBody(body({
      slots: [body().slots[0], body().slots[0]],
    })), '重复槽位')
  })

  test('确认 body 与白名单槽位严格校验', () => {
    assert.equal(parseConfirmBody({ slot_index: 1 }), 1)
    rejects(() => parseConfirmBody({ slot_index: -1 }), '负索引')
    rejects(() => parseConfirmBody({ slot_index: 1, interview_id: 'x' }), '额外键')
    const r = row()
    assert.deepEqual(requireWhitelistedSlot(r, 1), r.slots[1])
    rejects(() => requireWhitelistedSlot(r, 99), '越界索引')
    rejects(() => requireWhitelistedSlot(r, 3), '越界索引')
  })
})

describe('G-09 · 公开面零敏感信息', () => {
  test('公开 JSON 只含允许字段，零 UUID / token', () => {
    const view = publicBookingView(row(), Date.parse('2026-11-23T00:00:00Z'))
    const text = JSON.stringify(view)
    assert.deepEqual(Object.keys(view).sort(),
      ['duration_minutes', 'job_title', 'round_no', 'slots', 'status', 'timezone'])
    assert.ok(text.includes('后端工程师'))
    assert.ok(!text.includes(APP))
    assert.ok(!text.includes('aaaaaaaa-aaaa'))
    assert.ok(!text.includes('token'))
    assert.ok(!text.includes('简历'))
    assert.ok(!text.includes('评估'))
  })

  test('HTML 温暖纸单列最大 520px，仅展示白名单文本与确认按钮', () => {
    const view = publicBookingView(row(), Date.parse('2026-11-23T00:00:00Z'))
    const page = renderBookingHtml(view, 'A'.repeat(43))
    assert.match(page, /#F9F8F5/)
    assert.match(page, /#FFFFFF/)
    assert.match(page, /max-width:520px/)
    assert.match(page, /后端工程师/)
    assert.match(page, /确认此时段/)
    assert.ok(!page.includes(APP))
    assert.ok(!page.includes('aaaaaaaa-aaaa'))
    assert.ok(!page.includes('简历'))
    assert.ok(!page.includes('评估'))
    const consumed = renderBookingHtml(publicBookingView(row({ status: 'CONSUMED' })), 'A'.repeat(43))
    assert.ok(!consumed.includes('确认此时段'))
    assert.match(consumed, /已确认/)
    assert.equal(statusLabel('EXPIRED'), '已失效')
  })

  test('所有用户文本 HTML 转义（XSS 红线）', () => {
    const evil = '<script>alert("x")</script>&\''
    assert.equal(escapeHtml(evil),
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;')
    const page = renderBookingHtml(publicBookingView(row({ job_title: evil })), 'A'.repeat(43))
    assert.ok(!page.includes('<script>alert'))
    assert.ok(page.includes('&lt;script&gt;'))
    assert.ok(slotLabel({ start: '<b>', end: '</b>' }, 'Asia/Shanghai').startsWith('Asia/Shanghai · &lt;b&gt;'))
  })
})
