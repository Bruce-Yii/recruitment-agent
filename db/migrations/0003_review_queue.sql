-- =====================================================================
--  recruitment-agent · 0003_review_queue.sql
--  ② 可观测层 + ④ 人工兜底队列（doc 12 的第 ② 层与第 ④ 层）
--
--  权威来源：
--    docs/12-layer-acceptance.md（= work/handoff/12-layer-acceptance.md）
--      §2② 可观测：每次调用留痕，关掉日志仍可查（OBS-01..04）
--      §2④ 人工兜底：该入队的入队、未处理项的阻断率 100%（HUM-01..05）
--      §3   故障注入矩阵；§5③「④ 层必须验阻断，不只是验入队」
--    db/SCHEMA.md §1 全局约定（schema=recruitment / uuid 主键 / tenant_id /
--      状态迁移必须有 actor / 历史不可物理删 / 枚举用 text+CHECK / 幂等）
--    work/control/DECISIONS-2026-11-12.md D-18（actor 必须 SET LOCAL，不能 SET）
--    work/control/DECISIONS-2026-11-12.md D-36（主键列一律叫 id —— 运营表不例外；
--      本迁移原用 run_id / item_id / audit_id，按 D-36 机械改名为 id，语义零变更）
--
--  三张表分别回答三个问题：
--    conversion_run  这次调用发生了什么？      —— 每次调用一条，append-only（②）
--    review_queue    机器判不了的由谁接手？    —— 未结案即阻断下游（④）
--    review_audit    是谁、何时、为什么改的？  —— 触发器自动写，应用层无法漏记（④）
--
--  依赖：0001_init.sql（organization / actor / fn_block_delete）。
--  幂等：可重复执行（IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS）。
--  执行：psql -v ON_ERROR_STOP=1 -f db/migrations/0003_review_queue.sql
--        不要加 -1（本文件自带 begin/commit）。
--
--  不在本文件内（见 db/REVIEW-QUEUE.md §8）：① 自检规则、③ 模型换招、
--  ⑤ 告警作业与账平报表。本迁移只保证「失败能被看见」+「没处理的挡住下游」。
-- =====================================================================

begin;

-- 前置：0003 不是独立 schema，它长在 0001 的租户/身份模型上
do $$
begin
  if to_regclass('recruitment.organization') is null
     or to_regclass('recruitment.actor') is null
     or to_regprocedure('recruitment.fn_block_delete()') is null then
    raise exception
      'MIGRATION_PRECONDITION: 0003_review_queue.sql 需要先执行 0001_init.sql（organization / actor / fn_block_delete 缺失）';
  end if;
end $$;


-- =====================================================================
--  0. D-36 原地改名：run_id / item_id / audit_id → id
--
--  本文件的建表都是 CREATE TABLE IF NOT EXISTS，对「已经被旧版 0003 建过表」
--  的库不会改列名；后面的触发器/视图就会引用到不存在的列。这一段补齐升级路径：
--    * 新库：三张表还不存在 → to_regclass 为 null → 整块跳过（随后按新列名建表）
--    * 旧库：把旧主键列改名为 id；PostgreSQL 会自动把主键/唯一约束/复合外键/
--      索引/视图定义一起指到新列名，因此不需要再 ALTER CONSTRAINT
--  语义零变更：只改列名，不增删任何列、不改变任何值。
-- =====================================================================

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('conversion_run', 'run_id'),
      ('review_queue',   'item_id'),
      ('review_audit',   'audit_id')
    ) as v(tbl, old_col)
  loop
    if to_regclass('recruitment.' || r.tbl) is not null
       and exists (select 1 from pg_attribute
                    where attrelid = to_regclass('recruitment.' || r.tbl)
                      and attname = r.old_col and not attisdropped)
       and not exists (select 1 from pg_attribute
                        where attrelid = to_regclass('recruitment.' || r.tbl)
                          and attname = 'id' and not attisdropped) then
      execute format('alter table recruitment.%I rename column %I to id', r.tbl, r.old_col);
      raise notice 'D-36 原地改名：recruitment.%.% → id', r.tbl, r.old_col;
    end if;
  end loop;
