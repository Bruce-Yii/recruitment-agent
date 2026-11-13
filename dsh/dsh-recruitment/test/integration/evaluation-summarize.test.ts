// `computeEvaluationSummaryIn` 的集成矩阵（**连真库** ra_s6s7，每个用例结束 ROLLBACK）。
//
// 覆盖任务书要求的机检面：
//   * P1：3 人 2 交 1 缺 → coverage={3,2,0,1} / ready=false / permitted=[A,H,W] /
//     average=null(MISSING_SCORES)；同时断言 M-1 / M-2 / M-3；
//   * P4：2 通过 1 不通过 → MAJORITY_ADVANCE + minority_reports 原文 + MINORITY_DISSENT；
//   * 全豁免（submitted=0 / waived=3 / missing=0）→ NO_SUBMITTED_SCORECARD、
//     permitted 至少含 HOLD/WITHDRAW；
//   * 形状不合法的面评被剔除 → unusable + SCORECARD_SHAPE_INVALID + SCORECARD_UNUSABLE；
//   * require_complete=true 且有缺失 → SCORECARD_MISSING(REQUIRED_SCORECARDS_INCOMPLETE)；
//   * FINAL 跨面试并集；observer(required_scorecard=false) 只进 not_required；
//   * 只读性（调用前后 record_version / 行数不变）；同参两次逐字节相同；
//   * brief（DC-41..46）+ ALREADY_DECIDED；rationale 不可解析 → INVALID_ARGS。
import test from 'node:test'
import assert from 'node:assert/strict'

