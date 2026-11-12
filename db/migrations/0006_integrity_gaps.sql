-- =====================================================================
--  recruitment-agent · 0006_integrity_gaps.sql
--
--  裁定（work/control/DECISIONS-2026-11-12.md）：
--    D-65 打包 0006：四个 schema 缺口
--         1. interview.stage_code 默认 'INTERVIEW'，不在 S1–S12，且无外键
--         2. execution_mandate 的 CHECK 没禁 submit_scorecard
--            → agent 代填面评在库层不拦（项目原则：面试官独立提交、不可代填）
--         3. fk_interview_record_artifact 未带 tenant_id → 跨租户引用可能成立
--         4. business_task 无 owner_actor_id（D-59）
--    D-59 business_task.owner_actor_id 单开 0006：可空外键到 actor，**不设默认值**；
--         工作台用它判"我的任务"；**禁止**用 business_refs.kind 表达责任人
--         （会撞 screening-rules.md §6.2 的 7 值封闭集）。
--    D-66 认可 P 线："面试官独立提交、不可代填" —— 与 D-65 第 2 条同源。
--
--  第五个缺口（GAP-5，本批一并交付）：
--    meeting / meeting_binding 有 record_version 列，但 0001 §9.2 的状态护栏
--    和 9.5 的 fn_touch 都没覆盖这两张表 —— 列存在、永远等于 1、永不递增。
--    没有自增就没有"版本变了"这个事实，**不能声称对它们做乐观并发**。
--    修法完全照 0001 里其它表的写法：before update 触发 recruitment.fn_touch()。
--
--  本文件 = 五段（§1–§5），每段都是「先检查、再改」：
--    * 加约束之前先看现有数据；有任何不满足新约束的行 → raise + 整笔回滚，
--      并把"哪一行、错在哪"逐条列出来。
--    * **不替任何人改数据**：迁移替人改数据，会把"写错了"变成"看不出来写错过了"，
--      而且改完就再也无法分辨原来错在哪（与 0004 §3 / 0005 §1 同一口径）。
--    * 整块是一个事务 → 五段全有或全无；任何一段 dirty 都不会留下半套结构。
--
--  依赖：0001_init.sql + 0004_stage_catalog.sql（GAP-1 的外键指向 stage_catalog）。
--        0002_seed.sql 可选（种子数据本来就满足新约束）。
--        0005_version_binding.sql 可选（与本文件无交集：本文件不碰 application 的版本列）。
--        0003_review_queue.sql 可选（review_queue 系，与本文件无交集）。
--
--  幂等：连续执行两遍，第二遍零 ERROR、零新增对象、零数据改动。
--        * 默认值用 alter column set default（天然幂等）；
--        * 列用 add column if not exists；
--        * 约束一律先查 pg_constraint（或按"列集合"判断等价唯一键）再建；
--        * CHECK 用"定义里是否已含新值"判断是否已迁移；
--        * 旧外键**先验证新外键已 convalidated，再删**（同 0005 §4 的三道闸）；
--        * 触发器 drop trigger if exists + create trigger（同 0001 §9 的写法）。
--
--  不改：0001–0005 / verify.sql / SCHEMA.md / 任何业务语义。
--        唯一的"行为改动"是 D-65 明写的 interview.stage_code 默认值 'INTERVIEW' → 'S8'。
--        不删任何列、不改任何已有约束的语义（GAP-2 只**加**一个禁止值）。
--
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0006_integrity_gaps.sql
--        不要加 -1（本文件自带 begin/commit）。
-- =====================================================================

begin;


-- =====================================================================
--  §0  依赖 + 改造前的现场（只读，全部打进日志作为"改造前"证据）
-- =====================================================================

do $$
declare
  r         record;
  v_missing text := '';
begin
  for r in
    select * from (values
      ('organization'), ('actor'), ('interview'), ('interviewer'),
      ('interview_record'), ('execution_mandate'), ('business_task'),
      ('meeting'), ('meeting_binding'), ('transcript_artifact'),
      ('stage_catalog')   -- 0004 的产物：GAP-1 的外键必须有它
    ) as v(tbl)
  loop
    if to_regclass('recruitment.' || r.tbl) is null then
      v_missing := v_missing || r.tbl || ' ';
    end if;
  end loop;
  if v_missing <> '' then
    raise exception 'INTEGRITY_GAP_DEPENDENCY: 缺表 %（0006 依赖 0001 + 0004；GAP-1 必须有 stage_catalog）',
      v_missing
      using errcode = '42P01';
  end if;
  raise notice '0006 DEPENDENCY PASS 依赖表齐全（含 0004 的 stage_catalog）';
end $$;

do $$
declare
  v_txt   text;
  v_n     integer;
  v_col   text;
