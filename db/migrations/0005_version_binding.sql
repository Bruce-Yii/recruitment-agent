-- =====================================================================
--  recruitment-agent · 0005_version_binding.sql
--
--  裁定：D-49（work/control/DECISIONS-2026-11-12.md）
--
--  问题（J 线 S-3，最该修）：
--    application.rubric_version_id / application.job_version_id 现在只做
--    (id, tenant_id) 外键 —— **能指向别的 job 的版本**。
--    后果：A 岗位的申请记录引用 B 岗位的评价标准，"钉版本"形同虚设；
--          而且它是绕着不变量 10（配置换版不静默改写已开始的申请）走的暗门。
--
--  本文件做四件事（顺序不能换）：
--    1. 迁移前自检：现有数据里是否存在跨 job / 跨租户的版本引用
--       → 有则 RAISE + 整笔回滚（**不替人修数据**，见 §1）
--    2. 被引用键：rubric_version / job_version 各加 unique (id, job_id)（D-49 1）
--    3. application 加复合外键（**先加新的，再删旧的**：不留无保护窗口）
--    4. 删旧外键之前逐一核对：新外键已存在且已 convalidated 才允许删（§4）
--
--  ── 与 D-49 字面的偏离（复核时必须确认，不要当成笔误）──────────────
--    D-49 字面写 2 列：
--        (rubric_version_id, job_id) → rubric_version (id, job_id)
--        (job_version_id,  job_id) → job_version  (id, job_id)
--    但 db/verify.sql 的 STRUCT-07 断言：
--        「凡 conkey 超过 1 列的复合外键，必须含 tenant_id（防跨租户引用）」
--    2 列形态不含 tenant_id → 本迁移一跑就 STRUCT-07 FAIL，
--    而 D-49 的验收第 4 条要求 verify.sql **仍必须 VERIFY PASS**。
--    两条要求不可能同时按字面成立，本文件选"加严 + 兼容既有台账"：
--        (tenant_id, rubric_version_id, job_id) → rubric_version (tenant_id, id, job_id)
--        (tenant_id, job_version_id,  job_id) → job_version  (tenant_id, id, job_id)
--    强度：严格**强于** D-49 的 2 列形态（同 job + 同租户同时成为物理约束）；
--    语义：D-49 要拦的"指向别的 job 的版本"照样被拦，且拦得更早（连租户都不放过）。
--    这是"加严"，不是"放宽"；如果总控坚持 2 列，唯一代价是 STRUCT-07 必须开口子
--    （那需要授权改 verify.sql，本文件不碰）。
--
--  依赖：0001_init.sql（application / rubric_version / job_version）
--        0002_seed.sql 可选（种子数据应当本来就满足新约束）
--        0003 / 0004 与本文件无交集（本文件不引用 stage_catalog、review_queue 系）。
--        **本文件不依赖 0004**：不需要 stage_catalog，也不需要 current_rubric_version_id。
--
--  幂等：所有 DDL 都先查 pg_constraint 再建（无 "duplicate object"）；
--        旧外键用 drop constraint if exists + 先核对定义；
--        第二遍：零 ERROR、零新增约束、零数据改动。
--        本文件**没有任何 INSERT / UPDATE / DELETE**（§1 的检查是只读查询）。
--
--  不改：0001 / 0002 / 0003 / 0004 / SCHEMA.md / verify.sql / SEED.md。
--
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0005_version_binding.sql
--        不要加 -1（本文件自带 begin/commit）。
-- =====================================================================

begin;


-- =====================================================================
--  §0  改造前的现场（只读）：把旧外键的真实定义打进日志，作为"改造前"证据
-- =====================================================================

do $$
declare
  v_txt text;
