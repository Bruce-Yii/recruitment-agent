-- =====================================================================
--  recruitment-agent · db/verify-0005.sql
--  0005_version_binding.sql 的自检脚本（D-49 / J 线 S-3）
--
--  用法（必须用 psql 跑，本文件含 \echo 等 psql 元命令）：
--    psql -v ON_ERROR_STOP=1 -d <db> -f db/verify-0005.sql
--
--  行为保证：
--    * 整个脚本在一个事务里执行，结尾 ROLLBACK —— 不留任何数据；
--    * 所有断言失败都会 RAISE EXCEPTION（exit code != 0），不会静默通过；
--    * 负向测试打印的是数据库**真实返回的 SQLSTATE 与 message_text**，
--      不是脚本自己编的期望值。
--
--  验证的是"申请能不能指向别的岗位的版本"这一个漏洞被堵住了：
--    §1 结构断言：外键形态（含 job_id + tenant_id、restrict、validated）、旧外键已退场、
--                  不存在"绕过 job_id"的后门外键
--    §2 夹具：两个租户 / 三个岗位（同一租户内两个岗位 + 另一个租户一个岗位）
--    §3 改造后的外键清单（真实 pg_get_constraintdef）
--    §4 正向：同 job 引用必须**成功**（约束不能把正常业务也拦掉）
--    §5 负向：跨 job / 跨租户引用、改 job_id、改版本归属 → 必须被拒绝，断言 SQLSTATE
--    §6 删除被引用的版本：触发器路径（23514）与外键 RESTRICT 路径（23503）都要拦
--    §7 数据面复核 + 被引用键在位
--
--  与 0004 的关系：本脚本**不依赖** 0004。若库里有 stage_catalog（0004 已跑），
--  自动给夹具租户补 12 行阶段目录，让 application 的默认阶段值能过外键；
--  没有 0004 时整块跳过（0001 的默认值是 'SCREENING'，只受正则约束）。
-- =====================================================================

\set ON_ERROR_STOP on

\echo '=================================================================='
\echo ' 0. 环境'
\echo '=================================================================='

select current_database() as database,
       current_setting('server_version') as pg_version,
       (select count(*) from pg_constraint
         where conrelid = 'recruitment.application'::regclass and contype = 'f') as application_fks;

begin;


-- =====================================================================
--  §1  结构断言
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 1. 结构断言（任何一条不满足即整体失败）'
\echo '=================================================================='

do $$
declare
  v_bad text;
  r     record;
