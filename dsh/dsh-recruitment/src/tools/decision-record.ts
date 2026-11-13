// recruitment_decision_record —— S10「正式决策」的**唯一写入口**（人已拍板，工具只记录）。
//
// 形状权威：`contracts/evaluation/tool-contracts.md` §4（下称 TC）；
// 领域规则：`contracts/evaluation/decision-rules.md`（下称 DC）；
// 缺面评口径：`contracts/evaluation/scorecard-rules.md` §6/§7（下称 SC）；
// 三工具对接：`manual/evaluation-line/DESIGN.md`（下称 DESIGN）。
//
// 本文件负责的条款（实现清单）：
//   * DC-05 判定顺序 STEP 0→7（顺序本身是规则；STEP 6.5 是 D-79 的 approval 闸门）
//   * DC-06 scope/interview 互斥；DC-07 `stage_code` **由 scope 写死**（STAGE/FINAL→'S10'，
//     SCREENING→'S7'；入参一律不接受）。**SCREENING 写侧**是 2026-11-14 的增补
//     （`decision-rules.md` §17.1，补 DC-06 的空白；见文件头末尾"2026-11-14 增补"）
//   * DC-08/09/10/11 人工确认四要素 + `confirmation_text_sha256` 的 pre-image（**版本化**）：
//     v1（旧口径）= `{result, reason, override_rationale, basis_refs}`；
//     v2（D-95，IN_CHAT）= v1 + `{preimage_version:2, confirmation_text, confirmed_by_actor_id, confirmed_at}`
//   * DC-12/13/14/15/16/17/18/19 `basis_refs` 的 9 种 kind（**S10 口径**；SCREENING 用
//     `job-screening/tool-contracts.md` §3.7 的 SCREENING_EVALUATION/RESUME_VERSION，
//     见 `decision-rules.md` §17.1）、非空、AUTHORITY 计算值、
//     SUMMARY digest、RUBRIC_VERSION 哈希、REJECT 必须引到维度、approval 绑定
//   * DC-20 只比对重算出来的 `summary_digest`（**不重算**：唯一实现是 evaluation-summarize.ts）
//   * DC-22/23/24/25/26/27/28/29 四道防线（REJECT 不得建立在缺失/读不出之上；反着来必须签字）
//   * DC-30..DC-40 撤回三步舞（反向插 → 换指针 → 清空；旧行 record_version 手动 +1；
//     单向链；**禁止 `SELECT … FOR UPDATE`**，D-80）
//   * DC-38 同事务写内部事件（`provider='internal'`/`trust_level='INTERNAL'`/
//     `idempotency_source='FALLBACK_KEY'`/`source_object_id=<新 decision id>`/
//     `provider_event_id=NULL`）
//   * DC-47/DC-48 不改任何状态；`decided_at` 由服务端时钟
//   * TC §4.7 `warnings[]` 封闭集、TC §4.3 出参形状、DESIGN §3.5 ④ D-79 approval
//
// 已知偏差（必须与交付说明一致，逐条登记）：
//   1. **`APPROVAL_UNAVAILABLE` / `APPROVAL_NOT_GRANTED` 是本文件新增的两个 `reason_code`**
//      （D-79 晚于 TC §4.2 的五个，后者是 D-79 之前的封闭集）。
//   2. `as_of` **格式错**报 `INVALID_ARGS(TYPE_MISMATCH)`（DESIGN §2：TC §5.1 没有
//      `AS_OF_FORMAT`；`AS_OF_IN_FUTURE` 照用）。`summary_digest` / `confirmed_at` /
//      `confirmation_text_sha256` 的形状错同样归 `TYPE_MISMATCH`（TC §5.1 无专用码）。
//   3. `stage_code` **声明在 schema 里但一律拒收**（`TENANT_OR_ACTOR_NOT_ALLOWED`，TC §1.6 +
//      DESIGN §2 的保留键清单）。这与 TC §7.1 第 5 条（「`stage_code` → `UNKNOWN_PARAM`，
//      键都不存在」）**冲突**；TC §1.6 与 §7.1 之间本身不自洽，本文件取 §1.6（声明后拒收），
//      `idempotency_key` 则**不声明** → `UNKNOWN_PARAM`（D-80）。
//   4. `system_digest` 之外，`missing_disposition` 在 `ADVANCE(FINAL)` 时被**忽略而不报错**：
//      TC §4.1 写「`FINAL` 不接受它 → `MISSING_ACK_REQUIRED` 不适用，直接 `SCORECARD_MISSING`」，
//      取「不适用」而不是「参数错误」（否则 P10 永远走不到 `SCORECARD_MISSING`）。
//   5. `summary_digest` 一律以 **`evaluation-summarize.ts` 的重算值**为准（DC-16/DC-20），
//      本文件**没有**第二份 digest 实现。
//   6. 库缺口（DESIGN §4）：`decision` 无 current 部分唯一索引 → 先查 current +
//      `WHERE superseded_by_decision_id IS NULL` 的条件更新 + **写后复核**；
//      `0008` 之后 `uq_decision_current` 是 **DEFERRABLE EXCLUDE**，并发/重复在 COMMIT 抛
//      **23P01**（exclusion_violation）→ `ALREADY_DECIDED`；23505 仍按原口径映射（P1-1）。
//   7. 输出里**没有 null**（DSH 校验器不支持 `type` 数组，`type:'null'` 不可表达）：
//      `recordDecisionInTransaction` 返回契约逐字形状（TC §4.3 里画成 `null` 的
//      `superseded` / `decision.superseded_by_decision_id` 保留 `null`），
//      `execute()` 在交给宿主前 `stripNulls()`（与 `screening-evaluate.ts` 同一处置，
//      `test/unit/output-schema.test.ts` 的既有约定）。
//   8. TC §7.3 第 5 条要求「落库值 = 出参 `basis_refs`」，但 TC §4.3 的出参里没有
//      `basis_refs` 键；本文件按 INV-9 的实质执行：**入参 `basis_refs` 与落库值逐字相同**
//      （工具不改写、不裁剪），测试对 `canonicalJson` 做等值断言。
//   9. `basis_refs` 里「缺 SUMMARY / RUBRIC_VERSION / AUTHORITY / SCORECARD」一律报
//      `INVALID_ARGS(BASIS_REF_EMPTY)` + `detail.missing_kinds`（D-组没有更细的码）；
//      单个 kind 缺键报 `MISSING_REQUIRED`。
//   10. `AUTHORITY.actor_id` 与服务端 actor 不一致报 `BASIS_AUTHORITY_MISMATCH`
//      （DC-14 只写了 `is_hiring_manager`；本文件把「替别人盖章」当同一种不一致）。
//   11. **SCREENING 出参没有 `gate`**（S7 没有 S10 的汇总，硬造一个 `summary_digest`
//      等于把没有的绑定画出来）。`OUTPUT_SCHEMA.required` 因此不再要求 `gate`；S10 仍必带。
//      `decision.stage_code` 按 scope 取值（'S7'/'S10'），不再是单一枚举。
//   12. `confirmation_text_sha256` 的 pre-image **版本化**（D-95 + P1-2）：传了
//      `confirmation_text`（IN_CHAT）→ v2，旧记录/旧调用（无原话）→ v1。**v1 的四个键
//      一字节都不能动**，否则库里已有的旧 sha256 全部验不过（`decision-rules.md` §17.2）。
//
// 2026-11-14 增补（`decision-rules.md` §17；与既有 DC 条目冲突时以 §17 为准）：
//   * P0-3：`decision_scope='SCREENING'` 是 S7 人决定的落库路径（`stage_code='S7'`，
//     不需要 `interview_id`、不需要 S10 汇总；`result` 只允许 ADVANCE/HOLD/REJECT/WITHDRAW，
//     S7 不是终局；D-95 的人机闸门不变）。它**不**走 STEP 4/5/6（那三步是 S10 面评面板的门禁）。
//   * P1-1：`0008` 的可延迟排斥约束在 COMMIT 抛 23P01 → `ALREADY_DECIDED`（execute 也要兜）。
//   * P1-2：D-95 的 `confirmation_text` 进 v2 pre-image；契约补 `IN_CHAT`。
//
// 不做什么（TC §0 六条）：不代决、不用缺失面评算分、不用 unreadable 拒绝人、不接受
// 调用方给的身份/租户/阶段码、不改任何状态、不输出恒真权限字段。

import { randomUUID } from 'node:crypto'

import { canonicalJson, checkAsOf, digestOf, isUuid } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { computeEvaluationSummaryIn, type EvaluationSummary } from './evaluation-summarize.ts'

const TOOL_NAME = 'recruitment_decision_record'
const CONTRACT_VERSION = '2.0.0'
/** 阶段码**由工具按 scope 写死**（DC-07 + §17.1）；入参出现它一律拒收。 */
const STAGE_CODE = 'S10'
/** S7 写侧（`decision_scope='SCREENING'`）的阶段码（§17.1；`stage_catalog` 里 S7 在册）。 */
const SCREENING_STAGE_CODE = 'S7'

/**
 * `decision_scope` → 该行**写死**的 `stage_code`（DC-07 + §17.1）。
 * 不接受调用方传值：那是"把阶段码当参数"，同名脏值能绕过 `stage_catalog`（`D-24` 同构）。
 * @param decisionScope - 入参 `decision_scope`。
 */
export function stageCodeOf(decisionScope: string): string {
  return decisionScope === 'SCREENING' ? SCREENING_STAGE_CODE : STAGE_CODE
}
/** 服务端时钟（DC-48）。 */
const CONFIRMATION_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** `basis_refs` 的上下界（TC §4.1）。 */
const BASIS_MIN = 1
const BASIS_MAX = 200
const REASON_MAX = 4000
const WHY_PROCEED_MAX = 1000

/** 本文件允许抛出的错误码（DESIGN §2 的局部构造器；`errors.ts` 不在写范围）。 */
type EvaluationErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'NOT_CONFIGURED'
  | 'INTERVIEWER_MISMATCH'
  | 'ALREADY_SUBMITTED'
  | 'VERSION_CONFLICT'
  | 'EVIDENCE_INSUFFICIENT'
  | 'SCORECARD_MISSING'
  | 'BLOCKED_BY_REVIEW'
  | 'DECISION_REQUIRES_HUMAN'
  | 'ALREADY_DECIDED'
  | 'DB_CONSTRAINT_VIOLATION'

/**
 * 造一个 `Error: <CODE>: <compact-json>` 形态的工具错误（TC §1.2 键序）。
 * @param code - 稳定错误码。
 * @param reasonCode - 该码下的封闭取值。
 * @param message - 一句中文说明（不含 PII）。
 * @param detail - 结构化明细；没有就省略键。
 * @param family - 仅 `BLOCKED_BY_REVIEW` 用（TC §1.2）。
 */
function evalError(
  code: EvaluationErrorCode,
  reasonCode: string,
  message: string,
  detail?: unknown,
  family?: string,
): RecruitmentToolError {
  const body: Record<string, unknown> = { code, reason_code: reasonCode }
  if (family !== undefined) body.family = family
  body.message = message
  if (detail !== undefined) body.detail = detail
  // `errors.ts` 的联合不含 S10 的码（不在写范围）→ 运行期 code 就是传入值（DESIGN §2）。
  return new RecruitmentToolError(code as never, canonicalJson(body))
}

/** D-79 的 approval 结果（DSH `ctx.approval.request` 的封闭结果）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 决策工具的依赖（DESIGN §3.5 ④）。 */
export interface DecisionToolDeps {
  readonly database: ResolvedDatabaseConfig
  /** DSH `ctx.approval` 的窄接口（D-79）。**缺省 = 一律拒绝**，不存在"直接写库"的分支。 */
  readonly approval?: {
    request(req: {
      agent?: unknown
      toolName: string
      reason?: string
      signal?: AbortSignal
    }): Promise<string>
  }
}

/** `basis_refs[].kind` 封闭集（DC §6.1，**九种，多一种都不行**）。**只约束 S10 口径**。 */
const BASIS_KINDS = [
  'SCORECARD',
  'SUMMARY',
  'RUBRIC_VERSION',
  'INTERVIEW_RECORD',
  'SCREENING_DECISION',
  'AUTHORITY',
  'OVERRIDE',
  'MISSING_ACK',
  'SUPERSEDES',
] as const

/**
 * S7 写侧专属 kind（`job-screening/tool-contracts.md` §3.7 的写侧结构）：
 * `SCREENING_EVALUATION`（这次筛选评估的瞬态输出摘要）+ `RESUME_VERSION`（这次评估用的材料版本）。
 * **只在 `decision_scope='SCREENING'` 下接受**；SCORECARD/SUMMARY/INTERVIEW_RECORD 等 S10 依据
 * 在 S7 下无意义 → `BASIS_KIND_FORBIDDEN`（`decision-rules.md` §17.1）。
 */
const SCREENING_BASIS_KINDS = [
  'SCREENING_EVALUATION',
  'RESUME_VERSION',
  'RUBRIC_VERSION',
  'AUTHORITY',
  'SUPERSEDES',
] as const

/** 入参 schema 里 `kind` 的完整枚举（声明面）；运行期按 scope 收窄（`checkBasisRefs`）。 */
const DECLARED_BASIS_KINDS = [...BASIS_KINDS, 'SCREENING_EVALUATION', 'RESUME_VERSION'] as const

/** 面评四态（SC §4.5）。 */
const ASSESSMENTS = ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'] as const

/** 写给模型的入参 schema 里每个 kind 允许的键（运行期逐键校验，未知键 → `UNKNOWN_PARAM`）。 */
const BASIS_KEYS: Record<string, { readonly required: readonly string[]; readonly optional: readonly string[] }> = {
  SCORECARD: {
    required: ['id', 'overall', 'transcript_basis', 'transcript_state'],
    optional: ['revision_no', 'interviewer_id', 'payload_hash', 'fields', 'evidence_state'],
  },
  SUMMARY: {
    required: ['summary_digest'],
    optional: ['contract_version', 'coverage', 'tally', 'consensus', 'provenance'],
  },
  RUBRIC_VERSION: { required: ['id', 'payload_hash'], optional: ['version_no'] },
  INTERVIEW_RECORD: {
    required: ['id'],
    optional: ['transcript_artifact_id', 'transcript_revision', 'verification_status'],
  },
  SCREENING_DECISION: { required: ['id'], optional: ['result', 'decided_at'] },
  AUTHORITY: { required: ['actor_id', 'is_hiring_manager'], optional: [] },
  OVERRIDE: { required: ['acknowledged_dissent', 'override_rationale'], optional: [] },
  MISSING_ACK: { required: ['interviewer_ids', 'rationale'], optional: [] },
  SUPERSEDES: { required: ['decision_id', 'reason', 'opened_by_actor_id'], optional: [] },
  // ---- S7 写侧（只在 decision_scope='SCREENING' 下接受；§17.1）----
  SCREENING_EVALUATION: {
    required: ['evaluation_digest', 'verdict', 'rubric_version_id', 'rubric_payload_hash', 'resume_version_id', 'resume_content_sha256'],
    optional: ['contract_version', 'reasons_digest', 'criteria_evaluated', 'counts', 'provenance'],
  },
  RESUME_VERSION: { required: ['id'], optional: ['content_sha256', 'version_no'] },
}

/**
 * 保留键：**声明在 schema 里，但一律拒收**（TC §1.6 + DESIGN §2）。
 * `idempotency_key` **不在此列**：它根本不在 schema 里 → `UNKNOWN_PARAM`（D-80）。
 */
const RESERVED_KEYS = [
  'tenant_id',
  'actor_id',
  'interviewer_id',
  'decided_by_actor_id',
  'stage_code',
  'round_no',
  'slot_code',
  'submitted_at',
  'decided_at',
  'status',
] as const

// =====================================================================
//  入参 schema（官方可接受子集：type/properties/required/additionalProperties/
//  items/enum/description；无 type 数组、无 type:null、required ⊆ properties）
// =====================================================================

const HUMAN_CONFIRMATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    confirmed_by_actor_id: { type: 'string', description: '必须 = 执行上下文的 actor（UUID）' },
    confirmed_at: { type: 'string', description: 'ISO-8601 带偏移；与 decided_at 相差 ≤ 24h 且不得晚于它' },
    confirmation_method: { type: 'string', enum: ['IN_CHAT', 'IN_APP_CONFIRM', 'SIGNED_RECORD'] },
    confirmation_text: {
      type: 'string',
      description:
        '人在对话里说过的原话（逐字，≤2000 字符）。confirmation_method=IN_CHAT 时必填：'
        + '它是"人只决策一次"的授权凭据，落库后可与会话日志对账（D-95）。'
        + '**原话进 pre-image v2**（§17.2）：改了原话、哈希就对不上。',
    },
    confirmation_text_sha256: {
      type: 'string',
      description:
        '64 位 hex。v1（无原话，旧口径）：sha256(canonical_json({result, reason, override_rationale, basis_refs}))；'
        + 'v2（IN_CHAT，D-95）：上述四键 + {preimage_version:2, confirmation_text, confirmed_by_actor_id, confirmed_at}'
        + '（键序由 canonical_json 固定；见 decision-rules.md §17.2）。',
    },
  },
  required: ['confirmed_by_actor_id', 'confirmed_at', 'confirmation_method', 'confirmation_text_sha256'],
  additionalProperties: false,
}

const BASIS_REF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...DECLARED_BASIS_KINDS] },
    id: { type: 'string' },
    revision_no: { type: 'integer' },
    interviewer_id: { type: 'string' },
    payload_hash: { type: 'string' },
    overall: { type: 'string', enum: ['ADVANCE', 'HOLD', 'REJECT'] },
    transcript_basis: { type: 'string', enum: ['TRANSCRIPT', 'NO_TRANSCRIPT'] },
    transcript_state: { type: 'string' },
    evidence_state: { type: 'string', enum: ['MEMORY_ONLY'] },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dimension_key: { type: 'string' },
          assessment: { type: 'string', enum: [...ASSESSMENTS] },
          evidence: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['dimension_key', 'assessment'],
        additionalProperties: false,
      },
    },
    summary_digest: { type: 'string' },
    contract_version: { type: 'string' },
    coverage: { type: 'object', additionalProperties: true },
    tally: { type: 'object', additionalProperties: true },
    consensus: { type: 'string' },
    provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
    version_no: { type: 'integer' },
    transcript_artifact_id: { type: 'string' },
    transcript_revision: { type: 'integer' },
    verification_status: { type: 'string' },
    result: { type: 'string' },
    decided_at: { type: 'string' },
    actor_id: { type: 'string' },
    is_hiring_manager: { type: 'boolean' },
    acknowledged_dissent: { type: 'boolean' },
    override_rationale: { type: 'string' },
    interviewer_ids: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
    decision_id: { type: 'string' },
    reason: { type: 'string' },
    opened_by_actor_id: { type: 'string' },
    // ---- S7 写侧（SCREENING_EVALUATION / RESUME_VERSION；§17.1）----
    evaluation_digest: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NEEDS_REVIEW'] },
    rubric_version_id: { type: 'string' },
    rubric_payload_hash: { type: 'string' },
    resume_version_id: { type: 'string' },
    resume_content_sha256: { type: 'string' },
    reasons_digest: { type: 'string' },
    criteria_evaluated: { type: 'boolean' },
    counts: { type: 'object', additionalProperties: true },
    content_sha256: { type: 'string' },
  },
  required: ['kind'],
  additionalProperties: false,
}

