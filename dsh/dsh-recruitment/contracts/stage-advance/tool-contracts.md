# stage-advance/tool-contracts.md · `recruitment_application_stage_advance`

**契约版本**：`stage-advance 1.3.0`（2026-11-15 **G3 裁决 B**；1.1 起 blocker/warning 带**结构化责任人 + 下一步**，并新增只读阻塞视图；
1.2 起梯子从两条边扩到**四条边**：新增 T3 `S8→S9`、T4 `S9→S10`，并裁决 **S10 = v1.0 终态**；新增
`INTERVIEW_NOT_COMPLETED` / `TRANSCRIPT_NOT_READY` 两条 blocker 码与四个 next_action_code；
1.3 起 T3 的事实改为「材料就绪（canonical READY 转写）」——删除「面试已执行」表述，`interview.status` 只作排期状态；
T4 在「材料可用」之外增加「该申请关联面试至少 1 份 `status="SUBMITTED"` 面评」，0 份 → `SCORECARD_REQUIRED`（新 blocker 码）
+ `SUBMIT_SCORECARD`（新 next_action_code），零写入；新增 0016 一致性视图 `v_application_stage_consistency`）
**状态**：本 lane 交付（**待独立复核**；实现者不验收自己的工作）
**覆盖范围**：一个工具 —— `recruitment_application_stage_advance`（阶段推进的**唯一写入口**），
外加一个**只读**的阻塞视图函数 `readStageBlockedView`（供工作台直接用，不是工具、不注册）。
**实现**：`src/tools/stage-advance.ts`（胶水：入参/事务/标签）+ `src/domain/stage-advance.ts`（判定/责任推导/版本守卫/时间戳/只读视图）。
**测试**：`test/unit/stage-advance.test.ts`（假库：判定矩阵 + 零 UPDATE + 并发错误映射 + 结构化责任 + 视图 + 四条边全链）、
`test/integration/stage-advance.test.ts`（真库：A1–A9 全部读库回验）、
`test/integration/stage-advance-s8-s10.test.ts`（真库：**A12–A18** 证明 S8→S9→S10 真的能推进并读回 `current_stage_code=S10`，
且无 SUBMITTED 面评时拒绝且零写入）、
`test/integration/stage-advance-g3-consistency.test.ts`（一次性库：干净库 S6→S10 后 S10 必有 ≥1 SUBMITTED；0016 视图 0 违规）、
`test/integration/f1-rubric-pin.test.ts`（A10）、`test/integration/scorecard-rubric-version-gate.test.ts`（A11）。
**位置在哪个缺口**：`docs/23` N8 / P1-09（阶段推进无入口）、`docs/18` §3.7 第 ① 条；
`§11.6-8`（HR 能从工作台理解「状态 + 阻塞原因 + 责任人 + 下一步」）。
**1.2 修复的缺口**：**D-A**（P1 范围缺口，证据见 `evidence/experiments/2026-11-14-golden-path-rerun/README.md §6`）——
Golden Path 跑完 S10 之后 `application.current_stage_code` 仍停在 S8，因为梯子只到 S8；
现由 T3/T4 补到 S10（S10 = `stage_catalog.in_v1_scope` 的最后一格，见 §2.5）。
**阶段码权威**：`recruitment.stage_catalog`（见 `contracts/STAGE-CODES.md`）；本文件不新增、不改名任何阶段码。
**与其它契约冲突时**：本文件只覆盖这一个工具与这一个视图；`decision` 的写侧以
`contracts/evaluation/decision-rules.md` §17.1 为准，S7 评估以 `contracts/job-screening/tool-contracts.md` 为准；
S8/S9 的事实口径以 `contracts/interview/scheduling-rules.md` §7.5/§8 与
`contracts/interview/transcript-rules.md` §3/§8 为准。

---

## 0. 它不做什么（先写边界，避免"命令式推进"回流）

方案 D = **派生式推进命令**：工具只"**承认已经发生的事实**"，不新增任何授权。

| # | 不做 | 为什么 |
|---|---|---|
| 1 | 不接受目标阶段（没有 `to_stage` / `stage_code` 入参） | 一旦能指定目标，模型就能跳阶；"能跳到哪"必须由事实决定 |
| 2 | 不接受 `actor_id` / `tenant_id` / 时间 | 身份只能来自执行上下文（`SET LOCAL recruitment.actor_id`）与插件配置 |
| 3 | 不写 `decision`、不建 `business_task` | 那是 `recruitment_decision_record` 与任务层的事（D-79/D-95 的人机闸门不能被绕开） |
| 4 | 不改 `lifecycle_status`、不写 `stage_blocked_reason` | 本命令只动"阶段指针"这一个轴；BLOCKED 也不落库（零写） |
| 5 | **不新造授权**（F1 补钉只是把**已批准**的事实记录到申请上） | rubric 版本必须已由人批准、且是 `job.current_rubric_version_id` 指向的那一版；补钉见 §2.1.1 |
| 6 | 不重试到成功、不 last-write-wins | 版本冲突 → `VERSION_CONFLICT`，把"重读"交回调用方 |
| 7 | 不倒退、不跳阶 | 指针已超前（> S10）→ `STAGE_AHEAD` 警告 + 一条 UPDATE 都不发（见 §7.3）；中间任一前置不成立就停在那一格 |
| 8 | 阻塞里的"责任人"**不编造** | 能从库里推出就填 `owner_actor_id`，推不出来只给 `owner_role` + `next_action_code`（见 §5） |
| 9 | **不发明阶段码，也不越过 S10** | 梯子到 S10 为止（`in_v1_scope` 的最后一格）；S10 的决策由 `decision` 行表达，不改阶段指针（见 §2.5） |

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

## 2. 事实：只承认四条边（T1–T4）

梯子有四条边，**顺序执行、不许跳**：

```
S6 ──T1──▶ S7 ──T2──▶ S8 ──T3──▶ S9 ──T4──▶ S10（v1.0 终态，停在 S10）
```

> S6 = 简历接入与处理（Intake）；S7 = 初筛 / Screening；S8 = 面试规划与排期；
> S9 = 面试执行与材料获取；S10 = 综合评价与招聘决策。
> 每条边的判据都是**上一格的工作已经完成**（与 T1/T2 同一口径）：T3 = **材料就绪**（canonical READY 转写）；
> T4 = **材料可用 + 至少 1 份已提交面评**。`interview.status` 只是**排期状态**，不承载「面试是否发生」（G3 裁决 B）。
> S10 之后没有边（见 §2.5）。

