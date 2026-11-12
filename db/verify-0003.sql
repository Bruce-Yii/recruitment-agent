-- =====================================================================
--  recruitment-agent · db/verify-0003.sql
--  0003_review_queue.sql 的自检：结构断言 + 状态机矩阵 + 一条完整正例
--  + 25 条负向测试（每条断言 SQLSTATE）。
--
--  用法（必须用 psql 跑，本文件含 \echo 等元命令）：
--    psql -v ON_ERROR_STOP=1 -d <db> -f db/verify-0003.sql
--  前置：同库已执行 0001_init.sql + 0003_review_queue.sql。
--
--  行为保证：
--    * 整个脚本在一个事务里执行，结尾 ROLLBACK —— 不留任何数据；
--    * 任何断言失败都 RAISE EXCEPTION（exit code != 0），不会静默通过；
--    * 负向测试打印数据库真实返回的 SQLSTATE 与 message_text。
-- =====================================================================

\set ON_ERROR_STOP on
\echo '=================================================================='
\echo ' 0. 环境'
\echo '=================================================================='

select current_database() as database,
       current_setting('server_version') as pg_version,
       to_regclass('recruitment.conversion_run') is not null as has_0003,
       to_regclass('recruitment.review_queue') is not null as has_review_queue,
       to_regclass('recruitment.review_audit') is not null as has_review_audit;

begin;

\echo ''
\echo '=================================================================='
\echo ' 1. 对象清单（0003 建出来的东西）'
\echo '    口径：字段数 / NOT NULL 问 information_schema.columns；'
\echo '          约束按类型问 pg_constraint（PG17 的 information_schema 把 NOT NULL'
\echo '          也记成 CHECK，直接用它的合计数会虚高，见 1.1 的交叉核对）。'
\echo '=================================================================='

select c.relname as "表",
       (select count(*) from information_schema.columns col
         where col.table_schema = 'recruitment' and col.table_name = c.relname) as "字段数",
       (select count(*) from information_schema.columns col
         where col.table_schema = 'recruitment' and col.table_name = c.relname
           and col.is_nullable = 'NO') as "NOT NULL",
       (select count(*) from pg_constraint p where p.conrelid = c.oid and p.contype = 'p') as "PK",
       (select count(*) from pg_constraint p where p.conrelid = c.oid and p.contype = 'u') as "UNIQUE",
       (select count(*) from pg_constraint p where p.conrelid = c.oid and p.contype = 'f') as "FK",
       (select count(*) from pg_constraint p where p.conrelid = c.oid and p.contype = 'c') as "CHECK",
       (select count(*) from pg_constraint p where p.conrelid = c.oid) as "约束合计",
       (select count(*) from pg_index i where i.indrelid = c.oid) as "索引",
       (select count(*) from pg_trigger g where g.tgrelid = c.oid and not g.tgisinternal) as "触发器"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'recruitment'
   and c.relname in ('conversion_run','review_queue','review_audit')
 order by c.relname;

\echo ''
\echo ' 1.1 交叉核对：information_schema 的 CHECK 数 == 真实 CHECK 数 + NOT NULL 列数'

select c.relname as "表",
       (select count(*) from information_schema.table_constraints tc
         where tc.table_schema = 'recruitment' and tc.table_name = c.relname
           and tc.constraint_type = 'CHECK') as "infoschema CHECK",
       (select count(*) from pg_constraint p where p.conrelid = c.oid and p.contype = 'c') as "真实 CHECK",
       (select count(*) from information_schema.columns col
         where col.table_schema = 'recruitment' and col.table_name = c.relname
           and col.is_nullable = 'NO') as "NOT NULL"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'recruitment'
   and c.relname in ('conversion_run','review_queue','review_audit')
 order by c.relname;

select 'views' as kind, count(*)::text as n
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'recruitment' and c.relkind = 'v'
   and c.relname in ('v_review_open','v_source_gate','v_conversion_ledger')
union all
select 'functions(0003)', count(*)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'recruitment'
   and p.proname in ('fn_issue_codes_valid','fn_require_actor','fn_review_transition_allowed',
                     'fn_review_queue_before_insert','fn_review_queue_before_update','fn_review_audit_write');


\echo ''
\echo '=================================================================='
\echo ' 2. 结构断言（任何一条不满足即整体失败，exit != 0）'
\echo '=================================================================='

do $$
declare
  v_bad  text;
  v_n    integer;
  v_def  text;
  v_val  text;
  v_cols text[];
  r      record;
