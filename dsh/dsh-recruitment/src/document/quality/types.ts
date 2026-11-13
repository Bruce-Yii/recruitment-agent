// U2 质量层类型。形状按 docs/19 §2.1「统一内容的最小类型」写。
//
// 为什么在本地声明而不 import：U0 的 `src/document/contracts/**` 尚未落地。
// 本层只读字段、不依赖类型身份，U0 落地后把下面的 DocumentContentLike /
// RawBlock / RawIssue 换成 `import type` 即可，判定逻辑不用改。
//
// 设计约束（来自 docs/19 §2.2 与 docs/11）：
//   * 阅读器给的 issue 不能被当成「解释」，只能被当成「证据」——本层重新映射 severity。
//   * 上游说 SOFT、表里写 HARD 时取 HARD（不得降级），反过来可以升级。
//   * 任何「不知道」都按未核实处理，不得默认 complete。

/** docs/19 §2.1 的 Media 闭集；另接受字符串，未知媒体由判定器报错而不是崩。 */
export type MediaType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'image/png'
  | 'image/jpeg'

/** docs/19 §2.1 的 provenance 闭集。 */
export type Provenance = 'native_text' | 'docling' | 'ocr' | 'agent_read' | 'human_confirmed'

export type Completeness = 'complete' | 'partial' | 'unverified'

/** docs/19 §2.1 的封闭枚举：issue 严重度。 */
export type IssueSeverity = 'HARD' | 'SOFT'

/** docs/19 §2.1 的封闭枚举：建议动作。 */
export type SuggestedAction = 'retry' | 'switch_reader' | 'vision_read' | 'human_review' | 'none'

/** 原始定位：PDF 页 + bbox / DOCX 部件 / 图像帧。 */
export type EvidenceLocator =
  | { kind: 'pdf', page: number, bbox?: [number, number, number, number], block_id?: string }
  | {
    kind: 'docx',
    part: string,
    paragraph_id?: string,
    table_id?: string,
    row?: number,
    cell?: number
  }
  | { kind: 'image', frame?: number, bbox?: [number, number, number, number] }

/** 归属置信度。**只有 `same_row` 允许下游把「主体/公司」与「时间」当成同一行的事实**。 */
export type AttributionConfidence = 'same_row' | 'adjacent' | 'unresolved'

/**
 * 归属证据的种类：回答「凭什么给出这个 confidence」。
 *
 * * `org_in_row`      —— 该块自己就含组织文本（最强：连相邻性都不用判断）；
 * * `self_subject`    —— 该块除时间/职务词外还有实质主体文本（奖项行、项目行、`公司名 时间 职位` 同一块），
 *                        即主体与时间**在同一个块内闭合**，不需要跨块拼装；
 * * `same_row_anchor` —— 同页同一可视行的**另一个**块含组织/职务文本（复用了 `sameVisualRow` 的判据）；
 * * `adjacent_anchor` —— 同页紧邻的上一/下一可视行含组织文本。**位置相邻 ≠ 可以拼**，只标待核；
 * * `no_anchor`       —— 同页找不到任何可用作主体的文本（此时不存在「跨块拼装」的风险对象）。
 */
export type AttributionBasis =
  | 'org_in_row'
  | 'self_subject'
  | 'same_row_anchor'
  | 'adjacent_anchor'
  | 'no_anchor'

/**
 * 一条经历行的**归属结果**（不是问题清单，是答案）。
 *
 * 为什么需要：`doc_cross_block_attribution` 原来只说「公司/时间分属不同块」，不回答「这条经历属于哪个块」。
 * 下游拿到 `unresolved` 以外的结果才有东西可用（见 `AssessmentIssue.detail.attribution`）。
 */
