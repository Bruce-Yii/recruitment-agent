// 稳定 issue code 表（U2 的唯一权威）。
//
// 边界：`converter/src/issues.py` 的 issue code 已冻结，本文件**只做映射，不改级**。
// `converter` 组的 severity 必须与 issues.py 一致（测试里用真实 issues.py 对拍）；
// 本层新增的 code 一律 `origin: 'document'`，命名前缀 `doc_`，不与冻结族冲突。
//
// fail-closed 规则（docs/11 §1「未知 issue code 一律按 HARD 处理」，抄 batch.py:130）：
//   * 不在本表里的 code → HARD + human_review + retryable=false，原样保留 code 字符串，
//     并在 Assessment 里进 `unregistered_codes`；**绝不当 SOFT 放行**。
//   * 注意本层比 issues.py 更严：issues.py 对 `unverified_` / `html_` /
//     `display_*` / `markdown_page_context_` 前缀当 SOFT（抄自参考实现的族规则），
//     本层不按前缀猜——只有登记过的 code 才有 SOFT 资格。当前转换器不产出这些族
//     （测试 `converterIssueCodes()` 扫描真实源码核对），因此没有实际分歧。

import type { IssueSeverity, SuggestedAction } from './types.ts'

export type IssueOrigin = 'converter' | 'document'

export interface IssueCodeSpec {
  readonly code: string
  readonly origin: IssueOrigin
  /** 问题大类：coverage / fidelity / uri / order / attribution / provenance / reader / record / contract。 */
  readonly family: string
  readonly severity: IssueSeverity
  readonly retryable: boolean
  readonly suggested_action: SuggestedAction
  /** 人读的一句话（会进入恢复计划的「具体问题」）。 */
  readonly meaning: string
}

export const DOCUMENT_ISSUE_CODES = {
  // ---- 契约层：输入本身不合法，不许猜 ----
  doc_contract_invalid: {
    code: 'doc_contract_invalid',
    origin: 'document',
    family: 'contract',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '统一内容结构不合法（不是对象/缺 blocks/块字段类型错），无法建立可追溯定位',
  },
  doc_media_unsupported: {
    code: 'doc_media_unsupported',
    origin: 'document',
    family: 'contract',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '媒体类型不在 docs/19 §2.1 的闭集内，本层没有可用的判据',
  },
  doc_completeness_unexplained: {
    code: 'doc_completeness_unexplained',
    origin: 'document',
    family: 'contract',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '上游声明没读完，却没有给出任何 issue（docs/11 B3：不可静默）',
  },
  // ---- 覆盖：页/块 ----
  doc_block_missing: {
    code: 'doc_block_missing',
    origin: 'document',
    family: 'coverage',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'vision_read',
    meaning: '整份材料没有任何 block（正文若存在也失去定位，不能当作已读）',
  },
  doc_page_count_unverified: {
    code: 'doc_page_count_unverified',
    origin: 'document',
    family: 'coverage',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '分页材料没有页数，无法核对页覆盖（docs/11 A1）',
  },
  doc_page_coverage_missing: {
    code: 'doc_page_coverage_missing',
    origin: 'document',
    family: 'coverage',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'vision_read',
    meaning: '该页既没有 block 也没有 issue 记录（页在输出里消失了）',
  },
  // ---- 保真 ----
  doc_char_fidelity_mismatch: {
    code: 'doc_char_fidelity_mismatch',
    origin: 'document',
    family: 'fidelity',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '原生文本非空白字符数与输出字符数不等（docs/11 A2：不增不减）',
  },
  doc_unreadable_glyph_in_body: {
    code: 'doc_unreadable_glyph_in_body',
    origin: 'document',
    family: 'fidelity',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '正文里出现坏字形/不可读标记（U+FFFD、(cid:N)、控制字符），docs/11 A6',
  },
  // ---- URI ----
  doc_uri_lost: {
    code: 'doc_uri_lost',
    origin: 'document',
    family: 'uri',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '原件里有真实 URI，输出里没有（docs/11 A5：链接不猜、也不许丢）',
  },
  doc_uri_fabricated: {
    code: 'doc_uri_fabricated',
    origin: 'document',
    family: 'uri',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '输出里出现原件没有的 URI（凭空生成，任何下游都不得引用）',
  },
  // ---- 顺序 ----
  doc_reading_order_unverified: {
    code: 'doc_reading_order_unverified',
    origin: 'document',
    family: 'order',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'vision_read',
    meaning: '阅读顺序没有经过核对（order_verified 未声明/false，或 order 自相矛盾）',
  },
  // ---- 归属 ----
  doc_cross_block_attribution: {
    code: 'doc_cross_block_attribution',
    origin: 'document',
    family: 'attribution',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '含时间区间的行缺少组织文本，公司/职位/时间来自不同区块（禁止跨区块拼装）',
  },
  // ---- 来源核验 ----
  doc_provenance_unverified: {
    code: 'doc_provenance_unverified',
    origin: 'document',
    family: 'provenance',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '该块的 provenance 是模型/OCR 生成或缺失，属于待核证据（docs/19 §2.2.3）',
  },
  doc_identity_from_unverified_source: {
    code: 'doc_identity_from_unverified_source',
    origin: 'document',
    family: 'provenance',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '邮箱/电话/姓名类身份信息来自未核来源，不得触发自动并人（docs/11 D3）',
  },
} as const satisfies Record<string, IssueCodeSpec>

