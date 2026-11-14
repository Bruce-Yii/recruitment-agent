-- =====================================================================
--  recruitment-agent · 0011_task_runtime.sql
--
--  任务运行时（Business Task / Task Attempt / Agent Session 三层身份）
--  + 事件运行时（Event Inbox 验源 → 幂等去重 → 定位业务对象 → 创建/唤醒 Task）
--  的**库层缺口**。只加结构，不改任何已有列的语义，不回填、不替人改数据。
--
--  权威来源：
--    Notion `04｜Agent Runtime & Reuse Architecture`
--      §10  两条事件路径（确定性事件 / 语义准入）、幂等与业务对象关联
--      §12  上下文、会话与长期状态（Task / Attempt / Session 三层分离）
--    `docs/03-domain-and-runtime.md` §9 Event Envelope、§10–§11 Task / Attempt
--    `db/verify.sql` STRUCT-01..07（单列 uuid 主键 / tenant_id / 复合外键 / 禁删）
--
--  现状（2026-11-14 实测 ra_s6s7，迁移到 0010 + 0012/0013 之前的口径）：
--    0001_init.sql 已经建了 event_inbox / business_task / task_attempt / agent_session
--    四张表，字段和 CHECK 很全，但**没有写入者**，而且结构上缺四块"运行时需要、
--    查得出来"的事实：
--
--    1) event_inbox：
--       * 只有 `idempotency_key` 唯一；**没有 (tenant_id, provider, provider_event_id)
--         唯一约束** —— 同一 provider 事件只要调用方换了幂等键写法就能进第二行，
--         "同一 provider event id 不重复处理"在库层不成立；
--       * `processed_at` 列存在，但**没有任何状态机**：谁在什么时候把它从"收到"
--         推到"已路由/已忽略/失败"、失败原因是什么，都无处记录。它现在是死列。
--
--    2) 没有 event → task 的**唤醒事实表**：同一事件重复到达时，business_task 的
--       `uq_business_task_idempotency` 只能保证"不重复建任务"，不能保证
--       "不重复唤醒/不重复执行"；也无法回答"这个 Task 被哪些事件唤醒过、几次"。
--       0013 的 `tool_call` 是执行事实，不是唤醒事实，二者不能互相代替。
--
--    3) agent_session：只有 (task_id, attempt_id, runtime_kind, runtime_version,
--       model_route, status)，**没有一列记录 DSH 真实 session id**。于是
--       "Session 可替换的计算上下文"无法从库里对回真实会话，也无法证明
--       "Session 结束 ≠ Task 结束"时到底是哪个会话结束了。
--
--    4) task_attempt：没有租约回收索引（重启后按 lease_expires_at 扫描失联
--       Attempt 会全表扫）；agent_session 与 task_attempt 之间也没有一致性守卫，
--       可以出现 "session.task_id = A 但 attempt 属于 B" 的混身份行。
--
--  本迁移新增（全部为**增量**）：
--    §1 event_inbox：dispatch 状态机 + 业务对象定位列 + provider event 唯一索引
--    §2 business_task：last_wake_event_id / wake_count + 派发索引
--    §3 task_wakeup：事件唤醒事实表（(task_id, event_id) 唯一 = 同一事件只唤醒一次）
--    §4 agent_session：真实 runtime session id + worker 角色 + 一致性守卫
--    §5 task_attempt：租约回收索引
--    §6 自检 + 登记迁移台账
--
--  为什么新表叫 task_wakeup 而不是复用 business_task.status_source_event_id：
--    那是**状态审计**列（一次状态迁移的来源事件），不是"唤醒"列；一条事件可以
--    只唤醒不迁移状态（例如 WAITING_EXTERNAL 的 Task 收到同一 Transcript 的
--    第二个分片），复用会把两种事实混成一条，正是 Notion §12 禁止的"混层"。
--
--  幂等：add column if not exists / create index if not exists / DO 块先查
--  pg_constraint、pg_trigger；连跑两遍第二遍零新增。
--  回滚方式见文件末尾（反向 DDL，需人工确认）。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- §0 前置检查：本迁移依赖的表必须存在（在空库顺序重放时给出可读错误）
-- ---------------------------------------------------------------------
do $$
declare
  v_missing text := '';
  t text;
