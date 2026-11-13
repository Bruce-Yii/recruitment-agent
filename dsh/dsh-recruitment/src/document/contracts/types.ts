// 统一文档内容契约（docs/19 §2.1 的 TS 落地）。
//
// 定位：这是**只读文档读取层**的 canonical schema，不是业务身份。
//   * 一个 DocumentContent 只描述「一份原件被读成了什么」+「证据指向原件哪里」；
//   * 它不产生 Candidate / Application / ResumeVersion —— 文档版本 ≠ 业务版本
//     （docs/19 §2.1 约束：路径不能当业务身份，结构化引用只能指回 block 与原件 SHA）。
//
// 这个 schema 是对现有 converter 输出（blocks / location / links / completeness /
// issues）的**增量统一**，不是替换：`block.location` 的 page+bbox 原样搬进
// `EvidenceLocator(kind:"pdf")`，而 DOCX / 图片各有自己的定位形状，
// **不要求**它们伪造 page+bbox（docs/19 §2.1 约束）。
//
// 类型只描述形状；是否可信由 `validate.ts` 的机械校验器判定，判不过不得进入下游。

/** 契约版本。任何不兼容改动都要换版本号，校验器只认 `SUPPORTED_SCHEMA_VERSIONS`。 */
export const DOCUMENT_CONTENT_SCHEMA_VERSION = '1.0.0'

/** 校验器接受的版本集合（新版本必须显式登记，不猜）。 */
export const SUPPORTED_SCHEMA_VERSIONS = ['1.0.0'] as const

/** 允许的媒体类型（封闭集合；与 docs/19 §2.1 的 `Media` 逐字一致）。 */
export const MEDIA_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
] as const

/** 媒体类型。 */
export type MediaType = (typeof MEDIA_TYPES)[number]

/** 文档块的类型（封闭集合；读不出类型就写 `other`，不猜）。 */
export const BLOCK_KINDS = ['heading', 'paragraph', 'list', 'table', 'link', 'other'] as const

/** 块类型。 */
export type BlockKind = (typeof BLOCK_KINDS)[number]

/**
 * 块文字的来源（封闭集合）。**证伪红线**：OCR / 模型读出的文字只能是 `ocr` /
 * `agent_read`，绝不能标成 `native_text`；`human_confirmed` 只用于人工闸门产出的、
 * 另生成一条可审计结果的文字（docs/19 §2.2.5 可恢复的人工动作）。
 */
export const PROVENANCES = ['native_text', 'docling', 'ocr', 'agent_read', 'human_confirmed'] as const

/** 文字来源。 */
export type Provenance = (typeof PROVENANCES)[number]

/** 整体完整度三态。`partial` / `unverified` 绝不能被下游当 `complete`。 */
export const COMPLETENESS_STATES = ['complete', 'partial', 'unverified'] as const

/** 完整度。 */
export type Completeness = (typeof COMPLETENESS_STATES)[number]

/** issue 严重度（大写，与 docs/19 §2.1 一致；小写会被判非法）。 */
export const ISSUE_SEVERITIES = ['HARD', 'SOFT'] as const

/** issue 严重度。 */
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number]

/**
 * issue 的可执行动作（封闭集合）。`none` = 只记录，不需要动作；
 * 其余四个必须能被调度方直接执行（docs/19 §2.2.6 的可恢复动作）。
 */
export const SUGGESTED_ACTIONS = ['retry', 'switch_reader', 'vision_read', 'human_review', 'none'] as const

/** 建议动作。 */
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number]

/** 定位框 `[x0, y0, x1, y1]`（PDF 用户空间坐标；原样来自读取器，不换算）。 */
export type BBox = readonly [number, number, number, number]

/**
 * 「读取器没给页码」的哨兵值。
 *
 * 为什么需要：`DocumentBlock.locator` 在契约里是**必填**的。若读取器没报页码，
 * 映射层不能编一个真实页码（那是伪造证据），于是写 `page: 0`；校验器把
 * `page < 1` 判为 `LOCATOR_INVALID`，所以带哨兵的 content **一定过不了校验**，
 * 不会静默流入下游。任何真实页码都 ≥ 1。
 */
export const LOCATOR_PAGE_UNKNOWN = 0

/** PDF 定位：页码必填，bbox 只有读取器真的给了才写（不编造）。 */
export interface PdfLocator {
  readonly kind: 'pdf'
  /** 1-based 页码。 */
  readonly page: number
  readonly bbox?: BBox
  /** 读取器自己的块号（原样保留，便于回查读取器输出）。 */
  readonly block_id?: string
}

