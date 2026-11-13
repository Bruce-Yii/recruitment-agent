// `recruitment_interview_get` 的集成矩阵（**连真库 ra_s6s7**，每个用例结束 ROLLBACK）。
//
// 覆盖 `manual/interview-line/SPEC.md` §5.2 的六组：
//   1. 成功读单场（S8 / round 2 / slot BACKEND / 两面试官 / meeting+binding / 一条 SUBMITTED 面评）
//      —— 同时证明 `readInterviewValue` 与 `getInTransaction` 给出同一个元素（A 侧依赖这一点）；
//   2. 未绑会议 + 已过开始 → UNBOUND + MEETING_NOT_BOUND_OVERDUE + MISSING/NO_MEETING_BOUND；
//   3. require_transcript=true → NO_TRANSCRIPT，reason_code 与 2 的 transcript.reason_code 逐字相同；
//   4. BY_APPLICATION → 按 (round_no, slot_code) 排序、count 恒等于 interviews.length；
//   5. NOT_FOUND（随机 UUID / 申请不存在）与互斥参数；
//   6. TR-D 至少序 2 / 序 6 / 序 7（+ 序 3 的 CANONICAL_MISSING），用 `as_of` 控制时间。
//
// 纪律：夹具一律在 `inRolledBackTx` 里直接 INSERT（测试代码可以写库），结束 ROLLBACK，
// 不污染 `ra_s6s7`；不依赖真实平台数据，也不打印任何原文。
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { getInTransaction, readInterviewValue } from '../../src/tools/interview-get.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  HR_ACTOR,
  TENANT,
  createTestPool,
  errorBody,
  hex64,
  inRolledBackTx,
  one,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

/** 演示租户的种子演员（0002_seed）：0101 管理员 / 0102 招聘负责人 / 0103 HR / 0104 面试官。 */
const ACTOR_ADMIN = '11111111-1111-4111-8111-000000000101'
const ACTOR_INTERVIEWER = '11111111-1111-4111-8111-000000000104'

/** 服务端"现在"（固定值：本工具的唯一时钟是 as_of，测试不读真实时钟）。 */
const NOW_MS = Date.parse('2026-11-13T12:00:00+08:00')
/** 派生状态的基准时刻，必须早于 NOW_MS。 */
const AS_OF = '2026-11-13T00:00:00+08:00'

/** 一份能被 `seedScenario` 接受的 Rubric（本文件不跑筛选，只为满足外键与 payload_hash）。 */
const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months', label: '≥60 个月', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 60 },
]

/** 造一份完整夹具（job / rubric / candidate / event 链 / resume_version / application）。 */
async function newApplication(client: DatabaseClient): Promise<{
  applicationId: string
  candidateId: string
  jobId: string
  rubricId: string
}> {
  return seedScenario(client, { dimensions: DIMENSIONS })
}

/** 直接 INSERT 一场面试（`S8` 显式写入：0006 之后默认值也是 S8，但测试不靠默认值）。 */
async function insertInterview(client: DatabaseClient, input: {
  readonly applicationId: string
  readonly roundNo: number
  readonly slotCode?: string
  readonly status?: string
  readonly startAt?: string | null
  readonly endAt?: string | null
}): Promise<string> {
  return one(client, `insert into recruitment.interview
      (tenant_id, application_id, round_no, slot_code, stage_code, status,
       scheduled_start_at, scheduled_end_at, timezone, status_changed_by_actor_id)
      values ($1, $2, $3, $4, 'S8', $5, $6::timestamptz, $7::timestamptz, 'Asia/Shanghai', $8)
      returning id`, [
    TENANT, input.applicationId, input.roundNo, input.slotCode ?? 'DEFAULT',
    input.status ?? 'SCHEDULED', input.startAt ?? null, input.endAt ?? null, HR_ACTOR,
  ])
}

/** 直接 INSERT 一个面试官。 */
async function insertInterviewer(client: DatabaseClient, input: {
  readonly interviewId: string
  readonly actorId: string
  readonly requiredScorecard?: boolean
  readonly dueAt?: string | null
}): Promise<string> {
  return one(client, `insert into recruitment.interviewer
      (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard, scorecard_due_at)
      values ($1, $2, $3, 'INTERVIEWER', $4, $5::timestamptz)
      returning id`, [
    TENANT, input.interviewId, input.actorId, input.requiredScorecard ?? true, input.dueAt ?? null,
  ])
}

