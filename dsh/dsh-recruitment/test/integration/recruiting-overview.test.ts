// Recruiting Workspace 只读投影（W2-A）的**真库**集成测试（只读；**自包含**）。
//
// 为什么自包含：CI 的 plugin job 用**全新数据库**（0001→0016 迁移 + 0002 seed，没有任何本地
// 演示增量），所以本文件**不依赖任何本地演示行**（不假设 701 有材料、不假设存在 e61380dc/
// DRAFT 岗位/转写行）。每个用例在 `inRolledBackTx` 里**自己插 fixture**（独立 UUID/独特键），
// 事务结束一律 ROLLBACK；断言只针对自造行 + 独立 SQL（本文件自己写 SELECT，不 import 投影内部查询）。
//
// 唯一使用迁移 seed 的地方：`CFG.actor_id`（0002 seed 的 103）是**插件配置身份**，投影必须能解析它；
// 只读事务用例用迁移自带的 1 条 application 证明"只读事务里可跑投影"（0002 seed 是迁移的一部分，
// CI fresh DB 必有，不属于本地演示增量）。
//
// 纪律（`test/integration/db.ts` + 任务书）：
//   1. 每个用例都在 `inRolledBackTx` 里跑并一律 ROLLBACK —— 不污染共享库；
//   2. 连不上库就**失败**（不静默 skip，R3 要求 `skipped === 0`）；
//   3. 断言形状/语义不放宽；PII 反证用**自造**的 storage_ref / email / phone / 转写正文 / segment 正文。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import {
  actionCapabilities,
  readApplicationDetail,
  readJobDetail,
  readRecruitingOverview,
  type ApplicationDetailResponse,
  type RecruitingOverview,
} from '../../src/http/recruiting.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import { digestOf } from '../../src/tools/contract.ts'
import { createTestPool, hex64, inRolledBackTx, testDatabaseConfig, uniqueSuffix } from './db.ts'

const CFG = testDatabaseConfig()
const POOL = createTestPool(CFG)

after(async () => {
  await POOL.end()
})

const TENANT = CFG.tenant_id
/** 0002 seed 的 HUMAN actor（迁移自带；投影要求配置 actor 可解析）。 */
const ACTOR_HR = '11111111-1111-4111-8111-000000000103'
const ACTOR_INTERVIEWER = '11111111-1111-4111-8111-000000000104'
const ACTOR_HM = '11111111-1111-4111-8111-000000000102'

/** 每次运行唯一的敏感 marker（用于 PII 反证；只存在于本进程与回滚事务里）。 */
const RUN = uniqueSuffix()
const PII_EMAIL = `w2a-${RUN}@example.invalid`
const PII_PHONE = '199 5555 0101'
const STORAGE_REF = `w2a-storage-ref-${RUN}`
const TRANSCRIPT_BODY = `W2A-TRANSCRIPT-BODY-${RUN}`
const SEGMENT_TEXT = `W2A-SEGMENT-${RUN}`

/** 与演示 rubric 同形的三个维度（Σweight = 1）。 */
const DIMENSIONS = [
  { key: 'work_exists', label: '简历中存在可分割的工作经历条目', kind: 'MUST_HAVE', weight: 0.5, operator: 'EXISTS', value: true },
  { key: 'edu_exists', label: '简历中存在可分割的教育经历条目', kind: 'MUST_HAVE', weight: 0.25, operator: 'EXISTS', value: true },
  { key: 'team_lead', label: '有带团队经验', kind: 'NICE_TO_HAVE', weight: 0.25 },
] as const

// =====================================================================
//  通用读库小工具
// =====================================================================

async function rows<T>(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await client.query<T>(sql, [...params])
  return result.rows
}

async function oneNumber(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const result = await client.query<{ n: number }>(sql, [...params])
  return Number(result.rows[0]?.n ?? 0)
}

/** 跑一条 `returning id` 的 insert 并取回第一列（fixture 专用）。 */
async function oneId(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<string> {
  const { rows: result } = await client.query<Record<string, unknown>>(sql, [...params])
  const value = result[0] === undefined ? undefined : Object.values(result[0])[0]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`fixture insert 没有返回 id：${sql.trim().slice(0, 80)}`)
  }
  return value
}

// =====================================================================
//  fixture：岗位 / 候选人 / 材料 / 申请 / 面试 / 面评 / 会议 / 转写 / 记录 / 决策
// =====================================================================

interface JobFixture {
  readonly jobId: string
  readonly code: string
  readonly title: string
  readonly departmentId: string
  readonly versionIds: readonly string[]
  readonly currentJobVersionId: string
  readonly currentVersionNo: number
  readonly rubricId: string | null
  readonly description: string
  readonly requirements: string
}

