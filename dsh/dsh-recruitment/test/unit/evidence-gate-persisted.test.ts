// D-110 持久化证据核验矩阵（不连库、不读真实语料；夹具全是合成文本）。
//
// 守的是 docs/17 D-110 在**读取侧**（S7 只读 DB 工具拿不到源字节/全文）的口径：
//   ① sha 链一致：材料锚点 = converter / intake / 证据记录各自声明的 sha256；
//   ② 定位唯一：持久化记录反推的 locator 在索引里只对应**一种原文**；
//   ③ quote 在定位范围内逐字命中（归一化只允许换行/空白/行断连字符）。
//   证据没声明 sha、锚点缺失、索引记录 sha 对不上 → 一律 fail-closed；
//   定位/quote 多处命中 → 转人工，**绝不取第一条**。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  derivePersistedLocator,
  verifyPersistedEvidence,
  type PersistedEvidenceDocument,
  type PersistedEvidenceRecord,
  type PersistedVerifiedEvidence,
  type RejectedEvidence,
} from '../../src/document/evidence/index.ts'

/** 材料锚点（合成值，不对应任何真实文件）。 */
const SHA = '3c12527f6aba0b2ac81702375eaee63e47d4cacb3a5573af09bb85f198eaca24'
const OTHER = 'a'.repeat(64)

const PARAGRAPH_4 = '2021-2024 Backend Engineer, Example Corp - built payment services'
const PARAGRAPH_5 = '2019-2021 Software Engineer, Sample Ltd - worked on internal tools'

/** 文档级证据索引：RTF 的 block 就是段落序号（读取器一段一个 block），page=1 是逻辑页。 */
const RTF_INDEX: readonly PersistedEvidenceRecord[] = [
  { block: 4, page: 1, text: PARAGRAPH_4, source_sha256: SHA },
  { block: 5, page: 1, text: PARAGRAPH_5, source_sha256: SHA },
]

/** 字段级证据项：converter `_evidence()` 只落 page/bbox/block/text/source_sha256。 */
const RTF_ITEM: PersistedEvidenceRecord = {
  page: 1,
  bbox: null,
  block: 4,
  text: '2021-2024 Backend Engineer',
  source_sha256: SHA,
}

/** 一份 sha 链完全自洽的 RTF 持久化证据文档（正例默认形态）。 */
function rtfDocument(
  index: readonly PersistedEvidenceRecord[] = RTF_INDEX,
): PersistedEvidenceDocument {
  return {
    source_asset_sha256: SHA,
    converter_source_sha256: SHA,
    intake_asset_sha256: SHA,
    format: 'rtf',
    index,
  }
}

/** 断言 helper：确认通过并返回记录（失败时把整条拒绝打出来，便于定位）。 */
function expectVerified(
  result: PersistedVerifiedEvidence | RejectedEvidence,
): PersistedVerifiedEvidence {
  assert.equal(result.ok, true, `expect verified, got: ${JSON.stringify(result)}`)
  if (result.ok !== true) throw new Error('unreachable')
  return result
}

/** 断言 helper：确认拒绝并检查 reason_code / requires_human。 */
function expectRejected(
  result: PersistedVerifiedEvidence | RejectedEvidence,
  reasonCode: string,
  requiresHuman?: boolean,
): RejectedEvidence {
  assert.equal(result.ok, false, `expect rejected(${reasonCode}), got verified`)
  if (result.ok !== false) throw new Error('unreachable')
  assert.equal(result.reason_code, reasonCode)
  if (requiresHuman !== undefined) assert.equal(result.requires_human, requiresHuman)
  return result
}

// ---------------------------------------------------------------------------
//  ① 正例：三条件同时成立 → 通过（locator_kind / method / range_text 齐全）
// ---------------------------------------------------------------------------