import type { DatabaseClient } from '../../src/db/pool.ts'
import { canonicalJson } from '../../src/tools/contract.ts'
import { computeEvaluationSummaryIn } from '../../src/tools/evaluation-summarize.ts'
import {
  createTestPool,
  errorBody,
  hex64,
  HR_ACTOR,
  inRolledBackTx,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

const A1 = '11111111-1111-4111-8111-000000000101'
const A2 = '11111111-1111-4111-8111-000000000102'
const A3 = '11111111-1111-4111-8111-000000000103'
const A4 = '11111111-1111-4111-8111-000000000104'
const AS_OF = '2026-11-13T01:00:00+08:00'
const DUE_PAST = '2026-11-12T12:00:00+08:00'

const DIMENSIONS = [
  { key: 'backend_depth', kind: 'MUST_HAVE', label: '后端工程深度', weight: 0.5 },
  { key: 'async_pipeline', kind: 'MUST_HAVE', label: '异步/队列流水线经验', weight: 0.3 },
  {
    key: 'frontend_basics',
    kind: 'NICE_TO_HAVE',
    label: '基本前端能力',
    weight: 0.2,
    question: '是否独立做过前端页面？',
  },
]
const DIMENSION_KEYS = DIMENSIONS.map((dimension) => dimension.key)
const NO_REASONS = 'REJECT_REASONS_JSON: []'

/** 造一场面试。 */
async function addInterview(
  client: DatabaseClient,
  applicationId: string,
  roundNo: number,
  slotCode = 'DEFAULT',
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at)
     values ($1, $2, $3, $4, 'POST_INTERVIEW', now())
     returning id`,
    [TENANT, applicationId, roundNo, slotCode],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('interview insert returned no row')
  return row.id
}

/** 登记一位面试官（required=false 即 observer/旁听）。 */
async function addInterviewer(
  client: DatabaseClient,
  interviewId: string,
  actorId: string,
  required: boolean,
  dueAt: Date | null = null,
  role = required ? 'INTERVIEWER' : 'OBSERVER',
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.interviewer
       (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard, scorecard_due_at)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [TENANT, interviewId, actorId, role, required, dueAt],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('interviewer insert returned no row')
  return row.id
}

/** 契约形状的 items（三维度 + transcript_basis）。 */
function itemsFor(assessments: Record<string, string> = {}): Record<string, unknown> {
  const items: Record<string, unknown> = { transcript_basis: 'NO_TRANSCRIPT' }
  for (const key of DIMENSION_KEYS) {
    const assessment = assessments[key] ?? 'MET'
    if (assessment === 'NOT_OBSERVED' || assessment === 'UNREADABLE') {
      items[key] = { assessment, evidence: [] }
      continue
    }
    items[key] = {
      assessment,
      score: assessment === 'NOT_MET' ? 1 : 4,
      note: `${key} 的现场观察记录`,
      evidence: [],
    }
  }
  return items
}

/** 固定编码的 rationale（DESIGN §3.5②）。 */
function rationaleFor(reasons: readonly unknown[]): string {
  return `REJECT_REASONS_JSON: ${canonicalJson(reasons)}`
}

/** 直接插一条面评（工具端点不提供造夹具入口，测试故意写库）。 */
async function addScorecard(
  client: DatabaseClient,
  input: {
    readonly interviewId: string
    readonly interviewerId: string
    readonly rubricVersionId: string
    readonly status?: 'SUBMITTED' | 'WAIVED'
    readonly overall?: string | null
    readonly items?: unknown
    readonly rationale?: string | null
    readonly waiveReason?: string | null
  },
): Promise<string> {
  const status = input.status ?? 'SUBMITTED'
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.scorecard
       (tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
        submitted_at, waive_reason, items, overall, rationale, payload_hash)
     values ($1, $2, $3, $4, 1, $5, $6, $7, $8::jsonb, $9, $10, $11)
     returning id`,
    [
      TENANT,
      input.interviewId,
      input.interviewerId,
      input.rubricVersionId,
      status,
      status === 'SUBMITTED' ? new Date() : null,
      input.waiveReason ?? null,
      input.items === undefined ? null : JSON.stringify(input.items),
      input.overall ?? null,
      input.rationale ?? null,
      hex64(`scorecard:${uniqueSuffix()}`),
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('scorecard insert returned no row')
  return row.id
}

/** 调一次汇总（事务由调用方提供）。 */
function summarize(
  client: DatabaseClient,
  applicationId: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return computeEvaluationSummaryIn(
    client,
    cfg,
    { application_id: applicationId, as_of: AS_OF, ...extra },
    Date.now(),
  )
}

/** 断言一次调用抛契约错误并返回错误体。 */
async function rejection(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  if (thrown === undefined) throw new Error('expected a contract error')
  return errorBody(thrown)
}

// ---- 共用断言（TC §7.0 的 M-1 / M-2 / M-3）----

function assertM1(value: Record<string, unknown>): void {
  const coverage = value.coverage as Record<string, number>
  const aggregation = value.aggregation as Record<string, unknown>
  const shouldHaveAverage = coverage.missing === 0 && coverage.submitted >= 1
  assert.equal(aggregation.average !== null, shouldHaveAverage, 'M-1: average 的 ⇔')
  if (shouldHaveAverage) {
    assert.equal(Object.hasOwn(aggregation, 'average_refused_reason'), false, 'M-1: 有 average 时不得给 refused')
  } else {
    const reason = aggregation.average_refused_reason
    assert.ok(reason === 'MISSING_SCORES' || reason === 'NO_SUBMITTED_SCORECARD', 'M-1: refused 二值')
    if (coverage.missing > 0) assert.equal(reason, 'MISSING_SCORES', 'M-1: missing>0')
    else assert.equal(reason, 'NO_SUBMITTED_SCORECARD', 'M-1: missing=0 且 submitted=0')
  }
}

function assertM2(value: Record<string, unknown>): void {
  const coverage = value.coverage as Record<string, number>
  const tally = value.tally as Record<string, number>
  assert.equal(tally.advance + tally.hold + tally.reject, coverage.submitted, 'M-2: a+h+r=submitted')
  assert.equal(tally.waived, coverage.waived, 'M-2: waived')
}

function assertM3(value: Record<string, unknown>): void {
  const coverage = value.coverage as Record<string, number>
  assert.equal(
    coverage.submitted + coverage.waived + coverage.missing,
    coverage.required_total,
    'M-3: 三个桶',
  )
  assert.ok(coverage.unusable <= coverage.missing, 'M-3: unusable ⊆ missing')
  const aggregation = value.aggregation as Record<string, unknown>
  for (const dimension of aggregation.per_dimension as Record<string, number>[]) {
    assert.equal(
      dimension.denominator + dimension.excluded,
      coverage.required_total,
      'M-3: denominator + excluded',
    )
  }
}

function blockerCodes(value: Record<string, unknown>): string[] {
  return (value.blockers as Record<string, unknown>[]).map((blocker) => blocker.code as string)
}

// =====================================================================
//  P1 + M-1/M-2/M-3
// =====================================================================
test('P1：3 人 2 交 1 缺 → coverage 3/2/0/1、average=null(MISSING_SCORES)、permitted=[A,H,W]', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const first = await addInterviewer(client, interviewId, A1, true)
    const second = await addInterviewer(client, interviewId, A2, true)
    const third = await addInterviewer(client, interviewId, A4, true, new Date(DUE_PAST))
    await addScorecard(client, {
      interviewId, interviewerId: first, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })
    await addScorecard(client, {
      interviewId, interviewerId: second, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })

    const value = await summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    })

    assert.equal(value.advisory, true)
    assert.equal(value.read_only, true)
    assert.equal(value.as_of, AS_OF)
    assert.equal(value.stage_code, 'S10')
    assert.equal(value.decision_scope, 'STAGE')

    const coverage = value.coverage as Record<string, number>
    assert.deepEqual(coverage, {
      required_total: 3, submitted: 2, waived: 0, missing: 1,
      unusable: 0, not_required: 0, overdue: 1, completion_ratio: 0.6667,
    })
    const tally = value.tally as Record<string, number>
    assert.deepEqual(tally, { advance: 2, hold: 0, reject: 0, waived: 0 })
    assert.equal(value.consensus, 'UNANIMOUS_ADVANCE')
    assert.equal(value.consensus_scope, 'PARTIAL_PANEL')

    const missing = value.missing as Record<string, unknown>[]
    assert.equal(missing.length, 1)
    assert.equal(missing[0]?.interviewer_id, third)
    assert.equal(missing[0]?.actor_id, A4)
    assert.equal(missing[0]?.round_no, 1)
    assert.equal(missing[0]?.slot_code, 'DEFAULT')
    assert.equal(missing[0]?.overdue, true)
    assert.equal(missing[0]?.scorecard_due_at, new Date(DUE_PAST).toISOString())
    assert.equal(Object.hasOwn(missing[0] as object, 'in_progress'), false)
    assert.equal(Object.hasOwn(missing[0] as object, 'status'), false)

    const aggregation = value.aggregation as Record<string, unknown>
    assert.equal(aggregation.method, 'PER_DIMENSION_SUBMITTED_ONLY')
    assert.equal(aggregation.average, null)
    assert.equal(aggregation.average_refused_reason, 'MISSING_SCORES')
    for (const dimension of aggregation.per_dimension as Record<string, unknown>[]) {
      assert.equal(dimension.denominator, 2)
      assert.equal(dimension.excluded, 1)
    }

    assert.equal(value.ready_for_decision, false)
    assert.deepEqual(blockerCodes(value), ['SCORECARD_MISSING'])
    const blocker = (value.blockers as Record<string, unknown>[])[0]
    assert.equal(blocker?.family, 'COVERAGE')
    assert.deepEqual(blocker?.blocks_results, ['REJECT', 'HIRED'])
    assert.equal(blocker?.blocks_all, false)
    assert.deepEqual(value.permitted_results, ['ADVANCE', 'HOLD', 'WITHDRAW'])
    assert.equal(value.required_human_action, 'CHASE_SCORECARD')

    // 不能出现"综合得分/建议结论"。
    assert.equal(Object.hasOwn(value, 'overall_score'), false)
    assert.equal(Object.hasOwn(value, 'recommended_result'), false)
    assert.equal(Object.hasOwn(value, 'score'), false)

    assertM1(value)
    assertM2(value)
    assertM3(value)
  })
})

