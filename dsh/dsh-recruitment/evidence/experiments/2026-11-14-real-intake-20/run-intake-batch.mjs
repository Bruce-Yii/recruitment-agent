// 真实语料批量走 S6 intake（取证脚本，不是产品运行时）。
//
// 每份文档两跳，**都走产品真实工具入口的 handler**（不是 SQL）：
//   1) `recruitment_document_read`（U3 统一读取，带质量判定与恢复计划；只读、不写库）
//   2) `recruitment_application_intake`（S6 唯一写库工具；身份闸门在里面）
// 身份闸门**不放开**：只有 `provenance='native_text'` 的 phone/email 能自动归并，
// OCR / agent 读出来的一律进 weak ⇒ 工具自己抛 `BLOCKED_BY_REVIEW`，一行不写。
//
// R7：输出**不含**文件名（文件名带真实姓名）、电话、邮箱原文；只给 sha256 前缀、
// 脱敏标签 F01..、id、状态、字段**名**与 provenance。
//
// 用法（PowerShell，包目录下）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node evidence/experiments/2026-11-14-real-intake-20/run-intake-batch.mjs --mode intake --max-created 20
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { createDocumentReadTool } from '../../../src/tools/document-read.ts'
import { createApplicationIntakeTool } from '../../../src/tools/application-intake.ts'
import { resolveConverterConfig } from '../../../src/tools/converter.ts'
import { resolveDatabaseConfig } from '../../../src/db/pool.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..', '..')
const REPO = resolve(PLUGIN_DIR, '..', '..')
const CORPUS = resolve('D:\\12412\\dsh工作区\\projects\\resume-talent-pool\\.snap-cache\\research\\content')
const JOB_ID = '11111111-1111-4111-8111-000000000401'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const mode = option('--mode', 'intake')
const maxCreated = Number(option('--max-created', '999'))
const labelsArg = option('--labels', '')
const excludeArg = option('--exclude', '')
const order = option('--order', 'size-asc')
const outLabel = option('--out', mode)
const limit = Number(option('--limit', '999'))

