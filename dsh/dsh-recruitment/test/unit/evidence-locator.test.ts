// D-110 证据定位器的纯函数矩阵（不连库、不起 Python、不读真实语料）。
//
// 守的是 docs/17 D-110 的三条件与两条红线：
//   1. sha256 独立重算不一致 → 拒绝（fail-closed，requires_human）；
//   2. 定位/quote 多处命中 = 歧义 → 拒绝（requires_human），**绝不取第一条**；
//   3. 无坐标格式（RTF paragraph / 纯文本 line+offset）只要三条件成立就必须能通过——
//      「缺 bbox」不是拒绝理由。
//
// 夹具全部是合成文本（示例姓名/电话/邮箱），不含真实候选人资料。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  evidenceBlocksFromConverter,
  evidenceContextFromConverter,
  isEvidenceLocator,
  locatorFromConverterLocation,
  locatorKindOf,
  normalizeQuote,
  sameLocator,
  sha256Hex,
  verifyEvidence,
  type EvidenceBlock,
  type EvidenceDocument,
  type EvidenceLocator,
} from '../../src/document/evidence/index.ts'
import { observeIdentity } from '../../src/db/identity.ts'

const encoder = new TextEncoder()

/** 造一份可核验原文：sha 与字节自洽（正例的默认形态）。 */
function documentWith(
  blocks: readonly EvidenceBlock[],
  bytesText = 'synthetic source bytes (not a real resume)',
): EvidenceDocument {
  const bytes = encoder.encode(bytesText)
  return { source_sha256: sha256Hex(bytes), source_bytes: bytes, blocks }
}

/** RTF 形状的块（无 bbox，只有 paragraph；单页时 page=1）。 */
const RTF_BLOCKS: readonly EvidenceBlock[] = [
  { locator: { kind: 'rtf_paragraph', paragraph: 0, page: 1 }, text: 'SYNTHETIC SAMPLE - NOT A REAL RESUME' },
  { locator: { kind: 'rtf_paragraph', paragraph: 1, page: 1 }, text: 'Name: Li Example' },
  { locator: { kind: 'rtf_paragraph', paragraph: 2, page: 1 }, text: 'Phone: 13900001111' },
  { locator: { kind: 'rtf_paragraph', paragraph: 3, page: 1 }, text: 'Email: li.example@example.test' },
]

/** 断言 helper：确认通过并返回记录（失败时把整条拒绝打出来，便于定位）。 */
function expectVerified(result: ReturnType<typeof verifyEvidence>) {
  assert.equal(result.ok, true, `expect verified, got: ${JSON.stringify(result)}`)
  if (result.ok !== true) throw new Error('unreachable')
  return result
}

/** 断言 helper：确认拒绝并检查 reason_code / requires_human。 */
function expectRejected(
  result: ReturnType<typeof verifyEvidence>,
  reasonCode: string,
  requiresHuman?: boolean,
) {
  assert.equal(result.ok, false, `expect rejected(${reasonCode}), got verified`)
  if (result.ok !== false) throw new Error('unreachable')
  assert.equal(result.reason_code, reasonCode)
  if (requiresHuman !== undefined) assert.equal(result.requires_human, requiresHuman)
  return result
}

// ---------------------------------------------------------------------------
//  ① 五种 locator 正例（三条件同时成立 → 通过，带 locator_kind + method）
// ---------------------------------------------------------------------------

