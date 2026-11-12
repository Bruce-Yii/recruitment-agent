# db/REVIEW-QUEUE.md · ② 可观测层 + ④ 人工兜底队列

**状态**：初始版（`migrations/0003_review_queue.sql`），**待独立复核**
**权威来源**：`docs/12-layer-acceptance.md`（= `work/handoff/12-layer-acceptance.md`）§2② / §2④ / §3 / §5③ / §6；`db/SCHEMA.md` §1 全局约定；`work/control/DECISIONS-2026-11-12.md` D-18 / **D-36**（主键列一律叫 `id`）/ **D-47**（本迁移两张表豁免 `fn_row_guard`）
**一句话**：把「这次调用发生了什么」写成一等公民，把「机器判不了的」变成一条**人必须接手、且没接手就挡住下游**的队列。

---

## 0. 范围（说清不做什么）

| 层 | 归属 | 本迁移 |
|---|---|---|
| ① 可检验（工具自检） | 工具层 | **不做**（红线规则在转换器里；库里只保留它判完的结论） |
| ② 可观测（每次调用留痕） | 工具层 | **做**：`conversion_run` + 3 个视图 |
| ③ 模型兜底（Agent 换招） | 工具→Agent 层 | **不做**（行为验收，不是表结构） |
| ④ 人工兜底（队列 + 阻断） | 系统层 | **做**：`review_queue` / `review_audit` / `v_source_gate` |
| ⑤ 系统治理（账平/告警） | 系统层 | **不做作业**，只给账本：`v_conversion_ledger` |

边界理由：② 和 ④ 是「失败能被看见」的最小集。①③⑤ 都要跑真实样本/真实 Agent/定时作业，不是迁移能交付的东西；但 ⑤ 需要的**账本**必须是结构的一部分，否则 ⑤ 只能靠应用层自己拼 SQL，迟早口径漂移（R5）。

---

## 1. 三张表速查（实测于 PG 17.11）

| 表 | 字段 | 约束（PK/UNIQUE/FK/CHECK） | 索引 | 触发器 | 回答的问题 |
|---|---|---|---|---|---|
| `conversion_run` | 16 | 1 / 1 / 1 / 16 = **19** | 8 | 2 | 这次调用到底发生了什么？ |
| `review_queue` | 13 | 1 / 2 / 3 / 12 = **18** | 6 | 4 | 谁接手？没接手时下游能不能过？ |
| `review_audit` | 9 | 1 / 0 / 3 / 4 = **8** | 5 | 2 | 谁、何时、为什么改的？ |

外加 6 个函数、3 个视图、8 个触发器。计数口径与断言写在 `db/verify-0003.sql` §1/§2（`STRUCT-04` 断言字段数精确，`STRUCT-11` 断言约束数精确，`STRUCT-12` 解释 `information_schema` 为什么虚高）。

> **口径提醒**：PG 17 的 `information_schema.table_constraints` 把 `NOT NULL` 也记成 `CHECK`，所以它给出的 `conversion_run` 约束数是 31 而不是 19。`verify-0003.sql` §1.1 把这条差额显式核对成 `真实 CHECK + NOT NULL 列数`，避免「约束数」这个数字被误读。

> **主键命名（D-36）**：三张表的主键列一律叫 **`id`**（原为 `run_id` / `item_id` / `audit_id`，2026-11-13 按 D-36 机械改名，语义零变更）。`review_queue.run_id` 与 `review_audit.item_id` 是**对外引用列**，保留原名；三个视图也保留原输出列名 `item_id` / `run_id`（视图是下游接口，改名会静默改所有消费者的语义，且 `CREATE OR REPLACE VIEW` 不允许改列名）。

---

## 2. `conversion_run`：每次调用一条，永不覆盖

### 2.1 为什么 append-only

- doc 12 **OBS-02**：同一文件跑两次 → **两条记录**，`source_sha256` 相同、`run_id` 不同。
  所以 `source_sha256` **不能**建唯一约束——建了就等于「同一文件只能记录一次」，重跑会把历史挤掉。
