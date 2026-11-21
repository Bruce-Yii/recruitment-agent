// 回执三态语义回归（真链发信成功后回执永远 UNREADABLE 的根因）：
//   null（邮件还没到 INBOX）= 可重试：排 next_attempt_at，状态保持 SENT；
//   抛异常 = UNREADABLE，同样可重试；命中 = MATCH + CONFIRMED；预算耗尽才 NOT_FOUND。
//   每 tick 必须扫"已 SENT 但回执未完"的行（旧实现只查本 tick 刚 SENT 的 → 永远不复查）。
// 不连真网/真库：假 claim / listForReadback / readback / markReadback / advance。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createEmailPump,
  readbackRetryDelay,
  READBACK_RETRY_DELAYS_MS,
  type ClaimedEffect,
  type EffectAdvancePatch,
  type ReadbackMark,
  type ReadbackResult,
} from '../../src/runtime/email-pump.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const NOW = '2026-11-18T23:52:47.054Z'
const EFFECT_ID = 'eeeeeeee-1111-4111-8111-000000000001'
const EXTERNAL_ID = '<22415908-xxxx@qq.com>'
const DB = { host: '127.0.0.1', port: 1, user: 'x', database: 'x', password: 'x', password_env: 'PW',
  tenant_id: 't', actor_id: 'a', statement_timeout_ms: 1, connect_timeout_ms: 1, max: 1 } as ResolvedDatabaseConfig
const MAIL = { host: 'smtp.test', user: 'hr@test', password_env: 'PW', password: 'x', port: 587, tls: false,
  folder: 'INBOX', since_days: 7, since_uid: 0 } as MailConfig

interface Harness {
  tick(): Promise<ReturnType<ReturnType<typeof createEmailPump>['tick']>>
  marks: ReadbackMark[]
  patches: EffectAdvancePatch[]
  queryCount(): number
  setReadback(fn: () => Promise<ReadbackResult | null>): void
  setDueRows(rows: readonly ClaimedEffect[]): void
}

function harness(opts: {
  maxAttempts?: number
  readback: () => Promise<ReadbackResult | null>
  dueRows?: readonly ClaimedEffect[]
} = {}): Harness {
  let readback = opts.readback ?? (async () => null)
  let dueRows: readonly ClaimedEffect[] = opts.dueRows ?? [sentRow()]
  const marks: ReadbackMark[] = []
  const patches: EffectAdvancePatch[] = []
  let queryCount = 0
  const pump = createEmailPump({
    database: DB, mail: MAIL,
    transport: async () => { throw new Error('不应发送已 SENT 的行') },
    readback: async () => { queryCount += 1; return readback() },
    readbackMaxAttempts: opts.maxAttempts ?? 5,
    now: () => new Date(NOW),
    io: {
      claim: async () => [],
      listForReadback: async () => dueRows,
      withWrite: async (fn) => fn(undefined),
      markReadback: async (_c, _id, mark) => { marks.push({ ...mark }) },
      advance: async (_c, id, patch) => {
        patches.push({ ...patch })
        return { id, status: patch.status, record_version: 2 }
      },
    },
  })
  return {
    tick: () => pump.tick(),
    marks, patches,
    queryCount: () => queryCount,
    setReadback: (fn) => { readback = fn },
    setDueRows: (rows) => { dueRows = rows },
  }
}

function sentRow(overrides: Partial<ClaimedEffect> = {}): ClaimedEffect {
  return {
    id: EFFECT_ID, tenant_id: 't', status: 'SENT', idempotency_key: 'k',
    payload: { to: 'me@qq.com', subject: '初筛结果 · 测试候选人丁', text: '正文', body_summary: '正文' },
    payload_hash: null, attempt_count: 0, max_attempts: 5,
    external_id: EXTERNAL_ID, error_code: null,
    next_attempt_at: null, readback_state: 'NOT_READ',
    receipt_payload: null, sent_at: NOW,
    recipient_ref: 'app-1', subject: '初筛结果 · 测试候选人丁', body_summary: '正文',
    ...overrides,
  } as ClaimedEffect
}