end $$;


-- =====================================================================
--  0.1 本迁移用的通用函数
-- =====================================================================

-- issue_codes 只校验「不是空串、没有 NULL 元素、数量有上限」。
-- 故意不校验 code 的命名格式：doc 11 §1 要求「未知 issue code 一律按 HARD 处理」，
-- 若这里用正则把未知 code 拒掉，等于让工具的失败记录写不进库——②层最不能接受的
-- 失败模式是「没有这条」，不是「code 长得不对」。
create or replace function recruitment.fn_issue_codes_valid(p_codes text[]) returns boolean
language sql immutable as $$
  select coalesce(bool_and(c is not null and length(btrim(c)) between 1 and 64), true)
    from unnest(p_codes) as c
$$;

-- 取「本次事务的操作者」。0001 的约定是 SET LOCAL recruitment.actor_id = '<uuid>'
-- （D-18：用 SET 会被连接池泄漏给下一个请求，责任人记错是静默错误）。
create or replace function recruitment.fn_require_actor(p_tenant_id uuid) returns uuid
language plpgsql stable as $$
declare
  v_raw   text;
  v_actor uuid;
begin
  v_raw := nullif(btrim(coalesce(current_setting('recruitment.actor_id', true), '')), '');
  if v_raw is null then
    raise exception
      'ACTOR_REQUIRED: 缺少 actor —— 调用方必须先 SET LOCAL recruitment.actor_id = ''<actor uuid>''（D-18）'
      using errcode = '23514';
  end if;

  begin
    v_actor := v_raw::uuid;
  exception when invalid_text_representation then
    raise exception 'ACTOR_INVALID: recruitment.actor_id 不是合法 uuid：%', v_raw
      using errcode = '23514';
  end;

  if not exists (select 1 from recruitment.actor a
                  where a.id = v_actor and a.tenant_id = p_tenant_id) then
    raise exception 'ACTOR_TENANT_MISMATCH: actor % 不存在或不属于租户 %', v_actor, p_tenant_id
      using errcode = '23503';
  end if;
  return v_actor;
end $$;

-- ④ 层的状态机：唯一一份「哪些边允许走」的定义。
-- 只放行 8 条边，其余 28 格（含全部自环之外的跨级跳）一律拒绝。
-- 裁决理由见 db/REVIEW-QUEUE.md §5；要点：任何决策必须先有人认领（IN_REVIEW），
-- 因此 QUEUED → APPROVED / REJECTED / CORRECTED / REPROCESS 全部禁止。
create or replace function recruitment.fn_review_transition_allowed(p_from text, p_to text)
returns boolean
language sql immutable as $$
  select (p_from, p_to) in (
    ('QUEUED',    'IN_REVIEW'),
    ('IN_REVIEW', 'CORRECTED'),
    ('IN_REVIEW', 'APPROVED'),
    ('IN_REVIEW', 'REJECTED'),
    ('IN_REVIEW', 'REPROCESS'),
    ('CORRECTED', 'APPROVED'),
    ('CORRECTED', 'REJECTED'),
    ('CORRECTED', 'REPROCESS')
  )
$$;


-- =====================================================================
--  1. conversion_run · 每次转换调用一条（② 可观测层）
--
--  设计要点：
--    * append-only：同一文件跑两次 = 两条记录（OBS-02），id 不同、
--      source_sha256 相同；因此 source_sha256 上**不能**建唯一约束。
--    * 没有 RUNNING 状态：调用结束（含崩溃被监护进程补记）才写一行，
--      所以 finished_at 必填，不存在「半条记录」。
--    * 判定与完整性自洽：任何 issue 或 needs_visual 都不允许标 complete
--      （doc 11 §1 硬性；INJ-04「图像页标成 complete」在库里就过不去）。
--    * 不做物理删除、不做 UPDATE：历史不可覆盖（SCHEMA.md §1 / 不变量 2）。
-- =====================================================================

