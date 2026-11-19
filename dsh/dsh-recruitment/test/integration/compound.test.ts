// D-159 复合确认 HTTP 的**真库 + 真 HTTP** 集成测试。
//
// 纪律（与 demo-actor-http.test.ts 同款）：
//   1. 每个文件一个 createIsolatedTestDatabase() 一次性库，结束时 drop；
//   2. 连不上库直接失败（不 skip，R3 要 skipped === 0）；
//   3. 用真实 registerCompoundHttp + 真 registerActorHttp（session→alias 绑定）+ node:http；
//   4. 断言只信独立 SQL 读回（不 import 产品代码自证业务事实）；
//   5. 每个用例独立 application —— 初筛一旦写过就不能重复决定，共用夹具会串扰。
//
// 覆盖：preview 零写入 / 三步全成功 + 库读回 / 执行期失败立刻停（不回滚）/ 幂等重放 /
// 整卡预检失败零写入 / 未知动作 400 UNSUPPORTED_STEP。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  createDemoActorIdentity,
  type DemoActorIdentity,
} from '../../src/demo-actor/index.ts'
import { registerActorHttp } from '../../src/http/actor.ts'
import {
  registerCompoundHttp,
  resetCompoundDedupStateForTests,
} from '../../src/http/compound.ts'
import { createScreeningEvaluateTool } from '../../src/tools/screening-evaluate.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  createIsolatedTestDatabase,
  HR_ACTOR,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'
import { seedScenario, type Scenario } from './db.ts'

const BASE = testDatabaseConfig()
const SESSION_RECRUITER = 'session-11111111-1111-4111-8111-000000000103'
const PATH = '/recruitment/api/action/compound'
/** 合法 rubric 维度（shape 照 screening.test.ts；work_experience present 满足它）。 */
const DIMENSIONS = [{
  key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1,
  field: 'work_experience', operator: 'EXISTS', value: true,
}]

interface CaseFixture {
  readonly screening: Scenario
  readonly schedule: Scenario
  readonly evaluation: Record<string, unknown>
}

const FIXTURES = new Map<string, CaseFixture>()

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let server: TestServer

interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

interface TestServer {
  readonly port: number
  close(): Promise<void>
}

before(async () => {
  db = await createIsolatedTestDatabase('compound')
  cfg = { ...BASE, database: db.name, actor_id: HR_ACTOR }
  const created = createDemoActorIdentity()
  identity = created.identity

  // 六个用例各自的申请：screening 写过的申请不复用（初筛 already-decided 守卫）。
  const cases = ['preview', 'ok', 'replay', 'stop', 'blocked', 'unknown']
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    for (const label of cases) {
      const screening = await seedScenario(client, { dimensions: DIMENSIONS })
      const schedule = await seedScenario(client, { dimensions: DIMENSIONS })
      FIXTURES.set(label, { screening, schedule, evaluation: {} })
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }

  // 用既有 screening-evaluate 工具为每个用例算出真实评估摘要（不是手编 digest）。
  const evalTool = createScreeningEvaluateTool(cfg)
  for (const label of cases) {
    const fixture = FIXTURES.get(label) as CaseFixture
    const output = await evalTool.execute(
      { application_id: fixture.screening.applicationId }, {},
    ) as Record<string, unknown>
    const snapshot = output.snapshot as Record<string, unknown> | undefined
    assert.ok(typeof output.evaluation_digest === 'string' && /^[0-9a-f]{64}$/.test(output.evaluation_digest),
      `${label} 评估工具必须给出真实 evaluation_digest`)
    assert.ok(snapshot !== undefined, `${label} 评估工具必须给出 snapshot`)
    assert.equal(output.verdict, 'PASS', `${label} 夹具评估应为 PASS（真实评估路径）`)
    Object.assign(fixture.evaluation, {
      kind: 'SCREENING_EVALUATION',
      evaluation_digest: output.evaluation_digest,
      verdict: output.verdict,
      rubric_version_id: snapshot.rubric_version_id,
      rubric_payload_hash: snapshot.rubric_payload_hash,
      resume_version_id: snapshot.resume_version_id,
      resume_content_sha256: snapshot.resume_content_sha256,
      criteria_evaluated: true,
    })
  }

  server = await startCompoundServer()
  const bound = await http('PUT', '/recruitment/api/actor', {
    body: { alias: 'recruiter' },
    session: SESSION_RECRUITER,
  })
  assert.equal(bound.status, 200, `绑定 recruiter 应 200：${bound.text}`)
})

after(async () => {
  if (server !== undefined) await server.close()
  if (db !== undefined) await db.drop()
})

