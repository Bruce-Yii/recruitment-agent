-- =====================================================================
--  recruitment-agent · 0007_decision_integrity.sql
--
--  0007 的五个缺口（GAP-A … GAP-E）：
--    A  decision.stage_code 没有外键 —— 正则只挡形状，不挡"形状对但目录里没有"
--    B  decision 没有"当前决策唯一性" —— 两条互相矛盾的 current FINAL 可以并存
--    C  scorecard.rubric_version 没绑定到"这个申请的那个岗位" —— A 岗位的面试
--       可以用 B 岗位的评分标准交面评，库不报错
--    D  ai_summary.fk_ai_summary_artifact 是 2 列（不含 tenant_id）——
--       甲租户的摘要可以引用乙租户的转写（0006 已修 interview_record 的同型外键）
--    E  直接 INSERT 已终态行可以绕过 status_changed_by_actor_id（只有 UPDATE 路径
--       被 fn_row_guard 管）
--
--  ⚠️ 关于 GAP-E 的一处**事实更正**（实测，不是推测）：
--      任务书写"decision / scorecard 都有 status_changed_by_actor_id 与
--      status_source_event_id 列"。**decision 没有这两个列**，也没有 status 列
--      （decision 的 16 个列见 §0.6；实测 `insert ... status_changed_by_actor_id`
--      返回 SQLSTATE 42703）。decision 的 actor 强制在 INSERT 上由
--      `decided_by_actor_id NOT NULL` + `fk_decision_actor (decided_by_actor_id,
--      tenant_id) → actor(id, tenant_id)` 完成（实测不写 actor → 23502）。
--      所以 **GAP-E 的 decision 半边不成立**；本文件不新造 status / actor 列
--      （新造列才是顺着错的前提做）。scorecard 半边成立，见 §5。
--
--  写法（与 0004 / 0005 / 0006 同一口径，一条不少）：
--    * 单事务：五段全有或全无。
--    * **先检查再改**：每段加约束前先查现有数据；有任何行不满足新约束 →
--      raise + 整笔回滚，并逐行列出"哪一行、错在哪"。
--    * **不替任何人改数据**：唯一的数据写入是 GAP-C 的 job_id 回填，且只在
--      "该值能由既有外键链唯一推出"（interview → application.job_id）时进行；
--      不设默认值、不猜。回填会让 PENDING 行的 record_version 自增 1
--      （0001 的 trg_scorecard_guard_status 对所有 UPDATE 的固有行为），
--      本文件**不 disable 任何护栏**来绕开它；终态行无法回填 → 直接停下报错。
--    * **幂等**：连续跑两遍，第二遍零 ERROR、零新增对象、零数据改动。
--      所有对象都先查 pg_constraint / pg_index / pg_trigger / pg_proc 再建，
--      **不用 drop ... if exists 后重建**（唯一例外是 GAP-D 的"先建新键、
--      验 convalidated、再删旧键"—— 那是为了不留无保护窗口，且第二遍不会再走）。
--    * 不改 0001–0006 的任何语义；唯一的行为改动是**新增**约束：
--      原本能写进去的错数据开始报错，这是目的。
--
--  依赖：0001（decision / scorecard / ai_summary / transcript_artifact / actor）、
--        0004（stage_catalog 的 12 行 + uq_stage_catalog_tenant_code +
--              uq_rubric_version_tenant_job_id）。
--        0006 提供了 uq_transcript_artifact_tenant_id_revision（GAP-D 的被引用键）；
--        若那一步没跑，本文件会按列集合判断后补建同名键（不重复建）。
--        0002 / 0003 / 0005 与本文件无交集，可选。
--
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0007_decision_integrity.sql
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
      ('organization'), ('actor'), ('job'), ('application'), ('interview'),
      ('interviewer'), ('rubric_version'), ('stage_catalog'),
      ('transcript_artifact'), ('ai_summary'), ('scorecard'), ('decision')
    ) as v(tbl)
  loop
    if to_regclass('recruitment.' || r.tbl) is null then
      v_missing := v_missing || r.tbl || ' ';
    end if;
  end loop;
  if v_missing <> '' then
    raise exception 'DECISION_INTEGRITY_DEPENDENCY: 缺表 %（0007 依赖 0001 + 0004；GAP-A 必须有 stage_catalog）',
      v_missing
      using errcode = '42P01';
  end if;
  raise notice '0007 DEPENDENCY PASS 依赖表齐全（含 0004 的 stage_catalog）';
end $$;

do $$
declare
  v_txt   text;
  v_n     integer;
  v_cols  text;
