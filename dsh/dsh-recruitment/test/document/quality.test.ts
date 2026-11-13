// U2 质量判定器的独立测试。
//
// 覆盖：
//   1. 稳定 code 表（封闭枚举、converter 映射与 issues.py 对拍、不改级）
//   2. 六类故障注入，逐条核对 code / severity / suggested_action / blocking
//   3. 未知 issue code → fail-closed（含「看起来像 SOFT 前缀」的未知 code）
//   4. 三条不变量（unreadable≠absent、不足即非 complete、缺字≠缺经历）
//   5. 纯函数性：无模型/网络/子进程依赖，同输入两次结果一致
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONVERTER_ISSUE_CODES,
  DOCUMENT_ISSUE_CODES,
  assess,
  canProceedToStructure,
  countUnreadableMarkers,
  evidenceState,
  fieldPresence,
  isBlocked,
  knownIssueCodes,
  lookupIssueCode,
  mayConcludeAbsence,
  nonWhitespaceChars,
  readerFactsFromSourceMeta,
} from '../../src/document/quality/index.ts'
import { plan } from '../../src/document/recovery/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..', '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const CONVERTER_SRC = join(REPO_ROOT, 'converter', 'src')

type Block = {
  block_id: string
  kind: string
  order: number
  text: string
  locator: Record<string, unknown>
  provenance: string
  links?: Array<{ text: string, href: string }>
}

function makeContent(blocks: Block[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = blocks.map((block) => block.text).join('\n\n')
  return {
    schema_version: '1',
    asset_sha256: 'a'.repeat(64),
    media_type: 'application/pdf',
    reader_id: 'pdf:pymupdf-mounted/1.28.0',
    reader_version: '1.28.0',
    text,
    blocks,
    completeness: 'complete',
    needs_visual: false,
    issues: [],
    meta: { pages: 1, order_verified: true, backend: 'pymupdf+layout/1.28.0' },
    ...overrides,
  }
}

/** 一页、四块、全部原生文本、顺序已核：这是本测试的「合格基线」。 */
function goodBlocks(): Block[] {
  return [
    { block_id: 'b1', kind: 'paragraph', order: 1, text: '张三', locator: { kind: 'pdf', page: 1, bbox: [50, 60, 120, 80] }, provenance: 'native_text' },
    { block_id: 'b2', kind: 'paragraph', order: 2, text: 'Email: demo.candidate@example.invalid', locator: { kind: 'pdf', page: 1, bbox: [50, 100, 300, 120] }, provenance: 'native_text' },
    { block_id: 'b3', kind: 'paragraph', order: 3, text: 'Example Technology Ltd 2021.07 - 2024.06 后端工程师', locator: { kind: 'pdf', page: 1, bbox: [50, 160, 400, 180] }, provenance: 'native_text' },
    { block_id: 'b4', kind: 'paragraph', order: 4, text: 'Example University 2015.09 - 2019.06 计算机', locator: { kind: 'pdf', page: 1, bbox: [50, 220, 400, 240] }, provenance: 'native_text' },
  ]
}

function goodContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeContent(goodBlocks(), overrides)
}

function codes(assessment: { issues: ReadonlyArray<{ code: string }> }): string[] {
  return assessment.issues.map((issue) => issue.code)
}

function issueOf(assessment: { issues: ReadonlyArray<{ code: string, severity: string, suggested_action: string, retryable: boolean }> }, code: string): { code: string, severity: string, suggested_action: string, retryable: boolean } {
  const found = assessment.issues.find((issue) => issue.code === code)
  assert.ok(found !== undefined, `期望出现 ${code}，实际只有 ${codes(assessment).join(',') || '(空)'}`)
  return found as { code: string, severity: string, suggested_action: string, retryable: boolean }
}

// ---------------------------------------------------------------------------
// 1. 稳定 code 表
// ---------------------------------------------------------------------------

test('code 表：每条都有封闭枚举内的 severity / suggested_action / retryable / meaning', () => {
  const actions = new Set(['retry', 'switch_reader', 'vision_read', 'human_review', 'none'])
  const severities = new Set(['HARD', 'SOFT'])
  for (const spec of [...Object.values(DOCUMENT_ISSUE_CODES), ...Object.values(CONVERTER_ISSUE_CODES)]) {
    assert.ok(severities.has(spec.severity), `${spec.code}: severity=${spec.severity}`)
    assert.ok(actions.has(spec.suggested_action), `${spec.code}: action=${spec.suggested_action}`)
    assert.equal(typeof spec.retryable, 'boolean', `${spec.code}: retryable`)
    assert.ok(spec.meaning.length > 8, `${spec.code}: meaning 太短`)
    assert.ok(spec.family.length > 0, `${spec.code}: family 为空`)
  }
  assert.equal(knownIssueCodes().length, new Set(knownIssueCodes()).size, 'code 表有重复键')
})

