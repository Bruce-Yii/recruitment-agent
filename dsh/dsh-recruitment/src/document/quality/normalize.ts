// 宽输入归一化：把「转换器真实输出」或「docs/19 §2.1 统一内容」变成判定器能用的形状。
//
// 原则：
//   * 不抛异常。结构问题变成 `contract_problems`，由判定器转成 HARD（fail-closed）。
//   * 不猜事实。provenance 缺失就记 `provenance_known=false`；order 缺失就记
//     `order_source='position'`；页数缺失就是 null，绝不假设为 1。
//   * 媒体类型优先取 `media_type`；缺失时只接受「阅读器自己声明的 backend/reader_id」，
//     不做文件名猜测。

import type {
  Completeness,
  DocumentContentLike,
  EvidenceLocator,
  NormalizedBlock,
  NormalizedContent,
  NormalizedPageInfo,
  RawBlock,
  RawIssue,
  RawLink,
  ReaderFacts,
} from './types.ts'

const COMPLETENESS: readonly Completeness[] = ['complete', 'partial', 'unverified']
const KNOWN_PROVENANCE = new Set(['native_text', 'docling', 'ocr', 'agent_read', 'human_confirmed'])
const UNREADABLE_MARKER = /\uFFFD|\(cid:\d+\)|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu

/** 非空白字符数（按 Unicode 码点计，与 docs/11 A2 的 `len()` 口径一致）。 */
export function nonWhitespaceChars(text: string): number {
  return Array.from(text.replace(/\s+/gu, '')).length
}

/** 正文里的坏字形/不可读标记数量。 */
export function countUnreadableMarkers(text: string): number {
  const matches = text.match(UNREADABLE_MARKER)
  return matches === null ? 0 : matches.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asPage(value: unknown): number | null {
  const n = asNumber(value)
  if (n === null || !Number.isInteger(n) || n < 1) return null
  return n
}

function bboxTuple(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined
  const nums = value.map((item) => asNumber(item))
  if (nums.some((item) => item === null)) return undefined
  return [nums[0] as number, nums[1] as number, nums[2] as number, nums[3] as number]
}

/**
 * 定位归一化。
 * 接受：`{kind:'pdf',page,bbox}` / 转换器 `{page,bbox}` / `{kind:'docx',part,...}` /
 * `{kind:'rtf',paragraph,page?}` / `{kind:'image',frame}`。都不像就返回 null
 * （= 没有定位，不是「定位没问题」）。
 */
export function normalizeLocator(raw: unknown): EvidenceLocator | null {
  if (!isRecord(raw)) return null
  const kind = asString(raw.kind)
  const page = asPage(raw.page)
  const bbox = bboxTuple(raw.bbox)
  const blockId = asString(raw.block_id)
  if (kind === 'rtf' || raw.paragraph !== undefined) {
    const paragraph = asNumber(raw.paragraph)
    if (paragraph !== null && (!Number.isInteger(paragraph) || paragraph < 0)) return null
    const loc: { kind: 'rtf', paragraph?: number, page?: number } = { kind: 'rtf' }
    if (paragraph !== null) loc.paragraph = paragraph
    if (page !== null) loc.page = page
    // 与契约同一不变量：paragraph / page 至少一个，否则等于没有定位。
    if (loc.paragraph === undefined && loc.page === undefined) return null
    return loc
  }
  if (kind === 'docx' || raw.part !== undefined) {
    const part = asString(raw.part)
    if (part === null) return null
    const loc: {
      kind: 'docx',
      part: string,
      paragraph_id?: string,
      table_id?: string,
      row?: number,
      cell?: number
      block_id?: string
    } = { kind: 'docx', part }
    const paragraph = asString(raw.paragraph_id)
    const table = asString(raw.table_id)
    const row = asNumber(raw.row)
    const cell = asNumber(raw.cell)
    if (paragraph !== null) loc.paragraph_id = paragraph
    if (table !== null) loc.table_id = table
    if (row !== null) loc.row = row
    if (cell !== null) loc.cell = cell
    if (blockId !== null) (loc as { block_id?: string }).block_id = blockId
    return loc
  }
  if (kind === 'image' || (kind === null && page === null && raw.frame !== undefined)) {
    const loc: { kind: 'image', frame?: number, bbox?: [number, number, number, number] } = { kind: 'image' }
    const frame = asNumber(raw.frame)
    if (frame !== null) loc.frame = frame
    if (bbox !== undefined) loc.bbox = bbox
    return loc
  }
  if (page !== null) {
    const loc: { kind: 'pdf', page: number, bbox?: [number, number, number, number], block_id?: string } = {
      kind: 'pdf',
      page,
    }
    if (bbox !== undefined) loc.bbox = bbox
    if (blockId !== null) loc.block_id = blockId
    return loc
  }
  return null
}

/** 定位的稳定字符串（用于去重、排序、计划 ID）。 */
export function locatorKey(locator: EvidenceLocator | null): string {
  if (locator === null) return '-'
  if (locator.kind === 'pdf') {
    const bbox = locator.bbox === undefined ? '' : `@${locator.bbox.join(',')}`
    return `pdf:p${locator.page}${bbox}`
  }
  if (locator.kind === 'docx') {
    return `docx:${locator.part}:${locator.paragraph_id ?? ''}:${locator.table_id ?? ''}`
  }
  if (locator.kind === 'rtf') {
    return `rtf:p${locator.page ?? ''}#${locator.paragraph ?? ''}`
  }
  return `image:f${locator.frame ?? ''}`
}

/** 块定位的页号（pdf 与「有逻辑页号的 rtf」有页；docx / 图像帧 / 无页 RTF 不算页）。 */
export function locatorPage(locator: EvidenceLocator | null): number | null {
  if (locator === null) return null
  if (locator.kind === 'pdf') return locator.page
  if (locator.kind === 'rtf' && locator.page !== undefined) return locator.page
  return null
}

function normalizeLinks(raw: unknown): Array<{ text: string, href: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ text: string, href: string }> = []
  for (const item of raw as Array<RawLink | string>) {
    if (typeof item === 'string') {
      if (item.trim() !== '') out.push({ text: item, href: item })
      continue
    }
    if (!isRecord(item)) continue
    const href = asString(item.href)
    if (href === null || href.trim() === '') continue
    out.push({ text: asString(item.text) ?? href, href })
  }
  return out
}

