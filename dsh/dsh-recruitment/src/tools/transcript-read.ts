// recruitment_transcript_read —— S9「转写线」线 1 的**读路径（只读）**。
//
// 语义逐条照 `contracts/interview/transcript-rules.md`（下称 TR）：
//   * `transcript.state` 严格按 TR-D 的**七条规则、顺序即规则**派生（§4）；
//     `reason_code` 只用 §5 的封闭集，**不得造新值**；
//   * `M(i)` 只算 `meeting_role ∈ {PRIMARY, CONTINUATION}`（TR-D4）；
//   * `WAIT=120min` 可被 `business_config(config_key='transcript_policy').payload.wait_minutes` 覆盖；
//   * `transcript READY` 与 `interview_record.status` 是**两条状态轴**，分别回显（TR-D2 / TR-C6）。
//
// 形状照 `manual/transcript-line/README.md` §3.2（下称 RD）。
//
// 只读怎么保证（不是自我声称，三层）：
//   1. **数据库层**：整个读取跑在 `begin transaction read only` 里（`src/db/pool.ts` 的
//      `withReadOnly`），任何写语句直接 25006；
//   2. **源码层**：本文件不出现任何写语句，也不引入写事务封装
//      （`test/unit/transcript-readonly.test.ts` 静态断言）；
//   3. **模块图**：本文件**不**引用写路径模块 —— 只读模块图里不能出现写 SQL。
//
// 输出里**没有 null**：DSH 校验器不支持 `type` 数组，写 null 会让整次调用 INVALID_TOOL_OUTPUT
// （2026-11-13 真实事故）。缺失一律**省略键**，用 `warnings` 说明缺什么。

import { parseContractArgs, toParameterSchema, type ParamMap } from './args.ts'
import { checkAsOf } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
// R4：`provenance` 的唯一判定实现（`contracts/tenant-provenance.md` §2）。
// 演示租户（0002_seed）的转写行同样真的在库里 —— "读到了行"不是 `LIVE` 的证据。
import { resolveTenantProvenance } from './candidate-get.ts'
import { closePool, createPool, withReadOnly, type DatabaseClient, type ResolvedDatabaseConfig } from '../db/pool.ts'

const TOOL_NAME = 'recruitment_transcript_read'
/** 契约版本（`tool-contracts.md` / RD §3 同一基线）。 */
export const TRANSCRIPT_READ_CONTRACT_VERSION = '1.0.0'
const CONTRACT_VERSION = TRANSCRIPT_READ_CONTRACT_VERSION
/** TR-D：等待窗默认 120 分钟（可被 business_config 覆盖）。 */
const DEFAULT_WAIT_MINUTES = 120
const DEFAULT_MAX_CHARS = 20_000
const MAX_CHARS_LIMIT = 200_000
const DEFAULT_SEGMENT_LIMIT = 200
/** `M(i)` 认的会议角色（TR-D4：REPLACED / CANCELLED 不进）。 */
const TRANSCRIPT_MEETING_ROLES: ReadonlySet<string> = new Set(['PRIMARY', 'CONTINUATION'])

/**
 * 本工具抛出的错误码（RD §3.2 的封闭集；`errors.ts` 的窄联合**不改**）。
 */
export type TranscriptReadErrorCode = 'INVALID_ARGS' | 'NOT_FOUND' | 'NOT_CONFIGURED'

/**
 * 本工具的错误：message 恒为 `<CODE>: <compact-json>`（`tool-contracts.md` §1.2），带 `.code`。
 */
export class TranscriptReadError extends Error {
  readonly code: TranscriptReadErrorCode

  constructor(code: TranscriptReadErrorCode, body: string) {
    super(`${code}: ${body}`)
    this.name = 'TranscriptReadError'
    this.code = code
  }
}

/** 一次契约错误的 detail（键序由 `canonicalJson` 归一为字典序）。 */
interface ErrorParts {
  readonly reason_code: string
  readonly message: string
  readonly detail?: unknown
}

/**
 * 抛一条契约错误（`canonicalJson` 在这里内联：只读模块图里少一个依赖面）。
 * @param code - 顶层 code（同时是 message 前缀）。
 * @param parts - reason_code / message / 可选 detail。
 */
function fail(code: TranscriptReadErrorCode, parts: ErrorParts): never {
  const body: Record<string, unknown> = {
    code,
    reason_code: parts.reason_code,
    message: parts.message,
  }
  if (parts.detail !== undefined) body.detail = parts.detail
  throw new TranscriptReadError(code, canonical(body))
}

/**
 * 键按 Unicode 码点升序、无空白的 JSON（与 `src/tools/contract.ts` 的 `canonicalJson` 同一口径）。
 * 这里重写一份是为了让本文件的模块图**只剩** `args.ts` / `contract.ts` / `definition.ts` / `db/pool.ts`
 * —— 不把写路径所在的模块拉进只读图里。
 * @param value - 任意 JSON 值。
 * @returns 单行 JSON 文本。
 */
function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical: non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  throw new TypeError(`canonical: unsupported type ${typeof value}`)
}

/**
 * 入参表（封闭对象根；`tenant_id`/`actor_id` 由 `parseContractArgs` 判
 * `TENANT_OR_ACTOR_NOT_ALLOWED`，`tool-contracts.md` §0 第 4 条）。
 */
const PARAMS: ParamMap = {
  interview_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: '查哪一场面试的转写（UUID）。不存在的 id → NOT_FOUND(INTERVIEW_NOT_FOUND)。',
  },
  artifact_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description:
      '可选：只看某一版产物（必须属于该面试 M(i) 下的产物，否则 NOT_FOUND(ARTIFACT_NOT_FOUND)）。'
      + '该版不是 canonical 时附 ARTIFACT_FILTER_NOT_CANONICAL，但仍然照常返回它自己的正文。',
  },
  include_text: {
    kind: 'boolean',
    description: '是否返回正文切片（默认 true）。本工具会把 raw_text 按字符分页返回，绝不改写原文。',
  },
  text_offset: {
    kind: 'integer',
    min: 0,
    description: '正文起始字符偏移（默认 0，按 PostgreSQL 的字符数计，不是字节）。',
  },
  max_chars: {
    kind: 'integer',
    min: 1,
    max: MAX_CHARS_LIMIT,
    description: `一次最多返回多少个字符（默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_CHARS_LIMIT}）。`,
  },
  include_segments: {
    kind: 'boolean',
    description: '是否返回该产物的 transcript_segment 片段（默认 false）。',
  },
  segment_offset: {
    kind: 'integer',
    min: 0,
    description: '片段起始下标（默认 0；按 sequence 升序）。',
  },
  segment_limit: {
    kind: 'integer',
    min: 1,
    max: 1000,
    description: `一次最多返回多少条片段（默认 ${DEFAULT_SEGMENT_LIMIT}，上限 1000）。`,
  },
  as_of: {
    kind: 'string',
    maxLength: 40,
    description:
      '派生状态的基准时刻（ISO-8601 **带时区偏移**，如 2026-11-13T00:00:00+08:00，不得晚于服务端 now）。'
      + '不带偏移 → INVALID_ARGS(AS_OF_FORMAT)；晚于 now → INVALID_ARGS(AS_OF_IN_FUTURE)。默认服务端 now。',
  },
}

