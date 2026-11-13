// 恢复计划生成器：`plan(content) -> RecoveryPlan`。
//
// 纯函数：不读磁盘、不起子进程、不调模型、不写库。计划描述「谁、对着哪段原文、
// 做什么」，执行由 U3 在 DSH 里完成（视觉补读走 recruitment_page_image + read_image）。
//
// 分派条件（写死在这里，可测）：
//   retry          : issue.retryable 且仍有重试预算（默认 1 次），用尽 → human_review
//   switch_reader  : 需要另一种读取能力（文本层/版面/链接/页清单/DOCX/OCR），
//                    当前媒体有可用能力族 → 生成候选；没有 → human_review
//   vision_read    : 媒体可分页（PDF/图像）且能看到目标页/帧 → 生成页清单 + 渲染参数；
//                    DOCX 无页、页数未知、模型不支持图像 → 降级
//   human_review   : 始终可用；按 code 分派给 recruiter 或 engineering

import { assess } from '../quality/assess.ts'
import { lookupIssueCode } from '../quality/issue-codes.ts'
import { locatorKey, locatorPage } from '../quality/normalize.ts'
import type { Assessment, AssessmentIssue, EvidenceLocator, SuggestedAction } from '../quality/types.ts'
import type {
  HumanPayload,
  PlanOptions,
  RecoveryPlan,
  RecoveryStep,
  RecoverySummary,
  ResponsibilityRole,
  RetryPayload,
  SwitchReaderPayload,
  VisionPageRequest,
  VisionRender,
} from './types.ts'

const DEFAULT_MAX_VISION_PAGES = 20
const DEFAULT_MAX_RETRIES = 1
const VISION_DPI = 200

/** 渲染参数镜像 recruitment_page_image 的真实行为：dpi 走配置，不是逐次参数。 */
const RENDER: Omit<VisionRender, 'args'> = {
  tool: 'recruitment_page_image',
  dpi: VISION_DPI,
  dpi_source: 'RESUME_FALLBACK_DPI 或内置默认 200（工具不接收逐次 dpi 参数）',
  format: 'png',
  page_1_based: true,
  consumer: 'read_image',
}

const ACTION_ORDER: readonly SuggestedAction[] = ['retry', 'switch_reader', 'vision_read', 'human_review']

/** 需要工程侧看的问题：契约/登记缺陷，不是招聘同学能回答的。 */
const ENGINEERING_CODES = new Set([
  'doc_contract_invalid',
  'doc_completeness_unexplained',
  'doc_page_count_unverified',
  'doc_media_unsupported',
])

/** 读取能力画像（不是 reader_id，reader_id 由读取器注册表提供）。 */
const SWITCH_PROFILE_BY_CODE: Readonly<Record<string, string>> = {
  doc_char_fidelity_mismatch: 'pdf:strict-counter',
  doc_unreadable_glyph_in_body: 'pdf:alternate-text-extraction',
  doc_uri_lost: 'pdf:link-extraction',
  doc_page_count_unverified: 'pdf:page-inventory',
  doc_reading_order_unverified: 'pdf:layout-backend',
  pdf_text_encoding_unread: 'pdf:alternate-text-extraction',
  text_decode_unread: 'pdf:alternate-text-extraction',
  pdf_layout_unread: 'pdf:layout-backend',
  pdf_damaged_repaired: 'pdf:strict-reader',
  no_reader: 'same-media:registered-reader',
  partial_read: 'same-media:registered-reader',
  reader_unverified: 'same-media:registered-reader',
  office_backend_unavailable: 'docx:alternate-word-reader',
  missing_word_part: 'docx:alternate-word-reader',
  missing_word_note: 'docx:alternate-word-reader',
  unread_word_object: 'docx:alternate-word-reader',
}