const ACK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    interviewer_id: { type: 'string', description: '缺的那位（UUID）' },
    why_proceed: { type: 'string', description: '1..1000，为什么可以不等人' },
  },
  required: ['interviewer_id', 'why_proceed'],
  additionalProperties: false,
}

const SUPERSEDES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision_id: { type: 'string' },
    reason: { type: 'string' },
    expected_record_version: { type: 'integer' },
  },
  required: ['decision_id', 'reason', 'expected_record_version'],
  additionalProperties: false,
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    application_id: { type: 'string', description: '申请 id（UUID）。决策对象是申请，不是人也不是岗位。' },
    decision_scope: {
      type: 'string',
      enum: ['SCREENING', 'STAGE', 'FINAL'],
      description:
        'STAGE 必须带 interview_id；FINAL 必须不带（DC-06）；SCREENING 是 S7 的人决定'
        + '（不需要 interview_id / S10 汇总，stage_code 写 S7，§17.1）',
    },
    interview_id: { type: 'string', description: 'STAGE 必填 / FINAL、SCREENING 禁止（UUID）' },
    as_of: {
      type: 'string',
      description: '必填：ISO-8601 带时区偏移，不得晚于服务端 now。STAGE/FINAL 必须与 summarize 用的那个 as_of 相同，否则 SUMMARY_STALE。',
    },
    result: {
      type: 'string',
      enum: ['ADVANCE', 'HOLD', 'WITHDRAW', 'REJECT'],
      description: '人做出的结论；HIRED 在 v1.0 禁用（RESULT_NOT_IN_V1_SCOPE）。SCREENING 不是终局（不许 HIRED）',
    },
    reason: { type: 'string', description: '1..4000；REJECT 时必须含至少一个 rubric dimension_key（S7 是 criterion key）' },
    basis_refs: {
      type: 'array',
      items: BASIS_REF_SCHEMA,
      description: '1..200；S10：kind ∈ 九种（DC §6.1）；SCREENING：SCREENING_EVALUATION/RESUME_VERSION/RUBRIC_VERSION/AUTHORITY/SUPERSEDES（§17.1）',
    },
    summary_digest: { type: 'string', description: 'STAGE/FINAL 必填，64 位 hex 且必须 = 本次重算值（DC-16）；SCREENING 没有汇总，不接受' },
    human_confirmation: HUMAN_CONFIRMATION_SCHEMA,
    missing_disposition: {
      type: 'string',
      enum: ['PROCEED_WITH_MISSING'],
      description: '只对 ADVANCE(STAGE) 且 missing≠∅ 时有效（DC §4.2 矩阵）',
    },
    acknowledged_missing: { type: 'array', items: ACK_SCHEMA, description: '集合必须与 missing[].interviewer_id 完全相等' },
    acknowledged_dissent: { type: 'boolean', description: '结论与 consensus 相反时必须 true' },
    override_rationale: { type: 'string', description: '同上，非空；进 confirmation_text_sha256 的 pre-image' },
    supersedes: SUPERSEDES_SCHEMA,
    approval_id: { type: 'string', description: '可选 UUID（v1.0 不要求，DC-19）' },
    // ---- 保留键：声明但一律拒收（TC §1.6 / DESIGN §2）----
    tenant_id: { type: 'string', description: '保留键：只能来自执行上下文，一律拒收' },
    actor_id: { type: 'string', description: '保留键：只能来自执行上下文，一律拒收' },
    interviewer_id: { type: 'string', description: '保留键：只能来自执行上下文，一律拒收' },
    decided_by_actor_id: { type: 'string', description: '保留键：决策人只能来自执行上下文，一律拒收' },
    stage_code: { type: 'string', description: '保留键：工具按 scope 写死（S10/S7，DC-07/§17.1），一律拒收' },
    round_no: { type: 'integer', description: '保留键：轮次由 interview_id 决定，一律拒收' },
    slot_code: { type: 'string', description: '保留键：轮次由 interview_id 决定，一律拒收' },
    submitted_at: { type: 'string', description: '保留键：时间由服务端取，一律拒收' },
    decided_at: { type: 'string', description: '保留键：时间由服务端取（DC-48），一律拒收' },
    status: { type: 'string', description: '保留键：本工具不写状态，一律拒收' },
  },
  // `summary_digest` **不在 schema 层必填**：SCREENING 没有 S10 汇总（§17.1）；
  // STAGE/FINAL 由运行期（parseDecisionArgs）按 scope 强制必填，见 STEP 0。
  required: [
    'application_id', 'decision_scope', 'as_of', 'result', 'reason',
    'basis_refs', 'human_confirmation',
  ],
  additionalProperties: false,
}

// =====================================================================
//  出参 schema（TC §4.3；无 null —— 见文件头偏差 7）
// =====================================================================

const WARNING_CODES = [
  'DECIDER_NOT_HIRING_MANAGER',
  'HIRING_MANAGER_UNSET',
  'PROCEEDED_WITH_MISSING_SCORECARDS',
  'MINORITY_DISSENT',
  'OVERRIDE_APPLIED',
  'REJECT_BASIS_MEMORY_ONLY',
  'FIXTURE_BASIS',
  'SUPERSEDES_APPLIED',
  'APPROVAL_ATTACHED',
] as const

const DECISION_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    application_id: { type: 'string' },
    interview_id: { type: 'string' },
    decision_scope: { type: 'string', enum: ['SCREENING', 'STAGE', 'FINAL'] },
    stage_code: { type: 'string', enum: [SCREENING_STAGE_CODE, STAGE_CODE] },
    result: { type: 'string', enum: ['ADVANCE', 'HOLD', 'WITHDRAW', 'REJECT'] },
    decided_by_actor_id: { type: 'string' },
    decided_at: { type: 'string' },
    record_version: { type: 'integer' },
    superseded_by_decision_id: { type: 'string' },
  },
  required: [
    'id', 'application_id', 'decision_scope', 'stage_code', 'result',
    'decided_by_actor_id', 'decided_at', 'record_version',
  ],
  additionalProperties: false,
}

const GATE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    as_of: { type: 'string' },
    ready_for_decision: { type: 'boolean' },
    missing_disposition: { type: 'string', enum: ['PROCEED_WITH_MISSING'] },
    acknowledged_missing: { type: 'array', items: ACK_SCHEMA },
    permitted_results_echo: { type: 'array', items: { type: 'string' } },
    summary_digest: { type: 'string' },
  },
  required: ['as_of', 'ready_for_decision', 'acknowledged_missing', 'permitted_results_echo', 'summary_digest'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    replayed: { type: 'boolean', enum: [false] },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['CONNECTED', 'NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    decision: DECISION_OBJECT_SCHEMA,
    gate: GATE_SCHEMA,
    superseded: {
      type: 'object',
      properties: { decision_id: { type: 'string' }, record_version: { type: 'integer' } },
      required: ['decision_id', 'record_version'],
      additionalProperties: false,
    },
    event: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        provider: { type: 'string', enum: ['internal'] },
        trust_level: { type: 'string', enum: ['INTERNAL'] },
      },
      required: ['event_id', 'provider', 'trust_level'],
      additionalProperties: false,
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', enum: [...WARNING_CODES] },
          message: { type: 'string' },
        },
        required: ['code', 'message'],
        additionalProperties: false,
      },
    },
  },
  // `gate` 是 S10 的汇总门禁回显：SCREENING 没有汇总 → 出参没有这个键（文件头偏差 11）。
  required: ['tool', 'contract_version', 'status', 'replayed', 'labels', 'decision', 'event', 'warnings'],
  additionalProperties: false,
}

// =====================================================================
//  STEP 0：参数层（TC §1.1 八条 + TC §4.1）
// =====================================================================

/** 一条参数违反项（`detail.violations[]`）。 */
interface Violation {
  readonly reason_code: string
  readonly path: string
  readonly message: string
}

/** 一条缺人确认（TC §4.1）。 */
export interface AcknowledgedMissing {
  readonly interviewer_id: string
  readonly why_proceed: string
}

/** 人工确认四要素（DC §5.1 + D-95：IN_CHAT 必带原话）。 */
export interface HumanConfirmation {
  readonly confirmed_by_actor_id: string
  readonly confirmed_at: string
  readonly confirmation_method: string
  readonly confirmation_text_sha256: string
  readonly confirmation_text?: string
}

/** 撤回/重开的三绑定（§8）。 */
export interface SupersedesArgs {
  readonly decision_id: string
  readonly reason: string
  readonly expected_record_version: number
}

/** `parseDecisionArgs` 的产物（只含已声明键；语义校验留给后续 STEP）。 */
export interface DecisionArgs {
  readonly application_id: string
  readonly decision_scope: 'SCREENING' | 'STAGE' | 'FINAL'
  readonly interview_id?: string
  readonly as_of: string
  readonly result: 'ADVANCE' | 'HOLD' | 'REJECT' | 'WITHDRAW'
  readonly reason: string
  readonly basis_refs: readonly Record<string, unknown>[]
  readonly summary_digest?: string
  readonly human_confirmation?: Record<string, unknown>
  readonly missing_disposition?: 'PROCEED_WITH_MISSING'
  readonly acknowledged_missing: readonly AcknowledgedMissing[]
  readonly acknowledged_dissent?: boolean
  readonly override_rationale?: string
  readonly supersedes?: SupersedesArgs
  readonly approval_id?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pushViolation(list: Violation[], reason_code: string, path: string, message: string): void {
  list.push({ reason_code, path, message })
}

const HEX64_RE = /^[0-9a-f]{64}$/
const HEX64_ANY_CASE_RE = /^[0-9a-fA-F]{64}$/
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 校验 `basis_refs`（DC-12/13 + 每个 kind 的键集），返回逐条解析结果。
 *
 * **按 scope 收窄 kind 封闭集**：S10（STAGE/FINAL）只认九种（DC-13）；
 * SCREENING 只认 S7 写侧的 `SCREENING_BASIS_KINDS`（§17.1）。
 * @param raw - 入参 `basis_refs`。
 * @param violations - 违反项收集器。
 * @param decisionScope - 入参 `decision_scope`（未知值按 S10 口径处理，更严）。
 */
function checkBasisRefs(
  raw: unknown,
  violations: Violation[],
  decisionScope: unknown,
): Record<string, unknown>[] {
  const screeningScope = decisionScope === 'SCREENING'
  const allowedKinds: readonly string[] = screeningScope ? SCREENING_BASIS_KINDS : BASIS_KINDS
  if (!Array.isArray(raw)) {
    pushViolation(violations, 'TYPE_MISMATCH', 'basis_refs', 'basis_refs 必须是数组')
    return []
  }
  if (raw.length < BASIS_MIN) {
    pushViolation(violations, 'BASIS_REF_EMPTY', 'basis_refs', 'basis_refs 不得为空（DC-12）')
    return []
  }
  if (raw.length > BASIS_MAX) {
    pushViolation(violations, 'OUT_OF_RANGE', 'basis_refs', `basis_refs 最多 ${BASIS_MAX} 条`)
    return []
  }
  const out: Record<string, unknown>[] = []
  raw.forEach((item, index) => {
    const path = `basis_refs[${index}]`
    if (!isPlainObject(item)) {
      pushViolation(violations, 'TYPE_MISMATCH', path, 'basis_refs 的元素必须是对象')
      return
    }
    const kind = item.kind
    if (typeof kind !== 'string' || kind === '') {
      pushViolation(violations, 'MISSING_REQUIRED', `${path}.kind`, '每条依据都必须有 kind')
      return
    }
    if (!allowedKinds.includes(kind)) {
      // DC-13：`AI_SUMMARY` 或任何其它值都不许当依据；SCREENING 下 S10 的 kind 同样不许。
      const message = screeningScope
        ? `kind=${kind} 不适用于 SCREENING（S7 只接受 ${SCREENING_BASIS_KINDS.join(' / ')}，§17.1）`
        : `kind=${kind} 不在九种之内（DC §6.1）`
      pushViolation(violations, 'BASIS_KIND_FORBIDDEN', `${path}.kind`, message)
      return
    }
    const spec = BASIS_KEYS[kind] as { required: readonly string[]; optional: readonly string[] }
    const allowed = new Set(['kind', ...spec.required, ...spec.optional])
    for (const key of Object.keys(item)) {
      if (!allowed.has(key)) {
        pushViolation(
          violations,
          'UNKNOWN_PARAM',
          `${path}.${key}`,
          `kind=${kind} 没有 ${key} 这个键（允许：${[...allowed].join(', ')}）`,
        )
      }
    }
    for (const key of spec.required) {
      if (item[key] === undefined) {
        pushViolation(violations, 'MISSING_REQUIRED', `${path}.${key}`, `kind=${kind} 缺少必填键 ${key}`)
      }
    }
    // 逐字段类型
    const uuidKeys = [
      'id', 'interviewer_id', 'actor_id', 'decision_id', 'opened_by_actor_id',
      // S7 写侧（§17.1）
      'rubric_version_id', 'resume_version_id',
    ]
    for (const key of uuidKeys) {
      const value = item[key]
      if (value !== undefined && !isUuid(value)) {
        pushViolation(violations, 'ID_NOT_UUID', `${path}.${key}`, `${key} 必须是 UUID`)
      }
    }
    const hexKeys = [
      'payload_hash', 'summary_digest',
      // S7 写侧（§17.1）：评估摘要 / 原文 reasons 摘要 / 被评估的 rubric 与材料版本
      'evaluation_digest', 'reasons_digest', 'rubric_payload_hash', 'resume_content_sha256', 'content_sha256',
    ]
    for (const key of hexKeys) {
      const value = item[key]
      if (value !== undefined && (typeof value !== 'string' || !HEX64_RE.test(value))) {
        pushViolation(violations, 'TYPE_MISMATCH', `${path}.${key}`, `${key} 必须是 64 位小写 hex`)
      }
    }
    for (const key of ['revision_no', 'version_no', 'transcript_revision']) {
      const value = item[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value))) {
        pushViolation(violations, 'TYPE_MISMATCH', `${path}.${key}`, `${key} 必须是整数`)
      }
    }
    if (item.overall !== undefined && !['ADVANCE', 'HOLD', 'REJECT'].includes(item.overall as string)) {
      pushViolation(violations, 'ENUM_INVALID', `${path}.overall`, 'overall 只能是 ADVANCE/HOLD/REJECT')
    }
    if (item.transcript_basis !== undefined && !['TRANSCRIPT', 'NO_TRANSCRIPT'].includes(item.transcript_basis as string)) {
      pushViolation(violations, 'ENUM_INVALID', `${path}.transcript_basis`, 'transcript_basis 只能是 TRANSCRIPT/NO_TRANSCRIPT')
    }
    if (item.is_hiring_manager !== undefined && typeof item.is_hiring_manager !== 'boolean') {
      pushViolation(violations, 'TYPE_MISMATCH', `${path}.is_hiring_manager`, 'is_hiring_manager 必须是布尔')
    }
    if (item.acknowledged_dissent !== undefined && typeof item.acknowledged_dissent !== 'boolean') {
      pushViolation(violations, 'TYPE_MISMATCH', `${path}.acknowledged_dissent`, 'acknowledged_dissent 必须是布尔')
    }
    // S7 写侧（§17.1）：verdict / criteria_evaluated / counts 的形状
    if (item.verdict !== undefined && !['PASS', 'FAIL', 'NEEDS_REVIEW'].includes(item.verdict as string)) {
      pushViolation(violations, 'ENUM_INVALID', `${path}.verdict`, 'verdict 只能是 PASS/FAIL/NEEDS_REVIEW（SR §5）')
    }
    if (item.criteria_evaluated !== undefined && typeof item.criteria_evaluated !== 'boolean') {
      pushViolation(violations, 'TYPE_MISMATCH', `${path}.criteria_evaluated`, 'criteria_evaluated 必须是布尔')
    }
    if (item.counts !== undefined && !isPlainObject(item.counts)) {
      pushViolation(violations, 'TYPE_MISMATCH', `${path}.counts`, 'counts 必须是对象')
    }
    if (item.fields !== undefined) {
      if (!Array.isArray(item.fields)) {
        pushViolation(violations, 'TYPE_MISMATCH', `${path}.fields`, 'fields 必须是数组')
      } else {
        item.fields.forEach((field, fieldIndex) => {
          const fieldPath = `${path}.fields[${fieldIndex}]`
          if (!isPlainObject(field)) {
            pushViolation(violations, 'TYPE_MISMATCH', fieldPath, 'fields 的元素必须是对象')
            return
          }
          for (const key of Object.keys(field)) {
            if (!['dimension_key', 'assessment', 'evidence'].includes(key)) {
              pushViolation(violations, 'UNKNOWN_PARAM', `${fieldPath}.${key}`, `fields 元素没有 ${key} 这个键`)
            }
          }
          if (!nonEmptyString(field.dimension_key)) {
            pushViolation(violations, 'MISSING_REQUIRED', `${fieldPath}.dimension_key`, '必须给 dimension_key')
          }
          if (!(ASSESSMENTS as readonly string[]).includes(field.assessment as string)) {
            pushViolation(
              violations,
              'ENUM_INVALID',
              `${fieldPath}.assessment`,
              'assessment 只能是 MET/NOT_MET/NOT_OBSERVED/UNREADABLE（SC §4.5）',
            )
          }
          if (field.evidence !== undefined && !Array.isArray(field.evidence)) {
            pushViolation(violations, 'TYPE_MISMATCH', `${fieldPath}.evidence`, 'evidence 必须是数组')
          }
        })
      }
    }
    if (item.interviewer_ids !== undefined) {
      if (!Array.isArray(item.interviewer_ids) || item.interviewer_ids.length === 0) {
        pushViolation(violations, 'MISSING_REQUIRED', `${path}.interviewer_ids`, 'interviewer_ids 必须是非空数组')
      } else {
        item.interviewer_ids.forEach((id, idIndex) => {
          if (!isUuid(id)) {
            pushViolation(violations, 'ID_NOT_UUID', `${path}.interviewer_ids[${idIndex}]`, 'interviewer_id 必须是 UUID')
          }
        })
      }
    }
    out.push(item)
  })
  return out
}

