// D5 决策 facts / screening-evaluate / record facade 的**真库 + 真 HTTP** 集成测试。
//
// 覆盖 `work/d5/decision/CONTRACT.md`（W2b 逐字消费口径）与 task-56 验收：
//   a. GET  /recruitment/api/decision/facts             → 200；job/rubric payload_hash 与独立 SQL 逐字一致；
//      authority / stage_code / missing / basis / screening_evaluation / evaluation_summary 结构；
//      无材料种子（0701）→ screening_evaluation=null 且 missing 区分 UNAVAILABLE。
//   b. POST /recruitment/api/decision/screening/evaluate → 200；evaluation digest 64hex、rubric hash 与 SQL 一致；
//      readback.persisted=false 如实（domain 只读）；前后 decision 行数不变。
//   c. POST /recruitment/api/decision/record            → FINAL HOLD 200；独立 SQL 读回 decision 行
//      （scope/result/stage_code/actor/record_version/basis_refs hash）；重复 → 409 零写入。
//   d. 负例族：缺 session 400 / 未绑定 409 / interviewer_a 403 / 客户端传 hash 400 /
//      actor 覆盖 400 / 同源 403 / 方法 405 / 非法 uuid 400 / 申请不存在 404 / 缺参 400 /
//      ADVANCE 无面评 4xx；每项断言目标表行数不变。
//
// 纪律：
//   1. 独占一个 `createIsolatedTestDatabase('d5decision')` 一次性库（不写 ra_s6s7），跑完 drop；
//   2. 真迁移 0001→0016 + `scripts/bootstrap-demo.mjs` 种子；
//   3. 真 `node:http` 监听 127.0.0.1:0，注册**真实** `registerDecisionHttp` + `registerActorHttp`；
//   4. 断言只用独立 SQL（`db.pool.query`），不 import 产品读投影。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerActorHttp } from '../../src/http/actor.ts'
import { DECISION_PATHS, registerDecisionHttp } from '../../src/http/decision-read.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  criterion,
  parsedFields,
  seedScenario,
  TENANT,
  HR_ACTOR,
  testDatabaseConfig,
  type IsolatedTestDatabase,
  type Scenario,
} from './db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const BOOTSTRAP_SCRIPT = join(REPO_ROOT, 'scripts', 'bootstrap-demo.mjs')
const BASE = testDatabaseConfig()

const SESSION_R = 'session-d5dec000-0000-4000-8000-00000000c001'
const SESSION_A = 'session-d5dec000-0000-4000-8000-00000000a001'
const SESSION_UNBOUND = 'session-d5dec000-0000-4000-8000-00000000ff01'
const DEMO_APPLICATION_0701 = '11111111-1111-4111-8111-000000000701'

const WORK_EXISTS = {
  key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.6,
  field: 'work_experience', operator: 'EXISTS', value: true,
}
const MONTHS_LTE60 = {
  key: 'too_short', label: '不足 60 个月即排除', kind: 'DISQUALIFIER', weight: 0.4,
  field: 'timeline.covered_months_closed', operator: 'LTE', value: 60,
}

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let harness: Harness
let scenario: Scenario
let pinnedRubricHash = ''
let jobPayloadHash = ''

interface Harness {
  readonly baseUrl: string
  readonly registered: ReadonlyArray<{ kind: string; path: string }>
  close(): Promise<void>
}

interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

