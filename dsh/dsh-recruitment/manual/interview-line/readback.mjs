// S8 DB 读回（验收 #3）：面试 / 面试官 / 会议 / 会议绑定 / 业务任务，逐表打印真实行。
//
// 用法（在 dsh/dsh-recruitment 下）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/interview-line/readback.mjs --interview <interview_id>
//   node manual/interview-line/readback.mjs --application <application_id>
// 不打印任何密码；只读。
import pg from 'pg'

const password = process.env.RECRUITMENT_DB_PASSWORD
if (!password) {
  console.error('FATAL: RECRUITMENT_DB_PASSWORD is not set')
  process.exit(2)
}

const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : undefined
}
const interviewId = option('--interview')
const applicationId = option('--application')
if (interviewId === undefined && applicationId === undefined) {
  console.error('usage: readback.mjs --interview <uuid> | --application <uuid>')
  process.exit(2)
}

const pool = new pg.Pool({
  host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
  user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
  password,
  database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
  max: 1,
})

const iso = (value) => (value instanceof Date ? value.toISOString() : value)

function line(label, value) {
  console.log(`${label}: ${value}`)
}

try {
  const where = interviewId !== undefined
    ? { sql: 'i.id = $1', params: [interviewId] }
    : { sql: 'i.application_id = $1', params: [applicationId] }

  const { rows: interviews } = await pool.query(
    `select i.id, i.application_id, i.tenant_id, i.round_no, i.slot_code, i.stage_code, i.status,
            i.scheduled_start_at, i.scheduled_end_at, i.timezone, i.record_version,
            i.status_changed_at, i.status_changed_by_actor_id, i.created_at,
            a.candidate_id, a.job_id, a.lifecycle_status, a.record_version as application_record_version
       from recruitment.interview i
       join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
      where ${where.sql}
      order by i.round_no, i.slot_code`, where.params)
  line('INTERVIEW_COUNT', interviews.length)
  for (const row of interviews) {
    console.log('--- interview ---')
    for (const [key, value] of Object.entries(row)) line(`  ${key}`, iso(value))

    const { rows: interviewers } = await pool.query(
      `select r.id as interviewer_id, r.actor_id, act.display_name, act.kind,
              r.role_in_interview, r.required_scorecard, r.scorecard_due_at
         from recruitment.interviewer r
         join recruitment.actor act on act.id = r.actor_id and act.tenant_id = r.tenant_id
        where r.interview_id = $1
        order by r.actor_id`, [row.id])
    line('  INTERVIEWER_COUNT', interviewers.length)
    for (const interviewer of interviewers) {
      console.log('  --- interviewer ---')
      for (const [key, value] of Object.entries(interviewer)) line(`    ${key}`, iso(value))
    }

    const { rows: bindings } = await pool.query(
      `select b.id as binding_id, b.binding_method, b.bound_by_actor_id, b.bound_at,
              b.unbound_at, b.unbound_reason,
              m.id as meeting_id, m.provider, m.account_scope, m.external_meeting_id,
              m.calendar_event_id, m.meeting_role, m.actual_start_at, m.actual_end_at
         from recruitment.meeting_binding b
         join recruitment.meeting m on m.id = b.meeting_id and m.tenant_id = b.tenant_id
        where b.interview_id = $1
        order by b.bound_at`, [row.id])
    line('  BINDING_COUNT', bindings.length)
    for (const binding of bindings) {
      console.log('  --- meeting_binding ---')
      for (const [key, value] of Object.entries(binding)) line(`    ${key}`, iso(value))
    }

    const { rows: tasks } = await pool.query(
      `select id, task_type, status, idempotency_key, business_refs, due_at, completed_at, created_at
         from recruitment.business_task
        where tenant_id = $1
          and (business_refs @> jsonb_build_array(jsonb_build_object('kind', 'INTERVIEW', 'id', $2::text))
               or idempotency_key = 'bind_meeting:' || $2::text)
        order by created_at`, [row.tenant_id, row.id])
    line('  BUSINESS_TASK_COUNT', tasks.length)
    for (const task of tasks) {
      console.log('  --- business_task ---')
      for (const [key, value] of Object.entries(task)) {
        line(`    ${key}`, key === 'business_refs' ? JSON.stringify(value) : iso(value))
      }
    }
  }
} finally {
  await pool.end()
}
