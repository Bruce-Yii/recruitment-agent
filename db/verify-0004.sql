-- =====================================================================
--  recruitment-agent · db/verify-0004.sql
--  0004_stage_catalog.sql 的专项自检：正向断言 + 负向测试（逐条断言 SQLSTATE）
--
--  用法（必须 psql，本文件含 \echo 元命令）：
--    psql -v ON_ERROR_STOP=1 -d ra_stage_check -f db/verify-0004.sql
--
--  前提：同一个库已按序跑过 0001_init.sql → 0002_seed.sql → 0004_stage_catalog.sql
--
--  行为保证：
--    * 整个脚本一个事务，结尾 ROLLBACK —— **不改变数据库任何一行**；
--    * 任何断言不满足 → RAISE EXCEPTION → exit != 0；
--    * 负向测试打印的是数据库真实返回的 SQLSTATE + message_text（不是自述）。
--
--  与 db/verify.sql 的分工：verify.sql 断言 0001 的 39 表结构 / 状态机 / 32 条
--  负向测试；本文件只断言 0004 新增的东西（stage_catalog + 两个外键 + 回填）。
-- =====================================================================

\set ON_ERROR_STOP on
\echo '=================================================================='
\echo ' verify-0004 · 0. 环境'
\echo '=================================================================='

select current_database() as database,
       current_setting('server_version') as pg_version,
       to_regclass('recruitment.stage_catalog') is not null as stage_catalog_exists,
       exists (select 1 from information_schema.columns
                where table_schema = 'recruitment' and table_name = 'job'
                  and column_name = 'current_rubric_version_id') as job_rubric_column_exists;

begin;

-- 0009 之后 (tenant, candidate, job) 只能有一条 ACTIVE 申请。负例夹具必须用**专属候选人**，
-- 否则 23505（uq_application_active_cycle）会抢在 23503（fk_application_stage_catalog）前面，
-- 断言失败——这不是迁移错，是 verify 脚本没有"在 0001→N 全链上可重放"。
insert into recruitment.candidate (id, tenant_id, display_name)
values ('dddddddd-dddd-4ddd-8ddd-0000000006f1',
        '11111111-1111-4111-8111-000000000001', 'V4 负例候选人（合成）');
\echo ''
\echo '=================================================================='
\echo ' verify-0004 · 1. 本迁移新增的对象（约束定义原文）'
\echo '=================================================================='

select c.relname as tbl, p.conname as constraint_name, p.contype as kind,
       pg_get_constraintdef(p.oid) as definition
  from pg_constraint p
  join pg_class c on c.oid = p.conrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'recruitment'
   and p.conname in ('fk_application_stage_catalog', 'fk_job_current_rubric',
                     'uq_rubric_version_tenant_job_id',
                     'uq_stage_catalog_tenant_code', 'uq_stage_catalog_tenant_order',
                     'ck_stage_catalog_code', 'ck_stage_catalog_name',
                     'ck_stage_catalog_sort_order')
 order by 1, 2;

\echo '-- application.current_stage_code 的默认值（D-22 后不应再是 SCREENING）--'
select column_name, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'recruitment' and table_name = 'application'
   and column_name = 'current_stage_code';

\echo '-- stage_catalog 全量（应当正好 12 行，S1..S12） --'
select code, name, sort_order, in_v1_scope
  from recruitment.stage_catalog
 where tenant_id = '11111111-1111-4111-8111-000000000001'
 order by sort_order;

\echo '-- job.current_rubric_version_id 回填结果（应与 rubric 的 job_id 相同） --'
select j.id as job_id, j.code, j.record_version,
       j.current_rubric_version_id, rv.job_id as rubric_job_id, rv.version_no
  from recruitment.job j
  left join recruitment.rubric_version rv on rv.id = j.current_rubric_version_id
 where j.id = '11111111-1111-4111-8111-000000000401';


\echo ''
\echo '=================================================================='
\echo ' verify-0004 · 2. 正向断言（任何一条不满足即整体失败）'
\echo '=================================================================='

do $$
declare
  v_tenant   constant uuid := '11111111-1111-4111-8111-000000000001';
  v_n        integer;
  v_codes    text[];
  v_bad      text;
  v_def      text;
