// D-141 ⑧ + ① 的**纯函数**测试（不连库、不读文件、不起 Python）：
//   * `buildMaterialTextValue()`：TEXT 模式的**可定位逐字引文**——四态全覆盖
//     （有引文 / 无引文 / 多命中歧义 / 哈希不符）+ PII 跳过 + 预算截断 + render；
//   * `summarizeRubricCriteria()`：application_get 的 criteria 摘要（≤8 条 + 真实总数，
//     不带 question/notes 全文）。
//
// 为什么是纯函数测试：引文的三条件是**判定逻辑**，与"文件在不在 allowed_roots 里"是两件事。
// 真实读取（PDF/DOCX/RTF 走真 converter）与真库读回在 `test/integration/evidence-read-pg.test.ts`。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  APPLICATION_GET_TOOL,
  MATERIAL_READ_TOOL,
  buildMaterialTextValue,
  createApplicationGetTool,
  createMaterialReadTool,
  summarizeRubricCriteria,
} from '../../src/tools/business-read.ts'
import type { DocumentBlock, DocumentContent, EvidenceLocator } from '../../src/document/contracts/index.ts'

const PDF_SHA = createHash('sha256').update('synthetic pdf bytes').digest('hex')
const DOCX_SHA = createHash('sha256').update('synthetic docx bytes').digest('hex')

/** 造一个 PDF 块（page + bbox 定位）。 */
function pdfBlock(
  blockId: string,
  order: number,
  page: number,
  bbox: readonly [number, number, number, number],
  text: string,
): DocumentBlock {
  return {
    block_id: blockId,
    kind: 'paragraph',
    text,
    order,
    locator: { kind: 'pdf', page, bbox },
    provenance: 'native_text',
  }
}

/** 造一个块（定位器可换，用来测"无结构定位器"的分支）。 */
function blockWith(blockId: string, order: number, locator: EvidenceLocator, text: string): DocumentBlock {
  return { block_id: blockId, kind: 'paragraph', text, order, locator, provenance: 'native_text' }
}

/** 造一份最小 DocumentContent（`buildMaterialTextValue` 只消费这五个字段）。 */
function contentOf(
  text: string,
  blocks: readonly DocumentBlock[],
  assetSha256 = PDF_SHA,
  mediaType: DocumentContent['media_type'] = 'application/pdf',
): Pick<DocumentContent, 'text' | 'blocks' | 'asset_sha256' | 'media_type' | 'reader_id'> {
  return { text, blocks, asset_sha256: assetSha256, media_type: mediaType, reader_id: 'synthetic/test' }
}

/** 断言 quote 在全文里逐字出现（D-110 条件 ③）。 */
function assertQuoteLiteral(text: string, quote: string): void {
  assert.ok(text.includes(quote), `quote 不是原文的逐字子串：${JSON.stringify(quote)}`)
}

// ---------------------------------------------------------------------------
//  有引文：PDF / MOST-RTF / DOCX 三种定位器
// ---------------------------------------------------------------------------

