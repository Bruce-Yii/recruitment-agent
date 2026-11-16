// recruitment_transcript_import —— S9「转写线」线 1（真功能）的**写路径**。
//
// 语义逐条照 `contracts/interview/transcript-rules.md`（下称 TR）与
// `contracts/interview/tool-contracts.md`（下称 TC）；形状照
// `manual/transcript-line/README.md` §2/§3.1（下称 RD）。
//
// 这条路径的**全部**难点都在 P-2/P-3/§8.3 这三个字上：
//   * `raw_text` / `content_sha256` / `read_receipt_ref` / `provenance` / `provider_artifact_id` /
//     `source_revision` 在插入后**不可改**（`0001 L1777` 的列级白名单）；
//   * 所以**不插占位行**（TR-C7）：首次 INSERT 就带全内容 + 终态 `READY` + sha + 回执（LIMIT 见 TR-C8）；
//   * 平台修订 → 新 `source_revision` 行（TR-U7），canonical 同事务迁移（TR-U9），旧行保留；
//   * 内容 sha 没变 → 一行都不写（TR-U8，`replayed=true`）。
//
// **两条来源路径**（2026-11-14 起；此前只有人工上传）：
//   1. `MANUAL`：调用方给 `content`（+`source_kind`）。人工上传**不冒充飞书已接通**：
//      `trigger_mode` 恒 `MANUAL`、`connection_state` 恒 `NOT_CONNECTED`；`provenance='LIVE'`
//      只给声明为 `PLATFORM_EXPORT` 且给出导出文件名的调用，并附
//      `EXPORT_RECEIPT_IS_SELF_DECLARED`（回执是人工自述，我们没连平台，TR-S3/TR-S4）。
//   2. `CONNECTOR_READBACK`：调用方**不给正文**、给 `minute_token`（或 `external_meeting_id`），
//      由飞书连接器 `fetchTranscript()` 回读取正文。**默认态是 fail-closed**：
//      插件配置里没有 `feishu.cli`（lark-cli 绝对路径）时不装配传输层，本路径直接
//      `BLOCKED / TRANSPORT_NOT_CONFIGURED`，不拉进程、不读正文、不写任何行。
//      落库标签由 `evaluateLiveGate()` 按**本次回读证据**算（不是全局开关）：
//        * 证据齐全 → `provenance=LIVE`、`trigger=MANUAL`、`connection=CONNECTED`，
//          `provider_artifact_id` 用真实分钟标识（`feishu:minutes:<token>`）；
//        * 缺任何一项 → `FIXTURE / MANUAL / {NOT_CONNECTED, AUTH_REQUIRED}`，
//          并把缺项写进 warnings / detail（说清缺什么）；
//        * 回读对象**自相矛盾**（声明的 sha / 回执 / 重读哈希与正文不一致）→
//          `BLOCKED / READBACK_INVALID`，一行不写（不一致是失败，不是警告）。
//      工具**永不**把调用方自报的 LIVE 当依据：只看回读证据。
//
// 写事务：`withActor`（`set_config('recruitment.actor_id', …, true)`，等价 SET LOCAL），单事务；
// 任何失败整笔回滚 —— `changes` 全空就是"没写"的证明（TC §1.3）。
//
// 输出里**没有 null**：DSH 的校验器不支持 `type` 数组（`dsh-tools/lib/types/json-schema.js:245`），
// 写 null 会让整次调用 INVALID_TOOL_OUTPUT（2026-11-13 真实事故）。缺省一律**省略键**。

import { createHash } from 'node:crypto'

import { parseContractArgs, toParameterSchema, type ParamMap } from './args.ts'
import { canonicalJson } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { MACHINE_ARGS_HEADER, shortRef } from './render-ref.ts'
import { closePool, createPool, withActor, type DatabaseClient, type ResolvedDatabaseConfig } from '../db/pool.ts'
import { resolveWriteActor, type ToolActorDeps } from '../demo-actor/tool-actor.ts'
import {
  FEISHU_MINUTES_CONNECTOR_ID,
  FEISHU_MINUTES_PROVIDER,
  LIVE_READBACK_PROVENANCE_BASIS,
  evaluateLiveGate,
  readNonEmptyString,
  readbackConsistencyViolations,
  type Connection,
  type FeishuCliTranscriptReadback,
  type FeishuConnectorDependency,
  type FeishuMinutesAdapter,
  type FeishuTranscriptBlocked,
  type FeishuTranscriptWaitingExternal,
  type LiveGateDecision,
} from '../connectors/feishu/index.ts'

const TOOL_NAME = 'recruitment_transcript_import'
/** 契约版本（`tool-contracts.md` / RD §3 同一基线）。 */
export const TRANSCRIPT_IMPORT_CONTRACT_VERSION = '1.0.0'
const CONTRACT_VERSION = TRANSCRIPT_IMPORT_CONTRACT_VERSION
/** `content` 的上界（RD §3.1：1..400000 字符，逐字节保存）。 */
export const MAX_CONTENT_CHARS = 400_000
/** `sections.turns` / `sections.citations` 的上界（RD §2）。 */
const MAX_TURNS = 200
/** 片段批量插入时的每批行数（5 个参数/行，远低于 65535 上限）。 */
const SEGMENT_CHUNK = 500
/** `interview_record` 的固定取值：人工导入是**确定性中性记录**，不是模型抽取。 */
const RECORD_MODEL_ID = 'none:manual-import'
const RECORD_PROMPT_VERSION = 'manual-import/1.0.0'
const RECORD_SCHEMA_VERSION = 1
const SECTIONS_SCHEMA = 'manual-import.sections/1'
/** 片段来源引用（可追溯是谁写的：人工导入）。 */
const SEGMENT_RAW_SOURCE_REF = 'manual-import'
/** 片段来源引用（连接器回读：字节来自 `lark-cli-transport`；是否 LIVE 由证据算）。 */
const SEGMENT_RAW_SOURCE_REF_CONNECTOR = 'feishu-connector-readback'
/** 同 meeting 下按 provider_artifact_id 生成（**不编造平台标识**，RD §2）。 */
const ARTIFACT_ID_PREFIX = 'local:'
/** 连接器回读但**不满足 LIVE 证据**时的 provider_artifact_id 前缀（`local:` = 未经平台核实）。 */
const FEISHU_READBACK_ARTIFACT_PREFIX = `${ARTIFACT_ID_PREFIX}feishu-minutes:`
/** 连接器回读且 **LIVE 证据齐全**时的 provider_artifact_id 前缀（真实平台分钟标识）。 */
const FEISHU_LIVE_ARTIFACT_PREFIX = 'feishu:minutes:'
/** 两条连接器产物前缀：replay 时用来认「这一行是不是连接器回读写的」。 */
const FEISHU_CONNECTOR_ARTIFACT_PREFIXES = [FEISHU_READBACK_ARTIFACT_PREFIX, FEISHU_LIVE_ARTIFACT_PREFIX] as const
/** 连接器回读的确定性记录（不是模型抽取，与人工导入同形，但来源不同）。 */
const CONNECTOR_RECORD_MODEL_ID = 'none:connector-readback'
const CONNECTOR_RECORD_PROMPT_VERSION = 'connector-readback/1.0.0'
const CONNECTOR_SECTIONS_SCHEMA = 'feishu-connector-readback.sections/1'
/** 连接器回读但**证据不齐**时的 `provenance_basis`（读到了字节，但不构成 LIVE 依据）。 */
export const FEISHU_READBACK_PROVENANCE_BASIS = 'FEISHU_READBACK_NO_LIVE_GATE'
/** `sections.source.kind`：连接器回读（与人工上传的 PLATFORM_EXPORT / DEMO_SAMPLE 并列）。 */
const SECTIONS_SOURCE_KIND_CONNECTOR = 'FEISHU_CONNECTOR_READBACK'

/** 本工具接受的来源（TR-S3 平台导出件 / 演示样本，TR-S5 手打纪要不在其中）。 */
export const SOURCE_KINDS = ['PLATFORM_EXPORT', 'DEMO_SAMPLE'] as const
export type TranscriptSourceKind = (typeof SOURCE_KINDS)[number]

/** 进来时允许的 `meeting_role`（TR-D4：REPLACED / CANCELLED 不进 M(i)）。 */
const TRANSCRIPT_MEETING_ROLES = ['PRIMARY', 'CONTINUATION'] as const

/** 本工具抛出的错误码（RD §3.1 的封闭集 + 连接器回读的 `BLOCKED`；`errors.ts` 的窄联合**不改**）。 */
export type TranscriptImportErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'NO_MEETING_BOUND'
  | 'AMBIGUOUS_MEETING'
  | 'NOT_CONFIGURED'
  /** 连接器回读路径 fail-closed：没有传输层 / 平台生成中 / 传输层失败 / 回读自检不过。detail.reason_code 说清哪一环。 */
  | 'BLOCKED'

/**
 * 本工具的错误：message 恒为 `<CODE>: <compact-json>`（TC §1.2），并带 `.code`
 * （测试与宿主日志只认这个前缀，不去解析自然语言）。
 */
export class TranscriptImportError extends Error {
  readonly code: TranscriptImportErrorCode

