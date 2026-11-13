// 六个派生检查：不依赖上游「自报合格」，自己从内容里算证据。
//
// 每个检查只做一件事，返回 `AssessmentIssue[]`。所有 issue 的
// severity/retryable/suggested_action 都来自 `issue-codes.ts` 的稳定表，
// 这里不写死严重度。
//
// 覆盖的 6 类（docs/19 §2.2 / §3 U2 行）：
//   1. 页/块覆盖缺失      -> doc_block_missing / doc_page_count_unverified / doc_page_coverage_missing
//   2. 字符保真失败        -> doc_char_fidelity_mismatch（+ doc_unreadable_glyph_in_body）
//   3. URI 丢失或凭空生成  -> doc_uri_lost / doc_uri_fabricated
//   4. 阅读顺序不可靠      -> doc_reading_order_unverified
//   5. 跨块错配            -> doc_cross_block_attribution
//   6. 来源未核            -> doc_provenance_unverified / doc_identity_from_unverified_source

import { lookupIssueCode } from './issue-codes.ts'
import { locatorKey, locatorPage, nonWhitespaceChars } from './normalize.ts'
import type {
  AssessmentIssue,
  EvidenceLocator,
  IssueSeverity,
  NormalizedBlock,
  NormalizedContent,
  RawIssue,
  SuggestedAction,
} from './types.ts'

/** 整份材料读不出来时，不再逐页报覆盖（否则一个加密 PDF 会刷出 N 条噪声）。 */
export const DOCUMENT_LEVEL_UNREAD = new Set([
  'encrypted_pdf',
  'reader_failed',
  'reader_timeout',
  'pdf_no_text',
  'no_reader',
  'reader_unverified',
])

/** 允许出现在「已核来源」里的 provenance。docling 是文本层解析器，不是模型生成。 */
export const VERIFIED_PROVENANCE = new Set(['native_text', 'human_confirmed', 'docling'])

const ORG_TOKENS = /公司|集团|科技|技术有限|有限(?:责任)?公司|股份|大学|学院|学校|研究院|研究所|医院|银行|中心|事务所|工作室|事业部|Ltd\.?|Limited|Inc\.?|LLC|Corp\.?|Group|Technolog|University|College|Institute|Hospital|Bank|Company|Co\.|GmbH/iu
const ROLE_TOKENS = /工程师|经理|主管|总监|专员|架构师|设计师|分析师|顾问|实习生|助理|负责人|组长|开发|研发|运营|产品|测试|前端|后端|全栈|engineer|manager|director|developer|designer|analyst|architect|intern|lead|specialist|consultant/iu
const DATE_RANGE = [
  // 2021.07 - 2024.06 / 2021-07—2024-06 / 2021年7月 至 2024年6月 / Jul 2020 – Jun 2023
  /(?:19|20)\d{2}\s*(?:[.\-/年]\s*\d{1,2}\s*月?)?\s*[-–—~～]\s*(?:(?:19|20)\d{2}|至今|现在|present|now|今)/iu,
  /(?:19|20)\d{2}\s*(?:[.\-/年]\s*\d{1,2}\s*月?)?\s*(?:至|到)\s*(?:(?:19|20)\d{2}|今|现在|present|now)/iu,
  /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s*(?:19|20)\d{2}\s*[-–—~]\s*/iu,
]
const IDENTITY_TOKENS = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
  /(?:\+?86[-\s]?)?1[3-9]\d{9}\b/u,
  /\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/u,
  /(?:姓\s*名|名字|Name)\s*[:：]/iu,
]

export function buildIssue(
  code: string,
  message: string,
  locator: EvidenceLocator | null,
  options: {
    readonly locators?: ReadonlyArray<EvidenceLocator>
    readonly severity?: IssueSeverity
    readonly suggested_action?: SuggestedAction
    readonly retryable?: boolean
  } = {},
): AssessmentIssue {
  const { spec, registered } = lookupIssueCode(code)
  const locators = options.locators ?? (locator === null ? [] : [locator])
  const severity = options.severity === 'HARD' ? 'HARD' : spec.severity
  return {
    code,
    message,
    locator,
    locators,
    severity,
    retryable: options.retryable ?? spec.retryable,
    suggested_action: options.suggested_action ?? spec.suggested_action,
    registered,
    origin: registered ? spec.origin : 'unregistered',
    family: spec.family,
  }
}

