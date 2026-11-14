-- =====================================================================
--  recruitment-agent · 0013_trace_chain.sql
--
--  执行追溯链（execution trace chain）：给"一次外部事件 / 用户动作"产生的所有
--  执行事实一个统一的 correlation_id，并补齐缺失的一环（Tool Call）。
--
--  权威来源：
--    docs/03-domain-and-runtime.md §8   五类事实必须分开（Tool Call 是"某次执行事实"）
--    docs/03-domain-and-runtime.md §9   Event Envelope 十四个字段（correlation_id / causation_id）
--    docs/03-domain-and-runtime.md §11  Task Attempt 字段（trace_id / correlation_id）
--    docs/03-domain-and-runtime.md §13  Durable Effect + Receipt
--    docs/03-domain-and-runtime.md §16  不变量 9：所有关键日志能通过 correlation_id / business_refs 追溯
--    Notion 08 §11.3 第 9 步 / §11.6 验收门槛：Event → Business Task → Task Attempt
--      → Agent Session → Tool Call → Durable Effect → External Receipt → 人工决策
--
--  现状（2026-11-14 实测 ra_s6s7）：
--    * event_inbox 62 行，correlation_id 全部为 NULL（列存在但没有任何写入方填）；
--    * task_attempt / agent_session / durable_effect 各 0 行；
--    * **没有 tool_call 表** —— 执行链在"Tool Call"这一环结构上就不存在；
--    * decision 只有 application_id / actor，没有 correlation、没有来源事件指针；
--    * business_task / agent_session / decision 没有 correlation 列。
--
--  本迁移做三件事（只加结构，不改业务语义）：
--    1. 给缺列的追溯表补 correlation_id（+ decision.causation_event_id）；
--    2. 新建 recruitment.tool_call（docs/03 §8 的"某次执行事实"落表）；
--    3. 用 BEFORE INSERT 触发器把 correlation 从**已存在的真实链接**向下游传播：
--          intake event → application（经 resume_version→resume→asset→record→event）
--          application → interview → scorecard
--          application → decision（+ decision.record 事件回指）
--          event / business_task.business_refs → task → attempt → session
--          event / business_refs → durable_effect
--       **没有真实链接就不伪造**：解析不出就留 NULL（应用/事件是链根，各自生成新链），
--       追溯查询会把 NULL / 不一致报成断链，而不是编一个 ID 让图看起来是通的。
--
--  三条安全规则（都为保证不破坏既有 0001–0012 语义）：
--    * 触发器**永不抛错**：解析失败一律返回 NULL（任何异常都被捕获），
--      绝不因为追溯元数据缺失而拒绝一次合法业务写入；
--    * **不回填历史行**：迁移前的行 correlation 保持 NULL，如实表示"这条事实早于追溯链"；
--      不 UPDATE 任何业务行（0001 的 fn_row_guard / fn_guard_columns 会因此被触发，污染审计）；
--    * 全部幂等：add column if not exists / create table if not exists /
--      create or replace function / DO 块判重后再建触发器。
--
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0013_trace_chain.sql
--  不要加 -1（本文件自带 begin/commit）。
-- =====================================================================

begin;

-- =====================================================================
--  1. 缺列的追溯表补 correlation_id
-- =====================================================================

-- 申请是 Golden Path 的业务链根：事件 → 材料 → 申请 → 面试/面评 → 决策 都挂在它下面。
alter table recruitment.application add column if not exists correlation_id uuid;

-- 面试：从 application 继承（S8 写路径的真实父子关系）。
alter table recruitment.interview add column if not exists correlation_id uuid;

-- 面评：从 interview 继承（S10 写路径）。
alter table recruitment.scorecard add column if not exists correlation_id uuid;

-- 后台任务：从 trigger_event_id 或 business_refs 里的业务对象继承。
alter table recruitment.business_task add column if not exists correlation_id uuid;

