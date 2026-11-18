// 邮件解析层（rec/31 §4.1）：mailparser simpleParser 解析原始 RFC822 字节，
// 产出收件元数据 + 附件列表（filename/contentType/buffer/bytes/sha256）。
//
// 安全边界：
//   * 文件名安全化：basename + 长度截断，禁止路径穿越（`../`、绝对路径、盘符）。
//   * 附件大小上限（默认 25MB）：超限跳过并记录 reason，不静默截断。
//   * 只认已知类型（PDF/DOCX/RTF）：按**字节魔数**判定（复用
//     `src/document/readers/sniff.ts` 的 detectMagic，它要路径就先落临时文件再 sniff），
//     不按扩展名猜；未知/图片/宏文档按"读不出来"跳过，不猜 reader。
//   * 正文/PII 不进结果；只保留摘要与 sha。

import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'

import { detectMagic, type DetectedContainer } from '../../document/readers/sniff.ts'
import { MailTransportError, mailSummary, type RawMailMessage } from './contract.ts'

/**
 * 单封邮件的附件总大小上限：20MB（总控第四轮补强，原 25MB 改为 20MB）。
 * 超限的附件跳过并记录 reason（ATTACHMENT_TOO_LARGE），不静默截断。
 */
export const MAIL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
/** 文件名安全化后的最大长度（含扩展名）。 */
export const MAIL_FILENAME_MAX_CHARS = 120

/** 解析后的一个可用附件（只在此层持有 buffer，落盘算 sha 后由编排层释放）。 */
export interface ParsedAttachment {
  readonly filename: string
  readonly contentType: string
  readonly bytes: number
  readonly sha256: string
  readonly buffer: Buffer
  /** 嗅探到的容器格式（pdf/docx/rtf）。 */
  readonly format: 'pdf' | 'docx' | 'rtf'
}

/** 一个被跳过的附件及其原因（不静默丢弃）。 */
export interface SkippedAttachment {
  readonly filename: string
  readonly reason: string
  readonly bytes: number
}

/** 收件元数据摘要（不进正文全文）。 */
export interface ParsedMailSummary {
  readonly message_id: string
  readonly subject: string
  readonly from: string
  readonly date: string
  readonly text_summary: string
}

/** 一次解析的产物。 */
export interface ParsedMail {
  readonly summary: ParsedMailSummary
  readonly attachments: readonly ParsedAttachment[]
  readonly skipped: readonly SkippedAttachment[]
}

/** 文件名安全化：basename + 长度截断 + 禁止路径穿越字符。 */
export function safeMailFileName(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return 'attachment'
  // 统一 Windows / POSIX 分隔符后取末段，堵死 `..\..\x` 与 `/etc/passwd`。
  const normalized = raw.replace(/\\/g, '/')
  let name = basename(normalized)
  // 去掉控制字符与路径残留。
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\.\./g, '_')
  if (name === '' || name === '.' || name === '..') name = 'attachment'
  const ext = extname(name).toLowerCase()
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  const trimmedStem = stem.slice(0, Math.max(1, MAIL_FILENAME_MAX_CHARS - ext.length))
  return `${trimmedStem}${ext}`.slice(0, MAIL_FILENAME_MAX_CHARS)
}

/** 已知、可交给 intake 的容器格式；其它（zip/ole/png/jpeg/unknown）一律跳过。 */
function knownFormat(container: DetectedContainer): 'pdf' | 'docx' | 'rtf' | null {
  if (container === 'pdf') return 'pdf'
  if (container === 'rtf') return 'rtf'
  return null
}

/** 按字节嗅探容器；DOCX 是 ZIP，需要检测 zip 内容（detectMagic 只返回 'zip'）。 */
function sniffBuffer(buffer: Buffer): DetectedContainer {
  return detectMagic(buffer.subarray(0, 64 * 1024))
}

/**
 * 用 mailparser 的 simpleParser 解析原始邮件。
 * 依赖由宿主 package.json 注入；未安装时动态加载并映射到 INVALID_MESSAGE。
 */
