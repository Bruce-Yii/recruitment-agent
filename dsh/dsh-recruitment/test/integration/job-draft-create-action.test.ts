// D5 W2b · 岗位草案 / 创建 Host Action 的真库 + 真 HTTP 集成测试（task-57）。
//
// 契约：`work/d5/joblife/CONTRACT-ACTIONS.md`（W0 2026-11-15 冻结）。
//   POST /recruitment/api/job-action/job/draft   —— 只读，不写库；返回草案/理由/缺失项/confirmation
//   POST /recruitment/api/job-action/job/create  —— 人确认后写；复用现有 job_create 领域；rubric 仍 PENDING
//
// 纪律（与 `demo-actor-http.test.ts` 同口径）：
//   1. 本文件独占一次性空库 `createIsolatedTestDatabase('jobaction')`（迁移 0001→0016 重放），
//      真提交、结束时 drop；**不写 ra_s6s7**；
//   2. 连不上库直接抛（不静默 skip）；
//   3. 断言只信独立 SQL 读回（只 import 路由注册入口 + demo-actor 身份单例来驱动）；
//   4. 每条拒绝路径都断言「HTTP 码 + 目标表行数/record_version 前后不变」。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerJobActionHttp, type JobActionHttpDeps } from '../../src/http/actions-job.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  DEMO_DEPARTMENT,
  TENANT,
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

const BASE = testDatabaseConfig()
const SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UNBOUND_SESSION = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DRAFT_PATH = '/recruitment/api/job-action/job/draft'
const CREATE_PATH = '/recruitment/api/job-action/job/create'

/** 一条合法 criterion（Σweight=1 由两条各 0.5 保证）。 */
const CRITERIA = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months_gte36', label: '至少 36 个月后端经历', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 36 },
] as const

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let server: ActionServer

interface ActionServer {
  readonly baseUrl: string
  readonly port: number
  readonly registered: readonly { kind: string; path: string }[]
  close(): Promise<void>
}

/**
 * 起一个真 `node:http` server，并用 `registerJobActionHttp` 注册三条 exact 路由。
 * @param deps - 路由依赖。
 */
async function startActionServer(deps: JobActionHttpDeps): Promise<ActionServer> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const instance: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found (exact route)', pathname }))
      return
    }
    Promise.resolve().then(() => handler(req, res)).catch(() => {
      try { res.destroy() } catch { /* ignore */ }
    })
  })
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject)
    instance.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (instance.address() as AddressInfo).port
  registerJobActionHttp(
    {
      webServer: {
        host: '127.0.0.1',
        port,
        register(route) {
          registered.push({ kind: route.kind, path: route.path })
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
    },
    deps,
  )
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    registered,
    async close() {
      instance.closeAllConnections()
      await new Promise<void>((resolve) => instance.close(() => resolve()))
    },
  }
}

interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

/**
 * 发一次同源请求。
 * @param path - exact path。
 * @param options - 是否带同源头/session、body。
 */
async function httpCall(
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
  const response = await fetch(`${server.baseUrl}${path}`, { method: 'POST', headers, body: payload })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
  return { status: response.status, body, text }
}

/** 断言封闭错误体。 */
function assertHttpError(result: HttpResult, status: number, code: string, reasonCode?: string): void {
  assert.equal(result.status, status, `HTTP 状态应为 ${status}：${result.text}`)
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `响应必须是 {"error":{...}}：${result.text}`)
  assert.equal(error.code, code, `error.code 应为 ${code}：${result.text}`)
  if (reasonCode !== undefined) {
    assert.equal(error.reason_code, reasonCode, `error.reason_code 应为 ${reasonCode}：${result.text}`)
  }
}

/** 一次"整库快照"：目标表行数 + job/rubric/approval 计数（用于零写入断言）。 */
async function snapshot(): Promise<string> {
  const { rows } = await db.pool.query<{
    jobs: number; job_versions: number; rubrics: number; approvals: number; events: number
  }>(`select
      (select count(*)::int from recruitment.job where tenant_id = $1) as jobs,
      (select count(*)::int from recruitment.job_version where tenant_id = $1) as job_versions,
      (select count(*)::int from recruitment.rubric_version where tenant_id = $1) as rubrics,
      (select count(*)::int from recruitment.approval where tenant_id = $1) as approvals,
      (select count(*)::int from recruitment.event_inbox where tenant_id = $1) as events`, [TENANT])
  const row = rows[0]
  assert.ok(row !== undefined)
  return `${row.jobs}|${row.job_versions}|${row.rubrics}|${row.approvals}|${row.events}`
}

