// D-110「持久化证据」核验：只读 DB 工具拿不到源字节/全文时，如何复核一条已落库的证据。
//
// 与 `locator.ts::verifyEvidence` 的分工：
//   * `verifyEvidence`  —— **写入侧**核验：调用方手里有源文件字节，可独立重算 sha256；
//   * `verifyPersistedEvidence`（本文件）—— **读取侧**核验：S7 `recruitment_screening_evaluate`
//     是只读 DB 工具，只有 `resume_version.evidence`（文档级证据索引）、
//     `parsed_fields.fields[*].evidence[]`（字段级证据）以及三处 sha256 声明
//     （`resume_version.source_asset_sha256` / `parsed_fields.meta.source_sha256` /
//     `intake_asset.sha256`），**没有字节、也没有全文**，无法自己重算哈希。
//
// 因此读取侧把 D-110 的三条件改写为「持久化可复核」：
//   ① 原文可核 → **sha 链一致**：材料锚点（`doc.source_asset_sha256`，来自 resume_version，
//      接入时写入）与 converter / intake / 证据记录各自的 sha256 声明全部逐字相等；
//   ② 定位唯一 → 由持久化记录里**真实存在**的定位字段反推出唯一 locator，且该 locator 在
//      持久化索引里只对应**一种原文**（不是"一条"：同一逻辑位置的重复记录是允许的，见规则 7）；
//   ③ 原句逐字命中 → quote 落在该记录原文范围内，归一化只允许 `normalizeQuote` 写死的那几条
//      （换行 / 空白 / 行断连字符），**禁止语义/模糊/大小写匹配**。
// 命中多处 = 歧义 → 拒绝并要求转人工，**绝不取第一条**。
//
// ---------------------------------------------------------------------------
//  规则顺序（= 实现顺序；前一步失败即返回，绝不"尽量找一条"）
// ---------------------------------------------------------------------------
// 0. `doc` / `item` 畸形（非对象）→ 结构化拒绝，**永不 throw**；`request.quote` 允许缺失。
// 1. 锚点：`doc.source_asset_sha256` 必须是 64 位 hex（trim 后比较、统一小写比较，detail 给原值）。
//    缺失/畸形 → `SOURCE_UNREADABLE`（requires_human=false：多半是接入数据不全，不是歧义）。
// 2. `doc.converter_source_sha256` 存在（非 null/undefined）时必须 64 hex 且等于锚点，
//    否则 `SHA256_MISMATCH`（requires_human=true）。
// 3. `doc.intake_asset_sha256` 同上。
// 4. 证据记录声明：`item.source_sha256 ?? item.source_asset_sha256` 必须存在、64 hex、等于锚点。
//    * 声明存在但不等 → `SHA256_MISMATCH`，requires_human=true（原文可能变了，人必须看）；
//    * 缺失/畸形 → `SHA256_MISMATCH`，requires_human=false，detail 带 `declared_sha256_missing: true`
//      （这是接入数据缺字段，补数据可重试，不需要人工裁决引用是否有效）。
// 5. quote = `request.quote ?? item.text ?? item.quote`（顺序固定；**空串不跳过**——空串就是空串，
//    不能因为它是"假值"就去用下一个候选）。`normalizeQuote` 后为空 → `QUOTE_EMPTY`。
// 6. 定位器：`derivePersistedLocator(item, doc.format)` → invalid / locator / quote_search
//    （invalid 见 {@link derivePersistedLocator}：显式 locator 存在但畸形 → `LOCATOR_NOT_FOUND`，
//    detail 写明"证据自带畸形 locator，拒绝猜位置"）。
// 7. 定位器路径：在 `doc.index` 逐条反推 locator，取 `sameLocator` 的记录。
//    * 0 条 → `LOCATOR_NOT_FOUND`（detail: locator + block_count）；
//    * ≥1 条：先**逐条**核验索引记录自己的 sha 声明（与规则 4 **逐字同规则**：缺失/畸形
//      requires_human=false + `declared_sha256_missing`，声明存在但不等 requires_human=true）；
//      任一不符即返回，不拿不合格记录当原文范围；
//    * 再按 `normalizeQuote(原文)` 去重：只有 1 种归一化原文 → 定位唯一（range_text 取第一条
//      出现的原文——归一化后文本相同，谁先谁后不影响逐字命中判断）；
//      >1 种 → `LOCATOR_AMBIGUOUS`（requires_human=true，detail.candidates 列 `{index, locator, text}`）。
// 8. quote 路径（没有可用定位器）：在全部索引记录里做"归一化 quote 是否被归一化原文包含"的逐字命中；
//    **先核验索引记录 sha 声明，不合格的记录不能作为命中物**（它们不算命中，但会在 detail 里报数，
//    不静默吞掉）。
//    * 0 条 → `QUOTE_NOT_FOUND`；
//    * ≥2 条 → `QUOTE_AMBIGUOUS`（requires_human=true，detail.candidates 列 index/locator/text）；
//    * 恰好 1 条 → 对该记录反推 locator；拿不到 → `LOCATOR_NOT_FOUND`（quote 唯一但没有可交代的位置）；
//      拿到 → method = `PERSISTED_SHA_CHAIN+QUOTE_UNIQUE+LITERAL_QUOTE`。
// 9. 逐字命中：`normalizeQuote(range_text).includes(normalizedQuote)` 必须成立，否则
//    `QUOTE_NOT_FOUND`（detail: quote_normalized / block_index / locator_kind）。
// 10. 通过：locator_kind = locator.kind；method 按路径区分（定位器路径 LOCATOR_UNIQUE，否则
//    QUOTE_UNIQUE）；source_sha256 回填锚点（小写）；quote 回填**原始**引用串（未归一化）；
//    normalized = 原文或 quote 在比较时被归一化改动过。
// 11. `indexTextOf(record)` = `record.text`（字符串）?? `record.quote`（字符串）?? `''`。
//
// ---------------------------------------------------------------------------
//  容量边界（必须诚实说明，别把"内部自洽"当成"原文已核"）
// ---------------------------------------------------------------------------
// * **sha 链只能证明声明自洽，不能证明哈希为真**：若接入时把挂错文件的 sha 同时写进
//   resume_version 与全部证据记录，本函数会通过。它的职责是"同一份材料 + 同一条引用"的内部
//   一致性；字节级重算仍是写入侧 `verifyEvidence` 的事（因此接入必须原子写入，见 intake）。
// * **`block` → `paragraph` 只在 `format === 'rtf'` 时成立**：RTF 读取器的 `blocks[]` 是**段落流**
//   （`rtf_reader.py` 每个非空段落一个 block），所以字段证据里的 `block` 就是段落序号。
//   PDF 的 block 是页/文本块，DOCX 的 block 是部件内的版式块——把它们猜成段落号就是伪造位置，
//   因此本分支**只**对 `format='rtf'` 启用；其余格式的 block 一律落到 quote 路径（fail-closed）。
//   `block_id` / `block_no` 同理：它们是"字段归属块编号"（agent 证据引用 `fields[*].block_ids`），
//   不是定位器，**不**转成 paragraph。
// * 索引记录与请求记录的 `text` 必须是**同一粒度**（段落/行/表格行文本），否则逐字包含比较会
//   退化成 QUOTE_NOT_FOUND——宁可否证，也不做跨记录拼接或近似匹配。
// * 规则 7 的去重按"归一化原文"而非原始字节：两条记录原文只差空白/换行时视为同一位置；
//   原文真的不同（哪怕是同 locator 的脏数据）→ 歧义转人工。
//
// 本文件是纯函数：不读文件、不连库、不起子进程、不 throw。
import {
  isEvidenceLocator,
  normalizeQuote,
  sameLocator,
  type EvidenceLocator,
  type EvidenceRejectionCode,
  type LocatorKind,
  type RejectedEvidence,
} from './locator.ts'

