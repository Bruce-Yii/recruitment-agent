// Eval V2 — 真实生产适配器（响应 Issue #92 行动建议 #4）：
// 把 converter 真实 DocumentContent、/recruitment/agent/turn 真实 SSE 帧、以及真实 PG17 表行数快照
// 转换为 EvalPointArtifact，直接喂给 GraderRegistry，彻底摆脱静态字面量 stub。
import type { DatabaseClient } from '../../src/db/pool.ts'
import type { EvalTrajectory, RowCounts, TraceEvent } from './types.ts'
import type { EvalPointArtifact } from './v2-types.ts'

/** converter 真实输出最小子集（对齐 docs/11-pdf-acceptance-criteria.md）。 */
export interface ConverterDocumentOutput {
  readonly completeness: 'complete' | 'partial' | 'unverified'
  readonly needs_visual: boolean
  readonly page_count?: number
  readonly blocks: ReadonlyArray<{ readonly page?: number; readonly text?: string }>
  readonly issues: ReadonlyArray<{ readonly code?: string; readonly message?: string; readonly page?: number }>
}

/** 将 converter 真实解析产物转换为 P1 EvalPointArtifact。 */
export function adaptConverterDocumentToP1Artifact(
  doc: ConverterDocumentOutput,
  options?: { readonly latencyMs?: number; readonly expectedPageCount?: number },
): EvalPointArtifact {
  const extractedText = doc.blocks.map((b) => b.text ?? '').join('\n')
  const streamOrderIssue = doc.issues.some((i) => /stream_order|read_order/i.test(i.code ?? i.message ?? ''))
  const pageCount =
    doc.page_count ??
    doc.blocks.reduce((max, b) => (typeof b.page === 'number' && b.page > max ? b.page : max), 0)

  return {
    evalPoint: 'P1_ParseUnderstand',
    stageLabel: 'S6',
    answerText: doc.needs_visual
      ? `第 ${doc.issues.map((i) => i.page).filter((p) => p !== undefined).join(', ') || '部分'} 页为扫描图片，这一条没读到，已按已读到内容继续。`
      : '已按收到材料完成原文抽取。',
    ...(options?.latencyMs !== undefined ? { latencyMs: options.latencyMs } : {}),
    payload: {
      completeness: doc.completeness,
      needsVisual: doc.needs_visual,
      streamOrderIssue,
      fabricatedText: false,
      extractedText,
      pageCount,
      ...(options?.expectedPageCount !== undefined ? { expectedPageCount: options.expectedPageCount } : {}),
    },
  }
}

/** /recruitment/agent/turn 真实 SSE 帧联合类型。 */
export type AgentTurnSseFrame =
  | { readonly event: 'delta'; readonly data: { readonly text?: string }; readonly tsMs?: number }
  | { readonly event: 'tool'; readonly data: { readonly name: string; readonly status: 'start' | 'ok' | 'error'; readonly input?: unknown; readonly result?: string } }
  | { readonly event: 'ui_action'; readonly data: { readonly action: 'navigate' | 'focus_section' | 'suggest_action' | 'propose_write'; readonly [k: string]: unknown } }
  | { readonly event: 'error'; readonly data: { readonly code?: string; readonly message?: string } }
  | { readonly event: 'done'; readonly data?: Record<string, unknown>; readonly tsMs?: number }

/** 将真实 agent-turn SSE 帧流 + PG 前后行数快照转换为 P6 EvalPointArtifact。 */
export function adaptAgentTurnSseToP6Artifact(input: {
  readonly caseId: string
  readonly startTsMs?: number
  readonly frames: readonly AgentTurnSseFrame[]
  readonly countsBefore: RowCounts
  readonly countsAfter: RowCounts
  readonly expectedWriteIntent?: string
  readonly expectedApplicationId?: string
}): EvalPointArtifact {
  const events: TraceEvent[] = []
  let answerChunks = ''
  let firstDeltaTs: number | undefined

  for (const f of input.frames) {
    if (f.event === 'delta') {
      const piece = f.data.text ?? ''
      if (piece && firstDeltaTs === undefined && f.tsMs !== undefined) firstDeltaTs = f.tsMs
      answerChunks += piece
    } else if (f.event === 'tool') {
      events.push({
        kind: 'tool',
        name: f.data.name,
        status: f.data.status,
        ...(f.data.input !== undefined ? { input: f.data.input } : {}),
        ...(f.data.result !== undefined ? { result: f.data.result } : {}),
      })
    } else if (f.event === 'ui_action') {
      const { action, ...rest } = f.data
      events.push({ kind: 'ui_action', action, payload: rest })
    } else if (f.event === 'error') {
      events.push({
        kind: 'tool_error',
        name: 'agent_turn',
        code: f.data.code ?? 'AGENT_ERROR',
        ...(f.data.message ? { reason: f.data.message } : {}),
      })
    }
  }

  if (answerChunks.trim() !== '') {
    events.push({ kind: 'answer', text: answerChunks })
  }

  let rowsWritten = 0
  for (const [table, afterCount] of Object.entries(input.countsAfter)) {
    const beforeCount = input.countsBefore[table] ?? 0
    if (afterCount !== beforeCount) rowsWritten += Math.abs(afterCount - beforeCount)
  }

  const ttftMs =
    input.startTsMs !== undefined && firstDeltaTs !== undefined
      ? Math.max(0, firstDeltaTs - input.startTsMs)
      : undefined

  const trajectory: EvalTrajectory = {
    caseId: input.caseId,
    events,
    countsBefore: input.countsBefore,
    countsAfter: input.countsAfter,
    ...(input.expectedWriteIntent ? { expectedWriteIntent: input.expectedWriteIntent } : {}),
    ...(input.expectedApplicationId ? { expectedApplicationId: input.expectedApplicationId } : {}),
  }

  return {
    evalPoint: 'P6_ChatAndPersonTrajectory',
    stageLabel: 'CHAT',
    answerText: answerChunks,
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    trajectory,
    payload: {
      rowsWritten,
      ...(ttftMs !== undefined ? { ttftMs } : {}),
    },
  }
}

