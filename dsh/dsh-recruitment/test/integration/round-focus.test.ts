// =====================================================================
//  task-50 轮次级评分标准与考察重点：**真库集成测试**（真 PG 17，一次性库）
//
//  为什么用 `createIsolatedTestDatabase('d5round')`（而不是共享库回滚事务）：
//    · 本文件要证明"两轮不同模板配置在同一个申请上返回不同 effective schema"，
//      夹具跨多张表（job / rubric / application / interview / template / interviewer），
//      一次性库让夹具与断言互不干扰，也让本文件在 CI fresh 库上自包含可跑；
//    · 每个用例结束后由 `after` 统一 `drop()`；连不上库就**失败**（不静默 skip，
//      R3 要求 skipped === 0）。
//
//  数据全部由本文件自己造（`seedScenario` + 直接 SQL 造面试/模板）；断言只针对自造 id，
//  读回用**本文件自己写的 SELECT**（不 import 投影内部查询）对齐关键事实。
//
//  覆盖（任务书 §2 逐条）：
//    1. 同一 application 第 1/2 轮两场面试绑定两个模板 → `readInterviewerWorkspace` 两行
//       effective_rubric **JSON 不同**（focus/must_cover/questions/scale/title 逐字段），source=ROUND_OVERRIDE；
//    2. 第三场无模板面试 → source=JOB_BASE、reason 非空、scale=null、维度全 JOB_BASE；
//    3. `readApplicationDetail` 的 interviews[] 每项有 `round_focus`，第 1/2 轮内容不同、
//       无模板那场 available=false（且 W2 不带 effective_rubric）；
//    4. 反证：actor 不在某场 interviewer 行里 → `readInterviewerWorkspace({interviewId})`
//       抛 FORBIDDEN(ACTOR_NOT_INTERVIEWER) 且**零行**（独立 SQL 读回确认没有该 actor 的分配）；
//    5. 反证：模板 job_id=别的岗位（直接 SQL 写，FK 允许）→ 该场 round_focus.source=JOB_BASE、
//       issues 有说明、**不泄露**别的岗位的 focus 文本。
// =====================================================================
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'

import { readInterviewerWorkspace, type InterviewerOverview, type InterviewerRow } from '../../src/http/interviewer.ts'
import { readApplicationDetail, type ApplicationDetailResponse } from '../../src/http/recruiting.ts'
import { withReadOnly, type DatabaseClient, type ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  errorBody,
  hex64,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
  type IsolatedTestDatabase,
} from './db.ts'

const BASE = testDatabaseConfig()
const ACTOR_104 = '11111111-1111-4111-8111-000000000104' // 0002 seed 的演示面试官 A
const ACTOR_105 = '11111111-1111-4111-8111-000000000105' // fresh 库**没有**，由本文件自造
const ACTOR_HR = '11111111-1111-4111-8111-000000000103' // 0002 seed 的 HR（插件配置 actor）
const DEMO_DEPARTMENT = '11111111-1111-4111-8111-000000000010'

