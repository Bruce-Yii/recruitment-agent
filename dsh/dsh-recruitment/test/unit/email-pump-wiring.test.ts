// email pump 接线 / 回执语义的**无真库、无真网络**单元测试。
//
// 覆盖：
//   1. dispose() 后 tick() 不再 claim（spy 调用 0 次）；
//   2. 两实例并发 tick（同一假 claim 用内存 Set 模拟 `for update skip locked`）→ 只有一方发送；
//   3. 组合键回执：服务端改写 Message-ID（SMTP id ≠ 收件箱 id）仍 MATCH，
//      matched_message_id 为收件箱 id，receipt_payload 写清 method；
//   4. 完全找不到且预算耗尽 → NOT_FOUND（只写回执列，状态保持 SENT，不 CONFIRMED）；
//   5. readback 抛异常 → UNREADABLE（不是 CONFIRMED）；
//   6. 时间窗/主题/收件人严格校验（组合键不是摆设）；
//   7. 常量 EMAIL_PUMP_INTERVAL_MS === 2000、READBACK_TIME_WINDOW_MS === 10 分钟；
//   8. 组合默认防线：不注入 io.claim、只注入 io.withWrite → 默认 claimFn 必须收到
//      withWrite 给的 client（不是 undefined），tick 不抛（真链发信卡死根因）。
//
// 纪律：所有 IO 走 io seam 注入；不连真 PG、不连真 SMTP/IMAP。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createEmailPump,
  EMAIL_PUMP_INTERVAL_MS,
  READBACK_TIME_WINDOW_MS,
  type EmailPumpDeps,
  type PumpIo,
  type PumpTickResult,
  type ReadbackMark,
  type ReadbackQuery,
  type SendFunction,
} from '../../src/runtime/email-pump.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'
import type { EffectAdvancePatch } from '../../src/connectors/mail/durable-effect.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const EFFECT_ID = 'eeeeeeee-1111-4111-8111-000000000001'
const SMTP_MESSAGE_ID = '<1795010723134210@smtp.example.test>'
const INBOX_MESSAGE_ID = '<tencent_8E55BC4C7777A1B2@qq.com>'
const NOW = '2026-01-01T00:00:00.000Z'

const FAKE_DB: ResolvedDatabaseConfig = {
  host: '127.0.0.1', port: 1, user: 'nobody', database: 'no_such_db_email_unit',
  password: 'not-a-real-password', password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT, actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 1000, connect_timeout_ms: 200, max: 1,
}
const FAKE_MAIL = {
  host: '127.0.0.1', port: 1, user: 'nobody', password_env: 'RECRUITMENT_MAIL_PASSWORD',
  tls: false, folder: 'INBOX', allowed_roots: [], password: 'not-a-real-password',
  since_days: 7, since_uid: 0,
} as unknown as MailConfig

interface ClaimRow {
  id: string
  status: string
  payload: Record<string, unknown>
  attempt_count: number
  max_attempts: number
  external_id: string | null
  sent_at: string | null
}

function sentRow(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: EFFECT_ID, status: 'SENT',
    payload: { to: 'candidate@example.invalid', subject: '面试邀请', text: '正文', body_summary: '正文' },
    attempt_count: 0, max_attempts: 5,
    external_id: SMTP_MESSAGE_ID, sent_at: NOW,
    ...overrides,
  }
}

interface Harness {
  pump: ReturnType<typeof createEmailPump>
  patches: EffectAdvancePatch[]
  marks: { effectId: string; mark: ReadbackMark }[]
  queries: ReadbackQuery[]
  claimCalls: () => number
  sendCalls: () => number
}

