-- =====================================================================
--  recruitment-agent · 0015_runtime_cutover.sql
--
--  主题：**历史事件的 cutover 水位**（runtime watermark）。开启事件运行时之前，
--  必须先回答"库里已有的历史事件算不算新事件"。本迁移把这个回答变成**数据库里
--  的一行有审计的事实**，而不是"记得别 tick 太快"这种口头约定。
--
--  ── 为什么必须做（迁移前实测，ra_s6s7，2026-11-14 19:50 +08）──────────
--    * `event_inbox` 共 117 行：76 RECEIVED / 40 IGNORED / 1 ROUTED。
--    * 其中 51 条 RECEIVED 是 0001 `fn_row_guard` 写的**状态审计内部事件**
--      （normalizer_version='schema/0001'），`store.listPendingEvents` 本来就
--      排除它们 —— 它们不是"会被派发"的积压。
--    * 真正会被 tick 取到的积压是 **25 条**：22 条 `resume.intake.received`
--      （intake/1.0.0，真实业务事实）+ 3 条 `decision.record`
--      （schema/evaluation-2.0.0）。
--    * 40 条已 IGNORED 是 tick 已经跑过的痕迹（route_error 全部是
--      `SEMANTIC_GATE_REJECTED`），证明"tick 会被跑"不是假设。
--    * 这 25 条**没有天然的时间断点**：received_at 从 2026-11-13 01:36 连续到
--      2026-11-14 19:49，中间没有空闲间隔。所以"历史"不能靠猜时间窗，必须由
--      一次**显式声明**的 cutover 决定。
--
--  ── 政策（本迁移 + `contracts/runtime/runtime-cutover.md` 的权威表述）────
--    1. 水位是**每个租户一行**的 `cutover_at`；判定列是
--       `event_inbox.received_at`（**库生成的服务端事实**，不是事件 payload 里的
--       `occurred_at` —— 后者外部可伪造，用外部时间做 cutover 等于让外部决定
--       "我要不要被派发"）。
--    2. `received_at < cutover_at` → tick **不派发**，只把 dispatch 投影标成
--       `IGNORED`，原因 `BEFORE_RUNTIME_CUTOVER: ...`。不建 Task、不写 wakeup、
--       不入队副作用。事件主体（payload/幂等键/occurred_at/trust）一行不改。
--    3. `received_at >= cutover_at` → 正常派发（与迁移前的语义一致）。
--    4. 默认值**安全优先**：迁移应用时刻 = 存量租户的 cutover；之后新建的
--       组织由触发器在**创建时刻**补一行。缺水位行 = fail closed（运行时抛
--       `CUTOVER_WATERMARK_MISSING`，不猜一个"现在"）。
--       "宁可漏处理，不可重复处理"：漏处理的补救是显式、可审计的回退水位。
--    5. 水位**只能前进**；把它改小必须走
--       `recruitment.fn_runtime_watermark_rewind(tenant, cutover_at, reason)`，
--       该路径要求 (a) 事务里能确定 actor、(b) 非空理由、(c) 显式 ack，
--       并且**由触发器**写一行 `runtime_watermark_change`（REWIND）。直接
--       `update ... set cutover_at = <更早>` 会被 `WATERMARK_REWIND_FORBIDDEN` 拒绝。
--    6. 每次变更（初始化 / 前进 / 回退）都由 AFTER 触发器写审计行；审计表
--       禁删 + 整行不可改。水位行本身禁删。
--
--  ── 为什么是 watermark，不是"清空旧事件"或"按 dispatch_state 判断" ──────
--    * **不能删/清空旧事件**：`event_inbox` 是历史事实（0001 的 no-delete +
--      列级不可变白名单），删除会破坏"事件事实不可变"这条地基；而且 22 条
--      intake 事件对应的业务对象已经存在，删除只会让"为什么没派发"无法解释。
--    * **不能只按 dispatch_state='RECEIVED' 判断**：RECEIVED 也包含"运行时上线
--      之后新到、还没来得及处理"的事件 —— 那正是不该被 cutover 吞掉的。
--      状态不携带时间语义，水位携带。
--    * **不能放插件配置（cordis.patch.yml）**：配置是部署期静态值，落在进程里，
--      改它没有 DB 审计、也无法与"这个租户库里到底有哪些事件"对齐；两个租户
--      不同 cutover 时更是一份配置塞不下。水位是**数据**，不是开关。
--    * **不能"开 tick 前手动跑一次 SQL 把 25 条改成 IGNORED"**：那是一次性
--      操作，运行时上线后新到的历史事件（回填/导入）仍会重复；水位是**每次
--      tick 都重新读取**的持续约束。
--
--  ── 本迁移**不做**什么（写下来防止越界）────────────────────────────
--    * **不 UPDATE 任何 event_inbox 行**：本文件只建水位结构与存量租户的初始
--      水位。把历史事件标成 IGNORED 是 tick 的职责（运行时读水位后批量扫，
--      且只改 dispatch 投影列）。POST-CHECK 明确断言迁移后
--      `BEFORE_RUNTIME_CUTOVER` 行数为 0。
--    * 不碰 `src/runtime/routing.ts`（事件名映射是另一条 lane 的范围）。
--    * 不种任何业务数据。
--
--  ── 幂等 ────────────────────────────────────────────────────────────
--    `create table if not exists` / `create or replace function` /
--    `drop trigger if exists` + `create trigger` / 约束先查 pg_constraint 再建 /
--    存量回填 `on conflict (tenant_id) do nothing`。连跑两遍零 ERROR、零新增行。
--
--  依赖：0001（organization/actor/event_inbox）、0010（迁移台账，可缺省）。
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0015_runtime_cutover.sql
--        不要加 -1（本文件自带 begin/commit）。
-- =====================================================================