/** 与演示 rubric 同形的三个维度；backend_depth 自带 question（证明 effective 维度 question 来自 base）。 */
const BASE_DIMENSIONS = [
  {
    key: 'backend_depth',
    label: '后端工程深度',
    kind: 'MUST_HAVE',
    weight: 0.5,
    question: 'base 维度自带的问题（集成夹具）',
  },
  { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
] as const
const BASE_KEYS = BASE_DIMENSIONS.map((dimension) => dimension.key)

const OTHER_JOB_FOCUS_TEXT = '其它岗位轮次重点文本：不得出现在本岗位的响应里（integration guard）'

// ---------------------------------------------------------------------------
//  一次性库 + 夹具
// ---------------------------------------------------------------------------

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig

interface Fixture {
  readonly applicationId: string
  readonly jobId: string
  readonly rubricId: string
  readonly template1: string
  readonly template2: string
  readonly templateOtherJob: string
  readonly template1Objective: string
  readonly template1Summary: string
  readonly template2Objective: string
  readonly template2Summary: string
  readonly template1Hash: string
  readonly template2Hash: string
  readonly iv1: string
  readonly iv2: string
  readonly iv3NoTemplate: string
  readonly ivOtherJobTemplate: string
  readonly ivNotAssignedTo104: string
}

let fixture: Fixture

/** 插一场面试（同一 application 用 round_no 区分，`uq_interview_slot` 允许）。 */
async function addInterview(
  dbClient: DatabaseClient,
  input: {
    readonly applicationId: string
    readonly roundNo: number
    readonly templateVersionId: string | null
    readonly status?: string
    readonly startOffset?: string
  },
): Promise<string> {
  const { rows } = await dbClient.query<{ id: string }>(
    `insert into recruitment.interview
       (tenant_id, application_id, interview_template_version_id, round_no, slot_code, status,
        scheduled_start_at, scheduled_end_at, timezone)
     values ($1, $2, $3, $4, 'DEFAULT', $5,
             now() + ($6::text)::interval, now() + ($6::text)::interval + interval '1 hour', 'Asia/Shanghai')
     returning id::text as id`,
    [
      TENANT,
      input.applicationId,
      input.templateVersionId,
      input.roundNo,
      input.status ?? 'SCHEDULED',
      input.startOffset ?? '-3 days',
    ],
  )
  const id = rows[0]?.id
  assert.ok(typeof id === 'string' && id !== '', 'interview insert 必须返回 id')
  return id
}

/** 加一条 interviewer 分配。 */
async function addInterviewer(dbClient: DatabaseClient, interviewId: string, actorId: string): Promise<void> {
  await dbClient.query(
    `insert into recruitment.interviewer (tenant_id, interview_id, actor_id, required_scorecard)
     values ($1, $2, $3, true)`,
    [TENANT, interviewId, actorId],
  )
}

/** 造一个 `interview_template_version`（内容全部由参数决定；payload_hash 与内容一一对应）。 */
async function addTemplateVersion(
  dbClient: DatabaseClient,
  input: {
    readonly jobId: string | null
    readonly templateCode: string
    readonly roundNo: number
    readonly objective: string
    readonly summary: string
    readonly focus: readonly Record<string, unknown>[]
    readonly questions: readonly unknown[]
    readonly feedbackForm: Record<string, unknown>
    readonly rubricVersionId: string | null
    readonly payloadHash: string
  },
): Promise<string> {
  const { rows } = await dbClient.query<{ id: string }>(
    `insert into recruitment.interview_template_version
       (tenant_id, job_id, template_code, round_no, version_no, objective, briefing,
        focus_attributes, question_templates, feedback_form, rubric_version_id, payload_hash,
        created_by_actor_id)
     values ($1, $2, $3, $4, 1, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)
     returning id::text as id`,
    [
      TENANT,
      input.jobId,
      input.templateCode,
      input.roundNo,
      input.objective,
      JSON.stringify({ summary: input.summary }),
      JSON.stringify(input.focus),
      JSON.stringify(input.questions),
      JSON.stringify(input.feedbackForm),
      input.rubricVersionId,
      input.payloadHash,
      ACTOR_HR,
    ],
  )
  const id = rows[0]?.id
  assert.ok(typeof id === 'string' && id !== '', 'template insert 必须返回 id')
  return id
}

/** 独立 SQL 读回模板行（不 import 投影实现）。 */
async function readTemplateRow(
  dbClient: DatabaseClient,
  templateId: string,
): Promise<{ round_no: number; version_no: number; objective: string; briefing: unknown; payload_hash: string; rubric_version_id: string | null }> {
  const { rows } = await dbClient.query<{
    round_no: number
    version_no: number
    objective: string
    briefing: unknown
    payload_hash: string
    rubric_version_id: string | null
  }>(
    `select round_no, version_no, objective, briefing, payload_hash, rubric_version_id::text as rubric_version_id
       from recruitment.interview_template_version where id = $1::uuid and tenant_id = $2`,
    [templateId, TENANT],
  )
  const row = rows[0]
  assert.ok(row !== undefined, `模板 ${templateId} 必须能从库读回`)
  return row
}

test.before(async () => {
  db = await createIsolatedTestDatabase('d5round')
  assertPrivateDatabase(db.name)
  cfg = { ...BASE, database: db.name }

  const client = await db.pool.connect()
  try {
    await client.query('begin')
    // 写夹具需要 actor（触发器/审计要求）；写事务显式给身份，结束提交（一次性库，无需回滚）。
    await client.query("select set_config('recruitment.actor_id', $1, true)", [ACTOR_HR])
    // 105 在 fresh 库不存在：自造（只用于"不是这场面试官"的反证）。
    await client.query(
      `insert into recruitment.actor (id, tenant_id, kind, display_name)
       values ($1, $2, 'HUMAN', '集成测试-面试官B')
       on conflict (id) do nothing`,
      [ACTOR_105, TENANT],
    )

    const suffix = uniqueSuffix()
    const scenario = await seedScenario(client, { dimensions: [...BASE_DIMENSIONS] })
    const applicationId = scenario.applicationId
    const jobId = scenario.jobId
    const rubricId = scenario.rubricId

    const template1Objective = `第 1 轮：技术基础与后端深度（集成 ${suffix}）`
    const template1Summary = `验证后端工程深度与异步流水线（集成 ${suffix}）`
    const template2Objective = `第 2 轮：跨团队协作与取舍（集成 ${suffix}）`
    const template2Summary = `验证冲突取舍依据、避免重复第 1 轮技术题（集成 ${suffix}）`
    const template1Hash = hex64(`t1-${suffix}`)
    const template2Hash = hex64(`t2-${suffix}`)

    const template1 = await addTemplateVersion(client, {
      jobId,
      templateCode: `R1_T_${suffix}`.slice(0, 40).toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      roundNo: 1,
      objective: template1Objective,
      summary: template1Summary,
      focus: [
        { key: 'backend_depth', label: '后端工程深度', weight: 0.5, required: true, must_cover: true },
        { key: 'async_pipeline', label: '异步/队列流水线经验', weight: 0.3, required: true, must_cover: true },
      ],
      questions: ['讲一个你设计过的分片方案。', { key: 'replay', question: '消息重放/幂等怎么处理？' }],
      feedbackForm: {
        scale: { min: 1, max: 5 },
        fields: [
          { key: 'backend_depth', label: '后端工程深度', kind: 'DIMENSION', required: true },
          { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'DIMENSION', required: true },
        ],
      },
      rubricVersionId: rubricId,
      payloadHash: template1Hash,
    })
    const template2 = await addTemplateVersion(client, {
      jobId,
      templateCode: `R2_T_${suffix}`.slice(0, 40).toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      roundNo: 2,
      objective: template2Objective,
      summary: template2Summary,
      focus: [{ key: 'frontend_basics', label: '基本前端能力', weight: 0.2, required: false, must_cover: false }],
      questions: ['讲一次你推翻自己技术方案的经历：依据是什么？'],
      feedbackForm: {
        scale: { min: 2, max: 10 },
        fields: [{ key: 'frontend_basics', label: '基本前端能力', kind: 'DIMENSION', required: true }],
      },
      rubricVersionId: rubricId,
      payloadHash: template2Hash,
    })

    // 另一个岗位（只有 job 行）：它的模板绑到本申请的面试上 = 跨岗位模板（FK 允许）。
    const otherJobId = (
      await client.query<{ id: string }>(
        `insert into recruitment.job (tenant_id, department_id, code, title, status)
         values ($1, $2, $3, $4, 'OPEN') returning id::text as id`,
        [TENANT, DEMO_DEPARTMENT, `OTHER_${suffix}`.slice(0, 40), '另一个岗位（跨岗位模板反证）'],
      )
    ).rows[0]?.id
    assert.ok(typeof otherJobId === 'string' && otherJobId !== '')
    const templateOtherJob = await addTemplateVersion(client, {
      jobId: otherJobId,
      templateCode: `OTHER_T_${suffix}`.slice(0, 40).toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      roundNo: 4,
      objective: '别的岗位的第 4 轮目标（不得泄露）',
      summary: '别的岗位简报（不得泄露）',
      focus: [{ key: 'backend_depth', label: OTHER_JOB_FOCUS_TEXT, weight: 0.9, required: true }],
      questions: [OTHER_JOB_FOCUS_TEXT],
      feedbackForm: { scale: { min: 1, max: 5 }, fields: [{ key: 'backend_depth', label: OTHER_JOB_FOCUS_TEXT, kind: 'DIMENSION', required: true }] },
      rubricVersionId: null,
      payloadHash: hex64(`other-${suffix}`),
    })

    const iv1 = await addInterview(client, {
      applicationId,
      roundNo: 1,
      templateVersionId: template1,
      status: 'POST_INTERVIEW',
      startOffset: '-5 days',
    })
    const iv2 = await addInterview(client, {
      applicationId,
      roundNo: 2,
      templateVersionId: template2,
      status: 'SCHEDULED',
      startOffset: '-3 days',
    })
    const iv3NoTemplate = await addInterview(client, {
      applicationId,
      roundNo: 3,
      templateVersionId: null,
      status: 'SCHEDULED',
      startOffset: '-1 days',
    })
    const ivOtherJobTemplate = await addInterview(client, {
      applicationId,
      roundNo: 4,
      templateVersionId: templateOtherJob,
      status: 'SCHEDULED',
      startOffset: '-2 days',
    })
    // 104 是前四场的面试官；第五场只分配给 105（反证用）。
    const ivNotAssignedTo104 = await addInterview(client, {
      applicationId,
      roundNo: 5,
      templateVersionId: null,
      status: 'SCHEDULED',
      startOffset: '-4 days',
    })
    for (const interviewId of [iv1, iv2, iv3NoTemplate, ivOtherJobTemplate]) {
      await addInterviewer(client, interviewId, ACTOR_104)
    }
    await addInterviewer(client, ivNotAssignedTo104, ACTOR_105)

    await client.query('commit')

    // 独立 SQL 读回夹具（不拿插入返回值自证）。
    const counts = await client.query<{ templates: number; interviews: number; assigned_104: number; assigned_105: number }>(
      `select
         (select count(*)::int from recruitment.interview_template_version
           where tenant_id = $1 and id in ($2::uuid, $3::uuid, $7::uuid)) as templates,
         (select count(*)::int from recruitment.interview
           where tenant_id = $1 and application_id = $4::uuid) as interviews,
         (select count(*)::int from recruitment.interviewer
           where tenant_id = $1 and actor_id = $5::uuid and interview_id = any($6::uuid[])) as assigned_104,
         (select count(*)::int from recruitment.interviewer
           where tenant_id = $1 and actor_id = $8::uuid and interview_id = $9::uuid) as assigned_105`,
      [
        TENANT, template1, template2, applicationId, ACTOR_104,
        [iv1, iv2, iv3NoTemplate, ivOtherJobTemplate], templateOtherJob, ACTOR_105, ivNotAssignedTo104,
      ],
    )
    const row = counts.rows[0]
    assert.equal(Number(row?.templates), 3, '三个模板行必须真实落库')
    assert.equal(Number(row?.interviews), 5, '五场面试必须真实落库')
    assert.equal(Number(row?.assigned_104), 4, '104 必须被分配在前四场')
    assert.equal(Number(row?.assigned_105), 1, '105 必须只被分配在第五场')

    fixture = {
      applicationId,
      jobId,
      rubricId,
      template1,
      template2,
      templateOtherJob,
      template1Objective,
      template1Summary,
      template2Objective,
      template2Summary,
      template1Hash,
      template2Hash,
      iv1,
      iv2,
      iv3NoTemplate,
      ivOtherJobTemplate,
      ivNotAssignedTo104,
    }
  } catch (error) {
    try { await client.query('rollback') } catch { /* 保留第一个错误 */ }
    throw error
  } finally {
    client.release()
  }
})

test.after(async () => {
  if (db !== undefined) await db.drop()
})

/** 以 104 视角读工作台（只读事务，和产品 HTTP 路径同一种事务语义）。 */
async function readWorkspace(options: { readonly interviewId?: string } = {}): Promise<InterviewerOverview> {
  return await withReadOnly(db.pool, (readClient) =>
    readInterviewerWorkspace(
      readClient,
      cfg,
      { alias: 'interviewer_a', actor_id: ACTOR_104, display_name: '演示-面试官 A' },
      options,
    ),
  )
}

/** 读申请详情（只读事务）。 */
async function readDetail(): Promise<ApplicationDetailResponse> {
  return await withReadOnly(db.pool, (readClient) =>
    readApplicationDetail({ database: cfg, client: readClient }, fixture.applicationId),
  )
}

function rowById(overview: InterviewerOverview, interviewId: string): InterviewerRow {
  const row = overview.interviews.find((item) => item.interview_id === interviewId)
  assert.ok(row !== undefined, `工作台必须包含面试 ${interviewId}`)
  return row
}

function dimensionOf(row: InterviewerRow, key: string) {
  const found = row.effective_rubric.dimensions.find((dimension) => dimension.key === key)
  assert.ok(found !== undefined, `effective_rubric.dimensions 必须包含 ${key}`)
  return found
}

// =====================================================================
//  1. 两轮不同模板配置 → 两行 effective_rubric 真实不同
// =====================================================================

test('两轮不同模板：readInterviewerWorkspace 两行 round_focus/effective_rubric 逐字段不同，source=ROUND_OVERRIDE', async () => {
  const overview = await readWorkspace()
  const first = rowById(overview, fixture.iv1)
  const second = rowById(overview, fixture.iv2)

  // --- 来源/轮次/模板回显 ---
  assert.equal(first.round_focus.source, 'ROUND_CONFIG')
  assert.equal(second.round_focus.source, 'ROUND_CONFIG')
  assert.equal(first.round_focus.round_no, 1)
  assert.equal(second.round_focus.round_no, 2)
  assert.equal(first.round_focus.template_version_id, fixture.template1)
  assert.equal(second.round_focus.template_version_id, fixture.template2)
  assert.equal(first.round_focus.template_payload_hash, fixture.template1Hash)
  assert.equal(second.round_focus.template_payload_hash, fixture.template2Hash)
  assert.equal(first.round_focus.title, fixture.template1Objective)
  assert.equal(first.round_focus.description, fixture.template1Summary)
  assert.equal(second.round_focus.title, fixture.template2Objective)
  assert.equal(second.round_focus.description, fixture.template2Summary)
  assert.equal(first.effective_rubric.source, 'ROUND_OVERRIDE')
  assert.equal(second.effective_rubric.source, 'ROUND_OVERRIDE')
  assert.equal(first.effective_rubric.template_version_id, fixture.template1)
  assert.equal(second.effective_rubric.template_version_id, fixture.template2)

  // --- 重点不同（真库读出的模板内容，不是硬编码的演示行） ---
  assert.deepEqual(first.round_focus.focus_dimensions.map((item) => item.key), ['backend_depth', 'async_pipeline'])
  assert.deepEqual(second.round_focus.focus_dimensions.map((item) => item.key), ['frontend_basics'])
  assert.deepEqual(first.round_focus.questions, [
    { key: null, text: '讲一个你设计过的分片方案。' },
    { key: 'replay', text: '消息重放/幂等怎么处理？' },
  ])
  assert.deepEqual(second.round_focus.questions, [{ key: null, text: '讲一次你推翻自己技术方案的经历：依据是什么？' }])
  assert.deepEqual(first.round_focus.scorecard_fields.map((field) => field.key), ['backend_depth', 'async_pipeline'])
  assert.deepEqual(second.round_focus.scorecard_fields.map((field) => field.key), ['frontend_basics'])

  // --- effective_rubric：维度宇宙恒 = 岗位 rubric（顺序不变），focus/must_cover 标记正确 ---
  assert.deepEqual(first.effective_rubric.dimensions.map((dimension) => dimension.key), BASE_KEYS)
  assert.deepEqual(second.effective_rubric.dimensions.map((dimension) => dimension.key), BASE_KEYS)
  assert.equal(dimensionOf(first, 'backend_depth').focus, true)
  assert.equal(dimensionOf(first, 'backend_depth').must_cover, true)
  assert.equal(dimensionOf(first, 'async_pipeline').focus, true)
  assert.equal(dimensionOf(first, 'frontend_basics').focus, false)
  assert.equal(dimensionOf(first, 'frontend_basics').must_cover, false)
  // round 2：frontend_basics 是重点但**非必覆盖**（focus 与 must_cover 不是同一个标记）
  assert.equal(dimensionOf(second, 'frontend_basics').focus, true)
  assert.equal(dimensionOf(second, 'frontend_basics').must_cover, false)
  assert.equal(dimensionOf(second, 'backend_depth').focus, false)
  assert.equal(dimensionOf(second, 'backend_depth').origin, 'JOB_BASE')
  for (const row of [first, second]) {
    for (const dimension of row.effective_rubric.dimensions) {
      assert.equal(dimension.required, true, `${dimension.key}: required 恒 true`)
    }
  }
  // question 来自 base rubric；focus 模板里的 question 不混入
  assert.equal(dimensionOf(first, 'backend_depth').question, 'base 维度自带的问题（集成夹具）')
  // 两轮量表确实不同（min 与 max 都不同）
  assert.deepEqual(first.effective_rubric.scorecard.scale, { min: 1, max: 5 })
  assert.deepEqual(second.effective_rubric.scorecard.scale, { min: 2, max: 10 })
  // 提交键集恒 = 全部 base key（顺序一致）；rubric 版本 = 申请钉住版本
  for (const row of [first, second]) {
    assert.deepEqual(row.effective_rubric.submission.dimension_keys, BASE_KEYS)
    assert.equal(row.effective_rubric.submission.rubric_version_id, fixture.rubricId)
    assert.equal(row.effective_rubric.rubric_version_id, fixture.rubricId)
    assert.equal(row.effective_rubric.job_id, fixture.jobId)
  }
  // 两行整体不同（JSON 级）
  assert.notEqual(JSON.stringify(first.effective_rubric), JSON.stringify(second.effective_rubric))
  assert.notEqual(JSON.stringify(first.round_focus), JSON.stringify(second.round_focus))

  // --- 独立 SQL 读回：模板行的 round_no/payload_hash 与响应回显一致 ---
  const t1 = await withReadOnly(db.pool, (readClient) => readTemplateRow(readClient, fixture.template1))
  const t2 = await withReadOnly(db.pool, (readClient) => readTemplateRow(readClient, fixture.template2))
  assert.equal(t1.round_no, 1)
  assert.equal(t2.round_no, 2)
  assert.equal(t1.payload_hash, first.round_focus.template_payload_hash)
  assert.equal(t2.payload_hash, second.round_focus.template_payload_hash)
})

// =====================================================================
//  2. 第三场无模板 → JOB_BASE 降级（不伪造本轮重点）
// =====================================================================

test('无模板那场：round_focus.available=false + reason 非空，effective_rubric=JOB_BASE（scale=null、维度全 JOB_BASE）', async () => {
  const overview = await readWorkspace()
  const row = rowById(overview, fixture.iv3NoTemplate)
  const focus = row.round_focus
  const rubric = row.effective_rubric

  assert.equal(focus.available, false)
  assert.equal(focus.source, 'JOB_BASE')
  assert.equal(focus.round_no, 3)
  assert.equal(focus.template_version_id, null)
  assert.equal(focus.template_version_no, null)
  assert.equal(focus.template_payload_hash, null)
  assert.equal(focus.title, null)
  assert.equal(focus.description, null)
  assert.deepEqual(focus.focus_dimensions, [])
  assert.deepEqual(focus.questions, [])
  assert.deepEqual(focus.scorecard_fields, [])
  assert.equal(typeof focus.reason, 'string')
  assert.ok((focus.reason ?? '').trim() !== '')
  assert.match(focus.reason ?? '', /没有绑定可用的轮次模板/)
  assert.match(focus.reason ?? '', /JOB_BASE/)

  assert.equal(rubric.available, true)
  assert.equal(rubric.source, 'JOB_BASE')
  assert.equal(rubric.round_no, 3)
  assert.equal(rubric.rubric_version_id, fixture.rubricId)
  assert.equal(rubric.template_version_id, null)
  assert.equal(rubric.scorecard.scale, null, '无模板时不得编造量表')
  assert.deepEqual(rubric.dimensions.map((dimension) => dimension.key), BASE_KEYS)
  for (const dimension of rubric.dimensions) {
    assert.equal(dimension.focus, false)
    assert.equal(dimension.must_cover, false)
    assert.equal(dimension.origin, 'JOB_BASE')
    assert.equal(dimension.required, true)
  }
  assert.deepEqual(rubric.scorecard.fields.map((field) => field.key), BASE_KEYS)
  for (const field of rubric.scorecard.fields) {
    assert.equal(field.kind, 'DIMENSION')
    assert.equal(field.required, true)
  }
  assert.deepEqual(rubric.submission, { rubric_version_id: fixture.rubricId, dimension_keys: BASE_KEYS })
  // 工作台 issues 不应把"正常降级"说成错误：无模板这一场不得出现 issue
  // （同一 overview 里另有"跨岗位模板"反证夹具会合法产生 issue，所以按 interview id 定位断言，
  //   而不是要求整个数组为空 —— 否则测试断言的是夹具布局，不是产品行为。）
  assert.equal(
    overview.issues.some((line) => line.includes(fixture.iv3NoTemplate)),
    false,
    '无模板的正常降级不应产生 issue',
  )
})

// =====================================================================
//  3. readApplicationDetail（W2）：interviews[] 每项有 round_focus，两轮不同，无模板降级
// =====================================================================

test('readApplicationDetail：interviews[] 每项带 round_focus，第 1/2 轮内容不同、无模板那场 available=false（且 W2 不带 effective_rubric）', async () => {
  const detail = await readDetail()
  const interviews = detail.application.interviews
  assert.ok(interviews.length >= 5, `申请详情应包含 5 场面试，实际 ${interviews.length}`)
  for (const item of interviews) {
    assert.ok(item.round_focus !== undefined, `interviews[] 每项必须有 round_focus（${item.interview_id}）`)
    assert.equal((item as unknown as Record<string, unknown>).effective_rubric, undefined, 'W2 InterviewSummary 不含 effective_rubric')
  }
  const byId = Object.fromEntries(interviews.map((item) => [item.interview_id, item]))
  const detail1 = byId[fixture.iv1]
  const detail2 = byId[fixture.iv2]
  const detail3 = byId[fixture.iv3NoTemplate]
  assert.ok(detail1 !== undefined && detail2 !== undefined && detail3 !== undefined)
  assert.deepEqual(detail1.round_focus.focus_dimensions.map((item) => item.key), ['backend_depth', 'async_pipeline'])
  assert.deepEqual(detail2.round_focus.focus_dimensions.map((item) => item.key), ['frontend_basics'])
  assert.notDeepEqual(detail1.round_focus, detail2.round_focus)
  assert.equal(detail1.round_focus.title, fixture.template1Objective)
  assert.equal(detail2.round_focus.title, fixture.template2Objective)
  assert.equal(detail3.round_focus.available, false)
  assert.equal(detail3.round_focus.source, 'JOB_BASE')
  assert.ok((detail3.round_focus.reason ?? '').trim() !== '')
})

// =====================================================================
//  4. 反证：actor 不在 interviewer 行 → FORBIDDEN(ACTOR_NOT_INTERVIEWER) 且零行
// =====================================================================

test('反证：104 不在某场的 interviewer 行（该场只分配 105）→ readInterviewerWorkspace({interviewId}) 抛 FORBIDDEN 且零行', async () => {
  // 独立 SQL 先证明"这场 104 确实没有分配"（不是因为查询写错而 403）
  const { rows } = await withReadOnly(db.pool, (readClient) => readClient.query<{ n: number }>(
    `select count(*)::int as n from recruitment.interviewer
      where tenant_id = $1 and interview_id = $2::uuid and actor_id = $3::uuid`,
    [TENANT, fixture.ivNotAssignedTo104, ACTOR_104],
  ))
  assert.equal(Number(rows[0]?.n), 0, '夹具前提：104 在这场没有 interviewer 行')

  await assert.rejects(
    () => readWorkspace({ interviewId: fixture.ivNotAssignedTo104 }),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'FORBIDDEN')
      assert.equal(body.reason_code, 'ACTOR_NOT_INTERVIEWER')
      return true
    },
  )
  // 零行：读全量工作台时也不包含这场（不确认别人名下是否存在）
  const overview = await readWorkspace()
  assert.equal(
    overview.interviews.some((row) => row.interview_id === fixture.ivNotAssignedTo104),
    false,
    '未被分配的面试不得出现在我的工作台（零行）',
  )
})