/** 造岗位（自造部门，避免依赖任何部门的演示行）+ 可选多版本 + 可选 rubric。 */
async function seedJob(
  client: DatabaseClient,
  options: {
    readonly status?: string
    readonly versions?: ReadonlyArray<{ readonly description: string; readonly requirements: string }>
    readonly withRubric?: boolean
  } = {},
): Promise<JobFixture> {
  const suffix = uniqueSuffix()
  const departmentId = await oneId(
    client,
    'insert into recruitment.department (tenant_id, name) values ($1, $2) returning id',
    [TENANT, `W2A 自造部门 ${suffix}`],
  )
  const code = `W2A-${suffix}`
  const title = `W2A 自造岗位 ${suffix}`
  const jobId = await oneId(
    client,
    `insert into recruitment.job (tenant_id, department_id, code, title, status)
     values ($1, $2, $3, $4, $5) returning id`,
    [TENANT, departmentId, code, title, options.status ?? 'OPEN'],
  )
  const versions = options.versions ?? [{ description: `W2A 自造 JD ${suffix}`, requirements: `W2A 自造要求 ${suffix}` }]
  const versionIds: string[] = []
  for (const [index, version] of versions.entries()) {
    const versionNo = index + 1
    const versionId = await oneId(
      client,
      `insert into recruitment.job_version
         (tenant_id, job_id, version_no, description_md, requirements_md, payload_hash, created_by_actor_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [TENANT, jobId, versionNo, version.description, version.requirements, hex64(`jv-${suffix}-${versionNo}`), ACTOR_HR],
    )
    versionIds.push(versionId)
  }
  const currentJobVersionId = versionIds[versionIds.length - 1] as string
  await client.query('update recruitment.job set current_job_version_id = $2 where id = $1', [jobId, currentJobVersionId])

  let rubricId: string | null = null
  if (options.withRubric !== false) {
    rubricId = await oneId(
      client,
      `insert into recruitment.rubric_version
         (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
       values ($1, $2, 1, $3::jsonb, $4, $5) returning id`,
      [TENANT, jobId, JSON.stringify(DIMENSIONS), digestOf([...DIMENSIONS]), ACTOR_HR],
    )
    await client.query('update recruitment.job set current_rubric_version_id = $2 where id = $1', [jobId, rubricId])
  }
  return {
    jobId,
    code,
    title,
    departmentId,
    versionIds,
    currentJobVersionId,
    currentVersionNo: versions.length,
    rubricId,
    description: versions[versions.length - 1]?.description as string,
    requirements: versions[versions.length - 1]?.requirements as string,
  }
}

/** 造候选人（自造 display_name）。 */
async function seedCandidate(client: DatabaseClient): Promise<string> {
  return oneId(
    client,
    'insert into recruitment.candidate (tenant_id, display_name) values ($1, $2) returning id',
    [TENANT, `W2A 自造候选人 ${uniqueSuffix()}`],
  )
}

interface MaterialFixture {
  readonly resumeVersionId: string
  readonly resumeId: string
  readonly assetId: string
  readonly assetSha256: string
  readonly sourceAssetSha256: string
  readonly storageRef: string
}

/** 造完整材料链：event_inbox → intake_record → intake_asset → resume → resume_version。 */
async function seedMaterial(
  client: DatabaseClient,
  options: {
    readonly candidateId: string
    readonly fields: Record<string, unknown>
    readonly evidence?: readonly unknown[]
    readonly storageRef?: string
    readonly parseStatus?: string
    readonly assetSha?: string
    readonly sourceSha?: string
  },
): Promise<MaterialFixture> {
  const suffix = uniqueSuffix()
  const assetSha256 = options.assetSha ?? hex64(`w2a-asset-${suffix}`)
  const sourceAssetSha256 = options.sourceSha ?? assetSha256
  const storageRef = options.storageRef ?? `w2a-storage-ref-${suffix}`
  const eventId = await oneId(
    client,
    `insert into recruitment.event_inbox (tenant_id, provider, event_type, idempotency_key, payload, trust_level)
     values ($1, 'internal', 'w2a.fixture.intake', $2, '{}'::jsonb, 'INTERNAL') returning event_id`,
    [TENANT, `w2a:${suffix}`],
  )
  const intakeRecordId = await oneId(
    client,
    `insert into recruitment.intake_record (tenant_id, event_id, subject, status)
     values ($1, $2, $3, 'RESOLVED') returning id`,
    [TENANT, eventId, `W2A 自造收件 ${suffix}`],
  )
  const assetId = await oneId(
    client,
    `insert into recruitment.intake_asset
       (tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref, validation_status)
     values ($1, $2, $3, 'application/pdf', 20480, $4, $5, 'VALID') returning id`,
    [TENANT, intakeRecordId, `w2a-fixture-${suffix}.pdf`, assetSha256, storageRef],
  )
  const resumeId = await oneId(
    client,
    'insert into recruitment.resume (tenant_id, candidate_id, intake_asset_id) values ($1, $2, $3) returning id',
    [TENANT, options.candidateId, assetId],
  )
  const resumeVersionId = await oneId(
    client,
    `insert into recruitment.resume_version
       (tenant_id, resume_id, version_no, source_asset_sha256, content_sha256, parser_name, parser_version,
        parse_status, parsed_fields, evidence)
     values ($1, $2, 1, $3, $4, 'w2a-test-parser', '1.0.0', $5, $6::jsonb, $7::jsonb) returning id`,
    [
      TENANT,
      resumeId,
      sourceAssetSha256,
      hex64(`w2a-content-${suffix}`),
      options.parseStatus ?? 'PARSED',
      JSON.stringify(options.fields),
      JSON.stringify(options.evidence ?? []),
    ],
  )
  return { resumeVersionId, resumeId, assetId, assetSha256, sourceAssetSha256, storageRef }
}

interface ApplicationFixture {
  readonly applicationId: string
}

/** 造申请（rubric/材料可选；stage/lifecycle/applied_at 显式给，便于断言排序与 next_step）。 */
async function seedApplication(
  client: DatabaseClient,
  options: {
    readonly job: JobFixture
    readonly candidateId: string
    readonly resumeVersionId?: string
    readonly stage?: string
    readonly lifecycle?: string
    readonly appliedHoursAgo?: number
  },
): Promise<ApplicationFixture> {
  const appliedHoursAgo = options.appliedHoursAgo ?? 1
  const applicationId = await oneId(
    client,
    `insert into recruitment.application
       (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
        lifecycle_status, current_stage_code, applied_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() - ($9::int * interval '1 hour')) returning id`,
    [
      TENANT,
      options.candidateId,
      options.job.jobId,
      options.job.currentJobVersionId,
      options.job.rubricId,
      options.resumeVersionId ?? null,
      options.lifecycle ?? 'ACTIVE',
      options.stage ?? 'S7',
      appliedHoursAgo,
    ],
  )
  return { applicationId }
}

/** 造当前有效的 SCREENING 决定（basis_refs 含 RUBRIC_VERSION/AUTHORITY/SCREENING_EVALUATION/RESUME_VERSION）。 */
async function seedScreeningDecision(
  client: DatabaseClient,
  options: {
    readonly applicationId: string
    readonly rubricId: string
    readonly resumeVersionId: string
    readonly contentSha256: string
    readonly result?: string
    readonly decidedHoursAgo?: number
  },
): Promise<string> {
  const evaluationDigest = hex64(`w2a-eval-${uniqueSuffix()}`)
  const basisRefs = [
    { kind: 'RUBRIC_VERSION', id: options.rubricId, version_no: 1, payload_hash: digestOf([...DIMENSIONS]) },
    { kind: 'AUTHORITY', actor_id: ACTOR_HR, is_hiring_manager: false },
    {
      kind: 'SCREENING_EVALUATION',
      verdict: 'PASS',
      provenance: 'FIXTURE',
      contract_version: '1.0.0',
      evaluation_digest: evaluationDigest,
      resume_version_id: options.resumeVersionId,
      rubric_version_id: options.rubricId,
      criteria_evaluated: true,
      resume_content_sha256: options.contentSha256,
    },
    { kind: 'RESUME_VERSION', id: options.resumeVersionId, content_sha256: options.contentSha256 },
  ]
  return oneId(
    client,
    `insert into recruitment.decision
       (tenant_id, application_id, decision_scope, stage_code, result, reason, decided_by_actor_id, decided_at, basis_refs)
     values ($1, $2, 'SCREENING', 'S7', $3, $4, $5, now() - ($6::int * interval '1 hour'), $7::jsonb) returning id`,
    [
      TENANT,
      options.applicationId,
      options.result ?? 'ADVANCE',
      'W2A 自造初筛决定：按 rubric 逐准则人工确认（合成数据）',
      ACTOR_HR,
      options.decidedHoursAgo ?? 6,
      JSON.stringify(basisRefs),
    ],
  )
}

/** 造面试（status 显式；created_at/scheduled_start_at 显式，便于时间线与排序断言）。 */
async function seedInterview(
  client: DatabaseClient,
  options: {
    readonly applicationId: string
    readonly status: string
    readonly stageCode?: string
    readonly roundNo?: number
    readonly slotCode?: string
    readonly createdHoursAgo?: number
    readonly scheduledStartHoursAgo?: number
  },
): Promise<string> {
  const createdHoursAgo = options.createdHoursAgo ?? 30
  const scheduledStartHoursAgo = options.scheduledStartHoursAgo ?? createdHoursAgo + 1
  return oneId(
    client,
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, stage_code, status, scheduled_start_at, scheduled_end_at,
        timezone, created_at)
     values ($1, $2, $3, $4, $5, $6,
             now() - ($7::int * interval '1 hour'), now() - ($7::int * interval '1 hour') + interval '1 hour',
             'Asia/Shanghai', now() - ($8::int * interval '1 hour')) returning id`,
    [
      TENANT,
      options.applicationId,
      options.roundNo ?? 1,
      options.slotCode ?? 'DEFAULT',
      options.stageCode ?? 'S9',
      options.status,
      scheduledStartHoursAgo,
      createdHoursAgo,
    ],
  )
}

/** 造面试官分配。 */
async function seedInterviewer(
  client: DatabaseClient,
  options: {
    readonly interviewId: string
    readonly actorId: string
    readonly requiredScorecard?: boolean
    readonly dueHoursAgo?: number | null
    readonly roleInInterview?: string
  },
): Promise<string> {
  const required = options.requiredScorecard ?? true
  const dueHoursAgo = options.dueHoursAgo === undefined ? null : options.dueHoursAgo
  return oneId(
    client,
    `insert into recruitment.interviewer
       (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard, scorecard_due_at)
     values ($1, $2, $3, $4, $5,
             case when $6::int is null then null else now() - ($6::int * interval '1 hour') end) returning id`,
    [TENANT, options.interviewId, options.actorId, options.roleInInterview ?? 'INTERVIEWER', required, dueHoursAgo],
  )
}

/** 造当前有效面评（SUBMITTED 需要 submitted_at + items + actor）。 */
async function seedScorecard(
  client: DatabaseClient,
  options: {
    readonly interviewId: string
    readonly interviewerId: string
    readonly rubricVersionId: string
    readonly jobId: string
    readonly status?: string
    readonly overall?: string
    readonly submittedHoursAgo?: number
  },
): Promise<string> {
  const status = options.status ?? 'SUBMITTED'
  return oneId(
    client,
    `insert into recruitment.scorecard
       (tenant_id, interview_id, interviewer_id, rubric_version_id, job_id, status, overall,
        revision_no, submitted_at, items, status_changed_by_actor_id)
     values ($1, $2, $3, $4, $5, $6, $7, 1,
             case when $6 = 'SUBMITTED' then now() - ($8::int * interval '1 hour') else null end,
             case when $6 = 'SUBMITTED' then '{}'::jsonb else null end, $9) returning id`,
    [
      TENANT,
      options.interviewId,
      options.interviewerId,
      options.rubricVersionId,
      options.jobId,
      status,
      options.overall ?? 'ADVANCE',
      options.submittedHoursAgo ?? 12,
      ACTOR_HR,
    ],
  )
}

/** 造面试↔会议绑定（`interview_record` 之外的第二种转写关联路径；`unbound_at is null` 表示有效）。 */
async function bindInterviewToMeeting(client: DatabaseClient, interviewId: string, meetingId: string): Promise<string> {
  return oneId(
    client,
    `insert into recruitment.meeting_binding
       (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id, bound_at)
     values ($1, $2, $3, 'MANUAL', $4, now()) returning id`,
    [TENANT, meetingId, interviewId, ACTOR_HR],
  )
}

/** 造会议（飞书 provider；外部会议 id 唯一）。 */
async function seedMeeting(client: DatabaseClient): Promise<string> {  return oneId(
    client,
    `insert into recruitment.meeting (tenant_id, provider, external_meeting_id, meeting_role)
     values ($1, 'feishu', $2, 'PRIMARY') returning id`,
    [TENANT, `w2a-meeting-${uniqueSuffix()}`],
  )
}

/** 造转写工件（READY 必须 is_complete + content_sha256 + raw_text；LIVE 还需 read_receipt_ref+fetched_at）。 */
async function seedArtifact(
  client: DatabaseClient,
  options: {
    readonly meetingId: string
    readonly isCanonical: boolean
    readonly body: string
    readonly provenance?: 'FIXTURE' | 'LIVE'
    readonly fetchedHoursAgo?: number
  },
): Promise<string> {
  const provenance = options.provenance ?? 'FIXTURE'
  const fetchedHoursAgo = options.fetchedHoursAgo ?? 20
  return oneId(
    client,
    `insert into recruitment.transcript_artifact
       (tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type,
        transcript_status, provenance, trigger_mode, connection_state, content_sha256, page_count,
        is_complete, is_canonical, raw_text, fetched_at, read_receipt_ref)
     values ($1, $2, 'feishu', $3, 1, 'ORIGINAL', 'READY', $4, 'MANUAL', 'NOT_CONNECTED', $5, 2,
             true, $6, $7, case when $4 = 'LIVE' then now() - ($8::int * interval '1 hour') else null end,
             case when $4 = 'LIVE' then $9 else null end) returning id`,
    [
      TENANT,
      options.meetingId,
      `w2a-artifact-${uniqueSuffix()}`,
      provenance,
      hex64(`w2a-artifact-content-${uniqueSuffix()}`),
      options.isCanonical,
      options.body,
      fetchedHoursAgo,
      `w2a-receipt-${uniqueSuffix()}`,
    ],
  )
}

/** 造转写分段（sequence 从 0 起）。 */
async function seedSegments(
  client: DatabaseClient,
  artifactId: string,
  texts: readonly string[],
): Promise<void> {
  for (const [index, text] of texts.entries()) {
    await client.query(
      `insert into recruitment.transcript_segment
         (tenant_id, artifact_id, sequence, speaker_ref, speaker_label, start_ms, end_ms, content_text)
       values ($1, $2, $3, 'speaker-1', '面试官', $4, $5, $6)`,
      [TENANT, artifactId, index, index * 1000, index * 1000 + 900, text],
    )
  }
}

/** 造面试记录（current；transcript_revision 必须 = artifact.source_revision = 1）。 */
async function seedInterviewRecord(
  client: DatabaseClient,
  options: {
    readonly interviewId: string
    readonly artifactId: string
    readonly rubricVersionId: string
    readonly jobId: string
    readonly isCurrent?: boolean
    readonly createdHoursAgo?: number
  },
): Promise<string> {
  return oneId(
    client,
    `insert into recruitment.interview_record
       (tenant_id, interview_id, transcript_artifact_id, transcript_revision, rubric_version_id,
        prompt_version, model_id, job_id, schema_version, status, verification_status, sections,
        evidence_ok, chunk_coverage, is_current, created_at)
     values ($1, $2, $3, 1, $4, 'w2a-prompt-1.0.0', 'w2a-test-model', $5, 1, 'NEEDS_REVIEW', 'UNVERIFIED',
             '{}'::jsonb, true, 1.0, $6, now() - ($7::int * interval '1 hour')) returning id`,
    [
      TENANT,
      options.interviewId,
      options.artifactId,
      options.rubricVersionId,
      options.jobId,
      options.isCurrent ?? true,
      options.createdHoursAgo ?? 18,
    ],
  )
}

/** 含 PII 的 `parsed_fields` 夹具（email/phone 原值只用于反证投影不带出）。 */
function parsedFieldsWithPii(): Record<string, unknown> {
  return {
    meta: { pages: 2, backend: 'w2a-test' },
    fields: {
      name: { state: 'present', provenance: 'native_text', value: 'W2A 自造候选人' },
      email: { state: 'present', provenance: 'native_text', value: PII_EMAIL },
      phone: { state: 'present', provenance: 'native_text', value: PII_PHONE },
      work_experience: {
        state: 'present',
        provenance: 'native_text',
        entry_count: 2,
        entries: [
          {
            header_text: '2023.01-2024.12 W2A 公司甲 后端工程师',
            company: 'W2A 公司甲',
            title: '后端工程师',
            dates: [{ start: { year: 2023, month: 1 }, end: { year: 2024, month: 12 }, open_ended: false }],
          },
          {
            header_text: '2022.01-2022.12 W2A 公司乙 实习生',
            company: 'W2A 公司乙',
            title: '实习生',
            dates: [{ start: { year: 2022, month: 1 }, end: null, open_ended: true }],
          },
        ],
      },
      education: {
        state: 'present',
        provenance: 'native_text',
        entries: [
          {
            header_text: '2024.09-至今 W2A 大学 硕士',
            dates: [{ start: { year: 2024, month: 9 }, end: null, open_ended: true }],
          },
        ],
      },
    },
  }
}

/** 含 email/phone 字段（必须被过滤）+ 超长 quote（必须截断）的证据夹具。 */
function evidenceWithPii(): unknown[] {
  const items: unknown[] = [
    { field: 'email', page: 1, block: 2, quote: PII_EMAIL },
    { field: 'phone', page: 1, block: 3, quote: PII_PHONE },
  ]
  for (let index = 0; index < 12; index += 1) {
    items.push({
      field: 'work_experience',
      page: (index % 2) + 1,
      block: 10 + index,
      quote: `W2A 证据条目 ${index}：${'很长的证据引文'.repeat(20)}`,
    })
  }
  return items
}

interface RichFixture {
  readonly job: JobFixture
  readonly candidateId: string
  readonly material: MaterialFixture
  readonly applicationId: string
  readonly decisionId: string
  readonly interviewId: string
  readonly interviewerId: string
  readonly scorecardId: string
  readonly meetingId: string
  readonly artifactId: string
  readonly segmentTexts: readonly string[]
  readonly recordId: string
}

/**
 * 造一份「材料 + 初筛决定 + 已完成面试 + 已提交面评 + canonical READY 转写 + current 面试记录」的申请。
 * 用于详情投影的逐段断言（不依赖任何本地演示行）。
 */
async function seedRichApplication(client: DatabaseClient): Promise<RichFixture> {
  const job = await seedJob(client, {
    status: 'OPEN',
    versions: [{ description: 'W2A 自造 JD（详情用）', requirements: 'W2A 自造要求（详情用）' }],
    withRubric: true,
  })
  const candidateId = await seedCandidate(client)
  const material = await seedMaterial(client, {
    candidateId,
    fields: parsedFieldsWithPii(),
    evidence: evidenceWithPii(),
    storageRef: STORAGE_REF,
  })
  const { applicationId } = await seedApplication(client, {
    job,
    candidateId,
    resumeVersionId: material.resumeVersionId,
    stage: 'S9',
    appliedHoursAgo: 72,
  })
  const decisionId = await seedScreeningDecision(client, {
    applicationId,
    rubricId: job.rubricId as string,
    resumeVersionId: material.resumeVersionId,
    contentSha256: hex64(`w2a-decision-${uniqueSuffix()}`),
  })
  const interviewId = await seedInterview(client, {
    applicationId,
    status: 'POST_INTERVIEW',
    stageCode: 'S9',
    createdHoursAgo: 50,
    scheduledStartHoursAgo: 48,
  })
  const interviewerId = await seedInterviewer(client, {
    interviewId,
    actorId: ACTOR_INTERVIEWER,
    requiredScorecard: true,
    dueHoursAgo: 30,
  })
  const scorecardId = await seedScorecard(client, {
    interviewId,
    interviewerId,
    rubricVersionId: job.rubricId as string,
    jobId: job.jobId,
    status: 'SUBMITTED',
    submittedHoursAgo: 12,
  })
  const meetingId = await seedMeeting(client)
  const segmentTexts = [`${SEGMENT_TEXT}-0`, `${SEGMENT_TEXT}-1`, `${SEGMENT_TEXT}-2`]
  const artifactId = await seedArtifact(client, {
    meetingId,
    isCanonical: true,
    body: TRANSCRIPT_BODY,
    fetchedHoursAgo: 20,
  })
  await seedSegments(client, artifactId, segmentTexts)
  await bindInterviewToMeeting(client, interviewId, meetingId)
  const recordId = await seedInterviewRecord(client, {
    interviewId,
    artifactId,
    rubricVersionId: job.rubricId as string,
    jobId: job.jobId,
    isCurrent: true,
    createdHoursAgo: 18,
  })
  return {
    job,
    candidateId,
    material,
    applicationId,
    decisionId,
    interviewId,
    interviewerId,
    scorecardId,
    meetingId,
    artifactId,
    segmentTexts,
    recordId,
  }
}

function readOverview(client: DatabaseClient, seams?: Record<string, string>): Promise<RecruitingOverview> {
  return readRecruitingOverview({ database: CFG, client, actionSeams: seams })
}

function readApplication(client: DatabaseClient, id: string): Promise<ApplicationDetailResponse> {
  return readApplicationDetail({ database: CFG, client }, id)
}

// =====================================================================
//  1) overview：计数 / 列表 / 岗位聚合 vs 独立 SQL（全部基于自造夹具）
// =====================================================================

test('overview：counts 与独立 SQL 逐项一致；自造申请的 next_step/排序/岗位聚合正确', async () => {
  await inRolledBackTx(POOL, async (client) => {
    // 一份岗位 + 三个申请（材料就绪未初筛 / 无材料 / 已有初筛结论但停在 S6）。
    const job = await seedJob(client, { status: 'OPEN', withRubric: true })
    const candidateA = await seedCandidate(client)
    const candidateB = await seedCandidate(client)
    const candidateC = await seedCandidate(client)
    const materialA = await seedMaterial(client, { candidateId: candidateA, fields: parsedFieldsWithPii() })
    const materialC = await seedMaterial(client, { candidateId: candidateC, fields: parsedFieldsWithPii() })
    const appA = await seedApplication(client, {
      job, candidateId: candidateA, resumeVersionId: materialA.resumeVersionId, stage: 'S7', appliedHoursAgo: 5,
    })
    const appB = await seedApplication(client, {
      job, candidateId: candidateB, stage: 'S7', appliedHoursAgo: 4,
    })
    const appC = await seedApplication(client, {
      job, candidateId: candidateC, resumeVersionId: materialC.resumeVersionId, stage: 'S6', appliedHoursAgo: 3,
    })
    await seedScreeningDecision(client, {
      applicationId: appC.applicationId,
      rubricId: job.rubricId as string,
      resumeVersionId: materialC.resumeVersionId,
      contentSha256: hex64(`w2a-eval-content-${uniqueSuffix()}`),
    })

    const overview = await readOverview(client)
    assert.equal(overview.configured, true)
    assert.deepEqual(overview.issues, [])
    assert.equal(overview.actor.actor_id, CFG.actor_id)
    assert.ok(overview.actor.roles.length > 0, '配置 actor 必须能解析出角色标签')
    assert.deepEqual(overview.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
    assert.ok(Number.isFinite(Date.parse(overview.evaluated_at)))

    // ---- 独立 SQL 读回（整租户；不假设本地演示数据量） ----
    const applicationsTotal = await oneNumber(client,
      'select count(*)::int as n from recruitment.application where tenant_id = $1', [TENANT])
    const applicationsActive = await oneNumber(client,
      "select count(*)::int as n from recruitment.application where tenant_id = $1 and lifecycle_status = 'ACTIVE'", [TENANT])
    const byStageRows = await rows<{ stage_code: string; n: number }>(client,
      'select current_stage_code as stage_code, count(*)::int as n from recruitment.application where tenant_id = $1 group by 1 order by 1',
      [TENANT])
    const interviewsScheduled = await oneNumber(client,
      "select count(*)::int as n from recruitment.interview where tenant_id = $1 and status = 'SCHEDULED'", [TENANT])
    const jobsTotal = await oneNumber(client,
      'select count(*)::int as n from recruitment.job where tenant_id = $1', [TENANT])
    const jobsOpen = await oneNumber(client,
      "select count(*)::int as n from recruitment.job where tenant_id = $1 and status = 'OPEN'", [TENANT])
    const awaitingScreening = await oneNumber(client, `
      select count(*)::int as n from recruitment.application a
       where a.tenant_id = $1 and a.lifecycle_status = 'ACTIVE'
         and not exists (select 1 from recruitment.decision d
                          where d.tenant_id = a.tenant_id and d.application_id = a.id
                            and d.decision_scope = 'SCREENING' and d.superseded_by_decision_id is null)`, [TENANT])
    const interviewing = await oneNumber(client, `
      select count(distinct i.application_id)::int as n from recruitment.interview i
        join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
       where i.tenant_id = $1 and a.lifecycle_status = 'ACTIVE' and i.status not in ('CANCELLED', 'DECIDED')`, [TENANT])
    const awaitingDecision = await oneNumber(client, `
      select count(*)::int as n from recruitment.application a
       where a.tenant_id = $1 and a.lifecycle_status = 'ACTIVE' and a.current_stage_code = 'S10'
         and not exists (select 1 from recruitment.decision d
                          where d.tenant_id = a.tenant_id and d.application_id = a.id and d.stage_code = 'S10'
                            and d.decision_scope in ('STAGE', 'FINAL') and d.superseded_by_decision_id is null)`, [TENANT])
    const scorecards = await rows<{ required_total: number; submitted_total: number }>(client, `
      select count(*) filter (where ivr.required_scorecard)::int as required_total,
             count(*) filter (
               where ivr.required_scorecard and exists (
                 select 1 from recruitment.scorecard sc
                  where sc.tenant_id = ivr.tenant_id and sc.interview_id = ivr.interview_id
                    and sc.interviewer_id = ivr.id and sc.superseded_by_scorecard_id is null
                    and sc.status = 'SUBMITTED'))::int as submitted_total
        from recruitment.interviewer ivr where ivr.tenant_id = $1`, [TENANT])
    const transcripts = await rows<{ ready_total: number; pending_total: number }>(client, `
      select count(*) filter (where ta.is_canonical and ta.transcript_status = 'READY')::int as ready_total,
             count(*) filter (where ta.transcript_status in ('DISCOVERED', 'FETCHING', 'PARTIAL'))::int as pending_total
        from recruitment.transcript_artifact ta where ta.tenant_id = $1`, [TENANT])

    const expectedByStage: Record<string, number> = {}
    for (const row of byStageRows) expectedByStage[row.stage_code] = Number(row.n)

    assert.equal(overview.counts.applications_total, applicationsTotal, 'applications_total 必须等于独立 count(*)')
    assert.equal(overview.counts.applications_active, applicationsActive)
    assert.deepEqual(overview.counts.applications_by_stage, expectedByStage)
    assert.equal(overview.counts.interviews_scheduled, interviewsScheduled)
    assert.equal(overview.counts.jobs_total, jobsTotal)
    assert.equal(overview.counts.jobs_open, jobsOpen)
    assert.equal(overview.counts.awaiting_screening, awaitingScreening)
    assert.equal(overview.counts.interviewing, interviewing)
    assert.equal(overview.counts.awaiting_decision, awaitingDecision)
    assert.equal(overview.counts.scorecards_required_total, Number(scorecards[0]?.required_total ?? -1))
    assert.equal(overview.counts.scorecards_submitted_total, Number(scorecards[0]?.submitted_total ?? -1))
    assert.equal(overview.counts.transcripts_ready, Number(transcripts[0]?.ready_total ?? -1))
    assert.equal(overview.counts.transcripts_pending, Number(transcripts[0]?.pending_total ?? -1))

    // ---- 列表：无重复、按 applied_at desc、上限 200 ----
    assert.equal(overview.applications.length, Math.min(applicationsTotal, 200))
    const ids = overview.applications.map((application) => application.application_id)
    assert.equal(new Set(ids).size, ids.length, 'applications 不得出现重复 id')
    const appliedAt = overview.applications.map((application) => application.applied_at ?? '')
    assert.deepEqual(appliedAt, [...appliedAt].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0)), 'applications 必须按 applied_at desc')
    assert.equal(overview.jobs.length, Math.min(jobsTotal, 200))
    assert.equal(new Set(overview.jobs.map((job_) => job_.job_id)).size, overview.jobs.length)
    assert.deepEqual(
      overview.jobs.map((job_) => job_.created_at ?? ''),
      [...overview.jobs.map((job_) => job_.created_at ?? '')].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0)),
      'jobs 必须按 created_at desc',
    )

    // ---- 自造申请的 next_step（封闭 code + 非空 label/合法 kind） ----
    const byId = new Map(overview.applications.map((application) => [application.application_id, application]))
    const cardA = byId.get(appA.applicationId)
    const cardB = byId.get(appB.applicationId)
    const cardC = byId.get(appC.applicationId)
    assert.ok(cardA && cardB && cardC, '自造申请必须出现在 overview.applications 里')
    // O12：`seedJob(withRubric:true)` 造的 rubric **没有 approval 行** → 申请钉住的版本未批准，
    // 人点"记录初筛结论"也会被 NO_APPROVED_RUBRIC 拒；所以真实下一步是"先处理评分标准"。
    // （旧断言期望 PROVIDE_SCREENING_DECISION，那会让人去点一个做不了的动作 —— 结论由真值派生，收紧。）
    assert.equal(cardA.progress.next_step.code, 'RESOLVE_RUBRIC_STANDARD')
    assert.equal(cardB.progress.next_step.code, 'WAIT_MATERIAL_INTAKE')
    assert.equal(cardC.progress.next_step.code, 'ADVANCE_STAGE')
    for (const card of [cardA, cardB, cardC]) {
      assert.ok(card.progress.next_step.label.length > 0)
      assert.ok(['INFO', 'HUMAN_ACTION', 'WAIT'].includes(card.progress.next_step.kind))
    }
    assert.equal(cardB.material, null)
    assert.equal(cardB.screening, null)
    assert.equal(cardC.material?.parse_status, 'PARSED')
    assert.equal(cardC.screening?.result, 'ADVANCE')
    assert.equal(cardC.screening?.decided_by_actor_id, ACTOR_HR)

    // ---- 自造岗位的申请聚合 + 岗位级 next_step（HUMAN_ACTION 优先） ----
    const jobCard = overview.jobs.find((job_) => job_.job_id === job.jobId)
    assert.ok(jobCard, '自造岗位必须出现在 overview.jobs 里')
    assert.equal(jobCard.code, job.code)
    assert.equal(jobCard.title, job.title)
    assert.equal(jobCard.status, 'OPEN')
    // O12：岗位级 next_step 由申请聚合 → 与 cardA 同一真值（钉住 rubric 未批准）。
    assert.equal(jobCard.next_step.code, 'RESOLVE_RUBRIC_STANDARD')
    const jobAggregate = await rows<{ stage_code: string; n: number; active_n: number }>(client, `
      select current_stage_code as stage_code, count(*)::int as n,
             count(*) filter (where lifecycle_status = 'ACTIVE')::int as active_n
        from recruitment.application where tenant_id = $1 and job_id = $2::uuid
       group by current_stage_code order by current_stage_code`, [TENANT, job.jobId])
    const expectedJobByStage: Record<string, number> = {}
    let expectedJobTotal = 0
    let expectedJobActive = 0
    for (const row of jobAggregate) {
      expectedJobByStage[row.stage_code] = Number(row.n)
      expectedJobTotal += Number(row.n)
      expectedJobActive += Number(row.active_n)
    }
    assert.equal(jobCard.application_counts.total, expectedJobTotal)
    assert.equal(jobCard.application_counts.active, expectedJobActive)
    assert.deepEqual(jobCard.application_counts.by_stage, expectedJobByStage)
    assert.equal(jobCard.rubric?.rubric_version_id, job.rubricId)
    assert.equal(jobCard.rubric?.dimension_count, DIMENSIONS.length)
    assert.equal(jobCard.rubric?.approved, false)
    assert.deepEqual(jobCard.postings, [])

    // ---- actions：缺省全禁用（唯一判定点 = actionCapabilities） ----
    assert.deepEqual(overview.actions, actionCapabilities({}))
    for (const capability of Object.values(overview.actions)) {
      assert.equal(capability.available, false)
      assert.equal(capability.pending, 'ACTION_SEAM_NOT_WIRED')
    }

    // ---- settings：stage_catalog / configs / departments 与独立 SQL 一致 ----
    const config = await rows<{ payload: unknown; version_no: number }>(client,
      "select payload, version_no from recruitment.business_config where tenant_id = $1 and config_key = 'stage_catalog' and effective_to is null",
      [TENANT])
    assert.ok(config[0] !== undefined, '迁移 seed 必须提供 stage_catalog 配置')
    const payload = config[0]?.payload as { stages?: unknown[] }
    assert.equal(overview.settings.stage_catalog?.stages.length, payload.stages?.length)
    const s10 = overview.settings.stage_catalog?.stages.find((stage) => stage.code === 'S10')
    assert.equal(s10?.in_v1_scope, true)
    const s11 = overview.settings.stage_catalog?.stages.find((stage) => stage.code === 'S11')
    assert.equal(s11?.in_v1_scope, false)
    assert.equal(overview.settings.configs.length, await oneNumber(client,
      'select count(*)::int as n from recruitment.business_config where tenant_id = $1 and effective_to is null', [TENANT]))
    assert.equal(overview.settings.departments.length, await oneNumber(client,
      'select count(*)::int as n from recruitment.department where tenant_id = $1', [TENANT]))
    assert.equal(overview.settings.entry.available, false)
    assert.equal(overview.settings.entry.href, null)
  })
})

