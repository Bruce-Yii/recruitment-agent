// A4 面评草稿 · 真库集成测试（一次性库，0001→0022 全量重放；结束 drop）。
//
// 覆盖契约的六件事：
//   ① 保存 → 独立读回最新（append-only 版本行，连续保存版本 +1）；
//   ② 真 HTTP 路由 GET/POST（session→alias→actor 绑定 + 本人面试官）；
//   ③ 负例：未绑定 / 非本人面试官 / 已提交面评再写草稿 / payload 超限 → 全部零写入；
//   ④ 禁删/不可变由库触发器强制（不是源码自觉）；
//   ⑤ 与 scorecard/submit 隔离：本测试不 import scorecard-submit，也不改 scorecard 行（除夹具造 SUBMITTED）；
//   ⑥ verify.sql 的 DRAFT-STRUCT 断言在真库上跑通（见 work/d5/scorecard-draft/REPORT.md）。
//
// 用 createIsolatedTestDatabase()：并发安全的一次性空库，跑完 drop（不碰 ra_s6s7）。
import test, { before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  createIsolatedTestDatabase,
  TENANT,
  HR_ACTOR,
  seedScenario,
  type IsolatedTestDatabase,
} from './db.ts'
import {
  assertDraftWritable,
  readDraft,
  saveDraft,
  validateDraftPayload,
  type ScorecardDraftRow,
} from '../../src/db/scorecard-draft.ts'
import {
  registerScorecardDraftHttp,
  SCORECARD_DRAFT_CONTRACT,
  type ScorecardDraftHttpDeps,
} from '../../src/http/scorecard-draft.ts'
import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { withActor, withReadOnly } from '../../src/db/pool.ts'

const SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACTOR_B = '11111111-1111-4111-8111-000000000105' // 默认 interviewer_b（非本场面试官）

interface Fixture {
  readonly interviewId: string
  readonly interviewerId: string
  readonly interviewerActorId: string
  readonly submittedInterviewId: string
  readonly submittedInterviewerId: string
}

let db: IsolatedTestDatabase
let fixture: Fixture

async function insertInterview(client: { query<T>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }> }, applicationId: string, roundNo: number): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.interview
        (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at, scheduled_end_at, timezone)
      values ($1, $2, $3, 'DEFAULT', 'SCHEDULED', now() - interval '1 hour', now(), 'Asia/Shanghai')
      returning id::text as id`,
    [TENANT, applicationId, roundNo],
  )
  const id = rows[0]?.id
  assert.ok(typeof id === 'string')
  return id
}

async function insertInterviewer(client: { query<T>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }> }, interviewId: string, actorId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.interviewer (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard)
      values ($1, $2, $3, 'TECH_LEAD', true) returning id::text as id`,
    [TENANT, interviewId, actorId],
  )
  const id = rows[0]?.id
  assert.ok(typeof id === 'string')
  return id
}

before(async () => {
  db = await createIsolatedTestDatabase('scorecard_draft')
  const client = await db.pool.connect()
  try {
    // 默认 actor 映射：interviewer_a = …0104（本人面试官），interviewer_b = …0105。
    const actorA = '11111111-1111-4111-8111-000000000104'
    const scenario = await seedScenario(client, {
      dimensions: [{ key: 'BACKEND', label: '后端', kind: 'RUBRIC', weight: 1 }],
    })
    const interviewId = await insertInterview(client, scenario.applicationId, 1)
    const interviewerId = await insertInterviewer(client, interviewId, actorA)

    // 第二场：造一条 SUBMITTED 面评（负例：已提交后不许写草稿）。
    const submittedInterviewId = await insertInterview(client, scenario.applicationId, 2)
    const submittedInterviewerId = await insertInterviewer(client, submittedInterviewId, actorA)
    await client.query(
      `insert into recruitment.scorecard
          (tenant_id, interview_id, interviewer_id, rubric_version_id, status, submitted_at,
           items, overall, status_changed_by_actor_id)
        values ($1, $2, $3, $4, 'SUBMITTED', now(), '[{"dim":"BACKEND","score":4}]'::jsonb, 'ADVANCE', $5)`,
      [TENANT, submittedInterviewId, submittedInterviewerId, scenario.rubricId, actorA],
    )
    fixture = {
      interviewId,
      interviewerId,
      interviewerActorId: actorA,
      submittedInterviewId,
      submittedInterviewerId,
    }
  } finally {
    client.release()
  }
})

after(async () => {
  if (db !== undefined) await db.drop()
})