export function hasDateRange(text: string): boolean {
  return DATE_RANGE.some((pattern) => pattern.test(text))
}

export function hasOrgToken(text: string): boolean {
  return ORG_TOKENS.test(text)
}

export function hasRoleToken(text: string): boolean {
  return ROLE_TOKENS.test(text)
}

export function hasIdentityTokens(text: string): boolean {
  return IDENTITY_TOKENS.some((pattern) => pattern.test(text))
}

/** 两个 bbox 是否在同一「可视行」：垂直重叠 ≥ 较矮者高度的一半。 */
function sameVisualRow(a: EvidenceLocator | null, b: EvidenceLocator | null): boolean {
  if (a === null || b === null || a.kind !== 'pdf' || b.kind !== 'pdf') return false
  if (a.page !== b.page || a.bbox === undefined || b.bbox === undefined) return false
  const overlap = Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1])
  const minHeight = Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1])
  return minHeight > 0 && overlap >= 0.5 * minHeight
}

function mediaKind(mediaType: string): 'pdf' | 'docx' | 'image' | 'unknown' {
  if (mediaType === 'application/pdf' || mediaType.endsWith('/pdf')) return 'pdf'
  if (mediaType.includes('wordprocessingml')) return 'docx'
  if (mediaType.startsWith('image/')) return 'image'
  return 'unknown'
}

export interface CheckContext {
  readonly content: NormalizedContent
  /** 上游已带的 code（用于避免重复报同一事实）。 */
  readonly inheritedCodes: ReadonlySet<string>
  /** 整份读不出：跳过分页覆盖，避免噪声（HARD 已由上游 issue 兜住）。 */
  readonly documentLevelUnread: boolean
}

/** 0. 契约与媒体：输入不合格就不许继续判「合格」。 */
export function checkContract(ctx: CheckContext): AssessmentIssue[] {
  const out: AssessmentIssue[] = []
  if (!ctx.content.present) {
    out.push(buildIssue('doc_contract_invalid', ctx.content.contract_problems.join('；') || 'content 不合法', null))
    return out
  }
  if (ctx.content.contract_problems.length > 0) {
    out.push(buildIssue('doc_contract_invalid', ctx.content.contract_problems.join('；'), null))
  }
  if (mediaKind(ctx.content.media_type) === 'unknown') {
    out.push(buildIssue(
      'doc_media_unsupported',
      `media_type 为 ${ctx.content.media_type || '(空)'}，不在 docs/19 §2.1 闭集内`,
      null,
    ))
  }
  return out
}

/** 1. 页/块覆盖缺失。 */
export function checkCoverage(ctx: CheckContext): AssessmentIssue[] {
  const content = ctx.content
  const out: AssessmentIssue[] = []
  if (content.blocks.length === 0) {
    out.push(buildIssue(
      'doc_block_missing',
      content.text.trim() === ''
        ? '整份材料没有任何 block（也没有正文）'
        : '正文存在但没有任何 block（无法建立可追溯定位）',
      null,
    ))
    return out
  }
  if (ctx.documentLevelUnread) return out
  const kind = mediaKind(content.media_type)
  if (kind !== 'pdf') return out
  if (content.page_count === null) {
    out.push(buildIssue('doc_page_count_unverified', '分页材料没有页数，无法核对页覆盖', null))
    return out
  }
  const pageLocated = content.blocks.filter((block) => locatorPage(block.locator) !== null)
  if (pageLocated.length === 0) {
    out.push(buildIssue(
      'doc_page_coverage_missing',
      `${content.page_count} 页的材料里没有任何块带页号定位，页覆盖无法核对`,
      null,
    ))
    return out
  }
  const pagesWithBlock = new Set<number>()
  for (const block of pageLocated) {
    const page = locatorPage(block.locator)
    if (page !== null) pagesWithBlock.add(page)
  }
  const pagesWithIssue = new Set<number>()
  for (const raw of content.issues) {
    const page = locatorPage(extractLocator(raw))
    if (page !== null) pagesWithIssue.add(page)
  }
  for (const info of content.page_info) {
    if (info.block_count === 0 && info.chars !== null && info.chars > 0) {
      // 有字符但 0 块：页级别读失败，必须当 HARD（不是空页）。
      pagesWithIssue.add(info.page)
    }
  }
  for (let page = 1; page <= content.page_count; page += 1) {
    if (pagesWithBlock.has(page) || pagesWithIssue.has(page)) continue
    out.push(buildIssue(
      'doc_page_coverage_missing',
      `第 ${page} 页既没有 block，也没有 issue 记录（该页在输出里消失了）`,
      { kind: 'pdf', page },
    ))
  }
  return out
}

