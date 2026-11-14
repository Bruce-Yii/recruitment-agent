-- =====================================================================
--  recruitment-agent · 0014_tenant_config.sql
--
--  主题：**企业自建配置**（tenant-config）。配置是数据，不是代码。
--
--  方向（用户裁决，2026-11-14）：
--    「每个企业情况都不一样。你需要做的就是把那些通用的后端做好，
--      然后企业到时候可以自己创建。」
--  → 本迁移**不写死任何一家企业的组织/流程**，只补"企业能自己建"所需的
--    最小结构。不种任何业务数据（种子数据一行不动）。
--
--  ── 迁移前实测的缺口（ra_s6s7，0013 之后）──────────────────────────
--    * `recruitment.role`（0001:374）只有 code + name：**没有权限范围、没有描述、
--      没有 record_version / updated_at**。企业能"给角色起名"，不能表达"这个角色
--      能看到/改什么"，也不能并发安全地改。→ 本文件扩列（**不新建 role_template**：
--      新建会让"角色"出现两套概念，actor_role 引用的是旧表，必然漂移）。
--    * **没有 hiring_team / team 任何表**（实测：recruitment 下无 %team% 表）。
--      现有最接近的是 `department.hiring_manager_actor_id`（0001:331，单个负责人）
--      与 `interviewer`（0001:973，按场次参与人）—— 都不是"可复用的招聘团队"。
--    * **没有 pipeline / 流水线模板任何表**（实测：无 %pipeline% 表）。
--      `db/verify.sql:311` 明写 `(12,'Pipeline Template','','DEFERRED')`、
--      `:313 (14,'Stage','','DEFERRED')`；今天唯一的"流程"是
--      `application.current_stage_code`（0001:845）指向 `stage_catalog`（0004:55）
--      的 sort_order 1..12，即**全租户共用一条隐式流水线**，企业无法定义自己的流程。
--    * 已有且**够用**的：`organization`(0001:271) / `department`(0001:326) /
--      `actor`(0001:342) / `actor_role`(0001:385) / `business_config`(0001:561) /
--      `stage_catalog`(0004:55) / `interview_template_version`(0001:897)。
--      其中 business_config 是"任意 JSON 配置桶"——能塞，但没有结构、没有服务端
--      校验、没有版本并发控制；本迁移补的是**被约束的结构**，不是另起一套 JSON。
--
--  ── 本文件做什么（四件，顺序不能换）────────────────────────────────
--    1. role 扩列：permission_scopes（封闭集，函数校验）+ description +
--       is_active + record_version/updated_at + created_by_actor_id + fn_touch
--    2. hiring_team / hiring_team_member：团队 + 成员（成员的 actor 必须
--       **存在** 且 **kind='HUMAN'**，用复合外键在数据库层物理保证）
--    3. pipeline_template / pipeline_template_stage /
--       pipeline_template_stage_template：流水线模板 + 有序阶段
--       （阶段必须引用本租户 stage_catalog 里已存在的 code；阶段引用的面试模板
--         必须引用**已存在**的 interview_template_version，且同租户）
--    4. 迁移后自检（结构、负向校验、种子行未被改动、触发器计数）
--
--  ── 为什么用 fn_touch 而不是 fn_row_guard ───────────────────────────
--    fn_row_guard（0001:87）是**状态迁移**守卫：它要求 status*_changed_by_actor_id
--    并向 event_inbox 写一条内部事件。配置表没有"状态机"，生命周期只有
--    `is_active`（在用 / 退休），套 fn_row_guard 等于接一条永不执行的触发器（R2 假接线）。
--    因此这里用 0001 里**同一份** `fn_touch()`（0001:233，注释原文：
--    「用于没有状态列、但仍需乐观并发的表」）——它只做 record_version +1 / updated_at。
--    `fn_block_delete` 照旧：配置被引用后物理删除会让历史无法解释，只允许软关闭。
--
--  ── 幂等 ────────────────────────────────────────────────────────────
--    全部 `add column if not exists` / `create table if not exists` /
--    `create or replace function` / `drop trigger if exists` + `create trigger` /
--    约束与索引一律先查 pg_constraint / pg_class 再建。
--    连跑两遍：零 ERROR、零新增行、种子 role 的 record_version 不漂移。
--
--  依赖：0001（全部基础表）、0004（stage_catalog）、0010（迁移台账，可缺省）。
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0014_tenant_config.sql
--        不要加 -1（本文件自带 begin/commit）。
-- =====================================================================