- doc 12 **OBS-03**：读取器崩溃 → `status=CRASHED`，「不是没有这条」。
  所以没有 `RUNNING` 状态：**调用结束（含监护进程补记）才写一行**，`finished_at` 必填，不存在半条记录。
  崩溃后补记的行 `recorded_at > started_at`，两个时间分开存（docs/03 §19 的时间语义：发生时间与记录时间不互相冒充）。
- `trg_conversion_run_immutable`（`fn_guard_columns()` 无参数）让**任何列都改不了**，`trg_conversion_run_no_delete` 让 `DELETE` 直接 `DELETE_FORBIDDEN`。要修正历史 = 再跑一次、再写一条。

### 2.2 字段

| 字段 | 说明 |
|---|---|
| `run_id` | 主键；**每次调用新生成**，不复用 |
| `tenant_id` | 0001 的全局约定（除 `organization` 外每表都有），带外键；也是 `review_queue` 复合外键的一半 |
| `source_sha256` | 小写 64 位十六进制（`^[0-9a-f]{64}$`）；按文件查历史的 join key。**有索引**：`ix_conversion_run_sha (source_sha256, started_at desc)` |
| `source_name` | **只存 basename**，不存绝对路径（路径常含候选人姓名/目录名，R7） |
| `converter_version` | 例：`pymupdf+layout/1.28.0`。同一文件两次结果不同时，靠它区分「换了实现」还是「实现不稳定」 |
| `status` | `ACCEPTED` / `QUARANTINED` / `FAILED` / `CRASHED`（见 §2.3） |
| `completeness` | `complete` / `partial` / `unverified`（doc 11 §1 的三态原词，不改写） |
| `needs_visual` | 对齐 doc 11 的 `needs_visual`：图像页/扫描件 |
| `issue_codes` | `text[]`，来自 `issues[].code`；**不校验命名格式**（见 §2.4） |
| `pages` / `blocks` | 读数规模；`>= 0` |
| `elapsed_ms` | 转换器自己的测量；只约束 `>= 0`（一次挂死 25 小时也必须能记下来） |
| `started_at` / `finished_at` | 调用起止；`finished_at >= started_at` |
| `recorded_at` | 这行**写进库**的时间（崩溃补记时晚于 `started_at`） |
| `result_json` | 结构化摘要（见 §2.5），`jsonb object`，≤ 1 MiB |

### 2.3 四个状态与它们的判定

| 状态 | 含义 | 会进队列吗 |
|---|---|---|
| `ACCEPTED` | 自检通过：`completeness=complete`、零 issue、`needs_visual=false` | **不会**（见 §4.3） |
| `QUARANTINED` | 读出来了，但**不可信/不完整**（HARD issue、图像页、partial） | 必须进 |
| `FAILED` | 调用本身失败但返回了结构化错误（加密、超时、reader 失败） | 必须进 |
| `CRASHED` | 进程崩了/读取器抛异常，由监护方补记 | 必须进 |

- 前三种是任务书要求的；**`CRASHED` 是 doc 12 OBS-03 逐字要求的第四种**（「status=CRASHED，不是没有这条」），所以 `ck_conversion_run_status` 放行四个值。把 CRASHED 折进 FAILED 会让 OBS-03 的机检对不上。
- 判定与完整性必须自洽（都是「定义上不可能」，不是业务偏好）：
  - `completeness='complete'` ⇒ 零 `issue_codes` 且 `needs_visual=false`（doc 11 §1 硬性；INJ-04「图像页标成 complete」在库里就过不去）；
  - `status='ACCEPTED'` ⇒ 同上三条（接受 = 没有读不出的东西）；
  - `status in (FAILED, CRASHED)` ⇒ 不允许 `complete`（崩了/失败了不可能完整）；
  - `ACCEPTED` / `QUARANTINED` ⇒ `result_json` 必须非空（有结果才谈得上判定）。

### 2.4 为什么 `issue_codes` 不校验命名格式

doc 11 §1：「**未知 issue code 一律按 HARD 处理**」。

如果这里用 `^[a-z_]+$` 把未知 code 拒掉，后果是**这条失败记录写不进库**——而 ② 层最不能接受的失败模式恰恰是「没有这条」，不是「code 长得不对」。所以只校验：非 NULL、非空白、长度 1..64、数组不是无穷大。code 的目录属于工具层（① 的 issue 表），库不复制一份，避免两套真相源。

