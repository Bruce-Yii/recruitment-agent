// record_human_decision —— 「人类已经在业务里拍板，Agent 只把它记录下来」的**高层 Agent 动作**。
//
// 背景（work/review/2026-11-16-notion-acceptance/14-PRODUCT-BUSINESS-VERDICT.md §2.1）：
//   真实 HR 场景里，Agent 为了记录一次 S7 初筛决定，不得不读 `decision-rules.md` / 源码，
//   研究 canonical JSON / basis_refs 规范化 / AUTHORITY 的 `is_hiring_manager` 计算，自己算
//   confirmation preimage 哈希 —— 2 轮 42 步 3.3M tokens。产品缺一个"与 UI 同级"的高层动作。
//
// 本工具就是这个动作。它把工程细节全部收回服务端：
//   * 入参只有业务语义：`application_id` / `decision_scope` / `result` / `reason` /
//     `human_confirmation{ confirmed_by_actor_id?, confirmed_at, method, text }`；
//   * **服务端组装** `basis_refs`（SUMMARY / RUBRIC_VERSION / AUTHORITY / SCORECARD /
//     SCREENING_EVALUATION / RESUME_VERSION）、`AUTHORITY.is_hiring_manager`、`summary_digest`、
//     `RUBRIC_VERSION.payload_hash` 与 `human_confirmation.confirmation_text_sha256`；
//   * Agent **不能**传 hash / digest / basis_refs / interview_id / actor / tenant / 阶段码 ——
//     传了就是 `SERVER_DERIVED_REJECTED`（零写入）。
//
// 领域规则**不重写**：写入仍然走 `decision-record.ts` 的
// `parseDecisionArgs` → `recordDecisionInTransaction`（STEP 0→7、S10 阶段闸门、SC-11 版本绑定、
// DC-08..11 人工确认、D-79 approval、DC-30..40 撤回、decision.record 内部事件）。
// 本文件只负责三件领域之外的事：
//   1) 把高层入参翻译成领域入参（服务端事实 + 服务端派生 hash）；
//   2) 读事实（申请/岗位/rubric/部门负责人/面评/汇总/初筛评估）——只读；
//   3) 写后**另开连接独立读回** decision 行 + `decision.record` 事件的确认元数据，出参只来自读回。
//
// 权限/租户/身份口径与既有写工具一致：`resolveWriteActor(exec, identity, legacyActorId)`，
// 拿不到 session/绑定/映射就 fail-closed（`DEMO_ACTOR_UNMAPPED`，零写入）。
//
// 与低层工具 `recruitment_decision_record` 的关系：
//   * 本工具是**面向 Agent 的高层入口**（写库语义与 UI facade 同源）；
//   * 低层工具仍是领域权威：同样的 STEP、同样的错误码；本工具绝不绕过它。
//   * 差异：本工具不接受 client 传 basis/hash/approval 等内部知识，也不支持 supersedes
//     （撤回是另一个业务动作，应走低层工具或后续高层动作）。
//
// 已知边界（必须与交付说明一致）：
//   1. `decision_scope=STAGE` 需要"这一场面试"，但高层入参刻意不收 `interview_id`
//      （Agent 只该谈业务）。服务端按申请事实**唯一推导**：非取消面试恰好 1 场 → 用它；
//      0 场 → `STAGE_INTERVIEW_REQUIRED`；多场 → `STAGE_INTERVIEW_AMBIGUOUS`（零写入，让模型
//      去问人"哪一轮"，而不是猜）。
//   2. 阶段闸门在领域之外再补一层**方向性守卫**（不改领域语义）：
//      * SCREENING 只在申请当前阶段 ∈ {S6, S7} 时允许（S7 是初筛写侧；S10 再录初筛是脏数据）；
//      * STAGE / FINAL 仍由领域强制 `current_stage_code='S10'`（DC-07），本工具提前 fail-fast，
//        让模型看到 `STAGE_NOT_S10` 而不是被 summary 错误遮蔽。
//   3. `human_confirmation.text` 两种 method 都必填：它进 v2 pre-image（D-95），写后可从
//      `decision.record` 事件 payload 复算。IN_APP_CONFIRM 仍需 D-79 approval 通道（领域规则），
//      headless 无应答者时 fail-closed（`APPROVAL_UNAVAILABLE`，零写入）。
//   4. `decision.record` 事件 payload 的确认元数据字段（`confirmed_at` /
//      `confirmed_by_actor_id` / `confirmation_method` / `confirmation_text_sha256`；既有
//      `human_confirmation_*` 键保留）由 `decision-record.ts` 的 wiring 补丁落
//      （见 `work/d5/product-decision/wiring/decision-record-confirmation-event.patch`）。
//      本工具写后读回会**核对**这四个字段；缺失时如实报 `EVENT_CONFIRMATION_METADATA_MISSING`
//      警告（不假装持久化成功）。
//   5. 本工具不写任何状态（application/interview/scorecard），与低层工具同口径。
//      例外（D-141③，`docs/17`）：SCREENING 的 `ADVANCE` / `REJECT` 由**领域**在同一个事务里
//      派生 S6→S7（只派生 T1；幂等；材料/rubric 不满足则整体回滚）；`REJECT` 另把生命周期
//      `ACTIVE → CLOSED`（2026-11-16 lead 收窄裁定：用既有 CLOSED 取值/既有事件类型）。
//      本工具不自己写阶段/生命周期、也不检查/放宽任何阶段闸门 —— 它只把写后独立读回的
//      `stage`（含 lifecycle_before/after）一并回显，让模型不需要再补一次 `stage_advance`
//      （那正是 D-141 要消灭的多余失败点）。
import { isUuid } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type DatabaseClient,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { computeEvaluationSummaryIn, scorecardShapeViolations } from './evaluation-summarize.ts'
import { evaluateInTransaction } from './screening-evaluate.ts'
import {
  confirmationTextSha256,
  makeApprovalRequest,
  parseDecisionArgs,
  recordDecisionInTransaction,
  stripNulls,
  translateWriteError,
  type DecisionArgs,
} from './decision-record.ts'
import { resolveWriteActor } from '../demo-actor/tool-actor.ts'
import type { ToolActorDeps } from '../demo-actor/tool-actor.ts'
// render 口径 helper（O1 残留修复轮）：人读正文只放业务标识 / 短号；完整编号只允许出现在
// 末尾 machine arguments 区（模型要原样复制才能调下游工具），见 render-ref.ts 文件头。
import { machineArgumentLines, shortHash, shortRef } from './render-ref.ts'
import { EVENT_TYPES } from '../runtime/event-types.ts'

/** 工具名（DSH 全局唯一）。**不用 `recruitment_` 前缀**：这是产品级动作名（verdict §4.1）。 */
const TOOL_NAME = 'record_human_decision'
/** 出参契约版本。 */
const CONTRACT_VERSION = 'record-human-decision 1.0.0'
/** 本文件自己的 reason_code 封闭集（其余来自领域/契约层）。 */
const REASON = {
  UNKNOWN_PARAM: 'UNKNOWN_PARAM',
  SERVER_DERIVED_REJECTED: 'SERVER_DERIVED_REJECTED',
  TENANT_OR_ACTOR_NOT_ALLOWED: 'TENANT_OR_ACTOR_NOT_ALLOWED',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  ENUM_INVALID: 'ENUM_INVALID',
  ID_NOT_UUID: 'ID_NOT_UUID',
  /** O3：形状合法但语义伪造的凭据（全零 UUID / 全零 hash）—— 显式拒绝，零写入。 */
  PLACEHOLDER_CONFIRMATION: 'PLACEHOLDER_CONFIRMATION',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  RESULT_NOT_IN_V1_SCOPE: 'RESULT_NOT_IN_V1_SCOPE',
  CONFIRMATION_SUBJECT_MISMATCH: 'CONFIRMATION_SUBJECT_MISMATCH',
  CONFIRMATION_TIME_INVALID: 'CONFIRMATION_TIME_INVALID',
  CONFIRMATION_TIME_IN_FUTURE: 'CONFIRMATION_TIME_IN_FUTURE',
  STAGE_NOT_SCREENING_STAGE: 'STAGE_NOT_SCREENING_STAGE',
  STAGE_REQUIRES_INTERVIEW: 'STAGE_REQUIRES_INTERVIEW',
  STAGE_INTERVIEW_AMBIGUOUS: 'STAGE_INTERVIEW_AMBIGUOUS',
  APPLICATION_NOT_FOUND: 'APPLICATION_NOT_FOUND',
  ACTOR_NOT_HUMAN: 'ACTOR_NOT_HUMAN',
  NO_RUBRIC: 'NO_RUBRIC',
  MISSING_SUMMARY: 'MISSING_SUMMARY',
  MISSING_SCREENING_EVALUATION: 'MISSING_SCREENING_EVALUATION',
  EVIDENCE_INSUFFICIENT: 'EVIDENCE_INSUFFICIENT',
  READBACK_MISSING: 'READBACK_MISSING',
  EVENT_CONFIRMATION_METADATA_MISSING: 'EVENT_CONFIRMATION_METADATA_MISSING',
} as const

