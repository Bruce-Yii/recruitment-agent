# stage-advance/tool-contracts.md · `recruitment_application_stage_advance`

**契约版本**：`stage-advance 1.1.0`（2026-11-14；1.1 起 blocker/warning 带**结构化责任人 + 下一步**，并新增只读阻塞视图）
**状态**：本 lane 交付（**待独立复核**；实现者不验收自己的工作）
**覆盖范围**：一个工具 —— `recruitment_application_stage_advance`（阶段推进的**唯一写入口**），
外加一个**只读**的阻塞视图函数 `readStageBlockedView`（供工作台直接用，不是工具、不注册）。
**实现**：`src/tools/stage-advance.ts`（胶水：入参/事务/标签）+ `src/domain/stage-advance.ts`（判定/责任推导/版本守卫/时间戳/只读视图）。
**测试**：`test/unit/stage-advance.test.ts`（假库：判定矩阵 + 零 UPDATE + 并发错误映射 + 结构化责任 + 视图）、
`test/integration/stage-advance.test.ts`（真库：A1–A9 全部读库回验）。
**位置在哪个缺口**：`docs/23` N8 / P1-09（阶段推进无入口）、`docs/18` §3.7 第 ① 条；
`§11.6-8`（HR 能从工作台理解「状态 + 阻塞原因 + 责任人 + 下一步」）。
**阶段码权威**：`recruitment.stage_catalog`（见 `contracts/STAGE-CODES.md`）；本文件不新增、不改名任何阶段码。
**与其它契约冲突时**：本文件只覆盖这一个工具与这一个视图；`decision` 的写侧以
`contracts/evaluation/decision-rules.md` §17.1 为准，S7 评估以 `contracts/job-screening/tool-contracts.md` 为准。

---

## 0. 它不做什么（先写边界，避免"命令式推进"回流）

方案 D = **派生式推进命令**：工具只"**承认已经发生的事实**"，不新增任何授权。

| # | 不做 | 为什么 |
|---|---|---|
| 1 | 不接受目标阶段（没有 `to_stage` / `stage_code` 入参） | 一旦能指定目标，模型就能跳阶；"能跳到哪"必须由事实决定 |
| 2 | 不接受 `actor_id` / `tenant_id` / 时间 | 身份只能来自执行上下文（`SET LOCAL recruitment.actor_id`）与插件配置 |
| 3 | 不写 `decision`、不建 `business_task` | 那是 `recruitment_decision_record` 与任务层的事（D-79/D-95 的人机闸门不能被绕开） |
| 4 | 不改 `lifecycle_status`、不写 `stage_blocked_reason` | 本命令只动"阶段指针"这一个轴；BLOCKED 也不落库（零写） |
| 5 | 不做 rubric pin 的写入（F1） | pin 由 intake 线写入；本命令**只判定** pinned / 未 pinned |
| 6 | 不重试到成功、不 last-write-wins | 版本冲突 → `VERSION_CONFLICT`，把"重读"交回调用方 |
| 7 | 不倒退、不跳阶 | 指针已超前 → `STAGE_AHEAD` 警告 + 一条 UPDATE 都不发（见 §6.3） |
| 8 | 阻塞里的"责任人"**不编造** | 能从库里推出就填 `owner_actor_id`，推不出来只给 `owner_role` + `next_action_code`（见 §5） |

---

## 1. 入参（**只有一个键**）

```json
{ "application_id": "11111111-1111-4111-8111-000000000701" }
```

| 键 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `application_id` | string（UUID） | ✅ | 申请 id。这是**唯一**参数 |

* `additionalProperties: false`：出现任何其它键 → `INVALID_ARGS`（`to_stage` / `target_stage` / `stage_code` /
  `actor_id` / `tenant_id` 全部拒收；其中身份键的违规码是 `TENANT_OR_ACTOR_NOT_ALLOWED`）。
* 参数校验发生在**连库之前**（`test/unit/stage-advance.test.ts` 有断言）：非法调用不会打开连接、不会开事务。

---

## 2. 事实：只承认两条边（T1 / T2）

梯子只有两条边，**顺序执行、不许跳**：

```
S6 ──T1──▶ S7 ──T2──▶ S8
```

> S6 = 简历接入与处理（Intake）；S7 = 初筛 / Screening；S8 = 面试规划与排期。
> 本命令的梯子**到 S8 为止**：再往后（S8→S9→S10）属于面试执行 / 评价线的事实，本轮不做。

