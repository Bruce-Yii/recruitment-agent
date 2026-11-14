// 把各批 results JSON 汇总成 README 的表格行（只读、无 PII：只有 sha 前缀、id、状态、字段名）。
// 每个 F 标签只出一行（F20 的首次 CREATED 被同文件幂等复跑覆盖成 REUSED，单独注明）。
// 用法：node evidence/experiments/2026-11-14-real-intake-20/make-table.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES = ['results-pdfs.json', 'results-probe1.json', 'results-largest.json', 'results-docx.json', 'results-docx-rest.json']

const rows = []
const seen = new Map()
for (const file of FILES) {
  let data
  try {
    data = JSON.parse(readFileSync(join(HERE, file), 'utf8'))
  } catch {
    continue
  }
  for (const row of data) {
    if (seen.has(row.label)) continue
    seen.set(row.label, file)
    const read = row.read?.ok
      ? `${row.read.reader.split('@')[0]} ${row.read.completeness}${row.read.blocking ? ' ⚠blocking' : ''}`
      : `FAIL ${row.read?.code ?? '?'}${row.read?.reason_code ? `(${row.read.reason_code})` : ''}`
    let intake
    let appId = '—'
    let candId = '—'
    let gate = ''
    if (file === 'results-docx-rest.json') {
      intake = '（只读，未试 intake）'
    } else if (row.intake?.ok) {
      intake = `OK ${row.intake.application_action}`
      appId = `\`${row.intake.application_id}\``
      candId = `\`${row.intake.candidate_id}\``
      gate = `strong=[${row.intake.strong_fields.join(',')}]`
      if (row.intake.weak_fields.length > 0) gate += ` weak=[${row.intake.weak_fields.join(',')}]`
      if (row.intake.blocked_fields.length > 0) gate += ` blocked=[${row.intake.blocked_fields.join(',')}]`
      if (row.label === 'F20') gate += '（首跑 CREATED，见阶段 B；复跑幂等 REUSED）'
    } else if (row.intake?.blocked) {
      intake = `**BLOCKED_BY_REVIEW**(${row.intake.reason_code})`
      gate = 'strong=[] ⇒ 一行未写'
    } else if (row.intake) {
      intake = `${row.intake.code}(${row.intake.reason_code || '-'})`
      gate = '一行未写'
    } else {
      intake = '—'
    }
    rows.push(`| ${row.label} | \`${row.sha12}\` | ${row.ext.replace('.', '')} | ${read} | ${intake} | ${appId} | ${candId} | ${gate} |`)
  }
}

const table = [
  '| 文件 | sha256 前缀 | 格式 | document_read | intake 结果 | application_id | candidate_id | 身份闸门证据（字段名 + provenance） |',
  '|---|---|---|---|---|---|---|---|',
  ...rows,
].join('\n')
writeFileSync(join(HERE, 'table.md'), `${table}\n`, 'utf8')
console.log(`rows=${rows.length}`)
