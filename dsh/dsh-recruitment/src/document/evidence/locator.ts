// D-110 证据定位器：证据闸门只管「可复核」，不管「有没有坐标」。
//
// 裁决出处：`docs/17` D-110（2026-11-15 产品负责人裁决）+ IR-G1/IR-G8/IR-G9。
// 三条件**同时**成立才可自动通过：
//
//   ① 原文可核：引用绑定源文件字节级 sha256，独立重算一致（{@link sha256Hex}）；
//   ② 定位唯一：定位器解析到原文唯一位置（{@link EvidenceLocator} 联合类型，
//      按格式分型：PDF page+bbox；DOCX part+paragraph / part+table_id+row；
//      RTF paragraph（有硬分页时 +page）；纯文本 line/offset）；
//   ③ 原句逐字命中：quote 在定位范围里逐字出现，归一化只允许
//      {@link normalizeQuote} 写死的那几条（换行 / 空白 / 行尾断连字符），
//      **禁止语义匹配、禁止模糊匹配、禁止大小写折叠**。
//
// 命中多处 = 歧义，不是通过：必须补第二定位（前后文 / 相邻块 / 章节）或转人工；
// **禁止取第一条命中**（D-110：「同一句话出现多次时取第一条，比没有坐标更危险」）。
//
// 为什么坐标不是门槛：坐标是「可追溯」的实现手段，不是目的。任何人拿原文都能核对
// 「这句话确实在那里」就够了；把手段当目的，就会把格式差异（RTF 没有 bbox）变成业务
// 阻断——RTF 能读却进不了 S6，正是修复前的缺陷（S6 的 `identity.ts::toEvidence` 只接受
// `page>=1 && bbox 四元组`）。
//
// 与 `src/document/contracts/types.ts` 的 `EvidenceLocator` 的关系：那边是**读取层契约**
// 的 locator（kind = 'pdf' | 'docx' | 'image' | 'rtf'，字段形态来自读取器）；本文件是
// **S6 证据闸门**的定位器（kind 更细，把 DOCX 段落/表格行与 PDF 坐标分开），消费的是
// converter 输出的 `location`，不依赖读取层契约的必填 locator。两者最终应统一，
// 但在读取层契约与 S6 闸门各自演进期间不强行耦合（避免一个 lane 的改动打断另一个）。
//
// 本文件是纯函数：不读文件、不连库、不起子进程。字节由调用方传入（见 converter-adapter.ts）。
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
//  定位器联合类型
// ---------------------------------------------------------------------------

/** 定位器种类：五种可定位格式/位置形态。 */
export type LocatorKind =
  | 'pdf_page_bbox'
  | 'docx_part_paragraph'
  | 'docx_part_table_row'
  | 'rtf_paragraph'
  | 'text_line_offset'

/** PDF 文本层：页码（1-based）+ 用户空间坐标 `[x0, y0, x1, y1]`。 */
export interface PdfPageBboxLocator {
  readonly kind: 'pdf_page_bbox'
  /** 1-based 页码。 */
  readonly page: number
  /** PDF 用户空间坐标；必须是 4 个有限数（否则不是合格坐标，不能当证据）。 */
  readonly bbox: readonly [number, number, number, number]
}

/** DOCX 段落：OOXML 部件名 + 段落序号（0-based，按部件内段落流顺序）。 */
export interface DocxPartParagraphLocator {
  readonly kind: 'docx_part_paragraph'
  /** 部件名，如 `word/document.xml`；空串不是合格部件名。 */
  readonly part: string
  /** 部件内段落序号（0-based）。 */
  readonly paragraph: number
}

/** DOCX 表格行：部件名 + 表号（0-based）+ 行号（0-based）。 */
export interface DocxPartTableRowLocator {
  readonly kind: 'docx_part_table_row'
  readonly part: string
  /** 该部件内的表序号（0-based）。 */
  readonly table_id: number
  /** 表内行号（0-based）。 */
  readonly row: number
}

/**
 * RTF 段落：读取器块流里的段落序号（0-based，= 原文段落顺序）。
 *
 * `page` 是**附加**约束，不是必要条件：RTF 没有硬分页符时 converter 会写 `page:1`
 * （格式等价事实）；有硬分页时读取器不重建逐页归属，`page` 省略（不猜）。
 * 因此 `{paragraph:2}` 与 `{paragraph:2, page:1}` 指同一位置（见 {@link sameLocator}）。
 */
