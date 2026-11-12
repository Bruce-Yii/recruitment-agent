# workbench-rules.md · 个人工作台「什么算我的」

**版本**：`workbench-rules 1.0.0`
**日期**：2026-11-13
**范围**：**只定义归属判定**——哪一行数据该出现在谁的"我的"里。不定义 UI、不定义接口形状（那在 `tool-contracts.md`）、不含实现代码。
**不在本文件范围**：权限、角色、拦截。**v1.0 没有权限**（见 §0.1）。

---

## 0. 先划三条边界，再谈谓词

### 0.1 工作台不是权限（D-33）

`DECISIONS-2026-11-12.md` D-33：v1.0 **不做 RBAC**，所有人**全局可见**；角色降级为**标签**，"只用于我的工作台过滤和界面展示，**不用于拦截**"。

因此本文件定义的每一个谓词，**都不是**访问控制：

| 命题 | 是否成立 |
|---|---|
| "这一行不在我的工作台里" | ✅ 事实 |
| "我不该看到这一行" | ❌ **永不成立**（全局可见） |
| "系统替我挡住了它" | ❌ **永不成立**（本层没有任何拦截代码） |

**任何实现把工作台谓词当成 `WHERE` 之外的准入检查（拒绝访问 / 403 / 空结果代替报错），都违反 D-33。**

### 0.2 工作台是投影，不是事实

工作台**只读**：不写 `last_seen`、不标已读、不自动认领、不改任何 `status`、不新建任何行。它把库里既有的行**投影**成五个视角。

这条不是洁癖。**库里根本没有"看过"这张表**（§7 缺口 5），如果工作台顺手写一个 `last_viewed_at`，那么"我最近处理过的申请"就会悄悄变成"我最近打开过的申请"——那是把一个**动作**（decision/scorecard/stage move，有 `decided_by_actor_id` 等字段为证）降级成一个**点击**。R4 的教训是同一种错误：**别把"读到了"当成"处理了"**。

### 0.3 工作台必须暴露无主积压

D-33 的直接要求 + 本任务书的硬要求：**不得因为过滤而隐藏"我该处理但没分配给我"的积压**。

所以 `unassigned`（未分配 / 待认领）**不是**第六个可选区块，而是**恒返回的独占区**（§3）：它不受"只看某几块"的参数影响，因为一旦可以被关掉，它就会在某次调用里消失，而消失的那一次正是出事的那一次。

---

## 1. 归属判定四条铁律

| 编号 | 铁律 | 反面（会出的事） |
|---|---|---|
| **R-WB-1** | **只用有库约束的列做过滤**。`role_in_interview` 这类"只有正则、取值开放"的列**只作展示标签**，不参与"是不是我的"判定 | 用 `role_in_interview='HIRING_MANAGER'` 过滤 → 没写 role 的面试官（默认值 `INTERVIEWER`）**静默消失**，而库里不会报错 |
| **R-WB-2** | 一个谓词只回答**"我与这条记录是什么关系"**。"我需要做什么"由 `required_action` 从状态派生，**不混进 WHERE** | 把 `status='WAITING_HUMAN'` 写进归属谓词 → 已认领但还没给结论的任务从工作台消失 |
| **R-WB-3** | **归属推不出来 ⇒ 不分配给任何人**。宁可进 `unassigned`，不许猜 | "没有 owner 就算 HR 的" → 无主积压被静默吸收进某人的列表，然后被"我已经看过了"心理过滤掉 |
| **R-WB-4** | **不得隐式兜底**。没有"默认负责人"，没有 `COALESCE(owner, <某个角色>)` | 一个人请假，所有找不到人的单子自动堆到他名下，且没人知道它们本来是无主的 |

**第四条还要加一句**：`actor_role`（`ORG_ADMIN` / `HIRING_MANAGER` / `HR_SPECIALIST` / `INTERVIEWER`，`0002_seed.sql:102-107`）**不参与任何归属谓词**。它是标签（D-33 第 2 条）。工作台里唯一合法的"按部门"判定走 `department.hiring_manager_actor_id`（一个真实的、有外键的**指派人**字段），不走角色。

---

## 2. 五个区块的谓词

**通用约定**（下面五段不再重复）：

