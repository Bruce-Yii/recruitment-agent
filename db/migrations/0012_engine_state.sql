-- =====================================================================
--  recruitment-agent · 0012_engine_state.sql
--
--  给 vendor 进来的执行器引擎（dsh-superagent 原型 core/executor/app）建持久化表。
--
--  为什么是 0012 而不是 0011：
--    0011 可能被其他 lane 占用，本 lane 按总控指示避让，固定用 0012。
--
--  为什么表长这样（三条硬约束，都是被 verify.sql 检查的）：
--    1. 每张表单列 uuid 主键、列名必须是 `id`（STRUCT-01）。引擎聚合的业务键
--       （trigger_id / thread_key / ticket_id ...）因此另开 unique 列，不做主键。
--    2. 每张表 NOT NULL tenant_id + 外键到 organization（STRUCT-02/03）。引擎是单库单租户，
--       但仍按仓库约定记归属：租户来自连接配置，不接受模型入参。
--    3. 状态列名不得落在 STRUCT-04 的封闭清单里、或用 CHECK 收口。本迁移没有 `status` 列
--       （引擎把状态存在 JSON 聚合里），effect 的 `kind` 命中清单，故加 ck_engine_effect_kind。
--
--  为什么用 JSONB 聚合行而不是拆关系表：
--    引擎的 `Repositories` 端口按**聚合根**读写（Thread / Ticket / Decision 整体 JSON），
--    拆表就等于重写引擎。这一层只负责"同一个 JSON 聚合按业务键落一行"，语义与原型 SQLite 一致。
--
--  seq 的用途：原型用 SQLite `rowid` 保插入顺序（tickets 列表 newest-first、decisions 按插入序、
--    outbox 按排队序）。PostgreSQL 没有 rowid，这里用 identity 列补同一个语义。
--
--  幂等：全部 if not exists / on conflict，重跑只补登记。
-- =====================================================================

begin;

-- ── 1. Trigger：不可变的外部事件（历史事实，禁删）────────────────────
create table if not exists recruitment.engine_trigger (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references recruitment.organization(id),
  trigger_id text        not null unique,
  value      jsonb       not null,
  at         text        not null,
  seq        bigint      generated always as identity
);
comment on table recruitment.engine_trigger is
  '引擎 Trigger 聚合（不可变外部事件）。trigger_id 是源侧 ID，value 是整份 JSON 聚合。';
create index if not exists engine_trigger_at on recruitment.engine_trigger (at);
create index if not exists engine_trigger_seq on recruitment.engine_trigger (seq);

-- ── 2. Trigger 处置：扇出/eval/决策归属（可更新）──────────────────────
create table if not exists recruitment.engine_disposition (
  id             uuid  primary key default gen_random_uuid(),
  tenant_id      uuid  not null references recruitment.organization(id),
  disposition_id text  not null unique,
  value          jsonb not null
);
comment on table recruitment.engine_disposition is
  '每个 Trigger 的处置记录（happened where：fanout / evalId / decisionId / handbacks / acked）。';

-- ── 3. Trigger ↔ Thread 索引：扇出与时间线定位 ────────────────────────
create table if not exists recruitment.engine_trigger_thread (
  id         uuid    primary key default gen_random_uuid(),
  tenant_id  uuid    not null references recruitment.organization(id),
  thread_key text    not null,
  trigger_id text    not null,
  at         text    not null,
  human      boolean not null,
  seq        bigint  generated always as identity,
  unique (thread_key, trigger_id)
);
comment on table recruitment.engine_trigger_thread is
  'Trigger 与 Thread 的从属关系，保存一行即可按 thread 时间线检索；每次保存 Trigger 时整体重建该 Trigger 的行。';
create index if not exists engine_trigger_thread_at on recruitment.engine_trigger_thread (thread_key, at);

-- ── 4. Thread 聚合：Eval 的边界、订阅与决定历史 ───────────────────────
create table if not exists recruitment.engine_thread (
  id         uuid   primary key default gen_random_uuid(),
  tenant_id  uuid   not null references recruitment.organization(id),
  thread_key text   not null unique,
  value      jsonb  not null,
  seq        bigint generated always as identity
);
comment on table recruitment.engine_thread is
  '引擎 Thread 聚合（thread_key = source:id）。active 判定在查询里用 JSONB 表达式做：pending 非空或 evaluating 存在。';
create index if not exists engine_thread_seq on recruitment.engine_thread (seq);