// =====================================================================
//  5. 反证：模板 job_id = 别的岗位 → 不套用（JOB_BASE）+ issues 有说明 + 不泄露别岗 focus 文本
// =====================================================================

test('反证：跨岗位模板绑到本申请的面试 → round_focus.source=JOB_BASE、issues 说明、不泄露别岗文本', async () => {
  const overview = await readWorkspace()
  const row = rowById(overview, fixture.ivOtherJobTemplate)

  // 模板被回显（能看出绑了哪个模板），但不套用
  assert.equal(row.round_focus.source, 'JOB_BASE')
  assert.equal(row.round_focus.available, false)
  assert.equal(row.round_focus.template_version_id, fixture.templateOtherJob)
  assert.deepEqual(row.round_focus.focus_dimensions, [])
  assert.deepEqual(row.round_focus.questions, [])
  assert.deepEqual(row.round_focus.scorecard_fields, [])
  assert.equal(row.round_focus.title, null)
  assert.equal(row.round_focus.description, null)
  assert.match(row.round_focus.reason ?? '', /不套用该轮次配置/)
  assert.match(row.round_focus.reason ?? '', /JOB_BASE/)

  // 维度宇宙 = 本申请的岗位 rubric（全 JOB_BASE），不换宇宙
  assert.equal(row.effective_rubric.source, 'JOB_BASE')
  assert.deepEqual(row.effective_rubric.dimensions.map((dimension) => dimension.key), BASE_KEYS)
  for (const dimension of row.effective_rubric.dimensions) {
    assert.equal(dimension.focus, false)
    assert.equal(dimension.origin, 'JOB_BASE')
  }

  // issues 有说明（overview 级）
  assert.ok(overview.issues.length >= 1, '跨岗位模板必须有 issue')
  const issueText = overview.issues.join('\n')
  assert.match(issueText, /轮次模板/)
  assert.match(issueText, /与申请岗位/)
  assert.match(issueText, /不一致，不套用该轮次配置/)

  // 不泄露别的岗位的 focus 文本/问题原文（响应任何位置都不出现）
  const serialized = JSON.stringify(overview)
  assert.equal(serialized.includes(OTHER_JOB_FOCUS_TEXT), false, '不得泄露跨岗位模板的 focus 文本')
  assert.equal(serialized.includes('别的岗位的第 4 轮目标（不得泄露）'), false)
  assert.equal(serialized.includes('别的岗位简报（不得泄露）'), false)
})
