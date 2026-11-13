// 现有 converter 输出 → DocumentContent 的**无损**映射。
//
// 为什么需要这一层：U0 的契约必须证明「现有 PDF 读取路径不需要改就能装进新 schema」
// （docs/19 §2.1 约束：schema 是对 blocks/location/links/completeness/issues 的增量统一，
// 不要求 PDF/DOCX/图片都伪造 page+bbox）。本文件只做形状搬运与枚举归一，
// **不重新解析、不重新归一化文本、不改写任何坐标**。
//
// 三条硬规矩：
//   1. 文本逐字搬运。converter 已经做过它的归一化，这里再动一次就等于改原文证据。
//   2. 缺什么就留空，由 `validate.ts` 判非法 —— 绝不补一个看起来合理的值。
//      （唯一例外是 PDF 块没有 page 时写 `LOCATOR_PAGE_UNKNOWN` 哨兵，见 types.ts。）
//   3. 语料/证据的来源标注不猜测：块 provenance、issue 严重度都按台账搬运，
//      读不懂的取值原样保留，让校验器报出来。
//
// issue 严重度的权威在 Python 侧（`converter/src/issues.py`），不在本文件：
// 本文件是那张表的**镜像**，`test/document/converter-mapping.test.ts` 会起 Python
// 重新算一遍并逐 code 比对，Python 改了而这里没跟上就会红。
// 同一张表也决定了「未知 code 一律 HARD」这条保守规则（原文如此）。

import type {
  BBox,
  BlockKind,
  Completeness,
  DocumentBlock,
  DocumentContent,
  DocumentIssue,
  DocumentLink,
  EvidenceLocator,
  MediaType,
  Provenance,
  SuggestedAction,
} from './types.ts'
import { DOCUMENT_CONTENT_SCHEMA_VERSION, LOCATOR_PAGE_UNKNOWN, MEDIA_TYPES } from './types.ts'

/**
 * converter 输出的结构化镜像（字段与 `src/tools/converter.ts` 的 `ConverterOutput` 对齐，
 * 这里只声明映射用得到的部分）。
 *
 * 为什么不在契约层 `import type { ConverterOutput }`：
 * 本模块是纯形状搬运，**不依赖读取器怎么实现**；U1 的 DOCX/图片读取器只要产出同样形状
 * 就能复用同一套映射，不必把 PDF 胶水模块拖进来。字段名对不上会在
 * `test/document/converter-mapping.test.ts` 的真实 CLI 输出上立刻暴露。
 */
export interface ConverterLikeBlock {
  readonly kind?: string
  readonly text?: string
  readonly location?: { readonly page?: number; readonly bbox?: readonly number[] }
  readonly provenance?: string
  readonly links?: ReadonlyArray<{ readonly href?: string; readonly text?: string }>
}

export interface ConverterLikeIssue {
  readonly code?: string
  readonly message?: string
  readonly location?: { readonly page?: number; readonly bbox?: readonly number[] }
}

export interface ConverterLikeOutput {
  readonly text?: string
  readonly blocks?: readonly ConverterLikeBlock[]
  readonly completeness?: string
  readonly needs_visual?: boolean
  readonly issues?: readonly ConverterLikeIssue[]
  readonly meta?: {
    readonly source_sha256?: string
    readonly backend?: string
    readonly reader_version?: string
    readonly layout_backend?: string | null
  }
}

/** 映射参数。全部可选：缺省时如实留空（不编），由校验器判。 */
export interface MapOptions {
  /** 内容嗅探得到的媒体类型；PDF 快速路径默认 `application/pdf`。 */
  readonly media_type?: MediaType
  readonly reader_id?: string
  readonly reader_version?: string
  /** 覆盖 `meta.layout_backend`（读取器档位）。 */
  readonly reader_profile?: string
  /** 调用方测得的耗时；缺省 0 = 未测（运行字段，不参与一致性比较）。 */
  readonly elapsed_ms?: number
  readonly schema_version?: string
  /**
   * 调用方自己算出的原件 SHA-256。
   *
   * 为什么需要：读取失败时 converter 报 `source_sha256: null`（它连文件都没打开），
   * 但契约仍然要求「这份内容对应哪份原件」。这个值只能由**读过文件字节的调用方**给，
   * 不能在纯映射里编。给了就用它，没给才用 `meta.source_sha256`。
   */
  readonly asset_sha256?: string
}

