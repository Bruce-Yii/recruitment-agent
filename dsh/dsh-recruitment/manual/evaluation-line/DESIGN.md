# S10 评价线 · 实现锁定（三个并行子代理共用的接口契约）

**Owner**：S10（评价线）。**分支**：`feat/unified-document-intake`（本地 = 远端 `5581c26`）。**不 commit、不 push。**

权威是 `dsh/dsh-recruitment/contracts/evaluation/{scorecard-rules,decision-rules,tool-contracts}.md`（下称 **SC / DC / TC**）。
本文只锁「三份实现怎么对接」与「库缺口怎么落地」。**与契约冲突时以契约为准，且必须在本文件登记偏差。**

---

## 0. 文件所有权（越界即作废）

只能写：

- `src/tools/scorecard-submit.ts`（新）
- `src/tools/evaluation-summarize.ts`（新）
- `src/tools/decision-record.ts`（新）
- `test/unit/evaluation-*.test.ts`（新）
- `test/integration/evaluation-*.test.ts`（新）
- `manual/evaluation-line/**`（新）

**不许碰**：`contracts/evaluation/**`、`src/index.ts`、`src/db/**`、`src/tools/{application-intake,screening-evaluate,job-get,contract,args,errors,definition}.ts`、`db/**`、`converter/**`、`src/document/**`、`test/integration/db.ts`。
需要改它们 → 停下报告，不要改。

---

## 1. 数据访问约定（照抄 `screening-evaluate.ts` 的既有手法）

每个工具**导出两件东西**：

```ts
export function createXxxTool(deps: { database: ResolvedDatabaseConfig }): ReadonlyToolDefinition
export async function xxxInTransaction(
  client: DatabaseClient,              // 调用方给的连接；actor 已由调用方 set_config 设好
  cfg: ResolvedDatabaseConfig,
  rawArgs: unknown,
  nowMs: number,                       // 服务端"现在"（execute 里传 Date.now()，测试可注入）
): Promise<XxxOutput>                   // 抛 RecruitmentToolError
```

`execute()` 里：

- 写工具：`withActor(pool, cfg.actor_id, (client) => xxxInTransaction(client, cfg, args, Date.now()))`，`finally { await closePool(pool) }`。
- 只读工具：`withReadOnly(pool, ...)`（库层强制只读，TC §7.4）。
- **SQL 一律参数化**（`$1`…），不得拼字符串。

`import { withActor, withReadOnly, createPool, closePool, isUuidText, type DatabaseClient, type ResolvedDatabaseConfig } from '../db/pool.ts'`
`import { canonicalJson, digestOf, checkAsOf, isUuid } from './contract.ts'`

---

## 2. 错误形状（TC §1.2，逐字）

`Error: <CODE>: <compact-json>`，键序**固定**：`code` → `reason_code` →（`family`，仅 `BLOCKED_BY_REVIEW`）→ `message` → `detail`（无则不占位）。
JSON **单行**、键按上面顺序、可 `JSON.parse`。

`src/tools/errors.ts` 的 `RecruitmentErrorCode` 联合**不含** S10 的 8 个新码，而 `errors.ts` **不在写范围**。
所以每个文件各带一个**同文**的局部构造器（刻意重复，避免越界 + 避免互相 import）：

```ts
type EvaluationErrorCode =
  | 'INVALID_ARGS' | 'NOT_FOUND' | 'NOT_CONFIGURED'
  | 'INTERVIEWER_MISMATCH' | 'ALREADY_SUBMITTED' | 'VERSION_CONFLICT'
  | 'EVIDENCE_INSUFFICIENT' | 'SCORECARD_MISSING' | 'BLOCKED_BY_REVIEW'
  | 'DECISION_REQUIRES_HUMAN' | 'ALREADY_DECIDED' | 'DB_CONSTRAINT_VIOLATION'

function evalError(code: EvaluationErrorCode, reasonCode: string, message: string, detail?: unknown): Error {
  const body: Record<string, unknown> = { code, reason_code: reasonCode, message }
  if (detail !== undefined) body.detail = detail
  const error = new RecruitmentToolError(code as never, canonicalJson(body))
  return error
}
```

`RecruitmentToolError` 的 `code` 运行期就是传入值（`this.code = code`），所以 `error.code` 正确。

**`as_of` 格式错** → `INVALID_ARGS(TYPE_MISMATCH)`（TC §5.1 封闭集里没有 `AS_OF_FORMAT`；`AS_OF_IN_FUTURE` 照用 `checkAsOf`）。此偏差必须写进交付说明。

**`parameters`** 必须 `additionalProperties: false` 且显式声明保留键（`tenant_id`/`actor_id`/`interviewer_id`/`decided_by_actor_id`/`stage_code`/`round_no`/`slot_code`/`submitted_at`/`decided_at`/`status`/`idempotency_key`(record)），
即：**声明了但一律拒收**，报 `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)`（TC §1.6）；未声明键 → `INVALID_ARGS(UNKNOWN_PARAM)` + `allowed[]`。

