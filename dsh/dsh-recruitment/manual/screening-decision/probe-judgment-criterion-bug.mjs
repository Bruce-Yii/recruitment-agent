// 复现「判断型 rubric 准则（`field` 缺省）+ `job_create` → `screening_evaluate` 崩溃」这个产品缺陷。
//
// 缺陷事实（2026-11-14 由 `run-screening-decision.mjs` 第一版顺手撞出来）：
//   * `recruitment_job_create` 把准则归一化成**固定 9 键**：判断型准则（只给 `question`）
//     落库是 `"field": null` / `"operator": null` / `"value": null`；
//   * `recruitment_screening_evaluate` 的 `evaluateCriterion()` 只用
//     `criterion.field === undefined` 判"判断型"（走 NEEDS_JUDGMENT 分支）；
//     `null` 不满足 `=== undefined` → 掉进 `resolveFieldFact(ctx, null)` →
//     `TypeError: Cannot read properties of null (reading 'startsWith')`。
//
// 后果：**用产品自己的唯一入口建出来的、含判断型准则的 rubric，S7 根本评估不了**。
// 之前那份"能跑通"的验收之所以没撞到，是因为它的 rubric 是手工 SQL 插的——那份 JSON
// 里判断型准则**没有 `field` 键**（`undefined`），正好绕过这个分支。
// 也就是说：这不是"环境差异"，而是"手钉 rubric"掩盖了产品缺陷。
//
// 本脚本全程走真实工具（job_create → job_rubric_approve → application_intake → screening_evaluate），
// 只做**复现与取证**，不做修复（改 src 不在本 lane 的范围）。
//
// 用法（PowerShell；仓库根 = recruitment-agent）：
//   $env:RECRUITMENT_DB_PASSWORD='<本机演示库密码，按约定注入，不落盘>'
//   node dsh/dsh-recruitment/manual/screening-decision/probe-judgment-criterion-bug.mjs
//   退出码：0 = 缺陷复现（拿到 TypeError）；1 = 没复现（需要重新判断）；2 = 配置问题。
import { createHash } from 'node:crypto'
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

import { createJobCreateTool } from '../../src/tools/job-create.ts'
import { createJobRubricApproveTool } from '../../src/tools/job-rubric-approve.ts'
import { createApplicationIntakeTool } from '../../src/tools/application-intake.ts'
import { createScreeningEvaluateTool } from '../../src/tools/screening-evaluate.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { resolveConverterConfig } from '../../src/tools/converter.ts'

const TENANT_ID = '11111111-1111-4111-8111-000000000001'
const ACTOR_ID = '11111111-1111-4111-8111-000000000103'
const JOB_CODE = 'REPRO-JUDGMENT-CRIT'
/** 含**判断型**准则（只有 question、没有 field）的 rubric。 */
const CRITERIA = [
  {
    key: 'work_exists',
    label: '简历中存在可分割的工作经历条目',
    kind: 'MUST_HAVE',
    weight: 0.5,
    field: 'work_experience',
    operator: 'EXISTS',
    value: true,
  },
  {
    key: 'edu_exists',
    label: '简历中存在可分割的教育条目',
    kind: 'MUST_HAVE',
    weight: 0.25,
    field: 'education',
    operator: 'EXISTS',
    value: true,
  },
  {
    key: 'team_lead',
    label: '有带团队经验',
    kind: 'NICE_TO_HAVE',
    weight: 0.25,
    question: '是否有 ≥1 年、≥3 人的直接带团队经历？',
    notes: '判断型：机器不判，只进 bonus_signals',
  },
]

const HERE = new URL('./', import.meta.url)
const PKG_ROOT = new URL('../../', HERE)
const REPO_ROOT = new URL('../../../../', HERE)
const FIXTURE_PDF = new URL('./fixtures/synthetic-resume-screening-repro.pdf', HERE)
const CONVERTER_DIR = new URL('converter/', REPO_ROOT)
const PYTHON_BIN = process.env.RECRUITMENT_PYTHON_BIN ?? 'D:\\Python3.12.9\\python.exe'
const EVIDENCE_ROOT = new URL('./evidence/experiments/2026-11-14-screening-decision-repro/bug-judgment-criterion/', PKG_ROOT)
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const RUN_DIR = new URL(`run-${stamp}/`, EVIDENCE_ROOT)
const LOG_PATH = fileURLToPath(new URL('run.log', RUN_DIR))

