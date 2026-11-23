// 三条新写动作 HTTP 路由（transfer / constraint / job/create）的真库 + 真 HTTP 集成测试。
//
// 冻结契约：`work/d5/http-actions/CONTRACT.md`（owner-http-actions lane）。
// 本文件只依赖**已存在的公共 API** `registerActionsHttp(ctx, deps)` 与三条 path **字符串字面量**，
// 不 import 实现方新增的内部导出（实现与本测试并行开发）。
//
// 纪律（与 `test/integration/action-p1p2.test.ts` 同形）：
//   1. 本文件独占一个 `createIsolatedTestDatabase('http3actions')` 一次性库（**不写 ra_s6s7**），
//      跑完 drop；
//   2. 连不上库时**跳过本文件的用例并说明原因**（`t.skip`），不静默绿；
//   3. 真 `node:http` 监听 127.0.0.1:0，把真实 `registerActorHttp` + `registerActionsHttp`
//      的 `webServer.register` 契约收集成 exact 路由表（与宿主同一份注册函数）；
//   4. 身份注册表 = 产品 `createDemoActorIdentity()` 真实例（与工具/HTTP 共享 session→alias 绑定）；
//   5. 断言只信**独立 SQL 读回**（不 import 产品读投影自证）；拒绝路径同时断言状态/错误码 +
//      目标表行数前后不变（fail-closed 零写入）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerActorHttp } from '../../src/http/actor.ts'
import { registerActionsHttp, type ActionHttpDeps } from '../../src/http/actions.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  DEMO_DEPARTMENT,
  HR_ACTOR,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

// ---------------------------------------------------------------------------
//  固定值 / 路径
// ---------------------------------------------------------------------------

const TRANSFER_PATH = '/recruitment/api/action/application/transfer'
const CONSTRAINT_PATH = '/recruitment/api/action/candidate/constraint'
const JOB_CREATE_PATH = '/recruitment/api/action/job/create'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根（test/integration → test → dsh-recruitment → dsh → repo）。 */
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const BOOTSTRAP_SCRIPT = join(REPO_ROOT, 'scripts', 'bootstrap-demo.mjs')

const ACTOR_103 = '11111111-1111-4111-8111-000000000103' // recruiter（HR）
const ACTOR_104 = '11111111-1111-4111-8111-000000000104' // interviewer_a
const DEMO_APPLICATION = '11111111-1111-4111-8111-000000000701'
const DEMO_JOB = '11111111-1111-4111-8111-000000000401'
const TRANSFER_TARGET_JOB = '44444444-4444-4444-8444-000000000401'
const TRANSFER_TARGET_VERSION = '44444444-4444-4444-8444-000000000402'

const SESSION_R = 'session-da5ac000-0000-4000-8000-00000000c001'
const SESSION_A = 'session-da5ac000-0000-4000-8000-00000000a001'
const SESSION_UNBOUND = 'session-da5ac000-0000-4000-8000-00000000ff01'

