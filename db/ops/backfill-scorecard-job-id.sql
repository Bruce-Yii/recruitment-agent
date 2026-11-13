-- =====================================================================
--  ops/backfill-scorecard-job-id.sql
--
--  一次性运维脚本：把"已终态但缺 job_id"的 scorecard 回填成申请推出的岗位。
--  唯一用途：解除 0007 的 SCORECARD_JOB_BACKFILL_BLOCKED。
--
--  依据：db/DECISION-INTEGRITY.md §7（原文逐字照做，不改判据）。
--
--  为什么必须在事务里 disable 两条护栏：
--    trg_scorecard_guard_status       —— 禁止改终态行的评价内容
--    trg_scorecard_submitted_guard    —— 禁止改已提交面评
--  回填的只是**派生列** job_id（可从 interview→application 唯一推出），
--  不碰 record_version / updated_at / items / overall，所以不算"改评价"。
--  事务提交前必须恢复两条护栏；任何一步失败整笔回滚。
--
--  ⚠️ 这是本项目**唯一**允许 disable 护栏的地方，且必须：
--     1) 由人授权后执行（2026-11-14 用户批准"1 可以"）；
--     2) 先跑下面的诊断 SELECT 逐行确认；
--     3) 在同一个事务内恢复护栏；
--     4) 把执行输出存档（evidence）。
--     迁移自己**不做**这件事 —— 迁移替人决定"已提交面评可以改"是反模式。
-- =====================================================================

-- ── 0) 诊断：先看清是哪几行、推出的 job_id 是什么 ──────────────────────
-- 首跑 0007 失败时 scorecard.job_id 这一列还不存在，所以这里用动态 SQL：
-- 列在就列出待回填的行，不在就只报一句提示（0007 的报错清单里有 id）。
do $$
declare
  has_col boolean;
  r       record;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'recruitment' and table_name = 'scorecard' and column_name = 'job_id'
  ) into has_col;

  if not has_col then
    raise notice 'scorecard.job_id 尚不存在（0007 未成功跑过）；待回填行见 0007 报错清单，'
                 '本脚本第 1 步会先加列再回填。';
  else
    raise notice '待回填 scorecard（job_id 为空）：';
    for r in
      select s.id, s.status, s.interview_id, i.application_id, a.job_id as derived_job_id
        from recruitment.scorecard s
        join recruitment.interview i   on i.id = s.interview_id and i.tenant_id = s.tenant_id
        join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
       where s.job_id is null
    loop
      raise notice '  scorecard=% status=% interview=% application=% derived_job_id=%',
        r.id, r.status, r.interview_id, r.application_id, r.derived_job_id;
    end loop;
  end if;
end $$;

-- ── 1) 回填（单事务）──────────────────────────────────────────────────
begin;

-- 0007 首跑失败会整笔回滚，所以 job_id 列可能还不存在，这里补上
alter table recruitment.scorecard add column if not exists job_id uuid;

alter table recruitment.scorecard disable trigger trg_scorecard_guard_status;
alter table recruitment.scorecard disable trigger trg_scorecard_submitted_guard;

update recruitment.scorecard s
   set job_id = d.job_id
  from (select sc.id as scorecard_id, a.job_id
          from recruitment.scorecard sc
          join recruitment.interview i   on i.id = sc.interview_id and i.tenant_id = sc.tenant_id
          join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
         where sc.job_id is null) d
 where d.scorecard_id = s.id;

alter table recruitment.scorecard enable trigger trg_scorecard_guard_status;
alter table recruitment.scorecard enable trigger trg_scorecard_submitted_guard;

-- 提交前自检：护栏必须已恢复、且不再有 NULL
do $$
declare
  still_null integer;
  disabled   integer;
begin
  select count(*) into still_null from recruitment.scorecard where job_id is null;
  select count(*) into disabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment' and c.relname = 'scorecard'
     and t.tgname in ('trg_scorecard_guard_status','trg_scorecard_submitted_guard')
     and t.tgenabled = 'D';
  if still_null > 0 then
    raise exception 'BACKFILL_INCOMPLETE: 仍有 % 行 job_id 为空', still_null;
  end if;
  if disabled > 0 then
    raise exception 'TRIGGER_NOT_RESTORED: 仍有 % 条护栏处于 disable', disabled;
  end if;
end $$;

commit;
