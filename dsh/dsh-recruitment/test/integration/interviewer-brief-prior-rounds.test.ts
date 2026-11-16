// =====================================================================
//  task-51「prior_rounds + reference_points」：**真库**集成测试
//
//  被测：`src/http/interviewer.ts::readInterviewerWorkspace()`（含新 SQL `PRIOR_ROUND_SQL`）
//        —— 这是"批量取上一轮事实 + 逐维覆盖判定 + 本行组合"的**唯一运行时入口**。
//
//  纪律（`test/integration/db.ts` + 本 lane 任务书）：
//   1. 每个用例在自己的事务里跑并一律 ROLLBACK —— 不污染本 lane 的一次性库；
//   2. 连不上库就**失败**（不静默 skip；R3 要求 skipped === 0 才算绿）；
//   3. 断言只针对**本文件造出来的夹具 id**（共享库里还有别的演示行）；
//   4. 覆盖判定"与 DB 一致"用**独立 SQL 读回**面评行（不 import 生产谓词）交叉验证；
//   5. 时间不 mock 时钟：一律用相对 now() 的 interval（过去/未来）。
//
//  覆盖（任务书 ①–④ + 一条补充）：
//    ① round 1 已交面评（部分维度）→ prior_rounds 的 covered/uncovered 与 DB 面评逐维一致；
//    ② prior 无面评 → 全 uncovered NO_SCORECARD（草稿不算，另见单测）；
//    ③ 未分配该场的 actor 请求该 interview_id → FORBIDDEN(ACTOR_NOT_INTERVIEWER)，**写前后行数不变**；
//    ④ round 3 的 prior_rounds 只含 round 2（不含 round 1）——证明"只看紧邻上一轮"；
//    ⑤ 补充：简历"未展开经历"真的从库里的 parsed_fields 投影成 RESUME_HIGHLIGHT（端到端组合）。
// =====================================================================
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import {
  readInterviewerWorkspace,
  renderTextViolations,
  type InterviewerOverview,
  type InterviewerRow,
} from '../../src/http/interviewer.ts'
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

/** `0002_seed.sql` 的演示身份：104 = 面试官；105 由本文件在事务内幂等补齐（CI 新库没有 105）。 */
const ACTOR_104 = '11111111-1111-4111-8111-000000000104'
const ACTOR_105 = '11111111-1111-4111-8111-000000000105'

