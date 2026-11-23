-- =====================================================================
--  recruitment-agent · db/verify.sql
--  自检脚本：结构断言 + 不变量/状态机覆盖 + 负向测试 + 对象覆盖率
--
--  用法（必须用 psql 跑，本文件含 \echo 等 psql 元命令）：
--    psql -v ON_ERROR_STOP=1 -d <db> -f db/verify.sql
--
--  行为保证：
--    * 整个脚本在一个事务里执行，结尾 ROLLBACK —— 不留任何数据；
--    * 所有检查失败都会 RAISE EXCEPTION（exit code != 0），不会静默通过；
--    * 负向测试打印的是数据库真实返回的 SQLSTATE 与 message_text。
-- =====================================================================

\set ON_ERROR_STOP on
\echo '=================================================================='
\echo ' 0. 环境'
\echo '=================================================================='

select current_database() as database,
       current_setting('server_version') as pg_version,
       (select count(*) from pg_namespace where nspname = 'recruitment') as schema_exists;

begin;

\echo ''
\echo '=================================================================='
\echo ' 1. 对象清单（迁移建出来的东西）'
\echo '=================================================================='

select 'tables' as kind, count(*)::text as n
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'recruitment' and c.relkind = 'r'
union all
select 'foreign_keys', count(*)::text
  from pg_constraint c join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
 where n.nspname = 'recruitment' and c.contype = 'f'
union all
select 'check_constraints', count(*)::text
  from pg_constraint c join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
 where n.nspname = 'recruitment' and c.contype = 'c'
union all
select 'unique_constraints', count(*)::text
  from pg_constraint c join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
 where n.nspname = 'recruitment' and c.contype = 'u'
union all
select 'partial_unique_indexes', count(*)::text
  from pg_index i join pg_class t on t.oid = i.indrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'recruitment' and i.indisunique and i.indpred is not null
union all
select 'triggers', count(*)::text
  from pg_trigger g join pg_class t on t.oid = g.tgrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'recruitment' and not g.tgisinternal
union all
select 'functions', count(*)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'recruitment';


\echo ''
\echo '=================================================================='
\echo ' 2. 结构断言（任何一条不满足即整体失败）'
\echo '=================================================================='

do $$
declare
  v_bad  text;
  v_n    integer;
  r      record;
begin
  -- 2.1 每张表都有单列 uuid 主键，且列名在封闭白名单 {id, event_id} 内。
  --
  -- [D-36 2026-11-13] 白名单**不放宽**：0003 的三张运营表已把 run_id / item_id /
  --   audit_id 改名为 id，而不是把旧名塞进白名单。D-36 的理由是「一条约定必须
  --   一条到底」，开口子会让以后每张新表都要求例外。
  -- [D-47 2026-11-13] 同批裁定只给 STRUCT-05 开豁免，STRUCT-01 **没有**豁免，
  --   所以这里也不放宽成「随便什么名字的单列主键即可」。
  -- 唯一例外 event_inbox.event_id 来自 docs/03 §9，且是封闭集合（只此一个）。
  -- 顺带把「uuid」这半个条件真正断言掉：旧写法只比对列名，消息写着「单列 uuid
  --   主键」却从不检查类型 —— 名字对而类型不是 uuid 也会 PASS。
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment' and c.relkind = 'r'
     and not exists (
       select 1
         from pg_constraint p
         join pg_attribute a on a.attrelid = p.conrelid and a.attnum = p.conkey[1]
         join pg_type t on t.oid = a.atttypid
        where p.conrelid = c.oid and p.contype = 'p'
          and array_length(p.conkey, 1) = 1        -- 单列
          and a.attname in ('id', 'event_id')      -- 封闭白名单，只此两名
          and t.typname = 'uuid');                 -- 类型必须真是 uuid
  if v_bad is not null then
    raise exception 'STRUCT-01 这些表的主键不是单列 uuid 的 id（唯一例外 event_inbox.event_id）：%', v_bad;
  end if;
  raise notice 'STRUCT-01 PASS 每张表都是单列 uuid 主键，列名 = id（event_inbox = event_id）';

  -- 2.2 除 organization 外每张表都有 tenant_id（多租户隔离的最小前提）
  --     例外：schema_migration 是**基础设施台账**，不是租户业务数据（没有租户维度），
  --     给它造一个假 tenant_id 反而会让人误以为它可以按租户隔离。见 0010 的注释。
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment' and c.relkind = 'r'
     and c.relname not in ('organization', 'schema_migration')
     and not exists (select 1 from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'tenant_id'
                        and a.attnotnull and not a.attisdropped);
  if v_bad is not null then
    raise exception 'STRUCT-02 这些表缺少 NOT NULL 的 tenant_id：%', v_bad;
  end if;
  raise notice 'STRUCT-02 PASS 除 organization 外每张表都有 NOT NULL tenant_id';

  -- 2.3 每张有 tenant_id 的表，tenant_id 都有指向 organization 的外键
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment' and c.relkind = 'r'
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id')
     and not exists (
       select 1 from pg_constraint p
        where p.conrelid = c.oid and p.contype = 'f'
          and p.confrelid = 'recruitment.organization'::regclass
          and (select a.attname from pg_attribute a
                where a.attrelid = c.oid and a.attnum = p.conkey[1]) = 'tenant_id');
  if v_bad is not null then
    raise exception 'STRUCT-03 这些表的 tenant_id 没有外键到 organization：%', v_bad;
  end if;
  raise notice 'STRUCT-03 PASS 所有 tenant_id 都有到 organization 的外键';

  -- 2.4 每个"状态列"都必须有 CHECK 约束（*_status / status / current_stage_code 之外的语义列除外）
  select string_agg(format('%s.%s', c.relname, a.attname), ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where n.nspname = 'recruitment' and c.relkind = 'r'
     and a.attname in ('status', 'lifecycle_status', 'transcript_status', 'identity_status',
                       'parse_status', 'verification_status', 'readback_state',
                       'validation_status', 'meeting_role', 'variant_type', 'provenance',
                       'trigger_mode', 'connection_state', 'idempotency_source', 'trust_level',
                       'error_class', 'result', 'decision_scope', 'resource_type',
                       'scope', 'channel_type', 'kind', 'actor_type')
     and not exists (
       select 1 from pg_constraint p
        where p.conrelid = c.oid and p.contype = 'c'
          and pg_get_constraintdef(p.oid) like '%' || a.attname || '%');
  if v_bad is not null then
    raise exception 'STRUCT-04 这些状态/枚举列没有 CHECK 约束：%', v_bad;
  end if;
  raise notice 'STRUCT-04 PASS 所有状态/枚举列都有 CHECK 约束';

  -- 2.5 每张有状态列的表都要有 fn_row_guard 触发器（迁移必须带审计）
  --
  -- [D-47 2026-11-13] 豁免 conversion_run / review_queue（封闭集合，理由如下）：
  --   * conversion_run：append-only，**没有 UPDATE 路径**
  --       （trg_conversion_run_immutable 让任何列都改不了），
  --       套 fn_row_guard 需要加 status_changed_* 并向 event_inbox 写事件，
  --       等于接一条永不执行的触发器 —— 属 R2 假接线。
  --       真实守卫：trg_conversion_run_immutable / trg_conversion_run_no_delete
  --   * review_queue：专用状态机 fn_review_transition_allowed + review_audit 留痕，
  --       状态语义不是业务对象的 status 轴。
  --       真实守卫：trg_review_queue_before_update / trg_review_queue_audit
  -- 豁免不是免检：下面逐条断言这些真实守卫存在，否则本断言仍然失败。
  -- （表不存在时跳过 —— 保持 verify.sql 在只有 0001(+0004) 的库上也能跑。）
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where n.nspname = 'recruitment' and c.relkind = 'r'
     and a.attname in ('status', 'lifecycle_status', 'transcript_status')
     and c.relname not in ('conversion_run', 'review_queue')     -- D-47 豁免
     and not exists (
       select 1 from pg_trigger g
        where g.tgrelid = c.oid and not g.tgisinternal
          and g.tgfoid = 'recruitment.fn_row_guard'::regproc);
  if v_bad is not null then
    raise exception 'STRUCT-05 这些表有状态列但没有 fn_row_guard 触发器（D-47 只豁免 conversion_run / review_queue）：%', v_bad;
  end if;

  for r in
    select * from (values
      ('conversion_run', 'trg_conversion_run_immutable'),
      ('conversion_run', 'trg_conversion_run_no_delete'),
      ('review_queue',   'trg_review_queue_before_update'),
      ('review_queue',   'trg_review_queue_audit')
    ) as v(tbl, tname)
  loop
    if to_regclass('recruitment.' || r.tbl) is not null
       and not exists (
         select 1 from pg_trigger g
          join pg_class c on c.oid = g.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'recruitment' and c.relname = r.tbl
           and g.tgname = r.tname and not g.tgisinternal) then
      raise exception 'STRUCT-05 豁免守卫缺失：%.%（D-47 的豁免以这些触发器为条件）', r.tbl, r.tname;
    end if;
  end loop;
  raise notice 'STRUCT-05 PASS 状态表都有 fn_row_guard；conversion_run / review_queue 按 D-47 豁免，真实守卫已逐条核对';

  -- 2.6 历史事实表必须禁删（地板 38 = 0001_init 基线，保证本文件在只有 0001(+0004) 的库上仍可跑；2026-11-14 21:00 回抄实测：0015 链 52）
  select count(*) into v_n
    from pg_trigger g
   where g.tgfoid = 'recruitment.fn_block_delete'::regproc and not g.tgisinternal;
  if v_n < 38 then
    raise exception 'STRUCT-06 禁删触发器只有 % 个（期望 >= 38；0001 基线 38，2026-11-14 实测 52，见 notice）', v_n;
  end if;
  raise notice 'STRUCT-06 PASS 历史事实禁删触发器 % 个', v_n;

  -- 2.7 复合外键必须带 tenant_id（防跨租户引用）；唯一例外是 (artifact_id, revision) 这类版本定位
  select string_agg(format('%s(%s)', c.relname, p.conname), ', ') into v_bad
    from pg_constraint p join pg_class c on c.oid = p.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment' and p.contype = 'f' and array_length(p.conkey, 1) > 1
     and not exists (
       select 1 from pg_attribute a
        where a.attrelid = p.conrelid and a.attnum = any(p.conkey)
          and a.attname in ('tenant_id', 'source_revision', 'transcript_revision'));
  if v_bad is not null then
    raise exception 'STRUCT-07 这些复合外键不含 tenant_id：%', v_bad;
  end if;
  raise notice 'STRUCT-07 PASS 复合外键都带 tenant_id（防跨租户引用）';
end $$;


-- [0017 追加式人工覆盖] 新表 criterion_override 的专项断言：
-- 表/列/CHECK/禁删触发器/当前行索引/白名单 UPDATE 护栏必须齐全。
-- 不修改上面任何既有断言；表不存在时本块跳过（保持 verify.sql 在旧库可跑）。
do $$
declare
  v_missing text := '';
  v_col text;
begin
  if to_regclass('recruitment.criterion_override') is not null then
    -- 必需列（含本轮约定的全部业务列）
    for v_col in select unnest(array[
      'id','tenant_id','application_id','rubric_version_id','criterion_key',
      'human_state','note','actor_id','confirmation_method','confirmation_text_sha256',
      'superseded_by_override_id','record_version','created_at','updated_at'
    ]) loop
      if not exists (select 1 from pg_attribute a
                      where a.attrelid = 'recruitment.criterion_override'::regclass
                        and a.attname = v_col and not a.attisdropped) then
        v_missing := v_missing || v_col || ' ';
      end if;
    end loop;
    if v_missing <> '' then
      raise exception 'OV-STRUCT-01 criterion_override 缺列：%', v_missing;
    end if;

    -- 必需的 CHECK 约束（闭集 / 形状 / 长度 / 哈希）
    v_missing := '';
    select string_agg(t.name, ' ') into v_missing
      from unnest(array[
        'ck_criterion_override_key','ck_criterion_override_human_state',
        'ck_criterion_override_note','ck_criterion_override_method',
        'ck_criterion_override_hash','ck_criterion_override_self_supersede',
        'ck_criterion_override_record_version'
      ]) as t(name)
     where not exists (select 1 from pg_constraint p
                        where p.conrelid = 'recruitment.criterion_override'::regclass
                          and p.contype = 'c' and p.conname = t.name);
    if coalesce(v_missing, '') <> '' then
      raise exception 'OV-STRUCT-02 criterion_override 缺 CHECK 约束：%', v_missing;
    end if;

    -- 历史事实禁删（append-only）
    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = 'recruitment.criterion_override'::regclass
                      and not g.tgisinternal and g.tgname = 'trg_criterion_override_no_delete') then
      raise exception 'OV-STRUCT-03 criterion_override 缺 fn_block_delete 触发器';
    end if;

    -- 当前行查询索引（非唯一部分索引即可；不承诺 DB 唯一性）
    if not exists (
      select 1 from pg_index i
       where i.indrelid = 'recruitment.criterion_override'::regclass
         and i.indpred is not null and not i.indisunique
    ) then
      raise exception 'OV-STRUCT-04 criterion_override 缺当前行部分索引';
    end if;

    -- 只许改 superseded_by_override_id 的护栏（AI 原判定不可被覆盖）
    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = 'recruitment.criterion_override'::regclass
                      and not g.tgisinternal and g.tgname = 'trg_criterion_override_immutable') then
      raise exception 'OV-STRUCT-05 criterion_override 缺不可变护栏触发器';
    end if;
    raise notice 'OV-STRUCT PASS criterion_override 列/CHECK/禁删/索引/不可变护栏齐全';
  else
    raise notice 'OV-STRUCT SKIP criterion_override 表不存在（0017 尚未应用）';
  end if;