begin;


-- =====================================================================
--  §1  水位表：每个租户一行
--
--  为什么主键是 id 而不是 tenant_id：`db/verify.sql` STRUCT-01 要求每张表
--  单列 uuid 主键且列名 ∈ {id, event_id}，业务唯一键另开 UNIQUE。这里照做：
--  `uq_runtime_watermark_tenant (tenant_id)` 才是真正的业务键。
--
--  为什么没有 `status` 列：水位不是状态机（没有"待生效/生效中"），只有"此刻的
--  分界线"；历史全部在 change 表。所以不套 fn_row_guard（那要求状态迁移列并向
--  event_inbox 写审计事件），守卫语义见 §3 的专用函数。
-- =====================================================================

create table if not exists recruitment.runtime_watermark (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references recruitment.organization (id),
  -- 此时间**之前**（received_at < cutover_at）的事件不派发。
  cutover_at         timestamptz not null,
  -- 人可读理由（为什么定在这个时刻）。空理由不允许：水位变更必须能解释。
  reason             text        not null,
  -- 最后一次显式设置者（系统初始化时为 null，表示"由迁移/触发器按默认策略建立"）。
  set_by_actor_id    uuid,
  record_version     integer     not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_runtime_watermark_tenant unique (tenant_id),
  constraint uq_runtime_watermark_id_tenant unique (id, tenant_id),
  constraint ck_runtime_watermark_reason check (
    length(btrim(reason)) between 1 and 2000),
  constraint ck_runtime_watermark_record_version check (record_version >= 1),
  -- 复合外键把 set_by_actor_id 钉在本租户（STRUCT-07：复合外键必须含 tenant_id）
  constraint fk_runtime_watermark_set_by
    foreign key (set_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id)
    on update restrict on delete restrict
);

comment on table recruitment.runtime_watermark is
  '事件运行时启动水位（cutover）：received_at < cutover_at 的事件不派发，只标 IGNORED(BEFORE_RUNTIME_CUTOVER)。每租户一行，只进不退，变更全部写 runtime_watermark_change。';

comment on column recruitment.runtime_watermark.cutover_at is
  '分界线时间（服务端 received_at 语义）。默认 = 迁移应用时刻 / 组织创建时刻；改小必须走 fn_runtime_watermark_rewind。';

