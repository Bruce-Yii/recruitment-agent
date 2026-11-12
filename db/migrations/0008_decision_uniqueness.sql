-- =====================================================================
--  recruitment-agent · 0008_decision_uniqueness.sql
--
--  0007 已提交（10adbc8），但实测出两个问题；0008 只修这两个 + 一个同型缺口：
--
--  问题 ①（阻断级）· "当前决策唯一"是**部分唯一索引**，把重评事务夹死了
--    0007 的 uq_decision_current 是
--      unique index (tenant_id, application_id, decision_scope, stage_code)
--      nulls not distinct where superseded_by_decision_id is null
--    唯一性在**每条语句结束时**立即检查。于是契约
--    dsh/dsh-recruitment/contracts/job-screening/job-rubric-rules.md:159-163
--    规定的重评事务在同一事务里无解（实测，ra_v8 = 0001→0007）：
--      先 INSERT 新 current        → 23505（旧行还是 current，两条撞索引）
--      先 UPDATE 旧行指向新行      → 23503（fk_decision_superseded_by 是立即校验，
--                                    新行还不存在）
--    两条顺序都不通 → 一次重评无法在一个事务里完成。
--
--  问题 ② · 键里含 stage_code，FINAL/S10 与 FINAL/NULL 仍可同时 current
--    0007 的键是四列，stage_code 不同 = 键不同。实测 FINAL/S10 + FINAL/NULL
--    两条 current 可以 COMMIT 成功（SQLSTATE 无，INSERT 0 2 + COMMIT）——
--    而"同一个申请有两条互相矛盾的最终决策"正是最该防的场景。
--
--  同型缺口 · interview_record.rubric_version_id 没有绑定到"该申请的岗位"
--    0007 的 GAP-C 只补了 scorecard（实测 scorecard 有 rubric_version_id，
--    而 interview_record 也有同名列：0001:1188 `rubric_version_id uuid not null`，
--    fk_interview_record_rubric 只保证 (id, tenant_id) 存在、同租户，
--    **不保证是该申请的那个 job 的 rubric**）。所以本缺口成立，按 0007 §3 的
--    同一做法补：加 job_id + 复合外键 + 缺省填充触发器。
--
--  ============================ 改法（三条） ============================
--
--  A. 把"当前唯一"从部分唯一索引改成**可延迟的排斥约束**
--       alter table recruitment.decision
--         add constraint uq_decision_current
--         exclude using btree (tenant_id with =,
--                              application_id with =,
--                              decision_scope with =,
--                              (coalesce(stage_code, '')) with =)
--         where (superseded_by_decision_id is null)
--         deferrable initially deferred;
--
--     **为什么必须用 EXCLUDE，而不能继续用唯一索引**：
--       * 想让检查推迟到 COMMIT，唯一性必须由**可延迟约束**表达；
--         `CREATE UNIQUE INDEX` 没有 DEFERRABLE（只有表约束才可延迟）；
--         而可延迟的 UNIQUE 表约束**不支持 WHERE 谓词**（partial unique）；
--         我们要的恰恰是"只对 current 行唯一"这个 partial 语义。
--         PostgreSQL 里同时满足 "partial + deferrable" 的构造只有 EXCLUDE 约束。
--       * 排斥约束的语义是"两行的 WITH = 判为相等即冲突"。btree 的 `=` 对
--         NULL 返回 NULL（不是 true），所以两个 NULL 默认**不冲突**。
--         0007 用的 `NULLS NOT DISTINCT` 是唯一索引专属关键字，
--         `CREATE/ALTER ... EXCLUDE` 不接受它（语法层面就不存在这个位置）。
--         要让两个 NULL stage_code 在检查时算相等，只能把 NULL 映射成一个
--         与所有合法值都不相等的哨兵：这里用 `coalesce(stage_code, '')`。
--         空串是安全的：ck_decision_stage_code 要求
--         `stage_code ~ '^[A-Z][A-Z0-9_]{1,40}$'`（至少 2 个字符、首字符大写
--         字母），所以**没有任何合法 stage_code 会是空串**，NULL 与 NULL 撞、
--         NULL 与任何真实值不撞 —— 与 0007 的 NULLS NOT DISTINCT 语义等价。
--       * 键仍是 (tenant_id, application_id, decision_scope, stage_code)；
--         对象名保持 uq_decision_current（先建临时名、验形态、删旧索引、再改名）。
--
--     **目标**：同一个事务里先 INSERT 新 current、再 UPDATE 旧行指向新行 →
--     COMMIT 成功；COMMIT 时若仍有两条同键 current → 23P01（排斥约束冲突；
--     SQLSTATE 不再是 23505，见 db/DECISION-UNIQUENESS.md §7 残留）。
--
--  B. 闭合"每个申请最多一条 current FINAL"
--       alter table recruitment.decision
--         add constraint uq_decision_current_final
--         exclude using btree (tenant_id with =, application_id with =)
--         where (decision_scope = 'FINAL' and superseded_by_decision_id is null)
--         deferrable initially deferred;
--     同样必须 EXCLUDE（partial + deferrable），同样可延迟：FINAL 重评时
--     "先 INSERT 新 FINAL、再 UPDATE 旧 FINAL"中间态有两条 current FINAL，
--     但 COMMIT 前就修好了 → 合法。
--
--  C. interview_record.rubric_version_id 的同型岗位绑定（同 0007 §3 的做法）
--     1. interview_record 加 job_id（uuid，NOT NULL，**不设默认值**）；
--     2. 复合外键 (tenant_id, job_id, rubric_version_id) →
--          rubric_version (tenant_id, job_id, id)（复用 0004 的
--          uq_rubric_version_tenant_job_id）；
--     3. 触发器 fn_interview_record_job_guard 保证
--          interview_record.job_id = interview → application.job_id。
--
--     **为什么选 (a) 复合外键而不是纯触发器**（代价写在 db/DECISION-UNIQUENESS.md §5）：
--       * 外键是硬的，不能 disable；纯触发器可以被 disable / bulk load 绕过。
--       0007 §3 已经为 scorecard 做了同样选择，同一缺口用同一形状，运维/审计
--       只需要理解一套机制。
--       * 代价：多一份派生副本。application.job_id 目前**可变**（0001 §9.3 的
--       列级不可变清单里没有 application），改了它，已有 interview_record.job_id
--       会变成旧值；此后对该行任何 UPDATE 都会被触发器的"job_id 必须等于推导值"
--       拦下，直到人工把 job_id 修正。这不影响 INSERT（触发器按新推导值填）。
--       0007 的 scorecard.job_id 有同样的残留；本文件不扩大范围去冻结
--       application.job_id（那会改 0001 的业务语义），只把代价写清。
--       * 回填只填空值、值只来自既有外键链（interview.application_id →
--         application.job_id，两段都是 NOT NULL 外键），不是默认值、不猜；
--         已有 job_id 且与推导值不一致 → 报错，不覆盖。
--       * 回填是真实 UPDATE：PENDING 行的 record_version 会被 0001 的
--         trg_interview_record_guard_status（fn_row_guard）自增 1、updated_at
--         变成 now()。这是该触发器对所有 UPDATE 的固有行为，本文件**不 disable
--         任何护栏**来假装"什么都没发生"。
--
--  ======================= 与 0007 的关系 / 边界 =======================
--    * 不改 0001–0007 的一个字节（含 0007_decision_integrity.sql）：0008 只
--      新增列 / 换一个约束 / 加一个约束 / 加一个触发器。0007 的索引被本文件的
--      可延迟排斥约束**替换**（同一事务内：先建新约束 → 验形态 → 删旧索引 → 改名）。
--    * **不用 `drop ... if exists` 重建**：旧索引必须先被验证成 0007 的目标形态
--      才允许 drop；所有对象都先查 pg_constraint / pg_index / pg_trigger /
--      pg_proc 再建。
--    * 单事务：三段全有或全无。先检查再改：有脏数据（重复 current、跨岗位
--      rubric、解析不出的链）→ raise + 整笔回滚，并逐行列出；**不替人改数据**。
--    * 幂等：连续跑两遍，第二遍零 ERROR、零新增对象、零数据改动。
--
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0008_decision_uniqueness.sql
--        不要加 -1（本文件自带 begin/commit）。
-- =====================================================================

