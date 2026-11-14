// §11.6 Golden Path 初步验收门槛（8 条）—— 可模拟的 6 条在这里跑；§11.6-1 / §11.6-7 在
// engine-gates.test.ts（事件与任务运行时）。§11.6-2 与 §9.12-6 有交叠，但断言口径不同：
// 这里守「不静默覆盖 / 不混 Application」，那里守「多岗位与撤回不误删历史」。
//
// 所有夹具都是合成数据（合成手机号段 / example.test 邮箱），没有真实简历内容（R7）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addInterview,
  addInterviewer,
  assertNoWrites,
  cfg,
  count,
  DEMO_JOB,
  expectToolError,
  HR_ACTOR,
  hex64,
  inRolledBackTx,
  one,
  pool,
  seedInterviewWithMeetings,
  seedScenario,
  tableCounts,
  TENANT,
  uniqueSuffix,
} from './harness.ts'
import type { DatabaseClient } from './harness.ts'
import {
  intakeInTransaction,
  type IntakeMaterial,
} from '../../src/tools/application-intake.ts'
import { observeIdentity } from '../../src/db/identity.ts'
import { evaluateInTransaction } from '../../src/tools/screening-evaluate.ts'
import { importTranscriptInTransaction } from '../../src/tools/transcript-import.ts'
import { readTranscriptInTransaction } from '../../src/tools/transcript-read.ts'
import { computeEvaluationSummaryIn } from '../../src/tools/evaluation-summarize.ts'
import { scheduleInTransaction } from '../../src/tools/interview-schedule.ts'
import { advanceApplicationStage } from '../../src/domain/stage-advance.ts'

test.after(async () => {
  await pool.end()
})

const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]
const SIZE_DIMENSIONS = [
  { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
  { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2, question: '是否独立做过前端页面？' },
]
const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
const INTERVIEWER_B = '11111111-1111-4111-8111-000000000102'
const INTERVIEWER_C = '11111111-1111-4111-8111-000000000101'

/** 一份合成材料（不读 PDF：身份只看 fields 的三态与来源）。 */
function material(input: {
  readonly sha: string
  readonly phone?: string
  readonly email?: string
  readonly text?: string
}): IntakeMaterial {
  const evidence = [{ page: 1, bbox: [72, 100, 520, 120], block: 1, text: '联系方式：见合成简历正文' }]
  const fields: Record<string, unknown> = {
    name: { state: 'present', value: '合成候选人', provenance: 'native_text', evidence },
    phone: input.phone === undefined
      ? { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] }
      : { state: 'present', value: input.phone, provenance: 'native_text', evidence },
    email: input.email === undefined
      ? { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] }
      : { state: 'present', value: input.email, provenance: 'native_text', evidence },
    work_experience: { state: 'present', provenance: 'native_text', evidence },
    education: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
  }
  const eligible = [...(input.phone === undefined ? [] : ['phone']), ...(input.email === undefined ? [] : ['email'])]
  const observation = observeIdentity(fields as never, eligible)
  const text = input.text ?? '合成简历正文（不是真实候选人材料）'
  return {
    real_path: 'C:/fake/acceptance.pdf',
    file_name: 'acceptance.pdf',
    byte_size: 1024,
    output: {
      text,
      chars: text.length,
      completeness: 'complete',
      issues: [],
      fields,
      timeline: { intervals: 1, closed_intervals: 1, open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 36 },
      screening: { eligible_fields: eligible, blocked_fields: [], identity_merge_eligible: eligible },
      meta: { pages: 1, source_sha256: input.sha, backend: 'pymupdf/1.0', reader_version: '1.0.0' },
    } as never,
    strong: observation.strong,
    blocked: observation.blocked,
    sha256: input.sha,
  }
}