同理，`elapsed_ms` 只约束 `>= 0`：**可观测表不许拒收真实观测**。

### 2.5 `result_json` 存什么、不存什么

存**摘要**：`issue_codes` / `hard_codes` / `field_states` / `pages` / `blocks` / `needs_visual` / 各 issue 的 `location` 概要 / `error`。

不存**全文**：正文属于 `resume_version`（0001），原件属于 `intake_asset`。1 MiB 的 CHECK 是防这张表长成 blob 库的护栏，不是容量规划。

---

## 3. `review_queue`：一条失败 = 一条队列条目

### 3.1 关键约束与理由

| 约束 | 为什么 |
|---|---|
| `uq_review_queue_run (run_id)` | **一次失败只排一次队**。重复入队会让「入队率 100%」和「阻断率 100%」两个判据同时失真。重跑 = 新 `run_id` = 新条目，不是「同一条重开」 |
| `fk_review_queue_run (run_id, tenant_id)` | 复合外键：物理上不可能把甲租户的 run 排进乙租户的队列 |
| `fk_review_queue_assignee (assignee, tenant_id)` | 受理人必须是**真实 actor**，且同租户；不许写一段自由文本当「负责人」 |
| `ck_review_queue_corrected` | `CORRECTED` ⇒ `human_result` 非空（任务书硬要求；触发器先给 `QUEUE_CORRECTED_NEEDS_HUMAN_RESULT` 的可读报错） |
| `ck_review_queue_terminal` | `(status in (APPROVED,REJECTED,REPROCESS)) = (closed_at is not null)`：终态必有 `closed_at`，未结案必无。任务书要求 APPROVED/REJECTED；**REPROCESS 同样是终态**，一并要求 |
| `ck_review_queue_assignee` | 除 `QUEUED` 外必须有 `assignee`（**没认领就不算受理**） |
| `ck_review_queue_reason_terminal` | 三种终态必须有 `reason`；触发器进一步要求**理由本次给出**（见 §5.2） |
| `ck_review_queue_human_result_state` | `QUEUED`/`IN_REVIEW` 不许有 `human_result`（人工结论只在受理之后出现） |
| `ck_review_queue_deadline` | `deadline > opened_at`；默认 `now() + 24h`（HUM-04 的升级依据） |
| `ck_review_queue_closed_time` | `closed_at >= opened_at` |
| `machine_result NOT NULL` + object | 机器结论必须留档；与 `human_result` 分两列，**两份都保留**（HUM-05） |

### 3.2 不可变列（触发器强制，不是文档约定）

- `item_id` / `run_id` / `tenant_id` / `opened_at` / `machine_result`：**一次写入，永不修改**。
  最后一条是 HUM-05 的落点：人工补正**不许覆盖**机器结果，只能新增 `human_result`。
- `deadline`：只能**延长**（`QUEUE_DEADLINE_NOT_EXTENDED`），已结案不许改（`QUEUE_DEADLINE_CLOSED`）。
  缩短 deadline 等于绕过 HUM-04 的升级计时，所以禁掉。
- `closed_at`：只能由触发器在终态迁移时写；手工赋值报 `QUEUE_CLOSED_AT_TRIGGER_ONLY`。
- `record_version` / `updated_at`：触发器维护（`+1` / `now()`），调用方应 `WHERE record_version = $expected` 做乐观并发。
  两个审核人同时点「受理」时，后到的那条更新 0 行 → 立刻重读，而不是两个人各自以为抢到了。

`review_audit` 记的是**所有**变更，不只是状态迁移：

- 入队 → `∅ → QUEUED`；
- 受理 / 补正 / 放行 → `from ≠ to`；
- 改 `assignee`、延 `deadline`、补 `human_result`（状态不变）→ `from = to`。

这样「人工补正被谁改过」也查得到，而不是只有状态跳变才有记录。顺序看 `audit_seq`（identity 列）：
`now()` 是事务时间，同一事务里的多条审计 `at` 完全相同，**不能按 `at` 排序**。
`uq_review_audit_transition (item_id, to_status) where from_status <> to_status` 保证同一目标状态最多出现一次——
状态机是无环 DAG，重复到达同一状态本身就该报 23505。

