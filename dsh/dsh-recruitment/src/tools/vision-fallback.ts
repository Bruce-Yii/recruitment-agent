// recruitment_model_text_merge —— 把 agent 自己读出来的页面文字，校验后合并回转换结果。
//
// D-81 的落点：**读**由 agent 完成（它看 read_image 给的图），本工具只做两件事：
//   1. 用 converter/fallback/verify_model_text.py 现有规则做机械校验（空/短、元话语、
//      坏字形、□ 占比、输出包装、与原生文本的重合率……）——规则一行都不重写；
//   2. 通过后调 converter/fallback/merge.py 追加一个 provenance="model_read"、
//      location={page, bbox:null} 的 block —— 合并语义也不重写。
//
// 三条硬边界：
//   * **拒绝就不合并**：verify 的结论是唯一的准绳，本工具不提供"信心够高就跳过"的路径。
//   * **不复述原文**：拒绝记录只带稳定 code 与消息，绝不把 `text` 写进错误或描述
//     （可能是个资）。桥里对会携带文本片段的两条消息做了固定替换，见 fallback_bridge.py。
//   * **不改原生文本**：merge 只追加 block，`text` / `issues` / `needs_visual` 都不动；
//     清 needs_visual 是人的决定。
import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError, type RecruitmentErrorCode } from './errors.ts'
import { assertReadablePdf, ConverterPathError, type ResolvedConverterConfig } from './converter.ts'
import { bridgeFailure, runFallbackBridge } from './fallback-bridge.ts'

const PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 1024,
    description: 'Absolute path of the same resume PDF inside an allowed root that recruitment_page_image rendered.',
  },
  page: {
    kind: 'integer',
    required: true,
    min: 1,
    max: 10000,
    description: '1-based page number this transcription is about; it must match the page you looked at.',
  },
  text: {
    kind: 'string',
    required: true,
    maxLength: 20000,
    description:
      'Verbatim text you read from that page image. No commentary, no code fences, no '
      + '"here is the transcription" preamble — verification rejects those. Copy the page, do not summarise it.',
  },
}

/** 一条拒绝记录（没有 null，也没有原文）。 */
export interface Rejection {
  readonly code: string
  readonly message: string
}

/** 规范输出值。 */
export interface ModelTextMergeValue {
  /** true 表示真的追加了一个 model_read block。 */
  readonly accepted: boolean
  readonly rejections: readonly Rejection[]
  readonly blocks_before: number
  readonly blocks_after: number
}

const MAX_REJECTION_MESSAGE = 300

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    accepted: { type: 'boolean', description: 'True only when a model_read block was actually appended.' },
    rejections: {
      type: 'array',
      description: 'Why the reading was refused (empty when accepted). Codes are stable; messages never carry the text.',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['code', 'message'],
        additionalProperties: false,
      },
    },
    blocks_before: { type: 'integer', description: 'Content blocks before the merge.' },
    blocks_after: { type: 'integer', description: 'Content blocks after the merge (before + 1 when accepted).' },
  },
  required: ['accepted', 'rejections', 'blocks_before', 'blocks_after'],
  additionalProperties: false,
}

/** 读不到就返回 0：整型键缺失不该让整次调用 INVALID_TOOL_OUTPUT。 */
function integerOrZero(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : 0
}

/** 一条拒绝记录的防御性归一化：只要字符串，长度有界。 */
function toRejection(raw: unknown): Rejection {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const code = typeof record.code === 'string' && record.code !== '' ? record.code : 'UNKNOWN'
  const message = typeof record.message === 'string' ? record.message : ''
  return {
    code,
    message: message.length > MAX_REJECTION_MESSAGE ? `${message.slice(0, MAX_REJECTION_MESSAGE)}…` : message,
  }
}

/**
 * 桥返回 → 工具规范输出（纯映射，无 I/O，导出为测试用）。
 * @param merge - 桥返回的 `merge` 对象。
 * @returns 四个键齐全的规范值。
 * @throws RecruitmentToolError - 桥的返回自相矛盾（accepted=true 却带着拒绝）。
 */
export function toModelTextMergeValue(merge: Readonly<Record<string, unknown>>): ModelTextMergeValue {
  const accepted = merge.accepted === true
  const rawRejections = Array.isArray(merge.rejections) ? merge.rejections : []
  const rejections = rawRejections.map(toRejection)
  if (accepted && rejections.length > 0) {
    throw new RecruitmentToolError(
      'READER_FAILED',
      'merge reported accepted=true together with rejections; refusing to report a contradictory result',
    )
  }
  return {
    accepted,
    rejections: accepted ? [] : rejections,
    blocks_before: integerOrZero(merge.blocks_before),
    blocks_after: integerOrZero(merge.blocks_after),
  }
}

/**
 * 当前会话路由的模型标识。合并记录要靠它可审计（verify 的 MODEL_ID_MISSING 就是查这个）。
 * 读法与 DSH 自己的 read_image 一致：先看本次请求的 route config，再看 agent options。
 * @param exec - 工具执行上下文。
 * @returns 模型 id；解析不出来时返回空串（verify 会 fail-closed 拒掉）。
 */