/** 造第二岗位（有 job_version 指针，否则 intake 会拒绝）。 */
async function makeJob(client: DatabaseClient, label: string): Promise<string> {
  const suffix = uniqueSuffix()
  const jobId = await one(client, `insert into recruitment.job
      (tenant_id, department_id, code, title, status)
      values ($1, '11111111-1111-4111-8111-000000000010', $2, $3, 'OPEN') returning id`, [
    TENANT, `ACC-${suffix}`.slice(0, 40), label,
  ])
  const versionId = await one(client, `insert into recruitment.job_version
      (tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
      values ($1, $2, 1, '验收合成 JD', $3, $4) returning id`, [TENANT, jobId, hex64(`jv${suffix}`), HR_ACTOR])
  await client.query('update recruitment.job set current_job_version_id = $2 where id = $1', [jobId, versionId])
  return jobId
}

/** 一条合法面评 items（三个维度 + 保留键）。 */
function itemsFor(): Record<string, unknown> {
  return {
    transcript_basis: 'NO_TRANSCRIPT',
    backend_depth: { assessment: 'MET', score: 4, note: '合成观察记录', evidence: [] },
    async_pipeline: { assessment: 'NOT_MET', score: 2, note: '合成观察记录', evidence: [] },
    frontend_basics: { assessment: 'MET', score: 3, note: '合成观察记录', evidence: [] },
  }
}

/** 直接插一条 SUBMITTED 面评（夹具；工具端点不提供造夹具入口）。 */
async function addScorecard(
  client: DatabaseClient,
  interviewId: string,
  interviewerId: string,
  rubricVersionId: string,
  overall: string,
): Promise<void> {
  await client.query(
    `insert into recruitment.scorecard
       (tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
        submitted_at, items, overall, rationale, payload_hash)
     values ($1, $2, $3, $4, 1, 'SUBMITTED', now(), $5::jsonb, $6, 'REJECT_REASONS_JSON: []', $7)`,
    [TENANT, interviewId, interviewerId, rubricVersionId, JSON.stringify(itemsFor()), overall, hex64(`sc${uniqueSuffix()}`)],
  )
}

// =====================================================================
//  §11.6-2
// =====================================================================
test('§11.6-2 重复候选人资料不静默覆盖历史，也不把不同 Application 混在一起', async () => {
  await inRolledBackTx(pool, async (client) => {
    const phone = `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
    const m1 = material({ sha: hex64(`M1${uniqueSuffix()}`), phone })
    const jobB = await makeJob(client, '验收第二岗位')

    const first = await intakeInTransaction(client, cfg, m1, DEMO_JOB)
    assert.equal(first.application_action, 'CREATED')
    const v1Before = (await client.query<{ parsed_fields: unknown; evidence: unknown }>(
      'select parsed_fields, evidence from recruitment.resume_version where id = $1', [first.resume_version_id],
    )).rows[0]

    // ① 重复资料（不同字节 sha、同一强标识）→ 复用同一 ACTIVE 申请，不改旧版本字节。
    const m2 = material({ sha: hex64(`M2${uniqueSuffix()}`), phone })
    const second = await intakeInTransaction(client, cfg, m2, DEMO_JOB)
    assert.equal(second.application_action, 'REUSED', '同一 (candidate, job, ACTIVE) 必须复用申请')
    assert.equal(second.application_id, first.application_id)
    assert.equal(second.resume_version_action, 'APPENDED')
    assert.notEqual(second.resume_version_id, first.resume_version_id)
    const v1After = (await client.query<{ parsed_fields: unknown; evidence: unknown }>(
      'select parsed_fields, evidence from recruitment.resume_version where id = $1', [first.resume_version_id],
    )).rows[0]
    assert.equal(JSON.stringify(v1After), JSON.stringify(v1Before), '重复资料不得改写旧版本（历史不可变）')

    // ② 同一候选人的另一个岗位 → 独立 Application，绝不混在一起。
    const third = await intakeInTransaction(client, cfg, m1, jobB)
    assert.equal(third.application_action, 'CREATED')
    assert.equal(third.candidate_id, first.candidate_id, '同一个自然人')
    assert.notEqual(third.application_id, first.application_id, '不同岗位是独立申请')
    assert.equal(
      (await client.query<{ resume_version_id: string }>('select resume_version_id from recruitment.application where id = $1', [first.application_id])).rows[0]?.resume_version_id,
      second.resume_version_id,
      '岗位 A 的材料指针只受岗位 A 的投递影响',
    )
    assert.equal((await client.query<{ job_id: string }>('select job_id from recruitment.application where id = $1', [third.application_id])).rows[0]?.job_id, jobB)

    // ③ 不同人、同一份模板正文 → 不得按 content hash 合并。
    const other = await intakeInTransaction(client, cfg, material({
      sha: hex64(`M3${uniqueSuffix()}`),
      phone: `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      text: '合成简历正文（不是真实候选人材料）',
    }), DEMO_JOB)
    assert.notEqual(other.candidate_id, first.candidate_id, '不同强标识 = 不同人，不得按正文合并')

    assert.deepEqual(
      await Promise.all([
        count(client, `select count(*)::int as n from recruitment.application where tenant_id = $1 and candidate_id = $2 and job_id = $3 and lifecycle_status = 'ACTIVE'`, [TENANT, first.candidate_id, DEMO_JOB]),
        count(client, `select count(*)::int as n from recruitment.application where tenant_id = $1 and candidate_id = $2 and job_id = $3 and lifecycle_status = 'ACTIVE'`, [TENANT, first.candidate_id, jobB]),
      ]),
      [1, 1],
      '每个 (candidate, job) 只能有一条 ACTIVE',
    )
    assert.equal(await count(client, 'select count(*)::int as n from recruitment.candidate_merge where tenant_id = $1', [TENANT]), 0)
  })
})