begin
  -- 2.1 三张表都在
  select string_agg(t, ', ') into v_bad
    from unnest(array['conversion_run','review_queue','review_audit']) t
   where to_regclass('recruitment.' || t) is null;
  if v_bad is not null then
    raise exception 'STRUCT-01 缺表：%', v_bad;
  end if;
  raise notice 'STRUCT-01 PASS 三张表都存在';

  -- 2.2 单列 uuid 主键，且列名必须是 id（D-36；改名前是 run_id / item_id / audit_id）
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment'
     and c.relname in ('conversion_run','review_queue','review_audit')
     and not exists (
       select 1
         from pg_constraint p
         join pg_attribute a on a.attrelid = p.conrelid and a.attnum = p.conkey[1]
         join pg_type ty on ty.oid = a.atttypid
        where p.conrelid = c.oid and p.contype = 'p'
          and array_length(p.conkey, 1) = 1 and ty.typname = 'uuid'
          and a.attname = 'id');
  if v_bad is not null then
    raise exception 'STRUCT-02 这些表的主键不是单列 uuid 的 id（D-36）：%', v_bad;
  end if;
  raise notice 'STRUCT-02 PASS 三张表都是单列 uuid 主键，列名 = id';

  -- 2.3 tenant_id NOT NULL + 外键到 organization（与 0001 的全局约定一致）
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment'
     and c.relname in ('conversion_run','review_queue','review_audit')
     and (not exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'tenant_id'
                         and a.attnotnull and not a.attisdropped)
          or not exists (select 1 from pg_constraint p
                          where p.conrelid = c.oid and p.contype = 'f'
                            and p.confrelid = 'recruitment.organization'::regclass));
  if v_bad is not null then
    raise exception 'STRUCT-03 这些表缺 NOT NULL tenant_id 或其外键：%', v_bad;
  end if;
  raise notice 'STRUCT-03 PASS 三张表都有 NOT NULL tenant_id + 外键到 organization';

  -- 2.4 必备字段齐全，且字段数正好（多一列少一列都失败）
  --     [D-36] 主键列名：id；review_queue.run_id 与 review_audit.item_id 是对外引用列，保留原名
  for r in select * from (values
    ('conversion_run', array['id','tenant_id','source_sha256','source_name','converter_version',
                             'status','completeness','needs_visual','issue_codes','pages','blocks',
                             'elapsed_ms','started_at','finished_at','recorded_at','result_json']::text[]),
    ('review_queue', array['id','tenant_id','run_id','status','assignee','deadline','opened_at',
                           'closed_at','machine_result','human_result','reason','record_version','updated_at']::text[]),
    ('review_audit', array['id','audit_seq','tenant_id','item_id','from_status','to_status',
                           'actor','reason','at']::text[])
  ) as v(tbl, cols)
  loop
    select array_agg(column_name::text order by ordinal_position) into v_cols
      from information_schema.columns
     where table_schema = 'recruitment' and table_name = r.tbl;
    if not (v_cols @> r.cols) then
      raise exception 'STRUCT-04 %.% 缺列：期望 %，实际 %', 'recruitment', r.tbl, r.cols, v_cols;
    end if;
    if cardinality(v_cols) <> cardinality(r.cols) then
      raise exception 'STRUCT-04 %.% 字段数应为 %，实际 %：%',
        'recruitment', r.tbl, cardinality(r.cols), cardinality(v_cols), v_cols;
    end if;
  end loop;
  raise notice 'STRUCT-04 PASS 字段齐全且字段数精确（16 / 13 / 9）';

  -- 2.5 状态取值必须被 CHECK 逐个列全（少一个就失败）
  for r in select * from (values
    ('ck_conversion_run_status', array['ACCEPTED','QUARANTINED','FAILED','CRASHED']::text[]),
    ('ck_review_queue_status',  array['QUEUED','IN_REVIEW','CORRECTED','APPROVED','REJECTED','REPROCESS']::text[]),
    ('ck_review_audit_to',      array['QUEUED','IN_REVIEW','CORRECTED','APPROVED','REJECTED','REPROCESS']::text[])
  ) as v(cname, vals)
  loop
    select pg_get_constraintdef(oid) into v_def
      from pg_constraint
     where conname = r.cname and connamespace = 'recruitment'::regnamespace;
    if v_def is null then
      raise exception 'STRUCT-05 缺约束 %', r.cname;
    end if;
    foreach v_val in array r.vals loop
      if position('''' || v_val || '''' in v_def) = 0 then
        raise exception 'STRUCT-05 % 的取值缺 %：%', r.cname, v_val, v_def;
      end if;
    end loop;
  end loop;
  raise notice 'STRUCT-05 PASS 状态 CHECK 覆盖全部取值（4 / 6 / 6）';

  -- 2.6 外键数量 + review_queue → conversion_run 必须是 (run_id, tenant_id) 复合外键
  --     指向 conversion_run.id（D-36 前的列名叫 run_id；队列侧引用列仍叫 run_id）
  for r in select * from (values ('conversion_run',1),('review_queue',3),('review_audit',3)) as v(tbl, fk)
  loop
    select count(*) into v_n
      from pg_constraint p
      join pg_class c on c.oid = p.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'recruitment' and c.relname = r.tbl and p.contype = 'f';
    if v_n <> r.fk then
      raise exception 'STRUCT-06 % 的外键数应为 %，实际 %', r.tbl, r.fk, v_n;
    end if;
  end loop;

  select count(*) into v_n
    from pg_constraint p
   where p.conname = 'fk_review_queue_run' and p.contype = 'f'
     and p.confrelid = 'recruitment.conversion_run'::regclass
     and array_length(p.conkey, 1) = 2 and array_length(p.confkey, 1) = 2;
  if v_n <> 1 then
    raise exception 'STRUCT-06 fk_review_queue_run 不是指向 conversion_run(id, tenant_id) 的复合外键';
  end if;
  raise notice 'STRUCT-06 PASS 外键 1/3/3，run 引用是带 tenant_id 的复合外键';

  -- 2.7 source_sha256 必须有索引（按文件查历史）
  select count(*) into v_n
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
   where i.indrelid = 'recruitment.conversion_run'::regclass and a.attname = 'source_sha256';
  if v_n < 1 then
    raise exception 'STRUCT-07 source_sha256 上没有索引';
  end if;
  raise notice 'STRUCT-07 PASS source_sha256 有索引（按文件查历史）';

  -- 2.8 触发器齐、时机/事件正确
  for r in select * from (values
    ('conversion_run','trg_conversion_run_immutable',    'BEFORE','UPDATE'),
    ('conversion_run','trg_conversion_run_no_delete',    'BEFORE','DELETE'),
    ('review_queue',  'trg_review_queue_before_insert',  'BEFORE','INSERT'),
    ('review_queue',  'trg_review_queue_before_update',  'BEFORE','UPDATE'),
    ('review_queue',  'trg_review_queue_audit',          'AFTER', 'UPDATE'),
    ('review_queue',  'trg_review_queue_no_delete',      'BEFORE','DELETE'),
    ('review_audit',  'trg_review_audit_no_update',      'BEFORE','UPDATE'),
    ('review_audit',  'trg_review_audit_no_delete',      'BEFORE','DELETE')
  ) as v(tbl, tname, timing, event)
  loop
    select pg_get_triggerdef(g.oid) into v_def
      from pg_trigger g
      join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'recruitment' and c.relname = r.tbl
       and g.tgname = r.tname and not g.tgisinternal;
    if v_def is null then
      raise exception 'STRUCT-08 缺触发器 %.%', r.tbl, r.tname;
    end if;
    if position(r.timing in upper(v_def)) = 0 or position(r.event in upper(v_def)) = 0 then
      raise exception 'STRUCT-08 %.% 的时机/事件不对：%', r.tbl, r.tname, v_def;
    end if;
  end loop;

  -- 审计触发器必须同时覆盖 INSERT 与 UPDATE（入队也要留痕）
  select pg_get_triggerdef(g.oid) into v_def
    from pg_trigger g
    join pg_class c on c.oid = g.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment' and c.relname = 'review_queue'
     and g.tgname = 'trg_review_queue_audit';
  if position('INSERT' in upper(v_def)) = 0 or position('UPDATE' in upper(v_def)) = 0 then
    raise exception 'STRUCT-08 审计触发器没有同时覆盖 INSERT/UPDATE：%', v_def;
  end if;
  raise notice 'STRUCT-08 PASS 8 个触发器齐全（审计触发器覆盖 INSERT+UPDATE）';

  -- 2.9 三个视图都在
  select string_agg(v, ', ') into v_bad
    from unnest(array['v_review_open','v_source_gate','v_conversion_ledger']) v
   where to_regclass('recruitment.' || v) is null;
  if v_bad is not null then
    raise exception 'STRUCT-09 缺视图：%', v_bad;
  end if;
  raise notice 'STRUCT-09 PASS 三个视图都在';

  -- 2.10 审计的唯一索引（防重复迁移、防重复入队记录）
  select string_agg(x, ', ') into v_bad
    from unnest(array['uq_review_audit_initial','uq_review_audit_transition','uq_review_queue_run']) x
   where not exists (
     select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'recruitment' and c.relname = x and c.relkind = 'i');
  if v_bad is not null then
    raise exception 'STRUCT-10 缺唯一索引：%', v_bad;
  end if;
  raise notice 'STRUCT-10 PASS 唯一索引齐全（入队一次性 / 迁移一次性）';

  -- 2.11 约束总数必须精确（19 / 18 / 8），防止「悄悄少一条」
  for r in select * from (values ('conversion_run',19),('review_queue',18),('review_audit',8)) as v(tbl, n)
  loop
    select count(*) into v_n
      from pg_constraint p
      join pg_class c on c.oid = p.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'recruitment' and c.relname = r.tbl;
    if v_n <> r.n then
      raise exception 'STRUCT-11 % 的约束数应为 %，实际 %', r.tbl, r.n, v_n;
    end if;
  end loop;
  raise notice 'STRUCT-11 PASS 约束总数精确（conversion_run 19 / review_queue 18 / review_audit 8）';

  -- 2.12 information_schema 的 CHECK 虚高必须能被解释（= 真实 CHECK + NOT NULL），
  --      否则说明「约束数」这个口径本身不可信
  for r in select * from (values ('conversion_run'),('review_queue'),('review_audit')) as v(tbl)
  loop
    select count(*) into v_n
      from information_schema.table_constraints tc
     where tc.table_schema = 'recruitment' and tc.table_name = r.tbl
       and tc.constraint_type = 'CHECK';
    if v_n <> (select count(*) from pg_constraint p
                 join pg_class c on c.oid = p.conrelid
                 join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'recruitment' and c.relname = r.tbl and p.contype = 'c')
             + (select count(*) from information_schema.columns col
                 where col.table_schema = 'recruitment' and col.table_name = r.tbl
                   and col.is_nullable = 'NO') then
      raise exception 'STRUCT-12 % 的 information_schema CHECK 数解释不通（≠ 真实 CHECK + NOT NULL）', r.tbl;
    end if;
  end loop;
  raise notice 'STRUCT-12 PASS 约束口径自洽（information_schema CHECK = 真实 CHECK + NOT NULL）';
end $$;


\echo ''
\echo '=================================================================='
\echo ' 3. 状态机矩阵：6×6 = 36 格，只允许 8 条边（Y = 允许，- = 拒绝）'
\echo '=================================================================='

with s(x, ord) as (values
  ('QUEUED',1),('IN_REVIEW',2),('CORRECTED',3),('APPROVED',4),('REJECTED',5),('REPROCESS',6))
select f.x as "from \ to",
       max(case when t.x = 'QUEUED'    then case when recruitment.fn_review_transition_allowed(f.x,t.x) then 'Y' else '-' end end) as "QUEUED",
       max(case when t.x = 'IN_REVIEW' then case when recruitment.fn_review_transition_allowed(f.x,t.x) then 'Y' else '-' end end) as "IN_REVIEW",
       max(case when t.x = 'CORRECTED' then case when recruitment.fn_review_transition_allowed(f.x,t.x) then 'Y' else '-' end end) as "CORRECTED",
       max(case when t.x = 'APPROVED'  then case when recruitment.fn_review_transition_allowed(f.x,t.x) then 'Y' else '-' end end) as "APPROVED",
       max(case when t.x = 'REJECTED'  then case when recruitment.fn_review_transition_allowed(f.x,t.x) then 'Y' else '-' end end) as "REJECTED",
       max(case when t.x = 'REPROCESS' then case when recruitment.fn_review_transition_allowed(f.x,t.x) then 'Y' else '-' end end) as "REPROCESS"
  from s f cross join s t
 group by f.x, f.ord
 order by f.ord;

do $$
declare
  v_allowed integer;
  v_total   integer;
begin
  select count(*) filter (where recruitment.fn_review_transition_allowed(a, b)), count(*)
    into v_allowed, v_total
    from unnest(array['QUEUED','IN_REVIEW','CORRECTED','APPROVED','REJECTED','REPROCESS']) a
    cross join unnest(array['QUEUED','IN_REVIEW','CORRECTED','APPROVED','REJECTED','REPROCESS']) b;

  if v_total <> 36 or v_allowed <> 8 then
    raise exception 'MATRIX 期望 36 格 / 8 条允许边，实际 % / %', v_total, v_allowed;
  end if;

  if recruitment.fn_review_transition_allowed('QUEUED','APPROVED') then
    raise exception 'MATRIX QUEUED→APPROVED 必须禁止（没有人受理就放行）';
  end if;
  if recruitment.fn_review_transition_allowed('QUEUED','CORRECTED') then
    raise exception 'MATRIX QUEUED→CORRECTED 必须禁止';
  end if;
  if recruitment.fn_review_transition_allowed('IN_REVIEW','QUEUED') then
    raise exception 'MATRIX IN_REVIEW→QUEUED 必须禁止（交接靠改 assignee，不靠退回队列）';
  end if;
  if recruitment.fn_review_transition_allowed('APPROVED','IN_REVIEW')
     or recruitment.fn_review_transition_allowed('REJECTED','APPROVED')
     or recruitment.fn_review_transition_allowed('REPROCESS','IN_REVIEW') then
    raise exception 'MATRIX 终态必须不可再迁出';
  end if;
  if not recruitment.fn_review_transition_allowed('CORRECTED','APPROVED') then
    raise exception 'MATRIX CORRECTED→APPROVED 必须允许';
  end if;

  raise notice 'MATRIX PASS 36 格 / 8 条允许边；QUEUED→APPROVED 等跨级跳全部禁止';
end $$;


\echo ''
\echo '=================================================================='
\echo ' 4. 正例：建 run → 入队 → IN_REVIEW → CORRECTED → APPROVED → 审计逐条查回'
\echo '=================================================================='

\echo ''
\echo ' 4.1 夹具：两个租户 / 四个 actor / 七个 run（第八个在 4.9 追加）'

set local recruitment.actor_id = '11111111-0000-0000-0000-000000000003';

insert into recruitment.organization (id, name) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', '租户甲（队列验收）'),
  ('aaaaaaaa-0000-0000-0000-0000000000b1', '租户乙（跨租户用例）');

insert into recruitment.actor (id, tenant_id, kind, display_name, primary_email) values
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'HUMAN',  'HR 甲',        'hr-a@example.com'),
  ('11111111-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'HUMAN',  '复核 乙',      'hr-b@example.com'),
  ('11111111-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'SYSTEM', '转换器（系统）', 'conv@example.com'),
  ('22222222-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'HUMAN',  '租户乙 HR',    'hr-c@example.com');

-- R1 正例（顺序类 HARD）；R2 机器已 ACCEPTED；R3 结构性失败但「没人入队」（漏记检测）
-- R4 读取器崩溃；R5 纯图像页；R6 用于终态用例；R7 三天前入队（超期）；
-- R8 与 R1 同 sha256 的第二次调用（OBS-02：两条记录，不覆盖）
insert into recruitment.conversion_run
  (id, tenant_id, source_sha256, source_name, converter_version, status, completeness,
   needs_visual, issue_codes, pages, blocks, elapsed_ms, started_at, finished_at, result_json)
values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', repeat('1',64),
   'candidate-001.pdf', 'pymupdf+layout/1.28.0', 'QUARANTINED', 'partial', false,
   array['pdf_reading_order_unverified'], 11, 133, 4120,
   now() - interval '30 minutes', now() - interval '29 minutes',
   jsonb_build_object('issue_codes', jsonb_build_array('pdf_reading_order_unverified'),
                      'pages', 11, 'blocks', 133, 'hard_codes', jsonb_build_array('pdf_reading_order_unverified'))),
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', repeat('2',64),
   'candidate-002.pdf', 'pymupdf+layout/1.28.0', 'ACCEPTED', 'complete', false,
   '{}'::text[], 2, 47, 890,
   now() - interval '20 minutes', now() - interval '19 minutes',
   jsonb_build_object('pages', 2, 'blocks', 47, 'field_states', jsonb_build_object('name','present'))),
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-0000000000a1', repeat('3',64),
   'candidate-003.pdf', 'pymupdf+layout/1.28.0', 'FAILED', 'partial', false,
   array['encrypted_pdf'], 0, 0, 120,
   now() - interval '15 minutes', now() - interval '14 minutes', null),
  ('cccccccc-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-0000000000a1', repeat('4',64),
   'candidate-004.pdf', 'pymupdf+layout/1.28.0', 'CRASHED', 'unverified', false,
   array['reader_crashed'], 0, 0, 50,
   now() - interval '12 minutes', now() - interval '11 minutes',
   jsonb_build_object('error', 'reader_crashed')),
  ('cccccccc-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000000a1', repeat('5',64),
   'candidate-005.pdf', 'pymupdf+layout/1.28.0', 'QUARANTINED', 'partial', true,
   array['unread_visual_page','pdf_no_text'], 1, 0, 640,
   now() - interval '10 minutes', now() - interval '9 minutes',
   jsonb_build_object('needs_visual', true, 'pages', 1, 'blocks', 0)),
  ('cccccccc-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000000a1', repeat('6',64),
   'candidate-006.pdf', 'pymupdf+layout/1.28.0', 'QUARANTINED', 'partial', false,
   array['pdf_reading_order_unverified'], 5, 88, 2100,
   now() - interval '8 minutes', now() - interval '7 minutes',
   jsonb_build_object('issue_codes', jsonb_build_array('pdf_reading_order_unverified'))),
  ('cccccccc-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000000a1', repeat('7',64),
   'candidate-007.pdf', 'pymupdf+layout/1.28.0', 'QUARANTINED', 'partial', true,
   array['pdf_no_text'], 3, 0, 300,
   now() - interval '3 days', now() - interval '3 days' + interval '1 minute',
   jsonb_build_object('needs_visual', true, 'pages', 3, 'blocks', 0));