test.before(async () => {
  db = await createIsolatedTestDatabase('d5decision')
  assertPrivateDatabase(db.name)
  assert.ok(db.migrations.length >= 16, `迁移应 >=16，实际 ${db.migrations.length}`)
  cfg = { ...BASE, database: db.name }

  const boot = await runBootstrap(db.name)
  assert.equal(boot.code, 0, `bootstrap 必须 exit 0；实际 code=${String(boot.code)}\n${boot.stdout.slice(-2000)}\n${boot.stderr.slice(-2000)}`)

  // 提交事务里造一份"材料已绑定 + rubric 已批准 + 已钉住"的完整夹具（真提交，供跨连接 HTTP 读）。
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    scenario = await seedScenario(client, {
      dimensions: [WORK_EXISTS, MONTHS_LTE60].map(criterion),
      fields: parsedFields({ entryCount: 1 }),
      approve: true,
      pinRubric: true,
      bindMaterial: true,
    })
    await client.query('commit')
  } finally {
    client.release()
  }
  const pinned = await query<{ rubric_payload_hash: string; job_payload_hash: string }>(
    `select rv.payload_hash as rubric_payload_hash, jv.payload_hash as job_payload_hash
       from recruitment.application a
       join recruitment.rubric_version rv on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id
       join recruitment.job_version jv on jv.id = a.job_version_id and jv.tenant_id = a.tenant_id
      where a.id = $1::uuid and a.tenant_id = $2::uuid`,
    [scenario.applicationId, TENANT],
  )
  pinnedRubricHash = pinned[0]?.rubric_payload_hash ?? ''
  jobPayloadHash = pinned[0]?.job_payload_hash ?? ''
  assert.match(pinnedRubricHash, /^[0-9a-f]{64}$/)
  assert.match(jobPayloadHash, /^[0-9a-f]{64}$/)

  identity = createDemoActorIdentity().identity
  harness = await startHarness()

  // 真路由注册表：3 条 decision exact path（W0 接线 patch 落地后宿主走同一注册函数）。
  const decisionRoutes = harness.registered.filter((route) => route.path.startsWith('/recruitment/api/decision'))
  assert.equal(decisionRoutes.length, 3, `decision exact 路由应 3 条，实际 ${decisionRoutes.map((route) => route.path).join(', ')}`)
  for (const path of [DECISION_PATHS.facts, DECISION_PATHS.screeningEvaluate, DECISION_PATHS.record]) {
    assert.ok(decisionRoutes.some((route) => route.path === path), `缺路由 ${path}`)
  }

  for (const [session, alias] of [[SESSION_R, 'recruiter'], [SESSION_A, 'interviewer_a']] as const) {
    const put = await httpCall('PUT', '/recruitment/api/actor', { session, body: { alias } })
    assert.equal(put.status, 200, `绑定 ${alias} 应 200：${put.text}`)
  }
})

test.after(async () => {
  if (harness !== undefined) await harness.close()
  if (db !== undefined) await db.drop()
})

test('facts：钉住的 job/rubric payload_hash 与独立 SQL 逐字一致，且不编造评估 digest', async () => {
  const result = await httpCall('GET', `${DECISION_PATHS.facts}?application_id=${scenario.applicationId}`, { session: SESSION_R })
  assert.equal(result.status, 200, `facts 期望 200：${result.text.slice(0, 1200)}`)
  const body = result.body
  assert.equal(body.contract_version, 'decision-facts 1.0.0')
  assert.equal(body.readonly, true)
  assert.equal(body.application_id, scenario.applicationId)
  assert.equal(body.stage_code, 'S7')

  assert.equal(body.job?.job_payload_hash, jobPayloadHash, 'job.job_payload_hash 必须 = 库里的 job_version.payload_hash')
  assert.equal(body.rubric?.payload_hash, pinnedRubricHash, 'rubric.payload_hash 必须 = 库里的 rubric_version.payload_hash')
  assert.equal(body.basis?.screening_decide?.rubric_version?.payload_hash, pinnedRubricHash)
  assert.equal(body.authority?.actor_id, HR_ACTOR)
  assert.equal(typeof body.authority?.is_hiring_manager, 'boolean')

  // 有材料夹具：现场只读评估可算出真实 digest（不是编造；work/d5/decision/CONTRACT.md §1 的 JSON 形态）
  assert.equal(body.screening_evaluation_state, 'LIVE_COMPUTED')
  assert.ok(body.screening_evaluation !== null, 'screening_evaluation 不该为 null')
  assert.match(body.screening_evaluation.evaluation_digest, /^[0-9a-f]{64}$/)
  assert.ok(['PASS', 'FAIL', 'NEEDS_REVIEW'].includes(body.screening_evaluation.verdict))
  assert.equal(body.screening_evaluation.rubric_payload_hash, pinnedRubricHash)
  assert.equal(body.screening_evaluation.persisted, false)
  assert.equal(body.basis?.screening_decide?.screening_evaluation?.evaluation_digest, body.screening_evaluation.evaluation_digest)

  // S10 汇总（FINAL 口径）可算：as_of + summary_digest 是真实值
  assert.equal(body.evaluation_summary_state, 'COMPUTED')
  assert.match(body.evaluation_summary?.summary_digest ?? '', /^[0-9a-f]{64}$/)
  assert.equal(body.basis?.decision_record?.summary_digest, body.evaluation_summary.summary_digest)
  assert.ok(Array.isArray(body.missing))
})

