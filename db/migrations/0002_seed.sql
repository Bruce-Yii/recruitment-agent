-- =====================================================================
--  recruitment-agent · 0002_seed.sql
--  v1.0 最小种子数据（决策 D-14）
--
--  ⚠️ 演示用，非真实数据（DEMO ONLY / SYNTHETIC）。
--     本文件写入的每一行都是合成样例：演示租户、演示岗位、演示候选人。
--     不含任何真实候选人资料、真实企业、真实邮箱或真实凭据（铁律 R7）。
--     任何查询都能从 organization.name / job.title 里读到 DEMO 标记。
--
--  目的：P1 联调时 business_config.stage_catalog（阶段目录）不是空表，
--        且能立刻查到一条 job / rubric_version / candidate / application。
--
--  依赖：先跑 0001_init.sql。本文件**不改任何 schema 对象**（无 DDL），
--        只写数据；0001 的 39 表 / 约束 / 触发器全部保持原样。
--
--  幂等：所有 INSERT 都是 `on conflict do nothing`；两处状态迁移用
--        `update ... where <当前值> <> <目标值>` 守住。
--        连跑两遍：零 ERROR、零新增行、record_version 不因重跑而漂移。
--
--  不变量 8 / D-18：job DRAFT→OPEN、application S6→S7 是真实的状态迁移，
--        必须先 `set local recruitment.actor_id`（transaction 作用域，不外溢），
--        迁移由 fn_row_guard 自动写内部事件到 event_inbox 并回填
--        status_source_event_id / stage_source_event_id。
--        首跑产生 2 条内部事件；第二遍因为 0 行更新，不产生任何事件。
--
--  固定 UUID（便于测试复现，全部是 RFC 9562 v4 形式：…-4xxx-8xxx-…）
--    租户           11111111-1111-4111-8111-000000000001
--    部门           11111111-1111-4111-8111-000000000010
--    actor          11111111-1111-4111-8111-000000000101 … 0104
--    role           11111111-1111-4111-8111-000000000201 … 0204
--    actor_role     11111111-1111-4111-8111-000000000301 … 0304
--    job            11111111-1111-4111-8111-000000000401
--    job_version    11111111-1111-4111-8111-000000000402
--    rubric_version 11111111-1111-4111-8111-000000000403
--    business_config(stage_catalog) 11111111-1111-4111-8111-000000000501
--    candidate      11111111-1111-4111-8111-000000000601
--    application    11111111-1111-4111-8111-000000000701
--
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0002_seed.sql
--        不要加 -1（本文件自带 begin/commit）。
--        Windows 控制台建议先设 PGCLIENTENCODING=UTF8，否则中文名可能乱码。
-- =====================================================================

begin;


-- =====================================================================
--  1. 租户（1 行）
-- =====================================================================

insert into recruitment.organization (id, name, timezone)
values (
  '11111111-1111-4111-8111-000000000001',
  '演示租户 · DEMO ONLY（非真实数据）',
  'Asia/Shanghai'
)
on conflict (id) do nothing;


-- =====================================================================
--  2. 部门（1 行）
--     job.department_id 是 NOT NULL 复合外键，所以部门是 job 的前置；
--     hiring_manager 先留空，等 actor 落库后再回填（见 §3 末尾）。
-- =====================================================================

insert into recruitment.department (id, tenant_id, name)
values (
  '11111111-1111-4111-8111-000000000010',
  '11111111-1111-4111-8111-000000000001',
  '研发部（演示）'
)
on conflict (id) do nothing;


-- =====================================================================
--  3. 身份：4 个 actor（企业管理员 / 招聘负责人 / HR 专员 / 面试官）
-- + 4 个 role + 4 条 actor_role
--
--  actor.id 固定，便于联调时直接拿来 SET LOCAL recruitment.actor_id。
--  邮箱一律小写且域名带点（ck_actor_email_normalized），用保留 TLD .test。
-- =====================================================================