begin
  -- 1.1 F-01/F-02：新复合外键必须存在，且 conkey / confkey / 动作 / 验证状态全对
  --     conkey 要求含 tenant_id（STRUCT-07）、job_id（"钉版本"本体）与版本列。
  for r in
    select * from (values
      ('fk_application_rubric_job',      'rubric_version', 'rubric_version_id'),
      ('fk_application_job_version_job', 'job_version',    'job_version_id')
    ) as v(conname, reftbl, ver_col)
  loop
    if not exists (
      select 1
        from pg_constraint c
       where c.conname  = r.conname
         and c.conrelid = 'recruitment.application'::regclass
         and c.contype  = 'f'
         and c.confrelid = format('recruitment.%I', r.reftbl)::regclass
         and c.convalidated
         and c.confdeltype = 'r'     -- ON DELETE RESTRICT
         and c.confupdtype = 'r'     -- ON UPDATE RESTRICT
         and (select array_agg(a.attname::text order by a.attname)
                from pg_attribute a
               where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
             = (select array_agg(x order by x)
                  from unnest(array['tenant_id', r.ver_col, 'job_id']) as x)
         and (select array_agg(a.attname::text order by a.attname)
                from pg_attribute a
               where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
             = (select array_agg(x order by x)
                  from unnest(array['tenant_id', 'id', 'job_id']) as x)
    ) then
      select string_agg(format('%s: %s', c.conname, pg_get_constraintdef(c.oid)), '; ')
        into v_bad
        from pg_constraint c
       where c.conrelid = 'recruitment.application'::regclass
         and c.conname in (r.conname);
      raise exception 'F-01 % 不存在或形态不对（期望 (tenant_id, %, job_id) → %(tenant_id, id, job_id)，restrict/restrict/validated）。实际：%',
        r.conname, r.ver_col, r.reftbl, coalesce(v_bad, '（无此约束）');
    end if;
    raise notice 'F-01 PASS %：(tenant_id, %, job_id) → %(tenant_id, id, job_id)，restrict/validated',
      r.conname, r.ver_col, r.reftbl;
  end loop;

  -- 1.2 F-03：旧外键必须已退场（两套并存 = 日后必然漂移）
  select string_agg(c.conname, ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.application'::regclass
     and c.conname in ('fk_application_rubric', 'fk_application_job_version');
  if v_bad is not null then
    raise exception 'F-03 旧版本外键仍在：%（0005 未完成或被人加回来了）', v_bad;
  end if;
  raise notice 'F-03 PASS 旧外键 fk_application_rubric / fk_application_job_version 已退场';

  -- 1.3 F-04：不存在"绕过 job_id"的后门外键
  select string_agg(format('%s(%s)', c.conname, pg_get_constraintdef(c.oid)), ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.application'::regclass
     and c.contype = 'f'
     and (select array_agg(a.attname::text)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         && array['rubric_version_id', 'job_version_id']::text[]
     and not (select array_agg(a.attname::text)
                from pg_attribute a
               where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
             @> array['job_id']::text[];
  if v_bad is not null then
    raise exception 'F-04 存在不含 job_id 的版本外键（跨岗位后门）：%', v_bad;
  end if;
  raise notice 'F-04 PASS 没有"不含 job_id 的版本外键"';

  -- 1.4 U-01：D-49 第 1 条字面要求 unique (id, job_id)
  for r in
    select * from (values ('rubric_version'), ('job_version')) as v(tbl)
  loop
    if not exists (
      select 1 from pg_constraint c
       where c.conrelid = format('recruitment.%I', r.tbl)::regclass
         and c.contype = 'u'
         and (select array_agg(a.attname::text order by a.attname)
                from pg_attribute a
               where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
             = array['id', 'job_id']::text[])
    then
      raise exception 'U-01 % 缺少 unique (id, job_id)', r.tbl;
    end if;
    raise notice 'U-01 PASS % 有 unique (id, job_id)', r.tbl;
  end loop;

  -- 1.5 U-02：外键的被引用键必须有唯一约束（3 列，含 tenant_id）
  for r in
    select * from (values ('rubric_version'), ('job_version')) as v(tbl)
  loop
    if not exists (
      select 1 from pg_constraint c
       where c.conrelid = format('recruitment.%I', r.tbl)::regclass
         and c.contype = 'u'
         and (select array_agg(a.attname::text order by a.attname)
                from pg_attribute a
               where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
             = array['id', 'job_id', 'tenant_id']::text[])
    then
      raise exception 'U-02 % 缺少 unique (tenant_id, id, job_id)（3 列外键的被引用键）', r.tbl;
    end if;
    raise notice 'U-02 PASS % 有 unique (tenant_id, id, job_id)', r.tbl;
  end loop;

  raise notice 'STRUCT PASS 0005 的结构断言全部通过';
end $$;


-- =====================================================================
--  §2  夹具
--      T1：job1 / job2 两个岗位（同一租户 —— 跨岗位引用就发生在这里）
--      T2：job9（跨租户用）
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 2. 夹具（脚本结束 ROLLBACK，不留数据）'
\echo '=================================================================='

insert into recruitment.organization (id, name) values
  ('dddddddd-dddd-4ddd-8ddd-000000000001', 'V5 租户甲'),
  ('dddddddd-dddd-4ddd-8ddd-000000000002', 'V5 租户乙');

-- 若 0004 已跑：application.current_stage_code 有外键到 stage_catalog，夹具租户必须有目录
do $$
declare
  v_tenant uuid;
begin
  if to_regclass('recruitment.stage_catalog') is null then
    raise notice 'SKIP stage_catalog 不存在（未跑 0004）→ application 用 0001 的默认阶段值';
    return;
  end if;
  foreach v_tenant in array array['dddddddd-dddd-4ddd-8ddd-000000000001',
                                 'dddddddd-dddd-4ddd-8ddd-000000000002']::uuid[]
  loop
    insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
    select v_tenant, s.code, s.name, s.ord, s.v1
      from (values ('S1','招聘需求发现',1,false), ('S2','Requisition 创建与审批',2,false),
                   ('S3','Job / JD / Rubric 设计',3,true), ('S4','Job Posting 发布',4,false),
                   ('S5','人才获取 / Sourcing',5,false), ('S6','简历接入与处理（Intake）',6,true),
                   ('S7','初筛 / Screening',7,true), ('S8','面试规划与排期',8,true),
                   ('S9','面试执行与材料获取',9,true), ('S10','综合评价与招聘决策',10,true),
                   ('S11','Offer 与入职交接',11,false), ('S12','人才沉淀与复盘',12,false)
            ) as s(code, name, ord, v1)
    on conflict (tenant_id, code) do nothing;
  end loop;
  raise notice '夹具：stage_catalog 已补（0004 存在）';
end $$;

insert into recruitment.department (id, tenant_id, name) values
  ('dddddddd-dddd-4ddd-8ddd-000000000011', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'V5 甲-研发部'),
  ('dddddddd-dddd-4ddd-8ddd-000000000012', 'dddddddd-dddd-4ddd-8ddd-000000000002', 'V5 乙-研发部');

-- 两个租户、三个岗位：job1 与 job2 同租户（跨岗位引用），job9 属另一个租户（跨租户引用）
insert into recruitment.job (id, tenant_id, department_id, code, title) values
  ('dddddddd-dddd-4ddd-8ddd-000000000021', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000011', 'V5-JOB-1', 'V5 岗位一（甲）'),
  ('dddddddd-dddd-4ddd-8ddd-000000000022', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000011', 'V5-JOB-2', 'V5 岗位二（甲）'),
  ('dddddddd-dddd-4ddd-8ddd-000000000023', 'dddddddd-dddd-4ddd-8ddd-000000000002',
   'dddddddd-dddd-4ddd-8ddd-000000000012', 'V5-JOB-9', 'V5 岗位九（乙）');

insert into recruitment.job_version (id, tenant_id, job_id, version_no, description_md, payload_hash) values
  ('dddddddd-dddd-4ddd-8ddd-000000000031', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000021', 1, 'V5 JD v1（岗位一）', repeat('a', 64)),
  ('dddddddd-dddd-4ddd-8ddd-000000000032', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000022', 1, 'V5 JD v1（岗位二）', repeat('b', 64)),
  ('dddddddd-dddd-4ddd-8ddd-000000000033', 'dddddddd-dddd-4ddd-8ddd-000000000002',
   'dddddddd-dddd-4ddd-8ddd-000000000023', 1, 'V5 JD v1（岗位九）', repeat('c', 64));

insert into recruitment.rubric_version (id, tenant_id, job_id, version_no, dimensions, payload_hash) values
  ('dddddddd-dddd-4ddd-8ddd-000000000041', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000021', 1, '[{"key":"v5_a","weight":1.0}]'::jsonb, repeat('d', 64)),
  ('dddddddd-dddd-4ddd-8ddd-000000000042', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000022', 1, '[{"key":"v5_b","weight":1.0}]'::jsonb, repeat('e', 64)),
  ('dddddddd-dddd-4ddd-8ddd-000000000043', 'dddddddd-dddd-4ddd-8ddd-000000000002',
   'dddddddd-dddd-4ddd-8ddd-000000000023', 1, '[{"key":"v5_c","weight":1.0}]'::jsonb, repeat('f', 64));

insert into recruitment.candidate (id, tenant_id, display_name, normalized_email) values
  ('dddddddd-dddd-4ddd-8ddd-000000000051', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'V5 候选人甲', 'v5-c1@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000052', 'dddddddd-dddd-4ddd-8ddd-000000000002', 'V5 候选人乙', 'v5-c2@example.test');

\echo ' 夹具就绪：T1 = job1(021)/job2(022)，T2 = job9(023)；版本各 1 行'


-- =====================================================================
--  §3  改造后的外键清单（真实定义，作为"改造后"证据）
-- =====================================================================

\echo ''
\echo '-- application 上与版本相关的外键（改造后，真实 pg_get_constraintdef）--'
select c.conname,
       c.convalidated as validated,
       c.confdeltype  as on_delete,
       pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.conrelid = 'recruitment.application'::regclass
   and c.contype = 'f'
   and (select array_agg(a.attname::text)
          from pg_attribute a
         where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
       && array['rubric_version_id', 'job_version_id']::text[]
 order by 1;

\echo '-- rubric_version / job_version 上的唯一键（被引用键）--'
select c.conrelid::regclass as tbl, c.conname,
       pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.conrelid in ('recruitment.rubric_version'::regclass, 'recruitment.job_version'::regclass)
   and c.contype = 'u'
   and (select array_agg(a.attname::text order by a.attname)
          from pg_attribute a
         where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
       in (array['id', 'job_id']::text[], array['id', 'job_id', 'tenant_id']::text[])
 order by 1, 2;

\echo '-- 旧外键（应回空集）--'
select c.conname
  from pg_constraint c
 where c.conrelid = 'recruitment.application'::regclass
   and c.conname in ('fk_application_rubric', 'fk_application_job_version');


-- =====================================================================
--  §4  正向用例：约束不能把正常业务也拦掉
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 4. 正向用例（同岗位引用必须成功）'
\echo '=================================================================='

do $$
declare
  v_n integer;
begin
  -- 4.1 同 job 的 job_version + rubric → 必须成功
  insert into recruitment.application (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id)
  values ('dddddddd-dddd-4ddd-8ddd-000000000061', 'dddddddd-dddd-4ddd-8ddd-000000000001',
          'dddddddd-dddd-4ddd-8ddd-000000000051', 'dddddddd-dddd-4ddd-8ddd-000000000021',
          'dddddddd-dddd-4ddd-8ddd-000000000031', 'dddddddd-dddd-4ddd-8ddd-000000000041');

  select count(*) into v_n from recruitment.application
   where id = 'dddddddd-dddd-4ddd-8ddd-000000000061';
  if v_n <> 1 then
    raise exception 'POS-05-01 同 job 引用竟然没插进去（% 行）', v_n;
  end if;
  raise notice 'POS-05-01 PASS 同 job 的 (job_version, rubric) 引用成功落库';

  -- 4.2 rubric 可空：还没定评分标准的申请仍然可以存在（MATCH SIMPLE 语义不变）
  insert into recruitment.application (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id)
  values ('dddddddd-dddd-4ddd-8ddd-000000000062', 'dddddddd-dddd-4ddd-8ddd-000000000001',
          'dddddddd-dddd-4ddd-8ddd-000000000051', 'dddddddd-dddd-4ddd-8ddd-000000000021',
          'dddddddd-dddd-4ddd-8ddd-000000000031', null);

  select count(*) into v_n from recruitment.application
   where id = 'dddddddd-dddd-4ddd-8ddd-000000000062';
  if v_n <> 1 then
    raise exception 'POS-05-02 rubric 为空的申请竟然插不进去（% 行）', v_n;
  end if;
  raise notice 'POS-05-02 PASS rubric_version_id 为空时外键不检查（MATCH SIMPLE，可空语义不变）';

  -- 4.3 同岗位的第二条申请（同 job、同版本）也应成功
  insert into recruitment.application (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id)
  values ('dddddddd-dddd-4ddd-8ddd-000000000063', 'dddddddd-dddd-4ddd-8ddd-000000000001',
          'dddddddd-dddd-4ddd-8ddd-000000000051', 'dddddddd-dddd-4ddd-8ddd-000000000022',
          'dddddddd-dddd-4ddd-8ddd-000000000032', 'dddddddd-dddd-4ddd-8ddd-000000000042');
  raise notice 'POS-05-03 PASS 岗位二自己的版本组合也成功（约束不是"只允许一条"）';
end $$;


-- =====================================================================
--  §5  负向用例：跨岗位 / 跨租户的版本引用必须被拒绝（断言 SQLSTATE）
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 5. 负向用例（每条都必须 FAIL，并给出真实 SQLSTATE / 报错）'
\echo '=================================================================='

do $$
declare
  v_state text;
  v_msg   text;
  v_ok    boolean;
  r       record;
begin
  for r in
    select * from (values
      ('V5-01', '23503', '申请指向**别的 job** 的 rubric（同租户：job1 的申请钉 job2 的 rubric）',
       $q$insert into recruitment.application (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000051',
                  'dddddddd-dddd-4ddd-8ddd-000000000021','dddddddd-dddd-4ddd-8ddd-000000000031',
                  'dddddddd-dddd-4ddd-8ddd-000000000042')$q$),

      ('V5-02', '23503', '申请指向**别的 job** 的 job_version（job1 的申请钉 job2 的 JD 版本）',
       $q$insert into recruitment.application (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000051',
                  'dddddddd-dddd-4ddd-8ddd-000000000021','dddddddd-dddd-4ddd-8ddd-000000000032',
                  'dddddddd-dddd-4ddd-8ddd-000000000041')$q$),

      ('V5-03', '23503', '反方向：job2 的申请钉 job1 的 rubric',
       $q$insert into recruitment.application (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000051',
                  'dddddddd-dddd-4ddd-8ddd-000000000022','dddddddd-dddd-4ddd-8ddd-000000000032',
                  'dddddddd-dddd-4ddd-8ddd-000000000041')$q$),

      ('V5-04', '23503', '跨租户：甲租户的申请钉乙租户的 rubric（job9 的 rubric）',
       $q$insert into recruitment.application (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000051',
                  'dddddddd-dddd-4ddd-8ddd-000000000021','dddddddd-dddd-4ddd-8ddd-000000000031',
                  'dddddddd-dddd-4ddd-8ddd-000000000043')$q$),

      ('V5-05', '23503', 'UPDATE 已有申请：把 rubric 改成别的 job 的（钉版本不允许事后换岗）',
       $q$update recruitment.application set rubric_version_id = 'dddddddd-dddd-4ddd-8ddd-000000000042'
           where id = 'dddddddd-dddd-4ddd-8ddd-000000000061'$q$),

      ('V5-06', '23503', 'UPDATE 已有申请：把 job_version 改成别的 job 的',
       $q$update recruitment.application set job_version_id = 'dddddddd-dddd-4ddd-8ddd-000000000032'
           where id = 'dddddddd-dddd-4ddd-8ddd-000000000061'$q$),

      ('V5-07', '23503', 'UPDATE 已钉版本后改 job_id：旧版本跟着"换岗"必须被拒绝（钉版本的本体）',
       $q$update recruitment.application set job_id = 'dddddddd-dddd-4ddd-8ddd-000000000022'
           where id = 'dddddddd-dddd-4ddd-8ddd-000000000061'$q$),

      ('V5-08', '23514', '改 rubric_version.job_id 来"洗白"跨岗位引用（版本整行不可改，不变量 10）',
       $q$update recruitment.rubric_version set job_id = 'dddddddd-dddd-4ddd-8ddd-000000000022'
           where id = 'dddddddd-dddd-4ddd-8ddd-000000000041'$q$),

      ('V5-09', '23514', '改 job_version.job_id 来"洗白"跨岗位引用（同上）',
       $q$update recruitment.job_version set job_id = 'dddddddd-dddd-4ddd-8ddd-000000000022'
           where id = 'dddddddd-dddd-4ddd-8ddd-000000000031'$q$)
    ) as v(id, want_state, descr, stmt)
  loop
    v_state := null;
    v_msg   := null;
    v_ok    := false;
    begin
      execute r.stmt;
      v_ok := true;                       -- 走到这里 = 本应被拒绝却成功了
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate,
                              v_msg   = message_text;
    end;

    if v_ok then
      raise exception 'FAIL % % —— 本应被拒绝却成功了', r.id, r.descr;
    end if;
    if v_state <> r.want_state then
      raise exception 'FAIL % % —— 期望 SQLSTATE %，实际 %（%）',
        r.id, r.descr, r.want_state, v_state, v_msg;
    end if;
    raise notice 'PASS % % → SQLSTATE % | %', r.id, r.descr, v_state, v_msg;
  end loop;
end $$;


-- =====================================================================
--  §6  删除被引用的版本必须被拒绝（两条路径都要拦）
--
--  路径 A（正常）：trg_*_no_delete 触发器先拦 → 23514 DELETE_FORBIDDEN
--  路径 B（关掉禁删触发器）：只剩外键 RESTRICT 在拦 → 23503
--  为什么两条都测：路径 A 只能证明"历史不可删"，证明不了"外键建对了"；
--  路径 B 才是 D-49 真正要的物理保证（版本被钉住就不能被删）。
--  关触发器只在**本事务**内生效，块尾立即 enable，脚本结尾 ROLLBACK。
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 6. 删除被引用的版本（触发器路径 23514 / 外键路径 23503）'
\echo '=================================================================='

do $$
declare
  v_state text;
  v_msg   text;
  v_ok    boolean;
  r       record;
begin
  for r in
    select * from (values
      ('V5-10', 'rubric_version', 'trg_rubric_version_no_delete',
       'dddddddd-dddd-4ddd-8ddd-000000000041'),
      ('V5-11', 'job_version',    'trg_job_version_no_delete',
       'dddddddd-dddd-4ddd-8ddd-000000000031')
    ) as v(id, tbl, trg, victim)
  loop
    -- 6.a 正常路径：禁删触发器
    v_state := null; v_msg := null; v_ok := false;
    begin
      execute format('delete from recruitment.%I where id = %L', r.tbl, r.victim);
      v_ok := true;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    end;
    if v_ok then
      raise exception 'FAIL % 删除被引用的 % 竟然成功（禁删触发器没生效）', r.id, r.tbl;
    end if;
    if v_state <> '23514' then
      raise exception 'FAIL % % 期望 23514（DELETE_FORBIDDEN），实际 %（%）', r.id, r.tbl, v_state, v_msg;
    end if;
    raise notice 'PASS % 删除被引用的 % → SQLSTATE 23514（禁删触发器）| %', r.id, r.tbl, v_msg;

    -- 6.b 关掉禁删触发器，让外键 RESTRICT 单独受考
    execute format('alter table recruitment.%I disable trigger %I', r.tbl, r.trg);

    v_state := null; v_msg := null; v_ok := false;
    begin
      execute format('delete from recruitment.%I where id = %L', r.tbl, r.victim);
      v_ok := true;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    end;

    execute format('alter table recruitment.%I enable trigger %I', r.tbl, r.trg);

    if v_ok then
      raise exception 'FAIL % 关掉禁删触发器后删除被引用的 % 竟然成功 —— 外键没拦住', r.id, r.tbl;
    end if;
    if v_state <> '23503' then
      raise exception 'FAIL % % 期望 23503（外键 RESTRICT），实际 %（%）', r.id, r.tbl, v_state, v_msg;
    end if;
    raise notice 'PASS % 关掉禁删触发器后删除 % → SQLSTATE 23503（外键 RESTRICT）| %', r.id, r.tbl, v_msg;

    -- 6.c 触发器必须已经恢复
    if not exists (select 1 from pg_trigger
                    where tgrelid = format('recruitment.%I', r.tbl)::regclass
                      and tgname  = r.trg and tgenabled = 'O') then
      raise exception 'FAIL % % 的禁删触发器没有恢复（tgenabled <> O）', r.id, r.tbl;
    end if;
    raise notice 'PASS % 禁删触发器 % 已恢复（tgenabled = O）', r.id, r.trg;
  end loop;
end $$;


-- =====================================================================
--  §7  数据面复核 + 行数
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 7. 数据面复核'
\echo '=================================================================='

do $$
declare
  v_n integer;
begin
  select count(*) into v_n
    from recruitment.application a
    join recruitment.rubric_version rv on rv.id = a.rubric_version_id
   where rv.job_id <> a.job_id or rv.tenant_id <> a.tenant_id;
  if v_n <> 0 then
    raise exception 'DATA-01 仍有 % 条 application 的 rubric 跨岗位/跨租户', v_n;
  end if;

  select count(*) into v_n
    from recruitment.application a
    join recruitment.job_version jv on jv.id = a.job_version_id
   where jv.job_id <> a.job_id or jv.tenant_id <> a.tenant_id;
  if v_n <> 0 then
    raise exception 'DATA-02 仍有 % 条 application 的 job_version 跨岗位/跨租户', v_n;
  end if;

  raise notice 'DATA PASS 库内跨岗位/跨租户的版本引用 = 0 条';
end $$;

\echo '-- 夹具申请（3 条，全部同岗位同租户）--'
select a.id, a.job_id, a.job_version_id, a.rubric_version_id,
       jv.job_id as jv_job, rv.job_id as rv_job
  from recruitment.application a
  left join recruitment.job_version jv    on jv.id = a.job_version_id
  left join recruitment.rubric_version rv on rv.id = a.rubric_version_id
 where a.tenant_id = 'dddddddd-dddd-4ddd-8ddd-000000000001'
 order by a.id;

\echo '-- 版本 / 申请行数 --'
select 'application' as t, count(*) from recruitment.application
union all select 'rubric_version', count(*) from recruitment.rubric_version
union all select 'job_version',    count(*) from recruitment.job_version
order by 1;


-- =====================================================================
--  收尾
-- =====================================================================

\echo ''
\echo '=== ROLLBACK：自检不改变数据库 ==='
rollback;

\echo ''
\echo '=================================================================='
\echo ' V5 PASS：结构断言 + 3 条正向用例 + 9 条负向用例（断言 SQLSTATE）'
\echo '          + 2×2 条删除路径（23514 触发器 / 23503 外键 RESTRICT）全部通过'
\echo '=================================================================='