test('code 表：本层新增的 code 一律 doc_ 前缀，不占用转换器的冻结族', () => {
  for (const spec of Object.values(DOCUMENT_ISSUE_CODES)) {
    assert.ok(spec.code.startsWith('doc_'), `${spec.code} 不满足 doc_ 前缀`)
    assert.equal(spec.origin, 'document')
  }
  for (const spec of Object.values(CONVERTER_ISSUE_CODES)) {
    assert.equal(spec.code.startsWith('doc_'), false, `${spec.code} 不该用 doc_ 前缀`)
    assert.equal(spec.origin, 'converter')
  }
})

/** 解析 converter/src/issues.py，复现它的 (has_hard, soft) 判定。 */
function readIssuesPy(): { hard: Set<string>, added: Map<string, string>, softPrefixes: string[] } | null {
  let source: string
  try {
    source = readFileSync(join(CONVERTER_SRC, 'issues.py'), 'utf8')
  } catch {
    return null
  }
  const hard = new Set<string>()
  const literal = source.match(/_HARD_ISSUE_CODES\s*=\s*\{([\s\S]*?)\}/u)
  assert.ok(literal !== null, 'issues.py 的 _HARD_ISSUE_CODES 字面量没找到')
  for (const match of (literal as RegExpMatchArray)[1].matchAll(/'([a-z0-9_]+)'/gu)) hard.add(match[1])
  for (const match of source.matchAll(/_HARD_ISSUE_CODES\.add\('([a-z0-9_]+)'\)/gu)) hard.add(match[1])
  const added = new Map<string, string>()
  for (const match of source.matchAll(/'([a-z0-9_]+)':\s*\('(hard|soft)'/gu)) added.set(match[1], match[2])
  const prefixMatch = source.match(/_SOFT_ISSUE_PREFIXES\s*=\s*\(([\s\S]*?)\)/u)
  const softPrefixes: string[] = []
  if (prefixMatch !== null) {
    for (const match of (prefixMatch as RegExpMatchArray)[1].matchAll(/'([a-z0-9_]+)'/gu)) softPrefixes.push(match[1])
  }
  return { hard, added, softPrefixes }
}

/** issues.py 对单个 code 的判定（未知 → hard，照抄 batch.py:130 的规矩）。 */
function pySeverity(code: string, table: { hard: Set<string>, added: Map<string, string>, softPrefixes: string[] }): 'HARD' | 'SOFT' {
  if (table.hard.has(code)) return 'HARD'
  const added = table.added.get(code)
  if (added === 'hard') return 'HARD'
  if (added === 'soft') return 'SOFT'
  if (table.softPrefixes.some((prefix) => code.startsWith(prefix))) return 'SOFT'
  return 'HARD'
}

test('converter 映射：本层 severity 与 converter/src/issues.py 完全一致（只映射，不改级）', (t) => {
  const table = readIssuesPy()
  if (table === null) {
    t.skip('converter/src/issues.py 不存在')
    return
  }
  const divergent: string[] = []
  for (const spec of Object.values(CONVERTER_ISSUE_CODES)) {
    const expected = pySeverity(spec.code, table)
    if (spec.severity !== expected) divergent.push(`${spec.code}: 本层=${spec.severity} issues.py=${expected}`)
  }
  assert.deepEqual(divergent, [], '出现改级（本层不允许改转换器 issue 的严重度）')
})

test('converter 映射：转换器真实发出的 code 全部已登记（新 code 会被这条测试提醒）', () => {
  const emitted = new Set<string>()
  for (const name of readdirSync(CONVERTER_SRC)) {
    if (!name.endsWith('.py')) continue
    const source = readFileSync(join(CONVERTER_SRC, name), 'utf8')
    for (const match of source.matchAll(/"code":\s*"([a-z0-9_]+)"/gu)) emitted.add(match[1])
    for (const match of source.matchAll(/'code':\s*'([a-z0-9_]+)'/gu)) emitted.add(match[1])
  }
  assert.ok(emitted.size >= 20, `只扫到 ${emitted.size} 个 code，扫描逻辑可能失效`)
  const missing = [...emitted].filter((code) => !knownIssueCodes().includes(code)).sort()
  assert.deepEqual(missing, [], '转换器发出的 code 没有映射（映射表必须保持完整）')
})

test('查表：已登记返回登记值，未登记返回 fail-closed 兜底且保留原 code', () => {
  const known = lookupIssueCode('pdf_no_text')
  assert.equal(known.registered, true)
  assert.equal(known.spec.severity, 'HARD')
  const unknown = lookupIssueCode('mystery_future_code')
  assert.equal(unknown.registered, false)
  assert.equal(unknown.spec.severity, 'HARD')
  assert.equal(unknown.spec.retryable, false)
  assert.equal(unknown.spec.suggested_action, 'human_review')
  assert.equal(unknown.spec.code, 'mystery_future_code', '原 code 必须保留，不能被吞掉')
})

// ---------------------------------------------------------------------------
// 2. 六类故障注入
// ---------------------------------------------------------------------------

test('注入 1a：PDF 有 3 页但第 2/3 页 0 block → doc_page_coverage_missing（HARD / vision_read）', () => {
  const content = makeContent(goodBlocks(), {
    meta: {
      pages: 3,
      order_verified: true,
      backend: 'pymupdf+layout/1.28.0',
      page_info: [
        { page: 1, chars: 120, block_count: 4, readable: true },
        { page: 2, chars: 0, block_count: 0, readable: true },
        { page: 3, chars: 0, block_count: 0, readable: true },
      ],
    },
  })
  const assessment = assess(content)
  const issue = issueOf(assessment, 'doc_page_coverage_missing')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.retryable, true)
  assert.equal(issue.suggested_action, 'vision_read')
  const covered = assessment.issues
    .filter((item) => item.code === 'doc_page_coverage_missing')
    .map((item) => (item.locator as { page: number }).page)
  assert.deepEqual(covered, [2, 3])
  assert.equal(assessment.blocking, true)
  assert.notEqual(assessment.completeness, 'complete')
  assert.ok(assessment.blocking_codes.includes('doc_page_coverage_missing'))
})