-- 正例用 Q1：先只入队，后续 4.3/4.4/4.5 逐步推进。
-- 其它条目（Q4/Q5/Q6/Q7）放到 4.8 再建，这样 Q1 的审计序号是连续的 1..4，
-- 便于「逐条查回」。
insert into recruitment.review_queue (id, tenant_id, run_id, machine_result, reason) values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1',
   'cccccccc-0000-0000-0000-000000000001',
   jsonb_build_object('run_status','QUARANTINED','completeness','partial','pages',11,'blocks',133,
                      'issue_codes', jsonb_build_array('pdf_reading_order_unverified'), 'needs_visual', false),
   '机器判定：pdf_reading_order_unverified（doc 11 A4 HARD，需人工核对）');

\echo ''
\echo ' 4.2 入队即留痕：Q1 的 deadline / 状态 / 第一条审计'

select id, status, assignee is null as assignee_null, closed_at is null as closed_null,
       round(extract(epoch from (deadline - now())) / 3600.0, 2) as hours_to_deadline,
       record_version
  from recruitment.review_queue
 where id = 'dddddddd-0000-0000-0000-000000000001';

select audit_seq, coalesce(from_status, '(入队)') as "from", to_status as "to",
       (select display_name from recruitment.actor where id = a.actor) as actor, reason
  from recruitment.review_audit a
 where item_id = 'dddddddd-0000-0000-0000-000000000001'
 order by audit_seq;

