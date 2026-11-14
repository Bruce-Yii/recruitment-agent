// G5 · 干净库 demo bootstrap 的验收测试（`scripts/bootstrap-demo.mjs`）。
//
// 缺陷背景（2026-11-15 现场核实）：
//   全新库按名重放 db/migrations 0001→N 之后，0002_seed.sql 的演示岗位 DEMO-BE-001 只有
//   rubric_version v1（…0403），**没有 approval 行**。按 contracts/job-screening/job-rubric-rules.md
//   §4.2，`approved(v) = EXISTS(approval … status='APPROVED' ∧ canonical_payload_hash = v.payload_hash)`，
//   所以这个版本等于"未批准"：S7 报 NO_RUBRIC(NO_APPROVED_RUBRIC)，
//   manual/golden-path/run-golden-path.mjs 的 HOP 0 预检（L502-510）会 BLOCKED，干净库跑不了 demo。
//
// 本文件守的是**修复**：`scripts/bootstrap-demo.mjs` 必须能在一个只有迁移重放的干净库上，
// 用产品工具链（job_create/job_update + job_rubric_approve 的 allow-once 审批 seam）
// 把「岗位 current 指针 → APPROVED 且 payload_hash 对齐的 rubric 版本」这条前置补出来；
// 且幂等、拒绝/缺配置时**零写入**。
//
// 纪律（与 test/integration/db.ts 一致）：
//   1. 每个用例独占一个 `createIsolatedTestDatabase('bootstrap')` 的一次性库（不写 ra_s6s7）。
//   2. 连不上库 / 脚本不存在 → **抛错失败**，不许静默 skip（skip ≠ 通过，R3）。
//   3. 断言只信**独立 pg 读回**（本文件不 import 任何产品源码来"自证"），脚本人读输出只作对账。
//   4. 密码只从环境变量 `RECRUITMENT_DB_PASSWORD` 来；不落盘、不打印。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  HR_ACTOR,
  TENANT,
  type IsolatedTestDatabase,
} from '../integration/db.ts'

// ---------------------------------------------------------------------------
//  路径 / 环境（脚本在仓库根的 scripts/ 下；测试在 <repo>/dsh/dsh-recruitment/test/acceptance）
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根（= 本测试文件上四级：acceptance → test → dsh-recruitment → dsh → repo）。 */
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'bootstrap-demo.mjs')

/** 子进程上限：脚本要跑两次产品工具链（job_update + 审批），120s 足够；超时必须 kill 并失败。 */
const CHILD_TIMEOUT_MS = 120_000

const TENANT_DEFAULT = TENANT // 11111111-…-0001（seed 租户）
const ACTOR_DEFAULT = HR_ACTOR // 11111111-…-0103（seed HR 专员）
const DEMO_JOB_CODE = 'DEMO-BE-001'

/** 密码只从环境变量来：缺了就在这里炸（不 skip）。 */
function requirePassword(): string {
  const password = process.env.RECRUITMENT_DB_PASSWORD
  if (typeof password !== 'string' || password === '') {
    throw new Error(
      '验收测试需要 RECRUITMENT_DB_PASSWORD（数据库密码只从环境变量读，绝不落盘）。'
      + ' 先 set $env:RECRUITMENT_DB_PASSWORD 再跑 node --test test/acceptance/bootstrap-demo.test.ts。',
    )
  }
  return password
}

const PASSWORD = requirePassword()

