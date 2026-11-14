// 六个派生检查：不依赖上游「自报合格」，自己从内容里算证据。
//
// 每个检查只做一件事，返回 `AssessmentIssue[]`。所有 issue 的
// severity/retryable/suggested_action 都来自 `issue-codes.ts` 的稳定表，
// 这里不写死严重度。
// 唯一例外（2026-11-14）：`doc_attribution_resolved` 的动作由**置信度**决定
// （same_row → none 只留档；adjacent → human_review 标待核），因为「位置相邻」本身就需要人看。
//
// 覆盖的 6 类（docs/19 §2.2 / §3 U2 行）：
//   1. 页/块覆盖缺失      -> doc_block_missing / doc_page_count_unverified / doc_page_coverage_missing
//   2. 字符保真失败        -> doc_char_fidelity_mismatch（+ doc_unreadable_glyph_in_body）
//   3. URI 丢失或凭空生成  -> doc_uri_lost / doc_uri_fabricated
//   4. 阅读顺序不可靠      -> doc_reading_order_unverified
//   5. 跨块归属            -> doc_cross_block_attribution（只有 unresolved 才 HARD）
//                            + doc_attribution_resolved（能归出结果时发 SOFT，结果进 issue.detail）
//   6. 来源未核            -> doc_provenance_unverified / doc_identity_from_unverified_source