test('五种 locator 正例：pdf / docx 段落 / docx 表格行 / rtf / 纯文本都可通过', () => {
  const pdfLocator: EvidenceLocator = { kind: 'pdf_page_bbox', page: 3, bbox: [10, 20, 300, 40] }
  const docxParagraphLocator: EvidenceLocator = {
    kind: 'docx_part_paragraph',
    part: 'word/document.xml',
    paragraph: 4,
  }
  const docxTableRowLocator: EvidenceLocator = {
    kind: 'docx_part_table_row',
    part: 'word/document.xml',
    table_id: 1,
    row: 2,
  }
  const rtfLocator: EvidenceLocator = { kind: 'rtf_paragraph', paragraph: 2, page: 1 }
  const textLocator: EvidenceLocator = { kind: 'text_line_offset', line: 7, offset: 0 }

  const cases: readonly {
    readonly name: string
    readonly locator: EvidenceLocator
    readonly blockText: string
    readonly quote: string
  }[] = [
    { name: 'pdf_page_bbox', locator: pdfLocator, blockText: 'Education: Example University', quote: 'Example University' },
    { name: 'docx_part_paragraph', locator: docxParagraphLocator, blockText: 'Phone: 13900001111', quote: '13900001111' },
    { name: 'docx_part_table_row', locator: docxTableRowLocator, blockText: '2020.07 | Example Ltd | Engineer', quote: 'Example Ltd' },
    { name: 'rtf_paragraph', locator: rtfLocator, blockText: 'Email: li.example@example.test', quote: 'li.example@example.test' },
    { name: 'text_line_offset', locator: textLocator, blockText: 'Work experience', quote: 'Work experience' },
  ]

  for (const item of cases) {
    const doc = documentWith([{ locator: item.locator, text: item.blockText }])
    const result = expectVerified(verifyEvidence(doc, { locator: item.locator, quote: item.quote }))
    assert.equal(result.locator_kind, item.locator.kind, item.name)
    assert.equal(result.verification_method, 'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE', item.name)
    assert.deepEqual(result.locator, item.locator, item.name)
    assert.equal(result.range_text, item.blockText, 'range_text 必须是原始块文本')
    assert.equal(result.source_sha256, doc.source_sha256)
    assert.equal(result.normalized, false, '逐字命中时 normalized 必须为 false')
  }
})

// ---------------------------------------------------------------------------
//  ② 条件①：原文可核
// ---------------------------------------------------------------------------

test('sha256 不一致 → SHA256_MISMATCH（requires_human=true，fail-closed）', () => {
  const doc = documentWith([{ locator: { kind: 'rtf_paragraph', paragraph: 1 }, text: 'Phone: 13900001111' }])
  const tampered: EvidenceDocument = { ...doc, source_bytes: encoder.encode('different bytes') }
  const result = expectRejected(verifyEvidence(tampered, { quote: '13900001111' }), 'SHA256_MISMATCH', true)
  assert.notEqual(result.detail.actual_sha256, result.detail.expected_sha256)
  assert.equal(result.detail.expected_sha256, doc.source_sha256)
})

test('空 source_bytes → SOURCE_EMPTY；非 Uint8Array → SOURCE_UNREADABLE', () => {
  const blocks: EvidenceBlock[] = [{ locator: { kind: 'text_line_offset', line: 1, offset: 0 }, text: 'x' }]
  const emptyDoc: EvidenceDocument = {
    source_sha256: sha256Hex(new Uint8Array(0)),
    source_bytes: new Uint8Array(0),
    blocks,
  }
  expectRejected(verifyEvidence(emptyDoc, { quote: 'x' }), 'SOURCE_EMPTY', false)

  const broken = { source_sha256: 'a'.repeat(64), source_bytes: 'not-bytes', blocks } as unknown as EvidenceDocument
  expectRejected(verifyEvidence(broken, { quote: 'x' }), 'SOURCE_UNREADABLE', false)
})

// ---------------------------------------------------------------------------
//  ③ 条件③：quote 逐字命中
// ---------------------------------------------------------------------------

test('quote 不存在（有定位器 / 无定位器）→ QUOTE_NOT_FOUND', () => {
  const doc = documentWith(RTF_BLOCKS)
  const locator = RTF_BLOCKS[2]?.locator as EvidenceLocator
  expectRejected(verifyEvidence(doc, { locator, quote: '13900009999' }), 'QUOTE_NOT_FOUND', false)
  expectRejected(verifyEvidence(doc, { quote: '13900009999' }), 'QUOTE_NOT_FOUND', false)
})