export interface RtfParagraphLocator {
  readonly kind: 'rtf_paragraph'
  /** 读取器块流里的段落序号（0-based）。 */
  readonly paragraph: number
  /** 逻辑页号（1-based）；只在读取器真的给出时出现。 */
  readonly page?: number
}

/** 纯文本：行号（1-based）+ 行内字符偏移（0-based）。 */
export interface TextLineOffsetLocator {
  readonly kind: 'text_line_offset'
  /** 1-based 行号。 */
  readonly line: number
  /** 行内 0-based 字符偏移。 */
  readonly offset: number
}

/** 证据定位器（D-110 联合类型）。字段形态即「可指回原文的最小信息」。 */
export type EvidenceLocator =
  | PdfPageBboxLocator
  | DocxPartParagraphLocator
  | DocxPartTableRowLocator
  | RtfParagraphLocator
  | TextLineOffsetLocator

// ---------------------------------------------------------------------------
//  证据文档 / 请求 / 结果
// ---------------------------------------------------------------------------

/** 原文里的一个可定位块（converter `blocks[]` 的证据投影）。 */
export interface EvidenceBlock {
  readonly locator: EvidenceLocator
  /** 块原文。**不预归一化**：归一化只发生在比较时，原文必须原样保留（IR-G7）。 */
  readonly text: string
}

/** 一份待核验的原文：字节 + 声明的 sha256 + 可定位块。 */
export interface EvidenceDocument {
  /** 源文件**字节级** sha256（小写 64 位 hex）。由 converter 声明，核验时独立重算。 */
  readonly source_sha256: string
  /** 源文件原始字节。空 = 不可核验（SOURCE_EMPTY）。 */
  readonly source_bytes: Uint8Array
  /** 全文块；quote 只能在块文本里命中，不能在拼接后的全文里跨块命中。 */
  readonly blocks: readonly EvidenceBlock[]
}

/** 一次核验请求：可选定位器（没给则按 quote 全文唯一命中反推位置）+ 引用原文。 */
export interface EvidenceRequest {
  /**
   * 定位器。给了就**必须**在 blocks 里唯一命中（0 个 → LOCATOR_NOT_FOUND；
   * ≥2 个 → LOCATOR_AMBIGUOUS，不取第一条）。
   */
  readonly locator?: EvidenceLocator
  /** 引用原文（逐字，允许 {@link normalizeQuote} 允许的归一化）。 */
  readonly quote: string
}

/** 拒绝原因码（封闭集；每一条都必须能落到"下一步做什么"）。 */
export type EvidenceRejectionCode =
  | 'SHA256_MISMATCH'
  | 'SOURCE_EMPTY'
  | 'SOURCE_UNREADABLE'
  | 'QUOTE_EMPTY'
  | 'LOCATOR_NOT_FOUND'
  | 'LOCATOR_AMBIGUOUS'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_AMBIGUOUS'

/**
 * 验证方式（写进证据记录，下游按证据强度区分）。
 *
 * - `LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE`：位置由定位器唯一确定（三条件全核）；
 * - `QUOTE_UNIQUE+SHA256+LITERAL_QUOTE`：没有可用定位器时，由 quote 在全文中**唯一**
 *   命中反推位置（仍要求 sha 一致 + 逐字命中；多处命中一律拒绝）。
 */
export type VerificationMethod =
  | 'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE'
  | 'QUOTE_UNIQUE+SHA256+LITERAL_QUOTE'

/** 通过：带齐 D-110 要求的 locator_kind / verification_method / 原文范围。 */
export interface VerifiedEvidence {
  readonly ok: true
  readonly locator_kind: LocatorKind
  readonly verification_method: VerificationMethod
  readonly locator: EvidenceLocator
  /** 请求里的原始 quote（原样返回，便于审计；匹配用的是归一化形式）。 */
  readonly quote: string
  readonly source_sha256: string
  /** 定位块**原始**文本（未归一化；任何复核者可用它重跑 {@link normalizeQuote}）。 */
  readonly range_text: string
  /** 匹配过程中是否发生过归一化变化（quote 或 range_text 任一被改变）。 */
  readonly normalized: boolean
}

/**
 * 拒绝。`requires_human=true` 表示这不是"修一下重试"能解决的，必须转人工裁决：
 * 哈希不符（fail-closed）、定位歧义、quote 歧义。
 */
