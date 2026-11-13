# 会议材料获取规则（S9 · transcript & materials）

**日期**：2026-11-13
**范围**：S9「面试执行与材料获取」——会议结束后，**材料（转写产物）从哪来、怎么和那一场面试对上、取不到时系统说什么**。
**不管**：面试怎么排（见 `scheduling-rules.md`）、面评写什么、结构化记录怎么生成（S10 / `docs/04 §15 D`）。
**性质**：合同。不含实现代码、不含 DDL。所有「必须 / 不得」都是可判定的断言。
**上位口径**：与本文冲突时依次以 `docs/04-connectors-and-transcript.md`（§9–§21 转写链路）、`db/SCHEMA.md` §8/§9/§10、`docs/17-decision-ledger.md`（D-17 / D-33 / D-46）为准。

> **阶段编号提醒（R5）**：本文的 **S9 = 面试执行与材料获取**，与 `stage_catalog`（`0002_seed.sql:241`）**逐字一致**（`D-22` 定生命周期编号为唯一口径，见 `contracts/STAGE-CODES.md`）。落库写 `interview_record` 关联阶段时以 `stage_catalog` 为准，**不得**把章节号当 stage code。

---

## 0. 一句话

> **一场会议只能绑一场面试，绑的依据只能是平台给出的 ID；平台没有转写就说"没有"，一个字也不许猜。**
> 系统的能力上限不是"能不能拿到转写"，而是**在拿不到的时候能不能说清楚为什么、还差什么、谁来补**。任何"看起来像同一场会议"的推断，都不得写进业务关系（`docs/04 §12` 逐字：**「禁止只凭会议标题、候选人姓名或模糊时间自动绑定。模糊匹配最多提供候选项，不能直接写入业务关系。」**）。

四条贯穿全篇的裁决：

| # | 裁决 | 一句话理由 |
|---|---|---|
| **P-1** | **绑定的唯一依据是平台 ID 组合**（provider + tenant/account scope + external_meeting_id，辅以 calendar_event_id） | 不变量 5（`SCHEMA §8`）；`meeting` 表**结构上不存标题**（`0001 L1006`），所以"按标题猜"连字段都没有 |
| **P-2** | **一行 `transcript_artifact` = 一次完整的平台回读快照**（插进去就带全内容 + 终态） | 原文列在不可变白名单之外（`0001 L1777`），所以"先插空行、再补内容"在库层**物理不可能**（§8.3） |
| **P-3** | **"等待中"写在任务上，不写在产物上** | 你没有内容就没有产物；产物行的存在本身必须意味着"我取到过东西" |
| **P-4** | **没有转写不妨碍评价**，但评价必须自报"无转写依据"，且这个标记永远不再改 | `docs/04 §10②`（评价与转写并行）；面评提交后冻结（`fn_scorecard_guard`） |

---

## 1. 术语（后文只用这几个词）

| 词 | 定义 | 不是 |
|---|---|---|
| **会议（meeting）** | `meeting` 表一行：`(provider, account_scope, external_meeting_id \| calendar_event_id, 实际起止)` | 日历上的那个"日程"。一条日程可能对应多个实际会议（`docs/04 §12`） |
| **绑定（binding）** | `meeting_binding` 一行且 `unbound_at is null`，把 1 个 meeting 指到 1 个 interview | 有 meeting 行 |
| **产物（artifact）** | `transcript_artifact` 一行：某平台某一次生成的转写文件 | 片段（segment）。1 产物 : N 片段 |
| **版本（revision）** | `transcript_artifact.source_revision`，**我们**的版本号，同一平台产物每次内容不同就 +1 | 平台的事件 id、妙记 token |
| **变体（variant）** | `variant_type ∈ {ORIGINAL, TRANSLATION, OPTIMIZED, DERIVATIVE}`：同一场会议的不同形态产物 | 不同会议 |
| **canonical** | 该 meeting 下被选为"本轮唯一"的那一版（`uq_transcript_artifact_canonical` 每 meeting 至多一个） | "最新那一版" |
| **READY** | `transcript_status='READY'` 且 `is_complete=true`（`ck_transcript_artifact_ready`） | "拿到了点东西" |

---

## 2. 材料从哪来 · TR-S

`docs/04 §21` 逐字：**「Recruitment OS 直接处理的是平台已经生成的正式 Transcript Artifact，不是重建会议平台或 ASR。」** 所以来源只有三类，且每类都必须三维标注（`R4`：`provenance` / `trigger` / `connection` 正交，禁止压成一维）。

| # | 来源 | 触发 | 怎么拿 | `provenance` | `trigger_mode` | `connection_state` |
|---|---|---|---|---|---|---|
| **TR-S1** | **平台自动推送**（飞书 `minutes.minute.generated_v1`） | `EVENT` | 事件给 `minute_token` + `minute_source.source_entity_id`(Meeting ID) + `event_id`；再调 `minutes +detail --transcript` 取全文 | `LIVE` | `EVENT` | `CONNECTED` |
| **TR-S2** | **平台手动回读**（HR 在工具里点"取一次"） | `MANUAL` | 同上 API；或 `vc +recording` 先拿 `minute_token` 再取全文 | `LIVE` | `MANUAL` | `CONNECTED` |
| **TR-S3** | **人工上传平台导出的转写文件** | `MANUAL` | 人把妙记/腾讯会议导出的 `.txt/.docx` 传上来 | `LIVE` | `MANUAL` | `NOT_CONNECTED` |

### 2.1 三条判定（避免把三种事混成一种）

| # | 规则 | 判定式 | 依据 |
|---|---|---|---|
| **TR-S4** | `provenance='LIVE'` **当且仅当**该产物的字节来自平台 | 来源是 TR-S1/S2（接口回读）**或** TR-S3 且人能证明是"平台导出文件"（`read_receipt_ref` 记录 `upload:<actor_id>:sha256:<hex>` + 文件名） | `R4`；`0001 L1108-1110`（`LIVE` 必须有 `read_receipt_ref` + `fetched_at`） |
| **TR-S5** | **人工手打的会议纪要不得写成 `transcript_artifact`** | 无平台出处 → 拒绝。它可以作为 `ai_summary` 的输入或笔记，但不进"原文"链路 | `docs/04 §16`「原文不可被摘要/记录/人工修订覆盖」；把纪要当原文会让"原文"这个词失去意义 |
| **TR-S6** | `connection_state='NOT_CONNECTED'` 时**不得**谎称 `EVENT` | TR-S3 一律 `trigger_mode='MANUAL'` + `NOT_CONNECTED` | `R4`「`MANUAL` 冒充自动摄取」「`READY` 冒充已读取」都是红线 |
| **TR-S7** | **不把某一次 webhook 的 payload 当逐字稿** | `event_inbox.payload` 只是**触发信号**；正文必须来自回读 API 的结果 | `docs/04 §13` 统一原则逐字 |
| **TR-S8** | 音视频**不下载、不自建媒体仓库** | 只存 `provider_artifact_id` + 访问引用 | `docs/04 §16` |