### 2.1 T1：S6 → S7（材料 + rubric）

三个**前置事实**同时成立才推进；否则 `BLOCKED`（阶段不变、零 UPDATE）：

| # | 事实 | 不成立时的 `blockers[].code` | `owner_role` | `next_action_code` |
|---|---|---|---|---|
| 1 | `application.resume_version_id` 非空 | `MATERIAL_NOT_LINKED` | `RECRUITMENT_OWNER` | `LINK_INTAKE_MATERIAL` |
| 2 | 该 `resume_version.parse_status <> 'FAILED'` | `MATERIAL_PARSE_FAILED` | `RECRUITMENT_OWNER` | `REPARSE_MATERIAL` |
| 3 | `application.rubric_version_id` 非空 | `RUBRIC_NOT_PINNED` | `JOB_HIRING_MANAGER` | `PIN_RUBRIC_VERSION` |
| 3b | **补钉不会撞已有面评的版本**（SC-11） | `RUBRIC_PIN_CONFLICT_WITH_SCORECARD`（**只读视图**报；写路径以同一 code 抛错） | `JOB_HIRING_MANAGER` | `RESOLVE_RUBRIC_PIN_CONFLICT` |

**实现口径（写死）**：材料只用 `resume_version.parse_status` 判定，**只把 `FAILED` 当反向事实**；
`PARSED` / `PARTIAL` / `NEEDS_REVIEW` / `PENDING` / `PARSING` 都放行（设计如此；见 §13 未决 1）。

#### 2.1.1 rubric 补钉（F1；本命令**唯一的业务写入**）

事实 3 有两个来源，缺一不可：

| # | 写入时机 | 谁写 |
|---|---|---|
| 1 | intake **新建申请**时，岗位已有已批准的 current | `application-intake.ts`（`application.rubric_version_id` 随 INSERT 落库） |
| 2 | 申请先建、岗位**之后**才批准 rubric（常态：先收简历，后定标准） | **本命令的 T1 判定**（补钉） |

补钉的封死边界：

1. 只认 `job.current_rubric_version_id`（**D-21**：当前只由这个指针说话，**不是** `max(version_no)`；
   **D-48**：指针为空 = 没有当前版本，**不回退**推导）。
2. 当场复核该版本**此刻已批准**：`approval.status='APPROVED'` + `canonical_payload_hash` 与
   `rubric_version.payload_hash` 一致 + 未被取代 + 未过期（`job-rubric-rules.md` §4.2 的 `approved(v, as_of)`）。
   **不读** `rubric_version.approved_by_approval_id`（可空指针，不保证是 APPROVED、不保证 hash 一致）。
3. **只在 T1 的唯一缺口就是这个 rubric 时**补钉：材料还没绑 / 解析失败时一行都不写（BLOCKED 必须零写入）。
3b. **SC-11 冲突前置（本命令唯一的业务拒绝）**：补钉前必须确认该申请**没有**绑在别的
   rubric 版本上的现行面评（`scorecard.superseded_by_scorecard_id is null` ∧
   `status ∈ {SUBMITTED, WAIVED}` ∧ `rubric_version_id ≠ 待钉版本`）。
   有冲突 → `INVARIANT_VIOLATION(RUBRIC_PIN_CONFLICT_WITH_SCORECARD)`，**零写入**，
   `detail` 带 `pin_target_rubric_version_id` / `conflicting_rubric_version_ids` /
   `conflicting_scorecard_count` / `conflicting_scorecard_ids` / `owner_role` / `next_action_code`。
   理由：补钉会让旧版面评被静默算进绑新版的汇总/决策 —— **SC-11 明令禁止混用**；
   这是人工裁决点（沿用面评实际使用的版本，或作废/重做那些面评），不是等一等会消失的缺失。
4. 同一事务内顺序：条件 `UPDATE application … where rubric_version_id is null`（经 `fn_row_guard`，
   `record_version` 自增）→ 写一条内部审计事件 → 才发阶段 UPDATE。
   阶段 UPDATE 的乐观并发条件必须用**补钉之后**的 `record_version`。
5. `UPDATE` 前必须已 `SET LOCAL recruitment.actor_id`（`withActor`）；没有 actor → `INVALID_ARGS(ACTOR_REQUIRED)`，
   **拒绝匿名写入**。审计事件里记的就是这个执行账号（它不是"决策人"，见 §9）。
6. **只读视图不补钉**（`allowPin=false`）：它一条写语句都不发；如果"没钉 rubric"其实会撞
   已有面评的版本（3b），视图直接报 `BLOCKED(RUBRIC_PIN_CONFLICT_WITH_SCORECARD)`（结构化
   `owner_role=JOB_HIRING_MANAGER` + `next_action_code=RESOLVE_RUBRIC_PIN_CONFLICT`），
   否则仍按"当前事实"报 `RUBRIC_NOT_PINNED`。
   这不是两套判据 —— 视图回答"库里现在缺什么/为什么补不了"，写路径回答"这次调用能不能把已批准的事实补齐后推进"。
7. 本命令**不因此获得任何新授权**：rubric 版本已经由人批准过；没有批准就没有可钉的版本。

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

### 2.3 T3：S8 → S9（材料就绪 = canonical READY 转写）

判定式 = **该申请的材料已经到手且可用**这一件事实（G3 裁决 B；**不再**以「面试已执行」为判据）：

| # | 事实 | SQL（只读） | 依据 |
|---|---|---|---|
| 1 | 该申请存在 `is_canonical=true` ∧ `transcript_status='READY'` 的转写产物（经**未解绑**的 `meeting_binding` 可达） | 见 §2.4 的同一查询（T3/T4 共用 `readTranscriptArtifacts`） | `contracts/interview/transcript-rules.md` §3/§4：`canonical READY` 才是 `transcript.state='READY'` = 材料可用；材料存在本身证明那场面试已经发生过（§7.5 因果链） |

结论表：