- 参数：`:actor_id`（uuid）、`:tenant_id`（uuid，**由 `actor.tenant_id` 推出**，不接受调用方传入）。
- 每一段都是**完整可执行的单条 SQL**，已在 PG 17.11 的真实 schema 上 `EXPLAIN` 通过（证据见 §9）。
- `:uuid_re` = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`。
  这个正则**不是装饰**：`business_refs` 库层只校验"是数组"（`0001_init.sql:1445-1446`），元素里的 `id` 可能是任意字符串；直接 `::uuid` 会在脏数据上抛 `22P02`，把"某条任务 ref 写坏了"变成"整个工作台 500"。**契约要求：非 UUID 形态的 ref 一律视为不匹配，不得报错。**
- "开启"（open）= `status` 不在终态集合里。每个区块给各自的终态集合。

---

### 2.1 待办任务 `tasks`

**表**：`business_task`（`0001_init.sql:1397-1456`）

**先说清楚一件事**：**这张表没有 `owner_actor_id`，也没有 `assignee`。** 它的全部人员字段是：

| 字段 | 位置 | 语义 | 能当"负责人"用吗 |
|---|---|---|---|
| `created_by_actor_id` | `:1407` | 谁建的任务 | ✅ **唯一可用**，见下 |
| `status_changed_by_actor_id` | `:1423` | 最后一个改状态的人 | ❌ 那是"最后动过的人"，不是"该处理的人" |
| `business_refs` (jsonb) | `:1401` | 指向业务对象 | ⚠️ 只能**间接**推出人，见下 |

**"我的任务" = 三源并集**（`:actor_id` 命中任一即算）：

1. **我是创建者**：`business_task.created_by_actor_id = :actor_id`
   → `relation = OWNER`
2. **任务指向一场我是面试官的面试**：`business_refs` 含 `{"kind":"INTERVIEW","id":<interview>}` 且该面试的 `interviewer.actor_id = :actor_id`
   → `relation = INTERVIEWER`
3. **任务指向一个我作为用人经理负责的部门下的申请**：`business_refs` 含 `{"kind":"APPLICATION","id":<application>}` 且 `application.job_id → job.department_id → department.hiring_manager_actor_id = :actor_id`
   → `relation = HIRING_MANAGER`

**为什么只有这三源，不加 `CANDIDATE` / `JOB` / `RESUME_VERSION` / `INTAKE_RECORD` / `DECISION`**：
`business_refs.kind` 的封闭集是 `screening-rules.md:291-297` 定的 7 个值
（`APPLICATION|CANDIDATE|RESUME_VERSION|INTAKE_RECORD|JOB|DECISION|INTERVIEW`），
其中只有 `INTERVIEW` 与 `APPLICATION` 能沿外键走到一个**有指派语义的人**
（`interviewer.actor_id` / `department.hiring_manager_actor_id`）。
`CANDIDATE` 没有负责人列；`JOB` 的"人"是部门的用人经理（与 `APPLICATION` 同一路径，重复算会把整个部门的积压摊到经理头上）；`DECISION` 是已发生的事实，不是待办。

**本契约不新增 `business_refs.kind` 值。** 要"把任务直接指派给某人"，必须走 `0005` 加 `business_task.owner_actor_id`，或扩展那份契约的 `kind` 枚举（**两份契约必须同步改**，否则 R5 会在 `business_refs` 上再破一次）。

```sql
with refs as (
  select bt.id as task_id, bt.tenant_id, r.value as r
    from recruitment.business_task bt
    cross join lateral jsonb_array_elements(bt.business_refs) r
), ref_owner as (
  -- 源 2：INTERVIEW ref → 该场面试的面试官
  select distinct rf.task_id, rf.tenant_id, ivr.actor_id as owner_actor_id
    from refs rf
    join recruitment.interviewer ivr
      on rf.r->>'kind' = 'INTERVIEW'
     and (rf.r->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and ivr.interview_id = (rf.r->>'id')::uuid
     and ivr.tenant_id  = rf.tenant_id
  union
  -- 源 3：APPLICATION ref → 该岗位所属部门的用人经理
  select distinct rf.task_id, rf.tenant_id, d.hiring_manager_actor_id
    from refs rf
    join recruitment.application a
      on rf.r->>'kind' = 'APPLICATION'
     and (rf.r->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and a.id = (rf.r->>'id')::uuid
     and a.tenant_id = rf.tenant_id
    join recruitment.job j        on j.id = a.job_id        and j.tenant_id = a.tenant_id
    join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
   where d.hiring_manager_actor_id is not null
)
select bt.id
  from recruitment.business_task bt
 where bt.tenant_id = :tenant_id
   and bt.status not in ('SUCCEEDED','FAILED','CANCELLED','SUPERSEDED')
   and ( bt.created_by_actor_id = :actor_id
      or exists (select 1 from ref_owner o
                  where o.task_id = bt.id and o.owner_actor_id = :actor_id) );
```

**开启状态集**（11 个取值中排除 4 个终态，`0001_init.sql:1441-1443`）：
`PENDING · READY · RUNNING · WAITING_EXTERNAL · WAITING_HUMAN · RETRY_WAIT · CANCEL_REQUESTED`
排除：`SUCCEEDED · FAILED · CANCELLED · SUPERSEDED`。

> `FAILED` **不进**"我的待办"。它不是待办，是已结束的失败；要看它用全局查询。把 FAILED 放进工作台会让"待办 30 条"里混进 28 条永远做不完的东西。

**"需要我做什么"（`required_action`，从状态派生，不进 WHERE）**：

| `status` | `required_action` |
|---|---|
| `WAITING_HUMAN` | `PROVIDE_DECISION` —— 轮到人给结论 |
| `CANCEL_REQUESTED` | `CONFIRM_CANCEL` |
| `WAITING_EXTERNAL` | `WAIT` —— 等外部系统，**别催** |
| `PENDING` / `READY` / `RUNNING` / `RETRY_WAIT` | `MONITOR` —— 系统自己在跑 |

**无主任务**：`WAITING_HUMAN` **且** `created_by_actor_id IS NULL` **且** `ref_owner` 里没有它 → 进 §3.1。
（`PENDING` 之类没有人的任务不需要人，不算积压；把它们也塞进 `unassigned` 会让无主区每天刷出几百条不需要任何人处理的东西，然后没人再看它——这正是"闸门疲劳"的成因。）

---

### 2.2 我负责的面试 `interviews`

**表**：`interview`（`0001_init.sql:930-971`）+ `interviewer`（`:973-990`）

**`interview` 没有负责人列。** 唯一的指派表是 `interviewer`，`uq_interviewer (interview_id, actor_id)`（`:984`）保证"同一场面试一个人只挂一次"。

**"我的面试" = 我是这场面试的 `interviewer` 行之一**：

```sql
select iv.id,
       ivr.role_in_interview,
       ivr.required_scorecard,
       ( ivr.required_scorecard
         and not exists (
           select 1 from recruitment.scorecard sc
            where sc.interview_id = iv.id
              and sc.interviewer_id = ivr.id
              and sc.tenant_id = ivr.tenant_id
              and sc.superseded_by_scorecard_id is null
              and sc.status in ('SUBMITTED','WAIVED')) ) as needs_scorecard
  from recruitment.interview iv
  join recruitment.interviewer ivr
    on ivr.interview_id = iv.id and ivr.tenant_id = iv.tenant_id
 where iv.tenant_id = :tenant_id
   and ivr.actor_id = :actor_id
   and iv.status not in ('CANCELLED','DECIDED');
```

- `relation` = `INTERVIEWER`（唯一值）。
- **开启状态集**：8 个取值（`:959-961`）中排除 `CANCELLED`（已取消）与 `DECIDED`（已决策，面试环节结束）。`NO_SHOW` / `RESCHEDULED` **保留**——那是"还要重排"的信号，藏起来等于假装没发生。
- `needs_scorecard` 的判定必须走 `superseded_by_scorecard_id IS NULL`：`uq_scorecard_current`（`:1322-1323`）保证同一 `(interview, interviewer)` 只有一条"当前"评分卡，历史修订行也在表里。不带这个条件，交过一版就打不上勾。
- `required_action`：`needs_scorecard = true` → `SUBMIT_SCORECARD`；否则 → `NONE`。
- `role_in_interview`（`:978`）**只作展示**（R-WB-1）：它的约束是 `ck_interviewer_role`（`:989`）的一条正则，取值开放（默认 `'INTERVIEWER'`，没有任何 CHECK 限定词表）。**不用它过滤，只用它显示"用人经理面试 / 业务专家面试"**。

---

### 2.3 我参与的岗位 `jobs`

**表**：`job`（`0001_init.sql:504-533`）+ `department`（`:326-340`）

**关键事实：`job` 没有 `hiring_manager_actor_id`，也没有 `owner_actor_id`。**
用人经理挂在**部门**上：`department.hiring_manager_actor_id`（`:331`）。`job.department_id` 是 `NOT NULL` 复合外键（`:521-522`），所以"岗位 → 部门 → 用人经理"这条链是**结构上必然存在**的，只有末端可能为 `NULL`。

**"我的岗位" = 五条关系并集**（`:actor_id` 命中任一）：

| 关系 | 谓词 | `relation` |
|---|---|---|
| 用人经理 | `department.hiring_manager_actor_id = :actor_id`（经 `job.department_id`） | `HIRING_MANAGER` |
| JD 作者 | `∃ job_version.job_id = job.id AND job_version.created_by_actor_id = :actor_id` | `AUTHOR` |
| 标准作者 | `∃ rubric_version.job_id = job.id AND rubric_version.created_by_actor_id = :actor_id` | `AUTHOR` |
| 在该岗位下当过面试官 | `∃ application.job_id = job.id → interview → interviewer.actor_id = :actor_id` | `INTERVIEWER` |
| 最后动过岗位状态 | `job.status_changed_by_actor_id = :actor_id` | `TOUCHED` |

```sql
select j.id
  from recruitment.job j
  join recruitment.department d
    on d.id = j.department_id and d.tenant_id = j.tenant_id
 where j.tenant_id = :tenant_id
   and j.status not in ('CLOSED','ARCHIVED')
   and ( d.hiring_manager_actor_id = :actor_id
      or j.status_changed_by_actor_id = :actor_id                    -- TOUCHED
      or exists (select 1 from recruitment.job_version jv            -- AUTHOR
                  where jv.job_id = j.id and jv.tenant_id = j.tenant_id
                    and jv.created_by_actor_id = :actor_id)
      or exists (select 1 from recruitment.rubric_version rv         -- AUTHOR
                  where rv.job_id = j.id and rv.tenant_id = j.tenant_id
                    and rv.created_by_actor_id = :actor_id)
      or exists (select 1                                        -- INTERVIEWER
                   from recruitment.interview iv
                   join recruitment.application a
                     on a.id = iv.application_id and a.tenant_id = iv.tenant_id
                   join recruitment.interviewer ivr
                     on ivr.interview_id = iv.id and ivr.tenant_id = iv.tenant_id
                  where a.job_id = j.id and a.tenant_id = j.tenant_id
                    and ivr.actor_id = :actor_id) );
```

- **开启状态集**：`job.status`（7 值，`:529-530`）排除 `CLOSED` / `ARCHIVED`。`PAUSED` 保留（暂停的岗位还归我管）。
- 命中多条关系时：`relation` 取优先级 `HIRING_MANAGER > INTERVIEWER > AUTHOR > TOUCHED` 的第一个，**全部**放进 `relations[]`。
- `required_action` = **`NONE`**（岗位区块是"我在其中"的关系视图）。
  这不是偷懒：**放进去的岗位不等于要我做动作**。真要我批的 `approval` / 要我处理的 `business_task` 会各自出现在 `pending_reviews` / `tasks` 里。如果岗位区块也发 `required_action`，同一个动作会在三个区块各报一次，"待办 5 条"实际只有 1 件事。

---

### 2.4 我最近处理的申请 `applications`

**必须先纠正一处措辞**：D-33 第 3 条写的是"我最近**看过**的候选人"。**库里没有"看过"这个事实**——没有任何表记录"谁打开过什么"（§7 缺口 5）。

所以本区块定义的是"我最近**处理过**的申请"，判据全部是**有 actor 字段的写动作**。这不是降级，是**唯一诚实的口径**：看过 ≠ 处理过，而工作台上写着"最近处理"的时候，它必须真的是处理。

**四类 touch（并集）**，每类都带"谁"：

| touch | 字段证据 | 时间锚点 |
|---|---|---|
| `STAGE_MOVED` 我推进了阶段 | `application.stage_changed_by_actor_id`（`:853`） | `application.stage_changed_at`（`:852`） |
| `LIFECYCLE_CHANGED` 我改了生命周期 | `application.status_changed_by_actor_id`（`:850`） | `application.status_changed_at`（`:849`） |
| `DECISION_MADE` 我下了决策 | `decision.decided_by_actor_id`（`:1333`） | `decision.decided_at`（`:1334`） |
| `SCORECARD_SUBMITTED` 我交了面评 | `scorecard.interviewer_id → interviewer.actor_id`（`:1278`、`:1322`） | `scorecard.submitted_at`（`:1283`） |

```sql
with touch as (
  select a.id as application_id, a.tenant_id, a.stage_changed_at as touched_at, 'STAGE_MOVED'::text as action
    from recruitment.application a
   where a.stage_changed_by_actor_id = :actor_id
  union all
  select a.id, a.tenant_id, a.status_changed_at, 'LIFECYCLE_CHANGED'
    from recruitment.application a
   where a.status_changed_by_actor_id = :actor_id
  union all
  select d.application_id, d.tenant_id, d.decided_at, 'DECISION_MADE'
    from recruitment.decision d
   where d.decided_by_actor_id = :actor_id
  union all
  select iv.application_id, iv.tenant_id, sc.submitted_at, 'SCORECARD_SUBMITTED'
    from recruitment.scorecard sc
    join recruitment.interviewer ivr
      on ivr.id = sc.interviewer_id and ivr.tenant_id = sc.tenant_id
    join recruitment.interview iv
      on iv.id = ivr.interview_id and iv.tenant_id = ivr.tenant_id
   where ivr.actor_id = :actor_id
     and sc.status = 'SUBMITTED'
     and sc.submitted_at is not null
)
select t.application_id,
       max(t.touched_at)                                     as last_touched_at,
       (array_agg(t.action order by t.touched_at desc))[1]   as last_action
  from touch t
 where t.tenant_id = :tenant_id
   and t.touched_at >= :evaluated_at - interval '14 days'
 group by t.application_id
 order by max(t.touched_at) desc, t.application_id asc
 limit 50;
```

- `relation` = `TOUCHED`；`union all` 后 `group by` 保证**同一申请只出现一次**（否则一次申请能靠 4 个动作刷 4 条）。
- **窗口 = 14 天，上限 = 50 条**（契约常量，见 `tool-contracts.md` §1.6）。窗口语义是"最近"，不设窗口会让这个区块变成"我这辈子碰过的所有申请"，那就不是工作台。
- **不能用 `application.updated_at`**：`fn_touch` 在每次 UPDATE 自动刷新它（`SCHEMA.md` §1 乐观并发行），**包括系统内部迁移**。用它当"我处理过"的锚点，等于把"系统动过"记成"我动过"。
- 不含 `ABORTED` 语义：`WITHDRAWN` / `CLOSED` 的申请照样出现（我确实处理过它），但 `required_action = NONE`。
- `required_action` = `NONE`。**这条必须写死**：如果我上一步把申请推到 S8（排期），那么"该排期"是 `pending_reviews` / `tasks` 的事，不是"最近处理"区块的事。

**为什么 `SCORECARD_SUBMITTED` 走 `interviewer.actor_id` 而不是 `scorecard.status_changed_by_actor_id`**：
评分卡的内容归属是"这张卡属于哪个面试官"（不变量 7 要求 `interviewer_id NOT NULL`），而 `status_changed_by_actor_id` 只记"最后一次改状态是谁"。**内容归属比状态动作者更接近"这是我做的"**。两者不一致时（例如 HR 代提交），归属仍算面试官的——因为待他签字。

---

### 2.5 需要我确认的事项 `pending_reviews`

**这是唯一一个"多来源"区块**：五个来源，每个都有自己的"谁该确认"判定。逐条给谓词。

| # | `kind` | 来源表 | "该我"的判定 | 为什么是它 |
|---|---|---|---|---|
| A | `APPROVAL_PENDING` | `approval` | 见下（**经资源反查部门用人经理**） | `approval` **没有审批人字段** |
| B | `REVIEW_QUEUE_ITEM` | `review_queue` | `assignee = :actor_id` | 这是库里**唯一真正的"指派"字段** |
| C | `SCORECARD_DUE` | `interviewer` | `interviewer.actor_id = :actor_id` 且没交卡 | 面评只能本人交 |
| D | `HUMAN_TASK` | `business_task` | 同 §2.1 的归属，且 `status='WAITING_HUMAN'` | 轮到我给结论 |
| E | `INTERVIEW_RECORD_REVIEW` | `interview_record` | 该记录所属面试的面试官包含我 | 证据校验只能由在场的人做 |

**A. `approval` 的硬缺口（必须先说清）**

`approval` 的字段是：`requested_by_actor_id`（`:425`，"谁提的"）与 `decision_by_actor_id`（`:426`，"谁已经批了"，`PENDING` 时必须为 `NULL`，见 `ck_approval_decided_fields` `:455-459`）。

**没有 `approver_actor_id`。** 也就是说：**"这条审批等谁批"在库里不存在。**

两条路：

1. ❌ 用 `requested_by_actor_id = :actor_id` —— 那是"我提的、等别人批的"，语义正好相反。放进"需要我确认"会让提出者以为自己要批自己的单。
2. ✅ **从被审资源反查它所属部门的用人经理**（`ck_approval_resource_type` `:448-449` 的 7 个取值里，5 个能走通）：

| `resource_type` | 反查路径 | 可推导 |
|---|---|---|
| `REQUISITION` | `requisition.department_id → department.hiring_manager_actor_id` | ✅ |
| `JOB` | `job.department_id → department.hiring_manager_actor_id` | ✅ |
| `JOB_VERSION` | `job_version.job_id → job.department_id → …` | ✅ |
| `RUBRIC_VERSION` | `rubric_version.job_id → job.department_id → …` | ✅ |
| `JOB_POSTING` | `job_posting.job_id → job.department_id → …` | ✅ |
| `DECISION` | **无部门链路** | ❌ → `unassigned`（`why=RESOURCE_TYPE_UNMAPPABLE`） |
| `OFFER` | **无 `offer` 表**（缓做，`SCHEMA.md` §5） | ❌ → `unassigned` |

**这不是审批矩阵，也不许被当成审批矩阵**：它只是在"恰好存在唯一责任人"时把单子算给那个人。没有唯一责任人的审批**不猜**，进 `unassigned`（§3.3）。

**B. `review_queue` 的硬缺口**

`review_queue.assignee`（`0003_review_queue.sql:222`）是**真的指派字段**，但 `ck_review_queue_assignee`（`:258`）是：

```sql
constraint ck_review_queue_assignee check (status = 'QUEUED' or assignee is not null)
```

即：**`QUEUED` 状态允许 `assignee IS NULL`**。这正是"待认领"的库级表达，也是 §3.2 的来源。
**"未结案"** = `status in ('QUEUED','IN_REVIEW','CORRECTED')`（与 `v_review_open` `:497-517` 同一口径；`APPROVED`/`REJECTED`/`REPROCESS` 是终态）。

> ⚠️ **主键名待统一**：`0003` 文件里主键叫 `item_id`（`:218`），而 **D-36 已裁定改为单列 `id`**；实测实库（`ra_align`）已是 `id`。**本契约统一写 `review_queue.id`**，实现须兼容两种命名或等 `0003` 修正落地（详见 §7 缺口 6）。

**C. `SCORECARD_DUE`**：`id` 用 **`interviewer.id`**，不用 `scorecard.id`。
理由：还没建评分卡时没有 `scorecard` 行可给 id，用 `interviewer.id` 才能让"该交但还没开始"也有一条稳定标识，且两种情况（无卡 / 卡为 `PENDING`）**不会产生两条**。

**E. `interview_record`**：`interview_record` 同样没有 actor 字段，但有 `interview_id`（`:1185`）与 `is_current`（`:1198`，`uq_interview_record_current` `:1231-1232` 保证每场面试只有一条 current）。走"这场面试的面试官里有我"。

```sql
with pending_approval as (
  select ap.id as approval_id, ap.tenant_id, ap.resource_type, ap.resource_id,
         case ap.resource_type
           when 'REQUISITION' then
             (select d.hiring_manager_actor_id from recruitment.requisition rq
                join recruitment.department d on d.id = rq.department_id and d.tenant_id = rq.tenant_id
               where rq.id = ap.resource_id and rq.tenant_id = ap.tenant_id)
           when 'JOB' then
             (select d.hiring_manager_actor_id from recruitment.job j
                join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
               where j.id = ap.resource_id and j.tenant_id = ap.tenant_id)
           when 'JOB_VERSION' then
             (select d.hiring_manager_actor_id from recruitment.job_version jv
                join recruitment.job j on j.id = jv.job_id and j.tenant_id = jv.tenant_id
                join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
               where jv.id = ap.resource_id and jv.tenant_id = ap.tenant_id)
           when 'RUBRIC_VERSION' then
             (select d.hiring_manager_actor_id from recruitment.rubric_version rv
                join recruitment.job j on j.id = rv.job_id and j.tenant_id = rv.tenant_id
                join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
               where rv.id = ap.resource_id and rv.tenant_id = ap.tenant_id)
           when 'JOB_POSTING' then
             (select d.hiring_manager_actor_id from recruitment.job_posting jp
                join recruitment.job j on j.id = jp.job_id and j.tenant_id = jp.tenant_id
                join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
               where jp.id = ap.resource_id and jp.tenant_id = ap.tenant_id)
         end as accountable_actor_id
    from recruitment.approval ap
   where ap.tenant_id = :tenant_id and ap.status = 'PENDING'
)
select 'APPROVAL_PENDING'::text as kind, a.approval_id as entity_id
  from pending_approval a where a.accountable_actor_id = :actor_id
union all
select 'REVIEW_QUEUE_ITEM', q.id
  from recruitment.review_queue q
 where q.tenant_id = :tenant_id
   and q.assignee = :actor_id
   and q.status in ('QUEUED','IN_REVIEW','CORRECTED')
union all
select 'SCORECARD_DUE', ivr.id
  from recruitment.interviewer ivr
  join recruitment.interview iv on iv.id = ivr.interview_id and iv.tenant_id = ivr.tenant_id
 where ivr.tenant_id = :tenant_id
   and ivr.actor_id = :actor_id
   and ivr.required_scorecard
   and iv.status not in ('CANCELLED','DECIDED')
   and not exists (select 1 from recruitment.scorecard sc
                    where sc.interview_id = iv.id and sc.interviewer_id = ivr.id
                      and sc.tenant_id = ivr.tenant_id
                      and sc.superseded_by_scorecard_id is null
                      and sc.status in ('SUBMITTED','WAIVED'))
union all
select 'HUMAN_TASK', bt.id
  from recruitment.business_task bt
 where bt.tenant_id = :tenant_id
   and bt.status = 'WAITING_HUMAN'
   and bt.created_by_actor_id = :actor_id
union all
select 'INTERVIEW_RECORD_REVIEW', ir.id
  from recruitment.interview_record ir
 where ir.tenant_id = :tenant_id
   and ir.status = 'NEEDS_REVIEW'
   and ir.is_current
   and exists (select 1 from recruitment.interviewer ivr
                where ivr.interview_id = ir.interview_id
                  and ivr.tenant_id = ir.tenant_id
                  and ivr.actor_id = :actor_id);
```

> `HUMAN_TASK` 这一支在示例里只写了 `created_by_actor_id = :actor_id`；**实现必须用 §2.1 的完整三源谓词**（含 `ref_owner`），否则"面试官名下的人工任务"会漏。示例为可读性做了简化，**以 §2.1 为准**。

`required_action` 映射：

| `kind` | `required_action` |
|---|---|
| `APPROVAL_PENDING` | `DECIDE_APPROVAL` |
| `REVIEW_QUEUE_ITEM` | `RESOLVE_REVIEW_ITEM` |
| `SCORECARD_DUE` | `SUBMIT_SCORECARD` |
| `HUMAN_TASK` | `PROVIDE_DECISION` |
| `INTERVIEW_RECORD_REVIEW` | `VERIFY_INTERVIEW_RECORD` |

`relation` 映射：`APPROVAL_PENDING` / `REVIEW_QUEUE_ITEM` / `INTERVIEW_RECORD_REVIEW` → `REVIEWER`；`SCORECARD_DUE` → `INTERVIEWER`；`HUMAN_TASK` → `OWNER`。

---

## 3. 未分配 / 待认领（公共待办）`unassigned`

### 3.1 定位

**这是全租户共享的、与我无关的积压。** 它是本契约里**唯一一个故意不做个人过滤**的区块。
理由只有一个，且是 D-33 要求的：**如果没有它，一条没人被指派的单子在所有人的工作台里都不存在**，而它正是最该被看见的那种单子。

### 3.2 六类无主来源 + 精确谓词

| # | `kind` | 无主判定 | `why_unassigned` |
|---|---|---|---|
| 1 | `TASK_NO_OWNER` | `WAITING_HUMAN` ∧ `created_by_actor_id IS NULL` ∧ 无 `ref_owner` 行 | `NO_OWNER_AND_NO_DERIVABLE_PERSON` |
| 2 | `REVIEW_QUEUE_UNCLAIMED` | `assignee IS NULL AND status='QUEUED'` | `ASSIGNEE_NULL` |
| 3 | `APPROVAL_UNMAPPABLE` | `PENDING` ∧ (`resource_type IN ('DECISION','OFFER')`) | `RESOURCE_TYPE_UNMAPPABLE` |
| 4 | `APPROVAL_NO_HIRING_MANAGER` | `PENDING` ∧ 资源可映射但 `department.hiring_manager_actor_id IS NULL` | `DEPARTMENT_MANAGER_NULL` |
| 5 | `INTAKE_NEEDS_REVIEW` | `intake_record.status='NEEDS_REVIEW'` | `NO_ASSIGNEE_COLUMN` |
| 6 | `INTERVIEW_RECORD_UNASSIGNED` | `NEEDS_REVIEW ∧ is_current` ∧ 该面试**没有任何** `interviewer` 行 | `NO_INTERVIEWER_ASSIGNED` |

```sql
-- 1) 无主人工任务
with refs as (
  select bt.id as task_id, bt.tenant_id, r.value as r
    from recruitment.business_task bt
    cross join lateral jsonb_array_elements(bt.business_refs) r
), ref_owner as (
  select distinct rf.task_id, ivr.actor_id as owner_actor_id
    from refs rf
    join recruitment.interviewer ivr
      on rf.r->>'kind' = 'INTERVIEW'
     and (rf.r->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and ivr.interview_id = (rf.r->>'id')::uuid
     and ivr.tenant_id = rf.tenant_id
  union
  select distinct rf.task_id, d.hiring_manager_actor_id
    from refs rf
    join recruitment.application a
      on rf.r->>'kind' = 'APPLICATION'
     and (rf.r->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and a.id = (rf.r->>'id')::uuid
     and a.tenant_id = rf.tenant_id
    join recruitment.job j        on j.id = a.job_id        and j.tenant_id = a.tenant_id
    join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
   where d.hiring_manager_actor_id is not null
)
select 'TASK_NO_OWNER'::text as kind, bt.id as entity_id
  from recruitment.business_task bt
 where bt.tenant_id = :tenant_id
   and bt.status = 'WAITING_HUMAN'
   and bt.created_by_actor_id is null
   and not exists (select 1 from ref_owner o where o.task_id = bt.id)
union all
-- 2) 待认领的人工队列条目
select 'REVIEW_QUEUE_UNCLAIMED', q.id
  from recruitment.review_queue q
 where q.tenant_id = :tenant_id and q.assignee is null and q.status = 'QUEUED'
union all
-- 5) 待复核的接入记录
select 'INTAKE_NEEDS_REVIEW', ir.id
  from recruitment.intake_record ir
 where ir.tenant_id = :tenant_id and ir.status = 'NEEDS_REVIEW'
union all
-- 6) 有待复核记录、但那场面试没挂任何面试官
select 'INTERVIEW_RECORD_UNASSIGNED', ird.id
  from recruitment.interview_record ird
 where ird.tenant_id = :tenant_id
   and ird.status = 'NEEDS_REVIEW'
   and ird.is_current
   and not exists (select 1 from recruitment.interviewer ivr
                    where ivr.interview_id = ird.interview_id
                      and ivr.tenant_id = ird.tenant_id);