// =====================================================================
//  P4：少数派原文
// =====================================================================
test('P4：2 通过 1 不通过 → MAJORITY_ADVANCE + minority_reports 原文 + MINORITY_DISSENT', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const first = await addInterviewer(client, interviewId, A1, true)
    const second = await addInterviewer(client, interviewId, A2, true)
    const third = await addInterviewer(client, interviewId, A4, true)

    const rejectReasons = [{
      dimension_key: 'backend_depth',
      observation: '追问两次容量估算仍回答“加机器就行”',
      why_decisive: '该维度是 MUST_HAVE，且已给两次澄清机会',
      evidence: [],
      evidence_state: 'MEMORY_ONLY',
    }]
    await addScorecard(client, {
      interviewId, interviewerId: first, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })
    await addScorecard(client, {
      interviewId, interviewerId: second, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })
    const rejecting = await addScorecard(client, {
      interviewId, interviewerId: third, rubricVersionId: scenario.rubricId,
      overall: 'REJECT',
      items: itemsFor({ backend_depth: 'NOT_MET' }),
      rationale: rationaleFor(rejectReasons),
    })

    const value = await summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    })

    const coverage = value.coverage as Record<string, number>
    assert.deepEqual(coverage, {
      required_total: 3, submitted: 3, waived: 0, missing: 0,
      unusable: 0, not_required: 0, overdue: 0, completion_ratio: 1,
    })
    assert.deepEqual(value.tally, { advance: 2, hold: 0, reject: 1, waived: 0 })
    assert.equal(value.consensus, 'MAJORITY_ADVANCE')
    assert.equal(value.consensus_scope, 'FULL_PANEL')

    const minority = value.minority_reports as Record<string, unknown>[]
    assert.equal(minority.length, 1)
    assert.equal(minority[0]?.scorecard_id, rejecting)
    assert.equal(minority[0]?.interviewer_id, third)
    assert.equal(minority[0]?.overall, 'REJECT')
    assert.equal(minority[0]?.transcript_basis, 'NO_TRANSCRIPT')
    assert.deepEqual(minority[0]?.reject_reasons, rejectReasons, 'DC-03：原文带出，不得摘要')
    assert.match(String(minority[0]?.rationale), /REJECT_REASONS_JSON: /)

    const warningCodes = (value.warnings as Record<string, unknown>[]).map((warning) => warning.code)
    assert.ok(warningCodes.includes('MINORITY_DISSENT'))
    assert.equal(value.ready_for_decision, true)
    assert.deepEqual(value.permitted_results, ['ADVANCE', 'HOLD', 'WITHDRAW', 'REJECT'])
    assert.equal(value.required_human_action, 'CONFIRM_DECISION')
    assert.equal(blockerCodes(value).length, 0)

    assertM1(value)
    assertM2(value)
    assertM3(value)
  })
})

