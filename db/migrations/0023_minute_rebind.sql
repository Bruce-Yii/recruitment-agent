-- =====================================================================
--  recruitment-agent · 0023_minute_rebind.sql
--
--  主题：换面试官后把该场会议的妙记录音归属改绑到新面试官（docs/34 §二.2-3、
--  docs/36 C2）。防面评挂错人：谁的面评必须挂在谁的录音上。
--
--  设计要点（与 0019/0021/0022 同款 append-only 事实表模式）：
--    * 一张 append-only 审计表 `recruitment.minute_rebind`：每次请求（dry-run 或真实写）
--      INSERT 一行，记「谁、何时、哪个会议、从谁到谁、原话哈希、CLI 返回摘要」。
--      本表是**审计事实**，不是外部写本身；真实外部写由 HTTP 层调 CLI 完成。
--    * 禁删（fn_block_delete）/ 整行不可改（fn_guard_columns 无白名单）：
--      一旦落库不可篡改、不可抵赖，只能追加。
--    * **幂等（同一 interview + minute_token + to_actor 重复提交不再执行第二次外部写）**：
--      唯一键 `uq_minute_rebind_idempotent (tenant_id, interview_id, minute_token, to_actor_id)`。
--      写入前先只读查同键是否已存在：存在则直接返回 already_bound=true，不再调 CLI；
--      并发下由唯一约束兜底（唯一冲突 → 409 REBIND_ALREADY_DONE，零外部写）。
--      注意：**失败的行不写审计表**（FAILED 不 INSERT），所以失败后可以重试。
--    * 复合外键都带 tenant_id（STRUCT-07 防跨租户引用）：
--        (interview_id, tenant_id) → interview、
--        (from_actor_id, tenant_id) / (to_actor_id, tenant_id) /
--        (requested_by_actor_id, tenant_id) → actor。
--    * confirmation_text 只存 **sha256**（人的原话不入库，R7：不把人的原话写进任何文件/库）；
--      哈希由服务端算（HTTP 层 sha256Text），不接受客户端传哈希。
--    * cli_summary jsonb：CLI 返回摘要（status / exit_code / 脱敏 stderr / 是否 dry_run），
--      不存原始 stdout/stderr、不存 argv（argv 含平台标识）。
--    * 不新增事件类型、不动 src/runtime/**：本表是独立审计事实，不进事件总线。
--
--  幂等：create table / index / trigger 全部 guarded；迁移台账自登记 0023_minute_rebind。
--  依赖：0001（organization / interview / actor / fn_block_delete / fn_guard_columns）；
--        0010（schema_migration 台账）。
-- =====================================================================

begin;

create table if not exists recruitment.minute_rebind (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references recruitment.organization (id),
  interview_id              uuid not null,
  -- 谁的面评原属 / 改绑给谁 / 谁发起（都是 HUMAN actor 的 uuid）
  from_actor_id             uuid not null,
  to_actor_id               uuid not null,
  requested_by_actor_id     uuid not null,
  -- 平台妙记 token（来自 HTTP body，服务端校验形状）
  minute_token              text not null,
  -- 人的原话的 sha256（服务端计算；原话不入库）
  confirmation_text_sha256  text not null,
  -- CLI 返回摘要（已脱敏；不含 argv / 原始 stdout/stderr）
  cli_summary               jsonb not null,
  -- true = dry-run（只打印请求，无外部写）；false = 真实改绑（本阶段 HTTP 层不产生）
  dry_run                   boolean not null,
  created_at                timestamptz not null default now(),

  constraint uq_minute_rebind_id_tenant unique (id, tenant_id),

  -- 幂等键：同一 (tenant, interview, minute, to) 只允许一行；重复提交不再外部写
  constraint uq_minute_rebind_idempotent
    unique (tenant_id, interview_id, minute_token, to_actor_id),

  -- 复合外键（STRUCT-07）
  constraint fk_minute_rebind_interview foreign key (interview_id, tenant_id)
    references recruitment.interview (id, tenant_id),
  constraint fk_minute_rebind_from_actor foreign key (from_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_minute_rebind_to_actor foreign key (to_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),
  constraint fk_minute_rebind_requester foreign key (requested_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id),

  -- 值域 / 形状约束
  constraint ck_minute_rebind_minute_token check (
    length(minute_token) between 1 and 512
    and minute_token not like '%@%'
    and minute_token not like '%' || chr(10) || '%'
    and minute_token not like '%' || chr(13) || '%'
  ),
  constraint ck_minute_rebind_sha256 check (confirmation_text_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ck_minute_rebind_distinct_actors check (from_actor_id <> to_actor_id),
  constraint ck_minute_rebind_cli_summary_object check (jsonb_typeof(cli_summary) = 'object')
);

-- 「按面试查最近改绑」的只读索引（审计读回用）。
create index if not exists ix_minute_rebind_interview
  on recruitment.minute_rebind (tenant_id, interview_id, created_at desc);

-- append-only：任何 DELETE 都 23514。
drop trigger if exists trg_minute_rebind_no_delete on recruitment.minute_rebind;
create trigger trg_minute_rebind_no_delete before delete on recruitment.minute_rebind
  for each row execute function recruitment.fn_block_delete();

-- 不可变：不给白名单 = 整行业务列不可改。
drop trigger if exists trg_minute_rebind_immutable on recruitment.minute_rebind;
create trigger trg_minute_rebind_immutable before update on recruitment.minute_rebind
  for each row execute function recruitment.fn_guard_columns();

-- ---------------------------------------------------------------------
--  迁移台账自登记（0010 §规则第 1 条）
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0023_minute_rebind',
            '妙记录音归属改绑：minute_rebind append-only 审计表（禁删/禁改 + 幂等唯一键 + 原话 sha256 + CLI 摘要 + 台账自登记）')
    on conflict (version) do nothing;
  end if;
end $$;

commit;