test('注入 1b：整份材料 0 block（正文也没有）→ doc_block_missing（HARD / vision_read）', () => {
  const assessment = assess(makeContent([], { text: '', completeness: 'partial', meta: { pages: 2, order_verified: true } }))
  const issue = issueOf(assessment, 'doc_block_missing')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.suggested_action, 'vision_read')
  assert.equal(assessment.blocking, true)
  assert.notEqual(assessment.completeness, 'complete')
  // 0 block 本身已经解释了「为什么不是 complete」，不应再报 doc_completeness_unexplained
  assert.equal(codes(assessment).includes('doc_completeness_unexplained'), false)
})

test('注入 1c：分页材料没有页数 → doc_page_count_unverified（HARD / switch_reader）', () => {
  const content = makeContent(goodBlocks(), {
    meta: { backend: 'pymupdf+layout/1.28.0', order_verified: true },
  })
  const assessment = assess(content)
  const issue = issueOf(assessment, 'doc_page_count_unverified')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.suggested_action, 'switch_reader')
  assert.equal(assessment.blocking, true)
})

test('注入 2：原生字符数 120 但输出只剩一部分 → doc_char_fidelity_mismatch（HARD / switch_reader）', () => {
  const full = goodContent()
  const truncated = String(full.text).slice(0, 20)
  const content = { ...full, text: truncated, source_chars: 120 }
  const assessment = assess(content)
  const issue = issueOf(assessment, 'doc_char_fidelity_mismatch')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.retryable, false)
  assert.equal(issue.suggested_action, 'switch_reader')
  assert.match(assessment.issues.find((item) => item.code === 'doc_char_fidelity_mismatch')?.message ?? '', /原生文本非空白字符 120/u)
  assert.equal(assessment.blocking, true)
  assert.notEqual(assessment.completeness, 'complete')
})

test('注入 2b：正文里出现坏字形 → doc_unreadable_glyph_in_body（HARD）', () => {
  const blocks = goodBlocks()
  blocks[0] = { ...blocks[0], text: '张\ufffd三' }
  const assessment = assess(makeContent(blocks))
  const issue = issueOf(assessment, 'doc_unreadable_glyph_in_body')
  assert.equal(issue.severity, 'HARD')
  assert.equal(countUnreadableMarkers('a\ufffdb(cid:12)c'), 2)
  assert.equal(assessment.facts.unreadable_markers, 1)
  assert.equal(assessment.blocking, true)
})

