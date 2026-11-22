-- =====================================================================
--  recruitment-agent · 0024_booking_invite.sql
--
--  主题：G-09 候选人自助选时段的一次性预约邀约（design/v4/wave3-product-loop-spec.md §1）。
--
--  设计要点：
--    * 一张 `recruitment.booking_invite`：HR 生成一条邀约（2..5 个白名单时段、
--      72h 默认有效期），候选人免登录确认后同一事务 OPEN → CONSUMED。
--    * **token 不明文落库**：只存 `token_sha256`（服务端生成的 32 字节随机串的 sha256）；
--      HTTP 响应里的 token 是唯一一次可见的钥匙，日志/错误/公开投影都不输出它。
--    * 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）：
--        (application_id, tenant_id) → application、
--        (created_by_actor_id, tenant_id) → actor（发起邀约的 HR）、
--        (confirmed_interview_id, tenant_id) → interview（确认后回填）。
--    * `interviewer_actor_ids` / `slots` 是 jsonb 数组：其元素语义由服务端校验，
--      不在这里展开成子表（G-09 的最小持久化面）。
--    * 状态机只有 OPEN → CONSUMED（一次性）；过期由 expires_at 判定，不改行状态，
--      公开页如实展示 EXPIRED，零写入。
--    * 幂等：create table / index / trigger 全部 guarded；迁移台账自登记 0024_booking_invite。
--      依赖 0001（organization/application/actor/interview/fn_block_delete）、0010（schema_migration）。
-- =====================================================================

begin;

create table if not exists recruitment.booking_invite (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references recruitment.organization (id),
  application_id            uuid not null,
  created_by_actor_id       uuid not null,
  round_no                  integer not null,
  duration_minutes          integer not null,
  interviewer_actor_ids     jsonb not null,
  timezone                  text not null,
  slots                     jsonb not null,
  token_sha256              text not null,
  booking_state             text not null default 'OPEN',
  expires_at                timestamptz not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  confirmed_slot_index      integer,
  confirmed_interview_id    uuid,
  self_booked               boolean not null default true,

  constraint uq_booking_invite_id_tenant unique (id, tenant_id),
  constraint uq_booking_invite_token unique (tenant_id, token_sha256),

  constraint fk_booking_invite_application foreign key (application_id, tenant_id)
    references recruitment.application (id, tenant_id),
  constraint fk_booking_invite_creator foreign key (created_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_booking_invite_interview foreign key (confirmed_interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),

  constraint ck_booking_invite_booking_state check (booking_state in ('OPEN', 'CONSUMED')),
  constraint ck_booking_invite_round check (round_no between 1 and 20),
  constraint ck_booking_invite_duration check (duration_minutes between 15 and 480),
  constraint ck_booking_invite_token_sha256 check (token_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ck_booking_invite_timezone check (btrim(timezone) <> '' and length(timezone) <= 64),
  constraint ck_booking_invite_slots_shape check (
    jsonb_typeof(slots) = 'array'
    and jsonb_array_length(slots) between 2 and 5
  ),
  constraint ck_booking_invite_interviewers_shape check (
    jsonb_typeof(interviewer_actor_ids) = 'array'
    and jsonb_array_length(interviewer_actor_ids) >= 1
  ),
  constraint ck_booking_invite_confirmed_slot check (
    (booking_state = 'OPEN' and confirmed_slot_index is null and confirmed_interview_id is null)
    or (booking_state = 'CONSUMED' and confirmed_slot_index between 0 and 4
        and confirmed_interview_id is not null)
  )
);

-- token 查找索引（公开读/确认按 token_sha256 定位；唯一约束已建索引，这一条给状态过滤用）。
create index if not exists ix_booking_invite_tenant_status
  on recruitment.booking_invite (tenant_id, booking_state, created_at desc);

-- append-only 审计护栏：邀约表禁删；状态推进只允许 OPEN → CONSUMED 且仅改三列。
-- 用 fn_guard_columns 会禁止一切 UPDATE（含我们需要的 CONSUMED 回填），这里只加禁删。
drop trigger if exists trg_booking_invite_no_delete on recruitment.booking_invite;
create trigger trg_booking_invite_no_delete before delete on recruitment.booking_invite
  for each row execute function recruitment.fn_block_delete();

-- ---------------------------------------------------------------------
--  迁移台账自登记（0010 §规则第 1 条）
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0024_booking_invite',
            'G-09 候选人自助预约：booking_invite 一次性邀约（token sha256 / 白名单时段 / OPEN→CONSUMED / 72h 有效期 / 禁删）')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
