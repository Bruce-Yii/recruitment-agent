// D5 决策 facts 投影 + screening/evaluate + decision/record facade（W2b 消费入口）。
//
// 冻结契约：`work/d5/decision/CONTRACT.md`（W2b 逐字消费口径，W0 2026-11-15）、
// `work/d5/actions/CONTRACT.md`（screening/decide 与 decision/record 的既有服务端派生口径）、
// `contracts/job-screening/tool-contracts.md` §17.1（SCREENING 的 basis 分片）、
// `contracts/evaluation/decision-rules.md`（S10 basis / summary digest）。
//
// 独立前缀 `/recruitment/api/decision`（**不能**复用 `/recruitment/api` 或
// `/recruitment/api/recruiting`：webServer 对重复 `(kind,path)` 直接 throw；本文件只注册 exact path）：
//   * `GET  /recruitment/api/decision/facts?application_id=<uuid>`   只读事实投影（同源 loopback + session 绑定）；
//   * `POST /recruitment/api/decision/screening/evaluate`            复用 `recruitment_screening_evaluate`（只读 domain，
//     Host 人类动作入口），返回 evaluation 事实 + 独立 DB 读回；
//   * `POST /recruitment/api/decision/record`                        facade：body 只有业务选择，服务端从 facts 组装
//     `basis_refs`（SUMMARY / RUBRIC_VERSION / AUTHORITY / SCORECARD）并调 `recruitment_decision_record`。
//
// 为什么要有这一层（不是重复实现）：
//   现有 `src/http/recruiting.ts` 的只读投影**不暴露** `rubric_version.payload_hash`、`job_version.payload_hash`、
//   `AUTHORITY`、`summary_digest` 等决策依据键，W2b 无法诚实构造 `basis_refs`。本文件只做 ① 事实投影
//   ② 身份/同源闸门 ③ 「人点击 = allow-once」适配 ④ 写后独立 DB 读回；参数校验、领域规则、事务、幂等、
//   approval 位置全部仍在既有工具实现里（`screening-evaluate.ts` / `decision-record.ts` /
//   `evaluation-summarize.ts`），本文件**不重写任何业务规则**。
//
// 冻结口径与偏差（见 `work/d5/decision/REPORT.md`）：
//   1. `screening_evaluation` 在库里**没有独立表**：`recruitment_screening_evaluate` 是只读工具
//      （`read_only:true`，唯一持久化载体是 `decision.basis_refs`，screening-rules §11 D-3/P-1）。
//      因此 facts 的取值顺序是：当前 SCREENING decision 的 `SCREENING_EVALUATION` 分片（persisted=true，
//      source=SCREENING_DECISION_BASIS）→ 否则现场跑一次只读评估（persisted=false，
//      source=SCREENING_EVALUATE_LIVE，digest 由 domain 真实计算，不编造）；两者都不行则为 null 且进 missing[]。
//      `evaluation_id` 没有库 id：用 `deriveEvaluationId(evaluation_digest)` 派生**内容寻址** UUID 形态标识，
//      同时给 `evaluation_id_kind=DERIVED_FROM_EVALUATION_DIGEST`（不是数据库主键，不冒充）。
//   2. `POST /screening/evaluate` 复用的工具没有 D-79 approval 分支（只读工具），因此 `approval.result`
//      如实写 `not-applicable`，人类动作闸门由「同源 loopback + 已绑 session + 只允许 recruiter alias」承担。
//   3. `POST /record` 契约 body 未含 `interview_id`，但既有 `recruitment_decision_record` 的
//      `decision_scope=STAGE` **必须**带 interview_id（DC-06）。facade 把 `interview_id` 作为 STAGE 的
//      可选扩展键接受（FINAL 传了就 400），不改前端契约的既有键；缺失时 400 `STAGE_REQUIRES_INTERVIEW`。
//   4. `basis.screening_decide` 的 `SCREENING_EVALUATION` 分片按 `decision-record.ts` 的运行期 schema 组装：
//      只带白名单键（不带 `evaluation_id`：该键不在 basis_ref 允许键集，带了会 400 UNKNOWN_PARAM）。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'

import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
// 批准真值只有一份判据（approval 行；`approved_by_approval_id` 恒 null，O8）。
import { isRubricVersionApproved } from '../db/approval.ts'
import { checkAsOf, isUuid } from '../tools/contract.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorAlias,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'
import {
  confirmationTextSha256,
  createDecisionRecordTool,
  parseDecisionArgs,
} from '../tools/decision-record.ts'
import { evaluateInTransaction } from '../tools/screening-evaluate.ts'
import { computeEvaluationSummaryIn } from '../tools/evaluation-summarize.ts'
import { scorecardShapeViolations } from '../tools/evaluation-summarize.ts'

// =====================================================================
//  契约常量
// =====================================================================

/** 独立前缀（见文件头；exact path 逐个注册）。 */
export const DECISION_ROUTE_PREFIX = '/recruitment/api/decision'

/** 端点 → exact path（路径是契约，W2b 按此请求）。 */
export const DECISION_PATHS = {
  facts: `${DECISION_ROUTE_PREFIX}/facts`,
  screeningEvaluate: `${DECISION_ROUTE_PREFIX}/screening/evaluate`,
  record: `${DECISION_ROUTE_PREFIX}/record`,
} as const

/** 响应 `contract_version`（W2b 用它判形态）。 */
export const DECISION_FACTS_CONTRACT_VERSION = 'decision-facts 1.0.0'
export const DECISION_EVALUATE_CONTRACT_VERSION = 'decision-evaluate 1.0.0'
export const DECISION_RECORD_CONTRACT_VERSION = 'decision-record 1.0.0'

/** 决策工具名（allow-once 闸门绑定 + 调试口径）。 */
const DECISION_TOOL_NAME = 'recruitment_decision_record'
/** 初筛评估工具名（只读；approval 不适用，见文件头偏差 2）。 */
const SCREENING_EVALUATE_TOOL_NAME = 'recruitment_screening_evaluate'

/** 允许调用写动作的受控 alias（与 `actions.ts` 同口径：招聘/决策只允许 recruiter）。 */
const WRITE_ALLOWED_ALIASES: readonly DemoActorAlias[] = ['recruiter']

/** 客户端**不许**提交的身份键（命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_BODY_KEYS = [
  'actor_id',
  'tenant_id',
  'actor',
  'tenant',
  'alias',
  'actor_alias',
  'decided_by_actor_id',
  'confirmed_by_actor_id',
  'created_by_actor_id',
  'approved_by_actor_id',
  'submitted_by_actor_id',
] as const

/** 决策端点额外禁止由服务端派生的键（与 `actions.ts` 同口径）。 */
const DECISION_DERIVED_BODY_KEYS = [
  'human_confirmation',
  'approval_id',
  'stage_code',
  'decided_at',
  'status',
  'decision_id',
  'superseded_by_decision_id',
] as const

/**
 * facade 明确拒绝的「客户端 hash/digest」键：前端不得传 hash/digest，
 * 由服务端从 facts / summarize 组装（命中即 400 `SERVER_DERIVED_REJECTED`，零写入）。
 */
const SERVER_DERIVED_BODY_KEYS = [
  'basis_refs',
  'summary_digest',
  'evaluation_digest',
  'evaluation_id',
  'rubric_version_id',
  'rubric_payload_hash',
  'resume_version_id',
  'resume_content_sha256',
  'payload_hash',
  'content_sha256',
  'confirmed_at',
  'confirmation_method',
  'confirmation_text_sha256',
] as const

/** 客户端**不许**覆盖的身份查询键 / 头（与 actions 同口径）。 */
const ACTOR_OVERRIDE_QUERY_KEYS = ['actor_id', 'tenant_id'] as const
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const

/** facts 允许的查询键（其余 400 UNKNOWN_PARAM）。 */
const FACTS_QUERY_KEYS = ['application_id'] as const
/** evaluate body 封闭键集（契约 §2）。 */
const EVALUATE_BODY_KEYS = ['application_id', 'as_of'] as const
/** record facade body 封闭键集（契约 §3 + STAGE 扩展 `interview_id`，见文件头偏差 3）。 */
const RECORD_BODY_KEYS = ['application_id', 'decision_scope', 'result', 'reason', 'as_of', 'interview_id'] as const

/** 请求体上限 64 KiB（超限 413，零写入）。 */
const MAX_BODY_BYTES = 64 * 1024

/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 契约错误的 HTTP 映射（与 `actions.ts` / `actor.ts` 同口径；未列出的一律 500，不猜 200）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  FORBIDDEN: 403,
  DECISION_REQUIRES_HUMAN: 403,
  NOT_FOUND: 404,
  ALREADY_DECIDED: 409,
  VERSION_CONFLICT: 409,
  SCORECARD_MISSING: 409,
  BLOCKED: 409,
  BLOCKED_BY_REVIEW: 409,
  NO_RUBRIC: 409,
  NO_TRANSCRIPT: 409,
  SUMMARY_STALE: 409,
  EVIDENCE_INSUFFICIENT: 422,
  INVALID_REFERENCE: 400,
  NOT_CONFIGURED: 503,
  DEMO_ACTOR_UNMAPPED: 409,
  DB_CONSTRAINT_VIOLATION: 500,
  INVARIANT_VIOLATION: 500,
  READER_FAILED: 500,
}

/** 初筛评估的 verdict 封闭集（`screening-rules.md §5`；**不是**决策 result）。 */
const SCREENING_VERDICTS = ['PASS', 'FAIL', 'NEEDS_REVIEW'] as const
/** 决策 result 封闭集（契约 §3：ADVANCE / HOLD / REJECT；WITHDRAW 不在 facade 面）。 */
const RECORD_RESULTS = ['ADVANCE', 'HOLD', 'REJECT'] as const
/** 决策 scope（契约 §3；SCREENING 走既有 `/recruitment/api/action/screening/decide`）。 */
const RECORD_SCOPES = ['STAGE', 'FINAL'] as const

// =====================================================================
//  宿主上下文 / 依赖（形状与 http/actor.ts、http/actions.ts 同窄接口）
// =====================================================================

/** 宿主侧用到的 `webServer` 最小面（与 overview / actor / actions 同形）。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 宿主上下文（`src/index.ts` 把 cordis Context 窄成这个形状再传进来）。 */
export interface DecisionHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 路由依赖：与工具 / `http/actor.ts` **共享**的 Demo Actor 身份（session→alias 单例）。 */
export interface DecisionHttpDeps {
  /** 已解析的数据库配置；`null` = 未配置（路由仍注册，返回 503，不假装成功）。 */
  readonly database: ResolvedDatabaseConfig | null
  /** `database === null` 时缺失的配置项（只含变量名，不含密码）。 */
  readonly databaseIssues: readonly string[]
  /** session → alias 注册表 + alias → HUMAN actor 映射（由 `src/index.ts` 持有单例）。 */
  readonly identity: DemoActorIdentity
}

