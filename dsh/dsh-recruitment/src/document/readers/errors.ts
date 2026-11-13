// 结构化读取错误：fail-closed 的唯一出口。
//
// 约定（docs/19 §2.2 / §5 NO-GO）：
//   * 读不出 / 容器损坏 / 格式不支持 / 路径越界 → 抛 DocumentReadError，
//     **不返回**一个看起来正常的 DocumentContent；
//   * 错误里带 `code`（稳定、可被上层映射）和 `issues`（可交给 U2/HR 的结构化
//     issue），message 只描述原因，不携带候选人正文（R7）；
//   * 绝不把「没读」表达成「文件里没有」。
//
// 诊断契约（2026-11-14 增补，对应 docs/11 §11 的"失败必须可归因"门槛）：
//   一条 message 必须回答「**为什么**读不出」，而不只是「哪一步失败」。
//   因此构造函数会按 code 从 `details` / `cause` 里补一层**机器可核的事实**：
//     UNSUPPORTED_MEDIA        -> 真实字节数 + 前 8 字节 hex + 声明扩展名
//     EMPTY_FILE               -> 真实字节数（0 字节与"只有换行的 2 字节占位文件"都算）
//     SOURCE_CHANGED_DURING_READ -> 前后两个 SHA-256 的前缀
//     TIMEOUT                  -> 超时值（毫秒）
//     READER_FAILED            -> 底层原因（cause）
//     ADAPTER_FAILED           -> 子进程 stderr 的首行（协议失败时唯一的线索）
//     DOCX/IMAGE_UNREADABLE    -> 容器/解码层失败的性质
//   这些事实只来自**白名单键**与 cause，绝不含文档正文（R7）。
//
// 边界：这里只补 message 文本，**不改变抛错时机、错误码或控制流**；
// 同一错误被上层重新包装（如 readers/index.ts 为 MEDIA_MISMATCH 重包）时，
// 按 `key=value` token 去重，因此 message 不会重复堆叠（幂等）。

import type { DocumentIssue } from '../contracts/index.ts'

export type DocumentReadErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFIG_INVALID'
  | 'EMPTY_FILE'
  | 'UNSUPPORTED_MEDIA'
  | 'READ_TOO_LARGE'
  | 'READER_FAILED'
  | 'TIMEOUT'
  | 'DOCX_UNREADABLE'
  | 'IMAGE_UNREADABLE'
  | 'SOURCE_CHANGED_DURING_READ'
  | 'READER_OUTPUT_INVALID'
  | 'ADAPTER_FAILED'

