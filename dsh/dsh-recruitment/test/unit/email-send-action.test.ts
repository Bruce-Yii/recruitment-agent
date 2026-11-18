// 发信 Host Action + durable_effect 派发器的**无真库 / 无真网络**单元测试。
//
// 覆盖任务书必测项：
//   [HTTP] 预览不写库；body 带派生键 → 400 零写入；非 recruiter → 403 零写入；
//          同键两次确认 → created:true / created:false（INSERT 1 次）；未配置 mail/db → 503 零写入；
//          模式 B：无授权 / 过期 / 撤销 / 范围外 / OFFER → 403 且 enqueue 0 次；有效授权 → 成功。
//   [pump] 发送成功→SENT；超时(无 kind)→UNKNOWN_OUTCOME；TRANSIENT→RETRY_WAIT；
//          次数用尽→FAILED_FINAL；readback MATCH→CONFIRMED、读不到保持 NOT_READ；状态倒退被拒。
//
// 纪律：真 node:http 监听 127.0.0.1:0 + 假 webServer.register；所有 IO 走 `io` seam 注入，
// 不连真 PG、不连真 SMTP。测试里的假实现只断言"传给 enqueue/advance 的 patch 正确"。
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import {
  EMAIL_SEND_PATH,
  EMAIL_SEND_AUTHORIZED_PATH,
  EMAIL_AUTHORIZE_PATH,
  registerEmailSendHttp,
  type EmailSendHttpDeps,
  type EmailSendIo,
  type ResolvedRecipient,
} from '../../src/http/email-send.ts'
import {
  createEmailPump,
  classifySendResult,
  type EmailPumpDeps,
  type PumpIo,
  type ReadbackFunction,
  type SendFunction,
} from '../../src/runtime/email-pump.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'
import type { EmailAuthorizationConfigLike, EffectAdvancePatch } from '../../src/connectors/mail/durable-effect.ts'

// ---------------------------------------------------------------------------
//  固定值（与 demo-actor 缺省映射一致；本文件不连库）
// ---------------------------------------------------------------------------
const TENANT = '11111111-1111-4111-8111-000000000001'
const RECRUITER_ACTOR = '11111111-1111-4111-8111-000000000103'
const APPLICATION = '11111111-1111-4111-8111-000000000701'
const JOB = '11111111-1111-4111-8111-000000000801'
const CANDIDATE = '11111111-1111-4111-8111-000000000901'
const SESSION_RECRUITER = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_INTERVIEWER = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const FAKE_DB: ResolvedDatabaseConfig = {
  host: '127.0.0.1', port: 1, user: 'nobody', database: 'no_such_db_email_unit',
  password: 'not-a-real-password', password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT, actor_id: RECRUITER_ACTOR,
  statement_timeout_ms: 1000, connect_timeout_ms: 200, max: 1,
}
const FAKE_MAIL = {
  host: '127.0.0.1', port: 1, user: 'nobody', password_env: 'RECRUITMENT_MAIL_PASSWORD',
  tls: false, folder: 'INBOX', allowed_roots: [], password: 'not-a-real-password',
  since_days: 7, since_uid: 0,
} as unknown as MailConfig

const RECIPIENT: ResolvedRecipient = { to: 'candidate@example.invalid', display_name: '测试候选人' }

// ---------------------------------------------------------------------------
//  HTTP harness
// ---------------------------------------------------------------------------
interface HttpResult { status: number; body: Record<string, unknown>; text: string }
interface TestServer {
  baseUrl: string
  registered: readonly { kind: string; path: string }[]
  warnings: readonly string[]
  close(): Promise<void>
}