/** 造一个 meeting + 一条 SCHEDULED binding（模拟"排期时顺手绑定"）。 */
async function bindMeeting(client: DatabaseClient, input: {
  readonly interviewId: string
  readonly role?: string
  readonly actualStartAt?: string | null
  readonly actualEndAt?: string | null
}): Promise<string> {
  const suffix = uniqueSuffix()
  const meetingId = await one(client, `insert into recruitment.meeting
      (tenant_id, provider, account_scope, external_meeting_id, calendar_event_id, meeting_role,
       actual_start_at, actual_end_at)
      values ($1, 'FEISHU', 'default', $2, $3, $4, $5::timestamptz, $6::timestamptz)
      returning id`, [
    TENANT, `meeting_${suffix}`, `evt_${suffix}`, input.role ?? 'PRIMARY',
    input.actualStartAt ?? null, input.actualEndAt ?? null,
  ])
  await client.query(`insert into recruitment.meeting_binding
      (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
      values ($1, $2, $3, 'SCHEDULED', $4)`, [TENANT, meetingId, input.interviewId, HR_ACTOR])
  return meetingId
}

/** 造一条 `transcript_artifact`（FIXTURE 三维标签，不需要真实回执）。 */
async function insertArtifact(client: DatabaseClient, input: {
  readonly meetingId: string
  readonly status: string
  readonly isCanonical: boolean
  readonly isComplete?: boolean
  readonly revision?: number
}): Promise<string> {
  const suffix = uniqueSuffix()
  const ready = input.status === 'READY'
  const isComplete = input.isComplete ?? ready
  return one(client, `insert into recruitment.transcript_artifact
      (tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type, language,
       transcript_status, provenance, trigger_mode, connection_state, fetched_at,
       content_sha256, is_complete, is_canonical, raw_payload)
      values ($1, $2, 'FEISHU', $3, $4, 'ORIGINAL', 'zh', $5, 'FIXTURE', 'MANUAL', 'NOT_CONNECTED',
              now(), $6, $7, $8, $9::jsonb)
      returning id`, [
    TENANT, input.meetingId, `artifact_${suffix}`, input.revision ?? 1, input.status,
    ready ? hex64(`sha${suffix}`) : null, isComplete, input.isCanonical,
    JSON.stringify({ segments: ready ? 3 : 1 }),
  ])
}

/** 造一份面评（`submitted_at` 只在 SUBMITTED 时给，`ck_scorecard_submitted` 要求它）。 */
async function insertScorecard(client: DatabaseClient, input: {
  readonly interviewId: string
  readonly interviewerId: string
  readonly rubricId: string
  readonly status: string
  readonly items?: unknown
}): Promise<string> {
  const items = input.items ?? { transcript_basis: 'TRANSCRIPT', overall: 'PASS' }
  return one(client, `insert into recruitment.scorecard
      (tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
       submitted_at, items)
      values ($1, $2, $3, $4, 1, $5, $6::timestamptz, $7::jsonb)
      returning id`, [
    TENANT, input.interviewId, input.interviewerId, input.rubricId, input.status,
    input.status === 'SUBMITTED' ? '2026-11-10T12:30:00+08:00' : null, JSON.stringify(items),
  ])
}

/** 断言的形状（只取本文件用到的键）。 */
interface LooseInterview {
  readonly id: string
  readonly application_id: string
  readonly candidate_id: string
  readonly job_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly stage_code: string
  readonly status: string
  readonly record_version: number
  readonly scheduled_start_at?: string
  readonly scheduled_end_at?: string
  readonly duration_minutes?: number
  readonly timezone: string
  readonly status_changed_at: string
  readonly is_overdue_start: boolean
  readonly interviewers: readonly {
    interviewer_id: string
    actor_id: string
    display_name: string
    role_in_interview: string
    required_scorecard: boolean
    scorecard_due_at?: string
    scorecard?: { scorecard_id: string; status: string; revision_no: number; submitted_at?: string; transcript_basis: string }
  }[]
  readonly meeting_binding: {
    state: string
    count: number
    bindings: readonly {
      binding_id: string
      meeting_id: string
      binding_method: string
      bound_at: string
      bound_by_actor_id?: string
      provider: string
      account_scope?: string
      external_meeting_id?: string
      calendar_event_id?: string
      meeting_role: string
      actual_start_at?: string
      actual_end_at?: string
    }[]
  }
  readonly transcript: { state: string; reason_code: string; no_transcript: boolean }
  readonly evaluation: {
    required_scorecards: number
    submitted: number
    waived: number
    pending: number
    evaluation_ready: boolean
    blockers: readonly { code: string; interviewer_id?: string; actor_id?: string; interview_record_id?: string }[]
  }
  readonly warnings: readonly { code: string; message: string; interview_id?: string; meeting_id?: string }[]
}

