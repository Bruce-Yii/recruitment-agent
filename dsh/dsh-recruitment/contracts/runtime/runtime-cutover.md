# 运行时启动水位（cutover watermark）· 历史事件不派发

**状态**：本合同随 `db/migrations/0015_runtime_cutover.sql` + `src/runtime/cutover.ts`
一起交付（2026-11-14）。
**权威来源**：本文件是"哪些历史事件由运行时处理"的**唯一权威表述**；
`contracts/runtime/task-runtime.md` §2.6 是摘要与入口。
**实现位置**：
- 库：`recruitment.runtime_watermark` / `recruitment.runtime_watermark_change`（0015）
- 取数：`src/runtime/store.ts` 的 `listPendingEvents`（SQL 里 JOIN 水位）
- 扫尾：`src/runtime/cutover.ts` 的 `RuntimeCutoverStore.sweepBefore`
- 入口：`src/runtime/event-runtime.ts` 的 `processPending`（`tick` 第一步）

---

## 0. 一句话政策

> **水位之前的事件永远不派发**：只把 dispatch 投影标成 `IGNORED`
> （原因 `BEFORE_RUNTIME_CUTOVER`），不建 Task、不写唤醒、不入队副作用、不改事件主体。
> 水位之后的事件正常派发。没有水位 = 不派发任何事件（fail closed）。
> 水位默认按"迁移应用时刻 / 组织创建时刻"取**安全值**；要处理更早的历史，
> 必须由人显式回退并留下审计行。

---

## 1. 为什么需要它（实测事实，不是假设）

2026-11-14 19:50 +08 对 `ra_s6s7` 的实测（见交付报告）：

| 事实 | 数字 |
|---|---|
| `event_inbox` 总量 | 117 行 |
| `dispatch_state` 分布 | RECEIVED 76 / IGNORED 40 / ROUTED 1 |
| 其中 51 条 RECEIVED 是 `fn_row_guard` 的状态审计事件（`normalizer_version='schema/0001'`） | 本来就不进派发队列 |
| **真正会被 tick 取到的积压** | **25 条**（22 × `resume.intake.received` + 3 × `decision.record`） |
| 积压的 `received_at` 跨度 | 2026-11-13 01:36 → 2026-11-14 19:49（**连续，没有天然空闲间隔**） |
| 已 IGNORED 的 `route_error` | 40 条全是 `SEMANTIC_GATE_REJECTED`（证明 tick 会被跑、历史会被"处理"） |

两个直接结论：

1. **"历史"没有时间断点可猜** —— 连续的事件流里不存在"看起来像分界线"的空隙，
   边界只能由人**显式声明**一次，并记录在库里。
2. **一次误派发的代价不对称** —— 漏处理一条可以补（显式回退水位）；
   重复派发会重复建 Task / 重复发副作用（候选人与材料都可能被重复处理），
   且 `event_inbox` 的事件主体不可变，事后无法靠改数据收场。
   所以默认值必须"宁可漏处理，不可重复处理"。

---

## 2. 判定语义（精确到边界）

### 2.1 判定列：`event_inbox.received_at`

- `received_at` 是**数据库在插事件时生成的服务端时间**（`0001` 的
  `received_at timestamptz not null default now()`），不是调用方入参；
- 不用 `occurred_at`（外部提供的事件发生时间）：外部可以回填/伪造时间，
  用外部时间做 cutover 等于把"是否派发"的决定权交给外部；
- 不用 `recorded_at`（与 received_at 同事务、冗余）：判定列只保留一个，避免两个口径。

### 2.2 边界

| 事件 | 结论 |
|---|---|
| `received_at < cutover_at` | **历史** → `IGNORED`，`route_error` 以 `BEFORE_RUNTIME_CUTOVER:` 开头 |
| `received_at = cutover_at` | **新**（`>=`）→ 正常派发 |
| `received_at > cutover_at` | 正常派发 |
| 该租户没有水位行 | **fail closed**：`processPending()` 抛 `CUTOVER_WATERMARK_MISSING` |