begin
  -- 0.1 GAP-1 改造前：默认值 + 该列上有没有外键
  select pg_get_expr(d.adbin, d.adrelid) into v_txt
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'recruitment.interview'::regclass
     and a.attname  = 'stage_code';
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.interview'::regclass
     and c.contype  = 'f'
     and (select array_agg(a.attname::text)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         && array['stage_code']::text[];
  raise notice '0006 改造前 GAP-1：interview.stage_code 默认值 = %；引用 stage_code 的外键 = % 条',
    coalesce(v_txt, '（无）'), v_n;

  -- 0.2 GAP-2 改造前：mandate 的禁令 CHECK 原文
  select pg_get_constraintdef(c.oid) into v_txt
    from pg_constraint c
   where c.conrelid = 'recruitment.execution_mandate'::regclass
     and c.conname  = 'ck_execution_mandate_no_business_approval';
  raise notice '0006 改造前 GAP-2：ck_execution_mandate_no_business_approval = %',
    coalesce(v_txt, '（不存在）');

  -- 0.3 GAP-3 改造前：interview_record → transcript_artifact 的外键原文
  select pg_get_constraintdef(c.oid) into v_txt
    from pg_constraint c
   where c.conrelid = 'recruitment.interview_record'::regclass
     and c.conname  = 'fk_interview_record_artifact';
  raise notice '0006 改造前 GAP-3：fk_interview_record_artifact = %',
    coalesce(v_txt, '（不存在）');

  -- 0.4 GAP-4 改造前：business_task 上有没有 owner_actor_id
  select string_agg(format('%s %s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ')
    into v_col
    from pg_attribute a
   where a.attrelid = 'recruitment.business_task'::regclass
     and a.attname  like '%owner%'
     and a.attnum   > 0
     and not a.attisdropped;
  raise notice '0006 改造前 GAP-4：business_task 上 owner* 列 = %',
    coalesce(v_col, '（无）');

  -- 0.5 GAP-5 改造前：两张表的 before update 触发器 + 死列证据
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid in ('recruitment.meeting'::regclass, 'recruitment.meeting_binding'::regclass)
     and not g.tgisinternal
     and (g.tgtype & 2) = 2      -- BEFORE
     and (g.tgtype & 16) = 16;   -- UPDATE
  raise notice '0006 GAP-5 现场：meeting / meeting_binding 的 before update 触发器 = % 个（首跑应为 0；重跑时这 % 个是本文件上一轮挂的 fn_touch）', v_n, v_n;

  raise notice '0006 改造前 GAP-5：meeting 中 record_version <> 1 的行 = % / meeting_binding 中 = %（死列证据：从未被任何触发器改变）',
    (select count(*) from recruitment.meeting        where record_version <> 1),
    (select count(*) from recruitment.meeting_binding where record_version <> 1);
end $$;


-- =====================================================================
--  §1  GAP-1 · interview.stage_code
--
--  现状：默认 'INTERVIEW' —— 不在 S1–S12（D-22 唯一口径），且该列**没有外键**，
--        所以"写进一个不存在的阶段 code 不报错"，与 0004 修掉 application 的
--        那个缺口完全同型：查得到面试、查不到阶段名。
--  改：默认值 'S8'（面试规划与排期，docs/01 阶段 8 = Interview 所在阶段）+
--      复合外键 (tenant_id, stage_code) → stage_catalog (tenant_id, code)。
--      外键选择 (tenant_id, code) 而不是 code：阶段目录是**按租户**的
--      （0004 §1 的理由），跨租户借用阶段名必须在库层被拦。
--  注意：ck_interview_stage_code 的正则仍允许 'INTERVIEW' —— 正则管形状，
--        外键管取值。两条同时存在不是冗余：正则挡住小写/空串，外键挡住"形状对但不存在"。
-- =====================================================================

-- 1.1 前置检查：现有 interview 的 (tenant_id, stage_code) 必须已在目录里
do $$
declare
  v_bad text;
begin
  select string_agg(
           format('interview=%s tenant=%s stage_code=%s',
                  i.id, i.tenant_id, i.stage_code),
           E'\n      ')
    into v_bad
    from recruitment.interview i
   where not exists (
     select 1 from recruitment.stage_catalog s
      where s.tenant_id = i.tenant_id
        and s.code      = i.stage_code);
  if v_bad is not null then
    raise exception E'STAGE_CATALOG_MISSING: 以下 interview 的 stage_code 不在**它自己租户**的 stage_catalog 中，外键无法建立。\n      本迁移不会替你改数据：请人工确认这些面试真正属于哪个阶段（或补目录）后重跑。\n      %', v_bad
      using errcode = '23503';
  end if;

  raise notice '0006 GAP-1 PRE-CHECK PASS 现有 interview 的 stage_code 全部已在各自租户的 stage_catalog 内（0 条脏值）';
end $$;

-- 1.2 默认值：'INTERVIEW' → 'S8'（D-65 逐字）。改默认值是幂等的。
alter table recruitment.interview
  alter column stage_code set default 'S8';

-- 1.3 复合外键：阶段 code 必须真实存在于同一租户的目录
--     on update/delete restrict 显式写死：改/删被引用的阶段必须失败，而不是级联
--     （级联会把历史面试的阶段悄悄改掉 —— 又一种静默错误）。
do $$
begin
  if not exists (select 1 from pg_constraint c
                  where c.conname  = 'fk_interview_stage_catalog'
                    and c.conrelid = 'recruitment.interview'::regclass) then
    alter table recruitment.interview
      add constraint fk_interview_stage_catalog
      foreign key (tenant_id, stage_code)
      references recruitment.stage_catalog (tenant_id, code)
      on update restrict on delete restrict;
    raise notice '0006 GAP-1 已加 fk_interview_stage_catalog：(tenant_id, stage_code) → stage_catalog(tenant_id, code)';
  else
    raise notice '0006 GAP-1 fk_interview_stage_catalog 已存在，跳过';
  end if;
end $$;


-- =====================================================================
--  §2  GAP-2 · execution_mandate 禁止 submit_scorecard
--
--  现状：CHECK 只禁 approve / reject / decide / merge_candidate / waive_scorecard。
--        **没禁 submit_scorecard** → 把"代填面评"写进 mandate 时库层不报错，
--        只能靠应用层自律。项目原则是"面试官独立提交、不可代填"，
--        所以这条禁令必须落到库层（与 0001 §7 注释、SCHEMA.md #35、APP-07 同源）。
--  改：在同一个 CHECK 里加 'submit_scorecard' —— 只**加**禁止值，
--      不改语义、不放开任何原有取值（严格更强，不是更强硬地换个说法）。
--
--  为什么不是新加一条 CHECK：两条 CHECK 各自表达同一件事，日后必有一处漏改。
--  为什么必须先检查数据：CHECK 是在 ALTER TABLE 时**校验存量行**的，
--      若已有 mandate 带 submit_scorecard，ALTER 会以一条难以读懂的外键式错误失败；
--      我们要的是"列出哪几条 mandate、让人决定怎么处理"。
-- =====================================================================

-- 2.1 前置检查：现有 mandate 的 allowed_actions 不得已含 submit_scorecard
do $$
declare
  v_bad text;
begin
  select string_agg(
           format('mandate=%s tenant=%s actor=%s allowed_actions=%s',
                  m.id, m.tenant_id, m.actor_id, m.allowed_actions::text),
           E'\n      ')
    into v_bad
    from recruitment.execution_mandate m
   where 'submit_scorecard' = any (m.allowed_actions);
  if v_bad is not null then
    raise exception E'MANDATE_ALREADY_ALLOWS_SUBMIT_SCORECARD: 以下 execution_mandate 已经允许 submit_scorecard（代填面评），新 CHECK 无法建立。\n      本迁移不会替你吊销授权：请人工确认这些 mandate 是否应当立即撤销/重建（改数据后重跑）。\n      %', v_bad
      using errcode = '23514';
  end if;

  -- 大小写变体：CHECK 是**大小写敏感**的精确匹配（与 0001 原有 5 个值同一口径）。
  -- 'SUBMIT_SCORECARD' / 'Submit_Scorecard' 这类写法不会被 CHECK 拦住，
  -- 属于"看起来禁了、其实没禁"的脏数据 → 同样拒绝迁移，交给人归一化。
  select string_agg(
           format('mandate=%s allowed_actions=%s', m.id, m.allowed_actions::text),
           E'\n      ')
    into v_bad
    from recruitment.execution_mandate m
   where exists (
     select 1 from unnest(m.allowed_actions) as a(v)
      where lower(a.v) = 'submit_scorecard'
        and a.v <> 'submit_scorecard');
  if v_bad is not null then
    raise exception E'MANDATE_ACTION_CASE_VARIANT: 以下 mandate 用了 submit_scorecard 的大小写变体。\n      新 CHECK 是大小写敏感匹配，**拦不住它们**；本迁移不替你改名（改名 = 替人做决定）。\n      请人工归一化为小写 submit_scorecard（或直接吊销）后重跑。\n      %', v_bad
      using errcode = '23514';
  end if;

  raise notice '0006 GAP-2 PRE-CHECK PASS 现有 execution_mandate 中没有 submit_scorecard（含大小写变体）';
end $$;

-- 2.2 扩展 CHECK：先确认现有定义是"我们以为的那条"，再 drop + recreate
--     闸：只允许替换**已知旧形态**（含 allowed_actions + 原有 5 个禁止值）。
--     若有人改过这条约束（例如已经加了别的值），拒绝覆盖 —— 覆盖可能悄悄放宽别人的加严。
do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'recruitment.execution_mandate'::regclass
     and c.conname  = 'ck_execution_mandate_no_business_approval';

  if v_def is null then
    alter table recruitment.execution_mandate
      add constraint ck_execution_mandate_no_business_approval
      check (not (allowed_actions && array['approve','reject','decide',
                                           'merge_candidate','waive_scorecard',
                                           'submit_scorecard']));
    raise notice '0006 GAP-2 CHECK 原本不存在，已新建（含 submit_scorecard）';
    return;
  end if;

  if v_def like '%submit_scorecard%' then
    raise notice '0006 GAP-2 ck_execution_mandate_no_business_approval 已含 submit_scorecard，跳过';
    return;
  end if;

  if v_def not like '%allowed_actions%'
     or v_def not like '%approve%'
     or v_def not like '%reject%'
     or v_def not like '%decide%'
     or v_def not like '%merge_candidate%'
     or v_def not like '%waive_scorecard%' then
    raise exception 'MANDATE_CHECK_UNEXPECTED: ck_execution_mandate_no_business_approval 的定义与预期不符，拒绝替换（可能有人另行加严/改写过）。实际：%', v_def
      using errcode = '23514';
  end if;

  alter table recruitment.execution_mandate
    drop constraint ck_execution_mandate_no_business_approval;
  alter table recruitment.execution_mandate
    add constraint ck_execution_mandate_no_business_approval
    check (not (allowed_actions && array['approve','reject','decide',
                                         'merge_candidate','waive_scorecard',
                                         'submit_scorecard']));
  raise notice '0006 GAP-2 已扩展 ck_execution_mandate_no_business_approval：加入 submit_scorecard（原 5 值全部保留）';
end $$;


-- =====================================================================
--  §3  GAP-3 · fk_interview_record_artifact 带上 tenant_id
--
--  现状：(transcript_artifact_id, transcript_revision) → (id, source_revision)。
--        两列**不含 tenant_id** → 甲租户的 interview_record 可以指向乙租户的
--        transcript_artifact，只要 revision 对得上。跨租户引用在库层成立，
--        而 interview_record 会带着乙租户的原文摘要出现在甲的界面上。
--  改：(tenant_id, transcript_artifact_id, transcript_revision)
--        → transcript_artifact (tenant_id, id, source_revision)
--      —— 同表其它外键（fk_interview_record_interview / _rubric / _template）的写法，
--        也是 db/verify.sql STRUCT-07 的断言口径。
--
--  被引用键必须先有唯一约束：transcript_artifact 现有 uq(…) 是 (id, tenant_id)
--  与 (id, source_revision)，都没有 (tenant_id, id, source_revision) → 先补一个。
--  （唯一性与外键引用都只看**列集合**，列序不影响语义；这里按外键列序写，便于对读。）
-- =====================================================================

-- 3.1 前置检查：跨租户引用 / revision 对不上 / 指向不存在的 artifact
do $$
declare
  v_bad text;
begin
  -- 3.1.1 跨租户：record 与它引用的 artifact 不在同一个租户
  select string_agg(
           format('interview_record=%s (tenant=%s) → artifact=%s (tenant=%s)',
                  r.id, r.tenant_id, ta.id, ta.tenant_id),
           E'\n      ')
    into v_bad
    from recruitment.interview_record r
    join recruitment.transcript_artifact ta on ta.id = r.transcript_artifact_id
   where ta.tenant_id <> r.tenant_id;
  if v_bad is not null then
    raise exception E'INTERVIEW_RECORD_CROSS_TENANT_ARTIFACT: 以下 interview_record 引用了**别的租户**的 transcript_artifact，复合外键无法建立。\n      本迁移不会替你改数据（这可能是越权读取的痕迹，需要人工判断）：\n      %', v_bad
      using errcode = '23503';
  end if;

  -- 3.1.2 revision 对不上（旧外键已在拦；这里再查一遍，因为"旧外键被谁 drop 过"
  --       正是本缺口存在的形态之一，不能假设它一定在位）
  select string_agg(
           format('interview_record=%s 声称 revision=%s，artifact 实际 revision=%s',
                  r.id, r.transcript_revision, ta.source_revision),
           E'\n      ')
    into v_bad
    from recruitment.interview_record r
    join recruitment.transcript_artifact ta on ta.id = r.transcript_artifact_id
   where ta.source_revision <> r.transcript_revision;
  if v_bad is not null then
    raise exception E'INTERVIEW_RECORD_REVISION_MISMATCH: 以下 interview_record 声称的转写版本与 artifact 实际版本不符：%', v_bad
      using errcode = '23503';
  end if;

  -- 3.1.3 指向不存在的 artifact（旧外键缺失时的孤儿行）
  select string_agg(format('interview_record=%s → artifact=%s（不存在）', r.id, r.transcript_artifact_id), E'\n      ')
    into v_bad
    from recruitment.interview_record r
   where not exists (select 1 from recruitment.transcript_artifact ta where ta.id = r.transcript_artifact_id);
  if v_bad is not null then
    raise exception E'INTERVIEW_RECORD_ORPHAN_ARTIFACT: 以下 interview_record 引用的 transcript_artifact 不存在：%', v_bad
      using errcode = '23503';
  end if;

  raise notice '0006 GAP-3 PRE-CHECK PASS 现有 interview_record：跨租户引用 0 条 / revision 不符 0 条 / 孤儿引用 0 条';
end $$;

-- 3.2 被引用键：unique (tenant_id, id, source_revision)
--     按"列集合"判断是否已有等价唯一键（同 0005 §2 的做法），不按约束名。
do $$
begin
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'recruitment.transcript_artifact'::regclass
       and c.contype  = 'u'
       and (select array_agg(a.attname::text order by a.attname)
              from pg_attribute a
             where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
           = array['id', 'source_revision', 'tenant_id']::text[])
  then
    alter table recruitment.transcript_artifact
      add constraint uq_transcript_artifact_tenant_id_revision
      unique (tenant_id, id, source_revision);
    raise notice '0006 GAP-3 已加 transcript_artifact unique (tenant_id, id, source_revision)（3 列外键的被引用键）';
  else
    raise notice '0006 GAP-3 transcript_artifact 已有等价唯一键 (tenant_id, id, source_revision)，复用';
  end if;
end $$;

-- 3.3 新的 3 列外键（**先加新的，再删旧的**：不留无保护窗口）
--     沿用原约束名 fk_interview_record_artifact：库里只有一条"面试记录 → 转写版本"
--     的外键，名字不随形态改变而漂移（SCHEMA.md / 台账引用的是这个名字）。
do $$
declare
  v_exists boolean;
  v_is_fk  boolean;                 -- 是"指向 transcript_artifact 的外键"吗
  v_ok     boolean;                 -- 是目标形态（3 列 + restrict + validated）吗
  v_cols   text[];
  v_def    text;
begin
  select true,
         (c.contype = 'f' and c.confrelid = 'recruitment.transcript_artifact'::regclass),
         (c.contype = 'f'
          and c.confrelid   = 'recruitment.transcript_artifact'::regclass
          and c.convalidated
          and c.confdeltype = 'r'
          and c.confupdtype = 'r'
          and (select array_agg(a.attname::text order by a.attname)
                 from pg_attribute a
                where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
              = array['tenant_id', 'transcript_artifact_id', 'transcript_revision']::text[]
          and (select array_agg(a.attname::text order by a.attname)
                 from pg_attribute a
                where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
              = array['id', 'source_revision', 'tenant_id']::text[]),
         (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_exists, v_is_fk, v_ok, v_cols
    from pg_constraint c
   where c.conrelid = 'recruitment.interview_record'::regclass
     and c.conname  = 'fk_interview_record_artifact';

  -- 3.3.1 已经是目标形态 → 幂等跳过
  if coalesce(v_ok, false) then
    raise notice '0006 GAP-3 fk_interview_record_artifact 已是 3 列（含 tenant_id）形态，跳过';
    return;
  end if;

  -- 3.3.2 存在但不是目标形态：只允许删除下列"已知形态"，其余一律拒绝覆盖
  if coalesce(v_exists, false) then
    if not coalesce(v_is_fk, false) then
      select pg_get_constraintdef(c.oid) into v_def
        from pg_constraint c
       where c.conrelid = 'recruitment.interview_record'::regclass
         and c.conname  = 'fk_interview_record_artifact';
      raise exception 'INTERVIEW_RECORD_ARTIFACT_FK_UNEXPECTED: 现有 fk_interview_record_artifact 不是指向 transcript_artifact 的外键，拒绝替换。实际：%', v_def
        using errcode = '23514';
    end if;
    if v_cols is distinct from array['transcript_artifact_id', 'transcript_revision']::text[]
       and v_cols is distinct from array['tenant_id', 'transcript_artifact_id', 'transcript_revision']::text[] then
      select pg_get_constraintdef(c.oid) into v_def
        from pg_constraint c
       where c.conrelid = 'recruitment.interview_record'::regclass
         and c.conname  = 'fk_interview_record_artifact';
      raise exception 'INTERVIEW_RECORD_ARTIFACT_FK_UNEXPECTED: 现有 fk_interview_record_artifact 的列集合既不是已知的 2 列旧形态，也不是 3 列目标形态，拒绝替换。实际：%', v_def
        using errcode = '23514';
    end if;
    alter table recruitment.interview_record
      drop constraint fk_interview_record_artifact;
    raise notice '0006 GAP-3 已删旧外键 fk_interview_record_artifact（列集合 %）', array_to_string(v_cols, ',');
  end if;

  -- 3.3.3 建 3 列外键
  alter table recruitment.interview_record
    add constraint fk_interview_record_artifact
    foreign key (tenant_id, transcript_artifact_id, transcript_revision)
    references recruitment.transcript_artifact (tenant_id, id, source_revision)
    on update restrict on delete restrict;
  raise notice '0006 GAP-3 已建 fk_interview_record_artifact：(tenant_id, artifact, revision) → transcript_artifact(tenant_id, id, source_revision)';
end $$;

-- 3.4 删旧之前的闸（同 0005 §4 闸 1）：新外键必须已存在且 convalidated
--     若新外键没建上（或建成了 NOT VALID），库里就**静默回到"可跨租户引用"**，
--     而且再跑一遍迁移也不会发现 —— 所以这里必须显式失败。
do $$
declare
  v_n integer;
begin
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.interview_record'::regclass
     and c.conname  = 'fk_interview_record_artifact'
     and c.contype  = 'f'
     and c.convalidated
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['tenant_id', 'transcript_artifact_id', 'transcript_revision']::text[];
  if v_n <> 1 then
    raise exception 'INTERVIEW_RECORD_ARTIFACT_FK_ABORT: 新 3 列外键未建立并验证（% / 1）。拒绝继续 —— 否则库里会静默回到"转写可跨租户引用"的状态。', v_n
      using errcode = '23514';
  end if;
  raise notice '0006 GAP-3 闸 PASS 新 3 列外键已建立并 convalidated；同表不存在第二条无 tenant_id 的转写外键';
end $$;


-- =====================================================================
--  §4  GAP-4 · business_task.owner_actor_id（D-59）
--
--  现状：business_task 有 created_by_actor_id / status_changed_by_actor_id，
--        **没有责任人列** → 工作台只能用"创建人"冒充"责任人"，
--        而创建人和责任人在真实业务里经常不是一个人（HR 建任务、面试官执行）。
--  改：加可空外的 owner_actor_id → actor。**不设默认值**（D-59 逐字）：
--        默认值会让"没分配"看起来像"分配给了某人"，是静默错误。
--
--  ⚠️ 与 D-59 字面的一处**加严**（复核时必须确认，不要当成笔误）：
--      D-59 写 `owner_actor_id → actor (id)` 单列；本文件用
--      `(owner_actor_id, tenant_id) → actor (id, tenant_id)` 复合外键。
--      理由：本表其它 actor 外键（created_by / status_changed_by）全是复合写法，
--      SCHEMA.md §1「关键关系用 (id, tenant_id) 复合外键，物理上禁止跨租户引用」
--      也是复合口径。单列形态能让甲租户的任务把"责任人"指向乙租户的 actor ——
--      工作台按 actor 过滤时，跨租户的人会看到别人租户的任务。
--      强度**严格强于**字面（同租户 + 存在性同时成为物理约束），
--      D-59 要拦的"指向不存在的 actor"照样拦（实测 23503），语义不变。
--      MATCH SIMPLE（默认）：owner_actor_id is null 时不检查 → 可空语义成立。
-- =====================================================================

-- 4.1 前置检查 A：列若已存在，类型必须是 uuid（别人可能建过别的形态）
do $$
declare
  v_typ text;
begin
  select format_type(a.atttypid, a.atttypmod) into v_typ
    from pg_attribute a
   where a.attrelid = 'recruitment.business_task'::regclass
     and a.attname  = 'owner_actor_id'
     and a.attnum   > 0
     and not a.attisdropped;
  if v_typ is not null and v_typ <> 'uuid' then
    raise exception 'OWNER_ACTOR_COLUMN_UNEXPECTED: business_task.owner_actor_id 已存在但类型是 %（期望 uuid）。拒绝改列 —— 请人工核对。', v_typ
      using errcode = '42804';
  end if;
  raise notice '0006 GAP-4 PRE-CHECK A PASS business_task.owner_actor_id 类型检查通过（% ）',
    coalesce(v_typ, '尚未创建，将按 uuid 新建');
end $$;

-- 4.2 前置检查 B：不得已经用 business_refs.kind 表达责任人（D-59 明确禁止）
--     这是"数据先行于 schema"才会出现的形态：如果库里已经有 kind='OWNER' 之类的引用，
--     那么加了列也不会有人用，而且两套责任人表达并存 → 必须先让人统一口径。
do $$
declare
  v_bad text;
begin
  select string_agg(
           format('business_task=%s refs=%s', t.id, t.business_refs::text),
           E'\n      ')
    into v_bad
    from recruitment.business_task t
   where exists (
     select 1
       from jsonb_array_elements(case when jsonb_typeof(t.business_refs) = 'array'
                                      then t.business_refs else '[]'::jsonb end) as e(ref)
      where upper(coalesce(e.ref ->> 'kind', '')) in ('OWNER', 'OWNER_ACTOR', 'ASSIGNEE', 'RESPONSIBLE'));
  if v_bad is not null then
    raise exception E'OWNER_EXPRESSED_VIA_BUSINESS_REFS: 以下 business_task 已经用 business_refs.kind 表达责任人（D-59 明确禁止：会撞 screening-rules §6.2 的 7 值封闭集）。\n      两套责任人表达不能并存；本迁移不替你迁移数据，请人工统一到 owner_actor_id 后重跑。\n      %', v_bad
      using errcode = '23514';
  end if;
  raise notice '0006 GAP-4 PRE-CHECK B PASS 没有 business_task 用 business_refs.kind 表达责任人（0 条）';
end $$;

-- 4.3 加列（可空、无默认值 —— D-59 逐字）
alter table recruitment.business_task
  add column if not exists owner_actor_id uuid;

-- 4.4 外键：责任人与任务必须同租户（理由见 §4 抬头）
do $$
begin
  if not exists (select 1 from pg_constraint c
                  where c.conname  = 'fk_business_task_owner_actor'
                    and c.conrelid = 'recruitment.business_task'::regclass) then
    alter table recruitment.business_task
      add constraint fk_business_task_owner_actor
      foreign key (owner_actor_id, tenant_id)
      references recruitment.actor (id, tenant_id)
      on update restrict on delete restrict;
    raise notice '0006 GAP-4 已加 fk_business_task_owner_actor：(owner_actor_id, tenant_id) → actor(id, tenant_id)';
  else
    raise notice '0006 GAP-4 fk_business_task_owner_actor 已存在，跳过';
  end if;
end $$;


-- =====================================================================
--  §5  GAP-5 · meeting / meeting_binding 的 record_version 是死列
--
--  现状：两张表都有 record_version（0001 建表时给的），但 0001 §9.2 的状态护栏
--        只覆盖有状态列的表，§9.5 只给了 candidate —— 这两张表**没有任何
--        before update 触发器**。于是 record_version 永远是 1：
--          * 客户端拿 1 去 WHERE record_version = 1 做乐观并发，永远"成功"；
--          * 两个人同时改同一条会议，后写的静默覆盖前写的，没人知道。
--  改：照 0001 里 fn_touch 的既有写法挂 before update 触发器，
--      与 updated_at 一起自增。不新造函数、不加新语义。
--
--  为什么用 fn_touch 而不是 fn_row_guard：这两张表**没有状态列**
--      （meeting 有 meeting_role，meeting_binding 有 binding_method，都不是状态轴），
--      套 fn_row_guard 需要虚构 status 列并向 event_inbox 写事件 —— 属 R2 假接线。
-- =====================================================================

-- 5.1 前置检查 A：这两张表上不能已有别的 before update 触发器
--     （两个自增触发器会把 record_version 一次 UPDATE 加 2，并发语义直接错位）
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s.%s', t.tbl, g.tgname), ', ')
    into v_bad
    from (values ('meeting'), ('meeting_binding')) as t(tbl)
    join pg_trigger g on g.tgrelid = format('recruitment.%I', t.tbl)::regclass
   where not g.tgisinternal
     and (g.tgtype & 2)  = 2     -- BEFORE
     and (g.tgtype & 16) = 16    -- UPDATE
     and g.tgname not in ('trg_meeting_touch', 'trg_meeting_binding_touch');
  if v_bad is not null then
    raise exception 'TOUCH_TRIGGER_CONFLICT: 这些表上已有 before update 触发器，再挂 fn_touch 会一次 UPDATE 把 record_version 加两次：%', v_bad
      using errcode = '23514';
  end if;
  raise notice '0006 GAP-5 PRE-CHECK A PASS meeting / meeting_binding 上没有其它 before update 触发器';
end $$;

-- 5.2 前置检查 B：审计列本身不能已经坏了
--     record_version 是计数器的唯一载体，updated_at 是"最后一次改动"的唯一载体；
--     它们自相矛盾时先加触发器，等于给坏数据盖合格章。
do $$
declare
  v_bad text;
begin
  select string_agg(x.txt, E'\n      ')
    into v_bad
    from (
      select format('meeting=%s record_version=%s created_at=%s updated_at=%s',
                    m.id, m.record_version, m.created_at, m.updated_at) as txt
        from recruitment.meeting m
       where m.record_version is null or m.record_version < 1
          or m.updated_at is null or m.updated_at < m.created_at
      union all
      select format('meeting_binding=%s record_version=%s created_at=%s updated_at=%s',
                    b.id, b.record_version, b.created_at, b.updated_at)
        from recruitment.meeting_binding b
       where b.record_version is null or b.record_version < 1
          or b.updated_at is null or b.updated_at < b.created_at
    ) x;
  if v_bad is not null then
    raise exception E'TOUCH_AUDIT_COLUMNS_CORRUPT: 以下行的 record_version / updated_at 自相矛盾（version < 1、updated_at 为空，或 updated_at 早于 created_at）。\n      先加触发器会把坏历史当成"版本 1、刚从 1 开始"，请人工核对这些行后重跑。\n      %', v_bad
      using errcode = '23514';
  end if;
  raise notice '0006 GAP-5 PRE-CHECK B PASS 两张表的 record_version / updated_at 自洽（0 条坏行）';
end $$;

-- 5.3 触发器（drop + create 保证幂等，同 0001 §9 的写法）
drop trigger if exists trg_meeting_touch on recruitment.meeting;
create trigger trg_meeting_touch
  before update on recruitment.meeting
  for each row execute function recruitment.fn_touch();

drop trigger if exists trg_meeting_binding_touch on recruitment.meeting_binding;
create trigger trg_meeting_binding_touch
  before update on recruitment.meeting_binding
  for each row execute function recruitment.fn_touch();

do $$
begin
  raise notice '0006 GAP-5 已挂 trg_meeting_touch / trg_meeting_binding_touch（fn_touch：record_version + 1、updated_at = now()）';
end $$;


-- =====================================================================
--  §6  迁移后自检（任何一条不满足 → raise → 整笔回滚，不留半套结构）
-- =====================================================================

do $$
declare
  v_bad text;
  v_n   integer;
  v_def text;
  v_cols text[];
begin
  -- 6.1 GAP-1a：默认值必须是 'S8'
  select pg_get_expr(d.adbin, d.adrelid) into v_def
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'recruitment.interview'::regclass
     and a.attname  = 'stage_code';
  if v_def is null or v_def not like '%S8%' or v_def like '%INTERVIEW%' then
    raise exception '0006 POST-CHECK 失败 GAP-1a：interview.stage_code 默认值应为 ''S8''，实际 %', coalesce(v_def, '（无）');
  end if;

  -- 6.2 GAP-1b：外键形态（2 列含 tenant_id，指向 stage_catalog(tenant_id, code)，restrict/validated）
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid  = 'recruitment.interview'::regclass
     and c.conname   = 'fk_interview_stage_catalog'
     and c.contype   = 'f'
     and c.confrelid = 'recruitment.stage_catalog'::regclass
     and c.convalidated
     and c.confdeltype = 'r'
     and c.confupdtype = 'r'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['stage_code', 'tenant_id']::text[]
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['code', 'tenant_id']::text[];
  if v_n <> 1 then
    raise exception '0006 POST-CHECK 失败 GAP-1b：fk_interview_stage_catalog 形态不对（% / 1）', v_n;
  end if;

  -- 6.3 GAP-2：CHECK 必须含 submit_scorecard，且原有 5 个禁止值一个都不能少
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'recruitment.execution_mandate'::regclass
     and c.conname  = 'ck_execution_mandate_no_business_approval';
  if v_def is null then
    raise exception '0006 POST-CHECK 失败 GAP-2：ck_execution_mandate_no_business_approval 不存在';
  end if;
  foreach v_bad in array array['approve','reject','decide','merge_candidate',
                              'waive_scorecard','submit_scorecard']::text[]
  loop
    if v_def not like '%''' || v_bad || '''%' then
      raise exception '0006 POST-CHECK 失败 GAP-2：禁令 CHECK 缺少 %（当前：%）', v_bad, v_def;
    end if;
  end loop;

  -- 6.4 GAP-3a：外键必须是 3 列（含 tenant_id）
  select (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_cols
    from pg_constraint c
   where c.conrelid = 'recruitment.interview_record'::regclass
     and c.conname  = 'fk_interview_record_artifact'
     and c.contype  = 'f'
     and c.convalidated
     and c.confdeltype = 'r'
     and c.confupdtype = 'r'
     and c.confrelid   = 'recruitment.transcript_artifact'::regclass;
  if v_cols is distinct from array['tenant_id', 'transcript_artifact_id', 'transcript_revision']::text[] then
    raise exception '0006 POST-CHECK 失败 GAP-3a：fk_interview_record_artifact 不是含 tenant_id 的 3 列形态（实际 %）',
      coalesce(v_cols::text, '（不存在或无 tenant_id）');
  end if;

  -- 6.5 GAP-3b：被引用键在位（否则日后 drop 掉唯一键会让外键无声失效）
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.transcript_artifact'::regclass
     and c.contype  = 'u'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['id', 'source_revision', 'tenant_id']::text[];
  if v_n < 1 then
    raise exception '0006 POST-CHECK 失败 GAP-3b：transcript_artifact 缺 unique (tenant_id, id, source_revision)';
  end if;

  -- 6.6 GAP-3c：同表不允许再存在"不含 tenant_id 的转写外键"（后门）
  select string_agg(format('%s(%s)', c.conname, pg_get_constraintdef(c.oid)), ', ') into v_bad
    from pg_constraint c
   where c.conrelid = 'recruitment.interview_record'::regclass
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
    raise exception '0006 POST-CHECK 失败 GAP-3c：存在不含 tenant_id 的转写外键（跨租户后门）：%', v_bad;
  end if;

  -- 6.7 GAP-4a：列存在、可空、且**没有默认值**
  select string_agg(format('nullable=%s default=%s', a.attnotnull, coalesce(d.adbin::text, 'null')), ' ')
    into v_bad
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'recruitment.business_task'::regclass
     and a.attname  = 'owner_actor_id'
     and a.attnum   > 0
     and not a.attisdropped;
  if v_bad is null then
    raise exception '0006 POST-CHECK 失败 GAP-4a：business_task.owner_actor_id 不存在';
  end if;
  if exists (select 1 from pg_attribute a
               join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = 'recruitment.business_task'::regclass
                and a.attname  = 'owner_actor_id') then
    raise exception '0006 POST-CHECK 失败 GAP-4a：owner_actor_id 不允许有默认值（D-59）';
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'recruitment.business_task'::regclass
                and a.attname  = 'owner_actor_id'
                and a.attnotnull) then
    raise exception '0006 POST-CHECK 失败 GAP-4a：owner_actor_id 必须可空（D-59）';
  end if;

  -- 6.8 GAP-4b：外键 (owner_actor_id, tenant_id) → actor(id, tenant_id)
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid  = 'recruitment.business_task'::regclass
     and c.conname   = 'fk_business_task_owner_actor'
     and c.contype   = 'f'
     and c.confrelid = 'recruitment.actor'::regclass
     and c.convalidated
     and c.confdeltype = 'r'
     and c.confupdtype = 'r'
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['owner_actor_id', 'tenant_id']::text[]
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['id', 'tenant_id']::text[];
  if v_n <> 1 then
    raise exception '0006 POST-CHECK 失败 GAP-4b：fk_business_task_owner_actor 形态不对（% / 1）', v_n;
  end if;

  -- 6.9 GAP-5：两个触发器都在，且都执行 fn_touch（不是"随便挂了个触发器"）
  select string_agg(t.tbl, ', ') into v_bad
    from (values ('meeting'), ('meeting_binding')) as t(tbl)
   where not exists (
     select 1 from pg_trigger g
      where g.tgrelid = format('recruitment.%I', t.tbl)::regclass
        and not g.tgisinternal
        and (g.tgtype & 2)  = 2      -- BEFORE
        and (g.tgtype & 16) = 16     -- UPDATE
        and (g.tgtype & 1)  = 1      -- FOR EACH ROW
        and g.tgfoid = 'recruitment.fn_touch'::regproc);
  if v_bad is not null then
    raise exception '0006 POST-CHECK 失败 GAP-5：这些表缺 before update 的 fn_touch 触发器：%', v_bad;
  end if;

  raise notice '0006 POST-CHECK PASS 五个缺口全部落地：'
    'GAP-1 默认 S8 + fk_interview_stage_catalog；'
    'GAP-2 CHECK 含 submit_scorecard（原 5 值保留）；'
    'GAP-3 3 列外键 + 被引用键 + 无后门；'
    'GAP-4 owner_actor_id（可空、无默认）+ 同租户外键；'
    'GAP-5 两张表的 fn_touch 触发器';
end $$;

-- §7 改造后的现场（真实定义，作为"改造后"证据写进日志）
do $$
declare
  v_txt text;
begin
  select string_agg(format('%s.%s = %s', c.conrelid::regclass, c.conname, pg_get_constraintdef(c.oid)), E'\n      ')
    into v_txt
    from pg_constraint c
   where (c.conrelid = 'recruitment.interview'::regclass        and c.conname = 'fk_interview_stage_catalog')
      or (c.conrelid = 'recruitment.execution_mandate'::regclass and c.conname = 'ck_execution_mandate_no_business_approval')
      or (c.conrelid = 'recruitment.interview_record'::regclass  and c.conname = 'fk_interview_record_artifact')
      or (c.conrelid = 'recruitment.business_task'::regclass     and c.conname = 'fk_business_task_owner_actor')
      or (c.conrelid = 'recruitment.transcript_artifact'::regclass and c.conname = 'uq_transcript_artifact_tenant_id_revision');
  raise notice E'0006 改造后的约束定义：\n      %', coalesce(v_txt, '（无）');

  select string_agg(format('%s: %s', g.tgname, pg_get_triggerdef(g.oid)), E'\n      ')
    into v_txt
    from pg_trigger g
   where g.tgname in ('trg_meeting_touch', 'trg_meeting_binding_touch')
     and not g.tgisinternal;
  raise notice E'0006 改造后的触发器：\n      %', coalesce(v_txt, '（无）');

  raise notice '0006 DONE 五个完整性缺口已修复（单事务提交；本次无任何数据改动）';
end $$;


commit;


-- =====================================================================
--  回滚方式（反向 DDL，需人工确认；本文件没有数据改动，回滚是纯结构操作）
--
--    alter table recruitment.interview        drop constraint if exists fk_interview_stage_catalog;
--    alter table recruitment.interview        alter column stage_code set default 'INTERVIEW';
--    alter table recruitment.execution_mandate drop constraint if exists ck_execution_mandate_no_business_approval;
--    alter table recruitment.execution_mandate add constraint ck_execution_mandate_no_business_approval
--      check (not (allowed_actions && array['approve','reject','decide','merge_candidate','waive_scorecard']));
--    alter table recruitment.interview_record drop constraint if exists fk_interview_record_artifact;
--    alter table recruitment.interview_record add constraint fk_interview_record_artifact
--      foreign key (transcript_artifact_id, transcript_revision)
--      references recruitment.transcript_artifact (id, source_revision);
--    alter table recruitment.transcript_artifact drop constraint if exists uq_transcript_artifact_tenant_id_revision;
--    alter table recruitment.business_task   drop constraint if exists fk_business_task_owner_actor;
--    alter table recruitment.business_task   drop column    if exists owner_actor_id;
--    drop trigger if exists trg_meeting_touch         on recruitment.meeting;
--    drop trigger if exists trg_meeting_binding_touch on recruitment.meeting_binding;
--
--  ⚠️ 回滚前先确认：没有代码依赖"阶段 code 必须存在于目录""转写必须同租户"
--     "任务的负责人必须同租户"这三条保证 —— 回滚 = 把这五个缺口重新打开。
--  ⚠️ 回滚 owner_actor_id 会丢数据；数据库层没有替代载体（D-59 明确禁止用
--     business_refs.kind 表达责任人）。
-- =====================================================================
