// recruitment_scorecard_submit —— S10「面评提交」（**写** scorecard 一行）。
//
// 契约（权威，冲突时以它们为准）：
//   * `contracts/evaluation/scorecard-rules.md`（下称 SC）
//   * `contracts/evaluation/tool-contracts.md`（下称 TC，本文件照 §1 / §2 / §5 / §7）
//   * `contracts/interview/transcript-rules.md` 的 TR-E2 / TR-E3（`transcript_basis` 保留键与 `SEGMENT`）
//   * `manual/evaluation-line/DESIGN.md`（§2 错误形状、§3.5 三条精确口径、§4 库缺口 G-1/G-2/G-3）
//
// 本文件逐条负责：
//   SC-01/02/03/05  作者 = 事务里 `recruitment.actor_id` GUC；必须存在 interviewer 行；必须 HUMAN；
//                   入参**没有**"作者"这个字段（结构上无法代填）
//   SC-04           一人一场一份 current：已有 SUBMITTED/WAIVED 当前行且未带 revision → ALREADY_SUBMITTED
//   SC-06/07/08     轮次只经 interview 得到并回显；CANCELLED / NO_SHOW 不得产生新的 SUBMITTED
//   SC-09/10/11/47  rubric 三绑定：申请钉住的优先（APPLICATION_PINNED）；未钉必须显式给
//                   （EXPLICIT_VERSION_ID）；给了就必须等于钉住的；且必须属于该申请的岗位
//   SC-12/13        `items` 是对象；键集恰好 = `dimensions[].key` ∪ {transcript_basis}；维度上限 50
//   SC-14/15/16     `submitted_at` 服务端取时钟，与 `created_at` 同一次写入同值；回显面试计划时间
//   SC-17..20       提交后不可改；修订 = 新行 `revision_no + 1` + 旧行指针（三步舞，§5.2）
//   SC-26           本工具只产 `SUBMITTED`，不接受 `status`（WAIVED 走独立人工命令）
//   SC-29..33       REJECT 理由三字段 + 必须由 `NOT_MET` 支撑；ADVANCE 不得含未评维度且每条 MET 有依据
//   SC-37/38/39/40  幂等键 + `payload_hash` + 修订乐观并发 + `record_version` 由库自增
//   SC-44/45        终态行必须自带 actor + 内部事件（先插 `event_inbox`）；PENDING 原地转正
//   SC-46           `required_scorecard=false` 的旁听者也能交（筹码不进分母是 summarize 的事）
//   TC §1.3         `labels.provenance` 按判定式算（`resume_version → resume → intake_asset →
//                   intake_record → event_inbox.provider <> 'internal'`，且该场面试的活动 meeting
//                   `provider <> 'internal'`），否则 FIXTURE；不因 FIXTURE 改判
//   TC §2.2/§2.6    出参形状 + `warnings[]` 封闭集
//
// 已知偏差（全部登记在此，交付说明里逐条回传）：
//   1. **`ACTOR_REQUIRED`**：TC §5.1 的封闭集里没有这个 reason_code，但"执行上下文没有 actor"必须
//      fail-closed（DESIGN §3.5 ① 已登记）。
//   2. **`AS_OF_*` 不适用**：本工具没有 `as_of` 入参（DESIGN §2 的格式码偏差只影响 summarize/record）；
//      传 `as_of` 就是 `INVALID_ARGS(UNKNOWN_PARAM)`。
//   3. **G-1 / G-2 落库**：`scorecard` 无 `reject_reasons` / `revision_reason` / `idempotency_key` 列 →
//      前两者写进 `rationale` 固定格式（见 `buildRationale`），幂等键落 `event_inbox`。
//   4. **输出里不写 null**（全仓口径，DSH 校验器不支持 `type` 数组）：`superseded` 在"没有旧行"时
//      **省略键**（TC §2.2 画成 `null`）；`interview.scheduled_start_at` 在库里为 null 时也省略键。
//   5. **修订新行的 `record_version` 是库里的真实值**：三步舞第 3 步（清空指针）会触发 `fn_row_guard`
//      把 `record_version` 抬到 2；TC §2.2 的样例 `record_version: 1` 是"干净 INSERT"的形状。
//   6. **PENDING 原地转正不产生新 id** → `superseded` 省略（TC §2.2 只定义了"新行"口径）；
//      转正时若该 PENDING 行的 `rubric_version_id` 与解析出的 rubric 不一致 → `RUBRIC_MISMATCH`（fail-closed）。
//   7. **PENDING 当前行不带 `revision` 也允许原地转正**：SC-04 的 `ALREADY_SUBMITTED` 只覆盖
//      `SUBMITTED`/`WAIVED`，而 TC §2.5 要求历史 PENDING 行"必须原地转正"——否则这行永远交不上来。
//   8. **重放时 `event_inbox` 指向的 scorecard 行不存在**（`scorecard` 在禁删清单里，正常不可达）→
//      `NOT_FOUND(SCORECARD_NOT_FOUND)`，fail-closed，不猜。
//   9. **`reject_reasons[]` 里同一个 `dimension_key` 出现两次** → `INVALID_ARGS(DIMENSION_DUPLICATED)`
//      （TC §1.1 第 6 条"重复元素拒绝"；S- 组里唯一表达"重复"的码；`items` 是对象，维度键不可能重复）。
//  10. **`DB_CONSTRAINT_VIOLATION` 的 `constraint` 只在库真的给了约束名时出现**（PL/pgSQL `raise`
//      不带 `constraint` 时 `error.constraint` 为空，编一个名字等于伪造证据）。
//
// 不打印 PII：日志与错误 detail 只放 UUID、计数、键名（R7）。

import { randomUUID } from 'node:crypto'

import { canonicalJson, digestOf, isUuid } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { closePool, createPool, withActor, type DatabaseClient, type ResolvedDatabaseConfig } from '../db/pool.ts'

const TOOL_NAME = 'recruitment_scorecard_submit'
const CONTRACT_VERSION = '2.0.0'

/** `items` 的保留键（TR-E2）：它与维度 key 同名是**非法**的。 */
const TRANSCRIPT_BASIS_KEY = 'transcript_basis'
/** `rationale` 里 `reject_reasons` 的固定前缀（DESIGN §3.5 ②，G-1）。 */
const REJECT_REASONS_MARKER = 'REJECT_REASONS_JSON: '
/** 修订原因的首行前缀（SC-19）。 */
const REVISION_REASON_PREFIX = '修订原因：'

const ASSESSMENTS = ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'] as const
const OVERALLS = ['ADVANCE', 'HOLD', 'REJECT'] as const
const TRANSCRIPT_BASES = ['TRANSCRIPT', 'NO_TRANSCRIPT'] as const
/** `evidence[].kind` 只有一种（D-74 / TR-E3）：`TRANSCRIPT_SEGMENT` 已作废。 */
const EVIDENCE_KINDS = ['SEGMENT'] as const
const EVIDENCE_STATES = ['MEMORY_ONLY'] as const
const WARNING_CODES = ['NO_TIMESTAMPED_EVIDENCE', 'FIXTURE_BASIS', 'RUBRIC_EXPLICIT_NOT_PINNED'] as const
const RUBRIC_RESOLUTIONS = ['APPLICATION_PINNED', 'EXPLICIT_VERSION_ID'] as const
/** 面试状态里不允许新增面评的两个（SC-08）。 */
const BLOCKED_INTERVIEW_STATUSES = ['CANCELLED', 'NO_SHOW'] as const

/** `R-VAL-1` 的 dimensions 上限，**本工具不另设更小的常数**（SC-13 / TC §2.1）。 */
const MAX_DIMENSIONS = 50
const MAX_EVIDENCE_PER_ITEM = 20
const MAX_REJECT_REASONS = 10
const MAX_NOTE_LENGTH = 2000
const MAX_QUOTE_LENGTH = 1000
const MAX_REASON_TEXT_LENGTH = 1000
const MAX_IDEMPOTENCY_KEY_LENGTH = 128
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{1,128}$/

/**
 * 保留键（TC §1.6）：**声明在 schema 里，但一律拒收**，报
 * `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)`。
 */
const RESERVED_PARAM_KEYS = [
  'tenant_id', 'actor_id', 'interviewer_id', 'round_no', 'slot_code', 'submitted_at', 'status', 'stage_code',
] as const

/** 声明过的全部键（未知键的错误里列这个）。 */
const DECLARED_PARAM_KEYS = [
  'interview_id', 'rubric_version_id', 'items', 'overall', 'reject_reasons', 'revision', 'idempotency_key',
  ...RESERVED_PARAM_KEYS,
] as const

// =====================================================================
//  错误形状（TC §1.2；DESIGN §2 的局部构造器，刻意不 import 其它 S10 文件）
// =====================================================================

/** S10 三个工具共用的错误码（`src/tools/errors.ts` 的联合不含它们，且不在写范围）。 */
export type EvaluationErrorCode =
  | 'INVALID_ARGS' | 'NOT_FOUND' | 'NOT_CONFIGURED'
  | 'INTERVIEWER_MISMATCH' | 'ALREADY_SUBMITTED' | 'VERSION_CONFLICT'
  | 'EVIDENCE_INSUFFICIENT' | 'SCORECARD_MISSING' | 'BLOCKED_BY_REVIEW'
  | 'DECISION_REQUIRES_HUMAN' | 'ALREADY_DECIDED' | 'DB_CONSTRAINT_VIOLATION'

/**
 * 造一个 `Error: <CODE>: <compact-json>` 形态的错误（键序 code → reason_code → message → detail）。
 * @param code - 稳定错误码（同时是消息前缀）。
 * @param reasonCode - 该 code 下的封闭枚举取值（TC §5）。
 * @param message - 一句给人看的中文说明。
 * @param detail - 结构化明细；没有就省略这个键（禁止用 null 占位）。
 */
export function evalError(
  code: EvaluationErrorCode,
  reasonCode: string,
  message: string,
  detail?: unknown,
): Error {
  const body: Record<string, unknown> = { code, reason_code: reasonCode, message }
  if (detail !== undefined) body.detail = detail
  // `RecruitmentToolError` 的 `code` 运行期就是传入值（`this.code = code`），但联合类型不含 S10 的码。
  return new RecruitmentToolError(code as never, canonicalJson(body))
}

// =====================================================================
//  入参 / 出参的 JSON Schema（只用官方受支持的子集：type/properties/required/
//  additionalProperties/items/enum/description；**没有** type 数组与 type:'null'）
// =====================================================================

const EVIDENCE_PARAM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    '一条时间戳证据。kind 只能是 SEGMENT（TRANSCRIPT_SEGMENT 已作废）；quote 必须是转写原文片段。',
  properties: {
    kind: { type: 'string', enum: [...EVIDENCE_KINDS], description: '只有 SEGMENT' },
    transcript_artifact_id: { type: 'string', description: 'canonical transcript artifact id（UUID）' },
    transcript_revision: { type: 'integer', description: 'artifact 的 source_revision（>=1）' },
    segment_id: { type: 'string', description: 'transcript_segment id（UUID）' },
    quote: { type: 'string', description: `转写原文片段（1..${MAX_QUOTE_LENGTH} 字）` },
  },
  required: ['kind', 'transcript_artifact_id', 'transcript_revision', 'segment_id', 'quote'],
  additionalProperties: false,
}