### 2.2 飞书链路的两个必须记住的错误码（`docs/04 §13`）

| 平台返回 | 含义 | 系统动作 |
|---|---|---|
| `2091003` | 产物仍在生成 | **不建 artifact 行**；`business_task.status='WAITING_EXTERNAL'`，等新事件或人工重试（P-3） |
| `2091005` | 无读取权限 | `business_task.status='WAITING_HUMAN'` + `error_code='AUTH_REQUIRED'`；**不重试到死**，要给重授权入口 |

> 另注（`docs/04 §13`）：`vc.recording.recording_transcript_generated_v1` 是**转写片段事件**，不带完整 Meeting 关联，**不得作为批量归档的唯一依据**；`minutes.minute.generated_v1` 当前标注为 **user identity**，不能默认 Bot 也能订阅。

---

## 3. 绑定只靠平台 ID，不靠标题 · TR-L

### 3.1 六个定位维度（缺一不可，且不许压成一个字段）

`docs/04 §12` 要求按 6 维命名：`Provider` / `Tenant·Account Scope` / `Calendar Event ID` / `External Meeting ID` / `Recording Artifact ID` / `Actual Start-End`。

落库映射（`0001 L992-1014`、`L1047-1114`）：

| 维度 | 列 | 备注 |
|---|---|---|
| Provider | `meeting.provider` | 必填 |
| Tenant·Account Scope | `meeting.tenant_id` + `meeting.account_scope` | `account_scope` 可空；空 = 租户默认账号 |
| Calendar Event ID | `meeting.calendar_event_id` | 可空；与下一列至少一个（`ck_meeting_identity`） |
| External Meeting ID | `meeting.external_meeting_id` | 可空；`(tenant, provider, external_meeting_id)` 唯一（`uq_meeting_external`） |
| Recording Artifact ID | `transcript_artifact.provider_artifact_id` | 1 meeting : N artifact |
| Actual Start-End | `meeting.actual_start_at/end_at` | 只用于排序与人工核对，**不用于自动匹配** |

### 3.2 定位算法（给输入必得唯一结论）

```
resolve(provider p, tenant t, external_meeting_id mid, calendar_event_id cid)

L1  若 mid 非空：
      M = { m ∈ meeting : m.tenant_id=t ∧ m.provider=p ∧ m.external_meeting_id=mid }
      |M| = 1 → 定位于该 meeting
      |M| = 0 → 转 L2
      |M| > 1 → 不可能（uq_meeting_external），出现即 500 INTEGRITY_BROKEN

L2  若 cid 非空：
      E = { m ∈ meeting : m.tenant_id=t ∧ m.provider=p ∧ m.calendar_event_id=cid }
      |E| = 0 → UNRESOLVED(no_meeting)
      |E| ≥ 1 → **读取该日程下全部实际会议实例**，逐个跑 L1；不得只取第一个
                恰 1 个实例可定位 → 定位于该实例
                否则 → UNRESOLVED(ambiguous_calendar)

L3  定位于 meeting m 后：
      B = { b ∈ meeting_binding : b.meeting_id=m.id ∧ b.unbound_at is null }
      |B| = 1 → 定位于该 interview
      |B| = 0 → 落到 binding 绑定分支（binding_method='EVENT_MATCH'，按 §3.3）
      |B| > 1 → 不可能（uq_meeting_binding_active），出现即 500 INTEGRITY_BROKEN
```

| # | 规则 | 判定 | 依据 |
|---|---|---|---|
| **TR-L1** | 只有 `provider + tenant + external_meeting_id`（或 `calendar_event_id` + 逐个实例）能定位置信 | 见 L1–L3 | `docs/04 §12` 解析顺序逐字 |
| **TR-L2** | 定不到唯一 → `NEEDS_LINKING`，**不调用 LLM 猜测** | `transcript_artifact.transcript_status='NEEDS_LINKING'` 或 `business_task(WAITING_HUMAN, task_type='LINK_MEETING')` | `docs/04 §12`、`§15 B` |
| **TR-L3** | 禁止用**标题、候选人姓名、时间接近、时长相近、参会人集合**作为唯一依据 | 这些最多产出 `candidates[]`（供人挑），**不得**写 `meeting_binding` | `docs/04 §12` 逐字；`APP-04` |
| **TR-L4** | `binding_method='EVENT_MATCH'` 时必须留下"匹配键" | 匹配用的 `(provider, external_meeting_id, tenant)` 写进 `event_inbox.payload`（provider=`internal`，`event_type='meeting.bound'`），并在该事件里记 `event_id` 原值 | `meeting_binding` 无"依据"列 → §13 G-3 |
| **TR-L5** | `binding_method='MANUAL'` 必须有人 | `bound_by_actor_id` 非空（`ck_meeting_binding_manual_actor`，`L1038`） | 库强制 |
| **TR-L6** | 绑定可解，解绑必须写理由 | `unbound_at` + `unbound_reason` 非空（`ck_meeting_binding_unbound`，`L1039`）；解绑后行保留（禁删，`L1726`） | 历史可追溯 |

### 3.3 事件到达时的绑定分支（"来了一条转写事件，但这场会议还没绑"）

```
绑定分支（B = ∅ 时）：
  B1  事件里的 meeting 能唯一确定，且该 meeting 的 calendar_event_id 对应**唯一**一个 interview 的
      meeting_binding 历史（含已解绑）→ 不允许直接绑；进 NEEDS_LINKING（人工确认）
  B2  该 meeting 是**本次排期时创建**的（可由 meeting.created_at 与 event 的 calendar_event_id 对上）
      → 允许自动补绑，binding_method='EVENT_MATCH'（唯一可自动的形态：排期时已写 calendar_event_id）
  其余 → NEEDS_LINKING
```

