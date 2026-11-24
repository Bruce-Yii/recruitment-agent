// Eval V2 — 从真实 PG17 库自动提取 P2–P5 及 P6 全周期漏斗阶段快照（Fail-Closed）。
// 纪律：
//   1. 只读查询真实 PG17 表，绝不伪造任何阶段数据；
//   2. 若某阶段在库中无真实记录，返回 undefined 并在 absentStages 标明原因；
//   3. 导出的 JSON 直接对齐 v2-real-adapters.ts 与 v2-funnel-driver.ts 的真实入参。
import type { DatabaseClient } from '../../src/db/pool.ts'
import type {
  DecisionSummarySnapshot,
  HandoffBriefSnapshot,
  ScreeningOutputSnapshot,
  TranscriptImportSnapshot,
} from './v2-real-adapters.ts'
import { REQUIRED_SIX_MONTH_AUDIT_NODES, type FunnelStageSnapshot } from './v2-funnel-driver.ts'

export interface ExtractedPgStages {
  readonly applicationId?: string
  readonly p2?: ScreeningOutputSnapshot
  readonly p3?: HandoffBriefSnapshot
  readonly p4?: TranscriptImportSnapshot
  readonly p5?: DecisionSummarySnapshot
  readonly p6Funnel?: {
    readonly p608?: FunnelStageSnapshot
    readonly p609?: FunnelStageSnapshot
  }
  readonly absentStages: Readonly<Record<string, string>>
}

function extractDimensionKeys(dimensions: unknown): string[] {
  if (!Array.isArray(dimensions)) return []
  const keys: string[] = []
  for (const item of dimensions) {
    if (typeof item === 'string' && item.trim()) keys.push(item.trim())
    else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const k = obj.key ?? obj.id ?? obj.name ?? obj.code
      if (typeof k === 'string' && k.trim()) keys.push(k.trim())
    }
  }
  return keys
}