begin;


-- =====================================================================
--  §0  依赖 + 改造前的现场（只读，全部打进日志）
-- =====================================================================

do $$
declare
  v_missing text := '';
begin
  if to_regclass('recruitment.decision')         is null then v_missing := v_missing || 'decision ';         end if;
  if to_regclass('recruitment.interview_record') is null then v_missing := v_missing || 'interview_record '; end if;
  if to_regclass('recruitment.interview')        is null then v_missing := v_missing || 'interview ';        end if;
  if to_regclass('recruitment.application')      is null then v_missing := v_missing || 'application ';      end if;
  if to_regclass('recruitment.rubric_version')   is null then v_missing := v_missing || 'rubric_version ';   end if;
  if to_regclass('recruitment.actor')            is null then v_missing := v_missing || 'actor ';            end if;
  if v_missing <> '' then
    raise exception 'DECISION_UNIQUENESS_DEPENDENCY: 缺表 %（0008 依赖 0001）', v_missing
      using errcode = '42P01';
  end if;

  -- 0007 是必需依赖：C 段的形状与 0007 §3 一致，且被引用键来自 0004/0007。
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'recruitment.scorecard'::regclass
       and c.conname  = 'fk_scorecard_rubric_job'
       and c.contype  = 'f'
       and c.convalidated
  ) then
    raise exception 'DECISION_UNIQUENESS_DEPENDENCY: 0008 依赖 0007（fk_scorecard_rubric_job 不在位）。请先跑 db/migrations/0007_decision_integrity.sql'
      using errcode = '42P01';
  end if;

  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'recruitment.rubric_version'::regclass
       and c.contype  = 'u'
       and (select array_agg(a.attname::text order by a.attname)
              from pg_attribute a
             where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
           = array['id', 'job_id', 'tenant_id']::text[]
  ) then
    raise exception 'DECISION_UNIQUENESS_DEPENDENCY: rubric_version 缺 unique (tenant_id, job_id, id)（0004 的 uq_rubric_version_tenant_job_id / 0007 §3.6）'
      using errcode = '42P01';
  end if;

  raise notice '0008 DEPENDENCY PASS 依赖表齐全 + 0007 的 fk_scorecard_rubric_job 在位 + rubric_version unique (tenant_id, job_id, id) 在位';
end $$;

do $$
declare
  v_txt text;
  v_n   integer;
  v_col text;
