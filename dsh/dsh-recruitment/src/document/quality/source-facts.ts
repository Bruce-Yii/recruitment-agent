// 读取器旁路证据 → U2 的 reader facts 桥。
//
// 为什么需要这一层：U0/U1 把 canonical `DocumentContent` 做成了**封闭契约**
// （`DOCUMENT_CONTENT_KEYS` 不含 page_count / order_verified / page_info），
// 转换器的这些证据被放到旁路 `source_meta.converter_meta`（U1
// `readDocumentDetailed()` 的第二个返回值）。没有它们，U2 无法核对 docs/11 的 A1
// （页覆盖）与 A4（顺序），只能一律判 `doc_page_count_unverified`（HARD）。
//
// 所以 U3 的接线方式是：
//   const { content, source_meta } = await readDocumentDetailed(path, cfg)
//   const assessment = assess(content, readerFactsFromSourceMeta(source_meta))
//   const recovery   = plan(content, { assessment })
//
// 边界：这里只搬运读取器自己的声明，不发明事实。转换器的 `links` 是块链接的并集
// （派生物），**不能**当「原件 URI 清单」用，所以不由这里填 native_links。

import type { ReaderFacts } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 从 `source_meta`（U1）或裸的转换器 meta 里取出 reader facts。
 *
 * 接受的形状：
 *   * `{ converter_meta: { pages, page_info, order_verified, layout_backend } }`（U1）
 *   * `{ pages, page_info, order_verified, layout_backend }`（转换器 meta 原样）
 * 认不出的字段直接省略（省略 = 未声明，判定器按未核处理，不猜）。
 */
export function readerFactsFromSourceMeta(sourceMeta: unknown): ReaderFacts {
  if (!isRecord(sourceMeta)) return {}
  const nested = sourceMeta.converter_meta
  const meta = isRecord(nested) ? nested : sourceMeta

  const facts: {
    page_count?: number
    order_verified?: boolean
    layout_backend?: string | null
    page_info?: ReaderFacts['page_info']
  } = {}

  const pages = asNumber(meta.pages)
  if (pages !== null) facts.page_count = pages

  const orderFlag = meta.order_verified
  if (typeof orderFlag === 'boolean') facts.order_verified = orderFlag

  if (typeof meta.layout_backend === 'string') facts.layout_backend = meta.layout_backend
  else if (meta.layout_backend === null) facts.layout_backend = null

  if (Array.isArray(meta.page_info)) {
    const pageInfo: Array<{ page: number, chars: number | null, block_count: number | null, readable: boolean | null }> = []
    for (const item of meta.page_info) {
      if (!isRecord(item)) continue
      const page = asNumber(item.page)
      if (page === null || !Number.isInteger(page) || page < 1) continue
      pageInfo.push({
        page,
        chars: asNumber(item.chars),
        block_count: asNumber(item.block_count),
        readable: typeof item.readable === 'boolean' ? item.readable : null,
      })
    }
    if (pageInfo.length > 0) facts.page_info = pageInfo
  }

  return facts
}