begin
  select string_agg(format('%s = %s', c.conname, pg_get_constraintdef(c.oid)), E'\n      ')
    into v_txt
    from pg_constraint c
   where c.conrelid = 'recruitment.application'::regclass
     and c.contype = 'f'
     and (select array_agg(a.attname::text)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         && array['rubric_version_id', 'job_version_id']::text[];
  raise notice E'0005 改造前 application 上与版本相关的外键：\n      %', coalesce(v_txt, '（无）');
end $$;


-- =====================================================================
--  §1  迁移前自检：跨 job / 跨租户的版本引用
--
--  这是本迁移**唯一**关心现有数据的地方。发现任何一条就整笔回滚，
--  并把"哪条申请、钉的哪个版本、版本实际属于哪个 job"逐条列出来。
--
--  为什么报错而不是修数据：
--    跨 job 引用有两种可能 —— (a) 写错了（该钉 A 的版本，错钉了 B 的），
--    (b) 业务上真的要换岗位（那应该新建 application，而不是改旧申请的版本）。
--    迁移替人选 (a) 或 (b) 都是**替人做决定**，而且改完就再也看不出"曾经错过"。
--    正确反应：人工确认后改数据，再重跑本迁移。
-- =====================================================================

do $$
declare
  v_bad   text;
  v_scope integer;
  v_rub   integer;
begin
  -- 1.1 rubric_version_id：可为空；只要非空，就必须属于同一个 job + 同一个租户
  select count(*) into v_rub
    from recruitment.application a
   where a.rubric_version_id is not null;

  select string_agg(
           format('application=%s (tenant=%s job=%s) 钉的 rubric=%s，该 rubric 属于 job=%s / tenant=%s',
                  a.id, a.tenant_id, a.job_id, rv.id, rv.job_id, rv.tenant_id),
           E'\n      ')
    into v_bad
    from recruitment.application a
    join recruitment.rubric_version rv on rv.id = a.rubric_version_id
   where rv.job_id <> a.job_id
      or rv.tenant_id <> a.tenant_id;
  if v_bad is not null then
    raise exception E'VERSION_BINDING_CROSS_JOB: 以下申请的 rubric_version_id 指向**别的岗位/租户**的评分标准，复合外键无法建立。\n      本迁移不会替你改数据：请人工确认这些申请应当钉哪个版本的 rubric（改数据后重跑本迁移）。\n      %', v_bad
      using errcode = '23503';
  end if;

  -- 1.2 job_version_id：NOT NULL；必须属于同一个 job + 同一个租户
  select count(*) into v_scope
    from recruitment.application a
    join recruitment.job_version jv on jv.id = a.job_version_id
   where jv.job_id = a.job_id
     and jv.tenant_id = a.tenant_id;

  select string_agg(
           format('application=%s (tenant=%s job=%s) 钉的 job_version=%s，该版本属于 job=%s / tenant=%s',
                  a.id, a.tenant_id, a.job_id, jv.id, jv.job_id, jv.tenant_id),
           E'\n      ')
    into v_bad
    from recruitment.application a
    join recruitment.job_version jv on jv.id = a.job_version_id
   where jv.job_id <> a.job_id
      or jv.tenant_id <> a.tenant_id;
  if v_bad is not null then
    raise exception E'VERSION_BINDING_CROSS_JOB: 以下申请的 job_version_id 指向**别的岗位/租户**的 JD 版本，复合外键无法建立。\n      本迁移不会替你改数据：请人工确认这些申请应当钉哪个 JD 版本（改数据后重跑本迁移）。\n      %', v_bad
      using errcode = '23503';
  end if;

  raise notice '0005 PRE-CHECK PASS 现有 application：% 条（钉了 rubric 的 % 条 / JD 版本对得上 job 的 % 条）全部同 job 同租户，无跨岗位引用',
    (select count(*) from recruitment.application), v_rub, v_scope;
end $$;


-- =====================================================================
--  §2  被引用键：unique (id, job_id)  +  unique (tenant_id, id, job_id)
--
--  两对唯一键各有用处，别当成重复：
--    * unique (id, job_id)         —— D-49 第 1 条的字面要求，也是本约束的**语义声明**：
--                                     "一个版本行 = (版本, 岗位)"，外键才有东西可指。
--                                     （技术上 id 已是主键，它不增加拦截力，但它是
--                                      这条业务事实的载体，也让 pg_dump 的 DDL 自解释。）
--    * unique (tenant_id, id, job_id) —— 3 列复合外键的**被引用键**（§3）。
--                                     PostgreSQL 要求外键指向一组唯一列；STRUCT-07 又要求
--                                     复合外键必须含 tenant_id，所以被引用键必须带 tenant_id。
--
--  幂等/避重：按"列集合"判断，而不是按约束名 —— 0004 若已建过
--    uq_rubric_version_tenant_job_id unique (tenant_id, job_id, id)（同一列集合，
--    只是列序不同），本文件就复用它，不再叠一个同义索引。
--    （唯一性与外键引用都只看列集合，列序不影响语义。）
-- =====================================================================

do $$
declare
  r record;
begin
  -- 2.1 unique (id, job_id)
  for r in
    select * from (values ('rubric_version', 'uq_rubric_version_id_job'),
                          ('job_version',    'uq_job_version_id_job')
                 ) as v(tbl, conname)
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
      execute format('alter table recruitment.%I add constraint %I unique (id, job_id)',
                     r.tbl, r.conname);
      raise notice '0005 已加 % unique (id, job_id) [%]', r.tbl, r.conname;
    else
      raise notice '0005 % 已有 unique (id, job_id)（等价唯一键），跳过', r.tbl;
    end if;
  end loop;

  -- 2.2 unique (tenant_id, id, job_id)：外键的被引用键
  for r in
    select * from (values ('rubric_version', 'uq_rubric_version_tenant_id_job'),
                          ('job_version',    'uq_job_version_tenant_id_job')
                 ) as v(tbl, conname)
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
      execute format('alter table recruitment.%I add constraint %I unique (tenant_id, id, job_id)',
                     r.tbl, r.conname);
      raise notice '0005 已加 % unique (tenant_id, id, job_id) [%]', r.tbl, r.conname;
    else
      raise notice '0005 % 已有等价唯一键 (tenant_id, id, job_id)（如 0004 的 uq_*_tenant_job_id），复用', r.tbl;
    end if;
  end loop;
end $$;


-- =====================================================================
--  §3  新的复合外键（先加，后删旧的）
--
--  MATCH SIMPLE（默认）：只要有一列为 NULL 就不检查。
--    rubric_version_id 可空 → "还没定评分标准"的申请仍然可以存在（语义不变）；
--    job_version_id NOT NULL、tenant_id/job_id NOT NULL → 一定被检查。
--
--  on update restrict / on delete restrict 显式写死：
--    改/删被引用的版本必须失败，而不是级联 —— 级联会把历史申请钉的版本
--    悄悄改掉，那正是不变量 10 要防的静默改写。
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'fk_application_rubric_job'
                    and c.conrelid = 'recruitment.application'::regclass) then
    alter table recruitment.application
      add constraint fk_application_rubric_job
      foreign key (tenant_id, rubric_version_id, job_id)
      references recruitment.rubric_version (tenant_id, id, job_id)
      on update restrict on delete restrict;
    raise notice '0005 已加 fk_application_rubric_job：申请钉的 rubric 必须属于同一个 job + 租户';
  else
    raise notice '0005 fk_application_rubric_job 已存在，跳过';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'fk_application_job_version_job'
                    and c.conrelid = 'recruitment.application'::regclass) then
    alter table recruitment.application
      add constraint fk_application_job_version_job
      foreign key (tenant_id, job_version_id, job_id)
      references recruitment.job_version (tenant_id, id, job_id)
      on update restrict on delete restrict;
    raise notice '0005 已加 fk_application_job_version_job：申请钉的 JD 版本必须属于同一个 job + 租户';
  else
    raise notice '0005 fk_application_job_version_job 已存在，跳过';
  end if;
