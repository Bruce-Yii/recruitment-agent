// Golden Path 端到端 harness（S6 → S10）：**真实工具对象 execute() + 真实 PostgreSQL + 真实 converter**。
//
// 这**不是**单测、也不是插件运行时的一部分（package.json 的 files 不含 manual/）。它做的事：
//   1. 用产品同一份 `resolveConverterConfig` / `resolveDatabaseConfig` 构造配置（密码只从环境变量来）；
//   2. 用 `create*Tool(...)` 拿到**真实的工具定义**，只通过 `tool.execute(args, exec)` 调用；
//   3. 每一跳之后用只读 SQL 读回数据库（不写业务表；写只经过工具）；
//   4. 把命令、请求、响应/错误、DB 读回、行数对比写进 evidence/experiments/2026-11-14-golden-path-e2e/。
//
// 硬边界（任务书）：
//   * 不放宽任何闸门：S8/S10 的 approval 用 allow-once 替身（或 denied/unavailable 负例），
//     但**闸门本身照常调用**；decision 走 D-95 v2（IN_CHAT + 逐字 confirmation_text + 服务端同一份 hash 实现）。
//   * 不伪造 LIVE：本 harness 的数据全是合成 fixture；工具若返回 LIVE 而事实是 FIXTURE，按 R4 记账为工具缺陷。
//   * 不直接写库：写只经 `tool.execute()`；`pg` 只用于 SELECT 读回与行数统计。
//
// 重复执行：固定 candidate（合成电话/邮箱）→ S6 第二次会 REUSED；S8/S10 用固定 idempotency_key
// → 第二次 replayed=true；S9 同内容 replayed=true（TR-U8）。HOP 表会明确标出这一点。
//
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='<本机演示库密码，按约定注入，不落盘>'
//   node manual/golden-path/run-golden-path.mjs
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, copyFile, appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

import { createApplicationIntakeTool } from '../../src/tools/application-intake.ts'
import { createScreeningEvaluateTool } from '../../src/tools/screening-evaluate.ts'
import { createInterviewScheduleTool } from '../../src/tools/interview-schedule.ts'
import { createInterviewGetTool } from '../../src/tools/interview-get.ts'
import { createTranscriptImportTool } from '../../src/tools/transcript-import.ts'
import { createTranscriptReadTool } from '../../src/tools/transcript-read.ts'
import { createScorecardSubmitTool } from '../../src/tools/scorecard-submit.ts'
import { createEvaluationSummarizeTool } from '../../src/tools/evaluation-summarize.ts'
import { createDecisionRecordTool, confirmationTextSha256 } from '../../src/tools/decision-record.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { resolveConverterConfig } from '../../src/tools/converter.ts'

// ---------------------------------------------------------------------------
//  固定事实（演示租户 + 合成数据；不碰任何真实候选人）
// ---------------------------------------------------------------------------
const TENANT_ID = '11111111-1111-4111-8111-000000000001'
const ACTOR_ID = '11111111-1111-4111-8111-000000000103' // 演示-HR 专员（HUMAN）
const INTERVIEWER_2_ID = '11111111-1111-4111-8111-000000000104' // 演示-面试官（HUMAN）
const JOB_ID = '11111111-1111-4111-8111-000000000401' // DEMO-BE-001（OPEN，rubric v2 已批准）
const SCREENING_CONFIRMATION = '我确认：林承宇这条申请初筛通过，推进到面试。'
const STAGE_CONFIRMATION = '我确认：林承宇这一轮面试通过，进入下一轮。'
/** 固定面试时间：本轮（2026-11-14）之后、可重复执行期间有效；过期后需更新。 */
const SCHEDULED_START_AT = '2026-12-02T10:00:00+08:00'
// 幂等键在 S6 之后按 application_id 生成（见下方 scheduleKey / scorecardKey）：
// 同一条申请重跑 → 同一个键 → replay；不同申请互不串键（否则会 IDEMPOTENCY_KEY_REUSED）。
/** 合成候选人的强标识（与 fixtures/build_synthetic_resume.py 生成 PDF 里的值一致）。
 *  换一个合成身份重跑时，用 GOLDEN_PATH_EMAIL / GOLDEN_PATH_PHONE_NORM 同步两端。 */
const SYNTHETIC_EMAIL = process.env.GOLDEN_PATH_EMAIL ?? 'lin.chengyu.gp6@example.test'
const SYNTHETIC_PHONE_NORM = process.env.GOLDEN_PATH_PHONE_NORM ?? '+8613600000733'

const HERE = new URL('./', import.meta.url)
const PKG_ROOT = new URL('../../', HERE)
const REPO_ROOT = new URL('../../../../', HERE)
const FIXTURE_PDF = new URL('./fixtures/synthetic-resume-golden-path.pdf', HERE)
const CONVERTER_DIR = new URL('converter/', REPO_ROOT)
const PYTHON_BIN = process.env.RECRUITMENT_PYTHON_BIN ?? 'D:\\Python3.12.9\\python.exe'
const EVIDENCE_ROOT = new URL('./evidence/experiments/2026-11-14-golden-path-e2e/', PKG_ROOT)

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const RUN_DIR = new URL(`run-${stamp}/`, EVIDENCE_ROOT)
const LOG_PATH = fileURLToPath(new URL('run.log', RUN_DIR))

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------
const abort = new AbortController()
const exec = { signal: abort.signal, callId: `golden-path-${stamp}` }

const out = []
function log(line = '') {
  out.push(line)
  console.log(line)
}

let logFlush = Promise.resolve()
function flushLog() {
  // 串行追加，避免并发写把行截断。
  logFlush = logFlush.then(() => appendFile(LOG_PATH, out.splice(0).join('\n') + '\n', 'utf8'))
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

/** 现在 - N 秒（as_of / confirmed_at 必须不晚于服务端 now）。 */
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

// ---------------------------------------------------------------------------
//  配置（产品同一份 resolver；密码只从环境变量）
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
  console.error(`[golden-path] DB 配置不完整：${dbResolved.issues.join('; ')}`)
  process.exit(2)
}
const DB = dbResolved.resolved

const convResolved = resolveConverterConfig({
  python_bin: PYTHON_BIN,
  converter_dir: fileURLToPath(CONVERTER_DIR),
  // 边界收紧：harness 只允许读自己的合成 fixture 目录（产品 profile 的 allowed_roots 不包含仓库）。
  allowed_roots: [fileURLToPath(new URL('./fixtures/', HERE))],
  timeout_ms: 180_000,
})
if (convResolved.resolved === null) {
  console.error(`[golden-path] converter 配置不完整：${convResolved.issues.join('; ')}`)
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
  application_name: 'golden-path-harness',
})

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params)
  return rows
}

