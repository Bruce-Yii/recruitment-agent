-- =====================================================================
--  recruitment-agent · 0001_init.sql
--  v1.0 领域库初始化（PostgreSQL 17）
--
--  权威来源：
--    docs/03-domain-and-runtime.md   §1 三十四个业务对象 / §3 五组状态机 /
--                                    §4 十条最小数据不变量 / §5 Intake 三层 /
--                                    §6 Candidate 合并 / §9 Event Envelope /
--                                    §10 Business Task / §11 Task Attempt /
--                                    §13 Durable Effect / §18 并发绑定审批 /
--                                    §19 七种时间语义
--    docs/13-project-plan.md         §4 P1（7 张核心表）/ §3 技术栈
--    docs/01-business-lifecycle.md   §9 v1.0 切割（阶段 3/6/7/8/9/10）
--    docs/04-connectors-and-transcript.md §11/§12/§16/§18/§20（转写与绑定）
--
--  本文件只做三件事：建表、建约束、建触发器。不含任何业务逻辑。
--
--  约定：
--    * 全部对象在 schema `recruitment` 下（避免与同库其它 schema 撞名）。
--    * 主键一律 uuid（gen_random_uuid()，PG13+ 内置，无需扩展）。
--    * 幂等：本文件可重复执行（IF NOT EXISTS / CREATE OR REPLACE /
--      DROP TRIGGER IF EXISTS / DO 块内 IF NOT EXISTS 加约束）。
--    * 多租户：除 organization 自身外，每张表都有 tenant_id；关键关系用
--      (id, tenant_id) 复合外键，物理上禁止跨租户引用。
--    * 状态迁移：带状态的表都有 status_changed_at / status_changed_by_actor_id /
--      status_source_event_id，并由 fn_row_guard 触发器强制：
--        - 状态变了 → 必须能确定 actor，并自动写一条内部事件（event_inbox），
--          事件 id 回填到 status_source_event_id（docs/03 §4 不变量 8）；
--        - 状态没变 → 不允许手改 status_changed_at（防伪造历史）。
--    * 历史事实表禁止物理删除（fn_block_delete），只能追加 / 软关闭
--      （docs/03 §4 不变量 2、§6 合并规则、§11 重试保留历史）。
--
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
--  不要加 -1（本文件自带 begin/commit）。
-- =====================================================================

begin;

create schema if not exists recruitment;

-- 乐观并发/fencing 用单调计数器（docs/03 §18「Worker 领取用 fencing_token」）
create sequence if not exists recruitment.seq_fencing_token as bigint start with 1 increment by 1;


-- =====================================================================
--  0. 通用触发器函数
-- =====================================================================

-- 历史事实禁止物理删除
create or replace function recruitment.fn_block_delete() returns trigger
language plpgsql as $$
begin
  raise exception
    'DELETE_FORBIDDEN: %.% 是历史事实，不允许物理删除（只允许追加或软关闭；docs/03 §4 不变量 2 / §6 / §11）',
    tg_table_schema, tg_table_name
    using errcode = '23514';
end $$;

-- 列级不可变：TG_ARGV 为允许修改的列名白名单（不给参数 = 整行不可改）
create or replace function recruitment.fn_guard_columns() returns trigger
language plpgsql as $$
declare
  k text;
begin
  for k in select jsonb_object_keys(to_jsonb(new)) loop
    if k = any (tg_argv) then continue; end if;
    -- 触发器自身维护的列不算篡改
    if k in ('record_version', 'updated_at',
             'status_changed_at', 'status_changed_by_actor_id', 'status_source_event_id',
             'stage_changed_at', 'stage_changed_by_actor_id', 'stage_source_event_id') then
      continue;
    end if;
    if (to_jsonb(new) ->> k) is distinct from (to_jsonb(old) ->> k) then
      raise exception
        'IMMUTABLE_COLUMN: %.% 的列 % 不允许修改（允许修改的列：%）',
        tg_table_schema, tg_table_name, k, coalesce(array_to_string(tg_argv, ','), '（无）')
        using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

-- 行级护栏：版本自增 + 状态迁移审计（TG_ARGV[0]=列名，TG_ARGV[1]=列前缀）
--   fn_row_guard('status','status')            → status_changed_at / status_changed_by_actor_id / status_source_event_id
--   fn_row_guard('lifecycle_status','status')  → 同上（列名不同，前缀相同）
--   fn_row_guard('current_stage_code','stage') → stage_changed_at / stage_changed_by_actor_id / stage_source_event_id
create or replace function recruitment.fn_row_guard() returns trigger
language plpgsql as $$
declare
  v_col    text := tg_argv[0];
  v_prefix text := tg_argv[1];
  v_old    text;
  v_new    text;
  v_actor  uuid;
  v_event  uuid := gen_random_uuid();
  j        jsonb;
begin
  v_old := to_jsonb(old) ->> v_col;
  v_new := to_jsonb(new) ->> v_col;

  -- 未发生迁移：只做版本自增，并禁止手改审计时间/事件
  if v_old is not distinct from v_new then
    if (to_jsonb(new) ->> (v_prefix || '_changed_at')) is distinct from (to_jsonb(old) ->> (v_prefix || '_changed_at')) then
      raise exception
        'STATUS_AUDIT_TAMPER: %.% 的 %_changed_at 只能随状态迁移改写',
        tg_table_schema, tg_table_name, v_prefix
        using errcode = '23514';
    end if;
    if (to_jsonb(new) ->> (v_prefix || '_source_event_id')) is distinct from (to_jsonb(old) ->> (v_prefix || '_source_event_id')) then
      raise exception
        'STATUS_AUDIT_TAMPER: %.% 的 %_source_event_id 只能随状态迁移改写',
        tg_table_schema, tg_table_name, v_prefix
        using errcode = '23514';
    end if;
    new := jsonb_populate_record(new, jsonb_build_object(
      'updated_at',     to_jsonb(now()),
      'record_version', to_jsonb(old.record_version + 1)
    ));
    return new;
  end if;

  -- 迁移：必须能确定 actor（可信服务端 SET LOCAL recruitment.actor_id，或显式写审计列）
  v_actor := nullif(current_setting('recruitment.actor_id', true), '')::uuid;
  if v_actor is null then
    if new.status_changed_by_actor_id is not distinct from old.status_changed_by_actor_id then
      raise exception
        'ACTOR_REQUIRED: %.% 的 % 迁移必须给出 actor（SET LOCAL recruitment.actor_id 或显式写 %_changed_by_actor_id）',
        tg_table_schema, tg_table_name, v_col, v_prefix
        using errcode = '23514';
    end if;
    v_actor := new.status_changed_by_actor_id;
  end if;

  if not exists (select 1 from recruitment.actor a where a.id = v_actor and a.tenant_id = new.tenant_id) then
    raise exception 'ACTOR_TENANT_MISMATCH: actor % 不存在或不属于该租户', v_actor
      using errcode = '23503';
  end if;

  -- 内部事件：状态迁移的来源（docs/03 §4 不变量 8 / §9 Event Envelope）
  insert into recruitment.event_inbox (
    event_id, tenant_id, provider, provider_event_id, event_type, schema_version,
    occurred_at, received_at, recorded_at, correlation_id, causation_id,
    idempotency_key, idempotency_source, source_object_id,
    payload_ref, payload, trust_level, normalized_event_type, normalizer_version
  ) values (
    v_event, new.tenant_id, 'internal', null, tg_table_name || '.' || v_col || '.changed', 1,
    now(), now(), now(), null, null,
    'internal:' || v_event::text, 'FALLBACK_KEY', new.id::text,
    null,
    jsonb_build_object('table', tg_table_name, 'column', v_col, 'record_id', new.id,
                       'from', v_old, 'to', v_new, 'actor_id', v_actor),
    'INTERNAL', tg_table_name || '.' || v_col || '.changed', 'schema/0001'
  );

  j := jsonb_build_object(
    v_prefix || '_changed_at',          to_jsonb(now()),
    v_prefix || '_changed_by_actor_id', to_jsonb(v_actor),
    'updated_at',                       to_jsonb(now()),
    'record_version',                   to_jsonb(old.record_version + 1)
  );
  if v_prefix = 'status' then
    j := j || jsonb_build_object('status_source_event_id', to_jsonb(v_event));
  else
    j := j || jsonb_build_object('stage_source_event_id', to_jsonb(v_event));
  end if;

  new := jsonb_populate_record(new, j);
  return new;
end $$;

-- Candidate 身份状态只能经 candidate_merge 变更（docs/03 §6 第 4/5/7 条）
create or replace function recruitment.fn_candidate_identity_guard() returns trigger
language plpgsql as $$
begin
  if new.identity_status is distinct from old.identity_status
     and not exists (select 1 from recruitment.candidate_merge m
                     where m.merged_candidate_id = new.id
                       and m.tenant_id = new.tenant_id) then
    raise exception 'CANDIDATE_IDENTITY_UNTRACKED: candidate % 的 identity_status 只能由 candidate_merge 记录驱动', new.id
      using errcode = '23514';
  end if;
  return new;
end $$;

