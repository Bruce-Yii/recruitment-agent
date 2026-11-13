// U1 readers 的真实读取测试（node --test 直接跑 .ts，靠 Node 的类型擦除）。
//
// 这里**真的**起两个子进程：
//   1. converter 的 PDF CLI（`python -m src.cli <pdf> --no-isolation`）；
//   2. python/document_readers.py（python-docx / Pillow）。
//
// 样本全部是**合成**的（fixture 生成器在本文件内，不提交、不含真实候选人资料）：
// 文字 PDF、带超链接 DOCX、带表格 DOCX、带文本框 DOCX、空 DOCX、PNG、JPEG(EXIF 6)、
// 截断 PDF/DOCX/PNG/JPG、空文件、未知字节、旧 OLE、扩展名伪装。
//
// U0 的合成 fixture 生成器（test/document/fixtures*）在写这一版时**还没有落地**
// （2026-11-13 实测：test/document 目录不存在）。本文件的生成器是临时替代：
// U0 落地后应改为 import U0 的 fixture，而不是长期并存两套样本。
//
// 设计原则：
//   * 断言的是**真实输出**（block 数、locator、provenance、issues、SHA），不是 mock；
//   * 坏文件必须抛结构化错误，或至少 partial + HARD，绝不 complete；
//   * 同一文件两次结果一致（elapsed_ms 除外）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runConverter } from '../../src/tools/converter.ts'
import {
  converterIssueSeverity,
  detectMagic,
  DocumentReadError,
  isDocumentReadError,
  ISSUE_IMAGE_REQUIRES_VISION,
  ISSUE_MEDIA_MISMATCH,
  mapPdfOutput,
  MEDIA_DOCX,
  MEDIA_JPEG,
  MEDIA_PDF,
  MEDIA_PNG,
  readDocument,
  resolveDocumentReaderConfig,
  sniffFile,
  type DocumentContent,
  type DocxLocator,
  type PdfLocator,
} from '../../src/document/readers/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..', '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
const CONVERTER_DIR = join(REPO_ROOT, 'converter')

const PYTHON = process.env.RECRUITMENT_PYTHON ?? 'D:\\Python3.12.9\\python.exe'
const CAN_RUN = existsSync(PYTHON) && existsSync(join(CONVERTER_DIR, 'src', 'cli.py'))