/** `getInTransaction` 的输出形状。 */
interface LooseOutput {
  tool: string
  contract_version: string
  status: string
  read_only: boolean
  labels: { provenance: string; trigger: string; connection: string }
  as_of: string
  query: Record<string, unknown>
  count: number
  interviews: readonly LooseInterview[]
}

/** 跑一次查询并断言顶层恒等性质（`count === interviews.length`、标签、状态恒 OK）。 */
async function read(client: DatabaseClient, args: unknown): Promise<LooseOutput> {
  const output = (await getInTransaction(client, cfg, args, NOW_MS)) as unknown as LooseOutput
  assert.equal(output.tool, 'recruitment_interview_get')
  assert.equal(output.contract_version, '1.0.0')
  assert.equal(output.status, 'OK', '警告不改变 status')
  assert.equal(output.read_only, true)
  assert.deepEqual(output.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
  assert.equal(output.count, output.interviews.length, 'count 必须恒等于 interviews.length')
  return output
}

/** 递归断言：输出值里没有 null、也没有 undefined（数据库 NULL 一律省略键）。 */
function assertNoNull(value: unknown, path = '$'): void {
  assert.notEqual(value, null, `${path} 不得为 null`)
  assert.notEqual(value, undefined, `${path} 不得为 undefined`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNull(item, `${path}[${index}]`))
    return
  }
  if (typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertNoNull(child, `${path}.${key}`)
  }
}

/** 取回一次调用的契约错误体。 */
async function readError(client: DatabaseClient, args: unknown): Promise<Record<string, unknown>> {
  let caught: unknown
  try {
    await getInTransaction(client, cfg, args, NOW_MS)
  } catch (error) {
    caught = error
  }
  assert.notEqual(caught, undefined, `期望抛错，实际通过了：${JSON.stringify(args)}`)
  return errorBody(caught)
}

// ---------------------------------------------------------------------------
// 1. 成功读单场
// ---------------------------------------------------------------------------

