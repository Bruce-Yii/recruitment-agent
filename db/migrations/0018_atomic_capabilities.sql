-- =====================================================================
--  recruitment-agent · 0018_atomic_capabilities.sql
--
--  主题：三个"原子写能力"的**结构面**（docs/29 §3.7 AT-1 ~ AT-7）。
--  工具面保持 32 不变：三件事都通过给现有工具加可选参数完成，不新增工具。
--
--  A · 跨岗携带历史（AT-1/2/3）
--    * 新表 recruitment.application_carry_over（append-only，禁删禁改）：
--      一行 = "把源申请的某个引用带到目标申请"这一个历史事实。
--    * 唯一键 (tenant_id, application_id, source_application_id, ref_kind, ref_id)
--      保证 AT-3 幂等（重复提交 → 不产生第二行，由工具的幂等分支吞掉）。
--    * 旧申请一行都不许改（AT-1）：本迁移**没有任何** update application 的语句；
--      carry_over 只 INSERT，源申请只读。
--    * 同候选人 / 同租户 / 源≠目标 / ref 确实属于源申请（AT-2）：
--      工具在事务内 fail-closed 校验；本迁移另加库级触发器 trg_application_carry_over_same_candidate
--      做第二道防线（两个 application 必须同 tenant + 同 candidate，且 id 不同），
--      ref 归属由工具按 ref_kind 逐表校验（库级无法用一条通用外键表达三种 ref）。
--
--  B · 加面 / 换人（AT-4/5）
--    * interview 加可空列 round_label（自定义轮次标签，如 '加面 · 交叉评估'）；
--      round_no 语义与唯一键 uq_interview_slot **一律不变** —— 标签只是显示层附加事实。
--    * interviewer 加可空列 replaced_by_interviewer_id / replaced_at / replacement_reason：
--      换人 = **追加**新分配行 + 把旧行标记被谁替换（旧行不删，AT-5）；
--      三个列要么全空要么全有（ck_interviewer_replacement_consistent），
--      且不能自己替换自己（ck_interviewer_not_self_replaced）。
--      新面评只挂新人：由工具把旧行 required_scorecard 置 false（既有语义）并在读投影展示。
--
--  C · 带人工原话跳轮 / 豁免面评（AT-6/7）
--    * **没有新表/新列**：override 只走既有 event_inbox + application 阶段 UPDATE，
--      新事件类型在 src/runtime/event-types.ts 登记（本迁移不重复登记）。
--      审计 payload 必含 reason / confirmed_by_actor_id / confirmed_at /
--      confirmation_text_sha256 / from_stage / to_stage（AT-7）。
--
--  幂等：create table / add column / create index / drop+create trigger 全部 guarded；
--  迁移台账自登记 version='0018_atomic_capabilities'（照 0016/0017 写法）。
--  依赖：0001（organization / application / actor / fn_block_delete / fn_guard_columns）；
--        0009（application 复合身份）；0017（append-only 模式样板）。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
--  A · application_carry_over（跨岗携带历史）
-- ---------------------------------------------------------------------
create table if not exists recruitment.application_carry_over (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references recruitment.organization (id),
  application_id        uuid not null,
  source_application_id uuid not null,
  ref_kind              text not null,
  ref_id                uuid not null,
  carried_by_actor_id   uuid not null,
  created_at            timestamptz not null default now(),

  constraint uq_application_carry_over_id_tenant unique (id, tenant_id),

  -- AT-3：同一 (源, 目标, 引用) 只能有一行；重试不会冒出第二条。
  constraint uq_application_carry_over_ref
    unique (tenant_id, application_id, source_application_id, ref_kind, ref_id),

  -- 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）
  constraint fk_carry_over_application foreign key (application_id, tenant_id)
    references recruitment.application (id, tenant_id),
  constraint fk_carry_over_source_application foreign key (source_application_id, tenant_id)
    references recruitment.application (id, tenant_id),
  constraint fk_carry_over_actor foreign key (carried_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),

  -- 值域闭集 / 形状约束
  constraint ck_carry_over_ref_kind check (ref_kind in ('SCORECARD','TRANSCRIPT','DECISION')),
  constraint ck_carry_over_distinct_application check (application_id <> source_application_id)
);

-- 目标申请维度的时间线查询（application_get 的 carry_over 段）。
create index if not exists ix_carry_over_application
  on recruitment.application_carry_over (tenant_id, application_id, created_at);