/**
 * converter 块类型 → 契约块类型的**全函数**映射。
 *
 * `markdown` 是 converter 在「只拿到一段已渲染 Markdown、没有分块类型」时的兜底类型
 * （`converter/src/content.py` 的 `result()`）。它的类型信息不可恢复，所以归到 `other`
 * 而不是猜成 `paragraph`；文本仍然逐字保留。
 */
export const CONVERTER_BLOCK_KIND_MAP: Readonly<Record<string, BlockKind>> = {
  paragraph: 'paragraph',
  heading: 'heading',
  link: 'link',
  list: 'list',
  table: 'table',
  markdown: 'other',
  other: 'other',
}

/** 映射一个块类型；表外取值 → `other`（不猜，但记在文档里）。 */
export function mapBlockKind(kind: unknown): BlockKind {
  if (typeof kind !== 'string') return 'other'
  return CONVERTER_BLOCK_KIND_MAP[kind] ?? 'other'
}

// ---------------------------------------------------------------------------
// issue 严重度：converter/src/issues.py 的镜像
// ---------------------------------------------------------------------------

/** HARD code 集合（逐字抄自 `converter/src/issues.py` 的 `_HARD_ISSUE_CODES`）。 */
export const CONVERTER_HARD_ISSUE_CODES: readonly string[] = [
  'unread_visual_page',
  'pdf_no_text',
  'pdf_text_encoding_unread',
  'reader_timeout',
  'reader_failed',
  'no_reader',
  'office_backend_unavailable',
  'epub_embedded_image_unread',
  'missing_word_part',
  'missing_word_note',
  'unread_word_object',
  'encrypted_pdf',
  'pdf_layout_unread',
  'text_decode_unread',
  'fetch_failed',
  'source_changed_during_read',
  'structure_unidentified',
  'pdf_reading_order_unverified',
  'pdf_damaged_repaired',
  'resume_field_unreadable',
  'resume_experience_cross_block',
  'platform_noise_inline_unresolved',
]

/** SOFT code 前缀（逐字抄自 `converter/src/issues.py` 的 `_SOFT_ISSUE_PREFIXES`）。 */
export const CONVERTER_SOFT_ISSUE_PREFIXES: readonly string[] = [
  'unverified_',
  'html_',
  'display_relation_',
  'display_entry_',
  'pdf_reading_order_',
  'markdown_page_context_',
]

/** 已登记的 SOFT code（逐字抄自 `converter/src/issues.py` 的 `ADDED_CODES` 中 soft 项）。 */
export const CONVERTER_SOFT_ISSUE_CODES: readonly string[] = [
  'resume_timeline_gap',
  'resume_timeline_overlap',
  'resume_timeline_inversion',
  'resume_timeline_unparsed',
  'resume_attribution_unverified',
  'platform_noise_excluded',
  'pdf_page_empty',
  'resume_protected_attribute_present',
  'resume_ocr_heading_inserted',
]

/**
 * 复刻 `issues.py::issue_severity()` 的判定顺序：HARD 集合 → SOFT 前缀 → 已登记 SOFT
 * → **未知一律 HARD**。顺序必须一致，`pdf_reading_order_unverified` 就是靠「先查 HARD 集合」
 * 才没被 `pdf_reading_order_` 前缀降级。
 * @param code - issue code（空串视为「没有 code」，与 Python 一致不报 HARD）。
 */
export function converterIssueSeverity(code: string | undefined): 'HARD' | 'SOFT' {
  const value = typeof code === 'string' ? code : ''
  if (value === '') return 'SOFT'
  if (CONVERTER_HARD_ISSUE_CODES.includes(value)) return 'HARD'
  if (CONVERTER_SOFT_ISSUE_PREFIXES.some((prefix) => value.startsWith(prefix))) return 'SOFT'
  if (CONVERTER_SOFT_ISSUE_CODES.includes(value)) return 'SOFT'
  return 'HARD'
}

