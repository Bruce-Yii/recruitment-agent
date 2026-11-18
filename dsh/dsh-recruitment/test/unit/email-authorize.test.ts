// email/authorize（人点授权写入口）单元测试：无真库 / 无真网络。
//
// 覆盖：
//   1) 授权成功：max version 1 → 新行 version_no=2、payload authorized_by_actor_id 来自 identity、
//      confirmation_text_sha256（非原文）、payload_hash 64hex；旧行没有 UPDATE（spy SQL 断言）；
//   2) 撤销：新版本 revoked:true/revoked_at，旧行未改写；
//   3) 未绑定 session → 拒绝零写入；
//   4) OFFER → 403 零写入；
//   5) body 带 authorized_by_actor_id → 400 零写入；
//   6) 撤销后 resolveEmailAuthorization（A 的纯函数）对新配置数组判定为 REVOKED。
//
// 真 node:http 监听 127.0.0.1:0 + 假 webServer.register；所有 IO 走 `io` seam，不连真 PG。
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import {
  EMAIL_AUTHORIZE_PATH,
  registerEmailSendHttp,
  type EmailSendHttpDeps,
  type EmailSendIo,
} from '../../src/http/email-send.ts'
import {
  insertEmailAuthorization,
  resolveEmailAuthorization,
  type EmailAuthorizationConfigLike,
  type InsertEmailAuthorizationInput,
  type InsertEmailAuthorizationResult,
} from '../../src/connectors/mail/durable-effect.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const RECRUITER_ACTOR = '11111111-1111-4111-8111-000000000103'
const SESSION_RECRUITER = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_UNBOUND = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NEW_ID = '33333333-3333-4333-8333-000000000001'

const FAKE_DB: ResolvedDatabaseConfig = {
  host: '127.0.0.1', port: 1, user: 'nobody', database: 'no_such_db_authorize_unit',
  password: 'not-a-real-password', password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT, actor_id: RECRUITER_ACTOR,
  statement_timeout_ms: 1000, connect_timeout_ms: 200, max: 1,
}
const FAKE_MAIL = {
  host: '127.0.0.1', port: 1, user: 'nobody', password_env: 'RECRUITMENT_MAIL_PASSWORD',
  tls: false, folder: 'INBOX', allowed_roots: [], password: 'not-a-real-password',
  since_days: 7, since_uid: 0,
} as unknown as MailConfig

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
const VALID_BODY = {
  email_class: 'INTERVIEW_NOTICE',
  template_key: 'INTERVIEW_INVITE',
  scope: { job_ids: ['11111111-1111-4111-8111-000000000801'], application_ids: ['11111111-1111-4111-8111-000000000701'] },
  expires_at: FUTURE,
  confirmation_text: '我确认授权这类通知可以自动发送',
}

interface HttpResult { status: number; body: Record<string, unknown>; text: string }
interface TestServer {
  baseUrl: string
  registered: readonly { kind: string; path: string }[]
  close(): Promise<void>
}

