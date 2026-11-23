// Eval V2 Phase 3 — G3 线上生产质量成对护栏只读遥测（对齐 docs/42 §6）。
// 纯只读聚合，零写入、零 PII/UUID 泄露；查询失败显式标 degraded=true + status='ERROR'，绝不伪装成 NO_DATA。
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
  readonly blindAuditSampled?: number
  readonly blindAuditAgreed?: number
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
}

export type GuardrailStatus = 'OK' | 'WATCH' | 'NO_DATA' | 'ERROR'

export interface PairedGuardrailItem {
  readonly id: 'override_vs_blind_audit' | 'scorecard_completion_vs_faithfulness' | 'decision_vs_undo' | 'funnel_speed_vs_rework'
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
      errItem('override_vs_blind_audit', 'HR 人工纠偏率 × 盲审抽检一致率'),
      errItem('scorecard_completion_vs_faithfulness', '面评按时提交率 × 抽样原子事实忠实度'),
      errItem('decision_vs_undo', '决策确认 × 撤回改判率'),
      errItem('funnel_speed_vs_rework', '面试推进 × 取消/重约返工率'),
    ],
  }
}

export function buildG3PairedGuardrails(counts: G3RawTelemetryCounts): G3TelemetrySnapshot {
  const overrideRate = safeRate(counts.criterionOverrides, counts.totalApplications)
  const blindAuditRate =
    counts.blindAuditSampled && counts.blindAuditSampled > 0 && counts.blindAuditAgreed !== undefined
      ? safeRate(counts.blindAuditAgreed, counts.blindAuditSampled)
      : null

  const overrideStatus: GuardrailStatus =
    overrideRate === null
      ? 'NO_DATA'
      : overrideRate < 0.05 && blindAuditRate === null && counts.totalApplications >= 20
        ? 'WATCH'
        : 'OK'

  const scorecardTotal = counts.submittedScorecards + counts.pendingScorecards
  const scorecardSubmitRate = safeRate(counts.submittedScorecards, scorecardTotal)
  const scorecardStatus: GuardrailStatus =
    scorecardSubmitRate === null ? 'NO_DATA' : scorecardSubmitRate < 0.8 ? 'WATCH' : 'OK'

  const undoRate = safeRate(counts.supersededDecisions, counts.totalDecisions)
  const undoStatus: GuardrailStatus =
    undoRate === null ? 'NO_DATA' : undoRate > 0.15 ? 'WATCH' : 'OK'

  const reworkRate = safeRate(counts.cancelledOrRescheduledInterviews, counts.totalInterviews)
  const reworkStatus: GuardrailStatus =
    reworkRate === null ? 'NO_DATA' : reworkRate > 0.2 ? 'WATCH' : 'OK'

  return {
    schema_version: '2.2.0',
    degraded: false,
    counts,
    paired_guardrails: [
      {
        id: 'override_vs_blind_audit',
        label: 'HR 人工纠偏率 × 盲审抽检一致率',
        primaryRate: overrideRate,
        guardrailRate: blindAuditRate,
        status: overrideStatus,
        note:
          overrideStatus === 'NO_DATA'
            ? '暂无足够申请样本'
            : overrideStatus === 'WATCH'
              ? '纠偏率低于 5% 且暂无盲审抽检，建议抽样复核防橡皮图章'
              : blindAuditRate === null
                ? '主指标正常（盲审抽检源尚未接入，护栏待补）'
                : '主指标与盲审护栏均正常',
      },
      {
        id: 'scorecard_completion_vs_faithfulness',
        label: '面评按时提交率 × 抽样原子事实忠实度',
        primaryRate: scorecardSubmitRate,
        guardrailRate: null,
        status: scorecardStatus,
        note:
          scorecardStatus === 'NO_DATA'
            ? '暂无面评样本'
            : scorecardStatus === 'WATCH'
              ? '待交面评偏多，需关注积压与草稿复核质量'
              : '面评提交节奏正常（L3 抽样忠实度源尚未接入，护栏待补）',
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

/** 在只读事务内从现有业务表聚合租户级 G3 遥测（零写入；异常显式返回 degraded=true，严禁静默吞错）。 */
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
    }>(
      `select
         (select count(*) from recruitment.application where tenant_id = $1::uuid)::text as total_applications,
         (select count(*) from recruitment.criterion_override where tenant_id = $1::uuid)::text as criterion_overrides,
         (select count(*) from recruitment.scorecard where tenant_id = $1::uuid and status = 'SUBMITTED')::text as submitted_scorecards,
         (select count(*) from recruitment.scorecard where tenant_id = $1::uuid and status = 'PENDING')::text as pending_scorecards,
         (select count(*) from recruitment.decision where tenant_id = $1::uuid)::text as total_decisions,
         (select count(*) from recruitment.decision where tenant_id = $1::uuid and superseded_by_decision_id is not null)::text as superseded_decisions,
         (select count(*) from recruitment.interview where tenant_id = $1::uuid)::text as total_interviews,
         (select count(*) from recruitment.interview where tenant_id = $1::uuid and status in ('CANCELLED', 'RESCHEDULED'))::text as rework_interviews`,
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
    })
  } catch (err) {
    const pgCode = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'UNKNOWN'
    console.error(`[eval-telemetry] readG3FunnelTelemetry failed (code=${pgCode})`)
    return buildDegradedG3Telemetry('TELEMETRY_QUERY_FAILED')
  }
}