begin
  foreach t in array array['organization', 'event_inbox', 'business_task',
                           'task_attempt', 'agent_session'] loop
    if to_regclass('recruitment.' || t) is null then
      v_missing := v_missing || t || ' ';
    end if;
  end loop;
  if v_missing <> '' then
    raise exception 'TASK_RUNTIME_DEPENDENCY: 缺表 %（0011 依赖 0001_init；请按 0001→0011 顺序重放）', v_missing;
  end if;
  raise notice '0011 PRE-CHECK PASS 依赖表齐全（event_inbox / business_task / task_attempt / agent_session）';
end $$;

-- ---------------------------------------------------------------------
-- §1 event_inbox：事件运行时的去重与路由状态
-- ---------------------------------------------------------------------
alter table recruitment.event_inbox
  add column if not exists dispatch_state text not null default 'RECEIVED',
  add column if not exists routed_at      timestamptz,
  add column if not exists route_attempts integer not null default 0,
  add column if not exists route_error    text,
  add column if not exists business_object_type text,
  add column if not exists business_object_id   text,
  add column if not exists routed_task_id       uuid;

do $$
begin
  -- 1.1 dispatch 状态机：RECEIVED → ROUTED / IGNORED / FAILED。
  --     不叫 `status` 是故意的：event_inbox 整行不可变（0001 的 COMMENT），
  --     dispatch 是**运行时投影**，不是事件本身的业务状态；套 fn_row_guard 会
  --     把一条不可变事件变成"每次重播都写状态审计"的可变行（R2 假接线）。
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_event_inbox_dispatch_state'
                    and c.conrelid = 'recruitment.event_inbox'::regclass) then
    alter table recruitment.event_inbox
      add constraint ck_event_inbox_dispatch_state check (
        dispatch_state in ('RECEIVED', 'ROUTED', 'IGNORED', 'FAILED'));
    raise notice '0011 §1.1 已加 ck_event_inbox_dispatch_state';
  else
    raise notice '0011 §1.1 ck_event_inbox_dispatch_state 已存在，跳过';
  end if;

  -- 1.2 路由终态必须留下时间；FAILED 必须留下机器可读原因（docs/03 §15）。
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_event_inbox_dispatch_recorded'
                    and c.conrelid = 'recruitment.event_inbox'::regclass) then
    alter table recruitment.event_inbox
      add constraint ck_event_inbox_dispatch_recorded check (
        (dispatch_state = 'RECEIVED' and routed_at is null)
        or (dispatch_state in ('ROUTED', 'IGNORED', 'FAILED') and routed_at is not null));
    raise notice '0011 §1.2 已加 ck_event_inbox_dispatch_recorded';
  else
    raise notice '0011 §1.2 ck_event_inbox_dispatch_recorded 已存在，跳过';
  end if;

  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_event_inbox_route_failure'
                    and c.conrelid = 'recruitment.event_inbox'::regclass) then
    alter table recruitment.event_inbox
      add constraint ck_event_inbox_route_failure check (
        dispatch_state <> 'FAILED' or route_error is not null);
    raise notice '0011 §1.3 已加 ck_event_inbox_route_failure';
  else
    raise notice '0011 §1.3 ck_event_inbox_route_failure 已存在，跳过';
  end if;

  -- 1.4 route_attempts 非负；业务对象定位必须成对（有类型没 ID 或反过来都拒绝）。
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_event_inbox_route_attempts'
                    and c.conrelid = 'recruitment.event_inbox'::regclass) then
    alter table recruitment.event_inbox
      add constraint ck_event_inbox_route_attempts check (route_attempts >= 0);
    raise notice '0011 §1.4 已加 ck_event_inbox_route_attempts';
  else
    raise notice '0011 §1.4 ck_event_inbox_route_attempts 已存在，跳过';
  end if;

  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_event_inbox_business_object'
                    and c.conrelid = 'recruitment.event_inbox'::regclass) then
    alter table recruitment.event_inbox
      add constraint ck_event_inbox_business_object check (
        (business_object_type is null and business_object_id is null)
        or (business_object_type is not null and business_object_id is not null
            and length(btrim(business_object_id)) > 0));
    raise notice '0011 §1.5 已加 ck_event_inbox_business_object';
  else
    raise notice '0011 §1.5 ck_event_inbox_business_object 已存在，跳过';
  end if;

  -- 1.6 业务对象类型是**招聘领域**的封闭集合；语义准入事件可以没有业务对象，
  --     但不能编造一个类型。新增类型必须改这里（一次迁移一条 CHECK）。
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_event_inbox_business_object_type'
                    and c.conrelid = 'recruitment.event_inbox'::regclass) then
    alter table recruitment.event_inbox
      add constraint ck_event_inbox_business_object_type check (
        business_object_type is null or business_object_type in
          ('APPLICATION', 'INTERVIEW', 'TRANSCRIPT_ARTIFACT', 'INTAKE_RECORD',
           'JOB', 'CANDIDATE'));
    raise notice '0011 §1.6 已加 ck_event_inbox_business_object_type';
  else
    raise notice '0011 §1.6 ck_event_inbox_business_object_type 已存在，跳过';
  end if;
