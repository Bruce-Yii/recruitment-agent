# 候选人身份状态机（S6 的一部分 · merge / split state machine）

**日期**：2026-11-13
**配套**：`identity-resolution-rules.md`（下称 `IR`）。规则怎么判在 `IR`，状态怎么走在这里。
**范围**：`candidate.identity_status` 的取值、迁移、审计与非法迁移。
**性质**：合同。不含实现代码。**没有一条迁移允许"悄悄发生"**——每条都要能回答「谁、依据什么、多确定、什么时候」。

---

## 0. 一句话

> **身份状态只有三种结局：这条档案仍代表一个独立当事人 / 这条档案已被另一条吸收 / 还没有裁决。**
> 第三种**不存放在 `candidate.identity_status` 里**（理由在 §2.2，是结构性论据不是偏好）；它是一条待复核项，挂在档案旁边。

---

## 1. 状态定义

### 1.1 契约三态（`IR` 全文使用的名字）

| 契约态 | 含义 | 读者该理解成 | 不是 |
|---|---|---|---|
| `IDENTITY_ACTIVE` | 单条：这条档案就是这个当事人 | 可以往它身上写申请、筛选、面试 | 「已验证」——不代表身份核实过，只代表没人主张它是别人的重复档 |
| `IDENTITY_MERGED` | 已合并：这条档案已被吸收进另一条 | **只读历史**：不能写新申请、不能进筛选、读取必须跟随指针 | 「已删除」——行还在，`INV-2` 要求历史全留 |
| `IDENTITY_REVIEW` | 待人工：一个解析尝试还没裁决 | **档案本身没有这个状态**；是"某个 attempt 悬着" | 档案的第三种 `identity_status` |

### 1.2 待复核项（`identity_review`）与解析尝试（`identity_attempt`）

| 对象 | 作用 | v1.0 落点 | 依据 |
|---|---|---|---|
| `identity_attempt` | 一次「这份材料是谁」的判定 + 依据（字段级 provenance/evidence） | 无表 → `event_inbox.payload`（`provider='internal'`，`correlation_id=attempt_id`）+ 合并时把 `attempt_id` 写进 `match_basis` | `IR §13 G-2/G-4` |
| `identity_review` | 待人工项：`OPEN` / `RESOLVED_SAME` / `RESOLVED_DIFFERENT` / `EXPIRED` | **来料侧**可落工作区已有的 `0003` `review_queue`（`status='QUEUED'`，`machine_result` 带 `kind/subject_candidate_ids/proposed_match_basis`）；**但它以 `run_id`(=`conversion_run`) 为锚且 `uq_review_queue_run`（`0003:217-264`），承载不了"两条既有档案要不要合并"这类没有 run 的复核** → 那一类只能作为 Human Attention Inbox 的聚合项，独立表留到 0002 | `docs03 §7`（`03-domain-and-runtime.md:134`）；`0003:217-264`（**工作区已有、尚未合入**，本行按"若已落地"表述） |

`identity_review` 必带：`tenant_id`、`kind ∈ {MERGE_CONFLICT_ID_NAME, NAME_UNVERIFIED, PROVENANCE_NOT_AUTOMATABLE, WEAK_MATCH, MULTIPLE_STRONG_MATCH, SHARED_MAILBOX, POLICY_MANUAL_ONLY}`、`subject_candidate_ids[]`、`subject_intake_record_id`、`proposed_match_basis`、`created_at`、`opened_by`（`SYSTEM` 或 actor）、`status`、`resolved_by`/`resolved_at`/`resolution_reason`。

---

## 2. 载体裁决：为什么"待人工"不写进 `candidate.identity_status`

### 2.1 库现状（实测）

