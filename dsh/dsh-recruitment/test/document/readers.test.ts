// U1 readers 的真实读取测试（node --test 直接跑 .ts，靠 Node 的类型擦除）。
//
// 样本来源（按 U0 README §5 收口后）：**U0 的合成 fixture 生成器**
// `test/document/fixtures/generate.py`（经 `./fixtures.ts` 的 ensureFixtures()）。
// 不在本文件里再维护第二套 PDF/DOCX/图片样本。
//
// U0 的样本集没有覆盖 U1 的失败矩阵，因此这里**派生**少量副本（全部仍在临时目录，
// 不含真实候选人资料）：
//   * corrupt.docx（截断 50% 的 docx_normal.docx）
//   * corrupt.png / corrupt.jpg（真魔数 + 垃圾体）
//   * legacy.doc（OLE 魔数）/ unknown.bin（无魔数）
//   * exif.jpg（image.jpg + EXIF orientation=6）
//   * empty.docx / textbox.docx（空文档 / 注入 w:txbxContent）
//   * disguised.docx.pdf / disguised.pdf.png / renamed.txt（扩展名伪装）
//
// 真实起两个子进程：converter 的 PDF CLI 与 python/document_readers.py。
// 断言的是真实输出（block 数 / locator / provenance / issues / SHA），不是 mock。
// 坏文件必须抛结构化错误，或至少 partial + HARD，绝不 complete。
// 同一文件两次结果一致（elapsed_ms 除外）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { runConverter } from '../../src/tools/converter.ts'
import {
  converterIssueSeverity,
  DocumentReadError,
  detectMagic,
  isDocumentReadError,
  ISSUE_IMAGE_REQUIRES_VISION,
  ISSUE_MEDIA_MISMATCH,
  mapPdfOutput,
  MEDIA_DOCX,
  MEDIA_JPEG,
  MEDIA_PDF,
  MEDIA_PNG,
  MEDIA_RTF,
  readDocument,
  readDocumentDetailed,
  resolveDocumentReaderConfig,
  sniffFile,
  type DocumentContent,
  type DocxLocator,
  type PdfLocator,
} from '../../src/document/readers/index.ts'
import { assess, readerFactsFromSourceMeta } from '../../src/document/quality/index.ts'
import {
  CONVERTER_DIR,
  ensureFixtures,
  fixtureEntry,
  fixturePath,
  sha256OfFile,
  type Fixtures,
} from './fixtures.ts'

/** 派生样本的 Python 脚本（只操作临时目录）。 */
const DERIVED_SCRIPT = String.raw`
import shutil
import sys
import zipfile
from pathlib import Path

from PIL import Image

src = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

# 1) corrupt DOCX: keep the first 50% of the bytes (central directory gone)
data = (src / "docx_normal.docx").read_bytes()
(out / "corrupt.docx").write_bytes(data[: int(len(data) * 0.5)])

# 2) corrupt images: real magic, broken body
(out / "corrupt.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 24)
(out / "corrupt.jpg").write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 24)

# 3) legacy OLE and unknown bytes
(out / "legacy.doc").write_bytes(
    bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b"\x00" * 64)
(out / "unknown.bin").write_bytes(bytes(range(32)))

# 4) EXIF orientation 6 derived from U0's image.jpg
image = Image.open(src / "image.jpg")
exif = Image.Exif()
exif[274] = 6
image.save(out / "exif.jpg", exif=exif)

# 5) genuinely empty DOCX
from docx import Document
Document().save(out / "empty.docx")

# 6) DOCX with a text box (python-docx does not expose it through Paragraph.text)
with zipfile.ZipFile(src / "docx_normal.docx") as zin:
    items = [(item, zin.read(item.filename)) for item in zin.infolist()]
index = next(i for i, (item, _) in enumerate(items) if item.filename == "word/document.xml")
item, xml = items[index]
text = xml.decode("utf-8").replace(
    "</w:body>",
    "<w:p><w:r><w:txbxContent><w:p><w:r><w:t>Textbox only sentence</w:t>"
    "</w:r></w:p></w:txbxContent></w:r></w:p></w:body>")
items[index] = (item, text.encode("utf-8"))
with zipfile.ZipFile(out / "textbox.docx", "w", zipfile.ZIP_DEFLATED) as zout:
    for item, payload in items:
        zout.writestr(item, payload)

# 7) extension disguises
shutil.copyfile(src / "docx_normal.docx", out / "disguised.docx.pdf")
shutil.copyfile(src / "text_simple.pdf", out / "disguised.pdf.png")
shutil.copyfile(src / "image.png", out / "renamed.txt")

print("derived-ok")
`