test.before(async () => {
  db = await createIsolatedTestDatabase('jobaction')
  assertPrivateDatabase(db.name)
  cfg = { ...BASE, database: db.name }
  const created = createDemoActorIdentity()
  assert.deepEqual([...created.issues], [], '缺省 alias 映射不应有配置问题')
  identity = created.identity
  server = await startActionServer({ database: cfg, databaseIssues: [], identity })
  identity.registry.bind(SESSION, 'recruiter')
})

test.after(async () => {
  await server?.close()
  await db?.drop()
})

test('① draft：一句人话 → 200 草案 + 理由 + 缺失项 + confirmation；零写入', async () => {
  const before = await snapshot()
  const result = await httpCall(DRAFT_PATH, {
    session: SESSION,
    body: { request_text: '我们要招一名后端工程师，做支付系统，最好有大厂经验' },
  })
  assert.equal(result.status, 200, `draft 应 200：${result.text}`)
  assert.equal(result.body.contract_version, 'job-draft 1.0.0')
  const draft = result.body.draft as Record<string, unknown>
  const jobDraft = draft.job_draft as Record<string, unknown>
  for (const key of ['recruiting_reason', 'responsibilities', 'success_profile', 'must_have', 'nice_to_have', 'rounds', 'location', 'level', 'salary', 'headcount']) {
    assert.ok(Object.hasOwn(jobDraft, key), `job_draft 必须含 ${key}：${result.text}`)
  }
  assert.ok(Array.isArray(jobDraft.responsibilities) && (jobDraft.responsibilities as unknown[]).length > 0)
  const rounds = jobDraft.rounds as { round_no: number; title: string; focus: string[]; questions: string[] }[]
  assert.ok(rounds.length >= 1 && rounds[0]?.round_no === 1 && typeof rounds[0]?.title === 'string')
  // 未给部门/人数/招聘原因 → 必须进 missing_items，且不得编造具体值。
  const missing = draft.missing_items as { key: string; question: string }[]
  const missingKeys = missing.map((item) => item.key)
  for (const key of ['department', 'headcount', 'recruitment_reason']) {
    assert.ok(missingKeys.includes(key), `missing_items 必须含 ${key}：${missingKeys.join(',')}`)
  }
  assert.equal(jobDraft.location, null)
  assert.equal(jobDraft.headcount, null)
  assert.equal(jobDraft.recruiting_reason, null)
  // reasons：至少一条带 path/reason/source
  const reasons = draft.reasons as { path: string; reason: string; source: string }[]
  assert.ok(reasons.length > 0)
  assert.ok(reasons.every((item) => typeof item.path === 'string' && typeof item.reason === 'string' && typeof item.source === 'string'))
  // rubric 草案：维度过 R-VAL 形状 + 硬性门槛位于其中
  const rubricDraft = draft.rubric_draft as Record<string, unknown>
  const dimensions = rubricDraft.dimensions as { key: string; kind: string; weight: number; reason: string }[]
  assert.ok(dimensions.length > 0)
  assert.ok(dimensions.some((item) => item.kind === 'MUST_HAVE' || item.kind === 'DISQUALIFIER'))
  assert.ok(Math.abs(dimensions.reduce((sum, item) => sum + item.weight, 0) - 1) <= 1e-6)
  const confirmation = result.body.confirmation as Record<string, unknown>
  assert.equal(confirmation.required, true)
  assert.equal(confirmation.status, 'PENDING_HUMAN_CONFIRMATION')
  assert.deepEqual(confirmation.next, ['recruitment_job_create', 'recruitment_job_rubric_approve'])
  assert.equal(await snapshot(), before, 'draft 必须零写入（整库计数不变）')
})