test('注入 3a：原件有 URI、输出里没有 → doc_uri_lost（HARD / switch_reader）', () => {
  const content = makeContent(goodBlocks(), {
    native_links: ['https://example.invalid/profile/candidate-a'],
  })
  const assessment = assess(content)
  const issue = issueOf(assessment, 'doc_uri_lost')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.suggested_action, 'switch_reader')
  // 没有凭空生成，就不该同时报 fabricated
  assert.equal(codes(assessment).includes('doc_uri_fabricated'), false)
  assert.equal(assessment.facts.uri_verified, true)
})

test('注入 3b：输出里出现原件没有的 URI → doc_uri_fabricated（HARD / human_review）', () => {
  const blocks = goodBlocks()
  blocks.push({
    block_id: 'b5',
    kind: 'link',
    order: 5,
    text: '个人主页 https://example.invalid/invented-by-model',
    locator: { kind: 'pdf', page: 1, bbox: [50, 280, 400, 300] },
    provenance: 'native_text',
    links: [{ text: '个人主页', href: 'https://example.invalid/invented-by-model' }],
  })
  const content = makeContent(blocks, { native_links: [] })
  const assessment = assess(content)
  const issue = issueOf(assessment, 'doc_uri_fabricated')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.suggested_action, 'human_review')
  assert.equal(codes(assessment).includes('doc_uri_lost'), false)
  assert.equal(assessment.blocking, true)
})

test('注入 4a：版面后端已应用但 order_verified=false → doc_reading_order_unverified（HARD / vision_read）', () => {
  const content = goodContent({
    meta: { pages: 1, order_verified: false, layout_backend: 'pdf-layout/1.28.0', backend: 'pymupdf+layout/1.28.0' },
  })
  const assessment = assess(content)
  const issue = issueOf(assessment, 'doc_reading_order_unverified')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.retryable, true)
  assert.equal(issue.suggested_action, 'vision_read')
  assert.equal(assessment.blocking, true)
  assert.notEqual(assessment.completeness, 'complete')
})

test('注入 4 的反例：order_verified=false 但没有版面后端只是「没按几何排」，不阻断', () => {
  // 真实证据：U1 的 PDF 读取器对一份干净单栏 PDF 输出 meta.order_verified=false
  // （转换器 order_verified = bool(layout) and all(layout_order_applied)）。
  // 若把它当「顺序不可靠」，每一份原生文字 PDF 都会被误阻断。
  const content = goodContent({ meta: { pages: 1, order_verified: false, layout_backend: null, backend: 'pymupdf/1.28.0' } })
  const assessment = assess(content)
  assert.equal(codes(assessment).includes('doc_reading_order_unverified'), false)
  assert.equal(assessment.blocking, false)
  assert.equal(assessment.completeness, 'complete')
})

test('注入 4b：转换器自己报的顺序问题一定阻断（继承映射，不看声明）', () => {
  const content = goodContent({
    meta: { pages: 1, order_verified: false, layout_backend: null },
    completeness: 'partial',
    issues: [{ code: 'pdf_reading_order_unverified', message: 'native content stream jumps backwards', location: { page: 1 } }],
  })
  const assessment = assess(content)
  const issue = issueOf(assessment, 'pdf_reading_order_unverified')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.suggested_action, 'switch_reader')
  assert.equal(assessment.blocking, true)
})

test('注入 4c：声明 order_verified=true 但 block order 自相矛盾 → 仍判未核', () => {
  const blocks = goodBlocks()
  blocks[2] = { ...blocks[2], order: 9 }
  const assessment = assess(makeContent(blocks))
  const issue = issueOf(assessment, 'doc_reading_order_unverified')
  assert.equal(issue.severity, 'HARD')
  assert.match(assessment.issues.find((item) => item.code === 'doc_reading_order_unverified')?.message ?? '', /非严格递增/u)
})

test('注入 5：公司在一个区块、时间+职位在另一个不同行的区块 → doc_cross_block_attribution（HARD / human_review）', () => {
  const blocks = [
    { block_id: 'row-org', kind: 'paragraph', order: 1, text: 'Example Technology Ltd', locator: { kind: 'pdf', page: 1, bbox: [300, 160, 480, 178] }, provenance: 'native_text' },
    { block_id: 'row-date', kind: 'paragraph', order: 2, text: '2021.07 - 2024.06 后端工程师', locator: { kind: 'pdf', page: 1, bbox: [50, 200, 280, 218] }, provenance: 'native_text' },
  ]
  const assessment = assess(makeContent(blocks))
  const issue = issueOf(assessment, 'doc_cross_block_attribution')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.retryable, false)
  assert.equal(issue.suggested_action, 'human_review')
  assert.ok(issue.locator !== null, '必须给出时间行的定位')
  assert.ok(assessment.issues.find((item) => item.code === 'doc_cross_block_attribution')?.locators.length === 2,
    '两个区块的定位都要给出（原文定位）')
  assert.equal(assessment.blocking, true)
  assert.notEqual(assessment.completeness, 'complete')
})