let fixtures: Fixtures | null = null
let derivedDir = ''
let setupError: Error | null = null
try {
  fixtures = ensureFixtures()
  derivedDir = join(fixtures.dir, 'derived')
  mkdirSync(derivedDir, { recursive: true })
  execFileSync(fixtures.python.bin, ['-c', DERIVED_SCRIPT, fixtures.dir, derivedDir], {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
} catch (error) {
  setupError = error instanceof Error ? error : new Error(String(error))
}

const SKIP: string | false = fixtures === null || setupError !== null
  ? `synthetic fixtures unavailable: ${setupError === null ? 'unknown' : setupError.message}`
  : false

/** converter/reader 配置要求 python_bin 是绝对路径；`python` 可能只是 PATH 上的名字。 */
function absolutePython(bin: string): string {
  if (isAbsolute(bin)) return bin
  const resolved = execFileSync(bin, ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  }).trim()
  return resolved === '' ? bin : resolved
}

const PYTHON_BIN = fixtures === null ? '' : absolutePython(fixtures.python.bin)
const CONFIG_RESOLUTION = fixtures === null || PYTHON_BIN === ''
  ? null
  : resolveDocumentReaderConfig({
    python_bin: PYTHON_BIN,
    converter_dir: CONVERTER_DIR,
    allowed_roots: [fixtures.dir],
    timeout_ms: 60_000,
  })
const CONFIG = CONFIG_RESOLUTION?.resolved ?? null
const SKIP_REASON: string | false = SKIP !== false
  ? SKIP
  : CONFIG === null
    ? `reader config is invalid: ${(CONFIG_RESOLUTION?.issues ?? []).join('; ')}`
    : false

test.after(() => {
  if (fixtures !== null) rmSync(fixtures.dir, { recursive: true, force: true })
})

function requireConfig(): NonNullable<typeof CONFIG> {
  if (CONFIG === null) throw new Error('reader config was not resolved')
  return CONFIG
}

function fixture(name: string): string {
  if (fixtures === null) throw new Error('fixtures are not available')
  return fixturePath(fixtures, name)
}

function derived(name: string): string {
  return join(derivedDir, name)
}

function stripElapsed(content: DocumentContent): Record<string, unknown> {
  return { ...content, elapsed_ms: 0 }
}

test('S1 魔数嗅探是纯字节判断（不依赖扩展名）', () => {
  assert.equal(detectMagic(Buffer.from('%PDF-1.7\n', 'ascii')), 'pdf')
  assert.equal(detectMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png')
  assert.equal(detectMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg')
  assert.equal(detectMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip')
  assert.equal(detectMagic(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'ole')
  assert.equal(detectMagic(Buffer.from('not a document', 'ascii')), null)
})

test('S2 嗅探 U0 的四种真实样本，扩展名与内容一致', { skip: SKIP_REASON }, async () => {
  const cases: Array<[string, string]> = [
    ['text_simple.pdf', MEDIA_PDF],
    ['docx_normal.docx', MEDIA_DOCX],
    ['image.png', MEDIA_PNG],
    ['image.jpg', MEDIA_JPEG],
  ]
  for (const [name, media] of cases) {
    const sniff = await sniffFile(fixture(name))
    assert.equal(sniff.media, media, `${name} 应嗅探为 ${media}`)
    assert.equal(sniff.matches_extension, true, `${name} 的扩展名应与内容一致`)
    assert.equal(fixtureEntry(fixtures as Fixtures, name).media_type, media)
  }
})

test('S3 PDF 回归：统一读取与 converter 直出逐块一致', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  const pdf = fixture('text_simple.pdf')
  const content = await readDocument(pdf, cfg)
  const raw = await runConverter(cfg, pdf)

  const rawBlocks = raw.blocks ?? []
  assert.ok(rawBlocks.length > 0, 'U0 的文字 PDF 必须有原生文字块')
  assert.equal(content.blocks.length, rawBlocks.length, 'block 数必须与 converter 直出一致')
  assert.equal(content.completeness, raw.completeness)
  assert.deepEqual(
    content.issues.map((issue) => issue.code),
    (raw.issues ?? []).map((issue) => issue.code),
  )
  assert.equal(content.asset_sha256, sha256OfFile(pdf))

  for (let index = 0; index < rawBlocks.length; index += 1) {
    const mapped = content.blocks[index]
    const original = rawBlocks[index]
    const locator = mapped.locator as PdfLocator
    assert.equal(mapped.text, original.text, `block ${index} 文本必须逐字一致`)
    assert.equal(mapped.order, index)
    assert.equal(locator.kind, 'pdf')
    assert.equal(locator.page, original.location?.page)
    assert.deepEqual(locator.bbox, original.location?.bbox)
    assert.equal(locator.block_id, String(index), 'U0 契约：block_id 原样保留读取器块号')
    assert.equal(mapped.provenance, original.provenance ?? 'native_text')
  }
})

test('S4 PDF 的 reader 身份 / SHA / source_meta 不丢', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  const pdf = fixture('text_simple.pdf')
  const outcome = await readDocumentDetailed(pdf, cfg)
  const { content } = outcome
  const raw = await runConverter(cfg, pdf)

  assert.equal(content.media_type, MEDIA_PDF)
  assert.equal(content.reader_id, raw.meta?.backend, 'reader_id 必须能追溯到实际读取器')
  assert.equal(content.reader_version, raw.meta?.reader_version)
  assert.ok(Number.isFinite(content.elapsed_ms) && content.elapsed_ms >= 0)
  assert.match(content.asset_sha256, /^[0-9a-f]{64}$/)
  assert.equal((content.blocks[0].locator as PdfLocator).kind, 'pdf')

  const converterMeta = outcome.source_meta.converter_meta as Record<string, unknown>
  assert.equal(converterMeta.pages, raw.meta?.pages, 'meta.pages 必须保留在 source_meta')
  assert.equal(converterMeta.source_sha256, content.asset_sha256)
  assert.equal(typeof converterMeta.order_verified, 'boolean')
  const extras = outcome.source_meta.converter_extras as Record<string, unknown>
  assert.ok(extras.fields !== undefined, 'converter 的 fields 必须保留在 source_meta')
  assert.ok(Array.isArray(extras.links))
})

test('S5 DOCX 段落 / 顺序 / locator / hyperlink', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  const fx = fixtures as Fixtures
  const name = 'docx_normal.docx'
  const expected = fixtureEntry(fx, name).expected
  const paragraphs = expected.paragraphs as readonly string[]

  const outcome = await readDocumentDetailed(fixture(name), cfg)
  const { content } = outcome
  assert.equal(content.media_type, MEDIA_DOCX)
  assert.equal(content.completeness, 'complete')
  assert.equal(content.needs_visual, false)
  assert.equal(content.blocks.length, paragraphs.length, '每个非空段落一个 block')
  assert.equal(content.blocks[0].kind, 'heading')
  assert.equal(content.blocks[0].text, paragraphs[0])

  content.blocks.forEach((block, index) => {
    const locator = block.locator as DocxLocator
    assert.equal(block.order, index)
    assert.equal(block.provenance, 'native_text')
    assert.equal(locator.kind, 'docx')
    assert.equal(locator.part, 'word/document.xml')
    assert.equal(locator.paragraph_id, `p${index}`)
  })
  assert.equal(outcome.source_meta.paragraphs, paragraphs.length)
})

test('S6 DOCX 表格按行列展开 + 超链接保留', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  const fx = fixtures as Fixtures
  const expected = fixtureEntry(fx, 'docx_table.docx').expected
  const cells = expected.table_cell_texts as readonly string[]
  const rows = expected.table_rows as number
  const cols = expected.table_cols as number

  const outcome = await readDocumentDetailed(fixture('docx_table.docx'), cfg)
  const { content } = outcome
  const tableBlocks = content.blocks.filter((block) => block.kind === 'table')
  assert.equal(tableBlocks.length, rows * cols, '表格必须按行列展开成 block')
  assert.deepEqual(tableBlocks.map((block) => block.text), cells)

  const grid = tableBlocks.map((block) => {
    const locator = block.locator as DocxLocator
    return [locator.row, locator.cell]
  })
  const expectedGrid: Array<[number, number]> = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) expectedGrid.push([row, column])
  }
  assert.deepEqual(grid, expectedGrid)
  for (const block of tableBlocks) {
    const locator = block.locator as DocxLocator
    assert.equal(locator.part, 'word/document.xml')
    assert.equal(typeof locator.table_id, 'string')
  }
  assert.equal(outcome.source_meta.tables, 1)

  const linked = content.blocks.find((block) => (block.links ?? []).length > 0)
  assert.ok(linked !== undefined, 'DOCX 超链接不能丢')
  assert.equal(linked.links?.[0].href, expected.hyperlink_url)
  assert.equal(linked.links?.[0].text, expected.hyperlink_text)
  assert.equal((linked.links?.[0].locator as DocxLocator).kind, 'docx')
})