-- 3)/4) 由 §2.5 的 pending_approval CTE 取 NOT EXISTS(...) 反集得到
```

### 3.3 三条硬规矩

1. **`unassigned` 恒返回**，不受 `sections` 参数影响（`tool-contracts.md` §1.5）。可以在结果里被我"折叠"，但不能被我"请求不到"。
2. **不许把 `unassigned` 当成"别人的事"**。它**没有别人**——它就是没人认领。界面文案必须写"未分配（全租户共享）"，不写"其他"。
3. **只读**：这个区块**不提供认领按钮的写能力**。认领是一次真实的 `UPDATE review_queue SET assignee=…`（受 `fn_review_queue_before_update` 与 `SET LOCAL recruitment.actor_id` 约束），属写侧工具，不属本只读工具。

---

## 4. 全局可见 ≠ 工作台可见

D-33 把这两件事同时定了，它们必须被分开实现，否则会互相冒充。

| 命题 | 正确理解 | 错误实现（会被判违约） |
|---|---|---|
| 数据层 | 任何 `actor` 都能查到任何一行（全局可见） | 在查询里加 `tenant_id = 调用方租户` 之外的 ACL |
| 工作台 | 默认只显示"与我有关" + "没有人有关"（`unassigned`） | 把工作台当作"我能看到什么"的唯一入口 |
| 越权判定 | **不存在**。本层没有 403 | 返回空结果伪装成"无权查看" |

**推论 1（必须有出路）**：既然工作台只是过滤器，那么"我要看全部"必须走得通——用其它工具（`recruitment_job_get` / `recruitment_screening_evaluate` / 后续的 list 工具）查，而不是给本工具加一个 `scope=all` 开关。**加 `scope=all` 会让"工作台"变成"查询台"，然后它的五个谓词就没人维护了。**

**推论 2（不得反向推断不存在）**：某条记录不在我的工作台里，**只说明它与我无归属关系**，不说明它不存在、也不说明它已处理完。

**推论 3（`unassigned` 是共享的）**：同一个 `unassigned` 条目会同时出现在多人的工作台上。这是**故意**的——库里没有"认领"动作之前，它本来就属于所有人。一旦有人认领（写 `assignee`），它会立刻从 `unassigned` 消失、出现在那个人的 `pending_reviews` 里。**没有第二个副本**。

---

## 5. 工作台不做什么

| # | 不做 | 为什么 | 做了会怎样 |
|---|---|---|---|
| 1 | **不做权限** | D-33：v1.0 无 RBAC；角色只作标签 | 变成一套假的 RBAC：所有人都是"有权限"，但代码路径上多了一层永远返回 true 的检查（D-33 明确"当前不预留假接口"） |
| 2 | **不隐藏积压** | 硬要求 §0.3 | 一条无人指派的单子在所有工作台里都不可见；它只在出事故时才被想起来 |
| 3 | **不改变数据** | §0.2 只读 | 写 `last_seen` → "最近处理"变成"最近打开"；自动认领 → 认领这个动作失去审计意义（`review_audit` 会记到一个没做过决定的人） |
| 4 | **不改变事实** | 投影不改源 | 合并候选人、去重实体、补默认负责人、回填 `assignee`——每一件都会让"谁负责"从**记录**变成**推断**，且推断没有留痕 |
| 5 | **不做审批矩阵** | D-33 撤掉了权限矩阵 | `approval` 上加 `approver_actor_id` 的分配规则 = 一张隐式审批矩阵；本轮不建 |
| 6 | **不做角色判定** | §1 R-WB-4 | `actor_role` 参与过滤 → 改了角色就改了谁看到什么（这就是 RBAC，只是没写在文档里） |
| 7 | **不做跨租户"全局"** | 每条 SQL 都带 `tenant_id`（由 `actor.tenant_id` 推出） | 多租户物理隔离（`SCHEMA.md` §1）被一个"全局可见"的误读推翻 |

---

## 6. 三个判定用例

> **口径声明（R3）**：以下三例是**规格期望**，不是实测结果。
> 实测到的是：① 五段谓词在真实 schema 上 `EXPLAIN` 全部通过（§9.1）；② 在 `ra_align` 的真实种子上，`actor 102`（部门用人经理）的 `jobs` 区块返回 1 条、`actor 104`（面试官）全空（§9.2）。
> 三例的具体条目需要夹具 `F-WB-A/B/C`（每例列了最小行集）。**没有夹具就宣称"用例通过"= 违反 R3。**

### 6.1 用例 A · 一个面试官 = 2 场面试的面试官 + 1 个岗位的用人经理

**夹具 `F-WB-A`**（最小行集）：
`actor A`；`department D`（`hiring_manager_actor_id = A`）；`job J`（`department_id = D`，`status='OPEN'`）；
`application P1`、`P2`（均 `job_id = J`）；`interview I1`（`application_id=P1`）、`I2`（`application_id=P2`），均 `status='SCHEDULED'`；
`interviewer (I1, A)`、`interviewer (I2, A)`，`required_scorecard=true`；无 `scorecard` 行。

**期望输出**：

| 区块 | 条数 | 内容 |
|---|---|---|
| `tasks` | 0 | 无任务 |
| `interviews` | **2** | I1、I2，`relation=INTERVIEWER`，`needs_scorecard=true`，`required_action=SUBMIT_SCORECARD` |
| `jobs` | **1** | J，`relation=HIRING_MANAGER`（同时命中 INTERVIEWER：A 在 J 下当过面试官 → `relations=["HIRING_MANAGER","INTERVIEWER"]`），`required_action=NONE` |
| `applications` | **0** | 没有任何 touch（夹具里没有由 A 发生的写动作） |
| `pending_reviews` | **2** | 两条 `SCORECARD_DUE`，`id` = 两个 `interviewer.id`（**不是** `interview.id`，也**不是** `scorecard.id`） |
| `unassigned` | 0 | — |

**三个必须成立的判定**：
1. `jobs` 里只有 **1** 条 J，且 `relations` 同时含 `HIRING_MANAGER` 与 `INTERVIEWER`——**不是 2 条**。
2. `interviews` 有 **2** 条，`pending_reviews` 也有 **2** 条，**同一个面试在两个区块各出现一次**（这是**允许的投影**：区块是视角，不是实体去重表）；但**同一区块内不重复**，且跨区块必须用 `ref` 互指（`tool-contracts.md` §3.3）。
3. `applications` = **0**。夹具里 A 没有做过任何写动作。**如果实现给出 2 条，说明它把"我参与了这场面试"当成了"我处理过这个申请"**——那是把两件事混为一谈。

**错法**：`pending_reviews` 用 `interview.id` 当条目 id → 两场面试两个 id，看似对，但一旦同一场面试有两个必须交卡的人（用人经理 + 专家，`slot_code` 允许，`:949-950`），两个人会拿到同一个 id，前端勾选会串。

### 6.2 用例 B · 刚入职的人，没有任何分配

**夹具 `F-WB-B`**：`actor B`（`kind='HUMAN'`、`status='ACTIVE'`、`department_id=D`，**但**：不是任何 `interviewer`、不是任何 `assignee`、没建过任何 `business_task`、不是任何部门的 `hiring_manager`）；同时库里**存在** 1 条 `REVIEW_QUEUE_UNCLAIMED` 与 1 条 `INTAKE_NEEDS_REVIEW`。

**期望输出**：

| 区块 | 条数 | 说明 |
|---|---|---|
| `tasks` | 0 | |
| `interviews` | 0 | |
| `jobs` | 0 | 注意：B 在部门 `D` 里，但 `D` 的用人经理**不是**他 → **不因"同部门"而出现** |
| `applications` | 0 | |
| `pending_reviews` | 0 | |
| **`unassigned`** | **≥2** | `REVIEW_QUEUE_UNCLAIMED` ×1、`INTAKE_NEEDS_REVIEW` ×1 |

**判定**：**结果不是空白。** 五个"我的"区块全 0，但 `unassigned` 非空，且 `status` 仍是 `"OK"`。
如果实现返回一个全 0 的响应而不带 `unassigned`，或把"全 0"当成错误（`NOT_FOUND` / `EMPTY`），**都判违约**——那正是把无主积压藏起来的具体形态。

**同时必须成立**：`unassigned` 里**不含**"B 所在部门的其他岗位"。§2.3 的岗位谓词里没有 `actor.department_id` 这一项；**同部门不是"参与"**。

### 6.3 用例 C · 一个任务没有 owner

**夹具 `F-WB-C`**：`business_task T`（`status='WAITING_HUMAN'`、`created_by_actor_id IS NULL`、`business_refs='[]'`）。

**期望**：

| 视角 | 结果 |
|---|---|
| 任何 `actor` 的 `tasks` 区块 | **0 条**（T 不属于任何人） |
| 任何 `actor` 的 `unassigned` 区块 | **有 T**，`kind=TASK_NO_OWNER`，`why_unassigned=NO_OWNER_AND_NO_DERIVABLE_PERSON` |
| 两个人同时查 | **都看得到同一条 T**（共享，不是副本） |

**三个变体（用来钉死边界）**：

| 变体 | 期望 |
|---|---|
| `created_by_actor_id = X`（X 是人） | 出现**且仅出现**在 X 的 `tasks`（`relation=OWNER`），**不在** `unassigned` |
| `refs` 含 `{"kind":"INTERVIEW","id":I1}` 且 I1 有 **3 个**面试官 | 出现在**这 3 人**的 `tasks` 里（这是**故意**的：这 3 人都是"相关人"），**不在** `unassigned` |
| `refs` 含 `{"kind":"CANDIDATE","id":C1}` | **不派生任何人**（候选人没有负责人列）→ 若 `created_by_actor_id` 也为空，则进 `unassigned` |

---

## 7. 与 `SCHEMA.md` / DDL 对不上的字段（逐条，附证据）

| # | 契约想说的 | 库里实际有什么 | 处置 |
|---|---|---|---|
| 1 | "我**负责**的岗位 / 用人经理" | **`job` 没有 `hiring_manager_actor_id`，也没有 `owner_actor_id`**（`0001_init.sql:504-533` 全列）。用人经理只在 `department.hiring_manager_actor_id`（`:331`） | 用 `job.department_id → department` 推导。**同部门 ≠ 我的岗位**，所以必须精确到"我是这个部门的用人经理" |
| 2 | "**我**的待办任务" | **`business_task` 没有 `owner_actor_id` / `assignee`**（`:1397-1456`）。唯一人员列是 `created_by_actor_id`（`:1407`） | 三源并集（§2.1），并**明确规定 `created_by_actor_id` 在本版本充当"责任人"**。它不等于 owner，这是已知妥协，登记在 §7 缺口 8 |
| 3 | "我负责的**面试**" | `interview` 无 owner 列；只有 `interviewer` 指派表（`:973-990`） | 只用 `interviewer.actor_id` |
| 4 | "**需要我确认**的审批" | **`approval` 没有 `approver_actor_id`**：只有 `requested_by_actor_id`（`:425`）与事后的 `decision_by_actor_id`（`:426`） | 从被审资源反查部门用人经理（§2.5 A）；推不出的进 `unassigned` |
| 5 | D-33 原话"我最近**看过**的候选人" | **没有任何表记录"谁看过什么"**（`0001`–`0004` DDL 全文检索：无 `viewed_*` / `last_view*` / `seen_at` / `read_by`；唯一的 `last_readback_at` 在 `transcript_artifact`/`durable_effect` 上，语义是"外部回读"） | **改口径为"最近处理过"**（§2.4），并**明确否掉**用 `updated_at` 冒充。建议总控把 D-33 该措辞回抄为"处理过"，否则文档会许诺一个不存在的能力（R5） |
| 6 | `review_queue` 主键 | **两处不一致**：`0003_review_queue.sql:218` 仍叫 `item_id`；**D-36 已裁定**改为单列 `id`；实测 `ra_align` 已是 `id`（`conversion_run.id` / `review_audit.id` 同样已改） | 契约统一写 `review_queue.id`。**`0003` 修正落地前，实现必须容忍 `item_id`**；这属已知状态债，不是契约错误 |
| 7 | `intake_record` 的"谁该复核" | 只有 `status_changed_by_actor_id`（`:679`），是"最后改状态的人"，**不是受理人** | 不用于归属；`NEEDS_REVIEW` 一律进 `unassigned`（`why=NO_ASSIGNEE_COLUMN`） |
| 8 | `business_task.created_by_actor_id` 的语义 | `fk_business_task_actor`（`:1433-1434`）只保证"是个合法 actor"，可空 | 契约**赋予**它"责任人"语义（v1.0）。**风险**：创建者 ≠ 责任人时无法表达。若 P2 要真实指派，开 `0005` 加 `owner_actor_id`，**不要**扩展 `business_refs.kind` |
| 9 | `interview_record` 的"谁复核" | 无 actor 列；有 `interview_id`（`:1185`）+ `is_current`（`:1198`） | 走"该场面试的面试官"；一场面试没有任何面试官 → `unassigned` |
| 10 | `application` 的"我改过" | 有 `status_changed_by_actor_id`（`:850`）与 `stage_changed_by_actor_id`（`:853`），**没有** `updated_by_actor_id` | 用两个 `*_changed_by_actor_id` + `decision` + `scorecard` 四源（§2.4）。**禁止**用 `updated_at` |
| 11 | `interviewer.role_in_interview` | 只有正则 `ck_interviewer_role`（`:989`），**无取值词表**；默认 `'INTERVIEWER'` | **只展示、不过滤**（R-WB-1）。若以后要按角色过滤，必须先加 CHECK 词表 + 回填，否则漏数据 |
| 12 | `business_refs` 元素形状 | 库只校验"是 array"（`:1445-1446`）；形状由 `screening-rules.md:291-297` 定义（7 个 `kind`） | 本契约**复用**该形状，**不新增 `kind`**；并对 `id` 加 UUID 正则 guard 防 `22P02` |

**对不上但不影响本契约的**：`stage_catalog`（0004）已把 `application.current_stage_code` 的默认值改为 `'S6'`（`0004:226`），本契约**不按阶段做归属判定**（阶段是流程状态，不是人），所以无影响。若将来要做"按阶段分派"，必须先在 `stage_catalog` 上加"该阶段默认责任角色"——那是新决策，不是本契约的延伸。

---

## 8. 验收清单（可机检）

| # | 检查 | 期望 | 判废条件 |
|---|---|---|---|
| 1 | 五个区块各有一条完整可执行 SQL | 见 §2 | 出现"相关人员""有关人员""等"这类词 |
| 2 | 每条 SQL 都用真实字段名 | 与 `0001`/`0003`/`0004` 逐字一致 | 出现不存在的列（如 `job.hiring_manager_actor_id`） |
| 3 | `unassigned` 在 `sections` 只给 `["tasks"]` 时仍返回 | 非空（有积压时） | 被过滤掉 |
| 4 | 空工作台（新人） | `status="OK"`，5 块计数为 0，`unassigned` 照常 | 返回错误 / 返回 `null` |
| 5 | 无主任务同时出现在多人 `unassigned` | 同一 `entity_id` 多人可见 | 被分摊给某人 |
| 6 | `role_in_interview` 缺失（默认 `INTERVIEWER`）的面试官 | 照样出现在其 `interviews` | 漏掉 |
| 7 | 脏 `business_refs`（`id` 非 UUID） | 视为不匹配，不报错 | 抛 `22P02` |
| 8 | 同一申请有 4 类 touch | `applications` 里 **1** 条 | 4 条 |
| 9 | 同一岗位命中多关系 | `jobs` 里 **1** 条，`relations` 多值 | 多条 |
| 10 | `approval` 的 `resource_type='DECISION'` | 进 `unassigned`，不进任何人 `pending_reviews` | 被算给某人 |

---

## 9. 实测记录（本契约自带的证据，不是自述）

### 9.1 五段谓词在真实 schema 上 `EXPLAIN` 通过

环境：PostgreSQL 17，库 `ra_align`（已应用 `0001`/`0002`/`0003`(含 D-36 改名)/`0004`），`psql` = `D:\12412\PostgreSQL\bin\psql.exe`。

```
$ psql -U postgres -h 127.0.0.1 -d ra_align -c "explain (costs off) <§2.1 的 SQL>"
 Index Scan using ix_business_task_dispatch on business_task bt
   Index Cond: (tenant_id = '11111111-…-000000000001'::uuid)
   Filter: ((status <> ALL ('{SUCCEEDED,FAILED,CANCELLED,SUPERSEDED}'::text[]))
            AND ((created_by_actor_id = '…0102'::uuid) OR (ANY (id = (hashed SubPlan 3).col1))))