/** 一次子进程运行的结果。 */
interface BootstrapRun {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/**
 * 运行 `node scripts/bootstrap-demo.mjs`（cwd = 仓库根）。
 * @param databaseName - 指向的一次性库名（写进 `RECRUITMENT_DB_NAME`）。
 * @param extra - 额外/覆盖的环境变量（如 `DEMO_APPROVAL_MODE`）。
 * @param options - `withPassword: false` 用来造「缺密码」负例。
 * @returns 退出码 + 完整 stdout/stderr。
 */
function runBootstrap(
  databaseName: string,
  extra: Record<string, string> = {},
  options: { withPassword?: boolean } = {},
): Promise<BootstrapRun> {
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(
      `G5 修复脚本不存在：${SCRIPT_PATH}。`
      + ' 本测试不降级、不 skip —— 脚本缺失必须红（见 owner-g5 的 G5 任务书）。',
    )
  }
  // 只透传"非数据库"的宿主变量：显式清掉 RECRUITMENT_*/DEMO_*，
  // 防止跑测试时进程里的 ra_s6s7 配置泄漏进子进程（所有运行必须指向一次性库）。
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('RECRUITMENT_') || key.startsWith('DEMO_')) continue
    env[key] = value
  }
  if (options.withPassword !== false) env.RECRUITMENT_DB_PASSWORD = PASSWORD
  env.RECRUITMENT_DB_HOST = process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1'
  env.RECRUITMENT_DB_PORT = process.env.RECRUITMENT_TEST_DB_PORT ?? '5432'
  env.RECRUITMENT_DB_USER = process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres'
  env.RECRUITMENT_DB_NAME = databaseName
  env.RECRUITMENT_TENANT_ID = TENANT_DEFAULT
  env.RECRUITMENT_ACTOR_ID = ACTOR_DEFAULT
  env.DEMO_JOB_CODE = DEMO_JOB_CODE
  for (const [key, value] of Object.entries(extra)) env[key] = value

  return new Promise<BootstrapRun>((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, CHILD_TIMEOUT_MS)
    // 不要因为 kill 之后 timer 还挂着而拖住事件循环。
    timer.unref?.()

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`spawn ${SCRIPT_PATH} 失败：${String(error)}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}

/**
 * 从 stdout 里取最后一行 `BOOTSTRAP_RESULT: <json>`。
 * @param stdout - 子进程标准输出。
 * @returns 解析后的结果对象。
 */
function parseBootstrapResult(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const line = lines.findLast((candidate) => candidate.startsWith('BOOTSTRAP_RESULT:'))
  if (line === undefined) {
    throw new Error(`stdout 里没有 BOOTSTRAP_RESULT 行；实际输出（尾部）：\n${lines.slice(-15).join('\n')}`)
  }
  const raw = line.slice('BOOTSTRAP_RESULT:'.length).trim()
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    throw new Error(`BOOTSTRAP_RESULT 不是合法 JSON：${String(error)}；原文：${raw.slice(0, 500)}`)
  }
}

/** 断言一次运行留下了完整诊断（失败时把 stdout/stderr 一起抛出来，避免"只见断言不见现场"）。 */
function describeRun(run: BootstrapRun): string {
  return `exit=${String(run.code)} signal=${String(run.signal)} timedOut=${String(run.timedOut)}\n`
    + `--- stdout ---\n${run.stdout.slice(-4000)}\n--- stderr ---\n${run.stderr.slice(-4000)}`
}

// ---------------------------------------------------------------------------
//  独立 pg 读回（不 import 产品代码；全部是只读查询）
// ---------------------------------------------------------------------------

/** 四张"有业务影响"的表在本文件里的零写入口径。 */
const ZERO_WRITE_TABLES = ['job', 'rubric_version', 'approval', 'event_inbox'] as const

/** 读四表行数 + 演示岗位的 record_version（幂等 / 零写入的证明口径）。 */
async function snapshot(db: IsolatedTestDatabase): Promise<{
  counts: Record<string, number>
  recordVersion: number
  jobCountByCode: number
}> {
  const counts: Record<string, number> = {}
  for (const table of ZERO_WRITE_TABLES) {
    const { rows } = await db.pool.query<{ n: number }>(`select count(*)::int as n from recruitment.${table}`)
    counts[table] = rows[0]?.n ?? -1
  }
  const { rows } = await db.pool.query<{ record_version: number; n: number }>(
    `select j.record_version,
            (select count(*)::int from recruitment.job where code = $2) as n
       from recruitment.job j
      where j.tenant_id = $1 and j.code = $2`,
    [TENANT_DEFAULT, DEMO_JOB_CODE],
  )
  return {
    counts,
    recordVersion: rows[0]?.record_version ?? -1,
    jobCountByCode: rows[0]?.n ?? -1,
  }
}

/** 演示岗位的完整事实：job + current 指向的 rubric 版本 + 该版本的生效 APPROVED 审批。 */
interface DemoFacts {
  readonly jobCount: number
  readonly jobsByCode: number
  readonly jobId: string
  readonly jobStatus: string
  readonly recordVersion: number
  readonly currentRubricVersionId: string | null
  readonly rubricJobId: string | null
  readonly rubricVersionNo: number | null
  readonly rubricPayloadHash: string | null
  readonly approvedApprovalCount: number
  readonly alignedApprovalCount: number
  readonly approvalStatus: string | null
  readonly approvalHash: string | null
  readonly approvalDecidedBy: string | null
  readonly approvalSuperseded: string | null
  readonly approvalExpiresAt: string | null
}

/**
 * 读回演示岗位的 §4.2 事实链：
 * job.current_rubric_version_id → 该版本属于本岗位 → 存在 APPROVED ∧ hash 对齐 ∧ 未 supersede ∧ 未过期的 approval。
 * @param db - 一次性测试库。
 * @returns 事实快照（字段为 null 表示"没有这一行/这一列"）。
 */
async function readDemoFacts(db: IsolatedTestDatabase): Promise<DemoFacts> {
  const job = await db.pool.query<{
    id: string
    status: string
    record_version: number
    current_rubric_version_id: string | null
    n: number
  }>(
    `select j.id, j.status, j.record_version, j.current_rubric_version_id,
            (select count(*)::int from recruitment.job where code = $2) as n
       from recruitment.job j
      where j.tenant_id = $1 and j.code = $2
      order by j.created_at
      limit 1`,
    [TENANT_DEFAULT, DEMO_JOB_CODE],
  )
  const jobRow = job.rows[0]
  if (jobRow === undefined) {
    return {
      jobCount: job.rowCount ?? 0,
      jobsByCode: 0,
      jobId: '',
      jobStatus: '',
      recordVersion: -1,
      currentRubricVersionId: null,
      rubricJobId: null,
      rubricVersionNo: null,
      rubricPayloadHash: null,
      approvedApprovalCount: 0,
      alignedApprovalCount: 0,
      approvalStatus: null,
      approvalHash: null,
      approvalDecidedBy: null,
      approvalSuperseded: null,
      approvalExpiresAt: null,
    }
  }

  const rubric = await db.pool.query<{ job_id: string; version_no: number; payload_hash: string }>(
    `select rv.job_id, rv.version_no, rv.payload_hash
       from recruitment.rubric_version rv
      where rv.tenant_id = $1 and rv.id = $2`,
    [TENANT_DEFAULT, jobRow.current_rubric_version_id],
  )
  const rubricRow = rubric.rows[0]

  const approvals = await db.pool.query<{
    status: string
    canonical_payload_hash: string
    decision_by_actor_id: string | null
    superseded_by_approval_id: string | null
    expires_at: string | null
  }>(
    `select a.status, a.canonical_payload_hash, a.decision_by_actor_id,
            a.superseded_by_approval_id, a.expires_at::text as expires_at
       from recruitment.approval a
      where a.tenant_id = $1 and a.resource_type = 'RUBRIC_VERSION' and a.resource_id = $2
      order by a.created_at`,
    [TENANT_DEFAULT, jobRow.current_rubric_version_id],
  )
  const approved = approvals.rows.filter((row) =>
    row.status === 'APPROVED'
    && row.superseded_by_approval_id === null
    && (row.expires_at === null || new Date(row.expires_at).getTime() > Date.now()))
  const aligned = approved.filter((row) =>
    rubricRow !== undefined && row.canonical_payload_hash === rubricRow.payload_hash)
  // "生效的那条"= hash 对齐的已批准行（没有就退回最后一行，便于失败诊断）。
  const first = aligned.at(-1) ?? approved.at(-1) ?? approvals.rows.at(-1)

  return {
    jobCount: job.rowCount ?? 0,
    jobsByCode: jobRow.n,
    jobId: jobRow.id,
    jobStatus: jobRow.status,
    recordVersion: jobRow.record_version,
    currentRubricVersionId: jobRow.current_rubric_version_id,
    rubricJobId: rubricRow?.job_id ?? null,
    rubricVersionNo: rubricRow?.version_no ?? null,
    rubricPayloadHash: rubricRow?.payload_hash ?? null,
    approvedApprovalCount: approved.length,
    alignedApprovalCount: aligned.length,
    approvalStatus: first?.status ?? null,
    approvalHash: first?.canonical_payload_hash ?? null,
    approvalDecidedBy: first?.decision_by_actor_id ?? null,
    approvalSuperseded: first?.superseded_by_approval_id ?? null,
    approvalExpiresAt: first?.expires_at ?? null,
  }
}

// ---------------------------------------------------------------------------
//  用例
// ---------------------------------------------------------------------------

/** 用例 A 之后保留给 B / D 复用的一次性库；`test.after` 里统一删。 */
let shared: IsolatedTestDatabase | undefined

test.after(async () => {
  if (shared !== undefined) await shared.drop()
})

test('A 正例：fresh 干净库 → 脚本 exit 0；独立读回 current 指针 → APPROVED 且 hash 对齐', async () => {
  const db = await createIsolatedTestDatabase('bootstrap')
  assertPrivateDatabase(db.name)
  shared = db

  // 先证基线：迁移重放后审批行不存在（G5 缺陷本身）。
  const before = await readDemoFacts(db)
  assert.equal(before.jobsByCode, 1, '干净库应该恰好有 1 个 DEMO-BE-001')
  assert.equal(before.approvedApprovalCount, 0, '缺陷基线：干净库不应有已批准 approval')
  assert.equal(before.alignedApprovalCount, 0, '缺陷基线：干净库不应有 hash 对齐的已批准 approval')

  const run = await runBootstrap(db.name)
  assert.equal(run.timedOut, false, `脚本超时（${CHILD_TIMEOUT_MS}ms）\n${describeRun(run)}`)
  assert.equal(run.code, 0, `脚本应 exit 0\n${describeRun(run)}`)

  const result = parseBootstrapResult(run.stdout)
  assert.equal(result.outcome, 'BOOTSTRAPPED', `脚本 outcome 应为 BOOTSTRAPPED，实际 ${String(result.outcome)}`)
  assert.equal(result.exit_code, 0, `JSON exit_code 应为 0，实际 ${String(result.exit_code)}`)
  assert.equal(result.database, db.name, `JSON database 应指向本用例的一次性库，实际 ${String(result.database)}`)

  // ---- 独立 pg 读回（不看脚本自述）----
  const after = await readDemoFacts(db)
  assert.equal(after.jobsByCode, 1, '岗位总数仍应为 1（不许为修 rubric 造第二个岗位）')
  assert.equal(after.jobStatus, 'OPEN', '演示岗位必须仍是 OPEN')
  assert.notEqual(after.currentRubricVersionId, null, 'current_rubric_version_id 必须非空')
  assert.equal(after.rubricJobId, after.jobId, 'current 指针指向的 rubric_version 必须属于该岗位')
  assert.notEqual(after.rubricPayloadHash, null, 'rubric 版本必须有 payload_hash')
  assert.equal(after.alignedApprovalCount, 1, '必须存在 1 条 APPROVED ∧ hash 对齐 ∧ 未 supersede ∧ 未过期的 approval')
  assert.equal(after.approvalStatus, 'APPROVED', 'approval.status 必须是 APPROVED')
  assert.equal(after.approvalHash, after.rubricPayloadHash, 'approval.canonical_payload_hash 必须等于 rubric.payload_hash')
  assert.equal(after.approvalDecidedBy, ACTOR_DEFAULT, '审批必须记录 seed HR 专员（…0103）作为决策人')
  assert.equal(after.approvalSuperseded, null, '生效 approval 不得已被 supersede')
  // §4.2 允许 expires_at 为空或"晚于 as_of"；demo 前置要么长期有效、要么至少此刻没过期。
  if (after.approvalExpiresAt !== null) {
    assert.ok(
      new Date(after.approvalExpiresAt).getTime() > Date.now(),
      `生效 approval 的 expires_at 必须晚于当前时刻，实际 ${after.approvalExpiresAt}`,
    )
  }

  // ---- 脚本 JSON 与库读回对账（自述只对账，不当证据）----
  const job = result.job as Record<string, unknown> | undefined
  const rubric = result.rubric as Record<string, unknown> | undefined
  const approval = result.approval as Record<string, unknown> | undefined
  const pointer = result.pointer as Record<string, unknown> | undefined
  const writes = result.writes as Record<string, unknown> | undefined
  assert.equal(job?.id, after.jobId, 'JSON job.id 必须等于库里的演示岗位 id')
  assert.equal(job?.code, DEMO_JOB_CODE, 'JSON job.code 必须是 DEMO-BE-001')
  assert.equal(job?.current_rubric_version_id, after.currentRubricVersionId, 'JSON job.current_rubric_version_id 必须等于库里的指针')
  assert.equal(rubric?.version_id, after.currentRubricVersionId, 'JSON rubric.version_id 必须等于库里的当前版本')
  assert.equal(rubric?.payload_hash, after.rubricPayloadHash, 'JSON rubric.payload_hash 必须等于库里的 payload_hash')
  assert.equal(approval?.status, 'APPROVED', 'JSON approval.status 必须是 APPROVED')
  assert.equal(approval?.canonical_payload_hash, after.rubricPayloadHash, 'JSON approval.canonical_payload_hash 必须等于 rubric.payload_hash')
  assert.equal(approval?.decided_by_actor_id, ACTOR_DEFAULT, 'JSON approval.decided_by_actor_id 必须是 …0103')
  assert.equal(pointer?.aligned, true, 'JSON pointer.aligned 必须是 true')
  assert.equal(pointer?.after, after.currentRubricVersionId, 'JSON pointer.after 必须等于库里的当前指针')
  assert.equal(writes?.written, true, 'JSON writes.written 必须是 true（首次 bootstrap 有写入）')
})

test('B 幂等：同库再跑一次 → exit 0 / NO_OP；四表行数与 record_version 完全不变', async () => {
  const db = shared
  assert.ok(db !== undefined, 'B 依赖 A 先建好的一次性库（A 失败时 B 没有可复用对象）')
  const before = await snapshot(db)

  const run = await runBootstrap(db.name)
  assert.equal(run.timedOut, false, `脚本超时（${CHILD_TIMEOUT_MS}ms）\n${describeRun(run)}`)
  assert.equal(run.code, 0, `幂等重跑应 exit 0\n${describeRun(run)}`)

  const result = parseBootstrapResult(run.stdout)
  assert.equal(result.outcome, 'NO_OP', `第二次应 outcome=NO_OP，实际 ${String(result.outcome)}`)
  assert.equal(result.exit_code, 0, `JSON exit_code 应为 0，实际 ${String(result.exit_code)}`)
  assert.equal((result.writes as Record<string, unknown> | undefined)?.written, false, 'NO_OP 必须 writes.written=false')

  const after = await snapshot(db)
  assert.deepEqual(after.counts, before.counts, `幂等重跑不得改行数：${JSON.stringify({ before: before.counts, after: after.counts })}`)
  assert.equal(after.recordVersion, before.recordVersion, '幂等重跑不得改 job.record_version')
  assert.equal(after.jobCountByCode, before.jobCountByCode, '演示岗位总数不变')
  assert.equal(after.jobCountByCode, 1, '演示岗位必须仍恰好 1 行')
})

test('C 反证（拒绝零写入）：DEMO_APPROVAL_MODE=deny → 退出码 3 / DENIED / 四表行数逐表相等', async () => {
  const db = await createIsolatedTestDatabase('bootstrap_deny')
  try {
    assertPrivateDatabase(db.name)
    const before = await snapshot(db)

    const run = await runBootstrap(db.name, { DEMO_APPROVAL_MODE: 'deny' })
    assert.equal(run.timedOut, false, `脚本超时（${CHILD_TIMEOUT_MS}ms）\n${describeRun(run)}`)
    assert.equal(run.code, 3, `审批被拒应 exit 3（约定），实际 ${String(run.code)}\n${describeRun(run)}`)

    const result = parseBootstrapResult(run.stdout)
    assert.equal(result.outcome, 'DENIED', `outcome 应为 DENIED，实际 ${String(result.outcome)}`)
    assert.equal(result.exit_code, 3, `JSON exit_code 应为 3，实际 ${String(result.exit_code)}`)
    assert.equal((result.writes as Record<string, unknown> | undefined)?.written, false, 'DENIED 必须 writes.written=false（fail closed）')

    const after = await snapshot(db)
    for (const table of ZERO_WRITE_TABLES) {
      assert.equal(after.counts[table], before.counts[table], `拒绝路径必须零写入：${table} 行数变了（${before.counts[table]} -> ${after.counts[table]}）`)
    }
    assert.equal(after.recordVersion, before.recordVersion, '拒绝路径不得改 job.record_version')
    // 拒绝之后缺陷仍然成立（审批行依旧是 0）——这正是"闸门拦住了"的语义。
    const facts = await readDemoFacts(db)
    assert.equal(facts.approvedApprovalCount, 0, '拒绝后不应出现已批准 approval')
  } finally {
    await db.drop()
  }
})

test('D 反证（缺密码）：不传 RECRUITMENT_DB_PASSWORD → 退出码 2 且目标库四表行数不变', async () => {
  const db = shared
  assert.ok(db !== undefined, 'D 依赖 A 的一次性库作为"目标库"')
  const before = await snapshot(db)

  const run = await runBootstrap(db.name, {}, { withPassword: false })
  assert.equal(run.timedOut, false, `脚本超时（${CHILD_TIMEOUT_MS}ms）\n${describeRun(run)}`)
  assert.equal(run.code, 2, `配置缺失应 exit 2（约定），实际 ${String(run.code)}\n${describeRun(run)}`)

  const result = parseBootstrapResult(run.stdout)
  assert.equal(result.outcome, 'FAILED', `缺密码应 outcome=FAILED，实际 ${String(result.outcome)}`)
  assert.equal(result.exit_code, 2, `JSON exit_code 应为 2，实际 ${String(result.exit_code)}`)
  assert.equal((result.writes as Record<string, unknown> | undefined)?.written, false, '缺密码必须 writes.written=false')
  // 配置错误必须在**连库之前**失败：不应假装读了库（job/rubric/approval 全为 null）。
  assert.equal(result.job, null, '缺密码时不应读回岗位（未连库）')
  assert.equal(result.rubric, null, '缺密码时不应读回 rubric（未连库）')
  assert.equal(result.approval, null, '缺密码时不应读回 approval（未连库）')

  const after = await snapshot(db)
  for (const table of ZERO_WRITE_TABLES) {
    assert.equal(after.counts[table], before.counts[table], `缺密码路径必须零写入：${table} 行数变了（${before.counts[table]} -> ${after.counts[table]}）`)
  }
  assert.equal(after.recordVersion, before.recordVersion, '缺密码路径不得改 job.record_version')
  // 密码绝不能进任何输出（脚本自带 scrub；这里独立断言一次）。
  // 不能用 `includes(PASSWORD)`：CI 的密码可能就是 `postgres`，而 "user postgres" 是合法输出
  // （环境相关断言会误报）。这里断言"泄漏形状"：赋值式密码或带密码的连接串。
  const combined = run.stdout + run.stderr
  assert.equal(
    /RECRUITMENT_DB_PASSWORD\s*[=:]\s*\S/i.test(combined),
    false,
    '脚本输出里绝不允许出现 RECRUITMENT_DB_PASSWORD=<值>',
  )
  assert.equal(
    /postgres(?:ql)?:\/\/[^\s]*:[^\s@]+@/i.test(combined),
    false,
    '脚本输出里绝不允许出现带密码的连接串',
  )
})