// 2026-11-14 改判：Word 里用文本框排版简历是常态（实测 中文简历-新.docx 的正文全在 28 个文本框里），
// 旧实现把文字收集起来又扔掉、只报一句"读不了"，等于把正常简历判成没内容。
// 新口径：文本框文字**读进 blocks**（结构化只需要文字），顺序不可知降级为 SOFT。
test('S7 DOCX 文本框：文字必须读出来，顺序不可知记 SOFT（D-97 第一批）', { skip: SKIP_REASON }, async () => {
  const content = await readDocument(derived('textbox.docx'), requireConfig())
  assert.equal(
    content.blocks.some((block) => block.text.includes('Textbox only sentence')),
    true,
    '文本框里的文字必须进 blocks —— 不许再"收集后扔掉"',
  )
  const order = content.issues.find((item) => item.code === 'doc_docx_textbox_order_unknown')
  assert.ok(order !== undefined, '必须报告 doc_docx_textbox_order_unknown')
  assert.equal(order.severity, 'SOFT', '顺序未知只影响可信筛选，不阻断结构化')
  assert.equal(
    content.issues.some((item) => item.code === 'docx_textbox_unread' && item.severity === 'HARD'),
    false,
    '文字读出来了就不许再报 HARD 的"文本框读不了"',
  )
})

