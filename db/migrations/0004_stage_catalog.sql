-- =====================================================================
--  recruitment-agent · 0004_stage_catalog.sql
--
--  决策（work/control/DECISIONS-2026-11-12.md）：
--    D-23 建真表 stage_catalog，种 12 行，application.current_stage_code 加外键
--         —— 现在阶段目录只活在 business_config 的 JSON 里，current_stage_code
--            只有正则约束，写进一个不存在的 code 不报错 → 联调时"查得到申请、
--            查不到阶段名"的静默不一致。脏 code 必须在数据库层拦住。
--    D-22 阶段 code 唯一口径 = S1–S12（五档粗粒度值作废）
--    D-21 job.current_rubric_version_id 显式指针（可空），不用 max(version_no)
--         —— 回滚到旧版本后 max() 会撒谎。
--
--  本文件做四件事（顺序不能换）：
--    1. 建 stage_catalog（uuid 主键 + tenant_id，业务键 = (tenant_id, code)）
--    2. 从 business_config.stage_catalog **派生**种子（保证与 0002 逐字一致）
--    3. 先检查"现有 application 的 stage code 是否都已在目录里"，再加外键
--    4. 加 job.current_rubric_version_id + 回填 + 复合外键（同岗位约束）
--
--  依赖：0001_init.sql（结构）+ 0002_seed.sql（阶段目录配置行 / demo job+rubric）
--        0003 与本文件无交集（review_queue 系），先跑后跑都可。
--
--  幂等：create table if not exists / add column if not exists /
--        所有约束都用 DO $$ ... if not exists (pg_constraint) ... $$ /
--        create index if not exists / 种子 insert ... on conflict do nothing /
--        回填只动 current_rubric_version_id is null 的行。
--        连跑两遍：零 ERROR、零新增行；第二遍只剩 record_version 不变（回填 0 行）。
--
--  不改：0001 / 0002 / 0003 / SCHEMA.md / verify.sql / SEED.md。本文件无 DELETE。
--
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0004_stage_catalog.sql
--        不要加 -1（本文件自带 begin/commit）。
-- =====================================================================

begin;


-- =====================================================================
--  §1  stage_catalog：阶段目录真表
--
--  为什么不是 `code text primary key`（D-23 的字面写法）：
--    SCHEMA.md §1 全局约定 + db/verify.sql §2 的结构断言（STRUCT-01/02/03）要求
--    *迁移建出来的每一张表* 都是「单列 uuid 主键 id」+「NOT NULL tenant_id」+
--    「tenant_id 外键到 organization」。stage_catalog 若用 text 主键、无 tenant_id，
--    verify.sql 会直接 FAIL。
--  因此：主键 = uuid 代理键；**业务键 = (tenant_id, code)** 由唯一约束保证，
--    外键仍然指向 (tenant_id, code) —— 拦脏 code 的强度与 D-23 完全一致。
--  同一决定还保证了阶段目录是**按租户**的（与 0002 的 business_config
--  scope='ORGANIZATION' 一致），不会出现甲租户改名影响乙租户。
--
--  in_v1_scope：v1.0 切割（docs/01 §9），来自配置，不在本表里推导。
--  kind（业务域）：仍留在 business_config 的 JSON 快照里 —— 本表只建 D-23 要求的
--    列；要加列请先改决策 + SCHEMA.md，不要在迁移里悄悄扩。
-- =====================================================================

