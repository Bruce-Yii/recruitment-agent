// 前后差异归属（只读）：把 after 的 application 与 before 清单、本次 run 的 CREATED 清单对账。
// 目的：**证明哪些行是我这次新增的**，哪些是别的 lane 或既有行（避免把并行 lane 的写算到自己头上）。
// 用法：node evidence/experiments/2026-11-14-real-intake-20/attribute-diff.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const TENANT = '11111111-1111-4111-8111-000000000001'

const beforeIds = new Set(
  readFileSync(join(HERE, 'db-before.txt'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{"application_id"'))
    .map((line) => JSON.parse(line).application_id),
)

const createdIds = []
const myCandidateIds = new Set()
for (const file of ['results-probe1.json', 'results-pdfs.json', 'results-largest.json']) {
  const rows = JSON.parse(readFileSync(join(HERE, file), 'utf8'))
  for (const row of rows) {
    if (row.intake?.ok) {
      myCandidateIds.add(row.intake.candidate_id)
      if (row.intake.application_action === 'CREATED') createdIds.push(row.intake.application_id)
    }
  }
}

const pool = new pg.Pool({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password: process.env.RECRUITMENT_DB_PASSWORD, max: 1, application_name: 'real-intake-20-attribute',
})
const client = await pool.connect()
await client.query('begin transaction read only')
const { rows } = await client.query(
  `select id::text as application_id, candidate_id::text as candidate_id, created_at, lifecycle_status
     from recruitment.application where tenant_id = $1 order by created_at`, [TENANT])
await client.query('commit')
client.release()
await pool.end()

const createdSet = new Set(createdIds)
const lines = []
lines.push(`before_applications = ${beforeIds.size}`)
lines.push(`after_applications  = ${rows.length}`)
lines.push(`tool_reported_created = ${createdSet.size}`)
lines.push('')
lines.push('=== after 中不在 before 的行，按归属分类 ===')
for (const row of rows.filter((r) => !beforeIds.has(r.application_id))) {
  const mine = createdSet.has(row.application_id)
  // 单份探针 F20 首次调用建的行：其 CREATED 记录已被同文件幂等复跑覆盖成 REUSED，
  // 因此按 candidate 归属（该 candidate 只可能来自本次 F20 调用）。
  const mineByCandidate = !mine && myCandidateIds.has(row.candidate_id)
  const tag = mine ? 'MINE        ' : (mineByCandidate ? 'MINE_PROBE  ' : 'OTHER       ')
  lines.push(`${tag} ${row.application_id} ${row.created_at.toISOString()} ${row.lifecycle_status}`)
}
lines.push('')
lines.push('=== 工具报 CREATED 但不在 after 清单（应为 0） ===')
const afterSet = new Set(rows.map((r) => r.application_id))
for (const id of createdSet) if (!afterSet.has(id)) lines.push(`MISSING ${id}`)
lines.push(`missing = ${[...createdSet].filter((id) => !afterSet.has(id)).length}`)
console.log(lines.join('\n'))