insert into recruitment.actor (id, tenant_id, kind, display_name, primary_email, department_id)
values
  ('11111111-1111-4111-8111-000000000101', '11111111-1111-4111-8111-000000000001', 'HUMAN',
   '演示-企业管理员', 'admin@demo-recruitment.test', '11111111-1111-4111-8111-000000000010'),
  ('11111111-1111-4111-8111-000000000102', '11111111-1111-4111-8111-000000000001', 'HUMAN',
   '演示-招聘负责人', 'hiring.manager@demo-recruitment.test', '11111111-1111-4111-8111-000000000010'),
  ('11111111-1111-4111-8111-000000000103', '11111111-1111-4111-8111-000000000001', 'HUMAN',
   '演示-HR 专员', 'hr@demo-recruitment.test', '11111111-1111-4111-8111-000000000010'),
  ('11111111-1111-4111-8111-000000000104', '11111111-1111-4111-8111-000000000001', 'HUMAN',
   '演示-面试官', 'interviewer@demo-recruitment.test', '11111111-1111-4111-8111-000000000010')
on conflict (id) do nothing;

-- 部门招聘负责人 = 招聘负责人（department 没有状态列，不受 fn_row_guard 约束；
-- 用 is null 守住，重跑时 0 行更新）
update recruitment.department
   set hiring_manager_actor_id = '11111111-1111-4111-8111-000000000102'
 where id = '11111111-1111-4111-8111-000000000010'
   and hiring_manager_actor_id is null;

insert into recruitment.role (id, tenant_id, code, name)
values
  ('11111111-1111-4111-8111-000000000201', '11111111-1111-4111-8111-000000000001', 'ORG_ADMIN',      '企业管理员'),
  ('11111111-1111-4111-8111-000000000202', '11111111-1111-4111-8111-000000000001', 'HIRING_MANAGER', '招聘负责人'),
  ('11111111-1111-4111-8111-000000000203', '11111111-1111-4111-8111-000000000001', 'HR_SPECIALIST',  'HR 专员'),
  ('11111111-1111-4111-8111-000000000204', '11111111-1111-4111-8111-000000000001', 'INTERVIEWER',    '面试官')
on conflict (id) do nothing;