| 查到的事实 | 结论 |
|---|---|
| 存在 canonical READY 转写 | `PASS` → 推进到 S9 |
| 有产物但取不回来：`transcript_status ∈ {AUTH_REQUIRED, RETRYABLE_FAILED, NEEDS_LINKING}` | `BLOCKED`（`TRANSCRIPT_NOT_READY`，`owner_role=RECRUITMENT_OWNER`，`next_action_code=REIMPORT_TRANSCRIPT`），阶段**留在 S8** |
| 有材料但还没 READY（`DISCOVERED` / `FETCHING` / `PARTIAL` / `WAITING_EXTERNAL`） | `WAIT`（`pending_fact='TRANSCRIPT_MATERIAL'`）→ **`NO_OP`**；视图下一步 = `IMPORT_TRANSCRIPT` |
| 没有任何面试（还没排期） | `WAIT`（`pending_fact='INTERVIEW_SCHEDULING'`）→ **`NO_OP`**；视图下一步 = `SCHEDULE_INTERVIEW` |
| 有面试但都还是 `SCHEDULED` / `RESCHEDULED`，且没有材料 | `WAIT`（`pending_fact='INTERVIEW_EXECUTION'`）→ **`NO_OP`**；视图下一步 = `IMPORT_TRANSCRIPT` |
| **所有**面试都是 `CANCELLED` / `NO_SHOW`（且没有材料） | `BLOCKED`（`INTERVIEW_NOT_COMPLETED`，`owner_role=JOB_HIRING_MANAGER`，`next_action_code=RESCHEDULE_INTERVIEW`），阶段**留在 S8** |

* **`interview.status` 只作排期状态**（G3 裁决 B）：它只回答「排期到哪一步/要不要重新排期」，
  **不再**作为「面试是否发生」的证据，也**不是任何边的 PASS 依据**。`IN_PROGRESS` / `POST_INTERVIEW`
  不会让阶段推进；推进只认材料（转写）这一条硬事实。
* **为什么材料可以替代「面试已执行」**：`transcript_artifact` 只能经 `meeting_binding → interview` 归属到申请
  （`transcript-rules.md §7.5`：没有 meeting 就没有 `transcript_artifact`），所以「材料在」⇒「那场面试发生过」；
  而 v1.0 的 `interview_schedule` 没有 START/COMPLETE 入口（`docs/18 §4`），`IN_PROGRESS` / `POST_INTERVIEW`
  在产品路径上根本写不出来 —— 把「面试已执行」当闸门会让阶段永远到不了 S9（D-A 的另一种复发）。
* **与 D-111 #1 的冲突**：D-111 #1 曾拟「补 S9 的 START/COMPLETE 写入口、面试已执行必须是产品记录的事实」；
  G3 裁决 B 把 T3 的事实定为**材料就绪**。本文件按 B 执行；D-111 #1 的写入口降级为**可选**（不影响 v1.0），
  由总控在 `docs/17` 回抄时统一措辞（本轮不新增第二条判据）。
* 有多场面试时：任意一场已有 canonical READY 材料 ⇒ PASS；全部取消/未到场且无材料才 BLOCKED。

### 2.4 T4：S9 → S10（材料可用 + ≥1 份已提交面评）

两个前置**同时**成立才推进（G3 裁决 B）：

**① 材料可用（既有前置，保留）** —— 存在该申请的 `canonical` 且 `READY` 的转写产物：

```sql
select ta.id, ta.transcript_status, ta.is_canonical
  from recruitment.transcript_artifact ta
 where ta.tenant_id = $1
   and exists (
     select 1
       from recruitment.meeting_binding mb
       join recruitment.interview iv
         on iv.id = mb.interview_id and iv.tenant_id = mb.tenant_id
      where mb.tenant_id = ta.tenant_id
        and mb.meeting_id = ta.meeting_id
        and mb.unbound_at is null          -- 有效绑定；解绑后事件无法定位到面试（§7.5）
        and iv.application_id = $2
   )
 order by ta.created_at, ta.id;
```

| ① 查到的事实 | 结论 |
|---|---|
| 有 `is_canonical=true` ∧ `transcript_status='READY'` | 继续判 ② |
| 没有材料，或材料还在 `DISCOVERED` / `FETCHING` / `PARTIAL` / `WAITING_EXTERNAL` | `WAIT`（`pending_fact='TRANSCRIPT_MATERIAL'`）→ **`NO_OP`**；视图下一步 = `IMPORT_TRANSCRIPT` |
| 有材料但取不回来：`{AUTH_REQUIRED, RETRYABLE_FAILED, NEEDS_LINKING}` | `BLOCKED`（`TRANSCRIPT_NOT_READY`，`owner_role=RECRUITMENT_OWNER`，`next_action_code=REIMPORT_TRANSCRIPT`），阶段**留在 S9** |

**② 至少 1 份已提交面评（1.3 新增）** —— 该申请关联的面试下，`scorecard.status='SUBMITTED'` 的行数 ≥ 1：

```sql
select count(*)::int as n
  from recruitment.scorecard s
  join recruitment.interview i
    on i.id = s.interview_id and i.tenant_id = s.tenant_id
 where s.tenant_id = $1
   and i.application_id = $2
   and s.status = 'SUBMITTED';
```

| ② 查到的事实 | 结论 |
|---|---|
| `count = 0` | `BLOCKED`（**`SCORECARD_REQUIRED`**，`owner_role=JOB_HIRING_MANAGER`，`next_action_code=SUBMIT_SCORECARD`），阶段**留在 S9**，**零写入** |
| `count ≥ 1` | `PASS` → 推进到 S10 |

口径与理由（别扩、也别减）：

* **只数 `SUBMITTED`**：SC-26 规定 `scorecard_submit` 只产 `SUBMITTED`；`PENDING` 未交、`WAIVED` 是人工豁免，
  都不是「有人提交了面评」。**不**按 `superseded_by_scorecard_id` 过滤 —— 判据是「这次招聘至少发生过一次
  人提交的评价」（指令原文「至少 1 份 SUBMITTED」），历史修订行仍是已提交事实。
* **与 1.2 旧口径的差异（刻意改判）**：1.2 曾写「面评齐是 S10 的工作，用它证明进入评价阶段是循环论证」。
  G3 裁决 B 明确 S9→S10 的前置是**「本次面试至少 1 份已提交面评」**：多份面评、汇总、决策仍然是 S10 的工作，
  但「至少有一份人提交的面评」是进入决策阶段的**准入事实**，不是循环论证（不要求评价已汇总/已决策）。
