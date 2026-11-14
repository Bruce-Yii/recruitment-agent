// `recruitment_resume_read` 的**格式覆盖**回归（2026-11-14，gap 一）。
//
// 修前的现场：本工具用 `assertReadablePdf()`（`src/tools/converter.ts:100`）按扩展名硬判
// `.pdf`，于是 `document_read` 能读的 DOCX 到了 resume_read 就变成
// `INVALID_ARGS(PATH_INVALID)`；converter 明明认 DOCX（MuPDF 的 OOXML 通道）。
//
// 修后的契约（本文件逐条钉住）：
//   1. 判定与 intake/document_read **同一口径**：`assertReadableFile` + `sniffFile`，
//      按**字节**选格式，扩展名不参与；
//   2. DOCX 能读（不再是 PATH_INVALID），media_type 如实写 DOCX 的 MIME；
//   3. RTF 能读（converter 的 striprtf reader），字段 provenance 是 native_text；
//   4. PDF 零回归；
//   5. 图片 / 未知字节 / 路径错误仍然 fail-closed（读不了就说读不了，不返回空内容冒充成功）。
//
// 全部用合成样本（假 phone/email，R7）；依赖本机 python + converter/，缺了 skip 并说明。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createResumeReadTool } from '../../src/tools/resume-read.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import { MEDIA_DOCX, MEDIA_PDF, MEDIA_RTF } from '../../src/document/readers/media.ts'
import { ensureFixtures, fixturePath } from '../document/fixtures.ts'
import { PYTHON_BIN } from '../helpers/paths.ts'

const HERE = import.meta.dirname
const CONVERTER_DIR = resolve(HERE, '..', '..', '..', '..', 'converter')
const PYTHON = PYTHON_BIN ?? 'python3'
const CAN_RUN_PYTHON = existsSync(PYTHON) && existsSync(join(CONVERTER_DIR, 'src', 'cli.py'))
const SKIP = CAN_RUN_PYTHON ? false : `本机没有 python（${PYTHON}）或 converter/，无法真跑读取器`

/** 合成样本目录：每次都新建，只放本测试生成的假文件。 */
const WORK_DIR = mkdtempSync(join(tmpdir(), 'recruitment-resume-read-formats-'))

/** 惰性生成 U0 合成 fixture（PDF / DOCX / PNG）。 */
let fixturesDir: string | null = null
function fixtures(): string {
  if (fixturesDir === null) {
    const generated = ensureFixtures()
    fixturesDir = generated.dir
  }
  return fixturesDir
}

function cfg(): ResolvedConverterConfig {
  return {
    python_bin: PYTHON,
    converter_dir: CONVERTER_DIR,
    allowed_roots: [WORK_DIR, fixtures()],
    timeout_ms: 120_000,
  } as ResolvedConverterConfig
}

/** 合成 RTF（假 phone/email；同一段落里带 tab 表格行）。 */
function writeRtf(): string {
  const path = join(WORK_DIR, 'synthetic-resume.rtf')
  writeFileSync(path, [
    '{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0\\fnil Arial;}}\\f0',
    '\\pard SYNTHETIC SAMPLE - NOT A REAL RESUME\\par',
    '\\pard Candidate Example Rtf\\par',
    '\\pard Phone: 138 0000 0000   Email: demo.candidate@example.invalid\\par',
    '\\pard Work experience\\par',
    '\\pard 2021.07 - 2024.06\\tab Example Technology Ltd\\tab Backend Engineer\\par}',
  ].join(''), 'utf8')
  return path
}

/** 从 `RecruitmentToolError` 的 `<CODE>: <json>` 消息里取回稳定码 + JSON 体。 */
function errorBody(error: unknown): { code?: string, reason_code?: string, message?: string } {
  const message = error instanceof Error ? error.message : String(error)
  const prefix = /^([A-Z_]+): /.exec(message)
  const index = message.indexOf(': ')
  const json = index >= 0 ? message.slice(index + 2) : message
  try {
    const body = JSON.parse(json) as { code?: string, reason_code?: string, message?: string }
    return prefix === null ? body : { ...body, code: body.code ?? prefix[1] }
  } catch {
    return prefix === null ? { message } : { code: prefix[1], message }
  }
}

test('F1 PDF 零回归：合成 PDF 照旧读出、media_type=application/pdf', { skip: SKIP }, async () => {
  const tool = createResumeReadTool(cfg())
  const value = await tool.execute({ path: fixturePath({ dir: fixtures() } as never, 'text_simple.pdf') }, {}) as Record<string, any>
  assert.equal(value.source.media_type, MEDIA_PDF)
  assert.ok(value.blocks.length > 0)
  assert.equal(value.source.pages, 2)
  assert.equal(value.provenance, 'LIVE')
})