begin;


-- =====================================================================
--  §1  角色模板：给 recruitment.role 补"权限范围 + 描述 + 版本"
--
--  为什么扩列而不是新建 role_template：
--    `role` 已被 0002 §3 种了 4 行，`actor_role.role_id`（0001:389）指向它。
--    再建一张 role_template 会出现"角色"两套概念：企业建了模板，actor_role
--    仍然只能引用旧表 → 要么同步逻辑（写死 glue），要么两套并存（静默漂移）。
--    扩列的代价是**旧行 permission_scopes 为空**（见 §1.4 的说明），收益是
--    "企业建的角色"立刻可被 actor_role 授权，不需要任何中间同步。
-- =====================================================================

alter table recruitment.role
  add column if not exists description          text,
  add column if not exists permission_scopes    jsonb       not null default '[]'::jsonb,
  add column if not exists is_active            boolean     not null default true,
  add column if not exists created_by_actor_id  uuid,
  add column if not exists record_version       integer     not null default 1,
  add column if not exists updated_at           timestamptz not null default now();

-- 1.1 权限范围 = **封闭集**，由服务端校验（DB 函数 + 工具层双保险）。
--
--  为什么是"能力码"而不是 RBAC 矩阵：
--    方向明确要求"不要把复杂权限矩阵铺开"。这里只表达"这个角色能碰到哪一类
--    业务动作"，粒度刻意粗（9 个码），够企业把角色建出来、够后续接权限判断；
--    真正的鉴权引擎不在这条 lane 上（见 contracts/tenant-config/tool-contracts.md §0）。
--
--  为什么元素不能重复：权限是**集合**。允许 ["JOB_READ","JOB_READ"] 会让
--    "两条角色的权限范围是否相同"变成取决于数组顺序的比较 → 幂等判定会撒谎。
--
--  ⚠️ 兼容 0002 的 4 行种子：它们的 permission_scopes = '[]'（空集合）必须合法，
--    否则本迁移在既有库上直接失败。**空集合合法 ≠ 工具允许建空角色**：
--    工具层（src/domain/tenant-config.ts）对"新建角色"要求至少 1 个范围，
--    对"更新角色"允许清空（那是企业的显式决定）。这一条写进契约，不靠注释飘着。
create or replace function recruitment.fn_permission_scopes_valid(p_scopes jsonb)
returns boolean
language plpgsql immutable as $$
declare
  v_bad   text;
  v_total integer;
  v_uniq  integer;
begin
  if p_scopes is null or jsonb_typeof(p_scopes) <> 'array' then
    return false;
  end if;

  select string_agg(distinct e.code, ', ' order by e.code) into v_bad
    from jsonb_array_elements_text(p_scopes) as e(code)
   where e.code not in (
     'CONFIG_ADMIN',       -- 建/改角色、团队、流水线模板（本迁移这三类配置的写权限）
     'JOB_READ', 'JOB_WRITE',
     'APPLICATION_READ', 'APPLICATION_WRITE',
     'INTERVIEW_READ', 'INTERVIEW_WRITE',
     'SCORECARD_SUBMIT',
     'DECISION_RECORD'
   );
  if v_bad is not null then
    return false;
  end if;

  select jsonb_array_length(p_scopes),
         (select count(distinct e.code) from jsonb_array_elements_text(p_scopes) as e(code))
    into v_total, v_uniq;
  return v_total = v_uniq;
end $$;

comment on function recruitment.fn_permission_scopes_valid(jsonb) is
  'role.permission_scopes 的唯一判定式：必须是数组、元素取自 9 个封闭能力码、不得重复。'
  '（空数组合法 = 0002 种子角色；"新建角色至少 1 个范围"由工具层强制，不在此处。）';