export interface RejectedEvidence {
  readonly ok: false
  readonly reason_code: EvidenceRejectionCode
  readonly requires_human: boolean
  /** 结构化细节（候选 locator/索引、期望/实际 sha 等），便于转人工时交代清楚。 */
  readonly detail: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
//  纯函数：sha256 / 归一化 / 定位器比较
// ---------------------------------------------------------------------------

/**
 * 字节级 sha256（小写 hex）。
 * @param bytes - 源文件原始字节。
 * @returns 64 位小写十六进制。
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 契约允许的 quote 归一化。**规则写死，按顺序执行**：
 *
 * 1. `CRLF` / `CR` → `LF`（跨平台换行统一）；
 * 2. 行尾断连字符：`-` 紧跟 `LF` → 两字符一起删除（英文排版 `inter-\nnational` →
 *    `international`）。这是**唯一**允许的字符删除；
 * 3. 其余空白（空格 / 制表 / 换行 / 其它 `\s`）连续段 → 单个空格；
 * 4. 去首尾空白。
 *
 * **不允许**：大小写折叠、全角/半角或 Unicode 归一化（NFKC）、去标点、同义词替换、
 * 编辑距离/模糊匹配——那些都是「语义匹配」，D-110 明确禁止。
 *
 * @param text - 原文或 quote。
 * @returns 归一化字符串；非字符串输入按空串处理（调用方据此得到 QUOTE_EMPTY）。
 */
export function normalizeQuote(text: string): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/-\n/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 普通对象判定（数组 / null 不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * 运行时收窄：`unknown` 是不是一个**字段完整**的 {@link EvidenceLocator}。
 *
 * 用途：converter 输出 / converter 字段证据来自 JSON，类型系统管不到运行期；
 * 在构造定位器前必须机检，绝不把畸形 locator 当"已定位"。
 * @param value - 任意运行期值。
 * @returns 类型谓词。
 */
export function isEvidenceLocator(value: unknown): value is EvidenceLocator {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'pdf_page_bbox': {
      const bbox = value.bbox
      return (
        isInteger(value.page) &&
        value.page >= 1 &&
        Array.isArray(bbox) &&
        bbox.length === 4 &&
        bbox.every((n) => isFiniteNumber(n))
      )
    }
    case 'docx_part_paragraph':
      return (
        typeof value.part === 'string' &&
        value.part !== '' &&
        isInteger(value.paragraph) &&
        value.paragraph >= 0
      )
    case 'docx_part_table_row':
      return (
        typeof value.part === 'string' &&
        value.part !== '' &&
        isInteger(value.table_id) &&
        value.table_id >= 0 &&
        isInteger(value.row) &&
        value.row >= 0
      )
    case 'rtf_paragraph':
      return (
        isInteger(value.paragraph) &&
        value.paragraph >= 0 &&
        (value.page === undefined || (isInteger(value.page) && value.page >= 1))
      )
    case 'text_line_offset':
      return (
        isInteger(value.line) &&
        value.line >= 1 &&
        isInteger(value.offset) &&
        value.offset >= 0
      )
    default:
      return false
  }
}

/**
 * 两个定位器是否指同一位置。
 *
 * 语义（按 kind）：
 * - `pdf_page_bbox`：page 与 bbox 四元组逐个相等；
 * - `docx_part_paragraph`：part + paragraph 相等；
 * - `docx_part_table_row`：part + table_id + row 相等；
 * - `rtf_paragraph`：paragraph 相等；`page` 只在**双方都给出**时比较——
 *   任一方没给等于「无法区分」，不构成不同位置（见 {@link RtfParagraphLocator}）。
 *   两个带不同 page 的块仍会被视为不同定位；
 * - `text_line_offset`：line + offset 相等。
 *
 * 畸形输入（非对象、缺字段、kind 未知）一律返回 `false`：它们不能证明任何位置。
 * @param a - 定位器。
 * @param b - 定位器。
 * @returns 是否同一位置。
 */
