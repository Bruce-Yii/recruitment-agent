// 面评提交工具（`recruitment_scorecard_submit`）的**真库**集成测试。
//
// 纪律（`test/integration/db.ts` 的三条 + 本轮任务书）：
//   1. 每个用例都在自己的事务里跑并一律 ROLLBACK —— 不污染 `ra_s6s7`；
//   2. 连不上库就**失败**（不静默 skip，R3 要求 `skipped === 0`）；
//   3. **不调 `execute()`**（它自建连接池，看不到未提交的夹具），只调
//      `submitScorecardInTransaction(client, cfg, args, nowMs)`；
//   4. interview / interviewer / meeting / transcript 全部由本文件自己插
//      （`seedScenario` 只产 job/job_version/rubric/candidate/材料链/application）。
//
// 覆盖：正常提交两行（两个不同 interviewer actor）+ SC-44 三列审计 + 幂等重放/键复用 +
// ACTOR_NOT_HUMAN / ACTOR_NOT_INTERVIEWER / ALREADY_SUBMITTED + 修订三步舞 + PENDING 原地转正 +
// REJECT 理由 + TRANSCRIPT_BASIS_CONFLICT + RUBRIC_NOT_OF_JOB / RUBRIC_MISMATCH / RUBRIC_UNRESOLVED +
// CANCELLED 拒收 + provenance=LIVE 的判定式。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  parseRejectReasonsFromRationale,
  submitScorecardInTransaction,
} from '../../src/tools/scorecard-submit.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  errorBody,
  hex64,
  inRolledBackTx,
  one,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const CFG = testDatabaseConfig()
const POOL = createTestPool(CFG)

after(async () => {
  await POOL.end()
})

/** 两个已存在的 HUMAN actor（`0002_seed.sql` 的演示身份）。 */
const ACTOR_102 = '11111111-1111-4111-8111-000000000102'
const ACTOR_104 = '11111111-1111-4111-8111-000000000104'

/** 面评用的三个维度（与演示 rubric v1 同形）。 */
const DIMENSIONS = [
  { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
  { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
] as const

/** 工具出参的测试侧形状（TC §2.2）。 */
interface SubmitOutput {
  tool: string
  contract_version: string
  status: string
  replayed: boolean
  labels: { provenance: string; trigger: string; connection: string }
  scorecard: {
    id: string
    revision_no: number
    status: string
    interview_id: string
    interviewer_id: string
    actor_id: string
    rubric_version_id: string
    rubric_payload_hash: string
    rubric_resolution: string
    transcript_basis: string
    payload_hash: string
    submitted_at: string
    status_changed_by_actor_id: string
    status_source_event_id: string
    record_version: number
  }
  interview: { round_no: number; slot_code: string; scheduled_start_at?: string; status: string }
  coverage: {
    dimensions_total: number
    dimensions_assessed: number
    by_assessment: { met: number; not_met: number; not_observed: number; unreadable: number }
  }
  superseded?: { scorecard_id: string; revision_no: number }
  warnings: { code: string; message: string }[]
}

/** 断言某次调用抛的契约错误是 `code` + `reason_code`。 */
function expectError(fn: () => Promise<unknown>, code: string, reasonCode: string): Promise<Record<string, unknown>> {
  return fn().then(
    () => assert.fail(`期望抛错 ${code}/${reasonCode}，但成功了`),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, code, `期望 code=${code}，实际 ${String(body.code)}`)
      assert.equal(body.reason_code, reasonCode, `期望 reason_code=${reasonCode}，实际 ${String(body.reason_code)}`)
      const message = error instanceof Error ? error.message : String(error)
      assert.ok(message.startsWith(`${code}: `), `错误消息必须以 "${code}: " 开头`)
      return body
    },
  )
}

/** 切换事务里的执行身份（`set_config(..., is_local = true)`）。 */
async function setActor(client: DatabaseClient, actorId: string): Promise<void> {
  await client.query("select set_config('recruitment.actor_id', $1, true)", [actorId])
}

function idempotencyKey(tag: string): string {
  return `sc:${uniqueSuffix()}:${tag}`
}

async function submit(
  client: DatabaseClient,
  args: Record<string, unknown>,
): Promise<SubmitOutput> {
  return (await submitScorecardInTransaction(client, CFG, args, Date.now())) as unknown as SubmitOutput
}