export function routedModelId(exec: unknown): string {
  interface Routed {
    readonly provider?: unknown
    readonly model?: unknown
  }
  const agent = (exec as {
    agent?: {
      options?: Routed
      session?: { requestHeader?: () => { config?: Routed } | undefined }
    }
  } | undefined)?.agent
  let routed: Routed | undefined
  try {
    routed = agent?.session?.requestHeader?.()?.config
  } catch {
    routed = undefined
  }
  for (const candidate of [routed?.model, agent?.options?.model]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/** 造一个绑定配置的合并工具。 */
export function createModelTextMergeTool(cfg: ResolvedConverterConfig): ReadonlyToolDefinition {
  return {
    name: 'recruitment_model_text_merge',
    description:
      'Merge a transcription YOU produced from a page image (see recruitment_page_image + read_image) back '
      + 'into the converter result. The text is mechanically verified first (length, meta-discourse, bad '
      + 'glyphs, placeholder ratio, wrapper, overlap with the native text); a refused reading is NOT merged '
      + 'and the page stays needs_visual. On acceptance one block with provenance="model_read" and '
      + 'location={page, bbox:null} is appended; existing blocks, the body text, issues and needs_visual are '
      + 'left untouched. A page that already carries a model_read block inside the converter result is '
      + 'skipped as ALREADY_APPLIED; note that each call re-reads the PDF from disk and v1.0 stores no merged '
      + 'artifact, so two calls for the same page both report accepted. '
      + 'Returns {accepted, rejections[], blocks_before, blocks_after}.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as ModelTextMergeValue
        const lines = [
          `accepted=${String(v.accepted)} blocks ${v.blocks_before} -> ${v.blocks_after}`,
        ]
        if (v.accepted) {
          lines.push('a provenance="model_read" block was appended; the body text and needs_visual are unchanged.')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        lines.push('nothing was merged; the page keeps its previous state.')
        if (v.rejections.length === 0) lines.push('  (no rejection record was returned)')
        for (const rejection of v.rejections) lines.push(`  ${rejection.code}: ${rejection.message}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      // 本工具不持有跨调用状态：每次调用都是一个新子进程 + 一份新的转换结果。
      // 所以与兄弟调用并行不会互相污染；代价是同一页并行合并两次会各成功一次
      // （v1.0 不保存合并产物，没有"已合并"的持久事实可查）。
      return true
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      const args = parseArgs(PARAMS, rawArgs)
      const requested = args.path as string
      const page = args.page as number
      const text = args.text as string
      let realPath: string
      try {
        realPath = assertReadablePdf(requested, cfg)
      } catch (error) {
        if (error instanceof ConverterPathError) {
          // 类型口径修正：ConverterPathError.code 是 string，而 RecruitmentToolError 收
          // 封闭错误码。converter.ts 的 assertReadablePdf 只抛 'INVALID_ARGS' / 'NOT_FOUND'
          // / 'FORBIDDEN'，均是 RecruitmentErrorCode 成员；与同目录 page-image.ts 一致。
          // 仅补断言对齐真实运行时类型，不改 code / message / 行为。
          throw new RecruitmentToolError(error.code as RecruitmentErrorCode, error.message)
        }
        throw error
      }
      const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
      // 子进程超时预算里要给转换器留位置：桥内部先跑一次转换器读取（默认 45s），
      // 再合并。整体超时仍由 runFallbackBridge 的 cfg.timeout_ms 兜住。
      const readTimeoutSeconds = Math.max(5, Math.round(cfg.timeout_ms / 1000) - 8)
      let response: Record<string, unknown>
      try {
        response = await runFallbackBridge(
          cfg,
          { op: 'merge', pdf: realPath, page, text, model: routedModelId(exec), read_timeout: readTimeoutSeconds },
          signal,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new RecruitmentToolError('READER_FAILED', `merge failed: ${message}`)
      }
      if (response.ok !== true) throw bridgeFailure(response, 'merge')
      const merge = response.merge
      if (typeof merge !== 'object' || merge === null || Array.isArray(merge)) {
        throw new RecruitmentToolError('READER_FAILED', 'merge returned no merge record')
      }
      return toModelTextMergeValue(merge as Record<string, unknown>)
    },
  }
}

/**
 * 配置不完整时的替身：注册同一个工具名，调用即报 NOT_CONFIGURED。
 * @param issues - 缺了哪些配置项。
 */
export function unconfiguredModelTextMergeTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: 'recruitment_model_text_merge',
    description:
      'Merge a model transcription of a page image into the converter result. Currently NOT CONFIGURED: '
      + 'the plugin config is missing python_bin / converter_dir / allowed_roots. Calls return NOT_CONFIGURED.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `recruitment_model_text_merge is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError(
        'NOT_CONFIGURED',
        `model text merge is not configured: ${issues.join('; ')}`,
      )
    },
  }
}