test('S8 空 DOCX 不得冒充 complete', { skip: SKIP_REASON }, async () => {
  const content = await readDocument(derived('empty.docx'), requireConfig())
  assert.equal(content.blocks.length, 0)
  assert.equal(content.completeness, 'partial')
  assert.ok(content.issues.some((issue) => issue.code === 'docx_no_text' && issue.severity === 'HARD'))
})

test('S9 PNG：一个 image block + needs_visual + HARD image_requires_vision', { skip: SKIP_REASON }, async () => {
  const content = await readDocument(fixture('image.png'), requireConfig())
  const expected = fixtureEntry(fixtures as Fixtures, 'image.png').expected
  assert.equal(content.media_type, MEDIA_PNG)
  assert.equal(content.text, '', '图片不得产生任何推断文本')
  assert.equal(content.blocks.length, 1)
  assert.equal(content.blocks[0].kind, 'other')
  assert.equal(content.blocks[0].text, '')
  assert.deepEqual(content.blocks[0].locator, { kind: 'image', frame: 0 })
  assert.equal(content.needs_visual, true)
  assert.equal(content.completeness, 'partial')
  const issue = content.issues.find((item) => item.code === ISSUE_IMAGE_REQUIRES_VISION)
  assert.ok(issue !== undefined)
  assert.equal(issue.severity, 'HARD')
  assert.equal(issue.retryable, true)
  assert.equal(issue.suggested_action, 'vision_read')

  const outcome = await readDocumentDetailed(fixture('image.png'), requireConfig())
  assert.equal(outcome.source_meta.width, expected.width)
  assert.equal(outcome.source_meta.height, expected.height)
})