  constructor(code: TranscriptImportErrorCode, body: string) {
    super(`${code}: ${body}`)
    this.name = 'TranscriptImportError'
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
 * 抛一条契约错误。
 * @param code - 顶层 code（同时是 message 前缀）。
 * @param parts - reason_code / message / 可选 detail。
 */
function fail(code: TranscriptImportErrorCode, parts: ErrorParts): never {
  const body: Record<string, unknown> = {
    code,
    reason_code: parts.reason_code,
    message: parts.message,
  }
  if (parts.detail !== undefined) body.detail = parts.detail
  throw new TranscriptImportError(code, canonicalJson(body))
}

/**
 * 参数表（封闭对象根；`tenant_id`/`actor_id` 由 `parseContractArgs` 直接判
 * `TENANT_OR_ACTOR_NOT_ALLOWED`，TC §0 第 4 条）。
 */
const PARAMS: ParamMap = {
  interview_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: '哪一场面试（UUID）。转写只能挂到"已经绑定的会议"上，本工具不接受按标题/时间猜。',
  },
  content: {
    kind: 'string',
    // 可选：与 minute_token / external_meeting_id **二选一**（见 validateTranscriptImportArgs）。
    maxLength: MAX_CONTENT_CHARS,
    description:
      '转写原文（1..400000 字符）。逐字节保存为 raw_text，不清洗、不摘要、不改写；'
      + '按 \\r?\\n 切行写入 transcript_segment（空行跳过但序号不重排）。'
      + '人工上传路径必填，且必须给 source_kind；与 minute_token/external_meeting_id 不能同时给。',
  },
  minute_token: {
    kind: 'string',
    maxLength: 255,
    description:
      '飞书妙记的 minute_token（连接器回读路径）。没给 content 时给这个（或只给 external_meeting_id，'
      + '用于定位会议）就会由飞书连接器 fetchTranscript() 取正文；回读被阻断时返回 BLOCKED，不写任何行。'
      + '本机默认未装配传输层（插件配置没有 feishu.cli），因此默认就是 BLOCKED/TRANSPORT_NOT_CONFIGURED。',
  },
  external_meeting_id: {
    kind: 'string',
    maxLength: 255,
    description:
      '飞书会议 id（可选，连接器回读路径）：多会议绑同一场面试时按**平台会议 id**消歧（不按标题/时间猜）。'
      + '给了就必须与该面试某条 active 绑定的 external_meeting_id 精确相等，否则 NOT_FOUND(MEETING_NOT_FOUND)。'
      + '只有它、没有 minute_token 时不会发起回读（INVALID_ARGS/MINUTE_TOKEN_REQUIRED）。',
  },
  source_kind: {
    kind: 'string',
    values: [...SOURCE_KINDS],
    description:
      '人工上传路径必填（给了 content 就必须给）。'
      + 'PLATFORM_EXPORT = 人上传的"平台导出的转写文件"（provenance=LIVE，必须给 exported_file_name）；'
      + 'DEMO_SAMPLE = 演示/测试文本（provenance=FIXTURE，一律附 FIXTURE_CONTENT_NOT_LIVE，'
      + '绝不当 LIVE）。人工手打的会议纪要不得走这两个值（TR-S5）。'
      + '连接器回读路径不得给（provenance 由回读结果决定，不接受自报）。',
  },
  exported_file_name: {
    kind: 'string',
    maxLength: 255,
    description:
      '平台导出文件名（PLATFORM_EXPORT 必填；缺 → INVALID_ARGS(EXPORT_FILE_NAME_REQUIRED)）。'
      + '会写进 read_receipt_ref=`upload:<actor>:sha256:<hex>;file=<name>`，不得含 ";" 或换行。',
  },
  language: {
    kind: 'string',
    maxLength: 16,
    description: '语言标签（默认 zh，1..16 字符），原样写进 transcript_artifact.language。',
  },
  meeting_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description:
      '可选：多会议（PRIMARY + CONTINUATION）绑同一场面试时用于消歧。'
      + '必须属于该面试的 active 绑定且 role ∈ {PRIMARY, CONTINUATION}，否则 NOT_FOUND(MEETING_NOT_FOUND)。',
  },
  note: {
    kind: 'string',
    maxLength: 500,
    description: '可选备注（1..500 字符）。只用于人工追溯，不落 transcript 原文列，不进 sections。',
  },
}

/** `changes[]` 的一条（真正插入/更新了哪一行）。 */
interface ChangeRow {
  readonly table: string
  readonly id: string
}

/** 一条结构化警告（封闭集见 RD §3.1；message 说清"为什么不能说成别的"）。 */
interface WarningRow {
  readonly code: string
  readonly message: string
}

/** 本工具的输出值（`output.schema` 的运行时形状；所有可选键都是**省略**而非 null）。 */
export interface TranscriptImportValue {
  readonly tool: string
  readonly contract_version: string
  readonly status: 'OK'
  readonly write: true
  readonly replayed: boolean
  readonly labels: { readonly provenance: string; readonly trigger: string; readonly connection: string }
  readonly provenance_basis: string
  readonly interview: Record<string, unknown>
  readonly meeting: Record<string, unknown>
  readonly artifact: Record<string, unknown>
  readonly record?: Record<string, unknown>
  readonly changes: { readonly created: readonly ChangeRow[]; readonly updated: readonly ChangeRow[] }
  readonly warnings: readonly WarningRow[]
  readonly next_actions: readonly never[]
}

const CHANGE_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['table', 'id'],
  properties: {
    table: { type: 'string', description: '表名（不带 schema 前缀）。' },
    id: { type: 'string', description: '该行的主键。' },
  },
}

const WARNING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', description: '警告码（封闭集）。' },
    message: { type: 'string', description: '一句中文说明。' },
  },
}

/** 输出 schema：只用 DSH 子集关键字，任何节点都没有 `type:'null'` / type 数组。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tool', 'contract_version', 'status', 'write', 'replayed', 'labels', 'provenance_basis',
    'interview', 'meeting', 'artifact', 'changes', 'warnings', 'next_actions',
  ],
  properties: {
    tool: { type: 'string', description: '工具名。' },
    contract_version: { type: 'string', description: '契约版本（1.0.0）。' },
    status: { type: 'string', enum: ['OK'], description: '成功即 OK；失败抛 `Error: <CODE>: <json>`。' },
    write: { type: 'boolean', description: '本工具会写库，恒 true。' },
    replayed: {
      type: 'boolean',
      description: 'true = 同一 (meeting, provider_artifact_id) 已有相同 content_sha256 的产物，本次一行都没写（TR-U8）。',
    },
    labels: {
      type: 'object',
      additionalProperties: false,
      required: ['provenance', 'trigger', 'connection'],
      properties: {
        provenance: { type: 'string', enum: ['FIXTURE', 'LIVE'], description: '数据是真的还是造的。' },
        trigger: { type: 'string', enum: ['MANUAL'], description: '本工具只由人/模型在会话里调用，恒 MANUAL。' },
        connection: {
          type: 'string',
          enum: ['NOT_CONNECTED', 'AUTH_REQUIRED', 'CONNECTED'],
          description:
            '人工上传恒 NOT_CONNECTED；连接器回读：证据齐全（evaluateLiveGate=LIVE）才是 CONNECTED，'
            + '否则按 probe() 的真实状态给 NOT_CONNECTED/AUTH_REQUIRED。',
        },
      },
      description:
        '三维正交标签（R4）。人工路径：LIVE 当且仅当 source_kind=PLATFORM_EXPORT 且给出导出文件名；'
        + '连接器回读路径：provenance/connection 由**本次回读证据**算出（平台通道 + 回执绑定哈希 + '
        + 'content_sha256 与 raw_text 重算一致 + 重读哈希 + 带偏移 fetched_at + 完整分页 + 非空正文）：'
        + '全齐 → LIVE/MANUAL/CONNECTED，缺一项 → FIXTURE/MANUAL/{NOT_CONNECTED,AUTH_REQUIRED}。'
        + 'replayed=true 时回显既有行的真实标注，不因本次入参而升级。',
    },
    provenance_basis: {
      type: 'string',
      description:
        'provenance 的判定依据（一句话理由码）。人工路径两值；连接器回读：证据齐全为 '
        + `${LIVE_READBACK_PROVENANCE_BASIS}，证据不齐为 ${FEISHU_READBACK_PROVENANCE_BASIS}（说清缺哪项见 warnings）。`,
    },
    interview: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'application_id', 'job_id', 'round_no', 'stage_code', 'status'],
      properties: {
        id: { type: 'string' },
        application_id: { type: 'string' },
        job_id: { type: 'string' },
        round_no: { type: 'integer' },
        stage_code: { type: 'string' },
        status: { type: 'string' },
      },
      description: '这场面试（只回显身份与状态，不含候选人姓名）。',
    },
    meeting: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'provider', 'meeting_role', 'binding_id', 'binding_method'],
      properties: {
        id: { type: 'string' },
        provider: { type: 'string' },
        external_meeting_id: { type: 'string', description: '平台会议 id；平台没给就省略这个键。' },
        meeting_role: { type: 'string', enum: ['PRIMARY', 'CONTINUATION'] },
        binding_id: { type: 'string' },
        binding_method: { type: 'string' },
      },
      description: '这次导入落到哪个已绑定会议（绑定靠平台 ID，不靠标题）。',
    },
    artifact: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id', 'meeting_id', 'provider', 'provider_artifact_id', 'source_revision', 'variant_type',
        'transcript_status', 'provenance', 'trigger_mode', 'connection_state', 'is_canonical',
        'is_complete', 'has_more', 'content_sha256', 'char_count', 'segment_count',
      ],
      properties: {
        id: { type: 'string' },
        meeting_id: { type: 'string' },
        provider: { type: 'string' },
        provider_artifact_id: { type: 'string' },
        source_revision: { type: 'integer' },
        variant_type: { type: 'string', enum: ['ORIGINAL'] },
        language: { type: 'string' },
        transcript_status: { type: 'string', enum: ['READY'], description: '一次性带全内容后才 READY（TR-C8）。' },
        provenance: { type: 'string', enum: ['FIXTURE', 'LIVE'] },
        trigger_mode: { type: 'string', enum: ['MANUAL'] },
        connection_state: {
          type: 'string',
          enum: ['NOT_CONNECTED', 'AUTH_REQUIRED', 'CONNECTED'],
          description:
            '**这一行**自己的连接标注。人工路径恒 NOT_CONNECTED；连接器回读：LIVE 证据齐全才 CONNECTED，否则收敛为 NOT_CONNECTED/AUTH_REQUIRED。',
        },
        is_canonical: { type: 'boolean' },
        is_complete: { type: 'boolean' },
        has_more: { type: 'boolean' },
        content_sha256: { type: 'string', description: 'sha256(UTF-8 原文) 小写 hex。' },
        char_count: { type: 'integer' },
        segment_count: { type: 'integer' },
        fetched_at: { type: 'string', description: '入库时刻（ISO-8601）。' },
      },
      description:
        '这次落库/命中的那一版产物。**transcript READY 只代表原文齐了**，'
        + '不代表 interview_record READY（TR-D2 / TR-C6）。',
    },
    record: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'status', 'verification_status', 'transcript_revision', 'evidence_ok', 'is_current'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['NEEDS_REVIEW'] },
        verification_status: { type: 'string', enum: ['UNVERIFIED'] },
        transcript_revision: { type: 'integer' },
        evidence_ok: { type: 'boolean' },
        is_current: { type: 'boolean' },
      },
      description:
        '人工导入产生的确定性中性记录（不是模型抽取，所以 status=NEEDS_REVIEW / UNVERIFIED）。'
        + '申请没钉评分标准（rubric_version_id 为空）时**省略这个键**并给 RECORD_NOT_CREATED_NO_RUBRIC（TR-E4）。',
    },
    changes: {
      type: 'object',
      additionalProperties: false,
      required: ['created', 'updated'],
      properties: {
        created: { type: 'array', items: CHANGE_ROW_SCHEMA, description: '真正 INSERT 的行。' },
        updated: { type: 'array', items: CHANGE_ROW_SCHEMA, description: '真正被改的行（canonical / is_current）。' },
      },
      description: 'replayed=true 时两个数组都是空的 —— 那就是"没写"的证明。',
    },
    warnings: { type: 'array', items: WARNING_SCHEMA },
    next_actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' } },
      },
      description: '本工具不建 business_task，恒为空数组。',
    },
  },
}

/** 一行的 `timestamptz` 可能是 pg 给的 `Date` 也可能是字符串：统一成 ISO-8601。 */
function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** 只在值存在时写键（缺省靠省略键，不用 null 占位）。 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value
}