const REJECT_REASON_PARAM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description: '一条"不通过"的具体理由：哪一维、看到了什么、为什么决定性。',
  properties: {
    dimension_key: { type: 'string', description: '必须是 items 里的一个维度键，且该维 assessment=NOT_MET' },
    observation: { type: 'string', description: `现场观察到的具体表现（1..${MAX_REASON_TEXT_LENGTH} 字）` },
    why_decisive: { type: 'string', description: `为什么这一项是决定性的（1..${MAX_REASON_TEXT_LENGTH} 字）` },
    evidence: { type: 'array', description: '可空；有则每条同 items 的证据形状', items: EVIDENCE_PARAM_SCHEMA },
    evidence_state: {
      type: 'string',
      enum: [...EVIDENCE_STATES],
      description: 'evidence 为空时必填 MEMORY_ONLY（显式承认凭现场记忆，没有时间戳证据）',
    },
  },
  required: ['dimension_key', 'observation', 'why_decisive'],
  additionalProperties: false,
}

/** 工具入参（对象根，显式 `additionalProperties:false`；保留键声明但一律拒收）。 */
const SUBMIT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    interview_id: {
      type: 'string',
      description:
        '面评归属的面试（UUID）。轮次（round_no / slot_code）由它决定并回显，**不接受**入参传轮次。',
    },
    rubric_version_id: {
      type: 'string',
      description:
        '评分标准版本（UUID）。仅当申请没有钉住 rubric 时必须给（否则 RUBRIC_UNRESOLVED）；'
        + '给了但与申请钉住的不一致 → RUBRIC_MISMATCH；版本必须属于该申请的岗位（RUBRIC_NOT_OF_JOB）。',
    },
    items: {
      type: 'object',
      description:
        '逐维度评价。**对象**，不是数组：键 = rubric 的 dimensions[].key（恰好覆盖，缺一维即 DIMENSION_COVERAGE_INCOMPLETE）'
        + ' ∪ {"transcript_basis"}（保留键，必填 TRANSCRIPT|NO_TRANSCRIPT）。'
        + '每个维度对象：assessment（MET|NOT_MET|NOT_OBSERVED|UNREADABLE，必填）、'
        + 'score（仅在 MET|NOT_MET 时允许 1..5；NOT_OBSERVED|UNREADABLE 必须缺省或 null）、'
        + `note（${MAX_NOTE_LENGTH} 字以内；NOT_MET 时必填）、evidence[]（最多 ${MAX_EVIDENCE_PER_ITEM} 条）。`,
      properties: {
        transcript_basis: {
          type: 'string',
          enum: [...TRANSCRIPT_BASES],
          description:
            '保留键，必填。该场面试的 canonical transcript 已 READY 时必须 TRANSCRIPT，否则必须 NO_TRANSCRIPT；'
            + '不一致 → TRANSCRIPT_BASIS_CONFLICT；缺 → TRANSCRIPT_BASIS_MISSING。',
        },
      },
      required: [TRANSCRIPT_BASIS_KEY],
    },
    overall: {
      type: 'string',
      enum: [...OVERALLS],
      description:
        '一句话结论。ADVANCE：不得含 NOT_OBSERVED/UNREADABLE，且每条 MET 至少带 note 或 evidence；'
        + 'REJECT：reject_reasons[] 必须 1..10 条且每条落到 NOT_MET 维度上。',
    },
    reject_reasons: {
      type: 'array',
      description: `overall=REJECT 时必填 1..${MAX_REJECT_REASONS} 条；其余可空。`,
      items: REJECT_REASON_PARAM_SCHEMA,
    },
    revision: {
      type: 'object',
      description:
        '修订（可选）：把已有当前面评换成新的一行。三字段全必填，少一个 → REVISION_FIELDS_INCOMPLETE。'
        + '写入顺序由工具保证（反向插 → 换指针 → 清空）。',
      properties: {
        supersedes_scorecard_id: { type: 'string', description: '必须是**当前**行（UUID），否则 SCORECARD_ALREADY_SUPERSEDED' },
        expected_record_version: { type: 'integer', description: '旧行的 record_version；不匹配 → VERSION_CONFLICT' },
        revision_reason: { type: 'string', description: '为什么改（非空，写进新行 rationale 首行）' },
      },
      required: ['supersedes_scorecard_id', 'expected_record_version', 'revision_reason'],
      additionalProperties: false,
    },
    idempotency_key: {
      type: 'string',
      description:
        '幂等键（1..128，^[A-Za-z0-9:_-]{1,128}$）。同 key + 同 payload → 返回原结果（replayed=true，不新增行）；'
        + '同 key + 不同 payload → IDEMPOTENCY_KEY_REUSED。',
    },
    tenant_id: { type: 'string', description: '**拒收**：租户只从执行上下文取（TENANT_OR_ACTOR_NOT_ALLOWED）' },
    actor_id: { type: 'string', description: '**拒收**：作者只从执行上下文取（SC-01/SC-05）' },
    interviewer_id: { type: 'string', description: '**拒收**：作者只从执行上下文取（SC-01/SC-05）' },
    round_no: { type: 'integer', description: '**拒收**：轮次由 interview_id 决定（SC-07）' },
    slot_code: { type: 'string', description: '**拒收**：轮次由 interview_id 决定（SC-07）' },
    submitted_at: { type: 'string', description: '**拒收**：时间由服务端取（SC-14）' },
    status: { type: 'string', description: '**拒收**：本工具只产 SUBMITTED（SC-26）' },
    stage_code: { type: 'string', description: '**拒收**：阶段码只由工具写（DC-07）' },
  },
  required: ['interview_id', 'items', 'overall', 'idempotency_key'],
  additionalProperties: false,
}

const SCORECARD_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    revision_no: { type: 'integer' },
    status: { type: 'string', enum: ['SUBMITTED'] },
    interview_id: { type: 'string' },
    interviewer_id: { type: 'string' },
    actor_id: { type: 'string' },
    rubric_version_id: { type: 'string' },
    rubric_payload_hash: { type: 'string' },
    rubric_resolution: { type: 'string', enum: [...RUBRIC_RESOLUTIONS] },
    transcript_basis: { type: 'string', enum: [...TRANSCRIPT_BASES] },
    payload_hash: { type: 'string' },
    submitted_at: { type: 'string' },
    status_changed_by_actor_id: { type: 'string' },
    status_source_event_id: { type: 'string' },
    record_version: { type: 'integer' },
  },
  required: [
    'id', 'revision_no', 'status', 'interview_id', 'interviewer_id', 'actor_id', 'rubric_version_id',
    'rubric_payload_hash', 'rubric_resolution', 'transcript_basis', 'payload_hash', 'submitted_at',
    'status_changed_by_actor_id', 'status_source_event_id', 'record_version',
  ],
  additionalProperties: false,
}