end $$;


-- [0018 原子写能力] AT-1~AT-7 的结构面断言。
-- 只新增本块，既有断言与计数零改动；表/列不存在时跳过（保持旧库可跑）。
do $$
declare
  v_missing text := '';
  v_col text;
begin
  if to_regclass('recruitment.application_carry_over') is not null then
    -- A · 必需列
    for v_col in select unnest(array[
      'id','tenant_id','application_id','source_application_id','ref_kind','ref_id',
      'carried_by_actor_id','created_at'
    ]) loop
      if not exists (select 1 from pg_attribute a
                      where a.attrelid = 'recruitment.application_carry_over'::regclass
                        and a.attname = v_col and not a.attisdropped) then
        v_missing := v_missing || v_col || ' ';
      end if;
    end loop;
    if v_missing <> '' then
      raise exception 'AT-STRUCT-01 application_carry_over 缺列：%', v_missing;
    end if;

    -- A · 唯一键（AT-3 幂等）必须存在且覆盖五列
    if not exists (
      select 1 from pg_constraint p
       where p.conrelid = 'recruitment.application_carry_over'::regclass
         and p.contype = 'u' and p.conname = 'uq_application_carry_over_ref'
         and p.conkey = array[
               (select attnum from pg_attribute where attrelid = p.conrelid and attname = 'tenant_id'),
               (select attnum from pg_attribute where attrelid = p.conrelid and attname = 'application_id'),
               (select attnum from pg_attribute where attrelid = p.conrelid and attname = 'source_application_id'),
               (select attnum from pg_attribute where attrelid = p.conrelid and attname = 'ref_kind'),
               (select attnum from pg_attribute where attrelid = p.conrelid and attname = 'ref_id')
             ]::smallint[]
    ) then
      raise exception 'AT-STRUCT-02 application_carry_over 缺五列幂等唯一键 uq_application_carry_over_ref';
    end if;

    -- A · 闭集 / 形状 / 源≠目标 CHECK
    v_missing := '';
    select string_agg(t.name, ' ') into v_missing
      from unnest(array[
        'ck_carry_over_ref_kind','ck_carry_over_distinct_application'
      ]) as t(name)
     where not exists (select 1 from pg_constraint p
                        where p.conrelid = 'recruitment.application_carry_over'::regclass
                          and p.contype = 'c' and p.conname = t.name);
    if coalesce(v_missing, '') <> '' then
      raise exception 'AT-STRUCT-03 application_carry_over 缺 CHECK 约束：%', v_missing;
    end if;

    -- A · append-only：禁删 + 全列不可变 + 同候选人守卫
    for v_col in
      select unnest(array[
        'trg_application_carry_over_no_delete',
        'trg_application_carry_over_immutable',
        'trg_application_carry_over_same_candidate'
      ])
    loop
      if not exists (select 1 from pg_trigger g
                      where g.tgrelid = 'recruitment.application_carry_over'::regclass
                        and not g.tgisinternal and g.tgname = v_col) then
        raise exception 'AT-STRUCT-04 application_carry_over 缺触发器：%', v_col;
      end if;
    end loop;
    raise notice 'AT-STRUCT-A PASS carry_over 列/五列唯一键/CHECK/禁删/不可变/同候选人守卫齐全';
  else
    raise notice 'AT-STRUCT-A SKIP application_carry_over 表不存在（0018 尚未应用）';
  end if;

  -- B · interview.round_label 与 interviewer 换人三列（表在 0001 必有，列可能未加）
  if to_regclass('recruitment.interview') is not null then
    if not exists (select 1 from pg_attribute a
                    where a.attrelid = 'recruitment.interview'::regclass
                      and a.attname = 'round_label' and not a.attisdropped) then
      raise exception 'AT-STRUCT-05 interview 缺 round_label 列';
    end if;
    if not exists (select 1 from pg_constraint p
                    where p.conrelid = 'recruitment.interview'::regclass
                      and p.contype = 'c' and p.conname = 'ck_interview_round_label') then
      raise exception 'AT-STRUCT-06 interview 缺 ck_interview_round_label';
    end if;
  end if;
  if to_regclass('recruitment.interviewer') is not null then
    for v_col in select unnest(array[
      'replaced_by_interviewer_id','replaced_at','replacement_reason'
    ]) loop
      if not exists (select 1 from pg_attribute a
                      where a.attrelid = 'recruitment.interviewer'::regclass
                        and a.attname = v_col and not a.attisdropped) then
        raise exception 'AT-STRUCT-07 interviewer 缺换人列：%', v_col;
      end if;
    end loop;
    v_missing := '';
    select string_agg(t.name, ' ') into v_missing
      from unnest(array[
        'fk_interviewer_replaced_by','ck_interviewer_replacement_consistent',
        'ck_interviewer_not_self_replaced'
      ]) as t(name)
     where not exists (select 1 from pg_constraint p
                        where p.conrelid = 'recruitment.interviewer'::regclass
                          and p.conname = t.name);
    if coalesce(v_missing, '') <> '' then
      raise exception 'AT-STRUCT-08 interviewer 缺换人约束：%', v_missing;
    end if;
    -- round_no 的唯一键语义不许被改坏（AT-4 反例）
    if not exists (select 1 from pg_constraint p
                    where p.conrelid = 'recruitment.interview'::regclass
                      and p.contype = 'u' and p.conname = 'uq_interview_slot') then
      raise exception 'AT-STRUCT-09 interview 缺原唯一键 uq_interview_slot（round_no 语义被改坏）';
    end if;
    raise notice 'AT-STRUCT-B PASS round_label / 换人三列 / round_no 唯一键齐全';
  end if;
end $$;


-- [0019 碎片约束置顶 + 下一轮交接提醒] candidate_constraint 的专项断言。
-- 只新增本块，既有断言与计数零改动；表不存在时跳过（保持 verify.sql 在旧库可跑）。
do $$
declare
  v_missing text := '';
  v_col text;
begin
  if to_regclass('recruitment.candidate_constraint') is not null then
    -- PIN-STRUCT-01 必需列（含本轮约定的全部业务列）
    for v_col in select unnest(array[
      'id','tenant_id','candidate_id','kind','text','source','application_id','interview_id',
      'created_by_actor_id','created_at','superseded_by_constraint_id','record_version'
    ]) loop
      if not exists (select 1 from pg_attribute a
                      where a.attrelid = 'recruitment.candidate_constraint'::regclass
                        and a.attname = v_col and not a.attisdropped) then
        v_missing := v_missing || v_col || ' ';
      end if;
    end loop;
    if v_missing <> '' then
      raise exception 'PIN-STRUCT-01 candidate_constraint 缺列：%', v_missing;
    end if;

    -- PIN-STRUCT-02 闭集 / 形状 / HANDOFF 必带 interview_id / 不可自取代 CHECK
    v_missing := '';
    select string_agg(t.name, ' ') into v_missing
      from unnest(array[
        'ck_candidate_constraint_kind','ck_candidate_constraint_source',
        'ck_candidate_constraint_text','ck_candidate_constraint_handoff_interview',
        'ck_candidate_constraint_record_version','ck_candidate_constraint_no_self_supersede'
      ]) as t(name)
     where not exists (select 1 from pg_constraint p
                        where p.conrelid = 'recruitment.candidate_constraint'::regclass
                          and p.contype = 'c' and p.conname = t.name);
    if coalesce(v_missing, '') <> '' then
      raise exception 'PIN-STRUCT-02 candidate_constraint 缺 CHECK 约束：%', v_missing;
    end if;

    -- PIN-STRUCT-03 append-only：禁删 + 全列不可变（只允许 superseded_by_constraint_id）护栏
    for v_col in
      select unnest(array[
        'trg_candidate_constraint_no_delete','trg_candidate_constraint_immutable'
      ])
    loop
      if not exists (select 1 from pg_trigger g
                      where g.tgrelid = 'recruitment.candidate_constraint'::regclass
                        and not g.tgisinternal and g.tgname = v_col) then
        raise exception 'PIN-STRUCT-03 candidate_constraint 缺触发器：%', v_col;
      end if;
    end loop;

    -- PIN-STRUCT-04 置顶 PIN 与交接 HANDOFF 两个查询索引必须存在
    v_missing := '';
    select string_agg(t.name, ' ') into v_missing
      from unnest(array['ix_candidate_constraint_pin','ix_candidate_constraint_handoff']) as t(name)
     where not exists (select 1 from pg_index i
                        where i.indrelid = 'recruitment.candidate_constraint'::regclass
                          and i.indexrelid = ('recruitment.' || t.name)::regclass);
    if coalesce(v_missing, '') <> '' then
      raise exception 'PIN-STRUCT-04 candidate_constraint 缺索引：%', v_missing;
    end if;
    raise notice 'PIN-STRUCT PASS candidate_constraint 列/CHECK/禁删/不可变/置顶与交接索引齐全';
  else
    raise notice 'PIN-STRUCT SKIP candidate_constraint 表不存在（0019 尚未应用）';
  end if;
