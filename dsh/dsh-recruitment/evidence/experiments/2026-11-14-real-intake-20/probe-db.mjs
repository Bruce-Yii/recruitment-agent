// 摸底 / 验收用只读探针（取证脚本，不是产品运行时）。
//
// 只读：`begin transaction read only`，不 INSERT/UPDATE/DELETE。
// 输出**不含**候选人姓名、电话、邮箱（R7）：只给 id、sha256 前缀、计数、状态、脱敏标签。
//
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node evidence/experiments/2026-11-14-real-intake-20/probe-db.mjs before|after
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const label = process.argv[2] ?? 'probe'

const password = process.env.RECRUITMENT_DB_PASSWORD
if (password === undefined || password === '') {
  console.error('需要环境变量 RECRUITMENT_DB_PASSWORD')
  process.exit(2)
}
const TENANT = '11111111-1111-4111-8111-000000000001'

const pool = new pg.Pool({
  host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
  user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
  database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
  password,
  max: 2,
  application_name: 'real-intake-20-probe',
})

const QUERIES = [
  ['各表行数（本租户）', `
    select 'application' as t, count(*)::int as n from recruitment.application where tenant_id = $1
    union all select 'application(ACTIVE)', count(*)::int from recruitment.application where tenant_id = $1 and lifecycle_status = 'ACTIVE'
    union all select 'candidate', count(*)::int from recruitment.candidate where tenant_id = $1
    union all select 'candidate(ACTIVE)', count(*)::int from recruitment.candidate where tenant_id = $1 and identity_status = 'ACTIVE'
    union all select 'resume', count(*)::int from recruitment.resume where tenant_id = $1
    union all select 'resume_version', count(*)::int from recruitment.resume_version where tenant_id = $1
    union all select 'intake_record', count(*)::int from recruitment.intake_record where tenant_id = $1
    union all select 'intake_asset', count(*)::int from recruitment.intake_asset where tenant_id = $1
    order by t`],
  ['application 清单（不含 PII：只给 id / 状态 / sha 前缀）', `
    select a.id::text as application_id,
           a.lifecycle_status,
           a.candidate_id::text as candidate_id,
           a.job_id::text as job_id,
           a.resume_version_id::text as resume_version_id,
           rv.version_no,
           left(coalesce(rv.source_asset_sha256, rv.content_sha256), 12) as sha12,
           rv.parse_status,
           ia.id::text as intake_asset_id,
           a.created_at
    from recruitment.application a
    left join recruitment.resume_version rv
      on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
    left join recruitment.resume r
      on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
    left join recruitment.intake_asset ia
      on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
    where a.tenant_id = $1
    order by a.created_at, a.id`],
  ['intake_asset 清单（sha 前缀 / 大小 / 校验状态）', `
    select id::text as intake_asset_id,
           left(sha256, 12) as sha12,
           mime_type, byte_size, validation_status,
           created_at
    from recruitment.intake_asset
    where tenant_id = $1
    order by created_at, id`],
  ['job 清单（只读，供 intake 选择目标）', `
    select id::text as job_id, code, title, status, created_at
    from recruitment.job
    where tenant_id = $1
    order by created_at, id`],
]

const lines = []
const client = await pool.connect()
try {
  await client.query('begin transaction read only')
  for (const [title, sql] of QUERIES) {
    const { rows } = await client.query(sql, [TENANT])
    lines.push(`=== ${title} ===`)
    lines.push(`rows=${rows.length}`)
    for (const row of rows) lines.push(JSON.stringify(row))
    lines.push('')
  }
  await client.query('commit')
} finally {
  client.release()
  await pool.end()
}

const text = lines.join('\n')
mkdirSync(HERE, { recursive: true })
writeFileSync(join(HERE, `db-${label}.txt`), `${text}\n`, 'utf8')
console.log(text)
