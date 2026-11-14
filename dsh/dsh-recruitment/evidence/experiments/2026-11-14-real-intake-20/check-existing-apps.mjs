// 只读核对：本次是否有**既有申请**被工具改动（append 版本 / 指针变化），如实记录。
import pg from 'pg'
const pool = new pg.Pool({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password: process.env.RECRUITMENT_DB_PASSWORD, max: 1,
})
const client = await pool.connect()
await client.query('begin transaction read only')
const apps = await client.query(`
  select a.id::text as application_id, a.candidate_id::text as candidate_id,
         a.resume_version_id::text as current_resume_version_id, a.lifecycle_status,
         a.created_at, a.updated_at, a.record_version
  from recruitment.application a
  where a.tenant_id = $1 and a.id in (
    '00d0f6c0-c7b0-4e62-be62-ae7f0c6ea0bc', 'bc2f582b-6b38-48fa-900e-8ffa568f503c')
  order by a.created_at`, ['11111111-1111-4111-8111-000000000001'])
for (const row of apps.rows) console.log(JSON.stringify(row))
const chains = await client.query(`
  select rv.id::text as resume_version_id, rv.resume_id::text as resume_id, rv.version_no,
         left(rv.source_asset_sha256, 12) as sha12, rv.parser_name, rv.parse_status,
         rv.created_at,
         (rv.parsed_fields ? 'structured') as has_structured
  from recruitment.resume_version rv
  where rv.tenant_id = $1
    and rv.resume_id in (select r.resume_id from recruitment.application a join recruitment.resume_version r on r.id = a.resume_version_id where a.id in ('00d0f6c0-c7b0-4e62-be62-ae7f0c6ea0bc','bc2f582b-6b38-48fa-900e-8ffa568f503c'))
  order by rv.created_at`, ['11111111-1111-4111-8111-000000000001'])
console.log('--- versions on those chains ---')
for (const row of chains.rows) console.log(JSON.stringify(row))
await client.query('commit')
client.release()
await pool.end()