test('facts：无材料申请 → screening_evaluation=null 且 missing 区分「不可计算」', async () => {
  const result = await httpCall('GET', `${DECISION_PATHS.facts}?application_id=${DEMO_APPLICATION_0701}`, { session: SESSION_R })
  assert.equal(result.status, 200, `facts 期望 200：${result.text.slice(0, 1200)}`)
  const body = result.body
  assert.equal(body.screening_evaluation, null)
  assert.equal(body.screening_evaluation_state, 'UNAVAILABLE')
  const missing = (body.missing as Array<{ key: string; reason: string }>)
  const evaluationMissing = missing.find((entry) => entry.key === 'screening_evaluation')
  assert.ok(evaluationMissing !== undefined, 'missing 必须含 screening_evaluation')
  assert.match(evaluationMissing.reason, /^SCREENING_EVALUATION_UNAVAILABLE:/, 'missing 原因必须能区分「不可计算」')
  // 不能给假 basis：评估缺失时 screening_decide.screening_evaluation 必须为 null
  assert.equal(body.basis?.screening_decide?.screening_evaluation, null)
})

test('evaluate：200 + evaluation 事实 + 独立 DB 读回（零写入）', async () => {
  const before = await countRows('decision')
  const result = await httpCall('POST', DECISION_PATHS.screeningEvaluate, {
    session: SESSION_R,
    body: { application_id: scenario.applicationId },
  })
  assert.equal(result.status, 200, `evaluate 期望 200：${result.text.slice(0, 1600)}`)
  const body = result.body
  assert.equal(body.contract_version, 'decision-evaluate 1.0.0')
  assert.equal(body.application_id, scenario.applicationId)
  assert.match(body.evaluation?.evaluation_digest ?? '', /^[0-9a-f]{64}$/)
  assert.ok(['PASS', 'FAIL', 'NEEDS_REVIEW'].includes(body.evaluation?.verdict))
  assert.equal(body.evaluation?.rubric_payload_hash, pinnedRubricHash)
  assert.equal(body.evaluation?.rubric_version_id, (await query<{ id: string }>(
    'select rubric_version_id::text as id from recruitment.application where id = $1::uuid and tenant_id = $2::uuid',
    [scenario.applicationId, TENANT],
  ))[0]?.id)
  // 只读 domain：不落表；readback 必须如实标注 persisted=false 并给独立 DB 主体事实
  assert.equal(body.readback?.table, 'screening_evaluation')
  assert.equal(body.readback?.persisted, false)
  assert.deepEqual(body.readback?.row, {})
  assert.equal(body.readback?.subject?.application_id, scenario.applicationId)
  assert.equal(body.readback?.subject?.rubric_payload_hash, pinnedRubricHash)
  assert.equal(body.readback?.subject?.resume_version_id, scenario.resumeVersionId)
  assert.equal(body.replayed, false)
  assert.equal(await countRows('decision'), before, 'evaluate 必须零写入')
})

test('record facade：FINAL HOLD 200 + 独立 SQL 读回 basis_refs；重复 409 零写入', async () => {
  const before = await countRows('decision')
  const payload = {
    application_id: scenario.applicationId,
    decision_scope: 'FINAL',
    result: 'HOLD',
    reason: '集成测试：汇总不足以推进，人工决定暂缓（契约 §3 业务选择）',
  }
  const result = await httpCall('POST', DECISION_PATHS.record, { session: SESSION_R, body: payload })
  assert.equal(result.status, 200, `record 期望 200：${result.text.slice(0, 2000)}`)
  const body = result.body
  assert.equal(body.contract_version, 'decision-record 1.0.0')
  assert.equal(body.decision?.decision_scope, 'FINAL')
  assert.equal(body.decision?.result, 'HOLD')

  // 独立 SQL 读回（不是回显响应）
  const rows = await query<{
    decision_id: string
    decision_scope: string
    result: string
    stage_code: string
    actor_id: string
    record_version: number
    basis_refs: unknown
  }>(
    `select d.id::text as decision_id, d.decision_scope, d.result, d.stage_code,
            d.decided_by_actor_id::text as actor_id, d.record_version, d.basis_refs
       from recruitment.decision d
      where d.application_id = $1::uuid and d.tenant_id = $2::uuid and d.decision_scope = 'FINAL'`,
    [scenario.applicationId, TENANT],
  )
  assert.equal(rows.length, 1, '必须恰好有 1 条 FINAL 决策')
  const row = rows[0]
  assert.equal(row.decision_scope, 'FINAL')
  assert.equal(row.result, 'HOLD')
  assert.equal(row.stage_code, 'S10')
  assert.equal(row.actor_id, HR_ACTOR)
  assert.ok(row.record_version >= 1)
  assert.equal(body.readback?.table, 'decision')
  assert.equal(body.readback?.row?.decision_id, row.decision_id)
  assert.equal(body.readback?.row?.result, 'HOLD')
  assert.equal(body.readback?.row?.is_current, true)

  const refs = row.basis_refs as Array<Record<string, unknown>>
  assert.ok(Array.isArray(refs))
  const summary = refs.find((ref) => ref.kind === 'SUMMARY')
  const rubric = refs.find((ref) => ref.kind === 'RUBRIC_VERSION')
  const authority = refs.find((ref) => ref.kind === 'AUTHORITY')
  assert.ok(summary !== undefined && rubric !== undefined && authority !== undefined)
  assert.match(String(summary.summary_digest), /^[0-9a-f]{64}$/)
  assert.equal(summary.summary_digest, body.basis_refs?.find((ref: Record<string, unknown>) => ref.kind === 'SUMMARY')?.summary_digest)
  assert.equal(rubric.payload_hash, pinnedRubricHash, 'basis RUBRIC_VERSION.payload_hash 必须 = 库值')
  assert.equal(authority.actor_id, HR_ACTOR, 'basis AUTHORITY.actor_id 必须是当前 session 的 actor')

  // 同 body 重复 → 409 且不新增行
  const duplicate = await httpCall('POST', DECISION_PATHS.record, { session: SESSION_R, body: payload })
  assert.equal(duplicate.status, 409, `重复决策期望 409：${duplicate.text.slice(0, 800)}`)
  assert.equal(await countRows('decision'), before + 1, '重复决策必须零写入')
})