// =====================================================================
//  §11.6-3
// =====================================================================
test('§11.6-3 初筛每条关键结论可回到原始证据；没有证据时明确标为缺失/待核实', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [
        { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
        { key: 'edu_exists', label: '有教育经历', kind: 'MUST_HAVE', weight: 0.5, field: 'education', operator: 'EXISTS', value: true },
      ],
    })
    const value = await evaluateInTransaction(client, cfg, { application_id: scenario.applicationId }, Date.now()) as {
      verdict: string
      reasons: { kind: string; code: string; tri_state: string; evidence: { source_asset_sha256: string; quote?: string }[]; absence?: unknown }[]
      resume_version: { source_asset_sha256: string }
    }
    assert.equal(value.verdict, 'NEEDS_REVIEW', '有缺失项时不得给 PASS/FAIL 冒充结论')
    const satisfied = value.reasons.find(reason => reason.code === 'MUST_HAVE_SATISFIED')
    assert.ok(satisfied !== undefined, '有证据的结论必须给出 MUST_HAVE_SATISFIED')
    assert.ok((satisfied.evidence.length ?? 0) >= 1, '每条肯定结论必须有 ≥1 条原文证据')
    assert.equal(satisfied.evidence[0]?.source_asset_sha256, value.resume_version.source_asset_sha256, '证据必须指回同一版材料')

    const missing = value.reasons.find(reason => reason.kind === 'MUST_HAVE' && reason.tri_state === 'absent')
    assert.ok(missing !== undefined, '无证据的维度必须显式标 absent（未知/待核实）')
    assert.equal(missing.evidence.length, 0, '没证据就不许编造证据')
    assert.ok(missing.absence !== undefined, '缺失项必须带 absence 说明（为什么未知）')
  })
})

