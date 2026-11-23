-- =====================================================================
--  recruitment-agent · 0025_auth_login.sql
--
--  主题：Issue #61 / D-178 —— 生产登录的最小持久化面（独立产品入口的正式账号）。
--
--  设计要点：
--    * `recruitment.auth_user`：用户名唯一（租户内）、口令只存 scrypt 串
--      （`scrypt$N$r$p$salt$hash`，随机 16 字节盐），绝不存明文；alias 闭集与
--      `src/demo-actor/alias.ts::DEMO_ACTOR_ALIASES` 一致（不另造角色系统）。
--    * `recruitment.auth_session`：登录会话落库，Host 重启后仍有效；cookie 里的
--      token 只以 sha256 形式存（`token_sha256`），`revoked_at` 让 logout 立即失效。
--    * 没有名为 `status` 的列（避免 STRUCT-04/05 强加无关状态机触发器）；用户禁用用
--      `disabled_at`、会话撤销用 `revoked_at` 表达。
--    * 复合外键都带 tenant_id（STRUCT-07）；tenant_id 都 NOT NULL 且指向 organization
--      （STRUCT-02/03）；主键都是单列 uuid `id`（STRUCT-01）。
--    * 种子只给两个演示账号（哈希在下方，明文只在 docs/41-production-login.md 文档化），
--      幂等 `on conflict (tenant_id, username) do nothing`，重复跑迁移零写入。
--    * 台账自登记 0025_auth_login（0010 §规则第 1 条）。
-- =====================================================================

begin;

create table if not exists recruitment.auth_user (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references recruitment.organization (id),
  username      text not null,
  password_hash text not null,
  display_name  text not null,
  alias         text not null,
  disabled_at   timestamptz,
  created_at    timestamptz not null default now(),

  constraint uq_auth_user_id_tenant unique (id, tenant_id),
  constraint uq_auth_user_tenant_username unique (tenant_id, username),
  constraint ck_auth_user_username check (username ~ '^[a-z0-9_.-]{2,64}$'),
  constraint ck_auth_user_password_hash check (
    password_hash ~ '^scrypt\$[0-9]{4,5}\$[0-9]{1,2}\$[0-9]{1,2}\$[0-9a-f]{32}\$[0-9a-f]{128}$'
  ),
  constraint ck_auth_user_display_name check (length(btrim(display_name)) between 1 and 200),
  constraint ck_auth_user_alias check (alias in ('recruiter', 'interviewer_a', 'interviewer_b'))
);

create table if not exists recruitment.auth_session (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references recruitment.organization (id),
  session_id    text not null,
  token_sha256  text not null,
  username      text not null,
  alias         text not null,
  display_name  text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,

  constraint uq_auth_session_id_tenant unique (id, tenant_id),
  constraint uq_auth_session_token unique (tenant_id, token_sha256),
  constraint ck_auth_session_sid check (session_id ~ '^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint ck_auth_session_token_sha256 check (token_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ck_auth_session_username check (username ~ '^[a-z0-9_.-]{2,64}$'),
  constraint ck_auth_session_alias check (alias in ('recruiter', 'interviewer_a', 'interviewer_b')),
  constraint ck_auth_session_expiry check (expires_at > created_at)
);

-- token 查找索引：唯一约束已建索引，这里给"未撤销会话"的部分索引（会话量小，
-- 但保留与 verify.sql 的专项断言一一对应）。
create index if not exists ix_auth_session_active
  on recruitment.auth_session (tenant_id, token_sha256)
 where revoked_at is null;

-- ---------------------------------------------------------------------
--  演示账号种子（口令哈希 = scrypt 随机盐；明文见 docs/41-production-login.md）
-- ---------------------------------------------------------------------
insert into recruitment.auth_user
  (tenant_id, username, password_hash, display_name, alias)
values
  ('11111111-1111-4111-8111-000000000001', 'recruiter',
   'scrypt$16384$8$1$5f99186ba663a2676f9b3b7899d779bd$713ae9a488f8f32c66e8ecc23db0f935458308153dbc0b02bc31bef9bfe6095cf543c8f016796f159a6f88a20218139326c77c36cb7dc52488984ea8e1b165ec',
   '演示-招聘负责人', 'recruiter'),
  ('11111111-1111-4111-8111-000000000001', 'interviewer',
   'scrypt$16384$8$1$567442441bce8e8b49e878cadee6a893$b65090a6f86ef2066db49f219202ce304321cdd044239a07fabb9cb29db3672961c13bf75a7e532b8d893ba144f7576b920fb2803f135218d8260add0b9ab4a2',
   '演示-面试官 A', 'interviewer_a')
on conflict (tenant_id, username) do nothing;

-- ---------------------------------------------------------------------
--  迁移台账自登记（0010 §规则第 1 条）
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0025_auth_login',
            'Issue #61 生产登录：auth_user（scrypt 哈希，无明文）+ auth_session（token sha256 / 持久会话 / revoked_at 即时失效）')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
