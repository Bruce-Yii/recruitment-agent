// Eval V2 — Evaluation Card 切分报告器（修复零样本 passRate=1 假 100% 漏洞 + 显式标明 executionMode）。
import {
  ALL_EVAL_POINTS,
  DEFAULT_COUNTER_METRICS_THRESHOLDS,
  type CaseRunOutcome,
  type CounterMetricsObserved,
  type CounterMetricsThresholds,
  type DataTier,
  type EvalPointId,
  type MinGate,
  type SuitePool,
} from './v2-types.ts'

export interface SliceStats {
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly passRate: number | null
}

export interface CounterMetricBreach {
  readonly metric: string
  readonly observed: number
  readonly threshold: number
  readonly message: string
}

export interface BaselineDiff {
  readonly baselineRunId: string
  readonly newlyRegressedCaseIds: readonly string[]
  readonly newlyFixedCaseIds: readonly string[]
  readonly evalPointDelta: Readonly<Record<EvalPointId, number | null>>
}

/** Issue #92 P1-B — 真实适配器覆盖度（只补可观测字段，不参与/放宽判分）。 */
export interface RealCoverage {
  readonly totalCases: number
  readonly executedCases: number
  readonly realSourceCaseIds: readonly string[]
  readonly noRealSourceCaseIds: readonly string[]
  readonly note?: string
}

export interface EvaluationCard {
  readonly schemaVersion: '2.2.0'
  readonly executionMode: 'contract_smoke' | 'real_adapter'
  readonly runId: string
  readonly generatedAt: string
  readonly totalCases: number
  /** 顶层通过率：real 模式零执行时为 null（禁止 0/0 假 100%）。 */
  readonly passRate?: number | null
  /** real_adapter 模式的真实源覆盖度；contract_smoke 缺省。 */
  readonly coverage?: RealCoverage
  readonly byDataTier: Readonly<Record<DataTier, SliceStats>>
  readonly byEvalPoint: Readonly<Record<EvalPointId, SliceStats>>
  readonly bySuitePool: Readonly<Record<SuitePool, SliceStats>>
  readonly byMinGate: Readonly<Record<MinGate, SliceStats>>
  readonly firstBreakdowns: readonly {
    readonly evalPoint: EvalPointId
    readonly caseId: string
    readonly code: string
    readonly message: string
  }[]
  readonly counterMetricsOk: boolean
  readonly counterMetricBreaches: readonly CounterMetricBreach[]
  readonly casePassMap: Readonly<Record<string, boolean>>
  readonly baselineDiff?: BaselineDiff
}

export interface EvaluationCardInput {
  readonly runId: string
  readonly executionMode?: 'contract_smoke' | 'real_adapter'
  readonly generatedAt?: string
  readonly outcomes: readonly CaseRunOutcome[]
  readonly counterMetrics?: CounterMetricsObserved
  readonly thresholds?: CounterMetricsThresholds
  readonly baseline?: EvaluationCard
  /** Issue #92 P1-B：由 runner 传入的真实源覆盖度，仅作报告字段。 */
  readonly coverage?: RealCoverage
}

function summarize(items: readonly CaseRunOutcome[]): SliceStats {
  const total = items.length
  const passed = items.filter((x) => x.passed).length
  const failed = total - passed
  const passRate = total === 0 ? null : Number((passed / total).toFixed(4))
  return { total, passed, failed, passRate }
}