/** 造一场面试（默认 POST_INTERVIEW + 有排期，`ck_interview_scheduled` 要求非空）。 */
async function addInterview(
  client: DatabaseClient,
  applicationId: string,
  options: { status?: string; roundNo?: number; slotCode?: string } = {},
): Promise<string> {
  return one(
    client,
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at)
     values ($1, $2, $3, $4, $5, now() - interval '2 days') returning id`,
    [
      TENANT,
      applicationId,
      options.roundNo ?? 1,
      options.slotCode ?? 'DEFAULT',
      options.status ?? 'POST_INTERVIEW',
    ],
  )
}

async function addInterviewer(
  client: DatabaseClient,
  interviewId: string,
  actorId: string,
  requiredScorecard = true,
): Promise<string> {
  return one(
    client,
    `insert into recruitment.interviewer (tenant_id, interview_id, actor_id, required_scorecard)
     values ($1, $2, $3, $4) returning id`,
    [TENANT, interviewId, actorId, requiredScorecard],
  )
}

/** 造一个非 HUMAN 的 actor（`ACTOR_NOT_HUMAN` 用）。 */
async function addAgentActor(client: DatabaseClient): Promise<string> {
  return one(
    client,
    `insert into recruitment.actor (tenant_id, kind, display_name)
     values ($1, 'AGENT_WORKER', $2) returning id`,
    [TENANT, `测试 agent ${uniqueSuffix()}`],
  )
}

/** 给一场面试绑一个 meeting（`provider` 决定 provenance 判定式的会议那一段）。 */
async function bindMeeting(
  client: DatabaseClient,
  interviewId: string,
  provider = 'fixture',
): Promise<string> {
  const meetingId = await one(
    client,
    `insert into recruitment.meeting (tenant_id, provider, external_meeting_id)
     values ($1, $2, $3) returning id`,
    [TENANT, provider, `ext-${uniqueSuffix()}`],
  )
  await one(
    client,
    `insert into recruitment.meeting_binding (tenant_id, meeting_id, interview_id, binding_method)
     values ($1, $2, $3, 'SCHEDULED') returning id`,
    [TENANT, meetingId, interviewId],
  )
  return meetingId
}

/**
 * 给面试的 meeting 造一条 canonical transcript。
 * `READY` 需要 `is_complete` + `content_sha256`（`ck_transcript_artifact_ready`），
 * `is_complete` 又只允许在 `READY` 时为 true（`ck_transcript_artifact_not_complete`）。
 */
async function addCanonicalTranscript(
  client: DatabaseClient,
  interviewId: string,
  transcriptStatus = 'READY',
): Promise<{ meetingId: string; artifactId: string }> {
  const meetingId = await bindMeeting(client, interviewId)
  const artifactId = await one(
    client,
    `insert into recruitment.transcript_artifact
       (tenant_id, meeting_id, provider, provider_artifact_id, transcript_status, provenance,
        trigger_mode, connection_state, content_sha256, is_complete, is_canonical, raw_text)
     values ($1, $2, 'fixture', $3, $4, 'FIXTURE', 'MANUAL', 'CONNECTED', $5, $6, true, '面试原文片段')
     returning id`,
    [
      TENANT,
      meetingId,
      `art-${uniqueSuffix()}`,
      transcriptStatus,
      hex64(`sha${uniqueSuffix()}`),
      transcriptStatus === 'READY',
    ],
  )
  return { meetingId, artifactId }
}

/** 一份合法 items（三个维度 + 保留键）。 */
function itemsFor(
  basis: 'TRANSCRIPT' | 'NO_TRANSCRIPT' = 'NO_TRANSCRIPT',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    transcript_basis: basis,
    backend_depth: { assessment: 'MET', score: 4, note: '讲清了分片键的选择' },
    async_pipeline: { assessment: 'NOT_MET', score: 2, note: '队列重放答不上来' },
    frontend_basics: { assessment: 'NOT_OBSERVED' },
    ...overrides,
  }
}

/** 一份合法的提交入参（HOLD + NO_TRANSCRIPT）。 */
function submitArgs(interviewId: string, key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    interview_id: interviewId,
    items: itemsFor('NO_TRANSCRIPT'),
    overall: 'HOLD',
    idempotency_key: key,
    ...extra,
  }
}

interface ScorecardRow {
  id: string
  interviewer_id: string
  rubric_version_id: string
  status: string
  revision_no: number
  record_version: number
  superseded_by_scorecard_id: string | null
  payload_hash: string | null
  overall: string | null
  rationale: string | null
  items: Record<string, unknown> | null
  submitted_at: Date | null
  created_at: Date
  status_changed_by_actor_id: string | null
  status_changed_at: Date
  status_source_event_id: string | null
  event_rows: number
}

async function readScorecard(client: DatabaseClient, scorecardId: string): Promise<ScorecardRow> {
  const { rows } = await client.query<ScorecardRow>(
    `select s.id, s.interviewer_id, s.rubric_version_id, s.status, s.revision_no, s.record_version,
            s.superseded_by_scorecard_id, s.payload_hash, s.overall, s.rationale, s.items,
            s.submitted_at, s.created_at, s.status_changed_by_actor_id, s.status_changed_at,
            s.status_source_event_id,
            (select count(*)::int from recruitment.event_inbox e
              where e.event_id = s.status_source_event_id and e.tenant_id = s.tenant_id) as event_rows
       from recruitment.scorecard s
      where s.id = $1 and s.tenant_id = $2`,
    [scorecardId, TENANT],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`scorecard ${scorecardId} 不存在`)
  return row
}

/** 当前行（`superseded_by_scorecard_id is null`）。 */
async function currentRows(
  client: DatabaseClient,
  interviewId: string,
  interviewerId: string,
): Promise<{ id: string; revision_no: number; record_version: number; status: string }[]> {
  const { rows } = await client.query<{ id: string; revision_no: number; record_version: number; status: string }>(
    `select id, revision_no, record_version, status
       from recruitment.scorecard
      where interview_id = $1 and interviewer_id = $2 and tenant_id = $3
        and superseded_by_scorecard_id is null`,
    [interviewId, interviewerId, TENANT],
  )
  return rows
}

async function countRows(client: DatabaseClient, table: string, where?: string, params?: readonly unknown[]): Promise<number> {
  // 注意：`scorecard` / `event_inbox` 在 ra_s6s7 里**可能有别的 lane 或演示脚本留下的已提交行**，
  // 所以断言"只多了 N 行"必须按本用例的 interview_id 限定范围；直接 `count(*)` 全表会假红
  // （2026-11-13 实测：演示链跑完后全表 3 行，把"拒收调用不得写任何行"的 0 断言打红）。
  const suffix = where === undefined ? '' : ` where ${where}`
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from recruitment.${table}${suffix}`, params === undefined ? [] : [...params],
  )
  return rows[0]?.n ?? 0
}

