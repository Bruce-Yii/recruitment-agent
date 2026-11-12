-- =====================================================================
--  recruitment-agent · db/verify-0007.sql
--  0007_decision_integrity.sql 的自检脚本（GAP-A … GAP-E）
--
--  用法（必须用 psql 跑，本文件含 \echo 等 psql 元命令）：
--    psql -v ON_ERROR_STOP=1 -d <db> -f db/verify-0007.sql
--
--  行为保证（与 db/verify.sql / verify-0005.sql / verify-0006.sql 同口径）：
--    * 整个脚本在一个事务里执行，结尾 ROLLBACK —— 不留任何数据；
--    * 所有断言失败都会 RAISE EXCEPTION（exit code != 0），不会静默通过；
--    * 负向测试打印的是数据库**真实返回的 SQLSTATE 与 message_text**，
--      不是脚本自己编的期望值。
--
--  验证的是五个"库层拦不住"的缺口被堵住：
--    §1 结构断言：11 条，每个新对象的存在 / 形态 / convalidated
--    §2 改造后的真实定义（pg_get_constraintdef / pg_get_indexdef / pg_get_triggerdef）
--    §3 夹具：两个租户 + 一条完整招聘链（岗位 2 / rubric 2 / 面试 2 / 转写 2）
--    §4 正向：11 条（约束不能把正常业务也拦掉）
--    §5 负向：22 条（每个缺口 ≥2，INSERT 与 UPDATE 两条路径；逐条断言 SQLSTATE）
--    §6 数据面复核：迁移后全库无违反
--    §7 GAP-E 的 decision 侧：**本缺口不成立**的实测证据（42703 / 23502）
--
--  依赖：0001 + 0004（stage_catalog / uq_rubric_version_tenant_job_id）+ 0007。
--        0002 / 0003 / 0005 / 0006 可选（0007 自带 0006 被引用键的兜底）。
-- =====================================================================

\set ON_ERROR_STOP on

\echo '=================================================================='
\echo ' 0. 环境'
\echo '=================================================================='

select current_database() as database,
       current_setting('server_version') as pg_version,
       (select count(*) from pg_constraint
         where conrelid = 'recruitment.decision'::regclass and contype = 'f') as decision_fks,
       (select count(*) from pg_constraint
         where conrelid = 'recruitment.scorecard'::regclass and contype = 'f') as scorecard_fks;

begin;