### 2.1 T1：S6 → S7（材料 + rubric）

三个**前置事实**同时成立才推进；否则 `BLOCKED`（阶段不变、零 UPDATE）：

| # | 事实 | 不成立时的 `blockers[].code` | `owner_role` | `next_action_code` |
|---|---|---|---|---|
| 1 | `application.resume_version_id` 非空 | `MATERIAL_NOT_LINKED` | `RECRUITMENT_OWNER` | `LINK_INTAKE_MATERIAL` |
| 2 | 该 `resume_version.parse_status <> 'FAILED'` | `MATERIAL_PARSE_FAILED` | `RECRUITMENT_OWNER` | `REPARSE_MATERIAL` |
| 3 | `application.rubric_version_id` 非空 | `RUBRIC_NOT_PINNED` | `JOB_HIRING_MANAGER` | `PIN_RUBRIC_VERSION` |

**实现口径（写死）**：材料只用 `resume_version.parse_status` 判定，**只把 `FAILED` 当反向事实**；
`PARSED` / `PARTIAL` / `NEEDS_REVIEW` / `PENDING` / `PARSING` 都放行（设计如此；见 §13 未决 1）。

### 2.2 T2：S7 → S8（人已经做出的初筛结论）

判定式只有一条 —— **存在 current 的 SCREENING 决策，且结果是 ADVANCE**：

```sql
select d.id, d.result, d.decided_by_actor_id
  from recruitment.decision d
 where d.tenant_id = $1
   and d.application_id = $2
   and d.decision_scope = 'SCREENING'
   and d.superseded_by_decision_id is null   -- current：没被新决策取代
 order by d.decided_at desc, d.id
 limit 1;
```

| 查到的 current SCREENING 决策 | 结论 |
|---|---|
| 没有（人还没决定） | `WAIT` → **`NO_OP`**（不是错误；幂等的来源） |
| `result = 'ADVANCE'` | `PASS` → 推进到 S8 |
| `result ∈ {HOLD, REJECT, WITHDRAW}` | `BLOCKED`（`SCREENING_DECISION_NOT_ADVANCE`，`owner_role=SCREENING_DECIDER`，`next_action_code=SUPERSEDE_SCREENING_DECISION`），阶段**留在 S7** |

* `0008` 的 `uq_decision_current` 是 (tenant, application, scope, stage_code) 上的可延迟排斥约束，
  同一申请最多一条 current SCREENING → 上面的查询是**确定**的，不靠"取最新一条覆盖旧条"。
* **HOLD / REJECT 不推进**：它们是"已经发生的事实"，本命令承认它们（报 BLOCKED + 决策 id + 决策人），但不能越过人。

---

## 3. 三态结论（封闭集）

| `status` | 含义 | 发 UPDATE？ | `transitions[]` | `blockers[]` | `warnings[]` |
|---|---|---|---|---|---|
| `ADVANCED` | 至少走了一条边 | 是（每条边一条） | 真实发生的边（1–2 条） | 推进到下一跳时遇到反向事实才非空 | 空 |
| `NO_OP` | 需要做的事已经做完（或还轮不到本命令） | **否** | 空 | 空 | 可能非空（`STAGE_AHEAD`） |
| `BLOCKED` | 有事实挡住推进 | **否** | 空 | 非空（可多条） | 空 |

> `ADVANCED + blockers` 是合法组合：例如申请在 S6、T1 成立但 current SCREENING=HOLD ——
> 命令**如实**把指针推到 S7（这一跳的事实成立），再停在 S7 并报 blocker。它不假装"什么都没发生"，
> 也不假装"全部做完了"。

---

## 4. 出参（DSH 子集：没有 `type` 数组、没有 `null`；缺省一律"省略键"）

```json
{
  "tool": "recruitment_application_stage_advance",
  "contract_version": "1.1.0",
  "application_id": "11111111-1111-4111-8111-000000000701",
  "stage_code": "S6",
  "record_version": 2,
  "status": "BLOCKED",
  "transitions": [],
  "blockers": [{
    "code": "RUBRIC_NOT_PINNED",
    "message": "申请还没有钉住 rubric 版本（rubric_version_id 为空）：……",
    "owner_role": "JOB_HIRING_MANAGER",
    "next_action_code": "PIN_RUBRIC_VERSION",
    "owner_actor_id": "11111111-1111-4111-8111-000000000102",
    "owner_display_name": "演示-招聘负责人"
  }],
  "warnings": [],
  "labels": { "provenance": "FIXTURE", "trigger": "MANUAL", "connection": "NOT_CONNECTED" }
}
```