function evaluateCounterMetrics(
  observed: CounterMetricsObserved | undefined,
  thresholds: CounterMetricsThresholds,
): readonly CounterMetricBreach[] {
  if (!observed) return []
  const breaches: CounterMetricBreach[] = []
  if (observed.clearTextUnreadableRate !== undefined && observed.clearTextUnreadableRate > thresholds.maxClearTextUnreadableRate) {
    breaches.push({ metric: 'clearTextUnreadableRate', observed: observed.clearTextUnreadableRate, threshold: thresholds.maxClearTextUnreadableRate, message: `清晰文本误报「读不出来」率 ${(observed.clearTextUnreadableRate * 100).toFixed(1)}% 超过上限 ${(thresholds.maxClearTextUnreadableRate * 100).toFixed(1)}%` })
  }
  if (observed.ttftMsP95 !== undefined && observed.ttftMsP95 > thresholds.maxTtftMs) {
    breaches.push({ metric: 'ttftMsP95', observed: observed.ttftMsP95, threshold: thresholds.maxTtftMs, message: `对话首字延迟 P95（${observed.ttftMsP95}ms）超过上限 ${thresholds.maxTtftMs}ms` })
  }
  if (observed.pdfScreenMsP95 !== undefined && observed.pdfScreenMsP95 > thresholds.maxPdfScreenP95Ms) {
    breaches.push({ metric: 'pdfScreenMsP95', observed: observed.pdfScreenMsP95, threshold: thresholds.maxPdfScreenP95Ms, message: `单份 PDF 解析+初筛 P95（${observed.pdfScreenMsP95}ms）超过上限 ${thresholds.maxPdfScreenP95Ms}ms` })
  }
  if (observed.maxS7ItemChars !== undefined && observed.maxS7ItemChars > thresholds.s7MaxCharsPerItem) {
    breaches.push({ metric: 'maxS7ItemChars', observed: observed.maxS7ItemChars, threshold: thresholds.s7MaxCharsPerItem, message: `S7 单条依据长度 ${observed.maxS7ItemChars} 字超过上限 ${thresholds.s7MaxCharsPerItem} 字` })
  }
  if (observed.maxS8BriefChars !== undefined && observed.maxS8BriefChars > thresholds.s8MaxChars) {
    breaches.push({ metric: 'maxS8BriefChars', observed: observed.maxS8BriefChars, threshold: thresholds.s8MaxChars, message: `S8 本轮参考长度 ${observed.maxS8BriefChars} 字超过上限 ${thresholds.s8MaxChars} 字` })
  }
  if (observed.maxChatReplyChars !== undefined && observed.maxChatReplyChars > thresholds.chatMaxChars) {
    breaches.push({ metric: 'maxChatReplyChars', observed: observed.maxChatReplyChars, threshold: thresholds.chatMaxChars, message: `常规对话回复长度 ${observed.maxChatReplyChars} 字超过上限 ${thresholds.chatMaxChars} 字` })
  }
  if (observed.emptyPointerCitations !== undefined && observed.emptyPointerCitations > 0) {
    breaches.push({ metric: 'emptyPointerCitations', observed: observed.emptyPointerCitations, threshold: 0, message: `检测到 ${observed.emptyPointerCitations} 条空指针敷衍引用` })
  }
  return breaches
}

export function buildEvaluationCard(input: EvaluationCardInput): EvaluationCard {
  const thresholds = input.thresholds ?? DEFAULT_COUNTER_METRICS_THRESHOLDS
  const outcomes = input.outcomes

  const byDataTier: Record<DataTier, SliceStats> = {
    tier1_private_corpus: summarize(outcomes.filter((o) => o.dataTier === 'tier1_private_corpus')),
    tier2_public_benchmark: summarize(outcomes.filter((o) => o.dataTier === 'tier2_public_benchmark')),
    tier3_fault_injection: summarize(outcomes.filter((o) => o.dataTier === 'tier3_fault_injection')),
  }
  const byEvalPoint = Object.fromEntries(
    ALL_EVAL_POINTS.map((pt) => [pt, summarize(outcomes.filter((o) => o.evalPoint === pt))]),
  ) as Record<EvalPointId, SliceStats>
  const bySuitePool: Record<SuitePool, SliceStats> = {
    regression: summarize(outcomes.filter((o) => o.suitePool === 'regression')),
    capability: summarize(outcomes.filter((o) => o.suitePool === 'capability')),
  }
  const byMinGate: Record<MinGate, SliceStats> = {
    G0: summarize(outcomes.filter((o) => o.minGate === 'G0')),
    G1: summarize(outcomes.filter((o) => o.minGate === 'G1')),
    G2: summarize(outcomes.filter((o) => o.minGate === 'G2')),
  }

  const firstBreakdowns: { readonly evalPoint: EvalPointId; readonly caseId: string; readonly code: string; readonly message: string }[] = []
  for (const pt of ALL_EVAL_POINTS) {
    const firstFail = outcomes.find((o) => o.evalPoint === pt && !o.passed)
    if (firstFail) {
      firstBreakdowns.push({
        evalPoint: pt,
        caseId: firstFail.caseId,
        code: firstFail.firstFailureCode ?? 'UNKNOWN_FAILURE',
        message: firstFail.firstFailureMessage ?? '未提供失败说明',
      })
    }
  }

  const counterMetricBreaches = evaluateCounterMetrics(input.counterMetrics, thresholds)
  const casePassMap = Object.fromEntries(outcomes.map((o) => [o.caseId, o.passed]))

  let baselineDiff: BaselineDiff | undefined
  if (input.baseline) {
    const prev = input.baseline
    const newlyRegressedCaseIds: string[] = []
    const newlyFixedCaseIds: string[] = []
    for (const o of outcomes) {
      const prevPass = prev.casePassMap[o.caseId]
      if (prevPass === true && !o.passed) newlyRegressedCaseIds.push(o.caseId)
      if (prevPass === false && o.passed) newlyFixedCaseIds.push(o.caseId)
    }
    const evalPointDelta = Object.fromEntries(
      ALL_EVAL_POINTS.map((pt) => {
        const currRate = byEvalPoint[pt].passRate
        const prevRate = prev.byEvalPoint[pt].passRate
        return [pt, currRate === null || prevRate === null ? null : Number((currRate - prevRate).toFixed(4))]
      }),
    ) as Record<EvalPointId, number | null>

    baselineDiff = {
      baselineRunId: prev.runId,
      newlyRegressedCaseIds: newlyRegressedCaseIds.sort(),
      newlyFixedCaseIds: newlyFixedCaseIds.sort(),
      evalPointDelta,
    }
  }

  // Issue #92 P1-B：real 模式零执行必须通过顶层 passRate:null 暴露，不能由 0/0 变成假 100%。
  const topLevelPassRate =
    input.coverage !== undefined
      ? input.coverage.executedCases === 0
        ? null
        : Number((outcomes.filter((o) => o.passed).length / outcomes.length).toFixed(4))
      : undefined

  return {
    schemaVersion: '2.2.0',
    executionMode: input.executionMode ?? 'contract_smoke',
    runId: input.runId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    totalCases: outcomes.length,
    ...(topLevelPassRate !== undefined ? { passRate: topLevelPassRate } : {}),
    ...(input.coverage !== undefined ? { coverage: input.coverage } : {}),
    byDataTier,
    byEvalPoint,
    bySuitePool,
    byMinGate,
    firstBreakdowns,
    counterMetricsOk: counterMetricBreaches.length === 0,
    counterMetricBreaches,
    casePassMap,
    ...(baselineDiff ? { baselineDiff } : {}),
  }
}

