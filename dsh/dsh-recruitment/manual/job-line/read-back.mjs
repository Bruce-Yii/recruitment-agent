// 读回取证：`recruitment_job_get` 的 render + value，再加打码后的 SQL 行。
//
// 为什么要两层：工具输出证明"模型看到的世界"，SQL 行证明"库里真的存在"。
// 两者都打出来，才能排除"render 自己编了一段"的可能。
//
// 用法（PowerShell，在 dsh/dsh-recruitment 下）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/job-line/read-back.mjs <job_id>
//
// 打码规则：uuid 只留前 8 位 + `…`（SPEC §9.3）。payload_hash 不是 uuid，保留全量
// （它是对内容的 sha256，不是个资）。脚本只 SELECT，不写库。
import { createJobGetTool } from '../../src/tools/job-get.ts'
import { closePool, createPool, resolveDatabaseConfig } from '../../src/db/pool.ts'

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

const jobId = process.argv[2]
if (jobId === undefined) {
  console.error('usage: node manual/job-line/read-back.mjs <job_id>')
  process.exit(2)
}

/** uuid（或 null）→ 前 8 位 + `…`。 */
function mask(value) {
  if (value === null || value === undefined) return null
  const text = String(value)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text) ? `${text.slice(0, 8)}…` : text
}

/** 一行里的 uuid 列打码，其余列原样（时间转 ISO）。 */
function maskRow(row) {
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString()
      : key.endsWith('_id') ? mask(value)
        : value
  }
  return out
}

const tool = createJobGetTool(database.resolved)
const args = { job_id: jobId }

let value
try {
  value = await tool.execute(args, { signal: new AbortController().signal })
} catch (error) {
  console.error(`Error: ${error?.message ?? String(error)}`)
  process.exit(1)
}

const render = tool.output.render(args, value).map((block) => block.text).join('\n')
console.log('=== recruitment_job_get render ===')
console.log(render)
console.log('')
console.log('=== recruitment_job_get value (JSON) ===')
console.log(JSON.stringify(value, null, 2))

// 第二层：直接读库。工具自己开短连接，读完后这里再开一个只读连接。
const pool = createPool(database.resolved)
try {
  const client = await pool.connect()
  try {
    await client.query('begin transaction read only')
    const job = await client.query(
      `select id, tenant_id, department_id, code, title, status, requisition_id,
              current_job_version_id, record_version, status_changed_at
         from recruitment.job where id = $1`,
      [jobId],
    )
    const jobVersions = await client.query(
      `select id, job_id, version_no, payload_hash, description_md, requirements_md,
              approved_by_approval_id, created_by_actor_id, created_at
         from recruitment.job_version where job_id = $1 order by version_no`,
      [jobId],
    )
    const rubrics = await client.query(
      `select id, job_id, version_no, payload_hash, dimensions, approved_by_approval_id,
              created_by_actor_id, created_at
         from recruitment.rubric_version where job_id = $1 order by version_no`,
      [jobId],
    )
    const approvals = await client.query(
      `select a.id, a.resource_type, a.resource_id, a.resource_record_version,
              a.payload_schema_version, a.canonical_payload_hash, a.status,
              a.requested_by_actor_id, a.decision_by_actor_id, a.decided_at, a.reason,
              a.record_version
         from recruitment.approval a
         join recruitment.rubric_version r on r.id = a.resource_id and r.tenant_id = a.tenant_id
        where r.job_id = $1 order by a.created_at, a.id`,
      [jobId],
    )
    await client.query('commit')

    const section = (label, rows) => {
      console.log('')
      console.log(`=== SQL ${label} (${rows.length} row(s), uuid masked) ===`)
      for (const row of rows) console.log(JSON.stringify(maskRow(row)))
    }
    section('recruitment.job', job.rows)
    section('recruitment.job_version', jobVersions.rows)
    section('recruitment.rubric_version', rubrics.rows)
    section('recruitment.approval', approvals.rows)
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      // 保留第一个错误。
    }
    throw error
  } finally {
    client.release()
  }
} catch (error) {
  console.error(`Error: ${error?.message ?? String(error)}`)
  process.exit(1)
} finally {
  await closePool(pool)
}