const FIXTURE_SCRIPT = String.raw`
import shutil
import sys
from pathlib import Path

import fitz
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from PIL import Image

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

# 1) text PDF, one real URI annotation
pdf = out / "text.pdf"
doc = fitz.open()
page = doc.new_page()
page.insert_text((72, 90), "SYNTHETIC SAMPLE - NOT A REAL RESUME", fontsize=9)
page.insert_text((72, 120), "Candidate Example A", fontsize=18)
page.insert_text((72, 150), "Phone: 138-0000-0000", fontsize=11)
page.insert_text((72, 172), "Email: demo.candidate@example.invalid", fontsize=11)
page.insert_text((72, 205), "Experience", fontsize=14)
page.insert_text((72, 232), "2021.07 - 2024.06 Example Technology Ltd Backend Engineer", fontsize=11)
page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(72, 245, 420, 262),
                  "uri": "https://example.com/profile"})
page.insert_text((72, 260), "Profile: https://example.com/profile", fontsize=11)
doc.save(pdf)
doc.close()

# 2) basic DOCX: heading + paragraph + hyperlink
docx_basic = out / "docx_basic.docx"
d = Document()
d.add_heading("Synthetic Candidate", level=1)
d.add_paragraph("Experience at Example Technology Ltd (2021-2024).")
profile = d.add_paragraph("Profile: ")
rid = d.part.relate_to(
    "https://example.com/profile",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
    is_external=True)
hl = OxmlElement("w:hyperlink")
hl.set(qn("r:id"), rid)
run = OxmlElement("w:r")
text = OxmlElement("w:t")
text.text = "Example Link"
run.append(text)
hl.append(run)
profile._p.append(hl)
d.add_paragraph("Education: Example University")
d.save(docx_basic)

# 3) DOCX with a 2x2 table after a paragraph
docx_table = out / "docx_table.docx"
d = Document()
d.add_paragraph("Synthetic table document")
table = d.add_table(rows=2, cols=2)
for ri in range(2):
    for ci in range(2):
        table.cell(ri, ci).text = "R%dC%d" % (ri, ci)
d.add_paragraph("After table paragraph")
d.save(docx_table)

# 4) DOCX with a text box (python-docx does not expose it as paragraph text)
docx_textbox = out / "docx_textbox.docx"
d = Document()
d.add_paragraph("Body paragraph")
tb = OxmlElement("w:txbxContent")
tp = OxmlElement("w:p")
tr = OxmlElement("w:r")
tt = OxmlElement("w:t")
tt.text = "Textbox only sentence"
tr.append(tt)
tp.append(tr)
tb.append(tp)
wrapper = OxmlElement("w:r")
wrapper.append(tb)
d.paragraphs[0]._p.append(wrapper)
d.save(docx_textbox)

# 5) genuinely empty DOCX
Document().save(out / "empty.docx")

# 6) PNG and JPEG with EXIF orientation 6
Image.new("RGB", (120, 80), (200, 30, 30)).save(out / "sample.png")
img = Image.new("RGB", (100, 60), (30, 120, 200))
exif = Image.Exif()
exif[274] = 6
img.save(out / "sample.jpg", exif=exif)

# 7) corrupt containers (magic stays, body is broken)
shutil.copyfile(docx_basic, out / "corrupt.docx")
data = (out / "corrupt.docx").read_bytes()
(out / "corrupt.docx").write_bytes(data[: int(len(data) * 0.5)])
(out / "corrupt.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 24)
(out / "corrupt.jpg").write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 24)
pdf_data = pdf.read_bytes()
corrupt_pdf = out / "corrupt.pdf"
corrupt_pdf.write_bytes(pdf_data[: int(len(pdf_data) * 0.5)])

# 8) empty / unknown / legacy OLE / disguised extensions
(out / "empty.bin").write_bytes(b"")
(out / "unknown.bin").write_bytes(bytes(range(32)))
(out / "legacy.doc").write_bytes(
    bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b"\x00" * 64)
shutil.copyfile(docx_basic, out / "disguised.docx.pdf")
shutil.copyfile(pdf, out / "disguised.pdf.png")
shutil.copyfile(out / "sample.png", out / "renamed.txt")

print("fixtures-ok")
`

let fixtureRoot = ''
let fixtureError: Error | null = null
if (CAN_RUN) {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'u1-readers-'))
  try {
    execFileSync(PYTHON, ['-c', FIXTURE_SCRIPT, fixtureRoot], {
      encoding: 'utf8',
      timeout: 180_000,
      windowsHide: true,
    })
  } catch (error) {
    fixtureError = error instanceof Error ? error : new Error(String(error))
  }
}

const SKIP: string | false = !CAN_RUN
  ? `python or converter/ not available (${PYTHON})`
  : fixtureError !== null
    ? `synthetic fixtures could not be built: ${fixtureError.message}`
    : false

const RESOLVED = CAN_RUN
  ? resolveDocumentReaderConfig({
    python_bin: PYTHON,
    converter_dir: CONVERTER_DIR,
    allowed_roots: [fixtureRoot],
    timeout_ms: 60_000,
  }).resolved
  : null

test.after(() => {
  if (fixtureRoot !== '') rmSync(fixtureRoot, { recursive: true, force: true })
})

function requireConfig(): NonNullable<typeof RESOLVED> {
  if (RESOLVED === null) throw new Error('reader config was not resolved')
  return RESOLVED
}

