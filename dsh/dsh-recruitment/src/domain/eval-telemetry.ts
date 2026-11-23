// Eval V2 Phase 3 — G3 线上生产质量成对护栏只读遥测（对齐 docs/42 §6）。
// 纯只读聚合，零写入、零 PII/UUID/quote/转写原文泄露；查询失败显式标 degraded=true + status='ERROR'，绝不伪装成 NO_DATA。
// 忠实度口径 B：**确定性引用锚定**（逐字 quote 命中同一 tenant + 同一 artifact 的 transcript_segment.content_text），
// 非 L3 LLM 裁判；SQL 里只 count，绝不 select 任何 UUID/quote/转写原文。
import type { DatabaseClient } from '../db/pool.ts'

export interface G3RawTelemetryCounts {
  readonly totalApplications: number
  readonly criterionOverrides: number
  readonly submittedScorecards: number
  readonly pendingScorecards: number
  readonly totalDecisions: number
  readonly supersededDecisions: number
  readonly totalInterviews: number
  readonly cancelledOrRescheduledInterviews: number
  /** 已提交面评里 kind=SEGMENT 的 evidence 引用样本数（确定性逐字锚定的分母）。 */
  readonly faithfulnessQuoteSampleCount: number
  /** 上述引用里 quote 逐字命中同一 tenant + 同一 artifact 的转写分段数（分子）。 */
  readonly faithfulnessQuoteMatchedCount: number
}

export const EMPTY_G3_COUNTS: G3RawTelemetryCounts = {
  totalApplications: 0,
  criterionOverrides: 0,
  submittedScorecards: 0,
  pendingScorecards: 0,
  totalDecisions: 0,
  supersededDecisions: 0,
  totalInterviews: 0,
  cancelledOrRescheduledInterviews: 0,
  faithfulnessQuoteSampleCount: 0,
  faithfulnessQuoteMatchedCount: 0,
}

export type GuardrailStatus = 'OK' | 'WATCH' | 'NO_DATA' | 'ERROR'

export interface PairedGuardrailItem {
  readonly id: 'scorecard_completion_vs_faithfulness' | 'decision_vs_undo' | 'funnel_speed_vs_rework'
  readonly label: string
  readonly primaryRate: number | null
  readonly guardrailRate: number | null
  readonly status: GuardrailStatus
  readonly note: string
}

export interface G3TelemetrySnapshot {
  readonly schema_version: '2.2.0'
  readonly degraded: boolean
  readonly error_code?: string
  readonly counts: G3RawTelemetryCounts
  readonly paired_guardrails: readonly PairedGuardrailItem[]
}

function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Number((numerator / denominator).toFixed(4))
}

export function buildDegradedG3Telemetry(errorCode = 'TELEMETRY_QUERY_FAILED'): G3TelemetrySnapshot {
  const errItem = (id: PairedGuardrailItem['id'], label: string): PairedGuardrailItem => ({
    id,
    label,
    primaryRate: null,
    guardrailRate: null,
    status: 'ERROR',
    note: '遥测查询失败，已降级（不冒充暂无数据）',
  })
  return {
    schema_version: '2.2.0',
    degraded: true,
    error_code: errorCode,
    counts: EMPTY_G3_COUNTS,
    paired_guardrails: [
      errItem('scorecard_completion_vs_faithfulness', '面评按时提交率 × 确定性引用锚定命中率'),
      errItem('decision_vs_undo', '决策确认 × 撤回改判率'),
      errItem('funnel_speed_vs_rework', '面试推进 × 取消/重约返工率'),
    ],
  }
}