function mediaKind(mediaType: string): 'pdf' | 'docx' | 'image' | 'unknown' {
  if (mediaType === 'application/pdf' || mediaType.endsWith('/pdf')) return 'pdf'
  if (mediaType.includes('wordprocessingml')) return 'docx'
  if (mediaType.startsWith('image/')) return 'image'
  return 'unknown'
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function uniqueSorted<T extends string | number>(values: ReadonlyArray<T>): T[] {
  return Array.from(new Set(values)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function locatorKeys(locators: ReadonlyArray<EvidenceLocator>): string[] {
  return uniqueSorted(locators.map((locator) => locatorKey(locator)))
}

function locatorsOf(issues: ReadonlyArray<AssessmentIssue>): EvidenceLocator[] {
  const out: EvidenceLocator[] = []
  const seen = new Set<string>()
  for (const issue of issues) {
    for (const locator of issue.locators.length > 0 ? issue.locators : (issue.locator === null ? [] : [issue.locator])) {
      const key = locatorKey(locator)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(locator)
    }
  }
  return out
}

/** 具体问题（人读）：把 code 的含义翻成一句话，并给出原文定位范围。 */
function describeProblem(codes: ReadonlyArray<string>, locators: ReadonlyArray<EvidenceLocator>): string {
  const meanings = uniqueSorted(codes.map((code) => lookupIssueCode(code).spec.meaning))
  const pages = uniqueSorted(locators
    .map((locator) => locatorPage(locator))
    .filter((page): page is number => page !== null))
  const frames = uniqueSorted(locators
    .map((locator) => (locator.kind === 'image' && locator.frame !== undefined ? locator.frame : -1))
    .filter((frame) => frame >= 0))
  const where: string[] = []
  if (pages.length > 0) where.push(`第 ${pages.join('、')} 页`)
  if (frames.length > 0) where.push(`第 ${frames.map((frame) => frame + 1).join('、')} 帧`)
  const locatorText = where.length > 0 ? `原文定位：${where.join(' / ')}` : '原文定位：整份材料层面（无单页定位）'
  return `${meanings.join('；')}。${locatorText}`
}

function humanRoleFor(codes: ReadonlyArray<string>): ResponsibilityRole {
  if (codes.some((code) => ENGINEERING_CODES.has(code) || !lookupIssueCode(code).registered)) return 'engineering'
  return 'recruiter'
}

function humanPayload(role: ResponsibilityRole): HumanPayload {
  return {
    ask: role === 'engineering'
      ? '下列问题属于读取器或契约层缺陷（含未登记 issue code）：请确认原因并修复；修复后从质量 Gate 重新判定。'
      : '请对照原件核对下列问题，并在确认/修订/仍无法识别中选一个；确认结果作为新的可审计证据追加，不覆盖旧输出。',
    options: ['confirm', 'amend', 'still_unreadable'],
    resume_from: 'quality_gate',
  }
}

function switchCandidates(mediaType: string, codes: ReadonlyArray<string>): string[] {
  const kind = mediaKind(mediaType)
  if (kind === 'docx') {
    const specific = codes
      .map((code) => SWITCH_PROFILE_BY_CODE[code])
      .filter((profile): profile is string => profile !== undefined && profile.startsWith('docx:'))
    return uniqueSorted([...specific, 'docx:docling-document'])
  }
  if (kind === 'image') return ['image:ocr', 'image:vision']
  if (kind === 'pdf') {
    const specific = codes
      .map((code) => SWITCH_PROFILE_BY_CODE[code])
      .filter((profile): profile is string => profile !== undefined)
    return uniqueSorted([...specific, 'pdf:alternate-reader'])
  }
  return []
}

interface VisionResolution {
  readonly requests: VisionPageRequest[]
  readonly overflow: number[]
  /** 无法生成补读页时的原因（此时调用方降级）。 */
  readonly unavailable: string | null
}

function collectVisionPages(issues: ReadonlyArray<AssessmentIssue>): { pages: number[], all: boolean } {
  const pages: number[] = []
  let all = false
  for (const issue of issues) {
    const locators = issue.locators.length > 0 ? issue.locators : (issue.locator === null ? [] : [issue.locator])
    if (locators.length === 0) all = true
    for (const locator of locators) {
      const page = locatorPage(locator)
      if (page === null) all = true
      else pages.push(page)
    }
  }
  return { pages: uniqueSorted(pages), all }
}

function resolveVision(
  assessment: Assessment,
  visionIssues: ReadonlyArray<AssessmentIssue>,
  maxPages: number,
): VisionResolution {
  const kind = mediaKind(assessment.facts.media_type)
  const codes = uniqueSorted(visionIssues.map((issue) => issue.code))
  if (kind === 'docx' || kind === 'unknown') {
    return { requests: [], overflow: [], unavailable: 'MEDIA_HAS_NO_PAGES' }
  }
  if (kind === 'image') {
    const frames = uniqueSorted(visionIssues.flatMap((issue) => issue.locators
      .filter((locator) => locator.kind === 'image')
      .map((locator) => (locator.kind === 'image' && locator.frame !== undefined ? locator.frame : -1))))
    if (frames.length === 0) {
      return {
        requests: [{
          kind: 'image_frame',
          page: null,
          frame: null,
          reason_codes: codes,
          locator: null,
          render: null,
          read_with: 'read_image',
          model_needed: true,
        }],
        overflow: [],
        unavailable: null,
      }
    }
    const requests = frames.filter((frame) => frame >= 0).map((frame) => ({
      kind: 'image_frame' as const,
      page: null,
      frame,
      reason_codes: codes,
      locator: { kind: 'image' as const, frame },
      render: null,
      read_with: 'read_image' as const,
      model_needed: true as const,
    }))
    return { requests, overflow: [], unavailable: null }
  }
  // PDF
  const { pages, all } = collectVisionPages(visionIssues)
  const pageCount = assessment.facts.page_count
  let targets = pages
  if (all || targets.length === 0) {
    if (pageCount === null) return { requests: [], overflow: [], unavailable: 'PAGE_COUNT_UNKNOWN' }
    targets = Array.from({ length: pageCount }, (_unused, index) => index + 1)
  }
  const kept = targets.slice(0, Math.max(1, maxPages))
  const overflow = targets.slice(Math.max(1, maxPages))
  const requests = kept.map((page) => ({
    kind: 'pdf_page' as const,
    page,
    frame: null,
    reason_codes: codes,
    locator: { kind: 'pdf' as const, page },
    render: { ...RENDER, args: { page } },
    read_with: 'read_image' as const,
    model_needed: true as const,
  }))
  return { requests, overflow, unavailable: null }
}

function stepId(action: SuggestedAction, codes: ReadonlyArray<string>, locators: ReadonlyArray<EvidenceLocator>, suffix = ''): string {
  return `step-${action}-${fnv1a(`${action}|${codes.join(',')}|${locatorKeys(locators).join(',')}|${suffix}`)}`
}

function buildRetryPayload(maxRetries: number): RetryPayload {
  return { max_attempts: maxRetries, on_exhausted: 'human_review', backoff_ms: [500] }
}

function buildSwitchPayload(assessment: Assessment, codes: ReadonlyArray<string>): SwitchReaderPayload {
  return {
    from: assessment.facts.reader_id === '' ? '(未声明)' : assessment.facts.reader_id,
    candidates: switchCandidates(assessment.facts.media_type, codes),
    why: '当前读取器在该问题上不可信，需要换一种读取能力重新读原件（不是重试同一条路径）',
    registry: 'reader_id 由 U1/U3 的读取器注册表提供；本层只声明所需能力',
  }
}

/**
 * 生成恢复计划。
 *
 * @param content 统一内容（或转换器输出）。内部调用 `assess()`；也可用
 *                `options.assessment` 复用已有判定。
 */
export function plan(content: unknown, options: PlanOptions = {}): RecoveryPlan {
  const assessment = options.assessment ?? assess(content, options.facts ?? {})
  const modelSupport: RecoveryPlan['model_image_support'] = options.model_supports_image === undefined
    ? 'assumed'
    : options.model_supports_image
      ? 'supported'
      : 'unsupported'
  const maxVision = options.max_vision_pages ?? DEFAULT_MAX_VISION_PAGES
  const maxRetries = options.max_retries ?? DEFAULT_MAX_RETRIES
  const notes: string[] = []

  const byAction = new Map<SuggestedAction, AssessmentIssue[]>()
  for (const issue of assessment.issues) {
    if (issue.suggested_action === 'none') continue
    const bucket = byAction.get(issue.suggested_action) ?? []
    bucket.push(issue)
    byAction.set(issue.suggested_action, bucket)
  }

  const steps: RecoveryStep[] = []
  const blockedVision = new Set<string>()

  // ---- retry ----
  const retryIssues = byAction.get('retry') ?? []
  if (retryIssues.length > 0) {
    const codes = uniqueSorted(retryIssues.map((issue) => issue.code))
    const locators = locatorsOf(retryIssues)
    if (maxRetries > 0) {
      steps.push({
        step_id: stepId('retry', codes, locators, String(maxRetries)),
        action: 'retry',
        role: 'reader_service',
        blocking: retryIssues.some((issue) => issue.severity === 'HARD'),
        codes,
        problem: describeProblem(codes, locators),
        locators,
        status: 'planned',
        blocked_reason: null,
        fallback_from: null,
        retry: buildRetryPayload(maxRetries),
        switch_reader: null,
        vision: [],
        human: null,
      })
    } else {
      steps.push({
        step_id: stepId('switch_reader', codes, locators, 'retry-exhausted'),
        action: 'switch_reader',
        role: 'reader_service',
        blocking: retryIssues.some((issue) => issue.severity === 'HARD'),
        codes,
        problem: `${describeProblem(codes, locators)}（重试预算为 0，直接换读取器）`,
        locators,
        status: 'planned',
        blocked_reason: null,
        fallback_from: 'retry',
        retry: null,
        switch_reader: buildSwitchPayload(assessment, codes),
        vision: [],
        human: null,
      })
    }
  }

  // ---- switch_reader ----
  const switchIssues = byAction.get('switch_reader') ?? []
  if (switchIssues.length > 0) {
    const codes = uniqueSorted(switchIssues.map((issue) => issue.code))
    const locators = locatorsOf(switchIssues)
    const payload = buildSwitchPayload(assessment, codes)
    if (payload.candidates.length > 0) {
      steps.push({
        step_id: stepId('switch_reader', codes, locators),
        action: 'switch_reader',
        role: 'reader_service',
        blocking: switchIssues.some((issue) => issue.severity === 'HARD'),
        codes,
        problem: describeProblem(codes, locators),
        locators,
        status: 'planned',
        blocked_reason: null,
        fallback_from: null,
        retry: null,
        switch_reader: payload,
        vision: [],
        human: null,
      })
    } else {
      steps.push(humanStep(codes, locators, switchIssues, 'switch_reader', 'NO_ALTERNATE_READER'))
    }
  }

  // ---- vision_read ----
  const visionIssues = byAction.get('vision_read') ?? []
  if (visionIssues.length > 0) {
    const codes = uniqueSorted(visionIssues.map((issue) => issue.code))
    const resolution = resolveVision(assessment, visionIssues, maxVision)
    const locators = locatorsOf(visionIssues)
    if (resolution.unavailable !== null) {
      blockedVision.add(resolution.unavailable)
      const candidates = switchCandidates(assessment.facts.media_type, codes)
      if (candidates.length > 0) {
        steps.push({
          step_id: stepId('switch_reader', codes, locators, resolution.unavailable),
          action: 'switch_reader',
          role: 'reader_service',
          blocking: visionIssues.some((issue) => issue.severity === 'HARD'),
          codes,
          problem: `${describeProblem(codes, locators)}（无法分页补读：${resolution.unavailable}，改换读取能力）`,
          locators,
          status: 'planned',
          blocked_reason: null,
          fallback_from: 'vision_read',
          retry: null,
          switch_reader: buildSwitchPayload(assessment, codes),
          vision: [],
          human: null,
        })
      } else {
        steps.push(humanStep(codes, locators, visionIssues, 'vision_read', resolution.unavailable))
      }
    } else {
      const status: RecoveryStep['status'] = modelSupport === 'unsupported' ? 'blocked' : 'planned'
      const blockedReason = modelSupport === 'unsupported' ? 'MODEL_HAS_NO_IMAGE_SUPPORT' : null
      if (blockedReason !== null) blockedVision.add(blockedReason)
      steps.push({
        step_id: stepId('vision_read', codes, resolution.requests.map((request) => request.locator).filter(
          (locator): locator is EvidenceLocator => locator !== null,
        )),
        action: 'vision_read',
        role: 'agent',
        blocking: visionIssues.some((issue) => issue.severity === 'HARD'),
        codes,
        problem: describeProblem(codes, locators),
        locators: resolution.requests
          .map((request) => request.locator)
          .filter((locator): locator is EvidenceLocator => locator !== null),
        status,
        blocked_reason: blockedReason,
        fallback_from: null,
        retry: null,
        switch_reader: null,
        vision: resolution.requests,
        human: null,
      })
      if (blockedReason !== null) {
        steps.push({
          step_id: stepId('human_review', codes, locators, 'model-no-image'),
          action: 'human_review',
          role: 'engineering',
          blocking: visionIssues.some((issue) => issue.severity === 'HARD'),
          codes,
          problem: `${describeProblem(codes, locators)}。当前 model 不支持图像，视觉补读无法执行；`
            + '需要切换到支持图像的模型，或由人工直接查看原件（不得声称视觉读取成功）',
          locators,
          status: 'planned',
          blocked_reason: null,
          fallback_from: 'vision_read',
          retry: null,
          switch_reader: null,
          vision: [],
          human: humanPayload('engineering'),
        })
      }
      if (resolution.overflow.length > 0) {
        const overflowLocators = resolution.overflow.map((page) => ({ kind: 'pdf' as const, page }))
        steps.push({
          step_id: stepId('human_review', codes, overflowLocators, 'vision-overflow'),
          action: 'human_review',
          role: 'recruiter',
          blocking: true,
          codes,
          problem: `${resolution.overflow.length} 页超出单次视觉补读上限（${maxVision} 页），`
            + `需人工复核：第 ${resolution.overflow.join('、')} 页`,
          locators: overflowLocators,
          status: 'planned',
          blocked_reason: null,
          fallback_from: 'vision_read',
          retry: null,
          switch_reader: null,
          vision: [],
          human: humanPayload('recruiter'),
        })
      }
    }
  }

  // ---- human_review ----
  const humanIssues = byAction.get('human_review') ?? []
  if (humanIssues.length > 0) {
    for (const role of ['recruiter', 'engineering'] as const) {
      const bucket = humanIssues.filter((issue) => humanRoleFor([issue.code]) === role)
      if (bucket.length === 0) continue
      steps.push(humanStep(uniqueSorted(bucket.map((issue) => issue.code)), locatorsOf(bucket), bucket, null))
    }
  }

  const visionRequests = steps.flatMap((step) => step.vision)
  const requiresModel = visionRequests.length > 0

  if (requiresModel) {
    notes.push('计划已生成，本层不调用模型、不渲染页面；实际视觉补读由 U3 经 DSH 触发 '
      + 'recruitment_page_image + read_image（D-81：不新建模型客户端）。')
  }
  if (modelSupport === 'unsupported') {
    notes.push('当前 model 不支持图像：视觉补读为 BLOCKED，不得声称视觉读取成功（docs/19 G2）。')
  }
  if (modelSupport === 'assumed') {
    notes.push('未提供 model 图像能力：按「未验证」处理，执行前必须由 U3 在真实 DSH Agent 上确认。')
  }
  if (blockedVision.has('PAGE_COUNT_UNKNOWN')) {
    notes.push('页数未知，无法确定补读页集合：需要读取器补页数（或换读取器）。')
  }
  if (assessment.unregistered_codes.length > 0) {
    notes.push(`存在未登记 issue code（${assessment.unregistered_codes.join(',')}），已按 HARD 兜住，需工程侧补表。`)
  }
  if (!assessment.facts.uri_verified) {
    notes.push('没有原件 URI 清单（native_links），本次未做 URI 对照；这不代表 URI 没问题。')
  }
  if (assessment.blocking) {
    notes.push('HARD 未解除前不得进入可信结构化/S7 PASS-FAIL；也不得用缺字推断候选人缺这段经历。')
  }

  const ordered = [...steps].sort((a, b) => {
    const rank = ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action)
    if (rank !== 0) return rank
    if (a.role !== b.role) return a.role < b.role ? -1 : 1
    return a.step_id < b.step_id ? -1 : a.step_id > b.step_id ? 1 : 0
  })

  const summary: RecoverySummary = {
    total: ordered.length,
    blocking_steps: ordered.filter((step) => step.blocking).length,
    by_action: countBy(ordered.map((step) => step.action)),
    by_role: countBy(ordered.map((step) => step.role)),
    vision_pages: uniqueSorted(visionRequests
      .map((request) => request.page)
      .filter((page): page is number => page !== null)),
  }

  const blocking = assessment.blocking
  const hasBlockingHuman = ordered.some((step) => step.blocking && step.action === 'human_review')
  const next: RecoveryPlan['next'] = !blocking
    ? 'structure'
    : hasBlockingHuman
      ? 'human'
      : 'repair'

  const planId = `plan-${fnv1a(`${ordered.map((step) => step.step_id).join(',')}|${blocking}|${assessment.completeness}`)}`

  return {
    plan_version: '1',
    plan_id: planId,
    blocking,
    next,
    requires_model: requiresModel,
    model_image_support: modelSupport,
    steps: ordered,
    vision: visionRequests,
    summary,
    notes,
    assessment,
  }
}

function countBy(values: ReadonlyArray<string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

function humanStep(
  codes: ReadonlyArray<string>,
  locators: ReadonlyArray<EvidenceLocator>,
  issues: ReadonlyArray<AssessmentIssue>,
  fallbackFrom: SuggestedAction | null,
  blockedReason: string | null = null,
): RecoveryStep {
  const role = humanRoleFor(codes)
  const suffix = blockedReason ?? ''
  return {
    step_id: stepId('human_review', codes, locators, `${role}|${suffix}`),
    action: 'human_review',
    role,
    blocking: issues.some((issue) => issue.severity === 'HARD'),
    codes,
    problem: describeProblem(codes, locators),
    locators,
    status: 'planned',
    blocked_reason: blockedReason,
    fallback_from: fallbackFrom,
    retry: null,
    switch_reader: null,
    vision: [],
    human: humanPayload(role),
  }
}
