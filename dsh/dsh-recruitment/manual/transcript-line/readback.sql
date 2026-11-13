-- S9 线 1 · DB readback（可直接用 psql 复核；只读）
--
-- 用法（PowerShell）：
--   $env:PGPASSWORD='123456'; $env:PGCLIENTENCODING='UTF8'
--   $psql='D:\12412\PostgreSQL\bin\psql.exe'
--   & $psql -U postgres -h 127.0.0.1 -d ra_s6s7 -v ON_ERROR_STOP=1 -f manual/transcript-line/readback.sql
--
-- 口径：
--   * 演示链路 = job.code 'S9-TR-DEMO' → application → interview → active meeting_binding → meeting
--   * 只查不写；原文列不可改由 0001 的 fn_guard_columns 触发器保证（node readback.mjs 会真去改一次并期望被拒）
\set ON_ERROR_STOP on
\pset pager off
\pset border 2

\echo '=== 1. transcript_artifact（原文、revision、三维标签、canonical、sha 自洽） ==='
select ta.id,
       ta.source_revision                       as revision,
       ta.transcript_status                     as status,
       ta.provenance,
       ta.trigger_mode                          as trigger,
       ta.connection_state                      as connection,
       ta.is_complete,
       ta.is_canonical,
       ta.provider,
       ta.provider_artifact_id,
       ta.read_receipt_ref,
       ta.fetched_at,
       length(ta.raw_text)                      as raw_chars,
       ta.content_sha256,
       encode(sha256(convert_to(ta.raw_text, 'UTF8')), 'hex') as recomputed_sha256,
       (ta.content_sha256 = encode(sha256(convert_to(ta.raw_text, 'UTF8')), 'hex')) as sha_self_consistent
  from recruitment.transcript_artifact ta
  join recruitment.meeting_binding b
    on b.meeting_id = ta.meeting_id and b.tenant_id = ta.tenant_id and b.unbound_at is null
  join recruitment.interview i on i.id = b.interview_id and i.tenant_id = b.tenant_id
  join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
  join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
 where j.code = 'S9-TR-DEMO'
 order by ta.source_revision, ta.variant_type;

\echo '=== 2. interview_record（引用哪个 revision、状态轴、rubric；job 从 application 取，本机 0008 未应用无 job_id 列） ==='
select r.id,
       r.transcript_artifact_id,
       r.transcript_revision,
       r.status,
       r.verification_status,
       r.evidence_ok,
       r.is_current,
       a.job_id                                 as application_job_id,
       r.rubric_version_id,
       r.model_id,
       r.prompt_version,
       r.created_at
  from recruitment.interview_record r
  join recruitment.interview i on i.id = r.interview_id and i.tenant_id = r.tenant_id
  join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
  join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
 where j.code = 'S9-TR-DEMO'
 order by r.created_at;

\echo '=== 3. transcript_segment 计数（每个 artifact 的行数与序号范围） ==='
select s.artifact_id,
       count(*)::int as segments,
       min(s.sequence) as first_seq,
       max(s.sequence) as last_seq,
       count(*) filter (where length(btrim(s.content_text)) = 0)::int as empty_rows,
       count(*) filter (where s.speaker_ref is not null or s.speaker_label is not null)::int as rows_with_speaker
  from recruitment.transcript_segment s
  join recruitment.transcript_artifact ta on ta.id = s.artifact_id and ta.tenant_id = s.tenant_id
  join recruitment.meeting_binding b
    on b.meeting_id = ta.meeting_id and b.tenant_id = ta.tenant_id and b.unbound_at is null
  join recruitment.interview i on i.id = b.interview_id and i.tenant_id = b.tenant_id
  join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
  join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
 where j.code = 'S9-TR-DEMO'
 group by s.artifact_id
 order by s.artifact_id;

\echo '=== 4. canonical 唯一性（应 0 行；>0 行说明 uq_transcript_artifact_canonical 被破坏） ==='
select ta.meeting_id, count(*)::int as canonical_rows
  from recruitment.transcript_artifact ta
  join recruitment.meeting_binding b
    on b.meeting_id = ta.meeting_id and b.tenant_id = ta.tenant_id and b.unbound_at is null
  join recruitment.interview i on i.id = b.interview_id and i.tenant_id = b.tenant_id
  join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
  join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
 where j.code = 'S9-TR-DEMO' and ta.is_canonical
 group by ta.meeting_id
having count(*) > 1;

\echo '=== 5. 标签分布（应当只有 MANUAL / NOT_CONNECTED；provenance 取决于导入声明） ==='
select ta.provenance, ta.trigger_mode, ta.connection_state, count(*)::int as rows
  from recruitment.transcript_artifact ta
  join recruitment.meeting_binding b
    on b.meeting_id = ta.meeting_id and b.tenant_id = ta.tenant_id and b.unbound_at is null
  join recruitment.interview i on i.id = b.interview_id and i.tenant_id = b.tenant_id
  join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
  join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
 where j.code = 'S9-TR-DEMO'
 group by ta.provenance, ta.trigger_mode, ta.connection_state
 order by ta.provenance, ta.trigger_mode, ta.connection_state;

\echo '=== 6. 原文片段（首尾各 200 字符；合成演示文本，无真实个人信息） ==='
select ta.source_revision as revision,
       left(ta.raw_text, 200)  as head_200,
       right(ta.raw_text, 200) as tail_200
  from recruitment.transcript_artifact ta
  join recruitment.meeting_binding b
    on b.meeting_id = ta.meeting_id and b.tenant_id = ta.tenant_id and b.unbound_at is null
  join recruitment.interview i on i.id = b.interview_id and i.tenant_id = b.tenant_id
  join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
  join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
 where j.code = 'S9-TR-DEMO'
 order by ta.source_revision;