/** pg 的 int8/bigint 以字符串返回；`length()`/`count()` 统一转数字。 */
function toCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

/**
 * 三维标签的**唯一**派生函数（纯函数，可单测）：
 * `trigger` 恒 `MANUAL`、`connection` 恒 `NOT_CONNECTED`；`provenance` 只由来源决定。
 * @param sourceKind - `PLATFORM_EXPORT`（平台导出件）或 `DEMO_SAMPLE`（演示样本）。
 */
export function artifactLabelsForSourceKind(
  sourceKind: TranscriptSourceKind,
): { provenance: 'LIVE' | 'FIXTURE'; trigger: 'MANUAL'; connection: 'NOT_CONNECTED' } {
  return {
    provenance: sourceKind === 'PLATFORM_EXPORT' ? 'LIVE' : 'FIXTURE',
    trigger: 'MANUAL',
    connection: 'NOT_CONNECTED',
  }
}

/**
 * `provenance_basis`：给 provenance 一句话依据（**不是**自由文本，取值封闭）。
 * @param provenance - 该行真实落库的 provenance。
 */
export function provenanceBasisFor(provenance: string): string {
  return provenance === 'LIVE' ? 'PLATFORM_EXPORT_SELF_DECLARED_RECEIPT' : 'DEMO_SAMPLE_NO_PLATFORM_RECEIPT'
}

/**
 * 解析 + 校验一次导入入参（**纯函数，不碰数据库**）。
 *
 * `execute()` 与 `importTranscriptInTransaction()` 都调用它：前者保证"参数错了不建连"，
 * 后者保证"直接调用核心函数也拿到同一套校验"（集成测试就是直接调核心函数）。
 * @param raw - 模型给的 arguments（未校验）。
 * @returns 只含已声明键的入参对象。
 */
export function parseImportArgs(raw: unknown): Record<string, unknown> {
  const args = parseContractArgs(PARAMS, raw)
  validateTranscriptImportArgs(args)
  return args
}

/**
 * 入参在 schema 之外还需要的业务校验（都在**任何数据库访问 / 任何外部读取之前**跑）。
 *
 * 两条路径的判别与互斥也在这里（纯函数）：
 *   * 给了 `content` → 人工上传路径：`source_kind` 必填、导出文件名规则照旧；
 *   * 没给 `content` → 连接器回读路径：必须给 `minute_token`/`external_meeting_id`，
 *     且不得带 `source_kind`/`exported_file_name`（provenance 不接受自报）。
 */
export function validateTranscriptImportArgs(args: Record<string, unknown>): void {
  const content = typeof args.content === 'string' ? args.content : undefined
  const sourceKind = typeof args.source_kind === 'string' ? (args.source_kind as TranscriptSourceKind) : undefined
  const fileName = typeof args.exported_file_name === 'string' ? args.exported_file_name : undefined
  const minuteToken = readNonEmptyString(args.minute_token)
  const externalMeetingId = readNonEmptyString(args.external_meeting_id)
  const connectorRequested = minuteToken !== null || externalMeetingId !== null

  // ---- 路径判别 -------------------------------------------------------------
  if (content === undefined && !connectorRequested) {
    fail('INVALID_ARGS', {
      reason_code: 'MISSING_REQUIRED',
      message: '必须给出 content（人工上传正文）或 minute_token / external_meeting_id（连接器回读）之一：'
        + '本工具不接受空导入，也不会自己去猜一场会议',
      detail: { required_any_of: ['content', 'minute_token', 'external_meeting_id'] },
    })
  }
  if (content !== undefined && connectorRequested) {
    fail('INVALID_ARGS', {
      reason_code: 'MUTUALLY_EXCLUSIVE',
      message: 'content 与 minute_token / external_meeting_id 不能同时给：有正文就走人工上传，没有正文才回读；'
        + '否则说不清落库的字节到底来自哪一条路径',
      detail: {
        content_present: true,
        minute_token_present: minuteToken !== null,
        external_meeting_id_present: externalMeetingId !== null,
      },
    })
  }

  // ---- 人工上传路径（既有规则一条不放松）------------------------------------
  if (content !== undefined) {
    if (content.length < 1 || content.length > MAX_CONTENT_CHARS) {
      fail('INVALID_ARGS', {
        reason_code: 'OUT_OF_RANGE',
        message: `content 必须是 1..${MAX_CONTENT_CHARS} 个字符`,
        detail: { content_length: content.length },
      })
    }
    if (sourceKind === undefined) {
      fail('INVALID_ARGS', {
        reason_code: 'MISSING_REQUIRED',
        message: '给了 content 就必须给 source_kind：'
          + '不说清"这是平台导出件还是演示文本"，就没有任何依据标 provenance（TR-S3/S4/S5）',
        detail: { required: ['source_kind'] },
      })
    }
    if (sourceKind === 'PLATFORM_EXPORT' && fileName === undefined) {
      fail('INVALID_ARGS', {
        reason_code: 'EXPORT_FILE_NAME_REQUIRED',
        message: 'source_kind=PLATFORM_EXPORT 时必须给出 exported_file_name：'
          + '录不上"这是哪个平台导出文件"，就没有任何证据说这批字节来自平台（TR-S3 / TR-S4）',
        detail: { source_kind: sourceKind },
      })
    }
    if (sourceKind === 'DEMO_SAMPLE' && fileName !== undefined) {
      fail('INVALID_ARGS', {
        reason_code: 'MUTUALLY_EXCLUSIVE',
        message: 'source_kind=DEMO_SAMPLE 不得带 exported_file_name：演示文本不是平台导出件，'
          + '带文件名会凭空造出一份"导出回执"',
        detail: { exported_file_name: fileName, source_kind: sourceKind },
      })
    }
    if (fileName !== undefined && /[;\r\n]/.test(fileName)) {
      fail('INVALID_ARGS', {
        reason_code: 'OUT_OF_RANGE',
        message: 'exported_file_name 不得含 ";" 或换行：它要原样拼进 read_receipt_ref，'
          + '含分隔符会让回执无法解析',
        detail: { exported_file_name: fileName },
      })
    }
    return
  }

  // ---- 连接器回读路径 -------------------------------------------------------
  if (sourceKind !== undefined || fileName !== undefined) {
    fail('INVALID_ARGS', {
      reason_code: 'MUTUALLY_EXCLUSIVE',
      message: 'source_kind / exported_file_name 只属于人工上传路径：连接器回读的 provenance 由回读结果决定，'
        + '不接受调用方自报来源',
      detail: {
        source_kind_present: sourceKind !== undefined,
        exported_file_name_present: fileName !== undefined,
      },
    })
  }
  if (minuteToken === null) {
    fail('INVALID_ARGS', {
      reason_code: 'MINUTE_TOKEN_REQUIRED',
      message: '连接器回读必须给 minute_token：只给 external_meeting_id 定位得到会议，'
        + '但没有平台产物标识就不能回读，也不猜（不发起任何读取、不写任何行）',
      detail: { external_meeting_id_present: externalMeetingId !== null, required: ['minute_token'] },
    })
  }
  // 回执形如 lark:minutes+detail:<token>@<revision>：token 里的 @ 会让回执不可解析，
  // 在发起任何读取之前就拒绝（传输层 validate 阶段也有同样的自检，这里是更早的一道）。
  if (minuteToken.includes('@') || /[\r\n]/.test(minuteToken)) {
    fail('INVALID_ARGS', {
      reason_code: 'OUT_OF_RANGE',
      message: 'minute_token 不得含 "@" 或换行：它要原样拼进读取回执 lark:minutes+detail:<token>@<revision>',
      detail: { minute_token_length: minuteToken.length },
    })
  }
}

/** 连接器回读落库允许的三维标签（永不 CONNECTED，除非 gate 真的 LIVE）。 */
export type ConnectorReadbackLabels = {
  readonly provenance: 'LIVE' | 'FIXTURE'
  readonly trigger: 'MANUAL'
  readonly connection: 'CONNECTED' | 'NOT_CONNECTED' | 'AUTH_REQUIRED'
}

/**
 * 连接器回读落库时的三维标签（纯函数，由**回读证据**算出，不接受自报）。
 *
 * 规则只有一条：`evaluateLiveGate(readback)` 给 `LIVE` → `LIVE / MANUAL / CONNECTED`；
 * 否则 `FIXTURE / MANUAL / {NOT_CONNECTED, AUTH_REQUIRED}`。
 * 缺任何一项证据都不是 LIVE；`CONNECTED` 这个值只能从 gate 成功路径来，
 * 调用方传什么（包括 probe 自报）都不能把它「升」成 CONNECTED。
 * @param readback - 连接器回读对象（不可信输入，逐项核对）。
 * @param connection - 连接器 probe() 的连接态（只在非 LIVE 时使用；`NOT_CONNECTED` 原样保留，其余收敛为 AUTH_REQUIRED）。
 */