-- ── 5. Ticket 聚合：授权工作单元及其 assignments / inputs ─────────────
create table if not exists recruitment.engine_ticket (
  id        uuid   primary key default gen_random_uuid(),
  tenant_id uuid   not null references recruitment.organization(id),
  ticket_id text   not null unique,
  value     jsonb  not null,
  seq       bigint generated always as identity
);
comment on table recruitment.engine_ticket is
  '引擎 Ticket 聚合。open = 无 ended 键；active = undelivered 非空或最后一个 assignment 为 pending/running。';
create index if not exists engine_ticket_seq on recruitment.engine_ticket (seq);

-- ── 6. Decision：不可变的判定记录（历史事实，禁删）────────────────────
create table if not exists recruitment.engine_decision (
  id          uuid   primary key default gen_random_uuid(),
  tenant_id   uuid   not null references recruitment.organization(id),
  decision_id text   not null unique,
  thread_key  text   not null,
  value       jsonb  not null,
  seq         bigint generated always as identity
);
comment on table recruitment.engine_decision is
  '引擎 Decision 聚合（accept/ignore/stop/unavailable）。按 thread 读取时以 seq 保插入序。';
create index if not exists engine_decision_thread on recruitment.engine_decision (thread_key, seq);

-- ── 7. Outbox：消息回执（幂等 ID，撤回只删 pending）───────────────────
create table if not exists recruitment.engine_outbox (
  id         uuid   primary key default gen_random_uuid(),
  tenant_id  uuid   not null references recruitment.organization(id),
  message_id text   not null unique,
  value      jsonb  not null,
  seq        bigint generated always as identity
);
comment on table recruitment.engine_outbox is
  '出站消息回执，永久保留以保证 message_id 幂等；status 存在 JSON 里（pending/sent/dropped）。';
create index if not exists engine_outbox_seq on recruitment.engine_outbox (seq);

-- ── 8. Effect：持久化副作用队列（effects.ts 直接读写这张表）──────────
create table if not exists recruitment.engine_effect (
  id         uuid    primary key default gen_random_uuid(),
  tenant_id  uuid    not null references recruitment.organization(id),
  kind       text    not null,
  key        text    not null,
  value      jsonb   not null,
  seq        bigint  not null,
  generation integer not null default 0,
  attempts   integer not null default 0,
  error      text    not null default '',
  due        bigint  not null,
  since      timestamptz not null,
  unique (kind, key),
  constraint ck_engine_effect_kind check (kind in ('assessment', 'launch', 'delivery', 'relay', 'notice', 'reply'))
);
comment on table recruitment.engine_effect is
  '引擎副作用队列：与命令同事务入队，提交后由 Effects 派发；kind 取值由 ck_engine_effect_kind 收口（STRUCT-04）。';
create index if not exists engine_effect_due on recruitment.engine_effect (kind, due, seq);

-- ── 9. KV：schema 版本、设置版本历史、主 Session ID 等 ────────────────
create table if not exists recruitment.engine_kv (
  id        uuid  primary key default gen_random_uuid(),
  tenant_id uuid  not null references recruitment.organization(id),
  key       text  not null unique,
  value     jsonb not null
);
comment on table recruitment.engine_kv is
  '引擎键值状态（schema 版本、设置版本、master session id、各 Source 的游标等）。键前缀即族（见 kv.ts）。';
-- LIKE 'prefix%' 走索引需要 text_pattern_ops（C 排序规则下方的按字节比较）。
create index if not exists engine_kv_prefix on recruitment.engine_kv (key text_pattern_ops);

-- ── 10. 历史事实禁删（沿用 0001 的 fn_block_delete 约定）──────────────
do $$
declare
  t text;
begin
  foreach t in array array['engine_trigger', 'engine_decision'] loop
    if not exists (
      select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'recruitment' and c.relname = t
         and g.tgname = format('trg_%s_no_delete', t) and not g.tgisinternal
    ) then
      execute format('create trigger trg_%s_no_delete before delete on recruitment.%I
                      for each row execute function recruitment.fn_block_delete()', t, t);
    end if;
  end loop;
end $$;

-- ── 11. 本文件自己登记自己（模板见 0010）─────────────────────────────
insert into recruitment.schema_migration (version, note) values
  ('0012_engine_state', '执行器引擎持久化：JSONB 聚合行 + 副作用队列 + KV（同步 PG 桥读写）')
on conflict (version) do nothing;

commit;