/** 真 node:http server，注册 compound + actor 路由（与 DSH webServer.register 同形）。 */
async function startCompoundServer(): Promise<TestServer> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const webServer = {
    host: '127.0.0.1',
    port: 0,
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
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
  // port 只有 listen 之后才知道；用同一个 holder 给两个 register 传真实端口。
  const holder = { host: '127.0.0.1', port, register: webServer.register }
  registerCompoundHttp({ webServer: holder }, { database: cfg, databaseIssues: [], identity })
  registerActorHttp({ webServer: holder }, { database: cfg, databaseIssues: [], identity })
  return {
    port,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 同源 + session 的请求（POST body 自动序列化）。 */
async function http(
  method: string,
  path: string,
  options: { readonly body?: unknown; readonly session?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    'x-recruitment-request': '1',
    host: `127.0.0.1:${server.port}`,
    origin: `http://127.0.0.1:${server.port}`,
  }
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method, headers, body: payload,
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body, text }
}

function post(body: unknown): Promise<HttpResult> {
  return http('POST', PATH, { body, session: SESSION_RECRUITER })
}

/** 三步合法计划（每个 label 用独立申请，避免初筛 already-decided 串扰）。 */
function plan(label: string): Record<string, unknown> {
  const fixture = FIXTURES.get(label) as CaseFixture
  // 固定未来时间 + 每个用例错开时段：同一 label 的两次 plan() 逐字相同 → 指纹稳定；
  // 不同 label 不共用面试官+时段，避免排期工具的 CONFLICT_SLOT 跨用例串扰。
  const offsets: Record<string, number> = {
    preview: 0, ok: 2, replay: 4, stop: 6, blocked: 8, unknown: 10,
  }
  const startHour = 9 + (offsets[label] ?? 0)
  const start = `2030-01-01T${String(startHour).padStart(2, '0')}:00:00+08:00`
  const end = `2030-01-01T${String(startHour).padStart(2, '0')}:30:00+08:00`
  return {
    confirmation_text: `确认按此计划执行-${label}`,
    preview_only: false,
    steps: [
      {
        action: 'screening_decide',
        application_id: fixture.screening.applicationId,
        result: 'PASS',
        reason: '真实评估：硬性条件满足、排除条件未命中',
        evaluation: fixture.evaluation,
      },
      {
        action: 'candidate_constraint',
        application_id: fixture.screening.applicationId,
        kind: 'PIN',
        text: '面试时重点确认异步管线经验（测试夹具）',
        source: 'CHAT',
      },
      {
        action: 'interview_schedule',
        application_id: fixture.schedule.applicationId,
        intent: 'CREATE',
        scheduled_start_at: start,
        scheduled_end_at: end,
        interviewer_actor_ids: [HR_ACTOR],
      },
    ],
  }
}

async function count(table: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(
    `select count(*)::int as n from recruitment.${table} where tenant_id = $1`,
    [TENANT],
  )
  return rows[0]?.n ?? -1
}

test('preview_only:true 返回预检与摘要，零写入', async () => {
  const before = {
    decision: await count('decision'),
    constraint: await count('candidate_constraint'),
    interview: await count('interview'),
  }
  const body = plan('preview')
  body.preview_only = true
  const result = await post(body)
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.preview, true)
  assert.equal(result.body.all_ok, true, JSON.stringify(result.body))
  const steps = result.body.steps as Record<string, unknown>[]
  assert.equal(steps.length, 3)
  assert.deepEqual(steps.map((s) => s.action), ['screening_decide', 'candidate_constraint', 'interview_schedule'])
  for (const step of steps) {
    assert.equal(step.ok, true)
    assert.equal(step.blocked_reason, '')
    assert.ok((step.summary as Record<string, unknown>).will_do)
  }
  assert.equal(await count('decision'), before.decision)
  assert.equal(await count('candidate_constraint'), before.constraint)
  assert.equal(await count('interview'), before.interview)
})

test('preview_only:false 三步全成功，DB 独立读回三条事实', async () => {
  const fixture = FIXTURES.get('ok') as CaseFixture
  const result = await post(plan('ok'))
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.succeeded, 3, JSON.stringify(result.body))
  assert.equal(result.body.failed, 0)
  assert.deepEqual(result.body.not_executed, [])
  assert.equal(result.body.replay, false)

  const decisions = await db.pool.query<{ result: string }>(
    `select result from recruitment.decision
      where tenant_id = $1 and application_id = $2 and decision_scope = 'SCREENING'`,
    [TENANT, fixture.screening.applicationId],
  )
  assert.equal(decisions.rows.length, 1, '初筛决策恰好一条')
  assert.equal(decisions.rows[0]?.result, 'ADVANCE', 'PASS 映射成 ADVANCE')

  const constraints = await db.pool.query<{ kind: string }>(
    `select kind from recruitment.candidate_constraint
      where tenant_id = $1 and application_id = $2`,
    [TENANT, fixture.screening.applicationId],
  )
  assert.equal(constraints.rows.length, 1, '约束恰好一条')
  assert.equal(constraints.rows[0]?.kind, 'PIN')

  const interviews = await db.pool.query<{ status: string }>(
    `select status from recruitment.interview
      where tenant_id = $1 and application_id = $2`,
    [TENANT, fixture.schedule.applicationId],
  )
  assert.equal(interviews.rows.length, 1, '面试恰好一场')
  assert.equal(interviews.rows[0]?.status, 'SCHEDULED')
})