do $$
declare
  v_queue record;
  v_audit record;
begin
  select * into v_queue from recruitment.review_queue
   where id = 'dddddddd-0000-0000-0000-000000000001';
  if v_queue.status <> 'QUEUED' or v_queue.assignee is not null or v_queue.closed_at is not null then
    raise exception 'HUM-01 入队后状态不对：% / % / %', v_queue.status, v_queue.assignee, v_queue.closed_at;
  end if;
  if v_queue.deadline <= now() or v_queue.deadline > now() + interval '25 hours' then
    raise exception 'HUM-01 deadline 不是 now()+24h：%', v_queue.deadline;
  end if;

  select * into v_audit from recruitment.review_audit
   where item_id = 'dddddddd-0000-0000-0000-000000000001' order by audit_seq limit 1;
  if v_audit.from_status is not null or v_audit.to_status <> 'QUEUED'
     or v_audit.actor <> '11111111-0000-0000-0000-000000000003' then
    raise exception 'HUM-01 入队没有自动留痕（from/to/actor 不对）';
  end if;
  raise notice 'HUM-01 PASS 入队即 QUEUED、有 24h deadline、审计自动写了「∅ → QUEUED」';
end $$;

\echo ''
\echo ' 4.3 受理：QUEUED → IN_REVIEW（此时下游必须被挡住）'

set local recruitment.actor_id = '11111111-0000-0000-0000-000000000001';

update recruitment.review_queue
   set status = 'IN_REVIEW', assignee = '11111111-0000-0000-0000-000000000001'
 where id = 'dddddddd-0000-0000-0000-000000000001'
   and record_version = 1;

select gate, blocking, open_items, latest_run_status, human_verdict
  from recruitment.v_source_gate
 where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and source_sha256 = repeat('1',64);

do $$
declare
  v_gate record;