create index if not exists ix_runtime_watermark_cutover
  on recruitment.runtime_watermark (cutover_at);


-- =====================================================================
--  §2  水位变更审计表（append-only）
--
--  为什么审计单独成表而不是只留水位行的 updated_at：
--    * "什么时候从哪天退到了哪天、谁批的、为什么"是一次决策，不是当前值；
--      只留当前值等于把决策历史抹掉，正是 R5/根因 C 反复出现的问题；
--    * 审计表禁删 + 不可改（§3），水位行可以继续被"前进"，两者生命周期不同。
-- =====================================================================

create table if not exists recruitment.runtime_watermark_change (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references recruitment.organization (id),
  watermark_id        uuid        not null,
  old_cutover_at      timestamptz,
  new_cutover_at      timestamptz not null,
  -- 列名不用 `kind`：verify.sql STRUCT-04 把 `kind` 当枚举列，需要额外 CHECK 语义；
  -- 这里用 change_kind 并只接受三个值，更精确。
  change_kind         text        not null,
  reason              text        not null,
  changed_by_actor_id uuid,
  changed_at          timestamptz not null default now(),
  constraint uq_runtime_watermark_change_id_tenant unique (id, tenant_id),
  constraint fk_runtime_watermark_change_watermark
    foreign key (watermark_id, tenant_id)
    references recruitment.runtime_watermark (id, tenant_id)
    on update restrict on delete restrict,
  constraint fk_runtime_watermark_change_actor
    foreign key (changed_by_actor_id, tenant_id)
    references recruitment.actor (id, tenant_id)
    on update restrict on delete restrict,
  constraint ck_runtime_watermark_change_kind check (
    change_kind in ('INSERT', 'FORWARD', 'REWIND')),
  constraint ck_runtime_watermark_change_reason check (
    length(btrim(reason)) between 1 and 2000),
  -- 方向必须自洽：INSERT 无 old；FORWARD 严格变大；REWIND 严格变小。
  -- 不允许 "方向写 FORWARD 但值变小" 这种自欺的审计行。
  constraint ck_runtime_watermark_change_direction check (
    (change_kind = 'INSERT' and old_cutover_at is null)
    or (change_kind = 'FORWARD' and old_cutover_at is not null
        and new_cutover_at > old_cutover_at)
    or (change_kind = 'REWIND' and old_cutover_at is not null
        and new_cutover_at < old_cutover_at))
);

comment on table recruitment.runtime_watermark_change is
  '水位变更审计（append-only）：INSERT/FORWARD/REWIND 每次一行，含旧值、新值、理由、actor。禁删、禁改。';

create index if not exists ix_runtime_watermark_change_tenant
  on recruitment.runtime_watermark_change (tenant_id, changed_at desc);
create index if not exists ix_runtime_watermark_change_watermark
  on recruitment.runtime_watermark_change (watermark_id, changed_at desc);


-- =====================================================================
--  §3  守卫与审计触发器函数
-- =====================================================================

-- 3.1 当前 actor（水位变更必须能确定责任人；与 0001 fn_row_guard 同一判据）
create or replace function recruitment.fn_runtime_watermark_actor(p_tenant_id uuid)
returns uuid
language plpgsql stable as $$
declare
  v_actor uuid := nullif(current_setting('recruitment.actor_id', true), '')::uuid;
begin
  if v_actor is null then
    raise exception
      'ACTOR_REQUIRED: 水位变更必须给出 actor（事务里 SET LOCAL recruitment.actor_id）'
      using errcode = '23514';
  end if;
  if not exists (select 1 from recruitment.actor a
                  where a.id = v_actor and a.tenant_id = p_tenant_id) then
    raise exception 'ACTOR_TENANT_MISMATCH: actor % 不存在或不属于该租户', v_actor
      using errcode = '23503';
  end if;
  return v_actor;
end $$;

comment on function recruitment.fn_runtime_watermark_actor(uuid) is
  '水位写入前的 actor 判据：必须由调用事务 SET LOCAL 提供，且属于该租户。系统初始化（迁移/组织创建触发器）走 INSERT，不经过这里。';