// =====================================================================
//  全豁免
// =====================================================================
test('全豁免：submitted=0 / waived=3 / missing=0 → NO_SUBMITTED_SCORECARD，HOLD/WITHDRAW 仍允许', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const interviewers: string[] = []
    for (const actor of [A1, A2, A4]) {
      interviewers.push(await addInterviewer(client, interviewId, actor, true))
    }
    for (const interviewerId of interviewers) {
      await addScorecard(client, {
        interviewId, interviewerId, rubricVersionId: scenario.rubricId,
        status: 'WAIVED', overall: null, items: undefined, rationale: null,
        waiveReason: '原面试官被临时替换',
      })
    }

    const value = await summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    })

    const coverage = value.coverage as Record<string, number>
    assert.deepEqual(coverage, {
      required_total: 3, submitted: 0, waived: 3, missing: 0,
      unusable: 0, not_required: 0, overdue: 0, completion_ratio: 1,
    })
    assert.deepEqual(value.tally, { advance: 0, hold: 0, reject: 0, waived: 3 })
    assert.equal(value.consensus, 'NO_SUBMISSIONS')
    assert.equal(value.consensus_scope, 'FULL_PANEL')
    assert.equal(value.ready_for_decision, false)
    assert.ok(blockerCodes(value).includes('NO_SUBMITTED_SCORECARD'))
    assert.equal(blockerCodes(value).includes('SCORECARD_MISSING'), false, '全豁免不得报缺面评')

    const aggregation = value.aggregation as Record<string, unknown>
    assert.equal(aggregation.method, 'NOT_COMPUTED')
    assert.equal(aggregation.average, null)
    assert.equal(aggregation.average_refused_reason, 'NO_SUBMITTED_SCORECARD')

    const permitted = value.permitted_results as string[]
    assert.ok(permitted.includes('HOLD'))
    assert.ok(permitted.includes('WITHDRAW'))
    assert.equal(permitted.includes('ADVANCE'), false)
    assert.equal(permitted.includes('REJECT'), false)
    assert.equal(value.required_human_action, 'RESOLVE_BLOCKER')

    const waivedWarning = (value.warnings as Record<string, unknown>[])
      .find((warning) => warning.code === 'SCORECARD_WAIVED')
    assert.ok(waivedWarning !== undefined)
    const waivers = (waivedWarning?.detail as Record<string, unknown>).waivers as Record<string, unknown>[]
    assert.equal(waivers.length, 3)
    assert.equal(waivers[0]?.waive_reason, '原面试官被临时替换')

    assertM1(value)
    assertM2(value)
    assertM3(value)
  })
})

