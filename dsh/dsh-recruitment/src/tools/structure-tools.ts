// 结构化层的两个工具：序列化 + 校验。
//
// 这两件是「文本 → 结构化」的前后两端：
//   recruitment_resume_serialize   把转换结果变成带 id 的行文本（给模型看）
//   recruitment_structure_validate 校验模型返回的结构化结果（防幻觉）
//
// 为什么必须接线：按 E4/R2，只存在于包内、只被单测调用的实现不算完成。
// 这两个工具让该层从插件运行入口可达。
//
// 只读：不写文件、不写数据库；唯一副作用是起子进程调本地 Python 读取器。

import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  assertReadablePdf,
  ConverterPathError,
  runConverter,
  type ConverterOutput,
  type ResolvedConverterConfig,
} from './converter.ts'
import { serialize, type BlockIndex, type SourceBlock } from '../structure/serialize.ts'
import { validate } from '../structure/validate.ts'

const SERIALIZE_PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 1024,
    description: 'Absolute path of a local resume PDF inside an allowed root.',
  },
  max_lines: {
    kind: 'integer',
    min: 1,
    max: 2000,
    description: 'Truncate the numbered text after this many lines (1..2000). Defaults to all.',
  },
}

const VALIDATE_PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 1024,
    description: 'Absolute path of the same resume PDF that was serialized.',
  },
  result_json: {
    kind: 'string',
    required: true,
    maxLength: 200_000,
    description: "The model's structured output as a JSON string. Validated against the block index.",
  },
}

/** 读一份 PDF 并拿到转换结果 + 序列化结果（两个工具共用）。 */
async function loadSerialized(
  cfg: ResolvedConverterConfig,
  requested: string,
  signal: AbortSignal | undefined,
): Promise<{ realPath: string; output: ConverterOutput; serialized: ReturnType<typeof serialize> }> {
  let realPath: string
  try {
    realPath = assertReadablePdf(requested, cfg)
  } catch (error) {
    if (error instanceof ConverterPathError) {
      throw new RecruitmentToolError(error.code, error.message)
    }
    throw error
  }
  let output: ConverterOutput
  try {
    output = await runConverter(cfg, realPath, signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new RecruitmentToolError('READER_FAILED', `converter failed: ${message}`)
  }
  const serialized = serialize({
    blocks: (output.blocks ?? []) as readonly SourceBlock[],
    meta: { source_sha256: output.meta?.source_sha256 },
  })
  return { realPath, output, serialized }
}

/** `#doc` 文档头：模型必须看到"顺序是否可信"，否则会在顺序不可信的文档上合法地写 absent。 */
function docHeader(output: ConverterOutput): string {
  const meta = output.meta ?? {}
  const issues = [...new Set((output.issues ?? []).map((i) => i.code ?? 'unknown_issue'))]
  const unreadPages = [...new Set(
    (output.issues ?? [])
      .filter((i) => {
        const code = i.code ?? ''
        return code === 'unread_visual_page' || code === 'pdf_text_encoding_unread'
      })
      .map((i) => {
        const loc = i.location as { page?: number } | undefined
        return typeof loc?.page === 'number' ? loc.page : -1
      })
      .filter((p) => p > 0),
  )]
  return [
    '#doc',
    `pages=${meta.pages ?? 0}`,
    `completeness=${output.completeness ?? 'unverified'}`,
    `order_verified=${meta.order_verified === true}`,
    `needs_visual=${output.needs_visual === true}`,
    `unread_pages=${unreadPages.join(',') || 'none'}`,
    `issues=${issues.join(',') || 'none'}`,
  ].join(' | ')
}

const SERIALIZE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    file_name: { type: 'string' },
    sha256: { type: 'string' },
    pages: { type: 'integer' },
    doc_header: { type: 'string' },
    numbered_text: { type: 'string' },
    line_count: { type: 'integer' },
    block_count: { type: 'integer' },
    split_blocks: { type: 'integer' },
    empty_blocks: { type: 'integer' },
    truncated: { type: 'boolean' },
    block_index: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          block_no: { type: 'integer' },
          page: { type: 'integer' },
          bbox: { type: 'array', items: { type: 'number' } },
          sha256: { type: 'string' },
        },
        required: ['id', 'block_no', 'page', 'bbox', 'sha256'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'file_name', 'sha256', 'pages', 'doc_header', 'numbered_text',
    'line_count', 'block_count', 'split_blocks', 'empty_blocks', 'truncated', 'block_index',
  ],
  additionalProperties: false,
}

const VALIDATE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    accepted: { type: 'boolean' },
    rejection_count: { type: 'integer' },
    issue_count: { type: 'integer' },
    rejections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { code: { type: 'string' }, detail: { type: 'string' } },
        required: ['code', 'detail'],
        additionalProperties: false,
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { code: { type: 'string' }, detail: { type: 'string' } },
        required: ['code', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['accepted', 'rejection_count', 'issue_count', 'rejections', 'issues'],
  additionalProperties: false,
}