---

## 4. 状态机（这是本迁移的核心裁决）

### 4.1 允许的 8 条边（`fn_review_transition_allowed`，库内唯一一份定义）

| # | 边 | 场景 |
|---|---|---|
| 1 | `QUEUED → IN_REVIEW` | 认领（必须同时写 `assignee`） |
| 2 | `IN_REVIEW → CORRECTED` | 人工补正（必须同时写 `human_result`） |
| 3 | `IN_REVIEW → APPROVED` | 看了原件，机器结果可用，**原样放行**（D-19「仅顺序问题快速放行」） |
| 4 | `IN_REVIEW → REJECTED` | 看了原件，这份材料不可用（如：不是简历） |
| 5 | `IN_REVIEW → REPROCESS` | 退回机器重跑（换后端/换参数） |
| 6 | `CORRECTED → APPROVED` | 复核通过人工补正（maker–checker：补正人 ≠ 复核人） |
| 7 | `CORRECTED → REJECTED` | 复核认为补正后仍不可用 |
| 8 | `CORRECTED → REPROCESS` | 复核认为补正不可用，退回机器 |

6×6 = 36 格，其余 28 格全部拒绝。`verify-0003.sql` §3 打印整张矩阵并断言「36 格 / 8 条边」。

### 4.2 `QUEUED → APPROVED` 允许吗？——**禁止**

任务书要求我裁决。裁决：**禁止**，且 `QUEUED` 的出口**只有** `IN_REVIEW` 一条。

理由：

1. **这一层存在的意义是「人接得住」**（doc 12 §2④）。没有人认领就放行，等于把「人工兜底」退化成「自动放行」，而且事后查不到是谁放的行——审计里会出现一条 `∅ → APPROVED` 的怪记录。
2. **阻断判据会失效**：doc 12 的核心判据是「**未处理**项的阻断率 100%」。如果 `QUEUED` 能直接 `APPROVED`，那么「未处理」与「已处理」在数据上只差一次 UPDATE，任何并发/重试 bug 都会把「未处理」直接变成「已处理」。
3. **成本几乎为零**：认领是同一事务里的一条 UPDATE（`status='IN_REVIEW', assignee=...`）。批量场景可以「认领 + 放行」两条语句包在一个事务里，审计仍然逐条留痕。
4. 同理禁止：`QUEUED → {CORRECTED, REJECTED, REPROCESS}`（**所有决策都必须经过受理**）。这是本状态机唯一的「一刀切」规则，换来的是可检验性。

### 4.3 为什么 `ACCEPTED` 的 run 不许入队

- 「兜底队列」只收**机器判不了**的。抽查/复核混进来会让「阻断率」失去意义：队列里会出现本不该阻断下游的条目。
- 也保证账本能一行写清：`ACCEPTED ⇒ 0 条队列条目`，`非 ACCEPTED ⇒ 恰好 1 条`（`v_conversion_ledger`）。
- 事后发现 ACCEPTED 有问题，属于业务纠正（`decision` / 重新转换），不是「兜底队列」的场景；硬要支持，应另开迁移并同时改指标口径。

### 4.4 `REPROCESS` 为什么是终态

退回机器重跑后，**这一条就该关闭**（`closed_at` + `reason` 必填）。重跑产生新的 `run_id`；如果又失败，会得到**新的条目**。这样：

- 每条条目只对应一次机器判定 → 审计序列无环；
- `uq_review_audit_transition (item_id, to_status)` 可以把「同一个目标状态出现两次」直接判为 23505（重复/伪造）；
- 想统计「同一文件被退回几次」，按 `source_sha256` 数条目即可，不需要在同一条上来回改状态。

---

## 5. 写入契约（调用方必须遵守）

### 5.1 每次写操作都要 actor（D-18）

```sql
begin;
set local recruitment.actor_id = '11111111-0000-0000-0000-000000000003';  -- 入队：转换器/系统 actor
insert into recruitment.conversion_run (...) values (...);
insert into recruitment.review_queue (tenant_id, run_id, machine_result, reason) values (...);
commit;
```