> ⚠️ 边界比较只在数据库里做。`runtime_watermark.cutover_at` 是 `timestamptz`（微秒），
> JS `Date` 只有毫秒；把水位读到 JS 再和前端的毫秒时间比较，会把"恰好等于边界"
> 的事件误判成历史。`RuntimeCutover.cutoverAt` 只是展示/传递用的字符串（见其 JSDoc）。

### 2.3 历史事件的处置（只动 dispatch 投影）

对每条历史事件，`sweepBefore()` 在**一条 UPDATE** 里写：

- `dispatch_state = 'IGNORED'`
- `routed_at = now()`、`processed_at = now()`（`ck_event_inbox_dispatch_recorded` 要求）
- `route_attempts += 1`
- `route_error = 'BEFORE_RUNTIME_CUTOVER: received_at <ts> < runtime cutover <ts>; not dispatched (no task, no side effect; runtime cutover policy)'`
- `business_object_type / business_object_id / routed_task_id = null`

**不动**：`provider` / `provider_event_id` / `event_type` / `schema_version` /
`occurred_at` / `received_at` / `recorded_at` / `correlation_id` / `causation_id` /
`idempotency_key` / `idempotency_source` / `source_object_id` / `payload_ref` /
`payload` / `trust_level` / `normalized_event_type` / `normalizer_version`。
这些列不在 `0011 §1.9` 的列级不可变白名单里；越界写会被 `IMMUTABLE_COLUMN` 拒绝。

**不产生业务副作用**：不 `INSERT business_task`、不 `INSERT task_wakeup`、
不 `enqueueEffect`（launch/delivery/reply 都不）。历史扫尾与路由路径完全分离：
它不调用 `decideRoute`，也不依赖语义 Gate 的结论。

### 2.4 幂等

- 扫尾的 UPDATE 带 `dispatch_state in ('RECEIVED','FAILED')` 条件：同一行只会被标一次；
  再 tick 不会重复计数、不会重复写 `route_attempts`；
- 已被标成 `IGNORED`（含 Gate 拒绝的）历史事件**不会**因为回退水位而"复活"——
  已 IGNORED 是终态投影，回退只影响**尚未扫过**的事件。这条是刻意的：
  水位回退的语义是"让还没处理的旧输入进入窗口"，不是"重放已经判定过的历史"。

### 2.5 与 `listPendingEvents` 的关系（防绕过）

`RuntimeStore.listPendingEvents` 的 SQL **JOIN** 水位：

```sql
from recruitment.event_inbox e
join recruitment.runtime_watermark w
  on w.tenant_id = e.tenant_id and e.received_at >= w.cutover_at
```

- 水位过滤不是可选参数（"忘了传 = 不过滤"是一种静默漏洞）；
- 没有水位行时 JOIN 取不到任何行 —— 即使调用方绕过 `processPending` 直接调
  `listPendingEvents`，也拿不到历史事件；
- 扫尾的 UPDATE 里也重复了一次 `received_at < cutover_at` 条件（防御水位在扫描与
  更新之间被推进的竞态）。

---

## 3. 存储结构（0015）

### 3.1 `recruitment.runtime_watermark`（每租户一行）

| 列 | 语义 |
|---|---|
| `id` | PK（`verify.sql` STRUCT-01：单列 uuid） |
| `tenant_id` | 唯一（`uq_runtime_watermark_tenant`），FK → `organization` |
| `cutover_at` | 分界线（`received_at <` 它 = 历史） |
| `reason` | 非空、人可读：为什么定在这个时刻 |
| `set_by_actor_id` | 最后一次显式设置者（系统初始化 = null；复合 FK 钉在本租户） |
| `record_version` / `created_at` / `updated_at` | 乐观并发与审计时间 |

- **禁删**（`fn_block_delete`）：水位行被删 = 运行时失去分界线；
- **只进不退**（BEFORE UPDATE 守卫）：见 §4。

### 3.2 `recruitment.runtime_watermark_change`（append-only 审计）