> **B2 是唯一允许自动写 binding 的形态**：因为排期时我们已经用 `calendar_event_id` 把它和某场面试**提前**绑上了（`docs/04 §10①`），此时 `EVENT_MATCH` 只是在补全同一个关系，不是新推断。

---

## 4. 转写状态派生 · TR-D（`transcript.state` 的唯一算法）

供 `recruitment_interview_get` 直接回显。**先算集合，再按优先级取第一个命中**，顺序本身是规则的一部分。

```
ACTIVE_BIND(i) = { b ∈ meeting_binding : b.interview_id=i.id ∧ b.unbound_at is null }
M(i)           = { b.meeting : b ∈ ACTIVE_BIND(i) ∧ b.meeting.meeting_role ∈ {'PRIMARY','CONTINUATION'} }
ART(i)         = { a ∈ transcript_artifact : a.meeting_id ∈ M(i) }
CANON(i)       = { a ∈ ART(i) : a.is_canonical }
WAIT           = 120 分钟（会议实际结束后的等待窗；可被 business_config(config_key='transcript_policy').wait_minutes 覆盖）
```

| 序 | 条件 | `transcript.state` | `reason_code` |
|---|---|---|---|
| 1 | `M(i) = ∅` ∧ `as_of > i.scheduled_start_at` | `MISSING` | `NO_MEETING_BOUND` |
| 2 | `M(i) ≠ ∅` ∧ `CANON(i) ≠ ∅` | `map(CANON.status)`：`READY`→`READY`、`PARTIAL`→`PARTIAL`、`AUTH_REQUIRED`→`AUTH_REQUIRED`、`NEEDS_LINKING`→`NEEDS_LINKING`、`RETRYABLE_FAILED`→`RETRYABLE_FAILED`、其它→`PENDING` | `CANONICAL_STATUS` |
| 3 | `CANON(i) = ∅` ∧ `∃a∈ART: a.status='READY' ∧ a.is_complete` | `READY` + 警告 `CANONICAL_MISSING` | `READY_NO_CANONICAL` |
| 4 | `CANON(i) = ∅` ∧ `∃a∈ART: a.status='PARTIAL'` | `PARTIAL` | `ONLY_PARTIAL` |
| 5 | `CANON(i) = ∅` ∧ `∃a∈ART: a.status='AUTH_REQUIRED'` | `AUTH_REQUIRED` | `ONLY_AUTH_REQUIRED` |
| 6 | `ART(i) = ∅` ∧ `as_of > max(actual_end_at, scheduled_end_at) + WAIT` | `MISSING` | `NO_ARTIFACT_AFTER_WAIT` |
| 7 | 其余（会议还没结束 / 还在等） | `PENDING` | `WAITING` |

| # | 规则 | 依据 |
|---|---|---|
| **TR-D1** | `state` 是**派生的**，不单独存列；任何缓存都必须在 `as_of` 上重算 | 多真相源会漂移（R5） |
| **TR-D2** | `READY` **只代表完整原文已获取**，不代表结构化记录完成（后者是 `interview_record.status='READY'`） | `docs/04 §18` 逐字 |
| **TR-D3** | `MISSING` 是**终态判定**，必须给 `reason_code`；不得把 `MISSING` 和 `PENDING` 混成一个"还没好" | `D-20` 同构：推不出 ≠ 没有；但这两种的**下游动作不同**（一个要人工补，一个只需等） |
| **TR-D4** | `meeting_role ∈ {REPLACED, CANCELLED}` 的会议**不进** `M(i)` | `docs/04 §20 A`：改期后的旧会议不纳入本轮记录 |

---

## 5. 读不到时怎么办 · TR-F

`docs/04 §19` 给了异常恢复的十一行；本节把"读不到"分成**五条互斥出口**，每条都有明确的下一步和可见状态。

| # | 情形 | 判定 | 落什么 | 谁下一步 |
|---|---|---|---|---|
| **TR-F1** | 产物仍在生成 | 平台 `2091003` / 事件早于产物就绪 | **不建 artifact**；`business_task(WAITING_EXTERNAL, task_type='FETCH_TRANSCRIPT', error_code=null, next_run_at=now()+10min)` | 系统按退避重试 |
| **TR-F2** | 无读取权限 | `2091005` / OAuth 过期 / 应用类型不支持 | `business_task(WAITING_HUMAN, error_code='AUTH_REQUIRED')`；**保留原任务**，重授权后从原 attempt 继续（`docs/04 §19`） | 人重授权 |
| **TR-F3** | 平台**根本没有**转写产物（没开录制 / 套餐不支持） | 会议已结束 + `ART=∅` + 超过 `WAIT` | `business_task(WAITING_HUMAN, task_type='SUPPLY_TRANSCRIPT')`，`idempotency_key='supply_transcript:'||meeting_id`；`transcript.state='MISSING'`，`reason_code='NO_ARTIFACT_AFTER_WAIT'` | 人上传（TR-S3）或确认放弃 |
| **TR-F4** | 有产物但**内容不可读**（图片/加密/编码错/纯噪声） | 回读成功但 `raw_text` 提不出可用文本 | **不得**标 `READY`（`ck_ready` 要求 `is_complete` + `content_sha256`，但"内容可读"不在 CHECK 里，只能靠应用层）；`transcript.state='PARTIAL'`（`reason_code='ONLY_PARTIAL'`）+ `business_task(error_code='NEEDS_VISUAL', task_type='SUPPLY_TRANSCRIPT')` | 人看图 / 重导 |
| **TR-F5** | 事件到了但**定不到唯一面试** | §3.2 返回 `UNRESOLVED` | `business_task(WAITING_HUMAN, task_type='LINK_MEETING', error_code='NEEDS_LINKING')`；**不建** artifact（没有 interview 可归） | 人绑定 |