begin
  select * into v_gate from recruitment.v_source_gate
   where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and source_sha256 = repeat('1',64);
  if v_gate.gate <> 'PENDING_REVIEW' then
    raise exception 'HUM-02 未处理的条目没有把 source 标成 PENDING_REVIEW（实际 %）', v_gate.gate;
  end if;
  if not v_gate.blocking then
    raise exception 'HUM-02/HUM-03 未处理的条目没有阻断下游（blocking=false）';
  end if;
  if v_gate.gate = 'REJECTED' then
    raise exception 'HUM-02 机器不能在人工处理前给出「不符合」（REJECTED 只能由人给）';
  end if;
  raise notice 'HUM-02/03 PASS 未结案时 gate=PENDING_REVIEW 且 blocking=true（下游只能显示「待核」）';
end $$;

\echo ''
\echo ' 4.4 补正：IN_REVIEW → CORRECTED（机器结果与人工结果两份都保留）'

update recruitment.review_queue
   set status = 'CORRECTED',
       human_result = jsonb_build_object(
         'corrected_fields', jsonb_build_object('work_experience', 'present', 'company', '示例科技'),
         'pages_reviewed', jsonb_build_array(1),
         'note', '按原件第 1 页重排顺序，补公司名；未改动正文'),
       reason = '人工补正：按原件重排页内顺序并补公司名'
 where id = 'dddddddd-0000-0000-0000-000000000001'
   and record_version = 2;

select status, closed_at is null as closed_null, record_version,
       human_result ->> 'note' as human_note,
       machine_result ->> 'run_status' as machine_run_status,
       machine_result -> 'issue_codes' as machine_issue_codes
  from recruitment.review_queue
 where id = 'dddddddd-0000-0000-0000-000000000001';

do $$
declare
  v_q record;
begin
  select * into v_q from recruitment.review_queue
   where id = 'dddddddd-0000-0000-0000-000000000001';
  if v_q.status <> 'CORRECTED' or v_q.human_result is null or v_q.closed_at is not null then
    raise exception 'HUM-05 CORRECTED 状态不对（human_result 必须非空、closed_at 必须为空）';
  end if;
  if v_q.machine_result ->> 'run_status' <> 'QUARANTINED'
     or not (v_q.machine_result -> 'issue_codes' ? 'pdf_reading_order_unverified') then
    raise exception 'HUM-05 人工补正把机器结果覆盖了：%', v_q.machine_result;
  end if;
  if v_q.record_version <> 3 then
    raise exception '并发版本号应为 3，实际 %', v_q.record_version;
  end if;
  raise notice 'HUM-05 PASS machine_result 原样保留、human_result 另存一份、record_version=3';
end $$;

\echo ''
\echo ' 4.5 复核放行：CORRECTED → APPROVED（换一个人，理由必须本次给出）'

set local recruitment.actor_id = '11111111-0000-0000-0000-000000000002';

update recruitment.review_queue
   set status = 'APPROVED',
       reason = '复核：与原件逐页对照，补正与原文一致，放行'
 where id = 'dddddddd-0000-0000-0000-000000000001'
   and record_version = 3;

\echo ''
\echo ' 4.6 审计逐条查回（同一事务内 at 相同，顺序看 audit_seq）'

select a.audit_seq as "#",
       coalesce(a.from_status, '(入队)') as "from",
       a.to_status as "to",
       ac.display_name as actor,
       a.reason
  from recruitment.review_audit a
  join recruitment.actor ac on ac.id = a.actor
 where a.item_id = 'dddddddd-0000-0000-0000-000000000001'
 order by a.audit_seq;

do $$
declare
  v_n       integer;
  v_states  text[];
  v_actors  uuid[];
  v_closed  timestamptz;
begin
  select count(*) into v_n from recruitment.review_audit
   where item_id = 'dddddddd-0000-0000-0000-000000000001';
  if v_n <> 4 then
    raise exception 'AUDIT 期望 4 条（入队/受理/补正/放行），实际 %', v_n;
  end if;

  select array_agg(coalesce(from_status,'∅') || '→' || to_status order by audit_seq),
         array_agg(actor order by audit_seq)
    into v_states, v_actors
    from recruitment.review_audit
   where item_id = 'dddddddd-0000-0000-0000-000000000001';

  if v_states <> array['∅→QUEUED','QUEUED→IN_REVIEW','IN_REVIEW→CORRECTED','CORRECTED→APPROVED'] then
    raise exception 'AUDIT 状态序列不对：%', v_states;
  end if;
  if v_actors <> array['11111111-0000-0000-0000-000000000003'::uuid,
                       '11111111-0000-0000-0000-000000000001'::uuid,
                       '11111111-0000-0000-0000-000000000001'::uuid,
                       '11111111-0000-0000-0000-000000000002'::uuid] then
    raise exception 'AUDIT 操作者序列不对（入队=系统、受理/补正=HR 甲、放行=复核乙）：%', v_actors;
  end if;

  select closed_at into v_closed from recruitment.review_queue
   where id = 'dddddddd-0000-0000-0000-000000000001';
  if v_closed is null then
    raise exception 'APPROVED 时 closed_at 必须非空';
  end if;

  raise notice 'AUDIT PASS 4 条审计按序可查（入队/受理/补正/放行），APPROVED 已写 closed_at';
end $$;

\echo ''
\echo ' 4.7 放行后：gate=CLEARED，未结案视图里不再有这条'

select gate, blocking, open_items, human_verdict
  from recruitment.v_source_gate
 where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and source_sha256 = repeat('1',64);

do $$
declare v_gate record; v_n integer;
begin
  select * into v_gate from recruitment.v_source_gate
   where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and source_sha256 = repeat('1',64);
  if v_gate.gate <> 'CLEARED' or v_gate.blocking then
    raise exception '人工放行后 gate 应为 CLEARED/false，实际 %/%', v_gate.gate, v_gate.blocking;
  end if;
  select count(*) into v_n from recruitment.v_review_open
   where item_id = 'dddddddd-0000-0000-0000-000000000001';
  if v_n <> 0 then
    raise exception '已结案的条目还留在 v_review_open 里';
  end if;
  raise notice 'GATE PASS 人工放行后 CLEARED 且不再阻断下游';
end $$;

\echo ''
\echo ' 4.7.1 乐观并发：拿旧 record_version 更新 0 行（不是报错，是重读信号）'

do $$
declare v_n integer;
begin
  update recruitment.review_queue set status = 'IN_REVIEW'
   where id = 'dddddddd-0000-0000-0000-000000000001' and record_version = 1;
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception '乐观并发失效：旧 record_version 也更新到了 % 行', v_n;
  end if;
  raise notice 'CONCURRENCY PASS 旧 record_version=1 更新 0 行（调用方必须重读，不能盲写）';
end $$;

\echo ''
\echo ' 4.8 其余队列条目：Q4 停在 QUEUED / Q5 停在 IN_REVIEW / Q6 走到 APPROVED / Q7 三天前入队'