-- 3.2 BEFORE UPDATE：不可变列 + 只进不退 + 未来值拒绝 + 版本自增
create or replace function recruitment.fn_runtime_watermark_guard()
returns trigger
language plpgsql as $$
declare
  v_ack   text;
  v_actor uuid;
begin
  -- id / tenant_id 是身份，不是可调参数
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id then
    raise exception
      'IMMUTABLE_COLUMN: runtime_watermark 的 id / tenant_id 不允许修改'
      using errcode = '23514';
  end if;

  -- 没有实际变化的 UPDATE 一律拒绝：避免"看起来调过水位"的假审计
  if new.cutover_at is not distinct from old.cutover_at then
    raise exception
      'WATERMARK_NOOP: 水位更新必须真正改变 cutover_at（只改 reason 会造成"调整过水位"的误读）'
      using errcode = '23514';
  end if;

  -- 未来水位会把"现在到达的新事件"也吞掉：允许它等于显式关闭运行时。拒绝并给出方向。
  if new.cutover_at > now() then
    raise exception
      'WATERMARK_IN_FUTURE: cutover_at(%) 不能晚于数据库当前时间（要停运行时请关 runtime.enabled，不要用未来水位代替）',
      new.cutover_at
      using errcode = '23514';
  end if;

  if length(btrim(new.reason)) = 0 then
    raise exception 'WATERMARK_REASON_REQUIRED: 水位变更必须给出非空理由'
      using errcode = '23514';
  end if;

  -- 每次 UPDATE 都需要 actor（forward 也要：前进同样是决策）
  v_actor := recruitment.fn_runtime_watermark_actor(new.tenant_id);

  -- 只进不退：变小必须经 fn_runtime_watermark_rewind（它会在本事务里设 ack）。
  if new.cutover_at < old.cutover_at then
    v_ack := nullif(current_setting('recruitment.watermark_rewind_ack', true), '');
    if v_ack is distinct from 'ALLOW' then
      raise exception
        'WATERMARK_REWIND_FORBIDDEN: 水位只能前进（% → %）。把水位改小会让更多历史事件被重新派发，必须走 recruitment.fn_runtime_watermark_rewind(tenant, cutover_at, reason) 并留下 REWIND 审计行',
        old.cutover_at, new.cutover_at
        using errcode = '23514';
    end if;
  end if;

  new.set_by_actor_id := v_actor;
  new.updated_at      := now();
  new.record_version  := old.record_version + 1;
  return new;
end $$;

comment on function recruitment.fn_runtime_watermark_guard() is
  'runtime_watermark 的 BEFORE UPDATE 守卫：身份列不可改、只进不退、拒绝未来水位、必须给 actor/理由；回退只允许在 fn_runtime_watermark_rewind 设置的 ack 下发生。';

-- 3.3 AFTER INSERT/UPDATE：写审计行（触发，不依赖调用方自觉）
create or replace function recruitment.fn_runtime_watermark_audit()
returns trigger
language plpgsql as $$
declare
  v_kind  text;
  v_actor uuid := nullif(current_setting('recruitment.actor_id', true), '')::uuid;
begin
  if tg_op = 'INSERT' then
    v_kind := 'INSERT';
  elsif new.cutover_at < old.cutover_at then
    v_kind := 'REWIND';
  else
    v_kind := 'FORWARD';
  end if;

  -- 系统初始化（迁移 / 组织创建触发器）时 actor GUC 可能为空或属于别的租户：
  -- 不强绑一个假 actor，宁可记 null（"系统按默认策略建立"）。UPDATE 路径已由
  -- §3.2 强制 actor 存在且属于本租户，不会被这里静默降级。
  if v_actor is not null and not exists (
    select 1 from recruitment.actor a
     where a.id = v_actor and a.tenant_id = new.tenant_id
  ) then
    v_actor := null;
  end if;

  insert into recruitment.runtime_watermark_change (
    tenant_id, watermark_id, old_cutover_at, new_cutover_at,
    change_kind, reason, changed_by_actor_id, changed_at
  ) values (
    new.tenant_id,
    new.id,
    case when tg_op = 'UPDATE' then old.cutover_at else null end,
    new.cutover_at,
    v_kind,
    new.reason,
    v_actor,
    now()
  );
  return null;