test('注入 5 的反例：同一可视行、同一区块内的时间+公司不报跨块错配（判据有边界）', () => {
  const sameRow = [
    { block_id: 'l', kind: 'paragraph', order: 1, text: 'Example Technology Ltd', locator: { kind: 'pdf', page: 1, bbox: [50, 160, 200, 178] }, provenance: 'native_text' },
    { block_id: 'r', kind: 'paragraph', order: 2, text: '2021.07 - 2024.06 后端工程师', locator: { kind: 'pdf', page: 1, bbox: [300, 161, 480, 179] }, provenance: 'native_text' },
  ]
  const assessment = assess(makeContent(sameRow))
  assert.equal(codes(assessment).includes('doc_cross_block_attribution'), false)
})

test('注入 6a：agent_read 来源的身份块 → doc_provenance_unverified + doc_identity_from_unverified_source（均 HARD / human_review）', () => {
  const blocks = goodBlocks()
  blocks[1] = { ...blocks[1], provenance: 'agent_read' }
  const assessment = assess(makeContent(blocks, { completeness: 'partial' }))
  const provenance = issueOf(assessment, 'doc_provenance_unverified')
  assert.equal(provenance.severity, 'HARD')
  assert.equal(provenance.suggested_action, 'human_review')
  const identity = issueOf(assessment, 'doc_identity_from_unverified_source')
  assert.equal(identity.severity, 'HARD')
  assert.equal(identity.suggested_action, 'human_review')
  assert.equal(assessment.facts.model_text_blocks, 1)
  assert.equal(assessment.blocking, true)
})

test('注入 6b：ocr 来源同样未核；provenance 缺失/不在闭集内也按未核处理', () => {
  const ocrBlocks = goodBlocks()
  ocrBlocks[2] = { ...ocrBlocks[2], provenance: 'ocr' }
  assert.ok(codes(assess(makeContent(ocrBlocks))).includes('doc_provenance_unverified'))

  const missing = goodBlocks().map((block) => {
    const copy: Record<string, unknown> = { ...block }
    delete copy.provenance
    return copy
  })
  const assessment = assess(makeContent(missing as unknown as Block[]))
  assert.ok(codes(assessment).includes('doc_provenance_unverified'))
  assert.ok(assessment.facts.unknown_provenance_blocks === 4)
  assert.equal(assessment.blocking, true)
})

test('注入 6 的反例：docling 是文本层解析器，不是模型生成，不触发来源阻断', () => {
  const blocks = goodBlocks().map((block) => ({ ...block, provenance: 'docling' }))
  const assessment = assess(makeContent(blocks))
  assert.equal(codes(assessment).includes('doc_provenance_unverified'), false)
  assert.equal(assessment.blocking, false)
})

test('六类故障注入：每一类都真实阻断，且都能被下游识别', () => {
  const injected: Array<[string, Record<string, unknown>]> = [
    ['coverage', makeContent(goodBlocks(), {
      meta: { pages: 2, order_verified: true, page_info: [{ page: 1, chars: 120, block_count: 4 }, { page: 2, chars: 0, block_count: 0 }] },
    })],
    ['fidelity', { ...goodContent(), source_chars: 999 }],
    ['uri', makeContent(goodBlocks(), { native_links: ['https://example.invalid/x'] })],
    ['order', goodContent({ meta: { pages: 1, order_verified: false, layout_backend: 'pdf-layout/1.28.0' } })],
    ['attribution', makeContent([
      { block_id: 'a', kind: 'paragraph', order: 1, text: 'Example Technology Ltd', locator: { kind: 'pdf', page: 1, bbox: [300, 160, 480, 178] }, provenance: 'native_text' },
      { block_id: 'b', kind: 'paragraph', order: 2, text: '2021.07 - 2024.06 后端工程师', locator: { kind: 'pdf', page: 1, bbox: [50, 200, 280, 218] }, provenance: 'native_text' },
    ])],
    ['provenance', makeContent(goodBlocks().map((block, index) => (index === 1 ? { ...block, provenance: 'agent_read' } : block)))],
  ]
  for (const [label, content] of injected) {
    const assessment = assess(content)
    assert.equal(assessment.blocking, true, `${label}: 必须阻断`)
    assert.notEqual(assessment.completeness, 'complete', `${label}: 质量不足不得 complete`)
    assert.ok(assessment.blocking_codes.length > 0, `${label}: 下游必须能看到 blocking code`)
    assert.ok(assessment.actions.length > 0, `${label}: 必须给出可行动作`)
    const recovery = plan(content, { assessment })
    assert.equal(recovery.blocking, true, `${label}: 计划必须带 blocking`)
    assert.ok(recovery.steps.some((step) => step.blocking), `${label}: 计划里必须有阻断步`)
    assert.equal(mayConcludeAbsence(assessment).allowed, false, `${label}: 不得据缺字下缺席结论`)
  }
})

