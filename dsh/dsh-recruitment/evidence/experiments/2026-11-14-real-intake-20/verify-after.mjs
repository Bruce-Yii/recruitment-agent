// 验收读回（取证脚本，不是产品运行时）：只读，校验"真实语料申请"到底进了多少。
//
// 关键点：**入库真实语料的计数不靠自述**——把语料目录里每个文件的 sha256 与库里
// `resume_version.source_asset_sha256` 对上，才算"这份真实简历进了库"。
// 输出不含姓名/电话/邮箱（R7）。
//
// 用法：$env:RECRUITMENT_DB_PASSWORD='123456'
//       node evidence/experiments/2026-11-14-real-intake-20/verify-after.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const TENANT = '11111111-1111-4111-8111-000000000001'
const CORPUS_MAP = join(tmpdir(), 'recruitment-real-intake-20', 'corpus-paths.json')
const CORPUS_SHAS = new Map(
  JSON.parse(readFileSync(CORPUS_MAP, 'utf8'))
    .map((row) => [String(row.sha256).toLowerCase(), row.label]),
)

const pool = new pg.Pool({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password: process.env.RECRUITMENT_DB_PASSWORD, max: 2, application_name: 'real-intake-20-verify',
})
const client = await pool.connect()
const lines = []
try {
  await client.query('begin transaction read only')

  const counts = await client.query(`
    select 'application' as t, count(*)::int as n from recruitment.application where tenant_id = $1
    union all select 'application(ACTIVE)', count(*)::int from recruitment.application where tenant_id = $1 and lifecycle_status = 'ACTIVE'
    union all select 'candidate', count(*)::int from recruitment.candidate where tenant_id = $1
    union all select 'candidate(ACTIVE)', count(*)::int from recruitment.candidate where tenant_id = $1 and identity_status = 'ACTIVE'
    union all select 'resume', count(*)::int from recruitment.resume where tenant_id = $1
    union all select 'resume_version', count(*)::int from recruitment.resume_version where tenant_id = $1
    union all select 'intake_record', count(*)::int from recruitment.intake_record where tenant_id = $1
    union all select 'intake_asset', count(*)::int from recruitment.intake_asset where tenant_id = $1
    order by t`, [TENANT])
  lines.push('=== 计数（本租户） ===')
  for (const row of counts.rows) lines.push(`${row.t} = ${row.n}`)

  const apps = await client.query(`
    select a.id::text as application_id, a.lifecycle_status, a.candidate_id::text as candidate_id,
           a.job_id::text as job_id, rv.id::text as resume_version_id, rv.version_no,
           lower(rv.source_asset_sha256) as source_sha256, rv.parse_status, a.created_at
    from recruitment.application a
    join recruitment.resume_version rv on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
    where a.tenant_id = $1
    order by a.created_at, a.id`, [TENANT])

  const corpusApps = apps.rows.filter((row) => CORPUS_SHAS.has(row.source_sha256))
  lines.push('')
  lines.push('=== 真实语料申请（source_asset_sha256 命中语料目录 sha256） ===')
  lines.push(`matched_applications = ${corpusApps.length}`)
  const byLabel = new Map()
  for (const row of corpusApps) {
    const label = CORPUS_SHAS.get(row.source_sha256)
    const key = `${label}|${row.application_id}`
    if (!byLabel.has(key)) byLabel.set(key, { label, ...row })
  }
  for (const row of [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    lines.push(`${row.label} sha=${row.source_sha256.slice(0, 12)} application=${row.application_id} `
      + `candidate=${row.candidate_id} resume_version=${row.resume_version_id} v${row.version_no} `
      + `parse=${row.parse_status} lifecycle=${row.lifecycle_status}`)
  }
  lines.push('')
  lines.push(`distinct_real_labels_in_db = ${new Set(corpusApps.map((r) => CORPUS_SHAS.get(r.source_sha256))).size}`)
  lines.push(`distinct_real_applications = ${new Set(corpusApps.map((r) => r.application_id)).size}`)
  lines.push(`corpus_applications_ACTIVE = ${corpusApps.filter((r) => r.lifecycle_status === 'ACTIVE').length}`)

  await client.query('commit')
} finally {
  client.release()
  await pool.end()
}
console.log(lines.join('\n'))