test('S10 JPEG：尺寸进 source_meta，文字仍不伪造', { skip: SKIP_REASON }, async () => {
  const content = await readDocument(fixture('image.jpg'), requireConfig())
  const expected = fixtureEntry(fixtures as Fixtures, 'image.jpg').expected
  const outcome = await readDocumentDetailed(fixture('image.jpg'), requireConfig())
  assert.equal(content.media_type, MEDIA_JPEG)
  assert.equal(content.text, '')
  assert.equal(content.needs_visual, true)
  assert.equal(outcome.source_meta.format, 'JPEG')
  assert.equal(outcome.source_meta.width, expected.width)
  assert.equal(outcome.source_meta.height, expected.height)
})

test('S11 JPEG EXIF orientation=6 必须进入 source_meta 并交换显示宽高', { skip: SKIP_REASON }, async () => {
  const outcome = await readDocumentDetailed(derived('exif.jpg'), requireConfig())
  assert.equal(outcome.content.media_type, MEDIA_JPEG)
  assert.equal(outcome.source_meta.exif_orientation, 6)
  assert.equal(outcome.source_meta.width, 800)
  assert.equal(outcome.source_meta.height, 1000)
  assert.equal(outcome.source_meta.display_width, 1000)
  assert.equal(outcome.source_meta.display_height, 800)
  assert.equal(outcome.content.text, '')
  assert.equal(outcome.content.completeness, 'partial')
})

test('S12 损坏 DOCX 抛结构化错误（fail-closed）', { skip: SKIP_REASON }, async () => {
  await assert.rejects(readDocument(derived('corrupt.docx'), requireConfig()), (error: unknown) => {
    assert.ok(isDocumentReadError(error), `必须是 DocumentReadError，实际 ${String(error)}`)
    assert.ok(['DOCX_UNREADABLE', 'UNSUPPORTED_MEDIA'].includes(error.code), `意外的 code ${error.code}`)
    return true
  })
})

test('S13 损坏 PNG/JPG 抛 IMAGE_UNREADABLE', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  for (const name of ['corrupt.png', 'corrupt.jpg']) {
    await assert.rejects(readDocument(derived(name), cfg), (error: unknown) => {
      assert.ok(isDocumentReadError(error))
      assert.equal(error.code, 'IMAGE_UNREADABLE', `${name} 必须是 IMAGE_UNREADABLE`)
      return true
    })
  }
})

test('S14 截断 PDF：抛结构化错误或 partial + HARD，绝不 complete', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  try {
    const content = await readDocument(fixture('corrupted_truncated.pdf'), cfg)
    assert.notEqual(content.completeness, 'complete', '截断 PDF 不得 complete')
    assert.ok(
      content.issues.some((issue) => issue.severity === 'HARD'),
      '截断 PDF 必须有 HARD issue',
    )
  } catch (error) {
    assert.ok(isDocumentReadError(error))
    assert.ok(['READER_FAILED', 'TIMEOUT'].includes(error.code), `意外的 code ${String(error)}`)
  }
})

test('S15 伪装成 .pdf 的非 PDF（PK 头）→ UNSUPPORTED_MEDIA，不猜', { skip: SKIP_REASON }, async () => {
  await assert.rejects(
    readDocument(fixture('masquerade_not_a_pdf.pdf'), requireConfig()),
    (error: unknown) => {
      assert.ok(isDocumentReadError(error))
      assert.equal(error.code, 'UNSUPPORTED_MEDIA')
      return true
    },
  )
})