begin
  -- 0.1 改造前：decision 上的索引（含 0007 的部分唯一索引）
  select string_agg(format('%s(unique=%s nulls_not_distinct=%s exclusion=%s pred=%s)',
                           c.relname, i.indisunique, i.indnullsnotdistinct, i.indisexclusion,
                           coalesce(pg_get_expr(i.indpred, i.indrelid), '无')), E'\n      ' order by c.relname)
    into v_txt
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'recruitment.decision'::regclass;
  raise notice E'0008 改造前 decision 的索引：\n      %', coalesce(v_txt, '（无）');

  -- 0.2 改造前：同键重复 current 的组数（A 段要建的约束会拒绝它们）
  select count(*) into v_n from (
    select 1 from recruitment.decision
     where superseded_by_decision_id is null
     group by tenant_id, application_id, decision_scope, coalesce(stage_code, '')
    having count(*) > 1) d;
  raise notice '0008 改造前 GAP-A：同 (tenant, application, scope, stage) 的重复 current 组数 = %（应为 0）', v_n;

  -- 0.3 改造前：每个申请有 >1 条 current FINAL 的组数（B 段要建的约束会拒绝它们）
  select count(*) into v_n from (
    select 1 from recruitment.decision
     where decision_scope = 'FINAL' and superseded_by_decision_id is null
     group by tenant_id, application_id
    having count(*) > 1) d;
  raise notice '0008 改造前 GAP-B：每个申请有 >1 条 current FINAL 的组数 = %（应为 0）', v_n;

  -- 0.4 改造前：interview_record 的 rubric 绑定现状
  select format('%s（%s）', a.attname, format_type(a.atttypid, a.atttypmod))
    into v_col
    from pg_attribute a
   where a.attrelid = 'recruitment.interview_record'::regclass
     and a.attname  = 'job_id'
     and a.attnum   > 0
     and not a.attisdropped;
  select count(*) into v_n from recruitment.interview_record;
  raise notice E'0008 改造前 GAP-C：interview_record 行数 = %；job_id 列 = %\n      interview_record.rubric_version_id 存在、fk_interview_record_rubric 只保证同租户存在，不保证"该申请的岗位"',
    v_n, coalesce(v_col, '尚未创建（将按 uuid 新建）');
end $$;


-- =====================================================================
--  §1  前置检查：有脏数据就停下（不替人改数据）
-- =====================================================================

-- 1.1 A 段：同 (tenant, application, decision_scope, coalesce(stage_code,''))
--     有不止一条 current → 排斥约束建不起来。逐组列出 id。
do $$
declare
  v_bad text;
begin
  select string_agg(format('tenant=%s application=%s scope=%s stage=%s ids=[%s]',
                           tenant_id, application_id, decision_scope, stage_label, ids), E'\n      ')
    into v_bad
    from (
      select tenant_id, application_id, decision_scope,
             case when stage_code is null then 'NULL' else stage_code end as stage_label,
             string_agg(id::text, ', ' order by decided_at, id) as ids,
             count(*) as n
        from recruitment.decision
       where superseded_by_decision_id is null
       group by tenant_id, application_id, decision_scope, stage_code
      having count(*) > 1
    ) d;

  if v_bad is not null then
    raise exception E'DECISION_CURRENT_DUPLICATE: 以下 (tenant, application, decision_scope, stage_code) 有不止一条 current 决策（superseded_by_decision_id IS NULL），可延迟排斥约束无法建立。\n      本迁移不会替你把其中一条标成 superseded（那等于替人决定哪条决策作废）。请人工确认保留哪一条后重跑。\n      %', v_bad
      using errcode = '23505';
  end if;
  raise notice '0008 GAP-A PRE-CHECK PASS 现有 decision 没有重复的 current 行（stage_code 的 NULL 按相等参与分组，0 组重复）';
end $$;

-- 1.2 B 段：同一个申请有 >1 条 current FINAL → 新的 FINAL 唯一约束建不起来。
do $$
declare
  v_bad text;
begin
  select string_agg(format('tenant=%s application=%s final_ids=[%s]',
                           tenant_id, application_id, ids), E'\n      ')
    into v_bad
    from (
      select tenant_id, application_id,
             string_agg(format('%s(stage=%s,result=%s)', id, coalesce(stage_code, 'NULL'), result),
                        ', ' order by decided_at, id) as ids,
             count(*) as n
        from recruitment.decision
       where decision_scope = 'FINAL' and superseded_by_decision_id is null
       group by tenant_id, application_id
      having count(*) > 1
    ) d;

  if v_bad is not null then
    raise exception E'DECISION_CURRENT_FINAL_DUPLICATE: 以下申请有不止一条 current FINAL 决策，新约束 uq_decision_current_final 无法建立。\n      本迁移不会替你作废任何一条最终决策（那等于替人决定录用结果）。请人工确认保留哪一条后重跑。\n      %', v_bad
      using errcode = '23505';
  end if;
  raise notice '0008 GAP-B PRE-CHECK PASS 现有 decision 每个申请最多一条 current FINAL（0 组重复）';
end $$;

-- 1.3 C 段：存量 interview_record 必须能解析出唯一 job_id，且 rubric 属于该岗位。
do $$
declare
  v_bad     text;
  v_has_col boolean;