begin
  -- 2.1 目录 12 行，code 恰为 S1..S12（顺序 = sort_order 升序）
  select array_agg(code order by sort_order) into v_codes
    from recruitment.stage_catalog where tenant_id = v_tenant;
  if v_codes is distinct from array['S1','S2','S3','S4','S5','S6','S7','S8','S9','S10','S11','S12'] then
    raise exception 'V4-01 stage_catalog 的 code 序列不是 S1..S12：%', v_codes;
  end if;

  select count(*) into v_n from recruitment.stage_catalog where tenant_id = v_tenant;
  if v_n <> 12 then
    raise exception 'V4-01 stage_catalog 应为 12 行，实际 %', v_n;
  end if;

  select count(*) into v_n
    from recruitment.stage_catalog
   where tenant_id = v_tenant and sort_order between 1 and 12;
  if v_n <> 12 then
    raise exception 'V4-01 有 sort_order 不在 1..12 的行（% 行合规）', v_n;
  end if;
  raise notice 'V4-01 PASS stage_catalog = 12 行 / code S1..S12 / sort_order 1..12';

  -- 2.2 in_v1_scope 与 0002 的配置一致：true 的只有 S3/S6/S7/S8/S9/S10
  select array_agg(code order by sort_order) into v_codes
    from recruitment.stage_catalog
   where tenant_id = v_tenant and in_v1_scope;
  if v_codes is distinct from array['S3','S6','S7','S8','S9','S10'] then
    raise exception 'V4-02 in_v1_scope=true 的阶段不是 S3/S6/S7/S8/S9/S10：%', v_codes;
  end if;
  raise notice 'V4-02 PASS in_v1_scope：true = S3,S6,S7,S8,S9,S10（其余 false）';

  -- 2.3 逐字一致：表 vs 0002 的 business_config.stage_catalog（双向 EXCEPT，两边都必须为空）
  with cfg as (
    select s.stage ->> 'code'                 as code,
           s.stage ->> 'name'                 as name,
           (s.stage ->> 'order')::integer     as sort_order,
           (s.stage ->> 'in_v1_scope')::boolean as in_v1_scope
      from recruitment.business_config c
      cross join lateral jsonb_array_elements(c.payload -> 'stages') as s(stage)
     where c.tenant_id = v_tenant
       and c.scope = 'ORGANIZATION'
       and c.config_key = 'stage_catalog'
  ), tbl as (
    select code, name, sort_order, in_v1_scope
      from recruitment.stage_catalog where tenant_id = v_tenant
  ), diff as (
    (select * from tbl except select * from cfg)
    union all
    (select * from cfg except select * from tbl)
  )
  select string_agg(format('%s/%s/order=%s/scope=%s', code, name, sort_order, in_v1_scope), '; ')
    into v_bad
    from diff;
  if v_bad is not null then
    raise exception 'V4-03 stage_catalog 与 business_config.stage_catalog 不一致：%', v_bad;
  end if;
  raise notice 'V4-03 PASS 目录表与 0002 的配置逐字一致（code/name/order/in_v1_scope）';

  -- 2.4 外键确实存在，且列组合正确
  select pg_get_constraintdef(p.oid) into v_def
    from pg_constraint p
   where p.conname = 'fk_application_stage_catalog'
     and p.conrelid = 'recruitment.application'::regclass;
  if v_def is null or v_def not like '%FOREIGN KEY (tenant_id, current_stage_code)%'
     or v_def not like '%REFERENCES recruitment.stage_catalog(tenant_id, code)%' then
    raise exception 'V4-04 fk_application_stage_catalog 定义不符：%', coalesce(v_def, '（不存在）');
  end if;

  select pg_get_constraintdef(p.oid) into v_def
    from pg_constraint p
   where p.conname = 'fk_job_current_rubric'
     and p.conrelid = 'recruitment.job'::regclass;
  if v_def is null or v_def not like '%FOREIGN KEY (tenant_id, id, current_rubric_version_id)%'
     or v_def not like '%REFERENCES recruitment.rubric_version(tenant_id, job_id, id)%' then
    raise exception 'V4-04 fk_job_current_rubric 定义不符：%', coalesce(v_def, '（不存在）');
  end if;
  raise notice 'V4-04 PASS 两个外键的列组合与目标唯一键都正确';

  -- 2.5 0002 的 job 已回填到"属于它自己"的 rubric
  select j.current_rubric_version_id into v_def
    from recruitment.job j
   where j.id = '11111111-1111-4111-8111-000000000401';
  if v_def is null then
    raise exception 'V4-05 demo job 的 current_rubric_version_id 仍为空（回填未生效）';
  end if;
  select count(*) into v_n
    from recruitment.job j
    join recruitment.rubric_version rv
      on rv.id = j.current_rubric_version_id
     and rv.job_id = j.id
     and rv.tenant_id = j.tenant_id
   where j.id = '11111111-1111-4111-8111-000000000401';
  if v_n <> 1 then
    raise exception 'V4-05 回填的 rubric 不属于该 job（命中 % 行）', v_n;
  end if;
  raise notice 'V4-05 PASS demo job 的当前 rubric 已回填，且属于同一 job（% 行）', v_n;

  -- 2.6 现有 application 的 stage code 全部在目录里（外键的前置条件，独立复核一遍）
  select string_agg(format('%s=%s', a.id, a.current_stage_code), '; ') into v_bad
    from recruitment.application a
   where not exists (select 1 from recruitment.stage_catalog s
                      where s.tenant_id = a.tenant_id and s.code = a.current_stage_code);
  if v_bad is not null then
    raise exception 'V4-06 仍有 application 指向目录外的 stage code：%', v_bad;
  end if;
  raise notice 'V4-06 PASS 现有 application 的 stage code 全部在 stage_catalog 内';