// =====================================================================
//  形状不合法 → 剔除
// =====================================================================
test('形状不合法：items 是数组 → unusable=1、SCORECARD_SHAPE_INVALID、SCORECARD_UNUSABLE', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const first = await addInterviewer(client, interviewId, A1, true)
    const broken = await addInterviewer(client, interviewId, A2, true)
    await addScorecard(client, {
      interviewId, interviewerId: first, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })
    const brokenScorecard = await addScorecard(client, {
      interviewId, interviewerId: broken, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: [], rationale: NO_REASONS,
    })

    const value = await summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    })

    const coverage = value.coverage as Record<string, number>
    assert.equal(coverage.required_total, 2)
    assert.equal(coverage.submitted, 1)
    assert.equal(coverage.missing, 1)
    assert.equal(coverage.unusable, 1)
    assert.ok(coverage.unusable <= coverage.missing)
    assert.deepEqual(value.tally, { advance: 1, hold: 0, reject: 0, waived: 0 })

    const invalidWarning = (value.warnings as Record<string, unknown>[])
      .find((warning) => warning.code === 'SCORECARD_SHAPE_INVALID')
    assert.ok(invalidWarning !== undefined)
    const detail = invalidWarning?.detail as Record<string, unknown>
    const entries = detail.scorecards as Record<string, unknown>[]
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.scorecard_id, brokenScorecard)
    assert.ok((entries[0]?.violations as string[]).includes('ITEMS_NOT_OBJECT'))

    const codes = blockerCodes(value)
    assert.ok(codes.includes('SCORECARD_UNUSABLE'))
    assert.ok(codes.includes('SCORECARD_MISSING'))
    assert.equal(codes.includes('NO_SUBMITTED_SCORECARD'), false)
    assert.deepEqual(value.permitted_results, ['ADVANCE', 'HOLD', 'WITHDRAW'])
    assert.equal(value.required_human_action, 'RESOLVE_UNREADABLE')

    const aggregation = value.aggregation as Record<string, unknown>
    for (const dimension of aggregation.per_dimension as Record<string, unknown>[]) {
      assert.equal(dimension.denominator, 1)
      assert.equal(dimension.excluded, 1)
    }

    assertM1(value)
    assertM2(value)
    assertM3(value)
  })
})

// =====================================================================
//  require_complete
// =====================================================================
test('require_complete=true 且有缺失 → SCORECARD_MISSING(REQUIRED_SCORECARDS_INCOMPLETE)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const first = await addInterviewer(client, interviewId, A1, true)
    await addInterviewer(client, interviewId, A2, true)
    await addScorecard(client, {
      interviewId, interviewerId: first, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })

    const body = await rejection(summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId, require_complete: true,
    }))
    assert.equal(body.code, 'SCORECARD_MISSING')
    assert.equal(body.reason_code, 'REQUIRED_SCORECARDS_INCOMPLETE')
    assert.deepEqual(body.detail, { missing_count: 1 })
  })
})

