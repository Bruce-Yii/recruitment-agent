// 确定性序列化层（A 层）：转换器 blocks -> 模型可引用的行文本 + 可回查的 block_index。
//
// 这一层不调用任何模型、不联网、不读文件：输入是已经解析好的 converter JSON（或其 blocks），
// 输出只有字符串与索引。同样的输入必然得到同样的输出（无时间戳 / 无随机 / 不依赖 locale / 不排序）。
//
// 行格式（固定，不得改动）：
//   #12 | p1 | 工作经历
//   * id 从 1 开始连续编号，一个 block 一行；
//   * 块内换行写成 ⏎，保证「一行一块」；
//   * 超过 MAX_BLOCK_CHARS 的块按句子 / 换行边界切成多行，各占一个 id，
//     block_index 里用 parent_id 指回该块的首段（同一块的 parent_id 全部相同）；
//   * 任何 block 都不丢弃：空块也保留 id，并在 block_index 里标 empty=true。
//
// 为什么把 sha256 打在文本上：校验层要能证明「模型引用的这个 id 对应的原文」与序列化时
// 交给模型的是同一份。文件级 sha256（converter meta.source_sha256）另存为
// block_index.source_sha256，用于回溯原件（doc 11 §9.9 的 page + bbox + 原件 SHA256）。
//
// 依赖：只用 node:crypto（Node 内置，无第三方依赖），不做任何 I/O。

import { createHash } from 'node:crypto'

/** 单块最大字数（按码点计）；超过即切分。 */
export const MAX_BLOCK_CHARS = 500
/** 切分时允许的最短片段（按码点计），避免切出没有意义的碎句。 */
export const MIN_PIECE_CHARS = 64
/** 块内换行在行文本里的转义符。 */
export const NEWLINE_ESCAPE = '⏎'
/** block_index 结构版本；形状变化时递增，校验层据此拒绝不认识的索引。 */
export const BLOCK_INDEX_VERSION = 1

/** 转换器 block 的最小结构子集（见 converter/README.md 的输出契约）。 */
export interface SourceBlock {
  readonly kind?: string
  readonly text?: string
  readonly location?: { readonly page?: number; readonly bbox?: readonly number[] }
  readonly provenance?: string
}

/** 转换器顶层输出里本层用到的字段。 */
export interface ConverterDocument {
  readonly blocks?: readonly SourceBlock[]
  readonly meta?: { readonly source_sha256?: string }
}

/** 序列化输入：整份转换器输出，或直接的 blocks 数组。 */
export type SerializeInput = ConverterDocument | readonly SourceBlock[]

/** 一个 id 的索引项：模型引用的 id 只能解析到这里给出的证据。 */
export interface BlockIndexEntry {
  /** 行文本里的 id，从 1 开始连续。 */
  readonly id: number
  /** 该行来自第几个原始 block（1 基，等于 converter blocks 数组下标 + 1）。 */
  readonly block_no: number
  /** 页号；拿不到就是 null（行文本写 p?，不编造页号）。 */
  readonly page: number | null
  /** 四元 bbox；拿不到就是 null。 */
  readonly bbox: readonly [number, number, number, number] | null
  /** 该行文本的 sha256（UTF-8，原样，不做归一化）。 */
  readonly sha256: string
  /** 原件 PDF 的 sha256；转换器没给就是 null。 */
  readonly source_sha256: string | null
  /** 该行文本的码点数。 */
  readonly chars: number
  /** converter 给的块类型（heading / paragraph / link / ...），缺失记 'unknown'。 */
  readonly kind: string
  /** converter 给的来源标签（native_text / ocr_title / agent_read），缺失记 'unknown'。 */
  readonly provenance: string
  /** 该块文本（去首尾空白后）为空。空块也占一个 id，不丢弃。 */
  readonly empty: boolean
  /** 切分时该块首段的 id；未切分为 null。同一块的所有片段 parent_id 相同。 */
  readonly parent_id: number | null
  /** 片段序号（0 基）；未切分为 0。 */
  readonly piece_index: number
  /** 该块被切成的片段数；未切分为 1。 */
  readonly piece_count: number
  /** 片段在父块文本里的起始码点偏移（含）；未切分为 0。 */
  readonly piece_start: number
  /** 片段在父块文本里的结束码点偏移（不含）；未切分为全文长度。 */
  readonly piece_end: number
}