const URL_IN_TEXT = /(?:https?:\/\/|mailto:)[^\s<>"'）】\]]+/gu

function urlsInText(text: string): string[] {
  const out: string[] = []
  for (const match of text.match(URL_IN_TEXT) ?? []) {
    const cleaned = match.replace(/[.,;:]+$/u, '')
    if (cleaned !== '') out.push(cleaned)
  }
  return out
}

function normalizePageInfo(raw: unknown): NormalizedPageInfo[] {
  if (!Array.isArray(raw)) return []
  const out: NormalizedPageInfo[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const page = asPage(item.page)
    if (page === null) continue
    const readable = typeof item.readable === 'boolean' ? item.readable : null
    out.push({
      page,
      chars: asNumber(item.chars),
      block_count: asNumber(item.block_count),
      readable,
    })
  }
  return out.sort((a, b) => a.page - b.page)
}

function normalizeBlocks(raw: unknown, problems: string[]): NormalizedBlock[] {
  if (!Array.isArray(raw)) {
    problems.push('blocks 不是数组（无法建立可追溯区块）')
    return []
  }
  const out: NormalizedBlock[] = []
  ;(raw as RawBlock[]).forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`blocks[${index}] 不是对象`)
      return
    }
    const text = asString(item.text)
    if (text === null) problems.push(`blocks[${index}].text 不是字符串`)
    const explicitOrder = asNumber(item.order)
    const provenance = asString(item.provenance)
    const locator = normalizeLocator(item.locator ?? item.location)
    out.push({
      block_id: asString(item.block_id) ?? `block#${index + 1}`,
      kind: asString(item.kind) ?? 'other',
      text: text ?? '',
      order: explicitOrder === null ? index : explicitOrder,
      order_source: explicitOrder === null ? 'position' : 'explicit',
      locator,
      provenance: provenance ?? '',
      provenance_known: provenance !== null && KNOWN_PROVENANCE.has(provenance),
      links: normalizeLinks(item.links),
      unreadable_markers: countUnreadableMarkers(text ?? ''),
    })
  })
  return out
}

function inferMediaType(content: Record<string, unknown>, readerId: string, pageCount: number | null): string {
  const declared = asString(content.media_type)
  if (declared !== null && declared.trim() !== '') return declared.trim()
  const meta = isRecord(content.meta) ? content.meta : {}
  const backend = asString(meta.backend) ?? ''
  const profile = asString(content.reader_profile) ?? ''
  const haystack = `${readerId} ${backend} ${profile}`.toLowerCase()
  if (haystack.includes('pymupdf') || haystack.includes('pdf')) return 'application/pdf'
  if (haystack.includes('docx') || haystack.includes('word') || haystack.includes('docling')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  if (haystack.includes('png')) return 'image/png'
  if (haystack.includes('jpeg') || haystack.includes('jpg')) return 'image/jpeg'
  if (haystack.includes('image')) return 'image/png'
  // 只有页数这一个线索：分页材料几乎必然是 PDF，但这是推断，不是声明。
  if (pageCount !== null && pageCount > 0) return 'application/pdf'
  return 'unknown'
}

function normalizeNativeUris(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim() !== '') out.push(item)
      continue
    }
    if (isRecord(item)) {
      const href = asString(item.href)
      if (href !== null && href.trim() !== '') out.push(href)
    }
  }
  return out
}