- 用 `SET LOCAL`，**不能**用 `SET`（连接池会把责任人泄漏给下一个请求，静默记错人）。
- 入队也要 actor：`review_audit` 的第一条 `∅ → QUEUED` 记的是「谁把它放进来的」。
- 没有 actor → `ACTOR_REQUIRED`（23514）；actor 不属于该租户 → `ACTOR_TENANT_MISMATCH`（23503）。

### 5.2 三条「一次调用」的写法

```sql
-- ① 落一次转换调用（ACCEPTED 的例子；QUARANTINED/FAILED/CRASHED 同理，只是 status/completeness 不同）
insert into recruitment.conversion_run
  (tenant_id, source_sha256, source_name, converter_version, status, completeness,
   needs_visual, issue_codes, pages, blocks, elapsed_ms, started_at, finished_at, result_json)
values
  ($tenant, $sha256, $basename, $converter_version, 'QUARANTINED', 'partial',
   false, array['pdf_reading_order_unverified'], 11, 133, 4120, $started, $finished,
   jsonb_build_object('issue_codes', ..., 'hard_codes', ..., 'pages', 11));

-- ② 机器判不了的入队（同一个事务里做，别拖到异步）
insert into recruitment.review_queue (tenant_id, run_id, machine_result, reason)
values ($tenant, $run_id,
        jsonb_build_object('run_status','QUARANTINED', ...),
        '机器判定：pdf_reading_order_unverified（doc 11 A4 HARD，需人工核对）');

-- ③ 受理 / 补正 / 放行：都要带 record_version
update recruitment.review_queue
   set status = 'IN_REVIEW', assignee = $human_actor
 where item_id = $item and record_version = $expected;      -- 0 行 = 被抢了，重读
```

### 5.3 终态理由必须「本次给出」

`IN_REVIEW → APPROVED` 时，触发器要求 `reason` **非空且与上一手不同**（`QUEUE_REASON_REQUIRED`）。
不这样做的话，补正时写的理由会被「继承」成放行理由，审计里看不出放行的人到底核对了什么。

---

## 6. 阻断：④ 层的核心判据

### 6.1 `v_source_gate`：下游唯一该看的视图

按 `(tenant_id, source_sha256)` 聚合**最新一次调用**：

| `gate` | 含义 | `blocking` | 下游允许说什么 |
|---|---|---|---|
| `CLEARED` | 机器已 ACCEPTED，或人工已 APPROVED | `false` | 可正常进筛选 |
| `PENDING_REVIEW` | 最新调用的条目未结案 | `true` | **只能显示「待核」** |
| `REJECTED` | 人工已 REJECTED | `false` | 可显示「不符合」——**但必须附人工理由**，机器永远不能给这个结论 |
| `UNACCOUNTED` | 非 ACCEPTED 却查不到条目 | `true` | 同上「待核」：**漏记按阻断处理（fail closed）** |

```sql
-- 下游唯一正确的写法：先看 blocking，再看 gate
select gate, blocking, latest_run_status, human_verdict
  from recruitment.v_source_gate
 where tenant_id = $tenant and source_sha256 = $sha;
```

关键词是 **fail closed**：查不到、漏记、状态不认识 → 一律 `blocking=true`。
`UNACCOUNTED` 是故意留的「洞的探测器」：它证明这张表能发现「失败没有被看见」，而不是假设应用层不会忘。

### 6.2 为什么不在库里强制「每个非 ACCEPTED 的 run 必须同事务入队」

可以用延迟约束触发器做到，但**故意不做**：

- 一旦两者绑死在同一事务，**入队失败会连 run 记录一起回滚**——可观测层就丢了证据。这正好违背 ② 层的目标（「日志关掉也能查」）。
- 正确做法是：先保证**记录一定写下去**，再让「漏入队」在 `v_conversion_ledger` / `v_source_gate` 里**立刻可见并阻断**，由 ⑤ 告警。证据优先于一致性。

### 6.3 未结案与超期

```sql
-- HUM-01/HUM-04：队列看板 + 升级
select * from recruitment.v_review_open where overdue;          -- 超 24h 未结案
select status, count(*) from recruitment.v_review_open group by status;
```

