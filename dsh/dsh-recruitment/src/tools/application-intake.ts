// recruitment_application_intake —— S6「简历接入」：本地简历文件 → 候选人 → 申请。
//
// **这是本包里唯一会写库的工具。** 写入路径与只读工具刻意分开文件，便于静态扫描
// （`test/unit/screening-readonly.test.ts` 只对 S7 源码断言"无写语句"）。
//
// 一次调用做六件事，全部在**一个** `withActor` 事务里：
//   1. 读材料：**按内容嗅探**判定媒体类型（扩展名不参与），PDF / DOCX 都交给
//      `src/tools/converter.ts` 的 `runConverter`（读取与字段抽取不重复实现，R1）；
//      图片 / RTF 等 S6 接不了的内容在**读之前**就明确拒绝，不假装能读
//      （`assertReadableFile` + `sniffFile` 与 `recruitment_document_read` 同一条路径）
//   2. 身份观察：只认 phone / email 的规范化精确相等，**姓名不参与判定**
//      （`docs/16-design-rationale.md` §8「D-46→D-52 身份规则简化到三条」）
//   3. 候选人：命中就复用，没命中才新建（`identity_status='ACTIVE'`）
//   4. 申请：**身份 = `(tenant_id, candidate_id, job_id)` 且 `lifecycle_status='ACTIVE'`**
//      —— 命中就复用（`application_action=REUSED`），没有才新建（`CREATED`）。
//      **文件 sha / 内容 sha 一律不参与"这是不是同一条申请"**（Issue #1 §2.4、0009）。
//   5. 版本：`resume_version` 不可变。新的、通过证据校验的结构化结果 ⇒ **追加**一条
//      （同 `resume_id`，`version_no=max+1`），再把 `application.resume_version_id`
//      显式指过去。同一内容+同一结构化结果 ⇒ 不写任何行（`UNCHANGED`）。
//      校验失败 ⇒ 一行不写，旧事实不动。
//   6. 落 Intake 三层（event / record / asset）+ `resume`（按 `(candidate, asset)` 唯一口径）
//   7. **钉 rubric 版本**（F1 / D-21 / D-48）：新建申请时，若岗位的
//      `job.current_rubric_version_id` 非空、该版本属于本岗位、且**此刻有生效的 APPROVED 审批**
//      （`status='APPROVED'` + hash 一致 + 未被取代 + 未过期），就把这个版本写进
//      `application.rubric_version_id`。
//      * **"当前"只由 `job.current_rubric_version_id` 说话**，不按 `max(version_no)` 推导；
//      * 没有已批准版本时**留空、不报错、不阻塞接入** —— 接简历不该要求先有 rubric
//        （后续岗位批准后，`recruitment_application_stage_advance` 的 T1 判定会补钉）；
//      * 复用已有申请（REUSED）时**不改** `rubric_version_id`：补钉是阶段推进写路径的职责，
//        本工具只在**建申请**这一刻记录当时已经批准的事实。
//
// **输出把三个状态分开表达**（这是本轮修的核心误导：旧实现把它们混成 `created`）：
//   * `application_action: CREATED | REUSED`
//   * `structure_saved: true | false`（本次是否新增了携带结构化结果的版本）
//   * `resume_version_id`（本次生效的版本）+ `resume_version_action: APPENDED | UNCHANGED`
//   `created` / `idempotent_replay` 只作**向后兼容的派生键**保留。
//
// 三条红线（违反任一条这次交付即不通过）：
//   * **读不出 ≠ 新人/重复**：phone/email 都不可自动时返回 `BLOCKED_BY_REVIEW`，
//     一条行都不写（`contracts/identity/identity-resolution-rules.md` IR-G1/G2/G3、IR-C9）。
//   * **关联 ≠ 合并**：命中已有档案只建 `application`，绝不写 `candidate_merge`
//     （IR §12-①、IR §5.4 D9）。
//   * **actor 只能来自配置**，用 `SET LOCAL`（`withActor`），不接受模型传入
//     （`tool-contracts.md` §0 第 4 条、D-18）。

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { contractError, digestOf, type ContractErrorCode } from './contract.ts'
import { parseContractArgs, toParameterSchema, type ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
// 事件名只从 `src/runtime/event-types.ts` 取（唯一权威注册表）：发射方与路由方
// 引同一份常量，`test/runtime/event-types.test.ts` 扫描本文件的发射点做机检。
import { EVENT_TYPES } from '../runtime/event-types.ts'
import {
  runConverter,
  type ConverterOutput,
  type ResolvedConverterConfig,
} from './converter.ts'
// 媒体判定复用统一读取层（U1）：`assertReadableFile` 只查**路径**安全（绝对路径 /
// 存在 / allowed_roots / 非空），`sniffFile` 只按**字节**判格式。两者都不看扩展名，
// 所以"扩展名是 .pdf 才算简历"这个硬编码不会再出现在 S6 的入口。
import { assertReadableFile } from '../document/readers/files.ts'
import { isDocumentReadError } from '../document/readers/errors.ts'
import { MEDIA_DOCX, MEDIA_PDF, MEDIA_RTF } from '../document/readers/media.ts'
import { sniffFile } from '../document/readers/sniff.ts'
import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import {
  matchByStrongIds,
  normEmail,
  normPhone,
  observeIdentity,
  strongIdentityKey,
  type CandidateHit,
  type ConverterFieldEntry,
  type IdEvidence,
  type StrongId,
  type StrongIdField,
} from '../db/identity.ts'
import {
  hardIssueCodes,
  mapParseStatus,
  projectParsedFields,
  type MaterialIssue,
} from '../db/material.ts'
// 证据校验**复用** structure 层，不在本文件重写规则（D-32）：
//   serialize() —— 把同一份 converter blocks 变成模型引用的 block_index；
//   validate()  —— 模型输出 × 索引 × 原文的机械校验（唯一判定口径）。
import {
  indexEntryById,
  serialize,
  toCodePoints,
  type BlockIndex,
  type BlockIndexEntry,
  type SourceBlock,
} from '../structure/serialize.ts'
import {
  FIELD_STATES,
  validate,
  type FieldState,
} from '../structure/validate.ts'

const TOOL_NAME = 'recruitment_application_intake'
const CONTRACT_VERSION = '1.0.0'

const PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 1024,
    description:
      'Absolute path of a local resume file (PDF or DOCX). The media type is sniffed from the file '
      + 'CONTENT, never from the extension. Must exist and must be inside the configured '
      + 'allowed_roots (fail-closed: any other path is rejected with FORBIDDEN). Images are rejected '
      + 'with reason_code=IMAGE_REQUIRES_VISION (S6 has no OCR/vision attribution step); RTF and '
      + 'other containers are rejected with READER_FAILED(reason_code=UNSUPPORTED_MEDIA).',
  },
  job_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Target job id, UUID text form (e.g. 11111111-1111-4111-8111-000000000401).',
  },
  structured_json: {
    kind: 'string',
    maxLength: 400_000,
    description:
      "Optional: the structuring agent's JSON result for the SAME material, as a JSON string (<= 400000 "
      + 'characters). When present it is validated against the block index of this material (the same '
      + 'serialize()/validate() used by recruitment_resume_serialize + recruitment_structure_validate); '
      + 'a rejected result writes nothing. When present the five business fields take their state '
      + 'from this result (converter state is preserved separately). When absent, behavior is unchanged.',
  },
}

/** 允许出现在结构化结果里的五个业务字段（`contracts/schema.json` §fields）。 */
const BUSINESS_FIELDS = ['name', 'phone', 'email', 'work_experience', 'education'] as const

/** 业务字段名。 */
type BusinessField = (typeof BUSINESS_FIELDS)[number]

/** 只靠 phone / email 做自动身份判定（姓名不参与，D-46/D-52）。 */
const IDENTITY_FIELDS = ['phone', 'email'] as const

/**
 * 身份来源闸门（D-67 / IR-G2 / IR-F4 / IR-G1 的 `AUTO_OK`）：
 * **只有 `native_text` 可以自动归并**（关联旧档或新建档都算"对'这是谁'的自动判定"）。
 * `ocr` / `ocr_title` / `model_read` / `agent_read` / `docling` / `reader_metadata` /
 * 缺失（`unknown`）一律只能进弱提示：**只提示，不参与匹配、不驱动归属**。
 */
const AUTO_MERGE_PROVENANCE = 'native_text'

/** `structured_json` 的字段是模型从原文读出来的（D-67 的 `agent_read`），永远不是 `native_text`。 */
const AGENT_READ_PROVENANCE = 'agent_read'

/** 一条弱身份提示：值读出来了，但来源不足以自动归并（D-67 / IR-F4）。 */
export interface WeakId {
  readonly field: StrongIdField
  /** 原件里的原文（只用于提示/审计，不进比较）。 */
  readonly raw: string
  /** 规范化后的比较键（`region_ambiguous` 的弱提示不会产生匹配）。 */
  readonly norm: string
  /** 该值的来源（`agent_read` / `ocr` / `ocr_title` / `unknown` ...）。 */
  readonly provenance: string
  /** 为什么不能自动（`provenance_*` / `not_identity_merge_eligible`）。 */
  readonly reason: string
  /** 块级证据坐标（page / bbox / block / quote）。 */
  readonly evidence: readonly IdEvidence[]
}

/** 来源 → 能否自动归并 + 拒绝原因（**唯一判据**，不看来源通道）。 */
function judgeProvenance(provenance: string): { readonly automatable: boolean; readonly reason: string } {
  const value = provenance === '' ? 'unknown' : provenance
  if (value === AUTO_MERGE_PROVENANCE) return { automatable: true, reason: '' }
  return { automatable: false, reason: `provenance_${value}` }
}

/** `detail.rejections` 默认展示前 N 条。 */
const MAX_REJECTIONS_SHOWN = 10

/** 一条块级证据（**不带原文**：输出里不打印手机号/邮箱）。 */
interface EvidenceRef {
  readonly field: string
  readonly page: number
  readonly bbox: readonly number[]
  readonly block: number
}