test('有引文（PDF）：每块一条，带 pdf_page_bbox + page/bbox + line/offset + 逐字 quote + 原件 sha', () => {
  const page1 = 'SYNTHETIC RESUME\nWORK EXPERIENCE\nEXAMPLE CORP / BACKEND / 2020 - 2021'
  const page2 = 'EDUCATION\nEXAMPLE UNIVERSITY / B.Sc. / 2016 - 2020'
  const text = `${page1}\n\n${page2}`
  const blocks = [
    pdfBlock('b1', 0, 1, [72, 78, 500, 93], 'SYNTHETIC RESUME'),
    pdfBlock('b2', 1, 1, [72, 98, 500, 113], 'WORK EXPERIENCE'),
    pdfBlock('b3', 2, 1, [72, 118, 500, 133], 'EXAMPLE CORP / BACKEND / 2020 - 2021'),
    pdfBlock('b4', 3, 2, [72, 78, 500, 93], 'EDUCATION'),
    pdfBlock('b5', 4, 2, [72, 98, 500, 113], 'EXAMPLE UNIVERSITY / B.Sc. / 2016 - 2020'),
  ]

  const value = buildMaterialTextValue(contentOf(text, blocks), PDF_SHA, 2000)

  assert.equal(value.mode, 'TEXT')
  assert.equal(value.available, true)
  assert.equal(value.reason_code, 'OK')
  assert.equal(value.asset_sha256_verified, true)
  assert.equal(value.source_chars, text.length)
  assert.equal(value.truncated, false)
  assert.equal(value.citation_count, 5)
  assert.ok(value.citations !== undefined)

  const first = value.citations[0]
  assert.equal(first.locator_kind, 'pdf_page_bbox')
  assert.equal(first.verification_method, 'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE')
  assert.equal(first.source_sha256, PDF_SHA)
  assert.equal(first.page, 1)
  assert.deepEqual(first.bbox, [72, 78, 500, 93])
  assert.equal(first.quote, 'SYNTHETIC RESUME')
  assertQuoteLiteral(text, first.quote)
  assert.equal(first.block_id, 'b1')
  // line/offset 是从**读取器全文**算出来的，可独立复核（offset 处逐字命中，line 从 1 起）。
  assert.equal(text.slice(first.offset ?? -1, (first.offset ?? 0) + first.quote.length), first.quote)
  assert.equal(first.line, 1)
  assert.equal(first.quote_multi_hit, false)

  // 第二页的引文定位到 page=2（页码来自读取器块定位器，不是从文本猜的）。
  const secondPage = value.citations.filter((citation) => citation.page === 2)
  assert.equal(secondPage.length, 2)
  assert.equal(secondPage[0]?.locator_kind, 'pdf_page_bbox')

  // excerpt 只由引文 quote 拼成（总长 ≤ max_chars），不是整篇原文。
  assert.ok(value.excerpt !== undefined)
  assert.equal(value.excerpt_chars, value.excerpt.length)
  assert.ok(value.excerpt.length <= 2000)
  assert.ok(!value.excerpt.includes('WORK EXPERIENCE\n\nEDUCATION'))
})

test('有引文（RTF）：rtf_paragraph + paragraph（0-based）+ page + line/offset', () => {
  const text = 'Zhang Sample\n\nWork Experience\n\nEXAMPLE CORP / BACKEND / 2021-2024'
  const blocks = [
    blockWith('rtf-0', 0, { kind: 'rtf', paragraph: 0, page: 1 }, 'Zhang Sample'),
    blockWith('rtf-1', 1, { kind: 'rtf', paragraph: 1, page: 1 }, 'Work Experience'),
    blockWith('rtf-2', 2, { kind: 'rtf', paragraph: 2, page: 1 }, 'EXAMPLE CORP / BACKEND / 2021-2024'),
  ]

  const value = buildMaterialTextValue(contentOf(text, blocks, PDF_SHA, 'application/rtf'), PDF_SHA, 500)

  assert.equal(value.available, true)
  assert.equal(value.citation_count, 3)
  const last = value.citations?.[2]
  assert.equal(last?.locator_kind, 'rtf_paragraph')
  assert.equal(last?.paragraph, 2)
  assert.equal(last?.page, 1)
  assert.equal(last?.line, 5)
  assert.equal(last?.offset, text.indexOf('EXAMPLE CORP'))
  assert.equal(last?.quote, 'EXAMPLE CORP / BACKEND / 2021-2024')
})

test('有引文（DOCX）：docx_part_paragraph + part/paragraph_id/paragraph', () => {
  const text = 'SYNTHETIC DOCX\nWORK EXPERIENCE\nEXAMPLE CORP / BACKEND / 2020 - 2021'
  const blocks = [
    blockWith('docx-0', 0, { kind: 'docx', part: 'word/document.xml', paragraph_id: 'p0' }, 'SYNTHETIC DOCX'),
    blockWith('docx-1', 1, { kind: 'docx', part: 'word/document.xml', paragraph_id: 'p1' }, 'WORK EXPERIENCE'),
    blockWith('docx-2', 2, { kind: 'docx', part: 'word/document.xml', paragraph_id: 'p2' }, 'EXAMPLE CORP / BACKEND / 2020 - 2021'),
  ]

  const value = buildMaterialTextValue(contentOf(text, blocks, DOCX_SHA, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), DOCX_SHA, 500)

  assert.equal(value.available, true)
  const work = value.citations?.[2]
  assert.equal(work?.locator_kind, 'docx_part_paragraph')
  assert.equal(work?.part, 'word/document.xml')
  assert.equal(work?.paragraph_id, 'p2')
  assert.equal(work?.paragraph, 2)
  assert.equal(work?.quote, 'EXAMPLE CORP / BACKEND / 2020 - 2021')
})

