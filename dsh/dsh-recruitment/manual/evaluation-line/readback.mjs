// S10 评价线 · DB readback（取证脚本，不是产品运行时）。
//
// 只读：不 INSERT/UPDATE/DELETE。把演示链路上的真实行打印成证据文件。
// 用法：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/evaluation-line/readback.mjs --label after-decision
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const at = argv.indexOf('--label')
const label = at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : `readback-${Date.now()}`

const password = process.env.RECRUITMENT_DB_PASSWORD
if (password === undefined || password === '') {
  console.error('需要环境变量 RECRUITMENT_DB_PASSWORD')
  process.exit(2)
}

const TENANT = '11111111-1111-4111-8111-000000000001'
const APPLICATION = '11111111-1111-4111-8111-000000000701'
const INTERVIEW = '11111111-1111-4111-8111-000000000801'

const SCORECARD_ROWS = `
    select s.id, s.revision_no, s.status, s.overall,
           s.interview_id, s.interviewer_id, i.actor_id as interviewer_actor_id,
           a.kind as interviewer_kind, a.display_name as interviewer_name,
           s.rubric_version_id, rv.version_no as rubric_version_no, rv.job_id as rubric_job_id,
           s.submitted_at, s.payload_hash,
           s.status_changed_by_actor_id, s.status_source_event_id,
           (select count(*) from recruitment.event_inbox e where e.event_id = s.status_source_event_id) as source_event_rows,
           s.superseded_by_scorecard_id, s.record_version,
           (select string_agg(k, ',' order by k) from jsonb_object_keys(s.items) k) as item_keys
    from recruitment.scorecard s
    join recruitment.interviewer i on i.id = s.interviewer_id and i.tenant_id = s.tenant_id
    join recruitment.actor a on a.id = i.actor_id and a.tenant_id = i.tenant_id
    join recruitment.rubric_version rv on rv.id = s.rubric_version_id and rv.tenant_id = s.tenant_id
    where s.tenant_id = $1 and s.interview_id = $2
    order by s.interviewer_id, s.revision_no, s.id`

const SCORECARD_AGG = `
    select interviewer_id, count(*) as rows,
           count(*) filter (where superseded_by_scorecard_id is null) as current_rows,
           count(distinct revision_no) as revisions,
           min(submitted_at) as first_submitted_at, max(submitted_at) as last_submitted_at
    from recruitment.scorecard
    where tenant_id = $1 and interview_id = $2
    group by interviewer_id order by interviewer_id`

const DECISION_ROWS = `
    select d.id, d.application_id, d.interview_id, d.decision_scope, d.stage_code, d.result,
           d.decided_by_actor_id, a.kind as decider_kind, a.display_name as decider_name,
           d.decided_at, d.record_version, d.superseded_by_decision_id,
           d.approval_id, jsonb_array_length(d.basis_refs) as basis_refs_count,
           (select string_agg(distinct x->>'kind', ',' order by x->>'kind')
              from jsonb_array_elements(d.basis_refs) x) as basis_kinds,
           left(d.reason, 120) as reason_head
    from recruitment.decision d
    join recruitment.actor a on a.id = d.decided_by_actor_id and a.tenant_id = d.tenant_id
    where d.tenant_id = $1 and d.application_id = $2
    order by d.decided_at, d.id`

const DECISION_EVENTS = `
    select e.event_id, e.provider, e.event_type, e.trust_level, e.idempotency_key,
           e.idempotency_source, e.source_object_id, e.provider_event_id, e.recorded_at
    from recruitment.event_inbox e
    where e.tenant_id = $1
      and e.source_object_id in (select d.id::text from recruitment.decision d
                                  where d.tenant_id = $1 and d.application_id = $2)
    order by e.recorded_at`

const SCORECARD_EVENTS = `
    select e.event_id, e.event_type, e.idempotency_key, e.idempotency_source,
           e.source_object_id, e.payload->>'payload_hash' as payload_hash, e.recorded_at
    from recruitment.event_inbox e
    where e.tenant_id = $1 and e.event_type = 'scorecard.submit'
    order by e.recorded_at`

const INTERVIEW_ROWS = `
    select i.id as interview_id, i.round_no, i.slot_code, i.status, i.scheduled_start_at,
           w.actor_id, a.kind, w.role_in_interview, w.required_scorecard, w.scorecard_due_at
    from recruitment.interview i
    left join recruitment.interviewer w on w.interview_id = i.id and w.tenant_id = i.tenant_id
    left join recruitment.actor a on a.id = w.actor_id and a.tenant_id = w.tenant_id
    where i.tenant_id = $1 and i.id = $2
    order by w.actor_id`

/** [标题, SQL, 第二参数] */
const QUERIES = [
  ['scorecard（该场面试的全部行，含修订链）', SCORECARD_ROWS, INTERVIEW],
  ['scorecard 聚合（行数 / current 行数 / 修订数）', SCORECARD_AGG, INTERVIEW],
  ['decision（该申请全部行）', DECISION_ROWS, APPLICATION],
  ['decision 内部事件（provider=internal）', DECISION_EVENTS, APPLICATION],
  ['面评提交的内部事件（event_type=scorecard.submit）', SCORECARD_EVENTS, null],
  ['interview / interviewer（S8 侧夹具，只读核对）', INTERVIEW_ROWS, INTERVIEW],
]

const pool = new pg.Pool({
  host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
  user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
  database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
  password, max: 2, application_name: 'evaluation-line-readback',
})

const lines = []
const client = await pool.connect()
try {
  await client.query('begin transaction read only')
  for (const [title, sql, secondParam] of QUERIES) {
    const params = secondParam === null ? [TENANT] : [TENANT, secondParam]
    const { rows } = await client.query(sql, params)
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
const evidenceDir = join(HERE, 'evidence', label)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(join(evidenceDir, 'db-readback.txt'), `${text}\n`, 'utf8')
console.log(text)