test('同一 confirmation_text + 同 steps 重复提交 → replay:true，DB 行数不增长', async () => {
  const body = plan('replay')
  const first = await post(body)
  assert.equal(first.status, 200, first.text)
  assert.equal(first.body.succeeded, 3, JSON.stringify(first.body))
  const before = {
    decision: await count('decision'),
    constraint: await count('candidate_constraint'),
    interview: await count('interview'),
  }
  const second = await post(body)
  assert.equal(second.status, 200, second.text)
  assert.equal(second.body.replay, true, JSON.stringify(second.body))
  assert.equal(second.body.notes, '这件事已经处理过了（这次没有重复执行）')
  assert.equal(await count('decision'), before.decision)
  assert.equal(await count('candidate_constraint'), before.constraint)
  assert.equal(await count('interview'), before.interview)
})

test('模拟 Host 重启（内存 dedup 丢失）：同指纹再提交被守卫拦住，数据安全、文案不说"已完成"', async () => {
  const replayBody = plan('replay')
  const before = {
    decision: await count('decision'),
    constraint: await count('candidate_constraint'),
    interview: await count('interview'),
  }
  // 真实重启会得到一个全新的空 Map；这里用测试钩子显式模拟同一效果。
  resetCompoundDedupStateForTests()
  const afterRestart = await post(replayBody)
  assert.equal(afterRestart.status, 400, afterRestart.text)
  const error = afterRestart.body.error as Record<string, unknown>
  assert.equal(error.code, 'COMPOUND_PRECONDITION_FAILED')
  const message = String(error.message)
  assert.ok(message.includes('已经有过初筛结论'), `应如实说人话被守卫拦住：${message}`)
  assert.ok(!message.includes('已完成'), `不能把被拒绝说成已完成：${message}`)
  assert.equal(await count('decision'), before.decision, '没有重复决策')
  assert.equal(await count('candidate_constraint'), before.constraint, '没有重复约束')
  assert.equal(await count('interview'), before.interview, '没有重复排期')
})

test('执行期失败立刻停：只落第一步，后续不执行，不回滚', async () => {
  const fixture = FIXTURES.get('stop') as CaseFixture
  const before = {
    decision: await count('decision'),
    constraint: await count('candidate_constraint'),
    interview: await count('interview'),
  }
  const body = plan('stop')
  const steps = body.steps as Record<string, unknown>[]
  // 第二步改成过去时间：结构预检过，排期工具事务里 START_IN_PAST 拒绝。
  steps[1] = {
    action: 'interview_schedule',
    application_id: fixture.schedule.applicationId,
    intent: 'CREATE',
    scheduled_start_at: '2020-01-01T09:00:00+08:00',
    scheduled_end_at: '2020-01-01T09:30:00+08:00',
    interviewer_actor_ids: [HR_ACTOR],
  }
  // 第三步换成另一份申请的 constraint（预检过，但不能被执行）。
  steps[2] = {
    action: 'candidate_constraint',
    application_id: fixture.schedule.applicationId,
    kind: 'PIN',
    text: '不应被执行（测试夹具）',
    source: 'CHAT',
  }
  const result = await post(body)
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.failed, 1, JSON.stringify(result.body))
  assert.equal(result.body.succeeded, 1)
  assert.equal(result.body.stopped_at, 1)
  assert.deepEqual(result.body.not_executed, [2])
  const outcomes = result.body.steps as Record<string, unknown>[]
  assert.equal(outcomes[0]?.ok, true)
  assert.equal(outcomes[1]?.ok, false)
  assert.ok(typeof outcomes[1]?.reason_code === 'string')

  assert.equal(await count('decision'), before.decision + 1, '第一步写保留，不回滚')
  assert.equal(await count('interview'), before.interview, '失败步骤零写')
  assert.equal(await count('candidate_constraint'), before.constraint, '后续步骤未执行')
})

test('整卡预检失败：第二步申请不存在 → 400，零写入', async () => {
  const before = {
    decision: await count('decision'),
    constraint: await count('candidate_constraint'),
    interview: await count('interview'),
  }
  const body = plan('blocked')
  const steps = body.steps as Record<string, unknown>[]
  steps[1] = {
    action: 'candidate_constraint',
    application_id: '22222222-2222-4222-8222-222222222222',
    kind: 'PIN',
    text: '申请不存在，应整卡拒绝',
    source: 'CHAT',
  }
  const result = await post(body)
  assert.equal(result.status, 400, result.text)
  assert.equal((result.body.error as Record<string, unknown>).code, 'COMPOUND_PRECONDITION_FAILED')
  assert.equal(await count('decision'), before.decision)
  assert.equal(await count('candidate_constraint'), before.constraint)
  assert.equal(await count('interview'), before.interview)
})

test('未知动作 → 400 UNSUPPORTED_STEP', async () => {
  const fixture = FIXTURES.get('unknown') as CaseFixture
  const before = await count('decision')
  const result = await post({
    confirmation_text: '未知动作',
    preview_only: false,
    steps: [{ action: 'delete_everything', application_id: fixture.screening.applicationId }],
  })
  assert.equal(result.status, 400, result.text)
  assert.equal((result.body.error as Record<string, unknown>).code, 'UNSUPPORTED_STEP')
  assert.equal(await count('decision'), before)
})
