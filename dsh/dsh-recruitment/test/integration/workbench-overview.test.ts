// 工作台投影（actor 视角）+ D-89 面评表单校验的**真库**集成测试。
//
// 纪律（`test/integration/db.ts` 的三条 + 本轮任务书）：
//   1. 每个用例都在自己的事务里跑并一律 ROLLBACK —— 不污染 `ra_s6s7`；
//   2. 连不上库就**失败**（不静默 skip，R3 要求 `skipped === 0`）；
//   3. 断言只针对本用例造出来的夹具 id（共享库里还有别的 lane/演示脚本的行，
//      「全表 count」会假红；这一点与 `evaluation-scorecard-submit.test.ts` 同一口径）；
//   4. 不调 HTTP handler 的写路径（它自建连接池、会真提交），负例只断言
//      「校验在写之前就拒绝」+ 「scorecard 行数不变」。
//
// 夹具（任务书要求的形状）：
//   · demo 部门（`0002_seed.sql` 的 DEMO_DEPARTMENT，hiring_manager = actor 102）
//   · APP1：current_stage_code='S10'、无当前有效 decision → 102 的 owned 待决策
//   · APP2：保持 'S7'、无 decision → **不属于任何个人** → unassigned 待决策
//   · 面试 IV1（APP1，interviewer=104，无面评，scheduled_start_at 已过 → 逾期）
//   · 面试 IV2（APP2，interviewer=103）
//   · review_queue 3 条：assignee=103 / assignee=102 / assignee=null(QUEUED)
//   · conversion_run FAILED 1 条（连接器异常；review_queue 的 FK 另造 3 条 ACCEPTED run）
//   · business_task WAITING_HUMAN 4 条：created_by=103 / ref INTERVIEW(IV1) / ref APPLICATION(APP1) / 无主
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseScorecardFormSubmission,
  readWorkbenchProjection,
  validateDimensionKeys,
  type OverviewResponse,
} from '../../src/http/overview.ts'
import { prepareScorecard } from '../../src/tools/scorecard-submit.ts'
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

/** `0002_seed.sql` 的演示身份：102 = 部门用人经理，103 = HR 专员，104 = 面试官。 */
const ACTOR_102 = '11111111-1111-4111-8111-000000000102'
const ACTOR_103 = '11111111-1111-4111-8111-000000000103'
const ACTOR_104 = '11111111-1111-4111-8111-000000000104'
/** 演示角色 id（`0002_seed.sql` §3）：HIRING_MANAGER / 管理员（授权人）。 */
const ROLE_HIRING_MANAGER = '11111111-1111-4111-8111-000000000202'
const ACTOR_ADMIN = '11111111-1111-4111-8111-000000000101'

