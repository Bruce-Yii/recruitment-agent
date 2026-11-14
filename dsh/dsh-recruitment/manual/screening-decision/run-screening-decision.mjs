// S6 → S7「决策落库」**仓库内可复现** harness（唯一目的：让独立验收窗口能自己重跑出同一条 SCREENING 决策）。
//
// 为什么要有它（独立验收窗口的原话）：
//   「DB 里那条 SCREENING 决策来自一次跑在仓库外的验收脚本，且必须先手工钉 rubric；
//     仓库里没有任何脚本能复现它 —— 功能跑通过一次，但没人在干净环境重跑出同样结果。」
//   本 harness 就是补这个缺口：**只用产品自己的工具** 走完整条 S6→S7，不手工 UPDATE 任何业务表。
//
// 它做的事（每一步都是真实的 `tool.execute()`，不是单测、不是 mock）：
//   0. 预检：库 / 迁移 / 演示租户 / 只读行数快照；
//   1. `recruitment_job_create`        建一个**固定 code** 的岗位（含 2 条机械型 rubric 准则）→ 只写 PENDING 审批；
//   2. `recruitment_job_rubric_approve` 人机闸门（宿主替身 allow-once）→ APPROVED + 把
//      `job.current_rubric_version_id` 指向该版本（**不是**手工 UPDATE）；
//   3. `recruitment_application_intake` 合成简历 PDF → candidate + application；
//      **F1 的验收点**：新建申请时 `application.rubric_version_id` 必须已被钉上（读回 SQL 证明）；
//   4. `recruitment_screening_evaluate` 只读评估 → verdict / evaluation_digest（resolution 必须是
//      `APPLICATION_PINNED`、`what_if=false`、`rubric_pin_required=false`）；
//   5. `recruitment_decision_record(decision_scope='SCREENING')` IN_CHAT v2（原话 + 服务端同一份 hash 实现）
//      → 真实写库；
//   6. DB 读回：`recruitment.decision` 那一行 + 内部事件 + 行数差。
//
// 幂等（任务书第 4 条）：脚本用**固定 job code + 固定合成身份**，所以第二次跑不会"再落一条一样的决策"：
//   * `job_create` → `INVALID_ARGS(DUPLICATE_JOB_CODE)`（`uq_job_code` 挡住重复岗位）；
//     脚本此时走**只读** SELECT 找回既有岗位并继续（不 UPDATE、不删行、不清库）；
//   * `job_rubric_approve` → `NO_OP, replayed=true`（批准已生效，零额外写入、不再问人）；
//   * `application_intake` → `application_action=REUSED`（同 candidate+job 复用同一条申请）；
//   * `decision_record(SCREENING)` → `ALREADY_DECIDED/SCOPE_ALREADY_DECIDED`
//     （写库前 STEP 3 查到 current 决策；`0008` 的 `uq_decision_current` 可延迟排斥约束是最后防线）。
//   脚本不把这两次结果都当 PASS：`run_mode` 明确区分 `FIRST_RUN` / `RERUN`，退出码分别为
//   「首次：决策必须真的写进去」/「第二次：必须被唯一约束拒绝且库里不新增行」。
//
// 硬边界：
//   * 写只经 `tool.execute()`；`pg` 只用于 SELECT 读回与行数统计（不写业务表）；
//   * 不放宽任何闸门：rubric 批准照常调用 approval seam（替身只替"人"，不替"闸门"）；
//     decision 走 D-95 v2（IN_CHAT + 逐字原话 + 服务端同一份 `confirmationTextSha256`）；
//   * R7：全程合成身份（姓名「示例甲」/ `example.test` 邮箱 / 保留手机号），日志里出现的都是合成值；
//     候选人联系方式在读回里打码。
//
// 用法（PowerShell；仓库根 = recruitment-agent）：
//   $env:RECRUITMENT_DB_PASSWORD='<本机演示库密码，按约定注入，不落盘>'
//   node dsh/dsh-recruitment/manual/screening-decision/run-screening-decision.mjs
//
// 可选环境变量：
//   RECRUITMENT_TEST_DB / _DB_HOST / _DB_PORT / _DB_USER   库连接（默认 ra_s6s7 @ 127.0.0.1:5432/postgres）
//   RECRUITMENT_PYTHON_BIN                                 converter 用的 python（默认 D:\Python3.12.9\python.exe）
//   REPRO_JOB_CODE                                         换一个岗 code（默认 REPRO-S6S7-SCREENING）
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

import { createJobCreateTool } from '../../src/tools/job-create.ts'
import { createJobRubricApproveTool } from '../../src/tools/job-rubric-approve.ts'
import { createApplicationIntakeTool } from '../../src/tools/application-intake.ts'
import { createScreeningEvaluateTool } from '../../src/tools/screening-evaluate.ts'
import {
  createDecisionRecordTool,
  confirmationTextSha256,
} from '../../src/tools/decision-record.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { resolveConverterConfig } from '../../src/tools/converter.ts'

// ---------------------------------------------------------------------------
//  固定事实（合成演示租户；不碰任何真实候选人）
// ---------------------------------------------------------------------------
const TENANT_ID = '11111111-1111-4111-8111-000000000001' // 0002_seed 的演示租户
const ACTOR_ID = '11111111-1111-4111-8111-000000000103' // 演示-HR 专员（HUMAN）
const JOB_CODE = process.env.REPRO_JOB_CODE ?? 'REPRO-S6S7-DECISION'
const JOB_TITLE = '后端工程师（S6→S7 决策复现演示岗）'
/** 合成候选人的强标识（必须与 fixtures 里生成的 PDF 内容一致）。 */
const SYNTHETIC_EMAIL = 'repro.candidate.a@example.test'
const SYNTHETIC_PHONE_NORM = '+8613600004242'
/** D-95：给人看过、并由人逐字确认的原话（固定字符串 = 可重复）。 */
const CONFIRMATION_TEXT = '我确认：示例甲这条申请初筛通过，推进到面试。'
/**
 * 只有**机械型**准则（两条 MUST_HAVE，weight Σ=1）。
 *
 * 为什么不放"判断型"（只有 `question`、没有 `field`）准则：产品自己的 `job_create`
 * 会把判断型准则存成 `"field": null`（9 键归一化），而 `screening_evaluate` 只用
 * `criterion.field === undefined` 判"判断型"，于是 `null` 会掉进 `resolveFieldFact(ctx, null)`
 * → `TypeError: Cannot read properties of null (reading 'startsWith')`。
 * 这是**产品缺陷**（job_create 与 screening_evaluate 对同一 JSON 形状的口径不一致），
 * 本 harness 不绕过、不修 src，只把它单独复现并报告（`probe-judgment-criterion-bug.mjs`）。
 */