> **两个 `reason_code` 命名空间，不许混用**（混了就会出现"这个码查不到定义"）：
> | 命名空间 | 取值来源 | 封闭集 |
> |---|---|---|
> | `transcript.reason_code`（**派生状态**，`get` 回显、`NO_TRANSCRIPT` 透传） | `TR-D` 序 1–7 | `NO_MEETING_BOUND` / `CANONICAL_STATUS` / `READY_NO_CANONICAL` / `ONLY_PARTIAL` / `ONLY_AUTH_REQUIRED` / `NO_ARTIFACT_AFTER_WAIT` / `WAITING` / `ARTIFACT_EMPTY`（2026-11-14 增补，见下） |
> | `business_task.error_code`（**运维任务**，`ck_business_task_failed` 只在 `FAILED` 时要求非空） | `TR-F` | `AUTH_REQUIRED` / `NEEDS_VISUAL` / `NEEDS_LINKING` / `EXTERNAL_TIMEOUT` |
>
> 例：`NEEDS_VISUAL` **只能**出现在 `business_task.error_code`，不能出现在 `transcript.reason_code` 里（后者由 `TR-D` 七条唯一决定）。

### 5.1 关于 `needs_visual`（口径差异必须写清）

`needs_visual` 是**简历解析**（`doc11 §1`）的概念："文件能读但结构/文字需要人眼确认"。**转写链路没有这个列**，也不要给它新造一个：

| 想表达 | 正确写法 | 不要写成 |
|---|---|---|
| "产物是图片/无法提取文本" | `transcript_state='PARTIAL'`（`reason_code='ONLY_PARTIAL'`）+ `business_task.error_code='NEEDS_VISUAL'` | `transcript_status='NEEDS_VISUAL'`（不在 `ck_transcript_artifact_status` 枚举里，`L1092-1093`）；也不要写进 `transcript.reason_code` |
| "还在生成" | `business_task(WAITING_EXTERNAL)` | 一条 `DISCOVERED` 的 artifact 占位行（P-2/P-3） |
| "要人补" | `business_task(WAITING_HUMAN)` | `interview_record.status='NEEDS_REVIEW'`（那是记录的问题，不是材料的问题） |

> **为什么不加枚举值**：`transcript_status` 的 8 个值已经把"平台的客观状态"说完（`DISCOVERED/FETCHING/PARTIAL/READY/WAITING_EXTERNAL/RETRYABLE_FAILED/AUTH_REQUIRED/NEEDS_LINKING`）。`NEEDS_VISUAL` 是**我们的业务判断**，塞进平台状态轴会让"平台说什么"和"我们怎么想"混成一根轴（`docs/04 §18`「六条状态轴不得压平」的同构）。

### 5.2 "标记待补"的硬要求

| # | 规则 |
|---|---|
| TR-F6 | 任何"待补"必须是**一条可查询的任务**（`business_task`），不能只是日志或前端提示 |
| TR-F7 | 同一对象同一原因只允许一条待办：`idempotency_key` 固定（`supply_transcript:<meeting_id>` / `link_meeting:<provider>:<external_meeting_id>`），重复触发只是 touch，不新建 |
| TR-F8 | "待补"必须进**个人工作台**（`D-33` §3），且 `due_at` 不得晚于该场次 `scheduled_start_at + 24h`（否则没人会补） |
| TR-F9 | 人**明确放弃**补材料时，必须留下 `business_task(status='CANCELLED')` + `description` 里的理由；**不得**通过删任务/删 artifact 让它"看起来没有过" |

---

## 6. 关联约束：一场会议只能绑一场面试 · TR-B

### 6.1 正向：1 meeting → ≤ 1 interview（库强制）

`uq_meeting_binding_active on meeting_binding (meeting_id) where unbound_at is null`（`0001 L1044-1045`）。
绑第二个 → `23505`。服务层**必须**把它翻译成 `MEETING_ALREADY_BOUND`（不是 500）。负向测试见 `SCHEMA §12 N28`。

### 6.2 反向：1 interview → N meeting（允许，且必须区分角色）

`docs/04 §11` 逐字：**「1 Interview : N Meeting（改期、重新发起会议、断线后重新开会）」**。所以**不**对 interview 侧加唯一约束。

| `meeting_role` | 含义 | 是否进 `M(i)` | 转写怎么处理 |
|---|---|---|---|
| `PRIMARY` | 本轮正式会议 | ✅ | 正常取，可作 canonical |
| `CONTINUATION` | 断线续接 | ✅ | 与 PRIMARY 同一 Transcript Set；**只有平台元数据明确表示同一连续录制且时间不冲突时才拼**（`docs/04 §20 B`） |
| `REPLACED` | 改期后的旧会议 | ❌ | 保留产物，**不入本轮记录**（`docs/04 §20 A`） |
| `CANCELLED` | 取消的会议 | ❌ | 同上 |

| # | 规则 | 判定 |
|---|---|---|
| **TR-B1** | 同一 interview 下 `PRIMARY` 至多 1 条 | `count(meeting where role='PRIMARY' ∧ 该 interview 的 active binding) ≤ 1`。**写侧**：新增会议时若已存在 `PRIMARY`，把本次 `meeting_role` 强制降为 `CONTINUATION`（`schedule` 回 `MEETING_ROLE_DOWNGRADED` 警告，不报错）。**读侧**：出现 2 条 = 历史脏数据 → `INTEGRITY_BROKEN` 并告警 |
| **TR-B2** | `CONTINUATION` 只有**明确关联**才纳入 | 必须有人在 `event_inbox` 里写下 `continuation_of=<primary meeting_id>`；`docs/04 §20 A` 逐字：**「断线续接也不能只靠时间接近自动认定」** |
| **TR-B3** | canonical 粒度 = **每 meeting 一个** | `uq_transcript_artifact_canonical`（`L1116-1117`）；跨 meeting 选一个 canonical 需要 `transcript_set` 实体 → 留 `0002`（`D-17`/`SCHEMA M-6`） |
| **TR-B4** | 同一 meeting 下多个 artifact 只能是"不同版本/不同变体"，不能是"同一连续的多个文件"（除非平台元数据说明） | 见 `docs/04 §20 B`；判断不了就**保留多个**，进人工选择，**不得静默拼接** |

---

## 7. 去重 · TR-U（六层，缺一层就会重复入库）