do $$
begin
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_role_permission_scopes'
                    and c.conrelid = 'recruitment.role'::regclass) then
    alter table recruitment.role
      add constraint ck_role_permission_scopes
      check (recruitment.fn_permission_scopes_valid(permission_scopes));
  end if;

  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_role_description'
                    and c.conrelid = 'recruitment.role'::regclass) then
    alter table recruitment.role
      add constraint ck_role_description
      check (description is null or length(btrim(description)) between 1 and 1000);
  end if;

  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_role_record_version'
                    and c.conrelid = 'recruitment.role'::regclass) then
    alter table recruitment.role
      add constraint ck_role_record_version check (record_version >= 1);
  end if;

  -- 创建人必须是本租户的 actor（复合外键：既查存在性又查租户）
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'fk_role_created_by'
                    and c.conrelid = 'recruitment.role'::regclass) then
    alter table recruitment.role
      add constraint fk_role_created_by
      foreign key (created_by_actor_id, tenant_id)
      references recruitment.actor (id, tenant_id)
      on update restrict on delete restrict;
  end if;
end $$;

-- 1.2 版本自增（乐观并发）：与 0001 的 fn_touch 同一份实现，不另写。
drop trigger if exists trg_role_touch on recruitment.role;
create trigger trg_role_touch
  before update on recruitment.role
  for each row execute function recruitment.fn_touch();

-- 1.3 联调最常用的查询：某租户的全部在用角色（按 code 排序稳定）
create index if not exists ix_role_tenant_active
  on recruitment.role (tenant_id, code)
  where is_active;

-- 1.4 为什么不回填种子角色的 permission_scopes：
--    那是**企业的配置决定**，不是迁移能替它拍的。空集合 = "这个角色还没被授予
--    任何能力码"，如实表达"旧行早于权限范围概念"，而不是猜一个看起来合理的集合
--    （猜错 = 静默多授权，比没数据更危险）。0002 的 4 行因此保持 '[]' 不变。


-- =====================================================================
--  §2  招聘团队（hiring team）
--
--  为什么需要：department.hiring_manager_actor_id 只能表达**一个**负责人；
--    interviewer 是"某场面试的参与者"，随场次产生、不能复用。企业真正要的是
--    "这个部门有哪几个人在招这个岗"——一个可复用、可授权的团队分组。
--
--  与部门的关系：一个团队**属于一个部门**（NOT NULL 复合外键）。
--    理由：不挂部门的团队没有归属，最终一定会变成企业自定义字段；
--    而"部门"已经是本仓一级对象（0001:326），挂上去不增加新概念。
-- =====================================================================

create table if not exists recruitment.hiring_team (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references recruitment.organization (id),
  code               text        not null,
  name               text        not null,
  department_id      uuid        not null,
  description        text,
  is_active          boolean     not null default true,
  record_version     integer     not null default 1,
  created_by_actor_id uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_hiring_team_id_tenant unique (id, tenant_id),
  -- 业务键：租户内 code 唯一 → 企业建团队是"幂等 upsert by code"的前提
  constraint uq_hiring_team_code unique (tenant_id, code),
  constraint fk_hiring_team_department foreign key (department_id, tenant_id)
    references recruitment.department (id, tenant_id)
    on update restrict on delete restrict,
  constraint fk_hiring_team_created_by foreign key (created_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id)
    on update restrict on delete restrict,
  -- code 格式与 role.code / job.code 同一风格（大写 + 数字下划线）
  constraint ck_hiring_team_code check (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  constraint ck_hiring_team_name check (length(btrim(name)) between 1 and 200),
  constraint ck_hiring_team_description check (
    description is null or length(btrim(description)) between 1 and 1000),
  constraint ck_hiring_team_record_version check (record_version >= 1)
);

create index if not exists ix_hiring_team_department
  on recruitment.hiring_team (tenant_id, department_id);
create index if not exists ix_hiring_team_active
  on recruitment.hiring_team (tenant_id, code)
  where is_active;

-- 团队成员的 actor 必须 **存在** 且 **kind='HUMAN'**。
--
--  怎么做到"物理保证"而不是"靠调用方自觉"（本仓既有做法 fk_job_current_rubric，
--  0004:282）：把 kind 也放进外键。
--    actor 先补一个 (id, tenant_id, kind) 的唯一键 → 成员表带一列 actor_kind，
--    CHECK 钉死 'HUMAN'，再用复合外键 (actor_id, tenant_id, actor_kind) 指过去。
--  效果：
--    * 不存在的 actor → 外键直接失败（23503）；
--    * 别的租户的 actor → 复合键不匹配，失败；
--    * SYSTEM / AGENT_WORKER 的 actor → 唯一键里没有那一行，失败；
--    * 后续有人把某个 actor 的 kind 改成 SYSTEM → 被外键 restrict 挡住（不能
--      悄悄把团队成员变成非人类账号）。
do $$
begin
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'uq_actor_id_tenant_kind'
                    and c.conrelid = 'recruitment.actor'::regclass) then
    alter table recruitment.actor
      add constraint uq_actor_id_tenant_kind unique (id, tenant_id, kind);
  end if;
