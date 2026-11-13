// 合成 fixture 的验收：能被生成、字节数/页数/像素符合**人工写死的预期**。
//
// 两套独立证据（任何一套说谎都会红）：
//   * 生成器（Python + PyMuPDF/python-docx/Pillow）在写盘后自检；
//   * 本文件用纯 JS 复核文件本身：PDF 页对象、PNG IHDR、JPEG SOF、ZIP magic、sha256。
//
// 路径纪律：一律 `path.join` / `os.tmpdir()`，不出现任何盘符。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import {
  GENERATOR_SCRIPT,
  REPO_ROOT,
  ensureFixtures,
  fixtureEntry,
  fixturePath,
  jpegSize,
  pdfPageCount,
  pngSize,
  sha256OfFile,
  type Fixtures,
} from './fixtures.ts'

// 人工核过的预期（不是从 manifest 抄的：manifest 也要被这几组常量核对）。
const EXPECTED_PAGES: Readonly<Record<string, number>> = {
  'text_simple.pdf': 2,
  'text_two_column.pdf': 1,
  'scan_image_only.pdf': 1,
  'ocr_confusable.pdf': 1,
  'text_variant_same_content.pdf': 2,
}

const EXPECTED_PIXELS: Readonly<Record<string, { width: number; height: number }>> = {
  'image.png': { width: 800, height: 1000 },
  'image.jpg': { width: 800, height: 1000 },
}

const EXPECTED_NAMES = [
  'text_simple.pdf',
  'text_two_column.pdf',
  'scan_image_only.pdf',
  'ocr_confusable.pdf',
  'text_variant_same_content.pdf',
  'docx_normal.docx',
  'docx_table.docx',
  'image.png',
  'image.jpg',
  'corrupted_truncated.pdf',
  'masquerade_not_a_pdf.pdf',
  'zero_byte.pdf',
]

let fixtures: Fixtures | null = null

/** 生成一次，整个文件复用。 */
function setup(): Fixtures {
  fixtures ??= ensureFixtures()
  return fixtures
}

after(() => {
  if (fixtures === null) return
  // 只删自己刚建的临时目录（确保它确实在 os.tmpdir() 下面）。
  const dir = resolve(fixtures.dir)
  if (dir.startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true })
})

test('F1 生成器产出全部 12 个样本，顺序与 manifest 一致', () => {
  const generated = setup()
  assert.deepEqual(
    [...generated.manifest.files.map((entry) => entry.name)],
    EXPECTED_NAMES,
    'manifest 里少了或多了一个样本',
  )
  assert.deepEqual([...generated.manifest.ordering], EXPECTED_NAMES)
  for (const name of EXPECTED_NAMES) {
    assert.equal(existsSync(fixturePath(generated, name)), true, `${name} 没有落盘`)
  }
})

test('F2 字节数与 sha256 与 manifest 一致（Node 自己算，不采信生成器）', () => {
  const generated = setup()
  for (const entry of generated.manifest.files) {
    const path = fixturePath(generated, entry.name)
    const bytes = readFileSync(path)
    assert.equal(bytes.length, entry.bytes, `${entry.name} 字节数不符`)
    assert.equal(sha256OfFile(path), entry.sha256, `${entry.name} sha256 不符`)
  }
})

test('F3 PDF 页数：纯 JS 数页对象，和人工预期一致', () => {
  const generated = setup()
  for (const [name, pages] of Object.entries(EXPECTED_PAGES)) {
    const actual = pdfPageCount(readFileSync(fixturePath(generated, name)))
    assert.equal(actual, pages, `${name} 页数不符`)
    assert.equal(fixtureEntry(generated, name).expected.pages, pages, `${name} manifest 里的预期页数与人工预期不一致`)
  }
})

test('F4 扫描 PDF 真的没有文字层（纯图像），且至少一张图', () => {
  const generated = setup()
  const entry = fixtureEntry(generated, 'scan_image_only.pdf')
  assert.equal(entry.expected.native_text, false)
  assert.equal(entry.observed.native_chars, 0, '扫描样本不该有原生文字')
  const images = entry.observed.images_per_page as number[]
  assert.ok(images.reduce((sum, count) => sum + count, 0) >= 1, '扫描样本至少要有一张图')
})

test('F5 PNG / JPEG 像素：纯 JS 读文件头，800x1000', () => {
  const generated = setup()
  for (const [name, size] of Object.entries(EXPECTED_PIXELS)) {
    const bytes = readFileSync(fixturePath(generated, name))
    const actual = name.endsWith('.png') ? pngSize(bytes) : jpegSize(bytes)
    assert.notEqual(actual, null, `${name} 不是一个可识别的 ${name.endsWith('.png') ? 'PNG' : 'JPEG'}`)
    assert.deepEqual(actual, size, `${name} 像素不符`)
  }
})

