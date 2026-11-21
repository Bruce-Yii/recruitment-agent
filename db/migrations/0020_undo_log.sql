-- =====================================================================
--  recruitment-agent · 0020_undo_log.sql
--
--  主题：前端确认卡的「批量不通过」与「撤销（5 秒 Toast）」两个 HTTP 动作的
--  **结构面 / 审计凭证面**。工具面保持 33 不变（两个动作都是 HTTP Host Action，
--  不新增工具）；不新增事件类型——逐条审计靠既有决策域的 `decision.record`
--  事件与排期域的 `interview.cancelled` 事件，本迁移只提供"这一批是一次操作"
--  的库内凭证与撤销窗口判定所需的事实。
--
--  两张 append-only 表：
--    * recruitment.batch_operation —— 一行 = 一次批量不通过 / 一次撤销动作。
--      唯一键 (tenant_id, action_id) 保证同一 action_id 重复提交不会产生第二行；
--      target_summary 只放 [{application_id, ok, reason_code}] 摘要，不放简历/原文。
--    * recruitment.undo_log —— 一行 = 一个动作的原记录（ORIGINAL）或其补偿记录
--      （COMPENSATION）。ORIGINAL 行记目标引用 / 操作前后摘要 / actor / 时间 /
--      原因 / confirmation_text_sha256；compensation_action_id 与
--      superseded_by_action_id 是**条件 UPDATE 允许改的两个列**（墓碑式收口，
--      历史行一律不物理删除）。唯一键 (tenant_id, action_id, kind) 保证幂等：
--      同一 action_id 撤销两次只会有一条 COMPENSATION 行。
--
--  补偿不是删除：决策撤销走既有 decision 域 supersede（反向插 + 换指针 + 旧行
--  record_version+1）；排期撤销走既有 interview_schedule 的 CANCEL。本迁移
--  没有任何 delete 语句，也没有任何改 decision / interview 业务列的语句。
--
--  审计三问（谁 / 何时 / 为什么 / 对什么做了什么）逐列对应：
--    谁 = actor_id；何时 = occurred_at；为什么 = reason + confirmation_text_sha256；
--    对什么做了什么 = operation_type / target_* + before_summary / after_summary。
--  只存摘要与引用，不把完整业务内容大段抄进日志。
--
--  幂等：create table / create index / drop+create trigger 全部 guarded；
--  迁移台账自登记 version='0020_undo_log'（照 0017/0018/0019 写法）。
--  依赖：0001（organization / application / decision / interview / actor /
--        fn_block_delete / fn_guard_columns）；0010（schema_migration 台账）。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
--  batch_operation（一次批量操作 = 一行）
-- ---------------------------------------------------------------------
create table if not exists recruitment.batch_operation (
  id                           uuid primary key default gen_random_uuid(),
  tenant_id                    uuid not null references recruitment.organization (id),
  action_id                    uuid not null,
  operation_type               text not null,
  actor_id                     uuid not null,
  occurred_at                  timestamptz not null default now(),
  target_count                 integer not null,
  succeeded_count              integer not null,
  failed_count                 integer not null,
  reason                       text not null,
  confirmation_text_sha256     text not null,
  target_summary               jsonb not null default '[]'::jsonb,
  superseded_by_action_id      uuid,

  constraint uq_batch_operation_id_tenant unique (id, tenant_id),
  -- 幂等：同一 action_id 在同租户下只可能有一行（重复提交不写第二条）。
  constraint uq_batch_operation_action_id unique (tenant_id, action_id),

  constraint fk_batch_operation_actor foreign key (actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),

  -- 值域闭集 / 形状约束（STRUCT-04：kind/operation_type 属枚举列，必须有 CHECK）
  constraint ck_batch_operation_type check (operation_type in ('BATCH_REJECT','UNDO')),
  constraint ck_batch_operation_counts check (
    target_count >= 0 and succeeded_count >= 0 and failed_count >= 0
    and succeeded_count + failed_count = target_count
  ),
  constraint ck_batch_operation_reason check (char_length(btrim(reason)) between 1 and 500),
  constraint ck_batch_operation_sha256 check (confirmation_text_sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists ix_batch_operation_tenant_time
  on recruitment.batch_operation (tenant_id, occurred_at desc);

-- append-only：任何 DELETE 都 23514（与 0001 §9.1 / 0017 / 0018 / 0019 同款）。
drop trigger if exists trg_batch_operation_no_delete on recruitment.batch_operation;
create trigger trg_batch_operation_no_delete before delete on recruitment.batch_operation
  for each row execute function recruitment.fn_block_delete();

-- 不可变：历史凭证一个业务列都不许改（fn_guard_columns() 无白名单 ⇒ 全列禁止）。
drop trigger if exists trg_batch_operation_immutable on recruitment.batch_operation;
create trigger trg_batch_operation_immutable before update on recruitment.batch_operation
  for each row execute function recruitment.fn_guard_columns();

-- ---------------------------------------------------------------------
--  undo_log（动作原记录 + 其补偿记录；同表两类行靠 kind 区分）
-- ---------------------------------------------------------------------
create table if not exists recruitment.undo_log (
  id                           uuid primary key default gen_random_uuid(),
  tenant_id                    uuid not null references recruitment.organization (id),
  action_id                    uuid not null,
  kind                         text not null,
  operation_type               text not null,
  target_application_id        uuid,
  target_decision_id           uuid,
  target_interview_id          uuid,
  action_type                  text,
  actor_id                     uuid not null,
  occurred_at                  timestamptz not null default now(),
  reason                       text not null,
  confirmation_text_sha256     text not null,
  before_summary               jsonb not null default '{}'::jsonb,
  after_summary                jsonb not null default '{}'::jsonb,
  compensation_action_id       uuid,
  superseded_by_action_id      uuid,

  constraint uq_undo_log_id_tenant unique (id, tenant_id),
  -- 幂等：同一 (action_id, kind) 只可能有一行；第二次撤销零写入。
  constraint uq_undo_log_action_kind unique (tenant_id, action_id, kind),

  -- 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）
  constraint fk_undo_log_application foreign key (target_application_id, tenant_id)
    references recruitment.application (id, tenant_id),
  constraint fk_undo_log_decision foreign key (target_decision_id, tenant_id)
    references recruitment.decision (id, tenant_id),
  constraint fk_undo_log_interview foreign key (target_interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  constraint fk_undo_log_actor foreign key (actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),

  -- 值域闭集 / 形状约束（STRUCT-04）
  constraint ck_undo_log_kind check (kind in ('ORIGINAL','COMPENSATION')),
  constraint ck_undo_log_operation_type check (
    operation_type in ('BATCH_REJECT','SINGLE_DECISION','SINGLE_SCHEDULE','UNDO')
  ),
  constraint ck_undo_log_action_type check (action_type in ('DECISION','SCHEDULE')),
  -- ORIGINAL 行必须有 action_type（撤销时要据此选补偿路径）；COMPENSATION 行不需要。
  constraint ck_undo_log_original_action_type check (kind <> 'ORIGINAL' or action_type is not null),
  constraint ck_undo_log_reason check (char_length(btrim(reason)) between 1 and 500),
  constraint ck_undo_log_sha256 check (confirmation_text_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ck_undo_log_no_self_link check (
    compensation_action_id is null or compensation_action_id <> action_id
  )
);

-- 撤销窗口判定：按 (tenant_id, action_id, kind) 唯一查 + 时间排序。
create index if not exists ix_undo_log_action
  on recruitment.undo_log (tenant_id, action_id, kind);
-- 按时间扫"待撤销"的原记录（5 分钟窗口的服务端判定从这里取事实）。
create index if not exists ix_undo_log_original_time
  on recruitment.undo_log (tenant_id, occurred_at desc)
  where kind = 'ORIGINAL';

-- append-only：任何 DELETE 都 23514。
drop trigger if exists trg_undo_log_no_delete on recruitment.undo_log;
create trigger trg_undo_log_no_delete before delete on recruitment.undo_log
  for each row execute function recruitment.fn_block_delete();

-- 墓碑式收口：唯一允许 UPDATE 的业务列是 compensation_action_id /
-- superseded_by_action_id（把 ORIGINAL 行标成"已撤销"或"已被后续动作影响"）；
-- record_version 由 fn_guard_columns 视为自身维护列放行。其余业务列一行都不许改。
drop trigger if exists trg_undo_log_immutable on recruitment.undo_log;
create trigger trg_undo_log_immutable before update on recruitment.undo_log
  for each row execute function recruitment.fn_guard_columns('compensation_action_id', 'superseded_by_action_id');

-- ---------------------------------------------------------------------
--  迁移台账自登记（0010 §规则第 1 条；与 0016/0017/0018/0019 同款）
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0020_undo_log',
            '批量不通过与撤销：batch_operation（一次批次一行）+ undo_log（ORIGINAL/COMPENSATION 墓碑式收口，禁删/禁改业务列，action_id 幂等，审计只存摘要与引用）')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