/** 规范输出（TC §2.2 的完整形状；`null` 一律改为省略键）。 */
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
    scorecard: SCORECARD_OUTPUT_SCHEMA,
    interview: {
      type: 'object',
      properties: {
        round_no: { type: 'integer' },
        slot_code: { type: 'string' },
        scheduled_start_at: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['round_no', 'slot_code', 'status'],
      additionalProperties: false,
    },
    coverage: {
      type: 'object',
      properties: {
        dimensions_total: { type: 'integer' },
        dimensions_assessed: { type: 'integer' },
        by_assessment: {
          type: 'object',
          properties: {
            met: { type: 'integer' },
            not_met: { type: 'integer' },
            not_observed: { type: 'integer' },
            unreadable: { type: 'integer' },
          },
          required: ['met', 'not_met', 'not_observed', 'unreadable'],
          additionalProperties: false,
        },
      },
      required: ['dimensions_total', 'dimensions_assessed', 'by_assessment'],
      additionalProperties: false,
    },
    superseded: {
      type: 'object',
      description: '只有"修订产生新行"时才出现；没有旧行时省略这个键（不是 null）。',
      properties: {
        scorecard_id: { type: 'string' },
        revision_no: { type: 'integer' },
      },
      required: ['scorecard_id', 'revision_no'],
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
  required: ['tool', 'contract_version', 'status', 'replayed', 'labels', 'scorecard', 'interview', 'coverage', 'warnings'],
  additionalProperties: false,
}

// =====================================================================
//  解析后的入参形状
// =====================================================================

/** 一条时间戳证据（TR-E3：kind 只有 SEGMENT）。 */
export interface ScorecardEvidence {
  readonly kind: 'SEGMENT'
  readonly transcript_artifact_id: string
  readonly transcript_revision: number
  readonly segment_id: string
  readonly quote: string
}

/** 一个维度的评价。 */
export interface ScorecardDimensionItem {
  readonly assessment: (typeof ASSESSMENTS)[number]
  readonly score?: number | null
  readonly note?: string | null
  readonly evidence?: readonly ScorecardEvidence[]
}

/** 一条拒绝理由（SC-29/30/31/32）。 */
export interface ScorecardRejectReason {
  readonly dimension_key: string
  readonly observation: string
  readonly why_decisive: string
  readonly evidence?: readonly ScorecardEvidence[]
  readonly evidence_state?: 'MEMORY_ONLY'
}

/** 修订对象（TC §2.5）。 */
export interface ScorecardRevision {
  readonly supersedes_scorecard_id: string
  readonly expected_record_version: number
  readonly revision_reason: string
}

/** 通过参数层校验后的入参（只含已声明的键）。 */
export interface ScorecardSubmitArgs {
  readonly interview_id: string
  readonly rubric_version_id?: string
  readonly items: Record<string, unknown>
  readonly overall: (typeof OVERALLS)[number]
  readonly reject_reasons?: readonly ScorecardRejectReason[]
  readonly revision?: ScorecardRevision
  readonly idempotency_key: string
}

/** 一条参数违反项（`detail.violations[]` 的元素）。 */
export interface ScorecardViolation {
  readonly reason_code: string
  readonly path: string
  readonly message: string
}

function has(input: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(input, key)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// =====================================================================
//  参数层校验（TC §1.1 八条：一次收集全部违反项）
// =====================================================================

/**
 * 校验并归一化入参。
 *
 * **一次收集全部违反项**（TC §1.1 第 7 条），顶层 `reason_code` = 第一条违反项。
 * @param rawArgs - 模型给的 arguments。
 * @returns 只含已声明键的入参。
 * @throws RecruitmentToolError - `INVALID_ARGS`，`detail = {allowed, violations[]}`。
 */
export function parseScorecardSubmitArgs(rawArgs: unknown): ScorecardSubmitArgs {
  const violations: ScorecardViolation[] = []
  const push = (reason_code: string, path: string, message: string): void => {
    violations.push({ reason_code, path, message })
  }

  if (!isPlainObject(rawArgs)) {
    throw violationsError([
      { reason_code: 'TYPE_MISMATCH', path: 'arguments', message: 'arguments 必须是 JSON 对象' },
    ])
  }
  const input = rawArgs

  // 1) 未知键（字典序）+ 2) 保留键（声明过但一律拒收，两种错误不能混成一个）。
  for (const key of Object.keys(input).sort()) {
    if (!(DECLARED_PARAM_KEYS as readonly string[]).includes(key)) {
      push('UNKNOWN_PARAM', key, `未声明的键 "${key}"（允许：${DECLARED_PARAM_KEYS.join(', ')}）`)
    }
  }
  for (const key of RESERVED_PARAM_KEYS) {
    if (has(input, key)) {
      push('TENANT_OR_ACTOR_NOT_ALLOWED', key, `${key} 只能来自执行上下文，不接受入参`)
    }
  }

  // 3) 必填
  for (const key of ['interview_id', 'items', 'overall', 'idempotency_key'] as const) {
    if (!has(input, key)) push('MISSING_REQUIRED', key, `缺必填参数 "${key}"`)
  }

  // interview_id
  const interviewId = input.interview_id
  if (has(input, 'interview_id')) {
    if (typeof interviewId !== 'string' || interviewId === '') {
      push('TYPE_MISMATCH', 'interview_id', '"interview_id" 必须是非空字符串')
    } else if (!isUuid(interviewId)) {
      push('ID_NOT_UUID', 'interview_id', '"interview_id" 必须是 UUID 文本')
    }
  }

  // rubric_version_id（条件必填：库里判定，这里只查形状）
  if (has(input, 'rubric_version_id')) {
    const value = input.rubric_version_id
    if (typeof value !== 'string' || value === '') {
      push('TYPE_MISMATCH', 'rubric_version_id', '"rubric_version_id" 必须是非空字符串')
    } else if (!isUuid(value)) {
      push('ID_NOT_UUID', 'rubric_version_id', '"rubric_version_id" 必须是 UUID 文本')
    }
  }

  // overall
  if (has(input, 'overall')) {
    const value = input.overall
    if (typeof value !== 'string') push('TYPE_MISMATCH', 'overall', '"overall" 必须是字符串')
    else if (!(OVERALLS as readonly string[]).includes(value)) {
      push('ENUM_INVALID', 'overall', `"overall" 只能是 ${OVERALLS.join(' | ')}`)
    }
  }

  // idempotency_key
  if (has(input, 'idempotency_key')) {
    const value = input.idempotency_key
    if (typeof value !== 'string' || value === '') {
      push('TYPE_MISMATCH', 'idempotency_key', '"idempotency_key" 必须是非空字符串')
    } else if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH || !IDEMPOTENCY_KEY_RE.test(value)) {
      push(
        'OUT_OF_RANGE',
        'idempotency_key',
        `"idempotency_key" 必须匹配 ^[A-Za-z0-9:_-]{1,${MAX_IDEMPOTENCY_KEY_LENGTH}}$（1..${MAX_IDEMPOTENCY_KEY_LENGTH} 个字母/数字/:_-）`,
      )
    }
  }

  // items（对象；数组形态已作废，D-74）
  let items: Record<string, unknown> | undefined
  if (has(input, 'items')) {
    const value = input.items
    if (!isPlainObject(value)) {
      push(
        'TYPE_MISMATCH',
        'items',
        '"items" 必须是对象（键 = rubric 维度 key ∪ {transcript_basis}）；数组形态已作废（D-74）',
      )
    } else {
      items = value
      validateItemsShape(value, push)
    }
  }

  // reject_reasons
  const rejectReasons = collectRejectReasons(input, push)

  // revision
  const revision = collectRevision(input, push)

  if (violations.length > 0) throw violationsError(violations)

  return {
    interview_id: interviewId as string,
    ...(has(input, 'rubric_version_id') ? { rubric_version_id: input.rubric_version_id as string } : {}),
    items: items as Record<string, unknown>,
    overall: input.overall as ScorecardSubmitArgs['overall'],
    ...(rejectReasons === undefined ? {} : { reject_reasons: rejectReasons }),
    ...(revision === undefined ? {} : { revision }),
    idempotency_key: input.idempotency_key as string,
  }
}

/** `items` 的结构：保留键 + 每个维度对象的四态/分值/备注/证据。 */
function validateItemsShape(
  items: Record<string, unknown>,
  push: (reasonCode: string, path: string, message: string) => void,
): void {
  if (!has(items, TRANSCRIPT_BASIS_KEY)) {
    push('TRANSCRIPT_BASIS_MISSING', `items.${TRANSCRIPT_BASIS_KEY}`, `items 必须带保留键 "${TRANSCRIPT_BASIS_KEY}"（TRANSCRIPT | NO_TRANSCRIPT）`)
  } else {
    const basis = items[TRANSCRIPT_BASIS_KEY]
    if (typeof basis !== 'string') {
      push('TYPE_MISMATCH', `items.${TRANSCRIPT_BASIS_KEY}`, `"${TRANSCRIPT_BASIS_KEY}" 必须是字符串`)
    } else if (!(TRANSCRIPT_BASES as readonly string[]).includes(basis)) {
      push('ENUM_INVALID', `items.${TRANSCRIPT_BASIS_KEY}`, `"${TRANSCRIPT_BASIS_KEY}" 只能是 ${TRANSCRIPT_BASES.join(' | ')}`)
    }
  }

  const dimensionKeys = Object.keys(items).filter((key) => key !== TRANSCRIPT_BASIS_KEY)
  if (dimensionKeys.length === 0) {
    push('DIMENSION_COVERAGE_INCOMPLETE', 'items', `items 里没有任何维度键（必须恰好覆盖 rubric 的 dimensions）`)
  } else if (dimensionKeys.length > MAX_DIMENSIONS) {
    push('OUT_OF_RANGE', 'items', `维度数 ${dimensionKeys.length} 超过上限 ${MAX_DIMENSIONS}（R-VAL-1）`)
  }

  for (const key of dimensionKeys) {
    const path = `items.${key}`
    const entry = items[key]
    if (!isPlainObject(entry)) {
      push('TYPE_MISMATCH', path, `${path} 必须是对象（assessment/score/note/evidence）`)
      continue
    }
    const assessment = entry.assessment
    if (!has(entry, 'assessment')) {
      push('MISSING_REQUIRED', `${path}.assessment`, `${path}.assessment 必填`)
    } else if (typeof assessment !== 'string') {
      push('TYPE_MISMATCH', `${path}.assessment`, `${path}.assessment 必须是字符串`)
    } else if (!(ASSESSMENTS as readonly string[]).includes(assessment)) {
      push('ENUM_INVALID', `${path}.assessment`, `${path}.assessment 只能是 ${ASSESSMENTS.join(' | ')}`)
    }
    if (has(entry, 'score')) {
      const score = entry.score
      if (score !== null) {
        if (typeof score !== 'number' || !Number.isInteger(score)) {
          push('TYPE_MISMATCH', `${path}.score`, `${path}.score 必须是整数（1..5）或 null`)
        } else if (score < 1 || score > 5) {
          push('OUT_OF_RANGE', `${path}.score`, `${path}.score 必须在 1..5`)
        }
      }
    }
    if (has(entry, 'note')) {
      const note = entry.note
      if (note !== null) {
        if (typeof note !== 'string') push('TYPE_MISMATCH', `${path}.note`, `${path}.note 必须是字符串或 null`)
        else if (note.length > MAX_NOTE_LENGTH) {
          push('OUT_OF_RANGE', `${path}.note`, `${path}.note 不得超过 ${MAX_NOTE_LENGTH} 字`)
        }
      }
    }
    if (has(entry, 'evidence')) collectEvidence(entry.evidence, `${path}.evidence`, push)
  }
}

/** 一条证据数组（0..20，逐元素校验，kind 只有 SEGMENT）。 */
function collectEvidence(
  raw: unknown,
  path: string,
  push: (reasonCode: string, path: string, message: string) => void,
): void {
  if (raw === null) return
  if (!Array.isArray(raw)) {
    push('TYPE_MISMATCH', path, `${path} 必须是数组`)
    return
  }
  if (raw.length > MAX_EVIDENCE_PER_ITEM) {
    push('OUT_OF_RANGE', path, `${path} 最多 ${MAX_EVIDENCE_PER_ITEM} 条`)
  }
  raw.forEach((item, index) => {
    const at = `${path}[${index}]`
    if (!isPlainObject(item)) {
      push('TYPE_MISMATCH', at, `${at} 必须是对象`)
      return
    }
    if (!has(item, 'kind')) push('MISSING_REQUIRED', `${at}.kind`, `${at}.kind 必填`)
    else if (typeof item.kind !== 'string') push('TYPE_MISMATCH', `${at}.kind`, `${at}.kind 必须是字符串`)
    else if (!(EVIDENCE_KINDS as readonly string[]).includes(item.kind)) {
      push(
        'ENUM_INVALID',
        `${at}.kind`,
        `${at}.kind 只能是 ${EVIDENCE_KINDS.join(' | ')}（TRANSCRIPT_SEGMENT 已作废，D-74 / TR-E3）`,
      )
    }
    for (const [field, label] of [
      ['transcript_artifact_id', 'transcript_artifact_id'],
      ['segment_id', 'segment_id'],
    ] as const) {
      if (!has(item, field)) push('MISSING_REQUIRED', `${at}.${field}`, `${at}.${field} 必填`)
      else if (typeof item[field] !== 'string' || item[field] === '') {
        push('TYPE_MISMATCH', `${at}.${field}`, `${at}.${field} 必须是非空字符串`)
      } else if (!isUuid(item[field])) {
        push('ID_NOT_UUID', `${at}.${field}`, `${at}.${field} 必须是 UUID 文本`)
      }
    }
    if (!has(item, 'transcript_revision')) {
      push('MISSING_REQUIRED', `${at}.transcript_revision`, `${at}.transcript_revision 必填`)
    } else if (typeof item.transcript_revision !== 'number' || !Number.isInteger(item.transcript_revision)) {
      push('TYPE_MISMATCH', `${at}.transcript_revision`, `${at}.transcript_revision 必须是整数`)
    } else if (item.transcript_revision < 1) {
      push('OUT_OF_RANGE', `${at}.transcript_revision`, `${at}.transcript_revision 必须 >= 1`)
    }
    if (!has(item, 'quote')) {
      push('MISSING_REQUIRED', `${at}.quote`, `${at}.quote 必填`)
    } else if (typeof item.quote !== 'string' || item.quote.trim() === '') {
      push('TYPE_MISMATCH', `${at}.quote`, `${at}.quote 必须是非空字符串（转写原文片段）`)
    } else if (item.quote.length > MAX_QUOTE_LENGTH) {
      push('OUT_OF_RANGE', `${at}.quote`, `${at}.quote 不得超过 ${MAX_QUOTE_LENGTH} 字`)
    }
  })
}

/** `reject_reasons[]`：数量 / 三字段 / 证据 / evidence_state。 */
function collectRejectReasons(
  input: Record<string, unknown>,
  push: (reasonCode: string, path: string, message: string) => void,
): ScorecardRejectReason[] | undefined {
  const overall = input.overall
  const required = overall === 'REJECT'
  if (!has(input, 'reject_reasons')) {
    if (required) {
      push('REJECT_REASON_INCOMPLETE', 'reject_reasons', 'overall=REJECT 时 reject_reasons 必填（1..10 条）')
    }
    return undefined
  }
  const raw = input.reject_reasons
  if (!Array.isArray(raw)) {
    push('TYPE_MISMATCH', 'reject_reasons', '"reject_reasons" 必须是数组')
    return undefined
  }
  if (raw.length === 0) {
    if (required) push('REJECT_REASON_INCOMPLETE', 'reject_reasons', 'overall=REJECT 时 reject_reasons 至少 1 条')
    return []
  }
  if (raw.length > MAX_REJECT_REASONS) {
    push('OUT_OF_RANGE', 'reject_reasons', `reject_reasons 最多 ${MAX_REJECT_REASONS} 条`)
  }
  const parsed: ScorecardRejectReason[] = []
  raw.forEach((item, index) => {
    const at = `reject_reasons[${index}]`
    if (!isPlainObject(item)) {
      push('TYPE_MISMATCH', at, `${at} 必须是对象`)
      return
    }
    for (const field of ['dimension_key', 'observation', 'why_decisive'] as const) {
      if (!has(item, field)) {
        push('REJECT_REASON_INCOMPLETE', `${at}.${field}`, `${at}.${field} 必填`)
        continue
      }
      const value = item[field]
      if (typeof value !== 'string') {
        push('TYPE_MISMATCH', `${at}.${field}`, `${at}.${field} 必须是字符串`)
        continue
      }
      if (field === 'dimension_key') {
        if (value.trim() === '') push('REJECT_REASON_INCOMPLETE', `${at}.${field}`, `${at}.${field} 不得为空`)
        else if (value === TRANSCRIPT_BASIS_KEY) {
          push('REJECT_REASON_NOT_BACKED', `${at}.${field}`, `${at}.${field} 不能是保留键 ${TRANSCRIPT_BASIS_KEY}`)
        }
      } else if (value.trim() === '') {
        push('REJECT_REASON_INCOMPLETE', `${at}.${field}`, `${at}.${field} 不得为空`)
      } else if (value.length > MAX_REASON_TEXT_LENGTH) {
        push('OUT_OF_RANGE', `${at}.${field}`, `${at}.${field} 不得超过 ${MAX_REASON_TEXT_LENGTH} 字`)
      }
    }
    if (has(item, 'evidence')) collectEvidence(item.evidence, `${at}.evidence`, push)
    if (has(item, 'evidence_state')) {
      const state = item.evidence_state
      if (typeof state !== 'string') push('TYPE_MISMATCH', `${at}.evidence_state`, `${at}.evidence_state 必须是字符串`)
      else if (!(EVIDENCE_STATES as readonly string[]).includes(state)) {
        push('ENUM_INVALID', `${at}.evidence_state`, `${at}.evidence_state 只能是 ${EVIDENCE_STATES.join(' | ')}`)
      }
    }
    parsed.push({
      dimension_key: typeof item.dimension_key === 'string' ? item.dimension_key : '',
      observation: typeof item.observation === 'string' ? item.observation : '',
      why_decisive: typeof item.why_decisive === 'string' ? item.why_decisive : '',
      ...(Array.isArray(item.evidence) ? { evidence: item.evidence as ScorecardEvidence[] } : {}),
      ...(item.evidence_state === 'MEMORY_ONLY' ? { evidence_state: 'MEMORY_ONLY' as const } : {}),
    })
  })
  // 重复元素拒绝（TC §1.1 第 6 条）。
  const seen = new Set<string>()
  parsed.forEach((reason, index) => {
    if (reason.dimension_key === '') return
    if (seen.has(reason.dimension_key)) {
      push(
        'DIMENSION_DUPLICATED',
        `reject_reasons[${index}].dimension_key`,
        `reject_reasons 里同一个 dimension_key（${reason.dimension_key}）出现两次`,
      )
    }
    seen.add(reason.dimension_key)
  })
  return parsed
}

/** `revision`：三字段全必填（缺一个就是 REVISION_FIELDS_INCOMPLETE，不是 MISSING_REQUIRED）。 */
function collectRevision(
  input: Record<string, unknown>,
  push: (reasonCode: string, path: string, message: string) => void,
): ScorecardRevision | undefined {
  if (!has(input, 'revision')) return undefined
  const raw = input.revision
  if (!isPlainObject(raw)) {
    push('TYPE_MISMATCH', 'revision', '"revision" 必须是对象')
    return undefined
  }
  for (const field of ['supersedes_scorecard_id', 'expected_record_version', 'revision_reason'] as const) {
    if (!has(raw, field)) push('REVISION_FIELDS_INCOMPLETE', `revision.${field}`, `revision.${field} 必填`)
  }
  if (has(raw, 'supersedes_scorecard_id')) {
    const value = raw.supersedes_scorecard_id
    if (typeof value !== 'string' || value === '') {
      push('TYPE_MISMATCH', 'revision.supersedes_scorecard_id', 'revision.supersedes_scorecard_id 必须是非空字符串')
    } else if (!isUuid(value)) {
      push('ID_NOT_UUID', 'revision.supersedes_scorecard_id', 'revision.supersedes_scorecard_id 必须是 UUID 文本')
    }
  }
  if (has(raw, 'expected_record_version')) {
    const value = raw.expected_record_version
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      push('TYPE_MISMATCH', 'revision.expected_record_version', 'revision.expected_record_version 必须是整数')
    } else if (value < 1) {
      push('OUT_OF_RANGE', 'revision.expected_record_version', 'revision.expected_record_version 必须 >= 1')
    }
  }
  if (has(raw, 'revision_reason')) {
    const value = raw.revision_reason
    if (typeof value !== 'string') push('TYPE_MISMATCH', 'revision.revision_reason', 'revision.revision_reason 必须是字符串')
    else if (value.trim() === '') push('REVISION_FIELDS_INCOMPLETE', 'revision.revision_reason', 'revision.revision_reason 不得为空')
    else if (value.length > MAX_REASON_TEXT_LENGTH) {
      push('OUT_OF_RANGE', 'revision.revision_reason', `revision.revision_reason 不得超过 ${MAX_REASON_TEXT_LENGTH} 字`)
    }
  }
  if (typeof raw.supersedes_scorecard_id !== 'string' || typeof raw.expected_record_version !== 'number'
    || typeof raw.revision_reason !== 'string') {
    return undefined
  }
  return {
    supersedes_scorecard_id: raw.supersedes_scorecard_id,
    expected_record_version: raw.expected_record_version,
    revision_reason: raw.revision_reason,
  }
}