/** 入参规范输出。 */
interface IntakeValue {
  readonly tool: string
  readonly contract_version: string
  readonly status: 'OK'
  /** 兼容键：等价于 `application_action === 'CREATED'`（旧调用方/证据脚本仍在读它）。 */
  readonly created: boolean
  readonly candidate_created: boolean
  /** 兼容键：本次既没新建申请、也没新增版本（两个状态都为"无变化"）。 */
  readonly idempotent_replay: boolean
  /** 状态一：申请是新建还是复用。**不包含**"结构化有没有保存"。 */
  readonly application_action: 'CREATED' | 'REUSED'
  /** 状态二：本次是否新增了一个**携带结构化结果**的版本（首次无结构化的接入为 false）。 */
  readonly structure_saved: boolean
  /** 状态三的补充：版本是本次新增的（APPENDED）还是沿用已有的（UNCHANGED）。 */
  readonly resume_version_action: 'APPENDED' | 'UNCHANGED'
  readonly candidate_id: string
  readonly application_id: string
  readonly matched_by: string
  readonly resume_id: string
  /** 状态三：本次生效的版本（`application.resume_version_id` 指向它）。 */
  readonly resume_version_id: string
  readonly resume_version_no: number
  readonly intake_record_id: string
  readonly intake_asset_id: string
  readonly event_id: string
  readonly provenance: 'LIVE' | 'FIXTURE'
  readonly labels: {
    readonly provenance: string
    readonly trigger: string
    readonly connection: string
    readonly source_kind: string
    readonly event_provider: string
  }
  readonly source: {
    readonly file_name: string
    readonly sha256: string
    readonly pages: number
    readonly byte_size: number
    readonly completeness: string
    readonly parse_status: string
    readonly hard_issue_count: number
  }
  readonly identity: {
    readonly strong_ids: readonly string[]
    /**
     * 可自动归并的字段（**只含** `provenance=native_text`、证据齐全、非 region-ambiguous）。
     * 这是 D-67 / IR-F4 的机检面：不在这个列表里的字段绝不能驱动关联/新建。
     */
    readonly identity_merge_eligible: readonly string[]
    /** 弱提示：读出来了但来源不可自动（agent_read / ocr / 缺失…）；只提示，不参与匹配。 */
    readonly weak_fields: readonly {
      readonly field: string
      readonly provenance: string
      readonly reason: string
    }[]
    readonly blocked_fields: readonly { readonly field: string; readonly reason: string }[]
    readonly evidence: readonly EvidenceRef[]
  }
  readonly job: { readonly id: string; readonly code: string; readonly title: string; readonly status: string }
  readonly application: {
    readonly job_id: string
    readonly job_version_id: string
    readonly stage_code: string
    readonly lifecycle_status: string
    readonly record_version: number
  }
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    created: { type: 'boolean' },
    candidate_created: { type: 'boolean' },
    idempotent_replay: { type: 'boolean' },
    application_action: { type: 'string', enum: ['CREATED', 'REUSED'] },
    structure_saved: { type: 'boolean' },
    resume_version_action: { type: 'string', enum: ['APPENDED', 'UNCHANGED'] },
    candidate_id: { type: 'string' },
    application_id: { type: 'string' },
    matched_by: { type: 'string' },
    resume_id: { type: 'string' },
    resume_version_id: { type: 'string' },
    resume_version_no: { type: 'integer' },
    intake_record_id: { type: 'string' },
    intake_asset_id: { type: 'string' },
    event_id: { type: 'string' },
    provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string' },
        trigger: { type: 'string' },
        connection: { type: 'string' },
        source_kind: { type: 'string' },
        event_provider: { type: 'string' },
      },
      required: ['provenance', 'trigger', 'connection', 'source_kind', 'event_provider'],
      additionalProperties: false,
    },
    source: {
      type: 'object',
      properties: {
        file_name: { type: 'string' },
        sha256: { type: 'string' },
        pages: { type: 'integer' },
        byte_size: { type: 'integer' },
        completeness: { type: 'string' },
        parse_status: { type: 'string' },
        hard_issue_count: { type: 'integer' },
      },
      required: ['file_name', 'sha256', 'pages', 'byte_size', 'completeness', 'parse_status', 'hard_issue_count'],
      additionalProperties: false,
    },
    identity: {
      type: 'object',
      properties: {
        strong_ids: { type: 'array', items: { type: 'string' } },
        identity_merge_eligible: { type: 'array', items: { type: 'string' } },
        weak_fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              provenance: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['field', 'provenance', 'reason'],
            additionalProperties: false,
          },
        },
        blocked_fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, reason: { type: 'string' } },
            required: ['field', 'reason'],
            additionalProperties: false,
          },
        },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              page: { type: 'integer' },
              bbox: { type: 'array', items: { type: 'number' } },
              block: { type: 'integer' },
            },
            required: ['field', 'page', 'bbox', 'block'],
            additionalProperties: false,
          },
        },
      },
      required: ['strong_ids', 'blocked_fields', 'evidence'],
      additionalProperties: false,
    },
    job: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        code: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['id', 'code', 'title', 'status'],
      additionalProperties: false,
    },
    application: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        job_version_id: { type: 'string' },
        stage_code: { type: 'string' },
        lifecycle_status: { type: 'string' },
        record_version: { type: 'integer' },
      },
      required: ['job_id', 'job_version_id', 'stage_code', 'lifecycle_status', 'record_version'],
      additionalProperties: false,
    },
  },
  // 注意：`application_action` / `structure_saved` / `resume_version_action` /
  // `resume_version_no` 是**已声明但暂不进 required**：`test/unit/output-schema.test.ts`
  // 用一份硬编码的旧样本值校验 additionalProperties/required，那份样本在本 lane 的
  // 写范围之外。实现每次都会输出这四个键（集成/单测逐条断言），
  // 待 W0 把样本值补齐后再提升为 required。
  required: [
    'tool', 'contract_version', 'status', 'created', 'candidate_created', 'idempotent_replay',
    'candidate_id', 'application_id', 'matched_by', 'resume_id', 'resume_version_id',
    'intake_record_id', 'intake_asset_id', 'event_id', 'provenance', 'labels', 'source',
    'identity', 'job', 'application',
  ],
  additionalProperties: false,
}

/** 一次调用的工具级配置（两段都已解析成功）。 */
export interface IntakeToolConfig {
  readonly converter: ResolvedConverterConfig
  readonly database: ResolvedDatabaseConfig
}

/** 身份结论：要么可自动关联/新建，要么拒绝（fail-closed）。 */
type IdentityDecision =
  | { readonly kind: 'CREATE_CANDIDATE' }
  | { readonly kind: 'LINK_EXISTING'; readonly hit: CandidateHit }
  | { readonly kind: 'REVIEW'; readonly reason_code: string; readonly message: string; readonly detail: unknown }

/**
 * 纯判定：给定观察结果与命中集，得身份结论（顺序即规则，首个命中即返回）。
 *
 * **本 lane 只有三档**（见文件头）：无命中 → 新建；恰好一条 → 关联；其余 → 人工。
 * 姓名不参与，所以 IR 的 `WEAK_MATCH` / `MERGE_CONFLICT_ID_NAME` / `NAME_UNVERIFIED`
 * 三档在本实现里**不存在**（这是 D-46/D-52 的简化，不是遗漏）。
 * @param strong - 可自动的强标识（**只可能**来自 `native_text`，D-67）。
 * @param hits - 同租户命中集（已解析到存活档）。
 * @param weak - 弱身份提示（agent_read / ocr / 缺失…）：只进拒绝明细，不参与判定。
 */
export function decideIdentity(
  strong: readonly StrongId[],
  hits: readonly CandidateHit[],
  weak: readonly WeakId[] = [],
): IdentityDecision {
  const usable = strong.filter((id) => !id.region_ambiguous)
  if (usable.length === 0) {
    const ambiguous = strong.filter((id) => id.region_ambiguous)
    if (ambiguous.length > 0) {
      return {
        kind: 'REVIEW',
        reason_code: 'REGION_AMBIGUOUS_PHONE',
        message: '简历里只有无国际前缀的本地号码，规范化后无法确定国别/地区，不得据此判新人或重复',
        detail: {
          blocking_items: ambiguous.map((id) => ({
            code: 'REGION_AMBIGUOUS_PHONE',
            family: 'MATERIAL',
            field: id.field,
            reason: 'region_ambiguous',
          })),
        },
      }
    }
    return {
      kind: 'REVIEW',
      reason_code: 'MATERIAL_ATTRIBUTION_UNKNOWN',
      message: weak.length > 0
        ? '简历里的 phone / email 读出来了，但来源不是原生文本（agent_read / ocr / 缺失），按 D-67 只能人工核对；不得据此判"新人"或"重复"'
        : '简历里的 phone / email 都没有读出可用值，无法判定这份材料属于谁；不得据此判"新人"或"重复"',
      detail: {
        blocking_items: strong.length === 0
          ? [{ code: 'MATERIAL_ATTRIBUTION_UNKNOWN', family: 'MATERIAL', field: 'phone,email' }]
          : [],
        ...(weak.length === 0 ? {} : {
          weak_fields: weak.map((id) => ({
            field: id.field,
            provenance: id.provenance,
            reason: id.reason,
          })),
        }),
      },
    }
  }
  const distinctCandidates = [...new Set(hits.map((hit) => hit.candidate_id))]
  if (distinctCandidates.length === 0) return { kind: 'CREATE_CANDIDATE' }
  if (distinctCandidates.length === 1) return { kind: 'LINK_EXISTING', hit: hits[0] as CandidateHit }
  // ≥2 条不同档案：交叉印证（D5）属于"合并"决策，必须由 SYSTEM/HUMAN + candidate_merge 完成，
  // 本工具**不合并**（IR-M5 / IR-F12）。
  return {
    kind: 'REVIEW',
    reason_code: 'MULTIPLE_STRONG_MATCH',
    message: '本次材料的 phone 与 email 分别命中不同档案；合并必须走人工/系统合并流程，本工具不合并',
    detail: {
      blocking_items: hits.map((hit) => ({
        code: 'MULTIPLE_STRONG_MATCH',
        family: 'HUMAN_QUEUE',
        ref_kind: 'CANDIDATE',
        ref_id: hit.candidate_id,
        field: hit.field,
      })),
    },
  }
}

/** 一次 intake 的中间上下文（纯数据，便于测试复用）。 */
export interface IntakeMaterial {
  readonly real_path: string
  readonly file_name: string
  readonly byte_size: number
  /**
   * **嗅探出来的**媒体类型（`intake_asset.mime_type` 写这个）。
   *
   * 为什么必须是嗅探值而不是扩展名：S6 现在收 PDF + DOCX + RTF 三种，写死
   * `'application/pdf'` 会让 DOCX/RTF 的材料在库里留下假标签；扩展名本身也不可信
   * （改个后缀就是"另一种格式"是假的）。
   */
  readonly mime_type: string
  readonly output: ConverterOutput
  /** 可自动归并的强标识：**只可能**是 `provenance='native_text'` 的 phone/email（D-67）。 */
  readonly strong: readonly StrongId[]
  /**
   * 弱身份提示：读出来了但来源不可自动（`agent_read` / `ocr` / 缺失…）。
   * 只能提示，**绝不**参与 `matchByStrongIds` / `decideIdentity`。
   */
  readonly weak?: readonly WeakId[]
  readonly blocked: readonly { readonly field: string; readonly reason: string }[]
  readonly sha256: string
  /**
   * 传入 `structured_json` 并**通过**证据校验后才有值。
   * 缺省 = 完全走转换器口径（向后兼容：不传时行为逐字不变）。
   */
  readonly structured?: StructuredOverlay
}

/** 一条 Agent 结构化的块级证据（带 block id 与原文；只在库内留存，输出不打印）。 */
export interface AgentEvidence {
  readonly field: BusinessField
  readonly state: FieldState
  /** 模型引用的行 id（`#12` 的 12）。 */
  readonly block_id: number
  /** 该行来自 converter 的第几个原始块（1 基）。 */
  readonly block_no: number
  readonly page: number | null
  readonly bbox: readonly number[] | null
  /** 该行原文（逐字；`unreadable` 时是模型引用的证据块，不是字段值）。 */
  readonly quote: string
}

/** 结构化结果里的一个字段（已归一，不保留原始 JSON）。 */
export interface AgentField {
  readonly state: FieldState
  /** 单值字段（name / phone / email）的逐字值；条目字段没有。 */
  readonly value?: string
  /** 条目字段的条目数（`value` 数组长度），用于 S7 的 `entry_count`。 */
  readonly entry_count?: number
  readonly reason?: string
  readonly block_ids: readonly number[]
  /** 该字段从哪来：顶层 `fields`（契约形状）或 section 内 `fields`（旧形状）。 */
  readonly origin: 'fields' | 'section'
  readonly evidence: readonly AgentEvidence[]
}

/** Agent 结构化结果的落库/判定视图（通过 validate() 之后才会存在）。 */
export interface StructuredOverlay {
  readonly prompt_version: string | null
  readonly schema_version: string | null
  readonly block_count: number | null
  readonly block_index_entries: number
  readonly issue_count: number
  readonly issue_codes: readonly string[]
  readonly fields: Readonly<Partial<Record<BusinessField, AgentField>>>
}

/**
 * 把 converter 字段里"读出来了但来源不可自动"的条目转成弱提示（D-67）。
 *
 * 只从 `observeIdentity()` 已经判掉的 `blocked` 里取两类原因：来源不是 `native_text`、
 * 或 converter 没把该字段列进 `identity_merge_eligible`（平台噪声等，IR-G6）。
 * 这两类**允许提示、禁止自动**；其余 blocked（absent/unreadable/格式/证据缺失）
 * 不是"有值但不能用"，不产生弱提示。
 * @param fields - converter 的 `fields`。
 * @param blocked - `observeIdentity()` 的 blocked 列表。
 * @returns 弱提示（不含 region-ambiguous：那类仍按既有 `REGION_AMBIGUOUS_PHONE` 处理）。
 */
function weakFromConverter(
  fields: Readonly<Record<string, ConverterFieldEntry | undefined>>,
  blocked: readonly { readonly field: string; readonly reason: string }[],
): WeakId[] {
  const out: WeakId[] = []
  for (const item of blocked) {
    if (item.field !== 'phone' && item.field !== 'email') continue
    if (!(item.reason.startsWith('provenance_') || item.reason === 'not_identity_merge_eligible')) continue
    const entry = fields[item.field]
    if (entry?.state !== 'present' || typeof entry.value !== 'string' || entry.value === '') continue
    const field: StrongIdField = item.field
    const normalized = field === 'phone' ? normPhone(entry.value) : normEmail(entry.value)
    if (normalized === null) continue
    const norm = typeof normalized === 'string' ? normalized : normalized.norm
    out.push({
      field,
      raw: entry.value,
      norm,
      provenance: typeof entry.provenance === 'string' && entry.provenance !== '' ? entry.provenance : 'unknown',
      reason: item.reason,
      evidence: identityEvidenceOf(entry),
    })
  }
  return out
}

