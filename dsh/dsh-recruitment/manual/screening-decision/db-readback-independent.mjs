// 独立的**只读**建库取证（不写任何业务表、不经过 harness 自己的读回代码）。
//
// 目的：harness 说"决策落库了"，还要有一个**不依赖 harness 逻辑**的旁证——直接 SQL 看库。
// 用法（PowerShell；仓库根 = recruitment-agent）：
//   $env:RECRUITMENT_DB_PASSWORD='<本机演示库密码，按约定注入，不落盘>'
//   node dsh/dsh-recruitment/manual/screening-decision/db-readback-independent.mjs [decision_id]
//
// 输出四段：
//   ① 本 lane 建的 REPRO-* 岗位上的 SCREENING 决策行；
//   ② 指定 decision_id 的整行（reason / basis_refs 都在）；
//   ③ 对应的内部事件（event_inbox 的 decision.record）；
//   ④ 同一申请 current SCREENING 决策的条数（唯一性）。
import pg from 'pg'

const password = process.env.RECRUITMENT_DB_PASSWORD
if (password === undefined || password === '') {
  console.error('RECRUITMENT_DB_PASSWORD is required')
  process.exit(2)
}
const TENANT = '11111111-1111-4111-8111-000000000001'
/** 默认看 FIRST_RUN 写进去的那条；也可以用 argv[2] 指定。 */
const DECISION_ID = process.argv[2] ?? '3742cde3-2448-4930-a203-e368a285291e'

const pool = new pg.Pool({
  host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
  user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
  database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
  password,
  max: 2,
  application_name: 'independent-readback',
})
const query = async (sql, params = []) => (await pool.query(sql, params)).rows

try {
  console.log('== ① 本 lane REPRO-* 岗位上的 SCREENING 决策 ==')
  console.log(JSON.stringify(await query(`
    select j.code as job_code,
           a.id as application_id,
           a.rubric_version_id,
           d.id as decision_id,
           d.decision_scope,
           d.stage_code,
           d.result,
           d.decided_by_actor_id,
           d.decided_at,
           d.record_version,
           d.superseded_by_decision_id,
           jsonb_array_length(d.basis_refs) as basis_ref_count,
           (select array_agg(distinct b->>'kind') from jsonb_array_elements(d.basis_refs) b) as basis_kinds
      from recruitment.job j
      join recruitment.application a on a.job_id = j.id and a.tenant_id = j.tenant_id
      left join recruitment.decision d on d.application_id = a.id and d.decision_scope = 'SCREENING'
     where j.tenant_id = $1 and j.code like 'REPRO-%'
     order by j.code, d.decided_at`, [TENANT]), null, 2))

  console.log('')
  console.log(`== ② decision 整行：${DECISION_ID} ==`)
  console.log(JSON.stringify(await query(
    'select * from recruitment.decision where tenant_id = $1 and id = $2', [TENANT, DECISION_ID]), null, 2))

  console.log('')
  console.log('== ③ 对应的内部事件（event_inbox / decision.record） ==')
  console.log(JSON.stringify(await query(`
    select event_id, event_type, trust_level, idempotency_key, idempotency_source, source_object_id,
           occurred_at,
           payload->>'human_confirmation_method' as confirmation_method,
           payload->>'human_confirmation_preimage_version' as preimage_version,
           payload->>'human_confirmation_text_sha256' as confirmation_text_sha256,
           payload->>'screening_evaluation_digest' as screening_evaluation_digest
      from recruitment.event_inbox
     where tenant_id = $1 and event_type = 'decision.record' and source_object_id = $2`, [TENANT, DECISION_ID]), null, 2))

  console.log('')
  console.log('== ④ 同一申请 current SCREENING 决策条数（唯一性） ==')
  console.log(JSON.stringify(await query(`
    select application_id, count(*)::int as current_screening_decisions
      from recruitment.decision
     where tenant_id = $1 and decision_scope = 'SCREENING' and superseded_by_decision_id is null
       and application_id = (select application_id from recruitment.decision where id = $2 and tenant_id = $1)
     group by 1`, [TENANT, DECISION_ID]), null, 2))
} finally {
  await pool.end()
}