-- 源申请维度反查（证明"从哪些申请带过来了什么"）。
create index if not exists ix_carry_over_source
  on recruitment.application_carry_over (tenant_id, source_application_id);

-- append-only：任何 DELETE 都 23514（与 0001 §9.1 / 0017 同款）。
drop trigger if exists trg_application_carry_over_no_delete on recruitment.application_carry_over;
create trigger trg_application_carry_over_no_delete before delete on recruitment.application_carry_over
  for each row execute function recruitment.fn_block_delete();

-- 不可变：历史引用行一个业务列都不许改（fn_guard_columns() 无白名单 ⇒ 全列禁止）。
drop trigger if exists trg_application_carry_over_immutable on recruitment.application_carry_over;
create trigger trg_application_carry_over_immutable before update on recruitment.application_carry_over
  for each row execute function recruitment.fn_guard_columns();

-- AT-2 库级第二道防线：源申请与目标申请必须同租户 + 同候选人。
-- 工具层已经在事务内校验并 fail-closed；这里防止任何人绕过工具直接写库。
create or replace function recruitment.fn_carry_over_same_candidate() returns trigger
language plpgsql as $fn$
declare
  v_target_candidate uuid;
  v_source_candidate uuid;
begin
  select candidate_id into v_target_candidate
    from recruitment.application
   where id = new.application_id and tenant_id = new.tenant_id;
  select candidate_id into v_source_candidate
    from recruitment.application
   where id = new.source_application_id and tenant_id = new.tenant_id;
  if v_target_candidate is null or v_source_candidate is null then
    raise exception using
      errcode = '23503',
      message = 'carry_over 的源/目标申请必须属于本租户';
  end if;
  if v_target_candidate <> v_source_candidate then
    raise exception using
      errcode = '23514',
      message = 'AT-2：跨岗携带历史只允许同一候选人的申请之间';
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_application_carry_over_same_candidate on recruitment.application_carry_over;
create trigger trg_application_carry_over_same_candidate before insert on recruitment.application_carry_over
  for each row execute function recruitment.fn_carry_over_same_candidate();

-- ---------------------------------------------------------------------
--  B · 加面标签 + 换人可追溯
-- ---------------------------------------------------------------------

-- AT-4：自定义轮次标签。round_no / uq_interview_slot 不变。
alter table recruitment.interview add column if not exists round_label text;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'recruitment.interview'::regclass
       and conname = 'ck_interview_round_label') then
    alter table recruitment.interview
      add constraint ck_interview_round_label
      check (round_label is null or char_length(btrim(round_label)) between 1 and 200);
  end if;
end $$;

-- AT-5：旧分配行标记被谁替换（不删行），新分配行追加。
alter table recruitment.interviewer add column if not exists replaced_by_interviewer_id uuid;
alter table recruitment.interviewer add column if not exists replaced_at timestamptz;
alter table recruitment.interviewer add column if not exists replacement_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'recruitment.interviewer'::regclass
       and conname = 'fk_interviewer_replaced_by') then
    alter table recruitment.interviewer
      add constraint fk_interviewer_replaced_by foreign key (replaced_by_interviewer_id, tenant_id)
      references recruitment.interviewer (id, tenant_id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'recruitment.interviewer'::regclass
       and conname = 'ck_interviewer_replacement_consistent') then
    alter table recruitment.interviewer
      add constraint ck_interviewer_replacement_consistent check (
        (replaced_by_interviewer_id is null and replaced_at is null and replacement_reason is null)
        or (replaced_by_interviewer_id is not null and replaced_at is not null
            and char_length(btrim(replacement_reason)) between 1 and 500));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'recruitment.interviewer'::regclass
       and conname = 'ck_interviewer_not_self_replaced') then
    alter table recruitment.interviewer
      add constraint ck_interviewer_not_self_replaced
      check (replaced_by_interviewer_id is null or replaced_by_interviewer_id <> id);
  end if;
end $$;

-- 换人时间线查询（interview_get 的替换展示）。
create index if not exists ix_interviewer_replacement
  on recruitment.interviewer (tenant_id, interview_id, replaced_at)
  where replaced_by_interviewer_id is not null;

-- ---------------------------------------------------------------------
--  迁移台账自登记（0010 §规则第 1 条；与 0016/0017 同款）
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0018_atomic_capabilities',
            '原子写能力：跨岗携带历史（append-only + 同候选人 + 幂等唯一键）+ 加面标签 + 换人可追溯（旧行标记、不删除）')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