| 键 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tool` / `contract_version` | string | ✅ | `contract_version` 从 `1.1.0` 起包含结构化责任 |
| `application_id` | string | ✅ | 回显 |
| `stage_code` | string | ✅ | **调用结束后**的当前阶段码（NO_OP/BLOCKED 时与调用前相同） |
| `record_version` | integer | ✅ | **调用结束后**的真实版本（没发 UPDATE 就与调用前相同） |
| `status` | string | ✅ | `ADVANCED` / `NO_OP` / `BLOCKED`（§3） |
| `transitions` | array | ✅ | 元素 `{from, to}`；`ADVANCED` 才非空 |
| `blockers` | array | ✅ | 元素见 §5（`code/message` + **结构化责任**） |
| `warnings` | array | ✅ | 元素同 §5（目前只有 `STAGE_AHEAD`） |
| `labels` | object | ✅ | R4 三维标签（§11） |

**与方案 D 六个字段的差异（本实现显式补的键）**：

| 补的键 | 为什么必须补 |
|---|---|
| `warnings[]` | 方案 D 的六字段没有承载 `STAGE_AHEAD` 的位置；约束"指针已超前 → 返回 `STAGE_AHEAD` 警告"要求一个出口。塞进 `blockers` 会把"警告"误读成"阻塞" |
| `labels` | 本仓所有读写工具都带 R4 三维标签（`contracts/tenant-provenance.md`）；不写会让本工具成为唯一的标签盲区 |
| blocker/warning 内的 `owner_role` / `next_action_code` / `owner_actor_id` / `owner_display_name` | `§11.6-8` 要求工作台能机检「责任人 + 下一步」；只有自由文本 `message` 无法机检（见 §5） |

---

## 5. 结构化责任：`owner_role` / `next_action_code` / `owner_actor_id`

> **每个 blocker / warning 都恒有 `owner_role` 与 `next_action_code`（封闭集）；**
> **`owner_actor_id` / `owner_display_name` 只在能从库里推出来时出现（推不出来不编造）。**
> 因此"至少有一个非空"不是靠调用方自觉，而是**形状层面的保证**。

### 5.1 `owner_role`（该找谁；封闭集）

| 取值 | 含义 | 从哪推 |
|---|---|---|
| `JOB_HIRING_MANAGER` | 岗位所属部门的招聘负责人 | `application.job_id → job.department_id → department.hiring_manager_actor_id` |
| `RECRUITMENT_OWNER` | 招聘负责人（材料/申请周期这类"招聘侧该收拾"的事） | 同上（推不出来就只给 role） |
| `SCREENING_DECIDER` | 做过 current SCREENING 决策的那个人 | `decision.decided_by_actor_id`（**库里可查的真实决策人**） |
| `PLATFORM_OPERATOR` | 平台 / 数据面（保留；本命令当前不产生） | — |

> **本仓没有 job 级 owner 列**（`job` / `requisition` 都没有 `hiring_manager_actor_id`），
> 只有 `department.hiring_manager_actor_id` —— 所以 `JOB_HIRING_MANAGER` 与 `RECRUITMENT_OWNER`
> 都落到"部门招聘负责人"这一条链上。不要把它写成"岗位里存了负责人"。

### 5.2 `next_action_code`（下一步做什么；封闭集）

| 取值 | 用在 | 人读说明（`NEXT_ACTION_MESSAGES`） |
|---|---|---|
| `PIN_RUBRIC_VERSION` | `RUBRIC_NOT_PINNED` | 产出并批准 rubric 版本，再由 intake 把它钉到这条申请上 |
| `LINK_INTAKE_MATERIAL` | `MATERIAL_NOT_LINKED` | 跑一次 intake，把材料绑定到这条申请 |
| `REPARSE_MATERIAL` | `MATERIAL_PARSE_FAILED` | 修复或重新导入材料（不能是 FAILED） |
| `RECORD_SCREENING_DECISION` | 视图：S7 在等决策 | 由人完成初筛并落一条 SCREENING 决策 |
| `SUPERSEDE_SCREENING_DECISION` | `SCREENING_DECISION_NOT_ADVANCE` | 若结论要改，由人做一次新的 SCREENING 决策取代当前这条 |
| `REOPEN_APPLICATION` | `APPLICATION_NOT_ACTIVE` | 确认是否需要重开/重新建档（不在本命令范围） |
| `START_AT_INTAKE` | `STAGE_NOT_ON_LADDER` | 先用 intake 把申请带到 S6 |
| `VERIFY_STAGE_PROGRESSION` | `STAGE_AHEAD` | 核对这次阶段推进是谁做的；本命令不倒退 |
| `ADVANCE_STAGE` | 视图：事实已齐 | 调用 `recruitment_application_stage_advance` 推进 |
| `CONTINUE_DOWNSTREAM` | 视图：S8 及以后 | 本命令已无剩余动作，后续由面试/评价线推进 |

### 5.3 与 actor 诚实的关系（别混）

`owner_actor_id` 回答"**该找谁推进这件事**"；`application.stage_changed_by_actor_id` 回答
"**这条阶段 UPDATE 是谁执行的**"。两者**不是**同一个概念：
* T1（S6→S7）是**自动推进**，`stage_changed_by_actor_id` = 执行账号（配置里的 …0103），
  `owner_actor_id` = 招聘负责人（…0102）——**不是同一个人，也不是"人按了按钮"**；
* T2 的 `SCREENING_DECIDER` 是**真的做过 SCREENING 决策的人**（`decision.decided_by_actor_id`），
  这才配叫"决策人"；`stage_changed_by_actor_id` 仍然只是执行账号。

---

## 6. 只读的「阻塞视图」`readStageBlockedView`（工作台直接用）

**不是工具、不注册、不新表**：一个导出的只读函数（`src/domain/stage-advance.ts`），
与推进命令**共用同一套判定**（`diagnose`），但：

* **不加行锁**（`diagnose(lock=false)` 用普通 `select`），因此可以安全跑在
  `begin transaction read only` 里（工作台的 `withReadOnly` 路由）；任何写都会被 PG `25006` 拒绝；
* **不写库、不需要 actor**；
* 工作台一次拿到四要素，不需要再自己拼字符串。

### 6.1 形状

```json
{
  "application_id": "11111111-1111-4111-8111-000000000701",
  "stage": "S6",
  "stage_name": "简历接入与处理（Intake）",
  "lifecycle_status": "ACTIVE",
  "record_version": 2,
  "status": "BLOCKED",
  "blocked": true,
  "blockers": [{
    "kind": "BLOCKER",
    "code": "RUBRIC_NOT_PINNED",
    "message": "……",
    "owner_role": "JOB_HIRING_MANAGER",
    "next_action_code": "PIN_RUBRIC_VERSION",
    "owner_actor_id": "11111111-1111-4111-8111-000000000102",
    "owner_display_name": "演示-招聘负责人"
  }],
  "owner": { "role": "JOB_HIRING_MANAGER", "actor_id": "11111111-1111-4111-8111-000000000102", "display_name": "演示-招聘负责人" },
  "next_action": { "code": "PIN_RUBRIC_VERSION", "message": "产出并批准 rubric 版本……", "owner_role": "JOB_HIRING_MANAGER", "owner_actor_id": "11111111-1111-4111-8111-000000000102" }
}
```

| 键 | 说明 |
|---|---|
| `stage` / `stage_name` | 当前阶段码 + 目录里的名字（HR 直接读） |
| `status` | 与推进命令同一套三态（`ADVANCED` = 事实已齐、可推进；`NO_OP` = 等人/已到头；`BLOCKED` = 被挡） |
| `blocked` | **真的被挡住了吗**：`STAGE_AHEAD` 只是告警 → `false` |
| `blockers[]` | 统一形状：`kind='BLOCKER'|'WARNING'` + 原因 + **结构化责任**（§5）。`STAGE_AHEAD` 也在这里（kind=WARNING） |
| `owner` / `next_action` | 整条申请级别：取**优先级最高的一条**（blockers 按判定顺序优先、其次 warnings）；没有阻塞时给通用下一步（见 §6.2）。**两者恒有 `role`/`code`**，actor 能推出来才带 |

### 6.2 没有阻塞时的"下一步"

| 情况 | `next_action.code` |
|---|---|
| 事实已齐、可以推进 | `ADVANCE_STAGE` |
| 在 S7 等人工初筛决策 | `RECORD_SCREENING_DECISION` |
| S8 及以后 / 本命令无剩余动作 | `CONTINUE_DOWNSTREAM` |

### 6.3 工作台接线（一行）

`src/http/overview.ts` 的 pending 行目前是 `{application_id, stage_code, reason}`（自由文本）。
接上本视图后，每行可带 `blockers[]`（含 owner/next_action 结构化字段）：

```ts
import { readStageBlockedView } from '../domain/stage-advance.ts'
// 在 readOverview 的 withReadOnly 事务里，对每条 pending 行：
const view = await readStageBlockedView(client, { tenantId: database.tenant_id, applicationId: row.application_id })
// pending 行 = { application_id, stage_code: view.stage, stage_name: view.stage_name,
//                blocked: view.blocked, blockers: view.blockers, owner: view.owner, next_action: view.next_action }
```

> **本 lane 没有改 `src/http/overview.ts`**（工作台面板属另一条线；本 lane 的可写范围是
> domain/tools/tests/contracts）。视图函数与测试已就绪，接线是上面这一行 —— 由总控决定谁落。

---

## 7. 顺序、幂等、并发（每一条都对应一次真实踩坑）

### 7.1 开头 `select … for update`（写路径的串行化点）

```sql
select id, current_stage_code, record_version, lifecycle_status,
       resume_version_id, rubric_version_id,
       (extract(epoch from stage_entered_at) * 1000000)::double precision as stage_entered_at_us,
       (extract(epoch from created_at)       * 1000000)::double precision as created_at_us
  from recruitment.application
 where id = $1 and tenant_id = $2
 for update;