export function connectorReadbackLabels(
  readback: unknown,
  connection: Connection | string = 'AUTH_REQUIRED',
): ConnectorReadbackLabels {
  if (evaluateLiveGate(readback).gate === 'LIVE') {
    return { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' }
  }
  return {
    provenance: 'FIXTURE',
    trigger: 'MANUAL',
    connection: connection === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'AUTH_REQUIRED',
  }
}

/** 一次导入的正文来源（两条路径的判别联合；调用方看不到正文之外的原始回读对象）。 */
export type TranscriptImportSource =
  | {
      readonly mode: 'MANUAL'
      readonly content: string
      readonly sourceKind: TranscriptSourceKind
      readonly exportedFileName?: string
    }
  | {
      readonly mode: 'CONNECTOR_READBACK'
      readonly content: string
      readonly readback: FeishuCliTranscriptReadback
      readonly minuteToken: string
      readonly labels: ConnectorReadbackLabels
      /** 本次回读的 Gate 结论（LIVE / BLOCKED + 缺哪项 + 证据快照）。 */
      readonly liveGate: LiveGateDecision
    }

/** 连接器回读被阻断 → 本工具的 `BLOCKED` 错误（detail 里逐项说清，不回显正文/minute_token）。 */
function failConnectorBlocked(result: FeishuTranscriptBlocked, issues: readonly string[]): never {
  const detail: Record<string, unknown> = {
    connector: result.connector,
    connector_result: 'BLOCKED',
    error_code: result.error_code,
    blocked_reason: result.blocked_reason,
    connection_state: result.connection_state,
    labels: result.labels,
    creates_artifact: false,
    requested: result.requested,
  }
  if (result.failure !== undefined) detail.failure = result.failure
  if (issues.length > 0) detail.config_issues = [...issues]
  fail('BLOCKED', {
    reason_code: result.blocked_reason,
    message: `飞书连接器回读被阻断（error_code=${result.error_code}, blocked_reason=${result.blocked_reason}）：`
      + `${result.message} 本次没有读到正文，也没有写任何 artifact。`,
    detail,
  })
}

/** 平台说「还在生成」：不是失败，但本次没有正文可写（TR-F1 / P-3）。 */
function failConnectorWaiting(result: FeishuTranscriptWaitingExternal): never {
  fail('BLOCKED', {
    reason_code: 'PROVIDER_GENERATING',
    message: `飞书平台说产物还在生成（provider_code=${result.provider_code}）：不是失败，`
      + `但本次没有正文也没有 artifact；等生成完再重试。${result.message}`,
    detail: {
      connector: result.connector,
      connector_result: 'WAITING_EXTERNAL',
      task_state: result.task_state,
      provider_code: result.provider_code,
      connection_state: result.connection_state,
      labels: result.labels,
      creates_artifact: false,
    },
  })
}

/**
 * 决定这次导入的正文从哪来。**在任何数据库访问之前**调用（`execute()` 里先于建连，
 * 核心函数里先于所有 SELECT/INSERT），所以任何 BLOCKED 都保证「一行没写」。
 *
 * 连接器路径的四类出口全部映射为**抛错**（不返回半成品）：
 *   * `ERROR`（缺 minute_token）→ `INVALID_ARGS`；
 *   * `BLOCKED`（凭据/传输层/平台失败）→ `BLOCKED` + 闭集 `reason_code` + connector 的 error_code；
 *   * `WAITING_EXTERNAL`（2091003）→ `BLOCKED/PROVIDER_GENERATING`（不是失败，但本次无正文）；
 *   * `READ` → 自检正文（非空、不超过 `MAX_CONTENT_CHARS`）后返回 `CONNECTOR_READBACK` 来源。
 *
 * @param args - 已通过 `validateTranscriptImportArgs()` 的入参。
 * @param connector - 插件配置装配出的连接器；`undefined` = 默认态（不装配传输层）。
 * @param connectorIssues - 装配配置问题（例如 cli 不是绝对路径），只进 BLOCKED 的 detail。
 */
export async function resolveImportSource(
  args: Record<string, unknown>,
  connector?: FeishuConnectorDependency,
  connectorIssues: readonly string[] = [],
): Promise<TranscriptImportSource> {
  const content = typeof args.content === 'string' ? args.content : undefined
  if (content !== undefined) {
    const sourceKind = args.source_kind as TranscriptSourceKind
    const fileName = typeof args.exported_file_name === 'string' ? args.exported_file_name : undefined
    return fileName === undefined
      ? { mode: 'MANUAL', content, sourceKind }
      : { mode: 'MANUAL', content, sourceKind, exportedFileName: fileName }
  }

  const minuteToken = readNonEmptyString(args.minute_token)
  if (minuteToken === null) {
    fail('INVALID_ARGS', {
      reason_code: 'MINUTE_TOKEN_REQUIRED',
      message: '连接器回读必须有 minute_token：本次没有正文、没有发起读取、没有写任何行',
      detail: { required: ['minute_token'] },
    })
  }
  // 默认态：插件配置没装配传输层 → fail-closed。**不**回退到环境变量 / PATH 上的 CLI。
  if (connector === undefined || connector.transport_configured !== true) {
    const detail: Record<string, unknown> = {
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      connector_result: 'BLOCKED',
      blocked_reason: 'TRANSPORT_NOT_CONFIGURED',
      transport_configured: false,
      // README §5 的既有口径：**传输层未装配**本身就归 AUTH_REQUIRED（不是 CONNECTED，也不假装有数据）。
      connection_state: 'AUTH_REQUIRED',
      creates_artifact: false,
      requested: {
        minute_token_present: true,
        external_meeting_id_present: readNonEmptyString(args.external_meeting_id) !== null,
      },
    }
    if (connectorIssues.length > 0) detail.config_issues = [...connectorIssues]
    fail('BLOCKED', {
      reason_code: 'TRANSPORT_NOT_CONFIGURED',
      message: '连接器回读路径没有可用的传输层：插件配置里没有装配 feishu.cli（lark-cli 的绝对路径），'
        + '本工具默认不拉起任何子进程、也不从环境变量 / PATH 找 CLI。'
        + '本次没有读正文，也没有写任何 artifact（先注入传输层再重试）。',
      detail,
    })
  }

  const adapter: FeishuMinutesAdapter = connector.adapter
  let result: Awaited<ReturnType<FeishuMinutesAdapter['fetchTranscript']>>
  try {
    result = await adapter.fetchTranscript({
      minute_token: minuteToken,
      external_meeting_id: args.external_meeting_id,
    })
  } catch (error) {
    // 适配器本身抛异常（不该发生）：按 fail-closed 处理，不回显异常 message（可能带内部路径）。
    fail('BLOCKED', {
      reason_code: 'CONNECTOR_CALL_FAILED',
      message: '飞书连接器调用抛出非预期异常：按 fail-closed 处理，本次没有正文也没有写任何 artifact。',
      detail: {
        connector: FEISHU_MINUTES_CONNECTOR_ID,
        connector_result: 'BLOCKED',
        error_name: error instanceof Error ? error.name : typeof error,
        creates_artifact: false,
      },
    })
  }

  if (result.kind === 'ERROR') {
    fail('INVALID_ARGS', {
      reason_code: result.reason_code,
      message: `${result.message} 本次没有发起读取，也没有写任何行。`,
      detail: { connector: result.connector, requested: result.requested },
    })
  }
  if (result.kind === 'BLOCKED') failConnectorBlocked(result, connectorIssues)
  if (result.kind === 'WAITING_EXTERNAL') failConnectorWaiting(result)

  // ---- READ：正文必须非空且回读自洽；标签由 evaluateLiveGate() 按证据算 ----------
  const readback = result.readback
  if (typeof readback.raw_text !== 'string' || readback.raw_text.trim() === '') {
    fail('BLOCKED', {
      reason_code: 'READBACK_INVALID',
      message: '连接器声称读成功，但回读对象没有正文：拒绝把空内容当产物（P-2），没有写任何 artifact。',
      detail: { connector: FEISHU_MINUTES_CONNECTOR_ID, readback_transport: readback.transport, creates_artifact: false },
    })
  }
  if (readback.raw_text.length > MAX_CONTENT_CHARS) {
    fail('BLOCKED', {
      reason_code: 'TRANSCRIPT_TOO_LARGE',
      message: `回读正文 ${readback.raw_text.length} 字符，超过本工具上限 ${MAX_CONTENT_CHARS}：`
        + '不截断、不摘要，也没有写任何 artifact。',
      detail: { char_count: readback.raw_text.length, max_chars: MAX_CONTENT_CHARS, creates_artifact: false },
    })
  }
  // 回读对象自相矛盾 = 失败，不是警告：声明的 sha / 回执摘要 / 重读哈希
  // 必须与 raw_text 对得上，否则不写任何行（降到 FIXTURE 继续写会把矛盾洗白）。
  const contradictions = readbackConsistencyViolations(readback)
  if (contradictions.length > 0) {
    fail('BLOCKED', {
      reason_code: 'READBACK_INVALID',
      message: '连接器回读对象自相矛盾：声明的 content_sha256 / read_receipt_ref / reread_sha256 '
        + '与 raw_text 重新计算的结果不一致。回读不一致是失败，不是警告；本次没有正文，也没有写任何 artifact。',
      detail: {
        connector: FEISHU_MINUTES_CONNECTOR_ID,
        connector_result: 'BLOCKED',
        violations: [...contradictions],
        creates_artifact: false,
      },
    })
  }
  const liveGate = evaluateLiveGate(readback)
  return {
    mode: 'CONNECTOR_READBACK',
    content: readback.raw_text,
    readback,
    minuteToken,
    // 不信任适配器给的标签：标签只由本次回读的证据算；缺证据就只能 FIXTURE。
    labels: connectorReadbackLabels(readback, result.labels.connection),
    liveGate,
  }
}

/** `interview` + 所属申请的关键列（`job_id` / `rubric_version_id` 只从这里来）。 */
interface InterviewRow {
  id: string
  application_id: string
  round_no: number
  stage_code: string
  status: string
  scheduled_start_at: Date | null
  scheduled_end_at: Date | null
  job_id: string
  rubric_version_id: string | null
  /**
   * 该 rubric 是否真的属于 `application.job_id`（左连条件里已判定）。
   * 本机 `interview_record` **还没有** `job_id` 列（0008 未应用），所以"评分标准必须绑该申请的岗位"
   * 这条（0008 GAP-C）只能由**写侧**自己校验，不能指望库里没有的复合外键。
   */
  rubric_job_ok: boolean
  candidate_id: string
}

/** 一条 active 绑定 + 它的会议（只含 PRIMARY / CONTINUATION）。 */
interface BindingRow {
  binding_id: string
  binding_method: string
  meeting_id: string
  provider: string
  external_meeting_id: string | null
  meeting_role: string
  actual_start_at: Date | null
  actual_end_at: Date | null
}

/** 某一 `(meeting, provider_artifact_id)` 下已有的产物行。 */
interface ArtifactRow {
  id: string
  source_revision: number
  content_sha256: string | null
  is_canonical: boolean
  provider: string
  provider_artifact_id: string
  variant_type: string
  language: string | null
  transcript_status: string
  provenance: string
  trigger_mode: string
  connection_state: string
  is_complete: boolean
  has_more: boolean
  fetched_at: Date | null
  char_count: string | number | null
}

/** 一条已存在的 `interview_record`（只取回显需要的列）。 */
interface RecordRow {
  id: string
  status: string
  verification_status: string
  transcript_revision: number
  evidence_ok: boolean
  is_current: boolean
}

/**
 * 读面试（不存在 → `NOT_FOUND(INTERVIEW_NOT_FOUND)`）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户（来自配置，不接受入参）。
 * @param interviewId - 面试 id。
 */
async function loadInterview(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<InterviewRow> {
  const { rows } = await client.query<InterviewRow>(
    `select i.id, i.application_id, i.round_no, i.stage_code, i.status,
            i.scheduled_start_at, i.scheduled_end_at,
            a.job_id, a.rubric_version_id, a.candidate_id,
            (rv.id is not null) as rubric_job_ok
       from recruitment.interview i
       join recruitment.application a
         on a.id = i.application_id and a.tenant_id = i.tenant_id
       left join recruitment.rubric_version rv
         on rv.id = a.rubric_version_id
        and rv.tenant_id = a.tenant_id
        and rv.job_id = a.job_id
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

/**
 * 取该面试的 active 绑定会议，**只保留 PRIMARY / CONTINUATION**（TR-D4）。
 * 排序：PRIMARY 在前，再按绑定时间、会议 id（结果是确定的）。
 */
async function loadBindings(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<BindingRow[]> {
  const { rows } = await client.query<BindingRow>(
    `select b.id as binding_id, b.binding_method,
            m.id as meeting_id, m.provider, m.external_meeting_id, m.meeting_role,
            m.actual_start_at, m.actual_end_at
       from recruitment.meeting_binding b
       join recruitment.meeting m
         on m.id = b.meeting_id and m.tenant_id = b.tenant_id
      where b.interview_id = $1
        and b.tenant_id = $2
        and b.unbound_at is null
        and m.meeting_role = any($3::text[])
      order by (m.meeting_role = 'PRIMARY') desc, b.bound_at, m.id`,
    [interviewId, tenantId, [...TRANSCRIPT_MEETING_ROLES]],
  )
  return rows
}

/**
 * 决定这次导入落到哪个会议：给了 `meeting_id` 就精确匹配；否则给了
 * `external_meeting_id` 就按**平台会议 id** 精确匹配；都没给则必须唯一。
 * 任何"多个候选"都不猜（TR-L3：不按标题 / 时间 / 参会人绑定）。
 * @returns 选中的绑定。
 */
function chooseMeeting(
  bindings: readonly BindingRow[],
  request: { readonly meeting_id?: string; readonly external_meeting_id?: string },
  interviewId: string,
): BindingRow {
  if (bindings.length === 0) {
    fail('NO_MEETING_BOUND', {
      reason_code: 'NO_MEETING_BOUND',
      message: '该面试没有处于有效绑定状态的会议（meeting_role ∈ {PRIMARY, CONTINUATION}），'
        + '无法确定转写归属；未写入任何行',
      detail: {
        interview_id: interviewId,
        meeting_count: 0,
        hint: '先在 recruitment.meeting_binding 里把平台会议绑到这场面试'
          + '（binding_method=MANUAL 时必须留 bound_by_actor_id），再导入转写',
      },
    })
  }
  if (request.meeting_id !== undefined) {
    const matched = bindings.find((binding) => binding.meeting_id === request.meeting_id)
    if (matched === undefined) {
      fail('NOT_FOUND', {
        reason_code: 'MEETING_NOT_FOUND',
        message: '入参 meeting_id 不是该面试的 active 绑定会议（或它的 meeting_role 不在转写集合里）',
        detail: { interview_id: interviewId, meeting_count: bindings.length, meeting_id: request.meeting_id },
      })
    }
    return matched
  }
  if (request.external_meeting_id !== undefined) {
    const matched = bindings.filter((binding) => binding.external_meeting_id === request.external_meeting_id)
    if (matched.length === 1) return matched[0] as BindingRow
    if (matched.length === 0) {
      fail('NOT_FOUND', {
        reason_code: 'MEETING_NOT_FOUND',
        message: '入参 external_meeting_id 不匹配该面试任何一条 active 绑定会议的平台会议 id；'
          + '不按标题 / 时间猜，也未写入任何行',
        detail: {
          interview_id: interviewId,
          meeting_count: bindings.length,
          external_meeting_id_present: true,
          hint: 'external_meeting_id 必须与 recruitment.meeting.external_meeting_id 精确相等',
        },
      })
    }
    fail('AMBIGUOUS_MEETING', {
      reason_code: 'AMBIGUOUS_MEETING',
      message: '同一个 external_meeting_id 匹配到多条 active 绑定会议，必须改用 meeting_id 明确指定；'
        + '未写入任何行',
      detail: { interview_id: interviewId, match_count: matched.length },
    })
  }
  if (bindings.length > 1) {
    fail('AMBIGUOUS_MEETING', {
      reason_code: 'AMBIGUOUS_MEETING',
      message: '同一场面试有多个 active 绑定会议（PRIMARY / CONTINUATION），必须用 meeting_id 明确指定；'
        + '未写入任何行',
      detail: {
        interview_id: interviewId,
        meeting_count: bindings.length,
        candidates: bindings.map((binding) => ({
          meeting_id: binding.meeting_id,
          meeting_role: binding.meeting_role,
          provider: binding.provider,
        })),
        hint: '按平台的 external_meeting_id 认准是哪一个会议，再把它的 meeting_id 传进来',
      },
    })
  }
  return bindings[0] as BindingRow
}

/** 取某个 `(meeting, provider_artifact_id)` 下已有的全部 revision（用于去重与算新 revision）。 */
async function loadArtifactRevisions(
  client: DatabaseClient,
  tenantId: string,
  meetingId: string,
  providerArtifactId: string,
): Promise<ArtifactRow[]> {
  const { rows } = await client.query<ArtifactRow>(
    `select id, source_revision, content_sha256, is_canonical, provider, provider_artifact_id,
            variant_type, language, transcript_status, provenance, trigger_mode, connection_state,
            is_complete, has_more, fetched_at, length(raw_text) as char_count
       from recruitment.transcript_artifact
      where tenant_id = $1 and meeting_id = $2 and provider_artifact_id = $3
      order by source_revision`,
    [tenantId, meetingId, providerArtifactId],
  )
  return rows
}

/**
 * 找引用 `(artifact_id, source_revision)` 的 `interview_record`：`is_current` 优先，否则最新一条。
 * @returns 没找到就是 `undefined`（TR-E4：先有 artifact 才可能有 record）。
 */
async function loadRecordForArtifact(
  client: DatabaseClient,
  tenantId: string,
  artifactId: string,
  sourceRevision: number,
): Promise<RecordRow | undefined> {
  const { rows } = await client.query<RecordRow>(
    `select id, status, verification_status, transcript_revision, evidence_ok, is_current
       from recruitment.interview_record
      where tenant_id = $1 and transcript_artifact_id = $2 and transcript_revision = $3
      order by is_current desc, created_at desc, id
      limit 1`,
    [tenantId, artifactId, sourceRevision],
  )
  return rows[0]
}

/** 数一下某 artifact 的片段数（replay 路径要回显 segment_count）。 */
async function countSegments(client: DatabaseClient, tenantId: string, artifactId: string): Promise<number> {
  const { rows } = await client.query<{ total: string | number }>(
    'select count(*) as total from recruitment.transcript_segment where tenant_id = $1 and artifact_id = $2',
    [tenantId, artifactId],
  )
  return toCount(rows[0]?.total)
}

/** pg 的唯一键冲突（`23505`）。 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === '23505'
}

/** 一次导入的公共上下文（新建与 replay 两条路径共用出参装配）。 */
interface ValueContext {
  readonly interview: InterviewRow
  readonly binding: BindingRow
  readonly artifact: Record<string, unknown>
  readonly labels: { provenance: string; trigger: string; connection: string }
  readonly provenanceBasis: string
  readonly replayed: boolean
  readonly record?: Record<string, unknown>
  readonly created: readonly ChangeRow[]
  readonly updated: readonly ChangeRow[]
  readonly warnings: readonly WarningRow[]
}

/** 装配出参（**唯一**一处，保证两条路径形状逐字节一致）。 */
function buildValue(ctx: ValueContext): TranscriptImportValue {
  const meeting: Record<string, unknown> = {
    id: ctx.binding.meeting_id,
    provider: ctx.binding.provider,
    meeting_role: ctx.binding.meeting_role,
    binding_id: ctx.binding.binding_id,
    binding_method: ctx.binding.binding_method,
  }
  put(meeting, 'external_meeting_id', ctx.binding.external_meeting_id ?? undefined)
  const value: TranscriptImportValue = {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    write: true,
    replayed: ctx.replayed,
    labels: ctx.labels,
    provenance_basis: ctx.provenanceBasis,
    interview: {
      id: ctx.interview.id,
      application_id: ctx.interview.application_id,
      job_id: ctx.interview.job_id,
      round_no: ctx.interview.round_no,
      stage_code: ctx.interview.stage_code,
      status: ctx.interview.status,
    },
    meeting,
    artifact: ctx.artifact,
    changes: { created: [...ctx.created], updated: [...ctx.updated] },
    warnings: [...ctx.warnings],
    next_actions: [],
  }
  return ctx.record === undefined ? value : { ...value, record: ctx.record }
}

/** 把一行已存在的产物投影成出参里的 `artifact`（replay 路径）。 */
function artifactFromRow(row: ArtifactRow, segmentCount: number): Record<string, unknown> {
  const artifact: Record<string, unknown> = {
    id: row.id,
    meeting_id: '',
    provider: row.provider,
    provider_artifact_id: row.provider_artifact_id,
    source_revision: row.source_revision,
    variant_type: row.variant_type,
    transcript_status: row.transcript_status,
    provenance: row.provenance,
    trigger_mode: row.trigger_mode,
    connection_state: row.connection_state,
    is_canonical: row.is_canonical,
    is_complete: row.is_complete,
    has_more: row.has_more,
    content_sha256: row.content_sha256,
    char_count: toCount(row.char_count),
    segment_count: segmentCount,
  }
  put(artifact, 'language', row.language ?? undefined)
  put(artifact, 'fetched_at', iso(row.fetched_at))
  return artifact
}

/** 一次导入的依赖（连接器由插件配置装配；缺省 = 没有传输层）。 */
export interface TranscriptImportDeps extends ToolActorDeps {
  /** 飞书连接器（`feishu.cli` 装配成功时才有）。缺省 ⇒ 回读路径 BLOCKED。 */
  readonly connector?: FeishuConnectorDependency
  /** 连接器配置问题（例如 cli 不是绝对路径）；只进 BLOCKED 的 detail。 */
  readonly connector_issues?: readonly string[]
  /** 已解析好的来源（`execute()` 用它避免"先读一次再在事务里读第二次"）。 */
  readonly source?: TranscriptImportSource
}

/**
 * 在**调用方给定的事务**里完成一次转写导入（单独导出是为了让集成测试在
 * "必回滚事务"里跑完整写路径，不然测试会往 ra_s6s7 里留真行）。
 *
 * 步骤固定（RD §2 / TR 对应条款见每步注释）：
 *   0. **先决定正文来源**（人工正文 or 连接器回读）：回读失败在这里抛 BLOCKED，
 *      此时**一行都没写**（也是"零 artifact"的证明）；
 *   1. 面试（NOT_FOUND）；2. active 绑定会议（NO_MEETING_BOUND / AMBIGUOUS_MEETING / MEETING_NOT_FOUND）；
 *   3. sha256 + 字符数；4. 同 (meeting, provider_artifact_id) 去重 → replay 或 +1 revision；
 *   5. 一次 INSERT 带全内容（TR-C7/C8）；6. 逐行切 segment；7. 建 interview_record（无 rubric 则不建）。
 *
 * @param client - 写事务内客户端（`recruitment.actor_id` 已由 `withActor` 设置）。
 * @param cfg - 已解析配置（租户 / actor 只从这里来）。
 * @param args - 入参（本函数自己再跑一遍 `parseImportArgs`，直接调用也拿到同一套校验）。
 * @param _nowMs - 保留形参以便与读工具的核心函数同形；本工具不用它：
 *   `fetched_at` 由库的 `now()` 生成，输出里不出现"我们的墙上时间"。
 * @param deps - 连接器依赖 / 已解析来源（见 `TranscriptImportDeps`）。
 */
export async function importTranscriptInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  _nowMs?: number,
  deps: TranscriptImportDeps = {},
): Promise<TranscriptImportValue> {
  const parsed = parseImportArgs(args)
  const tenantId = cfg.tenant_id
  const actorId = cfg.actor_id
  const interviewId = parsed.interview_id as string
  const language = typeof parsed.language === 'string' ? parsed.language : 'zh'
  const requestedMeetingId = typeof parsed.meeting_id === 'string' ? parsed.meeting_id : undefined
  const requestedExternalMeetingId = typeof parsed.external_meeting_id === 'string' ? parsed.external_meeting_id : undefined

  // ---- 0. 正文来源（在任何 DB 访问之前：回读失败 = 零写入）-------------------
  const source = deps.source ?? await resolveImportSource(parsed, deps.connector, deps.connector_issues ?? [])
  const content = source.content

  // ---- 1. 面试 --------------------------------------------------------------
  const interview = await loadInterview(client, tenantId, interviewId)

  // ---- 2. active 绑定会议（REPLACED / CANCELLED 在 SQL 里就排掉，TR-D4）----
  const bindings = await loadBindings(client, tenantId, interviewId)
  const binding = chooseMeeting(
    bindings,
    {
      ...(requestedMeetingId === undefined ? {} : { meeting_id: requestedMeetingId }),
      ...(requestedExternalMeetingId === undefined ? {} : { external_meeting_id: requestedExternalMeetingId }),
    },
    interviewId,
  )
  // 连接器只读飞书妙记：会议不是飞书会议时不许把回读内容挂上去（不猜、不跨平台冒充）。
  if (source.mode === 'CONNECTOR_READBACK' && binding.provider !== FEISHU_MINUTES_PROVIDER) {
    fail('INVALID_ARGS', {
      reason_code: 'SOURCE_CONNECTOR_MISMATCH',
      message: `连接器回读只读飞书妙记，但这场面试选中的会议 provider=${binding.provider}，不是 ${FEISHU_MINUTES_PROVIDER}；`
        + '未写入任何行（也不接受改标来源）',
      detail: { interview_id: interviewId, meeting_id: binding.meeting_id, provider: binding.provider },
    })
  }

  // ---- 3. 内容指纹（原文逐字节保存，不做任何清洗）--------------------------
  const sha = createHash('sha256').update(content, 'utf8').digest('hex')
  const charCount = content.length

  // 固定列取值（RD §2）：不编造平台标识；provenance 只由来源 + 证据决定。
  // 连接器回读：provider 用会议的真实平台名；**只有 LIVE 证据齐全**才写真实平台
  // 分钟标识（`feishu:minutes:<token>`），否则用 `local:` 前缀明确表示「未经平台核实」。
  const connectorLive = source.mode === 'CONNECTOR_READBACK' && source.liveGate.gate === 'LIVE'
  const provider = source.mode === 'CONNECTOR_READBACK'
    ? binding.provider
    : source.sourceKind === 'PLATFORM_EXPORT'
      ? binding.provider
      : 'LOCAL_DEMO'
  const providerArtifactId = source.mode === 'CONNECTOR_READBACK'
    ? `${connectorLive ? FEISHU_LIVE_ARTIFACT_PREFIX : FEISHU_READBACK_ARTIFACT_PREFIX}${source.minuteToken}`
    : source.sourceKind === 'PLATFORM_EXPORT'
      ? `${ARTIFACT_ID_PREFIX}platform-export:${binding.meeting_id}`
      : `${ARTIFACT_ID_PREFIX}demo-sample:${binding.meeting_id}`
  const labels = source.mode === 'CONNECTOR_READBACK'
    ? source.labels
    : artifactLabelsForSourceKind(source.sourceKind)
  const readReceiptRef = source.mode === 'CONNECTOR_READBACK'
    ? source.readback.read_receipt_ref
    : source.sourceKind === 'PLATFORM_EXPORT' && source.exportedFileName !== undefined
      ? `upload:${actorId}:sha256:${sha};file=${source.exportedFileName}`
      : undefined
  const provenanceBasis = source.mode === 'CONNECTOR_READBACK'
    ? (connectorLive ? LIVE_READBACK_PROVENANCE_BASIS : FEISHU_READBACK_PROVENANCE_BASIS)
    : provenanceBasisFor(labels.provenance)
  const segmentSourceRef = source.mode === 'CONNECTOR_READBACK'
    ? SEGMENT_RAW_SOURCE_REF_CONNECTOR
    : SEGMENT_RAW_SOURCE_REF

  // ---- 4. 去重 / revision ---------------------------------------------------
  const revisions = await loadArtifactRevisions(client, tenantId, binding.meeting_id, providerArtifactId)
  const sameContent = revisions.filter((row) => row.content_sha256 === sha)
  if (sameContent.length > 0) {
    const existing = sameContent[sameContent.length - 1] as ArtifactRow
    return await replayValue(client, tenantId, interview, binding, existing)
  }
  const nextRevision = revisions.reduce((max, row) => Math.max(max, row.source_revision), 0) + 1

  // ---- 5. canonical 归属（TR-U7/U9；粒度 = 每 meeting 一个，TR-B3）---------
  const canonicalRows = await client.query<{ id: string; provider_artifact_id: string; source_revision: number }>(
    `select id, provider_artifact_id, source_revision
       from recruitment.transcript_artifact
      where tenant_id = $1 and meeting_id = $2 and is_canonical`,
    [tenantId, binding.meeting_id],
  )
  const canonical = canonicalRows.rows[0]
  const movesCanonical = canonical !== undefined && canonical.provider_artifact_id === providerArtifactId
  const isCanonical = canonical === undefined || movesCanonical
  const warnings: WarningRow[] = []
  if (source.mode === 'CONNECTOR_READBACK') {
    if (connectorLive) {
      warnings.push({
        code: 'FEISHU_LIVE_MANUAL_OPERATOR_READ',
        message: '本行 provenance=LIVE 的依据是本次回读证据齐全：平台通道（FEISHU_MINUTES_API）+ '
          + 'read_receipt_ref 绑定内容哈希 + content_sha256 与 raw_text 重算一致'
          + (source.readback.reread_sha256 === undefined ? '' : ' + 两次完整回读哈希一致')
          + ' + 带偏移 fetched_at + 分页取完 + 非空正文。trigger=MANUAL：这是操作者发起的读取，不是事件自动摄取。'
          + '产品自有 OAuth / 事件订阅（F2）仍是 P1、未实现；LIVE 只说明这批字节来自平台，不代表产品已具备自动摄取能力。',
      })
    } else {
      warnings.push({
        code: 'FEISHU_READBACK_NOT_LIVE',
        message: '正文由飞书连接器回读（lark-cli-transport），但本次读取**不满足 LIVE 证据**：'
          + `${source.liveGate.violations.join('；')}。`
          + `因此 provenance 只能是 FIXTURE、trigger 只能是 MANUAL、connection=${labels.connection}，不得当作"已经接通飞书"`,
      })
      if (labels.connection === 'AUTH_REQUIRED') {
        warnings.push({
          code: 'FEISHU_CONNECTION_AUTH_REQUIRED',
          message: '连接器 probe() 判定 AUTH_REQUIRED：应用凭据/用户令牌/传输层还未构成一次证据齐全的真实回读，'
            + '这一行只是 FIXTURE 语料，不是平台已接通',
        })
      }
    }
  } else if (source.sourceKind === 'DEMO_SAMPLE') {
    warnings.push({
      code: 'FIXTURE_CONTENT_NOT_LIVE',
      message: 'DEMO_SAMPLE 是演示/测试文本，不是平台回读内容；provenance 只能是 FIXTURE，'
        + '不得当作"已经接通飞书"',
    })
  } else {
    warnings.push({
      code: 'EXPORT_RECEIPT_IS_SELF_DECLARED',
      message: '导出回执由人工自述（upload:<actor>:sha256:<hex>;file=<name>）；本工具没有连接会议平台，'
        + '无法验证该文件确实由平台导出 —— provenance 记 LIVE 只是因为"字节由人搬过来"这一事实成立',
    })
  }
  if (canonical !== undefined && !movesCanonical) {
    warnings.push({
      code: 'CANONICAL_ALREADY_SELECTED',
      message: '该会议已有另一份平台产物被选为 canonical；本次新版本不夺权（TR-U9：canonical 粒度 = 每 meeting 一个）',
    })
  }

  const created: ChangeRow[] = []
  const updated: ChangeRow[] = []

  // ---- 5. 一次 INSERT 带全（TR-C7/C8；绝不先插占位行）------------------------
  // 只更新白名单列（`0001 L1777`）：is_canonical。
  // 先改旧行再插新行：`uq_transcript_artifact_canonical` 是不可延迟的部分唯一索引。
  // 保存点只用于"并发插同一份内容撞 23505"时能回滚到插入前再按 replay 返回。
  await client.query('savepoint transcript_artifact_write')
  let inserted: { id: string; fetched_at: Date } | undefined
  try {
    if (movesCanonical && canonical !== undefined) {
      await client.query(
        'update recruitment.transcript_artifact set is_canonical = false where tenant_id = $1 and id = $2',
        [tenantId, canonical.id],
      )
      updated.push({ table: 'transcript_artifact', id: canonical.id })
    }
    const result = await client.query<{ id: string; fetched_at: Date }>(
      `insert into recruitment.transcript_artifact (
         tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type, language,
         transcript_status, provenance, trigger_mode, connection_state, fetched_at, read_receipt_ref,
         content_sha256, raw_text, is_complete, has_more, is_canonical, canonical_selected_by_actor_id,
         status_changed_by_actor_id
       ) values (
         $1, $2, $3, $4, $5, 'ORIGINAL', $6,
         'READY', $7, 'MANUAL', $13, now(), $8,
         $9, $10, true, false, $11, $12,
         $14
       )
       returning id, fetched_at`,
      [
        tenantId, binding.meeting_id, provider, providerArtifactId, nextRevision, language,
        labels.provenance, readReceiptRef ?? null,
        sha, content, isCanonical, isCanonical ? actorId : null,
        labels.connection, actorId,
      ],
    )
    inserted = result.rows[0]
  } catch (error) {
    // 并发插同一份内容：回滚到插入前（含 canonical 迁移），改成 replay 返回，不抛 500。
    if (!isUniqueViolation(error)) throw error
    await client.query('rollback to savepoint transcript_artifact_write')
    const again = await loadArtifactRevisions(client, tenantId, binding.meeting_id, providerArtifactId)
    const racing = again.filter((row) => row.content_sha256 === sha)
    if (racing.length === 0) throw error
    return await replayValue(client, tenantId, interview, binding, racing[racing.length - 1] as ArtifactRow)
  }
  const artifactId = (inserted as { id: string }).id
  created.push({ table: 'transcript_artifact', id: artifactId })

  // ---- 6. transcript_segment：按 \r?\n 逐行，空行跳过但序号不重排 -------------
  const lines = content.split(/\r?\n/)
  const segments: { sequence: number; text: string }[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (line === '') continue
    segments.push({ sequence: index, text: line })
  }
  for (let start = 0; start < segments.length; start += SEGMENT_CHUNK) {
    const chunk = segments.slice(start, start + SEGMENT_CHUNK)
    const values: unknown[] = []
    const tuples: string[] = []
    for (const segment of chunk) {
      const base = values.length
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`)
      values.push(tenantId, artifactId, segment.sequence, segment.text, segmentSourceRef)
    }
    const result = await client.query<{ id: string }>(
      `insert into recruitment.transcript_segment (
         tenant_id, artifact_id, sequence, content_text, raw_source_ref
       ) values ${tuples.join(', ')}
       returning id`,
      values,
    )
    for (const row of result.rows) created.push({ table: 'transcript_segment', id: row.id })
  }

  // ---- 7. interview_record：有 rubric 才建（TR-E4；无 rubric → warning）-----
  // 本机 `interview_record` 没有 job_id 列（0008 未应用）→ 这里**不写 job_id**；
  // 岗位一致性改由 loadInterview 的左连自己判定（rubric_job_ok）。
  // 未来 0008 应用后，`trg_interview_record_job_guard` 会在 job_id 为空时从
  // interview → application 推导，所以"不写 job_id"向前兼容。
  let record: Record<string, unknown> | undefined
  const rubricEligible = interview.rubric_version_id !== null && interview.rubric_job_ok === true
  if (!rubricEligible) {
    warnings.push({
      code: 'RECORD_NOT_CREATED_NO_RUBRIC',
      message: '该申请没有可用的评分标准版本（application.rubric_version_id 为空，'
        + '或它不属于该申请的岗位）；按 TR-E4 不建 interview_record'
        + '（它的 rubric_version_id 是 NOT NULL），转写产物已正常落库',
    })
  } else {
    const turns = segments.slice(0, MAX_TURNS)
    const citedSequences = turns.map((segment) => segment.sequence)
    const evidenceOk = citedSequences.length > 0
    const sections = {
      schema: source.mode === 'CONNECTOR_READBACK' ? CONNECTOR_SECTIONS_SCHEMA : SECTIONS_SCHEMA,
      source: source.mode === 'CONNECTOR_READBACK'
        ? {
          kind: SECTIONS_SOURCE_KIND_CONNECTOR,
          provider,
          // 回读对象的 transport 是通道事实（平台通道才有 API）：写进来就是来源证据。
          transport: source.readback.transport,
          minute_token: source.readback.minute_token,
          read_receipt_ref: source.readback.read_receipt_ref,
          revision: source.readback.revision,
          content_sha256: source.readback.content_sha256,
          ...(source.readback.reread_sha256 === undefined ? {} : { reread_sha256: source.readback.reread_sha256 }),
          live_gate: source.liveGate.gate,
          ...(source.liveGate.gate === 'LIVE' ? {} : { live_gate_violations: source.liveGate.violations }),
          page_count: source.readback.page_count,
          sha,
          segment_count: segments.length,
          char_count: charCount,
          language,
        }
        : {
          kind: source.sourceKind,
          provider,
          sha,
          segment_count: segments.length,
          char_count: charCount,
          language,
          ...(source.exportedFileName === undefined ? {} : { file: source.exportedFileName }),
        },
      basis: { artifact_id: artifactId, revision: nextRevision },
      turns: turns.map((segment) => ({ sequence: segment.sequence, text: segment.text })),
      citations: citedSequences.map((sequence) => ({ kind: 'SEGMENT', sequence })),
    }
    // 先撤旧 current 再插新 current：`uq_interview_record_current` 同上是不可延迟的部分唯一索引。
    const previous = await client.query<{ id: string }>(
      `update recruitment.interview_record
          set is_current = false
        where tenant_id = $1 and interview_id = $2 and is_current
        returning id`,
      [tenantId, interviewId],
    )
    for (const row of previous.rows) updated.push({ table: 'interview_record', id: row.id })

    const recordResult = await client.query<RecordRow & { chunk_coverage: string | null }>(
      `insert into recruitment.interview_record (
         tenant_id, interview_id, transcript_artifact_id, transcript_revision, rubric_version_id,
         schema_version, prompt_version, model_id, status, verification_status, sections,
         evidence_ok, chunk_coverage, is_current, status_changed_by_actor_id
       ) values (
         $1, $2, $3, $4, $5,
         $6, $7, $8, 'NEEDS_REVIEW', 'UNVERIFIED', $9::jsonb,
         $10, 1.0, true, $11
       )
       returning id, status, verification_status, transcript_revision, evidence_ok, is_current`,
      [
        tenantId, interviewId, artifactId, nextRevision, interview.rubric_version_id,
        RECORD_SCHEMA_VERSION,
        source.mode === 'CONNECTOR_READBACK' ? CONNECTOR_RECORD_PROMPT_VERSION : RECORD_PROMPT_VERSION,
        source.mode === 'CONNECTOR_READBACK' ? CONNECTOR_RECORD_MODEL_ID : RECORD_MODEL_ID,
        JSON.stringify(sections),
        evidenceOk, actorId,
      ],
    )
    const recordRow = recordResult.rows[0] as RecordRow
    created.push({ table: 'interview_record', id: recordRow.id })
    record = {
      id: recordRow.id,
      status: recordRow.status,
      verification_status: recordRow.verification_status,
      transcript_revision: recordRow.transcript_revision,
      evidence_ok: recordRow.evidence_ok,
      is_current: recordRow.is_current,
    }
  }

  return buildValue({
    interview,
    binding,
    artifact: {
      id: artifactId,
      meeting_id: binding.meeting_id,
      provider,
      provider_artifact_id: providerArtifactId,
      source_revision: nextRevision,
      variant_type: 'ORIGINAL',
      language,
      transcript_status: 'READY',
      provenance: labels.provenance,
      trigger_mode: labels.trigger,
      connection_state: labels.connection,
      is_canonical: isCanonical,
      is_complete: true,
      has_more: false,
      content_sha256: sha,
      char_count: charCount,
      segment_count: segments.length,
      fetched_at: iso(inserted?.fetched_at),
    },
    labels,
    provenanceBasis,
    replayed: false,
    record,
    created,
    updated,
    warnings,
  })
}

