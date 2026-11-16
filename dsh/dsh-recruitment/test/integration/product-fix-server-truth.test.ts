// O3 / O12 / O14 的真库集成测试（**共用 `ra_fix_srv`，每个用例结束 ROLLBACK**；不写 ra_s6s7）。
//
// 覆盖：
//   * O3  伪造凭据（全零 actor / 全零 hash）→ 工具层 INVALID_ARGS/PLACEHOLDER_CONFIRMATION（HTTP 映射 400），
//         且 `decision` / `event_inbox` 行数不变（零写入）；
//   * O12 `recruitment_application_get` 的 rubric remediation 按 approval 真值生成：
//         申请钉住的 v1 未批准 + 岗位当前 v2 已批准 → 不得建议"去审批 v2"，要说明"钉住版本未批准、
//         没有重绑入口、按钉住版本继续"；
//   * O14 同一申请上 `application_get.evaluations` 的跨轮合计与 `interview_get` 各场之和**逐字相等**
//         （两处 import 同一个派生函数 `scorecard-progress.ts`）。
//
// 纪律：夹具全部直接 INSERT（工具只提供业务入口，不提供造夹具入口）；断言只依赖本文件事务内的行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { readApplicationValue } from '../../src/tools/business-read.ts'
import { deriveRubricRemediation } from '../../src/tools/business-read.ts'
import { createDecisionRecordTool } from '../../src/tools/decision-record.ts'
import { digestOf } from '../../src/tools/contract.ts'
import { getInTransaction } from '../../src/tools/interview-get.ts'
import {
  TENANT,
  createTestPool,
  criterion,
  errorBody,
  hex64,
  inRolledBackTx,
  parsedFields,
  seedScenario,
  testDatabaseConfig,
  type Scenario,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

/** 两条真实形状的 rubric 维度（与 0002_seed 同形；本文件只读它们，不重算规则）。 */
const DIMENSIONS = [
  {
    key: 'work_exists',
    kind: 'MUST_HAVE',
    field: 'work_experience',
    label: '有工作经历',
    value: true,
    weight: 0.5,
    operator: 'EXISTS',
  },
  {
    key: 'edu_exists',
    kind: 'MUST_HAVE',
    field: 'education',
    label: '有教育经历',
    value: true,
    weight: 0.5,
    operator: 'EXISTS',
  },
]

/** `decision` / `event_inbox` 两个表的行数（零写入断言用；事务内可见自己的夹具）。 */
async function counts(client: Parameters<typeof seedScenario>[0]): Promise<{ decision: number; event_inbox: number }> {
  const decisionRows = await client.query<{ n: string }>(
    'select count(*)::text as n from recruitment.decision where tenant_id = $1',
    [TENANT],
  )
  const eventRows = await client.query<{ n: string }>(
    'select count(*)::text as n from recruitment.event_inbox where tenant_id = $1',
    [TENANT],
  )
  return {
    decision: Number(decisionRows.rows[0]?.n ?? '0'),
    event_inbox: Number(eventRows.rows[0]?.n ?? '0'),
  }
}

/** STEP 0 全合法、只把 human_confirmation 换成占位值的 SCREENING 入参。 */
function placeholderArgs(confirmation: Record<string, unknown>): Record<string, unknown> {
  const recent = new Date(Date.now() - 60_000).toISOString()
  return {
    application_id: '11111111-1111-4111-8111-000000000701',
    decision_scope: 'SCREENING',
    as_of: recent,
    result: 'HOLD',
    reason: '占位凭据负例（集成测试）',
    basis_refs: [{ kind: 'AUTHORITY', actor_id: '11111111-1111-4111-8111-000000000103', is_hiring_manager: false }],
    human_confirmation: {
      confirmed_at: recent,
      confirmation_method: 'IN_APP_CONFIRM',
      confirmation_text_sha256: 'a'.repeat(64),
      ...confirmation,
    },
  }
}

// ---------------------------------------------------------------------------
//  O3：占位凭据 → 拒绝且零写入（工具层 = 真实 execute 路径）
// ---------------------------------------------------------------------------

test('O3：全零 confirmed_by_actor_id → INVALID_ARGS/PLACEHOLDER_CONFIRMATION，decision/event_inbox 行数不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const before = await counts(client)
    const tool = createDecisionRecordTool({
      database: cfg,
      approval: { request: async () => 'rejected' },
    })
    await assert.rejects(
      () => tool.execute(
        placeholderArgs({ confirmed_by_actor_id: '00000000-0000-0000-0000-000000000000' }),
        {},
      ),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS', 'HTTP 层把 INVALID_ARGS 映射成 400（4xx）')
        assert.equal(body.reason_code, 'PLACEHOLDER_CONFIRMATION')
        assert.match(String(body.message), /确认人必须是真实身份，不能用占位值/)
        return true
      },
    )
    assert.deepEqual(await counts(client), before, '被拒绝的伪造凭据不得写任何行')
  })
})

