// 图片 reader（PNG / JPEG）：Pillow 只读尺寸/EXIF 方向，**不做 OCR**。
//
// 输出契约（docs/19 §2.2 第 3 条 + U1 验收）：
//   * 恰好一个 `other` block，text 为空；
//   * needs_visual = true；
//   * issue `image_requires_vision`（HARD，suggested_action=vision_read）；
//   * completeness 只能是 partial —— 像素里的字没有被任何模型读过，不许冒充文本。
//
// 如果 Pillow 识别出的格式与内容嗅探结果矛盾（例如 PNG 头 + GIF 体），
// output-guard 会以 READER_OUTPUT_INVALID 拒绝，而不是返回一半结果。

import type { DocumentContent, MediaType } from '../contracts/index.ts'
import type { ResolvedConverterConfig } from '../../tools/converter.ts'
import { DocumentReadError } from './errors.ts'
import { sha256File } from './files.ts'
import { ISSUE_IMAGE_REQUIRES_VISION } from './media.ts'
import type { DocumentReadOutcome } from './outcome.ts'
import { assertValidDocumentContent } from './output-guard.ts'
import { runDocumentAdapter } from './python-bridge.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读取一张 PNG/JPEG 并保留 Pillow 的附加证据。
 *
 * @param expectedMedia - 内容嗅探得到的 media；Pillow 必须给出同一结论。
 */
export async function readImageDocumentDetailed(
  filePath: string,
  cfg: ResolvedConverterConfig,
  expectedMedia: MediaType,
  signal?: AbortSignal,
): Promise<DocumentReadOutcome> {
  const startedAt = performance.now()
  const response = await runDocumentAdapter(cfg, { op: 'image', path: filePath }, 'image read', signal)
  const assetSha256 = await sha256File(filePath)
  if (!isRecord(response.content)) {
    throw new DocumentReadError('READER_OUTPUT_INVALID', 'image reader returned no content object')
  }
  const assembled = {
    ...response.content,
    asset_sha256: assetSha256,
    elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
  }
  const content = assertValidDocumentContent(assembled, expectedMedia, 'image reader')

  // 这三条是 U1 对「不许假装读图」的硬约束，不依赖 Python 侧自觉。
  if (content.needs_visual !== true) {
    throw new DocumentReadError(
      'READER_OUTPUT_INVALID',
      'image reader must set needs_visual=true; pixels were not transcribed',
    )
  }
  if (!content.issues.some((issue) => issue.code === ISSUE_IMAGE_REQUIRES_VISION)) {
    throw new DocumentReadError(
      'READER_OUTPUT_INVALID',
      `image reader must report a ${ISSUE_IMAGE_REQUIRES_VISION} issue`,
    )
  }
  if (content.completeness === 'complete') {
    throw new DocumentReadError(
      'READER_OUTPUT_INVALID',
      'image reader must not report completeness=complete without OCR/vision text',
    )
  }
  return {
    content,
    source_meta: isRecord(response.source_meta) ? response.source_meta : {},
  }
}

/** 读取一张 PNG/JPEG（只返回 canonical content）。 */
export async function readImageDocument(
  filePath: string,
  cfg: ResolvedConverterConfig,
  expectedMedia: MediaType,
  signal?: AbortSignal,
): Promise<DocumentContent> {
  return (await readImageDocumentDetailed(filePath, cfg, expectedMedia, signal)).content
}