/** 抛 `INVALID_ARGS`，`detail = {allowed, violations[]}`（TC §1.1 第 7 条）。 */
function violationsError(violations: readonly ScorecardViolation[]): Error {
  const first = violations[0] as ScorecardViolation
  return evalError('INVALID_ARGS', first.reason_code, '参数不合法，逐条见 detail.violations', {
    allowed: [...DECLARED_PARAM_KEYS],
    violations: violations.map((violation) => ({
      reason_code: violation.reason_code,
      path: violation.path,
      message: violation.message,
    })),
  })
}

// =====================================================================
//  语义层校验（需要 rubric 维度 + 转写状态；纯函数，便于单测）
// =====================================================================

/** 语义层输入。 */
export interface ScorecardSemanticInput {
  /** 已过参数层的 `items`。 */
  readonly items: Record<string, unknown>
  /** `overall`。 */
  readonly overall: string
  /** 已过参数层的拒绝理由（可能为空）。 */
  readonly rejectReasons: readonly ScorecardRejectReason[]
  /** `rubric_version.dimensions[].key`。 */
  readonly dimensionKeys: readonly string[]
  /** `items.transcript_basis`。 */
  readonly transcriptBasis: string
  /** 该场面试的 canonical transcript 是否 `READY`。 */
  readonly transcriptReady: boolean
}

/**
 * 语义层校验（SC-12/13/20/29…33 + TR-E2/TR-E3）。
 *
 * 顺序固定：转写基准 → 覆盖率 → 逐维（分值冲突 / NOT_MET 备注）→ NO_TRANSCRIPT 不得带 SEGMENT →
 * ADVANCE 两条 → REJECT 四条。**第一条违反即抛**（全是"写入前必须成立"的硬条件）。
 * @param input - 语义层输入。
 * @throws RecruitmentToolError - 见函数体内的封闭 reason_code。
 */