async function startServer(deps: EmailSendHttpDeps, host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1'): Promise<TestServer> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const warnings: string[] = []
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    Promise.resolve().then(() => handler(req, res)).catch(() => {
      try { res.destroy() } catch { /* ignore */ }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const dispose = registerEmailSendHttp({
    webServer: {
      host, port,
      register(route) {
        registered.push({ kind: route.kind, path: route.path })
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    logger: { warn(message: string) { warnings.push(message) } },
  }, deps)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    registered, warnings,
    async close() { dispose(); await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

async function call(
  baseUrl: string, path: string, body: unknown, session?: string,
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'x-recruitment-request': '1',
  }
  if (session !== undefined) headers['x-dsh-session'] = session
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { parsed = { raw: text } }
  return { status: response.status, body: parsed, text }
}

/** 记录 enqueue / INSERT 调用次数的 io seam。 */
interface EnqueueSpy {
  io: EmailSendIo
  enqueueCalls: () => number
  inserts: () => number
  inputs: () => readonly Record<string, unknown>[]
}

function makeEnqueueSpy(overrides: Partial<EmailSendIo> = {}): EnqueueSpy {
  const seen = new Set<string>()
  let enqueueCalls = 0
  let inserts = 0
  const inputs: Record<string, unknown>[] = []
  const io: EmailSendIo = {
    resolveRecipient: async () => RECIPIENT,
    withRead: async (_cfg, fn) => fn({
      query: async () => ({ rows: [{
        effect_id: 'aaaaaaaa-1111', status: 'PENDING', idempotency_key: 'kkkkkkkk',
        payload_hash: 'hhhhhhhh', record_version: 1, attempt_count: 0, sent_at: null, confirmed_at: null,
      }] }),
    } as never),
    withWrite: async (_cfg, _actor, fn) => fn({
      query: async () => ({ rows: [] }),
    } as never),
    enqueue: async (_client, input) => {
      enqueueCalls += 1
      inputs.push({ ...input })
      const key = String((input as unknown as Record<string, unknown>).idempotency_key)
      const created = !seen.has(key)
      if (created) { seen.add(key); inserts += 1 }
      return { id: 'ffffffff-1111-4111-8111-000000000001', status: 'PENDING', created }
    },
    ...overrides,
  }
  return { io, enqueueCalls: () => enqueueCalls, inserts: () => inserts, inputs: () => inputs }
}

let identity: DemoActorIdentity
before(() => {
  identity = createDemoActorIdentity().identity
  identity.registry.bind(SESSION_RECRUITER, 'recruiter')
  identity.registry.bind(SESSION_INTERVIEWER, 'interviewer_a')
})

const HUMAN_BODY = {
  application_id: APPLICATION, template_key: 'INTERVIEW_INVITE',
  variables: { round: '一面' }, confirmation_text: '我确认发送这封面试邀请',
}

// ===========================================================================
//  HTTP 测试
// ===========================================================================

describe('email/send 路由', () => {
  let server: TestServer

  before(async () => {
    server = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [],
    })
  })
  after(async () => { await server.close() })

  test('回环注册 3 条 exact 路由（人工 + 授权自动 + 授权配置写入）', () => {
    assert.deepEqual(
      server.registered.map((r) => `${r.kind} ${r.path}`),
      ['exact ' + EMAIL_SEND_PATH, 'exact ' + EMAIL_SEND_AUTHORIZED_PATH, 'exact ' + EMAIL_AUTHORIZE_PATH],
    )
  })

  test('预览不写库：200 + preview:true，enqueue 调用 0 次', async () => {
    const spy = makeEnqueueSpy()
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, EMAIL_SEND_PATH, { ...HUMAN_BODY, preview_only: true }, SESSION_RECRUITER)
      assert.equal(result.status, 200, result.text)
      assert.equal(result.body.preview, true)
      assert.equal((result.body as Record<string, unknown>).action, 'email/send')
      assert.equal(spy.enqueueCalls(), 0, '预览绝不调用 enqueue')
      assert.equal(spy.inserts(), 0)
    } finally { await s.close() }
  })

  test('body 带 actor_id/to/body → 400 ACTOR_OVERRIDE_REJECTED 且零写入', async () => {
    const spy = makeEnqueueSpy()
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, EMAIL_SEND_PATH,
        { ...HUMAN_BODY, actor_id: RECRUITER_ACTOR, to: 'evil@example.invalid', body: 'hack', subject: 'hack' },
        SESSION_RECRUITER)
      assert.equal(result.status, 400, result.text)
      const error = result.body.error as Record<string, unknown>
      assert.equal(error.code, 'INVALID_ARGS')
      assert.equal(error.reason_code, 'ACTOR_OVERRIDE_REJECTED')
      assert.equal(spy.enqueueCalls(), 0, '400 分支零 enqueue')
    } finally { await s.close() }
  })

  test('非 recruiter（interviewer_a）发信 → 403 且零写入', async () => {
    const spy = makeEnqueueSpy()
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, EMAIL_SEND_PATH, HUMAN_BODY, SESSION_INTERVIEWER)
      assert.equal(result.status, 403, result.text)
      assert.equal(spy.enqueueCalls(), 0, '403 分支零 enqueue')
    } finally { await s.close() }
  })

  test('同键两次确认 → created:true 然后 created:false，INSERT 次数 1', async () => {
    const spy = makeEnqueueSpy()
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const first = await call(s.baseUrl, EMAIL_SEND_PATH, HUMAN_BODY, SESSION_RECRUITER)
      assert.equal(first.status, 200, first.text)
      const firstEffect = first.body.effect as Record<string, unknown>
      assert.equal(firstEffect.created, true, '首次确认为 created:true')

      const second = await call(s.baseUrl, EMAIL_SEND_PATH, HUMAN_BODY, SESSION_RECRUITER)
      assert.equal(second.status, 200, second.text)
      const secondEffect = second.body.effect as Record<string, unknown>
      assert.equal(secondEffect.created, false, '同键重复确认 created:false')

      assert.equal(spy.enqueueCalls(), 2, 'enqueue 被调用两次（第二次由唯一键挡住）')
      assert.equal(spy.inserts(), 1, '真实 INSERT 只有一次（无新行、无重发）')
      assert.equal(spy.inputs()[0]?.authorization_ref, 'HUMAN_CLICK')
    } finally { await s.close() }
  })

  test('未配置 database → 503 且零写入', async () => {
    const spy = makeEnqueueSpy()
    const s = await startServer({
      database: null, databaseIssues: ['config.database.host is required'], identity,
      mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, EMAIL_SEND_PATH, HUMAN_BODY, SESSION_RECRUITER)
      assert.equal(result.status, 503, result.text)
      assert.equal(spy.enqueueCalls(), 0)
    } finally { await s.close() }
  })

  test('未配置 mail → 503 且零写入', async () => {
    const spy = makeEnqueueSpy()
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity,
      mail: null, mailIssues: ['config.mail.host is required'], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, EMAIL_SEND_PATH, HUMAN_BODY, SESSION_RECRUITER)
      assert.equal(result.status, 503, result.text)
      assert.equal(spy.enqueueCalls(), 0)
    } finally { await s.close() }
  })
})

