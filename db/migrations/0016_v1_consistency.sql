-- =====================================================================
--  recruitment-agent · 0016_v1_consistency.sql   （draft，总控）
--
--  主题：v1.0 收口的两块**机检/审计**地基（G3 + G10）：
--    1) 阶段-材料-面评一致性视图：把“S9+ 必须有 canonical READY 转写、
--       S10 必须有 ≥1 份 SUBMITTED 面评”变成可查询的违规行（0 行 = 合规），
--       供 health / 验收 / CI 机检；业务闸门仍由 stage-advance 代码负责。
--    2) event_disposition 表：每条进入 event_inbox 的事件最终必须留下
--       FILTERED / EVALUATED / FANNED_OUT 之一（G10），
--       并把存量 IGNORED / ROUTED 事件回填为可解释的处置（不重放历史）。
--
--  为什么违规用视图而不是触发器：这是**审计/机检**，不是业务约束；
--  用视图可以随时重算、可在 CI 里 count(*)=0，且不会在历史数据上
--  制造一次性的“补数据”迁移。
--
--  依赖：0001（event_inbox/organization）、0004（stage_catalog）、
--        0007/0011（scorecard/interview）、0010（迁移台账）。
--  幂等：create table if not exists / create or replace view /
--        drop trigger if exists + create trigger / 回填 on conflict do nothing。
-- =====================================================================

begin;

-- =====================================================================
--  §1  G3：阶段-材料-面评一致性视图（只列违规；0 行 = 合规）
--
--  S9+：该申请必须有一条 canonical 且 transcript_status='READY' 的转写
--       （经 meeting_binding → interview 关联）。
--  S10：该申请必须至少有 1 份 status='SUBMITTED' 的面评。
--
--  阶段先后用 stage_catalog.sort_order 判断（不能按 code 字符串比较：
--  'S10' < 'S9' 在字符串序下成立，会把 S10 误判成 S9 之前）。
-- =====================================================================

create or replace view recruitment.v_application_stage_consistency as
with app_stage as (
  select a.id            as application_id,
         a.tenant_id,
         a.current_stage_code,
         sc.sort_order   as stage_sort_order,
         s9.sort_order   as s9_sort_order,
         s10.sort_order  as s10_sort_order
    from recruitment.application a
    join recruitment.stage_catalog sc
      on sc.tenant_id = a.tenant_id and sc.code = a.current_stage_code
    left join recruitment.stage_catalog s9
      on s9.tenant_id = a.tenant_id and s9.code = 'S9'
    left join recruitment.stage_catalog s10
      on s10.tenant_id = a.tenant_id and s10.code = 'S10'
),
material as (
  select i.application_id,
         i.tenant_id,
         bool_or(
           ta.is_canonical
           and ta.transcript_status = 'READY'
         ) as has_ready_canonical_transcript
    from recruitment.interview i
    join recruitment.meeting_binding mb
      on mb.tenant_id = i.tenant_id
     and mb.interview_id = i.id
     and mb.unbound_at is null
    join recruitment.transcript_artifact ta
      on ta.tenant_id = mb.tenant_id
     and ta.meeting_id = mb.meeting_id
   group by i.application_id, i.tenant_id
),
scores as (
  select i.application_id,
         i.tenant_id,
         count(*) filter (where sc.status = 'SUBMITTED') as submitted_scorecards
    from recruitment.interview i
    join recruitment.scorecard sc
      on sc.tenant_id = i.tenant_id
     and sc.interview_id = i.id
   group by i.application_id, i.tenant_id
)
select st.application_id,
       st.tenant_id,
       st.current_stage_code,
       'S9_WITHOUT_READY_TRANSCRIPT'::text as violation_code,
       jsonb_build_object(
         'required', 'canonical READY transcript',
         'has_ready_canonical_transcript', coalesce(m.has_ready_canonical_transcript, false)
       ) as detail
  from app_stage st
  left join material m
    on m.application_id = st.application_id and m.tenant_id = st.tenant_id
 where st.s9_sort_order is not null
   and st.stage_sort_order >= st.s9_sort_order
   and coalesce(m.has_ready_canonical_transcript, false) = false
union all
select st.application_id,
       st.tenant_id,
       st.current_stage_code,
       'S10_WITHOUT_SUBMITTED_SCORECARD'::text as violation_code,
       jsonb_build_object(
         'required', '>=1 SUBMITTED scorecard',
         'submitted_scorecards', coalesce(s.submitted_scorecards, 0)
       ) as detail
  from app_stage st
  left join scores s
    on s.application_id = st.application_id and s.tenant_id = st.tenant_id
 where st.s10_sort_order is not null
   and st.stage_sort_order >= st.s10_sort_order
   and coalesce(s.submitted_scorecards, 0) = 0;

comment on view recruitment.v_application_stage_consistency is
  'G3 一致性机检：S9+ 必须 canonical READY 转写；S10 必须有 >=1 SUBMITTED 面评。只返回违规行，0 行 = 合规。';

-- =====================================================================
--  §2  G10：事件处置记录（每条事件最终一行；append-only）
--
--  为什么不加列到 event_inbox：dispatch_state 是“派发投影”（RECEIVED/
--  ROUTED/IGNORED/FAILED），处置是“这条事件最终被判了什么”的审计事实；
--  一条事件可以重新评估，处置历史不能被覆盖（D-106 §2 / V-10 落点）。
-- =====================================================================

