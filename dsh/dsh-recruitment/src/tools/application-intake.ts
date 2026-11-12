// recruitment_application_intake —— S6「简历接入」：本地 PDF → 候选人 → 申请。
//
// **这是本包里唯一会写库的工具。** 写入路径与只读工具刻意分开文件，便于静态扫描
// （`test/unit/screening-readonly.test.ts` 只对 S7 源码断言"无写语句"）。
//
// 一次调用做六件事，全部在**一个** `withActor` 事务里：
//   1. 读 PDF（复用 `src/tools/converter.ts` 的 `runConverter`，不重复实现）
//   2. 身份观察：只认 phone / email 的规范化精确相等，**姓名不参与判定**
//      （`docs/16-design-rationale.md` §8「D-46→D-52 身份规则简化到三条」）
//   3. 幂等：同一 `(sha256, job_id)` 已经有 application 就原样返回，`created=false`
//   4. 落 Intake 三层 + `resume` + `resume_version`（`parsed_fields` 白名单投影）
//   5. 找到就复用候选人，找不到才新建（`identity_status='ACTIVE'`）
//   6. 建 `application`，阶段 `S6`（`stage_catalog` 口径；阶段推进到 S7 是人工/写侧动作）
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

import { contractError, type ContractErrorCode } from './contract.ts'
import { parseContractArgs, toParameterSchema, type ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  assertReadablePdf,
  ConverterPathError,
  runConverter,
  type ConverterOutput,
  type ResolvedConverterConfig,
} from './converter.ts'
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
  type CandidateHit,
  type ConverterFieldEntry,
  type StrongId,
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
      'Absolute path of a local resume PDF. Must exist and must be inside the configured '
      + 'allowed_roots (fail-closed: any other path is rejected with FORBIDDEN).',
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
      "Optional: the structuring agent's JSON result for the SAME PDF, as a JSON string (<= 400000 "
      + 'characters). When present it is validated against the block index of this PDF (the same '
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
  readonly created: boolean
  readonly candidate_created: boolean
  readonly idempotent_replay: boolean
  readonly candidate_id: string
  readonly application_id: string
  readonly matched_by: string
  readonly resume_id: string
  readonly resume_version_id: string
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
    candidate_id: { type: 'string' },
    application_id: { type: 'string' },
    matched_by: { type: 'string' },
    resume_id: { type: 'string' },
    resume_version_id: { type: 'string' },
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
 * @param strong - 可自动的强标识。
 * @param hits - 同租户命中集（已解析到存活档）。
 */