test('RTF 正例：sha 链一致 + block→paragraph 定位唯一 + quote 逐字命中 → 通过', () => {
  const verified = expectVerified(verifyPersistedEvidence(rtfDocument(), { item: RTF_ITEM }))
  assert.equal(verified.locator_kind, 'rtf_paragraph')
  assert.deepEqual(verified.locator, { kind: 'rtf_paragraph', paragraph: 4, page: 1 })
  assert.equal(verified.verification_method, 'PERSISTED_SHA_CHAIN+LOCATOR_UNIQUE+LITERAL_QUOTE')
  assert.equal(verified.quote, RTF_ITEM.text)
  assert.equal(verified.range_text, PARAGRAPH_4)
  assert.equal(verified.source_sha256, SHA)
  assert.equal(verified.normalized, false)
})

// ---------------------------------------------------------------------------
//  ② sha 链：锚点 / converter / intake / 证据记录
// ---------------------------------------------------------------------------

test('RTF 反例：证据项声明 sha=OTHER → SHA256_MISMATCH 且转人工', () => {
  const item: PersistedEvidenceRecord = { ...RTF_ITEM, source_sha256: OTHER }
  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(), { item }),
    'SHA256_MISMATCH',
    true,
  )
  assert.equal(rejected.detail.expected_sha256, SHA)
  assert.equal(rejected.detail.actual_sha256, OTHER)
})

test('材料锚点缺失 / 畸形 → SOURCE_UNREADABLE（数据不全，不是引用歧义）', () => {
  for (const anchor of [undefined, '', 'abc123', 123] as unknown[]) {
    const doc = {
      ...rtfDocument(),
      source_asset_sha256: anchor,
    } as unknown as PersistedEvidenceDocument
    const rejected = expectRejected(
      verifyPersistedEvidence(doc, { item: RTF_ITEM }),
      'SOURCE_UNREADABLE',
      false,
    )
    const message = rejected.detail.message
    assert.equal(typeof message, 'string')
    assert.ok(
      typeof message === 'string' && message.includes('anchor'),
      `message should explain the missing anchor: ${String(message)}`,
    )
  }
})

test('converter / intake 声明与锚点不符或畸形 → SHA256_MISMATCH（转人工）', () => {
  const converterRejected = expectRejected(
    verifyPersistedEvidence({ ...rtfDocument(), converter_source_sha256: OTHER }, { item: RTF_ITEM }),
    'SHA256_MISMATCH',
    true,
  )
  assert.equal(converterRejected.detail.declared_kind, 'converter')
  assert.equal(converterRejected.detail.expected_sha256, SHA)
  assert.equal(converterRejected.detail.actual_sha256, OTHER)

  const intakeRejected = expectRejected(
    verifyPersistedEvidence({ ...rtfDocument(), intake_asset_sha256: OTHER }, { item: RTF_ITEM }),
    'SHA256_MISMATCH',
    true,
  )
  assert.equal(intakeRejected.detail.declared_kind, 'intake')

  const malformedConverter = expectRejected(
    verifyPersistedEvidence(
      { ...rtfDocument(), converter_source_sha256: 'not-a-hash' },
      { item: RTF_ITEM },
    ),
    'SHA256_MISMATCH',
    true,
  )
  assert.equal(malformedConverter.detail.actual_sha256, null)
})

test('证据项没声明 sha → SHA256_MISMATCH 且 detail.declared_sha256_missing=true', () => {
  const item: PersistedEvidenceRecord = {
    page: 1,
    bbox: null,
    block: 4,
    text: '2021-2024 Backend Engineer',
  }
  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(), { item }),
    'SHA256_MISMATCH',
    false,
  )
  assert.equal(rejected.detail.declared_sha256_missing, true)
})

test('sha256 声明大小写 / 首尾空白都接受，通过记录回填小写锚点', () => {
  const doc: PersistedEvidenceDocument = {
    source_asset_sha256: `  ${SHA.toUpperCase()}  `,
    converter_source_sha256: SHA.toUpperCase(),
    intake_asset_sha256: SHA,
    format: 'rtf',
    index: [{ block: 4, page: 1, text: PARAGRAPH_4, source_sha256: SHA.toUpperCase() }],
  }
  const item: PersistedEvidenceRecord = {
    page: 1,
    bbox: null,
    block: 4,
    text: '2021-2024 Backend Engineer',
    source_sha256: ` ${SHA.toUpperCase()} `,
  }
  const verified = expectVerified(verifyPersistedEvidence(doc, { item }))
  assert.equal(verified.source_sha256, SHA)
})