-- candidate_merge 落库后，把被合并方标成 MERGED（不删除任何历史）
create or replace function recruitment.fn_candidate_merge_apply() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from recruitment.candidate c
                 where c.id = new.surviving_candidate_id
                   and c.tenant_id = new.tenant_id
                   and c.identity_status = 'ACTIVE') then
    raise exception 'MERGE_SURVIVOR_NOT_ACTIVE: 主档候选人 % 不存在或不是 ACTIVE', new.surviving_candidate_id
      using errcode = '23514';
  end if;

  update recruitment.candidate c
     set identity_status          = 'MERGED',
         merged_into_candidate_id = new.surviving_candidate_id,
         merge_id                 = new.id
   where c.id = new.merged_candidate_id
     and c.tenant_id = new.tenant_id
     and c.identity_status = 'ACTIVE';

  if not found then
    raise exception 'MERGE_TARGET_NOT_ACTIVE: 被合并候选人 % 不存在或不是 ACTIVE', new.merged_candidate_id
      using errcode = '23514';
  end if;
  return new;
end $$;

-- 已提交/已豁免的 Scorecard 内容不可改，修订必须新建 revision（docs/01 §5 阶段10）
create or replace function recruitment.fn_scorecard_guard() returns trigger
language plpgsql as $$
declare
  a jsonb;
  b jsonb;
begin
  if old.status <> 'PENDING' then
    a := to_jsonb(new) - 'superseded_by_scorecard_id' - 'record_version' - 'updated_at'
                        - 'status_changed_at' - 'status_changed_by_actor_id' - 'status_source_event_id';
    b := to_jsonb(old) - 'superseded_by_scorecard_id' - 'record_version' - 'updated_at'
                        - 'status_changed_at' - 'status_changed_by_actor_id' - 'status_source_event_id';
    if a is distinct from b then
      raise exception 'SCORECARD_IMMUTABLE: 已提交/已豁免的 Scorecard 不可修改（修订必须新建 revision_no）'
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- 仅做版本自增（用于没有状态列、但仍需乐观并发的表）
create or replace function recruitment.fn_touch() returns trigger
language plpgsql as $$
begin
  new := jsonb_populate_record(new, jsonb_build_object(
    'updated_at',     to_jsonb(now()),
    'record_version', to_jsonb(old.record_version + 1)
  ));
  return new;
end $$;

-- 转写内容尚未到达的合法状态（供 transcript_artifact 的 CHECK 使用）
create or replace function recruitment.payload_pending_ok(p_status text) returns boolean
language sql immutable as $$
  select p_status in ('DISCOVERED','FETCHING','WAITING_EXTERNAL','AUTH_REQUIRED','NEEDS_LINKING')
$$;

-- 已决审批不可改判（docs/03 §18：内容实质变化 → 原 Approval 失效，必须重新审批）
create or replace function recruitment.fn_approval_guard() returns trigger
language plpgsql as $$
begin
  if old.status <> 'PENDING' then
    if (to_jsonb(new) - 'superseded_by_approval_id' - 'record_version' - 'updated_at'
                      - 'status_changed_at' - 'status_changed_by_actor_id' - 'status_source_event_id')
       is distinct from
       (to_jsonb(old) - 'superseded_by_approval_id' - 'record_version' - 'updated_at'
                      - 'status_changed_at' - 'status_changed_by_actor_id' - 'status_source_event_id') then
      raise exception 'APPROVAL_FINAL: 已决审批不可改判；内容变化必须新建审批并让原审批 SUPERSEDED'
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;


-- =====================================================================
--  1. 组织与身份 · Organization / Department / User · Role
-- =====================================================================

create table if not exists recruitment.organization (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'Asia/Shanghai',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ck_organization_name check (length(btrim(name)) between 1 and 200),
  constraint ck_organization_timezone check (length(btrim(timezone)) between 1 and 64)
);