* **仍然不作为闸门的**：`interview_record` 的 `READY` / `VERIFIED`（D-B 与 D-111 #2 不变）。
* **`NO_TRANSCRIPT` 不能进 S10**：G3=B 下 S8→S9 已要求 canonical READY，无转写在梯子上到不了 S9；
  D-111 #3「允许 NO_TRANSCRIPT 进 S10」与本裁决冲突，由总控回抄时裁定（本轮按 B 执行）。
### 2.5 终态裁决：S10 是 v1.0 的最后一格，**停在 S10，不再前进**

| 问题 | 裁决 | 依据 |
|---|---|---|
| S10 之后还有边吗？ | **没有**。本命令的梯子到 S10 为止。 | `db/migrations/0002_seed.sql` 的 `stage_catalog` + `db/STAGE-CATALOG.md §3`：`in_v1_scope` = true 的只有 **S3 / S6 / S7 / S8 / S9 / S10**；S11（Offer 与入职交接）/ S12（人才沉淀与复盘）**不在 v1.0 范围** |
| 要不要发明一个新码表示"结束"？ | **不发明**。`contracts/STAGE-CODES.md §5`：表里没有的阶段码不许自己编号；12 行之外没有第 13 个码 | 同上 + §5 铁律"两套编号不许并存" |
| S10 的决策写进阶段指针吗？ | **不写**。S10 的决策由 `decision(decision_scope='STAGE'/'FINAL', stage_code='S10')` 表达（`decision-record.ts` 按 scope 写死 `stage_code='S10'`）；阶段指针在 S10 就不再动 | `contracts/evaluation/decision-rules.md` DC-47（决策不写 `current_stage_code`） |
| 指针已经在 S11 / S12 怎么办？ | `NO_OP` + `STAGE_AHEAD` 警告，**一条 UPDATE 都不发**（不倒退；这两格**不做**） | §7.3 |
| 工作台在 S10 显示什么下一步？ | `next_action.code = CONTINUE_DOWNSTREAM`（"本命令已到 v1.0 终态 S10；S11/S12 不在 v1.0 范围（不做）"） | §6.2 |

---

## 3. 三态结论（封闭集）

| `status` | 含义 | 发 UPDATE？ | `transitions[]` | `blockers[]` | `warnings[]` |
|---|---|---|---|---|---|
| `ADVANCED` | 至少走了一条边 | 是（每条边一条） | 真实发生的边（1–4 条） | 推进到下一跳时遇到反向事实才非空 | 空 |
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
  "contract_version": "1.3.0",
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
| `tool` / `contract_version` | string | ✅ | `contract_version` 从 `1.1.0` 起包含结构化责任；从 `1.2.0` 起梯子到 S10（T3/T4）；从 `1.3.0` 起 T3=材料就绪、T4=材料+≥1 SUBMITTED 面评，新增 `SCORECARD_REQUIRED` 与 `SUBMIT_SCORECARD` |
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
| `PIN_RUBRIC_VERSION` | `RUBRIC_NOT_PINNED` | 先由 `recruitment_job_rubric_approve` 批准一版（它会更新 `job.current_rubric_version_id`），再调用本命令：写路径会在同一事务里把该版本钉到申请上 |
| `RESOLVE_RUBRIC_PIN_CONFLICT` | `RUBRIC_PIN_CONFLICT_WITH_SCORECARD`（SC-11） | 已有面评绑在别的版本上：由人先裁决口径 —— 或把申请钉到面评实际使用的版本（先批准该版本再重试），或先作废/重做那些面评，再钉新版本 |
| `LINK_INTAKE_MATERIAL` | `MATERIAL_NOT_LINKED` | 跑一次 intake，把材料绑定到这条申请 |
| `REPARSE_MATERIAL` | `MATERIAL_PARSE_FAILED` | 修复或重新导入材料（不能是 FAILED） |
| `RECORD_SCREENING_DECISION` | 视图：S7 在等决策 | 由人完成初筛并落一条 SCREENING 决策 |
| `SUPERSEDE_SCREENING_DECISION` | `SCREENING_DECISION_NOT_ADVANCE` | 若结论要改，由人做一次新的 SCREENING 决策取代当前这条 |
| `SCHEDULE_INTERVIEW` | 视图：S8 在等排期（`pending_fact=INTERVIEW_SCHEDULING`） | 用 `recruitment_interview_schedule`（CREATE，人过 approval）排一场面试 |
| `IMPORT_TRANSCRIPT` | 视图：S8 还没有材料 / S9 等材料（`INTERVIEW_EXECUTION` / `TRANSCRIPT_MATERIAL`） | 面试结束后用 `recruitment_transcript_import` 导入/回读转写（canonical READY） |
| `RESCHEDULE_INTERVIEW` | `INTERVIEW_NOT_COMPLETED` | 面试全被取消/未到场：由人重新排期（CREATE / RESCHEDULE），面试发生后再重试 |
| `SUBMIT_SCORECARD` | `SCORECARD_REQUIRED` | 由面试官用 `recruitment_scorecard_submit` 提交至少一份面评（SUBMITTED；走人工闸门），提交后重试推进 |
| `REIMPORT_TRANSCRIPT` | `TRANSCRIPT_NOT_READY` | 转写取不回来（AUTH_REQUIRED / RETRYABLE_FAILED / NEEDS_LINKING）：先修授权/绑定，再重新导入 |
| `REOPEN_APPLICATION` | `APPLICATION_NOT_ACTIVE` | 确认是否需要重开/重新建档（不在本命令范围） |
| `START_AT_INTAKE` | `STAGE_NOT_ON_LADDER` | 先用 intake 把申请带到 S6 |
| `VERIFY_STAGE_PROGRESSION` | `STAGE_AHEAD` | 核对这次阶段推进是谁做的；本命令不倒退（S11/S12 不在 v1.0 范围，不做） |
| `ADVANCE_STAGE` | 视图：事实已齐 | 调用 `recruitment_application_stage_advance` 推进 |
| `CONTINUE_DOWNSTREAM` | 视图：S10 终态 | 本命令已到 v1.0 终态 S10；S10 的决策由 `decision` 行表达；S11/S12 不在 v1.0 范围（不做） |

