// Golden Path 端到端 harness（S6 → S10）—— **G4：终值 S10 + FIRST_RUN/RERUN 双模式 + 内置 bootstrap**。
//
// 真实工具对象 execute() + 真实 PostgreSQL + 真实 converter + 干净 HEAD 快照。16 个写/读/负例跳
// （hop 1..16；hop 0 预检、hop 17 终态读回不计入 16），最后一条申请必须停在 **S10（v1.0 终态）**。
//
// 与 `run-golden-path.mjs`（旧版，旧报告 run A/B/C 的复现入口，**保持不动**）的关系：
//   * 同一个业务链、同样的真实工具调用方式、同样的闸门（一条都没放宽）；
//   * 期望值升级到 **stage-advance contract v1.3.0 的四条边**：S6→S7→S8→S9→S10。
//     旧版把"梯子终值=S8"当成功（那是 G3 之前的实现事实）；本版 HOP16 必须真实走完
//     S8→S9（canonical READY 转写）→ S9→S10（材料可用 + ≥1 份 SUBMITTED 面评）两条边。
//   * 新增 FIRST_RUN / RERUN 双模式：同一条命令在干净库上跑完 S10 之后，**再跑一次**必须得到
//     逐跳的幂等结果（NO_OP / replayed=true / ALREADY_DECIDED），而不是同一份期望值两次都成立、
//     也不是"任何失败都算过"。判定方式照抄 `manual/screening-decision/run-screening-decision.mjs`：
//     HOP1（S6 intake）返回 `application_action=CREATED` → FIRST_RUN；`REUSED` → RERUN；其余 FAIL。
//     可选守卫 `GOLDEN_PATH_EXPECT_RUN_MODE=FIRST_RUN|RERUN`：实际模式不符 → 直接 FAIL（exit 1）。
//   * 内置 bootstrap 前置：预检之前先 `spawn(process.execPath, [<repo>/scripts/bootstrap-demo.mjs])`
//     （cwd=仓库根），把 stdout/stderr 落 `bootstrap.log`、末行 `BOOTSTRAP_RESULT:` JSON 落
//     `bootstrap.json`；子进程非 0 或解析不到 → 日志说明后 **exit 2（fail closed）**。
//     于是干净库只差"建库 + 按名重放迁移"，不需要手工补审批。
//   * 证据根由 `GOLDEN_PATH_EVIDENCE_DIR` 控制（相对路径按 cwd 解析）；未设置时默认
//     `<pkg>/evidence/experiments/2026-11-15-golden-path-clean/`，其下仍建 `run-<UTC stamp>/`。
//   * 证据必须绑 SHA：`GOLDEN_PATH_HEAD` 优先，否则 `git -C <repo> rev-parse HEAD`；两者都没有
//     → exit 2（不落半份无 SHA 的证据）。summary 记 repository{head, head_source, branch?,
//     dirty_lines?/worktree_state}；git archive 导出的快照没有 .git → worktree_state=snapshot。
//
// 硬边界（与旧版一致）：
//   * 不放宽任何闸门：S8/S10 的 approval 用 allow-once 替身（或 denied 负例），但**闸门本身照常调用**；
//     decision 走 D-95 v2（IN_CHAT + 逐字 confirmation_text + 服务端同一份 hash 实现）。
//   * 不伪造 LIVE：本 harness 的数据全是合成 fixture；工具若返回 LIVE 而事实是 FIXTURE，按 R4 记账为工具缺陷。
//   * 不直接写库：写只经 `tool.execute()`；`pg` 只用于 SELECT 读回与行数统计。
//   * 不手工 UPDATE 任何业务行、不手工钉 rubric、不跳过任何校验。
//
// 用法（PowerShell；在**干净快照**里跑，见 evidence README）：
//   $env:RECRUITMENT_DB_PASSWORD='<本机演示库密码，按约定注入，不落盘>'
//   $env:GOLDEN_PATH_HEAD='<快照对应的 commit>'
//   $env:RECRUITMENT_TEST_DB='<一次性库名>'            # harness 主配置（不是 RECRUITMENT_DB_NAME）
//   $env:GOLDEN_PATH_EXPECT_RUN_MODE='FIRST_RUN'       # 可选守卫；第二次跑写 RERUN
//   node manual/golden-path/run-golden-path-rerun.mjs
//
// 出口码：0 = 16 跳全 PASS 且 acceptance.ok；1 = 有 hop FAIL / acceptance 不成立；
//         2 = 配置缺失 / 证据绑不到 SHA / bootstrap 前置不满足（fail closed）。
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, copyFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
import { createStageAdvanceTool } from '../../src/tools/stage-advance.ts'
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
/** 固定面试时间：必须避开共享演示库 `ra_s6s7` 里既有的面试占用。
 *  实测 2026-12-02 10:00+08 已被**旧报告 run A** 的面试（面试官 103/104）占用 → CONFLICT_SLOT。
 *  2026-12-09 10:00+08 在本次复跑时对 103/104 均空闲；过期后需改到未来。 */
const SCHEDULED_START_AT = '2026-12-09T10:00:00+08:00'
// 幂等键在 S6 之后按 application_id 生成（见下方 scheduleKey / scorecardKey）：
// 同一条申请重跑 → 同一个键 → replay；不同申请互不串键（否则会 IDEMPOTENCY_KEY_REUSED）。
/** 合成候选人的强标识（与 fixtures/build_synthetic_resume.py 生成 PDF 里的值一致）。
 *  rerun 用**新的合成身份** gp8：旧 fixture（gp6/gp7）的申请已存在，复用走 REUSED 不会验证 F1 的新建钉住。
 *  换身份必须同时换 fixture：`GOLDEN_PATH_FIXTURE` / GOLDEN_PATH_EMAIL / GOLDEN_PATH_PHONE_NORM 三处同步。 */
const SYNTHETIC_EMAIL = process.env.GOLDEN_PATH_EMAIL ?? 'lin.chengyu.gp8@example.test'
const SYNTHETIC_PHONE_NORM = process.env.GOLDEN_PATH_PHONE_NORM ?? '+8613600000888'

const HERE = new URL('./', import.meta.url)
const PKG_ROOT = new URL('../../', HERE)
const REPO_ROOT = new URL('../../../../', HERE)
const REPO_ROOT_PATH = fileURLToPath(REPO_ROOT)
/** 本 harness 自己（summary 里记 path + sha256；证据要能复核到跑的是哪份代码）。 */
const HARNESS_PATH = fileURLToPath(new URL('./run-golden-path-rerun.mjs', HERE))
/** 内置 bootstrap 的入口（产品工具链；本 harness 只 spawn，不改它的语义）。 */
const BOOTSTRAP_PATH = join(REPO_ROOT_PATH, 'scripts', 'bootstrap-demo.mjs')
/** rerun 专用 fixture（同一个人设、**新**电话/邮箱；sha256 记入 fixture.json）。
 *  可用 GOLDEN_PATH_FIXTURE 指向别的合成 PDF（再跑一次时必须换一个未入库的身份）。 */
const FIXTURE_PDF = process.env.GOLDEN_PATH_FIXTURE === undefined
  ? new URL('./fixtures/gp-rerun-2/synthetic-resume-golden-path.pdf', HERE)
  : new URL(`file://${process.env.GOLDEN_PATH_FIXTURE.replaceAll('\\', '/')}`)
const CONVERTER_DIR = new URL('converter/', REPO_ROOT)
const PYTHON_BIN = process.env.RECRUITMENT_PYTHON_BIN ?? 'D:\\Python3.12.9\\python.exe'
/** 证据根：`GOLDEN_PATH_EVIDENCE_DIR` 优先（相对路径按 **cwd** 解析）；缺省 = 本 lane 的新证据目录。
 *  注意：缺省值不再是 2026-11-14 的旧目录 —— 旧证据是旧版 harness 的产物，不能被这次重跑污染。 */
const DEFAULT_EVIDENCE_ROOT = fileURLToPath(
  new URL('./evidence/experiments/2026-11-15-golden-path-clean/', PKG_ROOT),
)
const EVIDENCE_DIR_ENV = (process.env.GOLDEN_PATH_EVIDENCE_DIR ?? '').trim()
const EVIDENCE_ROOT = EVIDENCE_DIR_ENV === ''
  ? DEFAULT_EVIDENCE_ROOT
  : resolve(process.cwd(), EVIDENCE_DIR_ENV)
/** 可选守卫：本次"应该"是 FIRST_RUN 还是 RERUN；HOP1 判定出真实模式后立即比对，不符 → FAIL。 */
const EXPECT_RUN_MODE = (process.env.GOLDEN_PATH_EXPECT_RUN_MODE ?? '').trim() === ''
  ? null
  : (process.env.GOLDEN_PATH_EXPECT_RUN_MODE ?? '').trim()