/** converter 字段的块级证据（与 `db/identity.ts` 的 `toEvidence` 同口径：坐标齐全才留）。 */
function identityEvidenceOf(entry: ConverterFieldEntry | undefined): IdEvidence[] {
  const out: IdEvidence[] = []
  for (const item of entry?.evidence ?? []) {
    const page = typeof item.page === 'number' ? item.page : 0
    const bbox = (item.bbox ?? []).map((n) => (typeof n === 'number' ? n : Number.NaN))
    const block = typeof item.block === 'number' ? item.block : -1
    const quote = typeof item.text === 'string' ? item.text : ''
    const bboxOk = bbox.length === 4 && bbox.every((n) => Number.isFinite(n))
    if (page >= 1 && bboxOk && quote !== '') {
      out.push({ page, bbox, block, quote })
    }
  }
  return out
}

/**
 * 把 converter 结果整理成待落库的材料（纯函数，除了 `statSync` 的字节数）。
 * @param realPath - 已通过 allowed_roots 校验的真实路径。
 * @param output - converter 输出。
 * @param mimeType - 嗅探到的媒体类型；省略时按历史口径记 PDF
 *   （只有直接构造 converter 输出的单测走这条默认，真实入口 `execute()` 一定显式传）。
 */
export function buildMaterial(
  realPath: string,
  output: ConverterOutput,
  mimeType?: string,
): IntakeMaterial {
  const fields = (output.fields ?? {}) as Readonly<Record<string, ConverterFieldEntry>>
  const observation = observeIdentity(fields, output.screening?.identity_merge_eligible)
  const sha = output.meta?.source_sha256 ?? ''
  if (sha === '') {
    throw contractError('READER_FAILED', {
      reason_code: 'READER_NO_SOURCE_HASH',
      message: 'converter 没有给出 source_sha256，无法建立内容寻址的材料引用',
    })
  }
  const name = realPath.split(/[\\/]/).pop() ?? realPath
  return {
    real_path: realPath,
    file_name: name,
    byte_size: statSync(realPath).size,
    mime_type: mimeType ?? MEDIA_PDF,
    output,
    strong: observation.strong,
    weak: weakFromConverter(fields, observation.blocked),
    blocked: observation.blocked,
    sha256: sha,
  }
}

// ---------------------------------------------------------------------------
//  可选入参 structured_json：Agent 结构化的消费路径
//
//  分工（不许互换）：
//    * validate() 决定「接不接受」——本文件不重写任何校验规则（D-32）；
//    * 本文件只决定「接受了以后，哪些业务字段按模型层口径落库」（D-29）。
//
//  形状：`contracts/schema.json` 的顶层 `fields`（五个键恒在，条目在 `.value[]` 里）。
//  `collectAgentFields()` 只消费 validate() 已经校验过的字段；它自己再判一次形状，
//  只是为了防止「校验器接受了、消费侧却看不懂」时静默丢字段（那会把模型层降级回转换器）。
// ---------------------------------------------------------------------------

/** 普通对象判定（数组 / null 不算）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析一个 block 引用（与 validate.ts 同口径：正整数或数字字符串）。 */
function parseBlockIdValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return /^[1-9]\d{0,5}$/.test(trimmed) ? Number(trimmed) : null
  }
  return null
}

/** 解析 `block_ids`（数组）或旧写法 `block_id`（单值）。 */
function parseBlockIdList(rawIds: unknown, rawSingle: unknown): number[] {
  const out: number[] = []
  if (Array.isArray(rawIds)) {
    for (const item of rawIds) {
      const id = parseBlockIdValue(item)
      if (id !== null) out.push(id)
    }
    return out
  }
  if (rawIds === undefined && rawSingle !== undefined) {
    const id = parseBlockIdValue(rawSingle)
    if (id !== null) out.push(id)
  }
  return out
}

/** 结构化字段的归一草稿（证据要等索引解析后再算）。 */
interface AgentFieldDraft {
  readonly field: BusinessField
  readonly state: FieldState
  readonly value?: string
  readonly entry_count?: number
  readonly reason?: string
  readonly block_ids: readonly number[]
  readonly origin: 'fields' | 'section'
}

/** 归一一个字段；形状不对就返回原因（由调用方拒绝，不静默丢弃）。 */
function normalizeAgentField(
  field: BusinessField,
  raw: unknown,
  origin: 'fields' | 'section',
): { ok: true; draft: AgentFieldDraft } | { ok: false; message: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, message: `field ${field} must be an object` }
  }
  const stateRaw = raw.state
  if (typeof stateRaw !== 'string' || !(FIELD_STATES as readonly string[]).includes(stateRaw)) {
    return {
      ok: false,
      message: `field ${field} state must be one of ${FIELD_STATES.join(', ')}, got ${JSON.stringify(stateRaw)}`,
    }
  }
  const state = stateRaw as FieldState
  const blockIds = parseBlockIdList(raw.block_ids, raw.block_id)
  const reason = typeof raw.reason === 'string' && raw.reason.trim() !== '' ? raw.reason : undefined
  const rawValue = raw.value
  let value: string | undefined
  let entryCount: number | undefined
  if (typeof rawValue === 'string' && rawValue !== '') value = rawValue
  else if (Array.isArray(rawValue)) entryCount = rawValue.length

  const structural = field === 'work_experience' || field === 'education'
  if (state === 'present') {
    if (structural) {
      if (entryCount === undefined || entryCount === 0) {
        return { ok: false, message: `field ${field} is present but carries no non-empty entry array` }
      }
    } else if (value === undefined) {
      return { ok: false, message: `field ${field} is present but carries no value` }
    }
  } else if (value !== undefined || (entryCount !== undefined && entryCount > 0)) {
    return { ok: false, message: `field ${field} is ${state} but carries a value` }
  }

  return {
    ok: true,
    draft: {
      field,
      state,
      ...(value === undefined ? {} : { value }),
      ...(entryCount === undefined ? {} : { entry_count: entryCount }),
      ...(reason === undefined ? {} : { reason }),
      block_ids: blockIds,
      origin,
    },
  }
}

/**
 * 收集五个业务字段：旧形状（`sections[].fields`）作底，契约形状（顶层 `fields`）覆盖。
 * 条目形状（`sections[].entries`）只在没有字段声明时推断 `present`，用于当前校验器
 * 尚未接受顶层 `fields` 的过渡期。
 * @param result - 已通过 validate() 的结构化结果。
 * @returns 字段草稿 + 形状错误（形状错误会让整份结果被拒）。
 */
function collectAgentFields(result: unknown): {
  readonly drafts: readonly AgentFieldDraft[]
  readonly invalid: readonly { readonly field: BusinessField; readonly message: string }[]
} {
  const byField = new Map<BusinessField, AgentFieldDraft>()
  const invalid: { field: BusinessField; message: string }[] = []
  if (!isPlainObject(result)) return { drafts: [], invalid }

  const sections = Array.isArray(result.sections) ? result.sections : []
  for (const rawSection of sections) {
    if (!isPlainObject(rawSection)) continue
    const bag = isPlainObject(rawSection.fields) ? rawSection.fields : undefined
    if (bag === undefined) continue
    for (const field of BUSINESS_FIELDS) {
      if (!Object.hasOwn(bag, field) || byField.has(field)) continue
      const parsed = normalizeAgentField(field, bag[field], 'section')
      if (!parsed.ok) {
        invalid.push({ field, message: parsed.message })
        continue
      }
      byField.set(field, parsed.draft)
    }
  }

  // 过渡期：旧形状把 work_experience / education 放在 section.entries 里。
  for (const rawSection of sections) {
    if (!isPlainObject(rawSection)) continue
    const label = rawSection.label
    if (label !== 'work_experience' && label !== 'education') continue
    const field: BusinessField = label
    if (byField.has(field)) continue
    const entries = Array.isArray(rawSection.entries) ? rawSection.entries : []
    if (entries.length === 0) continue
    byField.set(field, {
      field,
      state: 'present',
      entry_count: entries.length,
      block_ids: parseBlockIdList(rawSection.block_ids, undefined),
      origin: 'section',
    })
  }

  // 契约形状：顶层 fields 覆盖旧形状。
  const top = isPlainObject(result.fields) ? result.fields : undefined
  if (top !== undefined) {
    for (const field of BUSINESS_FIELDS) {
      if (!Object.hasOwn(top, field)) continue
      const parsed = normalizeAgentField(field, top[field], 'fields')
      if (!parsed.ok) {
        invalid.push({ field, message: parsed.message })
        continue
      }
      byField.set(field, parsed.draft)
    }
  }

  return { drafts: [...byField.values()], invalid }
}

/** 取一个索引项对应的原文（切分片段按码点精确切片）。 */
function sourceTextAt(blocks: readonly (SourceBlock | string)[], entry: BlockIndexEntry): string {
  const block = blocks[entry.block_no - 1]
  const raw = block === undefined
    ? ''
    : typeof block === 'string'
      ? block
      : typeof block.text === 'string' ? block.text : ''
  if (entry.piece_count > 1) {
    const codePoints = toCodePoints(raw)
    if (entry.piece_start >= 0 && entry.piece_end <= codePoints.length && entry.piece_start < entry.piece_end) {
      return codePoints.slice(entry.piece_start, entry.piece_end).join('')
    }
  }
  return raw
}

/** 把字段引用的 block id 解析成证据（含原文；原文只进库，不进工具输出）。 */
function buildAgentEvidence(
  draft: AgentFieldDraft,
  index: BlockIndex,
  blocks: readonly (SourceBlock | string)[],
): AgentEvidence[] {
  const out: AgentEvidence[] = []
  const seen = new Set<number>()
  for (const id of draft.block_ids) {
    if (seen.has(id)) continue
    const entry = indexEntryById(index, id)
    if (entry === undefined) continue
    seen.add(id)
    out.push({
      field: draft.field,
      state: draft.state,
      block_id: entry.id,
      block_no: entry.block_no,
      page: entry.page,
      bbox: entry.bbox,
      quote: sourceTextAt(blocks, entry),
    })
  }
  return out
}

/** 证据坐标是否齐全（与 S7 `evidenceFor` 的口径一致：page>=1 + 4 个有限数）。 */
function hasCoordinates(item: AgentEvidence): boolean {
  return item.page !== null
    && item.page >= 1
    && item.bbox !== null
    && item.bbox.length === 4
    && item.bbox.every((value) => typeof value === 'number' && Number.isFinite(value))
}

/** 落进 `parsed_fields.fields[field].evidence` 的 converter 同形证据（S7 只认这种）。 */
function toFieldEvidence(item: AgentEvidence, sourceSha: string): Record<string, unknown> {
  return {
    page: item.page,
    bbox: item.bbox,
    block: item.block_no,
    text: item.quote,
    block_id: item.block_id,
    source: 'agent_structured',
    source_asset_sha256: sourceSha,
  }
}

/** 落进 `parsed_fields.fields[field].agent_evidence` 的可读回证据（block id + 原文）。 */
function toEvidenceRecord(item: AgentEvidence): Record<string, unknown> {
  return {
    source: 'agent_structured',
    block_id: item.block_id,
    block_no: item.block_no,
    page: item.page,
    bbox: item.bbox,
    quote: item.quote,
  }
}

/**
 * 把结构化结果里的 phone / email 变成身份**提示**（D-29：模型层口径）。
 *
 * 关键：`structured_json` 的字段是模型读出来的 —— `provenance` 只能是 `agent_read`。
 * 按 D-67 / IR-G2 / IR-F4，这类来源**不得**进入 `strong`（自动归并），只能进 `weak`
 * （`reason='provenance_agent_read'`，提示人工核对）。姓名不参与（D-46/D-52）；
 * `unreadable` 与 `absent` 各自保留，绝不合并成一个状态。
 * @param fields - `validate()` 通过后按业务字段归一的模型结果。
 * @returns `strong` 恒为空（agent 字段没有 `native_text` 来源）；`weak` 是可提示的字段。
 */