// ---------------------------------------------------------------------------
//  四态中的另外三态：无引文 / 多命中歧义 / 哈希不符
// ---------------------------------------------------------------------------

test('无引文（读取器没给可用块）：available=false + MATERIAL_ORIGINAL_NOT_LOCATED（不假成功）', () => {
  const value = buildMaterialTextValue(contentOf('some readable text', []), PDF_SHA, 2000)
  assert.equal(value.available, false)
  assert.equal(value.reason_code, 'MATERIAL_ORIGINAL_NOT_LOCATED')
  assert.equal(value.citation_count, undefined)
  assert.equal(value.excerpt, undefined)
  assert.equal(value.excerpt_chars, 0)
  assert.equal(value.asset_sha256_verified, undefined)
})

test('无引文（可读原文但全部块含联系方式）：跳过整块并如实报 MATERIAL_ORIGINAL_NOT_LOCATED', () => {
  const text = 'EMAIL: candidate@example.invalid\n\nPHONE: candidate@example.invalid'
  const blocks = [
    blockWith('b1', 0, { kind: 'pdf', page: 1 }, 'EMAIL: candidate@example.invalid'),
    blockWith('b2', 1, { kind: 'pdf', page: 1 }, 'PHONE: candidate@example.invalid'),
  ]
  const value = buildMaterialTextValue(contentOf(text, blocks), PDF_SHA, 2000)
  assert.equal(value.available, false)
  assert.equal(value.reason_code, 'MATERIAL_ORIGINAL_NOT_LOCATED')
  assert.equal(value.omitted_contact_blocks, 2)
  assert.equal(value.excerpt, undefined)
})

test('含联系方式的块被整块跳过（quote 必须逐字，脱敏后的字符串不再算原文）', () => {
  const text = 'Zhang Sample\n\nEMAIL: candidate@example.invalid\n\nEXAMPLE CORP / BACKEND'
  const blocks = [
    blockWith('b1', 0, { kind: 'pdf', page: 1 }, 'Zhang Sample'),
    blockWith('b2', 1, { kind: 'pdf', page: 1 }, 'EMAIL: candidate@example.invalid'),
    blockWith('b3', 2, { kind: 'pdf', page: 1 }, 'EXAMPLE CORP / BACKEND'),
  ]
  const value = buildMaterialTextValue(contentOf(text, blocks), PDF_SHA, 2000)
  assert.equal(value.available, true)
  assert.equal(value.citation_count, 2)
  assert.equal(value.omitted_contact_blocks, 1)
  assert.deepEqual(value.citations?.map((citation) => citation.block_id), ['b1', 'b3'])
  assert.ok(!value.citations?.some((citation) => citation.quote.includes('candidate@example.invalid')))
})

test('多命中歧义（有结构定位器）：仍给引文，但标 quote_multi_hit 且不输出 line/offset', () => {
  const text = 'EXAMPLE CORP\n\nEXAMPLE CORP'
  const blocks = [
    pdfBlock('b1', 0, 1, [72, 78, 500, 93], 'EXAMPLE CORP'),
    pdfBlock('b2', 1, 2, [72, 78, 500, 93], 'EXAMPLE CORP'),
  ]
  const value = buildMaterialTextValue(contentOf(text, blocks), PDF_SHA, 2000)
  assert.equal(value.available, true)
  assert.equal(value.citation_count, 2)
  assert.equal(value.multi_hit_citation_count, 2)
  for (const citation of value.citations ?? []) {
    assert.equal(citation.quote_multi_hit, true)
    assert.equal(citation.offset, undefined)
    assert.equal(citation.line, undefined)
    // 结构定位器（页码）仍然唯一，不被"多处命中"污染。
    assert.equal(citation.locator_kind, 'pdf_page_bbox')
    assert.ok(citation.page === 1 || citation.page === 2)
  }
})