// ---------------------------------------------------------------------------
//  ③ 定位唯一：找不到 / 歧义 / 重复记录
// ---------------------------------------------------------------------------

test('定位器在索引里找不到 → LOCATOR_NOT_FOUND', () => {
  const item: PersistedEvidenceRecord = { ...RTF_ITEM, block: 9 }
  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(), { item }),
    'LOCATOR_NOT_FOUND',
    false,
  )
  assert.equal(rejected.detail.block_count, 2)
  assert.deepEqual(rejected.detail.locator, { kind: 'rtf_paragraph', paragraph: 9, page: 1 })
})

test('同一定位在索引出现两条且原文不同 → LOCATOR_AMBIGUOUS（禁止取第一条）', () => {
  const index: readonly PersistedEvidenceRecord[] = [
    { block: 4, page: 1, text: PARAGRAPH_4, source_sha256: SHA },
    { block: 4, page: 1, text: '2021-2024 Backend Engineer at Another Co', source_sha256: SHA },
  ]
  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(index), { item: RTF_ITEM }),
    'LOCATOR_AMBIGUOUS',
    true,
  )
  const candidates = rejected.detail.candidates
  assert.ok(Array.isArray(candidates))
  assert.equal(candidates.length, 2)
  assert.equal(rejected.detail.locator_kind, 'rtf_paragraph')
})

test('同一定位两条但原文完全相同 → 通过（同一逻辑位置的重复记录，不是"取第一条"）', () => {
  // 两条记录指向同一段落原文：去重后只有一种原文，选哪条对"quote 是否逐字命中"都等价，
  // 因此这不构成歧义；真正危险的是"不同原文被当同一位置"（见上一条）。
  const index: readonly PersistedEvidenceRecord[] = [
    { block: 4, page: 1, text: PARAGRAPH_4, source_sha256: SHA },
    { block: 4, page: 1, text: PARAGRAPH_4, source_sha256: SHA },
  ]
  const verified = expectVerified(verifyPersistedEvidence(rtfDocument(index), { item: RTF_ITEM }))
  assert.equal(verified.range_text, PARAGRAPH_4)
  assert.deepEqual(verified.locator, { kind: 'rtf_paragraph', paragraph: 4, page: 1 })
  assert.equal(verified.verification_method, 'PERSISTED_SHA_CHAIN+LOCATOR_UNIQUE+LITERAL_QUOTE')
})

// ---------------------------------------------------------------------------
//  ④ quote 路径：唯一命中 / 歧义 / 无位置
// ---------------------------------------------------------------------------

test('无定位器 + quote 在索引恰好一条命中 → 通过，method 是 QUOTE_UNIQUE', () => {
  const item: PersistedEvidenceRecord = { text: 'payment services', source_sha256: SHA }
  const verified = expectVerified(verifyPersistedEvidence(rtfDocument(), { item }))
  assert.equal(verified.verification_method, 'PERSISTED_SHA_CHAIN+QUOTE_UNIQUE+LITERAL_QUOTE')
  assert.equal(verified.locator_kind, 'rtf_paragraph')
  assert.deepEqual(verified.locator, { kind: 'rtf_paragraph', paragraph: 4, page: 1 })
  assert.equal(verified.range_text, PARAGRAPH_4)
  assert.equal(verified.quote, 'payment services')
})

test('无定位器 + quote 在索引两条命中 → QUOTE_AMBIGUOUS（禁止取第一条）', () => {
  const item: PersistedEvidenceRecord = { text: 'Engineer', source_sha256: SHA }
  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(), { item }),
    'QUOTE_AMBIGUOUS',
    true,
  )
  const candidates = rejected.detail.candidates
  assert.ok(Array.isArray(candidates))
  assert.equal(candidates.length, 2)
  assert.equal(rejected.detail.quote_normalized, 'Engineer')
})

