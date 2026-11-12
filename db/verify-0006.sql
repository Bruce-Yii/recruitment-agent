-- =====================================================================
--  recruitment-agent · db/verify-0006.sql
--  0006_integrity_gaps.sql 的自检脚本（D-65 / D-59 / GAP-5）
--
--  用法（必须用 psql 跑，本文件含 \echo 等 psql 元命令）：
--    psql -v ON_ERROR_STOP=1 -d <db> -f db/verify-0006.sql
--
--  行为保证（与 db/verify.sql / verify-0005.sql 同口径）：
--    * 整个脚本在一个事务里执行，结尾 ROLLBACK —— 不留任何数据；
--    * 所有断言失败都会 RAISE EXCEPTION（exit code != 0），不会静默通过；
--    * 负向测试打印的是数据库**真实返回的 SQLSTATE 与 message_text**，
--      不是脚本自己编的期望值。
--
--  验证的是五个"库层拦不住"的缺口被堵住：
--    §1 结构断言：五条约束 / 两条触发器的形态（列集合、被引用表、restrict、validated）
--    §2 改造后的真实定义（pg_get_constraintdef，作为"改造后"证据）
--    §3 夹具：两个租户 + 一条完整招聘链（面试 / 会议 / 转写 / 记录 / 任务 / 授权）
--    §4 正向：合法路径必须**成功**（约束不能把正常业务也拦掉）
--    §5 负向：14 条，每个缺口至少 2 条，逐条断言 SQLSTATE
--    §6 GAP-5 的"死列变活"：自增、不可伪造、过期版本 0 行
--    §7 数据面复核
--
--  依赖：0001 + 0004（stage_catalog）+ 0006。0002 / 0005 可选。
--  本脚本**不需要** 0003（review_queue 系与本文件无交集）。
-- =====================================================================

\set ON_ERROR_STOP on

\echo '=================================================================='
\echo ' 0. 环境'
\echo '=================================================================='

select current_database() as database,
       current_setting('server_version') as pg_version,
       (select count(*) from pg_constraint
         where conrelid = 'recruitment.interview'::regclass and contype = 'f') as interview_fks,
       (select count(*) from pg_constraint
         where conrelid = 'recruitment.business_task'::regclass and contype = 'f') as business_task_fks;

begin;


-- =====================================================================
--  §1  结构断言（任何一条不满足即整体失败）
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 1. 结构断言'
\echo '=================================================================='

do $$
declare
  v_bad  text;
  v_def  text;
  v_cols text[];
  v_n    integer;
  v_act  text;
