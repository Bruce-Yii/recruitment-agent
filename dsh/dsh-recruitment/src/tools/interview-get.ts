// recruitment_interview_get —— 查一场（或一份申请下的若干场）面试：谁面、几点、
// 会议绑没绑、转写有没有、面评齐没齐（只读，直连 PG）。
//
// 契约：
//   * `contracts/interview/tool-contracts.md` §1（共同约定）、§2（本工具的形状）。
//   * `contracts/interview/transcript-rules.md` §4 TR-D —— `transcript.state` 的**唯一**
//     算法。本文件是它在这一侧的唯一实现，不许在别处再写一套（TR-D1）。
//   * `manual/interview-line/SPEC.md` §2（通用约定）、§3（本刀的范围与形状）。
//
// 六个"永远不做"（`tool-contracts.md` §0）：
//   1. 不写面评、不豁免（`scorecard` 一个字段都不碰）；
//   2. 不落 `decision`；
//   3. 不创建/取消外部日历事件，不发通知；
//   4. 不接受模型传入的 `tenant_id` / `actor_id`（`parseContractArgs` 直接拒）；
//   5. 不猜会议、不按标题/姓名/模糊时间匹配；
//   6. 不返回转写正文（只回状态、原因码、计数；`artifacts[]` 明细属后续切片）。
//
// 三个"必须"：
//   * **零写入**：读路径包在 `withReadOnly()` 里 —— `begin transaction read only`，
//     写语句会被数据库拒成 `25006 read_only_sql_transaction`，不是"源码里没写 INSERT"。
//   * **只读工具没有自己的时钟**：唯一的时间输入是显式 `as_of`（原样回显），
//     输出里没有 `evaluated_at` / `now`（`tool-contracts.md` §1.3）。
//   * **输出值里禁止 `null`**（SPEC §2 第 4 条）：数据库 NULL 一律**省略键**，
//     schema 只用 DSH 强制子集（没有 `type:'null'`、没有 type 数组）。

import { parseContractArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { checkAsOf, contractError } from './contract.ts'
import type { ContractErrorCode } from './contract.ts'
import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'

const TOOL_NAME = 'recruitment_interview_get'
const CONTRACT_VERSION = '1.0.0'

/** `transcript-rules.md` §4 的 `WAIT` 缺省值（分钟）。 */
const DEFAULT_WAIT_MINUTES = 120

/** `transcript.state` 的封闭取值（TR-D 序 1–7 的全部输出）。 */
export type TranscriptState =
  | 'MISSING'
  | 'PENDING'
  | 'READY'
  | 'PARTIAL'
  | 'AUTH_REQUIRED'
  | 'NEEDS_LINKING'
  | 'RETRYABLE_FAILED'

/** `transcript.reason_code` 的封闭取值（`transcript-rules.md` §5 命名空间表）。 */
export type TranscriptReasonCode =
  | 'NO_MEETING_BOUND'
  | 'CANONICAL_STATUS'
  | 'READY_NO_CANONICAL'
  | 'ONLY_PARTIAL'
  | 'ONLY_AUTH_REQUIRED'
  | 'NO_ARTIFACT_AFTER_WAIT'
  | 'WAITING'

/** `meeting_binding.state`（`scheduling-rules.md` §7.2）。 */
export type MeetingBindingState = 'BOUND_ACTIVE' | 'UNBOUND' | 'NONE_EXPECTED'

/** `warnings[].code` 的封闭取值（`tool-contracts.md` §2.4 中本刀实现的五个）。 */
export type InterviewWarningCode =
  | 'MEETING_NOT_BOUND'
  | 'MEETING_NOT_BOUND_OVERDUE'
  | 'NO_REQUIRED_EVALUATOR'
  | 'CANONICAL_MISSING'
  | 'MISSING_TRANSCRIPT_BASIS'

/** `evaluation.blockers[].code` 的封闭取值（本刀实现三个，见 SPEC §3.3）。 */
export type EvaluationBlockerCode = 'SCORECARD_PENDING' | 'RECORD_NOT_READY' | 'NO_REQUIRED_EVALUATOR'

/** `interviews[]` 里的面试官（`tool-contracts.md` §2.2 的 `interviewers[]`）。 */
export interface InterviewerValue {
  readonly interviewer_id: string
  readonly actor_id: string
  readonly display_name: string
  readonly role_in_interview: string
  readonly required_scorecard: boolean
  /** ISO-8601；数据库 NULL 时省略这个键（不写 null）。 */
  readonly scorecard_due_at?: string
  /**
   * 只取**当前**那一份（`superseded_by_scorecard_id is null`）。
   * 该面试官还没有面评时整个键省略（契约写作 null，本仓库规定值里不许有 null）。
   */
  readonly scorecard?: {
    readonly scorecard_id: string
    readonly status: string
    readonly revision_no: number
    readonly submitted_at?: string
    /** `scorecard.items.transcript_basis`；缺该键 → `UNKNOWN`（TR-E2）。 */
    readonly transcript_basis: string
  }
}

/** `meeting_binding.bindings[]`（`scheduling-rules.md` §7.2 要求逐条回列）。 */
export interface MeetingBindingValue {
  readonly binding_id: string
  readonly meeting_id: string
  readonly binding_method: string
  readonly bound_at: string
  readonly bound_by_actor_id?: string
  readonly provider: string
  readonly account_scope?: string
  readonly external_meeting_id?: string
  readonly calendar_event_id?: string
  readonly meeting_role: string
  readonly actual_start_at?: string
  readonly actual_end_at?: string
}

/** `meeting_binding` 恒为对象（`state` 必须能读到，不让调用方先判空）。 */
export interface MeetingBindingBlockValue {
  readonly state: MeetingBindingState
  readonly count: number
  readonly bindings: readonly MeetingBindingValue[]
}

/** `transcript`（SPEC §3.3：本刀只回状态、原因码、布尔，不回 artifacts[]/open_tasks[]）。 */
export interface TranscriptValue {
  readonly state: TranscriptState
  readonly reason_code: TranscriptReasonCode
  readonly no_transcript: boolean
}

/** `evaluation.blockers[]`。 */
export interface EvaluationBlockerValue {
  readonly code: EvaluationBlockerCode
  readonly interviewer_id?: string
  readonly actor_id?: string
  readonly interview_record_id?: string
}

/** `evaluation`：只回显计数与 blockers，**不写状态**（`scheduling-rules.md` §5.1）。 */
export interface EvaluationValue {
  readonly required_scorecards: number
  readonly submitted: number
  readonly waived: number
  readonly pending: number
  readonly evaluation_ready: boolean
  readonly blockers: readonly EvaluationBlockerValue[]
}

/** `warnings[]`：本次查询看到的问题，**不改变** `status`。 */
export interface InterviewWarningValue {
  readonly code: InterviewWarningCode
  readonly message: string
  readonly interview_id?: string
  readonly meeting_id?: string
}

/**
 * `interviews[]` 的一个元素（SPEC §3.3）。
 * **get 的 `interviews[]` 与 schedule 的 `interview` 是同一形状**——A 侧把它原样放进
 * `schedule.interview`，所以这里的字段增删会影响两个工具。
 */
export interface InterviewValue {
  readonly id: string
  readonly application_id: string
  readonly candidate_id: string
  readonly job_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly stage_code: string
  readonly status: string
  readonly record_version: number
  /** 数据库 NULL 时省略（`CANCELLED` / `NO_SHOW` 行允许没有 `scheduled_start_at`）。 */
  readonly scheduled_start_at?: string
  readonly scheduled_end_at?: string
  /** `(scheduled_end_at - scheduled_start_at) / 60000`；任一为空 → 省略。派生，不落库。 */
  readonly duration_minutes?: number
  readonly timezone: string
  readonly status_changed_at: string
  readonly is_overdue_start: boolean
  readonly interviewers: readonly InterviewerValue[]
  readonly meeting_binding: MeetingBindingBlockValue
  readonly transcript: TranscriptValue
  readonly evaluation: EvaluationValue
  readonly warnings: readonly InterviewWarningValue[]
}

// ---------------------------------------------------------------------------
// 参数与 schema
// ---------------------------------------------------------------------------

/** 入参（`tool-contracts.md` §2.1 / SPEC §3.1）。 */
const PARAMS: ParamMap = {
  interview_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Interview id, UUID text form. Mutually exclusive with application_id '
      + '(and with round_no — a single-interview query has no round filter).',
  },
  application_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Application id, UUID text form: return every interview under that application, '
      + 'ordered by (round_no, slot_code). Mutually exclusive with interview_id.',
  },
  round_no: {
    kind: 'integer',
    min: 1,
    max: 20,
    description: 'Only with application_id: keep just that round. round_no without application_id '
      + 'is rejected (MISSING_REQUIRED); round_no together with interview_id is rejected (MUTUALLY_EXCLUSIVE).',
  },
  require_transcript: {
    kind: 'boolean',
    description: 'Default false. true means the caller declares "no complete transcript, no result": '
      + 'if any returned interview has transcript.state != READY the whole call fails with NO_TRANSCRIPT, '
      + 'and reason_code is echoed verbatim from transcript.reason_code. Leave it false to get the '
      + 'transcript state as data (a not-yet-finished interview is normal, not an error).',
  },
  as_of: {
    kind: 'string',
    maxLength: 40,
    description: 'ISO-8601 timestamp WITH an offset (e.g. 2026-11-13T00:00:00+08:00), not later than the '
      + 'server clock. The only clock input of this tool: transcript.state and is_overdue_start are derived '
      + 'at this instant and it is echoed back verbatim. Defaults to the server clock.',
  },
}