/**
 * STEP 0：入参校验（**一次收集全部违反项**，然后按第一条抛 `INVALID_ARGS`）。
 *
 * 只做形状与闭集；`DECISION_REASON_NO_DIMENSION`（要查 rubric）、`SUMMARY_STALE`
 * （要重算）、`MISSING_ACK_*`（要汇总）都在后面的 STEP 里。
 * @param raw - 模型给的 arguments。
 * @param nowMs - 服务端当前毫秒（`as_of` 的上界）。
 * @returns 已归一化的入参。
 * @throws RecruitmentToolError - `INVALID_ARGS`，`detail.violations[]` 列出全部违反项。
 */
export function parseDecisionArgs(raw: unknown, nowMs: number): DecisionArgs {
  if (!isPlainObject(raw)) {
    throw evalError('INVALID_ARGS', 'TYPE_MISMATCH', 'arguments 必须是 JSON 对象', { path: 'arguments' })
  }
  const violations: Violation[] = []
  const reserved = new Set<string>(RESERVED_KEYS)

  // 1) 未知键 / 保留键
  for (const key of Object.keys(raw).sort()) {
    if (reserved.has(key)) {
      pushViolation(
        violations,
        'TENANT_OR_ACTOR_NOT_ALLOWED',
        key,
        `${key} 只能来自执行上下文/工具自身，不接受入参（TC §1.6）`,
      )
      continue
    }
    if (!Object.hasOwn(PARAMETERS.properties as Record<string, unknown>, key)) {
      pushViolation(
        violations,
        'UNKNOWN_PARAM',
        key,
        `未知参数 ${key}（允许：${Object.keys(PARAMETERS.properties as Record<string, unknown>).join(', ')}）`,
      )
    }
  }

  // 2) 必填（human_confirmation 例外：缺整个对象 → STEP 1 的 NO_HUMAN_CONFIRMATION；
  //    `summary_digest` 例外：SCREENING 没有 S10 汇总，不要求也不接受，见 STEP 0 下方）
  const required = ['application_id', 'decision_scope', 'as_of', 'result', 'reason', 'basis_refs']
  if (raw.decision_scope !== 'SCREENING') required.push('summary_digest')
  for (const key of required) {
    if (raw[key] === undefined) {
      pushViolation(violations, 'MISSING_REQUIRED', key, `缺少必填参数 ${key}`)
    }
  }

  const applicationId = raw.application_id
  if (applicationId !== undefined && !isUuid(applicationId)) {
    pushViolation(violations, 'ID_NOT_UUID', 'application_id', 'application_id 必须是 UUID')
  }
  const scope = raw.decision_scope
  const screeningScope = scope === 'SCREENING'
  if (scope !== undefined) {
    if (scope !== 'SCREENING' && scope !== 'STAGE' && scope !== 'FINAL') {
      pushViolation(
        violations,
        'ENUM_INVALID',
        'decision_scope',
        'decision_scope 只能是 SCREENING / STAGE / FINAL（DC-06 + §17.1；SCREENING 是 S7 写侧）',
      )
    }
  }
  const interviewId = raw.interview_id
  if (interviewId !== undefined && !isUuid(interviewId)) {
    pushViolation(violations, 'ID_NOT_UUID', 'interview_id', 'interview_id 必须是 UUID')
  }
  if (scope === 'STAGE' && interviewId === undefined) {
    pushViolation(violations, 'STAGE_REQUIRES_INTERVIEW', 'interview_id', 'STAGE 决策必须给 interview_id（DC-06）')
  }
  if (scope === 'FINAL' && interviewId !== undefined) {
    pushViolation(violations, 'FINAL_SCOPE_NO_INTERVIEW', 'interview_id', 'FINAL 决策不得给 interview_id（DC-06）')
  }
  if (screeningScope && interviewId !== undefined) {
    // S7 还没有面试：SCREENING 不是"某一场面试的决策"（§17.1）。
    pushViolation(violations, 'SCREENING_SCOPE_NO_INTERVIEW', 'interview_id', 'SCREENING 决策不得给 interview_id（S7 没有面试，§17.1）')
  }
  const asOf = raw.as_of
  if (asOf !== undefined) {
    if (typeof asOf !== 'string' || !ISO_WITH_OFFSET_RE.test(asOf)) {
      // DESIGN §2：TC §5.1 没有 AS_OF_FORMAT，格式错按 TYPE_MISMATCH。
      pushViolation(violations, 'TYPE_MISMATCH', 'as_of', 'as_of 必须是带时区偏移的 ISO-8601 时间')
    } else {
      const checked = checkAsOf(asOf, nowMs)
      if (checked.ok !== true) {
        pushViolation(violations, checked.reason_code === 'AS_OF_FORMAT' ? 'TYPE_MISMATCH' : 'AS_OF_IN_FUTURE', 'as_of', checked.message)
      }
    }
  }
  const result = raw.result
  if (result !== undefined) {
    if (result === 'HIRED') {
      pushViolation(violations, 'RESULT_NOT_IN_V1_SCOPE', 'result', 'HIRED 在 v1.0 禁用（S11 缓做）')
    } else if (!['ADVANCE', 'HOLD', 'REJECT', 'WITHDRAW'].includes(result as string)) {
      pushViolation(violations, 'ENUM_INVALID', 'result', 'result 只能是 ADVANCE/HOLD/REJECT/WITHDRAW')
    }
  }
  const reason = raw.reason
  if (reason !== undefined) {
    if (typeof reason !== 'string') {
      pushViolation(violations, 'TYPE_MISMATCH', 'reason', 'reason 必须是字符串')
    } else if (reason.length === 0) {
      pushViolation(violations, 'TYPE_MISMATCH', 'reason', 'reason 不能是空字符串')
    } else if (reason.trim().length === 0) {
      pushViolation(violations, 'OUT_OF_RANGE', 'reason', 'reason 不能只有空白')
    } else if (reason.length > REASON_MAX) {
      pushViolation(violations, 'OUT_OF_RANGE', 'reason', `reason 最多 ${REASON_MAX} 字符`)
    }
  }
  const basisRefs = raw.basis_refs !== undefined ? checkBasisRefs(raw.basis_refs, violations, scope) : []
  const summaryDigest = raw.summary_digest
  if (summaryDigest !== undefined) {
    if (screeningScope) {
      // S7 没有 S10 汇总；存一个无法复算的 digest 等于留一条假绑定（§17.1）。
      pushViolation(violations, 'SCREENING_SCOPE_NO_SUMMARY', 'summary_digest', 'SCREENING 决策没有 S10 汇总，不接受 summary_digest（§17.1）')
    } else if (typeof summaryDigest !== 'string' || !HEX64_RE.test(summaryDigest)) {
      pushViolation(violations, 'TYPE_MISMATCH', 'summary_digest', 'summary_digest 必须是 64 位小写 hex')
    }
  }
  const humanConfirmation = raw.human_confirmation
  if (humanConfirmation !== undefined) {
    if (!isPlainObject(humanConfirmation)) {
      pushViolation(violations, 'TYPE_MISMATCH', 'human_confirmation', 'human_confirmation 必须是对象')
    } else {
      for (const key of Object.keys(humanConfirmation)) {
        if (!['confirmed_by_actor_id', 'confirmed_at', 'confirmation_method', 'confirmation_text_sha256', 'confirmation_text'].includes(key)) {
          pushViolation(violations, 'UNKNOWN_PARAM', `human_confirmation.${key}`, `human_confirmation 没有 ${key} 这个键`)
        }
      }
      const confirmedBy = humanConfirmation.confirmed_by_actor_id
      if (confirmedBy !== undefined && !isUuid(confirmedBy)) {
        pushViolation(violations, 'ID_NOT_UUID', 'human_confirmation.confirmed_by_actor_id', 'confirmed_by_actor_id 必须是 UUID')
      }
      const confirmedAt = humanConfirmation.confirmed_at
      if (confirmedAt !== undefined && (typeof confirmedAt !== 'string' || !ISO_WITH_OFFSET_RE.test(confirmedAt))) {
        pushViolation(
          violations,
          'TYPE_MISMATCH',
          'human_confirmation.confirmed_at',
          'confirmed_at 必须是带时区偏移的 ISO-8601 时间',
        )
      }
      const method = humanConfirmation.confirmation_method
      if (method !== undefined && !['IN_CHAT', 'IN_APP_CONFIRM', 'SIGNED_RECORD'].includes(method as string)) {
        pushViolation(
          violations,
          'ENUM_INVALID',
          'human_confirmation.confirmation_method',
          'confirmation_method 只能是 IN_CHAT / IN_APP_CONFIRM / SIGNED_RECORD',
        )
      }
      // D-95：人在对话里说过的原话是 IN_CHAT 的授权凭据 —— 必须逐字、非空、有长度上限。
      const confirmText = humanConfirmation.confirmation_text
      if (confirmText !== undefined && (typeof confirmText !== 'string' || confirmText.trim() === '')) {
        pushViolation(
          violations,
          'TYPE_MISMATCH',
          'human_confirmation.confirmation_text',
          'confirmation_text 必须是非空字符串（人的原话）',
        )
      }
      if (typeof confirmText === 'string' && confirmText.length > 2000) {
        pushViolation(
          violations,
          'TYPE_MISMATCH',
          'human_confirmation.confirmation_text',
          'confirmation_text 不能超过 2000 字符',
        )
      }
      if (method === 'IN_CHAT' && confirmText === undefined) {
        pushViolation(
          violations,
          'MISSING_REQUIRED',
          'human_confirmation.confirmation_text',
          'confirmation_method=IN_CHAT 必须带 confirmation_text（人的原话，D-95）',
        )
      }
      const textHash = humanConfirmation.confirmation_text_sha256
      if (textHash !== undefined && (typeof textHash !== 'string' || !HEX64_ANY_CASE_RE.test(textHash))) {
        pushViolation(
          violations,
          'TYPE_MISMATCH',
          'human_confirmation.confirmation_text_sha256',
          'confirmation_text_sha256 必须是 64 位 hex',
        )
      }
    }
  }
  const disposition = raw.missing_disposition
  if (disposition !== undefined && disposition !== 'PROCEED_WITH_MISSING') {
    pushViolation(violations, 'ENUM_INVALID', 'missing_disposition', 'missing_disposition 只能是 PROCEED_WITH_MISSING')
  }
  const ackRaw = raw.acknowledged_missing
  const ack: AcknowledgedMissing[] = []
  if (ackRaw !== undefined) {
    if (!Array.isArray(ackRaw)) {
      pushViolation(violations, 'TYPE_MISMATCH', 'acknowledged_missing', 'acknowledged_missing 必须是数组')
    } else {
      const seen = new Set<string>()
      ackRaw.forEach((entry, index) => {
        const path = `acknowledged_missing[${index}]`
        if (!isPlainObject(entry)) {
          pushViolation(violations, 'TYPE_MISMATCH', path, 'acknowledged_missing 的元素必须是对象')
          return
        }
        for (const key of Object.keys(entry)) {
          if (!['interviewer_id', 'why_proceed'].includes(key)) {
            pushViolation(violations, 'UNKNOWN_PARAM', `${path}.${key}`, `acknowledged_missing 没有 ${key} 这个键`)
          }
        }
        if (!isUuid(entry.interviewer_id)) {
          pushViolation(violations, 'ID_NOT_UUID', `${path}.interviewer_id`, 'interviewer_id 必须是 UUID')
          return
        }
        const key = entry.interviewer_id.toLowerCase()
        if (seen.has(key)) {
          pushViolation(violations, 'OUT_OF_RANGE', `${path}.interviewer_id`, '同一个 interviewer 不得出现两次（TC §1.1 第 6 条）')
          return
        }
        seen.add(key)
        const why = entry.why_proceed
        if (typeof why !== 'string') {
          pushViolation(violations, 'TYPE_MISMATCH', `${path}.why_proceed`, 'why_proceed 必须是字符串')
        } else if (why.trim().length === 0) {
          pushViolation(violations, 'OUT_OF_RANGE', `${path}.why_proceed`, 'why_proceed 不得为空白')
        } else if (why.length > WHY_PROCEED_MAX) {
          pushViolation(violations, 'OUT_OF_RANGE', `${path}.why_proceed`, `why_proceed 最多 ${WHY_PROCEED_MAX} 字符`)
        }
        ack.push({ interviewer_id: entry.interviewer_id, why_proceed: why as string })
      })
    }
  }
  // 缺人确认只对 ADVANCE(STAGE) 有意义；FINAL 是「不适用」而不是「参数错误」（TC §4.1）。
  if (result !== undefined && result !== 'ADVANCE' && (disposition !== undefined || ack.length > 0)) {
    pushViolation(
      violations,
      'MUTUALLY_EXCLUSIVE',
      'missing_disposition',
      'missing_disposition/acknowledged_missing 只对 ADVANCE 有效（DC §4.2 矩阵）',
    )
  }
  const dissent = raw.acknowledged_dissent
  if (dissent !== undefined && typeof dissent !== 'boolean') {
    pushViolation(violations, 'TYPE_MISMATCH', 'acknowledged_dissent', 'acknowledged_dissent 必须是布尔')
  }
  const overrideRationale = raw.override_rationale
  if (overrideRationale !== undefined) {
    if (typeof overrideRationale !== 'string') {
      pushViolation(violations, 'TYPE_MISMATCH', 'override_rationale', 'override_rationale 必须是字符串')
    } else if (overrideRationale.trim().length === 0) {
      pushViolation(violations, 'OUT_OF_RANGE', 'override_rationale', 'override_rationale 不得为空白')
    } else if (overrideRationale.length > REASON_MAX) {
      pushViolation(violations, 'OUT_OF_RANGE', 'override_rationale', `override_rationale 最多 ${REASON_MAX} 字符`)
    }
  }
  if (screeningScope) {
    // S7 写侧（§17.1）：没有 S10 汇总 → 没有"缺面评确认"/"与 consensus 相反"这两个概念。
    if (disposition !== undefined || ack.length > 0) {
      pushViolation(
        violations,
        'MUTUALLY_EXCLUSIVE',
        'missing_disposition',
        'SCREENING 没有面评面板，不接受 missing_disposition/acknowledged_missing（§17.1）',
      )
    }
    if (dissent !== undefined) {
      pushViolation(violations, 'MUTUALLY_EXCLUSIVE', 'acknowledged_dissent', 'SCREENING 没有 consensus，不接受 acknowledged_dissent（§17.1）')
    }
    if (overrideRationale !== undefined) {
      pushViolation(violations, 'MUTUALLY_EXCLUSIVE', 'override_rationale', 'SCREENING 没有 consensus，不接受 override_rationale（理由写 reason，§17.1）')
    }
  }
  let supersedes: SupersedesArgs | undefined
  const supersedesRaw = raw.supersedes
  if (supersedesRaw !== undefined) {
    if (!isPlainObject(supersedesRaw)) {
      pushViolation(violations, 'TYPE_MISMATCH', 'supersedes', 'supersedes 必须是对象')
    } else {
      for (const key of Object.keys(supersedesRaw)) {
        if (!['decision_id', 'reason', 'expected_record_version'].includes(key)) {
          pushViolation(violations, 'UNKNOWN_PARAM', `supersedes.${key}`, `supersedes 没有 ${key} 这个键`)
        }
      }
      for (const key of ['decision_id', 'reason', 'expected_record_version']) {
        if (supersedesRaw[key] === undefined) {
          pushViolation(violations, 'MISSING_REQUIRED', `supersedes.${key}`, `supersedes 缺少 ${key}`)
        }
      }
      if (supersedesRaw.decision_id !== undefined && !isUuid(supersedesRaw.decision_id)) {
        pushViolation(violations, 'ID_NOT_UUID', 'supersedes.decision_id', 'decision_id 必须是 UUID')
      }
      const superReason = supersedesRaw.reason
      if (superReason !== undefined) {
        if (typeof superReason !== 'string') {
          pushViolation(violations, 'TYPE_MISMATCH', 'supersedes.reason', 'reason 必须是字符串')
        } else if (superReason.trim().length === 0) {
          pushViolation(violations, 'OUT_OF_RANGE', 'supersedes.reason', 'reason 不得为空白（DC-33）')
        } else if (superReason.length > REASON_MAX) {
          pushViolation(violations, 'OUT_OF_RANGE', 'supersedes.reason', `reason 最多 ${REASON_MAX} 字符`)
        }
      }
      const expected = supersedesRaw.expected_record_version
      if (expected !== undefined) {
        if (typeof expected !== 'number' || !Number.isInteger(expected)) {
          pushViolation(violations, 'TYPE_MISMATCH', 'supersedes.expected_record_version', 'expected_record_version 必须是整数')
        } else if (expected < 1) {
          pushViolation(violations, 'OUT_OF_RANGE', 'supersedes.expected_record_version', 'expected_record_version 必须 ≥ 1')
        }
      }
      if (isUuid(supersedesRaw.decision_id) && nonEmptyString(superReason)
        && typeof expected === 'number' && Number.isInteger(expected) && expected >= 1) {
        supersedes = { decision_id: supersedesRaw.decision_id, reason: superReason, expected_record_version: expected }
      }
    }
  }
  const approvalId = raw.approval_id
  if (approvalId !== undefined && !isUuid(approvalId)) {
    pushViolation(violations, 'ID_NOT_UUID', 'approval_id', 'approval_id 必须是 UUID')
  }

  if (violations.length > 0) {
    const first = violations[0] as Violation
    throw evalError('INVALID_ARGS', first.reason_code, '参数不合法，逐条见 detail.violations', {
      allowed: Object.keys(PARAMETERS.properties as Record<string, unknown>),
      violations,
    })
  }

  const args: DecisionArgs = {
    application_id: applicationId as string,
    decision_scope: scope as 'SCREENING' | 'STAGE' | 'FINAL',
    ...(interviewId === undefined ? {} : { interview_id: interviewId as string }),
    as_of: asOf as string,
    result: result as DecisionArgs['result'],
    reason: reason as string,
    basis_refs: basisRefs,
    ...(summaryDigest === undefined ? {} : { summary_digest: summaryDigest as string }),
    ...(humanConfirmation === undefined ? {} : { human_confirmation: humanConfirmation as Record<string, unknown> }),
    ...(disposition === undefined ? {} : { missing_disposition: disposition as 'PROCEED_WITH_MISSING' }),
    acknowledged_missing: ack,
    ...(dissent === undefined ? {} : { acknowledged_dissent: dissent as boolean }),
    ...(overrideRationale === undefined ? {} : { override_rationale: overrideRationale as string }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(approvalId === undefined ? {} : { approval_id: approvalId as string }),
  }
  return args
}

// =====================================================================
//  STEP 1：人工确认（DC-08/09/10/11）
// =====================================================================

/** v1 pre-image（旧口径，2026-11-14 之前落库的记录）：**只有这四个键**。 */
export interface ConfirmationPreimageV1 {
  readonly result: string
  readonly reason: string
  readonly override_rationale: string | null
  readonly basis_refs: readonly unknown[]
}

/** v2 pre-image（D-95，`IN_CHAT`）：v1 四键 + 原话 + 确认人 + 确认时间（+ 版本标记）。 */
export interface ConfirmationPreimageV2 extends ConfirmationPreimageV1 {
  readonly confirmation_text: string
  readonly confirmed_by_actor_id: string
  readonly confirmed_at: string
}

/**
 * `confirmation_text_sha256` 的 pre-image（DC-11 + D-95，**版本化**）。
 *
 * **v1**（无原话的确认方式：`IN_APP_CONFIRM` / `SIGNED_RECORD`；也是 2026-11-14 之前
 * 所有记录的口径）：
 *   `{result, reason, override_rationale, basis_refs}` —— **四键，绝不加键**。
 *   库里已落的旧 sha256 就是按这个算的；往 v1 里加任何一个键，旧记录全部验不过
 *   （那会把"历史记录"变成假红，也是本函数必须同时保留 v1 的唯一理由）。
 *
 * **v2**（D-95，`IN_CHAT`：人只做一次决策，原话就是授权凭据）：
 *   v1 四键 + `{preimage_version: 2, confirmation_text, confirmed_by_actor_id, confirmed_at}`。
 *   多出的三个键把"人说过的那句话"绑进 hash —— 改原话、改确认人、改确认时间，
 *   hash 都会变；审计时"原话 + hash + 会话日志"三者必须对得上。
 *
 * 版本由入参决定（**不猜**）：传了非空 `confirmation_text` → v2；没传 → v1。
 * @param input - v1 四元组，或 v2 的七元组。
 * @returns `sha256(canonical_json(...))`，小写 hex。
 */
export function confirmationTextSha256(input: ConfirmationPreimageV1 | ConfirmationPreimageV2): string {
  const text = (input as Partial<ConfirmationPreimageV2>).confirmation_text
  if (text !== undefined) {
    const confirmedBy = (input as Partial<ConfirmationPreimageV2>).confirmed_by_actor_id
    const confirmedAt = (input as Partial<ConfirmationPreimageV2>).confirmed_at
    if (typeof text !== 'string' || text.trim() === ''
      || typeof confirmedBy !== 'string' || confirmedBy === ''
      || typeof confirmedAt !== 'string' || confirmedAt === '') {
      throw new TypeError(
        'confirmationTextSha256: v2 pre-image 需要 confirmation_text + confirmed_by_actor_id + confirmed_at（D-95）',
      )
    }
    return digestOf({
      preimage_version: 2,
      result: input.result,
      reason: input.reason,
      override_rationale: input.override_rationale,
      basis_refs: input.basis_refs,
      confirmation_text: text,
      confirmed_by_actor_id: confirmedBy,
      confirmed_at: confirmedAt,
    })
  }
  // v1：键集合与旧实现**逐字相同**（DC-11 原口径；旧记录按旧口径验）。
  return digestOf({
    result: input.result,
    reason: input.reason,
    override_rationale: input.override_rationale,
    basis_refs: input.basis_refs,
  })
}

/**
 * STEP 1：身份 + 人工确认四校验（顺序：kind → 四字段齐全 → 确认人 → 内容 hash → 时间）。
 *
 * `approval`（D-79）**不是**它的替代品：两者都要（DESIGN §3.5 ④）。
 * @param input - 上下文 actor 与该次决策的待确认内容。
 * @throws RecruitmentToolError - `DECISION_REQUIRES_HUMAN` 的五个 reason_code。
 */
export function assertHumanDecider(input: {
  readonly actorId: string
  readonly actorKind: string
  readonly confirmation: unknown
  readonly nowMs: number
  readonly result: string
  readonly reason: string
  readonly overrideRationale: string | null
  readonly basisRefs: readonly unknown[]
}): void {
  // DC-10：actor.kind 必须是 HUMAN（SYSTEM / AGENT_WORKER 一律拒）。
  if (input.actorKind !== 'HUMAN') {
    throw evalError(
      'DECISION_REQUIRES_HUMAN',
      'DECIDER_NOT_HUMAN',
      '决策只能由人做出：上下文 actor 的 kind 不是 HUMAN（DC-10）',
      { actor_id: input.actorId, actor_kind: input.actorKind },
    )
  }
  // DC-08：四要素齐全。
  if (!isPlainObject(input.confirmation)) {
    throw evalError(
      'DECISION_REQUIRES_HUMAN',
      'NO_HUMAN_CONFIRMATION',
      '缺少 human_confirmation（决策必须带人工确认标记，DC-08）',
      { required: ['confirmed_by_actor_id', 'confirmed_at', 'confirmation_method', 'confirmation_text_sha256'] },
    )
  }
  const confirmation = input.confirmation
  const missing = ['confirmed_by_actor_id', 'confirmed_at', 'confirmation_method', 'confirmation_text_sha256']
    .filter((key) => !nonEmptyString(confirmation[key]))
  if (missing.length > 0) {
    throw evalError(
      'DECISION_REQUIRES_HUMAN',
      'NO_HUMAN_CONFIRMATION',
      'human_confirmation 四要素不齐（DC-08）',
      { missing },
    )
  }
  // DC-09：不能替别人确认。
  if (String(confirmation.confirmed_by_actor_id).toLowerCase() !== input.actorId.toLowerCase()) {
    throw evalError(
      'DECISION_REQUIRES_HUMAN',
      'CONFIRMATION_SUBJECT_MISMATCH',
      '确认人必须就是执行上下文的 actor（不能替别人确认，DC-09）',
      { confirmed_by_actor_id: confirmation.confirmed_by_actor_id, actor_id: input.actorId },
    )
  }
  // DC-11 + D-95：人确认的是**这一版**内容；IN_CHAT 的原话必须进 v2 pre-image。
  const method = String(confirmation.confirmation_method)
  const confirmationText = typeof confirmation.confirmation_text === 'string' && confirmation.confirmation_text.trim() !== ''
    ? confirmation.confirmation_text
    : undefined
  if (method === 'IN_CHAT' && confirmationText === undefined) {
    // D-95：原话是"人只决策一次"的授权凭据，缺它就不是 IN_CHAT 的确认。
    throw evalError(
      'DECISION_REQUIRES_HUMAN',
      'NO_HUMAN_CONFIRMATION',
      'confirmation_method=IN_CHAT 必须带 confirmation_text（人的原话，D-95）',
      { missing: ['confirmation_text'], confirmation_method: method },
    )
  }
  const v1Preimage = {
    result: input.result,
    reason: input.reason,
    override_rationale: input.overrideRationale,
    basis_refs: input.basisRefs,
  }
  const expected = confirmationText === undefined
    ? confirmationTextSha256(v1Preimage)
    : confirmationTextSha256({
      ...v1Preimage,
      confirmation_text: confirmationText,
      confirmed_by_actor_id: String(confirmation.confirmed_by_actor_id),
      confirmed_at: String(confirmation.confirmed_at),
    })
  const preimageVersion = confirmationText === undefined ? 1 : 2
  if (String(confirmation.confirmation_text_sha256).toLowerCase() !== expected) {
    throw evalError(
      'DECISION_REQUIRES_HUMAN',
      'CONFIRMATION_TEXT_MISMATCH',
      confirmationText === undefined
        ? 'confirmation_text_sha256 与服务端按 {result, reason, override_rationale, basis_refs} 算出的 hash 不一致（DC-11）'
        : 'confirmation_text_sha256 与服务端按 v2 pre-image（含 confirmation_text，D-95）算出的 hash 不一致',
      { expected, provided: confirmation.confirmation_text_sha256, preimage_version: preimageVersion },
    )
  }
  // 时间窗：≤ now 且相差 ≤ 24h（TC §4.2）。
  const confirmedAt = Date.parse(String(confirmation.confirmed_at))
  if (!Number.isFinite(confirmedAt)) {
    throw evalError('DECISION_REQUIRES_HUMAN', 'CONFIRMATION_STALE', 'confirmed_at 不是可解析的时间', {
      confirmed_at: confirmation.confirmed_at,
    })
  }
  const skew = input.nowMs - confirmedAt
  if (skew < 0 || skew > CONFIRMATION_MAX_AGE_MS) {
    throw evalError(
      'DECISION_REQUIRES_HUMAN',
      'CONFIRMATION_STALE',
      'confirmed_at 必须不晚于决策时刻、且与它相差不超过 24 小时（TC §4.2）',
      { confirmed_at: confirmation.confirmed_at, decided_at: new Date(input.nowMs).toISOString(), skew_ms: skew },
    )
  }
}

// =====================================================================
//  D-79 approval 接线（STEP 6.5）
// =====================================================================

/**
 * 把 DSH `ctx.approval` 的窄接口包成"可等待的批准结果"。**缺依赖 = `unavailable`**，
 * 因此 headless（没有 answerer）恒 fail closed（DESIGN §3.5 ④）。
 * @param approval - 依赖里的 approval 服务（可缺省）。
 * @param exec - 执行上下文（`agent` / `signal` 透传给宿主）。
 * @returns 一个返回 `ApprovalOutcome` 的函数；结果不在封闭集内时归 `unavailable`。
 */
export function makeApprovalRequest(
  approval: DecisionToolDeps['approval'],
  exec: { readonly agent?: unknown; readonly signal?: AbortSignal } | undefined,
): () => Promise<ApprovalOutcome> {
  return async (): Promise<ApprovalOutcome> => {
    if (approval === undefined) return 'unavailable'
    const raw = await approval.request({
      agent: exec?.agent,
      toolName: TOOL_NAME,
      reason: 'S10 正式决策需要人工确认（D-79）',
      signal: exec?.signal,
    })
    if (raw === 'allowed-once' || raw === 'rejected' || raw === 'cancelled' || raw === 'unavailable') return raw
    // 宿主返回了封闭集之外的字符串：**不猜**，按不可用处理（fail closed）。
    return 'unavailable'
  }
}

/**
 * STEP 6.5：只有 `allowed-once` 才允许落库。
 * @param outcome - `approve()` 的结果。
 * @throws RecruitmentToolError - `APPROVAL_UNAVAILABLE` / `APPROVAL_NOT_GRANTED`。
 */
export function requireApprovalGranted(outcome: ApprovalOutcome): void {
  if (outcome === 'unavailable') {
    throw evalError(
      'DECISION_REQUIRES_HUMAN',
      'APPROVAL_UNAVAILABLE',
      '没有可用的批准通道（headless 无 answerer）：正式决策不放行（D-79，fail closed）',
      { approval: 'unavailable' },
    )
  }
  if (outcome !== 'allowed-once') {
    throw evalError(
      'DECISION_REQUIRES_HUMAN',
      'APPROVAL_NOT_GRANTED',
      '人工没有批准这次决策（D-79）',
      { approval: outcome },
    )
  }
}

// =====================================================================
//  读库（全部参数化 SQL；不出现 FOR UPDATE —— D-80）
// =====================================================================

interface ActorRow {
  readonly id: string
  readonly kind: string
}

interface ApplicationRow {
  readonly id: string
  readonly candidate_id: string
  readonly job_id: string
  readonly rubric_version_id: string | null
  readonly resume_version_id: string | null
  readonly lifecycle_status: string
  readonly current_stage_code: string
}

/** `resume_version` 里 S7 写侧要核对的两个事实（§17.1）。 */
interface ResumeVersionRow {
  readonly id: string
  readonly content_sha256: string
}

interface AuthorityRow {
  readonly job_id: string
  readonly department_id: string | null
  readonly hiring_manager_actor_id: string | null
}

interface RubricRow {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly job_id: string
  readonly dimensions: readonly unknown[]
}

interface InterviewRow {
  readonly id: string
  readonly application_id: string
  readonly round_no: number
}

interface DecisionRow {
  readonly id: string
  readonly result: string
  readonly record_version: number
  readonly superseded_by_decision_id: string | null
  readonly application_id: string
  readonly decision_scope: string
  readonly stage_code: string | null
  readonly interview_id: string | null
  readonly decided_by_actor_id: string
}

interface ScorecardRow {
  readonly id: string
  readonly interview_id: string
  readonly interviewer_id: string
  readonly overall: string | null
  readonly status: string
  readonly revision_no: number
  readonly payload_hash: string | null
  readonly items: Record<string, unknown> | null
  readonly superseded_by_scorecard_id: string | null
  readonly application_id: string
}

/** 当前事务的 actor（DESIGN §3.5 ①：**不是** `cfg.actor_id`）。 */
async function currentActorId(client: DatabaseClient): Promise<string | null> {
  const { rows } = await client.query<{ actor_id: string | null }>(
    "select nullif(current_setting('recruitment.actor_id', true), '') as actor_id",
  )
  const value = rows[0]?.actor_id
  return typeof value === 'string' && value !== '' ? value : null
}

async function loadActor(client: DatabaseClient, tenantId: string, actorId: string): Promise<ActorRow | undefined> {
  const { rows } = await client.query<ActorRow>(
    'select a.id, a.kind from recruitment.actor a where a.id = $1 and a.tenant_id = $2',
    [actorId, tenantId],
  )
  return rows[0]
}

async function loadApplication(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationRow> {
  const { rows } = await client.query<ApplicationRow>(
    `select a.id, a.candidate_id, a.job_id, a.rubric_version_id, a.resume_version_id,
            a.lifecycle_status, a.current_stage_code
       from recruitment.application a
      where a.id = $1 and a.tenant_id = $2`,
    [applicationId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError('NOT_FOUND', 'APPLICATION_NOT_FOUND', '该租户下没有这个申请', {
      application_id: applicationId,
    })
  }
  return row
}

async function loadAuthority(client: DatabaseClient, tenantId: string, jobId: string): Promise<AuthorityRow> {
  const { rows } = await client.query<AuthorityRow>(
    `select j.id as job_id, j.department_id, d.hiring_manager_actor_id
       from recruitment.job j
       left join recruitment.department d
              on d.id = j.department_id and d.tenant_id = j.tenant_id
      where j.id = $1 and j.tenant_id = $2`,
    [jobId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    // 复合外键保证 application.job_id 存在；走到这里说明数据坏了 → 按申请不存在之外的最稳口径。
    throw evalError('NOT_FOUND', 'APPLICATION_NOT_FOUND', '申请指向的岗位不存在（数据不一致）', { job_id: jobId })
  }
  return row
}

async function loadRubricVersion(
  client: DatabaseClient,
  tenantId: string,
  rubricVersionId: string,
): Promise<RubricRow> {
  const { rows } = await client.query<RubricRow>(
    `select id, version_no, payload_hash, job_id, dimensions
       from recruitment.rubric_version
      where id = $1 and tenant_id = $2`,
    [rubricVersionId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', '该租户下没有这个 Rubric 版本', {
      rubric_version_id: rubricVersionId,
    })
  }
  return row
}

/**
 * 读一份材料版本（S7 写侧核对用，§17.1）：`content_sha256` 是 screening 评估的输入事实之一。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param resumeVersionId - `resume_version.id`。
 */
async function loadResumeVersion(
  client: DatabaseClient,
  tenantId: string,
  resumeVersionId: string,
): Promise<ResumeVersionRow> {
  const { rows } = await client.query<ResumeVersionRow>(
    `select id, content_sha256
       from recruitment.resume_version
      where id = $1 and tenant_id = $2`,
    [resumeVersionId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError('NOT_FOUND', 'RESUME_VERSION_NOT_FOUND', '该租户下没有这份材料版本', {
      resume_version_id: resumeVersionId,
    })
  }
  return row
}

async function loadInterview(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  applicationId: string,
): Promise<InterviewRow> {
  const { rows } = await client.query<InterviewRow>(
    `select i.id, i.application_id, i.round_no
       from recruitment.interview i
      where i.id = $1 and i.tenant_id = $2`,
    [interviewId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError('NOT_FOUND', 'INTERVIEW_NOT_FOUND', '该租户下没有这场面试', { interview_id: interviewId })
  }
  if (row.application_id !== applicationId) {
    throw evalError('NOT_FOUND', 'INTERVIEW_NOT_FOUND', '这场面试不属于该申请（不得静默择一）', {
      interview_id: interviewId,
      application_id: applicationId,
    })
  }
  return row
}

/**
 * 当前同类决策（`superseded_by_decision_id is null` + 同 scope + 同 stage_code）。
 *
 * `stageCode` 由 `decision_scope` 写死（S7→'S7'，S10→'S10'，`stageCodeOf`）：它与
 * `0008` 的 `uq_decision_current` 键（tenant, application, scope, coalesce(stage_code,'')）
 * 一致 —— 查的和库拦的必须是同一把尺子。
 * **不加 `FOR UPDATE`**：它锁不到不存在的行（D-80）。
 */
async function loadCurrentDecision(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  decisionScope: string,
  stageCode: string,
): Promise<DecisionRow | undefined> {
  const { rows } = await client.query<DecisionRow>(
    `select d.id, d.result, d.record_version, d.superseded_by_decision_id, d.application_id,
            d.decision_scope, d.stage_code, d.interview_id, d.decided_by_actor_id
       from recruitment.decision d
      where d.tenant_id = $1
        and d.application_id = $2
        and d.decision_scope = $3
        and d.stage_code is not distinct from $4
        and d.superseded_by_decision_id is null
      order by d.decided_at desc, d.created_at desc
      limit 1`,
    [tenantId, applicationId, decisionScope, stageCode],
  )
  return rows[0]
}

async function loadDecisionById(
  client: DatabaseClient,
  tenantId: string,
  decisionId: string,
): Promise<DecisionRow> {
  const { rows } = await client.query<DecisionRow>(
    `select d.id, d.result, d.record_version, d.superseded_by_decision_id, d.application_id,
            d.decision_scope, d.stage_code, d.interview_id, d.decided_by_actor_id
       from recruitment.decision d
      where d.id = $1 and d.tenant_id = $2`,
    [decisionId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError('NOT_FOUND', 'DECISION_NOT_FOUND', '该租户下没有这条决策', { decision_id: decisionId })
  }
  return row
}

async function loadScorecard(
  client: DatabaseClient,
  tenantId: string,
  scorecardId: string,
): Promise<ScorecardRow> {
  const { rows } = await client.query<ScorecardRow>(
    `select s.id, s.interview_id, s.interviewer_id, s.overall, s.status, s.revision_no,
            s.payload_hash, s.items, s.superseded_by_scorecard_id, i.application_id
       from recruitment.scorecard s
       join recruitment.interview i
         on i.id = s.interview_id and i.tenant_id = s.tenant_id
      where s.id = $1 and s.tenant_id = $2`,
    [scorecardId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError('NOT_FOUND', 'SCORECARD_NOT_FOUND', '依据引用的面评不存在', { scorecard_id: scorecardId })
  }
  return row
}

/** 本 scope 下的当前面评（只取 `SUBMITTED`/`WAIVED`；草稿互不可见，SC-34/35）。 */
async function loadScopeScorecards(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  interviewId: string | undefined,
): Promise<ScorecardRow[]> {
  const { rows } = await client.query<ScorecardRow>(
    `select s.id, s.interview_id, s.interviewer_id, s.overall, s.status, s.revision_no,
            s.payload_hash, s.items, s.superseded_by_scorecard_id, i.application_id
       from recruitment.scorecard s
       join recruitment.interview i
         on i.id = s.interview_id and i.tenant_id = s.tenant_id
      where s.tenant_id = $1
        and i.application_id = $2
        and s.superseded_by_scorecard_id is null
        and s.status in ('SUBMITTED','WAIVED')
        and ($3::uuid is null or i.id = $3)
      order by s.interviewer_id`,
    [tenantId, applicationId, interviewId ?? null],
  )
  return rows
}

// =====================================================================
//  汇总投影的读取（**只读、不重算**：唯一实现是 evaluation-summarize.ts）
// =====================================================================

interface BlockerView {
  readonly code: string
  readonly family: string
  readonly blocks_results: readonly string[]
  readonly detail: unknown
}

interface SummaryView {
  readonly raw: Record<string, unknown>
  readonly digest: string
  readonly ready: boolean
  readonly submitted: number
  readonly missing: readonly Record<string, unknown>[]
  readonly missingIds: readonly string[]
  readonly tallyReject: number
  readonly consensus: string
  readonly blockers: readonly BlockerView[]
  readonly permitted: readonly string[]
  readonly minorityCount: number
  readonly provenance: string
  readonly coverage: Record<string, unknown> | undefined
  readonly tally: Record<string, unknown> | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `permitted_results` 缺省时的保守回退（仍然只用汇总给的 blockers，不算第二份门禁）。 */
function derivePermitted(blockers: readonly BlockerView[]): string[] {
  const all = ['ADVANCE', 'HOLD', 'WITHDRAW', 'REJECT']
  const blocked = new Set<string>()
  for (const blocker of blockers) {
    for (const result of blocker.blocks_results) blocked.add(result)
  }
  return all.filter((result) => !blocked.has(result))
}

/** provenance 读不出来时**按 FIXTURE 处理**（R4：没有证据就不许自称 LIVE）。 */
function provenanceOf(summary: Record<string, unknown>): string {
  const labels = asRecord(summary.labels)
  const fromLabels = labels === undefined ? undefined : labels.provenance
  const direct = summary.provenance
  const value = typeof fromLabels === 'string' ? fromLabels : typeof direct === 'string' ? direct : ''
  return value === 'LIVE' ? 'LIVE' : 'FIXTURE'
}

/**
 * 把 `EvaluationSummary` 读成决策工具需要的那几个事实（DC §3.2 / TC §3.2）。
 * **不重算任何门禁**：`ready_for_decision`、`summary_digest`、`missing`、`tally`、
 * `coverage`、`blockers` 一律取汇总的输出。
 */
function readSummary(summary: EvaluationSummary): SummaryView {
  const raw = summary as unknown as Record<string, unknown>
  const digest = asString(raw.summary_digest)
  if (!HEX64_RE.test(digest)) {
    // 兄弟工具的返回不合形状：不能继续（否则等于"用没有绑定的汇总做决策"）。
    throw evalError('INVALID_ARGS', 'SUMMARY_STALE', '汇总没有返回合法的 summary_digest，无法绑定本次决策', {
      summary_digest: digest,
    })
  }
  const gate = asRecord(raw.gate)
  const topReady = typeof raw.ready_for_decision === 'boolean' ? raw.ready_for_decision : undefined
  const gateReady = gate !== undefined && typeof gate.ready_for_decision === 'boolean' ? gate.ready_for_decision : undefined
  const coverage = asRecord(raw.coverage)
  const tally = asRecord(raw.tally)
  const missing = asArray(raw.missing).filter((item): item is Record<string, unknown> => isPlainObject(item))
  const missingIds = missing
    .map((item) => asString(item.interviewer_id))
    .filter((id) => id !== '')
  const blockers: BlockerView[] = asArray(raw.blockers)
    .filter((item): item is Record<string, unknown> => isPlainObject(item))
    .map((item) => ({
      code: asString(item.code),
      family: asString(item.family),
      blocks_results: asArray(item.blocks_results).filter((value): value is string => typeof value === 'string'),
      detail: item.detail,
    }))
  const permittedRaw = asArray(raw.permitted_results).filter((value): value is string => typeof value === 'string')
  const permitted = permittedRaw.length > 0 ? permittedRaw : derivePermitted(blockers)
  return {
    raw,
    digest,
    ready: topReady ?? gateReady ?? false,
    submitted: asNumber(coverage?.submitted, 0),
    missing,
    missingIds,
    tallyReject: asNumber(tally?.reject, 0),
    consensus: asString(raw.consensus),
    blockers,
    permitted,
    minorityCount: asArray(raw.minority_reports).length,
    provenance: provenanceOf(raw),
    coverage,
    tally,
  }
}

// =====================================================================
//  basis_refs 的语义校验（DC-12..DC-19 / DC-29 / DC-33）
// =====================================================================

interface BasisContext {
  readonly args: DecisionArgs
  readonly view: SummaryView
  readonly application: ApplicationRow
  readonly rubric: RubricRow
  readonly actorId: string
  readonly isHiringManager: boolean
  readonly hiringManagerActorId: string | null
  readonly scorecards: readonly ScorecardRow[]
}

function refsOfKind(basis: readonly Record<string, unknown>[], kind: string): Record<string, unknown>[] {
  return basis.filter((ref) => ref.kind === kind)
}

/** `is_hiring_manager(actor, application)`（DC-15）：只从部门推，**不采信入参**。 */
function computeIsHiringManager(authority: AuthorityRow, actorId: string): boolean {
  return authority.hiring_manager_actor_id !== null
    && authority.hiring_manager_actor_id.toLowerCase() === actorId.toLowerCase()
}

/**
 * DC-19：`approval_id` 给了就必须真的绑到**这一条**决策上。
 *
 * 库只保证 `resource_type` 的枚举与"已决必有审批人+时间"（`0001:L448-449`、`L455-459`）；
 * `resource_id = 本决策 id` 与 `decided_at ≤ decision.decided_at` **只能由写侧校验**
 * （`approval.resource_id` 是普通 uuid 列，没有反向外键）。
 * 顺序陷阱（`G-3`）：`decision` 整行不可改 ⇒ 必须**预生成** decision id 才能先建 approval。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param approvalId - 入参 `approval_id`。
 * @param decisionId - 本次预生成的决策 id。
 * @param nowMs - 服务端"现在"。
 */
async function checkApprovalBinding(
  client: DatabaseClient,
  tenantId: string,
  approvalId: string,
  decisionId: string,
  nowMs: number,
): Promise<void> {
  const { rows } = await client.query<{
    resource_type: string
    resource_id: string
    status: string
    decided_at: string | Date | null
  }>(
    `select a.resource_type, a.resource_id, a.status, a.decided_at
       from recruitment.approval a
      where a.id = $1 and a.tenant_id = $2`,
    [approvalId, tenantId],
  )
  const row = rows[0]
  const fail = (detail: Record<string, unknown>): never => {
    throw evalError(
      'INVALID_ARGS',
      'APPROVAL_BINDING_INVALID',
      'approval_id 没有绑到本次决策上（DC-19：resource_type/resource_id/status/decided_at 四条都要满足）',
      { approval_id: approvalId, decision_id: decisionId, ...detail },
    )
  }
  if (row === undefined) fail({ found: false })
  if (row !== undefined && row.resource_type !== 'DECISION') fail({ resource_type: row.resource_type })
  if (row !== undefined && row.resource_id !== decisionId) fail({ resource_id: row.resource_id })
  if (row !== undefined && row.status !== 'APPROVED') fail({ status: row.status })
  if (row !== undefined) {
    const decidedAt = row.decided_at === null
      ? Number.NaN
      : row.decided_at instanceof Date ? row.decided_at.getTime() : Date.parse(row.decided_at)
    if (!Number.isFinite(decidedAt) || decidedAt > nowMs) {
      fail({ decided_at: row.decided_at, now: new Date(nowMs).toISOString() })
    }
  }
}

/** `RUBRIC_VERSION` / `AUTHORITY` 校验需要的事实（S10 与 S7 写侧共用）。 */
interface BasisBindingContext {
  readonly basis: readonly Record<string, unknown>[]
  readonly application: ApplicationRow
  readonly rubric: RubricRow
  readonly actorId: string
  readonly isHiringManager: boolean
  readonly hiringManagerActorId: string | null
}

/**
 * RUBRIC_VERSION（DC-17）：id 必须是申请钉住的那版、payload_hash 与库值一致、且属于同一岗位。
 * **S10 与 S7 同口径** —— S7 也要证明"筛的是钉住的那版标准"（§17.1）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param ctx - 绑定事实。
 */
async function checkRubricVersionRefs(
  client: DatabaseClient,
  tenantId: string,
  ctx: BasisBindingContext,
): Promise<void> {
  for (const ref of refsOfKind(ctx.basis, 'RUBRIC_VERSION')) {
    const id = asString(ref.id)
    const row = id === ctx.rubric.id ? ctx.rubric : await loadRubricVersion(client, tenantId, id)
    if (id !== ctx.application.rubric_version_id) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'BASIS_RUBRIC_HASH_MISMATCH',
        'RUBRIC_VERSION 依据的 id 不是申请钉住的版本（DC-17）',
        { expected: ctx.application.rubric_version_id, provided: id },
      )
    }
    if (asString(ref.payload_hash) !== row.payload_hash) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'BASIS_RUBRIC_HASH_MISMATCH',
        'RUBRIC_VERSION 依据的 payload_hash 与库值不一致（DC-17）',
        { rubric_version_id: id, expected: row.payload_hash, provided: asString(ref.payload_hash) },
      )
    }
    if (row.job_id !== ctx.application.job_id) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'BASIS_RUBRIC_HASH_MISMATCH',
        'RUBRIC_VERSION 不属于该申请的岗位（DC-17/SC-47）',
        { rubric_version_id: id, rubric_job_id: row.job_id, application_job_id: ctx.application.job_id },
      )
    }
  }
}

/**
 * AUTHORITY（DC-14/DC-15）：actor 只能是执行上下文的人；`is_hiring_manager` 只认服务端计算值。
 * @param ctx - 绑定事实。
 */
function checkAuthorityRefs(ctx: BasisBindingContext): void {
  for (const ref of refsOfKind(ctx.basis, 'AUTHORITY')) {
    const actorInRef = asString(ref.actor_id)
    if (actorInRef.toLowerCase() !== ctx.actorId.toLowerCase()) {
      throw evalError(
        'INVALID_ARGS',
        'BASIS_AUTHORITY_MISMATCH',
        'AUTHORITY 依据的 actor_id 不是本次决策人（不能替别人盖章，DC-14）',
        { expected: ctx.actorId, provided: actorInRef },
      )
    }
    if (ref.is_hiring_manager !== ctx.isHiringManager) {
      throw evalError(
        'INVALID_ARGS',
        'BASIS_AUTHORITY_MISMATCH',
        'AUTHORITY 依据的 is_hiring_manager 与服务端计算结果不一致（DC-14）',
        { computed: ctx.isHiringManager, provided: ref.is_hiring_manager, hiring_manager_actor_id: ctx.hiringManagerActorId },
      )
    }
  }
}

/**
 * STEP 2（`basis_refs` 部分，**S10 口径**）：每个 kind 的必带项与语义校验。
 *
 * 顺序：先「必带哪几种 kind」（DC-12/§6.1 表），再逐条语义（DC-14/16/17/19/29/33）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param ctx - 应用/标准/权限/面评等已加载事实。
 */
async function checkBasisSemantics(
  client: DatabaseClient,
  tenantId: string,
  ctx: BasisContext,
): Promise<void> {
  const basis = ctx.args.basis_refs
  const missingKinds: string[] = []
  if (refsOfKind(basis, 'SUMMARY').length === 0) missingKinds.push('SUMMARY')
  if (refsOfKind(basis, 'RUBRIC_VERSION').length === 0) missingKinds.push('RUBRIC_VERSION')
  if (refsOfKind(basis, 'AUTHORITY').length === 0) missingKinds.push('AUTHORITY')
  if (missingKinds.length > 0) {
    throw evalError(
      'INVALID_ARGS',
      'BASIS_REF_EMPTY',
      'basis_refs 缺少每次必带的依据（SUMMARY / RUBRIC_VERSION / AUTHORITY，DC §6.1）',
      { missing_kinds: missingKinds },
    )
  }
  const binding: BasisBindingContext = {
    basis,
    application: ctx.application,
    rubric: ctx.rubric,
    actorId: ctx.actorId,
    isHiringManager: ctx.isHiringManager,
    hiringManagerActorId: ctx.hiringManagerActorId,
  }
  await checkRubricVersionRefs(client, tenantId, binding)
  checkAuthorityRefs(binding)

  // SCORECARD（TC §7.3 4b / INV-9）：必须含 overall/transcript_basis/transcript_state，且与库值一致。
  for (const ref of refsOfKind(basis, 'SCORECARD')) {
    const row = await loadScorecard(client, tenantId, asString(ref.id))
    if (row.application_id !== ctx.application.id) {
      throw evalError('NOT_FOUND', 'SCORECARD_NOT_FOUND', '依据引用的面评不属于该申请', {
        scorecard_id: row.id,
      })
    }
    if (ctx.args.interview_id !== undefined && row.interview_id !== ctx.args.interview_id) {
      throw evalError('NOT_FOUND', 'SCORECARD_NOT_FOUND', '依据引用的面评不属于这场面试（STAGE 口径）', {
        scorecard_id: row.id,
        interview_id: row.interview_id,
        expected_interview_id: ctx.args.interview_id,
      })
    }
    if (asString(ref.overall) !== String(row.overall)) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'SCORECARD_SHAPE_INVALID',
        'SCORECARD 依据的 overall 与库里的面评结论不一致',
        { scorecard_id: row.id, expected: row.overall, provided: ref.overall },
      )
    }
    if (ref.revision_no !== undefined && ref.revision_no !== row.revision_no) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'SCORECARD_SHAPE_INVALID',
        'SCORECARD 依据的 revision_no 与库值不一致',
        { scorecard_id: row.id, expected: row.revision_no, provided: ref.revision_no },
      )
    }
    if (ref.interviewer_id !== undefined && asString(ref.interviewer_id) !== row.interviewer_id) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'SCORECARD_SHAPE_INVALID',
        'SCORECARD 依据的 interviewer_id 与库值不一致',
        { scorecard_id: row.id, expected: row.interviewer_id, provided: ref.interviewer_id },
      )
    }
    if (ref.payload_hash !== undefined && asString(ref.payload_hash) !== String(row.payload_hash)) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'SCORECARD_SHAPE_INVALID',
        'SCORECARD 依据的 payload_hash 与库值不一致',
        { scorecard_id: row.id, expected: row.payload_hash, provided: ref.payload_hash },
      )
    }
  }

  // INTERVIEW_RECORD（DC-23）：引用即要求 READY + VERIFIED，否则进人工（不进决策依据）。
  for (const ref of refsOfKind(basis, 'INTERVIEW_RECORD')) {
    const id = asString(ref.id)
    const { rows } = await client.query<{ id: string; status: string; verification_status: string }>(
      `select r.id, r.status, r.verification_status
         from recruitment.interview_record r
        where r.id = $1 and r.tenant_id = $2`,
      [id, tenantId],
    )
    const row = rows[0]
    const provided = asString(ref.verification_status)
    const verified = row !== undefined && row.status === 'READY' && row.verification_status === 'VERIFIED'
    const claimedVerified = provided === '' ? true : provided === 'VERIFIED'
    if (!verified || !claimedVerified) {
      throw evalError(
        'BLOCKED_BY_REVIEW',
        'RECORD_NOT_VERIFIED',
        'INTERVIEW_RECORD 未就绪或未校验，不能作为决策依据（DC-23）',
        {
          application_id: ctx.application.id,
          blocking_items: [{
            code: 'RECORD_NOT_VERIFIED',
            family: 'EVIDENCE',
            interview_record_id: id,
            ...(row === undefined ? { found: false } : { status: row.status, verification_status: row.verification_status }),
          }],
        },
        'EVIDENCE',
      )
    }
  }

  // SCREENING_DECISION（只读引用）：必须存在、同一申请。
  for (const ref of refsOfKind(basis, 'SCREENING_DECISION')) {
    const row = await loadDecisionById(client, tenantId, asString(ref.id))
    if (row.application_id !== ctx.application.id || row.decision_scope !== 'SCREENING') {
      throw evalError('NOT_FOUND', 'DECISION_NOT_FOUND', 'SCREENING_DECISION 依据不是该申请的初筛决策', {
        decision_id: row.id,
      })
    }
  }

  // MISSING_ACK：集合口径在 STEP 6 校验；这里只查 interviewer 是否真的存在（不存在的 id 必是数据错误）。
  for (const ref of refsOfKind(basis, 'MISSING_ACK')) {
    const ids = asArray(ref.interviewer_ids).map((value) => String(value))
    if (ids.length === 0) continue
    const { rows } = await client.query<{ id: string }>(
      `select x.id from recruitment.interviewer x
        where x.tenant_id = $1
          and x.id = any($2::uuid[])
          and ($3::uuid is null or x.interview_id = $3)`,
      [tenantId, ids, ctx.args.interview_id ?? null],
    )
    const known = new Set(rows.map((row) => row.id))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      throw evalError('INVALID_ARGS', 'MISSING_ACK_MISMATCH', 'acknowledged_missing 引用了不存在的面试官', {
        unknown_interviewer_ids: unknown,
      })
    }
  }
}