export function formatEvaluationCardMarkdown(card: EvaluationCard): string {
  const fmtRate = (r: number | null) => (r === null ? '— (NO_DATA)' : `${(r * 100).toFixed(1)}%`)
  const lines: string[] = [
    `# Evaluation Card (${card.runId})`,
    `- Mode: ${card.executionMode} | Generated: ${card.generatedAt} | Cases: ${card.totalCases} | Counter-Metrics: ${card.counterMetricsOk ? 'PASS' : 'BREACHED'}`,
    ...(card.coverage !== undefined
      ? [
          `- Real Source Coverage: ${card.coverage.executedCases}/${card.coverage.totalCases} executed`,
          `- Real Source Case IDs: ${card.coverage.realSourceCaseIds.join(', ') || 'none'}`,
          `- NO_REAL_SOURCE Case IDs: ${card.coverage.noRealSourceCaseIds.join(', ') || 'none'}`,
          `- Overall Pass Rate: ${card.passRate === null || card.passRate === undefined ? '— (NO_DATA)' : `${(card.passRate * 100).toFixed(1)}%`}`,
        ]
      : []),
    '',
    '## By Eval Point (P1–P6)',
    '| Eval Point | Passed / Total | Pass Rate |',
    '| --- | --- | --- |',
  ]
  for (const pt of ALL_EVAL_POINTS) {
    const s = card.byEvalPoint[pt]
    lines.push(`| ${pt} | ${s.passed}/${s.total} | ${fmtRate(s.passRate)} |`)
  }
  lines.push('', '## By Data Tier', '| Data Tier | Passed / Total | Pass Rate |', '| --- | --- | --- |')
  for (const tier of ['tier1_private_corpus', 'tier2_public_benchmark', 'tier3_fault_injection'] as const) {
    const s = card.byDataTier[tier]
    lines.push(`| ${tier} | ${s.passed}/${s.total} | ${fmtRate(s.passRate)} |`)
  }
  if (card.counterMetricBreaches.length > 0) {
    lines.push('', '## Counter-Metric Breaches')
    for (const b of card.counterMetricBreaches) lines.push(`- [${b.metric}] ${b.message}`)
  }
  if (card.firstBreakdowns.length > 0) {
    lines.push('', '## First Breakdown Per Eval Point')
    for (const f of card.firstBreakdowns) lines.push(`- ${f.evalPoint} / ${f.caseId}: ${f.code} — ${f.message}`)
  }
  if (card.baselineDiff) {
    lines.push('', `## Baseline Diff (vs ${card.baselineDiff.baselineRunId})`, `- Newly Regressed: ${card.baselineDiff.newlyRegressedCaseIds.join(', ') || 'none'}`, `- Newly Fixed: ${card.baselineDiff.newlyFixedCaseIds.join(', ') || 'none'}`)
  }
  return lines.join('\n')
}