### 5.3 与 actor 诚实的关系（别混）

`owner_actor_id` 回答"**该找谁推进这件事**"；`application.stage_changed_by_actor_id` 回答
"**这条阶段 UPDATE 是谁执行的**"。两者**不是**同一个概念：
* T1（S6→S7）/ T3（S8→S9）/ T4（S9→S10）都是**自动推进**（承认已发生的事实），
  `stage_changed_by_actor_id` = 执行账号（配置里的 …0103），
  `owner_actor_id` = 招聘负责人（…0102）——**不是同一个人，也不是"人按了按钮"**；
* T2 的 `SCREENING_DECIDER` 是**真的做过 SCREENING 决策的人**（`decision.decided_by_actor_id`），
  这才配叫"决策人"；`stage_changed_by_actor_id` 仍然只是执行账号。
* T3/T4 的事实来自**上游已经被人类闸门约束过的写入口**（`interview_schedule` 走 `ctx.approval`；
  `transcript_import` 是 MANUAL 的产品入口），本命令**不新增**任何闸门、也不绕过它们（§0 第 9 条）。

---

## 6. 只读的「阻塞视图」`readStageBlockedView`（工作台直接用）

**不是工具、不注册、不新表**：一个导出的只读函数（`src/domain/stage-advance.ts`），
与推进命令**共用同一套判定**（`diagnose`），但：

* **`allowPin=false`：不补钉**（§2.1.1 的唯一写入在这里被关闭）；
* **不加行锁**（`diagnose(lock=false)` 用普通 `select`），因此可以安全跑在
  `begin transaction read only` 里（工作台的 `withReadOnly` 路由）；任何写都会被 PG `25006` 拒绝；
* **不写库、不需要 actor**；
* 工作台一次拿到四要素，不需要再自己拼字符串。

> 视图与写路径在"申请没钉、但岗位已有已批准 current"这一点上刻意不同：视图如实报告
> `RUBRIC_NOT_PINNED`（库里现在确实没钉），写路径会补钉后推进。视图**不发**任何写语句。

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

`pending_fact` 是闭集（`PENDING_FACTS`），视图用它算 `next_action.code`（`PENDING_ACTIONS` 同一张表；
写路径与视图共用，不在视图里另写 if/else）：

| 情况 | `pending_fact` | `next_action.code` |
|---|---|---|
| 事实已齐、可以推进 | —（`status=ADVANCED`） | `ADVANCE_STAGE` |
| S7 等人工初筛决策 | `SCREENING_DECISION` | `RECORD_SCREENING_DECISION` |
| S8 还没排面试 | `INTERVIEW_SCHEDULING` | `SCHEDULE_INTERVIEW` |
| S8 已排期、还没有材料（或 S9 等材料） | `INTERVIEW_EXECUTION` / `TRANSCRIPT_MATERIAL` | `IMPORT_TRANSCRIPT` |
| S10 终态 / 本命令无剩余动作 | — | `CONTINUE_DOWNSTREAM` |

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

### 7.2b rubric 补钉（F1，§2.1.1；只在满足条件时发）

```sql
-- ① 读"可钉的目标"：指针 + 此刻已批准（两条事实一起判）
select rv.id as rubric_version_id, rv.version_no
  from recruitment.application a
  join recruitment.job j
    on j.id = a.job_id and j.tenant_id = a.tenant_id
  join recruitment.rubric_version rv
    on rv.id = j.current_rubric_version_id and rv.tenant_id = j.tenant_id and rv.job_id = j.id
 where a.tenant_id = $1 and a.id = $2
   and j.current_rubric_version_id is not null
   and exists (select 1 from recruitment.approval ap
                where ap.tenant_id = rv.tenant_id and ap.resource_type = 'RUBRIC_VERSION'
                  and ap.resource_id = rv.id and ap.status = 'APPROVED'
                  and ap.canonical_payload_hash = rv.payload_hash
                  and ap.superseded_by_approval_id is null
                  and (ap.expires_at is null or ap.expires_at > now()));

-- ①b SC-11 冲突前置（只读）：已有现行面评绑在**别的**版本上 → 拒绝补钉（零写入）
select s.id, s.interviewer_id, s.status, s.rubric_version_id
  from recruitment.scorecard s
  join recruitment.interview iv
    on iv.id = s.interview_id and iv.tenant_id = s.tenant_id
 where s.tenant_id = $1 and iv.application_id = $2
   and s.superseded_by_scorecard_id is null
   and s.status in ('SUBMITTED', 'WAIVED')
   and s.rubric_version_id is distinct from $3;   -- 非空 ⇒ 抛 RUBRIC_PIN_CONFLICT_WITH_SCORECARD

-- ② 条件写：只有"仍然没钉"才写（值相同不发，歧义不覆盖）
update recruitment.application
   set rubric_version_id = $3
 where id = $1 and tenant_id = $2 and rubric_version_id is null
 returning record_version;          -- 触发器自增后的真实值，后续阶段 UPDATE 用它

-- ③ 审计事件（内部事实；FALLBACK_KEY 必须绑 source_object_id）
insert into recruitment.event_inbox (...)
values (... 'application.rubric_version.pinned', ...,
        'rubric-pin:<uuid>', 'FALLBACK_KEY', <application_id>,
        payload {table:'application', column:'rubric_version_id', record_id, application_id, job_id,
                 rubric_version_id, rubric_version_no, from:null, to:<rubric_version_id>,
                 actor_id, application_record_version, source, reason});
```

* ①b 命中（哪怕 1 条）→ `INVARIANT_VIOLATION(RUBRIC_PIN_CONFLICT_WITH_SCORECARD)`，**一条写语句都不发**。
* 0 行（并发/被别的写路径抢动）→ `VERSION_CONFLICT(APPLICATION_RUBRIC_PIN_CONFLICT)`，整体回滚。
* 审计事件写不进去 → `INVARIANT_VIOLATION(PIN_AUDIT_EVENT_MISSING)`，整体回滚（不写"无审计的补钉"）。
* **`fn_row_guard` 实测**（`test/integration/scorecard-rubric-version-gate.test.ts`）：
  `application` 上挂着两个 `fn_row_guard`（`lifecycle_status` / `current_stage_code`）+
  `trg_application_cycle_guard` + `trg_application_no_delete` + `trg_application_trace`（只 INSERT）。
  补钉 UPDATE 只改 `rubric_version_id`，两个守卫都走"状态未变"分支：`record_version` **恰好 +1**、
  **不写** `event_inbox`（补钉审计是应用层自己写的）、不动 `status_changed_at`/`stage_changed_at`。