test('负例族：拒绝且零写入（session/alias/客户端 hash/同源/方法/参数）', async () => {
  const before = await countRows('decision')
  const badApplication = (await httpCall('POST', DECISION_PATHS.screeningEvaluate, {
    session: SESSION_R,
    body: { application_id: 'not-a-uuid' },
  }))
  assert.equal(badApplication.status, 400)
  assert.equal((badApplication.body.error as Record<string, unknown>)?.reason_code, 'ID_NOT_UUID')

  const noSession = await httpCall('GET', `${DECISION_PATHS.facts}?application_id=${scenario.applicationId}`)
  assert.equal(noSession.status, 400)
  assert.equal((noSession.body.error as Record<string, unknown>)?.reason_code, 'SESSION_REQUIRED')

  const unbound = await httpCall('GET', `${DECISION_PATHS.facts}?application_id=${scenario.applicationId}`, { session: SESSION_UNBOUND })
  assert.equal(unbound.status, 409)
  assert.equal((unbound.body.error as Record<string, unknown>)?.code, 'DEMO_ACTOR_UNMAPPED')
  assert.equal((unbound.body.error as Record<string, unknown>)?.reason_code, 'SESSION_NOT_BOUND')

  const interviewerWrite = await httpCall('POST', DECISION_PATHS.screeningEvaluate, {
    session: SESSION_A,
    body: { application_id: scenario.applicationId },
  })
  assert.equal(interviewerWrite.status, 403)
  assert.equal((interviewerWrite.body.error as Record<string, unknown>)?.code, 'FORBIDDEN')
  assert.equal((interviewerWrite.body.error as Record<string, unknown>)?.reason_code, 'ACTOR_NOT_AUTHORIZED')

  const clientHash = await httpCall('POST', DECISION_PATHS.record, {
    session: SESSION_R,
    body: {
      application_id: scenario.applicationId,
      decision_scope: 'FINAL',
      result: 'HOLD',
      reason: '客户端不得传 hash',
      summary_digest: 'a'.repeat(64),
    },
  })
  assert.equal(clientHash.status, 400)
  assert.equal((clientHash.body.error as Record<string, unknown>)?.reason_code, 'SERVER_DERIVED_REJECTED')

  const clientBasis = await httpCall('POST', DECISION_PATHS.record, {
    session: SESSION_R,
    body: { application_id: scenario.applicationId, decision_scope: 'FINAL', result: 'HOLD', reason: 'x', basis_refs: [] },
  })
  assert.equal(clientBasis.status, 400)

  const overrideActor = await httpCall('POST', DECISION_PATHS.record, {
    session: SESSION_R,
    body: { application_id: scenario.applicationId, decision_scope: 'FINAL', result: 'HOLD', reason: 'x', actor_id: HR_ACTOR },
  })
  assert.equal(overrideActor.status, 400)
  assert.equal((overrideActor.body.error as Record<string, unknown>)?.reason_code, 'ACTOR_OVERRIDE_REJECTED')

  const sameOrigin = await httpCall('GET', `${DECISION_PATHS.facts}?application_id=${scenario.applicationId}`, {
    session: SESSION_R,
    omitRequestHeader: true,
  })
  assert.equal(sameOrigin.status, 403)
  assert.equal((sameOrigin.body.error as Record<string, unknown>)?.reason_code, 'SAME_ORIGIN_REQUIRED')

  const postFacts = await httpCall('POST', DECISION_PATHS.facts, { session: SESSION_R, body: {} })
  assert.equal(postFacts.status, 405)
  const getRecord = await httpCall('GET', DECISION_PATHS.record, { session: SESSION_R })
  assert.equal(getRecord.status, 405)

  const notFound = await httpCall('GET', `${DECISION_PATHS.facts}?application_id=11111111-1111-4111-8111-0000000007ff`, { session: SESSION_R })
  assert.equal(notFound.status, 404)
  assert.equal((notFound.body.error as Record<string, unknown>)?.code, 'NOT_FOUND')
  assert.equal((notFound.body.error as Record<string, unknown>)?.reason_code, 'APPLICATION_NOT_FOUND')

  const missingScope = await httpCall('POST', DECISION_PATHS.record, {
    session: SESSION_R,
    body: { application_id: scenario.applicationId, result: 'HOLD', reason: 'x' },
  })
  assert.equal(missingScope.status, 400)
  assert.equal((missingScope.body.error as Record<string, unknown>)?.reason_code, 'MISSING_REQUIRED')

  // 零面评时 ADVANCE 必须被领域门禁拦住（EVIDENCE_INSUFFICIENT 或 409），且零写入
  const advance = await httpCall('POST', DECISION_PATHS.record, {
    session: SESSION_R,
    body: { application_id: scenario.applicationId, decision_scope: 'FINAL', result: 'ADVANCE', reason: '没有面评硬推进' },
  })
  assert.ok(advance.status >= 400 && advance.status < 500, `ADVANCE 无面评期望 4xx：${advance.status} ${advance.text.slice(0, 600)}`)
  assert.equal(await countRows('decision'), before, '负例族必须零写入')
})

