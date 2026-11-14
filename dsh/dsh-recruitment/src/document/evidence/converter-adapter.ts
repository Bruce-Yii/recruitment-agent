// converter 输出 → 证据闸门上下文（D-110 落地胶水）。
//
// 职责只有一个：把「一次真实转换」的产物变成 {@link EvidenceGateContext}：
//   * `source_sha256`：采信 converter 自报的字节 sha（**核验时会被独立重算**，
//     不采信自报值——自报只是"待核声明"，不是"已验证"）；
//   * `source_bytes`：本文件从 `realPath` 重新读出来的原始字节（证据核验的锚点）；
//   * `blocks`：converter `blocks[]` 的 `{locator, text}` 投影（唯一位置判定用）。
//
// 为什么单独一层、且**不**从 `src/tools/converter.ts` 静态 import 类型：
//   `db/identity.ts` 要消费本模块的上下文；若本模块反向静态 import `tools/converter.ts`
//   （运行时 import，不只 type），会形成 `db → document → tools → db` 的运行期环。
//   这里用 `unknown` + 结构化收窄：converter 输出本来就在运行期来自 JSON，
//   类型系统管不到，收窄是必须的；`ConverterOutput` 的 type-only import 也不必要。
//
// 失败语义（全部结构化返回，**绝不 throw**）：
//   OSError（不存在 / 权限 / 是目录）→ `SOURCE_UNREADABLE`；
//   读到 0 字节 → `SOURCE_EMPTY`；
//   `output.meta.source_sha256` 不是 64 位 hex → `SOURCE_SHA_MISSING`（**不猜**：
//   不拿本地重算值去顶替 converter 的声明——那样会把"converter 说的"和"我算的"
//   混成一个字段，复核时再也分不清是谁的数据）。
//
// 纯函数边界：只读文件字节（`node:fs`），不连库、不起子进程、不缓存。
import { readFileSync } from 'node:fs'

import type { EvidenceBlock, EvidenceLocator } from './locator.ts'

// ---------------------------------------------------------------------------
//  上下文类型
// ---------------------------------------------------------------------------

/**
 * 证据闸门上下文：一次转换的"可复核锚点"。
 *
 * 结构与 `locator.ts::EvidenceDocument` 同形（可直接传给 `verifyEvidence`），
 * 但语义上这里是"还没核验的声明"：`source_sha256` 来自 converter，
 * `source_bytes` 来自本地重读，两者相等与否由核验步骤裁决。
 */
export interface EvidenceGateContext {
  /** converter 声明的源文件字节 sha256。核验时独立重算比对。 */
  readonly source_sha256: string
  /** 本地重读的源文件原始字节。 */
  readonly source_bytes: Uint8Array
  /** converter 块流 → 可定位块（locator + 原文）。 */
  readonly blocks: readonly EvidenceBlock[]
}

/** 构造上下文的结果：要么拿到上下文，要么结构化拒绝（调用方 fail-closed）。 */
export type EvidenceContextResult =
  | { readonly ok: true; readonly context: EvidenceGateContext }
  | {
      readonly ok: false
      readonly reason_code: 'SOURCE_UNREADABLE' | 'SOURCE_SHA_MISSING' | 'SOURCE_EMPTY'
      readonly message: string
    }

// ---------------------------------------------------------------------------
//  运行期收窄
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** bbox：4 个有限数才算合格坐标（否则不是坐标，不能拿来做 PDF 定位）。 */
function asBbox(value: unknown): readonly [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  return [value[0] as number, value[1] as number, value[2] as number, value[3] as number]
}

// ---------------------------------------------------------------------------
//  location → locator 映射
// ---------------------------------------------------------------------------

/** 支持的格式提示；省略时按 location 里**实际存在**的字段分派。 */
export type ConverterFormat = 'pdf' | 'docx' | 'rtf' | 'text'