### 7.3 不倒退 / 不跳阶（`STAGE_AHEAD`）

| 调用前的指针 | 事实推导出的上限 | 结论 |
|---|---|---|
| S6（T1–T4 都成立） | S10 | 四跳推进（§8） |
| S6（只有 T1） | S7 | 一跳推进到 S7 |
| S7（T2 成立） | S8（或更远，若 T3/T4 也成立） | 按事实逐边推进 |
| S7（无决策） | S7 | `NO_OP`（等人） |
| S7（HOLD/REJECT） | S7 | `BLOCKED` |
| S8（面试还没发生、没有材料） | S8 | `NO_OP`（等面试） |
| S8（面试全被取消/未到场） | S8 | `BLOCKED(INTERVIEW_NOT_COMPLETED)` |
| S9（材料还没可用） | S9 | `NO_OP`（等材料） |
| S9（转写取不回来） | S9 | `BLOCKED(TRANSCRIPT_NOT_READY)` |
| **S10（v1.0 终态）** | S10 | `NO_OP`（**停在 S10 不再前进**；S10 的决策由 `decision` 行表达） |
| **S11 / S12** | 最多 S10 | **`NO_OP` + `STAGE_AHEAD` 警告，一条 UPDATE 都不发**（不做这两格） |
| S1–S5 | 不许插队 | `BLOCKED(STAGE_NOT_ON_LADDER)` |

"超前"的判定用 `stage_catalog.sort_order`（权威是表，不是写死的数字）。

### 7.4 幂等

| 场景 | 第一次 | 第二次 | 库上的证据 |
|---|---|---|---|
| T1（S6→S7），没有 SCREENING 决策 | `ADVANCED` | `NO_OP` | `record_version` 不再变、`stage_entered_at` 不再变、事件仍只有 1 条 |
| T2（S7→S8） | `ADVANCED` | `NO_OP` | 同上 |
| T3（S8→S9），还没有材料 | `ADVANCED` | `NO_OP` | 同上（第二次停在 S9 的 WAIT） |
| T4（S9→S10） | `ADVANCED` | `NO_OP` | 停在 S10 终态；版本/时间戳/事件都不再变 |

**为什么第二次不发 UPDATE**：阶段**没变**的 UPDATE 也会让 `fn_row_guard` 把 `record_version` +1、把
`updated_at` 改成 now()，却**不写任何事件** —— 那是"幂等重试看起来像改动"的典型污染。本命令用
"没剩下可走的边就不发语句"来消除它（A5 断言版本不变）。

### 7.5 多跳的原子性

一次调用可以走**最多四跳**（S6→S7→S8→S9→S10，例如"落后补推进"）；每条边一条 UPDATE，全部在**同一个事务**里，
任一跳失败（版本冲突 / 断言失败）→ 调用方 `withActor` 回滚 → **不会半推进**。
每条 UPDATE 的乐观并发条件是**上一条 RETURNING 的真实 `record_version`**（F1 补钉会让它先 +1）。

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
| 本命令的账号是谁 | `…0103`（`kind=HUMAN`，演示 HR 专员）。**但 T1 / T3 / T4 都是自动推进**：没有任何人"按过这个按钮" |
| T2 是谁的意思 | T2 的前置是**人**做的 SCREENING 决策（`decision.decided_by_actor_id` + 人工确认哈希）。库里的 `stage_changed_by_actor_id` 仍然只是**执行账号** |
| T3 / T4 是谁的意思 | 前置事实来自上游已被人类闸门约束的写入口：排期走 `ctx.approval`（D-79/D-101）、转写是 `MANUAL` 的产品入口；本命令只承认它们已经发生，**不新增也不绕过**闸门（§0 第 9 条） |
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
| `VERSION_CONFLICT` | `APPLICATION_RUBRIC_PIN_CONFLICT` | 补钉 UPDATE 0 行（并发抢动） | 否（整体回滚） |
| `INVARIANT_VIOLATION` | `RUBRIC_PIN_CONFLICT_WITH_SCORECARD` | **SC-11**：该申请已有现行面评绑在待钉版本以外的 rubric 版本上 → 拒绝补钉（`detail` 带两边版本、冲突面评数与 `owner_role`/`next_action_code`） | 否（零写入） |
| `INVARIANT_VIOLATION` | `PIN_AUDIT_EVENT_MISSING` | 补钉审计事件写不进去 | 否（整体回滚） |
| `INVALID_ARGS` | `ACTOR_REQUIRED` | 补钉写库前发现没有 `recruitment.actor_id`（拒绝匿名审计） | 否 |
| `INVARIANT_VIOLATION` | `STAGE_ENTERED_AT_NOT_ADVANCED` / `STAGE_ENTERED_AT_NOT_MONOTONIC` / `STAGE_CODE_MISMATCH` / `STAGE_CATALOG_INCOMPLETE` | 写后断言失败（本仓缺陷回归的兜底） | 否（整体回滚） |
| `INVALID_ARGS` | `UNKNOWN_PARAM` / `TENANT_OR_ACTOR_NOT_ALLOWED` / `MISSING_REQUIRED` / `ID_NOT_UUID` … | 入参校验（连库前） | 否 |
| `NOT_CONFIGURED` | — | `database` 段不完整（工具仍注册） | 否 |

> `INVARIANT_VIOLATION` 是**不该发生**的码：它出现就说明库的护栏被绕过或本仓缺陷回归，
> 宁可整笔回滚也不静默放过。

---

## 11. 验收矩阵（A1–A9 在 `test/integration/stage-advance.test.ts`；A10/A11 见各自文件；A12–A16 在 `test/integration/stage-advance-s8-s10.test.ts`）