test('S16 空文件 / 未知字节 / 旧 OLE 都 fail-closed', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  await assert.rejects(readDocument(fixture('zero_byte.pdf'), cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'EMPTY_FILE')
    return true
  })
  await assert.rejects(readDocument(derived('unknown.bin'), cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'UNSUPPORTED_MEDIA')
    return true
  })
  await assert.rejects(readDocument(derived('legacy.doc'), cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'UNSUPPORTED_MEDIA')
    assert.match(error.message, /OLE/i)
    return true
  })
})

test('S17 扩展名伪装：按真实内容读 + MEDIA_MISMATCH HARD', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()

  const docxAsPdf = await readDocument(derived('disguised.docx.pdf'), cfg)
  assert.equal(docxAsPdf.media_type, MEDIA_DOCX, '必须按内容当 DOCX 读')
  assert.ok(docxAsPdf.blocks.length > 0)
  const mismatch = docxAsPdf.issues.find((issue) => issue.code === ISSUE_MEDIA_MISMATCH)
  assert.ok(mismatch !== undefined)
  assert.equal(mismatch.severity, 'HARD')
  assert.equal(docxAsPdf.completeness, 'partial', 'HARD mismatch 不能是 complete')

  const pdfAsPng = await readDocument(derived('disguised.pdf.png'), cfg)
  assert.equal(pdfAsPng.media_type, MEDIA_PDF)
  assert.ok(pdfAsPng.issues.some((issue) => issue.code === ISSUE_MEDIA_MISMATCH))

  const pngAsTxt = await readDocument(derived('renamed.txt'), cfg)
  assert.equal(pngAsTxt.media_type, MEDIA_PNG)
  assert.ok(pngAsTxt.issues.some((issue) => issue.code === ISSUE_MEDIA_MISMATCH))
})

test('S18 同一文件两次读取一致（elapsed_ms 除外）', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  for (const path of [fixture('text_simple.pdf'), fixture('docx_normal.docx'), fixture('image.png')]) {
    const first = await readDocument(path, cfg)
    const second = await readDocument(path, cfg)
    assert.deepEqual(stripElapsed(first), stripElapsed(second), `${path} 两次结果必须一致`)
  }
})

test('S19 路径 fail-closed：相对路径 / 越界 / 不存在 / 目录', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  await assert.rejects(readDocument('text_simple.pdf', cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'INVALID_ARGS')
    return true
  })
  await assert.rejects(readDocument(join(fixtures?.dir ?? '', 'nope.pdf'), cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'NOT_FOUND')
    return true
  })
  await assert.rejects(readDocument((fixtures as Fixtures).dir, cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'INVALID_ARGS')
    return true
  })

  const outside = mkdtempSync(join(tmpdir(), 'u1-outside-'))
  try {
    const copied = join(outside, 'text_simple.pdf')
    copyFileSync(fixture('text_simple.pdf'), copied)
    await assert.rejects(readDocument(copied, cfg), (error: unknown) => {
      assert.ok(isDocumentReadError(error))
      assert.equal(error.code, 'FORBIDDEN')
      return true
    })
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('S20 四类真实输出都满足 canonical 契约不变量', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  for (const name of ['text_simple.pdf', 'docx_normal.docx', 'image.png', 'image.jpg']) {
    const content = await readDocument(fixture(name), cfg)
    assert.match(content.asset_sha256, /^[0-9a-f]{64}$/)
    assert.equal(new Set(content.blocks.map((block) => block.block_id)).size, content.blocks.length)
    content.blocks.forEach((block, index) => {
      assert.equal(block.order, index)
      assert.equal(typeof block.locator.kind, 'string')
    })
    for (const issue of content.issues) {
      assert.ok(issue.severity === 'HARD' || issue.severity === 'SOFT')
      assert.ok(['retry', 'switch_reader', 'vision_read', 'human_review', 'none'].includes(issue.suggested_action))
      assert.equal(typeof issue.retryable, 'boolean')
    }
    assert.equal('meta' in (content as unknown as Record<string, unknown>), false, 'canonical content 不带 meta')
  }
})