/** 序列化产出的索引：id -> page / bbox / sha256 等证据。 */
export interface BlockIndex {
  readonly version: number
  readonly max_block_chars: number
  /** 原件 sha256（转换器 meta.source_sha256）；缺失为 null。 */
  readonly source_sha256: string | null
  /** 原始 block 数（未切分前）。 */
  readonly blocks: number
  /** 按 id 升序排列的索引项；条数 == 行数。 */
  readonly entries: readonly BlockIndexEntry[]
}

/** 序列化统计（给验收报告用，不参与判定）。 */
export interface SerializeStats {
  /** 原始 block 数。 */
  readonly blocks: number
  /** 行数（= 索引条数；切分后可能多于 block 数）。 */
  readonly lines: number
  /** 被切分的 block 数。 */
  readonly split_blocks: number
  /** 空块数。 */
  readonly empty_blocks: number
  /** 全部行文本的码点总数（切分不丢字符，故等于全部 block 文本码点数之和）。 */
  readonly chars: number
  /** 被转义掉的换行数。 */
  readonly escaped_newlines: number
}

/** 序列化结果。 */
export interface SerializedDocument {
  /** 模型看到的完整行文本（行之间用 \n 连接，行内不含换行）。 */
  readonly text: string
  /** 逐行文本（与 block_index.entries 下标一一对应）。 */
  readonly lines: readonly string[]
  /** id -> page / bbox / sha256。 */
  readonly blockIndex: BlockIndex
  readonly stats: SerializeStats
}

/** 按码点切出的一片文本；start/end 是父文本里的码点偏移，片段是精确切片（不丢字符）。 */
export interface TextPiece {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** 行尾可切分的字符：换行与中英文句末标点。 */
const CJK_BOUNDARY = new Set(['。', '！', '？', '；', '…'])
/** 英文句末标点：只有后面跟空白（或文本结束）时才算句子边界，避免切开 "3.5"。 */
const LATIN_BOUNDARY = new Set(['.', '!', '?', ';'])
/** 空白判定（英文句末标点后必须跟空白才算边界）。 */
const WHITESPACE = /\s/

/** 字符串 -> 码点数组（emoji 等代理对不会被切成半个）。 */
export function toCodePoints(text: string): string[] {
  return Array.from(text)
}

/** 计算文本的 sha256（UTF-8，原样）。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 把块内换行转义成 ⏎，保证「一行一块」。 */
export function escapeNewlines(text: string): string {
  return text.replace(/\r\n|\r|\n/g, NEWLINE_ESCAPE)
}

/** 统计文本里的换行数（与 escapeNewlines 用同一套匹配）。 */
export function countNewlines(text: string): number {
  const matches = text.match(/\r\n|\r|\n/g)
  return matches === null ? 0 : matches.length
}

/** 切点 i 是否合法：i 表示「片段到 i-1 为止」，即片段以句末标点或换行结尾。 */
function isCutAfter(cp: readonly string[], i: number): boolean {
  const last = cp[i - 1]
  if (last === undefined) return false
  if (last === '\n' || last === '\r') return true
  if (CJK_BOUNDARY.has(last)) return true
  if (LATIN_BOUNDARY.has(last)) {
    const next = cp[i]
    return next === undefined || WHITESPACE.test(next)
  }
  return false
}

/**
 * 按句子 / 换行边界把超长文本切成若干片。
 * 不变量：全部片段按顺序拼接 == 原文（不丢字符、不补字符），每片码点数 <= MAX_BLOCK_CHARS。
 * @param text - 原始块文本。
 * @returns 精确切片；长度不超过 MAX_BLOCK_CHARS 时返回单元素数组。
 */
export function splitBlockText(text: string): TextPiece[] {
  const cp = toCodePoints(text)
  if (cp.length <= MAX_BLOCK_CHARS) return [{ start: 0, end: cp.length, text }]
  const pieces: TextPiece[] = []
  let start = 0
  while (cp.length - start > MAX_BLOCK_CHARS) {
    const limit = start + MAX_BLOCK_CHARS
    let cut = -1
    // 从限长处往回找最近的合法切点；找不到就硬切在限长处（仍然一行一块，不丢字）。
    for (let i = limit; i > start + MIN_PIECE_CHARS; i -= 1) {
      if (isCutAfter(cp, i)) {
        cut = i
        break
      }
    }
    if (cut < 0) cut = limit
    pieces.push({ start, end: cut, text: cp.slice(start, cut).join('') })
    start = cut
  }
  pieces.push({ start, end: cp.length, text: cp.slice(start).join('') })
  return pieces
}

/** 组装一行：`#id | p{page} | {text}`。页号拿不到写 p?（不编造）。 */
export function formatBlockLine(id: number, page: number | null, text: string): string {
  return '#'.concat(String(id), ' | p', page === null ? '?' : String(page), ' | ', escapeNewlines(text))
}

/** 页号归一：正整数才算数，其余记 null。 */
function normalizePage(page: unknown): number | null {
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : null
}

/** bbox 归一：必须正好 4 个有限数，否则记 null（不编造坐标）。 */
function normalizeBbox(bbox: unknown): readonly [number, number, number, number] | null {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null
  const values: number[] = []
  for (const value of bbox) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    values.push(value)
  }
  const [x0, y0, x1, y1] = values
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return null
  return [x0, y0, x1, y1]
}