| 事实 | 出处 |
|---|---|
| `ck_candidate_identity_status check (identity_status in ('ACTIVE','MERGED'))` | `0001_init.sql:740` |
| 强标识唯一性建立在**部分唯一索引**上，谓词是 `identity_status='ACTIVE'` | `0001_init.sql:755-758`（`uq_candidate_active_email` / `uq_candidate_active_phone`） |
| 身份状态变更必须"存在一条 merge 记录" | `fn_candidate_identity_guard`，`0001:172-183` |
| `candidate` **没有** `status_changed_at/by/source_event` 三列；`fn_row_guard` 也不覆盖 `identity_status` | `0001:725-751`；`verify.sql STRUCT-05` 只查 `status/lifecycle_status/transcript_status` |
| `candidate_merge` 整行不可 UPDATE | `trg_candidate_merge_immutable`，`0001:1783/1789-1792` |

### 2.2 裁决（R1 采用，R2 否决）

**R1（采用）**：`identity_status` 保持两值。`IDENTITY_REVIEW` 由 `identity_review` 承载，档案保持 `ACTIVE`。

**R2（否决）**：给 CHECK 加 `'PENDING_REVIEW'`。**否决理由是结构性的**：`uq_candidate_active_email/phone` 的谓词写死为 `identity_status='ACTIVE'`，一旦出现第三个"非 `MERGED`"值，同一手机号/邮箱就能同时挂在两条 `PENDING_REVIEW` 档案上——**强标识唯一性当场失效**，而这正是 `N26`（`SCHEMA §12`）要守的东西。要修就得同时改两个索引的谓词为 `identity_status <> 'MERGED'`，那是 0002 的范围，且会改变"合并后同号可共存"的现有语义。

**R1 的代价（说清楚）**：`ACTIVE` 档案旁边可能挂着一条 `OPEN` 的 review，读端必须知道"这条档案有未决重复问题"。因此 `IR` 要求：任何列表/详情接口返回 `identity_review_open: true|false`，**不得**让前端靠"有没有 merge 记录"去猜。

### 2.3 载体对照表

| 契约态 | 库内可见？ | 落点 | 读端判定 |
|---|---|---|---|
| `IDENTITY_ACTIVE` | ✅ | `candidate.identity_status='ACTIVE'` ∧ `merged_into_candidate_id IS NULL` ∧ `merge_id IS NULL` | 三者同时成立才认 |
| `IDENTITY_MERGED` | ✅ | `identity_status='MERGED'` ∧ `merged_into` 非空 ∧ `merge_id` 非空（`ck_candidate_merged_fields`） | 三者缺一 → `IDENTITY_STATE_INCONSISTENT` |
| `IDENTITY_REVIEW` | ❌（档案上） | `identity_review.status='OPEN'`，`subject_candidate_ids` 含该档或该 intake | 按 review 查，不按档案状态查 |

> 半合并行是**可能的**：`ck_candidate_merged_fields` 只约束 `MERGED` 行，所以 `ACTIVE` 行带着 `merged_into` 也能存进去（`IR §10.3 S-2`）。读端必须按上表三条件判定，不能只读 `identity_status`。

---

## 3. 合法迁移（穷举）

每条迁移都必须满足：`tenant` 不变 · 前置谓词全真 · 五元组可写（§4）· 单事务。**表里没有的迁移就是非法迁移**（§5）。