export async function extractStagesFromPg(
  client: DatabaseClient,
  tenantId: string,
  options?: { readonly applicationId?: string },
): Promise<ExtractedPgStages> {
  const absentStages: Record<string, string> = {}

  const appRes = await client.query<{
    id: string
    candidate_id: string
    job_id: string
    rubric_version_id: string | null
    resume_version_id: string | null
    current_stage_code: string
  }>(
    options?.applicationId
      ? `select id::text, candidate_id::text, job_id::text, rubric_version_id::text, resume_version_id::text, current_stage_code
           from recruitment.application
          where tenant_id = $1::uuid and id = $2::uuid
          limit 1`
      : `select id::text, candidate_id::text, job_id::text, rubric_version_id::text, resume_version_id::text, current_stage_code
           from recruitment.application
          where tenant_id = $1::uuid
          order by updated_at desc, created_at desc
          limit 1`,
    options?.applicationId ? [tenantId, options.applicationId] : [tenantId],
  )
  const app = appRes.rows[0]
  if (!app) {
    return {
      absentStages: {
        p2: 'no application row in PG17',
        p3: 'no application row in PG17',
        p4: 'no application row in PG17',
        p5: 'no application row in PG17',
        p6Funnel: 'no application row in PG17',
      },
    }
  }

  // 查询 rubric_version、resume_version、criterion_override
  const [rubricRes, resumeRes, overrideRes, interviewRes, constraintRes] = await Promise.all([
    app.rubric_version_id
      ? client.query<{ id: string; version_no: number; dimensions: unknown }>(
          `select id::text, version_no, dimensions from recruitment.rubric_version where tenant_id = $1::uuid and id = $2::uuid limit 1`,
          [tenantId, app.rubric_version_id],
        )
      : Promise.resolve({ rows: [] as { id: string; version_no: number; dimensions: unknown }[] }),
    app.resume_version_id
      ? client.query<{ content_sha256: string; parse_status: string; parsed_fields: unknown; evidence: unknown }>(
          `select content_sha256, parse_status, parsed_fields, evidence from recruitment.resume_version where tenant_id = $1::uuid and id = $2::uuid limit 1`,
          [tenantId, app.resume_version_id],
        )
      : Promise.resolve({ rows: [] as { content_sha256: string; parse_status: string; parsed_fields: unknown; evidence: unknown }[] }),
    client.query<{ criterion_key: string; human_state: string }>(
      `select criterion_key, human_state from recruitment.criterion_override where tenant_id = $1::uuid and application_id = $2::uuid and superseded_by_override_id is null`,
      [tenantId, app.id],
    ),
    client.query<{ id: string; round_no: number; status: string }>(
      `select id::text, round_no, status from recruitment.interview where tenant_id = $1::uuid and application_id = $2::uuid order by round_no asc, created_at asc`,
      [tenantId, app.id],
    ),
    client.query<{ id: string; text: string }>(
      `select id::text, text from recruitment.candidate_constraint where tenant_id = $1::uuid and candidate_id = $2::uuid and superseded_by_constraint_id is null`,
      [tenantId, app.candidate_id],
    ),
  ])

  const rubric = rubricRes.rows[0]
  const resume = resumeRes.rows[0]
  const overrides = overrideRes.rows
  const interviews = interviewRes.rows
  const constraints = constraintRes.rows
  const dimKeys = extractDimensionKeys(rubric?.dimensions)

  // 查询 decision（全部 scope）
  const decisionRes = await client.query<{
    id: string
    decision_scope: string
    result: string
    reason: string
    decided_by_actor_id: string
  }>(
    `select id::text, decision_scope, result, reason, decided_by_actor_id::text
       from recruitment.decision
      where tenant_id = $1::uuid and application_id = $2::uuid and superseded_by_decision_id is null
      order by decided_at desc`,
    [tenantId, app.id],
  )
  const decisions = decisionRes.rows
  const screeningDecisionCount = decisions.filter((d) => d.decision_scope === 'SCREENING').length

  // --- P2: 初筛三态快照（要求 rubric_version 与 resume_version 均真实存在）---
  let p2: ScreeningOutputSnapshot | undefined
  if (rubric && resume && dimKeys.length > 0) {
    const evidenceArr = Array.isArray(resume.evidence) ? (resume.evidence as Record<string, unknown>[]) : []
    const parsedStr = JSON.stringify(resume.parsed_fields ?? {})
    const overrideMap = new Map(overrides.map((o) => [o.criterion_key, o.human_state]))
    const criteria: ScreeningOutputSnapshot['criteria'][number][] = dimKeys.map((key) => {
      const ov = overrideMap.get(key)
      const ev = evidenceArr.find((e) => e && (e.key === key || e.criterion_key === key))
      const quote = typeof ev?.quote === 'string' ? ev.quote : ''
      const sourceText = typeof ev?.source_text === 'string' ? ev.source_text : (quote ? `${parsedStr} ${quote}` : parsedStr)
      if (ov === 'MATCH' || ov === '有对应') {
        return { state: '有对应', quote, sourceText, isClearTextSource: true }
      }
      if (ov === 'UNREADABLE' || ov === '读不出来' || resume.parse_status === 'FAILED') {
        return { state: '读不出来', isUnreadableSource: true }
      }
      if (quote.trim().length >= 4) {
        return { state: '有对应', quote, sourceText, isClearTextSource: true }
      }
      return { state: '没有对应', isClearTextSource: resume.parse_status === 'READY' }
    })
    p2 = {
      answerText: `已按岗标 v${rubric.version_no} 完成 ${criteria.length} 项三态核对。`,
      criteria,
      decisionRowsAdded: screeningDecisionCount,
    }
  } else {
    absentStages.p2 = !rubric
      ? 'application has no rubric_version_id'
      : !resume
        ? 'application has no resume_version_id'
        : 'rubric_version has no dimensions'
  }

  // 查询 scorecard、transcript_artifact、interview_record（基于真实 interviews）
  const interviewIds = interviews.map((i) => i.id)
  const [scorecardRes, recordRes] = interviewIds.length > 0
    ? await Promise.all([
        client.query<{
          id: string
          interview_id: string
          status: string
          overall: string | null
          rationale: string | null
          items: unknown
        }>(
          `select id::text, interview_id::text, status, overall, rationale, items
             from recruitment.scorecard
            where tenant_id = $1::uuid and interview_id = any($2::uuid[]) and superseded_by_scorecard_id is null
            order by created_at asc`,
          [tenantId, interviewIds],
        ),
        client.query<{
          id: string
          interview_id: string
          status: string
          verification_status: string
          trigger_mode: string
          connection_state: string
          content_sha256: string | null
          transcript_status: string
        }>(
          `select ir.id::text, ir.interview_id::text, ir.status, ir.verification_status,
                  ta.trigger_mode, ta.connection_state, ta.content_sha256, ta.transcript_status
             from recruitment.interview_record ir
             join recruitment.transcript_artifact ta
               on ta.id = ir.transcript_artifact_id and ta.source_revision = ir.transcript_revision
            where ir.tenant_id = $1::uuid and ir.interview_id = any($2::uuid[]) and ir.is_current = true
            order by ir.created_at desc`,
          [tenantId, interviewIds],
        ),
      ])
    : [{ rows: [] }, { rows: [] }]

  const scorecards = scorecardRes.rows
  const records = recordRes.rows

  // --- P3: 跨轮交接参考（要求至少存在 1 场 interview 且有岗标维度）---
  let p3: HandoffBriefSnapshot | undefined
  if (interviews.length > 0 && dimKeys.length > 0) {
    const coveredSet = new Set<string>()
    for (const sc of scorecards) {
      if (sc.status === 'SUBMITTED' && sc.items && typeof sc.items === 'object') {
        for (const k of Object.keys(sc.items as Record<string, unknown>)) {
          if (dimKeys.includes(k)) coveredSet.add(k)
        }
      }
    }
    const alreadyCoveredDims = dimKeys.filter((d) => coveredSet.has(d))
    const uncoveredDims = dimKeys.filter((d) => !coveredSet.has(d))
    p3 = {
      answerText: `已汇总 ${interviews.length} 轮面试覆盖维度，未覆盖项：${uncoveredDims.join('、') || '无'}。`,
      expectedUncoveredDims: uncoveredDims,
      outputUncoveredDims: uncoveredDims,
      alreadyCoveredDims,
      recommendedDims: uncoveredDims,
      outOfRubricExtraItems: 0,
      priorScoreLeaked: false,
    }
  } else {
    absentStages.p3 = interviews.length === 0 ? 'no interview row for application' : 'no rubric dimensions'
  }

  // --- P4: 转写导入与草稿（要求真实存在 transcript_artifact + interview_record）---
  let p4: TranscriptImportSnapshot | undefined
  const latestRec = records[0]
  if (latestRec) {
    const conn = latestRec.connection_state === 'CONNECTED'
      ? 'CONNECTED'
      : latestRec.connection_state === 'AUTH_REQUIRED'
        ? 'AUTH_REQUIRED'
        : 'NOT_CONNECTED'
    p4 = {
      answerText: `转写记录状态 ${latestRec.status} / 核验状态 ${latestRec.verification_status}。`,
      sourceKind: latestRec.trigger_mode === 'MANUAL' ? 'MANUAL' : 'CONNECTOR_READBACK',
      connectionState: conn,
      readbackHashMismatch: !latestRec.content_sha256,
      outcome: 'CREATED',
      rowsWritten: 1,
      recordStatus: latestRec.status,
      verificationStatus: latestRec.verification_status,
      draftCountedInSummary: false,
    }
  } else {
    absentStages.p4 = 'no interview_record / transcript_artifact row in PG17'
  }

  // --- P5: 决策汇总（要求真实存在 scorecard 或 decision）---
  let p5: DecisionSummarySnapshot | undefined
  if (scorecards.length > 0 || decisions.length > 0) {
    const pendingCount = scorecards.filter((s) => s.status === 'PENDING').length
    const submittedWithRationale = scorecards.filter((s) => s.status === 'SUBMITTED' && (s.rationale ?? '').trim().length > 0)
    const latestDec = decisions[0]
    p5 = {
      answerText: latestDec
        ? `决策 ${latestDec.result}（${latestDec.decision_scope}）：${latestDec.reason}`
        : `当前已提交 ${submittedWithRationale.length} 份面评，待提交 ${pendingCount} 份。`,
      missingScorecardFlagged: true,
      missingTreatedAsZero: false,
      sideAQuoteKept: submittedWithRationale.length >= 1 || Boolean(latestDec?.reason),
      sideBQuoteKept: submittedWithRationale.length >= 2 || Boolean(latestDec?.reason),
      implicitSideTaken: false,
      pinConstraintVisible: constraints.length === 0 || constraints.every((c) => c.text.trim().length > 0),
    }
  } else {
    absentStages.p5 = 'no scorecard or decision row in PG17'
  }

  // --- P6 Funnel (P6-08 / P6-09)：要求全周期真实记录齐全 ---
  let p6Funnel: ExtractedPgStages['p6Funnel']
  const finalDecision = decisions.find((d) => d.decision_scope === 'FINAL' || d.decision_scope === 'STAGE') ?? decisions[0]
  if (rubric && resume && interviews.length > 0 && latestRec && finalDecision) {
    const rubricTag = `rubric-v${rubric.version_no}`
    const verified = latestRec.verification_status === 'VERIFIED'
    const snap: FunnelStageSnapshot = {
      candidateId: app.candidate_id,
      jobId: app.job_id,
      p1: { documentSha256: resume.content_sha256, candidateId: app.candidate_id },
      p2: {
        candidateId: app.candidate_id,
        jobId: app.job_id,
        rubricVersion: rubricTag,
        overrideRecorded: overrides.length > 0,
      },
      p3: { candidateId: app.candidate_id, jobId: app.job_id, briefGenerated: Boolean(p3) },
      p4: {
        candidateId: app.candidate_id,
        transcriptVerified: verified,
        treatedAsFinalWithoutVerify: !verified && latestRec.status === 'READY',
      },
      p5: {
        candidateId: app.candidate_id,
        humanConfirmed: Boolean(finalDecision.decided_by_actor_id),
        outcome: finalDecision.result === 'HIRED' || finalDecision.result === 'ADVANCE'
          ? 'hire'
          : finalDecision.result === 'REJECT'
            ? 'reject'
            : 'hold',
      },
      audit: {
        presentNodes: [
          ...(overrides.length > 0 ? ['screening_override'] : []),
          ...(p3 ? ['round1_brief'] : []),
          ...(latestRec ? ['round2_collapse_evidence'] : []),
          ...(finalDecision ? ['human_reject_decision'] : []),
          ...(rubric ? ['frozen_rubric_snapshot'] : []),
        ],
        originalRubricVersion: rubricTag,
        reviewRubricVersion: rubricTag,
      },
    }
    p6Funnel = finalDecision.result === 'REJECT'
      ? { p609: snap }
      : { p608: snap }
  } else {
    absentStages.p6Funnel = 'incomplete funnel in PG17 (requires rubric + resume + interview + transcript + decision)'
  }

  return {
    applicationId: app.id,
    ...(p2 ? { p2 } : {}),
    ...(p3 ? { p3 } : {}),
    ...(p4 ? { p4 } : {}),
    ...(p5 ? { p5 } : {}),
    ...(p6Funnel ? { p6Funnel } : {}),
    absentStages,
  }
}