/**
 * `replayed=true` 的出参：**一行都不写**，只回显已存在的那一版（TR-U8）。
 * 三维标签回显**该行真实落库**的取值，不因本次入参而升级（R4）。
 */
async function replayValue(
  client: DatabaseClient,
  tenantId: string,
  interview: InterviewRow,
  binding: BindingRow,
  existing: ArtifactRow,
): Promise<TranscriptImportValue> {
  const segmentCount = await countSegments(client, tenantId, existing.id)
  const record = await loadRecordForArtifact(client, tenantId, existing.id, existing.source_revision)
  const artifact = artifactFromRow(existing, segmentCount)
  artifact.meeting_id = binding.meeting_id
  const warnings: WarningRow[] = [
    {
      code: 'REPLAYED_SAME_CONTENT',
      message: '同一 (meeting_id, provider_artifact_id) 已有相同 content_sha256 的产物；'
        + '本次没有新建任何行（TR-U8），返回的是已存在的那一版',
    },
  ]
  const isConnectorRow = FEISHU_CONNECTOR_ARTIFACT_PREFIXES.some(
    (prefix) => existing.provider_artifact_id.startsWith(prefix),
  )
  const existingLive = existing.provenance === 'LIVE'
  warnings.push(existingLive
    ? isConnectorRow
      ? {
        code: 'FEISHU_LIVE_MANUAL_OPERATOR_READ',
        message: '该行是飞书连接器回读的 LIVE 产物（回执绑定内容哈希 + 证据齐全，trigger=MANUAL）；'
          + '产品自有 OAuth / 事件订阅（F2）仍是 P1，未实现——LIVE 只说明字节来自平台，不代表自动摄取能力',
      }
      : {
        code: 'EXPORT_RECEIPT_IS_SELF_DECLARED',
        message: '该行的回执由人工自述（upload:<actor>:sha256:<hex>;file=<name>），不是平台 API 回读',
      }
    : isConnectorRow
      ? {
        code: 'FEISHU_READBACK_NOT_LIVE',
        message: '该行是飞书连接器回读的 FIXTURE 语料（本次回读未通过 LIVE 证据：'
          + '回执/哈希/重读/完整性缺项，标签停在 FIXTURE），不得当作"已经接通飞书"',
      }
      : {
        code: 'FIXTURE_CONTENT_NOT_LIVE',
        message: '该行是 DEMO_SAMPLE 演示文本（provenance=FIXTURE），不得当作"已经接通飞书"',
      })
  return buildValue({
    interview,
    binding,
    artifact,
    labels: {
      provenance: existing.provenance,
      trigger: existing.trigger_mode,
      connection: existing.connection_state,
    },
    // 连接器回读行的依据分两种：LIVE 行是「证据齐全」，非 LIVE 行是「证据不齐」，
    // 都不能用人工样本的理由码（那会是假话）。
    provenanceBasis: isConnectorRow
      ? (existingLive ? LIVE_READBACK_PROVENANCE_BASIS : FEISHU_READBACK_PROVENANCE_BASIS)
      : provenanceBasisFor(existing.provenance),
    replayed: true,
    record: record === undefined
      ? undefined
      : {
        id: record.id,
        status: record.status,
        verification_status: record.verification_status,
        transcript_revision: record.transcript_revision,
        evidence_ok: record.evidence_ok,
        is_current: record.is_current,
      },
    created: [],
    updated: [],
    warnings,
  })
}