export interface DocumentReadErrorOptions {
  readonly issues?: readonly DocumentIssue[]
  readonly details?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

/** 单条内联事实的长度上限（避免把整段 stderr / cause 塞进一行 message）。 */
const MAX_INLINE_CHARS = 300
/** 子进程 stderr 只留首行、且截断，够定位是哪一类崩溃即可。 */
const MAX_STDERR_CHARS = 200
/** SHA-256 只带前缀：能对比"前后是不是同一份"，又不把完整哈希刷满日志。 */
const SHA_PREFIX_CHARS = 12

/** 补进 message 的诊断信息：可核事实（key=value）+ 一句"为什么会这样"。 */
interface Diagnosis {
  readonly facts: readonly string[]
  readonly why: string | null
}

/** 诊断上下文（构造函数的输入投影）。 */
interface DiagnosisContext {
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
  readonly cause: unknown
}

const NO_DIAGNOSIS: Diagnosis = { facts: [], why: null }

/** 压成一行并截断（cause / stderr 可能是多行文本，进 message 前必须压平）。 */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 取一个有限数字段；类型不对返回 null（details 是 unknown 形状，不能假设）。 */
function numberOf(details: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = details[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 取一个非空字符串字段。 */
function stringOf(details: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = details[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** cause → 单行文本；不是 Error 的 cause 按 String() 兜底，空值返回 null。 */
function causeText(cause: unknown): string | null {
  if (cause === undefined || cause === null) return null
  const raw = cause instanceof Error ? cause.message : String(cause)
  const flat = oneLine(raw, MAX_INLINE_CHARS)
  return flat === '' ? null : flat
}

/** `string.includes` 的大小写无关版本；用于判断 message 是否已自带某句解释。 */
function mentions(message: string, needle: string): boolean {
  return message.toLowerCase().includes(needle.toLowerCase())
}

/** message 里是否已经用自然语言写过这个字节数（"2 bytes" / "bytes=2"）。 */
function mentionsBytes(message: string, bytes: number): boolean {
  return message.includes(`${bytes} byte`) || message.includes(`bytes=${bytes}`)
}

/**
 * 每个 code 的"为什么"补充器。
 *
 * 只读 details 里**白名单键**（bytes/size/limit/prefix_hex/extension/container/
 * timeout_ms/converter_sha256/measured_sha256/stderr），不读任何正文/块文本。
 */
function diagnose(code: DocumentReadErrorCode, ctx: DiagnosisContext): Diagnosis {
  const { message, details } = ctx
  switch (code) {
    case 'EMPTY_FILE': {
      const bytes = numberOf(details, 'bytes')
      const alreadySaid = bytes === null || mentionsBytes(message, bytes)
      return { facts: alreadySaid ? [] : [`bytes=${bytes}`], why: null }
    }
    case 'UNSUPPORTED_MEDIA': {
      const bytes = numberOf(details, 'bytes')
      const prefix = stringOf(details, 'prefix_hex')
      const rawExtension = details['extension']
      const extension = typeof rawExtension === 'string' ? rawExtension.toLowerCase() : ''
      const declared = extension === '' ? 'no extension' : extension
      // 前 8 字节 hex：16 个 hex 字符。details.prefix_hex 存前 16 字节，这里截前 8。
      const first8 = prefix === null ? null : prefix.slice(0, 16)
      const facts: string[] = []
      if (bytes !== null && !mentionsBytes(message, bytes)) facts.push(`bytes=${bytes}`)
      if (first8 !== null) facts.push(`first8=${first8}`)
      if (typeof rawExtension === 'string') facts.push(`declared=${declared}`)
      // 没有字节事实时（例如"嗅探出新格式却没接 reader"的兜底分支）额外解释一句。
      return {
        facts,
        why: facts.length === 0
          ? 'the sniffed content is not one of PDF/DOCX/PNG/JPEG, and the extension was not used to guess a reader'
          : null,
      }
    }
    case 'READ_TOO_LARGE': {
      const bytes = numberOf(details, 'bytes')
      const limit = numberOf(details, 'limit_bytes') ?? numberOf(details, 'limit')
      const facts: string[] = []
      if (bytes !== null && !mentionsBytes(message, bytes)) facts.push(`bytes=${bytes}`)
      if (limit !== null) facts.push(`limit=${limit}`)
      return {
        facts,
        why: facts.length === 0
          ? 'the file exceeds the reader size cap, so it was not parsed'
          : null,
      }
    }
    case 'TIMEOUT': {
      const timeout = numberOf(details, 'timeout_ms')
      return {
        facts: timeout === null ? [] : [`timeout_ms=${timeout}`],
        why: timeout === null && !mentions(message, 'ms')
          ? 'the reader exceeded its deadline and was killed; no partial result was kept'
          : null,
      }
    }
    case 'SOURCE_CHANGED_DURING_READ': {
      const before = stringOf(details, 'converter_sha256')
      const after = stringOf(details, 'measured_sha256')
      const facts: string[] = []
      if (before !== null) facts.push(`converter_sha256=${before.slice(0, SHA_PREFIX_CHARS)}…`)
      if (after !== null) facts.push(`measured_sha256=${after.slice(0, SHA_PREFIX_CHARS)}…`)
      return { facts, why: null }
    }
    case 'READER_FAILED': {
      const cause = causeText(ctx.cause)
      return {
        facts: cause === null || message.includes(cause) ? [] : [`cause=${cause}`],
        why: null,
      }
    }
    case 'ADAPTER_FAILED': {
      const stderr = stringOf(details, 'stderr')
      if (stderr !== null) {
        // Python 的 traceback 最后一行才是异常本身；首行永远是 "Traceback ..."。
        const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
        const tail = oneLine(lines[lines.length - 1] ?? '', MAX_STDERR_CHARS)
        return {
          facts: tail === '' || message.includes(tail) ? [] : [`stderr_tail=${tail}`],
          why: null,
        }
      }
      return {
        facts: [],
        why: 'the reader adapter protocol failed before any document content was produced',
      }
    }
    case 'DOCX_UNREADABLE': {
      const explains = mentions(message, 'corrupt')
        || mentions(message, 'required part')
        || mentions(message, 'DOCX package')
        || mentions(message, 'not a valid ZIP')
      return {
        facts: [],
        why: explains
          ? null
          : 'the .docx package is corrupt, encrypted, or missing a required part; no text was extracted',
      }
    }
    case 'IMAGE_UNREADABLE': {
      const explains = mentions(message, 'decode') || mentions(message, 'PNG/JPEG')
      return {
        facts: [],
        why: explains
          ? null
          : 'Pillow could not decode the image bytes as PNG/JPEG; no pixels were inspected',
      }
    }
    case 'READER_OUTPUT_INVALID': {
      // "reader 说 ok 却没给 content" 这类消息本身没说清是谁的问题，补一句定性。
      const explains = mentions(message, 'no content object')
      return {
        facts: [],
        why: explains
          ? 'the adapter reported success but omitted content; this is a reader defect, not an unreadable file'
          : null,
      }
    }
    case 'CONFIG_INVALID': {
      return {
        facts: [],
        why: 'the reader configuration is incomplete, so no file was opened',
      }
    }
    case 'FORBIDDEN': {
      const roots = numberOf(details, 'allowed_roots')
      return {
        facts: roots === null || message.includes(`allowed_roots=${roots}`) ? [] : [`allowed_roots=${roots}`],
        why: null,
      }
    }
    case 'INVALID_ARGS':
    case 'NOT_FOUND':
      // 这两个由 files.ts / sniff.ts 在抛错点直接说清"为什么拒"（参数形态、路径边界），
      // 事实已经写在 message 里，构造函数不再堆叠。
      return NO_DIAGNOSIS
  }
}

/** 把诊断信息接到 message 后面；按 token 去重，保证重复包装时幂等。 */
function explain(code: DocumentReadErrorCode, message: string, options: DocumentReadErrorOptions): string {
  // 不改写原 message（output-guard 会把 violations 排成多行，保留它的可读性），
  // 只在其后追加诊断后缀。
  const base = message.trim()
  let diagnosis: Diagnosis
  try {
    diagnosis = diagnose(code, {
      message: base,
      details: options.details ?? {},
      cause: options.cause,
    })
  } catch {
    // 诊断是"锦上添花"，绝不能因为 details 形状异常把原始错误变成另一种错误。
    diagnosis = NO_DIAGNOSIS
  }
  const missingFacts = diagnosis.facts.filter((fact) => !base.includes(fact))
  const parts: string[] = []
  if (missingFacts.length > 0) parts.push(`(${missingFacts.join(', ')})`)
  if (diagnosis.why !== null) parts.push(`[why: ${diagnosis.why}]`)
  return parts.length === 0 ? base : `${base} ${parts.join(' ')}`
}

export class DocumentReadError extends Error {
  readonly code: DocumentReadErrorCode
  readonly issues: readonly DocumentIssue[]
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: DocumentReadErrorCode, message: string, options: DocumentReadErrorOptions = {}) {
    const explained = explain(code, message, options)
    super(explained, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DocumentReadError'
    this.code = code
    this.issues = options.issues ?? []
    this.details = options.details ?? {}
  }
}

/** 判断一个值是不是本模块的结构化错误（跨 bundle 时按形状兜底）。 */
export function isDocumentReadError(value: unknown): value is DocumentReadError {
  return value instanceof DocumentReadError
    || (typeof value === 'object' && value !== null
      && (value as { name?: unknown }).name === 'DocumentReadError'
      && typeof (value as { code?: unknown }).code === 'string')
}