| # | From → To | 触发 | 前置谓词 | 写入的行 | 审计落点 | 失败码 |
|---|---|---|---|---|---|---|
| **T1** | ∅ → `IDENTITY_ACTIVE` | `SYSTEM` 或 `HUMAN` | `IR §5.4 D2`（`HIT=∅` ∧ ¬`WEAK_EQ`）或人工裁决"不同人" | `INSERT candidate`（`identity_status` 用默认值） | `identity_attempt.decision=CREATE_CANDIDATE` + `event_inbox` 内部事件 | `VERSION_CONFLICT` / `TENANT_MISMATCH` |
| **T2** | `IDENTITY_ACTIVE` → `IDENTITY_MERGED` | `SYSTEM`（`auto_merged=true`） | `IR §5.4 D5`（交叉印证）或 `D15`（单命中且旧档 `ESTABLISHED`）全真 ∧ `blockers=[]` ∧ `policy=AUTO_HIGH_CONFIDENCE` ＋ `IR §6.1` 方向全序 | `INSERT candidate_merge(auto_merged=true, decided_by_actor_id=SYSTEM_ACTOR, match_basis=§6.6)` | 该 merge 行（触发器回写 `candidate.identity_status/merged_into/merge_id`） | `23514 MERGE_TARGET_NOT_ACTIVE` / `23505 MERGE_PAIR_ALREADY_DECIDED` / `VERSION_CONFLICT` |
| **T3** | `IDENTITY_ACTIVE` → `IDENTITY_MERGED` | `HUMAN`（`auto_merged=false`） | `IR §5.4` 判为 `REVIEW` 后由人裁决"同一人"；两条均 `ACTIVE`；actor 有 `merge_candidate` 权限 | 同 T2，但 `decided_by_actor_id` 必为非空 human actor，`match_basis.rule='MANUAL_CONFIRM'`、`direction_rule='HUMAN_CHOICE'` | 同 T2 | `403 ACTOR_FORBIDDEN` / `23505` / `VERSION_CONFLICT` |
| **T4** | ∅ → `IDENTITY_REVIEW` | `SYSTEM` 或 `HUMAN` | `IR §5.4` 判为 `REVIEW(*)，或人工主动发起复核 | **不写 `candidate_merge`**；`identity_review` 插 `OPEN`；可选把 `intake_record.status` 置 `NEEDS_REVIEW` | review 项（含 `proposed_match_basis`、`opened_by`、`created_at`） | `ALREADY_PARKED`（同 intake 已有 OPEN → 复用，不新建） |
| **T5** | `IDENTITY_REVIEW` → 终局（不落档案） | `HUMAN` | 人看完双方档案 | ① 判"同一人" ∧ 材料无自有档 → `LINK_EXISTING`（**无身份迁移**）；② 判"同一人" ∧ 两条既有档 → 走 **T3**；③ 判"不同人" → 走 **T1** | review → `RESOLVED_SAME` / `RESOLVED_DIFFERENT` + `resolved_by/at/reason` | `403` / `409` |
| **T6** | `IDENTITY_MERGED` → `IDENTITY_ACTIVE` | `HUMAN` | `IR §7.2 X1–X6` **全真**；拆分审计载体已存在 | 先释放 survivor 上由被合并方采纳的标识 → 再改本条（`identity_status='ACTIVE'`，清 `merged_into/merge_id`，按 snapshot 还原标识）→ `INSERT` 拆分记录 | 拆分记录（引用 `merge_id` 的 `R0`、`split_by_actor_id`、`split_at`、`reason`、`restored_fields`、原件 sha256） | `409 SPLIT_REQUIRES_SCHEMA`（**当前 v1.0 就是这条**）/ `409 SPLIT_SNAPSHOT_MISSING` / `409 SPLIT_IDENTIFIER_CONFLICT` / `VERSION_CONFLICT` |

**T6 的现状**：`0001` 里没有拆分审计载体（`IR §13 G-3`）。所以 **T6 今天一律返回 `SPLIT_REQUIRES_SCHEMA`**——这不是"没实现"，是**有意关闸**：宁可让 HR 看到"暂不支持撤销合并"，也不能让一次没有审计的 `MERGED→ACTIVE` 混进历史（见 §5 I-3）。

---

## 4. 每次迁移必须记录的 5 项（缺一项就不许迁移）

| # | 要求 | 载体（v1.0 唯一可用） | 谁拦 | 缺了会怎样 |
|---|---|---|---|---|
| 1 | **谁触发**：人工 / 自动 | `candidate_merge.auto_merged` + `decided_by_actor_id`（契约要求 auto 时也必须非空 = `SYSTEM` actor，`IR §10.3 S-1`） | 库只拦一半：`ck_candidate_merge_actor` 仅要求"`auto_merged=false` 时 actor 非空" | auto 且 actor 空 ⇒ "谁触发"永久丢失，只剩一个布尔 |
| 2 | **依据哪些字段** | `match_basis.strong_ids / weak_ids / rule / provenance / evidence` | `ck_candidate_merge_basis`（非空对象，`N25`）拦"完全没依据"，**拦不住"依据不充分"** | 事后无法回答"凭什么把这两个人并了" |
| 3 | **置信度** | `match_basis.confidence.band ∈ {HIGH, MEDIUM, LOW}`（枚举，禁止自由数值，`IR-F8`） | 无 | 无法区分"规则命中"与"人拍板" |
| 4 | **时间** | `candidate_merge.decided_at`（决策时刻；业务发生时间另记，`docs03 §19`） | `ck_candidate_merge_time`（`decided_at >= created_at`） | 无法回溯"当时的档案版本" |
| 5 | **依据的档案版本** | `match_basis.record_versions.{surviving, merged}` + `attempt_id` | 无（只能契约 + 测试） | 档案在合并后又变了的话，复核时看到的是"现在"而不是"当时" |

**迁移前自检清单**（实现者按此校验，任一为否则抛错而不是"尽力而为"）：

```
1) 两条档案 tenant_id 相同，且等于请求上下文租户
2) 两条都是 IDENTITY_ACTIVE（T2/T3）或本条是 MERGED 且指针自洽（T6）
3) expected_record_version 双方都匹配（IR-M4a）
4) match_basis 必填键齐（§IR 6.6），且 confidence.band ∈ 枚举
5) decided_via 与 auto_merged 一致；auto_merged=true 时 decided_by_actor_id = SYSTEM actor
6) 执行者 ≠ AGENT_WORKER（IR-M5；库层另有一道 mandate CHECK）
7) 同一事务内完成；提交后返回新 record_version
```

---

## 5. 非法迁移（穷举 + 谁拦得住）

「**库拦**」= DB 会报错；「**契约拦**」= 库不报错，只能靠服务层/测试拦。**这一列是本文最重要的信息**：凡是「契约拦」的，都不能假装数据库保证了它。

| # | 非法迁移 | 期望错误码 | 谁拦 | 依据 |
|---|---|---|---|---|
| **I-1** | `ACTIVE → MERGED` 直接 `UPDATE`，没有 merge 记录 | `23514 CANDIDATE_IDENTITY_UNTRACKED` | **库拦**（`fn_candidate_identity_guard`） | `0001:172-183`、`N24` |
| **I-2** | 对 `MERGED` 档再加一条 merge（让它当 survivor） | `23514 MERGE_SURVIVOR_NOT_ACTIVE` | **库拦**（`fn_candidate_merge_apply`） | `0001:189-195` |
| **I-3** | **`MERGED → ACTIVE` 直接改回，不走拆分** | 必须 `409 SPLIT_REQUIRES_SCHEMA` | ⚠️ **库拦不住**：guard 只要求"存在一条 `merged_candidate_id=本行` 的 merge 记录"，而拆分场景下那条记录**本来就在**（`0001:176-178`）→ 直接 `UPDATE` 会被放行，且不留任何新审计 | `IR §12-④`、`IR-X`、`G-3` |
| **I-4** | `ACTIVE` 行上写 `merged_into/merge_id`（半合并） | `422 IDENTITY_STATE_INCONSISTENT` | ⚠️ **库拦不住**：`ck_candidate_merged_fields` 只约束 `MERGED` 行（`0001:749-750`） | `IR §10.3 S-2` |
| **I-5** | 同一 `(surviving, merged)` 对二次合并 | `23505 MERGE_PAIR_ALREADY_DECIDED` | **库拦**（`uq_candidate_merge_pair`） | `0001:773`、`IR-M4b` |
| **I-6** | 拆分后**翻转 survivor 方向**再合并同一对（绕过 `uq pair`） | `422 MERGE_DIRECTION_FORGERY` | ⚠️ **库基本拦不住**：`(A,B)` 与 `(B,A)` 是两个不同的对，`uq_candidate_merge_pair` 只拦"一模一样的对"；只有在翻转方向恰好也被用过时才 `23505` | `IR §7.4`、`G-6` |
| **I-7** | 跨租户合并 | `23503` | **库拦**（`fk_candidate_merge_surviving/merged` 是复合外键） | `SCHEMA §1`、`N03` |
| **I-8** | 删除任一档案 | `23514 DELETE_FORBIDDEN` | **库拦**（`trg_candidate_no_delete`） | `INV-2`、`N20` |
| **I-9** | `UPDATE candidate_merge`（含改 `match_basis`） | `23514 IMMUTABLE_COLUMN` | **库拦**（`fn_guard_columns`，`tg_argv` 为空 = 全列禁止） | `0001:1783/1789-1792` |
| **I-10** | 同一对档案反复"合并/撤销/合并" | `409` | 契约拦（`uq pair` 只拦首次后的重复合并，撤销路径本身已被 T6 关闸） | `G-6` |
| **I-11** | 合并时改写/迁移/删除 `application` | `403 APPLICATION_REATTRIBUTION_FORBIDDEN` | ⚠️ **库拦不住**（`fk_application_candidate` 允许任意同租户档案） | `INV-2`、`IR-F6` |
| **I-12** | 对 `MERGED` 档写新 `application` / `resume` / `decision` | `409 WRITE_ON_MERGED_CANDIDATE` | ⚠️ **库拦不住**（外键只校验存在） | `IR-F11` |
| **I-13** | 自动合并但 `match_basis.strong_ids` 为空 | `422 AUTO_MERGE_WITHOUT_STRONG_ID` | ⚠️ 契约拦（`ck_candidate_merge_basis` 只拦空对象） | `IR-F1`、`doc11 §9.7` |
| **I-14** | `auto_merged=true` 但 `decided_by_actor_id IS NULL` | `422 MERGE_ACTOR_REQUIRED` | ⚠️ **库拦不住**（`ck_candidate_merge_actor` 允许 auto 空 actor） | `IR §10.3 S-1`、`D-18` |
| **I-15** | 用 `review` 当档案状态（把 `ACTIVE` 档"改成待人工"） | 不允许——**无此迁移** | 契约拦（§3 无此行） | §2.2 R1 |

> 读法：15 条非法迁移里 **8 条库拦不住**。实现者若把"数据库没报错"当"合规"，会在 I-3/I-4/I-11/I-12/I-14 上全部踩空。负向测试必须按 §11 逐条覆盖，不能只跑 `verify.sql`。

---

## 6. 并发、幂等、原子性

| # | 规则 | 说明 |
|---|---|---|
| C-1 | 合并/拆分命令携带双方 `expected_record_version`；任一不符 → `409 VERSION_CONFLICT`，**不自动重试** | `IR-M4a`；`docs03 §18` |
| C-2 | 单事务：`SELECT … FOR UPDATE` → 校验 → 写 → `COMMIT`；**不允许"状态已改、记录后补"** | `IR-M4c` |
| C-3 | 幂等键 = `match_basis.command_id`；同键重放返回既有结果，异键同 pair → `409` | `IR-M4b` |
| C-4 | actor 用 `SET LOCAL recruitment.actor_id`（不是 `SET`：连接池会泄漏，责任人记错且**静默**） | `D-18` |
| C-5 | 提交后**必须**返回新 `record_version`（`fn_touch` 每次 UPDATE +1）；调用方不得缓存旧值 | `D-18`、`0001:1819-1822` |
| C-6 | 两个并发请求争同一 pair：一个成功，另一个拿到 `23505`（唯一索引兜底）→ 翻译成 `409`，不得重试成第二条记录 | `IR-M4b` |

---

## 7. 读路径与写路径（状态机的对外语义）

### 7.1 解析（`resolve`）

```
resolve(c):
  seen = ∅
  while c.identity_status = 'MERGED':
      if c.merged_into IS NULL or c.merge_id IS NULL: raise IDENTITY_STATE_INCONSISTENT
      if c.id ∈ seen:                               raise IDENTITY_CHAIN_CYCLE
      seen.add(c.id); if |seen| > 8:                raise IDENTITY_CHAIN_DEPTH_EXCEEDED
      c = load(c.merged_into)
  return c