export interface ExperienceAttribution {
  /** 含时间区间的行所属块。 */
  readonly row_block_id: string
  /** 归属到的块；`unresolved` 时为 null。`org_in_row` / `self_subject` 时就是行自己。 */
  readonly org_block_id: string | null
  readonly confidence: AttributionConfidence
  /** 为什么是这个 confidence（见 `AttributionBasis`）。 */
  readonly basis: AttributionBasis
  /** 归属涉及的原文定位（行本身 + 归属到的块）；`unresolved` 时给出「看过的候选」的定位。 */
  readonly evidence: ReadonlyArray<EvidenceLocator>
  /** 行所属页（没有页定位为 null）。 */
  readonly page: number | null
  /** 承载归属的主体文本（`unresolved` 为 null）。不是「公司名猜测」，是被当作主体的原文片段。 */
  readonly org_text: string | null
  /** 本行归属时考虑过的主体候选块（`unresolved` 时是被判「不可拼」的那些）。顺序稳定。 */
  readonly candidate_block_ids: ReadonlyArray<string>
}

/** 上游 issue（转换器 `{code,message,location}` 与 docs/19 `{code,message,locator,...}` 都接受）。 */
export interface RawIssue {
  readonly code?: unknown
  readonly message?: unknown
  readonly severity?: unknown
  readonly retryable?: unknown
  readonly suggested_action?: unknown
  readonly locator?: unknown
  /** 转换器用 `location`，不是 `locator`。 */
  readonly location?: unknown
}

/** 上游 block（转换器 `{kind,text,location,links,provenance}` 与 docs/19 形状都接受）。 */
export interface RawBlock {
  readonly block_id?: unknown
  readonly kind?: unknown
  readonly text?: unknown
  readonly order?: unknown
  readonly locator?: unknown
  readonly location?: unknown
  readonly links?: unknown
  readonly provenance?: unknown
}

/** 上游链接。 */
export interface RawLink {
  readonly text?: unknown
  readonly href?: unknown
  readonly locator?: unknown
  readonly location?: unknown
}

/**
 * 统一内容（宽输入）。docs/19 §2.1 的字段全部可选地存在于这里，另外接受
 * 转换器真实输出的 `meta.page_info` / `meta.order_verified` / 顶层 `links`。
 *
 * 额外两个「证据 oracle」字段是本层的扩展（U0 落地时请并入匿名契约）：
 *   * `source_chars`：原生文本的非空白字符数，用于 A2 字符保真比对；
 *   * `native_links`：阅读器从原件拿到的真实 URI 集合，用于 A5 丢失/凭空生成比对。
 * 没有 oracle 时本层不猜：`uri_verified=false`、字符比对退回「正文 == 块文本」。
 */
export interface DocumentContentLike {
  readonly schema_version?: unknown
  readonly asset_sha256?: unknown
  readonly media_type?: unknown
  readonly reader_id?: unknown
  readonly reader_version?: unknown
  readonly reader_profile?: unknown
  readonly text?: unknown
  readonly blocks?: unknown
  readonly completeness?: unknown
  readonly needs_visual?: unknown
  readonly issues?: unknown
  readonly links?: unknown
  readonly page_count?: unknown
  readonly source_chars?: unknown
  readonly native_links?: unknown
  readonly order_verified?: unknown
  readonly meta?: unknown
}

/** 归一化后的块（本层内部使用；不含上游可信度假设）。 */
export interface NormalizedBlock {
  readonly block_id: string
  readonly kind: string
  readonly text: string
  readonly order: number
  /** `explicit` = 上游给了 order；`position` = 本层按数组下标补的（不算已核顺序）。 */
  readonly order_source: 'explicit' | 'position'
  readonly locator: EvidenceLocator | null
  readonly provenance: string
  readonly provenance_known: boolean
  readonly links: ReadonlyArray<{ text: string, href: string }>
  /** 正文里出现的坏字形/不可读标记数量（docs/11 A6）。 */
  readonly unreadable_markers: number
}

/** `meta.page_info` 的一页（转换器真实结构，只取判定要用的字段）。 */
export interface NormalizedPageInfo {
  readonly page: number
  readonly chars: number | null
  readonly block_count: number | null
  readonly readable: boolean | null
}