/** 工具描述（模型可见）：入参、两条来源路径、错误码、标签语义、两条状态轴分开。 */
const DESCRIPTION =
  'S9 转写导入（两条来源路径，写库）：'
  + '(a) 人工上传：给 content + source_kind；'
  + '(b) 飞书连接器回读：不给 content、给 minute_token（可加 external_meeting_id 消歧），由连接器 fetchTranscript() 取正文。'
  + '入参：interview_id(UUID, 必填)、content(1..400000 字符，逐字节保存；与 token 二选一)、'
  + 'minute_token（连接器回读）、external_meeting_id（可选，按平台会议 id 消歧）、'
  + 'source_kind∈{PLATFORM_EXPORT, DEMO_SAMPLE}（人工路径必填）、exported_file_name（PLATFORM_EXPORT 必填）、'
  + 'language（默认 zh）、meeting_id（多会议消歧）、note。'
  + 'tenant_id/actor_id 不接受模型传入（出现即 INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)）。'
  + '行为：只落到该面试 active 绑定且 meeting_role∈{PRIMARY,CONTINUATION} 的会议；'
  + '同一 (meeting, provider_artifact_id) 内容 sha 相同 → 一行不写（replayed=true）；'
  + 'sha 变了 → source_revision=max+1 的新行，canonical 同事务迁移，旧行与旧 interview_record 全部保留。'
  + '连接器路径**默认 fail-closed**：本机插件配置没有 feishu.cli（lark-cli 绝对路径）时不装配传输层，'
  + '调用直接 BLOCKED/TRANSPORT_NOT_CONFIGURED，不拉子进程、不读正文、不写任何行。'
  + '错误码：INVALID_ARGS（reason_code 见 detail）/ NOT_FOUND(INTERVIEW_NOT_FOUND|MEETING_NOT_FOUND) / '
  + 'NO_MEETING_BOUND / AMBIGUOUS_MEETING / NOT_CONFIGURED / BLOCKED（reason_code=连接器 blocked_reason 或 '
  + 'TRANSPORT_NOT_CONFIGURED/PROVIDER_GENERATING/CONNECTOR_CALL_FAILED/READBACK_INVALID/TRANSCRIPT_TOO_LARGE）。'
  + '三维标签：trigger 恒 MANUAL；人工路径 connection 恒 NOT_CONNECTED；连接器回读 connection 由**本次回读证据**算：'
  + '证据齐全（平台通道 + 回执绑定内容哈希 + content_sha256 与 raw_text 重算一致 + 带偏移 fetched_at + '
  + '完整分页 + 非空正文）才 CONNECTED，否则 NOT_CONNECTED/AUTH_REQUIRED。'
  + '人工路径 provenance=FIXTURE 当且仅当 DEMO_SAMPLE（附 FIXTURE_CONTENT_NOT_LIVE）；'
  + 'provenance=LIVE 只给 PLATFORM_EXPORT + 导出文件名（附 EXPORT_RECEIPT_IS_SELF_DECLARED —— 回执是人工自述）。'
  + '连接器路径 provenance=LIVE 当且仅当证据齐全（附 FEISHU_LIVE_MANUAL_OPERATOR_READ：MANUAL 读取、产品自有 OAuth 属 P1）；'
  + '证据不齐 → FIXTURE（附 FEISHU_READBACK_NOT_LIVE，并逐条列出缺哪项证据）；'
  + '回读对象自相矛盾（哈希/回执/重读不一致）→ BLOCKED/READBACK_INVALID，一行不写。'
  + '注意：artifact.transcript_status=READY 只代表原文已完整落库，'
  + '不代表 interview_record READY（后者是 status=NEEDS_REVIEW / verification_status=UNVERIFIED，需人工复核）。'
  + '把记录推进到 READY/VERIFIED 的**唯一产品入口**是 recruitment_interview_record_verify'
  + '（人机闸门：只有人批准才会写；DC-23 要求 READY+VERIFIED 才能被决策引用）。'

