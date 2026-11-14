// 现有 PDF 输出的**无损映射**证明（docs/19 §3 U0 的验收项）。
//
// 这一组用例回答一个问题：把 `converter/src/cli.py` 的真实输出塞进新契约，会不会丢东西？
// 证据分四层，任何一层说谎都会红：
//   1. 转换器真跑（起 Python 子进程读合成 PDF），不是喂假 JSON；
//   2. `auditConverterMapping()` 逐块/逐 issue 比对，且**能检测篡改**（M12 反证它不是空函数）；
//   3. sha256 三方一致：Node 算的文件指纹 = content.asset_sha256 = converter meta.source_sha256；
//   4. issue 严重度与 Python 侧 `converter/src/issues.py` 逐 code 比对（镜像表的漂移守卫）。
//
// 所有路径用 `path.join`，临时目录用 `os.tmpdir()`，不出现任何盘符。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import {
  CONVERTER_BLOCK_KIND_MAP,
  CONVERTER_HARD_ISSUE_CODES,
  CONVERTER_KEYS_CARRIED,
  CONVERTER_KEYS_NOT_CARRIED,
  CONVERTER_META_KEYS_CARRIED,
  CONVERTER_META_KEYS_NOT_CARRIED,
  CONVERTER_SOFT_ISSUE_CODES,
  CONVERTER_SOFT_ISSUE_PREFIXES,
  auditConverterMapping,
  converterIssueAction,
  converterIssueSeverity,
  mapConverterToDocumentContent,
  type ConverterLikeIssue,
  type ConverterLikeOutput,
} from '../../src/document/contracts/map-converter.ts'
import { validateDocumentContent } from '../../src/document/contracts/validate.ts'
import type { DocumentContent } from '../../src/document/contracts/types.ts'
import { MEDIA_RTF } from '../../src/document/readers/media.ts'
import { CONVERTER_DIR, ensureFixtures, fixturePath, sha256OfFile, type Fixtures } from './fixtures.ts'

let fixtures: Fixtures | null = null
const outputCache = new Map<string, ConverterLikeOutput>()
const contentCache = new Map<string, DocumentContent>()

/** 惰性生成 fixture（这个文件只用得到 PDF 样本）。 */
function setup(): Fixtures {
  fixtures ??= ensureFixtures()
  return fixtures
}

after(() => {
  if (fixtures === null) return
  const dir = resolve(fixtures.dir)
  if (dir.startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true })
})

/**
 * 真跑一次 `python -m src.cli <pdf> --no-isolation`，拿完整 JSON。
 * **不吞错误**：转换器崩了就是测试失败，不是 skip。
 */