test('多命中歧义（无结构定位器）：整条丢弃、计为 ambiguous，禁止取第一条命中（D-110 IR-G8）', () => {
  const text = 'CONFIDENTIAL NOTE\n\nCONFIDENTIAL NOTE'
  const blocks = [
    blockWith('b1', 0, { kind: 'image', frame: 0 }, 'CONFIDENTIAL NOTE'),
    blockWith('b2', 1, { kind: 'image', frame: 1 }, 'CONFIDENTIAL NOTE'),
  ]
  const value = buildMaterialTextValue(contentOf(text, blocks), PDF_SHA, 2000)
  assert.equal(value.available, false)
  assert.equal(value.reason_code, 'MATERIAL_ORIGINAL_NOT_LOCATED')
  assert.equal(value.ambiguous_citation_count, 2)
  assert.equal(value.citation_count, undefined)
  assert.equal(value.excerpt, undefined)
})

test('无结构定位器但 quote 全文唯一命中：走 text_line_offset 兜底（verification_method=QUOTE_UNIQUE）', () => {
  const text = 'HEADER\n\nUNIQUE SENTENCE ABOUT BACKEND WORK'
  const blocks = [blockWith('b1', 0, { kind: 'image', frame: 0 }, 'UNIQUE SENTENCE ABOUT BACKEND WORK')]
  const value = buildMaterialTextValue(contentOf(text, blocks), PDF_SHA, 2000)
  assert.equal(value.available, true)
  assert.equal(value.citation_count, 1)
  const citation = value.citations?.[0]
  assert.equal(citation?.locator_kind, 'text_line_offset')
  assert.equal(citation?.verification_method, 'QUOTE_UNIQUE+SHA256+LITERAL_QUOTE')
  assert.equal(citation?.line, 3)
  assert.equal(citation?.offset, text.indexOf('UNIQUE SENTENCE'))
})

test('哈希不符：available=false + HASH_MISMATCH，绝不返回正文/引文', () => {
  const text = 'EXAMPLE CORP / BACKEND'
  const blocks = [pdfBlock('b1', 0, 1, [72, 78, 500, 93], 'EXAMPLE CORP / BACKEND')]
  const value = buildMaterialTextValue(contentOf(text, blocks, PDF_SHA), 'f'.repeat(64), 2000)
  assert.equal(value.available, false)
  assert.equal(value.reason_code, 'HASH_MISMATCH')
  assert.equal(value.excerpt, undefined)
  assert.equal(value.citations, undefined)
  assert.equal(value.asset_sha256_verified, undefined)
})

// ---------------------------------------------------------------------------
//  预算：引文总量受 max_chars 约束（不整篇灌给模型）
// ---------------------------------------------------------------------------

test('预算：总引文字符 + 分隔符 ≤ max_chars；超出后截断并标 citations_truncated', () => {
  const text = 'AAAA BBBB CCCC\n\nDDDD EEEE FFFF\n\nGGGG HHHH IIII'
  const blocks = [
    pdfBlock('b1', 0, 1, [72, 78, 500, 93], 'AAAA BBBB CCCC'),
    pdfBlock('b2', 1, 1, [72, 98, 500, 113], 'DDDD EEEE FFFF'),
    pdfBlock('b3', 2, 1, [72, 118, 500, 133], 'GGGG HHHH IIII'),
  ]
  const value = buildMaterialTextValue(contentOf(text, blocks), PDF_SHA, 40)
  assert.equal(value.available, true)
  assert.equal(value.truncated, true)
  assert.equal(value.citations_truncated, true)
  assert.ok((value.excerpt?.length ?? Number.POSITIVE_INFINITY) <= 40)
  // 第一条 14 字；第二条需要 1+14=15 ≤ 40；第三条需要 1+14 > 剩余 11 → 不再给。
  assert.equal(value.citation_count, 2)
  assert.deepEqual(value.citations?.map((citation) => citation.quote), ['AAAA BBBB CCCC', 'DDDD EEEE FFFF'])
})

test('预算：第一条就超上限时按预结算截断（逐字前缀 + quote_truncated）', () => {
  const long = 'X'.repeat(100)
  const text = long
  const blocks = [pdfBlock('b1', 0, 1, [72, 78, 500, 93], long)]
  const value = buildMaterialTextValue(contentOf(text, blocks), PDF_SHA, 30)
  assert.equal(value.available, true)
  assert.equal(value.truncated, true)
  assert.equal(value.citations?.[0]?.quote_chars, 30)
  assert.equal(value.citations?.[0]?.quote_truncated, true)
  assert.equal(value.citations?.[0]?.quote, 'X'.repeat(30))
  // 截断的 quote 仍是原文前缀（逐字子串），且 sha 校验仍成立。
  assert.equal(text.slice(0, 30), value.citations?.[0]?.quote)
  assert.equal(value.asset_sha256_verified, true)
})