test('O3：全零 confirmation_text_sha256 → INVALID_ARGS/PLACEHOLDER_CONFIRMATION，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const before = await counts(client)
    const tool = createDecisionRecordTool({
      database: cfg,
      approval: { request: async () => 'rejected' },
    })
    await assert.rejects(
      () => tool.execute(
        placeholderArgs({
          confirmed_by_actor_id: '11111111-1111-4111-8111-000000000103',
          confirmation_text_sha256: '0'.repeat(64),
        }),
        {},
      ),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'PLACEHOLDER_CONFIRMATION')
        assert.match(String(body.message), /占位值/)
        return true
      },
    )
    assert.deepEqual(await counts(client), before, '被拒绝的伪造 hash 不得写任何行')
  })
})

// ---------------------------------------------------------------------------
//  O12：remediation 按 approval 真值（真库场景：钉住 v1 未批准 + 岗位 v2 已批准）
// ---------------------------------------------------------------------------

/** 在给定 job 上再插一个 rubric v2 并批准它，把 job.current_rubric_version_id 指过去。 */
async function seedApprovedSecondRubric(
  client: Parameters<typeof seedScenario>[0],
  scenario: Scenario,
): Promise<{ rubricId: string; versionNo: number }> {
  const dimensions = [criterion(DIMENSIONS[0]!)]
  const payloadHash = digestOf(dimensions)
  const inserted = await client.query<{ id: string }>(
    `insert into recruitment.rubric_version
       (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
     values ($1, $2, 2, $3::jsonb, $4, $5)
     returning id`,
    [TENANT, scenario.jobId, JSON.stringify(dimensions), payloadHash, '11111111-1111-4111-8111-000000000103'],
  )
  const rubricId = inserted.rows[0]?.id
  assert.ok(rubricId !== undefined, 'rubric v2 insert 必须返回行')
  await client.query(
    `insert into recruitment.approval
       (tenant_id, resource_type, resource_id, resource_record_version, payload_schema_version,
        canonical_payload_hash, status, requested_by_actor_id, decision_by_actor_id, decided_at, reason)
     values ($1, 'RUBRIC_VERSION', $2, 1, 1, $3, 'APPROVED', $4, $4, now(), 'O12 夹具：v2 已批准')`,
    [TENANT, rubricId, payloadHash, '11111111-1111-4111-8111-000000000103'],
  )
  await client.query(
    'update recruitment.job set current_rubric_version_id = $2, record_version = record_version + 1 where id = $1',
    [scenario.jobId, rubricId],
  )
  return { rubricId, versionNo: 2 }
}

test('O12：钉住 v1 未批准 + 岗位 v2 已批准 → 输出不含"审批 v2"，建议按钉住版本继续', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: DIMENSIONS.map(criterion),
      fields: parsedFields(),
      approve: false,
      pinRubric: true,
      bindMaterial: true,
    })
    const v2 = await seedApprovedSecondRubric(client, scenario)
    const value = await readApplicationValue(client, cfg, { application_id: scenario.applicationId })
    const application = value.applications[0]
    assert.ok(application !== undefined)

    // 真值：申请钉的是 v1（未批准），岗位当前是 v2（已批准）。
    assert.equal(application.rubric?.rubric_version_id, scenario.rubricId)
    assert.equal(application.rubric?.approved, false)
    assert.equal(application.rubric_remediation.code, 'PINNED_VERSION_NOT_APPROVED')
    assert.equal(application.rubric_remediation.pinned_approved, false)
    assert.equal(application.rubric_remediation.job_current_rubric_version_id, v2.rubricId)
    assert.equal(application.rubric_remediation.job_current_approved, true)
    const text = JSON.stringify(application.rubric_remediation)
    assert.doesNotMatch(text, /审批\s*v2/, '已批准的 v2 不得出现在"去审批"建议里（O12 的病根）')
    assert.match(application.rubric_remediation.message, /钉住版本 v1 未批准/)
    assert.match(application.rubric_remediation.message, /按钉住版本继续/)
  })
})