end $$;


-- =====================================================================
--  §4  旧外键：**先验证、后删除**
--
--  删除旧外键是本迁移唯一的破坏性动作，所以设三道闸：
--    闸 1：新外键必须已存在且 convalidated（= 已经不依赖旧外键的拦截）。
--    闸 2：旧外键若还在，必须先核对它的定义确实是"我们以为的那条"
--          （表/列集合/被引用表都对），否则拒绝删除 —— 防止误删别人改过的约束。
--    闸 3：只有在"新外键已验证"之后才执行 drop；
--          同一个事务里先加后删，任何时刻 application 都至少有一套外键在生效。
--
--  为什么"先验证再删"不能省略成 drop if exists：
--    drop 掉旧外键之后，新外键若因任何原因没建上（或建成了 NOT VALID），
--    库里就会**静默回到"版本可以跨岗位"的状态**，而且再跑一遍迁移也不会发现。
--    闸 1 就是这条自愈路径的入口。
-- =====================================================================

do $$
declare
  v_n     integer;
  r       record;
  v_ok    boolean;
  v_def   text;
  v_drop  integer := 0;
begin
  -- 4.1 闸 1：新外键齐了、且已验证
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.application'::regclass
     and c.contype = 'f'
     and c.conname in ('fk_application_rubric_job', 'fk_application_job_version_job')
     and c.convalidated;
  if v_n <> 2 then
    raise exception 'VERSION_BINDING_ABORT: 新复合外键未全部建立并验证（% / 2）。拒绝删除旧外键 —— 否则库里会静默回到"版本可跨岗位"的状态。', v_n
      using errcode = '23514';
  end if;
  raise notice '0005 闸 1 PASS 新复合外键 2/2 已建立并 convalidated';

  -- 4.2 闸 2 + 闸 3：逐条核对旧外键定义，确认后才删
  for r in
    select * from (values
      ('fk_application_rubric'      , 'recruitment.rubric_version'::regclass,
       array['rubric_version_id', 'tenant_id']::text[]),
      ('fk_application_job_version' , 'recruitment.job_version'::regclass,
       array['job_version_id', 'tenant_id']::text[])
    ) as v(conname, reftbl, ref_cols)
  loop
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c
     where c.conname = r.conname
       and c.conrelid = 'recruitment.application'::regclass;

    if v_def is null then
      raise notice '0005 旧外键 % 不存在（此前已迁移过），跳过', r.conname;
      continue;
    end if;

    select (c.contype = 'f'
            and c.confrelid = r.reftbl
            and (select array_agg(a.attname::text order by a.attname)
                   from pg_attribute a
                  where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) = r.ref_cols
            and (select array_agg(a.attname::text order by a.attname)
                   from pg_attribute a
                  where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
                = array['id', 'tenant_id']::text[])
      into v_ok
      from pg_constraint c
     where c.conname = r.conname
       and c.conrelid = 'recruitment.application'::regclass;

    if not v_ok then
      raise exception 'VERSION_BINDING_ABORT: 旧外键 % 的定义与预期（%(id, tenant_id)）不符，拒绝删除。实际：% —— 请人工核对后再处理。',
        r.conname, r.reftbl, v_def
        using errcode = '23514';
    end if;

    execute format('alter table recruitment.application drop constraint %I', r.conname);
    v_drop := v_drop + 1;
    raise notice '0005 已删旧外键 %（原定义：%）', r.conname, v_def;
  end loop;

  raise notice '0005 旧外键清理完成：本次删除 % 条（0 条 = 已迁移过，第二遍就是 0）', v_drop;
end $$;


-- =====================================================================
--  §5  迁移后自检（任何一条不满足 → 整笔回滚，不留半套结构）
-- =====================================================================

do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- 5.1 新外键：存在、已验证、且删除动作是 RESTRICT（不是 CASCADE/SET NULL）
  select string_agg(format('%s(confdeltype=%s, confupdtype=%s, validated=%s)',
                           c.conname, c.confdeltype, c.confupdtype, c.convalidated), ', ')
    into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.application'::regclass
     and c.conname in ('fk_application_rubric_job', 'fk_application_job_version_job')
     and not (c.contype = 'f' and c.convalidated
              and c.confdeltype = 'r' and c.confupdtype = 'r');
  if v_bad is not null then
    raise exception '0005 POST-CHECK 失败：新外键形态不对（期望 f/r/r/validated）：%', v_bad;
  end if;

  -- 5.2 旧外键必须已经退场（否则同一个约束方向存在两套，日后必然漂移）
  select string_agg(c.conname, ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.application'::regclass
     and c.conname in ('fk_application_rubric', 'fk_application_job_version');
  if v_bad is not null then
    raise exception '0005 POST-CHECK 失败：旧外键仍在：%', v_bad;
  end if;

  -- 5.3 不存在"绕过 job_id 的后门外键"：
  --     凡是 application 上引用 rubric_version_id / job_version_id 的外键，
  --     conkey 里必须同时含 job_id。否则等于又开了一条能跨岗位的路。
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
    raise exception '0005 POST-CHECK 失败：存在不含 job_id 的版本外键（跨岗位后门）：%', v_bad;
  end if;

  -- 5.4 数据面：跨 job / 跨租户引用必须是 0 条
  select count(*) into v_n
    from recruitment.application a
    join recruitment.rubric_version rv on rv.id = a.rubric_version_id
   where rv.job_id <> a.job_id or rv.tenant_id <> a.tenant_id;
  if v_n <> 0 then
    raise exception '0005 POST-CHECK 失败：仍有 % 条 application 的 rubric 跨岗位/跨租户', v_n;
  end if;

  select count(*) into v_n
    from recruitment.application a
    join recruitment.job_version jv on jv.id = a.job_version_id
   where jv.job_id <> a.job_id or jv.tenant_id <> a.tenant_id;
  if v_n <> 0 then
    raise exception '0005 POST-CHECK 失败：仍有 % 条 application 的 job_version 跨岗位/跨租户', v_n;
  end if;

  -- 5.5 被引用键在位（unique (id, job_id) 是 D-49 的交付物，不能悄悄没了）
  select string_agg(t.tbl, ', ') into v_bad
    from (values ('rubric_version'), ('job_version')) as t(tbl)
   where not exists (
     select 1 from pg_constraint c
      where c.conrelid = format('recruitment.%I', t.tbl)::regclass
        and c.contype = 'u'
        and (select array_agg(a.attname::text order by a.attname)
               from pg_attribute a
              where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
            = array['id', 'job_id']::text[]);
  if v_bad is not null then
    raise exception '0005 POST-CHECK 失败：这些表缺 unique (id, job_id)：%', v_bad;
  end if;

  -- 5.6 改造后的现场（写进日志，作为"改造后"证据）
  select string_agg(format('%s = %s', c.conname, pg_get_constraintdef(c.oid)), E'\n      ')
    into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.application'::regclass
     and c.contype = 'f'
     and (select array_agg(a.attname::text)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         && array['rubric_version_id', 'job_version_id']::text[];
  raise notice E'0005 改造后 application 上与版本相关的外键：\n      %', coalesce(v_bad, '（无）');

  raise notice '0005 POST-CHECK PASS 复合外键 2 条（含 job_id + tenant_id，restrict/validated）+ 旧外键已退场 + 跨岗位引用 0 条';
end $$;


commit;


-- =====================================================================
--  回滚方式（反向 DDL，需人工确认；本文件没有数据改动，回滚是纯结构操作）
--
--    alter table recruitment.application drop constraint if exists fk_application_rubric_job;
--    alter table recruitment.application drop constraint if exists fk_application_job_version_job;
--    alter table recruitment.application
--      add constraint fk_application_rubric foreign key (rubric_version_id, tenant_id)
--      references recruitment.rubric_version (id, tenant_id);
--    alter table recruitment.application
--      add constraint fk_application_job_version foreign key (job_version_id, tenant_id)
--      references recruitment.job_version (id, tenant_id);
--    alter table recruitment.rubric_version drop constraint if exists uq_rubric_version_id_job;
--    alter table recruitment.job_version    drop constraint if exists uq_job_version_id_job;
--    -- 3 列唯一键：0004 环境里是 0004 建的（uq_rubric_version_tenant_job_id），别顺手删掉
--    alter table recruitment.rubric_version drop constraint if exists uq_rubric_version_tenant_id_job;
--    alter table recruitment.job_version    drop constraint if exists uq_job_version_tenant_id_job;
--
--  ⚠️ 回滚前先确认：没有应用代码依赖"版本必须属于同一 job"这条保证
--     （回滚 = 重新开放"申请能指向别的岗位的版本"这个漏洞，D-49 会回到未修状态）。
-- =====================================================================
