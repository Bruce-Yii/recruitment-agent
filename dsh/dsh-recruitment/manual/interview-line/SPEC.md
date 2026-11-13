# S8 · 面试线（interview line）实现规格 · 2026-11-13

> 本文件是**给并行子代理的共享合同**（不是产品合同）。上游合同：
> `contracts/interview/scheduling-rules.md`（S8 规则）、`contracts/interview/tool-contracts.md`（两个工具形状）、
> `contracts/interview/transcript-rules.md` §4（`transcript.state` 唯一算法）。
> 三者**不得修改**。本文件只写"这一刀切到哪、共用哪些决定"。

## 0. 写范围（硬边界）

只允许新建/修改：

- `src/tools/interview-schedule.ts`（A）
- `src/tools/interview-get.ts`（B）
- `test/unit/interview-*.test.ts`、`test/integration/interview-*.test.ts`（A/B 各写自己前缀的文件）
- `manual/interview-line/**`（Owner）

**禁止**：`contracts/interview/**`、`src/tools/application-intake.ts`、`src/tools/screening-evaluate.ts`、
`src/db/**`、`src/index.ts`、`db/**`、`converter/**`、`src/document/**`、`package.json`、`cordis.patch.yml`。
不 commit、不 push。共享文件交给 Owner/W0。

## 1. 本刀的范围（诚实收窄）

| 工具 | 本刀实现 | 明确不做（写进 README/描述，不假装） |
|---|---|---|
| `recruitment_interview_schedule` | `intent=CREATE`；`interview`+`interviewer`+`meeting`+`meeting_binding`；`business_task`（未绑会议时 `BIND_MEETING`；成功命令落幂等 STORE）；面试官/候选人冲突拒绝；幂等重放 | `RESCHEDULE` / `CANCEL` / `WITHDRAW_INTERVIEWER`（后续切片）；外部日历写；通知 |
| `recruitment_interview_get` | 单场 / 按申请查询；面试官+当前面评；会议绑定状态；`transcript.state` 按 TR-D 七条；`evaluation` 计数与 blockers；warnings | `transcript.artifacts[]` 明细、`open_tasks[]`、`evaluated_at` 时钟字段 |

`contract_version` 两个工具都用 `1.0.0`。`intent` 的 enum **只有** `CREATE`（默认 `CREATE`）。

## 2. 全库通用约定（照抄现有工具）

1. **错误**：`contractError(code, {reason_code, message, detail?})`（`src/tools/contract.ts`），消息形如
   `Error: <CODE>: <单行 compact-json>`。code 封闭集：`INVALID_ARGS` / `NOT_FOUND` / `CONFLICT_SLOT` /
   `ALREADY_SCHEDULED` / `MEETING_ALREADY_BOUND` / `VERSION_CONFLICT` / `NO_TRANSCRIPT` / `NOT_CONFIGURED`。
   `RecruitmentErrorCode` 里没有的码**不要用**（否则 `contractError` 类型不过；运行时也不该出现）。
2. **身份**：`tenant_id` / `actor_id` 只能来自 `ResolvedDatabaseConfig`。入参出现这两个键 →
   `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)`（`parseContractArgs` 已做；手写校验也要做）。
3. **参数校验**：能复用 `parseContractArgs(PARAMS, raw)`（`src/tools/args.ts`）就复用；`interviewers`
   是**对象数组**、`meeting` 是**对象**，`args.ts` 不支持 → 这两个键自己校验，但**未知键检测要合并两份声明**
   （未声明的键 → `INVALID_ARGS(UNKNOWN_PARAM)`，`force`/`allow_conflict`/`skip_conflict_check`/`status`/`record_version` 同样按未声明处理）。
4. **输出值里禁止 `null`**（真实事故：DSH 校验器不支持 type 数组，`null` 会整次 `INVALID_TOOL_OUTPUT`）。
   数据库 NULL 一律**省略键**。输出 schema 只用
   `type/oneOf/properties/required/additionalProperties/items/enum/const/description/title/default/examples`；
   **不得**出现 `type: 'null'`、`type` 数组。
