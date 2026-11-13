// recruitment_evaluation_summarize —— S10「汇总投影」（只读、无时钟、确定性）。
//
// 形状与语义逐条照 `contracts/evaluation/tool-contracts.md`（下称 TC）§3、
// `contracts/evaluation/decision-rules.md`（下称 DC）§3.2/§3.3/§4.2/§4.2.1/§6.1/§9、
// `contracts/evaluation/scorecard-rules.md`（下称 SC）§4.4/§4.6/§6，
// 以及 `manual/evaluation-line/DESIGN.md` §3/§3.5/§4。
//
// 负责的条款（可机检的落点）：
//   * TC §3.1 入参：application_id / decision_scope / interview_id / as_of / require_complete；
//     scope 三条（STAGE_REQUIRES_INTERVIEW / FINAL_SCOPE_NO_INTERVIEW / DECISION_SCOPE_NOT_S10）。
//   * TC §3.2 出参硬约束：advisory/read_only 恒 true、黑名单键零出现、
//     M-1（average≠null ⟺ missing=0 ∧ submitted≥1）、M-3（三个桶 + unusable ⊆ missing）。
//   * TC §3.3 字段规则：coverage/missing/tally/consensus/aggregation/record/blockers/
//     permitted_results/required_human_action/snapshot/summary_digest/brief。
//   * TC §3.4 items 形状二次校验（对象、键集、四态、三值、REJECT 理由、ADVANCE 无未评、
//     NO_TRANSCRIPT 不得带 SEGMENT）；不合法 → unusable + SCORECARD_SHAPE_INVALID +
//     SCORECARD_UNUSABLE，且不计入 submitted/tally。
//   * TC §3.5 门禁封闭集与 permitted_results 顺序（ADVANCE, HOLD, WITHDRAW, REJECT）；
//     WITHDRAW/HOLD 不被面评类阻断挡住。
//   * TC §3.6 只读/无时钟/幂等/并发安全；TC §3.7 封闭错误码。
//   * DC §3.3 consensus 公式与 warnings 封闭集；DC-01/02/03/04。
//   * DC §4.2/§4.2.1 门槛矩阵（零提交不放行 ADVANCE；缺面评不挡 HOLD/WITHDRAW；
//     ADVANCE(FINAL)/REJECT 缺面评必挡）。
//   * DC-16 / DC-20：summary_digest 的固定子集（逐键见 summaryDigestOf）。
//   * DC-23 record.state；DC-41..46 next round brief（派生、带 digest、无自由文本）。
//   * SC §6：SC-21..SC-28（分母只含 required_interviewers、缺不是 0 分/反对票/平均、
//     豁免原样回显、as_of 决定 overdue）；SC-46（observer 只进 not_required）。
//
// 已知偏差（与契约字面不一致，按 DESIGN §2/§3.5 的口径执行，必须登记）：
//   1. `as_of` 格式错报 `INVALID_ARGS(TYPE_MISMATCH)`，不是 TC §5.1 里不存在的 AS_OF_FORMAT
//      （DESIGN §2 明写）。
//   2. 入口按 DESIGN §3.5① 读事务里的 `recruitment.actor_id` GUC；取不到报
//      `INVALID_ARGS(ACTOR_REQUIRED)`（TC §5.1 无此取值；DESIGN 要求登记）。
//   3. 多租户/身份/轮次类键（tenant_id/actor_id/interviewer_id/decided_by_actor_id/
//      stage_code/round_no/slot_code/submitted_at/decided_at/status）在 parameters 里
//      声明但一律拒收（TC §1.6、DESIGN §2）。
//   4. `aggregation.average`：M-1 要求 missing=0 ∧ submitted≥1 时非 null。若所有已交
//      面评都没有数值 `score`（例如全 NOT_OBSERVED），逐维度均值为空，此时 average=0
//      以保证 M-1 的 ⇔ 成立；`per_dimension[].values` 为空可识别它不是真实分数。
//   5. `SCORECARD_MISSING` 在 FINAL 下阻断 ADVANCE/REJECT（TC §3.5 写“FINAL 时全部”），
//      但不阻断 HOLD/WITHDRAW（TC §3.5 末注、DC §4.2.1 更严的一侧优先）。
//   6. `NO_REJECTING_SCORECARD` 只在 missing=0 ∧ submitted>0 ∧ tally.reject=0 时出现；
//      missing>0 时由 SCORECARD_MISSING 表达（TC §3.8 的 C1 正例只列一条阻断）。
//      DC-27 的 SCREENING_DECISION 例外形态不在汇总侧实现（由决策工具判定）。
//   7. `record.state` 的取值映射：无 current 行 = ABSENT；status≠READY = NOT_READY；
//      READY 但 verification_status≠VERIFIED = NOT_CITED；两者都满足 = READY。
//   8. `brief.evidence_refs[]` 只给 `{interview_record_id, section_key}`（sections 是
//      object，TC/DC 未定坐标形状）；没有 READY 记录时为空数组。
//   9. 输出额外带 `tool` / `contract_version` / `application_id` / `interview_id` /
//      `labels`：`contract_version` 与 `labels.provenance` 是 decision_record 写
//      `basis_refs[SUMMARY]` 需要的（TC §4.3/§1.3），DC §3.2 的键一个不少。
//
// 只读保证：本文件没有写语句，不 import 写事务封装；`execute()` 走 withReadOnly。
// 输出不含 generated_at/now；唯一时间输入是 as_of（原样回显）。

import { collectArgViolations, toParameterSchema, type ParamMap, type ParamSpec } from './args.ts'
import { canonicalJson, checkAsOf, digestOf } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'

/** 工具名（全局唯一）。 */
const TOOL_NAME = 'recruitment_evaluation_summarize'

/** 汇总结论的契约版本（进 DC-20 的 digest 子集，decision_record 写 basis_refs 也用）。 */
const CONTRACT_VERSION = '2.0.0'

/** S10 阶段码：工具写死，不接受入参（DC-07）。 */
const STAGE_CODE = 'S10'

/** permitted_results 的固定顺序（TC §3.5：便于断言）。 */
const BASE_PERMITTED_RESULTS = ['ADVANCE', 'HOLD', 'WITHDRAW', 'REJECT'] as const

/** 汇总 warnings 的封闭集（DC §3.3）。 */
const WARNING_CODES = [
  'PARTIAL_PANEL',
  'MINORITY_DISSENT',
  'SCORECARD_WAIVED',
  'SCORECARD_SHAPE_INVALID',
  'RECORD_NOT_READY',
  'HIRING_MANAGER_UNSET',
  'FIXTURE_BASIS',
] as const

/** blockers 的封闭集（TC §3.5）。汇总侧不产生 RECORD_NOT_VERIFIED（只在决策引用 record 时出现）。 */
const BLOCKER_CODES = [
  'SCORECARD_MISSING',
  'NO_SUBMITTED_SCORECARD',
  'SCORECARD_UNUSABLE',
  'NO_REJECTING_SCORECARD',
  'UNREADABLE_NOT_RESOLVED',
  'OPEN_REVIEW_TASK',
  'RECORD_NOT_VERIFIED',
  'ALREADY_DECIDED',
] as const

/** required_human_action 的封闭集（TC §3.3 优先级：前者 > 后者）。 */
const HUMAN_ACTIONS = [
  'SUPERSEDE_EXISTING_DECISION',
  'RESOLVE_BLOCKER',
  'RESOLVE_UNREADABLE',
  'CHASE_SCORECARD',
  'CONFIRM_DECISION',
] as const

/** assessment 四态（SC §4.5）。 */
const ASSESSMENTS = ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'] as const

/** overall 三值（SC §4.6；列名就是 overall）。 */
const OVERALLS = ['ADVANCE', 'HOLD', 'REJECT'] as const

/** rationale 里拒绝理由的固定行前缀（DESIGN §3.5②）。 */
const REJECT_REASONS_PREFIX = 'REJECT_REASONS_JSON: '

// =====================================================================
//  入参（TC §3.1；保留键声明但拒收，TC §1.6）
// =====================================================================

const ACCEPTED_PARAMS: ParamMap = {
  application_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Application id (UUID). The summary target is an application.',
  },
  decision_scope: {
    kind: 'string',
    required: true,
    maxLength: 16,
    description:
      'STAGE | FINAL. SCREENING is not an S10 scope (INVALID_ARGS(DECISION_SCOPE_NOT_S10)). '
      + 'STAGE requires interview_id; FINAL forbids it.',
  },
  interview_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Interview id (UUID). Required for decision_scope=STAGE; forbidden for FINAL.',
  },
  as_of: {
    kind: 'string',
    required: true,
    maxLength: 40,
    description:
      'ISO-8601 timestamp WITH timezone offset (e.g. 2026-11-13T00:00:00+08:00). '
      + 'Required; must not be later than the server clock. It is the only clock input and is echoed verbatim.',
  },
  require_complete: {
    kind: 'boolean',
    description:
      'Default false. When true and any required scorecard is missing (including unusable), '
      + 'the call fails with SCORECARD_MISSING(REQUIRED_SCORECARDS_INCOMPLETE).',
  },
}

