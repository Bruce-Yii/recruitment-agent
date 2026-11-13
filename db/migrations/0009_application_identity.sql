-- =====================================================================
--  recruitment-agent · 0009_application_identity.sql
--
--  Issue #1 §2.4：Application 的身份 = (candidate, job) 在**同一个有效申请周期**内。
--  不能用 file_sha / content_sha 决定"这是不是同一条申请"。
--
--  本迁移做三件事，全部单事务、先检查再改、不替人改数据：
--
--   §1 历史重复检测：同一 (tenant_id, candidate_id, job_id) 已有 >1 条 ACTIVE
--      → raise + 整笔回滚，逐行列出。**不猜哪条该保留**（Issue §2.4 / §5-G：
--      需要非破坏性方案 + 引用保留证明，那是人工裁决，不是迁移能替的）。
--
--   §2 部分唯一索引：uq_application_active_cycle
--      unique (tenant_id, candidate_id, job_id) where lifecycle_status = 'ACTIVE'
--      —— 库层保证"同一候选人对同一岗位同一时刻只有一条进行中的申请"。
--
--   §3 申请周期不可逆的守卫（最小）：
--      lifecycle_status 一旦离开 ACTIVE，不得再改回 ACTIVE（否则等于复活旧周期）。
--      before update 触发器，23514。
--
--  幂等：连跑两遍，第二遍零 ERROR / 零新增对象 / 零数据改动。
--  依赖：0001_init.sql（application / ck_application_lifecycle_status）。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- §1 历史重复检测
-- ---------------------------------------------------------------------
do $$
declare
  bad_count integer;
  detail    text;
begin
  select count(*) into bad_count from (
    select tenant_id, candidate_id, job_id
      from recruitment.application
     where lifecycle_status = 'ACTIVE'
     group by tenant_id, candidate_id, job_id
    having count(*) > 1
  ) d;

  if bad_count > 0 then
    select string_agg(
             format('  tenant=%s candidate=%s job=%s ids=%s',
                    tenant_id, candidate_id, job_id, ids), E'\n')
      into detail
      from (
        select tenant_id, candidate_id, job_id,
               string_agg(id::text, ',' order by created_at) as ids
          from recruitment.application
         where lifecycle_status = 'ACTIVE'
         group by tenant_id, candidate_id, job_id
        having count(*) > 1
      ) x;

    raise exception using
      errcode = '23505',
      message = format(
        'APPLICATION_ACTIVE_DUPLICATE: %s 组 (candidate, job) 已存在多条 ACTIVE 申请；'
        '不猜哪条该保留，请先人工处置后再迁移。', bad_count),
      detail  = detail;
  end if;
  raise notice '0009 §1 OK：无重复 ACTIVE 申请';
end $$;

-- ---------------------------------------------------------------------
-- §2 部分唯一索引（库层守卫）
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_indexes
     where schemaname = 'recruitment'
       and indexname  = 'uq_application_active_cycle'
  ) then
    -- 已存在：校验形态，不重建（幂等）
    if not exists (
      select 1 from pg_index i
        join pg_class c on c.oid = i.indexrelid
       where c.relname = 'uq_application_active_cycle'
         and i.indisunique
         and pg_get_expr(i.indpred, i.indrelid) ilike '%ACTIVE%'
    ) then
      raise exception using
        errcode = '23514',
        message = 'APPLICATION_ACTIVE_INDEX_UNEXPECTED: 已存在同名索引但形态不符，拒绝覆盖';
    end if;
    raise notice '0009 §2 已存在且形态正确，跳过';
  else
    execute $ddl$
      create unique index uq_application_active_cycle
        on recruitment.application (tenant_id, candidate_id, job_id)
        where lifecycle_status = 'ACTIVE'
    $ddl$;
    raise notice '0009 §2 已创建 uq_application_active_cycle';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- §3 申请周期不可逆（离开 ACTIVE 后不得复活）
-- ---------------------------------------------------------------------
create or replace function recruitment.fn_application_cycle_guard()
returns trigger
language plpgsql
as $$
begin
  if old.lifecycle_status = 'ACTIVE'
     and new.lifecycle_status = 'ACTIVE'
     and new.candidate_id is distinct from old.candidate_id then
    raise exception using
      errcode = '23514',
      message = 'APPLICATION_CANDIDATE_IMMUTABLE: 申请所属候选人不可改（换人是另一条申请）';
  end if;

  if old.lifecycle_status <> 'ACTIVE'
     and new.lifecycle_status = 'ACTIVE' then
    raise exception using
      errcode = '23514',
      message = 'APPLICATION_CYCLE_NOT_REVIVABLE: 已结束的申请周期不得改回 ACTIVE；再次申请请新建 Application';
  end if;

  return new;
end $$;

drop trigger if exists trg_application_cycle_guard on recruitment.application;
create trigger trg_application_cycle_guard
  before update on recruitment.application
  for each row execute function recruitment.fn_application_cycle_guard();

-- ---------------------------------------------------------------------
-- §4 后置自检
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname='recruitment' and indexname='uq_application_active_cycle'
  ) then
    raise exception '0009 POST-CHECK FAIL: uq_application_active_cycle 不存在';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgname='trg_application_cycle_guard' and not tgisinternal
  ) then
    raise exception '0009 POST-CHECK FAIL: trg_application_cycle_guard 不存在';
  end if;
  raise notice '0009 DONE：Application 身份由 (candidate, job, ACTIVE) 决定（单事务提交，无数据改动）';
end $$;

commit;