function observeAgentIdentity(
  fields: Readonly<Partial<Record<BusinessField, AgentField>>>,
): {
  readonly strong: readonly StrongId[]
  readonly weak: readonly WeakId[]
  readonly blocked: readonly { readonly field: string; readonly reason: string }[]
} {
  const strong: StrongId[] = []
  const weak: WeakId[] = []
  const blocked: { field: string; reason: string }[] = []
  for (const field of IDENTITY_FIELDS) {
    const agent = fields[field]
    if (agent === undefined) {
      blocked.push({ field, reason: 'field_missing_from_structured_result' })
      continue
    }
    if (agent.state !== 'present') {
      blocked.push({ field, reason: `field_state_${agent.state}` })
      continue
    }
    if (agent.value === undefined) {
      blocked.push({ field, reason: 'value_missing' })
      continue
    }
    const evidence = agent.evidence
      .filter((item) => item.quote !== '')
      .map((item) => ({
        page: item.page ?? 0,
        bbox: [...(item.bbox ?? [])],
        block: item.block_no,
        quote: item.quote,
      }))
    if (evidence.length === 0) {
      blocked.push({ field, reason: 'evidence_missing' })
      continue
    }
    const provenance = AGENT_READ_PROVENANCE
    const gate = judgeProvenance(provenance)
    if (field === 'phone') {
      const normalized = normPhone(agent.value)
      if (normalized === null) {
        blocked.push({ field, reason: 'format_not_normalizable' })
        continue
      }
      if (!gate.automatable) {
        weak.push({
          field,
          raw: agent.value,
          norm: normalized.norm,
          provenance,
          reason: gate.reason,
          evidence,
        })
        continue
      }
      // 不可达（`agent_read` 永远不是 native_text）：保留分支结构，防止将来新增
      // 别的来源时把 D-67 的闸门漏掉；真正的判据只有 judgeProvenance()。
      strong.push({
        field,
        raw: agent.value,
        norm: normalized.norm,
        region_ambiguous: normalized.region_ambiguous,
        provenance,
        evidence,
      })
      continue
    }
    const normalized = normEmail(agent.value)
    if (normalized === null) {
      blocked.push({ field, reason: 'format_not_normalizable' })
      continue
    }
    if (!gate.automatable) {
      weak.push({ field, raw: agent.value, norm: normalized, provenance, reason: gate.reason, evidence })
      continue
    }
    strong.push({ field, raw: agent.value, norm: normalized, region_ambiguous: false, provenance, evidence })
  }
  return { strong, weak, blocked }
}

/** `structured_json` 不是合法 JSON → INVALID_ARGS（D-51/D-63 的错误格式）。 */
function parseStructuredJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw contractError('INVALID_ARGS', {
      reason_code: 'STRUCTURED_JSON_INVALID',
      message: 'structured_json 不是合法 JSON',
      detail: { error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' },
    })
  }
}

/** 复制的摘要（避免 detail 里塞进整份结构化结果）。 */
interface ShownRejection {
  readonly code: string
  readonly message: string
  readonly path: string
  readonly block_id?: number
}

/** 拒绝：不降级接受、不写库。 */
function structuredRejected(
  jobId: string | undefined,
  rejectedBy: 'validate' | 'field_shape',
  rejections: readonly ShownRejection[],
  issueCodes: readonly string[],
): RecruitmentToolError {
  const shown = rejections.slice(0, MAX_REJECTIONS_SHOWN)
  return contractError('BLOCKED_BY_REVIEW', {
    reason_code: 'STRUCTURED_REJECTED',
    message: '结构化结果未通过与同一份 PDF 的块级证据校验；拒绝写入，不做降级接受',
    detail: {
      ...(jobId === undefined ? {} : { job_id: jobId }),
      rejected_by: rejectedBy,
      rejection_count: rejections.length,
      shown: shown.length,
      rejections: shown,
      issue_codes: [...issueCodes],
    },
  })
}

/**
 * 消费 Agent 的结构化结果：解析 → 对同一份 PDF 的 block_index 做证据校验 → 通过才合并。
 *
 * **不改变 converter 事实**：`completeness` / `issues` / `parse_status` 仍由转换器决定；
 * 这里只决定五个业务字段的 `state`（D-29：以模型层为准，同时保留 `converter_state`）。
 * @param material - `buildMaterial()` 的结果（必须是同一份 PDF 的 converter 输出）。
 * @param rawJson - `structured_json` 原文字符串。
 * @param jobId - 目标岗位 id（只用于错误明细定位）。
 * @returns 合并后的新材料（`structured` 非空，`strong` / `blocked` 按模型层重算）。
 * @throws RecruitmentToolError - `INVALID_ARGS(STRUCTURED_JSON_INVALID)` 或 `BLOCKED_BY_REVIEW(STRUCTURED_REJECTED)`。
 */
export function applyStructuredJson(
  material: IntakeMaterial,
  rawJson: string,
  jobId?: string,
): IntakeMaterial {
  const parsed = parseStructuredJson(rawJson)
  const blocks = (material.output.blocks ?? []) as readonly (SourceBlock | string)[]
  const serialized = serialize({
    blocks: blocks as readonly SourceBlock[],
    meta: { source_sha256: material.output.meta?.source_sha256 },
  })
  const result = validate({
    result: parsed,
    blockIndex: serialized.blockIndex,
    blocks,
  })
  const collected = collectAgentFields(parsed)

  if (!result.accepted) {
    throw structuredRejected(
      jobId,
      'validate',
      result.rejected.map((item) => (
        item.block_id === undefined
          ? { code: item.code, message: item.message, path: item.path }
          : { code: item.code, message: item.message, path: item.path, block_id: item.block_id }
      )),
      result.issues.map((item) => item.code),
    )
  }
  if (collected.invalid.length > 0) {
    // validate() 已接受，但消费侧读不懂某个字段：宁可拒绝，也不静默退回转换器口径
    // （那等于把模型层的结论降级，违反 D-29 的"state 以模型层为准"）。
    throw structuredRejected(
      jobId,
      'field_shape',
      collected.invalid.map((item) => ({
        code: 'SCHEMA_INVALID',
        message: item.message,
        path: `fields.${item.field}`,
      })),
      result.issues.map((item) => item.code),
    )
  }

  const fields: Partial<Record<BusinessField, AgentField>> = {}
  for (const draft of collected.drafts) {
    fields[draft.field] = {
      state: draft.state,
      ...(draft.value === undefined ? {} : { value: draft.value }),
      ...(draft.entry_count === undefined ? {} : { entry_count: draft.entry_count }),
      ...(draft.reason === undefined ? {} : { reason: draft.reason }),
      block_ids: [...draft.block_ids],
      origin: draft.origin,
      evidence: buildAgentEvidence(draft, serialized.blockIndex, blocks),
    }
  }
  const observation = observeAgentIdentity(fields)
  // D-67 / IR-F4：**来源闸门只看 provenance**。agent 字段是 `agent_read` ⇒ 只进 weak。
  // 转换器里已有的原生强标识（`native_text`）不因"本次带了 structured_json"而被清掉，
  // 但如果模型把某个字段判成非 present（D-29 以模型层为准），该字段的旧强标识必须失效。
  const strong = material.strong.filter((id) => {
    const agent = fields[id.field]
    return agent === undefined || agent.state === 'present'
  })
  // 同一字段已经有 native 强标识时，来源闸门已经过了：agent 对它的读出只影响字段 state，
  // 不构成"来源不可自动"的弱提示（否则输出会同时出现 strong 与 weak，自相矛盾）。
  const strongFields = new Set(strong.map((id) => id.field))
  const weak = [
    ...(material.weak ?? []),
    ...observation.weak.filter((id) => !strongFields.has(id.field)),
  ]
  const doc = isPlainObject(parsed) ? parsed : {}
  const overlay: StructuredOverlay = {
    prompt_version: typeof doc.prompt_version === 'string' ? doc.prompt_version : null,
    schema_version: typeof doc.schema_version === 'string' ? doc.schema_version : null,
    block_count: typeof doc.block_count === 'number' && Number.isInteger(doc.block_count) ? doc.block_count : null,
    block_index_entries: serialized.blockIndex.entries.length,
    issue_count: result.issues.length,
    issue_codes: [...new Set(result.issues.map((item) => item.code))],
    fields,
  }
  return {
    ...material,
    strong,
    weak,
    blocked: [...material.blocked, ...observation.blocked],
    structured: overlay,
  }
}

/**
 * 业务字段的**有效视图**：有结构化覆盖时用模型层口径，否则逐字等于 converter 的 `fields`。
 * @param material - intake 材料。
 * @returns 五个业务字段（未被覆盖的字段保持 converter 原样）。
 */
export function effectiveFields(material: IntakeMaterial): Record<string, ConverterFieldEntry> {
  const converterFields = (material.output.fields ?? {}) as Record<string, ConverterFieldEntry>
  const overlay = material.structured
  if (overlay === undefined) return converterFields
  const out: Record<string, unknown> = { ...converterFields }
  for (const field of BUSINESS_FIELDS) {
    const agent = overlay.fields[field]
    if (agent === undefined) continue
    const converterEntry = converterFields[field]
    const entry: Record<string, unknown> = {
      state: agent.state,
      state_source: 'agent_structured',
      provenance: 'agent_read',
      block_ids: [...agent.block_ids],
    }
    // D-29：模型层决定 state，但转换器的结论必须**同时保留**，否则看不出两者是否一致。
    if (typeof converterEntry?.state === 'string' && converterEntry.state !== '') {
      entry.converter_state = converterEntry.state
    }
    if (typeof converterEntry?.provenance === 'string' && converterEntry.provenance !== '') {
      entry.converter_provenance = converterEntry.provenance
    }
    if (typeof converterEntry?.value === 'string' && converterEntry.value !== '') {
      entry.converter_value = converterEntry.value
    }
    if (agent.state === 'present') {
      if (agent.value !== undefined) entry.value = agent.value
      if (agent.entry_count !== undefined) entry.entry_count = agent.entry_count
      // S7 的 `evidenceFor` 只认 page>=1 + 4 个有限数；缺坐标时证据会降级为 unreadable，
      // 所以这里只放能过 S7 证据闸门的条目，缺坐标的仍留在 agent_evidence 里可回查。
      entry.evidence = agent.evidence
        .filter((item) => hasCoordinates(item))
        .map((item) => toFieldEvidence(item, material.sha256))
      if (Array.isArray(entry.evidence) && entry.evidence.length === 0 && agent.evidence.length > 0) {
        entry.evidence_unlocatable = true
      }
    } else if (agent.reason !== undefined) {
      entry.reason = agent.reason
    }
    if (agent.evidence.length > 0) {
      entry.agent_evidence = agent.evidence.map((item) => toEvidenceRecord(item))
    }
    out[field] = entry
  }
  return out as Record<string, ConverterFieldEntry>
}

/** `parsed_fields.structured`：来源标记 + 校验结论 + 每个字段引用了哪些 block。 */
function structuredMetadata(overlay: StructuredOverlay): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const field of BUSINESS_FIELDS) {
    const agent = overlay.fields[field]
    if (agent === undefined) continue
    fields[field] = {
      state: agent.state,
      block_ids: [...agent.block_ids],
      origin: agent.origin,
      ...(agent.reason === undefined ? {} : { reason: agent.reason }),
    }
  }
  return {
    source: 'agent_structured',
    tool: TOOL_NAME,
    validated: true,
    block_index_entries: overlay.block_index_entries,
    issue_count: overlay.issue_count,
    issue_codes: [...overlay.issue_codes],
    ...(overlay.prompt_version === null ? {} : { prompt_version: overlay.prompt_version }),
    ...(overlay.schema_version === null ? {} : { schema_version: overlay.schema_version }),
    ...(overlay.block_count === null ? {} : { block_count: overlay.block_count }),
    fields,
  }
}

// ---------------------------------------------------------------------------
//  版本决定（Application 身份 + `resume_version` 不可变）
//
//  口径（Issue #1 §1.2/§1.3，W0 裁决，本文件不许另发明）：
//    * Application 身份 = `(tenant_id, candidate_id, job_id)` 且 `lifecycle_status='ACTIVE'`；
//      文件 sha / 内容 sha 不参与判定。
//    * `resume_version` 只 append。同一内容 + 同一结构化结果 ⇒ 不写行（UNCHANGED）；
//      新的、通过校验的结构化结果 ⇒ 新版本（同 `resume_id`，`version_no = max+1`）。
// ---------------------------------------------------------------------------