/** 与演示 rubric v1 同形的三个维度（`0002_seed.sql` §5）。 */
const DIMENSIONS = [
  { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
  { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
] as const

/** 夹具 id 集合（断言只针对这些 id）。 */
interface Fixture {
  readonly app1: string
  readonly app2: string
  readonly iv1: string
  readonly iv2: string
  readonly taskCreatedBy103: string
  readonly taskRefInterview: string
  readonly taskRefApplication: string
  readonly taskUnassigned: string
  readonly review103: string
  readonly review102: string
  readonly reviewUnclaimed: string
  readonly failedRun: string
}

async function setActor(client: DatabaseClient, actorId: string): Promise<void> {
  await client.query("select set_config('recruitment.actor_id', $1, true)", [actorId])
}

/** 造一场面试（默认 POST_INTERVIEW + 排期在 2 天前 —— 过期 → 逾期面评）。 */
async function addInterview(
  client: DatabaseClient,
  applicationId: string,
  options: { status?: string; roundNo?: number; slotCode?: string; daysAgo?: number } = {},
): Promise<string> {
  return one(
    client,
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at)
     values ($1, $2, $3, $4, $5, now() - ($6::int * interval '1 day')) returning id`,
    [
      TENANT,
      applicationId,
      options.roundNo ?? 1,
      options.slotCode ?? 'DEFAULT',
      options.status ?? 'POST_INTERVIEW',
      options.daysAgo ?? 2,
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

/**
 * 造一条 conversion_run（review_queue 的复合外键必需）。
 *
 * 默认 `QUARANTINED`：`fn_review_queue_before_insert` 明确拒收 ACCEPTED run（“抽查/复核不属于兜底”），
 * 而 QUARANTINED 不产生连接器异常（本用例只把 FAILED 当作异常源）。
 */
async function addConversionRun(
  client: DatabaseClient,
  options: { status?: 'QUARANTINED' | 'FAILED' | 'CRASHED'; completeness?: 'complete' | 'partial' | 'unverified' } = {},
): Promise<string> {
  const status = options.status ?? 'QUARANTINED'
  const completeness = options.completeness ?? 'partial'
  // ACCEPTED / QUARANTINED 必须有 result_json（ck_conversion_run_result_present）。
  const resultJson = status === 'FAILED' || status === 'CRASHED' ? 'null' : "'{}'::jsonb"
  return one(
    client,
    `insert into recruitment.conversion_run
       (tenant_id, source_sha256, source_name, converter_version, status, completeness,
        issue_codes, pages, blocks, elapsed_ms, started_at, finished_at, result_json)
     values ($1, $2, 'fixture.pdf', 'test-converter 1.0', $3, $4, '{}'::text[], 1, 1, 10,
             now() - interval '3 days', now() - interval '3 days' + interval '1 second',
             ${resultJson})
     returning id`,
    [TENANT, hex64(`conv${uniqueSuffix()}`), status, completeness],
  )
}

async function addReviewItem(
  client: DatabaseClient,
  runId: string,
  options: { assignee?: string | null; status?: string } = {},
): Promise<string> {
  const assignee = options.assignee ?? null
  return one(
    client,
    `insert into recruitment.review_queue (tenant_id, run_id, status, assignee, machine_result)
     values ($1, $2, $3, $4, '{}'::jsonb) returning id`,
    [TENANT, runId, options.status ?? 'QUEUED', assignee],
  )
}

async function addWaitingTask(
  client: DatabaseClient,
  options: { createdBy?: string | null; refs?: readonly { kind: string; id: string }[]; title: string },
): Promise<string> {
  return one(
    client,
    `insert into recruitment.business_task
       (tenant_id, task_type, business_refs, title, idempotency_key, status, created_by_actor_id, due_at)
     values ($1, 'HUMAN_REVIEW', $2::jsonb, $3, $4, 'WAITING_HUMAN', $5, now() + interval '1 day')
     returning id`,
    [
      TENANT,
      JSON.stringify(options.refs ?? []),
      options.title,
      `test:workbench:${uniqueSuffix()}`,
      options.createdBy ?? null,
    ],
  )
}

/**
 * V6-2：造一条终态失败任务（business_task.status='FAILED' + 最后一次 attempt='FAILED_FINAL'）。
 *
 * @param options.endedAtOffset - 失败时间相对 now() 的分钟偏移（负数=更早），用来验证倒序。
 * @param options.errorClass - 最后一次 attempt 的 error_class（决定是否需要人处理）。
 * @param options.errorCode - 最后一次 attempt 的 error_code（决定人话文案）。
 */
async function addFailedTask(
  client: DatabaseClient,
  options: {
    createdBy?: string | null
    refs?: readonly { kind: string; id: string }[]
    title: string
    errorClass: string
    errorCode: string
    endedAtOffsetMinutes?: number
    /** 可选：更早的 FAILED_RETRYABLE attempt（验证「只认最后一次 attempt」）。 */
    withRetry?: boolean
  },
): Promise<string> {
  const taskId = await one(
    client,
    `insert into recruitment.business_task
       (tenant_id, task_type, business_refs, title, idempotency_key, status, created_by_actor_id,
        error_code, error_summary, completed_at, status_changed_at)
     values ($1, 'HUMAN_REVIEW', $2::jsonb, $3, $4, 'FAILED', $5, $6, $7,
             now() + ($8::int * interval '1 minute'), now() + ($8::int * interval '1 minute'))
     returning id`,
    [
      TENANT,
      JSON.stringify(options.refs ?? []),
      options.title,
      `test:workbench:v62:${uniqueSuffix()}`,
      options.createdBy ?? null,
      options.errorCode,
      `fixture error ${options.errorCode}`,
      options.endedAtOffsetMinutes ?? 0,
    ],
  )
  const endedAt = `now() + (${options.endedAtOffsetMinutes ?? 0} * interval '1 minute')`
  if (options.withRetry === true) {
    // 更早的一次 attempt：可重试失败（TRANSIENT），不该被当成最终判定。
    // claimed_at 显式给更早的时间，满足 ck_task_attempt_started/ended（ended_at >= claimed_at）。
    await client.query(
      `insert into recruitment.task_attempt
         (tenant_id, task_id, attempt_no, worker_type, worker_id, status, claimed_at, lease_expires_at,
          ended_at, error_class, error_code, retry_after)
       values ($1, $2, 1, 'DSH_JOB', 'w-retry', 'FAILED_RETRYABLE', now() - interval '3 hours',
               now() - interval '2 hours', now() - interval '2 hours', 'TRANSIENT', 'TEMP', now() + interval '1 hour')`,
      [TENANT, taskId],
    )
  }
  // 最后一次 attempt：claimed_at 设为 ended_at 前 1 分钟，lease_expires_at 必须 > claimed_at。
  await client.query(
    `insert into recruitment.task_attempt
       (tenant_id, task_id, attempt_no, worker_type, worker_id, status, claimed_at, lease_expires_at,
        ended_at, error_class, error_code)
     values ($1, $2, ${options.withRetry === true ? 2 : 1}, 'DSH_JOB', 'w-final', 'FAILED_FINAL',
             ${endedAt} - interval '1 minute', ${endedAt} + interval '1 minute', ${endedAt}, $3, $4)`,
    [TENANT, taskId, options.errorClass, options.errorCode],
  )
  return taskId
}

/**
 * 一次性造齐夹具（在调用方事务里；结束时随事务回滚）。
 * @param client - 回滚事务内的连接。
 * @returns 夹具 id 集合。
 */
async function seedFixture(client: DatabaseClient): Promise<Fixture> {
  // APP1：demo 部门下（hiring_manager=102），推到 S10 且无 decision → owned 待决策。
  const scenario1 = await seedScenario(client, { dimensions: [...DIMENSIONS] })
  await client.query(
    "update recruitment.application set current_stage_code = 'S10' where id = $1 and tenant_id = $2",
    [scenario1.applicationId, TENANT],
  )
  // APP2：保持 S7（seed 默认），无 decision → unassigned 待决策（S7 闸门不属于任何个人）。
  const scenario2 = await seedScenario(client, { dimensions: [...DIMENSIONS] })

  const iv1 = await addInterview(client, scenario1.applicationId, { daysAgo: 2 })
  await addInterviewer(client, iv1, ACTOR_104)
  const iv2 = await addInterview(client, scenario2.applicationId, { daysAgo: 1 })
  await addInterviewer(client, iv2, ACTOR_103)

  // review_queue 3 条（每条指向一条自己的 QUARANTINED run，避开 uq_review_queue_run；
  // 触发器只允许新条目 status='QUEUED'，所以 assignee 的差别体现在 assignee 列上）。
  const review103 = await addReviewItem(client, await addConversionRun(client), { assignee: ACTOR_103 })
  const review102 = await addReviewItem(client, await addConversionRun(client), { assignee: ACTOR_102 })
  const reviewUnclaimed = await addReviewItem(client, await addConversionRun(client), { assignee: null })

  // 连接器异常：1 条 FAILED 的 conversion_run（恒 shared）。
  const failedRun = await addConversionRun(client, { status: 'FAILED', completeness: 'partial' })

  // WAITING_HUMAN 任务 4 条：三源归属 + 无主。
  const taskCreatedBy103 = await addWaitingTask(client, { createdBy: ACTOR_103, title: '103 创建的任务' })
  const taskRefInterview = await addWaitingTask(client, {
    createdBy: null,
    refs: [{ kind: 'INTERVIEW', id: iv1 }],
    title: '指向 IV1 的任务（面试官 104）',
  })
  const taskRefApplication = await addWaitingTask(client, {
    createdBy: null,
    refs: [{ kind: 'APPLICATION', id: scenario1.applicationId }],
    title: '指向 APP1 的任务（用人经理 102）',
  })
  const taskUnassigned = await addWaitingTask(client, { createdBy: null, refs: [], title: '完全无主任务' })

  return {
    app1: scenario1.applicationId,
    app2: scenario2.applicationId,
    iv1,
    iv2,
    taskCreatedBy103,
    taskRefInterview,
    taskRefApplication,
    taskUnassigned,
    review103,
    review102,
    reviewUnclaimed,
    failedRun,
  }
}

/** 断言某个列表里含/不含某个 id（字段名由调用方给）。 */
function hasId(rows: readonly Record<string, unknown>[], field: string, id: string): boolean {
  return rows.some((row) => row[field] === id)
}

function idsOf(rows: readonly Record<string, unknown>[], field: string): string[] {
  return rows.map((row) => String(row[field]))
}

/** 当前角色列表（`actor_role` 标签，不参与归属）。 */
function roles(response: OverviewResponse): string[] {
  return [...(response.actor?.roles ?? [])]
}

// =====================================================================
//  1. actor 103（HR 专员）：只看得到「自己的」；unassigned 与其它 actor 完全相同
// =====================================================================

test('actor 103：owned 待决策为空、我的面试是 IV2 不是 IV1、复核项是 assignee=103、任务含 created_by=103', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const p103 = await readWorkbenchProjection(client, CFG, ACTOR_103)

    assert.equal(p103.configured, true)
    assert.equal(p103.contract_version, 'workbench-overview 1.0.0')
    assert.equal(p103.actor?.actor_id, ACTOR_103)
    assert.ok(typeof p103.evaluated_at === 'string' && p103.evaluated_at.length > 0)
    assert.deepEqual(p103.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
    // `actor_role` 是标签：103 是 HR_SPECIALIST，但归属完全按列。
    assert.ok(roles(p103).includes('HR_SPECIALIST'), `103 的 roles 应含 HR_SPECIALIST，实际 ${roles(p103).join(',')}`)

    // owned 待决策：103 不是任何部门的用人经理（demo 部门 = 102）→ 一条都没有。
    assert.equal(hasId(p103.lists.pending_decisions, 'application_id', fixture.app1), false, 'S10 待决策属于 102，不属于 103')
    assert.deepEqual(p103.pending, p103.lists.pending_decisions, '向后兼容：pending 与 lists.pending_decisions 同内容')
    assert.equal(p103.counts.pending_total, p103.lists.pending_decisions.length)

    // 我的面试：IV2（interviewer=103），不含 IV1（interviewer=104）。
    assert.equal(hasId(p103.lists.my_interviews, 'interview_id', fixture.iv2), true)
    assert.equal(hasId(p103.lists.my_interviews, 'interview_id', fixture.iv1), false)

    // 复核项：assignee=103。
    assert.equal(hasId(p103.lists.pending_reviews, 'item_id', fixture.review103), true)
    assert.equal(hasId(p103.lists.pending_reviews, 'item_id', fixture.review102), false)
    assert.equal(hasId(p103.lists.pending_reviews, 'item_id', fixture.reviewUnclaimed), false, '未认领的不算我的')

    // 任务：created_by=103（OWNER）；ref 派生的不归 103。
    assert.equal(hasId(p103.lists.waiting_human_tasks, 'task_id', fixture.taskCreatedBy103), true)
    const ownedTask = p103.lists.waiting_human_tasks.find((row) => row.task_id === fixture.taskCreatedBy103)
    assert.equal(ownedTask?.relation, 'OWNER')
    assert.equal(ownedTask?.required_action, 'PROVIDE_DECISION')
    assert.equal(hasId(p103.lists.waiting_human_tasks, 'task_id', fixture.taskRefInterview), false)
    assert.equal(hasId(p103.lists.waiting_human_tasks, 'task_id', fixture.taskRefApplication), false)

    // 连接器异常：恒 shared（103 也能看到那条 FAILED run），lists 与 unassigned 同内容。
    assert.equal(hasId(p103.lists.connector_incidents as unknown as readonly Record<string, unknown>[], 'entity_id', fixture.failedRun), true)
    assert.equal(p103.lists.connector_incidents.every((row) => row.scope === 'SHARED'), true)
    assert.deepEqual(p103.lists.connector_incidents, p103.unassigned.connector_incidents)
    assert.equal(p103.counts.connector_incidents_total, p103.lists.connector_incidents.length)

    // unassigned 里能看到 S7 的 APP2 与未认领复核项/无主任务。
    assert.equal(hasId(p103.unassigned.pending_decisions, 'application_id', fixture.app2), true)
    assert.equal(hasId(p103.unassigned.pending_reviews, 'item_id', fixture.reviewUnclaimed), true)
    assert.equal(hasId(p103.unassigned.waiting_human_tasks, 'task_id', fixture.taskUnassigned), true)
    assert.ok(p103.unassigned.note.includes('全租户共享'))

    // 计数自洽（V-4 口径：counts = 列表返回条数）。
    assert.equal(p103.counts.my_interviews_total, p103.lists.my_interviews.length)
    assert.equal(p103.counts.overdue_scorecards_total, p103.lists.overdue_scorecards.length)
    assert.equal(p103.counts.pending_reviews_total, p103.lists.pending_reviews.length)
    assert.equal(p103.counts.waiting_human_total, p103.lists.waiting_human_tasks.length)
    assert.equal(
      p103.counts.unassigned_total,
      p103.unassigned.pending_decisions.length + p103.unassigned.pending_reviews.length
        + p103.unassigned.waiting_human_tasks.length + p103.unassigned.connector_incidents.length,
    )

    // unassigned 是**全租户共享**：三个 actor 必须逐字节相同（同一快照）。
    const p102 = await readWorkbenchProjection(client, CFG, ACTOR_102)
    const p104 = await readWorkbenchProjection(client, CFG, ACTOR_104)
    assert.deepEqual(p103.unassigned, p102.unassigned, '103 与 102 的 unassigned 必须完全相同')
    assert.deepEqual(p103.unassigned, p104.unassigned, '103 与 104 的 unassigned 必须完全相同')
  })
})

// =====================================================================
//  2. actor 102（部门用人经理）
// =====================================================================

test('actor 102：含 APP1 的 S10 待决策、APPLICATION-ref 任务、assignee=102 复核项；不含 103/104 的 owned 项', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const p102 = await readWorkbenchProjection(client, CFG, ACTOR_102)

    // S10 待决策（S10 闸门 + 无当前有效 decision + 部门用人经理 = 102）。
    const decision = p102.lists.pending_decisions.find((row) => row.application_id === fixture.app1)
    assert.ok(decision, 'APP1 的 S10 待决策必须在 102 名下')
    assert.equal(decision.stage_code, 'S10')
    assert.equal(decision.relation, 'HIRING_MANAGER')
    assert.equal(decision.required_action, 'PROVIDE_DECISION')
    assert.ok(decision.reason.includes('S10'))
    assert.equal(p102.pending, p102.lists.pending_decisions)
    assert.equal(p102.counts.pending_total, p102.lists.pending_decisions.length)
    assert.equal(p102.counts.pending_by_stage.S10, 1, 'APP1 一条 S10 待决策')

    // S7 的 APP2 不属于任何个人 → 不在 102 的 owned 里（在 unassigned）。
    assert.equal(hasId(p102.lists.pending_decisions, 'application_id', fixture.app2), false)

    // APPLICATION-ref → HIRING_MANAGER 任务。
    const task = p102.lists.waiting_human_tasks.find((row) => row.task_id === fixture.taskRefApplication)
    assert.ok(task, 'APPLICATION ref 任务必须归 102（HIRING_MANAGER）')
    assert.equal(task.relation, 'HIRING_MANAGER')
    assert.equal(hasId(p102.lists.waiting_human_tasks, 'task_id', fixture.taskCreatedBy103), false)
    assert.equal(hasId(p102.lists.waiting_human_tasks, 'task_id', fixture.taskRefInterview), false)

    // 复核项：assignee=102。
    assert.equal(hasId(p102.lists.pending_reviews, 'item_id', fixture.review102), true)
    assert.equal(hasId(p102.lists.pending_reviews, 'item_id', fixture.review103), false)
    const review = p102.lists.pending_reviews.find((row) => row.item_id === fixture.review102)
    assert.equal(review?.relation, 'REVIEWER')
    assert.equal(review?.required_action, 'RESOLVE_REVIEW_ITEM')

    // 102 不是这两场面试的 interviewer → 不在「我的面试」。
    assert.equal(hasId(p102.lists.my_interviews, 'interview_id', fixture.iv1), false)
    assert.equal(hasId(p102.lists.my_interviews, 'interview_id', fixture.iv2), false)

    // 103/104 的个人项不得出现在 102 名下。
    assert.equal(hasId(p102.lists.waiting_human_tasks, 'task_id', fixture.taskCreatedBy103), false)
    assert.equal(p102.lists.overdue_scorecards.some((row) => row.interviewer_id === fixture.iv1), false)
  })
})

// =====================================================================
//  3. actor 104（面试官）
// =====================================================================

test('actor 104：含自己的面试/逾期面评、INTERVIEW-ref 任务；不含 102/103 的 owned 项', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const p104 = await readWorkbenchProjection(client, CFG, ACTOR_104)

    // 我的面试：IV1（interviewer=104），needs_scorecard=true。
    const interview = p104.lists.my_interviews.find((row) => row.interview_id === fixture.iv1)
    assert.ok(interview, 'IV1 必须在 104 的我的面试里')
    assert.equal(interview.needs_scorecard, true)
    assert.equal(interview.required_action, 'SUBMIT_SCORECARD')
    assert.equal(interview.slot_code, 'DEFAULT')
    assert.equal(hasId(p104.lists.my_interviews, 'interview_id', fixture.iv2), false)

    // 逾期/缺面评：IV1 排期已过 + 没交面评 → 逾期，latency > 0。
    const overdue = p104.lists.overdue_scorecards.find((row) => row.interview_id === fixture.iv1)
    assert.ok(overdue, 'IV1 必须出现在 104 的逾期面评里')
    assert.equal(overdue.overdue, true)
    assert.equal(overdue.application_id, fixture.app1)
    assert.ok(overdue.latency_hours > 24, `latency 应约 48 小时，实际 ${overdue.latency_hours}`)
    assert.equal(overdue.required_action, 'SUBMIT_SCORECARD')

    // INTERVIEW-ref → INTERVIEWER 任务。
    const task = p104.lists.waiting_human_tasks.find((row) => row.task_id === fixture.taskRefInterview)
    assert.ok(task, 'INTERVIEW ref 任务必须归 104（INTERVIEWER）')
    assert.equal(task.relation, 'INTERVIEWER')
    assert.equal(hasId(p104.lists.waiting_human_tasks, 'task_id', fixture.taskRefApplication), false)
    assert.equal(hasId(p104.lists.waiting_human_tasks, 'task_id', fixture.taskCreatedBy103), false)

    // 102/103 的 owned 项不得出现在 104 名下。
    assert.equal(hasId(p104.lists.pending_decisions, 'application_id', fixture.app1), false)
    assert.equal(hasId(p104.lists.pending_reviews, 'item_id', fixture.review102), false)
    assert.equal(hasId(p104.lists.pending_reviews, 'item_id', fixture.review103), false)
  })
})

// =====================================================================
//  4. 三个 actor 的 owned 集合（夹具子集）两两不相交；unassigned 完全相同
// =====================================================================

test('owned 集合两两不相交（夹具 id）；unassigned 三 actor 逐字节相同', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const projections: Record<string, OverviewResponse> = {
      102: await readWorkbenchProjection(client, CFG, ACTOR_102),
      103: await readWorkbenchProjection(client, CFG, ACTOR_103),
      104: await readWorkbenchProjection(client, CFG, ACTOR_104),
    }

    const fixtureIds: Record<string, Record<string, string[]>> = {}
    for (const [actor, projection] of Object.entries(projections)) {
      fixtureIds[actor] = {
        pending: idsOf(projection.lists.pending_decisions as unknown as readonly Record<string, unknown>[], 'application_id')
          .filter((id) => id === fixture.app1 || id === fixture.app2),
        interviews: idsOf(projection.lists.my_interviews as unknown as readonly Record<string, unknown>[], 'interview_id')
          .filter((id) => id === fixture.iv1 || id === fixture.iv2),
        reviews: idsOf(projection.lists.pending_reviews as unknown as readonly Record<string, unknown>[], 'item_id')
          .filter((id) => id === fixture.review103 || id === fixture.review102 || id === fixture.reviewUnclaimed),
        tasks: idsOf(projection.lists.waiting_human_tasks as unknown as readonly Record<string, unknown>[], 'task_id')
          .filter((id) => [fixture.taskCreatedBy103, fixture.taskRefInterview, fixture.taskRefApplication, fixture.taskUnassigned].includes(id)),
      }
    }

    // 期望归属（按契约谓词）。
    assert.deepEqual(fixtureIds['102'], { pending: [fixture.app1], interviews: [], reviews: [fixture.review102], tasks: [fixture.taskRefApplication] })
    assert.deepEqual(fixtureIds['103'], { pending: [], interviews: [fixture.iv2], reviews: [fixture.review103], tasks: [fixture.taskCreatedBy103] })
    assert.deepEqual(fixtureIds['104'], { pending: [], interviews: [fixture.iv1], reviews: [], tasks: [fixture.taskRefInterview] })

    // 两两不相交。
    const actors = ['102', '103', '104'] as const
    for (let i = 0; i < actors.length; i += 1) {
      for (let j = i + 1; j < actors.length; j += 1) {
        const left = fixtureIds[actors[i] as string] as Record<string, string[]>
        const right = fixtureIds[actors[j] as string] as Record<string, string[]>
        for (const bucket of ['pending', 'interviews', 'reviews', 'tasks'] as const) {
          const overlap = (left[bucket] ?? []).filter((id) => (right[bucket] ?? []).includes(id))
          assert.deepEqual(overlap, [], `${actors[i]} 与 ${actors[j]} 的 ${bucket} 不得重叠：${overlap.join(',')}`)
        }
      }
    }

    // unassigned：三个 actor 必须完全相同（共享区不做个人过滤）。
    assert.deepEqual(projections['102']!.unassigned, projections['103']!.unassigned)
    assert.deepEqual(projections['103']!.unassigned, projections['104']!.unassigned)
  })
})

// =====================================================================
//  5. actor_role 是标签：给 104 授予 HIRING_MANAGER 也**不改变**任何归属
// =====================================================================

test('actor_role 不参与归属（R-WB-4）：104 临时授予 HIRING_MANAGER 后 lists/counts/unassigned 不变', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const before = await readWorkbenchProjection(client, CFG, ACTOR_104)
    assert.equal(roles(before).includes('HIRING_MANAGER'), false)

    // 授予 104 HIRING_MANAGER 角色（标签，不参与谓词）。
    await client.query(
      `insert into recruitment.actor_role (tenant_id, actor_id, role_id, granted_by_actor_id)
       values ($1, $2, $3, $4)`,
      [TENANT, ACTOR_104, ROLE_HIRING_MANAGER, ACTOR_ADMIN],
    )

    const after = await readWorkbenchProjection(client, CFG, ACTOR_104)
    assert.equal(roles(after).includes('HIRING_MANAGER'), true, '角色标签应当变化')
    // 归属不变：只看有库约束的指派列（R-WB-1/4）。
    assert.deepEqual(after.lists, before.lists)
    assert.deepEqual(after.counts, before.counts)
    assert.deepEqual(after.unassigned, before.unassigned)
    // 104 仍然看不到 APP1 的 S10 待决策（那属于部门用人经理 102）。
    assert.equal(hasId(after.lists.pending_decisions, 'application_id', fixture.app1), false)
  })
})

// =====================================================================
//  6. 负例：动态键在写之前就被拒（scorecard 行数不变；只读事务 + prepare 复兜底）
// =====================================================================

test('负例（fail-closed、零写入）：未知维度键 / 缺维度 / 保留键 / 越界 score 全部在写之前被拒', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    await setActor(client, ACTOR_104)

    const countScorecards = async (): Promise<number> => {
      const { rows } = await client.query<{ n: number }>(
        'select count(*)::int as n from recruitment.scorecard where interview_id = $1 and tenant_id = $2',
        [fixture.iv1, TENANT],
      )
      return rows[0]?.n ?? 0
    }
    const before = await countScorecards()
    assert.equal(before, 0, '夹具起点：IV1 没有任何面评行')

    // ---- 6.1 纯函数层：未知键 / 缺维度 / 保留键 / score 越界 ----
    // 形状层只校验「每个维度对象长什么样」，**不**知道 rubric 的权威键集；
    // 「键是否在 rubric 里」由 validateDimensionKeys / prepareScorecard 负责 —— 两层分工如下：
    const shaped = parseScorecardFormSubmission({
      interview_id: fixture.iv1,
      dimensions: { backend_depth: { assessment: 'MET', score: 4 }, made_up_key: { assessment: 'MET' } },
      transcript_basis: 'NO_TRANSCRIPT',
      overall: 'HOLD',
    })
    assert.deepEqual(Object.keys(shaped.dimensions).sort(), ['backend_depth', 'made_up_key'], '形状层不剪键（键集由覆盖校验负责）')
    assert.throws(
      () => validateDimensionKeys(['backend_depth', 'made_up_key'], DIMENSIONS.map((dimension) => dimension.key)),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.reason_code, 'DIMENSION_NOT_IN_RUBRIC')
        assert.deepEqual((body.detail as Record<string, unknown>).unexpected, ['made_up_key'])
        return true
      },
    )
    assert.throws(
      () => validateDimensionKeys(['backend_depth'], DIMENSIONS.map((dimension) => dimension.key)),
      (error: unknown) => {
        assert.equal(errorBody(error).reason_code, 'DIMENSION_COVERAGE_INCOMPLETE')
        return true
      },
    )
    assert.throws(
      () => parseScorecardFormSubmission({
        interview_id: fixture.iv1,
        dimensions: { transcript_basis: 'TRANSCRIPT' },
        transcript_basis: 'NO_TRANSCRIPT',
        overall: 'HOLD',
      }),
      (error: unknown) => {
        assert.equal(errorBody(error).reason_code, 'UNKNOWN_PARAM')
        return true
      },
    )
    assert.throws(
      () => parseScorecardFormSubmission({
        interview_id: fixture.iv1,
        dimensions: { backend_depth: { assessment: 'MET', score: 9 } },
        transcript_basis: 'NO_TRANSCRIPT',
        overall: 'HOLD',
      }),
      (error: unknown) => {
        assert.equal(errorBody(error).reason_code, 'OUT_OF_RANGE')
        return true
      },
    )

    // ---- 6.2 产品写路径第二层：即便绕过表单形状校验，prepare 也会拒（且只读阶段零写入）----
    const itemsFor = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      transcript_basis: 'NO_TRANSCRIPT',
      backend_depth: { assessment: 'MET', score: 4 },
      async_pipeline: { assessment: 'NOT_MET', score: 2, note: '重放答不上来' },
      frontend_basics: { assessment: 'NOT_OBSERVED' },
      ...overrides,
    })
    const baseArgs = (items: Record<string, unknown>): Record<string, unknown> => ({
      interview_id: fixture.iv1,
      items,
      overall: 'HOLD',
      idempotency_key: `neg:${uniqueSuffix()}`,
    })

    await assert.rejects(
      prepareScorecard(client, CFG, baseArgs(itemsFor({ made_up_key: { assessment: 'MET' } }))),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'DIMENSION_NOT_IN_RUBRIC')
        return true
      },
    )
    const missingItems = itemsFor({})
    delete (missingItems as Record<string, unknown>).frontend_basics
    await assert.rejects(
      prepareScorecard(client, CFG, baseArgs(missingItems)),
      (error: unknown) => {
        assert.equal(errorBody(error).reason_code, 'DIMENSION_COVERAGE_INCOMPLETE')
        return true
      },
    )

    // 零写入：所有负例都发生在写库之前。
    assert.equal(await countScorecards(), before, '负例不得写任何 scorecard 行')
  })
})

// =====================================================================
//  7. V6-2：终态失败任务进入「需要人处理」清单（真库）
// =====================================================================

test('V6-2：终态失败且 error_class 在人工闭集 → 进 lists/unassigned，带人话 reason，按失败时间倒序', async () => {
  await inRolledBackTx(POOL, async (client) => {
    // 103 名下三条失败任务：两条需要人处理（不同失败时间），一条不需要（WORKER_LOST）。
    // 第三条带更早的 FAILED_RETRYABLE attempt → 验证「只认最后一次 attempt」。
    const failedNewer = await addFailedTask(client, {
      createdBy: ACTOR_103, title: 'V62 最新失败（UNKNOWN_MODEL）', errorClass: 'PERMANENT',
      errorCode: 'UNKNOWN_MODEL', endedAtOffsetMinutes: -2,
    })
    const failedOlder = await addFailedTask(client, {
      createdBy: ACTOR_103, title: 'V62 较早失败（INVALID_INPUT）', errorClass: 'INVALID_INPUT',
      errorCode: 'INVALID_INPUT', endedAtOffsetMinutes: -60, withRetry: true,
    })
    const failedNoHuman = await addFailedTask(client, {
      createdBy: ACTOR_103, title: 'V62 worker 失联（不算）', errorClass: 'WORKER_LOST',
      errorCode: 'WORKER_LOST', endedAtOffsetMinutes: -1,
    })
    // 无主的失败任务：AUTH_REQUIRED → 进 unassigned（不双算到 owned）。
    const failedUnassigned = await addFailedTask(client, {
      createdBy: null, title: 'V62 无主失败（AUTH_REQUIRED）', errorClass: 'AUTH_REQUIRED',
      errorCode: 'AUTH_REQUIRED', endedAtOffsetMinutes: -30,
    })

    const p103 = await readWorkbenchProjection(client, CFG, ACTOR_103)

    // 1) 人工闭集内的失败任务必须出现；非人工类必须缺席。
    const owned = p103.lists.waiting_human_tasks
    assert.equal(hasId(owned, 'task_id', failedNewer), true, 'PERMANENT 失败应进 owned')
    assert.equal(hasId(owned, 'task_id', failedOlder), true, 'INVALID_INPUT 失败应进 owned')
    assert.equal(hasId(owned, 'task_id', failedNoHuman), false, 'WORKER_LOST 失败不得进人工队列')
    assert.equal(hasId(p103.unassigned.waiting_human_tasks, 'task_id', failedUnassigned), true,
      '无主 AUTH_REQUIRED 失败应进 unassigned')

    // 2) 人话原因：不给 HR 看机器码。
    const newer = owned.find((row) => row.task_id === failedNewer)
    const older = owned.find((row) => row.task_id === failedOlder)
    assert.equal(newer?.status, 'FAILED', 'FAILED 是真相，状态机未改')
    assert.equal(newer?.reason, '模型配置不正确，这次没能读出来')
    assert.equal(older?.reason, '这个文件没法处理')
    const unassignedFailed = p103.unassigned.waiting_human_tasks.find((row) => row.task_id === failedUnassigned)
    assert.equal(unassignedFailed?.reason, '外部账号未就绪')
    for (const row of [newer, older, unassignedFailed]) {
      assert.equal(row?.required_action, 'PROVIDE_DECISION')
    }

    // 3) 顺序：失败任务在最前、按失败时间倒序（最新失败在最上）。
    const failedIds = owned.filter((row) => row.status === 'FAILED').map((row) => row.task_id)
    assert.deepEqual(failedIds, [failedNewer, failedOlder], '失败任务必须按 ended_at 倒序')

    // 4) 计数与列表同步；unassigned 不双算（只在 unassigned_total 里算一次）。
    assert.equal(p103.counts.waiting_human_total, p103.lists.waiting_human_tasks.length)
    assert.equal(
      p103.counts.unassigned_total,
      p103.unassigned.pending_decisions.length + p103.unassigned.pending_reviews.length
        + p103.unassigned.waiting_human_tasks.length + p103.unassigned.connector_incidents.length,
    )

    // 5) unassigned 全租户共享：101/102/104 看到的与 103 完全相同。
    for (const actor of [ACTOR_102, ACTOR_104]) {
      const other = await readWorkbenchProjection(client, CFG, actor)
      assert.deepEqual(other.unassigned, p103.unassigned)
      assert.equal(hasId(other.lists.waiting_human_tasks, 'task_id', failedNewer), false,
        '103 的失败任务不得出现在别人的 owned')
    }
  })
})

test('V6-2 负例：BUSINESS_CONFLICT 进人工队列；WORKER_LOST/TRANSIENT/SUCCEEDED 不进（不改状态机）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const conflict = await addFailedTask(client, {
      createdBy: ACTOR_102, title: 'V62 业务冲突', errorClass: 'BUSINESS_CONFLICT',
      errorCode: 'BUSINESS_CONFLICT', endedAtOffsetMinutes: -5,
    })
    const transient = await addFailedTask(client, {
      createdBy: ACTOR_102, title: 'V62 瞬时失败重试耗尽（不算）', errorClass: 'TRANSIENT',
      errorCode: 'TEMP_ERROR', endedAtOffsetMinutes: -4,
    })
    const p102 = await readWorkbenchProjection(client, CFG, ACTOR_102)
    const row = p102.lists.waiting_human_tasks.find((r) => r.task_id === conflict)
    assert.ok(row, 'BUSINESS_CONFLICT 失败应进人工队列')
    assert.equal(row.status, 'FAILED')
    assert.equal(row.reason, '和已有事实冲突，需要你确认')
    assert.equal(hasId(p102.lists.waiting_human_tasks, 'task_id', transient), false,
      'TRANSIENT（重试耗尽）不得进人工队列')

    // 一个 SUCCEEDED 的任务、一个 TIMED_OUT 的 attempt 都不该进人工队列。
    const succeeded = await one(
      client,
      `insert into recruitment.business_task
         (tenant_id, task_type, title, idempotency_key, status, created_by_actor_id, completed_at)
       values ($1, 'HUMAN_REVIEW', 'V62 成功任务', $2, 'SUCCEEDED', $3, now()) returning id`,
      [TENANT, `test:workbench:v62:ok:${uniqueSuffix()}`, ACTOR_102],
    )
    const p102b = await readWorkbenchProjection(client, CFG, ACTOR_102)
    assert.equal(hasId(p102b.lists.waiting_human_tasks, 'task_id', succeeded), false)
  })
})