/** DOCX 定位：指向 OOXML 部件 + 段落/表格单元格，没有 page+bbox 也合法。 */
export interface DocxLocator {
  readonly kind: 'docx'
  /** 部件名，如 `word/document.xml`。 */
  readonly part: string
  readonly paragraph_id?: string
  readonly table_id?: string
  /** 0-based 行号；出现 row/cell 必须同时有 table_id。 */
  readonly row?: number
  /** 0-based 单元格号；出现 row/cell 必须同时有 table_id。 */
  readonly cell?: number
}

/** 图片定位：帧号（多帧图源）和/或区域。纯图片可以只有一个 frame，甚至只有 kind。 */
export interface ImageLocator {
  readonly kind: 'image'
  readonly frame?: number
  readonly bbox?: BBox
}

/** 证据定位（可指回原件的最小信息）。 */
export type EvidenceLocator = PdfLocator | DocxLocator | ImageLocator

/** 定位方式。 */
export type LocatorKind = EvidenceLocator['kind']

/** 块里的链接。`locator` 可选：链接本身常常没有独立 bbox。 */
export interface DocumentLink {
  readonly text: string
  readonly href: string
  readonly locator?: EvidenceLocator
}

/** 一个内容块。 */
export interface DocumentBlock {
  /** 文档内唯一。下游结构化只能引用这个 id，不能引用数组下标。 */
  readonly block_id: string
  readonly kind: BlockKind
  /** 原文（读取器给出的逐字文本；校验层不改写）。 */
  readonly text: string
  /** 阅读顺序（0-based；同一份 content 内唯一且严格递增）。 */
  readonly order: number
  readonly locator: EvidenceLocator
  readonly links?: readonly DocumentLink[]
  readonly provenance: Provenance
}

/** 一条读取问题。 */
export interface DocumentIssue {
  /** 稳定 code（由读取器/质量 Gate 定义；未知 code 一律按 HARD 处理）。 */
  readonly code: string
  readonly message: string
  readonly locator?: EvidenceLocator
  readonly severity: IssueSeverity
  /** 同一个读取器重试一次是否可能变好。 */
  readonly retryable: boolean
  readonly suggested_action: SuggestedAction
}

/** 统一文档内容。 */
export interface DocumentContent {
  readonly schema_version: string
  /** 原件 SHA-256（小写 64 位 hex）；结构化引用必须能指回它。 */
  readonly asset_sha256: string
  readonly media_type: MediaType
  readonly reader_id: string
  readonly reader_version: string
  /** 读取器档位（如 PDF 的 layout 后端）；没有就省略。 */
  readonly reader_profile?: string
  /** 全篇文本（读取器给的拼接文本；不重新归一化）。 */
  readonly text: string
  readonly blocks: readonly DocumentBlock[]
  readonly completeness: Completeness
  /** 还有未被读懂的视觉内容（必须由质量 Gate 处理，不等于失败、更不等于完整）。 */
  readonly needs_visual: boolean
  readonly issues: readonly DocumentIssue[]
  /** 读取耗时；`0` = 读取器没报（运行字段，不参与同一文件两次结果的一致性比较）。 */
  readonly elapsed_ms: number
}

/** 文档内容的顶层键（封闭集合；多一个键即违约）。 */
export const DOCUMENT_CONTENT_KEYS = [
  'schema_version',
  'asset_sha256',
  'media_type',
  'reader_id',
  'reader_version',
  'reader_profile',
  'text',
  'blocks',
  'completeness',
  'needs_visual',
  'issues',
  'elapsed_ms',
] as const

/** 块的键（封闭集合）。 */
export const DOCUMENT_BLOCK_KEYS = ['block_id', 'kind', 'text', 'order', 'locator', 'links', 'provenance'] as const

/** 链接的键（封闭集合）。 */
export const DOCUMENT_LINK_KEYS = ['text', 'href', 'locator'] as const

/** issue 的键（封闭集合）。 */
export const DOCUMENT_ISSUE_KEYS = ['code', 'message', 'locator', 'severity', 'retryable', 'suggested_action'] as const

/** PDF locator 的键（封闭集合）。 */
export const PDF_LOCATOR_KEYS = ['kind', 'page', 'bbox', 'block_id'] as const

/** DOCX locator 的键（封闭集合）。 */
export const DOCX_LOCATOR_KEYS = ['kind', 'part', 'paragraph_id', 'table_id', 'row', 'cell'] as const

/** 图片 locator 的键（封闭集合）。 */
export const IMAGE_LOCATOR_KEYS = ['kind', 'frame', 'bbox'] as const
