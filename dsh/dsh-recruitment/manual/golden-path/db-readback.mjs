// Golden Path 复跑 · **独立只读读回**（不 import 任何产品代码、不写任何行）。
//
// 用途：回答 R3 / E2 —— 复跑后，库里到底有哪些行？本脚本只发 SELECT：
//   * 申请（阶段码 / rubric pin / 材料版本 / record_version / stage_entered_at）
//   * 候选人（联系方式打码）
//   * 材料链（resume_version / intake_asset / 摄入事件）
//   * 决策（scope / stage / result / basis kinds / 人工确认哈希）
//   * 面试（interview / interviewer / meeting_binding / business_task）
//   * 转写（transcript_artifact / segment 数 / interview_record）
//   * 面评（scorecard，含 items.transcript_basis）
//   * 阶段 / pin 审计事件
//   * 全库行数与 both_bound 计数
//
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='<本机演示库密码>'
//   node manual/golden-path/db-readback.mjs <application_id>
//
// 安全（R7）：合成数据；输出里电话/邮箱一律打码；不打印任何转写正文。
import pg from 'pg'

const TENANT_ID = '11111111-1111-4111-8111-000000000001'
const applicationId = process.argv[2]
if (applicationId === undefined || !/^[0-9a-f-]{36}$/i.test(applicationId)) {
  console.error('usage: node manual/golden-path/db-readback.mjs <application_id-uuid>')
  process.exit(2)
}
const password = process.env.RECRUITMENT_DB_PASSWORD
if (password === undefined || password === '') {
  console.error('RECRUITMENT_DB_PASSWORD 未设置')
  process.exit(2)
}

const pool = new pg.Pool({
  host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
  user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
  database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
  password,
  max: 1,
  application_name: 'golden-path-db-readback',
})

const q = async (sql, params = []) => (await pool.query(sql, params)).rows
const section = (title) => {
  console.log('')
  console.log(`-- ${title} ` + '-'.repeat(Math.max(0, 74 - title.length)))
}
const dump = (rows) => {
  if (rows.length === 0) {
    console.log('(0 rows)')
    return
  }
  for (const row of rows) console.log(JSON.stringify(row))
}