begin
  select exists (
    select 1 from pg_attribute a
     where a.attrelid = 'recruitment.interview_record'::regclass
       and a.attname  = 'job_id'
       and a.attnum   > 0
       and not a.attisdropped
  ) into v_has_col;

  -- 1.3.1 interview → application 链解析不出 job_id
  select string_agg(format('interview_record=%s interview=%s tenant=%s',
                           r.id, r.interview_id, r.tenant_id), E'\n      ')
    into v_bad
    from recruitment.interview_record r
   where not exists (
     select 1
       from recruitment.interview i
       join recruitment.application a
         on a.id = i.application_id and a.tenant_id = i.tenant_id
      where i.id = r.interview_id
        and i.tenant_id = r.tenant_id);
  if v_bad is not null then
    raise exception E'INTERVIEW_RECORD_JOB_UNRESOLVED: 以下 interview_record 的 interview → application 链解析不出 job_id，复合外键无法建立。\n      本迁移不会替你猜岗位：请人工核对这些记录属于哪个申请。\n      %', v_bad
      using errcode = '23514';
  end if;

  -- 1.3.2 已经有 job_id 但与推导值不一致（别人手填过 / 上一次部分迁移留下的错值）
  if v_has_col then
    select string_agg(format('interview_record=%s job_id=%s 推导值=%s',
                             r.id, r.job_id, a.job_id), E'\n      ')
      into v_bad
      from recruitment.interview_record r
      join recruitment.interview i
        on i.id = r.interview_id and i.tenant_id = r.tenant_id
      join recruitment.application a
        on a.id = i.application_id and a.tenant_id = i.tenant_id
     where r.job_id is not null
       and r.job_id <> a.job_id;
    if v_bad is not null then
      raise exception E'INTERVIEW_RECORD_JOB_CONFLICT: 以下 interview_record 已有的 job_id 与 interview → application.job_id 推导值不一致。\n      本迁移不覆盖别人写过的值（覆盖会把"写错了"变成"看不出来写错过了"）：请人工确认哪个对。\n      %', v_bad
        using errcode = '23514';
    end if;
  end if;

  -- 1.3.3 rubric 的 job 与该申请的 job 不一致 → 新复合外键会拒绝（这就是缺口本身）
  select string_agg(format('interview_record=%s rubric=%s rubric_job=%s application_job=%s',
                           r.id, r.rubric_version_id, rv.job_id, a.job_id), E'\n      ')
    into v_bad
    from recruitment.interview_record r
    join recruitment.interview i
      on i.id = r.interview_id and i.tenant_id = r.tenant_id
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
    join recruitment.rubric_version rv
      on rv.id = r.rubric_version_id and rv.tenant_id = r.tenant_id
   where rv.job_id <> a.job_id;
  if v_bad is not null then
    raise exception E'INTERVIEW_RECORD_RUBRIC_JOB_MISMATCH: 以下 interview_record 用的评分标准属于**另一个岗位**（这就是 GAP-C 本身），复合外键无法建立。\n      本迁移不会替你换 rubric（换 rubric = 改评价标准）：请人工确认这些记录该保留还是作废后重跑。\n      %', v_bad
      using errcode = '23503';
  end if;

  raise notice '0008 GAP-C PRE-CHECK PASS 存量 interview_record：解析链 0 条断 / 已有 job_id 0 条冲突 / rubric 跨岗位 0 条';
end $$;


-- =====================================================================
--  §2  GAP-A · 把"当前唯一"从部分唯一索引改成可延迟排斥约束
--
--  三段式（同一事务）：
--    2.1 建临时名排斥约束（uq_decision_current_0008）
--    2.2 验证它 condeferrable / condeferred / convalidated / 定义符合预期
--    2.3 先验证旧索引确实是 0007 的目标形态，再 drop；然后改名成 uq_decision_current
--  这样在事务内的任何时刻都有保护，不存在"旧索引已删、新约束还没建"的窗口。
-- =====================================================================

do $$
declare
  v_ok      boolean;
  v_def     text;
  v_tmp_ok  boolean;
  v_old_ok  boolean;
  v_old_def text;