```

行锁保证：并发的第二个调用在这里等；拿到锁时看到的一定是**最新已提交**状态（READ COMMITTED）。

### 7.2 每条 UPDATE 都带版本条件；0 行 → `VERSION_CONFLICT`

```sql
update recruitment.application
   set current_stage_code = $4,            -- 目标阶段（由事实推导，不是入参）
       stage_entered_at   = greatest(
         clock_timestamp(),
         stage_entered_at + interval '1 microsecond',   -- 旧值（UPDATE 前的行值）
         created_at       + interval '1 microsecond'
       )
 where id = $1 and tenant_id = $2
   and current_stage_code = $3             -- 仍然停在"这条边"的起点
   and record_version = $5                 -- 本次认可的版本
returning current_stage_code, record_version,
          (extract(epoch from stage_entered_at) * 1000000)::double precision as stage_entered_at_us;
```

* **不写** `record_version` / `updated_at` / `stage_changed_at` / `stage_source_event_id` —— 它们由
  `fn_row_guard` 维护（手写 = 重复自增 + 审计篡改）。
* 0 行 → `VERSION_CONFLICT(APPLICATION_RECORD_VERSION_MISMATCH)`，**整体回滚，不重试**。
* `40001`（REPEATABLE READ 下等锁后发现行已被改）与 `40P01`（死锁）→ 同一个
  `VERSION_CONFLICT(APPLICATION_CONCURRENT_UPDATE)`：并发修改的正确反应是**重读**。

### 7.3 不倒退 / 不跳阶（`STAGE_AHEAD`）

| 调用前的指针 | 事实推导出的上限 | 结论 |
|---|---|---|
| S6（T1/T2 都成立） | S8 | 两跳推进（§8） |
| S6（只有 T1） | S7 | 一跳推进到 S7 |
| S7（T2 成立） | S8 | 一跳推进 |
| S7（无决策） | S7 | `NO_OP`（等人） |
| S7（HOLD/REJECT） | S7 | `BLOCKED` |
| S8 | S8 | `NO_OP`（已到梯子终点） |
| **S9 及以后** | 最多 S8 | **`NO_OP` + `STAGE_AHEAD` 警告，一条 UPDATE 都不发** |
| S1–S5 | 不许插队 | `BLOCKED(STAGE_NOT_ON_LADDER)` |

"超前"的判定用 `stage_catalog.sort_order`（权威是表，不是写死的数字）。

### 7.4 幂等

| 场景 | 第一次 | 第二次 | 库上的证据 |
|---|---|---|---|
| T1（S6→S7），没有 SCREENING 决策 | `ADVANCED` | `NO_OP` | `record_version` 不再变、`stage_entered_at` 不再变、事件仍只有 1 条 |
| T2（S7→S8） | `ADVANCED` | `NO_OP` | 同上 |

**为什么第二次不发 UPDATE**：阶段**没变**的 UPDATE 也会让 `fn_row_guard` 把 `record_version` +1、把
`updated_at` 改成 now()，却**不写任何事件** —— 那是"幂等重试看起来像改动"的典型污染。本命令用
"没剩下可走的边就不发语句"来消除它（A5 断言版本不变）。

### 7.5 多跳的原子性

一次调用可以走两跳（S6→S7→S8，例如"落后补推进"）；两条 UPDATE 在**同一个事务**里，
任一跳失败（版本冲突 / 断言失败）→ 调用方 `withActor` 回滚 → **不会半推进**。

---

## 8. `stage_entered_at`（本仓既有缺陷的兜底，必须有）

`db/migrations/0001_init.sql:846` 里 `stage_entered_at` **只有 `DEFAULT now()`**，`fn_row_guard`
不维护它。后果：如果不显式写，`stage_entered_at` 永远停在创建时刻，
"在当前阶段停留时长" ≡ "距创建时长"（一个静默的业务谎）。

本命令的规则：

1. **每次真实迁移都写** `stage_entered_at`（与阶段码在**同一条** UPDATE 里），式子见 §7.2 的
   `greatest(clock_timestamp(), 旧值 + 1µs, created_at + 1µs)`。
2. 写后**读回断言**（失败 → `INVARIANT_VIOLATION`，整体回滚）：
   * `stage_entered_at > created_at`；
   * 多跳时后一跳 `> ` 前一跳（严格单调）。
3. **比较用微秒，不用 JS `Date`**：`Date` 只有毫秒精度，而本命令用 1µs 下限保证严格单调 ——
   两跳只差 1µs 时 `Date` 会给出"相等"，断言就变成看时钟粒度运气。SQL 里
   `(extract(epoch from …) * 1000000)::double precision` 在 1.7e15 量级仍精确到 1µs（< 2^53）。
4. 为什么不是 `now()`：`now()` 是**事务开始时间**，同一事务里创建的申请会让两者相等，断言失去意义。
5. 为什么不是裸 `clock_timestamp()`：**时钟粒度可能粗到毫秒**（本机实测多跳会拿到同一个 tick →
   严格单调断言偶发失败）。`+1µs` 是**精度下限**：它把"严格单调"变成构造出来的事实，
   而不是靠时钟恰好前进。多出来的 1µs 不是编时间，是可解释的精度补偿。

---

## 9. actor 诚实（**明文写死，binding**）

> **`application.stage_changed_by_actor_id` 表示"执行账号"，不表示"决策人"。**

| 事实 | 说明 |
|---|---|
| 谁写这一列 | `fn_row_guard`（0001:157）从 `SET LOCAL recruitment.actor_id` 取 —— 即**配置里的本地执行账号** |
| 本命令的账号是谁 | `…0103`（`kind=HUMAN`，演示 HR 专员）。**但 T1 是自动推进**：没有任何人"按过这个按钮" |
| T2 是谁的意思 | T2 的前置是**人**做的 SCREENING 决策（`decision.decided_by_actor_id` + 人工确认哈希）。库里的 `stage_changed_by_actor_id` 仍然只是**执行账号** |
| 想证明"是谁决定的" | 唯一凭据是 `decision` 行；`application` 的审计列**不能**用来回答这个问题 |
| 阻塞里的 `owner_actor_id` | 回答"该找谁推进"，**不是**"谁执行了这条 UPDATE"（见 §5.3） |

**禁止的表述**（会造成"审计看起来像人做的"）：

* ✗ "HR 把申请推进到了 S7"
* ✗ "stage_changed_by_actor_id = 演示 HR 专员，说明 HR 决策了"
* ✓ "工具按事实把阶段指针推到 S7；执行账号是 …0103（T1 自动推进）"

**机检**：

* `src/tools/stage-advance.ts` 的 description 写死 `EXECUTING ACCOUNT` / `NOT the decision maker` / `T1 is an automatic advance`；
* 每次 `render()` 都打印 `stage_changed_by_actor_id = 执行账号…不代表决策人`；
* `test/unit/stage-advance.test.ts` 有断言扫这两处。

---

## 10. 错误（封闭集；message 形态 `CODE: <compact-json>`）

| `code` | `reason_code` | 触发 | 是否写库 |
|---|---|---|---|
| `NOT_FOUND` | `APPLICATION_NOT_FOUND` | 申请不存在 / 不属于当前租户 | 否 |
| `VERSION_CONFLICT` | `APPLICATION_RECORD_VERSION_MISMATCH` | UPDATE 0 行 | 否（整体回滚） |
| `VERSION_CONFLICT` | `APPLICATION_CONCURRENT_UPDATE` | `40001` / `40P01` | 否（整体回滚） |
| `INVARIANT_VIOLATION` | `STAGE_ENTERED_AT_NOT_ADVANCED` / `STAGE_ENTERED_AT_NOT_MONOTONIC` / `STAGE_CODE_MISMATCH` / `STAGE_CATALOG_INCOMPLETE` | 写后断言失败（本仓缺陷回归的兜底） | 否（整体回滚） |
| `INVALID_ARGS` | `UNKNOWN_PARAM` / `TENANT_OR_ACTOR_NOT_ALLOWED` / `MISSING_REQUIRED` / `ID_NOT_UUID` … | 入参校验（连库前） | 否 |
| `NOT_CONFIGURED` | — | `database` 段不完整（工具仍注册） | 否 |

> `INVARIANT_VIOLATION` 是**不该发生**的码：它出现就说明库的护栏被绕过或本仓缺陷回归，
> 宁可整笔回滚也不静默放过。

---

## 11. 验收矩阵（每条都在 `test/integration/stage-advance.test.ts` 里读库回验）

| # | 验收 | 断言要点 |
|---|---|---|
| A1 | T1 正例（材料 + rubric 齐） | `ADVANCED`、S7、`transitions=[{S6,S7}]`、`record_version` +1、`stage_entered_at > created_at` 且前进、恰好 1 条 `application.current_stage_code.changed`（`provider=internal`、`actor=执行账号`、`stage_source_event_id` 回填） |
| A2 | T1 缺 rubric | `BLOCKED['RUBRIC_NOT_PINNED']`、阶段不变、`record_version` 不变、事件 0 条；**`owner_actor_id` = 库里的招聘负责人（…0102）**、`owner_role=JOB_HIRING_MANAGER`、`next_action_code=PIN_RUBRIC_VERSION` |
| A2b | T1 材料 `FAILED` | `BLOCKED['MATERIAL_PARSE_FAILED']`、零 UPDATE |
| A3 | T2 正例 | `ADVANCED`、S8、恰好 1 条 S7→S8 事件 |
| A4 | T2 负例（HOLD / REJECT） | `BLOCKED`、阶段留在 S7、零 UPDATE、0 事件；`owner_role=SCREENING_DECIDER`、`owner_actor_id` = `decision.decided_by_actor_id` |
| A5 | 幂等（连调两次） | 第二次 `NO_OP`、`record_version` 不变、`stage_entered_at` 不变、事件仍 1 条 |
| A6 | 并发（两连接） | 一侧 `ADVANCED`、另一侧 `VERSION_CONFLICT`、**恰好 1 条**阶段事件、第三次调用 `NO_OP` |
| A7 | 落后补推进（多跳） | 一次调用两跳、`record_version` +2、一条边一条事件、`stage_entered_at` 严格单调 |
| A8 | 不倒退（S9） | `NO_OP` + `STAGE_AHEAD`、零 UPDATE；**告警带 `owner_actor_id` / `owner_role` / `next_action_code`** |
| A9 | **§11.6-8 只读阻塞视图**（真库） | RUBRIC 场景：`stage/stage_name/status/blocked/blockers/owner/next_action` 齐；**只发读语句**（逐条 SQL 检查 + 逐表零写）；`withReadOnly`（库层只读）里可跑；STAGE_AHEAD 场景：`kind=WARNING`、`blocked=false`、仍有 owner+next_action |

**门槛对照（§11.6-8）**：HR 看到「当前状态（`stage`/`status`）＋阻塞原因（`blockers[].code/message`）＋
责任人（`owner_role` + `owner_actor_id`/`owner_display_name`）＋下一步（`next_action_code` + §5.2 的人读说明）」——
四项全部是**结构化字段**，工作台可以机检、不需要解析自由文本。

---

## 12. R4 三维标签（本工具出口）

| 维 | 取值 | 依据 |
|---|---|---|
| `provenance` | 由 `resolveTenantProvenance()` 算（`ra_s6s7` 演示租户 ⇒ `FIXTURE`） | 与 `contracts/tenant-provenance.md` §2 **同一份实现**（不另写一份） |
| `trigger` | `MANUAL` | 模型/人显式调用；本工具不被事件驱动 |
| `connection` | `NOT_CONNECTED` | 只读写本产品业务库，不接任何外部系统 |

> 本命令**没有外部能力**可标：它既不发外部写，也不读外部事实。`FIXTURE` 不等于"假动作"——
> 它只说明这批数据是演示租户的合成数据（`docs/23` P2-03 的同一条口径）。

---

## 13. 与其它契约的关系

| 契约 | 关系 |
|---|---|
| `contracts/evaluation/decision-rules.md` **DC-47 / N-5** | `decision_record` 明确"不改 `current_stage_code`"；本文件就是那个**独立命令**（阶段推进从决策写入里分离） |
| `contracts/job-screening/tool-contracts.md` §17.1 的写侧 | T2 只读 S7 写侧落的 `decision(SCREENING)`；本命令**不写**它 |
| `contracts/STAGE-CODES.md` | 阶段码口径；S6/S7/S8（S8 = 面试规划与排期）的语义由 `stage_catalog` 决定，本文件不另立编号 |
| `docs/23` N8 / P1-09、`docs/18` §3.7 | 本文件闭合"阶段推进无入口"这一缺口（v1.0 只闭合到 S8，即面试规划与排期这一格） |
| `contracts/tenant-provenance.md` | §12 的 `provenance` 判定式（同一份实现） |
| `src/http/overview.ts`（工作台面板） | §6.3：只读视图函数已就绪；pending 行换成 `{stage, stage_name, blocked, blockers, owner, next_action}` 只需一行接线 |

**边界（本轮明确不做）**：S8→S9→S10 的推进不在本命令的梯子里。它们是面试执行 / 评价线的
事实（面试完成、转写、面评、汇总），等那些线有"可承认的事实"后再各自加边，**不在本命令里塞**。

---

## 14. 未决问题（交总控裁决，不在本 lane 自作主张）

| # | 问题 | 现状 | 建议 |
|---|---|---|---|
| 1 | T1 只排除 `FAILED`：`PENDING` / `PARSING` 的材料也会被推入 S7 | 按设计原文实现（"`parse_status` 非 `FAILED`"） | 若认为"未解析完不能进初筛"，把它收紧为 `∈ {PARSED, PARTIAL, NEEDS_REVIEW}`；这会改事实定义，需裁定 |
| 2 | `STAGE_AHEAD` 的出口 | 方案 D 六字段没有槽位 → 本实现加 `warnings[]`（已结构化） | 建议保留（塞进 `blockers` 会把"警告"误读成"阻塞"） |
| 3 | 多跳产生**多条**事件（一条边一条） | 事件由 `fn_row_guard` 自动写，无法合并 | 保留（每条边的 `from/to` 都是审计真相）；单跳并发用例已断言"恰好 1 条" |
| 4 | 非 `ACTIVE` 的申请 | 本实现加了 `APPLICATION_NOT_ACTIVE` 的 BLOCKED（设计未写） | 建议保留：CLOSED/WITHDRAWN 的申请不该再被推进 |
| 5 | **工作台接线**（`src/http/overview.ts`） | 本 lane 没有改它（面板属另一条线）；只读视图函数 + 测试已就绪（§6.3 一行接线） | 由总控决定谁落；落完 `§11.6-8` 在工作台层面才算真正闭合（当前门槛用例断言的是工具输出） |
| 6 | **工具注册行** | 本 lane **没有改** `src/index.ts`（共享工作树，所有 lane 并发写同一文件） | 由总控在所有 lane 收工后统一加（§15） |
| 7 | 并发用例需要**已提交**夹具（第二个连接看不见未提交行） | 用例在 after 钩子里用 `SET LOCAL session_replication_role = replica` 删干净自造行（事务内、自动恢复） | 需要 DB 角色是 superuser（本机与 CI 的 `postgres` 都是）；若换成受限角色，这条用例会**失败而不是静默 skip**（R3） |

---

## 15. 工具注册（待总控统一落；本 lane 未改 `src/index.ts`）

```ts
// ① src/index.ts:79 之后（import 区）
import { createStageAdvanceTool, unconfiguredStageAdvanceTool } from './tools/stage-advance.ts'

// ② src/index.ts:412 之后（const decisionRecord = ... 块之后）
  // ── 阶段推进（N8 / 方案 D）：只要 database。派生式推进，只承认已发生的事实（S6→S7→S8）。
  const stageAdvance = database.resolved === null
    ? unconfiguredStageAdvanceTool(database.issues)
    : createStageAdvanceTool(database.resolved)

// ③ src/index.ts:430 之后（tools 数组里 decisionRecord, 下一行）
    stageAdvance,
```