end $$;

comment on function recruitment.fn_runtime_watermark_audit() is
  '水位审计触发器：任何 INSERT/UPDATE 都写一行 runtime_watermark_change；方向由新旧值自动判定，调用方无法"自称"是前进还是回退。';


-- =====================================================================
--  §4  显式的写入入口（可审计、方向只能用对）
--
--  为什么既有触发器又有函数：触发器保证"任何写入路径都留痕"，函数保证"方向
--  只有三种合法动作，且回退必须由人显式发起"。两者不是二选一。
-- =====================================================================

-- 4.1 初始化（只对还没有水位的租户；已有则报错，防止用 upsert 偷偷改小）
create or replace function recruitment.fn_runtime_watermark_upsert(
  p_tenant_id  uuid,
  p_cutover_at timestamptz,
  p_reason     text
) returns recruitment.runtime_watermark
language plpgsql as $$
declare
  v_row   recruitment.runtime_watermark;
  v_actor uuid;
begin
  if p_tenant_id is null then
    raise exception 'TENANT_REQUIRED: 水位初始化必须给出 tenant_id' using errcode = '23514';
  end if;
  if p_cutover_at is null or p_cutover_at > now() then
    raise exception 'WATERMARK_IN_FUTURE: cutover_at 必须存在且不晚于 now()'
      using errcode = '23514';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'WATERMARK_REASON_REQUIRED: 水位初始化必须给出非空理由'
      using errcode = '23514';
  end if;
  if exists (select 1 from recruitment.runtime_watermark w where w.tenant_id = p_tenant_id) then
    raise exception
      'WATERMARK_EXISTS: 租户 % 已有水位；前进用 fn_runtime_watermark_forward，回退用 fn_runtime_watermark_rewind',
      p_tenant_id
      using errcode = '23514';
  end if;

  v_actor := recruitment.fn_runtime_watermark_actor(p_tenant_id);

  insert into recruitment.runtime_watermark (tenant_id, cutover_at, reason, set_by_actor_id)
  values (p_tenant_id, p_cutover_at, btrim(p_reason), v_actor)
  returning * into v_row;
  return v_row;
end $$;

-- 4.2 前进（安全方向：更容易漏处理，更难重复处理）
create or replace function recruitment.fn_runtime_watermark_forward(
  p_tenant_id  uuid,
  p_cutover_at timestamptz,
  p_reason     text
) returns recruitment.runtime_watermark
language plpgsql as $$
declare
  v_row   recruitment.runtime_watermark;
  v_actor uuid;
begin
  if p_cutover_at is null or p_cutover_at > now() then
    raise exception 'WATERMARK_IN_FUTURE: cutover_at 必须存在且不晚于 now()'
      using errcode = '23514';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'WATERMARK_REASON_REQUIRED: 水位前进必须给出非空理由'
      using errcode = '23514';
  end if;

  v_actor := recruitment.fn_runtime_watermark_actor(p_tenant_id);

  update recruitment.runtime_watermark w
     set cutover_at = p_cutover_at,
         reason     = btrim(p_reason)
   where w.tenant_id = p_tenant_id
     and w.cutover_at < p_cutover_at
  returning * into v_row;
  if v_row.id is null then
    raise exception
      'WATERMARK_NOT_FORWARD: 租户 % 没有水位，或新水位不晚于当前水位（前进必须严格变大）',
      p_tenant_id
      using errcode = '23514';
  end if;
  return v_row;
end $$;