5. **时间**：入参必须带偏移（`Z` 或 `±HH:MM`），正则 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$`；
   裸本地时间 → `INVALID_ARGS(TIMESTAMP_WITHOUT_OFFSET)`。输出时间统一 `new Date(x).toISOString()`（`Z` 也算带偏移）。
6. **事务**：
   - get：`withReadOnly(pool, client => getInTransaction(client, config, rawArgs))`。
   - schedule：`withActor(pool, config.actor_id, client => scheduleInTransaction(client, config, rawArgs))`
     （`withActor` 已 `select set_config('recruitment.actor_id', $1, true)`，即 `SET LOCAL`，D-18）。
   - 每次调用 `createPool(config)` + `finally closePool(pool)`（照 `job-get.ts` 末尾）。
   - 集成测试用 `test/integration/db.ts` 的 `inRolledBackTx` / `testDatabaseConfig` / `createTestPool`，
     **自己写夹具直接 INSERT**（测试代码可以写库），结束时事务回滚。
7. **测试可调用**：每个工具导出 `xxxInTransaction(client, config, rawArgs[, nowMs])`，
   `execute()` 里只做"开池 + 事务 + 调它 + 关池"。这样集成测试与生产走同一条代码路径。
8. **未配置替身**：`unconfiguredXxxTool(issues)`，调用抛 `NOT_CONFIGURED`（照 `job-get.ts`）。
9. **注册**：**不要**改 `src/index.ts`。Owner 把注册签名回传 W0。

## 3. `recruitment_interview_get`（B 负责）

### 3.1 入参

| 参数 | 类型 | 约束 |
|---|---|---|
| `interview_id` | string UUID | 与 `application_id` 二选一 |
| `application_id` | string UUID | 同上 |
| `round_no` | integer 1..20 | 仅 `application_id` 时可用 |
| `require_transcript` | boolean | 默认 `false` |
| `as_of` | string 带偏移 | 不得晚于 now；缺省 now |

错误：两 id 都给 → `INVALID_ARGS(MUTUALLY_EXCLUSIVE)`；都不给 / 只给 round_no → `INVALID_ARGS(MISSING_REQUIRED)`；
`interview_id`+`round_no` → `MUTUALLY_EXCLUSIVE`；非 UUID → `ID_NOT_UUID`；`as_of` 未来 → `AS_OF_IN_FUTURE`。
查不到（含跨租户）→ `NOT_FOUND(INTERVIEW_NOT_FOUND / APPLICATION_NOT_FOUND)`。

### 3.2 导出的 API（A 依赖的运行时签名，先写这个再写测试）

```ts
export const INTERVIEW_VALUE_SCHEMA: Record<string, unknown>   // interviews[] 元素的 schema
export interface InterviewValue { /* 见 3.3 */ }
export async function readInterviewValue(
  client: DatabaseClient, tenantId: string, interviewId: string, asOfIso: string,
): Promise<InterviewValue>   // 查不到抛 NOT_FOUND(INTERVIEW_NOT_FOUND)
export async function getInTransaction(
  client: DatabaseClient, config: ResolvedDatabaseConfig, rawArgs: unknown, nowMs?: number,
): Promise<Record<string, unknown>>
export function createInterviewGetTool(config: ResolvedDatabaseConfig): ReadonlyToolDefinition
export function unconfiguredInterviewGetTool(issues: readonly string[]): ReadonlyToolDefinition
```

### 3.3 `interviews[]` 元素（get 与 schedule 的 `interview` **同一形状**）

```ts
{
  id, application_id, candidate_id, job_id: string,
  round_no: number, slot_code: string, stage_code: string, status: string, record_version: number,
  scheduled_start_at: string, scheduled_end_at?: string,
  duration_minutes?: number,                          // (end-start)/60000，缺一省略
  timezone: string, status_changed_at: string,
  is_overdue_start: boolean,                          // as_of > start && status ∈ {SCHEDULED, RESCHEDULED}
  interviewers: [{ interviewer_id, actor_id, display_name, role_in_interview,
                   required_scorecard: boolean, scorecard_due_at?,
                   scorecard?: { scorecard_id, status, revision_no, submitted_at?, transcript_basis? } }],
  meeting_binding: { state: 'BOUND_ACTIVE'|'UNBOUND'|'NONE_EXPECTED', count: number,
                     bindings: [{ binding_id, meeting_id, binding_method, bound_at,
                                  bound_by_actor_id?, provider, account_scope?,
                                  external_meeting_id?, calendar_event_id?, meeting_role,
                                  actual_start_at?, actual_end_at? }] },
  transcript: { state, reason_code, no_transcript: boolean },
  evaluation: { required_scorecards, submitted, waived, pending, evaluation_ready: boolean,
                blockers: [{ code, interviewer_id?, actor_id?, interview_record_id? }] },
  warnings: [{ code, message, interview_id?, meeting_id? }],
}
```

规则：

- `interviewers[]` 按 `actor_id` 字典序；`meeting_binding.bindings[]` 按 `(meeting_role, bound_at, meeting_id)`；
  `bindings = 全部 active（unbound_at is null）`；`count = bindings.length`。
- `transcript.state` 严格按 `transcript-rules.md` §4 TR-D 七条（`ART.status` 列名是 `transcript_status`；
  `WAIT=120` 分钟，可读 `business_config(config_key='transcript_policy').payload.wait_minutes` 覆盖；
  `M(i)` 只看 `meeting_role ∈ {PRIMARY, CONTINUATION}` 的 active binding；`as_of` 由入参/now 传入）。
  `no_transcript = state !== 'READY'`。
- `evaluation`：`required = count(interviewer.required_scorecard)`，`submitted/waived` = 当前
  （`superseded_by_scorecard_id is null`）面评状态；`pending = required - submitted - waived`（≥0）；
  `blockers` 逐条：未交的 → `SCORECARD_PENDING`；`required=0` → `NO_REQUIRED_EVALUATOR`；
  没有 `interview_record.status='READY' ∧ verification_status='VERIFIED' ∧ is_current` 的当前记录 → `RECORD_NOT_READY`。
  `evaluation_ready = required>0 ∧ pending=0 ∧ 无 RECORD_NOT_READY`。本工具**只回显，不写状态**。
- `warnings`：`MEETING_NOT_BOUND`（state=UNBOUND）、`MEETING_NOT_BOUND_OVERDUE`（且 is_overdue_start）、
  `NO_REQUIRED_EVALUATOR`、`CANONICAL_MISSING`（transcript 由 TR-D 序3 命中）、`MISSING_TRANSCRIPT_BASIS`
  （面评 `items` 无 `transcript_basis`）。**warnings 不改变 `status`**（恒 `"OK"`）。
- `as_of` 原样回显；输出**不含** `evaluated_at`/`now`。

### 3.4 顶层输出

`{tool, contract_version, status:"OK", read_only:true, labels:{provenance:"LIVE",trigger:"MANUAL",connection:"CONNECTED"},
as_of, query:{mode:"BY_INTERVIEW"|"BY_APPLICATION", ...(给了的 id/round_no)}, count, interviews:[...]}`
`count === interviews.length`。`require_transcript=true ∧ state!=='READY'` → `Error: NO_TRANSCRIPT`，
`reason_code` **逐字**取 `transcript.reason_code`，`detail` 带 `interview_id / transcript_state / meetings_total`。

## 4. `recruitment_interview_schedule`（A 负责）

### 4.1 入参（`intent=CREATE`）

| 参数 | 必填 | 约束 |
|---|---|---|
| `intent` | — | enum `["CREATE"]`，默认 `CREATE` |
| `idempotency_key` | ✅ | 1..200，`^[A-Za-z0-9_.:-]+$` |
| `application_id` | ✅ | UUID |
| `round_no` | ✅ | 1..20 |
| `slot_code` | — | 默认 `DEFAULT`，`^[A-Z][A-Z0-9_]{1,20}$` |
| `interviewers` | ✅ | 对象数组 minItems 1：`{actor_id UUID ✅, role_in_interview? 默认 INTERVIEWER, required_scorecard? 默认 true, scorecard_due_at? 带偏移}` |
| `scheduled_start_at` | ✅ | 带偏移，**晚于 now** |
| `duration_minutes` | ✅ | 15..480 |
| `timezone` | — | 默认 `Asia/Shanghai`，仅展示 |
| `delivery_mode` | — | 只接受 `VIDEO` |
| `meeting` | — | `{provider ✅ 1..64, account_scope? 1..200, calendar_event_id? / external_meeting_id? 至少一个, meeting_role? PRIMARY\|CONTINUATION 默认 PRIMARY}` |
| `interview_template_version_id` | — | UUID（给了就校验属于该 application 的 job，否则 `TEMPLATE_JOB_MISMATCH`） |

拒绝：`tenant_id`/`actor_id` → `TENANT_OR_ACTOR_NOT_ALLOWED`；未声明键（含 `force`/`allow_conflict`/
`skip_conflict_check`/`status`/`record_version`/`reason`）→ `UNKNOWN_PARAM`；`meeting_role` 给
`REPLACED`/`CANCELLED` → `MEETING_ROLE_NOT_ALLOWED`；形式非 VIDEO → `UNSUPPORTED_DELIVERY_MODE`；
面试官空 → `INTERVIEWER_REQUIRED`；重复 actor → `DUPLICATE_INTERVIEWER`；越界 → `OUT_OF_RANGE` 或
`ROUND_OUT_OF_RANGE`/`DURATION_OUT_OF_RANGE`（按契约 §3.7 的码）；过去时间 → `START_IN_PAST`；
meeting 两个 ID 都没有 → `MEETING_IDENTITY_REQUIRED`。

### 4.2 导出的 API

```ts
export interface ScheduleArgs { /* 校验后的规范形态 */ }
export function parseScheduleArgs(raw: unknown, nowMs: number): ScheduleArgs  // 纯函数，抛 contractError
export async function scheduleInTransaction(
  client: DatabaseClient, config: ResolvedDatabaseConfig, rawArgs: unknown, nowMs?: number,
): Promise<Record<string, unknown>>
export function createInterviewScheduleTool(config: ResolvedDatabaseConfig): ReadonlyToolDefinition
export function unconfiguredInterviewScheduleTool(issues: readonly string[]): ReadonlyToolDefinition
```

`scheduleInTransaction` 里**先**做形状校验（不含"时间是否过去"），**再**查幂等 STORE：
命中且 digest 相同 → 重放（`replayed:true`、`changes` 三数组全空、`interview` 从库读回）；
digest 不同 → `INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)`；**然后**才做 `START_IN_PAST` 等时点校验
（重放不能被"时间已过"影响）。

### 4.3 事务内顺序（单事务，任何失败整笔回滚）

1. 查 `business_task` (`idempotency_key='interview_schedule:'||K`)：见 4.2 的重放/复用分支。
2. 读 application（同租户）：不存在 → `NOT_FOUND(APPLICATION_NOT_FOUND)`；`lifecycle_status!='ACTIVE'` →
   `INVALID_ARGS(APPLICATION_NOT_ACTIVE)`（合同未给这个码，README 记为缺口）。
3. 语义幂等：同 `(application_id, round_no, slot_code)` 任何状态已有行 → `ALREADY_SCHEDULED`，
   `detail={existing_interview_id, existing_status, hint:"如需改时间请用 intent=RESCHEDULE"}`。
4. 面试官：`actor` 同租户；不存在/跨租户 → `NOT_FOUND(INTERVIEWER_NOT_FOUND)`；`kind!='HUMAN'` →
   `INVALID_ARGS(INTERVIEWER_NOT_HUMAN)`。
5. 冲突（`scheduling-rules.md §3.2`）：窗口 `[start, end+buffer)`（buffer 读
   `business_config(config_key='interview_scheduling_policy').payload.buffer_minutes`，缺省 0）；
   面试官只算 `required_scorecard=true` 的行；候选人按 `application.candidate_id` 跨轮次；
   只算 `status ∈ {SCHEDULED, IN_PROGRESS}` 且 `id != 本场`；占位窗口用
   `coalesce(meeting.actual_start_at, i.scheduled_start_at)` / `coalesce(actual_end_at, i.scheduled_end_at)`；
   命中 → `CONFLICT_SLOT(INTERVIEWER_BUSY|CANDIDATE_BUSY)`，`detail={slot:{start,end}, conflicts:[{kind,ref_kind:"INTERVIEW",ref_id,actor_id?,window:{start,end}}]}`（按 `(kind,ref_id)` 排序）。
6. `INSERT interview`：显式 `stage_code='S8'`、`status='SCHEDULED'`、`timezone`、`status_changed_by_actor_id=config.actor_id`，
   `RETURNING id, record_version`。`23505 uq_interview_slot` → 翻译 `ALREADY_SCHEDULED`；
   `23503 fk_interview_stage_catalog` → `INVALID_ARGS(STAGE_CODE_NOT_IN_CATALOG)`（S8 不在目录时应失败）。
7. `INSERT interviewer` 每行（`role_in_interview`/`required_scorecard`/`scorecard_due_at`）。
8. meeting（可选）：
   - 有 `external_meeting_id`：先按 `(tenant, provider, external_meeting_id)` 找 meeting 行；
     有 active binding 且不是本场 → `MEETING_ALREADY_BOUND`；未绑定 → 复用；
   - 只有 `calendar_event_id`：按 `(tenant, provider, calendar_event_id)` 找最近一行；有 active binding → `MEETING_ALREADY_BOUND`；未绑定 → 复用；
   - 都没有匹配 → `INSERT meeting`；`23505 uq_meeting_external` → `MEETING_ALREADY_BOUND`；
   - `INSERT meeting_binding(binding_method='SCHEDULED', bound_by_actor_id=config.actor_id)`；
     `23505 uq_meeting_binding_active` → `MEETING_ALREADY_BOUND`。
9. 没给 meeting → `INSERT business_task(task_type='INTERVIEW_MEETING_BIND', status='WAITING_EXTERNAL',
   idempotency_key='bind_meeting:'||interview_id, business_refs=[{kind:'INTERVIEW',id:interviewId}],
   title=..., due_at=scheduled_start_at, created_by_actor_id=config.actor_id)`。
10. 幂等 STORE：`INSERT business_task(task_type='INTERVIEW_SCHEDULE', status='SUCCEEDED',
    idempotency_key='interview_schedule:'||K, business_refs=[{kind:'INTERVIEW',id},{args_digest,result_interview_id}],
    title=..., completed_at=now(), result_ref=interviewId, created_by_actor_id=config.actor_id,
    status_changed_by_actor_id=config.actor_id)`；
    `23505 uq_business_task_idempotency` → 重读 STORE → 重放（并发同键）。
11. `readInterviewValue(client, tenant, interviewId, asOfIso)` 读回（**写完立即可查的自证**）。

`args_digest = 'sha256:' + digestOf(args 去掉 idempotency_key)`（`digestOf`/`canonicalJson` 来自 `contract.ts`）。

### 4.4 顶层输出

```json
{"tool":"recruitment_interview_schedule","contract_version":"1.0.0","status":"OK","write":true,
 "replayed":false,
 "labels":{"provenance":"LIVE","trigger":"MANUAL","connection":"NOT_CONNECTED"},
 "intent":"CREATE",
 "command":{"idempotency_key":"…","args_digest":"sha256:…"},
 "interview": { /* 3.3 同一形状 */ },
 "changes":{"created":[{"table":"interview","id":"…"},{"table":"interviewer","id":"…"},
            {"table":"meeting","id":"…"},{"table":"meeting_binding","id":"…"},
            {"table":"business_task","id":"…"}],
            "updated":[],"unchanged":[]},
 "effects":{"meeting_bound":true,"external_call_made":false},
 "warnings":[{"code":"MEETING_NOT_BOUND","message":"…"}],
 "next_actions":[{"code":"BIND_MEETING","task_id":"…","due_at":"…"}]}