// ---------------------------------------------------------------------------
// 3. 未知 code → fail-closed
// ---------------------------------------------------------------------------

test('未知 issue code → HARD + human_review + 不可重试（不许当 SOFT 放行）', () => {
  const content = goodContent({ issues: [{ code: 'some_future_code', message: '未来的 code' }] })
  const assessment = assess(content)
  const issue = issueOf(assessment, 'some_future_code')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.retryable, false)
  assert.equal(issue.suggested_action, 'human_review')
  assert.deepEqual([...assessment.unregistered_codes], ['some_future_code'])
  assert.equal(assessment.blocking, true)
  assert.notEqual(assessment.completeness, 'complete')
  // 计划必须把它分派给工程侧，而不是招聘同学「看着办」
  const recovery = plan(content, { assessment })
  const step = recovery.steps.find((item) => item.codes.includes('some_future_code'))
  assert.ok(step !== undefined, '未知 code 必须出现在计划里')
  assert.equal(step?.role, 'engineering')
  assert.equal(step?.blocking, true)
})

test('未知 issue code 即使长得像 SOFT 前缀，也不放宽（比 issues.py 的前缀规则更严）', () => {
  for (const code of ['unverified_mystery', 'html_thing', 'pdf_reading_order_new']) {
    const assessment = assess(goodContent({ issues: [{ code, message: 'x' }] }))
    assert.equal(issueOf(assessment, code).severity, 'HARD', `${code} 被当成 SOFT 放行了`)
    assert.equal(assessment.blocking, true, code)
  }
})

test('上游自称 SOFT 的未知 code → 仍然 HARD（只允许升级，不允许降级）', () => {
  const assessment = assess(goodContent({
    issues: [{ code: 'totally_new', message: 'x', severity: 'SOFT', retryable: true, suggested_action: 'none' }],
  }))
  const issue = issueOf(assessment, 'totally_new')
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.suggested_action, 'human_review')
  assert.equal(assessment.blocking, true)
})

test('上游 issue 缺 code → 按契约不合法处理（HARD），不静默丢弃', () => {
  const assessment = assess(goodContent({ issues: [{ message: '没有 code 的问题' }] }))
  const issue = issueOf(assessment, 'doc_contract_invalid')
  assert.equal(issue.severity, 'HARD')
  assert.equal(assessment.blocking, true)
})

// ---------------------------------------------------------------------------
// 4. 三条不变量
// ---------------------------------------------------------------------------

test('不变量 I1：unreadable 永不降级成 absent（SR §3.2 红线）', () => {
  // 扫描件：整份没有可机读文本
  const scanned = makeContent([], {
    text: '',
    completeness: 'partial',
    meta: { pages: 3, order_verified: false, backend: 'pymupdf/1.28.0' },
    issues: [{ code: 'pdf_no_text', message: 'PDF has no machine-readable text' }],
  })
  const assessment = assess(scanned)
  assert.equal(evidenceState(assessment), 'unreadable')
  for (const field of ['name', 'phone', 'email', 'experience']) {
    assert.equal(fieldPresence(evidenceState(assessment), false), 'unreadable', field)
    assert.notEqual(fieldPresence(evidenceState(assessment), false), 'absent', field)
  }
  // 反证：只有「已核实 + 确实没有」才允许 absent
  const verified = assess(goodContent())
  assert.equal(evidenceState(verified), 'verified')
  assert.equal(fieldPresence(evidenceState(verified), false), 'absent')
  assert.equal(fieldPresence('unverified', false), 'unreadable', '未核实状态不得断言缺失')
  assert.equal(fieldPresence('unreadable', true), 'unreadable', 'unreadable 状态即使命中也只能是 unreadable')
})

test('不变量 I1b：字段读不出（resume_field_unreadable）时不得报 absent，且阻断', () => {
  const content = goodContent({
    issues: [{ code: 'resume_field_unreadable', message: '字段在原文出现但读不出', location: { page: 1 } }],
    completeness: 'partial',
  })
  const assessment = assess(content)
  assert.equal(assessment.blocking, true)
  assert.equal(fieldPresence(evidenceState(assessment), false), 'unreadable')
  assert.equal(mayConcludeAbsence(assessment).allowed, false)
})