test('成功读单场：S8 / round 2 / BACKEND / 两面试官 / meeting+binding / 一条 SUBMITTED 面评', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 2,
      slotCode: 'BACKEND',
      startAt: '2026-11-20T10:00:00+08:00',
      endAt: '2026-11-20T11:00:00+08:00',
    })
    const interviewerAdmin = await insertInterviewer(client, {
      interviewId, actorId: ACTOR_ADMIN, dueAt: '2026-11-21T10:00:00+08:00',
    })
    await insertInterviewer(client, { interviewId, actorId: ACTOR_INTERVIEWER })
    await bindMeeting(client, { interviewId })
    await insertScorecard(client, {
      interviewId, interviewerId: interviewerAdmin, rubricId: app.rubricId, status: 'SUBMITTED',
    })

    const output = await read(client, { interview_id: interviewId, as_of: AS_OF })

    // 顶层：as_of 原样回显、query 与入参一一对应。
    assert.equal(output.as_of, AS_OF, 'as_of 必须原样回显（不归一化）')
    assert.deepEqual(output.query, { mode: 'BY_INTERVIEW', interview_id: interviewId })
    assert.equal(output.count, 1)

    const interview = output.interviews[0] as LooseInterview
    assert.equal(interview.id, interviewId)
    assert.equal(interview.application_id, app.applicationId)
    assert.equal(interview.candidate_id, app.candidateId)
    assert.equal(interview.job_id, app.jobId)
    assert.equal(interview.stage_code, 'S8')
    assert.equal(interview.round_no, 2)
    assert.equal(interview.slot_code, 'BACKEND')
    assert.equal(interview.status, 'SCHEDULED')
    assert.equal(interview.record_version, 1)
    assert.equal(interview.timezone, 'Asia/Shanghai')
    assert.equal(interview.scheduled_start_at, '2026-11-20T02:00:00.000Z')
    assert.equal(interview.scheduled_end_at, '2026-11-20T03:00:00.000Z')
    assert.equal(interview.duration_minutes, 60)
    assert.equal(interview.is_overdue_start, false, 'as_of 早于开始时间 → 不算逾期')
    assert.equal(typeof interview.status_changed_at, 'string')

    // 面试官：按 actor_id 字典序（0101 < 0104），display_name 有值。
    assert.equal(interview.interviewers.length, 2)
    assert.deepEqual(interview.interviewers.map((row) => row.actor_id), [ACTOR_ADMIN, ACTOR_INTERVIEWER])
    const [first, second] = interview.interviewers
    assert.ok(first !== undefined && second !== undefined)
    assert.notEqual(first.display_name.trim(), '')
    assert.notEqual(second.display_name.trim(), '')
    assert.equal(first.role_in_interview, 'INTERVIEWER')
    assert.equal(first.required_scorecard, true)
    assert.equal(first.scorecard_due_at, '2026-11-21T02:00:00.000Z')
    assert.equal(first.scorecard?.status, 'SUBMITTED')
    assert.equal(first.scorecard?.revision_no, 1)
    assert.equal(first.scorecard?.transcript_basis, 'TRANSCRIPT')
    assert.equal(first.scorecard?.submitted_at, '2026-11-10T04:30:00.000Z')
    assert.equal(second.scorecard, undefined, '没有面评时省略这个键（不写 null）')

    // 会议绑定：一条 active 绑定，状态 BOUND_ACTIVE，count 恒等于 bindings.length。
    assert.equal(interview.meeting_binding.state, 'BOUND_ACTIVE')
    assert.equal(interview.meeting_binding.count, 1)
    assert.equal(interview.meeting_binding.bindings.length, 1)
    const binding = interview.meeting_binding.bindings[0]
    assert.ok(binding !== undefined)
    assert.equal(binding.binding_method, 'SCHEDULED')
    assert.equal(binding.provider, 'FEISHU')
    assert.equal(binding.account_scope, 'default')
    assert.equal(binding.meeting_role, 'PRIMARY')
    assert.equal(binding.bound_by_actor_id, HR_ACTOR)
    assert.match(String(binding.external_meeting_id), /^meeting_/)
    assert.match(String(binding.calendar_event_id), /^evt_/)

    // 转写：会议绑了但还没开始、也没有产物 → 序 7 PENDING/WAITING（不是 MISSING）。
    assert.deepEqual(interview.transcript, {
      state: 'PENDING', reason_code: 'WAITING', no_transcript: true,
    })

    // 评价：required=2、submitted=1、pending=1；缺记录 → RECORD_NOT_READY。
    assert.equal(interview.evaluation.required_scorecards, 2)
    assert.equal(interview.evaluation.submitted, 1)
    assert.equal(interview.evaluation.waived, 0)
    assert.equal(interview.evaluation.pending, 1)
    assert.equal(interview.evaluation.evaluation_ready, false)
    assert.deepEqual(interview.evaluation.blockers.map((blocker) => blocker.code), [
      'SCORECARD_PENDING', 'RECORD_NOT_READY',
    ])
    assert.equal(interview.evaluation.blockers[0]?.actor_id, ACTOR_INTERVIEWER)
    assert.equal(interview.evaluation.blockers[0]?.interviewer_id, second.interviewer_id)
    assert.equal(interview.evaluation.blockers[1]?.interview_record_id, undefined)

    // 有绑定、有面评依据 → 没有会议/转写类警告。
    assert.deepEqual(interview.warnings, [])

    assertNoNull(output)

    // 同一 (数据快照, as_of) 两次调用逐字节相同（契约 §1.3 幂等）。
    const again = await read(client, { interview_id: interviewId, as_of: AS_OF })
    assert.equal(JSON.stringify(again), JSON.stringify(output))

    // A 侧依赖：readInterviewValue 必须给出与 interviews[0] **完全相同**的元素。
    const direct = await readInterviewValue(client, TENANT, interviewId, AS_OF)
    assert.deepEqual(direct, interview)
  })
})

// ---------------------------------------------------------------------------
// 2/3. 未绑会议 + 逾期 → UNBOUND；require_transcript → NO_TRANSCRIPT
// ---------------------------------------------------------------------------