/** 硬 code 的动作台账（soft 一律 `none`，见 `converterIssueAction`）。 */
const HARD_ISSUE_ACTIONS: Readonly<Record<string, { readonly retryable: boolean; readonly suggested_action: SuggestedAction }>> = {
  // 基础设施失败：同一读取器重试一次可能变好。
  reader_timeout: { retryable: true, suggested_action: 'retry' },
  reader_failed: { retryable: true, suggested_action: 'retry' },
  fetch_failed: { retryable: true, suggested_action: 'retry' },
  source_changed_during_read: { retryable: true, suggested_action: 'retry' },
  office_backend_unavailable: { retryable: true, suggested_action: 'retry' },
  // 没有原生文字 / 有未读视觉内容：该上视觉读取，不是重试。
  pdf_no_text: { retryable: false, suggested_action: 'vision_read' },
  unread_visual_page: { retryable: false, suggested_action: 'vision_read' },
  epub_embedded_image_unread: { retryable: false, suggested_action: 'vision_read' },
  // 版式/编码/顺序问题：换读取器，重试同一个读取器没有意义。
  pdf_layout_unread: { retryable: false, suggested_action: 'switch_reader' },
  pdf_reading_order_unverified: { retryable: false, suggested_action: 'switch_reader' },
  pdf_text_encoding_unread: { retryable: false, suggested_action: 'switch_reader' },
  text_decode_unread: { retryable: false, suggested_action: 'switch_reader' },
  pdf_damaged_repaired: { retryable: false, suggested_action: 'switch_reader' },
  no_reader: { retryable: false, suggested_action: 'switch_reader' },
  // 只能由人确认的：加密、缺部件、结构不可识别、字段读不出、跨块归属、平台噪声同块。
  encrypted_pdf: { retryable: false, suggested_action: 'human_review' },
  missing_word_part: { retryable: false, suggested_action: 'human_review' },
  missing_word_note: { retryable: false, suggested_action: 'human_review' },
  unread_word_object: { retryable: false, suggested_action: 'human_review' },
  structure_unidentified: { retryable: false, suggested_action: 'human_review' },
  resume_field_unreadable: { retryable: false, suggested_action: 'human_review' },
  resume_experience_cross_block: { retryable: false, suggested_action: 'human_review' },
  platform_noise_inline_unresolved: { retryable: false, suggested_action: 'human_review' },
}

/** 未知 code 的兜底动作：与「未知一律 HARD」同口径，交给人工，不自动重试。 */
export const UNKNOWN_ISSUE_ACTION = { retryable: false, suggested_action: 'human_review' } as const

/**
 * 一条 issue 该做什么。
 * 规则（两条，可机械检查）：soft ⇒ `none`；hard ⇒ 查台账，查不到就 `human_review`。
 * @param code - issue code。
 */
export function converterIssueAction(code: string | undefined): { readonly retryable: boolean; readonly suggested_action: SuggestedAction } {
  if (converterIssueSeverity(code) === 'SOFT') return { retryable: false, suggested_action: 'none' }
  const value = typeof code === 'string' ? code : ''
  const known = HARD_ISSUE_ACTIONS[value]
  if (known !== undefined) return known
  return UNKNOWN_ISSUE_ACTION
}

// ---------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------

/** converter 顶层键里「被 carry 进 DocumentContent」的。 */
export const CONVERTER_KEYS_CARRIED: readonly string[] = ['text', 'blocks', 'completeness', 'needs_visual', 'issues', 'meta']

/**
 * converter 顶层键里**刻意不 carry** 的，以及理由。
 *
 * 它们不是被丢掉就消失：`fields` / `screening` / `protected_attributes` / `timeline` 是
 * **结构化层**的产物（U3 之后由 structure 层消费），`title` / `chars` / `warnings` /
 * `links`（顶层是块内链接的并集，块内已保留）/ `noise` / `pending_reads` 是读取器诊断，
 * 不属于「一份文档被读成了什么」。留这张表是为了让「多出一个键」变成一次有意识的决定。
 */