const CRITERIA = [
  {
    key: 'work_exists',
    label: '简历中存在可分割的工作经历条目',
    kind: 'MUST_HAVE',
    weight: 0.5,
    field: 'work_experience',
    operator: 'EXISTS',
    value: true,
    notes: 'EXISTS 判的是 state=present（读到了），不是"这个人有工作经历"',
  },
  {
    key: 'edu_exists',
    label: '简历中存在可分割的教育经历条目',
    kind: 'MUST_HAVE',
    weight: 0.5,
    field: 'education',
    operator: 'EXISTS',
    value: true,
    notes: 'state=absent → MISSING；state=unreadable → UNREADABLE',
  },
]

const HERE = new URL('./', import.meta.url)
const PKG_ROOT = new URL('../../', HERE)
const REPO_ROOT = new URL('../../../../', HERE)
const FIXTURE_PDF = new URL('./fixtures/synthetic-resume-screening-repro.pdf', HERE)
const CONVERTER_DIR = new URL('converter/', REPO_ROOT)
const PYTHON_BIN = process.env.RECRUITMENT_PYTHON_BIN ?? 'D:\\Python3.12.9\\python.exe'
const EVIDENCE_ROOT = new URL('./evidence/experiments/2026-11-14-screening-decision-repro/', PKG_ROOT)

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const RUN_DIR = new URL(`run-${stamp}/`, EVIDENCE_ROOT)
const LOG_PATH = fileURLToPath(new URL('run.log', RUN_DIR))

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------
const exec = { signal: new AbortController().signal, callId: `screening-decision-${stamp}` }

const lines = []
function log(line = '') {
  lines.push(line)
  console.log(line)
}

let logFlush = Promise.resolve()
function flushLog() {
  // 串行追加，避免并发写把行截断。
  logFlush = logFlush.then(() => appendFile(LOG_PATH, lines.splice(0).join('\n') + '\n', 'utf8'))
  return logFlush
}

async function saveJson(name, value) {
  await writeFile(new URL(name, RUN_DIR), JSON.stringify(value, null, 2), 'utf8')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** 带 +08:00 偏移的 ISO-8601（工具只接受带偏移的时间）。 */
function toOffsetIso(date = new Date(), offsetMinutes = 480) {
  const t = new Date(date.getTime() + offsetMinutes * 60_000)
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
    + `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`
}

/** 现在（截到秒 → 一定不晚于服务端 now；`as_of` 用）。 */
function nowIso() {
  return toOffsetIso(new Date())
}

/** 现在 - N 秒（confirmed_at 用：必须早于 decided_at，且在 24h 内）。 */
function nowMinus(seconds) {
  return toOffsetIso(new Date(Date.now() - seconds * 1000))
}

/** 从 `RecruitmentToolError` 的 message（`CODE: {json}`）里取出结构化 body。 */
function errorBody(error) {
  const message = String(error?.message ?? '')
  const idx = message.indexOf(': ')
  if (idx < 0) return undefined
  try {
    return JSON.parse(message.slice(idx + 2))
  } catch {
    return undefined
  }
}

/** allow-once / denied / unavailable 三种替身。**只替代"人"，不替代闸门本身**。 */
function makeApproval(mode) {
  const calls = []
  let used = false
  return {
    calls,
    async request(req) {
      calls.push({ toolName: req?.toolName, reason: req?.reason })
      if (mode === 'allow-once') {
        if (used) return 'rejected'
        used = true
        return 'allowed-once'
      }
      if (mode === 'deny') return 'rejected'
      return 'unavailable'
    },
  }
}

/** 打码候选人的联系方式（R7：日志里只留可核对的前缀/后缀）。 */
function maskEmail(value) {
  if (typeof value !== 'string') return value
  return value.replace(/^(.{3}).*(@.*)$/, '$1***$2')
}
function maskPhone(value) {
  if (typeof value !== 'string') return value
  return value.replace(/^(\+86\d{3}).*(\d{2})$/, '$1***$2')
}

// ---------------------------------------------------------------------------
//  配置（产品同一份 resolver；密码只从环境变量来）
// ---------------------------------------------------------------------------
const dbResolved = resolveDatabaseConfig({
  host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
  user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
  database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT_ID,
  actor_id: ACTOR_ID,
}, process.env)
if (dbResolved.resolved === null) {
  console.error(`[screening-decision] DB 配置不完整：${dbResolved.issues.join('; ')}`)
  process.exit(2)
}
const DB = dbResolved.resolved

const convResolved = resolveConverterConfig({
  python_bin: PYTHON_BIN,
  converter_dir: fileURLToPath(CONVERTER_DIR),
  // 边界收紧：harness 只允许读自己的合成 fixture 目录。
  allowed_roots: [fileURLToPath(new URL('./fixtures/', HERE))],
  timeout_ms: 180_000,
})
if (convResolved.resolved === null) {
  console.error(`[screening-decision] converter 配置不完整：${convResolved.issues.join('; ')}`)
  process.exit(2)
}
const CONV = convResolved.resolved

const pool = new pg.Pool({
  host: DB.host,
  port: DB.port,
  user: DB.user,
  database: DB.database,
  password: DB.password,
  max: 2,
  connectionTimeoutMillis: 10_000,
  application_name: 'screening-decision-repro',
})

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params)
  return rows
}

/** 全表行数快照（前后对比用；只读）。 */
async function rowCounts() {
  const rows = await query(`
    select 'job' as t, count(*)::int as n from recruitment.job
    union all select 'job_version', count(*)::int from recruitment.job_version
    union all select 'rubric_version', count(*)::int from recruitment.rubric_version
    union all select 'approval', count(*)::int from recruitment.approval
    union all select 'candidate', count(*)::int from recruitment.candidate
    union all select 'application', count(*)::int from recruitment.application
    union all select 'resume', count(*)::int from recruitment.resume
    union all select 'resume_version', count(*)::int from recruitment.resume_version
    union all select 'intake_asset', count(*)::int from recruitment.intake_asset
    union all select 'intake_record', count(*)::int from recruitment.intake_record
    union all select 'event_inbox', count(*)::int from recruitment.event_inbox
    union all select 'decision', count(*)::int from recruitment.decision
    union all select 'business_task', count(*)::int from recruitment.business_task
    order by t`)
  const map = {}
  for (const row of rows) map[row.t] = row.n
  return map
}