参数校验规则（TC §1.1 八条）：对象根、未知键拒绝、必填缺失、类型、整数闭区间、布尔、数组逐元素 + 重复拒绝、**一次收集全部违反项**（`violations[]`）、字符串 id 必须 UUID 文本（`ID_NOT_UUID`）。

---

## 3. 三个工具之间的接口（唯一跨文件契约）

`evaluation-summarize.ts` **必须导出**（`decision-record.ts` 只 import 这两个名字，不得自己再算一遍门禁）：

```ts
/** 汇总投影（只读、无时钟、确定性）。TC §3 / DC §3.2。 */
export async function computeEvaluationSummaryIn(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  rawArgs: unknown,
  nowMs: number,
): Promise<EvaluationSummary>

export type EvaluationSummary = Record<string, unknown> // 形状 = DC §3.2 的 JSON，逐键照抄
```

`decision-record.ts` 用法（STEP 4 的唯一实现）：

```ts
import { computeEvaluationSummaryIn, type EvaluationSummary } from './evaluation-summarize.ts'
const summary = await computeEvaluationSummaryIn(client, cfg, {
  application_id, decision_scope, ...(interview_id === undefined ? {} : { interview_id }), as_of,
}, nowMs) as EvaluationSummary & { summary_digest: string; permitted_results: string[]; ... }
```

`scorecard-submit.ts` **不**依赖另外两个文件。

---

## 3.5 三条精确口径（子代理必须逐字照做，避免三份实现互不一致）

**① 执行上下文 actor = 事务里的 `recruitment.actor_id` GUC，不是 `cfg.actor_id`**

```ts
const { rows } = await client.query("select nullif(current_setting('recruitment.actor_id', true), '') as actor_id")
```

取不到 → `INVALID_ARGS(ACTOR_REQUIRED)`（**登记偏差**：TC §5.1 无此取值）。
`cfg.actor_id` 只用于 `execute()` 里 `withActor()`；`-InTransaction` 变体**必须**读 GUC，测试才能在同一个池上切换身份。

**② `rationale` 的固定编码（G-1）**

```text
rationale := [ "修订原因：" + revision_reason + "\n" ] + "REJECT_REASONS_JSON: " + canonicalJson(reject_reasons_array)
```

- **始终**写这一行（没有拒绝理由时数组为 `[]`），保证读侧一定能解析；
- 解析：按行找**最后**一个以 `REJECT_REASONS_JSON: ` 开头的行，`JSON.parse(行剩余部分)`；失败 / 缺失而 `overall='REJECT'` → `INVALID_ARGS(RATIONALE_NOT_PARSABLE)`；
- 修订原因只在 `revision.revision_reason` 存在时写首行（SC-19）。

**③ `payload_hash`（SC-38）**

```ts
payload_hash = digestOf({ interview_id, rubric_version_id, items, overall, reject_reasons: reject_reasons ?? [] })
```

（`digestOf` = `sha256(canonicalJson(v))`，小写 hex；键序由 `canonicalJson` 保证。）

**④ D-79 approval 的落地位置**（只影响 `decision-record.ts`）

```ts
export interface DecisionToolDeps {
  readonly database: ResolvedDatabaseConfig
  /** DSH `ctx.approval` 的窄接口（D-79）。**缺省 = 一律拒绝**，不存在"直接写库"的分支。 */
  readonly approval?: { request(req: {
    agent?: unknown; toolName: string; reason?: string; signal?: AbortSignal
  }): Promise<string> }
}
```

`execute()` 里**先**过 approval（`outcome === 'allowed-once'` 才继续），**再**走契约的
`human_confirmation` 四项校验（两者都要，approval 不是替代品）：

- 无 `approval` 依赖 → `DECISION_REQUIRES_HUMAN(APPROVAL_UNAVAILABLE)`
- `outcome='unavailable'` → `DECISION_REQUIRES_HUMAN(APPROVAL_UNAVAILABLE)`
- 其它任何非 `allowed-once` → `DECISION_REQUIRES_HUMAN(APPROVAL_NOT_GRANTED)`

`APPROVAL_UNAVAILABLE` / `APPROVAL_NOT_GRANTED` 是 D-79（较晚）新增的两个 reason_code，TC §4.2 的五个是 D-79 之前的封闭集 → **登记偏差**，交付说明里必须写。
`-InTransaction` 变体把 approval 结果作为**显式参数**（`approvalOutcome: 'allowed-once' | ...`）传入，便于测试；`execute()` 负责真的去问。

---

## 4. 库缺口落地（0007/0008 未应用到 `ra_s6s7`，已现场核实）