/** `parsed_fields.version_digest` 的算法标识（换算法就换这个字符串）。 */
const VERSION_DIGEST_SCHEMA = 'intake-resume-version/1'

/** 库里已有的一版（只取判定用的键）。 */
export interface ExistingVersion {
  readonly id: string
  readonly version_no: number
  /** `parsed_fields.version_digest`；旧行没有这一键 ⇒ `null`（永远不匹配）。 */
  readonly digest: string | null
  /** 该版本是否携带已通过校验的结构化结果（旧行按 `parsed_fields.structured` 判定）。 */
  readonly has_structure: boolean
}

/** 三个状态里"版本"这一维的决定。 */
export type VersionDecision =
  | { readonly action: 'APPEND' }
  | { readonly action: 'UNCHANGED'; readonly matched_version_id: string | null }

/**
 * 纯判定：这次的提交要不要新增一条 `resume_version`。
 *
 * 顺序即规则：
 *   1. 已有**完全相同** digest 的版本 → `UNCHANGED`（幂等，指向那一版）；
 *   2. 这条材料链上还没有任何版本 → `APPEND`（首次接入，必须先有事实）；
 *   3. 本次带结构化结果（已通过证据校验）→ `APPEND`（新派生版本）；
 *   4. 本次**没有**结构化结果，但已有版本携带结构化结果 → `UNCHANGED`：
 *      绝不用一条更贫瘠的版本把 `application.resume_version_id` 往回指
 *      （replay 不是 discard；旧事实不许被覆盖）；
 *   5. 其余（同材料的重新解析，且还没有任何结构化事实）→ `APPEND`，可追踪。
 * @param input.digest - `submissionDigest(material)`。
 * @param input.hasStructured - 本次是否带了通过校验的 `structured_json`。
 * @param input.existing - 该 `resume` 上已有的版本（按 `version_no` 升序）。
 */
export function decideVersionAction(input: {
  readonly digest: string
  readonly hasStructured: boolean
  readonly existing: readonly ExistingVersion[]
}): VersionDecision {
  const match = input.existing.find((row) => row.digest !== null && row.digest === input.digest)
  if (match !== undefined) return { action: 'UNCHANGED', matched_version_id: match.id }
  if (input.existing.length === 0) return { action: 'APPEND' }
  if (input.hasStructured) return { action: 'APPEND' }
  if (input.existing.some((row) => row.has_structure)) {
    return { action: 'UNCHANGED', matched_version_id: null }
  }
  return { action: 'APPEND' }
}

/**
 * 一次提交的内容指纹：**只用来判断"这一版是不是同一版"**，不参与申请身份判定。
 *
 * 覆盖三部分：原件字节 sha、提取正文 sha、以及（若有的）已校验结构化结果的归一化投影。
 * 用 `digestOf`（`canonicalJson`：键排序）⇒ 同一份结构化结果换了键顺序/空白，
 * 指纹不变；任何一个业务字段的 state / value / entry_count / block_ids 变了，指纹就变。
 * @param material - `buildMaterial()` / `applyStructuredJson()` 的结果。
 */
export function submissionDigest(material: IntakeMaterial): string {
  const overlay = material.structured
  const structured = overlay === undefined
    ? null
    : {
        prompt_version: overlay.prompt_version,
        schema_version: overlay.schema_version,
        block_count: overlay.block_count,
        issue_codes: [...overlay.issue_codes].sort(),
        fields: BUSINESS_FIELDS.flatMap((field) => {
          const agent = overlay.fields[field]
          if (agent === undefined) return []
          return [{
            field,
            state: agent.state,
            value: agent.value ?? null,
            entry_count: agent.entry_count ?? null,
            reason: agent.reason ?? null,
            block_ids: [...agent.block_ids],
          }]
        }),
      }
  const parse = mapParseStatus(material.output.completeness, material.output.chars, material.output.issues)
  return digestOf({
    schema: VERSION_DIGEST_SCHEMA,
    source_asset_sha256: material.sha256,
    content_sha256: sha256OfText(material.output.text ?? ''),
    parse_status: parse.status,
    completeness: material.output.completeness ?? 'unknown',
    hard_issue_codes: hardIssueCodes(material.output.issues as readonly MaterialIssue[] | undefined),
    structured,
  })
}

/** 落进 `parsed_fields` 的版本元数据（`resume_version` 行本身不可改，所以只能写在 JSON 里）。 */
function versionMetadata(digest: string, hasStructure: boolean): Record<string, unknown> {
  return {
    version_digest: digest,
    version_meta: {
      digest_schema: VERSION_DIGEST_SCHEMA,
      has_structure: hasStructure,
      submitted_by: TOOL_NAME,
    },
  }
}

interface JobRow {
  readonly id: string
  readonly tenant_id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly current_job_version_id: string | null
  /**
   * D-21 的显式"当前 rubric"指针。**这是"当前版本"的唯一权威**（D-48：指针为空 = 没有当前，
   * 不回退推导）。S7/S10 的决策都以申请钉住的版本为准，所以这里必须把它读出来。
   */
  readonly current_rubric_version_id: string | null
}

/**
 * 解析"这一刻可以直接钉到新申请上的 rubric 版本"（F1 / D-21 / D-48）。
 *
 * 判据全部在 SQL 里，逐条对应 `job-rubric-rules.md` §4.2 的 `approved(v, as_of)`：
 *   1. 指针非空（D-48：指针为空 = 没有当前版本，**不回退**到 max(version_no)）；
 *   2. 被指的版本仍在、属于本岗位本租户（`0005` 的复合外键也是这条，这里提前判以免写侧才炸）；
 *   3. 该版本此刻有生效的 APPROVED 审批：`status='APPROVED'`、`canonical_payload_hash`
 *      与版本 `payload_hash` 一致、未被取代、未过期。
 *
 * **不读** `rubric_version.approved_by_approval_id`：那是可空指针，不保证指向 APPROVED
 * 也不保证 hash 一致（`job-rubric-rules.md` §4.2 第 3 条）。
 *
 * 返回 `null` 不是错误：这表示"现在没有什么可以钉的"，接简历照常成功（只留空）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param jobId - 目标岗位。
 * @param currentRubricVersionId - `job.current_rubric_version_id`。
 * @returns 可钉的版本 id；没有则 `null`。
 */
async function resolvePinnableRubricVersion(
  client: DatabaseClient,
  tenantId: string,
  jobId: string,
  currentRubricVersionId: string | null,
): Promise<string | null> {
  if (currentRubricVersionId === null) return null
  const { rows } = await client.query<{ id: string }>(
    `select rv.id
       from recruitment.rubric_version rv
      where rv.tenant_id = $1 and rv.job_id = $2 and rv.id = $3
        and exists (
          select 1 from recruitment.approval a
           where a.tenant_id = rv.tenant_id
             and a.resource_type = 'RUBRIC_VERSION'
             and a.resource_id = rv.id
             and a.status = 'APPROVED'
             and a.canonical_payload_hash = rv.payload_hash
             and a.superseded_by_approval_id is null
             and (a.expires_at is null or a.expires_at > now())
        )`,
    [tenantId, jobId, currentRubricVersionId],
  )
  return rows[0]?.id ?? null
}

/**
 * 在一个**已开启并已设置 actor** 的事务里完成一次 intake。
 *
 * 顺序是契约的一部分（`Issue #1 §1.2/§1.3`）：
 *   actor 校验 → 身份锁 → 身份结论 → 岗位 → 候选人 → 申请周期锁 → 版本决定 → 申请（复用/新建）。
 *
 * 三处**不许**用文件 sha / 内容 sha：身份匹配、申请复用、版本复用。
 * sha 只在两种地方用：① `intake_asset`/`resume_version` 的原件溯源列；
 * ② `submissionDigest()` 判断"这一版是不是同一版"。
 *
 * 单独导出是为了让集成测试把它放进"必回滚事务"里跑（幂等、身份匹配都要真库）。
 * @param client - 事务内客户端。
 * @param cfg - 已解析配置（租户与 actor 从这里来）。
 * @param material - `buildMaterial()`（可再经 `applyStructuredJson()`）的结果。
 * @param jobId - 目标岗位 id。
 * @returns 规范输出值。
 */
export async function intakeInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  material: IntakeMaterial,
  jobId: string,
): Promise<IntakeValue> {
  const tenantId = cfg.tenant_id

  // 0) 配置里的 actor 必须真的存在且属于该租户：否则"责任人"是一个不存在的 uuid。
  const actor = await client.query<{ kind: string }>(
    'select kind from recruitment.actor where id = $1 and tenant_id = $2',
    [cfg.actor_id, tenantId],
  )
  if (actor.rows.length === 0) {
    throw contractError('FORBIDDEN', {
      reason_code: 'ACTOR_NOT_IN_TENANT',
      message: '配置里的 database.actor_id 在该租户下不存在；写库会留下无法追溯的责任人',
      detail: { actor_id: cfg.actor_id, tenant_id: tenantId },
    })
  }

  // 1) 岗位必须在判定身份之前确认：目标岗位不合法是**参数**问题，
  //    不该被"材料读不出"盖住（`intake.test.ts`「岗位不存在 → NOT_FOUND」）。
  //    `job_version_id` 也在这里一次性确认，避免写了一半才报错。
  const job = await loadJob(client, tenantId, jobId)
  if (job.current_job_version_id === null) {
    throw contractError('NOT_FOUND', {
      reason_code: 'JOB_VERSION_NOT_FOUND',
      message: '该岗位还没有 job_version（application.job_version_id 是 NOT NULL）',
      detail: { job_id: jobId },
    })
  }

  // 1b) F1：新建申请时要钉的 rubric 版本 —— 只看 `job.current_rubric_version_id`（D-21），
  //     并要求它此刻已批准。没有就是 `null`：留空、不报错、不阻塞接入。
  const pinnableRubricVersionId = await resolvePinnableRubricVersion(
    client,
    tenantId,
    job.id,
    job.current_rubric_version_id,
  )

  // 2) 串行化"同一个自然人"的并发接入：key 来自**强标识集合**，不是文件 sha。
  //    否则同一个人的两份不同材料会各自"没查到"并各建一个候选人。
  const identityKey = strongIdentityKey(material.strong)
  if (identityKey !== null) await lockTransactionKey(client, `intake:identity:${tenantId}:${identityKey}`)

  // 3) 身份结论。命中不到就新建，命中一条就复用，其余一律拒绝（一条行都不写）。
  //    判定只吃 `material.strong`（D-67：只有 native_text 能自动）；`weak` 只进拒绝明细。
  const hits = await matchByStrongIds(client, tenantId, material.strong)
  const decision = decideIdentity(material.strong, hits, material.weak ?? [])
  if (decision.kind === 'REVIEW') {
    throw contractError('BLOCKED_BY_REVIEW', {
      reason_code: decision.reason_code,
      message: decision.message,
      detail: { job_id: jobId, ...(decision.detail as Record<string, unknown>) },
    })
  }

  // 4) 候选人：命中就复用，没命中才新建。
  let candidateId: string
  let candidateCreated: boolean
  if (decision.kind === 'LINK_EXISTING') {
    candidateId = decision.hit.candidate_id
    candidateCreated = false
  } else {
    candidateId = await insertCandidate(client, tenantId, material)
    candidateCreated = true
  }

  // 5) 串行化同一个 (candidate, job) 的申请周期：**这是 Application 身份的唯一来源**。
  //    库里若已有 0009 的部分唯一索引，这里的 insert 还会有第二条兜底（23505 → 回读复用）。
  await lockTransactionKey(client, `intake:application:${tenantId}:${candidateId}:${jobId}`)

  const activeApp = await findActiveApplication(client, tenantId, candidateId, jobId)
  const chain = await findMaterialChain(client, tenantId, candidateId, material.sha256)
  const existing = chain === null ? [] : await loadVersions(client, tenantId, chain.resume_id)

  const digest = submissionDigest(material)
  const hasStructured = material.structured !== undefined
  const versionDecision = decideVersionAction({ digest, hasStructured, existing })

  const parse = mapParseStatus(material.output.completeness, material.output.chars, material.output.issues)

  // 6) 版本：只能 append；已存在的版本行永远不动（库里 `trg_resume_version_immutable` 兜底）。
  let resumeVersionId: string
  let resumeVersionNo: number
  let materialIds: MaterialChainRow
  let structureSaved = false

  if (versionDecision.action === 'APPEND') {
    let resumeId: string
    if (chain !== null) {
      // 同一 (candidate, 原件) 已经有材料链：复用 event/record/asset/resume，不重复记录到达。
      materialIds = chain
      resumeId = chain.resume_id
    } else {
      const eventId = await upsertIntakeEvent(client, tenantId, material)
      const intakeRecordId = await insertIntakeRecord(client, tenantId, eventId, material)
      const intakeAssetId = await insertIntakeAsset(client, tenantId, intakeRecordId, material)
      resumeId = await insertResume(client, tenantId, candidateId, intakeAssetId)
      materialIds = { resume_id: resumeId, intake_asset_id: intakeAssetId, intake_record_id: intakeRecordId, event_id: eventId }
    }
    resumeVersionNo = (existing.length === 0 ? 0 : (existing[existing.length - 1] as ExistingVersion).version_no) + 1
    // D-29：有 `structured` 覆盖时五个业务字段以模型层为准；否则逐字等于转换器投影。
    const fields = effectiveFields(material)
    const projection = projectParsedFields(material.output) as unknown as Record<string, unknown>
    projection.fields = fields
    if (material.structured !== undefined) {
      projection.structured = structuredMetadata(material.structured)
    }
    Object.assign(projection, versionMetadata(digest, hasStructured))
    resumeVersionId = await insertResumeVersion(client, tenantId, {
      resumeId,
      versionNo: resumeVersionNo,
      material,
      parseStatus: parse.status,
      parseError: parse.parse_error,
      parsedFields: projection,
    })
    structureSaved = hasStructured
  } else {
    // 不写任何行：沿用那一版（本次提交与它逐字等价，或它比本次提交更有信息）。
    const effectiveId = versionDecision.matched_version_id
      ?? activeApp?.resume_version_id
      ?? (existing.length === 0 ? null : (existing[existing.length - 1] as ExistingVersion).id)
    if (effectiveId === null) {
      // 不可达：UNCHANGED 只在"该材料链上已有版本"时返回。
      throw new RecruitmentToolError('READER_FAILED', 'intake: UNCHANGED without any existing resume_version')
    }
    const source = await loadVersionChain(client, tenantId, effectiveId)
    resumeVersionId = source.resume_version_id
    resumeVersionNo = source.version_no
    materialIds = {
      resume_id: source.resume_id,
      intake_asset_id: source.intake_asset_id,
      intake_record_id: source.intake_record_id,
      event_id: source.event_id,
    }
  }

  // 7) 申请：复用同 (candidate, job, ACTIVE) 的那条，或新建一条（阶段 S6 = Intake）。
  //    新建时把上面解析到的、岗位当前已批准的 rubric 版本一并钉上（F1）。
  const application = await ensureActiveApplication(client, {
    tenantId,
    candidateId,
    jobId,
    jobVersionId: job.current_job_version_id,
    resumeVersionId,
    rubricVersionId: pinnableRubricVersionId,
  })

  return assemble({
    cfg,
    material,
    job,
    applicationAction: application.action,
    candidateCreated,
    structureSaved,
    resumeVersionAction: versionDecision.action === 'APPEND' ? 'APPENDED' : 'UNCHANGED',
    resumeVersionNo,
    candidateId,
    applicationId: application.id,
    matchedBy: decision.kind === 'LINK_EXISTING'
      ? [...new Set(hits.map((hit) => hit.field))].sort().join('+')
      : 'created',
    resumeId: materialIds.resume_id,
    resumeVersionId,
    intakeRecordId: materialIds.intake_record_id,
    intakeAssetId: materialIds.intake_asset_id,
    eventId: materialIds.event_id,
    stageCode: application.stage_code,
    lifecycleStatus: application.lifecycle_status,
    recordVersion: application.record_version,
    jobVersionId: application.job_version_id,
  })
}