create table if not exists recruitment.conversion_run (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references recruitment.organization (id),
  source_sha256     text        not null,
  source_name       text        not null,
  converter_version text        not null,
  status            text        not null,
  completeness      text        not null,
  needs_visual      boolean     not null default false,
  issue_codes       text[]      not null default '{}'::text[],
  pages             integer     not null default 0,
  blocks            integer     not null default 0,
  elapsed_ms        integer     not null,
  started_at        timestamptz not null,
  finished_at       timestamptz not null,
  recorded_at       timestamptz not null default now(),
  result_json       jsonb,

  constraint uq_conversion_run_id_tenant unique (id, tenant_id),

  -- 文件身份：sha256 是「按文件查历史」的 join key，必须小写 64 位十六进制，
  -- 否则同一份文件会以两种写法各查各的（OBS-02 会静默漏行）。
  constraint ck_conversion_run_sha256 check (source_sha256 ~ '^[0-9a-f]{64}$'),
  -- 只存文件名（basename），不存绝对路径：路径里常含候选人姓名/目录名（R7）
  constraint ck_conversion_run_source_name check (length(btrim(source_name)) between 1 and 1024),
  constraint ck_conversion_run_converter check (length(btrim(converter_version)) between 1 and 120),

  -- ACCEPTED / QUARANTINED / FAILED 是任务书要求的三种；CRASHED 是 doc 12
  -- OBS-03 逐字要求的第四种（「强制读取器崩溃 → status=CRASHED，不是没有这条」）。
  -- 用 CHECK 而不是 PG enum：扩值只改约束，迁移可幂等重跑（SCHEMA.md §1）。
  constraint ck_conversion_run_status check (status in ('ACCEPTED','QUARANTINED','FAILED','CRASHED')),
  constraint ck_conversion_run_completeness check (completeness in ('complete','partial','unverified')),

  constraint ck_conversion_run_issue_codes check (recruitment.fn_issue_codes_valid(issue_codes)),
  constraint ck_conversion_run_pages check (pages >= 0),
  constraint ck_conversion_run_blocks check (blocks >= 0),
  -- 只约束下界：一次挂死 25 小时的调用也必须能记下来（②层不许拒收真实观测）
  constraint ck_conversion_run_elapsed check (elapsed_ms >= 0),
  constraint ck_conversion_run_time_order check (finished_at >= started_at and recorded_at >= started_at),

  constraint ck_conversion_run_result_object check (result_json is null or jsonb_typeof(result_json) = 'object'),
  -- result_json 是「摘要」不是仓库：全文属于 resume_version / intake_asset。
  -- 1 MiB 上限防这张表长成 blob 库（真实全文走对象存储，见 REVIEW-QUEUE.md §7）。
  constraint ck_conversion_run_result_size check (result_json is null or octet_length(result_json::text) <= 1048576),
  constraint ck_conversion_run_result_present check (status not in ('ACCEPTED','QUARANTINED') or result_json is not null),

  -- 判定自洽（都是「定义上不可能」，不是业务偏好）：
  constraint ck_conversion_run_complete_no_issue check (
    completeness <> 'complete' or (cardinality(issue_codes) = 0 and not needs_visual)),
  constraint ck_conversion_run_accepted_clean check (
    status <> 'ACCEPTED'
    or (completeness = 'complete' and cardinality(issue_codes) = 0 and not needs_visual)),
  constraint ck_conversion_run_failed_not_complete check (
    status not in ('FAILED','CRASHED') or completeness <> 'complete')
);

-- OBS-04 的四个查询维度各有一条索引：code / 来源 / 时间 / 状态。
-- 「按文件查历史」是最高频的一条，所以 source_sha256 单独成索引（任务书硬要求）。
create index if not exists ix_conversion_run_sha
  on recruitment.conversion_run (source_sha256, started_at desc);