/** 人工确认方式（任务书封闭集；SIGNED_RECORD 是低层工具的旧口径，高层不收）。 */
const CONFIRMATION_METHODS = ['IN_APP_CONFIRM', 'IN_CHAT'] as const
/** 结果封闭集（HIRED 在 v1.0 禁用，与领域同口径）。 */
const RESULTS = ['ADVANCE', 'HOLD', 'REJECT', 'WITHDRAW'] as const
/** 高层入参**不接受**的服务端派生键（命中就明确拒绝，不静默忽略）。 */
const SERVER_DERIVED_KEYS = [
  'basis_refs',
  'summary_digest',
  'confirmation_text_sha256',
  'confirmation_preimage_version',
  'as_of',
  'interview_id',
  'approval_id',
  'override_rationale',
  'missing_disposition',
  'acknowledged_missing',
  'supersedes',
] as const
/** 身份键（TC §1.6）：只能来自服务端绑定。 */
const IDENTITY_KEYS = ['tenant_id', 'actor_id', 'decided_by_actor_id', 'decided_at', 'stage_code', 'status'] as const
/** 事实元组：申请 + 岗位 + 部门负责人 + rubric（一次读全）。 */
const HEX64_RE = /^[0-9a-f]{64}$/
/** 全零 UUID：形状合法但不是真实身份（O3 的伪造凭据场景）。 */
const PLACEHOLDER_UUID_RE = /^0{8}-0{4}-0{4}-0{4}-0{12}$/
/** 占位凭据的人话拒绝语（O3：message 直接给人/模型看）。 */
const PLACEHOLDER_CONFIRMATION_MESSAGE = '确认人必须是真实身份，不能用占位值'
/** 确认时间与服务端 now 的允许偏移（只挡明显未来值；领域还会按 decided_at 再校验一次）。 */
const CONFIRMATION_FUTURE_SKEW_MS = 60_000
/** 确认原话长度上限（与低层查询同一口径）。 */
const CONFIRMATION_TEXT_MAX = 2000
/** 理由长度上限（与领域 `REASON_MAX` 同一口径）。 */
const REASON_MAX = 4000

/** 本工具依赖：数据库 + approval 窄接口 + Demo Actor 身份（与低层决策工具同形）。 */
export interface RecordHumanDecisionDeps extends ToolActorDeps {
  readonly database: ResolvedDatabaseConfig
  /** DSH `ctx.approval` 的窄接口（D-79）。**缺省 = 一律拒绝**（IN_APP_CONFIRM 会因此零写入）。 */
  readonly approval?: {
    request(req: {
      agent?: unknown
      toolName: string
      reason?: string
      signal?: AbortSignal
    }): Promise<string>
  }
  /** 测试接缝：服务端"现在"（缺省 `Date.now`）。 */
  readonly now?: () => number
}

/** 造一个 `<CODE>: <compact-json>` 形态的工具错误（与 decision-record.ts 的 evalError 同形）。 */
function toolError(
  code: string,
  reasonCode: string,
  message: string,
  detail?: unknown,
): RecruitmentToolError {
  const body: Record<string, unknown> = { code, reason_code: reasonCode, message }
  if (detail !== undefined) body.detail = detail
  return new RecruitmentToolError(code as never, canonicalJsonSafe(body))
}

/** 稳定键序 JSON（不 import contract.ts 的 canonicalJson 以免和错误信封语义混淆）。 */
function canonicalJsonSafe(value: unknown): string {
  return JSON.stringify(value)
}

/** 非空字符串？ */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** 普通对象？ */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 高层入参（已解析/已校验）。 */
interface ParsedInput {
  readonly application_id: string
  readonly decision_scope: 'SCREENING' | 'STAGE' | 'FINAL'
  readonly result: (typeof RESULTS)[number]
  readonly reason: string
  readonly human_confirmation: {
    readonly confirmed_by_actor_id?: string
    readonly confirmed_at: string
    readonly method: (typeof CONFIRMATION_METHODS)[number]
    readonly text: string
  }
}

/** 高层入参 schema（官方可接受子集：无 null / 无 type 数组）。 */
const HUMAN_CONFIRMATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    confirmed_by_actor_id: {
      type: 'string',
      description: '确认人（UUID）。可省略 = 执行上下文的 actor；给了就必须与执行上下文一致（DC-09）。',
    },
    confirmed_at: {
      type: 'string',
      description: '人确认的时间（ISO-8601 带时区偏移，如 2026-11-16T09:30:00+08:00）；与决策时刻相差 ≤ 24h。',
    },
    method: {
      type: 'string',
      enum: [...CONFIRMATION_METHODS],
      description: 'IN_CHAT = 人在对话里明确说过；IN_APP_CONFIRM = 人在应用里点过确认（需要 D-79 批准通道）。',
    },
    text: {
      type: 'string',
      description: '人确认时的原话（逐字，1..2000 字符）。它进 confirmation pre-image v2；服务端据此算 sha256。',
    },
  },
  required: ['confirmed_at', 'method', 'text'],
  additionalProperties: false,
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    application_id: { type: 'string', description: '申请 id（UUID）。' },
    decision_scope: {
      type: 'string',
      enum: ['SCREENING', 'STAGE', 'FINAL'],
      description: 'SCREENING = S7 初筛决定；STAGE = S10 某一场面试后的决定；FINAL = S10 终局决定。',
    },
    result: {
      type: 'string',
      enum: [...RESULTS],
      description: '人做出的结论（HIRED 在 v1.0 禁用）。',
    },
    reason: {
      type: 'string',
      description: '人给出的理由（1..4000 字符，进 confirmation pre-image）。',
    },
    human_confirmation: {
      ...HUMAN_CONFIRMATION_SCHEMA,
      description: '人是怎么确认的（原话 + 时间 + 方式）。服务端算 hash，调用方不得传任何 hash/digest/basis。',
    },
  },
  required: ['application_id', 'decision_scope', 'result', 'reason', 'human_confirmation'],
  additionalProperties: false,
}

/**
 * 解析并校验高层入参（**不碰库**）。
 *
 * 明确拒绝服务端派生键 / 身份键（这条是产品契约：Agent 不该知道 hash 怎么算）。
 * @param raw - DSH 交给工具的 arguments（未校验）。
 * @returns 已校验的高层入参。
 */