/** 保留键：声明在 parameters 里，但出现即 INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)（TC §1.6）。 */
const RESERVED_PARAMS: ParamMap = {
  tenant_id: { kind: 'string', maxLength: 64, description: 'Reserved. Comes from execution context only; always rejected.' },
  actor_id: { kind: 'string', maxLength: 64, description: 'Reserved. Comes from execution context only; always rejected.' },
  interviewer_id: { kind: 'string', maxLength: 64, description: 'Reserved. Reviewer identity comes from context; always rejected.' },
  decided_by_actor_id: { kind: 'string', maxLength: 64, description: 'Reserved. The summary never records a decider; always rejected.' },
  stage_code: { kind: 'string', maxLength: 64, description: 'Reserved. The tool writes S10 itself; always rejected.' },
  round_no: { kind: 'string', maxLength: 64, description: 'Reserved. The round comes from interview_id; always rejected.' },
  slot_code: { kind: 'string', maxLength: 64, description: 'Reserved. The slot comes from interview_id; always rejected.' },
  submitted_at: { kind: 'string', maxLength: 64, description: 'Reserved. The summary never sets submitted_at; always rejected.' },
  decided_at: { kind: 'string', maxLength: 64, description: 'Reserved. The summary is a projection and never decides; always rejected.' },
  status: { kind: 'string', maxLength: 64, description: 'Reserved. Only current SUBMITTED/WAIVED rows are read; always rejected.' },
}

const RESERVED_KEYS: readonly string[] = Object.keys(RESERVED_PARAMS)
const ALLOWED_KEYS: readonly string[] = Object.keys(ACCEPTED_PARAMS)

/** 模型可见 schema：合法键 + 保留键都声明；根对象封闭。 */
const SCHEMA_PARAMS: ParamMap = {
  ...ACCEPTED_PARAMS,
  decision_scope: {
    ...(ACCEPTED_PARAMS.decision_scope as ParamSpec),
    values: ['STAGE', 'FINAL'],
  },
  ...RESERVED_PARAMS,
}

// =====================================================================
//  输出 schema（DSH 官方可接受子集：不允许 type 数组 / type:'null'）
// =====================================================================
//
// 契约把 `aggregation.average` 与 `brief` 画成 null；DSH 校验器不接受
// `type:'null'`，所以可空节点用 `oneOf: [<正形状>, { const: null }]` 表达
// （`oneOf`/`const` 都在官方子集里）。其余"可为空"的字段一律省略键。

// DSH 的子集允许 `type:"null"` 作为 scalar type，但要求 `const` 旁必须有 `type`
// （`assertSupportedJsonSchema`：`const requires type or oneOf`）。
const NULL_CONST: Record<string, unknown> = { type: 'null', const: null }

const MISSING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    interviewer_id: { type: 'string' },
    actor_id: { type: 'string' },
    round_no: { type: 'integer' },
    slot_code: { type: 'string' },
    scorecard_due_at: { type: 'string' },
    overdue: { type: 'boolean' },
  },
  required: ['interviewer_id', 'actor_id', 'round_no', 'slot_code', 'overdue'],
  additionalProperties: false,
}

const MINORITY_NOTE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    dimension_key: { type: 'string' },
    assessment: { type: 'string', enum: [...ASSESSMENTS] },
    note: { type: 'string' },
  },
  required: ['dimension_key', 'assessment', 'note'],
  additionalProperties: false,
}

const MINORITY_REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    scorecard_id: { type: 'string' },
    revision_no: { type: 'integer' },
    interviewer_id: { type: 'string' },
    actor_id: { type: 'string' },
    round_no: { type: 'integer' },
    slot_code: { type: 'string' },
    overall: { type: 'string', enum: [...OVERALLS] },
    transcript_basis: { type: 'string', enum: ['TRANSCRIPT', 'NO_TRANSCRIPT'] },
    reject_reasons: { type: 'array', items: { type: 'object', additionalProperties: true } },
    rationale: { type: 'string' },
    notes: { type: 'array', items: MINORITY_NOTE_SCHEMA },
  },
  required: [
    'scorecard_id', 'revision_no', 'interviewer_id', 'actor_id', 'round_no', 'slot_code',
    'overall', 'transcript_basis', 'reject_reasons', 'rationale', 'notes',
  ],
  additionalProperties: false,
}

const PER_DIMENSION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    dimension_key: { type: 'string' },
    mean: { type: 'number' },
    denominator: { type: 'integer' },
    excluded: { type: 'integer' },
    values: { type: 'array', items: { type: 'number' } },
  },
  required: ['dimension_key', 'denominator', 'excluded', 'values'],
  additionalProperties: false,
}

const AGGREGATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    method: { type: 'string', enum: ['PER_DIMENSION_SUBMITTED_ONLY', 'NOT_COMPUTED'] },
    average: {
      description: 'Mean of per-dimension means; null iff missing>0 or submitted=0 (M-1).',
      oneOf: [{ type: 'number' }, NULL_CONST],
    },
    average_refused_reason: { type: 'string', enum: ['MISSING_SCORES', 'NO_SUBMITTED_SCORECARD'] },
    per_dimension: { type: 'array', items: PER_DIMENSION_SCHEMA },
  },
  required: ['method', 'average', 'per_dimension'],
  additionalProperties: false,
}

const BLOCKER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: [...BLOCKER_CODES] },
    family: { type: 'string', enum: ['COVERAGE', 'EVIDENCE', 'QUEUE', 'STATE'] },
    blocks_results: {
      type: 'array',
      items: { type: 'string', enum: ['ADVANCE', 'HOLD', 'WITHDRAW', 'REJECT', 'HIRED'] },
    },
    blocks_all: { type: 'boolean' },
    detail: { type: 'object', additionalProperties: true },
  },
  required: ['code', 'family', 'blocks_results', 'blocks_all'],
  additionalProperties: false,
}

const WARNING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: [...WARNING_CODES] },
    message: { type: 'string' },
    detail: { type: 'object', additionalProperties: true },
  },
  required: ['code', 'message'],
  additionalProperties: false,
}

const CARRY_OVER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    dimension_key: { type: 'string' },
    scorecard_id: { type: 'string' },
    assessment: { type: 'string', enum: ['NOT_OBSERVED', 'UNREADABLE'] },
  },
  required: ['dimension_key', 'scorecard_id', 'assessment'],
  additionalProperties: false,
}

const UNANSWERED_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    dimension_key: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['dimension_key', 'question'],
  additionalProperties: false,
}

const EVIDENCE_REF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    interview_record_id: { type: 'string' },
    section_key: { type: 'string' },
  },
  required: ['interview_record_id', 'section_key'],
  additionalProperties: false,
}