try {
  console.log(`db-readback（只读） application_id=${applicationId}`)
  const server = (await q('select current_database() db, now()::text now, version() v'))[0]
  console.log(`database=${server.db} now=${server.now}`)
  console.log(`db_version=${server.v.split(' on ')[0]}`)

  section('1. application（阶段码 / rubric pin / 材料）')
  dump(await q(`
    select id, job_id, candidate_id, resume_version_id, rubric_version_id,
           lifecycle_status, current_stage_code, record_version,
           created_at::text, stage_entered_at::text, stage_changed_at::text, stage_changed_by_actor_id
      from recruitment.application where tenant_id = $1 and id = $2`, [TENANT_ID, applicationId]))

  section('2. candidate（联系方式打码）')
  dump(await q(`
    select c.id, c.identity_status, c.display_name,
           regexp_replace(c.normalized_email, '^(.{3}).*(@.*)$', '\\1***\\2') as email_masked,
           regexp_replace(c.normalized_phone, '^(\\+86\\d{3}).*(\\d{2})$', '\\1***\\2') as phone_masked
      from recruitment.candidate c
      join recruitment.application a on a.candidate_id = c.id and a.tenant_id = c.tenant_id
     where a.tenant_id = $1 and a.id = $2`, [TENANT_ID, applicationId]))

  section('3. 材料链（resume_version / intake_asset / 摄入事件）')
  dump(await q(`
    select rv.id as resume_version_id, rv.version_no, rv.parse_status,
           rv.content_sha256, rv.source_asset_sha256,
           ia.id as intake_asset_id, ia.file_name, ia.byte_size, ia.sha256 as asset_sha256,
           ia.validation_status
      from recruitment.application a
      join recruitment.resume_version rv on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
      join recruitment.resume r on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
      left join recruitment.intake_asset ia on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
     where a.tenant_id = $1 and a.id = $2`, [TENANT_ID, applicationId]))
  dump(await q(`
    select e.event_id, e.provider, e.trust_level, e.event_type, e.idempotency_source,
           e.source_object_id, e.occurred_at::text
      from recruitment.event_inbox e
     where e.tenant_id = $1
       and e.source_object_id = (select rv.source_asset_sha256
                                   from recruitment.application a join recruitment.resume_version rv
                                     on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
                                  where a.tenant_id = $1 and a.id = $2)
     order by e.recorded_at`, [TENANT_ID, applicationId]))

  section('4. decision（S7 SCREENING / S10 STAGE）')
  dump(await q(`
    select d.id, d.decision_scope, d.stage_code, d.result, d.interview_id,
           d.decided_by_actor_id, d.decided_at::text, d.record_version,
           jsonb_array_length(d.basis_refs) as basis_count,
           (select array_agg(distinct b->>'kind') from jsonb_array_elements(d.basis_refs) b) as basis_kinds,
           d.superseded_by_decision_id,
           e.payload->>'summary_digest' as decision_summary_digest,
           e.payload->>'human_confirmation_method' as confirmation_method,
           e.payload->>'human_confirmation_text_sha256' as confirmation_text_sha256,
           e.payload->>'human_confirmation_preimage_version' as confirmation_preimage_version,
           e.event_id as decision_event_id
      from recruitment.decision d
      left join recruitment.event_inbox e
        on e.tenant_id = d.tenant_id and e.source_object_id = d.id::text and e.event_type = 'decision.record'
     where d.tenant_id = $1 and d.application_id = $2
     order by d.decided_at`, [TENANT_ID, applicationId]))

  section('5. interview / interviewer / meeting_binding / business_task')
  dump(await q(`
    select i.id, i.round_no, i.slot_code, i.stage_code, i.status,
           i.scheduled_start_at::text, i.scheduled_end_at::text, i.timezone, i.record_version
      from recruitment.interview i
     where i.tenant_id = $1 and i.application_id = $2
     order by i.round_no`, [TENANT_ID, applicationId]))
  dump(await q(`
    select iv.interview_id, iv.actor_id, a.display_name, iv.role_in_interview, iv.required_scorecard
      from recruitment.interviewer iv
      join recruitment.actor a on a.id = iv.actor_id and a.tenant_id = iv.tenant_id
     where iv.tenant_id = $1
       and iv.interview_id in (select id from recruitment.interview where tenant_id = $1 and application_id = $2)
     order by iv.created_at`, [TENANT_ID, applicationId]))
  dump(await q(`
    select b.interview_id, b.meeting_id, m.provider, m.account_scope, m.external_meeting_id,
           m.calendar_event_id, b.binding_method, b.bound_at::text, b.unbound_at::text
      from recruitment.meeting_binding b
      join recruitment.meeting m on m.id = b.meeting_id and m.tenant_id = b.tenant_id
     where b.tenant_id = $1
       and b.interview_id in (select id from recruitment.interview where tenant_id = $1 and application_id = $2)
     order by b.bound_at`, [TENANT_ID, applicationId]))
  dump(await q(`
    select bt.id, bt.task_type, bt.status,
           bt.business_refs->0->>'kind' as ref0_kind, bt.business_refs->0->>'id' as ref0_id
      from recruitment.business_task bt
     where bt.tenant_id = $1
       and bt.business_refs->0->>'kind' = 'INTERVIEW'
       and bt.business_refs->0->>'id' in (
         select i.id::text from recruitment.interview i
          where i.tenant_id = $1 and i.application_id = $2)
     order by bt.created_at`, [TENANT_ID, applicationId]))

  section('6. 转写（transcript_artifact / segments / interview_record）')
  dump(await q(`
    select ta.id, ta.source_revision, ta.is_canonical, ta.provenance, ta.trigger_mode,
           ta.connection_state, ta.transcript_status, ta.content_sha256, ta.provider, ta.provider_artifact_id,
           (select count(*)::int from recruitment.transcript_segment ts
             where ts.tenant_id = ta.tenant_id and ts.artifact_id = ta.id) as segment_count
      from recruitment.transcript_artifact ta
     where ta.tenant_id = $1
       and ta.meeting_id in (
         select b.meeting_id from recruitment.meeting_binding b
          where b.tenant_id = $1
            and b.interview_id in (select id from recruitment.interview where tenant_id = $1 and application_id = $2))
     order by ta.source_revision`, [TENANT_ID, applicationId]))
  dump(await q(`
    select r.id, r.interview_id, r.transcript_artifact_id, r.transcript_revision,
           r.status, r.verification_status, r.evidence_ok, r.is_current
      from recruitment.interview_record r
     where r.tenant_id = $1
       and r.interview_id in (select id from recruitment.interview where tenant_id = $1 and application_id = $2)
     order by r.created_at`, [TENANT_ID, applicationId]))

  section('7. scorecard（含 items.transcript_basis）')
  dump(await q(`
    select s.id, s.interview_id, s.interviewer_id, s.rubric_version_id, s.status, s.overall,
           s.revision_no, s.record_version, s.payload_hash, s.items->>'transcript_basis' as transcript_basis,
           s.status_changed_by_actor_id
      from recruitment.scorecard s
     where s.tenant_id = $1
       and s.interview_id in (select id from recruitment.interview where tenant_id = $1 and application_id = $2)
     order by s.created_at`, [TENANT_ID, applicationId]))

  section('8. 阶段 / pin 审计事件（fn_row_guard 写的真实迁移）')
  dump(await q(`
    select event_id, event_type, source_object_id, occurred_at::text,
           payload->>'from' as from_stage, payload->>'to' as to_stage,
           payload->>'actor_id' as actor_id
      from recruitment.event_inbox
     where tenant_id = $1 and source_object_id = $2
       and event_type in ('application.current_stage_code.changed', 'application.rubric_version.pinned')
     order by recorded_at`, [TENANT_ID, applicationId]))

  section('9. 全库计数（预检 / 终态对比口径）')
  dump(await q(`
    select count(*)::int as applications,
           count(*) filter (where resume_version_id is not null)::int as with_material,
           count(*) filter (where rubric_version_id is not null)::int as with_rubric,
           count(*) filter (where resume_version_id is not null and rubric_version_id is not null)::int as both_bound
      from recruitment.application where tenant_id = $1`, [TENANT_ID]))
  dump(await q(`
    select decision_scope, stage_code, count(*)::int as n
      from recruitment.decision where tenant_id = $1
     group by 1, 2 order by 1, 2`, [TENANT_ID]))
} catch (error) {
  console.error(`[db-readback] FAILED：${String(error?.message ?? error)}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
