-- =====================================================================
--  recruitment-agent · 0019_candidate_constraint.sql
--
--  主题：docs/34 §2「碎片约束置顶 + 下一轮交接提醒」的**结构面**。
--  一张 append-only 表 `recruitment.candidate_constraint` 承载两类事实：
--
--    * kind='PIN'     —— HR 在对话里说的一句碎片约束（"字节 Offer 周五截止 · 期望 45k"），
--      由 Agent 工具把人的原话沉淀为**候选人级别置顶约束**：候选人页与面试官简报都
--      能看到（置顶、按时间排序）。同一 (candidate, text, source) 重复提交幂等，
--      不产生第二行。UNPIN 通过墓碑行（见下）把旧 PIN 标 superseded，历史不删。
--    * kind='HANDOFF' —— 初筛或前序面试官给**下一轮**留的一句专属追问；
--      interview_id 指向**下一轮**（本字段必填，kind='HANDOFF' 时库级强制），
--      它出现在下一轮面试官的前简报里并标明"上一轮留的"。
--
--  设计要点（与 0017 / 0018 同款 append-only 模式）：
--    * 禁删（fn_block_delete）：任何 DELETE 都 23514。
--    * 禁改业务列（fn_guard_columns('superseded_by_constraint_id')）：唯一允许 UPDATE 的
--      业务列是 superseded_by_constraint_id（把旧行标成"已被取代"）；record_version 由
--      触发器视为自身维护列放行。text/source/actor/定位列一行都不许改。
--    * 墓碑机制（UNPIN）：不物理删除 PIN；插入一行 kind='PIN'、text=固定墓碑文本
--      （见 domain/candidate-constraint.ts 的 UNPIN_TOMBSTONE_TEXT）的新行，把目标当前 PIN
--      的 superseded_by_constraint_id 指向新墓碑；读投影过滤"有 superseded 的旧行"与
--      "墓碑行本身"，该 PIN 便从置顶列表消失，而历史仍完整可查。
--    * 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）。
--    * 事件登记在 src/runtime/event-types.ts（candidate.constraint.recorded，IGNORED），
--      本迁移不重复登记。
--
--  幂等：create table / create index / drop+create trigger 全部 guarded；
--  迁移台账自登记 version='0019_candidate_constraint'（照 0016/0017/0018 写法）。
--  依赖：0001（organization / candidate / application / interview / actor /
--        fn_block_delete / fn_guard_columns）；0010（schema_migration 台账）。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
--  candidate_constraint（候选约束：置顶 PIN + 下一轮交接 HANDOFF）
-- ---------------------------------------------------------------------
create table if not exists recruitment.candidate_constraint (
  id                           uuid primary key default gen_random_uuid(),
  tenant_id                    uuid not null references recruitment.organization (id),
  candidate_id                 uuid not null,
  kind                         text not null,
  text                         text not null,
  source                       text not null,
  application_id               uuid,
  interview_id                 uuid,
  created_by_actor_id          uuid not null,
  created_at                   timestamptz not null default now(),
  superseded_by_constraint_id  uuid,
  record_version               integer not null default 1,

  constraint uq_candidate_constraint_id_tenant unique (id, tenant_id),

  -- 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）
  constraint fk_candidate_constraint_candidate foreign key (candidate_id, tenant_id)
    references recruitment.candidate (id, tenant_id),
  constraint fk_candidate_constraint_application foreign key (application_id, tenant_id)
    references recruitment.application (id, tenant_id),
  constraint fk_candidate_constraint_interview foreign key (interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  constraint fk_candidate_constraint_actor foreign key (created_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  -- 自引用：旧行指向后继（墓碑/取代行）。复合带 tenant_id，防跨租户串链。
  constraint fk_candidate_constraint_superseded_by foreign key (superseded_by_constraint_id, tenant_id)
    references recruitment.candidate_constraint (id, tenant_id),

  -- 值域闭集 / 形状约束
  constraint ck_candidate_constraint_kind check (kind in ('PIN','HANDOFF')),
  constraint ck_candidate_constraint_source check (source in ('CHAT','WEIXIN','PHONE','OTHER')),
  constraint ck_candidate_constraint_text check (char_length(btrim(text)) between 1 and 500),
  -- HANDOFF 必须有 interview_id（指向下一轮）；PIN 不要求。
  constraint ck_candidate_constraint_handoff_interview
    check (kind <> 'HANDOFF' or interview_id is not null),
  constraint ck_candidate_constraint_record_version check (record_version >= 1),
  constraint ck_candidate_constraint_no_self_supersede
    check (superseded_by_constraint_id is null or superseded_by_constraint_id <> id)
);

-- 置顶 PIN 的时间线查询（候选人页 / 面试官简报：只取当前、按时间排序）。
create index if not exists ix_candidate_constraint_pin
  on recruitment.candidate_constraint (tenant_id, candidate_id, kind, created_at desc)
  where kind = 'PIN' and superseded_by_constraint_id is null;

-- 下一轮交接提醒查询（按 interview_id 取该轮相关的 HANDOFF）。
create index if not exists ix_candidate_constraint_handoff
  on recruitment.candidate_constraint (tenant_id, interview_id)
  where kind = 'HANDOFF' and superseded_by_constraint_id is null;

-- 候选人的全部约束历史（含已被取代的旧行 / 墓碑，供审计回查）。
create index if not exists ix_candidate_constraint_timeline
  on recruitment.candidate_constraint (tenant_id, candidate_id, created_at);

-- append-only：任何 DELETE 都 23514（与 0001 §9.1 / 0017 / 0018 同款）。
drop trigger if exists trg_candidate_constraint_no_delete on recruitment.candidate_constraint;
create trigger trg_candidate_constraint_no_delete before delete on recruitment.candidate_constraint
  for each row execute function recruitment.fn_block_delete();

-- 不可变：唯一允许 UPDATE 的业务列是 superseded_by_constraint_id
-- （record_version 由 fn_guard_columns 视为自身维护列放行）。
drop trigger if exists trg_candidate_constraint_immutable on recruitment.candidate_constraint;
create trigger trg_candidate_constraint_immutable before update on recruitment.candidate_constraint
  for each row execute function recruitment.fn_guard_columns('superseded_by_constraint_id');

-- ---------------------------------------------------------------------
--  迁移台账自登记（0010 §规则第 1 条；与 0016/0017/0018 同款）
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0019_candidate_constraint',
            '碎片约束置顶 + 下一轮交接提醒：candidate_constraint append-only（禁删/禁改业务列 + HANDOFF 必带 interview_id + 幂等/墓碑 UNPIN 口径）')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
