// 内容嗅探：按字节判断 PDF / DOCX / PNG / JPEG，扩展名永远不参与选 reader。
//
// 判定规则（docs/19 U1）：
//   PDF  : 前 8 字节 `%PDF-`
//   PNG  : 8 字节 PNG 签名 `89 50 4E 47 0D 0A 1A 0A`
//   JPEG : `FF D8 FF`
//   DOCX : ZIP 局部头 `PK\x03\x04`，且 ZIP 目录里**同时**存在
//          `[Content_Types].xml` 与 `word/document.xml`
//
// 「fail-closed，不猜」的含义：
//   * 扩展名与内容不符 → 用**真实内容**选 reader，并由调用方记 MEDIA_MISMATCH；
//   * 内容无法识别、或只是 ZIP 但不是 Word（xlsx/pptx/其它）→ 抛
//     UNSUPPORTED_MEDIA，绝不用扩展名猜一个 reader 去读；
//   * 旧二进制 Office（OLE，`.doc` 等）→ UNSUPPORTED_MEDIA，明确说没有实现。
//
// DOCX 的 zip 目录解析不依赖第三方库：读 EOCD → 中央目录 → 条目名。ZIP64 或
// 目录损坏时退化为扫描文件头部 1 MiB 里的两个条目名；两者都不在 → 拒绝。

import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { FileHandle } from 'node:fs/promises'

import { DocumentReadError } from './errors.ts'
import { hardIssue } from './issues.ts'
import {
  ISSUE_MEDIA_MISMATCH,
  MEDIA_DOCX,
  MEDIA_JPEG,
  MEDIA_PDF,
  MEDIA_PNG,
  type MediaFormat,
} from './media.ts'
import type { MediaType } from '../contracts/index.ts'

const HEAD_BYTES = 64 * 1024
const PREFIX_SCAN_BYTES = 1024 * 1024
const EOCD_SIZE = 22
const EOCD_MAX_COMMENT = 65_535
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024

const SIG_PDF = Buffer.from('%PDF-', 'ascii')
const SIG_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SIG_JPEG = Buffer.from([0xff, 0xd8, 0xff])
const SIG_ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const SIG_ZIP_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const SIG_ZIP_SPANNED = Buffer.from([0x50, 0x4b, 0x07, 0x08])
const SIG_OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

const CONTENT_TYPES = '[Content_Types].xml'
const WORD_DOCUMENT = 'word/document.xml'
const XLSX_WORKBOOK = 'xl/workbook.xml'
const PPTX_PRESENTATION = 'ppt/presentation.xml'

export type DetectedContainer = 'pdf' | 'png' | 'jpeg' | 'zip' | 'ole' | null

/** 扩展名 → 它**声明**的格式；未知扩展名返回 undefined（不算 mismatch）。 */
export const EXTENSION_FORMATS: Readonly<Record<string, MediaFormat | 'other'>> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  // 已知但 U1 不支持的格式：内容若是上面四种之一，就是「扩展名与内容不符」。
  '.doc': 'other',
  '.xls': 'other',
  '.xlsx': 'other',
  '.ppt': 'other',
  '.pptx': 'other',
  '.gif': 'other',
  '.webp': 'other',
  '.bmp': 'other',
  '.tif': 'other',
  '.tiff': 'other',
  '.heic': 'other',
  '.svg': 'other',
  '.rtf': 'other',
  '.odt': 'other',
  '.txt': 'other',
  '.md': 'other',
}

export interface SniffResult {
  readonly media: MediaType
  readonly format: MediaFormat
  readonly bytes: number
  /** 小写扩展名，含点；无扩展名时为空串。 */
  readonly extension: string
  /** 扩展名声明的格式；未知扩展名为 null。 */
  readonly extension_format: MediaFormat | 'other' | null
  /** null = 扩展名无法判断（没有扩展名或扩展名未登记），不算 mismatch。 */
  readonly matches_extension: boolean | null
  /** 前 16 字节的 hex，便于日志复核（不是内容摘要）。 */
  readonly prefix_hex: string
  readonly evidence: string
}

/** 纯函数：只看字节判断容器。 */
export function detectMagic(head: Buffer): DetectedContainer {
  if (head.length >= SIG_PDF.length && head.subarray(0, SIG_PDF.length).equals(SIG_PDF)) return 'pdf'
  if (head.length >= SIG_PNG.length && head.subarray(0, SIG_PNG.length).equals(SIG_PNG)) return 'png'
  if (head.length >= SIG_JPEG.length && head.subarray(0, SIG_JPEG.length).equals(SIG_JPEG)) return 'jpeg'
  if (head.length >= SIG_ZIP_LOCAL.length
    && (head.subarray(0, 4).equals(SIG_ZIP_LOCAL)
      || head.subarray(0, 4).equals(SIG_ZIP_EOCD)
      || head.subarray(0, 4).equals(SIG_ZIP_SPANNED))) return 'zip'
  if (head.length >= SIG_OLE.length && head.subarray(0, SIG_OLE.length).equals(SIG_OLE)) return 'ole'
  return null
}

