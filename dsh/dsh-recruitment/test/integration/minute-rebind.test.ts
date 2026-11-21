// 妙记录音归属改绑 · 真库集成测试（一次性库，0001→0023 全量重放；结束 drop）。
//
// 覆盖：
//   ① 审计行 append-only（禁删/整行不可改由库触发器强制）；
//   ② 幂等唯一键 (tenant, interview, minute_token, to_actor) + HTTP 层幂等（第二次不再调 CLI）；
//   ③ 真 HTTP：session→actor + 本人是这场面试官 + from/to 是同场面试官 → dry-run 成功写审计；
//   ④ 负例：非本人面试官 / CLI 非零 → 403/502 且审计表零写入（fail-closed，绝不报成功）；
//   ⑤ CLI 用假 runner 注入（不发起真实外部写）；
//   ⑥ verify.sql 的 REBIND-STRUCT 断言在真库上跑通（见 work/d5/minute-rebind/REPORT.md）。
import test, { before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  createIsolatedTestDatabase,
  TENANT,
  seedScenario,
  type IsolatedTestDatabase,
} from './db.ts'
import {
  appendMinuteRebind,
  findByIdempotencyKey,
} from '../../src/db/minute-rebind.ts'
import {
  MINUTE_REBIND_CONTRACT,
  registerMinuteRebindHttp,
  type MinuteRebindHttpDeps,
  type RebindActorIdentity,
} from '../../src/http/minute-rebind.ts'
import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { withActor, withReadOnly } from '../../src/db/pool.ts'
import { sha256Text } from '../../src/domain/criterion-override.ts'
import type { RebindCliRunner, RebindRunResult } from '../../src/connectors/feishu/rebind.ts'

const SESSION_FROM = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_OTHER = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ACTOR_FROM = '11111111-1111-4111-8111-000000000104' // interviewer_a（默认 actor 映射）
const ACTOR_TO = '11111111-1111-4111-8111-000000000105'   // interviewer_b
const ACTOR_OTHER = '11111111-1111-4111-8111-000000000103' // HR（非本场面试官）
const MINUTE = 'obcnSyntheticTokenForIntegration001'
const IDENTITIES: Record<string, RebindActorIdentity> = {
  [ACTOR_FROM]: { from_speaker_id: 'sp_synthetic_old_int', to_user_id: 'ou_synthetic_from_int' },
  [ACTOR_TO]: { from_speaker_id: 'sp_synthetic_new_int', to_user_id: 'ou_synthetic_new_int' },
}

interface Fixture {
  readonly interviewId: string
}
let db: IsolatedTestDatabase
let fixture: Fixture

/** 假 CLI runner（仅记录调用次数；不发起真实外部写）。 */
function fakeRunner(result: RebindRunResult = { status: 'OK', exit_code: 0, signal: null, stdout: '{}', stderr: '' }) {
  const calls: string[][] = []
  const runner: RebindCliRunner = async (invocation) => {
    calls.push([...invocation.args])
    return result
  }
  return { runner, calls }
}

async function seedInterview(): Promise<string> {
  const client = await db.pool.connect()
  try {
    const scenario = await seedScenario(client, {
      dimensions: [{ key: 'BACKEND', label: '后端', kind: 'RUBRIC', weight: 1 }],
    })
    const { rows } = await client.query<{ id: string }>(
      `insert into recruitment.interview
          (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at, scheduled_end_at, timezone)
        values ($1, $2, 1, 'DEFAULT', 'SCHEDULED', now() - interval '1 hour', now(), 'Asia/Shanghai')
        returning id::text as id`,
      [TENANT, scenario.applicationId],
    )
    const id = rows[0]?.id
    assert.ok(typeof id === 'string')
    // 0023 依赖的面试官 B（…0105）不在 0002 seed 里，测试自己补（与 interviewer-overview 同款）。
    await client.query(
      `insert into recruitment.actor (id, tenant_id, kind, display_name)
       values ($1, $2, 'HUMAN', '集成测试-面试官B')
       on conflict (id) do nothing`,
      [ACTOR_TO, TENANT],
    )
    for (const actor of [ACTOR_FROM, ACTOR_TO]) {
      await client.query(
        `insert into recruitment.interviewer (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard)
          values ($1, $2, $3, 'TECH_LEAD', true)`,
        [TENANT, id, actor],
      )
    }
    return id
  } finally {
    client.release()
  }
}

before(async () => {
  db = await createIsolatedTestDatabase('minute_rebind')
  fixture = { interviewId: await seedInterview() }
})