`ix_review_queue_open (deadline) where status in ('QUEUED','IN_REVIEW')` 就是给这条查询用的。

---

## 7. ② 层的查询面（OBS-04 的四个维度）

| 维度 | 查询 | 索引 |
|---|---|---|
| code | `where issue_codes @> array['pdf_reading_order_unverified']` | `ix_conversion_run_issue_codes`（GIN） |
| 来源 | `where source_sha256 = $sha` | `ix_conversion_run_sha (sha, started_at desc)` |
| 时间 | `where started_at >= $t` / `order by started_at desc` | `ix_conversion_run_started` |
| 状态 | `where status = 'QUARANTINED'` | `ix_conversion_run_status (status, started_at desc)` |

漏记检测（⑤ 的入口，一句 SQL）：

```sql
select accounting, count(*)
  from recruitment.v_conversion_ledger
 group by accounting;          -- 只允许出现 OK_ACCEPTED / OK_QUEUED
```

`v_conversion_ledger` 的 `accounting` 四值：`OK_ACCEPTED` / `OK_QUEUED` / `BAD_ACCEPTED_QUEUED`（结构上已被 §4.3 挡住）/ `MISSING_QUEUE_ITEM`。

文件级账平（doc 12 §6 的 `输入 = ACCEPTED + 队列中 + 已拒绝`）：

```sql
select gate, count(*) from recruitment.v_source_gate group by gate;
-- CLEARED + PENDING_REVIEW + REJECTED + UNACCOUNTED 之和 == 不同 source_sha256 的个数
```

---

## 8. 已知边界（不装作没有）

| # | 边界 | 影响 | 处理 |
|---|---|---|---|
| B-1 | **审计可被有写权限的人伪造**：`review_audit` 禁止 UPDATE/DELETE，但直连数据库仍可 `INSERT` 一条假记录 | 审计的「完整性」靠唯一索引 + 外键 + 触发器，不靠权限 | v1.0 单应用连接；生产化时加角色/权限（不在本迁移范围） |
| B-2 | **`record_version` 只保护并发，不保护越权**：它不校验「这个人能不能审这条」 | 授权在应用/服务端（docs/03 §16 不变量 7） | 库里只保证 `assignee`/`actor` 是真实且同租户 |
| B-3 | **同一文件的多个 run 会各自入队**：R1 被拒后重跑失败 → 第二条条目 | 看板会出现同 sha 的两条 | 这是刻意的（每条对应一次机器判定）；看板按 sha 分组即可 |
| B-4 | **`source_name` 可能含候选人姓名**（文件名） | PII | 只存 basename；报告/日志只用 `source_sha256` + 编号（R7）。真要脱敏，在写入前做，不在库里猜 |
| B-5 | **`result_json` 只留摘要**，原始全文不在可观测层 | 事后想复算要回 `resume_version` | 刻意的：可观测层不是仓库（§2.5） |
| B-6 | **`REPROCESS` 的闭环没有实现**：库里只记录「退回机器」，真正触发重跑是 ③/⑤ 的作业 | 条目会停在 `REPROCESS` 直到新 run 出来 | 新的失败会带来新条目；`v_source_gate` 不会因为 `REPROCESS` 就放行（最新 run 若没有新记录 → `UNACCOUNTED`，仍然阻断） |
| B-7 | **没有硬性 SLA 通知**：只有 `deadline` / `overdue` | 超期不会自己发消息 | ⑤ 的告警作业负责（`where overdue`） |
| B-8 | **`issue_codes` 没有 severity**：HARD/SOFT 的目录在工具层 | 库里不能直接筛「只有 HARD」 | `result_json->'hard_codes'` 可查；是否把 severity 升成列，见 §9 |

---

## 9. 待裁决（需要总控/产品拍板，不在本迁移擅自决定）