test('S21 纯映射红线：未知 code 按 HARD；fatal 抛错；SHA 不一致抛错', () => {
  const sha = 'a'.repeat(64)
  const base = {
    text: 'x',
    blocks: [{
      kind: 'paragraph',
      text: 'x',
      location: { page: 1, bbox: [0, 0, 1, 1] },
      provenance: 'native_text',
      links: [],
    }],
    completeness: 'complete',
    issues: [],
    needs_visual: false,
    meta: { source_sha256: sha, backend: 'pymupdf/x', reader_version: '1.0.0' },
  }
  assert.equal(mapPdfOutput(base, sha, 1).completeness, 'complete')
  assert.equal(converterIssueSeverity('a_brand_new_code'), 'HARD')
  assert.equal(converterIssueSeverity('pdf_page_empty'), 'SOFT')

  assert.throws(
    () => mapPdfOutput({ ...base, issues: [{ code: 'reader_failed', message: 'boom' }] }, sha, 1),
    (error: unknown) => error instanceof DocumentReadError && error.code === 'READER_FAILED',
  )
  assert.throws(
    () => mapPdfOutput(base, 'b'.repeat(64), 1),
    (error: unknown) => error instanceof DocumentReadError && error.code === 'SOURCE_CHANGED_DURING_READ',
  )
})

// ---------------------------------------------------------------------------
// RTF（2026-11-14 新增的第五种媒体）：按内容嗅探 + canonical 映射 + 不伪造版面
// ---------------------------------------------------------------------------

/** 写一份合成 RTF（全假资料，R7）并返回路径。 */
function writeRtf(name: string, rtf: string): string {
  const path = derived(name)
  writeFileSync(path, rtf, 'utf8')
  return path
}

/** 一份单页合成 RTF：段落、tab 表格行、假 phone/email。 */
function sampleRtf(): string {
  return [
    '{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0\\fnil Arial;}}\\f0',
    '\\pard SYNTHETIC SAMPLE - NOT A REAL RESUME\\par',
    '\\pard Phone: 138 0000 0000   Email: demo.candidate@example.invalid\\par',
    '\\pard Work experience\\par',
    '\\pard 2021.07 - 2024.06\\tab Example Technology Ltd\\tab Backend Engineer\\par',
    '\\pard Education\\par',
    '\\pard 2015.09 - 2019.06\\tab Example University\\tab Computer Science\\par}',
  ].join('')
}

test('S22 RTF：嗅探只看字节——扩展名 .rtf 与内容一致；改名 .pdf 仍按 RTF 读', { skip: SKIP_REASON }, async () => {
  const rtf = writeRtf('synthetic-resume.rtf', sampleRtf())
  const sniff = await sniffFile(rtf)
  assert.equal(sniff.format, 'rtf')
  assert.equal(sniff.media, MEDIA_RTF)
  assert.equal(sniff.matches_extension, true)

  // 扩展名不改内容：改成 .pdf 后仍然嗅探为 RTF，只是 matches_extension=false。
  const renamed = derived('actually-rtf.pdf')
  copyFileSync(rtf, renamed)
  const renamedSniff = await sniffFile(renamed)
  assert.equal(renamedSniff.format, 'rtf', '扩展名不参与选 reader')
  assert.equal(renamedSniff.matches_extension, false)
})

test('S23 RTF：canonical content 用 rtf 定位（paragraph），不伪造 bbox / 页码', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  const rtf = writeRtf('canonical.rtf', sampleRtf())
  const outcome = await readDocumentDetailed(rtf, cfg)
  const content = outcome.content

  assert.equal(content.media_type, MEDIA_RTF)
  assert.equal(content.reader_id.startsWith('striprtf/'), true, `reader_id=${content.reader_id}`)
  assert.ok(content.blocks.length >= 5)
  content.blocks.forEach((block, index) => {
    assert.equal(block.order, index)
    assert.equal(block.locator.kind, 'rtf')
    const locator = block.locator as { kind: 'rtf', paragraph?: number, page?: number, bbox?: unknown }
    assert.equal(locator.paragraph, index, '段落序号 = 读取器块流顺序')
    assert.equal(locator.page, 1, '单页 RTF 的第 1 页是格式等价事实')
    assert.equal('bbox' in locator, false, 'RTF 没有 bbox，不许伪造')
    assert.equal(block.provenance, 'native_text', 'RTF 文本是原生文本（不是 OCR/模型）')
  })
  const joined = content.blocks.map((block) => block.text).join('\n')
  assert.ok(joined.includes('demo.candidate@example.invalid'))
  // source_meta 旁路：converter 的 rtf 统计/字段证据不能丢。
  const meta = outcome.source_meta.converter_meta as Record<string, unknown>
  const rtfStats = meta.rtf as Record<string, unknown>
  assert.equal(rtfStats.page_breaks, 0)
  assert.equal(rtfStats.table_rows, 0, '样本没有 \\trowd（tab 分隔行不是 RTF 表格）')
  assert.ok(outcome.source_meta.converter_extras !== undefined)
})