if (EXPECT_RUN_MODE !== null && EXPECT_RUN_MODE !== 'FIRST_RUN' && EXPECT_RUN_MODE !== 'RERUN') {
  console.error(`[golden-path] GOLDEN_PATH_EXPECT_RUN_MODE 只能是 FIRST_RUN / RERUN（收到 ${JSON.stringify(EXPECT_RUN_MODE)}）`)
  process.exit(2)
}

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const RUN_DIR = join(EVIDENCE_ROOT, `run-${stamp}`)
const LOG_PATH = join(RUN_DIR, 'run.log')

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
  await writeFile(join(RUN_DIR, name), JSON.stringify(value, null, 2), 'utf8')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 只读取 git 事实（**绝不写 git**）：用于把证据绑到 SHA 与工作树状态。
 * 快照目录（git archive 导出、没有 .git）会返回 null，调用方按"snapshot"记账。
 * @param args - `git -C <repo>` 之后的参数。
 * @returns 成功时 trim 后的 stdout；失败/不可用返回 null。
 */
function gitReadOnly(args) {
  try {
    const result = spawnSync('git', ['-C', REPO_ROOT_PATH, ...args], { encoding: 'utf8' })
    return result.status === 0 ? String(result.stdout ?? '').trim() : null
  } catch {
    return null
  }
}

/**
 * 证据必须绑 SHA：`GOLDEN_PATH_HEAD` 优先，否则 `git -C <repo> rev-parse HEAD`。
 * 同时记录工作树状态（git 仓库里 = clean/dirty + dirty_lines；无 .git 的快照 = snapshot）。
 * @returns `{ head, head_source, branch, dirty_lines, worktree_state, note? }`；head 可能为 null。
 */