export function validateScorecardSemantics(input: ScorecardSemanticInput): void {
  const expectedBasis = input.transcriptReady ? 'TRANSCRIPT' : 'NO_TRANSCRIPT'
  if (input.transcriptBasis !== expectedBasis) {
    throw evalError(
      'INVALID_ARGS',
      'TRANSCRIPT_BASIS_CONFLICT',
      `该场面试的 canonical transcript ${input.transcriptReady ? '已 READY，必须写 TRANSCRIPT' : '没有 READY 的 canonical 版本，必须写 NO_TRANSCRIPT'}`,
      { transcript_basis: input.transcriptBasis, expected: expectedBasis, canonical_transcript_ready: input.transcriptReady },
    )
  }

  // 覆盖率：键集恰好 = 维度键（保留键已在参数层剥离）。
  const missing = input.dimensionKeys.filter((key) => !has(input.items, key))
  if (missing.length > 0) {
    throw evalError('INVALID_ARGS', 'DIMENSION_COVERAGE_INCOMPLETE', '有维度没有评（覆盖率必须 100%）', {
      missing,
      dimension_keys: [...input.dimensionKeys],
      dimensions_assessed: input.dimensionKeys.length - missing.length,
    })
  }
  const itemKeys = Object.keys(input.items).filter((key) => key !== TRANSCRIPT_BASIS_KEY)
  const unexpected = itemKeys.filter((key) => !input.dimensionKeys.includes(key))
  if (unexpected.length > 0) {
    throw evalError('INVALID_ARGS', 'DIMENSION_NOT_IN_RUBRIC', 'items 里有 rubric 里没有的维度键', {
      unexpected,
      dimension_keys: [...input.dimensionKeys],
    })
  }

  // 逐维：四态与分值的冲突、NOT_MET 必须有 note。
  for (const key of input.dimensionKeys) {
    const entry = input.items[key] as ScorecardDimensionItem
    const assessment = entry.assessment
    const hasScore = entry.score !== undefined && entry.score !== null
    if ((assessment === 'NOT_OBSERVED' || assessment === 'UNREADABLE') && hasScore) {
      throw evalError(
        'INVALID_ARGS',
        'ASSESSMENT_SCORE_CONFLICT',
        `assessment=${assessment} 时不得打分（"判不了"不能当"不满足"，D11 §9.2）`,
        { dimension_key: key, assessment, score: entry.score },
      )
    }
    if (assessment === 'NOT_MET') {
      const note = entry.note
      if (typeof note !== 'string' || note.trim() === '') {
        throw evalError('INVALID_ARGS', 'NOT_MET_NOTE_MISSING', 'assessment=NOT_MET 时必须写 note（看见了什么）', {
          dimension_key: key,
        })
      }
    }
  }

  // NO_TRANSCRIPT 时不得出现 kind='SEGMENT' 的证据（TR-E3）。
  if (input.transcriptBasis === 'NO_TRANSCRIPT') {
    const offenders: string[] = []
    for (const key of input.dimensionKeys) {
      const entry = input.items[key] as ScorecardDimensionItem
      if ((entry.evidence ?? []).some((evidence) => evidence.kind === 'SEGMENT')) offenders.push(`items.${key}`)
    }
    input.rejectReasons.forEach((reason, index) => {
      if ((reason.evidence ?? []).some((evidence) => evidence.kind === 'SEGMENT')) {
        offenders.push(`reject_reasons[${index}]`)
      }
    })
    if (offenders.length > 0) {
      throw evalError(
        'INVALID_ARGS',
        'TRANSCRIPT_BASIS_CONFLICT',
        'transcript_basis=NO_TRANSCRIPT 时不得携带 kind=SEGMENT 的证据（TR-E3）',
        { transcript_basis: input.transcriptBasis, paths: offenders },
      )
    }
  }

  if (input.overall === 'ADVANCE') {
    const unassessed = input.dimensionKeys.filter((key) => {
      const entry = input.items[key] as ScorecardDimensionItem
      return entry.assessment === 'NOT_OBSERVED' || entry.assessment === 'UNREADABLE'
    })
    if (unassessed.length > 0) {
      throw evalError(
        'INVALID_ARGS',
        'ADVANCE_WITH_UNASSESSED_DIMENSION',
        'overall=ADVANCE 时不得含 NOT_OBSERVED / UNREADABLE 的维度（"没看到"不等于"行"）',
        { dimensions: unassessed },
      )
    }
    const withoutBasis = input.dimensionKeys.filter((key) => {
      const entry = input.items[key] as ScorecardDimensionItem
      if (entry.assessment !== 'MET') return false
      const hasNote = typeof entry.note === 'string' && entry.note.trim() !== ''
      const hasEvidence = (entry.evidence ?? []).length > 0
      return !hasNote && !hasEvidence
    })
    if (withoutBasis.length > 0) {
      throw evalError('INVALID_ARGS', 'ADVANCE_WITHOUT_BASIS', 'overall=ADVANCE 时每条 MET 至少带 note 或 evidence', {
        dimensions: withoutBasis,
      })
    }
  }

  if (input.overall === 'REJECT') {
    if (input.rejectReasons.length === 0) {
      throw evalError('INVALID_ARGS', 'REJECT_REASON_INCOMPLETE', 'overall=REJECT 时 reject_reasons 至少 1 条', {})
    }
    input.rejectReasons.forEach((reason, index) => {
      const path = `reject_reasons[${index}]`
      const dimensionKey = reason.dimension_key
      if (dimensionKey === '' || !has(input.items, dimensionKey) || dimensionKey === TRANSCRIPT_BASIS_KEY) {
        throw evalError('INVALID_ARGS', 'REJECT_REASON_NOT_BACKED', '拒绝理由必须指向 items 里的一个维度键', {
          path,
          dimension_key: dimensionKey,
        })
      }
      const entry = input.items[dimensionKey] as ScorecardDimensionItem
      if (entry.assessment === 'UNREADABLE' || entry.assessment === 'NOT_OBSERVED') {
        throw evalError(
          'EVIDENCE_INSUFFICIENT',
          'REJECT_BASIS_UNREADABLE',
          '拒绝依据落在读不出/没看到的维度上——不得用 NOT_OBSERVED / UNREADABLE 拒绝人（D11 §9.11 红线 7）',
          { path, dimension_key: dimensionKey, assessment: entry.assessment },
        )
      }
      if (entry.assessment !== 'NOT_MET') {
        throw evalError('INVALID_ARGS', 'REJECT_REASON_NOT_BACKED', '拒绝理由指向的维度不是 NOT_MET（自相矛盾的面评）', {
          path,
          dimension_key: dimensionKey,
          assessment: entry.assessment,
        })
      }
      const hasEvidence = (reason.evidence ?? []).length > 0
      if (!hasEvidence && reason.evidence_state !== 'MEMORY_ONLY') {
        throw evalError(
          'INVALID_ARGS',
          'REJECT_EVIDENCE_UNDECLARED',
          '拒绝理由的证据为空时必须显式声明 evidence_state=MEMORY_ONLY（凭现场记忆）',
          { path, dimension_key: dimensionKey },
        )
      }
    })
  }
}

// =====================================================================
//  `rationale` 固定编码（G-1 / DESIGN §3.5 ②）与 `payload_hash`（SC-38）
// =====================================================================

/**
 * 编码 `rationale`：`[修订原因：…\n]` + `REJECT_REASONS_JSON: <canonical json 数组>`。
 *
 * **始终**写 `REJECT_REASONS_JSON` 这一行（没有拒绝理由时是 `[]`），保证读侧一定解析得到。
 * @param rejectReasons - 拒绝理由数组（无则空数组）。
 * @param revisionReason - 修订原因（只有修订时才有，SC-19）。
 */
export function buildRationale(
  rejectReasons: readonly unknown[],
  revisionReason?: string,
): string {
  const lines: string[] = []
  if (revisionReason !== undefined && revisionReason !== '') {
    lines.push(`${REVISION_REASON_PREFIX}${revisionReason}`)
  }
  lines.push(`${REJECT_REASONS_MARKER}${canonicalJson(rejectReasons)}`)
  return lines.join('\n')
}

/**
 * 解码 `rationale` 里的 `reject_reasons`：找**最后**一个以 `REJECT_REASONS_JSON: ` 开头的行。
 * @param rationale - 落库的 rationale 文本。
 * @returns 解析出的数组（保证是数组）。
 * @throws RecruitmentToolError - 缺失或不可解析 → `INVALID_ARGS(RATIONALE_NOT_PARSABLE)`。
 */
export function parseRejectReasonsFromRationale(rationale: string | null | undefined): unknown[] {
  if (typeof rationale !== 'string') {
    throw evalError('INVALID_ARGS', 'RATIONALE_NOT_PARSABLE', 'rationale 为空，读不出 reject_reasons')
  }
  const lines = rationale.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string
    if (!line.startsWith(REJECT_REASONS_MARKER)) continue
    try {
      const parsed: unknown = JSON.parse(line.slice(REJECT_REASONS_MARKER.length))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      throw evalError('INVALID_ARGS', 'RATIONALE_NOT_PARSABLE', 'rationale 里的 REJECT_REASONS_JSON 不是合法 JSON')
    }
  }
  throw evalError('INVALID_ARGS', 'RATIONALE_NOT_PARSABLE', 'rationale 里没有 REJECT_REASONS_JSON 行')
}

/**
 * `payload_hash = sha256(canonical_json({interview_id, rubric_version_id, items, overall, reject_reasons}))`。
 * @param input - 提交内容的规范部分。
 */
export function computeScorecardPayloadHash(input: {
  readonly interview_id: string
  readonly rubric_version_id: string
  readonly items: Record<string, unknown>
  readonly overall: string
  readonly reject_reasons?: readonly unknown[]
}): string {
  return digestOf({
    interview_id: input.interview_id,
    rubric_version_id: input.rubric_version_id,
    items: input.items,
    overall: input.overall,
    reject_reasons: input.reject_reasons ?? [],
  })
}

// =====================================================================
//  数据库行形状
// =====================================================================

interface InterviewRow {
  readonly id: string
  readonly application_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly status: string
  readonly scheduled_start_at: string | Date | null
  readonly job_id: string
  readonly pinned_rubric_version_id: string | null
  readonly candidate_id: string
  readonly resume_version_id: string | null
}

interface RubricRow {
  readonly id: string
  readonly job_id: string
  readonly payload_hash: string
  readonly dimensions: readonly unknown[]
}

interface InterviewerRow {
  readonly id: string
  readonly required_scorecard: boolean
}

interface ScorecardRow {
  readonly id: string
  readonly revision_no: number
  readonly status: string
  readonly interview_id: string
  readonly interviewer_id: string
  readonly rubric_version_id: string
  readonly submitted_at: string | Date | null
  readonly payload_hash: string | null
  readonly items: Record<string, unknown> | null
  readonly overall: string | null
  readonly status_changed_by_actor_id: string | null
  readonly status_source_event_id: string | null
  readonly record_version: number
}

interface CurrentScorecardRow {
  readonly id: string
  readonly status: string
  readonly revision_no: number
  readonly record_version: number
  readonly rubric_version_id: string
}

/** 写库时需要的全部已解析事实。 */
interface ResolvedContext {
  readonly actorId: string
  readonly tenantId: string
  readonly args: ScorecardSubmitArgs
  readonly interview: InterviewRow
  readonly interviewer: InterviewerRow
  readonly rubric: RubricRow
  readonly rubricResolution: (typeof RUBRIC_RESOLUTIONS)[number]
  readonly provenance: 'LIVE' | 'FIXTURE'
  readonly transcriptReady: boolean
  readonly payloadHash: string
  readonly rationale: string
  readonly overall: string
  readonly transcriptBasis: string
}

// =====================================================================
//  读路径
// =====================================================================

/** 当前执行上下文的 actor（`recruitment.actor_id` GUC，DESIGN §3.5 ①）。 */
async function readActorId(client: DatabaseClient): Promise<string> {
  const { rows } = await client.query<{ actor_id: string | null }>(
    "select nullif(current_setting('recruitment.actor_id', true), '') as actor_id",
  )
  const actorId = rows[0]?.actor_id ?? null
  if (actorId === null || actorId === '') {
    throw evalError(
      'INVALID_ARGS',
      'ACTOR_REQUIRED',
      '执行上下文没有 actor（recruitment.actor_id）；面评的作者只能来自上下文，不接受入参',
    )
  }
  return actorId
}