| 层 | 去重键 | 落点 | 重复时动作 |
|---|---|---|---|
| **U1 事件层** | `(tenant_id, idempotency_key)`，key 优先 `provider:provider_event_id` | `uq_event_inbox_idempotency`（`0001 L306`） | 23505 → **不重复建任务**，直接 ACK |
| **U2 备用键合法性** | 拿不到 `provider_event_id` 才能用 `FALLBACK_KEY`，且必须绑 `source_object_id` | `ck_event_inbox_fallback_no_event_id` / `_object`（`L312-313`） | 违反 → 23514（`N07`）。**禁止只按文本哈希**（`APP-03`） |
| **U3 会议层** | `(tenant, provider, external_meeting_id)` | `uq_meeting_external`（`L1013`） | 命中 → **复用该 meeting 行**，不新建 |
| **U4 产物层** | `(meeting_id, provider_artifact_id, source_revision)` | `uq_transcript_artifact_revision`（`L1091`） | 命中 → 更新该行状态，不新建（但原文列不可改，见 P-2） |
| **U5 片段层** | `(artifact_id, sequence)` + `(artifact_id, provider_segment_id)` | `uq_transcript_segment_sequence` / `_provider`（`L1133`、`L1143-1145`） | 重取时**先删该 artifact 的片段再重建**（`transcript_segment` 是**唯一**允许物理删除的表，`SCHEMA §1`） |
| **U6 任务层** | `business_task.idempotency_key` | `uq_business_task_idempotency`（`L1430`） | 命中 → 复用同一 Fetch Task（`docs/04 §19`「多个事件指向同一 Artifact → 按 provider artifact ID 复用同一 Transcript Task」） |

### 7.1 "同一会议多次推送"的完整判定

```
重复推送（同 provider_event_id）        → U1 拦掉，零副作用
同 meeting，同 artifact，同 revision    → U4 命中：UPDATE 状态；若内容 sha 变了 → 这是"平台修订" → 走 §7.2
同 meeting，不同 artifact               → 两个 artifact 行（1 meeting : N artifact）
同 event 反复到，但 contents 不同       → 不是重复，是修订（§7.2）
```

### 7.2 平台修订 = 新 `source_revision`，不静默覆盖

| # | 规则 | 依据 |
|---|---|---|
| **TR-U7** | 内容哈希变化 → `source_revision = max(该 provider_artifact_id 的 revision) + 1`，**插新行**；旧行保留（`is_canonical=false` 但可查） | `docs/04 §11`「平台修订转写时创建新版本，不静默覆盖历史」；`INV-6` |
| **TR-U8** | 内容哈希**相同** → 不新建行（真重复） | 同上一句的反面 |
| **TR-U9** | canonical 迁移必须在同一事务里：旧 `is_canonical=false` → 新 `is_canonical=true`（部分唯一索引只允许一个） | `L1116` |
| **TR-U10** | 已被 `interview_record` / `ai_summary` 引用的旧 revision **永不删除、永不改写** | 复合外键 `(artifact_id, transcript_revision)`（`L1209-1210`、`L1255-1256`）物理保证"引用的是真实存在的版本" |

---

## 8. 完整性 Gate：什么时候才能 READY · TR-C

`docs/04 §15 C` 的六项检查，缺一不可：

| # | 检查 | 判定式 | 依据 |
|---|---|---|---|
| **TR-C1** | 取该 meeting 下**全部** artifact | `∀m ∈ M(i): 该 m 的所有 artifact 都已处理到终态或明确待补` | `docs/04 §19`「多个 Recording Artifact → 全部读取，不只取第一份」 |
| **TR-C2** | 按平台分页规则**读完全部内容** | `has_more=false ∧ next_cursor is null` | `docs/04 §15 C`；`ck_transcript_artifact_ready`（`L1103-1104`） |
| **TR-C3** | 内容非意外截断 + 重复片段已去重 | sha 稳定；片段时间范围不冲突 | 同上 |
| **TR-C4** | 只有完整性 Gate 通过才 `READY` | `is_complete=true` ⇔ `status='READY'`（双向，`ck_transcript_artifact_not_complete`，`L1106-1107`） | 库强制 |
| **TR-C5** | `LIVE` 必须有读取回执 | `read_receipt_ref` 非空 ∧ `fetched_at` 非空 | `ck_transcript_artifact_live_receipt`（`L1109-1110`）、负向测试 `N09` |
| **TR-C6** | `READY` ≠ 记录完成 | `interview_record.status` 单独判定；`Transcript READY` 只是"原文齐了" | `docs/04 §18` 逐字 |

### 8.3 P-2 的结构性后果（**这是本节最重要的一条，实现者几乎必错**）

`transcript_artifact` 的列级不可变白名单是（`0001 L1777`）：

```
允许 UPDATE 的列 = transcript_status, fetched_at, last_readback_at, page_count,
                  has_more, next_cursor, is_complete, is_canonical, canonical_selected_by_actor_id
```

**`raw_payload` / `raw_text` / `content_sha256` / `read_receipt_ref` / `provenance` / `trigger_mode` /
`connection_state` / `variant_type` / `language` / `source_generated_at` / `provider_artifact_id` /
`source_revision` 全部在插入后不可改。**

推论（必须照此实现）：

| # | 结论 |
|---|---|
| **TR-C7** | **不得插入"占位 artifact 行"**（内容为空、等以后填）。填不进去，也删不掉（`trg_transcript_artifact_no_delete`），会永久留下一个假的"发现过的产物" |
| **TR-C8** | **首次 INSERT 必须已经带上**：`raw_text` 或 `raw_payload`、`content_sha256`、`read_receipt_ref`（LIVE）、`fetched_at`，以及当时真实的 `transcript_status` |
| **TR-C9** | **"分页还想续取"必须走新 revision**：`PARTIAL`（`has_more=true`）行无法把后续页追加进去（`raw_text` 不可改）→ 续取结果 = `source_revision + 1` 的新行，最终完整那一版才是 `canonical`、才可被 `interview_record` 引用。断点 `cursor` 存**任务**（`business_task.business_refs.next_cursor`），不存 artifact 行 |
| **TR-C10** | 因此 `transcript_status ∈ {DISCOVERED, FETCHING, WAITING_EXTERNAL, AUTH_REQUIRED, NEEDS_LINKING}` 这些"无内容也合法"的状态（`payload_pending_ok`，`L244-247`）在**正常链路里不可达**。若实现里出现它们，说明在造占位行 |

> 这不是设计偏好，是 `fn_guard_columns`（`L60-81`）加白名单的直接后果。**P-3（等待写在任务上）就是从这里推出来的。**

---

## 9. 转写缺失时，评价能否进行 · TR-E

### 9.1 明确结论

> **可以。但必须标明"无转写依据"。**