// =====================================================================
//  纯函数（可单测）：facts 事实形状 / basis 组装 / 内容寻址 id
// =====================================================================

/** 一条 rubric 维度（facts.rubric.dimensions 的元素）。 */
export interface FactsRubricDimension {
  readonly key: string
  readonly label: string
  readonly weight: number | null
  /** MUST_HAVE / DISQUALIFIER 视为 required；NICE_TO_HAVE 不是。 */
  readonly required: boolean
  readonly kind: string | null
}

/** facts.missing[] 的一条（缺什么、为什么；UI 只在**没有被列出的**键上启用按钮）。 */
export interface FactsMissingEntry {
  readonly key: string
  readonly reason: string
}

/** facts.authority（当前 session 绑定的 HUMAN 决策人 + 服务端计算的 is_hiring_manager）。 */
export interface FactsAuthority {
  readonly actor_id: string
  readonly alias: string
  readonly display_name: string
  readonly roles: ReadonlyArray<string>
  readonly is_hiring_manager: boolean
}

/**
 * facts.screening_evaluation 的形状。
 *
 * 注意：**不是**决策 result；`verdict` 是 `recruitment_screening_evaluate` 的
 * `PASS / FAIL / NEEDS_REVIEW`。`evaluation_id` 是内容寻址派生标识（见文件头偏差 1），
 * `persisted` / `source` 如实说明它来自哪里。
 */
export interface FactsScreeningEvaluation {
  readonly evaluation_id: string
  readonly evaluation_id_kind: string
  readonly evaluation_digest: string
  readonly verdict: string
  readonly rubric_version_id: string
  readonly rubric_payload_hash: string
  readonly resume_version_id: string
  readonly resume_content_sha256: string
  readonly as_of: string | null
  readonly criteria_evaluated: ReadonlyArray<Record<string, unknown>>
  readonly criteria_evaluated_flag: boolean
  readonly counts: Readonly<Record<string, unknown>>
  readonly provenance: unknown
  readonly source: string
  readonly persisted: boolean
  /** 只有在 persisted=true 时才有：那条 SCREENING decision 的 id。 */
  readonly decision_id?: string
}

/** `assembleFactsBasis` 的输入（全部来自 DB/domain 事实，调用方不传 hash）。 */
export interface FactsBasisInput {
  readonly rubric: { readonly id: string | null; readonly payload_hash: string | null }
  readonly authority: FactsAuthority | null
  readonly screeningEvaluation: FactsScreeningEvaluation | null
  readonly evaluationSummary: { readonly as_of: string; readonly summary_digest: string } | null
  readonly scorecards?: ReadonlyArray<unknown>
  /** missing 里的可选人话原因（例如现场评估的领域错误）。 */
  readonly screeningEvaluationReason?: string
  readonly summaryReason?: string
}

/** facts.basis（W2b 直接拿去构造 screening/decide 与 decision/record 的表单事实）。 */
export interface FactsBasis {
  readonly screening_decide: {
    readonly rubric_version: { readonly id: string; readonly payload_hash: string }
    readonly authority: { readonly actor_id: string; readonly is_hiring_manager: boolean }
    readonly screening_evaluation: {
      readonly evaluation_id: string
      readonly evaluation_digest: string
      readonly verdict: string
    } | null
  } | null
  readonly decision_record: {
    readonly as_of: string
    readonly summary_digest: string
    readonly rubric_version: { readonly id: string; readonly payload_hash: string }
    readonly authority: { readonly actor_id: string; readonly is_hiring_manager: boolean }
    readonly scorecards: ReadonlyArray<unknown>
  } | null
}

/** `buildRecordBasisRefs` 里一条 SCORECARD 依据（来自库行，不是客户端）。 */
export interface RecordScorecardRef {
  readonly id: string
  readonly overall: string
  readonly transcript_basis: string
  readonly transcript_state: string
  readonly revision_no?: number
  readonly interviewer_id?: string
  readonly payload_hash?: string
}

/** 64 位小写 hex 判据（digest / payload_hash）。 */
export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** `unknown` → 普通对象；不是对象就给 null（不把数组/标量当对象）。 */
function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `unknown` → 普通对象（工具输出必是对象；否则按空对象兜底，不冒充字段）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return asOptionalRecord(value) ?? {}
}

/** jsonb 列兼容（pg 正常返回对象/数组；字符串形态也有历史数据）。 */
function parseJsonb(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

/** 非空字符串（trim 后）。 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 数值（有限数）。 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

/**
 * rubric dimensions（jsonb）→ facts.rubric.dimensions 的契约形状。
 * 只投影业务键；非法条目跳过（不编造 key/label/weight）。
 * @param dimensions - `rubric_version.dimensions`（数组或 JSON 字符串）。
 */
export function mapRubricDimensions(dimensions: unknown): ReadonlyArray<FactsRubricDimension> {
  const parsed = parseJsonb(dimensions)
  if (!Array.isArray(parsed)) return []
  const out: FactsRubricDimension[] = []
  for (const entry of parsed) {
    const raw = asOptionalRecord(entry)
    if (raw === null) continue
    const key = nonEmptyString(raw.key)
    if (key === null) continue
    const label = nonEmptyString(raw.label) ?? key
    const weight = finiteNumber(raw.weight)
    const kind = nonEmptyString(raw.kind)
    out.push({ key, label, weight, required: kind !== 'NICE_TO_HAVE', kind })
  }
  return out
}

/**
 * 由**真实的** evaluation_digest 派生内容寻址 id（UUID 形态，确定性）。
 *
 * 为什么不是库 id：`screening_evaluation` 没有表、评估是瞬态投影（文件头偏差 1）。
 * 这里不做任何随机；同 digest → 同 id，不同 digest → 不同 id（单测覆盖）。
 * @param evaluationDigest - `recruitment_screening_evaluate` 输出的 64 hex digest。
 */
export function deriveEvaluationId(evaluationDigest: string): string {
  const hex = createHash('sha256')
    .update(`recruitment:screening-evaluation:${evaluationDigest}`)
    .digest('hex')
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** 把工具输出的 reasons/bonus_signals 投影成 `criteria_evaluated[]`（只给业务字段）。 */
function criteriaEvaluatedOf(output: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
  const rows: Record<string, unknown>[] = []
  for (const [group, value] of [['REASON', output.reasons], ['BONUS', output.bonus_signals]] as const) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      const raw = asOptionalRecord(entry)
      if (raw === null) continue
      const criterionKey = nonEmptyString(raw.criterion_key)
      rows.push({
        source: group,
        ...(criterionKey === null ? {} : { criterion_key: criterionKey }),
        ...(nonEmptyString(raw.kind) === null ? {} : { kind: raw.kind }),
        ...(nonEmptyString(raw.outcome) === null ? {} : { outcome: raw.outcome }),
        ...(nonEmptyString(raw.failure_class) === null ? {} : { failure_class: raw.failure_class }),
        ...(nonEmptyString(raw.code) === null ? {} : { code: raw.code }),
      })
    }
  }
  return rows
}

/** 由工具输出的 reasons/bonus_signals/warnings 派生计数（事实的聚合，不是新结论）。 */
function countsOf(output: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const reasons = Array.isArray(output.reasons) ? output.reasons.map(asRecord) : []
  const bonus = Array.isArray(output.bonus_signals) ? output.bonus_signals.map(asRecord) : []
  const warnings = Array.isArray(output.warnings) ? output.warnings : []
  const outcomeOf = (row: Record<string, unknown>): string | null => nonEmptyString(row.outcome)
  return {
    reasons: reasons.length,
    bonus_signals: bonus.length,
    warnings: warnings.length,
    must_have: reasons.filter((row) => row.kind === 'MUST_HAVE').length,
    disqualifier: reasons.filter((row) => row.kind === 'DISQUALIFIER').length,
    satisfied: [...reasons, ...bonus].filter((row) => outcomeOf(row) === 'SATISFIED').length,
    unsatisfied: [...reasons, ...bonus].filter((row) => outcomeOf(row) === 'UNSATISFIED').length,
    needs_judgment: [...reasons, ...bonus].filter((row) => outcomeOf(row) === 'NEEDS_JUDGMENT').length,
    indeterminate: [...reasons, ...bonus].filter((row) => outcomeOf(row) === 'INDETERMINATE').length,
  }
}

/**
 * `recruitment_screening_evaluate` 的输出 → facts.screening_evaluation。
 *
 * 只搬运 domain 已算好的事实（digest / verdict / snapshot hash），**不重算、不编造**；
 * 形状不完整（缺 digest 或 snapshot 绑定）→ null（调用方进 missing[]）。
 * @param output - 工具原始输出（未 strip 的对象）。
 * @param options - `asOf`：本次评估请求用的 as_of（工具输出缺省 as_of 时用它）。
 */
export function mapScreeningEvaluationFromToolOutput(
  output: Record<string, unknown>,
  options: { readonly asOf?: string | null } = {},
): FactsScreeningEvaluation | null {
  const digest = nonEmptyString(output.evaluation_digest)
  const verdict = nonEmptyString(output.verdict)
  const snapshot = asOptionalRecord(output.snapshot)
  if (digest === null || verdict === null || snapshot === null) return null
  if (!(SCREENING_VERDICTS as readonly string[]).includes(verdict)) return null
  const rubricVersionId = nonEmptyString(snapshot.rubric_version_id)
  const rubricPayloadHash = nonEmptyString(snapshot.rubric_payload_hash)
  const resumeVersionId = nonEmptyString(snapshot.resume_version_id)
  const resumeContentSha256 = nonEmptyString(snapshot.resume_content_sha256)
  if (
    rubricVersionId === null
    || rubricPayloadHash === null
    || resumeVersionId === null
    || resumeContentSha256 === null
  ) {
    return null
  }
  return {
    evaluation_id: deriveEvaluationId(digest),
    evaluation_id_kind: 'DERIVED_FROM_EVALUATION_DIGEST',
    evaluation_digest: digest,
    verdict,
    rubric_version_id: rubricVersionId,
    rubric_payload_hash: rubricPayloadHash,
    resume_version_id: resumeVersionId,
    resume_content_sha256: resumeContentSha256,
    as_of: options.asOf ?? nonEmptyString(output.as_of),
    criteria_evaluated: criteriaEvaluatedOf(output),
    criteria_evaluated_flag: output.criteria_evaluated === true,
    counts: countsOf(output),
    provenance: asOptionalRecord(output.labels) ?? output.labels ?? null,
    source: 'SCREENING_EVALUATE_LIVE',
    persisted: false,
  }
}