| # | 问题 | 现状 | 建议 |
|---|---|---|---|
| Q-1 | 非 ACCEPTED 的 run 是否**必须**同事务入队 | 否（§6.2，故意） | 维持：证据优先，漏记靠 `v_conversion_ledger` + 告警 |
| Q-2 | `hard_codes` / `severity` 是否升成列 | 只在 `result_json` 里 | 等 ① 的 issue 目录冻结后再定；现在加列会制造第二份 code 目录 |
| Q-3 | `REPROCESS` 由谁触发、退几次后强制人工 | 未实现 | ⑤ 的重试上限（doc 12 SYS-02：≤3 次）落地时一起定 |
| Q-4 | 队列是否要「按技能/语言分配」 | 只有 `assignee` | v1.0 单租户小团队，不需要；要了再加 `routing_policy` |
| Q-5 | 抽查/复核 ACCEPTED 的样本 | 被 §4.3 禁止 | 若产品要抽样质检，另建 `audit_sample` 表，不要污染兜底队列的指标 |

---

## 10. 怎么验（真实命令 + 判据）

```powershell
$env:PGPASSWORD='123456'; $psql='D:\12412\PostgreSQL\bin\psql.exe'
& $psql -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE IF EXISTS ra_queue_check WITH (FORCE);" -c "CREATE DATABASE ra_queue_check;"
& $psql -U postgres -h 127.0.0.1 -d ra_queue_check -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
& $psql -U postgres -h 127.0.0.1 -d ra_queue_check -v ON_ERROR_STOP=1 -f db/migrations/0003_review_queue.sql
& $psql -U postgres -h 127.0.0.1 -d ra_queue_check -v ON_ERROR_STOP=1 -f db/migrations/0003_review_queue.sql   # 第二遍：幂等
& $psql -U postgres -h 127.0.0.1 -d ra_queue_check -v ON_ERROR_STOP=1 -f db/verify-0003.sql
```

**通过判据**（全部是 exit code 0，不接受「看着对」）：

| 检查 | 期望 |
|---|---|
| 迁移第一遍 / 第二遍 | 都 `exit=0`，对象数不变（在**只有 0001+0003** 的库上实测 42 表 / 80 触发器 / 3 视图 / 15 函数 / 133 索引，第二、三遍完全一致） |
| `verify-0003.sql` §2 | 12 条结构断言全 PASS（字段数 16/13/9、约束数 19/18/8 都是**精确断言**） |
| §3 | 36 格矩阵打印；断言 8 条边；`QUEUED→APPROVED` 等被拒 |
| §4 | 一条完整正例：入队 → 受理 → 补正 → 放行；4 条审计按 `audit_seq` 查回；gate 从 `PENDING_REVIEW` 变 `CLEARED` |
| §4.7.1 / §4.8.1 | 旧 `record_version` 更新 0 行；deadline 只能延长，且内容编辑也留痕（`QUEUED→QUEUED`） |
| §4.12 | 故意漏记 1 条（R3）→ `UNACCOUNTED` + `blocking=true`，证明「漏记能被发现」 |
| §5 | **25 条负向测试**全部按预期被拒，且 SQLSTATE 逐条比对 |
| §6 | 收尾计数 `8 runs / 5 条目 / 12 条审计 / 1 条漏记`，负向测试零残留 |

`verify-0003.sql` 最后 `ROLLBACK`：**不往库里留任何数据**。

---

## 11. 常见报错 → 正确反应

| 报错前缀 | SQLSTATE | 含义 | 正确反应 |
|---|---|---|---|
| `QUEUE_ILLEGAL_TRANSITION` | 23514 | 走了 8 条边之外的迁移 | 先认领再决策；终态不可回退 |
| `QUEUE_CORRECTED_NEEDS_HUMAN_RESULT` | 23514 | `CORRECTED` 没写 `human_result` | 同一条 UPDATE 里写 `human_result` |
| `QUEUE_REASON_REQUIRED` | 23514 | 终态沿用了上一手理由 | 写本次决策理由 |
| `QUEUE_IMMUTABLE` | 23514 | 改了 `machine_result` 等免疫列 | 新增 `human_result`，别覆盖机器结果 |
| `QUEUE_DEADLINE_NOT_EXTENDED` | 23514 | 想缩短 deadline | 只能延长；要提前升级走告警 |
| `QUEUE_DEADLINE_CLOSED` / `QUEUE_CLOSED_AT_TRIGGER_ONLY` | 23514 | 已结案改 deadline / 手写 `closed_at` | 交给触发器 |
| `QUEUE_BAD_INITIAL_STATE` | 23514 | 新条目不是 `QUEUED`，或带了 `human_result`/`closed_at` | 入队只能是 `QUEUED` |
| `QUEUE_ACCEPTED_RUN` | 23514 | 把 `ACCEPTED` 的 run 入队 | 兜底队列只收机器判不了的 |
| `QUEUE_RUN_NOT_FOUND` | 23503 | run 不存在或不属于该租户 | 检查 `tenant_id`/`run_id` |
| 唯一约束冲突 | 23505 | 同一 run 重复入队 / 重复审计 | 复用已有条目，不要重复入队 |
| `ACTOR_REQUIRED` | 23514 | 没 `SET LOCAL recruitment.actor_id` | 每次事务开头设置（D-18） |
| `ACTOR_TENANT_MISMATCH` | 23503 | actor 不属于该租户 | 检查 actor 与 tenant |
| `IMMUTABLE_COLUMN` | 23514 | 改了 `conversion_run` / `review_audit` | 历史只能追加，不能改 |
| `DELETE_FORBIDDEN` | 23514 | 物理删了历史事实 | 软关闭 / 新建条目 |