end $$;

-- 1.7 同一 provider 事件 ID 在库层唯一（只对拿得到 provider_event_id 的事件）。
--     0001 的 `uq_event_inbox_idempotency` 保护的是调用方算出的幂等键；这一条
--     保护的是**来源侧的事实 ID**。两者是不同防线，不能互相代替。
create unique index if not exists uq_event_inbox_provider_event
  on recruitment.event_inbox (tenant_id, provider, provider_event_id)
  where provider_event_id is not null;

-- 1.8 事件分发扫描：按 (tenant, dispatch_state, received_at) 取待路由事件。
create index if not exists ix_event_inbox_dispatch
  on recruitment.event_inbox (tenant_id, dispatch_state, received_at);

-- 1.9 扩展 event_inbox 的列级不可变白名单。
--
-- ⚠️ 这一条**必须**和 §1 的列同时存在，否则上面几列永远写不进去：
--     0001 §9.3 给 event_inbox 装了 `trg_event_inbox_immutable`，白名单**只有**
--     `processed_at` —— 任何对 dispatch_state / routed_at 的 UPDATE 都会被
--     `IMMUTABLE_COLUMN` 拒绝，测试里也不会暴露（要 UPDATE 才发现）。
--     这里只把"运行时投影列"加进白名单，事件本身（provider / payload /
--     idempotency / trust_level / occurred_at ...）仍然不可改。
--     没有把 `updated_at` 放进白名单：路由投影的写入不需要伪造事件更新时间。
do $$
begin
  if exists (
    select 1 from pg_trigger g
      join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'recruitment' and c.relname = 'event_inbox'
       and g.tgname = 'trg_event_inbox_immutable' and not g.tgisinternal
  ) then
    drop trigger trg_event_inbox_immutable on recruitment.event_inbox;
  end if;
  create trigger trg_event_inbox_immutable before update on recruitment.event_inbox
    for each row execute function recruitment.fn_guard_columns(
      'processed_at', 'dispatch_state', 'routed_at', 'route_attempts',
      'route_error', 'business_object_type', 'business_object_id', 'routed_task_id');
  raise notice '0011 §1.9 已重建 trg_event_inbox_immutable（追加运行时投影列，事件主体仍不可改）';
end $$;

-- ---------------------------------------------------------------------
-- §2 business_task：唤醒指针与派发索引
-- ---------------------------------------------------------------------
alter table recruitment.business_task
  add column if not exists last_wake_event_id uuid,
  add column if not exists wake_count         integer not null default 0;

do $$
begin
  -- 2.1 唤醒计数非负；有 last_wake_event_id 必然至少唤醒过一次。
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_business_task_wake_count'
                    and c.conrelid = 'recruitment.business_task'::regclass) then
    alter table recruitment.business_task
      add constraint ck_business_task_wake_count check (
        wake_count >= 0 and (last_wake_event_id is null or wake_count >= 1));
    raise notice '0011 §2.1 已加 ck_business_task_wake_count';
  else
    raise notice '0011 §2.1 ck_business_task_wake_count 已存在，跳过';
  end if;

  -- 2.2 最近一次唤醒事件必须同租户（复合外键，禁止跨租户引用）。
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'fk_business_task_last_wake_event'
                    and c.conrelid = 'recruitment.business_task'::regclass) then
    alter table recruitment.business_task
      add constraint fk_business_task_last_wake_event
      foreign key (last_wake_event_id, tenant_id)
      references recruitment.event_inbox (event_id, tenant_id)
      on update restrict on delete restrict;
    raise notice '0011 §2.2 已加 fk_business_task_last_wake_event';
  else
    raise notice '0011 §2.2 fk_business_task_last_wake_event 已存在，跳过';
  end if;
