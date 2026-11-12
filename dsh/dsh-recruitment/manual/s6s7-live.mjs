// 手工联调驱动（不是单测）：把 S6/S7 两个工具**真的**对着本地 PG 跑一遍。
//
// 为什么放在 `manual/` 而不是 `test/`：`node --test` 会把 `test/` 下所有 .ts/.mjs
// 当测试文件加载，而这个脚本要连库、要读真 PDF、会写库（S6）。
//
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/s6s7-live.mjs [pdf 绝对路径]
//
// 输出**不含**姓名/手机号/邮箱：只打印 id、state、计数与错误码（R7）。
import { createApplicationIntakeTool } from '../src/tools/application-intake.ts'
import { createScreeningEvaluateTool } from '../src/tools/screening-evaluate.ts'
import { resolveConverterConfig } from '../src/tools/converter.ts'
import { resolveDatabaseConfig } from '../src/db/pool.ts'

const REPO = 'D:\\12412\\dsh工作区\\projects\\recruitment-agent'
const PDF = process.argv[2]
  ?? `${REPO}\\converter\\corpus\\synthetic\\platform_noise.pdf`
const JOB_ID = '11111111-1111-4111-8111-000000000401'

const converter = resolveConverterConfig({
  python_bin: 'D:\\Python3.12.9\\python.exe',
  converter_dir: `${REPO}\\converter`,
  allowed_roots: [`${REPO}\\converter\\corpus\\synthetic`],
})
if (converter.resolved === null) {
  console.error('converter config issues:', converter.issues)
  process.exit(2)
}
const database = resolveDatabaseConfig({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, process.env)
if (database.resolved === null) {
  console.error('database config issues:', database.issues)
  process.exit(2)
}

const intake = createApplicationIntakeTool({ converter: converter.resolved, database: database.resolved })
const evaluate = createScreeningEvaluateTool(database.resolved)

/** 只打印不含 PII 的字段。 */
function summarizeIntake(value) {
  return {
    status: value.status,
    created: value.created,
    candidate_created: value.candidate_created,
    idempotent_replay: value.idempotent_replay,
    matched_by: value.matched_by,
    candidate_id: value.candidate_id,
    application_id: value.application_id,
    resume_version_id: value.resume_version_id,
    intake_record_id: value.intake_record_id,
    event_id: value.event_id,
    provenance: value.provenance,
    labels: value.labels,
    source: {
      file_name: value.source.file_name,
      sha256: value.source.sha256,
      pages: value.source.pages,
      byte_size: value.source.byte_size,
      completeness: value.source.completeness,
      parse_status: value.source.parse_status,
      hard_issue_count: value.source.hard_issue_count,
    },
    identity: {
      strong_ids: value.identity.strong_ids,
      blocked_fields: value.identity.blocked_fields,
      evidence_count: value.identity.evidence.length,
      evidence_pages: value.identity.evidence.map((e) => `${e.field}@p${e.page}`),
    },
    application: value.application,
  }
}

/** 只打印不含 PII 的字段（evidence 只给 page/bbox，不给 quote）。 */
function summarizeEvaluate(value) {
  return {
    status: value.status,
    verdict: value.verdict,
    verdict_summary: value.verdict_summary,
    criteria_evaluated: value.criteria_evaluated,
    required_human_action: value.required_human_action,
    labels: value.labels,
    rubric: value.rubric,
    preconditions: value.preconditions,
    resume_version: value.resume_version,
    snapshot: value.snapshot,
    reasons: value.reasons.map((r) => ({
      code: r.code,
      failure_class: r.failure_class,
      criterion_key: r.criterion_key,
      kind: r.kind,
      outcome: r.outcome,
      tri_state: r.tri_state,
      bounds: r.bounds,
      evidence_count: r.evidence.length,
      evidence_pages: r.evidence.map((e) => `p${e.page}`),
      issue_codes: r.issue_codes,
    })),
    bonus_signals: value.bonus_signals.map((r) => ({ code: r.code, criterion_key: r.criterion_key })),
    warnings: value.warnings.map((w) => w.code),
    prior_screening: value.prior_screening,
    evaluation_digest: value.evaluation_digest,
  }
}

async function call(tool, args) {
  try {
    return { ok: true, value: await tool.execute(args, { signal: new AbortController().signal }) }
  } catch (error) {
    return { ok: false, error: `${error?.code ?? error?.name}: ${error?.message ?? String(error)}` }
  }
}

const first = await call(intake, { path: PDF, job_id: JOB_ID })
console.log('=== S6 intake #1 ===')
console.log(first.ok ? JSON.stringify(summarizeIntake(first.value), null, 2) : first.error)
if (!first.ok) process.exit(1)

const second = await call(intake, { path: PDF, job_id: JOB_ID })
console.log('=== S6 intake #2 (idempotent replay) ===')
console.log(second.ok ? JSON.stringify(summarizeIntake(second.value), null, 2) : second.error)

const evaluated = await call(evaluate, { application_id: first.value.application_id })
console.log('=== S7 evaluate ===')
console.log(evaluated.ok ? JSON.stringify(summarizeEvaluate(evaluated.value), null, 2) : evaluated.error)

const negResume = await call(evaluate, { application_id: first.value.application_id, resume_version_id: '00000000-0000-4000-8000-000000000000' })
console.log('=== S7 negative: unknown resume_version_id ===')
console.log(negResume.ok ? 'UNEXPECTED OK' : negResume.error)

const negArg = await call(evaluate, { application_id: 'job_0001' })
console.log('=== S7 negative: job_0001 is not a UUID ===')
console.log(negArg.ok ? 'UNEXPECTED OK' : negArg.error)

const negIdentity = await call(evaluate, { application_id: first.value.application_id, actor_id: '11111111-1111-4111-8111-000000000101' })
console.log('=== S7 negative: model-supplied actor_id ===')
console.log(negIdentity.ok ? 'UNEXPECTED OK' : negIdentity.error)