/** 一条警告（RD §3.2 的封闭集）。 */
interface WarningRow {
  readonly code: string
  readonly message: string
}

/** `transcript.state`（TR-D §4 的七个取值）。 */
export type TranscriptState =
  | 'MISSING'
  | 'READY'
  | 'PARTIAL'
  | 'PENDING'
  | 'AUTH_REQUIRED'
  | 'NEEDS_LINKING'
  | 'RETRYABLE_FAILED'

/** `transcript.reason_code`（TR-D §5 的封闭集，**不得造新值**）。 */
export type TranscriptReasonCode =
  | 'NO_MEETING_BOUND'
  | 'CANONICAL_STATUS'
  | 'READY_NO_CANONICAL'
  | 'ONLY_PARTIAL'
  | 'ONLY_AUTH_REQUIRED'
  | 'NO_ARTIFACT_AFTER_WAIT'
  | 'WAITING'
  /** 产物在，但正文为空 / 提不出可用文本（TR-F4；D-96 新增）。 */
  | 'ARTIFACT_EMPTY'

/** 一条产物在派生算法里被用到的三个字段（快照的最小子集）。 */
export interface TranscriptStateArtifact {
  readonly transcript_status: string
  readonly is_complete: boolean
  readonly is_canonical: boolean
  /**
   * 正文可用字符数（length(raw_text)）。
   *
   * 为什么派生算法需要它：**状态 READY 不等于有内容**。飞书实测踩过——
   * 视频会议录制没有生成"妙记"AI 转写，产物存在、状态看着正常，正文却是空的；
   * 只按 status 派生就会报 READY，把"没读到"说成"有转写"（D-96）。
   * 缺省（undefined）= 调用方没提供，保持旧行为。
   */
  readonly content_chars?: number
}

/** 一个会议的"实际结束时间"（`meeting.actual_end_at`）。 */
export interface TranscriptStateMeeting {
  readonly actual_end_at?: string
}

/** TR-D 派生所需的全部输入（**只有**这些，函数是纯的、可单测）。 */
export interface TranscriptStateSnapshot {
  /** 派生基准时刻（ISO-8601 带偏移）。 */
  readonly as_of: string
  /** `interview.scheduled_start_at`（缺省 = 没有可比较的起点）。 */
  readonly scheduled_start_at?: string
  /** `interview.scheduled_end_at`（缺省 = 只能用 meeting.actual_end_at）。 */
  readonly scheduled_end_at?: string
  /** `M(i)`：**调用方已过滤**为 PRIMARY / CONTINUATION 的会议（TR-D4）。 */
  readonly meetings: readonly TranscriptStateMeeting[]
  /** `ART(i)`：这些会议下的全部产物。 */
  readonly artifacts: readonly TranscriptStateArtifact[]
  /** 等待窗分钟数（默认 120；`business_config` 覆盖值从这里进来）。 */
  readonly wait_minutes?: number
}

/** TR-D 的推导结果。 */
export interface TranscriptDerivation {
  readonly state: TranscriptState
  readonly reason_code: TranscriptReasonCode
  /** `CANON(i)=∅ ∧ ART(i)≠∅`：RD §3.2 要为此给 `NO_CANONICAL` 警告。 */
  readonly no_canonical: boolean
}

/** `READY` 之外的状态映射（TR-D 序 2 的 `map(CANON.status)`；未列出的落 `PENDING`）。 */
const CANONICAL_STATE_MAP: Readonly<Record<string, TranscriptState>> = {
  READY: 'READY',
  PARTIAL: 'PARTIAL',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NEEDS_LINKING: 'NEEDS_LINKING',
  RETRYABLE_FAILED: 'RETRYABLE_FAILED',
}

/**
 * 把 `business_config` 里的 `wait_minutes` 归一：非正整数 / 解析不出来 → 默认 120。
 * @param raw - `payload->>'wait_minutes'` 的原文（可能是 undefined）。
 */
function normalizeWaitMinutes(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return DEFAULT_WAIT_MINUTES
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  if (!Number.isInteger(value) || value < 1) return DEFAULT_WAIT_MINUTES
  return value
}