| # | 规则 | 判定式 | 依据 |
|---|---|---|---|
| **TR-E1** | 面评**不依赖**转写：`scorecard` 与 `transcript_artifact` 之间**没有**任何外键，也不需要 | 结构事实：`scorecard` 表（`0001 L1274-1320`）零 transcript 引用 | `docs/04 §10②`「转写处理与面试官评价必须并行，面试官不必等 AI 记录生成才提交评价」 |
| **TR-E2** | 每份面评必须自报依据来源 | `scorecard.items` 的保留键 `transcript_basis ∈ {'TRANSCRIPT','NO_TRANSCRIPT'}`；`READY` 时为 `TRANSCRIPT`，否则**必须** `NO_TRANSCRIPT` | 无列 → §13 G-1 |
| **TR-E3** | `NO_TRANSCRIPT` 面评**不得**引用任何 `transcript_segment` 作为证据 | 若 `items[].evidence[].kind='SEGMENT'` 与 `transcript_basis='NO_TRANSCRIPT'` 同时出现 → 拒绝写入 | `docs/04 §17 禁止③`（不输出没有 Segment 依据的具体结论） |
| **TR-E4** | **`interview_record` 在无转写时不可能存在**，且必须不存在 | `interview_record.transcript_artifact_id NOT NULL` + 复合外键（`L1209-1210`）→ 没有 artifact 就建不出记录 | 结构强制，不需要额外规则 |
| **TR-E5** | 转写后来就绪，**已提交的面评不重写** | `fn_scorecard_guard`（提交后冻结，`L213-230`）；要改 → 新 `revision_no` | `INV-7`、`docs/04 §19` |
| **TR-E6** | `Evaluation Ready` **不要求**转写就绪 | `REQUIRED = SATISFIED`（`scheduling-rules.md §5.1`）+ `record_ok ∨ 授权记录缺失原因`；`record_ok` 可为"无转写且已记录原因" | `docs/04 §18` Evaluation Ready 三条件（"Record 完成**或**授权记录缺失原因"） |

### 9.2 判定表（`transcript.state` × 评价 × 标记）

| `transcript.state` | 能否提交面评 | 必须的 `transcript_basis` | 能否生成 `interview_record` | 能否进 `Evaluation Ready` |
|---|---|---|---|---|
| `READY` | ✅ | `TRANSCRIPT` | ✅ | ✅ |
| `PENDING` | ✅（并行，不必等） | `NO_TRANSCRIPT` | ❌ | ✅（需记录"材料待补"） |
| `PARTIAL` | ✅ | `NO_TRANSCRIPT` | ❌（`PARTIAL` 记录可存在但非 `READY`，且需 artifact） | ✅ |
| `AUTH_REQUIRED` | ✅ | `NO_TRANSCRIPT` | ❌ | ✅ |
| `NEEDS_LINKING` | ✅ | `NO_TRANSCRIPT` | ❌ | ✅ |
| `MISSING` | ✅ | `NO_TRANSCRIPT` | ❌ | ✅（但决策必须知道这一场"没有原文"） |
| `RETRYABLE_FAILED` | ✅ | `NO_TRANSCRIPT` | ❌ | ✅ |

> **这张表的立法意图**：不许把"转写挂了"升级成"面试白做了"。但也**不许**让"没有原文"这一事实在评价里消失 —— 一份 `TRANSCRIPT` 标记的面评和一份 `NO_TRANSCRIPT` 标记的面评，在决策桌上是两种不同分量的证据。

### 9.3 下游（S10）必须继承的两条

| # | 规则 |
|---|---|
| TR-E7 | `decision.basis_refs` 引用面评时，必须带 `transcript_basis` 与该场次的 `transcript_state`（让"这个决定有没有原文支撑"可查） |
| TR-E8 | 任何汇总/看板**必须**能按 `transcript_basis` 分组统计；**禁止**把 `NO_TRANSCRIPT` 的面评与 `TRANSCRIPT` 的面评做同质平均而不标注 |

---

## 10. 判定用例（5 条，输入 → 结论）

记号：`i1` 是面试安排表里一场 `SCHEDULED` 的面试；`m1` 是它 `PRIMARY` 的会议；等待窗 `WAIT=120min`。

| # | 输入（关键差异） | 结论 | 理由 / 依据 |
|---|---|---|---|
| **T1** | `i1` 排期时已带 `calendar_event_id='evt_1'`，`meeting(m1)` + binding(`SCHEDULED`) 存在；会后飞书推 `minutes.minute.generated_v1`，`source_entity_id=<m1.external_meeting_id>` | 定位到 `m1` → 唯一 binding → `i1`；**INSERT 一行** artifact：`source_revision=1`、`is_complete=true`、`raw_text` 非空、`content_sha256`、`read_receipt_ref='lark:minutes+detail:<token>@1'`、`status='READY'`、`is_canonical=true`；`transcript.state='READY'` | §3.2 L1→L3；TR-C8；P-2/P-3 |
| **T2** | 同上，但事件在产物生成中就到了（平台返回 `2091003`） | **不插 artifact 行**；`business_task(WAITING_EXTERNAL, task_type='FETCH_TRANSCRIPT')`；`transcript.state='PENDING'`（`reason_code='WAITING'`） | TR-F1；P-3；TR-C7 |
| **T3** | 会议结束 3 天后，`i1` 的 `M(i)=∅`（排期时没绑会议） | `transcript.state='MISSING'`、`reason_code='NO_MEETING_BOUND'`；**同时**建立 `SUPPLY_TRANSCRIPT` 待办；面评**仍可提交**，`transcript_basis='NO_TRANSCRIPT'` | §4 序1；TR-F3；TR-E1/TR-E2；跨阶段因果链（`scheduling-rules.md §7.5`） |
| **T4** | 同一个 `provider_event_id` 被推送 3 次；同一 artifact 内容 sha 未变 | 3 次全部被 U1 拦掉（2 次 23505 → ACK，不建任务）；artifact 行数 = 1 | TR-U1；TR-U8 |
| **T5** | 平台修订了转写（同一 `provider_artifact_id`，内容 sha 变了，且原 rev1 已被 `interview_record` 引用） | **新增** `source_revision=2` 行（`is_complete=true`），rev1 保留且 `is_canonical=false`；canonical 迁到 rev2（同事务）；`interview_record` 仍指 rev1（`(artifact_id, revision)` 复合外键）→ 需要新记录才引用 rev2 | TR-U7；TR-U9；TR-U10；`INV-6` |