// ---------------------------------------------------------------------------
//  持久化证据的形状
// ---------------------------------------------------------------------------

/** 媒体格式提示（决定 RTF 的 block→paragraph 分支是否启用，见文件头容量边界）。 */
export type PersistedFormat = 'rtf' | 'pdf' | 'docx' | 'text'

/**
 * 一条持久化证据记录（文档级索引项或字段级证据项；两者形状同族，字段都可缺）。
 *
 * 字段来源（converter）：`_evidence()` 只写 `{page, bbox, block, text, source_sha256}`，
 * RTF 读取器的块位置是 `{paragraph}`；接入层补充 `source_asset_sha256` / `locator` 等。
 * 所有字段都是**声明**，本模块只按"字段真的存在才用"消费，绝不补默认值。
 */
export interface PersistedEvidenceRecord {
  readonly page?: number | null
  readonly bbox?: readonly number[] | null
  readonly block?: number
  readonly block_id?: number
  readonly block_no?: number
  readonly paragraph?: number
  readonly part?: string
  readonly table_id?: number
  readonly row?: number
  readonly line?: number
  readonly offset?: number
  readonly text?: string
  readonly quote?: string
  readonly source?: string
  readonly field?: string
  readonly source_sha256?: string
  readonly source_asset_sha256?: string
  readonly locator?: unknown
}