after(async () => {
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------
//  DB 适配器层（append-only + 幂等唯一键）
// ---------------------------------------------------------------------

describe('minute_rebind · 真库 DB 适配器', () => {
  test('写一行 → 独立读回；append-only 禁删/禁改由库触发器强制', async () => {
    const confirmation = '我确认把这场面试的妙记录音归属改给新面试官'
    const params = {
      tenant_id: TENANT,
      interview_id: fixture.interviewId,
      from_actor_id: ACTOR_FROM,
      to_actor_id: ACTOR_TO,
      requested_by_actor_id: ACTOR_FROM,
      minute_token: MINUTE,
      confirmation_text_sha256: sha256Text(confirmation),
      cli_summary: { dry_run: true, status: 'DRY_RUN', exit_code: 0, stderr_head: '', stderr_bytes_seen: 0, truncated: false, stdout_bytes: 2, external_write: false },
      dry_run: true,
    }
    const written = await withActor(db.pool, ACTOR_FROM, (client) => appendMinuteRebind(client, params))
    const found = await withReadOnly(db.pool, (client) =>
      findByIdempotencyKey(client, TENANT, fixture.interviewId, MINUTE, ACTOR_TO))
    assert.equal(found.found, true)
    if (!found.found) return
    assert.equal(found.record.id, written.rebind_id)
    assert.equal(found.record.confirmation_text_sha256, sha256Text(confirmation))
    assert.equal(found.record.dry_run, true)

    // 禁删
    await assert.rejects(
      withActor(db.pool, ACTOR_FROM, async (client) => {
        await client.query('delete from recruitment.minute_rebind where id = $1::uuid', [written.rebind_id])
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes('DELETE_FORBIDDEN')
      },
    )
    // 整行不可改
    await assert.rejects(
      withActor(db.pool, ACTOR_FROM, async (client) => {
        await client.query("update recruitment.minute_rebind set minute_token = 'obcnChanged' where id = $1::uuid", [written.rebind_id])
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes('IMMUTABLE_COLUMN')
      },
    )
  })

  test('同一幂等键再 INSERT → FORBIDDEN/REBIND_ALREADY_DONE（并发兜底）', async () => {
    const confirmation = '重复提交'
    const params = {
      tenant_id: TENANT,
      interview_id: fixture.interviewId,
      from_actor_id: ACTOR_FROM,
      to_actor_id: ACTOR_TO,
      requested_by_actor_id: ACTOR_FROM,
      minute_token: MINUTE,
      confirmation_text_sha256: sha256Text(confirmation),
      cli_summary: { dry_run: true, status: 'DRY_RUN', external_write: false },
      dry_run: true,
    }
    await assert.rejects(
      withActor(db.pool, ACTOR_FROM, (client) => appendMinuteRebind(client, params)),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes('REBIND_ALREADY_DONE')
      },
    )
  })
})

// ---------------------------------------------------------------------
//  真 HTTP（短连接池 + 假 CLI runner；不发起真实外部写）
// ---------------------------------------------------------------------

interface Harness {
  readonly baseUrl: string
  readonly dispose: () => void
  close(): Promise<void>
}
async function startServer(deps: MinuteRebindHttpDeps): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    Promise.resolve().then(() => handler(req, res)).catch(() => res.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const dispose = registerMinuteRebindHttp(
    { webServer: { host: '127.0.0.1', port, register(route) { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } } } },
    deps,
  )
  return {
    baseUrl: `http://127.0.0.1:${port}`, dispose,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

function depsFor(identity: DemoActorIdentity, runner: RebindCliRunner): MinuteRebindHttpDeps {
  return {
    database: {
      host: '127.0.0.1', port: 5432, user: 'postgres', database: db.name,
      password: process.env.RECRUITMENT_DB_PASSWORD ?? '', password_env: 'RECRUITMENT_DB_PASSWORD',
      tenant_id: TENANT, actor_id: ACTOR_FROM, statement_timeout_ms: 15_000,
      connect_timeout_ms: 10_000, max: 2,
    },
    databaseIssues: [],
    identity,
    connector: { runner },
    identities: IDENTITIES,
  }
}

function bodyFor(interviewId: string, overrides: Record<string, unknown> = {}) {
  return {
    interview_id: interviewId,
    from_actor_id: ACTOR_FROM,
    to_actor_id: ACTOR_TO,
    minute_token: MINUTE,
    confirmation_text: '我确认把这场面试的妙记录音归属改给新面试官',
    ...overrides,
  }
}

async function post(h: Harness, session: string, body: unknown) {
  const response = await fetch(`${h.baseUrl}${MINUTE_REBIND_CONTRACT.path}`, {
    method: 'POST',
    headers: { 'x-recruitment-request': '1', 'x-dsh-session': session, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { parsed = { raw: text } }
  return { status: response.status, body: parsed, text }
}

async function auditCount(interviewId: string, minuteToken: string): Promise<number> {
  return withReadOnly(db.pool, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from recruitment.minute_rebind
        where tenant_id = $1 and interview_id = $2 and minute_token = $3`,
      [TENANT, interviewId, minuteToken],
    )
    return Number(rows[0]?.n ?? 0)
  })
}

describe('minute_rebind · 真 HTTP（dry-run 唯一路径）', () => {
  test('本人面试官 + dry-run → 200，写一条审计行，CLI 调用一次且带 --dry-run', async () => {
    const interviewId = await seedInterview()
    const minuteToken = `obcnHttpDryRun${Date.now()}`
    const { runner, calls } = fakeRunner()
    const identity = createDemoActorIdentity().identity
    identity.registry.bind(SESSION_FROM, 'interviewer_a', { display_name: '面试官 A' })
    const h = await startServer(depsFor(identity, runner))
    const result = await post(h, SESSION_FROM, bodyFor(interviewId, { minute_token: minuteToken }))
    assert.equal(result.status, 200, result.text)
    assert.equal(result.body.already_done, false)
    assert.ok(typeof result.body.rebind_id === 'string')
    assert.equal(result.body.dry_run, true)
    assert.equal(calls.length, 1, '真实 CLI 只调用一次（dry-run）')
    assert.ok(calls[0]?.includes('--dry-run'))
    assert.ok(calls[0]?.includes('--profile'))
    assert.ok(!calls[0]?.includes('--yes'))
    assert.equal(await auditCount(interviewId, minuteToken), 1)
    h.dispose(); await h.close()
  })

  test('幂等：同一 (interview, minute, to) 再提交 → 200 already_done=true，CLI 不再调用、零新增审计', async () => {
    const interviewId = await seedInterview()
    const minuteToken = `obcnIdempotent${Date.now()}`
    const { runner, calls } = fakeRunner()
    const identity = createDemoActorIdentity().identity
    identity.registry.bind(SESSION_FROM, 'interviewer_a', { display_name: '面试官 A' })
    const h = await startServer(depsFor(identity, runner))
    const first = await post(h, SESSION_FROM, bodyFor(interviewId, { minute_token: minuteToken }))
    assert.equal(first.status, 200, first.text)
    const second = await post(h, SESSION_FROM, bodyFor(interviewId, { minute_token: minuteToken }))
    assert.equal(second.status, 200, second.text)
    assert.equal(second.body.already_done, true)
    assert.equal(calls.length, 1, '第二次提交不再调 CLI')
    assert.equal(await auditCount(interviewId, minuteToken), 1, '审计表不新增行')
    h.dispose(); await h.close()
  })

  test('非本场面试官 → 403 ACTOR_NOT_INTERVIEWER，CLI 零调用、审计零写入', async () => {
    const interviewId = await seedInterview()
    const minuteToken = `obcnForbidden${Date.now()}`
    const { runner, calls } = fakeRunner()
    const identity = createDemoActorIdentity().identity
    identity.registry.bind(SESSION_OTHER, 'recruiter', { display_name: 'HR' })
    const h = await startServer(depsFor(identity, runner))
    const result = await post(h, SESSION_OTHER, bodyFor(interviewId, { minute_token: minuteToken }))
    assert.equal(result.status, 403, result.text)
    const error = result.body.error as Record<string, unknown>
    assert.equal(error.reason_code, 'ACTOR_NOT_INTERVIEWER')
    assert.equal(calls.length, 0)
    assert.equal(await auditCount(interviewId, minuteToken), 0)
    h.dispose(); await h.close()
  })

  test('CLI 非零退出 → 502 REBIND_FAILED + 脱敏 stderr，绝不报成功，审计零写入', async () => {
    const interviewId = await seedInterview()
    const minuteToken = `obcnFailed${Date.now()}`
    const { runner, calls } = fakeRunner({
      status: 'NON_ZERO_EXIT', exit_code: 3,
      signal: null, stdout: '', stderr: '{"msg":"候选人张三的面评内容不能外泄"} speaker replace failed',
    })
    const identity = createDemoActorIdentity().identity
    identity.registry.bind(SESSION_FROM, 'interviewer_a', { display_name: '面试官 A' })
    const h = await startServer(depsFor(identity, runner))
    const result = await post(h, SESSION_FROM, bodyFor(interviewId, { minute_token: minuteToken }))
    assert.equal(result.status, 502, result.text)
    const error = result.body.error as Record<string, unknown>
    assert.equal(error.code, 'REBIND_FAILED')
    assert.ok(!result.text.includes('张三'), 'stderr 必须脱敏')
    assert.equal(calls.length, 1)
    assert.equal(await auditCount(interviewId, minuteToken), 0, '失败路径零审计写入')
    h.dispose(); await h.close()
  })

  test('dry_run=false → 400 REAL_WRITE_NOT_ALLOWED，CLI 零调用、审计零写入', async () => {
    const interviewId = await seedInterview()
    const minuteToken = `obcnRealWrite${Date.now()}`
    const { runner, calls } = fakeRunner()
    const identity = createDemoActorIdentity().identity
    identity.registry.bind(SESSION_FROM, 'interviewer_a', { display_name: '面试官 A' })
    const h = await startServer(depsFor(identity, runner))
    const result = await post(h, SESSION_FROM, bodyFor(interviewId, { minute_token: minuteToken, dry_run: false }))
    assert.equal(result.status, 400, result.text)
    const error = result.body.error as Record<string, unknown>
    assert.equal(error.reason_code, 'REAL_WRITE_NOT_ALLOWED')
    assert.equal(calls.length, 0)
    assert.equal(await auditCount(interviewId, minuteToken), 0)
    h.dispose(); await h.close()
  })
})
