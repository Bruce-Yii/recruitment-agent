// 材料层（S6 写入 / S7 读取共用）：
//   * issue 严重度的唯一口径（逐字抄自 `converter/src/issues.py`）
//   * `parse_status` 的映射（converter `completeness` + 是否有 HARD issue）
//   * `parsed_fields` 的**白名单投影**（`screening-rules.md` §2.2：不读 protected）
//
// 为什么严重度表要复制一份：S6 落库时要决定 `parse_status`，S7 判 `absent` 是否可信时
// 要再算一次 `hard_issue_count`（`screening-rules.md` §3.3 要求筛选"自己也要兜一层"，
// 不能依赖上游一定对）。两处必须用同一张表，所以只在这里定义一次。

/** HARD issue code（**逐字抄自** `converter/src/issues.py:21-28` + `ADDED_CODES` 的 hard 项 + `pdf_reading_order_unverified`）。 */
export const HARD_ISSUE_CODES: ReadonlySet<string> = new Set([
  // 抄自 batch.py:117-124（原样）
  'unread_visual_page', 'pdf_no_text', 'pdf_text_encoding_unread',
  'reader_timeout', 'reader_failed', 'no_reader', 'office_backend_unavailable',
  'epub_embedded_image_unread', 'missing_word_part', 'missing_word_note',
  'unread_word_object', 'encrypted_pdf', 'pdf_layout_unread',
  'text_decode_unread', 'fetch_failed', 'source_changed_during_read',
  'structure_unidentified',
  // 招聘字段层新增（`issues.py:36-51` 的 hard 项）
  'pdf_damaged_repaired', 'resume_field_unreadable', 'resume_experience_cross_block',
  'platform_noise_inline_unresolved',
  // `issues.py:59`：doc 11 A4 比 batch.py 更严，登记为 HARD
  'pdf_reading_order_unverified',
])

/** SOFT 前缀（`issues.py:31-32`）。 */
const SOFT_ISSUE_PREFIXES: readonly string[] = [
  'unverified_', 'html_', 'display_relation_', 'display_entry_',
  'pdf_reading_order_', 'markdown_page_context_',
]

/** 已登记且为 SOFT 的 code（`issues.py:42-50` 中 soft 的部分）。 */
const ADDED_SOFT_CODES: ReadonlySet<string> = new Set([
  'resume_timeline_gap', 'resume_timeline_overlap', 'resume_timeline_inversion',
  'resume_timeline_unparsed', 'resume_attribution_unverified', 'platform_noise_excluded',
  'pdf_page_empty', 'resume_protected_attribute_present', 'resume_ocr_heading_inserted',
])

/** 一条 issue（只声明用到的键）。 */
export interface MaterialIssue {
  readonly code?: string
  readonly message?: string
  readonly location?: unknown
}

/**
 * 一个 issue 是 HARD 吗？
 * **未知 code 一律按 HARD**（`issues.py:66-80` 原话：保守优先）。
 * @param code - issue code。
 */
export function isHardIssue(code: string): boolean {
  if (code === '') return false
  if (HARD_ISSUE_CODES.has(code)) return true
  if (SOFT_ISSUE_PREFIXES.some((prefix) => code.startsWith(prefix))) return false
  if (ADDED_SOFT_CODES.has(code)) return false
  return true
}

/**
 * HARD issue 的 code（去重、保序）。口径与 `issues.py:83-94` 的 `hard_codes()` 一致。
 * @param issues - converter 的 `issues[]`。
 */
export function hardIssueCodes(issues: readonly MaterialIssue[] | undefined): string[] {
  const out: string[] = []
  for (const issue of issues ?? []) {
    const code = typeof issue.code === 'string' ? issue.code : ''
    if (code === '') continue
    if (isHardIssue(code) && !out.includes(code)) out.push(code)
  }
  return out
}

/** converter 的 `meta`（只声明用到的键）。 */
export interface ConverterMeta {
  readonly pages?: number
  readonly source_sha256?: string
  readonly source_name?: string
  readonly backend?: string
  readonly reader_version?: string
  readonly order_verified?: boolean
}

/**
 * converter 结果 → `resume_version.parse_status`。
 *
 * 映射表（本 lane 定义，写进 README）：
 *   `completeness='complete'` 且无 HARD issue  → `PARSED`
 *   有可读正文但 `completeness!='complete'` 或有 HARD issue → `PARTIAL`
 *   一个字符都没读出来（`chars<=0/undefined`）        → `FAILED`（`ck_resume_version_error` 要求 parse_error 非空）
 *
 * 为什么 `PARTIAL` 也要看 HARD issue：`PARSED` 的唯一含义是"整篇读完了，`absent` 可信"；
 * 只要有 HARD issue，就不能给出这个承诺（`screening-rules.md` §3.3 第 1/2 行）。
 * @param completeness - converter 的 `completeness`。
 * @param chars - converter 的 `chars`。
 * @param issues - converter 的 `issues[]`。
 */
export function mapParseStatus(
  completeness: string | undefined,
  chars: number | undefined,
  issues: readonly MaterialIssue[] | undefined,
): { status: 'PARSED' | 'PARTIAL' | 'FAILED'; parse_error?: string } {
  const hard = hardIssueCodes(issues)
  const text = typeof chars === 'number' && Number.isFinite(chars) ? chars : 0
  if (text <= 0) {
    return { status: 'FAILED', parse_error: hard[0] ?? 'pdf_no_text' }
  }
  if (completeness === 'complete' && hard.length === 0) return { status: 'PARSED' }
  return { status: 'PARTIAL' }
}

/** `parsed_fields` 白名单投影的形状（S7 只读这四个子树）。 */
export interface ParsedFieldsProjection {
  readonly fields: Record<string, unknown>
  readonly timeline?: unknown
  readonly issues: readonly MaterialIssue[]
  readonly screening?: unknown
  readonly meta: { readonly pages: number; readonly source_sha256: string; readonly backend: string; readonly reader_version: string }
}

/**
 * 把 converter 输出投影成落到 `resume_version.parsed_fields` 的对象。
 *
 * **白名单**：`fields` / `timeline` / `issues` / `screening` + `meta`（页数与哈希，
 * 证据契约要用）。`protected_attributes` / `noise` / `links` / `blocks` / `text`
 * **一律不落库**——`screening-rules.md` §2.2 要求"不读 protected"是结构保证，
 * 落到库里就等于留下了误用的可能（`D11 §9.6`）。
 * @param output - converter 输出。
 */
export function projectParsedFields(output: {
  readonly fields?: Record<string, unknown>
  readonly timeline?: unknown
  readonly issues?: readonly MaterialIssue[]
  readonly screening?: unknown
  readonly meta?: ConverterMeta
}): ParsedFieldsProjection {
  const pages = typeof output.meta?.pages === 'number' ? output.meta.pages : 0
  const projection: ParsedFieldsProjection = {
    fields: output.fields ?? {},
    issues: (output.issues ?? []).map((issue) => ({
      code: typeof issue.code === 'string' ? issue.code : '',
      message: typeof issue.message === 'string' ? issue.message : '',
    })),
    meta: {
      pages,
      source_sha256: typeof output.meta?.source_sha256 === 'string' ? output.meta.source_sha256 : '',
      backend: typeof output.meta?.backend === 'string' ? output.meta.backend : '',
      reader_version: typeof output.meta?.reader_version === 'string' ? output.meta.reader_version : '',
    },
  }
  const withOptional = projection as unknown as Record<string, unknown>
  if (output.timeline !== undefined) withOptional.timeline = output.timeline
  if (output.screening !== undefined) withOptional.screening = output.screening
  return projection
}