| # | 验收 | 断言要点 |
|---|---|---|
| A1 | T1 正例（材料 + rubric 齐） | `ADVANCED`、S7、`transitions=[{S6,S7}]`、`record_version` +1、`stage_entered_at > created_at` 且前进、恰好 1 条 `application.current_stage_code.changed`（`provider=internal`、`actor=执行账号`、`stage_source_event_id` 回填） |
| A2 | T1 缺 rubric（岗位**没有已批准的 current**） | `BLOCKED['RUBRIC_NOT_PINNED']`、阶段不变、`record_version` 不变、事件 0 条、**无补钉事件**；**`owner_actor_id` = 库里的招聘负责人（…0102）**、`owner_role=JOB_HIRING_MANAGER`、`next_action_code=PIN_RUBRIC_VERSION` |
| A2b | T1 材料 `FAILED` | `BLOCKED['MATERIAL_PARSE_FAILED']`、零 UPDATE |
| A3 | T2 正例 | `ADVANCED`、S8、恰好 1 条 S7→S8 事件 |
| A4 | T2 负例（HOLD / REJECT） | `BLOCKED`、阶段留在 S7、零 UPDATE、0 事件；`owner_role=SCREENING_DECIDER`、`owner_actor_id` = `decision.decided_by_actor_id` |
| A5 | 幂等（连调两次） | 第二次 `NO_OP`、`record_version` 不变、`stage_entered_at` 不变、事件仍 1 条 |
| A6 | 并发（两连接） | 一侧 `ADVANCED`、另一侧 `VERSION_CONFLICT`、**恰好 1 条**阶段事件、第三次调用 `NO_OP` |
| A7 | 落后补推进（多跳） | 一次调用两跳（T1/T2）、`record_version` +2、一条边一条事件、`stage_entered_at` 严格单调 |
| A8 | 不倒退（S11，超过 S10 终态；S11/S12 不做） | `NO_OP` + `STAGE_AHEAD`、零 UPDATE；**告警带 `owner_actor_id` / `owner_role` / `next_action_code`** |
| A9 | **§11.6-8 只读阻塞视图**（真库） | RUBRIC 场景：`stage/stage_name/status/blocked/blockers/owner/next_action` 齐；**只发读语句**（逐条 SQL 检查 + 逐表零写）；`withReadOnly`（库层只读）里可跑；STAGE_AHEAD 场景：`kind=WARNING`、`blocked=false`、仍有 owner+next_action |
| A10 | **F1 补钉**（`test/integration/f1-rubric-pin.test.ts`） | 申请先建（无 rubric）→ 岗位批准 → 本命令：`ADVANCED`、S7、`application.rubric_version_id` = `job.current_rubric_version_id`、`record_version` +2（补钉+迁移）、恰好 1 条 `application.rubric_version.pinned`（`source_object_id`=申请、`actor_id`=执行账号、`from=null`）；第二次 `NO_OP` 且事件不重复；只读视图在同一情形下零写入 |
| A11 | **SC-11 补钉冲突**（`test/integration/scorecard-rubric-version-gate.test.ts`） | 完整真工具路径：intake（不钉）→ 排期 → 面评显式 V1 → 批准 V2 → `stage_advance` 抛 `INVARIANT_VIOLATION(RUBRIC_PIN_CONFLICT_WITH_SCORECARD)`，`detail` 带 V1/V2 + 冲突面评数；**零写入**（申请/阶段/`record_version` 不变、补钉事件 0、阶段事件 0）；只读视图在同一情形报 `BLOCKED(RUBRIC_PIN_CONFLICT_WITH_SCORECARD)` + `owner_role` + `next_action_code`；强行绕过补钉后 `evaluation_summarize` 报 `SCORECARD_RUBRIC_MISMATCH` 且 `decision_record` 拒绝（同一 reason_code） |
| **A12** | **T3 正例（材料就绪）+ T4 正例（材料 + SUBMITTED）** | 申请 S8 + 会议绑定 + canonical READY 转写 → `ADVANCED`、S9、1 条 S8→S9 事件、`record_version` +1；再调（有材料但 0 份 SUBMITTED）→ `BLOCKED['SCORECARD_REQUIRED']`、零 UPDATE、零事件、阶段留 S9；插 1 份 `SUBMITTED` scorecard 后再调 → `ADVANCED`、**读回 `application.current_stage_code='S10'`**、`record_version` +2、S9→S10 事件 1 条；S10 终态再调 → `NO_OP`（零写入、`warnings=[]`） |
| **A13** | **S8→S9→S10 一次两跳（Golden Path 终态形状）** | S8 + 面试 `POST_INTERVIEW` + canonical READY 转写 + ≥1 份 `SUBMITTED` scorecard + `interview_record(NEEDS_REVIEW/UNVERIFIED)` + `decision(STAGE,S10,ADVANCE)` → 一次调用 `transitions=[{S8,S9},{S9,S10}]`、`record_version` +2、终态读回 **S10**、两条边各 1 条事件；`decision` 行不被本命令改动 |
| **A14** | **T3 负例** | 所有面试 `CANCELLED`/`NO_SHOW` → `BLOCKED['INTERVIEW_NOT_COMPLETED']`、阶段留 S8、`record_version`/`stage_source_event_id`/事件数都不变；`owner_role=JOB_HIRING_MANAGER`、`next_action_code=RESCHEDULE_INTERVIEW`、`owner_actor_id`=库里的招聘负责人 |
| **A15** | **T4 负例** | 转写 `AUTH_REQUIRED` → `BLOCKED['TRANSCRIPT_NOT_READY']`、阶段留 S9、零写入；`owner_role=RECRUITMENT_OWNER`、`next_action_code=REIMPORT_TRANSCRIPT` |
| **A16** | **只读视图（真库）三条路径 + 只发读语句** | S8 没面试 → `next_action.code=SCHEDULE_INTERVIEW`；S9 等材料 → `IMPORT_TRANSCRIPT`；S10 终态 → `CONTINUE_DOWNSTREAM`；三条路径的 SQL 逐条检查全是 `select`（无写动词、无 `for update`） |
| **A17** | **T4 负例（G3 核心）** | S9 + canonical READY 转写 + **0 份** `SUBMITTED` → `BLOCKED['SCORECARD_REQUIRED']`、阶段留 S9、`record_version` 不变、阶段事件 0；**逐表行数不变**（application / event_inbox / scorecard / interview / transcript_artifact / decision / business_task）；`owner_role=JOB_HIRING_MANAGER`、`next_action_code=SUBMIT_SCORECARD`；且挂在**其它申请**面试上的 SUBMITTED 不算（阴性对照） |
| **A18** | **T3 负例（G3 核心：`interview.status` 不再承载「面试发生」）** | S8 + 面试 `IN_PROGRESS` / `POST_INTERVIEW` + 会议绑定但**没有**转写 → **不推进**（`NO_OP` / `WAIT`），阶段留 S8、零 UPDATE；证明 `interview.status` 只作排期状态 |
| **A19** | **干净库 S6→S10 + 0016 视图 0 违规** | 一次性库重放 0001→0016 → 从 S6 驱动到 S10（含 canonical READY + `SUBMITTED`）→ 读回 `current_stage_code='S10'` 且 `count(SUBMITTED)>=1`；落地视图 `recruitment.v_application_stage_consistency`（HEAD `9145e25`）`count(*)=0`；反例（直接 SQL 指到 S10、无面评）视图能报 `S10_WITHOUT_SUBMITTED_SCORECARD`（证明视图非恒 0） |

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
| `contracts/interview/scheduling-rules.md` §7.5 / §8 | `interview.status` 的**排期状态**口径（T3 只把它当排期信息用）；没有 meeting 就没有 `transcript_artifact`（材料事实的因果链） |
| `contracts/interview/scheduling-rules.md` §8 与 `docs/17` D-111 | **冲突项**：D-111 #1「面试已执行必须是产品记录的事实」与本文件 1.3（T3=材料就绪，G3=B）不一致，按本轮复核指令执行 B；D-111 #1 的 START/COMPLETE 写入口降级为可选 |
| `contracts/interview/transcript-rules.md` §3 / §8（TR-C）/ §4 派生表 | T4 的事实口径：`READY` = 完整原文已获取；`canonical READY` 才让 `transcript.state='READY'`（材料可用） |
| `contracts/STAGE-CODES.md` | 阶段码口径；S6–S10 的语义由 `stage_catalog` 决定，本文件不另立编号；**不发明第 13 个码** |
| `db/STAGE-CATALOG.md §3`（`in_v1_scope`） | §2.5 终态裁决的依据：v1.0 **不做** S11/S12（`in_v1_scope=false`），只做 S3/S6/S7/S8/S9/S10 |
| `docs/23` N8 / P1-09、`docs/18` §3 | 本文件闭合"阶段推进无入口"这一缺口；**1.2 起覆盖到 S10**（S6→S7→S8→S9→S10），不再停在 S8 |
| `contracts/tenant-provenance.md` | §12 的 `provenance` 判定式（同一份实现） |
| `src/http/overview.ts`（工作台面板） | §6.3：只读视图函数已就绪；pending 行换成 `{stage, stage_name, blocked, blockers, owner, next_action}` 只需一行接线 |