export async function parseRawMail(raw: Buffer, fallback: RawMailMessage, maxBytes: number = MAIL_ATTACHMENT_MAX_BYTES): Promise<ParsedMail> {
  let simpleParser: (input: Buffer) => Promise<Record<string, unknown>>
  // mailparser 的类型由宿主 package.json 提供；未安装时编译期放宽，运行时动态加载。
  // @ts-ignore - optional dependency; loaded lazily at parse time
  const module = await import('mailparser') as Record<string, unknown>
  const candidate = module.simpleParser
  if (typeof candidate !== 'function') {
    throw new MailTransportError('INVALID_MESSAGE', 'MAILPARSER_UNAVAILABLE')
  }
  simpleParser = candidate as (input: Buffer) => Promise<Record<string, unknown>>

  let parsed: Record<string, unknown>
  try {
    parsed = await simpleParser(raw)
  } catch (error) {
    const code = typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code
      : 'PARSE_FAILED'
    throw new MailTransportError('INVALID_MESSAGE', code)
  }

  const summary: ParsedMailSummary = {
    message_id: fallback.message_id,
    subject: mailSummary(parsed.subject ?? fallback.headers['subject'] ?? ''),
    from: mailSummary(typeof parsed.from === 'object' && parsed.from !== null
      ? ((parsed.from as { text?: unknown }).text ?? '')
      : (parsed.from ?? fallback.headers['from'] ?? '')),
    date: parsed.date instanceof Date
      ? parsed.date.toISOString()
      : mailSummary(parsed.date ?? fallback.headers['date'] ?? ''),
    text_summary: mailSummary(parsed.text ?? fallback.text ?? ''),
  }

  const attachments: ParsedAttachment[] = []
  const skipped: SkippedAttachment[] = []
  let totalBytes = 0
  const rawAttachments = Array.isArray(parsed.attachments) ? parsed.attachments : []
  for (const item of rawAttachments) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const filename = safeMailFileName(typeof record.filename === 'string' ? record.filename : 'attachment')
    const contentType = typeof record.contentType === 'string' ? record.contentType : 'application/octet-stream'
    const content = Buffer.isBuffer(record.content)
      ? record.content
      : record.content instanceof Uint8Array
        ? Buffer.from(record.content)
        : null
    const bytes = content === null ? 0 : content.length
    if (content === null) {
      skipped.push({ filename, reason: 'ATTACHMENT_CONTENT_MISSING', bytes: 0 })
      continue
    }
    if (bytes === 0) {
      skipped.push({ filename, reason: 'EMPTY_ATTACHMENT', bytes: 0 })
      continue
    }
    // 单封总大小预算 20MB：超限的跳过并记原因，不静默截断。
    if (bytes > maxBytes || totalBytes + bytes > maxBytes) {
      skipped.push({ filename, reason: 'ATTACHMENT_TOO_LARGE', bytes })
      continue
    }
    const container = sniffBuffer(content)
    // DOCX（ZIP+word/document.xml）用 detectMagic 只能看到 zip；这里用轻量检查补足，
    // 不自己解压：真正的判定仍由 orchestrator 调用 resolveIntakeSource → sniffFile 完成。
    let format = knownFormat(container)
    if (container === 'zip') {
      const looksDocx = content.includes(Buffer.from('word/document.xml'))
        && content.includes(Buffer.from('[Content_Types].xml'))
      if (looksDocx) format = 'docx'
    }
    if (format === null) {
      const reason = container === 'png' || container === 'jpeg'
        ? 'IMAGE_REQUIRES_VISION'
        : container === 'ole'
          ? 'LEGACY_OLE_UNSUPPORTED'
          : 'UNSUPPORTED_MEDIA'
      skipped.push({ filename, reason, bytes })
      continue
    }
    attachments.push({
      filename,
      contentType,
      bytes,
      sha256: createHash('sha256').update(content).digest('hex'),
      buffer: content,
      format,
    })
    totalBytes += bytes
  }
  return { summary, attachments, skipped }
}

/**
 * 从 RawMailMessage 取原始字节（transport 提供，解析用）。
 * 兼容假 transport：若没给 raw，会按附件里已有的 content 拼一个最小 MIME 不可行，
 * 因此要求假实现提供 raw 或 attachments[].content（后者走 direct 路径）。
 */
export function rawBytesOf(message: RawMailMessage): Buffer | null {
  return Buffer.isBuffer(message.raw) ? message.raw : null
}