/** 一份待核验的持久化证据文档：材料锚点 + 声明的哈希 + 文档级证据索引。 */
export interface PersistedEvidenceDocument {
  /** 材料锚点 sha256（resume_version.source_asset_sha256；接入时写入）。 */
  readonly source_asset_sha256: string
  /** converter 声明的源文件 sha256（`parsed_fields.meta.source_sha256`）。 */
  readonly converter_source_sha256?: string
  /** intake 声明的源文件 sha256（`intake_asset.sha256`）。 */
  readonly intake_asset_sha256?: string
  /** 媒体格式；只影响 RTF 的 block 分派（见文件头容量边界）。 */
  readonly format?: PersistedFormat
  /** 文档级证据索引（`resume_version.evidence`）。没有可用索引时按空数组处理。 */
  readonly index: readonly PersistedEvidenceRecord[]
}

/** 从持久化记录反推定位器的结果。 */
export type DerivedPersistedLocator =
  /** 拿到了可用于唯一性判断的定位器。 */
  | { readonly kind: 'locator'; readonly locator: EvidenceLocator }
  /** 没有定位字段：交给 quote 唯一命中反推位置。 */
  | { readonly kind: 'quote_search' }
  /** 显式 locator 存在但畸形：fail-closed，拒绝猜位置（不能降级成 quote_search）。 */
  | { readonly kind: 'invalid' }

/**
 * 持久化证据的核验方式（与 `locator.ts::VerificationMethod` 同构，但前缀标明"持久化 sha 链"，
 * 审计时能一眼分清"字节级重算"与"声明链一致"）。
 */
export type PersistedVerificationMethod =
  | 'PERSISTED_SHA_CHAIN+LOCATOR_UNIQUE+LITERAL_QUOTE'
  | 'PERSISTED_SHA_CHAIN+QUOTE_UNIQUE+LITERAL_QUOTE'

/** 通过：带齐 locator / 核验方式 / 原文范围，供 S7 落 `ScreenEvidence`。 */
export interface PersistedVerifiedEvidence {
  readonly ok: true
  readonly locator_kind: LocatorKind
  readonly verification_method: PersistedVerificationMethod
  readonly locator: EvidenceLocator
  /** 请求里的原始 quote（未归一化，便于审计）。 */
  readonly quote: string
  /** 材料锚点 sha256（小写）。 */
  readonly source_sha256: string
  /** 定位记录**原始**文本（未归一化；复核者可自己重跑 normalizeQuote）。 */
  readonly range_text: string
  /** 比较时是否发生过归一化改动（原文或 quote 任一被改）。 */
  readonly normalized: boolean
}

const METHOD_LOCATOR: PersistedVerificationMethod = 'PERSISTED_SHA_CHAIN+LOCATOR_UNIQUE+LITERAL_QUOTE'
const METHOD_QUOTE: PersistedVerificationMethod = 'PERSISTED_SHA_CHAIN+QUOTE_UNIQUE+LITERAL_QUOTE'

// ---------------------------------------------------------------------------
//  运行期收窄（持久化数据来自 JSONB，类型系统管不到）
// ---------------------------------------------------------------------------

/** 普通对象判定（数组 / null 不算）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 非空字符串（返回**原值**，不 trim：part 是身份的一部分，trim 会改变它）。 */
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 整数（含负数；调用方自己判下界）。 */
function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/** 4 个有限数才算坐标。 */
function asBbox(value: unknown): readonly [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  return [value[0] as number, value[1] as number, value[2] as number, value[3] as number]
}

/** 64 位十六进制 sha256（大小写都接受；只接受**连续 64 位**，不剥内部空白）。 */
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/

/** sha256 声明 → 小写规范化值；缺失/畸形 → `undefined`（调用方自己决定拒绝码）。 */
function normalizeSha256(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return SHA256_HEX_RE.test(trimmed) ? trimmed.toLowerCase() : undefined
}