-- 4.3 回退（危险方向：会让更多历史事件重新可派发；必须显式、带理由、留 REWIND）
--
--  为什么允许回退：cutover 默认值取"迁移应用时刻"，可能比业务上想要的边界更晚
--  （例如 22 条 intake 事件是上线前真实业务事实，业务决定要补处理）。补救必须
--  是**显式决定**，而不是让 tick 默认去重放。回退 = 人签字，不是默认行为。
create or replace function recruitment.fn_runtime_watermark_rewind(
  p_tenant_id  uuid,
  p_cutover_at timestamptz,
  p_reason     text
) returns recruitment.runtime_watermark
language plpgsql as $$
declare
  v_row   recruitment.runtime_watermark;
  v_actor uuid;
begin
  if p_cutover_at is null then
    raise exception 'WATERMARK_REQUIRED: 回退必须给出 cutover_at' using errcode = '23514';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'WATERMARK_REASON_REQUIRED: 水位回退必须给出非空理由（写进审计行）'
      using errcode = '23514';
  end if;

  v_actor := recruitment.fn_runtime_watermark_actor(p_tenant_id);

  -- ack 只在本事务内有效；下一事务想再退必须再调用本函数。
  perform set_config('recruitment.watermark_rewind_ack', 'ALLOW', true);

  update recruitment.runtime_watermark w
     set cutover_at = p_cutover_at,
         reason     = btrim(p_reason)
   where w.tenant_id = p_tenant_id
     and w.cutover_at > p_cutover_at
  returning * into v_row;

  perform set_config('recruitment.watermark_rewind_ack', '', true);

  if v_row.id is null then
    raise exception
      'WATERMARK_NOT_REWIND: 租户 % 没有水位，或新水位不早于当前水位（回退必须严格变小）',
      p_tenant_id
      using errcode = '23514';
  end if;
  return v_row;
end $$;


-- =====================================================================
--  §5  触发器挂载（删后重建 = 幂等；顺序：guard 在 audit 之前）
-- =====================================================================

drop trigger if exists trg_runtime_watermark_guard on recruitment.runtime_watermark;
create trigger trg_runtime_watermark_guard
  before update on recruitment.runtime_watermark
  for each row execute function recruitment.fn_runtime_watermark_guard();

drop trigger if exists trg_runtime_watermark_audit on recruitment.runtime_watermark;
create trigger trg_runtime_watermark_audit
  after insert or update on recruitment.runtime_watermark
  for each row execute function recruitment.fn_runtime_watermark_audit();

-- 历史事实禁删（与 0001 §9.1 同一函数；水位行被删掉 = 运行时失去分界线）
drop trigger if exists trg_runtime_watermark_no_delete on recruitment.runtime_watermark;
create trigger trg_runtime_watermark_no_delete
  before delete on recruitment.runtime_watermark
  for each row execute function recruitment.fn_block_delete();

-- 审计表禁删 + 整行不可改（append-only）
drop trigger if exists trg_runtime_watermark_change_no_delete on recruitment.runtime_watermark_change;
create trigger trg_runtime_watermark_change_no_delete
  before delete on recruitment.runtime_watermark_change
  for each row execute function recruitment.fn_block_delete();

drop trigger if exists trg_runtime_watermark_change_immutable on recruitment.runtime_watermark_change;
create trigger trg_runtime_watermark_change_immutable
  before update on recruitment.runtime_watermark_change
  for each row execute function recruitment.fn_guard_columns();

-- 5.5 新组织自动获得水位 = 创建时刻。
--
--  为什么用触发器而不是"运行时发现没有水位就补一行 now()"：
--    * 运行时补默认值会让"没有水位"这种配置缺口**静默消失**，而它恰好意味着
--      "这个租户的事件边界从未被声明过"；
--    * 组织创建时刻就是它能收到任何事件之前的**下界**，语义上严格正确；
--    * 触发器在同一个事务里完成，不会出现"组织已存在但水位缺失"的中间态。
create or replace function recruitment.fn_runtime_watermark_bootstrap()
returns trigger
language plpgsql as $$
begin
  insert into recruitment.runtime_watermark (tenant_id, cutover_at, reason, set_by_actor_id)
  values (
    new.id,
    now(),
    'BOOTSTRAP: organization created; runtime cutover = organization creation time (events received earlier are never dispatched)',
    null
  )
  on conflict (tenant_id) do nothing;
  return null;