/** 面试官数组元素的 schema（只用 DSH 强制子集；没有 type 数组、没有 null 分支）。 */
const INTERVIEWER_VALUE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    interviewer_id: { type: 'string', description: 'interviewer.id (not actor_id).' },
    actor_id: { type: 'string', description: 'actor.id of the interviewer.' },
    display_name: { type: 'string', description: 'actor.display_name, echoed verbatim.' },
    role_in_interview: { type: 'string', description: 'Label only; it never gates anything (D-33).' },
    required_scorecard: { type: 'boolean' },
    scorecard_due_at: { type: 'string', description: 'Omitted when the interviewer has no due_at.' },
    scorecard: {
      type: 'object',
      additionalProperties: false,
      description: 'The CURRENT scorecard (superseded_by_scorecard_id is null). Omitted when none exists.',
      properties: {
        scorecard_id: { type: 'string' },
        status: { type: 'string', enum: ['PENDING', 'SUBMITTED', 'WAIVED'] },
        revision_no: { type: 'integer' },
        submitted_at: { type: 'string', description: 'Omitted while the scorecard is still PENDING.' },
        transcript_basis: {
          type: 'string',
          description: 'Read from scorecard.items.transcript_basis; "UNKNOWN" when that key is missing '
            + '(which also raises the MISSING_TRANSCRIPT_BASIS warning, TR-E2).',
        },
      },
      required: ['scorecard_id', 'status', 'revision_no', 'transcript_basis'],
    },
  },
  required: ['interviewer_id', 'actor_id', 'display_name', 'role_in_interview', 'required_scorecard'],
}

/** 一条 active 会议绑定的 schema。 */
const MEETING_BINDING_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    binding_id: { type: 'string' },
    meeting_id: { type: 'string' },
    binding_method: { type: 'string', enum: ['SCHEDULED', 'MANUAL', 'EVENT_MATCH'] },
    bound_at: { type: 'string' },
    bound_by_actor_id: { type: 'string', description: 'Omitted when the DB has no actor (allowed for EVENT_MATCH).' },
    provider: { type: 'string' },
    account_scope: { type: 'string' },
    external_meeting_id: { type: 'string' },
    calendar_event_id: { type: 'string' },
    meeting_role: { type: 'string', enum: ['PRIMARY', 'CONTINUATION', 'REPLACED', 'CANCELLED'] },
    actual_start_at: { type: 'string' },
    actual_end_at: { type: 'string' },
  },
  required: ['binding_id', 'meeting_id', 'binding_method', 'bound_at', 'provider', 'meeting_role'],
}

/** `meeting_binding` 块：恒为对象，`count === bindings.length`。 */
const MEETING_BINDING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: ['BOUND_ACTIVE', 'UNBOUND', 'NONE_EXPECTED'] },
    count: { type: 'integer', description: 'Always equals bindings.length. count >= 2 is normal '
      + '(one scheduled meeting + one continuation), not a broken invariant.' },
    bindings: { type: 'array', items: MEETING_BINDING_ITEM_SCHEMA },
  },
  required: ['state', 'count', 'bindings'],
}

/** `transcript.state` 的封闭取值（TR-D）。 */
const TRANSCRIPT_STATES: readonly string[] = [
  'MISSING', 'PENDING', 'READY', 'PARTIAL', 'AUTH_REQUIRED', 'NEEDS_LINKING', 'RETRYABLE_FAILED',
]

/** `transcript.reason_code` 的封闭取值（TR-D）。 */
const TRANSCRIPT_REASON_CODES: readonly string[] = [
  'NO_MEETING_BOUND', 'CANONICAL_STATUS', 'READY_NO_CANONICAL', 'ONLY_PARTIAL',
  'ONLY_AUTH_REQUIRED', 'NO_ARTIFACT_AFTER_WAIT', 'WAITING',
]

const TRANSCRIPT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description: 'Derived at as_of by the single algorithm in transcript-rules.md §4 (TR-D). '
    + 'TR-D1: state is never stored, it is recomputed on every call. '
    + 'The artifact-level three-axis labels (provenance/trigger_mode/connection_state) and the '
    + 'artifacts[]/open_tasks[] detail are NOT part of this slice (SPEC §1).',
  properties: {
    state: { type: 'string', enum: [...TRANSCRIPT_STATES] },
    reason_code: {
      type: 'string',
      enum: [...TRANSCRIPT_REASON_CODES],
      description: 'Echoed verbatim into NO_TRANSCRIPT.reason_code when require_transcript=true.',
    },
    no_transcript: { type: 'boolean', description: 'state != READY. Same single source as NO_TRANSCRIPT.' },
  },
  required: ['state', 'reason_code', 'no_transcript'],
}

const EVALUATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description: 'Read-only echo. This tool never writes an evaluation state (scheduling-rules.md §5.1).',
  properties: {
    required_scorecards: { type: 'integer', description: 'Count of interviewers with required_scorecard=true.' },
    submitted: { type: 'integer', description: 'Current scorecards (superseded_by_scorecard_id is null) in SUBMITTED.' },
    waived: { type: 'integer', description: 'Current scorecards in WAIVED.' },
    pending: { type: 'integer', description: 'max(0, required_scorecards - submitted - waived).' },
    evaluation_ready: {
      type: 'boolean',
      description: 'required_scorecards > 0 AND pending == 0 AND a current interview_record is READY+VERIFIED.',
    },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', enum: ['SCORECARD_PENDING', 'RECORD_NOT_READY', 'NO_REQUIRED_EVALUATOR'] },
          interviewer_id: { type: 'string', description: 'Per-interviewer blockers only.' },
          actor_id: { type: 'string', description: 'Per-interviewer blockers only.' },
          interview_record_id: {
            type: 'string',
            description: 'RECORD_NOT_READY only, and only when a current record exists but is not READY+VERIFIED.',
          },
        },
        required: ['code'],
      },
    },
  },
  required: ['required_scorecards', 'submitted', 'waived', 'pending', 'evaluation_ready', 'blockers'],
}

const WARNINGS_SCHEMA: Record<string, unknown> = {
  type: 'array',
  description: 'Problems seen by THIS query. Warnings never change status: status is always "OK".',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: {
        type: 'string',
        enum: [
          'MEETING_NOT_BOUND', 'MEETING_NOT_BOUND_OVERDUE', 'NO_REQUIRED_EVALUATOR',
          'CANONICAL_MISSING', 'MISSING_TRANSCRIPT_BASIS',
        ],
      },
      message: { type: 'string' },
      interview_id: { type: 'string' },
      meeting_id: { type: 'string' },
    },
    required: ['code', 'message'],
  },
}

/**
 * `interviews[]` 元素的规范 schema（SPEC §3.3）。
 * A 侧 `recruitment_interview_schedule.output.schema.interview` 直接用同一份 —— 两个工具
 * 的元素形状必须一致，所以这里导出而不是各写一份。
 */
export const INTERVIEW_VALUE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description: 'One interview. Same shape as recruitment_interview_schedule.interview (§3.3).',
  properties: {
    id: { type: 'string' },
    application_id: { type: 'string' },
    candidate_id: { type: 'string' },
    job_id: { type: 'string' },
    round_no: { type: 'integer' },
    slot_code: { type: 'string' },
    stage_code: { type: 'string', description: 'S8 for interviews created by this stage (0006 sets the default).' },
    status: { type: 'string' },
    record_version: { type: 'integer' },
    scheduled_start_at: {
      type: 'string',
      description: 'Omitted only when the row has no scheduled_start_at (possible for CANCELLED/NO_SHOW rows: '
        + 'ck_interview_scheduled requires it only for scheduled statuses).',
    },
    scheduled_end_at: { type: 'string' },
    duration_minutes: { type: 'integer', description: 'Derived: (end - start) / 60000. Omitted when either is absent.' },
    timezone: { type: 'string', description: 'Display only.' },
    status_changed_at: { type: 'string' },
    is_overdue_start: {
      type: 'boolean',
      description: 'as_of > scheduled_start_at AND status in {SCHEDULED, RESCHEDULED}.',
    },
    interviewers: {
      type: 'array',
      description: 'Stable order: actor_id ascending (never the DB return order).',
      items: INTERVIEWER_VALUE_SCHEMA,
    },
    meeting_binding: MEETING_BINDING_SCHEMA,
    transcript: TRANSCRIPT_SCHEMA,
    evaluation: EVALUATION_SCHEMA,
    warnings: WARNINGS_SCHEMA,
  },
  required: [
    'id', 'application_id', 'candidate_id', 'job_id', 'round_no', 'slot_code', 'stage_code', 'status',
    'record_version', 'timezone', 'status_changed_at', 'is_overdue_start',
    'interviewers', 'meeting_binding', 'transcript', 'evaluation', 'warnings',
  ],
}

/** 顶层输出 schema（SPEC §3.4）。 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    // 恒为 "OK" / true：警告不改变 status（§2.4）。不用 `const`，与 job-get 的写法一致，
    // 避免依赖宿主校验器对 `const` 的支持（description 已经写死这个事实）。
    status: { type: 'string', description: 'Always "OK": warnings are facts about this query, not a failure.' },
    read_only: { type: 'boolean', description: 'Always true: this tool never writes.' },
    labels: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['CONNECTED', 'NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
    },
    as_of: { type: 'string', description: 'The as_of argument echoed verbatim (or the server clock ISO text).' },
    query: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['BY_INTERVIEW', 'BY_APPLICATION'] },
        interview_id: { type: 'string' },
        application_id: { type: 'string' },
        round_no: { type: 'integer' },
      },
      required: ['mode'],
    },
    count: { type: 'integer', description: 'Always equals interviews.length; there is no separate total.' },
    interviews: { type: 'array', items: INTERVIEW_VALUE_SCHEMA },
  },
  required: ['tool', 'contract_version', 'status', 'read_only', 'labels', 'as_of', 'query', 'count', 'interviews'],
}

// ---------------------------------------------------------------------------
// 数据库行
// ---------------------------------------------------------------------------

/** `interview` + 它所属 `application` 的投影。 */
interface InterviewRow {
  readonly id: string
  readonly application_id: string
  readonly candidate_id: string
  readonly job_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly stage_code: string
  readonly status: string
  readonly record_version: number
  readonly scheduled_start_at: string | Date | null
  readonly scheduled_end_at: string | Date | null
  readonly timezone: string
  readonly status_changed_at: string | Date
}

/** `interviewer` join `actor` 的投影。 */
interface InterviewerRow {
  readonly interviewer_id: string
  readonly actor_id: string
  readonly display_name: string
  readonly role_in_interview: string
  readonly required_scorecard: boolean
  readonly scorecard_due_at: string | Date | null
}

/** 当前面评（`superseded_by_scorecard_id is null`）。 */
interface ScorecardRow {
  readonly id: string
  readonly interviewer_id: string
  readonly status: string
  readonly revision_no: number
  readonly submitted_at: string | Date | null
  readonly items: unknown
}

/** active 绑定 join `meeting` 的投影。 */
interface BindingRow {
  readonly binding_id: string
  readonly meeting_id: string
  readonly binding_method: string
  readonly bound_at: string | Date
  readonly bound_by_actor_id: string | null
  readonly provider: string
  readonly account_scope: string | null
  readonly external_meeting_id: string | null
  readonly calendar_event_id: string | null
  readonly meeting_role: string
  readonly actual_start_at: string | Date | null
  readonly actual_end_at: string | Date | null
}

/** `transcript_artifact` 的投影（TR-D 只看这几列）。 */
interface ArtifactRow {
  readonly id: string
  readonly meeting_id: string
  readonly transcript_status: string
  readonly is_complete: boolean
  readonly is_canonical: boolean
  readonly source_revision: number
  readonly variant_type: string
}

