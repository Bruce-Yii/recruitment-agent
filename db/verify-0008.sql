-- =====================================================================
--  recruitment-agent · db/verify-0008.sql
--
--  0008 的自检（`psql -v ON_ERROR_STOP=1 -d ra_v8 -f db/verify-0008.sql`）：
--
--    §1 结构断言（7 条）
--       S-1 GAP-A：uq_decision_current 是可延迟排斥约束，键 = (tenant_id,
--                  application_id, decision_scope, coalesce(stage_code,''))，
--                  谓词 = superseded_by_decision_id IS NULL，condeferrable/
--                  condeferred/convalidated 全 true，backing index 同名且
--                  indisunique=f / indisexclusion=t
--       S-2 GAP-B：uq_decision_current_final 同上（键 = tenant_id, application_id，
--                  谓词 = scope='FINAL' 且未取代）
--       S-3 0007 的部分唯一索引**已不存在**（避免"两个对象都在"）：
--                  ① decision 上 0 个 unique + nulls not distinct + 该谓词的索引
--                  ② 名叫 uq_decision_current 的关系只有 1 个，且属于排斥约束
--       S-4 GAP-C：interview_record.job_id = uuid / NOT NULL / 无默认值
--       S-5 GAP-C：fk_interview_record_rubric_job 3 列 + 被引用键在位
--       S-6 GAP-C：trg_interview_record_job_guard + fn_interview_record_job_guard
--       S-7 decision 上恰好 2 个排斥约束（没有第三个同名/旧形态残留）
--
--    §2 改造后的真实定义（pg_get_constraintdef / pg_get_indexdef / pg_get_triggerdef）
--    §3 夹具（脚本结束 ROLLBACK，不留数据）
--    §4 正向
--       P-1 **契约 §5.2 的两步重评事务在同一事务内成功**（本迁移存在的理由）：
--             INSERT 新 current（同键）→ UPDATE 旧行指向新行 → 两条都提交
--       P-2 FINAL 重评同理（旧 FINAL/NULL → 新 FINAL/S10），证明 B 不把正常重评拦死
--           两条都做完后 `SET CONSTRAINTS ALL IMMEDIATE` —— 等价于 COMMIT 时的检查，
--           通过即证明"延迟到提交才检查"没有放过任何一条。
--       P-3 C：不写 job_id → 触发器从 interview → application 推导
--       P-4 C：显式写正确的 job_id 可以落库
--    §5 负向（此时约束已被 SET CONSTRAINTS ALL IMMEDIATE，逐条断言 SQLSTATE）
--       N-1 同 (application, scope, stage) 两条 current → 23P01 / 23505
--       N-2 FINAL/S10 + FINAL/NULL 两条 current → 23P01 / 23505
--       N-3 interview_record 用别的岗位的 rubric → 23503
--       N-4 interview_record 显式写别的岗位的 job_id → 23514
--    §6 数据面（全库断言）
--    §7 夹具行数 / 约束原文
--
--  结尾 ROLLBACK：自检不改变数据库。
-- =====================================================================

\echo '=================================================================='
\echo ' 0. 环境'
\echo '=================================================================='
select current_database() as db,
       current_setting('server_version') as pg_version,
       now() as at;

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
  v_n   integer;
  v_def text;
  v_col text;