// ---------------------------------------------------------------------------
//  申请周期（Application 身份）—— 与文件 sha / 内容 sha 无关
// ---------------------------------------------------------------------------

/** 库里那条 ACTIVE 申请（判定 + 输出都要用到的列）。 */
export interface ActiveApplicationRow {
  readonly id: string
  readonly record_version: number
  readonly stage_code: string
  readonly lifecycle_status: string
  readonly job_version_id: string
  readonly resume_version_id: string | null
}

/** `ensureActiveApplication` 的结果：行 + 这次是新建还是复用。 */
export interface ActiveApplicationResult extends ActiveApplicationRow {
  readonly action: 'CREATED' | 'REUSED'
}

/** 事务级咨询锁：同一 key 串行，不同 key 不互相阻塞。 */
async function lockTransactionKey(client: DatabaseClient, key: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
}

/** 唯一约束冲突？（0009 的 `uq_application_active_cycle` 上线后，并发插入会走到这里） */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

/**
 * 找同 (candidate, job) 的 ACTIVE 申请。**这是 Application 身份的唯一判据**。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param candidateId - 已解析的存活档候选人。
 * @param jobId - 岗位。
 * @returns 命中行；没有则为 `null`（→ 允许新建一条 ACTIVE）。
 */
export async function findActiveApplication(
  client: DatabaseClient,
  tenantId: string,
  candidateId: string,
  jobId: string,
): Promise<ActiveApplicationRow | null> {
  const { rows } = await client.query<ActiveApplicationRow>(
    `select id, record_version, current_stage_code as stage_code, lifecycle_status,
            job_version_id, resume_version_id
       from recruitment.application
      where tenant_id = $1 and candidate_id = $2 and job_id = $3 and lifecycle_status = 'ACTIVE'
      order by created_at
      limit 1`,
    [tenantId, candidateId, jobId],
  )
  return rows[0] ?? null
}

/**
 * 复用或新建这条 ACTIVE 申请，并把它的 `resume_version_id` 显式指向本次生效的版本。
 *
 * 三种可能：
 *   1. 已有 ACTIVE → 复用（`REUSED`）；指针不同才 UPDATE（`resume_version` 侧永远只读）；
 *   2. 没有 → INSERT（`CREATED`）；
 *   3. INSERT 撞唯一约束（并发/0009 索引）→ 回读那一条当复用（`REUSED`）。
 *
 * 更新指针会经过 `fn_row_guard`（两个 status 守卫各加一次 `record_version`），
 * 所以**必须**用 `RETURNING` 取回新值，不能自己 +1。
 *
 * `rubricVersionId` 只在**新建**时写入（F1）：复用路径不动 `rubric_version_id` ——
 * 补钉是 `recruitment_application_stage_advance` 的写路径职责，本工具不替它做。
 * @param client - 事务内客户端。
 * @param input - 租户 / 候选人 / 岗位 / 岗位版本 / 本轮生效的版本 /（可空）要钉的 rubric 版本。
 * @returns 申请行 + 动作。
 */
export async function ensureActiveApplication(
  client: DatabaseClient,
  input: {
    readonly tenantId: string
    readonly candidateId: string
    readonly jobId: string
    readonly jobVersionId: string
    readonly resumeVersionId: string
    /**
     * 岗位当前已批准的 rubric 版本；`null` / 省略 = 现在没有可钉的（留空，不阻塞接入）。
     * 只有**新建**申请时用得上（复用路径不动这个指针）。
     */
    readonly rubricVersionId?: string | null
  },
): Promise<ActiveApplicationResult> {
  const existing = await findActiveApplication(client, input.tenantId, input.candidateId, input.jobId)
  if (existing !== null) {
    return { ...(await pointApplicationAtVersion(client, existing, input.resumeVersionId)), action: 'REUSED' }
  }
  try {
    const { rows } = await client.query<{
      id: string
      record_version: number
      stage_code: string
      lifecycle_status: string
      job_version_id: string
      resume_version_id: string | null
    }>(
      `insert into recruitment.application
         (tenant_id, candidate_id, job_id, job_version_id, resume_version_id, rubric_version_id,
          lifecycle_status, current_stage_code)
       values ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'S6')
       returning id, record_version, current_stage_code as stage_code, lifecycle_status,
                 job_version_id, resume_version_id`,
      [
        input.tenantId,
        input.candidateId,
        input.jobId,
        input.jobVersionId,
        input.resumeVersionId,
        input.rubricVersionId ?? null,
      ],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new RecruitmentToolError('READER_FAILED', 'application insert returned no row')
    }
    return { ...row, action: 'CREATED' }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await findActiveApplication(client, input.tenantId, input.candidateId, input.jobId)
    if (raced === null) throw error
    return { ...(await pointApplicationAtVersion(client, raced, input.resumeVersionId)), action: 'REUSED' }
  }
}

/** 把申请的 `resume_version_id` 指到新版本（值相同则一条 UPDATE 都不发）。 */
async function pointApplicationAtVersion(
  client: DatabaseClient,
  row: ActiveApplicationRow,
  resumeVersionId: string,
): Promise<ActiveApplicationRow> {
  if (row.resume_version_id === resumeVersionId) return row
  const { rows } = await client.query<ActiveApplicationRow>(
    `update recruitment.application
        set resume_version_id = $2
      where id = $1
      returning id, record_version, current_stage_code as stage_code, lifecycle_status,
                job_version_id, resume_version_id`,
    [row.id, resumeVersionId],
  )
  const updated = rows[0]
  if (updated === undefined) {
    throw new RecruitmentToolError('READER_FAILED', 'application update returned no row')
  }
  return updated
}

// ---------------------------------------------------------------------------
//  材料链 + 版本（`resume` 的口径：一份原件一条 resume，版本挂在它下面）
// ---------------------------------------------------------------------------

/** 一条材料链：resume → asset → record → event。 */
interface MaterialChainRow {
  readonly resume_id: string
  readonly intake_asset_id: string
  readonly intake_record_id: string
  readonly event_id: string
}

/** 材料链 + 某一版的版本号。 */
interface VersionChainRow extends MaterialChainRow {
  readonly resume_version_id: string
  readonly version_no: number
}

/**
 * 这条 `(candidate, 原件 sha)` 已经有一条 `resume` 吗？
 *
 * 用 `intake_asset.sha256` 找原件：**只用于把"同一份原件"挂在同一条 `resume` 下**，
 * 不用于判断"这是不是同一条申请"（那是 `ensureActiveApplication` 的事）。
 */
async function findMaterialChain(
  client: DatabaseClient,
  tenantId: string,
  candidateId: string,
  sha256: string,
): Promise<MaterialChainRow | null> {
  const { rows } = await client.query<MaterialChainRow>(
    `select r.id as resume_id, r.intake_asset_id, a.intake_record_id, ir.event_id
       from recruitment.resume r
       join recruitment.intake_asset a
         on a.id = r.intake_asset_id and a.tenant_id = r.tenant_id
       join recruitment.intake_record ir
         on ir.id = a.intake_record_id and ir.tenant_id = a.tenant_id
      where r.tenant_id = $1 and r.candidate_id = $2 and a.sha256 = $3
      order by r.created_at
      limit 1`,
    [tenantId, candidateId, sha256],
  )
  return rows[0] ?? null
}

/**
 * 该 `resume` 上已有的版本（按 `version_no` 升序）。
 *
 * `has_structure`：新行读 `parsed_fields.version_meta.has_structure`；
 * 旧行（本 lane 之前落的）没有这个键，就退回"有没有 `parsed_fields.structured`"——
 * 否则一条旧的结构化版本会被当成贫瘠版本，replay 时被降级覆盖。
 */
async function loadVersions(
  client: DatabaseClient,
  tenantId: string,
  resumeId: string,
): Promise<ExistingVersion[]> {
  const { rows } = await client.query<{
    id: string
    version_no: number
    digest: string | null
    has_structure: boolean
  }>(
    `select rv.id, rv.version_no,
            rv.parsed_fields ->> 'version_digest' as digest,
            coalesce((rv.parsed_fields -> 'version_meta' ->> 'has_structure')::boolean,
                     (rv.parsed_fields ? 'structured')) as has_structure
       from recruitment.resume_version rv
      where rv.tenant_id = $1 and rv.resume_id = $2
      order by rv.version_no`,
    [tenantId, resumeId],
  )
  return rows.map((row) => ({
    id: row.id,
    version_no: row.version_no,
    digest: row.digest,
    has_structure: row.has_structure === true,
  }))
}

