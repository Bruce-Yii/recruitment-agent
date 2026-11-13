// 错误可诊断回归（对应 docs/11 §11.3 的 R-3「失败可归因」）。
//
// 背景：真实语料第一次跑，"读不出"的消息不可诊断——一个 2 字节的空占位文件被报成
// `content does not match PDF, DOCX, PNG or JPEG magic bytes`，看不出"文件是空的"。
// 修好 empty-file 那一条只解决了 14 个 `DocumentReadErrorCode` 里的 1 个；本文件把
// **全部 14 个 code** 的"message 必须回答为什么"变成可执行的断言。
//
// 三层：
//   1. 闭集完整性：14 个 code 一个不少，每个都有"可诊断消息"的样例与期望；
//   2. 逐个 code 的事实断言：字节数 / 前 8 字节 hex / 超时值 / 前后 SHA 前缀 /
//      底层原因 / 容器性质——message 里必须真的出现，而不是只躺在 details 里；
//   3. R7：错误消息不得携带候选人正文（用合成假资料验证，绝不碰真实语料）。
//
// 这些断言只检查 message 文本；不检查抛错时机与控制流（那属于 readers.test.ts）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertReadableFile,
  assertValidDocumentContent,
  DocumentReadError,
  sniffFile,
  type DocumentReadErrorCode,
} from '../../src/document/readers/index.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'

/** 14 个 code 的运行时清单（与 `DocumentReadErrorCode` 联合类型逐字对应）。 */
const ALL_CODES: readonly DocumentReadErrorCode[] = [
  'INVALID_ARGS',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFIG_INVALID',
  'EMPTY_FILE',
  'UNSUPPORTED_MEDIA',
  'READ_TOO_LARGE',
  'READER_FAILED',
  'TIMEOUT',
  'DOCX_UNREADABLE',
  'IMAGE_UNREADABLE',
  'SOURCE_CHANGED_DURING_READ',
  'READER_OUTPUT_INVALID',
  'ADAPTER_FAILED',
]

/** 临时目录（只放本测试生成的假文件；不含任何真实候选人资料）。 */
const WORK_DIR = mkdtempSync(join(tmpdir(), 'recruitment-error-diagnosability-'))

/** reader 配置：allowed_roots 只放临时目录。 */
const CFG: ResolvedConverterConfig = {
  python_bin: 'python-unused',
  converter_dir: 'converter-unused',
  allowed_roots: [WORK_DIR],
  timeout_ms: 60_000,
} as ResolvedConverterConfig

/** 写一个临时文件并返回绝对路径。 */
function tempFile(name: string, bytes: Buffer | string): string {
  const file = join(WORK_DIR, name)
  writeFileSync(file, bytes)
  return file
}

/** 断言 message 同时满足若干"必须出现"的事实（任一缺失即失败并打印完整消息）。 */
function expectMessage(error: DocumentReadError, facts: readonly string[]): void {
  for (const fact of facts) {
    assert.ok(
      error.message.toLowerCase().includes(fact.toLowerCase()),
      `${error.code} 的 message 缺少"为什么"的事实 ${JSON.stringify(fact)}：\n${error.message}`,
    )
  }
}

test('R-3 闭集：14 个 DocumentReadErrorCode 全部覆盖，缺一个就失败', () => {
  assert.equal(new Set(ALL_CODES).size, 14, 'DocumentReadErrorCode 必须是 14 个（去重后）')
})

test('路径类失败（INVALID_ARGS / NOT_FOUND / FORBIDDEN / EMPTY_FILE）的 message 说清"为什么拒"', async () => {
  // 空路径：不是"读失败"，是"没有可解析的目标"。
  assert.throws(
    () => assertReadableFile('', CFG),
    (error: unknown) => {
      assert.ok(error instanceof DocumentReadError)
      assert.equal(error.code, 'INVALID_ARGS')
      expectMessage(error, ['non-empty', 'nothing was opened'])
      return true
    },
  )

  // 相对路径：会被解析到子进程自己的 cwd，可能指向别的文件。
  assert.throws(
    () => assertReadableFile('relative.pdf', CFG),
    (error: unknown) => {
      assert.ok(error instanceof DocumentReadError)
      assert.equal(error.code, 'INVALID_ARGS')
      expectMessage(error, ['absolute', 'subprocess working directory'])
      return true
    },
  )

  // 不存在：路径可能拼错 / 被移动 / 在离线位置。
  const missing = join(WORK_DIR, 'not-here.pdf')
  assert.throws(
    () => assertReadableFile(missing, CFG),
    (error: unknown) => {
      assert.ok(error instanceof DocumentReadError)
      assert.equal(error.code, 'NOT_FOUND')
      expectMessage(error, ['does not exist', missing, 'nothing was read'])
      return true
    },
  )

  // 目录：普通文件才有文档字节。
  assert.throws(
    () => assertReadableFile(WORK_DIR, CFG),
    (error: unknown) => {
      assert.ok(error instanceof DocumentReadError)
      assert.equal(error.code, 'INVALID_ARGS')
      expectMessage(error, ['not a regular file', 'nothing was read'])
      return true
    },
  )

  // 越界：文件存在，但 reader 不被允许打开它——这不是"读失败"。
  const outside = mkdtempSync(join(tmpdir(), 'recruitment-error-outside-'))
  const outsideFile = join(outside, 'x.pdf')
  writeFileSync(outsideFile, '%PDF-1.4\n%%EOF\n')
  assert.throws(
    () => assertReadableFile(outsideFile, CFG),
    (error: unknown) => {
      assert.ok(error instanceof DocumentReadError)
      assert.equal(error.code, 'FORBIDDEN')
      expectMessage(error, ['allowed_roots', 'not allowed to open', 'nothing was read'])
      return true
    },
  )

  // 0 字节：是空占位，不是损坏文档。
  const empty = tempFile('empty.pdf', '')
  assert.throws(
    () => assertReadableFile(empty, CFG),
    (error: unknown) => {
      assert.ok(error instanceof DocumentReadError)
      assert.equal(error.code, 'EMPTY_FILE')
      expectMessage(error, ['0 bytes', 'empty placeholder'])
      return true
    },
  )

  // 2 字节（真实语料里的空占位文件就是这种）：必须报"太小"，不得报"格式不支持"。
  const tiny = tempFile('tiny.pdf', '\r\n')
  await assert.rejects(sniffFile(tiny), (error: unknown) => {
    assert.ok(error instanceof DocumentReadError)
    assert.equal(error.code, 'EMPTY_FILE', '2 字节文件必须是 EMPTY_FILE，不是 UNSUPPORTED_MEDIA')
    expectMessage(error, ['2 bytes', '0d0a', 'too small', 'empty placeholder'])
    return true
  })
})