// ===========================================================================
//  模式 B 授权入口测试
// ===========================================================================

const AUTO_BODY = {
  application_id: APPLICATION, job_id: JOB, recipient_ref: CANDIDATE,
  email_class: 'INTERVIEW', template_key: 'INTERVIEW_INVITE', variables: {},
}

function authConfig(overrides: Record<string, unknown> = {}): EmailAuthorizationConfigLike {
  return {
    id: '22222222-2222-4222-8222-000000000001',
    scope: 'JOB', scope_id: JOB, config_key: 'email.send.authorization', version_no: 1,
    effective_from: '2020-01-01T00:00:00Z', effective_to: null,
    payload: {
      authorized_by_actor_id: RECRUITER_ACTOR,
      authorization_id: 'AUTH-001',
      email_class: 'INTERVIEW', template_key: 'INTERVIEW_INVITE',
      scope: { job_ids: [JOB], application_ids: [APPLICATION], recipient_refs: [CANDIDATE] },
      ...overrides,
    },
  }
}

async function authorizedCall(configs: readonly EmailAuthorizationConfigLike[], body: unknown = AUTO_BODY) {
  const spy = makeEnqueueSpy({ readAuthorizations: async () => configs })
  const s = await startServer({
    database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
  })
  try {
    const result = await call(s.baseUrl, EMAIL_SEND_AUTHORIZED_PATH, body)
    return { result, spy }
  } finally { await s.close() }
}