/** 与演示 rubric v1 同形的三个维度（`0002_seed.sql` §5）；label 里的「/」是中文，不是路径。 */
const DIMENSIONS = [
  { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
  { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
] as const

/** 简历字段：`work_experience.entries` 里第 2 条"只有一行摘要"（title/company 都空）。 */
const PARSED_FIELDS_WITH_UNEXPANDED = {
  fields: {
    name: { state: 'present', value: '夹具候选人' },
    work_experience: {
      state: 'present',
      entries: [
        { header_text: '2023.01-2024.12 | 某某公司 | 后端工程师', company: '某某公司', title: '后端工程师' },
        { header_text: '2021.03-2022.12 | 一家小公司', company: null, title: null },
      ],
    },
  },
  timeline: { intervals: 2, covered_months_closed: 60 },
} as const

/**
 * 确保演示身份 105（面试官 B）存在（`0002_seed.sql` 只种了 101–104；105 是本地演示库的
 * bootstrap 补的）。在**本用例的回滚事务里**幂等补齐，测试因此自包含（CI 新库也能跑）。
 * @param client - 回滚事务内的连接。
 */
async function ensureActor105(client: DatabaseClient): Promise<void> {
  await client.query(
    `insert into recruitment.actor (id, tenant_id, kind, display_name)
     values ($1, $2, 'HUMAN', '集成测试-面试官B')
     on conflict (id) do nothing`,
    [ACTOR_105, TENANT],
  )
}

/** 造一场面试（时间相对 now()；`startOffset` 为负 = 过去）。 */
async function addInterview(
  client: DatabaseClient,
  applicationId: string,
  options: {
    roundNo?: number
    slotCode?: string
    status?: string
    startOffset?: string
  } = {},
): Promise<string> {
  return one(
    client,
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, status,
        scheduled_start_at, scheduled_end_at, timezone)
     values ($1, $2, $3, $4, $5,
             now() + ($6::text)::interval, now() + ($6::text)::interval + interval '1 hour', 'Asia/Shanghai')
     returning id`,
    [
      TENANT,
      applicationId,
      options.roundNo ?? 1,
      options.slotCode ?? 'DEFAULT',
      options.status ?? 'POST_INTERVIEW',
      options.startOffset ?? '-3 days',
    ],
  )
}

/** 登记一位面试官（返回 interviewer 行 id）。 */
async function addInterviewer(
  client: DatabaseClient,
  interviewId: string,
  actorId: string,
): Promise<string> {
  return one(
    client,
    `insert into recruitment.interviewer (tenant_id, interview_id, actor_id, required_scorecard)
     values ($1, $2, $3, true) returning id`,
    [TENANT, interviewId, actorId],
  )
}

/**
 * 造一条**当前**面评（`superseded_by_scorecard_id is null`）。
 * SUBMITTED 必须带 `submitted_at` + `items`（`ck_scorecard_submitted`）。
 */
async function addScorecard(
  client: DatabaseClient,
  input: {
    interviewId: string
    interviewerId: string
    rubricVersionId: string
    status: 'PENDING' | 'SUBMITTED'
    items: Record<string, unknown>
    overall?: string
  },
): Promise<string> {
  return one(
    client,
    `insert into recruitment.scorecard
       (tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
        submitted_at, items, overall, payload_hash)
     values ($1, $2, $3, $4, 1, $5,
             case when $5 = 'SUBMITTED' then now() - interval '2 days' else null end,
             $6::jsonb, $7, $8)
     returning id`,
    [
      TENANT,
      input.interviewId,
      input.interviewerId,
      input.rubricVersionId,
      input.status,
      JSON.stringify(input.items),
      input.status === 'SUBMITTED' ? (input.overall ?? 'ADVANCE') : null,
      hex64(`sc${uniqueSuffix()}`),
    ],
  )
}

/** 读一场面试的展示名/状态等事实（独立 SQL；不复用生产谓词）。 */
async function readInterviewFacts(
  client: DatabaseClient,
  interviewId: string,
): Promise<{ status: string; slotCode: string; roundNo: number; scheduledStartAt: Date | null }> {
  const row = (await client.query<{
    status: string
    slot_code: string
    round_no: number
    scheduled_start_at: Date | null
  }>(
    `select status, slot_code, round_no, scheduled_start_at
       from recruitment.interview where id = $1 and tenant_id = $2`,
    [interviewId, TENANT],
  )).rows[0]
  assert.ok(row !== undefined, `夹具面试 ${interviewId} 必须真实存在`)
  return {
    status: row.status,
    slotCode: row.slot_code,
    roundNo: row.round_no,
    scheduledStartAt: row.scheduled_start_at,
  }
}

/** 读一张面评行 + 面试官显示名（独立 SQL；用来交叉验证投影里的 decision/conclusion）。 */
async function readScorecardFacts(
  client: DatabaseClient,
  scorecardId: string,
): Promise<{ status: string; overall: string | null; items: unknown; displayName: string }> {
  const row = (await client.query<{
    status: string
    overall: string | null
    items: unknown
    display_name: string
  }>(
    `select sc.status, sc.overall, sc.items, ac.display_name
       from recruitment.scorecard sc
       join recruitment.interviewer ivr on ivr.id = sc.interviewer_id and ivr.tenant_id = sc.tenant_id
       join recruitment.actor ac on ac.id = ivr.actor_id and ac.tenant_id = ivr.tenant_id
      where sc.id = $1 and sc.tenant_id = $2`,
    [scorecardId, TENANT],
  )).rows[0]
  assert.ok(row !== undefined, `夹具面评 ${scorecardId} 必须真实存在`)
  return { status: row.status, overall: row.overall, items: row.items, displayName: row.display_name }
}

/** 读一个 actor 在面试/面评等表上的总行数（"写前后行数不变"的反证用）。 */
async function tableCounts(client: DatabaseClient): Promise<Record<string, number>> {
  const row = (await client.query<{
    interview: string
    interviewer: string
    scorecard: string
    actor: string
    application: string
  }>(
    `select (select count(*) from recruitment.interview)::text      as interview,
            (select count(*) from recruitment.interviewer)::text    as interviewer,
            (select count(*) from recruitment.scorecard)::text       as scorecard,
            (select count(*) from recruitment.actor)::text           as actor,
            (select count(*) from recruitment.application)::text     as application`,
  )).rows[0]
  assert.ok(row !== undefined)
  return {
    interview: Number(row.interview),
    interviewer: Number(row.interviewer),
    scorecard: Number(row.scorecard),
    actor: Number(row.actor),
    application: Number(row.application),
  }
}

function rowById(overview: InterviewerOverview, interviewId: string): InterviewerRow {
  const row = overview.interviews.find((candidate) => candidate.interview_id === interviewId)
  assert.ok(row !== undefined, `投影里必须有 ${interviewId} 这一行`)
  return row
}

/** D-141：投影里所有 point/why 都必须过渲染禁令机检（真实库链路，不是单测假数据）。 */
function assertReferenceTextsAreRenderable(row: InterviewerRow): void {
  for (const point of row.reference_points) {
    assert.deepEqual(renderTextViolations(point.point), [], `point 命中 D-141 禁令：${point.point}`)
    assert.deepEqual(renderTextViolations(point.why), [], `why 命中 D-141 禁令：${point.why}`)
  }
}

/** 参考点的 `kind|ref` 列表（断言 v2 的池序/去重/简历名额用）。 */
function pointKeys(row: InterviewerRow): string[] {
  return row.reference_points.map((point) => `${point.basis.kind}|${point.basis.ref}`)
}

// =====================================================================
//  ① round 1 已交面评（部分维度）→ covered/uncovered 与 DB 面评逐维一致
// =====================================================================

test('① round 1 已交面评（部分维度）→ prior_rounds 的 covered/uncovered 与 DB 面评逐维一致', async () => {
  await inRolledBackTx(POOL, async (client) => {
    await ensureActor105(client)
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS], fields: PARSED_FIELDS_WITH_UNEXPANDED })

    // ---- 上一轮（round 1，104 的面评：backend MET 4 / async NOT_OBSERVED / frontend 缺键）----
    const priorInterviewId = await addInterview(client, scenario.applicationId, {
      roundNo: 1,
      slotCode: 'DEFAULT',
      startOffset: '-3 days',
    })
    const priorInterviewerId = await addInterviewer(client, priorInterviewId, ACTOR_104)
    const items = {
      transcript_basis: 'TRANSCRIPT',
      backend_depth: { assessment: 'MET', score: 4 },
      async_pipeline: { assessment: 'NOT_OBSERVED' },
      // frontend_basics 故意缺键：证明 reason=NOT_RATED（真实提交会被工具拒绝，这是脏数据夹具）。
    }
    const scorecardId = await addScorecard(client, {
      interviewId: priorInterviewId,
      interviewerId: priorInterviewerId,
      rubricVersionId: scenario.rubricId,
      status: 'SUBMITTED',
      items,
      overall: 'ADVANCE',
    })

    // ---- 当前轮（round 2）：105 是这一轮的面试官（授权依据）----
    const currentInterviewId = await addInterview(client, scenario.applicationId, {
      roundNo: 2,
      slotCode: 'DEFAULT',
      startOffset: '-1 day',
    })
    await addInterviewer(client, currentInterviewId, ACTOR_105)

    // 独立读回：先证明夹具真的在库里（不是测试想象）。
    const dbInterview = await readInterviewFacts(client, priorInterviewId)
    const dbScorecard = await readScorecardFacts(client, scorecardId)
    assert.equal(dbScorecard.status, 'SUBMITTED')
    assert.equal(dbScorecard.overall, 'ADVANCE')
    assert.deepEqual(dbScorecard.items, items, 'DB 里的 items 必须与夹具逐键一致')

    const overview = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B', session_id: 'session-brief-1',
    }, { interviewId: currentInterviewId })
    assert.equal(overview.interviews.length, 1)
    const row = rowById(overview, currentInterviewId)

    // ---- prior_rounds：一场上一轮 = 一个元素 ----
    assert.equal(row.prior_rounds.length, 1)
    const prior = row.prior_rounds[0]
    assert.ok(prior !== undefined)
    assert.equal(prior.interview_id, priorInterviewId)
    assert.equal(prior.round_no, dbInterview.roundNo)
    assert.equal(prior.status, dbInterview.status)
    assert.equal(prior.slot_code, dbInterview.slotCode)
    assert.equal(
      prior.scheduled_start_at,
      dbInterview.scheduledStartAt === null ? null : dbInterview.scheduledStartAt.toISOString(),
      'scheduled_start_at 必须是同一份库事实（ISO 文本）',
    )
    assert.equal(prior.dimensions_available, true)
    assert.deepEqual(prior.interviewers, [{
      display_name: dbScorecard.displayName,
      scorecard_state: 'SUBMITTED',
      scorecard_submitted: true,
      conclusion: dbScorecard.overall,
    }])

    // ---- 逐维覆盖判定（与上面 DB 读回的 items 一致）----
    assert.deepEqual(prior.covered_dimensions, [
      { key: 'backend_depth', label: '后端工程深度', weight: 0.5, assessment: 'MET', score: 4 },
    ])
    assert.deepEqual(prior.uncovered_dimensions.map((dimension) => [dimension.key, dimension.reason]), [
      ['async_pipeline', 'NOT_OBSERVED'],
      ['frontend_basics', 'NOT_RATED'],
    ])

    // ---- reference_points：PRIOR_GAP 优先，文案逐字（DESIGN §1.2）----
    assert.deepEqual(row.reference_points.slice(0, 2).map((point) => point.basis), [
      { kind: 'PRIOR_GAP', ref: 'async_pipeline' },
      { kind: 'PRIOR_GAP', ref: 'frontend_basics' },
    ])
    assert.equal(row.reference_points[0]?.point, '上一轮没有覆盖到「异步/队列流水线经验」')
    assert.equal(
      row.reference_points[0]?.why,
      '岗位标准里有这一条（权重 0.3），但上一轮的面评没有给出这一维的评价（上一轮没有观察到这一维）。这一轮可以自己确认一下。',
    )
    // DESIGN §1.2 v2：gap 维度不再重复出 RUBRIC_DIMENSION；有可用简历 → 维度类 3 条 + 简历 1 条。
    assert.deepEqual(pointKeys(row), [
      'PRIOR_GAP|async_pipeline',
      'PRIOR_GAP|frontend_basics',
      'RUBRIC_DIMENSION|backend_depth',
      'RESUME_HIGHLIGHT|work_experience[1]',
    ])
    assert.deepEqual(row.reference_points[3], {
      point: '简历里有一段没有展开的经历：2021.03-2022.12 | 一家小公司',
      why: '材料里这段经历只有一行摘要，没有写具体做法；可以参考它了解真实的技术选择。',
      basis: { kind: 'RESUME_HIGHLIGHT', ref: 'work_experience[1]' },
    })
    assert.ok(row.reference_points.length >= 2 && row.reference_points.length <= 4, '目标 2–4 条')
    assertReferenceTextsAreRenderable(row)

    // ---- 既有字段语义不变（最小回归；本 lane 只加两个键）----
    assert.equal(row.scorecard.state, 'NONE', '105 还没填自己的面评')
    assert.equal(row.required_action, 'SUBMIT_SCORECARD')
    assert.equal(row.effective_rubric.available, true)
    assert.equal(row.brief.source, 'JOB_RUBRIC')
  })
})

// =====================================================================
//  ② prior 无面评 → 全 uncovered NO_SCORECARD
// =====================================================================

test('② prior 无面评 → 所有维度 uncovered 且 reason=NO_SCORECARD；面试官状态 NONE/结论 null', async () => {
  await inRolledBackTx(POOL, async (client) => {
    await ensureActor105(client)
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })

    const priorInterviewId = await addInterview(client, scenario.applicationId, { roundNo: 1, startOffset: '-2 days' })
    await addInterviewer(client, priorInterviewId, ACTOR_104)
    // 独立读回：这一场确实没有任何面评行（不是测试没造）。
    const scorecardCount = Number((await client.query<{ count: string }>(
      'select count(*)::text as count from recruitment.scorecard where interview_id = $1',
      [priorInterviewId],
    )).rows[0]?.count)
    assert.equal(scorecardCount, 0)

    const currentInterviewId = await addInterview(client, scenario.applicationId, { roundNo: 2, startOffset: '-1 day' })
    await addInterviewer(client, currentInterviewId, ACTOR_105)

    const overview = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B', session_id: 'session-brief-2',
    }, { interviewId: currentInterviewId })
    const row = rowById(overview, currentInterviewId)

    assert.equal(row.prior_rounds.length, 1)
    const prior = row.prior_rounds[0]
    assert.ok(prior !== undefined)
    assert.deepEqual(prior.covered_dimensions, [])
    assert.deepEqual(prior.uncovered_dimensions.map((dimension) => [dimension.key, dimension.reason]), [
      ['backend_depth', 'NO_SCORECARD'],
      ['async_pipeline', 'NO_SCORECARD'],
      ['frontend_basics', 'NO_SCORECARD'],
    ])
    assert.equal(prior.interviewers.length, 1)
    assert.deepEqual(prior.interviewers[0], {
      // 104 的显示名以库里行为准（`0002_seed.sql`：演示-面试官）。
      display_name: '演示-面试官',
      scorecard_state: 'NONE',
      scorecard_submitted: false,
      conclusion: null,
    })

    // 两个 gap 的 why 都写"上一轮没有提交的面评"。
    const gaps = row.reference_points.filter((point) => point.basis.kind === 'PRIOR_GAP')
    assert.deepEqual(gaps.map((point) => point.basis.ref), ['backend_depth', 'async_pipeline'])
    assert.match(gaps[0]?.why ?? '', /上一轮没有提交的面评/)
    // 没有可用简历条目（默认 parsedFields 没有 entries）→ 维度类可以填满，但只有 3 个维度/2 个 gap：
    // gap 维度不再重复出 RUBRIC_DIMENSION，只剩 frontend 一条。
    assert.deepEqual(pointKeys(row), [
      'PRIOR_GAP|backend_depth',
      'PRIOR_GAP|async_pipeline',
      'RUBRIC_DIMENSION|frontend_basics',
    ])
    assertReferenceTextsAreRenderable(row)
  })
})

// =====================================================================
//  ③ 未分配 → 403 ACTOR_NOT_INTERVIEWER，且写前后行数不变
// =====================================================================

test('③ 未分配该场的 actor 请求该 interview_id → FORBIDDEN(ACTOR_NOT_INTERVIEWER)，前后行数不变', async () => {
  await inRolledBackTx(POOL, async (client) => {
    await ensureActor105(client)
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const currentInterviewId = await addInterview(client, scenario.applicationId, { roundNo: 2, startOffset: '-1 day' })
    await addInterviewer(client, currentInterviewId, ACTOR_105)

    // 104 只分配在 round 1（另一个申请也不在）；这里它请求 round 2 的 id → 403。
    const before = await tableCounts(client)
    await assert.rejects(
      readInterviewerWorkspace(client, CFG, {
        alias: 'interviewer_a', actor_id: ACTOR_104, display_name: 'A', session_id: 'session-brief-3',
      }, { interviewId: currentInterviewId }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'FORBIDDEN')
        assert.equal(body.reason_code, 'ACTOR_NOT_INTERVIEWER')
        assert.deepEqual(body.detail, { interview_id: currentInterviewId })
        return true
      },
    )
    const after = await tableCounts(client)
    assert.deepEqual(after, before, '403 是只读拒绝：interview/interviewer/scorecard/actor/application 行数都不许变')

    // 反证：同一场换成真正被分配的 105 → 200（证明 403 是分配问题，不是库坏了）。
    const allowed = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B', session_id: 'session-brief-3b',
    }, { interviewId: currentInterviewId })
    assert.deepEqual(allowed.interviews.map((row) => row.interview_id), [currentInterviewId])
    assert.deepEqual(await tableCounts(client), before, '成功读取同样零写入')
  })
})

// =====================================================================
//  ④ round 3 的 prior_rounds 只含 round 2（不含 round 1）
// =====================================================================

test('④ round 3 的 prior_rounds 只含 round 2（不含 round 1）——只看紧邻上一轮', async () => {
  await inRolledBackTx(POOL, async (client) => {
    await ensureActor105(client)
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })

    // round 1（更早一轮；假如"多轮汇总"就会把它带出来）。
    const round1 = await addInterview(client, scenario.applicationId, { roundNo: 1, startOffset: '-5 days' })
    await addInterviewer(client, round1, ACTOR_104)
    // round 2（紧邻上一轮；105 也是这场的面试官 —— 证明"我是当前轮面试官"不是它出现的条件）。
    const round2 = await addInterview(client, scenario.applicationId, { roundNo: 2, startOffset: '-3 days' })
    const round2Interviewer = await addInterviewer(client, round2, ACTOR_104)
    await addScorecard(client, {
      interviewId: round2,
      interviewerId: round2Interviewer,
      rubricVersionId: scenario.rubricId,
      status: 'SUBMITTED',
      items: { transcript_basis: 'TRANSCRIPT', backend_depth: { assessment: 'MET', score: 3 } },
      overall: 'HOLD',
    })
    // round 3（当前轮；105 是这一轮的面试官）。
    const round3 = await addInterview(client, scenario.applicationId, { roundNo: 3, startOffset: '-1 day' })
    await addInterviewer(client, round3, ACTOR_105)

    const overview = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B', session_id: 'session-brief-4',
    }, { interviewId: round3 })
    const row = rowById(overview, round3)
    assert.deepEqual(row.prior_rounds.map((prior) => prior.interview_id), [round2], '只含紧邻上一轮（round 2）')
    assert.deepEqual(row.prior_rounds.map((prior) => prior.round_no), [2])
    assert.equal(row.prior_rounds.some((prior) => prior.interview_id === round1), false, '更早的 round 1 不得出现')
    assert.equal(row.prior_rounds[0]?.interviewers[0]?.conclusion, 'HOLD')

    // round 1 作为当前行（105 也被分配）→ 没有前置轮次。
    await addInterviewer(client, round1, ACTOR_105)
    const firstOwn = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B', session_id: 'session-brief-4b',
    }, { interviewId: round1 })
    const firstRow = rowById(firstOwn, round1)
    assert.deepEqual(firstRow.prior_rounds, [], '第 1 轮 → prior_rounds 恒为 []')
    assert.equal(
      firstRow.reference_points.some((point) => point.basis.kind === 'PRIOR_GAP'),
      false,
      '第 1 轮 → 一条 PRIOR_GAP 都不许有',
    )
    assertReferenceTextsAreRenderable(firstRow)
  })
})

// =====================================================================
//  ⑤ 补充：简历"未展开经历"从库里的 parsed_fields 投影成 RESUME_HIGHLIGHT
// =====================================================================

test('⑤ 简历未展开经历（parsed_fields.fields.work_experience.entries）→ 真实链路产出 RESUME_HIGHLIGHT', async () => {
  await inRolledBackTx(POOL, async (client) => {
    await ensureActor105(client)
    // 单维度 rubric：gap（1）+ 维度（1）+ 简历（1）= 3 条，给 RESUME_HIGHLIGHT 留出名额。
    const singleDimension = [DIMENSIONS[0]]
    const scenario = await seedScenario(client, {
      dimensions: [...singleDimension],
      fields: PARSED_FIELDS_WITH_UNEXPANDED,
    })

    const priorInterviewId = await addInterview(client, scenario.applicationId, { roundNo: 1, startOffset: '-2 days' })
    await addInterviewer(client, priorInterviewId, ACTOR_104)
    const currentInterviewId = await addInterview(client, scenario.applicationId, { roundNo: 2, startOffset: '-1 day' })
    await addInterviewer(client, currentInterviewId, ACTOR_105)

    // 独立读回：库里的简历版本确实带着那段"只有一行摘要"的经历。
    const resumeRow = (await client.query<{ parsed_fields: Record<string, unknown> }>(
      `select parsed_fields from recruitment.resume_version
        where id = (select resume_version_id from recruitment.application where id = $1)`,
      [scenario.applicationId],
    )).rows[0]
    assert.ok(resumeRow !== undefined)
    const workExperience = (resumeRow.parsed_fields as {
      fields?: { work_experience?: { entries?: readonly Record<string, unknown>[] } }
    }).fields?.work_experience
    assert.equal(workExperience?.entries?.[1]?.header_text, '2021.03-2022.12 | 一家小公司')
    assert.equal(workExperience?.entries?.[1]?.title, null)
    assert.equal(workExperience?.entries?.[1]?.company, null)

    const overview = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B', session_id: 'session-brief-5',
    }, { interviewId: currentInterviewId })
    const row = rowById(overview, currentInterviewId)
    const highlight = row.reference_points.find((point) => point.basis.kind === 'RESUME_HIGHLIGHT')
    assert.ok(highlight !== undefined, '应当产出 RESUME_HIGHLIGHT（端到端）')
    assert.deepEqual(highlight.basis, { kind: 'RESUME_HIGHLIGHT', ref: 'work_experience[1]' })
    assert.equal(highlight.point, '简历里有一段没有展开的经历：2021.03-2022.12 | 一家小公司')
    assert.deepEqual(row.reference_points.filter((point) => point.basis.kind === 'RESUME_HIGHLIGHT').length, 1, '最多 1 条')
    // 单维度 + 1 个 gap：gap 维度不再重复出 RUBRIC_DIMENSION，只剩 gap + 简历。
    assert.deepEqual(pointKeys(row), [
      'PRIOR_GAP|backend_depth',
      'RESUME_HIGHLIGHT|work_experience[1]',
    ])
    assert.ok(row.reference_points.length >= 2 && row.reference_points.length <= 4)
    assertReferenceTextsAreRenderable(row)
  })
})