| 缺口 | 本轮落地（一致口径） |
|---|---|
| **G-1** 无 `reject_reasons`/`revision_reason`/`evidence_state` 列 | 全写进 `scorecard.rationale`，固定格式：`REJECT_REASONS_JSON: <单行 canonical JSON 数组>`；修订时**首行** `修订原因：<text>`。解析方（summarize/decision）用**同一个正则** `^REJECT_REASONS_JSON: ` 抓最后一段；抓不到且 `overall='REJECT'` → `INVALID_ARGS(RATIONALE_NOT_PARSABLE)` |
| **G-2** 无 `idempotency_key` 列 | 落 `event_inbox`：`provider='internal'`、`event_type='scorecard.submit'`、`idempotency_key='scorecard:'||key`、`idempotency_source='FALLBACK_KEY'`、`source_object_id=<scorecard_id>`、`payload={payload_hash, scorecard_id, interview_id, interviewer_id}`、`trust_level='INTERNAL'`。重放判定 = 同 key 行存在且 `payload->>'payload_hash'` 相同 → `replayed:true` 原样回显该 `scorecard_id`；不同 → `INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)` |
| **G-3** 修订三步舞 | 反向插（新行 `superseded_by_scorecard_id = old.id`）→ 旧行指向新行 → 新行置 `NULL`。**第 1 步的 INSERT 是终态行，必须自带 `status_changed_by_actor_id` + `status_changed_at` + `status_source_event_id`**（SC-44） |
| **0007/0008 未落地** | `decision` 无 current 部分唯一索引 → **先查 current（`superseded_by_decision_id is null`）再插，写后复核**；**禁止 `SELECT … FOR UPDATE`**（D-80）。23505 若出现（`uq_decision_id_tenant` 等）按 §5.3 兜底；文档注明 0007 落地后 23505 必须映射 `ALREADY_DECIDED` |
| **`scorecard` 无 `transcript_basis` 列** | 作为 `items` 的保留键随 `items` 落库（DC/TC 已如此规定），读侧从 `items` 取 |

---

## 5. 现场事实（2026-11-13 实测，勿再猜）

- 库：`ra_s6s7` @ 127.0.0.1:5432，`RECRUITMENT_DB_PASSWORD='123456'`（本机演示；**不得写进任何文件**）。
- 租户 `11111111-1111-4111-8111-000000000001`；HUMAN actors 101/102/103/104（103 = HR 专员，插件配置里的 `actor_id`）。
- 岗位 `…0401`（DEMO-BE-001）；rubric v1 `…0403`（维度 `backend_depth` / `async_pipeline` / `frontend_basics`，**面评用这个**）；rubric v2 `…0404` 是初筛 rubric（EXISTS 算子，不是面评分项）。
- 申请 `11111111-1111-4111-8111-000000000701`：`current_stage_code='S7'`，`rubric_version_id=…0403`（**已钉住**）。
- **当前没有 interview / interviewer / transcript 行**（S8/S9 未落数据）：演示前由 `manual/evaluation-line/seed-demo.mjs` 造（面评侧不动 S8/S9 代码）。
- `scorecard` 已存在：`uq_scorecard_current (interview_id, interviewer_id) where superseded_by_scorecard_id is null`、`uq_scorecard_revision`、`fn_scorecard_guard`（`old.status<>'PENDING'` 时除 6 列外全不可改）、`fn_row_guard`（只 `BEFORE UPDATE`）。
- `decision` 只有 PK + 5 FK + `ix_decision_application`，**无 current 唯一索引**。
- `transcript_artifact`/`transcript_segment` 存在（`transcript_status`、`is_canonical`、`content_text`）。

---

## 6. 测试约定

- `node --test`（包根）真库跑：`$env:RECRUITMENT_DB_PASSWORD='123456'; node --test`。
- 基线（改动前，2026-11-13）：**tests 389 / pass 389 / fail 0 / skipped 0**。**不得新增失败，不得新增 skip。**
- unit 测试：不连库，只测纯函数（参数校验、rationale 编解码、digest、schema 封闭性）。
- integration 测试：`inRolledBackTx(pool, ...)` + `xxxInTransaction(client, …)`（**不要**在测试里调 `execute()`——它自建池，看不到未提交夹具）。
- 每个集成用例自己造 interview/interviewer/transcript（`test/integration/db.ts` 的 `seedScenario` 不产这三样）。

---

## 7. 交付纪律

- 不写 `TODO`/占位实现；契约要求的行为要么实现要么抛封闭错误码。
- 不打印 PII；日志/错误 detail 不放姓名、电话、邮箱（R7）。
- 每个文件头部注释写清：负责哪几条 SC/DC/TC，以及**已知偏差**（尤其 §2 的 `as_of` 格式码、§4 的库缺口）。