end $$;

-- 2.3 派发扫描索引：Router 只找"现在可以跑"的任务，不扫历史终态。
--     0001 的 ix_business_task_dispatch 是 (tenant, status, next_run_at)，
--     这里补 priority / created_at 的稳定排序，避免同一 next_run_at 下顺序抖动。
create index if not exists ix_business_task_claim
  on recruitment.business_task (tenant_id, priority, next_run_at, created_at)
  where status in ('PENDING', 'READY', 'RETRY_WAIT');

do $$
begin
  -- 2.4 event → task 的可读链接：重复事件到达时不用猜"这次该唤醒谁"，
  --     也让它成为"同一事件只落一个 Task"的直接证据（配合 uq_task_wakeup_event）。
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'fk_event_inbox_routed_task'
                    and c.conrelid = 'recruitment.event_inbox'::regclass) then
    alter table recruitment.event_inbox
      add constraint fk_event_inbox_routed_task
      foreign key (routed_task_id, tenant_id)
      references recruitment.business_task (id, tenant_id)
      on update restrict on delete restrict;
    raise notice '0011 §2.4 已加 fk_event_inbox_routed_task';
  else
    raise notice '0011 §2.4 fk_event_inbox_routed_task 已存在，跳过';
  end if;

  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_event_inbox_routed_task'
                    and c.conrelid = 'recruitment.event_inbox'::regclass) then
    alter table recruitment.event_inbox
      add constraint ck_event_inbox_routed_task check (
        routed_task_id is null or dispatch_state = 'ROUTED');
    raise notice '0011 §2.5 已加 ck_event_inbox_routed_task';
  else
    raise notice '0011 §2.5 ck_event_inbox_routed_task 已存在，跳过';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- §3 task_wakeup：事件唤醒事实表
--
--   为什么必须是独立表（不能用 business_task 的列代替）：
--     * 一个 Task 可以被多条事件唤醒；只存"最近一条"就丢了唤醒历史，
--       无法回答"同一事件重复到达时到底有没有重复唤醒"；
--     * (task_id, event_id) 唯一 = 库层保证**同一事件对同一任务只唤醒一次**，
--       与 memory 里的去重集合无关，进程重启后依然成立（Notion §10 幂等）。
--   为什么没有 status 列：唤醒是**不可变事实**（发生即历史），不是状态机；
--     STRUCT-04/05 不适用，故也不套 fn_row_guard（没有 UPDATE 路径）。
-- ---------------------------------------------------------------------
create table if not exists recruitment.task_wakeup (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references recruitment.organization (id),
  task_id      uuid not null,
  event_id     uuid not null,
  wake_seq     integer not null,
  wake_reason  text not null default 'EVENT',
  created_at   timestamptz not null default now(),
  constraint uq_task_wakeup_id_tenant unique (id, tenant_id),
  -- 同一 Task 的同一事件只能唤醒一次（跨进程、跨重启都成立）
  constraint uq_task_wakeup_event unique (task_id, event_id),
  -- 唤醒序号在 Task 内严格递增，便于按序重放
  constraint uq_task_wakeup_seq unique (task_id, wake_seq),
  constraint fk_task_wakeup_task foreign key (task_id, tenant_id)
    references recruitment.business_task (id, tenant_id),
  constraint fk_task_wakeup_event foreign key (event_id, tenant_id)
    references recruitment.event_inbox (event_id, tenant_id),
  constraint ck_task_wakeup_seq check (wake_seq >= 1),
  constraint ck_task_wakeup_reason check (
    wake_reason in ('EVENT', 'RETRY', 'RECOVERY', 'MANUAL'))
);

create index if not exists ix_task_wakeup_task
  on recruitment.task_wakeup (tenant_id, task_id, created_at);

do $$
begin
  if not exists (
    select 1 from pg_trigger g
      join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'recruitment' and c.relname = 'task_wakeup'
       and g.tgname = 'trg_task_wakeup_no_delete' and not g.tgisinternal
  ) then
    create trigger trg_task_wakeup_no_delete
      before delete on recruitment.task_wakeup
      for each row execute function recruitment.fn_block_delete();
    raise notice '0011 §3 已加 trg_task_wakeup_no_delete';
  else
    raise notice '0011 §3 trg_task_wakeup_no_delete 已存在，跳过';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- §4 agent_session：真实 runtime session id 与三层一致性守卫
