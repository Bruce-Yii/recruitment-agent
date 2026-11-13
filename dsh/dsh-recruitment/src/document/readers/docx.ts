// DOCX reader：调用 python/document_readers.py（python-docx）并产出 canonical content。
//
// 这里不解析 OOXML，只做三件事：
//   1. 起子进程（stdin JSON / stdout JSON / 超时 / abort）；
//   2. 补上原件 SHA-256 与 elapsed_ms；
//   3. 交给 U0 的校验器（output-guard），不合法就抛，绝不返回半成品。
//
// 段落 / 表格 / 顺序 / 超链接的实现全部在 Python 适配器里，规则只有一份。
// 适配器返回的 meta（part 统计、文本框数等）走 `source_meta`，不塞进封闭契约。

import type { DocumentContent } from '../contracts/index.ts'
import type { ResolvedConverterConfig } from '../../tools/converter.ts'
import { DocumentReadError } from './errors.ts'
import { sha256File } from './files.ts'
import { MEDIA_DOCX } from './media.ts'
import type { DocumentReadOutcome } from './outcome.ts'
import { assertValidDocumentContent } from './output-guard.ts'
import { runDocumentAdapter } from './python-bridge.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取 DOCX 并保留适配器的附加证据。 */
export async function readDocxDocumentDetailed(
  filePath: string,
  cfg: ResolvedConverterConfig,
  signal?: AbortSignal,
): Promise<DocumentReadOutcome> {
  const startedAt = performance.now()
  const response = await runDocumentAdapter(cfg, { op: 'docx', path: filePath }, 'DOCX read', signal)
  const assetSha256 = await sha256File(filePath)
  if (!isRecord(response.content)) {
    throw new DocumentReadError('READER_OUTPUT_INVALID', 'DOCX reader returned no content object')
  }
  const assembled = {
    ...response.content,
    asset_sha256: assetSha256,
    elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
  }
  const content = assertValidDocumentContent(assembled, MEDIA_DOCX, 'docx reader')
  return {
    content,
    source_meta: isRecord(response.source_meta) ? response.source_meta : {},
  }
}

/** 读取一份 DOCX（只返回 canonical content）。 */
export async function readDocxDocument(
  filePath: string,
  cfg: ResolvedConverterConfig,
  signal?: AbortSignal,
): Promise<DocumentContent> {
  return (await readDocxDocumentDetailed(filePath, cfg, signal)).content
}