// =====================================================================
//  2) 申请详情：材料 / 初筛证据 / 面试 / 面评 / 转写 / 时间线 vs 独立 SQL
// =====================================================================

test('application detail：candidate/job/material/screening/decisions/interviews/timeline 与独立 SQL 逐条一致', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedRichApplication(client)
    const detail = await readApplication(client, fixture.applicationId)
    assert.equal(detail.contract_version, 'recruiting-overview 1.0.0')
    assert.ok(Number.isFinite(Date.parse(detail.evaluated_at)))
    assert.deepEqual(detail.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
    assert.equal(detail.actor.actor_id, CFG.actor_id)

    const card = detail.application
    const appRows = await rows<{
      lifecycle_status: string
      current_stage_code: string
      record_version: number
      stage_blocked_reason: string | null
      candidate_id: string
      candidate_display_name: string
      job_id: string
      job_code: string
      job_title: string
    }>(client, `
      select a.lifecycle_status, a.current_stage_code, a.record_version, a.stage_blocked_reason,
             c.id::text as candidate_id, c.display_name as candidate_display_name,
             j.id::text as job_id, j.code as job_code, j.title as job_title
        from recruitment.application a
        join recruitment.candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
        join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
       where a.tenant_id = $1 and a.id = $2::uuid`, [TENANT, fixture.applicationId])
    const app = appRows[0]
    assert.ok(app, '自造申请必须存在')
    assert.equal(card.application_id, fixture.applicationId)
    assert.equal(card.lifecycle_status, app.lifecycle_status)
    assert.equal(card.current_stage_code, app.current_stage_code)
    assert.equal(card.record_version, Number(app.record_version))
    assert.equal(card.stage_blocked_reason, app.stage_blocked_reason)
    assert.deepEqual(card.candidate, { candidate_id: app.candidate_id, display_name: app.candidate_display_name })
    assert.deepEqual(card.job, { job_id: app.job_id, code: app.job_code, title: app.job_title })

    // ---- material 与独立 SQL 一致（哈希对齐、页数、条目数、证据数） ----
    const materialRows = await rows<{
      resume_version_id: string
      resume_id: string
      asset_id: string
      file_name: string
      mime_type: string | null
      byte_size: number
      asset_sha256: string
      source_asset_sha256: string
      validation_status: string
      parse_status: string
      parser_name: string
      parser_version: string
      pages: string | null
      evidence_count: number
    }>(client, `
      select rv.id::text as resume_version_id, r.id::text as resume_id, ia.id::text as asset_id,
             ia.file_name, ia.mime_type, ia.byte_size::int as byte_size, ia.sha256 as asset_sha256,
             rv.source_asset_sha256, ia.validation_status, rv.parse_status,
             rv.parser_name, rv.parser_version, rv.parsed_fields->'meta'->>'pages' as pages,
             jsonb_array_length(rv.evidence) as evidence_count
        from recruitment.application a
        join recruitment.resume_version rv on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
        join recruitment.resume r on r.id = rv.resume_id and rv.tenant_id = r.tenant_id
        join recruitment.intake_asset ia on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
       where a.tenant_id = $1 and a.id = $2::uuid`, [TENANT, fixture.applicationId])
    const material = materialRows[0]
    assert.ok(material, '自造申请必须有材料')
    const summary = card.material
    assert.ok(summary, 'material 不得为 null')
    assert.equal(summary.resume_version_id, material.resume_version_id)
    assert.equal(summary.resume_id, material.resume_id)
    assert.equal(summary.asset_id, material.asset_id)
    assert.equal(summary.file_name, material.file_name)
    assert.equal(summary.mime_type, material.mime_type)
    assert.equal(summary.byte_size, Number(material.byte_size))
    assert.equal(summary.sha256, material.asset_sha256)
    assert.equal(summary.source_asset_sha256, material.source_asset_sha256)
    assert.equal(summary.source_hash_aligned, material.asset_sha256 === material.source_asset_sha256)
    assert.equal(summary.source_hash_aligned, true)
    assert.equal(summary.validation_status, material.validation_status)
    assert.equal(summary.parse_status, material.parse_status)
    assert.equal(summary.parser_name, material.parser_name)
    assert.equal(summary.parser_version, material.parser_version)
    assert.equal(summary.page_count, Number(material.pages))
    assert.equal(summary.evidence_count, Number(material.evidence_count))
    assert.deepEqual(summary.entry_counts, { work: 2, education: 1 })
    assert.equal(summary.field_states.email, 'present')
    assert.equal(summary.field_states.phone, 'present')

    // ---- 简历段：PII 只给 state、工作/教育条目、证据样本 ≤12 且跳过 email/phone ----
    assert.ok(detail.resume, '有 material 时必须有 resume 段')
    assert.equal(detail.resume.material.resume_version_id, summary.resume_version_id)
    assert.equal(detail.resume.work_entries.length, 2)
    assert.deepEqual(detail.resume.work_entries[0], {
      company: 'W2A 公司甲', title: '后端工程师', start: '2023-01', end: '2024-12',
    })
    assert.equal(detail.resume.work_entries[1]?.end, null, 'open-ended 的 end 必须是 null')
    assert.equal(detail.resume.education_entries.length, 1)
    assert.equal(detail.resume.education_entries[0]?.end, null)
    assert.equal(detail.resume.evidence_samples.length, 12, '证据样本上限 12 条（23 条里挑 12 条工作经历）')
    for (const sample of detail.resume.evidence_samples) {
      assert.ok(sample.quote.length <= 120, 'quote 必须 ≤120 字符')
      assert.equal(['email', 'phone'].includes(sample.field), false, '证据样本不得使用 email/phone 字段')
    }
    for (const field of detail.resume.fields) {
      if (field.key === 'email' || field.key === 'phone') {
        assert.equal(field.value_preview, null, 'PII 字段的 value_preview 恒 null')
      }
    }
    assert.equal(detail.resume.fields.find((field) => field.key === 'work_experience')?.entry_count, 2)

    // ---- 初筛：决定 + basis 安全投影 + rubric 快照 ----
    const screeningDecision = await rows<{
      decision_id: string
      result: string
      stage_code: string
      decided_by_actor_id: string
      display_name: string
    }>(client, `
      select d.id::text as decision_id, d.result, d.stage_code, d.decided_by_actor_id::text as decided_by_actor_id,
             a.display_name
        from recruitment.decision d
        join recruitment.actor a on a.id = d.decided_by_actor_id and a.tenant_id = d.tenant_id
       where d.tenant_id = $1 and d.application_id = $2::uuid
         and d.decision_scope = 'SCREENING' and d.superseded_by_decision_id is null
       order by d.decided_at desc limit 1`, [TENANT, fixture.applicationId])
    assert.ok(screeningDecision[0], '自造初筛决定必须存在')
    const screening = card.screening
    assert.ok(screening, 'screening 不得为 null')
    assert.equal(screening.decision_id, screeningDecision[0]?.decision_id)
    assert.equal(screening.result, screeningDecision[0]?.result)
    assert.equal(screening.decided_by_actor_id, screeningDecision[0]?.decided_by_actor_id)
    assert.equal(screening.decided_by_display_name, screeningDecision[0]?.display_name)
    assert.equal(screening.rubric_version_id, fixture.job.rubricId)
    assert.deepEqual(screening.basis_kinds, ['RUBRIC_VERSION', 'AUTHORITY', 'SCREENING_EVALUATION', 'RESUME_VERSION'])
    assert.equal(screening.evaluation?.verdict, 'PASS')
    assert.equal(screening.evaluation?.provenance, 'FIXTURE')
    assert.equal(screening.evaluation?.criteria_evaluated, true)
    assert.equal(screening.evaluation?.resume_version_id, fixture.material.resumeVersionId)

    assert.equal(detail.screening_evidence.decision?.decision_id, screening.decision_id)
    assert.equal(detail.screening_evidence.rubric?.rubric_version_id, fixture.job.rubricId)
    assert.equal(detail.screening_evidence.rubric?.dimensions.length, DIMENSIONS.length)
    assert.equal(detail.screening_evidence.basis.length, 4)
    for (const basis of detail.screening_evidence.basis) {
      assert.ok(basis.kind.length > 0)
      for (const deniedKey of ['storage_ref', 'raw_payload', 'raw_text', 'content_text', 'email', 'phone']) {
        assert.equal(deniedKey in basis.detail, false, `basis 安全投影不得带出 ${deniedKey}`)
      }
    }

    // ---- 决定全量（含历史）+ is_current ----
    const decisionRows = await rows<{ decision_id: string; superseded: string | null }>(client,
      'select id::text as decision_id, superseded_by_decision_id::text as superseded from recruitment.decision where tenant_id = $1 and application_id = $2::uuid order by decided_at desc, id asc',
      [TENANT, fixture.applicationId])
    assert.equal(card.decisions.length, decisionRows.length)
    for (const [index, decision] of card.decisions.entries()) {
      assert.equal(decision.decision_id, decisionRows[index]?.decision_id)
      assert.equal(decision.is_current, decisionRows[index]?.superseded === null)
    }

    // ---- 面试 / 面试官 / 面评：与独立 SQL 一致 ----
    const interviewRows = await rows<{ interview_id: string }>(client,
      'select id::text as interview_id from recruitment.interview where tenant_id = $1 and application_id = $2::uuid order by scheduled_start_at asc nulls last, id asc',
      [TENANT, fixture.applicationId])
    assert.equal(card.interviews.length, interviewRows.length)
    const interview = card.interviews[0]
    assert.ok(interview)
    assert.equal(interview.interview_id, fixture.interviewId)
    // S14：面试行版本必须按行读回（不是拿申请版本顶替，也不能缺省为 1）。
    const ivVersionRows = await rows<{ record_version: number }>(client,
      'select record_version from recruitment.interview where tenant_id = $1 and id = $2::uuid',
      [TENANT, fixture.interviewId])
    assert.equal(interview.record_version, ivVersionRows[0]?.record_version,
      'interview.record_version 必须等于该面试行的库内版本（乐观锁按行）')
    assert.equal(interview.status, 'POST_INTERVIEW')
    assert.equal(interview.round_no, 1)
    assert.equal(interview.scorecards.required_total, 1)
    assert.equal(interview.scorecards.submitted, 1)
    assert.equal(interview.scorecards.missing_total, 0)
    assert.equal(interview.scorecards.overdue, 0, '已提交的 required 面评不算逾期')
    assert.equal(interview.interviewers.length, 1)
    assert.equal(interview.interviewers[0]?.interviewer_row_id, fixture.interviewerId)
    assert.equal(interview.interviewers[0]?.required_scorecard, true)
    assert.equal(interview.interviewers[0]?.scorecard?.status, 'SUBMITTED')
    assert.equal(interview.interviewers[0]?.scorecard?.scorecard_id, fixture.scorecardId)
    assert.equal(interview.interviewers[0]?.scorecard?.interviewer_display_name, interview.interviewers[0]?.display_name)
    assert.equal(card.progress.scorecards_required, 1)
    assert.equal(card.progress.scorecards_submitted, 1)

    // ---- 转写：record 路径（is_current）→ canonical READY artifact ----
    const transcriptRows = await rows<{ artifact_id: string; segment_count: number; is_canonical: boolean }>(client, `
      select ta.id::text as artifact_id,
             (select count(*)::int from recruitment.transcript_segment ts
               where ts.artifact_id = ta.id and ts.tenant_id = ta.tenant_id) as segment_count,
             ta.is_canonical
        from recruitment.interview_record ir
        join recruitment.transcript_artifact ta
          on ta.id = ir.transcript_artifact_id and ta.tenant_id = ir.tenant_id
       where ir.tenant_id = $1 and ir.interview_id = $2::uuid and ir.is_current`, [TENANT, fixture.interviewId])
    assert.equal(interview.transcript.artifact_id, transcriptRows[0]?.artifact_id)
    assert.equal(interview.transcript.state, 'READY')
    assert.equal(interview.transcript.is_canonical, transcriptRows[0]?.is_canonical)
    assert.equal(interview.transcript.is_canonical, true)
    assert.equal(interview.transcript.provenance, 'FIXTURE')
    assert.equal(interview.transcript.segment_count, Number(transcriptRows[0]?.segment_count))
    assert.equal(interview.transcript.segment_count, fixture.segmentTexts.length)
    assert.equal(interview.transcript.interview_record?.interview_record_id, fixture.recordId)
    assert.equal(interview.transcript.interview_record?.is_current, true)
    assert.equal(card.progress.transcript_state, 'READY')

    // ---- 下一步：S9 + 已有初筛结论 + 无 SCHEDULED 面试 → SCHEDULE_INTERVIEW ----
    assert.equal(card.progress.next_step.code, 'SCHEDULE_INTERVIEW')
    assert.equal(card.progress.next_step.kind, 'HUMAN_ACTION')

    // ---- timeline：8 类事实都出现、按时间倒序、ref_id 指向自造行 ----
    const kinds = new Set(detail.timeline.map((entry) => entry.kind))
    for (const kind of [
      'APPLIED', 'INTAKE', 'SCREENING_DECISION', 'INTERVIEW_SCHEDULED', 'TRANSCRIPT_FETCHED',
      'INTERVIEW_RECORD', 'SCORECARD_SUBMITTED', 'DECISION',
    ] as const) {
      assert.equal(kinds.has(kind), true, `timeline 缺少 ${kind}`)
    }
    const timelineAt = detail.timeline.map((entry) => entry.at)
    assert.deepEqual(timelineAt, [...timelineAt].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0)), 'timeline 必须倒序')
    const refIds = new Set(detail.timeline.map((entry) => entry.ref_id))
    for (const refId of [fixture.applicationId, fixture.material.assetId, fixture.decisionId, fixture.interviewId, fixture.artifactId, fixture.recordId, fixture.scorecardId]) {
      assert.equal(refIds.has(refId), true, `timeline 必须引用自造事实 ${refId}`)
    }
    assert.deepEqual(detail.transcript_runs, [], '没有 transcript_processing_run 时必须是空数组')
    for (const capability of Object.values(detail.actions)) assert.equal(capability.available, false)
  })
})