end $$;

comment on function recruitment.fn_runtime_watermark_bootstrap() is
  '新建组织时自动建立水位（= 创建时刻），保证"每个租户都有声明过的边界"；已有水位不覆盖。';

drop trigger if exists trg_organization_runtime_watermark on recruitment.organization;
create trigger trg_organization_runtime_watermark
  after insert on recruitment.organization
  for each row execute function recruitment.fn_runtime_watermark_bootstrap();


-- =====================================================================
--  §6  存量租户回填：cutover = 迁移应用时刻（安全默认）
--
--  为什么是 now() 而不是 max(received_at)：
--    * max(received_at) 会让"最新的那批积压"仍被判为新事件（等于没 cutover）；
--    * now() 声明的是"迁移之前的任何事件都不再是运行时可信窗口内的新输入"。
--      想补处理其中一部分，走 §4.3 的回退（显式、审计、逐租户）。
--  为什么不是 created_at：水位语义是"运行时被信任的时刻"，不是"租户诞生时刻"。
-- =====================================================================

insert into recruitment.runtime_watermark (tenant_id, cutover_at, reason, set_by_actor_id)
select o.id,
       now(),
       'BOOTSTRAP 0015: runtime cutover = migration apply time; every event already in event_inbox is history and is never dispatched (no task, no side effect)',
       null
  from recruitment.organization o
on conflict (tenant_id) do nothing;


-- =====================================================================
--  §7  迁移后自检（不满足即整个迁移失败）
-- =====================================================================
do $$
declare
  v_n       integer;
  v_org     integer;
  v_wm      integer;
  v_cut     timestamptz;
  v_wid     uuid;
  v_tenant  uuid;
  v_actor   uuid;
  v_changed integer;
begin
  -- 7.1 两张表都在
  if to_regclass('recruitment.runtime_watermark') is null
     or to_regclass('recruitment.runtime_watermark_change') is null then
    raise exception '0015 POST-CHECK 失败：水位表或审计表不存在';
  end if;

  -- 7.2 每个组织恰好一行水位；没有孤儿审计行
  select count(*) into v_org from recruitment.organization;
  select count(*) into v_wm  from recruitment.runtime_watermark;
  if v_org <> v_wm then
    raise exception '0015 POST-CHECK 失败：组织 % 行但水位 % 行（必须一一对应）', v_org, v_wm;
  end if;

  select count(*) into v_n
    from recruitment.runtime_watermark w
   where not exists (select 1 from recruitment.runtime_watermark_change c
                      where c.watermark_id = w.id and c.change_kind = 'INSERT');
  if v_n <> 0 then
    raise exception '0015 POST-CHECK 失败：% 行水位没有 INSERT 审计行（触发器没接上）', v_n;
  end if;

  select count(*) into v_n
    from recruitment.runtime_watermark_change c
   where not exists (select 1 from recruitment.runtime_watermark w where w.id = c.watermark_id);
  if v_n <> 0 then
    raise exception '0015 POST-CHECK 失败：% 行审计没有对应水位（外键/触发器异常）', v_n;
  end if;

  -- 7.3 水位不晚于当前时间，且全部到本次迁移为止没有任何 REWIND/FORWARD（刚建出来）
  select count(*) into v_n from recruitment.runtime_watermark w where w.cutover_at > now();
  if v_n <> 0 then
    raise exception '0015 POST-CHECK 失败：% 行水位晚于 now()（默认值必须安全且可解释）', v_n;
  end if;

  select count(*) into v_n
    from recruitment.runtime_watermark_change
   where change_kind in ('FORWARD', 'REWIND');
  if v_n <> 0 then
    raise exception '0015 POST-CHECK 失败：初始化不应产生 FORWARD/REWIND 审计行（实际 % 行）', v_n;
  end if;

  -- 7.4 本迁移**没有**改任何 event_inbox 行（历史事件留待 tick 按水位处理）
  select count(*) into v_n
    from recruitment.event_inbox
   where route_error like 'BEFORE_RUNTIME_CUTOVER%';
  if v_n <> 0 then
    raise exception '0015 POST-CHECK 失败：迁移不应把历史事件标成 BEFORE_RUNTIME_CUTOVER（实际 % 行，那是 tick 的职责）', v_n;
  end if;

  -- 7.5 负向：直接 UPDATE 把水位改小必须被拒（WATERMARK_REWIND_FORBIDDEN）。
  --     失败语句在子事务里回滚，不会留下一行审计。
  select w.id, w.tenant_id, w.cutover_at into v_wid, v_tenant, v_cut
    from recruitment.runtime_watermark w order by w.created_at, w.id limit 1;
  select a.id into v_actor
    from recruitment.actor a where a.tenant_id = v_tenant order by a.created_at, a.id limit 1;

  if v_actor is null then
    raise notice '0015 POST-CHECK SKIP 负向回退自检（该租户没有 actor，无法构造"能确定 actor 但方向非法"的场景）';
  else
    perform set_config('recruitment.actor_id', v_actor::text, true);
    begin
      update recruitment.runtime_watermark
         set cutover_at = v_cut - interval '1 minute',
             reason = '0015 negative self-check: must be rejected'
       where id = v_wid;
      raise exception '0015 POST-CHECK 失败：直接改小水位竟然成功（WATERMARK_REWIND_FORBIDDEN 没有生效）';
    exception
      when check_violation then
        null;  -- 期望路径：23514
    end;

    select count(*) into v_changed
      from recruitment.runtime_watermark_change
     where watermark_id = v_wid and change_kind = 'REWIND';
    if v_changed <> 0 then
      raise exception '0015 POST-CHECK 失败：被拒绝的回退竟然写了 % 行 REWIND 审计', v_changed;
    end if;
  end if;

  raise notice '0015 POST-CHECK PASS 水位表 + 审计表 + 存量回填(%) 行 + 只进不退负向自检通过', v_wm;