function parseInput(raw: unknown): ParsedInput {
  if (!isPlainObject(raw)) {
    throw toolError('INVALID_ARGS', REASON.TYPE_MISMATCH, 'arguments 必须是 JSON 对象', { path: 'arguments' })
  }
  const allowed = PARAMETERS.properties as Record<string, unknown>
  const serverDerived = new Set<string>(SERVER_DERIVED_KEYS)
  const identityKeys = new Set<string>(IDENTITY_KEYS)
  for (const key of Object.keys(raw).sort()) {
    if (serverDerived.has(key)) {
      throw toolError(
        'INVALID_ARGS',
        REASON.SERVER_DERIVED_REJECTED,
        `${key} 由服务端从业务事实组装，调用方不得传入（本工具不收 hash / digest / basis / interview_id）`,
        { rejected: [key] },
      )
    }
    if (identityKeys.has(key)) {
      throw toolError(
        'INVALID_ARGS',
        REASON.TENANT_OR_ACTOR_NOT_ALLOWED,
        `${key} 只能来自执行上下文/服务端，不接受入参（TC §1.6）`,
        { rejected: [key] },
      )
    }
    if (!Object.hasOwn(allowed, key)) {
      throw toolError('INVALID_ARGS', REASON.UNKNOWN_PARAM, `未知参数 ${key}`, {
        unknown_keys: [key],
        allowed: Object.keys(allowed).sort(),
      })
    }
  }
  const missing = ['application_id', 'decision_scope', 'result', 'reason', 'human_confirmation']
    .filter((key) => raw[key] === undefined)
  if (missing.length > 0) {
    throw toolError('INVALID_ARGS', REASON.MISSING_REQUIRED, '缺少必填参数', { missing })
  }
  if (!isUuid(raw.application_id)) {
    throw toolError('INVALID_ARGS', REASON.ID_NOT_UUID, 'application_id 必须是 UUID', { path: 'application_id' })
  }
  const scope = raw.decision_scope
  if (scope !== 'SCREENING' && scope !== 'STAGE' && scope !== 'FINAL') {
    throw toolError('INVALID_ARGS', REASON.ENUM_INVALID, 'decision_scope 只能是 SCREENING / STAGE / FINAL', {
      path: 'decision_scope',
      got: typeof scope === 'string' ? scope.slice(0, 64) : `[${typeof scope}]`,
    })
  }
  const result = raw.result
  if (result === 'HIRED') {
    throw toolError('INVALID_ARGS', REASON.RESULT_NOT_IN_V1_SCOPE, 'HIRED 在 v1.0 禁用（S11 缓做）', {
      path: 'result',
    })
  }
  if (typeof result !== 'string' || !(RESULTS as readonly string[]).includes(result)) {
    throw toolError('INVALID_ARGS', REASON.ENUM_INVALID, 'result 只能是 ADVANCE / HOLD / REJECT / WITHDRAW', {
      path: 'result',
      got: typeof result === 'string' ? result.slice(0, 64) : `[${typeof result}]`,
    })
  }
  const reason = raw.reason
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw toolError('INVALID_ARGS', REASON.TYPE_MISMATCH, 'reason 必须是非空字符串（人写的理由）', { path: 'reason' })
  }
  if (reason.length > REASON_MAX) {
    throw toolError('INVALID_ARGS', REASON.OUT_OF_RANGE, `reason 最多 ${REASON_MAX} 字符`, {
      path: 'reason',
      length: reason.length,
    })
  }
  const confirmation = raw.human_confirmation
  if (!isPlainObject(confirmation)) {
    throw toolError('INVALID_ARGS', REASON.TYPE_MISMATCH, 'human_confirmation 必须是对象', {
      path: 'human_confirmation',
    })
  }
  const confirmationAllowed = HUMAN_CONFIRMATION_SCHEMA.properties as Record<string, unknown>
  for (const key of Object.keys(confirmation).sort()) {
    if (!Object.hasOwn(confirmationAllowed, key)) {
      throw toolError('INVALID_ARGS', REASON.SERVER_DERIVED_REJECTED, `human_confirmation 不接受 ${key}（hash 由服务端算）`, {
        rejected: [`human_confirmation.${key}`],
        allowed: Object.keys(confirmationAllowed).sort(),
      })
    }
  }
  const confirmedAt = confirmation.confirmed_at
  if (typeof confirmedAt !== 'string') {
    throw toolError('INVALID_ARGS', REASON.MISSING_REQUIRED, 'human_confirmation.confirmed_at 必填（ISO-8601 带偏移）', {
      path: 'human_confirmation.confirmed_at',
    })
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(confirmedAt)
    || !Number.isFinite(Date.parse(confirmedAt))) {
    throw toolError('INVALID_ARGS', REASON.CONFIRMATION_TIME_INVALID, 'confirmed_at 必须是带时区偏移的 ISO-8601 时间', {
      path: 'human_confirmation.confirmed_at',
    })
  }
  const method = confirmation.method
  if (typeof method !== 'string' || !(CONFIRMATION_METHODS as readonly string[]).includes(method)) {
    throw toolError('INVALID_ARGS', REASON.ENUM_INVALID, 'human_confirmation.method 只能是 IN_APP_CONFIRM / IN_CHAT', {
      path: 'human_confirmation.method',
      allowed: [...CONFIRMATION_METHODS],
    })
  }
  const text = confirmation.text
  if (typeof text !== 'string' || text.trim() === '') {
    throw toolError('INVALID_ARGS', REASON.TYPE_MISMATCH, 'human_confirmation.text 必须是人的原话（非空字符串）', {
      path: 'human_confirmation.text',
    })
  }
  if (text.length > CONFIRMATION_TEXT_MAX) {
    throw toolError('INVALID_ARGS', REASON.OUT_OF_RANGE, `human_confirmation.text 最多 ${CONFIRMATION_TEXT_MAX} 字符`, {
      path: 'human_confirmation.text',
      length: text.length,
    })
  }
  const confirmedBy = confirmation.confirmed_by_actor_id
  if (confirmedBy !== undefined) {
    if (!isUuid(confirmedBy)) {
      throw toolError('INVALID_ARGS', REASON.ID_NOT_UUID, 'human_confirmation.confirmed_by_actor_id 必须是 UUID', {
        path: 'human_confirmation.confirmed_by_actor_id',
      })
    }
    // O3：全零 UUID 能通过形状校验，但它不是真实身份 —— 入参层显式拒绝（零写入，
    // 不能滑到后面"替别人确认"那种难懂的错）。
    if (PLACEHOLDER_UUID_RE.test(confirmedBy.toLowerCase())) {
      throw toolError(
        'INVALID_ARGS',
        REASON.PLACEHOLDER_CONFIRMATION,
        `${PLACEHOLDER_CONFIRMATION_MESSAGE}（human_confirmation.confirmed_by_actor_id 是全零 UUID）`,
        { path: 'human_confirmation.confirmed_by_actor_id' },
      )
    }
  }
  return {
    application_id: raw.application_id,
    decision_scope: scope,
    result: result as ParsedInput['result'],
    reason,
    human_confirmation: {
      ...(confirmedBy === undefined ? {} : { confirmed_by_actor_id: confirmedBy }),
      confirmed_at: confirmedAt,
      method: method as ParsedInput['human_confirmation']['method'],
      text,
    },
  }
}

// =====================================================================
//  只读事实（服务端组装 basis 的唯一来源；全部参数化 SQL）
// =====================================================================

/** 申请事实行（组装 basis 的最小集合）。 */
interface ApplicationFactsRow {
  application_id: string
  lifecycle_status: string
  current_stage_code: string
  record_version: number
  job_id: string
  application_rubric_version_id: string | null
  application_resume_version_id: string | null
  rubric_payload_hash: string | null
  rubric_dimensions: unknown
  resume_content_sha256: string | null
  hiring_manager_actor_id: string | null
}

const APPLICATION_FACTS_SQL = `
  select a.id::text                        as application_id,
         a.lifecycle_status                as lifecycle_status,
         a.current_stage_code              as current_stage_code,
         a.record_version                  as record_version,
         a.job_id::text                    as job_id,
         a.rubric_version_id::text         as application_rubric_version_id,
         a.resume_version_id::text         as application_resume_version_id,
         rv.payload_hash                   as rubric_payload_hash,
         rv.dimensions                     as rubric_dimensions,
         rvv.content_sha256                as resume_content_sha256,
         d.hiring_manager_actor_id::text   as hiring_manager_actor_id
    from recruitment.application a
    join recruitment.job j
      on j.id = a.job_id and j.tenant_id = a.tenant_id
    left join recruitment.department d
      on d.id = j.department_id and d.tenant_id = j.tenant_id
    left join recruitment.rubric_version rv
      on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id and rv.job_id = a.job_id
    left join recruitment.resume_version rvv
      on rvv.id = a.resume_version_id and rvv.tenant_id = a.tenant_id
   where a.tenant_id = $1::uuid
     and a.id = $2::uuid
`

/** 决策人（HUMAN 校验）。 */
const ACTOR_KIND_SQL = `
  select a.kind as kind
    from recruitment.actor a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/** 申请的有效面试（STAGE 唯一推导用）。 */
interface InterviewRow {
  id: string
  round_no: number | null
  status: string
}

const INTERVIEWS_SQL = `
  select i.id::text     as id,
         i.round_no     as round_no,
         i.status       as status
    from recruitment.interview i
   where i.tenant_id = $1::uuid
     and i.application_id = $2::uuid
   order by i.created_at asc, i.id asc
