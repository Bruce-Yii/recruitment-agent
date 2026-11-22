// Issue #25 / G-02 轮询与编排集成单测（无真实网络/真实时钟/真实 PG）：
//   * 未配置 env → 不启动 timer、不跑 tick（回归保护）
//   * 注入假 timer/clock/transport/pool → 编码命中、标题命中、未命中/多义 fail-closed
//     + unmatched_reason、UID 水位幂等去重、互斥防重入、水位保存失败下周期可恢复。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createImapPoller,
  resolvePollIntervalMs,
  createMailLock,
  MAIL_POLL_INTERVAL_ENV,
  type PollTimer,
} from '../../src/connectors/mail/poll.ts'
import { fetchAndIngest, makeJobResolver } from '../../src/connectors/mail/orchestrator.ts'
import type { MailJobCandidate } from '../../src/connectors/mail/match.ts'
import type { MailEnvelope, MailTransport, RawMailMessage } from '../../src/connectors/mail/contract.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const NOW = new Date('2026-11-22T10:00:00.000Z')

const JOBS: readonly MailJobCandidate[] = [
  { id: 'job-be', code: 'DEMO-BE-001', title: '后端工程师', status: 'OPEN' },
  { id: 'job-fe', code: 'JOB-20261114-77CD5B', title: '前端工程师', status: 'OPEN' },
]

/** 假 timer：记录待触发回调，不真的等待。 */
function fakeTimer(): PollTimer & { pending: (() => void)[]; cleared: number } {
  const state = { pending: [] as (() => void)[], cleared: 0 }
  return {
    pending: state.pending,
    get cleared() { return state.cleared },
    setTimeout(fn: () => void): unknown {
      state.pending.push(fn)
      return state.pending.length
    },
    clearTimeout(): void { state.cleared += 1 },
  }
}

/** 最小 MIME（无附件，编排层走 SEEN_NO_ATTACHMENT，只写 event_inbox 事实事件）。 */
function mime(id: string, subject: string, body: string): Buffer {
  return Buffer.from([
    `Message-ID: <${id}>`,
    'From: hr-applicant@example.test',
    `Subject: ${subject}`,
    'Date: Sun, 22 Nov 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n'))
}

function envelope(uid: number, id: string, subject: string): MailEnvelope {
  return { uid, message_id: id, subject, from: 'applicant@example.test', date: NOW.toISOString() }
}

/** 假 transport：按 UID 返回不同邮件；listNew 只返回 uid > since_uid 的窗口。 */
function transportFor(mails: readonly { uid: number; id: string; subject: string; body: string }[]): MailTransport {
  const byUid = new Map(mails.map((m) => [m.uid, m]))
  return {
    async connect(): Promise<void> {},
    async listNew(input): Promise<readonly MailEnvelope[]> {
      const since = input.since_uid ?? 0
      return mails
        .filter((m) => m.uid > since)
        .sort((a, b) => b.uid - a.uid)
        .map((m) => envelope(m.uid, m.id, m.subject))
    },
    async fetchMessage(uid: number): Promise<RawMailMessage> {
      const m = byUid.get(uid)
      if (m === undefined) throw new Error(`no mail uid ${uid}`)
      return {
        uid,
        message_id: m.id,
        headers: { subject: m.subject },
        attachments: [],
        text: m.body,
        raw: mime(m.id, m.subject, m.body),
      }
    },
    async disconnect(): Promise<void> {},
  }
}