| 列 | 语义 |
|---|---|
| `watermark_id` + `tenant_id` | 复合 FK（含 tenant_id，STRUCT-07） |
| `old_cutover_at` / `new_cutover_at` | 旧值 / 新值 |
| `change_kind` | `INSERT` / `FORWARD` / `REWIND`（CHECK 校验方向与新旧值自洽） |
| `reason` | 非空；回退理由**必须**写清"为什么要把历史重新放进窗口" |
| `changed_by_actor_id` | 谁签的字（系统初始化可为 null） |
| `changed_at` | 审计时间 |

- **禁删 + 整行不可改**（`fn_block_delete` + `fn_guard_columns()` 无白名单）；
- 审计行由**触发器**写（`trg_runtime_watermark_audit`），调用方无法选择"自称"成前进还是回退：
  方向由新旧值自动判定。

---

## 4. 显式写入入口（只能用对方向）

所有函数都要求：

- `recruitment.actor_id`（事务内 `SET LOCAL`）必须存在且属于该租户，否则
  `ACTOR_REQUIRED` / `ACTOR_TENANT_MISMATCH`；
- 非空 `reason`（否则 `WATERMARK_REASON_REQUIRED`）；
- `cutover_at <= now()`（否则 `WATERMARK_IN_FUTURE`；要停运行时请关
  `runtime.enabled`，不要用未来水位代替）。

| 函数 | 方向 | 额外约束 |
|---|---|---|
| `recruitment.fn_runtime_watermark_upsert(tenant, cutover_at, reason)` | 初始化 | 只对**还没有水位**的租户；已有则 `WATERMARK_EXISTS`（防止用 upsert 偷偷改小） |
| `recruitment.fn_runtime_watermark_forward(tenant, cutover_at, reason)` | 前进 | 必须严格变大（`WATERMARK_NOT_FORWARD`）；安全方向，允许直接 SQL UPDATE（仍要 actor） |
| `recruitment.fn_runtime_watermark_rewind(tenant, cutover_at, reason)` | 回退 | 必须严格变小（`WATERMARK_NOT_REWIND`）；函数内部设本次事务的 ack，**只有这条路径能过守卫** |

直接写 `UPDATE recruitment.runtime_watermark SET cutover_at = <更早>`（哪怕有 actor）
→ `WATERMARK_REWIND_FORBIDDEN`。把水位改小需要**主动选择这条函数**，这一步就是
"人签字"。同一事务里事后想再退，必须再调用一次函数（ack 是 transaction-local）。

### 4.1 默认值（安全优先）

| 场景 | cutover_at 默认值 | 理由 |
|---|---|---|
| 0015 应用到已有库 | 迁移应用时刻 `now()` | 迁移之前的任何事件都不再是"运行时可信窗口内的新输入" |
| 0015 之后新建组织 | 组织创建时刻 `now()`（`trg_organization_runtime_watermark`） | 组织创建是它可能收到事件之前的**下界**；同事务完成，不会出现"有组织没边界"的中间态 |
| 运行时发现没有水位行 | **不补默认值**，抛 `CUTOVER_WATERMARK_MISSING` | 自动补 `now()` 会让"边界从未被声明过"这种配置缺口静默消失 |

为什么不是 `max(received_at)`：那会让最新一批积压仍被判成新事件，等于没 cutover。
为什么不是 `organization.created_at` 作为统一默认：水位语义是"运行时开始被信任的时刻"，
不是"租户诞生时刻"；只有新组织两者恰好重合。

---

## 5. 运行时行为（tick）

`Router.tick()` → `EventRuntime.processPending()` 的顺序固定：

1. 读水位；没有 → 抛 `CUTOVER_WATERMARK_MISSING`（HTTP 入口返回 500 + 可读 message，
   不把失败说成"没有任务"）；
2. `sweepBefore(batchLimit, maxRouteAttempts)`：本批最多标 `batchLimit` 条历史事件
   IGNORED，并作为 `IGNORED` 结果放进 tick 回执（`reason` 以 `BEFORE_RUNTIME_CUTOVER` 开头）；
