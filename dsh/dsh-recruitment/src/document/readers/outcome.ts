// 一次读取的完整产物：canonical DocumentContent + 契约之外的读取器证据。
//
// 为什么 meta 不放进 DocumentContent：canonical 契约（`src/document/contracts/types.ts`
// 的 `DOCUMENT_CONTENT_KEYS`）是**封闭键集**，多一个 `meta` 键就会被 U0 校验器判非法。
// 但 U1 验收又要求 PDF 映射「不丢 meta」（converter 的 pages / page_info /
// order_verified / fields 等）。两者不冲突的解法是：content 保持封闭，
// 旁路用一个显式的 `source_meta` 携带读取器证据；需要证据的调用方取它，
// 下游只消费 content。U0 落地后如果要把它升进契约，改这一处即可。

import type { DocumentContent } from '../contracts/index.ts'

export interface DocumentReadOutcome {
  readonly content: DocumentContent
  /** 读取器的附加证据（不参与 canonical 契约校验）。 */
  readonly source_meta: Readonly<Record<string, unknown>>
}