create index if not exists ix_conversion_run_started
  on recruitment.conversion_run (started_at desc);
create index if not exists ix_conversion_run_status
  on recruitment.conversion_run (status, started_at desc);
create index if not exists ix_conversion_run_issue_codes
  on recruitment.conversion_run using gin (issue_codes);
create index if not exists ix_conversion_run_source_name
  on recruitment.conversion_run (source_name);
-- ⑤ 告警/巡检的入口：只扫非 ACCEPTED，不扫全表
create index if not exists ix_conversion_run_attention
  on recruitment.conversion_run (started_at desc)
  where status <> 'ACCEPTED';

-- 历史不可覆盖：整行不可 UPDATE（没有列可以改，连 status 也不行）
drop trigger if exists trg_conversion_run_immutable on recruitment.conversion_run;
create trigger trg_conversion_run_immutable
  before update on recruitment.conversion_run
  for each row execute function recruitment.fn_guard_columns();

drop trigger if exists trg_conversion_run_no_delete on recruitment.conversion_run;
create trigger trg_conversion_run_no_delete
  before delete on recruitment.conversion_run
  for each row execute function recruitment.fn_block_delete();


-- =====================================================================
--  2. review_queue · 人工兜底队列（④ 人工兜底）
--
--  设计要点：
--    * 一个 run 最多入队一次（uq_review_queue_run）：重复入队会让「入队率」
--      与「阻断率」都失真；重跑 = 新 run = 新条目。
--    * machine_result / human_result 两份都保留，机器结果永不被人工覆盖
--      （HUM-05；由 guard 触发器禁止 UPDATE）。
--    * deadline 默认 now()+24h，只能延长不能缩短（HUM-04 靠它触发升级）。
--    * closed_at 由触发器写，不接受调用方伪造。
--    * 状态机在触发器里强制（CHECK 只能管取值，管不了「从哪来」）。
-- =====================================================================

create table if not exists recruitment.review_queue (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references recruitment.organization (id),
  run_id         uuid        not null,
  status         text        not null default 'QUEUED',
  assignee       uuid,
  deadline       timestamptz not null default (now() + interval '24 hours'),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  machine_result jsonb       not null,
  human_result   jsonb,
  reason         text,
  record_version integer     not null default 1,
  updated_at     timestamptz not null default now(),

  constraint uq_review_queue_id_tenant unique (id, tenant_id),
  -- 一次失败只排队一次；REPROCESS 之后的失败是「新 run」，不是「同一条重开」
  constraint uq_review_queue_run unique (run_id),

  -- 复合外键带上 tenant_id：物理上不可能把甲租户的 run 排进乙租户的队列
  constraint fk_review_queue_run foreign key (run_id, tenant_id)
    references recruitment.conversion_run (id, tenant_id),
  constraint fk_review_queue_assignee foreign key (assignee, tenant_id)
    references recruitment.actor (id, tenant_id),

  constraint ck_review_queue_status check (
    status in ('QUEUED','IN_REVIEW','CORRECTED','APPROVED','REJECTED','REPROCESS')),

  constraint ck_review_queue_machine_result_object check (jsonb_typeof(machine_result) = 'object'),
  constraint ck_review_queue_human_result_object check (human_result is null or jsonb_typeof(human_result) = 'object'),
  constraint ck_review_queue_reason_len check (reason is null or length(btrim(reason)) between 1 and 2000),
  constraint ck_review_queue_record_version check (record_version >= 1),

  constraint ck_review_queue_deadline check (deadline > opened_at),
  constraint ck_review_queue_closed_time check (closed_at is null or closed_at >= opened_at),

  -- 任务书的三条硬约束 + 它们的状态机补全：
  constraint ck_review_queue_corrected check (status <> 'CORRECTED' or human_result is not null),
  -- APPROVED / REJECTED 必须 closed_at；REPROCESS 同样是终态，一并要求
  constraint ck_review_queue_terminal check (
    (status in ('APPROVED','REJECTED','REPROCESS')) = (closed_at is not null)),
  constraint ck_review_queue_assignee check (status = 'QUEUED' or assignee is not null),
  constraint ck_review_queue_reason_terminal check (
    status not in ('APPROVED','REJECTED','REPROCESS') or reason is not null),
  -- 人工结论只在受理之后出现（QUEUED/IN_REVIEW 不允许先写 human_result）
  constraint ck_review_queue_human_result_state check (
    status not in ('QUEUED','IN_REVIEW') or human_result is null)
);