-- 清掉可能从环境继承的"可信服务端 actor"通道，负向用例要靠它为空
set local recruitment.actor_id = '';


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
begin
  -- ------------------------------------------------------------------
  -- S-1 GAP-A：fk_decision_stage_catalog 形态
  -- ------------------------------------------------------------------
  select (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_cols
    from pg_constraint c
   where c.conrelid  = 'recruitment.decision'::regclass
     and c.conname   = 'fk_decision_stage_catalog'
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
    raise exception 'S-1 fk_decision_stage_catalog 形态不对（期望 (tenant_id, stage_code) → stage_catalog(tenant_id, code)，restrict/restrict/validated；实际 %）',
      coalesce(v_cols::text, '（约束不存在）');
  end if;
  raise notice 'S-1 PASS fk_decision_stage_catalog：(tenant_id, stage_code) → stage_catalog(tenant_id, code)，restrict/validated';

  -- ------------------------------------------------------------------
  -- S-2 GAP-A：decision 上不允许再存在"不含 tenant_id 的 stage_code 外键"（后门）
  -- ------------------------------------------------------------------
  select string_agg(format('%s(%s)', c.conname, pg_get_constraintdef(c.oid)), ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
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
    raise exception 'S-2 存在不含 tenant_id 的 stage_code 外键（跨租户后门）：%', v_bad;
  end if;
  raise notice 'S-2 PASS decision 的 stage_code 上没有"不含 tenant_id"的第二条外键';

  -- ------------------------------------------------------------------
  -- S-3 GAP-B：当前决策唯一性 —— 断言**不变量**，不断言具体对象名
  --   0007 原本用"部分唯一索引（unique + NULLS NOT DISTINCT + 谓词）"表达；
  --   0008 把同一个不变量改成"可延迟排斥约束"（否则同一事务里先 INSERT 新
  --   current、再 UPDATE 旧行永远走不通）。对象形态会随 0008 变化，但
  --   "同一 (tenant, application, decision_scope, stage_code) 只能一条
  --   current（superseded_by_decision_id IS NULL）"不变。
  --   所以这里只断言不变量（现有数据 0 组重复）；"真能拦住"由 §5 的
  --   B-01 .. B-03 实测（0007 下是 23505，0008 下是 23P01，两者都接受）。
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from (
      select 1
        from recruitment.decision
       where superseded_by_decision_id is null
       group by tenant_id, application_id, decision_scope, coalesce(stage_code, '')
      having count(*) > 1
    ) d;
  if v_n <> 0 then
    raise exception 'S-3 不变量被破坏：% 组 (tenant, application, decision_scope, stage_code) 有不止一条 current 决策', v_n;
  end if;
  raise notice 'S-3 PASS 当前决策唯一性不变量成立：0 组重复 current（执行层由 §5 B-01..B-03 实测，23505/23P01 均接受）';

  -- ------------------------------------------------------------------
  -- S-4 GAP-C：scorecard.job_id 存在、uuid、NOT NULL、**无默认值**
  -- ------------------------------------------------------------------
  select string_agg(format('type=%s notnull=%s default=%s',
                           format_type(a.atttypid, a.atttypmod), a.attnotnull,
                           coalesce(pg_get_expr(d.adbin, d.adrelid), '（无）')), ' ')
    into v_bad
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'recruitment.scorecard'::regclass
     and a.attname  = 'job_id'
     and a.attnum   > 0
     and not a.attisdropped;
  if v_bad is null then
    raise exception 'S-4 scorecard.job_id 不存在';
  end if;
  if v_bad not like '%type=uuid%' then
    raise exception 'S-4 scorecard.job_id 类型不是 uuid：%', v_bad;
  end if;
  if v_bad not like '%notnull=t%' then
    raise exception 'S-4 scorecard.job_id 必须 NOT NULL：%', v_bad;
  end if;
  if v_bad not like '%default=（无）%' then
    raise exception 'S-4 scorecard.job_id 不允许有默认值：%', v_bad;
  end if;
  raise notice 'S-4 PASS scorecard.job_id = %（uuid、NOT NULL、无默认值）', v_bad;

  -- ------------------------------------------------------------------
  -- S-5 GAP-C：fk_scorecard_rubric_job 形态 + 被引用键
  -- ------------------------------------------------------------------
  select (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_cols
    from pg_constraint c
   where c.conrelid  = 'recruitment.scorecard'::regclass
     and c.conname   = 'fk_scorecard_rubric_job'
     and c.contype   = 'f'
     and c.confrelid = 'recruitment.rubric_version'::regclass
     and c.convalidated
     and c.confdeltype = 'r'
     and c.confupdtype = 'r'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['id', 'job_id', 'tenant_id']::text[];
  if v_cols is distinct from array['job_id', 'rubric_version_id', 'tenant_id']::text[] then
    raise exception 'S-5 fk_scorecard_rubric_job 形态不对（实际 %）', coalesce(v_cols::text, '（约束不存在）');
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
  raise notice 'S-5 PASS fk_scorecard_rubric_job + 被引用键 rubric_version unique (tenant_id, job_id, id)';

  -- ------------------------------------------------------------------
  -- S-6 GAP-C：trg_scorecard_job_guard（before insert or update，逐行）
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'recruitment.scorecard'::regclass
     and g.tgname  = 'trg_scorecard_job_guard'
     and not g.tgisinternal
     and (g.tgtype & 1)  = 1
     and (g.tgtype & 2)  = 2
     and (g.tgtype & 20) = 20
     and g.tgfoid = 'recruitment.fn_scorecard_job_guard'::regproc;
  if v_n <> 1 then
    raise exception 'S-6 trg_scorecard_job_guard 不在位或形态不对（% / 1）', v_n;
  end if;
  raise notice 'S-6 PASS trg_scorecard_job_guard：before insert or update → fn_scorecard_job_guard';

  -- ------------------------------------------------------------------
  -- S-7 GAP-C：函数真的在 pg_proc 里
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'recruitment' and p.proname = 'fn_scorecard_job_guard';
  if v_n <> 1 then
    raise exception 'S-7 fn_scorecard_job_guard 不存在或重名（% / 1）', v_n;
  end if;
  raise notice 'S-7 PASS fn_scorecard_job_guard 存在';

  -- ------------------------------------------------------------------
  -- S-8 GAP-D：fk_ai_summary_artifact 是 3 列 + 被引用键在位
  -- ------------------------------------------------------------------
  select (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_cols
    from pg_constraint c
   where c.conrelid  = 'recruitment.ai_summary'::regclass
     and c.conname   = 'fk_ai_summary_artifact'
     and c.contype   = 'f'
     and c.confrelid = 'recruitment.transcript_artifact'::regclass
     and c.convalidated
     and c.confdeltype = 'r'
     and c.confupdtype = 'r'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['id', 'source_revision', 'tenant_id']::text[];
  if v_cols is distinct from array['tenant_id', 'transcript_artifact_id', 'transcript_revision']::text[] then
    raise exception 'S-8 fk_ai_summary_artifact 不是含 tenant_id 的 3 列形态（实际 %）',
      coalesce(v_cols::text, '（约束不存在）');
  end if;

  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.transcript_artifact'::regclass
     and c.contype  = 'u'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['id', 'source_revision', 'tenant_id']::text[];
  if v_n < 1 then
    raise exception 'S-8 transcript_artifact 缺 unique (tenant_id, id, source_revision)';
  end if;
  raise notice 'S-8 PASS fk_ai_summary_artifact：(tenant_id, artifact, revision) → transcript_artifact(tenant_id, id, source_revision)';

  -- ------------------------------------------------------------------
  -- S-9 GAP-D：ai_summary 上不允许再存在"不含 tenant_id 的转写外键"
  -- ------------------------------------------------------------------
  select string_agg(format('%s(%s)', c.conname, pg_get_constraintdef(c.oid)), ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.ai_summary'::regclass
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
    raise exception 'S-9 存在不含 tenant_id 的转写外键（跨租户后门）：%', v_bad;
  end if;
  raise notice 'S-9 PASS ai_summary 上没有"不含 tenant_id"的转写外键';

  -- ------------------------------------------------------------------
  -- S-10 GAP-E：ck_scorecard_terminal_actor 存在、validated、定义对
  -- ------------------------------------------------------------------
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'recruitment.scorecard'::regclass
     and c.conname  = 'ck_scorecard_terminal_actor'
     and c.contype  = 'c'
     and c.convalidated;
  if v_def is null then
    raise exception 'S-10 ck_scorecard_terminal_actor 不存在或未 validated';
  end if;
  if v_def not like '%status_changed_by_actor_id%' or v_def not like '%PENDING%' then
    raise exception 'S-10 ck_scorecard_terminal_actor 定义不对：%', v_def;
  end if;
  raise notice 'S-10 PASS ck_scorecard_terminal_actor（validated）= %', v_def;

  -- ------------------------------------------------------------------
  -- S-11 GAP-E：trg_scorecard_terminal_actor_guard（before insert）
  -- ------------------------------------------------------------------
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'recruitment.scorecard'::regclass
     and g.tgname  = 'trg_scorecard_terminal_actor_guard'
     and not g.tgisinternal
     and (g.tgtype & 1) = 1
     and (g.tgtype & 2) = 2
     and (g.tgtype & 4) = 4
     and (g.tgtype & 16) = 0
     and g.tgfoid = 'recruitment.fn_scorecard_terminal_actor_guard'::regproc;
  if v_n <> 1 then
    raise exception 'S-11 trg_scorecard_terminal_actor_guard 不在位或形态不对（% / 1）', v_n;
  end if;
  raise notice 'S-11 PASS trg_scorecard_terminal_actor_guard：before insert → fn_scorecard_terminal_actor_guard';

  raise notice 'STRUCT-0007 PASS 五个缺口的 11 条结构断言全部通过';
end $$;


-- =====================================================================
--  §2  改造后的真实定义（"改造后"证据；"改造前"证据见 0007 §0 的日志）
-- =====================================================================

\echo ''
\echo '-- 改造后：0007 新增 / 改写的约束（pg_get_constraintdef 原文）--'
select 'A' as gap, 'fk_decision_stage_catalog'::text as object, pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.conrelid = 'recruitment.decision'::regclass and c.conname = 'fk_decision_stage_catalog'
union all
select 'C', 'fk_scorecard_rubric_job', pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.conrelid = 'recruitment.scorecard'::regclass and c.conname = 'fk_scorecard_rubric_job'
union all
select 'D', 'fk_ai_summary_artifact', pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.conrelid = 'recruitment.ai_summary'::regclass and c.conname = 'fk_ai_summary_artifact'
union all
select 'E', 'ck_scorecard_terminal_actor', pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.conrelid = 'recruitment.scorecard'::regclass and c.conname = 'ck_scorecard_terminal_actor'
order by 1, 2;

\echo '-- 改造后：uq_decision_current（pg_get_indexdef 原文）--'
select pg_get_indexdef(i.indexrelid) as definition
  from pg_index i
 where i.indexrelid = to_regclass('recruitment.uq_decision_current');

\echo '-- 改造后：0007 的两个新触发器 + scorecard.job_id 缺省值 --'
select g.tgname, pg_get_triggerdef(g.oid) as definition
  from pg_trigger g
 where g.tgname in ('trg_scorecard_job_guard', 'trg_scorecard_terminal_actor_guard')
   and not g.tgisinternal
 order by 1;

select a.attname, a.attnotnull as not_null,
       coalesce(pg_get_expr(d.adbin, d.adrelid), '（无默认值）') as default_expr
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
 where a.attrelid = 'recruitment.scorecard'::regclass and a.attname = 'job_id';

\echo '-- 改造后：decision 的列（证明没有 status / status_changed_by_actor_id）--'
select a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) as type
  from pg_attribute a
 where a.attrelid = 'recruitment.decision'::regclass
   and a.attnum > 0 and not a.attisdropped
 order by a.attnum;


-- =====================================================================
--  §3  夹具（脚本结束 ROLLBACK，不留数据）
--      T1 = 完整链：目录 / 部门 / 9 个 actor / 2 岗位 / 2 rubric / 申请 /
--           面试 1 / 面试官 8 / 转写 1
--      T2 = 只有目录 1 行（SX1，T1 没有）+ 会议 + 转写（跨租户引用用）
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 3. 夹具'
\echo '=================================================================='

insert into recruitment.organization (id, name) values
  ('dddddddd-dddd-4ddd-8ddd-000000000001', 'V7 租户甲'),
  ('dddddddd-dddd-4ddd-8ddd-000000000002', 'V7 租户乙');

-- T1 的阶段目录（0004 的 stage_catalog；GAP-A 的外键要靠它）
insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
select 'dddddddd-dddd-4ddd-8ddd-000000000001'::uuid, s.code, s.name, s.ord, s.v1
  from (values ('S1','招聘需求发现',1,false), ('S2','Requisition 创建与审批',2,false),
               ('S3','Job / JD / Rubric 设计',3,true), ('S4','Job Posting 发布',4,false),
               ('S5','人才获取 / Sourcing',5,false), ('S6','简历接入与处理（Intake）',6,true),
               ('S7','初筛 / Screening',7,true), ('S8','面试规划与排期',8,true),
               ('S9','面试执行与材料获取',9,true), ('S10','综合评价与招聘决策',10,true),
               ('S11','Offer 与入职交接',11,false), ('S12','人才沉淀与复盘',12,false)
       ) as s(code, name, ord, v1)
on conflict (tenant_id, code) do nothing;

-- T2 只放一个 T1 没有的 code：用来证明外键是**按租户**的
insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope) values
  ('dddddddd-dddd-4ddd-8ddd-000000000002', 'SX1', '只有乙租户有的阶段', 1, false);

insert into recruitment.department (id, tenant_id, name) values
  ('dddddddd-dddd-4ddd-8ddd-000000000011', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'V7 研发部');

insert into recruitment.actor (id, tenant_id, kind, display_name, primary_email) values
  ('dddddddd-dddd-4ddd-8ddd-000000000101', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'HUMAN', 'V7-HR 甲',        'v7-hr@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000102', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'HUMAN', 'V7-面试官 1',      'v7-iv1@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000103', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'HUMAN', 'V7-面试官 2',      'v7-iv2@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000104', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'HUMAN', 'V7-面试官 3',      'v7-iv3@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000105', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'HUMAN', 'V7-面试官 4',      'v7-iv4@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000106', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'HUMAN', 'V7-面试官 5',      'v7-iv5@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000107', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'HUMAN', 'V7-面试官 6',      'v7-iv6@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000108', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'HUMAN', 'V7-面试官 7',      'v7-iv7@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000109', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'HUMAN', 'V7-面试官 8',      'v7-iv8@example.test'),
  ('dddddddd-dddd-4ddd-8ddd-000000000110', 'dddddddd-dddd-4ddd-8ddd-000000000002', 'HUMAN', 'V7-HR 乙（异租户）', 'v7-hrb@example.test');

insert into recruitment.job (id, tenant_id, department_id, code, title) values
  ('dddddddd-dddd-4ddd-8ddd-000000000121', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000011', 'V7-JOB-1', 'V7 岗位一'),
  ('dddddddd-dddd-4ddd-8ddd-000000000124', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000011', 'V7-JOB-2', 'V7 岗位二');

insert into recruitment.job_version (id, tenant_id, job_id, version_no, description_md, payload_hash) values
  ('dddddddd-dddd-4ddd-8ddd-000000000122', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000121', 1, 'V7 JD v1', repeat('a', 64));

insert into recruitment.rubric_version (id, tenant_id, job_id, version_no, dimensions, payload_hash) values
  ('dddddddd-dddd-4ddd-8ddd-000000000123', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000121', 1, '[{"key":"v7a","weight":1.0}]'::jsonb, repeat('b', 64)),
  ('dddddddd-dddd-4ddd-8ddd-000000000125', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000124', 1, '[{"key":"v7b","weight":1.0}]'::jsonb, repeat('c', 64));

insert into recruitment.candidate (id, tenant_id, display_name, normalized_email) values
  ('dddddddd-dddd-4ddd-8ddd-000000000131', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'V7 候选人甲', 'v7-c1@example.test');

insert into recruitment.application
  (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, current_stage_code)
values
  ('dddddddd-dddd-4ddd-8ddd-000000000141', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000131', 'dddddddd-dddd-4ddd-8ddd-000000000121',
   'dddddddd-dddd-4ddd-8ddd-000000000122', 'dddddddd-dddd-4ddd-8ddd-000000000123', 'S7');

insert into recruitment.interview
  (id, tenant_id, application_id, round_no, slot_code, stage_code, status,
   scheduled_start_at, scheduled_end_at)
values
  ('dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000141', 1, 'V7A', 'S9', 'SCHEDULED',
   now() + interval '1 day', now() + interval '1 day 1 hour');

insert into recruitment.interviewer (id, tenant_id, interview_id, actor_id, role_in_interview) values
  ('dddddddd-dddd-4ddd-8ddd-000000000171', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000102', 'TECH_LEAD'),
  ('dddddddd-dddd-4ddd-8ddd-000000000172', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000103', 'INTERVIEWER'),
  ('dddddddd-dddd-4ddd-8ddd-000000000173', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000104', 'INTERVIEWER'),
  ('dddddddd-dddd-4ddd-8ddd-000000000174', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000105', 'INTERVIEWER'),
  ('dddddddd-dddd-4ddd-8ddd-000000000175', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000106', 'INTERVIEWER'),
  ('dddddddd-dddd-4ddd-8ddd-000000000176', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000107', 'INTERVIEWER'),
  ('dddddddd-dddd-4ddd-8ddd-000000000177', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000108', 'INTERVIEWER'),
  ('dddddddd-dddd-4ddd-8ddd-000000000178', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000109', 'INTERVIEWER');

insert into recruitment.meeting (id, tenant_id, provider, external_meeting_id) values
  ('dddddddd-dddd-4ddd-8ddd-000000000181', 'dddddddd-dddd-4ddd-8ddd-000000000001', 'feishu', 'v7-mtg-1'),
  ('dddddddd-dddd-4ddd-8ddd-000000000182', 'dddddddd-dddd-4ddd-8ddd-000000000002', 'feishu', 'v7-mtg-2');

insert into recruitment.transcript_artifact
  (id, tenant_id, meeting_id, provider, provider_artifact_id, source_revision,
   transcript_status, provenance, trigger_mode, connection_state, raw_text)
values
  ('dddddddd-dddd-4ddd-8ddd-0000000001a1', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000181', 'feishu', 'v7-mn-1', 1,
   'DISCOVERED', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED', '[00:00] V7 甲租户转写'),
  ('dddddddd-dddd-4ddd-8ddd-0000000001a2', 'dddddddd-dddd-4ddd-8ddd-000000000002',
   'dddddddd-dddd-4ddd-8ddd-000000000182', 'feishu', 'v7-mn-2', 1,
   'DISCOVERED', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED', '[00:00] V7 乙租户转写');

\echo ' 夹具就绪：T1 有目录 12 行（S1–S12）/ 岗位 2 / rubric 2 / 面试 1 / 面试官 8；T2 有目录 1 行（SX1）'


-- =====================================================================
--  §4  正向用例：约束不能把正常业务也拦掉
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 4. 正向用例（合法路径必须成功）'
\echo '=================================================================='

do $$
declare
  v_txt text;
  v_n   integer;
begin
  -- 4.1 GAP-A：合法阶段码（S9 在 T1 目录里）可以写
  insert into recruitment.decision
    (id, tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
  values
    ('dddddddd-dddd-4ddd-8ddd-0000000001d4', 'dddddddd-dddd-4ddd-8ddd-000000000001',
     'dddddddd-dddd-4ddd-8ddd-000000000141', 'STAGE', 'S9', 'ADVANCE',
     'dddddddd-dddd-4ddd-8ddd-000000000101', 'POS-7-01 合法阶段');
  raise notice 'POS-7-01 PASS 合法阶段码 S9 可以落库（外键不是"什么都拦"）';

  -- 4.2 GAP-A：stage_code IS NULL 合法（NULL = 不分阶段，不是任意阶段）
  insert into recruitment.decision
    (id, tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
  values
    ('dddddddd-dddd-4ddd-8ddd-0000000001d5', 'dddddddd-dddd-4ddd-8ddd-000000000001',
     'dddddddd-dddd-4ddd-8ddd-000000000141', 'FINAL', null, 'HIRED',
     'dddddddd-dddd-4ddd-8ddd-000000000101', 'POS-7-02 不分阶段');
  raise notice 'POS-7-02 PASS stage_code IS NULL 可以落库（MATCH SIMPLE：NULL 不参与外键检查）';

  -- 4.3 GAP-B：第一条 current STAGE/S10 可以写
  insert into recruitment.decision
    (id, tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
  values
    ('dddddddd-dddd-4ddd-8ddd-0000000001d1', 'dddddddd-dddd-4ddd-8ddd-000000000001',
     'dddddddd-dddd-4ddd-8ddd-000000000141', 'STAGE', 'S10', 'ADVANCE',
     'dddddddd-dddd-4ddd-8ddd-000000000101', 'POS-7-03 当前决策');
  raise notice 'POS-7-03 PASS 第一条 current (STAGE, S10) 可以落库';

  -- 4.4 GAP-B：不同 decision_scope 的当前决策并存是合法的（键含 scope）
  --     0008 之后 FINAL 另受"每个申请最多一条 current FINAL"约束，而本夹具
  --     POS-7-02 已经有一条 FINAL/NULL current；为了让夹具在"有/无 0008"
  --     两种库上都合法，这里用 SCREENING（不同 scope 仍可并存）。
  insert into recruitment.decision
    (id, tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
  values
    ('dddddddd-dddd-4ddd-8ddd-0000000001d3', 'dddddddd-dddd-4ddd-8ddd-000000000001',
     'dddddddd-dddd-4ddd-8ddd-000000000141', 'SCREENING', null, 'HOLD',
     'dddddddd-dddd-4ddd-8ddd-000000000101', 'POS-7-04 另一个 scope');
  raise notice 'POS-7-04 PASS 不同 scope 的 current 决策可以并存（唯一键含 decision_scope；0008 后 FINAL 另受"每申请一条"约束，故用 SCREENING）';

  -- 4.5 GAP-B：历史行可以指向一条**已存在**的决策表示被它取代（superseded 形态合法）
  insert into recruitment.decision
    (id, tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason,
     superseded_by_decision_id)
  values
    ('dddddddd-dddd-4ddd-8ddd-0000000001d2', 'dddddddd-dddd-4ddd-8ddd-000000000001',
     'dddddddd-dddd-4ddd-8ddd-000000000141', 'STAGE', 'S10', 'HOLD',
     'dddddddd-dddd-4ddd-8ddd-000000000101', 'POS-7-05 历史行',
     'dddddddd-dddd-4ddd-8ddd-0000000001d1');
  raise notice 'POS-7-05 PASS superseded 行可以指向已存在的决策（部分唯一索引只约束 current 行）';

  -- 4.6 GAP-C：不写 job_id → 由触发器从 interview → application 唯一推导
  insert into recruitment.scorecard
    (id, tenant_id, interview_id, interviewer_id, rubric_version_id, items, overall)
  values
    ('dddddddd-dddd-4ddd-8ddd-0000000001e1', 'dddddddd-dddd-4ddd-8ddd-000000000001',
     'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000171',
     'dddddddd-dddd-4ddd-8ddd-000000000123', '[]'::jsonb, 'GOOD');
  select job_id into v_txt from recruitment.scorecard where id = 'dddddddd-dddd-4ddd-8ddd-0000000001e1';
  if v_txt is distinct from 'dddddddd-dddd-4ddd-8ddd-000000000121' then
    raise exception 'POS-7-06 不写 job_id 时没有推导出岗位一（实际 %）', v_txt;
  end if;
  raise notice 'POS-7-06 PASS 不写 job_id → 触发器推导为 application.job_id = 岗位一';

  -- 4.7 GAP-C：显式写正确的 job_id 也可以
  insert into recruitment.scorecard
    (id, tenant_id, interview_id, interviewer_id, rubric_version_id, job_id, items, overall)
  values
    ('dddddddd-dddd-4ddd-8ddd-0000000001e2', 'dddddddd-dddd-4ddd-8ddd-000000000001',
     'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000172',
     'dddddddd-dddd-4ddd-8ddd-000000000123', 'dddddddd-dddd-4ddd-8ddd-000000000121',
     '[]'::jsonb, 'GOOD');
  raise notice 'POS-7-07 PASS 显式写正确的 job_id 可以落库';

  -- 4.8 GAP-D：同租户、同 revision 的摘要引用成功
  insert into recruitment.ai_summary
    (id, tenant_id, transcript_artifact_id, transcript_revision, content_md, cited_segments,
     model_id, prompt_version)
  values
    ('dddddddd-dddd-4ddd-8ddd-0000000001f1', 'dddddddd-dddd-4ddd-8ddd-000000000001',
     'dddddddd-dddd-4ddd-8ddd-0000000001a1', 1, 'V7 摘要', '[{"segment":"0-1","at":"00:00"}]'::jsonb,
     'deepseek-v4', 'prompt@1');
  raise notice 'POS-7-08 PASS 同租户同 revision 的 ai_summary 正常落库';

  -- 4.9 GAP-E：显式带 actor 的 SUBMITTED 可以落库
  insert into recruitment.scorecard
    (id, tenant_id, interview_id, interviewer_id, rubric_version_id, status, submitted_at, items,
     overall, status_changed_by_actor_id)
  values
    ('dddddddd-dddd-4ddd-8ddd-0000000001e3', 'dddddddd-dddd-4ddd-8ddd-000000000001',
     'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000173',
     'dddddddd-dddd-4ddd-8ddd-000000000123', 'SUBMITTED', now(), '[{"dim":"V7","score":4}]'::jsonb,
     'GOOD', 'dddddddd-dddd-4ddd-8ddd-000000000102');
  raise notice 'POS-7-09 PASS 显式带 status_changed_by_actor_id 的 SUBMITTED 可以落库';
end $$;

-- 4.10 GAP-E：终态行不写 actor 时，从 0001 的可信服务端通道（SET LOCAL recruitment.actor_id）取
set local recruitment.actor_id = 'dddddddd-dddd-4ddd-8ddd-000000000102';

insert into recruitment.scorecard
  (id, tenant_id, interview_id, interviewer_id, rubric_version_id, status, waive_reason)
values
  ('dddddddd-dddd-4ddd-8ddd-0000000001e4', 'dddddddd-dddd-4ddd-8ddd-000000000001',
   'dddddddd-dddd-4ddd-8ddd-000000000161', 'dddddddd-dddd-4ddd-8ddd-000000000174',
   'dddddddd-dddd-4ddd-8ddd-000000000123', 'WAIVED', 'POS-7-10 面试取消');

set local recruitment.actor_id = '';

do $$
begin
  if (select status_changed_by_actor_id from recruitment.scorecard
       where id = 'dddddddd-dddd-4ddd-8ddd-0000000001e4')
     is distinct from 'dddddddd-dddd-4ddd-8ddd-000000000102'::uuid then
    raise exception 'POS-7-10 没有从 recruitment.actor_id 回填 status_changed_by_actor_id';
  end if;
  raise notice 'POS-7-10 PASS WAIVED + session actor → 列被填为 session actor（CHECK 成立）';
end $$;

-- 4.11 GAP-E：PENDING（默认）不要求 actor（约束不能把草稿也拦掉）
do $$
begin
  if (select status_changed_by_actor_id from recruitment.scorecard
       where id = 'dddddddd-dddd-4ddd-8ddd-0000000001e1') is not null then
    raise exception 'POS-7-11 PENDING 草稿不应该被强制 actor';
  end if;
  raise notice 'POS-7-11 PASS PENDING 草稿不需要 actor（约束只针对终态）';
end $$;


-- =====================================================================
--  §5  负向用例：22 条，每个缺口至少 2 条，逐条断言 SQLSTATE
--      INSERT 与 UPDATE 两条路径都覆盖；被更早的护栏（不可变 / 行护栏）
--      先挡下的，注释里写明"哪条护栏先挡"，不冒充新约束的功劳。
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 5. 负向用例（每条都必须 FAIL，并给出真实 SQLSTATE / 报错）'
\echo '=================================================================='

-- 0008 把 GAP-B 的唯一性改成了 DEFERRABLE INITIALLY DEFERRED：冲突推迟到
-- COMMIT 才报。本脚本整体是一个事务、结尾 ROLLBACK，所以必须在这里把延迟
-- 约束提前成 IMMEDIATE，B-01 .. B-03 才会在同一条语句里报错（而 0007 的
-- 部分唯一索引本来就是立即校验，这句在"无 0008"的库上是 no-op）。
set constraints all immediate;

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
      -- GAP-A：decision.stage_code 必须存在于**本租户**的 stage_catalog
      -- ----------------------------------------------------------------
      ('A-01', '23503', 'GAP-A INSERT 形状合法但目录里没有的阶段 BANANA',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000141',
                  'STAGE','BANANA','ADVANCE','dddddddd-dddd-4ddd-8ddd-000000000101','neg A-01')$q$),

      ('A-02', '23503', 'GAP-A INSERT 作废的五档值 SCREENING（不在 S1–S12）',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000141',
                  'SCREENING','SCREENING','ADVANCE','dddddddd-dddd-4ddd-8ddd-000000000101','neg A-02')$q$),

      ('A-03', '23503', 'GAP-A INSERT 0006 已退场的旧默认值 INTERVIEW',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000141',
                  'STAGE','INTERVIEW','ADVANCE','dddddddd-dddd-4ddd-8ddd-000000000101','neg A-03')$q$),

      ('A-04', '23503', 'GAP-A INSERT 用**别的租户**目录里才有的 SX1（外键按租户隔离）',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000141',
                  'STAGE','SX1','ADVANCE','dddddddd-dddd-4ddd-8ddd-000000000101','neg A-04')$q$),

      ('A-05', '23514', 'GAP-A UPDATE 把已有决策改到 S11（先被 trg_decision_immutable 挡下：decision 的列不可变）',
       $q$update recruitment.decision set stage_code = 'S11'
           where id = 'dddddddd-dddd-4ddd-8ddd-0000000001d1'$q$),

      ('A-06', '23503', 'GAP-A UPDATE 被引用键 stage_catalog.code（S10 被决策引用 → FK ON UPDATE RESTRICT 挡住，证明 FK 在 UPDATE 路径活着）',
       $q$update recruitment.stage_catalog set code = 'S10X'
           where tenant_id = 'dddddddd-dddd-4ddd-8ddd-000000000001' and code = 'S10'$q$),

      -- ----------------------------------------------------------------
      -- GAP-B：同一 (tenant, application, scope, stage) 只能有一条 current
      --   期望 23505（0007 的部分唯一索引）或 23P01（0008 的可延迟排斥约束）
      -- ----------------------------------------------------------------
      ('B-01', '23505|23P01', 'GAP-B INSERT 第二条 current FINAL + stage_code IS NULL（两个 NULL 必须按相等处理：0007 靠 NULLS NOT DISTINCT，0008 靠 coalesce(stage_code, 空串)）',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000141',
                  'FINAL',null,'REJECT','dddddddd-dddd-4ddd-8ddd-000000000101','neg B-01')$q$),

      ('B-02', '23505|23P01', 'GAP-B INSERT 第二条 current STAGE/S10（同一键的重复 current）',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000141',
                  'STAGE','S10','REJECT','dddddddd-dddd-4ddd-8ddd-000000000101','neg B-02')$q$),

      ('B-03', '23505|23P01', 'GAP-B UPDATE 把 superseded 行改回 current（触发当前唯一性：0007 索引 / 0008 排斥约束）',
       $q$update recruitment.decision set superseded_by_decision_id = null
           where id = 'dddddddd-dddd-4ddd-8ddd-0000000001d2'$q$),

      -- ----------------------------------------------------------------
      -- GAP-C：rubric 必须属于"这个申请的那个岗位"
      -- ----------------------------------------------------------------
      ('C-01', '23503', 'GAP-C INSERT 用岗位二的 rubric 给岗位一的面试交面评（不写 job_id，由触发器推导）',
       $q$insert into recruitment.scorecard
            (tenant_id, interview_id, interviewer_id, rubric_version_id, items, overall)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000161',
                  'dddddddd-dddd-4ddd-8ddd-000000000177','dddddddd-dddd-4ddd-8ddd-000000000125',
                  '[]'::jsonb,'POOR')$q$),

      ('C-02', '23514', 'GAP-C INSERT 显式写 job_id = 岗位二（触发器：与 interview → application 的岗位不符）',
       $q$insert into recruitment.scorecard
            (tenant_id, interview_id, interviewer_id, rubric_version_id, job_id, items, overall)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000161',
                  'dddddddd-dddd-4ddd-8ddd-000000000178','dddddddd-dddd-4ddd-8ddd-000000000125',
                  'dddddddd-dddd-4ddd-8ddd-000000000124','[]'::jsonb,'POOR')$q$),

      ('C-03', '23503', 'GAP-C UPDATE 把 PENDING 面评的 rubric 换成岗位二的（复合外键挡住）',
       $q$update recruitment.scorecard set rubric_version_id = 'dddddddd-dddd-4ddd-8ddd-000000000125'
           where id = 'dddddddd-dddd-4ddd-8ddd-0000000001e2'$q$),

      ('C-04', '23514', 'GAP-C UPDATE 把 PENDING 面评的 job_id 改成岗位二（触发器挡住）',
       $q$update recruitment.scorecard set job_id = 'dddddddd-dddd-4ddd-8ddd-000000000124'
           where id = 'dddddddd-dddd-4ddd-8ddd-0000000001e2'$q$),

      -- ----------------------------------------------------------------
      -- GAP-D：摘要的转写必须同租户 + 同 revision
      -- ----------------------------------------------------------------
      ('D-01', '23503', 'GAP-D INSERT 甲租户摘要引用**乙租户**的 transcript_artifact',
       $q$insert into recruitment.ai_summary
            (tenant_id, transcript_artifact_id, transcript_revision, content_md, cited_segments,
             model_id, prompt_version)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-0000000001a2',1,
                  '跨租户摘要','[{"segment":"0-1","at":"00:00"}]'::jsonb,'deepseek-v4','prompt@1')$q$),

      ('D-02', '23503', 'GAP-D INSERT 同租户但 revision 对不上（artifact 只有 1，声称 2）',
       $q$insert into recruitment.ai_summary
            (tenant_id, transcript_artifact_id, transcript_revision, content_md, cited_segments,
             model_id, prompt_version)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-0000000001a1',2,
                  '版本错','[{"segment":"0-1","at":"00:00"}]'::jsonb,'deepseek-v4','prompt@1')$q$),

      ('D-03', '23514', 'GAP-D UPDATE 把已有摘要改指向乙租户的 artifact（先被 trg_ai_summary_immutable 挡下）',
       $q$update recruitment.ai_summary
             set transcript_artifact_id = 'dddddddd-dddd-4ddd-8ddd-0000000001a2'
           where id = 'dddddddd-dddd-4ddd-8ddd-0000000001f1'$q$),

      ('D-04', '23514', 'GAP-D UPDATE 试图把被引用的转写搬到另一个租户（先被 trg_transcript_artifact_immutable 挡下）',
       $q$update recruitment.transcript_artifact
             set tenant_id = 'dddddddd-dddd-4ddd-8ddd-000000000002'
           where id = 'dddddddd-dddd-4ddd-8ddd-0000000001a1'$q$),

      -- ----------------------------------------------------------------
      -- GAP-E：直接 INSERT 终态行不能绕过 actor（scorecard 侧）
      -- ----------------------------------------------------------------
      ('E-01', '23514', 'GAP-E INSERT SUBMITTED 不写 actor、也没有 session actor（新 CHECK / 新触发器挡住）',
       $q$insert into recruitment.scorecard
            (tenant_id, interview_id, interviewer_id, rubric_version_id, status, submitted_at, items)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000161',
                  'dddddddd-dddd-4ddd-8ddd-000000000175','dddddddd-dddd-4ddd-8ddd-000000000123',
                  'SUBMITTED', now(), '[]'::jsonb)$q$),

      ('E-02', '23514', 'GAP-E INSERT WAIVED 不写 actor、也没有 session actor',
       $q$insert into recruitment.scorecard
            (tenant_id, interview_id, interviewer_id, rubric_version_id, status, waive_reason)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000161',
                  'dddddddd-dddd-4ddd-8ddd-000000000176','dddddddd-dddd-4ddd-8ddd-000000000123',
                  'WAIVED','neg E-02')$q$),

      ('E-03', '23514', 'GAP-E UPDATE PENDING → SUBMITTED 不给 actor（这条路径 0007 之前就被 fn_row_guard 关着：ACTOR_REQUIRED）',
       $q$update recruitment.scorecard
             set status = 'SUBMITTED', submitted_at = now(), items = '[]'::jsonb
           where id = 'dddddddd-dddd-4ddd-8ddd-0000000001e1'$q$),

      -- ----------------------------------------------------------------
      -- GAP-E · decision 侧：**本缺口不成立**的实测证据（不是新约束的负向测试）
      -- ----------------------------------------------------------------
      ('E-04', '42703', 'GAP-E 事实核对：decision 没有 status_changed_by_actor_id 列（写入它 → 字段不存在）',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id,
             reason, status_changed_by_actor_id)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000141',
                  'STAGE','S9','ADVANCE','dddddddd-dddd-4ddd-8ddd-000000000101','neg E-04',
                  'dddddddd-dddd-4ddd-8ddd-000000000101')$q$),

      ('E-05', '23502', 'GAP-E 事实核对：decision 的 actor 由 decided_by_actor_id NOT NULL 强制（不写它 → 23502）',
       $q$insert into recruitment.decision
            (tenant_id, application_id, decision_scope, stage_code, result, reason)
          values ('dddddddd-dddd-4ddd-8ddd-000000000001','dddddddd-dddd-4ddd-8ddd-000000000141',
                  'STAGE','S9','ADVANCE','neg E-05')$q$)
    ) as v(id, expect, what, sql)
  loop
    begin
      execute r.sql;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      -- expect 允许写多个 SQLSTATE（用 | 分隔）：0008 会把 GAP-B 的 23505 变成 23P01
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

  if v_ok <> 22 then
    raise exception 'NEGATIVE-0007 只跑了 % 条（期望 22）', v_ok;
  end if;
  raise notice 'NEGATIVE-0007 SUMMARY % 条负向测试全部按预期失败（A:6 / B:3 / C:4 / D:4 / E:5）', v_ok;
end $$;


-- =====================================================================
--  §6  数据面复核（夹具也在内：正反两侧都要真的干净）
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
  -- 6.1 没有任何 decision 的阶段 code 落在自己租户目录之外（NULL 合法）
  select count(*) into v_n
    from recruitment.decision d
   where d.stage_code is not null
     and not exists (select 1 from recruitment.stage_catalog s
                      where s.tenant_id = d.tenant_id and s.code = d.stage_code);
  if v_n <> 0 then
    raise exception 'DATA-0007-01 仍有 % 条 decision 的 stage_code 不在目录中', v_n;
  end if;
  raise notice 'DATA-0007-01 PASS 全部 decision 的 stage_code 都在各自租户目录内（NULL 除外）';

  -- 6.2 没有任何 (tenant, application, scope, stage) 有两条 current 行
  --     （group by 把 NULL 当相等 —— 与 NULLS NOT DISTINCT 同语义）
  select count(*) into v_n
    from (
      select 1 from recruitment.decision
       where superseded_by_decision_id is null
       group by tenant_id, application_id, decision_scope, stage_code
      having count(*) > 1
    ) d;
  if v_n <> 0 then
    raise exception 'DATA-0007-02 仍有 % 组重复的 current 决策', v_n;
  end if;
  raise notice 'DATA-0007-02 PASS 全库没有重复的 current 决策（NULL stage_code 也按相等处理）';

  -- 6.3 没有 job_id 为空的 scorecard
  select count(*) into v_n from recruitment.scorecard where job_id is null;
  if v_n <> 0 then
    raise exception 'DATA-0007-03 仍有 % 条 scorecard 的 job_id 为空', v_n;
  end if;
  raise notice 'DATA-0007-03 PASS 全部 scorecard 都有 job_id（NOT NULL 生效）';

  -- 6.4 没有 rubric 不属于该申请岗位的 scorecard
  select count(*) into v_n
    from recruitment.scorecard s
    join recruitment.interview i
      on i.id = s.interview_id and i.tenant_id = s.tenant_id
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
    join recruitment.rubric_version rv
      on rv.id = s.rubric_version_id and rv.tenant_id = s.tenant_id
   where rv.job_id <> a.job_id;
  if v_n <> 0 then
    raise exception 'DATA-0007-04 仍有 % 条 scorecard 用了别的岗位的 rubric', v_n;
  end if;
  raise notice 'DATA-0007-04 PASS 全部 scorecard 的 rubric 都属于该申请的岗位';

  -- 6.5 没有跨租户的 ai_summary → artifact
  select count(*) into v_n
    from recruitment.ai_summary s
    join recruitment.transcript_artifact ta on ta.id = s.transcript_artifact_id
   where ta.tenant_id <> s.tenant_id;
  if v_n <> 0 then
    raise exception 'DATA-0007-05 仍有 % 条 ai_summary 跨租户引用 artifact', v_n;
  end if;
  raise notice 'DATA-0007-05 PASS 全部 ai_summary 的 artifact 引用都在同租户';

  -- 6.6 没有终态 scorecard 缺 actor
  select count(*) into v_n
    from recruitment.scorecard
   where status <> 'PENDING' and status_changed_by_actor_id is null;
  if v_n <> 0 then
    raise exception 'DATA-0007-06 仍有 % 条终态 scorecard 缺 actor', v_n;
  end if;
  raise notice 'DATA-0007-06 PASS 全部终态 scorecard 都有 status_changed_by_actor_id';

  -- 6.7 全库：多列外键全部含 tenant_id（GAP-D 之后不该再有例外）
  select string_agg(format('%s(%s)', c.conrelid::regclass, c.conname), ', ') into v_bad
    from pg_constraint c
   where c.contype = 'f'
     and cardinality(c.conkey) > 1
     and not exists (
       select 1 from unnest(c.conkey) k
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
        where a.attname = 'tenant_id');
  if v_bad is not null then
    raise exception 'DATA-0007-07 全库仍有不含 tenant_id 的多列外键：%', v_bad;
  end if;
  raise notice 'DATA-0007-07 PASS 全库多列外键全部含 tenant_id（0 条例外）';
end $$;


-- =====================================================================
--  §7  GAP-E 的 decision 侧：本缺口不成立的实测证据（只打印，不断言）
-- =====================================================================

\echo ''
\echo '=================================================================='
\echo ' 7. GAP-E · decision 侧「本缺口不成立」的实测证据'
\echo '=================================================================='

\echo '-- decision 是否有 status / status_changed_by_actor_id / status_source_event_id --'
select a.attname
  from pg_attribute a
 where a.attrelid = 'recruitment.decision'::regclass
   and a.attname in ('status', 'status_changed_by_actor_id', 'status_source_event_id',
                     'decided_by_actor_id', 'decided_at')
 order by a.attname;

\echo '-- decided_by_actor_id 是 NOT NULL + 同租户外键：decision 的 INSERT 上 actor 不可能缺席 --'
select c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
 where c.conrelid = 'recruitment.decision'::regclass
   and c.conname in ('fk_decision_actor')
union all
select 'decided_by_actor_id NOT NULL', 'n', null, a.attnotnull::text
  from pg_attribute a
 where a.attrelid = 'recruitment.decision'::regclass and a.attname = 'decided_by_actor_id';

\echo '-- 结论：E-04 = 42703（列不存在）；E-05 = 23502（actor 缺失被 NOT NULL 拦）--'
\echo '--   两条都说明：decision 的"终态行不写 actor"不是可写状态，GAP-E 在 decision 上不成立。--'

\echo ''
\echo '-- 夹具行数（脚本回滚前）--'
select 'decision'    as t, count(*) from recruitment.decision
union all select 'scorecard',    count(*) from recruitment.scorecard
union all select 'interviewer',  count(*) from recruitment.interviewer
union all select 'ai_summary',   count(*) from recruitment.ai_summary
union all select 'interview',    count(*) from recruitment.interview
order by 1;

\echo ''
\echo '=== ROLLBACK：自检不改变数据库 ==='
rollback;

\echo ''
\echo '=================================================================='
\echo ' VERIFY-0007 PASS：11 条结构断言 + 11 条正向 + 22 条负向 + 7 条数据面全部通过（GAP-E 的 decision 侧已实测判定不成立）'