/**
 * 当前 SCREENING decision 的 `basis_refs[SCREENING_EVALUATION]` → facts.screening_evaluation。
 *
 * 这条分片是 S7 评估的**唯一持久化载体**（screening-rules §11 D-3/P-1）。缺必填键 → null
 * （宁可 missing 也不编造 digest）。
 * @param ref - basis_refs 里 kind=SCREENING_EVALUATION 的对象。
 * @param decision - 该 decision 的 id / 时间（用于 `decision_id` 与 `as_of` 标注）。
 */
export function mapScreeningEvaluationFromPersistedBasis(
  ref: Record<string, unknown>,
  decision: { readonly decision_id: string; readonly decided_at?: string | null },
): FactsScreeningEvaluation | null {
  const digest = nonEmptyString(ref.evaluation_digest)
  const verdict = nonEmptyString(ref.verdict)
  const rubricVersionId = nonEmptyString(ref.rubric_version_id)
  const rubricPayloadHash = nonEmptyString(ref.rubric_payload_hash)
  const resumeVersionId = nonEmptyString(ref.resume_version_id)
  const resumeContentSha256 = nonEmptyString(ref.resume_content_sha256)
  if (
    digest === null
    || verdict === null
    || rubricVersionId === null
    || rubricPayloadHash === null
    || resumeVersionId === null
    || resumeContentSha256 === null
  ) {
    return null
  }
  return {
    evaluation_id: deriveEvaluationId(digest),
    evaluation_id_kind: 'DERIVED_FROM_EVALUATION_DIGEST',
    evaluation_digest: digest,
    verdict,
    rubric_version_id: rubricVersionId,
    rubric_payload_hash: rubricPayloadHash,
    resume_version_id: resumeVersionId,
    resume_content_sha256: resumeContentSha256,
    as_of: nonEmptyString(decision.decided_at),
    criteria_evaluated: [],
    criteria_evaluated_flag: ref.criteria_evaluated === true,
    counts: asOptionalRecord(ref.counts) ?? {},
    provenance: nonEmptyString(ref.provenance),
    source: 'SCREENING_DECISION_BASIS',
    persisted: true,
    decision_id: decision.decision_id,
  }
}

/**
 * facts.basis：只在事实齐全的范围内给出可执行依据；缺什么进 missing[]（UI 据此禁用）。
 *
 * 门禁口径（契约 §1 + 既有写侧）：
 *   * `basis.screening_decide`：`rubric.payload_hash` + `authority` 齐全才给；ADVANCE/REJECT 还需
 *     `screening_evaluation` 非空（此处 null + missing 说明，UI 只在没有该 missing 时启用）。
 *   * `basis.decision_record`：S10 汇总（as_of + summary_digest）+ rubric + authority 齐全才给。
 * @param input - 全部来自 DB/domain 的事实。
 */
export function assembleFactsBasis(input: FactsBasisInput): {
  readonly basis: FactsBasis
  readonly missing: ReadonlyArray<FactsMissingEntry>
} {
  const missing: FactsMissingEntry[] = []
  const rubricOk = input.rubric.id !== null && isHex64(input.rubric.payload_hash)
  const authorityOk = input.authority !== null
    && nonEmptyString(input.authority.actor_id) !== null
    && typeof input.authority.is_hiring_manager === 'boolean'
  if (!rubricOk) {
    missing.push({
      key: 'rubric_version',
      reason: '申请未钉住可用的 Rubric 版本（缺 rubric_version_id 或 64hex payload_hash）',
    })
  }
  if (!authorityOk) {
    missing.push({ key: 'authority', reason: '当前 Session 未解析出可追责的 HUMAN 决策人' })
  }
  const evaluation = input.screeningEvaluation
  if (evaluation === null) {
    missing.push({
      key: 'screening_evaluation',
      reason: input.screeningEvaluationReason ?? '尚未有可用的初筛评估事实（执行初筛评估后才产生真实 digest）',
    })
  }
  const summary = input.evaluationSummary
  if (summary === null) {
    missing.push({
      key: 'summary',
      reason: input.summaryReason ?? 'S10 汇总不可用（evaluation_summarize 只读投影没有返回 as_of/summary_digest）',
    })
  }
  const rubricBinding = rubricOk
    ? { id: input.rubric.id as string, payload_hash: input.rubric.payload_hash as string }
    : null
  const authorityBinding = authorityOk
    ? { actor_id: input.authority?.actor_id as string, is_hiring_manager: input.authority?.is_hiring_manager === true }
    : null
  const screeningDecide = rubricBinding !== null && authorityBinding !== null
    ? {
        rubric_version: rubricBinding,
        authority: authorityBinding,
        screening_evaluation: evaluation === null
          ? null
          : {
              evaluation_id: evaluation.evaluation_id,
              evaluation_digest: evaluation.evaluation_digest,
              verdict: evaluation.verdict,
            },
      }
    : null
  const decisionRecord = rubricBinding !== null && authorityBinding !== null && summary !== null
    ? {
        as_of: summary.as_of,
        summary_digest: summary.summary_digest,
        rubric_version: rubricBinding,
        authority: authorityBinding,
        scorecards: input.scorecards ?? [],
      }
    : null
  return { basis: { screening_decide: screeningDecide, decision_record: decisionRecord }, missing }
}

/**
 * 服务端组装 `recruitment_decision_record` 的 `basis_refs`（S10：SUMMARY / RUBRIC_VERSION /
 * AUTHORITY / SCORECARD）。
 *
 * **前端不传 hash**：这些值全部来自服务端事实；缺 summary digest / rubric payload_hash 直接抛错
 * （facade 转 400 `MISSING_SUMMARY`，绝不猜一个 digest）。
 * @param input - 服务端事实（summary 重算值 + 库里的 rubric / authority / scorecards）。
 */
export function buildRecordBasisRefs(input: {
  readonly summaryDigest: string
  readonly asOf: string
  readonly rubric: { readonly id: string; readonly payload_hash: string }
  readonly authority: { readonly actor_id: string; readonly is_hiring_manager: boolean }
  readonly scorecards?: ReadonlyArray<RecordScorecardRef>
}): Array<Record<string, unknown>> {
  if (!isHex64(input.summaryDigest)) {
    throw new Error('MISSING_SUMMARY: 服务端没有可用的 summary_digest（拒绝让客户端提供或伪造）')
  }
  if (!isHex64(input.rubric.payload_hash)) {
    throw new Error('MISSING_RUBRIC_PAYLOAD_HASH: 申请钉住的 Rubric 版本没有 64hex payload_hash')
  }
  const refs: Array<Record<string, unknown>> = [
    { kind: 'SUMMARY', summary_digest: input.summaryDigest },
    { kind: 'RUBRIC_VERSION', id: input.rubric.id, payload_hash: input.rubric.payload_hash },
    { kind: 'AUTHORITY', actor_id: input.authority.actor_id, is_hiring_manager: input.authority.is_hiring_manager },
  ]
  for (const scorecard of input.scorecards ?? []) {
    refs.push({
      kind: 'SCORECARD',
      id: scorecard.id,
      overall: scorecard.overall,
      transcript_basis: scorecard.transcript_basis,
      transcript_state: scorecard.transcript_state,
      ...(scorecard.revision_no === undefined ? {} : { revision_no: scorecard.revision_no }),
      ...(scorecard.interviewer_id === undefined ? {} : { interviewer_id: scorecard.interviewer_id }),
      ...(scorecard.payload_hash === undefined ? {} : { payload_hash: scorecard.payload_hash }),
    })
  }
  return refs
}

// =====================================================================
//  HTTP 小工具（封闭错误信封：`{error:{code,reason_code,message,detail?}}`）
// =====================================================================

/** 本文件自己产生的、可直接返回的 HTTP 问题（不经过域错误映射）。 */
class DecisionHttpProblem extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'DecisionHttpProblem'
    this.status = status
    this.body = body
  }
}

/** 造一个契约形状的 HTTP 问题。 */
function decisionHttpError(
  status: number,
  code: string,
  reasonCode: string,
  message: string,
  detail?: unknown,
): DecisionHttpProblem {
  return new DecisionHttpProblem(status, {
    error: { code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) },
  })
}

/** 写 JSON 响应（固定 no-store + nosniff；防重复写头）。 */
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/** 405（带 allow）。 */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(405, { allow, ...NO_STORE })
  res.end()
}

/** 读请求体（上限 64 KiB；超限 413）。 */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number.isFinite(Number(declared)) && Number(declared) > limit) {
    throw decisionHttpError(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > limit) {
      throw decisionHttpError(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Content-Type 必须是 JSON（允许带 charset）。 */
function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().split(';')[0]?.trim() === 'application/json'
}

/** 读 JSON 请求体 → 普通对象（415/413/400 的封闭映射；不做业务校验）。 */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw decisionHttpError(
      415,
      'INVALID_ARGS',
      'UNSUPPORTED_MEDIA_TYPE',
      '请求体必须是 Content-Type: application/json',
      { got: req.headers['content-type'] ?? '' },
    )
  }
  const text = await readBody(req, MAX_BODY_BYTES)
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    throw decisionHttpError(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body' })
  }
  return raw as Record<string, unknown>
}

/** 同源校验（**复用** `overview.ts::sameOrigin`；不能过就 403）。 */
function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw decisionHttpError(
      403,
      'FORBIDDEN',
      'SAME_ORIGIN_REQUIRED',
      '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）',
    )
  }
}

/** 拒绝 query / header 上的身份覆盖。**不碰 DB**。 */
function rejectQueryOrHeaderOverrides(req: IncomingMessage, url: URL): void {
  const rejected: string[] = []
  for (const key of ACTOR_OVERRIDE_QUERY_KEYS) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  }
  if (rejected.length > 0) {
    throw decisionHttpError(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
      { rejected },
    )
  }
}

/** 拒绝 body 里的身份/服务端派生键（命中即 400，**零写入**）。 */
function rejectBodyKeys(
  body: Record<string, unknown>,
  keys: readonly string[],
  reasonCode: string,
  message: string,
): void {
  const rejected = keys.filter((key) => Object.hasOwn(body, key)).sort()
  if (rejected.length > 0) {
    throw decisionHttpError(400, 'INVALID_ARGS', reasonCode, message, { rejected })
  }
}

/** 拒绝封闭键集之外的键（400 UNKNOWN_PARAM）。 */
function rejectUnknownBodyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key)).sort()
  if (unknown.length > 0) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'UNKNOWN_PARAM', '请求体包含未定义的键', {
      unknown_keys: unknown,
      allowed,
    })
  }
}

/** 拒绝封闭查询键集之外的键（400 UNKNOWN_PARAM）。 */
function rejectUnknownQueryKeys(url: URL, allowed: readonly string[]): void {
  const unknown: string[] = []
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) unknown.push(key)
  }
  if (unknown.length > 0) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'UNKNOWN_PARAM', '查询串包含未定义的键', {
      unknown_keys: [...new Set(unknown)].sort(),
      allowed,
    })
  }
}

