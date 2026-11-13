// recruitment_document_read —— 多格式文档读取（PDF / DOCX / PNG / JPEG）的**唯一入口**。
//
// 这是 U3 的"收口"：U0（契约）/ U1（Reader）/ U2（质量 + 恢复）都已经有实现和测试，
// 但**没有暴露成工具**，所以 agent 调不到 —— 典型 R2 假接线（能力在包里、入口没有它）。
//
// 接线硬要求（`src/document/README.md` §6.2）：
//   const { content, source_meta } = await readDocumentDetailed(path, cfg)
//   const facts = readerFactsFromSourceMeta(source_meta)   // 只消费 content 会丢 facts
//   const assessment = assess(content, facts)              // 症状：每份 PDF 都命中 doc_page_count_unverified（HARD）
//   const recovery = plan(content, { assessment, facts })
//
// 三个诚实点：
//   1. 读不出就抛错（`DocumentReadError`），**绝不**返回一个"看起来 complete"的结果；
//   2. `assessment.blocking=true` 时明确告诉模型"不得进入可信结构化/S7"，并把恢复计划一并给出；
//   3. 恢复计划只是**计划**，本工具不调模型、不渲染、不写库（D-81：视觉补读由 agent 用 read_image 做）。
//
// 与 `recruitment_resume_read` 的分工：那个只读 PDF 的纯文本；这个走统一 Reader（按内容嗅探，
// 不按扩展名），并且带质量判定与恢复计划。新链路一律用这个。

import { readDocumentDetailed, isDocumentReadError } from '../document/readers/index.ts'
import { assess, readerFactsFromSourceMeta } from '../document/quality/index.ts'
import { plan } from '../document/recovery/index.ts'
import type { DocumentContent } from '../document/contracts/index.ts'
import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import type { ResolvedConverterConfig } from './converter.ts'

/**
 * 真正阻断**结构化**的 code（D-97 第一批）。
 *
 * 不在这里的 HARD code（跨块归属、阅读顺序、未核图片、归属未核、时间线未解析）
 * 只影响"可信筛选"，不影响"把文字抽成字段"——模型结构化不需要知道哪句话在左栏。
 */
const STRUCTURE_BLOCKING_CODES: readonly string[] = [
  'doc_empty',
  'doc_text_unreadable',
  'pdf_text_encoding_unread',
  'docx_textbox_unread',
  'doc_unreadable',
  'image_requires_vision',
]

/** 工具名。 */
const TOOL_NAME = 'recruitment_document_read'

/** 入参声明。 */
const PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 4096,
    description:
      'Absolute path to one local PDF / DOCX / PNG / JPEG. Must be inside the configured allowed_roots.',
  },
}

/** 输出：一个区块（模型只能引用 block_id，不能引用数组下标）。 */
interface BlockValue {
  readonly block_id: string
  readonly kind: string
  readonly order: number
  readonly page: number
  readonly text: string
}

/** 输出：一条质量问题的投影（只留人/模型需要的字段）。 */
interface IssueValue {
  readonly code: string
  readonly severity: string
  readonly message: string
  readonly suggested_action: string
  readonly retryable: boolean
  readonly page: number
}

/** 输出：一条恢复步骤的投影。 */
interface StepValue {
  readonly step_id: string
  readonly action: string
  readonly role: string
  readonly blocking: boolean
  readonly status: string
  readonly codes: readonly string[]
  readonly problem: string
  readonly blocked_reason?: string
}

/** 输出：规范值。 */
interface DocumentReadValue {
  readonly path: string
  readonly media_type: string
  readonly reader_id: string
  readonly reader_version: string
  readonly asset_sha256: string
  readonly completeness: string
  readonly needs_visual: boolean
  readonly page_count: number
  readonly source_chars: number
  readonly text: string
  readonly blocks: readonly BlockValue[]
  readonly assessment: {
    readonly completeness: string
    readonly blocking: boolean
    /** 结构化用：版式/顺序/图片类问题不阻断（D-97 第一批）。 */
    readonly blocking_for_structure: boolean
    readonly blocking_codes: readonly string[]
    readonly soft_codes: readonly string[]
    readonly actions: readonly { action: string; codes: readonly string[]; blocking: boolean }[]
    readonly issues: readonly IssueValue[]
  }
  readonly recovery: {
    readonly plan_id: string
    readonly blocking: boolean
    readonly next: string
    readonly requires_model: boolean
    readonly model_image_support: string
    readonly vision_pages: readonly number[]
    readonly steps: readonly StepValue[]
    readonly notes: readonly string[]
  }
}

/** 规范输出 schema（只用官方强制子集；不用 type 数组、不用 null）。 */
const ISSUE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    severity: { type: 'string' },
    message: { type: 'string' },
    suggested_action: { type: 'string' },
    retryable: { type: 'boolean' },
    page: { type: 'number' },
  },
  required: ['code', 'severity', 'message', 'suggested_action', 'retryable', 'page'],
  additionalProperties: false,
}

const STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    step_id: { type: 'string' },
    action: { type: 'string' },
    role: { type: 'string' },
    blocking: { type: 'boolean' },
    status: { type: 'string' },
    codes: { type: 'array', items: { type: 'string' } },
    problem: { type: 'string' },
    blocked_reason: { type: 'string' },
  },
  required: ['step_id', 'action', 'role', 'blocking', 'status', 'codes', 'problem'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    media_type: { type: 'string' },
    reader_id: { type: 'string' },
    reader_version: { type: 'string' },
    asset_sha256: { type: 'string' },
    completeness: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    needs_visual: { type: 'boolean' },
    page_count: { type: 'number' },
    source_chars: { type: 'number' },
    text: { type: 'string' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          block_id: { type: 'string' },
          kind: { type: 'string' },
          order: { type: 'number' },
          page: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['block_id', 'kind', 'order', 'page', 'text'],
        additionalProperties: false,
      },
    },
    assessment: {
      type: 'object',
      properties: {
        completeness: { type: 'string' },
        blocking: { type: 'boolean' },
        blocking_for_structure: { type: 'boolean' },
        blocking_codes: { type: 'array', items: { type: 'string' } },
        soft_codes: { type: 'array', items: { type: 'string' } },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              codes: { type: 'array', items: { type: 'string' } },
              blocking: { type: 'boolean' },
            },
            required: ['action', 'codes', 'blocking'],
            additionalProperties: false,
          },
        },
        issues: { type: 'array', items: ISSUE_SCHEMA },
      },
      required: ['completeness', 'blocking', 'blocking_for_structure', 'blocking_codes', 'soft_codes', 'actions', 'issues'],
      additionalProperties: false,
    },
    recovery: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        blocking: { type: 'boolean' },
        next: { type: 'string' },
        requires_model: { type: 'boolean' },
        model_image_support: { type: 'string' },
        vision_pages: { type: 'array', items: { type: 'number' } },
        steps: { type: 'array', items: STEP_SCHEMA },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'plan_id', 'blocking', 'next', 'requires_model',
        'model_image_support', 'vision_pages', 'steps', 'notes',
      ],
      additionalProperties: false,
    },
  },
  required: [
    'path', 'media_type', 'reader_id', 'reader_version', 'asset_sha256', 'completeness',
    'needs_visual', 'page_count', 'source_chars', 'text', 'blocks', 'assessment', 'recovery',
  ],
  additionalProperties: false,
}

/**
 * 从定位器里取页码；没有页码（DOCX / 图片）返回 0。
 * @param locator - 契约里的定位器（PdfLocator | DocxLocator | ImageLocator）。
 * @returns 页码，取不到给 0。
 */
function pageOf(locator: unknown): number {
  if (typeof locator !== 'object' || locator === null) return 0
  const page = (locator as { page?: unknown }).page
  return typeof page === 'number' && Number.isFinite(page) ? page : 0
}

/**
 * 从 source_meta 里取页数；取不到时退回区块页码的最大值。
 * @param content - 规范内容。
 * @param sourceMeta - 读取器附加证据。
 * @returns 页数（至少 0）。
 */
function pageCountOf(content: DocumentContent, sourceMeta: Readonly<Record<string, unknown>>): number {
  const fromMeta = sourceMeta.page_count
  if (typeof fromMeta === 'number' && Number.isFinite(fromMeta)) return fromMeta
  let max = 0
  for (const block of content.blocks) {
    const page = pageOf(block.locator)
    if (page > max) max = page
  }
  return max
}

/**
 * 把读取器的错误映射成插件稳定错误码。
 * @param error - 任意错误。
 * @returns 不会返回（总是抛）。
 */
function rethrowAsToolError(error: unknown): never {
  if (isDocumentReadError(error)) {
    const mapped = error.code === 'INVALID_ARGS' || error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN'
      ? error.code
      : 'READER_FAILED'
    throw new RecruitmentToolError(
      mapped,
      JSON.stringify({ reason_code: error.code, message: error.message }),
    )
  }
  throw error
}

/**
 * 读一份文档并产出「内容 + 判定 + 恢复计划」。
 * @param filePath - 绝对路径。
 * @param cfg - converter 配置（allowed_roots 在这里生效）。
 * @returns 规范输出值。
 */