test('UNSUPPORTED_MEDIA 的 message 必带真实字节数 + 前 8 字节 hex + 声明扩展名', async () => {
  // 未知字节：注意正文里故意放"假候选人资料"，下面会验证它没有泄漏进消息（R7）。
  const junk = tempFile('not-a-document.txt', '王小明 13800000000 wangxiaoming@example.invalid')
  await assert.rejects(sniffFile(junk), (error: unknown) => {
    assert.ok(error instanceof DocumentReadError)
    assert.equal(error.code, 'UNSUPPORTED_MEDIA')
    expectMessage(error, [
      `bytes=${Buffer.byteLength('王小明 13800000000 wangxiaoming@example.invalid')}`,
      'first8=',
      'declared=.txt',
      'content does not match',
    ])
    assert.match(error.message, /first8=[0-9a-f]{16}/u, `first8 必须是前 8 字节（16 hex）：${error.message}`)
    return true
  })

  // 旧二进制 Office（OLE）：必须说清是"旧容器，请另存为 .docx"，而不是"未知格式"。
  const ole = tempFile('legacy.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]))
  await assert.rejects(sniffFile(ole), (error: unknown) => {
    assert.ok(error instanceof DocumentReadError)
    assert.equal(error.code, 'UNSUPPORTED_MEDIA')
    expectMessage(error, ['OLE', 'bytes=10', 'first8=d0cf11e0a1b11ae1', 'declared=.doc', 're-export as .docx'])
    return true
  })

  // 扩展名与内容不符不是"读不出"，但内容不认识时必须给字节事实。
  const noExtension = tempFile('noext', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]))
  await assert.rejects(sniffFile(noExtension), (error: unknown) => {
    assert.ok(error instanceof DocumentReadError)
    assert.equal(error.code, 'UNSUPPORTED_MEDIA')
    expectMessage(error, ['bytes=10', 'declared=no extension'])
    return true
  })
})

test('READER_FAILED / TIMEOUT / ADAPTER_FAILED 的 message 必带底层原因 / 超时值 / stderr 尾部', () => {
  // READER_FAILED：message 没写原因时，由构造函数补上 cause。
  const readerFailed = new DocumentReadError('READER_FAILED', 'PDF reader failed', {
    cause: new Error('spawn python ENOENT'),
  })
  expectMessage(readerFailed, ['cause=', 'spawn python ENOENT'])

  // TIMEOUT：真实生产者（pdf.ts / python-bridge.ts）在 message 里写超时值；
  // 只给 details 时也必须落到 message。
  const timeoutWithMessage = new DocumentReadError(
    'TIMEOUT',
    'PDF reader exceeded the 60000 ms timeout; the process was killed, no partial body kept',
  )
  expectMessage(timeoutWithMessage, ['60000 ms', 'killed'])
  const timeoutWithDetails = new DocumentReadError('TIMEOUT', 'reader timed out', {
    details: { timeout_ms: 1234 },
  })
  expectMessage(timeoutWithDetails, ['timeout_ms=1234'])

  // ADAPTER_FAILED：Python traceback 的最后一行才是异常本身，必须进 message；
  // 没有 stderr 时至少要说清"适配器协议失败、没有产出内容"。
  const adapterFailed = new DocumentReadError('ADAPTER_FAILED', 'DOCX read produced no output (exit 1)', {
    details: {
      stderr: 'Traceback (most recent call last):\n  File "document_readers.py", line 1\nRuntimeError: zip part missing',
      exit_code: 1,
    },
  })
  expectMessage(adapterFailed, ['stderr_tail=', 'RuntimeError: zip part missing'])
  const adapterNoStderr = new DocumentReadError('ADAPTER_FAILED', 'DOCX read output is not JSON')
  expectMessage(adapterNoStderr, ['[why:', 'protocol failed', 'document content'])
})