async function loadInterview(client: DatabaseClient, tenantId: string, interviewId: string): Promise<InterviewRow> {
  const { rows } = await client.query<InterviewRow>(
    `select i.id, i.application_id, i.round_no, i.slot_code, i.status, i.scheduled_start_at,
            a.job_id, a.rubric_version_id as pinned_rubric_version_id, a.candidate_id, a.resume_version_id
       from recruitment.interview i
       join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
      where i.id = $1 and i.tenant_id = $2`,
    [interviewId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError('NOT_FOUND', 'INTERVIEW_NOT_FOUND', '该租户下没有这场面试', { interview_id: interviewId })
  }
  return row
}

async function loadInterviewer(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  actorId: string,
): Promise<InterviewerRow> {
  const { rows } = await client.query<InterviewerRow>(
    `select id, required_scorecard
       from recruitment.interviewer
      where interview_id = $1 and actor_id = $2 and tenant_id = $3`,
    [interviewId, actorId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError(
      'INTERVIEWER_MISMATCH',
      'ACTOR_NOT_INTERVIEWER',
      '当前 actor 不是这场面试已登记的面试官（一人只能交自己的面评，SC-02/SC-05）',
      { interview_id: interviewId, actor_id: actorId },
    )
  }
  return row
}

/** `actor.kind` 必须是 HUMAN（SC-03 / APP-07）。 */
async function assertHumanActor(client: DatabaseClient, tenantId: string, actorId: string): Promise<void> {
  const { rows } = await client.query<{ kind: string }>(
    'select kind from recruitment.actor where id = $1 and tenant_id = $2',
    [actorId, tenantId],
  )
  const kind = rows[0]?.kind
  if (kind !== 'HUMAN') {
    throw evalError(
      'INTERVIEWER_MISMATCH',
      'ACTOR_NOT_HUMAN',
      '面评作者必须是 HUMAN actor（Agent 不得写面评内容，APP-07）',
      { actor_id: actorId, ...(kind === undefined ? { found: false } : { kind }) },
    )
  }
}

async function loadRubric(client: DatabaseClient, tenantId: string, rubricVersionId: string): Promise<RubricRow> {
  const { rows } = await client.query<RubricRow>(
    'select id, job_id, payload_hash, dimensions from recruitment.rubric_version where id = $1 and tenant_id = $2',
    [rubricVersionId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', '该租户下没有这个 rubric 版本', {
      rubric_version_id: rubricVersionId,
    })
  }
  return row
}

/** rubric 的三绑定（SC-09/10/11/47）。 */
async function resolveRubric(
  client: DatabaseClient,
  tenantId: string,
  interview: InterviewRow,
  explicitId: string | undefined,
): Promise<{ rubric: RubricRow; resolution: (typeof RUBRIC_RESOLUTIONS)[number] }> {
  const pinned = interview.pinned_rubric_version_id
  let rubricId: string
  let resolution: (typeof RUBRIC_RESOLUTIONS)[number]
  if (pinned !== null) {
    if (explicitId !== undefined && explicitId !== pinned) {
      throw evalError(
        'INVALID_ARGS',
        'RUBRIC_MISMATCH',
        '入参的 rubric_version_id 与申请钉住的版本不一致；没有 what-if 面评（SC-11）',
        { pinned_rubric_version_id: pinned, rubric_version_id: explicitId },
      )
    }
    rubricId = pinned
    resolution = 'APPLICATION_PINNED'
  } else {
    if (explicitId === undefined) {
      throw evalError(
        'INVALID_ARGS',
        'RUBRIC_UNRESOLVED',
        '该申请没有钉住 rubric 版本，必须显式给 rubric_version_id（不做 fallback，SC-10）',
        { application_id: interview.application_id },
      )
    }
    rubricId = explicitId
    resolution = 'EXPLICIT_VERSION_ID'
  }
  const rubric = await loadRubric(client, tenantId, rubricId)
  if (rubric.job_id !== interview.job_id) {
    throw evalError(
      'INVALID_ARGS',
      'RUBRIC_NOT_OF_JOB',
      '这个 rubric 版本不属于该申请的岗位（拿别的岗位的标准打分不被接受，SC-47）',
      { rubric_version_id: rubric.id, rubric_job_id: rubric.job_id, application_job_id: interview.job_id },
    )
  }
  return { rubric, resolution }
}

/** rubric 的维度 key（`dimensions[].key`）。 */
function dimensionKeysOf(rubric: RubricRow): string[] {
  const dimensions = Array.isArray(rubric.dimensions) ? rubric.dimensions : []
  const keys: string[] = []
  for (const raw of dimensions) {
    if (isPlainObject(raw) && typeof raw.key === 'string' && raw.key !== '') keys.push(raw.key)
  }
  return keys
}

/** 该场面试的 canonical transcript 是否 READY（TR-E2 的判定输入）。 */
async function isCanonicalTranscriptReady(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ transcript_status: string }>(
    `select ta.transcript_status
       from recruitment.meeting_binding mb
       join recruitment.transcript_artifact ta
         on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id
      where mb.interview_id = $1 and mb.tenant_id = $2
        and mb.unbound_at is null and ta.is_canonical`,
    [interviewId, tenantId],
  )
  return rows.some((row) => row.transcript_status === 'READY')
}

/**
 * `labels.provenance`（TC §1.3 判定式）。
 *
 * LIVE ⟺ 材料链路 `resume_version → resume → intake_asset → intake_record → event_inbox`
 * 存在且 `event_inbox.provider <> 'internal'`，**且**该场面试的活动 meeting（若有 binding）
 * `provider <> 'internal'`；否则 FIXTURE（**不因 FIXTURE 改判**）。
 */
async function computeProvenance(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  resumeVersionId: string | null,
): Promise<'LIVE' | 'FIXTURE'> {
  if (resumeVersionId === null) return 'FIXTURE'
  const chain = await client.query<{ provider: string }>(
    `select ev.provider
       from recruitment.resume_version rv
       join recruitment.resume r on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
       join recruitment.intake_asset ia on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
       join recruitment.intake_record ir on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
       join recruitment.event_inbox ev on ev.event_id = ir.event_id and ev.tenant_id = ir.tenant_id
      where rv.id = $1 and rv.tenant_id = $2`,
    [resumeVersionId, tenantId],
  )
  const provider = chain.rows[0]?.provider
  if (provider === undefined || provider === 'internal') return 'FIXTURE'
  const internalMeeting = await client.query<{ ok: number }>(
    `select 1 as ok
       from recruitment.meeting_binding mb
       join recruitment.meeting m on m.id = mb.meeting_id and m.tenant_id = mb.tenant_id
      where mb.interview_id = $1 and mb.tenant_id = $2
        and mb.unbound_at is null and m.provider = 'internal'
      limit 1`,
    [interviewId, tenantId],
  )
  if (internalMeeting.rows.length > 0) return 'FIXTURE'
  return 'LIVE'
}

/** 当前行（`superseded_by_scorecard_id is null`；`uq_scorecard_current` 保证至多一条）。 */
async function loadCurrentScorecard(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  interviewerId: string,
): Promise<CurrentScorecardRow | undefined> {
  const { rows } = await client.query<CurrentScorecardRow>(
    `select id, status, revision_no, record_version, rubric_version_id
       from recruitment.scorecard
      where interview_id = $1 and interviewer_id = $2 and tenant_id = $3
        and superseded_by_scorecard_id is null`,
    [interviewId, interviewerId, tenantId],
  )
  return rows[0]
}

