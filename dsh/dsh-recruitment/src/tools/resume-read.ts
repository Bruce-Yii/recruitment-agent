// recruitment_resume_read —— 读一份本地简历（PDF / DOCX / RTF），返回带证据的结构化结果。
//
// 只读：不写文件、不写数据库、不改模块级状态。唯一的副作用是起一个 Python
// 子进程读取指定文档（只读打开），路径受 allowed_roots 约束。
//
// 格式判定与 `application_intake` / `document_read` **同一口径**（2026-11-14 修）：
// 不再用 `assertReadablePdf()` 按扩展名硬判 `.pdf`（那是 DOCX / RTF 被
// `INVALID_ARGS(PATH_INVALID)` 拒掉的根因），而是
// `assertReadableFile()`（只查路径安全）→ `sniffFile()`（**按字节**判格式）。
// 读得进去的格式只有 converter 真能读的三种：PDF、DOCX（MuPDF 的 OOXML 通道）、
// RTF（converter 的 striprtf reader）。图片字节明确拒绝：本工具没有 OCR/视觉步骤，
// 返回空 block 会被下游误当成"没有内容"。
//
// 字段三态是硬约束：present / absent / unreadable。unreadable 绝不能当 absent，
// 因为下游会把 absent 当"候选人确实没有这项"（见 doc 11 §9.2）。
//
// R4（`contracts/tenant-provenance.md` §2.1）：本工具是**唯一**真的读外部字节的读工具
// （真起 converter 子进程读磁盘上的 PDF），所以它可能合理地标 `LIVE`。但 `LIVE` 不是常量：
// 依据是 converter 对实际文件字节算出的 SHA-256（`meta.source_sha256`）。拿不到该 digest
// ⇒ fail-closed 成 `FIXTURE` + `provenance_evidence_missing` issue，绝不"默认 LIVE"。
// 边界：`LIVE` 只断言"字节来自真实文件且 digest 可复核"，**不**断言"这是真人简历、
// 不是演示件"——本工具没有租户/事件链证据去回答后者（那是 S6 intake / S7 证据链的问题）。

import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import type { RecruitmentErrorCode } from './errors.ts'
import {
  runConverter,
  type ConverterOutput,
  type ResolvedConverterConfig,
} from './converter.ts'
// 媒体判定复用统一读取层（U1）：路径安全与内容嗅探各只有一个实现，
// 与 `application_intake` / `document_read` 走同一条入口（2026-11-14 收口）。
import { DocumentReadError, isDocumentReadError } from '../document/readers/errors.ts'
import { assertReadableFile } from '../document/readers/files.ts'
import { sniffFile, type SniffResult } from '../document/readers/sniff.ts'
// O1：render 的**人读正文**只放业务事实，不放内部编号（完整 64hex 不给 HR 念）。
import { shortHash } from './render-ref.ts'

const RESUME_BLOCK_TYPES = ['paragraph', 'link', 'heading'] as const
const FIELD_NAMES = ['name', 'phone', 'email', 'work_experience', 'education'] as const
const FIELD_STATES = ['present', 'absent', 'unreadable'] as const

/**
 * `provenance` 的依据码（闭集；逐字进输出，不写自由文本）。
 *
 * R4：`LIVE` 必须**有证据**。本工具唯一的证据是 converter 对**实际文件字节**算出的
 * SHA-256（`meta.source_sha256`）——它证明了"这些 block 来自那份真实文件"。
 * 拿不到这个 digest ⇒ 不许自称 `LIVE`，fail-closed 成 `FIXTURE`。
 *
 * 边界（必须写在契约里，不许读者自行放大）：这里 `LIVE` 只断言"字节来自真实文件且可复核"，
 * **不**断言"这份简历是真人材料、不是演示件"。后者本工具无从判断（没有租户/事件链证据）。
 */
const PROVENANCE_BASES = ['FILE_BYTES_SHA256_VERIFIED', 'NO_READ_EVIDENCE'] as const
type ProvenanceBasis = (typeof PROVENANCE_BASES)[number]

/** 64 位小写 hex（SHA-256 的文本形状）。 */
const SHA256_HEX = /^[0-9a-f]{64}$/