begin
  -- 0.1 GAP-A 改造前：decision 的 stage_code 上有几条外键
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.contype  = 'f'
     and (select array_agg(a.attname::text)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         && array['stage_code']::text[];
  raise notice '0007 改造前 GAP-A：decision 上引用 stage_code 的外键 = % 条（应为 0：只有正则，没有取值校验）', v_n;

  -- 0.2 GAP-B 改造前：decision 上能表达"当前行唯一"的唯一索引
  select count(*) into v_n
    from pg_index i
   where i.indrelid = 'recruitment.decision'::regclass
     and i.indisunique
     and (select array_agg(a.attname::text)
            from pg_attribute a
           where a.attrelid = i.indrelid and a.attnum = any(i.indkey))
         && array['application_id', 'decision_scope']::text[];
  raise notice '0007 改造前 GAP-B：decision 上含 (application_id, decision_scope) 的唯一索引 = % 个（应为 0：当前决策可重复）', v_n;

  -- 0.3 GAP-C 改造前：scorecard 上有没有 job_id
  select string_agg(format('%s %s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ')
    into v_cols
    from pg_attribute a
   where a.attrelid = 'recruitment.scorecard'::regclass
     and a.attname  = 'job_id'
     and a.attnum   > 0
     and not a.attisdropped;
  raise notice '0007 改造前 GAP-C：scorecard.job_id = %', coalesce(v_cols, '（不存在）');

  -- 0.4 GAP-D 改造前：ai_summary → transcript_artifact 的外键原文
  select pg_get_constraintdef(c.oid) into v_txt
    from pg_constraint c
   where c.conrelid = 'recruitment.ai_summary'::regclass
     and c.conname  = 'fk_ai_summary_artifact';
  raise notice '0007 改造前 GAP-D：fk_ai_summary_artifact = %', coalesce(v_txt, '（不存在）');

  -- 0.5 GAP-E 改造前：scorecard 上有没有 before insert 触发器
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'recruitment.scorecard'::regclass
     and not g.tgisinternal
     and (g.tgtype & 2)  = 2      -- BEFORE
     and (g.tgtype & 4)  = 4;     -- INSERT
  raise notice '0007 改造前 GAP-E：scorecard 的 before insert 触发器 = % 个（首跑应为 0：直接 INSERT 终态行无人管）', v_n;

  -- 0.6 GAP-E 事实核对：decision 的列（打印出来，证明没有 status / status_changed_by_actor_id）
  select string_agg(a.attname, ', ' order by a.attnum) into v_cols
    from pg_attribute a
   where a.attrelid = 'recruitment.decision'::regclass
     and a.attnum   > 0
     and not a.attisdropped;
  raise notice '0007 GAP-E 事实核对：decision 的列 = %', v_cols;

  -- 0.7 改造前：五段的存量行数（决定"是否有东西可查"）
  raise notice '0007 改造前行数：decision=% / scorecard=% / ai_summary=% / rubric_version=%',
    (select count(*) from recruitment.decision),
    (select count(*) from recruitment.scorecard),
    (select count(*) from recruitment.ai_summary),
    (select count(*) from recruitment.rubric_version);

  -- 0.8 改造前：全库"多列外键但不含 tenant_id"（GAP-D 修完后应为 0）
  select string_agg(format('%s(%s)', c.conrelid::regclass, c.conname), ', ')
    into v_cols
    from pg_constraint c
   where c.contype = 'f'
     and cardinality(c.conkey) > 1
     and not exists (
       select 1 from unnest(c.conkey) k
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
        where a.attname = 'tenant_id');
  raise notice '0007 改造前：全库多列外键不含 tenant_id = %', coalesce(v_cols, '（无）');
end $$;


-- =====================================================================
--  §1  GAP-A · decision.stage_code 必须存在于**本租户**的阶段目录
--
--  现状：`ck_decision_stage_code` 只校验形状 `^[A-Z][A-Z0-9_]{1,40}$`。
--        于是 'BANANA' / 'SCREENING'（作废的五档值）/ 'INTERVIEW'（0006 已
--        退场的旧默认值）全都能落库；查得到决策，查不到它是哪个阶段。
--  改：照 0006 的 fk_interview_stage_catalog 写法，加
--        (tenant_id, stage_code) → stage_catalog (tenant_id, code)。
--      用复合列而不是单列 code：阶段目录是**按租户**的（0004 §1），
--      跨租户借用阶段名必须在库层被拦。
--
--  ⚠️ 该列可空。外键是 MATCH SIMPLE：stage_code IS NULL 时不检查。
--     这是**有意的**：FINAL 决策可以不分阶段。NULL 表示"不分阶段"，
--     不是"任意阶段"—— 正则与外键都不把 NULL 当成一个合法 code。
--  ⚠️ 'S11'（Offer，in_v1_scope=false）加外键后**仍然可写**：它在目录里。
--     in_v1_scope 是 v1.0 产品范围，不是库层存在性；本迁移不把它变成禁令。
-- =====================================================================

-- 1.1 前置检查：现有 decision 的 (tenant_id, stage_code) 必须已在目录里
do $$
declare
  v_bad text;
begin
  select string_agg(
           format('decision=%s tenant=%s stage_code=%s（自己租户的目录里没有这个 code）',
                  d.id, d.tenant_id, d.stage_code),
           E'\n      ')
    into v_bad
    from recruitment.decision d
   where d.stage_code is not null
     and not exists (
       select 1 from recruitment.stage_catalog s
        where s.tenant_id = d.tenant_id
          and s.code      = d.stage_code);
  if v_bad is not null then
    raise exception E'DECISION_STAGE_CATALOG_MISSING: 以下 decision 的 stage_code 不在**它自己租户**的 stage_catalog 中，外键无法建立。\n      本迁移不会替你改数据：请人工确认这些决策真正属于哪个阶段（或补目录）后重跑。\n      %', v_bad
      using errcode = '23503';
  end if;

  -- 被引用键必须在位（0004 的产物；不在位时外键无处可指）
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'recruitment.stage_catalog'::regclass
       and c.contype  = 'u'
       and (select array_agg(a.attname::text order by a.attname)
              from pg_attribute a
             where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
           = array['code', 'tenant_id']::text[])
  then
    raise exception 'DECISION_STAGE_CATALOG_DEPENDENCY: stage_catalog 缺 unique (tenant_id, code)（0004 的产物），GAP-A 的外键无处可指'
      using errcode = '42P01';
  end if;

  raise notice '0007 GAP-A PRE-CHECK PASS 现有 decision 的 stage_code 全部已在各自租户的 stage_catalog 内（NULL 除外，0 条脏值）';
end $$;

-- 1.2 复合外键（先查 pg_constraint，已存在则不重建）
do $$
declare
  v_exists boolean;
  v_ok     boolean;
  v_cols   text[];
  v_def    text;
begin
  select true,
         (c.contype   = 'f'
          and c.confrelid  = 'recruitment.stage_catalog'::regclass
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
              = array['code', 'tenant_id']::text[]),
         (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_exists, v_ok, v_cols
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'fk_decision_stage_catalog';

  if coalesce(v_ok, false) then
    raise notice '0007 GAP-A fk_decision_stage_catalog 已存在且形态正确，跳过';
    return;
  end if;

  if coalesce(v_exists, false) then
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c
     where c.conrelid = 'recruitment.decision'::regclass
       and c.conname  = 'fk_decision_stage_catalog';
    raise exception 'DECISION_STAGE_FK_UNEXPECTED: 现有 fk_decision_stage_catalog 不是目标形态（列集合 %），拒绝覆盖。实际：%', v_cols, v_def
      using errcode = '23514';
  end if;

  alter table recruitment.decision
    add constraint fk_decision_stage_catalog
    foreign key (tenant_id, stage_code)
    references recruitment.stage_catalog (tenant_id, code)
    on update restrict on delete restrict;
  raise notice '0007 GAP-A 已加 fk_decision_stage_catalog：(tenant_id, stage_code) → stage_catalog(tenant_id, code)（restrict/restrict，MATCH SIMPLE）';
end $$;


-- =====================================================================
--  §2  GAP-B · "当前决策"唯一性
--
--  现状：decision 上没有任何唯一约束能阻止同一
--        (tenant_id, application_id, decision_scope, stage_code) 存在两条
--        superseded_by_decision_id IS NULL 的 current 行。实测：同一申请可以
--        同时有 FINAL/REJECT 与 FINAL/HIRED 两条 current 决策，库一声不吭。
--        应用层的 ALREADY_DECIDED 是唯一拦截，而应用层可以被绕过。
--  改：部分唯一索引
--        unique (tenant_id, application_id, decision_scope, stage_code)
--        where superseded_by_decision_id is null
--
--  为什么用 NULLS NOT DISTINCT 而不是 coalesce(stage_code, '')：
--    * stage_code 可空，而 PG 默认认为 NULL 互不相等 —— 两条 stage_code IS NULL
--      的 current FINAL 会同时通过。必须显式处理。
--    * coalesce(...,'') 能把 NULL 变成可比较的哨兵值，但那是**编造一个阶段码**：
--      '' 不是目录里的 code（正则也不允许），它只活在索引表达式里；
--      pg_indexes / \d / 以后的迁移结构断言都要多记一条"'' 等于没有阶段"的暗规则。
--    * NULLS NOT DISTINCT（PG15+，本机 17.11）直接表达意图："在这个索引里，
--      两个 NULL 视为相等"，不需要哨兵值，也不需要表达式索引。
--    代价：NULLS NOT DISTINCT 只能用在索引上（partial unique constraint 在 PG 里
--    不存在），所以它是一条唯一**索引**，不是 pg_constraint 里的 unique 约束。
--
--  ⚠️ 行为后果（必须知道，见 db/DECISION-INTEGRITY.md §4）：
--      "先插新决策、再回填旧决策的 superseded_by_decision_id"这种顺序，
--      在**立即**唯一索引下会先撞 23505；而"先回填、后插新行"会撞
--      fk_decision_superseded_by（新行还不存在）→ 23503。
--      也就是说：同一 (scope, stage_code) 的"替换"不能再按这两步走。
--      本文件按任务书要求建部分唯一索引，没有擅自改成 deferrable exclusion
--      constraint（那会让"同一事务内先插后改"可行）—— 这是留给总控的裁决。
-- =====================================================================

-- 2.1 前置检查：现有 current 行不得重复
--     注意 group by 把 NULL 当成相等（这正是 NULLS NOT DISTINCT 的语义），
--     所以 stage_code IS NULL 的重复也会被查出来。
do $$
declare
  v_bad text;
begin
  select string_agg(
           format('tenant=%s application=%s scope=%s stage_code=%s：%s 条 current（id: %s）',
                  d.tenant_id, d.application_id, d.decision_scope,
                  coalesce(d.stage_code, '<NULL>'), d.n, d.ids),
           E'\n      ')
    into v_bad
    from (
      select tenant_id, application_id, decision_scope, stage_code,
             count(*) as n,
             string_agg(id::text, ', ' order by decided_at, id) as ids
        from recruitment.decision
       where superseded_by_decision_id is null
       group by tenant_id, application_id, decision_scope, stage_code
      having count(*) > 1
    ) d;
  if v_bad is not null then
    raise exception E'DECISION_CURRENT_DUPLICATE: 以下 (tenant, application, decision_scope, stage_code) 有不止一条 current 决策（superseded_by_decision_id IS NULL），部分唯一索引无法建立。\n      本迁移不会替你把其中一条标成 superseded（那等于替人决定哪条决策作废）。请人工确认保留哪一条后重跑。\n      %', v_bad
      using errcode = '23505';
  end if;
  raise notice '0007 GAP-B PRE-CHECK PASS 现有 decision 没有重复的 current 行（NULL stage_code 按相等分组，0 组重复）';
end $$;

-- 2.2 部分唯一索引（先查 pg_index，已存在则不重建）
do $$
declare
  v_exists boolean;
  v_ok     boolean;
  v_cols   text[];
  v_def    text;
begin
  select true,
         (i.indrelid = 'recruitment.decision'::regclass
          and i.indisunique
          and i.indnullsnotdistinct
          and i.indpred is not null
          and (select array_agg(a.attname::text order by a.attname)
                 from pg_attribute a
                where a.attrelid = i.indrelid and a.attnum = any(i.indkey))
              = array['application_id', 'decision_scope', 'stage_code', 'tenant_id']::text[]
          and pg_get_expr(i.indpred, i.indrelid) like '%superseded_by_decision_id IS NULL%'),
         (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = i.indrelid and a.attnum = any(i.indkey))
    into v_exists, v_ok, v_cols
    from pg_index i
   where i.indexrelid = to_regclass('recruitment.uq_decision_current');

  if coalesce(v_ok, false) then
    raise notice '0007 GAP-B uq_decision_current 已存在且形态正确，跳过';
    return;
  end if;

  if coalesce(v_exists, false) then
    select pg_get_indexdef(i.indexrelid) into v_def
      from pg_index i
     where i.indexrelid = to_regclass('recruitment.uq_decision_current');
    raise exception 'DECISION_CURRENT_INDEX_UNEXPECTED: 现有 uq_decision_current 不是目标形态（列集合 %），拒绝覆盖。实际：%', v_cols, v_def
      using errcode = '23514';
  end if;

  create unique index uq_decision_current
    on recruitment.decision (tenant_id, application_id, decision_scope, stage_code)
    nulls not distinct
    where superseded_by_decision_id is null;
  raise notice '0007 GAP-B 已建 uq_decision_current：(tenant_id, application_id, decision_scope, stage_code) NULLS NOT DISTINCT WHERE superseded_by_decision_id IS NULL';
end $$;


-- =====================================================================
--  §3  GAP-C · scorecard 的评分标准必须属于"这个申请的那个岗位"
--
--  现状：fk_scorecard_rubric 只保证 rubric_version_id 存在且同租户，
--        **不保证它是该面试对应申请的那个 job 的 rubric**。于是 A 岗位的面试
--        可以用 B 岗位的评分标准交面评，库不报错。
--  改（任务书倾向的 (a)，采用）：
--    1. scorecard 加 job_id（uuid，NOT NULL，**不设默认值**）；
--    2. 复合外键 (tenant_id, job_id, rubric_version_id) →
--         rubric_version (tenant_id, job_id, id)
--       被引用键复用 0004 已有的 uq_rubric_version_tenant_job_id；
--    3. 触发器 fn_scorecard_job_guard 保证
--         scorecard.job_id = interview → application.job_id。
--
--  为什么是 (a) 而不是纯触发器：外键是硬的（不能 disable）。纯触发器校验
--  "rubric.job_id = application.job_id" 也能挡住跨岗位，但库里仍然允许
--  一条 rubric 属于 job B 的 scorecard 存在，只要当时没人跑触发器（例如
--  触发器被 disable / 数据由 bulk load 绕过）。复合外键把"rubric 属于 job_id"
--  变成物理事实；触发器只负责把"job_id 属于这个申请"补齐。
--
--  代价与回填：
--    * job_id 由既有外键链**唯一推出**（interview.application_id → application.job_id，
--      两段都是 NOT NULL 外键），所以给存量行回填不是"猜"，是把已经被两条外键
--      固定的事实物化出来。没有用默认值硬填。
--    * 回填只处理 job_id IS NULL 的行；已经有 job_id 且与推导值不一致 → 报错
--      （不覆盖别人写过的值）。
--    * 回填是一次真实 UPDATE：PENDING 行的 record_version 会被 0001 的
--      trg_scorecard_guard_status 自增 1、updated_at 变成 now()。这是该触发器
--      对所有 UPDATE 的固有行为，本文件**不 disable 护栏**来假装"什么都没发生"。
--    * 终态行（SUBMITTED / WAIVED）若缺 job_id，回填会被 fn_scorecard_guard
--      拦（SCORECARD_IMMUTABLE）。本文件不 disable 那条护栏，直接停下报错，
--      把"要不要动已提交面评"交给人。
--    * 触发器在值为 NULL 时**填充**（唯一推导，不是默认值）；显式给了错误的
--      job_id 一律拒绝。这样既有写入方（不写 job_id）不需要改就能继续工作，
--      而想绕过 FK 的写法（写一个别的 job_id）会被 23514 挡下。
-- =====================================================================

-- 3.1 前置检查 A：列若已存在，类型必须是 uuid
do $$
declare
  v_typ text;
begin
  select format_type(a.atttypid, a.atttypmod) into v_typ
    from pg_attribute a
   where a.attrelid = 'recruitment.scorecard'::regclass
     and a.attname  = 'job_id'
     and a.attnum   > 0
     and not a.attisdropped;
  if v_typ is not null and v_typ <> 'uuid' then
    raise exception 'SCORECARD_JOB_COLUMN_UNEXPECTED: scorecard.job_id 已存在但类型是 %（期望 uuid）。拒绝改列 —— 请人工核对。', v_typ
      using errcode = '42804';
  end if;
  raise notice '0007 GAP-C PRE-CHECK A PASS scorecard.job_id 类型检查通过（%）',
    coalesce(v_typ, '尚未创建，将按 uuid 新建');
end $$;

-- 3.2 前置检查 B：存量行必须能解析出唯一 job_id，且不违反新外键
--     注意：首跑时 job_id 列还不存在，所以"已有 job_id 冲突 / 终态缺 job_id"这两条
--     必须按列是否存在分支（plpgsql 的 SQL 语句是执行到时才解析，未走到的分支不会报错）。
do $$
declare
  v_bad     text;
  v_has_col boolean;
begin
  select exists (
    select 1 from pg_attribute a
     where a.attrelid = 'recruitment.scorecard'::regclass
       and a.attname  = 'job_id'
       and a.attnum   > 0
       and not a.attisdropped
  ) into v_has_col;

  -- 3.2.1 解析不出 job_id（interview → application 链断了）
  select string_agg(format('scorecard=%s interview=%s tenant=%s',
                           s.id, s.interview_id, s.tenant_id), E'\n      ')
    into v_bad
    from recruitment.scorecard s
   where not exists (
     select 1
       from recruitment.interview i
       join recruitment.application a
         on a.id = i.application_id and a.tenant_id = i.tenant_id
      where i.id = s.interview_id
        and i.tenant_id = s.tenant_id);
  if v_bad is not null then
    raise exception E'SCORECARD_JOB_UNRESOLVED: 以下 scorecard 的 interview → application 链解析不出 job_id，复合外键无法建立。\n      本迁移不会替你猜岗位：请人工核对这些面评属于哪个申请。\n      %', v_bad
      using errcode = '23514';
  end if;

  -- 3.2.2 已经有 job_id 但与推导值不一致（别人手填过 / 上一次部分迁移留下的错值）
  if v_has_col then
    select string_agg(format('scorecard=%s job_id=%s 推导值=%s',
                             s.id, s.job_id, a.job_id), E'\n      ')
      into v_bad
      from recruitment.scorecard s
      join recruitment.interview i
        on i.id = s.interview_id and i.tenant_id = s.tenant_id
      join recruitment.application a
        on a.id = i.application_id and a.tenant_id = i.tenant_id
     where s.job_id is not null
       and s.job_id <> a.job_id;
    if v_bad is not null then
      raise exception E'SCORECARD_JOB_CONFLICT: 以下 scorecard 已有的 job_id 与 interview → application.job_id 推导值不一致。\n      本迁移不覆盖别人写过的值（覆盖会把"写错了"变成"看不出来写错过了"）：请人工确认哪个对。\n      %', v_bad
        using errcode = '23514';
    end if;
  end if;

  -- 3.2.3 rubric 的 job 与该申请的 job 不一致 → 新复合外键会拒绝（这就是缺口本身）
  select string_agg(format('scorecard=%s rubric=%s rubric_job=%s application_job=%s',
                           s.id, s.rubric_version_id, rv.job_id, a.job_id), E'\n      ')
    into v_bad
    from recruitment.scorecard s
    join recruitment.interview i
      on i.id = s.interview_id and i.tenant_id = s.tenant_id
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
    join recruitment.rubric_version rv
      on rv.id = s.rubric_version_id and rv.tenant_id = s.tenant_id
   where rv.job_id <> a.job_id;
  if v_bad is not null then
    raise exception E'SCORECARD_RUBRIC_JOB_MISMATCH: 以下 scorecard 用的评分标准属于**另一个岗位**（这就是 GAP-C 本身），复合外键无法建立。\n      本迁移不会替你换 rubric（换 rubric = 改评价内容）：请人工确认这些面评该保留还是作废后重跑。\n      %', v_bad
      using errcode = '23503';
  end if;

  -- 3.2.4 终态行缺 job_id → 回填会被 fn_scorecard_guard 拦；不 disable 护栏，先停
  if v_has_col then
    select string_agg(format('scorecard=%s status=%s', s.id, s.status), E'\n      ')
      into v_bad
      from recruitment.scorecard s
     where s.job_id is null
       and s.status <> 'PENDING';
  else
    -- 列还不存在 = 所有行都缺 job_id；终态行一律停下（PENDING 行可以安全回填）
    select string_agg(format('scorecard=%s status=%s', s.id, s.status), E'\n      ')
      into v_bad
      from recruitment.scorecard s
     where s.status <> 'PENDING';
  end if;
  if v_bad is not null then
    raise exception E'SCORECARD_JOB_BACKFILL_BLOCKED: 以下 scorecard 已是终态（SUBMITTED / WAIVED）但 job_id 为空，需要回填；而 trg_scorecard_submitted_guard（fn_scorecard_guard）禁止修改终态行。\n      本迁移**不会** disable 那条护栏来绕开它（那会把"评价不可覆盖"短暂打开）。\n      请人工按 db/DECISION-INTEGRITY.md §7 的一次性 SQL 回填 job_id 后重跑本迁移。\n      %', v_bad
      using errcode = '23514';
  end if;

  raise notice '0007 GAP-C PRE-CHECK B PASS 存量 scorecard：解析链 0 条断 / 已有 job_id 0 条冲突 / rubric 跨岗位 0 条 / 终态缺 job_id 0 条';
end $$;

-- 3.3 加列（可空先加，回填后再收紧成 NOT NULL —— 不在这一步给默认值）
alter table recruitment.scorecard
  add column if not exists job_id uuid;

-- 3.4 回填：只填 job_id IS NULL 的行，值只来自 interview → application.job_id
do $$
declare
  v_n integer;
begin
  update recruitment.scorecard s
     set job_id = d.job_id
    from (
      select sc.id as scorecard_id, a.job_id
        from recruitment.scorecard sc
        join recruitment.interview i
          on i.id = sc.interview_id and i.tenant_id = sc.tenant_id
        join recruitment.application a
          on a.id = i.application_id and a.tenant_id = i.tenant_id
       where sc.job_id is null
    ) d
   where d.scorecard_id = s.id;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    raise notice '0007 GAP-C 回填 scorecard.job_id：% 行（唯一推导 interview → application.job_id；这些行是 PENDING，record_version 被 trg_scorecard_guard_status 自增 1 —— 见文件头）', v_n;
  else
    raise notice '0007 GAP-C scorecard.job_id 无需回填（0 行）';
  end if;
end $$;

-- 3.5 收紧为 NOT NULL（回填后无 NULL；第二遍是 no-op）
alter table recruitment.scorecard
  alter column job_id set not null;

-- 3.6 被引用键：0004 的 uq_rubric_version_tenant_job_id (tenant_id, job_id, id)
do $$
declare
  v_cols text;
  v_def  text;
begin
  if exists (
    select 1 from pg_constraint c
     where c.conrelid = 'recruitment.rubric_version'::regclass
       and c.contype  = 'u'
       and (select array_agg(a.attname::text order by a.attname)
              from pg_attribute a
             where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
           = array['id', 'job_id', 'tenant_id']::text[])
  then
    raise notice '0007 GAP-C 复用 rubric_version 已有 unique (tenant_id, job_id, id)（0004 的 uq_rubric_version_tenant_job_id）';
    return;
  end if;

  -- 名字被占但列集合不对 → 拒绝在别人头上抢名字
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'recruitment.rubric_version'::regclass
     and c.conname  = 'uq_rubric_version_tenant_job_id';
  if v_def is not null then
    raise exception 'RUBRIC_VERSION_KEY_UNEXPECTED: uq_rubric_version_tenant_job_id 已存在但列集合不是 (tenant_id, job_id, id)，拒绝覆盖。实际：%', v_def
      using errcode = '23514';
  end if;

  alter table recruitment.rubric_version
    add constraint uq_rubric_version_tenant_job_id
    unique (tenant_id, job_id, id);
  raise notice '0007 GAP-C 已补 rubric_version unique (tenant_id, job_id, id)（3 列外键的被引用键）';
end $$;

-- 3.7 复合外键（先查 pg_constraint，已存在则不重建）
do $$
declare
  v_exists boolean;
  v_ok     boolean;
  v_cols   text[];
  v_def    text;
begin
  select true,
         (c.contype   = 'f'
          and c.confrelid  = 'recruitment.rubric_version'::regclass
          and c.convalidated
          and c.confdeltype = 'r'
          and c.confupdtype = 'r'
          and (select array_agg(a.attname::text order by a.attname)
                 from pg_attribute a
                where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
              = array['job_id', 'rubric_version_id', 'tenant_id']::text[]
          and (select array_agg(a.attname::text order by a.attname)
                 from pg_attribute a
                where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
              = array['id', 'job_id', 'tenant_id']::text[]),
         (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
    into v_exists, v_ok, v_cols
    from pg_constraint c
   where c.conrelid = 'recruitment.scorecard'::regclass
     and c.conname  = 'fk_scorecard_rubric_job';

  if coalesce(v_ok, false) then
    raise notice '0007 GAP-C fk_scorecard_rubric_job 已存在且形态正确，跳过';
    return;
  end if;

  if coalesce(v_exists, false) then
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c
     where c.conrelid = 'recruitment.scorecard'::regclass
       and c.conname  = 'fk_scorecard_rubric_job';
    raise exception 'SCORECARD_RUBRIC_JOB_FK_UNEXPECTED: 现有 fk_scorecard_rubric_job 不是目标形态（列集合 %），拒绝覆盖。实际：%', v_cols, v_def
      using errcode = '23514';
  end if;

  alter table recruitment.scorecard
    add constraint fk_scorecard_rubric_job
    foreign key (tenant_id, job_id, rubric_version_id)
    references recruitment.rubric_version (tenant_id, job_id, id)
    on update restrict on delete restrict;
  raise notice '0007 GAP-C 已加 fk_scorecard_rubric_job：(tenant_id, job_id, rubric_version_id) → rubric_version(tenant_id, job_id, id)';
end $$;

-- 3.8 触发器：scorecard.job_id 必须等于 interview → application.job_id
--     值为 NULL 时填充（唯一推导）；显式给了不一致的值 → 23514。
create or replace function recruitment.fn_scorecard_job_guard() returns trigger
language plpgsql as $$
declare
  v_job uuid;
begin
  select a.job_id into v_job
    from recruitment.interview i
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
   where i.id = new.interview_id
     and i.tenant_id = new.tenant_id;

  if v_job is null then
    raise exception
      'SCORECARD_JOB_UNRESOLVED: scorecard 的面试 %（tenant=%）解析不出 application.job_id',
      new.interview_id, new.tenant_id
      using errcode = '23514';
  end if;

  if new.job_id is null then
    -- 唯一推导，不是默认值：值由两条 NOT NULL 外键链固定，无选择余地
    new.job_id := v_job;
  elsif new.job_id <> v_job then
    raise exception
      'SCORECARD_JOB_MISMATCH: scorecard 声称 job_id=% ，但面试 % 所属申请的岗位是 %（评分标准必须绑定该申请的岗位）',
      new.job_id, new.interview_id, v_job
      using errcode = '23514';
  end if;
  return new;
end $$;

do $$
declare
  v_exists boolean;
  v_ok     boolean;
begin
  select true,
         ((g.tgtype & 1)  = 1      -- FOR EACH ROW
          and (g.tgtype & 2)  = 2  -- BEFORE
          and (g.tgtype & 20) = 20 -- INSERT + UPDATE
          and g.tgfoid = 'recruitment.fn_scorecard_job_guard'::regproc)
    into v_exists, v_ok
    from pg_trigger g
   where g.tgrelid = 'recruitment.scorecard'::regclass
     and g.tgname  = 'trg_scorecard_job_guard'
     and not g.tgisinternal;

  if coalesce(v_ok, false) then
    raise notice '0007 GAP-C trg_scorecard_job_guard 已存在且形态正确，跳过';
    return;
  end if;

  if coalesce(v_exists, false) then
    raise exception 'SCORECARD_JOB_TRIGGER_UNEXPECTED: trg_scorecard_job_guard 已存在但不是 "before insert or update ... fn_scorecard_job_guard" 形态，拒绝覆盖'
      using errcode = '23514';
  end if;

  create trigger trg_scorecard_job_guard
    before insert or update on recruitment.scorecard
    for each row execute function recruitment.fn_scorecard_job_guard();
  raise notice '0007 GAP-C 已挂 trg_scorecard_job_guard（before insert or update → fn_scorecard_job_guard）';
end $$;


-- =====================================================================
--  §4  GAP-D · fk_ai_summary_artifact 带上 tenant_id
--
--  现状：(transcript_artifact_id, transcript_revision) → (id, source_revision)。
--        两列**不含 tenant_id** → 甲租户的 ai_summary 可以指向乙租户的
--        transcript_artifact，只要 revision 对得上。跨租户引用在库层成立，
--        而摘要会带着乙租户的原文摘录出现在甲的界面上。
--        0006 已把 interview_record 的同型外键改成 3 列，并顺手建了被引用键
--        uq_transcript_artifact_tenant_id_revision —— 这里直接复用。
--  改：(tenant_id, transcript_artifact_id, transcript_revision)
--        → transcript_artifact (tenant_id, id, source_revision)
--
--  三道闸（同 0005 §4 / 0006 §3.4）：先建新键 → 验 convalidated → 再删旧键。
--  旧键存在时新键先挂临时名 fk_ai_summary_artifact_0007；验证通过、删旧键后
--  再改名回 fk_ai_summary_artifact（名字不随形态漂移：SCHEMA.md / 台账引用的是它）。
-- =====================================================================

-- 4.1 前置检查：跨租户 / revision 对不上 / 指向不存在的 artifact
do $$
declare
  v_bad text;
begin
  select string_agg(
           format('ai_summary=%s (tenant=%s) → artifact=%s (tenant=%s)',
                  s.id, s.tenant_id, ta.id, ta.tenant_id),
           E'\n      ')
    into v_bad
    from recruitment.ai_summary s
    join recruitment.transcript_artifact ta on ta.id = s.transcript_artifact_id
   where ta.tenant_id <> s.tenant_id;
  if v_bad is not null then
    raise exception E'AI_SUMMARY_CROSS_TENANT_ARTIFACT: 以下 ai_summary 引用了**别的租户**的 transcript_artifact，复合外键无法建立。\n      本迁移不会替你改数据（这可能是越权读取的痕迹，需要人工判断）：\n      %', v_bad
      using errcode = '23503';
  end if;

  select string_agg(
           format('ai_summary=%s 声称 revision=%s，artifact 实际 revision=%s',
                  s.id, s.transcript_revision, ta.source_revision),
           E'\n      ')
    into v_bad
    from recruitment.ai_summary s
    join recruitment.transcript_artifact ta on ta.id = s.transcript_artifact_id
   where ta.source_revision <> s.transcript_revision;
  if v_bad is not null then
    raise exception E'AI_SUMMARY_REVISION_MISMATCH: 以下 ai_summary 声称的转写版本与 artifact 实际版本不符：%', v_bad
      using errcode = '23503';
  end if;

  select string_agg(format('ai_summary=%s → artifact=%s（不存在）', s.id, s.transcript_artifact_id), E'\n      ')
    into v_bad
    from recruitment.ai_summary s
   where not exists (select 1 from recruitment.transcript_artifact ta where ta.id = s.transcript_artifact_id);
  if v_bad is not null then
    raise exception E'AI_SUMMARY_ORPHAN_ARTIFACT: 以下 ai_summary 引用的 transcript_artifact 不存在：%', v_bad
      using errcode = '23503';
  end if;

  raise notice '0007 GAP-D PRE-CHECK PASS 现有 ai_summary：跨租户引用 0 条 / revision 不符 0 条 / 孤儿引用 0 条';
end $$;

-- 4.2 被引用键：unique (tenant_id, id, source_revision)（0006 的产物；不在位则补建）
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
    raise notice '0007 GAP-D 已补 transcript_artifact unique (tenant_id, id, source_revision)（0006 未跑时的兜底）';
  else
    raise notice '0007 GAP-D 复用 transcript_artifact 已有 unique (tenant_id, id, source_revision)（0006 的 uq_transcript_artifact_tenant_id_revision）';
  end if;
end $$;

-- 4.3 换外键：先建新键 → 验 convalidated → 删旧键 → 改名
do $$
declare
  v_exists boolean;
  v_is_fk  boolean;
  v_ok     boolean;
  v_cols   text[];
  v_def    text;
  v_tmp    text := 'fk_ai_summary_artifact_0007';
begin
  select true,
         (c.contype = 'f' and c.confrelid = 'recruitment.transcript_artifact'::regclass),
         (c.contype   = 'f'
          and c.confrelid  = 'recruitment.transcript_artifact'::regclass
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
   where c.conrelid = 'recruitment.ai_summary'::regclass
     and c.conname  = 'fk_ai_summary_artifact';

  -- 4.3.1 已是目标形态 → 幂等跳过
  if coalesce(v_ok, false) then
    raise notice '0007 GAP-D fk_ai_summary_artifact 已是 3 列（含 tenant_id）形态，跳过';
    return;
  end if;

  -- 4.3.2 旧键不存在（0001 没跑全 / 已被谁删过）→ 直接建目标形态
  if not coalesce(v_exists, false) then
    alter table recruitment.ai_summary
      add constraint fk_ai_summary_artifact
      foreign key (tenant_id, transcript_artifact_id, transcript_revision)
      references recruitment.transcript_artifact (tenant_id, id, source_revision)
      on update restrict on delete restrict;
    raise notice '0007 GAP-D 原 fk_ai_summary_artifact 不存在，已直接建 3 列形态';
    return;
  end if;

  -- 4.3.3 存在但不是目标形态：只允许删除**已知的 2 列旧形态**
  if not coalesce(v_is_fk, false) then
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c
     where c.conrelid = 'recruitment.ai_summary'::regclass
       and c.conname  = 'fk_ai_summary_artifact';
    raise exception 'AI_SUMMARY_ARTIFACT_FK_UNEXPECTED: 现有 fk_ai_summary_artifact 不是指向 transcript_artifact 的外键，拒绝替换。实际：%', v_def
      using errcode = '23514';
  end if;
  if v_cols is distinct from array['transcript_artifact_id', 'transcript_revision']::text[] then
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c
     where c.conrelid = 'recruitment.ai_summary'::regclass
       and c.conname  = 'fk_ai_summary_artifact';
    raise exception 'AI_SUMMARY_ARTIFACT_FK_UNEXPECTED: 现有 fk_ai_summary_artifact 的列集合既不是已知的 2 列旧形态，也不是 3 列目标形态，拒绝替换。实际：%', v_def
      using errcode = '23514';
  end if;

  -- 临时名若被占：拒绝（说明库里有上一轮/别人留下的半套对象）
  if exists (select 1 from pg_constraint c
              where c.conrelid = 'recruitment.ai_summary'::regclass
                and c.conname  = v_tmp) then
    raise exception 'AI_SUMMARY_ARTIFACT_FK_UNEXPECTED: 已存在临时约束 %（可能存在未清理的半套对象），拒绝继续', v_tmp
      using errcode = '23514';
  end if;

  -- 闸 1：先建新 3 列外键（临时名），DDL 会立即校验存量行
  alter table recruitment.ai_summary
    add constraint fk_ai_summary_artifact_0007
    foreign key (tenant_id, transcript_artifact_id, transcript_revision)
    references recruitment.transcript_artifact (tenant_id, id, source_revision)
    on update restrict on delete restrict;

  -- 闸 2：新键必须已 convalidated（不是 NOT VALID）
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'recruitment.ai_summary'::regclass
       and c.conname  = v_tmp
       and c.contype  = 'f'
       and c.convalidated)
  then
    raise exception 'AI_SUMMARY_ARTIFACT_FK_ABORT: 新 3 列外键未建立并验证，拒绝删旧键 —— 否则库里会静默回到"转写可跨租户引用"'
      using errcode = '23514';
  end if;

  -- 闸 3：删旧键、改名回正式名
  alter table recruitment.ai_summary drop constraint fk_ai_summary_artifact;
  alter table recruitment.ai_summary rename constraint fk_ai_summary_artifact_0007 to fk_ai_summary_artifact;
  raise notice '0007 GAP-D 已替换 fk_ai_summary_artifact：先建 3 列新键（convalidated）→ 删 2 列旧键 → 改名回正式名';
end $$;

-- 4.4 改完之后的闸：正式名必须是 3 列且 validated
do $$
declare
  v_n integer;
begin
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid  = 'recruitment.ai_summary'::regclass
     and c.conname   = 'fk_ai_summary_artifact'
     and c.contype   = 'f'
     and c.convalidated
     and c.confrelid = 'recruitment.transcript_artifact'::regclass
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['tenant_id', 'transcript_artifact_id', 'transcript_revision']::text[];
  if v_n <> 1 then
    raise exception 'AI_SUMMARY_ARTIFACT_FK_ABORT: fk_ai_summary_artifact 不是 3 列 validated 形态（% / 1）。拒绝继续 —— 否则库里会静默回到"转写可跨租户引用"。', v_n
      using errcode = '23514';
  end if;
  raise notice '0007 GAP-D 闸 PASS fk_ai_summary_artifact 已建立并 convalidated（3 列含 tenant_id）';
end $$;


-- =====================================================================
--  §5  GAP-E · 直接 INSERT 终态行绕过 actor（只有 scorecard 半边成立）
--
--  现状（实测）：scorecard 的 `status_changed_by_actor_id` 只有 UPDATE 路径
--        被 fn_row_guard 管；直接
--          insert into scorecard (..., status='SUBMITTED', submitted_at, items)
--  不写 actor 可以成功（exit=0）。WAIVED 同理。
--  改：两道，互补：
--    1. CHECK ck_scorecard_terminal_actor：终态行（非 PENDING）必须有
--       status_changed_by_actor_id。声明式、不可 disable、对 INSERT/UPDATE 都生效。
--    2. BEFORE INSERT 触发器 trg_scorecard_terminal_actor_guard：
--       终态行没写 actor 时，从 0001 的**可信服务端通道**
--       `SET LOCAL recruitment.actor_id` 取（与 fn_row_guard 的 UPDATE 路径同一口径）；
--       两条路都没有 → 23514 ACTOR_REQUIRED。
--       存在的意义：既有写入方（例如 db/verify.sql 的夹具）靠 session actor 表达
--       "谁提交的"，不应该因为本迁移而全挂；同时列最终一定被填上，CHECK 照样成立。
--
--  ⚠️ decision 侧：**本缺口不成立**，因为 decision 没有 status / status_changed_by_actor_id
--     列（实测 42703），而且 decided_by_actor_id NOT NULL + fk_decision_actor 已经在
--     INSERT 上强制了"同租户、真实存在的 actor"（实测 23502）。本文件不新造列。
-- =====================================================================

-- 5.1 前置检查：现存终态 scorecard 必须都已经有 actor
do $$
declare
  v_bad text;
begin
  select string_agg(format('scorecard=%s status=%s（status_changed_by_actor_id 为空）',
                           s.id, s.status), E'\n      ')
    into v_bad
    from recruitment.scorecard s
   where s.status <> 'PENDING'
     and s.status_changed_by_actor_id is null;
  if v_bad is not null then
    raise exception E'SCORECARD_TERMINAL_WITHOUT_ACTOR: 以下 scorecard 已是终态但不知道是谁提交/豁免的，新 CHECK 无法建立。\n      本迁移不会替你编一个 actor（那会伪造审计）：请人工确认这些面评的操作人后重跑。\n      %', v_bad
      using errcode = '23514';
  end if;
  raise notice '0007 GAP-E PRE-CHECK PASS 现有终态 scorecard 全部有 status_changed_by_actor_id（0 条缺 actor）';
end $$;

-- 5.2 CHECK：终态行必须有 actor（先查 pg_constraint）
do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'recruitment.scorecard'::regclass
     and c.conname  = 'ck_scorecard_terminal_actor';

  if v_def is not null then
    if v_def not like '%status_changed_by_actor_id%' or v_def not like '%PENDING%' then
      raise exception 'SCORECARD_TERMINAL_ACTOR_CHECK_UNEXPECTED: ck_scorecard_terminal_actor 已存在但定义与预期不符，拒绝覆盖。实际：%', v_def
        using errcode = '23514';
    end if;
    raise notice '0007 GAP-E ck_scorecard_terminal_actor 已存在，跳过';
    return;
  end if;

  alter table recruitment.scorecard
    add constraint ck_scorecard_terminal_actor
    check (status = 'PENDING' or status_changed_by_actor_id is not null);
  raise notice '0007 GAP-E 已加 ck_scorecard_terminal_actor：status <> ''PENDING'' 时必须有 status_changed_by_actor_id';
end $$;

-- 5.3 BEFORE INSERT 触发器：终态行缺 actor 时，从可信服务端通道取；都没有 → 拒绝
create or replace function recruitment.fn_scorecard_terminal_actor_guard() returns trigger
language plpgsql as $$
declare
  v_actor uuid;
begin
  if new.status = 'PENDING' then
    return new;
  end if;
  if new.status_changed_by_actor_id is not null then
    return new;
  end if;

  v_actor := nullif(current_setting('recruitment.actor_id', true), '')::uuid;
  if v_actor is null then
    raise exception
      'ACTOR_REQUIRED: scorecard 直接 INSERT 成终态（%）必须给出 actor（显式写 status_changed_by_actor_id，或 SET LOCAL recruitment.actor_id）',
      new.status
      using errcode = '23514';
  end if;

  new.status_changed_by_actor_id := v_actor;
  return new;
end $$;

do $$
declare
  v_exists boolean;
  v_ok     boolean;
begin
  select true,
         ((g.tgtype & 1)  = 1      -- FOR EACH ROW
          and (g.tgtype & 2)  = 2  -- BEFORE
          and (g.tgtype & 4)  = 4  -- INSERT
          and g.tgfoid = 'recruitment.fn_scorecard_terminal_actor_guard'::regproc)
    into v_exists, v_ok
    from pg_trigger g
   where g.tgrelid = 'recruitment.scorecard'::regclass
     and g.tgname  = 'trg_scorecard_terminal_actor_guard'
     and not g.tgisinternal;

  if coalesce(v_ok, false) then
    raise notice '0007 GAP-E trg_scorecard_terminal_actor_guard 已存在且形态正确，跳过';
    return;
  end if;

  if coalesce(v_exists, false) then
    raise exception 'SCORECARD_TERMINAL_ACTOR_TRIGGER_UNEXPECTED: trg_scorecard_terminal_actor_guard 已存在但不是 "before insert ... fn_scorecard_terminal_actor_guard" 形态，拒绝覆盖'
      using errcode = '23514';
  end if;

  create trigger trg_scorecard_terminal_actor_guard
    before insert on recruitment.scorecard
    for each row execute function recruitment.fn_scorecard_terminal_actor_guard();
  raise notice '0007 GAP-E 已挂 trg_scorecard_terminal_actor_guard（before insert → fn_scorecard_terminal_actor_guard）';
end $$;


-- =====================================================================
--  §6  迁移后自检（任何一条不满足 → raise → 整笔回滚，不留半套结构）
-- =====================================================================

do $$
declare
  v_bad   text;
  v_n     integer;
  v_cols  text[];
  v_def   text;
begin
  -- 6.1 GAP-A：外键形态（2 列含 tenant_id，指向 stage_catalog(tenant_id, code)，restrict/validated）
  select count(*) into v_n
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
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['stage_code', 'tenant_id']::text[]
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['code', 'tenant_id']::text[];
  if v_n <> 1 then
    raise exception '0007 POST-CHECK 失败 GAP-A：fk_decision_stage_catalog 形态不对（% / 1）', v_n;
  end if;

  -- 6.2 GAP-A：decision 上不允许再存在"不含 tenant_id 的 stage_code 外键"（后门）
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
    raise exception '0007 POST-CHECK 失败 GAP-A：存在不含 tenant_id 的 stage_code 外键（跨租户后门）：%', v_bad;
  end if;

  -- 6.3 GAP-B：部分唯一索引形态（unique + nulls not distinct + 列集合 + 谓词）
  select count(*) into v_n
    from pg_index i
   where i.indexrelid = to_regclass('recruitment.uq_decision_current')
     and i.indrelid   = 'recruitment.decision'::regclass
     and i.indisunique
     and i.indnullsnotdistinct
     and i.indpred is not null
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = i.indrelid and a.attnum = any(i.indkey))
         = array['application_id', 'decision_scope', 'stage_code', 'tenant_id']::text[]
     and pg_get_expr(i.indpred, i.indrelid) like '%superseded_by_decision_id IS NULL%';
  if v_n <> 1 then
    raise exception '0007 POST-CHECK 失败 GAP-B：uq_decision_current 形态不对（% / 1）', v_n;
  end if;

  -- 6.4 GAP-C：job_id 存在、uuid、NOT NULL、**无默认值**
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
    raise exception '0007 POST-CHECK 失败 GAP-C：scorecard.job_id 不存在';
  end if;
  if v_bad not like '%type=uuid%' then
    raise exception '0007 POST-CHECK 失败 GAP-C：scorecard.job_id 类型不是 uuid：%', v_bad;
  end if;
  if v_bad not like '%notnull=t%' then
    raise exception '0007 POST-CHECK 失败 GAP-C：scorecard.job_id 必须 NOT NULL：%', v_bad;
  end if;
  if v_bad not like '%default=（无）%' then
    raise exception '0007 POST-CHECK 失败 GAP-C：scorecard.job_id 不允许有默认值：%', v_bad;
  end if;

  -- 6.5 GAP-C：复合外键形态 + 被引用键
  select count(*) into v_n
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
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['job_id', 'rubric_version_id', 'tenant_id']::text[]
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['id', 'job_id', 'tenant_id']::text[];
  if v_n <> 1 then
    raise exception '0007 POST-CHECK 失败 GAP-C：fk_scorecard_rubric_job 形态不对（% / 1）', v_n;
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
    raise exception '0007 POST-CHECK 失败 GAP-C：rubric_version 缺 unique (tenant_id, job_id, id)';
  end if;

  -- 6.6 GAP-C：触发器在位且执行 fn_scorecard_job_guard
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'recruitment.scorecard'::regclass
     and g.tgname  = 'trg_scorecard_job_guard'
     and not g.tgisinternal
     and (g.tgtype & 20) = 20
     and g.tgfoid = 'recruitment.fn_scorecard_job_guard'::regproc;
  if v_n <> 1 then
    raise exception '0007 POST-CHECK 失败 GAP-C：trg_scorecard_job_guard 不在位（% / 1）', v_n;
  end if;

  -- 6.7 GAP-D：3 列外键 + 被引用键 + 无后门
  select count(*) into v_n
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
           where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
         = array['tenant_id', 'transcript_artifact_id', 'transcript_revision']::text[]
     and (select array_agg(a.attname::text order by a.attname)
            from pg_attribute a
           where a.attrelid = c.confrelid and a.attnum = any(c.confkey))
         = array['id', 'source_revision', 'tenant_id']::text[];
  if v_n <> 1 then
    raise exception '0007 POST-CHECK 失败 GAP-D：fk_ai_summary_artifact 不是 3 列 validated 形态（% / 1）', v_n;
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
    raise exception '0007 POST-CHECK 失败 GAP-D：transcript_artifact 缺 unique (tenant_id, id, source_revision)';
  end if;

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
    raise exception '0007 POST-CHECK 失败 GAP-D：ai_summary 上还有不含 tenant_id 的转写外键（跨租户后门）：%', v_bad;
  end if;

  -- 6.8 GAP-E：CHECK + 触发器都在（constraint 必须 validated）
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'recruitment.scorecard'::regclass
     and c.conname  = 'ck_scorecard_terminal_actor'
     and c.contype  = 'c'
     and c.convalidated;
  if v_def is null then
    raise exception '0007 POST-CHECK 失败 GAP-E：ck_scorecard_terminal_actor 不存在或未 validated';
  end if;
  if v_def not like '%status_changed_by_actor_id%' or v_def not like '%PENDING%' then
    raise exception '0007 POST-CHECK 失败 GAP-E：ck_scorecard_terminal_actor 定义不对：%', v_def;
  end if;

  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'recruitment.scorecard'::regclass
     and g.tgname  = 'trg_scorecard_terminal_actor_guard'
     and not g.tgisinternal
     and (g.tgtype & 4) = 4
     and g.tgfoid = 'recruitment.fn_scorecard_terminal_actor_guard'::regproc;
  if v_n <> 1 then
    raise exception '0007 POST-CHECK 失败 GAP-E：trg_scorecard_terminal_actor_guard 不在位（% / 1）', v_n;
  end if;

  -- 6.9 全库：多列外键全部含 tenant_id（GAP-D 之后不该再有例外）
  select string_agg(format('%s(%s)', c.conrelid::regclass, c.conname), ', ') into v_bad
    from pg_constraint c
   where c.contype = 'f'
     and cardinality(c.conkey) > 1
     and not exists (
       select 1 from unnest(c.conkey) k
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
        where a.attname = 'tenant_id');
  if v_bad is not null then
    raise exception '0007 POST-CHECK 失败：全库仍有不含 tenant_id 的多列外键：%', v_bad;
  end if;

  raise notice '0007 POST-CHECK PASS 五个缺口全部落地：'
    'A decision stage_code 复合外键（含 tenant_id）；'
    'B 当前决策唯一（NULLS NOT DISTINCT 部分唯一索引）；'
    'C scorecard.job_id NOT NULL + 复合外键 + 触发器；'
    'D ai_summary 3 列外键 + 被引用键 + 无后门；'
    'E scorecard 终态 CHECK + before insert actor 闸（decision 侧不成立，见 §5 抬头）';
end $$;

-- §7 改造后的现场（真实定义，作为"改造后"证据写进日志）
do $$
declare
  v_txt text;
begin
  select string_agg(format('%s = %s', c.conname, pg_get_constraintdef(c.oid)), E'\n      ')
    into v_txt
    from pg_constraint c
   where (c.conrelid = 'recruitment.decision'::regclass  and c.conname = 'fk_decision_stage_catalog')
      or (c.conrelid = 'recruitment.scorecard'::regclass and c.conname = 'fk_scorecard_rubric_job')
      or (c.conrelid = 'recruitment.scorecard'::regclass and c.conname = 'ck_scorecard_terminal_actor')
      or (c.conrelid = 'recruitment.ai_summary'::regclass and c.conname = 'fk_ai_summary_artifact')
      or (c.conrelid = 'recruitment.rubric_version'::regclass and c.conname = 'uq_rubric_version_tenant_job_id');
  raise notice E'0007 改造后的约束定义：\n      %', coalesce(v_txt, '（无）');

  select pg_get_indexdef(i.indexrelid) into v_txt
    from pg_index i
   where i.indexrelid = to_regclass('recruitment.uq_decision_current');
  raise notice '0007 改造后的当前决策唯一索引：%', coalesce(v_txt, '（无）');

  select string_agg(format('%s: %s', g.tgname, pg_get_triggerdef(g.oid)), E'\n      ')
    into v_txt
    from pg_trigger g
   where g.tgname in ('trg_scorecard_job_guard', 'trg_scorecard_terminal_actor_guard')
     and not g.tgisinternal;
  raise notice E'0007 改造后的触发器：\n      %', coalesce(v_txt, '（无）');

  raise notice '0007 DONE 五个完整性缺口已按上述范围修复（单事务提交；无默认值硬填；唯一数据写入是 GAP-C 的派生回填）';
end $$;


commit;


-- =====================================================================
--  回滚方式（反向 DDL，需人工确认；本文件只有 GAP-C 的派生回填会丢数据）
--
--    alter table recruitment.decision   drop constraint if exists fk_decision_stage_catalog;
--    drop index if exists recruitment.uq_decision_current;
--    drop trigger if exists trg_scorecard_job_guard             on recruitment.scorecard;
--    drop function if exists recruitment.fn_scorecard_job_guard();
--    drop trigger if exists trg_scorecard_terminal_actor_guard  on recruitment.scorecard;
--    drop function if exists recruitment.fn_scorecard_terminal_actor_guard();
--    alter table recruitment.scorecard  drop constraint if exists ck_scorecard_terminal_actor;
--    alter table recruitment.scorecard  drop constraint if exists fk_scorecard_rubric_job;
--    alter table recruitment.scorecard  drop column    if exists job_id;
--    alter table recruitment.ai_summary drop constraint if exists fk_ai_summary_artifact;
--    alter table recruitment.ai_summary add constraint fk_ai_summary_artifact
--      foreign key (transcript_artifact_id, transcript_revision)
--      references recruitment.transcript_artifact (id, source_revision);
--
--  ⚠️ 回滚前先确认：没有代码依赖"决策阶段必须存在""当前决策唯一""评分标准
--     必须属于该申请岗位""摘要转写必须同租户""终态面评必须有 actor"这五条保证。
--  ⚠️ 回滚会重新打开 GAP-A … GAP-E —— 这是**退回**，不是修复。
-- =====================================================================