test('O12：钉住版本已批准 → CONTINUE_WITH_PINNED（真库路径）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: DIMENSIONS.map(criterion),
      fields: parsedFields(),
      approve: true,
      pinRubric: true,
      bindMaterial: true,
    })
    const value = await readApplicationValue(client, cfg, { application_id: scenario.applicationId })
    const remediation = value.applications[0]?.rubric_remediation
    assert.equal(remediation?.code, 'CONTINUE_WITH_PINNED')
    assert.equal(remediation?.pinned_approved, true)
    assert.match(String(remediation?.message), /按钉住版本继续/)
  })
})

// ---------------------------------------------------------------------------
//  O14：application_get 与 interview_get 同一口径（跨轮 required/submitted 汇总）
// ---------------------------------------------------------------------------

/** 一条面试官 + 当前面评（status = PENDING/SUBMITTED/WAIVED；SUBMITTED/WAIVED 需要审计列）。 */
async function insertInterviewerAndScorecard(
  client: Parameters<typeof seedScenario>[0],
  input: {
    readonly applicationId: string
    readonly interviewId: string
    readonly actorId: string
    readonly rubricId: string
    readonly jobId: string
    readonly required: boolean
    readonly status: 'PENDING' | 'SUBMITTED' | 'WAIVED'
  },
): Promise<void> {
  const interviewer = await client.query<{ id: string }>(
    `insert into recruitment.interviewer
       (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard)
     values ($1, $2, $3, 'INTERVIEWER', $4)
     returning id`,
    [TENANT, input.interviewId, input.actorId, input.required],
  )
  const interviewerId = interviewer.rows[0]?.id
  assert.ok(interviewerId !== undefined, 'interviewer insert 必须返回行')
  if (input.status === 'PENDING') return
  const isSubmitted = input.status === 'SUBMITTED'
  await client.query(
    `insert into recruitment.scorecard
       (tenant_id, interview_id, interviewer_id, rubric_version_id, job_id, revision_no, status,
        submitted_at, waive_reason, items, overall, payload_hash, status_changed_by_actor_id)
     values ($1, $2, $3, $4, $5, 1, $6,
             case when $7 then now() else null end,
             case when $7 then null else '集成测试：豁免' end,
             case when $7 then $8::jsonb else null end,
             case when $7 then 'HOLD' else null end,
             case when $7 then $9 else null end,
             $10)`,
    [
      TENANT, input.interviewId, interviewerId, input.rubricId, input.jobId,
      input.status, isSubmitted,
      JSON.stringify({ transcript_basis: 'NO_TRANSCRIPT' }),
      hex64(`o14:${interviewerId}`),
      '11111111-1111-4111-8111-000000000103',
    ],
  )
}