async function loadScorecardById(
  client: DatabaseClient,
  tenantId: string,
  scorecardId: string,
): Promise<ScorecardRow> {
  const { rows } = await client.query<ScorecardRow>(
    `select id, revision_no, status, interview_id, interviewer_id, rubric_version_id, submitted_at,
            payload_hash, items, overall, status_changed_by_actor_id, status_source_event_id, record_version
       from recruitment.scorecard
      where id = $1 and tenant_id = $2`,
    [scorecardId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw evalError('NOT_FOUND', 'SCORECARD_NOT_FOUND', '库里没有这条面评（幂等重放指向的行不存在）', {
      scorecard_id: scorecardId,
    })
  }
  return row
}

/** 指向 `scorecardId` 的旧行（修订链的单向指针）。 */
async function loadSupersededBy(
  client: DatabaseClient,
  tenantId: string,
  scorecardId: string,
): Promise<{ scorecard_id: string; revision_no: number } | undefined> {
  const { rows } = await client.query<{ id: string; revision_no: number }>(
    `select id, revision_no
       from recruitment.scorecard
      where superseded_by_scorecard_id = $1 and tenant_id = $2
      order by revision_no desc
      limit 1`,
    [scorecardId, tenantId],
  )
  const row = rows[0]
  return row === undefined ? undefined : { scorecard_id: row.id, revision_no: row.revision_no }
}

/**
 * 幂等键（G-2）：落 `event_inbox`。
 * @returns 同 key 的行（含 payload）；没有则 undefined。
 */
async function loadIdempotencyRecord(
  client: DatabaseClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<{ event_id: string; payload_hash: string | null; scorecard_id: string | null } | undefined> {
  const { rows } = await client.query<{ event_id: string; payload_hash: string | null; scorecard_id: string | null }>(
    `select event_id, payload->>'payload_hash' as payload_hash, payload->>'scorecard_id' as scorecard_id
       from recruitment.event_inbox
      where tenant_id = $1 and idempotency_key = $2`,
    [tenantId, idempotencyKey],
  )
  return rows[0]
}

// =====================================================================
//  写路径（SC-44 / SC-45 / §5.2 三步舞）
// =====================================================================

/** 先写内部事件（SC-44）：`provider='internal'`、`FALLBACK_KEY`、`source_object_id=<scorecard id>`。 */
async function insertInternalEvent(
  client: DatabaseClient,
  tenantId: string,
  idempotencyKey: string,
  scorecardId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const { rows } = await client.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, event_type, idempotency_key, idempotency_source, source_object_id,
        payload, trust_level, occurred_at, normalized_event_type)
     values ($1, 'internal', 'scorecard.submit', $2, 'FALLBACK_KEY', $3, $4::jsonb, 'INTERNAL', now(), 'scorecard.submit')
     returning event_id`,
    [tenantId, idempotencyKey, scorecardId, JSON.stringify(payload)],
  )
  const eventId = rows[0]?.event_id
  if (eventId === undefined) {
    throw evalError('DB_CONSTRAINT_VIOLATION', 'UNIQUE_VIOLATION', '内部事件没有写进去（no row returned）', {})
  }
  return eventId
}

/** 终态行 `INSERT`：必须自带 actor + 事件 + 时间（SC-44；`INSERT` 不触发 `fn_row_guard`）。 */
async function insertSubmittedScorecard(
  client: DatabaseClient,
  context: ResolvedContext,
  scorecardId: string,
  eventId: string,
  revisionNo: number,
  supersededByScorecardId: string | null,
): Promise<void> {
  await client.query(
    `insert into recruitment.scorecard
       (id, tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
        submitted_at, items, overall, rationale, payload_hash, superseded_by_scorecard_id,
        status_changed_at, status_changed_by_actor_id, status_source_event_id, created_at)
     values ($1, $2, $3, $4, $5, $6, 'SUBMITTED', now(), $7::jsonb, $8, $9, $10, $11,
             now(), $12, $13, now())`,
    [
      scorecardId,
      context.tenantId,
      context.interview.id,
      context.interviewer.id,
      context.rubric.id,
      revisionNo,
      JSON.stringify(context.args.items),
      context.overall,
      context.rationale,
      context.payloadHash,
      supersededByScorecardId,
      context.actorId,
      eventId,
    ],
  )
}

/**
 * `PENDING → SUBMITTED` 原地转正（SC-45）。
 *
 * 一条 `UPDATE` 就够——但**必须**在事务里已 `SET LOCAL recruitment.actor_id`：`fn_row_guard`
 * 自己会插 `event_inbox` 行、回填 `status_source_event_id`、把 `record_version` 置为旧值 + 1。
 * 所以这里 `WHERE record_version = <旧值>`，**不手写** `record_version = record_version + 1`。
 * @returns 更新后的 `record_version`。
 */
async function promotePendingScorecard(
  client: DatabaseClient,
  context: ResolvedContext,
  current: CurrentScorecardRow,
): Promise<number> {
  const { rows } = await client.query<{ record_version: number }>(
    `update recruitment.scorecard
        set status = 'SUBMITTED',
            submitted_at = now(),
            items = $1::jsonb,
            overall = $2,
            rationale = $3,
            payload_hash = $4
      where id = $5 and tenant_id = $6 and record_version = $7
      returning record_version`,
    [
      JSON.stringify(context.args.items),
      context.overall,
      context.rationale,
      context.payloadHash,
      current.id,
      context.tenantId,
      current.record_version,
    ],
  )
  const updated = rows[0]
  if (updated === undefined) {
    throw evalError(
      'VERSION_CONFLICT',
      'RECORD_VERSION_MISMATCH',
      '该 PENDING 面评已被别人改过（record_version 不匹配）',
      { scorecard_id: current.id, expected_record_version: current.record_version },
    )
  }
  return updated.record_version
}

/**
 * 修订三步舞（`scorecard-rules.md` §5.2）：**反向插 → 换指针 → 清空**。
 *
 * 任何两步写法都会撞 `uq_scorecard_current`(23505) 或 `fk_scorecard_superseded_by`(23503)。
 * @returns 新行 id。
 */
async function reviseScorecard(
  client: DatabaseClient,
  context: ResolvedContext,
  current: CurrentScorecardRow,
  expectedRecordVersion: number,
): Promise<string> {
  const newId = randomUUID()
  const revisionNo = current.revision_no + 1
  // 内部事件必须先写（SC-44）：payload 里带上新 scorecard id 供幂等重放读回。
  const eventId = await insertInternalEvent(
    client,
    context.tenantId,
    `scorecard:${context.args.idempotency_key}`,
    newId,
    {
      payload_hash: context.payloadHash,
      scorecard_id: newId,
      interview_id: context.interview.id,
      interviewer_id: context.interviewer.id,
    },
  )
  // 第 1 步：反向插（superseded_by 先指向旧行，避开 uq_scorecard_current）。
  await insertSubmittedScorecard(client, context, newId, eventId, revisionNo, current.id)
  // 第 2 步：旧行指向新行（`WHERE record_version = expected`；0 行 = 乐观并发冲突）。
  const updated = await client.query<{ record_version: number }>(
    `update recruitment.scorecard
        set superseded_by_scorecard_id = $1
      where id = $2 and tenant_id = $3 and record_version = $4
      returning record_version`,
    [newId, current.id, context.tenantId, expectedRecordVersion],
  )
  if (updated.rows[0] === undefined) {
    throw evalError('VERSION_CONFLICT', 'RECORD_VERSION_MISMATCH', '旧面评已被别人改过（record_version 不匹配）', {
      scorecard_id: current.id,
      expected_record_version: expectedRecordVersion,
    })
  }
  // 第 3 步：清空新行的指针 → 它成为唯一的 current 行。
  await client.query(
    `update recruitment.scorecard
        set superseded_by_scorecard_id = null
      where id = $1 and tenant_id = $2`,
    [newId, context.tenantId],
  )
  return newId
}

/**
 * 把 23505 / 23514 / 23503 翻成 `DB_CONSTRAINT_VIOLATION`（TC §5.3 兜底，不是逃生门）。
 * 其它错误原样抛出（契约错误不该被包一层）。
 */
function mapConstraintError(error: unknown): never {
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown }
  const sqlstate = typeof record.code === 'string' ? record.code : ''
  if (sqlstate === '23505' || sqlstate === '23503' || sqlstate === '23514') {
    const reason = sqlstate === '23505' ? 'UNIQUE_VIOLATION' : sqlstate === '23503' ? 'FK_VIOLATION' : 'SCORECARD_IMMUTABLE'
    const detail: Record<string, unknown> = { sqlstate }
    if (typeof record.constraint === 'string' && record.constraint !== '') detail.constraint = record.constraint
    if (typeof record.message === 'string') detail.error = record.message.slice(0, 300)
    throw evalError('DB_CONSTRAINT_VIOLATION', reason, '写库撞到了库约束（并发或历史状态），详见 detail', detail)
  }
  throw error
}

// =====================================================================
//  出参构造
// =====================================================================

interface OutputContext {
  readonly row: ScorecardRow
  readonly interview: InterviewRow
  readonly rubric: RubricRow
  readonly dimensionKeys: readonly string[]
  readonly actorId: string
  readonly resolution: (typeof RUBRIC_RESOLUTIONS)[number]
  readonly provenance: 'LIVE' | 'FIXTURE'
  readonly replayed: boolean
  readonly superseded?: { scorecard_id: string; revision_no: number }
  readonly rejectReasons: readonly unknown[]
}

function isoOrUndefined(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(ms)) return undefined
  return new Date(ms).toISOString()
}

/** 逐维度四态计数（`coverage.by_assessment`）。 */
function countAssessments(
  items: Record<string, unknown>,
  dimensionKeys: readonly string[],
): { met: number; not_met: number; not_observed: number; unreadable: number; assessed: number } {
  const counts = { met: 0, not_met: 0, not_observed: 0, unreadable: 0, assessed: 0 }
  for (const key of dimensionKeys) {
    const entry = items[key]
    if (!isPlainObject(entry) || typeof entry.assessment !== 'string') continue
    counts.assessed += 1
    if (entry.assessment === 'MET') counts.met += 1
    else if (entry.assessment === 'NOT_MET') counts.not_met += 1
    else if (entry.assessment === 'NOT_OBSERVED') counts.not_observed += 1
    else if (entry.assessment === 'UNREADABLE') counts.unreadable += 1
  }
  return counts
}

/** 组装 TC §2.2 的规范输出（`null` 一律省略键）。 */
function buildOutput(context: OutputContext): Record<string, unknown> {
  const { row, interview, rubric, dimensionKeys } = context
  const items = row.items ?? {}
  const counts = countAssessments(items, dimensionKeys)
  const basis = typeof items[TRANSCRIPT_BASIS_KEY] === 'string'
    ? (items[TRANSCRIPT_BASIS_KEY] as string)
    : 'NO_TRANSCRIPT'
  const submittedAt = isoOrUndefined(row.submitted_at)
  const scheduledStartAt = isoOrUndefined(interview.scheduled_start_at)

  const warnings: { code: string; message: string }[] = []
  const memoryOnly = context.rejectReasons.filter(
    (reason) => isPlainObject(reason) && reason.evidence_state === 'MEMORY_ONLY',
  ).length
  if (memoryOnly > 0) {
    warnings.push({
      code: 'NO_TIMESTAMPED_EVIDENCE',
      message: `${memoryOnly} 条 reject_reason 未附转写证据，已按 MEMORY_ONLY 记录`,
    })
  }
  if (context.provenance === 'FIXTURE') {
    warnings.push({
      code: 'FIXTURE_BASIS',
      message: '这场面试的材料/会议链路含 fixture 或 internal 事件，provenance=FIXTURE（只贴标签，不改判）',
    })
  }
  if (context.resolution === 'EXPLICIT_VERSION_ID') {
    warnings.push({
      code: 'RUBRIC_EXPLICIT_NOT_PINNED',
      message: '申请没有钉住 rubric 版本，本次按显式 rubric_version_id 提交；应尽快把申请钉住（SC-10）',
    })
  }

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    replayed: context.replayed,
    labels: { provenance: context.provenance, trigger: 'MANUAL', connection: 'CONNECTED' },
    scorecard: {
      id: row.id,
      revision_no: row.revision_no,
      status: 'SUBMITTED',
      interview_id: row.interview_id,
      interviewer_id: row.interviewer_id,
      actor_id: context.actorId,
      rubric_version_id: row.rubric_version_id,
      rubric_payload_hash: rubric.payload_hash,
      rubric_resolution: context.resolution,
      transcript_basis: basis,
      payload_hash: row.payload_hash ?? '',
      submitted_at: submittedAt ?? '',
      status_changed_by_actor_id: row.status_changed_by_actor_id ?? '',
      status_source_event_id: row.status_source_event_id ?? '',
      record_version: row.record_version,
    },
    interview: {
      round_no: interview.round_no,
      slot_code: interview.slot_code,
      ...(scheduledStartAt === undefined ? {} : { scheduled_start_at: scheduledStartAt }),
      status: interview.status,
    },
    coverage: {
      dimensions_total: dimensionKeys.length,
      dimensions_assessed: counts.assessed,
      by_assessment: {
        met: counts.met,
        not_met: counts.not_met,
        not_observed: counts.not_observed,
        unreadable: counts.unreadable,
      },
    },
    ...(context.superseded === undefined ? {} : { superseded: context.superseded }),
    warnings,
  }
}

// =====================================================================
//  主流程（事务内）
// =====================================================================

/**
 * 在一个事务里提交一份面评。单独导出是为了让集成测试在"必回滚事务"里跑，
 * 并且**必须**读事务里的 `recruitment.actor_id` GUC（不是 `cfg.actor_id`），
 * 否则同一个池上无法切换身份（DESIGN §3.5 ①）。
 * @param client - 调用方给的连接（actor 已由调用方 `set_config` 设好）。
 * @param cfg - 已解析配置（租户从这里来，不接受入参覆盖）。
 * @param rawArgs - 模型给的 arguments（未校验）。
 * @param nowMs - 服务端"现在"（毫秒）。本工具不把它写进任何时间列——时间一律用库的 `now()`；
 *   参数保留它是为了与另外两个工具同形（DESIGN §1）。
 * @returns TC §2.2 的规范输出。
 * @throws RecruitmentToolError - 契约错误（TC §5 封闭集）。
 */
export async function submitScorecardInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  rawArgs: unknown,
  nowMs: number,
): Promise<Record<string, unknown>> {
  void nowMs
  const tenantId = cfg.tenant_id

  // ---- 0) 身份只从执行上下文来（SC-01）----
  const actorId = await readActorId(client)

  // ---- 1) 参数层（TC §1.1，一次收集全部违反项）----
  const args = parseScorecardSubmitArgs(rawArgs)

  // ---- 2) 面试（轮次只经它得到）+ 归属 ----
  const interview = await loadInterview(client, tenantId, args.interview_id)

  // ---- 3) 作者必须是已登记面试官（SC-02）+ HUMAN（SC-03）----
  const interviewer = await loadInterviewer(client, tenantId, interview.id, actorId)
  await assertHumanActor(client, tenantId, actorId)

  // ---- 4) CANCELLED / NO_SHOW 不得新增面评（SC-08）----
  if ((BLOCKED_INTERVIEW_STATUSES as readonly string[]).includes(interview.status)) {
    throw evalError(
      'INVALID_ARGS',
      'INTERVIEW_CANCELLED',
      `面试状态是 ${interview.status}，不得新增面评（SC-08）`,
      { interview_id: interview.id, interview_status: interview.status },
    )
  }

  // ---- 5) rubric 三绑定（SC-09/10/11/47）----
  const { rubric, resolution } = await resolveRubric(client, tenantId, interview, args.rubric_version_id)

  // ---- 6) payload_hash（SC-38）----
  const payloadHash = computeScorecardPayloadHash({
    interview_id: interview.id,
    rubric_version_id: rubric.id,
    items: args.items,
    overall: args.overall,
    reject_reasons: args.reject_reasons ?? [],
  })

  // ---- 7) 幂等（G-2 / SC-37）----
  const idempotencyKey = `scorecard:${args.idempotency_key}`
  const recorded = await loadIdempotencyRecord(client, tenantId, idempotencyKey)
  if (recorded !== undefined) {
    if (recorded.payload_hash !== payloadHash) {
      throw evalError(
        'INVALID_ARGS',
        'IDEMPOTENCY_KEY_REUSED',
        '这个 idempotency_key 已经用于**另一份**提交内容（同 key 不同 payload）',
        { idempotency_key: args.idempotency_key, recorded_payload_hash: recorded.payload_hash ?? '', payload_hash: payloadHash },
      )
    }
    const scorecardId = recorded.scorecard_id ?? ''
    const row = await loadScorecardById(client, tenantId, scorecardId)
    const provenance = await computeProvenance(
      client,
      tenantId,
      interview.id,
      interview.resume_version_id,
    )
    const replayedRejectReasons = safeParseRejectReasons(row.rationale)
    return buildOutput({
      row,
      interview,
      rubric,
      dimensionKeys: dimensionKeysOf(rubric),
      actorId,
      resolution,
      provenance,
      replayed: true,
      ...(await supersededOf(client, tenantId, row.id)),
      rejectReasons: replayedRejectReasons,
    })
  }

  // ---- 8) 转写基准 + 语义层（SC-12/13/29…33、TR-E2/E3）----
  const transcriptReady = await isCanonicalTranscriptReady(client, tenantId, interview.id)
  validateScorecardSemantics({
    items: args.items,
    overall: args.overall,
    rejectReasons: args.reject_reasons ?? [],
    dimensionKeys: dimensionKeysOf(rubric),
    transcriptBasis: args.items[TRANSCRIPT_BASIS_KEY] as string,
    transcriptReady,
  })

  const provenance = await computeProvenance(client, tenantId, interview.id, interview.resume_version_id)
  const rationale = buildRationale(args.reject_reasons ?? [], args.revision?.revision_reason)
  const context: ResolvedContext = {
    actorId,
    tenantId,
    args,
    interview,
    interviewer,
    rubric,
    rubricResolution: resolution,
    provenance,
    transcriptReady,
    payloadHash,
    rationale,
    overall: args.overall,
    transcriptBasis: args.items[TRANSCRIPT_BASIS_KEY] as string,
  }

  // ---- 9) 已有 current 行？----
  const current = await loadCurrentScorecard(client, tenantId, interview.id, interviewer.id)
  let scorecardId: string
  let superseded: { scorecard_id: string; revision_no: number } | undefined

  try {
    if (current === undefined) {
      if (args.revision !== undefined) {
        // 修订指向的行不是当前行 → SCORECARD_ALREADY_SUPERSEDED（TC §2.5）。
        throw evalError(
          'ALREADY_SUBMITTED',
          'SCORECARD_ALREADY_SUPERSEDED',
          'revision.supersedes_scorecard_id 指向的不是当前面评行',
          { supersedes_scorecard_id: args.revision.supersedes_scorecard_id },
        )
      }
      scorecardId = randomUUID()
      const eventId = await insertInternalEvent(client, tenantId, idempotencyKey, scorecardId, {
        payload_hash: payloadHash,
        scorecard_id: scorecardId,
        interview_id: interview.id,
        interviewer_id: interviewer.id,
      })
      await insertSubmittedScorecard(client, context, scorecardId, eventId, 1, null)
    } else if (current.status === 'PENDING') {
      // 历史/别的路径留下的 PENDING 当前行 → 必须原地转正（TC §2.5、SC-45）。
      if (args.revision !== undefined) {
        if (args.revision.supersedes_scorecard_id !== current.id) {
          throw evalError(
            'ALREADY_SUBMITTED',
            'SCORECARD_ALREADY_SUPERSEDED',
            'revision.supersedes_scorecard_id 指向的不是当前行',
            { supersedes_scorecard_id: args.revision.supersedes_scorecard_id, current_scorecard_id: current.id },
          )
        }
        if (args.revision.expected_record_version !== current.record_version) {
          throw evalError('VERSION_CONFLICT', 'RECORD_VERSION_MISMATCH', '当前面评的 record_version 与入参不一致', {
            scorecard_id: current.id,
            expected_record_version: args.revision.expected_record_version,
            actual_record_version: current.record_version,
          })
        }
      }
      if (current.rubric_version_id !== rubric.id) {
        throw evalError(
          'INVALID_ARGS',
          'RUBRIC_MISMATCH',
          '这条 PENDING 面评绑的 rubric 与本次解析出的不一致（不得静默改绑，SC-42）',
          { pending_rubric_version_id: current.rubric_version_id, rubric_version_id: rubric.id },
        )
      }
      scorecardId = current.id
      await promotePendingScorecard(client, context, current)
    } else {
      // SUBMITTED / WAIVED 当前行：只能走修订（SC-04 / SC-17..20）。
      if (args.revision === undefined) {
        throw evalError(
          'ALREADY_SUBMITTED',
          'SCORECARD_ALREADY_SUBMITTED',
          '这位面试官对这场面试已经有一份当前面评；要改必须走 revision（SC-04/SC-18）',
          { scorecard_id: current.id, revision_no: current.revision_no, status: current.status },
        )
      }
      if (args.revision.supersedes_scorecard_id !== current.id) {
        throw evalError(
          'ALREADY_SUBMITTED',
          'SCORECARD_ALREADY_SUPERSEDED',
          'revision.supersedes_scorecard_id 指向的不是当前行',
          { supersedes_scorecard_id: args.revision.supersedes_scorecard_id, current_scorecard_id: current.id },
        )
      }
      superseded = { scorecard_id: current.id, revision_no: current.revision_no }
      scorecardId = await reviseScorecard(client, context, current, args.revision.expected_record_version)
    }
  } catch (error) {
    mapConstraintError(error)
  }

  // ---- 10) 读回库里真实状态（不硬编码 record_version / 事件 id）----
  const row = await loadScorecardById(client, tenantId, scorecardId)
  return buildOutput({
    row,
    interview,
    rubric,
    dimensionKeys: dimensionKeysOf(rubric),
    actorId,
    resolution,
    provenance,
    replayed: false,
    ...(superseded === undefined ? {} : { superseded }),
    rejectReasons: args.reject_reasons ?? [],
  })
}

/** 重放时从 rationale 解析 reject_reasons（解析不了就当空数组，只影响 warnings）。 */
function safeParseRejectReasons(rationale: string | null): unknown[] {
  try {
    return parseRejectReasonsFromRationale(rationale)
  } catch {
    return []
  }
}

/** 重放时还原 `superseded` 指针（旧行指向本行）。 */
async function supersededOf(
  client: DatabaseClient,
  tenantId: string,
  scorecardId: string,
): Promise<{ superseded?: { scorecard_id: string; revision_no: number } }> {
  const pointer = await loadSupersededBy(client, tenantId, scorecardId)
  return pointer === undefined ? {} : { superseded: pointer }
}

// =====================================================================
//  工具定义
// =====================================================================

/**
 * 造一个绑定配置的面评提交工具。
 *
 * `execute()` 用 `withActor(pool, cfg.actor_id, …)` 开事务（GUC = 配置里的 actor），
 * 然后调 `submitScorecardInTransaction(…, Date.now())`；`finally` 关池。
 * @param deps - `{ database }`（已解析的库配置）。
 */
export function createScorecardSubmitTool(deps: { database: ResolvedDatabaseConfig }): ReadonlyToolDefinition {
  const cfg = deps.database
  return {
    name: TOOL_NAME,
    description:
      'S10 scorecard submit: ONE interviewer submits their OWN interview scorecard (writes exactly one '
      + 'scorecard row, status=SUBMITTED). The author is the execution-context actor (never an argument); '
      + 'it must be a HUMAN interviewer registered for that interview. Rubric binding: the application-pinned '
      + 'version wins; if the application has no pinned version, rubric_version_id is required (no fallback), '
      + 'and the version must belong to the application job. items is an OBJECT keyed by rubric dimension key '
      + 'plus the reserved key transcript_basis (TRANSCRIPT|NO_TRANSCRIPT) and must cover 100% of the dimensions. '
      + 'assessment is MET|NOT_MET|NOT_OBSERVED|UNREADABLE; score (1..5) only with MET|NOT_MET; note is required '
      + 'with NOT_MET. overall is ADVANCE|HOLD|REJECT; REJECT needs 1..10 reject_reasons backed by NOT_MET '
      + 'dimensions (never by NOT_OBSERVED/UNREADABLE). Idempotent by idempotency_key. Re-submission goes through '
      + 'revision {supersedes_scorecard_id, expected_record_version, revision_reason} (new revision_no, old row kept). '
      + 'Errors: INVALID_ARGS / NOT_FOUND / INTERVIEWER_MISMATCH / ALREADY_SUBMITTED / VERSION_CONFLICT / '
      + 'EVIDENCE_INSUFFICIENT / DB_CONSTRAINT_VIOLATION with reason_code.',
    parameters: SUBMIT_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as {
          scorecard: Record<string, unknown>
          interview: Record<string, unknown>
          coverage: { dimensions_total: number; dimensions_assessed: number; by_assessment: Record<string, number> }
          labels: Record<string, string>
          warnings: { code: string }[]
          replayed: boolean
          superseded?: { scorecard_id: string; revision_no: number }
        }
        const coverage = v.coverage.by_assessment
        const lines = [
          `面评已提交（面评工具 ${CONTRACT_VERSION}）：scorecard ${String(v.scorecard.id)} `
            + `revision_no=${String(v.scorecard.revision_no)} status=SUBMITTED${v.replayed ? '（幂等重放，未新增行）' : ''}`,
          `面试：round_no=${String(v.interview.round_no)} slot_code=${String(v.interview.slot_code)} `
            + `status=${String(v.interview.status)}`,
          `rubric ${String(v.scorecard.rubric_version_id)}（${String(v.scorecard.rubric_resolution)}）`
            + ` transcript_basis=${String(v.scorecard.transcript_basis)}`,
          `维度覆盖 ${v.coverage.dimensions_assessed}/${v.coverage.dimensions_total}：`
            + `met=${coverage.met} not_met=${coverage.not_met} not_observed=${coverage.not_observed} unreadable=${coverage.unreadable}`,
          `标签：provenance=${v.labels.provenance} trigger=${v.labels.trigger} connection=${v.labels.connection}`,
          `审计：status_changed_by_actor_id=${String(v.scorecard.status_changed_by_actor_id)} `
            + `status_source_event_id=${String(v.scorecard.status_source_event_id)} `
            + `record_version=${String(v.scorecard.record_version)}`,
        ]
        if (v.superseded !== undefined) {
          lines.push(`修订：被替换的旧行 ${v.superseded.scorecard_id}（revision_no=${v.superseded.revision_no}）`)
        }
        if (v.warnings.length > 0) {
          lines.push(`提示：${v.warnings.map((warning) => warning.code).join(', ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const pool = createPool(cfg)
      try {
        return await withActor(pool, cfg.actor_id, (client) =>
          submitScorecardInTransaction(client, cfg, rawArgs, Date.now()))
      } finally {
        await closePool(pool)
      }
    },
  }
}
