-- =====================================================================
--  recruitment-agent · 0021_application_star.sql
--
--  主题：候选人「星标（主推标记）」的**结构面**。HR 在候选人卡片上点星标/取消星标，
--  是一次人工判断，属 Recruiter 职权：写一次 append-only 事实，读侧取同一申请的
--  最新一条作为当前星标值。工具面保持 33 不变（写走 HTTP Host Action，不新增工具）。
--
--  一张 append-only 表 `recruitment.application_star`：
--    * 一行 = 一次星标切换事实（starred=true 点亮 / false 取消）。
--    * tenant_id + application_id 定位申请；actor_id 是点星的 HUMAN actor（来自 session
--      绑定，body/query/header 不接受身份覆盖）；confirmation_text_sha256 是人在界面
--      点确认时原话的服务端哈希（与 0017/0018/0019/0020 同口径）。
--    * created_at 定序；同一申请**取最新一条**为当前值（并列时以 id 兜底稳定排序）。
--    * 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）。
--
--  为什么 append-only 而不是 UPDATE application 加一个 starred 列：
--    * 星标是"谁在什么时候主推了谁"的人的判断，必须可追溯（V3 人的闸门）；
--    * 不碰到 0001 的 application 业务列（不改历史、不动不变量），读侧聚合即可；
--    * 重复切换只追加，不删除历史（禁删触发器 + 全列不可变护栏）。
--
--  幂等：create table / create index / drop+create trigger 全部 guarded；
--  迁移台账自登记 version='0021_application_star'（照 0017/0018/0019/0020 写法）。
--  依赖：0001（organization / application / actor / fn_block_delete / fn_guard_columns）；
--        0010（schema_migration 台账）。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
--  application_star（一行 = 一次星标切换事实；append-only，取最新一条为当前值）
-- ---------------------------------------------------------------------
create table if not exists recruitment.application_star (
  id                           uuid primary key default gen_random_uuid(),
  tenant_id                    uuid not null references recruitment.organization (id),
  application_id               uuid not null,
  starred                      boolean not null,
  actor_id                     uuid not null,
  confirmation_text_sha256     text not null,
  created_at                   timestamptz not null default now(),

  constraint uq_application_star_id_tenant unique (id, tenant_id),
  -- 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）
  constraint fk_application_star_application foreign key (application_id, tenant_id)
    references recruitment.application (id, tenant_id),
  constraint fk_application_star_actor foreign key (actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  -- 形状约束（STRUCT-04 同款：sha256 必须 64 位小写十六进制）
  constraint ck_application_star_sha256 check (confirmation_text_sha256 ~ '^[0-9a-f]{64}$')
);

-- 当前值查询：按 (tenant_id, application_id) 取最新一条（created_at desc, id desc 兜底稳定）。
create index if not exists ix_application_star_current
  on recruitment.application_star (tenant_id, application_id, created_at desc, id desc);

-- append-only：任何 DELETE 都 23514（与 0001 §9.1 / 0017 / 0018 / 0019 / 0020 同款）。
drop trigger if exists trg_application_star_no_delete on recruitment.application_star;
create trigger trg_application_star_no_delete before delete on recruitment.application_star
  for each row execute function recruitment.fn_block_delete();

-- 不可变：历史星标事实一个业务列都不许改（fn_guard_columns() 无白名单 ⇒ 全列禁止）。
drop trigger if exists trg_application_star_immutable on recruitment.application_star;
create trigger trg_application_star_immutable before update on recruitment.application_star
  for each row execute function recruitment.fn_guard_columns();

-- ---------------------------------------------------------------------
--  迁移台账自登记（0010 §规则第 1 条；与 0016/0017/0018/0019/0020 同款）
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0021_application_star',
            '候选人星标（主推标记）：application_star append-only（一行一次切换，tenant+application+starred+actor+确认原文 sha256+created_at，取最新一条为当前值；禁删/全列不可变，当前值索引）')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