const BRIEF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    next_round: {
      type: 'object',
      properties: { round_no: { type: 'integer' } },
      required: ['round_no'],
      additionalProperties: false,
    },
    carry_over: { type: 'array', items: CARRY_OVER_SCHEMA },
    unanswered_questions: { type: 'array', items: UNANSWERED_SCHEMA },
    absent_interviewers: { type: 'array', items: MISSING_SCHEMA },
    evidence_refs: { type: 'array', items: EVIDENCE_REF_SCHEMA },
    derived_from: {
      type: 'object',
      properties: {
        decision_id: { type: 'string' },
        summary_digest: { type: 'string' },
        rubric_version_id: { type: 'string' },
        interview_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['decision_id', 'summary_digest', 'rubric_version_id', 'interview_ids'],
      additionalProperties: false,
    },
    brief_digest: { type: 'string' },
  },
  required: [
    'next_round', 'carry_over', 'unanswered_questions', 'absent_interviewers',
    'evidence_refs', 'derived_from', 'brief_digest',
  ],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    advisory: { type: 'boolean', enum: [true] },
    read_only: { type: 'boolean', enum: [true] },
    as_of: { type: 'string' },
    application_id: { type: 'string' },
    interview_id: { type: 'string' },
    decision_scope: { type: 'string', enum: ['STAGE', 'FINAL'] },
    stage_code: { type: 'string', enum: [STAGE_CODE] },
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
    rubric: {
      type: 'object',
      properties: {
        version_id: { type: 'string' },
        version_no: { type: 'integer' },
        payload_hash: { type: 'string' },
        source: { type: 'string', enum: ['APPLICATION_PINNED'] },
      },
      required: ['version_id', 'version_no', 'payload_hash', 'source'],
      additionalProperties: false,
    },
    coverage: {
      type: 'object',
      properties: {
        required_total: { type: 'integer' },
        submitted: { type: 'integer' },
        waived: { type: 'integer' },
        missing: { type: 'integer' },
        unusable: { type: 'integer' },
        not_required: { type: 'integer' },
        overdue: { type: 'integer' },
        completion_ratio: { type: 'number' },
      },
      required: [
        'required_total', 'submitted', 'waived', 'missing',
        'unusable', 'not_required', 'overdue', 'completion_ratio',
      ],
      additionalProperties: false,
    },
    missing: { type: 'array', items: MISSING_SCHEMA },
    tally: {
      type: 'object',
      properties: {
        advance: { type: 'integer' },
        hold: { type: 'integer' },
        reject: { type: 'integer' },
        waived: { type: 'integer' },
      },
      required: ['advance', 'hold', 'reject', 'waived'],
      additionalProperties: false,
    },
    consensus: {
      type: 'string',
      enum: [
        'NO_SUBMISSIONS', 'UNANIMOUS_ADVANCE', 'UNANIMOUS_REJECT',
        'MAJORITY_ADVANCE', 'MAJORITY_REJECT', 'SPLIT',
      ],
    },
    consensus_scope: { type: 'string', enum: ['FULL_PANEL', 'PARTIAL_PANEL'] },
    minority_reports: { type: 'array', items: MINORITY_REPORT_SCHEMA },
    aggregation: AGGREGATION_SCHEMA,
    record: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['READY', 'NOT_READY', 'ABSENT', 'NOT_CITED'] },
        interview_record_id: { type: 'string' },
        verification_status: { type: 'string', enum: ['UNVERIFIED', 'VERIFIED', 'FAILED'] },
      },
      required: ['state'],
      additionalProperties: false,
    },
    ready_for_decision: { type: 'boolean' },
    blockers: { type: 'array', items: BLOCKER_SCHEMA },
    permitted_results: {
      type: 'array',
      items: { type: 'string', enum: [...BASE_PERMITTED_RESULTS] },
    },
    required_human_action: { type: 'string', enum: [...HUMAN_ACTIONS] },
    warnings: { type: 'array', items: WARNING_SCHEMA },
    snapshot: {
      type: 'object',
      properties: {
        application_record_version: { type: 'integer' },
        rubric_version_id: { type: 'string' },
        rubric_payload_hash: { type: 'string' },
        scorecard_ids: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'application_record_version', 'rubric_version_id',
        'rubric_payload_hash', 'scorecard_ids',
      ],
      additionalProperties: false,
    },
    summary_digest: { type: 'string' },
    brief: {
      description: 'Next round brief (DC-41..46); null when it does not apply.',
      oneOf: [BRIEF_SCHEMA, NULL_CONST],
    },
    brief_absence: {
      type: 'object',
      properties: { code: { type: 'string', enum: ['NO_DECISION', 'NOT_ADVANCED', 'FINAL_SCOPE'] } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  required: [
    'tool', 'contract_version', 'advisory', 'read_only', 'as_of', 'application_id',
    'decision_scope', 'stage_code', 'labels', 'rubric', 'coverage', 'missing', 'tally',
    'consensus', 'consensus_scope', 'minority_reports', 'aggregation', 'record',
    'ready_for_decision', 'blockers', 'permitted_results', 'required_human_action',
    'warnings', 'snapshot', 'summary_digest', 'brief',
  ],
  additionalProperties: false,
}

// =====================================================================
//  错误形状（TC §1.2；errors.ts 的类型联合不含 S10 的新码，故本地构造）
// =====================================================================

type EvaluationErrorCode = 'INVALID_ARGS' | 'NOT_FOUND' | 'SCORECARD_MISSING'

/**
 * 构造 `Error: <CODE>: <compact-json>`（键序 code → reason_code → message → detail）。
 * @param code - 稳定错误码。
 * @param reasonCode - 该码下的封闭枚举取值。
 * @param message - 一句中文说明。
 * @param detail - 结构化明细；没有则省略键。
 */
function evalError(
  code: EvaluationErrorCode,
  reasonCode: string,
  message: string,
  detail?: unknown,
): RecruitmentToolError {
  // TC §1.2 要求键序固定为 code → reason_code → (family) → message → detail。
  // 这里**不**用 canonicalJson 包整包（它会按字典序排键）；detail 内部仍用规范化 JSON。
  const head = `{"code":${JSON.stringify(code)},"reason_code":${JSON.stringify(reasonCode)},`
    + `"message":${JSON.stringify(message)}`
  const body = detail === undefined ? `${head}}` : `${head},"detail":${canonicalJson(detail)}}`
  // `RecruitmentToolError` 的 code 联合不含 S10 新码；运行期 code 就是传入值（DESIGN §2）。
  return new RecruitmentToolError(code as never, body)
}

// =====================================================================
//  纯函数（可单测）：rationale 解析 / items 形状 / consensus / digest
// =====================================================================

/** 一条面评的形状校验结果。 */
export interface ScorecardShapeResult {
  /** 违规代码；空数组表示可用（TC §3.4）。 */
  readonly violations: readonly string[]
  /** 从 rationale 里解析出的 reject_reasons 原文（非 REJECT 时为空数组）。 */
  readonly rejectReasons: readonly unknown[]
  /** `items.transcript_basis`；形状不可用时为 null。 */
  readonly transcriptBasis: string | null
}

/**
 * 解析 `rationale` 里的拒绝理由（DESIGN §3.5②）：按行找**最后**一个
 * `REJECT_REASONS_JSON: ` 开头的行，JSON.parse 行剩余部分。
 * @param rationale - 面评的自由文本（库没有 reject_reasons 列，G-1）。
 * @returns 解析成功且是数组 → `{ok:true}`；否则 `{ok:false}`。
 */
export function parseRejectReasons(
  rationale: string | null,
): { ok: true; reasons: readonly unknown[] } | { ok: false } {
  if (typeof rationale !== 'string' || rationale === '') return { ok: false }
  const lines = rationale.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string
    if (!line.startsWith(REJECT_REASONS_PREFIX)) continue
    try {
      const parsed: unknown = JSON.parse(line.slice(REJECT_REASONS_PREFIX.length))
      if (!Array.isArray(parsed)) return { ok: false }
      return { ok: true, reasons: parsed }
    } catch {
      return { ok: false }
    }
  }
  return { ok: false }
}