/**
 * 归一化入口。任何输入（含 null/垃圾）都返回结构完整的 `NormalizedContent`，
 * 结构问题写进 `contract_problems`。
 */
export function normalizeContent(raw: unknown, facts: ReaderFacts = {}): NormalizedContent {
  const problems: string[] = []
  if (!isRecord(raw)) {
    return {
      present: false,
      media_type: 'unknown',
      reader_id: '',
      text: '',
      blocks: [],
      issues: [],
      completeness: 'unverified',
      needs_visual: false,
      page_count: null,
      page_info: [],
      order_verified: false,
      order_asserted: false,
      layout_backend: null,
      source_chars: null,
      native_uris: null,
      output_uris: [],
      contract_problems: ['content 不是对象（null/数组/原始值）'],
    }
  }
  const content = raw as DocumentContentLike & Record<string, unknown>
  const meta = isRecord(content.meta) ? content.meta : {}

  const readerId = asString(content.reader_id) ?? asString(meta.backend) ?? ''
  const blocks = normalizeBlocks(content.blocks, problems)

  const pageInfo = facts.page_info === undefined
    ? normalizePageInfo(meta.page_info)
    : normalizePageInfo(facts.page_info)
  const declaredPages = asPage(facts.page_count) ?? asPage(content.page_count) ?? asPage(meta.pages)
  const pageCount = declaredPages ?? (pageInfo.length > 0 ? pageInfo.length : null)
  if (declaredPages !== null && pageInfo.length > 0 && pageInfo.length !== declaredPages) {
    problems.push(`meta.pages=${declaredPages} 与 meta.page_info 长度 ${pageInfo.length} 不一致`)
  }

  let text = asString(content.text)
  if (text === null) {
    problems.push('text 不是字符串（无法做字符保真比对）')
    text = blocks.map((block) => block.text).join('\n\n')
  }

  const rawCompleteness = asString(content.completeness)
  // completeness 缺失不是「合格」，但也不该单凭缺失就阻断：按 unverified 处理，
  // 由派生检查（覆盖/保真/顺序/来源）自己证明，绝不默认 complete。
  const completeness: Completeness = COMPLETENESS.includes(rawCompleteness as Completeness)
    ? (rawCompleteness as Completeness)
    : 'unverified'

  // issues 缺失 = 没有报错（正常情况），不算契约问题；类型错才算。
  const issues = Array.isArray(content.issues)
    ? (content.issues as RawIssue[])
    : []
  if (content.issues !== undefined && !Array.isArray(content.issues)) problems.push('issues 不是数组')

  const topLinks = normalizeLinks(content.links)
  const blockLinks = blocks.flatMap((block) => block.links)
  const outputUris = Array.from(new Set([
    ...blockLinks.map((link) => link.href),
    ...topLinks.map((link) => link.href),
    ...urlsInText(text),
  ]))

  // 事实优先级：调用方显式传入的 reader facts > 内容自带的声明/转换器 meta。
  const orderFlag = (typeof facts.order_verified === 'boolean'
    ? facts.order_verified
    : undefined) ?? content.order_verified ?? meta.order_verified
  const orderVerified = orderFlag === true
  const orderAsserted = typeof orderFlag === 'boolean'

  const sourceChars = asNumber(facts.source_chars)
    ?? asNumber(content.source_chars)
    ?? asNumber(meta.native_chars)
    ?? asNumber(meta.source_chars)

  const nativeUris = (facts.native_links === undefined ? null : normalizeNativeUris(facts.native_links))
    ?? normalizeNativeUris(content.native_links)
    ?? normalizeNativeUris(meta.native_links)

  return {
    present: true,
    media_type: inferMediaType(content, readerId, pageCount),
    reader_id: readerId,
    text,
    blocks,
    issues,
    completeness,
    needs_visual: content.needs_visual === true,
    page_count: pageCount,
    page_info: pageInfo,
    order_verified: orderVerified,
    order_asserted: orderAsserted,
    layout_backend: (facts.layout_backend === undefined
      ? asString(meta.layout_backend)
      : (facts.layout_backend ?? null)),
    source_chars: sourceChars,
    native_uris: nativeUris,
    output_uris: outputUris,
    contract_problems: Array.from(new Set(problems)),
  }
}