export const CONVERTER_KEYS_NOT_CARRIED: Readonly<Record<string, string>> = {
  title: 'reader heuristic (first heading guess); not part of the content contract',
  chars: 'derived count; recomputable from text',
  warnings: 'reader diagnostics, not content',
  links: 'union of block links; every link is kept inside its block',
  fields: 'structured layer (business fields), owned by the structure stage',
  noise: 'reader diagnostics (platform watermark detection)',
  protected_attributes: 'structured layer; must never enter screening features',
  screening: 'structured layer',
  timeline: 'structured layer',
  pending_reads: 'batch/recovery bookkeeping',
}

/** `meta` 里被 carry 的键。 */
export const CONVERTER_META_KEYS_CARRIED: readonly string[] = ['source_sha256', 'backend', 'reader_version', 'layout_backend']

/** `meta` 里刻意不 carry 的键。 */
export const CONVERTER_META_KEYS_NOT_CARRIED: Readonly<Record<string, string>> = {
  pages: 'page count is reader metadata; the contract locates blocks, not documents',
  source_name: 'a file name is not identity (docs/19 §2.1: paths are not business identity)',
  page_info: 'per-page diagnostics (chars/images/coverage)',
  order_verified: 'reader diagnostic',
  repaired: 'reader diagnostic',
  ocr: 'reader diagnostic',
  noise_blocks: 'reader diagnostic',
  encoding_removed_chars: 'reader diagnostic',
  timed_out: 'reader diagnostic (already an issue when it matters)',
  failed: 'reader diagnostic (already an issue when it matters)',
}

/** 4 个有限数的 bbox，否则 undefined（不裁剪、不排序、不换算）。 */
function asBBox(raw: unknown): BBox | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined
  const [x0, y0, x1, y1] = raw as unknown[]
  for (const v of [x0, y0, x1, y1]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  }
  return [x0 as number, y0 as number, x1 as number, y1 as number]
}

/**
 * 读取器给的页码是否可用（1-based 整数）。
 *
 * 现有 converter 会输出 `location: {page: null, bbox: null}`（例如
 * `resume_field_unreadable`），所以「有 location 对象」不等于「有页码」。
 */
function usablePage(location: { readonly page?: number } | undefined): number | undefined {
  const page = location?.page
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return undefined
  return page
}

/**
 * converter 的 `location` → PDF 定位。
 *
 * * 有合法页码（≥1）→ `{kind:"pdf", page, bbox?, block_id}`，bbox 仅在读取器给了 4 个数时出现；
 * * 没有页码 → `{kind:"pdf", page: LOCATOR_PAGE_UNKNOWN}` 哨兵。**不编页码**，
 *   校验器会把它判成 `LOCATOR_INVALID`，所以这种 content 进不了下游。
 * @param location - converter 块/issue 的 location。
 * @param readerBlockIndex - 该块在读取器输出数组里的下标（0-based，原样作为 `block_id`）。
 */
export function mapPdfLocator(
  location: { readonly page?: number; readonly bbox?: readonly number[] } | undefined,
  readerBlockIndex?: number,
): EvidenceLocator {
  const page = location?.page
  const blockId = readerBlockIndex === undefined ? undefined : String(readerBlockIndex)
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
    // 没页码：留哨兵，让校验器拦住；不伪造一个真实页码。
    const sentinel: EvidenceLocator = { kind: 'pdf', page: LOCATOR_PAGE_UNKNOWN }
    return sentinel
  }
  const bbox = asBBox(location?.bbox)
  if (bbox === undefined) {
    return blockId === undefined ? { kind: 'pdf', page } : { kind: 'pdf', page, block_id: blockId }
  }
  return blockId === undefined
    ? { kind: 'pdf', page, bbox }
    : { kind: 'pdf', page, bbox, block_id: blockId }
}

/** 块内链接：文本与 href 逐字搬运（缺就留空串，由校验器判）。 */
function mapLinks(links: ConverterLikeBlock['links']): DocumentLink[] | undefined {
  if (!Array.isArray(links) || links.length === 0) return undefined
  return links.map((link) => ({
    text: typeof link?.text === 'string' ? link.text : '',
    href: typeof link?.href === 'string' ? link.href : '',
  }))
}