// ===========================================================================
//  helper（与 action-p1p2 同一 harness 口径；不改产品代码）
// ===========================================================================

/** 独立 SQL 读回（不经过任何产品读模块）。 */
async function query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

/** 一张表的行数（独立 SQL）。 */
async function countRows(table: 'decision' | 'application'): Promise<number> {
  const rows = await query<{ n: number }>(`select count(*)::int as n from recruitment.${table}`)
  return rows[0]?.n ?? 0
}

/** 跑 `scripts/bootstrap-demo.mjs`（cwd = 仓库根；env 只指向本用例的一次性库）。 */
function runBootstrap(databaseName: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('RECRUITMENT_') || key.startsWith('DEMO_')) continue
    env[key] = value
  }
  env.RECRUITMENT_DB_PASSWORD = BASE.password
  env.RECRUITMENT_DB_HOST = BASE.host
  env.RECRUITMENT_DB_PORT = String(BASE.port)
  env.RECRUITMENT_DB_USER = BASE.user
  env.RECRUITMENT_DB_NAME = databaseName
  env.RECRUITMENT_TENANT_ID = TENANT
  env.RECRUITMENT_ACTOR_ID = HR_ACTOR
  env.DEMO_APPROVAL_MODE = 'allow-once'
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOOTSTRAP_SCRIPT], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`bootstrap 超时（120s）\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`))
    }, 120_000)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

/** 起真 node:http server 并注册真实 decision + actor 路由（同一份产品注册函数）。 */
async function startHarness(): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', reason_code: 'NO_EXACT_ROUTE' } }))
      return
    }
    Promise.resolve().then(() => handler(req, res)).catch(() => {
      try { res.destroy() } catch { /* 连接已坏：忽略 */ }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  const webServer = {
    host: '127.0.0.1',
    port: address.port,
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }) {
      registered.push({ kind: route.kind, path: route.path })
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const logger = { warn() {} }
  const deps = { database: cfg, databaseIssues: [], identity }
  const disposers = [
    registerActorHttp({ webServer, logger }, deps),
    registerDecisionHttp({ webServer, logger }, deps),
  ]
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registered,
    async close(): Promise<void> {
      for (const dispose of disposers) dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 发一次同源请求（默认带 `x-recruitment-request: 1` 与 `x-dsh-session`）。 */
async function httpCall(
  method: string,
  path: string,
  options: { readonly session?: string; readonly body?: unknown; readonly omitRequestHeader?: boolean } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {}
  if (options.omitRequestHeader !== true) headers['x-recruitment-request'] = '1'
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }
  const response = await fetch(`${harness.baseUrl}${path}`, { method, headers, body: payload })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body, text }
}