/** 2. 字符保真：正文 == 块文本；有原生字符数 oracle 时再对一次。 */
export function checkCharFidelity(ctx: CheckContext): AssessmentIssue[] {
  const content = ctx.content
  if (content.blocks.length === 0) return []
  const textChars = nonWhitespaceChars(content.text)
  const blockChars = content.blocks.reduce((sum, block) => sum + nonWhitespaceChars(block.text), 0)
  const reasons: string[] = []
  if (textChars !== blockChars) {
    reasons.push(`正文非空白字符 ${textChars}，块文本合计 ${blockChars}`)
  }
  if (content.source_chars !== null && content.source_chars !== textChars) {
    reasons.push(`原生文本非空白字符 ${content.source_chars}，输出正文 ${textChars}`)
  }
  if (reasons.length === 0) return []
  return [buildIssue('doc_char_fidelity_mismatch', `字符保真失败：${reasons.join('；')}`, null)]
}

/** 2b. 坏字形不得进正文（docs/11 A6）。 */
export function checkUnreadableGlyphs(ctx: CheckContext): AssessmentIssue[] {
  const offenders = ctx.content.blocks.filter((block) => block.unreadable_markers > 0)
  if (offenders.length === 0) return []
  const total = offenders.reduce((sum, block) => sum + block.unreadable_markers, 0)
  const locators = offenders
    .map((block) => block.locator)
    .filter((locator): locator is EvidenceLocator => locator !== null)
  return [buildIssue(
    'doc_unreadable_glyph_in_body',
    `正文里有 ${total} 个坏字形/不可读标记（U+FFFD、(cid:N) 或控制字符），出现在 ${offenders.length} 个块`,
    locators[0] ?? null,
    { locators },
  )]
}

/** 3. URI 丢失或凭空生成。没有原件 URI 清单时不做结论（不猜）。 */
export function checkUris(ctx: CheckContext): AssessmentIssue[] {
  const content = ctx.content
  if (content.native_uris === null) return []
  const native = new Set(content.native_uris.map((uri) => uri.trim()).filter((uri) => uri !== ''))
  const output = new Set(content.output_uris.map((uri) => uri.trim()).filter((uri) => uri !== ''))
  const out: AssessmentIssue[] = []
  const lost = [...native].filter((uri) => !output.has(uri))
  const fabricated = [...output].filter((uri) => !native.has(uri))
  if (lost.length > 0) {
    out.push(buildIssue('doc_uri_lost', `原件里有 ${lost.length} 个 URI 未出现在输出（不复述 URI 本身）`, null))
  }
  if (fabricated.length > 0) {
    out.push(buildIssue(
      'doc_uri_fabricated',
      `输出里有 ${fabricated.length} 个原件没有的 URI（凭空生成，不复述 URI 本身）`,
      null,
    ))
  }
  return out
}

/** 4. 阅读顺序。判据见 `NormalizedContent.layout_backend` 的注释（不是「false 就阻断」）。 */
export function checkReadingOrder(ctx: CheckContext): AssessmentIssue[] {
  const content = ctx.content
  if (content.blocks.length === 0) return []
  const reasons: string[] = []
  if (!content.order_verified && content.layout_backend !== null) {
    reasons.push(`版面后端 ${content.layout_backend} 已应用，但 order_verified=false（有的页没排成几何顺序）`)
  }
  // 显式 order 自相矛盾：不管声明怎么写的，块顺序都不可信。
  const explicit = content.blocks.filter((block) => block.order_source === 'explicit')
  for (let index = 1; index < explicit.length; index += 1) {
    if (explicit[index].order <= explicit[index - 1].order) {
      reasons.push(`块顺序非严格递增（order=${explicit[index - 1].order} → ${explicit[index].order}）`)
      break
    }
  }
  if (reasons.length === 0) return []
  return [buildIssue('doc_reading_order_unverified', `阅读顺序不可信：${reasons.join('；')}`, null)]
}