/** 记录原文（规则 11）：`text` 优先，其次 `quote`，都没有则空串。 */
function indexTextOf(raw: Record<string, unknown>): string {
  if (typeof raw.text === 'string') return raw.text
  if (typeof raw.quote === 'string') return raw.quote
  return ''
}

/** 持久化索引：非数组按空处理（后续按"没有候选位置" fail-closed，不 throw）。 */
function indexRecordsOf(documentRaw: Record<string, unknown>): readonly unknown[] {
  const index = documentRaw.index
  return Array.isArray(index) ? index : []
}

/** 格式提示收窄：未知格式一律当作"未给"（不启用 RTF block 分支）。 */
function formatOf(documentRaw: Record<string, unknown>): PersistedFormat | undefined {
  const format = documentRaw.format
  return format === 'rtf' || format === 'pdf' || format === 'docx' || format === 'text'
    ? format
    : undefined
}

// ---------------------------------------------------------------------------
//  定位器反推
// ---------------------------------------------------------------------------

/**
 * 持久化记录 → 定位器（分派顺序；**字段真的存在才用，绝不补默认值**）：
 *
 * 1. `record.locator` 显式给出（`null` 视为"未给出"——本族接口用 null 表示缺失）：
 *    `isEvidenceLocator` 通过则用之，否则 `{kind:'invalid'}`（fail-closed，不降级去猜）；
 * 2. `part` 非空 + `table_id` 整数≥0 + `row` 整数≥0 → `docx_part_table_row`；
 * 3. `part` 非空 + `paragraph` 整数≥0 → `docx_part_paragraph`；
 * 4. `paragraph` 整数≥0（无 part）→ `rtf_paragraph`（`page` 整数≥1 时作为附加约束带上）；
 * 5. `line` 整数≥1 + `offset` 整数≥0 → `text_line_offset`；
 * 6. `format === 'rtf'` 且 `block` 整数≥0 → `rtf_paragraph{paragraph: block, ...(page≥1 ? page)}`。
 *    前提：RTF 读取器的 blocks 是段落流（一段一个 block），block 下标即段落序号。
 *    **只**在 format 明确是 rtf 时启用——PDF/DOCX 的 block 不是段落（见文件头容量边界）；
 * 7. `page` 整数≥1 + `bbox` 是 4 个有限数 → `pdf_page_bbox`（否则 bbox 不是坐标，不猜）；
 * 8. 都不满足 → `{kind:'quote_search'}`。
 *
 * 畸形输入（非对象 / 字段类型不对）不得 throw：未知类型字段按"不存在"跳过。
 *
 * @param record - 持久化证据记录（运行期可能来自 JSONB，按形状收窄）。
 * @param format - 媒体格式提示；省略时只按字段分派（不启用 block→paragraph）。
 * @returns 反推结果（locator / quote_search / invalid）。
 */
export function derivePersistedLocator(
  record: PersistedEvidenceRecord,
  format?: PersistedFormat,
): DerivedPersistedLocator {
  const raw = asRecord(record)
  if (raw === undefined) return { kind: 'quote_search' }
  return deriveLocatorFromRecord(raw, format)
}