3. `listPendingEvents(batchLimit, maxRouteAttempts)`：重放跨过水位的待路由事件。

回执形状不变（仍是 `EventReceiveResult[]`）：历史扫尾事件的
`outcome='stored'` / `dispatchState='IGNORED'` / `taskId=null` / `taskCreated=false` /
`wakeInserted=false`。调用方靠 `reason` 区分"水位扫尾"与"语义 Gate 拒绝"。

单轮工作量上限 = `pendingBatchSize`（默认 20）条扫尾 + `pendingBatchSize` 条派发。
积压超过 2 × batch 时分多轮处理完；每轮都是可解释的（回执里有具体 eventId）。

### 5.1 健康检查必须显示"历史积压"（不能只显示"已标 IGNORED"）

把历史事件标成 `IGNORED` 只是**不再派发**，不等于积压消失。运维必须能回答
"有多少历史事件从未被派发、最老等了多久"，否则"扫完了"会被误读成"没积压"。

`GET /recruitment/runtime/health` 的 `counts` 里固定包含（`RuntimeStore.runtimeCounts`）：

| 字段 | 语义 | 会不会因 tick 扫尾而变小 |
|---|---|---|
| `events_legacy_undispatched` | 早于水位、未派发、**本来就会进派发队列**的事件（`routed_task_id is null`，排除 `schema/0001` 审计事实） | **不会**（扫尾只改投影） |
| `events_legacy_undispatched_ignored` | 其中**早已被判定、从未派发**的（`dispatch_state='IGNORED'` 且 `routed_task_id is null`：历史 Gate 拒绝批 + 水位扫尾批） | **不会**（它们本来就没派发） |
| `events_legacy_internal_audit` | 早于水位、从未派发的库触发器审计事件（本来就不进派发队列，单独透明展示，避免被算成"积压"） | 不会 |
| `events_before_cutover_pending` | 其中仍在待派发队列、下一轮会被扫尾的条数（`RECEIVED`/`FAILED`） | 会（扫完变 0） |
| `events_ignored_before_cutover` | 已经因为**水位**标成 `IGNORED` 的条数（`route_error` 以 `BEFORE_RUNTIME_CUTOVER` 开头） | 会随扫尾增长 |
| `events_legacy_oldest_wait_seconds` | 从未派发的候选事件里最早一条**已经等了多久**（秒） | 不会（持续增长） |

三个口径必须同时展示：
- `events_legacy_undispatched` 是"历史总量"（问题规模）；
- `events_legacy_undispatched_ignored` 与 `events_before_cutover_pending` 把历史**拆成两类**：
  早已被判定但从未派发的（例如 2026-11-14 那 40 条 `SEMANTIC_GATE_REJECTED`），
  以及还在队列里、下一轮就会被水位扫尾的（例如 25 条 `resume.intake.received` 积压）；
- `events_legacy_oldest_wait_seconds` 是积压的时间成本（最老一条等了多久）。

只读查询（可直接用于报告；权威实现在 `RuntimeCutoverStore.legacyBacklog`）：

```sql
select count(*)                                              as legacy_undispatched,
       count(*) filter (where e.dispatch_state in ('RECEIVED','FAILED')) as still_pending,
       min(e.received_at)                                     as oldest_received_at,
       extract(epoch from (now() - min(e.received_at)))::bigint as oldest_wait_seconds
  from recruitment.event_inbox e
  join recruitment.runtime_watermark w on w.tenant_id = e.tenant_id
 where e.tenant_id = '<tenant-uuid>'::uuid
   and e.received_at < w.cutover_at
   and e.routed_task_id is null
   and (e.normalizer_version is distinct from 'schema/0001'
        or e.event_type like 'semantic.%' or e.event_type like 'router.%');
```

---

## 6. 运维步骤

### 6.1 上线前 dry-run（只读，不改变库）