test('未绑会议且已过开始 → UNBOUND + MEETING_NOT_BOUND_OVERDUE + MISSING/NO_MEETING_BOUND', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 1,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    await insertInterviewer(client, { interviewId, actorId: ACTOR_INTERVIEWER, requiredScorecard: false })

    const output = await read(client, { interview_id: interviewId, as_of: AS_OF })
    const interview = output.interviews[0] as LooseInterview

    assert.equal(interview.meeting_binding.state, 'UNBOUND')
    assert.equal(interview.meeting_binding.count, 0)
    assert.deepEqual(interview.meeting_binding.bindings, [])
    assert.equal(interview.is_overdue_start, true)
    assert.deepEqual(interview.transcript, {
      state: 'MISSING', reason_code: 'NO_MEETING_BOUND', no_transcript: true,
    })
    const codes = interview.warnings.map((warning) => warning.code)
    assert.ok(codes.includes('MEETING_NOT_BOUND'), `warnings 应含 MEETING_NOT_BOUND，实际 ${codes.join(',')}`)
    assert.ok(codes.includes('MEETING_NOT_BOUND_OVERDUE'), `warnings 应含 MEETING_NOT_BOUND_OVERDUE，实际 ${codes.join(',')}`)
    for (const warning of interview.warnings) {
      assert.equal(warning.interview_id, interviewId)
      assert.notEqual(warning.message.trim(), '')
    }
    assert.equal(output.status, 'OK', '缺会议不改变 status')
    assertNoNull(output)
  })
})

test('require_transcript=true → NO_TRANSCRIPT，reason_code 与 transcript.reason_code 逐字相同', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 1,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })

    // (a) 默认 require_transcript=false：缺材料是**状态**，不是错误。
    const output = await read(client, { interview_id: interviewId, as_of: AS_OF })
    const transcript = (output.interviews[0] as LooseInterview).transcript
    assert.equal(transcript.state, 'MISSING')

    // (b) require_transcript=true：同一个数据变成**硬前置失败**。
    const body = await readError(client, {
      interview_id: interviewId, as_of: AS_OF, require_transcript: true,
    })
    assert.equal(body.code, 'NO_TRANSCRIPT')
    assert.equal(body.reason_code, transcript.reason_code, 'reason_code 必须逐字透传 transcript.reason_code')
    const detail = body.detail as { interview_id: string; transcript_state: string; meetings_total: number }
    assert.equal(detail.interview_id, interviewId)
    assert.equal(detail.transcript_state, transcript.state)
    assert.equal(detail.meetings_total, 0)
    assert.equal(Object.keys(body).sort().join(','), 'code,detail,message,reason_code')
  })
})

// ---------------------------------------------------------------------------
// 4. BY_APPLICATION
// ---------------------------------------------------------------------------

test('BY_APPLICATION：按 (round_no, slot_code) 排序、count=2，round_no 过滤有效', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    // 故意先插第 2 轮：排序不能是插入顺序。
    const second = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 2,
      slotCode: 'BACKEND',
      startAt: '2026-11-21T10:00:00+08:00',
      endAt: '2026-11-21T11:00:00+08:00',
    })
    const first = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 1,
      slotCode: 'DEFAULT',
      startAt: '2026-11-20T10:00:00+08:00',
      endAt: '2026-11-20T11:00:00+08:00',
    })

    const output = await read(client, { application_id: app.applicationId, as_of: AS_OF })
    assert.deepEqual(output.query, { mode: 'BY_APPLICATION', application_id: app.applicationId })
    assert.equal(output.count, 2)
    assert.deepEqual(output.interviews.map((row) => row.id), [first, second])
    assert.deepEqual(output.interviews.map((row) => [row.round_no, row.slot_code]), [[1, 'DEFAULT'], [2, 'BACKEND']])

    const onlyRound2 = await read(client, { application_id: app.applicationId, round_no: 2, as_of: AS_OF })
    assert.deepEqual(onlyRound2.query, { mode: 'BY_APPLICATION', application_id: app.applicationId, round_no: 2 })
    assert.equal(onlyRound2.count, 1)
    assert.equal(onlyRound2.interviews[0]?.id, second)

    // 同一申请下的另一份申请不受影响（查询必须绑租户 + 申请）。
    const other = await newApplication(client)
    const otherOutput = await read(client, { application_id: other.applicationId, as_of: AS_OF })
    assert.equal(otherOutput.count, 0)
    assert.deepEqual(otherOutput.interviews, [])
    assert.equal(otherOutput.status, 'OK')
    assertNoNull(otherOutput)
  })
})

