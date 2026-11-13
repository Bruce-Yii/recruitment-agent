-- =====================================================================
--  db/verify-0009.sql · 0009 自检（Issue #1 §2.4 / §5 A–G）
--  结构断言 + 正向 + 负向（真实 SQLSTATE）+ 数据面；结尾 ROLLBACK 不改数据。
-- =====================================================================
\set ON_ERROR_STOP on
begin;

-- ---------- 结构断言 ----------
do $$
declare n integer;
begin
  select count(*) into n from pg_indexes
   where schemaname='recruitment' and indexname='uq_application_active_cycle';
  if n <> 1 then raise exception 'STRUCT-0009-01 FAIL: uq_application_active_cycle 不存在'; end if;

  select count(*) into n from pg_index i join pg_class c on c.oid=i.indexrelid
   where c.relname='uq_application_active_cycle' and i.indisunique
     and pg_get_expr(i.indpred,i.indrelid) ilike '%ACTIVE%';
  if n <> 1 then raise exception 'STRUCT-0009-02 FAIL: 索引不是"仅 ACTIVE"的部分唯一索引'; end if;

  select count(*) into n from pg_trigger
   where tgname='trg_application_cycle_guard' and not tgisinternal;
  if n <> 1 then raise exception 'STRUCT-0009-03 FAIL: trg_application_cycle_guard 不存在'; end if;

  raise notice 'STRUCT-0009 PASS：3 条结构断言通过';
end $$;

-- ---------- 夹具：一个租户 / 一个候选人 / 两个岗位 ----------
do $$
declare
  t uuid := '11111111-1111-4111-8111-000000000001';
  cand uuid := 'aaaaaaaa-0000-0000-0000-0000000009c1';
  job1 uuid := 'aaaaaaaa-0000-0000-0000-0000000009a1';
  job2 uuid := 'aaaaaaaa-0000-0000-0000-0000000009a2';
  app1 uuid := 'aaaaaaaa-0000-0000-0000-0000000009b1';
  app2 uuid := 'aaaaaaaa-0000-0000-0000-0000000009b2';
begin
  -- 状态迁移必须带 actor（fn_row_guard / D-18）
  perform set_config('recruitment.actor_id', '11111111-1111-4111-8111-000000000103', true);

  insert into recruitment.candidate (id, tenant_id, display_name, identity_status)
  values (cand, t, '验证用候选人', 'ACTIVE');


  insert into recruitment.job (id, tenant_id, department_id, code, title, status)
  values (job1, t, '11111111-1111-4111-8111-000000000010', 'VERIFY-JOB-1', '验证岗位一', 'OPEN'),
         (job2, t, '11111111-1111-4111-8111-000000000010', 'VERIFY-JOB-2', '验证岗位二', 'OPEN');

  -- 每个测试岗位各建一条 job_version（fk_application_job_version_job 要求版本属于该岗位）
  insert into recruitment.job_version (id, tenant_id, job_id, version_no, description_md, payload_hash)
  values ('aaaaaaaa-0000-0000-0000-0000000009e1', t, job1, 1, '验证用岗位描述一', repeat('a',64)),
         ('aaaaaaaa-0000-0000-0000-0000000009e2', t, job2, 1, '验证用岗位描述二', repeat('b',64));

  -- 正向 1：同一 (candidate, job) 第一条 ACTIVE 可以建
  insert into recruitment.application
    (id, tenant_id, candidate_id, job_id, job_version_id, lifecycle_status, current_stage_code)
  values (app1, t, cand, job1, 'aaaaaaaa-0000-0000-0000-0000000009e1', 'ACTIVE', 'S6');
  raise notice 'POS-0009-01 PASS：第一条 ACTIVE 申请可以创建';

  -- 正向 2：同一 candidate 换岗位 → 允许（用例 D）
  insert into recruitment.application
    (id, tenant_id, candidate_id, job_id, job_version_id, lifecycle_status, current_stage_code)
  values (app2, t, cand, job2, 'aaaaaaaa-0000-0000-0000-0000000009e2', 'ACTIVE', 'S6');
  raise notice 'POS-0009-02 PASS：同一候选人不同岗位可以有独立 ACTIVE 申请（用例 D）';

  -- 负向 1：同一 (candidate, job) 第二条 ACTIVE → 23505（用例 A/B/F）
  begin
    insert into recruitment.application
      (tenant_id, candidate_id, job_id, job_version_id, lifecycle_status, current_stage_code)
    values (t, cand, job1, 'aaaaaaaa-0000-0000-0000-0000000009e1', 'ACTIVE', 'S6');
    raise exception 'NEG-0009-01 FAIL：第二条 ACTIVE 竟然创建成功';
  exception when unique_violation then
    raise notice 'NEG-0009-01 PASS：第二条 ACTIVE 被拒 => sqlstate=23505';
  end;

  -- 负向 2：已 CLOSED 的申请改回 ACTIVE → 23514（周期不可复活）
  update recruitment.application set lifecycle_status='CLOSED' where id=app2;
  begin
    update recruitment.application set lifecycle_status='ACTIVE' where id=app2;
    raise exception 'NEG-0009-02 FAIL：CLOSED 竟然改回 ACTIVE';
  exception when check_violation then
    raise notice 'NEG-0009-02 PASS：已结束周期不得复活 => sqlstate=23514';
  end;

  -- 正向 3：周期结束后显式再申请 → 新的 ACTIVE 允许（用例 E）
  insert into recruitment.application
    (tenant_id, candidate_id, job_id, job_version_id, lifecycle_status, current_stage_code)
  values (t, cand, job2, 'aaaaaaaa-0000-0000-0000-0000000009e2', 'ACTIVE', 'S6');
  raise notice 'POS-0009-03 PASS：上一周期结束后可再次申请（用例 E）';

  -- 负向 3：改申请所属候选人 → 23514
  begin
    update recruitment.application set candidate_id = gen_random_uuid() where id = app1;
    raise exception 'NEG-0009-03 FAIL：候选人被改成功了';
  exception when check_violation then
    raise notice 'NEG-0009-03 PASS：申请所属候选人不可改 => sqlstate=23514';
  end;
end $$;

-- ---------- 数据面 ----------
do $$
declare n integer;
begin
  select count(*) into n from (
    select tenant_id, candidate_id, job_id from recruitment.application
     where lifecycle_status='ACTIVE'
     group by 1,2,3 having count(*)>1
  ) d;
  if n <> 0 then raise exception 'DATA-0009 FAIL: 仍有 % 组重复 ACTIVE 申请', n; end if;
  raise notice 'DATA-0009 PASS：全库无重复 ACTIVE 申请';
end $$;

rollback;

\echo ' VERIFY-0009 PASS：3 条结构断言 + 3 条正向（含用例 D/E）+ 3 条负向（23505/23514/23514）+ 1 条数据面全部通过'