export function sameLocator(a: EvidenceLocator, b: EvidenceLocator): boolean {
  if (!isEvidenceLocator(a) || !isEvidenceLocator(b)) return false
  switch (a.kind) {
    case 'pdf_page_bbox': {
      if (b.kind !== 'pdf_page_bbox') return false
      return a.page === b.page && a.bbox.every((value, index) => value === b.bbox[index])
    }
    case 'docx_part_paragraph': {
      if (b.kind !== 'docx_part_paragraph') return false
      return a.part === b.part && a.paragraph === b.paragraph
    }
    case 'docx_part_table_row': {
      if (b.kind !== 'docx_part_table_row') return false
      return a.part === b.part && a.table_id === b.table_id && a.row === b.row
    }
    case 'rtf_paragraph': {
      if (b.kind !== 'rtf_paragraph') return false
      if (a.paragraph !== b.paragraph) return false
      if (a.page === undefined || b.page === undefined) return true
      return a.page === b.page
    }
    case 'text_line_offset':
      return b.kind === 'text_line_offset' && a.line === b.line && a.offset === b.offset
  }
}

/**
 * 取定位器种类（证据记录必须带 `locator_kind`）。
 * @param locator - 已构造的定位器。
 * @returns `locator.kind`。
 */
export function locatorKindOf(locator: EvidenceLocator): LocatorKind {
  return locator.kind
}

// ---------------------------------------------------------------------------
//  核验
// ---------------------------------------------------------------------------

/** 构造一条拒绝（保持 detail 可序列化，便于转人工与日志）。 */
function reject(
  reason_code: EvidenceRejectionCode,
  requires_human: boolean,
  detail: Readonly<Record<string, unknown>>,
): RejectedEvidence {
  return { ok: false, reason_code, requires_human, detail }
}

/** 候选描述（歧义时列给人工；**不得**用它取第一条消解）。 */
function candidateOf(index: number, block: EvidenceBlock): Record<string, unknown> {
  return { index, locator_kind: locatorKindOf(block.locator), locator: block.locator }
}

/**
 * 核验一条证据：sha256 一致 + 定位唯一 + quote 逐字命中（D-110 三条件）。
 *
 * 执行顺序**就是规则顺序**（前一步失败即返回，绝不在失败后"尽量找一条"）：
 *
 * 1. 源字节为空 → `SOURCE_EMPTY`；非 Uint8Array → `SOURCE_UNREADABLE`；
 *    重算 sha256 与 `doc.source_sha256` 不一致 → `SHA256_MISMATCH`（requires_human，
 *    fail-closed——原文都变了，任何引用都不能信）。
 * 2. quote 归一化后为空 → `QUOTE_EMPTY`。
 * 3. 给了 locator：在 blocks 里找 `sameLocator` 的块。0 个 → `LOCATOR_NOT_FOUND`；
 *    ≥2 个 → `LOCATOR_AMBIGUOUS`（requires_human，detail 列候选）；恰好 1 个 →
 *    该块即定位范围，method = `LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE`。
 * 4. 没给 locator：按归一化 quote 在**全部 blocks** 里找命中。0 个 → `QUOTE_NOT_FOUND`；
 *    ≥2 个 → `QUOTE_AMBIGUOUS`（requires_human，detail 列候选索引/locator kind；
 *    **绝不取第一条**）；恰好 1 个 → 该块 locator 即位置，method =
 *    `QUOTE_UNIQUE+SHA256+LITERAL_QUOTE`。
 * 5. 命中块的归一化文本必须逐字包含归一化 quote；否则 `QUOTE_NOT_FOUND`。
 * 6. 通过：返回 locator_kind / verification_method / range_text（原始块文本）/
 *    normalized（是否发生归一化变化）。
 *
 * 注意：quote 只允许在**单个块内**命中，不跨块拼接——否则「这句话在该文件里」会变成
 * 「这句话由两段拼出来」，定位范围就不唯一了。
 *
 * @param doc - 源字节 + 声明 sha + 可定位块。
 * @param request - 定位器（可选）+ quote。
 * @returns 通过记录或结构化拒绝；**不抛异常**（畸形输入也转成拒绝）。
 */