/** 当前 `interview_record`。 */
interface RecordRow {
  readonly id: string
  readonly status: string
  readonly verification_status: string
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** `timestamptz` 可能是 pg 给的 `Date`，也可能是测试造的字符串；空 → NaN。 */
function toMs(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN
  if (value instanceof Date) return value.getTime()
  return Date.parse(value)
}

/** 时间列 → ISO 文本（输出统一 `toISOString()`，§2 第 5 条）。 */
function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/** `max(asOf > x)` 判定用：只在 `value` 真的存在时参与比较。 */
function isAfter(instantMs: number, boundary: string | Date | null): boolean {
  const parsed = toMs(boundary)
  return Number.isFinite(parsed) && instantMs > parsed
}

/** 面评 `items.transcript_basis`：有则回原值，缺则 `UNKNOWN`（TR-E2）。 */
function transcriptBasisOf(items: unknown): { basis: string; present: boolean } {
  if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
    const raw = (items as Record<string, unknown>).transcript_basis
    if (typeof raw === 'string' && raw.length > 0) return { basis: raw, present: true }
  }
  return { basis: 'UNKNOWN', present: false }
}

/** 规范模式匹配到的 `transcript_status` → `transcript.state`（TR-D 序 2 的 map）。 */
function mapCanonicalStatus(status: string): TranscriptState {
  if (status === 'READY') return 'READY'
  if (status === 'PARTIAL') return 'PARTIAL'
  if (status === 'AUTH_REQUIRED') return 'AUTH_REQUIRED'
  if (status === 'NEEDS_LINKING') return 'NEEDS_LINKING'
  if (status === 'RETRYABLE_FAILED') return 'RETRYABLE_FAILED'
  return 'PENDING'
}

/** 一个会议是不是 TR-D 里的 `M(i)`（`REPLACED`/`CANCELLED` 不进，TR-D4）。 */
function isTranscriptMeeting(role: string): boolean {
  return role === 'PRIMARY' || role === 'CONTINUATION'
}

/**
 * TR-D 的派生结果。
 * @property state - `transcript.state`。
 * @property reasonCode - `transcript.reason_code`（与 `NO_TRANSCRIPT` 透传的是同一个值）。
 * @property canonicalMissing - 命中了序 3（有 READY 无 canonical）→ 触发 `CANONICAL_MISSING` 警告。
 * @property meetingsTotal - `M(i)` 的大小（`NO_TRANSCRIPT.detail.meetings_total`）。
 */
interface TranscriptDerivation {
  readonly state: TranscriptState
  readonly reasonCode: TranscriptReasonCode
  readonly canonicalMissing: boolean
  readonly meetingsTotal: number
}

/**
 * `transcript-rules.md` §4 的 TR-D 七条：**先算集合，再按优先级取第一个命中**。
 *
 * 顺序本身是规则的一部分，所以这里写成一条 if 链，不做"更聪明"的合并：
 *   1. `M(i)=∅ ∧ as_of > scheduled_start_at` → `MISSING/NO_MEETING_BOUND`
 *   2. `CANON(i)≠∅` → `map(canonical.transcript_status)` + `CANONICAL_STATUS`
 *   3. `∃a∈ART: READY ∧ is_complete` → `READY/READY_NO_CANONICAL`（+ 警告）
 *   4. `∃a∈ART: PARTIAL` → `PARTIAL/ONLY_PARTIAL`
 *   5. `∃a∈ART: AUTH_REQUIRED` → `AUTH_REQUIRED/ONLY_AUTH_REQUIRED`
 *   6. `ART=∅ ∧ as_of > max(actual_end_at, scheduled_end_at) + WAIT` → `MISSING/NO_ARTIFACT_AFTER_WAIT`
 *   7. 其余 → `PENDING/WAITING`
 *
 * @param input.asOfMs - 基准时刻（入参 `as_of`）。
 * @param input.interview - 面试行（序 1 用 `scheduled_start_at`，序 6 用 `scheduled_end_at`）。
 * @param input.transcriptMeetings - `M(i)`（active binding ∩ `meeting_role ∈ {PRIMARY,CONTINUATION}`）。
 * @param input.artifacts - `ART(i)`（`M(i)` 的会议下的全部产物，含非 canonical）。
 * @param input.waitMinutes - `WAIT`（缺省 120，可被 `transcript_policy.wait_minutes` 覆盖）。
 */
function deriveTranscript(input: {
  readonly asOfMs: number
  readonly interview: InterviewRow
  readonly transcriptMeetings: readonly BindingRow[]
  readonly artifacts: readonly ArtifactRow[]
  readonly waitMinutes: number
}): TranscriptDerivation {
  const { asOfMs, interview, transcriptMeetings, artifacts, waitMinutes } = input
  const meetingsTotal = transcriptMeetings.length

  // 序 1：没有任何可产材料的会议，而面试已经该开始了 → 这是终态缺失，不是"还在等"。
  if (meetingsTotal === 0 && isAfter(asOfMs, interview.scheduled_start_at)) {
    return { state: 'MISSING', reasonCode: 'NO_MEETING_BOUND', canonicalMissing: false, meetingsTotal }
  }

  const canonical = artifacts.filter((artifact) => artifact.is_canonical)

  // 序 2：有 canonical 就完全由它的 status 决定（canonical 是"本轮唯一"的那一版）。
  if (canonical.length > 0) {
    // 每 meeting 至多一个 canonical（uq_transcript_artifact_canonical），但 1 面试 : N 会议，
    // 所以 CANON(i) 可能多于一个。DB 只保证"会议侧唯一"，不替我们排序：
    // 这里取 (meeting_role 主会优先 → meeting_id → source_revision → variant_type) 的第一条，
    // 保证同一 (数据快照, as_of) 逐字节相同的输出（契约 §1.3 幂等）。
    const roleRank = new Map<string, number>()
    for (const [index, meeting] of transcriptMeetings.entries()) roleRank.set(meeting.meeting_id, index)
    const preferred = [...canonical].sort((left, right) => {
      const leftRank = roleRank.get(left.meeting_id) ?? Number.MAX_SAFE_INTEGER
      const rightRank = roleRank.get(right.meeting_id) ?? Number.MAX_SAFE_INTEGER
      if (leftRank !== rightRank) return leftRank - rightRank
      if (left.meeting_id !== right.meeting_id) return left.meeting_id < right.meeting_id ? -1 : 1
      if (left.source_revision !== right.source_revision) return left.source_revision - right.source_revision
      return left.variant_type < right.variant_type ? -1 : left.variant_type > right.variant_type ? 1 : 0
    })[0] as ArtifactRow
    return {
      state: mapCanonicalStatus(preferred.transcript_status),
      reasonCode: 'CANONICAL_STATUS',
      canonicalMissing: false,
      meetingsTotal,
    }
  }

  // 序 3：有完整原文但没人标 canonical → 能读，但"本轮唯一"缺失，必须可见。
  if (artifacts.some((artifact) => artifact.transcript_status === 'READY' && artifact.is_complete)) {
    return { state: 'READY', reasonCode: 'READY_NO_CANONICAL', canonicalMissing: true, meetingsTotal }
  }

  // 序 4 / 序 5：只拿到一部分，或只拿到"没有权限"。
  if (artifacts.some((artifact) => artifact.transcript_status === 'PARTIAL')) {
    return { state: 'PARTIAL', reasonCode: 'ONLY_PARTIAL', canonicalMissing: false, meetingsTotal }
  }
  if (artifacts.some((artifact) => artifact.transcript_status === 'AUTH_REQUIRED')) {
    return { state: 'AUTH_REQUIRED', reasonCode: 'ONLY_AUTH_REQUIRED', canonicalMissing: false, meetingsTotal }
  }

  // 序 6：会议确实结束了、也等过了 WAIT，却一个产物都没有 → 终态缺失（TR-F3 的入口）。
  if (artifacts.length === 0) {
    let latestEndMs = toMs(interview.scheduled_end_at)
    for (const meeting of transcriptMeetings) {
      const endMs = toMs(meeting.actual_end_at)
      if (Number.isFinite(endMs) && (!Number.isFinite(latestEndMs) || endMs > latestEndMs)) latestEndMs = endMs
    }
    if (Number.isFinite(latestEndMs) && asOfMs > latestEndMs + waitMinutes * 60_000) {
      return { state: 'MISSING', reasonCode: 'NO_ARTIFACT_AFTER_WAIT', canonicalMissing: false, meetingsTotal }
    }
  }

  // 序 7：会议还没结束，或还在等待窗内 —— 只需等，不是缺失（TR-D3 把两者分开）。
  return { state: 'PENDING', reasonCode: 'WAITING', canonicalMissing: false, meetingsTotal }
}