/**
 * 把 converter 输出映射成 DocumentContent。
 *
 * **纯函数**：不改入参、不读文件、不取时间。
 * 「无损」指 docs/19 §2.1 列出的那五类（blocks / location / links / completeness / issues）
 * 加原件 SHA 与读取器身份；其余键的去处见 `CONVERTER_KEYS_NOT_CARRIED`。
 * `auditConverterMapping()` 是可以跑起来的证明。
 * @param output - `python -m src.cli <pdf> --no-isolation` 的 JSON（或同形状的任何读取器输出）。
 * @param options - 媒体类型 / 读取器身份 / 耗时覆盖。
 */
export function mapConverterToDocumentContent(output: ConverterLikeOutput, options: MapOptions = {}): DocumentContent {
  const meta = output.meta ?? {}
  const rawBlocks = Array.isArray(output.blocks) ? output.blocks : []
  const blocks: DocumentBlock[] = rawBlocks.map((raw, index) => {
    const block: DocumentBlock = {
      block_id: `b${index + 1}`,
      kind: mapBlockKind(raw?.kind),
      text: typeof raw?.text === 'string' ? raw.text : '',
      order: index,
      locator: mapPdfLocator(raw?.location, index),
      // 枚举外的 provenance 原样保留（不猜成 native_text），由校验器报 PROVENANCE_INVALID。
      provenance: (typeof raw?.provenance === 'string' ? raw.provenance : '') as Provenance,
    }
    const links = mapLinks(raw?.links)
    return links === undefined ? block : { ...block, links }
  })

  const rawIssues = Array.isArray(output.issues) ? output.issues : []
  const issues: DocumentIssue[] = rawIssues.map((raw) => {
    const code = typeof raw?.code === 'string' ? raw.code : ''
    const action = converterIssueAction(code)
    const issue: DocumentIssue = {
      code,
      message: typeof raw?.message === 'string' ? raw.message : '',
      severity: converterIssueSeverity(code),
      retryable: action.retryable,
      suggested_action: action.suggested_action,
    }
    // issue 的 locator 在契约里是**可选**的，所以这里和块不一样：
    // 读取器只说「有问题」而没给页码时，就**不挂 locator**，而不是挂一个 0 页哨兵。
    // （块必须挂：block.locator 是必填，缺页码必须被校验器看见。）
    if (usablePage(raw?.location) !== undefined) return { ...issue, locator: mapPdfLocator(raw.location) }
    return issue
  })

  const mediaType = options.media_type ?? 'application/pdf'
  const readerId = options.reader_id ?? (typeof meta.backend === 'string' ? meta.backend : '')
  const readerVersion = options.reader_version ?? (typeof meta.reader_version === 'string' ? meta.reader_version : '')
  const profile = options.reader_profile ?? (typeof meta.layout_backend === 'string' ? meta.layout_backend : undefined)
  const assetSha = options.asset_sha256 ?? (typeof meta.source_sha256 === 'string' ? meta.source_sha256 : '')

  const content: DocumentContent = {
    schema_version: options.schema_version ?? DOCUMENT_CONTENT_SCHEMA_VERSION,
    asset_sha256: assetSha,
    media_type: mediaType,
    reader_id: readerId,
    reader_version: readerVersion,
    text: typeof output.text === 'string' ? output.text : '',
    blocks,
    completeness: (typeof output.completeness === 'string' ? output.completeness : 'unverified') as Completeness,
    needs_visual: output.needs_visual === true,
    issues,
    elapsed_ms: typeof options.elapsed_ms === 'number' ? options.elapsed_ms : 0,
  }
  if (profile === undefined) return content
  return { ...content, reader_profile: profile }
}

// ---------------------------------------------------------------------------
// 映射审计（可执行的「无损」证明）
// ---------------------------------------------------------------------------

/** 一条映射审计结论。 */
export interface MappingAudit {
  readonly ok: boolean
  /** 任何一处不一致（空数组 = 无损）。 */
  readonly problems: readonly string[]
  readonly counts: {
    readonly blocks: number
    readonly links: number
    readonly issues: number
    readonly hard_issues: number
    readonly soft_issues: number
  }
}