export function verifyEvidence(
  doc: EvidenceDocument,
  request: EvidenceRequest,
): VerifiedEvidence | RejectedEvidence {
  // ① 原文可核 -------------------------------------------------------------
  const bytes = doc?.source_bytes
  if (!(bytes instanceof Uint8Array)) {
    return reject('SOURCE_UNREADABLE', false, {
      message: 'source_bytes is not a Uint8Array; the source cannot be re-hashed',
    })
  }
  if (bytes.length === 0) {
    return reject('SOURCE_EMPTY', false, { message: 'source_bytes is empty; nothing to re-hash' })
  }
  const actualSha = sha256Hex(bytes)
  const declaredSha = typeof doc.source_sha256 === 'string' ? doc.source_sha256 : ''
  if (actualSha !== declaredSha) {
    return reject('SHA256_MISMATCH', true, {
      expected_sha256: declaredSha,
      actual_sha256: actualSha,
      message: 'recomputed sha256 of source_bytes does not match the declared source_sha256',
    })
  }

  // ② quote 不能为空 -------------------------------------------------------
  const rawQuote = typeof request?.quote === 'string' ? request.quote : ''
  const quote = normalizeQuote(rawQuote)
  if (quote === '') {
    return reject('QUOTE_EMPTY', false, {
      quote: rawQuote,
      message: 'quote is empty after contract-allowed normalization',
    })
  }

  const blocks: readonly EvidenceBlock[] = Array.isArray(doc.blocks) ? doc.blocks : []
  const textOf = (block: EvidenceBlock): string =>
    typeof block?.text === 'string' ? block.text : ''

  // ③ 给了定位器：必须在 blocks 里唯一命中 --------------------------------
  if (request.locator !== undefined) {
    const locator = request.locator
    const matches: { index: number; block: EvidenceBlock }[] = []
    blocks.forEach((block, index) => {
      if (block !== undefined && sameLocator(block.locator, locator)) {
        matches.push({ index, block })
      }
    })
    if (matches.length === 0) {
      return reject('LOCATOR_NOT_FOUND', false, {
        locator: locator,
        locator_kind: isEvidenceLocator(locator) ? locator.kind : null,
        block_count: blocks.length,
        message: 'the locator does not match any block',
      })
    }
    if (matches.length > 1) {
      return reject('LOCATOR_AMBIGUOUS', true, {
        locator: locator,
        locator_kind: isEvidenceLocator(locator) ? locator.kind : null,
        candidates: matches.map(({ index, block }) => candidateOf(index, block)),
        message: 'the locator resolves to more than one block; refusing to take the first one',
      })
    }
    const chosen = matches[0]
    if (chosen === undefined) {
      // 理论上不可达（matches.length === 1）；保留 fail-closed。
      return reject('LOCATOR_NOT_FOUND', false, { locator: locator, block_count: blocks.length })
    }
    return finish(chosen.index, chosen.block)
  }

  // ④ 没给定位器：按 quote 全文唯一命中反推位置 ---------------------------
  const hits: { index: number; block: EvidenceBlock }[] = []
  blocks.forEach((block, index) => {
    if (normalizeQuote(textOf(block)).includes(quote)) hits.push({ index, block })
  })
  if (hits.length === 0) {
    return reject('QUOTE_NOT_FOUND', false, {
      quote_normalized: quote,
      block_count: blocks.length,
      message: 'quote does not occur literally in any block',
    })
  }
  if (hits.length > 1) {
    return reject('QUOTE_AMBIGUOUS', true, {
      quote_normalized: quote,
      candidates: hits.map(({ index, block }) => candidateOf(index, block)),
      message:
        'quote occurs in more than one block and no locator disambiguates it; ' +
        'refusing to take the first match — supply a second locator or send to a human',
    })
  }
  const chosen = hits[0]
  if (chosen === undefined) {
    return reject('QUOTE_NOT_FOUND', false, { quote_normalized: quote, block_count: blocks.length })
  }

  /** ⑤ 命中块内逐字复核 + 组装通过记录（locator 路径与 quote 路径共用）。 */
  function finish(index: number, block: EvidenceBlock): VerifiedEvidence | RejectedEvidence {
    const rangeText = textOf(block)
    const normalizedRange = normalizeQuote(rangeText)
    if (!normalizedRange.includes(quote)) {
      return reject('QUOTE_NOT_FOUND', false, {
        quote_normalized: quote,
        locator_kind: locatorKindOf(block.locator),
        block_index: index,
        message: 'quote is not contained literally in the located block range',
      })
    }
    const method: VerificationMethod =
      request.locator !== undefined
        ? 'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE'
        : 'QUOTE_UNIQUE+SHA256+LITERAL_QUOTE'
    return {
      ok: true,
      locator_kind: locatorKindOf(block.locator),
      verification_method: method,
      locator: block.locator,
      quote: rawQuote,
      source_sha256: declaredSha,
      range_text: rangeText,
      normalized: normalizedRange !== rangeText || quote !== rawQuote,
    }
  }

  return finish(chosen.index, chosen.block)
}