/** {@link derivePersistedLocator} 的实现体（入参已收窄成普通对象）。 */
function deriveLocatorFromRecord(
  raw: Record<string, unknown>,
  format?: PersistedFormat,
): DerivedPersistedLocator {
  // 1) 显式 locator：null/undefined = 未给出；给了但不是合法 locator → invalid。
  const explicit = raw.locator
  if (explicit !== undefined && explicit !== null) {
    return isEvidenceLocator(explicit)
      ? { kind: 'locator', locator: explicit }
      : { kind: 'invalid' }
  }

  const part = asNonEmptyString(raw.part)
  const paragraph = asInteger(raw.paragraph)
  const tableId = asInteger(raw.table_id)
  const row = asInteger(raw.row)
  const page = asInteger(raw.page)
  const locatedPage = page !== undefined && page >= 1 ? page : undefined
  const line = asInteger(raw.line)
  const offset = asInteger(raw.offset)

  // 2) DOCX 表格行：part + table_id + row。
  if (part !== undefined && tableId !== undefined && tableId >= 0 && row !== undefined && row >= 0) {
    return { kind: 'locator', locator: { kind: 'docx_part_table_row', part, table_id: tableId, row } }
  }
  // 3) DOCX 段落：part + paragraph。
  if (part !== undefined && paragraph !== undefined && paragraph >= 0) {
    return { kind: 'locator', locator: { kind: 'docx_part_paragraph', part, paragraph } }
  }
  // 4) RTF 段落：paragraph（无 part）。page 只在真的给了且 ≥1 时附带，绝不补 1。
  if (paragraph !== undefined && paragraph >= 0) {
    return {
      kind: 'locator',
      locator: locatedPage === undefined
        ? { kind: 'rtf_paragraph', paragraph }
        : { kind: 'rtf_paragraph', paragraph, page: locatedPage },
    }
  }
  // 5) 纯文本：line + offset。
  if (line !== undefined && line >= 1 && offset !== undefined && offset >= 0) {
    return { kind: 'locator', locator: { kind: 'text_line_offset', line, offset } }
  }
  // 6) RTF 块号 → 段落（只有 format='rtf' 成立，见文件头容量边界）。
  if (format === 'rtf') {
    const block = asInteger(raw.block)
    if (block !== undefined && block >= 0) {
      return {
        kind: 'locator',
        locator: locatedPage === undefined
          ? { kind: 'rtf_paragraph', paragraph: block }
          : { kind: 'rtf_paragraph', paragraph: block, page: locatedPage },
      }
    }
  }
  // 7) PDF 坐标：page≥1 + bbox 四元组。
  const bbox = asBbox(raw.bbox)
  if (locatedPage !== undefined && bbox !== undefined) {
    return { kind: 'locator', locator: { kind: 'pdf_page_bbox', page: locatedPage, bbox } }
  }
  // 8) 没有定位字段：交给 quote 唯一命中反推。
  return { kind: 'quote_search' }
}

// ---------------------------------------------------------------------------
//  核验
// ---------------------------------------------------------------------------

/** 构造一条拒绝（detail 必须可序列化，便于转人工与日志）。 */
function reject(
  reasonCode: EvidenceRejectionCode,
  requiresHuman: boolean,
  detail: Readonly<Record<string, unknown>>,
): RejectedEvidence {
  return { ok: false, reason_code: reasonCode, requires_human: requiresHuman, detail }
}

/** sha 声明的核验对象：请求里的证据项 / 索引里的记录（detail 里要能分辨）。 */
interface ShaSubject {
  readonly subject: 'evidence_item' | 'index_record'
  /** 索引下标（仅 index_record）。 */
  readonly blockIndex?: number
}

/**
 * 核验一条记录的 sha256 声明是否链到材料锚点（规则 4 / 规则 7 共用，语义逐字一致）。
 *
 * - 声明缺失 / 畸形 → `SHA256_MISMATCH`，requires_human=false，
 *   detail 带 `declared_sha256_missing: true`（补数据可重试，不是引用歧义）；
 * - 声明存在但**不等于**锚点 → `SHA256_MISMATCH`，requires_human=true（原文可能换了，人必须看）。
 *
 * @param raw - 已收窄的记录对象。
 * @param anchor - 已规范化（小写 64 hex）的材料锚点。
 * @param subject - 核验对象（用于 detail 区分证据项与索引记录）。
 * @returns 拒绝记录；合格时 `undefined`。
 */
function checkRecordSha(
  raw: Record<string, unknown>,
  anchor: string,
  subject: ShaSubject,
): RejectedEvidence | undefined {
  const declaredRaw = raw.source_sha256 ?? raw.source_asset_sha256
  const declared = normalizeSha256(declaredRaw)
  const base: Record<string, unknown> = { subject: subject.subject }
  if (subject.blockIndex !== undefined) base.block_index = subject.blockIndex

  if (declared === undefined) {
    const detail: Record<string, unknown> = {
      ...base,
      declared_sha256_missing: true,
      message: declaredRaw === undefined || declaredRaw === null
        ? 'the evidence record declares no sha256 (neither source_sha256 nor source_asset_sha256); '
          + 'there is nothing to chain to the material anchor'
        : 'the evidence record sha256 declaration is not a 64-hex digest; '
          + 'it cannot be chained to the material anchor',
    }
    if (declaredRaw !== undefined && declaredRaw !== null) detail.declared_sha256 = declaredRaw
    return reject('SHA256_MISMATCH', false, detail)
  }

  if (declared !== anchor) {
    const detail: Record<string, unknown> = {
      ...base,
      expected_sha256: anchor,
      actual_sha256: declared,
      message: 'the evidence record declares a sha256 that differs from the material anchor; '
        + 'fail-closed: the quoted text cannot be trusted for this material',
    }
    if (typeof declaredRaw === 'string') detail.declared_sha256 = declaredRaw
    return reject('SHA256_MISMATCH', true, detail)
  }

  return undefined
}