/** 5. 跨块错配：日期行缺组织文本，公司/职位/时间来自不同区块。 */
export function checkCrossBlockAttribution(ctx: CheckContext): AssessmentIssue[] {
  const blocks = ctx.content.blocks.filter((block) => block.text.trim() !== '')
  const out: AssessmentIssue[] = []
  const orgBlocks = blocks.filter((block) => hasOrgToken(block.text) && !hasDateRange(block.text))
  for (const row of blocks) {
    if (!hasDateRange(row.text)) continue
    if (hasOrgToken(row.text)) continue
    const rowPage = locatorPage(row.locator)
    const candidates = orgBlocks.filter((candidate) => {
      if (candidate.block_id === row.block_id) return false
      const page = locatorPage(candidate.locator)
      if (rowPage !== null && page !== null) return page === rowPage
      return true
    })
    if (candidates.length === 0) continue
    if (candidates.some((candidate) => sameVisualRow(row.locator, candidate.locator))) continue
    const roleNote = hasRoleToken(row.text) ? '职位文本在同块但公司缺失' : '公司/职位文本都不在该块'
    const locators = [row.locator, candidates[0].locator]
      .filter((locator): locator is EvidenceLocator => locator !== null)
    out.push(buildIssue(
      'doc_cross_block_attribution',
      `含时间区间的行缺少组织文本（${roleNote}），最近的候选组织在另一区块`
      + `（${candidates[0].block_id}）；拼装公司/职位/时间需要跨区块，按不可归属处理`,
      row.locator,
      { locators },
    ))
  }
  return out
}

/** 6. 来源核验：模型/OCR 生成或来源缺失的块 = 待核证据。 */
export function checkProvenance(ctx: CheckContext): AssessmentIssue[] {
  const out: AssessmentIssue[] = []
  for (const block of ctx.content.blocks) {
    if (block.text.trim() === '') continue
    if (VERIFIED_PROVENANCE.has(block.provenance)) continue
    const label = block.provenance === '' ? 'provenance 缺失' : `provenance=${block.provenance}`
    out.push(buildIssue(
      'doc_provenance_unverified',
      `块 ${block.block_id} 的 ${label}，属于待核证据（不得冒充原生文本）`,
      block.locator,
    ))
    if (hasIdentityTokens(block.text)) {
      out.push(buildIssue(
        'doc_identity_from_unverified_source',
        `块 ${block.block_id} 含邮箱/电话/姓名类身份信息，来源未核 → 禁止用于自动并人，只能人工复核`,
        block.locator,
      ))
    }
  }
  return out
}

/** 7. 上游说没读完却没有任何 issue：静默降级，按 HARD 兜住（docs/11 B3）。 */
export function checkCompletenessExplained(ctx: CheckContext, issueCount: number): AssessmentIssue[] {
  if (issueCount > 0) return []
  if (ctx.content.completeness === 'unverified' || ctx.content.completeness === 'complete') return []
  return [buildIssue(
    'doc_completeness_unexplained',
    'completeness=partial 但没有任何 issue（没读完却不说哪里没读）',
    null,
  )]
}

function extractLocator(raw: RawIssue): EvidenceLocator | null {
  const value = raw.locator ?? raw.location
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const page = record.page
  if (typeof page === 'number' && Number.isInteger(page) && page > 0) {
    const bbox = record.bbox
    if (Array.isArray(bbox) && bbox.length >= 4 && bbox.every((n) => typeof n === 'number')) {
      return { kind: 'pdf', page, bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] as [number, number, number, number] }
    }
    return { kind: 'pdf', page }
  }
  return null
}

/** 供测试/文档使用：把块的定位键导出（不参与判定）。 */
export function blockLocatorKeys(blocks: ReadonlyArray<NormalizedBlock>): string[] {
  return blocks.map((block) => locatorKey(block.locator))
}