// =====================================================================
//  STEP 2'S（S7 写侧）：SCREENING 的 basis_refs 语义（§17.1）
// =====================================================================

/**
 * STEP 2'S：`decision_scope='SCREENING'` 的 `basis_refs` 语义校验。
 *
 * **不重算 screening**（S7 是瞬态投影，唯一持久化载体就是 `basis_refs`，
 * `screening-rules.md §11 D-3/P-1`）；只做**绑定**核对：
 *   * `RUBRIC_VERSION` / `AUTHORITY`：与 S10 同口径（DC-14/17）；
 *   * `SCREENING_EVALUATION`：`rubric_version_id` 必须是申请钉住的那版、`rubric_payload_hash`
 *     与库值相同、`resume_version_id`/`resume_content_sha256` 必须与库里的材料版本一致
 *     （申请钉了材料就必须是那一份）；
 *   * `RESUME_VERSION`（可选）：给了就与库值核对。
 *
 * 门禁（§17.1）：`result ∈ {ADVANCE, REJECT}` **必须**带 `SCREENING_EVALUATION`
 * （推进/淘汰要有那次评估做依据）；`HOLD`/`WITHDRAW` 可以不带（安全方向，与 §4.2.1 同构）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param ctx - 申请/标准/权限等已加载事实 + 入参。
 */