test('S24 RTF：有硬分页符时不编页码，另发 SOFT 声明（不挂 page 定位）', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  const rtf = writeRtf('two-pages.rtf',
    '{\\rtf1\\ansi Page one line\\par\\page Page two line\\par}')
  const outcome = await readDocumentDetailed(rtf, cfg)
  for (const block of outcome.content.blocks) {
    assert.equal(block.locator.kind, 'rtf')
    assert.equal((block.locator as { page?: number }).page, undefined, '逐页归属未重建时不挂 page')
    assert.equal(typeof (block.locator as { paragraph?: number }).paragraph, 'number')
  }
  const meta = outcome.source_meta.converter_meta as Record<string, unknown>
  assert.equal((meta.rtf as Record<string, unknown>).page_breaks, 1)
  assert.ok(outcome.content.issues.some((issue) => issue.code === 'unverified_rtf_pagination'))
})

test('S25 RTF：内嵌图片不读但必须声明，文字仍然可用；质量层把"图片未核"升级为 HARD', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  const rtf = writeRtf('with-image.rtf',
    '{\\rtf1\\ansi Text before image\\par'
    + '{\\pict\\pngblip\\picw1\\pich1 89504e470d0a1a0a}\\par Text after image\\par}')
  const outcome = await readDocumentDetailed(rtf, cfg)
  const content = outcome.content
  const imageIssue = content.issues.find((issue) => issue.code === 'unverified_rtf_embedded_image')
  assert.ok(imageIssue !== undefined, '未核图片必须声明，不能静默丢弃')
  // canonical 层：与 converter 的 issues.py 一致（unverified_* → SOFT，映射不改级）。
  assert.equal(imageIssue.severity, 'SOFT', '映射层不改转换器的严重度')
  // 质量层：未核图片 = 版式类阻断（与 unverified_pdf_image 同口径：未登记 → HARD）。
  const assessment = assess(content, readerFactsFromSourceMeta(outcome.source_meta))
  assert.equal(assessment.blocking, true)
  assert.ok(assessment.blocking_codes.includes('unverified_rtf_embedded_image'),
    `blocking_codes=${assessment.blocking_codes.join(',')}`)
  assert.equal(assessment.layout_only_blocking, true, '图片未核属于"仅版式阻断"（文字本身可用）')
  assert.ok(content.issues.some((issue) => issue.code === 'unverified_rtf_embedded_image'))
  assert.notEqual(content.completeness, 'complete')
  const joined = content.blocks.map((block) => block.text).join('\n')
  assert.ok(joined.includes('Text before image'))
  assert.ok(joined.includes('Text after image'))
  assert.equal(joined.includes('89504e47'), false, '图片字节不得混进正文')
})

test('S26 RTF 空正文：不冒充 complete（0 块 + HARD rtf_no_text）', { skip: SKIP_REASON }, async () => {
  const cfg = requireConfig()
  const rtf = writeRtf('empty.rtf', '{\\rtf1\\ansi \\par \\par}')
  const content = await readDocument(rtf, cfg)
  assert.equal(content.blocks.length, 0)
  assert.notEqual(content.completeness, 'complete')
  assert.ok(content.issues.some((issue) => issue.code === 'rtf_no_text' && issue.severity === 'HARD'))
})