/** 一次读取的"证据是否成立"：LIVE 的唯一依据。 */
interface ReadEvidence {
  /** true = `source.sha256` 是真实文件字节的 digest（且文档有页、有解析后端）。 */
  readonly verified: boolean
  /** 依据码（`LIVE` ⇔ `FILE_BYTES_SHA256_VERIFIED`）。 */
  readonly basis: ProvenanceBasis
  /** 归一化后的 digest（'' = converter 没给）。 */
  readonly sha256: string
}

/**
 * 从 converter 输出里取"这次读取有没有证据"。
 * 只认 **converter 自算**的 `meta.source_sha256`；不接受调用方自报的任何值。
 * @param output - converter 的原始输出（不可信输入）。
 * @returns 证据结论（`verified=false` 时调用方必须 fail-closed）。
 */
function readEvidenceOf(output: ConverterOutput): ReadEvidence {
  const raw = typeof output.meta?.source_sha256 === 'string' ? output.meta.source_sha256.trim().toLowerCase() : ''
  const pages = typeof output.meta?.pages === 'number' ? output.meta.pages : 0
  const backend = typeof output.meta?.backend === 'string' ? output.meta.backend.trim() : ''
  const verified = SHA256_HEX.test(raw) && pages > 0 && backend !== ''
  return {
    verified,
    basis: verified ? 'FILE_BYTES_SHA256_VERIFIED' : 'NO_READ_EVIDENCE',
    sha256: raw,
  }
}

/**
 * 本工具能读的格式：converter 真有 reader 的三类。
 *
 * 判定依据是**字节嗅探**（`sniffFile`）后的格式，不是扩展名；图片虽然能被
 * `document_read` 读成"待视觉补读"，但本工具没有视觉/OCR 步骤，收下只会返回空 block，
 * 让调用方误以为"这份简历没有内容"，所以明确拒绝而不是假装能读。
 */
const READABLE_FORMATS: readonly string[] = ['pdf', 'docx', 'rtf']

/** 路径类错误码：原样透传（它们不是"读取失败"，而是"这个路径不能读"）。 */
function pathOrReadError(error: DocumentReadError): RecruitmentToolError {
  const passThrough: readonly RecruitmentErrorCode[] = ['INVALID_ARGS', 'NOT_FOUND', 'FORBIDDEN']
  if (passThrough.includes(error.code as RecruitmentErrorCode)) {
    return new RecruitmentToolError(error.code as RecruitmentErrorCode, error.message)
  }
  // 其余（EMPTY_FILE / UNSUPPORTED_MEDIA / READ_TIMEOUT...）统一走 READER_FAILED，
  // 并把 reader 的稳定 code 作为 `reason_code` 保留，便于机器复核（与 S6 同形）。
  return new RecruitmentToolError(
    error.code === 'EMPTY_FILE' ? 'INVALID_ARGS' : 'READER_FAILED',
    JSON.stringify({ reason_code: error.code, message: error.message }),
  )
}

const PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 1024,
    description: 'Absolute path of a local resume (PDF / DOCX / RTF) inside an allowed root.',
  },
  max_blocks: {
    kind: 'integer',
    min: 1,
    max: 200,
    description: 'Maximum number of content blocks to return (1..200). Defaults to 40.',
  },
  block_types: {
    kind: 'string[]',
    values: RESUME_BLOCK_TYPES,
    description: 'Optional filter: return only these block kinds.',
  },
}

const DEFAULT_MAX_BLOCKS = 40

interface FieldValue {
  readonly state: string
  /** 只有 state === 'present' 时才出现；absent / unreadable 时整个键省略。 */
  readonly value?: string
  readonly reason: string
  readonly evidence: readonly {
    readonly page: number
    readonly bbox: readonly number[]
    readonly block: number
    readonly text: string
  }[]
}