create table if not exists recruitment.stage_catalog (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references recruitment.organization (id),
  code         text        not null,
  name         text        not null,
  sort_order   integer     not null,
  in_v1_scope  boolean     not null,
  created_at   timestamptz not null default now(),
  -- 业务键：同一租户内 code 唯一（外键就指向这对列）
  constraint uq_stage_catalog_tenant_code unique (tenant_id, code),
  -- 顺序也唯一：两行同 sort_order 会让"按顺序取阶段"变成不确定结果，同属静默错误
  constraint uq_stage_catalog_tenant_order unique (tenant_id, sort_order),
  -- 与 application.ck_application_stage_code 同一正则：外键 + 正则双保险
  constraint ck_stage_catalog_code check (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  constraint ck_stage_catalog_name check (length(btrim(name)) between 1 and 120),
  -- D-23 的 1..12（v1.0 固定 12 个阶段）
  constraint ck_stage_catalog_sort_order check (sort_order between 1 and 12)
);

-- 联调最常用的查询：某租户按顺序取目录
create index if not exists ix_stage_catalog_order
  on recruitment.stage_catalog (tenant_id, sort_order);


-- =====================================================================
--  §2  种子：从 business_config 派生，而不是在迁移里重抄一遍 12 行
--
--  派生理由：任务要求"与 0002 的目录逐字一致"。手抄 12 行 = 两个真相源，
--    抄错一个字就是新的静默漂移；派生让"一致"成为结构事实。
--
--  取数规则：每个租户取 **version_no 最大** 的那条 stage_catalog 配置
--    （scope='ORGANIZATION'、effective_to is null）。
--  表一旦有行，它就是运行时的权威目录；business_config 退回"版本化输入快照"。
-- =====================================================================

-- 2.1 配置形状检查：stages 必须是数组，元素必须带齐 4 个字段且类型正确
--     （宁可让迁移失败，也不要静默跳过一条坏配置 —— 跳过 = 少一个阶段，
--       而 application 的外键会把这个缺失放大成"阶段查不到"）
do $$
declare
  v_bad text;
begin
  select string_agg(format('tenant=%s', c.tenant_id), ', ') into v_bad
    from recruitment.business_config c
   where c.scope = 'ORGANIZATION'
     and c.config_key = 'stage_catalog'
     and c.effective_to is null
     and jsonb_typeof(c.payload -> 'stages') is distinct from 'array';
  if v_bad is not null then
    raise exception 'STAGE_CATALOG_CONFIG_INVALID: business_config.stage_catalog 的 payload.stages 不是数组（%）', v_bad
      using errcode = '22023';
  end if;

  select string_agg(format('tenant=%s stage#%s', c.tenant_id, e.i), ', ') into v_bad
    from recruitment.business_config c
    cross join lateral jsonb_array_elements(c.payload -> 'stages') with ordinality as e(stage, i)
   where c.scope = 'ORGANIZATION'
     and c.config_key = 'stage_catalog'
     and c.effective_to is null
     and (jsonb_typeof(e.stage) is distinct from 'object'
          or jsonb_typeof(e.stage -> 'code')        is distinct from 'string'
          or jsonb_typeof(e.stage -> 'name')        is distinct from 'string'
          or jsonb_typeof(e.stage -> 'order')       is distinct from 'number'
          or jsonb_typeof(e.stage -> 'in_v1_scope') is distinct from 'boolean');
  if v_bad is not null then
    raise exception 'STAGE_CATALOG_CONFIG_INVALID: stages[] 元素缺字段或类型不对（%）', v_bad
      using errcode = '22023';
  end if;
end $$;

-- 2.2 派生插入（幂等：同一 (tenant, code) 已存在就跳过，不覆盖已有行）
with cfg as (
  select distinct on (c.tenant_id) c.tenant_id, c.payload
    from recruitment.business_config c
   where c.scope = 'ORGANIZATION'
     and c.config_key = 'stage_catalog'
     and c.effective_to is null
   order by c.tenant_id, c.version_no desc
)
insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
select cfg.tenant_id,
       e.stage ->> 'code',
       e.stage ->> 'name',
       (e.stage ->> 'order')::integer,
       (e.stage ->> 'in_v1_scope')::boolean
  from cfg
  cross join lateral jsonb_array_elements(cfg.payload -> 'stages') as e(stage)
on conflict (tenant_id, code) do nothing;

-- 2.3 目录完整性检查：有配置的租户，目录必须正好 12 行、顺序 1..12 不缺不重
--     （CHECK 已把 sort_order 限在 1..12；这里再要求 12 行 + 12 个不同顺序 = 连续）
do $$
declare
  v_bad text;
begin
  select string_agg(format('tenant=%s（目录 %s 行 / %s 个不同顺序）', t.tenant_id, t.n, t.n_order), ', ')
    into v_bad
    from (
      select cfg.tenant_id,
             count(s.id)                   as n,
             count(distinct s.sort_order)  as n_order,
             min(s.sort_order)             as min_order,
             max(s.sort_order)             as max_order
        from (select distinct on (c.tenant_id) c.tenant_id
                from recruitment.business_config c
               where c.scope = 'ORGANIZATION'
                 and c.config_key = 'stage_catalog'
                 and c.effective_to is null
               order by c.tenant_id, c.version_no desc) cfg
        left join recruitment.stage_catalog s on s.tenant_id = cfg.tenant_id
       group by cfg.tenant_id
    ) t
   where t.n <> 12 or t.n_order <> 12 or t.min_order <> 1 or t.max_order <> 12;
  if v_bad is not null then
    raise exception 'STAGE_CATALOG_INCOMPLETE: 阶段目录必须 S1–S12 共 12 个、顺序 1..12 连续（%）', v_bad
      using errcode = '23514';
  end if;
end $$;


-- =====================================================================
--  §3  加外键**之前**处理已存在数据（0002 已把 application 推到 'S7'）
--
--  不删、不改、不"猜"：如果存在任何 application 的 current_stage_code
--  不在它自己租户的目录里，本迁移**整笔回滚**并列出脏值。
--  正确反应是补目录（或人工确认该申请应处于哪个阶段后再改），
--  而不是让迁移替人决定 —— 自动改数据会把"写错了"变成"看不出来写错过了"。
--
--  0002 的数据：application ...0701 的 current_stage_code='S7'，目录里已有 S7
--  → 本检查通过，外键可以安全加上。
-- =====================================================================

do $$
declare
  v_bad text;
begin
  select string_agg(format('application=%s tenant=%s code=%s', a.id, a.tenant_id, a.current_stage_code), '; ')
    into v_bad
    from recruitment.application a
   where not exists (
     select 1 from recruitment.stage_catalog s
      where s.tenant_id = a.tenant_id
        and s.code = a.current_stage_code);
  if v_bad is not null then
    raise exception 'STAGE_CATALOG_MISSING: 以下 application 的 current_stage_code 不在 stage_catalog 中，外键无法建立（先补目录/改数据再跑本迁移）：%', v_bad
      using errcode = '23503';
  end if;
  raise notice '0004 PRE-FK PASS 现有 application 的 stage code 全部已在目录内';
end $$;

-- 3.1 外键：application.(tenant_id, current_stage_code) → stage_catalog.(tenant_id, code)
--     on update/delete restrict 写显式：改/删被引用的 code 必须失败，而不是级联
--     （级联会把历史记录里的旧 code 悄悄改掉 —— 又一次静默错误）
do $$
begin
  if not exists (select 1 from pg_constraint c
                 where c.conname = 'fk_application_stage_catalog'
                   and c.conrelid = 'recruitment.application'::regclass) then
    alter table recruitment.application
      add constraint fk_application_stage_catalog
      foreign key (tenant_id, current_stage_code)
      references recruitment.stage_catalog (tenant_id, code)
      on update restrict on delete restrict;
  end if;
end $$;

-- 3.2 连带修正：current_stage_code 的默认值 'SCREENING' 已被 D-22 作废
--     （五档粗粒度值不再有效）。不修的话，新外键会让"不写阶段就插入"永远失败，
--     而且报错信息指向外键而不是"默认值过期"—— 换个方式继续静默。
--     0002 §7 的既有流程是 S6（Intake）起步、再迁移到 S7，故默认取 S6。
alter table recruitment.application
  alter column current_stage_code set default 'S6';


-- =====================================================================
--  §4  job.current_rubric_version_id（D-21）
--
--  可空：岗位可以还没有 rubric（DRAFT 阶段）。
--  复合外键 (tenant_id, id, current_rubric_version_id)
--        → rubric_version (tenant_id, job_id, id)
--  = "这个 rubric 必须属于**这个 job**" 的物理保证：
--    不可能出现 A 岗位指向 B 岗位的 rubric（哪怕 id 是合法 UUID）。
--  MATCH SIMPLE（默认）：current_rubric_version_id is null 时不检查，故可空成立。
--
--  注意 (tenant_id, job_id, id) 这个被引用键必须先有唯一约束才能被外键引用。
-- =====================================================================

alter table recruitment.job
  add column if not exists current_rubric_version_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint c
                 where c.conname = 'uq_rubric_version_tenant_job_id'
                   and c.conrelid = 'recruitment.rubric_version'::regclass) then
    alter table recruitment.rubric_version
      add constraint uq_rubric_version_tenant_job_id unique (tenant_id, job_id, id);
  end if;