test('空 quote（含全空白）→ QUOTE_EMPTY', () => {
  const doc = documentWith(RTF_BLOCKS)
  expectRejected(verifyEvidence(doc, { quote: '' }), 'QUOTE_EMPTY', false)
  expectRejected(verifyEvidence(doc, { quote: ' \r\n\t ' }), 'QUOTE_EMPTY', false)
})

// ---------------------------------------------------------------------------
//  ④ 条件②：定位唯一（显式 locator 的 0/多命中）
// ---------------------------------------------------------------------------

test('显式 locator：0 命中 → LOCATOR_NOT_FOUND；≥2 命中 → LOCATOR_AMBIGUOUS（不取第一条）', () => {
  const missing: EvidenceLocator = { kind: 'rtf_paragraph', paragraph: 99 }
  const doc = documentWith(RTF_BLOCKS)
  expectRejected(verifyEvidence(doc, { locator: missing, quote: 'Phone' }), 'LOCATOR_NOT_FOUND', false)

  // 两个块声明同一个 locator：文档本身有歧义，必须拒绝而不是取第一条。
  const duplicatedLocator: EvidenceLocator = { kind: 'text_line_offset', line: 1, offset: 0 }
  const ambiguousDoc = documentWith([
    { locator: duplicatedLocator, text: 'Phone: 13900001111' },
    { locator: duplicatedLocator, text: 'Phone: 13900002222' },
  ])
  const result = expectRejected(
    verifyEvidence(ambiguousDoc, { locator: duplicatedLocator, quote: '13900001111' }),
    'LOCATOR_AMBIGUOUS',
    true,
  )
  const candidates = result.detail.candidates as readonly { index: number }[]
  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates.map((c) => c.index), [0, 1])
})

test('无 locator 且同一 quote 出现在两个块 → QUOTE_AMBIGUOUS（detail 列候选，证明没取第一条）', () => {
  const doc = documentWith([
    { locator: { kind: 'rtf_paragraph', paragraph: 0 }, text: 'Phone: 13900001111' },
    { locator: { kind: 'text_line_offset', line: 2, offset: 0 }, text: 'alt phone 13900001111' },
  ])
  const result = expectRejected(verifyEvidence(doc, { quote: '13900001111' }), 'QUOTE_AMBIGUOUS', true)
  const candidates = result.detail.candidates as readonly { index: number; locator_kind: string }[]
  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates.map((c) => c.index), [0, 1])
  assert.deepEqual(candidates.map((c) => c.locator_kind), ['rtf_paragraph', 'text_line_offset'])
  // 歧义必须转人工：detail 明确写"拒绝取第一条"。
  assert.match(String(result.detail.message), /first match/i)
})

test('显式 locator 命中歧义文本仍按 locator 唯一位置通过（位置由 locator 唯一确定）', () => {
  // 理由：D-110 的"歧义"是**位置**歧义，不是"文本出现次数"歧义。给了唯一 locator 时，
  // 引用范围就是我指的那一块；同一句话在别处出现不影响"这句话确实在那里"。
  const target: EvidenceLocator = { kind: 'rtf_paragraph', paragraph: 1 }
  const doc = documentWith([
    { locator: { kind: 'rtf_paragraph', paragraph: 0 }, text: 'Phone: 13900001111' },
    { locator: target, text: 'Phone: 13900001111' },
  ])
  const result = expectVerified(verifyEvidence(doc, { locator: target, quote: '13900001111' }))
  assert.equal(result.locator_kind, 'rtf_paragraph')
  assert.equal(result.verification_method, 'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE')
  assert.deepEqual(result.locator, target)
})

// ---------------------------------------------------------------------------
//  ⑤ 归一化：只允许契约写死的换行/空白/断连字符
// ---------------------------------------------------------------------------