function converterOutput(name: string): ConverterLikeOutput {
  const cached = outputCache.get(name)
  if (cached !== undefined) return cached
  const generated = setup()
  const stdout = execFileSync(generated.python.bin, ['-m', 'src.cli', fixturePath(generated, name), '--no-isolation'], {
    cwd: CONVERTER_DIR,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const trimmed = stdout.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  assert.ok(start >= 0 && end > start, `${name}: converter 没有输出 JSON`)
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as ConverterLikeOutput
  outputCache.set(name, parsed)
  return parsed
}

/** 映射 + 校验（SHA 由“读过文件字节的一方”提供，模拟 U1 的调用姿势）。 */
function mapped(name: string): { content: DocumentContent; valid: boolean; violations: string[] } {
  const generated = setup()
  const output = converterOutput(name)
  const content = mapConverterToDocumentContent(output, {
    asset_sha256: sha256OfFile(fixturePath(generated, name)),
    elapsed_ms: 1,
  })
  const validation = validateDocumentContent(content)
  return {
    content,
    valid: validation.valid,
    violations: validation.violations.map((violation) => `${violation.code}@${violation.path}`),
  }
}

/** 取映射结果（带缓存）。 */
function contentFor(name: string): DocumentContent {
  const cachedContent = contentCache.get(name)
  if (cachedContent !== undefined) return cachedContent
  const { content } = mapped(name)
  contentCache.set(name, content)
  return content
}

// ---------------------------------------------------------------------------
// 1. 正常文字 PDF：无损 + 契约合法
// ---------------------------------------------------------------------------

test('M1 合成文字 PDF：映射后契约校验通过，且块/链接/issue 全部有归宿', () => {
  const generated = setup()
  const output = converterOutput('text_simple.pdf')
  assert.ok((output.blocks ?? []).length > 0, '转换器在合成文字 PDF 上应当读到块')
  assert.equal(output.completeness, 'complete', '干净的合成文字 PDF 应当是 complete')

  const { content, valid, violations } = mapped('text_simple.pdf')
  assert.equal(valid, true, `映射结果不合法：${violations.join(', ')}`)
  assert.equal(content.media_type, 'application/pdf')
  assert.equal(content.schema_version, '1.0.0')
  assert.equal(content.reader_id, output.meta?.backend)
  assert.equal(content.reader_version, output.meta?.reader_version)
  assert.equal(content.blocks.length, (output.blocks ?? []).length)
  assert.equal(content.asset_sha256, sha256OfFile(fixturePath(generated, 'text_simple.pdf')))
})

test('M2 sha256 三方一致：Node 文件指纹 = content.asset_sha256 = converter meta.source_sha256', () => {
  const generated = setup()
  const output = converterOutput('text_simple.pdf')
  const content = contentFor('text_simple.pdf')
  const fromDisk = sha256OfFile(fixturePath(generated, 'text_simple.pdf'))
  assert.equal(fromDisk.length, 64)
  assert.equal(content.asset_sha256, fromDisk)
  assert.equal(output.meta?.source_sha256, fromDisk)
})

test('M3 无损：块数、文本、类型、顺序、页码、bbox、provenance 逐项相等', () => {
  const output = converterOutput('text_simple.pdf')
  const content = contentFor('text_simple.pdf')
  const rawBlocks = output.blocks ?? []
  assert.equal(content.blocks.length, rawBlocks.length)

  const pages = new Set<number>()
  for (let i = 0; i < rawBlocks.length; i += 1) {
    const raw = rawBlocks[i]!
    const block = content.blocks[i]!
    assert.equal(block.block_id, `b${i + 1}`)
    assert.equal(block.order, i, 'order 必须等于阅读顺序下标')
    assert.equal(block.text, raw.text, `blocks[${i}].text 必须逐字相等`)
    assert.equal(block.kind, CONVERTER_BLOCK_KIND_MAP[raw.kind ?? 'other'] ?? 'other')
    assert.equal(block.provenance, raw.provenance, `blocks[${i}].provenance 必须原样搬运`)
    assert.equal(block.locator.kind, 'pdf')
    if (block.locator.kind === 'pdf') {
      assert.equal(block.locator.page, raw.location?.page, `blocks[${i}] 页码不符`)
      assert.equal(block.locator.block_id, String(i), 'pdf locator 必须保留读取器自己的块号')
      pages.add(block.locator.page)
      if (raw.location?.bbox === undefined) {
        assert.equal(block.locator.bbox, undefined, '读取器没给 bbox 时不许编一个')
      } else {
        assert.deepEqual(block.locator.bbox, raw.location.bbox, `blocks[${i}] bbox 必须逐值相等`)
      }
    }
    const rawLinks = raw.links ?? []
    assert.equal((block.links ?? []).length, rawLinks.length)
    for (let j = 0; j < rawLinks.length; j += 1) {
      assert.equal(block.links?.[j]?.text, rawLinks[j]?.text)
      assert.equal(block.links?.[j]?.href, rawLinks[j]?.href)
    }
  }
  // 两页的原件必须两页都出现在证据里（否则「页覆盖」是假的）。
  assert.deepEqual([...pages].sort((a, b) => a - b), [1, 2])
})

test('M4 completeness / needs_visual / issues 原样保留（顺序也一致）', () => {
  const output = converterOutput('text_simple.pdf')
  const content = contentFor('text_simple.pdf')
  assert.equal(content.completeness, output.completeness)
  assert.equal(content.needs_visual, output.needs_visual)
  const rawIssues = output.issues ?? []
  assert.equal(content.issues.length, rawIssues.length)
  for (let i = 0; i < rawIssues.length; i += 1) {
    assert.equal(content.issues[i]?.code, rawIssues[i]?.code)
    assert.equal(content.issues[i]?.message, rawIssues[i]?.message)
    assert.equal(content.issues[i]?.severity, converterIssueSeverity(rawIssues[i]?.code))
  }
})

test('M5 同一文件两次结果一致（排除 elapsed_ms 这个运行字段）', () => {
  const first = contentFor('text_simple.pdf')
  // 重新跑一次子进程，绕开所有缓存。
  const stdout = execFileSync(setup().python.bin, ['-m', 'src.cli', fixturePath(setup(), 'text_simple.pdf'), '--no-isolation'], {
    cwd: CONVERTER_DIR,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const trimmed = stdout.trim()
  const second = mapConverterToDocumentContent(
    JSON.parse(trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)) as ConverterLikeOutput,
    { asset_sha256: first.asset_sha256, elapsed_ms: 0 },
  )
  const normalize = (content: DocumentContent): unknown => ({ ...content, elapsed_ms: 0 })
  assert.deepEqual(normalize(second), normalize(first))
  assert.equal(second.blocks.length, first.blocks.length)
  assert.equal(second.asset_sha256, first.asset_sha256)
})

test('M6 converter 的每个顶层键都有明确归宿：要么被搬运，要么在「不搬运」表里', () => {
  const raw = converterOutput('text_simple.pdf') as unknown as Record<string, unknown>
  const covered = new Set([...CONVERTER_KEYS_CARRIED, ...Object.keys(CONVERTER_KEYS_NOT_CARRIED)])
  const unaccounted = Object.keys(raw).filter((key) => !covered.has(key))
  assert.deepEqual(
    unaccounted,
    [],
    `converter 新增了没登记的顶层键：${unaccounted.join(', ')}；请决定是搬运还是写进 CONVERTER_KEYS_NOT_CARRIED`,
  )
  const meta = (raw.meta ?? {}) as Record<string, unknown>
  const metaCovered = new Set([...CONVERTER_META_KEYS_CARRIED, ...Object.keys(CONVERTER_META_KEYS_NOT_CARRIED)])
  const unaccountedMeta = Object.keys(meta).filter((key) => !metaCovered.has(key))
  assert.deepEqual(
    unaccountedMeta,
    [],
    `converter meta 新增了没登记的键：${unaccountedMeta.join(', ')}`,
  )
})

test('M7 issue 严重度与 converter/src/issues.py 逐 code 一致（镜像表的漂移守卫）', () => {
  const codes = [
    ...CONVERTER_HARD_ISSUE_CODES,
    ...CONVERTER_SOFT_ISSUE_CODES,
    ...CONVERTER_SOFT_ISSUE_PREFIXES.map((prefix) => `${prefix}probe`),
    'unknown_code_for_drift_test',
  ]
  const script = [
    'import json, sys',
    'from src.issues import issue_severity',
    'codes = json.loads(sys.stdin.read())',
    'print(json.dumps({c: ("HARD" if issue_severity([{"code": c}])[0] else "SOFT") for c in codes}))',
  ].join('\n')
  const stdout = execFileSync(setup().python.bin, ['-c', script], {
    cwd: CONVERTER_DIR,
    encoding: 'utf8',
    input: JSON.stringify(codes),
    timeout: 60_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const fromPython = JSON.parse(stdout.trim()) as Record<string, 'HARD' | 'SOFT'>
  const mismatches: string[] = []
  for (const code of codes) {
    const expected = fromPython[code]
    const actual = converterIssueSeverity(code)
    if (expected !== actual) mismatches.push(`${code}: ts=${actual} py=${String(expected)}`)
  }
  assert.deepEqual(mismatches, [], `严重度镜像与 Python 不一致：${mismatches.join(', ')}`)
  // 未登记的 code 一律 HARD（保守规则本身也要被钉住）。
  assert.equal(converterIssueSeverity('unknown_code_for_drift_test'), 'HARD')
  assert.deepEqual(converterIssueAction('unknown_code_for_drift_test'), { retryable: false, suggested_action: 'human_review' })
})

test('M8 真实 issue 列表的 HARD 判定与 Python 一致（不只比表，还比实际输出）', () => {
  const names = ['text_simple.pdf', 'text_two_column.pdf', 'scan_image_only.pdf']
  const issueLists = names.map((name) => (outputCache.get(name) ?? converterOutput(name)).issues ?? [])
  const script = [
    'import json, sys',
    'from src.issues import issue_severity',
    'lists = json.loads(sys.stdin.read())',
    'print(json.dumps([issue_severity(items)[0] for items in lists]))',
  ].join('\n')
  const stdout = execFileSync(setup().python.bin, ['-c', script], {
    cwd: CONVERTER_DIR,
    encoding: 'utf8',
    input: JSON.stringify(issueLists),
    timeout: 60_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const fromPython = JSON.parse(stdout.trim()) as boolean[]
  names.forEach((name, index) => {
    const content = contentFor(name)
    const fromContract = content.issues.some((issue) => issue.severity === 'HARD')
    assert.equal(fromContract, fromPython[index], `${name}: HARD 判定与 Python 不一致`)
  })
})

// ---------------------------------------------------------------------------
// 2. 扫描 / 双栏：失败必须被如实表达（而不是变 complete）
// ---------------------------------------------------------------------------

test('M9 扫描 PDF：needs_visual + HARD issue + 0 块，契约仍然合法（失败可表达）', () => {
  const output = converterOutput('scan_image_only.pdf')
  const { content, valid, violations } = mapped('scan_image_only.pdf')
  assert.equal(valid, true, `扫描件的失败描述本身必须是合法内容：${violations.join(', ')}`)
  assert.equal(content.needs_visual, true)
  assert.equal(content.blocks.length, 0)
  assert.equal(content.text, '')
  assert.notEqual(content.completeness, 'complete')
  assert.equal(content.completeness, output.completeness)
  assert.ok(
    content.issues.some((issue) => issue.severity === 'HARD'),
    '扫描件必须带 HARD issue（不能只有一句「未识别」）',
  )
  // 读不懂的视觉内容一旦被标成 complete，校验器必须拦住（同一份数据，只改声明）。
  const lied = { ...content, completeness: 'complete' as const }
  const validation = validateDocumentContent(lied)
  assert.equal(validation.valid, false)
  assert.ok(validation.violations.some((violation) => violation.code === 'COMPLETENESS_CONTRADICTS_VISUAL'))
})

test('M10 双栏 PDF：阅读顺序未验证 = HARD + switch_reader，不是「读完了」', () => {
  const output = converterOutput('text_two_column.pdf')
  const content = contentFor('text_two_column.pdf')
  assert.notEqual(content.completeness, 'complete')
  const hard = content.issues.filter((issue) => issue.severity === 'HARD')
  assert.ok(hard.length > 0, '双栏样本必须至少带一条 HARD issue')
  const orderIssue = content.issues.find((issue) => issue.code === 'pdf_reading_order_unverified')
  assert.ok(orderIssue !== undefined, `双栏样本应报 pdf_reading_order_unverified，实际 ${content.issues.map((i) => i.code).join(', ')}`)
  assert.equal(orderIssue?.severity, 'HARD')
  assert.equal(orderIssue?.suggested_action, 'switch_reader')
  assert.equal(orderIssue?.retryable, false)
  // 所有读到的行都必须在块文本里（不许因为顺序未验证就丢字）。
  const joined = content.blocks.map((block) => block.text).join('\n')
  for (const needle of ['LEFT COLUMN HEADING', 'RIGHT COLUMN HEADING', 'LEFT LINE ALPHA', 'RIGHT LINE DELTA']) {
    assert.ok(joined.includes(needle), `双栏样本丢了这一行：${needle}`)
  }
  const validation = validateDocumentContent(content)
  assert.equal(validation.valid, true, `双栏的失败描述必须合法：${validation.violations.map((v) => v.code).join(', ')}`)
})

// ---------------------------------------------------------------------------
// 3. 坏文件：fail-closed（有 code，不冒充成功）
// ---------------------------------------------------------------------------

for (const name of ['corrupted_truncated.pdf', 'masquerade_not_a_pdf.pdf', 'zero_byte.pdf']) {
  test(`M11 ${name}：fail-closed（0 块、非 complete、HARD code），且契约能如实表达这次失败`, () => {
    const output = converterOutput(name)
    assert.equal((output.blocks ?? []).length, 0, '坏文件不该产出块')
    assert.notEqual(output.completeness, 'complete')
    const { content, valid, violations } = mapped(name)
    assert.equal(valid, true, `失败描述本身必须合法：${violations.join(', ')}`)
    assert.notEqual(content.completeness, 'complete')
    assert.ok(content.issues.length > 0, '坏文件必须带 issue code')
    assert.ok(content.issues.some((issue) => issue.severity === 'HARD'), '坏文件必须带 HARD issue')
    assert.equal(content.blocks.length, 0)
  })
}

test('M12 SHA 不许编：读取器没给指纹就留空，校验器据此拒绝（不拿空串冒充原件）', () => {
  // 真实行为：converter 读不开文件时仍会算原件指纹（这里 0 字节 → e3b0c442…）。
  const output = converterOutput('zero_byte.pdf')
  assert.equal(output.meta?.source_sha256, sha256OfFile(fixturePath(setup(), 'zero_byte.pdf')))
  assert.equal(mapped('zero_byte.pdf').content.asset_sha256, output.meta?.source_sha256)

  // 读取器根本没给指纹时（例如上游截断了 meta），映射必须留空而不是补一个值。
  const shaLess: ConverterLikeOutput = {
    text: '',
    blocks: [],
    completeness: 'partial',
    needs_visual: false,
    issues: [{ code: 'reader_failed', message: 'reader could not open the file' }],
    meta: { backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
  }
  const content = mapConverterToDocumentContent(shaLess)
  assert.equal(content.asset_sha256, '')
  const validation = validateDocumentContent(content)
  assert.equal(validation.valid, false)
  assert.ok(validation.violations.some((violation) => violation.code === 'ASSET_SHA_INVALID'))
})

test('M13 缺少页码时不伪造页码：哨兵 page=0 会被校验器判成 LOCATOR_INVALID', () => {
  const output: ConverterLikeOutput = {
    text: 'SYNTHETIC LINE WITHOUT A LOCATION',
    blocks: [{ kind: 'paragraph', text: 'SYNTHETIC LINE WITHOUT A LOCATION', location: {}, provenance: 'native_text' }],
    completeness: 'partial',
    needs_visual: false,
    issues: [{ code: 'pdf_layout_unread', message: 'no page reported' }],
    meta: { source_sha256: 'b'.repeat(64), backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
  }
  const content = mapConverterToDocumentContent(output)
  assert.equal(content.blocks[0]?.locator.kind, 'pdf')
  assert.equal(content.blocks[0]?.locator.kind === 'pdf' ? content.blocks[0]?.locator.page : undefined, 0)
  const validation = validateDocumentContent(content)
  assert.equal(validation.valid, false)
  assert.ok(validation.violations.some((violation) => violation.code === 'LOCATOR_INVALID'))
})

// ---------------------------------------------------------------------------
// 4. 审计本身要能抓错（否则「无损」只是自述）
// ---------------------------------------------------------------------------

test('M14 审计能抓到篡改：丢块 / 改文本 / 改严重度 / 改 sha 都会红', () => {
  const blocksOutput = converterOutput('text_simple.pdf')
  const blocksBase = contentFor('text_simple.pdf')
  assert.deepEqual(auditConverterMapping(blocksOutput, blocksBase).problems, [], '基线必须是零问题')

  const tamperedBlocks: [string, DocumentContent][] = [
    ['丢一个块', { ...blocksBase, blocks: blocksBase.blocks.slice(1) }],
    ['改块文本', { ...blocksBase, blocks: blocksBase.blocks.map((block, i) => (i === 0 ? { ...block, text: `${block.text} (edited)` } : block)) }],
    ['改块类型', { ...blocksBase, blocks: blocksBase.blocks.map((block, i) => (i === 0 ? { ...block, kind: 'heading' as const } : block)) }],
    ['改页码', { ...blocksBase, blocks: blocksBase.blocks.map((block, i) => (i === 0 && block.locator.kind === 'pdf' ? { ...block, locator: { ...block.locator, page: 9 } } : block)) }],
    ['改 sha', { ...blocksBase, asset_sha256: 'c'.repeat(64) }],
    ['改 completeness', { ...blocksBase, completeness: blocksBase.completeness === 'complete' ? ('partial' as const) : ('complete' as const) }],
    ['改全篇 text', { ...blocksBase, text: `${blocksBase.text}\n(edited)` }],
  ]
  for (const [label, mutated] of tamperedBlocks) {
    const audit = auditConverterMapping(blocksOutput, mutated)
    assert.equal(audit.ok, false, `审计没有发现「${label}」`)
    assert.ok(audit.problems.length > 0, `「${label}」没有给出问题描述`)
  }

  // issue 相关字段要用一份**真的有 issue** 的内容来试（干净的 PDF 上 issues 是空数组）。
  const issuesOutput = converterOutput('text_two_column.pdf')
  const issuesBase = contentFor('text_two_column.pdf')
  assert.ok(issuesBase.issues.length >= 2, '双栏样本应当带多条 issue')
  assert.deepEqual(auditConverterMapping(issuesOutput, issuesBase).problems, [], 'issue 基线也必须是零问题')
  const flipped = issuesBase.issues.map((issue) => ({
    ...issue,
    severity: issue.severity === 'HARD' ? ('SOFT' as const) : ('HARD' as const),
  }))
  const tamperedIssues: [string, DocumentContent][] = [
    ['改 issue 严重度', { ...issuesBase, issues: flipped }],
    ['丢一条 issue', { ...issuesBase, issues: issuesBase.issues.slice(1) }],
    ['改 issue code', { ...issuesBase, issues: issuesBase.issues.map((issue, i) => (i === 0 ? { ...issue, code: 'not_the_same_code' } : issue)) }],
    ['改 issue message', { ...issuesBase, issues: issuesBase.issues.map((issue, i) => (i === 0 ? { ...issue, message: 'edited' } : issue)) }],
  ]
  for (const [label, mutated] of tamperedIssues) {
    const audit = auditConverterMapping(issuesOutput, mutated)
    assert.equal(audit.ok, false, `审计没有发现「${label}」`)
  }
})

test('M15 同内容不同 bytes：块文本逐字相同、sha 不同（sha 是身份，文本是内容）', () => {
  const generated = setup()
  const original = contentFor('text_simple.pdf')
  const variant = mapped('text_variant_same_content.pdf').content
  assert.deepEqual(
    variant.blocks.map((block) => block.text),
    original.blocks.map((block) => block.text),
    '同内容变体的块文本必须逐字相同',
  )
  assert.notEqual(variant.asset_sha256, original.asset_sha256, 'bytes 不同 → sha 必须不同')
  assert.equal(variant.asset_sha256, sha256OfFile(fixturePath(generated, 'text_variant_same_content.pdf')))
  assert.equal(validateDocumentContent(variant).valid, true)
})

test('M16 映射是纯函数：不改入参、不读文件、两次调用深相等', () => {
  const output = converterOutput('text_simple.pdf')
  const snapshot = JSON.stringify(output)
  const first = mapConverterToDocumentContent(output, { elapsed_ms: 0 })
  const second = mapConverterToDocumentContent(output, { elapsed_ms: 0 })
  assert.equal(JSON.stringify(output), snapshot, '映射不得修改入参')
  assert.deepEqual(second, first)
})

test('M17 issue 动作台账是封闭的：每条 issue 的动作都在枚举内，soft 一律 none', () => {
  const issues: ConverterLikeIssue[] = [
    ...CONVERTER_HARD_ISSUE_CODES.map((code) => ({ code, message: 'probe' })),
    ...CONVERTER_SOFT_ISSUE_CODES.map((code) => ({ code, message: 'probe' })),
    ...CONVERTER_SOFT_ISSUE_PREFIXES.map((prefix) => ({ code: `${prefix}probe`, message: 'probe' })),
    { code: 'unknown_code_for_drift_test', message: 'probe' },
  ]
  const content = mapConverterToDocumentContent({
    text: '',
    blocks: [],
    completeness: 'partial',
    needs_visual: false,
    issues,
    meta: { source_sha256: 'd'.repeat(64), backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
  })
  const actions = new Set(['retry', 'switch_reader', 'vision_read', 'human_review', 'none'])
  for (const issue of content.issues) {
    assert.ok(actions.has(issue.suggested_action), `非法动作：${issue.suggested_action}`)
    if (issue.severity === 'SOFT') assert.equal(issue.suggested_action, 'none', `soft issue 不该要求动作：${issue.code}`)
    assert.equal(typeof issue.retryable, 'boolean')
  }
  const validation = validateDocumentContent(content)
  assert.equal(validation.valid, true, validation.violations.map((v) => v.code).join(', '))
})

test('M18 审计不越界：非 PDF 内容直接说「不适用」，不给假通过', () => {
  const output = converterOutput('text_simple.pdf')
  const pdfContent = contentFor('text_simple.pdf')
  const nonPdf: DocumentContent = { ...pdfContent, media_type: 'image/png' }
  const audit = auditConverterMapping(output, nonPdf)
  assert.equal(audit.ok, false)
  assert.match(audit.problems[0] ?? '', /only covers PDF mappings/)
})

test('M19 RTF 映射：locator_kind=rtf 时定位是 paragraph（可选 page），不伪造 bbox', () => {
  const sha = 'e'.repeat(64)
  const raw: ConverterLikeOutput = {
    text: 'SYNTHETIC RTF A\n\nSYNTHETIC RTF B',
    blocks: [
      {
        kind: 'paragraph',
        text: 'SYNTHETIC RTF A',
        location: { page: 1, paragraph: 0 },
        provenance: 'native_text',
      },
      {
        kind: 'paragraph',
        text: 'SYNTHETIC RTF B',
        // 有硬分页符的文件：读取器只给段落序号（不编页码、不编 bbox）。
        location: { paragraph: 1 },
        provenance: 'native_text',
      },
    ],
    completeness: 'partial',
    needs_visual: false,
    issues: [
      { code: 'unverified_rtf_pagination', message: '1 hard page break; per-page layout not reconstructed' },
    ],
    meta: { source_sha256: sha, backend: 'striprtf/0.0.35', reader_version: '1.0.0' },
  }
  const content = mapConverterToDocumentContent(raw, {
    media_type: MEDIA_RTF,
    locator_kind: 'rtf',
    asset_sha256: sha,
  })

  assert.equal(content.media_type, MEDIA_RTF)
  assert.equal(content.blocks.length, 2)
  const first = content.blocks[0]?.locator as { kind: string, paragraph?: number, page?: number }
  assert.deepEqual(first, { kind: 'rtf', paragraph: 0, page: 1 })
  const second = content.blocks[1]?.locator as { kind: string, paragraph?: number, page?: number }
  assert.deepEqual(second, { kind: 'rtf', paragraph: 1 }, '没有页声明时不许补 page')
  for (const block of content.blocks) {
    assert.equal((block.locator as { bbox?: unknown }).bbox, undefined, 'RTF 没有 bbox')
  }
  const validation = validateDocumentContent(content)
  assert.equal(validation.valid, true, validation.violations.map((v) => v.code).join(', '))

  // 不给 locator_kind 时仍是历史 PDF 行为（零回归）；RTF 内容用 pdf 定位会被校验器拒绝。
  const asPdfLocator = mapConverterToDocumentContent(raw, {
    media_type: MEDIA_RTF,
    asset_sha256: sha,
  })
  assert.equal(asPdfLocator.blocks[0]?.locator.kind, 'pdf')
  assert.equal(validateDocumentContent(asPdfLocator).valid, false)
  assert.ok(validateDocumentContent(asPdfLocator).violations.some((v) => v.code === 'LOCATOR_MEDIA_MISMATCH'))
})