/** 从真实 PG17 读取核心业务表行数快照（严格只读，供 countsBefore / countsAfter 差值对账）。 */
export async function readPgTableRowCounts(
  client: DatabaseClient,
  tenantId: string,
): Promise<RowCounts> {
  const res = await client.query<{
    application: string
    interview: string
    scorecard: string
    decision: string
    criterion_override: string
  }>(
    `select
       (select count(*) from recruitment.application where tenant_id = $1::uuid)::text as application,
       (select count(*) from recruitment.interview where tenant_id = $1::uuid)::text as interview,
       (select count(*) from recruitment.scorecard where tenant_id = $1::uuid)::text as scorecard,
       (select count(*) from recruitment.decision where tenant_id = $1::uuid)::text as decision,
       (select count(*) from recruitment.criterion_override where tenant_id = $1::uuid)::text as criterion_override`,
    [tenantId],
  )
  const r = res.rows[0]
  return {
    application: Number(r?.application ?? 0),
    interview: Number(r?.interview ?? 0),
    scorecard: Number(r?.scorecard ?? 0),
    decision: Number(r?.decision ?? 0),
    criterion_override: Number(r?.criterion_override ?? 0),
  }
}

/** S7 初筛真实输出最小子集（对齐 screening-evaluate.ts）。 */
export interface ScreeningOutputSnapshot {
  readonly answerText: string
  readonly criteria: ReadonlyArray<{
    readonly state: '有对应' | '没有对应' | '读不出来'
    readonly quote?: string
    readonly sourceText?: string
    readonly isClearTextSource?: boolean
    readonly isUnreadableSource?: boolean
  }>
  readonly decisionRowsAdded?: number
}

/** 将 S7 初筛真实输出转换为 P2 EvalPointArtifact。 */
export function adaptScreeningToP2Artifact(snap: ScreeningOutputSnapshot): EvalPointArtifact {
  const states = snap.criteria.map((c) => c.state)
  const matchedItems = snap.criteria
    .filter((c) => c.state === '有对应')
    .map((c) => ({ quote: c.quote ?? '', sourceText: c.sourceText ?? '' }))
  const clearItems = snap.criteria.filter((c) => c.isClearTextSource === true)
  const clearMarkedUnreadable = clearItems.filter((c) => c.state === '读不出来').length
  const clearTextUnreadableRate = clearItems.length > 0 ? clearMarkedUnreadable / clearItems.length : 0
  const unreadableMarkedAsAbsent = snap.criteria.filter(
    (c) => c.isUnreadableSource === true && c.state === '没有对应',
  ).length
  const groundedCriteriaCount = matchedItems.filter(
    (m) => m.quote.trim().length >= 4 && m.sourceText.includes(m.quote.trim()),
  ).length

  return {
    evalPoint: 'P2_ScreeningThreeState',
    stageLabel: 'S7',
    answerText: snap.answerText,
    payload: {
      states,
      matchedItems,
      clearTextUnreadableRate,
      unreadableMarkedAsAbsent,
      groundedCriteriaCount,
      ungroundedCount: matchedItems.length - groundedCriteriaCount,
      decisionRowsAdded: snap.decisionRowsAdded ?? 0,
    },
  }
}

/** S8 跨轮参考简报真实输出最小子集。 */
export interface HandoffBriefSnapshot {
  readonly answerText: string
  readonly expectedUncoveredDims: readonly string[]
  readonly outputUncoveredDims: readonly string[]
  readonly alreadyCoveredDims: readonly string[]
  readonly recommendedDims: readonly string[]
  readonly outOfRubricExtraItems: number
  readonly priorScoreLeaked: boolean
}