```

- **链是合法的**：`merge A→B` 之后再 `merge B→C`，`A` 必须解析到 `C`（`IR §12-②`）。只看一跳会停在 `MERGED` 行上，前端就会显示"已合并到 B"，而 B 自己也是 `MERGED`。
- 环在正常写入下不可能产生（survivor 必须是 `ACTIVE`），但**读端仍必须检测**：数据修复、0002 迁移、手工 SQL 都可能造环，而"读的时候死循环"比"报错"严重得多。

### 7.2 写必须朝向存活档

| 写操作 | 规则 | 错误码 |
|---|---|---|
| 新 `application` | 先 `resolve()`；目标为 `MERGED` → 拒绝或解析后写 | `409 WRITE_ON_MERGED_CANDIDATE`（I-12） |
| 新 `resume` 关联 | 同上 | 同上 |
| 新 `decision` / `scorecard` 关联链 | 一律经 `application`，不改 `candidate_id` | `403 APPLICATION_REATTRIBUTION_FORBIDDEN`（I-11） |

### 7.3 与 Application 四轴的关系（`INV-2`）

| 事实 | 规则 |
|---|---|
| 合并**不改** `application` 任何列 | `INV-2`、`IR-M3`；`verify.sql POS-05` 已断言"合并后申请条数不变" |
| 合并不改 `lifecycle_status` / `current_stage_code` | 身份 ≠ 招聘进度（`docs03 §4`：「Candidate 的全局身份状态不等于某一条 Application 的招聘进度」） |
| 拆分**也不改** `application` | 申请本来就各自指向自己的档案，拆分天然正确 |
| 「这个人的全部申请」 | 等价类上的并集，按 `application.id` 去重（`IR-M3`） |

---

## 8. 状态图（含 attempt / review 两个外挂对象）

```
                    ┌──────────────── identity_attempt ────────────────┐
                    │ CREATE_CANDIDATE  LINK_EXISTING  AUTO_MERGE       │
                    │ MANUAL_MERGE      REVIEW(*)[+review OPEN]         │
                    │ REJECT_CROSS_TENANT（无对象可写，只落拒因）        │
                    └───────────────┬──────────────────┬───────────────┘
                                    │                  │
              ┌─────────────────────┘                  └──────────────┐
              ▼                                                        ▼
   (无档案) ──T1──►  IDENTITY_ACTIVE  ◄──T6（SPLIT，当前 409）──  IDENTITY_MERGED
                        │      ▲                                        ▲
                   T2/T3│      │T5③（判"不同人"→ T1 新建）               │
                        ▼      │                                        │
                   IDENTITY_MERGED ──T6──► IDENTITY_ACTIVE              │
                        │                                               │
                        └──────── T4：不落档案，挂 review ──────────────┘
                                        │
                              IDENTITY_REVIEW ──T5①──► LINK_EXISTING（无迁移）
                                             ──T5②──► T3
                                             ──T5③──► T1