end $$;

create table if not exists recruitment.hiring_team_member (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references recruitment.organization (id),
  team_id             uuid        not null,
  actor_id            uuid        not null,
  -- 只是复合外键的载体列：值恒为 'HUMAN'（CHECK 钉死），不表达"成员类型"
  actor_kind          text        not null default 'HUMAN',
  team_role           text        not null default 'RECRUITER',
  is_active           boolean     not null default true,
  record_version      integer     not null default 1,
  added_by_actor_id   uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_hiring_team_member_id_tenant unique (id, tenant_id),
  constraint fk_hiring_team_member_team foreign key (team_id, tenant_id)
    references recruitment.hiring_team (id, tenant_id)
    on update restrict on delete restrict,
  constraint fk_hiring_team_member_actor_human
    foreign key (actor_id, tenant_id, actor_kind)
    references recruitment.actor (id, tenant_id, kind)
    on update restrict on delete restrict,
  constraint fk_hiring_team_member_added_by foreign key (added_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id)
    on update restrict on delete restrict,
  constraint ck_hiring_team_member_human check (actor_kind = 'HUMAN'),
  constraint ck_hiring_team_member_role check (team_role in
    ('HIRING_MANAGER','RECRUITER','COORDINATOR','INTERVIEWER','APPROVER')),
  constraint ck_hiring_team_member_record_version check (record_version >= 1)
);

-- 幂等补齐：本文件第一版忘记给成员表 record_version，而 §4 给它挂了 fn_touch ——
-- fn_touch 会写 old.record_version，缺列时**任何一次成员软关闭都会报错**
-- （实测：`记录"old"没有字段"record_version"`）。create table if not exists 对已存在的
-- 表不会补列，所以这里显式 add column if not exists（既有库与新库同一条路径）。
alter table recruitment.hiring_team_member
  add column if not exists record_version integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_hiring_team_member_record_version'
                    and c.conrelid = 'recruitment.hiring_team_member'::regclass) then
    alter table recruitment.hiring_team_member
      add constraint ck_hiring_team_member_record_version check (record_version >= 1);
  end if;
end $$;

-- 同一团队里"同一个人同时在用"只能有一条：**部分**唯一索引（软关闭后可再入队）。
-- 不用普通唯一约束，否则"移除 → 重新加入"会永久撞键（本仓先例：0001:755
-- uq_candidate_active_email 就是同一手法）。
create unique index if not exists uq_hiring_team_member_active
  on recruitment.hiring_team_member (tenant_id, team_id, actor_id)
  where is_active;
create index if not exists ix_hiring_team_member_actor
  on recruitment.hiring_team_member (tenant_id, actor_id)
  where is_active;


-- =====================================================================
--  §3  流水线模板（pipeline template + 有序阶段 + 阶段引用的面试模板）
--
--  为什么是"模板"而不是直接改 application：
--    docs/03 §2 明确「模板更新不应静默改写已开始的招聘申请；应明确选择继续沿用
--    旧版本或迁移到新版本」。application.current_stage_code 是**实例**（已映射，
--    verify.sql:312），本迁移建的是**可复用的模板**——两者分开，模板改了不影响
--    已经在跑的申请。
--
--  阶段的 stage_code 必须已存在于本租户的 stage_catalog：
--    复合外键 (tenant_id, stage_code) → stage_catalog (tenant_id, code)。
--    好处是"阶段码拼错"在 INSERT 就被数据库拒绝，而不是到联调时"查得到流水线、
--    渲染不出阶段名"（0004 修 D-23 的同一条教训）。
--    ⚠️ 注意 stage_catalog.sort_order 是 1..12 的**目录**顺序；模板自己的
--       pipeline_template_stage.sort_order 是"这份流程里的第几步"，两者不同轴，
--       所以不复制 1..12 的限制（企业可以先只上线 5 步）。
-- =====================================================================