test('归一化：CRLF / 多空白 / 行尾断连字符 "-\\n" 可命中且 normalized=true', () => {
  const crlfDoc = documentWith([
    {
      locator: { kind: 'text_line_offset', line: 1, offset: 0 },
      text: 'Education\r\n2015.09 - 2019.06   Example   University',
    },
  ])
  const crlf = expectVerified(
    verifyEvidence(crlfDoc, { quote: 'Education\n2015.09 - 2019.06 Example University' }),
  )
  assert.equal(crlf.normalized, true, '跨行/多空白匹配必须标 normalized=true')

  const hyphenDoc = documentWith([
    {
      locator: { kind: 'rtf_paragraph', paragraph: 0 },
      text: 'Research inter-\nnational banking experience',
    },
  ])
  const hyphen = expectVerified(verifyEvidence(hyphenDoc, { quote: 'international banking experience' }))
  assert.equal(hyphen.normalized, true)

  // 反向：归一化后仍不包含 → QUOTE_NOT_FOUND（不做模糊/语义匹配）。
  expectRejected(
    verifyEvidence(hyphenDoc, { quote: 'international banking experiences' }),
    'QUOTE_NOT_FOUND',
    false,
  )
})

test('normalizeQuote 规则写死：换行→空格、多空白→单空格、断连字符拼接、大小写不折叠', () => {
  assert.equal(normalizeQuote('  Foo\r\n\tBar   Baz  '), 'Foo Bar Baz')
  assert.equal(normalizeQuote('inter-\nnational'), 'international')
  assert.equal(normalizeQuote('a -\nb'), 'a b', '连字符前有空格时是破折号，不删除连字符')
  assert.equal(normalizeQuote('Phone: 13900001111'), 'Phone: 13900001111')
  assert.equal(normalizeQuote(''), '')
  // 大小写/全角半角/标点都不归一化（只允许清单里的规则）。
  assert.equal(normalizeQuote('ＦＯＯ'), 'ＦＯＯ')
  assert.equal(normalizeQuote('foo'), 'foo')
})

// ---------------------------------------------------------------------------
//  ⑥ sameLocator / locatorKindOf / isEvidenceLocator
// ---------------------------------------------------------------------------

test('sameLocator：同 kind 逐字段相等；rtf 的 page 是附加约束（单边缺失不算不同）', () => {
  const rtfNoPage: EvidenceLocator = { kind: 'rtf_paragraph', paragraph: 2 }
  const rtfPage1: EvidenceLocator = { kind: 'rtf_paragraph', paragraph: 2, page: 1 }
  const rtfPage2: EvidenceLocator = { kind: 'rtf_paragraph', paragraph: 2, page: 2 }
  assert.equal(sameLocator(rtfNoPage, rtfPage1), true, '无 page 与 page=1 不构成不同位置')
  assert.equal(sameLocator(rtfPage1, rtfPage1), true)
  assert.equal(sameLocator(rtfPage1, rtfPage2), false, '双方都有 page 且不同 → 不同位置')

  const pdfA: EvidenceLocator = { kind: 'pdf_page_bbox', page: 1, bbox: [1, 2, 3, 4] }
  const pdfB: EvidenceLocator = { kind: 'pdf_page_bbox', page: 1, bbox: [1, 2, 3, 5] }
  assert.equal(sameLocator(pdfA, pdfA), true)
  assert.equal(sameLocator(pdfA, pdfB), false)
  assert.equal(sameLocator(pdfA, rtfPage1), false, 'kind 不同永远不是同一位置')
  assert.equal(
    sameLocator({ kind: 'docx_part_paragraph', part: 'word/document.xml', paragraph: 1 },
      { kind: 'docx_part_paragraph', part: 'word/header1.xml', paragraph: 1 }),
    false,
  )
  assert.equal(
    sameLocator({ kind: 'text_line_offset', line: 1, offset: 0 },
      { kind: 'text_line_offset', line: 1, offset: 3 }),
    false,
  )
  assert.equal(sameLocator({ kind: 'unknown' } as unknown as EvidenceLocator, pdfA), false, '畸形输入不能证明位置')

  assert.equal(locatorKindOf(pdfA), 'pdf_page_bbox')
  assert.equal(isEvidenceLocator(pdfA), true)
  assert.equal(isEvidenceLocator({ kind: 'pdf_page_bbox', page: 0, bbox: [1, 2, 3, 4] }), false)
  assert.equal(isEvidenceLocator({ kind: 'rtf_paragraph', paragraph: -1 }), false)
  assert.equal(isEvidenceLocator({ kind: 'rtf_paragraph', paragraph: 0, page: 0 }), false)
  assert.equal(isEvidenceLocator(null), false)
})