// =====================================================================
//  3) transcript 结论：record 优先（is_current）+ canonical 如实 + meeting 兜底
// =====================================================================

test('transcript：record(is_current) 优先；READY 但 canonical=false 如实带出；无 record 时走 meeting 绑定', async () => {
  await inRolledBackTx(POOL, async (client) => {
    // 申请 A：无材料；两场面试。
    //   IV1：record(current) 指向 **非 canonical 的 LIVE** artifact，同时 meeting 绑着一条 canonical artifact
    //        → 契约要求 record 优先 → state=READY、is_canonical=false、provenance=LIVE。
    //   IV2：没有 record，只有 meeting 绑定 → 必须走 meeting 兜底 → canonical READY。
    const job = await seedJob(client, { status: 'OPEN', withRubric: true })
    const candidateId = await seedCandidate(client)
    const { applicationId } = await seedApplication(client, { job, candidateId, stage: 'S9', appliedHoursAgo: 40 })

    const meeting1 = await seedMeeting(client)
    const recordArtifact = await seedArtifact(client, {
      meetingId: meeting1, isCanonical: false, provenance: 'LIVE', body: `${TRANSCRIPT_BODY}-record`,
    })
    const canonicalArtifactSameMeeting = await seedArtifact(client, {
      meetingId: meeting1, isCanonical: true, body: `${TRANSCRIPT_BODY}-canonical-1`,
    })
    await seedSegments(client, recordArtifact, [`${SEGMENT_TEXT}-record-0`, `${SEGMENT_TEXT}-record-1`])
    await seedSegments(client, canonicalArtifactSameMeeting, [`${SEGMENT_TEXT}-canonical-1-0`, `${SEGMENT_TEXT}-canonical-1-1`, `${SEGMENT_TEXT}-canonical-1-2`])
    const interview1 = await seedInterview(client, {
      applicationId, status: 'POST_INTERVIEW', stageCode: 'S9', createdHoursAgo: 30,
    })
    await bindInterviewToMeeting(client, interview1, meeting1)
    const record1 = await seedInterviewRecord(client, {
      interviewId: interview1,
      artifactId: recordArtifact,
      rubricVersionId: job.rubricId as string,
      jobId: job.jobId,
      isCurrent: true,
      createdHoursAgo: 20,
    })

    const meeting2 = await seedMeeting(client)
    const canonicalArtifact2 = await seedArtifact(client, {
      meetingId: meeting2, isCanonical: true, body: `${TRANSCRIPT_BODY}-canonical-2`,
    })
    await seedSegments(client, canonicalArtifact2, [`${SEGMENT_TEXT}-canonical-2-0`, `${SEGMENT_TEXT}-canonical-2-1`])
    const interview2 = await seedInterview(client, {
      applicationId, status: 'SCHEDULED', stageCode: 'S9', roundNo: 2, createdHoursAgo: 10,
    })
    await bindInterviewToMeeting(client, interview2, meeting2)

    const detail = await readApplication(client, applicationId)
    const card = detail.application
    assert.equal(card.material, null)
    assert.equal(detail.resume, null)

    const iv1 = card.interviews.find((item) => item.interview_id === interview1)
    const iv2 = card.interviews.find((item) => item.interview_id === interview2)
    assert.ok(iv1 && iv2)
    assert.equal(iv1.transcript.artifact_id, recordArtifact, 'record 路径必须优先于 meeting 绑定')
    assert.equal(iv1.transcript.state, 'READY')
    assert.equal(iv1.transcript.is_canonical, false, 'READY 但非 canonical 必须如实带出 false（不谎报）')
    assert.equal(iv1.transcript.provenance, 'LIVE')
    assert.equal(iv1.transcript.segment_count, 2)
    assert.equal(iv1.transcript.interview_record?.interview_record_id, record1)
    assert.equal(iv1.transcript.interview_record?.is_current, true)
    assert.equal(iv1.transcript.interview_record?.status, 'NEEDS_REVIEW')
    assert.equal(iv1.transcript.interview_record?.verification_status, 'UNVERIFIED')

    assert.equal(iv2.transcript.interview_record, null, '没有 record 时不得伪造 record 块')
    const meetingBound = await rows<{ artifact_id: string; segment_count: number }>(client, `
      select ta.id::text as artifact_id,
             (select count(*)::int from recruitment.transcript_segment ts
               where ts.artifact_id = ta.id and ts.tenant_id = ta.tenant_id) as segment_count
        from recruitment.meeting_binding mb
        join recruitment.transcript_artifact ta on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id
       where mb.tenant_id = $1 and mb.interview_id = $2::uuid and mb.unbound_at is null and ta.is_canonical
       limit 1`, [TENANT, interview2])
    // 会议绑定已在本用例顶部显式插入（两个 interview 各一条），这里只做独立 SQL 比对。
    assert.equal(meetingBound.length, 1, 'IV2 的 meeting 绑定必须存在')
    assert.equal(iv2.transcript.artifact_id, meetingBound[0]?.artifact_id)
    assert.equal(iv2.transcript.state, 'READY')
    assert.equal(iv2.transcript.is_canonical, true)
    assert.equal(iv2.transcript.segment_count, Number(meetingBound[0]?.segment_count))

    // 无材料 → 下一步是 WAIT_MATERIAL_INTAKE（即便有面试事实，也不编造材料结论）。
    assert.equal(card.progress.next_step.code, 'WAIT_MATERIAL_INTAKE')
    assert.equal(card.progress.transcript_state, 'READY')
  })
})

