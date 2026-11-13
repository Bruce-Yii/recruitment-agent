// reader 输出的最后一道闸：调用 U0 的校验器，不合法就抛结构化错误。
//
// 契约层的 `validateDocumentContent()` 语义是「不抛异常、收集 violations」
// （README §5 第 4 条）。U1 的 reader 需要的是「不合法就 fail-closed」，
// 所以这里只做一层包装：调 U0 的校验器 → 有 hard violation 就抛
// DocumentReadError(READER_OUTPUT_INVALID)，绝不返回半成品。
//
// 本文件**不声明**自己的 DocumentContent / 校验规则；唯一的事实来源是
// `src/document/contracts/`。

import {
  formatViolations,
  validateDocumentContent,
  type DocumentContent,
  type DocumentViolation,
  type MediaType,
} from '../contracts/index.ts'
import { DocumentReadError } from './errors.ts'

/**
 * 校验 content 并返回窄化后的引用。
 *
 * @param value - reader 产出的对象（unknown，故意不做类型假设）。
 * @param expectedMedia - 内容嗅探得到的媒体；reader 说别的就是自相矛盾。
 * @param label - 出错时用于定位 reader 的短名（例如 "pdf reader"）。
 */
export function assertValidDocumentContent(
  value: unknown,
  expectedMedia: MediaType,
  label: string,
): DocumentContent {
  const validation = validateDocumentContent(value)
  if (!validation.valid) {
    throw new DocumentReadError(
      'READER_OUTPUT_INVALID',
      `${label} returned invalid document content:\n${formatViolations(validation).slice(0, 4000)}`,
      { details: { violations: validation.violations } },
    )
  }
  const content = value as DocumentContent
  if (content.media_type !== expectedMedia) {
    throw new DocumentReadError(
      'READER_OUTPUT_INVALID',
      `${label} returned media_type ${JSON.stringify(content.media_type)} but the sniffed content is ${JSON.stringify(expectedMedia)}`,
      { details: { expected_media: expectedMedia, actual_media: content.media_type } },
    )
  }
  return content
}

/** 暴露 violations 类型给测试断言用（避免测试直接 import 契约内部路径）。 */
export type { DocumentViolation }