/**
 * 读 `transcript_policy.wait_minutes`（缺省 120）。
 *
 * v1.0 只读 `config_key='transcript_policy'` 的最新版本，不按 scope 分层 —— 本刀不做
 * 部门/岗位/阶段级覆盖；读不到或值不合法一律回缺省，不让配置缺失把 `transcript.state`
 * 变成另一个算法。
 * @param client - 事务内客户端。
 * @param tenantId - 租户（只来自配置）。
 * @param asOfIso - 配置必须在此时刻有效。
 */
async function readWaitMinutes(client: DatabaseClient, tenantId: string, asOfIso: string): Promise<number> {
  const { rows } = await client.query<{ wait_minutes: string | null }>(
    `select payload ->> 'wait_minutes' as wait_minutes
       from recruitment.business_config
      where tenant_id = $1
        and config_key = 'transcript_policy'
        and effective_from <= $2::timestamptz
        and (effective_to is null or effective_to > $2::timestamptz)
      order by version_no desc
      limit 1`,
    [tenantId, asOfIso],
  )
  const raw = rows[0]?.wait_minutes
  if (raw === null || raw === undefined) return DEFAULT_WAIT_MINUTES
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WAIT_MINUTES
}

/** `readInterviewValue` 的完整结果 + 只给本文件用的派生量（`meetings_total`）。 */
interface LoadedInterview {
  readonly value: InterviewValue
  readonly meetingsTotal: number
}

/**
 * 查一场面试并组装 §3.3 的值。
 *
 * **故意不校验 `interviewId` 的 UUID**：schedule 侧刚 INSERT 出来的 id 直接传进来，
 * 格式校验属于入参层（`getInTransaction` / `execute`）。
 * @param client - 只读事务内的客户端。
 * @param tenantId - 租户 id（只来自 `ResolvedDatabaseConfig`）。
 * @param interviewId - `interview.id`。
 * @param asOfIso - 派生状态的基准时刻（带偏移的 ISO-8601）。
 * @throws RecruitmentToolError - 查不到（含跨租户）→ `NOT_FOUND(INTERVIEW_NOT_FOUND)`。
 */