async function checkScreeningBasisSemantics(
  client: DatabaseClient,
  tenantId: string,
  ctx: {
    readonly args: DecisionArgs
    readonly application: ApplicationRow
    readonly rubric: RubricRow
    readonly actorId: string
    readonly isHiringManager: boolean
    readonly hiringManagerActorId: string | null
  },
): Promise<void> {
  const basis = ctx.args.basis_refs
  const missingKinds: string[] = []
  if (refsOfKind(basis, 'RUBRIC_VERSION').length === 0) missingKinds.push('RUBRIC_VERSION')
  if (refsOfKind(basis, 'AUTHORITY').length === 0) missingKinds.push('AUTHORITY')
  const evaluations = refsOfKind(basis, 'SCREENING_EVALUATION')
  if (evaluations.length === 0 && (ctx.args.result === 'ADVANCE' || ctx.args.result === 'REJECT')) {
    // 推进/淘汰必须有那次筛选评估做依据；HOLD/WITHDRAW 是安全方向，不因此阻断。
    missingKinds.push('SCREENING_EVALUATION')
  }
  if (missingKinds.length > 0) {
    throw evalError(
      'INVALID_ARGS',
      'BASIS_REF_EMPTY',
      'SCREENING 的 basis_refs 缺少必带依据（RUBRIC_VERSION / AUTHORITY；ADVANCE、REJECT 另需 SCREENING_EVALUATION，§17.1）',
      { missing_kinds: missingKinds, decision_scope: 'SCREENING', result: ctx.args.result },
    )
  }
  const binding: BasisBindingContext = {
    basis,
    application: ctx.application,
    rubric: ctx.rubric,
    actorId: ctx.actorId,
    isHiringManager: ctx.isHiringManager,
    hiringManagerActorId: ctx.hiringManagerActorId,
  }
  await checkRubricVersionRefs(client, tenantId, binding)
  checkAuthorityRefs(binding)

  // 材料版本（可选 kind）：给了就必须是该租户下的那一版，且 hash 对得上。
  for (const ref of refsOfKind(basis, 'RESUME_VERSION')) {
    const id = asString(ref.id)
    const row = await loadResumeVersion(client, tenantId, id)
    if (ref.content_sha256 !== undefined && asString(ref.content_sha256) !== row.content_sha256) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'BASIS_RESUME_HASH_MISMATCH',
        'RESUME_VERSION 依据的 content_sha256 与库值不一致（§17.1）',
        { resume_version_id: id, expected: row.content_sha256, provided: asString(ref.content_sha256) },
      )
    }
  }

  // 评估摘要：只核对绑定（rubric / resume / hash 形状已在 STEP 0 校验）。
  for (const [index, ref] of evaluations.entries()) {
    const rubricVersionId = asString(ref.rubric_version_id)
    if (rubricVersionId !== ctx.application.rubric_version_id) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'BASIS_SCREENING_RUBRIC_MISMATCH',
        'SCREENING_EVALUATION 不是按申请钉住的那版标准做的（§17.1）',
        { expected: ctx.application.rubric_version_id, provided: rubricVersionId, basis_refs_index: index },
      )
    }
    if (asString(ref.rubric_payload_hash) !== ctx.rubric.payload_hash) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'BASIS_SCREENING_RUBRIC_MISMATCH',
        'SCREENING_EVALUATION 的 rubric_payload_hash 与库值不一致（§17.1）',
        { expected: ctx.rubric.payload_hash, provided: asString(ref.rubric_payload_hash), basis_refs_index: index },
      )
    }
    const resumeVersionId = asString(ref.resume_version_id)
    if (ctx.application.resume_version_id !== null && resumeVersionId !== ctx.application.resume_version_id) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'BASIS_SCREENING_RESUME_MISMATCH',
        'SCREENING_EVALUATION 用的不是申请钉住的那份材料（§17.1）',
        {
          expected: ctx.application.resume_version_id,
          provided: resumeVersionId,
          basis_refs_index: index,
        },
      )
    }
    const resume = await loadResumeVersion(client, tenantId, resumeVersionId)
    if (asString(ref.resume_content_sha256) !== resume.content_sha256) {
      throw evalError(
        'EVIDENCE_INSUFFICIENT',
        'BASIS_SCREENING_RESUME_MISMATCH',
        'SCREENING_EVALUATION 的 resume_content_sha256 与库值不一致（§17.1）',
        { expected: resume.content_sha256, provided: asString(ref.resume_content_sha256), basis_refs_index: index },
      )
    }
  }
}