test('不变量 I2：质量不足时 completeness != complete，且 blocking 项可被下游识别', () => {
  const cases = [
    makeContent(goodBlocks(), { meta: { pages: 2, order_verified: true, page_info: [{ page: 1, chars: 10, block_count: 4 }, { page: 2, chars: 0, block_count: 0 }] } }),
    { ...goodContent(), source_chars: 1 },
    goodContent({ meta: { pages: 1, order_verified: false, layout_backend: 'pdf-layout/1.28.0' } }),
    goodContent({ issues: [{ code: 'pdf_no_text', message: 'x' }], completeness: 'partial' }),
  ]
  for (const content of cases) {
    const assessment = assess(content)
    assert.notEqual(assessment.completeness, 'complete')
    assert.equal(assessment.blocking, true)
    assert.ok(assessment.blocking_codes.length > 0)
    assert.equal(canProceedToStructure(assessment), false)
    assert.equal(isBlocked(assessment), true)
  }
})

test('不变量 I3：不以缺字推断缺经历（mayConcludeAbsence 只在完整且已核实时放行）', () => {
  const clean = assess(goodContent())
  assert.deepEqual(mayConcludeAbsence(clean), {
    allowed: true,
    reason: '阅读完整且已核实，可以就「原文未出现」下结论',
  })
  const partial = assess(makeContent(goodBlocks(), {
    completeness: 'partial',
    issues: [{ code: 'resume_timeline_gap', message: '时间线断档' }],
  }))
  assert.equal(partial.blocking, false, '只有 SOFT 时不该阻断')
  assert.equal(mayConcludeAbsence(partial).allowed, false)
  assert.match(mayConcludeAbsence(partial).reason, /completeness=partial/u)

  const blocked = assess(goodContent({ meta: { pages: 1, order_verified: false, layout_backend: 'pdf-layout/1.28.0' } }))
  assert.equal(mayConcludeAbsence(blocked).allowed, false)
  assert.match(mayConcludeAbsence(blocked).reason, /HARD/u)
})

test('不变量 I2b：没有 issue 时不升级 completeness（只降不升）', () => {
  const declaredPartial = assess({ ...goodContent(), completeness: 'partial', issues: [] })
  assert.notEqual(declaredPartial.completeness, 'complete')
  // 上游 partial 却没有任何解释 → 静默降级，按 HARD 兜住
  assert.ok(codes(declaredPartial).includes('doc_completeness_unexplained'))

  const declaredUnverified = assess({ ...goodContent(), completeness: 'unverified' })
  assert.equal(declaredUnverified.completeness, 'unverified')
  assert.equal(declaredUnverified.blocking, false)
})

// ---------------------------------------------------------------------------
// 5. 输入健壮性与纯函数性
// ---------------------------------------------------------------------------

test('非对象/字段类型错/访问器抛异常：一律 fail-closed，不抛到调用方', () => {
  for (const bad of [null, undefined, 42, 'text', [], true] as unknown[]) {
    const assessment = assess(bad)
    assert.equal(assessment.blocking, true, JSON.stringify(bad))
    assert.notEqual(assessment.completeness, 'complete')
    assert.ok(codes(assessment).includes('doc_contract_invalid'))
  }
  const wrongTypes = assess({ ...goodContent(), blocks: 'not-an-array' })
  assert.equal(issueOf(wrongTypes, 'doc_contract_invalid').severity, 'HARD')

  const hostile = {
    get blocks(): never { throw new Error('boom') },
  }
  const failed = assess(hostile)
  assert.equal(failed.blocking, true)
  assert.match(String(failed.issues.find((item) => item.code === 'doc_contract_invalid')?.message), /fail-closed/u)
})

test('媒体类型不在闭集内 → doc_media_unsupported（HARD），不猜', () => {
  const assessment = assess({ ...goodContent(), media_type: 'application/x-msdownload' })
  assert.equal(issueOf(assessment, 'doc_media_unsupported').severity, 'HARD')
  assert.equal(assessment.blocking, true)
})

test('确定性：同一输入两次判定完全一致（排除运行字段）', () => {
  const content = makeContent(goodBlocks(), { meta: { pages: 2, order_verified: false } })
  assert.deepEqual(assess(content), assess(content))
  assert.equal(nonWhitespaceChars('  中 文\n'), 2)
})

