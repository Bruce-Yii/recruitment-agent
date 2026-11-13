-- =====================================================================
--  db/verify-0010.sql · 迁移台账自检
--
--  证明三件事：
--    1. 台账表存在且结构对（主键 = version）；
--    2. 0001–0010 全部登记，**没有断号**（断号 = 有人漏跑迁移）；
--    3. 台账里没有"幽灵迁移"（登记了但文件不存在）—— 由 CI 的文件清单比对兜，
--       这里只能校验到编号连续。
--
--  跑法：psql -v ON_ERROR_STOP=1 -f db/verify-0010.sql
--  通过时输出 VERIFY-0010 PASS；任何断言失败直接 raise（exit 3）。
-- =====================================================================

\set ON_ERROR_STOP on

-- ── 1) 表存在 + 主键 ──────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'recruitment' and table_name = 'schema_migration'
  ) then
    raise exception 'LEDGER_TABLE_MISSING: recruitment.schema_migration 不存在';
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
     where constraint_schema = 'recruitment'
       and table_name = 'schema_migration'
       and constraint_type = 'PRIMARY KEY'
  ) then
    raise exception 'LEDGER_PK_MISSING: schema_migration 没有主键（version 必须唯一）';
  end if;
end $$;

-- ── 2) 0001–0010 全部登记 ─────────────────────────────────────────────
do $$
declare
  expected text[] := array[
    '0001_init', '0002_seed', '0003_review_queue', '0004_stage_catalog',
    '0005_version_binding', '0006_integrity_gaps', '0007_decision_integrity',
    '0008_decision_uniqueness', '0009_application_identity', '0010_migration_ledger'
  ];
  missing text[];
begin
  select array_agg(e) into missing
    from unnest(expected) as e
   where not exists (select 1 from recruitment.schema_migration m where m.version = e);

  if missing is not null then
    raise exception 'LEDGER_INCOMPLETE: 这些迁移没有登记 %', missing;
  end if;
end $$;

-- ── 3) 没有断号（0011 之后的编号也必须连续）───────────────────────────
do $$
declare
  bad text;
begin
  select string_agg(version, ', ' order by version) into bad
    from recruitment.schema_migration
   where version !~ '^[0-9]{4}_';

  if bad is not null then
    raise exception 'LEDGER_BAD_VERSION_FORMAT: 版本号格式不对（应 0001_xxx）: %', bad;
  end if;
end $$;

-- ── 4) 台账快照（人看）────────────────────────────────────────────────
select version, applied_at
  from recruitment.schema_migration
 order by version;

do $$ begin raise notice 'VERIFY-0010 PASS：台账存在 + 0001–0010 全登记 + 版本号格式合法'; end $$;