**边界（本轮明确不做）**：S11（Offer 与入职交接）/ S12（人才沉淀与复盘）的推进**不在**本命令里
（`in_v1_scope=false`，没有合法阶段码可用，也不许发明）。S10 是 v1.0 终态：S10 的决策由
`decision` 行表达，不改阶段指针（§2.5）。

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
| **8** | **S8→S9 的「面试已执行」没有产品写入口** | **已裁决（G3=B，2026-11-15）**：T3 改为「材料就绪（canonical READY 转写）」，`interview.status` 只作排期状态；本文件 1.3 不再以「面试已执行」为判据，缺口消解。D-111 #1 的 START/COMPLETE 写入口**可选**（补也只是把排期状态写得更细，不改变 T3 判据）。 |
| **9** | **S9→S10 是否要求 `interview_record` 就绪** | `interview_record` 在 Golden Path 里是 `NEEDS_REVIEW/UNVERIFIED`（D-B：v1.0 没有把它转 `VERIFIED` 的产品入口）。本实现**不**把 record 当闸门，只要求"canonical READY 转写（材料可用）"。 | **待产品裁决**：若要求 record `READY`+`VERIFIED` 才能进 S10，必须先补"人工复核/校验"入口；否则阶段永远到不了 S10（与 D-A 同类的范围缺口）。 |
| **10** | **无转写（`NO_TRANSCRIPT`）能否进 S10** | **已裁决（G3=B）**：S8→S9 要求 canonical READY，因此无转写在梯子上到不了 S9/S10。与 D-111 #3「允许 NO_TRANSCRIPT 进 S10」冲突；本轮按 B（时间在后的复核指令 + 执行计划 06 §2 明确），D-111 #3 对**阶段推进**的表述需由总控在 `docs/17` 回抄时限定为「影响 decision 的缺口披露，不改变阶段梯子」。 |
| **11** | 多跳最多 **4 条**事件（一条边一条） | 事件由 `fn_row_guard` 自动写，无法合并 | 保留（每条边的 `from/to` 都是审计真相）；A12/A13 已断言"一条边一条事件、不多不少" |

---

## 15. 工具注册（本 lane 未改 `src/index.ts`；当前工作树已由总控 lane 落地）

> **现状（2026-11-14）**：工作树的 `src/index.ts` 已有 `stageAdvance` 的 import / 工厂 / tools 数组三处注册
> （与 `docs/18 §4`「插件 25 个工具」口径一致）；以 committed HEAD 为准与否由总控复核。
> 下面的片段仍作为"接入点说明"保留。路径里的行号会随 lane 变化，按**符号名**找，不要按行号。

```ts
// ① src/index.ts（import 区）
import { createStageAdvanceTool, unconfiguredStageAdvanceTool } from './tools/stage-advance.ts'

// ② src/index.ts（const decisionRecord = ... 块之后）
  // ── 阶段推进（N8 / 方案 D）：只要 database。派生式推进，只承认已发生的事实
  //    （S6→S7→S8→S9→S10；S10 = v1.0 终态）。
  const stageAdvance = database.resolved === null
    ? unconfiguredStageAdvanceTool(database.issues)
    : createStageAdvanceTool(database.resolved)

// ③ src/index.ts（tools 数组里 decisionRecord 的下一行）
    stageAdvance,
```