async function readOne(filePath: string, cfg: ResolvedConverterConfig): Promise<DocumentReadValue> {
  let outcome
  try {
    outcome = await readDocumentDetailed(filePath, cfg)
  } catch (error) {
    rethrowAsToolError(error)
  }
  const { content, source_meta } = outcome
  // 必须走 source_meta 旁路拿 facts，否则 PDF 会全部误判 doc_page_count_unverified（HARD）。
  const facts = readerFactsFromSourceMeta(source_meta)
  const assessment = assess(content, facts)
  const recovery = plan(content, { assessment, facts })

  return {
    path: filePath,
    media_type: content.media_type,
    reader_id: content.reader_id,
    reader_version: content.reader_version,
    asset_sha256: content.asset_sha256,
    completeness: content.completeness,
    needs_visual: content.needs_visual,
    page_count: pageCountOf(content, source_meta),
    source_chars: content.text.length,
    text: content.text,
    blocks: content.blocks.map((block) => ({
      block_id: block.block_id,
      kind: block.kind,
      order: block.order,
      page: pageOf(block.locator),
      text: block.text,
    })),
    assessment: {
      completeness: assessment.completeness,
      blocking: assessment.blocking,
      // D-97 第一批：**版式与顺序不阻断结构化**。
      // 模型的结构化能力只依赖文字本身；左右分栏的阅读顺序、图片有没有核过，
      // 不影响"把文字抽成字段"。这些留给第二批（版面分析 + 图片分类修好）再严格。
      // 真正阻断结构化的只有"文字本身不可用"：空文件、乱码、编码读不出。
      blocking_for_structure: STRUCTURE_BLOCKING_CODES.some((code) => assessment.blocking_codes.includes(code)),
      blocking_codes: [...assessment.blocking_codes],
      soft_codes: [...assessment.soft_codes],
      actions: assessment.actions.map((action) => ({
        action: action.action,
        codes: [...action.codes],
        blocking: action.blocking,
      })),
      issues: assessment.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        suggested_action: issue.suggested_action,
        retryable: issue.retryable,
        page: pageOf(issue.locator),
      })),
    },
    recovery: {
      plan_id: recovery.plan_id,
      blocking: recovery.blocking,
      next: recovery.next,
      requires_model: recovery.requires_model,
      model_image_support: recovery.model_image_support,
      vision_pages: [...recovery.vision],
      steps: recovery.steps.map((step) => {
        const base = {
          step_id: step.step_id,
          action: step.action,
          role: step.role,
          blocking: step.blocking,
          status: step.status,
          codes: [...step.codes],
          problem: step.problem,
        }
        return step.blocked_reason === null ? base : { ...base, blocked_reason: step.blocked_reason }
      }),
      notes: [...recovery.notes],
    },
  }
}

/**
 * 配置不完整时的替身：注册同一个工具名，调用即报 NOT_CONFIGURED。
 * @param issues - 缺失的配置项。
 * @returns 调用即抛错的工具定义。
 */
export function unconfiguredDocumentReadTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Read one local PDF/DOCX/PNG/JPEG into canonical content with a quality assessment and a '
      + `recovery plan. Currently NOT CONFIGURED: ${issues.join('; ')}. Calls return NOT_CONFIGURED.`,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${TOOL_NAME} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError('NOT_CONFIGURED', issues.join('; '))
    },
  }
}

/**
 * 造真实的多格式文档读取工具。
 * @param cfg - 已解析的 converter 配置。
 * @returns 工具定义。
 */
export function createDocumentReadTool(cfg: ResolvedConverterConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Read ONE local document (PDF, DOCX, PNG or JPEG) and return everything the next step needs: '
      + 'canonical content (text + blocks with stable block_id), a quality assessment, and a recovery plan. '
      + 'The reader is chosen by content sniffing, not by extension; a mismatch is reported as an issue. '
      + 'assessment.blocking=true means DO NOT proceed to trusted structuring / screening until the listed '
      + 'recovery steps are done; recovery.next says what comes next (structure | repair | human) and '
      + 'recovery.vision_pages lists pages that need an image read (do that with your own image tool, then '
      + 'call recruitment_model_text_merge). Unreadable input throws instead of returning a fake complete '
      + 'document. Read-only: it never writes the database and never calls a model.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as DocumentReadValue
        const lines: string[] = [
          `document ${v.media_type} via ${v.reader_id}@${v.reader_version} `
            + `(completeness=${v.completeness}, needs_visual=${String(v.needs_visual)}, `
            + `pages=${v.page_count}, chars=${v.source_chars}, blocks=${v.blocks.length})`,
          `  sha256=${v.asset_sha256.slice(0, 16)}…`,
          `assessment: blocking=${String(v.assessment.blocking)} completeness=${v.assessment.completeness}`,
        ]
        if (v.assessment.blocking_codes.length > 0) {
          lines.push(`  blocking codes: ${v.assessment.blocking_codes.join(', ')}`)
        }
        if (v.assessment.soft_codes.length > 0) {
          lines.push(`  soft codes: ${v.assessment.soft_codes.join(', ')}`)
        }
        for (const issue of v.assessment.issues) {
          const page = issue.page > 0 ? ` p${issue.page}` : ''
          lines.push(`  ISSUE ${issue.severity} ${issue.code}${page} -> ${issue.suggested_action}: ${issue.message}`)
        }
        lines.push(
          `recovery: next=${v.recovery.next} blocking=${String(v.recovery.blocking)} `
            + `steps=${v.recovery.steps.length} vision_pages=[${v.recovery.vision_pages.join(',')}]`,
        )
        for (const step of v.recovery.steps) {
          lines.push(`  STEP ${step.step_id} ${step.action}/${step.role} (${step.status}) ${step.problem}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const args = parseArgs(PARAMS, rawArgs)
      return await readOne(args.path as string, cfg)
    },
  }
}