// =====================================================================
//  STEP 5 / STEP 6：阻断与结果门禁
// =====================================================================

/** TC §4.5 里那三个"现在不该判"的 blocker code。 */
const REVIEW_BLOCKER_CODES = ['OPEN_REVIEW_TASK', 'UNREADABLE_NOT_RESOLVED', 'RECORD_NOT_VERIFIED'] as const

function familyOfReviewBlocker(code: string): string {
  return code === 'OPEN_REVIEW_TASK' ? 'QUEUE' : 'EVIDENCE'
}

/** TC §3.5：blocker code → 本工具的错误 reason_code（只有 `UNREADABLE_NOT_RESOLVED` 会改名）。 */
function reasonCodeOfReviewBlocker(code: string): string {
  return code === 'UNREADABLE_NOT_RESOLVED' ? 'REJECT_BASIS_UNREADABLE' : code
}

/**
 * STEP 5：汇总里的阻断是否命中本次 `result`。
 *
 * - `OPEN_REVIEW_TASK`：阻断**全部**结果；
 * - `UNREADABLE_NOT_RESOLVED`：只挡 `REJECT`（`blocks_results` 里含它才挡）；
 * - `RECORD_NOT_VERIFIED`：只在决策引用了 `INTERVIEW_RECORD` 时挡。
 * @param ctx - 汇总 + 入参。
 */
function checkSummaryBlockers(ctx: { readonly args: DecisionArgs; readonly view: SummaryView }): void {
  const citesRecord = refsOfKind(ctx.args.basis_refs, 'INTERVIEW_RECORD').length > 0
  const items: Record<string, unknown>[] = []
  for (const blocker of ctx.view.blockers) {
    if (!(REVIEW_BLOCKER_CODES as readonly string[]).includes(blocker.code)) continue
    if (blocker.code === 'UNREADABLE_NOT_RESOLVED') {
      const blocksReject = blocker.blocks_results.length === 0 || blocker.blocks_results.includes('REJECT')
      if (ctx.args.result !== 'REJECT' || !blocksReject) continue
    }
    if (blocker.code === 'RECORD_NOT_VERIFIED' && !citesRecord) continue
    const detail = asRecord(blocker.detail)
    const reasonCode = reasonCodeOfReviewBlocker(blocker.code)
    items.push({
      code: reasonCode,
      family: blocker.family === '' ? familyOfReviewBlocker(blocker.code) : blocker.family,
      blocker_code: blocker.code,
      ...(detail === undefined ? {} : detail),
    })
  }
  if (items.length === 0) return
  const first = items[0] as Record<string, unknown>
  const reasonCode = String(first.code)
  throw evalError(
    'BLOCKED_BY_REVIEW',
    reasonCode,
    '存在未处理的人工队列项或未澄清的读不出维度，现在不得落这条决策（DC-24/DC-25/DC-23）',
    {
      application_id: ctx.args.application_id,
      result: ctx.args.result,
      blocking_items: items,
    },
    familyOfReviewBlocker(String(first.blocker_code ?? reasonCode)),
  )
}

/** 空集合比较：两边成员完全一致（无视大小写，UUID 文本）。 */
function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left.map((value) => value.toLowerCase()))
  const b = new Set(right.map((value) => value.toLowerCase()))
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

/** `consensus` 的方向是不是 ADVANCE 方向（DC-28）。 */
function consensusDirection(consensus: string): 'ADVANCE' | 'REJECT' | 'UNKNOWN' {
  if (consensus === 'UNANIMOUS_ADVANCE' || consensus === 'MAJORITY_ADVANCE') return 'ADVANCE'
  if (consensus === 'UNANIMOUS_REJECT' || consensus === 'MAJORITY_REJECT') return 'REJECT'
  return 'UNKNOWN'
}

/** 反着来时一并要求 `basis_refs[OVERRIDE]`（DC-29）。 */
function assertOverrideBasis(args: DecisionArgs): void {
  const overrides = refsOfKind(args.basis_refs, 'OVERRIDE')
  if (overrides.length === 0) {
    throw evalError(
      'INVALID_ARGS',
      'OVERRIDE_NOT_ACKNOWLEDGED',
      '结论与汇总相反时必须把理由落进 basis_refs[OVERRIDE]（DC-29）',
      { required_kind: 'OVERRIDE', acknowledged_dissent: args.acknowledged_dissent },
    )
  }
  if (!overrides.some((ref) => nonEmptyString(ref.override_rationale))) {
    throw evalError(
      'INVALID_ARGS',
      'OVERRIDE_NOT_ACKNOWLEDGED',
      'basis_refs[OVERRIDE].override_rationale 不得为空（DC-28/DC-29）',
      { required_kind: 'OVERRIDE' },
    )
  }
}

/**
 * STEP 6：结果门禁（DC §4.2 矩阵 + §4.2.1 + 四道防线）。
 *
 * **不对称**：`WITHDRAW`/`HOLD` 恒放行（不受缺失/零面评/零 SCORECARD basis 影响）；
 * `ADVANCE(FINAL)` 与 `REJECT` 缺一个人都不放行。
 * @param ctx - 入参 + 汇总视图 + 本 scope 的当前面评。
 */
function checkResultGate(ctx: {
  readonly args: DecisionArgs
  readonly view: SummaryView
  readonly scorecards: readonly ScorecardRow[]
}): void {
  const { args, view } = ctx
  const missing = view.missingIds
  const submitted = view.submitted
  const scope = args.decision_scope

  // DC-18：REJECT 的理由必须引到具体维度（维度集合要查 rubric，见 STEP 6 调用点）。
  // WITHDRAW / HOLD：安全方向，**不受**缺失/零面评/零 SCORECARD basis 影响（§4.2.1）。
  if (args.result === 'WITHDRAW' || args.result === 'HOLD') return

  // TC §3.5：`submitted ≥ 1` 是 ADVANCE / REJECT 的**先决**（零提交含全豁免）。
  if (submitted < 1) {
    throw evalError(
      'EVIDENCE_INSUFFICIENT',
      'NO_SUBMITTED_SCORECARD',
      '没有任何一份可用面评时，推进/淘汰都没有依据（DC §4.2.1、N-9）',
      { application_id: args.application_id, submitted: 0, missing_count: missing.length },
    )
  }

  if (args.result === 'ADVANCE') {
    if (scope === 'STAGE') {
      if (missing.length > 0) {
        if (args.missing_disposition !== 'PROCEED_WITH_MISSING') {
          throw evalError(
            'INVALID_ARGS',
            'MISSING_ACK_REQUIRED',
            '缺人推进必须显式给 missing_disposition=PROCEED_WITH_MISSING 并逐条确认缺谁（DC §4.2）',
            { missing: missing },
          )
        }
        const ackIds = args.acknowledged_missing.map((entry) => entry.interviewer_id)
        if (!sameIdSet(ackIds, missing)) {
          throw evalError(
            'INVALID_ARGS',
            'MISSING_ACK_MISMATCH',
            'acknowledged_missing 的集合必须与汇总的 missing[].interviewer_id 完全相等（不多不少，DC §4.2）',
            {
              missing,
              acknowledged_missing: ackIds,
              not_acknowledged: missing.filter((id) => !ackIds.map((v) => v.toLowerCase()).includes(id.toLowerCase())),
              unknown_in_ack: ackIds.filter((id) => !missing.map((v) => v.toLowerCase()).includes(id.toLowerCase())),
            },
          )
        }
      } else if (args.acknowledged_missing.length > 0) {
        throw evalError(
          'INVALID_ARGS',
          'MISSING_ACK_MISMATCH',
          '汇总没有缺失面评，acknowledged_missing 集合必须为空（DC §4.2）',
          { missing: [], acknowledged_missing: args.acknowledged_missing.map((entry) => entry.interviewer_id) },
        )
      }
      return
    }
    // FINAL：缺一个人都不放行；`acknowledged_missing` 不放行 FINAL（§4.2.1、Q-5）。
    if (missing.length > 0) {
      throw evalError(
        'SCORECARD_MISSING',
        'REQUIRED_SCORECARDS_INCOMPLETE',
        '终局决策不接受残缺面板：必交面评缺失，逐条确认不放行 FINAL（DC §4.2.1）',
        { scope: 'FINAL', missing },
      )
    }
    if (view.tallyReject > 0) {
      requireDissent(args, view, 'ADVANCE')
    }
    return
  }

  // REJECT
  if (missing.length > 0) {
    throw evalError(
      'SCORECARD_MISSING',
      'REQUIRED_SCORECARDS_INCOMPLETE',
      '淘汰必须建立在齐备面板上：有必交面评缺失时不得淘汰（DC-26、防线 2）',
      { scope, missing },
    )
  }
  const rejecting = ctx.scorecards.filter((row) => row.status === 'SUBMITTED' && row.overall === 'REJECT')
  if (rejecting.length === 0 && !hasScreeningRejectionBasis(args, ctx.scorecards, view)) {
    throw evalError(
      'EVIDENCE_INSUFFICIENT',
      'REJECT_WITHOUT_REJECTING_SCORECARD',
      '没有任何一份面评投了不通过，淘汰就成了个人判断伪装成面试结论（DC-27、防线 2）',
      { application_id: args.application_id, tally_reject: view.tallyReject },
    )
  }
  assertRejectBasisReadable(args, ctx.scorecards)
  if (consensusDirection(view.consensus) === 'ADVANCE') {
    requireDissent(args, view, 'REJECT')
  }
}

/** 反着来必须签字（DC-28）+ 理由进 basis（DC-29）。 */
function requireDissent(args: DecisionArgs, view: SummaryView, result: string): void {
  const rationale = typeof args.override_rationale === 'string' ? args.override_rationale.trim() : ''
  if (args.acknowledged_dissent !== true || rationale === '') {
    throw evalError(
      'INVALID_ARGS',
      'OVERRIDE_NOT_ACKNOWLEDGED',
      '结论与汇总（consensus）相反时，必须 acknowledged_dissent=true 且给出非空 override_rationale（DC-28）',
      { result, consensus: view.consensus, acknowledged_dissent: args.acknowledged_dissent ?? null },
    )
  }
  assertOverrideBasis(args)
}

/**
 * DC-27 的唯一例外：存在**未被撤回**的同申请 `SCREENING` 决策，且其依据里有
 * `failure_class='HARD_FAIL'` 的条目，并且本次 `basis_refs` 带 `SCREENING_DECISION`
 * 指向它。这是"没有面试官投反对票也能拒"的**唯一**合法路径。
 */
function hasScreeningRejectionBasis(
  args: DecisionArgs,
  scorecards: readonly ScorecardRow[],
  view: SummaryView,
): boolean {
  void scorecards
  void view
  const refs = refsOfKind(args.basis_refs, 'SCREENING_DECISION')
  if (refs.length === 0) return false
  return refs.some((ref) => {
    const nested = asRecord(ref.basis_refs)
    return nested !== undefined && containsHardFail(nested)
  })
}

/** 深扫一个 JSON 值里有没有 `failure_class='HARD_FAIL'`（S7 的 reasons[] 形状）。 */
function containsHardFail(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsHardFail(item))
  if (isPlainObject(value)) {
    if (value.failure_class === 'HARD_FAIL') return true
    return Object.values(value).some((item) => containsHardFail(item))
  }
  return false
}

/**
 * DC-24：REJECT 的每一条依据都必须是 `NOT_MET`；落到 `UNREADABLE`/`NOT_OBSERVED`
 * → `BLOCKED_BY_REVIEW(REJECT_BASIS_UNREADABLE)`（`blocking_items[]` 至少 1 项）。
 *
 * 判定两路（都与 A2 同构）：
 *   1. `basis_refs[SCORECARD].fields[]` 里显式写了 `UNREADABLE`/`NOT_OBSERVED`；
 *   2. `reason` 点名的维度，在所有被引面评里都只有 `UNREADABLE`/`NOT_OBSERVED`（没有 `NOT_MET`）。
 */
function assertRejectBasisReadable(args: DecisionArgs, scorecards: readonly ScorecardRow[]): void {
  const byScorecardId = new Map(scorecards.map((row) => [row.id, row]))
  const blocking: Record<string, unknown>[] = []
  const citedDims = new Map<string, { anyNotMet: boolean; unreadable: boolean }>()

  for (const ref of refsOfKind(args.basis_refs, 'SCORECARD')) {
    const scorecardId = asString(ref.id)
    const row = byScorecardId.get(scorecardId)
    const fields = asArray(ref.fields).filter((item): item is Record<string, unknown> => isPlainObject(item))
    for (const field of fields) {
      const dimensionKey = asString(field.dimension_key)
      const assessment = asString(field.assessment)
      const bucket = citedDims.get(dimensionKey) ?? { anyNotMet: false, unreadable: false }
      if (assessment === 'NOT_MET') bucket.anyNotMet = true
      if (assessment === 'UNREADABLE' || assessment === 'NOT_OBSERVED') {
        bucket.unreadable = true
        blocking.push({
          code: 'REJECT_BASIS_UNREADABLE',
          family: 'EVIDENCE',
          interviewer_id: row?.interviewer_id ?? asString(ref.interviewer_id),
          dimension_key: dimensionKey,
          assessment,
          scorecard_id: scorecardId,
          source: 'basis_refs.fields',
        })
      }
      citedDims.set(dimensionKey, bucket)
    }
  }
  if (blocking.length > 0) {
    throwEVIDENCEBlocked(args, blocking)
  }

  // 第二路：reason 点名的维度在**所有被引面评**里都读不出 / 没观察到（没有任何 NOT_MET 支撑）。
  for (const ref of refsOfKind(args.basis_refs, 'SCORECARD')) {
    const row = byScorecardId.get(asString(ref.id))
    if (row === undefined || row.items === null) continue
    for (const [dimensionKey, item] of Object.entries(row.items)) {
      if (dimensionKey === 'transcript_basis') continue
      if (!isPlainObject(item)) continue
      const assessment = asString(item.assessment)
      const bucket = citedDims.get(dimensionKey)
      if (bucket === undefined) continue
      if (assessment === 'NOT_MET') bucket.anyNotMet = true
      if (assessment === 'UNREADABLE' || assessment === 'NOT_OBSERVED') bucket.unreadable = true
    }
  }
  const weakDims = [...citedDims.entries()]
    .filter(([dimensionKey, bucket]) => bucket.unreadable && !bucket.anyNotMet && args.reason.includes(dimensionKey))
    .map(([dimensionKey]) => dimensionKey)
  if (weakDims.length === 0) return
  const derived: Record<string, unknown>[] = []
  for (const dimensionKey of weakDims) {
    for (const ref of refsOfKind(args.basis_refs, 'SCORECARD')) {
      const row = byScorecardId.get(asString(ref.id))
      if (row === undefined || !isPlainObject(row.items)) continue
      const item = asRecord(row.items[dimensionKey])
      if (item === undefined) continue
      const assessment = asString(item.assessment)
      if (assessment !== 'UNREADABLE' && assessment !== 'NOT_OBSERVED') continue
      derived.push({
        code: 'REJECT_BASIS_UNREADABLE',
        family: 'EVIDENCE',
        interviewer_id: row.interviewer_id,
        dimension_key: dimensionKey,
        assessment,
        scorecard_id: row.id,
        source: 'reason',
      })
    }
  }
  throwEVIDENCEBlocked(args, derived.length > 0 ? derived : weakDims.map((dimensionKey) => ({
    code: 'REJECT_BASIS_UNREADABLE',
    family: 'EVIDENCE',
    dimension_key: dimensionKey,
    assessment: 'UNREADABLE',
  })))
}

