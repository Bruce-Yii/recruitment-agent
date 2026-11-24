// Eval V2 — PG17 真库 P2–P5 及 P6 全周期阶段提取器集成测试。
// 验证：
//   1. 空库/仅种子库时严格 fail-closed（不伪造 P3/P4/P5/P6Funnel）；
//   2. 真实写入完整招聘漏斗记录后，extractStagesFromPg 一次从 PG17 提取 P2/P3/P4/P5/P6-08，
//      直接喂给真实适配器与判分器全部跑通。
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { createIsolatedTestDatabase, HR_ACTOR, TENANT, type IsolatedTestDatabase } from '../integration/db.ts'
import { extractStagesFromPg } from './v2-pg-stage-extractor.ts'
import {
  adaptDecisionSummaryToP5Artifact,
  adaptHandoffBriefToP3Artifact,
  adaptScreeningToP2Artifact,
  adaptTranscriptDraftToP4Artifact,
} from './v2-real-adapters.ts'
import { adaptFunnelTrajectoryToP6Artifact } from './v2-funnel-driver.ts'
import { V2_L1_GRADERS } from './v2-graders-l1.ts'
import { V2_L2_GRADERS } from './v2-graders-l2.ts'

const APP_ID = '11111111-1111-4111-8111-000000000701'
const CAND_ID = '11111111-1111-4111-8111-000000000601'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const INTERVIEWER_ACTOR = '11111111-1111-4111-8111-000000000104'

let db: IsolatedTestDatabase

before(async () => {
  db = await createIsolatedTestDatabase('eval_pg_stages')
})

after(async () => {
  if (db !== undefined) await db.drop()
})

test('PG17 阶段提取器 fail-closed：种子库无面试/转写/决策时绝不伪造 P3/P4/P5/P6Funnel', async () => {
  const client = await db.pool.connect()
  try {
    const extracted = await extractStagesFromPg(client, TENANT, { applicationId: APP_ID })
    assert.equal(extracted.applicationId, APP_ID)
    assert.equal(extracted.p3, undefined)
    assert.equal(extracted.p4, undefined)
    assert.equal(extracted.p5, undefined)
    assert.equal(extracted.p6Funnel, undefined)
    assert.ok(extracted.absentStages.p3)
    assert.ok(extracted.absentStages.p4)
    assert.ok(extracted.absentStages.p5)
  } finally {
    client.release()
  }
})