export type DocumentIssueCode = keyof typeof DOCUMENT_ISSUE_CODES

/**
 * 转换器 issue code 的映射表。
 *
 * severity 与 `converter/src/issues.py` 完全一致（测试
 * `test/document/quality.test.ts` 用真实 issues.py 对拍，不允许改级）。
 * 新增 code 属于转换器所有者的权限，本层遇到就按未登记 HARD 兜住。
 */
export const CONVERTER_ISSUE_CODES = {
  // issues.py `_HARD_ISSUE_CODES`（抄自 batch.py:117-124，原样）
  unread_visual_page: {
    code: 'unread_visual_page',
    origin: 'converter',
    family: 'coverage',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'vision_read',
    meaning: '该页文字很少但有图形，视觉内容未被读取（docs/11 B1）',
  },
  pdf_no_text: {
    code: 'pdf_no_text',
    origin: 'converter',
    family: 'coverage',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'vision_read',
    meaning: 'PDF 没有可机读文本层（扫描件/图像型，docs/11 B1）',
  },
  pdf_text_encoding_unread: {
    code: 'pdf_text_encoding_unread',
    origin: 'converter',
    family: 'fidelity',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '原生层有未解码字形，正文不可信（docs/11 A6）',
  },
  reader_timeout: {
    code: 'reader_timeout',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'retry',
    meaning: '读取超时，没有产生可信正文（docs/11 C3）',
  },
  reader_failed: {
    code: 'reader_failed',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'retry',
    meaning: '读取失败（文件打不开/解析异常）',
  },
  no_reader: {
    code: 'no_reader',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '没有可用的读取器处理该媒体类型',
  },
  office_backend_unavailable: {
    code: 'office_backend_unavailable',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'retry',
    meaning: 'Office 解析后端不可用（通常是瞬时/配置问题，先重试）',
  },
  epub_embedded_image_unread: {
    code: 'epub_embedded_image_unread',
    origin: 'converter',
    family: 'coverage',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'vision_read',
    meaning: 'EPUB 内嵌图像未读取',
  },
  missing_word_part: {
    code: 'missing_word_part',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: 'DOCX 缺失部件，内容可能不完整',
  },
  missing_word_note: {
    code: 'missing_word_note',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: 'DOCX 缺失批注/脚注部件',
  },
  unread_word_object: {
    code: 'unread_word_object',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'switch_reader',
    meaning: 'DOCX 内有读不出的对象（文本框/图表等）',
  },
  encrypted_pdf: {
    code: 'encrypted_pdf',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: 'PDF 需要密码才能打开，正文完全未读（docs/11 B2）',
  },
  pdf_layout_unread: {
    code: 'pdf_layout_unread',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '版面后端不可用，顺序/分栏判断失去依据',
  },
  text_decode_unread: {
    code: 'text_decode_unread',
    origin: 'converter',
    family: 'fidelity',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '文本解码失败，正文不可信',
  },
  fetch_failed: {
    code: 'fetch_failed',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'retry',
    meaning: '远端取件失败，未能拿到原件内容',
  },
  source_changed_during_read: {
    code: 'source_changed_during_read',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'retry',
    meaning: '读取过程中原件发生变化（docs/11 C2）',
  },
  structure_unidentified: {
    code: 'structure_unidentified',
    origin: 'converter',
    family: 'attribution',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '结构层无法识别分区（经历/教育），字段归属不可确认',
  },
  // issues.py 把 `pdf_reading_order_` 整族当 SOFT，本项目按 docs/11 A4（更严）登记为 HARD。
  // 这不是「改级」，是 issues.py 里同样登记为 HARD 的取舍（见其源码注释）。
  pdf_reading_order_unverified: {
    code: 'pdf_reading_order_unverified',
    origin: 'converter',
    family: 'order',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '内容流回跳，阅读顺序不可信（docs/11 A4）',
  },
  // issues.py `ADDED_CODES` 中 hard 的部分（本层映射，不改级）
  pdf_damaged_repaired: {
    code: 'pdf_damaged_repaired',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '解析器修复了结构损坏的文件，内容可能不完整',
  },
  resume_field_unreadable: {
    code: 'resume_field_unreadable',
    origin: 'converter',
    family: 'provenance',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '字段在原文出现但读不出（是 unreadable，不是 absent）',
  },
  resume_experience_cross_block: {
    code: 'resume_experience_cross_block',
    origin: 'converter',
    family: 'attribution',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '经历行有日期但没有同区块组织文本，拒绝跨区块拼装',
  },
  platform_noise_inline_unresolved: {
    code: 'platform_noise_inline_unresolved',
    origin: 'converter',
    family: 'provenance',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '平台噪声与正文同块，未移除，需人工确认不是公司名',
  },
  // issues.py `ADDED_CODES` 中 soft 的部分
  pdf_page_empty: {
    code: 'pdf_page_empty',
    origin: 'converter',
    family: 'coverage',
    severity: 'SOFT',
    retryable: false,
    suggested_action: 'none',
    meaning: '该页无文字、无图像、无矢量图形（空页，仅记录）',
  },
  resume_timeline_gap: {
    code: 'resume_timeline_gap',
    origin: 'converter',
    family: 'record',
    severity: 'SOFT',
    retryable: false,
    suggested_action: 'none',
    meaning: '时间线断档（原文如此，未修补）',
  },
  resume_timeline_overlap: {
    code: 'resume_timeline_overlap',
    origin: 'converter',
    family: 'record',
    severity: 'SOFT',
    retryable: false,
    suggested_action: 'none',
    meaning: '时间线重叠（原文如此，未修补）',
  },
  resume_timeline_inversion: {
    code: 'resume_timeline_inversion',
    origin: 'converter',
    family: 'record',
    severity: 'SOFT',
    retryable: false,
    suggested_action: 'none',
    meaning: '时间线倒挂（起止颠倒，未修补）',
  },
  resume_timeline_unparsed: {
    code: 'resume_timeline_unparsed',
    origin: 'converter',
    family: 'record',
    severity: 'SOFT',
    retryable: false,
    suggested_action: 'none',
    meaning: '含年份但无法归一为区间',
  },
  resume_attribution_unverified: {
    code: 'resume_attribution_unverified',
    origin: 'converter',
    family: 'attribution',
    severity: 'SOFT',
    retryable: false,
    suggested_action: 'human_review',
    meaning: '经历行跨多个同排区块，只取同一排，未做跨排拼接',
  },
  platform_noise_excluded: {
    code: 'platform_noise_excluded',
    origin: 'converter',
    family: 'record',
    severity: 'SOFT',
    retryable: false,
    suggested_action: 'none',
    meaning: '平台噪声已识别并移出正文（保留记录）',
  },
  resume_protected_attribute_present: {
    code: 'resume_protected_attribute_present',
    origin: 'converter',
    family: 'record',
    severity: 'SOFT',
    retryable: false,
    suggested_action: 'none',
    meaning: '识别到受保护属性并隔离，未进入筛选特征',
  },
  resume_ocr_heading_inserted: {
    code: 'resume_ocr_heading_inserted',
    origin: 'converter',
    family: 'record',
    severity: 'SOFT',
    retryable: false,
    suggested_action: 'none',
    meaning: '标题来自 OCR 区域补读（正文仍为原生文本）',
  },
  // 转换器真实会发出、但 issues.py 未登记 → issues.py 按未知 HARD 处理。
  // 这里显式登记（同样是 HARD），既保持不降级，也让恢复计划有明确动作。
  visual_read_required: {
    code: 'visual_read_required',
    origin: 'converter',
    family: 'coverage',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'vision_read',
    meaning: '材料有未读取的视觉内容（content.py result() 兜底）',
  },
  partial_read: {
    code: 'partial_read',
    origin: 'converter',
    family: 'coverage',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '阅读器只返回了材料的一部分（content.py result() 兜底）',
  },
  read_failed: {
    code: 'read_failed',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: true,
    suggested_action: 'retry',
    meaning: '所选材料读取失败（content.py observe_read 兜底）',
  },
  reader_unverified: {
    code: 'reader_unverified',
    origin: 'converter',
    family: 'reader',
    severity: 'HARD',
    retryable: false,
    suggested_action: 'switch_reader',
    meaning: '所选材料未被完整读取（content.py observe_read 兜底）',
  },
} as const satisfies Record<string, IssueCodeSpec>