export function buildG3PairedGuardrails(counts: G3RawTelemetryCounts): G3TelemetrySnapshot {
  const scorecardTotal = counts.submittedScorecards + counts.pendingScorecards
  const scorecardSubmitRate = safeRate(counts.submittedScorecards, scorecardTotal)
  // 确定性逐字命中率：分母=SEGMENT 引用数，分子=quote 在同一 tenant+artifact 命中数；0 分母返回 null（NO_DATA/诚实缺数，绝不假 0/假 1）。
  const faithfulnessRate = safeRate(counts.faithfulnessQuoteMatchedCount, counts.faithfulnessQuoteSampleCount)
  const hasQuotes = counts.faithfulnessQuoteSampleCount > 0
  const hasScorecards = scorecardTotal > 0

  // 判据：primaryRate 与 guardrailRate 联合；两者都没数据 → NO_DATA；任一走弱 → WATCH；否则 OK。
  const scorecardStatus: GuardrailStatus =
    !hasScorecards && !hasQuotes
      ? 'NO_DATA'
      : (scorecardSubmitRate !== null && scorecardSubmitRate < 0.8)
          || (hasQuotes && faithfulnessRate !== null && faithfulnessRate < 0.8)
        ? 'WATCH'
        : 'OK'

  const undoRate = safeRate(counts.supersededDecisions, counts.totalDecisions)
  const undoStatus: GuardrailStatus =
    undoRate === null ? 'NO_DATA' : undoRate > 0.15 ? 'WATCH' : 'OK'

  const reworkRate = safeRate(counts.cancelledOrRescheduledInterviews, counts.totalInterviews)
  const reworkStatus: GuardrailStatus =
    reworkRate === null ? 'NO_DATA' : reworkRate > 0.2 ? 'WATCH' : 'OK'

  const pct = (rate: number | null): string =>
    rate === null ? '—' : `${(rate * 100).toFixed(1)}%`

  return {
    schema_version: '2.2.0',
    degraded: false,
    counts,
    paired_guardrails: [
      {
        id: 'scorecard_completion_vs_faithfulness',
        label: '面评按时提交率 × 确定性引用锚定命中率',
        primaryRate: scorecardSubmitRate,
        guardrailRate: faithfulnessRate,
        status: scorecardStatus,
        note: [
          // 两个触发条件各自独立出话；同时成立时两句都写，避免 WATCH 却读不到原因（V5 看得见）。
          !hasQuotes
            ? '暂无可抽样引用'
            : faithfulnessRate !== null && faithfulnessRate < 0.8
              ? `确定性引用锚定命中率偏低（${pct(faithfulnessRate)}，<80%），需人工复核面评引用`
              : `引用锚定命中率 ${pct(faithfulnessRate)}（确定性逐字匹配）`,
          scorecardSubmitRate !== null && scorecardSubmitRate < 0.8
            ? '待交面评偏多，需关注积压与草稿复核质量'
            : '面评提交节奏正常',
        ].join('；') + '（确定性引用锚定，非 L3 LLM 裁判）',
      },
      {
        id: 'decision_vs_undo',
        label: '决策确认 × 撤回改判率',
        primaryRate: safeRate(counts.totalDecisions - counts.supersededDecisions, counts.totalDecisions),
        guardrailRate: undoRate,
        status: undoStatus,
        note:
          undoStatus === 'NO_DATA'
            ? '暂无决策样本'
            : undoStatus === 'WATCH'
              ? '撤回改判率超过 15%，请排查前置信息或确认卡提示是否清晰'
              : '决策稳定性正常',
      },
      {
        id: 'funnel_speed_vs_rework',
        label: '面试推进 × 取消/重约返工率',
        primaryRate: safeRate(counts.totalInterviews - counts.cancelledOrRescheduledInterviews, counts.totalInterviews),
        guardrailRate: reworkRate,
        status: reworkStatus,
        note:
          reworkStatus === 'NO_DATA'
            ? '暂无面试排期样本'
            : reworkStatus === 'WATCH'
              ? '面试取消/重约率超过 20%，需检查日程建议准确度'
              : '排期返工率在安全范围内',
      },
    ],
  }
}