// ---------------------------------------------------------------------------
//  criteria 摘要（D-141 ①）
// ---------------------------------------------------------------------------

test('criteria_summary：key/label/kind/weight，最多 8 条 + 真实 criteria_count，不带 question/notes 全文', () => {
  const dimensions = Array.from({ length: 10 }, (_, index) => ({
    key: `criterion_${index}`,
    label: `标准 ${index}`,
    kind: index < 3 ? 'MUST_HAVE' : 'NICE_TO_HAVE',
    weight: Number((0.1).toFixed(1)),
    question: `这是第 ${index} 条的判断问题全文（不应出现在摘要里）`,
    notes: `这是第 ${index} 条的备注全文（不应出现在摘要里）`,
    field: 'work_experience',
    operator: 'EXISTS',
  }))

  const summary = summarizeRubricCriteria(dimensions)
  assert.equal(summary.criteria_count, 10)
  assert.equal(summary.criteria_summary.length, 8)
  assert.deepEqual(summary.criteria_summary[0], {
    key: 'criterion_0',
    label: '标准 0',
    kind: 'MUST_HAVE',
    weight: 0.1,
  })
  const serialized = JSON.stringify(summary.criteria_summary)
  assert.ok(!serialized.includes('判断问题全文'))
  assert.ok(!serialized.includes('备注全文'))
  assert.ok(!serialized.includes('question'))
  assert.ok(!serialized.includes('notes'))
  assert.ok(!serialized.includes('operator'))
})

test('criteria_summary：结构不合法的条目跳过（不伪造 key）、非数组/空值给 0 条', () => {
  const summary = summarizeRubricCriteria([
    { key: 'ok_key', kind: 'MUST_HAVE' },
    { kind: 'MUST_HAVE' },
    'not-an-object',
    null,
    { key: 42 },
    { key: 'ok_key_2', weight: 'not-a-number' },
  ])
  assert.equal(summary.criteria_count, 6)
  assert.deepEqual(summary.criteria_summary.map((item) => item.key), ['ok_key', 'ok_key_2'])
  assert.equal(summary.criteria_summary[1]?.weight, undefined)
  assert.equal(summarizeRubricCriteria(null).criteria_count, 0)
  assert.deepEqual(summarizeRubricCriteria(null).criteria_summary, [])
  assert.equal(summarizeRubricCriteria({}).criteria_count, 0)
})

// ---------------------------------------------------------------------------
//  render：模型可见文本里必须有可引用的页/行 + 原句（且不泄露完整 sha）
// ---------------------------------------------------------------------------

/** 造一个 material_read 输出值（render 用；TEXT 且有引文）。 */
function materialValueWithCitations(): unknown {
  const text = 'Zhang Sample\n\nWork Experience\n\nEXAMPLE CORP / BACKEND / 2021-2024'
  const blocks = [
    blockWith('rtf-0', 0, { kind: 'rtf', paragraph: 0, page: 1 }, 'Zhang Sample'),
    blockWith('rtf-1', 1, { kind: 'rtf', paragraph: 1, page: 1 }, 'Work Experience'),
    blockWith('rtf-2', 2, { kind: 'rtf', paragraph: 2, page: 1 }, 'EXAMPLE CORP / BACKEND / 2021-2024'),
  ]
  const textValue = buildMaterialTextValue(contentOf(text, blocks, PDF_SHA, 'application/rtf'), PDF_SHA, 2000)
  return {
    tool: MATERIAL_READ_TOOL,
    contract_version: '1.0.0',
    tool_kind: 'READ_ONLY',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    query: { mode: 'TEXT', source: 'APPLICATION', application_id: 'x', resume_version_id: 'y' },
    material: {
      meta: {
        resume_version_id: 'y', version_no: 1, parse_status: 'PARSED', pages: 1,
        reader_backend: 'striprtf', reader_version: '0.0.35',
      },
      structure: {
        field_locators: [],
        entries: [],
        issues: { count: 0, hard_count: 0, hard_codes: [], codes: [] },
      },
      contacts: { visible: false, email: '', phone: '' },
    },
    text: textValue,
    next_tools: [],
  }
}