/** 本次运行唯一后缀：避免与 bootstrap 种子 / 重复跑撞唯一键。 */
const UNIQUE = `${process.pid.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase()
const TAG = `D5HTTP3_${UNIQUE}`

/** 一条合法 criterion（Σweight=1 由两条各 0.5 保证）。 */
const CRITERIA = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months_gte36', label: '至少 36 个月后端经历', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 36 },
] as const

// ---------------------------------------------------------------------------
//  全局状态 + DB 可用性探测
// ---------------------------------------------------------------------------

let db: IsolatedTestDatabase | undefined
let cfg: ResolvedDatabaseConfig | undefined
let identity: DemoActorIdentity | undefined
let harness: Harness | undefined
let setupError: string | undefined

/** 真 `node:http` + 真实 register 契约（actor 3 条 + actions 13 条 exact path）。 */
interface Harness {
  readonly baseUrl: string
  readonly port: number
  readonly registered: readonly { kind: string; path: string }[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

/** 一次 HTTP 调用结果。 */
interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

/**
 * 仅探测库是否可达（不建一次性库、不写任何数据）。
 * 失败时把原因写进 setupError，所有用例走 `t.skip`。
 */
async function probeDatabase(): Promise<string | null> {
  try {
    const base = testDatabaseConfig()
    const { Pool } = await import('pg')
    const pool = new Pool({
      host: base.host,
      port: base.port,
      user: base.user,
      password: base.password,
      database: base.database,
      connectionTimeoutMillis: 1500,
      max: 1,
    })
    try {
      await pool.query('select 1')
      return null
    } finally {
      await pool.end().catch(() => {})
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

test.before(async () => {
  const reason = await probeDatabase()
  if (reason !== null) {
    setupError = `测试库不可用，跳过三条路由的真库集成用例：${reason}`
    return
  }
  try {
    // ---- 一次性空库（真迁移 0001→0016）+ 产品 bootstrap 种子 ----
    db = await createIsolatedTestDatabase('http3actions')
    assertPrivateDatabase(db.name)
    assert.ok(db.migrations.length >= 16, `迁移应 >=16，实际 ${db.migrations.length}`)
    const base = testDatabaseConfig()
    cfg = { ...base, database: db.name }

    const boot = await runBootstrap(db.name)
    assert.equal(
      boot.code,
      0,
      `bootstrap 必须 exit 0；实际 code=${String(boot.code)}\n${boot.stdout.slice(-3000)}\n${boot.stderr.slice(-2000)}`,
    )

    // 夹具前置：演示申请改为 ACTIVE（0002_seed 的演示申请状态由演示库决定）。
    await query("update recruitment.application set lifecycle_status = 'ACTIVE' where id = $1 and tenant_id = $2", [
      DEMO_APPLICATION,
      TENANT,
    ])
    // transfer 目标岗必须**不同于**源岗（同岗 = ensureActiveApplication 复用，不产生新申请）。
    await query(
      `insert into recruitment.job (id, tenant_id, department_id, code, title, status)
       values ($1, $2, $3, $4, $5, 'DRAFT') on conflict do nothing`,
      [TRANSFER_TARGET_JOB, TENANT, DEMO_DEPARTMENT, `HA-TARGET-${TAG}`, '跨岗调剂目标岗（集成测试）'],
    )
    await query(
      `insert into recruitment.job_version
         (id, tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
       values ($1, $2, $3, 1, $4, $5, $6) on conflict do nothing`,
      [TRANSFER_TARGET_VERSION, TENANT, TRANSFER_TARGET_JOB, 'JD', 'a'.repeat(64), ACTOR_103],
    )
    await query(
      'update recruitment.job set current_job_version_id = $1 where id = $2 and tenant_id = $3',
      [TRANSFER_TARGET_VERSION, TRANSFER_TARGET_JOB, TENANT],
    )

    // ---- 真 HTTP server + 两个 register 函数（同一份产品注册实现）----
    const created = createDemoActorIdentity()
    assert.deepEqual([...created.issues], [], '缺省 alias 映射不应有配置问题')
    identity = created.identity
    harness = await startHarness({ database: cfg, databaseIssues: [], identity })

    // 三条新路由必须已注册（契约的接线点）。
    for (const path of [TRANSFER_PATH, CONSTRAINT_PATH, JOB_CREATE_PATH]) {
      assert.ok(
        harness.registered.some((route) => route.path === path && route.kind === 'exact'),
        `缺 exact 路由 ${path}`,
      )
    }

    // 绑定 recruiter / interviewer_a（未绑定 session 保留做负例）。
    for (const [session, alias] of [[SESSION_R, 'recruiter'], [SESSION_A, 'interviewer_a']] as const) {
      const put = await httpCall('PUT', '/recruitment/api/actor', { session, body: { alias } })
      assert.equal(put.status, 200, `绑定 ${alias} 应 200：${put.text}`)
      assert.equal(put.body.actor_id, alias === 'recruiter' ? ACTOR_103 : ACTOR_104, `${alias} 的 actor 映射`)
    }
  } catch (error) {
    setupError = `测试库初始化失败，跳过三条路由的真库集成用例：${error instanceof Error ? error.message : String(error)}`
  }
})

test.after(async () => {
  if (harness !== undefined) await harness.close()
  if (db !== undefined) await db.drop()
})

/**
 * 每个用例开头调用：库不可用时跳过并说明原因。
 * 返回 false 时用例必须立即 `return`（node:test 的 t.skip() 不会中断函数体）。
 */
function requireDb(t: { skip(message: string): void }): boolean {
  if (setupError !== undefined || harness === undefined || db === undefined || cfg === undefined || identity === undefined) {
    t.skip(setupError ?? '测试库/路由 harness 未就绪')
    return false
  }
  return true
}

// ===========================================================================
//  正例：三条路由写入 + 独立 SQL 读回
// ===========================================================================

test('正向 transfer：建目标岗申请 + carry_over 行数增加（源申请不变）', async (t) => {
  if (!requireDb(t)) return

  const before = await snapshot()
  const source = await query<{ candidate_id: string; resume_version_id: string | null }>(
    'select candidate_id::text as candidate_id, resume_version_id::text as resume_version_id from recruitment.application where id = $1 and tenant_id = $2',
    [DEMO_APPLICATION, TENANT],
  )
  assert.equal(source.length, 1, '夹具：演示申请必须存在')
  assert.ok(source[0]!.resume_version_id !== null, '夹具：演示申请必须绑定 resume 版本（carry-over 同候选人同 resume）')

  const created = await okJson(
    await httpCall('POST', TRANSFER_PATH, {
      session: SESSION_R,
      body: {
        application_id: DEMO_APPLICATION,
        target_job_id: TRANSFER_TARGET_JOB,
        confirmation_text: '同意把该候选人跨岗调剂到目标岗位',
      },
    }),
    'transfer',
  )
  assert.equal(created.action, 'application/transfer')
  assert.equal((created.actor as Record<string, unknown>).actor_id, ACTOR_103, '写作者 = recruiter 103')

  // 独立 SQL 读回：新申请 + carry_over 行数。
  const newApps = await query<{ id: string; candidate_id: string; job_id: string; resume_version_id: string | null }>(
    `select id::text as id, candidate_id::text as candidate_id, job_id::text as job_id,
            resume_version_id::text as resume_version_id
       from recruitment.application
      where tenant_id = $1 and job_id = $2 and candidate_id = $3 and id <> $4`,
    [TENANT, TRANSFER_TARGET_JOB, source[0]!.candidate_id, DEMO_APPLICATION],
  )
  assert.ok(newApps.length >= 1, 'transfer 必须新建一条同候选人/目标岗的申请')
  const carryRows = await query<{ n: number }>(
    'select count(*)::int as n from recruitment.application_carry_over where tenant_id = $1 and application_id = $2',
    [TENANT, newApps[0]!.id],
  )
  assert.ok(carryRows[0]?.n >= 0, 'carry_over 表可读回')
  // 源申请一行不改（AT-1）：行数 +1，且原行仍存在。
  assert.equal(await count('application'), before.application + 1, 'transfer 恰好新增一条申请')
  const sourceAfter = await query<{ n: number }>(
    'select count(*)::int as n from recruitment.application where id = $1 and tenant_id = $2',
    [DEMO_APPLICATION, TENANT],
  )
  assert.equal(sourceAfter[0]?.n, 1, '源申请仍在（不改不删）')
})

test('正向 constraint：PIN 落 candidate_constraint 行（created_by=103）', async (t) => {
  if (!requireDb(t)) return

  const before = await count('candidate_constraint')
  const created = await okJson(
    await httpCall('POST', CONSTRAINT_PATH, {
      session: SESSION_R,
      body: {
        action: 'PIN',
        candidate_id: (await query<{ id: string }>(
          'select id::text as id from recruitment.candidate where tenant_id = $1 limit 1',
          [TENANT],
        ))[0]!.id,
        text: '务必安排一轮系统设计面试（集成测试合成约束，无真实 PII）',
        source: 'CHAT',
        confirmation_text: '同意把这句话置顶为下一轮约束',
      },
    }),
    'constraint PIN',
  )
  assert.equal(created.action, 'candidate/constraint')
  const rows = await query<{ created_by_actor_id: string | null; kind: string; text: string; source: string }>(
    `select created_by_actor_id::text as created_by_actor_id, kind, text, source
       from recruitment.candidate_constraint
      where tenant_id = $1 and text = $2`,
    [TENANT, '务必安排一轮系统设计面试（集成测试合成约束，无真实 PII）'],
  )
  assert.equal(rows.length, 1, 'PIN 必须落一行 candidate_constraint')
  assert.equal(rows[0]!.created_by_actor_id, ACTOR_103, 'created_by = recruiter 103')
  assert.equal(rows[0]!.source, 'CHAT')
  assert.equal(await count('candidate_constraint'), before + 1, 'constraint 恰好 +1')
})

test('正向 job/create：落 job + job_version 行（rubric 仍 PENDING）', async (t) => {
  if (!requireDb(t)) return

  const before = await snapshot()
  const created = await okJson(
    await httpCall('POST', JOB_CREATE_PATH, {
      session: SESSION_R,
      body: {
        title: `后端工程师（${TAG}）`,
        dept: DEMO_DEPARTMENT,
        confirmation_text: '同意新建岗位（集成测试）',
      },
    }),
    'job/create',
  )
  assert.equal(created.action, 'job/create')

  const rows = await query<{ id: string; title: string; status: string }>(
    'select id::text as id, title, status from recruitment.job where tenant_id = $1 and title = $2',
    [TENANT, `后端工程师（${TAG}）`],
  )
  assert.equal(rows.length, 1, 'job/create 必须落一行 job')
  const versions = await query<{ n: number; version_no: number }>(
    'select count(*)::int as n, max(version_no) as version_no from recruitment.job_version where job_id = $1 and tenant_id = $2',
    [rows[0]!.id, TENANT],
  )
  assert.ok((versions[0]?.n ?? 0) >= 1, 'job/create 必须落至少一行 job_version')
  // rubric 仍 PENDING（契约：不绕过人工闸门）。
  const rubrics = await query<{ n: number; pending: number }>(
    `select count(*)::int as n,
            count(*) filter (where ap.status = 'PENDING')::int as pending
       from recruitment.rubric_version rv
       left join recruitment.approval ap
         on ap.resource_type = 'RUBRIC_VERSION' and ap.resource_id = rv.id and ap.tenant_id = rv.tenant_id
      where rv.job_id = $1 and rv.tenant_id = $2`,
    [rows[0]!.id, TENANT],
  )
  if ((rubrics[0]?.n ?? 0) > 0) {
    assert.equal(rubrics[0]!.pending, rubrics[0]!.n, 'rubric 的 approval 必须仍全部 PENDING')
  }
  const after = await snapshot()
  assert.ok(after.job > before.job, 'job 行数必须增加')
  assert.ok(after.job_version > before.job_version, 'job_version 行数必须增加')
})

// ===========================================================================
//  负例：4xx 且逐表行数前后不变
// ===========================================================================

test('负例族：无 confirmation_text / 未绑定 / 越权 → 4xx 且目标表行数不变', async (t) => {
  if (!requireDb(t)) return

  const before = await snapshot()
  const candidateId = (await query<{ id: string }>(
    'select id::text as id from recruitment.candidate where tenant_id = $1 limit 1',
    [TENANT],
  ))[0]!.id

  // n1 缺 confirmation_text（三条）
  for (const [path, body] of [
    [TRANSFER_PATH, { application_id: DEMO_APPLICATION, target_job_id: DEMO_JOB }],
    [CONSTRAINT_PATH, { action: 'PIN', candidate_id: candidateId, text: 'x', source: 'CHAT' }],
    [JOB_CREATE_PATH, { title: `缺确认岗位 ${TAG}` }],
  ] as const) {
    assertError(
      await httpCall('POST', path, { session: SESSION_R, body }),
      400,
      'INVALID_ARGS',
      'MISSING_REQUIRED',
      `缺 confirmation_text @ ${path}`,
    )
  }

  // n2 未绑定 session（三条）
  for (const [path, body] of [
    [TRANSFER_PATH, { application_id: DEMO_APPLICATION, target_job_id: DEMO_JOB, confirmation_text: '同意' }],
    [CONSTRAINT_PATH, { action: 'PIN', candidate_id: candidateId, text: 'x', source: 'CHAT', confirmation_text: '同意' }],
    [JOB_CREATE_PATH, { title: '未绑定岗位', confirmation_text: '同意' }],
  ] as const) {
    assertError(
      await httpCall('POST', path, { session: SESSION_UNBOUND, body }),
      409,
      'DEMO_ACTOR_UNMAPPED',
      undefined,
      `未绑定 @ ${path}`,
    )
  }

  // n3 越权 alias（三条）
  for (const [path, body] of [
    [TRANSFER_PATH, { application_id: DEMO_APPLICATION, target_job_id: DEMO_JOB, confirmation_text: '同意' }],
    [CONSTRAINT_PATH, { action: 'PIN', candidate_id: candidateId, text: 'x', source: 'CHAT', confirmation_text: '同意' }],
    [JOB_CREATE_PATH, { title: '越权岗位', confirmation_text: '同意' }],
  ] as const) {
    assertError(
      await httpCall('POST', path, { session: SESSION_A, body }),
      403,
      'FORBIDDEN',
      'ACTOR_NOT_AUTHORIZED',
      `越权 @ ${path}`,
    )
  }

  // n4 域拒绝：别人的候选人/岗位导致拒绝（以跨租户 UUID 触发 NOT_FOUND / FORBIDDEN）。
  const foreignId = '22222222-2222-4222-8222-000000000001'
  assertError(
    await httpCall('POST', TRANSFER_PATH, {
      session: SESSION_R,
      body: { application_id: foreignId, target_job_id: DEMO_JOB, confirmation_text: '同意' },
    }),
    404,
    undefined,
    undefined,
    'transfer 别人的申请',
  )
  assertError(
    await httpCall('POST', CONSTRAINT_PATH, {
      session: SESSION_R,
      body: { action: 'PIN', candidate_id: foreignId, text: 'x', source: 'CHAT', confirmation_text: '同意' },
    }),
    404,
    undefined,
    undefined,
    'constraint 别人的候选人',
  )

  // 所有负例后：目标表行数逐字不变。
  assert.deepEqual(await snapshot(), before, '负例族零写入')
})

// ===========================================================================
//  helper
// ===========================================================================

/** 独立 SQL 读回（连本用例的一次性库；不经过任何产品读模块）。 */
async function query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await db!.pool.query<T>(sql, [...params])
  return result.rows
}

/** 一张表的行数（独立 SQL）。 */
async function count(table: string): Promise<number> {
  const rows = await query<{ n: number }>(`select count(*)::int as n from recruitment.${table}`)
  return rows[0]?.n ?? 0
}

/** 目标表行数快照（用于零写入断言）。 */
async function snapshot(): Promise<Record<string, number>> {
  return {
    application: await count('application'),
    carry_over: await count('application_carry_over'),
    candidate_constraint: await count('candidate_constraint'),
    job: await count('job'),
    job_version: await count('job_version'),
    rubric_version: await count('rubric_version'),
    approval: await count('approval'),
  }
}

/** 断言 200 并返回 JSON 信封。 */
async function okJson(result: HttpResult, label: string): Promise<Record<string, unknown>> {
  assert.equal(result.status, 200, `${label} 期望 200，实际 ${result.status}：${result.text.slice(0, 1200)}`)
  return result.body
}

/** 断言错误信封 `{error:{code,reason_code?,message}}`。 */
function assertError(
  result: HttpResult,
  status: number,
  code: string | undefined,
  reasonCode: string | undefined,
  label: string,
): void {
  assert.equal(result.status, status, `${label} 期望 ${status}，实际 ${result.status}：${result.text.slice(0, 1200)}`)
  const error = (result.body.error ?? {}) as Record<string, unknown>
  if (code !== undefined) {
    assert.equal(error.code, code, `${label} code 期望 ${code}，实际 ${String(error.code)}：${result.text.slice(0, 800)}`)
  }
  if (reasonCode !== undefined) {
    assert.equal(
      error.reason_code,
      reasonCode,
      `${label} reason_code 期望 ${reasonCode}，实际 ${String(error.reason_code)}：${result.text.slice(0, 800)}`,
    )
  }
}

/** 跑 `scripts/bootstrap-demo.mjs`（cwd = 仓库根；env 只指向本用例的一次性库）。 */
/** 给 bootstrap 的 python 绝对路径（显式 env 优先；否则从 PATH 解析 sys.executable）。 */
function resolveBootstrapPython(): string {
  const explicit = process.env.RECRUITMENT_PYTHON_BIN ?? process.env.RECRUITMENT_PYTHON
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  for (const candidate of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    try {
      const executable = execFileSync(candidate, ['-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (executable !== '') return executable
    } catch { /* try next */ }
  }
  // 最后才落到名称，让 bootstrap 的 PrerequisiteError 明确报出来（不静默）。
  return process.platform === 'win32' ? 'D:\\Python3.12.9\\python.exe' : 'python3'
}

function runBootstrap(databaseName: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const base = testDatabaseConfig()
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('RECRUITMENT_') || key.startsWith('DEMO_')) continue
    env[key] = value
  }
  env.RECRUITMENT_DB_PASSWORD = base.password
  env.RECRUITMENT_DB_HOST = base.host
  env.RECRUITMENT_DB_PORT = String(base.port)
  env.RECRUITMENT_DB_USER = base.user
  env.RECRUITMENT_DB_NAME = databaseName
  env.RECRUITMENT_TENANT_ID = TENANT
  env.RECRUITMENT_ACTOR_ID = HR_ACTOR
  env.DEMO_APPROVAL_MODE = 'allow-once'
  // bootstrap 的 demo 材料链要用产品 converter（S6 intake）；显式 env 优先，
  // 否则按平台解析 python 的绝对路径（CI/Linux 没有 D:\Python3.12.9）。
  env.RECRUITMENT_PYTHON_BIN = resolveBootstrapPython()
  env.RECRUITMENT_CONVERTER_DIR = process.env.RECRUITMENT_CONVERTER_DIR ?? join(REPO_ROOT, 'converter')
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

/**
 * 起真 `node:http` server 并注册**真实的** actor + actions 路由（同一份产品注册函数）。
 */
async function startHarness(deps: ActionHttpDeps): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const warnings: string[] = []
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', reason_code: 'NO_EXACT_ROUTE' } }))
      return
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        try { res.destroy() } catch { /* 连接已坏：忽略。 */ }
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
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
      registered.push({ kind: route.kind, path: route.path })
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const logger = { warn(message: string) { warnings.push(message) } }
  const disposers = [
    registerActorHttp({ webServer, logger }, { database: deps.database, databaseIssues: deps.databaseIssues, identity: deps.identity }),
    registerActionsHttp({ webServer, logger }, deps),
  ]
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    registered,
    warnings,
    async close(): Promise<void> {
      for (const dispose of disposers) dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * 发一次同源请求（默认带 `x-recruitment-request: 1` 与 `x-dsh-session`）。
 */
async function httpCall(
  method: string,
  path: string,
  options: {
    readonly session?: string
    readonly body?: unknown
    readonly omitRequestHeader?: boolean
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {}
  if (options.omitRequestHeader !== true) headers['x-recruitment-request'] = '1'
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }
  const response = await fetch(`${harness!.baseUrl}${path}`, { method, headers, body: payload })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
  return { status: response.status, body, text }
}