set local recruitment.actor_id = '11111111-0000-0000-0000-000000000003';

insert into recruitment.review_queue (id, tenant_id, run_id, machine_result, reason) values
  ('dddddddd-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-0000000000a1',
   'cccccccc-0000-0000-0000-000000000004',
   jsonb_build_object('run_status','CRASHED','completeness','unverified','error','reader_crashed'),
   '机器判定：reader_crashed（读取器崩溃，无结果，必须人工处理）'),
  ('dddddddd-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000000a1',
   'cccccccc-0000-0000-0000-000000000005',
   jsonb_build_object('run_status','QUARANTINED','completeness','partial','needs_visual',true,
                      'issue_codes', jsonb_build_array('unread_visual_page','pdf_no_text')),
   '机器判定：unread_visual_page（纯图像页，模型也读不出）'),
  ('dddddddd-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000000a1',
   'cccccccc-0000-0000-0000-000000000006',
   jsonb_build_object('run_status','QUARANTINED','completeness','partial',
                      'issue_codes', jsonb_build_array('pdf_reading_order_unverified')),
   '机器判定：pdf_reading_order_unverified');

-- Q7：opened_at / deadline 是「三天前入队、两天前到期」（HUM-04 的超期样本）。
-- 这两列入队后不可改（guard 的免疫列），只能在 INSERT 时给。
insert into recruitment.review_queue
  (id, tenant_id, run_id, machine_result, reason, opened_at, deadline)
values
  ('dddddddd-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000000a1',
   'cccccccc-0000-0000-0000-000000000007',
   jsonb_build_object('run_status','QUARANTINED','completeness','partial','needs_visual',true),
   '机器判定：pdf_no_text（纯图像 PDF）',
   now() - interval '3 days', now() - interval '2 days');

set local recruitment.actor_id = '11111111-0000-0000-0000-000000000001';

update recruitment.review_queue
   set status = 'IN_REVIEW', assignee = '11111111-0000-0000-0000-000000000001'
 where id in ('dddddddd-0000-0000-0000-000000000005', 'dddddddd-0000-0000-0000-000000000006');

update recruitment.review_queue
   set status = 'APPROVED', reason = '人工核对：顺序问题不影响内容，放行'
 where id = 'dddddddd-0000-0000-0000-000000000006';

\echo ''
\echo ' 4.8.1 延长 deadline 是允许的，而且内容编辑也留痕（from = to）'

update recruitment.review_queue
   set deadline = deadline + interval '2 hours'
 where id = 'dddddddd-0000-0000-0000-000000000004'
   and record_version = 1;

select audit_seq, coalesce(from_status, '(入队)') as "from", to_status as "to",
       (select display_name from recruitment.actor where id = a.actor) as actor, reason
  from recruitment.review_audit a
 where item_id = 'dddddddd-0000-0000-0000-000000000004'
 order by audit_seq;

do $$
declare v_q record; v_n integer;
begin
  select * into v_q from recruitment.review_queue
   where id = 'dddddddd-0000-0000-0000-000000000004';
  if v_q.record_version <> 2 then
    raise exception '延 deadline 后 record_version 应为 2，实际 %', v_q.record_version;
  end if;

  select count(*) into v_n from recruitment.review_audit
   where item_id = 'dddddddd-0000-0000-0000-000000000004'
     and from_status = 'QUEUED' and to_status = 'QUEUED';
  if v_n <> 1 then
    raise exception '内容编辑没有被审计（from=to 的行应有 1 条，实际 %）', v_n;
  end if;
  raise notice 'AUDIT-EDIT PASS deadline 只能延长且内容编辑留痕（QUEUED→QUEUED，record_version=2）';
end $$;

\echo ''
\echo ' 4.9 OBS-02：同一文件跑两次 = 两条记录（id 不同、status 各自保留）'

insert into recruitment.conversion_run
  (id, tenant_id, source_sha256, source_name, converter_version, status, completeness,
   needs_visual, issue_codes, pages, blocks, elapsed_ms, started_at, finished_at, result_json)
values
  ('cccccccc-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-0000000000a1', repeat('1',64),
   'candidate-001.pdf', 'pymupdf+layout/1.28.0', 'ACCEPTED', 'complete', false,
   '{}'::text[], 11, 140, 3800,
   now() - interval '5 minutes', now() - interval '4 minutes',
   jsonb_build_object('pages', 11, 'blocks', 140, 'rerun', true));

select id, status, completeness, started_at, finished_at
  from recruitment.conversion_run
 where source_sha256 = repeat('1',64)
 order by started_at;

do $$
declare v_n integer; v_ids integer;
begin
  select count(*), count(distinct id) into v_n, v_ids
    from recruitment.conversion_run where source_sha256 = repeat('1',64);
  if v_n <> 2 or v_ids <> 2 then
    raise exception 'OBS-02 同一文件两次调用应为 2 条不同 run，实际 % 条 / % 个 id', v_n, v_ids;
  end if;
  if not exists (select 1 from recruitment.conversion_run
                  where source_sha256 = repeat('1',64) and status = 'QUARANTINED') then
    raise exception 'OBS-02 第一次调用的 QUARANTINED 记录被覆盖了';
  end if;
  raise notice 'OBS-02 PASS 同一 sha256 两条记录、id 不同、历史判定未被覆盖';
end $$;

\echo ''
\echo ' 4.10 OBS-04：code / 来源 / 时间 / 状态 四个维度都能查到同一批记录'

select 'code=pdf_reading_order_unverified' as dimension, count(*) as n
  from recruitment.conversion_run
 where issue_codes @> array['pdf_reading_order_unverified']
union all
select 'source=sha256(1..)', count(*)
  from recruitment.conversion_run where source_sha256 = repeat('1',64)
union all
select 'time=最近 1 小时', count(*)
  from recruitment.conversion_run where started_at >= now() - interval '1 hour'
union all
select 'status=QUARANTINED', count(*)
  from recruitment.conversion_run where status = 'QUARANTINED';

do $$
declare v_n integer;
begin
  select count(*) into v_n from recruitment.conversion_run
   where issue_codes @> array['pdf_reading_order_unverified'];
  if v_n < 1 then raise exception 'OBS-04 按 code 查不到记录'; end if;

  select count(*) into v_n from recruitment.conversion_run
   where source_sha256 = repeat('1',64);
  if v_n < 1 then raise exception 'OBS-04 按来源查不到记录'; end if;

  select count(*) into v_n from recruitment.conversion_run
   where started_at >= now() - interval '1 hour';
  if v_n < 1 then raise exception 'OBS-04 按时间查不到记录'; end if;

  select count(*) into v_n from recruitment.conversion_run
   where status = 'QUARANTINED';
  if v_n < 1 then raise exception 'OBS-04 按状态查不到记录'; end if;

  raise notice 'OBS-04 PASS 四个维度命中同一批记录';