test('PG17 阶段提取器真漏斗闭环：从真库一次提取 P2–P5 + P6-08 并喂给真实适配器与判分器', async () => {
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query(`select set_config('recruitment.actor_id', $1, true)`, [HR_ACTOR])

    // 0. 复用 0002_seed.sql 已写入的 event_inbox 行作为 intake_record 来源事件
    const evRes = await client.query<{ event_id: string }>(
      `select event_id::text from recruitment.event_inbox where tenant_id = $1::uuid limit 1`,
      [TENANT],
    )
    const eventId = evRes.rows[0]?.event_id
    assert.ok(eventId, '0002_seed.sql 应已写入至少一条 event_inbox')

    // 1. 写入真实 intake_record -> intake_asset -> resume -> resume_version 并挂到 application（P1/P2 真源）
    const intakeRecId = '22222222-2222-4222-8222-000000000009'
    const intakeAssetId = '22222222-2222-4222-8222-000000000010'
    const resumeId = '22222222-2222-4222-8222-000000000011'
    const resumeVerId = '22222222-2222-4222-8222-000000000012'
    const sha64 = 'a'.repeat(64)
    await client.query(
      `insert into recruitment.intake_record (id, tenant_id, event_id, status) values ($1::uuid, $2::uuid, $3::uuid, 'RESOLVED')`,
      [intakeRecId, TENANT, eventId],
    )
    await client.query(
      `insert into recruitment.intake_asset (id, tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref, validation_status)
       values ($1::uuid, $2::uuid, $3::uuid, 'eval-resume.pdf', 'application/pdf', 2048, $4, 'local://eval/eval-resume.pdf', 'VALID')`,
      [intakeAssetId, TENANT, intakeRecId, sha64],
    )
    await client.query(
      `insert into recruitment.resume (id, tenant_id, candidate_id, intake_asset_id) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [resumeId, TENANT, CAND_ID, intakeAssetId],
    )
    await client.query(
      `insert into recruitment.resume_version
         (id, tenant_id, resume_id, version_no, source_asset_sha256, content_sha256, parser_name, parser_version, parse_status, parsed_fields, evidence)
       values ($1::uuid, $2::uuid, $3::uuid, 1, $4, $4, 'pymupdf', '1.0', 'PARSED', $5::jsonb, $6::jsonb)`,
      [
        resumeVerId,
        TENANT,
        resumeId,
        sha64,
        JSON.stringify({ summary: '6 年后端 TypeScript 与 PostgreSQL 生产架构经验' }),
        JSON.stringify([{ key: 'system_design', quote: '6 年后端 TypeScript 与 PostgreSQL 生产架构经验', source_text: '6 年后端 TypeScript 与 PostgreSQL 生产架构经验' }]),
      ],
    )
    await client.query(
      `update recruitment.application set resume_version_id = $1::uuid where tenant_id = $2::uuid and id = $3::uuid`,
      [resumeVerId, TENANT, APP_ID],
    )

    // 2. 写入真实 interview + interviewer + meeting + transcript_artifact + interview_record（P3/P4 真源）
    const interviewId = '22222222-2222-4222-8222-000000000021'
    const interviewerId = '22222222-2222-4222-8222-000000000022'
    const meetingId = '22222222-2222-4222-8222-000000000023'
    const transcriptId = '22222222-2222-4222-8222-000000000024'
    const recordId = '22222222-2222-4222-8222-000000000025'
    await client.query(
      `insert into recruitment.interview (id, tenant_id, application_id, round_no, slot_code, stage_code, status, scheduled_start_at, scheduled_end_at)
       values ($1::uuid, $2::uuid, $3::uuid, 1, 'DEFAULT', 'INTERVIEW', 'POST_INTERVIEW', now() - interval '2 hour', now() - interval '1 hour')`,
      [interviewId, TENANT, APP_ID],
    )
    await client.query(
      `insert into recruitment.interviewer (id, tenant_id, interview_id, actor_id, role_in_interview)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'LEAD')`,
      [interviewerId, TENANT, interviewId, INTERVIEWER_ACTOR],
    )
    await client.query(
      `insert into recruitment.meeting (id, tenant_id, provider, external_meeting_id, meeting_role)
       values ($1::uuid, $2::uuid, 'FEISHU', 'mtg-eval-001', 'PRIMARY')`,
      [meetingId, TENANT],
    )
    await client.query(
      `insert into recruitment.transcript_artifact
         (id, tenant_id, meeting_id, provider, provider_artifact_id, source_revision, transcript_status,
          provenance, trigger_mode, connection_state, content_sha256, is_complete, raw_text, is_canonical)
       values ($1::uuid, $2::uuid, $3::uuid, 'FEISHU', 'min-eval-001', 1, 'READY',
          'LIVE', 'MANUAL', 'CONNECTED', $4, true, '候选人系统设计阐述清晰，无明显短板。', true)`,
      [transcriptId, TENANT, meetingId, sha64],
    )
    await client.query(
      `insert into recruitment.interview_record
         (id, tenant_id, interview_id, transcript_artifact_id, transcript_revision, rubric_version_id,
          prompt_version, model_id, status, verification_status, evidence_ok, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::uuid,
          'v1', 'eval-model', 'READY', 'VERIFIED', true, true)`,
      [recordId, TENANT, interviewId, transcriptId, RUBRIC_ID],
    )

    // 3. 写入真实 scorecard + decision（P5 真源）
    await client.query(
      `insert into recruitment.scorecard
         (tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status, submitted_at, items, overall, rationale)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'SUBMITTED', now(), $5::jsonb, 'STRONG_HIRE', '技术深度与工程落地均扎实')`,
      [TENANT, interviewId, interviewerId, RUBRIC_ID, JSON.stringify({ system_design: 4 })],
    )
    await client.query(
      `insert into recruitment.decision
         (tenant_id, application_id, interview_id, decision_scope, stage_code, result, decided_by_actor_id, reason)
       values ($1::uuid, $2::uuid, $3::uuid, 'FINAL', 'INTERVIEW', 'HIRED', $4::uuid, '一轮表现扎实，真人确认录用')`,
      [TENANT, APP_ID, interviewId, HR_ACTOR],
    )

    // 4. 调真实提取器，验证 P2/P3/P4/P5/P6-08 全部自动提取且真实判分通过
    const extracted = await extractStagesFromPg(client, TENANT, { applicationId: APP_ID })
    assert.ok(extracted.p2, 'P2 应已从 PG17 自动提取')
    assert.ok(extracted.p3, 'P3 应已从 PG17 自动提取')
    assert.ok(extracted.p4, 'P4 应已从 PG17 自动提取')
    assert.ok(extracted.p5, 'P5 应已从 PG17 自动提取')
    assert.ok(extracted.p6Funnel?.p608, 'P6-08 全周期漏斗应已从 PG17 自动提取')

    const p2Art = adaptScreeningToP2Artifact(extracted.p2)
    const p3Art = adaptHandoffBriefToP3Artifact(extracted.p3)
    const p4Art = adaptTranscriptDraftToP4Artifact(extracted.p4)
    const p5Art = adaptDecisionSummaryToP5Artifact(extracted.p5)
    const p6Art = adaptFunnelTrajectoryToP6Artifact('P6-08', extracted.p6Funnel.p608)

    assert.equal(p2Art.evalPoint, 'P2_ScreeningThreeState')
    assert.equal(p3Art.evalPoint, 'P3_LinearRoundHandoff')
    assert.equal(p4Art.evalPoint, 'P4_TranscriptScorecard')
    assert.equal(p5Art.evalPoint, 'P5_DecisionAndTrace')
    assert.equal(V2_L1_GRADERS.L1_person_lifecycle_zero_violation(p6Art).ok, true)
    assert.equal(V2_L2_GRADERS.L2_handoff_integrity_100(p6Art).ok, true)

    await client.query('rollback')
  } finally {
    client.release()
  }
})
