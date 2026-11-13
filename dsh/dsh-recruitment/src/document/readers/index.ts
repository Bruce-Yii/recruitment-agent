// U1 统一文档读取入口：内容嗅探 -> 对应 reader -> canonical DocumentContent。
//
// 这一层是「选哪个 reader」的唯一决策点，规则只有一条：**按内容，不按扩展名**。
// 扩展名与内容不符时仍然用真实内容读，但记 MEDIA_MISMATCH（HARD）并把
// completeness 降为 partial —— 既不猜，也不假装干净。
//
// 读不出任何内容（未知字节 / 旧 OLE / 非 Word 的 ZIP / 损坏包 / 空文件 /
// 越界路径 / 超时）一律抛 DocumentReadError，绝不返回“看起来 complete”的结果。
//
// 契约：canonical 类型与校验器来自 `src/document/contracts/`（U0）。
// 本目录不再声明第二套 DocumentContent / EvidenceLocator / 校验器
// （U0 README §5：同层只能有一个真相）。
//
// 读取器的附加证据（converter 的 pages/page_info/fields、DOCX 的 part 统计、
// 图片的 EXIF）通过 `readDocumentDetailed()` 的 `source_meta` 旁路返回；
// canonical content 是封闭键集，不带 `meta`。

import type { MediaType } from '../contracts/index.ts'
import type { ResolvedConverterConfig } from '../../tools/converter.ts'
import { readDocxDocumentDetailed } from './docx.ts'
import { DocumentReadError, isDocumentReadError } from './errors.ts'
import { assertReadableFile } from './files.ts'
import { readImageDocumentDetailed } from './image.ts'
import type { DocumentReadOutcome } from './outcome.ts'
import { readPdfDocumentDetailed } from './pdf.ts'
import { mediaMismatchIssue, sniffFile } from './sniff.ts'
import { assertValidDocumentContent } from './output-guard.ts'

export interface ReadDocumentOptions {
  readonly signal?: AbortSignal
}

/**
 * 读取一份本地 PDF / DOCX / PNG / JPEG，并保留读取器的附加证据。
 *
 * @param filePath - 绝对路径；必须落在 cfg.allowed_roots 内。
 * @param cfg - 与 converter 相同的配置（python_bin / converter_dir / allowed_roots / timeout_ms）。
 * @param options - 仅支持 exec.signal（中止时杀掉子进程）。
 */
export async function readDocumentDetailed(
  filePath: string,
  cfg: ResolvedConverterConfig,
  options: ReadDocumentOptions = {},
): Promise<DocumentReadOutcome> {
  const startedAt = performance.now()
  const file = assertReadableFile(filePath, cfg)
  const sniff = await sniffFile(file.real_path)
  const mismatch = mediaMismatchIssue(sniff)

  let outcome: DocumentReadOutcome
  try {
    switch (sniff.format) {
      case 'pdf':
        outcome = await readPdfDocumentDetailed(file.real_path, cfg, options.signal)
        break
      case 'docx':
        outcome = await readDocxDocumentDetailed(file.real_path, cfg, options.signal)
        break
      case 'png':
      case 'jpeg':
        outcome = await readImageDocumentDetailed(
          file.real_path,
          cfg,
          sniff.media,
          options.signal,
        )
        break
      default: {
        // 类型上不可达；运行时兜底，防止 sniff 新增格式却忘了接线。
        const exhaustive: never = sniff.format
        throw new DocumentReadError(
          'UNSUPPORTED_MEDIA',
          `no reader is wired for sniffed format "${String(exhaustive)}"`,
        )
      }
    }
  } catch (error) {
    if (mismatch !== null && isDocumentReadError(error)) {
      throw new DocumentReadError(error.code, error.message, {
        issues: [mismatch, ...error.issues],
        details: {
          ...error.details,
          extension: sniff.extension,
          sniffed_media: sniff.media,
        },
        cause: error,
      })
    }
    throw error
  }

  let issues = outcome.content.issues
  let completeness = outcome.content.completeness
  if (mismatch !== null) {
    issues = [mismatch, ...issues]
    if (completeness === 'complete') completeness = 'partial'
  }

  const assembled = {
    ...outcome.content,
    issues,
    completeness,
    elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
  }
  const content = assertValidDocumentContent(assembled, sniff.media, 'document reader')
  return { content, source_meta: outcome.source_meta }
}

/** 读取一份文档，只返回 canonical content（大多数调用方用这个）。 */
export async function readDocument(
  filePath: string,
  cfg: ResolvedConverterConfig,
  options: ReadDocumentOptions = {},
): Promise<ReadDocumentOutcome['content']> {
  return (await readDocumentDetailed(filePath, cfg, options)).content
}

export { resolveConverterConfig as resolveDocumentReaderConfig } from '../../tools/converter.ts'
export type {
  ConverterConfig as DocumentReaderConfig,
  ResolvedConverterConfig,
} from '../../tools/converter.ts'

export { DocumentReadError, isDocumentReadError } from './errors.ts'
export type { DocumentReadErrorCode } from './errors.ts'
export { readPdfDocument, readPdfDocumentDetailed, mapPdfOutput } from './pdf.ts'
export { readDocxDocument, readDocxDocumentDetailed } from './docx.ts'
export { readImageDocument, readImageDocumentDetailed } from './image.ts'
export { assertReadableFile, sha256File } from './files.ts'
export { sniffFile, detectMagic, mediaMismatchIssue, EXTENSION_FORMATS } from './sniff.ts'
export type { SniffResult } from './sniff.ts'
export { assertValidDocumentContent } from './output-guard.ts'
export type { DocumentReadOutcome } from './outcome.ts'
export {
  ISSUE_IMAGE_REQUIRES_VISION,
  ISSUE_MEDIA_MISMATCH,
  MEDIA_DOCX,
  MEDIA_JPEG,
  MEDIA_PDF,
  MEDIA_PNG,
  formatOfMedia,
  isMedia,
  locatorKindForMedia,
} from './media.ts'
export type { MediaFormat } from './media.ts'

// 类型/严重度表的唯一来源是 U0 契约；这里只是给 readers 的调用方一个方便入口。
export { converterIssueSeverity } from '../contracts/index.ts'
export type {
  BlockKind,
  Completeness,
  DocumentBlock,
  DocumentContent,
  DocumentIssue,
  DocumentLink,
  DocxLocator,
  EvidenceLocator,
  ImageLocator,
  IssueSeverity,
  LocatorKind,
  MediaType,
  PdfLocator,
  Provenance,
  SuggestedAction,
} from '../contracts/index.ts'