-- ---------------------------------------------------------------------
alter table recruitment.agent_session
  add column if not exists runtime_session_id text,
  add column if not exists runtime_worker_role text not null default 'WORKER',
  add column if not exists last_heartbeat_at  timestamptz;

do $$
begin
  -- 4.1 角色封闭集合：Router 自己也可能登记一个 ROUTER session，
  --     但它不承担任务身份（STRUCT 上 business_task 不引用 session）。
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_agent_session_worker_role'
                    and c.conrelid = 'recruitment.agent_session'::regclass) then
    alter table recruitment.agent_session
      add constraint ck_agent_session_worker_role check (
        runtime_worker_role in ('ROUTER', 'WORKER'));
    raise notice '0011 §4.1 已加 ck_agent_session_worker_role';
  else
    raise notice '0011 §4.1 ck_agent_session_worker_role 已存在，跳过';
  end if;

  -- 4.2 runtime_session_id 要么为空（尚未创建/无法创建），要么是非空文本。
  --     空字符串是"看起来有、其实没有"的静默错误，直接拒绝。
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'ck_agent_session_runtime_id'
                    and c.conrelid = 'recruitment.agent_session'::regclass) then
    alter table recruitment.agent_session
      add constraint ck_agent_session_runtime_id check (
        runtime_session_id is null or length(btrim(runtime_session_id)) > 0);
    raise notice '0011 §4.2 已加 ck_agent_session_runtime_id';
  else
    raise notice '0011 §4.2 ck_agent_session_runtime_id 已存在，跳过';
  end if;
end $$;

-- 4.3 真实 runtime session 的定位索引：同一 runtime 下 session id 唯一。
--     一个 DSH Session 只能对应一行 Agent Session —— 否则"可替换上下文"会变成
--     "一个会话被多个 Attempt 同时认领"，无法判断结果属于哪次执行。
create unique index if not exists uq_agent_session_runtime
  on recruitment.agent_session (tenant_id, runtime_kind, runtime_session_id)
  where runtime_session_id is not null;

create index if not exists ix_agent_session_attempt
  on recruitment.agent_session (tenant_id, attempt_id)
  where attempt_id is not null;

create index if not exists ix_agent_session_task
  on recruitment.agent_session (tenant_id, task_id)
  where task_id is not null;

-- 4.4 三层身份一致性守卫：
--     * attempt 存在 → task_id 必须存在；
--     * attempt.task_id 必须等于 session.task_id（禁止 Session 认领别人的 Attempt）；
--     * ROUTER 角色的 session 不允许挂 attempt（Router 不承担任务执行身份）。
--     触发器只拒绝**不一致**，不替应用补值；错误码 23514 与其它 CHECK 一致。
create or replace function recruitment.fn_agent_session_identity_guard() returns trigger
language plpgsql as $$
declare
  v_attempt_task uuid;
begin
  if new.attempt_id is not null then
    if new.runtime_worker_role <> 'WORKER' then
      raise exception 'AGENT_SESSION_ROLE_MISMATCH: 只有 WORKER 角色的 Session 可以挂 attempt_id'
        using errcode = '23514';
    end if;
    if new.task_id is null then
      raise exception 'AGENT_SESSION_TASK_REQUIRED: 挂了 attempt_id 的 Session 必须有 task_id'
        using errcode = '23514';
    end if;
    select a.task_id into v_attempt_task
      from recruitment.task_attempt a
     where a.id = new.attempt_id and a.tenant_id = new.tenant_id;
    if v_attempt_task is null then
      raise exception 'AGENT_SESSION_ATTEMPT_NOT_FOUND: attempt_id % 不存在或不属于该租户', new.attempt_id
        using errcode = '23514';
    end if;
    if v_attempt_task <> new.task_id then
      raise exception 'AGENT_SESSION_TASK_ATTEMPT_MISMATCH: Session(task=%) 与 Attempt(task=%) 不属于同一业务任务',
        new.task_id, v_attempt_task
        using errcode = '23514';
    end if;
  elsif new.task_id is not null and new.runtime_worker_role = 'ROUTER' then
    -- Router 会话可以引用 Task 作为"正在协调哪个任务"，但不承担执行身份；
    -- 这里不禁止，只禁止它挂 attempt（上面的分支已覆盖）。保留显式分支是为了
    -- 让后来读代码的人看到这条边界是**被想过**的，不是漏掉。
    null;
  end if;
  return new;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_trigger g
      join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'recruitment' and c.relname = 'agent_session'
       and g.tgname = 'trg_agent_session_identity_guard' and not g.tgisinternal
  ) then
    create trigger trg_agent_session_identity_guard
      before insert or update of task_id, attempt_id, runtime_worker_role
      on recruitment.agent_session
      for each row execute function recruitment.fn_agent_session_identity_guard();
    raise notice '0011 §4.4 已加 trg_agent_session_identity_guard';
  else
    raise notice '0011 §4.4 trg_agent_session_identity_guard 已存在，跳过';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- §5 task_attempt：租约回收索引
