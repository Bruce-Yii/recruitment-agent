// 只读核对：把「39 条 application / 多少条停在 S6」这个口径拆开，便于对账。
import pg from 'pg'
const pool = new pg.Pool({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password: process.env.RECRUITMENT_DB_PASSWORD, max: 1,
})
const client = await pool.connect()
await client.query('begin transaction read only')
const TENANT = '11111111-1111-4111-8111-000000000001'
const stage = await client.query(`
  select current_stage_code, lifecycle_status, count(*)::int as n
  from recruitment.application where tenant_id = $1
  group by 1, 2 order by 1, 2`, [TENANT])
console.log('=== application by stage / lifecycle ===')
for (const row of stage.rows) console.log(JSON.stringify(row))

const withVersion = await client.query(`
  select count(*)::int as n from recruitment.application where tenant_id = $1 and resume_version_id is not null`, [TENANT])
console.log('\napplications_with_resume_version =', withVersion.rows[0].n)

const mine = await client.query(`
  select count(*)::int as n
  from recruitment.application a
  join recruitment.resume_version rv on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
  where a.tenant_id = $1 and a.created_at > '2026-11-14T08:54:00Z'`, [TENANT])
console.log('applications_created_in_this_run =', mine.rows[0].n)

await client.query('commit')
client.release()
await pool.end()
