-- =====================================================================
--  recruitment-agent · 0017_criterion_override.sql
--
--  主题：人对 AI 的 rubric-criterion 判定做**追加式覆盖**（human override）。
--
--  业务事实：AI 对某 criterion 给出的判定（有对应/没有对应/读不出来）是历史事实，
--  人（Recruiter / Interviewer）在会话里以一句确认话术纠正它时，**不改写 AI 的原判定**，
--  而是 INSERT 一条新行，并把旧行的 superseded_by_override_id 指向新行
--  （与 decision / approval / scorecard 的 supersede 模式一致）。
--
--  设计要点：
--    * 表是 append-only 历史：每行记录一次人的覆盖（含确认话术的 sha256、actor、时间）。
--      fn_block_delete 禁止任何 DELETE —— 历史事实永不消失。
--    * 唯一允许 UPDATE 的**业务列**是 superseded_by_override_id（把旧行标成"已被取代"），
--      另加其自身审计列 updated_at / record_version（标记动作的元数据）。
--      这不是篡改历史，而是给历史补一条"指向后继"的链：旧行的原始 judgment、
--      note、actor、确认哈希、created_at 全部保持不变。本迁移用 fn_guard_columns 白名单
--      在数据库层强制这一点（白名单只放 superseded_by_override_id；record_version /
--      updated_at 由触发器函数视为自身维护列而放行）。
--    * human_state 三态：PRESENT（有对应）/ ABSENT（没有对应）/ UNREADABLE（读不出来）。
--      它不是"status"语义列（不进 STRUCT-04/05 的状态列白名单），但仍给 CHECK 闭集。
--    * confirmation_text 只存 sha256（原文在事件/会话里，不落此表），且只接受小写 64 hex。
--    * criterion 由 (tenant, application, rubric_version, criterion_key) 定位 ——
--      rubric_version 来自 application 钉住的版本，配置再变也不移动历史。
--    * 当前行查询（superseded_by_override_id is null）用**非唯一**部分索引：
--      业务层在事务里 `select ... for update` 串行化"同一 criterion 的并发覆盖"，
--      不靠 DB 唯一约束，因此不会引入 partial_unique_indexes 计数变化或"唯一性"承诺。
--
--  幂等：create table if not exists / create index if not exists /
--        drop trigger if exists + create trigger。
--  依赖：0001（organization / application / rubric_version / actor / fn_block_delete /
--        fn_guard_columns）。
-- =====================================================================

begin;

create table if not exists recruitment.criterion_override (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references recruitment.organization (id),
  application_id            uuid not null,
  rubric_version_id         uuid not null,
  criterion_key             text not null,
  human_state               text not null,
  note                      text,
  actor_id                  uuid not null,
  confirmation_method       text not null default 'IN_CHAT',
  confirmation_text_sha256  char(64) not null,
  superseded_by_override_id uuid,
  record_version            integer not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint uq_criterion_override_id_tenant unique (id, tenant_id),

  -- 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）
  constraint fk_criterion_override_application foreign key (application_id, tenant_id)
    references recruitment.application (id, tenant_id),
  constraint fk_criterion_override_rubric foreign key (rubric_version_id, tenant_id)
    references recruitment.rubric_version (id, tenant_id),
  constraint fk_criterion_override_actor foreign key (actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  -- 自引用：旧行指向后继。复合带 tenant_id，满足 STRUCT-07 且防跨租户串链。
  constraint fk_criterion_override_superseded_by foreign key (superseded_by_override_id, tenant_id)
    references recruitment.criterion_override (id, tenant_id),

  -- 值域闭集 / 形状约束
  constraint ck_criterion_override_key check (
    char_length(btrim(criterion_key)) between 1 and 200),
  constraint ck_criterion_override_human_state check (
    human_state in ('PRESENT','ABSENT','UNREADABLE')),
  constraint ck_criterion_override_note check (
    note is null or char_length(note) <= 2000),
  constraint ck_criterion_override_method check (
    confirmation_method = 'IN_CHAT'),
  constraint ck_criterion_override_hash check (
    confirmation_text_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ck_criterion_override_self_supersede check (
    superseded_by_override_id is null or superseded_by_override_id <> id),
  constraint ck_criterion_override_record_version check (record_version >= 1)
);

-- 当前行查询（每个 criterion 只有一行 superseded_by_override_id is null）。
-- 非唯一：并发由工具层 `select ... for update` 串行化，不承诺 DB 级唯一。
create index if not exists ix_criterion_override_current
  on recruitment.criterion_override (tenant_id, application_id, rubric_version_id, criterion_key)
  where superseded_by_override_id is null;

-- 时间线查询（按申请拉全部历史，含已被取代的旧行）。
create index if not exists ix_criterion_override_timeline
  on recruitment.criterion_override (tenant_id, application_id);

-- 历史事实禁删（与 0001 §9.1 同款，任何 DELETE 都 raise 23514）。
drop trigger if exists trg_criterion_override_no_delete on recruitment.criterion_override;
create trigger trg_criterion_override_no_delete before delete on recruitment.criterion_override
  for each row execute function recruitment.fn_block_delete();

-- 只允许改 superseded_by_override_id（record_version/updated_at 由 fn_guard_columns 视为
-- 自身维护列自动放行）。任何对 human_state / note / 确认哈希 / actor / 定位列的改写
-- 都会被 23514 拒绝 —— 人类覆盖也是"追加 + 指向后继"，不是篡改 AI 原判定。
drop trigger if exists trg_criterion_override_immutable on recruitment.criterion_override;
create trigger trg_criterion_override_immutable before update on recruitment.criterion_override
  for each row execute function recruitment.fn_guard_columns('superseded_by_override_id');

-- =====================================================================
--  迁移台账自登记（0010 §规则第 1 条；与 0016 §4 同款）
-- =====================================================================
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0017_criterion_override',
            '人工逐条纠偏：criterion_override 只追加（不改 AI 原判）+ supersede 指针收口 + 确认话术哈希审计')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