test('F2 DOCX 能读（修前是 INVALID_ARGS(PATH_INVALID)）：media_type 如实写 DOCX', { skip: SKIP }, async () => {
  const tool = createResumeReadTool(cfg())
  const value = await tool.execute({ path: fixturePath({ dir: fixtures() } as never, 'docx_normal.docx') }, {}) as Record<string, any>
  assert.equal(value.source.media_type, MEDIA_DOCX, 'DOCX 必须被内容嗅探认出，不能按扩展名拒掉')
  assert.ok(value.blocks.length > 0, 'DOCX 必须真读出 block，而不是空成功')
  assert.equal(value.provenance, 'LIVE')
  assert.match(String(value.source.backend), /^pymupdf\//)
})

test('F3 RTF 能读：striprtf backend、字段来源 native_text、不带假 bbox', { skip: SKIP }, async () => {
  const rtf = writeRtf()
  const tool = createResumeReadTool(cfg())
  const value = await tool.execute({ path: rtf }, {}) as Record<string, any>

  assert.equal(value.source.media_type, MEDIA_RTF)
  assert.match(String(value.source.backend), /^striprtf\//, 'RTF 的读取后端必须如实写')
  assert.equal(value.source.pages, 1)
  assert.ok(value.blocks.length >= 5)
  assert.equal(value.provenance, 'LIVE', '有文件字节 sha256 + backend 就该是 LIVE')
  assert.equal(value.provenance_basis, 'FILE_BYTES_SHA256_VERIFIED')

  const phone = value.fields.phone
  const email = value.fields.email
  assert.equal(phone.state, 'present')
  assert.equal(email.state, 'present')
  assert.ok(phone.evidence.length > 0, 'present 必须带可回查证据')
  // RTF 没有 bbox：证据里是空数组，不是编出来的坐标（tool 输出约定：空数组 = 没有）。
  for (const evidence of phone.evidence) assert.deepEqual(evidence.bbox, [])

  const text = value.blocks.map((block: { text: string }) => block.text).join('\n')
  assert.ok(text.includes('demo.candidate@example.invalid'))
  // RTF 的 block page 是 1（单页无分页符），不是 0 哨兵。
  assert.ok(value.blocks.every((block: { page: number }) => block.page === 1))
})

test('F4 图片不假装能读：READER_FAILED(IMAGE_REQUIRES_VISION)，不是空成功', { skip: SKIP }, async () => {
  const tool = createResumeReadTool(cfg())
  await assert.rejects(
    () => tool.execute({ path: fixturePath({ dir: fixtures() } as never, 'image.png') }, {}),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'READER_FAILED', JSON.stringify(body))
      assert.equal(body.reason_code, 'IMAGE_REQUIRES_VISION', JSON.stringify(body))
      return true
    },
  )
})

test('F5 未知字节 fail-closed：READER_FAILED(UNSUPPORTED_MEDIA)', async () => {
  const junk = join(WORK_DIR, 'not-a-document.rtf')
  writeFileSync(junk, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]))
  const tool = createResumeReadTool(cfg())
  await assert.rejects(
    () => tool.execute({ path: junk }, {}),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'READER_FAILED')
      assert.equal(body.reason_code, 'UNSUPPORTED_MEDIA')
      return true
    },
  )
})

test('F6 路径安全仍然 fail-closed：相对路径 INVALID_ARGS、越界 FORBIDDEN、不存在 NOT_FOUND', async () => {
  const tool = createResumeReadTool({
    python_bin: PYTHON,
    converter_dir: CONVERTER_DIR,
    allowed_roots: [WORK_DIR],
    timeout_ms: 10_000,
  } as ResolvedConverterConfig)
  await assert.rejects(() => tool.execute({ path: 'relative.pdf' }, {}), /INVALID_ARGS/)
  // 越界必须是"文件存在但不在 allowed_roots 内"，否则会先命中 NOT_FOUND（顺序即契约）。
  const outside = join(tmpdir(), `recruitment-outside-${process.pid}.pdf`)
  writeFileSync(outside, '%PDF-1.4\n%%EOF\n')
  await assert.rejects(() => tool.execute({ path: outside }, {}), /FORBIDDEN/)
  await assert.rejects(() => tool.execute({ path: join(WORK_DIR, 'missing.pdf') }, {}), /NOT_FOUND/)
})