async function loadInterview(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  asOfIso: string,
): Promise<LoadedInterview> {
  const asOfMs = Date.parse(asOfIso)
  if (!Number.isFinite(asOfMs)) {
    throw contractError('INVALID_ARGS', {
      reason_code: 'AS_OF_FORMAT',
      message: 'as_of 必须是带时区偏移的 ISO-8601 时间（如 2026-11-13T00:00:00+08:00）',
      detail: { as_of: asOfIso },
    })
  }

  const interviewResult = await client.query<InterviewRow>(
    `select i.id, i.application_id, a.candidate_id, a.job_id,
            i.round_no, i.slot_code, i.stage_code, i.status, i.record_version,
            i.scheduled_start_at, i.scheduled_end_at, i.timezone, i.status_changed_at
       from recruitment.interview i
       join recruitment.application a
         on a.id = i.application_id and a.tenant_id = i.tenant_id
      where i.tenant_id = $1 and i.id = $2`,
    [tenantId, interviewId],
  )
  const interview = interviewResult.rows[0]
  // 跨租户一律 NOT_FOUND：不确认对方租户里那一行是否存在（IR-C7 同构）。
  if (interview === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'INTERVIEW_NOT_FOUND',
      message: `该租户下没有面试 ${interviewId}`,
      detail: { interview_id: interviewId },
    })
  }

  const interviewerRows = (await client.query<InterviewerRow>(
    `select iv.id as interviewer_id, iv.actor_id, ac.display_name,
            iv.role_in_interview, iv.required_scorecard, iv.scorecard_due_at
       from recruitment.interviewer iv
       join recruitment.actor ac
         on ac.id = iv.actor_id and ac.tenant_id = iv.tenant_id
      where iv.tenant_id = $1 and iv.interview_id = $2
      order by iv.actor_id, iv.id`,
    [tenantId, interviewId],
  )).rows

  // 只取当前那一份面评（uq_scorecard_current 保证每 (interview, interviewer) 至多一行）。
  const scorecardRows = (await client.query<ScorecardRow>(
    `select s.id, s.interviewer_id, s.status, s.revision_no, s.submitted_at, s.items
       from recruitment.scorecard s
      where s.tenant_id = $1 and s.interview_id = $2
        and s.superseded_by_scorecard_id is null`,
    [tenantId, interviewId],
  )).rows
  const scorecardByInterviewer = new Map<string, ScorecardRow>()
  for (const row of scorecardRows) scorecardByInterviewer.set(row.interviewer_id, row)

  // 全部 active 绑定（unbound_at is null），一条也不藏：1 面试 : N 会议是正常现象。
  const bindingRows = (await client.query<BindingRow>(
    `select b.id as binding_id, b.meeting_id, b.binding_method, b.bound_at, b.bound_by_actor_id,
            m.provider, m.account_scope, m.external_meeting_id, m.calendar_event_id, m.meeting_role,
            m.actual_start_at, m.actual_end_at
       from recruitment.meeting_binding b
       join recruitment.meeting m
         on m.id = b.meeting_id and m.tenant_id = b.tenant_id
      where b.tenant_id = $1 and b.interview_id = $2 and b.unbound_at is null`,
    [tenantId, interviewId],
  )).rows

  // 输出要稳定排序，不许依赖 DB 返回顺序（契约 §2.3）：排序一律在 JS 里按码点做。
  const bindings = [...bindingRows].sort((left, right) => {
    if (left.meeting_role !== right.meeting_role) return left.meeting_role < right.meeting_role ? -1 : 1
    const leftBound = toMs(left.bound_at)
    const rightBound = toMs(right.bound_at)
    if (leftBound !== rightBound) return leftBound - rightBound
    return left.meeting_id < right.meeting_id ? -1 : left.meeting_id > right.meeting_id ? 1 : 0
  })

  const bindingsValue: MeetingBindingValue[] = bindings.map((binding) => ({
    binding_id: binding.binding_id,
    meeting_id: binding.meeting_id,
    binding_method: binding.binding_method,
    bound_at: iso(binding.bound_at),
    ...(binding.bound_by_actor_id === null ? {} : { bound_by_actor_id: binding.bound_by_actor_id }),
    provider: binding.provider,
    ...(binding.account_scope === null ? {} : { account_scope: binding.account_scope }),
    ...(binding.external_meeting_id === null ? {} : { external_meeting_id: binding.external_meeting_id }),
    ...(binding.calendar_event_id === null ? {} : { calendar_event_id: binding.calendar_event_id }),
    meeting_role: binding.meeting_role,
    ...(binding.actual_start_at === null ? {} : { actual_start_at: iso(binding.actual_start_at) }),
    ...(binding.actual_end_at === null ? {} : { actual_end_at: iso(binding.actual_end_at) }),
  }))

  // scheduling-rules §7.2：|BIND| >= 1 → BOUND_ACTIVE；0 且状态属"会开"的三个 → UNBOUND；
  // 0 且 CANCELLED/NO_SHOW → NONE_EXPECTED。其余状态在 |BIND|=0 时按 UNBOUND 处理
  // （终态也没绑上会议这件事必须可见，不能因为状态不在枚举里就变成"没有这回事"）。
  const meetingBindingState: MeetingBindingState = bindings.length > 0
    ? 'BOUND_ACTIVE'
    : interview.status === 'CANCELLED' || interview.status === 'NO_SHOW'
      ? 'NONE_EXPECTED'
      : 'UNBOUND'

  // M(i)：只有 PRIMARY / CONTINUATION 进（TR-D4：REPLACED/CANCELLED 不进）。
  const transcriptMeetings = bindings.filter((binding) => isTranscriptMeeting(binding.meeting_role))
  const meetingIds = [...new Set(transcriptMeetings.map((binding) => binding.meeting_id))]

  let artifacts: ArtifactRow[] = []
  if (meetingIds.length > 0) {
    artifacts = (await client.query<ArtifactRow>(
      `select a.id, a.meeting_id, a.transcript_status, a.is_complete, a.is_canonical,
              a.source_revision, a.variant_type
         from recruitment.transcript_artifact a
        where a.tenant_id = $1 and a.meeting_id = any($2::uuid[])`,
      [tenantId, meetingIds],
    )).rows
  }

  const waitMinutes = await readWaitMinutes(client, tenantId, asOfIso)
  const derivation = deriveTranscript({ asOfMs, interview, transcriptMeetings, artifacts, waitMinutes })

  // 当前的面试记录（uq_interview_record_current 保证至多一行）。
  const recordRow = (await client.query<RecordRow>(
    `select r.id, r.status, r.verification_status
       from recruitment.interview_record r
      where r.tenant_id = $1 and r.interview_id = $2 and r.is_current`,
    [tenantId, interviewId],
  )).rows[0]

  const interviewers: InterviewerValue[] = [...interviewerRows]
    .sort((left, right) => (left.actor_id < right.actor_id ? -1 : left.actor_id > right.actor_id ? 1 : 0))
    .map((row) => {
      const scorecard = scorecardByInterviewer.get(row.interviewer_id)
      return {
        interviewer_id: row.interviewer_id,
        actor_id: row.actor_id,
        display_name: row.display_name,
        role_in_interview: row.role_in_interview,
        required_scorecard: row.required_scorecard,
        ...(row.scorecard_due_at === null ? {} : { scorecard_due_at: iso(row.scorecard_due_at) }),
        ...(scorecard === undefined ? {} : {
          scorecard: {
            scorecard_id: scorecard.id,
            status: scorecard.status,
            revision_no: scorecard.revision_no,
            ...(scorecard.submitted_at === null ? {} : { submitted_at: iso(scorecard.submitted_at) }),
            transcript_basis: transcriptBasisOf(scorecard.items).basis,
          },
        }),
      }
    })

  // ---- evaluation（只回显，不写状态）-------------------------------------
  const requiredInterviewers = interviewers.filter((row) => row.required_scorecard)
  const required = requiredInterviewers.length
  const requiredInterviewerIds = new Set(requiredInterviewers.map((row) => row.interviewer_id))
  let submitted = 0
  let waived = 0
  let missingBasis = false
  for (const row of scorecardRows) {
    // 计数只数 `required_scorecard=true` 的面试官 —— 与下面的 blockers 用**同一个集合**。
    // 否则"非 required 的面试官交了评、required 的没交"会出现 pending=0 却仍有
    // SCORECARD_PENDING blocker 的自相矛盾（实现自检时发现的真实缺口）。
    if (requiredInterviewerIds.has(row.interviewer_id)) {
      if (row.status === 'SUBMITTED') submitted += 1
      else if (row.status === 'WAIVED') waived += 1
    }
    // TR-E2 只约束"已提交"的面评：WAIVED 那一份本来就没有 items（它有 waive_reason），
    // 给它报 MISSING_TRANSCRIPT_BASIS 就是假警报。
    if (row.status === 'SUBMITTED' && !transcriptBasisOf(row.items).present) missingBasis = true
  }
  // pending 与 submitted/waived 同集合，三者恒满足 `required = submitted + waived + pending`。
  const pending = Math.max(0, required - submitted - waived)

  const blockers: EvaluationBlockerValue[] = []
  for (const row of requiredInterviewers) {
    const scorecard = scorecardByInterviewer.get(row.interviewer_id)
    if (scorecard === undefined || scorecard.status === 'PENDING') {
      blockers.push({
        code: 'SCORECARD_PENDING',
        interviewer_id: row.interviewer_id,
        actor_id: row.actor_id,
      })
    }
  }
  if (required === 0) blockers.push({ code: 'NO_REQUIRED_EVALUATOR' })
  const recordOk = recordRow !== undefined
    && recordRow.status === 'READY'
    && recordRow.verification_status === 'VERIFIED'
  if (!recordOk) {
    blockers.push({
      code: 'RECORD_NOT_READY',
      ...(recordRow === undefined ? {} : { interview_record_id: recordRow.id }),
    })
  }
  const evaluationReady = required > 0 && pending === 0 && recordOk

  // ---- warnings（不改变 status；status 恒 "OK"）---------------------------
  const startMs = toMs(interview.scheduled_start_at)
  const endMs = toMs(interview.scheduled_end_at)
  const isOverdueStart = Number.isFinite(startMs)
    && asOfMs > startMs
    && (interview.status === 'SCHEDULED' || interview.status === 'RESCHEDULED')

  const warnings: InterviewWarningValue[] = []
  if (meetingBindingState === 'UNBOUND') {
    warnings.push({
      code: 'MEETING_NOT_BOUND',
      message: '该场面试没有绑定任何会议，S9 取不到材料（补绑任务到期后应升级为人工待办）',
      interview_id: interview.id,
    })
    if (isOverdueStart) {
      // §2.4 的两条触发条件在"逾期"时同时成立，所以两条都出（逾期是升级信号，不是替换）。
      warnings.push({
        code: 'MEETING_NOT_BOUND_OVERDUE',
        message: '该场面试已过开始时间且仍未绑定任何会议',
        interview_id: interview.id,
      })
    }
  }
  if (required === 0) {
    warnings.push({
      code: 'NO_REQUIRED_EVALUATOR',
      message: '该场面试没有任何需要交面评的面试官（无人需交评却可能进 Evaluation Ready）',
      interview_id: interview.id,
    })
  }
  if (derivation.canonicalMissing) {
    warnings.push({
      code: 'CANONICAL_MISSING',
      message: '已有完整转写产物，但没有一份被标为 canonical（本轮唯一版本缺失）',
      interview_id: interview.id,
    })
  }
  if (missingBasis) {
    warnings.push({
      code: 'MISSING_TRANSCRIPT_BASIS',
      message: '面评 items 里没有 transcript_basis，无法判断该面评是否基于原文（违反 TR-E2）',
      interview_id: interview.id,
    })
  }

  const value: InterviewValue = {
    id: interview.id,
    application_id: interview.application_id,
    candidate_id: interview.candidate_id,
    job_id: interview.job_id,
    round_no: interview.round_no,
    slot_code: interview.slot_code,
    stage_code: interview.stage_code,
    status: interview.status,
    record_version: interview.record_version,
    ...(interview.scheduled_start_at === null ? {} : { scheduled_start_at: iso(interview.scheduled_start_at) }),
    ...(interview.scheduled_end_at === null ? {} : { scheduled_end_at: iso(interview.scheduled_end_at) }),
    ...(Number.isFinite(startMs) && Number.isFinite(endMs)
      ? { duration_minutes: Math.round((endMs - startMs) / 60_000) }
      : {}),
    timezone: interview.timezone,
    status_changed_at: iso(interview.status_changed_at),
    is_overdue_start: isOverdueStart,
    interviewers,
    meeting_binding: { state: meetingBindingState, count: bindingsValue.length, bindings: bindingsValue },
    transcript: {
      state: derivation.state,
      reason_code: derivation.reasonCode,
      no_transcript: derivation.state !== 'READY',
    },
    evaluation: {
      required_scorecards: required,
      submitted,
      waived,
      pending,
      evaluation_ready: evaluationReady,
      blockers,
    },
    warnings,
  }

  return { value, meetingsTotal: derivation.meetingsTotal }
}