---

## 12. 与 0001 的关系

- **不改 0001**：本迁移只新增对象；`organization` / `actor` / `fn_block_delete` / `fn_guard_columns` 直接复用。
- **沿用 0001 的约定**：`recruitment` schema、uuid 主键、`tenant_id NOT NULL` + 外键、状态用 `text + CHECK`、actor 用 `SET LOCAL`、历史禁删、幂等迁移。
- **不沿用 `fn_row_guard`**：它假定主键列叫 `id`、每表有 `status_changed_*` 且要写 `event_inbox`。队列的「状态变更」语义是**队列状态机 + 人工审计**，不是业务对象的 `status` 轴；硬套会产生「每条队列表项都往事件表写事件」的噪声。所以本迁移用专用 guard（§4/§5），错误码前缀也独立（`QUEUE_*`）。
- **依赖 0001 但不依赖 0002**：`0003` 前置检查会显式报 `MIGRATION_PRECONDITION`（而不是在某条 SQL 上莫名失败）。

### 12.1 与 `db/verify.sql` 的两处冲突（**需要总控裁决，本迁移无权改 verify.sql**）

`db/verify.sql` 里有两类**全局**结构断言，写的是 0001 的形状；0003 按任务书故意不同，因此现在跑 `verify.sql` 会在第一条就停：

| 断言 | 现状 | 冲突原因 | 最小改法（由 verify.sql 的属主改） |
|---|---|---|---|
| `STRUCT-01` | `exit 3`：`这些表的主键不是单列 id/event_id：review_queue, review_audit, conversion_run` | 任务书要求主键叫 `run_id` / `item_id` / `audit_id`；0001 假定一律 `id`（`event_inbox` 是唯一例外） | 把 `in (array['id'], array['event_id'])` 扩成 `..., array['run_id'], array['item_id'], array['audit_id']`（或直接放宽为「单列 uuid 主键」） |
| `STRUCT-05` | 修掉上一条后报：`这些表有状态列但没有 fn_row_guard 触发器：conversion_run, review_queue` | 这两个表的状态语义不是业务对象的 `status` 轴：`conversion_run` 是 append-only（根本没有 UPDATE），`review_queue` 用专用状态机 + `review_audit`。硬套 `fn_row_guard` 会要求给它们加 `status_changed_*` 并向 `event_inbox` 写事件（**为了过检查而接一条永不执行的触发器**，属 R2 假接线） | 在该检查里排除 `conversion_run` / `review_queue`，注释说明它们由 `trg_conversion_run_immutable` / `trg_review_queue_before_update` / `trg_review_queue_audit` 覆盖 |

**实测**：把上面两处按最小改法改到一份**临时副本**（未改仓库里的 `verify.sql`）后，`verify.sql` 在同一库上 `VERIFY PASS`、`exit 0`、32/32 负向测试通过、禁删触发器 41 个。

> 这两条不是 0003 的缺陷，而是「0001 的全局断言」与「0003 的局部设计」之间的口径差。按 R5，口径必须由唯一权威源裁决；本迁移只负责把冲突连同证据摆出来。