function diffCounts(before, after) {
  const delta = {}
  for (const key of Object.keys(after)) {
    const d = (after[key] ?? 0) - (before[key] ?? 0)
    if (d !== 0) delta[key] = d
  }
  return delta
}

// ---------------------------------------------------------------------------
//  读回查询（全部只读；敏感值打码）
// ---------------------------------------------------------------------------
async function readJobByCode(code) {
  return (await query(`
    select id, code, title, status, department_id, current_job_version_id,
           current_rubric_version_id, record_version, created_at
      from recruitment.job where tenant_id = $1 and code = $2`, [TENANT_ID, code]))[0] ?? null
}

async function readJob(jobId) {
  return (await query(`
    select id, code, title, status, department_id, current_job_version_id,
           current_rubric_version_id, record_version
      from recruitment.job where tenant_id = $1 and id = $2`, [TENANT_ID, jobId]))[0] ?? null
}

async function readRubricAndApprovals(jobId) {
  const rubrics = await query(`
    select rv.id, rv.job_id, rv.version_no, rv.payload_hash,
           jsonb_array_length(rv.dimensions) as dimension_count,
           (select array_agg(d->>'key' order by ord)
              from jsonb_array_elements(rv.dimensions) with ordinality as x(d, ord)) as dimension_keys
      from recruitment.rubric_version rv
     where rv.tenant_id = $1 and rv.job_id = $2
     order by rv.version_no`, [TENANT_ID, jobId])
  const approvals = await query(`
    select a.id, a.resource_id, a.status, a.canonical_payload_hash,
           a.superseded_by_approval_id, a.expires_at, a.decided_at, a.decision_by_actor_id
      from recruitment.approval a
     where a.tenant_id = $1 and a.resource_type = 'RUBRIC_VERSION'
       and a.resource_id in (select id from recruitment.rubric_version where tenant_id = $1 and job_id = $2)
     order by a.created_at`, [TENANT_ID, jobId])
  return { rubrics, approvals }
}

async function readApplication(applicationId) {
  return (await query(`
    select id, job_id, candidate_id, job_version_id, rubric_version_id, resume_version_id,
           lifecycle_status, current_stage_code, record_version, created_at
      from recruitment.application where tenant_id = $1 and id = $2`, [TENANT_ID, applicationId]))[0] ?? null
}

async function readDecisions(applicationId) {
  return query(`
    select d.id, d.application_id, d.decision_scope, d.stage_code, d.result,
           d.decided_by_actor_id, act.display_name as decided_by_display_name,
           d.decided_at, d.record_version, d.superseded_by_decision_id, d.approval_id,
           d.reason,
           jsonb_array_length(d.basis_refs) as basis_ref_count,
           (select array_agg(distinct b->>'kind') from jsonb_array_elements(d.basis_refs) b) as basis_kinds,
           d.basis_refs
      from recruitment.decision d
      left join recruitment.actor act on act.id = d.decided_by_actor_id and act.tenant_id = d.tenant_id
     where d.tenant_id = $1 and d.application_id = $2
     order by d.decided_at`, [TENANT_ID, applicationId])
}

async function readDecisionEvents(decisionIds) {
  if (decisionIds.length === 0) return []
  return query(`
    select event_id, provider, trust_level, event_type, idempotency_key, idempotency_source,
           source_object_id, occurred_at,
           payload->>'decision_scope' as decision_scope,
           payload->>'result' as result,
           payload->>'screening_evaluation_digest' as screening_evaluation_digest,
           payload->>'human_confirmation_method' as human_confirmation_method,
           payload->>'human_confirmation_text' as human_confirmation_text,
           payload->>'human_confirmation_text_sha256' as human_confirmation_text_sha256,
           payload->>'human_confirmation_preimage_version' as human_confirmation_preimage_version
      from recruitment.event_inbox
     where tenant_id = $1 and event_type = 'decision.record' and source_object_id = any($2::text[])
     order by recorded_at`, [TENANT_ID, decisionIds])
}

async function readScreeningDecisionsInTenant() {
  return query(`
    select decision_scope, count(*)::int as n from recruitment.decision
     where tenant_id = $1 group by 1 order by 1`, [TENANT_ID])
}

async function readAuthority(jobId) {
  return (await query(`
    select j.id as job_id, j.department_id, d.hiring_manager_actor_id
      from recruitment.job j
      left join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
     where j.id = $1 and j.tenant_id = $2`, [jobId, TENANT_ID]))[0] ?? null
}

// ---------------------------------------------------------------------------
//  STEP 记录器
// ---------------------------------------------------------------------------
const steps = []
let RUN_MODE = 'UNKNOWN'

async function runStep(input) {
  const before = await rowCounts()
  const record = {
    step: input.step,
    id: input.id,
    label: input.label,
    tool: input.tool === undefined ? '(只读 SQL)' : (input.tool.name ?? '(unknown tool)'),
    run_mode: RUN_MODE,
    started_at: new Date().toISOString(),
    request: input.args ?? null,
  }
  log('')
  log(`──────── STEP ${input.step} · ${input.label} ────────`)
  log(`tool      : ${record.tool}`)
  if (input.args !== undefined) {
    log(`request   : ${JSON.stringify(input.args, null, 1).replace(/\n/g, '\n            ')}`)
  }
  let value
  try {
    value = await input.call()
    record.ok = true
    record.result = value
    log('result    : OK')
    if (input.tool !== undefined && input.render !== false) {
      try {
        const rendered = input.tool.output.render(input.args, value).map((block) => block.text).join('\n')
        record.rendered = rendered
        log(rendered.split('\n').map((line) => `  ${line}`).join('\n'))
      } catch (renderError) {
        record.render_error = String(renderError)
        log(`  (render 失败: ${String(renderError)})`)
      }
    }
  } catch (error) {
    record.ok = false
    record.error = {
      name: error?.name,
      code: error?.code,
      message: String(error?.message ?? error),
    }
    record.error_body = errorBody(error)
    log(`result    : ${error?.code ?? error?.name} — ${String(error?.message ?? error)}`)
  }
  const after = await rowCounts()
  record.row_counts_before = before
  record.row_counts_after = after
  record.row_count_delta = diffCounts(before, after)
  log(`row delta : ${JSON.stringify(record.row_count_delta)}`)
  if (input.readback !== undefined) {
    try {
      record.readback = await input.readback(record)
      log(`readback  : ${JSON.stringify(record.readback, null, 1).replace(/\n/g, '\n            ')}`)
    } catch (readbackError) {
      record.readback_error = String(readbackError)
      log(`readback  : ERROR ${String(readbackError)}`)
    }
  }
  record.outcome = input.judge === undefined
    ? (record.ok ? 'PASS' : 'FAIL')
    : (input.judge(record) ? 'PASS' : 'FAIL')
  log(`outcome   : ${record.outcome}`)
  steps.push(record)
  await saveJson(`step-${String(input.step).padStart(2, '0')}-${input.id}.json`, record)
  await flushLog()
  return record
}

