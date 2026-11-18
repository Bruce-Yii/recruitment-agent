-- =====================================================================
--  recruitment-agent · 0022_scorecard_draft.sql
--
--  主题：A4 面评草稿（面试官写到一半的面评自动保存，刷新/断网不丢）。
--  前端 localStorage 只是兜底，**真相落库**在本表。
--
--  设计要点（与 0017/0018/0019 同款 append-only 模式）：
--    * 一张 append-only 版本行表 `recruitment.scorecard_draft`：每次保存 INSERT 一行，
--      `record_version` 递增（同一 interviewer 连续保存 = 版本 +1），同一
--      (interview_id, interviewer_actor_id) 取 `created_at`/`record_version` 最新一条为草稿。
--    * 禁删（fn_block_delete）：任何 DELETE 都 23514；禁改业务列（fn_guard_columns()，
--      不给白名单 = 整行不可改），草稿一旦落库不可篡改，只能追加新版本。
--    * 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）：
--        (interview_id, tenant_id) → interview、
--        (interviewer_id, tenant_id) → interviewer（interviewer 行的 uuid）、
--        (interviewer_actor_id, tenant_id) → actor（HUMAN actor 的 uuid）。
--      `interviewer_id` 是定位面试里"这位面试官行"的内部列（与 scorecard.interviewer_id 同口径），
--      `interviewer_actor_id` 是契约要求的列（谁的草稿）。两者在写入时由同一个 interviewer 行解析，
--      并由 ck 约束保证同一租户。
--    * payload jsonb：维度评分 + 备注的自由形状；`ck_scorecard_draft_payload_size` 限制
--      `pg_column_size(payload) <= 32768`（32KB 上限，超限 23514，零写入）。
--      payload 形状（`{assessments?: {key: value}, note?: string}`）由应用层校验（本表只守大小）。
--    * 不碰 `scorecard` / `scorecard/submit` 一行：本表是独立事实，"已提交面评不允许再写草稿"
--      由应用层在写之前只读检查当前 scorecard 状态（SUBMITTED/WAIVED → 拒），不是改 scorecard。
--
--  幂等：create table / create index / drop+create trigger 全部 guarded；
--  迁移台账自登记 version='0022_scorecard_draft'（照 0019 写法）。
--  依赖：0001（organization / interview / interviewer / actor / scorecard /
--        fn_block_delete / fn_guard_columns）；0010（schema_migration 台账）。
-- =====================================================================

begin;

create table if not exists recruitment.scorecard_draft (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references recruitment.organization (id),
  interview_id          uuid not null,
  -- 面试官行 id（scorecard.interviewer_id 同口径；用来定位"本人这场面试的面试官行"）
  interviewer_id        uuid not null,
  -- 契约列：HUMAN actor 的 uuid（谁的草稿）
  interviewer_actor_id  uuid not null,
  payload               jsonb not null,
  record_version        integer not null default 1,
  created_at            timestamptz not null default now(),

  constraint uq_scorecard_draft_id_tenant unique (id, tenant_id),

  -- 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）
  constraint fk_scorecard_draft_interview foreign key (interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  constraint fk_scorecard_draft_interviewer foreign key (interviewer_id, tenant_id)
    references recruitment.interviewer (id, tenant_id),
  constraint fk_scorecard_draft_actor foreign key (interviewer_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),

  -- 值域 / 形状约束
  constraint ck_scorecard_draft_record_version check (record_version >= 1),
  constraint ck_scorecard_draft_payload_object check (jsonb_typeof(payload) = 'object'),
  -- payload ≤ 32KB（jsonb 落库后的真实占用；应用端另按 JSON 文本字节数前置校验）
  constraint ck_scorecard_draft_payload_size check (pg_column_size(payload) <= 32768)
);

-- "同一 (interview, interviewer) 取最新一条草稿"的查询索引（降序 + record_version 兜底）。
create index if not exists ix_scorecard_draft_latest
  on recruitment.scorecard_draft (tenant_id, interview_id, interviewer_actor_id, created_at desc, record_version desc);

-- append-only：任何 DELETE 都 23514（与 0001 §9.1 / 0019 同款）。
drop trigger if exists trg_scorecard_draft_no_delete on recruitment.scorecard_draft;
create trigger trg_scorecard_draft_no_delete before delete on recruitment.scorecard_draft
  for each row execute function recruitment.fn_block_delete();

-- 不可变：不给白名单 = 整行业务列不可改（record_version / created_at 为触发器/默认列，UPDATE 也不许改业务列）。
drop trigger if exists trg_scorecard_draft_immutable on recruitment.scorecard_draft;
create trigger trg_scorecard_draft_immutable before update on recruitment.scorecard_draft
  for each row execute function recruitment.fn_guard_columns();

-- ---------------------------------------------------------------------
--  迁移台账自登记（0010 §规则第 1 条；与 0019 同款）
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0022_scorecard_draft',
            'A4 面评草稿：scorecard_draft append-only 版本行（禁删/禁改 + payload ≤ 32KB + 同一面试官取最新版本）；与 scorecard/submit 隔离')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