test('退避链：5s → 15s → 30s → 60s', () => {
  assert.deepEqual([...READBACK_RETRY_DELAYS_MS], [5_000, 15_000, 30_000, 60_000])
  assert.equal(readbackRetryDelay(1), 5_000)
  assert.equal(readbackRetryDelay(3), 30_000)
  assert.equal(readbackRetryDelay(99), 60_000)
})

test('① 第一次回执 null → 不写终态、排 next_attempt_at；第二次命中 → CONFIRMED', async () => {
  const h = harness({ readback: async () => null })
  await h.tick()
  assert.equal(h.queryCount(), 1)
  assert.equal(h.marks.length, 1)
  assert.equal(h.marks[0]!.readback_state, 'NOT_READ')
  assert.equal(h.marks[0]!.next_attempt_at, new Date(Date.parse(NOW) + 5_000).toISOString())
  assert.equal(h.patches.some((p) => p.status === 'CONFIRMED'), false)
  assert.equal(h.patches.some((p) => p.status === 'NOT_FOUND'), false)

  h.setReadback(async () => ({ matched: true, matched_message_id: '<tencent_inbox@qq.com>',
    method: 'subject+recipient+time_window' }))
  await h.tick()
  assert.equal(h.queryCount(), 2, '第二 tick 必须再查（旧实现只查一次 → 永远不 CONFIRMED）')
  assert.equal(h.patches.some((p) => p.status === 'CONFIRMED'), true)
  const matchMark = h.marks.find((m) => m.readback_state === 'MATCH')
  assert.ok(matchMark !== undefined)
  assert.equal((matchMark!.receipt_payload as Record<string, unknown>).matched_message_id, '<tencent_inbox@qq.com>')
  assert.equal((matchMark!.receipt_payload as Record<string, unknown>).method, 'subject+recipient+time_window')
})

test('② 连续 N 次 null → NOT_FOUND，且从不 CONFIRMED', async () => {
  const h = harness({ maxAttempts: 3, readback: async () => null })
  for (let i = 0; i < 2; i += 1) await h.tick()
  assert.equal(h.patches.some((p) => p.status === 'CONFIRMED'), false)
  assert.equal(h.marks.filter((m) => m.readback_state === 'NOT_FOUND').length, 0)
  await h.tick()
  assert.equal(h.queryCount(), 3)
  assert.equal(h.marks.at(-1)!.readback_state, 'NOT_FOUND')
  assert.equal(h.marks.at(-1)!.next_attempt_at, null)
  assert.equal(h.patches.some((p) => p.status === 'CONFIRMED'), false)
})

test('③ 回执抛异常 → UNREADABLE 但仍排重试（不是终态）', async () => {
  const h = harness({ readback: async () => { throw new Error('IMAP down') } })
  await h.tick()
  assert.equal(h.marks[0]!.readback_state, 'UNREADABLE')
  assert.equal(typeof h.marks[0]!.next_attempt_at, 'string')
  assert.equal(h.patches.some((p) => p.status === 'CONFIRMED'), false)
})

test('④ 已 CONFIRMED 的行不再重复扫（listForReadback 返回空 → 零查询）', async () => {
  const h = harness({ readback: async () => null, dueRows: [] })
  await h.tick()
  assert.equal(h.queryCount(), 0)
  assert.equal(h.marks.length, 0)
})

test('⑤ 旧 UNREADABLE 行允许被重新扫描（lead 的现存证据行）', async () => {
  const h = harness({
    readback: async () => ({ matched: true, matched_message_id: '<tencent_old@qq.com>', method: 'subject+recipient+time_window' }),
    dueRows: [sentRow({ readback_state: 'UNREADABLE', next_attempt_at: null })],
  })
  await h.tick()
  assert.equal(h.queryCount(), 1)
  assert.equal(h.patches.some((p) => p.status === 'CONFIRMED'), true)
})