begin
  -- 2.1 已迁移？（第二遍走这里：零 DDL）
  select (c.contype = 'x'
          and c.condeferrable
          and c.condeferred
          and c.convalidated
          and lower(pg_get_constraintdef(c.oid)) like '%tenant_id with =%'
          and lower(pg_get_constraintdef(c.oid)) like '%application_id with =%'
          and lower(pg_get_constraintdef(c.oid)) like '%decision_scope with =%'
          and lower(pg_get_constraintdef(c.oid)) like '%coalesce(stage_code%'
          and lower(pg_get_constraintdef(c.oid)) like '%superseded_by_decision_id is null%'
          and lower(pg_get_constraintdef(c.oid)) like '%deferrable initially deferred%')
    into v_ok
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current';

  if coalesce(v_ok, false) then
    raise notice '0008 GAP-A uq_decision_current 已是可延迟排斥约束（condeferrable/condeferred/validated），跳过';
    return;
  end if;

  -- 2.2 同名对象存在但不是目标形态 → 拒绝覆盖
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current';
  if v_def is not null then
    raise exception 'DECISION_CURRENT_OBJECT_UNEXPECTED: 现有约束 uq_decision_current 不是目标形态（期望 EXCLUDE ... DEFERRABLE INITIALLY DEFERRED），拒绝覆盖。实际：%', v_def
      using errcode = '23514';
  end if;

  -- 2.3 临时名：已存在则必须已经是目标形态（否则拒绝）
  select (c.contype = 'x'
          and c.condeferrable
          and c.condeferred
          and c.convalidated
          and lower(pg_get_constraintdef(c.oid)) like '%coalesce(stage_code%'
          and lower(pg_get_constraintdef(c.oid)) like '%superseded_by_decision_id is null%'
          and lower(pg_get_constraintdef(c.oid)) like '%deferrable initially deferred%')
    into v_tmp_ok
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current_0008';

  if not coalesce(v_tmp_ok, false) then
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c
     where c.conrelid = 'recruitment.decision'::regclass
       and c.conname  = 'uq_decision_current_0008';
    if v_def is not null then
      raise exception 'DECISION_CURRENT_TMP_UNEXPECTED: 临时约束 uq_decision_current_0008 已存在但形态不对，拒绝覆盖。实际：%', v_def
        using errcode = '23514';
    end if;

    alter table recruitment.decision
      add constraint uq_decision_current_0008
      exclude using btree (
        tenant_id with =,
        application_id with =,
        decision_scope with =,
        (coalesce(stage_code, '')) with =
      )
      where (superseded_by_decision_id is null)
      deferrable initially deferred;
    raise notice '0008 GAP-A 已建临时排斥约束 uq_decision_current_0008：EXCLUDE (tenant_id, application_id, decision_scope, coalesce(stage_code, 空串)) WHERE 未取代 DEFERRABLE INITIALLY DEFERRED';
  else
    raise notice '0008 GAP-A 临时排斥约束 uq_decision_current_0008 已存在且形态正确，跳过创建';
  end if;

  -- 2.4 验证临时约束已就绪（在删旧索引之前）
  select (c.contype = 'x' and c.condeferrable and c.condeferred and c.convalidated)
    into v_ok
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current_0008';
  if not coalesce(v_ok, false) then
    raise exception 'DECISION_CURRENT_NOT_READY: 临时排斥约束未就绪（contype/condeferrable/condeferred/convalidated 不全是目标值），拒绝删旧索引'
      using errcode = '23514';
  end if;

  -- 2.5 旧索引：先验形态（0007 的目标形态），再 drop。不是 drop ... if exists 蒙混。
  if to_regclass('recruitment.uq_decision_current') is not null then
    select (i.indisunique
            and i.indnullsnotdistinct
            and i.indpred is not null
            and (select array_agg(a.attname::text order by a.attname)
                   from pg_attribute a
                  where a.attrelid = i.indrelid and a.attnum = any(i.indkey))
                = array['application_id', 'decision_scope', 'stage_code', 'tenant_id']::text[]
            and pg_get_expr(i.indpred, i.indrelid) like '%superseded_by_decision_id IS NULL%')
      into v_old_ok
      from pg_index i
     where i.indexrelid = to_regclass('recruitment.uq_decision_current');

    if not coalesce(v_old_ok, false) then
      select pg_get_indexdef(i.indexrelid) into v_old_def
        from pg_index i
       where i.indexrelid = to_regclass('recruitment.uq_decision_current');
      raise exception 'DECISION_CURRENT_INDEX_UNEXPECTED: 现有 uq_decision_current 不是 0007 的目标形态（unique + nulls not distinct + (tenant_id, application_id, decision_scope, stage_code) + where superseded_by_decision_id is null），拒绝替换。实际：%', v_old_def
        using errcode = '23514';
    end if;

    drop index recruitment.uq_decision_current;
    raise notice '0008 GAP-A 已删 0007 的部分唯一索引 uq_decision_current（已先验证新约束就绪 + 旧索引形态）';
  else
    raise notice '0008 GAP-A 旧的部分唯一索引不在位（可能已迁移过），跳过 drop';
  end if;

  -- 2.6 改名：对象名保持 uq_decision_current（改名同时把其 backing index 改名）
  alter table recruitment.decision
    rename constraint uq_decision_current_0008 to uq_decision_current;
  raise notice '0008 GAP-A 已将可延迟排斥约束改名为 uq_decision_current（符号名不变，语义从"立即唯一索引"变为"COMMIT 时检查的排斥约束"）';
end $$;


-- =====================================================================
--  §3  GAP-B · 每个申请最多一条 current FINAL
--
--  单查 pg_constraint；已存在且形态正确 → 跳过（第二遍零 DDL）。
-- =====================================================================

do $$
declare
  v_ok  boolean;
  v_def text;
begin
  select (c.contype = 'x'
          and c.condeferrable
          and c.condeferred
          and c.convalidated
          and lower(pg_get_constraintdef(c.oid)) like '%tenant_id with =%'
          and lower(pg_get_constraintdef(c.oid)) like '%application_id with =%'
          and lower(pg_get_constraintdef(c.oid)) like '%decision_scope = ''final''%'
          and lower(pg_get_constraintdef(c.oid)) like '%superseded_by_decision_id is null%'
          and lower(pg_get_constraintdef(c.oid)) like '%deferrable initially deferred%')
    into v_ok
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current_final';

  if coalesce(v_ok, false) then
    raise notice '0008 GAP-B uq_decision_current_final 已存在且形态正确（可延迟排斥约束），跳过';
    return;
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current_final';
  if v_def is not null then
    raise exception 'DECISION_CURRENT_FINAL_UNEXPECTED: 现有约束 uq_decision_current_final 不是目标形态，拒绝覆盖。实际：%', v_def
      using errcode = '23514';
  end if;

  alter table recruitment.decision
    add constraint uq_decision_current_final
    exclude using btree (
      tenant_id with =,
      application_id with =
    )
    where (decision_scope = 'FINAL' and superseded_by_decision_id is null)
    deferrable initially deferred;
  raise notice '0008 GAP-B 已建 uq_decision_current_final：EXCLUDE (tenant_id, application_id) WHERE scope=FINAL 且未取代 DEFERRABLE INITIALLY DEFERRED';
end $$;


-- =====================================================================
--  §4  GAP-C · interview_record 的评分标准必须属于"这个申请的那个岗位"
--      （与 0007 §3 完全同型，见文件头的"为什么选 (a)"）
-- =====================================================================

-- 4.1 列类型检查 + 加列（可空先加，回填后再收紧；不设默认值）
do $$
declare
  v_typ text;