test('F6 DOCX 是合法 OOXML 包（ZIP magic + word/document.xml），正常件没有表格、表格件有表', () => {
  const generated = setup()
  for (const name of ['docx_normal.docx', 'docx_table.docx']) {
    const bytes = readFileSync(fixturePath(generated, name))
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'PK\x03\x04', `${name} 不是 ZIP 容器`)
    // ZIP 的中央目录把文件名明文存放，所以这一条不依赖解压。
    assert.ok(bytes.toString('latin1').includes('word/document.xml'), `${name} 缺 word/document.xml`)
  }
  const normal = fixtureEntry(generated, 'docx_normal.docx')
  const table = fixtureEntry(generated, 'docx_table.docx')
  assert.equal(normal.expected.tables, 0)
  assert.equal(table.expected.tables, 1)
  assert.equal(table.expected.table_rows, 3)
  assert.equal(table.expected.table_cols, 2)
  assert.equal(table.expected.hyperlinks, 1)
  assert.deepEqual(table.expected.table_cell_texts, ['YEAR', 'ROLE', '2020', 'TEST ROLE ONE', '2021', 'TEST ROLE TWO'])
  assert.equal(table.observed.tables, 1)
  assert.equal(table.observed.hyperlinks, 1)
})

test('F7 损坏件三种：截断 PDF 更小、非 PDF 伪装不以 %PDF- 开头、0 字节为空', () => {
  const generated = setup()
  const original = fixtureEntry(generated, 'text_simple.pdf')
  const truncated = fixtureEntry(generated, 'corrupted_truncated.pdf')
  assert.ok(truncated.bytes > 0, '截断件不该是空文件')
  assert.ok(truncated.bytes < original.bytes, '截断件必须比原件小')
  const ratio = truncated.bytes / original.bytes
  assert.ok(Math.abs(ratio - 0.45) < 0.02, `截断比例应约为 0.45，实际 ${ratio.toFixed(3)}`)

  const masquerade = readFileSync(fixturePath(generated, 'masquerade_not_a_pdf.pdf'))
  assert.notEqual(masquerade.subarray(0, 5).toString('latin1'), '%PDF-', '伪装件不能以 %PDF- 开头')
  assert.equal(masquerade.subarray(0, 4).toString('latin1'), 'PK\x03\x04', '伪装件是 ZIP 负载')

  assert.equal(fixtureEntry(generated, 'zero_byte.pdf').bytes, 0)
  assert.equal(readFileSync(fixturePath(generated, 'zero_byte.pdf')).length, 0)
})

test('F8 同内容不同 bytes：文本长度一致、sha256 必须不同', () => {
  const generated = setup()
  const simple = fixtureEntry(generated, 'text_simple.pdf')
  const variant = fixtureEntry(generated, 'text_variant_same_content.pdf')
  assert.notEqual(simple.sha256, variant.sha256, '变体必须和原件不同 bytes')
  assert.equal(
    simple.observed.native_chars,
    variant.observed.native_chars,
    '变体必须保留同样的原生文字',
  )
  assert.equal(simple.expected.text_contains.length, variant.expected.text_contains.length)
})

test('F9 产物必须在仓库外（PDF / 图片不许入库）', () => {
  const generated = setup()
  const dir = resolve(generated.dir)
  assert.ok(dir.startsWith(resolve(tmpdir()) + sep), `fixture 目录应在 os.tmpdir() 下，实际 ${dir}`)
  assert.equal(dir.startsWith(resolve(REPO_ROOT) + sep), false, 'fixture 不许写进仓库')
})

test('F10 R7 自检：生成器与 manifest 都不含真实个人资料', () => {
  const generated = setup()
  assert.equal(generated.manifest.self_check.no_real_personal_data, true)
  assert.equal(generated.manifest.self_check.expectations_are_hand_written, true)

  // 1) 生成器脚本里出现的每个邮箱都必须是保留 TLD（和仓库里既有的 R7 自检同口径）。
  //    注意：只按邮箱正则扫，不按字面量扫 —— 否则守卫自己的黑名单会把自己判红。
  const source = readFileSync(GENERATOR_SCRIPT, 'utf8')
  const sourceEmails = source.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? []
  assert.ok(sourceEmails.length > 0, '生成器里应当能找到它自己造的邮箱（否则这条自检是空的）')
  for (const email of sourceEmails) {
    assert.ok(
      email.endsWith('@example.invalid') || email.endsWith('@examp1e.invalid'),
      `生成器里出现了非保留 TLD 的邮箱：${email}`,
    )
  }

  // 2) manifest 里声明的人读文本：邮箱 / 电话都必须在虚构区间。
  for (const entry of generated.manifest.files) {
    const texts = [...((entry.expected.text_contains as string[] | undefined) ?? []), ...((entry.expected.text as string[] | undefined) ?? []), ...((entry.expected.paragraphs as string[] | undefined) ?? [])]
    for (const line of texts) {
      for (const email of line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? []) {
        assert.ok(
          email.endsWith('@example.invalid') || email.endsWith('@examp1e.invalid'),
          `样本邮箱不在保留 TLD：${email}`,
        )
      }
      for (const phone of line.match(/\b\d{3}-\d{4}\b/g) ?? []) {
        assert.ok(phone.startsWith('555-01'), `样本电话不在 555-01xx 虚构区间：${phone}`)
      }
    }
  }
})