`

/** 面评行（SCORECARD 依据的来源；与 decision-read.ts 同口径）。 */
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
 * 面试 → 转写状态（SCORECARD 依据的 `transcript_state`）。
 *
 * **复用** `decision-read.ts` 的同一关系口径（2026-11-15 真 Host 500 修复的那份）：
 * `transcript_artifact` 没有 `interview_id` 列；真实关系是
 *   `interview_record.interview_id → transcript_artifact_id`
 * 与 `meeting_binding.interview_id → meeting_id → transcript_artifact.meeting_id`。
 * 两条都没有 = `MISSING`（不编造 READY）。
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

/** 从 rubric dimensions（jsonb）取维度 key 列表（与 evaluation-summarize 的 shape 校验同口径）。 */
function rubricDimensionKeys(dimensions: unknown): string[] {
  if (!Array.isArray(dimensions)) return []
  const keys: string[] = []
  for (const entry of dimensions) {
    if (typeof entry !== 'object' || entry === null) continue
    const key = (entry as Record<string, unknown>).key
    if (typeof key === 'string' && key !== '') keys.push(key)
  }
  return keys
}

/** 由库里的面评行组装 SCORECARD 依据（与 decision-read.ts::loadRecordScorecardRefs 同口径）。 */
async function loadScorecardRefs(
  client: DatabaseClient,
  tenantId: string,
  facts: ApplicationFactsRow,
  scope: 'STAGE' | 'FINAL',
  interviewId: string | null,
): Promise<Array<Record<string, unknown>>> {
  const rows = scope === 'STAGE'
    ? (await client.query<ScorecardFactsRow>(STAGE_SCORECARDS_SQL, [tenantId, interviewId])).rows
    : (await client.query<ScorecardFactsRow>(FINAL_SCORECARDS_SQL, [tenantId, facts.application_id])).rows
  if (rows.length === 0) return []
  const dimensionKeys = rubricDimensionKeys(facts.rubric_dimensions)
  const states = new Map<string, string>()
  const interviewIds = [...new Set(rows.map((row) => row.interview_id))]
  const stateRows = await client.query<{ interview_id: string; status: string }>(
    TRANSCRIPT_STATE_SQL,
    [tenantId, interviewIds],
  )
  for (const row of stateRows.rows) {
    if (!states.has(row.interview_id)) states.set(row.interview_id, row.status)
  }
  const refs: Array<Record<string, unknown>> = []
  for (const row of rows) {
    if (facts.application_rubric_version_id === null
      || row.rubric_version_id !== facts.application_rubric_version_id) {
      continue
    }
    const items = parseJsonb(row.items)
    const overall = nonEmptyString(row.overall) ? row.overall : null
    const transcriptBasis = isPlainObject(items) && nonEmptyString(items.transcript_basis)
      ? items.transcript_basis
      : null
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
      ...(typeof row.payload_hash === 'string' && HEX64_RE.test(row.payload_hash)
        ? { payload_hash: row.payload_hash }
        : {}),
    })
  }
  return refs
}

/** jsonb 列可能是对象（pg 解析）或字符串（旧数据）；两种都收。 */
function parseJsonb(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

// =====================================================================
//  写后独立读回
// =====================================================================

/** decision 行（读回用；字段与库列一致）。 */
interface DecisionReadbackRow {
  decision_id: string
  application_id: string
  interview_id: string | null
  decision_scope: string
  stage_code: string | null
  result: string
  decided_by_actor_id: string
  decided_at: string | Date
  record_version: number
  superseded_by_decision_id: string | null
  reason: string
  basis_refs: unknown
}

const DECISION_READBACK_SQL = `
  select d.id::text                      as decision_id,
         d.application_id::text          as application_id,
         d.interview_id::text            as interview_id,
         d.decision_scope                as decision_scope,
         d.stage_code                    as stage_code,
         d.result                        as result,
         d.decided_by_actor_id::text     as decided_by_actor_id,
         d.decided_at                    as decided_at,
         d.record_version                as record_version,
         d.superseded_by_decision_id::text as superseded_by_decision_id,
         d.reason                        as reason,
         d.basis_refs                    as basis_refs
    from recruitment.decision d
   where d.tenant_id = $1::uuid
     and d.id = $2::uuid
`

/** `decision.record` 事件行（确认元数据读回用）。 */
interface DecisionEventRow {
  event_id: string
  event_type: string
  occurred_at: string | Date | null
  payload: unknown
}

/** 申请行（写后独立读回：阶段派生 + REJECT 收口到底有没有真的落库）。 */
interface ApplicationStageRow {
  current_stage_code: string
  lifecycle_status: string
  record_version: number
}

const APPLICATION_STAGE_SQL = `
  select a.current_stage_code::text as current_stage_code,
         a.lifecycle_status::text    as lifecycle_status,
         a.record_version            as record_version
    from recruitment.application a
   where a.tenant_id = $1::uuid
     and a.id = $2::uuid
`

const DECISION_EVENT_SQL = `
  select e.event_id::text   as event_id,
         e.event_type       as event_type,
         e.occurred_at      as occurred_at,
         e.payload          as payload
    from recruitment.event_inbox e
   where e.tenant_id = $1::uuid
     and e.event_type = '${EVENT_TYPES.DECISION_RECORD}'
     and e.source_object_id = $2::text
   order by e.recorded_at desc, e.event_id desc
   limit 1
