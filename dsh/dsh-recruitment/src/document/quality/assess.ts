// 判定器：`assess(content) -> { completeness, blocking, actions[] }`（docs/19 §3 U2 行）。
//
// 三条不变量在这里落成代码，不在文档里落成口号：
//   I1 `unreadable` 永不降级成 `absent`（SR §3.2 红线 / docs/19 G2 最后一条）。
//      实现：`evidenceState()` 把 blocking 判成 'unreadable'；`fieldPresence()`
//      在非 verified 状态下即使「没找到」也返回 'unreadable'，绝不返回 'absent'。
//   I2 质量不足时 `completeness != 'complete'`，且 blocking 项可被下游识别。
//      实现：任何 issue 都把 completeness 压到 partial 以下；blocking 时
//      `blocking_codes` 非空。
//   I3 不以「缺字」推断「候选人缺这段经历」。
//      实现：`mayConcludeAbsence()` 只在 completeness==='complete' 且 !blocking
//      时才允许得出「原文没有」的结论。

import { buildIssue, checkCharFidelity, checkCompletenessExplained, checkContract, checkCoverage, checkCrossBlockAttribution, checkProvenance, checkReadingOrder, checkUris, checkUnreadableGlyphs, DOCUMENT_LEVEL_UNREAD } from './checks.ts'
import { lookupIssueCode, stricterSeverity } from './issue-codes.ts'
import { locatorKey, normalizeContent, normalizeLocator } from './normalize.ts'
import type {
  Assessment,
  AssessmentAction,
  AssessmentFacts,
  AssessmentIssue,
  Completeness,
  EvidenceLocator,
  EvidenceState,
  FieldPresence,
  IssueSeverity,
  RawIssue,
  ReaderFacts,
  SuggestedAction,
} from './types.ts'

const COMPLETENESS_RANK: Readonly<Record<Completeness, number>> = {
  unverified: 0,
  partial: 1,
  complete: 2,
}

const ACTION_ORDER: readonly SuggestedAction[] = ['retry', 'switch_reader', 'vision_read', 'human_review']

function minCompleteness(a: Completeness, b: Completeness): Completeness {
  return COMPLETENESS_RANK[a] <= COMPLETENESS_RANK[b] ? a : b
}

function normalizeSeverity(raw: unknown): IssueSeverity | undefined {
  if (typeof raw !== 'string') return undefined
  const upper = raw.trim().toUpperCase()
  return upper === 'HARD' || upper === 'SOFT' ? upper : undefined
}

function rawLocatorOf(raw: RawIssue): EvidenceLocator | null {
  return normalizeLocator(raw.locator ?? raw.location)
}

/** 继承上游 issue：只做映射与「不得降级」。 */
function mapInheritedIssue(raw: RawIssue): AssessmentIssue {
  const rawCode = typeof raw.code === 'string' ? raw.code.trim() : ''
  const code = rawCode === '' ? 'doc_contract_invalid' : rawCode
  const message = typeof raw.message === 'string' && raw.message.trim() !== ''
    ? raw.message
    : rawCode === ''
      ? '上游 issue 没有 code（按契约不合法处理）'
      : `上游 issue ${rawCode} 没有 message`
  const { spec } = lookupIssueCode(code)
  const upstreamSeverity = normalizeSeverity(raw.severity)
  const severity = upstreamSeverity === undefined ? spec.severity : stricterSeverity(upstreamSeverity, spec.severity)
  return buildIssue(code, message, rawLocatorOf(raw), { severity })
}

