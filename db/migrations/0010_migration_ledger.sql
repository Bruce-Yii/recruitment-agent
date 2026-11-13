-- =====================================================================
--  recruitment-agent · 0010_migration_ledger.sql
--
--  修根因 C（状态靠人记）：在库里建**迁移台账**，让"哪些迁移应用过"可查询，
--  不再靠人回忆、不再出现 2026-11-14 那次「0007/0008 被 0009 截断」的事故。
--
--  为什么需要它（事故原文）：
--    本地库当时是 0001–0006 + 0009，而 0007/0008 从没跑过。
--    没有任何地方记录"跑到哪了"，`\dt` 也看不出来 —— 于是代码按"0007 已落地"写，
--    实际库里没有 uq_decision_current / fk_scorecard_rubric_job。
--
--  规则（从此生效）：
--    1. 每条迁移**自己登记自己**（本文件末尾那段就是模板）；
--    2. `db/verify-0010.sql` 校验台账与 `db/migrations/*.sql` 一致；
--    3. CI 按 0001→N 顺序全链重放，任何一条漏登记都会红。
--
--  本文件是**幂等**的：重复执行只补登记，不重复建表、不报错。
-- =====================================================================

begin;

-- 表形状必须遵守仓库约定（verify.sql STRUCT-01）：**主键是单列 uuid id**，
-- 业务唯一键另开 unique 约束。第一版我用了 ersion text primary key，被 verify.sql 直接判红 ——
-- 全链重放的价值就在这里：约定不是靠记的，是被脚本检查的。
create table if not exists recruitment.schema_migration (
  id         uuid        primary key default gen_random_uuid(),
  version    text        not null unique,
  applied_at timestamptz not null default now(),
  note       text
);

comment on table recruitment.schema_migration is
  '迁移台账：每条 db/migrations/*.sql 应用后在此登记一行（D-96/根因C 的机制修复）。';

-- ── 历史回填（0001–0009 已应用；2026-11-14 逐条 verify 通过）───────────
insert into recruitment.schema_migration (version, note) values
  ('0001_init',                 '回填：初始 schema（0001–0009 于 2026-11-14 逐条 verify 通过）'),
  ('0002_seed',                 '回填：演示租户/actor/stage_catalog 种子'),
  ('0003_review_queue',         '回填：人工复核队列'),
  ('0004_stage_catalog',        '回填：阶段目录'),
  ('0005_version_binding',      '回填：版本绑定'),
  ('0006_integrity_gaps',       '回填：完整性缺口第一批'),
  ('0007_decision_integrity',   '回填：决策完整性（2026-11-14 补跑，含 §7 回填 scorecard.job_id）'),
  ('0008_decision_uniqueness',  '回填：决策唯一性（2026-11-14 补跑）'),
  ('0009_application_identity', '回填：申请身份 (tenant, candidate, job, ACTIVE)')
on conflict (version) do nothing;

-- ── 本文件自己登记自己（模板：以后每条迁移末尾照抄这段）──────────────
insert into recruitment.schema_migration (version, note) values
  ('0010_migration_ledger', '迁移台账：建表 + 历史回填 + 自登记')
on conflict (version) do nothing;

commit;