**覆盖检查**：正常取到(T1) · 生成中(T2) · 从未绑定→缺失(T3) · 重复推送(T4) · 平台修订(T5)。

---

## 11. 实现者最容易搞错的 6 个点（①–③ 必须裁决，已裁决）

| # | 容易写成 | 为什么错 | 裁决 |
|---|---|---|---|
| **①** | 事件一到就 `INSERT transcript_artifact(status='DISCOVERED', raw_text=null)`，等会儿再 UPDATE 填内容 | `raw_text`/`content_sha256` 在不可变白名单外（`L1777`）→ 填不进去；行也删不掉（禁删触发器）→ 永久留一条假产物，且 `ck_transcript_artifact_content` 只允许"无内容的 pending 状态"，于是它会一直"合法地挂着" | **不插占位行**；等待写在 `business_task`；INSERT 时一次带全（TR-C7/TR-C8） |
| **②** | 收到转写事件后，用会议标题/时间"找到大概是这场"然后写 `meeting_binding` | `docs/04 §12` 明确禁止；且 `meeting` 表根本没有标题列，实现者只能从 `event_inbox.payload` 里读标题再猜 —— 这是把"外部不可信文本"当匹配依据 | 只用 §3.2 的 L1–L3；定不到 → `NEEDS_LINKING`（TR-L2/TR-L3） |
| **③** | 把 `transcript READY` 当成"面试记录也好了"，或反之 | 两条状态轴（`docs/04 §18`）：`Transcript READY` = 原文齐了；`Interview Record READY` = 结构化 + 证据校验完成（`ck_interview_record_ready` 要求 `verification_status='VERIFIED'`） | 分别判定、分别回显（TR-D2、TR-C6） |
| ④ | 分页没拉完就标 `READY`（第一页看起来挺完整） | `ck_transcript_artifact_ready` 要求 `is_complete`，而 `is_complete` 只能同 `READY` 出现（双向 CHECK）→ 实现者为了过 CHECK 会把 `is_complete` 直接写 true | 完整性 Gate 六项（TR-C1–C6）；分页未完成 → `PARTIAL` + 新 revision 续取（TR-C9） |
| ⑤ | 把"人工上传"标成 `EVENT` 或把 `NOT_CONNECTED` 标成 `CONNECTED` | `R4` 三维标签混用；`ck_transcript_artifact_connection` 只看取值合法，**看不出**你在撒谎 | TR-S6：上传一律 `MANUAL` + `NOT_CONNECTED` + `LIVE`（若为平台导出件） |
| ⑥ | 无转写时强行凑一份 `interview_record`（内容为空/占位） | `transcript_artifact_id NOT NULL` + 复合外键 → 要么造一个假 artifact（P-2 禁止），要么写不进去。硬写会撞 `ck_interview_record_ready` | 无转写 → **没有** `interview_record`，这是正确结果（TR-E4） |

---

## 12. 系统不做的事（明确清单）

| 不做 | 为什么 | 谁做 |
|---|---|---|
| 不自研 ASR / 说话人分离 / 声纹识别 | `docs/04 §9①`、`§20 C` 逐字 | 会议平台 |
| 不猜会议（标题/姓名/模糊时间/参会人集合） | `docs/04 §12`、`APP-04` | 人工绑定（`MANUAL`） |
| 不把 webhook payload 当逐字稿 | `docs/04 §13` | 回读 API |
| 不下载音视频、不自建媒体存储 | `docs/04 §16` | 平台（只存 ID/引用） |
| 不把多个 meeting 的转写拼成一份 | `docs/04 §20 A/B`；跨 meeting canonical 需 `transcript_set`（`0002`） | 人（若要拼，先改文档再建表） |
| 不覆盖/改写平台原文，不"顺手清洗" | `INV-6`；`docs/04 §21` | 无人（列级不可变） |
| 不补全平台没给的字段（说话人、时间戳、段落 ID） | `docs/04 §21` 逐字 | 无人；缺失就是缺失 |
| 不按固定字符数切块（切片属 S10） | `docs/04 §16`：按说话轮次 + Token Budget | S10 |
| 不用转写"推"出候选人身份或评价 | `docs/04 §17 禁止①②`；`APP-07` | 面试官 / HR |
| 不把 `NO_TRANSCRIPT` 的面评视作无效 | `docs/04 §10②`（并行）+ `TR-E1` | 无人；但必须标注（TR-E2） |
| 不在 v1.0 做自动重试的无限升级 | `docs/04 §19` 只要求"保留任务、可恢复" | 人的重授权 / 放弃决策（TR-F2、TR-F9） |

---

## 13. 与现有 schema 对不上的地方（需要 `0002` 的清单）

| # | 缺口 | 影响 | 需要的变更 | v1.0 现行口径 |
|---|---|---|---|---|
| **G-1** | `scorecard` **没有**"依据来源"列，无法强制 `TRANSCRIPT` / `NO_TRANSCRIPT` | "无转写依据"只能靠 `items` 里的保留键（库不校验） | `0002`: `scorecard.evidence_basis text not null default 'TRANSCRIPT'` + CHECK `in ('TRANSCRIPT','NO_TRANSCRIPT')` | `items.transcript_basis` 保留键 + 写侧校验（TR-E2）；`verify.sql` 加断言 |
| **G-2** | `transcript_artifact` **不可追加内容**（白名单 `L1777` 不含 `raw_text`/`content_sha256`/`read_receipt_ref`） | 分页续取不能在同一行完成（TR-C9）；"占位行"是死路（TR-C7） | 若要"同一行追加"，需专用触发器（只允许 `null → 非null` 或"追加"），属精细化设计。**不建议**放开原文列 | 续取 = 新 `source_revision`；cursor 存任务 |
| **G-3** | `meeting_binding` **没有**"匹配依据"列（只有 `binding_method` 枚举） | `EVENT_MATCH` 到底按哪个键匹配的，无法从绑定行看出来（TR-L4） | `0002`: `meeting_binding.match_basis jsonb`（对齐 `candidate_merge.match_basis` 的做法） | 写 `event_inbox(provider='internal', event_type='meeting.bound')` 的 payload |
| **G-4** | `transcript_artifact` **没有** `needs_visual` / "可读性"标记 | 业务判断无处落列，只能挂在**运维任务**上（§5.1 的两个命名空间） | 不建列（见 §5.1 理由）；若要，加 `content_readability text` 而不是塞进 `transcript_status` | `transcript.state='PARTIAL'`（`reason_code='ONLY_PARTIAL'`）+ `business_task.error_code='NEEDS_VISUAL'` |
| **G-5** | `interview_record` 的 `fk_interview_record_artifact (transcript_artifact_id, transcript_revision)` **未带 `tenant_id`**（`L1209-1210`） | 跨租户引用 artifact 在库层**可能**成立（违背 `XINV-7` 的复合外键口径；对比同表其它外键都带 tenant） | `0002`: 改为 `(transcript_artifact_id, transcript_revision, tenant_id) → transcript_artifact(id, source_revision, tenant_id)`（需先给 `transcript_artifact` 加 `unique (id, source_revision, tenant_id)`） | **写侧必须**自行校验 artifact 与 interview 同租户（不能指望库） |
| **G-6** | `meeting` **没有计划时间**（同 `scheduling-rules.md` G-2） | `TR-D` 序 6 的"会议结束时间"在会议未发生时只能用 `interview.scheduled_end_at`；`WAIT` 的起点因此依赖 S8 的字段 | 同 `scheduling-rules.md` G-2 | 用 `coalesce(meeting.actual_end_at, interview.scheduled_end_at)` |