function dedupe(issues: ReadonlyArray<AssessmentIssue>): AssessmentIssue[] {
  const seen = new Set<string>()
  const out: AssessmentIssue[] = []
  for (const issue of issues) {
    const key = `${issue.code}|${locatorKey(issue.locator)}|${issue.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(issue)
  }
  return out
}

function sortIssues(issues: ReadonlyArray<AssessmentIssue>): AssessmentIssue[] {
  return [...issues].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'HARD' ? -1 : 1
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    const la = locatorKey(a.locator)
    const lb = locatorKey(b.locator)
    if (la !== lb) return la < lb ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })
}

function buildActions(issues: ReadonlyArray<AssessmentIssue>): AssessmentAction[] {
  const out: AssessmentAction[] = []
  for (const action of ACTION_ORDER) {
    const matching = issues.filter((issue) => issue.suggested_action === action)
    if (matching.length === 0) continue
    out.push({
      action,
      codes: Array.from(new Set(matching.map((issue) => issue.code))).sort(),
      blocking: matching.some((issue) => issue.severity === 'HARD'),
    })
  }
  return out
}

function factsOf(normalized: ReturnType<typeof normalizeContent>): AssessmentFacts {
  return {
    media_type: normalized.media_type,
    reader_id: normalized.reader_id,
    block_count: normalized.blocks.length,
    page_count: normalized.page_count,
    order_verified: normalized.order_verified,
    uri_verified: normalized.native_uris !== null,
    unreadable_markers: normalized.blocks.reduce((sum, block) => sum + block.unreadable_markers, 0),
    model_text_blocks: normalized.blocks.filter(
      (block) => block.provenance === 'ocr' || block.provenance === 'agent_read',
    ).length,
    unknown_provenance_blocks: normalized.blocks.filter((block) => !block.provenance_known).length,
    needs_visual: normalized.needs_visual,
    declared_completeness: normalized.completeness,
  }
}

function emptyAssessment(normalized: ReturnType<typeof normalizeContent>, issue: AssessmentIssue): Assessment {
  const issues = [issue]
  return {
    completeness: 'partial',
    blocking: true,
    actions: buildActions(issues),
    issues,
    blocking_codes: [issue.code],
    soft_codes: [],
    unregistered_codes: issue.registered ? [] : [issue.code],
    facts: factsOf(normalized),
  }
}

/**
 * 判定统一内容。
 *
 * @param content 转换器输出或 docs/19 §2.1 的 DocumentContent。允许宽输入：
 *                结构不合法会被判 `doc_contract_invalid`（HARD），不会抛异常。
 * @param facts   读取器事实（页数/顺序声明/原生字符数与 URI 清单）。U0 的封闭契约
 *                不带这些字段时，必须经此传入，否则 A1/A4 无法核对（一律 HARD）。
 */
export function assess(content: unknown, facts: ReaderFacts = {}): Assessment {
  let normalized: ReturnType<typeof normalizeContent>
  try {
    normalized = normalizeContent(content, facts)
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const fallback = normalizeContent(null)
    return emptyAssessment(fallback, buildIssue('doc_contract_invalid', `归一化异常（fail-closed）：${message}`, null))
  }

  const inherited = normalized.issues.map(mapInheritedIssue)
  const inheritedCodes = new Set(inherited.map((issue) => issue.code))
  const documentLevelUnread = inherited.some((issue) => issue.severity === 'HARD'
    && DOCUMENT_LEVEL_UNREAD.has(issue.code))
  const ctx = { content: normalized, inheritedCodes, documentLevelUnread }

  let derived: AssessmentIssue[]
  try {
    derived = [
      ...checkContract(ctx),
      ...checkCoverage(ctx),
      ...checkCharFidelity(ctx),
      ...checkUnreadableGlyphs(ctx),
      ...checkUris(ctx),
      ...checkReadingOrder(ctx),
      ...checkCrossBlockAttribution(ctx),
      ...checkProvenance(ctx),
    ]
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const issue = buildIssue('doc_contract_invalid', `检查过程异常（fail-closed）：${message}`, null)
    const issues = sortIssues(dedupe([...inherited, issue]))
    return finalize(normalized, issues)
  }

  let issues = dedupe([...inherited, ...derived])
  const explained = checkCompletenessExplained(ctx, issues.length)
  if (explained.length > 0) issues = dedupe([...issues, ...explained])

  return finalize(normalized, sortIssues(issues))
}

function finalize(
  normalized: ReturnType<typeof normalizeContent>,
  issues: ReadonlyArray<AssessmentIssue>,
): Assessment {
  const blocking = issues.some((issue) => issue.severity === 'HARD')
  const derivedCompleteness: Completeness = issues.length === 0 ? 'complete' : 'partial'
  const completeness = minCompleteness(normalized.completeness, derivedCompleteness)
  return {
    completeness,
    blocking,
    actions: buildActions(issues),
    issues,
    blocking_codes: Array.from(new Set(
      issues.filter((issue) => issue.severity === 'HARD').map((issue) => issue.code),
    )).sort(),
    soft_codes: Array.from(new Set(
      issues.filter((issue) => issue.severity === 'SOFT').map((issue) => issue.code),
    )).sort(),
    unregistered_codes: Array.from(new Set(
      issues.filter((issue) => !issue.registered).map((issue) => issue.code),
    )).sort(),
    facts: factsOf(normalized),
  }
}

/** 下游唯一需要看的闸门：blocking 就是 block。 */
export function isBlocked(assessment: Assessment): boolean {
  return assessment.blocking
}

/** 证据状态：'unreadable' 与 'unverified' 都必须与 'verified' 分开，绝不合并。 */
export function evidenceState(assessment: Assessment): EvidenceState {
  if (assessment.blocking) return 'unreadable'
  if (assessment.completeness === 'complete') return 'verified'
  return 'unverified'
}

/**
 * 字段结论（I1）。
 *
 * `unreadable` 永远优先：只要阅读状态不是 verified，「原文里没找到」只能得出
 * `unreadable`，不能得出 `absent`。`absent` 的唯一合法前提是
 * 「已核实的完整阅读 + 确实没找到」。
 */
export function fieldPresence(state: EvidenceState, foundInText: boolean): FieldPresence {
  if (state === 'unreadable') return 'unreadable'
  if (foundInText) return 'present'
  if (state === 'verified') return 'absent'
  return 'unreadable'
}

/**
 * 是否允许得出「候选人没有这段经历」这类**缺席结论**（I3）。
 *
 * 只允许在完整且已核实的阅读上；任何 HARD、任何未核实项都不行。
 * 这是「缺字 ≠ 缺经历」的可执行版本。
 */
export function mayConcludeAbsence(assessment: Assessment): { allowed: boolean, reason: string } {
  if (assessment.blocking) {
    return {
      allowed: false,
      reason: `仍有 HARD 未解除（${assessment.blocking_codes.join(',')}），缺字不能推断缺经历`,
    }
  }
  if (assessment.completeness !== 'complete') {
    return {
      allowed: false,
      reason: `completeness=${assessment.completeness}，阅读不完整时不能断言原文缺失`,
    }
  }
  if (assessment.unregistered_codes.length > 0) {
    return { allowed: false, reason: `存在未登记 issue code（${assessment.unregistered_codes.join(',')}）` }
  }
  return { allowed: true, reason: '阅读完整且已核实，可以就「原文未出现」下结论' }
}

/** 便捷别名：某些下游只关心能否进入可信结构化。 */
export function canProceedToStructure(assessment: Assessment): boolean {
  return !assessment.blocking && evidenceState(assessment) !== 'unreadable'
}