interface ResumeReadValue {
  /**
   * R4 数据真假。`LIVE` **当且仅当** {@link readEvidenceOf} 判定读取证据成立
   * （converter 对实际字节算了 SHA-256）；否则 `FIXTURE`（fail-closed）。
   */
  readonly provenance: 'LIVE' | 'FIXTURE'
  /** `provenance` 的依据码（闭集）：`LIVE` ⇔ `FILE_BYTES_SHA256_VERIFIED`。 */
  readonly provenance_basis: ProvenanceBasis
  readonly stub: false
  readonly source: {
    readonly file_name: string
    readonly media_type: string
    readonly pages: number
    readonly sha256: string
    readonly backend: string
    readonly order_verified: boolean
    readonly completeness: string
  }
  readonly blocks: readonly {
    readonly index: number
    readonly type: string
    readonly page: number
    readonly text: string
    readonly bbox: readonly number[]
  }[]
  readonly block_count: number
  readonly truncated: boolean
  readonly fields: Record<string, FieldValue>
  readonly screening: {
    readonly eligible_fields: readonly string[]
    readonly blocked_fields: readonly { readonly field: string; readonly reason: string }[]
    readonly identity_merge_eligible: readonly string[]
    readonly protected_excluded: readonly string[]
  }
  readonly issues: readonly { readonly code: string; readonly message: string }[]
  readonly needs_visual: boolean
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    provenance: {
      type: 'string',
      enum: ['LIVE', 'FIXTURE'],
      description: '数据真假（R4）。LIVE 当且仅当 provenance_basis=FILE_BYTES_SHA256_VERIFIED；'
        + '拿不到文件字节 digest 时 fail-closed 成 FIXTURE。',
    },
    provenance_basis: {
      type: 'string',
      enum: [...PROVENANCE_BASES],
      description: 'LIVE 的依据：FILE_BYTES_SHA256_VERIFIED = source.sha256 是 converter 对实际文件字节算的'
        + ' 64 位 hex（可复核）；NO_READ_EVIDENCE = 没有这个 digest，因此只能是 FIXTURE。',
    },
    stub: { type: 'boolean', enum: [false] },
    source: {
      type: 'object',
      properties: {
        file_name: { type: 'string' },
        media_type: { type: 'string' },
        pages: { type: 'integer' },
        sha256: { type: 'string' },
        backend: { type: 'string' },
        order_verified: { type: 'boolean' },
        completeness: { type: 'string' },
      },
      required: ['file_name', 'media_type', 'pages', 'sha256', 'backend', 'order_verified', 'completeness'],
      additionalProperties: false,
    },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          type: { type: 'string' },
          page: { type: 'integer' },
          text: { type: 'string' },
          bbox: { type: 'array', items: { type: 'number' } },
        },
        required: ['index', 'type', 'page', 'text', 'bbox'],
        additionalProperties: false,
      },
    },
    block_count: { type: 'integer' },
    truncated: { type: 'boolean' },
    fields: {
      type: 'object',
      properties: Object.fromEntries(FIELD_NAMES.map((name) => [name, {
        type: 'object',
        properties: {
          state: { type: 'string', enum: [...FIELD_STATES] },
          value: { type: 'string' },
          reason: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                bbox: { type: 'array', items: { type: 'number' } },
                block: { type: 'integer' },
                text: { type: 'string' },
              },
              required: ['page', 'bbox', 'block', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['state', 'reason', 'evidence'],
        additionalProperties: false,
      }])),
      required: [...FIELD_NAMES],
      additionalProperties: false,
    },
    screening: {
      type: 'object',
      properties: {
        eligible_fields: { type: 'array', items: { type: 'string' } },
        blocked_fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, reason: { type: 'string' } },
            required: ['field', 'reason'],
            additionalProperties: false,
          },
        },
        identity_merge_eligible: { type: 'array', items: { type: 'string' } },
        protected_excluded: { type: 'array', items: { type: 'string' } },
      },
      required: ['eligible_fields', 'blocked_fields', 'identity_merge_eligible', 'protected_excluded'],
      additionalProperties: false,
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' } },
        required: ['code', 'message'],
        additionalProperties: false,
      },
    },
    needs_visual: { type: 'boolean' },
  },
  required: [
    'provenance', 'provenance_basis', 'stub', 'source', 'blocks', 'block_count', 'truncated',
    'fields', 'screening', 'issues', 'needs_visual',
  ],
  additionalProperties: false,
}

function toFieldValue(raw: ConverterOutput['fields'], name: string): FieldValue {
  const entry = raw?.[name]
  const state = entry?.state
  const evidence = (entry?.evidence ?? []).map((e) => ({
    page: typeof e.page === 'number' ? e.page : 0,
    bbox: (e.bbox ?? []).map((n) => (typeof n === 'number' ? n : 0)),
    block: typeof e.block === 'number' ? e.block : -1,
    text: typeof e.text === 'string' ? e.text : '',
  }))
  if (state !== 'present' && state !== 'absent' && state !== 'unreadable') {
    // 转换器没给出可识别状态时，按 unreadable 处理：绝不当成 absent。
    return { state: 'unreadable', reason: 'state_missing_from_converter', evidence }
  }
  // value 只在 present 时存在。用「省略」而不是 null 表达「没有值」：
  // 输出 schema 的 value 是 type:string，而 DSH 的校验器不支持 type 数组
  // （dsh-tools/lib/types/json-schema.js:245「type arrays are not supported」），
  // 写 null 会让整个工具调用以 INVALID_TOOL_OUTPUT 失败——这正是 2026-11-13
  // 第一次真实 headless 调用暴露的缺陷。状态本身已由 state 三元组表达。
  const base = {
    state,
    reason: typeof entry?.reason === 'string' ? entry.reason : '',
    evidence,
  }
  return state === 'present' && typeof entry?.value === 'string'
    ? { ...base, value: entry.value }
    : base
}