function makeHarness(opts: {
  rows?: ClaimRow[]
  transport?: SendFunction
  readback?: EmailPumpDeps['readback']
  readbackMaxAttempts?: number
  readbackTimeWindowMs?: number
  sharedClaim?: () => Promise<readonly ClaimRow[]>
} = {}): Harness {
  const patches: EffectAdvancePatch[] = []
  const marks: { effectId: string; mark: ReadbackMark }[] = []
  const queries: ReadbackQuery[] = []
  let claimCalls = 0
  let sendCalls = 0
  const rows = opts.rows ?? [sentRow()]
  const io: PumpIo = {
    claim: opts.sharedClaim ?? (async () => { claimCalls += 1; return rows as never }),
    listForReadback: async () => [],
    withWrite: async (fn) => fn(undefined),
    advance: async (_client, id, patch) => {
      patches.push({ ...patch })
      return { id, status: patch.status, record_version: 2 }
    },
    markReadback: async (client, effectId, mark) => {
      marks.push({ effectId, mark: { ...mark } })
    },
  }
  const transport: SendFunction = opts.transport ?? (async () => { sendCalls += 1; return { messageId: SMTP_MESSAGE_ID } })
  const pump = createEmailPump({
    database: FAKE_DB, mail: FAKE_MAIL,
    transport,
    readback: opts.readback ?? null,
    readbackMaxAttempts: opts.readbackMaxAttempts,
    readbackTimeWindowMs: opts.readbackTimeWindowMs,
    io,
    now: () => new Date(NOW),
    sleep: async () => {},
  })
  return {
    pump, patches, marks, queries,
    claimCalls: () => claimCalls,
    sendCalls: () => sendCalls,
  }
}

// ---------------------------------------------------------------------------

test('常量：EMAIL_PUMP_INTERVAL_MS === 2000，导出 === 2000，窗口 === 10 分钟', () => {
  assert.equal(EMAIL_PUMP_INTERVAL_MS, 2000)
  assert.equal(READBACK_TIME_WINDOW_MS, 10 * 60 * 1000)
})

test('dispose() 后 tick() 不再 claim（spy claim 调用 0 次）', async () => {
  let claims = 0
  const pump = createEmailPump({
    database: FAKE_DB, mail: FAKE_MAIL,
    transport: async () => ({ messageId: SMTP_MESSAGE_ID }),
    io: { claim: async () => { claims += 1; return [] }, withWrite: async (fn) => fn(undefined) },
  })
  const first = await pump.tick()
  assert.equal(claims, 1, 'dispose 前 claim 一次')
  assert.equal(first.claimed, 0)
  pump.dispose()
  const after = await pump.tick()
  assert.equal(claims, 1, 'dispose 后不再 claim')
  assert.deepEqual(after, {
    claimed: 0, sent: 0, retry: 0, unknown: 0, failed: 0,
    readback_checked: 0, confirmed: 0, not_found: 0, unreadable: 0,
  })
})

test('两实例并发 tick（同一假 claim 用内存 Set 模拟 FOR UPDATE SKIP LOCKED）→ 只有一方 send', async () => {
  const claimed = new Set<string>()
  const sharedClaim = async (): Promise<readonly ClaimRow[]> => {
    const row = sentRow({ status: 'CLAIMED', external_id: null, sent_at: null })
    if (claimed.has(row.id)) return []
    claimed.add(row.id)
    return [row]
  }
  let sends = 0
  const transport: SendFunction = async () => { sends += 1; return { messageId: SMTP_MESSAGE_ID } }
  const io = {
    claim: sharedClaim,
    withWrite: async <T,>(fn: (client: unknown) => Promise<T>): Promise<T> => fn(undefined),
    advance: async (_client: unknown, id: string, patch: EffectAdvancePatch) => ({ id, status: patch.status, record_version: 2 }),
  }
  const a = createEmailPump({ database: FAKE_DB, mail: FAKE_MAIL, transport, io })
  const b = createEmailPump({ database: FAKE_DB, mail: FAKE_MAIL, transport, io })
  const [ra, rb] = await Promise.all([a.tick(), b.tick()])
  assert.equal(ra.claimed + rb.claimed, 1, '两次 claim 总共只认领 1 行')
  assert.equal(sends, 1, '同一 effectId 只发送一次')
  assert.equal(ra.sent + rb.sent, 1)
})