end $$;

\echo ''
\echo ' 4.11 HUM-04：超 24h 的条目在 v_review_open 里被标成 overdue'

select item_id, status, opened_at, deadline, overdue, age_hours
  from recruitment.v_review_open
 where item_id = 'dddddddd-0000-0000-0000-000000000007';

do $$
declare v_q record;
begin
  select * into v_q from recruitment.v_review_open
   where item_id = 'dddddddd-0000-0000-0000-000000000007';
  if v_q is null then raise exception 'HUM-04 超期条目不在未结案视图里'; end if;
  if not v_q.overdue then raise exception 'HUM-04 超期条目没有被标成 overdue'; end if;
  if v_q.age_hours < 71.9 then raise exception 'HUM-04 age_hours 不对：%', v_q.age_hours; end if;
  raise notice 'HUM-04 PASS 三天前入队的条目 overdue=true、age_hours=%（升级查询：where overdue）', v_q.age_hours;
end $$;

\echo ''
\echo ' 4.12 漏记必须可见：R3 是 FAILED 但没有人入队 → gate=UNACCOUNTED（fail closed）'

select gate, blocking, open_items, latest_run_status, human_verdict
  from recruitment.v_source_gate
 where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and source_sha256 = repeat('3',64);

select accounting, count(*) as n
  from recruitment.v_conversion_ledger
 group by accounting
 order by accounting;

do $$
declare v_gate record; v_bad integer;
begin
  select * into v_gate from recruitment.v_source_gate
   where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and source_sha256 = repeat('3',64);
  if v_gate.gate <> 'UNACCOUNTED' then
    raise exception '漏记的失败没有标成 UNACCOUNTED（实际 %）', v_gate.gate;
  end if;
  if not v_gate.blocking then
    raise exception '漏记的失败没有阻断下游（fail open 了）';
  end if;

  select count(*) into v_bad from recruitment.v_conversion_ledger
   where accounting not in ('OK_ACCEPTED','OK_QUEUED');
  if v_bad <> 1 then
    raise exception '账本里应恰好有 1 条漏记（R3），实际 %', v_bad;
  end if;
  raise notice 'LEDGER PASS 漏记 1 条（R3）被 gate 标成 UNACCOUNTED 并阻断';
end $$;


\echo ''
\echo '=================================================================='
\echo ' 5. 负向测试（25 条，每条都必须被数据库拒绝，并断言 SQLSTATE）'
\echo '=================================================================='

do $$
declare
  v_state text;
  v_msg   text;
  v_ok    integer := 0;
  v_default_actor constant text := '11111111-0000-0000-0000-000000000001';
  r       record;
