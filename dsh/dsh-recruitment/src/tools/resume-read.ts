// recruitment_resume_read —— 读一份本地简历 PDF，返回带坐标证据的结构化结果。
//
// 只读：不写文件、不写数据库、不改模块级状态。唯一的副作用是起一个 Python
// 子进程读取指定 PDF（只读打开），路径受 allowed_roots 约束。
//
// 字段三态是硬约束：present / absent / unreadable。unreadable 绝不能当 absent，
// 因为下游会把 absent 当"候选人确实没有这项"（见 doc 11 §9.2）。

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

const RESUME_BLOCK_TYPES = ['paragraph', 'link', 'heading'] as const
const FIELD_NAMES = ['name', 'phone', 'email', 'work_experience', 'education'] as const
const FIELD_STATES = ['present', 'absent', 'unreadable'] as const

const PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 1024,
    description: 'Absolute path of a local resume PDF inside an allowed root.',
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
  readonly value: string | null
  readonly reason: string
  readonly evidence: readonly {
    readonly page: number
    readonly bbox: readonly number[]
    readonly block: number
    readonly text: string
  }[]
}

interface ResumeReadValue {
  readonly provenance: 'LIVE'
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
    provenance: { type: 'string', enum: ['LIVE'] },
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
    'provenance', 'stub', 'source', 'blocks', 'block_count', 'truncated',
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
    return { state: 'unreadable', value: null, reason: 'state_missing_from_converter', evidence }
  }
  return {
    state,
    value: typeof entry?.value === 'string' ? entry.value : null,
    reason: typeof entry?.reason === 'string' ? entry.reason : '',
    evidence,
  }
}

function toValue(output: ConverterOutput, maxBlocks: number, wanted?: readonly string[]): ResumeReadValue {
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
  return {
    provenance: 'LIVE',
    stub: false,
    source: {
      file_name: output.meta?.source_name ?? '',
      media_type: 'application/pdf',
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
    issues: (output.issues ?? []).map((i) => ({
      code: i.code ?? 'unknown_issue',
      message: i.message ?? '',
    })),
    needs_visual: output.needs_visual === true,
  }
}

/** 造一个绑定配置的只读简历工具。 */
export function createResumeReadTool(cfg: ResolvedConverterConfig): ReadonlyToolDefinition {
  return {
    name: 'recruitment_resume_read',
    description:
      'Read one local resume PDF and return its ordered content blocks with page/bbox evidence, '
      + 'plus name/phone/email/work_experience/education in a three-state form '
      + '(present | absent | unreadable). Read-only: no database, no writes. '
      + 'unreadable must never be treated as absent. Returns FORBIDDEN for paths outside '
      + 'the configured roots and NOT_FOUND for missing files.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as ResumeReadValue
        const lines: string[] = [
          `resume: ${v.source.file_name}`,
          `pages=${v.source.pages} backend=${v.source.backend} `
            + `completeness=${v.source.completeness} order_verified=${String(v.source.order_verified)}`,
          `sha256=${v.source.sha256}`,
          `blocks: ${v.blocks.length} of ${v.block_count} (truncated=${String(v.truncated)})`,
          '',
          'fields:',
        ]
        for (const name of FIELD_NAMES) {
          const f = v.fields[name]
          const where = f.evidence.length > 0
            ? ` @p${f.evidence[0].page}`
            : ''
          lines.push(`  ${name}: ${f.state}${f.value === null ? '' : ` = ${f.value}`}`
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
        const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
        output = await runConverter(cfg, realPath, signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new RecruitmentToolError('READER_FAILED', `converter failed: ${message}`)
      }
      return toValue(output, maxBlocks, wanted)
    },
  }
}