**两处"契约严于库"**：

| # | 库允许 | 契约要求 | 理由 |
|---|---|---|---|
| S-1 | `transcript_status='READY'` 只要 `is_complete` + `content_sha256`（内容可读性不管） | 还必须通过 TR-C1–C3（全部 artifact、分页取完、非截断） | 库的 CHECK 只能看一行，看不完"所有产物" |
| S-2 | 任意 artifact 可被设为 `is_canonical`（只要该 meeting 只有一个） | 只有 `status='READY'` 的 artifact 可作 canonical | 让一个 `PARTIAL` 当 canonical 会让 `transcript.state` 永远 `PARTIAL`，即使"另一份是完整的" |

---

## 14. 依据索引

| 代号 | 位置 | 本文用它裁定了什么 |
|---|---|---|
| `docs/04 §9` | `docs/04-connectors-and-transcript.md:87-94` | 不自研 ASR/说话人分离；平台负责原始产物 |
| `docs/04 §10` | 同上 `:96-99` | 提前绑定；评价与转写并行 |
| `docs/04 §11` | 同上 `:104-112` | 1:N 关系；修订建新版本；Record 必须引用具体版本 |
| `docs/04 §12` | 同上 `:115-125` | 6 维命名；绑定/解析顺序；**禁止标题/姓名/模糊时间** |
| `docs/04 §13` | 同上 `:128-152` | 飞书 `2091003`/`2091005`；webhook payload 不是逐字稿 |
| `docs/04 §15 C` | 同上 `:171` | 完整性 Gate（六项） |
| `docs/04 §16` | 同上 `:179-190` | 原始与派生分开；不下载媒体；分段与 Chunk |
| `docs/04 §17` | 同上 `:192-198` | 五条禁止（不造假证据、不覆盖原文） |
| `docs/04 §18` | 同上 `:200-213` | 六条状态轴；`Transcript READY ≠ Record READY`；Evaluation Ready 三条件 |
| `docs/04 §19` | 同上 `:215-229` | 异常恢复十一行（去重/续取/重授权） |
| `docs/04 §20 A/B/C` | 同上 `:233-238` | meeting 角色、artifact 变体、说话人不猜 |
| `docs/04 §21` | 同上 `:242-251` | 平台没给的字段保持缺失；完整性针对"平台实际返回" |
| `SCHEMA §8 INV-5/6` | `db/SCHEMA.md:176-177` | 绑定靠平台 ID；原文不可被覆盖 |
| `SCHEMA §9 XINV-7/8` | 同上 `:195-196` | 跨租户、三种事实分离 |
| `SCHEMA §10 APP-04` | 同上 `:209` | 禁止模糊匹配写业务关系 |
| `SCHEMA §12 N08/N09/N23/N28` | 同上 `:244-264` | READY 无完整性 / LIVE 无回执 / 改写原文 / 一会议绑两场 |
| `SCHEMA §11 M-6` | 同上 `:227` | canonical 粒度 = meeting |
| `0001 L992-1045` | `db/migrations/0001_init.sql` | `meeting`（无标题列）+ `meeting_binding`（`uq_meeting_binding_active`） |
| `0001 L1047-1117` | 同上 | `transcript_artifact` 全部列与 CHECK + canonical 唯一索引 |
| `0001 L1119-1145` | 同上 | `transcript_segment` 两套唯一键 |
| `0001 L60-81` / `L1777` | 同上 | `fn_guard_columns` 与 artifact 的可改列白名单（P-2 的根因） |
| `0001 L244-247` | 同上 | `payload_pending_ok`（无内容也合法的状态集） |
| `0001 L1182-1232` | 同上 | `interview_record`（artifact+revision 复合外键、`READY` 需 VERIFIED） |
| `0001 L1274-1323` | 同上 | `scorecard`（无 transcript 引用，TR-E1 的结构证据） |
| `D-17` | `docs/17-decision-ledger.md` | canonical 粒度 = 每 meeting 一个 |
| `D-33` | 同上 `:196` | 不做权限拦截；待补进个人工作台 |
| `D-46` | 同上 `:299` | 不为罕见场景设闸门（§12 的取舍依据） |

> **`ARTIFACT_EMPTY` 增补说明（2026-11-14，D-96）**：飞书实测发现"产物在、状态 READY、正文为空"是真实存在的
> （视频会议录制没有生成"妙记" AI 转写，`+detail --transcript` 只写出表头）。
> 原七条只按 `transcript_status` 派生，会把这种情况报成 `READY` —— **等于把"没读到"说成"有转写"**，
> 正是 TR-D3 要禁止的那类错误。
>
> 增补规则（并入序 2）：`canonical` 存在且映射为 `READY`，但 `content_chars === 0` 时，
> 返回 `state='PARTIAL'` + `reason_code='ARTIFACT_EMPTY'`。
> `content_chars` 缺省（调用方没提供）时保持旧行为，不改变既有语义。