// =====================================================================
//  4) 负例：不存在 / 非 UUID 的 id → NOT_FOUND（不是 500、不是 22P02）
// =====================================================================

test('负例：不存在的 application/job id → NOT_FOUND；非 UUID → NOT_FOUND；大写 UUID 可命中', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const job = await seedJob(client, { status: 'OPEN' })
    const candidateId = await seedCandidate(client)
    const { applicationId } = await seedApplication(client, { job, candidateId, stage: 'S7' })

    const upper = await readApplication(client, applicationId.toUpperCase())
    assert.equal(upper.application.application_id, applicationId)
    const upperJob = await readJobDetail({ database: CFG, client }, job.jobId.toUpperCase())
    assert.equal(upperJob.job.job_id, job.jobId)

    for (const id of ['11111111-1111-4111-8111-000000009999', 'not-a-uuid', '']) {
      await assert.rejects(
        () => readApplication(client, id),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message.startsWith('NOT_FOUND: application '), true, `实际：${error.message}`)
          return true
        },
      )
      await assert.rejects(
        () => readJobDetail({ database: CFG, client }, id),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message.startsWith('NOT_FOUND: job '), true, `实际：${error.message}`)
          return true
        },
      )
    }
  })
})

// =====================================================================
//  5) PII 红线：自造 storage_ref / email / phone / 转写正文 / segment 正文 都不出现在投影 JSON
// =====================================================================