/**
 * 读一场面试的规范值（**A 侧 `recruitment_interview_schedule` 依赖这个函数**：
 * 写完立刻读回，作为"写完即可查"的自证）。
 *
 * 不校验 `interviewId` 的 UUID —— 调用方传的是刚从 `INSERT ... RETURNING id` 拿到的真 id；
 * 格式校验在入参层（`getInTransaction` / `execute`）。
 * @param client - 只读事务（或写事务）内的客户端。
 * @param tenantId - 租户 id（只来自 `ResolvedDatabaseConfig`）。
 * @param interviewId - `interview.id`，任何格式。
 * @param asOfIso - 派生状态的基准时刻（带偏移的 ISO-8601）。
 * @returns SPEC §3.3 的那一个元素（不含 null 值）。
 * @throws RecruitmentToolError - 查不到（含跨租户）→ `NOT_FOUND(INTERVIEW_NOT_FOUND)`。
 */
export async function readInterviewValue(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  asOfIso: string,
): Promise<InterviewValue> {
  const loaded = await loadInterview(client, tenantId, interviewId, asOfIso)
  return loaded.value
}

/**
 * 在**已有事务**里跑完整查询（测试与生产走同一条代码路径）。
 *
 * 入参在这里自己解析/校验（不把校验散到 `execute` 里），错误码按
 * `tool-contracts.md` §2.1 的互斥/依赖表逐条判定。
 * @param client - `withReadOnly()` 给的客户端。
 * @param config - 已解析的数据库配置（`tenant_id` 只从这里来）。
 * @param rawArgs - 模型给的 arguments。
 * @param nowMs - 服务端当前时刻（毫秒）；测试可注入，缺省 `Date.now()`。
 * @returns SPEC §3.4 的顶层输出值。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `NOT_FOUND` / `NO_TRANSCRIPT`。
 */
export async function getInTransaction(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  rawArgs: unknown,
  nowMs?: number,
): Promise<Record<string, unknown>> {
  const now = nowMs ?? Date.now()
  // 未知键 / 类型 / UUID / tenant_id / actor_id 由 parseContractArgs 一次性收集抛出。
  const args = parseContractArgs(PARAMS, rawArgs)

  const interviewId = args.interview_id as string | undefined
  const applicationId = args.application_id as string | undefined
  const roundNo = args.round_no as number | undefined
  const requireTranscript = args.require_transcript === true

  // 互斥与依赖（§2.1 的四行表，顺序也照抄：先"两个都给"，再"都没给"，最后"单场 + 轮次"）。
  if (interviewId !== undefined && applicationId !== undefined) {
    throw contractError('INVALID_ARGS', {
      reason_code: 'MUTUALLY_EXCLUSIVE',
      message: 'interview_id 与 application_id 只能给一个',
      detail: { given: { interview_id: interviewId, application_id: applicationId } },
    })
  }
  if (interviewId === undefined && applicationId === undefined) {
    throw contractError('INVALID_ARGS', {
      reason_code: 'MISSING_REQUIRED',
      message: roundNo === undefined
        ? '必须给 interview_id 或 application_id 之一'
        : '只给 round_no 不行：它依附 application_id',
      detail: {
        required_one_of: ['interview_id', 'application_id'],
        ...(roundNo === undefined ? {} : { given: { round_no: roundNo } }),
      },
    })
  }
  if (interviewId !== undefined && roundNo !== undefined) {
    throw contractError('INVALID_ARGS', {
      reason_code: 'MUTUALLY_EXCLUSIVE',
      message: 'interview_id 与 round_no 不能同时给：单场查询和轮次过滤语义冲突',
      detail: { given: { interview_id: interviewId, round_no: roundNo } },
    })
  }

  const rawAsOf = typeof args.as_of === 'string' ? args.as_of : undefined
  let asOfIso: string
  if (rawAsOf !== undefined) {
    const checked = checkAsOf(rawAsOf, now)
    if (checked.ok !== true) {
      throw contractError('INVALID_ARGS', {
        reason_code: checked.reason_code,
        message: checked.message,
        detail: { as_of: rawAsOf },
      })
    }
    // as_of 原样回显（不做时区归一化）：调用方要能唯一定位它给的那个时刻。
    asOfIso = rawAsOf
  } else {
    asOfIso = new Date(now).toISOString()
  }

  const tenantId = config.tenant_id
  const loaded: LoadedInterview[] = []
  let query: Record<string, unknown>

  if (interviewId !== undefined) {
    query = { mode: 'BY_INTERVIEW', interview_id: interviewId }
    loaded.push(await loadInterview(client, tenantId, interviewId, asOfIso))
  } else {
    // 先确认申请存在（否则"这份申请没有场次"和"这份申请不存在"会被混成一个空数组）。
    const applicationExists = await client.query<{ id: string }>(
      'select id from recruitment.application where tenant_id = $1 and id = $2',
      [tenantId, applicationId],
    )
    if (applicationExists.rows.length === 0) {
      throw contractError('NOT_FOUND', {
        reason_code: 'APPLICATION_NOT_FOUND',
        message: `该租户下没有申请 ${applicationId as string}`,
        detail: { application_id: applicationId },
      })
    }
    // 排序键与 SPEC §3.3 一致：(round_no, slot_code)；id 只作同键决胜。
    const ids = (await client.query<{ id: string }>(
      `select id
         from recruitment.interview
        where tenant_id = $1 and application_id = $2
          and ($3::integer is null or round_no = $3)
        order by round_no, slot_code, id`,
      [tenantId, applicationId, roundNo ?? null],
    )).rows
    for (const row of ids) loaded.push(await loadInterview(client, tenantId, row.id, asOfIso))
    query = {
      mode: 'BY_APPLICATION',
      application_id: applicationId,
      ...(roundNo === undefined ? {} : { round_no: roundNo }),
    }
  }

  const interviews = loaded.map((item) => item.value)

  // require_transcript=true 是调用方的**硬前置**：没有完整转写就整次失败，不返回"OK + 空数组"。
  if (requireTranscript) {
    const blocked = loaded.find((item) => item.value.transcript.state !== 'READY')
    if (blocked !== undefined) {
      // NO_TRANSCRIPT 尚未进 `errors.ts` 的 RecruitmentErrorCode 封闭集（该文件不在本刀写范围），
      // 所以这里做一次类型断言；运行时消息格式与其它码完全相同：`Error: NO_TRANSCRIPT: <json>`。
      throw contractError('NO_TRANSCRIPT' as ContractErrorCode, {
        // reason_code 逐字透传 TR-D 的 reason_code（§2.5：两处必须逐字相同）。
        reason_code: blocked.value.transcript.reason_code,
        message: '该场面试没有完整转写，而调用方声明了 require_transcript=true',
        detail: {
          interview_id: blocked.value.id,
          transcript_state: blocked.value.transcript.state,
          meetings_total: blocked.meetingsTotal,
        },
      })
    }
  }

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    read_only: true,
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    as_of: asOfIso,
    query,
    count: interviews.length,
    interviews,
  }
}