/** 导出只为测试：这是「转换结果 → 工具规范输出」的纯映射，没有 I/O。 */
export function toValue(
  output: ConverterOutput,
  maxBlocks: number,
  wanted?: readonly string[],
  mediaType: string = 'application/pdf',
): ResumeReadValue {
  const allBlocks = (output.blocks ?? []).map((block, index) => ({
    index,
    type: typeof block.kind === 'string' ? block.kind : 'paragraph',
    page: typeof block.location?.page === 'number' ? block.location.page : 0,
    text: typeof block.text === 'string' ? block.text : '',
    bbox: (block.location?.bbox ?? []).map((n) => (typeof n === 'number' ? n : 0)),
  }))
  const selected = wanted === undefined ? allBlocks : allBlocks.filter((b) => wanted.includes(b.type))
  const kept = selected.slice(0, maxBlocks)
  const fields = Object.fromEntries(
    FIELD_NAMES.map((name) => [name, toFieldValue(output.fields, name)]),
  ) as Record<string, FieldValue>
  const screening = output.screening ?? {}
  // R4：provenance 由**这次读取的证据**算，不是常量。证据不成立时补一条 issue，让调用方
  // 看得到"为什么不是 LIVE"，而不是只看到一个静默降级的标签。
  const evidence = readEvidenceOf(output)
  const issues = (output.issues ?? []).map((i) => ({
    code: i.code ?? 'unknown_issue',
    message: i.message ?? '',
  }))
  if (!evidence.verified) {
    issues.push({
      code: 'provenance_evidence_missing',
      message: 'converter 没有给出可复核的文件字节 SHA-256（或页数/解析后端缺失）：'
        + '本次读取无法证明"这些 block 来自真实文件字节"，provenance 只能是 FIXTURE',
    })
  }
  return {
    provenance: evidence.verified ? 'LIVE' : 'FIXTURE',
    provenance_basis: evidence.basis,
    stub: false,
    source: {
      file_name: output.meta?.source_name ?? '',
      media_type: mediaType,
      pages: typeof output.meta?.pages === 'number' ? output.meta.pages : 0,
      sha256: output.meta?.source_sha256 ?? '',
      backend: output.meta?.backend ?? '',
      order_verified: output.meta?.order_verified === true,
      completeness: output.completeness ?? 'unverified',
    },
    blocks: kept,
    block_count: selected.length,
    truncated: selected.length > kept.length,
    fields,
    screening: {
      eligible_fields: screening.eligible_fields ?? [],
      blocked_fields: (screening.blocked_fields ?? []).map((b) => ({
        field: b.field ?? '',
        reason: b.reason ?? '',
      })),
      identity_merge_eligible: screening.identity_merge_eligible ?? [],
      protected_excluded: screening.protected_excluded ?? [],
    },
    issues,
    needs_visual: output.needs_visual === true,
  }
}