const lines = []
function log(line = '') {
  lines.push(line)
  console.log(line)
}
let logFlush = Promise.resolve()
function flushLog() {
  logFlush = logFlush.then(() => appendFile(LOG_PATH, lines.splice(0).join('\n') + '\n', 'utf8'))
  return logFlush
}
async function saveJson(name, value) {
  await writeFile(new URL(name, RUN_DIR), JSON.stringify(value, null, 2), 'utf8')
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
function toOffsetIso(date = new Date(), offsetMinutes = 480) {
  const t = new Date(date.getTime() + offsetMinutes * 60_000)
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
    + `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`
}
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
function makeApproval(mode) {
  let used = false
  return {
    async request() {
      if (mode === 'allow-once') {
        if (used) return 'rejected'
        used = true
        return 'allowed-once'
      }
      return 'unavailable'
    },
  }
}

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
  console.error(`DB 配置不完整：${dbResolved.issues.join('; ')}`)
  process.exit(2)
}
const DB = dbResolved.resolved
const convResolved = resolveConverterConfig({
  python_bin: PYTHON_BIN,
  converter_dir: fileURLToPath(CONVERTER_DIR),
  allowed_roots: [fileURLToPath(new URL('./fixtures/', HERE))],
  timeout_ms: 180_000,
})
if (convResolved.resolved === null) {
  console.error(`converter 配置不完整：${convResolved.issues.join('; ')}`)
  process.exit(2)
}
const CONV = convResolved.resolved

const pool = new pg.Pool({
  host: DB.host, port: DB.port, user: DB.user, database: DB.database, password: DB.password,
  max: 2, connectionTimeoutMillis: 10_000, application_name: 'judgment-crit-probe',
})
const query = async (sql, params = []) => (await pool.query(sql, params)).rows

await mkdir(RUN_DIR, { recursive: true })
const exec = { signal: new AbortController().signal, callId: `judgment-crit-${stamp}` }
const fixtureSha = sha256(await readFile(FIXTURE_PDF))

log('复现：判断型 rubric 准则（job_create 存 field=null）→ screening_evaluate TypeError')
log(`运行时间   : ${new Date().toISOString()}`)
log(`数据库     : ${DB.user}@${DB.host}:${DB.port}/${DB.database}`)
log(`合成简历   : ${fileURLToPath(FIXTURE_PDF)} sha256=${fixtureSha}`)
log(`证据目录   : ${fileURLToPath(RUN_DIR)}`)
log('')

// ---- 1 job_create（含判断型准则） ----
const jobCreate = createJobCreateTool(DB)
let jobId
let rubricVersionId
let jobCreated = false
try {
  const value = await jobCreate.execute({
    title: '后端工程师（判断型准则缺陷复现岗）',
    code: JOB_CODE,
    status: 'OPEN',
    description_md: '缺陷复现：rubric 里带一条判断型准则。',
    requirements_md: '后端开发经验。',
    criteria: CRITERIA,
  }, exec)
  jobId = value.job.id
  rubricVersionId = value.rubric.version_id
  jobCreated = true
  log(`STEP 1 job_create  : CREATED job=${jobId} rubric=${rubricVersionId}`)
} catch (error) {
  const body = errorBody(error)
  if (error?.code !== 'INVALID_ARGS' || body?.reason_code !== 'DUPLICATE_JOB_CODE') throw error
  const existing = (await query(
    'select id, current_rubric_version_id from recruitment.job where tenant_id = $1 and code = $2',
    [TENANT_ID, JOB_CODE]))[0]
  jobId = existing.id
  rubricVersionId = existing.current_rubric_version_id
  if (rubricVersionId === null) {
    rubricVersionId = (await query(
      `select id from recruitment.rubric_version where tenant_id = $1 and job_id = $2
        order by version_no desc limit 1`, [TENANT_ID, jobId]))[0]?.id ?? null
  }
  log(`STEP 1 job_create  : DUPLICATE_JOB_CODE → 复用 job=${jobId} rubric=${rubricVersionId}`)
}
if (rubricVersionId === null) {
  log('BLOCKED：找不到 rubric 版本')
  await saveJson('summary.json', { reproduced: false, reason: 'rubric_version_missing', job_id: jobId })
  await flushLog()
  await pool.end()
  process.exit(2)
}