/** 一行面试官（render 用）。 */
function interviewerLine(row: InterviewerValue): string {
  const required = row.required_scorecard ? 'required' : 'optional'
  if (row.scorecard === undefined) return `  ${row.display_name}(${required}, no scorecard)`
  const submitted = row.scorecard.submitted_at === undefined ? '' : ` @${row.scorecard.submitted_at}`
  return `  ${row.display_name}(${required}, ${row.scorecard.status} rev${row.scorecard.revision_no}/`
    + `${row.scorecard.transcript_basis}${submitted})`
}

/** 一个元素 → 模型可见文本（§2.6 的正例格式）。 */
function interviewBlock(value: InterviewValue): string[] {
  const window = `${value.scheduled_start_at ?? '?'} – ${value.scheduled_end_at ?? '?'}`
  const lines: string[] = [
    `interview ${value.id}  round=${value.round_no} slot=${value.slot_code} stage=${value.stage_code} `
      + `[${value.status}]  ${window}`,
    `  application_id=${value.application_id}  candidate_id=${value.candidate_id}  job_id=${value.job_id}`,
  ]
  if (value.interviewers.length === 0) {
    lines.push('  interviewers: none')
  } else {
    lines.push('  interviewers:')
    for (const row of value.interviewers) lines.push(interviewerLine(row))
  }
  const binding = value.meeting_binding
  if (binding.bindings.length === 0) {
    lines.push(`  meeting_binding: ${binding.state}  (count=${binding.count})`)
  } else {
    for (const item of binding.bindings) {
      lines.push(
        `  meeting_binding: ${binding.state}  ${item.provider} `
        + `${item.external_meeting_id ?? item.calendar_event_id ?? '?'} → ${item.meeting_role} `
        + `(binding_method=${item.binding_method}, meeting_id=${item.meeting_id})`,
      )
    }
  }
  lines.push(`  transcript: ${value.transcript.state} ${value.transcript.reason_code}`
    + ` (no_transcript=${String(value.transcript.no_transcript)})`)
  const evaluation = value.evaluation
  lines.push(
    `  evaluation: required=${evaluation.required_scorecards} submitted=${evaluation.submitted} `
    + `waived=${evaluation.waived} pending=${evaluation.pending} → `
    + `evaluation_ready=${String(evaluation.evaluation_ready)}`,
  )
  if (evaluation.blockers.length > 0) {
    lines.push(`    blockers: ${evaluation.blockers
      .map((blocker) => `${blocker.code}(${blocker.actor_id ?? blocker.interviewer_id
        ?? blocker.interview_record_id ?? '-'})`)
      .join(', ')}`)
  }
  lines.push(`  warnings: ${value.warnings.map((warning) => warning.code).join(', ') || '—'}`)
  return lines
}

/**
 * 造一个"数据库没配置"的替身：工具照常注册，调用时报 NOT_CONFIGURED 并列出缺什么。
 * 这比让工具消失更好——模型能看到"为什么查不了"，而不是以为工具不存在。
 * @param issues - `resolveDatabaseConfig` 给出的逐条缺失项。
 */
export function unconfiguredInterviewGetTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Get one interview (or every interview under an application) with interviewers, meeting binding, '
      + 'transcript state (derived by transcript-rules.md §4 TR-D) and evaluation counts. '
      + 'Currently NOT CONFIGURED: the plugin config is missing database settings (or the database password '
      + 'environment variable). Calls return NOT_CONFIGURED.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${TOOL_NAME} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw contractError('NOT_CONFIGURED', {
        reason_code: 'PLUGIN_NOT_CONFIGURED',
        message: '数据库配置不完整，面试查询不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}

/**
 * 造真实的面试查询工具。
 *
 * `execute` 只做"解析入参 → 开池 → 只读事务 → 调 `getInTransaction` → 关池"，
 * 查询逻辑全在 `getInTransaction` 里，所以集成测试与生产走同一条路径（SPEC §2 第 7 条）。
 * @param config - 已解析的数据库配置（`tenant_id` 只从这里来，模型无法传入）。
 */
export function createInterviewGetTool(config: ResolvedDatabaseConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Get interviews read straight from the business database (labels: LIVE/MANUAL/CONNECTED, read-only). '
      + 'Pass exactly one of interview_id (one interview) or application_id (every interview under that '
      + 'application, ordered by round_no then slot_code; round_no narrows it to one round and is rejected '
      + 'with interview_id). Both ids must be UUIDs. For each interview it returns the interview row '
      + '(stage_code/status/round_no/slot_code/duration), the interviewers with their CURRENT scorecard '
      + '(submitted_at/transcript_basis), the active meeting bindings (state BOUND_ACTIVE/UNBOUND/NONE_EXPECTED '
      + 'plus every binding), transcript.state derived at as_of by TR-D exactly (MISSING/PENDING/READY/PARTIAL/'
      + 'AUTH_REQUIRED/NEEDS_LINKING/RETRYABLE_FAILED with one reason_code), the evaluation counts with '
      + 'blockers, and warnings. Nothing is written. require_transcript=true turns "no complete transcript" '
      + 'into a NO_TRANSCRIPT error whose reason_code is the same transcript.reason_code. as_of is the only '
      + 'clock input and is echoed verbatim. Not in this slice: transcript.artifacts[] detail, open_tasks[], '
      + 'and any evaluated_at/now field.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as Record<string, unknown>
        const interviews = (v.interviews ?? []) as readonly InterviewValue[]
        const labels = v.labels as { provenance: string; trigger: string; connection: string }
        const lines: string[] = [
          `${String(v.tool)} ${String(v.contract_version)}  (labels: `
          + `${labels.provenance}/${labels.trigger}/${labels.connection})  as_of=${String(v.as_of)}`,
          `query: ${JSON.stringify(v.query)}  count=${String(v.count)}`,
        ]
        for (const interview of interviews) lines.push(...interviewBlock(interview))
        if (interviews.length === 0) lines.push('interviews: none')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const pool = createPool(config)
      try {
        return await withReadOnly(pool, async (client) => getInTransaction(client, config, rawArgs))
      } finally {
        await closePool(pool)
      }
    },
  }
}