/** ISO-8601 → 毫秒；解析不出来就是 `undefined`（调用方据此跳过这条比较）。 */
function ms(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * TR-D §4 的**唯一**实现：先算集合，再按优先级取第一个命中的规则。
 *
 * 七条的顺序本身是规则的一部分（TR-D3：`MISSING` 是终态判定，不能和 `PENDING` 混成"还没好"）：
 * 1. `M(i)=∅ ∧ as_of > scheduled_start_at` → `MISSING` / `NO_MEETING_BOUND`
 * 2. `CANON(i)≠∅` → `map(CANON.status)` / `CANONICAL_STATUS`
 * 3. `CANON(i)=∅ ∧ ∃ READY+is_complete` → `READY` / `READY_NO_CANONICAL`
 * 4. `CANON(i)=∅ ∧ ∃ PARTIAL` → `PARTIAL` / `ONLY_PARTIAL`
 * 5. `CANON(i)=∅ ∧ ∃ AUTH_REQUIRED` → `AUTH_REQUIRED` / `ONLY_AUTH_REQUIRED`
 * 6. `ART(i)=∅ ∧ as_of > max(actual_end_at, scheduled_end_at) + WAIT` → `MISSING` / `NO_ARTIFACT_AFTER_WAIT`
 * 7. 其余 → `PENDING` / `WAITING`
 *
 * @param snapshot - 只有 `as_of` / 计划起止 / `M(i)` / `ART(i)` / `WAIT`。
 * @returns `{ state, reason_code, no_canonical }`。
 */
export function deriveTranscriptState(snapshot: TranscriptStateSnapshot): TranscriptDerivation {
  const wait = normalizeWaitMinutes(snapshot.wait_minutes)
  const canonical = snapshot.artifacts.find((artifact) => artifact.is_canonical)
  const noCanonical = canonical === undefined && snapshot.artifacts.length > 0
  const asOf = ms(snapshot.as_of)
  const startAt = ms(snapshot.scheduled_start_at)

  // 序 1：一场会议都没绑，且已经过了计划开始（排期时就该绑，没绑就是"缺"，不是"还在等"）。
  if (snapshot.meetings.length === 0 && asOf !== undefined && startAt !== undefined && asOf > startAt) {
    return { state: 'MISSING', reason_code: 'NO_MEETING_BOUND', no_canonical: noCanonical }
  }

  // 序 2：有 canonical → 它的客观状态就是本轮状态。
  if (canonical !== undefined) {
    const mapped = CANONICAL_STATE_MAP[canonical.transcript_status] ?? 'PENDING'
    // TR-F4 / D-96：状态 READY 不等于有内容。正文为空就**不得**报 READY，
    // 否则下游会把"没读到"当成"有转写"（飞书视频会议录制踩过这个坑）。
    if (mapped === 'READY' && canonical.content_chars === 0) {
      return { state: 'PARTIAL', reason_code: 'ARTIFACT_EMPTY', no_canonical: false }
    }
    return { state: mapped, reason_code: 'CANONICAL_STATUS', no_canonical: false }
  }

  // 序 3：没人被选为 canonical，但已有一份完整的 → 原文齐了，只是还没选 canonical。
  if (snapshot.artifacts.some((artifact) => artifact.transcript_status === 'READY' && artifact.is_complete)) {
    return { state: 'READY', reason_code: 'READY_NO_CANONICAL', no_canonical: true }
  }

  // 序 4：只有残缺的。
  if (snapshot.artifacts.some((artifact) => artifact.transcript_status === 'PARTIAL')) {
    return { state: 'PARTIAL', reason_code: 'ONLY_PARTIAL', no_canonical: true }
  }

  // 序 5：只有"没权限读"的。
  if (snapshot.artifacts.some((artifact) => artifact.transcript_status === 'AUTH_REQUIRED')) {
    return { state: 'AUTH_REQUIRED', reason_code: 'ONLY_AUTH_REQUIRED', no_canonical: true }
  }

  // 序 6：一份产物都没有，且已过"会议结束 + 等待窗"→ 平台根本没有产物（TR-F3）。
  if (snapshot.artifacts.length === 0) {
    const ends = [ms(snapshot.scheduled_end_at), ...snapshot.meetings.map((meeting) => ms(meeting.actual_end_at))]
      .filter((value): value is number => value !== undefined)
    if (ends.length > 0 && asOf !== undefined && asOf > Math.max(...ends) + wait * 60_000) {
      return { state: 'MISSING', reason_code: 'NO_ARTIFACT_AFTER_WAIT', no_canonical: false }
    }
  }

  // 序 7：会议还没结束 / 还在等。
  return { state: 'PENDING', reason_code: 'WAITING', no_canonical: noCanonical }
}

/** 输出 schema 里复用的片段：数组/对象都必须显式 `type`（DSH 子集没有 `oneOf`）。 */
const WARNING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', description: '警告码（封闭集）。' },
    message: { type: 'string', description: '一句中文说明。' },
  },
}

const MEETING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'provider', 'meeting_role', 'binding_id', 'binding_method', 'in_transcript_set'],
  properties: {
    id: { type: 'string' },
    provider: { type: 'string' },
    external_meeting_id: { type: 'string', description: '平台会议 id；平台没给就省略这个键。' },
    meeting_role: { type: 'string', description: 'PRIMARY / CONTINUATION / REPLACED / CANCELLED（全部角色都回显）。' },
    binding_id: { type: 'string' },
    binding_method: { type: 'string' },
    in_transcript_set: {
      type: 'boolean',
      description: 'true = 该会议属于 M(i)（PRIMARY/CONTINUATION），它的产物参与 transcript.state 派生。',
    },
  },
}

const ARTIFACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'meeting_id', 'provider', 'provider_artifact_id', 'source_revision', 'variant_type',
    'transcript_status', 'provenance', 'trigger_mode', 'connection_state', 'is_canonical',
    'is_complete', 'has_more', 'char_count', 'segment_count',
  ],
  properties: {
    id: { type: 'string' },
    meeting_id: { type: 'string' },
    provider: { type: 'string' },
    provider_artifact_id: { type: 'string' },
    source_revision: { type: 'integer' },
    variant_type: { type: 'string' },
    language: { type: 'string' },
    transcript_status: { type: 'string' },
    provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'], description: '**这一行**自己的标注（不汇总进 labels）。' },
    trigger_mode: { type: 'string', enum: ['EVENT', 'MANUAL'], description: '**这一行**自己的标注。' },
    connection_state: {
      type: 'string',
      enum: ['CONNECTED', 'NOT_CONNECTED', 'AUTH_REQUIRED'],
      description: '**这一行**自己的标注（三维标签禁止压平，tool-contracts §1.4）。',
    },
    is_canonical: { type: 'boolean' },
    is_complete: { type: 'boolean' },
    has_more: { type: 'boolean' },
    content_sha256: { type: 'string' },
    char_count: { type: 'integer', description: 'raw_text 的字符数（PG 口径）。' },
    segment_count: { type: 'integer' },
    fetched_at: { type: 'string' },
    created_at: { type: 'string' },
  },
}

const TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['artifact_id', 'source_revision', 'content', 'offset', 'length', 'total_chars', 'has_more'],
  properties: {
    artifact_id: { type: 'string' },
    source_revision: { type: 'integer' },
    content: { type: 'string', description: 'raw_text 的切片，逐字节照抄（不做清洗/摘要）。' },
    offset: { type: 'integer' },
    length: { type: 'integer', description: '本次切片的字符数。' },
    total_chars: { type: 'integer' },
    has_more: { type: 'boolean' },
    next_offset: { type: 'integer', description: '仅当 has_more=true 时出现。' },
  },
}

const SEGMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'content_text'],
  properties: {
    sequence: { type: 'integer' },
    content_text: { type: 'string' },
    speaker_ref: { type: 'string', description: '平台没给就省略这个键（不猜说话人）。' },
  },
}

const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status', 'verification_status', 'transcript_revision', 'evidence_ok', 'is_current'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', description: 'interview_record 自己的状态轴（与 transcript.state 无关）。' },
    verification_status: { type: 'string' },
    transcript_revision: { type: 'integer' },
    evidence_ok: { type: 'boolean' },
    is_current: { type: 'boolean' },
    created_at: { type: 'string' },
  },
}

/** 输出 schema：只用 DSH 子集关键字，任何节点都没有 `type:'null'` / type 数组。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'contract_version', 'status', 'read_only', 'as_of', 'labels', 'interview', 'transcript', 'warnings'],
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    read_only: { type: 'boolean', description: '恒 true：本工具在只读事务里跑，零写入。' },
    as_of: { type: 'string', description: '派生状态的基准时刻（入参给了就原样回显，否则服务端 now）。' },
    labels: {
      type: 'object',
      additionalProperties: false,
      required: ['provenance', 'trigger', 'connection'],
      properties: {
        provenance: {
          type: 'string',
          enum: ['LIVE', 'FIXTURE'],
          description: '按本次调用的租户事实算（contracts/tenant-provenance.md §2）：演示租户/缺声明 ⇒ FIXTURE。'
            + '**不**汇总 artifacts 的 provenance（逐条在 transcript.artifacts[] 里）。',
        },
        trigger: { type: 'string', enum: ['MANUAL'], description: '人/模型在会话里调用，恒 MANUAL。' },
        connection: { type: 'string', enum: ['CONNECTED'], description: '直连业务库（与会议平台无关）。' },
      },
      description: '顶层三维标签 = 本工具与业务库的关系；每条产物自己的三维在 transcript.artifacts[] 里逐条回显。',
    },
    interview: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'application_id', 'round_no', 'stage_code', 'status', 'timezone', 'record_version'],
      properties: {
        id: { type: 'string' },
        application_id: { type: 'string' },
        round_no: { type: 'integer' },
        stage_code: { type: 'string' },
        status: { type: 'string' },
        scheduled_start_at: { type: 'string' },
        scheduled_end_at: { type: 'string' },
        timezone: { type: 'string' },
        record_version: { type: 'integer' },
      },
    },
    transcript: {
      type: 'object',
      additionalProperties: false,
      required: ['state', 'reason_code', 'wait_minutes', 'artifact_count', 'meetings', 'artifacts'],
      properties: {
        state: {
          type: 'string',
          enum: ['MISSING', 'READY', 'PARTIAL', 'PENDING', 'AUTH_REQUIRED', 'NEEDS_LINKING', 'RETRYABLE_FAILED'],
          description: '按 TR-D 七条派生的唯一状态（顺序即规则）。',
        },
        reason_code: {
          type: 'string',
          enum: [
            'NO_MEETING_BOUND', 'CANONICAL_STATUS', 'READY_NO_CANONICAL', 'ONLY_PARTIAL',
            'ONLY_AUTH_REQUIRED', 'NO_ARTIFACT_AFTER_WAIT', 'WAITING', 'ARTIFACT_EMPTY',
          ],
          description: 'TR-D §5 封闭集。',
        },
        wait_minutes: { type: 'integer', description: '生效的等待窗（默认 120，可被 business_config 覆盖）。' },
        artifact_count: { type: 'integer' },
        canonical_artifact_id: { type: 'string', description: '仅当该面试的 M(i) 下存在 canonical 时出现。' },
        canonical_revision: { type: 'integer' },
        selected_artifact_id: { type: 'string', description: '本次正文/片段取自哪一版（无产物则省略）。' },
        selected_source_revision: { type: 'integer' },
        meetings: { type: 'array', items: MEETING_SCHEMA, description: '该面试全部 active 绑定会议（含 REPLACED/CANCELLED）。' },
        artifacts: { type: 'array', items: ARTIFACT_SCHEMA, description: 'ART(i)：M(i) 下全部产物，按 (meeting, revision, variant) 排序。' },
        text: TEXT_SCHEMA,
        segments: { type: 'array', items: SEGMENT_SCHEMA },
        segment_page: {
          type: 'object',
          additionalProperties: false,
          required: ['offset', 'limit', 'total', 'has_more'],
          properties: {
            offset: { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
            has_more: { type: 'boolean' },
          },
        },
        record: RECORD_SCHEMA,
      },
    },
    warnings: { type: 'array', items: WARNING_SCHEMA },
  },
}

/** 本工具的输出值（`output.schema` 的运行时形状；可选键一律**省略**而非 null）。 */
export interface TranscriptReadValue {
  readonly tool: string
  readonly contract_version: string
  readonly status: 'OK'
  readonly read_only: true
  readonly as_of: string
  readonly labels: { readonly provenance: string; readonly trigger: string; readonly connection: string }
  readonly interview: Record<string, unknown>
  readonly transcript: Record<string, unknown>
  readonly warnings: readonly WarningRow[]
}

/** 一行的 `timestamptz` 统一成 ISO-8601（pg 给 `Date`）。 */
function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** 只在值存在时写键（缺省靠省略键）。 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value
}

/** pg 的 int8/bigint 以字符串返回；计数统一转数字。 */
function toCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

/**
 * 解析 + 校验一次读取入参（**纯函数，不碰数据库**；`as_of` 的格式/未来判定在这里）。
 *
 * `execute()` 与 `readTranscriptInTransaction()` 都调用它：前者保证"参数错了不建连"，
 * 后者保证"直接调用核心函数也拿到同一套校验"（集成测试就是直接调核心函数）。
 * @param raw - 模型给的 arguments（未校验）。
 * @param nowMs - 服务端当前毫秒（`as_of` 的"不得晚于"基准；**不写进输出**）。
 */
export function parseReadArgs(raw: unknown, nowMs: number): Record<string, unknown> {
  const args = parseContractArgs(PARAMS, raw)
  if (typeof args.as_of === 'string') {
    const checked = checkAsOf(args.as_of, nowMs)
    if (checked.ok !== true) {
      fail('INVALID_ARGS', {
        reason_code: checked.reason_code,
        message: checked.message,
        detail: { as_of: args.as_of },
      })
    }
  }
  return args
}