test('render（material_read）：给 locator_kind + page/line + 原句；不给完整 64hex', () => {
  const tool = createMaterialReadTool({ database: undefined as never })
  const rendered = tool.output.render({}, materialValueWithCitations()).map((block) => block.text).join('\n')
  assert.match(rendered, /citations=3/)
  assert.match(rendered, /\[1\] rtf_paragraph page 1 · paragraph 0 · line 1 · offset 0 — 「Zhang Sample」/)
  assert.match(rendered, /「EXAMPLE CORP \/ BACKEND \/ 2021-2024」/)
  assert.match(rendered, /source citations/)
  assert.doesNotMatch(rendered, new RegExp(PDF_SHA))
})

test('render（material_read）：MATERIAL_ORIGINAL_NOT_LOCATED 有明确提示（不假成功）', () => {
  const tool = createMaterialReadTool({ database: undefined as never })
  const value = {
    tool: MATERIAL_READ_TOOL,
    contract_version: '1.0.0',
    tool_kind: 'READ_ONLY',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    query: { mode: 'TEXT', source: 'RESUME_VERSION', resume_version_id: 'y' },
    material: {
      meta: {
        resume_version_id: 'y', version_no: 1, parse_status: 'PARSED', pages: 1,
        reader_backend: '', reader_version: '',
      },
      structure: {
        field_locators: [],
        entries: [],
        issues: { count: 0, hard_count: 0, hard_codes: [], codes: [] },
      },
      contacts: { visible: false, email: '', phone: '' },
    },
    text: { mode: 'TEXT', available: false, reason_code: 'MATERIAL_ORIGINAL_NOT_LOCATED', source_chars: 10, excerpt_chars: 0, truncated: false },
    next_tools: [],
  }
  const rendered = tool.output.render({}, value).map((block) => block.text).join('\n')
  assert.match(rendered, /MATERIAL_ORIGINAL_NOT_LOCATED/)
  assert.match(rendered, /do not claim a page\/line you do not have/)
  assert.doesNotMatch(rendered, /source citations/)
})

test('render（application_get）：rubric 行后给 criteria 摘要；O1 不出现完整 UUID/64hex', () => {
  const tool = createApplicationGetTool({ database: undefined as never })
  const value = {
    tool: APPLICATION_GET_TOOL,
    contract_version: '1.0.0',
    tool_kind: 'READ_ONLY',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    query: { mode: 'ONE', matched: 1, limit: 1, application_id: '11111111-1111-4111-8111-000000000701' },
    needs_human_choice: false,
    applications: [{
      application_id: '11111111-1111-4111-8111-000000000701',
      stage_code: 'S7',
      lifecycle_status: 'ACTIVE',
      record_version: 1,
      candidate: {
        candidate_id: '11111111-1111-4111-8111-000000000601',
        display_name: '演示候选人',
        identity_status: 'ACTIVE',
        contacts: { visible: false, email: '', phone: '' },
      },
      job: { job_id: '11111111-1111-4111-8111-000000000401', code: 'DEMO-BE-001', title: '后端工程师（演示）', status: 'OPEN' },
      rubric: {
        rubric_version_id: '11111111-1111-4111-8111-000000000403',
        version_no: 1,
        source: 'APPLICATION_PIN',
        approved: true,
        criteria_count: 3,
        criteria_summary: [
          { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
          { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
          { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
        ],
        payload_hash: 'a'.repeat(64),
      },
      interviews: { count: 0, items: [] },
      transcripts: { count: 0, ready_count: 0 },
      evaluations: {
        scorecard_count: 0, submitted_count: 0,
        scorecards_required_total: 0, scorecards_submitted_total: 0,
        scorecards_waived_total: 0, scorecards_pending_total: 0,
      },
      rubric_remediation: { code: 'CONTINUE_WITH_PINNED', message: '按 v1 继续', rebind_action_available: false },
      decisions: { count: 0 },
    }],
    next_tools: [],
  }
  const rendered = tool.output.render({}, value).map((block) => block.text).join('\n')
  assert.match(rendered, /criteria: backend_depth \[MUST_HAVE\] w=0\.5 后端工程深度; async_pipeline/)
  assert.doesNotMatch(rendered, /11111111-1111-4111-8111-000000000701/)
  assert.doesNotMatch(rendered, /a{64}/)
})