// ---------------------------------------------------------------------------
//  ⑦ converter-adapter：location → locator 映射 + 源不可用的结构化拒绝
// ---------------------------------------------------------------------------

test('locatorFromConverterLocation：五种 location 形态各归其位；无定位字段返回 undefined', () => {
  assert.deepEqual(
    locatorFromConverterLocation({ page: 2, bbox: [10, 20, 30, 40] }),
    { kind: 'pdf_page_bbox', page: 2, bbox: [10, 20, 30, 40] },
  )
  assert.deepEqual(
    locatorFromConverterLocation({ part: 'word/document.xml', paragraph: 7 }),
    { kind: 'docx_part_paragraph', part: 'word/document.xml', paragraph: 7 },
  )
  assert.deepEqual(
    locatorFromConverterLocation({ part: 'word/document.xml', table_id: 0, row: 3 }),
    { kind: 'docx_part_table_row', part: 'word/document.xml', table_id: 0, row: 3 },
  )
  assert.deepEqual(
    locatorFromConverterLocation({ paragraph: 4 }),
    { kind: 'rtf_paragraph', paragraph: 4 },
  )
  assert.deepEqual(
    locatorFromConverterLocation({ paragraph: 4, page: 1 }),
    { kind: 'rtf_paragraph', paragraph: 4, page: 1 },
  )
  assert.deepEqual(
    locatorFromConverterLocation({ line: 9, offset: 12 }),
    { kind: 'text_line_offset', line: 9, offset: 12 },
  )
  // 不合格 bbox（3 个数 / 非数）不算坐标；无其它定位字段 → undefined。
  assert.equal(locatorFromConverterLocation({ page: 1, bbox: [1, 2, 3] }), undefined)
  assert.equal(locatorFromConverterLocation({ page: 0, bbox: [1, 2, 3, 4] }), undefined)
  assert.equal(locatorFromConverterLocation({}), undefined)
  assert.equal(locatorFromConverterLocation(null), undefined)
})

test('DOCX 缺 part 时不伪造 DOCX 定位：优先真实 page+bbox，否则纯文本兜底', () => {
  // 理由：part 是 DOCX 定位的一部分，缺了就不能把 paragraph 冒充成"某个部件里的第 N 段"。
  assert.deepEqual(
    locatorFromConverterLocation({ paragraph: 2, page: 1, bbox: [1, 2, 3, 4] }, 'docx'),
    { kind: 'pdf_page_bbox', page: 1, bbox: [1, 2, 3, 4] },
    'DOCX 缺 part 但读取器给了真实 page+bbox → 用真实坐标，不虚构部件名',
  )
  assert.equal(locatorFromConverterLocation({ paragraph: 2 }, 'docx'), undefined)
})

test('evidenceBlocksFromConverter：块文本非 string 记空串；无定位字段的块走 line/offset 兜底', () => {
  const blocks = evidenceBlocksFromConverter([
    { text: 'first block' },
    { text: 'second block', location: { paragraph: 1, page: 1 } },
    { text: 12345 },
  ])
  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks[0]?.locator, { kind: 'text_line_offset', line: 1, offset: 0 })
  assert.equal(blocks[0]?.text, 'first block')
  assert.deepEqual(blocks[1]?.locator, { kind: 'rtf_paragraph', paragraph: 1, page: 1 })
  assert.equal(blocks[2]?.text, '', '非 string 的块文本按空串处理（不抛、不猜）')
  assert.deepEqual(blocks[2]?.locator, { kind: 'text_line_offset', line: 3, offset: 0 })
})