/** 归一化结果。`contract_problems` 非空 = 输入不合法，一律 fail-closed。 */
export interface NormalizedContent {
  readonly present: boolean
  readonly media_type: string
  readonly reader_id: string
  readonly text: string
  readonly blocks: ReadonlyArray<NormalizedBlock>
  readonly issues: ReadonlyArray<RawIssue>
  readonly completeness: Completeness
  readonly needs_visual: boolean
  readonly page_count: number | null
  readonly page_info: ReadonlyArray<NormalizedPageInfo>
  /** 只有上游**明确声明** true 才算已核；缺省/false 都是未核。 */
  readonly order_verified: boolean
  readonly order_asserted: boolean
  /**
   * 版面后端名（转换器 meta.layout_backend）。null = 没有按几何排序。
   *
   * 为什么需要：转换器 `order_verified = bool(layout) and all(layout_order_applied)`，
   * 也就是说 **没有版面后端时 order_verified 恒为 false**。把 false 一律当「顺序不可靠」
   * 会把每一份原生文字 PDF 都阻断（已用 U1 真实输出复现）。所以判据是：
   *   * order_verified=false 且 layout_backend≠null → 版面试过但没排成 → 不可信；
   *   * order_verified=false 且 layout_backend=null → 只是「没按几何排」，按
   *     docs/11 A4 依赖转换器自己发出的 `pdf_reading_order_unverified`。
   */
  readonly layout_backend: string | null
  /** 原生字符数 oracle（没有就 null）。 */
  readonly source_chars: number | null
  /** 原生 URI oracle（没有就 null）。 */
  readonly native_uris: ReadonlyArray<string> | null
  readonly output_uris: ReadonlyArray<string>
  readonly contract_problems: ReadonlyArray<string>
}

/** 判定后的一条 issue：每个字段都是下游可直接消费的封闭值。 */
export interface AssessmentIssue {
  readonly code: string
  readonly message: string
  readonly locator: EvidenceLocator | null
  /** 同一问题涉及多个区块时给出全部定位（docs/19 §2.2.6 的「原文定位」）。 */
  readonly locators: ReadonlyArray<EvidenceLocator>
  readonly severity: IssueSeverity
  readonly retryable: boolean
  readonly suggested_action: SuggestedAction
  /** 是否在稳定表里登记过。false = 未登记 code，已按 HARD 兜住。 */
  readonly registered: boolean
  readonly origin: 'converter' | 'document' | 'unregistered'
  readonly family: string
  /**
   * 结构化细节（供下游**程序**消费，不是给人看的措辞）。
   *
   * 目前只有归属类 issue 使用：`{ attribution: { row_block_id, org_block_id, confidence, basis,
   * may_join_same_row, needs_human_check, candidate_block_ids } }`。
   * 语义约束：`may_join_same_row === true` 才允许把主体与时间当同一行；`needs_human_check === true`
   * 表示位置相邻但**不许拼**，必须人工核对。没有细节时为 null（不伪装成空对象）。
   */
  readonly detail: Readonly<Record<string, unknown>> | null
}

/** 建议动作的聚合（一条动作可能由多个 code 共同要求）。 */
export interface AssessmentAction {
  readonly action: SuggestedAction
  readonly codes: ReadonlyArray<string>
  readonly blocking: boolean
}