// =====================================================================
//  §11.6-4
// =====================================================================
test('§11.6-4 转写完整获取；片段状态齐全；部分处理不得伪装成完整成功', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const { interviewId } = await seedInterviewWithMeetings(client, scenario.applicationId)
    const content = [
      '00:00 面试官：请用两分钟介绍你最近做过的项目。',
      '00:12 候选人：我做过一个合成订单链路，把超时率从 3% 降到 0.2%。',
      '00:30 面试官：具体用了什么手段？',
    ].join('\n')
    const imported = await importTranscriptInTransaction(client, cfg, {
      interview_id: interviewId,
      content,
      source_kind: 'DEMO_SAMPLE',
    }, Date.now()) as { artifact: { id: string; is_complete: boolean; has_more: boolean; segment_count: number } }

    // 原文完整性：一次性带全内容（is_complete=true / has_more=false / 片段数 = 非空行数）。
    assert.equal(imported.artifact.is_complete, true, '完整获取才允许标 READY')
    assert.equal(imported.artifact.has_more, false, '不得留 has_more 的分页尾巴')
    assert.equal(imported.artifact.segment_count, 3)
    assert.equal(
      await count(client, 'select count(*)::int as n from recruitment.transcript_segment where tenant_id = $1 and artifact_id = $2', [TENANT, imported.artifact.id]),
      3,
      '每个片段都要落一行（不是只存一段文本）',
    )

    const value = await readTranscriptInTransaction(client, cfg, {
      interview_id: interviewId,
      include_segments: true,
    }, Date.now()) as {
      transcript: {
        state: string
        reason_code: string
        text: { content: string; has_more: boolean; total_chars: number }
        segments: { sequence: number; content_text: string }[]
        segment_page: { total: number; has_more: boolean }
        record?: { status: string }
      }
      warnings: { code: string }[]
    }
    assert.equal(value.transcript.state, 'READY', '原文齐了才是 READY')
    assert.equal(value.transcript.reason_code, 'CANONICAL_STATUS')
    assert.equal(value.transcript.text.content, content, '正文逐字节保留，不摘要不重排')
    assert.equal(value.transcript.text.has_more, false)
    assert.equal(value.transcript.text.total_chars, content.length)
    assert.deepEqual(value.transcript.segments.map(segment => segment.sequence), [0, 1, 2], '每条片段都有处理状态/序号')
    assert.equal(value.transcript.segment_page.total, 3)
    assert.equal(value.transcript.segment_page.has_more, false)

    // 两条状态轴不许混：transcript READY ≠ interview_record 完成。
    assert.equal(value.transcript.record?.status, 'NEEDS_REVIEW', '结构化记录未完成时不许说 READY')
    assert.ok(value.warnings.some(warning => warning.code === 'RECORD_NOT_READY'), '必须显式警告记录未就绪')
  })
})

// =====================================================================
//  §11.6-5
// =====================================================================
test('§11.6-5 两位面试官评价独立；一人未提交时系统正确等待，不伪造完成', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: SIZE_DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId)
    const first = await addInterviewer(client, interviewId, INTERVIEWER_A, true)
    const second = await addInterviewer(client, interviewId, INTERVIEWER_B, true)
    await addScorecard(client, interviewId, first, scenario.rubricId, 'ADVANCE')

    const value = await computeEvaluationSummaryIn(client, cfg, {
      application_id: scenario.applicationId,
      as_of: new Date().toISOString(),
      decision_scope: 'STAGE',
      interview_id: interviewId,
    }, Date.now()) as {
      coverage: { required_total: number; submitted: number; missing: number }
      tally: { advance: number; hold: number; reject: number }
      missing: { interviewer_id: string }[]
      aggregation: { average: number | null; average_refused_reason?: string }
      ready_for_decision: boolean
      required_human_action: string
      permitted_results: string[]
      blockers: { code: string }[]
    }
    assert.deepEqual(value.coverage, { required_total: 2, submitted: 1, waived: 0, missing: 1, unusable: 0, not_required: 0, overdue: 0, completion_ratio: 0.5 })
    assert.deepEqual(value.tally, { advance: 1, hold: 0, reject: 0, waived: 0 }, '只统计真实提交的那一份，不得补造第二份')
    assert.equal(value.missing[0]?.interviewer_id, second)
    assert.equal(value.ready_for_decision, false, '缺一份面评时不得允许完成决策')
    assert.equal(value.required_human_action, 'CHASE_SCORECARD')
    assert.equal(value.aggregation.average, null, '缺人时不得算"平均分"冒充完整')
    assert.equal(value.aggregation.average_refused_reason, 'MISSING_SCORES')
    assert.ok(value.blockers.some(blocker => blocker.code === 'SCORECARD_MISSING'))
    assert.ok(value.permitted_results.includes('HOLD') && value.permitted_results.includes('WITHDRAW'), '流程可继续（HOLD/WITHDRAW），不因缺一份面评卡死')
    assert.equal(
      await count(client, 'select count(*)::int as n from recruitment.scorecard where tenant_id = $1 and interview_id = $2', [TENANT, interviewId]),
      1,
      '不得伪造第二份面评',
    )
  })
})