/**
 * 把 converter 块 `location` 映射成 D-110 定位器。
 *
 * 分派顺序（先具体后抽象；**字段真的存在才用，绝不补默认值**）：
 * 1. `part` + `table_id` + `row`（都是数字）→ `docx_part_table_row`；
 * 2. `part` + `paragraph` → `docx_part_paragraph`（`format='docx'` 时优先走这条：
 *    DOCX 的段落定位比"渲染后的 page+bbox"更贴原文结构）；
 * 3. `paragraph` 数字 → `rtf_paragraph`（`page` 数字则带上，作为附加约束）；
 *    **注意**：`format='docx'` 但缺 `part` 时**不**把 paragraph 当 DOCX 段落——
 *    part 是 DOCX 定位的一部分，缺了它就是没有定位，不能编一个部件名；
 *    此时若同时有合格 page+bbox 则走 PDF 定位，否则落到纯文本兜底。
 * 4. `line` + `offset` → `text_line_offset`；
 * 5. `page≥1` + bbox 四元组 → `pdf_page_bbox`（DOCX 经 MuPDF 读取时也走这条：
 *    读取器给出的是真实 page+bbox 坐标空间，如实标注，不冒充 part 定位）；
 * 6. 都没有 → `undefined`（由调用方决定兜底或不做证据）。
 *
 * @param location - converter 块里的 `location`（`unknown`，运行期来自 JSON）。
 * @param format - 媒体格式提示；省略时按字段分派。
 * @returns 定位器；没有任何可定位字段时返回 `undefined`。
 */
export function locatorFromConverterLocation(
  location: unknown,
  format?: ConverterFormat,
): EvidenceLocator | undefined {
  const loc = isRecord(location) ? location : {}
  const part = asNonEmptyString(loc.part)
  const paragraph = asInteger(loc.paragraph)
  const tableId = asInteger(loc.table_id)
  const row = asInteger(loc.row)
  const page = asInteger(loc.page)
  const line = asInteger(loc.line)
  const offset = asInteger(loc.offset)
  const bbox = asBbox(loc.bbox)

  // 1) DOCX 表格行：part + table_id + row。
  if (part !== undefined && tableId !== undefined && tableId >= 0 && row !== undefined && row >= 0) {
    return { kind: 'docx_part_table_row', part, table_id: tableId, row }
  }
  // 2) DOCX 段落：part + paragraph。
  if (part !== undefined && paragraph !== undefined && paragraph >= 0) {
    return { kind: 'docx_part_paragraph', part, paragraph }
  }
  // 3) RTF 段落：paragraph（无 part）。DOCX 缺 part 时不能伪造 DOCX 定位，跳过本支。
  if (paragraph !== undefined && paragraph >= 0 && format !== 'docx') {
    return page !== undefined && page >= 1
      ? { kind: 'rtf_paragraph', paragraph, page }
      : { kind: 'rtf_paragraph', paragraph }
  }
  // 4) 纯文本：line + offset。
  if (line !== undefined && line >= 1 && offset !== undefined && offset >= 0) {
    return { kind: 'text_line_offset', line, offset }
  }
  // 5) PDF 坐标：page≥1 + bbox 四元组。
  if (page !== undefined && page >= 1 && bbox !== undefined) {
    return { kind: 'pdf_page_bbox', page, bbox }
  }
  return undefined
}

/**
 * 映射 converter `blocks[]` 为证据块。
 *
 * 兜底规则（**容量边界，必须诚实说明**）：没有任何可定位字段的块 → `text_line_offset`
 * `{line: 块序号(1-based), offset: 0}`。这条兜底**不伪造坐标**：line 只是"converter
 * 块流里的第 N 块"（真实的顺序事实），不是源文件的字符偏移；它仍受"quote 在该块内逐字
 * 命中"约束，因此可复核性不降级为"任意位置"。若未来某格式连块顺序都不可信，
 * 应在读取器层拒绝，而不是在这里补坐标。
 *
 * @param blocks - converter 的 `blocks`（`unknown`，非数组按空处理）。
 * @param format - 媒体格式提示。
 * @returns 与输入等长、顺序一致的证据块（text 非字符串时记 `''`）。
 */