// =====================================================================
//  FINAL 跨面试并集
// =====================================================================
test('FINAL：跨两场面试取 required_interviewers 并集（required=4 / submitted=2 / missing=2）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const round1 = await addInterview(client, scenario.applicationId, 1)
    const round2 = await addInterview(client, scenario.applicationId, 2)
    const first = await addInterviewer(client, round1, A1, true)
    await addInterviewer(client, round1, A2, true)
    const third = await addInterviewer(client, round2, A3, true)
    await addInterviewer(client, round2, A4, true)
    await addScorecard(client, {
      interviewId: round1, interviewerId: first, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })
    await addScorecard(client, {
      interviewId: round2, interviewerId: third, rubricVersionId: scenario.rubricId,
      overall: 'HOLD', items: itemsFor({ async_pipeline: 'NOT_OBSERVED' }), rationale: NO_REASONS,
    })

    const value = await summarize(client, scenario.applicationId, { decision_scope: 'FINAL' })
    assert.equal(Object.hasOwn(value, 'interview_id'), false, 'FINAL 不回显 interview_id')

    const coverage = value.coverage as Record<string, number>
    assert.deepEqual(coverage, {
      required_total: 4, submitted: 2, waived: 0, missing: 2,
      unusable: 0, not_required: 0, overdue: 0, completion_ratio: 0.5,
    })
    assert.deepEqual(value.tally, { advance: 1, hold: 1, reject: 0, waived: 0 })
    assert.equal(value.consensus, 'SPLIT')
    assert.equal(value.consensus_scope, 'PARTIAL_PANEL')

    const missing = value.missing as Record<string, unknown>[]
    assert.deepEqual(missing.map((entry) => entry.round_no).sort(), [1, 2])
    assert.equal(value.ready_for_decision, false)
    assert.deepEqual(value.permitted_results, ['HOLD', 'WITHDRAW'])
    assert.ok(blockerCodes(value).includes('SCORECARD_MISSING'))
    assert.equal(value.required_human_action, 'CHASE_SCORECARD')

    assertM1(value)
    assertM2(value)
    assertM3(value)
  })
})

// =====================================================================
//  observer
// =====================================================================
test('observer(required_scorecard=false)：只进 not_required，不进 tally / 分母', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const required = await addInterviewer(client, interviewId, A1, true)
    const observer = await addInterviewer(client, interviewId, A4, false)
    await addScorecard(client, {
      interviewId, interviewerId: required, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })
    await addScorecard(client, {
      interviewId, interviewerId: observer, rubricVersionId: scenario.rubricId,
      overall: 'REJECT',
      items: itemsFor({ backend_depth: 'NOT_MET' }),
      rationale: rationaleFor([{ dimension_key: 'backend_depth' }]),
    })

    const value = await summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    })

    const coverage = value.coverage as Record<string, number>
    assert.equal(coverage.required_total, 1)
    assert.equal(coverage.submitted, 1)
    assert.equal(coverage.not_required, 1)
    assert.deepEqual(value.tally, { advance: 1, hold: 0, reject: 0, waived: 0 })
    assert.equal((value.minority_reports as unknown[]).length, 0)
    for (const dimension of (value.aggregation as Record<string, unknown>)
      .per_dimension as Record<string, unknown>[]) {
      assert.equal(dimension.denominator, 1)
      assert.equal(dimension.excluded, 0)
    }
    assertM1(value)
    assertM2(value)
    assertM3(value)
  })
})

// =====================================================================
//  只读性
// =====================================================================
test('只读性：调用前后 application/interview record_version、scorecard/decision/business_task 行数不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const first = await addInterviewer(client, interviewId, A1, true)
    await addInterviewer(client, interviewId, A2, true)
    await addScorecard(client, {
      interviewId, interviewerId: first, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })

    const snapshot = async (): Promise<Record<string, unknown>> => {
      const app = (await client.query<Record<string, unknown>>(
        `select record_version, current_stage_code, lifecycle_status
           from recruitment.application where id = $1`, [scenario.applicationId],
      )).rows[0]
      const interview = (await client.query<Record<string, unknown>>(
        `select id, record_version, status from recruitment.interview
          where id = $1`, [interviewId],
      )).rows[0]
      const scorecards = (await client.query<{ n: number }>(
        `select count(*)::int as n from recruitment.scorecard
          where tenant_id = $1 and interview_id = $2`, [TENANT, interviewId],
      )).rows[0]?.n
      const decisions = (await client.query<{ n: number }>(
        `select count(*)::int as n from recruitment.decision
          where tenant_id = $1 and application_id = $2`, [TENANT, scenario.applicationId],
      )).rows[0]?.n
      const tasks = (await client.query<{ n: number }>(
        `select count(*)::int as n from recruitment.business_task where tenant_id = $1`, [TENANT],
      )).rows[0]?.n
      return { app, interview, scorecards, decisions, tasks }
    }

    const before = await snapshot()
    await summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    })
    const after = await snapshot()
    assert.deepEqual(after, before)
  })
})