/** 造一个绑定配置的只读简历工具。 */
export function createResumeReadTool(cfg: ResolvedConverterConfig): ReadonlyToolDefinition {
  return {
    name: 'recruitment_resume_read',
    description:
      'Read one local resume (PDF / DOCX / RTF — the format is sniffed from the file CONTENT, '
      + 'so the extension never decides) and return its ordered content blocks with evidence, '
      + 'plus name/phone/email/work_experience/education in a three-state form '
      + '(present | absent | unreadable). Read-only: no database, no writes. '
      + 'unreadable must never be treated as absent. Returns FORBIDDEN for paths outside '
      + 'the configured roots and NOT_FOUND for missing files; image-only bytes are rejected '
      + 'with READER_FAILED(reason_code=IMAGE_REQUIRES_VISION) because this tool has no OCR step. '
      + 'R4 labels: provenance=LIVE only when the converter reported a verifiable SHA-256 of the actual file '
      + 'bytes (provenance_basis=FILE_BYTES_SHA256_VERIFIED); otherwise FIXTURE (fail-closed, with a '
      + 'provenance_evidence_missing issue). LIVE means "these blocks come from those real file bytes", not '
      + '"this resume belongs to a real person".',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as ResumeReadValue
        const lines: string[] = [
          `resume: ${v.source.file_name}`,
          `pages=${v.source.pages} backend=${v.source.backend} `
            + `completeness=${v.source.completeness} order_verified=${String(v.source.order_verified)}`,
          // O1：文件字节 digest 只给短 hash（前 8 位）——它是"这些 block 来自哪份文件"的
          // 锚点，完整 64hex 对 HR 没有意义、还会被原样念出来。完整值仍在结构化 value 里。
          `sha256=${shortHash(v.source.sha256)}`,
          `provenance=${v.provenance} (basis=${v.provenance_basis})`,
          `blocks: ${v.blocks.length} of ${v.block_count} (truncated=${String(v.truncated)})`,
          '',
          'fields:',
        ]
        for (const name of FIELD_NAMES) {
          const f = v.fields[name]
          const where = f.evidence.length > 0
            ? ` @p${f.evidence[0].page}`
            : ''
          lines.push(`  ${name}: ${f.state}${f.value === undefined ? '' : ` = ${f.value}`}`
            + `${f.reason === '' ? '' : ` (${f.reason})`}${where}`)
        }
        if (v.screening.blocked_fields.length > 0) {
          lines.push('', 'blocked from screening:')
          for (const b of v.screening.blocked_fields) lines.push(`  ${b.field}: ${b.reason}`)
        }
        if (v.issues.length > 0) {
          const codes = [...new Set(v.issues.map((i) => i.code))]
          lines.push('', `issues: ${codes.join(', ')}`)
        }
        if (v.needs_visual) lines.push('', 'needs_visual: true (content requires human/vision reading)')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      const args = parseArgs(PARAMS, rawArgs)
      const requested = args.path as string
      const maxBlocks = args.max_blocks === undefined ? DEFAULT_MAX_BLOCKS : (args.max_blocks as number)
      const wanted = args.block_types as readonly string[] | undefined

      // 1) 路径安全（绝对 / 存在 / 普通文件 / allowed_roots / 非空）——只有一份实现。
      // 2) 内容嗅探（按字节判 PDF / DOCX / RTF / PNG / JPEG）——扩展名不参与。
      let realPath: string
      let sniff: SniffResult
      try {
        const file = assertReadableFile(requested, cfg)
        realPath = file.real_path
        sniff = await sniffFile(realPath)
      } catch (error) {
        if (isDocumentReadError(error)) throw pathOrReadError(error)
        throw error
      }

      if (!READABLE_FORMATS.includes(sniff.format)) {
        // 图片本工具读不了：不是"内容为空"，而是"这种媒体需要视觉读取"。
        // 与 S6 的 `IMAGE_REQUIRES_VISION` 同一原因码，调用方可以据此改走 document_read。
        const reasonCode = sniff.format === 'png' || sniff.format === 'jpeg'
          ? 'IMAGE_REQUIRES_VISION'
          : 'UNSUPPORTED_MEDIA'
        throw new RecruitmentToolError('READER_FAILED', JSON.stringify({
          reason_code: reasonCode,
          message: sniff.format === 'png' || sniff.format === 'jpeg'
            ? '这份材料是图片，本工具没有 OCR / 视觉步骤：从像素猜出来的字段只能算 agent_read，'
              + '不能当原生文本。请改用 recruitment_document_read（会给出 vision 补读计划），'
              + '或先用能产出 native_text 的原件（PDF / DOCX / RTF）。'
            : `本工具不读这种媒体：${String(sniff.format)}`,
          sniffed_media: sniff.media,
        }))
      }

      let output: ConverterOutput
      try {
        const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
        output = await runConverter(cfg, realPath, signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new RecruitmentToolError('READER_FAILED', `converter failed: ${message}`)
      }
      // media_type 用**嗅探值**，不用扩展名、也不写死 application/pdf（DOCX/RTF 的假标签根因）。
      return toValue(output, maxBlocks, wanted, sniff.media)
    },
  }
}


