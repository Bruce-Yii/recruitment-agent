// `recruitment_document_read`（U3 收口）的测试。
//
// 2026-11-14：解析层（U0 契约 / U1 Reader / U2 质量+恢复）早就实现并有 73 条测试，
// 但**没有暴露成工具** —— agent 调不到，属于 R2 的假接线。本文件证明"真的接出来了"。
//
// 覆盖：
//   1. 合成 PDF（自带文本层，不含任何真实个人资料）→ 读出内容 + 块 + 判定 + 恢复计划；
//   2. **source_meta 旁路生效**：blocking_codes 里不得出现 `doc_page_count_unverified`
//      （只消费 readDocument() 会丢 facts，症状正是每份 PDF 都命中它，见 src/document/README.md §6.2）；
//   3. 输出无 null（DSH 校验器不支持 type:null）；
//   4. 路径越界 → FORBIDDEN；未知字节 → READER_FAILED（读不出就报错，不返回"看起来 complete"）；
//   5. 未配置替身。
//
// 需要本机 python + converter/；缺任一项时 skip（不伪装成通过）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createDocumentReadTool, unconfiguredDocumentReadTool } from '../../src/tools/document-read.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'

const HERE = import.meta.dirname
const CONVERTER_DIR = resolve(HERE, '..', '..', '..', '..', 'converter')
const PYTHON = 'D:\\Python3.12.9\\python.exe'
const CAN_RUN_PYTHON = existsSync(PYTHON)
  && existsSync(join(CONVERTER_DIR, 'src', 'cli.py'))

/** 造一份**带文本层**的一页合成 PDF（内容全是假数据，R7）。 */
const MAKE_TEXT_PDF = String.raw`
import sys
from pathlib import Path
import fitz

out = Path(sys.argv[1])
font = r"C:\Windows\Fonts\simhei.ttf"
lines = [
    ("SYNTHETIC SAMPLE - NOT A REAL RESUME", 11.0),
    ("Candidate Example A", 18.0),
    ("Phone: 138-0000-0000   Email: demo.candidate@example.invalid", 11.5),
    ("Work experience", 13.0),
    ("2021.07 - 2024.06  Example Technology Ltd  Backend Engineer", 11.5),
    ("- split the order service; P99 went from 480ms to 120ms", 11.5),
    ("Education", 13.0),
    ("2015.09 - 2019.06  Example University  Computer Science  BSc", 11.5),
]
doc = fitz.open()
page = doc.new_page(width=595, height=842)
y = 70.0
for text, size in lines:
    page.insert_text((50, y), text, fontsize=size, fontname="cjk" if font else "helv",
                     fontfile=font if font else None)
    y += size * 1.6 + 2.0
doc.save(str(out), deflate=True, garbage=4)
doc.close()
print("ok")
`

/** 在 temp 下造一份合成 PDF。 */
function makeTextPdf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recruitment-doc-read-'))
  const pdf = join(dir, 'synthetic-text.pdf')
  execFileSync(PYTHON, ['-c', MAKE_TEXT_PDF, pdf], { encoding: 'utf8', timeout: 60_000 })
  return pdf
}

/** 测试用的 converter 配置：allowed_roots 只放 temp，别的都读不到。 */
function cfgFor(roots: readonly string[]): ResolvedConverterConfig {
  return {
    python_bin: PYTHON,
    converter_dir: CONVERTER_DIR,
    allowed_roots: [...roots],
    timeout_ms: 90_000,
  } as ResolvedConverterConfig
}

/**
 * 递归找 null；DSH 的输出 schema 没有 type:null，出现 null 会 INVALID_TOOL_OUTPUT。
 * @param value - 任意值。
 * @param path - 当前路径（用于报错定位）。
 * @returns 找到的第一个 null 的路径，没有则 null。
 */
function findNull(value: unknown, path = '$'): string | null {
  if (value === null) return path
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNull(value[i], `${path}[${i}]`)
      if (hit !== null) return hit
    }
    return null
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const hit = findNull(child, `${path}.${key}`)
      if (hit !== null) return hit
    }
  }
  return null
}

test('document_read：合成 PDF → 内容 + 块 + 判定 + 恢复计划（真跑 python）', { skip: CAN_RUN_PYTHON ? false : '本机没有 python / converter' }, async () => {
  const pdf = makeTextPdf()
  const tool = createDocumentReadTool(cfgFor([tmpdir()]))
  const value = await tool.execute({ path: pdf }) as Record<string, any>

  assert.equal(value.media_type, 'application/pdf')
  assert.equal(value.completeness, 'complete')
  assert.equal(value.page_count, 1)
  assert.ok(value.blocks.length > 0, 'blocks 不能为空')
  assert.ok(value.text.includes('SYNTHETIC SAMPLE'), 'text 必须含原文')
  assert.equal(value.asset_sha256.length, 64)

  // 判定与恢复计划是"接线"的证明：字段必须齐、且形状稳定
  assert.equal(typeof value.assessment.blocking, 'boolean')
  assert.ok(Array.isArray(value.assessment.issues))
  assert.ok(Array.isArray(value.recovery.steps))
  assert.ok(['structure', 'repair', 'human'].includes(value.recovery.next))
  assert.equal(value.recovery.plan_id.length > 0, true)

  // 关键断言：source_meta 旁路生效。只消费 readDocument() 会丢 facts，
  // 症状就是每份 PDF 都命中 doc_page_count_unverified（HARD）。
  assert.equal(
    value.assessment.blocking_codes.includes('doc_page_count_unverified'),
    false,
    'blocking_codes 不该有 doc_page_count_unverified —— 说明 readerFactsFromSourceMeta 没被用上',
  )

  // DSH 输出 schema 不支持 null
  assert.equal(findNull(value), null, `输出里出现了 null：${findNull(value)}`)
})

test('document_read：路径越界 → FORBIDDEN（allowed_roots 之外读不到）', async () => {
  const outside = join(mkdtempSync(join(tmpdir(), 'recruitment-doc-outside-')), 'x.pdf')
  writeFileSync(outside, '%PDF-1.4\n%%EOF\n')
  const inside = mkdtempSync(join(tmpdir(), 'recruitment-doc-inside-'))
  const tool = createDocumentReadTool(cfgFor([inside]))
  await assert.rejects(() => tool.execute({ path: outside }), /FORBIDDEN/)
})

test('document_read：读不出就报错，不返回"看起来 complete"的结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recruitment-doc-junk-'))
  const junk = join(dir, 'not-a-document.bin')
  writeFileSync(junk, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))
  const tool = createDocumentReadTool(cfgFor([dir]))
  await assert.rejects(() => tool.execute({ path: junk }), /READER_FAILED|UNSUPPORTED_MEDIA|EMPTY_FILE/)
})

test('document_read：未配置时注册同一个工具名，调用报 NOT_CONFIGURED', async () => {
  const tool = unconfiguredDocumentReadTool(['converter.python_bin'])
  assert.equal(tool.name, 'recruitment_document_read')
  await assert.rejects(() => tool.execute({ path: 'x.pdf' }), /NOT_CONFIGURED/)
})
