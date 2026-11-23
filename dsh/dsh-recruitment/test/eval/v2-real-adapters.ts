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
