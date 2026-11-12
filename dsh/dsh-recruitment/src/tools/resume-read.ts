// recruitment_resume_read —— 读一份简历的解析结果（只读，stub 数据）。
//
// 只读证据：本文件不 import 任何 fs / net / DB 模块，也不修改任何模块级状态；
// execute 只做「按 id 取常量 + 过滤 + 切片」。

import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { RESUME_BLOCK_TYPES, RESUME_STUBS, STUB_PROVENANCE } from './stubs.ts'

/** 入参声明。 */
const PARAMS: ParamMap = {
  resume_id: {
    kind: 'string',
    required: true,
    maxLength: 64,
    description: 'Resume identifier, e.g. "resume_0001". Non-empty, at most 64 characters.',
  },
  max_blocks: {
    kind: 'integer',
    min: 1,
    max: 50,
    description: 'Maximum number of blocks to return (1..50). Defaults to 20.',
  },
  block_types: {
    kind: 'string[]',
    values: RESUME_BLOCK_TYPES,
    description: 'Optional filter: return only these block kinds '
      + '(contact | summary | experience | education | skill).',
  },
}

/** 输出：解析来源。 */
interface ResumeSource {
  readonly file_name: string
  readonly media_type: string
  readonly pages: number
  readonly extraction: string
}

/** 输出：一个内容块。 */
interface ResumeBlockValue {
  readonly index: number
  readonly type: string
  readonly page: number
  readonly text: string
  readonly review_required: boolean
}

/** 输出：规范值。 */
interface ResumeReadValue {
  readonly resume_id: string
  readonly provenance: string
  readonly stub: boolean
  readonly source: ResumeSource
  readonly blocks: readonly ResumeBlockValue[]
  readonly block_count: number
  readonly truncated: boolean
}

/** 规范输出 schema（只用官方强制子集里的关键字）。 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    resume_id: { type: 'string' },
    provenance: { type: 'string', enum: ['FIXTURE', 'LIVE'] },
    stub: { type: 'boolean' },
    source: {
      type: 'object',
      properties: {
        file_name: { type: 'string' },
        media_type: { type: 'string' },
        pages: { type: 'integer' },
        extraction: { type: 'string', enum: ['TEXT_LAYER', 'OCR'] },
      },
      required: ['file_name', 'media_type', 'pages', 'extraction'],
      additionalProperties: false,
    },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          type: { type: 'string', enum: [...RESUME_BLOCK_TYPES] },
          page: { type: 'integer' },
          text: { type: 'string' },
          review_required: { type: 'boolean' },
        },
        required: ['index', 'type', 'page', 'text', 'review_required'],
        additionalProperties: false,
      },
    },
    block_count: { type: 'integer' },
    truncated: { type: 'boolean' },
  },
  required: ['resume_id', 'provenance', 'stub', 'source', 'blocks', 'block_count', 'truncated'],
  additionalProperties: false,
}

/** 默认返回块数。 */
const DEFAULT_MAX_BLOCKS = 20

/** 只读简历工具。 */
export const resumeReadTool: ReadonlyToolDefinition = {
  name: 'recruitment_resume_read',
  description:
    'Read one parsed resume and return its ordered content blocks. '
    + 'Read-only stub over fixture data: provenance is always FIXTURE and no database is touched. '
    + 'Returns NOT_FOUND when the resume id is unknown.',
  parameters: toParameterSchema(PARAMS),
  output: {
    schema: OUTPUT_SCHEMA,
    render(_args: unknown, value: unknown): readonly TextBlock[] {
      const v = value as ResumeReadValue
      const lines: string[] = [
        `resume ${v.resume_id} (provenance=${v.provenance}, stub=${String(v.stub)})`,
        `source: ${v.source.file_name} (${v.source.media_type}), ${v.source.pages} page(s), `
          + `extraction=${v.source.extraction}`,
        `blocks: ${v.blocks.length} returned of ${v.block_count} (truncated=${String(v.truncated)})`,
      ]
      for (const block of v.blocks) {
        lines.push('')
        lines.push(`[${block.index}] ${block.type} (page ${block.page}, `
          + `review_required=${String(block.review_required)})`)
        lines.push(block.text)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  isConcurrencySafe(): boolean {
    return true
  },
  async execute(rawArgs: unknown): Promise<unknown> {
    const args = parseArgs(PARAMS, rawArgs)
    const resumeId = args.resume_id as string
    const record = RESUME_STUBS[resumeId]
    if (record === undefined) {
      throw new RecruitmentToolError(
        'NOT_FOUND',
        `resume "${resumeId}" not found; known stub ids: ${Object.keys(RESUME_STUBS).join(', ')}`,
      )
    }
    const maxBlocks = args.max_blocks === undefined ? DEFAULT_MAX_BLOCKS : (args.max_blocks as number)
    const wanted = args.block_types as readonly string[] | undefined
    const selected = wanted === undefined
      ? record.blocks
      : record.blocks.filter((block) => wanted.includes(block.type))
    const kept = selected.slice(0, maxBlocks)
    const value: ResumeReadValue = {
      resume_id: record.resume_id,
      provenance: STUB_PROVENANCE,
      stub: true,
      source: {
        file_name: record.file_name,
        media_type: record.media_type,
        pages: record.pages,
        extraction: record.extraction,
      },
      blocks: kept.map((block) => ({
        index: block.index,
        type: block.type,
        page: block.page,
        text: block.text,
        review_required: block.review_required,
      })),
      block_count: selected.length,
      truncated: selected.length > kept.length,
    }
    return value
  },
}