/** 面试行（只取回显要用的列）。 */
interface InterviewRow {
  id: string
  application_id: string
  round_no: number
  stage_code: string
  status: string
  scheduled_start_at: Date | null
  scheduled_end_at: Date | null
  timezone: string
  record_version: number
}

/** active 绑定 + 会议（**全部角色**都取出来，`M(i)` 的过滤在 JS 里按 TR-D4 做）。 */
interface MeetingRow {
  binding_id: string
  binding_method: string
  meeting_id: string
  provider: string
  external_meeting_id: string | null
  meeting_role: string
  actual_start_at: Date | null
  actual_end_at: Date | null
}

/** 产物行（含 `raw_text` 的字符数，不含正文）。 */
interface ArtifactRow {
  id: string
  meeting_id: string
  provider: string
  provider_artifact_id: string
  source_revision: number
  variant_type: string
  language: string | null
  transcript_status: string
  provenance: string
  trigger_mode: string
  connection_state: string
  is_canonical: boolean
  is_complete: boolean
  has_more: boolean
  content_sha256: string | null
  fetched_at: Date | null
  created_at: Date
  char_count: string | number | null
  segment_count: string | number | null
}

/** `interview_record` 行（先 `is_current`，否则最新）。 */
interface RecordRow {
  id: string
  status: string
  verification_status: string
  transcript_revision: number
  transcript_artifact_id: string
  evidence_ok: boolean
  is_current: boolean
  created_at: Date
}

/**
 * 读面试；不存在 → `NOT_FOUND(INTERVIEW_NOT_FOUND)`。
 */