/** 面评形状校验的输入。 */
export interface ScorecardShapeInput {
  /** rubric_version.dimensions[].key（不是保留键）。 */
  readonly rubricDimensionKeys: readonly string[]
  /** scorecard.items（jsonb 解析后）。 */
  readonly items: unknown
  /** scorecard.overall。 */
  readonly overall: unknown
  /** scorecard.rationale。 */
  readonly rationale: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** jsonb 列兼容：pg 正常返回对象；测试/旧数据可能是字符串。 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (isObject(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/** jsonb 数组兼容。 */
function asArray(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * 读侧二次校验 `items` 形状（TC §3.4 / SC §4.4/§4.6）。本工具是最后一道门：
 * 库不校验 items（0001:L1314-1315）。
 * @param input - 维度键、items、overall、rationale。
 * @returns 违规代码 + 原始 reject_reasons + transcript_basis。
 */
export function scorecardShapeViolations(input: ScorecardShapeInput): ScorecardShapeResult {
  const violations: string[] = []
  const overall = input.overall
  if (typeof overall !== 'string' || !(OVERALLS as readonly string[]).includes(overall)) {
    violations.push('OVERALL_INVALID')
  }
  const items = asObject(input.items)
  if (items === null) {
    violations.push('ITEMS_NOT_OBJECT')
    return { violations, rejectReasons: [], transcriptBasis: null }
  }

  const expected = new Set<string>([...input.rubricDimensionKeys, 'transcript_basis'])
  for (const key of Object.keys(items)) {
    if (!expected.has(key)) violations.push(`ITEM_NOT_IN_RUBRIC:${key}`)
  }
  for (const key of input.rubricDimensionKeys) {
    if (!Object.hasOwn(items, key)) violations.push(`DIMENSION_MISSING:${key}`)
  }

  let transcriptBasis: string | null = null
  const basis = items.transcript_basis
  if (basis === 'TRANSCRIPT' || basis === 'NO_TRANSCRIPT') {
    transcriptBasis = basis
  } else {
    violations.push('TRANSCRIPT_BASIS_INVALID')
  }

  for (const key of input.rubricDimensionKeys) {
    const item = asObject(items[key])
    if (item === null) {
      violations.push(`ITEM_NOT_OBJECT:${key}`)
      continue
    }
    const assessment = item.assessment
    if (typeof assessment !== 'string' || !(ASSESSMENTS as readonly string[]).includes(assessment)) {
      violations.push(`ASSESSMENT_INVALID:${key}`)
      continue
    }
    if (overall === 'ADVANCE' && (assessment === 'NOT_OBSERVED' || assessment === 'UNREADABLE')) {
      violations.push(`ADVANCE_WITH_UNASSESSED:${key}`)
    }
    if (transcriptBasis === 'NO_TRANSCRIPT') {
      const evidence = asArray(item.evidence) ?? []
      const hasSegment = evidence.some((entry) => {
        const object = asObject(entry)
        return object !== null && object.kind === 'SEGMENT'
      })
      if (hasSegment) violations.push(`NO_TRANSCRIPT_SEGMENT:${key}`)
    }
  }

  let rejectReasons: readonly unknown[] = []
  if (overall === 'REJECT') {
    const parsed = parseRejectReasons(input.rationale)
    if (!parsed.ok) {
      violations.push('RATIONALE_NOT_PARSABLE')
    } else {
      rejectReasons = parsed.reasons
      if (parsed.reasons.length === 0) violations.push('REJECT_REASONS_EMPTY')
      for (const reason of parsed.reasons) {
        const object = asObject(reason)
        const dimensionKey = object?.dimension_key
        if (typeof dimensionKey !== 'string') {
          violations.push('REJECT_REASON_INVALID')
          continue
        }
        if (!input.rubricDimensionKeys.includes(dimensionKey)) {
          violations.push(`REJECT_DIMENSION_UNKNOWN:${dimensionKey}`)
          continue
        }
        const item = asObject(items[dimensionKey])
        if (item?.assessment !== 'NOT_MET') {
          violations.push(`REJECT_DIMENSION_NOT_NOT_MET:${dimensionKey}`)
        }
      }
    }
  }

  return { violations, rejectReasons, transcriptBasis }
}

/** tally 的四项（DC §3.3）。 */
export interface EvaluationTally {
  readonly advance: number
  readonly hold: number
  readonly reject: number
  readonly waived: number
}

/**
 * consensus 封闭词汇（DC §3.3，逐字实现；只描述已交票数，不产结论）。
 * @param tally - 票数。
 * @returns `NO_SUBMISSIONS | UNANIMOUS_ADVANCE | UNANIMOUS_REJECT | MAJORITY_ADVANCE | MAJORITY_REJECT | SPLIT`。
 */
export function consensusOf(tally: EvaluationTally): string {
  const a = tally.advance
  const h = tally.hold
  const r = tally.reject
  const n = a + h + r
  if (n === 0) return 'NO_SUBMISSIONS'
  if (r === 0 && h === 0) return 'UNANIMOUS_ADVANCE'
  if (a === 0 && h === 0) return 'UNANIMOUS_REJECT'
  if (a > r + h) return 'MAJORITY_ADVANCE'
  if (r > a + h) return 'MAJORITY_REJECT'
  return 'SPLIT'
}

/** `summary_digest` 固定子集的输入（DC-20；子集逐键见函数体注释）。 */
export interface SummaryDigestFacts {
  readonly as_of: string
  readonly application_id: string
  readonly decision_scope: string
  readonly interview_id?: string | null
  readonly rubric_version_id: string
  readonly rubric_payload_hash: string
  readonly scorecards: readonly {
    readonly id: string
    readonly revision_no: number
    readonly interviewer_id: string
    readonly payload_hash: string | null
    readonly status: string
  }[]
  readonly record: {
    readonly id: string | null
    readonly revision: number | null
    readonly verification_status: string | null
  }
  readonly coverage: Readonly<Record<string, unknown>>
  readonly tally: Readonly<Record<string, unknown>>
  readonly missing: readonly { readonly interviewer_id: string }[]
  readonly blockers: readonly { readonly code: string }[]
}

/**
 * DC-20 的固定子集 → sha256(canonical_json(...))（小写 hex）。
 *
 * 子集逐键（一个都不能少、不能多）：
 *   `contract_version` / `as_of` / `application_id` / `decision_scope` / `interview_id`
 *   / `rubric{version_id,payload_hash}`
 *   / `scorecards[{id,revision_no,interviewer_id,payload_hash,status}]`（按 interviewer_id 排序）
 *   / `record{id,revision,verification_status}`
 *   / `coverage` / `tally` / `missing[interviewer_id]` / `blockers[code]`。
 *
 * `as_of` **必须**进子集：`coverage.overdue` 由它决定（DC-20）；不含任何墙钟/随机。
 * @param facts - 上述子集的来源值。
 * @returns 64 位小写 hex。
 */
export function summaryDigestOf(facts: SummaryDigestFacts): string {
  const scorecards = [...facts.scorecards]
    .sort((left, right) => {
      const byInterviewer = left.interviewer_id.localeCompare(right.interviewer_id)
      return byInterviewer !== 0 ? byInterviewer : left.id.localeCompare(right.id)
    })
    .map((scorecard) => ({
      id: scorecard.id,
      revision_no: scorecard.revision_no,
      interviewer_id: scorecard.interviewer_id,
      payload_hash: scorecard.payload_hash,
      status: scorecard.status,
    }))
  const missingIds = facts.missing
    .map((entry) => entry.interviewer_id)
    .sort((left, right) => left.localeCompare(right))
  const blockerCodes = facts.blockers
    .map((blocker) => blocker.code)
    .sort((left, right) => left.localeCompare(right))
  return digestOf({
    contract_version: CONTRACT_VERSION,
    as_of: facts.as_of,
    application_id: facts.application_id,
    decision_scope: facts.decision_scope,
    interview_id: facts.interview_id ?? null,
    rubric: {
      version_id: facts.rubric_version_id,
      payload_hash: facts.rubric_payload_hash,
    },
    scorecards,
    record: {
      id: facts.record.id,
      revision: facts.record.revision,
      verification_status: facts.record.verification_status,
    },
    coverage: facts.coverage,
    tally: facts.tally,
    missing: missingIds,
    blockers: blockerCodes,
  })
}

/** 四舍五入到 4 位小数（contract 的 0.6667 形态；避免浮点尾差进 digest）。 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

// =====================================================================
//  数据库行形状
// =====================================================================

interface ApplicationRow {
  readonly id: string
  readonly candidate_id: string
  readonly job_id: string
  readonly job_version_id: string
  readonly rubric_version_id: string | null
  readonly lifecycle_status: string
  readonly current_stage_code: string
  readonly record_version: number
}

interface InterviewRow {
  readonly id: string
  readonly application_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly status: string
  readonly scheduled_start_at: string | Date | null
}

interface InterviewerRow {
  readonly id: string
  readonly interview_id: string
  readonly actor_id: string
  readonly required_scorecard: boolean
  readonly scorecard_due_at: string | Date | null
  readonly round_no: number
  readonly slot_code: string
}

interface RubricRow {
  readonly id: string
  readonly job_id: string
  readonly version_no: number
  readonly dimensions: unknown
  readonly payload_hash: string
}

interface ScorecardRow {
  readonly id: string
  readonly interview_id: string
  readonly interviewer_id: string
  readonly rubric_version_id: string
  readonly revision_no: number
  readonly status: string
  readonly submitted_at: string | Date | null
  readonly waive_reason: string | null
  readonly items: unknown
  readonly overall: string | null
  readonly rationale: string | null
  readonly payload_hash: string | null
}

interface RecordRow {
  readonly id: string
  readonly interview_id: string
  readonly status: string
  readonly verification_status: string
  readonly record_version: number
  readonly sections: unknown
}

interface DecisionRow {
  readonly id: string
  readonly result: string
  readonly interview_id: string | null
  readonly decision_scope: string
  readonly record_version: number
}

interface TaskRow {
  readonly id: string
  readonly business_refs: unknown
}

/** 已解析并通过参数层的入参。 */
interface SummaryArgs {
  readonly application_id: string
  readonly decision_scope: 'STAGE' | 'FINAL'
  readonly interview_id?: string
  readonly as_of: string
  readonly require_complete: boolean
}

// =====================================================================
//  参数层（TC §3.1 / §1.1 / §1.6）
// =====================================================================

/**
 * 校验并归一化入参。所有检查都在任何库访问之前完成。
 * @param rawArgs - 模型给的 arguments（或 decision_record 构造的同一形状）。
 * @param nowMs - 服务端"现在"（毫秒），只用于 AS_OF_IN_FUTURE。
 * @returns 归一化后的入参。
 * @throws RecruitmentToolError - 违反项一次性抛出（TC §1.1 第 7 条）。
 */
function parseSummaryArgs(rawArgs: unknown, nowMs: number): SummaryArgs {
  if (isObject(rawArgs)) {
    const reserved = RESERVED_KEYS.filter((key) => Object.hasOwn(rawArgs, key))
    if (reserved.length > 0) {
      throw evalError(
        'INVALID_ARGS',
        'TENANT_OR_ACTOR_NOT_ALLOWED',
        `${reserved[0]} 只能来自执行上下文，不接受入参`,
        { rejected_keys: reserved, allowed: ALLOWED_KEYS },
      )
    }
  }

  const { parsed, violations } = collectArgViolations(ACCEPTED_PARAMS, rawArgs)
  if (violations.length > 0) {
    const first = violations[0]
    if (first === undefined) throw new Error('unreachable: empty arg violations')
    throw evalError(
      'INVALID_ARGS',
      first.reason,
      '参数不合法，逐条见 detail.violations',
      {
        allowed: ALLOWED_KEYS,
        violations: violations.map((violation) => ({
          reason_code: violation.reason,
          path: violation.path,
          message: violation.message,
        })),
      },
    )
  }
  const applicationId = parsed.application_id as string
  const scopeRaw = parsed.decision_scope as string

  if (scopeRaw !== 'STAGE' && scopeRaw !== 'FINAL') {
    if (scopeRaw === 'SCREENING') {
      throw evalError(
        'INVALID_ARGS',
        'DECISION_SCOPE_NOT_S10',
        '本工具只处理 S10（STAGE/FINAL）；SCREENING 归 S7',
        { got: scopeRaw, allowed: ['STAGE', 'FINAL'] },
      )
    }
    throw evalError(
      'INVALID_ARGS',
      'ENUM_INVALID',
      'decision_scope 不在封闭枚举内',
      { got: scopeRaw, allowed: ['STAGE', 'FINAL'] },
    )
  }

  const interviewId = typeof parsed.interview_id === 'string' ? parsed.interview_id : undefined
  if (scopeRaw === 'STAGE' && interviewId === undefined) {
    throw evalError(
      'INVALID_ARGS',
      'STAGE_REQUIRES_INTERVIEW',
      'decision_scope=STAGE 必须指定 interview_id（禁止自动取最后一轮）',
      { allowed: ['STAGE'] },
    )
  }
  if (scopeRaw === 'FINAL' && interviewId !== undefined) {
    throw evalError(
      'INVALID_ARGS',
      'FINAL_SCOPE_NO_INTERVIEW',
      'decision_scope=FINAL 不得指定 interview_id（终局跨全部面试）',
      { interview_id: interviewId },
    )
  }

  const asOf = parsed.as_of as string
  const checked = checkAsOf(asOf, nowMs)
  if (!checked.ok) {
    // DESIGN §2：格式错按 TYPE_MISMATCH；TC §5.1 没有 AS_OF_FORMAT。
    const reasonCode = checked.reason_code === 'AS_OF_IN_FUTURE' ? 'AS_OF_IN_FUTURE' : 'TYPE_MISMATCH'
    throw evalError('INVALID_ARGS', reasonCode, checked.message, { as_of: asOf })
  }

  return {
    application_id: applicationId,
    decision_scope: scopeRaw,
    ...(interviewId === undefined ? {} : { interview_id: interviewId }),
    as_of: asOf,
    require_complete: parsed.require_complete === true,
  }
}

/**
 * DESIGN §3.5①：执行上下文 actor 必须来自事务里的 GUC，不是 cfg.actor_id。
 * 汇总本身不用 actor 做判定，但必须在同一上下文里执行（身份不能被调用方伪造）。
 * @param client - 事务连接。
 * @throws INVALID_ARGS(ACTOR_REQUIRED) - GUC 为空（登记偏差，TC §5.1 无此取值）。
 */
async function requireActor(client: DatabaseClient): Promise<string> {
  const { rows } = await client.query<{ actor_id: string | null }>(
    "select nullif(current_setting('recruitment.actor_id', true), '') as actor_id",
  )
  const actorId = rows[0]?.actor_id ?? null
  if (actorId === null) {
    throw evalError(
      'INVALID_ARGS',
      'ACTOR_REQUIRED',
      '执行上下文没有 recruitment.actor_id，无法证明调用身份',
    )
  }
  return actorId
}

// =====================================================================
//  读取（全部参数化；只读 current 的 SUBMITTED/WAIVED）
// =====================================================================

const APPLICATION_SQL = `
  select a.id, a.candidate_id, a.job_id, a.job_version_id, a.rubric_version_id,
         a.lifecycle_status, a.current_stage_code, a.record_version
    from recruitment.application a
   where a.tenant_id = $1 and a.id = $2`

const STAGE_INTERVIEW_SQL = `
  select iv.id, iv.application_id, iv.round_no, iv.slot_code, iv.status, iv.scheduled_start_at
    from recruitment.interview iv
   where iv.tenant_id = $1 and iv.id = $2 and iv.application_id = $3`

const FINAL_INTERVIEWS_SQL = `
  select iv.id, iv.application_id, iv.round_no, iv.slot_code, iv.status, iv.scheduled_start_at
    from recruitment.interview iv
   where iv.tenant_id = $1 and iv.application_id = $2
   order by iv.round_no, iv.slot_code, iv.id`

const RUBRIC_SQL = `
  select rv.id, rv.job_id, rv.version_no, rv.dimensions, rv.payload_hash
    from recruitment.rubric_version rv
   where rv.tenant_id = $1 and rv.id = $2`

const INTERVIEWER_SQL = `
  select i.id, i.interview_id, i.actor_id, i.required_scorecard, i.scorecard_due_at,
         iv.round_no, iv.slot_code
    from recruitment.interviewer i
    join recruitment.interview iv
      on iv.id = i.interview_id and iv.tenant_id = i.tenant_id
   where i.tenant_id = $1 and i.interview_id = any($2::uuid[])
   order by iv.round_no, iv.slot_code, iv.id, i.actor_id, i.id`

const SCORECARD_SQL = `
  select s.id, s.interview_id, s.interviewer_id, s.rubric_version_id, s.revision_no,
         s.status, s.submitted_at, s.waive_reason, s.items, s.overall, s.rationale,
         s.payload_hash
    from recruitment.scorecard s
   where s.tenant_id = $1
     and s.interview_id = any($2::uuid[])
     and s.superseded_by_scorecard_id is null
     and s.status in ('SUBMITTED', 'WAIVED')
   order by s.interview_id, s.interviewer_id, s.id`

const STAGE_DECISION_SQL = `
  select d.id, d.result, d.interview_id, d.decision_scope, d.record_version
    from recruitment.decision d
   where d.tenant_id = $1 and d.application_id = $2 and d.decision_scope = 'STAGE'
     and d.stage_code = 'S10' and d.superseded_by_decision_id is null
     and d.interview_id = $3
   order by d.decided_at desc, d.id
   limit 1`

const FINAL_DECISION_SQL = `
  select d.id, d.result, d.interview_id, d.decision_scope, d.record_version
    from recruitment.decision d
   where d.tenant_id = $1 and d.application_id = $2 and d.decision_scope = 'FINAL'
     and d.stage_code = 'S10' and d.superseded_by_decision_id is null
   order by d.decided_at desc, d.id
   limit 1`

const RECORD_SQL = `
  select ir.id, ir.interview_id, ir.status, ir.verification_status, ir.record_version, ir.sections
    from recruitment.interview_record ir
   where ir.tenant_id = $1 and ir.interview_id = any($2::uuid[]) and ir.is_current
   order by ir.interview_id, ir.id`

const HUMAN_TASK_SQL = `
  select bt.id, bt.business_refs
    from recruitment.business_task bt
   where bt.tenant_id = $1 and bt.status = 'WAITING_HUMAN'
   order by bt.id`

const DEPARTMENT_SQL = `
  select d.hiring_manager_actor_id
    from recruitment.job j
    join recruitment.department d
      on d.id = j.department_id and d.tenant_id = j.tenant_id
   where j.tenant_id = $1 and j.id = $2`

const RESUME_PROVIDER_SQL = `
  select e.provider
    from recruitment.resume_version rv
    join recruitment.resume r
      on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
    join recruitment.intake_asset ia
      on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
    join recruitment.intake_record ir
      on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
    join recruitment.event_inbox e
      on e.event_id = ir.event_id and e.tenant_id = ir.tenant_id
   where rv.tenant_id = $1 and rv.id = $2
   limit 1`

const MEETING_PROVIDER_SQL = `
  select iv.id as interview_id, mb.id as binding_id, m.provider
    from recruitment.interview iv
    left join recruitment.meeting_binding mb
      on mb.interview_id = iv.id and mb.tenant_id = iv.tenant_id and mb.unbound_at is null
    left join recruitment.meeting m
      on m.id = mb.meeting_id and m.tenant_id = mb.tenant_id
   where iv.tenant_id = $1 and iv.id = any($2::uuid[])
   order by iv.round_no, iv.slot_code, iv.id`

/** ISO 字符串（timestamptz 只记得瞬时，不记得原偏移；统一 UTC 形态保证确定性）。 */
function toIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** 某值是否是"工程上存在"的字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

// =====================================================================
//  主函数（decision_record 也调用它，DC-16 要求同一个函数）
// =====================================================================

/**
 * 计算一份汇总投影（只读、无时钟、确定性）。TC §3 / DC §3.2。
 *
 * **decision_record 必须调用本函数重算**，不得另写一份门禁（DC-16）。
 * @param client - 调用方给的连接（事务里的 `recruitment.actor_id` 已设好）。
 * @param cfg - 已解析的 database 配置（只用 tenant_id）。
 * @param rawArgs - 入参（application_id / decision_scope / interview_id? / as_of / require_complete?）。
 * @param nowMs - 服务端"现在"（只用于 as_of 不得晚于 now）。
 * @returns 汇总投影；键集见文件头与 DC §3.2。
 * @throws RecruitmentToolError - INVALID_ARGS / NOT_FOUND / SCORECARD_MISSING。
 */
export async function computeEvaluationSummaryIn(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  rawArgs: unknown,
  nowMs: number,
): Promise<EvaluationSummary> {
  const args = parseSummaryArgs(rawArgs, nowMs)
  const tenantId = cfg.tenant_id
  const asOfMs = Date.parse(args.as_of)

  // DESIGN §3.5①：身份只从事务 GUC 来。
  await requireActor(client)

  // ---- 申请 ----
  const appResult = await client.query<ApplicationRow>(APPLICATION_SQL, [tenantId, args.application_id])
  const app = appResult.rows[0]
  if (app === undefined) {
    throw evalError('NOT_FOUND', 'APPLICATION_NOT_FOUND', '该租户下没有这个申请', {
      application_id: args.application_id,
    })
  }

  // ---- 面试（STAGE 一场；FINAL 跨全部）----
  let interviews: InterviewRow[] = []
  if (args.decision_scope === 'STAGE') {
    const interviewResult = await client.query<InterviewRow>(STAGE_INTERVIEW_SQL, [
      tenantId, args.interview_id as string, app.id,
    ])
    const interview = interviewResult.rows[0]
    if (interview === undefined) {
      throw evalError('NOT_FOUND', 'INTERVIEW_NOT_FOUND', '该申请下没有入参指定的面试', {
        application_id: app.id,
        interview_id: args.interview_id as string,
      })
    }
    interviews = [interview]
  } else {
    const interviewResult = await client.query<InterviewRow>(FINAL_INTERVIEWS_SQL, [tenantId, app.id])
    interviews = [...interviewResult.rows]
  }
  const interviewIds = interviews.map((interview) => interview.id)

  // ---- Rubric（只用申请钉住的版本，不做任何 fallback：SC-09/10）----
  if (app.rubric_version_id === null) {
    throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', '申请没有钉住 Rubric 版本，汇总无法二次校验 items', {
      application_id: app.id,
    })
  }
  const rubricResult = await client.query<RubricRow>(RUBRIC_SQL, [tenantId, app.rubric_version_id])
  const rubric = rubricResult.rows[0]
  if (rubric === undefined) {
    throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', '申请钉住的 Rubric 版本不存在', {
      application_id: app.id,
      rubric_version_id: app.rubric_version_id,
    })
  }
  if (rubric.job_id !== app.job_id) {
    throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', '申请钉住的 Rubric 版本不属于该申请的岗位', {
      application_id: app.id,
      job_id: app.job_id,
      rubric_version_id: rubric.id,
      rubric_job_id: rubric.job_id,
    })
  }
  const dimensions = asArray(rubric.dimensions)
  const dimensionKeys: string[] = []
  if (dimensions === null) {
    throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', 'Rubric 的 dimensions 不可解析', {
      rubric_version_id: rubric.id,
    })
  }
  for (const dimension of dimensions) {
    const object = asObject(dimension)
    const key = object?.key
    if (!isNonEmptyString(key) || key === 'transcript_basis' || dimensionKeys.includes(key)) {
      throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', 'Rubric 的维度键不合法（空/重复/保留键）', {
        rubric_version_id: rubric.id,
      })
    }
    dimensionKeys.push(key)
  }
  if (dimensionKeys.length === 0) {
    throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', 'Rubric 没有可评价的维度', {
      rubric_version_id: rubric.id,
    })
  }

  // ---- 面试官（统计空间只能 required_interviewers：SC-21）----
  const interviewerResult = interviewIds.length === 0
    ? { rows: [] as InterviewerRow[] }
    : await client.query<InterviewerRow>(INTERVIEWER_SQL, [tenantId, interviewIds])
  const interviewerRows = [...interviewerResult.rows]

  // ---- 当前面评（SUBMITTED/WAIVED；PENDING 与无行等价：SC §6.2）----
  const scorecardResult = interviewIds.length === 0
    ? { rows: [] as ScorecardRow[] }
    : await client.query<ScorecardRow>(SCORECARD_SQL, [tenantId, interviewIds])
  const scorecards = [...scorecardResult.rows]
  const scorecardByInterviewer = new Map<string, ScorecardRow>()
  for (const scorecard of scorecards) scorecardByInterviewer.set(scorecard.interviewer_id, scorecard)

  const requiredRows = interviewerRows.filter((row) => row.required_scorecard === true)
  const requiredIds = new Set(requiredRows.map((row) => row.id))
  const requiredTotal = requiredRows.length

  let submitted = 0
  let waived = 0
  let unusable = 0
  let notRequired = 0
  const tally: { advance: number; hold: number; reject: number; waived: number } = {
    advance: 0, hold: 0, reject: 0, waived: 0,
  }
  const missingRows: InterviewerRow[] = []
  const usable: { readonly interviewer: InterviewerRow; readonly scorecard: ScorecardRow; readonly shape: ScorecardShapeResult }[] = []
  const shapeInvalid: { readonly interviewer: InterviewerRow; readonly scorecard: ScorecardRow; readonly violations: readonly string[] }[] = []
  const invalidRequiredIds: string[] = []
  const waivedRows: { readonly interviewer: InterviewerRow; readonly scorecard: ScorecardRow }[] = []
  const unreadableDimensions: { readonly scorecard_id: string; readonly dimension_key: string }[] = []

  for (const interviewer of interviewerRows) {
    const isRequired = interviewer.required_scorecard === true
    const scorecard = scorecardByInterviewer.get(interviewer.id)

    if (scorecard === undefined) {
      if (isRequired) missingRows.push(interviewer)
      continue
    }
    if (scorecard.status === 'WAIVED') {
      if (isRequired) {
        waived += 1
        tally.waived += 1
        waivedRows.push({ interviewer, scorecard })
      }
      continue
    }
    if (scorecard.status !== 'SUBMITTED') {
      if (isRequired) missingRows.push(interviewer)
      continue
    }

    const shape = scorecardShapeViolations({
      rubricDimensionKeys: dimensionKeys,
      items: scorecard.items,
      overall: scorecard.overall,
      rationale: scorecard.rationale,
    })
    if (shape.violations.includes('RATIONALE_NOT_PARSABLE')) {
      throw evalError(
        'INVALID_ARGS',
        'RATIONALE_NOT_PARSABLE',
        '面评 overall=REJECT 但 rationale 里的 REJECT_REASONS_JSON 行不可解析',
        { scorecard_id: scorecard.id, interviewer_id: interviewer.id },
      )
    }
    if (shape.violations.length > 0) {
      shapeInvalid.push({ interviewer, scorecard, violations: shape.violations })
      if (isRequired) {
        unusable += 1
        invalidRequiredIds.push(scorecard.id)
        missingRows.push(interviewer)
      }
      continue
    }

    if (!isRequired) {
      notRequired += 1
      continue
    }

    submitted += 1
    usable.push({ interviewer, scorecard, shape })
    if (scorecard.overall === 'ADVANCE') tally.advance += 1
    else if (scorecard.overall === 'REJECT') tally.reject += 1
    else tally.hold += 1

    const items = asObject(scorecard.items) ?? {}
    for (const key of dimensionKeys) {
      const item = asObject(items[key])
      if (item?.assessment === 'UNREADABLE') {
        unreadableDimensions.push({ scorecard_id: scorecard.id, dimension_key: key })
      }
    }
  }

  const missingCount = requiredTotal - submitted - waived
  // 防御：三个桶必须覆盖 required_total（若不等，说明遍历逻辑漏了分支；不静默改口径）。
  if (missingCount !== missingRows.length) {
    throw evalError('INVALID_ARGS', 'TYPE_MISMATCH', '汇总桶不守恒（实现错误）', {
      required_total: requiredTotal,
      submitted,
      waived,
      missing: missingCount,
      missing_rows: missingRows.length,
    })
  }

  const overdueCount = missingRows.filter((row) => {
    const due = toIso(row.scorecard_due_at)
    return due !== null && Date.parse(due) < asOfMs
  }).length

  const coverage = {
    required_total: requiredTotal,
    submitted,
    waived,
    missing: missingCount,
    unusable,
    not_required: notRequired,
    overdue: overdueCount,
    completion_ratio: requiredTotal === 0 ? 0 : round4((submitted + waived) / requiredTotal),
  }

  const missing = missingRows.map((row) => {
    const due = toIso(row.scorecard_due_at)
    return {
      interviewer_id: row.id,
      actor_id: row.actor_id,
      round_no: row.round_no,
      slot_code: row.slot_code,
      ...(due === null ? {} : { scorecard_due_at: due }),
      overdue: due !== null && Date.parse(due) < asOfMs,
    }
  })

  // `require_complete` 只用于"决策前预检"；默认不抛（汇总的职责就是报告缺）。
  if (args.require_complete && missingCount > 0) {
    throw evalError(
      'SCORECARD_MISSING',
      'REQUIRED_SCORECARDS_INCOMPLETE',
      `${missingCount} 份必填面评缺失（含形状不可用的），require_complete=true 拒绝出汇总`,
      { missing_count: missingCount },
    )
  }

  // ---- consensus / minority（DC §3.3；少数派原文不得摘要：DC-03）----
  const consensus = consensusOf(tally)
  const consensusScope = missingCount === 0 ? 'FULL_PANEL' : 'PARTIAL_PANEL'
  const direction = consensus.endsWith('_ADVANCE')
    ? 'ADVANCE'
    : consensus.endsWith('_REJECT') ? 'REJECT' : null
  const minorityReports: Record<string, unknown>[] = []
  if (direction !== null) {
    for (const entry of usable) {
      if (entry.scorecard.overall === direction) continue
      const items = asObject(entry.scorecard.items) ?? {}
      const notes: Record<string, unknown>[] = []
      for (const key of dimensionKeys) {
        const item = asObject(items[key])
        if (item === null || !isNonEmptyString(item.note)) continue
        notes.push({ dimension_key: key, assessment: item.assessment, note: item.note })
      }
      minorityReports.push({
        scorecard_id: entry.scorecard.id,
        revision_no: entry.scorecard.revision_no,
        interviewer_id: entry.interviewer.id,
        actor_id: entry.interviewer.actor_id,
        round_no: entry.interviewer.round_no,
        slot_code: entry.interviewer.slot_code,
        overall: entry.scorecard.overall,
        transcript_basis: entry.shape.transcriptBasis ?? 'NO_TRANSCRIPT',
        reject_reasons: [...entry.shape.rejectReasons],
        rationale: entry.scorecard.rationale ?? '',
        notes,
      })
    }
  }

  // ---- aggregation（SC-22/23/24；M-1 完整形态）----
  const perDimension = dimensionKeys.map((key) => {
    const values: number[] = []
    for (const entry of usable) {
      const items = asObject(entry.scorecard.items) ?? {}
      const item = asObject(items[key])
      const value = item?.score
      if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
    }
    const denominator = submitted
    const excluded = requiredTotal - denominator
    return {
      dimension_key: key,
      ...(values.length === 0
        ? {}
        : { mean: round4(values.reduce((sum, value) => sum + value, 0) / values.length) }),
      denominator,
      excluded,
      values,
    }
  })

  let average: number | null = null
  let averageRefusedReason: 'MISSING_SCORES' | 'NO_SUBMITTED_SCORECARD' | undefined
  if (missingCount > 0) {
    averageRefusedReason = 'MISSING_SCORES'
  } else if (submitted === 0) {
    averageRefusedReason = 'NO_SUBMITTED_SCORECARD'
  } else {
    const means = perDimension
      .map((entry) => (typeof entry.mean === 'number' ? entry.mean : null))
      .filter((value): value is number => value !== null)
    // 偏差 4：M-1 的 ⇔ 要求此处非 null；没有任何数值分时用 0 表达“无可用数值”。
    average = means.length === 0
      ? 0
      : round4(means.reduce((sum, value) => sum + value, 0) / means.length)
  }
  const method = submitted === 0 ? 'NOT_COMPUTED' : 'PER_DIMENSION_SUBMITTED_ONLY'
  const aggregation = {
    method,
    average,
    ...(averageRefusedReason === undefined ? {} : { average_refused_reason: averageRefusedReason }),
    per_dimension: perDimension,
  }

  // ---- record（DC-23）----
  const recordResult = interviewIds.length === 0
    ? { rows: [] as RecordRow[] }
    : await client.query<RecordRow>(RECORD_SQL, [tenantId, interviewIds])
  const records = [...recordResult.rows]
  const recordByInterview = new Map<string, RecordRow>()
  for (const record of records) recordByInterview.set(record.interview_id, record)
  const orderedRecords = interviews
    .map((interview) => recordByInterview.get(interview.id))
    .filter((record): record is RecordRow => record !== undefined)
  const chosenRecord = orderedRecords[0]
  let recordState: 'READY' | 'NOT_READY' | 'ABSENT' | 'NOT_CITED'
  if (orderedRecords.length === 0) {
    recordState = 'ABSENT'
  } else if (orderedRecords.some((record) => record.status !== 'READY')) {
    recordState = 'NOT_READY'
  } else if (orderedRecords.some((record) => record.verification_status !== 'VERIFIED')) {
    recordState = 'NOT_CITED'
  } else {
    recordState = 'READY'
  }
  const record = {
    state: recordState,
    ...(chosenRecord === undefined
      ? {}
      : {
          interview_record_id: chosenRecord.id,
          verification_status: chosenRecord.verification_status,
        }),
  }

  // ---- 部门招聘负责人（DC-15 的 warning）----
  const departmentResult = await client.query<{ hiring_manager_actor_id: string | null }>(
    DEPARTMENT_SQL, [tenantId, app.job_id],
  )
  const hiringManagerUnset = departmentResult.rows[0]?.hiring_manager_actor_id == null

  // ---- 人工队列（只认 WAITING_HUMAN；DC §12 ⑨）----
  const taskResult = await client.query<TaskRow>(HUMAN_TASK_SQL, [tenantId])
  const referencedIds = new Set<string>([
    app.id,
    ...interviewIds,
    ...interviewerRows.map((row) => row.id),
    ...scorecards.map((scorecard) => scorecard.id),
  ])
  const openTaskIds: string[] = []
  for (const task of taskResult.rows) {
    if (businessRefsMatch(task.business_refs, referencedIds)) openTaskIds.push(task.id)
  }

  // ---- 当前决策（ALREADY_DECIDED + brief 的来源，DC-41）----
  const decisionResult = args.decision_scope === 'STAGE'
    ? await client.query<DecisionRow>(STAGE_DECISION_SQL, [tenantId, app.id, args.interview_id as string])
    : await client.query<DecisionRow>(FINAL_DECISION_SQL, [tenantId, app.id])
  const currentDecision = decisionResult.rows[0]

  // ---- provenance（TC §1.3；只贴标签，不因 FIXTURE 改判）----
  const provenance = await computeProvenance(client, tenantId, app, interviewIds)

  // ---- blockers（TC §3.5 封闭集；顺序固定，digest 取 code）----
  const blockers: Record<string, unknown>[] = []
  if (currentDecision !== undefined) {
    blockers.push({
      code: 'ALREADY_DECIDED',
      family: 'STATE',
      blocks_results: [...BASE_PERMITTED_RESULTS],
      blocks_all: true,
      detail: { decision_id: currentDecision.id, record_version: currentDecision.record_version },
    })
  }
  if (openTaskIds.length > 0) {
    blockers.push({
      code: 'OPEN_REVIEW_TASK',
      family: 'QUEUE',
      blocks_results: [...BASE_PERMITTED_RESULTS],
      blocks_all: true,
      detail: { task_ids: openTaskIds, task_count: openTaskIds.length },
    })
  }
  if (missingCount > 0) {
    blockers.push({
      code: 'SCORECARD_MISSING',
      family: 'COVERAGE',
      blocks_results: args.decision_scope === 'FINAL'
        ? ['ADVANCE', 'REJECT', 'HIRED']
        : ['REJECT', 'HIRED'],
      blocks_all: false,
      detail: { missing_count: missingCount },
    })
  }
  if (submitted === 0) {
    blockers.push({
      code: 'NO_SUBMITTED_SCORECARD',
      family: 'EVIDENCE',
      blocks_results: ['ADVANCE', 'REJECT', 'HIRED'],
      blocks_all: false,
      detail: { submitted: 0, waived },
    })
  }
  if (unusable > 0) {
    blockers.push({
      code: 'SCORECARD_UNUSABLE',
      family: 'COVERAGE',
      blocks_results: ['REJECT', 'HIRED'],
      blocks_all: false,
      detail: { unusable, scorecard_ids: invalidRequiredIds },
    })
  }
  if (unreadableDimensions.length > 0) {
    blockers.push({
      code: 'UNREADABLE_NOT_RESOLVED',
      family: 'EVIDENCE',
      blocks_results: ['REJECT'],
      blocks_all: false,
      detail: {
        dimensions: unreadableDimensions,
        dimension_count: unreadableDimensions.length,
      },
    })
  }
  if (missingCount === 0 && submitted > 0 && tally.reject === 0) {
    blockers.push({
      code: 'NO_REJECTING_SCORECARD',
      family: 'EVIDENCE',
      blocks_results: ['REJECT'],
      blocks_all: false,
      detail: { submitted, reject: 0 },
    })
  }

  const permittedResults = BASE_PERMITTED_RESULTS.filter(
    (result) => !blockers.some(
      (blocker) => (blocker.blocks_results as string[]).includes(result),
    ),
  )
  const readyForDecision = missingCount === 0
    && submitted >= 1
    && !blockers.some((blocker) => blocker.blocks_all === true)

  const blockerCodeSet = new Set(blockers.map((blocker) => blocker.code as string))
  let requiredHumanAction: string
  if (blockerCodeSet.has('ALREADY_DECIDED')) requiredHumanAction = 'SUPERSEDE_EXISTING_DECISION'
  else if (blockerCodeSet.has('OPEN_REVIEW_TASK')) requiredHumanAction = 'RESOLVE_BLOCKER'
  else if (blockerCodeSet.has('SCORECARD_UNUSABLE') || blockerCodeSet.has('UNREADABLE_NOT_RESOLVED')) {
    requiredHumanAction = 'RESOLVE_UNREADABLE'
  } else if (blockerCodeSet.has('SCORECARD_MISSING')) requiredHumanAction = 'CHASE_SCORECARD'
  else if (blockerCodeSet.has('NO_SUBMITTED_SCORECARD') || blockerCodeSet.has('NO_REJECTING_SCORECARD')) {
    requiredHumanAction = 'RESOLVE_BLOCKER'
  } else requiredHumanAction = 'CONFIRM_DECISION'

  // ---- snapshot + digest（DC-20）----
  const sortedScorecards = [...scorecards].sort((left, right) => {
    const byInterviewer = left.interviewer_id.localeCompare(right.interviewer_id)
    return byInterviewer !== 0 ? byInterviewer : left.id.localeCompare(right.id)
  })
  const snapshot = {
    application_record_version: app.record_version,
    rubric_version_id: rubric.id,
    rubric_payload_hash: rubric.payload_hash,
    scorecard_ids: sortedScorecards.map((scorecard) => scorecard.id),
  }
  const summaryDigest = summaryDigestOf({
    as_of: args.as_of,
    application_id: app.id,
    decision_scope: args.decision_scope,
    interview_id: args.interview_id ?? null,
    rubric_version_id: rubric.id,
    rubric_payload_hash: rubric.payload_hash,
    scorecards: sortedScorecards.map((scorecard) => ({
      id: scorecard.id,
      revision_no: scorecard.revision_no,
      interviewer_id: scorecard.interviewer_id,
      payload_hash: scorecard.payload_hash,
      status: scorecard.status,
    })),
    record: {
      id: chosenRecord?.id ?? null,
      revision: chosenRecord?.record_version ?? null,
      verification_status: chosenRecord?.verification_status ?? null,
    },
    coverage,
    tally,
    missing,
    blockers: blockers.map((blocker) => ({ code: blocker.code as string })),
  })

  // ---- warnings（DC §3.3 封闭集；只提示、不改门禁）----
  const warnings: Record<string, unknown>[] = []
  if (missingCount > 0) {
    warnings.push({
      code: 'PARTIAL_PANEL',
      message: `${requiredTotal} 人必交面板，已交 ${submitted}、豁免 ${waived}、缺 ${missingCount}；标签是 PARTIAL_PANEL`,
    })
  }
  if (minorityReports.length > 0) {
    warnings.push({
      code: 'MINORITY_DISSENT',
      message: `${minorityReports.length} 份面评与 consensus 方向相反（原文见 minority_reports）`,
    })
  }
  if (waived > 0) {
    warnings.push({
      code: 'SCORECARD_WAIVED',
      message: `${waived} 份必填面评已豁免；豁免不等于有分`,
      detail: {
        waivers: waivedRows.map((entry) => ({
          scorecard_id: entry.scorecard.id,
          interviewer_id: entry.interviewer.id,
          waive_reason: entry.scorecard.waive_reason ?? '',
        })),
      },
    })
  }
  if (shapeInvalid.length > 0) {
    warnings.push({
      code: 'SCORECARD_SHAPE_INVALID',
      message: `${shapeInvalid.length} 份面评的 items/overall 形状不合法，已从 tally 剔除`,
      detail: {
        scorecards: shapeInvalid.map((entry) => ({
          scorecard_id: entry.scorecard.id,
          interviewer_id: entry.interviewer.id,
          violations: [...entry.violations],
        })),
      },
    })
  }
  if (recordState === 'NOT_READY') {
    warnings.push({
      code: 'RECORD_NOT_READY',
      message: '面试记录尚未 READY；不阻塞决策，但不得作为决策依据',
    })
  }
  if (hiringManagerUnset) {
    warnings.push({
      code: 'HIRING_MANAGER_UNSET',
      message: '该部门的 hiring_manager_actor_id 为空，招聘负责人只能记为未设置',
    })
  }
  if (provenance === 'FIXTURE') {
    warnings.push({
      code: 'FIXTURE_BASIS',
      message: '本次汇总的链路标记为 FIXTURE，结论只可用于演练，不可当作真实业务事实',
    })
  }

  // ---- brief（DC-41..46；派生不落表、无自由文本、带 digest）----
  let brief: Record<string, unknown> | null = null
  let briefAbsence: { code: string } | undefined
  if (currentDecision === undefined) {
    briefAbsence = { code: 'NO_DECISION' }
  } else if (currentDecision.result !== 'ADVANCE') {
    briefAbsence = { code: 'NOT_ADVANCED' }
  } else if (args.decision_scope === 'FINAL') {
    briefAbsence = { code: 'FINAL_SCOPE' }
  } else {
    const selectedInterview = interviews[0] as InterviewRow
    const carryOver: Record<string, unknown>[] = []
    for (const entry of usable) {
      const items = asObject(entry.scorecard.items) ?? {}
      for (const key of dimensionKeys) {
        const item = asObject(items[key])
        const assessment = item?.assessment
        if (assessment === 'NOT_OBSERVED' || assessment === 'UNREADABLE') {
          carryOver.push({
            dimension_key: key,
            scorecard_id: entry.scorecard.id,
            assessment,
          })
        }
      }
    }
    carryOver.sort((left, right) => {
      const byDimension = (left.dimension_key as string).localeCompare(right.dimension_key as string)
      return byDimension !== 0
        ? byDimension
        : (left.scorecard_id as string).localeCompare(right.scorecard_id as string)
    })

    const unansweredQuestions: Record<string, unknown>[] = []
    for (const dimension of dimensions) {
      const object = asObject(dimension)
      const key = object?.key
      const question = object?.question
      if (!isNonEmptyString(key) || !isNonEmptyString(question)) continue
      const hasNote = usable.some((entry) => {
        const items = asObject(entry.scorecard.items) ?? {}
        const item = asObject(items[key])
        return isNonEmptyString(item?.note)
      })
      if (!hasNote) unansweredQuestions.push({ dimension_key: key, question })
    }

    const evidenceRefs: Record<string, unknown>[] = []
    if (recordState === 'READY' && chosenRecord !== undefined) {
      const sections = asObject(chosenRecord.sections)
      if (sections !== null) {
        for (const sectionKey of Object.keys(sections).sort((left, right) => left.localeCompare(right))) {
          evidenceRefs.push({
            interview_record_id: chosenRecord.id,
            section_key: sectionKey,
          })
        }
      }
    }

    const derivedFrom = {
      decision_id: currentDecision.id,
      summary_digest: summaryDigest,
      rubric_version_id: rubric.id,
      interview_ids: [selectedInterview.id],
    }
    const briefBody = {
      next_round: { round_no: selectedInterview.round_no + 1 },
      carry_over: carryOver,
      unanswered_questions: unansweredQuestions,
      absent_interviewers: missing,
      evidence_refs: evidenceRefs,
      derived_from: derivedFrom,
    }
    brief = { ...briefBody, brief_digest: digestOf(briefBody) }
  }

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    advisory: true,
    read_only: true,
    as_of: args.as_of,
    application_id: app.id,
    ...(args.interview_id === undefined ? {} : { interview_id: args.interview_id }),
    decision_scope: args.decision_scope,
    stage_code: STAGE_CODE,
    labels: {
      provenance,
      trigger: 'MANUAL',
      connection: 'CONNECTED',
    },
    rubric: {
      version_id: rubric.id,
      version_no: rubric.version_no,
      payload_hash: rubric.payload_hash,
      source: 'APPLICATION_PINNED',
    },
    coverage,
    missing,
    tally,
    consensus,
    consensus_scope: consensusScope,
    minority_reports: minorityReports,
    aggregation,
    record,
    ready_for_decision: readyForDecision,
    blockers,
    permitted_results: permittedResults,
    required_human_action: requiredHumanAction,
    warnings,
    snapshot,
    summary_digest: summaryDigest,
    brief,
    ...(briefAbsence === undefined ? {} : { brief_absence: briefAbsence }),
  }
}