-- HUM-04（超 24h 升级）与日常巡检都从这两条走
create index if not exists ix_review_queue_status
  on recruitment.review_queue (tenant_id, status, deadline);
create index if not exists ix_review_queue_open
  on recruitment.review_queue (deadline)
  where status in ('QUEUED','IN_REVIEW');
create index if not exists ix_review_queue_assignee
  on recruitment.review_queue (assignee, status)
  where assignee is not null;

-- 入队：只允许以 QUEUED 开局，且 ACCEPTED 的 run 不许进队列
create or replace function recruitment.fn_review_queue_before_insert() returns trigger
language plpgsql as $$
declare
  v_run_status text;
begin
  perform recruitment.fn_require_actor(new.tenant_id);

  if new.status <> 'QUEUED' then
    raise exception 'QUEUE_BAD_INITIAL_STATE: 新条目只能是 QUEUED（收到 %）', new.status
      using errcode = '23514';
  end if;
  if new.closed_at is not null then
    raise exception 'QUEUE_BAD_INITIAL_STATE: 新条目的 closed_at 必须为空'
      using errcode = '23514';
  end if;
  if new.human_result is not null then
    raise exception 'QUEUE_BAD_INITIAL_STATE: 新条目不允许带 human_result（人工结论只在受理之后出现）'
      using errcode = '23514';
  end if;

  select r.status into v_run_status
    from recruitment.conversion_run r
   where r.id = new.run_id and r.tenant_id = new.tenant_id;

  if v_run_status is null then
    raise exception 'QUEUE_RUN_NOT_FOUND: run % 不存在或不属于租户 %', new.run_id, new.tenant_id
      using errcode = '23503';
  end if;
  -- 抽查/复核不属于「兜底」：ACCEPTED 进队列会让「未结案阻断率」失去意义
  if v_run_status = 'ACCEPTED' then
    raise exception 'QUEUE_ACCEPTED_RUN: run % 已 ACCEPTED，不入人工兜底队列（④ 只收机器判不了的）', new.run_id
      using errcode = '23514';
  end if;

  return new;
end $$;

-- 状态迁移 + 不可变列 + deadline/closed_at 的维护
create or replace function recruitment.fn_review_queue_before_update() returns trigger
language plpgsql as $$
declare
  v_terminal constant text[] := array['APPROVED','REJECTED','REPROCESS'];