function resolveRepository() {
  const envHead = (process.env.GOLDEN_PATH_HEAD ?? '').trim()
  const gitHead = gitReadOnly(['rev-parse', 'HEAD'])
  const head = envHead !== '' ? envHead : gitHead
  const headSource = envHead !== ''
    ? 'env:GOLDEN_PATH_HEAD'
    : (gitHead === null ? 'missing' : 'git rev-parse HEAD')
  const branch = gitReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'])
  const statusText = gitReadOnly(['status', '--porcelain'])
  const isGitRepo = branch !== null || statusText !== null || gitReadOnly(['rev-parse', '--git-dir']) !== null
  const dirtyLines = statusText === null
    ? null
    : statusText.split('\n').map((line) => line.trim()).filter((line) => line !== '').length
  const worktreeState = isGitRepo ? (dirtyLines === 0 ? 'clean' : 'dirty') : 'snapshot'
  return {
    head: head === '' ? null : head,
    head_source: headSource,
    branch,
    dirty_lines: dirtyLines,
    worktree_state: worktreeState,
    ...(isGitRepo
      ? {}
      : { note: '快照目录由 git archive 导出、没有 .git：HEAD 由 GOLDEN_PATH_HEAD 显式绑定，worktree_state=snapshot' }),
  }
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
// 复核 P1：harness 的主配置是 `RECRUITMENT_TEST_DB`（bootstrap 认 `RECRUITMENT_DB_NAME`）。
// 两个 env 不一致时**直接失败**，禁止静默落到 demo 库（否则 RUN_MODE 会变成 RERUN、16 跳"通过"但零写入）。
const harnessDb = (process.env.RECRUITMENT_TEST_DB ?? '').trim()
const dbNameEnv = (process.env.RECRUITMENT_DB_NAME ?? '').trim()
if (harnessDb === '') {
  console.error('[golden-path] 缺少 RECRUITMENT_TEST_DB（harness 主配置；不是 RECRUITMENT_DB_NAME）。')
  process.exit(2)
}
if (dbNameEnv !== '' && dbNameEnv !== harnessDb) {
  console.error(`[golden-path] RECRUITMENT_DB_NAME(${dbNameEnv}) 与 RECRUITMENT_TEST_DB(${harnessDb}) 不一致；拒绝运行（避免静默落到 demo 库）。`)
  process.exit(2)
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
/** 本次运行的语义模式：HOP1 的 intake 结果决定（CREATED→FIRST_RUN / REUSED→RERUN）。
 *  HOP1 记录在判定前写文件，判定后回填 `run_mode` 并重写 hop-01 证据。 */
let RUN_MODE = 'UNKNOWN'
/** 声明式 skip 计数（HOP 未执行 = skipped；正常路径必须为 0，否则四数不齐）。 */
let skippedHops = 0

/**
 * 每跳的角色：write = 正常写库；read = 只读；
 * negative-control = 故意让闸门拒绝（期望一行不写）；
 * expected-blocker = 已知产品缺陷，期望被工具自己拒绝（不得为了"跑通"绕过）。
 */
const HOP_KIND = {
  's6-intake': 'write',
  's6s7-stage-advance': 'write',
  's7-screening-evaluate': 'read',
  's7-decision-screening': 'write',
  's7s8-stage-advance': 'write',
  's8-schedule-denied': 'negative-control',
  's8-schedule-allow-once': 'write',
  's8-interview-get': 'read',
  's9-transcript-import': 'write',
  's9-transcript-read': 'read',
  's10-scorecard-denied': 'negative-control',
  's10-scorecard-allow-once': 'write',
  's10-scorecard-2': 'write',
  's10-evaluation-summarize': 'read',
  's10-decision-stage': 'write',
  's10-stage-advance-after-decision': 'write',
}

/**
 * 跑一跳：调用真实工具 + 读回数据库。
 * @param {object} input - { id, hop, label, tool, args, readback?, expect?, expect_note? }
 */
async function runHop(input) {
  const before = await rowCounts()
  const record = {
    id: input.id,
    kind: HOP_KIND[input.id] ?? 'unknown',
    hop: input.hop,
    run_mode: RUN_MODE,
    label: input.label,
    tool: input.tool.name,
    ...(input.expect_note === undefined ? {} : { expect_note: input.expect_note }),
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
           lifecycle_status, current_stage_code, record_version, created_at,
           stage_entered_at, stage_changed_at, stage_changed_by_actor_id
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
//  内置 bootstrap（G5：scripts/bootstrap-demo.mjs）
// ---------------------------------------------------------------------------
/**
 * 跑一次 demo bootstrap：**只 spawn 产品脚本，不在这里复制它的逻辑**。
 *
 * 子进程环境显式映射（父进程的 `RECRUITMENT_TEST_DB` 是 harness 自己的主配置，
 * 不能混给 bootstrap —— 它认的是 `RECRUITMENT_DB_NAME`）：
 *   `RECRUITMENT_DB_HOST/PORT/USER/NAME`（NAME = 已解析的 `config.database`）、
 *   `RECRUITMENT_DB_PASSWORD`（透传，绝不打印）、`RECRUITMENT_TENANT_ID/ACTOR_ID`、
 *   `DEMO_APPROVAL_MODE`（默认 allow-once）。
 *
 * 产物：`bootstrap.log`（stdout/stderr 原文）+ `bootstrap.json`（末行 BOOTSTRAP_RESULT 的 JSON）。
 * fail closed：子进程非 0 / 解析不到末行 → 调用方 exit 2（不拿"没审批的干净库"继续跑）。
 * @returns `{ ok, record }`；`record` 就是写进 summary 的那份 bootstrap 账。
 */
async function runBootstrapStep() {
  const demoApprovalMode = (process.env.DEMO_APPROVAL_MODE ?? '').trim() === ''
    ? 'allow-once'
    : (process.env.DEMO_APPROVAL_MODE ?? '').trim()
  const env = {
    ...process.env,
    RECRUITMENT_DB_HOST: DB.host,
    RECRUITMENT_DB_PORT: String(DB.port),
    RECRUITMENT_DB_USER: DB.user,
    RECRUITMENT_DB_NAME: DB.database,
    RECRUITMENT_DB_PASSWORD: process.env.RECRUITMENT_DB_PASSWORD,
    RECRUITMENT_TENANT_ID: TENANT_ID,
    RECRUITMENT_ACTOR_ID: ACTOR_ID,
    DEMO_APPROVAL_MODE: demoApprovalMode,
  }
  const child = spawn(process.execPath, [BOOTSTRAP_PATH], {
    cwd: REPO_ROOT_PATH,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const settled = await new Promise((resolvePromise) => {
    child.on('error', (error) => resolvePromise(error))
    child.on('close', (code) => resolvePromise(code ?? -1))
  })
  const exitCode = typeof settled === 'number' ? settled : null

  const bootstrapLog = [
    '# scripts/bootstrap-demo.mjs（本 harness 的内置前置；不是 harness 自己补数据）',
    `# cwd=${REPO_ROOT_PATH}`,
    `# node=${process.execPath}`,
    `# DEMO_APPROVAL_MODE=${demoApprovalMode}`,
    `# exit_code=${exitCode === null ? `spawn error: ${String(settled)}` : exitCode}`,
    '--- stdout ---',
    stdout.trimEnd(),
    '--- stderr ---',
    stderr.trimEnd(),
    '',
  ].join('\n')
  await writeFile(join(RUN_DIR, 'bootstrap.log'), bootstrapLog, 'utf8')

  // 脚本约定：最后**一行**机器可读 `BOOTSTRAP_RESULT: <单行 JSON>`（NO_OP / deny / 失败同样输出）。
  let parsed = null
  let parseError = null
  const resultLines = stdout.split(/\r?\n/).filter((line) => line.startsWith('BOOTSTRAP_RESULT: '))
  const resultLine = resultLines[resultLines.length - 1]
  if (resultLine === undefined) {
    parseError = 'stdout 里没有以 "BOOTSTRAP_RESULT: " 开头的行'
  } else {
    try {
      parsed = JSON.parse(resultLine.slice('BOOTSTRAP_RESULT: '.length))
    } catch (error) {
      parseError = `BOOTSTRAP_RESULT JSON 解析失败：${String(error)}`
    }
  }

  const record = {
    path: BOOTSTRAP_PATH,
    sha256: sha256(await readFile(BOOTSTRAP_PATH)),
    exit_code: exitCode,
    command: `${process.execPath} ${BOOTSTRAP_PATH}`,
    cwd: REPO_ROOT_PATH,
    env_mapping: {
      RECRUITMENT_DB_HOST: DB.host,
      RECRUITMENT_DB_PORT: String(DB.port),
      RECRUITMENT_DB_USER: DB.user,
      RECRUITMENT_DB_NAME: DB.database,
      RECRUITMENT_DB_PASSWORD: '(透传，不落盘)',
      RECRUITMENT_TENANT_ID: TENANT_ID,
      RECRUITMENT_ACTOR_ID: ACTOR_ID,
      DEMO_APPROVAL_MODE: demoApprovalMode,
    },
    stdout_bytes: Buffer.byteLength(stdout, 'utf8'),
    stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
    outcome: parsed?.outcome ?? null,
    state: parsed?.state ?? null,
    writes: parsed?.writes ?? null,
    demo_approval_mode: demoApprovalMode,
    result: parsed,
    ...(parseError === null ? {} : { parse_error: parseError }),
  }
  await saveJson('bootstrap.json', record)
  return { ok: exitCode === 0 && parsed !== null, record }
}

// ---------------------------------------------------------------------------
//  主流程
// ---------------------------------------------------------------------------
// 证据必须绑 SHA（先绑、后落证据；两者都没有就 exit 2，不产出半份无 SHA 的"证据"）。
const repository = resolveRepository()
if (repository.head === null) {
  console.error('[golden-path] 证据必须绑 SHA：GOLDEN_PATH_HEAD 未设置，且 git -C <repo> rev-parse HEAD 也失败'
    + '（git archive 导出的快照没有 .git，必须显式传 GOLDEN_PATH_HEAD）。')
  process.exit(2)
}
await mkdir(EVIDENCE_ROOT, { recursive: true })
await mkdir(RUN_DIR, { recursive: true })

log('Golden Path end-to-end harness（S6 → S10 · 终值 S10 · FIRST_RUN/RERUN 双模式）')
log(`运行时间        : ${new Date().toISOString()}`)
log(`仓库 HEAD       : ${repository.head}（来源 ${repository.head_source}）`)
log(`工作树          : ${repository.worktree_state}${repository.dirty_lines === null ? '' : `（dirty_lines=${repository.dirty_lines}）`} branch=${repository.branch ?? '(n/a)'}`)
log(`数据库          : ${DB.user}@${DB.host}:${DB.port}/${DB.database}（只读读回；写只经工具）`)
log(`租户 / actor    : ${TENANT_ID} / ${ACTOR_ID}（HUMAN）`)
log(`岗位            : ${JOB_ID}（DEMO-BE-001，合成演示租户）`)
log(`合成简历        : ${fileURLToPath(FIXTURE_PDF)}`)
log(`合成身份        : ${SYNTHETIC_EMAIL} / ${SYNTHETIC_PHONE_NORM}（合成值，不对应任何真实候选人）`)
log(`证据根          : ${EVIDENCE_ROOT}${EVIDENCE_DIR_ENV === '' ? '（默认）' : `（GOLDEN_PATH_EVIDENCE_DIR=${EVIDENCE_DIR_ENV}）`}`)
log(`证据目录        : ${RUN_DIR}`)
log(`RUN_MODE 守卫   : ${EXPECT_RUN_MODE ?? '未设置（由 HOP1 的 application_action 判定）'}`)
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
await copyFile(FIXTURE_PDF, join(RUN_DIR, 'fixture-synthetic-resume-golden-path.pdf'))

// ---- 内置 bootstrap（必须在预检之前：干净库没有 APPROVED 审批时 S7 会 NO_APPROVED_RUBRIC）----
log('')
log('════════ BOOTSTRAP · scripts/bootstrap-demo.mjs（G5：干净库的 demo 前置，内置） ════════')
const bootstrap = await runBootstrapStep()
log(`bootstrap       : outcome=${bootstrap.record.outcome} exit_code=${bootstrap.record.exit_code} state=${bootstrap.record.state}`)
log(`bootstrap sha256: ${bootstrap.record.sha256}`)
log(`bootstrap writes: ${JSON.stringify(bootstrap.record.writes)}`)
if (bootstrap.record.parse_error !== undefined) log(`bootstrap parse : ${bootstrap.record.parse_error}`)
await flushLog()
if (!bootstrap.ok) {
  log('')
  log('BLOCKED（fail closed）：内置 bootstrap 非 0 或没有可解析的 BOOTSTRAP_RESULT —— demo 前置不成立，不继续预检。')
  await flushLog()
  await pool.end()
  process.exit(2)
}

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

// ---- 1 S6 intake —— **本跳决定 RUN_MODE**（照抄 screening-decision harness 的判定方式）----
// FIRST_RUN = 干净库上的第一次：intake 必须新建申请（application_action=CREATED，application 行 +1）；
// RERUN     = 同一库第二次：同 candidate+job 复用同一条 ACTIVE 申请（application_action=REUSED，
//             application 行 +0；material 内容 sha 未变 → 版本 UNCHANGED，一行都不写）。
// 其余取值（缺 status / 缺 application_id / 其它 action）→ FAIL，后续不猜模式、不继续。
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
  expect_note: 'CREATED→FIRST_RUN（application 行 +1）/ REUSED→RERUN（application 行 +0）；两种模式都必须有 application_id 与 resume_version_id',
  expect: (record) => {
    if (record.ok !== true || record.result?.status !== 'OK') return false
    if (typeof record.result?.application_id !== 'string') return false
    if (typeof record.result?.resume_version_id !== 'string') return false
    const action = record.result?.application_action
    // CREATED/REUSED 是封闭集；同时用行数增量验证"这句 action 是真的"（不是只看工具自称）。
    if (action === 'CREATED') return (record.row_count_delta.application ?? 0) === 1
    if (action === 'REUSED') return (record.row_count_delta.application ?? 0) === 0
    return false
  },
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
// RUN_MODE 由库内事实决定（不是由入口脚本猜）：CREATED→FIRST_RUN / REUSED→RERUN / 其它→FAIL。
const intakeAction = intake.result?.application_action
if (intakeAction === 'CREATED') RUN_MODE = 'FIRST_RUN'
else if (intakeAction === 'REUSED') RUN_MODE = 'RERUN'
else {
  log('')
  log(`BLOCKED：HOP1 的 application_action=${JSON.stringify(intakeAction)} 不在 {CREATED, REUSED} 里，无法判定 FIRST_RUN/RERUN。`)
  await flushLog()
  await pool.end()
  process.exit(1)
}
// HOP1 记录在模式判定前落盘过（run_mode=UNKNOWN），这里回填真实模式并重写证据。
intake.run_mode = RUN_MODE
await saveJson(`hop-${String(intake.hop).padStart(2, '0')}-${intake.id}.json`, intake)
log(`RUN_MODE=${RUN_MODE}（依据：HOP1 application_action=${intakeAction}，rank.delta.application=${intake.row_count_delta.application ?? 0}）`)
// 可选守卫：命令行声明的模式必须与库内事实一致，不一致就是环境/证据用错了 → 直接 FAIL。
if (EXPECT_RUN_MODE !== null && EXPECT_RUN_MODE !== RUN_MODE) {
  await saveJson('run-mode-guard.json', {
    expected: EXPECT_RUN_MODE,
    actual: RUN_MODE,
    intake_application_action: intakeAction,
    application_id: applicationId,
    ok: false,
  })
  log('')
  log(`FAIL（RUN_MODE 守卫）：GOLDEN_PATH_EXPECT_RUN_MODE=${EXPECT_RUN_MODE}，但库内事实判定为 ${RUN_MODE}。`
    + '—— 这次没跑成"声明的那一次"，证据不能混用。')
  await flushLog()
  await pool.end()
  process.exit(1)
}
if (EXPECT_RUN_MODE !== null) {
  await saveJson('run-mode-guard.json', {
    expected: EXPECT_RUN_MODE,
    actual: RUN_MODE,
    intake_application_action: intakeAction,
    application_id: applicationId,
    ok: true,
  })
}
const appAfterIntake = await readApplication(applicationId)
log(`application=${applicationId} stage=${appAfterIntake.current_stage_code} lifecycle=${appAfterIntake.lifecycle_status} rubric_version_id=${appAfterIntake.rubric_version_id}`)
log(`candidate=${candidateId} resume_version=${resumeVersionIdFromHop} rubric_pinned=${appAfterIntake.rubric_version_id !== null}`)

// ---- 2 S7 前置：阶段推进 T1（S6→S7）----
// FIRST_RUN：材料已绑定 + 解析不是 FAILED + rubric 已钉（F1 后 intake 新建即钉）→ 必须真前移一格；
// RERUN    ：指针已在 S10（终态），T1 的事实早已满足 → 幂等结果必须是 NO_OP@S10、零迁移、零 UPDATE。
// 本工具是 `application.current_stage_code` 的**唯一写入口**（docs/18 §3）。
const stageAdvanceTool = createStageAdvanceTool(DB)
const advanceS6S7 = await runHop({
  id: 's6s7-stage-advance',
  hop: 2,
  label: RUN_MODE === 'FIRST_RUN'
    ? '阶段推进 T1（S6→S7）：材料 + rubric pin 已成立（F1 后无需补钉）'
    : '阶段推进 T1 幂等调用（RERUN）：申请已在 S10，必须 NO_OP 且零迁移',
  tool: stageAdvanceTool,
  args: { application_id: applicationId },
  readback: async () => ({ application: await readApplication(applicationId) }),
  expect_note: RUN_MODE === 'FIRST_RUN'
    ? 'ADVANCED + transitions 逐字 [{S6→S7}] + stage_code=S7'
    : 'NO_OP + stage_code=S10 + transitions=[]（零 UPDATE；旧断言"梯子只到 S8"已作废）',
  expect: (record) => {
    if (record.ok !== true) return false
    if (RUN_MODE === 'FIRST_RUN') {
      return record.result?.status === 'ADVANCED'
        && JSON.stringify(record.result?.transitions ?? []) === JSON.stringify([{ from: 'S6', to: 'S7' }])
        && record.result?.stage_code === 'S7'
    }
    return record.result?.status === 'NO_OP'
      && record.result?.stage_code === 'S10'
      && (record.result?.transitions ?? []).length === 0
  },
})
log(`stage after T1 = ${advanceS6S7.result?.stage_code} transitions=${JSON.stringify(advanceS6S7.result?.transitions)}`)
// 幂等键按 application_id 派生：同一条申请重跑 → 同一个键（replay）；
// 不同申请 → 不同键（避免 IDEMPOTENCY_KEY_REUSED）。负例用独立键，避免与正例互撞。
const scheduleKey = `gp-e2e:${applicationId}:schedule-r1`
const scheduleKeyDenied = `gp-e2e:${applicationId}:schedule-r2-denied`
const scorecardKey = `gp-e2e:${applicationId}:scorecard-103`
const scorecardKeyDenied = `gp-e2e:${applicationId}:scorecard-103-denied`

// ---- 3 S7 screening_evaluate ----
// ⚠️ as_of 必须是"现在"：内置 bootstrap **刚刚**批准 rubric，若像旧版那样回溯 5 秒，
// `approved(v, as_of)` 会判成"该时刻还没批准" → NO_RUBRIC/NO_APPROVED_RUBRIC。
// 这是 as_of 语义的**正确行为**，不是产品缺陷（`manual/screening-decision` 同一 harness 踩过并改成 now）。
const screeningAsOf = toOffsetIso()
const screeningTool = createScreeningEvaluateTool(DB)
const screening = await runHop({
  id: 's7-screening-evaluate',
  hop: 3,
  label: 'S7 screening_evaluate（只读、advisory、带证据）',
  tool: screeningTool,
  args: { application_id: applicationId, as_of: screeningAsOf },
  readback: async () => ({
    application: await readApplication(applicationId),
    decisions: await readDecisions(applicationId),
  }),
  expect_note: '两模式都 ok=true + verdict 字符串（只读；RERUN 读同一份已钉 rubric/材料；RO/RERUN 都必须真过 approved(v, as_of)）',
  expect: (record) => record.ok === true && record.result?.status === 'OK' && typeof record.result?.verdict === 'string',
})
const screeningValue = screening.result
log(`verdict=${screeningValue?.verdict} evaluation_digest=${screeningValue?.evaluation_digest}`)
log(`rubric resolution=${screeningValue?.rubric?.resolution} pin_required=${screeningValue?.rubric?.rubric_pin_required} what_if=${screeningValue?.rubric?.what_if}`)
log(`warnings=${JSON.stringify((screeningValue?.warnings ?? []).map((w) => w.code))}`)
log(`criteria_evaluated=${screeningValue?.criteria_evaluated} reasons=${JSON.stringify((screeningValue?.reasons ?? []).map((r) => `${r.criterion_key ?? ''}:${r.code}:${r.outcome ?? ''}`))}`)

// ---- 4 S7 decision_record(SCREENING) —— F1 已修（1b23fff / D-108），期望真实落库 ----
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
  // 与 screening_evaluate 同一个 as_of（都取"这次运行里 rubric 已批准之后"的时刻）。
  as_of: screeningAsOf,
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
  hop: 4,
  label: RUN_MODE === 'FIRST_RUN'
    ? 'S7 decision_record(SCREENING)（D-103 写侧 + D-95 IN_CHAT v2；F1 后必须真落库）'
    : 'S7 decision_record(SCREENING) 重复提交（RERUN）：当前 SCREENING 决策已存在，必须 ALREADY_DECIDED 且零写入',
  tool: decisionTool,
  args: screeningDecisionArgs,
  readback: async () => ({
    application: await readApplication(applicationId),
    decisions: await readDecisions(applicationId),
    approval_service_calls: screeningApproval.calls.length,
  }),
  expect_note: RUN_MODE === 'FIRST_RUN'
    ? 'ok=true + decision 行 +1（真写；STEP 3 走"没有 current SCREENING 决策"的写分支）'
    : 'ok=false + ALREADY_DECIDED/SCOPE_ALREADY_DECIDED + decision 行 +0（STEP 3 在汇总重算之前就拒绝）',
  expect: (record) => {
    if (RUN_MODE === 'FIRST_RUN') {
      return record.ok === true && (record.row_count_delta.decision ?? 0) === 1
    }
    return record.ok === false
      && record.error?.code === 'ALREADY_DECIDED'
      && (record.row_count_delta.decision ?? 0) === 0
  },
})
log(`SCREENING 决策结果：${screeningDecision.ok ? 'WROTE' : `FAILED(${screeningDecision.error?.code}/${screeningDecision.error_body?.reason_code ?? '?'})`}`)
log(`approval.request 调用次数：${screeningApproval.calls.length}（IN_CHAT 按 D-95 不再二次弹确认）`)

// ---- 5 S8 前置：阶段推进 T2（S7→S8）----
// FIRST_RUN：current SCREENING=ADVANCE（上一步刚写）→ 必须真前移一格到 S8；
// RERUN    ：指针已在 S10 → 幂等结果必须是 NO_OP@S10、零迁移。
const advanceS7S8 = await runHop({
  id: 's7s8-stage-advance',
  hop: 5,
  label: RUN_MODE === 'FIRST_RUN'
    ? '阶段推进 T2（S7→S8）：current SCREENING 决策 = ADVANCE'
    : '阶段推进 T2 幂等调用（RERUN）：申请已在 S10，必须 NO_OP 且零迁移',
  tool: stageAdvanceTool,
  args: { application_id: applicationId },
  readback: async () => ({ application: await readApplication(applicationId), decisions: await readDecisions(applicationId) }),
  expect_note: RUN_MODE === 'FIRST_RUN'
    ? 'ADVANCED + transitions 逐字 [{S7→S8}] + stage_code=S8'
    : 'NO_OP + stage_code=S10 + transitions=[]（零 UPDATE）',
  expect: (record) => {
    if (record.ok !== true) return false
    if (RUN_MODE === 'FIRST_RUN') {
      return record.result?.status === 'ADVANCED'
        && JSON.stringify(record.result?.transitions ?? []) === JSON.stringify([{ from: 'S7', to: 'S8' }])
        && record.result?.stage_code === 'S8'
    }
    return record.result?.status === 'NO_OP'
      && record.result?.stage_code === 'S10'
      && (record.result?.transitions ?? []).length === 0
  },
})
log(`stage after T2 = ${advanceS7S8.result?.stage_code} transitions=${JSON.stringify(advanceS7S8.result?.transitions)}`)

// ---- 6 S8 interview_schedule：先 denied 负例（一行不写），再 allow-once 正例 ----
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
  hop: 6,
  label: 'S8 interview_schedule 负例：approval=deny（D-79 fail closed，必须一行不写）',
  tool: scheduleDeniedTool,
  args: scheduleDeniedArgs,
  readback: async () => ({
    approval_requests: scheduleDeniedApproval.calls.length,
    interviews_for_application: await query(
      'select round_no, slot_code, status from recruitment.interview where tenant_id = $1 and application_id = $2 order by round_no',
      [TENANT_ID, applicationId]),
  }),
  expect_note: '两模式都必须 FORBIDDEN/APPROVAL_NOT_GRANTED 且 interview 行 +0（负例用 round 2，从未有人真的排上它；'
    + 'RERUN 下 round 1 的面试已存在不影响这条负例：闸门在业务冲突判定之前就拒绝）',
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
  hop: 7,
  label: RUN_MODE === 'FIRST_RUN'
    ? 'S8 interview_schedule（人机闸门 allow-once + 真实写库）'
    : 'S8 interview_schedule 幂等重放（RERUN）：同 idempotency_key + 同参数 → replayed=true、零写入',
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
  expect_note: RUN_MODE === 'FIRST_RUN'
    ? 'ok=true + replayed=false + 返回 interview id + interview 行 +1（真过闸门真写）'
    : 'ok=true + replayed=true + 能从结果/库里读到既有 interview + interview 行 +0（STORE 命中，零写入）',
  expect: (record) => {
    if (record.ok !== true) return false
    const resultId = scheduleResultId(record)
    const readbackId = record.readback?.interview?.interview?.id
    const knownId = typeof resultId === 'string' ? resultId : (typeof readbackId === 'string' ? readbackId : undefined)
    if (knownId === undefined) return false
    if (RUN_MODE === 'FIRST_RUN') {
      return record.result?.replayed === false && (record.row_count_delta.interview ?? 0) === 1
    }
    return record.result?.replayed === true && (record.row_count_delta.interview ?? 0) === 0
  },
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
    hop: 8,
    label: 'S8 interview_get（面试 + 会议绑定 + 转写 + 面评状态）',
    tool: interviewGetTool,
    args: { interview_id: interviewId },
    readback: async () => readInterview(interviewId),
    expect_note: '两模式都 ok=true（只读；RERUN 读的是同一场既有面试）',
    expect: (record) => record.ok === true,
  })
} else {
  skippedHops += 1
  log('HOP 8 SKIPPED：没有 interview_id。')
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
    hop: 9,
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
    expect_note: 'FIRST_RUN: ok=true + replayed=false + transcript_artifact 行 +1（真写 canonical 材料）；'
      + 'RERUN: ok=true + replayed=true + transcript_artifact 行 +0（同 (meeting, provider_artifact_id) 同内容 sha，TR-U8 一行不写）',
    expect: (record) => {
      if (record.ok !== true) return false
      if (RUN_MODE === 'FIRST_RUN') {
        return record.result?.replayed === false && (record.row_count_delta.transcript_artifact ?? 0) === 1
      }
      return record.result?.replayed === true && (record.row_count_delta.transcript_artifact ?? 0) === 0
    },
  })
} else {
  skippedHops += 1
  log('HOP 9 SKIPPED：没有 interview_id。')
}