/** 读 `X-DSH-Session` 头并归一化（身份**有且只有**这个头）。 */
function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw decisionHttpError(
      400,
      'INVALID_ARGS',
      raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined
        ? '缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）'
        : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID',
    )
  }
  return normalized
}

/** session → alias → actor（未绑定 / 别名无映射 → 409 `DEMO_ACTOR_UNMAPPED`，零写入）。 */
function requireBoundActor(identity: DemoActorIdentity, sessionId: string): ResolvedExecutionActor {
  return resolveSessionActor(identity, sessionId)
}

/** 写动作 alias 闸门（只允许 recruiter；越权 403，零写入）。 */
function assertWriteAlias(resolved: ResolvedExecutionActor, action: string): void {
  if ((WRITE_ALLOWED_ALIASES as readonly string[]).includes(resolved.alias)) return
  throw decisionHttpError(
    403,
    'FORBIDDEN',
    'ACTOR_NOT_AUTHORIZED',
    `当前身份（${resolved.alias}）无权执行该决策写动作（只允许 ${WRITE_ALLOWED_ALIASES.join(', ')}）`,
    { action, alias: resolved.alias, allowed_aliases: [...WRITE_ALLOWED_ALIASES] },
  )
}

/** 把领域错误消息 `<CODE>: <compact-json>` 解析成可读事实（不丢 code/reason_code）。 */
function describeDomainError(error: unknown): { code: string; reason_code: string | null; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    const prefix = message.slice(0, index)
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      return {
        code: typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : prefix,
        reason_code: typeof parsed.reason_code === 'string' ? parsed.reason_code : null,
        message: typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message,
      }
    } catch {
      // 不是产品错误形态：按最小形状兜底。
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'INTERNAL'
  return { code, reason_code: null, message }
}

/** 把任意错误翻成 HTTP 状态 + 封闭错误信封（优先解析产品错误消息 `CODE: <compact-json>`）。 */
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof DecisionHttpProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    const prefix = message.slice(0, index)
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : prefix
      const body: Record<string, unknown> = { code }
      if (typeof parsed.reason_code === 'string' && parsed.reason_code !== '') body.reason_code = parsed.reason_code
      body.message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message
      if (parsed.detail !== undefined) body.detail = parsed.detail
      return { status: STATUS_BY_CODE[code] ?? 500, body: { error: body } }
    } catch {
      // 不是产品错误形态：下面按最小形状兜底。
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'INTERNAL'
  return {
    status: STATUS_BY_CODE[code] ?? 500,
    body: { error: { code, reason_code: 'UNEXPECTED', message } },
  }
}

/** 路由处理函数的统一错误边界（每条路径都有 JSON 错误体，不把异常抛进宿主事件循环）。 */
function guard(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }
}

/** 未配置库时的 503（含缺失项；只含变量名，不含密码）。 */
function requireDatabase(deps: DecisionHttpDeps): ResolvedDatabaseConfig {
  if (deps.database === null) {
    throw decisionHttpError(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，决策入口不可用', {
      issues: [...deps.databaseIssues],
    })
  }
  return deps.database
}

/** 在一个短连接池上执行 `fn`（HTTP 请求级；finally 关池，避免空闲 socket 挂住宿主）。 */
async function withPool<T>(
  cfg: ResolvedDatabaseConfig,
  fn: (pool: DatabasePool) => Promise<T>,
): Promise<T> {
  const pool = createPool(cfg)
  try {
    return await fn(pool)
  } finally {
    await closePool(pool)
  }
}

/** 一次执行者输出（与 actions 同口径：`exec.agent.id` = 当前 session）。 */
function execOf(resolved: ResolvedExecutionActor): Record<string, unknown> {
  return {
    agent: { id: resolved.session_id },
    headers: { [DEMO_SESSION_HEADER]: resolved.session_id },
  }
}

/** 成功响应里的 actor 段。 */
function actorEnvelope(resolved: ResolvedExecutionActor): Record<string, unknown> {
  return { session_id: resolved.session_id, alias: resolved.alias, actor_id: resolved.actor_id }
}

// =====================================================================
//  一次性 allow-once approval（人类点击等价；单次请求内只放行一次）
// =====================================================================