test('PII 红线：overview/detail JSON 不含自造 storage_ref 原值、邮箱/电话、转写正文、segment 正文、raw_payload', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedRichApplication(client)
    // 先确认这些值真的在库里（否则反证是空过）。
    const stored = await rows<{ kind: string; value: string }>(client, `
      select 'storage_ref'::text as kind, ia.storage_ref as value
        from recruitment.application a
        join recruitment.resume_version rv on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
        join recruitment.resume r on r.id = rv.resume_id and rv.tenant_id = rv.tenant_id
        join recruitment.intake_asset ia on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
       where a.tenant_id = $1 and a.id = $2::uuid
      union all
      select 'email', rv.parsed_fields->'fields'->'email'->>'value'
        from recruitment.application a
        join recruitment.resume_version rv on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
       where a.tenant_id = $1 and a.id = $2::uuid
      union all
      select 'phone', rv.parsed_fields->'fields'->'phone'->>'value'
        from recruitment.application a
        join recruitment.resume_version rv on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
       where a.tenant_id = $1 and a.id = $2::uuid
      union all
      select 'transcript_body', ta.raw_text
        from recruitment.interview i
        join recruitment.meeting_binding mb on mb.interview_id = i.id and mb.tenant_id = i.tenant_id
        join recruitment.transcript_artifact ta on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id
       where i.tenant_id = $1 and i.application_id = $2::uuid and ta.raw_text is not null
      union all
      select 'segment', ts.content_text
        from recruitment.interview i
        join recruitment.meeting_binding mb on mb.interview_id = i.id and mb.tenant_id = i.tenant_id
        join recruitment.transcript_artifact ta on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id
        join recruitment.transcript_segment ts on ts.artifact_id = ta.id and ts.tenant_id = ta.tenant_id
       where i.tenant_id = $1 and i.application_id = $2::uuid
       order by kind`, [TENANT, fixture.applicationId])
    for (const kind of ['storage_ref', 'email', 'phone', 'transcript_body', 'segment']) {
      const hit = stored.find((row) => row.kind === kind)
      assert.ok(hit && hit.value.length >= 8, `真库必须有自造 ${kind} 值才能反证`)
    }
    // 存储值确实是我们自造的那几个（不是别的行）。
    assert.equal(stored.find((row) => row.kind === 'storage_ref')?.value, STORAGE_REF)
    assert.equal(stored.find((row) => row.kind === 'email')?.value, PII_EMAIL)
    assert.equal(stored.find((row) => row.kind === 'phone')?.value, PII_PHONE)
    assert.ok((stored.find((row) => row.kind === 'transcript_body')?.value ?? '').startsWith(TRANSCRIPT_BODY))
    assert.ok((stored.find((row) => row.kind === 'segment')?.value ?? '').startsWith(SEGMENT_TEXT))

    const detail = await readApplication(client, fixture.applicationId)
    const overview = await readOverview(client)
    const texts = [JSON.stringify(detail), JSON.stringify(overview)]
    for (const text of texts) {
      assert.equal(text.includes(STORAGE_REF), false, 'storage_ref 原值不得出现在投影里')
      assert.equal(text.includes(PII_EMAIL), false, '邮箱原值不得出现在投影里')
      assert.equal(text.includes(PII_PHONE), false, '电话原值不得出现在投影里')
      assert.equal(text.includes(TRANSCRIPT_BODY), false, '转写正文不得出现在投影里')
      assert.equal(text.includes(SEGMENT_TEXT), false, 'segment 正文不得出现在投影里')
      // JSON 转义形态也查（防止原文里有换行/引号让 includes 空过）。
      for (const secret of [STORAGE_REF, PII_EMAIL, PII_PHONE, TRANSCRIPT_BODY, SEGMENT_TEXT]) {
        assert.equal(text.includes(JSON.stringify(secret).slice(1, -1)), false)
      }
      assert.equal(text.includes('raw_payload'), false)
      assert.equal(text.includes('raw_text'), false)
      assert.equal(text.includes('storage_ref'), false)
    }
    // 反向确认：非 PII 事实确实在投影里（不是空投影造成的空过）。
    assert.equal(texts[0]?.includes('W2A 公司甲'), true)
    assert.equal(texts[0]?.includes('work_experience'), true)
  })
})