/**
 * TC §1.3 的 provenance 判定式：
 * `LIVE` ⟺ 简历链 `resume_version → resume → intake_asset → intake_record → event_inbox`
 * 存在且 provider ≠ internal，且该场面试的 meeting（若有 binding）provider ≠ internal。
 * @returns `LIVE | FIXTURE`（只贴标签，不改判）。
 */
async function computeProvenance(
  client: DatabaseClient,
  tenantId: string,
  app: ApplicationRow,
  interviewIds: readonly string[],
): Promise<'LIVE' | 'FIXTURE'> {
  let resumeExternal = false
  if (app.resume_version_id !== null) {
    const { rows } = await client.query<{ provider: string }>(RESUME_PROVIDER_SQL, [
      tenantId, app.resume_version_id,
    ])
    const provider = rows[0]?.provider
    resumeExternal = typeof provider === 'string' && provider !== 'internal'
  }
  let meetingsExternal = true
  if (interviewIds.length > 0) {
    const { rows } = await client.query<{ binding_id: string | null; provider: string | null }>(
      MEETING_PROVIDER_SQL, [tenantId, interviewIds],
    )
    for (const row of rows) {
      if (row.binding_id === null) continue
      if (row.provider === null || row.provider === 'internal') {
        meetingsExternal = false
        break
      }
    }
  }
  return resumeExternal && meetingsExternal ? 'LIVE' : 'FIXTURE'
}