-- ---------------------------------------------------------------------
-- 重启后按 lease_expires_at 扫"失联 Attempt"，只扫 CLAIMED/RUNNING 两个活跃状态。
-- 没有这条部分索引，恢复流程会退化成全表扫描，且和 0001 的
-- uq_task_attempt_active_lease（task_id 维度）不是同一种查询。
create index if not exists ix_task_attempt_lease_reclaim
  on recruitment.task_attempt (tenant_id, lease_expires_at)
  where status in ('CLAIMED', 'RUNNING');

-- ---------------------------------------------------------------------
-- §6 自检：所有对象真实存在，形态符合预期
-- ---------------------------------------------------------------------
do $$
declare
  v_n integer;
  v_col text;
begin
  -- 6.1 event_inbox 新增列 + 部分唯一索引
  select string_agg(a.attname, ', ' order by a.attname) into v_col
    from pg_attribute a
   where a.attrelid = 'recruitment.event_inbox'::regclass
     and a.attname in ('dispatch_state', 'routed_at', 'route_attempts', 'route_error',
                       'business_object_type', 'business_object_id', 'routed_task_id')
     and a.attnum > 0 and not a.attisdropped;
  if v_col is null
     or (select count(*) from pg_attribute a
          where a.attrelid = 'recruitment.event_inbox'::regclass
            and a.attname in ('dispatch_state', 'routed_at', 'route_attempts', 'route_error',
                              'business_object_type', 'business_object_id', 'routed_task_id')
            and a.attnum > 0 and not a.attisdropped) <> 7 then
    raise exception '0011 POST-CHECK 失败 §1：event_inbox 新增列不齐（实际：%）', coalesce(v_col, '无');
  end if;

  select count(*) into v_n
    from pg_index i join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'recruitment' and c.relname = 'event_inbox'
     and i.indisunique and i.indpred is not null
     and pg_get_indexdef(i.indexrelid) like '%provider_event_id%';
  if v_n <> 1 then
    raise exception '0011 POST-CHECK 失败 §1.7：uq_event_inbox_provider_event 不存在（% / 1）', v_n;
  end if;

  -- 6.2 business_task 唤醒列
  select count(*) into v_n
    from pg_attribute a
   where a.attrelid = 'recruitment.business_task'::regclass
     and a.attname in ('last_wake_event_id', 'wake_count')
     and a.attnum > 0 and not a.attisdropped;
  if v_n <> 2 then
    raise exception '0011 POST-CHECK 失败 §2：business_task 唤醒列不齐（% / 2）', v_n;
  end if;

  -- 6.3 task_wakeup 表 + 唯一约束（同一事件只唤醒一次）
  if to_regclass('recruitment.task_wakeup') is null then
    raise exception '0011 POST-CHECK 失败 §3：task_wakeup 不存在';
  end if;
  select count(*) into v_n
    from pg_constraint c
   where c.conrelid = 'recruitment.task_wakeup'::regclass
     and c.conname = 'uq_task_wakeup_event' and c.contype = 'u';
  if v_n <> 1 then
    raise exception '0011 POST-CHECK 失败 §3：uq_task_wakeup_event 不存在';
  end if;

  -- 6.4 agent_session 真实 session id + 一致性触发器
  select count(*) into v_n
    from pg_attribute a
   where a.attrelid = 'recruitment.agent_session'::regclass
     and a.attname in ('runtime_session_id', 'runtime_worker_role', 'last_heartbeat_at')
     and a.attnum > 0 and not a.attisdropped;
  if v_n <> 3 then
    raise exception '0011 POST-CHECK 失败 §4：agent_session 新增列不齐（% / 3）', v_n;
  end if;
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'recruitment.agent_session'::regclass
     and g.tgname = 'trg_agent_session_identity_guard' and not g.tgisinternal;
  if v_n <> 1 then
    raise exception '0011 POST-CHECK 失败 §4.4：trg_agent_session_identity_guard 不存在';
  end if;

  -- 6.5 租约回收索引
  select count(*) into v_n
    from pg_index i join pg_class c on c.oid = i.indrelid
   where c.oid = 'recruitment.task_attempt'::regclass
     and i.indpred is not null
     and pg_get_indexdef(i.indexrelid) like '%lease_expires_at%';
  if v_n < 1 then
    raise exception '0011 POST-CHECK 失败 §5：ix_task_attempt_lease_reclaim 不存在';
  end if;

  raise notice '0011 POST-CHECK PASS 事件运行时 / 唤醒事实 / 三层身份结构已就位';