end $$;


-- =====================================================================
--  §8  迁移台账自登记（0010 §规则第 1 条）
-- =====================================================================
do $$
begin
  if to_regclass('recruitment.schema_migration') is not null then
    insert into recruitment.schema_migration (version, note)
    values ('0015_runtime_cutover',
            '历史事件 cutover 水位：runtime_watermark(每租户一行/只进不退) + runtime_watermark_change(append-only 审计) + 三段显式写入函数 + 组织创建自动建水位')
    on conflict (version) do nothing;
  end if;
end $$;


commit;


-- =====================================================================
--  回滚方式（本文件不写业务数据；但**水位行一旦被运行时读取过**，
--  回滚等于让"哪些事件算历史"这个决定失效，需人工确认后再执行）
--    drop trigger if exists trg_organization_runtime_watermark on recruitment.organization;
--    drop function if exists recruitment.fn_runtime_watermark_bootstrap();
--    drop trigger if exists trg_runtime_watermark_change_immutable on recruitment.runtime_watermark_change;
--    drop trigger if exists trg_runtime_watermark_change_no_delete on recruitment.runtime_watermark_change;
--    drop trigger if exists trg_runtime_watermark_no_delete on recruitment.runtime_watermark;
--    drop trigger if exists trg_runtime_watermark_audit on recruitment.runtime_watermark;
--    drop trigger if exists trg_runtime_watermark_guard on recruitment.runtime_watermark;
--    drop function if exists recruitment.fn_runtime_watermark_rewind(uuid, timestamptz, text);
--    drop function if exists recruitment.fn_runtime_watermark_forward(uuid, timestamptz, text);
--    drop function if exists recruitment.fn_runtime_watermark_upsert(uuid, timestamptz, text);
--    drop function if exists recruitment.fn_runtime_watermark_audit();
--    drop function if exists recruitment.fn_runtime_watermark_guard();
--    drop function if exists recruitment.fn_runtime_watermark_actor(uuid);
--    drop table if exists recruitment.runtime_watermark_change;
--    drop table if exists recruitment.runtime_watermark;
--    delete from recruitment.schema_migration where version = '0015_runtime_cutover';
-- =====================================================================