export function evidenceBlocksFromConverter(
  blocks: unknown,
  format?: ConverterFormat,
): EvidenceBlock[] {
  if (!Array.isArray(blocks)) return []
  return blocks.map((raw, index) => {
    const item = isRecord(raw) ? raw : {}
    const location = locatorFromConverterLocation(item.location, format)
    const locator: EvidenceLocator =
      location ??
      // 兜底：块序号 1-based 当"行号"。容量边界，不伪造源文件坐标。
      { kind: 'text_line_offset', line: index + 1, offset: 0 }
    const text = typeof item.text === 'string' ? item.text : ''
    return { locator, text }
  })
}

// ---------------------------------------------------------------------------
//  入口
// ---------------------------------------------------------------------------

/** 64 位十六进制 sha256（大小写都接受；输出统一小写）。 */
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/

/**
 * 从一次真实转换构造证据闸门上下文（**纯函数**：不连库、不起子进程、不 throw）。
 *
 * 执行顺序（顺序即语义，任一步失败即返回）：
 * 1. `readFileSync(realPath)` 读源文件字节；OSError → `SOURCE_UNREADABLE`；
 * 2. 字节长度 0 → `SOURCE_EMPTY`（空文件没有任何原文可核）；
 * 3. `output.meta.source_sha256` 必须是 64 位 hex 字符串；否则 `SOURCE_SHA_MISSING`
 *    （不猜、不用本地重算值顶替——否则分不清"converter 声明"与"本地实测"）；
 * 4. `output.blocks[]` 投影成 `{locator, text}`，无定位字段的块走 text_line_offset 兜底。
 *
 * @param realPath - 已通过 allowed_roots 校验的真实路径。
 * @param output - `runConverter()` 的输出（`unknown`：运行期来自 JSON，按结构收窄）。
 * @param format - 媒体格式提示（`'pdf' | 'docx' | 'rtf' | 'text'`）；影响 DOCX/RTF 的
 *   paragraph 分派（见 {@link locatorFromConverterLocation}）。
 * @returns `{ok:true, context}` 或结构化拒绝。
 */
export function evidenceContextFromConverter(
  realPath: string,
  output: unknown,
  format?: ConverterFormat,
): EvidenceContextResult {
  if (typeof realPath !== 'string' || realPath.trim() === '') {
    return {
      ok: false,
      reason_code: 'SOURCE_UNREADABLE',
      message: 'realPath must be a non-empty string',
    }
  }

  let sourceBytes: Uint8Array
  try {
    // 读原始字节：这是"独立重算 sha256"的锚点，不采信任何自报值。
    sourceBytes = readFileSync(realPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason_code: 'SOURCE_UNREADABLE',
      message: `cannot read source bytes${code === undefined ? '' : ` (${code})`}: ${reason}`,
    }
  }

  if (sourceBytes.length === 0) {
    return {
      ok: false,
      reason_code: 'SOURCE_EMPTY',
      message: 'source file is empty; there are no original bytes to verify against',
    }
  }

  const meta = isRecord(output) && isRecord(output.meta) ? output.meta : {}
  const declaredSha = meta.source_sha256
  if (typeof declaredSha !== 'string' || !SHA256_HEX_RE.test(declaredSha)) {
    return {
      ok: false,
      reason_code: 'SOURCE_SHA_MISSING',
      message:
        'converter output.meta.source_sha256 is missing or not a 64-hex digest; ' +
        'refusing to substitute a locally computed hash',
    }
  }

  const blocks = evidenceBlocksFromConverter(isRecord(output) ? output.blocks : undefined, format)
  return {
    ok: true,
    context: {
      source_sha256: declaredSha.toLowerCase(),
      source_bytes: sourceBytes,
      blocks,
    },
  }
}