/** 假 pool：返回假 client；记录 event_inbox 插入次数，用于 UID 幂等断言。 */
function depsFor(mails: readonly { uid: number; id: string; subject: string; body: string }[]) {
  const inserts: string[] = []
  const client = {
    query: async (sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> => {
      if (sql.includes('insert into recruitment.event_inbox')) {
        inserts.push(String(params?.[2] ?? ''))
      }
      return { rows: [] }
    },
    release: () => {},
  }
  const database: ResolvedDatabaseConfig = {
    host: '127.0.0.1', port: 1, user: 'postgres', database: 'never', password: 'x',
    password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: 't', actor_id: 'a',
    statement_timeout_ms: 100, connect_timeout_ms: 100, max: 1,
  }
  const converter: ResolvedConverterConfig = {
    python_bin: 'python', converter_dir: '/tmp', allowed_roots: ['/tmp'], timeout_ms: 100,
  }
  const mail: MailConfig = {
    host: 'imap.test', user: 'hr@test', password_env: 'PW', password: 'x',
    port: 993, tls: true, folder: 'INBOX', since_days: 7, since_uid: 0,
  }
  const observed: { type: string; unmatched_reason?: string }[] = []
  return {
    inserts,
    observed,
    deps: {
      transport: transportFor(mails),
      cfg: { database, converter, mail },
      clock: () => NOW,
      onObservable: (event: { type: string; unmatched_reason?: string }) => observed.push(event),
      __poolForTest: {
        pool: { connect: async () => client } as never,
        close: async () => {},
      },
    },
  }
}

// ---------------------------------------------------------------------------
// env gate
// ---------------------------------------------------------------------------

test('未配置 RECRUITMENT_IMAP_POLL_INTERVAL_MS → 禁用，不建 timer / 不跑 tick', () => {
  assert.equal(resolvePollIntervalMs({}), 0)
  assert.equal(resolvePollIntervalMs({ [MAIL_POLL_INTERVAL_ENV]: '' }), 0)
  assert.equal(resolvePollIntervalMs({ [MAIL_POLL_INTERVAL_ENV]: '0' }), 0)
  assert.equal(resolvePollIntervalMs({ [MAIL_POLL_INTERVAL_ENV]: '-5' }), 0)
  assert.equal(resolvePollIntervalMs({ [MAIL_POLL_INTERVAL_ENV]: 'abc' }), 0)
  assert.equal(resolvePollIntervalMs({ [MAIL_POLL_INTERVAL_ENV]: '1.5' }), 0)

  const timer = fakeTimer()
  let ticks = 0
  const poller = createImapPoller({
    intervalMs: 0,
    runOnce: async () => { ticks += 1; return { next_since_uid: 1, progressed: true } },
    loadWatermark: () => 0,
    saveWatermark: () => {},
    timer,
  })
  assert.equal(poller, null, '禁用时必须返回 null（不启动任何定时器）')
  assert.equal(timer.pending.length, 0)
  assert.equal(ticks, 0)

  assert.equal(resolvePollIntervalMs({ [MAIL_POLL_INTERVAL_ENV]: '60000' }), 60000)
})

// ---------------------------------------------------------------------------
// timer / stop / mutex
// ---------------------------------------------------------------------------

test('start 只排一个 timer；stop 清 timer 且幂等，在途 tick 结束后返回', async () => {
  const timer = fakeTimer()
  let done = false
  const poller = createImapPoller({
    intervalMs: 1000,
    runOnce: async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
      done = true
      return { next_since_uid: 1, progressed: true }
    },
    loadWatermark: () => 0,
    saveWatermark: () => {},
    timer,
  })!
  poller.start()
  poller.start()
  assert.equal(poller.isRunning(), true)
  assert.equal(timer.pending.length, 1, '重复 start 不应排多个 timer')

  const first = timer.pending.shift()!
  first() // 触发一轮
  await poller.stop()
  assert.equal(done, true, 'stop 应等在途 tick 完成')
  assert.equal(poller.isRunning(), false)
  assert.equal(timer.cleared, 1, 'stop 清理 timer')
  await poller.stop() // 幂等
  assert.equal(timer.cleared, 1)
})

test('互斥锁：上一轮未结束时新 tick 不并发执行（runExclusive 串行）', async () => {
  const lock = createMailLock()
  let active = 0
  let maxActive = 0
  const order: number[] = []
  const tasks = [1, 2, 3].map((id) => lock.runExclusive(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
    order.push(id)
    active -= 1
    return id
  }))
  await Promise.all(tasks)
  assert.equal(maxActive, 1, '任何时刻只能有一个执行体')
  assert.deepEqual(order, [1, 2, 3], 'FIFO 执行')
})

test('单轮失败不杀定时器；水位保存失败下周期用旧水位重试（可恢复）', async () => {
  const timer = fakeTimer()
  let watermark = 100
  let attempt = 0
  const seenSince: number[] = []
  const errors: string[] = []
  const poller = createImapPoller({
    intervalMs: 1000,
    runOnce: async (since) => {
      seenSince.push(since)
      attempt += 1
      if (attempt === 1) throw new Error('network down')
      return { next_since_uid: since + 1, progressed: true }
    },
    loadWatermark: () => watermark,
    saveWatermark: (uid) => { if (attempt === 2) throw new Error('db down'); watermark = uid },
    onEvent: (event) => errors.push(event.type),
    timer,
  })!
  poller.start()
  timer.pending.shift()!() // 第 1 轮：抛错
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  timer.pending.shift()!() // 第 2 轮：水位保存失败
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  timer.pending.shift()!() // 第 3 轮：应重试旧水位 100
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  await poller.stop()

  assert.deepEqual(seenSince, [100, 100, 100])
  assert.ok(errors.includes('TICK_FAILED'))
  assert.ok(errors.includes('WATERMARK_SAVE_FAILED'))
  assert.equal(poller.isRunning(), false)
})

// ---------------------------------------------------------------------------
// orchestrator 集成：分岗 / 水位 / 去重
// ---------------------------------------------------------------------------