// =====================================================================
//  6) 岗位详情：多版本 / rubric / 申请聚合 / 岗位级 next_step
// =====================================================================

test('job detail：多版本 desc、JD 正文取当前版本、rubric 维度、申请聚合与岗位级 next_step 正确', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const job = await seedJob(client, {
      status: 'OPEN',
      versions: [
        { description: 'W2A JD v1', requirements: 'W2A 要求 v1' },
        { description: 'W2A JD v2（当前）', requirements: 'W2A 要求 v2（当前）' },
      ],
      withRubric: true,
    })
    const candidateWithMaterial = await seedCandidate(client)
    const candidateWithoutMaterial = await seedCandidate(client)
    const material = await seedMaterial(client, { candidateId: candidateWithMaterial, fields: parsedFieldsWithPii() })
    const withMaterial = await seedApplication(client, {
      job, candidateId: candidateWithMaterial, resumeVersionId: material.resumeVersionId, stage: 'S7', appliedHoursAgo: 2,
    })
    const withoutMaterial = await seedApplication(client, {
      job, candidateId: candidateWithoutMaterial, stage: 'S7', appliedHoursAgo: 1,
    })

    const detail = await readJobDetail({ database: CFG, client }, job.jobId)
    assert.equal(detail.job.job_id, job.jobId)
    assert.equal(detail.job.code, job.code)
    assert.equal(detail.job.title, job.title)
    assert.equal(detail.job.status, 'OPEN')
    assert.equal(detail.job.version_no, 2)
    assert.equal(detail.job.rubric?.rubric_version_id, job.rubricId)
    assert.equal(detail.job.rubric?.version_no, 1)
    assert.equal(detail.job.rubric?.approved, false)
    assert.equal(detail.job.rubric?.dimension_count, DIMENSIONS.length)

    // 版本历史：version_no desc，payload_hash 为 64 hex，approved=false（自造 rubric 未批准）。
    const versionRows = await rows<{ version_no: number; payload_hash: string }>(client,
      'select version_no, payload_hash from recruitment.job_version where tenant_id = $1 and job_id = $2::uuid order by version_no desc',
      [TENANT, job.jobId])
    assert.deepEqual(detail.versions.map((version) => version.version_no), versionRows.map((row) => Number(row.version_no)))
    assert.deepEqual(detail.versions.map((version) => version.version_no), [2, 1])
    for (const [index, version] of detail.versions.entries()) {
      assert.equal(version.payload_hash, versionRows[index]?.payload_hash)
      assert.equal(/^[0-9a-f]{64}$/.test(version.payload_hash), true)
      assert.equal(version.approved, false)
    }

    // JD 正文 = 当前版本（v2）。
    assert.equal(detail.description_md, 'W2A JD v2（当前）')
    assert.equal(detail.requirements_md, 'W2A 要求 v2（当前）')

    // rubric 维度与 rubric_version.dimensions 数量/顺序一致。
    assert.equal(detail.rubric?.dimensions.length, DIMENSIONS.length)
    assert.deepEqual(detail.rubric?.dimensions.map((dimension) => dimension.key), DIMENSIONS.map((dimension) => dimension.key))
    for (const dimension of detail.rubric?.dimensions ?? []) {
      assert.ok(typeof dimension.key === 'string' && dimension.key.length > 0)
      assert.ok(typeof dimension.label === 'string' && dimension.label.length > 0)
      assert.equal(typeof dimension.kind, 'string')
    }

    // 申请聚合与申请列表（只含本岗位）。
    assert.equal(detail.job.application_counts.total, 2)
    assert.equal(detail.job.application_counts.active, 2)
    assert.deepEqual(detail.job.application_counts.by_stage, { S7: 2 })
    assert.equal(detail.applications.length, 2)
    const ids = detail.applications.map((application) => application.application_id)
    assert.deepEqual(new Set(ids), new Set([withMaterial.applicationId, withoutMaterial.applicationId]))
    assert.deepEqual(detail.applications.map((application) => application.applied_at ?? ''),
      [...detail.applications.map((application) => application.applied_at ?? '')]
        .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0)))
    const withMaterialCard = detail.applications.find((application) => application.application_id === withMaterial.applicationId)
    const withoutMaterialCard = detail.applications.find((application) => application.application_id === withoutMaterial.applicationId)
    // O12：夹具岗位的 rubric 没有 approval 行 → 钉住版本未批准，真实下一步是"先处理评分标准"。
    assert.equal(withMaterialCard?.progress.next_step.code, 'RESOLVE_RUBRIC_STANDARD')
    assert.equal(withoutMaterialCard?.progress.next_step.code, 'WAIT_MATERIAL_INTAKE')
    // 岗位级 next_step：同一真值（HUMAN_ACTION 的评分标准处理优先于 WAIT 的缺材料）。
    assert.equal(detail.job.next_step.code, 'RESOLVE_RUBRIC_STANDARD')
    assert.ok(detail.job.next_step.label.length > 0)
    for (const capability of Object.values(detail.actions)) assert.equal(capability.available, false)
  })
})