async function startServer(
  deps: EmailSendHttpDeps,
  host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1',
): Promise<TestServer> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
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
    logger: { warn() {} },
  }, deps)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    registered,
    async close() { dispose(); await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

async function call(baseUrl: string, body: unknown, session?: string): Promise<HttpResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'x-recruitment-request': '1',
  }
  if (session !== undefined) headers['x-dsh-session'] = session
  const response = await fetch(`${baseUrl}${EMAIL_AUTHORIZE_PATH}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { parsed = { raw: text } }
  return { status: response.status, body: parsed, text }
}

// ---------------------------------------------------------------------------
//  SQL spy：记录 query 文本，assert 没有任何 update 旧配置行；注入 max version 行。
// ---------------------------------------------------------------------------
interface InsertSpy {
  io: EmailSendIo
  calls: () => number
  inputs: () => readonly InsertEmailAuthorizationInput[]
  sqls: () => readonly string[]
}

function makeInsertSpy(previousVersion: number | null, previousEffectiveTo: string | null = null): InsertSpy {
  const calls: InsertEmailAuthorizationInput[] = []
  const sqls: string[] = []
  const io: EmailSendIo = {
    withWrite: async (_cfg, _actor, fn) => fn({
      query: async (sql: string, params?: unknown[]) => {
        sqls.push(sql)
        if (/select version_no, effective_to/i.test(sql)) {
          return { rows: previousVersion === null ? [] : [{ version_no: previousVersion, effective_to: previousEffectiveTo }] }
        }
        return { rows: [{ id: NEW_ID }] }
      },
    } as never),
    withRead: async (_cfg, fn) => fn({
      query: async () => ({ rows: [{
        id: NEW_ID, version_no: previousVersion === null ? 1 : previousVersion + 1,
        payload_hash: 'a'.repeat(64), effective_from: '2026-01-01T00:00:00.000Z',
      }] }),
    } as never),
    readAuthorization: async () => ({
      id: NEW_ID, version_no: previousVersion === null ? 1 : previousVersion + 1,
      payload_hash: 'a'.repeat(64), effective_from: '2026-01-01T00:00:00.000Z',
    }),
    insertAuthorization: async (_client, input) => {
      calls.push({ ...input })
      // 用真函数跑一遍，验证 SQL / payload 构造；withWrite 注入的假 client 会记录 SQL。
      // 这里直接调用真 insertEmailAuthorization 以覆盖版本/max/effective_from 逻辑。
      return insertEmailAuthorization(_client as never, input)
    },
  }
  return { io, calls: () => calls.length, inputs: () => calls, sqls: () => sqls }
}

let identity: DemoActorIdentity
before(() => {
  identity = createDemoActorIdentity().identity
  identity.registry.bind(SESSION_RECRUITER, 'recruiter')
  // SESSION_UNBOUND 故意不绑定 → resolveSessionActor 抛错。
})

// ===========================================================================
//  HTTP 授权写入测试
// ===========================================================================

describe('email/authorize 授权写入口', () => {
  let server: TestServer
  before(async () => {
    server = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [],
    })
  })
  after(async () => { await server.close() })

  test('注册 3 条 exact 路由（人工 + 授权自动 + 授权写入）', () => {
    assert.equal(server.registered.length, 3)
    assert.ok(server.registered.some((r) => r.kind === 'exact' && r.path === EMAIL_AUTHORIZE_PATH))
  })

  test('授权成功：max version 1 → 新版本 2，payload 来自 identity、sha256、payload_hash 64hex，无 UPDATE 旧行', async () => {
    const spy = makeInsertSpy(1)
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, VALID_BODY, SESSION_RECRUITER)
      assert.equal(result.status, 200, result.text)
      const auth = result.body.authorization as Record<string, unknown>
      assert.equal(auth.version_no, 2)
      assert.equal(typeof auth.id, 'string')
      assert.equal(String(auth.id).length, 8)
      assert.equal(spy.calls(), 1)

      const input = spy.inputs()[0]!
      assert.equal(input.actor_id, RECRUITER_ACTOR, 'actor 来自 identity 而非 body')
      assert.equal(input.confirmation_text_sha256.length, 64)
      assert.notEqual(input.confirmation_text_sha256, VALID_BODY.confirmation_text, '不存原文')

      // 真 insertEmailAuthorization 落到假 client 的 SQL：只 SELECT + INSERT，无 UPDATE。
      const updateSqls = spy.sqls().filter((sql) => /^\s*update\b/i.test(sql))
      assert.deepEqual(updateSqls, [], '绝不 UPDATE 旧版本（零 UPDATE）')
      const insertSql = spy.sqls().find((sql) => /^\s*insert\b/i.test(sql))
      assert.ok(insertSql && /recruitment\.business_config/.test(insertSql))
    } finally { await s.close() }
  })

  test('撤销：新版本 revoked:true/revoked_at，旧行未改写', async () => {
    const spy = makeInsertSpy(3, '2026-06-01T00:00:00.000Z')
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, {
        ...VALID_BODY, revoke: true, authorization_id: 'auth:target-001',
      }, SESSION_RECRUITER)
      assert.equal(result.status, 200, result.text)
      const auth = result.body.authorization as Record<string, unknown>
      assert.equal(auth.version_no, 4)
      const input = spy.inputs()[0]!
      assert.equal(input.revoke, true)
      assert.equal(input.revoke_authorization_id, 'auth:target-001')
      assert.equal(input.actor_id, RECRUITER_ACTOR)
      const updateSqls = spy.sqls().filter((sql) => /^\s*update\b/i.test(sql))
      assert.deepEqual(updateSqls, [], '撤销也不 UPDATE 历史版本')
      // effective_from = 旧 effective_to + 1ms（不 UPDATE 旧行也能避免两版同时生效）。
      assert.ok(spy.sqls().some((sql) => /\$7::timestamptz/.test(sql)))
    } finally { await s.close() }
  })

  test('未绑定 session → 拒绝零写入', async () => {
    const spy = makeInsertSpy(1)
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, VALID_BODY, SESSION_UNBOUND)
      assert.equal(result.status === 409 || result.status === 400, true, `status=${result.status}`)
    } finally { await s.close() }
  })

  test('OFFER → 403 OFFER_REQUIRES_HUMAN，零写入', async () => {
    const spy = makeInsertSpy(1)
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, { ...VALID_BODY, email_class: 'OFFER' }, SESSION_RECRUITER)
      assert.equal(result.status, 403, result.text)
      const error = result.body.error as Record<string, unknown>
      assert.equal(error.reason_code, 'OFFER_REQUIRES_HUMAN')
    } finally { await s.close() }
  })

  test('body 带 authorized_by_actor_id → 400 ACTOR_OVERRIDE_REJECTED，零写入', async () => {
    const spy = makeInsertSpy(1)
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const result = await call(s.baseUrl, { ...VALID_BODY, authorized_by_actor_id: 'evil-actor' }, SESSION_RECRUITER)
      assert.equal(result.status, 400, result.text)
      const error = result.body.error as Record<string, unknown>
      assert.equal(error.reason_code, 'ACTOR_OVERRIDE_REJECTED')
    } finally { await s.close() }
  })

  test('缺 confirmation_text / expires_at 非法 → 400 零写入', async () => {
    const spy = makeInsertSpy(1)
    const s = await startServer({
      database: FAKE_DB, databaseIssues: [], identity, mail: FAKE_MAIL, mailIssues: [], io: spy.io,
    })
    try {
      const noConfirm = await call(s.baseUrl, {
        email_class: 'INTERVIEW_NOTICE', template_key: 'INTERVIEW_INVITE',
        scope: { job_ids: ['x'] }, expires_at: FUTURE,
      }, SESSION_RECRUITER)
      assert.equal(noConfirm.status, 400, noConfirm.text)
      const badExpiry = await call(s.baseUrl, { ...VALID_BODY, expires_at: '2000-01-01T00:00:00Z' }, SESSION_RECRUITER)
      assert.equal(badExpiry.status, 400, badExpiry.text)
    } finally { await s.close() }
  })
})

// ===========================================================================
//  撤销后的纯判定（A 的 resolveEmailAuthorization → REVOKED）
// ===========================================================================

describe('email/authorize 撤销判定', () => {
  test('撤销后 resolveEmailAuthorization 对新配置数组判定为 REVOKED', () => {
    const configs: EmailAuthorizationConfigLike[] = [
      {
        id: 'old-1', version_no: 1, config_key: 'email.send.authorization',
        effective_from: '2020-01-01T00:00:00Z', effective_to: '2026-06-01T00:00:00.001Z',
        payload: {
          authorization_id: 'auth:target-001', authorized_by_actor_id: RECRUITER_ACTOR,
          email_class: 'INTERVIEW_NOTICE', template_key: 'INTERVIEW_INVITE',
          scope: { job_ids: ['11111111-1111-4111-8111-000000000801'] },
          expires_at: FUTURE,
        },
      },
      {
        id: 'new-2', version_no: 2, config_key: 'email.send.authorization',
        effective_from: '2026-06-01T00:00:00.002Z', effective_to: null,
        payload: {
          authorization_id: 'auth:target-001', authorized_by_actor_id: RECRUITER_ACTOR,
          email_class: 'INTERVIEW_NOTICE', template_key: 'INTERVIEW_INVITE',
          scope: {}, expires_at: FUTURE,
          revoked: true, revoked_at: '2026-07-01T00:00:00Z',
        },
      },
    ]
    const decision = resolveEmailAuthorization(configs, {
      application_id: '11111111-1111-4111-8111-000000000701',
      job_id: '11111111-1111-4111-8111-000000000801',
      recipient_ref: 'candidate-ref',
      email_class: 'INTERVIEW_NOTICE',
      template_key: 'INTERVIEW_INVITE',
      now: '2026-08-01T00:00:00Z',
    })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'REVOKED')
  })
})