interface ApprovalRequestShape {
  readonly agent?: unknown
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

interface AllowOnceGate {
  readonly approval: { request(req: ApprovalRequestShape): Promise<string> }
  summary(): { readonly requested: number; readonly result: string; readonly tool_names: readonly string[] }
}

/**
 * 造一个只属于本次 HTTP 请求的 allow-once 批准通道（与 `actions.ts` 同一语义）。
 * 第一次请求（且 toolName 一致）→ `allowed-once`；之后 → `rejected`；toolName 不符 → `unavailable`。
 * @param expectedToolName - 该动作复用工具的工具名（防串线）。
 */
function createAllowOnceGate(expectedToolName: string): AllowOnceGate {
  let requested = 0
  const toolNames: string[] = []
  let result = 'not-requested'
  return {
    approval: {
      async request(req: ApprovalRequestShape): Promise<string> {
        requested += 1
        toolNames.push(req.toolName)
        if (requested > 1) {
          result = 'rejected'
          return 'rejected'
        }
        if (req.toolName !== expectedToolName) {
          result = 'unavailable'
          return 'unavailable'
        }
        result = 'allowed-once'
        return 'allowed-once'
      },
    },
    summary() {
      return { requested, result, tool_names: [...toolNames] }
    },
  }
}

// =====================================================================
//  数据库行形状 / SQL（全部只读、参数化；租户一律来自服务端配置）
// =====================================================================

/** 申请 + 岗位 + 钉住的 job_version/rubric + 部门 hiring manager（facts / record 共用）。 */
interface ApplicationFactsRow {
  application_id: string
  lifecycle_status: string
  current_stage_code: string
  record_version: number
  job_version_id: string
  application_rubric_version_id: string | null
  candidate_display_name: string
  job_id: string
  job_code: string
  job_title: string
  job_status: string
  current_job_version_id: string | null
  current_rubric_version_id: string | null
  job_version_no: number | null
  job_payload_hash: string | null
  rubric_version_no: number | null
  rubric_payload_hash: string | null
  rubric_dimensions: unknown
  hiring_manager_actor_id: string | null
}

const APPLICATION_FACTS_SQL = `
  select a.id::text                            as application_id,
         a.lifecycle_status                    as lifecycle_status,
         a.current_stage_code                  as current_stage_code,
         a.record_version                      as record_version,
         a.job_version_id::text                as job_version_id,
         a.rubric_version_id::text             as application_rubric_version_id,
         c.display_name                        as candidate_display_name,
         j.id::text                            as job_id,
         j.code                                as job_code,
         j.title                               as job_title,
         j.status                              as job_status,
         j.current_job_version_id::text        as current_job_version_id,
         j.current_rubric_version_id::text     as current_rubric_version_id,
         jv.version_no                         as job_version_no,
         jv.payload_hash                       as job_payload_hash,
         rv.version_no                         as rubric_version_no,
         rv.payload_hash                       as rubric_payload_hash,
         rv.dimensions                         as rubric_dimensions,
         d.hiring_manager_actor_id::text       as hiring_manager_actor_id
    from recruitment.application a
    join recruitment.candidate c
      on c.id = a.candidate_id and c.tenant_id = a.tenant_id
    join recruitment.job j
      on j.id = a.job_id and j.tenant_id = a.tenant_id
    left join recruitment.department d
      on d.id = j.department_id and d.tenant_id = j.tenant_id
    left join recruitment.job_version jv
      on jv.id = a.job_version_id and jv.tenant_id = a.tenant_id
    left join recruitment.rubric_version rv
      on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id and rv.job_id = a.job_id
   where a.tenant_id = $1::uuid
     and a.id = $2::uuid
`

/** actor 行（HUMAN 校验用；不存在 → 调用方 409）。 */
interface ActorFactsRow {
  actor_id: string
  display_name: string
  kind: string
  status: string
}

const ACTOR_FACTS_SQL = `
  select a.id::text        as actor_id,
         a.display_name    as display_name,
         a.kind            as kind,
         a.status          as status
    from recruitment.actor a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/** actor 的角色标签（与 `recruiting.ts::ROLES_SQL` 同口径）。 */
const ACTOR_ROLES_SQL = `
  select r.code as code
    from recruitment.actor_role ar
    join recruitment.role r on r.id = ar.role_id and r.tenant_id = ar.tenant_id
   where ar.actor_id = $1::uuid and ar.tenant_id = $2::uuid and ar.revoked_at is null
   order by r.code asc
`

/** 当前有效的 SCREENING decision（唯一持久化 SCREENING_EVALUATION 的载体）。 */
interface PersistedScreeningRow {
  decision_id: string
  decided_at: Date | string
  basis_refs: unknown
}

const PERSISTED_SCREENING_SQL = `
  select d.id::text            as decision_id,
         d.decided_at          as decided_at,
         d.basis_refs          as basis_refs
    from recruitment.decision d
   where d.tenant_id = $1::uuid
     and d.application_id = $2::uuid
     and d.decision_scope = 'SCREENING'
     and d.superseded_by_decision_id is null
   order by d.decided_at desc, d.id desc
   limit 1
`

/** 面评行（facade 组装 SCORECARD 依据用；只读当前行）。 */
interface ScorecardFactsRow {
  scorecard_id: string
  interview_id: string
  interviewer_id: string
  rubric_version_id: string
  revision_no: number
  status: string
  overall: string | null
  payload_hash: string | null
  items: unknown
  rationale: string | null
}

const STAGE_SCORECARDS_SQL = `
  select s.id::text                  as scorecard_id,
         s.interview_id::text        as interview_id,
         s.interviewer_id::text      as interviewer_id,
         s.rubric_version_id::text   as rubric_version_id,
         s.revision_no               as revision_no,
         s.status                    as status,
         s.overall                   as overall,
         s.payload_hash              as payload_hash,
         s.items                     as items,
         s.rationale                 as rationale
    from recruitment.scorecard s
   where s.tenant_id = $1::uuid
     and s.superseded_by_scorecard_id is null
     and s.status in ('SUBMITTED', 'WAIVED')
     and s.interview_id = $2::uuid
   order by s.interviewer_id asc, s.id asc
`

const FINAL_SCORECARDS_SQL = `
  select s.id::text                  as scorecard_id,
         s.interview_id::text        as interview_id,
         s.interviewer_id::text      as interviewer_id,
         s.rubric_version_id::text   as rubric_version_id,
         s.revision_no               as revision_no,
         s.status                    as status,
         s.overall                   as overall,
         s.payload_hash              as payload_hash,
         s.items                     as items,
         s.rationale                 as rationale
    from recruitment.scorecard s
    join recruitment.interview iv
      on iv.id = s.interview_id and iv.tenant_id = s.tenant_id
   where s.tenant_id = $1::uuid
     and iv.application_id = $2::uuid
     and s.superseded_by_scorecard_id is null
     and s.status in ('SUBMITTED', 'WAIVED')
   order by s.interviewer_id asc, s.id asc
`

/**
 * 面试的转写状态（SCORECARD 依据的 `transcript_state` 只想如实取状态，不猜）。
 *
 * 2026-11-15 真 Host 500 修复：`transcript_artifact` **没有** `interview_id` 列
 * （`字段 ta.interview_id 不存在`，SQLSTATE 42703）。它与 interview 的正确关系有两条：
 *   * `interview_record.interview_id` → `interview_record.transcript_artifact_id`；
 *   * `meeting_binding.interview_id`（`unbound_at is null`）→ `meeting_binding.meeting_id`
 *     → `transcript_artifact.meeting_id`。
 * 这里按这两条真实关系取「面试 → artifact 状态」，一条都没有则该面试视为 `MISSING`（不编造 READY）。
 * 选取顺序：canonical 优先 → 最近 fetch/created 优先（与 `recruiting.ts::TRANSCRIPT_CANDIDATES_SQL` 同口径）。
 */
const TRANSCRIPT_STATE_SQL = `
  with artifact_links as (
    select ir.interview_id                                  as interview_id,
           ta.id                                            as artifact_id,
           ta.transcript_status                             as transcript_status,
           ta.is_canonical                                  as is_canonical,
           coalesce(ta.fetched_at, ta.created_at)           as linked_at
      from recruitment.interview_record ir
      join recruitment.transcript_artifact ta
        on ta.id = ir.transcript_artifact_id and ta.tenant_id = ir.tenant_id
     where ir.tenant_id = $1::uuid
       and ir.interview_id = any($2::uuid[])
    union all
    select mb.interview_id,
           ta.id,
           ta.transcript_status,
           ta.is_canonical,
           coalesce(ta.fetched_at, ta.created_at)
      from recruitment.meeting_binding mb
      join recruitment.transcript_artifact ta
        on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id
     where mb.tenant_id = $1::uuid
       and mb.interview_id = any($2::uuid[])
       and mb.unbound_at is null
  )
  select distinct on (interview_id)
         interview_id::text   as interview_id,
         transcript_status    as status
    from artifact_links
   order by interview_id asc, is_canonical desc, linked_at desc, artifact_id asc
`

/** 写后独立读回（decision 没有 status 列：用 result + is_current 表达状态）。 */
interface DecisionReadbackRow {
  decision_id: string
  application_id: string
  interview_id: string | null
  decision_scope: string
  stage_code: string | null
  result: string
  record_version: number
  actor_id: string
  decided_at: Date | string
  is_current: boolean
  superseded_by_decision_id: string | null
}

const DECISION_READBACK_SQL = `
  select d.id::text                          as decision_id,
         d.application_id::text              as application_id,
         d.interview_id::text                as interview_id,
         d.decision_scope                    as decision_scope,
         d.stage_code                        as stage_code,
         d.result                            as result,
         d.record_version                    as record_version,
         d.decided_by_actor_id::text         as actor_id,
         d.decided_at                        as decided_at,
         (d.superseded_by_decision_id is null) as is_current,
         d.superseded_by_decision_id::text   as superseded_by_decision_id
    from recruitment.decision d
   where d.tenant_id = $1::uuid
     and d.application_id = $2::uuid
     and d.decision_scope = $3
   order by d.decided_at desc, d.created_at desc, d.id desc
   limit 1
`

/** 评估主体的独立 DB 读回（不拿工具输出当"库事实"）。 */
interface EvaluateSubjectRow {
  application_id: string
  job_id: string
  rubric_version_id: string | null
  rubric_payload_hash: string | null
  resume_version_id: string | null
  resume_content_sha256: string | null
  application_record_version: number
}

const EVALUATE_SUBJECT_SQL = `
  select a.id::text                 as application_id,
         a.job_id::text             as job_id,
         a.rubric_version_id::text  as rubric_version_id,
         rv.payload_hash            as rubric_payload_hash,
         a.resume_version_id::text  as resume_version_id,
         res.content_sha256         as resume_content_sha256,
         a.record_version           as application_record_version
    from recruitment.application a
    left join recruitment.rubric_version rv
      on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id
    left join recruitment.resume_version res
      on res.id = a.resume_version_id and res.tenant_id = a.tenant_id
   where a.tenant_id = $1::uuid
     and a.id = $2::uuid
`

/** ISO 字符串（timestamptz 只记得瞬时；统一 ISO 形态）。 */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  return null
}

/** 读申请事实行（不存在 → undefined）。 */
async function loadApplicationFacts(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationFactsRow | undefined> {
  const { rows } = await client.query<ApplicationFactsRow>(APPLICATION_FACTS_SQL, [tenantId, applicationId])
  return rows[0]
}

/** 读 actor 行 + 角色；非 HUMAN / 不存在 → 409（不静默回退配置 actor）。 */
async function loadAuthorityActor(
  client: DatabaseClient,
  tenantId: string,
  resolved: ResolvedExecutionActor,
): Promise<{
  display_name: string
  roles: ReadonlyArray<string>
}> {
  const { rows } = await client.query<ActorFactsRow>(ACTOR_FACTS_SQL, [resolved.actor_id, tenantId])
  const row = rows[0]
  if (row === undefined) {
    throw decisionHttpError(409, 'DEMO_ACTOR_UNMAPPED', 'ACTOR_NOT_FOUND', 'Session 绑定的 actor 在库里不存在', {
      actor_id: resolved.actor_id,
    })
  }
  if (row.kind !== 'HUMAN') {
    throw decisionHttpError(409, 'DEMO_ACTOR_UNMAPPED', 'ACTOR_NOT_HUMAN', 'Session 绑定的 actor 不是 HUMAN', {
      actor_id: resolved.actor_id,
      kind: row.kind,
    })
  }
  const roleResult = await client.query<{ code: string }>(ACTOR_ROLES_SQL, [resolved.actor_id, tenantId])
  return { display_name: row.display_name, roles: roleResult.rows.map((entry) => entry.code) }
}

/** 读当前有效 SCREENING decision 的 SCREENING_EVALUATION 分片（无 → null）。 */
async function loadPersistedScreeningEvaluation(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<FactsScreeningEvaluation | null> {
  const { rows } = await client.query<PersistedScreeningRow>(PERSISTED_SCREENING_SQL, [tenantId, applicationId])
  const row = rows[0]
  if (row === undefined) return null
  const basis = parseJsonb(row.basis_refs)
  if (!Array.isArray(basis)) return null
  for (const ref of basis) {
    const raw = asOptionalRecord(ref)
    if (raw === null || raw.kind !== 'SCREENING_EVALUATION') continue
    const mapped = mapScreeningEvaluationFromPersistedBasis(raw, {
      decision_id: row.decision_id,
      decided_at: toIsoOrNull(row.decided_at),
    })
    if (mapped !== null) return mapped
  }
  return null
}

/** 读 scope 内的当前面评行（STAGE 一场 / FINAL 全申请）。 */
async function loadScopeScorecardRows(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  scope: 'STAGE' | 'FINAL',
  interviewId: string | null,
): Promise<ReadonlyArray<ScorecardFactsRow>> {
  if (scope === 'STAGE') {
    const { rows } = await client.query<ScorecardFactsRow>(STAGE_SCORECARDS_SQL, [tenantId, interviewId])
    return rows
  }
  const { rows } = await client.query<ScorecardFactsRow>(FINAL_SCORECARDS_SQL, [tenantId, applicationId])
  return rows
}

/** 读面试的转写状态映射（interview_id → status；无 artifact = MISSING）。 */
async function loadTranscriptStates(
  client: DatabaseClient,
  tenantId: string,
  interviewIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>()
  if (interviewIds.length === 0) return out
  const { rows } = await client.query<{ interview_id: string; status: string }>(
    TRANSCRIPT_STATE_SQL,
    [tenantId, [...interviewIds]],
  )
  for (const row of rows) {
    if (!out.has(row.interview_id)) out.set(row.interview_id, row.status)
  }
  return out
}

/**
 * 由库里的面评行组装 SCORECARD 依据（服务端事实；前端不传）。
 *
 * 只收「当前、版本一致、形状可用」的面评：与 `evaluation-summarize` 的判定同口径
 * （`scorecardShapeViolations` 是同一份导出函数），避免拿无效面评当依据。
 */
async function loadRecordScorecardRefs(
  client: DatabaseClient,
  tenantId: string,
  app: ApplicationFactsRow,
  scope: 'STAGE' | 'FINAL',
  interviewId: string | null,
): Promise<ReadonlyArray<RecordScorecardRef>> {
  const rows = await loadScopeScorecardRows(client, tenantId, app.application_id, scope, interviewId)
  const dimensionRows = mapRubricDimensions(app.rubric_dimensions)
  const dimensionKeys = dimensionRows.map((entry) => entry.key)
  const states = await loadTranscriptStates(client, tenantId, rows.map((row) => row.interview_id))
  const refs: RecordScorecardRef[] = []
  for (const row of rows) {
    if (app.application_rubric_version_id === null || row.rubric_version_id !== app.application_rubric_version_id) {
      continue
    }
    const items = parseJsonb(row.items)
    const overall = nonEmptyString(row.overall)
    const itemRecord = asOptionalRecord(items)
    const transcriptBasis = itemRecord === null ? null : nonEmptyString(itemRecord.transcript_basis)
    if (overall === null || transcriptBasis === null) continue
    if (transcriptBasis !== 'TRANSCRIPT' && transcriptBasis !== 'NO_TRANSCRIPT') continue
    if (row.status === 'SUBMITTED') {
      const shape = scorecardShapeViolations({
        rubricDimensionKeys: dimensionKeys,
        items,
        overall,
        rationale: row.rationale,
      })
      if (shape.violations.length > 0) continue
    }
    refs.push({
      id: row.scorecard_id,
      overall,
      transcript_basis: transcriptBasis,
      transcript_state: states.get(row.interview_id) ?? 'MISSING',
      revision_no: row.revision_no,
      interviewer_id: row.interviewer_id,
      ...(isHex64(row.payload_hash) ? { payload_hash: row.payload_hash } : {}),
    })
  }
  return refs
}

/** facts.evaluation_summary 的投影（service 从 summarize 只读投影取，不编造）。 */
export interface FactsEvaluationSummary {
  readonly available: boolean
  readonly as_of: string
  readonly summary_digest: string
  readonly warning_count: number
  readonly warnings: ReadonlyArray<{ readonly code: string; readonly message: string }>
  readonly source: string
  readonly decision_scope: string
  readonly ready_for_decision: boolean
  readonly permitted_results: ReadonlyArray<string>
  readonly blockers: ReadonlyArray<string>
  readonly coverage: Readonly<Record<string, number>>
}

/** 把 summarize 的只读投影投影成 facts.evaluation_summary（形状不全 → null）。 */
export function projectEvaluationSummary(raw: unknown): FactsEvaluationSummary | null {
  const record = asOptionalRecord(raw)
  if (record === null) return null
  const asOf = nonEmptyString(record.as_of)
  const digest = nonEmptyString(record.summary_digest)
  if (asOf === null || digest === null) return null
  const warnings: Array<{ code: string; message: string }> = []
  if (Array.isArray(record.warnings)) {
    for (const entry of record.warnings) {
      const warning = asOptionalRecord(entry)
      const code = warning === null ? null : nonEmptyString(warning.code)
      if (warning === null || code === null) continue
      warnings.push({ code, message: nonEmptyString(warning.message) ?? '' })
    }
  }
  const blockers: string[] = []
  if (Array.isArray(record.blockers)) {
    for (const entry of record.blockers) {
      const blocker = asOptionalRecord(entry)
      const code = blocker === null ? null : nonEmptyString(blocker.code)
      if (code !== null) blockers.push(code)
    }
  }
  const permitted: string[] = []
  if (Array.isArray(record.permitted_results)) {
    for (const entry of record.permitted_results) {
      if (typeof entry === 'string') permitted.push(entry)
    }
  }
  const coverageRaw = asOptionalRecord(record.coverage)
  const coverage: Record<string, number> = {}
  if (coverageRaw !== null) {
    for (const key of ['required_total', 'submitted', 'waived', 'missing', 'unusable', 'not_required', 'overdue'] as const) {
      const value = finiteNumber(coverageRaw[key])
      if (value !== null) coverage[key] = value
    }
  }
  return {
    available: true,
    as_of: asOf,
    summary_digest: digest,
    warning_count: warnings.length,
    warnings,
    source: 'EVALUATION_SUMMARIZE',
    decision_scope: nonEmptyString(record.decision_scope) ?? 'FINAL',
    ready_for_decision: record.ready_for_decision === true,
    permitted_results: permitted,
    blockers,
    coverage,
  }
}

/** 跑一次 S10 汇总（只读事务；GUC actor 由调用方先 set_config）。 */
async function runSummary(
  client: DatabaseClient,
  database: ResolvedDatabaseConfig,
  resolved: ResolvedExecutionActor,
  args: { application_id: string; decision_scope: 'STAGE' | 'FINAL'; interview_id?: string; as_of: string },
  nowMs: number,
): Promise<unknown> {
  await client.query("select set_config('recruitment.actor_id', $1, true)", [resolved.actor_id])
  return computeEvaluationSummaryIn(client, database, {
    application_id: args.application_id,
    decision_scope: args.decision_scope,
    ...(args.interview_id === undefined ? {} : { interview_id: args.interview_id }),
    as_of: args.as_of,
  }, nowMs)
}

// =====================================================================
//  GET /recruitment/api/decision/facts
// =====================================================================

/** facts 响应的形状（导出给单测/消费方判形态）。 */
export interface DecisionFactsResponse {
  readonly contract_version: string
  readonly application_id: string
  readonly stage_code: string
  readonly lifecycle_status: string
  readonly job: {
    readonly job_id: string
    readonly job_code: string
    readonly job_title: string
    readonly job_status: string
    readonly job_version_id: string
    readonly job_payload_hash: string | null
    readonly current_job_version_id: string | null
    readonly current_rubric_version_id: string | null
  }
  readonly rubric: {
    readonly rubric_version_id: string
    readonly version_no: number
    readonly payload_hash: string
    readonly dimensions: ReadonlyArray<FactsRubricDimension>
    readonly approved: boolean
  } | null
  readonly authority: FactsAuthority
  readonly screening_evaluation: FactsScreeningEvaluation | null
  /**
   * screening_evaluation 的可解释状态（W2b 用来区分「没有评估」与「不可计算」）：
   *   * `PERSISTED`      = 来自当前 SCREENING decision 的 basis 分片（唯一持久化载体）；
   *   * `LIVE_COMPUTED` = 现场只读评估算出（domain 真实输出；persisted=false）；
   *   * `UNAVAILABLE`   = 两者都拿不到，`missing[].reason` 以 `SCREENING_EVALUATION_UNAVAILABLE:` 开头并带领域原因。
   */
  readonly screening_evaluation_state: 'PERSISTED' | 'LIVE_COMPUTED' | 'UNAVAILABLE'
  readonly evaluation_summary: FactsEvaluationSummary | null
  /** `COMPUTED` / `UNAVAILABLE`（缺失原因以 `EVALUATION_SUMMARY_UNAVAILABLE:` 开头）。 */
  readonly evaluation_summary_state: 'COMPUTED' | 'UNAVAILABLE'
  readonly basis: FactsBasis
  readonly missing: ReadonlyArray<FactsMissingEntry>
  readonly readonly: true
}

/** 在只读事务里装配 facts（所有事实来自 DB/domain，缺就 missing）。 */
async function buildFacts(
  client: DatabaseClient,
  database: ResolvedDatabaseConfig,
  resolved: ResolvedExecutionActor,
  applicationId: string,
): Promise<DecisionFactsResponse> {
  const tenantId = database.tenant_id
  const app = await loadApplicationFacts(client, tenantId, applicationId)
  if (app === undefined) {
    throw decisionHttpError(404, 'NOT_FOUND', 'APPLICATION_NOT_FOUND', '该租户下没有这个申请', {
      application_id: applicationId,
    })
  }
  const actorFacts = await loadAuthorityActor(client, tenantId, resolved)
  const isHiringManager = app.hiring_manager_actor_id !== null
    && app.hiring_manager_actor_id.toLowerCase() === resolved.actor_id.toLowerCase()
  const authority: FactsAuthority = {
    actor_id: resolved.actor_id,
    alias: resolved.alias,
    display_name: actorFacts.display_name,
    roles: actorFacts.roles,
    is_hiring_manager: isHiringManager,
  }
  const nowMs = Date.now()
  const asOf = new Date(nowMs).toISOString()

  // ---- screening_evaluation：先持久化载体（S7 决策依据），否则现场只读评估 ----
  let screeningEvaluation = await loadPersistedScreeningEvaluation(client, tenantId, applicationId)
  let screeningEvaluationState: 'PERSISTED' | 'LIVE_COMPUTED' | 'UNAVAILABLE' = screeningEvaluation === null
    ? 'UNAVAILABLE'
    : 'PERSISTED'
  let screeningEvaluationReason: string | undefined
  if (screeningEvaluation === null) {
    try {
      const output = await evaluateInTransaction(client, database, {
        application_id: applicationId,
        as_of: asOf,
      }, nowMs)
      screeningEvaluation = mapScreeningEvaluationFromToolOutput(asRecord(output), { asOf })
      if (screeningEvaluation === null) {
        screeningEvaluationReason = 'SCREENING_EVALUATION_UNAVAILABLE: 初筛评估输出缺少 evaluation_digest / snapshot 绑定字段，不能当作事实'
      } else {
        screeningEvaluationState = 'LIVE_COMPUTED'
      }
    } catch (error) {
      const domain = describeDomainError(error)
      screeningEvaluationReason = 'SCREENING_EVALUATION_UNAVAILABLE: '
        + `${domain.code}${domain.reason_code === null ? '' : `/${domain.reason_code}`}: ${domain.message}`
    }
  }

  // ---- evaluation_summary：summarize 的只读投影（FINAL 口径） ----
  let evaluationSummary: FactsEvaluationSummary | null = null
  let summaryReason: string | undefined
  try {
    const rawSummary = await runSummary(client, database, resolved, {
      application_id: applicationId,
      decision_scope: 'FINAL',
      as_of: asOf,
    }, nowMs)
    evaluationSummary = projectEvaluationSummary(rawSummary)
    if (evaluationSummary === null) {
      summaryReason = 'EVALUATION_SUMMARY_UNAVAILABLE: evaluation_summarize 没有返回可用的 as_of/summary_digest（不编造）'
    }
  } catch (error) {
    const domain = describeDomainError(error)
    summaryReason = 'EVALUATION_SUMMARY_UNAVAILABLE: '
      + `${domain.code}${domain.reason_code === null ? '' : `/${domain.reason_code}`}: ${domain.message}`
  }

  const rubricOk = app.application_rubric_version_id !== null
    && isHex64(app.rubric_payload_hash)
    && app.rubric_version_no !== null
  const rubric = rubricOk
    ? {
        rubric_version_id: app.application_rubric_version_id as string,
        version_no: app.rubric_version_no as number,
        payload_hash: app.rubric_payload_hash as string,
        dimensions: mapRubricDimensions(app.rubric_dimensions),
        // 审批绑定在 rubric 行上（approval 指针非空）；facts 只做展示，philosophy 与写侧一致。
        approved: await isRubricApproved(client, tenantId, app.application_rubric_version_id as string),
      }
    : null
  const screeningDecideScorecards = await loadRecordScorecardRefs(
    client,
    tenantId,
    app,
    'FINAL',
    null,
  )
  const { basis, missing } = assembleFactsBasis({
    rubric: { id: rubric === null ? null : rubric.rubric_version_id, payload_hash: rubric === null ? null : rubric.payload_hash },
    authority,
    screeningEvaluation,
    evaluationSummary: evaluationSummary === null
      ? null
      : { as_of: evaluationSummary.as_of, summary_digest: evaluationSummary.summary_digest },
    scorecards: screeningDecideScorecards,
    screeningEvaluationReason,
    summaryReason,
  })
  const finalMissing: FactsMissingEntry[] = [...missing]
  if (app.job_payload_hash === null) {
    finalMissing.push({
      key: 'job_version',
      reason: '申请钉住的 job_version 行不存在或没有 64hex payload_hash',
    })
  }
  return {
    contract_version: DECISION_FACTS_CONTRACT_VERSION,
    application_id: app.application_id,
    stage_code: app.current_stage_code,
    lifecycle_status: app.lifecycle_status,
    job: {
      job_id: app.job_id,
      job_code: app.job_code,
      job_title: app.job_title,
      job_status: app.job_status,
      job_version_id: app.job_version_id,
      job_payload_hash: app.job_payload_hash,
      current_job_version_id: app.current_job_version_id,
      current_rubric_version_id: app.current_rubric_version_id,
    },
    rubric,
    authority,
    screening_evaluation: screeningEvaluation,
    screening_evaluation_state: screeningEvaluationState,
    evaluation_summary: evaluationSummary,
    evaluation_summary_state: evaluationSummary === null ? 'UNAVAILABLE' : 'COMPUTED',
    basis,
    missing: finalMissing,
    readonly: true,
  }
}

/** rubric 是否有生效的 APPROVED 审批（只读判定；与写侧同一判据的只读子集）。 */
async function isRubricApproved(
  client: DatabaseClient,
  tenantId: string,
  rubricVersionId: string,
): Promise<boolean> {
  // 口径统一到 `db/approval.ts`（O8）：含 payload_hash 对齐、未 supersede、未过期。
  return isRubricVersionApproved(client, tenantId, rubricVersionId)
}

/** `GET /recruitment/api/decision/facts` 的实现（路由层已做同源/方法校验）。 */
async function handleFacts(
  deps: DecisionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  rejectUnknownQueryKeys(url, FACTS_QUERY_KEYS)
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  const database = requireDatabase(deps)
  const rawId = url.searchParams.get('application_id')
  if (rawId === null || rawId.trim() === '') {
    throw decisionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填查询参数 "application_id"', {
      missing: ['application_id'],
    })
  }
  const applicationId = rawId.trim()
  if (!isUuid(applicationId)) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'application_id 必须是 UUID', {
      application_id: rawId.slice(0, 64),
    })
  }
  const facts = await withPool(database, (pool) => withReadOnly(pool, (client) => (
    buildFacts(client, database, resolved, applicationId)
  )))
  json(res, 200, facts)
}

// =====================================================================
//  POST /recruitment/api/decision/screening/evaluate
// =====================================================================

/** 评估主体的独立 DB 读回（另开连接；不拿工具输出当库事实）。 */
async function readEvaluateSubject(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<EvaluateSubjectRow> {
  const { rows } = await client.query<EvaluateSubjectRow>(EVALUATE_SUBJECT_SQL, [tenantId, applicationId])
  const row = rows[0]
  if (row === undefined) {
    throw decisionHttpError(404, 'NOT_FOUND', 'APPLICATION_NOT_FOUND', '该租户下没有这个申请', {
      application_id: applicationId,
    })
  }
  return row
}

/** `POST /recruitment/api/decision/screening/evaluate` 的实现。 */
async function handleScreeningEvaluate(
  deps: DecisionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  assertWriteAlias(resolved, 'screening/evaluate')
  const database = requireDatabase(deps)
  const body = await readJsonObject(req)
  rejectBodyKeys(
    body,
    ACTOR_OVERRIDE_BODY_KEYS,
    'ACTOR_OVERRIDE_REJECTED',
    'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33）',
  )
  rejectBodyKeys(
    body,
    SERVER_DERIVED_BODY_KEYS,
    'SERVER_DERIVED_REJECTED',
    'hash/digest/basis 由服务端从领域事实组装，不接受客户端传入',
  )
  rejectUnknownBodyKeys(body, EVALUATE_BODY_KEYS)
  const rawApplicationId = body.application_id
  if (rawApplicationId === undefined) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "application_id"', {
      missing: ['application_id'],
    })
  }
  if (typeof rawApplicationId !== 'string' || !isUuid(rawApplicationId)) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'application_id 必须是 UUID', {
      application_id: typeof rawApplicationId === 'string' ? rawApplicationId.slice(0, 64) : `[${typeof rawApplicationId}]`,
    })
  }
  const nowMs = Date.now()
  const rawAsOf = body.as_of
  let asOf = new Date(nowMs).toISOString()
  if (rawAsOf !== undefined) {
    if (typeof rawAsOf !== 'string') {
      throw decisionHttpError(400, 'INVALID_ARGS', 'TYPE_MISMATCH', 'as_of 必须是 ISO-8601 字符串', { path: 'as_of' })
    }
    const checked = checkAsOf(rawAsOf, nowMs)
    if (!checked.ok) {
      throw decisionHttpError(
        400,
        'INVALID_ARGS',
        checked.reason_code === 'AS_OF_IN_FUTURE' ? 'AS_OF_IN_FUTURE' : 'TYPE_MISMATCH',
        checked.message,
        { as_of: rawAsOf.slice(0, 64) },
      )
    }
    asOf = rawAsOf
  }
  const evaluated = await withPool(database, (pool) => withReadOnly(pool, (client) => (
    evaluateInTransaction(client, database, { application_id: rawApplicationId, as_of: asOf }, nowMs)
  )))
  const output = asRecord(evaluated)
  const evaluation = mapScreeningEvaluationFromToolOutput(output, { asOf })
  if (evaluation === null) {
    throw decisionHttpError(
      500,
      'INTERNAL',
      'EVALUATION_SHAPE_INVALID',
      '初筛评估输出缺少 evaluation_digest / snapshot 绑定字段（不编造）',
    )
  }
  // 独立读回（另开连接、另开只读事务；证明评估上下文与库事实一致，不是回显工具输出）。
  const subject = await withPool(database, (pool) => withReadOnly(pool, (client) => (
    readEvaluateSubject(client, database.tenant_id, rawApplicationId)
  )))
  json(res, 200, {
    contract_version: DECISION_EVALUATE_CONTRACT_VERSION,
    action: 'screening/evaluate',
    tool: SCREENING_EVALUATE_TOOL_NAME,
    actor: actorEnvelope(resolved),
    // 只读工具没有 D-79 approval 分支：如实标 not-applicable（人类动作闸门 = 同源 + session + recruiter）。
    approval: {
      requested: 0,
      result: 'not-applicable',
      tool_names: [],
      reason: 'SCREENING_EVALUATE_IS_READ_ONLY_NO_APPROVAL_GATE',
    },
    application_id: rawApplicationId,
    evaluation: {
      ...evaluation,
      verdict_summary: nonEmptyString(output.verdict_summary),
      required_human_action: nonEmptyString(output.required_human_action),
      warnings: Array.isArray(output.warnings) ? output.warnings : [],
      labels: asOptionalRecord(output.labels),
      read_only: output.read_only === true,
      advisory: output.advisory === true,
    },
    readback: {
      table: 'screening_evaluation',
      // 该 domain 工具是只读的（不落表）；不假装有一行库记录。
      persisted: false,
      row: {},
      reason: 'SCREENING_EVALUATE_READ_ONLY_NO_TABLE',
      subject,
    },
    replayed: false,
  })
}

// =====================================================================
//  POST /recruitment/api/decision/record（facade：服务端组装 basis_refs）
// =====================================================================

/** 读回某申请某 scope 的最新决策行（写后当前事实）。 */
async function readbackDecision(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  scope: string,
): Promise<DecisionReadbackRow> {
  const { rows } = await client.query<DecisionReadbackRow>(DECISION_READBACK_SQL, [
    tenantId,
    applicationId,
    scope,
  ])
  const row = rows[0]
  if (row === undefined) {
    throw decisionHttpError(500, 'INTERNAL', 'READBACK_MISSING', '决策写事务已提交但读回不到该行', {
      application_id: applicationId,
      decision_scope: scope,
    })
  }
  return row
}

/** body 基本形状校验（详细领域校验仍由 `parseDecisionArgs`/工具完成）。 */
function validateRecordBody(body: Record<string, unknown>): {
  applicationId: string
  scope: 'STAGE' | 'FINAL'
  result: 'ADVANCE' | 'HOLD' | 'REJECT'
  reason: string
  interviewId: string | null
  asOf: string
} {
  const rawApplicationId = body.application_id
  if (rawApplicationId === undefined) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "application_id"', {
      missing: ['application_id'],
    })
  }
  if (typeof rawApplicationId !== 'string' || !isUuid(rawApplicationId)) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'application_id 必须是 UUID', {
      application_id: typeof rawApplicationId === 'string' ? rawApplicationId.slice(0, 64) : `[${typeof rawApplicationId}]`,
    })
  }
  const scopeRaw = body.decision_scope
  if (scopeRaw === undefined) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "decision_scope"', {
      missing: ['decision_scope'],
      allowed: [...RECORD_SCOPES],
    })
  }
  if (scopeRaw === 'SCREENING') {
    throw decisionHttpError(
      400,
      'INVALID_ARGS',
      'SCOPE_MISMATCH',
      'SCREENING 决策请用 /recruitment/api/action/screening/decide（本 facade 只处理 STAGE/FINAL）',
      { decision_scope: scopeRaw },
    )
  }
  if (typeof scopeRaw !== 'string' || !(RECORD_SCOPES as readonly string[]).includes(scopeRaw)) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'ENUM_INVALID', 'decision_scope 只能是 STAGE / FINAL', {
      got: typeof scopeRaw === 'string' ? scopeRaw.slice(0, 64) : `[${typeof scopeRaw}]`,
      allowed: [...RECORD_SCOPES],
    })
  }
  const resultRaw = body.result
  if (resultRaw === undefined) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "result"', {
      missing: ['result'],
      allowed: [...RECORD_RESULTS],
    })
  }
  if (typeof resultRaw !== 'string' || !(RECORD_RESULTS as readonly string[]).includes(resultRaw)) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'ENUM_INVALID', 'result 只能是 ADVANCE / HOLD / REJECT', {
      got: typeof resultRaw === 'string' ? resultRaw.slice(0, 64) : `[${typeof resultRaw}]`,
      allowed: [...RECORD_RESULTS],
    })
  }
  const reasonRaw = body.reason
  if (reasonRaw === undefined) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填字段 "reason"（人写的理由）', {
      missing: ['reason'],
    })
  }
  if (typeof reasonRaw !== 'string' || reasonRaw.trim() === '') {
    throw decisionHttpError(400, 'INVALID_ARGS', 'TYPE_MISMATCH', 'reason 必须是 1..4000 字符的字符串', {
      path: 'reason',
    })
  }
  if (reasonRaw.length > 4000) {
    throw decisionHttpError(400, 'INVALID_ARGS', 'OUT_OF_RANGE', 'reason 不得超过 4000 字符', {
      path: 'reason',
      length: reasonRaw.length,
    })
  }
  const scope = scopeRaw as 'STAGE' | 'FINAL'
  const rawInterviewId = body.interview_id
  let interviewId: string | null = null
  if (rawInterviewId !== undefined) {
    if (scope === 'FINAL') {
      throw decisionHttpError(
        400,
        'INVALID_ARGS',
        'FINAL_SCOPE_NO_INTERVIEW',
        'FINAL 决策不得指定 interview_id（终局跨全部面试，DC-06）',
        { interview_id: typeof rawInterviewId === 'string' ? rawInterviewId.slice(0, 64) : `[${typeof rawInterviewId}]` },
      )
    }
    if (typeof rawInterviewId !== 'string' || !isUuid(rawInterviewId)) {
      throw decisionHttpError(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'interview_id 必须是 UUID', {
        path: 'interview_id',
      })
    }
    interviewId = rawInterviewId
  }
  if (scope === 'STAGE' && interviewId === null) {
    // 契约 body 未含 interview_id，但既有 decision-record 的 STAGE 必须带（DC-06）；
    // facade 把它作为 STAGE 的扩展键，缺失时如实 400（不猜"最后一轮"）。
    throw decisionHttpError(
      400,
      'INVALID_ARGS',
      'STAGE_REQUIRES_INTERVIEW',
      'STAGE 决策必须提供 interview_id（facade 不自动选轮次）',
      { decision_scope: 'STAGE', extension_key: 'interview_id' },
    )
  }
  const nowMs = Date.now()
  const rawAsOf = body.as_of
  let asOf = new Date(nowMs).toISOString()
  if (rawAsOf !== undefined) {
    if (typeof rawAsOf !== 'string') {
      throw decisionHttpError(400, 'INVALID_ARGS', 'TYPE_MISMATCH', 'as_of 必须是 ISO-8601 字符串', { path: 'as_of' })
    }
    const checked = checkAsOf(rawAsOf, nowMs)
    if (!checked.ok) {
      throw decisionHttpError(
        400,
        'INVALID_ARGS',
        checked.reason_code === 'AS_OF_IN_FUTURE' ? 'AS_OF_IN_FUTURE' : 'TYPE_MISMATCH',
        checked.message,
        { as_of: rawAsOf.slice(0, 64) },
      )
    }
    asOf = rawAsOf
  }
  return {
    applicationId: rawApplicationId,
    scope,
    result: resultRaw as 'ADVANCE' | 'HOLD' | 'REJECT',
    reason: reasonRaw,
    interviewId,
    asOf,
  }
}

/** `POST /recruitment/api/decision/record` 的实现（facade）。 */
async function handleRecord(
  deps: DecisionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  assertWriteAlias(resolved, 'decision/record')
  const database = requireDatabase(deps)
  const body = await readJsonObject(req)
  rejectBodyKeys(
    body,
    ACTOR_OVERRIDE_BODY_KEYS,
    'ACTOR_OVERRIDE_REJECTED',
    'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33）',
  )
  rejectBodyKeys(
    body,
    DECISION_DERIVED_BODY_KEYS,
    'ACTOR_OVERRIDE_REJECTED',
    '人工确认/状态字段由服务端派生，不接受客户端传入（D-95）',
  )
  rejectBodyKeys(
    body,
    SERVER_DERIVED_BODY_KEYS,
    'SERVER_DERIVED_REJECTED',
    'basis_refs / summary_digest / hash 由服务端从事实组装，前端不得传（契约 §3）',
  )
  rejectUnknownBodyKeys(body, RECORD_BODY_KEYS)
  const command = validateRecordBody(body)
  const nowMs = Date.now()

  // ---- 只读阶段：申请/权限/汇总重算/面评依据全部来自 DB ----
  const prepared = await withPool(database, (pool) => withReadOnly(pool, async (client) => {
    const app = await loadApplicationFacts(client, database.tenant_id, command.applicationId)
    if (app === undefined) {
      throw decisionHttpError(404, 'NOT_FOUND', 'APPLICATION_NOT_FOUND', '该租户下没有这个申请', {
        application_id: command.applicationId,
      })
    }
    await loadAuthorityActor(client, database.tenant_id, resolved)
    const isHiringManager = app.hiring_manager_actor_id !== null
      && app.hiring_manager_actor_id.toLowerCase() === resolved.actor_id.toLowerCase()
    // DC-07 阶段闸门（与 `decision-record.ts` 同一判据）：facade 先如实拒绝，避免把
    // "S7 不能落 S10 决策" 误报成 MISSING_SUMMARY（summary 在 STAGE 还依赖 interview_id）。
    // 工具侧仍会再校验一次（权威闸门，边界在领域里）。
    if (app.current_stage_code !== 'S10') {
      throw decisionHttpError(
        400,
        'INVALID_ARGS',
        'STAGE_NOT_S10',
        '申请当前阶段不是 S10，不能落 STAGE/FINAL 决策（先推进阶段，DC-07）',
        {
          application_id: app.application_id,
          current_stage_code: app.current_stage_code,
          required_stage_code: 'S10',
          decision_scope: command.scope,
          lifecycle_status: app.lifecycle_status,
        },
      )
    }
    if (app.application_rubric_version_id === null || !isHex64(app.rubric_payload_hash)) {
      throw decisionHttpError(400, 'INVALID_ARGS', 'NO_RUBRIC', '申请没有钉住可用的 Rubric 版本', {
        application_id: command.applicationId,
        rubric_version_id: app.application_rubric_version_id,
      })
    }
    let summaryRaw: unknown
    try {
      summaryRaw = await runSummary(client, database, resolved, {
        application_id: command.applicationId,
        decision_scope: command.scope,
        ...(command.interviewId === null ? {} : { interview_id: command.interviewId }),
        as_of: command.asOf,
      }, nowMs)
    } catch (error) {
      const domain = describeDomainError(error)
      throw decisionHttpError(
        400,
        'INVALID_ARGS',
        'MISSING_SUMMARY',
        '汇总不可用（服务端无法从事实得到 summary_digest；不猜、不接受客户端 hash）',
        { domain },
      )
    }
    const summary = asOptionalRecord(summaryRaw)
    const summaryDigest = summary === null ? null : nonEmptyString(summary.summary_digest)
    if (summaryDigest === null || !isHex64(summaryDigest)) {
      throw decisionHttpError(400, 'INVALID_ARGS', 'MISSING_SUMMARY', '汇总没有返回可用的 summary_digest', {
        summary: summary === null ? null : { as_of: summary.as_of },
      })
    }
    const scorecards = await loadRecordScorecardRefs(
      client,
      database.tenant_id,
      app,
      command.scope,
      command.interviewId,
    )
    return {
      app,
      isHiringManager,
      summaryDigest,
      asOf: nonEmptyString(summary?.as_of) ?? command.asOf,
      scorecards,
    }
  }))

  // ---- 服务端组装 basis_refs（前端不传任何 hash/digest） ----
  const basisRefs = buildRecordBasisRefs({
    summaryDigest: prepared.summaryDigest,
    asOf: prepared.asOf,
    rubric: {
      id: prepared.app.application_rubric_version_id as string,
      payload_hash: prepared.app.rubric_payload_hash as string,
    },
    authority: { actor_id: resolved.actor_id, is_hiring_manager: prepared.isHiringManager },
    scorecards: prepared.scorecards,
  })
  const rawArgs: Record<string, unknown> = {
    application_id: command.applicationId,
    decision_scope: command.scope,
    as_of: prepared.asOf,
    result: command.result,
    reason: command.reason,
    basis_refs: basisRefs,
    summary_digest: prepared.summaryDigest,
    ...(command.interviewId === null ? {} : { interview_id: command.interviewId }),
  }
  // 与 `actions.ts::buildDecisionCommand` 同一顺序：先 parse 归一化，再用同一份结果算人工确认哈希。
  const parsed = parseDecisionArgs(rawArgs, nowMs)
  const confirmationText = confirmationTextSha256({
    result: parsed.result,
    reason: parsed.reason,
    override_rationale: parsed.override_rationale ?? null,
    basis_refs: parsed.basis_refs,
  })
  const gate = createAllowOnceGate(DECISION_TOOL_NAME)
  const tool = createDecisionRecordTool({
    database,
    approval: gate.approval,
    identity: deps.identity,
  })
  const output = asRecord(await tool.execute({
    ...rawArgs,
    human_confirmation: {
      confirmed_by_actor_id: resolved.actor_id,
      confirmed_at: new Date(nowMs).toISOString(),
      confirmation_method: 'IN_APP_CONFIRM',
      confirmation_text_sha256: confirmationText,
    },
  }, execOf(resolved)))

  // ---- 写后另开只读连接独立读回 ----
  const readback = await withPool(database, (pool) => withReadOnly(pool, (client) => (
    readbackDecision(client, database.tenant_id, command.applicationId, command.scope)
  )))
  const decisionOut = asOptionalRecord(output.decision)
  const readbackDecisionId = readback.decision_id
  json(res, 200, {
    contract_version: DECISION_RECORD_CONTRACT_VERSION,
    action: 'decision/record',
    tool: DECISION_TOOL_NAME,
    actor: actorEnvelope(resolved),
    approval: gate.summary(),
    decision: {
      decision_id: decisionOut === null ? readbackDecisionId : nonEmptyString(decisionOut.id) ?? readbackDecisionId,
      decision_scope: command.scope,
      result: command.result,
      decided_at: toIsoOrNull(readback.decided_at),
      record_version: readback.record_version,
      stage_code: readback.stage_code,
      decided_by_actor_id: readback.actor_id,
      is_current: readback.is_current,
    },
    basis_refs: basisRefs,
    readback: { table: 'decision', row: readback },
    replayed: output.replayed === true,
    labels: asOptionalRecord(output.labels),
    warnings: Array.isArray(output.warnings) ? output.warnings : [],
  })
}

// =====================================================================
//  注册入口
// =====================================================================

/** 回环地址判据（只接受 127.0.0.1 / ::1；其余地址不注册路由）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/** 把一个 handler 包成「同源 loopback + 只接受指定方法」的 exact 路由处理函数。 */
function methodRoute(
  port: number,
  method: 'GET' | 'POST',
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    assertSameOrigin(req, port)
    rejectQueryOrHeaderOverrides(req, url)
    if (req.method !== method) {
      methodNotAllowed(res, method)
      return
    }
    await handle(req, res)
  })
}

/**
 * 注册 D5 决策 facts / evaluate / record facade；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警（fail-closed：决策事实与写入口绝不挂到网络可达地址）。
 * 3 条 exact 路由（facts GET 1 条 + evaluate/record POST 2 条）。
 * @param ctx - 宿主上下文（含 webServer 服务）。
 * @param deps - 库配置 + 与工具共享的 Demo Actor 身份。
 * @returns 注销函数。
 */
export function registerDecisionHttp(ctx: DecisionHostContext, deps: DecisionHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 决策入口未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const routes: readonly (readonly [string, (req: IncomingMessage, res: ServerResponse) => Promise<void>])[] = [
    [DECISION_PATHS.facts, methodRoute(port, 'GET', (req, res) => handleFacts(deps, req, res))],
    [
      DECISION_PATHS.screeningEvaluate,
      methodRoute(port, 'POST', (req, res) => handleScreeningEvaluate(deps, req, res)),
    ],
    [DECISION_PATHS.record, methodRoute(port, 'POST', (req, res) => handleRecord(deps, req, res))],
  ]
  const disposers = routes.map(([path, handler]) => webServer.register({ kind: 'exact', path, handler }))
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 注销失败不掩盖别的问题（宿主卸载本来就是尽力而为）。
      }
    }
  }
}