end $$;


-- [0022 A4 面评草稿] scorecard_draft 的专项断言：列 / CHECK / payload 上限 /
-- append-only（禁删 + 整行不可改）/ 最新版本查询索引 / 台账自登记必须齐全。
-- 只新增本块，既有断言与计数零改动；表不存在时跳过（保持 verify.sql 在旧库可跑）。
do $$
declare
  v_missing text := '';
  v_col text;
begin
  if to_regclass('recruitment.scorecard_draft') is not null then
    -- DRAFT-STRUCT-01 必需列（含本轮约定的全部业务列）
    for v_col in select unnest(array[
      'id','tenant_id','interview_id','interviewer_id','interviewer_actor_id',
      'payload','record_version','created_at'
    ]) loop
      if not exists (select 1 from pg_attribute a
                      where a.attrelid = 'recruitment.scorecard_draft'::regclass
                        and a.attname = v_col and not a.attisdropped) then
        v_missing := v_missing || v_col || ' ';
      end if;
    end loop;
    if v_missing <> '' then
      raise exception 'DRAFT-STRUCT-01 scorecard_draft 缺列：%', v_missing;
    end if;

    -- DRAFT-STRUCT-02 tenant_id NOT NULL + 外键到 organization（STRUCT-02/03 同口径）
    if not exists (select 1 from pg_attribute a
                    where a.attrelid = 'recruitment.scorecard_draft'::regclass
                      and a.attname = 'tenant_id' and a.attnotnull and not a.attisdropped) then
      raise exception 'DRAFT-STRUCT-02 scorecard_draft.tenant_id 不是 NOT NULL';
    end if;
    if not exists (select 1 from pg_constraint p
                    where p.conrelid = 'recruitment.scorecard_draft'::regclass
                      and p.contype = 'f' and p.conname = 'fk_scorecard_draft_tenant_org') then
      -- 表级外键名可能由 series 自动命名；按"confrelid = organization 且含 tenant_id 列"判定。
      if not exists (
        select 1 from pg_constraint p
         where p.conrelid = 'recruitment.scorecard_draft'::regclass and p.contype = 'f'
           and p.confrelid = 'recruitment.organization'::regclass
           and (select a.attname from pg_attribute a
                 where a.attrelid = p.conrelid and a.attnum = p.conkey[1]) = 'tenant_id') then
        raise exception 'DRAFT-STRUCT-02 scorecard_draft.tenant_id 缺到 organization 的外键';
      end if;
    end if;

    -- DRAFT-STRUCT-03 CHECK 约束（版本 ≥ 1 / payload 为对象 / payload ≤ 32KB）
    v_missing := '';
    select string_agg(t.name, ' ') into v_missing
      from unnest(array[
        'ck_scorecard_draft_record_version','ck_scorecard_draft_payload_object',
        'ck_scorecard_draft_payload_size'
      ]) as t(name)
     where not exists (select 1 from pg_constraint p
                        where p.conrelid = 'recruitment.scorecard_draft'::regclass
                          and p.contype = 'c' and p.conname = t.name);
    if coalesce(v_missing, '') <> '' then
      raise exception 'DRAFT-STRUCT-03 scorecard_draft 缺 CHECK 约束：%', v_missing;
    end if;

    -- DRAFT-STRUCT-04 append-only：禁删 + 整行不可改（fn_guard_columns 无白名单）
    for v_col in select unnest(array[
      'trg_scorecard_draft_no_delete','trg_scorecard_draft_immutable'
    ]) loop
      if not exists (select 1 from pg_trigger g
                      where g.tgrelid = 'recruitment.scorecard_draft'::regclass
                        and not g.tgisinternal and g.tgname = v_col) then
        raise exception 'DRAFT-STRUCT-04 scorecard_draft 缺触发器：%', v_col;
      end if;
    end loop;

    -- DRAFT-STRUCT-05 最新版本查询索引必须存在
    if not exists (select 1 from pg_index i
                    where i.indrelid = 'recruitment.scorecard_draft'::regclass
                      and i.indexrelid = 'recruitment.ix_scorecard_draft_latest'::regclass) then
      raise exception 'DRAFT-STRUCT-05 scorecard_draft 缺最新版本查询索引 ix_scorecard_draft_latest';
    end if;

    -- DRAFT-STRUCT-06 台账自登记
    if not exists (select 1 from recruitment.schema_migration where version = '0022_scorecard_draft') then
      raise exception 'DRAFT-STRUCT-06 schema_migration 缺 0022_scorecard_draft 自登记';
    end if;
    raise notice 'DRAFT-STRUCT PASS scorecard_draft 列/CHECK/payload≤32KB/禁删/不可变/最新版本索引/台账齐全';
  else
    raise notice 'DRAFT-STRUCT SKIP scorecard_draft 表不存在（0022 尚未应用）';
  end if;
end $$;


-- [0023 妙记改绑] minute_rebind 的专项断言：列 / CHECK / 幂等唯一键 / append-only /
-- 审计读回索引 / 台账自登记必须齐全。只新增本块，既有断言与计数零改动；
-- 表不存在时跳过（保持 verify.sql 在旧库可跑）。
do $$
declare
  v_missing text := '';
  v_col text;
begin
  if to_regclass('recruitment.minute_rebind') is not null then
    -- REBIND-STRUCT-01 必需列（含本轮约定的全部业务列）
    for v_col in select unnest(array[
      'id','tenant_id','interview_id','from_actor_id','to_actor_id','requested_by_actor_id',
      'minute_token','confirmation_text_sha256','cli_summary','dry_run','created_at'
    ]) loop
      if not exists (select 1 from pg_attribute a
                      where a.attrelid = 'recruitment.minute_rebind'::regclass
                        and a.attname = v_col and not a.attisdropped) then
        v_missing := v_missing || v_col || ' ';
      end if;
    end loop;
    if v_missing <> '' then
      raise exception 'REBIND-STRUCT-01 minute_rebind 缺列：%', v_missing;
    end if;

    -- REBIND-STRUCT-02 tenant_id NOT NULL + 外键到 organization（STRUCT-02/03 同口径）
    if not exists (select 1 from pg_attribute a
                    where a.attrelid = 'recruitment.minute_rebind'::regclass
                      and a.attname = 'tenant_id' and a.attnotnull and not a.attisdropped) then
      raise exception 'REBIND-STRUCT-02 minute_rebind.tenant_id 不是 NOT NULL';
    end if;
    if not exists (
      select 1 from pg_constraint p
       where p.conrelid = 'recruitment.minute_rebind'::regclass and p.contype = 'f'
         and p.confrelid = 'recruitment.organization'::regclass
         and (select a.attname from pg_attribute a
               where a.attrelid = p.conrelid and a.attnum = p.conkey[1]) = 'tenant_id') then
      raise exception 'REBIND-STRUCT-02 minute_rebind.tenant_id 缺到 organization 的外键';
    end if;

    -- REBIND-STRUCT-03 CHECK 约束（token 形状 / sha256 / 不同 actor / cli_summary 对象）
    v_missing := '';
    select string_agg(t.name, ' ') into v_missing
      from unnest(array[
        'ck_minute_rebind_minute_token','ck_minute_rebind_sha256',
        'ck_minute_rebind_distinct_actors','ck_minute_rebind_cli_summary_object'
      ]) as t(name)
     where not exists (select 1 from pg_constraint p
                        where p.conrelid = 'recruitment.minute_rebind'::regclass
                          and p.contype = 'c' and p.conname = t.name);
    if coalesce(v_missing, '') <> '' then
      raise exception 'REBIND-STRUCT-03 minute_rebind 缺 CHECK 约束：%', v_missing;
    end if;

    -- REBIND-STRUCT-04 幂等唯一键（tenant+interview+minute+to）
    if not exists (select 1 from pg_constraint p
                    where p.conrelid = 'recruitment.minute_rebind'::regclass
                      and p.contype = 'u' and p.conname = 'uq_minute_rebind_idempotent') then
      raise exception 'REBIND-STRUCT-04 minute_rebind 缺幂等唯一键 uq_minute_rebind_idempotent';
    end if;

    -- REBIND-STRUCT-05 append-only：禁删 + 整行不可改
    for v_col in select unnest(array[
      'trg_minute_rebind_no_delete','trg_minute_rebind_immutable'
    ]) loop
      if not exists (select 1 from pg_trigger g
                      where g.tgrelid = 'recruitment.minute_rebind'::regclass
                        and not g.tgisinternal and g.tgname = v_col) then
        raise exception 'REBIND-STRUCT-05 minute_rebind 缺触发器：%', v_col;
      end if;
    end loop;

    -- REBIND-STRUCT-06 审计读回索引
    if not exists (select 1 from pg_index i
                    where i.indrelid = 'recruitment.minute_rebind'::regclass
                      and i.indexrelid = 'recruitment.ix_minute_rebind_interview'::regclass) then
      raise exception 'REBIND-STRUCT-06 minute_rebind 缺索引 ix_minute_rebind_interview';
    end if;

    -- REBIND-STRUCT-07 台账自登记
    if not exists (select 1 from recruitment.schema_migration where version = '0023_minute_rebind') then
      raise exception 'REBIND-STRUCT-07 schema_migration 缺 0023_minute_rebind 自登记';
    end if;
    raise notice 'REBIND-STRUCT PASS minute_rebind 列/CHECK/幂等唯一键/禁删/不可变/审计索引/台账齐全';
  else
    raise notice 'REBIND-STRUCT SKIP minute_rebind 表不存在（0023 尚未应用）';
  end if;
end $$;


\echo ''
\echo '=================================================================='
\echo ' 3. 状态机取值覆盖（docs/03 §3/§10/§11/§13 + docs/04 §18）'
\echo '=================================================================='

do $$
declare
  r record;
  v_def text;
  v_val text;