// ---- 10 S9 transcript_read ----
const transcriptReadTool = createTranscriptReadTool(DB)
let transcriptReadHop = null
if (interviewId !== undefined) {
  transcriptReadHop = await runHop({
    id: 's9-transcript-read',
    hop: 10,
    label: 'S9 transcript_read（canonical 状态 + 正文切片）',
    tool: transcriptReadTool,
    args: { interview_id: interviewId, include_text: false, as_of: nowMinus(5) },
    readback: async () => readInterview(interviewId),
    expect_note: '两模式都 ok=true 且 transcript.state=READY（T3/T4"材料可用"的判据；只读）',
    expect: (record) => record.ok === true && record.result?.transcript?.state === 'READY',
  })
} else {
  skippedHops += 1
  log('HOP 10 SKIPPED：没有 interview_id。')
}

// ---- 11 S10 scorecard_submit：先 denied 负例（一行不写），再 allow-once 正例 ----
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
  // F1 之后申请已被 intake 钉住 rubric：面评的版本必须**等于申请钉住的版本**（SC-11，不允许 what-if）。
  rubric_version_id: appAfterIntake.rubric_version_id ?? approvedRubric.id,
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
    hop: 11,
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
    expect_note: hadScorecardBefore
      ? 'RERUN 口径：面评已存在 → 拒绝路径不再是"D-79 闸门"（业务校验先行拒绝也只能证明停写）；'
        + '仍必须 ok=false 且 scorecard 行 +0，实际拒绝路径在 summary.negative_controls[].reject_path 里如实记录'
      : 'FIRST_RUN 口径：approval=deny → 必须 FORBIDDEN/APPROVAL_NOT_GRANTED 且 scorecard 行 +0（D-79 fail closed）',
    expect: (record) => {
      if ((record.row_count_delta.scorecard ?? 0) !== 0) return false
      if (record.ok) return false
      // RERUN：面评已存在时"先撞业务校验"是产品真实行为；沿用既有口径"任何拒绝路径都不得写行"，
      // 但拒绝路径必须能在证据里被指名（下面把 code/reason 写进 hop 记录与 summary），不宽松成"随便失败都行"。
      if (hadScorecardBefore) return typeof record.error?.code === 'string'
      return record.error?.code === 'FORBIDDEN'
        && record.error_body?.reason_code === 'APPROVAL_NOT_GRANTED'
    },
  })
  // 如实记录这条负例实际走的是哪条拒绝路径（FIRST_RUN 是闸门；RERUN 面评已存在时可能是业务校验）。
  scorecardDenied.reject_path = scorecardDenied.ok
    ? 'UNEXPECTED_WRITE'
    : `${scorecardDenied.error?.code ?? '?'}/${scorecardDenied.error_body?.reason_code ?? '?'}`
  scorecardDenied.had_scorecard_before = hadScorecardBefore
  await saveJson(`hop-${String(scorecardDenied.hop).padStart(2, '0')}-${scorecardDenied.id}.json`, scorecardDenied)
  log(`scorecard denied：${scorecardDenied.ok ? 'UNEXPECTED WRITE' : `${scorecardDenied.error?.code}/${scorecardDenied.error_body?.reason_code}`
    + `（approval requests=${scorecardDeniedApproval.calls.length}，had_scorecard_before=${hadScorecardBefore}，拒绝路径=${scorecardDenied.reject_path}）`}`)

  const scorecardApproval = makeApproval('allow-once')
  const scorecardTool = createScorecardSubmitTool({ database: DB, approval: scorecardApproval })
  await runHop({
    id: 's10-scorecard-allow-once',
    hop: 12,
    label: RUN_MODE === 'FIRST_RUN'
      ? 'S10 scorecard_submit（面试官 103 本人 + 人机闸门 allow-once）'
      : 'S10 scorecard_submit 幂等重放（RERUN）：同 key 同 payload → replayed=true、零写入',
    tool: scorecardTool,
    args: { ...scorecardArgs, idempotency_key: scorecardKey },
    readback: async () => readInterview(interviewId),
    expect_note: RUN_MODE === 'FIRST_RUN'
      ? 'ok=true + replayed=false + scorecard id + scorecard 行 +1（真过闸门真写）'
      : 'ok=true + replayed=true + scorecard id + scorecard 行 +0（幂等重放在 D-79 闸门之前返回，不问人）',
    expect: (record) => {
      if (record.ok !== true || typeof record.result?.scorecard?.id !== 'string') return false
      if (RUN_MODE === 'FIRST_RUN') {
        return record.result?.replayed === false && (record.row_count_delta.scorecard ?? 0) === 1
      }
      return record.result?.replayed === true && (record.row_count_delta.scorecard ?? 0) === 0
    },
  })
  log(`scorecard allow-once approval requests=${scorecardApproval.calls.length}`)

  // ---- 13 S10 第 2 份面评（另一位必交面试官）----
  // 2 位面试官都是 required_scorecard=true → 只交 1 份时汇总 missing=1：
  //   * ready_for_decision=false；
  //   * STAGE 的 ADVANCE 必须走 missing_disposition=PROCEED_WITH_MISSING + 逐条 MISSING_ACK。
  // 为了让 S10 走**完整面板**（真实 ID/真实 consensus，不靠"缺人推进"的旁路），
  // 这里由第 2 位面试官**本人**再交一份面评：同样过 allow-once 闸门，作者从执行上下文取（104）。
  const interviewer2Db = { ...DB, actor_id: INTERVIEWER_2_ID }
  const scorecard2Approval = makeApproval('allow-once')
  const scorecard2Tool = createScorecardSubmitTool({ database: interviewer2Db, approval: scorecard2Approval })
  await runHop({
    id: 's10-scorecard-2',
    hop: 13,
    label: RUN_MODE === 'FIRST_RUN'
      ? 'S10 scorecard_submit（面试官 104 本人 + allow-once；补齐必交面板）'
      : 'S10 第 2 份面评幂等重放（RERUN）：同 key 同 payload → replayed=true、零写入',
    tool: scorecard2Tool,
    args: {
      ...scorecardArgs,
      idempotency_key: `gp-e2e:${applicationId}:scorecard-104`,
    },
    readback: async () => readInterview(interviewId),
    expect_note: RUN_MODE === 'FIRST_RUN'
      ? 'ok=true + replayed=false + scorecard id + scorecard 行 +1'
      : 'ok=true + replayed=true + scorecard id + scorecard 行 +0',
    expect: (record) => {
      if (record.ok !== true || typeof record.result?.scorecard?.id !== 'string') return false
      if (RUN_MODE === 'FIRST_RUN') {
        return record.result?.replayed === false && (record.row_count_delta.scorecard ?? 0) === 1
      }
      return record.result?.replayed === true && (record.row_count_delta.scorecard ?? 0) === 0
    },
  })
  log(`scorecard #2（104）approval requests=${scorecard2Approval.calls.length}`)
} else {
  skippedHops += 3
  log('HOP 11/12/13 SKIPPED：没有 interview_id。')
}