begin
  select format_type(a.atttypid, a.atttypmod) into v_typ
    from pg_attribute a
   where a.attrelid = 'recruitment.interview_record'::regclass
     and a.attname  = 'job_id'
     and a.attnum   > 0
     and not a.attisdropped;

  if v_typ is not null and v_typ <> 'uuid' then
    raise exception 'INTERVIEW_RECORD_JOB_COLUMN_UNEXPECTED: interview_record.job_id 已存在但类型是 %（期望 uuid）。拒绝改列 —— 请人工核对。', v_typ
      using errcode = '42804';
  end if;

  if v_typ is null then
    alter table recruitment.interview_record add column job_id uuid;
    raise notice '0008 GAP-C 已加列 interview_record.job_id uuid（先可空；回填后收紧为 NOT NULL；无默认值）';
  else
    raise notice '0008 GAP-C interview_record.job_id 已存在（%），跳过加列', v_typ;
  end if;
  raise notice '0008 GAP-C PRE-CHECK A PASS interview_record.job_id 类型检查通过（%）',
    coalesce(v_typ, '尚未创建，已按 uuid 新建');
end $$;

-- 4.2 回填：只填 job_id IS NULL 的行，值只来自 interview → application.job_id
do $$
declare
  v_n integer;
begin
  update recruitment.interview_record r
     set job_id = d.job_id
    from (
      select ir.id as record_id, a.job_id
        from recruitment.interview_record ir
        join recruitment.interview i
          on i.id = ir.interview_id and i.tenant_id = ir.tenant_id
        join recruitment.application a
          on a.id = i.application_id and a.tenant_id = i.tenant_id
       where ir.job_id is null
    ) d
   where d.record_id = r.id;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    raise notice '0008 GAP-C 回填 interview_record.job_id：% 行（唯一推导 interview → application.job_id；这些行的 record_version 被 trg_interview_record_guard_status 自增 1 —— 见文件头）', v_n;
  else
    raise notice '0008 GAP-C interview_record.job_id 无需回填（0 行）';
  end if;
end $$;

-- 4.3 收紧为 NOT NULL（已 NOT NULL 时是 no-op，不重复 DDL）
do $$
begin
  if exists (
    select 1 from pg_attribute a
     where a.attrelid = 'recruitment.interview_record'::regclass
       and a.attname  = 'job_id'
       and a.attnum   > 0
       and not a.attisdropped
       and not a.attnotnull
  ) then
    alter table recruitment.interview_record alter column job_id set not null;
    raise notice '0008 GAP-C 已收紧 interview_record.job_id 为 NOT NULL';
  else
    raise notice '0008 GAP-C interview_record.job_id 已是 NOT NULL，跳过';
  end if;
end $$;

-- 4.4 复合外键（被引用键 = 0004 的 uq_rubric_version_tenant_job_id，§0 已证在位）
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
   where c.conrelid = 'recruitment.interview_record'::regclass
     and c.conname  = 'fk_interview_record_rubric_job';

  if coalesce(v_ok, false) then
    raise notice '0008 GAP-C fk_interview_record_rubric_job 已存在且形态正确，跳过';
    return;
  end if;

  if coalesce(v_exists, false) then
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c
     where c.conrelid = 'recruitment.interview_record'::regclass
       and c.conname  = 'fk_interview_record_rubric_job';
    raise exception 'INTERVIEW_RECORD_RUBRIC_JOB_FK_UNEXPECTED: 现有 fk_interview_record_rubric_job 不是目标形态（列集合 %），拒绝覆盖。实际：%', v_cols, v_def
      using errcode = '23514';
  end if;

  alter table recruitment.interview_record
    add constraint fk_interview_record_rubric_job
    foreign key (tenant_id, job_id, rubric_version_id)
    references recruitment.rubric_version (tenant_id, job_id, id)
    on update restrict on delete restrict;
  raise notice '0008 GAP-C 已加 fk_interview_record_rubric_job：(tenant_id, job_id, rubric_version_id) → rubric_version(tenant_id, job_id, id)';
end $$;

-- 4.5 触发器：interview_record.job_id 必须等于 interview → application.job_id
--     值为 NULL 时填充（唯一推导）；显式给了不一致的值 → 23514。
create or replace function recruitment.fn_interview_record_job_guard() returns trigger
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
      'INTERVIEW_RECORD_JOB_UNRESOLVED: interview_record 的面试 %（tenant=%）解析不出 application.job_id',
      new.interview_id, new.tenant_id
      using errcode = '23514';
  end if;

  if new.job_id is null then
    -- 唯一推导，不是默认值：值由两条 NOT NULL 外键链固定，无选择余地
    new.job_id := v_job;
  elsif new.job_id <> v_job then
    raise exception
      'INTERVIEW_RECORD_JOB_MISMATCH: interview_record 声称 job_id=% ，但面试 % 所属申请的岗位是 %（评分标准必须绑定该申请的岗位）',
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
          and g.tgfoid = 'recruitment.fn_interview_record_job_guard'::regproc)
    into v_exists, v_ok
    from pg_trigger g
   where g.tgrelid = 'recruitment.interview_record'::regclass
     and g.tgname  = 'trg_interview_record_job_guard'
     and not g.tgisinternal;

  if coalesce(v_ok, false) then
    raise notice '0008 GAP-C trg_interview_record_job_guard 已存在且形态正确，跳过';
    return;
  end if;

  if coalesce(v_exists, false) then
    raise exception 'INTERVIEW_RECORD_JOB_TRIGGER_UNEXPECTED: trg_interview_record_job_guard 已存在但不是 "before insert or update ... fn_interview_record_job_guard" 形态，拒绝覆盖'
      using errcode = '23514';
  end if;

  create trigger trg_interview_record_job_guard
    before insert or update on recruitment.interview_record
    for each row execute function recruitment.fn_interview_record_job_guard();
  raise notice '0008 GAP-C 已挂 trg_interview_record_job_guard（before insert or update → fn_interview_record_job_guard）';