// =====================================================================
//  确定性
// =====================================================================
test('同参两次：JSON 逐字节相同（含 summary_digest），as_of 原样回显', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const first = await addInterviewer(client, interviewId, A1, true)
    const second = await addInterviewer(client, interviewId, A2, true)
    await addScorecard(client, {
      interviewId, interviewerId: first, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })
    await addScorecard(client, {
      interviewId, interviewerId: second, rubricVersionId: scenario.rubricId,
      overall: 'HOLD', items: itemsFor({ backend_depth: 'UNREADABLE' }), rationale: NO_REASONS,
    })

    const a = await summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    })
    const b = await summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    })
    assert.equal(JSON.stringify(a), JSON.stringify(b))
    assert.equal(a.summary_digest, b.summary_digest)
    assert.match(String(a.summary_digest), /^[0-9a-f]{64}$/)
    assert.equal(a.as_of, AS_OF)
  })
})

// =====================================================================
//  brief / ALREADY_DECIDED
// =====================================================================
test('已存在 current ADVANCE 决策：ALREADY_DECIDED + brief 派生（next_round/derived_from/digest）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const first = await addInterviewer(client, interviewId, A1, true)
    await addScorecard(client, {
      interviewId, interviewerId: first, rubricVersionId: scenario.rubricId,
      overall: 'ADVANCE', items: itemsFor(), rationale: NO_REASONS,
    })
    const decision = await client.query<{ id: string }>(
      `insert into recruitment.decision
         (tenant_id, application_id, interview_id, decision_scope, stage_code, result,
          decided_by_actor_id, decided_at, reason, basis_refs)
       values ($1, $2, $3, 'STAGE', 'S10', 'ADVANCE', $4, now(), $5, '[]'::jsonb)
       returning id`,
      [TENANT, scenario.applicationId, interviewId, HR_ACTOR, '人工确认进入下一轮'],
    )
    const decisionId = decision.rows[0]?.id
    assert.ok(decisionId !== undefined)

    const value = await summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    })
    const codes = blockerCodes(value)
    assert.equal(codes[0], 'ALREADY_DECIDED')
    assert.ok(codes.includes('ALREADY_DECIDED'))
    assert.deepEqual(value.permitted_results, [])
    assert.equal(value.ready_for_decision, false)
    assert.equal(value.required_human_action, 'SUPERSEDE_EXISTING_DECISION')

    const brief = value.brief as Record<string, unknown>
    assert.ok(brief !== null)
    assert.equal(Object.hasOwn(value, 'brief_absence'), false)
    assert.deepEqual(brief.next_round, { round_no: 2 })
    const derived = brief.derived_from as Record<string, unknown>
    assert.equal(derived.decision_id, decisionId)
    assert.equal(derived.summary_digest, value.summary_digest)
    assert.equal(derived.rubric_version_id, scenario.rubricId)
    assert.deepEqual(derived.interview_ids, [interviewId])
    assert.match(String(brief.brief_digest), /^[0-9a-f]{64}$/)
  })
})

// =====================================================================
//  rationale 不可解析 → 契约错误（不是悄悄剔除）
// =====================================================================
test('REJECT 面评的 rationale 没有编码行 → INVALID_ARGS(RATIONALE_NOT_PARSABLE)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const interviewId = await addInterview(client, scenario.applicationId, 1)
    const first = await addInterviewer(client, interviewId, A1, true)
    await addScorecard(client, {
      interviewId, interviewerId: first, rubricVersionId: scenario.rubricId,
      overall: 'REJECT',
      items: itemsFor({ backend_depth: 'NOT_MET' }),
      rationale: '当时觉得不行（没有固定编码行）',
    })

    const body = await rejection(summarize(client, scenario.applicationId, {
      decision_scope: 'STAGE', interview_id: interviewId,
    }))
    assert.equal(body.code, 'INVALID_ARGS')
    assert.equal(body.reason_code, 'RATIONALE_NOT_PARSABLE')
  })
})