end $$;


\echo ''
\echo '=================================================================='
\echo ' verify-0004 · 3. 负向测试夹具（本事务结束 ROLLBACK，不留数据）'
\echo '=================================================================='

-- 3.1 一个"别的租户"：用来证明外键是**按租户**生效的
insert into recruitment.organization (id, name)
values ('33333333-3333-4333-8333-000000000001', '校验用租户（verify-0004，回滚）');

insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
values ('33333333-3333-4333-8333-000000000001', 'SX1', '校验用阶段', 1, false);

-- 3.2 第二个岗位 + 它自己的 rubric：用来证明"不能指向别的 job 的 rubric"
insert into recruitment.job (id, tenant_id, department_id, code, title)
values ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
        '11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-000000000010',
        'VERIFY-0004-JOB2', '第二个岗位（verify-0004 用，回滚）');

insert into recruitment.rubric_version (id, tenant_id, job_id, version_no, dimensions, payload_hash)
values ('bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
        '11111111-1111-4111-8111-000000000001',
        'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
        1, '[{"key":"x","label":"x","kind":"MUST_HAVE","weight":1.0}]'::jsonb, repeat('a', 64));


\echo ''
\echo '=================================================================='
\echo ' verify-0004 · 4. 负向测试（每条断言 SQLSTATE，且断言命中的约束名）'
\echo '=================================================================='

do $$
declare
  r       record;
  v_ok    integer := 0;
  v_state text;
  v_msg   text;