test('canonical 契约（U0 形状、封闭、无 meta）必须显式传 reader facts，否则页覆盖无法核对', () => {
  const blocks = goodBlocks().map((block) => ({
    block_id: block.block_id,
    kind: block.kind,
    text: block.text,
    order: block.order,
    locator: block.locator,
    links: [],
    provenance: block.provenance,
  }))
  const canonical = {
    schema_version: '1.0.0',
    asset_sha256: 'd'.repeat(64),
    media_type: 'application/pdf',
    reader_id: 'pdf:pymupdf-mounted/1.28.0',
    reader_version: '1.28.0',
    text: blocks.map((block) => block.text).join('\n\n'),
    blocks,
    completeness: 'complete',
    needs_visual: false,
    issues: [],
    elapsed_ms: 12,
  }
  const withoutFacts = assess(canonical)
  assert.equal(withoutFacts.blocking, true, '没有页数就不得判合格')
  assert.ok(withoutFacts.blocking_codes.includes('doc_page_count_unverified'))

  const withFacts = assess(canonical, { page_count: 1, order_verified: true })
  assert.equal(withFacts.blocking, false)
  assert.equal(withFacts.completeness, 'complete')

  // 转换器形状（location + meta）与 canonical+facts 必须得到同样的结论
  const converterShape = makeContent(goodBlocks())
  const fromConverter = assess(converterShape)
  assert.deepEqual(
    fromConverter.issues.map((issue) => issue.code),
    withFacts.issues.map((issue) => issue.code),
  )
  assert.equal(fromConverter.completeness, withFacts.completeness)
})

test('source_meta → reader facts 桥：canonical 内容必须接上旁路证据才可能判合格', () => {
  const canonical = {
    schema_version: '1.0.0',
    asset_sha256: 'f'.repeat(64),
    media_type: 'application/pdf',
    reader_id: 'pdf:pymupdf-mounted/1.28.0',
    reader_version: '1.28.0',
    text: goodBlocks().map((block) => block.text).join('\n\n'),
    blocks: goodBlocks().map((block) => ({ ...block })),
    completeness: 'complete',
    needs_visual: false,
    issues: [],
    elapsed_ms: 5,
  }
  // 没有 facts：页覆盖无法核对 → HARD
  assert.equal(assess(canonical).blocking, true)

  const facts = readerFactsFromSourceMeta({
    converter_meta: {
      pages: 1,
      order_verified: false,
      layout_backend: null,
      page_info: [{ page: 1, chars: 120, block_count: 4, readable: true }],
    },
  })
  assert.equal(facts.page_count, 1)
  assert.equal(facts.order_verified, false)
  assert.equal(facts.layout_backend, null)
  assert.equal(facts.page_info?.length, 1)

  const bridged = assess(canonical, facts)
  assert.equal(bridged.blocking, false)
  assert.equal(bridged.completeness, 'complete')
  assert.equal(bridged.facts.page_count, 1)

  // 裸转换器 meta 形状也认；垃圾输入得到空 facts（不抛）
  assert.equal(readerFactsFromSourceMeta({ pages: 2 }).page_count, 2)
  assert.deepEqual(readerFactsFromSourceMeta(null), {})
  assert.deepEqual(readerFactsFromSourceMeta('junk'), {})
})

test('纯函数性：质量层与恢复层不 import 模型/网络/子进程，也不碰 tools/ 与 db/', () => {
  const files = [
    join(PKG_ROOT, 'src', 'document', 'quality', 'assess.ts'),
    join(PKG_ROOT, 'src', 'document', 'quality', 'checks.ts'),
    join(PKG_ROOT, 'src', 'document', 'quality', 'normalize.ts'),
    join(PKG_ROOT, 'src', 'document', 'quality', 'issue-codes.ts'),
    join(PKG_ROOT, 'src', 'document', 'quality', 'source-facts.ts'),
    join(PKG_ROOT, 'src', 'document', 'recovery', 'plan.ts'),
    join(PKG_ROOT, 'src', 'document', 'recovery', 'types.ts'),
  ]
  const forbidden = [
    /from\s+'node:(?:child_process|http|https|net|dns|tls)'/u,
    /from\s+'(?:\.\.\/)+(?:tools|db)\//u,
    /\bfetch\s*\(/u,
    /\bexecFile(?:Sync)?\s*\(/u,
    /\bspawn(?:Sync)?\s*\(/u,
    /\bopenai|anthropic|@ai-sdk|langchain/iu,
  ]
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${file} 命中了禁止模式 ${pattern}`)
    }
  }
})