test('自动分岗：精确编码命中与唯一标题命中各自写入正确 job_id', async () => {
  const mails = [
    { uid: 1, id: 'm1@test', subject: '应聘 DEMO-BE-001', body: '附件是我的简历' },
    { uid: 2, id: 'm2@test', subject: '前端工程师岗位投递', body: '请查收' },
  ]
  const { deps, inserts, observed } = depsFor(mails)
  const usedJobIds: string[] = []
  // 在 makeJobResolver 之上包一层记录 job_id，验证真的按封分流。
  const base = makeJobResolver(JOBS)
  const resolver = async (ctx: { subject: string; text_summary: string; message_id: string }) => {
    const decision = await base(ctx)
    if (decision.matched) usedJobIds.push(decision.job_id)
    return decision
  }
  const result = await fetchAndIngest(
    { job_id: '', jobResolver: resolver },
    deps as never,
  )
  assert.equal(result.total, 2)
  assert.equal(result.ingested, 0, '无附件邮件只写事实事件')
  assert.deepEqual(usedJobIds, ['job-fe', 'job-be'], 'listNew 降序：uid=2 标题命中前端；uid=1 编码命中后端')
  assert.equal(inserts.length, 2)
  assert.deepEqual(observed.filter((e) => e.type === 'MAIL_JOB_MATCHED').map((e) => e.unmatched_reason), [undefined, undefined])
})

test('自动分岗：未命中/多义 fail-closed，结果带 unmatched_reason，不写 event_inbox', async () => {
  const mails = [
    { uid: 1, id: 'bad1@test', subject: '应聘 运维工程师', body: '' },
    { uid: 2, id: 'bad2@test', subject: 'DEMO-BE-001 与 JOB-20261114-77CD5B 都投了', body: '' },
    { uid: 3, id: 'bad3@test', subject: '后端工程师 和 前端工程师 简历', body: '' },
  ]
  const { deps, inserts, observed } = depsFor(mails)
  const result = await fetchAndIngest(
    { job_id: '', jobResolver: makeJobResolver(JOBS) },
    deps as never,
  )
  assert.equal(result.total, 3)
  assert.equal(result.skipped, 3)
  assert.equal(inserts.length, 0, '未分岗邮件绝不写 event_inbox / intake')
  // listNew 按 UID 降序（newer-first）：uid=3 → 多标题，uid=2 → 多编码，uid=1 → 未命中。
  assert.deepEqual(result.results.map((r) => r.unmatched_reason), [
    'AMBIGUOUS_TITLE', 'AMBIGUOUS_CODE', 'NO_CODE_OR_TITLE_MATCH',
  ])
  assert.deepEqual(observed.map((e) => e.unmatched_reason), [
    'AMBIGUOUS_TITLE', 'AMBIGUOUS_CODE', 'NO_CODE_OR_TITLE_MATCH',
  ])
  // 水位仍推进到最大 uid（skip 不该卡住后续邮件）。
  assert.equal(result.next_since_uid, 3)
})

test('UID 水位幂等去重：同 message-id 第二轮被 DUPLICATE_MESSAGE，不重复写事实', async () => {
  const mails = [{ uid: 7, id: 'dup@test', subject: '应聘 DEMO-BE-001', body: '简历' }]
  const { deps, inserts } = depsFor(mails)

  const first = await fetchAndIngest({ job_id: '', jobResolver: makeJobResolver(JOBS) }, deps as never)
  assert.equal(first.next_since_uid, 7)
  assert.equal(inserts.length, 1)

  // 模拟 event_inbox 已有该 message-id：假 client 改为返回已有行。
  const dupClient = {
    query: async (sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> => {
      if (sql.includes('select event_id from recruitment.event_inbox')) {
        return { rows: [{ event_id: 'e1' }] }
      }
      if (sql.includes('insert into recruitment.event_inbox')) inserts.push(String(params?.[2] ?? ''))
      return { rows: [] }
    },
    release: () => {},
  }
  const dupDeps = {
    ...deps,
    __poolForTest: { pool: { connect: async () => dupClient } as never, close: async () => {} },
  }
  // since_uid=0 模拟水位回退/旧水位重试：同一封再次出现时必须被幂等挡住。
  const second = await fetchAndIngest(
    { job_id: '', jobResolver: makeJobResolver(JOBS), since_uid: 0 },
    dupDeps as never,
  )
  assert.equal(second.total, 1)
  assert.equal(second.results[0]!.status, 'DUPLICATE_MESSAGE')
  assert.equal(inserts.length, 1, '重复邮件不产生第二次事实写入')
})

test('自动化轮询一轮：调 fetchAndIngest 并用 next_since_uid 推进水位', async () => {
  const mails = [{ uid: 9, id: 'p1@test', subject: '应聘 DEMO-BE-001', body: '' }]
  const { deps } = depsFor(mails)
  let stored = 0
  const poller = createImapPoller({
    intervalMs: 60000,
    loadWatermark: () => stored,
    saveWatermark: (uid) => { stored = uid },
    runOnce: async (since) => {
      const result = await fetchAndIngest(
        { job_id: '', jobResolver: makeJobResolver(JOBS), since_uid: since },
        deps as never,
      )
      return { next_since_uid: result.next_since_uid, progressed: result.connection === 'CONNECTED' }
    },
  })!
  await poller.tick()
  await poller.stop()
  assert.equal(stored, 9, '水位应自动推进到本轮最大 uid')
})