test('组合键回执：服务端改写 Message-ID → 仍 MATCH，matched_message_id 是收件箱 id', async () => {
  const patches: EffectAdvancePatch[] = []
  const marks: { effectId: string; mark: ReadbackMark }[] = []
  const queries: ReadbackQuery[] = []
  const pump = createEmailPump({
    database: FAKE_DB, mail: FAKE_MAIL,
    // 刚 SENT 的行：本 tick 发送成功，external_id = SMTP 侧 id。
    transport: async () => ({ messageId: SMTP_MESSAGE_ID }),
    readback: async (query) => {
      queries.push(query)
      assert.equal(query.external_id, SMTP_MESSAGE_ID, 'external_id 仍是 SMTP 侧 id')
      assert.equal(query.subject, '面试邀请')
      assert.equal(query.to, 'candidate@example.invalid')
      assert.equal(query.time_window_ms, READBACK_TIME_WINDOW_MS)
      assert.ok(Math.abs(Date.parse(query.sent_at) - Date.parse(NOW)) < 1000)
      return {
        matched: true,
        matched_message_id: INBOX_MESSAGE_ID,
        method: 'subject+recipient+time_window',
      }
    },
    io: {
      claim: async () => [sentRow({ status: 'CLAIMED', external_id: null, sent_at: null })] as never,
      withWrite: async (fn) => fn(undefined),
      advance: async (_client, id, patch) => {
        patches.push({ ...patch })
        return { id, status: patch.status, record_version: 2 }
      },
      markReadback: async (_client, id, mark) => { marks.push({ effectId: id, mark }) },
    },
    now: () => new Date(NOW),
  })
  const r = await pump.tick()
  assert.equal(r.sent, 1)
  assert.equal(r.confirmed, 1)
  assert.equal(r.not_found, 0)
  const confirmed = patches.find((p) => p.status === 'CONFIRMED')
  assert.equal(confirmed?.readback_state, 'MATCH')
  const mark = marks.find((m) => m.mark.readback_state === 'MATCH')
  assert.ok(mark, '命中时必须写回执列')
  const payload = mark?.mark.receipt_payload as Record<string, unknown>
  assert.equal(payload.method, 'subject+recipient+time_window')
  assert.equal(payload.matched_message_id, INBOX_MESSAGE_ID, '写的是收件箱 id，不是 SMTP id')
  assert.equal(payload.smtp_message_id, SMTP_MESSAGE_ID, 'SMTP id 如实标注')
  assert.equal(payload.outcome, 'MATCH')
  assert.notEqual(payload.matched_message_id, payload.smtp_message_id, '真机改写场景：两 id 必须不同')
})

test('完全找不到且预算耗尽 → NOT_FOUND，状态保持 SENT，不 CONFIRMED', async () => {
  const patches: EffectAdvancePatch[] = []
  const marks: { effectId: string; mark: ReadbackMark }[] = []
  let reads = 0
  const pump = createEmailPump({
    database: FAKE_DB, mail: FAKE_MAIL,
    transport: async () => ({ messageId: SMTP_MESSAGE_ID }),
    readback: async () => { reads += 1; return null },
    readbackMaxAttempts: 3,
    io: {
      claim: async () => [sentRow()] as never,
      listForReadback: async () => [],
      withWrite: async (fn) => fn(undefined),
      advance: async (_client, id, patch) => {
        patches.push({ ...patch })
        return { id, status: patch.status, record_version: 2 }
      },
      markReadback: async (_client, id, mark) => { marks.push({ effectId: id, mark }) },
    },
    now: () => new Date(NOW),
  })
  const r1 = await pump.tick()
  assert.equal(r1.readback_checked, 1)
  assert.equal(r1.not_found, 0, '第 1 次读不到还不报 NOT_FOUND')
  // 新语义：未命中也写 NOT_READ + next_attempt_at（排重试），不是"不写回执列"。
  assert.equal(marks.length, 1)
  assert.equal(marks[0]!.mark.readback_state, 'NOT_READ')
  assert.equal(typeof marks[0]!.mark.next_attempt_at, 'string')
  const r2 = await pump.tick()
  assert.equal(r2.not_found, 0)
  const r3 = await pump.tick()
  assert.equal(r3.not_found, 1, '第 3 次（预算上限）报 NOT_FOUND')
  assert.equal(reads, 3)
  assert.equal(marks.at(-1)!.mark.readback_state, 'NOT_FOUND')
  assert.equal(marks.at(-1)!.mark.next_attempt_at, null)
  const terminal = marks.at(-1)!.mark
  assert.equal(terminal.readback_state, 'NOT_FOUND')
  assert.equal((terminal.receipt_payload as Record<string, unknown>).outcome, 'NOT_FOUND')
  assert.equal((terminal.receipt_payload as Record<string, unknown>).attempts, 3)
  assert.equal(patches.some((p) => p.status === 'CONFIRMED'), false, '绝不 CONFIRMED')
  assert.ok(!('status' in terminal), 'markReadback 不含 status 字段（状态保持 SENT）')
})