-- 事件入口必须先建：actor / approval / requisition 等表的状态审计列都要引用它
-- docs/03 §9 Event Envelope 十四个字段 + 接收规则 6 条（对应 §2 的注释占位）
create table if not exists recruitment.event_inbox (
  event_id             uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references recruitment.organization (id),
  provider             text not null,
  provider_event_id    text,
  event_type           text not null,
  schema_version       integer not null default 1,
  occurred_at          timestamptz,
  received_at          timestamptz not null default now(),
  recorded_at          timestamptz not null default now(),
  correlation_id       uuid,
  causation_id         uuid,
  idempotency_key      text not null,
  idempotency_source   text not null default 'PROVIDER_EVENT_ID',
  source_object_id     text,
  payload_ref          text,
  payload              jsonb,
  trust_level          text not null,
  normalized_event_type text,
  normalizer_version   text,
  processed_at         timestamptz,
  updated_at           timestamptz not null default now(),
  constraint uq_event_inbox_id_tenant unique (event_id, tenant_id),
  constraint uq_event_inbox_idempotency unique (tenant_id, idempotency_key),
  constraint fk_event_inbox_causation foreign key (causation_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_event_inbox_schema_version check (schema_version >= 1),
  constraint ck_event_inbox_idempotency_source check (idempotency_source in ('PROVIDER_EVENT_ID','FALLBACK_KEY')),
  -- 只有拿不到事件 ID 时才允许备用键；备用键必须绑一个真实对象 ID，不能只按文本哈希
  constraint ck_event_inbox_fallback_no_event_id check (idempotency_source <> 'FALLBACK_KEY' or provider_event_id is null),
  constraint ck_event_inbox_fallback_object check (idempotency_source <> 'FALLBACK_KEY' or source_object_id is not null),
  -- 外部文本始终不可信，不因 webhook 验源而变成指令
  constraint ck_event_inbox_trust check (trust_level in ('UNTRUSTED_EXTERNAL','INTERNAL')),
  constraint ck_event_inbox_internal_trust check (provider <> 'internal' or trust_level = 'INTERNAL'),
  -- 大文件不进事件表：至少要留 payload 或 payload_ref 之一
  constraint ck_event_inbox_payload check (payload is not null or payload_ref is not null),
  constraint ck_event_inbox_payload_object check (payload is null or jsonb_typeof(payload) = 'object'),
  constraint ck_event_inbox_recorded check (recorded_at >= received_at)
);

create index if not exists ix_event_inbox_received on recruitment.event_inbox (tenant_id, received_at desc);
create index if not exists ix_event_inbox_type on recruitment.event_inbox (tenant_id, event_type, received_at desc);

create table if not exists recruitment.department (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  name                   text not null,
  parent_department_id   uuid,
  hiring_manager_actor_id uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint uq_department_id_tenant unique (id, tenant_id),
  constraint fk_department_tenant foreign key (tenant_id) references recruitment.organization (id),
  constraint fk_department_parent foreign key (parent_department_id, tenant_id)
    references recruitment.department (id, tenant_id),
  constraint ck_department_name check (length(btrim(name)) between 1 and 200),
  constraint ck_department_not_self_parent check (parent_department_id is null or parent_department_id <> id)
);

create table if not exists recruitment.actor (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references recruitment.organization (id),
  kind          text not null default 'HUMAN',
  display_name  text not null,
  primary_email text,
  department_id uuid,
  status        text not null default 'ACTIVE',
  status_changed_at timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint uq_actor_id_tenant unique (id, tenant_id),
  constraint uq_actor_email unique (tenant_id, primary_email),
  constraint fk_actor_department foreign key (department_id, tenant_id)
    references recruitment.department (id, tenant_id),
  constraint fk_actor_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_actor_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_actor_kind check (kind in ('HUMAN','SYSTEM','AGENT_WORKER')),
  constraint ck_actor_status check (status in ('ACTIVE','DISABLED')),
  constraint ck_actor_name check (length(btrim(display_name)) between 1 and 200),
  -- 邮箱先规范化再匹配（docs/03 §6 第 1 条：强标识用于匹配建议）
  constraint ck_actor_email_normalized check (
    primary_email is null
    or (primary_email = lower(btrim(primary_email))
        and primary_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
);

create table if not exists recruitment.role (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references recruitment.organization (id),
  code        text not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  constraint uq_role_code unique (tenant_id, code),
  constraint ck_role_code check (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  constraint ck_role_name check (length(btrim(name)) between 1 and 120)
);

create table if not exists recruitment.actor_role (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references recruitment.organization (id),
  actor_id            uuid not null,
  role_id             uuid not null references recruitment.role (id),
  scope_department_id uuid,
  granted_by_actor_id uuid,
  granted_at          timestamptz not null default now(),
  revoked_at          timestamptz,
  constraint uq_actor_role unique nulls not distinct (tenant_id, actor_id, role_id, scope_department_id),
  constraint fk_actor_role_actor foreign key (actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_actor_role_dept foreign key (scope_department_id, tenant_id)
    references recruitment.department (id, tenant_id),
  constraint fk_actor_role_granted_by foreign key (granted_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint ck_actor_role_revoked check (revoked_at is null or revoked_at >= granted_at)
);


-- =====================================================================
--  2. 事件入口 · Event Inbox / Event
--     已提前到 §1 之前建（actor 等表的状态审计列要引用它），此处仅作索引说明
-- =====================================================================


-- =====================================================================
--  3. 审批 · Approval
--     docs/03 §18：审批绑内容（resource_version + payload_hash + schema_version）
-- =====================================================================

create table if not exists recruitment.approval (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references recruitment.organization (id),
  resource_type            text not null,
  resource_id              uuid not null,
  resource_record_version  integer not null,
  payload_schema_version   integer not null default 1,
  canonical_payload_hash   text not null,
  status                   text not null default 'PENDING',
  requested_by_actor_id    uuid,
  decision_by_actor_id     uuid,
  decided_at               timestamptz,
  reason                   text,
  expires_at               timestamptz,
  superseded_by_approval_id uuid,
  status_changed_at        timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id   uuid,
  record_version           integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint uq_approval_id_tenant unique (id, tenant_id),
  constraint fk_approval_requested_by foreign key (requested_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_approval_decided_by foreign key (decision_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_approval_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_approval_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint fk_approval_superseded_by foreign key (superseded_by_approval_id)
    references recruitment.approval (id),
  constraint ck_approval_resource_type check (resource_type in
    ('REQUISITION','JOB','JOB_VERSION','RUBRIC_VERSION','JOB_POSTING','OFFER','DECISION')),
  constraint ck_approval_status check (status in
    ('PENDING','APPROVED','REJECTED','EXPIRED','SUPERSEDED','WITHDRAWN')),
  constraint ck_approval_hash check (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_approval_versions check (resource_record_version >= 1 and payload_schema_version >= 1 and record_version >= 1),
  -- 决定必须留责任人 + 时间（docs/03 §4 不变量 9）
  constraint ck_approval_decided_fields check (
    (status = 'PENDING'  and decided_at is null     and decision_by_actor_id is null)
    or
    (status <> 'PENDING' and decided_at is not null and decision_by_actor_id is not null)
  ),
  constraint ck_approval_reject_reason check (status <> 'REJECTED' or length(btrim(coalesce(reason, ''))) > 0),
  constraint ck_approval_supersede_link check (status <> 'SUPERSEDED' or superseded_by_approval_id is not null),
  constraint ck_approval_expiry check (expires_at is null or expires_at > created_at),
  constraint ck_approval_self_supersede check (superseded_by_approval_id is null or superseded_by_approval_id <> id)
);

create index if not exists ix_approval_resource on recruitment.approval (tenant_id, resource_type, resource_id);


-- =====================================================================
--  4. 需求 / 岗位 / 配置 · Requisition / Job / Job Posting / Business Config / Rubric
-- =====================================================================

create table if not exists recruitment.requisition (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references recruitment.organization (id),
  department_id            uuid not null,
  title                    text not null,
  headcount                integer not null default 1,
  filled_headcount         integer not null default 0,
  target_start_date        date,
  status                   text not null default 'DRAFT',
  status_changed_at        timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id   uuid,
  record_version           integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint uq_requisition_id_tenant unique (id, tenant_id),
  constraint fk_requisition_department foreign key (department_id, tenant_id)
    references recruitment.department (id, tenant_id),
  constraint fk_requisition_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_requisition_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_requisition_status check (status in
    ('DRAFT','PENDING_APPROVAL','APPROVED','RECRUITING','PAUSED','FILLED','CANCELLED')),
  constraint ck_requisition_title check (length(btrim(title)) between 1 and 200),
  constraint ck_requisition_headcount check (headcount between 1 and 1000 and filled_headcount between 0 and headcount),
  -- 人员离职事件只产生需求信号，不直接把 Requisition 设为 Approved（docs/03 §3 边界）：
  -- Approved 必须能追溯到 status_source_event_id（由 fn_row_guard 强制），本处补一条 FILLED 的数量一致性
  constraint ck_requisition_filled check (status <> 'FILLED' or filled_headcount >= headcount)
);

create table if not exists recruitment.job (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references recruitment.organization (id),
  department_id          uuid not null,
  requisition_id         uuid,
  code                   text not null,
  title                  text not null,
  status                 text not null default 'DRAFT',
  current_job_version_id uuid,
  status_changed_at      timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version         integer not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint uq_job_id_tenant unique (id, tenant_id),
  constraint uq_job_code unique (tenant_id, code),
  constraint fk_job_department foreign key (department_id, tenant_id)
    references recruitment.department (id, tenant_id),
  constraint fk_job_requisition foreign key (requisition_id, tenant_id)
    references recruitment.requisition (id, tenant_id),
  constraint fk_job_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_job_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_job_status check (status in
    ('DRAFT','PENDING_REVIEW','APPROVED','OPEN','PAUSED','CLOSED','ARCHIVED')),
  constraint ck_job_code_format check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$'),
  constraint ck_job_title check (length(btrim(title)) between 1 and 200)
);

create table if not exists recruitment.job_version (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references recruitment.organization (id),
  job_id                  uuid not null,
  version_no              integer not null,
  description_md          text,
  requirements_md         text,
  payload_hash            text not null,
  approved_by_approval_id uuid,
  created_by_actor_id     uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint uq_job_version unique (job_id, version_no),
  constraint uq_job_version_id_tenant unique (id, tenant_id),
  constraint fk_job_version_job foreign key (job_id, tenant_id)
    references recruitment.job (id, tenant_id),
  constraint fk_job_version_approval foreign key (approved_by_approval_id, tenant_id)
    references recruitment.approval (id, tenant_id),
  constraint fk_job_version_actor foreign key (created_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint ck_job_version_no check (version_no >= 1),
  constraint ck_job_version_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_job_version_content check (
    length(btrim(coalesce(description_md, ''))) > 0 or length(btrim(coalesce(requirements_md, ''))) > 0)
);

create table if not exists recruitment.business_config (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references recruitment.organization (id),
  scope               text not null,
  scope_id            uuid,
  config_key          text not null,
  version_no          integer not null,
  payload             jsonb not null,
  payload_hash        text not null,
  effective_from      timestamptz not null default now(),
  effective_to        timestamptz,
  created_by_actor_id uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_business_config unique nulls not distinct
    (tenant_id, scope, scope_id, config_key, version_no),
  constraint fk_business_config_actor foreign key (created_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint ck_business_config_scope check (scope in ('ORGANIZATION','DEPARTMENT','JOB','STAGE')),
  constraint ck_business_config_scope_id check ((scope = 'ORGANIZATION') = (scope_id is null)),
  constraint ck_business_config_key check (config_key ~ '^[a-z][a-z0-9_.]{1,60}$'),
  constraint ck_business_config_version check (version_no >= 1),
  constraint ck_business_config_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_business_config_payload check (jsonb_typeof(payload) = 'object'),
  constraint ck_business_config_window check (effective_to is null or effective_to > effective_from)
);

create table if not exists recruitment.rubric_version (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references recruitment.organization (id),
  job_id                  uuid not null,
  version_no              integer not null,
  dimensions              jsonb not null,
  payload_hash            text not null,
  approved_by_approval_id uuid,
  created_by_actor_id     uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint uq_rubric_version unique (job_id, version_no),
  constraint uq_rubric_version_id_tenant unique (id, tenant_id),
  constraint fk_rubric_version_job foreign key (job_id, tenant_id)
    references recruitment.job (id, tenant_id),
  constraint fk_rubric_version_approval foreign key (approved_by_approval_id, tenant_id)
    references recruitment.approval (id, tenant_id),
  constraint fk_rubric_version_actor foreign key (created_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint ck_rubric_version_no check (version_no >= 1),
  constraint ck_rubric_version_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_rubric_version_dimensions check (
    jsonb_typeof(dimensions) = 'array' and jsonb_array_length(dimensions) > 0)
);

-- 渠道维度先建：Job Posting 与 Intake 都要引用它
-- 注意：本表只表达业务渠道，与技术 Connector Source（provider）分开（docs/03 §1）
create table if not exists recruitment.acquisition_channel (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references recruitment.organization (id),
  channel_type text not null,
  name         text not null,
  created_at   timestamptz not null default now(),
  constraint uq_acquisition_channel_id_tenant unique (id, tenant_id),
  constraint uq_acquisition_channel_name unique (tenant_id, name),
  constraint ck_acquisition_channel_type check (channel_type in
    ('EMAIL','FORM','JOB_BOARD','REFERRAL','SOURCING','MANUAL_IMPORT','HRIS','SOCIAL')),
  constraint ck_acquisition_channel_name check (length(btrim(name)) between 1 and 120)
);

create table if not exists recruitment.job_posting (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references recruitment.organization (id),
  job_id              uuid not null,
  channel_id          uuid not null,
  status              text not null default 'DRAFT',
  external_posting_id text,
  external_url        text,
  approved_by_approval_id uuid,
  published_at        timestamptz,
  closed_at           timestamptz,
  status_changed_at   timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version      integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_job_posting_id_tenant unique (id, tenant_id),
  constraint fk_job_posting_job foreign key (job_id, tenant_id)
    references recruitment.job (id, tenant_id),
  constraint fk_job_posting_channel foreign key (channel_id, tenant_id)
    references recruitment.acquisition_channel (id, tenant_id),
  constraint fk_job_posting_approval foreign key (approved_by_approval_id, tenant_id)
    references recruitment.approval (id, tenant_id),
  constraint fk_job_posting_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_job_posting_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_job_posting_status check (status in
    ('DRAFT','PENDING_APPROVAL','PUBLISHED','INTERNAL','CLOSED','REJECTED')),
  constraint ck_job_posting_published check (status <> 'PUBLISHED' or published_at is not null),
  constraint ck_job_posting_closed check (closed_at is null or (published_at is not null and closed_at >= published_at)),
  constraint ck_job_posting_approval check (status not in ('PUBLISHED','INTERNAL') or approved_by_approval_id is not null)
);


-- =====================================================================
--  5. 接入 / 简历 / 候选人 / 申请
--     Intake 三层（docs/03 §5）· Candidate · Resume · Application
--     注：acquisition_channel 因被 Job Posting 引用，已提前到 §4 建
-- =====================================================================

create table if not exists recruitment.intake_record (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references recruitment.organization (id),
  event_id             uuid not null,
  channel_id           uuid,
  sender_ref           text,
  subject              text,
  status               text not null default 'RECEIVED',
  status_changed_at    timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version       integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint uq_intake_record_id_tenant unique (id, tenant_id),
  constraint fk_intake_record_event foreign key (event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint fk_intake_record_channel foreign key (channel_id, tenant_id)
    references recruitment.acquisition_channel (id, tenant_id),
  constraint fk_intake_record_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_intake_record_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  -- 一封转发邮件三份资料 → 三条 Intake Record：因此 event_id 不唯一
  constraint ck_intake_record_status check (status in
    ('RECEIVED','VALIDATING','READY_FOR_PROCESSING','PROCESSING','RESOLVED',
     'NEEDS_REVIEW','RETRY_WAIT','REJECTED','FAILED')),
  constraint ck_intake_record_subject check (subject is null or length(subject) <= 500)
);

create table if not exists recruitment.intake_asset (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references recruitment.organization (id),
  intake_record_id    uuid not null,
  file_name           text not null,
  mime_type           text,
  byte_size           bigint not null,
  sha256              text not null,
  storage_ref         text not null,
  validation_status   text not null default 'PENDING',
  validation_error    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_intake_asset_id_tenant unique (id, tenant_id),
  constraint fk_intake_asset_record foreign key (intake_record_id, tenant_id)
    references recruitment.intake_record (id, tenant_id),
  constraint ck_intake_asset_validation check (validation_status in ('PENDING','VALID','INVALID')),
  constraint ck_intake_asset_error check (validation_status <> 'INVALID' or length(btrim(coalesce(validation_error, ''))) > 0),
  constraint ck_intake_asset_size check (byte_size > 0 and byte_size <= 104857600),
  constraint ck_intake_asset_sha256 check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint ck_intake_asset_file_name check (length(btrim(file_name)) between 1 and 400)
);

create index if not exists ix_intake_asset_sha on recruitment.intake_asset (tenant_id, sha256);

create table if not exists recruitment.candidate (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references recruitment.organization (id),
  display_name             text not null,
  normalized_email         text,
  normalized_phone         text,
  identity_status          text not null default 'ACTIVE',
  merged_into_candidate_id uuid,
  merge_id                 uuid,
  record_version           integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint uq_candidate_id_tenant unique (id, tenant_id),
  constraint fk_candidate_merged_into foreign key (merged_into_candidate_id, tenant_id)
    references recruitment.candidate (id, tenant_id),
  constraint ck_candidate_identity_status check (identity_status in ('ACTIVE','MERGED')),
  constraint ck_candidate_name check (length(btrim(display_name)) between 1 and 200),
  constraint ck_candidate_email_normalized check (
    normalized_email is null
    or (normalized_email = lower(btrim(normalized_email))
        and normalized_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  constraint ck_candidate_phone_normalized check (
    normalized_phone is null or normalized_phone ~ '^\+?[0-9]{5,20}$'),
  constraint ck_candidate_not_self check (merged_into_candidate_id is null or merged_into_candidate_id <> id),
  constraint ck_candidate_merged_fields check (
    identity_status <> 'MERGED' or (merged_into_candidate_id is not null and merge_id is not null))
);

-- 同一租户下 ACTIVE 候选人的强标识唯一：不重复创建候选人（docs/01 §5 阶段6 异常表）
-- 冲突时走 candidate_merge（人类闸门 5 / 2026-11-12 D-7 自动归并），不是新建第二条 ACTIVE
create unique index if not exists uq_candidate_active_email on recruitment.candidate (tenant_id, normalized_email)
  where normalized_email is not null and identity_status = 'ACTIVE';
create unique index if not exists uq_candidate_active_phone on recruitment.candidate (tenant_id, normalized_phone)
  where normalized_phone is not null and identity_status = 'ACTIVE';

create table if not exists recruitment.candidate_merge (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references recruitment.organization (id),
  surviving_candidate_id  uuid not null,
  merged_candidate_id     uuid not null,
  match_basis             jsonb not null,
  auto_merged             boolean not null default false,
  decided_by_actor_id     uuid,
  decided_at              timestamptz not null default now(),
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint uq_candidate_merge_id_tenant unique (id, tenant_id),
  constraint uq_candidate_merge_pair unique (tenant_id, surviving_candidate_id, merged_candidate_id),
  constraint fk_candidate_merge_surviving foreign key (surviving_candidate_id, tenant_id)
    references recruitment.candidate (id, tenant_id),
  constraint fk_candidate_merge_merged foreign key (merged_candidate_id, tenant_id)
    references recruitment.candidate (id, tenant_id),
  constraint fk_candidate_merge_actor foreign key (decided_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint ck_candidate_merge_distinct check (surviving_candidate_id <> merged_candidate_id),
  -- 匹配依据必须是对象且非空：自动归并也要留下多维依据（不可 LLM 独立决定）
  constraint ck_candidate_merge_basis check (jsonb_typeof(match_basis) = 'object' and match_basis <> '{}'::jsonb),
  constraint ck_candidate_merge_actor check (auto_merged or decided_by_actor_id is not null),
  constraint ck_candidate_merge_time check (decided_at >= created_at)
);

create table if not exists recruitment.resume (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references recruitment.organization (id),
  candidate_id    uuid,
  intake_asset_id uuid not null,
  channel_id      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint uq_resume_id_tenant unique (id, tenant_id),
  constraint fk_resume_candidate foreign key (candidate_id, tenant_id)
    references recruitment.candidate (id, tenant_id),
  constraint fk_resume_asset foreign key (intake_asset_id, tenant_id)
    references recruitment.intake_asset (id, tenant_id),
  constraint fk_resume_channel foreign key (channel_id, tenant_id)
    references recruitment.acquisition_channel (id, tenant_id)
);

create table if not exists recruitment.resume_version (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references recruitment.organization (id),
  resume_id          uuid not null,
  version_no         integer not null,
  source_asset_sha256 text not null,
  content_sha256     text not null,
  parser_name        text not null,
  parser_version     text not null,
  parse_status       text not null default 'PENDING',
  parse_error        text,
  parsed_fields      jsonb not null default '{}'::jsonb,
  evidence           jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_resume_version unique (resume_id, version_no),
  constraint uq_resume_version_id_tenant unique (id, tenant_id),
  constraint fk_resume_version_resume foreign key (resume_id, tenant_id)
    references recruitment.resume (id, tenant_id),
  constraint ck_resume_version_no check (version_no >= 1),
  constraint ck_resume_version_sha check (
    source_asset_sha256 ~ '^[0-9a-f]{64}$' and content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ck_resume_version_status check (parse_status in
    ('PENDING','PARSING','PARSED','PARTIAL','FAILED','NEEDS_REVIEW')),
  constraint ck_resume_version_error check (parse_status <> 'FAILED' or length(btrim(coalesce(parse_error, ''))) > 0),
  constraint ck_resume_version_fields check (jsonb_typeof(parsed_fields) = 'object'),
  constraint ck_resume_version_evidence check (jsonb_typeof(evidence) = 'array')
);

create table if not exists recruitment.application (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references recruitment.organization (id),
  candidate_id       uuid not null,
  job_id             uuid not null,
  job_version_id     uuid not null,
  rubric_version_id  uuid,
  channel_id         uuid,
  resume_version_id  uuid,
  -- 四轴之一：Application Lifecycle（不设单一 status，docs/03 §3）
  lifecycle_status   text not null default 'ACTIVE',
  -- 四轴之二：Pipeline Instance 的当前阶段（v1.0 单流程，见 SCHEMA.md 映射裁决 M-3）
  current_stage_code text not null default 'SCREENING',
  stage_entered_at   timestamptz not null default now(),
  stage_blocked_reason text,
  applied_at         timestamptz not null default now(),
  status_changed_at  timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  stage_changed_at   timestamptz not null default now(),
  stage_changed_by_actor_id uuid,
  stage_source_event_id uuid,
  record_version     integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_application_id_tenant unique (id, tenant_id),
  -- 不变量 1：一个 Application 必须关联一个 Candidate 和一个 Job
  constraint fk_application_candidate foreign key (candidate_id, tenant_id)
    references recruitment.candidate (id, tenant_id),
  constraint fk_application_job foreign key (job_id, tenant_id)
    references recruitment.job (id, tenant_id),
  constraint fk_application_job_version foreign key (job_version_id, tenant_id)
    references recruitment.job_version (id, tenant_id),
  constraint fk_application_rubric foreign key (rubric_version_id, tenant_id)
    references recruitment.rubric_version (id, tenant_id),
  constraint fk_application_channel foreign key (channel_id, tenant_id)
    references recruitment.acquisition_channel (id, tenant_id),
  constraint fk_application_resume_version foreign key (resume_version_id, tenant_id)
    references recruitment.resume_version (id, tenant_id),
  constraint fk_application_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_application_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint fk_application_stage_actor foreign key (stage_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_application_stage_event foreign key (stage_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_application_lifecycle_status check (lifecycle_status in
    ('ACTIVE','ON_HOLD','WITHDRAWN','CLOSED')),
  constraint ck_application_stage_code check (current_stage_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  constraint ck_application_blocked_reason check (
    stage_blocked_reason is null or length(btrim(stage_blocked_reason)) > 0),
  constraint ck_application_applied check (applied_at <= created_at + interval '1 day')
);

create index if not exists ix_application_candidate on recruitment.application (tenant_id, candidate_id);
create index if not exists ix_application_job on recruitment.application (tenant_id, job_id);
create index if not exists ix_application_stage on recruitment.application (tenant_id, current_stage_code);


-- =====================================================================
--  6. 面试 / 会议 / 转写 / 记录 / 评价 / 决策
-- =====================================================================

create table if not exists recruitment.interview_template_version (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references recruitment.organization (id),
  job_id             uuid,
  template_code      text not null,
  round_no           integer not null,
  version_no         integer not null,
  objective          text,
  briefing           jsonb not null default '{}'::jsonb,
  focus_attributes   jsonb not null default '[]'::jsonb,
  question_templates jsonb not null default '[]'::jsonb,
  feedback_form      jsonb not null default '{}'::jsonb,
  rubric_version_id  uuid,
  payload_hash       text not null,
  created_by_actor_id uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_interview_template_version unique (tenant_id, template_code, version_no),
  constraint uq_interview_template_id_tenant unique (id, tenant_id),
  constraint fk_interview_template_job foreign key (job_id, tenant_id)
    references recruitment.job (id, tenant_id),
  constraint fk_interview_template_rubric foreign key (rubric_version_id, tenant_id)
    references recruitment.rubric_version (id, tenant_id),
  constraint fk_interview_template_actor foreign key (created_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint ck_interview_template_code check (template_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  constraint ck_interview_template_versions check (round_no >= 1 and version_no >= 1),
  constraint ck_interview_template_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_interview_template_json check (
    jsonb_typeof(briefing) = 'object' and jsonb_typeof(feedback_form) = 'object'
    and jsonb_typeof(focus_attributes) = 'array' and jsonb_typeof(question_templates) = 'array')
);

create table if not exists recruitment.interview (
  id                             uuid primary key default gen_random_uuid(),
  tenant_id                      uuid not null references recruitment.organization (id),
  application_id                 uuid not null,
  interview_template_version_id  uuid,
  round_no                       integer not null,
  slot_code                      text not null default 'DEFAULT',
  stage_code                     text not null default 'INTERVIEW',
  status                         text not null default 'SCHEDULED',
  scheduled_start_at             timestamptz,
  scheduled_end_at               timestamptz,
  timezone                       text not null default 'Asia/Shanghai',
  status_changed_at              timestamptz not null default now(),
  status_changed_by_actor_id     uuid,
  status_source_event_id         uuid,
  record_version                 integer not null default 1,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  constraint uq_interview_id_tenant unique (id, tenant_id),
  -- 同一轮可同时有用人经理面试 + 业务专家面试：按 slot 区分，各自独立 Interview
  constraint uq_interview_slot unique (application_id, round_no, slot_code),
  constraint fk_interview_application foreign key (application_id, tenant_id)
    references recruitment.application (id, tenant_id),
  constraint fk_interview_template foreign key (interview_template_version_id, tenant_id)
    references recruitment.interview_template_version (id, tenant_id),
  constraint fk_interview_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_interview_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_interview_status check (status in
    ('SCHEDULED','IN_PROGRESS','POST_INTERVIEW','EVALUATION_READY','DECIDED',
     'RESCHEDULED','CANCELLED','NO_SHOW')),
  -- 不变量 4：Interview 必须关联明确的 Application 和面试轮次
  constraint ck_interview_round check (round_no between 1 and 20),
  constraint ck_interview_slot_code check (slot_code ~ '^[A-Z][A-Z0-9_]{1,20}$'),
  constraint ck_interview_stage_code check (stage_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  constraint ck_interview_window check (
    scheduled_end_at is null or scheduled_start_at is null or scheduled_end_at > scheduled_start_at),
  constraint ck_interview_scheduled check (
    status not in ('SCHEDULED','IN_PROGRESS','POST_INTERVIEW','EVALUATION_READY','DECIDED')
    or scheduled_start_at is not null)
);

create table if not exists recruitment.interviewer (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references recruitment.organization (id),
  interview_id        uuid not null,
  actor_id            uuid not null,
  role_in_interview   text not null default 'INTERVIEWER',
  required_scorecard  boolean not null default true,
  scorecard_due_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_interviewer_id_tenant unique (id, tenant_id),
  constraint uq_interviewer unique (interview_id, actor_id),
  constraint fk_interviewer_interview foreign key (interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  constraint fk_interviewer_actor foreign key (actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint ck_interviewer_role check (role_in_interview ~ '^[A-Z][A-Z0-9_]{1,30}$')
);

create table if not exists recruitment.meeting (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references recruitment.organization (id),
  provider           text not null,
  account_scope      text,
  external_meeting_id text,
  calendar_event_id  text,
  meeting_role       text not null default 'PRIMARY',
  actual_start_at    timestamptz,
  actual_end_at      timestamptz,
  record_version     integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_meeting_id_tenant unique (id, tenant_id),
  -- 不变量 5：靠平台 ID 绑定，不能靠标题猜测 —— 本表刻意不存标题字段
  constraint ck_meeting_identity check (external_meeting_id is not null or calendar_event_id is not null),
  constraint ck_meeting_role check (meeting_role in ('PRIMARY','CONTINUATION','REPLACED','CANCELLED')),
  constraint ck_meeting_window check (
    actual_end_at is null or actual_start_at is null or actual_end_at > actual_start_at)
);

create unique index if not exists uq_meeting_external on recruitment.meeting (tenant_id, provider, external_meeting_id)
  where external_meeting_id is not null;

create table if not exists recruitment.meeting_binding (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references recruitment.organization (id),
  meeting_id         uuid not null,
  interview_id       uuid not null,
  binding_method     text not null,
  bound_by_actor_id  uuid,
  bound_at           timestamptz not null default now(),
  unbound_at         timestamptz,
  unbound_reason     text,
  record_version     integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_meeting_binding_id_tenant unique (id, tenant_id),
  constraint fk_meeting_binding_meeting foreign key (meeting_id, tenant_id)
    references recruitment.meeting (id, tenant_id),
  constraint fk_meeting_binding_interview foreign key (interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  constraint fk_meeting_binding_actor foreign key (bound_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint ck_meeting_binding_method check (binding_method in ('SCHEDULED','MANUAL','EVENT_MATCH')),
  -- 禁止模糊匹配直接写业务关系：事件匹配也算一种方法，但人工绑定必须留人
  constraint ck_meeting_binding_manual_actor check (binding_method <> 'MANUAL' or bound_by_actor_id is not null),
  constraint ck_meeting_binding_unbound check (unbound_at is null or length(btrim(coalesce(unbound_reason, ''))) > 0),
  constraint ck_meeting_binding_time check (unbound_at is null or unbound_at >= bound_at)
);

-- 同一会议同一时刻只能绑一个面试（Golden Path 的 409 MEETING_ALREADY_BOUND）
create unique index if not exists uq_meeting_binding_active
  on recruitment.meeting_binding (meeting_id) where unbound_at is null;

create table if not exists recruitment.transcript_artifact (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references recruitment.organization (id),
  meeting_id            uuid not null,
  provider              text not null,
  provider_artifact_id  text not null,
  source_revision       integer not null default 1,
  variant_type          text not null default 'ORIGINAL',
  language              text,
  transcript_status     text not null default 'DISCOVERED',
  -- docs R4：外部能力三维正交标注，禁止混用一维枚举
  provenance            text not null,
  trigger_mode          text not null,
  connection_state      text not null,
  source_generated_at   timestamptz,
  fetched_at            timestamptz,
  last_readback_at      timestamptz,
  read_receipt_ref      text,
  content_sha256        text,
  page_count            integer,
  has_more              boolean not null default false,
  next_cursor           text,
  is_complete           boolean not null default false,
  raw_payload           jsonb,
  raw_text              text,
  is_canonical          boolean not null default false,
  canonical_selected_by_actor_id uuid,
  status_changed_at     timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version        integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint uq_transcript_artifact_id_tenant unique (id, tenant_id),
  constraint uq_transcript_artifact_id_revision unique (id, source_revision),
  constraint fk_transcript_artifact_meeting foreign key (meeting_id, tenant_id)
    references recruitment.meeting (id, tenant_id),
  constraint fk_transcript_artifact_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_transcript_artifact_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint fk_transcript_artifact_canonical_actor foreign key (canonical_selected_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  -- 1 Meeting : N Artifact；平台修订 → 新 revision，不静默覆盖
  constraint uq_transcript_artifact_revision unique (meeting_id, provider_artifact_id, source_revision),
  constraint ck_transcript_artifact_status check (transcript_status in
    ('DISCOVERED','FETCHING','PARTIAL','READY','WAITING_EXTERNAL','RETRYABLE_FAILED','AUTH_REQUIRED','NEEDS_LINKING')),
  constraint ck_transcript_artifact_variant check (variant_type in
    ('ORIGINAL','TRANSLATION','OPTIMIZED','DERIVATIVE')),
  constraint ck_transcript_artifact_provenance check (provenance in ('LIVE','FIXTURE')),
  constraint ck_transcript_artifact_trigger check (trigger_mode in ('EVENT','MANUAL')),
  constraint ck_transcript_artifact_connection check (connection_state in ('CONNECTED','NOT_CONNECTED','AUTH_REQUIRED')),
  constraint ck_transcript_artifact_sha check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ck_transcript_artifact_revision check (source_revision >= 1),
  constraint ck_transcript_artifact_pages check (page_count is null or page_count >= 1),
  -- 完整性 Gate：只有取全才 READY（docs/04 §15 C）
  constraint ck_transcript_artifact_ready check (
    transcript_status <> 'READY' or (is_complete and content_sha256 is not null)),
  -- 只有取全才允许标 is_complete；CARBON 分页中断不能标 READY（docs/04 §15 C / §19）
  constraint ck_transcript_artifact_not_complete check (
    is_complete = false or transcript_status = 'READY'),
  -- LIVE 内容必须有连接器读取回执引用，禁止 Fixture 冒充 LIVE
  constraint ck_transcript_artifact_live_receipt check (
    provenance <> 'LIVE' or (read_receipt_ref is not null and fetched_at is not null)),
  -- 原文不能凭空存在
  constraint ck_transcript_artifact_content check (
    raw_payload is not null or raw_text is not null or recruitment.payload_pending_ok(transcript_status))
);

create unique index if not exists uq_transcript_artifact_canonical
  on recruitment.transcript_artifact (meeting_id) where is_canonical;

create table if not exists recruitment.transcript_segment (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references recruitment.organization (id),
  artifact_id         uuid not null,
  provider_segment_id text,
  sequence            integer not null,
  speaker_ref         text,
  speaker_label       text,
  start_ms            bigint,
  end_ms              bigint,
  content_text        text not null,
  raw_source_ref      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_transcript_segment_sequence unique (artifact_id, sequence),
  constraint fk_transcript_segment_artifact foreign key (artifact_id, tenant_id)
    references recruitment.transcript_artifact (id, tenant_id),
  constraint ck_transcript_segment_sequence check (sequence >= 0),
  constraint ck_transcript_segment_time check (
    start_ms is null or end_ms is null or (start_ms >= 0 and end_ms >= start_ms)),
  -- 平台没给的字段保持缺失，不得编造：有 speaker_label 无 speaker_ref 是允许的
  constraint ck_transcript_segment_text check (length(content_text) > 0)
);

create unique index if not exists uq_transcript_segment_provider
  on recruitment.transcript_segment (artifact_id, provider_segment_id)
  where provider_segment_id is not null;

create table if not exists recruitment.transcript_processing_run (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references recruitment.organization (id),
  artifact_id       uuid not null,
  chunk_manifest    jsonb not null default '[]'::jsonb,
  chunk_total       integer not null default 0,
  chunk_succeeded   integer not null default 0,
  chunk_failed      integer not null default 0,
  model_id          text,
  prompt_version    text,
  status            text not null default 'PENDING',
  status_changed_at timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version    integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_transcript_processing_run_id_tenant unique (id, tenant_id),
  constraint fk_transcript_processing_run_artifact foreign key (artifact_id, tenant_id)
    references recruitment.transcript_artifact (id, tenant_id),
  constraint fk_transcript_processing_run_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_transcript_processing_run_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_transcript_processing_run_status check (status in
    ('PENDING','RUNNING','PARTIAL','SUCCEEDED','FAILED')),
  constraint ck_transcript_processing_run_counts check (
    chunk_total >= 0 and chunk_succeeded >= 0 and chunk_failed >= 0
    and chunk_succeeded + chunk_failed <= chunk_total),
  constraint ck_transcript_processing_run_manifest check (jsonb_typeof(chunk_manifest) = 'array'),
  -- 所有 Chunk 完成后再汇总，不能把部分结果标为完整（docs/04 §16）
  constraint ck_transcript_processing_run_success check (
    status <> 'SUCCEEDED' or (chunk_failed = 0 and chunk_succeeded = chunk_total))
);

create table if not exists recruitment.interview_record (
  id                            uuid primary key default gen_random_uuid(),
  tenant_id                     uuid not null references recruitment.organization (id),
  interview_id                  uuid not null,
  transcript_artifact_id        uuid not null,
  transcript_revision           integer not null,
  rubric_version_id             uuid not null,
  interview_template_version_id uuid,
  schema_version                integer not null default 1,
  prompt_version                text not null,
  model_id                      text not null,
  status                        text not null default 'PENDING',
  verification_status           text not null default 'UNVERIFIED',
  sections                      jsonb not null default '{}'::jsonb,
  evidence_ok                   boolean not null default false,
  chunk_coverage                numeric(5,4),
  is_current                    boolean not null default true,
  status_changed_at             timestamptz not null default now(),
  status_changed_by_actor_id    uuid,
  status_source_event_id        uuid,
  record_version                integer not null default 1,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint uq_interview_record_id_tenant unique (id, tenant_id),
  constraint fk_interview_record_interview foreign key (interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  -- 必须引用具体 Transcript 版本（artifact + revision 双列，物理上不能指向不存在的版本）
  constraint fk_interview_record_artifact foreign key (transcript_artifact_id, transcript_revision)
    references recruitment.transcript_artifact (id, source_revision),
  constraint fk_interview_record_rubric foreign key (rubric_version_id, tenant_id)
    references recruitment.rubric_version (id, tenant_id),
  constraint fk_interview_record_template foreign key (interview_template_version_id, tenant_id)
    references recruitment.interview_template_version (id, tenant_id),
  constraint fk_interview_record_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_interview_record_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_interview_record_status check (status in
    ('PENDING','PROCESSING','PARTIAL','READY','FAILED','NEEDS_REVIEW')),
  constraint ck_interview_record_verification check (verification_status in
    ('UNVERIFIED','VERIFIED','FAILED')),
  constraint ck_interview_record_revision check (transcript_revision >= 1),
  constraint ck_interview_record_coverage check (
    chunk_coverage is null or (chunk_coverage >= 0 and chunk_coverage <= 1)),
  constraint ck_interview_record_sections check (jsonb_typeof(sections) = 'object'),
  -- 证据校验通过才 READY（docs/04 §15 D / §18）
  constraint ck_interview_record_ready check (status <> 'READY' or verification_status = 'VERIFIED')
);

create unique index if not exists uq_interview_record_current
  on recruitment.interview_record (interview_id) where is_current;

create table if not exists recruitment.ai_summary (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references recruitment.organization (id),
  interview_id          uuid,
  transcript_artifact_id uuid not null,
  transcript_revision   integer not null,
  content_md            text not null,
  cited_segments        jsonb not null,
  model_id              text not null,
  prompt_version        text not null,
  status                text not null default 'READY',
  superseded_by_ai_summary_id uuid,
  status_changed_at     timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version        integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint uq_ai_summary_id_tenant unique (id, tenant_id),
  constraint fk_ai_summary_interview foreign key (interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  constraint fk_ai_summary_artifact foreign key (transcript_artifact_id, transcript_revision)
    references recruitment.transcript_artifact (id, source_revision),
  constraint fk_ai_summary_superseded_by foreign key (superseded_by_ai_summary_id)
    references recruitment.ai_summary (id),
  constraint fk_ai_summary_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_ai_summary_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_ai_summary_status check (status in ('READY','SUPERSEDED')),
  -- 不变量 6：摘要必须引用原文与时间戳，不能是自由文本
  constraint ck_ai_summary_cites check (
    jsonb_typeof(cited_segments) = 'array' and jsonb_array_length(cited_segments) > 0),
  constraint ck_ai_summary_content check (length(content_md) > 0),
  constraint ck_ai_summary_supersede_link check (
    status <> 'SUPERSEDED' or superseded_by_ai_summary_id is not null),
  constraint ck_ai_summary_self_supersede check (
    superseded_by_ai_summary_id is null or superseded_by_ai_summary_id <> id)
);

create table if not exists recruitment.scorecard (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references recruitment.organization (id),
  interview_id            uuid not null,
  interviewer_id          uuid not null,
  -- 不变量 7：必须记录评价者和使用的评分标准版本
  rubric_version_id       uuid not null,
  revision_no             integer not null default 1,
  status                  text not null default 'PENDING',
  submitted_at            timestamptz,
  waive_reason            text,
  items                   jsonb,
  overall                 text,
  rationale               text,
  payload_hash            text,
  superseded_by_scorecard_id uuid,
  status_changed_at       timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id  uuid,
  record_version          integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint uq_scorecard_id_tenant unique (id, tenant_id),
  constraint uq_scorecard_revision unique (interview_id, interviewer_id, revision_no),
  constraint fk_scorecard_interview foreign key (interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  constraint fk_scorecard_interviewer foreign key (interviewer_id, tenant_id)
    references recruitment.interviewer (id, tenant_id),
  constraint fk_scorecard_rubric foreign key (rubric_version_id, tenant_id)
    references recruitment.rubric_version (id, tenant_id),
  constraint fk_scorecard_superseded_by foreign key (superseded_by_scorecard_id)
    references recruitment.scorecard (id),
  constraint fk_scorecard_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_scorecard_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_scorecard_status check (status in ('PENDING','SUBMITTED','WAIVED')),
  constraint ck_scorecard_revision check (revision_no >= 1),
  constraint ck_scorecard_hash check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'),
  -- 提交必须有时间 + 分项；未提交不能被补齐
  constraint ck_scorecard_submitted check (
    status <> 'SUBMITTED' or (submitted_at is not null and items is not null)),
  constraint ck_scorecard_waived check (
    status <> 'WAIVED' or length(btrim(coalesce(waive_reason, ''))) > 0),
  constraint ck_scorecard_self_supersede check (
    superseded_by_scorecard_id is null or superseded_by_scorecard_id <> id)
);

create unique index if not exists uq_scorecard_current
  on recruitment.scorecard (interview_id, interviewer_id) where superseded_by_scorecard_id is null;

create table if not exists recruitment.decision (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references recruitment.organization (id),
  application_id          uuid not null,
  interview_id            uuid,
  decision_scope          text not null,
  stage_code              text,
  result                  text not null,
  decided_by_actor_id     uuid not null,
  decided_at              timestamptz not null default now(),
  reason                  text not null,
  basis_refs              jsonb not null default '[]'::jsonb,
  approval_id             uuid,
  superseded_by_decision_id uuid,
  record_version          integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint uq_decision_id_tenant unique (id, tenant_id),
  constraint fk_decision_application foreign key (application_id, tenant_id)
    references recruitment.application (id, tenant_id),
  constraint fk_decision_interview foreign key (interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  constraint fk_decision_actor foreign key (decided_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_decision_approval foreign key (approval_id, tenant_id)
    references recruitment.approval (id, tenant_id),
  constraint fk_decision_superseded_by foreign key (superseded_by_decision_id)
    references recruitment.decision (id),
  constraint ck_decision_scope check (decision_scope in ('SCREENING','STAGE','FINAL')),
  constraint ck_decision_result check (result in ('ADVANCE','HOLD','REJECT','WITHDRAW','HIRED')),
  constraint ck_decision_stage_code check (stage_code is null or stage_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  -- 不变量 9：决策保留责任人、时间、结果和理由
  constraint ck_decision_reason check (length(btrim(reason)) > 0),
  constraint ck_decision_basis check (jsonb_typeof(basis_refs) = 'array'),
  constraint ck_decision_self_supersede check (
    superseded_by_decision_id is null or superseded_by_decision_id <> id)
);

create index if not exists ix_decision_application on recruitment.decision (tenant_id, application_id, decided_at desc);


-- =====================================================================
--  7. 运行时 · Business Task / Task Attempt / Agent Session / Durable Effect /
--              Execution Mandate / Chat Thread
-- =====================================================================

create table if not exists recruitment.chat_thread (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references recruitment.organization (id),
  external_thread_ref text,
  owner_actor_id      uuid,
  title               text,
  status              text not null default 'ACTIVE',
  status_changed_at   timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version      integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_chat_thread_id_tenant unique (id, tenant_id),
  constraint fk_chat_thread_owner foreign key (owner_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_chat_thread_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_chat_thread_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_chat_thread_status check (status in ('ACTIVE','ARCHIVED'))
);

create unique index if not exists uq_chat_thread_external
  on recruitment.chat_thread (tenant_id, external_thread_ref) where external_thread_ref is not null;

create table if not exists recruitment.business_task (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references recruitment.organization (id),
  task_type             text not null,
  business_refs         jsonb not null default '[]'::jsonb,
  title                 text not null,
  description           text,
  priority              smallint not null default 3,
  trigger_event_id      uuid,
  origin_command_id     text,
  created_by_actor_id   uuid,
  idempotency_key       text not null,
  dependency_refs       jsonb not null default '[]'::jsonb,
  status                text not null default 'PENDING',
  due_at                timestamptz,
  next_run_at           timestamptz,
  execution_mandate_id  uuid,
  current_attempt_id    uuid,
  attempt_count         integer not null default 0,
  result_ref            text,
  error_code            text,
  error_summary         text,
  completed_at          timestamptz,
  chat_thread_id        uuid,
  schema_version        integer not null default 1,
  status_changed_at     timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version        integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint uq_business_task_id_tenant unique (id, tenant_id),
  -- 同一来源事件重复到达，不重复创建任务（不变量 1）
  constraint uq_business_task_idempotency unique (tenant_id, idempotency_key),
  constraint fk_business_task_event foreign key (trigger_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint fk_business_task_actor foreign key (created_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_business_task_thread foreign key (chat_thread_id, tenant_id)
    references recruitment.chat_thread (id, tenant_id),
  constraint fk_business_task_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_business_task_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_business_task_status check (status in
    ('PENDING','READY','RUNNING','WAITING_EXTERNAL','WAITING_HUMAN','RETRY_WAIT',
     'SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELLED','SUPERSEDED')),
  constraint ck_business_task_priority check (priority between 1 and 5),
  constraint ck_business_task_refs check (
    jsonb_typeof(business_refs) = 'array' and jsonb_typeof(dependency_refs) = 'array'),
  constraint ck_business_task_attempts check (attempt_count >= 0),
  constraint ck_business_task_schema check (schema_version >= 1),
  constraint ck_business_task_title check (length(btrim(title)) between 1 and 300),
  -- 错误必须含机器可判断的 error_code（docs/03 §15）
  constraint ck_business_task_failed check (status <> 'FAILED' or error_code is not null),
  -- RUNNING 必须有当前 Attempt；等待外部时 Worker 可以退出（所以 WAITING_* 不要求 attempt）
  constraint ck_business_task_running check (status <> 'RUNNING' or current_attempt_id is not null),
  constraint ck_business_task_completed check (
    completed_at is null or status in ('SUCCEEDED','FAILED','CANCELLED','SUPERSEDED'))
);

create index if not exists ix_business_task_dispatch
  on recruitment.business_task (tenant_id, status, next_run_at);

create table if not exists recruitment.task_attempt (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references recruitment.organization (id),
  task_id               uuid not null,
  attempt_no            integer not null,
  worker_type           text not null,
  worker_id             text not null,
  status                text not null default 'CLAIMED',
  fencing_token         bigint not null default nextval('recruitment.seq_fencing_token'),
  claimed_at            timestamptz not null default now(),
  started_at            timestamptz,
  heartbeat_at          timestamptz,
  lease_expires_at      timestamptz not null,
  ended_at              timestamptz,
  agent_session_ids     uuid[] not null default '{}'::uuid[],
  input_snapshot_ref    text,
  output_ref            text,
  error_class           text,
  error_code            text,
  error_detail          text,
  retryable             boolean not null default false,
  retry_after           timestamptz,
  execution_duration_ms bigint,
  trace_id              text,
  correlation_id        uuid,
  status_changed_at     timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version        integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint uq_task_attempt_id_tenant unique (id, tenant_id),
  -- 重试保持 task_id 不变、attempt_no 递增、历史保留（不变量 2）
  constraint uq_task_attempt_no unique (task_id, attempt_no),
  constraint fk_task_attempt_task foreign key (task_id, tenant_id)
    references recruitment.business_task (id, tenant_id),
  constraint fk_task_attempt_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_task_attempt_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_task_attempt_status check (status in
    ('CLAIMED','RUNNING','SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL','TIMED_OUT','CANCELLED','ABANDONED')),
  constraint ck_task_attempt_no check (attempt_no >= 1),
  constraint ck_task_attempt_error_class check (error_class is null or error_class in
    ('TRANSIENT','WAIT_EXTERNAL','AUTH_REQUIRED','INVALID_INPUT','BUSINESS_CONFLICT',
     'PERMANENT','UNKNOWN_OUTCOME','WORKER_LOST')),
  constraint ck_task_attempt_lease check (lease_expires_at > claimed_at),
  constraint ck_task_attempt_started check (started_at is null or started_at >= claimed_at),
  constraint ck_task_attempt_ended check (ended_at is null or ended_at >= claimed_at),
  constraint ck_task_attempt_duration check (execution_duration_ms is null or execution_duration_ms >= 0),
  -- 终态必须落 ended_at
  constraint ck_task_attempt_terminal check (
    status not in ('SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL','TIMED_OUT','CANCELLED','ABANDONED')
    or ended_at is not null),
  -- 可重试失败必须给下次时间与错误分类
  constraint ck_task_attempt_retry check (
    status <> 'FAILED_RETRYABLE' or (retry_after is not null and error_class is not null)),
  constraint ck_task_attempt_final check (
    status not in ('FAILED_FINAL','TIMED_OUT') or error_class is not null)
);

-- 同一 Task 同一时刻只能有一个有效租约（不变量：不引入分布式锁）
create unique index if not exists uq_task_attempt_active_lease
  on recruitment.task_attempt (task_id) where status in ('CLAIMED','RUNNING');

create table if not exists recruitment.agent_session (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references recruitment.organization (id),
  task_id            uuid,
  attempt_id         uuid,
  runtime_kind       text not null default 'DSH',
  runtime_version    text not null,
  model_route        text not null,
  permission_version text,
  status             text not null default 'ACTIVE',
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  status_changed_at  timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version     integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_agent_session_id_tenant unique (id, tenant_id),
  constraint fk_agent_session_task foreign key (task_id, tenant_id)
    references recruitment.business_task (id, tenant_id),
  constraint fk_agent_session_attempt foreign key (attempt_id, tenant_id)
    references recruitment.task_attempt (id, tenant_id),
  constraint fk_agent_session_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_agent_session_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_agent_session_status check (status in ('ACTIVE','ENDED','LOST')),
  constraint ck_agent_session_ended check (status <> 'ENDED' or ended_at is not null),
  constraint ck_agent_session_window check (ended_at is null or ended_at >= started_at),
  -- Session 丢失 ≠ Task 丢失：business_task 不引用本表，结构上就无法让会话牵着任务
  constraint ck_agent_session_versions check (
    length(btrim(runtime_version)) > 0 and length(btrim(model_route)) > 0)
);

create table if not exists recruitment.durable_effect (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references recruitment.organization (id),
  effect_type        text not null,
  business_refs      jsonb not null default '[]'::jsonb,
  idempotency_key    text not null,
  status             text not null default 'PENDING',
  payload            jsonb not null default '{}'::jsonb,
  payload_hash       text,
  attempt_count      integer not null default 0,
  max_attempts       integer not null default 5,
  sent_at            timestamptz,
  confirmed_at       timestamptz,
  last_readback_at   timestamptz,
  readback_state     text,
  receipt_ref        text,
  receipt_payload    jsonb,
  external_id        text,
  error_code         text,
  next_attempt_at    timestamptz,
  correlation_id     uuid,
  causation_event_id uuid,
  status_changed_at  timestamptz not null default now(),
  status_changed_by_actor_id uuid,
  status_source_event_id uuid,
  record_version     integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_durable_effect_id_tenant unique (id, tenant_id),
  -- 重试沿用原 Effect ID：同一幂等键只能有一条 Effect（不变量 4）
  constraint uq_durable_effect_idempotency unique (tenant_id, idempotency_key),
  constraint fk_durable_effect_event foreign key (causation_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint fk_durable_effect_status_actor foreign key (status_changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_durable_effect_status_event foreign key (status_source_event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_durable_effect_status check (status in
    ('PENDING','CLAIMED','SENT','CONFIRMED','RETRY_WAIT','UNKNOWN_OUTCOME',
     'FAILED_FINAL','CANCELLED','COMPENSATION_REQUIRED')),
  constraint ck_durable_effect_readback check (readback_state is null or readback_state in
    ('NOT_READ','MATCH','MISMATCH','NOT_FOUND','UNREADABLE')),
  constraint ck_durable_effect_attempts check (attempt_count >= 0 and max_attempts >= 1 and attempt_count <= max_attempts),
  constraint ck_durable_effect_hash check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_durable_effect_payload check (jsonb_typeof(payload) = 'object'),
  constraint ck_durable_effect_refs check (jsonb_typeof(business_refs) = 'array'),
  constraint ck_durable_effect_sent check (status <> 'SENT' or sent_at is not null),
  -- SENT 不等于对方业务系统完成；CONFIRMED 才算
  constraint ck_durable_effect_confirmed check (
    status <> 'CONFIRMED' or (confirmed_at is not null and sent_at is not null)),
  constraint ck_durable_effect_failed check (status <> 'FAILED_FINAL' or error_code is not null),
  constraint ck_durable_effect_unknown check (
    status <> 'UNKNOWN_OUTCOME' or last_readback_at is null)
);

create index if not exists ix_durable_effect_dispatch
  on recruitment.durable_effect (tenant_id, status, next_attempt_at);

create table if not exists recruitment.execution_mandate (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references recruitment.organization (id),
  actor_id           uuid not null,
  actor_type         text not null,
  task_id            uuid,
  role               text,
  permission_version text not null,
  resource_scope     jsonb not null default '{}'::jsonb,
  allowed_tools      text[] not null default '{}'::text[],
  allowed_actions    text[] not null default '{}'::text[],
  approval_refs      uuid[] not null default '{}'::uuid[],
  issued_at          timestamptz not null default now(),
  expires_at         timestamptz not null,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_execution_mandate_id_tenant unique (id, tenant_id),
  constraint fk_execution_mandate_actor foreign key (actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_execution_mandate_task foreign key (task_id, tenant_id)
    references recruitment.business_task (id, tenant_id),
  constraint ck_execution_mandate_actor_type check (actor_type in ('HUMAN','SYSTEM','AGENT_WORKER')),
  constraint ck_execution_mandate_scope check (jsonb_typeof(resource_scope) = 'object'),
  constraint ck_execution_mandate_window check (expires_at > issued_at),
  constraint ck_execution_mandate_revoked check (revoked_at is null or revoked_at >= issued_at),
  -- Mandate 是技术执行授权，不是 HR 业务审批（docs/03 §12）：
  -- 这些动作永远不能出现在 mandate 里，人类闸门只能由人来做
  constraint ck_execution_mandate_no_business_approval check (
    not (allowed_actions && array['approve','reject','decide','merge_candidate','waive_scorecard']))
);


-- =====================================================================
--  8. 循环外键（建表顺序所限，用幂等 DO 块补）
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_constraint c
                 where c.conname = 'fk_department_hiring_manager'
                   and c.conrelid = 'recruitment.department'::regclass) then
    alter table recruitment.department
      add constraint fk_department_hiring_manager
      foreign key (hiring_manager_actor_id, tenant_id) references recruitment.actor (id, tenant_id);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint c
                 where c.conname = 'fk_job_current_version'
                   and c.conrelid = 'recruitment.job'::regclass) then
    alter table recruitment.job
      add constraint fk_job_current_version
      foreign key (current_job_version_id, tenant_id) references recruitment.job_version (id, tenant_id);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint c
                 where c.conname = 'fk_candidate_merge'
                   and c.conrelid = 'recruitment.candidate'::regclass) then
    alter table recruitment.candidate
      add constraint fk_candidate_merge
      foreign key (merge_id, tenant_id) references recruitment.candidate_merge (id, tenant_id);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint c
                 where c.conname = 'fk_business_task_current_attempt'
                   and c.conrelid = 'recruitment.business_task'::regclass) then
    alter table recruitment.business_task
      add constraint fk_business_task_current_attempt
      foreign key (current_attempt_id, tenant_id) references recruitment.task_attempt (id, tenant_id);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint c
                 where c.conname = 'fk_business_task_mandate'
                   and c.conrelid = 'recruitment.business_task'::regclass) then
    alter table recruitment.business_task
      add constraint fk_business_task_mandate
      foreign key (execution_mandate_id, tenant_id) references recruitment.execution_mandate (id, tenant_id);
  end if;
end $$;


-- =====================================================================
--  9. 触发器
-- =====================================================================

-- 9.1 历史事实禁删
do $$
declare
  t text;
begin
  foreach t in array array[
    'organization','department','actor','role','actor_role','event_inbox','approval',
    'acquisition_channel','requisition','job','job_version','business_config','rubric_version',
    'job_posting','intake_record','intake_asset','candidate','candidate_merge','resume',
    'resume_version','application','interview_template_version','interview','interviewer',
    'meeting','meeting_binding','transcript_artifact','transcript_processing_run',
    'interview_record','ai_summary','scorecard','decision','chat_thread','business_task',
    'task_attempt','agent_session','durable_effect','execution_mandate'
  ] loop
    execute format('drop trigger if exists trg_%s_no_delete on recruitment.%I', t, t);
    execute format('create trigger trg_%s_no_delete before delete on recruitment.%I
                    for each row execute function recruitment.fn_block_delete()', t, t);
  end loop;
end $$;

-- 9.2 状态护栏（版本自增 + 迁移审计）
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('requisition',                'status',           'status'),
      ('job',                        'status',           'status'),
      ('job_posting',                'status',           'status'),
      ('intake_record',              'status',           'status'),      ('application',                'lifecycle_status', 'status'),
      ('application',                'current_stage_code','stage'),
      ('interview',                  'status',           'status'),
      ('transcript_artifact',        'transcript_status','status'),
      ('interview_record',           'status',           'status'),
      ('scorecard',                  'status',           'status'),
      ('approval',                   'status',           'status'),
      ('business_task',              'status',           'status'),
      ('task_attempt',               'status',           'status'),
      ('agent_session',              'status',           'status'),
      ('durable_effect',             'status',           'status'),
      ('actor',                      'status',           'status'),
      ('chat_thread',                'status',           'status'),
      ('transcript_processing_run',  'status',           'status'),
      ('ai_summary',                 'status',           'status')
    ) as v(tbl, col, prefix)  loop
    execute format('drop trigger if exists trg_%s_guard_%s on recruitment.%I', r.tbl, r.col, r.tbl);
    execute format('create trigger trg_%s_guard_%s before update on recruitment.%I
                    for each row execute function recruitment.fn_row_guard(%L, %L)',
                   r.tbl, r.col, r.tbl, r.col, r.prefix);
  end loop;
end $$;

-- 9.3 列级不可变（原始资料 / 配置版本 / 已定事实）
do $$
declare
  r record;
begin
  for r in
    select * from (values
      -- 平台原始转写：只允许状态与抓取元数据变化，原文与来源 ID 不可改
      ('transcript_artifact', 'transcript_status,fetched_at,last_readback_at,page_count,has_more,next_cursor,is_complete,is_canonical,canonical_selected_by_actor_id'),
      ('resume_version',      ''),
      ('rubric_version',      ''),
      ('job_version',         ''),
      ('business_config',     ''),
      ('interview_template_version', ''),
      ('candidate_merge',     ''),
      ('event_inbox',         'processed_at'),
      ('decision',            'superseded_by_decision_id'),
      ('ai_summary',          'status,superseded_by_ai_summary_id')
    ) as v(tbl, allowed)
  loop
    execute format('drop trigger if exists trg_%s_immutable on recruitment.%I', r.tbl, r.tbl);
    if r.allowed = '' then
      execute format('create trigger trg_%s_immutable before update on recruitment.%I
                      for each row execute function recruitment.fn_guard_columns()', r.tbl, r.tbl);
    else
      execute format('create trigger trg_%s_immutable before update on recruitment.%I
                      for each row execute function recruitment.fn_guard_columns(%s)',
                     r.tbl, r.tbl,
                     (select string_agg(quote_literal(x), ',') from unnest(string_to_array(r.allowed, ',')) as x));
    end if;
  end loop;
end $$;

-- 9.4 专用护栏
drop trigger if exists trg_candidate_identity_guard on recruitment.candidate;
create trigger trg_candidate_identity_guard before update on recruitment.candidate
for each row execute function recruitment.fn_candidate_identity_guard();

drop trigger if exists trg_candidate_merge_apply on recruitment.candidate_merge;
create trigger trg_candidate_merge_apply after insert on recruitment.candidate_merge
for each row execute function recruitment.fn_candidate_merge_apply();

drop trigger if exists trg_scorecard_submitted_guard on recruitment.scorecard;
create trigger trg_scorecard_submitted_guard before update on recruitment.scorecard
for each row execute function recruitment.fn_scorecard_guard();

drop trigger if exists trg_approval_final_guard on recruitment.approval;
create trigger trg_approval_final_guard before update on recruitment.approval
for each row execute function recruitment.fn_approval_guard();

-- 9.5 candidate 也走版本自增（身份状态由 candidate_merge 驱动，另有专用触发器）
drop trigger if exists trg_candidate_touch on recruitment.candidate;
create trigger trg_candidate_touch before update on recruitment.candidate
for each row execute function recruitment.fn_touch();


commit;