end $$;


-- =====================================================================
--  §5  改造后的结构自检（任何一条不满足即整笔回滚）
-- =====================================================================

do $$
declare
  v_n   integer;
  v_bad text;
  v_def text;
begin
  -- 5.1 A：uq_decision_current 是排斥约束且可延迟
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current'
     and c.contype  = 'x'
     and c.condeferrable
     and c.condeferred
     and c.convalidated
     and lower(pg_get_constraintdef(c.oid)) like '%coalesce(stage_code%'
     and lower(pg_get_constraintdef(c.oid)) like '%superseded_by_decision_id is null%'
     and lower(pg_get_constraintdef(c.oid)) like '%deferrable initially deferred%'
     and c.conindid = to_regclass('recruitment.uq_decision_current');
  if v_n <> 1 then
    raise exception '0008 POST-CHECK 失败 GAP-A：uq_decision_current 不是"可延迟排斥约束 + backing index 同名"（% / 1）', v_n;
  end if;

  -- 5.2 A：0007 的部分唯一索引形态（unique + nulls not distinct + 谓词）必须已不存在
  select count(*) into v_n
    from pg_index i
   where i.indrelid = 'recruitment.decision'::regclass
     and i.indisunique
     and i.indnullsnotdistinct
     and i.indpred is not null
     and pg_get_expr(i.indpred, i.indrelid) like '%superseded_by_decision_id IS NULL%';
  if v_n <> 0 then
    raise exception '0008 POST-CHECK 失败 GAP-A：decision 上仍存在 0007 形态的部分唯一索引（% 个，应为 0）', v_n;
  end if;

  -- 5.3 B：uq_decision_current_final 存在且可延迟
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname  = 'uq_decision_current_final'
     and c.contype  = 'x'
     and c.condeferrable
     and c.condeferred
     and c.convalidated
     and lower(pg_get_constraintdef(c.oid)) like '%decision_scope = ''final''%'
     and lower(pg_get_constraintdef(c.oid)) like '%superseded_by_decision_id is null%'
     and lower(pg_get_constraintdef(c.oid)) like '%deferrable initially deferred%';
  if v_n <> 1 then
    raise exception '0008 POST-CHECK 失败 GAP-B：uq_decision_current_final 形态不对（% / 1）', v_n;
  end if;

  -- 5.4 C：job_id 存在、uuid、NOT NULL、无默认值
  select string_agg(format('type=%s notnull=%s default=%s',
                           format_type(a.atttypid, a.atttypmod), a.attnotnull,
                           coalesce(pg_get_expr(d.adbin, d.adrelid), '（无）')), ' ')
    into v_bad
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'recruitment.interview_record'::regclass
     and a.attname  = 'job_id'
     and a.attnum   > 0
     and not a.attisdropped;
  if v_bad is null then
    raise exception '0008 POST-CHECK 失败 GAP-C：interview_record.job_id 不存在';
  end if;
  if v_bad not like '%type=uuid%'     then raise exception '0008 POST-CHECK 失败 GAP-C：job_id 类型不是 uuid：%', v_bad; end if;
  if v_bad not like '%notnull=t%'     then raise exception '0008 POST-CHECK 失败 GAP-C：job_id 必须 NOT NULL：%', v_bad; end if;
  if v_bad not like '%default=（无）%' then raise exception '0008 POST-CHECK 失败 GAP-C：job_id 不允许有默认值：%', v_bad; end if;

  -- 5.5 C：复合外键形态
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid  = 'recruitment.interview_record'::regclass
     and c.conname   = 'fk_interview_record_rubric_job'
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
    raise exception '0008 POST-CHECK 失败 GAP-C：fk_interview_record_rubric_job 形态不对（% / 1）', v_n;
  end if;

  -- 5.6 C：触发器 + 函数
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'recruitment.interview_record'::regclass
     and g.tgname  = 'trg_interview_record_job_guard'
     and not g.tgisinternal
     and (g.tgtype & 20) = 20
     and g.tgfoid = 'recruitment.fn_interview_record_job_guard'::regproc;
  if v_n <> 1 then
    raise exception '0008 POST-CHECK 失败 GAP-C：trg_interview_record_job_guard 不在位（% / 1）', v_n;
  end if;

  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'recruitment'::regnamespace
     and p.proname = 'fn_interview_record_job_guard';
  if v_n <> 1 then
    raise exception '0008 POST-CHECK 失败 GAP-C：fn_interview_record_job_guard 不存在或重名（% / 1）', v_n;
  end if;

  raise notice '0008 POST-CHECK PASS A 可延迟排斥约束（键含 coalesce(stage_code, 空串)）/ B 每个申请最多一条 current FINAL / C interview_record.job_id NOT NULL + 复合外键 + 触发器';
end $$;


-- =====================================================================
--  §6  数据面全库断言（迁移后仍必须成立）
-- =====================================================================

do $$
declare
  v_n   integer;
  v_bad text;