-- Agent Session：从 attempt / task 继承（docs/03 §12：Session 记所属 Task/Attempt）。
alter table recruitment.agent_session add column if not exists correlation_id uuid;

-- 决策：从申请继承；causation_event_id 指向它自己的 decision.record 内部事件。
alter table recruitment.decision add column if not exists correlation_id uuid;
alter table recruitment.decision add column if not exists causation_event_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint c
     where c.conname = 'fk_decision_causation_event'
       and c.conrelid = 'recruitment.decision'::regclass
  ) then
    alter table recruitment.decision
      add constraint fk_decision_causation_event
      foreign key (causation_event_id, tenant_id)
      references recruitment.event_inbox (event_id, tenant_id);
  end if;
end $$;

-- 追溯查询都从 correlation_id 进入，按 (tenant_id, correlation_id) 建部分索引。
create index if not exists ix_application_trace on recruitment.application (tenant_id, correlation_id)
  where correlation_id is not null;
create index if not exists ix_interview_trace on recruitment.interview (tenant_id, correlation_id)
  where correlation_id is not null;
create index if not exists ix_scorecard_trace on recruitment.scorecard (tenant_id, correlation_id)
  where correlation_id is not null;
create index if not exists ix_business_task_trace on recruitment.business_task (tenant_id, correlation_id)
  where correlation_id is not null;
create index if not exists ix_agent_session_trace on recruitment.agent_session (tenant_id, correlation_id)
  where correlation_id is not null;
create index if not exists ix_decision_trace on recruitment.decision (tenant_id, correlation_id)
  where correlation_id is not null;
create index if not exists ix_task_attempt_trace on recruitment.task_attempt (tenant_id, correlation_id)
  where correlation_id is not null;
create index if not exists ix_durable_effect_trace on recruitment.durable_effect (tenant_id, correlation_id)
  where correlation_id is not null;
create index if not exists ix_event_inbox_trace on recruitment.event_inbox (tenant_id, correlation_id)
  where correlation_id is not null;