begin
  -- ------------------------------------------------------------------
  -- S-1 GAP-A：可延迟排斥约束 + 键 + 谓词 + backing index
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current'
     and c.contype  = 'x'
     and c.condeferrable
     and c.condeferred
     and c.convalidated
     and c.conindid = to_regclass('recruitment.uq_decision_current')
     and lower(pg_get_constraintdef(c.oid)) like '%tenant_id with =%'
     and lower(pg_get_constraintdef(c.oid)) like '%application_id with =%'
     and lower(pg_get_constraintdef(c.oid)) like '%decision_scope with =%'
     and lower(pg_get_constraintdef(c.oid)) like '%coalesce(stage_code%'
     and lower(pg_get_constraintdef(c.oid)) like '%superseded_by_decision_id is null%'
     and lower(pg_get_constraintdef(c.oid)) like '%deferrable initially deferred%';
  if v_n <> 1 then
    select coalesce(pg_get_constraintdef(c.oid), '（约束不存在）') into v_def
      from pg_constraint c
     where c.conrelid = 'recruitment.decision'::regclass
       and c.conname  = 'uq_decision_current';
    raise exception 'S-1 uq_decision_current 不是"可延迟排斥约束 + 目标键 + 目标谓词"（% / 1）。实际：%', v_n, coalesce(v_def, '（无）');
  end if;

  select count(*) into v_n
    from pg_index i
   where i.indexrelid = to_regclass('recruitment.uq_decision_current')
     and i.indrelid   = 'recruitment.decision'::regclass
     and i.indisexclusion
     and not i.indisunique
     and pg_get_expr(i.indpred, i.indrelid) like '%superseded_by_decision_id IS NULL%';
  if v_n <> 1 then
    raise exception 'S-1 backing index uq_decision_current 不是 partial exclusion index（% / 1）', v_n;
  end if;

  raise notice 'S-1 PASS uq_decision_current：EXCLUDE (tenant_id, application_id, decision_scope, coalesce(stage_code,'''')) WHERE 未取代，DEFERRABLE INITIALLY DEFERRED，backing index indisunique=f/indisexclusion=t';

  -- ------------------------------------------------------------------
  -- S-2 GAP-B：每个申请最多一条 current FINAL
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current_final'
     and c.contype  = 'x'
     and c.condeferrable
     and c.condeferred
     and c.convalidated
     and c.conindid = to_regclass('recruitment.uq_decision_current_final')
     and lower(pg_get_constraintdef(c.oid)) like '%tenant_id with =%'
     and lower(pg_get_constraintdef(c.oid)) like '%application_id with =%'
     and lower(pg_get_constraintdef(c.oid)) like '%decision_scope = ''final''%'
     and lower(pg_get_constraintdef(c.oid)) like '%superseded_by_decision_id is null%'
     and lower(pg_get_constraintdef(c.oid)) like '%deferrable initially deferred%';
  if v_n <> 1 then
    select coalesce(pg_get_constraintdef(c.oid), '（约束不存在）') into v_def
      from pg_constraint c
     where c.conrelid = 'recruitment.decision'::regclass
       and c.conname  = 'uq_decision_current_final';
    raise exception 'S-2 uq_decision_current_final 不是"可延迟排斥约束 + 目标谓词"（% / 1）。实际：%', v_n, coalesce(v_def, '（无）');
  end if;
  raise notice 'S-2 PASS uq_decision_current_final：EXCLUDE (tenant_id, application_id) WHERE scope=''FINAL'' 且未取代，DEFERRABLE INITIALLY DEFERRED';

  -- ------------------------------------------------------------------
  -- S-3 旧对象已不存在（避免"两个对象都在"）
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_index i
   where i.indrelid = 'recruitment.decision'::regclass
     and i.indisunique
     and i.indnullsnotdistinct
     and i.indpred is not null
     and pg_get_expr(i.indpred, i.indrelid) like '%superseded_by_decision_id IS NULL%';
  if v_n <> 0 then
    raise exception 'S-3 decision 上仍存在 0007 形态的部分唯一索引（unique + nulls not distinct + 谓词）：% 个（应为 0）', v_n;
  end if;

  select count(*) into v_n
    from pg_class c
   where c.relnamespace = 'recruitment'::regnamespace
     and c.relname      = 'uq_decision_current'
     and c.relkind      = 'i';
  if v_n <> 1 then
    raise exception 'S-3 名叫 uq_decision_current 的索引关系应恰好 1 个（% / 1）—— 旧索引与新约束不能并存', v_n;
  end if;

  raise notice 'S-3 PASS 0007 的部分唯一索引已不存在；uq_decision_current 只剩 1 个关系（排斥约束的 backing index）';

  -- ------------------------------------------------------------------
  -- S-4 GAP-C：interview_record.job_id
  -- ------------------------------------------------------------------
  select string_agg(format('type=%s notnull=%s default=%s',
                           format_type(a.atttypid, a.atttypmod), a.attnotnull,
                           coalesce(pg_get_expr(d.adbin, d.adrelid), '（无）')), ' ')
    into v_col
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'recruitment.interview_record'::regclass
     and a.attname  = 'job_id'
     and a.attnum   > 0
     and not a.attisdropped;
  if v_col is null then
    raise exception 'S-4 interview_record.job_id 不存在';
  end if;
  if v_col not like '%type=uuid%' then raise exception 'S-4 job_id 类型不是 uuid：%', v_col; end if;
  if v_col not like '%notnull=t%' then raise exception 'S-4 job_id 必须 NOT NULL：%', v_col; end if;
  if v_col not like '%default=（无）%' then raise exception 'S-4 job_id 不允许有默认值：%', v_col; end if;
  raise notice 'S-4 PASS interview_record.job_id = %（uuid、NOT NULL、无默认值）', v_col;

  -- ------------------------------------------------------------------
  -- S-5 GAP-C：复合外键 + 被引用键
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid  = 'recruitment.interview_record'::regclass
     and c.conname   = 'fk_interview_record_rubric_job'
     and c.contype   = 'f'
     and c.confrelid = 'recruitment.rubric_version'::regclass
     and c.convalidated
     and c.confdeltype = 'r'
     and c.confupdtype = 'r'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['job_id', 'rubric_version_id', 'tenant_id']::text[]
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['id', 'job_id', 'tenant_id']::text[];
  if v_n <> 1 then
    raise exception 'S-5 fk_interview_record_rubric_job 不是目标 3 列形态（% / 1）', v_n;
  end if;

  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.rubric_version'::regclass
     and c.contype  = 'u'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['id', 'job_id', 'tenant_id']::text[];
  if v_n < 1 then
    raise exception 'S-5 rubric_version 缺 unique (tenant_id, job_id, id)（3 列外键无处可指）';
  end if;
  raise notice 'S-5 PASS fk_interview_record_rubric_job：(tenant_id, job_id, rubric_version_id) → rubric_version(tenant_id, job_id, id)';

  -- ------------------------------------------------------------------
  -- S-6 GAP-C：触发器 + 函数
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'recruitment.interview_record'::regclass
     and g.tgname  = 'trg_interview_record_job_guard'
     and not g.tgisinternal
     and (g.tgtype & 1)  = 1      -- FOR EACH ROW
     and (g.tgtype & 2)  = 2      -- BEFORE
     and (g.tgtype & 20) = 20     -- INSERT + UPDATE
     and g.tgfoid = 'recruitment.fn_interview_record_job_guard'::regproc;
  if v_n <> 1 then
    raise exception 'S-6 trg_interview_record_job_guard 不在位或形态不对（% / 1）', v_n;
  end if;

  select count(*) into v_n
    from pg_proc p
   where p.pronamespace = 'recruitment'::regnamespace
     and p.proname = 'fn_interview_record_job_guard';
  if v_n <> 1 then
    raise exception 'S-6 fn_interview_record_job_guard 不存在或重名（% / 1）', v_n;
  end if;
  raise notice 'S-6 PASS trg_interview_record_job_guard（before insert or update）→ fn_interview_record_job_guard';

  -- ------------------------------------------------------------------
  -- S-7 decision 上恰好 2 个排斥约束，没有残留的第三个
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.contype  = 'x';
  if v_n <> 2 then
    raise exception 'S-7 decision 上的排斥约束应恰好 2 个（% / 2）', v_n;
  end if;
  raise notice 'S-7 PASS decision 上恰好 2 个排斥约束（A 当前唯一 / B current FINAL 唯一）';
end $$;


-- =====================================================================
--  §2  改造后的真实定义（"改造后"证据；"改造前"证据见 0008 §0 的日志）
-- =====================================================================

\echo ''
\echo '-- 改造后：0008 的两条可延迟排斥约束（pg_get_constraintdef 原文）--'
select c.conname,
       c.contype,
       c.condeferrable,
       c.condeferred,
       c.convalidated,
       pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.conrelid = 'recruitment.decision'::regclass
   and c.conname in ('uq_decision_current', 'uq_decision_current_final')
 order by c.conname;

\echo ''
\echo '-- 改造后：backing index（注意 indisunique=f / indisexclusion=t）--'
select c.relname, i.indisunique, i.indisexclusion,
       pg_get_indexdef(i.indexrelid) as indexdef
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
 where i.indrelid = 'recruitment.decision'::regclass
   and i.indisexclusion
 order by c.relname;

\echo ''
\echo '-- 改造后：interview_record.job_id + 复合外键 + 触发器 --'
select a.attname,
       format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull,
       coalesce(pg_get_expr(d.adbin, d.adrelid), '（无）') as default_expr
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
 where a.attrelid = 'recruitment.interview_record'::regclass
   and a.attname  = 'job_id'
   and a.attnum   > 0;

select c.conname, pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.conrelid = 'recruitment.interview_record'::regclass
   and c.conname  = 'fk_interview_record_rubric_job';

select g.tgname, pg_get_triggerdef(g.oid) as definition
  from pg_trigger g
 where g.tgrelid = 'recruitment.interview_record'::regclass
   and g.tgname  = 'trg_interview_record_job_guard'
   and not g.tgisinternal;


-- =====================================================================
--  §3  夹具（本脚本结束 ROLLBACK，不留数据）
--
--  用 0002 演示租户的既有身份链（job 401 / rubric 403 / candidate 601），
--  再补：**一个专用申请**（7a2，属于 job 401 —— 不借用演示申请 701，避免
--  库里已有的决策让本脚本无法复跑）、第二个岗位（job 402 + rubric 404）、
--  一个会议 + 一份转写、一场面试。
--  所有 id 前缀 8888，避免与其它 verify 的夹具撞号。
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 3. 夹具'
\echo '=================================================================='

-- 3.1 第二个岗位（用于"rubric 属于另一个岗位"的负向测试）
insert into recruitment.job (id, tenant_id, department_id, code, title, status)
values ('88888888-8888-4888-8888-000000000402',
        '11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-000000000010',
        'V8-JOB-2', 'V8 岗位二（另一个岗位）', 'OPEN');

insert into recruitment.job_version (id, tenant_id, job_id, version_no, description_md, payload_hash)
values ('88888888-8888-4888-8888-000000000403',
        '11111111-1111-4111-8111-000000000001',
        '88888888-8888-4888-8888-000000000402', 1, 'V8 岗位二 JD', repeat('d', 64));

insert into recruitment.rubric_version (id, tenant_id, job_id, version_no, dimensions, payload_hash)
values ('88888888-8888-4888-8888-000000000404',
        '11111111-1111-4111-8111-000000000001',
        '88888888-8888-4888-8888-000000000402', 1,
        '[{"key":"v8_other","weight":1.0}]'::jsonb, repeat('e', 64));

-- 3.2 会议 + 转写（interview_record 的 transcript 外键需要）
insert into recruitment.meeting (id, tenant_id, provider, external_meeting_id)
values ('88888888-8888-4888-8888-000000000501',
        '11111111-1111-4111-8111-000000000001', 'feishu', 'v8-mtg-1');

insert into recruitment.transcript_artifact
  (id, tenant_id, meeting_id, provider, provider_artifact_id, source_revision,
   transcript_status, provenance, trigger_mode, connection_state, raw_text)
values
  ('88888888-8888-4888-8888-000000000502',
   '11111111-1111-4111-8111-000000000001', '88888888-8888-4888-8888-000000000501',
   'feishu', 'v8-mn-1', 1, 'DISCOVERED', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED',
   '[00:00] V8 演示转写');

-- 3.3 专用申请（属于 job 401；决策夹具全挂在这条申请上，不碰演示申请 701）
insert into recruitment.application
  (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, current_stage_code)
values
  ('88888888-8888-4888-8888-0000000007a2',
   '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000601',
   '11111111-1111-4111-8111-000000000401',
   '11111111-1111-4111-8111-000000000402',
   '11111111-1111-4111-8111-000000000403',
   'S8');

-- 3.4 面试（申请 7a2 属于 job 401；不写 stage_code → 0006 的默认值 S8）
insert into recruitment.interview
  (id, tenant_id, application_id, round_no, slot_code, status,
   scheduled_start_at, scheduled_end_at)
values
  ('88888888-8888-4888-8888-000000000601',
   '11111111-1111-4111-8111-000000000001',
   '88888888-8888-4888-8888-0000000007a2', 1, 'V8', 'SCHEDULED',
   now() + interval '1 day', now() + interval '1 day 1 hour');

-- 3.5 两条"重评前"的 current 决策（SCREENING 与 FINAL 各一条；不同 scope，可并存）
insert into recruitment.decision
  (id, tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
values
  ('88888888-8888-4888-8888-000000000701',
   '11111111-1111-4111-8111-000000000001',
   '88888888-8888-4888-8888-0000000007a2', 'SCREENING', null, 'REJECT',
   '11111111-1111-4111-8111-000000000101', '旧 rubric v1 下的筛选拒绝'),
  ('88888888-8888-4888-8888-0000000007d2',
   '11111111-1111-4111-8111-000000000001',
   '88888888-8888-4888-8888-0000000007a2', 'FINAL', null, 'REJECT',
   '11111111-1111-4111-8111-000000000101', '旧 rubric v1 下的最终拒绝');

\echo ' 夹具就绪：演示租户（0002 链）+ 专用申请 7a2（job 401）+ 岗位二 402/rubric 404 + 会议 501/转写 502 + 面试 601 + 两条重评前 current 决策'


-- =====================================================================
--  §4  正向用例（约束不能把正常业务也拦掉）
--
--   P-1 是 0008 存在的理由：契约 job-rubric-rules.md:159-163 的两步重评事务
--   必须能在一个事务里做完。注意此时两条约束还是 DEFERRED（事务开始时的
--   默认状态，没人 SET CONSTRAINTS）—— 所以"INSERT 新 current"这一步必须
--   成功，而不是像 0007 那样立刻 23505。
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 4. 正向用例（合法路径必须成功）'
\echo '=================================================================='

\echo '-- P-1 契约 §5.2 步骤 1/2：INSERT 新 current（同一 (SCREENING, NULL) 键，旧行仍 current）--'
insert into recruitment.decision
  (id, tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
values
  ('88888888-8888-4888-8888-000000000703',
   '11111111-1111-4111-8111-000000000001',
   '88888888-8888-4888-8888-0000000007a2', 'SCREENING', null, 'ADVANCE',
   '11111111-1111-4111-8111-000000000101', '新 rubric v2 下的筛选通过');
\echo '   INSERT 成功 —— 0007 会在这里 23505；0008 延迟到 COMMIT 才检查'

\echo '-- P-1 契约 §5.2 步骤 2/2：UPDATE 旧行指向新行 --'
update recruitment.decision
   set superseded_by_decision_id = '88888888-8888-4888-8888-000000000703'
 where id = '88888888-8888-4888-8888-000000000701';
\echo '   UPDATE 成功（旧行只改 superseded_by_decision_id，没删、没清 result）'

\echo '-- P-2 FINAL 重评：INSERT 新 FINAL（S10）→ 旧 FINAL（NULL）指向新行 --'
insert into recruitment.decision
  (id, tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
values
  ('88888888-8888-4888-8888-000000000704',
   '11111111-1111-4111-8111-000000000001',
   '88888888-8888-4888-8888-0000000007a2', 'FINAL', 'S10', 'HIRED',
   '11111111-1111-4111-8111-000000000101', '新 rubric v2 下的最终录用');
update recruitment.decision
   set superseded_by_decision_id = '88888888-8888-4888-8888-000000000704'
 where id = '88888888-8888-4888-8888-0000000007d2';
\echo '   FINAL 重评的两步都成功（中间态有两条 current FINAL，但提交前就修好了）'

-- 下面这一句 = 把"COMMIT 时的检查"提前到当前事务内执行。
-- 通过 = 上面两个重评事务的最终状态满足两条可延迟约束（等价于 COMMIT 成功）。
\echo '-- P-1/P-2 收尾：SET CONSTRAINTS ALL IMMEDIATE（等价于 COMMIT 时的检查）--'
set constraints all immediate;
\echo '   SET CONSTRAINTS ALL IMMEDIATE 成功 —— 最终状态可提交'

do $$
declare
  v_n integer;
begin
  -- 每个 (application, scope, stage) 恰好一条 current
  select count(*) into v_n from (
    select 1 from recruitment.decision
     where application_id = '88888888-8888-4888-8888-0000000007a2'
       and superseded_by_decision_id is null
     group by decision_scope, coalesce(stage_code, '')
    having count(*) > 1) d;
  if v_n <> 0 then
    raise exception 'POS-8-01 重评后仍有 % 组重复 current', v_n;
  end if;

  select count(*) into v_n
    from recruitment.decision
   where application_id = '88888888-8888-4888-8888-0000000007a2'
     and decision_scope = 'SCREENING' and superseded_by_decision_id is null;
  if v_n <> 1 then
    raise exception 'POS-8-01 重评后 current SCREENING 应恰好 1 条（% / 1）', v_n;
  end if;
  raise notice 'POS-8-01 PASS 契约两步重评事务在同一事务内成功：SCREENING 新行 current、旧行 superseded（无 23505 / 无 23503）';

  select count(*) into v_n
    from recruitment.decision
   where application_id = '88888888-8888-4888-8888-0000000007a2'
     and decision_scope = 'FINAL' and superseded_by_decision_id is null;
  if v_n <> 1 then
    raise exception 'POS-8-02 重评后 current FINAL 应恰好 1 条（% / 1）', v_n;
  end if;
  select count(*) into v_n
    from recruitment.decision
   where application_id = '88888888-8888-4888-8888-0000000007a2'
     and decision_scope = 'FINAL' and stage_code = 'S10' and superseded_by_decision_id is null;
  if v_n <> 1 then
    raise exception 'POS-8-02 重评后的 current FINAL 应是 S10（% / 1）', v_n;
  end if;
  raise notice 'POS-8-02 PASS FINAL 重评（FINAL/NULL → FINAL/S10）也成功：每个申请仍只有一条 current FINAL';
end $$;

-- P-3/P-4：interview_record 的岗位绑定
do $$
declare
  v_job uuid;
  v_n   integer;
begin
  insert into recruitment.interview_record
    (id, tenant_id, interview_id, transcript_artifact_id, transcript_revision,
     rubric_version_id, prompt_version, model_id)
  values
    ('88888888-8888-4888-8888-000000000801',
     '11111111-1111-4111-8111-000000000001',
     '88888888-8888-4888-8888-000000000601',
     '88888888-8888-4888-8888-000000000502', 1,
     '11111111-1111-4111-8111-000000000403',
     'v8@1', 'deepseek-v4');

  select job_id into v_job from recruitment.interview_record
   where id = '88888888-8888-4888-8888-000000000801';
  if v_job is distinct from '11111111-1111-4111-8111-000000000401'::uuid then
    raise exception 'POS-8-03 不写 job_id 时没有推导出岗位一（实际 %）', v_job;
  end if;
  raise notice 'POS-8-03 PASS 不写 job_id → 触发器推导为 application.job_id = 岗位一（401）';

  insert into recruitment.interview_record
    (id, tenant_id, interview_id, transcript_artifact_id, transcript_revision,
     rubric_version_id, job_id, prompt_version, model_id, is_current)
  values
    ('88888888-8888-4888-8888-000000000802',
     '11111111-1111-4111-8111-000000000001',
     '88888888-8888-4888-8888-000000000601',
     '88888888-8888-4888-8888-000000000502', 1,
     '11111111-1111-4111-8111-000000000403',
     '11111111-1111-4111-8111-000000000401',
     'v8@1', 'deepseek-v4', false);

  select job_id into v_job from recruitment.interview_record
   where id = '88888888-8888-4888-8888-000000000802';
  if v_job is distinct from '11111111-1111-4111-8111-000000000401'::uuid then
    raise exception 'POS-8-04 显式写正确 job_id 的记录没有落库（实际 %）', v_job;
  end if;
  raise notice 'POS-8-04 PASS 显式写正确 job_id = 401 可以落库（触发器不是"只允许 NULL"）';
end $$;


-- =====================================================================
--  §5  负向用例（此时两条约束已被 SET CONSTRAINTS ALL IMMEDIATE，
--      所以冲突在语句结束时就报，逐条断言 SQLSTATE）
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 5. 负向用例（每条都必须 FAIL，并给出真实 SQLSTATE / 报错）'
\echo '=================================================================='

do $$
declare
  v_state  text;
  v_msg    text;
  v_ok     integer := 0;
  r        record;
begin
  for r in
    select * from (values
      -- ----------------------------------------------------------------
      -- GAP-A：同一 (tenant, application, scope, stage) 只能一条 current
      --   期望 23P01（排斥约束冲突）；对 0007 的旧索引是 23505 —— 两者都接受
      -- ----------------------------------------------------------------
      ('N-1', '23P01|23505', 'GAP-A INSERT 同一 (SCREENING, NULL) 的第二条 current（此刻已有一条 current）',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
          values ('11111111-1111-4111-8111-000000000001','88888888-8888-4888-8888-0000000007a2',
                  'SCREENING',null,'REJECT','11111111-1111-4111-8111-000000000101','neg N-1')$q$),

      -- ----------------------------------------------------------------
      -- GAP-B：FINAL/S10 与 FINAL/NULL 不能同时 current
      --   注意：A 的键里含 stage_code，所以这一条**不是** A 能挡的（0007 的洞）；
      --   必须是 B（(tenant, application) 上的 FINAL 唯一）挡下。
      -- ----------------------------------------------------------------
      ('N-2', '23P01|23505', 'GAP-B INSERT 第二条 current FINAL（已有 FINAL/S10 current，本条 FINAL/NULL）',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
          values ('11111111-1111-4111-8111-000000000001','88888888-8888-4888-8888-0000000007a2',
                  'FINAL',null,'ADVANCE','11111111-1111-4111-8111-000000000101','neg N-2')$q$),

      -- ----------------------------------------------------------------
      -- GAP-C：interview_record 的 rubric 必须属于该申请的岗位
      -- ----------------------------------------------------------------
      ('N-3', '23503', 'GAP-C INSERT 用岗位二的 rubric 给岗位一的面试交记录（不写 job_id，由触发器推导 job=401）',
       $q$insert into recruitment.interview_record
            (tenant_id, interview_id, transcript_artifact_id, transcript_revision,
             rubric_version_id, prompt_version, model_id, is_current)
          values ('11111111-1111-4111-8111-000000000001','88888888-8888-4888-8888-000000000601',
                  '88888888-8888-4888-8888-000000000502', 1,
                  '88888888-8888-4888-8888-000000000404','v8@1','deepseek-v4', false)$q$),

      ('N-4', '23514', 'GAP-C INSERT 显式写 job_id = 岗位二（触发器：与 interview → application 的岗位不符）',
       $q$insert into recruitment.interview_record
            (tenant_id, interview_id, transcript_artifact_id, transcript_revision,
             rubric_version_id, job_id, prompt_version, model_id, is_current)
          values ('11111111-1111-4111-8111-000000000001','88888888-8888-4888-8888-000000000601',
                  '88888888-8888-4888-8888-000000000502', 1,
                  '11111111-1111-4111-8111-000000000403',
                  '88888888-8888-4888-8888-000000000402','v8@1','deepseek-v4', false)$q$)
    ) as v(id, expect, what, sql)
  loop
    begin
      execute r.sql;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if not (v_state = any (string_to_array(r.expect, '|'))) then
        raise exception 'NEGATIVE % 失败但 SQLSTATE 不符（期望 % 实际 %）：% | %',
          r.id, r.expect, v_state, r.what, v_msg;
      end if;
      v_ok := v_ok + 1;
      raise notice '% PASS [%] => sqlstate=% | %', r.id, r.what, v_state, v_msg;
      continue;
    end;
    raise exception 'NEGATIVE % 居然成功了（应当失败）：% | SQL=%', r.id, r.what, r.sql;
  end loop;

  if v_ok <> 4 then
    raise exception 'NEGATIVE-0008 只跑了 % 条（期望 4）', v_ok;
  end if;
  raise notice 'NEGATIVE-0008 SUMMARY % 条负向测试全部按预期失败（A:1 / B:1 / C:2）', v_ok;
end $$;


-- =====================================================================
--  §6  数据面复核（全库断言）
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 6. 数据面复核'
\echo '=================================================================='

do $$
declare
  v_n   integer;
  v_bad text;
begin
  -- 6.1 没有重复的 current 决策（键含 coalesce(stage_code,'')，NULL 按相等处理）
  select count(*) into v_n from (
    select 1 from recruitment.decision
     where superseded_by_decision_id is null
     group by tenant_id, application_id, decision_scope, coalesce(stage_code, '')
    having count(*) > 1) d;
  if v_n <> 0 then
    raise exception 'DATA-0008-01 仍有 % 组重复的 current 决策', v_n;
  end if;
  raise notice 'DATA-0008-01 PASS 全库没有重复的 current 决策（NULL stage_code 也按相等处理）';

  -- 6.2 每个申请最多一条 current FINAL
  select count(*) into v_n from (
    select 1 from recruitment.decision
     where decision_scope = 'FINAL' and superseded_by_decision_id is null
     group by tenant_id, application_id
    having count(*) > 1) d;
  if v_n <> 0 then
    raise exception 'DATA-0008-02 仍有 % 个申请有 >1 条 current FINAL', v_n;
  end if;
  raise notice 'DATA-0008-02 PASS 全库每个申请最多一条 current FINAL';

  -- 6.3 没有 interview_record.job_id IS NULL
  select count(*) into v_n from recruitment.interview_record where job_id is null;
  if v_n <> 0 then
    raise exception 'DATA-0008-03 仍有 % 条 interview_record 的 job_id 为空', v_n;
  end if;
  raise notice 'DATA-0008-03 PASS 全部 interview_record 都有 job_id（NOT NULL 生效）';

  -- 6.4 没有 rubric 不属于该申请岗位的 interview_record
  select count(*) into v_n
    from recruitment.interview_record r
    join recruitment.interview i
      on i.id = r.interview_id and i.tenant_id = r.tenant_id
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
    join recruitment.rubric_version rv
      on rv.id = r.rubric_version_id and rv.tenant_id = r.tenant_id
   where rv.job_id <> a.job_id;
  if v_n <> 0 then
    raise exception 'DATA-0008-04 仍有 % 条 interview_record 用了别的岗位的 rubric', v_n;
  end if;
  raise notice 'DATA-0008-04 PASS 全部 interview_record 的 rubric 都属于该申请的岗位';

  -- 6.5 全库：多列外键全部含 tenant_id（新外键不得破 0007 §6.9 的不变量）
  select string_agg(format('%s(%s)', c.conrelid::regclass, c.conname), ', ') into v_bad
    from pg_constraint c
   where c.contype = 'f'
     and cardinality(c.conkey) > 1
     and not exists (
       select 1 from unnest(c.conkey) k
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
        where a.attname = 'tenant_id');
  if v_bad is not null then
    raise exception 'DATA-0008-05 全库仍有不含 tenant_id 的多列外键：%', v_bad;
  end if;
  raise notice 'DATA-0008-05 PASS 全库多列外键全部含 tenant_id（含本文件新增的 fk_interview_record_rubric_job）';
end $$;


-- =====================================================================
--  §7  夹具行数（脚本回滚前） + 结尾
-- =====================================================================

\echo ''
\echo '-- 夹具行数（脚本回滚前）--'
select 'decision' as t, count(*) as n from recruitment.decision
union all
select 'interview_record', count(*) from recruitment.interview_record
union all
select 'interview', count(*) from recruitment.interview
union all
select 'rubric_version', count(*) from recruitment.rubric_version
order by 1;

\echo ''
\echo '=== ROLLBACK：自检不改变数据库 ==='
rollback;

\echo ''
\echo '=================================================================='
\echo ' VERIFY-0008 PASS：7 条结构断言 + 4 条正向（含契约两步重评事务在同一事务内成功）+ 4 条负向 + 5 条数据面全部通过（A 可延迟排斥约束 / B current FINAL 唯一 / C interview_record 岗位绑定）'