/** 一次核验的稳定上下文（sha 链已过 + quote 已归一化 + 索引已收窄）。 */
interface VerifyContext {
  readonly anchor: string
  readonly rawQuote: string
  readonly quote: string
  readonly format?: PersistedFormat
  readonly index: readonly unknown[]
}

/** 定位器路径的命中记录。 */
interface LocatedRecord {
  readonly index: number
  readonly locator: EvidenceLocator
  readonly text: string
  readonly raw: Record<string, unknown>
}

/** quote 路径的命中记录。 */
interface QuoteHit {
  readonly index: number
  readonly text: string
  readonly derived: DerivedPersistedLocator
}

/** 歧义候选（**只用于交代，不得用它取第一条**）。 */
interface AmbiguousCandidate {
  readonly index: number
  readonly locator: EvidenceLocator | null
  readonly locator_kind: LocatorKind | null
  readonly text: string
}

/** 候选投影：拿不到 locator 的命中也要如实写 null，不伪造位置。 */
function candidateOf(
  index: number,
  text: string,
  derived: DerivedPersistedLocator,
): AmbiguousCandidate {
  return derived.kind === 'locator'
    ? { index, locator: derived.locator, locator_kind: derived.locator.kind, text }
    : { index, locator: null, locator_kind: null, text }
}

/**
 * 规则 9 / 10：逐字命中复核 + 组装通过记录（定位器路径与 quote 路径共用）。
 *
 * @param context - 核验上下文。
 * @param blockIndex - 定位记录在 `doc.index` 里的下标（quote 不见时写进 detail）。
 * @param locator - 定位器。
 * @param rangeText - 定位记录的**原始**文本。
 * @param method - 本次走的核验方式。
 */
function finishPersisted(
  context: VerifyContext,
  blockIndex: number,
  locator: EvidenceLocator,
  rangeText: string,
  method: PersistedVerificationMethod,
): PersistedVerifiedEvidence | RejectedEvidence {
  const normalizedRange = normalizeQuote(rangeText)
  if (!normalizedRange.includes(context.quote)) {
    return reject('QUOTE_NOT_FOUND', false, {
      quote_normalized: context.quote,
      block_index: blockIndex,
      locator_kind: locator.kind,
      message: 'quote is not contained literally in the persisted range text',
    })
  }
  return {
    ok: true,
    locator_kind: locator.kind,
    verification_method: method,
    locator,
    quote: context.rawQuote,
    source_sha256: context.anchor,
    range_text: rangeText,
    normalized: normalizedRange !== rangeText || context.quote !== context.rawQuote,
  }
}

/**
 * 规则 7：定位器路径。定位器在索引里唯一对应**一种原文**才算通过；
 * 同一 locator 出现多条但原文相同 = 同一逻辑位置的重复记录（不是歧义，也不是"取第一条"：
 * 它们指向同一段原文，选哪条对 `range_text` 的逐字命中判断都等价）；原文不同 = 歧义转人工。
 */