create table if not exists recruitment.event_disposition (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references recruitment.organization (id),
  event_id        uuid        not null,
  disposition     text        not null,
  reason_code     text        not null,
  decided_at      timestamptz not null default now(),
  target_task_ids jsonb       not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  constraint uq_event_disposition_event unique (event_id),
  -- STRUCT-07：复合外键必须带 tenant_id（防跨租户引用）
  constraint fk_event_disposition_event
    foreign key (event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id)
    on update restrict on delete restrict,
  constraint ck_event_disposition_disposition check (
    disposition in ('FILTERED', 'EVALUATED', 'FANNED_OUT')),
  -- reason_code 封闭集：G10 的代码只能写这些值；新增值必须改迁移+合同。
  constraint ck_event_disposition_reason check (
    reason_code in (
      'SEMANTIC_GATE_REJECTED',
      'ROUTE_IGNORED',
      'BEFORE_RUNTIME_CUTOVER',
      'DUPLICATE_EVENT',
      'DETERMINISTIC_ROUTE',
      'SEMANTIC_ROUTE',
      'TASK_CREATED',
      'TASK_WOKEN'
    )),
  constraint ck_event_disposition_targets check (
    jsonb_typeof(target_task_ids) = 'array')
);

comment on table recruitment.event_disposition is
  'G10 事件处置审计（append-only）：每条 event_inbox 事件最终一行 FILTERED/EVALUATED/FANNED_OUT，含封闭 reason_code 与目标 task ids。禁删、禁改。';

create index if not exists ix_event_disposition_tenant_decided
  on recruitment.event_disposition (tenant_id, decided_at desc);

-- append-only：禁删 + 禁改（处置是审计事实，重新评估应产生新行而不是覆盖）
create or replace function recruitment.fn_event_disposition_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'EVENT_DISPOSITION_IMMUTABLE: event_disposition 是 append-only 审计表，禁止 %',
    tg_op;
end
$$;

drop trigger if exists trg_event_disposition_no_delete on recruitment.event_disposition;
create trigger trg_event_disposition_no_delete
  before delete on recruitment.event_disposition
  for each row execute function recruitment.fn_block_delete();

drop trigger if exists trg_event_disposition_no_update on recruitment.event_disposition;
create trigger trg_event_disposition_no_update
  before update on recruitment.event_disposition
  for each row execute function recruitment.fn_event_disposition_immutable();

-- 存量回填（只回填**已经终态**的历史事件；不重放、不派发）：
--   * IGNORED → FILTERED / SEMANTIC_GATE_REJECTED（G10 指令原文）
--   * 已 ROUTED 且有 routed_task_id → FANNED_OUT / TASK_CREATED
--     （否则“已路由”的旧事件永远缺处置，稳态 count 差永远 >0）
insert into recruitment.event_disposition
  (tenant_id, event_id, disposition, reason_code, decided_at, target_task_ids)
select e.tenant_id,
       e.event_id,
       case when e.dispatch_state = 'IGNORED' then 'FILTERED' else 'FANNED_OUT' end,
       case when e.dispatch_state = 'IGNORED' then 'SEMANTIC_GATE_REJECTED' else 'TASK_CREATED' end,
       coalesce(e.routed_at, e.processed_at, e.received_at),
       case
         when e.routed_task_id is null then '[]'::jsonb
         else jsonb_build_array(e.routed_task_id::text)
       end
  from recruitment.event_inbox e
 where e.dispatch_state in ('IGNORED', 'ROUTED')
   and not exists (
     select 1 from recruitment.event_disposition d where d.event_id = e.event_id)
on conflict (event_id) do nothing;

-- =====================================================================
--  §3  POST-CHECK（迁移必须自证）
-- =====================================================================
do $$
declare
  v_legacy integer;
  v_backfilled integer;
  v_view integer;
  v_disp uuid;
begin
  -- 3.1 视图存在且可查
  select count(*) into v_view from recruitment.v_application_stage_consistency;
  raise notice '0016 POST-CHECK 视图可查：当前违规行 % 行（0 行 = 合规；历史数据可能 >0，属如实暴露）', v_view;

  -- 3.2 回填完整：所有 IGNORED/ROUTED 旧事件都有处置
  select count(*) into v_legacy
    from recruitment.event_inbox
   where dispatch_state in ('IGNORED', 'ROUTED');
  select count(*) into v_backfilled
    from recruitment.event_disposition;
  if v_backfilled < v_legacy then
    raise exception '0016 POST-CHECK 失败：处置回填不完整（legacy=% 回填=%）', v_legacy, v_backfilled;
  end if;

  -- 3.3 处置不可删/不可改（负向自检，子事务回滚）
  select d.id into v_disp from recruitment.event_disposition d limit 1;
  if v_disp is null then
    raise notice '0016 POST-CHECK SKIP 负向自检（干净库没有历史事件，无可测的处置行）';
  else
    begin
      delete from recruitment.event_disposition where id = v_disp;
      raise exception '0016 POST-CHECK 失败：event_disposition 删除竟然成功';
    exception
      when check_violation then
        null;  -- 期望：fn_block_delete → 23514
    end;

    begin
      update recruitment.event_disposition set reason_code = 'DUPLICATE_EVENT' where id = v_disp;
      raise exception '0016 POST-CHECK 失败：event_disposition 修改竟然成功';
    exception
      when others then
        if sqlerrm not like 'EVENT_DISPOSITION_IMMUTABLE%' then
          raise;
        end if;
    end;
  end if;

  raise notice '0016 POST-CHECK PASS 一致性视图 + event_disposition（回填 % 行）+ 禁删/禁改自检', v_backfilled;
end $$;

-- =====================================================================
--  §4  迁移台账自登记（0010 §规则第 1 条）
-- =====================================================================
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0016_v1_consistency',
            'v1.0 收口：v_application_stage_consistency（G3 违规机检）+ event_disposition（G10 事件处置，append-only）+ 存量 IGNORED/ROUTED 回填')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