`

/** 从事件 payload 取确认元数据（确认四个字段；缺失就是缺失，不补）。 */
function confirmationFromEventPayload(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) return {}
  const pick = (key: string): string | undefined => (typeof payload[key] === 'string' ? payload[key] : undefined)
  const out: Record<string, unknown> = {}
  const method = pick('confirmation_method') ?? pick('human_confirmation_method')
  const sha = pick('confirmation_text_sha256') ?? pick('human_confirmation_text_sha256')
  const confirmedAt = pick('confirmed_at') ?? pick('human_confirmation_confirmed_at')
  const confirmedBy = pick('confirmed_by_actor_id') ?? pick('human_confirmation_confirmed_by_actor_id')
  if (method !== undefined) out.method = method
  if (sha !== undefined) out.text_sha256 = sha
  if (confirmedAt !== undefined) out.confirmed_at = confirmedAt
  if (confirmedBy !== undefined) out.confirmed_by_actor_id = confirmedBy
  return out
}

/** 把 ISO/Date 统一成字符串（读回输出用；不猜）。 */
function toIso(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/** 数 basis_refs 各 kind（读回输出用；不解释领域含义）。 */
function countBasisKinds(basis: unknown): Record<string, number> {
  const counts: Record<string, number> = {}
  if (!Array.isArray(basis)) return counts
  for (const ref of basis) {
    if (typeof ref !== 'object' || ref === null) continue
    const kind = (ref as Record<string, unknown>).kind
    if (typeof kind !== 'string') continue
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

// =====================================================================
//  出参 schema（DSH 校验器支持的子集；null 一律省略）
// =====================================================================

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    replayed: { type: 'boolean' },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    decision: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        application_id: { type: 'string' },
        interview_id: { type: 'string' },
        decision_scope: { type: 'string', enum: ['SCREENING', 'STAGE', 'FINAL'] },
        stage_code: { type: 'string' },
        result: { type: 'string', enum: [...RESULTS] },
        decided_by_actor_id: { type: 'string' },
        decided_at: { type: 'string' },
        record_version: { type: 'integer' },
        superseded_by_decision_id: { type: 'string' },
      },
      required: ['id', 'application_id', 'decision_scope', 'stage_code', 'result', 'decided_by_actor_id', 'decided_at', 'record_version'],
      additionalProperties: false,
    },
    human_confirmation: {
      type: 'object',
      properties: {
        confirmed_by_actor_id: { type: 'string' },
        confirmed_at: { type: 'string' },
        method: { type: 'string', enum: [...CONFIRMATION_METHODS] },
        text_sha256: { type: 'string' },
        preimage_version: { type: 'integer' },
        persisted_in: { type: 'string' },
      },
      required: ['confirmed_by_actor_id', 'confirmed_at', 'method', 'text_sha256', 'preimage_version', 'persisted_in'],
      additionalProperties: false,
    },
    stage: {
      type: 'object',
      properties: {
        before: { type: 'string', description: '决策写库前的申请阶段码' },
        after: { type: 'string', description: '写事务提交后独立读回的申请阶段码' },
        advanced: { type: 'boolean', description: '本次决策是否同事务推进了阶段（D-141③：SCREENING ADVANCE/REJECT 派生 S6→S7）' },
        record_version: { type: 'integer', description: '写后读回的 application.record_version' },
        lifecycle_before: { type: 'string', description: '决策写库前的申请生命周期' },
        lifecycle_after: {
          type: 'string',
          description: '写后读回的生命周期；SCREENING REJECT 会把 ACTIVE 收口为 CLOSED（2026-11-16 lead 裁定）',
        },
      },
      required: ['before', 'after', 'advanced', 'record_version', 'lifecycle_before', 'lifecycle_after'],
      additionalProperties: false,
    },
    basis: {
      type: 'object',
      properties: {
        kinds: { type: 'object' },
        rubric_version_id: { type: 'string' },
        rubric_payload_hash: { type: 'string' },
        authority_actor_id: { type: 'string' },
        is_hiring_manager: { type: 'boolean' },
        summary_digest: { type: 'string' },
        screening_evaluation_digest: { type: 'string' },
        as_of: { type: 'string' },
        scorecard_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['kinds', 'rubric_version_id', 'rubric_payload_hash', 'authority_actor_id', 'is_hiring_manager'],
      additionalProperties: false,
    },
    event: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        event_type: { type: 'string' },
        confirmation: {
          type: 'object',
          properties: {
            method: { type: 'string' },
            text_sha256: { type: 'string' },
            confirmed_at: { type: 'string' },
            confirmed_by_actor_id: { type: 'string' },
          },
          required: ['method', 'text_sha256'],
          additionalProperties: false,
        },
      },
      required: ['event_id', 'event_type', 'confirmation'],
      additionalProperties: false,
    },
    approval: {
      type: 'object',
      properties: {
        requested: { type: 'integer' },
        result: { type: 'string' },
      },
      required: ['requested', 'result'],
      additionalProperties: false,
    },
    readback: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        source: { type: 'string' },
        verified: { type: 'boolean' },
      },
      required: ['table', 'source', 'verified'],
      additionalProperties: false,
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' } },
        required: ['code', 'message'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'tool', 'contract_version', 'status', 'replayed', 'labels', 'decision',
    'human_confirmation', 'basis', 'event', 'approval', 'readback', 'warnings',
  ],
  additionalProperties: false,
}

/** 模型可见的渲染（只讲业务事实，不讲内部 hash 细节）。 */
function renderRecordHumanDecision(value: unknown): readonly TextBlock[] {
  const v = value as Record<string, unknown>
  const decision = (v.decision ?? {}) as Record<string, unknown>
  const confirmation = (v.human_confirmation ?? {}) as Record<string, unknown>
  const basis = (v.basis ?? {}) as Record<string, unknown>
  const warnings = Array.isArray(v.warnings) ? (v.warnings as Record<string, unknown>[]) : []
  // O1 残留修复：人读正文只给**业务事实**（范围 / 结果 / 阶段 / 记录版本 / 时间 / 确认方式）
  // 与**短号**（决策 / 决策人 / 评分标准版本），摘要类 hash 只给前 8 位。`basis_refs` 是内部
  // 字段名 → 正文改说「依据」；event id 是内部编号、也不是任何工具的入参 → 正文完全不提。
  // 只有 decision id 是下游入参（`recruitment_decision_record` 的 `supersedes.decision_id`，
  // 撤回/重开时用），且模型只能从本工具发现 → 完整值只放在末尾 machine arguments 区。
  const text = (input: unknown): string => (typeof input === 'string' ? input : '')
  const decisionId = text(decision.id)
  const textSha = text(confirmation.text_sha256)
  const rubricHash = shortHash(text(basis.rubric_payload_hash))
  const kinds = isPlainObject(basis.kinds) ? basis.kinds : {}
  // D-141③：阶段是这次决策的**业务结果**（人决定初筛 ⇒ S6→S7），必须在模型读到的那段文字里
  // 出现一次，否则模型会照旧补一次 `stage_advance`（多余步骤 + 多余失败点，正是 D-141 要消灭的）。
  // sparse 合成值/旧输出可能没有 `stage` 键：缺就整行省略（不猜、不打印 undefined）。
  const stage = isPlainObject(v.stage) ? v.stage : undefined
  const stageLine = stage === undefined
    ? undefined
    : `阶段：${text(stage.before)} → ${text(stage.after)}`
      + `${stage.advanced === true ? '（本次决策同事务推进）' : '（无变化）'}`
      + ` · 申请记录版本 ${String(stage.record_version)}`
  // 2026-11-16 lead 收窄裁定：REJECT 把 ACTIVE 收口为 CLOSED —— 必须让模型读到"这条申请已结束"，
  // 否则它会把已拒绝的申请继续当在办（例如接着安排面试）。
  const lifecycleBefore = stage === undefined ? '' : text(stage.lifecycle_before)
  const lifecycleAfter = stage === undefined ? '' : text(stage.lifecycle_after)
  const lifecycleLine = stage === undefined || lifecycleBefore === lifecycleAfter
    ? undefined
    : `生命周期：${lifecycleBefore} → ${lifecycleAfter}（初筛拒绝：这条申请已结束，不再推进）`
  // `kinds` 是「依据种类 → 条数」的计数表；只念数字计数，别的值一概不回显 ——
  // 这个键在 schema 里是自由对象（`type: object`），逐字回显等于把未知内部值念给 HR。
  const kindText = Object.entries(kinds)
    .filter(([, count]) => typeof count === 'number')
    .map(([kind, count]) => `${kind}×${String(count)}`)
    .join(' · ')
  const lines = [
    `${String(v.tool)} ${String(v.contract_version)} status=${String(v.status)}（决策已落库，写后独立读回一致）`,
    `决策：${String(decision.decision_scope)} ${String(decision.result)} `
      + `· 阶段 ${String(decision.stage_code)} · 记录版本 ${String(decision.record_version)} `
      + `· 决策 ${shortRef(decisionId)} · 决策人 ${shortRef(text(decision.decided_by_actor_id))} `
      + `· 决策时间 ${String(decision.decided_at)}`,
    ...(stageLine === undefined ? [] : [stageLine]),
    ...(lifecycleLine === undefined ? [] : [lifecycleLine]),
    `人已确认：${shortRef(text(confirmation.confirmed_by_actor_id))} `
      + `于 ${String(confirmation.confirmed_at)} 以 ${String(confirmation.method)} 方式确认 `
      + `· 确认原话摘要=${textSha === '' ? '（缺失）' : shortHash(textSha)} `
      + `（pre-image v${String(confirmation.preimage_version)}）`,
    `依据：${kindText === '' ? '（无）' : kindText} `
      + `· 评分标准版本 ${shortRef(text(basis.rubric_version_id))}`
      + `${rubricHash === '' ? '' : `（摘要 ${rubricHash}）`} `
      + `· 是招聘负责人=${String(basis.is_hiring_manager)}`,
  ]
  for (const warning of warnings) {
    lines.push(`warning ${String(warning.code)}: ${String(warning.message)}`)
  }
  // 机器参数区：撤回/重开同一申请的下一条决策时，`recruitment_decision_record` 的
  // `supersedes.decision_id` 必须是**这一行**的完整 id，而模型只能从本工具发现它
  // （business_read 只给决策条数 / 最新结论，不给 id）。完整值只允许出现在这里。
  lines.push(...machineArgumentLines([{ key: 'supersedes.decision_id', value: decisionId }]))
  return [{ type: 'text', text: lines.join('\n') }]
}

// =====================================================================
//  组装：把"人拍板"翻译成领域入参（服务端事实 + 服务端 hash）
// =====================================================================

/** 只读阶段算出来的组装事实。 */
interface AssembledArgs {
  readonly rawArgs: Record<string, unknown>
  readonly summary_digest?: string
  readonly screening_evaluation_digest?: string
  readonly as_of: string
  /** 写之前的申请阶段码（D-141③ 的 stage 回显："决策前 → 决策后"）。 */
  readonly current_stage_code: string
  /** 写之前的生命周期（D-141③ REJECT 收口："ACTIVE → CLOSED" 的回显）。 */
  readonly lifecycle_status: string
  readonly rubric_version_id: string
  readonly rubric_payload_hash: string
  readonly authority_actor_id: string
  readonly is_hiring_manager: boolean
  readonly scorecard_ids: readonly string[]
  readonly interview_id?: string
  /** 服务端算出的确认 pre-image 版本（v2 = 有原话，D-95）。 */
  readonly preimage_version: number
}

/**
 * 在**只读事务**里读事实并组装 `recruitment_decision_record` 的入参。
 *
 * 这里只做"把事实翻译成依据"，不做任何决策判断；判断全在领域 STEP 0→7。
 * @param client - 只读事务内客户端（GUC actor 已设）。
 * @param cfg - 数据库配置（租户/actor 来自这里）。
 * @param input - 已校验的高层入参。
 * @param actorId - 执行上下文解析出的 actor（写库作者 + AUTHORITY 主体）。
 * @param nowMs - 服务端当前毫秒。
 * @returns 领域入参 + 组装事实（供出参回显）。
 */
async function assembleDecisionArgs(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  input: ParsedInput,
  actorId: string,
  nowMs: number,
): Promise<AssembledArgs> {
  const tenantId = cfg.tenant_id
  const asOf = new Date(nowMs).toISOString()

  // ---- 申请事实 ----
  const appResult = await client.query<ApplicationFactsRow>(APPLICATION_FACTS_SQL, [tenantId, input.application_id])
  const app = appResult.rows[0]
  if (app === undefined) {
    throw toolError('NOT_FOUND', REASON.APPLICATION_NOT_FOUND, '该租户下没有这个申请', {
      application_id: input.application_id,
    })
  }

  // ---- 决策人（HUMAN；DC-10）----
  const actorRow = (await client.query<{ kind: string }>(ACTOR_KIND_SQL, [actorId, tenantId])).rows[0]
  if (actorRow === undefined) {
    throw toolError('FORBIDDEN', REASON.ACTOR_NOT_HUMAN, '执行上下文的 actor 在该租户下不存在，拒绝写入', {
      actor_id: actorId,
    })
  }
  if (actorRow.kind !== 'HUMAN') {
    throw toolError('FORBIDDEN', REASON.ACTOR_NOT_HUMAN, '决策只能由人做出：执行上下文 actor 的 kind 不是 HUMAN（DC-10）', {
      actor_id: actorId,
      actor_kind: actorRow.kind,
    })
  }

  // ---- 阶段闸门（方向性守卫；S10 的权威闸门在领域里，这里提前给出同一 reason_code）----
  if (input.decision_scope === 'SCREENING') {
    if (app.current_stage_code !== 'S6' && app.current_stage_code !== 'S7') {
      throw toolError(
        'INVALID_ARGS',
        REASON.STAGE_NOT_SCREENING_STAGE,
        'SCREENING 决策只能在申请处于 S6/S7（初筛阶段）时记录；S10 再补记初筛属于脏数据',
        {
          application_id: app.application_id,
          current_stage_code: app.current_stage_code,
          allowed_stage_codes: ['S6', 'S7'],
          decision_scope: input.decision_scope,
        },
      )
    }
  } else if (app.current_stage_code !== 'S10') {
    throw toolError(
      'INVALID_ARGS',
      'STAGE_NOT_S10',
      '申请当前阶段不是 S10，不能落 STAGE/FINAL 决策（先推进阶段，DC-07）',
      {
        application_id: app.application_id,
        current_stage_code: app.current_stage_code,
        required_stage_code: 'S10',
        decision_scope: input.decision_scope,
        lifecycle_status: app.lifecycle_status,
      },
    )
  }

  // ---- rubric（申请钉住的那一版；没有就没法证明"按哪版标准决定"）----
  if (app.application_rubric_version_id === null
    || app.rubric_payload_hash === null
    || !HEX64_RE.test(app.rubric_payload_hash)) {
    throw toolError('NO_RUBRIC', REASON.NO_RUBRIC, '申请没有钉住可用的 Rubric 版本（payload_hash 不可用）', {
      application_id: app.application_id,
      rubric_version_id: app.application_rubric_version_id,
    })
  }
  const rubricVersionId = app.application_rubric_version_id
  const rubricPayloadHash = app.rubric_payload_hash
  const isHiringManager = app.hiring_manager_actor_id !== null
    && app.hiring_manager_actor_id.toLowerCase() === actorId.toLowerCase()

  // ---- basis：两种 scope 的必带项不同（S7 = RUBRIC/AUTHORITY [+评估]；S10 = SUMMARY/RUBRIC/AUTHORITY/SCORECARD）----
  const basis: Array<Record<string, unknown>> = []
  let summaryDigest: string | undefined
  let evaluationDigest: string | undefined
  let scorecardIds: string[] = []
  let interviewId: string | undefined
  let decisionAsOf = asOf

  if (input.decision_scope === 'SCREENING') {
    basis.push({ kind: 'RUBRIC_VERSION', id: rubricVersionId, payload_hash: rubricPayloadHash })
    basis.push({ kind: 'AUTHORITY', actor_id: actorId, is_hiring_manager: isHiringManager })
    if (app.application_resume_version_id !== null && app.resume_content_sha256 !== null) {
      basis.push({
        kind: 'RESUME_VERSION',
        id: app.application_resume_version_id,
        content_sha256: app.resume_content_sha256,
      })
    }
    // ADVANCE / REJECT 必须有"那次初筛评估"做依据（§17.1）。服务端**重跑一次只读评估**
    // （唯一实现在 screening-evaluate.ts，不在这里复制规则），再把评估摘要写进 basis。
    if (input.result === 'ADVANCE' || input.result === 'REJECT') {
      let evaluation: Record<string, unknown>
      try {
        evaluation = await evaluateInTransaction(client, cfg, {
          application_id: app.application_id,
          as_of: asOf,
        }, nowMs) as unknown as Record<string, unknown>
      } catch (error) {
        throw toolError(
          'INVALID_ARGS',
          REASON.MISSING_SCREENING_EVALUATION,
          'S7 的 ADVANCE/REJECT 需要一次可用的初筛评估；服务端重算失败（不拿客户端 digest 顶替）',
          { cause: describeError(error) },
        )
      }
      const snapshot = isPlainObject(evaluation.snapshot) ? evaluation.snapshot : {}
      const digest = typeof evaluation.evaluation_digest === 'string' ? evaluation.evaluation_digest : ''
      if (!HEX64_RE.test(digest)
        || !isUuid(snapshot.rubric_version_id)
        || typeof snapshot.rubric_payload_hash !== 'string'
        || !HEX64_RE.test(snapshot.rubric_payload_hash)
        || !isUuid(snapshot.resume_version_id)
        || typeof snapshot.resume_content_sha256 !== 'string'
        || !HEX64_RE.test(snapshot.resume_content_sha256)) {
        throw toolError(
          'INVALID_ARGS',
          REASON.MISSING_SCREENING_EVALUATION,
          '初筛评估输出缺少可绑定的 digest / rubric / 材料事实，拒绝拼一个假依据',
          { evaluation_keys: Object.keys(evaluation).sort() },
        )
      }
      const labels = isPlainObject(evaluation.labels) ? evaluation.labels : {}
      basis.push({
        kind: 'SCREENING_EVALUATION',
        evaluation_digest: digest,
        verdict: typeof evaluation.verdict === 'string' ? evaluation.verdict : 'NEEDS_REVIEW',
        rubric_version_id: snapshot.rubric_version_id,
        rubric_payload_hash: snapshot.rubric_payload_hash,
        resume_version_id: snapshot.resume_version_id,
        resume_content_sha256: snapshot.resume_content_sha256,
        ...(typeof evaluation.contract_version === 'string'
          ? { contract_version: evaluation.contract_version }
          : {}),
        ...(typeof evaluation.criteria_evaluated === 'boolean'
          ? { criteria_evaluated: evaluation.criteria_evaluated }
          : {}),
        ...(typeof labels.provenance === 'string' ? { provenance: labels.provenance } : {}),
      })
      evaluationDigest = digest
    }
  } else {
    // ---- STAGE 需要唯一一场面试；多场 = 不猜（零写入）----
    if (input.decision_scope === 'STAGE') {
      const interviews = (await client.query<InterviewRow>(INTERVIEWS_SQL, [tenantId, app.application_id])).rows
      if (interviews.length === 0) {
        throw toolError(
          'INVALID_ARGS',
          REASON.STAGE_REQUIRES_INTERVIEW,
          'STAGE 决策必须对应一场面试，但该申请没有面试',
          { application_id: app.application_id },
        )
      }
      if (interviews.length > 1) {
        throw toolError(
          'INVALID_ARGS',
          REASON.STAGE_INTERVIEW_AMBIGUOUS,
          '该申请有多场面试；高层动作不猜轮次——请先向人确认是哪一场（或改用 recruitment_decision_record）',
          {
            application_id: app.application_id,
            interview_ids: interviews.map((row) => row.id),
            hint: 'high-level tool intentionally accepts no interview_id',
          },
        )
      }
      interviewId = interviews[0]?.id
      if (interviewId === undefined) {
        throw toolError('INVALID_ARGS', REASON.STAGE_REQUIRES_INTERVIEW, 'STAGE 面试推导失败', {
          application_id: app.application_id,
        })
      }
    }

    // ---- S10 汇总：服务端重算（唯一实现 evaluation-summarize.ts），不接受客户端 digest ----
    let summary: Record<string, unknown>
    try {
      summary = await computeEvaluationSummaryIn(client, cfg, {
        application_id: app.application_id,
        decision_scope: input.decision_scope,
        ...(interviewId === undefined ? {} : { interview_id: interviewId }),
        as_of: asOf,
      }, nowMs) as unknown as Record<string, unknown>
    } catch (error) {
      throw toolError(
        'INVALID_ARGS',
        REASON.MISSING_SUMMARY,
        'S10 汇总不可用（服务端无法从事实得到 summary_digest；不猜、不接受客户端 hash）',
        { cause: describeError(error) },
      )
    }
    const digest = typeof summary.summary_digest === 'string' ? summary.summary_digest : ''
    if (!HEX64_RE.test(digest)) {
      throw toolError('INVALID_ARGS', REASON.MISSING_SUMMARY, '汇总没有返回可用的 summary_digest', {
        summary_keys: Object.keys(summary).sort(),
      })
    }
    summaryDigest = digest
    const summaryAsOf = typeof summary.as_of === 'string' && summary.as_of !== '' ? summary.as_of : asOf
    decisionAsOf = summaryAsOf
    const scorecards = await loadScorecardRefs(client, tenantId, app, input.decision_scope, interviewId ?? null)
    for (const scorecard of scorecards) {
      basis.push({ kind: 'SCORECARD', ...scorecard })
      scorecardIds.push(String(scorecard.id))
    }
    basis.unshift({ kind: 'SUMMARY', summary_digest: digest })
    basis.push({ kind: 'RUBRIC_VERSION', id: rubricVersionId, payload_hash: rubricPayloadHash })
    basis.push({ kind: 'AUTHORITY', actor_id: actorId, is_hiring_manager: isHiringManager })
  }

  // ---- 领域入参（**先 parse 归一化，再算确认 hash**；与 UI facade 同顺序）----
  const rawArgs: Record<string, unknown> = {
    application_id: app.application_id,
    decision_scope: input.decision_scope,
    as_of: decisionAsOf,
    result: input.result,
    reason: input.reason,
    basis_refs: basis,
    ...(summaryDigest === undefined ? {} : { summary_digest: summaryDigest }),
    ...(interviewId === undefined ? {} : { interview_id: interviewId }),
  }
  // STEP 0 先跑一次：归一化后的字段才是被哈希的内容（顺序陷阱：先校验后算 hash）。
  const parsed = parseDecisionArgs(rawArgs, nowMs)
  const textSha = confirmationTextSha256({
    result: parsed.result,
    reason: parsed.reason,
    override_rationale: parsed.override_rationale ?? null,
    basis_refs: parsed.basis_refs,
    confirmation_text: input.human_confirmation.text,
    confirmed_by_actor_id: input.human_confirmation.confirmed_by_actor_id ?? actorId,
    confirmed_at: input.human_confirmation.confirmed_at,
  })
  rawArgs.human_confirmation = {
    confirmed_by_actor_id: input.human_confirmation.confirmed_by_actor_id ?? actorId,
    confirmed_at: input.human_confirmation.confirmed_at,
    confirmation_method: input.human_confirmation.method,
    confirmation_text: input.human_confirmation.text,
    confirmation_text_sha256: textSha,
  }
  return {
    rawArgs,
    ...(summaryDigest === undefined ? {} : { summary_digest: summaryDigest }),
    ...(evaluationDigest === undefined ? {} : { screening_evaluation_digest: evaluationDigest }),
    as_of: decisionAsOf,
    current_stage_code: app.current_stage_code,
    lifecycle_status: app.lifecycle_status,
    rubric_version_id: rubricVersionId,
    rubric_payload_hash: rubricPayloadHash,
    authority_actor_id: actorId,
    is_hiring_manager: isHiringManager,
    scorecard_ids: scorecardIds,
    ...(interviewId === undefined ? {} : { interview_id: interviewId }),
    preimage_version: 2,
  }
}

/** 把任意错误压成可读摘要（进 detail，不暴露栈/凭据）。 */
function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message.slice(0, 500) }
  }
  return { message: String(error).slice(0, 500) }
}

/** 只读事务里读事实（先把 GUC actor 设好，与 facade 同口径）。 */
async function readOnlyAssemble(
  pool: DatabasePool,
  cfg: ResolvedDatabaseConfig,
  input: ParsedInput,
  actorId: string,
  nowMs: number,
): Promise<AssembledArgs> {
  return await withReadOnly(pool, async (client) => {
    await client.query("select set_config('recruitment.actor_id', $1, true)", [actorId])
    return await assembleDecisionArgs(client, cfg, input, actorId, nowMs)
  })
}

/** 写库（高层入参已组装成领域入参；仍然走低层领域的 STEP 0→7）。 */
async function writeDecision(
  pool: DatabasePool,
  deps: RecordHumanDecisionDeps,
  assembled: AssembledArgs,
  actorId: string,
  approve: () => Promise<string>,
): Promise<Record<string, unknown>> {
  return await withActor(pool, actorId, async (client) => {
    const nowMs = deps.now?.() ?? Date.now()
    const value = await recordDecisionInTransaction(
      client,
      deps.database,
      assembled.rawArgs,
      nowMs,
      approve as never,
    )
    return value
  })
}

/** 写后独立读回（另开连接；不在写事务里）。 */
async function readbackAfterCommit(
  database: ResolvedDatabaseConfig,
  decisionId: string,
): Promise<{ decision: DecisionReadbackRow; event: DecisionEventRow | undefined; stage: ApplicationStageRow }> {
  const pool = createPool(database)
  try {
    return await withReadOnly(pool, async (client) => {
      const decisionRows = await client.query<DecisionReadbackRow>(DECISION_READBACK_SQL, [
        database.tenant_id,
        decisionId,
      ])
      const decision = decisionRows.rows[0]
      if (decision === undefined) {
        throw toolError('INVALID_ARGS', REASON.READBACK_MISSING, '决策写事务已提交但读回不到该行', {
          decision_id: decisionId,
        })
      }
      const eventRows = await client.query<DecisionEventRow>(DECISION_EVENT_SQL, [
        database.tenant_id,
        decisionId,
      ])
      // D-141③：阶段派生是同一事务的一部分，**只认**独立连接读回的 application 行（不拿出参自述）。
      const stageRows = await client.query<ApplicationStageRow>(APPLICATION_STAGE_SQL, [
        database.tenant_id,
        decision.application_id,
      ])
      const stage = stageRows.rows[0]
      if (stage === undefined) {
        throw toolError('INVALID_ARGS', REASON.READBACK_MISSING, '决策写事务已提交但读回不到对应申请行', {
          decision_id: decisionId,
          application_id: decision.application_id,
        })
      }
      return { decision, event: eventRows.rows[0], stage }
    })
  } finally {
    await closePool(pool)
  }
}

// =====================================================================
//  工具定义
// =====================================================================

/** 从执行上下文里取 `agent` / `signal`（供 approval 透传）。 */
function readExecContext(exec: unknown): { agent?: unknown; signal?: AbortSignal } | undefined {
  if (!isPlainObject(exec)) return undefined
  const agent = exec.agent
  const signal = exec.signal
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(signal instanceof AbortSignal ? { signal } : {}),
  }
}

/**
 * 造一个绑定配置的高层「记录人类决策」工具。
 * @param deps - 数据库配置 + approval 窄接口 + Demo Actor 身份（与低层决策工具同形）。
 */
export function createRecordHumanDecisionTool(deps: RecordHumanDecisionDeps): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Record a decision a HUMAN already made — the high-level business action (same level as the workbench UI). '
      + 'Caller supplies ONLY business facts: application_id, decision_scope (SCREENING / STAGE / FINAL), result '
      + '(ADVANCE / HOLD / REJECT / WITHDRAW), reason, and human_confirmation {confirmed_at, method: IN_CHAT | '
      + 'IN_APP_CONFIRM, text: the human\'s verbatim words}. The server assembles every derived field itself: '
      + 'basis_refs (SUMMARY / RUBRIC_VERSION / AUTHORITY / SCORECARD / SCREENING_EVALUATION / RESUME_VERSION), '
      + 'AUTHORITY.is_hiring_manager, the re-computed summary digest, and the confirmation pre-image sha256 '
      + '(v2, D-95). Callers MUST NOT pass basis_refs / summary_digest / confirmation_text_sha256 / interview_id / '
      + 'actor_id — such keys are rejected (zero write). The decision is still validated and written by the '
      + 'authoritative decision-record domain (same STEP 0→7 gates: S10 stage gate, SC-11 rubric binding, DC-08..11 '
      + 'human confirmation, D-79 approval for non-IN_CHAT methods). For decision_scope=SCREENING the domain ALSO derives '
      + 'the S6→S7 stage move in the SAME transaction (D-141; only T1 — material linked, not FAILED, rubric pinned — is '
      + 'derived, so T2–T4 gates stay untouched; idempotent when already S7). A SCREENING REJECT additionally closes the '
      + 'application lifecycle ACTIVE→CLOSED in the same transaction (existing CLOSED value / existing lifecycle event; '
      + 'no new value, no new event type) — the output `stage.lifecycle_before/after` is read back independently after '
      + 'COMMIT. Do NOT call stage_advance afterwards for a '
      + 'screening decision: the output `stage` block is read back independently after COMMIT and already reflects it. '
      + 'After COMMIT the tool re-reads the decision row '
      + 'and its decision.record event on a separate connection and returns only what the DB says. Fail-closed: any '
      + 'gate failure writes nothing.',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => renderRecordHumanDecision(value) },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // ---- 1) 入参形状（不碰库；服务端派生键在这里就被拒绝）----
      const input = parseInput(rawArgs)
      // ---- 2) 写身份（先于建连；identity 装配后解析失败 → DEMO_ACTOR_UNMAPPED，零写入）----
      const writeActor = resolveWriteActor(exec, deps.identity, deps.database.actor_id)
      const actorId = writeActor.actor_id
      const nowMs = deps.now?.() ?? Date.now()

      // ---- 3) 确认人 / 确认时间（服务端可判的 fail-closed 前置）----
      const confirmedBy = input.human_confirmation.confirmed_by_actor_id ?? actorId
      if (confirmedBy.toLowerCase() !== actorId.toLowerCase()) {
        throw toolError(
          'DECISION_REQUIRES_HUMAN',
          REASON.CONFIRMATION_SUBJECT_MISMATCH,
          '确认人必须就是执行上下文的 actor（不能替别人确认，DC-09）',
          { confirmed_by_actor_id: confirmedBy, actor_id: actorId },
        )
      }
      const confirmedAtMs = Date.parse(input.human_confirmation.confirmed_at)
      if (!Number.isFinite(confirmedAtMs)) {
        throw toolError('INVALID_ARGS', REASON.CONFIRMATION_TIME_INVALID, 'confirmed_at 不是可解析的时间', {
          confirmed_at: input.human_confirmation.confirmed_at,
        })
      }
      if (confirmedAtMs > nowMs + CONFIRMATION_FUTURE_SKEW_MS) {
        throw toolError('INVALID_ARGS', REASON.CONFIRMATION_TIME_IN_FUTURE, 'confirmed_at 不得晚于服务端当前时间', {
          confirmed_at: input.human_confirmation.confirmed_at,
          now: new Date(nowMs).toISOString(),
        })
      }
      // 说明：确认时间的"≤ decided_at / ≤24h"由领域 `assertHumanDecider` 权威校验。

      // ---- 4) 只读事实 + 服务端组装（零写入；任一闸门失败就抛）----
      const pool = createPool(deps.database)
      try {
        const assembled = await readOnlyAssemble(pool, deps.database, input, actorId, nowMs)
        // ---- 5) 写库（领域 STEP 0→7；approval 只在非 IN_CHAT 时被问到）----
        const context = readExecContext(exec)
        const approve = makeApprovalRequest(deps.approval, context)
        const approvalCalls = { requested: 0 }
        const wrappedApprove = async (): Promise<string> => {
          approvalCalls.requested += 1
          return await approve()
        }
        const written = await writeDecision(pool, deps, assembled, actorId, wrappedApprove)
        const decisionOut = isPlainObject(written.decision) ? written.decision : {}
        const decisionId = typeof decisionOut.id === 'string' ? decisionOut.id : ''
        if (!isUuid(decisionId)) {
          throw toolError('INVALID_ARGS', REASON.READBACK_MISSING, '领域返回里没有可读回的 decision id', {
            decision_keys: Object.keys(decisionOut).sort(),
          })
        }
        // ---- 6) 写后独立连接读回（出参只来自这里）----
        const readback = await readbackAfterCommit(deps.database, decisionId)
        const eventConfirmation = confirmationFromEventPayload(readback.event?.payload)
        const expectedSha = typeof (assembled.rawArgs.human_confirmation as Record<string, unknown>).confirmation_text_sha256 === 'string'
          ? String((assembled.rawArgs.human_confirmation as Record<string, unknown>).confirmation_text_sha256)
          : ''
        const readbackWarnings: Array<{ code: string; message: string }> = []
        const persistedSha = typeof eventConfirmation.text_sha256 === 'string' ? eventConfirmation.text_sha256 : ''
        const persistedMethod = typeof eventConfirmation.method === 'string' ? eventConfirmation.method : ''
        const persistedConfirmedAt = typeof eventConfirmation.confirmed_at === 'string' ? eventConfirmation.confirmed_at : ''
        const persistedConfirmedBy = typeof eventConfirmation.confirmed_by_actor_id === 'string'
          ? eventConfirmation.confirmed_by_actor_id
          : ''
        const eventMetadataComplete = persistedSha !== ''
          && persistedMethod !== ''
          && persistedConfirmedAt !== ''
          && persistedConfirmedBy !== ''
        if (!eventMetadataComplete) {
          // 事件 payload 的确认元数据是否完整是产品审计能力的**事实**；缺了就如实报，不补。
          readbackWarnings.push({
            code: REASON.EVENT_CONFIRMATION_METADATA_MISSING,
            message:
              'decision.record 事件 payload 缺少确认元数据字段（confirmed_at / confirmed_by_actor_id / method / text_sha256）——'
              + '需要 decision-record.ts 的 wiring 补丁（见 work/d5/product-decision/wiring/）；本次写库本身已成功',
          })
        } else {
          if (persistedSha !== expectedSha) {
            throw toolError('INVALID_ARGS', 'EVENT_CONFIRMATION_MISMATCH', '事件里的 confirmation_text_sha256 与服务端算出的不一致', {
              persisted: persistedSha,
              expected: expectedSha,
            })
          }
          if (persistedMethod !== input.human_confirmation.method
            || persistedConfirmedBy.toLowerCase() !== confirmedBy.toLowerCase()
            || persistedConfirmedAt !== input.human_confirmation.confirmed_at) {
            throw toolError('INVALID_ARGS', 'EVENT_CONFIRMATION_MISMATCH', '事件里的确认元数据与人确认的事实不一致', {
              persisted: eventConfirmation,
              expected: {
                method: input.human_confirmation.method,
                confirmed_by_actor_id: confirmedBy,
                confirmed_at: input.human_confirmation.confirmed_at,
              },
            })
          }
        }
        const domainWarnings = Array.isArray(written.warnings) ? written.warnings : []
        const warningList = [
          ...domainWarnings
            .filter((entry): entry is Record<string, unknown> => isPlainObject(entry))
            .map((entry) => ({
              code: typeof entry.code === 'string' ? entry.code : 'UNKNOWN',
              message: typeof entry.message === 'string' ? entry.message : '',
            })),
          ...readbackWarnings,
        ]
        const output: Record<string, unknown> = {
          tool: TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          status: 'OK',
          replayed: written.replayed === true,
          labels: isPlainObject(written.labels) ? written.labels : {},
          decision: {
            id: readback.decision.decision_id,
            application_id: readback.decision.application_id,
            ...(readback.decision.interview_id === null ? {} : { interview_id: readback.decision.interview_id }),
            decision_scope: readback.decision.decision_scope,
            stage_code: readback.decision.stage_code ?? '',
            result: readback.decision.result,
            decided_by_actor_id: readback.decision.decided_by_actor_id,
            decided_at: toIso(readback.decision.decided_at) ?? '',
            record_version: readback.decision.record_version,
            ...(readback.decision.superseded_by_decision_id === null
              ? {}
              : { superseded_by_decision_id: readback.decision.superseded_by_decision_id }),
          },
          human_confirmation: {
            confirmed_by_actor_id: persistedConfirmedBy === '' ? confirmedBy : persistedConfirmedBy,
            confirmed_at: persistedConfirmedAt === '' ? input.human_confirmation.confirmed_at : persistedConfirmedAt,
            method: persistedMethod === '' ? input.human_confirmation.method : persistedMethod,
            text_sha256: persistedSha === '' ? expectedSha : persistedSha,
            preimage_version: assembled.preimage_version,
            persisted_in: 'decision.record event payload (event_inbox)',
          },
          basis: {
            kinds: countBasisKinds(readback.decision.basis_refs),
            rubric_version_id: assembled.rubric_version_id,
            rubric_payload_hash: assembled.rubric_payload_hash,
            authority_actor_id: assembled.authority_actor_id,
            is_hiring_manager: assembled.is_hiring_manager,
            ...(assembled.summary_digest === undefined ? {} : { summary_digest: assembled.summary_digest }),
            ...(assembled.screening_evaluation_digest === undefined
              ? {}
              : { screening_evaluation_digest: assembled.screening_evaluation_digest }),
            as_of: assembled.as_of,
            scorecard_ids: [...assembled.scorecard_ids],
          },
          // D-141③：stage 只来自写后独立读回（before = 写事务之前的申请阶段，来自组装事实的只读快照）。
          stage: {
            before: assembled.current_stage_code,
            after: readback.stage.current_stage_code,
            advanced: assembled.current_stage_code !== readback.stage.current_stage_code,
            record_version: readback.stage.record_version,
            lifecycle_before: assembled.lifecycle_status,
            lifecycle_after: readback.stage.lifecycle_status,
          },
          event: {
            event_id: typeof readback.event?.event_id === 'string' ? readback.event.event_id : '',
            event_type: typeof readback.event?.event_type === 'string' ? readback.event.event_type : '',
            confirmation: {
              ...(persistedMethod === '' ? {} : { method: persistedMethod }),
              ...(persistedSha === '' ? {} : { text_sha256: persistedSha }),
              ...(persistedConfirmedAt === '' ? {} : { confirmed_at: persistedConfirmedAt }),
              ...(persistedConfirmedBy === '' ? {} : { confirmed_by_actor_id: persistedConfirmedBy }),
            },
          },
          approval: {
            requested: approvalCalls.requested,
            result: approvalCalls.requested === 0 ? 'NOT_REQUIRED_IN_CHAT' : 'REQUESTED',
          },
          readback: {
            table: 'decision',
            source: 'independent read-only connection after COMMIT',
            verified: true,
          },
          warnings: warningList,
        }
        // DSH 输出校验器不支持 null：与低层工具同一处置（去掉 null 键后再返回）。
        return stripNulls(output)
      } catch (error) {
        // 领域/库错误：P1-1 的 DEFERRABLE 23P01 在 COMMIT 抛，统一翻译（保留既有错误码）。
        translateWriteError(error)
        return undefined as never
      } finally {
        await closePool(pool)
      }
    },
  }
}

/** 低层领域入参类型导出给测试（只读类型用途；运行时不需要）。 */
export type RecordHumanDecisionArgs = DecisionArgs