/** 某一版的完整链（用于 UNCHANGED 时把 event/record/asset/resume 读回来，不新写行）。 */
async function loadVersionChain(
  client: DatabaseClient,
  tenantId: string,
  resumeVersionId: string,
): Promise<VersionChainRow> {
  const { rows } = await client.query<VersionChainRow>(
    `select rv.id as resume_version_id, rv.version_no, rv.resume_id,
            r.intake_asset_id, a.intake_record_id, ir.event_id
       from recruitment.resume_version rv
       join recruitment.resume r
         on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
       join recruitment.intake_asset a
         on a.id = r.intake_asset_id and a.tenant_id = r.tenant_id
       join recruitment.intake_record ir
         on ir.id = a.intake_record_id and ir.tenant_id = a.tenant_id
      where rv.tenant_id = $1 and rv.id = $2`,
    [tenantId, resumeVersionId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new RecruitmentToolError('READER_FAILED', 'resume_version chain disappeared during intake')
  }
  return row
}

async function loadJob(client: DatabaseClient, tenantId: string, jobId: string): Promise<JobRow> {
  const { rows } = await client.query<JobRow>(
    `select id, tenant_id, code, title, status, current_job_version_id, current_rubric_version_id
       from recruitment.job where id = $1 and tenant_id = $2`,
    [jobId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'JOB_NOT_FOUND',
      message: '该租户下没有这个岗位',
      detail: { job_id: jobId, tenant_id: tenantId },
    })
  }
  return row
}

/** 内部事件：材料到达。同一材料在同一租户只记一条（`uq_event_inbox_idempotency`）。 */
async function upsertIntakeEvent(
  client: DatabaseClient,
  tenantId: string,
  material: IntakeMaterial,
): Promise<string> {
  const idempotencyKey = `resume.intake:${material.sha256}`
  const inserted = await client.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, event_type, schema_version, occurred_at, received_at, recorded_at,
        idempotency_key, idempotency_source, source_object_id, payload, trust_level,
        normalized_event_type, normalizer_version)
     values ($1, 'internal', $5, 1, now(), now(), now(),
             $2, 'FALLBACK_KEY', $3, $4::jsonb, 'INTERNAL', $5, 'intake/1.0.0')
     on conflict (tenant_id, idempotency_key) do nothing
     returning event_id`,
    [
      tenantId,
      idempotencyKey,
      material.sha256,
      JSON.stringify({
        sha256: material.sha256,
        file_name: material.file_name,
        pages: material.output.meta?.pages ?? 0,
        source_kind: 'LOCAL_FILE',
      }),
      EVENT_TYPES.RESUME_INTAKE_RECEIVED,
    ],
  )
  const fresh = inserted.rows[0]
  if (fresh !== undefined) return fresh.event_id
  const found = await client.query<{ event_id: string }>(
    'select event_id from recruitment.event_inbox where tenant_id = $1 and idempotency_key = $2',
    [tenantId, idempotencyKey],
  )
  const row = found.rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'event_inbox row vanished during intake')
  return row.event_id
}

async function insertIntakeRecord(
  client: DatabaseClient,
  tenantId: string,
  eventId: string,
  material: IntakeMaterial,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.intake_record
       (tenant_id, event_id, sender_ref, subject, status)
     values ($1, $2, $3, $4, 'RESOLVED')
     returning id`,
    [tenantId, eventId, 'local-file', `简历接入：${material.file_name}`.slice(0, 500)],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'intake_record insert returned no row')
  return row.id
}

async function insertIntakeAsset(
  client: DatabaseClient,
  tenantId: string,
  intakeRecordId: string,
  material: IntakeMaterial,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.intake_asset
       (tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref, validation_status)
     values ($1, $2, $3, $4, $5, $6, $7, 'VALID')
     returning id`,
    [
      tenantId,
      intakeRecordId,
      material.file_name,
      // 媒体类型来自**嗅探**（PDF / DOCX），不写死 application/pdf。
      material.mime_type,
      material.byte_size,
      material.sha256,
      // 不把本机绝对路径写进库：材料是内容寻址的，原件不复制、不搬动（R7 最小化留存）。
      `content-addressed:sha256:${material.sha256}`,
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'intake_asset insert returned no row')
  return row.id
}

/**
 * 新建候选人。
 *
 * `display_name` 只是**展示标签**，从 converter 的 name 字段取；取不到就落一个
 * 内容寻址的占位名。姓名**不参与**任何身份判定（D-46/D-52），所以占位名不会
 * 影响"这份材料是谁"的结论。
 */
async function insertCandidate(
  client: DatabaseClient,
  tenantId: string,
  material: IntakeMaterial,
): Promise<string> {
  const nameEntry = effectiveFields(material).name
  const name = typeof nameEntry?.value === 'string' && nameEntry.value.trim() !== ''
    ? nameEntry.value.trim().slice(0, 200)
    : `待确认候选人-${material.sha256.slice(0, 8)}`
  const phone = material.strong.find((id) => id.field === 'phone' && !id.region_ambiguous)
  const email = material.strong.find((id) => id.field === 'email')
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.candidate
       (tenant_id, display_name, normalized_email, normalized_phone, identity_status)
     values ($1, $2, $3, $4, 'ACTIVE')
     returning id`,
    [tenantId, name, email?.norm ?? null, phone?.norm ?? null],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'candidate insert returned no row')
  return row.id
}

async function insertResume(
  client: DatabaseClient,
  tenantId: string,
  candidateId: string,
  intakeAssetId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.resume (tenant_id, candidate_id, intake_asset_id)
     values ($1, $2, $3)
     returning id`,
    [tenantId, candidateId, intakeAssetId],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'resume insert returned no row')
  return row.id
}

/**
 * 追加一条 `resume_version`（**只 insert、永不 update**：库里 `trg_resume_version_immutable`
 * 会拒绝任何 UPDATE）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param input - `versionNo` 由调用方按 `max(version_no)+1` 算好（同一 `resume_id` 内唯一）。
 * @returns 新版本行 id。
 */
async function insertResumeVersion(
  client: DatabaseClient,
  tenantId: string,
  input: {
    readonly resumeId: string
    readonly versionNo: number
    readonly material: IntakeMaterial
    readonly parseStatus: string
    readonly parseError: string | undefined
    readonly parsedFields: Record<string, unknown>
  },
): Promise<string> {
  const pages = input.material.output.meta?.pages
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.resume_version
       (tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
        parser_name, parser_version, parse_status, parse_error, parsed_fields, evidence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
     returning id`,
    [
      tenantId,
      input.resumeId,
      input.versionNo,
      input.material.sha256,
      sha256OfText(input.material.output.text ?? ''),
      backendName(input.material.output.meta?.backend),
      readerVersion(input.material.output.meta?.reader_version),
      input.parseStatus,
      // ck_resume_version_error：FAILED 必须有非空 parse_error；其余状态留空。
      input.parseStatus === 'FAILED' ? (input.parseError ?? 'pdf_no_text') : null,
      JSON.stringify(input.parsedFields),
      JSON.stringify(evidenceArray(input.material.output, pages ?? 0, input.material.structured)),
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'resume_version insert returned no row')
  return row.id
}

/** `parser_name` 只要 backend 的名字部分（`pymupdf/1.28.0` → `pymupdf`）。 */
function backendName(backend: string | undefined): string {
  if (typeof backend !== 'string' || backend === '') return 'pymupdf'
  const head = backend.split('/')[0]
  return head === '' ? 'pymupdf' : head
}

function readerVersion(version: string | undefined): string {
  return typeof version === 'string' && version !== '' ? version : 'unknown'
}

/**
 * 落 `resume_version.evidence`：converter 给出的字段级坐标（**不含原文以外的推断**）。
 * `quote` 保留原文片段（S7 的 `reason.quote` 只能来自原文），但 S6 的输出不打印它。
 *
 * 传入 `structured` 时追加 Agent 的块级证据：每条带 `source: 'agent_structured'` +
 * `block_id`（模型引用的 `#id`）+ `block_no`（converter 原始块）+ 原文，可据此读回
 * “这个值来自 Agent 结构化，引用了哪些 block”。
 */
function evidenceArray(
  output: ConverterOutput,
  pages: number,
  structured?: StructuredOverlay,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const sha = output.meta?.source_sha256 ?? ''
  for (const [field, entry] of Object.entries(output.fields ?? {})) {
    for (const item of entry?.evidence ?? []) {
      out.push({
        field,
        page: typeof item.page === 'number' ? item.page : 0,
        bbox: (item.bbox ?? []).map((n) => (typeof n === 'number' ? n : 0)),
        block: typeof item.block === 'number' ? item.block : -1,
        quote: typeof item.text === 'string' ? item.text : '',
        source_asset_sha256: sha,
        page_count: pages,
      })
    }
  }
  if (structured !== undefined) {
    for (const field of BUSINESS_FIELDS) {
      const agent = structured.fields[field]
      if (agent === undefined) continue
      for (const item of agent.evidence) {
        out.push({
          field,
          state: item.state,
          source: 'agent_structured',
          block_id: item.block_id,
          block_no: item.block_no,
          page: item.page ?? 0,
          bbox: item.bbox === null ? [] : [...item.bbox],
          quote: item.quote,
          source_asset_sha256: sha,
          page_count: pages,
        })
      }
    }
  }
  return out
}

/** 内容哈希：用于 `resume_version.content_sha256`（正文文本的 sha256）。 */
function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 组装规范输出（唯一出口，保证 schema 与 null-free 约束只实现一次）。 */
function assemble(input: {
  readonly cfg: ResolvedDatabaseConfig
  readonly material: IntakeMaterial
  readonly job: JobRow
  readonly applicationAction: 'CREATED' | 'REUSED'
  readonly candidateCreated: boolean
  readonly structureSaved: boolean
  readonly resumeVersionAction: 'APPENDED' | 'UNCHANGED'
  readonly resumeVersionNo: number
  readonly candidateId: string
  readonly applicationId: string
  readonly matchedBy: string
  readonly resumeId: string
  readonly resumeVersionId: string
  readonly intakeRecordId: string
  readonly intakeAssetId: string
  readonly eventId: string
  readonly stageCode: string
  readonly lifecycleStatus: string
  readonly recordVersion: number
  readonly jobVersionId: string
}): IntakeValue {
  const hard = hardIssueCodes(input.material.output.issues as readonly MaterialIssue[] | undefined)
  const parse = mapParseStatus(
    input.material.output.completeness,
    input.material.output.chars,
    input.material.output.issues,
  )
  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    // 兼容键：只由 application_action 派生，不再代表"结构化有没有落库"。
    created: input.applicationAction === 'CREATED',
    candidate_created: input.candidateCreated,
    idempotent_replay: input.applicationAction === 'REUSED' && input.resumeVersionAction === 'UNCHANGED',
    // 三个状态：分开表达，谁也不能替谁回答（Issue #1 §1.3）。
    application_action: input.applicationAction,
    structure_saved: input.structureSaved,
    resume_version_action: input.resumeVersionAction,
    candidate_id: input.candidateId,
    application_id: input.applicationId,
    matched_by: input.matchedBy,
    resume_id: input.resumeId,
    resume_version_id: input.resumeVersionId,
    resume_version_no: input.resumeVersionNo,
    intake_record_id: input.intakeRecordId,
    intake_asset_id: input.intakeAssetId,
    event_id: input.eventId,
    // R4：材料来自本机文件、事件由本系统内部产生（provider='internal'）⇒ FIXTURE。
    // 不因"读的是真文件"就贴 LIVE：LIVE 的定义是"能从外部 provider 的真实链路追到"
    // （`tool-contracts.md` §1.4），本工具没有外部链路。
    provenance: 'FIXTURE',
    labels: {
      provenance: 'FIXTURE',
      trigger: 'MANUAL',
      connection: 'CONNECTED',
      source_kind: 'LOCAL_FILE',
      event_provider: 'internal',
    },
    source: {
      file_name: input.material.file_name,
      sha256: input.material.sha256,
      pages: typeof input.material.output.meta?.pages === 'number' ? input.material.output.meta.pages : 0,
      byte_size: input.material.byte_size,
      completeness: input.material.output.completeness ?? 'unverified',
      parse_status: parse.status,
      hard_issue_count: hard.length,
    },
    identity: {
      strong_ids: [...new Set(input.material.strong.map((id) => id.field))].sort(),
      // D-67 / IR-F4 的机检面：只有 native_text 且未被 region-ambiguous 挡住的字段才可自动归并。
      identity_merge_eligible: [...new Set(input.material.strong
        .filter((id) => !id.region_ambiguous)
        .map((id) => id.field))].sort(),
      weak_fields: [...new Map((input.material.weak ?? []).map((id) => [
        `${id.field}|${id.provenance}|${id.reason}`,
        { field: id.field, provenance: id.provenance, reason: id.reason },
      ])).values()],
      blocked_fields: input.material.blocked.map((b) => ({ field: b.field, reason: b.reason })),
      evidence: input.material.strong.flatMap((id) =>
        id.evidence.map((e) => ({ field: id.field, page: e.page, bbox: e.bbox, block: e.block })),
      ),
    },
    job: {
      id: input.job.id,
      code: input.job.code,
      title: input.job.title,
      status: input.job.status,
    },
    application: {
      job_id: input.job.id,
      job_version_id: input.jobVersionId,
      stage_code: input.stageCode,
      lifecycle_status: input.lifecycleStatus,
      record_version: input.recordVersion,
    },
  }
}