-- =====================================================================
--  2. Tool Call：docs/03 §8 的"某次执行事实"
--
--  为什么必须单独一张表：执行链上"模型/工具这一次到底调了什么"目前没有任何落点，
--  event_inbox 记的是外部事实，business_task 记的是要做什么，durable_effect 记的是
--  对外发出什么 —— 都不是"这次工具调用本身"。缺这一环，"有 decision 但找不到对应的
--  tool call"这类断链在结构上无法检出。
--
--  R7：**不存 args / result 正文**，只存 sha256 摘要；business_refs 只存对象 id。
--  append-only：整行不可改（fn_guard_columns 无白名单）+ 禁删（fn_block_delete）。
-- =====================================================================
create table if not exists recruitment.tool_call (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references recruitment.organization (id),
  -- 调用方幂等键：DSH callId / "<session>:<call>"；同一键只落一行（重放不重复记）。
  call_ref         text not null,
  tool_name        text not null,
  correlation_id   uuid not null,
  actor_id         uuid,
  agent_session_id uuid,
  task_id          uuid,
  attempt_id       uuid,
  business_refs    jsonb not null default '[]'::jsonb,
  args_digest      text,
  result_digest    text,
  outcome          text not null,
  error_code       text,
  started_at       timestamptz not null,
  ended_at         timestamptz,
  duration_ms      bigint,
  created_at       timestamptz not null default now(),
  constraint uq_tool_call_id_tenant unique (id, tenant_id),
  constraint uq_tool_call_ref unique (tenant_id, call_ref),
  constraint fk_tool_call_actor foreign key (actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_tool_call_session foreign key (agent_session_id, tenant_id)
    references recruitment.agent_session (id, tenant_id),
  constraint fk_tool_call_task foreign key (task_id, tenant_id)
    references recruitment.business_task (id, tenant_id),
  constraint fk_tool_call_attempt foreign key (attempt_id, tenant_id)
    references recruitment.task_attempt (id, tenant_id),
  constraint ck_tool_call_outcome check (outcome in
    ('SUCCEEDED','FAILED','REJECTED','NOT_RUN','UNKNOWN')),
  constraint ck_tool_call_name check (length(btrim(tool_name)) between 1 and 120),
  constraint ck_tool_call_ref check (length(btrim(call_ref)) between 1 and 200),
  constraint ck_tool_call_digests check (
    (args_digest is null or args_digest ~ '^[0-9a-f]{64}$')
    and (result_digest is null or result_digest ~ '^[0-9a-f]{64}$')),
  constraint ck_tool_call_refs check (jsonb_typeof(business_refs) = 'array'),
  constraint ck_tool_call_window check (ended_at is null or ended_at >= started_at),
  constraint ck_tool_call_duration check (duration_ms is null or duration_ms >= 0),
  constraint ck_tool_call_terminal check (
    outcome not in ('SUCCEEDED','FAILED','REJECTED') or ended_at is not null),
  constraint ck_tool_call_failed check (outcome <> 'FAILED' or error_code is not null)
);

comment on table recruitment.tool_call is
  '某次执行事实：一次工具调用的调用记录（工具名 / 归属 Session / 业务引用 / 结果分类 / 耗时摘要）。'
  '不存 args、result 正文，只存 sha256（R7）；由 src/domain/trace.ts 的记录适配器写入。';

create index if not exists ix_tool_call_trace on recruitment.tool_call (tenant_id, correlation_id);
create index if not exists ix_tool_call_tool on recruitment.tool_call (tenant_id, tool_name, started_at desc);
create index if not exists ix_tool_call_refs on recruitment.tool_call using gin (business_refs);

do $$
begin
  if not exists (
    select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'recruitment' and c.relname = 'tool_call'
       and g.tgname = 'trg_tool_call_no_delete' and not g.tgisinternal
  ) then
    create trigger trg_tool_call_no_delete before delete on recruitment.tool_call
      for each row execute function recruitment.fn_block_delete();
  end if;
  if not exists (
    select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'recruitment' and c.relname = 'tool_call'
       and g.tgname = 'trg_tool_call_immutable' and not g.tgisinternal
  ) then
    create trigger trg_tool_call_immutable before update on recruitment.tool_call
      for each row execute function recruitment.fn_guard_columns();
  end if;
end $$;


-- =====================================================================
--  3. 解析辅助函数（**永不抛错**：任何解析失败都返回 NULL）
-- =====================================================================

-- 取某张追溯表的 correlation_id；表/列不存在 → NULL（不抛错）。
create or replace function recruitment.fn_trace_corr(p_table text, p_id uuid, p_tenant uuid)
returns uuid
language plpgsql stable as $$
declare
  v uuid;
begin
  if p_table is null or p_id is null then
    return null;
  end if;
  begin
    execute format('select correlation_id from recruitment.%I where id = $1 and tenant_id = $2', p_table)
      into v using p_id, p_tenant;
  exception when others then
    v := null;
  end;
  return v;
end $$;

comment on function recruitment.fn_trace_corr(text, uuid, uuid) is
  '按 (表名, 行 id, 租户) 取 correlation_id；表或列不存在时返回 NULL 而不抛错（0013 的传播触发器共用）。';

-- intake 材料链：resume_version → resume → intake_asset → intake_record → event_inbox。
create or replace function recruitment.fn_trace_intake_corr(p_tenant uuid, p_resume_version_id uuid)
returns uuid
language plpgsql stable as $$
declare
  v uuid;
begin
  if p_resume_version_id is null then
    return null;
  end if;
  select e.correlation_id into v
    from recruitment.resume_version rv
    join recruitment.resume r
      on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
    join recruitment.intake_asset a
      on a.id = r.intake_asset_id and a.tenant_id = r.tenant_id
    join recruitment.intake_record ir
      on ir.id = a.intake_record_id and ir.tenant_id = a.tenant_id
    join recruitment.event_inbox e
      on e.event_id = ir.event_id and e.tenant_id = ir.tenant_id
   where rv.id = p_resume_version_id and rv.tenant_id = p_tenant;
  return v;
exception when others then
  return null;
end $$;

comment on function recruitment.fn_trace_intake_corr(uuid, uuid) is
  '材料链根事件的相关链：resume_version → resume → intake_asset → intake_record → event_inbox.correlation_id。';

-- 业务引用 → correlation：business_refs 里的 {kind, id} 指向的业务对象（闭集，未知 kind 跳过）。
create or replace function recruitment.fn_trace_refs_corr(p_tenant uuid, p_refs jsonb)
returns uuid
language plpgsql stable as $$
declare
  r      jsonb;
  v      uuid;
  v_kind text;
  v_id   uuid;
begin
  if p_refs is null or jsonb_typeof(p_refs) <> 'array' then
    return null;
  end if;
  for r in select * from jsonb_array_elements(p_refs) loop
    if jsonb_typeof(r) <> 'object' then
      continue;
    end if;
    v_kind := r ->> 'kind';
    begin
      v_id := (r ->> 'id')::uuid;
    exception when others then
      v_id := null;
    end;
    if v_id is null then
      continue;
    end if;
    if v_kind = 'APPLICATION' then
      v := recruitment.fn_trace_corr('application', v_id, p_tenant);
    elsif v_kind = 'DECISION' then
      v := recruitment.fn_trace_corr('decision', v_id, p_tenant);
    elsif v_kind = 'BUSINESS_TASK' then
      v := recruitment.fn_trace_corr('business_task', v_id, p_tenant);
    elsif v_kind = 'TOOL_CALL' then
      v := recruitment.fn_trace_corr('tool_call', v_id, p_tenant);
    elsif v_kind = 'INTERVIEW' then
      select a.correlation_id into v
        from recruitment.interview i
        join recruitment.application a
          on a.id = i.application_id and a.tenant_id = i.tenant_id
       where i.id = v_id and i.tenant_id = p_tenant;
    end if;
    if v is not null then
      return v;
    end if;
  end loop;
  return null;
exception when others then
  return null;
end $$;

comment on function recruitment.fn_trace_refs_corr(uuid, jsonb) is
  'business_refs（[{kind,id}]）→ correlation_id；kind 闭集 APPLICATION/DECISION/BUSINESS_TASK/TOOL_CALL/INTERVIEW。';


-- =====================================================================
--  4. BEFORE INSERT 传播触发器
-- =====================================================================

-- 4.1 事件入口：追溯链的根之一。解析不出上游 → 生成新链（一条新外部事实 = 一条新链）。
create or replace function recruitment.fn_trace_event_stamp() returns trigger
language plpgsql as $$
declare
  v        uuid;
  v_table  text;
  v_rec    uuid;
  v_app    uuid;
  v_inter  uuid;
begin
  if new.correlation_id is not null then
    return new;
  end if;
  begin
    -- (a) fn_row_guard 写的内部事件：payload.table + payload.record_id 指向被改的行
    if jsonb_typeof(new.payload) = 'object' then
      v_table := new.payload ->> 'table';
      begin
        v_rec := (new.payload ->> 'record_id')::uuid;
      exception when others then
        v_rec := null;
      end;
      if v_table is not null and v_rec is not null then
        v := recruitment.fn_trace_corr(v_table, v_rec, new.tenant_id);
      end if;

      -- (b) decision.record：payload.application_id
      if v is null then
        begin
          v_app := (new.payload ->> 'application_id')::uuid;
        exception when others then
          v_app := null;
        end;
        v := recruitment.fn_trace_corr('application', v_app, new.tenant_id);
      end if;

      -- (c) scorecard.submit：payload.interview_id → interview.application_id → application
      if v is null then
        begin
          v_inter := (new.payload ->> 'interview_id')::uuid;
        exception when others then
          v_inter := null;
        end;
        if v_inter is not null then
          select a.correlation_id into v
            from recruitment.interview i
            join recruitment.application a
              on a.id = i.application_id and a.tenant_id = i.tenant_id
           where i.id = v_inter and i.tenant_id = new.tenant_id;
        end if;
      end if;
    end if;

    -- (d) 兜底：新链根
    if v is null then
      v := gen_random_uuid();
    end if;
  exception when others then
    v := gen_random_uuid();
  end;
  new.correlation_id := v;
  return new;
end $$;

comment on function recruitment.fn_trace_event_stamp() is
  'Event Inbox 入口盖章：从 payload 里的真实业务链接继承 correlation_id；解析不出则开新链（事件是链根）。';

-- 4.2 申请：从材料链根事件继承；没有材料链 → 新链根（申请是业务链根）。
create or replace function recruitment.fn_trace_application_stamp() returns trigger
language plpgsql as $$
declare
  v uuid;
begin
  if new.correlation_id is not null then
    return new;
  end if;
  begin
    v := recruitment.fn_trace_intake_corr(new.tenant_id, new.resume_version_id);
    if v is null then
      v := gen_random_uuid();
    end if;
  exception when others then
    v := gen_random_uuid();
  end;
  new.correlation_id := v;
  return new;
end $$;

-- 4.3 面试：从申请继承。
create or replace function recruitment.fn_trace_interview_stamp() returns trigger
language plpgsql as $$
begin
  if new.correlation_id is null then
    new.correlation_id := recruitment.fn_trace_corr('application', new.application_id, new.tenant_id);
  end if;
  return new;
end $$;

-- 4.4 面评：从面试继承。
create or replace function recruitment.fn_trace_scorecard_stamp() returns trigger
language plpgsql as $$
begin
  if new.correlation_id is null then
    new.correlation_id := recruitment.fn_trace_corr('interview', new.interview_id, new.tenant_id);
  end if;
  return new;
end $$;

-- 4.5 后台任务：trigger_event_id 优先，其次 business_refs 里的业务对象。
create or replace function recruitment.fn_trace_business_task_stamp() returns trigger
language plpgsql as $$
declare
  v uuid;
begin
  if new.correlation_id is not null then
    return new;
  end if;
  begin
    if new.trigger_event_id is not null then
      select e.correlation_id into v
        from recruitment.event_inbox e
       where e.event_id = new.trigger_event_id and e.tenant_id = new.tenant_id;
    end if;
    if v is null then
      v := recruitment.fn_trace_refs_corr(new.tenant_id, new.business_refs);
    end if;
  exception when others then
    v := null;
  end;
  new.correlation_id := v;
  return new;
end $$;

-- 4.6 Task Attempt：从所属 Task 继承（重试沿用同一条链）。
create or replace function recruitment.fn_trace_task_attempt_stamp() returns trigger
language plpgsql as $$
begin
  if new.correlation_id is null then
    new.correlation_id := recruitment.fn_trace_corr('business_task', new.task_id, new.tenant_id);
  end if;
  return new;
end $$;

-- 4.7 Agent Session：attempt 优先，其次 task（Session 只是上下文，不拥有任务）。
create or replace function recruitment.fn_trace_agent_session_stamp() returns trigger
language plpgsql as $$
declare
  v uuid;
begin
  if new.correlation_id is not null then
    return new;
  end if;
  v := recruitment.fn_trace_corr('task_attempt', new.attempt_id, new.tenant_id);
  if v is null then
    v := recruitment.fn_trace_corr('business_task', new.task_id, new.tenant_id);
  end if;
  new.correlation_id := v;
  return new;
end $$;

-- 4.8 Durable Effect：causation_event 优先，其次 business_refs。
create or replace function recruitment.fn_trace_durable_effect_stamp() returns trigger
language plpgsql as $$
declare
  v uuid;
begin
  if new.correlation_id is not null then
    return new;
  end if;
  if new.causation_event_id is not null then
    select e.correlation_id into v
      from recruitment.event_inbox e
     where e.event_id = new.causation_event_id and e.tenant_id = new.tenant_id;
  end if;
  if v is null then
    v := recruitment.fn_trace_refs_corr(new.tenant_id, new.business_refs);
  end if;
  new.correlation_id := v;
  return new;
end $$;

-- 4.9 决策：从申请继承；causation_event 指向它自己的 decision.record 内部事件（若已写入）。
create or replace function recruitment.fn_trace_decision_stamp() returns trigger
language plpgsql as $$
declare
  v uuid;
  e uuid;
begin
  if new.correlation_id is null then
    new.correlation_id := recruitment.fn_trace_corr('application', new.application_id, new.tenant_id);
  end if;
  begin
    select ev.event_id, ev.correlation_id into e, v
      from recruitment.event_inbox ev
     where ev.tenant_id = new.tenant_id
       and ev.provider = 'internal'
       and ev.event_type = 'decision.record'
       and ev.source_object_id = new.id::text
     order by ev.recorded_at desc
     limit 1;
    if new.causation_event_id is null then
      new.causation_event_id := e;
    end if;
    -- 事件先写、决策后写：若事件当时解析不出（例如申请人链缺失），用决策拿到的链补齐事件
    -- 不可行（event_inbox 不可改），因此这里只做本行继承，不回头改事件。
    if new.correlation_id is null and v is not null then
      new.correlation_id := v;
    end if;
  exception when others then
    null;
  end;
  return new;
end $$;

-- 4.10 Tool Call：调用记录必须带链；business_refs 能解析就继承（正常情况下由记录适配器显式给）。
create or replace function recruitment.fn_trace_tool_call_stamp() returns trigger
language plpgsql as $$
declare
  v uuid;
begin
  if new.correlation_id is null then
    v := recruitment.fn_trace_refs_corr(new.tenant_id, new.business_refs);
    new.correlation_id := coalesce(v, gen_random_uuid());
  end if;
  return new;
end $$;

-- 4.11 触发器登记（幂等：已存在就跳过）
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('event_inbox',   'trg_event_inbox_trace',       'fn_trace_event_stamp'),
      ('application',   'trg_application_trace',       'fn_trace_application_stamp'),
      ('interview',     'trg_interview_trace',         'fn_trace_interview_stamp'),
      ('scorecard',     'trg_scorecard_trace',         'fn_trace_scorecard_stamp'),
      ('business_task', 'trg_business_task_trace',     'fn_trace_business_task_stamp'),
      ('task_attempt',  'trg_task_attempt_trace',      'fn_trace_task_attempt_stamp'),
      ('agent_session', 'trg_agent_session_trace',     'fn_trace_agent_session_stamp'),
      ('durable_effect','trg_durable_effect_trace',    'fn_trace_durable_effect_stamp'),
      ('decision',      'trg_decision_trace',          'fn_trace_decision_stamp'),
      ('tool_call',     'trg_tool_call_trace',         'fn_trace_tool_call_stamp')
    ) as v(tbl, tname, fnname)
  loop
    if to_regclass('recruitment.' || spec.tbl) is null then
      continue;
    end if;
    if exists (
      select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'recruitment' and c.relname = spec.tbl
         and g.tgname = spec.tname and not g.tgisinternal
    ) then
      continue;
    end if;
    execute format(
      'create trigger %I before insert on recruitment.%I for each row execute function recruitment.%I()',
      spec.tname, spec.tbl, spec.fnname);
  end loop;
end $$;


-- =====================================================================
--  5. 本文件自己登记自己（模板见 0010）
-- =====================================================================
insert into recruitment.schema_migration (version, note) values
  ('0013_trace_chain', '执行追溯链：补 correlation_id + 新建 tool_call + 传播触发器（Event→Task→Attempt→Session→ToolCall→Effect→Decision）')
on conflict (version) do nothing;

commit;