begin
  -- ------------------------------------------------------------------
  -- S-1 GAP-1：interview.stage_code 默认值 = 'S8'
  -- ------------------------------------------------------------------
  select pg_get_expr(d.adbin, d.adrelid) into v_def
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'recruitment.interview'::regclass
     and a.attname  = 'stage_code';
  if v_def is null or v_def not like '%S8%' or v_def like '%INTERVIEW%' then
    raise exception 'S-1 interview.stage_code 默认值应为 ''S8''（D-65），实际 %', coalesce(v_def, '（无）');
  end if;
  raise notice 'S-1 PASS interview.stage_code 默认值 = %（旧值 ''INTERVIEW'' 已退场）', v_def;

  -- ------------------------------------------------------------------
  -- S-2 GAP-1：外键 (tenant_id, stage_code) → stage_catalog (tenant_id, code)
  -- ------------------------------------------------------------------
  select (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_cols
    from pg_constraint c
   where c.conrelid  = 'recruitment.interview'::regclass
     and c.conname   = 'fk_interview_stage_catalog'
     and c.contype   = 'f'
     and c.confrelid = 'recruitment.stage_catalog'::regclass
     and c.convalidated
     and c.confdeltype = 'r'
     and c.confupdtype = 'r'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['code', 'tenant_id']::text[];
  if v_cols is distinct from array['stage_code', 'tenant_id']::text[] then
    raise exception 'S-2 fk_interview_stage_catalog 形态不对（期望 (tenant_id, stage_code) → stage_catalog(tenant_id, code)，restrict/restrict/validated；实际 %）',
      coalesce(v_cols::text, '（约束不存在）');
  end if;
  raise notice 'S-2 PASS fk_interview_stage_catalog：(tenant_id, stage_code) → stage_catalog(tenant_id, code)，restrict/validated';

  -- ------------------------------------------------------------------
  -- S-3 GAP-1：该列上不允许再存在"不含 tenant_id"的第二条外键（后门）
  -- ------------------------------------------------------------------
  select string_agg(format('%s(%s)', c.conname, pg_get_constraintdef(c.oid)), ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.interview'::regclass
     and c.contype  = 'f'
     and (select array_agg(a.attname::text)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         && array['stage_code']::text[]
     and not (select array_agg(a.attname::text)
                from pg_attribute a
               where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
             @> array['tenant_id']::text[];
  if v_bad is not null then
    raise exception 'S-3 存在不含 tenant_id 的 stage_code 外键（跨租户后门）：%', v_bad;
  end if;
  raise notice 'S-3 PASS stage_code 上没有"不含 tenant_id"的第二条外键';

  -- ------------------------------------------------------------------
  -- S-4 GAP-2：禁令 CHECK 必须含全部 6 个动作（原 5 个 + submit_scorecard）
  -- ------------------------------------------------------------------
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'recruitment.execution_mandate'::regclass
     and c.conname  = 'ck_execution_mandate_no_business_approval';
  if v_def is null then
    raise exception 'S-4 ck_execution_mandate_no_business_approval 不存在';
  end if;
  foreach v_act in array array['approve','reject','decide','merge_candidate',
                              'waive_scorecard','submit_scorecard']::text[]
  loop
    if v_def not like '%''' || v_act || '''%' then
      raise exception 'S-4 禁令 CHECK 缺少动作 %（当前：%）', v_act, v_def;
    end if;
  end loop;
  if v_def not like '%allowed_actions%' then
    raise exception 'S-4 禁令 CHECK 不作用在 allowed_actions 上：%', v_def;
  end if;
  raise notice 'S-4 PASS ck_execution_mandate_no_business_approval 含 6 个禁止动作（含 submit_scorecard）';

  -- ------------------------------------------------------------------
  -- S-5 GAP-3：fk_interview_record_artifact 是含 tenant_id 的 3 列复合外键
  -- ------------------------------------------------------------------
  select (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_cols
    from pg_constraint c
   where c.conrelid  = 'recruitment.interview_record'::regclass
     and c.conname   = 'fk_interview_record_artifact'
     and c.contype   = 'f'
     and c.convalidated
     and c.confdeltype = 'r'
     and c.confupdtype = 'r'
     and c.confrelid   = 'recruitment.transcript_artifact'::regclass
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['id', 'source_revision', 'tenant_id']::text[];
  if v_cols is distinct from array['tenant_id', 'transcript_artifact_id', 'transcript_revision']::text[] then
    raise exception 'S-5 fk_interview_record_artifact 不是含 tenant_id 的 3 列形态（实际 %）',
      coalesce(v_cols::text, '（约束不存在）');
  end if;
  raise notice 'S-5 PASS fk_interview_record_artifact：(tenant_id, artifact, revision) → transcript_artifact(tenant_id, id, source_revision)';

  -- ------------------------------------------------------------------
  -- S-6 GAP-3：被引用键在位（unique 的列集合 = {tenant_id, id, source_revision}）
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.transcript_artifact'::regclass
     and c.contype  = 'u'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['id', 'source_revision', 'tenant_id']::text[];
  if v_n < 1 then
    raise exception 'S-6 transcript_artifact 缺 unique (tenant_id, id, source_revision)（3 列外键无处可指）';
  end if;
  raise notice 'S-6 PASS transcript_artifact 有 unique (tenant_id, id, source_revision)';

  -- ------------------------------------------------------------------
  -- S-7 GAP-3：interview_record 上不允许再存在"不含 tenant_id 的转写外键"
  -- ------------------------------------------------------------------
  select string_agg(format('%s(%s)', c.conname, pg_get_constraintdef(c.oid)), ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.interview_record'::regclass
     and c.contype  = 'f'
     and (select array_agg(a.attname::text)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         && array['transcript_artifact_id', 'transcript_revision']::text[]
     and not (select array_agg(a.attname::text)
                from pg_attribute a
               where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
             @> array['tenant_id']::text[];
  if v_bad is not null then
    raise exception 'S-7 存在不含 tenant_id 的转写外键（跨租户后门）：%', v_bad;
  end if;
  raise notice 'S-7 PASS interview_record 上没有"不含 tenant_id"的转写外键';

  -- ------------------------------------------------------------------
  -- S-8 GAP-4：business_task.owner_actor_id 存在、uuid、可空、**无默认值**
  -- ------------------------------------------------------------------
  select string_agg(format('type=%s notnull=%s default=%s',
                           format_type(a.atttypid, a.atttypmod), a.attnotnull,
                           coalesce(pg_get_expr(d.adbin, d.adrelid), '（无）')), ' ')
    into v_bad
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'recruitment.business_task'::regclass
     and a.attname  = 'owner_actor_id'
     and a.attnum   > 0
     and not a.attisdropped;
  if v_bad is null then
    raise exception 'S-8 business_task.owner_actor_id 不存在';
  end if;
  if v_bad not like '%type=uuid%' then
    raise exception 'S-8 owner_actor_id 类型不是 uuid：%', v_bad;
  end if;
  if v_bad not like '%notnull=f%' then
    raise exception 'S-8 owner_actor_id 必须可空（D-59）：%', v_bad;
  end if;
  if v_bad not like '%default=（无）%' then
    raise exception 'S-8 owner_actor_id 不允许有默认值（D-59：不设默认值）：%', v_bad;
  end if;
  raise notice 'S-8 PASS business_task.owner_actor_id = %（可空、无默认值）', v_bad;

  -- ------------------------------------------------------------------
  -- S-9 GAP-4：外键 (owner_actor_id, tenant_id) → actor (id, tenant_id)
  -- ------------------------------------------------------------------
  select (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_cols
    from pg_constraint c
   where c.conrelid  = 'recruitment.business_task'::regclass
     and c.conname   = 'fk_business_task_owner_actor'
     and c.contype   = 'f'
     and c.confrelid = 'recruitment.actor'::regclass
     and c.convalidated
     and c.confdeltype = 'r'
     and c.confupdtype = 'r'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['id', 'tenant_id']::text[];
  if v_cols is distinct from array['owner_actor_id', 'tenant_id']::text[] then
    raise exception 'S-9 fk_business_task_owner_actor 形态不对（实际 %）',
      coalesce(v_cols::text, '（约束不存在）');
  end if;
  raise notice 'S-9 PASS fk_business_task_owner_actor：(owner_actor_id, tenant_id) → actor(id, tenant_id)';

  -- ------------------------------------------------------------------
  -- S-10 GAP-5：两张表都有 before update 的 fn_touch 触发器
  -- ------------------------------------------------------------------
  select string_agg(t.tbl, ', ') into v_bad
    from (values ('meeting'), ('meeting_binding')) as t(tbl)
   where not exists (
     select 1 from pg_trigger g
      where g.tgrelid = format('recruitment.%I', t.tbl)::regclass
        and not g.tgisinternal
        and (g.tgtype & 1)  = 1     -- FOR EACH ROW
        and (g.tgtype & 2)  = 2     -- BEFORE
        and (g.tgtype & 16) = 16    -- UPDATE
        and g.tgfoid = 'recruitment.fn_touch'::regproc);
  if v_bad is not null then
    raise exception 'S-10 这些表缺 before update 的 fn_touch 触发器：%', v_bad;
  end if;
  raise notice 'S-10 PASS meeting / meeting_binding 都有 before update → fn_touch';

  -- ------------------------------------------------------------------
  -- S-11 GAP-5：这两张表上不允许有**第二个** before update 触发器
  --      （两个自增触发器 = 一次 UPDATE 加两次版本 → 并发语义直接错位）
  -- ------------------------------------------------------------------
  select string_agg(format('%s.%s', t.tbl, g.tgname), ', ')
    into v_bad
    from (values ('meeting'), ('meeting_binding')) as t(tbl)
    join pg_trigger g on g.tgrelid = format('recruitment.%I', t.tbl)::regclass
   where not g.tgisinternal
     and (g.tgtype & 2)  = 2
     and (g.tgtype & 16) = 16
     and g.tgfoid <> 'recruitment.fn_touch'::regproc;
  if v_bad is not null then
    raise exception 'S-11 这些表上还有别的 before update 触发器（会双重自增）：%', v_bad;
  end if;
  raise notice 'S-11 PASS 两张表上只有 fn_touch 一个 before update 触发器';

  raise notice 'STRUCT-0006 PASS 五个缺口的 11 条结构断言全部通过';
end $$;


-- =====================================================================
--  §2  改造后的真实定义（"改造后"证据；"改造前"证据见 0006 §0 的日志）
-- =====================================================================

\echo ''
\echo '-- 改造后：0006 新增 / 改写的约束（pg_get_constraintdef 原文）--'
select 'GAP-1' as gap, 'fk_interview_stage_catalog'::text as object,
       pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.conrelid = 'recruitment.interview'::regclass and c.conname = 'fk_interview_stage_catalog'
union all
select 'GAP-2', 'ck_execution_mandate_no_business_approval', pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.conrelid = 'recruitment.execution_mandate'::regclass
   and c.conname = 'ck_execution_mandate_no_business_approval'
union all
select 'GAP-3', 'fk_interview_record_artifact', pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.conrelid = 'recruitment.interview_record'::regclass and c.conname = 'fk_interview_record_artifact'
union all
select 'GAP-3', 'uq_transcript_artifact_tenant_id_revision', pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.conrelid = 'recruitment.transcript_artifact'::regclass
   and c.conname = 'uq_transcript_artifact_tenant_id_revision'
union all
select 'GAP-4', 'fk_business_task_owner_actor', pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.conrelid = 'recruitment.business_task'::regclass and c.conname = 'fk_business_task_owner_actor'
order by 1, 2;

\echo '-- 改造后：GAP-5 的两个触发器（pg_get_triggerdef 原文）--'
select g.tgname, pg_get_triggerdef(g.oid) as definition
  from pg_trigger g
 where g.tgname in ('trg_meeting_touch', 'trg_meeting_binding_touch')
   and not g.tgisinternal
 order by 1;

\echo '-- 改造后：interview.stage_code 的默认值 --'
select a.attname, pg_get_expr(d.adbin, d.adrelid) as default_expr
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
 where a.attrelid = 'recruitment.interview'::regclass and a.attname = 'stage_code';


-- =====================================================================
--  §3  夹具（脚本结束 ROLLBACK，不留数据）
--      T1 = 完整招聘链（面试 / 会议 / 转写 / 记录 / 任务 / 授权）
--      T2 = **不种阶段目录**，只放一个会议 + 一份转写（跨租户引用用）
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 3. 夹具'
\echo '=================================================================='

insert into recruitment.organization (id, name) values
  ('eeeeeeee-eeee-4eee-8eee-000000000001', 'V6 租户甲'),
  ('eeeeeeee-eeee-4eee-8eee-000000000002', 'V6 租户乙');

-- T1 的阶段目录（0004 的 stage_catalog；GAP-1 的外键要靠它）
insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
select 'eeeeeeee-eeee-4eee-8eee-000000000001'::uuid, s.code, s.name, s.ord, s.v1
  from (values ('S1','招聘需求发现',1,false), ('S2','Requisition 创建与审批',2,false),
               ('S3','Job / JD / Rubric 设计',3,true), ('S4','Job Posting 发布',4,false),
               ('S5','人才获取 / Sourcing',5,false), ('S6','简历接入与处理（Intake）',6,true),
               ('S7','初筛 / Screening',7,true), ('S8','面试规划与排期',8,true),
               ('S9','面试执行与材料获取',9,true), ('S10','综合评价与招聘决策',10,true),
               ('S11','Offer 与入职交接',11,false), ('S12','人才沉淀与复盘',12,false)
       ) as s(code, name, ord, v1)
on conflict (tenant_id, code) do nothing;

insert into recruitment.department (id, tenant_id, name) values
  ('eeeeeeee-eeee-4eee-8eee-000000000011', 'eeeeeeee-eeee-4eee-8eee-000000000001', 'V6 甲-研发部');

insert into recruitment.actor (id, tenant_id, kind, display_name, primary_email) values
  ('eeeeeeee-eeee-4eee-8eee-000000000101', 'eeeeeeee-eeee-4eee-8eee-000000000001', 'HUMAN', 'V6-HR 甲',        'v6-hr@example.test'),
  ('eeeeeeee-eeee-4eee-8eee-000000000102', 'eeeeeeee-eeee-4eee-8eee-000000000001', 'HUMAN', 'V6-面试官甲',      'v6-iv@example.test'),
  ('eeeeeeee-eeee-4eee-8eee-000000000103', 'eeeeeeee-eeee-4eee-8eee-000000000002', 'HUMAN', 'V6-HR 乙（异租户）', 'v6-hr-b@example.test');

insert into recruitment.job (id, tenant_id, department_id, code, title) values
  ('eeeeeeee-eeee-4eee-8eee-000000000121', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'eeeeeeee-eeee-4eee-8eee-000000000011', 'V6-JOB-1', 'V6 岗位一');

insert into recruitment.job_version (id, tenant_id, job_id, version_no, description_md, payload_hash) values
  ('eeeeeeee-eeee-4eee-8eee-000000000122', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'eeeeeeee-eeee-4eee-8eee-000000000121', 1, 'V6 JD v1', repeat('a', 64));

insert into recruitment.rubric_version (id, tenant_id, job_id, version_no, dimensions, payload_hash) values
  ('eeeeeeee-eeee-4eee-8eee-000000000123', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'eeeeeeee-eeee-4eee-8eee-000000000121', 1, '[{"key":"v6","weight":1.0}]'::jsonb, repeat('b', 64));

insert into recruitment.candidate (id, tenant_id, display_name, normalized_email) values
  ('eeeeeeee-eeee-4eee-8eee-000000000131', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'V6 候选人甲', 'v6-c1@example.test');

insert into recruitment.application (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, current_stage_code) values
  ('eeeeeeee-eeee-4eee-8eee-000000000141', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'eeeeeeee-eeee-4eee-8eee-000000000131', 'eeeeeeee-eeee-4eee-8eee-000000000121',
   'eeeeeeee-eeee-4eee-8eee-000000000122', 'eeeeeeee-eeee-4eee-8eee-000000000123', 'S6');

-- i1：**不写 stage_code**（验证默认值）；i2：显式 'S9'（验证合法值仍可写）
insert into recruitment.interview
  (id, tenant_id, application_id, round_no, slot_code, status, scheduled_start_at, scheduled_end_at)
values
  ('eeeeeeee-eeee-4eee-8eee-000000000161', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'eeeeeeee-eeee-4eee-8eee-000000000141', 1, 'T1', 'SCHEDULED',
   now() + interval '1 day', now() + interval '1 day 1 hour');

insert into recruitment.interview
  (id, tenant_id, application_id, round_no, slot_code, stage_code, status, scheduled_start_at, scheduled_end_at)
values
  ('eeeeeeee-eeee-4eee-8eee-000000000162', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'eeeeeeee-eeee-4eee-8eee-000000000141', 1, 'T2', 'S9', 'SCHEDULED',
   now() + interval '2 day', now() + interval '2 day 1 hour');

insert into recruitment.interviewer (id, tenant_id, interview_id, actor_id, role_in_interview) values
  ('eeeeeeee-eeee-4eee-8eee-000000000171', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'eeeeeeee-eeee-4eee-8eee-000000000161', 'eeeeeeee-eeee-4eee-8eee-000000000102', 'TECH_LEAD');

-- m1：故意让 record_version=2 / updated_at 前移 1 小时 —— 这样"更新后 updated_at 变化"
--     才是可观察的（now() 在同一个事务内是常量，行内时间不前移就看不到变化）。
--     record_version=2 与 updated_at 前移自洽：created 2 小时前、1 小时前改过一次。
insert into recruitment.meeting
  (id, tenant_id, provider, external_meeting_id, created_at, updated_at, record_version)
values
  ('eeeeeeee-eeee-4eee-8eee-000000000181', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'feishu', 'mtg-1', now() - interval '2 hour', now() - interval '1 hour', 2);

insert into recruitment.meeting_binding
  (id, tenant_id, meeting_id, interview_id, binding_method, created_at, updated_at, record_version)
values
  ('eeeeeeee-eeee-4eee-8eee-000000000191', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'eeeeeeee-eeee-4eee-8eee-000000000181', 'eeeeeeee-eeee-4eee-8eee-000000000161',
   'SCHEDULED', now() - interval '2 hour', now() - interval '1 hour', 2);

-- m3：给"record_version 为 null"的负向测试留一个**没有活跃绑定**的会议
insert into recruitment.meeting (id, tenant_id, provider, external_meeting_id)
values ('eeeeeeee-eeee-4eee-8eee-000000000183', 'eeeeeeee-eeee-4eee-8eee-000000000001',
        'feishu', 'mtg-3');

insert into recruitment.transcript_artifact
  (id, tenant_id, meeting_id, provider, provider_artifact_id, source_revision,
   transcript_status, provenance, trigger_mode, connection_state, raw_text)
values
  ('eeeeeeee-eeee-4eee-8eee-0000000001a1', 'eeeeeeee-eeee-4eee-8eee-000000000001',
   'eeeeeeee-eeee-4eee-8eee-000000000181', 'feishu', 'mn-1', 1,
   'DISCOVERED', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED', '[00:00] V6 甲租户转写');

-- T2：没有阶段目录，也不需要 application —— 只需要一个会议和一份转写
insert into recruitment.meeting (id, tenant_id, provider, external_meeting_id)
values ('eeeeeeee-eeee-4eee-8eee-000000000182', 'eeeeeeee-eeee-4eee-8eee-000000000002',
        'feishu', 'mtg-9');

insert into recruitment.transcript_artifact
  (id, tenant_id, meeting_id, provider, provider_artifact_id, source_revision,
   transcript_status, provenance, trigger_mode, connection_state, raw_text)
values
  ('eeeeeeee-eeee-4eee-8eee-0000000001a2', 'eeeeeeee-eeee-4eee-8eee-000000000002',
   'eeeeeeee-eeee-4eee-8eee-000000000182', 'feishu', 'mn-9', 1,
   'DISCOVERED', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED', '[00:00] V6 乙租户转写');

\echo ' 夹具就绪：T1 有完整链（面试 2 / 会议 2 / 转写 1 / 记录 0），T2 只有会议 + 转写（无阶段目录）'


-- =====================================================================
--  §4  正向用例：约束不能把正常业务也拦掉
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 4. 正向用例（合法路径必须成功）'
\echo '=================================================================='

do $$
declare
  v_stage text;
  v_ver   integer;
  v_n     integer;
begin
  -- 4.1 GAP-1：不写 stage_code → 默认 'S8'（且 S8 必须真实存在于目录 → 外键放行）
  select stage_code into v_stage from recruitment.interview
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000161';
  if v_stage is distinct from 'S8' then
    raise exception 'POS-6-01 默认阶段值应为 S8，实际 %', v_stage;
  end if;
  raise notice 'POS-6-01 PASS 不写 stage_code 的面试落库为 S8（默认值 + 外键同时成立）';

  -- 4.2 GAP-1：显式写合法阶段 'S9' 仍然成功
  select stage_code into v_stage from recruitment.interview
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000162';
  if v_stage is distinct from 'S9' then
    raise exception 'POS-6-02 显式 S9 没有落库（实际 %）', v_stage;
  end if;
  raise notice 'POS-6-02 PASS 显式写 S9 成功（约束不是"只允许默认值"）';

  -- 4.3 GAP-2：不含禁止动作的 mandate 正常落库
  insert into recruitment.execution_mandate
    (id, tenant_id, actor_id, actor_type, permission_version, allowed_tools, allowed_actions, expires_at)
  values
    ('eeeeeeee-eeee-4eee-8eee-0000000001d1', 'eeeeeeee-eeee-4eee-8eee-000000000001',
     'eeeeeeee-eeee-4eee-8eee-000000000102', 'AGENT_WORKER', 'perm@1',
     '{recruitment_resume_read,recruitment_interview_get}', '{read,fetch,summarize}',
     now() + interval '1 day');
  raise notice 'POS-6-03 PASS read/fetch/summarize 这类技术动作仍然可以进 mandate';

  -- 4.4 GAP-3：同租户、同版本的转写引用成功
  insert into recruitment.interview_record
    (id, tenant_id, interview_id, transcript_artifact_id, transcript_revision,
     rubric_version_id, prompt_version, model_id)
  values
    ('eeeeeeee-eeee-4eee-8eee-0000000001b1', 'eeeeeeee-eeee-4eee-8eee-000000000001',
     'eeeeeeee-eeee-4eee-8eee-000000000161', 'eeeeeeee-eeee-4eee-8eee-0000000001a1', 1,
     'eeeeeeee-eeee-4eee-8eee-000000000123', 'prompt@1', 'deepseek-v4');
  raise notice 'POS-6-04 PASS 同租户同 revision 的 interview_record 正常落库';

  -- 4.5 GAP-4：owner_actor_id 可空、可写同租户 actor、可清空
  insert into recruitment.business_task
    (id, tenant_id, task_type, title, idempotency_key, owner_actor_id)
  values
    ('eeeeeeee-eeee-4eee-8eee-0000000001c1', 'eeeeeeee-eeee-4eee-8eee-000000000001',
     'SCORECARD_REMIND', '提醒面试官交评价', 'v6:task:1', 'eeeeeeee-eeee-4eee-8eee-000000000102');

  select owner_actor_id, record_version into v_stage, v_ver
    from recruitment.business_task where id = 'eeeeeeee-eeee-4eee-8eee-0000000001c1';
  if v_stage is distinct from 'eeeeeeee-eeee-4eee-8eee-000000000102' then
    raise exception 'POS-6-05 owner_actor_id 没有落库（实际 %）', v_stage;
  end if;
  raise notice 'POS-6-05 PASS owner_actor_id 可写同租户 actor（record_version=%）', v_ver;

  -- 4.6 GAP-4：不写 owner 也合法（可空，不设默认值）
  insert into recruitment.business_task (tenant_id, task_type, title, idempotency_key)
  values ('eeeeeeee-eeee-4eee-8eee-000000000001', 'SCORECARD_REMIND', '无责任人的任务', 'v6:task:2');
  select count(*) into v_n from recruitment.business_task
   where idempotency_key = 'v6:task:2' and owner_actor_id is null;
  if v_n <> 1 then
    raise exception 'POS-6-06 不写 owner 的任务没有落库（% 行）', v_n;
  end if;
  raise notice 'POS-6-06 PASS 不写 owner_actor_id 也能落库（可空、无默认值）';

  -- 4.7 GAP-5：更新会议 → record_version +1（1 次，不是 2 次）
  update recruitment.meeting set provider = 'feishu' where id = 'eeeeeeee-eeee-4eee-8eee-000000000181';
  select record_version into v_ver from recruitment.meeting
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000181';
  if v_ver <> 3 then
    raise exception 'POS-6-07 meeting 更新后 record_version 应为 3（2+1），实际 %', v_ver;
  end if;
  raise notice 'POS-6-07 PASS meeting 一次 UPDATE → record_version 2→3（只加 1，没有双重触发器）';
end $$;


-- =====================================================================
--  §5  负向用例：14 条，每个缺口至少 2 条，逐条断言 SQLSTATE
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 5. 负向用例（每条都必须 FAIL，并给出真实 SQLSTATE / 报错）'
\echo '=================================================================='

do $$
declare
  v_state text;
  v_msg   text;
  v_ok    integer := 0;
  r       record;
begin
  for r in
    select * from (values
      -- ----------------------------------------------------------------
      -- GAP-1：stage_code 必须存在于本租户的 stage_catalog
      -- ----------------------------------------------------------------
      ('G1-01', '23503', 'GAP-1 写入旧默认值 INTERVIEW（不在 S1–S12、不在目录）',
       $q$insert into recruitment.interview
            (tenant_id, application_id, round_no, slot_code, stage_code, status,
             scheduled_start_at, scheduled_end_at)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','eeeeeeee-eeee-4eee-8eee-000000000141',
                  1,'TN1','INTERVIEW','SCHEDULED', now() + interval '3 day', now() + interval '3 day 1 hour')$q$),

      ('G1-02', '23503', 'GAP-1 写入形状合法但目录里没有的阶段 S99',
       $q$insert into recruitment.interview
            (tenant_id, application_id, round_no, slot_code, stage_code, status,
             scheduled_start_at, scheduled_end_at)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','eeeeeeee-eeee-4eee-8eee-000000000141',
                  1,'TN2','S99','SCHEDULED', now() + interval '3 day', now() + interval '3 day 1 hour')$q$),

      ('G1-03', '23503', 'GAP-1 把已存在的面试改到作废的五档值 SCREENING',
       $q$update recruitment.interview set stage_code = 'SCREENING'
           where id = 'eeeeeeee-eeee-4eee-8eee-000000000162'$q$),

      -- ----------------------------------------------------------------
      -- GAP-2：mandate 不得包含 submit_scorecard（代填面评）
      -- ----------------------------------------------------------------
      ('G2-01', '23514', 'GAP-2 mandate 的 allowed_actions 只有 submit_scorecard',
       $q$insert into recruitment.execution_mandate
            (tenant_id, actor_id, actor_type, permission_version, allowed_actions, expires_at)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','eeeeeeee-eeee-4eee-8eee-000000000102',
                  'AGENT_WORKER','perm@1','{submit_scorecard}', now() + interval '1 day')$q$),

      ('G2-02', '23514', 'GAP-2 submit_scorecard 混在合法动作里（{read,submit_scorecard}）',
       $q$insert into recruitment.execution_mandate
            (tenant_id, actor_id, actor_type, permission_version, allowed_actions, expires_at)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','eeeeeeee-eeee-4eee-8eee-000000000102',
                  'AGENT_WORKER','perm@1','{read,submit_scorecard}', now() + interval '1 day')$q$),

      ('G2-03', '23514', 'GAP-2 给已签发的 mandate 追加 submit_scorecard（UPDATE 路径）',
       $q$update recruitment.execution_mandate
             set allowed_actions = allowed_actions || '{submit_scorecard}'::text[]
           where id = 'eeeeeeee-eeee-4eee-8eee-0000000001d1'$q$),

      -- ----------------------------------------------------------------
      -- GAP-3：转写引用必须同租户 + 同 revision
      -- ----------------------------------------------------------------
      ('G3-01', '23503', 'GAP-3 甲租户的 interview_record 引用**乙租户**的 transcript_artifact',
       $q$insert into recruitment.interview_record
            (tenant_id, interview_id, transcript_artifact_id, transcript_revision,
             rubric_version_id, prompt_version, model_id, is_current)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','eeeeeeee-eeee-4eee-8eee-000000000161',
                  'eeeeeeee-eeee-4eee-8eee-0000000001a2', 1,
                  'eeeeeeee-eeee-4eee-8eee-000000000123','prompt@1','deepseek-v4', false)$q$),

      ('G3-02', '23503', 'GAP-3 同租户但 revision 对不上（artifact 只有 revision 1，声称 2）',
       $q$insert into recruitment.interview_record
            (tenant_id, interview_id, transcript_artifact_id, transcript_revision,
             rubric_version_id, prompt_version, model_id, is_current)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','eeeeeeee-eeee-4eee-8eee-000000000161',
                  'eeeeeeee-eeee-4eee-8eee-0000000001a1', 2,
                  'eeeeeeee-eeee-4eee-8eee-000000000123','prompt@1','deepseek-v4', false)$q$),

      ('G3-03', '23503', 'GAP-3 把已有记录的转写改指向乙租户的 artifact（UPDATE 路径）',
       $q$update recruitment.interview_record
             set transcript_artifact_id = 'eeeeeeee-eeee-4eee-8eee-0000000001a2'
           where id = 'eeeeeeee-eeee-4eee-8eee-0000000001b1'$q$),

      -- ----------------------------------------------------------------
      -- GAP-4：owner_actor_id 必须指向真实存在、且同租户的 actor
      -- ----------------------------------------------------------------
      ('G4-01', '23503', 'GAP-4 owner_actor_id 指向不存在的 actor',
       $q$insert into recruitment.business_task
            (tenant_id, task_type, title, idempotency_key, owner_actor_id)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','X','无主任务',
                  'v6:task:bad-1', 'bbbbbbbb-bbbb-4bbb-8bbb-000000000000')$q$),

      ('G4-02', '23503', 'GAP-4 owner_actor_id 指向**另一个租户**的 actor（跨租户负责人）',
       $q$insert into recruitment.business_task
            (tenant_id, task_type, title, idempotency_key, owner_actor_id)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','X','别人的任务',
                  'v6:task:bad-2', 'eeeeeeee-eeee-4eee-8eee-000000000103')$q$),

      ('G4-03', '23503', 'GAP-4 把已有任务的负责人改成不存在的 actor（UPDATE 路径）',
       $q$update recruitment.business_task
             set owner_actor_id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000000'
           where id = 'eeeeeeee-eeee-4eee-8eee-0000000001c1'$q$),

      -- ----------------------------------------------------------------
      -- GAP-5：版本列是 NOT NULL 的计数器（null 无法参与乐观并发比较）
      -- ----------------------------------------------------------------
      ('G5-01', '23502', 'GAP-5 meeting.record_version 写 null（计数器不能缺席）',
       $q$insert into recruitment.meeting
            (tenant_id, provider, external_meeting_id, record_version)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','feishu','mtg-null', null)$q$),

      ('G5-02', '23502', 'GAP-5 meeting_binding.record_version 写 null（计数器不能缺席）',
       $q$insert into recruitment.meeting_binding
            (tenant_id, meeting_id, interview_id, binding_method, record_version)
          values ('eeeeeeee-eeee-4eee-8eee-000000000001','eeeeeeee-eeee-4eee-8eee-000000000183',
                  'eeeeeeee-eeee-4eee-8eee-000000000162','EVENT_MATCH', null)$q$)
    ) as v(id, expect, what, sql)
  loop
    begin
      execute r.sql;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state <> r.expect then
        raise exception 'NEGATIVE % 失败但 SQLSTATE 不符（期望 % 实际 %）：% | %',
          r.id, r.expect, v_state, r.what, v_msg;
      end if;
      v_ok := v_ok + 1;
      raise notice '% PASS [%] => sqlstate=% | %', r.id, r.what, v_state, v_msg;
      continue;
    end;
    raise exception 'NEGATIVE % 居然成功了（应当失败）：% | SQL=%', r.id, r.what, r.sql;
  end loop;

  if v_ok <> 14 then
    raise exception 'NEGATIVE-0006 只跑了 % 条（期望 14）', v_ok;
  end if;
  raise notice 'NEGATIVE-0006 SUMMARY % 条负向测试全部按预期失败（GAP-1:3 / GAP-2:3 / GAP-3:3 / GAP-4:3 / GAP-5:2）', v_ok;
end $$;


-- =====================================================================
--  §6  GAP-5：死列变活 —— 自增、不可伪造、过期版本 0 行
--
--  说明：这三个断言不是 SQLSTATE 断言（fn_touch 是**静默覆盖**语义，与 0001
--        的 fn_row_guard 一致），所以用数值断言表达；SQLSTATE 类负向见 §5 G5-01/02。
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 6. GAP-5：record_version 是否真的活了（自增 / 不可伪造 / 过期版本 0 行）'
\echo '=================================================================='

do $$
declare
  v_ver0  integer;
  v_ver1  integer;
  v_ver2  integer;
  v_upd0  timestamptz;
  v_upd1  timestamptz;
  v_now   timestamptz;
  v_n     integer;
begin
  -- 6.0 用一条**全新**的会议行做时间观察：
  --     now() 在同一个事务里是常量，复用 §4 已经 UPDATE 过的行会看不到 updated_at 前移。
  --     created_at = updated_at = 1 小时前 → 自洽（建了就没改过，record_version = 1）。
  insert into recruitment.meeting
    (id, tenant_id, provider, external_meeting_id, created_at, updated_at)
  values
    ('eeeeeeee-eeee-4eee-8eee-000000000184', 'eeeeeeee-eeee-4eee-8eee-000000000001',
     'feishu', 'mtg-touch', now() - interval '1 hour', now() - interval '1 hour');

  select record_version, updated_at into v_ver0, v_upd0
    from recruitment.meeting where id = 'eeeeeeee-eeee-4eee-8eee-000000000184';

  -- 6.1 更新后 record_version 自增 1、updated_at 前移
  update recruitment.meeting set actual_start_at = now() - interval '30 min'
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000184';
  select record_version, updated_at into v_ver1, v_upd1
    from recruitment.meeting where id = 'eeeeeeee-eeee-4eee-8eee-000000000184';
  v_now := now();
  if v_ver1 <> v_ver0 + 1 then
    raise exception 'GAP-5-01 meeting 更新后 record_version 应 % → %，实际 %', v_ver0, v_ver0 + 1, v_ver1;
  end if;
  if v_upd1 <= v_upd0 then
    raise exception 'GAP-5-01 meeting 更新后 updated_at 没有前移（% → %）', v_upd0, v_upd1;
  end if;
  raise notice 'GAP-5-01 PASS meeting 更新：record_version % → %，updated_at % → %（事务时钟 %）',
    v_ver0, v_ver1, v_upd0, v_upd1, v_now;

  -- 6.2 直接写 record_version 会被触发器覆盖（不可伪造版本号）
  update recruitment.meeting set record_version = 99, provider = 'feishu-x'
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000184';
  select record_version into v_ver2 from recruitment.meeting
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000184';
  if v_ver2 <> v_ver1 + 1 then
    raise exception 'GAP-5-02 伪造 record_version=99 竟然生效（实际 %，应为 %）', v_ver2, v_ver1 + 1;
  end if;
  raise notice 'GAP-5-02 PASS 手写 record_version=99 被覆盖为 %（版本号不可伪造）', v_ver2;

  -- 6.3 过期版本号更新影响 0 行（乐观并发的调用方约定）
  update recruitment.meeting set provider = 'feishu-y'
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000184' and record_version = 1;
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'GAP-5-03 过期 record_version 竟然更新成功（% 行）', v_n;
  end if;
  raise notice 'GAP-5-03 PASS 过期 record_version 更新影响 0 行（VERSION_CONFLICT 由调用方处理）';

  -- 6.4 meeting_binding 同构：自增 1
  select record_version into v_ver0 from recruitment.meeting_binding
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000191';
  update recruitment.meeting_binding
     set binding_method = 'MANUAL', bound_by_actor_id = 'eeeeeeee-eeee-4eee-8eee-000000000101'
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000191';
  select record_version into v_ver1 from recruitment.meeting_binding
   where id = 'eeeeeeee-eeee-4eee-8eee-000000000191';
  if v_ver1 <> v_ver0 + 1 then
    raise exception 'GAP-5-04 meeting_binding 更新后 record_version 应 % → %，实际 %',
      v_ver0, v_ver0 + 1, v_ver1;
  end if;
  raise notice 'GAP-5-04 PASS meeting_binding 更新：record_version % → %', v_ver0, v_ver1;
end $$;


-- =====================================================================
--  §7  数据面复核（夹具也在内：正反两侧都要真的干净）
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 7. 数据面复核'
\echo '=================================================================='

do $$
declare
  v_n integer;
begin
  -- 7.1 没有任何 interview 的阶段 code 落在自己租户目录之外
  select count(*) into v_n
    from recruitment.interview i
   where not exists (select 1 from recruitment.stage_catalog s
                      where s.tenant_id = i.tenant_id and s.code = i.stage_code);
  if v_n <> 0 then
    raise exception 'DATA-0006-01 仍有 % 条 interview 的 stage_code 不在目录中', v_n;
  end if;
  raise notice 'DATA-0006-01 PASS 全部 interview 的 stage_code 都在各自租户目录内';

  -- 7.2 没有任何 interview_record 跨租户引用 artifact
  select count(*) into v_n
    from recruitment.interview_record r
    join recruitment.transcript_artifact ta on ta.id = r.transcript_artifact_id
   where ta.tenant_id <> r.tenant_id;
  if v_n <> 0 then
    raise exception 'DATA-0006-02 仍有 % 条 interview_record 跨租户引用 artifact', v_n;
  end if;
  raise notice 'DATA-0006-02 PASS 全部 interview_record 的 artifact 引用都在同租户';

  -- 7.3 没有任何 mandate 带 submit_scorecard
  select count(*) into v_n
    from recruitment.execution_mandate m
   where 'submit_scorecard' = any (m.allowed_actions);
  if v_n <> 0 then
    raise exception 'DATA-0006-03 仍有 % 条 mandate 允许 submit_scorecard', v_n;
  end if;
  raise notice 'DATA-0006-03 PASS 没有任何 mandate 允许 submit_scorecard';

  -- 7.4 没有任何 task 的负责人跨租户
  select count(*) into v_n
    from recruitment.business_task t
    join recruitment.actor a on a.id = t.owner_actor_id
   where a.tenant_id <> t.tenant_id;
  if v_n <> 0 then
    raise exception 'DATA-0006-04 仍有 % 条 task 的 owner 跨租户', v_n;
  end if;
  raise notice 'DATA-0006-04 PASS 全部 business_task 的 owner 都在同租户（或为空）';

  -- 7.5 两张表的版本列都已 > 1（说明触发器真的跑过）
  select count(*) into v_n
    from recruitment.meeting where record_version > 1;
  if v_n < 1 then
    raise exception 'DATA-0006-05 meeting.record_version 全是 1（触发器没生效）';
  end if;
  select count(*) into v_n
    from recruitment.meeting_binding where record_version > 1;
  if v_n < 1 then
    raise exception 'DATA-0006-05 meeting_binding.record_version 全是 1（触发器没生效）';
  end if;
  raise notice 'DATA-0006-05 PASS 两张表的 record_version 都已随 UPDATE 递增（不再是死列）';
end $$;

\echo ''
\echo '-- 夹具行数（脚本回滚前；回滚后应为 0）--'
select 'interview'        as t, count(*) from recruitment.interview
union all select 'meeting',          count(*) from recruitment.meeting
union all select 'meeting_binding',  count(*) from recruitment.meeting_binding
union all select 'interview_record', count(*) from recruitment.interview_record
union all select 'business_task',    count(*) from recruitment.business_task
union all select 'execution_mandate',count(*) from recruitment.execution_mandate
order by 1;

\echo ''
\echo '=== ROLLBACK：自检不改变数据库 ==='
rollback;

\echo ''
\echo '=================================================================='
\echo ' VERIFY-0006 PASS：11 条结构断言 + 7 条正向 + 14 条负向 + 4 条 GAP-5 动态 + 5 条数据面全部通过'
\echo '=================================================================='