/**
 * 造一个绑定配置的转写导入工具（写路径；`isConcurrencySafe=false`）。
 * @param database - 已解析的 database 配置（租户 / actor 只从这里来）。
 * @param deps - 连接器依赖（由插件配置装配；缺省 ⇒ 连接器回读路径 BLOCKED）；
 *   `identity` 由 `src/index.ts` 装配（产品路径），缺省 = 仅测试兼容的 legacy actor。
 */
export function createTranscriptImportTool(
  database: ResolvedDatabaseConfig,
  deps: TranscriptImportDeps = {},
): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as TranscriptImportValue
        const meeting = v.meeting
        const artifact = v.artifact
        const record = v.record
        // **一行**摘要（RD §3.1）：只回身份/状态/计数，不回显转写正文。
        // O1 残留：人读正文只给业务标识（第几轮 / 阶段 / 状态）与短号；完整 UUID 只进
        // 末尾的 machine arguments 区（模型要复制才能调 transcript_read / verify）。
        const summary = [
          `${v.tool} ${v.contract_version} status=${v.status} write=${String(v.write)} replayed=${String(v.replayed)}`,
          `interview 第 ${String(v.interview.round_no)} 轮 stage=${String(v.interview.stage_code)}`
            + ` interview_status=${String(v.interview.status)}`,
          `meeting ${shortRef(String(meeting.id))} provider=${String(meeting.provider)}`
            + ` role=${String(meeting.meeting_role)} binding=${String(meeting.binding_method)}`,
          `artifact ${shortRef(String(artifact.id))} rev=${String(artifact.source_revision)}`
            + ` status=${String(artifact.transcript_status)} provenance=${v.labels.provenance}`
            + ` trigger=${v.labels.trigger} connection=${v.labels.connection}`
            + ` canonical=${String(artifact.is_canonical)} chars=${String(artifact.char_count)}`
            + ` segments=${String(artifact.segment_count)}`,
          `record=${record === undefined
            ? 'none(no rubric)'
            : `${shortRef(String(record.id))} status=${String(record.status)}`
              + ` verification=${String(record.verification_status)} rev=${String(record.transcript_revision)}`}`,
          `changes: created=${v.changes.created.length} updated=${v.changes.updated.length}`,
          ...[...v.warnings].map((warning) => `warning ${warning.code}`),
        ]
        const machineArguments = [
          { key: 'interview_id', value: String(v.interview.id) },
          { key: 'meeting_id', value: String(meeting.id) },
          { key: 'artifact_id', value: String(artifact.id) },
          ...(record === undefined ? [] : [{ key: 'interview_record_id', value: String(record.id) }]),
        ]
        // 既有契约：导入摘要是**单行**（`test/unit/transcript-import.test.ts` 断言不含换行，
        // 不放宽），所以机器参数区只能内联在行尾；header 逐字带"不要给人看"的告诫。
        const machineInline = machineArguments.length === 0
          ? []
          : [`${MACHINE_ARGS_HEADER} ${machineArguments.map((entry) => `${entry.key}=${entry.value}`).join(' ')}`]
        return [{ type: 'text', text: [...summary, ...machineInline].join(' | ') }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // 写身份先于回读/建连解析：identity 已装配时缺失映射在此 fail-closed（零写入、零外部读取）。
      const writeActor = resolveWriteActor(exec, deps.identity, database.actor_id)
      // GUC 与 created_by 列共用同一作者（Demo Actor 解析结果；legacy 分支 = 配置里的 actor）。
      const writeConfig: ResolvedDatabaseConfig = { ...database, actor_id: writeActor.actor_id }
      const args = parseContractArgs(PARAMS, rawArgs)
      // 参数级失败必须在**建连之前**抛：INVALID_ARGS 不该先占一个连接。
      validateTranscriptImportArgs(args)
      // 连接器回读也必须在**建连之前**完成：BLOCKED = 零 artifact（也不占数据库连接）。
      const source = await resolveImportSource(args, deps.connector, deps.connector_issues ?? [])
      const pool = createPool(database)
      try {
        return await withActor(pool, writeConfig.actor_id, async (client) =>
          importTranscriptInTransaction(client, writeConfig, args, undefined, { ...deps, source }))
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
export function unconfiguredTranscriptImportTool(issues: readonly string[]): ReadonlyToolDefinition {
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
      return false
    },
    async execute(): Promise<unknown> {
      fail('NOT_CONFIGURED', {
        reason_code: 'PLUGIN_NOT_CONFIGURED',
        message: '数据库配置不完整，S9 转写导入不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}