function throwEVIDENCEBlocked(args: DecisionArgs, items: readonly Record<string, unknown>[]): never {
  throw evalError(
    'BLOCKED_BY_REVIEW',
    'REJECT_BASIS_UNREADABLE',
    '淘汰依据落在读不出/没观察到的维度上，必须先进人工澄清（DC-24、防线 1）',
    { application_id: args.application_id, blocking_items: [...items] },
    'EVIDENCE',
  )
}

/** REJECT 的理由必须含至少一个 rubric `dimension_key`（DC-18，子串、大小写敏感）。 */
async function checkReasonCitesDimension(
  client: DatabaseClient,
  tenantId: string,
  args: DecisionArgs,
): Promise<void> {
  if (args.result !== 'REJECT') return
  const rubricVersionId = args.basis_refs
    .filter((ref) => ref.kind === 'RUBRIC_VERSION')
    .map((ref) => asString(ref.id))
    .find((id) => id !== '')
  const row = rubricVersionId === undefined
    ? undefined
    : (await client.query<RubricRow>(
      'select id, version_no, payload_hash, job_id, dimensions from recruitment.rubric_version where id = $1 and tenant_id = $2',
      [rubricVersionId, tenantId],
    )).rows[0]
  const dimensions = asArray(row?.dimensions)
  const keys = dimensions
    .map((dimension) => (isPlainObject(dimension) ? asString(dimension.key) : ''))
    .filter((key) => key !== '')
  const cited = keys.filter((key) => args.reason.includes(key))
  if (cited.length === 0) {
    throw evalError(
      'INVALID_ARGS',
      'DECISION_REASON_NO_DIMENSION',
      'REJECT 的理由必须至少点到一个 rubric dimension_key（"不合适"三个字不算理由，DC-18）',
      { dimension_keys: keys },
    )
  }
}

// =====================================================================
//  STEP 7：写入（内部事件 + decision + 三步舞）+ 写后复核
// =====================================================================

interface WriteInput {
  readonly tenantId: string
  readonly args: DecisionArgs
  readonly actorId: string
  readonly decisionId: string
  readonly current: DecisionRow | undefined
  readonly supersedeTarget: DecisionRow | undefined
  readonly view: SummaryView
}

interface WrittenDecision {
  readonly id: string
  readonly decided_at: string
  readonly record_version: number
  readonly superseded_by_decision_id: string | null
}

/**
 * 把 pg 的约束错误翻成契约错误（TC §5.3）。
 *
 * 两条"不是兜底"的唯一性冲突：
 *   * `23505`（`0007` 之前的 `uq_decision_current` 部分唯一索引 / 其它唯一约束）；
 *   * **`23P01` exclusion_violation**：`0008` 把 `uq_decision_current` 换成
 *     `DEFERRABLE INITIALLY DEFERRED` 的排斥约束后，重复当前决策在 **COMMIT** 时才报错，
 *     SQLSTATE 不再是 23505。不映射它 = 用户看到 `23P01` 这种库内部码（P1-1）。
 *     两个约束（`uq_decision_current` / `uq_decision_current_final`）语义都是
 *     "同一申请已有当前决策"，一律 `ALREADY_DECIDED`。
 *
 * 本函数会**再次抛错**（返回类型 `never`）；在 `execute()` 的 catch 里对 `withActor`
 * （含 COMMIT）抛出的错误也调用它一次 —— 否则延迟约束的冲突逃到宿主。
 * @param error - 捕获到的异常。
 */
export function translateWriteError(error: unknown): never {
  if (error instanceof RecruitmentToolError) throw error
  const sqlstate = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : ''
  const constraint = typeof (error as { constraint?: unknown }).constraint === 'string'
    ? String((error as { constraint: string }).constraint)
    : undefined
  const rawMessage = error instanceof Error ? error.message : String(error)
  if (sqlstate === '23505') {
    if (constraint === 'uq_decision_current') {
      throw evalError('ALREADY_DECIDED', 'SCOPE_ALREADY_DECIDED', '同一 (申请, scope, 阶段) 已有当前决策（并发重复）', {
        constraint,
        sqlstate,
      })
    }
    throw evalError('DB_CONSTRAINT_VIOLATION', 'UNIQUE_VIOLATION', '写入撞上唯一约束', {
      sqlstate,
      constraint,
      message: rawMessage.slice(0, 300),
    })
  }
  if (sqlstate === '23P01') {
    // `0008` 的可延迟排斥约束：检查在 COMMIT 触发（D-80 之后的唯一防线）。
    throw evalError(
      'ALREADY_DECIDED',
      'SCOPE_ALREADY_DECIDED',
      '同一 (申请, scope, 阶段) 已有当前决策：可延迟排斥约束在提交时报冲突（23P01，§17.3）',
      { constraint, sqlstate },
    )
  }
  if (sqlstate === '23514') {
    const mutation = rawMessage.startsWith('IMMUTABLE_COLUMN') || rawMessage.includes('IMMUTABLE_COLUMN')
    throw evalError(
      'DB_CONSTRAINT_VIOLATION',
      mutation ? 'DECISION_IMMUTABLE' : 'UNIQUE_VIOLATION',
      mutation ? '决策整行不可改：只有 superseded_by_decision_id 允许变（DC-30）' : '写入违反库的 CHECK 约束',
      { sqlstate, constraint, message: rawMessage.slice(0, 300) },
    )
  }
  if (sqlstate === '23503') {
    throw evalError('DB_CONSTRAINT_VIOLATION', 'FK_VIOLATION', '写入违反外键（引用的行不存在或跨租户）', {
      sqlstate,
      constraint,
      message: rawMessage.slice(0, 300),
    })
  }
  // 不属于"契约没覆盖"的库错误（连接中断等）**不假扮成业务错误**，原样抛出。
  throw error
}

/** 写一条内部事件（DC-38 / N07）：`FALLBACK_KEY` 必须绑 `source_object_id` 且不带 `provider_event_id`。 */
async function insertDecisionEvent(
  client: DatabaseClient,
  input: { tenantId: string; decisionId: string; eventId: string; payload: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `insert into recruitment.event_inbox
       (event_id, tenant_id, provider, provider_event_id, event_type, schema_version,
        occurred_at, received_at, recorded_at, correlation_id, causation_id,
        idempotency_key, idempotency_source, source_object_id,
        payload_ref, payload, trust_level, normalized_event_type, normalizer_version)
     values ($1, $2, 'internal', null, 'decision.record', 1,
             now(), now(), now(), null, null,
             $3, 'FALLBACK_KEY', $4,
             null, $5::jsonb, 'INTERNAL', 'decision.record', 'schema/evaluation-2.0.0')`,
    [input.eventId, input.tenantId, `decision:${input.decisionId}`, input.decisionId, JSON.stringify(input.payload)],
  )
}