test('evidenceContextFromConverter：源文件不存在/空/缺 sha 都是结构化拒绝（不 throw）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-adapter-'))
  const bytes = encoder.encode('synthetic-bytes')
  const goodPath = join(dir, 'good.rtf')
  writeFileSync(goodPath, bytes)
  const sha = sha256Hex(bytes)

  const missing = evidenceContextFromConverter(join(dir, 'missing.rtf'), {})
  assert.equal(missing.ok, false)
  if (missing.ok === false) assert.equal(missing.reason_code, 'SOURCE_UNREADABLE')

  const emptyPath = join(dir, 'empty.rtf')
  writeFileSync(emptyPath, '')
  const empty = evidenceContextFromConverter(emptyPath, { meta: { source_sha256: sha } })
  assert.equal(empty.ok, false)
  if (empty.ok === false) assert.equal(empty.reason_code, 'SOURCE_EMPTY')

  const noSha = evidenceContextFromConverter(goodPath, { blocks: [] })
  assert.equal(noSha.ok, false)
  if (noSha.ok === false) {
    assert.equal(noSha.reason_code, 'SOURCE_SHA_MISSING')
    assert.match(noSha.message, /source_sha256/)
  }
  const badSha = evidenceContextFromConverter(goodPath, { meta: { source_sha256: 'abc' } })
  assert.equal(badSha.ok, false)
  if (badSha.ok === false) assert.equal(badSha.reason_code, 'SOURCE_SHA_MISSING')

  const okResult = evidenceContextFromConverter(goodPath, {
    meta: { source_sha256: sha.toUpperCase() },
    blocks: [{ text: 'Phone: 13900001111', location: { paragraph: 2, page: 1 } }],
  })
  assert.equal(okResult.ok, true)
  if (okResult.ok === true) {
    assert.equal(okResult.context.source_sha256, sha, 'sha 统一小写')
    assert.deepEqual([...okResult.context.source_bytes], [...bytes], 'source_bytes 必须是本地重读的字节')
    assert.deepEqual(okResult.context.blocks[0]?.locator, { kind: 'rtf_paragraph', paragraph: 2, page: 1 })
  }
})

// ---------------------------------------------------------------------------
//  ⑧ identity.ts 的证据闸门分派（D-110 + 兼容分派；不连库）
// ---------------------------------------------------------------------------

/** converter 字段条目：present + native_text + 指定 evidence。 */
function phoneEntry(evidence: readonly Record<string, unknown>[]) {
  return {
    state: 'present',
    value: '13900001111',
    provenance: 'native_text',
    evidence,
  }
}

test('observeIdentity（给 context）：RTF 无 bbox 也能通过，证据带 locator_kind/method/sha', () => {
  const context = documentWith(RTF_BLOCKS)
  const observation = observeIdentity(
    { phone: phoneEntry([{ page: 1, block: 2, text: '13900001111' }]) },
    ['phone'],
    { ok: true, context },
  )
  assert.deepEqual(observation.blocked.filter((item) => item.field === 'phone'), [])
  assert.deepEqual(observation.strong.map((id) => id.field), ['phone'])
  const evidence = observation.strong[0]?.evidence[0]
  assert.equal(evidence?.locator_kind, 'rtf_paragraph')
  assert.equal(evidence?.verification_method, 'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE')
  assert.equal(evidence?.source_sha256, context.source_sha256)
  assert.equal(evidence?.page, 1, 'RTF 单页时 page=1（读取器真的给了）')
  assert.deepEqual(evidence?.bbox, [], 'RTF 没有 bbox：空数组，不是拒绝理由')
})

test('observeIdentity（给 context）：sha 不符 → 字段 blocked evidence_sha256_mismatch（fail-closed）', () => {
  const context = documentWith(RTF_BLOCKS)
  const tampered = { ...context, source_sha256: '0'.repeat(64) }
  const observation = observeIdentity(
    { phone: phoneEntry([{ page: 1, block: 2, text: '13900001111' }]) },
    ['phone'],
    { ok: true, context: tampered },
  )
  assert.deepEqual(observation.strong, [])
  const blocked = observation.blocked.find((item) => item.field === 'phone')
  assert.equal(blocked?.reason, 'evidence_sha256_mismatch')
  assert.equal(blocked?.detail?.reason_code, 'SHA256_MISMATCH')
})