```

§2.2 / §2.3 / §2.4 / §2.5 / §3 各自同样 `EXPLAIN` 通过（`Append` / `Nested Loop` / `Limit` 计划均正常生成，零 `ERROR`）。
说明：**谓词里出现的每一个表名、列名、类型都是真的**，不是照着文档抄的想象。

### 9.2 真实种子上的执行结果

```
$ psql -U postgres -h 127.0.0.1 -d ra_align -t -A -F '|' -c "<§2.3 的 SQL，actor=…0102>"
JOBS|11111111-1111-4111-8111-000000000401|DEMO-BE-001|OPEN|HIRING_MANAGER

$ 同一条 SQL，actor=…0104（面试官）
（0 行）
```

- `actor 102` = `0002_seed.sql:97-100` 里被设为部门用人经理的人 → 岗位区块命中 demo 岗位 1 条，`relation=HIRING_MANAGER`。**这证明 §2.3 的推导链（`job → department → hiring_manager_actor_id`）在真实数据上生效。**
- `actor 104` = 面试官 → 全空。**这就是用例 B 的"全 0"形态**；它同时说明：没有夹具时工作台**就是**空的，所以 `unassigned` 不是装饰。

### 9.3 明确**没有**做的验证

- 三例（§6）**没有**在真实数据上跑：`ra_align` 里 `interview` / `interviewer` / `business_task` / `review_queue` / `approval` 全为 0 行（实测），造夹具需要写入，**超出本任务"只写契约"的范围**。
- 因此 §6 的三例是**规格**。谁要实现，必须建 `F-WB-A/B/C` 后再跑；跑不出来不算通过。

---

## 10. 本文件不规定的事

| 不规定 | 归谁 |
|---|---|
| 输出 JSON 形状、错误码、参数 | `tool-contracts.md`（同目录） |
| SQL 怎么拼、要不要建视图/物化视图 | 实现方；**禁止**在工具层拼字符串 |
| 认领 / 转派怎么写库 | 写侧工具（受 `fn_review_queue_before_update` + `SET LOCAL recruitment.actor_id` 约束） |
| 界面怎么排、折叠哪些块 | 前端。本契约只保证 `unassigned`**能拿到**，不保证它**被展开** |
| 将来开权限时怎么做 | 另一份 ADR。**在此之前不得预留 `can()` 之类恒 true 的假接口**（D-33 风险登记原文） |

**版本变更**：新增区块 / 新增归属来源 → `1.1.0`；任何谓词语义变化（同一行开始落入别人的工作台）→ `2.0.0`。