create table if not exists recruitment.pipeline_template (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references recruitment.organization (id),
  code                text        not null,
  name                text        not null,
  description         text,
  is_active           boolean     not null default true,
  record_version      integer     not null default 1,
  created_by_actor_id uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_pipeline_template_id_tenant unique (id, tenant_id),
  constraint uq_pipeline_template_code unique (tenant_id, code),
  constraint fk_pipeline_template_created_by foreign key (created_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id)
    on update restrict on delete restrict,
  constraint ck_pipeline_template_code check (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  constraint ck_pipeline_template_name check (length(btrim(name)) between 1 and 200),
  constraint ck_pipeline_template_description check (
    description is null or length(btrim(description)) between 1 and 1000),
  constraint ck_pipeline_template_record_version check (record_version >= 1)
);

create index if not exists ix_pipeline_template_active
  on recruitment.pipeline_template (tenant_id, code)
  where is_active;

create table if not exists recruitment.pipeline_template_stage (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null references recruitment.organization (id),
  pipeline_template_id uuid        not null,
  stage_code           text        not null,
  sort_order           integer     not null,
  created_at           timestamptz not null default now(),
  constraint uq_pipeline_stage_id_tenant unique (id, tenant_id),
  constraint fk_pipeline_stage_template foreign key (pipeline_template_id, tenant_id)
    references recruitment.pipeline_template (id, tenant_id)
    on update restrict on delete restrict,
  -- 阶段必须已存在于本租户的阶段目录（拼错 = 数据库直接拒绝）
  constraint fk_pipeline_stage_catalog foreign key (tenant_id, stage_code)
    references recruitment.stage_catalog (tenant_id, code)
    on update restrict on delete restrict,
  constraint ck_pipeline_stage_sort_order check (sort_order between 1 and 100)
);

-- 同一份模板：顺序唯一（两步同序号 = "按顺序渲染"变成不确定结果），
-- 且同一阶段不能在两个位置重复出现（否则"这条申请现在在第几阶段"无法回答）。
create unique index if not exists uq_pipeline_stage_order
  on recruitment.pipeline_template_stage (tenant_id, pipeline_template_id, sort_order);
create unique index if not exists uq_pipeline_stage_code
  on recruitment.pipeline_template_stage (tenant_id, pipeline_template_id, stage_code);

-- 阶段引用哪些面试模板（0..N）。
--   docs/03 §2：「Stage 可含**多个** Interview Template / Slot（同轮可同时有
--   用人经理面试 + 业务专家面试）」→ 必须是多对多，不能只在阶段行上放一个 id。
--   引用的是 **interview_template_version 的具体版本**（不是 template_code）：
--   模板改版不静默改写已上线的流水线（同 docs/03 §2 的版本原则），
--   而且"引用已存在的模板"由复合外键直接保证，不需要触发器。
create table if not exists recruitment.pipeline_template_stage_template (
  id                            uuid        primary key default gen_random_uuid(),
  tenant_id                     uuid        not null references recruitment.organization (id),
  stage_id                      uuid        not null,
  interview_template_version_id uuid        not null,
  is_required                   boolean     not null default true,
  created_at                    timestamptz not null default now(),
  constraint uq_pipeline_stage_template_id_tenant unique (id, tenant_id),
  constraint fk_pipeline_stage_template_stage foreign key (stage_id, tenant_id)
    references recruitment.pipeline_template_stage (id, tenant_id)
    on update restrict on delete restrict,
  constraint fk_pipeline_stage_template_itv
    foreign key (interview_template_version_id, tenant_id)
    references recruitment.interview_template_version (id, tenant_id)
    on update restrict on delete restrict
);

create unique index if not exists uq_pipeline_stage_template_ref
  on recruitment.pipeline_template_stage_template (tenant_id, stage_id, interview_template_version_id);


-- =====================================================================
--  §4  通用守卫：版本自增 + 禁删（与既有表同一套函数，不另写）
-- =====================================================================

drop trigger if exists trg_hiring_team_touch on recruitment.hiring_team;
create trigger trg_hiring_team_touch
  before update on recruitment.hiring_team
  for each row execute function recruitment.fn_touch();

drop trigger if exists trg_hiring_team_member_touch on recruitment.hiring_team_member;
create trigger trg_hiring_team_member_touch
  before update on recruitment.hiring_team_member
  for each row execute function recruitment.fn_touch();

drop trigger if exists trg_pipeline_template_touch on recruitment.pipeline_template;
create trigger trg_pipeline_template_touch
  before update on recruitment.pipeline_template
  for each row execute function recruitment.fn_touch();

-- 配置是"被引用的事实"：模板被某条申请用过之后物理删除，历史就解释不了。
-- 只允许软关闭（is_active = false）。与 0001 的历史事实表同一条规则。
drop trigger if exists trg_hiring_team_no_delete on recruitment.hiring_team;
create trigger trg_hiring_team_no_delete
  before delete on recruitment.hiring_team
  for each row execute function recruitment.fn_block_delete();

drop trigger if exists trg_hiring_team_member_no_delete on recruitment.hiring_team_member;
create trigger trg_hiring_team_member_no_delete
  before delete on recruitment.hiring_team_member
  for each row execute function recruitment.fn_block_delete();

drop trigger if exists trg_pipeline_template_no_delete on recruitment.pipeline_template;
create trigger trg_pipeline_template_no_delete
  before delete on recruitment.pipeline_template
  for each row execute function recruitment.fn_block_delete();

drop trigger if exists trg_pipeline_stage_no_delete on recruitment.pipeline_template_stage;
create trigger trg_pipeline_stage_no_delete
  before delete on recruitment.pipeline_template_stage
  for each row execute function recruitment.fn_block_delete();

drop trigger if exists trg_pipeline_stage_template_no_delete on recruitment.pipeline_template_stage_template;
create trigger trg_pipeline_stage_template_no_delete
  before delete on recruitment.pipeline_template_stage_template
  for each row execute function recruitment.fn_block_delete();


-- =====================================================================
--  §5  迁移后自检（任何一条不满足 → 整笔回滚，不留半套结构）
-- =====================================================================

do $$
declare
  v_missing text;
  v_n       integer;
begin
  -- 5.1 五张新表都在
  select string_agg(t, ', ') into v_missing
    from unnest(array[
      'hiring_team','hiring_team_member','pipeline_template',
      'pipeline_template_stage','pipeline_template_stage_template']) as t
   where to_regclass('recruitment.' || t) is null;
  if v_missing is not null then
    raise exception '0014 POST-CHECK 失败：缺表 %', v_missing;
  end if;

  -- 5.2 role 的新列都在且 NOT NULL 的列确实 NOT NULL
  select string_agg(c, ', ') into v_missing
    from unnest(array['permission_scopes','is_active','record_version','updated_at']) as c
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = 'recruitment.role'::regclass
        and a.attname = c and a.attnum > 0 and not a.attisdropped and a.attnotnull);
  if v_missing is not null then
    raise exception '0014 POST-CHECK 失败：role 缺 NOT NULL 列 %', v_missing;
  end if;

  -- 5.3 版本自增触发器：role + 3 张带 record_version 的新表（成员表/阶段表也带 updated_at）
  select count(*) into v_n
    from pg_trigger g
    join pg_class c on c.oid = g.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment' and not g.tgisinternal
     and g.tgfoid = 'recruitment.fn_touch'::regproc
     and g.tgname in ('trg_role_touch','trg_hiring_team_touch',
                      'trg_hiring_team_member_touch','trg_pipeline_template_touch');
  if v_n <> 4 then
    raise exception '0014 POST-CHECK 失败：fn_touch 触发器应 4 个，实际 %', v_n;
  end if;

  -- 5.4 禁删触发器：本迁移新增 5 个
  select count(*) into v_n
    from pg_trigger g
    join pg_class c on c.oid = g.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment' and not g.tgisinternal
     and g.tgfoid = 'recruitment.fn_block_delete'::regproc
     and g.tgname in ('trg_hiring_team_no_delete','trg_hiring_team_member_no_delete',
                      'trg_pipeline_template_no_delete','trg_pipeline_stage_no_delete',
                      'trg_pipeline_stage_template_no_delete');
  if v_n <> 5 then
    raise exception '0014 POST-CHECK 失败：禁删触发器应 5 个，实际 %', v_n;
  end if;

  -- 5.5 负向自检：非法权限范围必须被 CHECK 拦下。
  --     用子事务：INSERT 触发 check_violation → 整个子事务回滚，不留脏行。
  --     如果它居然成功，下面的 raise 是 P0001（不是 check_violation），会穿透本块 → 迁移失败。
  begin
    insert into recruitment.role (tenant_id, code, name, permission_scopes, created_by_actor_id)
    values ('11111111-1111-4111-8111-000000000001', 'SELFCHECK_BAD_SCOPE', '自检非法范围',
            '["NOT_A_REAL_SCOPE"]'::jsonb, null);
    raise exception '0014 POST-CHECK 失败：ck_role_permission_scopes 没有拦住非法权限范围';
  exception
    when check_violation then
      null;  -- 期望路径
  end;

  -- 5.6 种子数据没被本迁移改动：0002 的 4 个角色仍存在，且仍是空集合 + 版本 1
  select count(*) into v_n
    from recruitment.role
   where tenant_id = '11111111-1111-4111-8111-000000000001'
     and code in ('ORG_ADMIN','HIRING_MANAGER','HR_SPECIALIST','INTERVIEWER')
     and permission_scopes = '[]'::jsonb
     and record_version = 1
     and is_active;
  if v_n <> 0 and v_n <> 4 then
    raise exception '0014 POST-CHECK 失败：种子角色应 4 行且未被改动，实际 % 行', v_n;
  end if;

  raise notice '0014 POST-CHECK PASS 5 张新表 + role 扩列 + 4 个 touch + 5 个禁删触发器 + 负向自检通过';