function asInt(val: unknown): number {
  const n = Number(val ?? 0)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/**
 * 在只读事务内从现有业务表聚合租户级 G3 遥测（零写入；异常显式返回 degraded=true，严禁静默吞错）。
 *
 * 忠实度采样（口径 B）：一条只读 SQL 里展开已提交 scorecard.items → 维度对象 → evidence[]，
 * 只取 kind='SEGMENT' 的引用；对每条引用用 strpos(ts.content_text, quote) > 0 做确定性逐字校验，
 * 硬条件为同一 tenant_id + 同一 artifact_id（segment_id 仅作文本信息，不参与命中判定：
 * 即便 segment_id 对不上，只要 quote 在同一 artifact 命中仍算命中）。
 * 只输出两个 count 列，绝不 select UUID / quote / 转写原文。
 */
export async function readG3FunnelTelemetry(
  client: DatabaseClient,
  tenantId: string,
): Promise<G3TelemetrySnapshot> {
  try {
    const res = await client.query<{
      total_applications: string
      criterion_overrides: string
      submitted_scorecards: string
      pending_scorecards: string
      total_decisions: string
      superseded_decisions: string
      total_interviews: string
      rework_interviews: string
      faithfulness_quote_sample_count: string
      faithfulness_quote_matched_count: string
    }>(
      `with submitted_scorecards as (
         select sc.tenant_id, sc.items
         from recruitment.scorecard sc
         where sc.tenant_id = $1::uuid
           and sc.status = 'SUBMITTED'
           and sc.items is not null
       ),
       segment_evidence as (
         select
           se.tenant_id,
           ev.value->>'transcript_artifact_id' as artifact_id_text,
           ev.value->>'quote' as quote_text
         from submitted_scorecards se
         cross join lateral jsonb_each(se.items) as dim(dimension_key, dimension_value)
         cross join lateral jsonb_array_elements(
           case
             when jsonb_typeof(dim.dimension_value) = 'object'
                  and jsonb_typeof(dim.dimension_value->'evidence') = 'array'
               then dim.dimension_value->'evidence'
             else '[]'::jsonb
           end
         ) as ev(value)
         where jsonb_typeof(dim.dimension_value) = 'object'
           and ev.value->>'kind' = 'SEGMENT'
       )
       select
         (select count(*) from recruitment.application where tenant_id = $1::uuid)::text as total_applications,
         (select count(*) from recruitment.criterion_override where tenant_id = $1::uuid)::text as criterion_overrides,
         (select count(*) from recruitment.scorecard where tenant_id = $1::uuid and status = 'SUBMITTED')::text as submitted_scorecards,
         (select count(*) from recruitment.scorecard where tenant_id = $1::uuid and status = 'PENDING')::text as pending_scorecards,
         (select count(*) from recruitment.decision where tenant_id = $1::uuid)::text as total_decisions,
         (select count(*) from recruitment.decision where tenant_id = $1::uuid and superseded_by_decision_id is not null)::text as superseded_decisions,
         (select count(*) from recruitment.interview where tenant_id = $1::uuid)::text as total_interviews,
         (select count(*) from recruitment.interview where tenant_id = $1::uuid and status in ('CANCELLED', 'RESCHEDULED'))::text as rework_interviews,
         (select count(*)::text from segment_evidence) as faithfulness_quote_sample_count,
         (select count(*)::text
            from segment_evidence se
            -- 确定性逐字锚定：同一 tenant + 同一 artifact 且 quote 是分段原文的子串。
            -- segment_id（evidence 里可能是数字或字符串）不参与命中：quote 在同一 artifact 命中即算命中。
            where se.artifact_id_text ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              and coalesce(se.quote_text, '') <> ''
              and exists (
                select 1
                from recruitment.transcript_segment ts
                where ts.tenant_id = se.tenant_id
                  and ts.artifact_id = se.artifact_id_text::uuid
                  and strpos(ts.content_text, se.quote_text) > 0
              )) as faithfulness_quote_matched_count`,
      [tenantId],
    )
    const row = res.rows[0]
    if (!row) return buildG3PairedGuardrails(EMPTY_G3_COUNTS)
    return buildG3PairedGuardrails({
      totalApplications: asInt(row.total_applications),
      criterionOverrides: asInt(row.criterion_overrides),
      submittedScorecards: asInt(row.submitted_scorecards),
      pendingScorecards: asInt(row.pending_scorecards),
      totalDecisions: asInt(row.total_decisions),
      supersededDecisions: asInt(row.superseded_decisions),
      totalInterviews: asInt(row.total_interviews),
      cancelledOrRescheduledInterviews: asInt(row.rework_interviews),
      faithfulnessQuoteSampleCount: asInt(row.faithfulness_quote_sample_count),
      faithfulnessQuoteMatchedCount: asInt(row.faithfulness_quote_matched_count),
    })
  } catch (err) {
    const pgCode = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'UNKNOWN'
    console.error(`[eval-telemetry] readG3FunnelTelemetry failed (code=${pgCode})`)
    return buildDegradedG3Telemetry('TELEMETRY_QUERY_FAILED')
  }
}