begin
  for r in
    select * from (values
      -- 状态机（任务书硬要求：非法迁移必须被数据库拒绝）
      ('N01', '23514', 'QUEUED 直接跳到 APPROVED（跳过受理）', null::text,
       $q$update recruitment.review_queue set status = 'APPROVED', reason = '直接放行'
           where id = 'dddddddd-0000-0000-0000-000000000004'$q$),
      ('N02', '23514', 'IN_REVIEW 退回 QUEUED（要交接只能改 assignee）', null,
       $q$update recruitment.review_queue set status = 'QUEUED', assignee = null
           where id = 'dddddddd-0000-0000-0000-000000000005'$q$),
      ('N03', '23514', '终态 APPROVED 再迁回 IN_REVIEW', null,
       $q$update recruitment.review_queue set status = 'IN_REVIEW'
           where id = 'dddddddd-0000-0000-0000-000000000006'$q$),
      ('N04', '23514', 'CORRECTED 缺 human_result', null,
       $q$update recruitment.review_queue set status = 'CORRECTED'
           where id = 'dddddddd-0000-0000-0000-000000000005'$q$),
      ('N05', '23514', '终态决策沿用上一步理由（没给本次理由）', null,
       $q$update recruitment.review_queue set status = 'APPROVED'
           where id = 'dddddddd-0000-0000-0000-000000000005'$q$),

      -- 外键 / 租户
      ('N06', '23503', '入队引用不存在的 run', null,
       $q$insert into recruitment.review_queue (tenant_id, run_id, machine_result, reason)
          values ('aaaaaaaa-0000-0000-0000-0000000000a1',
                  'cccccccc-0000-0000-0000-0000000000ff', '{}'::jsonb, '不存在的 run')$q$),
      ('N07', '23503', '跨租户：乙租户的条目引用甲租户的 run', '22222222-0000-0000-0000-000000000001',
       $q$insert into recruitment.review_queue (tenant_id, run_id, machine_result, reason)
          values ('aaaaaaaa-0000-0000-0000-0000000000b1',
                  'cccccccc-0000-0000-0000-000000000004', '{}'::jsonb, '跨租户')$q$),

      -- actor
      ('N08', '23514', '状态迁移没有 actor（没有 SET LOCAL）', 'NONE',
       $q$update recruitment.review_queue set status = 'IN_REVIEW', assignee = '11111111-0000-0000-0000-000000000001'
           where id = 'dddddddd-0000-0000-0000-000000000004'$q$),
      ('N09', '23503', '用别的租户的 actor 操作甲租户的条目', '22222222-0000-0000-0000-000000000001',
       $q$update recruitment.review_queue set status = 'IN_REVIEW', assignee = '11111111-0000-0000-0000-000000000001'
           where id = 'dddddddd-0000-0000-0000-000000000004'$q$),

      -- 入队纪律
      ('N10', '23505', '同一个 run 重复入队', null,
       $q$insert into recruitment.review_queue (tenant_id, run_id, machine_result, reason)
          values ('aaaaaaaa-0000-0000-0000-0000000000a1',
                  'cccccccc-0000-0000-0000-000000000004', '{}'::jsonb, '重复入队')$q$),
      ('N11', '23514', 'ACCEPTED 的 run 入队（兜底队列只收机器判不了的）', null,
       $q$insert into recruitment.review_queue (tenant_id, run_id, machine_result, reason)
          values ('aaaaaaaa-0000-0000-0000-0000000000a1',
                  'cccccccc-0000-0000-0000-000000000002', '{}'::jsonb, '抽查')$q$),
      ('N12', '23514', '新条目带 human_result（人工结论只能受理后出现）', null,
       $q$insert into recruitment.review_queue (tenant_id, run_id, machine_result, human_result)
          values ('aaaaaaaa-0000-0000-0000-0000000000a1',
                  'cccccccc-0000-0000-0000-000000000003', '{}'::jsonb, '{}'::jsonb)$q$),

      -- 不可变 / 禁删
      ('N13', '23514', '改写 machine_result（HUM-05：两份都保留）', null,
       $q$update recruitment.review_queue set machine_result = machine_result || '{"x":1}'::jsonb
           where id = 'dddddddd-0000-0000-0000-000000000004'$q$),
      ('N14', '23514', '手改 closed_at（只能由触发器写）', null,
       $q$update recruitment.review_queue set closed_at = now()
           where id = 'dddddddd-0000-0000-0000-000000000004'$q$),
      ('N15', '23514', '缩短 deadline（只能延长）', null,
       $q$update recruitment.review_queue set deadline = deadline - interval '1 hour'
           where id = 'dddddddd-0000-0000-0000-000000000004'$q$),
      ('N16', '23514', '删除队列条目（历史不可物理删）', null,
       $q$delete from recruitment.review_queue where id = 'dddddddd-0000-0000-0000-000000000004'$q$),
      ('N17', '23514', '改写 conversion_run（历史不可覆盖）', null,
       $q$update recruitment.conversion_run set status = 'ACCEPTED'
           where id = 'cccccccc-0000-0000-0000-000000000001'$q$),
      ('N18', '23514', '删除 conversion_run', null,
       $q$delete from recruitment.conversion_run where id = 'cccccccc-0000-0000-0000-000000000001'$q$),
      ('N19', '23514', '改写审计行（审计被改就不叫审计）', null,
       $q$update recruitment.review_audit set reason = '伪造'
           where item_id = 'dddddddd-0000-0000-0000-000000000001' and from_status is null$q$),
      ('N20', '23514', '删除审计行', null,
       $q$delete from recruitment.review_audit
           where item_id = 'dddddddd-0000-0000-0000-000000000001' and from_status is null$q$),

      -- 审计完整性
      ('N21', '23505', '重复审计：同一条目同一个目标状态再插一条', null,
       $q$insert into recruitment.review_audit (tenant_id, item_id, from_status, to_status, actor)
          values ('aaaaaaaa-0000-0000-0000-0000000000a1',
                  'dddddddd-0000-0000-0000-000000000001', 'QUEUED', 'IN_REVIEW',
                  '11111111-0000-0000-0000-000000000001')$q$),
      ('N22', '23503', '审计引用不存在的条目', null,
       $q$insert into recruitment.review_audit (tenant_id, item_id, from_status, to_status, actor)
          values ('aaaaaaaa-0000-0000-0000-0000000000a1',
                  'dddddddd-0000-0000-0000-0000000000ff', 'QUEUED', 'IN_REVIEW',
                  '11111111-0000-0000-0000-000000000001')$q$),

      -- run 自身的数据自洽（doc 11 §1 的红线）
      ('N23', '23514', 'run.status 写非法枚举值', null,
       $q$insert into recruitment.conversion_run
            (tenant_id, source_sha256, source_name, converter_version, status, completeness, elapsed_ms, started_at, finished_at)
          values ('aaaaaaaa-0000-0000-0000-0000000000a1', repeat('9',64), 'bad.pdf', 'v1', 'DONE', 'partial', 1,
                  now() - interval '1 minute', now())$q$),
      ('N24', '23514', 'ACCEPTED 却带着 issue_codes（判定自洽）', null,
       $q$insert into recruitment.conversion_run
            (tenant_id, source_sha256, source_name, converter_version, status, completeness, issue_codes, elapsed_ms, started_at, finished_at, result_json)
          values ('aaaaaaaa-0000-0000-0000-0000000000a1', repeat('9',64), 'bad.pdf', 'v1',
                  'ACCEPTED', 'complete', array['pdf_no_text'], 1,
                  now() - interval '1 minute', now(), '{}'::jsonb)$q$),
      ('N25', '23514', '纯图像页标成 complete（INJ-04 红线）', null,
       $q$insert into recruitment.conversion_run
            (tenant_id, source_sha256, source_name, converter_version, status, completeness, needs_visual, elapsed_ms, started_at, finished_at, result_json)
          values ('aaaaaaaa-0000-0000-0000-0000000000a1', repeat('9',64), 'bad.pdf', 'v1',
                  'QUARANTINED', 'complete', true, 1,
                  now() - interval '1 minute', now(), '{}'::jsonb)$q$)
    ) as v(id, expect, what, actor_setting, sql)
  loop
    perform set_config('recruitment.actor_id',
      case when r.actor_setting = 'NONE' then ''
           when r.actor_setting is null then v_default_actor
           else r.actor_setting end, true);

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

  perform set_config('recruitment.actor_id', v_default_actor, true);
  raise notice 'NEGATIVE SUMMARY % 条负向测试全部按预期被拒绝', v_ok;
end $$;


\echo ''
\echo '=================================================================='
\echo ' 6. 收尾：负向测试没有留下任何数据，账本仍然平'
\echo '=================================================================='

select (select count(*) from recruitment.conversion_run) as runs,
       (select count(*) from recruitment.review_queue) as queue_items,
       (select count(*) from recruitment.review_audit) as audit_rows,
       (select count(*) from recruitment.review_audit where from_status is null) as enqueue_audits,
       (select count(*) from recruitment.v_review_open) as open_items,
       (select count(*) from recruitment.v_conversion_ledger
         where accounting not in ('OK_ACCEPTED','OK_QUEUED')) as unaccounted;

do $$
declare v_n integer;
begin
  select count(*) into v_n from recruitment.conversion_run;
  if v_n <> 8 then raise exception '收尾 runs 应为 8，实际 %（负向测试留下了数据？）', v_n; end if;

  select count(*) into v_n from recruitment.review_queue;
  if v_n <> 5 then raise exception '收尾 queue_items 应为 5，实际 %', v_n; end if;

  select count(*) into v_n from recruitment.review_audit;
  if v_n <> 12 then raise exception '收尾 audit_rows 应为 12（Q1:4 + Q4:2 + Q5:2 + Q6:3 + Q7:1），实际 %', v_n; end if;

  select count(*) into v_n from recruitment.review_audit where from_status is null;
  if v_n <> 5 then raise exception '每个条目应有且只有一条「入队」审计，实际 %', v_n; end if;

  select count(*) into v_n from recruitment.review_audit where from_status is null and to_status <> 'QUEUED';
  if v_n <> 0 then raise exception '入队审计的 to_status 必须是 QUEUED'; end if;

  select count(*) into v_n from recruitment.v_conversion_ledger
   where accounting not in ('OK_ACCEPTED','OK_QUEUED');
  if v_n <> 1 then raise exception '账本应只剩 1 条漏记（R3），实际 %', v_n; end if;

  raise notice 'FINAL PASS 8 runs / 5 条目 / 12 条审计 / 1 条漏记，负向测试零残留';
end $$;

\echo ''
\echo ' VERIFY-0003 PASS：结构断言 + 状态机矩阵 + 正例 + 25 条负向测试全部通过'
\echo ''

rollback;
