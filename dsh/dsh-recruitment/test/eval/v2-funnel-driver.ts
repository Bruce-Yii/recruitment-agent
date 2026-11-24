// Eval V2 — P6-08 / P6-09 跨阶段全周期漏斗轨迹适配器（对齐 docs/42 §8.6）。
// Fail-closed：任一阶段缺失、身份断链、未核验转写冒充终版、或复盘违规用新岗标倒推旧决定，均明确计入违规/断链列表。
import type { EvalPointArtifact } from './v2-types.ts'

export const REQUIRED_SIX_MONTH_AUDIT_NODES = [
  'screening_override',
  'round1_brief',
  'round2_collapse_evidence',
  'human_reject_decision',
  'frozen_rubric_snapshot',
] as const

export interface FunnelStageSnapshot {
  readonly candidateId?: string
  readonly jobId?: string
  readonly p1?: { readonly documentSha256?: string; readonly candidateId?: string }
  readonly p2?: { readonly candidateId?: string; readonly jobId?: string; readonly rubricVersion?: string; readonly overrideRecorded?: boolean }
  readonly p3?: { readonly candidateId?: string; readonly jobId?: string; readonly briefGenerated?: boolean }
  readonly p4?: { readonly candidateId?: string; readonly transcriptVerified?: boolean; readonly treatedAsFinalWithoutVerify?: boolean }
  readonly p5?: { readonly candidateId?: string; readonly humanConfirmed?: boolean; readonly outcome?: 'hire' | 'reject' | 'hold' }
  readonly audit?: {
    readonly presentNodes?: readonly string[]
    readonly originalRubricVersion?: string
    readonly reviewRubricVersion?: string
  }
}

export function adaptFunnelTrajectoryToP6Artifact(
  caseId: 'P6-08' | 'P6-09',
  snap: FunnelStageSnapshot,
): EvalPointArtifact {
  let lifecycleViolations = 0
  const brokenHandoffs: string[] = []

  // 硬红线检查（贯穿 P1 -> P5）
  if (!snap.p1?.documentSha256) lifecycleViolations += 1
  if (!snap.p2?.rubricVersion) lifecycleViolations += 1
  if (snap.p4?.treatedAsFinalWithoutVerify === true) lifecycleViolations += 1
  if (snap.p5?.humanConfirmed !== true) lifecycleViolations += 1

  // 跨阶段交接连续性检查（P6-08 核心）
  const cid = snap.candidateId
  const jid = snap.jobId
  if (!cid || snap.p1?.candidateId !== cid || snap.p2?.candidateId !== cid) {
    brokenHandoffs.push('P1->P2:candidate_id_mismatch')
  }
  if (!jid || snap.p2?.jobId !== jid || snap.p3?.jobId !== jid || snap.p3?.candidateId !== cid) {
    brokenHandoffs.push('P2->P3:handoff_context_broken')
  }
  if (!snap.p3?.briefGenerated || snap.p4?.candidateId !== cid) {
    brokenHandoffs.push('P3->P4:interview_brief_to_transcript_broken')
  }
  if (snap.p4?.transcriptVerified !== true || snap.p5?.candidateId !== cid) {
    brokenHandoffs.push('P4->P5:unverified_or_unlinked_decision')
  }
  if (!snap.p5?.humanConfirmed || !snap.audit?.originalRubricVersion) {
    brokenHandoffs.push('P5->review:missing_decision_or_rubric_snapshot')
  }

  // 半年复盘追责链检查（P6-09 核心）
  const presentSet = new Set(snap.audit?.presentNodes ?? [])
  const missingAuditNodes = REQUIRED_SIX_MONTH_AUDIT_NODES.filter((node) => !presentSet.has(node))
  const origRubric = snap.audit?.originalRubricVersion
  const reviewRubric = snap.audit?.reviewRubricVersion
  const retroactivelyUsedNewRubric = Boolean(origRubric && reviewRubric && origRubric !== reviewRubric)

  return {
    evalPoint: 'P6_ChatAndPersonTrajectory',
    stageLabel: caseId,
    answerText: `funnel_trajectory:${caseId}`,
    payload: {
      lifecycleViolations,
      brokenHandoffs,
      missingAuditNodes,
      retroactivelyUsedNewRubric,
    },
  }
}