import { lookupIssueCode } from './issue-codes.ts'
import { locatorKey, locatorPage, nonWhitespaceChars } from './normalize.ts'
import type {
  AssessmentIssue,
  AttributionBasis,
  AttributionConfidence,
  EvidenceLocator,
  ExperienceAttribution,
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
    /** 结构化细节（供下游程序消费）；没有就是 null，不伪装成空对象。 */
    readonly detail?: Readonly<Record<string, unknown>>
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
    detail: options.detail ?? null,
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

// ---------------------------------------------------------------------------
// 5. 跨块归属：先产出「归属结果」，再决定拦不拦（2026-11-14）
//
// 背景（真实语料）：45 份真实简历里 27 份被 `doc_cross_block_attribution` 判 HARD。
// 问题不在「发现了跨块」，而在**只拦住、不给结果**：系统知道公司/时间在不同块，
// 却不产出「这条经历到底属于哪个块」。而且它报的「最近的候选组织」其实是文档顺序里的
// 第一个组织块，不是几何最近的 —— 等于连线索都是错的。
//
// 现在的做法：先算归属（`attributeExperienceRows`），再按归属结果的置信度分级：
//   * `same_row`   （同块自证 / PDF 同一可视行 / DOCX 同一表格行）→ 归属闭合，
//                   **只有它可以允许下游把主体与时间当同一行**；
//   * `adjacent`   （紧邻上一/下一可视行）→ 位置相邻 **不等于** 可以拼，标待核（human_review）；
//   * `unresolved` → 同页有主体但都拼不上 → 唯一仍然 HARD 的情况。
//
// 「不许跨块拼装」的原则没有放宽：`adjacent` 不给「可拼」的许可，只给「就近的可疑归属」和待核标记。
// ---------------------------------------------------------------------------

/**
 * 完整时间区间扫描（连起止两端的年月一起吃掉）。
 *
 * 为什么不能只用 `DATE_RANGE` 做 replace：那几个正则用于**检测**（遇到第一个年份就够），
 * 末尾只吃掉结束年份，`2025.03-2025.07` 会留下 `.07` 这种残渣，被误当成主体文本的一部分。
 * 注意：这里只影响「从行文本里剔除时间」这一步，`hasDateRange` 的判定口径一个字没改。
 */
const DATE_RANGE_SWEEP = /(?:(?:19|20)\d{2}\s*(?:[.\-/年]\s*\d{1,2}\s*月?)?)\s*(?:[-–—~～]|至|到)\s*(?:(?:19|20)\d{2}\s*(?:[.\-/年]\s*\d{1,2}\s*月?)?|至今|现在|present|now)/giu
/** 英文月份日期（`Jul 2020 – Jun 2023` / `Jan 2021`）：也是时间，不是主体。 */
const ENGLISH_MONTH_DATE = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s*(?:19|20)\d{2}/giu
/** 全局版本的职务词：从行文本里剔除「职务」部分，剩下的才算主体文本。 */
const ROLE_TOKENS_ALL = new RegExp(ROLE_TOKENS.source, `${ROLE_TOKENS.flags}g`)
/** 级别/名次词：属于「职位/奖项级别」，不算主体。 */
const LEVEL_TOKENS = /国家级|省级|市级|校级|特等奖|一等奖学金|一等奖|二等奖|三等奖|优秀奖|金奖|银奖|铜奖|第[一二三四五六七八九十\d]{1,3}名/gu
/** 项目符号：不是主体。 */
const BULLET_CHARS = /[•·▪◦●◆◇■□*]/gu
/** 正文句末标点：出现即「这是一段叙述」，不是标题行 / 主体行。 */
const SENTENCE_PUNCT = /[。；;！？!?]/u
/** 主体文本里不允许出现的分句标点：有它就不是标题，是叙述。 */
const CLAUSE_PUNCT = /[，,、]/u
/** 叙述动词：出现即「这是一条工作内容」，不是主体标题（否则 bullet 正文会被当成主体）。 */
const PROSE_VERBS = /负责|参与|主导|协助|完成|实现|搭建|推动|带领/u
/** 行内主体文本长度上限（非空白字符）：超过这个长度是段落，不是主体。 */
const MAX_SUBJECT_CHARS = 48
/** 主体候选行长度上限：组织/职务标题行一般很短。 */
const MAX_ANCHOR_CHARS = 60
/** 认定「紧邻可视行」的垂直间隙上限：0.75 × 较矮行高（≈ 下一行，中间没空行）。 */
const ADJACENT_GAP_RATIO = 0.75
/** 紧邻判定的水平容差：列间距不超过较窄者宽度的 2 倍（右对齐日期列 vs 左侧组织列可相邻）。 */
const ADJACENT_COLUMN_RATIO = 2

/** 一个 pdf bbox 的几何盒（只有 pdf 定位参与几何判定）。 */
interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

function boxOf(locator: EvidenceLocator | null): Box | null {
  if (locator === null || locator.kind !== 'pdf') return null
  const bbox = locator.bbox
  if (bbox === undefined) return null
  const [x0, y0, x1, y1] = bbox
  return { x0, y0, x1, y1 }
}

/** 垂直间隙：> 0 表示两行之间有空隙（b 在 a 上方或下方不定），< 0 表示垂直方向重叠。 */
function verticalGap(a: Box, b: Box): number {
  return Math.max(b.y0 - a.y1, a.y0 - b.y1)
}

/** 水平间隙：> 0 表示左右不相交，< 0 表示水平方向重叠。 */
function horizontalGap(a: Box, b: Box): number {
  return Math.max(b.x0 - a.x1, a.x0 - b.x1)
}

function horizontalOverlap(a: Box, b: Box): number {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
}

/** 行文本里「主体」的部分：去掉时间区间、职务词、级别词、项目符号与空白。 */
export function subjectTextOf(text: string): string {
  const out = text
    .replace(DATE_RANGE_SWEEP, ' ')
    .replace(ENGLISH_MONTH_DATE, ' ')
    .replace(ROLE_TOKENS_ALL, ' ')
    .replace(LEVEL_TOKENS, ' ')
    .replace(BULLET_CHARS, ' ')
    // 日期被剔除后留下的孤立连接符（`Jul 2020 - Jun 2023 Project` → `- Project`）不是主体。
    .replace(/(?:^|\s)[-–—~～]+(?=\s|$)/gu, ' ')
  return out.replace(/\s+/gu, '')
}

/**
 * 行内是否**自带主体文本**（而不是只有时间/职务/级别）。
 *
 * 例子：`奖项名 国家级二等奖 2025.03-2025.07`、`XX公司 2021.07-2024.06 后端工程师`、
 * `研究一：…… 2025 年 10 月 - 至今`。这三种行的主体与时间**在同一个块内闭合**。
 * 反例：`2021.07 - 2024.06 后端工程师`（去掉时间和职务词后什么都不剩）→ 需要外部主体。
 */
export function hasSubjectText(text: string): boolean {
  const subject = subjectTextOf(text)
  if (subject.length < 4 || subject.length > MAX_SUBJECT_CHARS) return false
  if (SENTENCE_PUNCT.test(subject) || CLAUSE_PUNCT.test(subject)) return false
  if (PROSE_VERBS.test(subject)) return false
  return /\p{L}/u.test(subject)
}

/**
 * 表格**单元格**里的标题判据：比行内自证宽一档。
 *
 * 差别只有一个：允许 `，、` 这类分句标点。理由：表格结构已经证明「这一格是一个字段」，
 * 它不是叙述段落，标题里带顿号很常见（`全国大学生数学建模竞赛、美国大学生数学建模竞赛`）。
 * 仍然保留：去时间/职务/级别后 4–48 字、无句末标点（`。；!?` 出现即叙述）、无叙述动词。
 */
function isTableCellSubject(text: string): boolean {
  const subject = subjectTextOf(text)
  if (subject.length < 4 || subject.length > MAX_SUBJECT_CHARS) return false
  if (SENTENCE_PUNCT.test(subject)) return false
  if (PROSE_VERBS.test(subject)) return false
  return /\p{L}/u.test(subject)
}

/** 能否被当作「主体/组织标题行」。
 *
 * 沿用原判据的边界：含时间区间的块不是组织文本。另外排除长段落与整句叙述
 * （正文里的 `……大学生……` 常命中组织 token，但它不是组织名，不能拿来归属）。
 */
export function isAnchorBlock(block: NormalizedBlock): boolean {
  const text = block.text.trim()
  if (text === '') return false
  if (hasDateRange(text)) return false
  if (nonWhitespaceChars(text) > MAX_ANCHOR_CHARS) return false
  if (SENTENCE_PUNCT.test(text)) return false
  return hasOrgToken(text) || hasRoleToken(text)
}

/** 紧邻的可视行：垂直间隙 ≤ 0.75 × 较矮行高，且水平方向不是无关的另一栏。 */
function isAdjacentVisualRow(row: EvidenceLocator | null, candidate: EvidenceLocator | null): boolean {
  if (row === null || candidate === null) return false
  if (row.kind !== 'pdf' || candidate.kind !== 'pdf' || row.page !== candidate.page) return false
  const a = boxOf(row)
  const b = boxOf(candidate)
  if (a === null || b === null) return false
  const minHeight = Math.min(a.y1 - a.y0, b.y1 - b.y0)
  if (minHeight <= 0) return false
  const gap = verticalGap(a, b)
  if (gap < -0.25 * minHeight || gap > ADJACENT_GAP_RATIO * minHeight) return false
  const minWidth = Math.min(a.x1 - a.x0, b.x1 - b.x0)
  if (minWidth <= 0) return false
  return horizontalOverlap(a, b) > 0 || horizontalGap(a, b) <= ADJACENT_COLUMN_RATIO * minWidth
}

/** 两行之间是否还夹着第三块（「紧邻」必须真的中间没有别的块）。 */
function hasBlockBetween(
  row: NormalizedBlock,
  candidate: NormalizedBlock,
  blocks: ReadonlyArray<NormalizedBlock>,
): boolean {
  const a = boxOf(row.locator)
  const b = boxOf(candidate.locator)
  if (a === null || b === null) return false
  const page = locatorPage(row.locator)
  const bandTop = Math.min(a.y1, b.y1)
  const bandBottom = Math.max(a.y0, b.y0)
  if (bandBottom > bandTop) return false
  for (const other of blocks) {
    if (other.block_id === row.block_id || other.block_id === candidate.block_id) continue
    if (other.text.trim() === '') continue
    const locator = other.locator
    if (locator === null || locator.kind !== 'pdf') continue
    if (locator.page !== page) continue
    const box = boxOf(locator)
    if (box === null) continue
    if (Math.min(box.y1, bandTop) - Math.max(box.y0, bandBottom) > 2) return true
  }
  return false
}

/** 主体候选：同页、不是本行、且像组织/职务标题的块（顺序稳定）。 */
function anchorCandidates(
  row: NormalizedBlock,
  blocks: ReadonlyArray<NormalizedBlock>,
): NormalizedBlock[] {
  const rowPage = locatorPage(row.locator)
  return blocks.filter((candidate) => {
    if (candidate.block_id === row.block_id) return false
    if (candidate.text.trim() === '') return false
    if (!isAnchorBlock(candidate)) return false
    // 分页材料只和同一页的块比；没有页定位（DOCX）时保留全部候选：
    // 它们确实在材料里，但**无法建立位置关系** → 仍然 unresolved（不给假归属）。
    if (rowPage === null) return true
    return locatorPage(candidate.locator) === rowPage
  })
}

/** DOCX 表格行的身份键：同部件 + 同表 + 同行（`null` = 这一行不在表格里）。 */
function tableRowKey(locator: EvidenceLocator | null): string | null {
  if (locator === null || locator.kind !== 'docx') return null
  const { part, table_id: tableId, row } = locator
  if (tableId === undefined || row === undefined) return null
  return `${part}|${tableId}|${row}`
}

/** 每张 DOCX 表有几行：单行表通常是**排版用的外框表**，不是「一条记录一行」的记录表。 */
function docxTableRowCounts(
  blocks: ReadonlyArray<NormalizedBlock>,
): ReadonlyMap<string, number> {
  const rowsByTable = new Map<string, Set<number>>()
  for (const block of blocks) {
    const locator = block.locator
    if (locator === null || locator.kind !== 'docx') continue
    if (locator.table_id === undefined || locator.row === undefined) continue
    const key = `${locator.part}|${locator.table_id}`
    const rows = rowsByTable.get(key) ?? new Set<number>()
    rows.add(locator.row)
    rowsByTable.set(key, rows)
  }
  const counts = new Map<string, number>()
  for (const [key, rows] of rowsByTable) counts.set(key, rows.size)
  return counts
}

/**
 * DOCX 表格里的「同排」关系：同部件、同表、同一行，且**不是同一个单元格**。
 *
 * 为什么需要：DOCX 没有 bbox，`sameVisualRow` 永远为 false，于是「一行三格：公司 | 职位 | 时间」
 * 这种最常见的简历表格 100% 会掉进 unresolved（真实语料里整整 10 行）。
 * 表格行是精确的行身份，比 PDF 的「视觉同排」更强，所以 `same_row` 的语义完全成立；
 * 但**只对记录表生效**：单行表（排版外框）不算，同行出现多个组织格（无法确定谁是公司）也不算。
 */
function sameTableRow(row: EvidenceLocator | null, candidate: EvidenceLocator | null): boolean {
  const rowKey = tableRowKey(row)
  if (rowKey === null) return false
  if (tableRowKey(candidate) !== rowKey) return false
  const a = row as Extract<EvidenceLocator, { kind: 'docx' }>
  const b = candidate as Extract<EvidenceLocator, { kind: 'docx' }>
  return a.cell !== b.cell
}

function horizontalDistanceBetween(row: NormalizedBlock, candidate: NormalizedBlock): number {
  const a = boxOf(row.locator)
  const b = boxOf(candidate.locator)
  if (a === null || b === null) return Number.MAX_SAFE_INTEGER
  return horizontalGap(a, b)
}

function verticalDistanceBetween(row: NormalizedBlock, candidate: NormalizedBlock): number {
  const a = boxOf(row.locator)
  const b = boxOf(candidate.locator)
  if (a === null || b === null) return Number.MAX_SAFE_INTEGER
  return Math.abs(verticalGap(a, b))
}

/** 归属详情（JSON 安全、顺序稳定）：`issue.detail.attribution`。 */
export function attributionDetail(attribution: ExperienceAttribution): Readonly<Record<string, unknown>> {
  return {
    attribution: {
      row_block_id: attribution.row_block_id,
      org_block_id: attribution.org_block_id,
      confidence: attribution.confidence,
      basis: attribution.basis,
      page: attribution.page,
      // 可执行判据，不是注释：
      //   只有 same_row 才允许把主体/公司与时间当同一行；adjacent 只给「就近可疑」+ 待核。
      may_join_same_row: attribution.confidence === 'same_row',
      needs_human_check: attribution.confidence === 'adjacent',
      candidate_block_ids: [...attribution.candidate_block_ids],
      evidence: attribution.evidence.map((locator) => locatorKey(locator)),
      org_text: attribution.org_text,
    },
  }
}

function makeAttribution(
  row: NormalizedBlock,
  org: NormalizedBlock | null,
  confidence: AttributionConfidence,
  basis: AttributionBasis,
  evidence: ReadonlyArray<EvidenceLocator>,
  orgText: string | null,
  candidateIds: ReadonlyArray<string>,
): ExperienceAttribution {
  return {
    row_block_id: row.block_id,
    org_block_id: org === null ? null : org.block_id,
    confidence,
    basis,
    evidence,
    page: locatorPage(row.locator),
    org_text: orgText,
    candidate_block_ids: candidateIds,
  }
}

/** 对一行算归属（纯函数，不改入参）。 */
function attributeOneRow(
  row: NormalizedBlock,
  blocks: ReadonlyArray<NormalizedBlock>,
  tableRowCounts: ReadonlyMap<string, number>,
): ExperienceAttribution {
  const candidates = anchorCandidates(row, blocks)
  const candidateIds = candidates.map((candidate) => candidate.block_id)

  // 1. 组织文本就在本块：连「相邻」都不用判断（原判据里这类行本来也不报）。
  if (hasOrgToken(row.text)) {
    const evidence = row.locator === null ? [] : [row.locator]
    return makeAttribution(row, row, 'same_row', 'org_in_row', evidence, row.text, candidateIds)
  }

  // 2. 行内自证：时间之外还有主体文本 → 主体与时间在同一块里，不需要跨块拼装。
  if (hasSubjectText(row.text)) {
    const evidence = row.locator === null ? [] : [row.locator]
    return makeAttribution(row, row, 'same_row', 'self_subject', evidence, subjectTextOf(row.text), candidateIds)
  }

  // 3a. PDF：同一可视行的另一块（复用 sameVisualRow；取水平最近的那个）。
  const sameRowHits = candidates
    .filter((candidate) => sameVisualRow(row.locator, candidate.locator))
    .sort((a, b) => {
      const gap = horizontalDistanceBetween(row, a) - horizontalDistanceBetween(row, b)
      if (gap !== 0) return gap
      return a.order - b.order
    })
  if (sameRowHits.length > 0) {
    const picked = sameRowHits[0]
    const evidence = [row.locator, picked.locator]
      .filter((locator): locator is EvidenceLocator => locator !== null)
    return makeAttribution(row, picked, 'same_row', 'same_row_anchor', evidence, picked.text, candidateIds)
  }

  // 3b. DOCX 表格：同一表格行是精确的行身份（没有 bbox 也不影响）。
  //   行内「谁算主体」按强弱取，且必须唯一（不唯一就是歧义 → 不拼）：
  //     ① 唯一一个组织格 → 用它；
  //     ② 没有组织格时，唯一一个「标题格」（奖项名/项目名）→ 用它（表格行 = 一条记录，
  //        时间属于这一行的主体；这与 PDF 的 self_subject 是同一条道理）。
  //   单行表通常是排版外框，不算「一条记录一行」→ 不参与。
  const rowKey = tableRowKey(row.locator)
  const tableKey = rowKey === null ? null : rowKey.slice(0, rowKey.lastIndexOf('|'))
  const tableMultiRow = tableKey !== null && (tableRowCounts.get(tableKey) ?? 0) >= 2
  const tableSiblings = !tableMultiRow
    ? []
    : blocks.filter((block) => block.block_id !== row.block_id
      && block.text.trim() !== ''
      && sameTableRow(row.locator, block.locator)
      && !hasDateRange(block.text))
  const tableOrgSiblings = tableSiblings.filter((block) => hasOrgToken(block.text))
  const tableSubjectSiblings = tableSiblings.filter((block) => isTableCellSubject(block.text))
  const tableOwner = tableOrgSiblings.length === 1
    ? tableOrgSiblings[0]
    : (tableOrgSiblings.length === 0 && tableSubjectSiblings.length === 1 ? tableSubjectSiblings[0] : null)
  if (tableOwner !== null) {
    const evidence = [row.locator, tableOwner.locator]
      .filter((locator): locator is EvidenceLocator => locator !== null)
    const ids = candidateIds.includes(tableOwner.block_id)
      ? candidateIds
      : [...candidateIds, tableOwner.block_id]
    return makeAttribution(row, tableOwner, 'same_row', 'same_table_row', evidence, tableOwner.text, ids)
  }

  // 4. 紧邻的上一/下一可视行（位置相邻 ≠ 可拼，只给 adjacent + 待核）。
  const adjacentHits = candidates
    .filter((candidate) => isAdjacentVisualRow(row.locator, candidate.locator)
      && !hasBlockBetween(row, candidate, blocks))
    .sort((a, b) => {
      const gap = verticalDistanceBetween(row, a) - verticalDistanceBetween(row, b)
      if (gap !== 0) return gap
      return a.order - b.order
    })
  if (adjacentHits.length > 0) {
    const picked = adjacentHits[0]
    const evidence = [row.locator, picked.locator]
      .filter((locator): locator is EvidenceLocator => locator !== null)
    return makeAttribution(row, picked, 'adjacent', 'adjacent_anchor', evidence, picked.text, candidateIds)
  }

  // 5. 拼不上：同页有候选就给出「看过哪些」的定位，没有候选就是 no_anchor。
  const nearest = [...candidates].sort((a, b) => {
    const distance = verticalDistanceBetween(row, a) - verticalDistanceBetween(row, b)
    if (distance !== 0) return distance
    return a.order - b.order
  })
  const evidence = [row.locator, ...(nearest.length > 0 ? [nearest[0].locator] : [])]
    .filter((locator): locator is EvidenceLocator => locator !== null)
  return makeAttribution(row, null, 'unresolved', 'no_anchor', evidence, null, candidateIds)
}

/**
 * 对每个「含时间区间的行」产出归属结果（纯函数，不抛异常，不改入参）。
 *
 * @param content - 归一化后的统一内容（`normalizeContent` 的输出）。
 * @returns 与行顺序一致、顺序稳定的归属结果；没有时间行的材料返回空数组。
 */
export function attributeExperienceRows(content: NormalizedContent): ExperienceAttribution[] {
  const blocks = content.blocks.filter((block) => block.text.trim() !== '')
  const tableRowCounts = docxTableRowCounts(blocks)
  const out: ExperienceAttribution[] = []
  for (const row of blocks) {
    if (!hasDateRange(row.text)) continue
    out.push(attributeOneRow(row, blocks, tableRowCounts))
  }
  return out
}

/**
 * 5. 跨块归属检查（语义见本节开头）。
 *
 * 只有 `unresolved` 且**同页存在候选主体**时才发 HARD（没有候选 = 不存在可被误拼的对象，
 * 不凭空新增阻断）。`same_row` / `adjacent` 发 SOFT `doc_attribution_resolved` 并带 `detail`。
 */
export function checkCrossBlockAttribution(ctx: CheckContext): AssessmentIssue[] {
  const blocks = ctx.content.blocks.filter((block) => block.text.trim() !== '')
  const byId = new Map(blocks.map((block) => [block.block_id, block]))
  const out: AssessmentIssue[] = []
  for (const attribution of attributeExperienceRows(ctx.content)) {
    // 行内自带组织文本 = 没有跨块问题（原判据的边界，不新增噪声）。
    if (attribution.basis === 'org_in_row') continue
    const row = byId.get(attribution.row_block_id)
    if (row === undefined) continue
    const detail = attributionDetail(attribution)
    const candidates = attribution.candidate_block_ids
    if (attribution.confidence === 'unresolved') {
      // 只有**存在组织文本**时才是「公司/时间跨块」的 HARD。
      // 只有职务标题行（没有组织 token）时不存在可被误拼的公司，不能凭空新增阻断
      // ——这正是原判据的边界：没有 org 候选时它根本不报，这里不许放宽成「有候选就报」。
      const orgCandidates = candidates.filter((blockId) => {
        const candidate = byId.get(blockId)
        return candidate !== undefined && hasOrgToken(candidate.text)
      })
      if (orgCandidates.length === 0) continue
      const roleNote = hasRoleToken(row.text) ? '职位文本在同块但公司缺失' : '公司/职位文本都不在该块'
      out.push(buildIssue(
        'doc_cross_block_attribution',
        `归属 unresolved（${roleNote}）：同块、同一可视行、紧邻行都没有主体文本，`
        + `而同页还有 ${orgCandidates.length} 处组织文本（${orgCandidates.slice(0, 3).join('/')}）`
        + '——公司/职位/时间分属不同块，禁止跨块拼装',
        row.locator,
        { locators: attribution.evidence, detail },
      ))
      continue
    }
    const target = attribution.org_block_id ?? '(unknown)'
    const sameRow = attribution.confidence === 'same_row'
    const where = !sameRow
      ? '紧邻行（位置相邻，不等于可拼）'
      : attribution.basis === 'self_subject'
        ? '同一块内自证（主体文本与时间同块）'
        : attribution.basis === 'same_table_row'
          ? '同一表格行（同表同排的不同单元格）'
          : '同一可视行'
    const verdict = !sameRow
      ? '仍需人工核对，不得当作同一行拼装'
      : attribution.basis === 'self_subject'
        ? '时间属于该块的主体文本，不需要跨块拼装'
        : '公司/时间可视为同一行'
    out.push(buildIssue(
      'doc_attribution_resolved',
      `归属 ${attribution.confidence}（${attribution.basis}）：时间行 ${row.block_id} 的主体在 ${target}`
      + `（${where}）；${verdict}。归属结果见 detail.attribution`,
      row.locator,
      {
        locators: attribution.evidence,
        detail,
        // 只有 adjacent 需要人核；same_row 只是把结果留档，不派活。
        suggested_action: attribution.confidence === 'adjacent' ? 'human_review' : 'none',
      },
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