test('quote 唯一命中但该记录没有可用定位器 → LOCATOR_NOT_FOUND（有命中也得交代位置）', () => {
  const doc: PersistedEvidenceDocument = {
    source_asset_sha256: SHA,
    format: 'text',
    index: [{ text: 'payment services', source_sha256: SHA }],
  }
  const item: PersistedEvidenceRecord = { text: 'payment services', source_sha256: SHA }
  const rejected = expectRejected(
    verifyPersistedEvidence(doc, { item }),
    'LOCATOR_NOT_FOUND',
    false,
  )
  assert.equal(rejected.detail.block_index, 0)
})

// ---------------------------------------------------------------------------
//  ⑤ quote 取值与逐字命中
// ---------------------------------------------------------------------------

test('quote 取值顺序固定：request.quote ?? item.text ?? item.quote（空串不跳过）', () => {
  // request.quote 优先于 item.text
  const viaRequest = expectVerified(
    verifyPersistedEvidence(rtfDocument(), { item: RTF_ITEM, quote: 'payment services' }),
  )
  assert.equal(viaRequest.quote, 'payment services')

  // item.text 缺失时退回 item.quote
  const viaItemQuote = expectVerified(verifyPersistedEvidence(rtfDocument(), {
    item: { block: 4, page: 1, quote: 'Example Corp', source_sha256: SHA },
  }))
  assert.equal(viaItemQuote.quote, 'Example Corp')

  // 空串是"给了空串"，不能因为它是假值就去用 item.text（顺序固定）
  const emptyRequestQuote = expectRejected(
    verifyPersistedEvidence(rtfDocument(), { item: RTF_ITEM, quote: '' }),
    'QUOTE_EMPTY',
    false,
  )
  assert.equal(emptyRequestQuote.detail.quote, '')
})

test('quote 为空（空白串） → QUOTE_EMPTY', () => {
  const item: PersistedEvidenceRecord = { block: 4, page: 1, text: '   ', source_sha256: SHA }
  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(), { item }),
    'QUOTE_EMPTY',
    false,
  )
  assert.equal(rejected.detail.quote, '   ')
})

test('quote 不在定位原文里 → QUOTE_NOT_FOUND（detail 给 block_index / locator_kind）', () => {
  const item: PersistedEvidenceRecord = {
    page: 1,
    bbox: null,
    block: 4,
    text: 'Kubernetes',
    source_sha256: SHA,
  }
  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(), { item }),
    'QUOTE_NOT_FOUND',
    false,
  )
  assert.equal(rejected.detail.block_index, 0)
  assert.equal(rejected.detail.locator_kind, 'rtf_paragraph')
  assert.equal(rejected.detail.quote_normalized, 'Kubernetes')
})

test('归一化：quote 含 CRLF 与多空格、原文含换行 → 仍命中且 normalized=true', () => {
  const index: readonly PersistedEvidenceRecord[] = [
    { block: 4, page: 1, text: '2021-2024 Backend\nEngineer, Example Corp', source_sha256: SHA },
  ]
  const item: PersistedEvidenceRecord = {
    page: 1,
    bbox: null,
    block: 4,
    text: '2021-2024   Backend\r\nEngineer',
    source_sha256: SHA,
  }
  const verified = expectVerified(verifyPersistedEvidence(rtfDocument(index), { item }))
  assert.equal(verified.normalized, true)
  assert.equal(verified.quote, '2021-2024   Backend\r\nEngineer')
  assert.deepEqual(verified.locator, { kind: 'rtf_paragraph', paragraph: 4, page: 1 })
})

// ---------------------------------------------------------------------------
//  ⑥ 显式 locator 与分派矩阵
// ---------------------------------------------------------------------------

test('显式 locator：合法则用之；畸形 → LOCATOR_NOT_FOUND（拒绝猜位置，不降级 quote 路径）', () => {
  const valid = expectVerified(verifyPersistedEvidence(rtfDocument(), {
    item: {
      locator: { kind: 'rtf_paragraph', paragraph: 4, page: 1 },
      text: '2021-2024 Backend Engineer',
      source_sha256: SHA,
    },
  }))
  assert.deepEqual(valid.locator, { kind: 'rtf_paragraph', paragraph: 4, page: 1 })

  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(), {
      item: {
        locator: { kind: 'rtf_paragraph' },
        text: '2021-2024 Backend Engineer',
        source_sha256: SHA,
      },
    }),
    'LOCATOR_NOT_FOUND',
    false,
  )
  const message = rejected.detail.message
  assert.ok(
    typeof message === 'string' && message.includes('malformed locator'),
    `message should explain the malformed locator: ${String(message)}`,
  )
})