// ---------------------------------------------------------------------------
// 5. 错误
// ---------------------------------------------------------------------------

test('NOT_FOUND：随机 UUID → INTERVIEW_NOT_FOUND；申请不存在 → APPLICATION_NOT_FOUND', async () => {
  await inRolledBackTx(pool, async (client) => {
    const missingInterview = randomUUID()
    const interviewBody = await readError(client, { interview_id: missingInterview, as_of: AS_OF })
    assert.equal(interviewBody.code, 'NOT_FOUND')
    assert.equal(interviewBody.reason_code, 'INTERVIEW_NOT_FOUND')
    assert.deepEqual(interviewBody.detail, { interview_id: missingInterview })

    const missingApplication = randomUUID()
    const applicationBody = await readError(client, { application_id: missingApplication, as_of: AS_OF })
    assert.equal(applicationBody.code, 'NOT_FOUND')
    assert.equal(applicationBody.reason_code, 'APPLICATION_NOT_FOUND')
    assert.deepEqual(applicationBody.detail, { application_id: missingApplication })
  })
})

test('互斥参数被拒：两个 id 都给 / interview_id + round_no', async () => {
  await inRolledBackTx(pool, async (client) => {
    const both = await readError(client, {
      interview_id: randomUUID(), application_id: randomUUID(), as_of: AS_OF,
    })
    assert.equal(both.code, 'INVALID_ARGS')
    assert.equal(both.reason_code, 'MUTUALLY_EXCLUSIVE')

    const withRound = await readError(client, { interview_id: randomUUID(), round_no: 1, as_of: AS_OF })
    assert.equal(withRound.code, 'INVALID_ARGS')
    assert.equal(withRound.reason_code, 'MUTUALLY_EXCLUSIVE')
  })
})

// ---------------------------------------------------------------------------
// 6. TR-D 七条（至少序 2 / 序 6 / 序 7）
// ---------------------------------------------------------------------------

test('TR-D 序 2：canonical READY → READY/CANONICAL_STATUS', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 1,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    const meetingId = await bindMeeting(client, {
      interviewId, actualStartAt: '2026-11-10T10:02:00+08:00', actualEndAt: '2026-11-10T10:58:00+08:00',
    })
    const artifactId = await insertArtifact(client, {
      meetingId, status: 'READY', isCanonical: true, revision: 2,
    })

    const output = await read(client, { interview_id: interviewId, as_of: AS_OF })
    const interview = output.interviews[0] as LooseInterview
    assert.deepEqual(interview.transcript, {
      state: 'READY', reason_code: 'CANONICAL_STATUS', no_transcript: false,
    })
    assert.equal(interview.warnings.length, 0, 'canonical 存在时不该有 CANONICAL_MISSING')
    assert.ok(artifactId.length > 0)
    assertNoNull(output)

    // require_transcript=true 在 READY 时**不报错**（否则这个开关永远不可用）。
    const ok = await read(client, { interview_id: interviewId, as_of: AS_OF, require_transcript: true })
    assert.equal(ok.count, 1)
  })
})

test('TR-D 序 6：绑定会议但超过 scheduled_end + WAIT 仍无产物 → MISSING/NO_ARTIFACT_AFTER_WAIT', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 1,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    await bindMeeting(client, {
      interviewId, actualStartAt: '2026-11-10T10:00:00+08:00', actualEndAt: '2026-11-10T10:58:00+08:00',
    })

    // as_of 距会议结束已 2 天多 > WAIT(120min)
    const output = await read(client, { interview_id: interviewId, as_of: AS_OF })
    const interview = output.interviews[0] as LooseInterview
    assert.equal(interview.meeting_binding.state, 'BOUND_ACTIVE')
    assert.deepEqual(interview.transcript, {
      state: 'MISSING', reason_code: 'NO_ARTIFACT_AFTER_WAIT', no_transcript: true,
    })

    // 同一数据把 as_of 挪到会议结束刚过 30 分钟 → 还在 WAIT 内，只能是 PENDING/WAITING。
    const early = await read(client, { interview_id: interviewId, as_of: '2026-11-10T11:30:00+08:00' })
    assert.deepEqual((early.interviews[0] as LooseInterview).transcript, {
      state: 'PENDING', reason_code: 'WAITING', no_transcript: true,
    })
    assertNoNull(output)
  })
})