```

`changes.created` **逐行**列出真实写入（失败时不存在该输出；测试用 SQL 行数证明零写）。
`warnings` 封闭枚举 `MEETING_NOT_BOUND` / `ALREADY_ASSIGNED` / `BINDING_REUSED` / `MEETING_ROLE_DOWNGRADED`；
本刀至少实现 `MEETING_NOT_BOUND`（无 meeting 时）。
`next_actions` 只在写了 BIND_MEETING 任务时出现，`code` 恒 `BIND_MEETING`。

## 5. 测试要求

### 5.1 单元（不连库）

- `test/unit/interview-schedule-args.test.ts`：`parseScheduleArgs` 的全部拒绝路径 + 默认值
  （slot `DEFAULT`、role `INTERVIEWER`、required_scorecard true、timezone、delivery VIDEO）。
- `test/unit/interview-get-args.test.ts`：互斥/缺失/round_no 依附/as_of/require_transcript 类型。
- `test/unit/interview-output-schema.test.ts`（Owner 可写，A/B 不写）：两个工具的 output.schema 只用 DSH 子集、
  无 `type:'null'`、值里无 null（用样例值）。

### 5.2 集成（真库 `ra_s6s7`，必须跑）

- `test/integration/interview-schedule.test.ts`（A）：
  - 成功：interview `stage_code='S8'`、`round_no`、`status='SCHEDULED'`、`scheduled_end_at=start+60min`；
    interviewer 行数=入参、`required_scorecard` 正确；meeting + binding 行；`changes.created` 表名/id 对得上；
  - 幂等重放：同 key 同参 → `replayed=true`、`changes.created` 空、interview 表行数不变；
    同 key 不同参 → `INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)`；
  - 语义幂等：同 slot 再 CREATE → `ALREADY_SCHEDULED`，零写入；
  - 冲突：同面试官重叠 → `CONFLICT_SLOT(INTERVIEWER_BUSY)`，`detail.conflicts[0].kind='INTERVIEWER'`，零写入；
  - 会议负例：已有 meeting 绑在别的 interview 上，`CREATE` 用同一 `external_meeting_id` →
    `MEETING_ALREADY_BOUND`，零写入（**另**用裸 SQL 断言第二条 active binding 得到真实 `23505` +
    约束名 `uq_meeting_binding_active`）；
  - 缺面试官 → `INVALID_ARGS(INTERVIEWER_REQUIRED)`，零写入；`AGENT_WORKER` 面试官 → `INTERVIEWER_NOT_HUMAN`；
  - 非法 `stage_code` → 裸 SQL INSERT 得真实 `23503`，约束名 `fk_interview_stage_catalog`（0006 的外键）。
- `test/integration/interview-get.test.ts`（B）：
  - 直接 INSERT 一场（S8、round 2、slot `BACKEND`、两个面试官、meeting+binding、一个 scorecard），
    `getInTransaction` 读回：`count=1`、字段逐项、`interviewers` 排序、`meeting_binding.state='BOUND_ACTIVE'`；
  - 未绑会议 + 已过开始 → `UNBOUND` + `MEETING_NOT_BOUND_OVERDUE` + `transcript.state='MISSING'/NO_MEETING_BOUND`；
  - `require_transcript=true` → `NO_TRANSCRIPT`，reason 与 transcript 一致；
  - `BY_APPLICATION` 两场次按 `(round_no, slot_code)` 排序 + `count` 恒等；
  - `NOT_FOUND`（随机 UUID / 跨租户假 id）；互斥参数错误。
  - TR-D 至少两条：序2（canonical READY → READY/CANONICAL_STATUS）与序7（有绑定、未到结束+WAIT → PENDING/WAITING）、
    序6（超过 scheduled_end+120min 无 artifact → MISSING/NO_ARTIFACT_AFTER_WAIT）。

集成测试数据一律在 `inRolledBackTx` 里造，结束 ROLLBACK（不污染 `ra_s6s7`）。

### 5.3 跑测试

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment
$env:RECRUITMENT_DB_PASSWORD='123456'
node --test "test/unit/interview-*.test.ts"
node --test "test/integration/interview-*.test.ts"
```

报数必须给 `tests / pass / fail / skipped` 四个数；**不许新增失败**，`skipped` 必须 0。
