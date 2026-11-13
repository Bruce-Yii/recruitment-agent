// 结构化读取错误：fail-closed 的唯一出口。
//
// 约定（docs/19 §2.2 / §5 NO-GO）：
//   * 读不出 / 容器损坏 / 格式不支持 / 路径越界 → 抛 DocumentReadError，
//     **不返回**一个看起来正常的 DocumentContent；
//   * 错误里带 `code`（稳定、可被上层映射）和 `issues`（可交给 U2/HR 的结构化
//     issue），message 只描述原因，不携带候选人正文（R7）；
//   * 绝不把「没读」表达成「文件里没有」。

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

export class DocumentReadError extends Error {
  readonly code: DocumentReadErrorCode
  readonly issues: readonly DocumentIssue[]
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: DocumentReadErrorCode, message: string, options: DocumentReadErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
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