// =====================================================================
//  7) 无 rubric 的 DRAFT 岗位 → rubric=null + JOB_DRAFT（不编造维度）
// =====================================================================

test('DRAFT 岗位：rubric=null、applications=[]、next_step=JOB_DRAFT', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const job = await seedJob(client, { status: 'DRAFT', withRubric: false })
    const detail = await readJobDetail({ database: CFG, client }, job.jobId)
    assert.equal(detail.rubric, null)
    assert.equal(detail.job.rubric, null)
    assert.equal(detail.applications.length, 0)
    assert.equal(detail.job.application_counts.total, 0)
    assert.deepEqual(detail.job.application_counts.by_stage, {})
    assert.equal(detail.job.next_step.code, 'JOB_DRAFT')
    assert.ok(detail.job.next_step.label.length > 0)
    assert.equal(detail.versions.length, 1)
    assert.equal(detail.description_md, job.description)
    assert.equal(detail.requirements_md, job.requirements)
  })
})

// =====================================================================
//  8) 材料缺失 / 哈希不一致：不编造（material=null / source_hash_aligned=false）
// =====================================================================

test('材料：无 material → null + WAIT_MATERIAL_INTAKE；sha 与 source_sha 不一致 → source_hash_aligned=false', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const job = await seedJob(client, { status: 'OPEN', withRubric: true })
    const candidateNoMaterial = await seedCandidate(client)
    const candidateMismatch = await seedCandidate(client)
    const noMaterial = await seedApplication(client, { job, candidateId: candidateNoMaterial, stage: 'S6', appliedHoursAgo: 2 })
    const materialMismatch = await seedMaterial(client, {
      candidateId: candidateMismatch,
      fields: parsedFieldsWithPii(),
      assetSha: hex64(`w2a-asset-${uniqueSuffix()}`),
      sourceSha: hex64(`w2a-source-${uniqueSuffix()}`),
    })
    const mismatched = await seedApplication(client, {
      job, candidateId: candidateMismatch, resumeVersionId: materialMismatch.resumeVersionId, stage: 'S7', appliedHoursAgo: 1,
    })

    const detailNoMaterial = await readApplication(client, noMaterial.applicationId)
    assert.equal(detailNoMaterial.application.material, null)
    assert.equal(detailNoMaterial.resume, null)
    assert.equal(detailNoMaterial.application.progress.next_step.code, 'WAIT_MATERIAL_INTAKE')
    assert.equal(detailNoMaterial.application.progress.transcript_state, 'MISSING')

    const detailMismatch = await readApplication(client, mismatched.applicationId)
    assert.ok(detailMismatch.application.material)
    assert.equal(detailMismatch.application.material?.source_hash_aligned, false, '哈希不一致必须如实 false')
    assert.equal(detailMismatch.application.material?.sha256, materialMismatch.assetSha256)
    assert.equal(detailMismatch.application.material?.source_asset_sha256, materialMismatch.sourceAssetSha256)
    assert.notEqual(materialMismatch.assetSha256, materialMismatch.sourceAssetSha256)
  })
})

// =====================================================================
//  9) actionSeams：只影响 actions，不影响任何业务读数
// =====================================================================

test('actionSeams：部分接线只改 actions 可用性；业务读数逐字节不变', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const job = await seedJob(client, { status: 'OPEN', withRubric: true })
    const candidateId = await seedCandidate(client)
    const material = await seedMaterial(client, { candidateId, fields: parsedFieldsWithPii() })
    await seedApplication(client, { job, candidateId, resumeVersionId: material.resumeVersionId, stage: 'S7', appliedHoursAgo: 1 })

    const baseline = await readOverview(client)
    const seams = { screening_decide: '/recruitment/api/action/screening/decide' }
    const wired = await readOverview(client, seams)
    assert.deepEqual(wired.actions, actionCapabilities(seams))
    assert.equal(wired.actions.screening_decide.available, true)
    assert.equal(wired.actions.screening_decide.seam, '/recruitment/api/action/screening/decide')
    assert.equal(wired.actions.decision_record.available, false)
    assert.deepEqual(wired.counts, baseline.counts)
    assert.deepEqual(wired.applications, baseline.applications)
    assert.deepEqual(wired.jobs, baseline.jobs)
    assert.deepEqual(wired.settings, baseline.settings)
    assert.equal(wired.settings.entry.available, false, '设置入口只看 recruiting_settings_write')
  })
})

// =====================================================================
//  10) 只读性：投影在 `begin transaction read only` 里能跑；写语句被 PG 25006 拒绝
//     （用迁移自带的 seed 行，不依赖任何本地演示增量；0002 seed 是迁移的一部分）
// =====================================================================

test('投影可跑在 `begin transaction read only` 里（只读由 DB 强制，不靠自觉）', async () => {
  const client = await POOL.connect()
  try {
    await client.query('begin transaction read only')
    const overview = await readRecruitingOverview({ database: CFG, client })
    assert.equal(overview.configured, true)
    // 迁移 seed 保证至少有 1 条 application（CI fresh DB 与本地库都成立）。
    const applications = await rows<{ id: string }>(client,
      'select id::text as id from recruitment.application where tenant_id = $1 order by id asc limit 1', [TENANT])
    const applicationId = applications[0]?.id
    assert.ok(applicationId !== undefined, '迁移 seed 必须提供至少 1 条 application')
    const detail = await readApplicationDetail({ database: CFG, client }, applicationId)
    assert.equal(detail.application.application_id, applicationId)
    const jobs = await rows<{ id: string }>(client,
      'select id::text as id from recruitment.job where tenant_id = $1 order by id asc limit 1', [TENANT])
    const jobId = jobs[0]?.id
    assert.ok(jobId !== undefined, '迁移 seed 必须提供至少 1 个 job')
    const jobDetail = await readJobDetail({ database: CFG, client }, jobId)
    assert.equal(jobDetail.job.job_id, jobId)
    // 反证：只读事务里任何写语句会被 PG 拒绝（证明投影没有写库）。
    await assert.rejects(
      () => client.query('update recruitment.application set record_version = record_version where tenant_id = $1', [TENANT]),
      (error: unknown) => {
        const code = (error as { code?: string }).code
        assert.equal(code, '25006', `只读事务里的写必须被 PG 拒绝，实际 code=${String(code)}`)
        return true
      },
    )
  } finally {
    await client.query('rollback')
    client.release()
  }
})