begin
  for r in
    select * from (values
      ('NV-01', '23503', 'fk_application_stage_catalog',
       '写一个不存在的 stage code（S99）→ 外键拒绝',
       $q$insert into recruitment.application
            (tenant_id, candidate_id, job_id, job_version_id, current_stage_code)
          values ('11111111-1111-4111-8111-000000000001',
                  'dddddddd-dddd-4ddd-8ddd-0000000006f1',
                  '11111111-1111-4111-8111-000000000401',
                  '11111111-1111-4111-8111-000000000402', 'S99')$q$),

      ('NV-02', '23503', 'fk_job_current_rubric',
       'current_rubric_version_id 指向**别的 job** 的 rubric → 复合外键拒绝',
       $q$update recruitment.job
             set current_rubric_version_id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002'
           where id = '11111111-1111-4111-8111-000000000401'$q$),

      ('NV-03', '23505', 'uq_stage_catalog_tenant_code',
       '插入重复 stage code（同租户再插一次 SX1）→ 唯一约束拒绝',
       $q$insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
          values ('33333333-3333-4333-8333-000000000001', 'SX1', '重复阶段', 2, false)$q$),

      ('NV-04', '23503', 'fk_application_stage_catalog',
       '删除被 application 引用的 stage code（S7）→ 外键 RESTRICT 拒绝',
       $q$delete from recruitment.stage_catalog
           where tenant_id = '11111111-1111-4111-8111-000000000001' and code = 'S7'$q$),

      ('NV-05', '23505', 'uq_stage_catalog_tenant_order',
       '同一租户两个阶段占同一 sort_order（=1）→ 唯一约束拒绝（顺序不得歧义）',
       $q$insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
          values ('33333333-3333-4333-8333-000000000001', 'SX2', '顺序冲突', 1, false)$q$),

      ('NV-06', '23514', 'ck_stage_catalog_sort_order',
       'sort_order 越界（13，v1.0 只允许 1..12）→ CHECK 拒绝',
       $q$insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
          values ('33333333-3333-4333-8333-000000000001', 'SX3', '越界阶段', 13, false)$q$),

      ('NV-07', '23514', 'ck_stage_catalog_code',
       'stage code 格式非法（stage7，小写）→ CHECK 拒绝',
       $q$insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
          values ('33333333-3333-4333-8333-000000000001', 'stage7', '格式非法', 5, false)$q$),

      ('NV-08', '23503', 'fk_application_stage_catalog',
       '用别的租户才有的 stage code（SX1）→ 外键拒绝（目录按租户隔离）',
       $q$insert into recruitment.application
            (tenant_id, candidate_id, job_id, job_version_id, current_stage_code)
          values ('11111111-1111-4111-8111-000000000001',
                  'dddddddd-dddd-4ddd-8ddd-0000000006f1',
                  '11111111-1111-4111-8111-000000000401',
                  '11111111-1111-4111-8111-000000000402', 'SX1')$q$)
    ) as v(id, expect, conname, what, sql)
  loop
    begin
      execute r.sql;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state <> r.expect then
        raise exception 'NEGATIVE % 失败但 SQLSTATE 不符（期望 % 实际 %）：% | %',
          r.id, r.expect, v_state, r.what, v_msg;
      end if;
      if r.conname is not null and v_msg not like '%' || r.conname || '%' then
        raise exception 'NEGATIVE % 的 SQLSTATE 对了，但不是预期约束 % 拦下的：% | %',
          r.id, r.conname, r.what, v_msg;
      end if;
      v_ok := v_ok + 1;
      raise notice '% PASS [%] => sqlstate=% | %', r.id, r.what, v_state, v_msg;
      continue;
    end;
    raise exception 'NEGATIVE % 居然成功了（应当失败）：% | SQL=%', r.id, r.what, r.sql;
  end loop;

  raise notice 'NEGATIVE SUMMARY % 条负向测试全部按预期失败（SQLSTATE 全对）', v_ok;
end $$;


\echo ''
\echo '=================================================================='
\echo ' verify-0004 · 5. 正向断言：外键没有把合法路径堵死'
\echo '=================================================================='

do $$
declare
  v_n integer;
begin
  -- 5.1 目录内的 code 可以正常插入申请（同一 candidate/job 允许多次申请，无唯一约束）
  insert into recruitment.application
    (id, tenant_id, candidate_id, job_id, job_version_id, current_stage_code)
  values ('cccccccc-cccc-4ccc-8ccc-000000000001',
          '11111111-1111-4111-8111-000000000001',
          'dddddddd-dddd-4ddd-8ddd-0000000006f1',
          '11111111-1111-4111-8111-000000000401',
          '11111111-1111-4111-8111-000000000402', 'S6');

  -- 5.2 目录内的阶段迁移可以正常走（S6 → S7，带 actor，触发器写内部事件）
  perform set_config('recruitment.actor_id', '11111111-1111-4111-8111-000000000103', true);
  update recruitment.application
     set current_stage_code = 'S7'
   where id = 'cccccccc-cccc-4ccc-8ccc-000000000001';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'POS-01 合法阶段迁移 S6→S7 影响 % 行（期望 1）', v_n;
  end if;

  -- 5.3 当前 rubric 指针可以指向本 job 的更早版本（回滚场景，D-21 的核心用例）
  update recruitment.job
     set current_rubric_version_id = '11111111-1111-4111-8111-000000000403'
   where id = '11111111-1111-4111-8111-000000000401';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'POS-02 指向本 job 的 rubric 被拒（影响 % 行，期望 1）', v_n;
  end if;

  raise notice 'POS-01/02 PASS 合法写入与合法回滚都不被外键阻塞';
end $$;


\echo ''
\echo '=== ROLLBACK：自检不改变数据库 ==='
rollback;

\echo ''
\echo '=================================================================='
\echo ' VERIFY-0004 PASS：目录 12 行 / 双向逐字一致 / 两个外键 / 8 条负向测试全部按预期失败'
\echo '=================================================================='