/** 递归判断 `business_refs` 里是否有 id 命中（形状未定，按值匹配）。 */
function businessRefsMatch(raw: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof raw === 'string') {
    if (ids.has(raw)) return true
    try {
      return businessRefsMatch(JSON.parse(raw), ids)
    } catch {
      return false
    }
  }
  if (Array.isArray(raw)) return raw.some((entry) => businessRefsMatch(entry, ids))
  if (isObject(raw)) return Object.values(raw).some((value) => businessRefsMatch(value, ids))
  return false
}

// =====================================================================
//  工具定义
// =====================================================================

/**
 * 造一个绑定配置的只读汇总工具。
 * @param deps - `database` 已解析（`src/index.ts` 负责 NOT_CONFIGURED 分支）。
 */
export function createEvaluationSummarizeTool(
  deps: { readonly database: ResolvedDatabaseConfig },
): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S10 advisory evaluation summary for ONE application (read-only projection, advisory=true, '
      + 'never writes a decision). Reads the application-pinned rubric and the current SUBMITTED/WAIVED '
      + 'scorecards of the required interviewers (STAGE: one interview; FINAL: all interviews), '
      + 're-validates the scorecard items shape, and returns coverage / tally / consensus / blockers / '
      + 'permitted_results / summary_digest / next-round brief. as_of is required and echoed verbatim. '
      + 'Runs inside a read-only transaction. Errors are INVALID_ARGS / NOT_FOUND / SCORECARD_MISSING.',
    parameters: toParameterSchema(SCHEMA_PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const summary = value as Record<string, unknown>
        const coverage = summary.coverage as Record<string, number>
        const tally = summary.tally as Record<string, number>
        const aggregation = summary.aggregation as Record<string, unknown>
        const record = summary.record as Record<string, unknown>
        const blockers = summary.blockers as readonly Record<string, unknown>[]
        const permitted = summary.permitted_results as readonly string[]
        const warnings = summary.warnings as readonly Record<string, unknown>[]
        const lines: string[] = [
          'S10 汇总投影（只读，不代决）',
          `${String(summary.tool)} ${String(summary.contract_version)} `
            + `advisory=${String(summary.advisory)} read_only=${String(summary.read_only)} `
            + `as_of=${String(summary.as_of)}`,
          `scope=${String(summary.decision_scope)} stage=${String(summary.stage_code)} `
            + `rubric=v${String((summary.rubric as Record<string, unknown>).version_no)} `
            + `source=${String((summary.rubric as Record<string, unknown>).source)}`,
          `coverage: required=${coverage.required_total} submitted=${coverage.submitted} `
            + `waived=${coverage.waived} missing=${coverage.missing} unusable=${coverage.unusable} `
            + `not_required=${coverage.not_required} overdue=${coverage.overdue} `
            + `completion=${coverage.completion_ratio}`,
          `missing: ${(summary.missing as readonly unknown[]).length} 人`,
          `tally: advance=${tally.advance} hold=${tally.hold} reject=${tally.reject} waived=${tally.waived}`,
          `consensus: ${String(summary.consensus)} (${String(summary.consensus_scope)})`,
          `minority_reports: ${(summary.minority_reports as readonly unknown[]).length}`,
          `aggregation: method=${String(aggregation.method)} average=${String(aggregation.average)}`
            + `${aggregation.average_refused_reason === undefined
              ? ''
              : ` refused=${String(aggregation.average_refused_reason)}`}`,
          `record: state=${String(record.state)}`,
          `ready_for_decision=${String(summary.ready_for_decision)}`,
          `permitted_results: [${permitted.join(', ')}]`,
          `blockers: ${blockers.length}`,
        ]
        for (const blocker of blockers) {
          lines.push(
            `  - ${String(blocker.code)} family=${String(blocker.family)} `
            + `blocks=[${(blocker.blocks_results as readonly string[]).join(', ')}]`,
          )
        }
        lines.push(`required_human_action: ${String(summary.required_human_action)}`)
        lines.push(`warnings: ${warnings.length}`)
        for (const warning of warnings) lines.push(`  - ${String(warning.code)}`)
        lines.push(`summary_digest=${String(summary.summary_digest)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const pool = createPool(deps.database)
      try {
        return await withReadOnly(pool, async (client) => {
          // 汇总也要**可追责的调用身份**：`computeEvaluationSummaryIn` 从 GUC 读 actor
          // （DESIGN §3.5①）。只读事务里 `set_config(..., true)` 是事务局部的 SET LOCAL，
          // 不写任何表，因此不破坏"只读"这条性质（库层仍用 read-only transaction 兜底）。
          // 少了这一步，真实 headless 调用会在第一步就 `ACTOR_REQUIRED`——集成实测踩到过。
          await client.query("select set_config('recruitment.actor_id', $1, true)", [deps.database.actor_id])
          return await computeEvaluationSummaryIn(client, deps.database, rawArgs, Date.now())
        })
      } finally {
        await closePool(pool)
      }
    },
  }
}

/** 汇总投影的类型（形状 = DC §3.2 的 JSON；decision_record 只 import 这一个类型）。 */
export type EvaluationSummary = Record<string, unknown>