describe('email/send-authorized 模式 B', () => {
  test('无授权 → 403，enqueue 调用 0 次', async () => {
    const { result, spy } = await authorizedCall([])
    assert.equal(result.status, 403, result.text)
    assert.equal(spy.enqueueCalls(), 0, '无授权零写入')
  })

  test('授权过期（expires_at < now）→ 403，enqueue 0 次', async () => {
    const { result, spy } = await authorizedCall([
      authConfig({ expires_at: '2000-01-01T00:00:00Z' }),
    ])
    assert.equal(result.status, 403, result.text)
    assert.equal(spy.enqueueCalls(), 0)
  })

  test('授权已撤销（revoked_at 非空）→ 403，enqueue 0 次', async () => {
    const { result, spy } = await authorizedCall([
      authConfig({ revoked_at: '2026-01-01T00:00:00Z' }),
    ])
    assert.equal(result.status, 403, result.text)
    assert.equal(spy.enqueueCalls(), 0)
  })

  test('范围外收件人/岗位 → 403 OUT_OF_SCOPE，enqueue 0 次', async () => {
    const { result, spy } = await authorizedCall([
      authConfig({ scope: { job_ids: ['99999999-9999-4999-8999-999999999999'], application_ids: ['99999999-9999-4999-8999-999999999998'] } }),
    ])
    assert.equal(result.status, 403, result.text)
    assert.equal(spy.enqueueCalls(), 0)
  })

  test('email_class=OFFER 即使有授权 → 403 OFFER_REQUIRES_HUMAN，必须人点', async () => {
    const { result, spy } = await authorizedCall([authConfig()], { ...AUTO_BODY, email_class: 'OFFER' })
    assert.equal(result.status, 403, result.text)
    const error = result.body.error as Record<string, unknown>
    assert.equal(error.reason_code, 'OFFER_REQUIRES_HUMAN')
    assert.equal(spy.enqueueCalls(), 0)
  })

  test('有效授权 → 200，enqueue 1 次，payload 带 authorization_ref', async () => {
    const { result, spy } = await authorizedCall([authConfig()])
    assert.equal(result.status, 200, result.text)
    assert.equal(spy.enqueueCalls(), 1)
    assert.equal(spy.inserts(), 1)
    assert.equal(spy.inputs()[0]?.authorization_ref, 'AUTH-001')
    assert.equal(spy.inputs()[0]?.authorized_by_actor_id, RECRUITER_ACTOR)
  })
})

// ===========================================================================
//  pump 单测
// ===========================================================================

interface PumpHarness {
  tick(): Promise<{ claimed: number; sent: number; retry: number; unknown: number; failed: number; confirmed: number }>
  patches: readonly EffectAdvancePatch[]
  dispose(): void
}

function makePump(opts: {
  transport: SendFunction
  row?: Record<string, unknown>
  readback?: ReadbackFunction | null
  now?: () => Date
}): PumpHarness {
  const patches: EffectAdvancePatch[] = []
  const row = {
    id: 'eeeeeeee-1111-4111-8111-000000000001', status: 'CLAIMED', // claim 已把 PENDING → CLAIMED
    payload: { to: 'candidate@example.invalid', subject: '标题', text: '正文', body_summary: '正文' },
    attempt_count: 0, max_attempts: 3, external_id: null,
    ...opts.row,
  }
  const io: PumpIo = {
    claim: async () => [row as never],
    listForReadback: async () => [],
    withWrite: async (fn) => fn(undefined),
    advance: async (_client, _id, patch) => {
      // 模拟 A 的"状态倒退被拒"：若前驱不匹配则抛错。
      patches.push({ ...patch })
      const allowed: Record<string, readonly string[]> = {
        SENT: ['CLAIMED'], CONFIRMED: ['SENT'], RETRY_WAIT: ['CLAIMED'],
        UNKNOWN_OUTCOME: ['CLAIMED'], FAILED_FINAL: ['CLAIMED', 'RETRY_WAIT'],
      }
      const preds = allowed[patch.status]
      if (preds !== undefined && !preds.includes(String(row.status))) {
        throw new Error('INVALID_MESSAGE: illegal transition')
      }
      return { id: String(row.id), status: patch.status, record_version: 2 }
    },
  }
  const deps: EmailPumpDeps = {
    database: FAKE_DB, mail: FAKE_MAIL,
    transport: opts.transport,
    readback: opts.readback ?? null,
    io,
    now: opts.now ?? (() => new Date('2026-01-01T00:00:00Z')),
    sleep: async () => {},
    retryDelayMs: 1000,
  }
  const pump = createEmailPump(deps)
  return { tick: pump.tick, patches, dispose: pump.dispose }
}