/** 卡住时：写 summary、落盘、退出（不做任何"绕过"）。 */
async function blocked(reason, extra = {}) {
  log('')
  log(`BLOCKED：${reason}`)
  await saveJson('blocked.json', { reason, at: new Date().toISOString(), steps, ...extra })
  await flushLog()
  await pool.end()
  process.exitCode = 3
  return true
}

// ---------------------------------------------------------------------------
//  主流程
// ---------------------------------------------------------------------------
await mkdir(RUN_DIR, { recursive: true })

const fixtureBytes = await readFile(FIXTURE_PDF)
const fixtureSha = sha256(fixtureBytes)

/** 代码状态绑定：证据必须能对上"当时那份 src"。 */
const CODE_FILES = [
  'src/tools/job-create.ts',
  'src/tools/job-rubric-approve.ts',
  'src/tools/application-intake.ts',
  'src/tools/screening-evaluate.ts',
  'src/tools/decision-record.ts',
]
const codeState = {}
for (const relative of CODE_FILES) {
  const absolute = fileURLToPath(new URL(relative, PKG_ROOT))
  codeState[relative] = sha256(await readFile(absolute))
}
let gitHead = 'unknown'
try {
  gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(REPO_ROOT), encoding: 'utf8' }).trim()
} catch {
  gitHead = '(git 不可用；见 command.txt)'
}

log('S6 → S7 决策落库**仓库内可复现** harness')
log(`运行时间        : ${new Date().toISOString()}`)
log(`仓库 HEAD       : ${gitHead}`)
log(`数据库          : ${DB.user}@${DB.host}:${DB.port}/${DB.database}（只读读回；写只经工具）`)
log(`租户 / actor    : ${TENANT_ID} / ${ACTOR_ID}（演示-HR 专员，HUMAN）`)
log(`岗位 code       : ${JOB_CODE}（固定 → 第二次跑会被唯一约束挡住）`)
log(`合成简历        : ${fileURLToPath(FIXTURE_PDF)}`)
log(`fixture sha256  : ${fixtureSha}（${fixtureBytes.length} bytes）`)
log(`合成身份        : 「示例甲」 ${SYNTHETIC_EMAIL} / ${SYNTHETIC_PHONE_NORM}（合成值，不对应任何真实候选人）`)
log(`证据目录        : ${fileURLToPath(RUN_DIR)}`)
log('')