function fixture(name: string): string {
  return join(fixtureRoot, name)
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

test('S2 嗅探四种真实文件，扩展名一致', { skip: SKIP }, async () => {
  const cases: Array<[string, string]> = [
    ['text.pdf', MEDIA_PDF],
    ['docx_basic.docx', MEDIA_DOCX],
    ['sample.png', MEDIA_PNG],
    ['sample.jpg', MEDIA_JPEG],
  ]
  for (const [name, media] of cases) {
    const sniff = await sniffFile(fixture(name))
    assert.equal(sniff.media, media, `${name} 应嗅探为 ${media}`)
    assert.equal(sniff.matches_extension, true, `${name} 的扩展名应与内容一致`)
  }
})

test('S3 PDF 回归：统一读取的 block 数与 converter 直出一致', { skip: SKIP }, async () => {
  const cfg = requireConfig()
  const pdf = fixture('text.pdf')
  const content = await readDocument(pdf, cfg)
  const raw = await runConverter(cfg, pdf)

  const rawBlocks = raw.blocks ?? []
  assert.ok(rawBlocks.length > 0, '合成 PDF 必须有原生文字块')
  assert.equal(content.blocks.length, rawBlocks.length, 'block 数必须与 converter 直出一致')
  assert.equal(content.meta?.pages, raw.meta?.pages, 'pages 不能丢')
  assert.equal(content.completeness, raw.completeness, 'completeness 不能被改写')
  assert.deepEqual(
    content.issues.map((issue) => issue.code),
    (raw.issues ?? []).map((issue) => issue.code),
    'issue code 序列不能丢/不能改',
  )

  for (let index = 0; index < rawBlocks.length; index += 1) {
    const mapped = content.blocks[index]
    const original = rawBlocks[index]
    const locator = mapped.locator as PdfLocator
    assert.equal(mapped.text, original.text, `block ${index} 文本必须一致`)
    assert.equal(locator.kind, 'pdf')
    assert.equal(locator.page, original.location?.page, `block ${index} 页码必须一致`)
    assert.deepEqual(locator.bbox, original.location?.bbox, `block ${index} bbox 必须一致`)
    assert.equal(locator.block_id, mapped.block_id)
  }
})

test('S4 PDF 映射保留 links / provenance / meta / reader 身份', { skip: SKIP }, async () => {
  const cfg = requireConfig()
  const content = await readDocument(fixture('text.pdf'), cfg)
  assert.equal(content.media_type, MEDIA_PDF)
  assert.equal(content.reader_id, 'converter-pymupdf-cli')
  assert.match(content.reader_version, /pymupdf/)
  assert.ok(Number.isFinite(content.elapsed_ms) && content.elapsed_ms >= 0)
  assert.match(content.asset_sha256, /^[0-9a-f]{64}$/)

  const raw = await runConverter(cfg, fixture('text.pdf'))
  assert.equal(content.asset_sha256, raw.meta?.source_sha256, 'asset_sha256 必须等于 converter 记录的 SHA')

  assert.equal(content.blocks[0].provenance, 'native_text')
  const withLinks = content.blocks.filter((block) => (block.links ?? []).length > 0)
  assert.equal(withLinks.length, 1, '合成 PDF 里有一个带 URI 的 block')
  assert.equal(withLinks[0].links?.[0].href, 'https://example.com/profile')
  assert.equal((withLinks[0].links?.[0].locator as PdfLocator).kind, 'pdf')

  const converterMeta = content.meta?.converter as Record<string, unknown> | undefined
  assert.ok(converterMeta !== undefined, 'meta.converter 必须保留 converter 的其余结果')
  assert.equal(Array.isArray(converterMeta.links), true)
  assert.equal((converterMeta.links as unknown[]).length, 1)
})

test('S5 DOCX 段落 / 顺序 / 超链接 / locator', { skip: SKIP }, async () => {
  const content = await readDocument(fixture('docx_basic.docx'), requireConfig())
  assert.equal(content.media_type, MEDIA_DOCX)
  assert.equal(content.completeness, 'complete')
  assert.equal(content.needs_visual, false)
  assert.equal(content.blocks[0].kind, 'heading')
  assert.equal(content.blocks[0].text, 'Synthetic Candidate')

  const locators = content.blocks.map((block) => block.locator as DocxLocator)
  for (const [index, locator] of locators.entries()) {
    assert.equal(locator.kind, 'docx')
    assert.equal(locator.part, 'word/document.xml')
    assert.equal(locator.paragraph_id, `p${index}`)
    assert.equal(content.blocks[index].order, index)
  }
  assert.deepEqual(content.blocks.map((block) => block.provenance), ['native_text', 'native_text', 'native_text', 'native_text'])

  const linked = content.blocks.find((block) => (block.links ?? []).length > 0)
  assert.ok(linked !== undefined, '必须读出超链接')
  assert.equal(linked.links?.[0].href, 'https://example.com/profile')
  assert.equal(linked.links?.[0].text, 'Example Link')
  assert.equal((linked.links?.[0].locator as DocxLocator).kind, 'docx')
})

test('S6 DOCX 表格按行列展开成 table block', { skip: SKIP }, async () => {
  const content = await readDocument(fixture('docx_table.docx'), requireConfig())
  const cells = content.blocks.filter((block) => block.kind === 'table')
  assert.equal(cells.length, 4, '2x2 表格应展开成 4 个 block')
  const locators = cells.map((block) => block.locator as DocxLocator)
  assert.deepEqual(
    locators.map((locator) => [locator.row, locator.cell]),
    [[0, 0], [0, 1], [1, 0], [1, 1]],
  )
  for (const locator of locators) {
    assert.equal(locator.table_id, 't0')
    assert.equal(locator.part, 'word/document.xml')
  }
  assert.deepEqual(cells.map((block) => block.text), ['R0C0', 'R0C1', 'R1C0', 'R1C1'])

  const after = content.blocks.find((block) => block.text === 'After table paragraph')
  assert.ok(after !== undefined, '表格后的段落必须保留')
  assert.ok(after.order > cells[cells.length - 1].order, '表格后的段落顺序必须在表格之后')
})

test('S7 DOCX 文本框内容不可读时必须 PARTIAL + HARD', { skip: SKIP }, async () => {
  const content = await readDocument(fixture('docx_textbox.docx'), requireConfig())
  const issue = content.issues.find((item) => item.code === 'docx_textbox_unread')
  assert.ok(issue !== undefined, '必须报告 docx_textbox_unread')
  assert.equal(issue.severity, 'HARD')
  assert.equal(content.completeness, 'partial')
  assert.equal(content.blocks.some((block) => block.text.includes('Textbox only sentence')), false,
    '文本框内容不得被伪造成已读文本')
})

test('S8 空 DOCX 不得冒充 complete', { skip: SKIP }, async () => {
  const content = await readDocument(fixture('empty.docx'), requireConfig())
  assert.equal(content.blocks.length, 0)
  assert.equal(content.completeness, 'partial')
  assert.equal(content.issues.some((issue) => issue.code === 'docx_no_text' && issue.severity === 'HARD'), true)
})

test('S9 PNG：一个 image block + needs_visual + HARD image_requires_vision', { skip: SKIP }, async () => {
  const content = await readDocument(fixture('sample.png'), requireConfig())
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
  assert.equal(content.meta?.width, 120)
  assert.equal(content.meta?.height, 80)
})

test('S10 JPEG：EXIF 方向进入 meta，文字仍不伪造', { skip: SKIP }, async () => {
  const content = await readDocument(fixture('sample.jpg'), requireConfig())
  assert.equal(content.media_type, MEDIA_JPEG)
  assert.equal(content.meta?.exif_orientation, 6)
  assert.equal(content.meta?.width, 100)
  assert.equal(content.meta?.height, 60)
  assert.equal(content.meta?.display_width, 60, 'orientation 6 必须交换显示宽高')
  assert.equal(content.meta?.display_height, 100)
  assert.equal(content.text, '')
  assert.equal(content.needs_visual, true)
})

test('S11 损坏 DOCX 抛结构化错误（fail-closed）', { skip: SKIP }, async () => {
  await assert.rejects(
    readDocument(fixture('corrupt.docx'), requireConfig()),
    (error: unknown) => {
      assert.ok(isDocumentReadError(error), `必须是 DocumentReadError，实际 ${String(error)}`)
      assert.ok(['DOCX_UNREADABLE', 'UNSUPPORTED_MEDIA'].includes(error.code), `意外的 code ${error.code}`)
      return true
    },
  )
})

test('S12 损坏 PNG/JPG 抛 IMAGE_UNREADABLE', { skip: SKIP }, async () => {
  const cfg = requireConfig()
  for (const name of ['corrupt.png', 'corrupt.jpg'] as const) {
    await assert.rejects(readDocument(fixture(name), cfg), (error: unknown) => {
      assert.ok(isDocumentReadError(error))
      assert.equal(error.code, 'IMAGE_UNREADABLE', `${name} 必须是 IMAGE_UNREADABLE`)
      return true
    })
  }
})

test('S13 空文件 / 未知字节 / 旧 OLE 都 fail-closed', { skip: SKIP }, async () => {
  const cfg = requireConfig()
  await assert.rejects(readDocument(fixture('empty.bin'), cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'EMPTY_FILE')
    return true
  })
  await assert.rejects(readDocument(fixture('unknown.bin'), cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'UNSUPPORTED_MEDIA')
    return true
  })
  await assert.rejects(readDocument(fixture('legacy.doc'), cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'UNSUPPORTED_MEDIA')
    assert.match(error.message, /OLE/i)
    return true
  })
})