function verifyWithLocator(
  locator: EvidenceLocator,
  context: VerifyContext,
): PersistedVerifiedEvidence | RejectedEvidence {
  const matches: LocatedRecord[] = []
  context.index.forEach((rawRecord, index) => {
    const raw = asRecord(rawRecord)
    if (raw === undefined) return
    const derived = deriveLocatorFromRecord(raw, context.format)
    if (derived.kind !== 'locator') return
    if (!sameLocator(derived.locator, locator)) return
    matches.push({ index, locator: derived.locator, text: indexTextOf(raw), raw })
  })

  if (matches.length === 0) {
    return reject('LOCATOR_NOT_FOUND', false, {
      locator,
      locator_kind: locator.kind,
      block_count: context.index.length,
      message: 'the locator does not match any persisted evidence record; '
        + 'there is no original range to check the quote against',
    })
  }

  // 逐条核验索引记录自己的 sha 声明：不合格的记录不能当原文范围。
  for (const match of matches) {
    const rejection = checkRecordSha(match.raw, context.anchor, {
      subject: 'index_record',
      blockIndex: match.index,
    })
    if (rejection !== undefined) return rejection
  }

  // 按归一化原文去重；>1 种 = 歧义（禁止取第一条）。
  const distinct = new Map<string, { index: number; locator: EvidenceLocator; text: string }>()
  for (const match of matches) {
    const key = normalizeQuote(match.text)
    if (!distinct.has(key)) distinct.set(key, match)
  }
  if (distinct.size > 1) {
    return reject('LOCATOR_AMBIGUOUS', true, {
      locator,
      locator_kind: locator.kind,
      candidates: matches.map((match) => candidateOf(match.index, match.text, {
        kind: 'locator',
        locator: match.locator,
      })),
      message: 'the locator resolves to more than one persisted evidence record with different text; '
        + 'refusing to take the first one — supply a second locator or send to a human',
    })
  }

  let chosen: { index: number; locator: EvidenceLocator; text: string } | undefined
  for (const value of distinct.values()) {
    chosen = value
    break
  }
  if (chosen === undefined) {
    // 理论上不可达（matches.length ≥ 1 且 distinct.size ≤ 1）；保留 fail-closed。
    return reject('LOCATOR_NOT_FOUND', false, {
      locator,
      locator_kind: locator.kind,
      block_count: context.index.length,
    })
  }
  return finishPersisted(context, chosen.index, chosen.locator, chosen.text, METHOD_LOCATOR)
}

/**
 * 规则 8：quote 路径（没有可用定位器时，用 quote 在持久化原文里的**唯一**逐字命中反推位置）。
 *
 * 不合格（sha 声明链不上锚点）的记录不参与命中；若它们里本来有 quote 字面命中，
 * 只在 detail 报数，不静默吞掉（人工据此判断是数据缺失还是引用错位）。
 */
function verifyWithQuoteSearch(context: VerifyContext): PersistedVerifiedEvidence | RejectedEvidence {
  const hits: QuoteHit[] = []
  let ineligibleBlockCount = 0
  let ineligibleQuoteMatches = 0

  context.index.forEach((rawRecord, index) => {
    const raw = asRecord(rawRecord)
    if (raw === undefined) return
    const text = indexTextOf(raw)
    const rejection = checkRecordSha(raw, context.anchor, {
      subject: 'index_record',
      blockIndex: index,
    })
    const contains = normalizeQuote(text).includes(context.quote)
    if (rejection !== undefined) {
      ineligibleBlockCount += 1
      if (contains) ineligibleQuoteMatches += 1
      return
    }
    if (contains) hits.push({ index, text, derived: deriveLocatorFromRecord(raw, context.format) })
  })

  if (hits.length === 0) {
    return reject('QUOTE_NOT_FOUND', false, {
      quote_normalized: context.quote,
      block_count: context.index.length,
      ineligible_block_count: ineligibleBlockCount,
      ineligible_quote_matches: ineligibleQuoteMatches,
      message: 'quote does not occur literally in any eligible persisted evidence record',
    })
  }
  if (hits.length > 1) {
    return reject('QUOTE_AMBIGUOUS', true, {
      quote_normalized: context.quote,
      candidates: hits.map((hit) => candidateOf(hit.index, hit.text, hit.derived)),
      message: 'quote occurs in more than one persisted evidence record and no locator disambiguates it; '
        + 'refusing to take the first match — supply a second locator or send to a human',
    })
  }

  const hit = hits[0]
  if (hit === undefined) {
    // 理论上不可达（hits.length === 1）；保留 fail-closed。
    return reject('QUOTE_NOT_FOUND', false, {
      quote_normalized: context.quote,
      block_count: context.index.length,
    })
  }
  if (hit.derived.kind !== 'locator') {
    return reject('LOCATOR_NOT_FOUND', false, {
      quote_normalized: context.quote,
      block_index: hit.index,
      message: 'the quote matches exactly one persisted record, but that record carries no usable '
        + 'locator; there is no position to report for the quote',
    })
  }
  return finishPersisted(context, hit.index, hit.derived.locator, hit.text, METHOD_QUOTE)
}

/**
 * 核验一条持久化证据（D-110 读取侧口径；规则顺序见文件头）。
 *
 * @param doc - 材料锚点 + converter/intake 哈希声明 + 文档级证据索引。
 * @param request - 待核证据项 + 可选 quote（缺省时按 `item.text ?? item.quote` 取）。
 * @returns 通过记录或结构化拒绝；**不抛异常**（畸形输入也转成拒绝）。
 */