test('readback 抛异常 → UNREADABLE（立即报，不是 CONFIRMED）', async () => {
  const patches: EffectAdvancePatch[] = []
  const marks: { effectId: string; mark: ReadbackMark }[] = []
  const pump = createEmailPump({
    database: FAKE_DB, mail: FAKE_MAIL,
    transport: async () => ({ messageId: SMTP_MESSAGE_ID }),
    readback: async () => { throw new Error('IMAP DOWN') },
    io: {
      claim: async () => [sentRow()] as never,
      withWrite: async (fn) => fn(undefined),
      advance: async (_client, id, patch) => {
        patches.push({ ...patch })
        return { id, status: patch.status, record_version: 2 }
      },
      markReadback: async (_client, id, mark) => { marks.push({ effectId: id, mark }) },
    },
    now: () => new Date(NOW),
  })
  const r = await pump.tick()
  assert.equal(r.unreadable, 1)
  assert.equal(r.confirmed, 0)
  assert.equal(r.not_found, 0)
  assert.equal(marks.length, 1)
  assert.equal(marks[0]?.mark.readback_state, 'UNREADABLE')
  assert.equal((marks[0]?.mark.receipt_payload as Record<string, unknown>).outcome, 'UNREADABLE')
  assert.equal(patches.some((p) => p.status === 'CONFIRMED'), false)
})

test('matched:false（读到但不匹配）也只累计预算，不写 MATCH', async () => {
  const marks: { effectId: string; mark: ReadbackMark }[] = []
  const pump = createEmailPump({
    database: FAKE_DB, mail: FAKE_MAIL,
    transport: async () => ({ messageId: SMTP_MESSAGE_ID }),
    readback: async () => ({ matched: false }),
    readbackMaxAttempts: 1,
    io: {
      claim: async () => [sentRow()] as never,
      withWrite: async (fn) => fn(undefined),
      markReadback: async (_client, id, mark) => { marks.push({ effectId: id, mark }) },
    },
    now: () => new Date(NOW),
  })
  const r = await pump.tick()
  assert.equal(r.confirmed, 0)
  assert.equal(r.not_found, 1)
  assert.equal(marks[0]?.mark.readback_state, 'NOT_FOUND', '读到但不匹配 → NOT_FOUND，不写 MISMATCH')
})

// makeHarness 未使用前例导出会被 lint 认为死代码：这里用它做一次基本 smoke。
test('makeHarness smoke：默认 transport 发送并回执计数独立', async () => {
  const h = makeHarness({ readback: async () => null, readbackMaxAttempts: 1 })
  const r: PumpTickResult = await h.pump.tick()
  assert.equal(h.claimCalls(), 1)
  assert.equal(h.sendCalls(), 1)
  assert.equal(r.readback_checked, 1)
  assert.equal(r.not_found, 1)
  assert.equal(h.patches.some((p) => p.status === 'CONFIRMED'), false)
})

test('默认 claimFn 必须收到 withWrite 给的 client（不注入 io.claim），tick 不抛错', async () => {
  // 真链发信卡死根因：默认 claimFn 曾写 `() => claimPendingEffects(undefined, …)`，
  // 丢掉事务 client → client.query 抛 "Cannot read properties of undefined" → 被 catch 吞掉 → 永远 PENDING。
  let clientQueryCalls = 0
  const fakeClient = {
    query: async (): Promise<{ rows: unknown[] }> => {
      clientQueryCalls += 1
      return { rows: [] } // 无可认领行；关键是证明 client 被传到了 claimPendingEffects
    },
  }
  const io: PumpIo = {
    // 故意**不**提供 claim：走默认实现。
    withWrite: async (fn) => fn(fakeClient),
    advance: async (_client, id, patch) => ({ id, status: patch.status, record_version: 1 }),
  }
  const pump = createEmailPump({
    database: FAKE_DB, mail: FAKE_MAIL,
    transport: async () => ({ messageId: 'unused' }),
    io,
  })
  let thrown: unknown
  let counts: PumpTickResult | undefined
  try {
    counts = await pump.tick()
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown, undefined, `默认 claimFn 不得抛错：${String(thrown)}`)
  assert.ok(counts !== undefined)
  assert.equal(counts.claimed, 0)
  assert.equal(clientQueryCalls, 1, '默认 claimFn 必须在 withWrite 给的 client 上执行 query（不是 undefined）')
  pump.dispose()
})