async function loadInterview(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<InterviewRow> {
  const { rows } = await client.query<InterviewRow>(
    `select i.id, i.application_id, i.round_no, i.stage_code, i.status,
            i.scheduled_start_at, i.scheduled_end_at, i.timezone, i.record_version
       from recruitment.interview i
      where i.id = $1 and i.tenant_id = $2`,
    [interviewId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    fail('NOT_FOUND', {
      reason_code: 'INTERVIEW_NOT_FOUND',
      message: '面试不存在，或不属于当前租户',
      detail: { interview_id: interviewId },
    })
  }
  return row
}

/** 取该面试**全部** active 绑定会议（不在这里过滤角色：TR-D4 的过滤要能看出来）。 */
async function loadMeetings(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<MeetingRow[]> {
  const { rows } = await client.query<MeetingRow>(
    `select b.id as binding_id, b.binding_method,
            m.id as meeting_id, m.provider, m.external_meeting_id, m.meeting_role,
            m.actual_start_at, m.actual_end_at
       from recruitment.meeting_binding b
       join recruitment.meeting m
         on m.id = b.meeting_id and m.tenant_id = b.tenant_id
      where b.interview_id = $1
        and b.tenant_id = $2
        and b.unbound_at is null
      order by (m.meeting_role = 'PRIMARY') desc, b.bound_at, m.id`,
    [interviewId, tenantId],
  )
  return rows
}

/** 取 `ART(i)`：给定会议集合下的全部产物（按 meeting / revision / variant 排序）。 */
async function loadArtifacts(
  client: DatabaseClient,
  tenantId: string,
  meetingIds: readonly string[],
): Promise<ArtifactRow[]> {
  if (meetingIds.length === 0) return []
  const { rows } = await client.query<ArtifactRow>(
    `select a.id, a.meeting_id, a.provider, a.provider_artifact_id, a.source_revision,
            a.variant_type, a.language, a.transcript_status, a.provenance, a.trigger_mode,
            a.connection_state, a.is_canonical, a.is_complete, a.has_more, a.content_sha256,
            a.fetched_at, a.created_at,
            coalesce(length(a.raw_text), 0) as char_count,
            (select count(*) from recruitment.transcript_segment s
              where s.artifact_id = a.id and s.tenant_id = a.tenant_id) as segment_count
       from recruitment.transcript_artifact a
      where a.tenant_id = $1 and a.meeting_id = any($2::uuid[])
      order by a.meeting_id, a.source_revision, a.variant_type`,
    [tenantId, [...meetingIds]],
  )
  return rows
}

/** 取 `interview_record`：`is_current=true` 优先，否则最新一条（TR-C6：独立状态轴）。 */
async function loadRecord(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<RecordRow | undefined> {
  const { rows } = await client.query<RecordRow>(
    `select id, status, verification_status, transcript_revision, transcript_artifact_id,
            evidence_ok, is_current, created_at
       from recruitment.interview_record
      where tenant_id = $1 and interview_id = $2
      order by is_current desc, created_at desc, id
      limit 1`,
    [tenantId, interviewId],
  )
  return rows[0]
}

/**
 * 读 `transcript_policy.wait_minutes`（无行 / 坏值 → 默认 120，TR-D `WAIT`）。
 * 取该租户下最新生效的那一版；ORGANIZATION scope 优先。
 */
async function loadWaitMinutes(client: DatabaseClient, tenantId: string): Promise<number> {
  const { rows } = await client.query<{ wait_minutes: string | null }>(
    `select payload->>'wait_minutes' as wait_minutes
       from recruitment.business_config
      where tenant_id = $1
        and config_key = 'transcript_policy'
        and (effective_to is null or effective_to > now())
      order by case when scope = 'ORGANIZATION' then 0 else 1 end, version_no desc, effective_from desc
      limit 1`,
    [tenantId],
  )
  return normalizeWaitMinutes(rows[0]?.wait_minutes)
}

/** 正文切片（字符数按 PG 口径，`substring` 不会切坏多字节字符）。 */
async function loadTextSlice(
  client: DatabaseClient,
  tenantId: string,
  artifactId: string,
  offset: number,
  maxChars: number,
): Promise<{ content: string; total_chars: number; slice_len: number } | undefined> {
  const { rows } = await client.query<{ content: string | null; total_chars: string | number | null; slice_len: string | number | null }>(
    `select substring(raw_text from $3::int + 1 for $4::int) as content,
            length(raw_text) as total_chars,
            length(substring(raw_text from $3::int + 1 for $4::int)) as slice_len
       from recruitment.transcript_artifact
      where tenant_id = $1 and id = $2`,
    [tenantId, artifactId, offset, maxChars],
  )
  const row = rows[0]
  if (row === undefined || row.content === null) return undefined
  return {
    content: row.content,
    total_chars: toCount(row.total_chars),
    slice_len: toCount(row.slice_len),
  }
}

/** 片段一页（`include_segments=true` 才查）。 */
async function loadSegments(
  client: DatabaseClient,
  tenantId: string,
  artifactId: string,
  offset: number,
  limit: number,
): Promise<{ items: { sequence: number; content_text: string; speaker_ref: string | null }[]; total: number }> {
  const { rows } = await client.query<{ sequence: number; content_text: string; speaker_ref: string | null }>(
    `select sequence, content_text, speaker_ref
       from recruitment.transcript_segment
      where tenant_id = $1 and artifact_id = $2
      order by sequence
      offset $3 limit $4`,
    [tenantId, artifactId, offset, limit],
  )
  const total = await client.query<{ total: string | number }>(
    'select count(*) as total from recruitment.transcript_segment where tenant_id = $1 and artifact_id = $2',
    [tenantId, artifactId],
  )
  return { items: rows, total: toCount(total.rows[0]?.total) }
}

/**
 * 从 `ART(i)` 里挑本次正文/片段来源（RD §3.2 的顺序，不"自动挑最新"越过 canonical）：
 * 给了 `artifact_id` → 必须**逐字**命中它；否则 canonical → 否则最新完整（READY+is_complete）→
 * 否则最新一版。
 */
function selectArtifact(
  artifacts: readonly ArtifactRow[],
  requestedArtifactId: string | undefined,
  interviewId: string,
): ArtifactRow | undefined {
  if (requestedArtifactId !== undefined) {
    const matched = artifacts.find((artifact) => artifact.id === requestedArtifactId)
    if (matched === undefined) {
      fail('NOT_FOUND', {
        reason_code: 'ARTIFACT_NOT_FOUND',
        message: '入参 artifact_id 不属于该面试 M(i) 下的转写产物',
        detail: {
          artifact_id: requestedArtifactId,
          artifact_count: artifacts.length,
          interview_id: interviewId,
        },
      })
    }
    return matched
  }
  const canonical = artifacts.find((artifact) => artifact.is_canonical)
  if (canonical !== undefined) return canonical
  const complete = artifacts.filter((artifact) => artifact.transcript_status === 'READY' && artifact.is_complete)
  if (complete.length > 0) return latest(complete)
  return latest([...artifacts])
}

/** 按入库时间取最新一版（时间相同再看 revision，保证确定）。 */
function latest(artifacts: readonly ArtifactRow[]): ArtifactRow | undefined {
  if (artifacts.length === 0) return undefined
  return [...artifacts].sort((left, right) => {
    const leftAt = left.created_at.getTime()
    const rightAt = right.created_at.getTime()
    if (leftAt !== rightAt) return rightAt - leftAt
    if (left.source_revision !== right.source_revision) return right.source_revision - left.source_revision
    return left.id < right.id ? 1 : -1
  })[0]
}

/**
 * 在**调用方给定的事务**里完成一次读取（单独导出是为了让集成测试在"必回滚事务"里
 * 看到同一份未提交夹具；生产路径由 `execute()` 用 `withReadOnly` 提供只读事务）。
 *
 * @param client - 只读事务内客户端（测试里是已回滚事务的客户端）。
 * @param cfg - 已解析配置（租户只从这里来）。
 * @param args - 入参（本函数自己再跑一遍 `parseReadArgs`）。
 * @param nowMs - 服务端当前毫秒（`as_of` 默认值与被校验的上界）。
 */
export async function readTranscriptInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<TranscriptReadValue> {
  const parsed = parseReadArgs(args, nowMs)
  const tenantId = cfg.tenant_id
  const interviewId = parsed.interview_id as string
  const requestedArtifactId = typeof parsed.artifact_id === 'string' ? parsed.artifact_id : undefined
  const includeText = parsed.include_text !== false
  const textOffset = typeof parsed.text_offset === 'number' ? parsed.text_offset : 0
  const maxChars = typeof parsed.max_chars === 'number' ? parsed.max_chars : DEFAULT_MAX_CHARS
  const includeSegments = parsed.include_segments === true
  const segmentOffset = typeof parsed.segment_offset === 'number' ? parsed.segment_offset : 0
  const segmentLimit = typeof parsed.segment_limit === 'number' ? parsed.segment_limit : DEFAULT_SEGMENT_LIMIT
  const asOf = typeof parsed.as_of === 'string' ? parsed.as_of : new Date(nowMs).toISOString()

  const interview = await loadInterview(client, tenantId, interviewId)
  const meetings = await loadMeetings(client, tenantId, interviewId)
  const transcriptMeetings = meetings.filter((meeting) => TRANSCRIPT_MEETING_ROLES.has(meeting.meeting_role))
  const artifacts = await loadArtifacts(client, tenantId, transcriptMeetings.map((meeting) => meeting.meeting_id))
  const waitMinutes = await loadWaitMinutes(client, tenantId)

  const derivation = deriveTranscriptState({
    as_of: asOf,
    ...(interview.scheduled_start_at === null ? {} : { scheduled_start_at: iso(interview.scheduled_start_at) as string }),
    ...(interview.scheduled_end_at === null ? {} : { scheduled_end_at: iso(interview.scheduled_end_at) as string }),
    meetings: transcriptMeetings.map((meeting) => ({
      ...(meeting.actual_end_at === null ? {} : { actual_end_at: iso(meeting.actual_end_at) as string }),
    })),
    artifacts: artifacts.map((artifact) => ({
      transcript_status: artifact.transcript_status,
      is_complete: artifact.is_complete,
      is_canonical: artifact.is_canonical,
      content_chars: Number(artifact.char_count ?? 0),
    })),
    wait_minutes: waitMinutes,
  })

  const selected = selectArtifact(artifacts, requestedArtifactId, interviewId)
  const warnings: WarningRow[] = []
  if (derivation.state !== 'READY') {
    warnings.push({
      code: 'TRANSCRIPT_NOT_READY',
      message: `transcript.state=${derivation.state}（reason_code=${derivation.reason_code}）：`
        + '原文还没有完整拿到。注意这只说材料没齐，不代表面试不能评价（TR-E1）',
    })
  }
  if (derivation.no_canonical) {
    warnings.push({
      code: 'NO_CANONICAL',
      message: 'ART(i) 里已有产物，但该面试的 M(i) 下没有任何一版被选为 canonical；'
        + 'state 只能按"无 canonical"的规则（序 3–5）推导',
    })
  }
  if (requestedArtifactId !== undefined && selected !== undefined && selected.is_canonical !== true) {
    warnings.push({
      code: 'ARTIFACT_FILTER_NOT_CANONICAL',
      message: '入参 artifact_id 指向的版本不是该会议的 canonical；返回的是它自己的正文，'
        + '不代表"本轮唯一那一版"',
    })
  }

  const transcript: Record<string, unknown> = {
    state: derivation.state,
    reason_code: derivation.reason_code,
    wait_minutes: waitMinutes,
    artifact_count: artifacts.length,
    meetings: meetings.map((meeting) => {
      const item: Record<string, unknown> = {
        id: meeting.meeting_id,
        provider: meeting.provider,
        meeting_role: meeting.meeting_role,
        binding_id: meeting.binding_id,
        binding_method: meeting.binding_method,
        in_transcript_set: TRANSCRIPT_MEETING_ROLES.has(meeting.meeting_role),
      }
      put(item, 'external_meeting_id', meeting.external_meeting_id ?? undefined)
      return item
    }),
    artifacts: artifacts.map((artifact) => {
      const item: Record<string, unknown> = {
        id: artifact.id,
        meeting_id: artifact.meeting_id,
        provider: artifact.provider,
        provider_artifact_id: artifact.provider_artifact_id,
        source_revision: artifact.source_revision,
        variant_type: artifact.variant_type,
        transcript_status: artifact.transcript_status,
        provenance: artifact.provenance,
        trigger_mode: artifact.trigger_mode,
        connection_state: artifact.connection_state,
        is_canonical: artifact.is_canonical,
        is_complete: artifact.is_complete,
        has_more: artifact.has_more,
        char_count: toCount(artifact.char_count),
        segment_count: toCount(artifact.segment_count),
      }
      put(item, 'language', artifact.language ?? undefined)
      put(item, 'content_sha256', artifact.content_sha256 ?? undefined)
      put(item, 'fetched_at', iso(artifact.fetched_at))
      put(item, 'created_at', iso(artifact.created_at))
      return item
    }),
  }
  const canonical = artifacts.find((artifact) => artifact.is_canonical)
  if (canonical !== undefined) {
    transcript.canonical_artifact_id = canonical.id
    transcript.canonical_revision = canonical.source_revision
  }
  if (selected !== undefined) {
    transcript.selected_artifact_id = selected.id
    transcript.selected_source_revision = selected.source_revision
    if (includeText) {
      const slice = await loadTextSlice(client, tenantId, selected.id, textOffset, maxChars)
      if (slice !== undefined) {
        const text: Record<string, unknown> = {
          artifact_id: selected.id,
          source_revision: selected.source_revision,
          content: slice.content,
          offset: textOffset,
          length: slice.slice_len,
          total_chars: slice.total_chars,
          has_more: textOffset + slice.slice_len < slice.total_chars,
        }
        if (text.has_more === true) text.next_offset = textOffset + slice.slice_len
        transcript.text = text
      }
    }
    if (includeSegments) {
      const page = await loadSegments(client, tenantId, selected.id, segmentOffset, segmentLimit)
      transcript.segments = page.items.map((segment) => {
        const item: Record<string, unknown> = {
          sequence: segment.sequence,
          content_text: segment.content_text,
        }
        put(item, 'speaker_ref', segment.speaker_ref ?? undefined)
        return item
      })
      transcript.segment_page = {
        offset: segmentOffset,
        limit: segmentLimit,
        total: page.total,
        has_more: segmentOffset + page.items.length < page.total,
      }
    }
  }

  const record = await loadRecord(client, tenantId, interviewId)
  if (record === undefined) {
    warnings.push({
      code: 'RECORD_MISSING',
      message: '该面试还没有 interview_record（结构化记录）。'
        + '注意：没有记录不等于没有转写；有转写也不等于记录已就绪（TR-C6 / TR-E4）',
    })
  } else {
    transcript.record = {
      id: record.id,
      status: record.status,
      verification_status: record.verification_status,
      transcript_revision: record.transcript_revision,
      evidence_ok: record.evidence_ok,
      is_current: record.is_current,
      created_at: iso(record.created_at) as string,
    }
    if (record.status !== 'READY') {
      warnings.push({
        code: 'RECORD_NOT_READY',
        message: `interview_record.status=${record.status}（verification_status=${record.verification_status}）：`
          + '结构化记录还没就绪，与 transcript.state 是两条独立状态轴（TR-D2）',
      })
    }
  }

  const interviewValue: Record<string, unknown> = {
    id: interview.id,
    application_id: interview.application_id,
    round_no: interview.round_no,
    stage_code: interview.stage_code,
    status: interview.status,
    timezone: interview.timezone,
    record_version: interview.record_version,
  }
  put(interviewValue, 'scheduled_start_at', iso(interview.scheduled_start_at))
  put(interviewValue, 'scheduled_end_at', iso(interview.scheduled_end_at))

  // R4：顶层 `labels.provenance` 反映**这次调用**的数据来源（`contracts/tenant-provenance.md` §2），
  // 不写死 `LIVE`。演示租户 / 缺声明 / 有合成标记 ⇒ `FIXTURE`（fail-closed）。
  // 注意：逐条产物自己的三维在 `transcript.artifacts[]` 里回显，**不汇总**进 `labels`
  // （`contracts/interview/tool-contracts.md` §1.4）；`trigger`/`connection` 与 provenance 正交。
  const provenance = await resolveTenantProvenance(client, tenantId)

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    read_only: true,
    as_of: asOf,
    labels: { provenance, trigger: 'MANUAL', connection: 'CONNECTED' },
    interview: interviewValue,
    transcript,
    warnings,
  }
}

/** 工具描述（模型可见）：入参、错误码、标签语义、两条状态轴分开。 */
const DESCRIPTION =
  'S9 转写读取（**只读**，`begin transaction read only`）。'
  + '入参：interview_id(UUID, 必填)、artifact_id（可选过滤，必须属于该面试）、'
  + 'include_text（默认 true）、text_offset（默认 0）、max_chars（默认 20000，上限 200000）、'
  + 'include_segments（默认 false）、segment_offset（默认 0）、segment_limit（默认 200，上限 1000）、'
  + 'as_of（ISO-8601 带偏移、不得晚于 now）。'
  + 'tenant_id/actor_id 不接受模型传入（出现即 INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)）。'
  + 'transcript.state 严格按 TR-D 七条派生（顺序即规则）：'
  + 'MISSING(NO_MEETING_BOUND) → 有 canonical 则 map(状态)(CANONICAL_STATUS) → '
  + 'READY(READY_NO_CANONICAL) → PARTIAL(ONLY_PARTIAL) → AUTH_REQUIRED(ONLY_AUTH_REQUIRED) → '
  + 'MISSING(NO_ARTIFACT_AFTER_WAIT，等满 120min 仍无产物) → PENDING(WAITING)；'
  + 'wait_minutes 可被 business_config(transcript_policy) 覆盖。'
  + '错误码：INVALID_ARGS（reason_code 见 detail，含 AS_OF_FORMAT / AS_OF_IN_FUTURE）/ '
  + 'NOT_FOUND(INTERVIEW_NOT_FOUND|ARTIFACT_NOT_FOUND) / NOT_CONFIGURED。'
  + '三维标签：顶层 labels.provenance 按本次调用的租户事实算（contracts/tenant-provenance.md §2：'
  + '演示租户/缺声明/有合成标记 ⇒ FIXTURE，只有显式声明非合成的租户才可能是 LIVE），'
  + 'trigger 恒 MANUAL，connection=CONNECTED 只表示"直连业务库"（与会议平台无关）；'
  + '每条产物的 provenance/trigger_mode/connection_state 在 transcript.artifacts[] 里**逐条**回显，不汇总。'
  + '警告封闭集：TRANSCRIPT_NOT_READY / NO_CANONICAL / RECORD_MISSING / RECORD_NOT_READY / '
  + 'ARTIFACT_FILTER_NOT_CANONICAL。'
  + '关键：transcript.state=READY 只代表原文已完整拿到，**不代表** interview_record 就绪（两条状态轴）。'

/**
 * 造一个绑定配置的只读转写工具（`isConcurrencySafe=true`）。
 * @param database - 已解析的 database 配置（租户只从这里来）。
 */
export function createTranscriptReadTool(database: ResolvedDatabaseConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as TranscriptReadValue
        const transcript = v.transcript as {
          state: string
          reason_code: string
          wait_minutes: number
          artifact_count: number
          canonical_artifact_id?: string
          canonical_revision?: number
          meetings: readonly Record<string, unknown>[]
          artifacts: readonly Record<string, unknown>[]
          text?: { total_chars: number; offset: number; length: number; has_more: boolean; next_offset?: number }
          record?: { id: string; status: string; verification_status: string }
        }
        const lines = [
          `${v.tool} ${v.contract_version} status=${v.status} read_only=${String(v.read_only)} as_of=${v.as_of}`,
          `interview ${String(v.interview.id)} stage=${String(v.interview.stage_code)}`
            + ` status=${String(v.interview.status)} round=${String(v.interview.round_no)}`,
          `transcript state=${transcript.state} reason=${transcript.reason_code}`
            + ` wait_minutes=${transcript.wait_minutes} artifacts=${transcript.artifact_count}`,
          `labels: provenance=${v.labels.provenance} trigger=${v.labels.trigger} connection=${v.labels.connection}`,
        ]
        for (const meeting of transcript.meetings) {
          lines.push(`  meeting ${String(meeting.id)} ${String(meeting.provider)}`
            + ` role=${String(meeting.meeting_role)} in_set=${String(meeting.in_transcript_set)}`)
        }
        if (transcript.canonical_artifact_id !== undefined) {
          lines.push(`  canonical ${transcript.canonical_artifact_id} rev=${String(transcript.canonical_revision)}`)
        } else {
          lines.push('  canonical (none)')
        }
        for (const artifact of transcript.artifacts) {
          lines.push(`  artifact ${String(artifact.id)} rev=${String(artifact.source_revision)}`
            + ` status=${String(artifact.transcript_status)}`
            + ` provenance=${String(artifact.provenance)} trigger=${String(artifact.trigger_mode)}`
            + ` connection=${String(artifact.connection_state)}`
            + ` canonical=${String(artifact.is_canonical)} chars=${String(artifact.char_count)}`
            + ` segments=${String(artifact.segment_count)}`)
        }
        if (transcript.text !== undefined) {
          lines.push(`  text: chars=${transcript.text.total_chars} offset=${transcript.text.offset}`
            + ` returned=${transcript.text.length} has_more=${String(transcript.text.has_more)}`
            + `${transcript.text.has_more ? ` next_offset=${String(transcript.text.next_offset)}` : ''}`)
        } else {
          lines.push('  text: (omitted)')
        }
        lines.push(`  record ${transcript.record === undefined
          ? '(missing)'
          : `${String(transcript.record.id)} status=${String(transcript.record.status)}`
            + ` verification=${String(transcript.record.verification_status)}`}`)
        for (const warning of v.warnings) lines.push(`  warning ${warning.code}: ${warning.message}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const nowMs = Date.now()
      // 参数级失败必须在**建连之前**抛（INVALID_ARGS / NOT_CONFIGURED 不该先占一个连接）。
      const args = parseReadArgs(rawArgs, nowMs)
      const pool = createPool(database)
      try {
        return await withReadOnly(pool, async (client) =>
          readTranscriptInTransaction(client, database, args, nowMs))
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 配置不完整时用的替身：注册同名工具，调用即 `NOT_CONFIGURED`（schema 仍是同一个封闭对象）。
 * @param issues - 缺哪些配置（值里永远不含密码）。
 */
export function unconfiguredTranscriptReadTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      DESCRIPTION
      + ' 当前**未配置**（缺数据库设置或密码环境变量），任何调用都返回 NOT_CONFIGURED。',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${TOOL_NAME} 未配置：${issues.join('; ')}` }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(): Promise<unknown> {
      fail('NOT_CONFIGURED', {
        reason_code: 'PLUGIN_NOT_CONFIGURED',
        message: '数据库配置不完整，S9 转写读取不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}
