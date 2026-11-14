-- Golden Path 端到端 · 终态 DB 读回（官方 run A：application 9d408044-e30c-42be-9c7a-bd6dda78456c）
-- 全部只读；不含任何真实候选人数据（候选人/电话/邮箱都是合成示例值，输出里已打码）。
\pset pager off
\echo '===== 1. 申请（阶段 / 材料 / rubric pin / record_version） ====='
select id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
       lifecycle_status, current_stage_code, record_version, created_at
  from recruitment.application
 where id = '9d408044-e30c-42be-9c7a-bd6dda78456c';

\echo '===== 2. 候选人（联系方式打码） ====='
select id, display_name, identity_status,
       regexp_replace(normalized_email, '^(.{3}).*(@.*)$', '\1***\2') as email_masked,
       regexp_replace(normalized_phone, '^(\+86\d{3}).*(\d{2})$', '\1***\2') as phone_masked,
       record_version, created_at
  from recruitment.candidate
 where id = '96485f3c-0e73-43e8-89c3-7d87bb53f9cd';

\echo '===== 3. 材料链：intake_asset / resume / resume_version ====='
select a.id as intake_asset_id, a.file_name, a.byte_size, a.sha256, a.validation_status, a.intake_record_id,
       r.id as resume_id, rv.id as resume_version_id, rv.version_no, rv.parse_status,
       rv.source_asset_sha256, rv.content_sha256
  from recruitment.intake_asset a
  join recruitment.resume r on r.intake_asset_id = a.id and r.tenant_id = a.tenant_id
  join recruitment.resume_version rv on rv.resume_id = r.id and rv.tenant_id = r.tenant_id
 where a.tenant_id = '11111111-1111-4111-8111-000000000001'
   and a.id = (select r2.intake_asset_id from recruitment.resume r2 where r2.id =
       (select rv2.resume_id from recruitment.resume_version rv2 where rv2.id =
          (select resume_version_id from recruitment.application where id = '9d408044-e30c-42be-9c7a-bd6dda78456c')));

\echo '===== 4. 材料摄入事件 event_inbox ====='
select event_id, provider, trust_level, event_type, idempotency_source, idempotency_key,
       source_object_id, occurred_at
  from recruitment.event_inbox
 where tenant_id = '11111111-1111-4111-8111-000000000001'
   and idempotency_key = 'resume.intake:9754a77f11b4b9733f9a5072340a078b066ad86896ea9568b975de4aa6ff2356';

\echo '===== 5. decision（本申请 = 0 条；全库按 scope） ====='
select id, decision_scope, stage_code, result, decided_by_actor_id, decided_at
  from recruitment.decision
 where application_id = '9d408044-e30c-42be-9c7a-bd6dda78456c';
select decision_scope, stage_code, count(*) as n from recruitment.decision group by 1, 2 order by 1, 2;

\echo '===== 6. 面试 + 面试官 + 会议绑定 ====='
select i.id, i.application_id, i.round_no, i.slot_code, i.stage_code, i.status,
       i.scheduled_start_at, i.scheduled_end_at, i.timezone, i.record_version
  from recruitment.interview i where i.id = '6efc6919-0d63-4f80-847c-4813c6b5a475';
select i.actor_id, a.display_name, i.role_in_interview, i.required_scorecard
  from recruitment.interviewer i join recruitment.actor a on a.id = i.actor_id and a.tenant_id = i.tenant_id
 where i.interview_id = '6efc6919-0d63-4f80-847c-4813c6b5a475';
select b.id as binding_id, m.provider, m.account_scope, m.external_meeting_id, m.calendar_event_id,
       b.binding_method, b.bound_at, b.unbound_at
  from recruitment.meeting_binding b join recruitment.meeting m on m.id = b.meeting_id and m.tenant_id = b.tenant_id
 where b.interview_id = '6efc6919-0d63-4f80-847c-4813c6b5a475';

\echo '===== 7. S8 附带产物 business_task ====='
select id, task_type, status, business_refs
  from recruitment.business_task
 where business_refs @> '[{"kind":"INTERVIEW","id":"6efc6919-0d63-4f80-847c-4813c6b5a475"}]'::jsonb;

\echo '===== 8. transcript_artifact（canonical / revision / 标签） + 片段数 ====='
select a.id, a.source_revision, a.is_canonical, a.provenance, a.trigger_mode, a.connection_state,
       a.transcript_status, a.provider, a.provider_artifact_id, a.content_sha256, a.is_complete
  from recruitment.transcript_artifact a
 where a.meeting_id = (select meeting_id from recruitment.meeting_binding
                        where interview_id = '6efc6919-0d63-4f80-847c-4813c6b5a475' and unbound_at is null);
select count(*) as segment_count from recruitment.transcript_segment
 where artifact_id in (select id from recruitment.transcript_artifact a
                        where a.meeting_id = (select meeting_id from recruitment.meeting_binding
                          where interview_id = '6efc6919-0d63-4f80-847c-4813c6b5a475' and unbound_at is null));

\echo '===== 9. scorecard（面试官本人 / rubric / payload_hash） ====='
select id, interview_id, interviewer_id, rubric_version_id, revision_no, status, overall,
       payload_hash, record_version, submitted_at
  from recruitment.scorecard
 where interview_id = '6efc6919-0d63-4f80-847c-4813c6b5a475';

\echo '===== 10. 全库关键计数（both_bound 仍是 0：没有一条申请同时有材料与 rubric pin） ====='
select count(*) as applications,
       count(*) filter (where resume_version_id is not null) as with_material,
       count(*) filter (where rubric_version_id is not null) as with_rubric,
       count(*) filter (where resume_version_id is not null and rubric_version_id is not null) as both_bound
  from recruitment.application;

\echo '===== 11. 本 lane 试跑残留（合成候选人；官方申请是 9d408044，其余是 harness 迭代残留） ====='
select c.id as candidate_id,
       regexp_replace(c.normalized_email, '^(.{3}).*(@.*)$', '\1***\2') as email_masked,
       a.id as application_id, a.current_stage_code, a.lifecycle_status,
       (a.resume_version_id is not null) as has_material,
       (a.rubric_version_id is not null) as has_rubric,
       (select count(*) from recruitment.interview i where i.application_id = a.id) as interviews,
       (select count(*) from recruitment.decision d where d.application_id = a.id) as decisions
  from recruitment.candidate c
  left join recruitment.application a on a.candidate_id = c.id and a.tenant_id = c.tenant_id
 where c.normalized_email like 'lin.chengyu.gp%'
 order by c.created_at;