test('derivePersistedLocator 分派：显式 / DOCX 表格行 / DOCX 段落 / 纯文本 / PDF / 仅 RTF 的 block / 空对象', () => {
  // 显式 locator
  assert.deepEqual(
    derivePersistedLocator({
      locator: { kind: 'docx_part_paragraph', part: 'word/document.xml', paragraph: 2 },
    }),
    {
      kind: 'locator',
      locator: { kind: 'docx_part_paragraph', part: 'word/document.xml', paragraph: 2 },
    },
  )
  // DOCX 表格行
  assert.deepEqual(
    derivePersistedLocator({ part: 'word/document.xml', table_id: 1, row: 3 }),
    {
      kind: 'locator',
      locator: { kind: 'docx_part_table_row', part: 'word/document.xml', table_id: 1, row: 3 },
    },
  )
  // DOCX 段落
  assert.deepEqual(
    derivePersistedLocator({ part: 'word/document.xml', paragraph: 7 }),
    {
      kind: 'locator',
      locator: { kind: 'docx_part_paragraph', part: 'word/document.xml', paragraph: 7 },
    },
  )
  // 纯文本 line + offset
  assert.deepEqual(
    derivePersistedLocator({ line: 3, offset: 5 }),
    { kind: 'locator', locator: { kind: 'text_line_offset', line: 3, offset: 5 } },
  )
  // PDF page + bbox
  assert.deepEqual(
    derivePersistedLocator({ page: 2, bbox: [10, 20, 300, 40] }),
    { kind: 'locator', locator: { kind: 'pdf_page_bbox', page: 2, bbox: [10, 20, 300, 40] } },
  )
  // 非 rtf 的 block 不是段落，不能猜成 paragraph
  assert.deepEqual(derivePersistedLocator({ block: 4 }, 'pdf'), { kind: 'quote_search' })
  assert.deepEqual(derivePersistedLocator({ block: 4 }), { kind: 'quote_search' })
  // rtf 的 block → 段落；page 只在真的给了且 ≥1 时附带（不补默认值）
  assert.deepEqual(
    derivePersistedLocator({ block: 4 }, 'rtf'),
    { kind: 'locator', locator: { kind: 'rtf_paragraph', paragraph: 4 } },
  )
  assert.deepEqual(
    derivePersistedLocator({ block: 4, page: 2 }, 'rtf'),
    { kind: 'locator', locator: { kind: 'rtf_paragraph', paragraph: 4, page: 2 } },
  )
  // 显式 locator 畸形 → invalid（不降级成 quote_search）
  assert.deepEqual(
    derivePersistedLocator({ locator: { kind: 'rtf_paragraph' }, block: 4 }, 'rtf'),
    { kind: 'invalid' },
  )
  // 空对象 / 未知字段类型 → quote_search（不 throw）
  assert.deepEqual(derivePersistedLocator({}), { kind: 'quote_search' })
  assert.deepEqual(
    derivePersistedLocator({ paragraph: '4', block: '9' } as unknown as PersistedEvidenceRecord),
    { kind: 'quote_search' },
  )
})

// ---------------------------------------------------------------------------
//  ⑦ 索引记录的 sha 声明（不能拿不合格记录当原文范围）
// ---------------------------------------------------------------------------

test('索引里被命中的记录声明 sha=OTHER → SHA256_MISMATCH（不能拿它当原文范围）', () => {
  const index: readonly PersistedEvidenceRecord[] = [
    { block: 4, page: 1, text: PARAGRAPH_4, source_sha256: OTHER },
    { block: 5, page: 1, text: PARAGRAPH_5, source_sha256: SHA },
  ]
  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(index), { item: RTF_ITEM }),
    'SHA256_MISMATCH',
    true,
  )
  assert.equal(rejected.detail.block_index, 0)
  assert.equal(rejected.detail.actual_sha256, OTHER)
})