function mediaForFormat(format: MediaFormat): MediaType {
  switch (format) {
    case 'pdf':
      return MEDIA_PDF
    case 'docx':
      return MEDIA_DOCX
    case 'png':
      return MEDIA_PNG
    case 'jpeg':
      return MEDIA_JPEG
  }
}

function sniffResult(
  filePath: string,
  bytes: number,
  format: MediaFormat,
  evidence: string,
  prefix: Buffer,
): SniffResult {
  const extension = extname(filePath).toLowerCase()
  const extensionFormat = extension in EXTENSION_FORMATS ? EXTENSION_FORMATS[extension]! : null
  const matchesExtension = extensionFormat === null ? null : extensionFormat === format
  return {
    media: mediaForFormat(format),
    format,
    bytes,
    extension,
    extension_format: extensionFormat,
    matches_extension: matchesExtension,
    prefix_hex: prefix.subarray(0, 16).toString('hex'),
    evidence,
  }
}

async function readRange(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, offset)
  return buffer.subarray(0, bytesRead)
}

function findEocd(tail: Buffer): number {
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail[i] !== 0x50 || tail[i + 1] !== 0x4b || tail[i + 2] !== 0x05 || tail[i + 3] !== 0x06) {
      continue
    }
    const commentLength = tail.readUInt16LE(i + 20)
    if (i + EOCD_SIZE + commentLength <= tail.length) return i
  }
  return -1
}

/** 从 EOCD + 中央目录读出条目名；无法可靠解析时返回 null（由调用方退化扫描）。 */
async function listZipEntries(filePath: string, size: number): Promise<string[] | null> {
  const handle = await open(filePath, 'r')
  try {
    const tailLength = Math.min(size, EOCD_SIZE + EOCD_MAX_COMMENT)
    const tail = await readRange(handle, size - tailLength, tailLength)
    const eocd = findEocd(tail)
    if (eocd < 0) return null
    const entryCount = tail.readUInt16LE(eocd + 10)
    const directorySize = tail.readUInt32LE(eocd + 12)
    const directoryOffset = tail.readUInt32LE(eocd + 16)
    // ZIP64 或明显损坏：交给前缀扫描（只用于判断 DOCX，不用于解压）。
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      return null
    }
    if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES) return null
    if (directoryOffset + directorySize > size) return null
    const directory = await readRange(handle, directoryOffset, directorySize)
    const names: string[] = []
    let position = 0
    while (position + 46 <= directory.length) {
      if (directory.readUInt32LE(position) !== 0x02014b50) break
      const nameLength = directory.readUInt16LE(position + 28)
      const extraLength = directory.readUInt16LE(position + 30)
      const commentLength = directory.readUInt16LE(position + 32)
      const start = position + 46
      const end = start + nameLength
      if (end > directory.length) break
      names.push(directory.subarray(start, end).toString('utf8'))
      position = end + extraLength + commentLength
      if (names.length >= entryCount && entryCount > 0) break
    }
    return names.length > 0 ? names : null
  } finally {
    await handle.close()
  }
}

async function prefixContainsDocxParts(filePath: string, size: number): Promise<boolean> {
  const handle = await open(filePath, 'r')
  try {
    const length = Math.min(size, PREFIX_SCAN_BYTES)
    const prefix = await readRange(handle, 0, length)
    return prefix.includes(Buffer.from(CONTENT_TYPES, 'utf8'))
      && prefix.includes(Buffer.from(WORD_DOCUMENT, 'utf8'))
  } finally {
    await handle.close()
  }
}

function unsupported(
  code: string,
  message: string,
  filePath: string,
  size: number,
  head: Buffer,
  extra: Record<string, unknown> = {},
): never {
  const extension = extname(filePath).toLowerCase()
  // 消息必须回答"为什么"，且可被机器复核（docs/11 §11）：真实字节数 + 前 8 字节 hex
  // + 扩展名声明的格式。扩展名只用于说明"没有拿它猜 reader"，不参与选 reader。
  const declared = extension === '' ? 'no extension' : extension
  const prefixHex = head.subarray(0, 16).toString('hex')
  const first8Hex = head.subarray(0, 8).toString('hex')
  throw new DocumentReadError(
    'UNSUPPORTED_MEDIA',
    `${message} (bytes=${size}, first8=${first8Hex}, declared=${declared})`,
    {
      details: { reason: code, extension, declared, bytes: size, prefix_hex: prefixHex, ...extra },
      issues: [
        hardIssue(
          'unsupported_media',
          'the file content is not one of PDF / DOCX / PNG / JPEG; the extension was not used to guess a reader',
        ),
      ],
    },
  )
}