await saveJson('fixture.json', {
  path: fileURLToPath(FIXTURE_PDF),
  sha256: fixtureSha,
  bytes: fixtureBytes.length,
  content_note: '合成候选人「示例甲」；电话/邮箱为保留示例值（example.test），不对应任何真实候选人（R7）',
})
await saveJson('run-meta.json', {
  run_id: stamp,
  started_at: new Date().toISOString(),
  argv: process.argv,
  cwd: process.cwd(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  git_head: gitHead,
  code_files_sha256: codeState,
  database: { host: DB.host, port: DB.port, database: DB.database, tenant_id: TENANT_ID, actor_id: ACTOR_ID },
  fixture_sha256: fixtureSha,
  job_code: JOB_CODE,
})

// ---- 0 预检 ----
const preflight = await runStep({
  step: 0,
  id: 'preflight',
  label: '预检（库 / 迁移 / 演示租户 / 既有岗位 / 行数）',
  tool: undefined,
  call: async () => {
    const server = (await query('select current_database() as db, now() as now, version() as version'))[0]
    const migrations = (await query('select version from recruitment.schema_migration order by version')).map((r) => r.version)
    const department = (await query(
      'select id, name, hiring_manager_actor_id from recruitment.department where tenant_id = $1', [TENANT_ID]))[0] ?? null
    const actor = (await query(
      'select id, kind, display_name from recruitment.actor where tenant_id = $1 and id = $2', [TENANT_ID, ACTOR_ID]))[0] ?? null
    const existingJob = await readJobByCode(JOB_CODE)
    return {
      server,
      migrations,
      department,
      actor,
      existing_job_with_fixed_code: existingJob,
      decisions_by_scope: await readScreeningDecisionsInTenant(),
      counts: await rowCounts(),
    }
  },
  judge: (record) => record.ok === true && record.result?.actor?.kind === 'HUMAN',
})
if (preflight.outcome !== 'PASS') {
  await blocked('预检失败：库不可达或演示租户/actor 缺失（先确认迁移 0001..0014 已应用）')
  process.exit(3)
}
log(`db=${preflight.result.server.db}  migrations=${preflight.result.migrations.join(',')}`)
log(`department=${preflight.result.department?.name ?? '(none)'} hiring_manager=${preflight.result.department?.hiring_manager_actor_id ?? '(null)'}`)
log(`decision 按 scope（全租户）：${JSON.stringify(preflight.result.decisions_by_scope)}`)
log(`固定 code 的岗位是否已存在：${preflight.result.existing_job_with_fixed_code === null ? '否（首次跑）' : `是（${preflight.result.existing_job_with_fixed_code.id}）→ 本次是重跑`}`)

// ---- 1 job_create ----
const jobCreateTool = createJobCreateTool(DB)
const jobCreateArgs = {
  title: JOB_TITLE,
  code: JOB_CODE,
  status: 'OPEN',
  description_md: '演示岗位：用于证明 S6→S7 的 SCREENING 决策能在仓库内被重跑出来（合成数据）。',
  requirements_md: '后端开发经验；能读懂并落实接口契约。',
  criteria: CRITERIA,
}
const jobCreateStep = await runStep({
  step: 1,
  id: 'job-create',
  label: 'S3 job_create（含 2 条机械型 rubric 准则；只写 PENDING 审批）',
  tool: jobCreateTool,
  args: jobCreateArgs,
  call: async () => jobCreateTool.execute(jobCreateArgs, exec),
  readback: async () => ({ job_by_code: await readJobByCode(JOB_CODE) }),
  judge: (record) => {
    if (record.ok) return record.result?.outcome === 'CREATED' && record.result?.rubric?.version_id !== undefined
    const body = record.error_body
    return record.error?.code === 'INVALID_ARGS'
      && (body?.reason_code === 'DUPLICATE_JOB_CODE' || body?.detail?.code === 'DUPLICATE_JOB_CODE')
  },
})
if (jobCreateStep.outcome !== 'PASS') {
  await blocked('job_create 既没成功、也不是预期的 DUPLICATE_JOB_CODE（见 step-01）')
  process.exit(3)
}

let jobId
let rubricVersionId
if (jobCreateStep.ok) {
  RUN_MODE = 'FIRST_RUN'
  jobId = jobCreateStep.result.job.id
  rubricVersionId = jobCreateStep.result.rubric.version_id
  log(`RUN_MODE=FIRST_RUN  job=${jobId} rubric_version=${rubricVersionId} approval=${jobCreateStep.result.rubric.approval?.status}`)
} else {
  RUN_MODE = 'RERUN'
  const existing = jobCreateStep.readback.job_by_code
  if (existing === null) {
    await blocked('job_create 报 DUPLICATE_JOB_CODE，但按 code 又查不到岗位（库状态不一致）')
    process.exit(3)
  }
  jobId = existing.id
  rubricVersionId = existing.current_rubric_version_id
  log(`RUN_MODE=RERUN  job=${jobId}（复用既有岗位）current_rubric_version_id=${rubricVersionId ?? '(null)'}`)
  if (rubricVersionId === null) {
    // 指针为空说明上一次没批成功：本 harness 不"补跑一半"，直接报出来。
    const blockedNow = await blocked('重跑时 job.current_rubric_version_id 为空：无法确定要批准哪一版 rubric', { job_id: jobId })
    if (blockedNow) process.exit(3)
  }
}

// ---- 2 job_rubric_approve（人机闸门 allow-once；重跑 → NO_OP） ----
const approveStub = makeApproval('allow-once')
const approveTool = createJobRubricApproveTool(DB, { approval: approveStub })
const approveArgs = {
  job_id: jobId,
  rubric_version_id: rubricVersionId,
  reason: '复现 harness：人确认批准该版标准（approval seam 替身 allow-once，闸门本身照常调用）',
}
const approveStep = await runStep({
  step: 2,
  id: 'job-rubric-approve',
  label: 'S3 job_rubric_approve（人机闸门 allow-once → 批准 + 把 current 指针指过去）',
  tool: approveTool,
  args: approveArgs,
  call: async () => approveTool.execute(approveArgs, exec),
  readback: async () => ({
    job: await readJob(jobId),
    rubric_and_approvals: await readRubricAndApprovals(jobId),
    approval_service_calls: approveStub.calls.length,
  }),
  judge: (record) => {
    if (!record.ok) return false
    const outcome = record.result?.outcome
    if (RUN_MODE === 'FIRST_RUN') return outcome === 'APPROVED' && record.result?.replayed === false
    return outcome === 'NO_OP' && record.result?.replayed === true
  },
})
if (approveStep.outcome !== 'PASS') {
  await blocked('rubric 批准没有达到预期结果（首次应 APPROVED / 重跑应 NO_OP replayed=true）（见 step-02）')
  process.exit(3)
}
const jobAfterApprove = approveStep.readback.job
const approved = approveStep.readback.rubric_and_approvals.approvals
  .find((row) => row.resource_id === rubricVersionId && row.status === 'APPROVED' && row.superseded_by_approval_id === null)
const rubricRow = approveStep.readback.rubric_and_approvals.rubrics.find((row) => row.id === rubricVersionId)
log(`approve outcome=${approveStep.result.outcome} replayed=${approveStep.result.replayed} gate=${JSON.stringify(approveStep.result.gate)}`)
log(`job.current_rubric_version_id=${jobAfterApprove.current_rubric_version_id}（= 获批版本？ ${jobAfterApprove.current_rubric_version_id === rubricVersionId}）`)
log(`approval=${approved?.id} status=${approved?.status} hash_match=${approved?.canonical_payload_hash === rubricRow?.payload_hash}`)
if (jobAfterApprove.current_rubric_version_id !== rubricVersionId || approved === undefined) {
  await blocked('批准后 job.current_rubric_version_id 未指向获批版本，或没有生效的 APPROVED 审批行')
  process.exit(3)
}

// ---- 3 application_intake（合成简历；F1 的验收点在这里） ----
const intakeTool = createApplicationIntakeTool({ converter: CONV, database: DB })
const intakeArgs = { path: fileURLToPath(FIXTURE_PDF), job_id: jobId }
const intakeStep = await runStep({
  step: 3,
  id: 'application-intake',
  label: 'S6 application_intake（合成简历 → candidate + application；F1：新建时钉住 rubric）',
  tool: intakeTool,
  args: intakeArgs,
  call: async () => intakeTool.execute(intakeArgs, exec),
  readback: async (record) => {
    const applicationId = record.result?.application_id
    if (typeof applicationId !== 'string') return { found: false }
    return { application: await readApplication(applicationId) }
  },
  judge: (record) => {
    if (!record.ok || record.result?.status !== 'OK') return false
    if (typeof record.result?.application_id !== 'string') return false
    const action = record.result?.application_action ?? (record.result?.created ? 'CREATED' : 'REUSED')
    if (RUN_MODE === 'FIRST_RUN') return action === 'CREATED'
    return action === 'REUSED'
  },
})
if (intakeStep.outcome !== 'PASS') {
  await blocked('S6 intake 没有成功（见 step-03；converter 需要 PyMuPDF 与可执行 python）')
  process.exit(3)
}
const applicationId = intakeStep.result.application_id
const candidateId = intakeStep.result.candidate_id
const applicationAfterIntake = intakeStep.readback.application
log(`intake status=${intakeStep.result.status} application_action=${intakeStep.result.application_action ?? '(n/a)'} application=${applicationId}`)
log(`candidate=${candidateId}（联系方式打码：${maskEmail(SYNTHETIC_EMAIL)} / ${maskPhone(SYNTHETIC_PHONE_NORM)}）`)
log(`application.rubric_version_id=${applicationAfterIntake?.rubric_version_id}（= 获批版本？ ${applicationAfterIntake?.rubric_version_id === rubricVersionId}）`)
log(`application.resume_version_id=${applicationAfterIntake?.resume_version_id} stage=${applicationAfterIntake?.current_stage_code}`)

// **F1 门禁**：申请没钉住 rubric 就不往下走（否则 decision 必然 RUBRIC_VERSION_NOT_FOUND，
// 而"绕过"只能是手工 UPDATE —— 那正是本 harness 要否证的做法）。
const pinnedRubricId = applicationAfterIntake?.rubric_version_id ?? null
if (pinnedRubricId === null || pinnedRubricId !== rubricVersionId) {
  await blocked(
    'F1 未生效：S6 新建的申请没有把岗位当前已批准的 rubric 钉到 application.rubric_version_id'
    + `（期望 ${rubricVersionId}，实际 ${pinnedRubricId ?? 'null'}）—— 这不是 harness 能绕过的，需 f1-rubric-pin 修 src/tools/application-intake.ts`,
  )
  process.exit(3)
}

// ---- 4 screening_evaluate（只读评估） ----
// `as_of` 必须是"现在"，不能用"now-5s"：本 harness 上一秒刚批准 rubric，用回溯时间点会让
// `approved(v, as_of)` 判成未批准 → `NO_RUBRIC/NO_APPROVED_RUBRIC`。这是 as_of 语义的正确行为，
// 不是产品缺陷（第一次跑就踩到了它，见 evidence 里那次 run 的记录）。
const screeningTool = createScreeningEvaluateTool(DB)
const screeningArgs = { application_id: applicationId, as_of: nowIso() }
const screeningStep = await runStep({
  step: 4,
  id: 'screening-evaluate',
  label: 'S7 screening_evaluate（只读、advisory、带逐准则证据）',
  tool: screeningTool,
  args: screeningArgs,
  call: async () => screeningTool.execute(screeningArgs, exec),
  readback: async (record) => ({
    application: await readApplication(applicationId),
    decisions: (await readDecisions(applicationId)).map((d) => ({
      id: d.id, decision_scope: d.decision_scope, result: d.result, decided_at: d.decided_at,
    })),
    rubric_resolution: record.result?.rubric ?? null,
  }),
  judge: (record) => record.ok === true
    && record.result?.status === 'OK'
    && typeof record.result?.verdict === 'string'
    && record.result?.rubric?.resolution === 'APPLICATION_PINNED'
    && record.result?.rubric?.what_if === false
    && record.result?.rubric?.rubric_pin_required === false,
})
if (screeningStep.outcome !== 'PASS') {
  await blocked('screening_evaluate 没有按申请钉住的 rubric 完成评估（见 step-04）')
  process.exit(3)
}
const screeningValue = screeningStep.result
const snapshot = screeningValue.snapshot ?? {}
log(`verdict=${screeningValue.verdict} evaluation_digest=${screeningValue.evaluation_digest}`)
log(`rubric resolution=${screeningValue.rubric.resolution} what_if=${screeningValue.rubric.what_if} pin_required=${screeningValue.rubric.rubric_pin_required} version=${screeningValue.rubric.version_no}`)
log(`criteria_evaluated=${screeningValue.criteria_evaluated} labels=${JSON.stringify(screeningValue.labels)}`)
log(`warnings=${JSON.stringify((screeningValue.warnings ?? []).map((w) => w.code))}`)

/**
 * 这条申请此刻是否**已经有一条 current 的 SCREENING 决策**。
 * 决策那一步的期望由**这个库内事实**决定，而不是由 `run_mode` 猜：
 *   * 没有 → 必须真的写进去（这是"功能能落库"的证据）；
 *   * 有   → 必须被 `uq_decision_current` 拒绝，且一行都不新增（这是"不可重复"的证据）。
 * 两者都是 PASS，但含义完全不同，所以分开记账。
 */
const existingCurrentScreening = (await readDecisions(applicationId))
  .filter((d) => d.decision_scope === 'SCREENING' && d.superseded_by_decision_id === null)
const decisionAlreadyInDb = existingCurrentScreening.length > 0
if (decisionAlreadyInDb) {
  log(`库里已有 current SCREENING 决策：${existingCurrentScreening.map((d) => d.id).join(', ')}（本次决策步必须被唯一约束拒绝）`)
} else {
  log('库里还没有 current SCREENING 决策（本次决策步必须真的写进去）')
}

// ---- 5 decision_record(SCREENING)（IN_CHAT v2） ----
const authority = await readAuthority(jobId)
const isHiringManager = authority?.hiring_manager_actor_id !== null
  && String(authority?.hiring_manager_actor_id).toLowerCase() === ACTOR_ID.toLowerCase()
const decisionResult = screeningValue.verdict === 'PASS'
  ? 'ADVANCE'
  : screeningValue.verdict === 'FAIL' ? 'REJECT' : 'HOLD'
const decisionReason = decisionResult === 'ADVANCE'
  ? '初筛通过：work_exists 与 edu_exists 两条 MUST_HAVE 均满足（依据 SCREENING_EVALUATION 的逐准则证据）。'
  : `按初筛建议记录：${screeningValue.verdict}（依据 SCREENING_EVALUATION）。`
const basisRefs = [
  {
    kind: 'RUBRIC_VERSION',
    id: snapshot.rubric_version_id,
    payload_hash: snapshot.rubric_payload_hash,
    version_no: screeningValue.rubric.version_no,
  },
  { kind: 'AUTHORITY', actor_id: ACTOR_ID, is_hiring_manager: isHiringManager },
  {
    kind: 'SCREENING_EVALUATION',
    evaluation_digest: screeningValue.evaluation_digest,
    verdict: screeningValue.verdict,
    rubric_version_id: snapshot.rubric_version_id,
    rubric_payload_hash: snapshot.rubric_payload_hash,
    resume_version_id: snapshot.resume_version_id,
    resume_content_sha256: snapshot.resume_content_sha256,
    contract_version: screeningValue.contract_version,
    criteria_evaluated: screeningValue.criteria_evaluated,
    provenance: screeningValue.labels?.provenance,
  },
  {
    kind: 'RESUME_VERSION',
    id: snapshot.resume_version_id,
    content_sha256: snapshot.resume_content_sha256,
  },
]
const confirmedAt = nowMinus(60)
const decisionArgs = {
  application_id: applicationId,
  decision_scope: 'SCREENING',
  as_of: nowIso(),
  result: decisionResult,
  reason: decisionReason,
  basis_refs: basisRefs,
  human_confirmation: {
    confirmed_by_actor_id: ACTOR_ID,
    confirmed_at: confirmedAt,
    confirmation_method: 'IN_CHAT',
    confirmation_text: CONFIRMATION_TEXT,
    confirmation_text_sha256: confirmationTextSha256({
      result: decisionResult,
      reason: decisionReason,
      override_rationale: null,
      basis_refs: basisRefs,
      confirmation_text: CONFIRMATION_TEXT,
      confirmed_by_actor_id: ACTOR_ID,
      confirmed_at: confirmedAt,
    }),
  },
}
// IN_CHAT（D-95）：人已在对话里说过，**不再**弹二次确认；approval 依赖故意给 unavailable，
// 用来证明"这条决策不依赖消费 approval 通道"。
const decisionApproval = makeApproval('unavailable')
const decisionTool = createDecisionRecordTool({ database: DB, approval: decisionApproval })
const decisionStep = await runStep({
  step: 5,
  id: 'decision-record-screening',
  label: 'S7 decision_record(decision_scope=SCREENING)（D-95 IN_CHAT v2，真实写库）',
  tool: decisionTool,
  args: decisionArgs,
  call: async () => decisionTool.execute(decisionArgs, exec),
  readback: async () => {
    const decisions = await readDecisions(applicationId)
    return {
      application: await readApplication(applicationId),
      decisions,
      decision_events: await readDecisionEvents(decisions.map((d) => d.id)),
      approval_service_calls: decisionApproval.calls.length,
    }
  },
  judge: (record) => {
    if (!decisionAlreadyInDb) {
      // 库里没有 → 必须真的写进去（决策落库的正向证据）。
      return record.ok === true
        && record.result?.status === 'OK'
        && record.result?.decision?.decision_scope === 'SCREENING'
        && record.result?.decision?.stage_code === 'S7'
        && record.result?.decision?.result === decisionResult
        && record.result?.decision?.decided_by_actor_id === ACTOR_ID
        && (record.row_count_delta.decision ?? 0) === 1
    }
    // 库里已有 → 唯一约束（uq_decision_current，0008 可延迟排斥约束）必须拒绝，且一行都不新增。
    const code = String(record.error?.code ?? '')
    const reasonCode = String(record.error_body?.reason_code ?? '')
    return record.ok === false
      && (code === 'ALREADY_DECIDED' || reasonCode === 'SCOPE_ALREADY_DECIDED')
      && (record.row_count_delta.decision ?? 0) === 0
  },
})
if (decisionStep.outcome !== 'PASS') {
  await blocked('decision_record(SCREENING) 没有达到预期结果（见 step-05）', {
    run_mode: RUN_MODE,
    decision_already_in_db: decisionAlreadyInDb,
    hint: decisionAlreadyInDb
      ? '库里已有 current SCREENING 决策 → 期望被 uq_decision_current 拒绝且不新增行'
      : '库里没有 current SCREENING 决策 → 期望真的写进去；若被拒，看 error_body.reason_code（不得用人工 UPDATE/直接 SQL 绕过）',
  })
  process.exit(3)
}
const decisionWrittenThisRun = decisionStep.ok === true

// ---- 6 终态读回 ----
const finalReadback = await runStep({
  step: 6,
  id: 'db-readback',
  label: 'DB 读回（决策行 / 内部事件 / 申请链条 / 行数差）',
  tool: undefined,
  call: async () => {
    const application = await readApplication(applicationId)
    const decisions = await readDecisions(applicationId)
    const events = await readDecisionEvents(decisions.map((d) => d.id))
    return {
      application,
      job: await readJob(jobId),
      rubric_and_approvals: await readRubricAndApprovals(jobId),
      candidate_masked: (await query(`
        select id, identity_status, display_name,
               regexp_replace(normalized_email, '^(.{3}).*(@.*)$', '\\1***\\2') as email_masked,
               regexp_replace(normalized_phone, '^(\\+86\\d{3}).*(\\d{2})$', '\\1***\\2') as phone_masked
          from recruitment.candidate where tenant_id = $1 and id = $2`, [TENANT_ID, candidateId]))[0] ?? null,
      screening_decisions: decisions.filter((d) => d.decision_scope === 'SCREENING'),
      all_decisions_for_application: decisions,
      decision_events: events,
      decisions_by_scope_in_tenant: await readScreeningDecisionsInTenant(),
      counts: await rowCounts(),
      counts_delta_vs_preflight: diffCounts(preflight.result.counts, await rowCounts()),
    }
  },
  judge: (record) => {
    const screening = record.result?.screening_decisions ?? []
    // 无论第几次跑：同一个申请只允许有一条 current SCREENING 决策。
    if (!(record.ok === true && screening.length === 1)) return false
    // 本次真的写了 → 必须有且只有一条内部事件；被唯一约束拒绝 → 事件数不变（不新增）。
    return decisionWrittenThisRun ? record.result?.decision_events?.length === 1 : true
  },
})

if (finalReadback.outcome !== 'PASS') {
  await blocked('DB 读回没有达到预期（决策行/内部事件数不对，或读回 SQL 失败；见 step-06）', {
    run_mode: RUN_MODE,
    decision_written_this_run: decisionWrittenThisRun,
  })
  process.exit(3)
}

const final = finalReadback.result
const screeningDecision = final.screening_decisions[0] ?? null
log('')
log('════════ 汇总 ════════')
log(`run_mode                = ${RUN_MODE}`)
log(`决策是否本次写入         = ${decisionWrittenThisRun}（运行前库里已有 current SCREENING 决策？ ${decisionAlreadyInDb}）`)
log(`job                     = ${final.job.id} code=${final.job.code} status=${final.job.status}`)
log(`job.current_rubric      = ${final.job.current_rubric_version_id}`)
log(`rubric_version          = ${rubricVersionId} version_no=${rubricRow?.version_no} approvals=${JSON.stringify(final.rubric_and_approvals.approvals.map((a) => a.status))}`)
log(`candidate               = ${final.candidate_masked?.id} ${final.candidate_masked?.display_name}（email=${final.candidate_masked?.email_masked} phone=${final.candidate_masked?.phone_masked}）`)
log(`application             = ${final.application.id} stage=${final.application.current_stage_code} lifecycle=${final.application.lifecycle_status}`)
log(`application.rubric      = ${final.application.rubric_version_id}（F1 已钉住）`)
log(`application.resume      = ${final.application.resume_version_id}`)
log(`screening verdict       = ${screeningValue.verdict}（${screeningValue.evaluation_digest}）`)
log(`decision(SCREENING)     = ${screeningDecision === null ? '(none)' : `${screeningDecision.id} scope=${screeningDecision.decision_scope} stage=${screeningDecision.stage_code} result=${screeningDecision.result} decided_by=${screeningDecision.decided_by_actor_id} decided_at=${new Date(screeningDecision.decided_at).toISOString()}`}`)
log(`decision basis_refs     = ${screeningDecision?.basis_ref_count} kinds=${JSON.stringify(screeningDecision?.basis_kinds)}`)
log(`decision 内部事件        = ${final.decision_events.map((e) => `${e.event_type}/${e.idempotency_source}/${e.idempotency_key}`).join(', ') || '(none)'}`)
log(`全租户 decision 按 scope = ${JSON.stringify(final.decisions_by_scope_in_tenant)}`)
log(`本次行数变化             = ${JSON.stringify(final.counts_delta_vs_preflight)}`)

const summary = {
  run_id: stamp,
  run_mode: RUN_MODE,
  decision_already_in_db_before_step5: decisionAlreadyInDb,
  decision_written_this_run: decisionWrittenThisRun,
  generated_at: new Date().toISOString(),
  harness: {
    path: fileURLToPath(new URL('./run-screening-decision.mjs', HERE)),
    sha256: sha256(await readFile(fileURLToPath(new URL('./run-screening-decision.mjs', HERE)))),
  },
  git_head: gitHead,
  code_files_sha256: codeState,
  fixture: { path: fileURLToPath(FIXTURE_PDF), sha256: fixtureSha, bytes: fixtureBytes.length },
  database: { host: DB.host, port: DB.port, database: DB.database, tenant_id: TENANT_ID, actor_id: ACTOR_ID },
  job: final.job,
  rubric: { version_id: rubricVersionId, version_no: rubricRow?.version_no, approvals: final.rubric_and_approvals.approvals },
  candidate_masked: final.candidate_masked,
  application: final.application,
  screening: {
    verdict: screeningValue.verdict,
    evaluation_digest: screeningValue.evaluation_digest,
    rubric_resolution: screeningValue.rubric.resolution,
    what_if: screeningValue.rubric.what_if,
    rubric_pin_required: screeningValue.rubric.rubric_pin_required,
    criteria_evaluated: screeningValue.criteria_evaluated,
    labels: screeningValue.labels,
    warnings: (screeningValue.warnings ?? []).map((w) => w.code),
  },
  decision: screeningDecision,
  decision_events: final.decision_events,
  steps: steps.map((record) => ({
    step: record.step,
    id: record.id,
    tool: record.tool,
    run_mode: record.run_mode,
    outcome: record.outcome,
    ok: record.ok,
    error_code: record.error?.code,
    reason_code: record.error_body?.reason_code,
    row_delta: record.row_count_delta,
  })),
  counts_delta_vs_preflight: final.counts_delta_vs_preflight,
}
await saveJson('summary.json', summary)

const readbackText = [
  `run_mode: ${RUN_MODE}`,
  `run_id: ${stamp}`,
  `git_head: ${gitHead}`,
  '',
  '-- job --',
  JSON.stringify(final.job, null, 2),
  '',
  '-- rubric_version + approvals --',
  JSON.stringify(final.rubric_and_approvals, null, 2),
  '',
  '-- candidate (masked, R7) --',
  JSON.stringify(final.candidate_masked, null, 2),
  '',
  '-- application --',
  JSON.stringify(final.application, null, 2),
  '',
  '-- decision(SCREENING) --',
  JSON.stringify(final.screening_decisions, null, 2),
  '',
  '-- decision.record 内部事件 --',
  JSON.stringify(final.decision_events, null, 2),
  '',
  `-- decisions by scope (tenant) --\n${JSON.stringify(final.decisions_by_scope_in_tenant, null, 2)}`,
  '',
  `-- counts delta vs preflight --\n${JSON.stringify(final.counts_delta_vs_preflight, null, 2)}`,
].join('\n')
await writeFile(new URL('db-readback.txt', RUN_DIR), readbackText + '\n', 'utf8')

log('')
log('════════ STEP 汇总表 ════════')
log('step | id                       | tool                              | outcome | error/reason            | row delta')
log('-----+--------------------------+-----------------------------------+---------+-------------------------+----------')
for (const record of steps) {
  const err = record.error_code === undefined ? '' : `${record.error_code}/${record.error_body?.reason_code ?? ''}`
  log(`${String(record.step).padStart(4)} | ${record.id.padEnd(24)} | ${String(record.tool).padEnd(33)} | ${record.outcome.padEnd(7)} | ${err.padEnd(23)} | ${JSON.stringify(record.row_count_delta)}`)
}
log('')
log(`summary     : ${fileURLToPath(new URL('summary.json', RUN_DIR))}`)
log(`db readback : ${fileURLToPath(new URL('db-readback.txt', RUN_DIR))}`)
log(`run log     : ${LOG_PATH}`)
if (!decisionWrittenThisRun) {
  log('')
  log('本次为何不能重复写一条决策：')
  log('  1) 岗位用固定 code → uq_job_code(tenant_id, code) 拒绝重复岗位（INVALID_ARGS/DUPLICATE_JOB_CODE）；')
  log('  2) 批准已生效 → job_rubric_approve 返回 NO_OP, replayed=true（零额外写入、不再问人）；')
  log('  3) 同 candidate+job → intake 复用同一条申请（application_action=REUSED）；')
  log('  4) 决策唯一 → 写库前 STEP 3 就查到 current 决策 → ALREADY_DECIDED/SCOPE_ALREADY_DECIDED；')
  log('     （`0008` 的 uq_decision_current 可延迟排斥约束是并发/重入时的最后防线，本次没走到它）')
  log('  全库没有删任何行、没有手工 UPDATE。')
}

await flushLog()
await pool.end()
process.exitCode = 0