test('sha 声明不合格的索引记录不能作为 quote 命中物（且不静默吞掉）', () => {
  const index: readonly PersistedEvidenceRecord[] = [
    { block: 4, page: 1, text: PARAGRAPH_4, source_sha256: OTHER },
    { block: 5, page: 1, text: PARAGRAPH_5, source_sha256: SHA },
  ]
  const item: PersistedEvidenceRecord = { text: 'payment services', source_sha256: SHA }
  const rejected = expectRejected(
    verifyPersistedEvidence(rtfDocument(index), { item }),
    'QUOTE_NOT_FOUND',
    false,
  )
  assert.equal(rejected.detail.ineligible_quote_matches, 1)
  assert.equal(rejected.detail.ineligible_block_count, 1)
})

test('索引记录的真实形状（只带 quote、bbox 为空数组）仍能定位并取原文', () => {
  // `resume_version.evidence` 的行是 `{field, page, bbox:[], block, quote, source_asset_sha256, page_count}`：
  // 原文在 `quote` 而不是 `text`；`bbox: []` 是 RTF 诚实给的空数组，绝不能被当成 PDF 坐标。
  const realIndex = [
    {
      field: 'work_experience',
      page: 1,
      bbox: [],
      block: 4,
      quote: PARAGRAPH_4,
      source_asset_sha256: SHA,
      page_count: 1,
    },
    {
      field: 'education',
      page: 1,
      bbox: [],
      block: 7,
      quote: '2015-2019 B.Sc. Computer Science, Demo University',
      source_asset_sha256: SHA,
      page_count: 1,
    },
  ] as unknown as readonly PersistedEvidenceRecord[]

  // 定位器路径：字段证据 block=4，索引记录用 quote 当原文范围。
  const located = expectVerified(verifyPersistedEvidence(rtfDocument(realIndex), { item: RTF_ITEM }))
  assert.equal(located.range_text, PARAGRAPH_4)
  assert.deepEqual(located.locator, { kind: 'rtf_paragraph', paragraph: 4, page: 1 })

  // quote 路径：没有定位器，quote 只在 block 4 出现。
  const searched = expectVerified(verifyPersistedEvidence(rtfDocument(realIndex), {
    item: { text: 'payment services', source_sha256: SHA },
  }))
  assert.equal(searched.verification_method, 'PERSISTED_SHA_CHAIN+QUOTE_UNIQUE+LITERAL_QUOTE')
  assert.deepEqual(searched.locator, { kind: 'rtf_paragraph', paragraph: 4, page: 1 })
  assert.equal(searched.range_text, PARAGRAPH_4)
})

// ---------------------------------------------------------------------------
//  ⑧ 垃圾输入：不 throw，返回结构化拒绝
// ---------------------------------------------------------------------------

test('垃圾输入（null / 数组 / 字符串 / 数字）不 throw，返回 ok:false', () => {
  const garbage: readonly unknown[] = [null, [], 'doc', 42, undefined]
  for (const doc of garbage) {
    const result = verifyPersistedEvidence(
      doc as unknown as PersistedEvidenceDocument,
      { item: RTF_ITEM },
    )
    assert.equal(result.ok, false)
  }
  for (const item of garbage) {
    const result = verifyPersistedEvidence(
      rtfDocument(),
      { item: item as unknown as PersistedEvidenceRecord },
    )
    assert.equal(result.ok, false)
  }
  const nullRequest = verifyPersistedEvidence(
    rtfDocument(),
    null as unknown as { item: PersistedEvidenceRecord },
  )
  assert.equal(nullRequest.ok, false)

  assert.deepEqual(
    derivePersistedLocator(null as unknown as PersistedEvidenceRecord),
    { kind: 'quote_search' },
  )
  assert.deepEqual(
    derivePersistedLocator([] as unknown as PersistedEvidenceRecord),
    { kind: 'quote_search' },
  )
})
