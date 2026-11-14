// 真实语料 · 格式覆盖端到端取证（不是产品运行时；只读原件 + 调真实产品工具）。
//
// 每个格式跑三件事，全部走**产品 handler**（不是 mock）：
//   1) `recruitment_document_read`（统一读取层）
//   2) `recruitment_resume_read`（旧读工具，验证不再 PDF-only）
//   3) `recruitment_application_intake`（S6 真实写库路径）
//
// 输入路径来自环境变量（文件名带真实姓名，按 R7 不进仓库、不进日志）：
//   RA_E2E_RTF_PATH / RA_E2E_DOCX_PATH / RA_E2E_PDF_PATH
// 图片格式在真实语料里不存在 → 本脚本在 %TEMP% 现造一张 1x1 PNG，并如实标
// `provenance=FIXTURE`（数据是造的），不冒充真实材料。
//
// 输出（写入本目录）：
//   results.json  机器可读结果（无姓名/电话/邮箱/文件名；只有 sha 前缀与状态码）
//   run-log.txt   逐行日志（同上）
//
// 用法（仓库根，PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   $env:RA_E2E_RTF_PATH='...'; $env:RA_E2E_DOCX_PATH='...'; $env:RA_E2E_PDF_PATH='...'
//   node evidence/experiments/2026-11-14-format-coverage/run-format-e2e.mjs
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

import { createDocumentReadTool } from '../../../src/tools/document-read.ts'
import { createResumeReadTool } from '../../../src/tools/resume-read.ts'
import { createApplicationIntakeTool } from '../../../src/tools/application-intake.ts'
import { resolveConverterConfig } from '../../../src/tools/converter.ts'
import { resolveDatabaseConfig } from '../../../src/db/pool.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEMO_JOB = '11111111-1111-4111-8111-000000000401'
const TENANT = '11111111-1111-4111-8111-000000000001'
const ACTOR = '11111111-1111-4111-8111-000000000103'

/** 三维标签（R4）：数据真假 / 触发方式 / 产品能不能自己读。 */
function labelsOf(provenance, connection = 'CONNECTED') {
  return { provenance, trigger: 'MANUAL', connection }
}