// ---- 14 S10 evaluation_summarize（F1 后必须成功；旧版这里被 pin 挡住） ----
// as_of 同样取"现在"（不能早于本次 run 里刚提交的面评/刚批准的 rubric；见 HOP3 的注释）。
const summarizeTool = createEvaluationSummarizeTool({ database: DB })
const summarizeAsOf = toOffsetIso()
const summarizeHop = interviewId === undefined ? null : await runHop({
  id: 's10-evaluation-summarize',
  hop: 14,
  label: 'S10 evaluation_summarize（只读汇总，不产结论）',
  tool: summarizeTool,
  args: { application_id: applicationId, decision_scope: 'STAGE', interview_id: interviewId, as_of: summarizeAsOf },
  readback: async () => ({ application: await readApplication(applicationId) }),
  expect_note: '两模式都 ok=true 且 summary_digest 是非空字符串（真实汇总；RERUN 读同一批已提交面评）',
  expect: (record) => record.ok === true && typeof record.result?.summary_digest === 'string',
})
const summaryValue = summarizeHop?.result
log(`summarize：${summarizeHop?.ok ? 'OK' : `FAILED(${summarizeHop?.error?.code}/${summarizeHop?.error_body?.reason_code ?? '?'})`}`)
if (summaryValue !== undefined) {
  log(`  summary_digest=${summaryValue.summary_digest}`)
  log(`  coverage=${JSON.stringify(summaryValue.coverage)}`)
  log(`  tally=${JSON.stringify(summaryValue.tally)} consensus=${summaryValue.consensus} (${summaryValue.consensus_scope})`)
  log(`  record=${JSON.stringify(summaryValue.record)} ready_for_decision=${summaryValue.ready_for_decision}`)
  log(`  blockers=${JSON.stringify((summaryValue.blockers ?? []).map((b) => b.code))} permitted_results=${JSON.stringify(summaryValue.permitted_results)}`)
  log(`  rubric=${JSON.stringify(summaryValue.rubric)}`)
}