// =====================================================================
//  §11.6-6
// =====================================================================
test('§11.6-6 未经授权不能执行有业务影响的外部动作（排期/对外通知）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const before = await tableCounts(client)
    const start = new Date(Date.now() + 3 * 24 * 3600_000).toISOString()
    const args = {
      intent: 'CREATE',
      idempotency_key: `acc-${uniqueSuffix()}`,
      application_id: scenario.applicationId,
      round_no: 1,
      interviewers: [{ actor_id: INTERVIEWER_A }],
      scheduled_start_at: start,
      duration_minutes: 60,
      meeting: { provider: 'FEISHU', external_meeting_id: `acc-meeting-${uniqueSuffix()}`, meeting_role: 'PRIMARY' },
    }
    // 没有任何审批 → 必须 fail closed；行数不得变化（不许"先写后补授权"）。
    await expectToolError(
      scheduleInTransaction(client, cfg, args, Date.now()),
      'FORBIDDEN',
      'APPROVAL_UNAVAILABLE',
    )
    assertNoWrites(before, await tableCounts(client), '无授权')
    // 明确拒绝同样不写。
    await expectToolError(
      scheduleInTransaction(client, cfg, { ...args, idempotency_key: `acc-${uniqueSuffix()}` }, Date.now(), async () => 'rejected'),
      'FORBIDDEN',
      'APPROVAL_NOT_GRANTED',
    )
    assertNoWrites(before, await tableCounts(client), '审批被拒')
  })
})

// =====================================================================
//  §11.6-8
// =====================================================================
test('§11.6-8 HR 能从工作台理解状态、阻塞原因、责任人和下一步', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 申请没钉 rubric：阶段推进必须给出**可执行**的阻塞说明，而不是静默不动。
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS, pinRubric: false })
    await client.query("update recruitment.application set current_stage_code = 'S6' where id = $1", [scenario.applicationId])
    const before = (await client.query<{ current_stage_code: string; record_version: number }>(
      'select current_stage_code, record_version from recruitment.application where id = $1', [scenario.applicationId],
    )).rows[0]!
    const value = await advanceApplicationStage(client, { tenantId: TENANT, applicationId: scenario.applicationId }) as {
      status: string
      stage_code: string
      record_version: number
      blockers: { code: string; message: string }[]
      warnings: unknown[]
    }
    assert.equal(value.status, 'BLOCKED')
    assert.equal(value.stage_code, before.current_stage_code, '被阻塞时阶段不得偷偷变化')
    assert.equal(value.record_version, before.record_version, '被阻塞时不得写库')
    const blocker = value.blockers.find(item => item.code === 'RUBRIC_NOT_PINNED')
    assert.ok(blocker !== undefined, '必须告诉 HR 具体缺什么（RUBRIC_NOT_PINNED）')
    assert.ok(blocker.message.length > 0, '阻塞原因不能为空')
    assert.match(blocker.message, /rubric|评分标准/i, '阻塞原因必须指向具体对象，而不是泛泛而谈')

    // 门槛要求的另外两要素：责任人 + 下一步。下一步目前只以自由文本出现；
    // 责任人没有任何结构化字段 —— 这一条按门槛原文必须红（不是放宽断言）。
    assert.ok(
      Object.hasOwn(blocker as object, 'owner_actor_id') || Object.hasOwn(blocker as object, 'responsible_actor_id'),
      '§11.6-8 要求 HR 能看到"责任人"：blockers 只有 code/message，没有 owner/responsible 字段，工作台无法机检责任人',
    )
  })
})