begin
  perform recruitment.fn_require_actor(new.tenant_id);

  -- 1) 免疫列：机器结果与人工结果是「两份都保留」（HUM-05），谁都不能覆盖
  if new.id is distinct from old.id
     or new.run_id is distinct from old.run_id
     or new.tenant_id is distinct from old.tenant_id
     or new.opened_at is distinct from old.opened_at
     or new.machine_result is distinct from old.machine_result then
    raise exception
      'QUEUE_IMMUTABLE: id / run_id / tenant_id / opened_at / machine_result 不可修改（HUM-05：机器结果与人工结果两份都保留）'
      using errcode = '23514';
  end if;

  -- 2) deadline 只能延长，且只能在未结案时延长
  if new.deadline is distinct from old.deadline then
    if old.status in ('APPROVED','REJECTED','REPROCESS') then
      raise exception 'QUEUE_DEADLINE_CLOSED: 已结案条目不允许改 deadline'
        using errcode = '23514';
    end if;
    if new.deadline <= old.deadline then
      raise exception 'QUEUE_DEADLINE_NOT_EXTENDED: deadline 只能延长（% → %）', old.deadline, new.deadline
        using errcode = '23514';
    end if;
  end if;

  -- 3) closed_at 是触发器维护列：非状态迁移时不许手改
  if new.closed_at is distinct from old.closed_at
     and old.status is not distinct from new.status then
    raise exception 'QUEUE_CLOSED_AT_TRIGGER_ONLY: closed_at 由触发器维护，不接受直接赋值'
      using errcode = '23514';
  end if;

  -- 4) 乐观并发/更新时间由触发器维护（调用方应 WHERE record_version = $expected）
  new.record_version := old.record_version + 1;
  new.updated_at     := now();

  -- 5) 非状态迁移（改 assignee / 补 human_result / 改 reason）：到此为止
  if old.status is not distinct from new.status then
    return new;
  end if;

  -- 6) 状态机
  if not recruitment.fn_review_transition_allowed(old.status, new.status) then
    raise exception 'QUEUE_ILLEGAL_TRANSITION: % → % 不在允许的 8 条边内（见 fn_review_transition_allowed）',
      old.status, new.status
      using errcode = '23514';
  end if;

  -- 7) 终态：closed_at 由触发器写；决策理由必须「本次给出」，不得沿用上一手
  if new.status = any (v_terminal) then
    new.closed_at := now();
    if new.reason is null or new.reason is not distinct from old.reason then
      raise exception 'QUEUE_REASON_REQUIRED: % 必须给出本次决策理由（reason 必须为新值，不得沿用 %）',
        new.status, old.status
        using errcode = '23514';
    end if;
  else
    new.closed_at := null;
  end if;

  -- 8) CORRECTED 必须有 human_result（CHECK 也拦，这里给更可读的错误码）
  if new.status = 'CORRECTED' and new.human_result is null then
    raise exception 'QUEUE_CORRECTED_NEEDS_HUMAN_RESULT: CORRECTED 必须同时写入 human_result'
      using errcode = '23514';
  end if;

  return new;
end $$;

-- 审计：INSERT 与 UPDATE 都自动写，应用层无法漏记（也就无法「忘了留痕」）
create or replace function recruitment.fn_review_audit_write() returns trigger
language plpgsql as $$
declare
  v_actor uuid;
begin
  v_actor := recruitment.fn_require_actor(new.tenant_id);

  if tg_op = 'INSERT' then
    insert into recruitment.review_audit (tenant_id, item_id, from_status, to_status, actor, reason)
    values (new.tenant_id, new.id, null, new.status, v_actor, new.reason);
  else
    insert into recruitment.review_audit (tenant_id, item_id, from_status, to_status, actor, reason)
    values (new.tenant_id, new.id, old.status, new.status, v_actor, new.reason);
  end if;
  return null;
end $$;

drop trigger if exists trg_review_queue_before_insert on recruitment.review_queue;
create trigger trg_review_queue_before_insert
  before insert on recruitment.review_queue
  for each row execute function recruitment.fn_review_queue_before_insert();

drop trigger if exists trg_review_queue_before_update on recruitment.review_queue;
create trigger trg_review_queue_before_update
  before update on recruitment.review_queue
  for each row execute function recruitment.fn_review_queue_before_update();

drop trigger if exists trg_review_queue_audit on recruitment.review_queue;
create trigger trg_review_queue_audit
  after insert or update on recruitment.review_queue
  for each row execute function recruitment.fn_review_audit_write();

drop trigger if exists trg_review_queue_no_delete on recruitment.review_queue;
create trigger trg_review_queue_no_delete
  before delete on recruitment.review_queue
  for each row execute function recruitment.fn_block_delete();