describe('A4 面评草稿 · 真库 DB 适配器', () => {
  test('保存两次 → append-only 版本 1→2；独立读回最新一条', async () => {
    const payload1 = validateDraftPayload({ assessments: { BACKEND: 3 }, note: '第一版' })
    const payload2 = validateDraftPayload({ assessments: { BACKEND: 4 }, note: '第二版' })
    const write = async (payload: Record<string, unknown>) => withActor(db.pool, fixture.interviewerActorId, (client) =>
      saveDraft(client, {
        tenant_id: TENANT,
        interview_id: fixture.interviewId,
        interviewer_id: fixture.interviewerId,
        interviewer_actor_id: fixture.interviewerActorId,
        payload,
      }))
    const first = await write(payload1)
    const second = await write(payload2)
    assert.equal(first.record_version, 1)
    assert.equal(second.record_version, 2)
    const latest = await withReadOnly(db.pool, (client) =>
      readDraft(client, TENANT, fixture.interviewId, fixture.interviewerActorId))
    assert.ok(latest !== null)
    assert.equal(latest.record_version, 2, '读回必须是最新版本')
    assert.deepEqual(latest.payload, { assessments: { BACKEND: 4 }, note: '第二版' })
    // 历史行仍在（append-only，不删不改）。
    const count = await withReadOnly(db.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from recruitment.scorecard_draft
          where tenant_id = $1 and interview_id = $2 and interviewer_actor_id = $3`,
        [TENANT, fixture.interviewId, fixture.interviewerActorId],
      )
      return Number(rows[0]?.n)
    })
    assert.equal(count, 2)
  })

  test('已提交面评再写草稿 → FORBIDDEN/SCORECARD_ALREADY_SUBMITTED；草稿表零写入', async () => {
    const before = await withReadOnly(db.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from recruitment.scorecard_draft
          where tenant_id = $1 and interview_id = $2`,
        [TENANT, fixture.submittedInterviewId],
      )
      return Number(rows[0]?.n)
    })
    await assert.rejects(
      withActor(db.pool, fixture.interviewerActorId, async (client) => {
        await assertDraftWritable(client, TENANT, fixture.submittedInterviewId, fixture.submittedInterviewerId)
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes('FORBIDDEN') && message.includes('SCORECARD_ALREADY_SUBMITTED')
      },
    )
    const after = await withReadOnly(db.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from recruitment.scorecard_draft
          where tenant_id = $1 and interview_id = $2`,
        [TENANT, fixture.submittedInterviewId],
      )
      return Number(rows[0]?.n)
    })
    assert.equal(after, before, '负例必须零写入')
  })

  test('库级 append-only：DELETE / UPDATE 草稿行被触发器拒（23514）', async () => {
    await assert.rejects(
      withActor(db.pool, fixture.interviewerActorId, (client) =>
        client.query(`delete from recruitment.scorecard_draft where tenant_id = $1 and interview_id = $2`, [TENANT, fixture.interviewId])),
      (error: unknown) => (error as { code?: string }).code === '23514',
    )
    await assert.rejects(
      withActor(db.pool, fixture.interviewerActorId, (client) =>
        client.query(
          `update recruitment.scorecard_draft set payload = '{"note":"篡改"}'::jsonb
            where tenant_id = $1 and interview_id = $2`,
          [TENANT, fixture.interviewId],
        )),
      (error: unknown) => (error as { code?: string }).code === '23514',
    )
  })
})

// ---------------------------------------------------------------------
//  真 HTTP 路由（同一 identity 单例 + 真 PG；会话已绑定）
// ---------------------------------------------------------------------

interface HttpHarness {
  readonly baseUrl: string
  close(): Promise<void>
}

async function startHttp(deps: ScorecardDraftHttpDeps): Promise<HttpHarness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    Promise.resolve().then(() => handler(req, res)).catch(() => res.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  registerScorecardDraftHttp(
    {
      webServer: {
        host: '127.0.0.1',
        port,
        register(route) {
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
    },
    deps,
  )
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

function httpDeps(identity: DemoActorIdentity): ScorecardDraftHttpDeps {
  const cfg = {
    host: '127.0.0.1',
    port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
    user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
    database: db.name,
    password: process.env.RECRUITMENT_DB_PASSWORD ?? '',
    password_env: 'RECRUITMENT_DB_PASSWORD',
    tenant_id: TENANT,
    actor_id: HR_ACTOR,
    statement_timeout_ms: 15000,
    connect_timeout_ms: 10000,
    max: 4,
  }
  return { database: cfg, databaseIssues: [], identity }
}

async function callHttp(
  h: HttpHarness,
  opts: {
    readonly method?: string
    readonly session?: string
    readonly interviewId?: string
    readonly payload?: unknown
    readonly body?: unknown
  },
) {
  const headers: Record<string, string> = { 'x-recruitment-request': '1' }
  if (opts.session !== undefined) headers['x-dsh-session'] = opts.session
  let payload: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(opts.body)
  }
  const interviewId = opts.interviewId ?? fixture.interviewId
  const response = await fetch(
    `${h.baseUrl}${SCORECARD_DRAFT_CONTRACT.path}${opts.method === 'POST' ? '' : `?interview_id=${interviewId}`}`,
    { method: opts.method ?? 'GET', headers, body: payload },
  )
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
  return { status: response.status, body, text }
}

describe('A4 面评草稿 · 真 HTTP 端到端', () => {
  test('GET 未绑定 → 409；POST 未绑定 → 409（零写入）', async () => {
    const identity = createDemoActorIdentity().identity
    const h = await startHttp(httpDeps(identity))
    const get = await callHttp(h, { session: 'session-ffffffff-ffff-4fff-8fff-ffffffffffff' })
    assert.equal(get.status, 409, get.text)
    const post = await callHttp(h, {
      method: 'POST',
      session: 'session-ffffffff-ffff-4fff-8fff-ffffffffffff',
      body: { interview_id: fixture.interviewId, payload: { note: 'x' } },
    })
    assert.equal(post.status, 409, post.text)
    await h.close()
  })

  test('本人面试官：POST 保存 → GET 读回最新版本（真 HTTP + 真 DB 独立读回）', async () => {
    const identity = createDemoActorIdentity().identity
    identity.registry.bind(SESSION, 'interviewer_a', { display_name: '面试官 A' })
    const h = await startHttp(httpDeps(identity))
    const post = await callHttp(h, {
      method: 'POST',
      session: SESSION,
      body: { interview_id: fixture.interviewId, payload: { assessments: { BACKEND: 5 }, note: 'HTTP 保存' } },
    })
    assert.equal(post.status, 200, post.text)
    assert.equal((post.body as { record_version: number }).record_version, 3, '前两个版本来自 DB 适配器用例')
    const get = await callHttp(h, { session: SESSION, interviewId: fixture.interviewId })
    assert.equal(get.status, 200, get.text)
    const draft = (get.body as { draft: ScorecardDraftRow }).draft
    assert.equal(draft.record_version, 3)
    assert.deepEqual(draft.payload, { assessments: { BACKEND: 5 }, note: 'HTTP 保存' })
    // 独立 SQL 读回（不信 HTTP 自述）。
    const latest = await withReadOnly(db.pool, (client) =>
      readDraft(client, TENANT, fixture.interviewId, fixture.interviewerActorId))
    assert.equal(latest?.record_version, 3)
    await h.close()
  })

  test('非本人面试官写草稿 → 403 INTERVIEWER_MISMATCH（零写入）', async () => {
    const identity = createDemoActorIdentity().identity
    const otherSession = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    identity.registry.bind(otherSession, 'interviewer_b', { display_name: '面试官 B' })
    const h = await startHttp(httpDeps(identity))
    const before = await withReadOnly(db.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        'select count(*)::text as n from recruitment.scorecard_draft where tenant_id = $1', [TENANT])
      return Number(rows[0]?.n)
    })
    const result = await callHttp(h, {
      method: 'POST',
      session: otherSession,
      body: { interview_id: fixture.interviewId, payload: { note: '越权' } },
    })
    assert.equal(result.status, 403, result.text)
    assert.equal((result.body.error as { reason_code: string }).reason_code, 'ACTOR_NOT_INTERVIEWER')
    const after = await withReadOnly(db.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        'select count(*)::text as n from recruitment.scorecard_draft where tenant_id = $1', [TENANT])
      return Number(rows[0]?.n)
    })
    assert.equal(after, before, '越权必须零写入')
    await h.close()
  })

  test('已提交面评再 POST 草稿 → 409 SCORECARD_ALREADY_SUBMITTED（零写入）', async () => {
    const identity = createDemoActorIdentity().identity
    identity.registry.bind(SESSION, 'interviewer_a', { display_name: '面试官 A' })
    const h = await startHttp(httpDeps(identity))
    const before = await withReadOnly(db.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        'select count(*)::text as n from recruitment.scorecard_draft where tenant_id = $1', [TENANT])
      return Number(rows[0]?.n)
    })
    const result = await callHttp(h, {
      method: 'POST',
      session: SESSION,
      body: { interview_id: fixture.submittedInterviewId, payload: { note: '已提交后写' } },
    })
    assert.equal(result.status, 409, result.text)
    assert.equal((result.body.error as { reason_code: string }).reason_code, 'SCORECARD_ALREADY_SUBMITTED')
    const after = await withReadOnly(db.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        'select count(*)::text as n from recruitment.scorecard_draft where tenant_id = $1', [TENANT])
      return Number(rows[0]?.n)
    })
    assert.equal(after, before, '已提交后写草稿必须零写入')
    await h.close()
  })

  test('payload 超限 → 413 DRAFT_PAYLOAD_TOO_LARGE（零写入）', async () => {
    const identity = createDemoActorIdentity().identity
    identity.registry.bind(SESSION, 'interviewer_a', { display_name: '面试官 A' })
    const h = await startHttp(httpDeps(identity))
    const before = await withReadOnly(db.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        'select count(*)::text as n from recruitment.scorecard_draft where tenant_id = $1', [TENANT])
      return Number(rows[0]?.n)
    })
    const result = await callHttp(h, {
      method: 'POST',
      session: SESSION,
      body: { interview_id: fixture.interviewId, payload: { note: '字'.repeat(11_000) } },
    })
    assert.equal(result.status, 413, result.text)
    const after = await withReadOnly(db.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        'select count(*)::text as n from recruitment.scorecard_draft where tenant_id = $1', [TENANT])
      return Number(rows[0]?.n)
    })
    assert.equal(after, before, '超限必须零写入')
    await h.close()
  })
})