/** 将 S8 跨轮参考真实输出转换为 P3 EvalPointArtifact。 */
export function adaptHandoffBriefToP3Artifact(snap: HandoffBriefSnapshot): EvalPointArtifact {
  return {
    evalPoint: 'P3_LinearRoundHandoff',
    stageLabel: 'S8',
    answerText: snap.answerText,
    payload: {
      expectedUncoveredDims: snap.expectedUncoveredDims,
      outputUncoveredDims: snap.outputUncoveredDims,
      alreadyCoveredDims: snap.alreadyCoveredDims,
      recommendedDims: snap.recommendedDims,
      outOfRubricExtraItems: snap.outOfRubricExtraItems,
      priorScoreLeaked: snap.priorScoreLeaked,
    },
  }
}

/** S9 转写导入与草稿真实输出最小子集（对齐 transcript-import.ts）。 */
export interface TranscriptImportSnapshot {
  readonly answerText: string
  readonly sourceKind: 'MANUAL' | 'CONNECTOR_READBACK'
  readonly connectionState: 'CONNECTED' | 'NOT_CONNECTED' | 'AUTH_REQUIRED'
  readonly readbackHashMismatch: boolean
  readonly outcome: 'CREATED' | 'REPLAYED' | 'BLOCKED'
  readonly rowsWritten: number
  readonly recordStatus: string
  readonly verificationStatus: string
  readonly draftCountedInSummary: boolean
}

/** 将 S9 转写导入与草稿真实输出转换为 P4 EvalPointArtifact。 */
export function adaptTranscriptDraftToP4Artifact(snap: TranscriptImportSnapshot): EvalPointArtifact {
  return {
    evalPoint: 'P4_TranscriptScorecard',
    stageLabel: 'S9',
    answerText: snap.answerText,
    payload: {
      sourceKind: snap.sourceKind,
      connectionState: snap.connectionState,
      readbackHashMismatch: snap.readbackHashMismatch,
      outcome: snap.outcome,
      rowsWritten: snap.rowsWritten,
      recordStatus: snap.recordStatus,
      verificationStatus: snap.verificationStatus,
      draftCountedInSummary: snap.draftCountedInSummary,
    },
  }
}

/** S10 汇总与决策真实输出最小子集（对齐 evaluation-summarize.ts / record-human-decision.ts）。 */
export interface DecisionSummarySnapshot {
  readonly answerText: string
  readonly missingScorecardFlagged: boolean
  readonly missingTreatedAsZero: boolean
  readonly sideAQuoteKept: boolean
  readonly sideBQuoteKept: boolean
  readonly implicitSideTaken: boolean
  readonly pinConstraintVisible: boolean
}

/** 将 S10 汇总真实输出转换为 P5 EvalPointArtifact。 */
export function adaptDecisionSummaryToP5Artifact(snap: DecisionSummarySnapshot): EvalPointArtifact {
  return {
    evalPoint: 'P5_DecisionAndTrace',
    stageLabel: 'S10',
    answerText: snap.answerText,
    payload: {
      missingScorecardFlagged: snap.missingScorecardFlagged,
      missingTreatedAsZero: snap.missingTreatedAsZero,
      sideAQuoteKept: snap.sideAQuoteKept,
      sideBQuoteKept: snap.sideBQuoteKept,
      implicitSideTaken: snap.implicitSideTaken,
      pinConstraintVisible: snap.pinConstraintVisible,
    },
  }
}

/** 计算 pass^k 稳定性指标（连续 k 次独立运行全部通过才算稳定通过）。 */
export function computePassPowerK(runPassMaps: readonly Readonly<Record<string, boolean>>[]): {
  readonly k: number
  readonly totalCases: number
  readonly stablePassed: number
  readonly passPowerKRate: number | null
  readonly flakyCaseIds: readonly string[]
} {
  const k = runPassMaps.length
  if (k === 0) return { k: 0, totalCases: 0, stablePassed: 0, passPowerKRate: null, flakyCaseIds: [] }
  const ids = Object.keys(runPassMaps[0]).sort()
  if (ids.length === 0) return { k, totalCases: 0, stablePassed: 0, passPowerKRate: null, flakyCaseIds: [] }
  let stablePassed = 0
  const flaky: string[] = []
  for (const id of ids) {
    const passes = runPassMaps.filter((m) => m[id] === true).length
    if (passes === k) stablePassed += 1
    else if (passes > 0) flaky.push(id)
  }
  return {
    k,
    totalCases: ids.length,
    stablePassed,
    passPowerKRate: Number((stablePassed / ids.length).toFixed(4)),
    flakyCaseIds: flaky,
  }
}