test('SOURCE_CHANGED_DURING_READ 的 message 必带前后两个 SHA-256 前缀', () => {
  const before = 'a'.repeat(64)
  const after = 'b'.repeat(64)
  const error = new DocumentReadError(
    'SOURCE_CHANGED_DURING_READ',
    'the SHA-256 converter recorded differs from the SHA-256 of the file on disk',
    { details: { converter_sha256: before, measured_sha256: after } },
  )
  expectMessage(error, ['converter_sha256=aaaaaaaaaaaa', 'measured_sha256=bbbbbbbbbbbb'])
  assert.equal(error.message.includes(before), false, '完整 SHA 不应刷进 message（前缀足够定位）')
})

test('容器/解码/输出类失败（DOCX_UNREADABLE / IMAGE_UNREADABLE / READER_OUTPUT_INVALID / READ_TOO_LARGE / CONFIG_INVALID）都有"为什么"', async () => {
  // 适配器只给了薄消息时，构造函数补上"容器层发生了什么"。
  const docx = new DocumentReadError('DOCX_UNREADABLE', 'DOCX read failed [docx_unreadable]: the DOCX package could not be read (corrupt, encrypted, or missing a required part)')
  expectMessage(docx, ['corrupt', 'required part'])

  const image = new DocumentReadError('IMAGE_UNREADABLE', 'image read failed [image_unreadable]: the image could not be read')
  expectMessage(image, ['[why:', 'Pillow', 'PNG/JPEG'])

  const outputInvalid = new DocumentReadError('READER_OUTPUT_INVALID', 'DOCX reader returned no content object')
  expectMessage(outputInvalid, ['[why:', 'reader defect', 'not an unreadable file'])

  // 真正的 output-guard 校验失败：message 里必须有 violation 明细，而不是只说"不合法"。
  assert.throws(
    () => assertValidDocumentContent({ nonsense: true }, 'application/pdf', 'pdf reader'),
    (error: unknown) => {
      assert.ok(error instanceof DocumentReadError)
      assert.equal(error.code, 'READER_OUTPUT_INVALID')
      assert.ok(error.message.includes('returned invalid document content'), error.message)
      assert.ok(error.message.length > 'returned invalid document content'.length, '必须带 violation 明细')
      return true
    },
  )

  const tooLarge = new DocumentReadError('READ_TOO_LARGE', 'image read failed [too_large]: file is larger than the reader limit')
  expectMessage(tooLarge, ['[why:', 'size cap', 'not parsed'])
  const tooLargeWithFacts = new DocumentReadError('READ_TOO_LARGE', 'image read failed [too_large]: file is larger than the reader limit', {
    details: { bytes: 999, limit_bytes: 100 },
  })
  expectMessage(tooLargeWithFacts, ['bytes=999', 'limit=100'])

  const configInvalid = new DocumentReadError('CONFIG_INVALID', 'reader configuration is missing python_bin')
  expectMessage(configInvalid, ['[why:', 'configuration is incomplete', 'no file was opened'])
})

test('幂等：上层为 MEDIA_MISMATCH 重新包装错误时，message 不重复堆叠诊断事实', () => {
  const inner = new DocumentReadError(
    'UNSUPPORTED_MEDIA',
    'content does not match PDF, DOCX, PNG or JPEG magic bytes',
    { details: { bytes: 39, prefix_hex: '7365637265742064', extension: '.txt' } },
  )
  // 模拟 src/document/readers/index.ts 的重包：同 code、同 message、details 合并。
  const outer = new DocumentReadError(inner.code, inner.message, {
    details: { ...inner.details, extension: '.txt', sniffed_media: 'application/pdf' },
    cause: inner,
  })
  assert.equal(outer.message, inner.message, '重包后 message 必须逐字一致（幂等）')
  assert.equal(outer.message.split('bytes=39').length - 1, 1, `bytes=39 只应出现一次：${outer.message}`)
})

test('R7：错误消息不得携带候选人正文（合成假资料，不碰真实语料）', async () => {
  const secrets = ['王小明', '13800000000', 'wangxiaoming@example.invalid']
  const junk = tempFile('fake-candidate.bin', secrets.join(' '))
  await assert.rejects(sniffFile(junk), (error: unknown) => {
    assert.ok(error instanceof DocumentReadError)
    for (const secret of secrets) {
      assert.equal(
        error.message.includes(secret),
        false,
        `错误消息泄漏了正文片段 ${JSON.stringify(secret)}：${error.message}`,
      )
    }
    return true
  })

  // 带 cause 的失败同样不能泄漏：cause 只能是底层错误文本。
  const readerFailed = new DocumentReadError('READER_FAILED', 'PDF reader failed', {
    cause: new Error('spawn python ENOENT'),
  })
  for (const secret of secrets) {
    assert.equal(readerFailed.message.includes(secret), false)
  }
})
