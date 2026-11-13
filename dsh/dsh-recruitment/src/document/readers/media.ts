// 媒体常量与 locator 帮手。
//
// canonical 类型在 `src/document/contracts/`（U0）。本文件不声明任何文档类型，
// 只把 MIME 字符串、格式短名、locator kind 的对应关系和 U1 自己产生的 issue code
// 收敛到一处，避免在 4 个 reader 里各写一遍字面量。

import {
  MEDIA_TYPES,
  type LocatorKind,
  type MediaType,
} from '../contracts/index.ts'

/** docs/19 §2.1 的四种媒体，顺序与 `MEDIA_TYPES` 一致。 */
export const MEDIA_PDF: MediaType = MEDIA_TYPES[0]
export const MEDIA_DOCX: MediaType = MEDIA_TYPES[1]
export const MEDIA_PNG: MediaType = MEDIA_TYPES[2]
export const MEDIA_JPEG: MediaType = MEDIA_TYPES[3]

/** 嗅探/日志用的短格式名。 */
export type MediaFormat = 'pdf' | 'docx' | 'png' | 'jpeg'

/** U1 自己定义的 issue code（不是 converter 的 code）。 */
export const ISSUE_MEDIA_MISMATCH = 'MEDIA_MISMATCH'
export const ISSUE_IMAGE_REQUIRES_VISION = 'image_requires_vision'

export function isMedia(value: unknown): value is MediaType {
  return typeof value === 'string' && (MEDIA_TYPES as readonly string[]).includes(value)
}

export function formatOfMedia(media: MediaType): MediaFormat {
  switch (media) {
    case MEDIA_PDF:
      return 'pdf'
    case MEDIA_DOCX:
      return 'docx'
    case MEDIA_PNG:
      return 'png'
    case MEDIA_JPEG:
      return 'jpeg'
  }
}

/** 每份内容只允许一种 locator（PDF/DOCX/图片各用各的定位）。 */
export function locatorKindForMedia(media: MediaType): LocatorKind {
  if (media === MEDIA_PDF) return 'pdf'
  if (media === MEDIA_DOCX) return 'docx'
  return 'image'
}