test('observeIdentity（给 context）：quote 歧义 → 字段 blocked evidence_quote_ambiguous（detail 列候选）', () => {
  const context = documentWith([
    { locator: { kind: 'rtf_paragraph', paragraph: 0, page: 1 }, text: 'Phone: 13900001111' },
    { locator: { kind: 'rtf_paragraph', paragraph: 1, page: 1 }, text: 'alternate 13900001111' },
  ])
  const observation = observeIdentity(
    // 去掉 block/page/bbox → 强制走 quote 全文唯一搜索。
    { phone: phoneEntry([{ text: '13900001111' }]) },
    ['phone'],
    { ok: true, context },
  )
  assert.deepEqual(observation.strong, [], '歧义不得自动通过，更不得取第一条')
  const blocked = observation.blocked.find((item) => item.field === 'phone')
  assert.equal(blocked?.reason, 'evidence_quote_ambiguous')
  const candidates = blocked?.detail?.candidates as readonly unknown[] | undefined
  assert.equal(candidates?.length, 2, 'detail 必须列出候选，供人工补第二定位')
})

test('observeIdentity（给 context）：源不可用 → 非 bbox 证据字段 blocked evidence_source_unavailable', () => {
  const observation = observeIdentity(
    { phone: phoneEntry([{ page: 1, block: 2, text: '13900001111' }]) },
    ['phone'],
    { ok: false, reason_code: 'SOURCE_UNREADABLE', message: 'cannot read' },
  )
  assert.deepEqual(observation.strong, [])
  const blocked = observation.blocked.find((item) => item.field === 'phone')
  assert.equal(blocked?.reason, 'evidence_source_unavailable')
  assert.equal(blocked?.detail?.reason_code, 'SOURCE_UNREADABLE')
})

test('observeIdentity（兼容分派）：合格 page+bbox 证据即使给了 context 也走 LEGACY_BBOX_SHAPE_ONLY', () => {
  // 这是**已知债务**（owner 2026-11-15 复核指令）：既有集成测试手工构造随机 sha 的
  // converter 输出 + PDF 形状证据，不能被收紧成 SHA256_MISMATCH。S6 的 PDF 三条件升级
  // 另立任务；locator API 本身已由本文件 ①②③ 覆盖。
  const context = documentWith(RTF_BLOCKS)
  const bboxEvidence = [{ page: 1, bbox: [10, 20, 300, 40], block: 2, text: '13900001111' }]
  const observation = observeIdentity(
    { phone: phoneEntry(bboxEvidence) },
    ['phone'],
    { ok: true, context },
  )
  assert.deepEqual(observation.strong.map((id) => id.field), ['phone'])
  const evidence = observation.strong[0]?.evidence[0]
  assert.equal(evidence?.verification_method, 'LEGACY_BBOX_SHAPE_ONLY')
  assert.equal(evidence?.locator_kind, 'pdf_page_bbox')
  assert.equal(evidence?.source_sha256, undefined, '旧形状路径没有核验 sha，不得冒充已验证')

  // 无 context（历史 2 参调用）同样只做形状校验：既有测试行为不变。
  const legacy = observeIdentity({ phone: phoneEntry(bboxEvidence) }, ['phone'])
  assert.equal(legacy.strong[0]?.evidence[0]?.verification_method, 'LEGACY_BBOX_SHAPE_ONLY')
})

test('observeIdentity（无 context）：非 bbox 证据仍 evidence_missing（向后兼容，不放宽）', () => {
  const observation = observeIdentity(
    { phone: phoneEntry([{ page: 1, block: 2, text: '13900001111' }]) },
    ['phone'],
  )
  assert.deepEqual(observation.strong, [])
  assert.equal(observation.blocked.find((item) => item.field === 'phone')?.reason, 'evidence_missing')
})