describe('email-pump 状态机', () => {
  test('classifySendResult：成功 → SENT；无 kind 异常 → UNKNOWN', () => {
    assert.deepEqual(classifySendResult({ messageId: 'm-1' }, undefined), { kind: 'SENT', messageId: 'm-1' })
    const unknown = classifySendResult(undefined, new Error('ETIMEDOUT'))
    assert.deepEqual(unknown, { kind: 'UNKNOWN', errorCode: 'SEND_OUTCOME_UNKNOWN' })
  })

  test('发送成功 → SENT（带 sent_at / external_id，attempt_count 不变）', async () => {
    const pump = makePump({ transport: async () => ({ messageId: 'm-1' }) })
    const counts = await pump.tick()
    assert.equal(counts.sent, 1)
    assert.equal(pump.patches[0]?.status, 'SENT')
    assert.equal(pump.patches[0]?.external_id, 'm-1')
    assert.equal(pump.patches[0]?.attempt_count, 0)
  })

  test('超时/不确定（无 kind）→ UNKNOWN_OUTCOME，不写 sent_at/external_id', async () => {
    const pump = makePump({ transport: async () => { throw new Error('ETIMEDOUT after 30s') } })
    const counts = await pump.tick()
    assert.equal(counts.unknown, 1)
    assert.equal(pump.patches[0]?.status, 'UNKNOWN_OUTCOME')
    assert.equal((pump.patches[0] as unknown as Record<string, unknown>).sent_at, undefined)
    assert.equal((pump.patches[0] as unknown as Record<string, unknown>).external_id, undefined)
  })

  test('TRANSIENT → RETRY_WAIT（attempt_count+1 + next_attempt_at）', async () => {
    const err = Object.assign(new Error('4xx'), { kind: 'TRANSIENT' })
    const pump = makePump({ transport: async () => { throw err } })
    const counts = await pump.tick()
    assert.equal(counts.retry, 1)
    assert.equal(pump.patches[0]?.status, 'RETRY_WAIT')
    assert.equal(pump.patches[0]?.attempt_count, 1)
    assert.ok(pump.patches[0]?.next_attempt_at)
  })

  test('attempts 用尽（max_attempts=1）→ FAILED_FINAL', async () => {
    const err = Object.assign(new Error('4xx'), { kind: 'TRANSIENT' })
    const pump = makePump({
      transport: async () => { throw err },
      row: { attempt_count: 0, max_attempts: 1 },
    })
    const counts = await pump.tick()
    assert.equal(counts.failed, 1)
    assert.equal(pump.patches[0]?.status, 'FAILED_FINAL')
    assert.ok(pump.patches[0]?.error_code)
  })

  test('readback MATCH → CONFIRMED（readback_state=MATCH）', async () => {
    const pump = makePump({
      transport: async () => ({ messageId: 'm-2' }),
      row: { status: 'SENT', external_id: 'm-2' },
      readback: async () => ({ matched: true }),
    })
    const counts = await pump.tick()
    assert.equal(counts.confirmed, 1)
    const confirmed = pump.patches.find((p) => p.status === 'CONFIRMED')
    assert.equal(confirmed?.readback_state, 'MATCH')
  })

  test('readback 读不到 → 不写 CONFIRMED（保持 NOT_READ）', async () => {
    const pump = makePump({
      transport: async () => ({ messageId: 'm-3' }),
      row: { status: 'SENT', external_id: 'm-3' },
      readback: async () => null,
    })
    const counts = await pump.tick()
    assert.equal(counts.confirmed, 0)
    assert.equal(pump.patches.some((p) => p.status === 'CONFIRMED'), false)
  })

  test('状态倒退被拒：advance 抛错时 tick 不崩溃（patch 仍被记录，跳过计数）', async () => {
    const pump = makePump({
      transport: async () => ({ messageId: 'm-4' }),
      row: { status: 'FAILED_FINAL', payload: { to: 'x@y.invalid', subject: '标题', text: '正文' } },
    })
    const counts = await pump.tick()
    // SENT 的前驱不允许 FAILED_FINAL → advance 抛错 → sent 不计数。
    assert.equal(counts.sent, 0, '非法转移不得计入成功')
    assert.equal(pump.patches[0]?.status, 'SENT', 'patch 仍尝试过，但被下游拒绝')
  })
})