/** 把两种输入形状归一成 blocks + 原件 sha256。 */
function normalizeInput(input: SerializeInput): {
  blocks: readonly SourceBlock[]
  sourceSha256: string | null
} {
  if (Array.isArray(input)) {
    return { blocks: input as readonly SourceBlock[], sourceSha256: null }
  }
  const document = input as ConverterDocument
  const blocks = Array.isArray(document.blocks) ? document.blocks : []
  const sha = document.meta === undefined ? undefined : document.meta.source_sha256
  const sourceSha256 = typeof sha === 'string' && sha.trim() !== '' ? sha : null
  return { blocks, sourceSha256 }
}

/**
 * 把转换器输出序列化成「带 id 的行文本 + block_index」。
 * 纯函数：不读文件、不写文件、不调用模型、不取当前时间。
 * @param input - 转换器 JSON（取 blocks）或其 blocks 数组。
 * @returns 行文本、逐行数组、block_index、统计。
 */
export function serialize(input: SerializeInput): SerializedDocument {
  const { blocks, sourceSha256 } = normalizeInput(input)
  const entries: BlockIndexEntry[] = []
  const lines: string[] = []
  let splitBlocks = 0
  let emptyBlocks = 0
  let escapedNewlines = 0
  let chars = 0
  let nextId = 1

  for (let offset = 0; offset < blocks.length; offset += 1) {
    const block = blocks[offset] ?? undefined
    const text = block !== undefined && typeof block.text === 'string' ? block.text : ''
    const page = normalizePage(block === undefined || block.location === undefined ? undefined : block.location.page)
    const bbox = normalizeBbox(block === undefined || block.location === undefined ? undefined : block.location.bbox)
    const kind = block !== undefined && typeof block.kind === 'string' && block.kind !== '' ? block.kind : 'unknown'
    const provenance =
      block !== undefined && typeof block.provenance === 'string' && block.provenance !== ''
        ? block.provenance
        : 'unknown'
    const pieces = splitBlockText(text)
    const empty = text.trim() === ''
    const blockNo = offset + 1
    const firstId = nextId
    if (pieces.length > 1) splitBlocks += 1
    if (empty) emptyBlocks += 1

    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex]
      if (piece === undefined) continue
      const id = nextId
      nextId += 1
      const pieceChars = toCodePoints(piece.text).length
      chars += pieceChars
      escapedNewlines += countNewlines(piece.text)
      entries.push({
        id,
        block_no: blockNo,
        page,
        bbox,
        sha256: sha256Hex(piece.text),
        source_sha256: sourceSha256,
        chars: pieceChars,
        kind,
        provenance,
        empty,
        parent_id: pieces.length > 1 ? firstId : null,
        piece_index: pieceIndex,
        piece_count: pieces.length,
        piece_start: piece.start,
        piece_end: piece.end,
      })
      lines.push(formatBlockLine(id, page, piece.text))
    }
  }

  return {
    text: lines.join('\n'),
    lines,
    blockIndex: {
      version: BLOCK_INDEX_VERSION,
      max_block_chars: MAX_BLOCK_CHARS,
      source_sha256: sourceSha256,
      blocks: blocks.length,
      entries,
    },
    stats: {
      blocks: blocks.length,
      lines: lines.length,
      split_blocks: splitBlocks,
      empty_blocks: emptyBlocks,
      chars,
      escaped_newlines: escapedNewlines,
    },
  }
}

/** 按 id 取索引项；不存在返回 undefined（校验层据此报未知 id）。 */
export function indexEntryById(index: BlockIndex, id: unknown): BlockIndexEntry | undefined {
  if (typeof id !== 'number' || !Number.isInteger(id)) return undefined
  for (const entry of index.entries) {
    if (entry.id === id) return entry
  }
  return undefined
}