end $$;

-- ---------------------------------------------------------------------
-- §7 自登记（模板见 0010：每条迁移自己登记自己）
-- ---------------------------------------------------------------------
insert into recruitment.schema_migration (version, note) values
  ('0011_task_runtime',
   '任务运行时缺口：event_inbox dispatch 状态机 + provider event 唯一索引；business_task 唤醒指针；task_wakeup 唤醒事实；agent_session 真实 runtime session id + 三层一致性守卫；task_attempt 租约回收索引')
on conflict (version) do nothing;

commit;


-- =====================================================================
--  回滚方式（反向 DDL，需人工确认；本迁移不回填数据，回滚不丢业务数据）
--
--    drop trigger  if exists trg_agent_session_identity_guard on recruitment.agent_session;
--    drop function if exists recruitment.fn_agent_session_identity_guard();
--    drop index    if exists recruitment.ix_task_attempt_lease_reclaim;
--    drop index    if exists recruitment.ix_agent_session_attempt;
--    drop index    if exists recruitment.ix_agent_session_task;
--    drop index    if exists recruitment.uq_agent_session_runtime;
--    alter table recruitment.agent_session drop constraint if exists ck_agent_session_runtime_id;
--    alter table recruitment.agent_session drop constraint if exists ck_agent_session_worker_role;
--    alter table recruitment.agent_session drop column if exists last_heartbeat_at;
--    alter table recruitment.agent_session drop column if exists runtime_worker_role;
--    alter table recruitment.agent_session drop column if exists runtime_session_id;
--    drop table    if exists recruitment.task_wakeup;
--    drop index    if exists recruitment.ix_business_task_claim;
--    alter table recruitment.business_task drop constraint if exists fk_business_task_last_wake_event;
--    alter table recruitment.business_task drop constraint if exists ck_business_task_wake_count;
--    alter table recruitment.business_task drop column if exists wake_count;
--    alter table recruitment.business_task drop column if exists last_wake_event_id;
--    drop index    if exists recruitment.ix_event_inbox_dispatch;
--    drop index    if exists recruitment.uq_event_inbox_provider_event;
--    alter table recruitment.event_inbox drop constraint if exists ck_event_inbox_business_object_type;
--    alter table recruitment.event_inbox drop constraint if exists ck_event_inbox_business_object;
--    alter table recruitment.event_inbox drop constraint if exists ck_event_inbox_route_attempts;
--    alter table recruitment.event_inbox drop constraint if exists ck_event_inbox_route_failure;
--    alter table recruitment.event_inbox drop constraint if exists ck_event_inbox_dispatch_recorded;
--    alter table recruitment.event_inbox drop constraint if exists ck_event_inbox_dispatch_state;
--    alter table recruitment.event_inbox drop column if exists business_object_id;
--    alter table recruitment.event_inbox drop column if exists business_object_type;
--    alter table recruitment.event_inbox drop column if exists route_error;
--    alter table recruitment.event_inbox drop column if exists route_attempts;
--    alter table recruitment.event_inbox drop column if exists routed_at;
--    alter table recruitment.event_inbox drop column if exists dispatch_state;
--    delete from recruitment.schema_migration where version = '0011_task_runtime';
--
--  ⚠️ 回滚会重新打开：同一 provider 事件可重复入库、事件无路由状态、
--     Task 被同一事件重复唤醒、Session 无法对回真实 DSH 会话、
--     Session 可认领别的 Task 的 Attempt。这是**退回**，不是清理。
-- =====================================================================