```

---

## 9. 不变量（可断言）

| # | 不变量 | 断言方式 |
|---|---|---|
| IN-1 | 任一档案的 `identity_status ∈ {ACTIVE, MERGED}`，且 `MERGED` 必有 `merged_into + merge_id` | 库 CHECK（`ck_candidate_merged_fields`） |
| IN-2 | `ACTIVE` 行的 `merged_into/merge_id` 必须为空 | 契约 + 扫描（库不拦，I-4） |
| IN-3 | 同租户内，同一强标识最多一条 `ACTIVE` | 库部分唯一索引（`uq_candidate_active_email/phone`） |
| IN-4 | 每条 `candidate_merge` 的 `match_basis` 含 §IR 6.6 必填键 | 库只保证非空，其余靠 schema 校验 |
| IN-5 | `auto_merged=true` ⇒ `decided_by_actor_id` = `SYSTEM` actor 且 `confidence.band='HIGH'` | 契约（库不拦，I-14） |
| IN-6 | `auto_merged` 与 `match_basis.decided_via` 一致 | 契约 |
| IN-7 | 合并前后 `application` 行数、内容不变 | `verify.sql POS-05` + 快照对比 |
| IN-8 | `resolve()` 对所有 `MERGED` 行终止于唯一 `ACTIVE` 行，无环、深度 ≤ 8 | 读端断言 + 定期扫描任务 |
| IN-9 | 每条身份迁移都有对应 attempt；每条 split 都有对应拆分记录 | 契约 + 审计查询（当前 split 一律关闸，所以此条恒真） |
| IN-10 | 不存在跨租户的 `candidate_merge` 行 | 库复合外键 + 审计查询 |

---

## 10. 与 `IR §11` 十个用例的迁移视角

| 用例 | 迁移 | 写入 | 当前可执行？ |
|---|---|---|---|
| E1 同手机同姓名 | **T2**（自动） | 1 条 `candidate_merge`（`match_basis` 全键） | ✅（`policy=AUTO_HIGH_CONFIDENCE` 时） |
| E2 同手机不同姓名 | **T4** | `identity_review(OPEN, MERGE_CONFLICT_ID_NAME)`；**不写 merge** | ✅ |
| E3 同姓名不同手机 | **T1** | `INSERT candidate` + attempt | ✅（若公司或学校也同 → T4/WEAK_MATCH） |
| E4 只有姓名相同 | **T1** | 同上，**不产生 review** | ✅ |
| E5 OCR 手机号 | **T4** | `identity_review(OPEN, PROVENANCE_NOT_AUTOMATABLE)` | ✅ |
| E6 一人投两岗 | **无迁移**（`LINK_EXISTING`） | 1 条 `application` + resume 关联；`identity_status` 不变 | ✅ |
| E7 合并后撤销 | **T6** 目标态；今天 **T6 关闸** | 应写拆分记录（载体缺失） | ❌ `409 SPLIT_REQUIRES_SCHEMA` |
| E8 跨租户 | **无迁移**（`REJECT_CROSS_TENANT` / 对他租户即 T1） | 拒绝原因入 attempt；不触碰 T1 档案 | ✅ |
| E9 邮箱大小写 | **T2** | 同 E1（`norm_email` 后相等） | ✅ |
| E10 手机 ±86 | **T2** | 同 E1（`norm_phone` 后相等） | ✅ |

---

## 11. 必须有的负向测试（10 条，按 §5 的"谁拦"分层）

| # | 用例 | 期望 | 层 |
|---|---|---|---|
| N-1 | `UPDATE candidate SET identity_status='MERGED'` 无 merge 记录 | `23514 CANDIDATE_IDENTITY_UNTRACKED` | 库（`N24` 已覆盖） |
| N-2 | 对 `MERGED` 档插 merge（当 survivor） | `23514 MERGE_SURVIVOR_NOT_ACTIVE` | 库 |
| N-3 | **`MERGED→ACTIVE` 直接 UPDATE，无拆分记录** | 服务层必须 `409 SPLIT_REQUIRES_SCHEMA`；**若服务层放行，库不会报错** | 契约（**新增，必须写**） |
| N-4 | `ACTIVE` 行写 `merged_into` | `422 IDENTITY_STATE_INCONSISTENT` | 契约（新增） |
| N-5 | 同 pair 二次 merge | `23505 MERGE_PAIR_ALREADY_DECIDED` | 库 |
| N-6 | 跨租户 merge | `23503` | 库（`N03` 同类） |
| N-7 | `match_basis={}` | `23514`（`ck_candidate_merge_basis`） | 库（`N25` 已覆盖） |
| N-8 | `auto_merged=true` + `decided_by_actor_id NULL` | `422 MERGE_ACTOR_REQUIRED` | 契约（新增） |
| N-9 | 合并后 `UPDATE application SET candidate_id=…` | `403 APPLICATION_REATTRIBUTION_FORBIDDEN` | 契约（新增） |
| N-10 | 对 `MERGED` 档建 `application` | `409 WRITE_ON_MERGED_CANDIDATE` | 契约（新增） |

> `verify.sql` 现有 `N20/N24/N25/N26` 只覆盖其中 4 条（都是"库拦"那半边）。新增 6 条必须由服务层测试承接——**否则这 6 个洞永远不会有人发现**。

---

## 12. 缺口与 0002 需求（状态机视角）

| # | 缺什么 | 状态机上的后果 | 需要什么 |
|---|---|---|---|
| G-1 | 第三态无落点 | 已用 R1 绕开（§2.2），**不需要改 CHECK** | 无（若产品坚持要落列，见 §2.2 R2 的反驳） |
| G-2 | 字段级 provenance 无载体 | T2 的"依据"只剩值相等，无法证明"来源可考" | `candidate_identity_attempt` 表（或 `event_inbox.payload` 兜底） |
| G-3 | 拆分审计无载体 | **T6 关闸**（E7 不可执行） | `candidate_split`（不可变）+ 扩展 identity guard：`MERGED→ACTIVE` 必须存在引用它的 split 记录 |
| G-4 | attempt 无表 | T1/T4 的依据无处可查 | 同 G-2 |
| G-6 | pair 永久占位 | 拆分后无法再合并同一对 | `uq_candidate_merge_pair` → "每个 pair 只允许一条当前生效裁决" + `superseded_by_merge_id` |

**建议的 0002 最小集**（不含 DDL，只列对象与语义）：

1. `candidate_identity_attempt`：不可变，含 `tenant_id, intake_record_id, resume_version_id, decision, rule, confidence_band, blockers[], fields jsonb（字段级 raw/norm/state/provenance/evidence）, decided_by_actor_id, decided_at`。
2. `candidate_split`：不可变，含 `id, tenant_id, merge_id（引用被撤销的 merge）, restored_candidate_id, split_by_actor_id, split_at, reason, restored_fields jsonb, source_sha256`。
3. 身份 guard 扩展：`identity_status` 从 `MERGED` 变为 `ACTIVE` 时，必须存在 `candidate_split` 行（`restored_candidate_id = new.id` 且引用同一 `merge_id`），否则 `23514 CANDIDATE_SPLIT_UNTRACKED`。
4. `uq_candidate_merge_pair` 收窄为部分唯一索引（仅"未被 supersede"的裁决）。

---

## 13. 未决（与 `IR §15` P-1…P-6 同一组，此处只列状态机相关的）

| # | 问题 | 我的建议 | 不裁决的后果 |
|---|---|---|---|
| S-1 | T6（拆分）在 v1.0 是否接受"关闸" | **接受**，但 UI 必须明说"暂不支持撤销合并，请联系管理员"，并留工单字段 | HR 会以为点了没反应，转而手工改库（最坏结果） |
| S-2 | `identity_review` 是否要独立表（还是只做 Inbox 聚合） | v1.0 只做聚合 + `event_inbox` 留痕；表留到 0002 | 无独立表时"谁处理了哪条"只能靠事件流回溯 |
| S-3 | `SYSTEM` actor 是否先 seed | **必须先 seed**（`D-14` 已要求补 seed），否则 T2 写不出 `decided_by_actor_id` | 自动合并无法合规执行，只能退回 `MANUAL_ONLY` |