test('S14 扩展名伪装：按真实内容读 + MEDIA_MISMATCH HARD', { skip: SKIP }, async () => {
  const cfg = requireConfig()

  const docxAsPdf = await readDocument(fixture('disguised.docx.pdf'), cfg)
  assert.equal(docxAsPdf.media_type, MEDIA_DOCX, '必须按内容当 DOCX 读')
  assert.ok(docxAsPdf.blocks.length > 0)
  const mismatch = docxAsPdf.issues.find((issue) => issue.code === ISSUE_MEDIA_MISMATCH)
  assert.ok(mismatch !== undefined)
  assert.equal(mismatch.severity, 'HARD')
  assert.equal(docxAsPdf.completeness, 'partial', 'HARD mismatch 不能是 complete')

  const pdfAsPng = await readDocument(fixture('disguised.pdf.png'), cfg)
  assert.equal(pdfAsPng.media_type, MEDIA_PDF)
  assert.ok(pdfAsPng.issues.some((issue) => issue.code === ISSUE_MEDIA_MISMATCH))

  const pngAsTxt = await readDocument(fixture('renamed.txt'), cfg)
  assert.equal(pngAsTxt.media_type, MEDIA_PNG)
  assert.ok(pngAsTxt.issues.some((issue) => issue.code === ISSUE_MEDIA_MISMATCH))
})