insert into recruitment.actor_role (id, tenant_id, actor_id, role_id, granted_by_actor_id)
values
  -- 管理员是引导账号：自己不需要授权人
  ('11111111-1111-4111-8111-000000000301', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000101', '11111111-1111-4111-8111-000000000201', null),
  ('11111111-1111-4111-8111-000000000302', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000102', '11111111-1111-4111-8111-000000000202',
   '11111111-1111-4111-8111-000000000101'),
  ('11111111-1111-4111-8111-000000000303', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000103', '11111111-1111-4111-8111-000000000203',
   '11111111-1111-4111-8111-000000000101'),
  ('11111111-1111-4111-8111-000000000304', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000104', '11111111-1111-4111-8111-000000000204',
   '11111111-1111-4111-8111-000000000102')
on conflict do nothing;


-- =====================================================================
--  4. 岗位（1 job + 1 job_version），终态 = OPEN
--     先以 DRAFT 落库，再把 current_job_version_id 指向 v1，
--     最后由状态迁移推到 OPEN —— 迁移必须留 actor（不变量 8）。
-- =====================================================================

insert into recruitment.job (id, tenant_id, department_id, code, title, status)
values (
  '11111111-1111-4111-8111-000000000401',
  '11111111-1111-4111-8111-000000000001',
  '11111111-1111-4111-8111-000000000010',
  'DEMO-BE-001',
  '后端工程师（演示）',
  'DRAFT'
)
on conflict (id) do nothing;

-- JD 内容只用于联调展示；payload_hash 由内容真实算出（sha256 of 内容），
-- 不是占位常量 —— 任何哈希校验都能对上。
with content as (
  select
    $jd$# 后端工程师（演示岗位）

演示用 JD，非真实招聘信息。$jd$::text as description_md,
    $req$- 3 年以上后端开发经验（演示样例）
- 熟悉 PostgreSQL 与消息队列（演示样例）$req$::text as requirements_md
)
insert into recruitment.job_version (
  id, tenant_id, job_id, version_no, description_md, requirements_md,
  payload_hash, created_by_actor_id
)
select
  '11111111-1111-4111-8111-000000000402'::uuid,
  '11111111-1111-4111-8111-000000000001'::uuid,
  '11111111-1111-4111-8111-000000000401'::uuid,
  1,
  description_md,
  requirements_md,
  encode(sha256(convert_to(description_md || E'\n----\n' || requirements_md, 'UTF8')), 'hex'),
  '11111111-1111-4111-8111-000000000103'::uuid
from content
on conflict (id) do nothing;

-- job.current_job_version_id 是循环外键（0001 §8 补的），所以只能后置回填
update recruitment.job
   set current_job_version_id = '11111111-1111-4111-8111-000000000402'
 where id = '11111111-1111-4111-8111-000000000401'
   and current_job_version_id is null;

-- 状态迁移 1/2：DRAFT → OPEN（演示：招聘负责人放岗）。
-- SET LOCAL 只在当前事务有效（D-18：禁止用 SET）。重跑时 0 行更新 → 不写事件。
set local recruitment.actor_id = '11111111-1111-4111-8111-000000000102';
update recruitment.job
   set status = 'OPEN'
 where id = '11111111-1111-4111-8111-000000000401'
   and status <> 'OPEN';


-- =====================================================================
--  5. Rubric 版本（1 行，绑定该 job）
--     ⚠️ rubric_version 表**没有 is_current 列**（0001 未建，0002 不改 schema）。
--     本种子里只有 v1 一行 → 它就是"当前版本"；多版本时"当前"由
--     application.rubric_version_id 固定引用 / max(version_no) 推导，
--     不得靠改旧行来表达（rubric_version 整行不可 UPDATE，不变量 10）。
--     dimensions 形状对齐 C 线 CONTRACT 的 criteria: key/label/kind/weight，
--     weight 求和 = 1.0。
-- =====================================================================

with dims as (
  select $dims$[
    {"key": "backend_depth",    "label": "后端工程深度",        "kind": "MUST_HAVE",    "weight": 0.5},
    {"key": "async_pipeline",   "label": "异步/队列流水线经验", "kind": "MUST_HAVE",    "weight": 0.3},
    {"key": "frontend_basics",  "label": "基本前端能力",        "kind": "NICE_TO_HAVE", "weight": 0.2}
  ]$dims$::jsonb as dimensions
)
insert into recruitment.rubric_version (
  id, tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id
)
select
  '11111111-1111-4111-8111-000000000403'::uuid,
  '11111111-1111-4111-8111-000000000001'::uuid,
  '11111111-1111-4111-8111-000000000401'::uuid,
  1,
  dimensions,
  encode(sha256(convert_to(dimensions::text, 'UTF8')), 'hex'),
  '11111111-1111-4111-8111-000000000102'::uuid
from dims
on conflict (id) do nothing;


-- =====================================================================
--  6. 阶段目录 business_config.stage_catalog（D-14 的核心缺口）
--
--  scope='ORGANIZATION' + scope_id=null（ck_business_config_scope_id 要求）；
--  config_key='stage_catalog'；payload 是 object（约束要求）。
--  目录 = docs/01 §阶段 1–12 的完整 12 个阶段：code / name / order 齐全，
--  另带 kind（业务域）与 in_v1_scope（v1.0 切割：阶段 3/6/7/8/9/10）。
--  payload_hash 由 payload 真实算出，便于后续做"配置未被静默改动"校验。
-- =====================================================================

with cfg as (
  select $cfg${
    "catalog_version": 1,
    "demo": true,
    "note": "演示用，非真实数据（DEMO ONLY）；阶段取自 docs/01 §阶段 1–12",
    "stages": [
      {"order": 1,  "code": "S1",  "name": "招聘需求发现",             "kind": "DEMAND",       "in_v1_scope": false},
      {"order": 2,  "code": "S2",  "name": "Requisition 创建与审批",   "kind": "REQUISITION",  "in_v1_scope": false},
      {"order": 3,  "code": "S3",  "name": "Job / JD / Rubric 设计",   "kind": "JOB_DESIGN",   "in_v1_scope": true},
      {"order": 4,  "code": "S4",  "name": "Job Posting 发布",         "kind": "POSTING",      "in_v1_scope": false},
      {"order": 5,  "code": "S5",  "name": "人才获取 / Sourcing",      "kind": "SOURCING",     "in_v1_scope": false},
      {"order": 6,  "code": "S6",  "name": "简历接入与处理（Intake）", "kind": "INTAKE",       "in_v1_scope": true},
      {"order": 7,  "code": "S7",  "name": "初筛 / Screening",         "kind": "SCREENING",    "in_v1_scope": true},
      {"order": 8,  "code": "S8",  "name": "面试规划与排期",           "kind": "SCHEDULING",   "in_v1_scope": true},
      {"order": 9,  "code": "S9",  "name": "面试执行与材料获取",       "kind": "INTERVIEW",    "in_v1_scope": true},
      {"order": 10, "code": "S10", "name": "综合评价与招聘决策",       "kind": "DECISION",     "in_v1_scope": true},
      {"order": 11, "code": "S11", "name": "Offer 与入职交接",         "kind": "OFFER",        "in_v1_scope": false},
      {"order": 12, "code": "S12", "name": "人才沉淀与复盘",           "kind": "TALENT_POOL",  "in_v1_scope": false}
    ]
  }$cfg$::jsonb as payload
)
insert into recruitment.business_config (
  id, tenant_id, scope, scope_id, config_key, version_no,
  payload, payload_hash, created_by_actor_id
)
select
  '11111111-1111-4111-8111-000000000501'::uuid,
  '11111111-1111-4111-8111-000000000001'::uuid,
  'ORGANIZATION',
  null,
  'stage_catalog',
  1,
  payload,
  encode(sha256(convert_to(payload::text, 'UTF8')), 'hex'),
  '11111111-1111-4111-8111-000000000101'::uuid
from cfg
on conflict (id) do nothing;


-- =====================================================================
--  7. 候选人 + 申请（各 1 行，供工具查询联调）
--     application 的 job_version_id / rubric_version_id 固定引用上面的版本行
--     （不变量 10：配置换版不静默改写已开始的申请）。
--     current_stage_code 从 S6（Intake）起步，再由状态迁移推到 S7（初筛），
--     这样联调既有"当前阶段"，也有真实的 stage 迁移事件可查。
-- =====================================================================

insert into recruitment.candidate (
  id, tenant_id, display_name, normalized_email, normalized_phone
)
values (
  '11111111-1111-4111-8111-000000000601',
  '11111111-1111-4111-8111-000000000001',
  '演示候选人-张样例',
  'zhang.sample@demo-recruitment.test',
  '+8613800000000'
)
on conflict (id) do nothing;

insert into recruitment.application (
  id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id,
  lifecycle_status, current_stage_code
)
values (
  '11111111-1111-4111-8111-000000000701',
  '11111111-1111-4111-8111-000000000001',
  '11111111-1111-4111-8111-000000000601',
  '11111111-1111-4111-8111-000000000401',
  '11111111-1111-4111-8111-000000000402',
  '11111111-1111-4111-8111-000000000403',
  'ACTIVE',
  'S6'
)
on conflict (id) do nothing;

-- 状态迁移 2/2：S6（Intake）→ S7（初筛），演示 HR 专员推进阶段。
set local recruitment.actor_id = '11111111-1111-4111-8111-000000000103';
update recruitment.application
   set current_stage_code = 'S7'
 where id = '11111111-1111-4111-8111-000000000701'
   and current_stage_code <> 'S7';


commit;