/** 造一场面试（R1 POST_INTERVIEW / R2 SCHEDULED；stage_code 必须在目录内）。 */
async function insertInterview(
  client: Parameters<typeof seedScenario>[0],
  input: { readonly applicationId: string; readonly roundNo: number; readonly status: string; readonly stageCode: string },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, stage_code, status,
        scheduled_start_at, scheduled_end_at)
     values ($1, $2, $3, 'DEFAULT', $4, $5, now() - interval '2 hours', now() - interval '1 hour')
     returning id`,
    [TENANT, input.applicationId, input.roundNo, input.stageCode, input.status],
  )
  const id = inserted.rows[0]?.id
  assert.ok(id !== undefined, 'interview insert 必须返回行')
  return id
}

test('O14：同一申请上 application_get 的合计 == interview_get 各场之和（required/submitted）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: DIMENSIONS.map(criterion),
      fields: parsedFields(),
      approve: true,
      pinRubric: true,
      bindMaterial: true,
    })
    // 三个测试面试官（自建，不依赖 demo seed 的 actor）。
    const actors = [randomUUID(), randomUUID(), randomUUID()]
    for (const actorId of actors) {
      await client.query(
        `insert into recruitment.actor (id, tenant_id, kind, display_name)
         values ($1, $2, 'HUMAN', $3)`,
        [actorId, TENANT, `O14 面试官 ${actorId.slice(0, 8)}`],
      )
    }
    // R1（已面完，1 个 required 面试官，已提交 1 份）
    const r1 = await insertInterview(client, {
      applicationId: scenario.applicationId, roundNo: 1, status: 'POST_INTERVIEW', stageCode: 'S9',
    })
    await insertInterviewerAndScorecard(client, {
      applicationId: scenario.applicationId, interviewId: r1, actorId: actors[0]!,
      rubricId: scenario.rubricId, jobId: scenario.jobId, required: true, status: 'SUBMITTED',
    })
    // R2（已排期，2 个 required 面试官：一个 WAIVED，一个 PENDING）
    const r2 = await insertInterview(client, {
      applicationId: scenario.applicationId, roundNo: 2, status: 'SCHEDULED', stageCode: 'S8',
    })
    await insertInterviewerAndScorecard(client, {
      applicationId: scenario.applicationId, interviewId: r2, actorId: actors[1]!,
      rubricId: scenario.rubricId, jobId: scenario.jobId, required: true, status: 'WAIVED',
    })
    await insertInterviewerAndScorecard(client, {
      applicationId: scenario.applicationId, interviewId: r2, actorId: actors[2]!,
      rubricId: scenario.rubricId, jobId: scenario.jobId, required: true, status: 'PENDING',
    })

    const applicationValue = await readApplicationValue(client, cfg, { application_id: scenario.applicationId })
    const application = applicationValue.applications[0]
    assert.ok(application !== undefined)
    const evaluations = application.evaluations
    // 真值：跨轮 required = 1 + 2 = 3；已提交 1；豁免 1；还差 1。
    assert.equal(evaluations.scorecards_required_total, 3)
    assert.equal(evaluations.scorecards_submitted_total, 1)
    assert.equal(evaluations.scorecards_waived_total, 1)
    assert.equal(evaluations.scorecards_pending_total, 1)
    // 旧键保留且数值与跨轮合计一致（O14：不再是"面评行数 0/0"）。
    assert.equal(evaluations.scorecard_count, evaluations.scorecards_required_total)
    assert.equal(evaluations.submitted_count, evaluations.scorecards_submitted_total)

    const interviewValue = await getInTransaction(client, cfg, { application_id: scenario.applicationId }, Date.now())
    const interviews = interviewValue.interviews as Array<Record<string, unknown>>
    assert.equal(interviews.length, 2)
    let required = 0
    let submitted = 0
    let waived = 0
    let pending = 0
    for (const interview of interviews) {
      const evaluation = interview.evaluation as Record<string, number>
      required += evaluation.required_scorecards ?? 0
      submitted += evaluation.submitted ?? 0
      waived += evaluation.waived ?? 0
      pending += evaluation.pending ?? 0
    }
    // O14 的判据：两个工具在同一申请上必须相等（同一份派生函数）。
    assert.equal(evaluations.scorecards_required_total, required, 'application_get 与 interview_get 的 required 合计必须相等')
    assert.equal(evaluations.scorecards_submitted_total, submitted, 'submitted 合计必须相等')
    assert.equal(evaluations.scorecards_waived_total, waived)
    assert.equal(evaluations.scorecards_pending_total, pending)
    assert.equal(required, 3)
    assert.equal(submitted, 1)
  })
})

// 纯函数再兜一层：没有 DB 也能证明"已批准版本不进审批建议"（remediation 的稳定口径）。
test('O12（纯函数）：已批准版本不进入 remediation 的"去审批"文本', () => {
  const advice = deriveRubricRemediation({
    pinned: { id: 'pinned-v1', version_no: 1, approved: false },
    current: { id: 'current-v2', version_no: 2, approved: true },
  })
  assert.equal(advice.code, 'PINNED_VERSION_NOT_APPROVED')
  assert.doesNotMatch(advice.message, /审批\s*v2/)
})