-- =====================================================================
--  3. review_audit · 每次变更留痕（④ 的「谁/何时/为什么」）
--
--  设计要点：
--    * 由触发器写；from_status IS NULL 就是「入队」这一手。
--    * 不只是状态迁移：内容编辑（改 human_result / 延 deadline）也留一行，
--      此时 from_status = to_status。审计宁可多一行，不能少一行。
--    * 追加后不可改、不可删（审计被编辑就不叫审计）。
--    * 一个条目对同一个目标状态只能出现一次（uq_review_audit_transition）：
--      状态机是无环 DAG，重复到达同一状态本身就说明有 bug 或有人在伪造。
--    * audit_seq 是「逐条查回」的顺序号：now() 是事务时间，同一事务里的多条
--      审计 at 完全相同，只能靠 audit_seq 定序（不要按 at 排序）。
-- =====================================================================

create table if not exists recruitment.review_audit (
  id          uuid        primary key default gen_random_uuid(),
  audit_seq   bigint      generated always as identity,
  tenant_id   uuid        not null references recruitment.organization (id),
  item_id     uuid        not null,
  from_status text,
  to_status   text        not null,
  actor       uuid        not null,
  reason      text,
  at          timestamptz not null default now(),

  constraint fk_review_audit_item foreign key (item_id, tenant_id)
    references recruitment.review_queue (id, tenant_id),
  constraint fk_review_audit_actor foreign key (actor, tenant_id)
    references recruitment.actor (id, tenant_id),

  constraint ck_review_audit_from check (
    from_status is null or from_status in ('QUEUED','IN_REVIEW','CORRECTED','APPROVED','REJECTED','REPROCESS')),
  constraint ck_review_audit_to check (
    to_status in ('QUEUED','IN_REVIEW','CORRECTED','APPROVED','REJECTED','REPROCESS')),
  -- 只有「入队」这一手没有前态；反过来，没有前态的只能是 QUEUED
  constraint ck_review_audit_initial check (from_status is not null or to_status = 'QUEUED'),
  constraint ck_review_audit_reason_len check (reason is null or length(btrim(reason)) between 1 and 2000)
);

-- 每条目最多一条「入队」记录
create unique index if not exists uq_review_audit_initial
  on recruitment.review_audit (item_id)
  where from_status is null;
-- 每条目对同一个目标状态最多一条「迁移」记录（from = to 的内容编辑不受限）
create unique index if not exists uq_review_audit_transition
  on recruitment.review_audit (item_id, to_status)
  where from_status is not null and from_status <> to_status;

create index if not exists ix_review_audit_item
  on recruitment.review_audit (item_id, audit_seq);
create index if not exists ix_review_audit_actor
  on recruitment.review_audit (actor, at desc);

drop trigger if exists trg_review_audit_no_update on recruitment.review_audit;
create trigger trg_review_audit_no_update
  before update on recruitment.review_audit
  for each row execute function recruitment.fn_guard_columns();

drop trigger if exists trg_review_audit_no_delete on recruitment.review_audit;
create trigger trg_review_audit_no_delete
  before delete on recruitment.review_audit
  for each row execute function recruitment.fn_block_delete();


-- =====================================================================
--  4. 视图：④ 层「挡住下游」的唯一入口 + ② 层的漏记检测
-- =====================================================================

-- 未结案条目（含是否超期）：HUM-01 的入队清单、HUM-04 的升级清单都从这里出
-- [D-36] 基表主键已改名为 id；视图**刻意保留**对外列名 item_id / run_id：
--   视图是下游的接口，改名会静默改变所有消费者；且 CREATE OR REPLACE VIEW
--   不允许改列名（只能追加），保留别名才能原地升级。
create or replace view recruitment.v_review_open as
select q.tenant_id,
       q.id                                           as item_id,
       q.run_id,
       q.status,
       q.assignee,
       q.opened_at,
       q.deadline,
       (now() >= q.deadline)                          as overdue,
       round(extract(epoch from (now() - q.opened_at)) / 3600.0, 2) as age_hours,
       r.source_sha256,
       r.source_name,
       r.status                                       as run_status,
       r.completeness,
       r.needs_visual,
       r.issue_codes
  from recruitment.review_queue q
  join recruitment.conversion_run r
    on r.id = q.run_id
   and r.tenant_id = q.tenant_id
 where q.status in ('QUEUED','IN_REVIEW','CORRECTED');