/** 逐值比较（只用于审计，比较的是「搬运是否忠实」，不是业务正确性）。 */
function firstDifference(actual: readonly number[], expected: readonly number[] | undefined): boolean {
  if (expected === undefined) return true
  if (actual.length !== expected.length) return true
  return actual.some((value, i) => value !== expected[i])
}

/**
 * 审计「converter 输出 → DocumentContent」有没有丢东西。
 *
 * 逐项核对：块数、每块文本/类型/顺序/页码/bbox/链接/provenance、issue 数/每条 code+message+严重度、
 * 全篇 text、completeness、needs_visual、原件 SHA、读取器身份。
 * @param output - 喂给 `mapConverterToDocumentContent` 的同一份原始输出。
 * @param content - 映射结果。
 * @returns ok + problems（不抛异常）。
 */
export function auditConverterMapping(output: ConverterLikeOutput, content: DocumentContent): MappingAudit {
  const problems: string[] = []
  const rawBlocks = Array.isArray(output.blocks) ? output.blocks : []
  const rawIssues = Array.isArray(output.issues) ? output.issues : []

  if (content.media_type !== 'application/pdf') {
    // 本审计只认 PDF 快速路径的映射（DOCX / 图片走各自的读取器，不经过这个函数）。
    // 与其给出一个「看起来通过了」的结论，不如直接说它不适用。
    return {
      ok: false,
      problems: [`audit only covers PDF mappings, got media_type ${JSON.stringify(content.media_type)}`],
      counts: { blocks: content.blocks.length, links: 0, issues: content.issues.length, hard_issues: 0, soft_issues: 0 },
    }
  }

  if (content.blocks.length !== rawBlocks.length) {
    problems.push(`blocks: mapped ${content.blocks.length}, reader returned ${rawBlocks.length}`)
  }
  for (let i = 0; i < Math.min(content.blocks.length, rawBlocks.length); i += 1) {
    const mapped = content.blocks[i] as DocumentBlock
    const raw = rawBlocks[i] as ConverterLikeBlock
    const at = `blocks[${i}]`
    const expectedText = typeof raw.text === 'string' ? raw.text : ''
    if (mapped.text !== expectedText) problems.push(`${at}.text differs from the reader output`)
    if (mapped.order !== i) problems.push(`${at}.order is ${mapped.order}, expected ${i}`)
    const expectedKind = mapBlockKind(raw.kind)
    if (mapped.kind !== expectedKind) problems.push(`${at}.kind is ${mapped.kind}, expected ${expectedKind}`)
    const expectedProvenance = typeof raw.provenance === 'string' ? raw.provenance : ''
    if (mapped.provenance !== expectedProvenance) problems.push(`${at}.provenance is ${JSON.stringify(mapped.provenance)}, expected ${JSON.stringify(expectedProvenance)}`)
    const page = raw.location?.page
    const mappedPage = mapped.locator.kind === 'pdf' ? mapped.locator.page : undefined
    const expectedPage = typeof page === 'number' ? page : LOCATOR_PAGE_UNKNOWN
    if (mappedPage !== expectedPage) problems.push(`${at}.locator.page is ${String(mappedPage)}, expected ${expectedPage}`)
    if (mapped.locator.kind === 'pdf') {
      const mappedBBox = mapped.locator.bbox
      const expectedBBox = raw.location?.bbox
      if (mappedBBox === undefined) {
        if (asBBox(expectedBBox) !== undefined) problems.push(`${at}.locator.bbox missing but the reader returned 4 numbers`)
      } else if (firstDifference(mappedBBox, expectedBBox)) {
        problems.push(`${at}.locator.bbox differs from the reader output`)
      }
    }
    const mappedLinks = mapped.links ?? []
    const expectedLinks = Array.isArray(raw.links) ? raw.links : []
    if (mappedLinks.length !== expectedLinks.length) {
      problems.push(`${at}.links: mapped ${mappedLinks.length}, reader returned ${expectedLinks.length}`)
    }
    for (let j = 0; j < Math.min(mappedLinks.length, expectedLinks.length); j += 1) {
      const link = mappedLinks[j] as DocumentLink
      const rawLink = expectedLinks[j] ?? {}
      if (link.text !== (typeof rawLink.text === 'string' ? rawLink.text : '')) problems.push(`${at}.links[${j}].text differs`)
      if (link.href !== (typeof rawLink.href === 'string' ? rawLink.href : '')) problems.push(`${at}.links[${j}].href differs`)
    }
  }

  if (content.issues.length !== rawIssues.length) {
    problems.push(`issues: mapped ${content.issues.length}, reader returned ${rawIssues.length}`)
  }
  for (let i = 0; i < Math.min(content.issues.length, rawIssues.length); i += 1) {
    const mapped = content.issues[i] as DocumentIssue
    const raw = rawIssues[i] as ConverterLikeIssue
    const at = `issues[${i}]`
    if (mapped.code !== (typeof raw.code === 'string' ? raw.code : '')) problems.push(`${at}.code differs`)
    if (mapped.message !== (typeof raw.message === 'string' ? raw.message : '')) problems.push(`${at}.message differs`)
    const expectedSeverity = converterIssueSeverity(raw.code)
    if (mapped.severity !== expectedSeverity) problems.push(`${at}.severity is ${mapped.severity}, expected ${expectedSeverity} for code ${JSON.stringify(raw.code)}`)
    const expectedPage = usablePage(raw.location)
    if (expectedPage !== undefined) {
      const locator = mapped.locator
      if (locator === undefined) {
        problems.push(`${at}.locator missing but the reader reported page ${expectedPage}`)
      } else if (locator.kind !== 'pdf' || locator.page !== expectedPage) {
        problems.push(`${at}.locator.page differs from the reader output`)
      } else if (locator.bbox === undefined) {
        if (asBBox(raw.location?.bbox) !== undefined) problems.push(`${at}.locator.bbox missing but the reader returned 4 numbers`)
      } else if (firstDifference(locator.bbox, raw.location?.bbox)) {
        problems.push(`${at}.locator.bbox differs from the reader output`)
      }
    } else if (mapped.locator !== undefined) {
      problems.push(`${at}.locator is set although the reader location has no usable page`)
    }
  }

  const expectedText = typeof output.text === 'string' ? output.text : ''
  if (content.text !== expectedText) problems.push('text differs from the reader output')
  const expectedCompleteness = typeof output.completeness === 'string' ? output.completeness : 'unverified'
  if (content.completeness !== expectedCompleteness) problems.push(`completeness is ${content.completeness}, expected ${expectedCompleteness}`)
  if (content.needs_visual !== (output.needs_visual === true)) problems.push('needs_visual differs from the reader output')

  const sha = output.meta?.source_sha256
  if (typeof sha === 'string') {
    if (content.asset_sha256.toLowerCase() !== sha.toLowerCase()) problems.push('asset_sha256 differs from meta.source_sha256')
  }
  // 读取失败时 converter 报 source_sha256: null，SHA 由调用方（读过字节的一方）经
  // MapOptions.asset_sha256 传入；审计看不到那个入参，因此这里不判「为空」。
  const backend = typeof output.meta?.backend === 'string' ? output.meta.backend : ''
  if (content.reader_id !== backend) problems.push(`reader_id is ${JSON.stringify(content.reader_id)}, expected ${JSON.stringify(backend)}`)
  const readerVersion = typeof output.meta?.reader_version === 'string' ? output.meta.reader_version : ''
  if (content.reader_version !== readerVersion) problems.push(`reader_version is ${JSON.stringify(content.reader_version)}, expected ${JSON.stringify(readerVersion)}`)
  if (content.media_type !== undefined && !(MEDIA_TYPES as readonly string[]).includes(content.media_type)) {
    problems.push(`media_type ${JSON.stringify(content.media_type)} is not a contract media type`)
  }

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      blocks: content.blocks.length,
      links: content.blocks.reduce((sum, block) => sum + (block.links?.length ?? 0), 0),
      issues: content.issues.length,
      hard_issues: content.issues.filter((issue) => issue.severity === 'HARD').length,
      soft_issues: content.issues.filter((issue) => issue.severity === 'SOFT').length,
    },
  }
}