function flatten(index: BlockIndex): readonly {
  readonly id: number
  readonly block_no: number
  readonly page: number
  readonly bbox: readonly number[]
  readonly sha256: string
}[] {
  const entries = (index as unknown as { entries?: readonly unknown[] }).entries ?? []
  return (entries as readonly Record<string, unknown>[]).map((entry) => ({
    id: typeof entry.id === 'number' ? entry.id : 0,
    block_no: typeof entry.block_no === 'number' ? entry.block_no : 0,
    page: typeof entry.page === 'number' ? entry.page : -1,
    bbox: Array.isArray(entry.bbox) ? (entry.bbox as readonly number[]) : [],
    sha256: typeof entry.sha256 === 'string' ? entry.sha256 : '',
  }))
}

/** 序列化工具：把转换结果变成带 id 的行文本。 */
export function createResumeSerializeTool(cfg: ResolvedConverterConfig): ReadonlyToolDefinition {
  return {
    name: 'recruitment_resume_serialize',
    description:
      'Read a local resume PDF and return its content as numbered lines (`#id | pN | text`) '
      + 'plus a block index (id -> page/bbox/sha256) and a #doc header stating whether the '
      + 'reading order is verified. Feed the numbered lines to a structuring step; the ids are '
      + 'what make every extracted value verifiable afterwards. Read-only.',
    parameters: toParameterSchema(SERIALIZE_PARAMS),
    output: {
      schema: SERIALIZE_OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as {
          file_name: string
          doc_header: string
          numbered_text: string
          line_count: number
          block_count: number
          truncated: boolean
        }
        const header = `serialized ${v.file_name}: ${v.line_count} lines from ${v.block_count} blocks`
          + `${v.truncated ? ' (truncated)' : ''}`
        return [{ type: 'text', text: `${header}\n${v.doc_header}\n\n${v.numbered_text}` }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      const args = parseArgs(SERIALIZE_PARAMS, rawArgs)
      const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
      const { output, serialized } = await loadSerialized(cfg, args.path as string, signal)
      const maxLines = args.max_lines === undefined ? Number.MAX_SAFE_INTEGER : (args.max_lines as number)
      const allLines = serialized.text.split('\n')
      const kept = allLines.slice(0, maxLines)
      return {
        file_name: output.meta?.source_name ?? '',
        sha256: output.meta?.source_sha256 ?? '',
        pages: typeof output.meta?.pages === 'number' ? output.meta.pages : 0,
        doc_header: docHeader(output),
        numbered_text: kept.join('\n'),
        line_count: serialized.stats.lines,
        block_count: serialized.stats.blocks,
        split_blocks: serialized.stats.split_blocks,
        empty_blocks: serialized.stats.empty_blocks,
        truncated: kept.length < allLines.length,
        block_index: flatten(serialized.blockIndex),
      }
    },
  }
}

/** 校验工具：拿模型的输出对着 block index 查。 */
export function createStructureValidateTool(cfg: ResolvedConverterConfig): ReadonlyToolDefinition {
  return {
    name: 'recruitment_structure_validate',
    description:
      "Validate a structuring result against the same PDF's block index. Rejects values that are "
      + 'not verbatim substrings of the cited blocks, unknown block ids, uncovered blocks, '
      + 'duplicated blocks, invalid phone/email/date formats, and omitted fields. '
      + 'Soft issues (inverted or overlapping periods) are reported without rejecting. Read-only.',
    parameters: toParameterSchema(VALIDATE_PARAMS),
    output: {
      schema: VALIDATE_OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as {
          accepted: boolean
          rejection_count: number
          issue_count: number
          rejections: readonly { code: string; detail: string }[]
          issues: readonly { code: string; detail: string }[]
        }
        const lines = [
          `accepted=${String(v.accepted)}  rejections=${v.rejection_count}  issues=${v.issue_count}`,
        ]
        for (const r of v.rejections.slice(0, 20)) lines.push(`  REJECT ${r.code}: ${r.detail}`)
        for (const i of v.issues.slice(0, 20)) lines.push(`  ISSUE  ${i.code}: ${i.detail}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      const args = parseArgs(VALIDATE_PARAMS, rawArgs)
      const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
      const { output, serialized } = await loadSerialized(cfg, args.path as string, signal)
      let parsed: unknown
      try {
        parsed = JSON.parse(args.result_json as string)
      } catch (error) {
        throw new RecruitmentToolError(
          'INVALID_ARGS',
          `result_json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const result = validate({
        result: parsed,
        blockIndex: serialized.blockIndex,
        blocks: (output.blocks ?? []) as readonly SourceBlock[],
      })
      const toRow = (item: unknown): { code: string; detail: string } => {
        const record = item as Record<string, unknown>
        const code = typeof record.code === 'string' ? record.code : 'unknown'
        const detail = typeof record.detail === 'string'
          ? record.detail
          : typeof record.message === 'string' ? record.message : ''
        return { code, detail }
      }
      const rejections = (result.rejected ?? []).map(toRow)
      const issues = (result.issues ?? []).map(toRow)
      return {
        accepted: result.accepted === true,
        rejection_count: rejections.length,
        issue_count: issues.length,
        rejections,
        issues,
      }
    },
  }
}