// ---- 15 S10 decision_record(STAGE) —— 用**真实** summary_digest / 真实面评组装 basis_refs ----
// 旧 harness 因为拿不到汇总，传的是假 digest + 随机 INTERVIEW_RECORD；那只会制造 SUMMARY_STALE，
// 测不到产品真实边界。这里全部取自真实工具输出与库值（闸门/校验一条没放宽）。
const stageConfirmedAt = nowMinus(60)
const stageReason = '面试评估通过：工作经历与教育背景满足岗位 MUST_HAVE，建议进入下一轮。'
const stageResult = 'ADVANCE'
const transcriptState = transcriptReadHop?.result?.transcript?.state ?? 'UNKNOWN'
const scorecardRowsForBasis = interviewId === undefined ? [] : await query(`
  select id, interviewer_id, overall, revision_no, payload_hash, items->>'transcript_basis' as transcript_basis
    from recruitment.scorecard
   where tenant_id = $1 and interview_id = $2 and status = 'SUBMITTED'
   order by created_at, id`, [TENANT_ID, interviewId])
const stageBasisRefs = [
  {
    kind: 'SUMMARY',
    summary_digest: summaryValue?.summary_digest,
    contract_version: summaryValue?.contract_version,
    coverage: summaryValue?.coverage,
    tally: summaryValue?.tally,
    consensus: summaryValue?.consensus,
    provenance: summaryValue?.labels?.provenance,
  },
  {
    kind: 'RUBRIC_VERSION',
    id: summaryValue?.rubric?.version_id ?? appAfterIntake.rubric_version_id,
    payload_hash: summaryValue?.rubric?.payload_hash,
    version_no: summaryValue?.rubric?.version_no,
  },
  { kind: 'AUTHORITY', actor_id: ACTOR_ID, is_hiring_manager: preflight.hiring_manager_is_actor },
  ...scorecardRowsForBasis.map((row) => ({
    kind: 'SCORECARD',
    id: row.id,
    overall: row.overall,
    // transcript_basis 是面评 items 的保留键（SC-12 必填）；transcript_state 取 transcript_read 的真实 state。
    transcript_basis: row.transcript_basis ?? 'NO_TRANSCRIPT',
    transcript_state: transcriptState,
    revision_no: row.revision_no,
    interviewer_id: row.interviewer_id,
    payload_hash: row.payload_hash,
  })),
]
log(`decision basis: SCORECARD refs=${scorecardRowsForBasis.length} transcript_state=${transcriptState}`)
const stageDecisionArgs = {
  application_id: applicationId,
  decision_scope: 'STAGE',
  interview_id: interviewId ?? randomUUID(),
  // 与 summarize **同一个 as_of**：决策侧会按同一口径重算并比对 digest（DC-16/DC-20）。
  as_of: summarizeAsOf,
  result: stageResult,
  reason: stageReason,
  summary_digest: summaryValue?.summary_digest,
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
// ---- 15 阶段推进终跳（**终值 S10**）：先推进 S8→S9→S10，再做 S10 决策 ----
// 顺序修正（2026-11-15）：DC-07b 要求 STAGE/FINAL 写决策时 application 已在 S10；
// 旧版先做 S10 决策（实际在 S8）再推进，是错误业务顺序，会把 S7/S8 决策写进库。
const advanceAfterDecision = await runHop({
  id: 's10-stage-advance-after-decision',
  hop: 15,
  label: RUN_MODE === 'FIRST_RUN'
    ? '阶段推进终跳：S8→S9（canonical READY 转写）→ S9→S10（材料可用 + ≥1 SUBMITTED 面评），一次调用走完'
    : '阶段推进终跳幂等调用（RERUN）：申请已在 S10（v1.0 终态），必须 NO_OP 且零迁移',
  tool: stageAdvanceTool,
  args: { application_id: applicationId },
  readback: async () => ({ application: await readApplication(applicationId) }),
  expect_note: RUN_MODE === 'FIRST_RUN'
    ? 'ADVANCED + transitions 逐字 [{S8→S9},{S9→S10}] + stage_code=S10'
    : 'NO_OP + stage_code=S10 + transitions=[]（S10 是终态，不再前进、不发明 S11）',
  expect: (record) => {
    if (record.ok !== true) return false
    if (RUN_MODE === 'FIRST_RUN') {
      return record.result?.status === 'ADVANCED'
        && JSON.stringify(record.result?.transitions ?? [])
          === JSON.stringify([{ from: 'S8', to: 'S9' }, { from: 'S9', to: 'S10' }])
        && record.result?.stage_code === 'S10'
    }
    return record.result?.status === 'NO_OP'
      && record.result?.stage_code === 'S10'
      && (record.result?.transitions ?? []).length === 0
  },
})
log(`stage before S10 decision = ${advanceAfterDecision.result?.stage_code} status=${advanceAfterDecision.result?.status}`)

// ---- 16 S10 decision_record(STAGE)（**必须在 S10 之后**） ----
if (interviewId === undefined || summaryValue === undefined) {
  // 上游没有面试 / 汇总没成功时，不存在合法的 summary_digest 与面评依据；
  // 此时硬调 decision 只会得到一个 harness 自造的 INVALID_ARGS（旧版就踩过），如实标 SKIPPED。
  skippedHops += 1
  log('HOP 16 SKIPPED：HOP 7 没有面试 或 HOP 14 汇总未成功，无法构造合法 basis_refs。')
} else {
  const stageApproval = makeApproval('unavailable')
  const stageDecisionTool = createDecisionRecordTool({ database: DB, approval: stageApproval })
  const stageDecision = await runHop({
    id: 's10-decision-stage',
    hop: 16,
    label: RUN_MODE === 'FIRST_RUN'
      ? 'S10 decision_record(STAGE)（真实 summary_digest + 真实面评依据 + IN_CHAT v2）'
      : 'S10 decision_record(STAGE) 重复提交（RERUN）：STAGE@S10 决策已存在，必须 ALREADY_DECIDED 且零写入',
    tool: stageDecisionTool,
    args: stageDecisionArgs,
    readback: async () => ({
      application: await readApplication(applicationId),
      decisions: await readDecisions(applicationId),
      approval_service_calls: stageApproval.calls.length,
    }),
    expect_note: RUN_MODE === 'FIRST_RUN'
      ? 'ok=true + decision 行 +1（真实 digest/依据过闸门真写）'
      : 'ok=false + ALREADY_DECIDED/SCOPE_ALREADY_DECIDED + decision 行 +0（STEP 3 先于汇总重算）',
    expect: (record) => {
      if (RUN_MODE === 'FIRST_RUN') {
        return record.ok === true && (record.row_count_delta.decision ?? 0) === 1
      }
      return record.ok === false
        && record.error?.code === 'ALREADY_DECIDED'
        && (record.row_count_delta.decision ?? 0) === 0
    },
  })
  log(`STAGE 决策：${stageDecision.ok ? 'WROTE' : `FAILED(${stageDecision.error?.code}/${stageDecision.error_body?.reason_code ?? '?'})`}`)
}
// ---- 17 终态读回 ----
log('')
log('════════ HOP 17 · 终态读回（同一条申请 S6→S10 的全部事实；纯 SQL，不 import 产品代码） ════════')
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
// 阶段码的审计事实：fn_row_guard 在每次真实阶段变化时写一条 event_inbox（source_object_id=申请 id）。
const finalStageEvents = await query(`
  select event_id, event_type, source_object_id, occurred_at, payload->>'from' as from_stage,
         payload->>'to' as to_stage, payload->>'actor_id' as actor_id
    from recruitment.event_inbox
   where tenant_id = $1 and source_object_id = $2
     and event_type in ('application.current_stage_code.changed', 'application.rubric_version.pinned')
   order by recorded_at`, [TENANT_ID, applicationId])
// 0016 的一致性视图：**0 行 = 合规**（列：application_id / tenant_id / current_stage_code / violation_code / detail）。
const finalConsistencyViolationsForApp = await query(`
  select application_id, current_stage_code, violation_code, detail
    from recruitment.v_application_stage_consistency
   where tenant_id = $1 and application_id = $2
   order by violation_code`, [TENANT_ID, applicationId])
const finalConsistencyViolationsAll = await query(`
  select application_id, current_stage_code, violation_code
    from recruitment.v_application_stage_consistency
   where tenant_id = $1 order by application_id, violation_code`, [TENANT_ID])
const submittedScorecardRows = finalInterviewDetails.flatMap((detail) =>
  (detail?.scorecards ?? []).filter((row) => row.status === 'SUBMITTED' && row.superseded_by_scorecard_id === null))
const finalState = {
  application: finalChain?.application ?? null,
  candidate: finalChain?.candidate ?? null,
  resume_version: finalChain?.resume_version ?? null,
  intake_asset: finalChain?.intake_asset ?? null,
  application_events: finalChain?.events ?? [],
  stage_events: finalStageEvents,
  decisions: finalDecisions,
  interviews: finalInterviewDetails,
  counts: finalCounts,
  counts_delta_vs_preflight: diffCounts(preflight.counts, finalCounts),
  decisions_by_scope: await query(`
    select decision_scope, stage_code, count(*)::int as n from recruitment.decision
     where tenant_id = $1 group by 1, 2 order by 1, 2`, [TENANT_ID]),
  submitted_scorecards: submittedScorecardRows,
  consistency_view_violations_for_app: finalConsistencyViolationsForApp,
  consistency_view_violations_all: finalConsistencyViolationsAll,
}
await saveJson('hop-17-final-state.json', finalState)
const finalStage = finalState.application?.current_stage_code
log(`application.current_stage_code = ${finalStage}（终态断言：必须 = S10 = v1.0 终态的最后一格）`)
log(`application.stage_entered_at    = ${finalState.application?.stage_entered_at ?? '(未读)'}`)
log(`stage / pin 审计事件            = ${JSON.stringify(finalStageEvents.map((e) => `${e.event_type}:${e.from_stage ?? ''}->${e.to_stage ?? ''}`))}`)
log(`application.rubric_version_id   = ${finalState.application?.rubric_version_id}`)
log(`application.resume_version_id   = ${finalState.application?.resume_version_id}`)
log(`decisions for this application  = ${finalDecisions.length} 条 ${JSON.stringify(finalDecisions.map((d) => `${d.decision_scope}/${d.stage_code}/${d.result}`))}`)
log(`interviews for this application = ${finalInterviews.length} 场 ${JSON.stringify(finalInterviews.map((i) => `r${i.round_no}/${i.status}`))}`)
log(`transcript artifacts            = ${JSON.stringify(finalInterviewDetails.map((d) => (d?.transcript_artifacts ?? []).map((a) => `rev${a.source_revision}/canonical=${a.is_canonical}/${a.transcript_status}/${a.provenance}`)))}`)
log(`scorecards                      = ${JSON.stringify(finalInterviewDetails.map((d) => (d?.scorecards ?? []).map((s) => `${s.status}/${s.overall}/author=${s.interviewer_id.slice(-3)}`)))}`)
log(`submitted scorecards（现行）     = ${submittedScorecardRows.length} 份`)
log(`一致性视图 v_application_stage_consistency：本申请违规 ${finalConsistencyViolationsForApp.length} 行 / 全租户 ${finalConsistencyViolationsAll.length} 行（0 行 = 合规）`)
log(`行数对比（预检 → 终态，只列变化）：${JSON.stringify(finalState.counts_delta_vs_preflight)}`)
await flushLog()

// ---- 汇总：四数 / 负例 / 终态 / acceptance ----
const counts = {
  hops: hops.length,
  passed: hops.filter((record) => record.outcome === 'PASS').length,
  failed: hops.filter((record) => record.outcome === 'FAIL').length,
  skipped: skippedHops,
}
const negativeControls = hops
  .filter((record) => record.kind === 'negative-control')
  .map((record) => ({
    hop: record.hop,
    id: record.id,
    outcome: record.outcome,
    blocked: record.ok === false,
    code: record.error?.code,
    reason_code: record.error_body?.reason_code,
    reject_path: record.reject_path ?? null,
    had_scorecard_before: record.had_scorecard_before ?? null,
    row_delta: record.row_count_delta,
  }))
const HOP_TABLE = hops.map((record) => ({
  hop: record.hop,
  id: record.id,
  kind: record.kind,
  run_mode: record.run_mode,
  tool: record.tool,
  outcome: record.outcome,
  ok: record.ok,
  error_code: record.error?.code,
  reason_code: record.error_body?.reason_code,
  row_delta: record.row_count_delta,
}))
/** 验收五条（任何一条 false → exit 1；不是"尽量满足"）。 */
const acceptance = {
  all_hops_pass: counts.hops === 16 && counts.passed === 16 && counts.failed === 0 && counts.skipped === 0,
  stage_s10: finalStage === 'S10',
  submitted_scorecards_ge_1: submittedScorecardRows.length >= 1,
  consistency_view_zero_violations:
    finalConsistencyViolationsForApp.length === 0 && finalConsistencyViolationsAll.length === 0,
  negative_controls_blocked: negativeControls.length === 2
    && negativeControls.every((control) => control.outcome === 'PASS' && control.blocked === true),
}
acceptance.ok = acceptance.all_hops_pass
  && acceptance.stage_s10
  && acceptance.submitted_scorecards_ge_1
  && acceptance.consistency_view_zero_violations
  && acceptance.negative_controls_blocked

const harnessSha = sha256(await readFile(HARNESS_PATH))
const derivedHarnessSha = sha256(await readFile(fileURLToPath(new URL('./run-golden-path.mjs', HERE))))
const summary = {
  run_id: stamp,
  generated_at: new Date().toISOString(),
  expectation: {
    stage_advance_contract: '1.3.0',
    terminal_stage: 'S10',
    total_hops: 16,
    note: 'hop 0（预检）与 hop 17（终态读回）不计入 16；16 = 写/读/负例跳',
  },
  repository,
  harness: { path: HARNESS_PATH, sha256: harnessSha },
  harness_derived_from: {
    path: 'manual/golden-path/run-golden-path.mjs',
    sha256: derivedHarnessSha,
    note: '旧报告 run A/B/C 的原始 harness（保持不动）；本文件是它的 G4 派生版：终值 S10 + FIRST_RUN/RERUN + 内置 bootstrap + 证据根可配',
  },
  fixture: { path: fileURLToPath(FIXTURE_PDF), sha256: fixtureSha, bytes: fixtureBytes.length },
  bootstrap: {
    path: bootstrap.record.path,
    sha256: bootstrap.record.sha256,
    outcome: bootstrap.record.outcome,
    exit_code: bootstrap.record.exit_code,
    state: bootstrap.record.state,
    writes: bootstrap.record.writes,
    demo_approval_mode: bootstrap.record.demo_approval_mode,
  },
  database: { host: DB.host, port: DB.port, database: DB.database, tenant_id: TENANT_ID, actor_id: ACTOR_ID },
  run_mode: RUN_MODE,
  run_mode_guard: {
    expected: EXPECT_RUN_MODE,
    actual: RUN_MODE,
    ok: EXPECT_RUN_MODE === null ? null : EXPECT_RUN_MODE === RUN_MODE,
  },
  application_id: applicationId,
  candidate_id: candidateId,
  interview_id: interviewId,
  hops: HOP_TABLE,
  counts,
  negative_controls: negativeControls,
  failures: hops
    .filter((record) => record.outcome === 'FAIL')
    .map((record) => ({ hop: record.hop, id: record.id, code: record.error?.code, message: record.error?.message })),
  final_state: {
    application_stage: finalStage,
    application_rubric_version_id: finalState.application?.rubric_version_id,
    decision_count: finalDecisions.length,
    decision_scopes: finalState.decisions_by_scope,
    interview_count: finalInterviews.length,
    transcript_artifact_count: finalInterviewDetails.reduce((n, d) => n + (d?.transcript_artifacts ?? []).length, 0),
    interview_record_count: finalInterviewDetails.reduce((n, d) => n + (d?.interview_records ?? []).length, 0),
    scorecard_count: finalInterviewDetails.reduce((n, d) => n + (d?.scorecards ?? []).length, 0),
    submitted_scorecard_count: submittedScorecardRows.length,
    consistency_view_violations_for_app: finalConsistencyViolationsForApp.length,
    consistency_view_violations_all: finalConsistencyViolationsAll.length,
    consistency_violation_rows_for_app: finalConsistencyViolationsForApp,
    stage_events: finalStageEvents,
    counts: finalCounts,
    counts_delta_vs_preflight: finalState.counts_delta_vs_preflight,
  },
  acceptance,
}
await saveJson('summary.json', summary)

// ---- 人读 summary.md（逐跳表 + 四数 + 终态 + acceptance） ----
const mdTable = HOP_TABLE.map((row) => {
  const err = row.error_code === undefined ? '' : `${row.error_code}/${row.reason_code ?? ''}`
  return `| ${row.hop} | ${row.id} | ${row.kind} | ${row.run_mode} | ${row.outcome} | ${err} | ${JSON.stringify(row.row_delta)} |`
})
const mdNegative = negativeControls.map((control) =>
  `| ${control.hop} | ${control.id} | ${control.blocked ? 'BLOCKED' : 'UNEXPECTED-WRITE'} | ${control.code ?? ''}/${control.reason_code ?? ''} | ${control.reject_path ?? ''} | ${JSON.stringify(control.row_delta)} |`)
const mdLines = [
  `# Golden Path run ${stamp} — ${RUN_MODE}`,
  '',
  `- 生成时间：${summary.generated_at}`,
  `- 仓库 HEAD：\`${repository.head}\`（来源 ${repository.head_source}；工作树 ${repository.worktree_state}${repository.dirty_lines === null ? '' : `，dirty_lines=${repository.dirty_lines}`}；branch=${repository.branch ?? '(n/a)'}）`,
  `- harness：\`${HARNESS_PATH}\` sha256=\`${harnessSha}\``,
  `- fixture：\`${fileURLToPath(FIXTURE_PDF)}\` sha256=\`${fixtureSha}\`（${fixtureBytes.length} bytes）`,
  `- bootstrap：\`${bootstrap.record.path}\` sha256=\`${bootstrap.record.sha256}\` outcome=${bootstrap.record.outcome} exit_code=${bootstrap.record.exit_code} writes=${JSON.stringify(bootstrap.record.writes)}`,
  `- 数据库：${DB.user}@${DB.host}:${DB.port}/${DB.database}（tenant=${TENANT_ID}）`,
  `- run_mode：**${RUN_MODE}**（守卫：${EXPECT_RUN_MODE === null ? '未设置' : `${EXPECT_RUN_MODE} → ${EXPECT_RUN_MODE === RUN_MODE ? 'MATCH' : 'MISMATCH'}`}）`,
  '',
  '## 四数（16 跳）',
  '',
  `- hops=${counts.hops}`,
  `- passed=${counts.passed}`,
  `- failed=${counts.failed}`,
  `- skipped=${counts.skipped}`,
  '',
  '## 逐跳',
  '',
  '| hop | id | kind | run_mode | outcome | error/reason | row delta |',
  '|---:|---|---|---|---|---|---|',
  ...mdTable,
  '',
  '## 负例（期望被拒 + 零写入）',
  '',
  '| hop | id | result | code/reason | 实际拒绝路径 | row delta |',
  '|---:|---|---|---|---|---|',
  ...mdNegative,
  '',
  '## 终态（DB 独立读回）',
  '',
  `- application.current_stage_code = **${finalStage}**（终态断言：S10）`,
  `- application.rubric_version_id = ${finalState.application?.rubric_version_id ?? '(null)'}`,
  `- decisions = ${finalDecisions.length}（${JSON.stringify(finalState.decisions_by_scope)}）`,
  `- interviews = ${finalInterviews.length}`,
  `- transcript artifacts = ${summary.final_state.transcript_artifact_count}`,
  `- interview_record = ${summary.final_state.interview_record_count}`,
  `- scorecards = ${summary.final_state.scorecard_count}（SUBMITTED 现行 = ${submittedScorecardRows.length}）`,
  `- v_application_stage_consistency 违规：本申请 ${finalConsistencyViolationsForApp.length} 行 / 全租户 ${finalConsistencyViolationsAll.length} 行（0 行 = 合规）`,
  `- stage / pin 审计事件：${JSON.stringify(finalStageEvents.map((e) => `${e.event_type}:${e.from_stage ?? ''}->${e.to_stage ?? ''}`))}`,
  '',
  '## acceptance',
  '',
  `- all_hops_pass=${acceptance.all_hops_pass}`,
  `- stage_s10=${acceptance.stage_s10}`,
  `- submitted_scorecards_ge_1=${acceptance.submitted_scorecards_ge_1}`,
  `- consistency_view_zero_violations=${acceptance.consistency_view_zero_violations}`,
  `- negative_controls_blocked=${acceptance.negative_controls_blocked}`,
  `- **ok=${acceptance.ok}**`,
  '',
  '> 数据全部为合成 fixture（R4 provenance=FIXTURE）；写只经产品工具 execute()，本 harness 不手工 UPDATE 业务行。',
  '',
]
await writeFile(join(RUN_DIR, 'summary.md'), mdLines.join('\n'), 'utf8')

log('')
log('════════ HOP 汇总表 ════════')
log('hop | kind             | run_mode  | id                        | outcome | error/reason                          | row delta')
log('----+------------------+-----------+---------------------------+---------+---------------------------------------+----------')
for (const row of HOP_TABLE) {
  const err = row.error_code === undefined ? '' : `${row.error_code}/${row.reason_code ?? ''}`
  log(`${String(row.hop).padStart(3)} | ${String(row.kind).padEnd(16)} | ${String(row.run_mode).padEnd(9)} | ${row.id.padEnd(25)} | ${row.outcome.padEnd(7)} | ${err.padEnd(37)} | ${JSON.stringify(row.row_delta)}`)
}
log('')
log(`四数：hops=${counts.hops} passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped}`)
log(`闸门负例（期望被拒）：${negativeControls.map((control) => `HOP${control.hop}(${control.id}) ${control.blocked ? 'BLOCKED' : 'UNEXPECTED-WRITE'} ${control.code}/${control.reason_code ?? ''} path=${control.reject_path ?? ''} delta=${JSON.stringify(control.row_delta)}`).join(' ; ') || '无'}`)
log(`意外失败（outcome=FAIL）：${summary.failures.length} 个`)
log(`阶段码终值：${finalStage}（终态断言 S10 ${finalStage === 'S10' ? 'PASS' : 'FAIL'}）`)
log(`acceptance：all_hops_pass=${acceptance.all_hops_pass} stage_s10=${acceptance.stage_s10}`
  + ` submitted_scorecards_ge_1=${acceptance.submitted_scorecards_ge_1}`
  + ` consistency_view_zero_violations=${acceptance.consistency_view_zero_violations}`
  + ` negative_controls_blocked=${acceptance.negative_controls_blocked} → ok=${acceptance.ok}`)
log('')
log(`summary    : ${join(RUN_DIR, 'summary.json')}`)
log(`summary.md : ${join(RUN_DIR, 'summary.md')}`)
log(`bootstrap  : ${join(RUN_DIR, 'bootstrap.json')} / bootstrap.log`)
log(`run.log    : ${LOG_PATH}`)
await flushLog()
await pool.end()
// 任何 hop FAIL 或 acceptance 不成立 → 非 0（不接受"跳全绿但终态/一致性不对"）。
if (counts.failed > 0 || acceptance.ok !== true) process.exitCode = 1