/** `assess()` 的返回值。 */
export interface Assessment {
  /** 只降不升：min(上游 completeness, 本层推导)。 */
  readonly completeness: Completeness
  /** 有 HARD（含未登记 code）即为 true；下游据此拒绝进入可信结构化/S7。 */
  readonly blocking: boolean
  /**
   * **仅版式阻断**：`blocking=true` 且**全部** HARD 都属于版式类（顺序 / 跨块归属 / 未核图片）。
   *
   * 用途（D-97 第一批）：把「文字可用、只是版面事实未核」与「文字本身不可用」分开。
   *   * `layout_only_blocking=true` → 版式/顺序/图片问题，文字本身可读；
   *     结构化路径由 `document_read.assessment.blocking_for_structure` 放行，可信筛选（S7）仍要等。
   *   * `layout_only_blocking=false` 且 `blocking=true` → 至少有一条「文字不可用」类 HARD
   *     （空文件 / 乱码 / 编码读不出 / 页或块缺失 / 字符保真失败 / 来源未核 …），连结构化的文字都不该信。
   * `blocking=false` 时恒为 false（没有阻断就谈不上「仅版式阻断」）。判据见 `LAYOUT_ONLY_ISSUE_CODES`。
   */
  readonly layout_only_blocking: boolean
  readonly actions: ReadonlyArray<AssessmentAction>
  readonly issues: ReadonlyArray<AssessmentIssue>
  readonly blocking_codes: ReadonlyArray<string>
  readonly soft_codes: ReadonlyArray<string>
  /** 未登记的 code 原样保留，便于工程侧补表，不允许被静默丢弃。 */
  readonly unregistered_codes: ReadonlyArray<string>
  readonly facts: AssessmentFacts
}

export interface AssessmentFacts {
  readonly media_type: string
  readonly reader_id: string
  readonly block_count: number
  readonly page_count: number | null
  readonly order_verified: boolean
  /** URI 是否做过原件对照（没有 oracle 就是 false，不是「没问题」）。 */
  readonly uri_verified: boolean
  /** 坏字形标记总数（docs/11 A6）。 */
  readonly unreadable_markers: number
  /** 来自 OCR / agent_read 的块数（模型生成的文字 = 待核证据）。 */
  readonly model_text_blocks: number
  /** provenance 缺失或不在闭集内的块数。 */
  readonly unknown_provenance_blocks: number
  readonly needs_visual: boolean
  /** 上游声明的 completeness（只用于核对是否被升级）。 */
  readonly declared_completeness: Completeness
}

/** 下游可消费的证据状态。 */
export type EvidenceState = 'verified' | 'unverified' | 'unreadable'

/** 字段结论。`unreadable` 是独立状态，绝不与 `absent` 合并。 */
export type FieldPresence = 'present' | 'absent' | 'unreadable'

/**
 * 读取器事实（第二输入，可选）。
 *
 * 为什么需要：U0 的 canonical `DocumentContent` 是封闭契约，**不含**
 * `page_count` / `order_verified` / 原生 URI 清单（它们被明确列为「不携带的
 * converter meta」）。没有这些事实就无法核对 docs/11 的 A1（页覆盖）与 A4（顺序）：
 *   * U1 的 PDF 读取器把完整 converter meta 放在 `content.meta` 里 → 本层能读到；
 *   * 若调用方走的是「丢掉 meta」的映射，就必须把这些事实显式传进来，
 *     否则一律判 `doc_page_count_unverified` / `doc_reading_order_unverified`（HARD）。
 *
 * 这里不接受「大概是这样」：facts 只允许来自读取器自己的声明/原件比对。
 */
export interface ReaderFacts {
  /** 原件页数（分页媒体的 A1 前提）。 */
  readonly page_count?: number
  /** 读取器对阅读顺序的声明；只有 true 才算几何已核。 */
  readonly order_verified?: boolean
  /** 版面后端名（无后端为 null/省略）。顺序判据需要它区分「没按几何排」与「排失败」。 */
  readonly layout_backend?: string | null
  /** 原生文本非空白字符数（A2 oracle）。 */
  readonly source_chars?: number
  /** 原件真实 URI 清单（A5 oracle）。 */
  readonly native_links?: ReadonlyArray<string>
  /** 逐页诊断（转换器 meta.page_info）；有它也能推出页数。 */
  readonly page_info?: ReadonlyArray<{
    readonly page: number
    readonly chars?: number | null
    readonly block_count?: number | null
    readonly readable?: boolean | null
  }>
}