```sql
-- 运行时只读预览（TS）：src/runtime/evidence/runtime-cutover.evidence.ts
-- 单行 SQL 诊断（非权威，权威是运行时方法）：
select w.cutover_at,
       count(*) filter (where e.received_at <  w.cutover_at) as will_be_ignored_before_cutover,
       count(*) filter (where e.received_at >= w.cutover_at) as will_be_dispatched
  from recruitment.event_inbox e
  join recruitment.runtime_watermark w on w.tenant_id = e.tenant_id
 where e.tenant_id = '<tenant-uuid>'::uuid
   and e.dispatch_state in ('RECEIVED','FAILED')
   and e.route_attempts < 5
   and (e.normalizer_version is distinct from 'schema/0001'
        or e.event_type like 'semantic.%' or e.event_type like 'router.%')
 group by w.cutover_at;
```

dry-run 的"会处理多少条" = `will_be_ignored_before_cutover`（标 IGNORED，不派发）。

### 6.2 业务决定要补处理某段历史（显式回退）

```sql
begin;
set local recruitment.actor_id = '<本租户的 actor uuid>';
select recruitment.fn_runtime_watermark_rewind(
  '<tenant-uuid>'::uuid,
  '2026-11-14T16:00:00+08'::timestamptz,
  '业务裁决：补处理 2026-11-14 16:00 之后到达的 S6 intake 事件（理由写清范围与批准人）');
commit;
-- 审计行：
select change_kind, old_cutover_at, new_cutover_at, reason, changed_by_actor_id
  from recruitment.runtime_watermark_change
 where tenant_id = '<tenant-uuid>'::uuid order by changed_at desc limit 1;
```

注意：**已 IGNORED 的事件不会复活**（§2.4）。回退只让"还没被扫过"的旧事件进入窗口；
如果目标事件已经被扫过，需要的是数据修复/重放工单，不是水位回退。

### 6.3 收紧（前进）

```sql
begin;
set local recruitment.actor_id = '<actor uuid>';
select recruitment.fn_runtime_watermark_forward('<tenant-uuid>'::uuid, now(), '收紧：只处理此刻之后到达的事件');
commit;
```

---

## 7. 验收（可执行、可复跑）

| # | 验什么 | 命令 |
|---|---|---|
| 1 | 迁移 0015 能从 0001 顺序应用到最新 | 空库按 0001→0015 重放（见交付报告） |
| 2 | `db/verify.sql` PASS（新表满足 STRUCT-01..07） | `psql -f db/verify.sql` |
| 3 | 水位之前的事件不派发/不建 Task/主体不变 | `node --test test/runtime/cutover.test.ts` |
| 4 | 水位之后（含恰好等于）正常派发 | 同上 |
| 5 | 直接改小被拒；函数回退留 REWIND 审计 | 同上 |
| 6 | 审计表禁改禁删、水位行禁删 | 同上 |
| 7 | 无水位 → fail closed | 同上 |
| 8 | dry-run 与真实 tick 结论一致 | 同上 + `runtime-cutover.evidence.ts` |

---

## 8. 刻意不做的（边界）

- **不删/不清空历史事件**：`event_inbox` 是历史事实（0001 禁删 + 列级不可变），
  删除会让"为什么没派发"无法解释；水位是唯一合法手段。
- **不把水位放进 `cordis.patch.yml`**：配置是部署期静态值、无 DB 审计、无法按租户
  区分，而且"配置文件说 A、库里数据是 B"会产生两套权威。水位是**数据**。
- **不在迁移里批量改 event_inbox**：迁移只建结构与初始水位；标 IGNORED 是 tick 的
  职责（POST-CHECK 明确断言迁移后 `BEFORE_RUNTIME_CUTOVER` 行数为 0）。
- **不回退只按 `dispatch_state` 判断**：RECEIVED 同时包含"上线后新到、还没处理"的
  事件，状态不携带时间语义。
- **不改事件名路由表**：`src/runtime/routing.ts` / `event-types.ts` 是另一条 lane 的
  范围；本水位与事件类型无关（对任何类型一视同仁）。