/** 未登记 code 的兜底规则：HARD + human_review + 不可重试（fail-closed）。 */
export const UNREGISTERED_ISSUE_SPEC: IssueCodeSpec = {
  code: '',
  origin: 'document',
  family: 'unregistered',
  severity: 'HARD',
  retryable: false,
  suggested_action: 'human_review',
  meaning: '未登记的 issue code（按 HARD 兜住，不得当 SOFT 放行；需工程侧补表）',
}

const REGISTRY: Readonly<Record<string, IssueCodeSpec>> = (() => {
  const out: Record<string, IssueCodeSpec> = {}
  for (const spec of Object.values(DOCUMENT_ISSUE_CODES)) out[spec.code] = spec
  for (const spec of Object.values(CONVERTER_ISSUE_CODES)) out[spec.code] = spec
  return out
})()

export interface CodeLookup {
  readonly spec: IssueCodeSpec
  readonly registered: boolean
}

/** 查表；未登记返回 { UNREGISTERED_ISSUE_SPEC, registered:false } 且保留原 code。 */
export function lookupIssueCode(code: string): CodeLookup {
  const spec = REGISTRY[code]
  if (spec === undefined) return { spec: { ...UNREGISTERED_ISSUE_SPEC, code }, registered: false }
  return { spec, registered: true }
}

/** 全部已登记 code（顺序稳定，供测试与文档使用）。 */
export function knownIssueCodes(): string[] {
  return Object.keys(REGISTRY).sort()
}

/** 严重度取严：上游可以升级，不可以降级。 */
export function stricterSeverity(a: IssueSeverity | undefined, b: IssueSeverity): IssueSeverity {
  if (a === 'HARD' || b === 'HARD') return 'HARD'
  return 'SOFT'
}