export function verifyPersistedEvidence(
  doc: PersistedEvidenceDocument,
  request: { readonly item: PersistedEvidenceRecord; readonly quote?: string },
): PersistedVerifiedEvidence | RejectedEvidence {
  // ⓪ 畸形输入：一律结构化拒绝，不 throw。
  const documentRaw = asRecord(doc)
  if (documentRaw === undefined) {
    return reject('SOURCE_UNREADABLE', false, {
      message: 'the persisted evidence document is not an object; there is no anchor to verify against',
    })
  }
  const requestRaw = asRecord(request)
  const itemRaw = requestRaw === undefined ? undefined : asRecord(requestRaw.item)
  if (itemRaw === undefined) {
    return reject('LOCATOR_NOT_FOUND', false, {
      message: 'the persisted evidence record is not an object; '
        + 'refusing to guess a position for malformed evidence',
    })
  }

  // ① 材料锚点：没有它，任何"可复核"都是空话。
  const anchorRaw = documentRaw.source_asset_sha256
  const anchor = normalizeSha256(anchorRaw)
  if (anchor === undefined) {
    return reject('SOURCE_UNREADABLE', false, {
      declared_sha256: anchorRaw === undefined ? null : anchorRaw,
      message: 'no material anchor sha256 (resume_version.source_asset_sha256) is available; '
        + 'without it the persisted evidence cannot be verified — treat the material as unread',
    })
  }

  // ② converter 声明：存在就必须与锚点一致（两处声明分叉 = 接入写错，人必须看）。
  const converterRaw = documentRaw.converter_source_sha256
  if (converterRaw !== undefined && converterRaw !== null) {
    const converter = normalizeSha256(converterRaw)
    if (converter === undefined || converter !== anchor) {
      return reject('SHA256_MISMATCH', true, {
        declared_kind: 'converter',
        expected_sha256: anchor,
        actual_sha256: converter ?? null,
        declared_sha256: converterRaw,
        message: 'doc.converter_source_sha256 disagrees with the material anchor sha256; '
          + 'the converter declaration and the stored material are not the same bytes',
      })
    }
  }

  // ③ intake 声明：同上。
  const intakeRaw = documentRaw.intake_asset_sha256
  if (intakeRaw !== undefined && intakeRaw !== null) {
    const intake = normalizeSha256(intakeRaw)
    if (intake === undefined || intake !== anchor) {
      return reject('SHA256_MISMATCH', true, {
        declared_kind: 'intake',
        expected_sha256: anchor,
        actual_sha256: intake ?? null,
        declared_sha256: intakeRaw,
        message: 'doc.intake_asset_sha256 disagrees with the material anchor sha256; '
          + 'the intake declaration and the stored material are not the same bytes',
      })
    }
  }

  // ④ 证据记录自己的 sha 声明。
  const itemRejection = checkRecordSha(itemRaw, anchor, { subject: 'evidence_item' })
  if (itemRejection !== undefined) return itemRejection

  // ⑤ quote：顺序固定为 request.quote ?? item.text ?? item.quote；空串不跳过。
  const requestQuote = requestRaw?.quote
  const quoteCandidate = requestQuote ?? itemRaw.text ?? itemRaw.quote
  const rawQuote = typeof quoteCandidate === 'string' ? quoteCandidate : ''
  const quote = normalizeQuote(rawQuote)
  if (quote === '') {
    return reject('QUOTE_EMPTY', false, {
      quote: rawQuote,
      message: 'the quote is empty after contract-allowed normalization; '
        + 'there is no sentence to verify against the original',
    })
  }

  const context: VerifyContext = {
    anchor,
    rawQuote,
    quote,
    format: formatOf(documentRaw),
    index: indexRecordsOf(documentRaw),
  }

  // ⑥ 定位器分派。
  const derived = deriveLocatorFromRecord(itemRaw, context.format)
  if (derived.kind === 'invalid') {
    return reject('LOCATOR_NOT_FOUND', false, {
      locator: itemRaw.locator,
      message: 'the evidence record carries a malformed locator; refusing to guess a position',
    })
  }
  return derived.kind === 'locator'
    ? verifyWithLocator(derived.locator, context)
    : verifyWithQuoteSearch(context)
}