export function decideIdentity(strong: readonly StrongId[], hits: readonly CandidateHit[]): IdentityDecision {
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
      message: '简历里的 phone / email 都没有读出可用值，无法判定这份材料属于谁；不得据此判"新人"或"重复"',
      detail: {
        blocking_items: strong.length === 0
          ? [{ code: 'MATERIAL_ATTRIBUTION_UNKNOWN', family: 'MATERIAL', field: 'phone,email' }]
          : [],
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
  readonly output: ConverterOutput
  readonly strong: readonly StrongId[]
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
 * 把 converter 结果整理成待落库的材料（纯函数，除了 `statSync` 的字节数）。
 * @param realPath - 已通过 allowed_roots 校验的真实路径。
 * @param output - converter 输出。
 */
export function buildMaterial(realPath: string, output: ConverterOutput): IntakeMaterial {
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
    output,
    strong: observation.strong,
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
 * 把结构化结果里的 phone / email 变成可自动匹配的强标识（D-29：模型层口径）。
 * 姓名不参与（D-46/D-52）；`unreadable` 与 `absent` 各自保留，绝不合并成一个状态。
 */
function observeAgentIdentity(
  fields: Readonly<Partial<Record<BusinessField, AgentField>>>,
): { readonly strong: readonly StrongId[]; readonly blocked: readonly { readonly field: string; readonly reason: string }[] } {
  const strong: StrongId[] = []
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
    if (field === 'phone') {
      const normalized = normPhone(agent.value)
      if (normalized === null) {
        blocked.push({ field, reason: 'format_not_normalizable' })
        continue
      }
      strong.push({
        field,
        raw: agent.value,
        norm: normalized.norm,
        region_ambiguous: normalized.region_ambiguous,
        provenance: 'agent_read',
        evidence,
      })
      continue
    }
    const normalized = normEmail(agent.value)
    if (normalized === null) {
      blocked.push({ field, reason: 'format_not_normalizable' })
      continue
    }
    strong.push({ field, raw: agent.value, norm: normalized, region_ambiguous: false, provenance: 'agent_read', evidence })
  }
  return { strong, blocked }
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
    strong: observation.strong,
    blocked: observation.blocked,
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

interface JobRow {
  readonly id: string
  readonly tenant_id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly current_job_version_id: string | null
}

/**
 * 在一个**已开启并已设置 actor** 的事务里完成一次 intake。
 *
 * 单独导出是为了让集成测试把它放进"必回滚事务"里跑（幂等、身份匹配都要真库）。
 * @param client - 事务内客户端。
 * @param cfg - 已解析配置（租户与 actor 从这里来）。
 * @param material - `buildMaterial()` 的结果。
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

  // 1) 串行化同一 (材料, 岗位) 的并发调用，避免两个事务都"没查到"然后各插一条。
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `intake:${tenantId}:${material.sha256}:${jobId}`,
  ])

  // 2) 幂等：同一 (sha256, job_id) 已有申请 → 原样返回，created=false。
  const replay = await client.query<{
    application_id: string
    candidate_id: string
    resume_version_id: string
    resume_id: string
    intake_record_id: string
    intake_asset_id: string
    event_id: string
    stage_code: string
    lifecycle_status: string
    record_version: number
    job_version_id: string
  }>(
    `select a.id as application_id, a.candidate_id, a.resume_version_id,
            a.current_stage_code as stage_code, a.lifecycle_status, a.record_version,
            a.job_version_id,
            rv.id as resume_version_id, rv.resume_id,
            ia.id as intake_asset_id, ir.id as intake_record_id, ir.event_id
       from recruitment.application a
       join recruitment.resume_version rv
         on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
       join recruitment.resume r on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
       join recruitment.intake_asset ia on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
       join recruitment.intake_record ir on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
       join recruitment.candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
      where a.tenant_id = $1 and a.job_id = $2 and rv.source_asset_sha256 = $3
      order by a.created_at
      limit 1`,
    [tenantId, jobId, material.sha256],
  )
  const existing = replay.rows[0]
  const job = await loadJob(client, tenantId, jobId)
  if (existing !== undefined) {
    return assemble({
      cfg,
      material,
      job,
      created: false,
      candidateCreated: false,
      idempotentReplay: true,
      candidateId: existing.candidate_id,
      applicationId: existing.application_id,
      matchedBy: 'existing',
      resumeId: existing.resume_id,
      resumeVersionId: existing.resume_version_id,
      intakeRecordId: existing.intake_record_id,
      intakeAssetId: existing.intake_asset_id,
      eventId: existing.event_id,
      stageCode: existing.stage_code,
      lifecycleStatus: existing.lifecycle_status,
      recordVersion: existing.record_version,
      jobVersionId: existing.job_version_id,
    })
  }

  // 3) 身份结论。命中不到就新建，命中一条就复用，其余一律拒绝（一条行都不写）。
  const hits = await matchByStrongIds(client, tenantId, material.strong)
  const decision = decideIdentity(material.strong, hits)
  if (decision.kind === 'REVIEW') {
    throw contractError('BLOCKED_BY_REVIEW', {
      reason_code: decision.reason_code,
      message: decision.message,
      detail: { job_id: jobId, ...(decision.detail as Record<string, unknown>) },
    })
  }

  const parse = mapParseStatus(material.output.completeness, material.output.chars, material.output.issues)
  const hard = hardIssueCodes(material.output.issues as readonly MaterialIssue[] | undefined)

  // 4) Intake 三层 + resume + resume_version。
  const eventId = await upsertIntakeEvent(client, tenantId, material)
  const intakeRecordId = await insertIntakeRecord(client, tenantId, eventId, material)
  const intakeAssetId = await insertIntakeAsset(client, tenantId, intakeRecordId, material)

  let candidateId: string
  let candidateCreated: boolean
  if (decision.kind === 'LINK_EXISTING') {
    candidateId = decision.hit.candidate_id
    candidateCreated = false
  } else {
    candidateId = await insertCandidate(client, tenantId, material)
    candidateCreated = true
  }

  const resumeId = await insertResume(client, tenantId, candidateId, intakeAssetId)
  // D-29：有 `structured` 覆盖时五个业务字段以模型层为准；否则逐字等于转换器投影。
  const fields = effectiveFields(material)
  const projection = projectParsedFields(material.output) as unknown as Record<string, unknown>
  projection.fields = fields
  if (material.structured !== undefined) {
    projection.structured = structuredMetadata(material.structured)
  }
  const resumeVersionId = await insertResumeVersion(client, tenantId, {
    resumeId,
    material,
    parseStatus: parse.status,
    parseError: parse.parse_error,
    parsedFields: projection,
  })

  // 5) 申请（阶段 S6 = Intake；推进到 S7 是写侧动作，不由本工具代做）。
  if (job.current_job_version_id === null) {
    throw contractError('NOT_FOUND', {
      reason_code: 'JOB_VERSION_NOT_FOUND',
      message: '该岗位还没有 job_version（application.job_version_id 是 NOT NULL）',
      detail: { job_id: jobId },
    })
  }
  const application = await client.query<{ id: string; record_version: number }>(
    `insert into recruitment.application
       (tenant_id, candidate_id, job_id, job_version_id, resume_version_id,
        lifecycle_status, current_stage_code)
     values ($1, $2, $3, $4, $5, 'ACTIVE', 'S6')
     returning id, record_version`,
    [tenantId, candidateId, jobId, job.current_job_version_id, resumeVersionId],
  )
  const applicationRow = application.rows[0]
  if (applicationRow === undefined) {
    throw new RecruitmentToolError('READER_FAILED', 'application insert returned no row')
  }

  return assemble({
    cfg,
    material,
    job,
    created: true,
    candidateCreated,
    idempotentReplay: false,
    candidateId,
    applicationId: applicationRow.id,
    matchedBy: decision.kind === 'LINK_EXISTING'
      ? [...new Set(hits.map((hit) => hit.field))].sort().join('+')
      : 'created',
    resumeId,
    resumeVersionId,
    intakeRecordId,
    intakeAssetId,
    eventId,
    stageCode: 'S6',
    lifecycleStatus: 'ACTIVE',
    recordVersion: applicationRow.record_version,
    jobVersionId: job.current_job_version_id,
  })
}

async function loadJob(client: DatabaseClient, tenantId: string, jobId: string): Promise<JobRow> {
  const { rows } = await client.query<JobRow>(
    `select id, tenant_id, code, title, status, current_job_version_id
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
     values ($1, 'internal', 'resume.intake.received', 1, now(), now(), now(),
             $2, 'FALLBACK_KEY', $3, $4::jsonb, 'INTERNAL', 'resume.intake.received', 'intake/1.0.0')
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
     values ($1, $2, $3, 'application/pdf', $4, $5, $6, 'VALID')
     returning id`,
    [
      tenantId,
      intakeRecordId,
      material.file_name,
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

async function insertResumeVersion(
  client: DatabaseClient,
  tenantId: string,
  input: {
    readonly resumeId: string
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
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
     returning id`,
    [
      tenantId,
      input.resumeId,
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
  readonly created: boolean
  readonly candidateCreated: boolean
  readonly idempotentReplay: boolean
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
    created: input.created,
    candidate_created: input.candidateCreated,
    idempotent_replay: input.idempotentReplay,
    candidate_id: input.candidateId,
    application_id: input.applicationId,
    matched_by: input.matchedBy,
    resume_id: input.resumeId,
    resume_version_id: input.resumeVersionId,
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

/** 路径/读取层的失败 → 契约错误（消息里不出现手机号/邮箱/正文）。 */
function toPathError(error: unknown): never {
  if (error instanceof ConverterPathError) {
    const code: ContractErrorCode = error.code === 'FORBIDDEN'
      ? 'FORBIDDEN'
      : error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : 'INVALID_ARGS'
    throw contractError(code, {
      reason_code: error.code === 'FORBIDDEN'
        ? 'PATH_OUTSIDE_ALLOWED_ROOTS'
        : error.code === 'NOT_FOUND'
          ? 'FILE_NOT_FOUND'
          : 'PATH_INVALID',
      message: error.message,
    })
  }
  throw error
}

/**
 * 造一个绑定配置的 intake 工具。
 * @param cfg - 已解析的 converter + database 配置。
 */
export function createApplicationIntakeTool(cfg: IntakeToolConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S6 resume intake. Reads one local resume PDF, resolves the candidate by exact normalized '
      + 'phone/email only (names are never used for identity), and creates the application at stage S6. '
      + 'Idempotent per (sha256, job_id): a second call returns the same ids with created=false. '
      + 'If phone and email are both unreadable it refuses with BLOCKED_BY_REVIEW and writes nothing. '
      + 'It never merges candidates. Writes only through SET LOCAL recruitment.actor_id. '
      + 'Optionally accepts structured_json (the structuring agent result for the SAME PDF): it is '
      + 'validated against this PDF block index, rejected results write nothing, and accepted results '
      + 'set the five business fields state while preserving converter_state.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as IntakeValue
        const lines = [
          `intake: ${v.created ? 'created' : 'replayed'} application ${v.application_id}`,
          `candidate ${v.candidate_id} (${v.candidate_created ? 'new' : 'existing'}, matched_by=${v.matched_by})`,
          `job ${v.job.code} [${v.job.status}] stage=${v.application.stage_code} lifecycle=${v.application.lifecycle_status}`,
          `source: ${v.source.file_name} pages=${v.source.pages} bytes=${v.source.byte_size}`,
          `sha256=${v.source.sha256}`,
          `parse_status=${v.source.parse_status} completeness=${v.source.completeness} hard_issues=${v.source.hard_issue_count}`,
          `identity strong_ids=[${v.identity.strong_ids.join(', ')}] `
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
      let realPath: string
      try {
        realPath = assertReadablePdf(requested, cfg.converter)
      } catch (error) {
        toPathError(error)
      }
      let output: ConverterOutput
      try {
        output = await runConverter(cfg.converter, realPath)
      } catch (error) {
        throw contractError('READER_FAILED', {
          reason_code: 'CONVERTER_FAILED',
          message: 'converter 子进程读取失败（PDF 损坏/加密/超时）',
          detail: { error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' },
        })
      }
      let material = buildMaterial(realPath, output)
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