test('TR-D 序 7：绑定会议但结束时间还没到 → PENDING/WAITING', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 1,
      startAt: '2026-11-20T10:00:00+08:00',
      endAt: '2026-11-20T11:00:00+08:00',
    })
    await bindMeeting(client, { interviewId })

    const output = await read(client, { interview_id: interviewId, as_of: AS_OF })
    const interview = output.interviews[0] as LooseInterview
    assert.deepEqual(interview.transcript, {
      state: 'PENDING', reason_code: 'WAITING', no_transcript: true,
    })
    assert.equal(interview.is_overdue_start, false)
    assertNoNull(output)
  })
})

test('TR-D 序 3 + 警告：有 READY 无 canonical → READY/READY_NO_CANONICAL + CANONICAL_MISSING', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 1,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    const meetingId = await bindMeeting(client, { interviewId })
    await insertArtifact(client, { meetingId, status: 'READY', isCanonical: false })

    const output = await read(client, { interview_id: interviewId, as_of: AS_OF })
    const interview = output.interviews[0] as LooseInterview
    assert.deepEqual(interview.transcript, {
      state: 'READY', reason_code: 'READY_NO_CANONICAL', no_transcript: false,
    })
    assert.ok(interview.warnings.some((warning) => warning.code === 'CANONICAL_MISSING'))
    assert.equal(output.status, 'OK', '警告不改变 status')
    assertNoNull(output)
  })
})

test('evaluation 的 NO_REQUIRED_EVALUATOR + 面评缺 transcript_basis → 两个警告，status 仍 OK', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 1,
      startAt: '2026-11-20T10:00:00+08:00',
      endAt: '2026-11-20T11:00:00+08:00',
    })
    const interviewerId = await insertInterviewer(client, {
      interviewId, actorId: ACTOR_INTERVIEWER, requiredScorecard: false,
    })
    await insertScorecard(client, {
      interviewId, interviewerId, rubricId: app.rubricId, status: 'SUBMITTED',
      items: { overall: 'PASS' },
    })

    const output = await read(client, { interview_id: interviewId, as_of: AS_OF })
    const interview = output.interviews[0] as LooseInterview
    assert.equal(interview.evaluation.required_scorecards, 0)
    assert.equal(interview.evaluation.submitted, 1)
    assert.equal(interview.evaluation.pending, 0)
    assert.equal(interview.evaluation.evaluation_ready, false, 'required=0 时永远不是 ready')
    assert.deepEqual(interview.evaluation.blockers.map((blocker) => blocker.code), [
      'NO_REQUIRED_EVALUATOR', 'RECORD_NOT_READY',
    ])
    const codes = interview.warnings.map((warning) => warning.code)
    assert.ok(codes.includes('NO_REQUIRED_EVALUATOR'), `实际 ${codes.join(',')}`)
    assert.ok(codes.includes('MISSING_TRANSCRIPT_BASIS'), `实际 ${codes.join(',')}`)
    // transcript_basis 缺键 → "UNKNOWN"（不是 null，也不是省略）。
    assert.equal(interview.interviewers[0]?.scorecard?.transcript_basis, 'UNKNOWN')
    assert.equal(output.status, 'OK')
    assertNoNull(output)
  })
})

test('跨租户：真实存在的面试 id 在别的租户下一律 NOT_FOUND（不确认对方存在）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      roundNo: 1,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    // 另一个租户的行：organization 是种子里的同一行，用不存在的 tenant_id 构造配置即可
    // （这里只验证"同 id 不同租户 → NOT_FOUND"，所以直接改配置里的 tenant_id）。
    const foreignCfg = { ...cfg, tenant_id: '22222222-2222-4222-8222-000000000002' }
    let caught: unknown
    try {
      await getInTransaction(client, foreignCfg, { interview_id: interviewId, as_of: AS_OF }, NOW_MS)
    } catch (error) {
      caught = error
    }
    assert.notEqual(caught, undefined)
    const body = errorBody(caught)
    assert.equal(body.code, 'NOT_FOUND')
    assert.equal(body.reason_code, 'INTERVIEW_NOT_FOUND')
  })
})