/** 路径字段一律替换成 <path>：日志里不出现文件名（R7）。 */
function redact(value) {
  return String(value ?? '').replace(/(?:[A-Za-z]:\\|\/)[^\s"']+/g, '<path>')
}
/** 从 `RecruitmentToolError` 的 `<CODE>: <json>` 里只取稳定码（不取正文/路径）。 */
function errorCode(error) {
  const message = error instanceof Error ? error.message : String(error)
  const prefix = /^([A-Z_]+): /.exec(message)
  let reasonCode = null
  const index = message.indexOf(': ')
  if (index >= 0) {
    try {
      const body = JSON.parse(message.slice(index + 2))
      if (typeof body?.reason_code === 'string') reasonCode = body.reason_code
      if (typeof body?.code === 'string') reasonCode = reasonCode ?? body.code
    } catch {
      // 不是 JSON：只留前缀码，消息不入证据（可能含路径）。
    }
  }
  return { code: prefix === null ? 'UNKNOWN_ERROR' : prefix[1], reason_code: reasonCode }
}

const CONVERTER_DIR = join(HERE, '..', '..', '..', '..', '..', 'converter')
/** python 解释器：环境变量优先；否则用 PATH 上的 python 解析成绝对路径（config 要求绝对路径）。 */
function resolvePython() {
  const explicit = process.env['RECRUITMENT_PYTHON']
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return execFileSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
}
const python = resolvePython()
const roots = [
  'D:\\12412\\dsh工作区\\projects\\resume-talent-pool',
  'D:\\12412\\dsh工作区\\orchestration',
  'D:\\12412\\CodexWorkspace',
  tmpdir(),
]
const converterResolution = resolveConverterConfig({
  python_bin: python,
  converter_dir: CONVERTER_DIR,
  allowed_roots: roots,
  timeout_ms: 180_000,
})
if (converterResolution.resolved === null) {
  throw new Error(`converter config invalid: ${converterResolution.issues.join('; ')}`)
}
const converter = converterResolution.resolved

const dbResolution = resolveDatabaseConfig({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: TENANT, actor_id: ACTOR,
}, process.env)
if (dbResolution.resolved === null) {
  throw new Error(`database config invalid: ${dbResolution.issues.join('; ')}`)
}
const database = dbResolution.resolved

const documentRead = createDocumentReadTool(converter)
const resumeRead = createResumeReadTool(converter)
const intake = createApplicationIntakeTool({ converter, database })

const pool = new pg.Pool({
  host: database.host, port: database.port, user: database.user, database: database.database,
  password: database.password, max: 1,
})

async function counts() {
  const out = {}
  for (const table of ['candidate', 'application', 'resume', 'resume_version', 'intake_record', 'intake_asset']) {
    const { rows } = await pool.query(
      `select count(*)::int as n from recruitment.${table} where tenant_id = $1`, [TENANT])
    out[table] = rows[0].n
  }
  return out
}

async function assetRow(sha256) {
  const { rows } = await pool.query(
    `select a.mime_type, a.validation_status,
            rv.parser_name, rv.parser_version, rv.parse_status
       from recruitment.intake_asset a
       left join recruitment.resume r on r.intake_asset_id = a.id
       left join recruitment.resume_version rv on rv.resume_id = r.id
      where a.tenant_id = $1 and a.sha256 = $2
      order by rv.version_no desc nulls last
      limit 1`,
    [TENANT, sha256])
  return rows[0] ?? null
}

async function applicationById(applicationId) {
  const { rows } = await pool.query(
    `select a.id, a.current_stage_code, a.lifecycle_status, a.job_id, a.candidate_id, a.record_version
       from recruitment.application a
      where a.tenant_id = $1 and a.id = $2`,
    [TENANT, applicationId])
  return rows[0] ?? null
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 一个格式的完整取证：document_read → resume_read → intake → DB 读回。 */
async function probe(format, path, provenance) {
  const sha256 = sha256Of(path)
  const row = {
    format,
    byte_size: readFileSync(path).length,
    sha12: sha256.slice(0, 12),
    labels: labelsOf(provenance),
    document_read: null,
    resume_read: null,
    intake: null,
    db: { asset_before: await assetRow(sha256) !== null, asset_after: null, application: null },
  }

  // 1) 统一读取层（真实 handler；不 mock）
  try {
    const value = await documentRead.execute({ path }, {})
    row.document_read = {
      ok: true,
      media_type: value.media_type,
      reader_id: value.reader_id,
      reader_version: value.reader_version,
      completeness: value.completeness,
      needs_visual: value.needs_visual,
      page_count: value.page_count,
      blocks: value.blocks.length,
      block_pages: [...new Set(value.blocks.map((block) => block.page))],
      blocking: value.assessment.blocking,
      blocking_for_structure: value.assessment.blocking_for_structure,
      layout_only_blocking: value.assessment.layout_only_blocking,
      blocking_codes: value.assessment.blocking_codes,
      soft_codes: value.assessment.soft_codes,
      recovery_next: value.recovery.next,
    }
  } catch (error) {
    row.document_read = { ok: false, ...errorCode(error) }
  }

  // 2) 旧读工具（gap 一：按内容嗅探，不再 PDF-only）
  try {
    const value = await resumeRead.execute({ path }, {})
    row.resume_read = {
      ok: true,
      media_type: value.source.media_type,
      backend: value.source.backend,
      pages: value.source.pages,
      completeness: value.source.completeness,
      blocks: value.block_count,
      provenance: value.provenance,
      provenance_basis: value.provenance_basis,
      field_states: Object.fromEntries(
        Object.entries(value.fields).map(([key, field]) => [key, field.state])),
      issue_codes: [...new Set(value.issues.map((issue) => issue.code))],
    }
  } catch (error) {
    row.resume_read = { ok: false, ...errorCode(error) }
  }

  // 3) S6 真实写库路径
  try {
    const value = await intake.execute({ path, job_id: DEMO_JOB })
    row.intake = {
      outcome: value.application_action,
      application_id: value.application_id,
      candidate_id: value.candidate_id,
      candidate_created: value.candidate_created,
      matched_by: value.matched_by,
      resume_version_no: value.resume_version_no,
      structure_saved: value.structure_saved,
      source: {
        media_type: value.source.media_type,
        parse_status: value.source.parse_status,
        pages: value.source.pages,
        completeness: value.source.completeness,
      },
      labels: value.labels,
    }
    row.db.asset_after = await assetRow(sha256)
    row.db.application = await applicationById(value.application_id)
  } catch (error) {
    row.intake = { outcome: 'BLOCKED_OR_REJECTED', ...errorCode(error) }
    row.db.asset_after = await assetRow(sha256)
  }

  // 覆盖状态（诚实分级，不看"读得进去"就自动算 PASS）
  const readOk = row.document_read?.ok === true
  const resumeOk = row.resume_read?.ok === true
  const intakeOutcome = row.intake?.outcome
  if (readOk && resumeOk && (intakeOutcome === 'CREATED' || intakeOutcome === 'REUSED')) {
    row.coverage = 'PASS'
  } else if (readOk && resumeOk && intakeOutcome === 'BLOCKED_OR_REJECTED'
    && row.intake?.code === 'BLOCKED_BY_REVIEW') {
    row.coverage = 'PARTIAL' // 读得出来，但身份闸门拒收（缺可自动归并的证据）
  } else {
    row.coverage = 'FAILED'
  }
  return row
}

const rtfPath = process.env['RA_E2E_RTF_PATH']
const docxPath = process.env['RA_E2E_DOCX_PATH']
const pdfPath = process.env['RA_E2E_PDF_PATH']
const docxNoIdentityPath = process.env['RA_E2E_DOCX_NO_IDENTITY_PATH']
if (!rtfPath || !docxPath || !pdfPath) {
  throw new Error('RA_E2E_RTF_PATH / RA_E2E_DOCX_PATH / RA_E2E_PDF_PATH must be set (real corpus paths)')
}

// 图片格式：真实语料里没有图片文件 → 用 Pillow 现造一张合法 PNG（provenance 如实标 FIXTURE）。
const pngPath = join(mkdtempSync(join(tmpdir(), 'ra-format-e2e-')), 'synthetic.png')
execFileSync(python, ['-c',
  'import sys; from PIL import Image; Image.new("RGB", (64, 64), (255, 255, 255)).save(sys.argv[1])',
  pngPath], { encoding: 'utf8', timeout: 60_000 })

const before = await counts()
const results = {
  generated_at: new Date().toISOString(),
  environment: { python, converter_dir: '<repo>/converter', database: `${database.database}@${database.host}` },
  labels_policy: {
    provenance: 'LIVE = 真实语料文件（sha256 可复核）；FIXTURE = 本脚本现造的合成件',
    trigger: 'MANUAL = 由本取证脚本显式调用产品工具',
    connection: 'CONNECTED = 本地读取器 + 本地数据库，产品自己能读',
  },
  db_before: before,
  formats: [],
}
const imageRow = ['image', pngPath, 'FIXTURE']
const matrix = [
  ['rtf', rtfPath, 'LIVE'],
  ['docx', docxPath, 'LIVE'],
  // 可选：第二份真实 DOCX，正文里 phone 读不出/email 缺失 → 身份闸门必须 BLOCKED。
  ...(docxNoIdentityPath ? [['docx-no-identity', docxNoIdentityPath, 'LIVE']] : []),
  ['pdf', pdfPath, 'LIVE'],
  imageRow,
]
for (const [format, path, provenance] of matrix) {
  const row = await probe(format, path, provenance)
  results.formats.push(row)
  console.log(`${format}: coverage=${row.coverage} ` +
    `document_read=${row.document_read?.ok ? `${row.document_read.media_type}/${row.document_read.completeness}` : `FAIL(${row.document_read?.code})`} ` +
    `resume_read=${row.resume_read?.ok ? row.resume_read.media_type : `FAIL(${row.resume_read?.code})`} ` +
    `intake=${row.intake?.outcome}${row.intake?.code ? `(${row.intake.code}/${row.intake.reason_code})` : ''}`)
}
results.db_after = await counts()
await pool.end()

const json = `${JSON.stringify(results, null, 1)}\n`
writeFileSync(join(HERE, 'results.json'), json, 'utf8')
const logLines = [
  `generated_at: ${results.generated_at}`,
  `db_before: ${JSON.stringify(results.db_before)}`,
  ...results.formats.map((row) => `${row.format.padEnd(6)} coverage=${row.coverage} ` +
    `doc_read=${JSON.stringify(row.document_read)} resume_read=${JSON.stringify(row.resume_read)} ` +
    `intake=${JSON.stringify(row.intake)} db=${JSON.stringify(row.db)}`),
  `db_after: ${JSON.stringify(results.db_after)}`,
]
writeFileSync(join(HERE, 'run-log.txt'), `${logLines.join('\n')}\n`, 'utf8')
console.log('wrote results.json / run-log.txt')