end $$;

-- 4.1 回填（一次性）：现有 job 没有指针的，取它自己 **version_no 最大** 的 rubric。
--
--  为什么这里可以用 max()：迁移时刻没有任何"曾经回滚过"的历史记录可依赖，
--  取最高版本是唯一不撒谎的初值。回填完成后本列就是权威，
--  **此后任何代码都不得再用 max(version_no) 推导"当前版本"**（D-21）。
--  只动 is null 的行 → 第二遍 0 行更新，record_version 不漂移。
with pick as (
  select j.id as job_id,
         j.tenant_id,
         (select rv.id
            from recruitment.rubric_version rv
           where rv.job_id = j.id
             and rv.tenant_id = j.tenant_id
           order by rv.version_no desc, rv.created_at desc, rv.id
           limit 1) as rubric_version_id
    from recruitment.job j
   where j.current_rubric_version_id is null
)
update recruitment.job j
   set current_rubric_version_id = p.rubric_version_id
  from pick p
 where p.job_id = j.id
   and p.tenant_id = j.tenant_id
   and p.rubric_version_id is not null
   and j.current_rubric_version_id is null;

-- 4.2 复合外键：rubric 必须属于同一个 job（且同一租户）
do $$
begin
  if not exists (select 1 from pg_constraint c
                 where c.conname = 'fk_job_current_rubric'
                   and c.conrelid = 'recruitment.job'::regclass) then
    alter table recruitment.job
      add constraint fk_job_current_rubric
      foreign key (tenant_id, id, current_rubric_version_id)
      references recruitment.rubric_version (tenant_id, job_id, id)
      on update restrict on delete restrict;
  end if;