/** 插一条决策（新行 `record_version=1`；`stage_code` 由 scope 写死 —— `stageCodeOf`）。 */
async function insertDecisionRow(
  client: DatabaseClient,
  input: {
    tenantId: string
    args: DecisionArgs
    actorId: string
    decisionId: string
    supersededBy: string | null
    stageCode: string
  },
): Promise<WrittenDecision> {
  const { rows } = await client.query<{
    id: string
    decided_at: string | Date
    record_version: number
    superseded_by_decision_id: string | null
  }>(
    `insert into recruitment.decision
       (id, tenant_id, application_id, interview_id, decision_scope, stage_code, result,
        decided_by_actor_id, reason, basis_refs, approval_id, superseded_by_decision_id, record_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, 1)
     returning id, decided_at, record_version, superseded_by_decision_id`,
    [
      input.decisionId,
      input.tenantId,
      input.args.application_id,
      input.args.interview_id ?? null,
      input.args.decision_scope,
      input.stageCode,
      input.args.result,
      input.actorId,
      input.args.reason,
      JSON.stringify(input.args.basis_refs),
      input.args.approval_id ?? null,
      input.supersededBy,
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('decision insert returned no row')
  return {
    id: row.id,
    decided_at: row.decided_at instanceof Date ? row.decided_at.toISOString() : String(row.decided_at),
    record_version: row.record_version,
    superseded_by_decision_id: row.superseded_by_decision_id,
  }
}

/**
 * 撤回三步舞（DC-36/DC-39/DC-40）：反向插已在 `insertDecisionRow` 里完成（第 1 步），
 * 这里做第 2、3 步：旧行换指针（带版本条件 + `superseded_by IS NULL` 条件）→ 新行置 NULL。
 * @returns 旧行的新 `record_version`。
 */
async function rewireSupersede(
  client: DatabaseClient,
  input: { tenantId: string; oldId: string; newId: string; expectedRecordVersion: number },
): Promise<number> {
  const { rows } = await client.query<{ record_version: number }>(
    `update recruitment.decision
        set superseded_by_decision_id = $2,
            record_version = record_version + 1,
            updated_at = now()
      where id = $1 and tenant_id = $3
        and superseded_by_decision_id is null
        and record_version = $4
      returning record_version`,
    [input.oldId, input.newId, input.tenantId, input.expectedRecordVersion],
  )
  const row = rows[0]
  if (row === undefined) {
    // 0 行：要么链接已被别人设上（分叉），要么版本不符（DC-40 / DC-39）。
    const after = await loadDecisionById(client, input.tenantId, input.oldId)
    if (after.superseded_by_decision_id !== null) {
      throw evalError('INVALID_ARGS', 'SUPERSEDE_LINK_ALREADY_SET', '这条决策已经被另一次撤回指向，不能再次撤回（DC-40）', {
        decision_id: input.oldId,
        superseded_by_decision_id: after.superseded_by_decision_id,
      })
    }
    throw evalError('VERSION_CONFLICT', 'DECISION_RECORD_VERSION_MISMATCH', '旧决策的 record_version 与 expected_record_version 不一致（DC-39）', {
      decision_id: input.oldId,
      expected: input.expectedRecordVersion,
      actual: after.record_version,
    })
  }
  await client.query(
    `update recruitment.decision
        set superseded_by_decision_id = null, updated_at = now()
      where id = $1 and tenant_id = $2`,
    [input.newId, input.tenantId],
  )
  return row.record_version
}

/** 写后复核：同 `(application, scope, stage_code)` 的 current 必须**恰好 1 条**。 */
async function assertSingleCurrent(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  decisionScope: string,
  stageCode: string,
): Promise<void> {
  const { rows } = await client.query<{ current_count: number }>(
    `select count(*)::int as current_count
       from recruitment.decision d
      where d.tenant_id = $1
        and d.application_id = $2
        and d.decision_scope = $3
        and d.stage_code is not distinct from $4
        and d.superseded_by_decision_id is null`,
    [tenantId, applicationId, decisionScope, stageCode],
  )
  const count = rows[0]?.current_count ?? 0
  if (count === 1) return
  if (count > 1) {
    // 0008 之后这一步通常被 COMMIT 的 23P01 先撞到；留着是为了"索引未生效/被 disable"时也 fail closed。
    throw evalError('ALREADY_DECIDED', 'SCOPE_ALREADY_DECIDED', '同一 (申请, scope, 阶段) 出现了多条当前决策（并发重复）', {
      current_count: count,
    })
  }
  throw evalError('DB_CONSTRAINT_VIOLATION', 'UNIQUE_VIOLATION', '写后复核失败：没有留下任何当前决策（撤回链不完整）', {
    constraint: 'uq_decision_current',
    current_count: count,
  })
}

// =====================================================================
//  出参
// =====================================================================

interface Warning {
  readonly code: string
  readonly message: string
}

/** 把 `null` 键整棵删掉（DSH 校验器不支持 null；见文件头偏差 7）。 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripNulls(item))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (child === null) continue
      out[key] = stripNulls(child)
    }
    return out
  }
  return value
}

// =====================================================================
//  STEP 0→7 主流程
// =====================================================================

/**
 * 在**调用方给的事务**里记录一条 S10 决策（STEP 0→7）。
 *
 * `approve()` 的位置是 **STEP 6 之后、STEP 7 之前**（D-79）：先把"这次调用本来就允许吗"
 * 判完，再去打扰人；`SCORECARD_MISSING` 这类契约负例不会因为 headless 没有 answerer
 * 而被 `APPROVAL_UNAVAILABLE` 遮住。**没有 `allowed-once` 就一行都不写**。
 * @param client - 事务内客户端（actor 已由调用方 `set_config` 设好）。
 * @param cfg - 已解析配置（租户/`execute` 用的 actor 从这里来）。
 * @param rawArgs - 模型给的 arguments（本函数自己跑 STEP 0）。
 * @param nowMs - 服务端"现在"。
 * @param approve - D-79 的人工批准通道（结果见 `ApprovalOutcome`）。
 * @returns TC §4.3 的出参（契约逐字形状；`execute()` 负责去掉 null 键）。
 */
export async function recordDecisionInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  rawArgs: unknown,
  nowMs: number,
  approve: () => Promise<ApprovalOutcome>,
): Promise<Record<string, unknown>> {
  const tenantId = cfg.tenant_id
  // ---- STEP 0 参数 ----
  const args = parseDecisionArgs(rawArgs, nowMs)
  // 决策 id 必须**预生成**：DC-19 的 `approval.resource_id` 要指向它，而 `decision` 整行不可改（G-3）。
  const decisionId = randomUUID()

  // ---- STEP 1 身份 + human_confirmation ----
  const gucActor = await currentActorId(client)
  if (gucActor === null) {
    throw evalError('INVALID_ARGS', 'ACTOR_REQUIRED', '执行上下文没有 actor（SET LOCAL recruitment.actor_id），拒绝写入', {
      hint: 'recruitment.actor_id',
    })
  }
  const actor = await loadActor(client, tenantId, gucActor)
  if (actor === undefined) {
    throw evalError('INVALID_ARGS', 'ACTOR_REQUIRED', '执行上下文的 actor 在该租户下不存在', { actor_id: gucActor })
  }
  assertHumanDecider({
    actorId: actor.id,
    actorKind: actor.kind,
    confirmation: args.human_confirmation,
    nowMs,
    result: args.result,
    reason: args.reason,
    overrideRationale: args.override_rationale ?? null,
    basisRefs: args.basis_refs,
  })

  // ---- STEP 2 存在性 ----
  const screeningScope = args.decision_scope === 'SCREENING'
  // `stage_code` 由 scope 写死（S7→'S7'，S10→'S10'）；查 current / 写行 / 写事件都用同一值。
  const stageCode = stageCodeOf(args.decision_scope)
  const application = await loadApplication(client, tenantId, args.application_id)
  const authority = await loadAuthority(client, tenantId, application.job_id)
  const isHiringManager = computeIsHiringManager(authority, actor.id)
  if (application.rubric_version_id === null) {
    throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', '该申请没有钉住 Rubric 版本，决策无法绑定标准（DC-17）', {
      application_id: application.id,
    })
  }
  const rubric = await loadRubricVersion(client, tenantId, application.rubric_version_id)
  if (args.interview_id !== undefined) {
    await loadInterview(client, tenantId, args.interview_id, application.id)
  }
  // DC-19：approval_id（v1.0 不要求；给了就必须真的绑到这条决策）
  if (args.approval_id !== undefined) {
    await checkApprovalBinding(client, tenantId, args.approval_id, decisionId, nowMs)
  }
  // S7 写侧没有面评面板（也没有面试）：不查 SCORECARD，避免把"别的场次的面评"当成 S7 的依据。
  const scopeScorecards = screeningScope
    ? []
    : await loadScopeScorecards(client, tenantId, application.id, args.interview_id)

  // ---- STEP 3 已有 current / 撤回三绑定 ----
  const current = await loadCurrentDecision(client, tenantId, application.id, args.decision_scope, stageCode)
  let supersedeTarget: DecisionRow | undefined
  if (args.supersedes !== undefined) {
    const target = await loadDecisionById(client, tenantId, args.supersedes.decision_id)
    if (target.application_id !== application.id || target.decision_scope !== args.decision_scope) {
      throw evalError('INVALID_ARGS', 'SUPERSEDE_TARGET_MISMATCH', 'supersedes 指向的决策不是同一申请、同一 scope', {
        decision_id: target.id,
        target_application_id: target.application_id,
        target_decision_scope: target.decision_scope,
        application_id: application.id,
        decision_scope: args.decision_scope,
      })
    }
    if (args.decision_scope === 'STAGE' && target.interview_id !== (args.interview_id ?? null)) {
      throw evalError('INVALID_ARGS', 'SUPERSEDE_TARGET_MISMATCH', 'supersedes 指向的决策属于另一场面试', {
        decision_id: target.id,
        target_interview_id: target.interview_id,
        interview_id: args.interview_id ?? null,
      })
    }
    if (target.superseded_by_decision_id !== null) {
      throw evalError('INVALID_ARGS', 'SUPERSEDE_LINK_ALREADY_SET', '这条决策已经被撤回（单向链，不能再次撤回，DC-40）', {
        decision_id: target.id,
        superseded_by_decision_id: target.superseded_by_decision_id,
      })
    }
    if (target.record_version !== args.supersedes.expected_record_version) {
      throw evalError('VERSION_CONFLICT', 'DECISION_RECORD_VERSION_MISMATCH', 'expected_record_version 与库里不一致（DC-39）', {
        decision_id: target.id,
        expected: args.supersedes.expected_record_version,
        actual: target.record_version,
      })
    }
    // DC-33：新行必须带 basis_refs[SUPERSEDES] 且与 supersedes 入参一致。
    const supersedesBasis = refsOfKind(args.basis_refs, 'SUPERSEDES')
    if (supersedesBasis.length === 0) {
      throw evalError('INVALID_ARGS', 'SUPERSEDE_TARGET_MISMATCH', '撤回时 basis_refs 必须带 SUPERSEDES（DC-33）', {
        required_kind: 'SUPERSEDES',
        decision_id: target.id,
      })
    }
    for (const ref of supersedesBasis) {
      if (asString(ref.decision_id) !== target.id) {
        throw evalError('INVALID_ARGS', 'SUPERSEDE_TARGET_MISMATCH', 'basis_refs[SUPERSEDES].decision_id 与入参不一致（DC-33）', {
          decision_id: target.id,
          provided: asString(ref.decision_id),
        })
      }
      if (asString(ref.opened_by_actor_id).toLowerCase() !== actor.id.toLowerCase()) {
        throw evalError('INVALID_ARGS', 'SUPERSEDE_TARGET_MISMATCH', 'basis_refs[SUPERSEDES].opened_by_actor_id 必须是本次决策人（DC-33）', {
          expected: actor.id,
          provided: asString(ref.opened_by_actor_id),
        })
      }
      if (!nonEmptyString(ref.reason)) {
        throw evalError('INVALID_ARGS', 'SUPERSEDE_TARGET_MISMATCH', 'basis_refs[SUPERSEDES].reason 不得为空（DC-33）', {
          field: 'reason',
        })
      }
    }
    supersedeTarget = target
  } else if (current !== undefined) {
    throw evalError('ALREADY_DECIDED', 'SCOPE_ALREADY_DECIDED', '同一 (申请, scope, 阶段) 已有当前决策；要改必须走 supersedes 撤回（DC §4.3 STEP 3）', {
      application_id: application.id,
      decision_scope: args.decision_scope,
      existing_decision_id: current.id,
      existing_result: current.result,
      existing_record_version: current.record_version,
    })
  }

  // ---- STEP 4 重算汇总（唯一实现）+ 比对 digest ----
  // S7（SCREENING）**没有 S10 汇总**：跳过 STEP 4/5/6，改走 §17.1 的 S7 依据校验。
  let view: SummaryView | undefined
  if (!screeningScope) {
    const summaryRaw = await computeEvaluationSummaryIn(client, cfg, {
      application_id: args.application_id,
      decision_scope: args.decision_scope,
      ...(args.interview_id === undefined ? {} : { interview_id: args.interview_id }),
      as_of: args.as_of,
    }, nowMs)
    view = readSummary(summaryRaw as EvaluationSummary)
    const summaryDigest = args.summary_digest as string
    if (view.digest !== summaryDigest.toLowerCase()) {
      throw evalError('INVALID_ARGS', 'SUMMARY_STALE', 'summary_digest 不是本次重算的值（不得拿旧汇总做新决定，DC-16/DC-34）', {
        expected: view.digest,
        provided: args.summary_digest,
        as_of: args.as_of,
      })
    }
    for (const ref of refsOfKind(args.basis_refs, 'SUMMARY')) {
      if (asString(ref.summary_digest) !== view.digest) {
        throw evalError('INVALID_ARGS', 'SUMMARY_STALE', 'basis_refs[SUMMARY].summary_digest 与本次重算值不一致（DC-16）', {
          expected: view.digest,
          provided: asString(ref.summary_digest),
        })
      }
    }
    const basisCtx: BasisContext = {
      args,
      view,
      application,
      rubric,
      actorId: actor.id,
      isHiringManager,
      hiringManagerActorId: authority.hiring_manager_actor_id,
      scorecards: scopeScorecards,
    }
    await checkBasisSemantics(client, tenantId, basisCtx)

    // ---- STEP 5 阻断（未处理人工队列 / 未澄清 unreadable / record 未校验）----
    checkSummaryBlockers({ args, view })

    // ---- STEP 6 结果门禁 ----
    await checkReasonCitesDimension(client, tenantId, args)
    checkResultGate({ args, view, scorecards: scopeScorecards })
    // DC §6.1：默认每次决策至少 1 条 SCORECARD 依据；唯一例外是 {WITHDRAW,HOLD} ∧ submitted=0。
    const scorecardRefs = refsOfKind(args.basis_refs, 'SCORECARD')
    const scorecardBasisRequired = view.submitted > 0
    if (scorecardBasisRequired && scorecardRefs.length === 0) {
      throw evalError('INVALID_ARGS', 'BASIS_REF_EMPTY', '面板里有可用面评时，basis_refs 至少要引一条 SCORECARD（DC §6.1）', {
        missing_kinds: ['SCORECARD'],
        submitted: view.submitted,
      })
    }
    // DC §6.1：PROCEED_WITH_MISSING 时必须带 MISSING_ACK，且集合与逐条确认一致。
    if (args.missing_disposition === 'PROCEED_WITH_MISSING') {
      const ackIds = args.acknowledged_missing.map((entry) => entry.interviewer_id)
      const ackBasis = refsOfKind(args.basis_refs, 'MISSING_ACK')
      const basisIds = ackBasis.flatMap((ref) => asArray(ref.interviewer_ids).map((id) => String(id)))
      if (ackBasis.length === 0 || !sameIdSet(basisIds, ackIds)) {
        throw evalError('INVALID_ARGS', 'MISSING_ACK_MISMATCH', 'basis_refs[MISSING_ACK].interviewer_ids 必须与 acknowledged_missing 集合一致（DC §6.1）', {
          acknowledged_missing: ackIds,
          basis_interviewer_ids: basisIds,
        })
      }
    }
  } else {
    // ---- STEP 2'S（S7 写侧）：§17.1 ----
    await checkScreeningBasisSemantics(client, tenantId, {
      args,
      application,
      rubric,
      actorId: actor.id,
      isHiringManager,
      hiringManagerActorId: authority.hiring_manager_actor_id,
    })
    // DC-18 对 S7 的 REJECT 同样适用（理由要引到 rubric 的 criterion key）。
    await checkReasonCitesDimension(client, tenantId, args)
  }
  const scorecardRefs = refsOfKind(args.basis_refs, 'SCORECARD')

  // ---- STEP 6.5 人机闸门（D-95：人只做一次决策）----
  // 人在对话里明确指示过（IN_CHAT + 原话）→ 那就是那一次决策，**不再弹二次确认**。
  // 只有确实需要留痕签名的旧方式（IN_APP_CONFIRM / SIGNED_RECORD）才走 approval 通道。
  const humanConfirmation = args.human_confirmation as Record<string, unknown> | undefined
  const confirmationMethod = typeof humanConfirmation?.confirmation_method === 'string'
    ? humanConfirmation.confirmation_method
    : undefined
  const confirmationText = typeof humanConfirmation?.confirmation_text === 'string'
    && humanConfirmation.confirmation_text.trim() !== ''
    ? humanConfirmation.confirmation_text
    : undefined
  // pre-image 版本：有原话 = v2（D-95）；没有 = v1（旧口径，旧记录仍按它验）。
  const confirmationPreimageVersion = confirmationText === undefined ? 1 : 2
  if (confirmationMethod !== 'IN_CHAT') {
    const approvalOutcome = await approve()
    requireApprovalGranted(approvalOutcome)
  }

  // ---- STEP 7 写入（内部事件 → decision → 撤回三步舞 → 写后复核）----
  const eventId = randomUUID()
  const screeningEvaluation = refsOfKind(args.basis_refs, 'SCREENING_EVALUATION')[0]
  let written: WrittenDecision
  let supersededRecordVersion: number | undefined
  try {
    await insertDecisionEvent(client, {
      tenantId,
      decisionId,
      eventId,
      payload: {
        decision_id: decisionId,
        supersedes_decision_id: supersedeTarget?.id ?? null,
        application_id: application.id,
        interview_id: args.interview_id ?? null,
        decision_scope: args.decision_scope,
        stage_code: stageCode,
        result: args.result,
        from_result: supersedeTarget?.result ?? null,
        to_result: args.result,
        actor_id: actor.id,
        // S10：重算出来的 summary_digest；S7：那次 screening 评估的 evaluation_digest（§17.1）。
        summary_digest: view === undefined ? null : view.digest,
        screening_evaluation_digest: screeningEvaluation === undefined
          ? null
          : asString(screeningEvaluation.evaluation_digest),
        approval_id: args.approval_id ?? null,
        // D-95：把「人怎么授权的」写进内部事件，事后可与会话日志对账（原话 + 哈希 + 会话日志）。
        human_confirmation_method: confirmationMethod ?? null,
        human_confirmation_text: typeof humanConfirmation?.confirmation_text === 'string'
          ? humanConfirmation.confirmation_text
          : null,
        human_confirmation_text_sha256: typeof humanConfirmation?.confirmation_text_sha256 === 'string'
          ? humanConfirmation.confirmation_text_sha256
          : null,
        human_confirmation_preimage_version: confirmationPreimageVersion,
      },
    })
    written = await insertDecisionRow(client, {
      tenantId,
      args,
      actorId: actor.id,
      decisionId,
      supersededBy: supersedeTarget?.id ?? null,
      stageCode,
    })
    if (supersedeTarget !== undefined) {
      supersededRecordVersion = await rewireSupersede(client, {
        tenantId,
        oldId: supersedeTarget.id,
        newId: decisionId,
        expectedRecordVersion: supersedeTarget.record_version,
      })
    }
    await assertSingleCurrent(client, tenantId, application.id, args.decision_scope, stageCode)
  } catch (error) {
    translateWriteError(error)
  }

  // provenance：S10 取重算汇总的标签；S7 取 SCREENING_EVALUATION.provenance，缺省 = FIXTURE
  // （R4：没有证据就不许自称 LIVE；`screening_evaluate` 的 labels 由写侧抄进依据）。
  const decisionProvenance = view !== undefined
    ? view.provenance
    : (asString(screeningEvaluation?.provenance) === 'LIVE' ? 'LIVE' : 'FIXTURE')

  // ---- warnings（TC §4.7 封闭集，顺序固定）----
  const warnings: Warning[] = []
  if (!isHiringManager) {
    warnings.push({
      code: 'DECIDER_NOT_HIRING_MANAGER',
      message: '决策人不是该部门的招聘负责人；v1.0 不拦截，仅记录（DC-14）',
    })
  }
  if (authority.hiring_manager_actor_id === null) {
    warnings.push({
      code: 'HIRING_MANAGER_UNSET',
      message: '该部门没有登记招聘负责人，is_hiring_manager 一律为 false（DC-15）',
    })
  }
  if (!screeningScope && view !== undefined) {
    if (args.missing_disposition === 'PROCEED_WITH_MISSING') {
      warnings.push({
        code: 'PROCEEDED_WITH_MISSING_SCORECARDS',
        message: `${args.acknowledged_missing.length} 份必填面评缺失，已逐条确认后推进`,
      })
    }
    if (view.minorityCount > 0) {
      warnings.push({ code: 'MINORITY_DISSENT', message: '面板里有少数派意见，原文见汇总的 minority_reports[]' })
    }
    const opposite = (args.result === 'REJECT' && consensusDirection(view.consensus) === 'ADVANCE')
      || (args.result === 'ADVANCE' && consensusDirection(view.consensus) === 'REJECT')
    if (opposite) {
      warnings.push({ code: 'OVERRIDE_APPLIED', message: '结论与汇总的 consensus 相反，已要求决策人写明理由（DC-28）' })
    }
    if (scorecardRefs.some((ref) => ref.evidence_state === 'MEMORY_ONLY')) {
      warnings.push({ code: 'REJECT_BASIS_MEMORY_ONLY', message: '依据里有凭现场记忆的面评（evidence=[]、evidence_state=MEMORY_ONLY，DC-22）' })
    }
  }
  if (decisionProvenance === 'FIXTURE') {
    warnings.push({ code: 'FIXTURE_BASIS', message: '本次决策依据的是演练数据（provenance=FIXTURE），不是真实外部事实' })
  }
  if (supersedeTarget !== undefined) {
    warnings.push({ code: 'SUPERSEDES_APPLIED', message: '本次是撤回/重开：旧决策保留，新决策成为当前行' })
  }
  if (args.approval_id !== undefined) {
    warnings.push({ code: 'APPROVAL_ATTACHED', message: '已按 DC-19 绑定审批记录（v1.0 不要求）' })
  }

  // S10 出参带 `gate`（汇总门禁回显）；S7（SCREENING）没有汇总 → 出参没有这个键（偏差 11）。
  const gate: Record<string, unknown> | undefined = screeningScope || view === undefined
    ? undefined
    : {
      as_of: args.as_of,
      ready_for_decision: view.ready,
      ...(args.missing_disposition === undefined ? {} : { missing_disposition: args.missing_disposition }),
      acknowledged_missing: args.acknowledged_missing.map((entry) => ({
        interviewer_id: entry.interviewer_id,
        why_proceed: entry.why_proceed,
      })),
      permitted_results_echo: [...view.permitted],
      summary_digest: view.digest,
    }

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    replayed: false,
    labels: { provenance: decisionProvenance, trigger: 'MANUAL', connection: 'CONNECTED' },
    decision: {
      id: written.id,
      application_id: args.application_id,
      ...(args.interview_id === undefined ? {} : { interview_id: args.interview_id }),
      decision_scope: args.decision_scope,
      stage_code: stageCode,
      result: args.result,
      decided_by_actor_id: actor.id,
      decided_at: written.decided_at,
      record_version: written.record_version,
      // 新行在 STEP 7 的第 3 步之后一定是 NULL（契约画 null；execute() 会去掉这个键）。
      superseded_by_decision_id: written.superseded_by_decision_id,
    },
    ...(gate === undefined ? {} : { gate }),
    superseded: supersedeTarget === undefined
      ? null
      : { decision_id: supersedeTarget.id, record_version: supersededRecordVersion ?? supersedeTarget.record_version + 1 },
    event: { event_id: eventId, provider: 'internal', trust_level: 'INTERNAL' },
    warnings,
  }
}

// =====================================================================
//  工具定义
// =====================================================================

/** 从执行上下文里取 `agent` / `signal`（DSH 的 `exec` 是 unknown）。 */
function readExecContext(exec: unknown): { agent?: unknown; signal?: AbortSignal } | undefined {
  if (!isPlainObject(exec)) return undefined
  const agent = exec.agent
  const signal = exec.signal
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(signal instanceof AbortSignal ? { signal } : {}),
  }
}

function renderDecision(value: unknown): readonly TextBlock[] {
  const v = value as Record<string, unknown>
  const decision = (v.decision ?? {}) as Record<string, unknown>
  const gate = isPlainObject(v.gate) ? v.gate : undefined
  const warnings = Array.isArray(v.warnings) ? (v.warnings as Record<string, unknown>[]) : []
  const labels = (v.labels ?? {}) as Record<string, unknown>
  const event = (v.event ?? {}) as Record<string, unknown>
  const superseded = isPlainObject(v.superseded) ? v.superseded : undefined
  const lines = [
    `${String(v.tool)} ${String(v.contract_version)} status=${String(v.status)}`,
    `labels: provenance=${String(labels.provenance)} trigger=${String(labels.trigger)} connection=${String(labels.connection)}`,
    `decision ${String(decision.id)} scope=${String(decision.decision_scope)} stage=${String(decision.stage_code)} `
      + `result=${String(decision.result)} record_version=${String(decision.record_version)}`,
    `decided_at=${String(decision.decided_at)} decided_by=${String(decision.decided_by_actor_id)}`,
  ]
  if (gate === undefined) {
    // SCREENING：没有 S10 汇总门禁（§17.1）。
    lines.push('gate: —（SCREENING 没有 S10 汇总）')
  } else {
    lines.push(
      `gate: as_of=${String(gate.as_of)} ready_for_decision=${String(gate.ready_for_decision)} `
      + `permitted=[${(Array.isArray(gate.permitted_results_echo) ? gate.permitted_results_echo : []).join(',')}]`,
    )
    lines.push(`summary_digest=${String(gate.summary_digest)}`)
  }
  lines.push(
    superseded === undefined
      ? 'superseded: —（本次不是撤回）'
      : `superseded: ${String(superseded.decision_id)} → record_version=${String(superseded.record_version)}`,
    `event ${String(event.event_id)} ${String(event.provider)}/${String(event.trust_level)}`,
    `warnings(${warnings.length})`,
  )
  for (const warning of warnings) lines.push(`  ${String(warning.code)}: ${String(warning.message)}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 造一个绑定配置的决策工具（D-79：**approval 缺省即拒绝**，不存在"直接写库"的分支）。
 * @param deps - 数据库配置 + 可选的 approval 窄接口。
 */
export function createDecisionRecordTool(deps: DecisionToolDeps): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Formal decision record for ONE application: decision_scope=SCREENING (S7, stage_code=S7, no interview_id '
      + 'and no S10 summary) or STAGE/FINAL (S10, stage_code=S10). The decision itself is made by a HUMAN; this '
      + 'tool only verifies and records it: for S10 it re-computes the evaluation summary (same as_of) and enforces '
      + 'the result gate (WITHDRAW/HOLD always allowed; ADVANCE(FINAL)/REJECT blocked when required scorecards are '
      + 'missing); for S7 it only checks the screening-evaluation binding. It requires human_confirmation whose '
      + 'sha256 covers {result, reason, override_rationale, basis_refs} (plus the human\'s verbatim words for '
      + 'IN_CHAT, D-95), asks the human for approval when the confirmation is not IN_CHAT (no answerer => '
      + 'unavailable => nothing is written), then writes one decision row plus its internal event in the same '
      + 'transaction (supersede = reverse-insert, rewire, clear). It never writes application/interview status and '
      + 'accepts no tenant/actor/stage_code input.',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => renderDecision(value) },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      const context = readExecContext(exec)
      const approve = makeApprovalRequest(deps.approval, context)
      // 参数在事务内 STEP 0 才校验（判定顺序本身是规则，DC-05）；approval 在 STEP 6.5 才问。
      const pool = createPool(deps.database)
      try {
        const value = await withActor(pool, deps.database.actor_id, async (client) => (
          recordDecisionInTransaction(client, deps.database, rawArgs, Date.now(), approve)
        ))
        // DSH 的输出校验器不支持 null（见文件头偏差 7）→ 契约里画 null 的键在这里被省略。
        return stripNulls(value)
      } catch (error) {
        // P1-1：`0008` 的 `uq_decision_current` 是 DEFERRABLE，冲突在 **COMMIT** 才抛 23P01。
        // 那次 COMMIT 发生在 `withActor` 里（STEP 7 的 try/catch 之外），所以这里必须再翻一次，
        // 否则模型/用户会看到库内部 SQLSTATE 而不是 `ALREADY_DECIDED`。
        translateWriteError(error)
      } finally {
        await closePool(pool)
      }
    },
  }
}