test('② draft 负例：空白/超长/未知键/身份覆盖 + 缺 session/未绑定（全部 4xx 零写入）', async () => {
  const before = await snapshot()
  assertHttpError(await httpCall(DRAFT_PATH, { session: SESSION, body: { request_text: '   ' } }), 400, 'INVALID_ARGS', 'REQUEST_TEXT_EMPTY')
  assertHttpError(await httpCall(DRAFT_PATH, { session: SESSION, body: { request_text: 'x'.repeat(2001) } }), 400, 'INVALID_ARGS', 'REQUEST_TEXT_TOO_LONG')
  assertHttpError(await httpCall(DRAFT_PATH, { session: SESSION, body: { request_text: '招后端', extra: 1 } }), 400, 'INVALID_ARGS', 'UNKNOWN_BODY_KEY')
  assertHttpError(await httpCall(DRAFT_PATH, { session: SESSION, body: { request_text: '招后端', actor_id: 'x' } }), 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
  assertHttpError(await httpCall(DRAFT_PATH, { body: { request_text: '招后端' } }), 400, 'INVALID_ARGS', 'SESSION_REQUIRED')
  assertHttpError(await httpCall(DRAFT_PATH, { session: UNBOUND_SESSION, body: { request_text: '招后端' } }), 409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND')
  assertHttpError(await httpCall(DRAFT_PATH, { session: SESSION, body: { request_text: '招后端' }, omitRequestHeader: true }), 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')
  assert.equal(await snapshot(), before, 'draft 负例必须零写入')
})

test('③ create：草案字段 → 200；job/job_version/rubric_version/approval 全部 DB 读回，rubric 仍 PENDING', async () => {
  const before = await snapshot()
  const digest = 'a'.repeat(64)
  const result = await httpCall(CREATE_PATH, {
    session: SESSION,
    body: {
      job_create_args: {
        code: 'W2B-JOB-001',
        title: '后端工程师（W2b 演示）',
        department_id: DEMO_DEPARTMENT,
        description_md: '# 后端工程师\n负责支付系统后端开发。',
        requirements_md: '3 年以上后端经验。',
        criteria: CRITERIA,
        status: 'DRAFT',
      },
      draft_digest: digest,
    },
  })
  assert.equal(result.status, 200, `create 应 200：${result.text}`)
  assert.equal(result.body.contract_version, 'job-create 1.0.0')
  const job = result.body.job as Record<string, unknown>
  const versions = result.body.versions as Record<string, unknown>
  const readback = result.body.readback as { table: string; row: Record<string, unknown> }
  assert.equal(readback.table, 'job')
  assert.equal(job.code, 'W2B-JOB-001')
  assert.equal(job.status, 'DRAFT')
  // `createJobInTransaction` 落 current_job_version_id 时触发 fn_row_guard（非状态迁移也 +1 record_version），
  // 所以真实值 ≥1 且必须与 SQL 读回一致（D-18：输出取 RETURNING 的真实值，不自己 +1）。
  assert.ok(Number(job.record_version) >= 1)
  assert.equal(versions.version_no, 1)
  assert.equal(versions.approval_status, 'PENDING')
  assert.equal(result.body.replayed, false)

  // 独立 SQL 读回（不拿响应当证据）。
  const jobRow = (await db.pool.query<{ id: string; code: string; status: string; current_rubric_version_id: string | null; record_version: number }>(
    'select id::text as id, code, status, current_rubric_version_id::text as current_rubric_version_id, record_version from recruitment.job where id = $1 and tenant_id = $2',
    [job.job_id, TENANT],
  )).rows[0]
  assert.ok(jobRow !== undefined)
  assert.equal(jobRow.code, 'W2B-JOB-001')
  assert.equal(jobRow.status, 'DRAFT')
  assert.equal(jobRow.record_version, job.record_version)
  assert.equal(jobRow.current_rubric_version_id, null, '创建后 current 指针必须为空（批准后才指）')
  const versionRow = (await db.pool.query<{ version_no: number; approved_by_approval_id: string | null }>(
    'select version_no, approved_by_approval_id::text as approved_by_approval_id from recruitment.job_version where id = $1',
    [versions.job_version_id],
  )).rows[0]
  assert.ok(versionRow !== undefined)
  assert.equal(versionRow.version_no, 1)
  assert.equal(versionRow.approved_by_approval_id, null)
  const rubricRow = (await db.pool.query<{ version_no: number; approved_by_approval_id: string | null }>(
    'select version_no, approved_by_approval_id::text as approved_by_approval_id from recruitment.rubric_version where id = $1',
    [versions.rubric_version_id],
  )).rows[0]
  assert.ok(rubricRow !== undefined)
  assert.equal(rubricRow.version_no, 1)
  assert.equal(rubricRow.approved_by_approval_id, null)
  const approvalRow = (await db.pool.query<{ status: string; decision_by_actor_id: string | null }>(
    'select status, decision_by_actor_id::text as decision_by_actor_id from recruitment.approval where id = $1',
    [versions.approval_id],
  )).rows[0]
  assert.ok(approvalRow !== undefined)
  assert.equal(approvalRow.status, 'PENDING', 'rubric 必须仍是 PENDING（本端点不自动批准）')
  assert.equal(approvalRow.decision_by_actor_id, null)
  const after = await snapshot()
  assert.notEqual(after, before, 'create 应当有写入（四表至少 +1 行）')
})

test('④ create 负例：重复 code→409 / 非法 criteria→400 / 未知参数键 / 身份覆盖 / 未绑定（全部零假写）', async () => {
  const before = await snapshot()
  const baseArgs = {
    code: 'W2B-JOB-001',
    title: '后端工程师（重复 code）',
    department_id: DEMO_DEPARTMENT,
    criteria: CRITERIA,
  }
  assertHttpError(await httpCall(CREATE_PATH, { session: SESSION, body: { job_create_args: baseArgs } }), 409, 'CONFLICT', 'DUPLICATE_JOB_CODE')
  const badCriteria = { ...baseArgs, code: 'W2B-BAD-001', criteria: [{ ...CRITERIA[0], weight: 0.9 }, CRITERIA[1]] }
  assertHttpError(await httpCall(CREATE_PATH, { session: SESSION, body: { job_create_args: badCriteria } }), 400, 'INVALID_ARGS')
  assertHttpError(await httpCall(CREATE_PATH, { session: SESSION, body: { job_create_args: { ...baseArgs, code: 'W2B-X-1', extra: true } } }), 400, 'INVALID_ARGS', 'UNKNOWN_JOB_CREATE_ARG')
  assertHttpError(await httpCall(CREATE_PATH, { session: SESSION, body: { job_create_args: { ...baseArgs, code: 'W2B-X-2', actor_id: 'x' } } }), 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
  assertHttpError(await httpCall(CREATE_PATH, { session: SESSION, body: { job_create_args: baseArgs, draft_digest: 'NOT-HEX' } }), 400, 'INVALID_ARGS', 'DRAFT_DIGEST_INVALID')
  assertHttpError(await httpCall(CREATE_PATH, { session: UNBOUND_SESSION, body: { job_create_args: { ...baseArgs, code: 'W2B-X-3' } } }), 409, 'DEMO_ACTOR_UNMAPPED')
  assertHttpError(await httpCall(CREATE_PATH, { body: { job_create_args: { ...baseArgs, code: 'W2B-X-4' } } }), 400, 'INVALID_ARGS', 'SESSION_REQUIRED')
  assert.equal(await snapshot(), before, 'create 负例必须零写入')
})

test('⑤ create：不传 code → 服务端生成合法 code；不传 criteria → 无 rubric/approval（合法缺标准）', async () => {
  const result = await httpCall(CREATE_PATH, {
    session: SESSION,
    body: {
      job_create_args: {
        title: '自动 code 岗位',
        department_id: DEMO_DEPARTMENT,
        description_md: '占位 JD',
      },
    },
  })
  assert.equal(result.status, 200, `create 应 200：${result.text}`)
  const job = result.body.job as Record<string, unknown>
  assert.match(String(job.code), /^JOB-\d{8}-[0-9A-F]{6}$/)
  const versions = result.body.versions as Record<string, unknown>
  assert.equal(versions.version_no, 1)
  assert.equal(versions.rubric_version_id, undefined, '未给 criteria 时不得创建 rubric')
  const rows = await db.pool.query<{ n: number }>(
    'select count(*)::int as n from recruitment.rubric_version where job_id = $1 and tenant_id = $2',
    [job.job_id, TENANT],
  )
  assert.equal(rows.rows[0]?.n, 0)
})