const converter = resolveConverterConfig({
  python_bin: process.env.RECRUITMENT_PYTHON ?? 'D:\\Python3.12.9\\python.exe',
  converter_dir: join(REPO, 'converter'),
  allowed_roots: [CORPUS],
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

const readTool = createDocumentReadTool(converter.resolved)
const intakeTool = createApplicationIntakeTool({
  converter: converter.resolved,
  database: database.resolved,
})

// 语料文件的绝对路径映射放在**仓库外**（临时目录）：文件名带真实姓名，按 R7 不入库。
const CORPUS_MAP = join(tmpdir(), 'recruitment-real-intake-20', 'corpus-paths.json')
const inventory = JSON.parse(readFileSync(CORPUS_MAP, 'utf8'))
const excluded = excludeArg === '' ? [] : excludeArg.split(',')
let selected = labelsArg === ''
  ? inventory.filter((row) => !excluded.includes(row.label))
  : inventory.filter((row) => labelsArg.split(',').includes(row.label))
if (order === 'size-asc') selected = [...selected].sort((a, b) => a.bytes - b.bytes)
const extArg = option('--ext', '')
if (extArg !== '') selected = selected.filter((row) => extArg.split(',').includes(row.ext.replace('.', '')))

const LOG = join(HERE, `run-log-${outLabel}.txt`)
writeFileSync(LOG, `# ${new Date().toISOString()} mode=${mode} job=${JOB_ID}\n`
  + `# 语料根：resume-talent-pool/.snap-cache/research/content（真实语料；日志不含文件名/PII）\n`, 'utf8')
const log = (line) => {
  appendFileSync(LOG, `${line}\n`, 'utf8')
  console.log(line)
}

/** 错误消息里可能带文件路径/文件名 → 只留 code 与 reason_code。 */
function summarizeError(error) {
  const code = String(error?.code ?? error?.name ?? 'ERROR')
  const message = String(error?.message ?? error)
  const reason = /"reason_code":"([A-Z_]+)"/.exec(message)?.[1] ?? ''
  return { code, reason_code: reason }
}

const results = []
let created = 0

for (const [index, file] of selected.entries()) {
  if (created >= maxCreated) break
  if (index >= limit) break
  const startedAt = Date.now()
  const row = {
    label: file.label,
    sha12: file.sha12,
    bytes: file.bytes,
    ext: file.ext,
  }

  // ---- 1) document_read（真实 U3 入口；只读） ----
  let readValue = null
  try {
    readValue = await readTool.execute({ path: file.path }, { signal: new AbortController().signal })
    row.read = {
      ok: true,
      media_type: readValue.media_type,
      reader: `${readValue.reader_id}@${readValue.reader_version}`,
      completeness: readValue.completeness,
      needs_visual: readValue.needs_visual,
      blocking: readValue.assessment.blocking,
      blocking_codes: readValue.assessment.blocking_codes,
      soft_codes: readValue.assessment.soft_codes,
      pages: readValue.page_count,
      chars: readValue.source_chars,
      blocks: readValue.blocks.length,
      recovery_next: readValue.recovery.next,
      recovery_steps: readValue.recovery.steps.map((step) => `${step.kind}:${step.status ?? 'plan'}`),
      execution: {
        ran: readValue.recovery.execution.executed,
        succeeded: readValue.recovery.execution.succeeded,
        failed: readValue.recovery.execution.failed,
        content_updated: readValue.recovery.execution.content_updated,
      },
    }
    log(`[${index + 1}] ${file.label} sha=${file.sha12} ${file.ext} ${file.bytes}B`)
    log(`    READ ok reader=${row.read.reader} media=${row.read.media_type} completeness=${row.read.completeness} `
      + `needs_visual=${row.read.needs_visual} blocking=${row.read.blocking} pages=${row.read.pages} chars=${row.read.chars} blocks=${row.read.blocks}`)
    log(`    READ blocking_codes=[${row.read.blocking_codes.join(',')}] recovery_next=${row.read.recovery_next} `
      + `execution=${JSON.stringify(row.read.execution)}`)
  } catch (error) {
    row.read = { ok: false, ...summarizeError(error) }
    log(`[${index + 1}] ${file.label} sha=${file.sha12} ${file.ext} ${file.bytes}B`)
    log(`    READ FAIL code=${row.read.code} reason=${row.read.reason_code || '-'}`)
  }

  // ---- 2) intake（真实 S6 入口；会写库） ----
  if (mode === 'intake') {
    try {
      const value = await intakeTool.execute({ path: file.path, job_id: JOB_ID }, { signal: new AbortController().signal })
      row.intake = {
        ok: true,
        status: value.status,
        application_action: value.application_action,
        candidate_created: value.candidate_created,
        matched_by: value.matched_by,
        candidate_id: value.candidate_id,
        application_id: value.application_id,
        resume_version_id: value.resume_version_id,
        resume_version_no: value.resume_version_no,
        resume_version_action: value.resume_version_action,
        intake_asset_id: value.intake_asset_id,
        structure_saved: value.structure_saved,
        provenance: value.provenance,
        // 身份闸门机检面：只要**字段名**与计数，不要值
        strong_fields: value.identity.strong_ids,
        merge_eligible: value.identity.identity_merge_eligible,
        weak_fields: value.identity.weak_fields.map((w) => `${w.field}:${w.provenance}`),
        blocked_fields: value.identity.blocked_fields.map((b) => `${b.field}:${b.reason}`),
        evidence_refs: value.identity.evidence.length,
        parse_status: value.source.parse_status,
        source_sha12: String(value.source.sha256).slice(0, 12),
      }
      if (value.application_action === 'CREATED') created += 1
      log(`    INTAKE ok status=${value.status} application_action=${value.application_action} `
        + `candidate_created=${value.candidate_created} matched_by=${value.matched_by}`)
      log(`    INTAKE ids candidate=${value.candidate_id} application=${value.application_id} `
        + `resume_version=${value.resume_version_id} asset=${value.intake_asset_id}`)
      log(`    INTAKE gate strong=[${value.identity.strong_ids.join(',')}] `
        + `merge_eligible=[${value.identity.identity_merge_eligible.join(',')}] `
        + `weak=[${value.identity.weak_fields.map((w) => `${w.field}:${w.provenance}`).join(',')}] `
        + `blocked=[${value.identity.blocked_fields.map((b) => `${b.field}:${b.reason}`).join(',')}] evidence=${value.identity.evidence.length}`)
    } catch (error) {
      const summary = summarizeError(error)
      row.intake = { ok: false, ...summary, blocked: summary.code === 'BLOCKED_BY_REVIEW' }
      log(`    INTAKE BLOCKED code=${summary.code} reason=${summary.reason_code || '-'}（闸门拒绝，未写任何行）`
        .replace('BLOCKED code=', summary.code === 'BLOCKED_BY_REVIEW' ? 'BLOCKED code=' : 'FAIL code='))
    }
  }

  row.ms = Date.now() - startedAt
  results.push(row)
  log(`    (${row.ms}ms, 累计 CREATED=${created})`)
  log('')
  writeFileSync(join(HERE, `results-${outLabel}.json`), `${JSON.stringify(results, null, 1)}\n`, 'utf8')
}

log(`## 汇总 mode=${mode} 处理=${results.length} 读成功=${results.filter((r) => r.read?.ok).length} `
  + `intake成功=${results.filter((r) => r.intake?.ok).length} `
  + `BLOCKED=${results.filter((r) => r.intake?.blocked).length} CREATED=${created}`)