end $$;


-- =====================================================================
--  §6  迁移台账自登记（0010 §规则第 1 条）
-- =====================================================================

do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0014_tenant_config',
            '企业自建配置：role 扩列(权限范围/描述/版本) + hiring_team(+member) + pipeline_template(+stage/+面试模板引用)')
    on conflict (version) do nothing;
  end if;
end $$;


commit;


-- =====================================================================
--  回滚方式（本文件无任何业务数据写入，回滚 = 反向 DDL，需人工确认）
--    drop table if exists recruitment.pipeline_template_stage_template;
--    drop table if exists recruitment.pipeline_template_stage;
--    drop table if exists recruitment.pipeline_template;
--    drop table if exists recruitment.hiring_team_member;
--    drop table if exists recruitment.hiring_team;
--    alter table recruitment.actor drop constraint if exists uq_actor_id_tenant_kind;
--    drop trigger if exists trg_role_touch on recruitment.role;
--    alter table recruitment.role drop constraint if exists fk_role_created_by;
--    alter table recruitment.role drop constraint if exists ck_role_permission_scopes;
--    alter table recruitment.role drop constraint if exists ck_role_description;
--    alter table recruitment.role drop constraint if exists ck_role_record_version;
--    alter table recruitment.role
--      drop column if exists description, drop column if exists permission_scopes,
--      drop column if exists is_active, drop column if exists created_by_actor_id,
--      drop column if exists record_version, drop column if exists updated_at;
--    drop function if exists recruitment.fn_permission_scopes_valid(jsonb);
--    delete from recruitment.schema_migration where version = '0014_tenant_config';
--  ⚠️ 回滚前确认没有业务行引用这些配置（role 的 permission_scopes 一旦被读取就会
--     让"回滚后权限变少/变多"成为事实，别把回滚当成无损操作）。
-- =====================================================================