// ---- 2 approve（让 rubric 达到"已批准"，否则 screening 会先报 NO_APPROVED_RUBRIC） ----
const approveTool = createJobRubricApproveTool(DB, { approval: makeApproval('allow-once') })
const approveValue = await approveTool.execute({ job_id: jobId, rubric_version_id: rubricVersionId, reason: '缺陷复现：批准该版 rubric' }, exec)
log(`STEP 2 approve     : outcome=${approveValue.outcome} replayed=${approveValue.replayed}`)

// ---- 3 intake ----
const intakeTool = createApplicationIntakeTool({ converter: CONV, database: DB })
const intakeValue = await intakeTool.execute({ path: fileURLToPath(FIXTURE_PDF), job_id: jobId }, exec)
log(`STEP 3 intake      : status=${intakeValue.status} application_action=${intakeValue.application_action} application=${intakeValue.application_id}`)

// ---- 4 检查落库的 rubric JSON 形状（缺陷的一半：field=null） ----
const rubricRow = (await query(
  'select id, version_no, dimensions from recruitment.rubric_version where id = $1', [rubricVersionId]))[0]
const judgment = rubricRow.dimensions.filter((d) => d.question !== undefined && d.question !== null)
const shape = {
  rubric_version_id: rubricRow.id,
  version_no: rubricRow.version_no,
  criteria: rubricRow.dimensions.map((d) => ({
    key: d.key,
    kind: d.kind,
    has_field_key: Object.prototype.hasOwnProperty.call(d, 'field'),
    field: d.field ?? null,
    question: d.question ?? null,
  })),
  judgment_criteria_with_null_field: judgment.filter((d) => d.field === null).map((d) => d.key),
}
await saveJson('rubric-dimensions.json', shape)
log('STEP 4 rubric 形状 : 判断型准则的 field 落库值')
for (const entry of shape.criteria) {
  log(`  ${entry.key}: field=${JSON.stringify(entry.field)} question=${JSON.stringify(entry.question)}`)
}

// ---- 5 screening_evaluate（期望在这里撞 TypeError） ----
const screeningTool = createScreeningEvaluateTool(DB)
let reproduced = false
let screeningError
let screeningValue
try {
  screeningValue = await screeningTool.execute({ application_id: intakeValue.application_id, as_of: toOffsetIso() }, exec)
  log(`STEP 5 screening   : UNEXPECTED OK verdict=${screeningValue.verdict}`)
} catch (error) {
  screeningError = {
    name: error?.name,
    code: error?.code,
    message: String(error?.message ?? error),
    stack: String(error?.stack ?? ''),
  }
  reproduced = error?.name === 'TypeError' && /reading 'startsWith'/.test(String(error?.message ?? ''))
  log(`STEP 5 screening   : ${error?.name} — ${String(error?.message ?? error)}`)
  log('')
  log('  stack:')
  log(screeningError.stack.split('\n').map((l) => `    ${l}`).join('\n'))
}

// ---- 6 结论 ----
const summary = {
  reproduced,
  reproduced_at: new Date().toISOString(),
  job_id: jobId,
  job_created_this_run: jobCreated,
  rubric_version_id: rubricVersionId,
  application_id: intakeValue.application_id,
  fixture_sha256: fixtureSha,
  rubric_shape: shape,
  screening_error: screeningError ?? null,
  screening_value_if_ok: screeningValue ?? null,
  expected: {
    tool: 'recruitment_screening_evaluate',
    failing_frame: 'src/tools/screening-evaluate.ts resolveFieldFact (field.startsWith)',
    root_cause: 'job_create 把判断型准则归一化成 "field": null；screening_evaluate 只把 undefined 当判断型',
  },
}
await saveJson('summary.json', summary)
await flushLog()
await pool.end()

log('')
if (reproduced) {
  log('结论：缺陷复现（TypeError: Cannot read properties of null (reading \'startsWith\')）。')
  log('  根因：job_create 归一化后判断型准则的 field 是 null；screening_evaluate.evaluateCriterion 只认 field === undefined。')
  log('  影响：凡是用产品入口（job_create）建出来、含判断型准则的 rubric，S7 评估一律崩溃；')
  log('        之前"能跑通"的验收 rubric 是手工 SQL 插的（判断型准则没有 field 键），恰好绕开该分支。')
  log('  修复方向（不在本 lane 范围，只报告）：evaluateCriterion 判 `field == null`；或 job_create 落库时省略 null 键。')
  log(`  证据：${fileURLToPath(new URL('summary.json', RUN_DIR))}`)
  process.exitCode = 0
} else {
  log('结论：未复现（见 summary.json）。')
  process.exitCode = 1
}