begin
  -- 6.1 没有重复的 current 决策（键含 coalesce(stage_code,'')，NULL 按相等处理）
  select count(*) into v_n from (
    select 1 from recruitment.decision
     where superseded_by_decision_id is null
     group by tenant_id, application_id, decision_scope, coalesce(stage_code, '')
    having count(*) > 1) d;
  if v_n <> 0 then
    raise exception 'DATA-0008-01 仍有 % 组重复的 current 决策', v_n;
  end if;
  raise notice 'DATA-0008-01 PASS 全库没有重复的 current 决策（NULL stage_code 也按相等处理）';

  -- 6.2 每个申请最多一条 current FINAL
  select count(*) into v_n from (
    select 1 from recruitment.decision
     where decision_scope = 'FINAL' and superseded_by_decision_id is null
     group by tenant_id, application_id
    having count(*) > 1) d;
  if v_n <> 0 then
    raise exception 'DATA-0008-02 仍有 % 个申请有 >1 条 current FINAL', v_n;
  end if;
  raise notice 'DATA-0008-02 PASS 全库每个申请最多一条 current FINAL';

  -- 6.3 没有 interview_record.job_id IS NULL
  select count(*) into v_n from recruitment.interview_record where job_id is null;
  if v_n <> 0 then
    raise exception 'DATA-0008-03 仍有 % 条 interview_record 的 job_id 为空', v_n;
  end if;
  raise notice 'DATA-0008-03 PASS 全部 interview_record 都有 job_id（NOT NULL 生效）';

  -- 6.4 没有 rubric 不属于该申请岗位的 interview_record
  select count(*) into v_n
    from recruitment.interview_record r
    join recruitment.interview i
      on i.id = r.interview_id and i.tenant_id = r.tenant_id
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
    join recruitment.rubric_version rv
      on rv.id = r.rubric_version_id and rv.tenant_id = r.tenant_id
   where rv.job_id <> a.job_id;
  if v_n <> 0 then
    raise exception 'DATA-0008-04 仍有 % 条 interview_record 用了别的岗位的 rubric', v_n;
  end if;
  raise notice 'DATA-0008-04 PASS 全部 interview_record 的 rubric 都属于该申请的岗位';

  -- 6.5 全库：多列外键全部含 tenant_id（新外键不得破 0007 §6.9 的不变量）
  select string_agg(format('%s(%s)', c.conrelid::regclass, c.conname), ', ') into v_bad
    from pg_constraint c
   where c.contype = 'f'
     and cardinality(c.conkey) > 1
     and not exists (
       select 1 from unnest(c.conkey) k
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
        where a.attname = 'tenant_id');
  if v_bad is not null then
    raise exception 'DATA-0008-05 全库仍有不含 tenant_id 的多列外键：%', v_bad;
  end if;
  raise notice 'DATA-0008-05 PASS 全库多列外键全部含 tenant_id（含本文件新增的 fk_interview_record_rubric_job）';
end $$;


-- =====================================================================
--  §7  改造后的现场（真实定义，作为"改造后"证据写进日志）
-- =====================================================================

do $$
declare
  v_txt text;
  v_n   integer;
begin
  select string_agg(format('%s = %s', c.conname, pg_get_constraintdef(c.oid)), E'\n      ')
    into v_txt
    from pg_constraint c
   where c.conrelid = 'recruitment.decision'::regclass
     and c.conname in ('uq_decision_current', 'uq_decision_current_final');
  raise notice E'0008 改造后的当前决策唯一性约束：\n      %', coalesce(v_txt, '（无）');

  select string_agg(format('%s', pg_get_indexdef(i.indexrelid)), E'\n      ')
    into v_txt
    from pg_index i
   where i.indrelid = 'recruitment.decision'::regclass
     and i.indisexclusion;
  raise notice E'0008 改造后 decision 上的排斥索引（backing index，注意 indisunique=f）：\n      %', coalesce(v_txt, '（无）');

  select pg_get_constraintdef(c.oid) into v_txt
    from pg_constraint c
   where c.conrelid = 'recruitment.interview_record'::regclass
     and c.conname  = 'fk_interview_record_rubric_job';
  raise notice '0008 改造后的 fk_interview_record_rubric_job：%', coalesce(v_txt, '（无）');

  select string_agg(format('%s: %s', g.tgname, pg_get_triggerdef(g.oid)), E'\n      ')
    into v_txt
    from pg_trigger g
   where g.tgname = 'trg_interview_record_job_guard'
     and not g.tgisinternal;
  raise notice E'0008 改造后的触发器：\n      %', coalesce(v_txt, '（无）');

  select count(*) into v_n from recruitment.interview_record;
  raise notice '0008 DONE 三段全部落地（单事务提交；唯一数据写入是 GAP-C 的派生回填）。interview_record 现存 % 行', v_n;
end $$;


commit;


-- =====================================================================
--  回滚方式（反向 DDL，需人工确认；本文件只有 GAP-C 的派生回填会丢数据）
--
--    -- A：可延迟排斥约束 → 退回 0007 的部分唯一索引
--    alter table recruitment.decision drop constraint if exists uq_decision_current;
--    create unique index uq_decision_current
--      on recruitment.decision (tenant_id, application_id, decision_scope, stage_code)
--      nulls not distinct
--      where superseded_by_decision_id is null;
--
--    -- B
--    alter table recruitment.decision drop constraint if exists uq_decision_current_final;
--
--    -- C
--    drop trigger  if exists trg_interview_record_job_guard on recruitment.interview_record;
--    drop function if exists recruitment.fn_interview_record_job_guard();
--    alter table recruitment.interview_record drop constraint if exists fk_interview_record_rubric_job;
--    alter table recruitment.interview_record drop column    if exists job_id;
--
--  ⚠️ 回滚 A 会把"同一事务内先 INSERT 新 current 再 UPDATE 旧行"重新夹死
--     （23505），并把 FINAL/S10 与 FINAL/NULL 并存的洞重新打开。
--  ⚠️ 回滚 C 会重新打开"面试记录可以用别的岗位的 rubric"。
--  ⚠️ 回滚会重新打开 GAP-A / GAP-B / GAP-C —— 这是**退回**，不是修复。
-- =====================================================================