test('S15 同一文件两次读取一致（elapsed_ms 除外）', { skip: SKIP }, async () => {
  const cfg = requireConfig()
  for (const name of ['text.pdf', 'docx_basic.docx', 'sample.png'] as const) {
    const first = await readDocument(fixture(name), cfg)
    const second = await readDocument(fixture(name), cfg)
    assert.deepEqual(stripElapsed(first), stripElapsed(second), `${name} 两次结果必须一致`)
  }
})

test('S16 路径 fail-closed：相对路径 / 越界 / 不存在 / 目录', { skip: SKIP }, async () => {
  const cfg = requireConfig()
  await assert.rejects(readDocument('text.pdf', cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'INVALID_ARGS')
    return true
  })
  await assert.rejects(readDocument(fixture('nope.pdf'), cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'NOT_FOUND')
    return true
  })
  await assert.rejects(readDocument(fixtureRoot, cfg), (error: unknown) => {
    assert.ok(isDocumentReadError(error))
    assert.equal(error.code, 'INVALID_ARGS')
    return true
  })

  const outside = mkdtempSync(join(tmpdir(), 'u1-outside-'))
  try {
    const copied = join(outside, 'text.pdf')
    copyFileSync(fixture('text.pdf'), copied)
    await assert.rejects(readDocument(copied, cfg), (error: unknown) => {
      assert.ok(isDocumentReadError(error))
      assert.equal(error.code, 'FORBIDDEN')
      return true
    })
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('S17 四类真实输出都满足 DocumentContent 不变量', { skip: SKIP }, async () => {
  const cfg = requireConfig()
  for (const name of ['text.pdf', 'docx_basic.docx', 'sample.png', 'sample.jpg'] as const) {
    const content = await readDocument(fixture(name), cfg)
    assert.match(content.asset_sha256, /^[0-9a-f]{64}$/)
    assert.equal(new Set(content.blocks.map((block) => block.block_id)).size, content.blocks.length)
    content.blocks.forEach((block, index) => {
      assert.equal(block.order, index)
      assert.equal(block.provenance, 'native_text')
      assert.equal(typeof block.locator.kind, 'string')
    })
    for (const issue of content.issues) {
      assert.ok(issue.severity === 'HARD' || issue.severity === 'SOFT')
      assert.ok(['retry', 'switch_reader', 'vision_read', 'human_review', 'none'].includes(issue.suggested_action))
      assert.equal(typeof issue.retryable, 'boolean')
    }
  }
})

test('S18 纯映射：未知 issue code 按 HARD；fatal 抛错；SHA 不一致抛错', () => {
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
    meta: { source_sha256: sha, pages: 1, backend: 'pymupdf/x', reader_version: '1.0.0' },
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