async function readEvent(client: DatabaseClient, eventId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select event_id, provider, event_type, idempotency_key, idempotency_source, source_object_id,
            payload->>'payload_hash' as payload_hash, payload->>'scorecard_id' as payload_scorecard_id,
            payload->>'interview_id' as payload_interview_id, payload->>'interviewer_id' as payload_interviewer_id,
            trust_level
       from recruitment.event_inbox
      where event_id = $1 and tenant_id = $2`,
    [eventId, TENANT],
  )
  return rows[0]
}

/** 造一条"别的岗位"的 rubric（`RUBRIC_NOT_OF_JOB` 用）。 */
async function otherJobRubric(
  client: DatabaseClient,
  dimensions: readonly Record<string, unknown>[],
): Promise<{ jobId: string; rubricId: string }> {
  const scenario = await seedScenario(client, { dimensions })
  return { jobId: scenario.jobId, rubricId: scenario.rubricId }
}

/** 在同一岗位下再插一个 rubric 版本（`RUBRIC_MISMATCH` 用）。 */
async function secondRubricSameJob(
  client: DatabaseClient,
  jobId: string,
  dimensions: readonly Record<string, unknown>[],
): Promise<string> {
  return one(
    client,
    `insert into recruitment.rubric_version
       (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
     values ($1, $2, 2, $3::jsonb, $4, $5) returning id`,
    [TENANT, jobId, JSON.stringify(dimensions), hex64(`rubric2${uniqueSuffix()}`), ACTOR_102],
  )
}

/**
 * 造一条**非 internal** 的材料链 + 一份申请（`provenance=LIVE` 的判定式需要）。
 * 材料链：event(provider=feishu) → intake_record → intake_asset → resume → resume_version。
 */
async function liveApplication(
  client: DatabaseClient,
  job: { jobId: string; jobVersionId: string; rubricId: string },
): Promise<string> {
  const suffix = uniqueSuffix()
  const candidateId = await one(
    client,
    `insert into recruitment.candidate (tenant_id, display_name, identity_status)
     values ($1, $2, 'ACTIVE') returning id`,
    [TENANT, `LIVE 候选人 ${suffix}`],
  )
  const eventId = await one(
    client,
    `insert into recruitment.event_inbox
       (tenant_id, provider, event_type, idempotency_key, payload, trust_level)
     values ($1, 'feishu', 'message.received', $2, '{}'::jsonb, 'UNTRUSTED_EXTERNAL') returning event_id`,
    [TENANT, `feishu:${suffix}`],
  )
  const intakeRecordId = await one(
    client,
    `insert into recruitment.intake_record (tenant_id, event_id, subject, status)
     values ($1, $2, 'LIVE 收件', 'RESOLVED') returning id`,
    [TENANT, eventId],
  )
  const sha = hex64(`live${suffix}`)
  const assetId = await one(
    client,
    `insert into recruitment.intake_asset
       (tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref, validation_status)
     values ($1, $2, 'live.pdf', 'application/pdf', 2048, $3, 'live', 'VALID') returning id`,
    [TENANT, intakeRecordId, sha],
  )
  const resumeId = await one(
    client,
    `insert into recruitment.resume (tenant_id, candidate_id, intake_asset_id)
     values ($1, $2, $3) returning id`,
    [TENANT, candidateId, assetId],
  )
  const resumeVersionId = await one(
    client,
    `insert into recruitment.resume_version
       (tenant_id, resume_id, version_no, source_asset_sha256, content_sha256, parser_name, parser_version,
        parse_status, parsed_fields, evidence)
     values ($1, $2, 1, $3, $4, 'pymupdf', '1.0.0', 'PARSED', '{"fields":{}}'::jsonb, '[]'::jsonb) returning id`,
    [TENANT, resumeId, sha, hex64(`livecontent${suffix}`)],
  )
  return one(
    client,
    `insert into recruitment.application
       (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
        lifecycle_status, current_stage_code)
     values ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'S7') returning id`,
    [TENANT, candidateId, job.jobId, job.jobVersionId, job.rubricId, resumeVersionId],
  )
}

// =====================================================================
//  1. 正常提交（两个不同 interviewer actor）+ SC-44 三列审计
// =====================================================================

test('正常提交：两个不同 interviewer actor 各交一行，SELECT 读回 interviewer_id 不同、rubric 正确、审计齐全', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    const interviewer102 = await addInterviewer(client, interviewId, ACTOR_102)
    const interviewer104 = await addInterviewer(client, interviewId, ACTOR_104)

    await setActor(client, ACTOR_102)
    const first = await submit(client, submitArgs(interviewId, idempotencyKey('a102')))
    assert.equal(first.tool, 'recruitment_scorecard_submit')
    assert.equal(first.contract_version, '2.0.0')
    assert.equal(first.status, 'OK')
    assert.equal(first.replayed, false)
    assert.equal(first.labels.trigger, 'MANUAL')
    assert.equal(first.labels.connection, 'CONNECTED')
    assert.equal(first.labels.provenance, 'FIXTURE', 'seedScenario 的材料链是 internal 事件 → FIXTURE')
    assert.ok(first.warnings.some((warning) => warning.code === 'FIXTURE_BASIS'))
    assert.equal(Object.hasOwn(first, 'superseded'), false, '不是修订就没有 superseded 键')
    assert.equal(first.scorecard.revision_no, 1)
    assert.equal(first.scorecard.status, 'SUBMITTED')
    assert.equal(first.scorecard.rubric_version_id, scenario.rubricId)
    assert.equal(first.scorecard.rubric_resolution, 'APPLICATION_PINNED')
    assert.equal(first.scorecard.transcript_basis, 'NO_TRANSCRIPT')
    assert.equal(first.scorecard.actor_id, ACTOR_102)
    assert.equal(first.coverage.dimensions_total, 3)
    assert.equal(first.coverage.dimensions_assessed, 3)
    assert.deepEqual(first.coverage.by_assessment, { met: 1, not_met: 1, not_observed: 1, unreadable: 0 })
    assert.equal(first.interview.round_no, 1)
    assert.equal(first.interview.slot_code, 'DEFAULT')
    assert.equal(first.interview.status, 'POST_INTERVIEW')
    assert.ok(typeof first.interview.scheduled_start_at === 'string')

    const row1 = await readScorecard(client, first.scorecard.id)
    assert.equal(row1.interviewer_id, interviewer102)
    assert.equal(row1.rubric_version_id, scenario.rubricId)
    assert.equal(row1.status, 'SUBMITTED')
    assert.equal(row1.status_changed_by_actor_id, ACTOR_102)
    assert.ok(row1.status_source_event_id !== null, 'SC-44：终态行必须带 status_source_event_id')
    assert.equal(row1.event_rows, 1, 'SC-44：status_source_event_id 必须指向存在的 event_inbox 行')
    assert.ok(row1.submitted_at !== null)
    assert.equal(row1.submitted_at.getTime(), row1.created_at.getTime(), 'SC-16：submitted_at 与 created_at 同值')
    const event1 = await readEvent(client, row1.status_source_event_id as string)
    assert.equal(event1?.provider, 'internal')
    assert.equal(event1?.event_type, 'scorecard.submit')
    assert.equal(event1?.idempotency_source, 'FALLBACK_KEY')
    assert.equal(event1?.trust_level, 'INTERNAL')
    assert.equal(event1?.source_object_id, first.scorecard.id)
    assert.equal(event1?.payload_scorecard_id, first.scorecard.id)
    assert.equal(event1?.payload_interview_id, interviewId)
    assert.equal(event1?.payload_interviewer_id, interviewer102)
    assert.equal(event1?.payload_hash, row1.payload_hash)

    await setActor(client, ACTOR_104)
    const second = await submit(client, submitArgs(interviewId, idempotencyKey('a104')))
    assert.equal(second.scorecard.interviewer_id, interviewer104)
    assert.equal(second.scorecard.actor_id, ACTOR_104)
    const row2 = await readScorecard(client, second.scorecard.id)
    assert.equal(row2.interviewer_id, interviewer104)
    assert.equal(row2.status_changed_by_actor_id, ACTOR_104)
    assert.equal(row2.event_rows, 1)
    assert.notEqual(row1.interviewer_id, row2.interviewer_id, '两个面试官各交自己的行')
    assert.notEqual(row1.id, row2.id)

    const { rows } = await client.query<{ n: number }>(
      'select count(*)::int as n from recruitment.scorecard where interview_id = $1 and tenant_id = $2',
      [interviewId, TENANT],
    )
    assert.equal(rows[0]?.n, 2)
  })
})

// =====================================================================
//  2. 幂等（SC-37 / G-2）
// =====================================================================

test('幂等重放：同 key 同 payload 第二次 replayed=true，行数与 record_version 都不变', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const key = idempotencyKey('replay')
    const args = submitArgs(interviewId, key)
    const first = await submit(client, args)
    const rowsAfterFirst = await countRows(client, 'scorecard')
    const eventsAfterFirst = await countRows(client, 'event_inbox')
    const recordVersionAfterFirst = (await readScorecard(client, first.scorecard.id)).record_version

    const second = await submit(client, args)
    assert.equal(second.replayed, true)
    assert.equal(second.scorecard.id, first.scorecard.id)
    assert.equal(second.scorecard.record_version, recordVersionAfterFirst)
    assert.equal(second.scorecard.payload_hash, first.scorecard.payload_hash)
    assert.equal(second.scorecard.submitted_at, first.scorecard.submitted_at)
    assert.equal(await countRows(client, 'scorecard'), rowsAfterFirst, '重放不得新增行')
    assert.equal(await countRows(client, 'event_inbox'), eventsAfterFirst, '重放不得新增事件')
  })
})

test('幂等键复用（同 key 不同 payload）→ INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)，不新增行', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const key = idempotencyKey('reuse')
    await submit(client, submitArgs(interviewId, key))
    const rowsAfterFirst = await countRows(client, 'scorecard')

    const body = await expectError(
      () => submit(client, submitArgs(interviewId, key, { overall: 'HOLD', items: itemsFor('NO_TRANSCRIPT', {
        backend_depth: { assessment: 'MET', score: 5, note: '换了一个分数' },
      }) })),
      'INVALID_ARGS',
      'IDEMPOTENCY_KEY_REUSED',
    )
    const detail = body.detail as Record<string, unknown>
    assert.equal(detail.idempotency_key, key)
    assert.equal(await countRows(client, 'scorecard'), rowsAfterFirst)
  })
})

// =====================================================================
//  3. 身份三闸（SC-01/02/03）
// =====================================================================

test('ACTOR_NOT_HUMAN：AGENT_WORKER 即便有 interviewer 行也不能交（SC-03）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    const agentId = await addAgentActor(client)
    await addInterviewer(client, interviewId, agentId)

    await setActor(client, agentId)
    const before = await countRows(client, 'scorecard')
    const body = await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('agent'))),
      'INTERVIEWER_MISMATCH',
      'ACTOR_NOT_HUMAN',
    )
    assert.equal((body.detail as Record<string, unknown>).actor_id, agentId)
    assert.equal(await countRows(client, 'scorecard'), before, '被拒的提交不得留下任何行')
  })
})

test('ACTOR_NOT_INTERVIEWER：HUMAN 但不在该场面试的 interviewer 表里（SC-02）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)

    await setActor(client, ACTOR_104)
    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('stranger'))),
      'INTERVIEWER_MISMATCH',
      'ACTOR_NOT_INTERVIEWER',
    )
  })
})

test('ACTOR_REQUIRED：事务里没有 recruitment.actor_id → INVALID_ARGS(ACTOR_REQUIRED)（登记偏差）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await client.query("select set_config('recruitment.actor_id', '', true)")
    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('noactor'))),
      'INVALID_ARGS',
      'ACTOR_REQUIRED',
    )
  })
})

test('TC §7.1 第 2 条：入参出现 interviewer_id / tenant_id / actor_id → TENANT_OR_ACTOR_NOT_ALLOWED（不是 UNKNOWN_PARAM）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const body = await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('reserved'), {
        interviewer_id: randomUUID(),
        tenant_id: TENANT,
        actor_id: ACTOR_104,
      })),
      'INVALID_ARGS',
      'TENANT_OR_ACTOR_NOT_ALLOWED',
    )
    const violations = (body.detail as Record<string, unknown>).violations as Record<string, unknown>[]
    assert.equal(violations.length, 3)
    assert.equal(await countRows(client, 'scorecard', 'interview_id = $1 and tenant_id = $2', [interviewId, TENANT]), 0, '拒收的调用不得写任何行')
  })
})

test('SC-46：required_scorecard=false 的旁听者也能交自己的面评（不进分母是 summarize 的事）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    const observerId = await addInterviewer(client, interviewId, ACTOR_104, false)
    await setActor(client, ACTOR_104)

    const ok = await submit(client, submitArgs(interviewId, idempotencyKey('observer')))
    assert.equal(ok.scorecard.interviewer_id, observerId)
    assert.equal(ok.scorecard.status, 'SUBMITTED')
  })
})

// =====================================================================
//  4. ALREADY_SUBMITTED（SC-04）
// =====================================================================

test('ALREADY_SUBMITTED：已有 SUBMITTED 当前行、未带 revision → SCORECARD_ALREADY_SUBMITTED', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const first = await submit(client, submitArgs(interviewId, idempotencyKey('once')))
    const body = await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('twice'))),
      'ALREADY_SUBMITTED',
      'SCORECARD_ALREADY_SUBMITTED',
    )
    const detail = body.detail as Record<string, unknown>
    assert.equal(detail.scorecard_id, first.scorecard.id)
    assert.equal(await countRows(client, 'scorecard', 'interview_id = $1 and tenant_id = $2', [interviewId, TENANT]), 1)
  })
})

// =====================================================================
//  5. 修订三步舞（SC-18/19/39/44，§5.2）
// =====================================================================

test('修订三步舞：改后 current 恰好 1 行、revision_no=2、旧行仍在且指向新行、旧行 record_version+1', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    const interviewerId = await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const first = await submit(client, submitArgs(interviewId, idempotencyKey('rev1')))
    const oldRow = await readScorecard(client, first.scorecard.id)
    assert.equal(oldRow.record_version, 1)

    const revised = await submit(client, submitArgs(interviewId, idempotencyKey('rev2'), {
      items: itemsFor('NO_TRANSCRIPT', {
        async_pipeline: { assessment: 'MET', score: 3, note: '回听录音后确认答上了' },
      }),
      revision: {
        supersedes_scorecard_id: first.scorecard.id,
        expected_record_version: 1,
        revision_reason: '当时把 async_pipeline 判成 NOT_MET，回听录音后确认是我听错了',
      },
    }))
    assert.notEqual(revised.scorecard.id, first.scorecard.id, '修订是新 id，不是同 id 改内容（SC-18）')
    assert.equal(revised.scorecard.revision_no, 2)
    assert.deepEqual(revised.superseded, { scorecard_id: first.scorecard.id, revision_no: 1 })

    const current = await currentRows(client, interviewId, interviewerId)
    assert.equal(current.length, 1, '修订后 current 必须恰好 1 行（三步舞第 3 步不能漏）')
    assert.equal(current[0]?.id, revised.scorecard.id)
    assert.equal(current[0]?.revision_no, 2)

    const oldAgain = await readScorecard(client, first.scorecard.id)
    assert.equal(oldAgain.superseded_by_scorecard_id, revised.scorecard.id, '旧行的指针必须指向新行')
    assert.equal(oldAgain.record_version, 2, '换指针会触发 fn_row_guard（record_version 旧值 + 1）')
    assert.equal(oldAgain.status, 'SUBMITTED')

    const newRow = await readScorecard(client, revised.scorecard.id)
    assert.equal(newRow.revision_no, 2)
    assert.equal(newRow.record_version, revised.scorecard.record_version, '出参必须回显库里的真实 record_version')
    assert.equal(newRow.status_changed_by_actor_id, ACTOR_102)
    assert.equal(newRow.event_rows, 1)
    assert.ok(typeof newRow.rationale === 'string')
    assert.ok((newRow.rationale as string).startsWith('修订原因：'), 'SC-19：修订原因进新行 rationale 首行')
    assert.ok((newRow.rationale as string).includes('REJECT_REASONS_JSON: '))

    // 旧行的 rubric 绑定不变（SC-42）
    assert.equal(oldAgain.rubric_version_id, scenario.rubricId)
  })
})

test('幂等重放（修订路径）：重放同 key 返回新行原结果（replayed=true、superseded 指针一致、不再新增行）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const first = await submit(client, submitArgs(interviewId, idempotencyKey('r1')))
    const revisionKey = idempotencyKey('r2')
    const revisionArgs = submitArgs(interviewId, revisionKey, {
      revision: {
        supersedes_scorecard_id: first.scorecard.id,
        expected_record_version: 1,
        revision_reason: '回听录音后改判',
      },
    })
    const revised = await submit(client, revisionArgs)
    const rowsAfterRevision = await countRows(client, 'scorecard')

    const replay = await submit(client, revisionArgs)
    assert.equal(replay.replayed, true)
    assert.equal(replay.scorecard.id, revised.scorecard.id)
    assert.deepEqual(replay.superseded, { scorecard_id: first.scorecard.id, revision_no: 1 })
    assert.equal(replay.scorecard.revision_no, 2)
    assert.equal(await countRows(client, 'scorecard'), rowsAfterRevision, '重放不得新增行')
  })
})

test('修订：expected_record_version 不匹配 → VERSION_CONFLICT(RECORD_VERSION_MISMATCH)', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)
    const first = await submit(client, submitArgs(interviewId, idempotencyKey('v1')))

    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('v2'), {
        revision: {
          supersedes_scorecard_id: first.scorecard.id,
          expected_record_version: 7,
          revision_reason: '并发场景：我不是最后一个写的人',
        },
      })),
      'VERSION_CONFLICT',
      'RECORD_VERSION_MISMATCH',
    )
  })
})

test('修订：supersedes 指向的不是当前行 → ALREADY_SUBMITTED(SCORECARD_ALREADY_SUPERSEDED)', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)
    await submit(client, submitArgs(interviewId, idempotencyKey('s1')))

    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('s2'), {
        revision: {
          supersedes_scorecard_id: randomUUID(),
          expected_record_version: 1,
          revision_reason: '指向了一个不存在的行',
        },
      })),
      'ALREADY_SUBMITTED',
      'SCORECARD_ALREADY_SUPERSEDED',
    )
  })
})

// =====================================================================
//  6. PENDING 原地转正（SC-45 / TC §7.5 第 11 条）
// =====================================================================

/** 人为造一条 PENDING 当前行（历史数据 / 别的路径留下的）。 */
async function insertPendingScorecard(
  client: DatabaseClient,
  input: {
    interviewId: string
    interviewerId: string
    rubricId: string
    items: Record<string, unknown>
  },
): Promise<string> {
  return one(
    client,
    `insert into recruitment.scorecard
       (id, tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status, items, overall)
     values ($1, $2, $3, $4, $5, 1, 'PENDING', $6::jsonb, 'HOLD') returning id`,
    [randomUUID(), TENANT, input.interviewId, input.interviewerId, input.rubricId, JSON.stringify(input.items)],
  )
}

test('PENDING 原地转正：同一行变成 SUBMITTED、record_version=旧值+1、事件由 fn_row_guard 回填', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    const interviewerId = await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const pendingId = await insertPendingScorecard(client, {
      interviewId,
      interviewerId,
      rubricId: scenario.rubricId,
      items: { transcript_basis: 'NO_TRANSCRIPT' },
    })
    const before = await readScorecard(client, pendingId)
    assert.equal(before.status, 'PENDING')
    assert.equal(before.record_version, 1)
    assert.equal(before.status_source_event_id, null)
    const eventsBefore = await countRows(client, 'event_inbox')

    const out = await submit(client, submitArgs(interviewId, idempotencyKey('promote'), {
      revision: {
        supersedes_scorecard_id: pendingId,
        expected_record_version: 1,
        revision_reason: '把历史 PENDING 行转正',
      },
    }))

    assert.equal(out.scorecard.id, pendingId, '原地转正不产生新 id（不撞 uq_scorecard_current）')
    assert.equal(out.scorecard.revision_no, 1)
    assert.equal(out.scorecard.status, 'SUBMITTED')
    assert.equal(out.scorecard.record_version, 2, '出参回显旧值 + 1（SC-45）')
    assert.equal(Object.hasOwn(out, 'superseded'), false, '原地转正没有"被替换的新行"')

    const after = await readScorecard(client, pendingId)
    assert.equal(after.status, 'SUBMITTED')
    assert.equal(after.record_version, 2)
    assert.ok(after.submitted_at !== null)
    assert.equal(after.status_changed_by_actor_id, ACTOR_102)
    assert.ok(after.status_source_event_id !== null, '事件必须由 fn_row_guard 回填')
    assert.equal(after.event_rows, 1)
    const event = await readEvent(client, after.status_source_event_id as string)
    assert.equal(event?.event_type, 'scorecard.status.changed')
    assert.equal(event?.source_object_id, pendingId)
    assert.equal(await countRows(client, 'event_inbox'), eventsBefore + 1, '库自己插了一条事件（不是"一行 UPDATE 什么都不发生"）')

    const current = await currentRows(client, interviewId, interviewerId)
    assert.equal(current.length, 1)
    assert.equal(current[0]?.id, pendingId)
  })
})

test('PENDING 原地转正：不带 revision 也允许（SC-04 的 ALREADY_SUBMITTED 只覆盖 SUBMITTED/WAIVED）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    const interviewerId = await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const pendingId = await insertPendingScorecard(client, {
      interviewId,
      interviewerId,
      rubricId: scenario.rubricId,
      items: {},
    })
    const out = await submit(client, submitArgs(interviewId, idempotencyKey('promote2')))
    assert.equal(out.scorecard.id, pendingId)
    assert.equal((await readScorecard(client, pendingId)).status, 'SUBMITTED')
    assert.equal(out.scorecard.record_version, 2)
  })
})

// =====================================================================
//  7. REJECT（SC-29/30/31/32）
// =====================================================================

test('REJECT：没带 reject_reasons → REJECT_REASON_INCOMPLETE；带理由则成功并把理由写进 rationale', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('reject0'), {
        items: itemsFor('NO_TRANSCRIPT', {
          frontend_basics: { assessment: 'MET', note: '会写一点前端' },
        }),
        overall: 'REJECT',
      })),
      'INVALID_ARGS',
      'REJECT_REASON_INCOMPLETE',
    )

    const ok = await submit(client, submitArgs(interviewId, idempotencyKey('reject1'), {
      items: itemsFor('NO_TRANSCRIPT', {
        frontend_basics: { assessment: 'MET', note: '会写一点前端' },
      }),
      overall: 'REJECT',
      reject_reasons: [{
        dimension_key: 'async_pipeline',
        observation: '追问队列重放两次都答成"重试就行"',
        why_decisive: '该维度是 MUST_HAVE，且已给两次澄清机会',
        evidence: [],
        evidence_state: 'MEMORY_ONLY',
      }],
    }))
    assert.ok(ok.warnings.some((warning) => warning.code === 'NO_TIMESTAMPED_EVIDENCE'))
    const row = await readScorecard(client, ok.scorecard.id)
    assert.equal(row.overall, 'REJECT')
    const parsed = parseRejectReasonsFromRationale(row.rationale)
    assert.equal(parsed.length, 1)
    assert.equal((parsed[0] as Record<string, unknown>).dimension_key, 'async_pipeline')
  })
})

test('REJECT：理由落在 NOT_OBSERVED 维度 → EVIDENCE_INSUFFICIENT(REJECT_BASIS_UNREADABLE)', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('reject-unreadable'), {
        overall: 'REJECT',
        reject_reasons: [{
          dimension_key: 'frontend_basics',
          observation: '这块我没来得及问',
          why_decisive: '想用它做拒绝依据',
          evidence: [],
          evidence_state: 'MEMORY_ONLY',
        }],
      })),
      'EVIDENCE_INSUFFICIENT',
      'REJECT_BASIS_UNREADABLE',
    )
  })
})

// =====================================================================
//  8. transcript_basis（TR-E2 / TR-E3）
// =====================================================================

test('TRANSCRIPT_BASIS_CONFLICT：canonical transcript 已 READY 却写 NO_TRANSCRIPT', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    const { artifactId } = await addCanonicalTranscript(client, interviewId, 'READY')
    await setActor(client, ACTOR_102)

    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('basis-conflict'), {
        items: itemsFor('NO_TRANSCRIPT'),
      })),
      'INVALID_ARGS',
      'TRANSCRIPT_BASIS_CONFLICT',
    )

    // 写成 TRANSCRIPT 就通过，并且证据可以带 SEGMENT
    const ok = await submit(client, submitArgs(interviewId, idempotencyKey('basis-ok'), {
      items: itemsFor('TRANSCRIPT', {
        backend_depth: {
          assessment: 'MET',
          score: 4,
          note: '讲清了分片键',
          evidence: [{
            kind: 'SEGMENT',
            transcript_artifact_id: artifactId,
            transcript_revision: 1,
            segment_id: randomUUID(),
            quote: '我们当时把订单表按用户 ID 分了 64 片',
          }],
        },
      }),
    }))
    assert.equal(ok.scorecard.transcript_basis, 'TRANSCRIPT')
  })
})

test('TRANSCRIPT_BASIS_CONFLICT：没有 READY 的 canonical transcript 却写 TRANSCRIPT', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await addCanonicalTranscript(client, interviewId, 'PARTIAL')
    await setActor(client, ACTOR_102)

    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('basis-partial'), {
        items: itemsFor('TRANSCRIPT'),
      })),
      'INVALID_ARGS',
      'TRANSCRIPT_BASIS_CONFLICT',
    )
  })
})

// =====================================================================
//  9. rubric 三绑定（SC-09/10/11/47）
// =====================================================================

test('RUBRIC_NOT_OF_JOB：申请没钉版本、显式给的是别的岗位的 rubric → 拒收', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS], pinRubric: false })
    const other = await otherJobRubric(client, [
      { key: 'backend_depth', label: '后端深度', kind: 'MUST_HAVE', weight: 0.6 },
      { key: 'async_pipeline', label: '异步', kind: 'MUST_HAVE', weight: 0.2 },
      { key: 'frontend_basics', label: '前端', kind: 'NICE_TO_HAVE', weight: 0.2 },
    ])
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const body = await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('wrong-job'), {
        rubric_version_id: other.rubricId,
      })),
      'INVALID_ARGS',
      'RUBRIC_NOT_OF_JOB',
    )
    const detail = body.detail as Record<string, unknown>
    assert.equal(detail.rubric_job_id, other.jobId)
    assert.equal(detail.application_job_id, scenario.jobId)
  })
})

test('RUBRIC_UNRESOLVED：申请没钉版本且入参也没给 → 拒收（不做 fallback，SC-10）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS], pinRubric: false })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)
    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('unresolved'))),
      'INVALID_ARGS',
      'RUBRIC_UNRESOLVED',
    )
  })
})

test('RUBRIC_MISMATCH：申请已钉版本但入参给了另一个版本 → 拒收（没有 what-if 面评，SC-11）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const second = await secondRubricSameJob(client, scenario.jobId, [...DIMENSIONS])
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    await expectError(
      () => submit(client, submitArgs(interviewId, idempotencyKey('mismatch'), {
        rubric_version_id: second,
      })),
      'INVALID_ARGS',
      'RUBRIC_MISMATCH',
    )

    // 显式给 = 钉住的版本则允许（APPLICATION_PINNED，不产生 RUBRIC_EXPLICIT_NOT_PINNED）
    const ok = await submit(client, submitArgs(interviewId, idempotencyKey('pinned-again'), {
      rubric_version_id: scenario.rubricId,
    }))
    assert.equal(ok.scorecard.rubric_resolution, 'APPLICATION_PINNED')
    assert.equal(ok.warnings.some((warning) => warning.code === 'RUBRIC_EXPLICIT_NOT_PINNED'), false)
  })
})

test('EXPLICIT_VERSION_ID：申请未钉版本 + 入参给的版本属于该岗位 → 成功并给出 RUBRIC_EXPLICIT_NOT_PINNED', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS], pinRubric: false })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await setActor(client, ACTOR_102)

    const ok = await submit(client, submitArgs(interviewId, idempotencyKey('explicit'), {
      rubric_version_id: scenario.rubricId,
    }))
    assert.equal(ok.scorecard.rubric_resolution, 'EXPLICIT_VERSION_ID')
    assert.equal(ok.scorecard.rubric_version_id, scenario.rubricId)
    assert.ok(ok.warnings.some((warning) => warning.code === 'RUBRIC_EXPLICIT_NOT_PINNED'))
  })
})

// =====================================================================
//  10. CANCELLED / NO_SHOW 拒收（SC-08）+ INTERVIEW_NOT_FOUND
// =====================================================================

test('CANCELLED / NO_SHOW 的面试拒收（INVALID_ARGS(INTERVIEW_CANCELLED)）', async () => {
  for (const status of ['CANCELLED', 'NO_SHOW']) {
    await inRolledBackTx(POOL, async (client) => {
      const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
      const interviewId = await addInterview(client, scenario.applicationId, { status })
      await addInterviewer(client, interviewId, ACTOR_102)
      await setActor(client, ACTOR_102)
      const body = await expectError(
        () => submit(client, submitArgs(interviewId, idempotencyKey(`cancelled-${status}`))),
        'INVALID_ARGS',
        'INTERVIEW_CANCELLED',
      )
      assert.equal((body.detail as Record<string, unknown>).interview_status, status)
    })
  }
})

test('面试不存在 → NOT_FOUND(INTERVIEW_NOT_FOUND)', async () => {
  await inRolledBackTx(POOL, async (client) => {
    await setActor(client, ACTOR_102)
    await expectError(
      () => submit(client, submitArgs(randomUUID(), idempotencyKey('missing'))),
      'NOT_FOUND',
      'INTERVIEW_NOT_FOUND',
    )
  })
})

// =====================================================================
//  11. labels.provenance 判定式（TC §1.3）
// =====================================================================

test('provenance=LIVE：非 internal 的材料事件链 + 非 internal 的会议，且不再报 FIXTURE_BASIS', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const applicationId = await liveApplication(client, scenario)
    const interviewId = await addInterview(client, applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await bindMeeting(client, interviewId, 'feishu')
    await setActor(client, ACTOR_102)

    const ok = await submit(client, submitArgs(interviewId, idempotencyKey('live')))
    assert.equal(ok.labels.provenance, 'LIVE')
    assert.equal(ok.warnings.some((warning) => warning.code === 'FIXTURE_BASIS'), false)
  })
})

test('provenance=FIXTURE：材料链事件是 internal（即使会议 provider 非 internal）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await addInterview(client, scenario.applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await bindMeeting(client, interviewId, 'feishu')
    await setActor(client, ACTOR_102)

    const ok = await submit(client, submitArgs(interviewId, idempotencyKey('fixture')))
    assert.equal(ok.labels.provenance, 'FIXTURE')
    assert.ok(ok.warnings.some((warning) => warning.code === 'FIXTURE_BASIS'))
  })
})

test('provenance=FIXTURE：材料链是 LIVE，但绑定的会议 provider=internal', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const applicationId = await liveApplication(client, scenario)
    const interviewId = await addInterview(client, applicationId)
    await addInterviewer(client, interviewId, ACTOR_102)
    await bindMeeting(client, interviewId, 'internal')
    await setActor(client, ACTOR_102)

    const ok = await submit(client, submitArgs(interviewId, idempotencyKey('internal-meeting')))
    assert.equal(ok.labels.provenance, 'FIXTURE')
  })
})