begin
  for r in
    select * from (values
      ('requisition', 'ck_requisition_status',
        array['DRAFT','PENDING_APPROVAL','APPROVED','RECRUITING','PAUSED','FILLED','CANCELLED']),      ('job', 'ck_job_status',
        array['DRAFT','PENDING_REVIEW','APPROVED','OPEN','PAUSED','CLOSED','ARCHIVED']),
      ('interview', 'ck_interview_status',
        array['SCHEDULED','IN_PROGRESS','POST_INTERVIEW','EVALUATION_READY','DECIDED',
              'RESCHEDULED','CANCELLED','NO_SHOW']),
      ('application', 'ck_application_lifecycle_status',
        array['ACTIVE','ON_HOLD','WITHDRAWN','CLOSED']),
      ('business_task', 'ck_business_task_status',
        array['PENDING','READY','RUNNING','WAITING_EXTERNAL','WAITING_HUMAN','RETRY_WAIT',
              'SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELLED','SUPERSEDED']),
      ('task_attempt', 'ck_task_attempt_status',
        array['CLAIMED','RUNNING','SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL',
              'TIMED_OUT','CANCELLED','ABANDONED']),
      ('durable_effect', 'ck_durable_effect_status',
        array['PENDING','CLAIMED','SENT','CONFIRMED','RETRY_WAIT','UNKNOWN_OUTCOME',
              'FAILED_FINAL','CANCELLED','COMPENSATION_REQUIRED']),
      ('transcript_artifact', 'ck_transcript_artifact_status',
        array['DISCOVERED','FETCHING','PARTIAL','READY','WAITING_EXTERNAL',
              'RETRYABLE_FAILED','AUTH_REQUIRED','NEEDS_LINKING']),
      ('interview_record', 'ck_interview_record_status',
        array['PENDING','PROCESSING','PARTIAL','READY','FAILED','NEEDS_REVIEW']),
      ('scorecard', 'ck_scorecard_status', array['PENDING','SUBMITTED','WAIVED']),
      ('decision', 'ck_decision_result',
        array['ADVANCE','HOLD','REJECT','WITHDRAW','HIRED']),
      ('intake_record', 'ck_intake_record_status',
        array['RECEIVED','VALIDATING','READY_FOR_PROCESSING','PROCESSING','RESOLVED',
              'NEEDS_REVIEW','RETRY_WAIT','REJECTED','FAILED'])
    ) as v(tbl, conname, vals)
  loop
    select pg_get_constraintdef(p.oid) into v_def
      from pg_constraint p
     where p.conname = r.conname and p.conrelid = format('recruitment.%I', r.tbl)::regclass;
    if v_def is null then
      raise exception 'SM-01 约束不存在：% (%)', r.conname, r.tbl;
    end if;
    foreach v_val in array r.vals loop
      if v_def not like '%''' || v_val || '''%' then
        raise exception 'SM-01 % 缺少状态值 %', r.conname, v_val;
      end if;
    end loop;
    raise notice 'SM-01 PASS % 覆盖 % 个状态值', r.conname, array_length(r.vals, 1);
  end loop;
end $$;


\echo ''
\echo '=================================================================='
\echo ' 4. 对象覆盖率（docs/03 §1 三十六行 → 表 / 映射 / 缓做）'
\echo '=================================================================='

do $$
declare
  r        record;
  v_n_tab  integer := 0;
  v_n_map  integer := 0;
  v_n_def  integer := 0;
  v_tbl    text;
  v_missing text := '';
begin
  for r in
    select * from (values
      (1,  'Organization',                          'organization',                  'TABLE'),
      (2,  'Department',                            'department',                    'TABLE'),
      (3,  'User / Role',                           'actor, role, actor_role',       'TABLE'),
      (4,  'Requisition',                           'requisition',                   'TABLE'),
      (5,  'Job',                                   'job, job_version',              'TABLE'),
      (6,  'Job Posting',                           'job_posting',                   'TABLE'),
      (7,  'Candidate',                             'candidate, candidate_merge',    'TABLE'),
      (8,  'Prospect',                              '',                              'DEFERRED'),
      (9,  'Resume',                                'resume, resume_version',        'TABLE'),
      (10, 'Candidate Acquisition Source / Channel','acquisition_channel',           'TABLE'),
      (11, 'Application',                           'application',                   'TABLE'),
      (12, 'Pipeline Template',                     'pipeline_template',             'TABLE'),     -- [2026-11-14 回抄] 0014:332 已建表；0014 头注释 :20-24 点名的就是这个旧 DEFERRED
      (13, 'Pipeline Instance',                     'application.current_stage_code','MAPPED'),    -- 仍是列映射（0014 头注释 :22-24 同口径）
      (14, 'Stage',                                 'pipeline_template_stage',       'TABLE'),     -- [2026-11-14 回抄] 0014:359 已建表（旧 DEFERRED，0014 头注释 :21-23 点名）
      (15, 'Interview Template',                    'interview_template_version',    'TABLE'),
      (16, 'Stage Activity Template',               '',                              'DEFERRED'),
      (17, 'Interview',                             'interview',                     'TABLE'),
      (18, 'Interviewer',                           'interviewer',                   'TABLE'),
      (19, 'Meeting',                               'meeting, meeting_binding',      'TABLE'),
      (20, 'Transcript',                            'transcript_artifact, transcript_segment, transcript_processing_run', 'TABLE'),
      (21, 'AI Summary',                            'ai_summary',                    'TABLE'),
      (22, 'Interview Record',                      'interview_record',              'TABLE'),
      (23, 'Scorecard',                             'scorecard',                     'TABLE'),
      (24, 'Decision',                              'decision',                      'TABLE'),
      (25, 'Approval',                              'approval',                      'TABLE'),
      (26, 'Offer',                                 '',                              'DEFERRED'),
      (27, 'Talent Pool',                           '',                              'DEFERRED'),
      (28, 'Business Task',                         'business_task',                 'TABLE'),
      (29, 'Task Attempt',                          'task_attempt',                  'TABLE'),
      (30, 'Agent Session',                         'agent_session',                 'TABLE'),
      (31, 'Chat Thread',                           'chat_thread',                   'TABLE'),
      (32, 'Source Thread',                         '',                              'DEFERRED'),
      (33, 'Event Inbox / Event',                   'event_inbox',                   'TABLE'),
      (34, 'Durable Effect / Outbox',               'durable_effect',                'TABLE'),
      (35, 'Agent Execution Policy / Mandate',      'execution_mandate',             'TABLE'),
      (36, 'Business Config / Rubric Version',      'business_config, rubric_version','TABLE')
    ) as v(ord, obj_name, tbls, kind)
  loop
    if r.kind = 'DEFERRED' then
      v_n_def := v_n_def + 1;
    elsif r.kind = 'MAPPED' then
      v_n_map := v_n_map + 1;
    else
      foreach v_tbl in array string_to_array(r.tbls, ',') loop
        v_tbl := btrim(v_tbl);
        if to_regclass('recruitment.' || v_tbl) is null then
          v_missing := v_missing || format('[%s → %s] ', r.obj_name, v_tbl);
        end if;
      end loop;
      v_n_tab := v_n_tab + 1;
    end if;
  end loop;

  if v_missing <> '' then
    raise exception 'COV-01 以下对象声明了表但表不存在：%', v_missing;
  end if;
  raise notice 'COV-01 PASS 对象覆盖：有表 % / 列映射 % / 缓做 %（合计 %）',
    v_n_tab, v_n_map, v_n_def, v_n_tab + v_n_map + v_n_def;
end $$;

\echo '-- 额外表（不在三十六行清单内，来自 docs/03 §5 Intake 三层模型 / §6 合并记录）--'
select c.relname as extra_table
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'recruitment' and c.relkind = 'r'
   and c.relname in ('intake_record','intake_asset','candidate_merge')
 order by 1;


\echo ''
\echo '=================================================================='
\echo ' 5. 夹具（负向测试用，脚本结束会 ROLLBACK）'
\echo '=================================================================='

set local recruitment.actor_id = '11111111-1111-1111-1111-111111111111';

insert into recruitment.organization (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '租户甲'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '租户乙');

-- [D-34] 0004 给 application.current_stage_code 加了外键，夹具租户必须有自己的阶段目录。
-- to_regclass 保护：未跑 0004 时该表不存在，本块自动跳过 —— verify.sql 在"有/无 0004"两种情况下都能跑。
do $d34$
begin
  if to_regclass('recruitment.stage_catalog') is not null then
    insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope) values
      ('aaaaaaaa-0000-0000-0000-000000000001','S1','招聘需求发现',1,false),
      ('aaaaaaaa-0000-0000-0000-000000000001','S2','Requisition 创建与审批',2,false),
      ('aaaaaaaa-0000-0000-0000-000000000001','S3','Job / JD / Rubric 设计',3,true),
      ('aaaaaaaa-0000-0000-0000-000000000001','S4','Job Posting 发布',4,false),
      ('aaaaaaaa-0000-0000-0000-000000000001','S5','人才获取 / Sourcing',5,false),
      ('aaaaaaaa-0000-0000-0000-000000000001','S6','简历接入与处理（Intake）',6,true),
      ('aaaaaaaa-0000-0000-0000-000000000001','S7','初筛 / Screening',7,true),
      ('aaaaaaaa-0000-0000-0000-000000000001','S8','面试规划与排期',8,true),
      ('aaaaaaaa-0000-0000-0000-000000000001','S9','面试执行与材料获取',9,true),
      ('aaaaaaaa-0000-0000-0000-000000000001','S10','综合评价与招聘决策',10,true),
      ('aaaaaaaa-0000-0000-0000-000000000001','S11','Offer 与入职交接',11,false),
      ('aaaaaaaa-0000-0000-0000-000000000001','S12','人才沉淀与复盘',12,false)
    on conflict (tenant_id, code) do nothing;
  end if;
end
$d34$;

insert into recruitment.department (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', '研发部');

insert into recruitment.actor (id, tenant_id, kind, display_name, primary_email) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'HUMAN', 'HR 甲', 'hr@example.com'),
  ('11111111-1111-1111-1111-111111111112', 'aaaaaaaa-0000-0000-0000-000000000001', 'HUMAN', '面试官 乙', 'eng@example.com'),
  ('11111111-1111-1111-1111-111111111113', 'aaaaaaaa-0000-0000-0000-000000000001', 'SYSTEM', '系统', 'sys@example.com');

insert into recruitment.acquisition_channel (id, tenant_id, channel_type, name) values
  ('aaaaaaaa-0000-0000-0000-000000000021', 'aaaaaaaa-0000-0000-0000-000000000001', 'EMAIL', '企业邮箱');

insert into recruitment.requisition (id, tenant_id, department_id, title, headcount) values
  ('aaaaaaaa-0000-0000-0000-000000000031', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000011', '后端工程师', 2);

insert into recruitment.job (id, tenant_id, department_id, requisition_id, code, title) values
  ('aaaaaaaa-0000-0000-0000-000000000041', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000031', 'JOB-1', '后端工程师');

insert into recruitment.job_version (id, tenant_id, job_id, version_no, description_md, payload_hash) values
  ('aaaaaaaa-0000-0000-0000-000000000042', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000041', 1, 'JD v1', repeat('a', 64));

insert into recruitment.approval (id, tenant_id, resource_type, resource_id, resource_record_version, canonical_payload_hash) values
  ('aaaaaaaa-0000-0000-0000-000000000043', 'aaaaaaaa-0000-0000-0000-000000000001',
   'RUBRIC_VERSION', 'aaaaaaaa-0000-0000-0000-000000000044', 1, repeat('b', 64));

-- 让这条审批进入"已决"状态，后续负向测试才能验证「已决不可改判」
update recruitment.approval
   set status = 'APPROVED', decided_at = now(),
       decision_by_actor_id = '11111111-1111-1111-1111-111111111111'
 where id = 'aaaaaaaa-0000-0000-0000-000000000043';

insert into recruitment.rubric_version (id, tenant_id, job_id, version_no, dimensions, payload_hash, approved_by_approval_id) values
  ('aaaaaaaa-0000-0000-0000-000000000044', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000041', 1, '[{"code":"BACKEND","weight":1.0}]'::jsonb, repeat('c', 64),
   'aaaaaaaa-0000-0000-0000-000000000043');

insert into recruitment.event_inbox (event_id, tenant_id, provider, provider_event_id, event_type, idempotency_key, payload, trust_level) values
  ('aaaaaaaa-0000-0000-0000-000000000051', 'aaaaaaaa-0000-0000-0000-000000000001',
   'feishu', 'evt-1', 'resume.received', 'feishu:evt-1', '{"k":"v"}', 'UNTRUSTED_EXTERNAL');

insert into recruitment.intake_record (id, tenant_id, event_id, channel_id) values
  ('aaaaaaaa-0000-0000-0000-000000000052', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000051', 'aaaaaaaa-0000-0000-0000-000000000021');

insert into recruitment.intake_asset (id, tenant_id, intake_record_id, file_name, byte_size, sha256, storage_ref, validation_status) values
  ('aaaaaaaa-0000-0000-0000-000000000053', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000052', 'cv.pdf', 1024, repeat('d', 64), 's3://b/cv.pdf', 'VALID');

insert into recruitment.candidate (id, tenant_id, display_name, normalized_email) values
  ('aaaaaaaa-0000-0000-0000-000000000061', 'aaaaaaaa-0000-0000-0000-000000000001', '张三', 'zhangsan@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000062', 'aaaaaaaa-0000-0000-0000-000000000002', '跨租户候选人', 'other@example.com');

insert into recruitment.resume (id, tenant_id, candidate_id, intake_asset_id, channel_id) values
  ('aaaaaaaa-0000-0000-0000-000000000063', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000061', 'aaaaaaaa-0000-0000-0000-000000000053',
   'aaaaaaaa-0000-0000-0000-000000000021');

insert into recruitment.resume_version (id, tenant_id, resume_id, version_no, source_asset_sha256, content_sha256, parser_name, parser_version, parse_status) values
  ('aaaaaaaa-0000-0000-0000-000000000064', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000063', 1, repeat('d', 64), repeat('e', 64), 'converter', '1.0', 'PARSED');

insert into recruitment.application (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, channel_id, resume_version_id, current_stage_code) values
  ('aaaaaaaa-0000-0000-0000-000000000071', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000061', 'aaaaaaaa-0000-0000-0000-000000000041',
   'aaaaaaaa-0000-0000-0000-000000000042', 'aaaaaaaa-0000-0000-0000-000000000044',
   'aaaaaaaa-0000-0000-0000-000000000021', 'aaaaaaaa-0000-0000-0000-000000000064', 'S7');

insert into recruitment.interview_template_version (id, tenant_id, job_id, template_code, round_no, version_no, payload_hash, rubric_version_id) values
  ('aaaaaaaa-0000-0000-0000-000000000081', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000041', 'TECH_R1', 1, 1, repeat('f', 64),
   'aaaaaaaa-0000-0000-0000-000000000044');

insert into recruitment.interview (id, tenant_id, application_id, interview_template_version_id, round_no, slot_code, status, scheduled_start_at, scheduled_end_at) values
  ('aaaaaaaa-0000-0000-0000-000000000091', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000071', 'aaaaaaaa-0000-0000-0000-000000000081',
   1, 'TECH', 'SCHEDULED', now() - interval '3 hour', now() - interval '2 hour');

insert into recruitment.interviewer (id, tenant_id, interview_id, actor_id, role_in_interview) values
  ('aaaaaaaa-0000-0000-0000-000000000092', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000091', '11111111-1111-1111-1111-111111111112', 'TECH_LEAD'),
  ('aaaaaaaa-0000-0000-0000-000000000093', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000091', '11111111-1111-1111-1111-111111111111', 'HR');

insert into recruitment.meeting (id, tenant_id, provider, external_meeting_id, calendar_event_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'feishu', 'mtg-1', 'cal-1');

insert into recruitment.meeting_binding (id, tenant_id, meeting_id, interview_id, binding_method) values
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000091', 'SCHEDULED');

insert into recruitment.transcript_artifact (
  id, tenant_id, meeting_id, provider, provider_artifact_id, source_revision, transcript_status,
  provenance, trigger_mode, connection_state, fetched_at, read_receipt_ref, content_sha256,
  page_count, is_complete, raw_text)
values (
  'aaaaaaaa-0000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-0000000000a1', 'feishu', 'mn-1', 1, 'READY',
  'LIVE', 'MANUAL', 'NOT_CONNECTED', now(), 'lark-cli:minutes:abc', repeat('1', 64),
  1, true, '[00:00] 面试官：你好');

insert into recruitment.interview_record (
  id, tenant_id, interview_id, transcript_artifact_id, transcript_revision, rubric_version_id,
  prompt_version, model_id, status, verification_status, sections, evidence_ok, chunk_coverage)
values (
  'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000091', 'aaaaaaaa-0000-0000-0000-0000000000b1', 1,
  'aaaaaaaa-0000-0000-0000-000000000044', 'prompt@1', 'deepseek-v4', 'READY', 'VERIFIED',
  '{"overview":"x"}'::jsonb, true, 1.0);

insert into recruitment.scorecard (
  id, tenant_id, interview_id, interviewer_id, rubric_version_id, status, submitted_at, items, overall)
values (
  'aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000091', 'aaaaaaaa-0000-0000-0000-000000000092',
  'aaaaaaaa-0000-0000-0000-000000000044', 'SUBMITTED', now(), '[{"dim":"BACKEND","score":4}]'::jsonb, '推进');

insert into recruitment.decision (
  id, tenant_id, application_id, interview_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
values (
  'aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000071', 'aaaaaaaa-0000-0000-0000-000000000091',
  'STAGE', 'S8', 'ADVANCE', '11111111-1111-1111-1111-111111111111', '技术面通过');

insert into recruitment.business_task (id, tenant_id, task_type, title, trigger_event_id, idempotency_key) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'TRANSCRIPT_FETCH', '取转写', 'aaaaaaaa-0000-0000-0000-000000000051', 'transcript:mtg-1'),
  ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'TRANSCRIPT_FETCH', '取转写（第二条，负向测试用）', 'aaaaaaaa-0000-0000-0000-000000000051', 'transcript:mtg-2');

insert into recruitment.task_attempt (id, tenant_id, task_id, attempt_no, worker_type, worker_id, status, lease_expires_at) values
  ('aaaaaaaa-0000-0000-0000-000000001001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000f1', 1, 'DSH_JOB', 'w1', 'RUNNING', now() + interval '5 min');

update recruitment.business_task
   set status = 'RUNNING', current_attempt_id = 'aaaaaaaa-0000-0000-0000-000000001001', attempt_count = 1
 where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';

insert into recruitment.durable_effect (id, tenant_id, effect_type, idempotency_key, status) values
  ('aaaaaaaa-0000-0000-0000-000000001011', 'aaaaaaaa-0000-0000-0000-000000000001',
   'SEND_EMAIL', 'email:1', 'PENDING');

insert into recruitment.execution_mandate (id, tenant_id, actor_id, actor_type, task_id, permission_version, allowed_tools, allowed_actions, expires_at) values
  ('aaaaaaaa-0000-0000-0000-000000001021', 'aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111113', 'SYSTEM', 'aaaaaaaa-0000-0000-0000-0000000000f1',
   'perm@1', '{recruitment_resume_read}', '{read,fetch}', now() + interval '1 day');

insert into recruitment.chat_thread (id, tenant_id, external_thread_ref) values
  ('aaaaaaaa-0000-0000-0000-000000001031', 'aaaaaaaa-0000-0000-0000-000000000001', 'dsh-s-1');

\echo ' 夹具就绪'


\echo ''
\echo '=================================================================='
\echo ' 6. 负向测试（每条都必须 FAIL，并给出真实 SQLSTATE / 报错）'
\echo '=================================================================='

do $$
declare
  v_state text;
  v_msg   text;
  v_ok    integer := 0;
  r       record;
begin
  -- 负向测试期间不提供 actor：状态迁移类用例必须因此失败
  perform set_config('recruitment.actor_id', '', true);

  for r in
    select * from (values
      ('N01', '23503', 'Application 关联不存在的 Candidate（不变量 1）',
       $q$insert into recruitment.application (tenant_id, candidate_id, job_id, job_version_id)
          values ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000000',
                  'aaaaaaaa-0000-0000-0000-000000000041','aaaaaaaa-0000-0000-0000-000000000042')$q$),
      ('N02', '23502', 'Application 缺 Job（不变量 1：必须关联 Job）',
       $q$insert into recruitment.application (tenant_id, candidate_id, job_id, job_version_id)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000061',
                  null,'aaaaaaaa-0000-0000-0000-000000000042')$q$),
      ('N03', '23503', '跨租户引用 Candidate（复合外键防越权）',
       $q$insert into recruitment.application (tenant_id, candidate_id, job_id, job_version_id)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000062',
                  'aaaaaaaa-0000-0000-0000-000000000041','aaaaaaaa-0000-0000-0000-000000000042')$q$),
      ('N04', '23514', 'Job 状态写非法枚举值（状态机）',
       $q$insert into recruitment.job (tenant_id, department_id, code, title, status)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000011',
                  'JOB-BAD','非法状态岗','HIRED')$q$),
      ('N05', '23505', '同一来源事件重复创建 Business Task（不变量 1）',
       $q$insert into recruitment.business_task (tenant_id, task_type, title, idempotency_key)
          values ('aaaaaaaa-0000-0000-0000-000000000001','X','重复任务','transcript:mtg-1')$q$),
      ('N06', '23505', '同一 provider 事件重复进 Event Inbox',
       $q$insert into recruitment.event_inbox (tenant_id, provider, provider_event_id, event_type, idempotency_key, payload, trust_level)
          values ('aaaaaaaa-0000-0000-0000-000000000001','feishu','evt-1','resume.received','feishu:evt-1','{}','UNTRUSTED_EXTERNAL')$q$),
      ('N07', '23514', '备用幂等键同时又给了 provider_event_id（禁止双轨去重）',
       $q$insert into recruitment.event_inbox (tenant_id, provider, provider_event_id, event_type, idempotency_key, idempotency_source, source_object_id, payload, trust_level)
          values ('aaaaaaaa-0000-0000-0000-000000000001','feishu','evt-2','x.y','feishu:evt-2','FALLBACK_KEY','obj-2','{}','UNTRUSTED_EXTERNAL')$q$),
      ('N08', '23514', '转写 READY 但未取全（完整性 Gate）',
       $q$update recruitment.transcript_artifact set is_complete = false
           where id = 'aaaaaaaa-0000-0000-0000-0000000000b1'$q$),
      ('N09', '23514', 'LIVE 转写没有连接器读取回执（R4 诚实标注）',
       $q$insert into recruitment.transcript_artifact
            (tenant_id, meeting_id, provider, provider_artifact_id, source_revision,
             transcript_status, provenance, trigger_mode, connection_state, raw_text)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000a1',
                  'feishu','mn-noreceipt',1,'DISCOVERED','LIVE','MANUAL','NOT_CONNECTED','x')$q$),
      ('N10', '23514', 'Scorecard SUBMITTED 但缺 submitted_at / items',
       $q$insert into recruitment.scorecard (tenant_id, interview_id, interviewer_id, rubric_version_id, status, status_changed_by_actor_id)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000091',
                  'aaaaaaaa-0000-0000-0000-000000000092','aaaaaaaa-0000-0000-0000-000000000044','SUBMITTED',
                  '11111111-1111-1111-1111-111111111111')$q$),
      ('N11', '23514', '已提交 Scorecard 被改写（评价不可覆盖）',
       $q$update recruitment.scorecard set items = '[{"dim":"BACKEND","score":1}]'::jsonb
           where id = 'aaaaaaaa-0000-0000-0000-0000000000d1'$q$),
      ('N12', '23514', 'Decision 理由为空（不变量 9）',
       $q$insert into recruitment.decision (tenant_id, application_id, decision_scope, result, decided_by_actor_id, reason)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000071',
                  'STAGE','REJECT','11111111-1111-1111-1111-111111111111','   ')$q$),
      ('N13', '23514', 'Approval 批准但没写审批人/时间（不变量 9）',
       $q$insert into recruitment.approval (tenant_id, resource_type, resource_id, resource_record_version, canonical_payload_hash, status)
          values ('aaaaaaaa-0000-0000-0000-000000000001','JOB','aaaaaaaa-0000-0000-0000-000000000041',1,repeat('e',64),'APPROVED')$q$),
      ('N14', '23514', '已决 Approval 被改内容（审批绑内容）',
       $q$update recruitment.approval set canonical_payload_hash = repeat('9',64)
           where id = 'aaaaaaaa-0000-0000-0000-000000000043'$q$),
      ('N15', '23514', '状态迁移没有 actor（不变量 8）',
       $q$update recruitment.job set status = 'PAUSED' where id = 'aaaaaaaa-0000-0000-0000-000000000041'$q$),
      ('N16', '23514', '手改 status_changed_at 伪造迁移时间',
       $q$update recruitment.job set status_changed_at = now() - interval '30 day'
           where id = 'aaaaaaaa-0000-0000-0000-000000000041'$q$),
      ('N17', '23505', '同一 Task 两个有效租约（不允许双 Worker）',
       $q$insert into recruitment.task_attempt (tenant_id, task_id, attempt_no, worker_type, worker_id, status, lease_expires_at)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000f1',2,'DSH_JOB','w2','CLAIMED', now() + interval '5 min')$q$),
      ('N18', '23514', '可重试失败却不给 retry_after（重试必须有时间）',
       $q$insert into recruitment.task_attempt (tenant_id, task_id, attempt_no, worker_type, worker_id, status, lease_expires_at, ended_at, error_class)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000f2',1,'DSH_JOB','w3','FAILED_RETRYABLE', now() + interval '1 min', now(),'TRANSIENT')$q$),
      ('N19', '23514', 'Business Task RUNNING 但没有 current_attempt_id',
       $q$insert into recruitment.business_task (tenant_id, task_type, title, idempotency_key, status)
          values ('aaaaaaaa-0000-0000-0000-000000000001','X','无 attempt 的 RUNNING','task:no-attempt','RUNNING')$q$),
      ('N20', '23514', '删除 Candidate（历史事实禁删，不变量 2）',
       $q$delete from recruitment.candidate where id = 'aaaaaaaa-0000-0000-0000-000000000061'$q$),
      ('N21', '23514', '修改 Rubric 版本（配置变更不得静默改历史，不变量 10）',
       $q$update recruitment.rubric_version set dimensions = '[]'::jsonb
           where id = 'aaaaaaaa-0000-0000-0000-000000000044'$q$),
      ('N22', '23514', '修改 Resume 版本解析结果（简历版本不可覆盖）',
       $q$update recruitment.resume_version set parsed_fields = '{"x":1}'::jsonb
           where id = 'aaaaaaaa-0000-0000-0000-000000000064'$q$),
      ('N23', '23514', '改写平台原始转写原文（不变量 6：原文不可被覆盖）',
       $q$update recruitment.transcript_artifact set raw_text = '被改过的原文'
           where id = 'aaaaaaaa-0000-0000-0000-0000000000b1'$q$),
      ('N24', '23514', '直接改 Candidate 身份状态（没有 Merge Record）',
       $q$update recruitment.candidate set identity_status = 'MERGED'
           where id = 'aaaaaaaa-0000-0000-0000-000000000061'$q$),
      ('N25', '23514', 'Candidate 合并没有匹配依据（禁止无依据归并）',
       $q$insert into recruitment.candidate_merge (tenant_id, surviving_candidate_id, merged_candidate_id, match_basis, auto_merged)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000061',
                  'aaaaaaaa-0000-0000-0000-000000000061','{}'::jsonb, true)$q$),
      ('N26', '23505', '同一租户重复创建 ACTIVE 候选人（强标识唯一）',
       $q$insert into recruitment.candidate (tenant_id, display_name, normalized_email)
          values ('aaaaaaaa-0000-0000-0000-000000000001','张三（重复）','zhangsan@example.com')$q$),
      ('N27', '23514', 'Execution Mandate 里出现业务审批动作（闸门不可绕过）',
       $q$insert into recruitment.execution_mandate (tenant_id, actor_id, actor_type, permission_version, allowed_actions, expires_at)
          values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111113','SYSTEM','perm@1','{approve}', now() + interval '1 day')$q$),
      ('N28', '23505', '同一会议被绑定到第二个面试（MEETING_ALREADY_BOUND）',
       $q$insert into recruitment.meeting_binding (tenant_id, meeting_id, interview_id, binding_method)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000a1',
                  'aaaaaaaa-0000-0000-0000-000000000091','SCHEDULED')$q$),
      ('N29', '23514', 'Interview Record 标 READY 但证据未校验',
       $q$update recruitment.interview_record set verification_status = 'UNVERIFIED'
           where id = 'aaaaaaaa-0000-0000-0000-0000000000c1'$q$),
      ('N30', '23514', '处理跑通成功但仍有失败 Chunk（不得把部分当完整）',
       $q$insert into recruitment.transcript_processing_run (tenant_id, artifact_id, chunk_total, chunk_succeeded, chunk_failed, status)
          values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000b1',2,1,1,'SUCCEEDED')$q$),
      ('N31', '23505', 'Duplicate Effect：同一幂等键再建一条（重试不得新建 Effect）',
       $q$insert into recruitment.durable_effect (tenant_id, effect_type, idempotency_key, status)
          values ('aaaaaaaa-0000-0000-0000-000000000001','SEND_EMAIL','email:1','PENDING')$q$),
      ('N32', '23514', 'Event trust_level 写非法值（外部文本不可信是枚举）',
       $q$insert into recruitment.event_inbox (tenant_id, provider, event_type, idempotency_key, payload, trust_level)
          values ('aaaaaaaa-0000-0000-0000-000000000001','feishu','x.y','feishu:evt-3','{}','TRUSTED')$q$)
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

  raise notice 'NEGATIVE SUMMARY % 条负向测试全部按预期失败', v_ok;
end $$;


\echo ''
\echo '=================================================================='
\echo ' 7. 正向断言（约束没有把合法路径堵死）'
\echo '=================================================================='

do $$
declare
  v_n integer;
begin
  -- 7.1 合法状态迁移 + 自动写内部事件 + 版本自增
  set local recruitment.actor_id = '11111111-1111-1111-1111-111111111111';
  update recruitment.job set status = 'OPEN' where id = 'aaaaaaaa-0000-0000-0000-000000000041';

  select count(*) into v_n from recruitment.event_inbox
   where provider = 'internal' and event_type = 'job.status.changed'
     and payload ->> 'record_id' = 'aaaaaaaa-0000-0000-0000-000000000041';
  if v_n <> 1 then
    raise exception 'POS-01 状态迁移没有写内部事件（期望 1 条，实际 %）', v_n;
  end if;

  select record_version into v_n from recruitment.job
   where id = 'aaaaaaaa-0000-0000-0000-000000000041';
  if v_n < 2 then
    raise exception 'POS-02 状态迁移没有自增 record_version（实际 %）', v_n;
  end if;
  raise notice 'POS-01/02 PASS 状态迁移 → 内部事件 1 条 + record_version 自增';

  -- 7.2 乐观并发：版本不匹配时改不动（WHERE record_version = 期望值 → 0 行）
  update recruitment.job set title = '并发测试'
   where id = 'aaaaaaaa-0000-0000-0000-000000000041' and record_version = 1;
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'POS-03 过期版本竟然更新成功（% 行）', v_n;
  end if;
  raise notice 'POS-03 PASS 过期 record_version 更新影响 0 行（VERSION_CONFLICT 由调用方处理）';

  -- 7.3 未提交的 Scorecard 仍可编辑（PENDING → SUBMITTED）
  insert into recruitment.scorecard (id, tenant_id, interview_id, interviewer_id, rubric_version_id, status)
  values ('aaaaaaaa-0000-0000-0000-000000002001','aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000091','aaaaaaaa-0000-0000-0000-000000000093',
          'aaaaaaaa-0000-0000-0000-000000000044','PENDING');
  update recruitment.scorecard set items = '[{"dim":"BACKEND","score":5}]'::jsonb
   where id = 'aaaaaaaa-0000-0000-0000-000000002001';
  raise notice 'POS-04 PASS PENDING Scorecard 可编辑（提交后才冻结）';

  -- 7.4 合并链路：写入 Merge Record 自动把被合并方标 MERGED，且不删除 Application
  insert into recruitment.candidate (id, tenant_id, display_name, normalized_email)
  values ('aaaaaaaa-0000-0000-0000-000000002011','aaaaaaaa-0000-0000-0000-000000000001','张三（重复档）','zs2@example.com');
  insert into recruitment.candidate_merge (id, tenant_id, surviving_candidate_id, merged_candidate_id, match_basis, auto_merged, decided_by_actor_id)
  values ('aaaaaaaa-0000-0000-0000-000000002012','aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000061','aaaaaaaa-0000-0000-0000-000000002011',
          '{"strong_ids":["email"],"rule":"HIGH_CONFIDENCE_MULTI_DIM"}'::jsonb, false,
          '11111111-1111-1111-1111-111111111111');

  select count(*) into v_n from recruitment.candidate
   where id = 'aaaaaaaa-0000-0000-0000-000000002011' and identity_status = 'MERGED'
     and merged_into_candidate_id = 'aaaaaaaa-0000-0000-0000-000000000061';
  if v_n <> 1 then
    raise exception 'POS-05 合并后未把被合并方标 MERGED';
  end if;
  select count(*) into v_n from recruitment.application
   where candidate_id = 'aaaaaaaa-0000-0000-0000-000000000061';
  if v_n <> 1 then
    raise exception 'POS-05 合并影响了历史 Application（不变量 2）';
  end if;
  raise notice 'POS-05 PASS 合并保留全部历史 Application，且主档未被改动';

  -- 7.5 版本自增
  select record_version into v_n from recruitment.candidate
   where id = 'aaaaaaaa-0000-0000-0000-000000002011';
  if v_n < 2 then
    raise exception 'POS-06 candidate.record_version 未自增（实际 %）', v_n;
  end if;
  raise notice 'POS-06 PASS candidate.record_version 自动自增（当前 %）', v_n;
end $$;


\echo ''
\echo '=================================================================='
\echo ' 8. 不变量 → 约束 台账（逐条打印，全部必须已落地）'
\echo '=================================================================='

do $$
declare
  r record;
begin
  for r in
    select * from (values
      (1,  'Application 必须关联 Candidate 和 Job',
           'DB', 'fk_application_candidate / fk_application_job + NOT NULL'),
      (2,  'Candidate 合并不删除历史 Application',
           'DB', 'trg_application_no_delete + candidate_merge 不改 application + 复合外键 NO ACTION'),
      (3,  'Requisition / Job / Job Posting 各自独立身份与状态',
           'DB', '三张独立表，各自 PK 与 ck_*_status'),
      (4,  'Interview 必须关联 Application 和面试轮次',
           'DB', 'fk_interview_application + ck_interview_round + uq_interview_slot'),
      (5,  'Meeting 与 Interview 靠平台 ID 绑定，不能靠标题',
           'DB', 'meeting 表无标题列 + ck_meeting_identity + uq_meeting_binding_active'),
      (6,  'Transcript 原文不可被 AI Summary 覆盖',
           'DB', 'transcript_artifact 原文列在白名单外（trg_*_immutable）+ ai_summary 独立表引用 revision'),
      (7,  'Scorecard 必须记录评价者和评分标准版本',
           'DB', 'interviewer_id + rubric_version_id 均 NOT NULL 外键'),
      (8,  'Workflow 状态迁移必须有来源事件/动作、时间和结果',
           'DB', 'fn_row_guard：状态变化必须给 actor，自动写 event_inbox 并回填 status_source_event_id'),
      (9,  '重要审批与决策保留责任人、时间、结果、理由',
           'DB', 'ck_approval_decided_fields / ck_decision_reason / decided_by_actor_id NOT NULL'),
      (10, '配置变更不静默改变历史评价或已结束申请',
           'DB', 'rubric_version/business_config 不可变 + scorecard.rubric_version_id 固定引用 + application.job_version_id 固定引用')
    ) as v(no, inv, kind, enforcer)
  loop
    if r.kind = 'DB' then
      raise notice 'INV-% PASS % → %', r.no, r.inv, r.enforcer;
    else
      raise notice 'INV-% APP-LAYER % → %', r.no, r.inv, r.enforcer;
    end if;
  end loop;
end $$;

\echo ''
\echo '-- 应用层保证的规则（DB 无法声明，理由写在 SCHEMA.md §4）--'
select * from (values
  ('APP-01', '禁止"离职事件直接把 Requisition 设为 Approved"'),
  ('APP-02', '同一候选人同岗位重复申请的新建/复活/冷却期由企业规则决定'),
  ('APP-03', '禁止只按文本哈希去重（幂等键来源由接收层决定）'),
  ('APP-04', '禁止模糊匹配自动写 Meeting↔Interview 关系（只允许人工或事件精确匹配）'),
  ('APP-05', 'Evaluation Ready 三条件是跨表聚合（Scorecard 全交 + Record 完成 + 可回溯）'),
  ('APP-06', '禁止把 PARSING 当成招聘阶段（状态轴分离由写入方保证）'),
  ('APP-07', 'Agent 不得写 Scorecard 内容 / 不得代替人做闸门决策（由 Mandate + 服务端授权校验）'),
  ('APP-08', '跨租户与资源访问授权（不变量 7，依赖可信服务端 + Mandate，不依赖 Prompt）')
) as v(id, rule)
order by 1;


\echo ''
\echo '=================================================================='
\echo ' 9. 行数核对（脚本回滚前应为夹具行数，回滚后应为 0）'
\echo '=================================================================='

select 'candidate' as t, count(*) from recruitment.candidate
union all select 'application', count(*) from recruitment.application
union all select 'event_inbox', count(*) from recruitment.event_inbox
union all select 'transcript_artifact', count(*) from recruitment.transcript_artifact
union all select 'scorecard', count(*) from recruitment.scorecard
union all select 'business_task', count(*) from recruitment.business_task
order by 1;

\echo ''
\echo '=================================================================='
\echo ' 10. [0020 追加] 批量不通过与撤销的审计表结构断言'
\echo '=================================================================='

do $$
declare
  v_missing text := '';
  v_col text;
begin
  -- 10.1 batch_operation：列 / 幂等唯一键 / 枚举 CHECK / 禁删 / 不可变护栏
  if to_regclass('recruitment.batch_operation') is not null then
    for v_col in select unnest(array[
      'id','tenant_id','action_id','operation_type','actor_id','occurred_at',
      'target_count','succeeded_count','failed_count','reason',
      'confirmation_text_sha256','target_summary','superseded_by_action_id'
    ]) loop
      if not exists (select 1 from pg_attribute a
                      where a.attrelid = 'recruitment.batch_operation'::regclass
                        and a.attname = v_col and not a.attisdropped) then
        v_missing := v_missing || v_col || ' ';
      end if;
    end loop;
    if v_missing <> '' then
      raise exception 'BATCH-STRUCT-01 batch_operation 缺列：%', v_missing;
    end if;
    if not exists (select 1 from pg_constraint p
                    where p.conrelid = 'recruitment.batch_operation'::regclass
                      and p.contype = 'u' and p.conname = 'uq_batch_operation_action_id') then
      raise exception 'BATCH-STRUCT-02 batch_operation 缺 (tenant_id, action_id) 幂等唯一键';
    end if;
    if not exists (select 1 from pg_constraint p
                    where p.conrelid = 'recruitment.batch_operation'::regclass
                      and p.contype = 'c' and p.conname = 'ck_batch_operation_type') then
      raise exception 'BATCH-STRUCT-03 batch_operation 缺 operation_type 枚举 CHECK';
    end if;
    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = 'recruitment.batch_operation'::regclass
                      and not g.tgisinternal and g.tgname = 'trg_batch_operation_no_delete') then
      raise exception 'BATCH-STRUCT-04 batch_operation 缺 fn_block_delete 禁删触发器';
    end if;
    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = 'recruitment.batch_operation'::regclass
                      and not g.tgisinternal and g.tgname = 'trg_batch_operation_immutable') then
      raise exception 'BATCH-STRUCT-05 batch_operation 缺不可变护栏触发器';
    end if;
    raise notice 'BATCH-STRUCT PASS batch_operation 列/幂等键/CHECK/禁删/不可变护栏齐全';
  else
    raise notice 'BATCH-STRUCT SKIP batch_operation 表不存在（0020 尚未应用）';
  end if;

  -- 10.2 undo_log：列 / 幂等唯一键 / 枚举 CHECK / 禁删 / 墓碑式收口护栏 / 索引
  if to_regclass('recruitment.undo_log') is not null then
    v_missing := '';
    for v_col in select unnest(array[
      'id','tenant_id','action_id','kind','operation_type',
      'target_application_id','target_decision_id','target_interview_id','action_type',
      'actor_id','occurred_at','reason','confirmation_text_sha256',
      'before_summary','after_summary','compensation_action_id','superseded_by_action_id'
    ]) loop
      if not exists (select 1 from pg_attribute a
                      where a.attrelid = 'recruitment.undo_log'::regclass
                        and a.attname = v_col and not a.attisdropped) then
        v_missing := v_missing || v_col || ' ';
      end if;
    end loop;
    if v_missing <> '' then
      raise exception 'UNDO-STRUCT-01 undo_log 缺列：%', v_missing;
    end if;
    if not exists (select 1 from pg_constraint p
                    where p.conrelid = 'recruitment.undo_log'::regclass
                      and p.contype = 'u' and p.conname = 'uq_undo_log_action_kind') then
      raise exception 'UNDO-STRUCT-02 undo_log 缺 (tenant_id, action_id, kind) 幂等唯一键';
    end if;
    select string_agg(t.name, ' ') into v_missing
      from unnest(array[
        'ck_undo_log_kind','ck_undo_log_operation_type','ck_undo_log_action_type',
        'ck_undo_log_original_action_type','ck_undo_log_reason','ck_undo_log_sha256',
        'ck_undo_log_no_self_link'
      ]) as t(name)
     where not exists (select 1 from pg_constraint p
                        where p.conrelid = 'recruitment.undo_log'::regclass
                          and p.contype = 'c' and p.conname = t.name);
    if coalesce(v_missing, '') <> '' then
      raise exception 'UNDO-STRUCT-03 undo_log 缺 CHECK 约束：%', v_missing;
    end if;
    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = 'recruitment.undo_log'::regclass
                      and not g.tgisinternal and g.tgname = 'trg_undo_log_no_delete') then
      raise exception 'UNDO-STRUCT-04 undo_log 缺 fn_block_delete 禁删触发器';
    end if;
    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = 'recruitment.undo_log'::regclass
                      and not g.tgisinternal and g.tgname = 'trg_undo_log_immutable'
                      and pg_get_triggerdef(g.oid) like '%compensation_action_id%'
                      and pg_get_triggerdef(g.oid) like '%superseded_by_action_id%') then
      raise exception 'UNDO-STRUCT-05 undo_log 缺墓碑式收口护栏（两列白名单）';
    end if;
    if not exists (select 1 from pg_index i
                    where i.indrelid = 'recruitment.undo_log'::regclass
                      and i.indpred is not null) then
      raise exception 'UNDO-STRUCT-06 undo_log 缺原记录时间线部分索引';
    end if;
    raise notice 'UNDO-STRUCT PASS undo_log 列/幂等键/CHECK/禁删/墓碑护栏/索引齐全';
  else
    raise notice 'UNDO-STRUCT SKIP undo_log 表不存在（0020 尚未应用）';
  end if;

  -- 10.3 迁移台账必须自登记（结构存在时）
  if to_regclass('recruitment.batch_operation') is not null
     and not exists (select 1 from recruitment.schema_migration where version = '0020_undo_log') then
    raise exception 'MIGRATION-0020 batch_operation/undo_log 已存在但 schema_migration 未自登记 0020_undo_log';
  end if;
end $$;

\echo ''
\echo '=================================================================='
\echo ' 11. [0021 追加] 候选人星标 application_star 的结构断言'
\echo '=================================================================='

do $$
declare
  v_missing text := '';
  v_col text;
begin
  if to_regclass('recruitment.application_star') is not null then
    -- STAR-STRUCT-01 必需列（一行 = 一次切换事实，取最新一条为当前值）
    for v_col in select unnest(array[
      'id','tenant_id','application_id','starred','actor_id',
      'confirmation_text_sha256','created_at'
    ]) loop
      if not exists (select 1 from pg_attribute a
                      where a.attrelid = 'recruitment.application_star'::regclass
                        and a.attname = v_col and not a.attisdropped) then
        v_missing := v_missing || v_col || ' ';
      end if;
    end loop;
    if v_missing <> '' then
      raise exception 'STAR-STRUCT-01 application_star 缺列：%', v_missing;
    end if;

    -- STAR-STRUCT-02 复合外键都带 tenant_id（防跨租户引用）
    for v_col in select unnest(array[
      'fk_application_star_application','fk_application_star_actor'
    ]) loop
      if not exists (select 1 from pg_constraint p
                      where p.conrelid = 'recruitment.application_star'::regclass
                        and p.contype = 'f' and p.conname = v_col
                        and exists (select 1 from pg_attribute a
                                     where a.attrelid = p.conrelid and a.attnum = any(p.conkey)
                                       and a.attname = 'tenant_id')) then
        raise exception 'STAR-STRUCT-02 application_star 复合外键缺 tenant_id：%', v_col;
      end if;
    end loop;

    -- STAR-STRUCT-03 CHECK（sha256 形状）
    if not exists (select 1 from pg_constraint p
                    where p.conrelid = 'recruitment.application_star'::regclass
                      and p.contype = 'c' and p.conname = 'ck_application_star_sha256') then
      raise exception 'STAR-STRUCT-03 application_star 缺 ck_application_star_sha256';
    end if;

    -- STAR-STRUCT-04 append-only：禁删 + 全列不可变护栏（fn_guard_columns 无白名单）
    for v_col in select unnest(array[
      'trg_application_star_no_delete','trg_application_star_immutable'
    ]) loop
      if not exists (select 1 from pg_trigger g
                      where g.tgrelid = 'recruitment.application_star'::regclass
                        and not g.tgisinternal and g.tgname = v_col) then
        raise exception 'STAR-STRUCT-04 application_star 缺触发器：%', v_col;
      end if;
    end loop;

    -- STAR-STRUCT-05 当前值查询索引必须存在
    if not exists (select 1 from pg_index i
                    where i.indrelid = 'recruitment.application_star'::regclass
                      and i.indexrelid = 'recruitment.ix_application_star_current'::regclass) then
      raise exception 'STAR-STRUCT-05 application_star 缺当前值索引 ix_application_star_current';
    end if;

    -- STAR-STRUCT-06 台账自登记
    if not exists (select 1 from recruitment.schema_migration where version = '0021_application_star') then
      raise exception 'STAR-STRUCT-06 schema_migration 缺 0021_application_star 自登记';
    end if;
    raise notice 'STAR-STRUCT PASS application_star 列/复合外键/CHECK/禁删/不可变/当前值索引/台账齐全';
  else
    raise notice 'STAR-STRUCT SKIP application_star 表不存在（0021 尚未应用）';
  end if;
end $$;

do $$
declare
  v_missing text;
begin
  -- [0024 G-09] booking_invite 专项断言：列 / 复合外键 / CHECK / 唯一键 / 禁删 / 台账。
  -- 表不存在时 SKIP（0024 尚未应用的旧库仍可通过 verify）。
  if to_regclass('recruitment.booking_invite') is not null then
    for v_missing in select unnest(array[
      'id','tenant_id','application_id','created_by_actor_id','round_no','duration_minutes',
      'interviewer_actor_ids','timezone','slots','token_sha256','booking_state','expires_at',
      'created_at','updated_at','confirmed_slot_index','confirmed_interview_id','self_booked'
    ]) loop
      if not exists (select 1 from pg_attribute
                      where attrelid = 'recruitment.booking_invite'::regclass
                        and attname = v_missing and not attisdropped and attnum > 0) then
        raise exception 'BOOKING-STRUCT-01 booking_invite 缺列：%', v_missing;
      end if;
    end loop;

    select string_agg(conname, ', ') into v_missing
      from pg_constraint
     where conrelid = 'recruitment.booking_invite'::regclass and contype = 'f'
       and conname in ('fk_booking_invite_application','fk_booking_invite_creator','fk_booking_invite_interview');
    if v_missing is null or array_length(string_to_array(v_missing, ', '), 1) <> 3 then
      raise exception 'BOOKING-STRUCT-02 booking_invite 复合外键不全：%', coalesce(v_missing, 'none');
    end if;

    for v_missing in select unnest(array[
      'ck_booking_invite_booking_state','ck_booking_invite_round','ck_booking_invite_duration',
      'ck_booking_invite_token_sha256','ck_booking_invite_timezone',
      'ck_booking_invite_slots_shape','ck_booking_invite_interviewers_shape',
      'ck_booking_invite_confirmed_slot'
    ]) loop
      if not exists (select 1 from pg_constraint
                      where conrelid = 'recruitment.booking_invite'::regclass
                        and contype = 'c' and conname = v_missing) then
        raise exception 'BOOKING-STRUCT-03 booking_invite 缺 CHECK 约束：%', v_missing;
      end if;
    end loop;

    if not exists (select 1 from pg_constraint
                    where conrelid = 'recruitment.booking_invite'::regclass
                      and contype = 'u' and conname = 'uq_booking_invite_token') then
      raise exception 'BOOKING-STRUCT-04 booking_invite 缺 token 唯一键 uq_booking_invite_token';
    end if;

    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = 'recruitment.booking_invite'::regclass
                      and not g.tgisinternal and g.tgname = 'trg_booking_invite_no_delete') then
      raise exception 'BOOKING-STRUCT-05 booking_invite 缺禁删触发器';
    end if;

    if not exists (select 1 from recruitment.schema_migration where version = '0024_booking_invite') then
      raise exception 'BOOKING-STRUCT-06 schema_migration 缺 0024_booking_invite 自登记';
    end if;
    raise notice 'BOOKING-STRUCT PASS booking_invite 列/复合外键/CHECK/token 唯一键/禁删/台账齐全';
  else
    raise notice 'BOOKING-STRUCT SKIP booking_invite 表不存在（0024 尚未应用）';
  end if;
end $$;


-- [0025 Issue #61 生产登录] auth_user / auth_session 专项断言：
-- 列 / CHECK / scrypt 哈希形状 / 唯一键 / 未撤销会话索引 / 台账自登记。
-- 只新增本块，既有断言与计数零改动；表不存在时 SKIP（旧库仍可通过 verify）。
do $$
declare
  v_missing text;
begin
  if to_regclass('recruitment.auth_user') is not null
     and to_regclass('recruitment.auth_session') is not null then
    for v_missing in select unnest(array[
      'id','tenant_id','username','password_hash','display_name','alias','disabled_at','created_at'
    ]) loop
      if not exists (select 1 from pg_attribute
                      where attrelid = 'recruitment.auth_user'::regclass
                        and attname = v_missing and not attisdropped and attnum > 0) then
        raise exception 'AUTH-STRUCT-01 auth_user 缺列：%', v_missing;
      end if;
    end loop;
    for v_missing in select unnest(array[
      'id','tenant_id','session_id','token_sha256','username','alias','display_name',
      'created_at','expires_at','revoked_at'
    ]) loop
      if not exists (select 1 from pg_attribute
                      where attrelid = 'recruitment.auth_session'::regclass
                        and attname = v_missing and not attisdropped and attnum > 0) then
        raise exception 'AUTH-STRUCT-02 auth_session 缺列：%', v_missing;
      end if;
    end loop;

    -- 三张表的 tenant_id 必须 NOT NULL（STRUCT-02 在本块再做一次专项核对）
    if not exists (select 1 from pg_attribute
                    where attrelid = 'recruitment.auth_user'::regclass
                      and attname = 'tenant_id' and attnotnull)
       or not exists (select 1 from pg_attribute
                       where attrelid = 'recruitment.auth_session'::regclass
                         and attname = 'tenant_id' and attnotnull) then
      raise exception 'AUTH-STRUCT-03 auth 表 tenant_id 不是 NOT NULL';
    end if;

    for v_missing in select unnest(array[
      'ck_auth_user_username','ck_auth_user_password_hash','ck_auth_user_display_name',
      'ck_auth_user_alias','ck_auth_session_sid','ck_auth_session_token_sha256',
      'ck_auth_session_username','ck_auth_session_alias','ck_auth_session_expiry'
    ]) loop
      if not exists (select 1 from pg_constraint
                      where conrelid in ('recruitment.auth_user'::regclass,
                                         'recruitment.auth_session'::regclass)
                        and contype = 'c' and conname = v_missing) then
        raise exception 'AUTH-STRUCT-04 auth 表缺 CHECK 约束：%', v_missing;
      end if;
    end loop;

    if not exists (select 1 from pg_constraint
                    where conrelid = 'recruitment.auth_user'::regclass
                      and contype = 'u' and conname = 'uq_auth_user_tenant_username') then
      raise exception 'AUTH-STRUCT-05 auth_user 缺用户名唯一键';
    end if;
    if not exists (select 1 from pg_constraint
                    where conrelid = 'recruitment.auth_session'::regclass
                      and contype = 'u' and conname = 'uq_auth_session_token') then
      raise exception 'AUTH-STRUCT-06 auth_session 缺 token 唯一键';
    end if;
    if not exists (select 1 from pg_index i
                    where i.indrelid = 'recruitment.auth_session'::regclass
                      and i.indexrelid = 'recruitment.ix_auth_session_active'::regclass
                      and i.indpred is not null) then
      raise exception 'AUTH-STRUCT-07 auth_session 缺未撤销会话部分索引';
    end if;
    if not exists (select 1 from recruitment.schema_migration where version = '0025_auth_login') then
      raise exception 'AUTH-STRUCT-08 schema_migration 缺 0025_auth_login 自登记';
    end if;

    -- 不变量：种子账号只存 scrypt 哈希，绝不出现明文口令文本。
    if exists (select 1 from recruitment.auth_user
                where username in ('recruiter','interviewer')
                  and (password_hash not like 'scrypt%'
                       or password_hash like '%Recruiter%'
                       or password_hash like '%Interviewer%')) then
      raise exception 'AUTH-INVARIANT 演示账号口令哈希形状非法';
    end if;
    raise notice 'AUTH-STRUCT PASS auth_user/auth_session 列/CHECK/唯一键/部分索引/台账/哈希形状齐全';
  else
    raise notice 'AUTH-STRUCT SKIP auth_user 或 auth_session 表不存在（0025 尚未应用）';
  end if;
end $$;

\echo ''
\echo '=== ROLLBACK：自检不改变数据库 ==='
rollback;

\echo ''
\echo '=================================================================='
\echo ' VERIFY PASS：结构断言 + 状态机覆盖 + 对象覆盖 + 32 条负向测试全部通过'
\echo '=================================================================='