-- 每个源文件（tenant + sha256）能不能进下游。
-- gate 四值，含义固定：
--   CLEARED         机器已 ACCEPTED，或人工已 APPROVED —— 可以进筛选
--   PENDING_REVIEW  最新一次调用有未结案条目 —— 下游只能显示「待核」
--   REJECTED        人工已 REJECTED —— 只有人能给出「不符合」，机器不行
--   UNACCOUNTED     非 ACCEPTED 但库里没有对应条目 —— 漏记，按阻断处理（fail closed）
-- blocking 是下游唯一该看的那一位：true = 不得产出任何筛选结论。
create or replace view recruitment.v_source_gate as
with last_run as (
  select distinct on (r.tenant_id, r.source_sha256)
         r.tenant_id, r.source_sha256, r.id as run_id, r.status, r.completeness, r.started_at
    from recruitment.conversion_run r
   order by r.tenant_id, r.source_sha256, r.started_at desc, r.recorded_at desc
), open_items as (
  select q.run_id, count(*) as open_items
    from recruitment.review_queue q
   where q.status in ('QUEUED','IN_REVIEW','CORRECTED')
   group by q.run_id
), human_verdict as (
  select distinct on (r.tenant_id, r.source_sha256)
         r.tenant_id, r.source_sha256, q.status, q.closed_at
    from recruitment.review_queue q
    join recruitment.conversion_run r
      on r.id = q.run_id
     and r.tenant_id = q.tenant_id
   where q.status in ('APPROVED','REJECTED')
   order by r.tenant_id, r.source_sha256, q.closed_at desc
)
select lr.tenant_id,
       lr.source_sha256,
       lr.run_id                                    as latest_run_id,
       lr.status                                    as latest_run_status,
       lr.completeness,
       lr.started_at                                as latest_run_at,
       coalesce(oi.open_items, 0)                   as open_items,
       hv.status                                    as human_verdict,
       case
         when coalesce(oi.open_items, 0) > 0 then 'PENDING_REVIEW'
         when lr.status = 'ACCEPTED'         then 'CLEARED'
         when hv.status = 'APPROVED'         then 'CLEARED'
         when hv.status = 'REJECTED'         then 'REJECTED'
         else                                     'UNACCOUNTED'
       end                                          as gate,
       case
         when coalesce(oi.open_items, 0) > 0 then true
         when lr.status = 'ACCEPTED'         then false
         when hv.status in ('APPROVED','REJECTED') then false
         else true
       end                                          as blocking
  from last_run lr
  left join open_items oi on oi.run_id = lr.run_id
  left join human_verdict hv
         on hv.tenant_id = lr.tenant_id
        and hv.source_sha256 = lr.source_sha256;

-- ②/⑤ 的账本：每个 run 要么 ACCEPTED，要么有且只有一条队列条目。
-- 非 OK_* 就说明「这次失败没有被看见」，交给 ⑤ 告警。
create or replace view recruitment.v_conversion_ledger as
select r.tenant_id,
       r.id             as run_id,
       r.status,
       r.completeness,
       r.source_sha256,
       r.source_name,
       r.started_at,
       q.id           as item_id,
       q.status       as queue_status,
       q.deadline,
       case
         when r.status = 'ACCEPTED' and q.id is null then 'OK_ACCEPTED'
         when r.status <> 'ACCEPTED' and q.id is not null then 'OK_QUEUED'
         when r.status = 'ACCEPTED' and q.id is not null then 'BAD_ACCEPTED_QUEUED'
         else 'MISSING_QUEUE_ITEM'
       end            as accounting
  from recruitment.conversion_run r
  left join recruitment.review_queue q
         on q.run_id = r.id
        and q.tenant_id = r.tenant_id;

commit;