/** 一份通过入口校验的材料来源。 */
export interface IntakeSource {
  /** 已 realpath 的绝对路径（子进程只拿这个）。 */
  readonly real_path: string
  /** **嗅探出来的**媒体类型（不是扩展名声明的那个）。 */
  readonly media_type: string
}

/**
 * 入口判定：路径安全 + 内容嗅探 + S6 能否接这种媒体。
 *
 * 规则只有一条：**按内容判，不按扩展名**。`sniffFile()` 已经把 PDF / DOCX / RTF /
 * PNG / JPEG 分出来了，本函数只决定 S6 接不接：
 *   * `pdf` / `docx` / `rtf` → 接（三者都走同一个 converter，字段抽取与 provenance 口径一致：
 *     PDF/DOCX 由 MuPDF 读，RTF 由 converter 的 striprtf reader 读，块都是 `native_text`）；
 *   * `png` / `jpeg`  → **明确拒绝**：S6 没有 OCR/视觉归属步骤，收下一张图就等于
 *     拿"读不出的文字"去猜"这是谁"；
 *   * 其它字节（旧 OLE Office / xlsx / pptx / 未知）→ 由 `sniffFile()` 抛
 *     `UNSUPPORTED_MEDIA`，消息里带真实字节数、前 8 字节 hex 与声明扩展名。
 *
 * @param requested - 模型传入的路径（未校验）。
 * @param cfg - converter 配置（allowed_roots 是唯一的可读边界）。
 * @returns 可交给 converter 的真实路径 + 嗅探到的媒体类型。
 */
export async function resolveIntakeSource(
  requested: string,
  cfg: ResolvedConverterConfig,
): Promise<IntakeSource> {
  const file = assertReadableFile(requested, cfg)
  const sniff = await sniffFile(file.real_path)
  switch (sniff.format) {
    case 'pdf':
      // 媒体类型用契约常量而不是 `sniff.media`：S6 落库的 `mime_type` 要与
      // `src/document/contracts` 的 `MEDIA_TYPES` 逐字一致，避免两处各写一个字符串。
      return { real_path: file.real_path, media_type: MEDIA_PDF }
    case 'docx':
      return { real_path: file.real_path, media_type: MEDIA_DOCX }
    case 'rtf':
      // RTF 是文本容器：converter 的 striprtf reader 抽出的 block/字段 provenance 是
      // `native_text`（不是 OCR），所以 S6 的身份闸门口径与其他原生格式完全一致。
      return { real_path: file.real_path, media_type: MEDIA_RTF }
    case 'png':
    case 'jpeg':
      throw contractError('READER_FAILED', {
        reason_code: 'IMAGE_REQUIRES_VISION',
        message: '这份材料是图片，S6 不能从图片判定身份：本工具没有 OCR / 视觉归属步骤，'
          + '任何从图片里读出来的 phone/email 都只能是 weak（不得自动归并）。'
          + '先用能产出 native_text 的原件（PDF / DOCX），或走 vision_read 由人工确认。',
        detail: { sniffed_media: sniff.media, byte_size: sniff.bytes },
      })
    default: {
      // 类型上不可达：sniff 只返回上面四种。运行时兜底，防止将来新增格式却忘了这里的判定。
      const unreachable: never = sniff.format
      throw contractError('READER_FAILED', {
        reason_code: 'UNSUPPORTED_MEDIA',
        message: `S6 不接这种媒体：${String(unreachable)}`,
        detail: { sniffed_media: sniff.media },
      })
    }
  }
}

/**
 * 读取层的失败 → 契约错误（消息里不出现手机号/邮箱/正文）。
 *
 * 分三类，对应三种"为什么读不了"（`docs/11 §11.3` 失败可归因）：
 *   * **路径**（不存在 / 越界 / 不是普通文件）：NOT_FOUND / FORBIDDEN / INVALID_ARGS；
 *   * **媒体**（RTF、旧 .doc、图片、未知字节）：READER_FAILED + 原 `DocumentReadError`
 *     的 code 作 `reason_code`（`UNSUPPORTED_MEDIA` / `IMAGE_REQUIRES_VISION`），
 *     不冒充"文件损坏"；
 *   * **converter 子进程**失败（PDF/DOCX 解不开、超时）：READER_FAILED(CONVERTER_FAILED)。
 */
function toIntakeReadError(error: unknown): never {
  // 已经是契约错误（例如 `resolveIntakeSource()` 对图片的明确拒绝）：
  // 逐字抛出，**不要**再包一层 —— 否则 `IMAGE_REQUIRES_VISION` 会被改写成
  // `CONVERTER_FAILED`，把一个"格式我们不收"说成"子进程读崩了"。
  if (error instanceof RecruitmentToolError) throw error
  if (isDocumentReadError(error)) {
    const code: ContractErrorCode = error.code === 'FORBIDDEN'
      ? 'FORBIDDEN'
      : error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : 'INVALID_ARGS'
    if (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND' || error.code === 'INVALID_ARGS') {
      throw contractError(code, {
        reason_code: error.code === 'FORBIDDEN'
          ? 'PATH_OUTSIDE_ALLOWED_ROOTS'
          : error.code === 'NOT_FOUND'
            ? 'FILE_NOT_FOUND'
            : 'PATH_INVALID',
        message: error.message,
      })
    }
    if (error.code === 'EMPTY_FILE') {
      throw contractError('INVALID_ARGS', { reason_code: 'EMPTY_FILE', message: error.message })
    }
    throw contractError('READER_FAILED', {
      reason_code: error.code,
      message: error.message,
      detail: { reader_code: error.code },
    })
  }
  // 只剩 converter 子进程这一条：execFile 失败（非 DocumentReadError）。
  throw contractError('READER_FAILED', {
    reason_code: 'CONVERTER_FAILED',
    message: 'converter 子进程读取失败（文件损坏/加密/超时）',
    detail: { error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' },
  })
}

/**
 * 造一个绑定配置的 intake 工具。
 * @param cfg - 已解析的 converter + database 配置。
 */
export function createApplicationIntakeTool(cfg: IntakeToolConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S6 resume intake. Reads one local resume file (PDF, DOCX or RTF; the media type is sniffed from the '
      + 'CONTENT, so the extension never decides whether a file is accepted), resolves the candidate '
      + 'by exact normalized '
      + 'phone/email only (names are never used for identity), and reports THREE independent states: '
      + '(1) application_action=CREATED|REUSED — the application identity is (candidate, job) while '
      + 'lifecycle_status=ACTIVE, never the file hash, so a new material for the same candidate+job '
      + 'reuses that application; (2) structure_saved=true|false — whether this call appended a new '
      + 'resume_version carrying a validated structured result (resume_version rows are immutable); '
      + '(3) resume_version_id / resume_version_no / resume_version_action=APPENDED|UNCHANGED — the '
      + 'version now in effect, which application.resume_version_id points at. A byte-identical '
      + 'replay returns REUSED/UNCHANGED and writes nothing. '
      + 'If phone and email are both unreadable it refuses with BLOCKED_BY_REVIEW and writes nothing. '
      + 'Only a native_text phone/email from the reader may auto-merge; OCR / agent-read values stay '
      + 'weak (BLOCKED_BY_REVIEW), which is unaffected by the accepted-file-format list. '
      + 'It never merges candidates. Writes only through SET LOCAL recruitment.actor_id. '
      + 'Optionally accepts structured_json (the structuring agent result for the SAME material): it is '
      + 'validated against this material block index, rejected results write nothing (old facts untouched), '
      + 'and accepted results set the five business fields state while preserving converter_state. '
      + 'RUBRIC PIN: when the target job\'s current_rubric_version_id points at a version that is APPROVED '
      + 'at call time, a NEW application is created with application.rubric_version_id pinned to exactly that '
      + 'version (D-21/D-48: current is the explicit pointer, never max(version_no)). When the job has no '
      + 'approved current rubric the field stays EMPTY and intake still succeeds — receiving a resume must not '
      + 'require a rubric first; recruitment_application_stage_advance pins it later once the rubric is approved. '
      + 'Only the create path pins: an existing (REUSED) application is never re-pinned here.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as IntakeValue
        const lines = [
          `application: ${v.application_action} ${v.application_id}`,
          `structure: saved=${v.structure_saved} (resume_version v${v.resume_version_no} `
            + `${v.resume_version_id}, ${v.resume_version_action})`,
          `candidate: ${v.candidate_id} (${v.candidate_created ? 'new' : 'existing'}, matched_by=${v.matched_by})`,
          `job ${v.job.code} [${v.job.status}] stage=${v.application.stage_code} lifecycle=${v.application.lifecycle_status}`,
          `source: ${v.source.file_name} pages=${v.source.pages} bytes=${v.source.byte_size}`,
          `sha256=${v.source.sha256}`,
          `parse_status=${v.source.parse_status} completeness=${v.source.completeness} hard_issues=${v.source.hard_issue_count}`,
          `identity strong_ids=[${v.identity.strong_ids.join(', ')}] `
            + `merge_eligible=[${v.identity.identity_merge_eligible.join(', ')}] `
            + `weak=[${v.identity.weak_fields.map((w) => `${w.field}:${w.provenance}`).join(', ')}] `
            + `evidence=${v.identity.evidence.length} blocked=[${v.identity.blocked_fields.map((b) => `${b.field}:${b.reason}`).join(', ')}]`,
          `labels: provenance=${v.labels.provenance} trigger=${v.labels.trigger} connection=${v.labels.connection}`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const args = parseContractArgs(PARAMS, rawArgs)
      const requested = args.path as string
      if (isAbsolute(requested) === false) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'PATH_INVALID',
          message: 'path 必须是绝对路径',
          detail: { path: requested },
        })
      }
      let source: IntakeSource
      try {
        source = await resolveIntakeSource(requested, cfg.converter)
      } catch (error) {
        toIntakeReadError(error)
      }
      let output: ConverterOutput
      try {
        output = await runConverter(cfg.converter, source.real_path)
      } catch (error) {
        throw contractError('READER_FAILED', {
          reason_code: 'CONVERTER_FAILED',
          message: 'converter 子进程读取失败（文件损坏/加密/超时）',
          detail: { error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' },
        })
      }
      let material = buildMaterial(source.real_path, output, source.media_type)
      // 可选：消费 Agent 的结构化结果。**必须在开事务之前**完成校验，
      // 这样被拒的结构化结果一行都不写（与身份拒绝同一口径）。
      if (args.structured_json !== undefined) {
        material = applyStructuredJson(material, args.structured_json as string, args.job_id as string)
      }
      const pool = createPool(cfg.database)
      try {
        return await withActor(pool, cfg.database.actor_id, async (client) =>
          intakeInTransaction(client, cfg.database, material, args.job_id as string))
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 配置不完整时用的替身：注册同一个工具名，调用即 `NOT_CONFIGURED`。
 * 与 `src/index.ts` 里 `unconfiguredResumeReadTool` 同一做法：让模型看见"为什么不能用"，
 * 而不是看不见工具或看到假数据。
 * @param issues - 缺哪些配置。
 */
export function unconfiguredApplicationIntakeTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S6 resume intake. Currently NOT CONFIGURED: the plugin config is missing converter or database '
      + 'settings (or the database password environment variable). Calls return NOT_CONFIGURED.',
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
        message: '数据库或 converter 配置不完整，S6 接入不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}