/** 嗅探一份真实文件。读不出/无法识别时抛结构化错误，不返回猜测结果。 */
export async function sniffFile(filePath: string): Promise<SniffResult> {
  const handle = await open(filePath, 'r')
  let head: Buffer
  let size: number
  try {
    const stats = await handle.stat()
    size = stats.size
    if (!stats.isFile()) {
      const kind = stats.isDirectory() ? 'a directory' : 'a non-file entry'
      throw new DocumentReadError(
        'INVALID_ARGS',
        `path is not a regular file: ${filePath}; it is ${kind}, and only regular files carry `
          + 'document bytes, so nothing was read',
      )
    }
    if (size === 0) {
      // 0 字节不是"损坏的文档"，是**空占位文件**。
      throw new DocumentReadError(
        'EMPTY_FILE',
        'file is empty (0 bytes); a 0-byte file has no PDF/DOCX/PNG/JPEG magic bytes to parse, '
          + 'so this is an empty placeholder rather than a corrupt document',
        { details: { bytes: 0 } },
      )
    }
    // 真实语料里踩过：`排版经历.pdf` 只有 2 字节（一个 CRLF），是仓库里的空占位文件。
    // 报 "content does not match magic bytes" 会让人以为是格式问题，其实**文件本身就是空的**。
    // 任何受支持格式的魔数至少要 3 字节（JPEG FF D8 FF），PDF 要 5 字节，PNG 要 8 字节；
    // 小于 8 字节的文件一律按"空文件"报，并带上真实字节数与真实前几个字节。
    if (size < 8) {
      const prefix = await readRange(handle, 0, size)
      throw new DocumentReadError(
        'EMPTY_FILE',
        `file is ${size} byte${size === 1 ? '' : 's'}, first bytes ${prefix.toString('hex')}; that is `
          + 'too small to hold any supported magic (JPEG needs 3 bytes, PDF needs "%PDF-", PNG needs '
          + 'an 8-byte signature), so this is an empty placeholder rather than a corrupt document',
        { details: { bytes: size, prefix_hex: prefix.toString('hex') } },
      )
    }
    head = await readRange(handle, 0, Math.min(size, HEAD_BYTES))
  } finally {
    await handle.close()
  }

  const container = detectMagic(head)
  if (container === 'pdf') return sniffResult(filePath, size, 'pdf', 'magic:%PDF-', head)
  if (container === 'png') return sniffResult(filePath, size, 'png', 'magic:png-signature', head)
  if (container === 'jpeg') return sniffResult(filePath, size, 'jpeg', 'magic:ffd8ff', head)
  if (container === 'ole') {
    unsupported(
      'ole_container',
      'legacy binary Office (OLE) containers are not supported by this reader; re-export as .docx explicitly',
      filePath,
      size,
      head,
      { container: 'ole' },
    )
  }
  if (container !== 'zip') {
    unsupported(
      'unknown_magic',
      'content does not match PDF, DOCX, PNG or JPEG magic bytes',
      filePath,
      size,
      head,
    )
  }

  let entries = await listZipEntries(filePath, size)
  let evidence = 'zip:central-directory'
  if (entries === null) {
    if (!(await prefixContainsDocxParts(filePath, size))) {
      unsupported(
        'zip_without_word_part',
        'ZIP container is not a Word document (missing [Content_Types].xml or word/document.xml)',
        filePath,
        size,
        head,
        { container: 'zip' },
      )
    }
    entries = [CONTENT_TYPES, WORD_DOCUMENT]
    evidence = 'zip:prefix-scan'
  }
  const hasContentTypes = entries.includes(CONTENT_TYPES)
  const hasWordDocument = entries.includes(WORD_DOCUMENT)
  if (hasContentTypes && hasWordDocument) {
    return sniffResult(filePath, size, 'docx', evidence, head)
  }
  if (entries.includes(XLSX_WORKBOOK)) {
    unsupported('zip_is_xlsx', 'ZIP container is an Excel workbook, not a Word document', filePath, size, head, {
      container: 'xlsx',
    })
  }
  if (entries.includes(PPTX_PRESENTATION)) {
    unsupported('zip_is_pptx', 'ZIP container is a PowerPoint deck, not a Word document', filePath, size, head, {
      container: 'pptx',
    })
  }
  unsupported(
    'zip_without_word_part',
    'ZIP container is not a Word document (missing [Content_Types].xml or word/document.xml)',
    filePath,
    size,
    head,
    { container: 'zip' },
  )
}

/** 把嗅探结果翻译成 MEDIA_MISMATCH issue（调用方负责决定是否降级 completeness）。 */
export function mediaMismatchIssue(sniff: SniffResult): ReturnType<typeof hardIssue> | null {
  if (sniff.matches_extension !== false) return null
  const declared = sniff.extension === '' ? 'no extension' : `"${sniff.extension}"`
  return hardIssue(
    ISSUE_MEDIA_MISMATCH,
    `declared extension ${declared} does not match the sniffed content (${sniff.media}); `
      + 'the file was read by its real content, not by the extension',
    'human_review',
  )
}