end $$;


-- =====================================================================
--  §5  迁移后自检（失败即整笔回滚，不留半套结构）
-- =====================================================================

do $$
declare
  v_n integer;
begin
  -- 5.1 目录行数：demo 租户必须正好 12 行
  select count(*) into v_n
    from recruitment.stage_catalog s
   where s.tenant_id = '11111111-1111-4111-8111-000000000001';
  if v_n <> 0 and v_n <> 12 then
    raise exception '0004 POST-CHECK 失败：demo 租户的 stage_catalog 应为 12 行，实际 %', v_n;
  end if;

  -- 5.2 0002 既有的 job 必须已回填到它自己的 rubric（若该 rubric 存在）
  select count(*) into v_n
    from recruitment.job j
   where j.id = '11111111-1111-4111-8111-000000000401'
     and j.current_rubric_version_id is null
     and exists (select 1 from recruitment.rubric_version rv where rv.job_id = j.id);
  if v_n <> 0 then
    raise exception '0004 POST-CHECK 失败：demo job 的 current_rubric_version_id 未回填';
  end if;

  raise notice '0004 POST-CHECK PASS 目录 12 行 + demo job 已回填当前 rubric';
end $$;


commit;


-- =====================================================================
--  回滚方式（本文件无数据删除，回滚 = 反向 DDL，需人工确认）
--    alter table recruitment.application drop constraint if exists fk_application_stage_catalog;
--    alter table recruitment.application alter column current_stage_code set default 'SCREENING';
--    alter table recruitment.job drop constraint if exists fk_job_current_rubric;
--    alter table recruitment.rubric_version drop constraint if exists uq_rubric_version_tenant_job_id;
--    alter table recruitment.job drop column if exists current_rubric_version_id;
--    drop table if exists recruitment.stage_catalog;
--  ⚠️ 回滚前先确认没有 application 在用当前目录（否则这次"回滚"会重新放开脏 code）。
-- =====================================================================