/** 全表行数快照（前后对比用；只读）。 */
async function rowCounts() {
  const rows = await query(`
    select 'candidate' as t, count(*)::int as n from recruitment.candidate
    union all select 'application', count(*)::int from recruitment.application
    union all select 'resume', count(*)::int from recruitment.resume
    union all select 'resume_version', count(*)::int from recruitment.resume_version
    union all select 'intake_asset', count(*)::int from recruitment.intake_asset
    union all select 'intake_record', count(*)::int from recruitment.intake_record
    union all select 'event_inbox', count(*)::int from recruitment.event_inbox
    union all select 'decision', count(*)::int from recruitment.decision
    union all select 'interview', count(*)::int from recruitment.interview
    union all select 'interviewer', count(*)::int from recruitment.interviewer
    union all select 'meeting', count(*)::int from recruitment.meeting
    union all select 'meeting_binding', count(*)::int from recruitment.meeting_binding
    union all select 'transcript_artifact', count(*)::int from recruitment.transcript_artifact
    union all select 'transcript_segment', count(*)::int from recruitment.transcript_segment
    union all select 'interview_record', count(*)::int from recruitment.interview_record
    union all select 'scorecard', count(*)::int from recruitment.scorecard
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
//  HOP 记录器
// ---------------------------------------------------------------------------
const hops = []

/**
 * 每跳的角色：write = 正常写库；read = 只读；
 * negative-control = 故意让闸门拒绝（期望一行不写）；
 * expected-blocker = 已知产品缺陷，期望被工具自己拒绝（不得为了"跑通"绕过）。
 */
const HOP_KIND = {
  's6-intake': 'write',
  's7-screening-evaluate': 'read',
  's7-decision-screening': 'expected-blocker',
  's8-schedule-denied': 'negative-control',
  's8-schedule-allow-once': 'write',
  's8-interview-get': 'read',
  's9-transcript-import': 'write',
  's9-transcript-read': 'read',
  's10-scorecard-denied': 'negative-control',
  's10-scorecard-allow-once': 'write',
  's10-evaluation-summarize': 'expected-blocker',
  's10-decision-stage': 'expected-blocker',
}

/**
 * 跑一跳：调用真实工具 + 读回数据库。
 * @param {object} input - { id, hop, label, tool, args, readback?, expect? }
 */
async function runHop(input) {
  const before = await rowCounts()
  const record = {
    id: input.id,
    kind: HOP_KIND[input.id] ?? 'unknown',
    hop: input.hop,
    label: input.label,
    tool: input.tool.name,
    started_at: new Date().toISOString(),
    request: input.args,
  }
  log('')
  log(`──────── HOP ${input.hop} · ${input.label} ────────`)
  log(`tool      : ${input.tool.name}`)
  log(`request   : ${JSON.stringify(input.args, null, 1).replace(/\n/g, '\n            ')}`)
  let value
  try {
    value = await input.tool.execute(input.args, exec)
    record.ok = true
    record.result = value
    log('result    : OK')
    try {
      const rendered = input.tool.output.render(input.args, value)
        .map((block) => block.text).join('\n')
      record.rendered = rendered
      log(rendered.split('\n').map((line) => `  ${line}`).join('\n'))
    } catch (renderError) {
      record.render_error = String(renderError)
      log(`  (render 失败: ${String(renderError)})`)
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
      record.readback = await input.readback()
      log(`readback  : ${JSON.stringify(record.readback, null, 1).replace(/\n/g, '\n            ')}`)
    } catch (readbackError) {
      record.readback_error = String(readbackError)
      log(`readback  : ERROR ${String(readbackError)}`)
    }
  }
  const expected = input.expect
  record.outcome = expected === undefined
    ? (record.ok ? 'PASS' : 'FAIL')
    : (expected(record) ? 'PASS' : 'FAIL')
  log(`outcome   : ${record.outcome}`)
  hops.push(record)
  await saveJson(`hop-${String(input.hop).padStart(2, '0')}-${input.id}.json`, record)
  await flushLog()
  return record
}

// ---------------------------------------------------------------------------
//  读回查询（全部只读；敏感值打码）
// ---------------------------------------------------------------------------
const MASKED_CANDIDATE_SQL = `
  select c.id,
         c.identity_status,
         c.display_name,
         regexp_replace(c.normalized_email, '^(.{3}).*(@.*)$', '\\1***\\2') as email_masked,
         regexp_replace(c.normalized_phone, '^(\\+86\\d{3}).*(\\d{2})$', '\\1***\\2') as phone_masked
    from recruitment.candidate c
   where c.tenant_id = $1 and c.id = $2`

async function readApplication(applicationId) {
  const rows = await query(`
    select id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
           lifecycle_status, current_stage_code, record_version, created_at
      from recruitment.application where tenant_id = $1 and id = $2`, [TENANT_ID, applicationId])
  return rows[0] ?? null
}

async function readDecisions(applicationId) {
  return query(`
    select id, decision_scope, stage_code, result, decided_by_actor_id, decided_at,
           jsonb_array_length(basis_refs) as basis_count,
           (select array_agg(distinct b->>'kind') from jsonb_array_elements(basis_refs) b) as basis_kinds,
           superseded_by_decision_id
      from recruitment.decision where tenant_id = $1 and application_id = $2
     order by decided_at`, [TENANT_ID, applicationId])
}

async function readApplicationChain(applicationId) {
  const app = await readApplication(applicationId)
  if (app === null) return null
  const resume = app.resume_version_id === null ? null : (await query(`
    select rv.id, rv.version_no, rv.parse_status, rv.content_sha256, rv.source_asset_sha256,
           r.id as resume_id, r.intake_asset_id
      from recruitment.resume_version rv join recruitment.resume r on r.id = rv.resume_id
     where rv.tenant_id = $1 and rv.id = $2`, [TENANT_ID, app.resume_version_id]))[0] ?? null
  const candidate = (await query(MASKED_CANDIDATE_SQL, [TENANT_ID, app.candidate_id]))[0] ?? null
  const asset = resume === null ? null : (await query(`
    select id, file_name, byte_size, sha256, validation_status, intake_record_id
      from recruitment.intake_asset where tenant_id = $1 and id = $2`, [TENANT_ID, resume.intake_asset_id]))[0] ?? null
  // 材料摄入事件：source_object_id = 原件 sha256，idempotency_key = resume.intake:<sha>（见 application-intake.ts）。
  const events = resume === null ? [] : await query(`
    select event_id, provider, trust_level, event_type, idempotency_source, source_object_id, occurred_at
      from recruitment.event_inbox
     where tenant_id = $1 and idempotency_key = $2
     order by recorded_at`, [TENANT_ID, `resume.intake:${resume.source_asset_sha256}`])
  return { application: app, candidate, resume_version: resume, intake_asset: asset, events }
}

async function readInterview(interviewId) {
  const interview = (await query(`
    select id, application_id, round_no, slot_code, stage_code, status,
           scheduled_start_at, scheduled_end_at, timezone, record_version
      from recruitment.interview where tenant_id = $1 and id = $2`, [TENANT_ID, interviewId]))[0] ?? null
  if (interview === null) return null
  const interviewers = await query(`
    select i.actor_id, a.display_name, i.role_in_interview, i.required_scorecard, i.scorecard_due_at
      from recruitment.interviewer i join recruitment.actor a on a.id = i.actor_id and a.tenant_id = i.tenant_id
     where i.tenant_id = $1 and i.interview_id = $2 order by i.created_at`, [TENANT_ID, interviewId])
  const bindings = await query(`
    select b.id, b.meeting_id, m.provider, m.account_scope, m.external_meeting_id, m.calendar_event_id,
           b.binding_method, b.bound_at, b.unbound_at
      from recruitment.meeting_binding b join recruitment.meeting m on m.id = b.meeting_id and m.tenant_id = b.tenant_id
     where b.tenant_id = $1 and b.interview_id = $2 order by b.bound_at`, [TENANT_ID, interviewId])
  const artifacts = await query(`
    select a.id, a.source_revision, a.is_canonical, a.provenance, a.trigger_mode, a.connection_state,
           a.transcript_status, a.content_sha256, a.provider, a.provider_artifact_id
      from recruitment.transcript_artifact a
     where a.tenant_id = $1 and a.meeting_id in (
       select mb.meeting_id from recruitment.meeting_binding mb
        where mb.tenant_id = $1 and mb.interview_id = $2)
     order by a.source_revision, a.created_at`, [TENANT_ID, interviewId])
  const segments = await query(`
    select count(*)::int as n from recruitment.transcript_segment
     where tenant_id = $1 and artifact_id in (select id from recruitment.transcript_artifact
       where tenant_id = $1 and meeting_id in (select meeting_id from recruitment.meeting_binding
         where tenant_id = $1 and interview_id = $2))`, [TENANT_ID, interviewId])
  const records = await query(`
    select id, transcript_artifact_id, transcript_revision, status, verification_status, evidence_ok, is_current
      from recruitment.interview_record where tenant_id = $1 and interview_id = $2 order by created_at`, [TENANT_ID, interviewId])
  const scorecards = await query(`
    select id, interviewer_id, rubric_version_id, status, overall, revision_no, record_version,
           superseded_by_scorecard_id
      from recruitment.scorecard where tenant_id = $1 and interview_id = $2 order by created_at`, [TENANT_ID, interviewId])
  const tasks = await query(`
    select id, task_type, status, business_refs from recruitment.business_task
     where tenant_id = $1 and business_refs @> $2::jsonb order by created_at`,
  [TENANT_ID, JSON.stringify([{ kind: 'INTERVIEW', id: interviewId }])])
  const events = await query(`
    select event_id, provider, trust_level, event_type, source_object_id
      from recruitment.event_inbox
     where tenant_id = $1 and source_object_id = $2 order by recorded_at`, [TENANT_ID, interviewId])
  return {
    interview, interviewers, meeting_bindings: bindings, transcript_artifacts: artifacts,
    transcript_segment_count: segments[0]?.n ?? 0, interview_records: records,
    scorecards, business_tasks: tasks, events,
  }
}

// ---------------------------------------------------------------------------
//  主流程
// ---------------------------------------------------------------------------
await mkdir(RUN_DIR, { recursive: true })
await mkdir(EVIDENCE_ROOT, { recursive: true })

log('Golden Path end-to-end harness（S6 → S10）')
log(`运行时间        : ${new Date().toISOString()}`)
log(`仓库 HEAD       : ${process.env.GOLDEN_PATH_HEAD ?? '(未设置 GOLDEN_PATH_HEAD；请在命令里带上 git rev-parse HEAD)'}`)
log(`数据库          : ${DB.user}@${DB.host}:${DB.port}/${DB.database}（只读读回；写只经工具）`)
log(`租户 / actor    : ${TENANT_ID} / ${ACTOR_ID}（HUMAN）`)
log(`岗位            : ${JOB_ID}（DEMO-BE-001，合成演示租户）`)
log(`合成简历        : ${fileURLToPath(FIXTURE_PDF)}`)
log(`合成身份        : ${SYNTHETIC_EMAIL} / ${SYNTHETIC_PHONE_NORM}（合成值，不对应任何真实候选人）`)
log(`证据目录        : ${fileURLToPath(RUN_DIR)}`)
log('')

const fixtureBytes = await readFile(FIXTURE_PDF)
const fixtureSha = sha256(fixtureBytes)
log(`fixture sha256  : ${fixtureSha}（${fixtureBytes.length} bytes）`)
await saveJson('fixture.json', {
  path: fileURLToPath(FIXTURE_PDF),
  sha256: fixtureSha,
  bytes: fixtureBytes.length,
  content_note: '合成候选人「林承宇」；电话/邮箱为保留示例值，不对应任何真实候选人（R7）',
})
await copyFile(FIXTURE_PDF, fileURLToPath(new URL('fixture-synthetic-resume-golden-path.pdf', RUN_DIR)))

// ---- 0 预检：库 / 迁移 / 岗位 / rubric ----
log('')
log('════════ HOP 0 · 预检（DB / 迁移 / 岗位 / rubric） ════════')
const preflight = {}
try {
  preflight.server = (await query('select current_database() as db, now() as now, version() as version'))[0]
  preflight.migrations = (await query('select version from recruitment.schema_migration order by version')).map((r) => r.version)
  preflight.job = (await query(`
    select j.id, j.code, j.title, j.status, j.current_job_version_id, j.current_rubric_version_id,
           d.hiring_manager_actor_id
      from recruitment.job j left join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
     where j.tenant_id = $1 and j.id = $2`, [TENANT_ID, JOB_ID]))[0] ?? null
  preflight.rubrics = await query(`
    select rv.id, rv.version_no, rv.payload_hash,
           coalesce(jsonb_agg(jsonb_build_object('status', a.status, 'hash_match',
             (a.canonical_payload_hash = rv.payload_hash))
             order by a.created_at) filter (where a.id is not null), '[]'::jsonb) as approvals,
           jsonb_array_length(rv.dimensions) as dimension_count,
           (select array_agg(d->>'key') from jsonb_array_elements(rv.dimensions) d) as dimension_keys
      from recruitment.rubric_version rv
      left join recruitment.approval a on a.tenant_id = rv.tenant_id and a.resource_type = 'RUBRIC_VERSION'
       and a.resource_id = rv.id
     where rv.tenant_id = $1 and rv.job_id = $2
     group by rv.id, rv.version_no, rv.payload_hash, rv.dimensions order by rv.version_no`, [TENANT_ID, JOB_ID])
  preflight.actor = (await query('select id, kind, display_name from recruitment.actor where tenant_id = $1 and id = $2', [TENANT_ID, ACTOR_ID]))[0] ?? null
  preflight.hiring_manager_is_actor = preflight.job?.hiring_manager_actor_id === ACTOR_ID
  preflight.counts = await rowCounts()
  preflight.decisions_by_scope = await query(`
    select decision_scope, count(*)::int as n from recruitment.decision where tenant_id = $1 group by 1 order by 1`, [TENANT_ID])
  preflight.both_bound = (await query(`
    select count(*)::int as n from recruitment.application
     where tenant_id = $1 and resume_version_id is not null and rubric_version_id is not null`, [TENANT_ID]))[0]?.n
} catch (error) {
  log(`预检失败：${String(error)}`)
  await flushLog()
  await pool.end()
  process.exit(1)
}
log(`db=${preflight.server.db}  migrations=${preflight.migrations.join(',')}`)
log(`job=${preflight.job.code} status=${preflight.job.status} current_rubric=${preflight.job.current_rubric_version_id}`)
log(`hiring_manager_actor_id=${preflight.job.hiring_manager_actor_id}（actor 103 是 hiring manager? ${preflight.hiring_manager_is_actor}）`)
for (const rubric of preflight.rubrics) {
  log(`rubric v${rubric.version_no} id=${rubric.id} hash=${rubric.payload_hash.slice(0, 16)}… dims=${JSON.stringify(rubric.dimension_keys)} approvals=${JSON.stringify(rubric.approvals)}`)
}
log(`预检行数：${JSON.stringify(preflight.counts)}`)
log(`全库 decision 按 scope：${JSON.stringify(preflight.decisions_by_scope)}`)
log(`全库「材料 + rubric 都已绑定」的申请数（both_bound）：${preflight.both_bound}`)
await saveJson('hop-00-preflight.json', preflight)
await flushLog()

if (preflight.job === null || preflight.job.status !== 'OPEN') {
  log('')
  log('BLOCKED：演示岗位不存在或不是 OPEN，后续无法继续。')
  await flushLog()
  await pool.end()
  process.exit(2)
}
const approvedRubric = preflight.rubrics.find((r) =>
  r.approvals.some((a) => a.status === 'APPROVED' && a.hash_match === true))
if (approvedRubric === undefined) {
  log('')
  log('BLOCKED：演示岗位没有「已批准且 hash 对齐」的 rubric 版本，S7 无法执行。')
  await flushLog()
  await pool.end()
  process.exit(2)
}
log(`用于 S7 的已批准 rubric：v${approvedRubric.version_no} ${approvedRubric.id}`)

// ---- 1 S6 intake ----
const intakeTool = createApplicationIntakeTool({ converter: CONV, database: DB })
const intake = await runHop({
  id: 's6-intake',
  hop: 1,
  label: 'S6 application_intake（简历 → candidate + application，绑定 material/version）',
  tool: intakeTool,
  args: { path: fileURLToPath(FIXTURE_PDF), job_id: JOB_ID },
  readback: async () => {
    // S6 之前不知道 application_id：用合成候选人的强标识（native_text 归一化后）反查刚写入的申请。
    const rows = await query(`
      select a.id from recruitment.application a join recruitment.candidate c on c.id = a.candidate_id
       where a.tenant_id = $1 and a.job_id = $2
         and (c.normalized_email = $3 or c.normalized_phone = $4)
       order by a.created_at desc limit 1`, [TENANT_ID, JOB_ID, SYNTHETIC_EMAIL, SYNTHETIC_PHONE_NORM])
    if (rows[0] === undefined) return { found: false }
    return readApplicationChain(rows[0].id)
  },
  expect: (record) => record.ok === true
    && record.result?.status === 'OK'
    && typeof record.result?.application_id === 'string'
    && typeof record.result?.resume_version_id === 'string',
})
const applicationId = intake.result?.application_id
const candidateId = intake.result?.candidate_id
const resumeVersionIdFromHop = intake.result?.resume_version_id
if (typeof applicationId !== 'string') {
  log('')
  log('BLOCKED：S6 intake 没有返回 application_id，后续全部无法继续。')
  await flushLog()
  await pool.end()
  process.exit(2)
}
const appAfterIntake = await readApplication(applicationId)
log(`application=${applicationId} stage=${appAfterIntake.current_stage_code} lifecycle=${appAfterIntake.lifecycle_status} rubric_version_id=${appAfterIntake.rubric_version_id}`)
log(`candidate=${candidateId} resume_version=${resumeVersionIdFromHop} rubric_pinned=${appAfterIntake.rubric_version_id !== null}`)
// 幂等键按 application_id 派生：同一条申请重跑 → 同一个键（replay）；
// 不同申请 → 不同键（避免 IDEMPOTENCY_KEY_REUSED）。负例用独立键，避免与正例互撞。
const scheduleKey = `gp-e2e:${applicationId}:schedule-r1`
const scheduleKeyDenied = `gp-e2e:${applicationId}:schedule-r2-denied`
const scorecardKey = `gp-e2e:${applicationId}:scorecard-103`
const scorecardKeyDenied = `gp-e2e:${applicationId}:scorecard-103-denied`

// ---- 2 S7 screening_evaluate ----
const screeningTool = createScreeningEvaluateTool(DB)
const screening = await runHop({
  id: 's7-screening-evaluate',
  hop: 2,
  label: 'S7 screening_evaluate（只读、advisory、带证据）',
  tool: screeningTool,
  args: { application_id: applicationId, as_of: nowMinus(5) },
  readback: async () => ({
    application: await readApplication(applicationId),
    decisions: await readDecisions(applicationId),
  }),
  expect: (record) => record.ok === true && record.result?.status === 'OK' && typeof record.result?.verdict === 'string',
})
const screeningValue = screening.result
log(`verdict=${screeningValue?.verdict} evaluation_digest=${screeningValue?.evaluation_digest}`)
log(`rubric resolution=${screeningValue?.rubric?.resolution} pin_required=${screeningValue?.rubric?.rubric_pin_required} what_if=${screeningValue?.rubric?.what_if}`)
log(`warnings=${JSON.stringify((screeningValue?.warnings ?? []).map((w) => w.code))}`)
log(`criteria_evaluated=${screeningValue?.criteria_evaluated} reasons=${JSON.stringify((screeningValue?.reasons ?? []).map((r) => `${r.criterion_key ?? ''}:${r.code}:${r.outcome ?? ''}`))}`)

// ---- 3 S7 decision_record(SCREENING) —— 期望被产品缺陷挡住 ----
const snapshot = screeningValue?.snapshot
const screeningRubricId = snapshot?.rubric_version_id
const screeningRubricHash = snapshot?.rubric_payload_hash
const screeningResumeId = snapshot?.resume_version_id
const screeningResumeSha = snapshot?.resume_content_sha256
const screeningBasisRefs = [
  {
    kind: 'RUBRIC_VERSION',
    id: screeningRubricId,
    payload_hash: screeningRubricHash,
    version_no: screeningValue?.rubric?.version_no,
  },
  {
    kind: 'AUTHORITY',
    actor_id: ACTOR_ID,
    is_hiring_manager: preflight.hiring_manager_is_actor,
  },
  {
    kind: 'SCREENING_EVALUATION',
    evaluation_digest: screeningValue?.evaluation_digest,
    verdict: screeningValue?.verdict,
    rubric_version_id: screeningRubricId,
    rubric_payload_hash: screeningRubricHash,
    resume_version_id: screeningResumeId,
    resume_content_sha256: screeningResumeSha,
    contract_version: screeningValue?.contract_version,
    criteria_evaluated: screeningValue?.criteria_evaluated,
    provenance: screeningValue?.labels?.provenance,
  },
  {
    kind: 'RESUME_VERSION',
    id: screeningResumeId,
    content_sha256: screeningResumeSha,
  },
]
const screeningReason = screeningValue?.verdict === 'PASS'
  ? '初筛通过：work_exists 与 edu_exists 两条 MUST_HAVE 均满足（依据 SCREENING_EVALUATION 的逐准则证据）。'
  : '按初筛建议记录：需要人工判断（依据 SCREENING_EVALUATION）。'
const screeningConfirmedAt = nowMinus(60)
const screeningDecisionArgs = {
  application_id: applicationId,
  decision_scope: 'SCREENING',
  as_of: nowMinus(5),
  result: screeningValue?.verdict === 'PASS' ? 'ADVANCE' : 'HOLD',
  reason: screeningReason,
  basis_refs: screeningBasisRefs,
  human_confirmation: {
    confirmed_by_actor_id: ACTOR_ID,
    confirmed_at: screeningConfirmedAt,
    confirmation_method: 'IN_CHAT',
    confirmation_text: SCREENING_CONFIRMATION,
    confirmation_text_sha256: confirmationTextSha256({
      result: screeningValue?.verdict === 'PASS' ? 'ADVANCE' : 'HOLD',
      reason: screeningReason,
      override_rationale: null,
      basis_refs: screeningBasisRefs,
      confirmation_text: SCREENING_CONFIRMATION,
      confirmed_by_actor_id: ACTOR_ID,
      confirmed_at: screeningConfirmedAt,
    }),
  },
}
const screeningApproval = makeApproval('unavailable')
const decisionTool = createDecisionRecordTool({ database: DB, approval: screeningApproval })
const screeningDecision = await runHop({
  id: 's7-decision-screening',
  hop: 3,
  label: 'S7 decision_record(SCREENING)（D-103 写侧 + D-95 IN_CHAT v2）',
  tool: decisionTool,
  args: screeningDecisionArgs,
  readback: async () => ({
    application: await readApplication(applicationId),
    decisions: await readDecisions(applicationId),
    approval_service_calls: screeningApproval.calls.length,
  }),
  expect: (record) => record.ok === true
    || (record.error?.code === 'NOT_FOUND' && record.error_body?.reason_code === 'RUBRIC_VERSION_NOT_FOUND'),
})
log(`SCREENING 决策结果：${screeningDecision.ok ? 'WROTE' : `BLOCKED(${screeningDecision.error?.code}/${screeningDecision.error_body?.reason_code ?? '?'})`}`)
log(`approval.request 调用次数：${screeningApproval.calls.length}（IN_CHAT 按 D-95 不再二次弹确认）`)

// ---- 4 S8 interview_schedule：先 denied 负例（一行不写），再 allow-once 正例 ----
const scheduleDeniedApproval = makeApproval('deny')
const scheduleDeniedTool = createInterviewScheduleTool(DB, { approval: scheduleDeniedApproval })
// 负例用**另一轮**（round 2）：第一轮已有面试后，重复排同一轮会先撞业务冲突，
// 那就测不到闸门了。round 2 从来不会真的写（deny 恒败），可重复执行。
// 不带 meeting：负例只测"闸门拒绝前一行不写"，不需要占外部会议号（也避免与别的合成会议撞绑定）。
const scheduleDeniedArgs = {
  intent: 'CREATE',
  idempotency_key: scheduleKeyDenied,
  application_id: applicationId,
  round_no: 2,
  slot_code: 'DEFAULT',
  scheduled_start_at: '2026-12-03T10:00:00+08:00',
  duration_minutes: 60,
  timezone: 'Asia/Shanghai',
  delivery_mode: 'VIDEO',
  interviewers: [
    { actor_id: ACTOR_ID, role_in_interview: 'INTERVIEWER', required_scorecard: true },
    { actor_id: INTERVIEWER_2_ID, role_in_interview: 'INTERVIEWER', required_scorecard: true },
  ],
}
// 外部会议号按 application 派生：不同合成申请不能共用同一个 external_meeting_id
//（否则第二次会被 MEETING_ALREADY_BOUND 挡住——这是数据冲突，不是闸门）。
const meetingTag = applicationId.replaceAll('-', '').slice(0, 12)
const scheduleArgs = {
  intent: 'CREATE',
  idempotency_key: scheduleKey,
  application_id: applicationId,
  round_no: 1,
  slot_code: 'DEFAULT',
  scheduled_start_at: SCHEDULED_START_AT,
  duration_minutes: 60,
  timezone: 'Asia/Shanghai',
  delivery_mode: 'VIDEO',
  interviewers: [
    { actor_id: ACTOR_ID, role_in_interview: 'INTERVIEWER', required_scorecard: true },
    { actor_id: INTERVIEWER_2_ID, role_in_interview: 'INTERVIEWER', required_scorecard: true },
  ],
  meeting: {
    provider: 'SYNTHETIC_DEMO',
    account_scope: 'golden-path',
    calendar_event_id: `synthetic-calendar-${meetingTag}`,
    external_meeting_id: `synthetic-meeting-${meetingTag}`,
    meeting_role: 'PRIMARY',
  },
}
const scheduleDenied = await runHop({
  id: 's8-schedule-denied',
  hop: 4,
  label: 'S8 interview_schedule 负例：approval=deny（D-79 fail closed，必须一行不写）',
  tool: scheduleDeniedTool,
  args: scheduleDeniedArgs,
  readback: async () => ({
    approval_requests: scheduleDeniedApproval.calls.length,
    interviews_for_application: await query(
      'select round_no, slot_code, status from recruitment.interview where tenant_id = $1 and application_id = $2 order by round_no',
      [TENANT_ID, applicationId]),
  }),
  expect: (record) => record.ok === false
    && record.error?.code === 'FORBIDDEN'
    && record.error_body?.reason_code === 'APPROVAL_NOT_GRANTED'
    && (record.row_count_delta.interview ?? 0) === 0,
})
log(`denied 负例：${scheduleDenied.ok ? 'UNEXPECTED WRITE' : `${scheduleDenied.error?.code}/${scheduleDenied.error_body?.reason_code}（approval requests=${scheduleDeniedApproval.calls.length}）`}`)

const scheduleApproval = makeApproval('allow-once')
const scheduleTool = createInterviewScheduleTool(DB, { approval: scheduleApproval })
const schedule = await runHop({
  id: 's8-schedule-allow-once',
  hop: 5,
  label: 'S8 interview_schedule（人机闸门 allow-once + 真实写库）',
  tool: scheduleTool,
  args: scheduleArgs,
  readback: async () => {
    const rows = await query(`
      select id from recruitment.interview where tenant_id = $1 and application_id = $2
       and round_no = 1 and slot_code = 'DEFAULT' order by created_at desc limit 1`, [TENANT_ID, applicationId])
    return {
      approval_requests: scheduleApproval.calls.length,
      interview: rows[0] === undefined ? null : await readInterview(rows[0].id),
    }
  },
  expect: (record) => record.ok === true
    && typeof scheduleResultId(record) === 'string',
})
let interviewId = scheduleResultId(schedule)
log(`interview_id=${interviewId ?? '(none)'} approval requests=${scheduleApproval.calls.length}`)
if (interviewId === undefined) {
  // 回放路径也要能从库里找到这场面试（用 application + round 1 反查）。
  const rows = await query(`
    select id from recruitment.interview where tenant_id = $1 and application_id = $2
     and round_no = 1 and slot_code = 'DEFAULT' order by created_at desc limit 1`, [TENANT_ID, applicationId])
  interviewId = rows[0]?.id
}
log(`used interview_id=${interviewId ?? '(none)'}`)
const interviewRead = interviewId === undefined ? null : await readInterview(interviewId)
log(`readback interview.status=${interviewRead?.interview?.status} stage=${interviewRead?.interview?.stage_code} round=${interviewRead?.interview?.round_no}`)
log(`readback interviewers=${JSON.stringify((interviewRead?.interviewers ?? []).map((i) => `${i.display_name}:${i.role_in_interview}`))}`)
log(`readback meeting_bindings=${JSON.stringify((interviewRead?.meeting_bindings ?? []).map((b) => `${b.provider}:${b.external_meeting_id}:unbound=${b.unbound_at}`))}`)

function scheduleResultId(record) {
  const value = record?.result
  if (value === undefined || value === null) return undefined
  return value.interview?.id ?? value.interview_id ?? value.interview?.interview_id
}

// ---- 6 S8 interview_get ----
const interviewGetTool = createInterviewGetTool(DB)
if (interviewId !== undefined) {
  await runHop({
    id: 's8-interview-get',
    hop: 6,
    label: 'S8 interview_get（面试 + 会议绑定 + 转写 + 面评状态）',
    tool: interviewGetTool,
    args: { interview_id: interviewId },
    readback: async () => readInterview(interviewId),
    expect: (record) => record.ok === true,
  })
} else {
  log('HOP 6 SKIPPED：没有 interview_id。')
}

// ---- 7 S9 transcript_import ----
const transcriptContent = [
  '（合成演示转写，仅用于 Golden Path 联调，不对应任何真实会议）',
  '面试官：先做个自我介绍吧。',
  '候选人：我是林承宇，做后端开发六年，主要做交易链路和数据同步。',
  '面试官：讲一个你做过的幂等改造。',
  '候选人：支付回调以前会重复入账，我加了幂等键和状态机，重复回调直接返回成功。',
  '面试官：如果重试一直失败，你们怎么处理？',
  '候选人：进死信队列，人工确认后重放，同时保留原始报文做对账。',
  '面试官：设计一个任务调度服务，怎么保证不重复执行？',
  '候选人：先按任务 ID 做唯一约束，再在消费端做幂等，配合租约和超时。',
  '面试官：时间差不多了，后续有消息会同步给你。',
  '候选人：好的，谢谢。',
].join('\n')
const transcriptImportTool = createTranscriptImportTool(DB)
if (interviewId !== undefined) {
  const meetingId = interviewRead?.meeting_bindings?.find((b) => b.unbound_at === null)?.meeting_id
  await runHop({
    id: 's9-transcript-import',
    hop: 7,
    label: 'S9 transcript_import（人工导入合成转写；DEMO_SAMPLE → FIXTURE 标签）',
    tool: transcriptImportTool,
    args: {
      interview_id: interviewId,
      content: transcriptContent,
      source_kind: 'DEMO_SAMPLE',
      language: 'zh',
      ...(meetingId === undefined ? {} : { meeting_id: meetingId }),
      note: 'Golden Path 端到端联调：合成演示转写',
    },
    readback: async () => readInterview(interviewId),
    expect: (record) => record.ok === true,
  })
} else {
  log('HOP 7 SKIPPED：没有 interview_id。')
}

// ---- 8 S9 transcript_read ----
const transcriptReadTool = createTranscriptReadTool(DB)
if (interviewId !== undefined) {
  await runHop({
    id: 's9-transcript-read',
    hop: 8,
    label: 'S9 transcript_read（canonical 状态 + 正文切片）',
    tool: transcriptReadTool,
    args: { interview_id: interviewId, include_text: false, as_of: nowMinus(5) },
    readback: async () => readInterview(interviewId),
    expect: (record) => record.ok === true,
  })
} else {
  log('HOP 8 SKIPPED：没有 interview_id。')
}

// ---- 9 S10 scorecard_submit：先 denied 负例（一行不写），再 allow-once 正例 ----
const scorecardItems = {
  work_exists: {
    assessment: 'MET',
    score: 4,
    note: '候选人有 3 段可分割的后端工作经历，职责边界清楚。',
  },
  edu_exists: {
    assessment: 'MET',
    score: 4,
    note: '本科计算机科学与技术，学历与时间线完整。',
  },
  team_lead: {
    assessment: 'MET',
    note: '候选人自述在第二段经历中带过 3 人小组约一年；面试中能讲清分工与复盘。',
  },
  transcript_basis: 'TRANSCRIPT',
}
const scorecardArgs = {
  interview_id: interviewId,
  // 该申请没有钉住 rubric（S6 不写 application.rubric_version_id），按工具契约在入参里给版本。
  rubric_version_id: approvedRubric.id,
  items: scorecardItems,
  overall: 'ADVANCE',
  idempotency_key: scorecardKeyDenied,
}
if (interviewId !== undefined) {
  // 负例只在"还没有面评"时能证明闸门本身；第二次执行时面评已存在，业务校验会先拒绝，
  // 那时把负例降级为"任何拒绝路径都不得写行"，并在日志里如实标注。
  const hadScorecardBefore = (await query(`
    select count(*)::int as n from recruitment.scorecard
     where tenant_id = $1 and interview_id = $2`, [TENANT_ID, interviewId]))[0].n > 0
  const scorecardDeniedApproval = makeApproval('deny')
  const scorecardDeniedTool = createScorecardSubmitTool({ database: DB, approval: scorecardDeniedApproval })
  const scorecardDenied = await runHop({
    id: 's10-scorecard-denied',
    hop: 9,
    label: hadScorecardBefore
      ? 'S10 scorecard_submit 负例：面评已存在（业务拒绝路径不得写行；不再重复证明闸门）'
      : 'S10 scorecard_submit 负例：approval=deny（D-79 fail closed，必须一行不写）',
    tool: scorecardDeniedTool,
    args: scorecardArgs,
    readback: async () => ({
      approval_requests: scorecardDeniedApproval.calls.length,
      scorecards: (await query(
        'select count(*)::int as n from recruitment.scorecard where tenant_id = $1 and interview_id = $2',
        [TENANT_ID, interviewId]))[0].n,
    }),
    expect: (record) => {
      if ((record.row_count_delta.scorecard ?? 0) !== 0) return false
      if (record.ok) return false
      if (hadScorecardBefore) return true
      return record.error?.code === 'FORBIDDEN'
        && record.error_body?.reason_code === 'APPROVAL_NOT_GRANTED'
    },
  })
  log(`scorecard denied：${scorecardDenied.ok ? 'UNEXPECTED WRITE' : `${scorecardDenied.error?.code}/${scorecardDenied.error_body?.reason_code}（approval requests=${scorecardDeniedApproval.calls.length}）`}`)

  const scorecardApproval = makeApproval('allow-once')
  const scorecardTool = createScorecardSubmitTool({ database: DB, approval: scorecardApproval })
  await runHop({
    id: 's10-scorecard-allow-once',
    hop: 10,
    label: 'S10 scorecard_submit（面试官本人 + 人机闸门 allow-once）',
    tool: scorecardTool,
    args: { ...scorecardArgs, idempotency_key: scorecardKey },
    readback: async () => readInterview(interviewId),
    expect: (record) => record.ok === true,
  })
  log(`scorecard allow-once approval requests=${scorecardApproval.calls.length}`)
} else {
  log('HOP 9/10 SKIPPED：没有 interview_id。')
}

// ---- 11 S10 evaluation_summarize ----
const summarizeTool = createEvaluationSummarizeTool({ database: DB })
const summarizeHop = interviewId === undefined ? null : await runHop({
  id: 's10-evaluation-summarize',
  hop: 11,
  label: 'S10 evaluation_summarize（只读汇总，不产结论）',
  tool: summarizeTool,
  args: { application_id: applicationId, decision_scope: 'STAGE', interview_id: interviewId, as_of: nowMinus(5) },
  readback: async () => ({ application: await readApplication(applicationId) }),
  expect: (record) => record.ok === true
    || (record.error?.code === 'NOT_FOUND' && record.error_body?.reason_code === 'RUBRIC_VERSION_NOT_FOUND'),
})
log(`summarize：${summarizeHop?.ok ? 'OK' : `BLOCKED(${summarizeHop?.error?.code}/${summarizeHop?.error_body?.reason_code ?? '?'})`}`)

// ---- 12 S10 decision_record(STAGE) ----
const stageConfirmedAt = nowMinus(60)
const stageReason = '面试评估通过：工作经历与教育背景满足岗位 MUST_HAVE，建议进入下一轮。'
const stageResult = 'ADVANCE'
const stageBasisRefs = [
  { kind: 'RUBRIC_VERSION', id: approvedRubric.id, payload_hash: approvedRubric.payload_hash, version_no: approvedRubric.version_no },
  { kind: 'AUTHORITY', actor_id: ACTOR_ID, is_hiring_manager: preflight.hiring_manager_is_actor },
  { kind: 'INTERVIEW_RECORD', id: randomUUID() },
]
const stageDecisionArgs = {
  application_id: applicationId,
  decision_scope: 'STAGE',
  interview_id: interviewId ?? randomUUID(),
  as_of: nowMinus(5),
  result: stageResult,
  reason: stageReason,
  // 汇总被 pin 挡住，拿不到真实 summary_digest；这里给一个**形状合法的占位**，
  // 只为证明决策在更早的 STEP 2（rubric pin）就已经被拒，而不是 summary 语义问题。
  summary_digest: sha256('summary-not-available-because-rubric-pin-missing'),
  basis_refs: stageBasisRefs,
  human_confirmation: {
    confirmed_by_actor_id: ACTOR_ID,
    confirmed_at: stageConfirmedAt,
    confirmation_method: 'IN_CHAT',
    confirmation_text: STAGE_CONFIRMATION,
    confirmation_text_sha256: confirmationTextSha256({
      result: stageResult,
      reason: stageReason,
      override_rationale: null,
      basis_refs: stageBasisRefs,
      confirmation_text: STAGE_CONFIRMATION,
      confirmed_by_actor_id: ACTOR_ID,
      confirmed_at: stageConfirmedAt,
    }),
  },
}
{
  const stageApproval = makeApproval('unavailable')
  const stageDecisionTool = createDecisionRecordTool({ database: DB, approval: stageApproval })
  const stageDecision = await runHop({
    id: 's10-decision-stage',
    hop: 12,
    label: 'S10 decision_record(STAGE)（IN_CHAT v2；期望同样被 rubric pin 挡住）',
    tool: stageDecisionTool,
    args: stageDecisionArgs,
    readback: async () => ({
      application: await readApplication(applicationId),
      decisions: await readDecisions(applicationId),
      approval_service_calls: stageApproval.calls.length,
    }),
    expect: (record) => record.ok === true
      || (record.error?.code === 'NOT_FOUND' && record.error_body?.reason_code === 'RUBRIC_VERSION_NOT_FOUND'),
  })
  log(`STAGE 决策：${stageDecision.ok ? 'WROTE' : `BLOCKED(${stageDecision.error?.code}/${stageDecision.error_body?.reason_code ?? '?'})`}`)
}

// ---- 13 终态读回 ----
log('')
log('════════ HOP 13 · 终态读回（同一条申请 S6→S10 的全部事实） ════════')
const finalChain = await readApplicationChain(applicationId)
const finalDecisions = await readDecisions(applicationId)
const finalInterviews = await query(`
  select id, round_no, slot_code, stage_code, status, scheduled_start_at
    from recruitment.interview where tenant_id = $1 and application_id = $2 order by round_no, slot_code`,
[TENANT_ID, applicationId])
const finalInterviewDetails = []
for (const interview of finalInterviews) {
  finalInterviewDetails.push(await readInterview(interview.id))
}
const finalCounts = await rowCounts()
const finalState = {
  application: finalChain?.application ?? null,
  candidate: finalChain?.candidate ?? null,
  resume_version: finalChain?.resume_version ?? null,
  intake_asset: finalChain?.intake_asset ?? null,
  application_events: finalChain?.events ?? [],
  decisions: finalDecisions,
  interviews: finalInterviewDetails,
  counts: finalCounts,
  counts_delta_vs_preflight: diffCounts(preflight.counts, finalCounts),
  decisions_by_scope: await query(`
    select decision_scope, stage_code, count(*)::int as n from recruitment.decision
     where tenant_id = $1 group by 1, 2 order by 1, 2`, [TENANT_ID]),
}
await saveJson('hop-13-final-state.json', finalState)
log(`application.current_stage_code = ${finalState.application?.current_stage_code}（期望 S10；实际取决于是否有阶段推进工具）`)
log(`application.rubric_version_id   = ${finalState.application?.rubric_version_id}`)
log(`application.resume_version_id   = ${finalState.application?.resume_version_id}`)
log(`decisions for this application  = ${finalDecisions.length} 条 ${JSON.stringify(finalDecisions.map((d) => `${d.decision_scope}/${d.stage_code}/${d.result}`))}`)
log(`interviews for this application = ${finalInterviews.length} 场 ${JSON.stringify(finalInterviews.map((i) => `r${i.round_no}/${i.status}`))}`)
log(`transcript artifacts            = ${JSON.stringify(finalInterviewDetails.map((d) => (d?.transcript_artifacts ?? []).map((a) => `rev${a.source_revision}/canonical=${a.is_canonical}/${a.provenance}`)))}`)
log(`scorecards                      = ${JSON.stringify(finalInterviewDetails.map((d) => (d?.scorecards ?? []).map((s) => `${s.status}/${s.overall}/author=${s.interviewer_id.slice(-3)}`)))}`)
log(`行数对比（预检 → 终态，只列变化）：${JSON.stringify(finalState.counts_delta_vs_preflight)}`)
await flushLog()

// ---- 14 汇总 ----
const HOP_TABLE = hops.map((record) => ({
  hop: record.hop,
  id: record.id,
  kind: record.kind,
  tool: record.tool,
  outcome: record.outcome,
  ok: record.ok,
  error_code: record.error?.code,
  reason_code: record.error_body?.reason_code,
  row_delta: record.row_count_delta,
}))
const harnessSha = sha256(await readFile(fileURLToPath(new URL('./run-golden-path.mjs', HERE))))
const summary = {
  run_id: stamp,
  generated_at: new Date().toISOString(),
  harness: { path: fileURLToPath(new URL('./run-golden-path.mjs', HERE)), sha256: harnessSha },
  fixture: { path: fileURLToPath(FIXTURE_PDF), sha256: fixtureSha },
  database: { host: DB.host, port: DB.port, database: DB.database, tenant_id: TENANT_ID, actor_id: ACTOR_ID },
  application_id: applicationId,
  candidate_id: candidateId,
  interview_id: interviewId,
  hops: HOP_TABLE,
  // 产品缺陷导致的“期望内的失败”：这些跳**不允许**被当作 PASS，也不允许为了跑通而绕过。
  product_blockers: hops
    .filter((record) => record.kind === 'expected-blocker' && record.ok === false)
    .map((record) => ({
      hop: record.hop, id: record.id, code: record.error?.code,
      reason_code: record.error_body?.reason_code, detail: record.error_body?.detail,
    })),
  negative_controls: hops
    .filter((record) => record.kind === 'negative-control')
    .map((record) => ({
      hop: record.hop, id: record.id, blocked: record.ok === false,
      code: record.error?.code, reason_code: record.error_body?.reason_code,
      row_delta: record.row_count_delta,
    })),
  failures: hops.filter((record) => record.outcome === 'FAIL').map((record) => ({ hop: record.hop, id: record.id, code: record.error?.code, message: record.error?.message })),
  final_state: {
    application_stage: finalState.application?.current_stage_code,
    application_rubric_version_id: finalState.application?.rubric_version_id,
    decision_count: finalDecisions.length,
    decision_scopes: finalState.decisions_by_scope,
    interview_count: finalInterviews.length,
    counts: finalCounts,
  },
}
await saveJson('summary.json', summary)

log('')
log('════════ HOP 汇总表 ════════')
log('hop | kind             | id                        | outcome | error/reason                          | row delta')
log('----+------------------+---------------------------+---------+---------------------------------------+----------')
for (const row of HOP_TABLE) {
  const err = row.error_code === undefined ? '' : `${row.error_code}/${row.reason_code ?? ''}`
  log(`${String(row.hop).padStart(3)} | ${String(row.kind).padEnd(16)} | ${row.id.padEnd(25)} | ${row.outcome.padEnd(7)} | ${err.padEnd(37)} | ${JSON.stringify(row.row_delta)}`)
}
log('')
log(`产品缺陷阻断跳（expected-blocker 且被拒）：${summary.product_blockers.map((b) => `HOP${b.hop}(${b.id}) ${b.code}/${b.reason_code}`).join(' ; ') || '无'}`)
log(`闸门负例（期望被拒）：${summary.negative_controls.map((b) => `HOP${b.hop}(${b.id}) ${b.blocked ? 'BLOCKED' : 'UNEXPECTED-WRITE'} ${b.code}/${b.reason_code ?? ''} delta=${JSON.stringify(b.row_delta)}`).join(' ; ') || '无'}`)
log(`意外失败（outcome=FAIL）：${summary.failures.length} 个`)
log('')
log(`summary: ${fileURLToPath(new URL('summary.json', RUN_DIR))}`)
await flushLog()
await pool.end()
if (summary.failures.length > 0) process.exitCode = 1
